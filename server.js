const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { initDb, getDb } = require('./db');

const app = express();
const PORT = 3000;

// Helper to get db - it will be initialized before server starts
function db() {
  return getDb();
}

// ---------------------------------------------------------
// RECOMMENDER — talks to the Python Flask service
// Falls back silently if the service is not running yet
// ---------------------------------------------------------
const RECOMMENDER_URL = 'http://localhost:5001';

// Weight given to a category when a user authors a post in it.
// Posting about something is a strong signal of interest.
const POST_INTEREST_WEIGHT = 0.15;

// Record a category-interest signal for a user directly in SQLite.
// Scores are allowed to go negative so disliked topics get suppressed.
function recordCategoryScore(userId, categoryId, delta) {
  if (categoryId === undefined || categoryId === -1) return;
  db().prepare(`
    INSERT INTO user_interests (userId, category_id, score)
    VALUES (?, ?, ?)
    ON CONFLICT(userId, category_id) DO UPDATE SET
      score = score + excluded.score
  `).run(userId, categoryId, delta);
}

async function categorisePost(postId, text, authorId) {
  try {
    const res = await fetch(`${RECOMMENDER_URL}/categorise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, text }),
    });
    const data = await res.json();
    if (data.category_id !== undefined && data.category_id !== -1) {
      db().prepare(`UPDATE posts SET category_id = ?, post_vector = ? WHERE id = ?`)
        .run(
          data.category_id,
          data.post_vector ? JSON.stringify(data.post_vector) : null,
          postId
        );

      // A user's own posts inform their category interests
      if (authorId) {
        recordCategoryScore(authorId, data.category_id, POST_INTEREST_WEIGHT);
      }
    }
  } catch (_) {
    // Recommender not running — post saved, just unranked
  }
}

async function recordInteraction(userId, postId, signal) {
  try {
    const post = db().prepare(`SELECT category_id FROM posts WHERE id = ?`).get(postId);
    if (!post || post.category_id === -1) return;
    await fetch(`${RECOMMENDER_URL}/interact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, category_id: post.category_id, signal }),
    });
    // Mirror score in SQLite for fast feed queries.
    // Dislikes are weighted strongly negative so hated topics drop out
    // of the feed. Scores are allowed to go negative.
    const WEIGHTS = { like: 0.20, dislike: -0.25, comment: 0.12, save: 0.25, view: 0.02 };
    const delta = WEIGHTS[signal] || 0;
    recordCategoryScore(userId, post.category_id, delta);
  } catch (_) {}
}

// Fetch personalised category scores. Recomputed fresh from the database
// on every call (i.e. every page refresh) from the user's own posts,
// likes, dislikes and comments — then enhanced with topology awareness by
// the Python service. Falls back to raw SQLite scores if Python is down.
async function getRankedCategoryScores(userId) {
  const rows = db().prepare(
    `SELECT category_id, score FROM user_interests WHERE userId = ?`
  ).all(userId);
  const direct = Object.fromEntries(rows.map(r => [r.category_id, r.score]));

  try {
    const res = await fetch(`${RECOMMENDER_URL}/ranked-categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, direct_scores: direct }),
    });
    const data = await res.json();
    return Object.fromEntries(data.ranked.map(([c, s]) => [c, s]));
  } catch (_) {
    // Fallback: use raw SQLite scores without topology boost
    return direct;
  }
}

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Profile pictures folder
const picsFolder = path.join(__dirname, "profile_pics");
if (!fs.existsSync(picsFolder)) fs.mkdirSync(picsFolder);
const upload = multer({ dest: picsFolder });

function notify(userId, type, payload) {
  db().prepare(`
    INSERT INTO notifications (id, userId, type, payload, read, created)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(uuidv4(), userId, type, JSON.stringify(payload), Date.now());
}

function getFollowStats(userId) {
  const followers = db().prepare(`SELECT COUNT(*) AS count FROM follows WHERE followingId = ?`).get(userId).count;
  const following = db().prepare(`SELECT COUNT(*) AS count FROM follows WHERE followerId = ?`).get(userId).count;
  return { followers, following };
}

// ---------------------------------------------------------
// AUTO‑CREATE GUEST USER
// ---------------------------------------------------------
app.use((req, res, next) => {
  let userId = req.cookies.userId;

  if (userId) {
    const user = db().prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (user) {
      req.user = user;
      return next();
    }
  }

  // Create guest
  const newId = uuidv4();
  const created = Date.now();

  db().prepare(`
    INSERT INTO users (id, guest, created)
    VALUES (?, 1, ?)
  `).run(newId, created);

  res.cookie("userId", newId, { httpOnly: false });
  req.user = db().prepare("SELECT * FROM users WHERE id = ?").get(newId);

  next();
});


// ---------------------------------------------------------
// VIEWS (EJS)
// ---------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


// ---------------------------------------------------------
// SIGNUP — Upgrade guest
// ---------------------------------------------------------
app.post("/signup", upload.single("profilePic"), async (req, res) => {
  const { username, password, bio } = req.body;

  const exists = db().prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (exists) return res.status(400).json({ error: "Username already taken" });

  const hash = await bcrypt.hash(password, 10);
  const cleanBio = bio ? bio.split(/\s+/).slice(0, 40).join(" ") : "";

  let profilePic = req.user.profilePic;
  if (req.file) {
    const newPath = path.join(picsFolder, `${req.user.id}.png`);
    fs.renameSync(req.file.path, newPath);
    profilePic = `/profile_pics/${req.user.id}.png`;
  }

  db().prepare(`
    UPDATE users SET
      username = ?,
      passwordHash = ?,
      bio = ?,
      profilePic = ?,
      guest = 0
    WHERE id = ?
  `).run(username, hash, cleanBio, profilePic, req.user.id);

  res.json({ success: true });
});


// ---------------------------------------------------------
// LOGIN — Merge guest data
// ---------------------------------------------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const realUser = db().prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!realUser) return res.status(400).json({ error: "Invalid username" });

  const match = await bcrypt.compare(password, realUser.passwordHash);
  if (!match) return res.status(400).json({ error: "Invalid password" });

  const guest = req.user;

  if (guest && guest.guest) {
    // Reassign posts
    db().prepare(`
      UPDATE posts SET userId = ?
      WHERE userId = ?
    `).run(realUser.id, guest.id);

    // Reassign likes
    db().prepare(`
      UPDATE likes SET userId = ?
      WHERE userId = ?
    `).run(realUser.id, guest.id);

    // Reassign comments
    db().prepare(`
      UPDATE comments SET userId = ?
      WHERE userId = ?
    `).run(realUser.id, guest.id);

    // Delete guest user
    db().prepare("DELETE FROM users WHERE id = ?").run(guest.id);
  }

  res.cookie("userId", realUser.id, { httpOnly: false });
  res.json({ success: true });
});


// ---------------------------------------------------------
// LOGOUT
// ---------------------------------------------------------
app.post("/logout", (req, res) => {
  res.clearCookie("userId");
  res.json({ success: true });
});


// ---------------------------------------------------------
// UPDATE PROFILE
// ---------------------------------------------------------
app.post("/update-profile", upload.single("profilePic"), async (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: "Not logged in" });

  const { username, bio, password } = req.body;

  let profilePic = req.user.profilePic;
  if (req.file) {
    const newPath = path.join(picsFolder, `${req.user.id}.png`);
    fs.renameSync(req.file.path, newPath);
    profilePic = `/profile_pics/${req.user.id}.png`;
  }

  let hash = req.user.passwordHash;
  if (password && password.trim() !== "") {
    hash = await bcrypt.hash(password, 10);
  }

  db().prepare(`
    UPDATE users SET
      username = COALESCE(?, username),
      bio = COALESCE(?, bio),
      passwordHash = ?,
      profilePic = ?
    WHERE id = ?
  `).run(
    username || null,
    bio ? bio.split(/\s+/).slice(0, 40).join(" ") : null,
    hash,
    profilePic,
    req.user.id
  );

  res.json({ success: true });
});


// ---------------------------------------------------------
// CREATE POST (50 char limit)
// ---------------------------------------------------------
app.post("/save-message", (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: "Login required" });

  const text = req.body.message.trim();
  if (text.length > 50) return res.status(400).json({ error: "Post too long" });

  const id = uuidv4();
  const timestamp = Date.now();

  db().prepare(`
    INSERT INTO posts (id, userId, text, timestamp)
    VALUES (?, ?, ?, ?)\
  `).run(id, req.user.id, text, timestamp);

  // Categorise in background — doesn't block the response.
  // Author is passed so the post feeds their own interest profile.
  categorisePost(id, text, req.user.id);

  res.json({ success: true, id, timestamp });
});


// ---------------------------------------------------------
// PERSONAL POSTS
// ---------------------------------------------------------
app.get("/my-posts", (req, res) => {
  const posts = db().prepare(`
    SELECT * FROM posts
    WHERE userId = ? AND deleted = 0
    ORDER BY timestamp DESC
  `).all(req.user.id);

  res.json(posts);
});


// ---------------------------------------------------------
// DELETE POST (soft-delete)
// ---------------------------------------------------------
app.post("/post/:id/delete", (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: "Login required" });

  const postId = req.params.id;

  const post = db().prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  // Only post owner can delete
  if (post.userId !== req.user.id) {
    return res.status(403).json({ error: "Not authorized" });
  }

  db().prepare("UPDATE posts SET deleted = 1 WHERE id = ?").run(postId);

  res.json({ success: true });
});


// ---------------------------------------------------------
// SPAM DETECTION
// Auto-called after every dislike. Three signals raise spam_score:
//   1. High dislike ratio          (lots of people pushing thumbs down)
//   2. Repeat poster flooding      (same user posting too fast)
//   3. Duplicate content           (same text posted multiple times)
// spam_score is 0.0–1.0. Feed multiplies relevance by (1 - spam_score)
// so a score of 0.8 means the post appears 80% less often. Never hard-deleted.
// ---------------------------------------------------------
function updateSpamScore(postId) {
  const post = db().prepare(`SELECT * FROM posts WHERE id = ?`).get(postId);
  if (!post) return;

  let spamScore = 0;

  // Signal 1: dislike ratio
  const votes = db().prepare(`
    SELECT
      SUM(CASE WHEN value =  1 THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
    FROM likes WHERE postId = ?
  `).get(postId);

  const total = (votes.likes || 0) + (votes.dislikes || 0);
  if (total >= 3) {
    const dislikeRatio = (votes.dislikes || 0) / total;
    if (dislikeRatio > 0.7) spamScore += 0.5;       // majority disliked it
    else if (dislikeRatio > 0.5) spamScore += 0.25;  // more dislikes than likes
  }

  // Signal 2: posting too fast (more than 5 posts in the last 10 minutes)
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  const recentPostCount = db().prepare(`
    SELECT COUNT(*) AS count FROM posts
    WHERE userId = ? AND timestamp > ? AND deleted = 0
  `).get(post.userId, tenMinutesAgo).count;

  if (recentPostCount > 10) spamScore += 0.6;       // clear flood
  else if (recentPostCount > 5)  spamScore += 0.3;  // suspicious rate

  // Signal 3: duplicate text (same content posted before by anyone)
  const duplicateCount = db().prepare(`
    SELECT COUNT(*) AS count FROM posts
    WHERE text = ? AND id != ? AND deleted = 0
  `).get(post.text, postId).count;

  if (duplicateCount > 0) spamScore += 0.4;

  // Cap at 0.95 — never fully vanish, just heavily deprioritised
  spamScore = Math.min(0.95, spamScore);

  db().prepare(`UPDATE posts SET spam_score = ? WHERE id = ?`)
    .run(spamScore, postId);
}
app.get("/global-feed", async (req, res) => {
  const limit  = parseInt(req.query.limit)  || 20;
  const offset = parseInt(req.query.offset) || 0;
  // Rank over a wide pool so relevant posts aren't missed just because
  // they aren't the most recent. Keeps recommendations meaningful.
  const pool   = Math.max(limit * 10, 200);

  // Topology-aware scores from Python (falls back to raw SQLite if down)
  const categoryScores = await getRankedCategoryScores(req.user.id);

  const posts = db().prepare(`
    SELECT posts.*, users.username, users.profilePic
    FROM posts
    JOIN users ON posts.userId = users.id
    WHERE posts.userId != ? AND posts.deleted = 0
      AND posts.spam_score < 0.9
    ORDER BY posts.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, pool, offset);

  const now = Date.now();
  const scored = posts.map(p => {
    const catScore   = categoryScores[p.category_id] ?? 0;
    const spamFactor = 1 - (p.spam_score || 0);
    const ageHours   = (now - p.timestamp) / (1000 * 60 * 60);
    const recency    = Math.max(0, 1 - ageHours / 24) * 0.05;
    return { ...p, _score: catScore * spamFactor + recency };
  });

  const ranked   = scored.filter(p => p._score > 0.01).sort((a, b) => b._score - a._score);
  const unranked = scored.filter(p => p._score <= 0.01);

  let finalPosts;
  if (ranked.length === 0) {
    finalPosts = unranked.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  } else {
    const exploreN  = Math.max(1, Math.floor(limit * 0.15));
    const explore   = unranked.sort(() => Math.random() - 0.5).slice(0, exploreN);
    const topRanked = ranked.slice(0, limit - exploreN);
    const merged = [];
    let ei = 0;
    topRanked.forEach((p, i) => {
      merged.push(p);
      if ((i + 1) % 6 === 0 && ei < explore.length) merged.push(explore[ei++]);
    });
    while (ei < explore.length) merged.push(explore[ei++]);
    finalPosts = merged.slice(0, limit);
  }

  const enriched = finalPosts.map(p => {
    const counts = db().prepare(`
      SELECT
        SUM(CASE WHEN value =  1 THEN 1 ELSE 0 END) AS likes,
        SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
      FROM likes WHERE postId = ?
    `).get(p.id);
    const userVoteRow = db().prepare(
      `SELECT value FROM likes WHERE postId = ? AND userId = ?`
    ).get(p.id, req.user.id);
    const { _score, ...rest } = p;
    return { ...rest, likes: counts.likes || 0, dislikes: counts.dislikes || 0, userVote: userVoteRow ? userVoteRow.value : 0 };
  });

  res.json(enriched);
});


// ---------------------------------------------------------
// LIKE / DISLIKE (guests blocked)
// ---------------------------------------------------------
app.post("/post/:id/like", (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: "Login required" });

  const postId = req.params.id;
  const value = parseInt(req.body.value, 10);

  if (![1, -1, 0].includes(value))
    return res.status(400).json({ error: "Invalid value" });

  const existing = db().prepare(`
    SELECT * FROM likes WHERE postId = ? AND userId = ?
  `).get(postId, req.user.id);

  const post = db().prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  let didNotify = false;
  const oldValue = existing ? existing.value : 0;

  if (existing) {
    if (value === 0) {
      db().prepare("DELETE FROM likes WHERE id = ?").run(existing.id);
    } else {
      db().prepare(`
        UPDATE likes SET value = ?, created = ?
        WHERE id = ?
      `).run(value, Date.now(), existing.id);
    }
  } else if (value !== 0) {
    db().prepare(`
      INSERT INTO likes (id, postId, userId, value, created)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), postId, req.user.id, value, Date.now());
  }

  if (post.userId !== req.user.id && value === 1 && oldValue !== 1) {
    notify(post.userId, 'like', {
      fromUserId: req.user.id,
      postId: postId,
      message: `${req.user.username || 'Someone'} liked your post.`
    });
  }

  // Record as interest signal (like = positive, dislike = negative)
  if (value === 1)  recordInteraction(req.user.id, postId, 'like');
  if (value === -1) {
    recordInteraction(req.user.id, postId, 'dislike');
    updateSpamScore(postId);  // re-evaluate spam after every dislike
  }

  const counts = db().prepare(`
    SELECT
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
    FROM likes WHERE postId = ?
  `).get(postId);

  const userVote = db().prepare(`
    SELECT value FROM likes WHERE postId = ? AND userId = ?
  `).get(postId, req.user.id);

  res.json({
    likes: counts.likes || 0,
    dislikes: counts.dislikes || 0,
    userVote: userVote ? userVote.value : 0
  });
});


// ---------------------------------------------------------
// COMMENTS (guests can view, not comment)
// ---------------------------------------------------------
app.get("/post/:id/comments", (req, res) => {
  const postId = req.params.id;

  const comments = db().prepare(`
    SELECT c.id, c.text, c.timestamp,
           u.id AS userId, u.username, u.profilePic
    FROM comments c
    JOIN users u ON c.userId = u.id
    WHERE c.postId = ?
    ORDER BY c.timestamp ASC
  `).all(postId);

  res.json(comments);
});

app.post("/post/:id/comment", (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: "Login required" });

  const postId = req.params.id;
  const text = (req.body.text || "").trim();

  if (!text) return res.status(400).json({ error: "Empty comment" });
  if (text.length > 50) return res.status(400).json({ error: "Comment too long" });

  const id = uuidv4();
  const timestamp = Date.now();

  db().prepare(`
    INSERT INTO comments (id, postId, userId, text, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, postId, req.user.id, text, timestamp);

  const post = db().prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (post && post.userId !== req.user.id) {
    notify(post.userId, 'comment', {
      fromUserId: req.user.id,
      postId: postId,
      commentId: id,
      message: `${req.user.username || 'Someone'} commented on your post.`
    });
  }

  // Commenting signals strong interest
  recordInteraction(req.user.id, postId, 'comment');

  const comment = db().prepare(`
    SELECT c.id, c.text, c.timestamp,
           u.id AS userId, u.username, u.profilePic
    FROM comments c
    JOIN users u ON c.userId = u.id
    WHERE c.id = ?
  `).get(id);

  res.json(comment);
});


// ---------------------------------------------------------
// FOLLOW REQUESTS & NOTIFICATIONS

app.post('/user/:id/request-follow', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });

  const targetId = req.params.id;
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot request yourself' });

  const targetUser = db().prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const existingFollow = db().prepare('SELECT * FROM follows WHERE followerId = ? AND followingId = ?').get(req.user.id, targetId);
  if (existingFollow) return res.status(400).json({ error: 'Already following this user' });

  const existingRequest = db().prepare('SELECT * FROM follow_requests WHERE fromUserId = ? AND toUserId = ?').get(req.user.id, targetId);
  if (existingRequest) return res.status(400).json({ error: 'Follow request already pending' });

  db().prepare(`
    INSERT INTO follow_requests (id, fromUserId, toUserId, created)
    VALUES (?, ?, ?, ?)
  `).run(uuidv4(), req.user.id, targetId, Date.now());

  notify(targetId, 'follow_request', {
    fromUserId: req.user.id,
    message: `${req.user.username || 'Someone'} wants to follow you.`
  });

  res.json({ success: true });
});

app.get('/follow-requests', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });

  const requests = db().prepare(`
    SELECT fr.id, fr.fromUserId, fr.created, u.username, u.profilePic
    FROM follow_requests fr
    JOIN users u ON fr.fromUserId = u.id
    WHERE fr.toUserId = ?
    ORDER BY fr.created DESC
  `).all(req.user.id);

  res.json(requests);
});

app.post('/follow-request/:id/accept', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });

  const reqId = req.params.id;
  const request = db().prepare('SELECT * FROM follow_requests WHERE id = ?').get(reqId);
  if (!request) return res.status(404).json({ error: 'Follow request not found' });
  if (request.toUserId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  const fromUser = db().prepare('SELECT id, username FROM users WHERE id = ?').get(request.fromUserId);
  if (!fromUser) return res.status(404).json({ error: 'User not found' });

  db().prepare(`
    INSERT OR IGNORE INTO follows (id, followerId, followingId, created)
    VALUES (?, ?, ?, ?)
  `).run(uuidv4(), req.user.id, request.fromUserId, Date.now());

  db().prepare('DELETE FROM follow_requests WHERE id = ?').run(reqId);

  notify(request.fromUserId, 'follow_accept', {
    fromUserId: req.user.id,
    message: `${req.user.username || 'Someone'} accepted your follow request.`
  });

  res.json({ success: true });
});

app.get('/notifications', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });

  const notifications = db().prepare(`
    SELECT * FROM notifications
    WHERE userId = ? AND read = 0
    ORDER BY created DESC
    LIMIT 20
  `).all(req.user.id);

  const unread = db().prepare(`
    SELECT COUNT(*) AS count FROM notifications WHERE userId = ? AND read = 0
  `).get(req.user.id).count;

  res.json({ notifications, unread });
});

app.post('/notifications/mark-read', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });
  db().prepare('UPDATE notifications SET read = 1 WHERE userId = ?').run(req.user.id);
  res.json({ success: true });
});

app.post('/notifications/:id/dismiss', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });
  const notificationId = req.params.id;
  db().prepare('UPDATE notifications SET read = 1 WHERE id = ? AND userId = ?').run(notificationId, req.user.id);
  res.json({ success: true });
});

app.get('/my-followers', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });
  const followers = db().prepare(`
    SELECT u.id, u.username, u.profilePic
    FROM follows f
    JOIN users u ON f.followerId = u.id
    WHERE f.followingId = ?
    ORDER BY u.username
  `).all(req.user.id);
  res.json(followers);
});

app.get('/my-following', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });
  const following = db().prepare(`
    SELECT u.id, u.username, u.profilePic
    FROM follows f
    JOIN users u ON f.followingId = u.id
    WHERE f.followerId = ?
    ORDER BY u.username
  `).all(req.user.id);
  res.json(following);
});

app.post('/unfollow/:id', (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: 'Login required' });
  const targetId = req.params.id;
  db().prepare('DELETE FROM follows WHERE followerId = ? AND followingId = ?').run(req.user.id, targetId);
  res.json({ success: true });
});

app.get('/post-details/:id', (req, res) => {
  const id = req.params.id;
  const post = db().prepare(`
    SELECT posts.*, u.username, u.profilePic
    FROM posts
    JOIN users u ON posts.userId = u.id
    WHERE posts.id = ? AND posts.deleted = 0
  `).get(id);

  if (!post) return res.status(404).json({ error: 'Post not found' });

  const counts = db().prepare(`
    SELECT
      SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
    FROM likes WHERE postId = ?
  `).get(id);

  const userVoteRow = db().prepare(`
    SELECT value FROM likes WHERE postId = ? AND userId = ?
  `).get(id, req.user.id);

  res.json({
    post: {
      ...post,
      likes: counts.likes || 0,
      dislikes: counts.dislikes || 0,
      userVote: userVoteRow ? userVoteRow.value : 0
    }
  });
});

app.get('/view-post/:id', (req, res) => {
  res.render('post', { user: req.user });
});

// ---------------------------------------------------------
// PUBLIC USER PROFILE
// ---------------------------------------------------------
app.get("/user/:id", (req, res) => {
  const id = req.params.id;

  const user = db().prepare(`
    SELECT id, username, bio, profilePic
    FROM users
    WHERE id = ?
  `).get(id);

  if (!user) return res.status(404).json({ error: "User not found" });

  const posts = db().prepare(`
    SELECT * FROM posts
    WHERE userId = ? AND deleted = 0
    ORDER BY timestamp DESC
  `).all(id);

  const stats = getFollowStats(id);
  const outgoingRequest = req.user.guest ? null : db().prepare(`
    SELECT id FROM follow_requests WHERE fromUserId = ? AND toUserId = ?
  `).get(req.user.id, id);
  const incomingRequest = req.user.guest ? null : db().prepare(`
    SELECT id FROM follow_requests WHERE fromUserId = ? AND toUserId = ?
  `).get(id, req.user.id);
  const isFollowing = req.user.guest ? false : !!db().prepare(`
    SELECT * FROM follows WHERE followerId = ? AND followingId = ?
  `).get(req.user.id, id);

  res.json({
    user,
    posts,
    followers: stats.followers,
    following: stats.following,
    requestPending: !!outgoingRequest,
    incomingRequestId: incomingRequest ? incomingRequest.id : null,
    isFollowing
  });
});


// ---------------------------------------------------------
// CURRENT USER
// ---------------------------------------------------------
app.get("/me", (req, res) => {
  const stats = getFollowStats(req.user.id);
  const unread = db().prepare(`SELECT COUNT(*) AS count FROM notifications WHERE userId = ? AND read = 0`).get(req.user.id).count;
  const pending = db().prepare(`SELECT COUNT(*) AS count FROM follow_requests WHERE toUserId = ?`).get(req.user.id).count;

  res.json({
    loggedIn: !req.user.guest,
    guest: req.user.guest,
    id: req.user.id,
    username: req.user.username,
    profilePic: req.user.profilePic,
    bio: req.user.bio,
    followers: stats.followers,
    following: stats.following,
    unreadNotifications: unread,
    incomingRequests: pending
  });
});


// ---------------------------------------------------------
// ADMIN MIDDLEWARE
// ---------------------------------------------------------
function requireAdmin(req, res, next) {
  if (!req.user || req.user.username !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ---------------------------------------------------------
// ADMIN: Get user's category interests (likes/dislikes breakdown)
// ---------------------------------------------------------
app.get('/admin/user/:id/interests', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const user = db().prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const interests = db().prepare(`
    SELECT category_id, score FROM user_interests
    WHERE userId = ?
    ORDER BY score DESC
  `).all(userId);

  // Get category descriptions from Python service
  let categoryInfo = {};
  try {
    const catRes = await fetch(`${RECOMMENDER_URL}/categories`);
    categoryInfo = await catRes.json();
  } catch (_) {}

  const enriched = interests.map(i => ({
    category_id: i.category_id,
    score: i.score,
    words: categoryInfo[String(i.category_id)]?.words || [],
    description: categoryInfo[String(i.category_id)]?.description || `category_${i.category_id}`,
  }));

  // Also get their posts with categories
  const posts = db().prepare(`
    SELECT id, text, category_id FROM posts
    WHERE userId = ? AND deleted = 0
    ORDER BY timestamp DESC
  `).all(userId);

  res.json({ user, interests: enriched, posts });
});

// ---------------------------------------------------------
// ADMIN: Get all categories overview
// ---------------------------------------------------------
app.get('/admin/categories', requireAdmin, async (req, res) => {
  let categoryInfo = {};
  try {
    const catRes = await fetch(`${RECOMMENDER_URL}/categories`);
    categoryInfo = await catRes.json();
  } catch (_) {
    // If recommender is down, build from DB
    const cats = db().prepare(`
      SELECT category_id, COUNT(*) AS count FROM posts
      WHERE deleted = 0 AND category_id != -1
      GROUP BY category_id
      ORDER BY count DESC
    `).all();
    cats.forEach(c => {
      categoryInfo[String(c.category_id)] = { post_count: c.count, words: [], description: `category_${c.category_id}` };
    });
  }
  res.json(categoryInfo);
});

// ---------------------------------------------------------
// ADMIN: List all users (for admin panel)
// ---------------------------------------------------------
app.get('/admin/users', requireAdmin, (req, res) => {
  const users = db().prepare(`
    SELECT id, username, profilePic, guest, created FROM users
    WHERE guest = 0
    ORDER BY username
  `).all();
  res.json(users);
});

// ---------------------------------------------------------
// ADMIN PAGES
// ---------------------------------------------------------
app.get('/admin', requireAdmin, (req, res) => res.render('admin', { user: req.user }));
app.get('/admin/user-view', requireAdmin, (req, res) => res.render('admin-user', { user: req.user }));
app.get('/admin/categories-view', requireAdmin, (req, res) => res.render('admin-categories', { user: req.user }));

// ---------------------------------------------------------
// RENDER PAGES USING EJS
// ---------------------------------------------------------
app.get('/', (req, res) => res.render('index', { user: req.user }));
app.get('/index.html', (req, res) => res.render('index', { user: req.user }));

app.get('/login', (req, res) => res.render('login', { user: req.user }));
app.get('/login.html', (req, res) => res.render('login', { user: req.user }));

app.get('/signup', (req, res) => res.render('signup', { user: req.user }));
app.get('/signup.html', (req, res) => res.render('signup', { user: req.user }));

app.get('/profile', (req, res) => res.render('profile', { user: req.user }));
app.get('/profile.html', (req, res) => res.render('profile', { user: req.user }));

app.get('/update-profile', (req, res) => res.render('update-profile', { user: req.user }));
app.get('/update-profile.html', (req, res) => res.render('update-profile', { user: req.user }));

app.get('/user', (req, res) => res.render('user', { user: req.user }));
app.get('/user.html', (req, res) => res.render('user', { user: req.user }));

// Serve static assets (CSS/JS/images)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/profile_pics', express.static(picsFolder));

// 404 fallback render
app.use((req, res) => res.status(404).render('404'));

// ---------------------------------------------------------
// CATEGORISE ALL UNCATEGORISED POSTS ON STARTUP
// Waits for the Python recommender to be available, then
// feeds all posts with category_id = -1 through it.
// ---------------------------------------------------------
async function categoriseBacklog() {
  // Wait up to 15 seconds for the recommender to come online
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${RECOMMENDER_URL}/categories`);
      if (res.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }

  if (!ready) {
    console.log('[categorise-backlog] Recommender not available, skipping backlog.');
    return;
  }

  const uncategorised = db().prepare(`
    SELECT id, text, userId FROM posts
    WHERE category_id = -1 AND deleted = 0
    ORDER BY timestamp ASC
  `).all();

  if (uncategorised.length === 0) return;
  console.log(`[categorise-backlog] Feeding ${uncategorised.length} posts to recommender...`);

  for (const post of uncategorised) {
    try {
      const res = await fetch(`${RECOMMENDER_URL}/categorise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post_id: post.id, text: post.text }),
      });
      const data = await res.json();
      if (data.category_id !== undefined && data.category_id !== -1) {
        db().prepare(`UPDATE posts SET category_id = ?, post_vector = ? WHERE id = ?`)
          .run(
            data.category_id,
            data.post_vector ? JSON.stringify(data.post_vector) : null,
            post.id
          );
        // Seed the author's interest from their own post
        if (post.userId) {
          recordCategoryScore(post.userId, data.category_id, POST_INTEREST_WEIGHT);
        }
      }
    } catch (_) {
      break; // recommender died, stop trying
    }
  }

  const remaining = db().prepare(`SELECT COUNT(*) AS c FROM posts WHERE category_id = -1 AND deleted = 0`).get().c;
  const done = uncategorised.length - remaining;
  console.log(`[categorise-backlog] Done. Categorised ${done} posts, ${remaining} still pending (need more posts to fit model).`);
}

// ---------------------------------------------------------
// ADMIN: Trigger recategorisation manually
// ---------------------------------------------------------
app.post('/admin/recategorise', requireAdmin, async (req, res) => {
  categoriseBacklog();
  res.json({ success: true, message: 'Recategorisation started in background' });
});

// ---------------------------------------------------------
// Start server with database initialization
(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });

  // Categorise backlog after server starts
  categoriseBacklog();
})();
