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
      db().prepare(`UPDATE posts SET category_id = ?, post_vector = ?, sentiment = ? WHERE id = ?`)
        .run(
          data.category_id,
          data.post_vector ? JSON.stringify(data.post_vector) : null,
          data.sentiment || 0,
          postId
        );

      // A user's own posts inform their category interests
      if (authorId) {
        recordCategoryScore(authorId, data.category_id, POST_INTEREST_WEIGHT);
      }

      // Store hashtag associations: each hashtag maps to this category
      if (data.hashtags && data.hashtags.length > 0) {
        for (const tag of data.hashtags) {
          db().prepare(`
            INSERT INTO hashtags (tag, category_id, post_count)
            VALUES (?, ?, 1)
            ON CONFLICT(tag) DO UPDATE SET
              category_id = excluded.category_id,
              post_count = post_count + 1
          `).run(tag, data.category_id);

          db().prepare(`
            INSERT INTO post_hashtags (postId, tag) VALUES (?, ?)
            ON CONFLICT(postId, tag) DO NOTHING
          `).run(postId, tag);
        }

        // Hashtags give a stronger interest signal than plain text
        if (authorId) {
          recordCategoryScore(authorId, data.category_id, data.hashtags.length * 0.05);
        }
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

  // Collaborative: category-level signal from similar users
  const myTopCats = rows
    .filter(r => r.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(r => r.category_id);

  let collaborative = {};
  if (myTopCats.length > 0) {
    const placeholders = myTopCats.map(() => '?').join(',');
    const simUsers = db().prepare(`
      SELECT userId, SUM(score) AS s FROM user_interests
      WHERE category_id IN (${placeholders}) AND userId != ? AND score > 0.1
      GROUP BY userId ORDER BY s DESC LIMIT 10
    `).all(...myTopCats, userId);

    if (simUsers.length > 0) {
      const simIds = simUsers.map(u => u.userId);
      const simPH = simIds.map(() => '?').join(',');
      const simInterests = db().prepare(`
        SELECT category_id, AVG(score) AS avgScore FROM user_interests
        WHERE userId IN (${simPH}) AND score > 0.05
        GROUP BY category_id
      `).all(...simIds);
      collaborative = Object.fromEntries(
        simInterests.map(r => [r.category_id, r.avgScore])
      );
    }
  }

  try {
    const res = await fetch(`${RECOMMENDER_URL}/ranked-categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, direct_scores: direct, collaborative }),
    });
    const data = await res.json();
    return Object.fromEntries(data.ranked.map(([c, s]) => [c, s]));
  } catch (_) {
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
// CREATE POST (100 char limit)
// ---------------------------------------------------------
app.post("/save-message", (req, res) => {
  if (req.user.guest) return res.status(401).json({ error: "Login required" });

  const text = req.body.message.trim();
  if (text.length > 100) return res.status(400).json({ error: "Post too long" });

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
// ---------------------------------------------------------
// ENGAGEMENT TRACKING
// Receives batched view/hover data from the frontend.
// Very slight positive signal — dwarfed by likes/dislikes
// but helps surface posts that passively engage people.
// ---------------------------------------------------------
app.post("/track-engagement", (req, res) => {
  if (req.user.guest) return res.json({ ok: true }); // don't track guests

  const events = req.body.events;
  if (!Array.isArray(events)) return res.status(400).json({ error: "Bad data" });

  const now = Date.now();
  for (const ev of events.slice(0, 50)) { // cap at 50 per batch
    const { postId, viewMs, hoverMs } = ev;
    if (!postId) continue;

    const viewClamped  = Math.min(Math.max(0, viewMs  || 0), 60000);
    const hoverClamped = Math.min(Math.max(0, hoverMs || 0), 60000);

    // Only record meaningful engagement (> 1 second viewed)
    if (viewClamped < 1000) continue;

    db().prepare(`
      INSERT INTO engagement (id, postId, userId, viewMs, hoverMs, created)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), postId, req.user.id, viewClamped, hoverClamped, now);

    // Micro-signal: long views are a weak interest signal.
    // 3+ seconds viewed = 0.01, 8+ seconds = 0.02, hover adds 0.01
    const post = db().prepare('SELECT category_id FROM posts WHERE id = ?').get(postId);
    if (post && post.category_id !== -1) {
      let delta = 0;
      if (viewClamped >= 8000) delta += 0.02;
      else if (viewClamped >= 3000) delta += 0.01;
      if (hoverClamped >= 2000) delta += 0.01;
      if (delta > 0) recordCategoryScore(req.user.id, post.category_id, delta);
    }
  }

  res.json({ ok: true });
});


// ---------------------------------------------------------
// RELEVANT ACCOUNTS
// Instead of scanning all users, pick a focused set of accounts
// whose content is most likely relevant to the current user.
// This set is based on:
//   1. Users who post in the same categories the current user likes
//   2. Users whose posts were liked by taste-similar users
//   3. A handful of random accounts for discovery / anti-stagnation
// The set refreshes on every page load + updates via interactions.
// ---------------------------------------------------------
function getRelevantAccountIds(userId, topN = 20) {
  const myInterests = db().prepare(
    'SELECT category_id, score FROM user_interests WHERE userId = ?'
  ).all(userId);

  // COLD START: new user with no interests yet.
  // Return null to signal the feed should do a wide category spread.
  if (myInterests.length === 0) {
    return null;
  }

  const myTopCats = myInterests
    .filter(r => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(r => r.category_id);

  // If user has some interests but they're all very weak, still do discovery
  if (myTopCats.length === 0) {
    return null;
  }

  const accountScores = {};

  // 1. Users who post in categories the current user likes
  if (myTopCats.length > 0) {
    const ph = myTopCats.map(() => '?').join(',');
    const posters = db().prepare(`
      SELECT userId, COUNT(*) AS cnt FROM posts
      WHERE category_id IN (${ph}) AND userId != ? AND deleted = 0
      GROUP BY userId
      ORDER BY cnt DESC
      LIMIT 30
    `).all(...myTopCats, userId);
    for (const p of posters) {
      accountScores[p.userId] = (accountScores[p.userId] || 0) + p.cnt * 2;
    }
  }

  // 2. Users whose posts are liked by taste-similar users (collaborative)
  if (myTopCats.length > 0) {
    const ph = myTopCats.map(() => '?').join(',');
    const simUsers = db().prepare(`
      SELECT userId FROM user_interests
      WHERE category_id IN (${ph}) AND userId != ? AND score > 0.1
      GROUP BY userId
      ORDER BY SUM(score) DESC
      LIMIT 10
    `).all(...myTopCats, userId);

    if (simUsers.length > 0) {
      const simIds = simUsers.map(u => u.userId);
      const simPH = simIds.map(() => '?').join(',');
      const likedAuthors = db().prepare(`
        SELECT p.userId, COUNT(*) AS cnt
        FROM likes l JOIN posts p ON l.postId = p.id
        WHERE l.userId IN (${simPH}) AND l.value = 1 AND p.userId != ?
        GROUP BY p.userId
        ORDER BY cnt DESC
        LIMIT 20
      `).all(...simIds, userId);
      for (const a of likedAuthors) {
        accountScores[a.userId] = (accountScores[a.userId] || 0) + a.cnt;
      }
    }
  }

  // 3. Following — users the current user explicitly follows
  const following = db().prepare(
    'SELECT followingId FROM follows WHERE followerId = ?'
  ).all(userId);
  for (const f of following) {
    accountScores[f.followingId] = (accountScores[f.followingId] || 0) + 5;
  }

  // Sort and take topN, then add a few random for discovery
  const sorted = Object.entries(accountScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN - 3)
    .map(([id]) => id);

  // 4. A few random accounts for anti-stagnation / discovery
  const randomAccounts = db().prepare(`
    SELECT id FROM users
    WHERE guest = 0 AND id != ?
    ORDER BY RANDOM()
    LIMIT 3
  `).all(userId).map(u => u.id);

  const combined = [...new Set([...sorted, ...randomAccounts])];
  return combined;
}


// ---------------------------------------------------------
// GLOBAL FEED
// Pulls posts primarily from relevant accounts, heavily
// weighted by recency, with seen-penalty for already-served posts.
// ---------------------------------------------------------
app.get("/global-feed", async (req, res) => {
  const limit  = parseInt(req.query.limit)  || 20;
  const offset = parseInt(req.query.offset) || 0;

  // Topology-aware category scores
  const categoryScores = await getRankedCategoryScores(req.user.id);

  // Get relevant accounts for this user (null = cold start / new user)
  const relevantIds = getRelevantAccountIds(req.user.id, 20);

  const now = Date.now();

  // Exclude posts already served recently (< 1 hour) — forces fresh content
  // on every scroll rather than re-scoring the same posts.
  const recentlySeen = db().prepare(`
    SELECT postId FROM feed_seen
    WHERE userId = ? AND seenAt > ?
  `).all(req.user.id, now - 60 * 60 * 1000).map(r => r.postId);

  const excludeClause = recentlySeen.length > 0
    ? `AND posts.id NOT IN (${recentlySeen.map(() => '?').join(',')})`
    : '';
  const excludeParams = recentlySeen.length > 0 ? recentlySeen : [];

  let posts;

  if (relevantIds === null) {
    // COLD START: pick posts spread across as many categories as possible
    // so the user sees a wide variety and their interactions teach the algorithm.
    // Get one recent post from each category, ordered by recency.
    posts = db().prepare(`
      SELECT posts.*, users.username, users.profilePic
      FROM posts
      JOIN users ON posts.userId = users.id
      WHERE posts.userId != ?
        AND posts.deleted = 0
        AND posts.spam_score < 0.9
        AND posts.category_id != -1
        ${excludeClause}
      ORDER BY posts.timestamp DESC
      LIMIT 200
    `).all(req.user.id, ...excludeParams);

    // Deduplicate by category: pick the most recent post per category
    const seenCats = new Set();
    const diverse = [];
    for (const p of posts) {
      if (!seenCats.has(p.category_id)) {
        diverse.push(p);
        seenCats.add(p.category_id);
      }
    }
    // Fill remaining slots with other recent posts for volume
    for (const p of posts) {
      if (diverse.length >= 60) break;
      if (!diverse.includes(p)) diverse.push(p);
    }
    posts = diverse;
  } else if (relevantIds.length > 0) {
    const ph = relevantIds.map(() => '?').join(',');
    posts = db().prepare(`
      SELECT posts.*, users.username, users.profilePic
      FROM posts
      JOIN users ON posts.userId = users.id
      WHERE posts.userId IN (${ph})
        AND posts.userId != ?
        AND posts.deleted = 0
        AND posts.spam_score < 0.9
        ${excludeClause}
      ORDER BY posts.timestamp DESC
      LIMIT 200
    `).all(...relevantIds, req.user.id, ...excludeParams);
  } else {
    posts = db().prepare(`
      SELECT posts.*, users.username, users.profilePic
      FROM posts
      JOIN users ON posts.userId = users.id
      WHERE posts.userId != ? AND posts.deleted = 0
        AND posts.spam_score < 0.9
        ${excludeClause}
      ORDER BY posts.timestamp DESC
      LIMIT 200
    `).all(req.user.id, ...excludeParams);
  }

  // Engagement signal: posts with high avg view time get a small boost
  const engagementMap = {};
  const engRows = db().prepare(`
    SELECT postId, AVG(viewMs) AS avgView, AVG(hoverMs) AS avgHover, COUNT(*) AS n
    FROM engagement
    GROUP BY postId
    HAVING n >= 2
  `).all();
  for (const e of engRows) {
    engagementMap[e.postId] = Math.min(0.1, (e.avgView / 10000) * 0.1 + (e.avgHover / 5000) * 0.03);
  }

  // Score each post
  const scored = posts.map(p => {
    const catScore       = categoryScores[p.category_id] ?? 0;
    const spamFactor     = 1 - (p.spam_score || 0);
    const engagementBoost = engagementMap[p.id] || 0;

    // RECENCY: strong time-based boost. Posts < 1hr get major boost,
    // < 6hr moderate, < 24hr mild. Older posts decay quickly.
    const ageMs    = now - p.timestamp;
    const ageHours = ageMs / (1000 * 60 * 60);
    let recency;
    if (ageHours < 1)       recency = 1.0;
    else if (ageHours < 6)  recency = 0.7;
    else if (ageHours < 24) recency = 0.4;
    else if (ageHours < 72) recency = 0.15;
    else                    recency = 0.05;

    // Final score: recency is a major factor, multiplied by relevance
    const relevance = Math.max(0.01, catScore) * spamFactor + engagementBoost;
    const score = (relevance * 0.4 + recency * 0.6);

    return { ...p, _score: score };
  });

  // Sort by score, then enforce diversity: max 2 posts per user, never adjacent
  scored.sort((a, b) => b._score - a._score);

  const userCount = {};    // userId -> how many posts picked so far
  const diverseFeed = [];
  let lastUserId = null;

  for (const p of scored) {
    if (diverseFeed.length >= limit) break;

    const count = userCount[p.userId] || 0;
    if (count >= 2) continue;            // max 2 posts per user
    if (p.userId === lastUserId) continue; // never back-to-back same user

    userCount[p.userId] = count + 1;
    lastUserId = p.userId;
    diverseFeed.push(p);
  }

  const finalPosts = diverseFeed;

  // Record these posts as "seen" for future penalty
  const seenNow = Date.now();
  for (const p of finalPosts) {
    db().prepare(`
      INSERT INTO feed_seen (userId, postId, seenAt)
      VALUES (?, ?, ?)
      ON CONFLICT(userId, postId) DO UPDATE SET seenAt = excluded.seenAt
    `).run(req.user.id, p.id, seenNow);
  }

  // Enrich with like/dislike counts
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
// HASHTAG LOOKUP
// ---------------------------------------------------------
app.get("/hashtag/:tag", (req, res) => {
  const tag = req.params.tag.toLowerCase().replace(/^#/, '');

  const hashtagInfo = db().prepare('SELECT * FROM hashtags WHERE tag = ?').get(tag);
  const posts = db().prepare(`
    SELECT posts.*, users.username, users.profilePic
    FROM post_hashtags ph
    JOIN posts ON ph.postId = posts.id
    JOIN users ON posts.userId = users.id
    WHERE ph.tag = ? AND posts.deleted = 0
    ORDER BY posts.timestamp DESC
    LIMIT 50
  `).all(tag);

  const enriched = posts.map(p => {
    const counts = db().prepare(`
      SELECT
        SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
        SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
      FROM likes WHERE postId = ?
    `).get(p.id);
    const userVoteRow = db().prepare(
      `SELECT value FROM likes WHERE postId = ? AND userId = ?`
    ).get(p.id, req.user.id);
    return { ...p, likes: counts.likes || 0, dislikes: counts.dislikes || 0, userVote: userVoteRow ? userVoteRow.value : 0 };
  });

  res.json({ tag, category_id: hashtagInfo?.category_id ?? -1, post_count: hashtagInfo?.post_count ?? 0, posts: enriched });
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
  if (text.length > 100) return res.status(400).json({ error: "Comment too long" });

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

app.get('/hashtag/:tag', (req, res, next) => {
  // If it's an API request (from fetch) the route above handles it.
  // This renders the page for direct browser navigation.
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.render('hashtag', { user: req.user });
  }
  next();
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
        db().prepare(`UPDATE posts SET category_id = ?, post_vector = ?, sentiment = ? WHERE id = ?`)
          .run(
            data.category_id,
            data.post_vector ? JSON.stringify(data.post_vector) : null,
            data.sentiment || 0,
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
