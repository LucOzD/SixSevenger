// post-routes.js — creating, reading, voting on and commenting on posts,
// plus the ranked feed and engagement tracking.

import { json, badRequest, unauthorized, forbidden, notFound, readJson, uuid } from '../http.js';
import {
  loadAnalyser, saveAnalyser, recordCategoryScoreStmt,
  getUserInterests, getUserSentimentPref, getCollaborativeScores,
  getRelevantAccountIds,
} from '../storage.js';
import { UserProfiler, SIGNAL_WEIGHTS, POST_INTEREST_WEIGHT } from '../recommender.js';

export const MAX_POST_LENGTH = 100;
export const MAX_COMMENT_LENGTH = 100;

const HASHTAG_INTEREST_WEIGHT = 0.05;

// ---------------------------------------------------------------------------
// Create a post
// ---------------------------------------------------------------------------
export async function handleSavePost(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const body = await readJson(request);
  const text = (body.message || '').trim();
  if (!text) return badRequest('Post cannot be empty', ctx);
  if (text.length > MAX_POST_LENGTH) {
    return badRequest(`Post too long (max ${MAX_POST_LENGTH})`, ctx);
  }

  const id = uuid();
  const timestamp = Date.now();

  // Vectors are needed here so a category can split if it has grown incoherent
  const analyser = await loadAnalyser(db, { withVectors: true });

  // The author's history helps resolve posts VADER finds ambiguous
  const history = await db
    .prepare(
      `SELECT category_id, sentiment FROM posts
        WHERE userId = ? AND deleted = 0 AND category_id != -1`
    )
    .bind(user.id)
    .all();

  let authorContext = null;
  const rows = history.results || [];
  if (rows.length > 0) {
    const avgSentiment = rows.reduce((sum, r) => sum + (r.sentiment || 0), 0) / rows.length;
    const counts = {};
    for (const r of rows) counts[r.category_id] = (counts[r.category_id] || 0) + 1;
    const topCategories = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat]) => Number(cat));
    authorContext = { avgSentiment, topCategories };
  }

  const result = analyser.addPost(text, authorContext);

  const statements = [
    db
      .prepare(
        `INSERT INTO posts (id, userId, text, timestamp, deleted, category_id, spam_score, post_vector, sentiment)
         VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`
      )
      .bind(id, user.id, text, timestamp, result.categoryId,
            JSON.stringify(result.vector), result.sentiment),
    recordCategoryScoreStmt(db, user.id, result.categoryId, POST_INTEREST_WEIGHT),
  ];

  // Hashtags map to the post's category and count as a stronger interest signal
  for (const tag of result.hashtags) {
    statements.push(
      db
        .prepare(
          `INSERT INTO hashtags (tag, category_id, post_count) VALUES (?, ?, 1)
           ON CONFLICT(tag) DO UPDATE SET
             category_id = excluded.category_id,
             post_count = post_count + 1`
        )
        .bind(tag, result.categoryId),
      db
        .prepare('INSERT OR IGNORE INTO post_hashtags (postId, tag) VALUES (?, ?)')
        .bind(id, tag)
    );
  }
  if (result.hashtags.length > 0) {
    statements.push(
      recordCategoryScoreStmt(db, user.id, result.categoryId,
        result.hashtags.length * HASHTAG_INTEREST_WEIGHT)
    );
  }

  await db.batch(statements);
  await saveAnalyser(db, analyser);

  return json({
    success: true,
    id,
    timestamp,
    category_id: result.categoryId,
    sentiment: result.sentiment,
    hashtags: result.hashtags,
    splitInto: result.splitInto,
  }, { request, env });
}

// ---------------------------------------------------------------------------
// Own posts / delete
// ---------------------------------------------------------------------------
export async function handleMyPosts(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const rows = await db
    .prepare(
      `SELECT * FROM posts WHERE userId = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 100`
    )
    .bind(user.id)
    .all();
  return json(rows.results || [], { request, env });
}

export async function handleDeletePost(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const post = await db
    .prepare('SELECT userId FROM posts WHERE id = ?')
    .bind(params.id)
    .first();
  if (!post) return notFound('Post not found', ctx);
  if (post.userId !== user.id) return forbidden(null, ctx);

  await db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(params.id).run();
  return json({ success: true }, { request, env });
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------
export async function handleVote(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const body = await readJson(request);
  const value = parseInt(body.value, 10);
  if (![1, -1, 0].includes(value)) return badRequest('Invalid vote value', ctx);

  const post = await db
    .prepare('SELECT id, userId, category_id FROM posts WHERE id = ?')
    .bind(params.id)
    .first();
  if (!post) return notFound('Post not found', ctx);

  const existing = await db
    .prepare('SELECT id, value FROM likes WHERE postId = ? AND userId = ?')
    .bind(params.id, user.id)
    .first();
  const oldValue = existing ? existing.value : 0;

  if (existing) {
    if (value === 0) {
      await db.prepare('DELETE FROM likes WHERE id = ?').bind(existing.id).run();
    } else {
      await db
        .prepare('UPDATE likes SET value = ?, created = ? WHERE id = ?')
        .bind(value, Date.now(), existing.id)
        .run();
    }
  } else if (value !== 0) {
    await db
      .prepare('INSERT INTO likes (id, postId, userId, value, created) VALUES (?, ?, ?, ?, ?)')
      .bind(uuid(), params.id, user.id, value, Date.now())
      .run();
  }

  // Record the interest signal, undoing any previous vote's contribution first
  if (post.category_id !== -1) {
    const stmts = [];
    if (oldValue === 1) stmts.push(recordCategoryScoreStmt(db, user.id, post.category_id, -SIGNAL_WEIGHTS.like));
    if (oldValue === -1) stmts.push(recordCategoryScoreStmt(db, user.id, post.category_id, -SIGNAL_WEIGHTS.dislike));
    if (value === 1) stmts.push(recordCategoryScoreStmt(db, user.id, post.category_id, SIGNAL_WEIGHTS.like));
    if (value === -1) stmts.push(recordCategoryScoreStmt(db, user.id, post.category_id, SIGNAL_WEIGHTS.dislike));
    if (stmts.length) await db.batch(stmts);
  }

  // Notify the author of a new like
  if (post.userId !== user.id && value === 1 && oldValue !== 1) {
    await db
      .prepare(
        `INSERT INTO notifications (id, userId, type, payload, read, created)
         VALUES (?, ?, 'like', ?, 0, ?)`
      )
      .bind(uuid(), post.userId, JSON.stringify({
        fromUserId: user.id,
        postId: params.id,
        message: `${user.username || 'Someone'} liked your post.`,
      }), Date.now())
      .run();
  }

  if (value === -1) await updateSpamScore(db, params.id);

  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
         SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
       FROM likes WHERE postId = ?`
    )
    .bind(params.id)
    .first();

  return json({
    likes: counts?.likes || 0,
    dislikes: counts?.dislikes || 0,
    userVote: value,
  }, { request, env });
}

/**
 * Recompute a post's spam score. Three signals: a lopsided dislike ratio,
 * the author posting too fast, and duplicated text. Posts are never deleted,
 * only pushed down the feed.
 */
async function updateSpamScore(db, postId) {
  const post = await db
    .prepare('SELECT userId, text FROM posts WHERE id = ?')
    .bind(postId)
    .first();
  if (!post) return;

  let score = 0;

  const votes = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
         SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
       FROM likes WHERE postId = ?`
    )
    .bind(postId)
    .first();

  const likes = votes?.likes || 0;
  const dislikes = votes?.dislikes || 0;
  const total = likes + dislikes;
  if (total >= 3) {
    const ratio = dislikes / total;
    if (ratio > 0.7) score += 0.5;
    else if (ratio > 0.5) score += 0.25;
  }

  const recent = await db
    .prepare('SELECT COUNT(*) AS c FROM posts WHERE userId = ? AND timestamp > ? AND deleted = 0')
    .bind(post.userId, Date.now() - 10 * 60 * 1000)
    .first();
  if ((recent?.c || 0) > 10) score += 0.6;
  else if ((recent?.c || 0) > 5) score += 0.3;

  const dupes = await db
    .prepare('SELECT COUNT(*) AS c FROM posts WHERE text = ? AND id != ? AND deleted = 0')
    .bind(post.text, postId)
    .first();
  if ((dupes?.c || 0) > 0) score += 0.4;

  await db
    .prepare('UPDATE posts SET spam_score = ? WHERE id = ?')
    .bind(Math.min(0.95, score), postId)
    .run();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
export async function handleGetComments(ctx, params) {
  const { request, env, db } = ctx;
  const rows = await db
    .prepare(
      `SELECT c.id, c.text, c.timestamp, u.id AS userId, u.username, u.profilePic
         FROM comments c JOIN users u ON c.userId = u.id
        WHERE c.postId = ? ORDER BY c.timestamp ASC LIMIT 200`
    )
    .bind(params.id)
    .all();
  return json(rows.results || [], { request, env });
}

export async function handleAddComment(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const body = await readJson(request);
  const text = (body.text || '').trim();
  if (!text) return badRequest('Comment cannot be empty', ctx);
  if (text.length > MAX_COMMENT_LENGTH) {
    return badRequest(`Comment too long (max ${MAX_COMMENT_LENGTH})`, ctx);
  }

  const post = await db
    .prepare('SELECT userId, category_id FROM posts WHERE id = ?')
    .bind(params.id)
    .first();
  if (!post) return notFound('Post not found', ctx);

  const id = uuid();
  const timestamp = Date.now();
  const statements = [
    db
      .prepare('INSERT INTO comments (id, postId, userId, text, timestamp) VALUES (?, ?, ?, ?, ?)')
      .bind(id, params.id, user.id, text, timestamp),
  ];

  if (post.category_id !== -1) {
    statements.push(recordCategoryScoreStmt(db, user.id, post.category_id, SIGNAL_WEIGHTS.comment));
  }

  if (post.userId !== user.id) {
    statements.push(
      db
        .prepare(
          `INSERT INTO notifications (id, userId, type, payload, read, created)
           VALUES (?, ?, 'comment', ?, 0, ?)`
        )
        .bind(uuid(), post.userId, JSON.stringify({
          fromUserId: user.id,
          postId: params.id,
          commentId: id,
          message: `${user.username || 'Someone'} commented on your post.`,
        }), timestamp)
    );
  }

  await db.batch(statements);

  return json({
    id, text, timestamp,
    userId: user.id,
    username: user.username,
    profilePic: user.profilePic,
  }, { request, env });
}

// ---------------------------------------------------------------------------
// Engagement — view time and cursor hover, a deliberately weak signal
// ---------------------------------------------------------------------------
export async function handleTrackEngagement(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return json({ ok: true }, { request, env }); // guests are not tracked

  const body = await readJson(request);
  const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  if (events.length === 0) return json({ ok: true }, { request, env });

  const now = Date.now();
  const statements = [];
  const postIds = events.map((e) => e.postId).filter(Boolean);
  if (postIds.length === 0) return json({ ok: true }, { request, env });

  const placeholders = postIds.map(() => '?').join(',');
  const catRows = await db
    .prepare(`SELECT id, category_id FROM posts WHERE id IN (${placeholders})`)
    .bind(...postIds)
    .all();
  const catById = {};
  for (const row of catRows.results || []) catById[row.id] = row.category_id;

  for (const ev of events) {
    if (!ev.postId) continue;
    const viewMs = Math.min(Math.max(0, Number(ev.viewMs) || 0), 60000);
    const hoverMs = Math.min(Math.max(0, Number(ev.hoverMs) || 0), 60000);
    if (viewMs < 1000) continue;

    statements.push(
      db
        .prepare(
          'INSERT INTO engagement (id, postId, userId, viewMs, hoverMs, created) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(uuid(), ev.postId, user.id, viewMs, hoverMs, now)
    );

    const catId = catById[ev.postId];
    if (catId !== undefined && catId !== -1) {
      let delta = 0;
      if (viewMs >= 8000) delta += 0.02;
      else if (viewMs >= 3000) delta += 0.01;
      if (hoverMs >= 2000) delta += 0.01;
      if (delta > 0) statements.push(recordCategoryScoreStmt(db, user.id, catId, delta));
    }
  }

  if (statements.length) await db.batch(statements);
  return json({ ok: true }, { request, env });
}

// ---------------------------------------------------------------------------
// Post detail
// ---------------------------------------------------------------------------
export async function handlePostDetails(ctx, params) {
  const { request, env, db, user } = ctx;
  const post = await db
    .prepare(
      `SELECT p.*, u.username, u.profilePic
         FROM posts p JOIN users u ON p.userId = u.id
        WHERE p.id = ? AND p.deleted = 0`
    )
    .bind(params.id)
    .first();
  if (!post) return notFound('Post not found', ctx);

  const counts = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
         SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
       FROM likes WHERE postId = ?`
    )
    .bind(params.id)
    .first();

  let userVote = 0;
  if (user) {
    const vote = await db
      .prepare('SELECT value FROM likes WHERE postId = ? AND userId = ?')
      .bind(params.id, user.id)
      .first();
    userVote = vote?.value || 0;
  }

  return json({
    post: { ...post, likes: counts?.likes || 0, dislikes: counts?.dislikes || 0, userVote },
  }, { request, env });
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------
export async function handleGlobalFeed(ctx) {
  const { request, env, db, user } = ctx;
  const url = new URL(request.url);
  const limit = Math.min(50, parseInt(url.searchParams.get('limit')) || 20);
  const now = Date.now();

  // Guests get a simple recent feed — there is no profile to personalise with
  if (!user) {
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.profilePic
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.deleted = 0 AND p.spam_score < 0.9
          ORDER BY p.timestamp DESC LIMIT ?`
      )
      .bind(limit)
      .all();
    return json(await enrichPosts(db, rows.results || [], null), { request, env });
  }

  const interests = await getUserInterests(db, user.id);
  const [collaborative, userSentimentPref, relevantIds, analyser] = await Promise.all([
    getCollaborativeScores(db, user.id, interests),
    getUserSentimentPref(db, user.id),
    getRelevantAccountIds(db, user.id, interests, 20),
    loadAnalyser(db), // centroids only; vectors are not needed to rank
  ]);

  const categorySentiments = {};
  for (const catId of Object.keys(analyser.topology.centroids)) {
    categorySentiments[catId] = analyser.getCategorySentiment(Number(catId));
  }

  const profiler = new UserProfiler();
  const ranked = profiler.rankFromScores(interests, analyser.topology, {
    collaborative,
    categorySentiments,
    userSentimentPref,
    n: 60,
  });
  const categoryScores = Object.fromEntries(ranked);

  // Skip anything served in the last 5 minutes, so scrolling brings new posts
  // without starving the feed on a later visit
  const seenRows = await db
    .prepare('SELECT postId FROM feed_seen WHERE userId = ? AND seenAt > ?')
    .bind(user.id, now - 5 * 60 * 1000)
    .all();
  const seenIds = (seenRows.results || []).map((r) => r.postId);
  const seenClause = seenIds.length
    ? `AND p.id NOT IN (${seenIds.map(() => '?').join(',')})`
    : '';

  let candidates = [];

  if (relevantIds === null) {
    // Cold start: spread across categories so first interactions are informative
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.profilePic
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId != ? AND p.deleted = 0 AND p.spam_score < 0.9
            AND p.category_id != -1 ${seenClause}
          ORDER BY p.timestamp DESC LIMIT 200`
      )
      .bind(user.id, ...seenIds)
      .all();

    const perCategory = new Set();
    const spread = [];
    const rest = [];
    for (const p of rows.results || []) {
      if (!perCategory.has(p.category_id)) {
        perCategory.add(p.category_id);
        spread.push(p);
      } else {
        rest.push(p);
      }
    }
    candidates = [...spread, ...rest];
  } else if (relevantIds.length > 0) {
    const ph = relevantIds.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.profilePic
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId IN (${ph}) AND p.userId != ?
            AND p.deleted = 0 AND p.spam_score < 0.9 ${seenClause}
          ORDER BY p.timestamp DESC LIMIT 200`
      )
      .bind(...relevantIds, user.id, ...seenIds)
      .all();
    candidates = rows.results || [];
  }

  // Never return an empty feed: fall back to anything recent
  if (candidates.length < limit) {
    const have = new Set(candidates.map((p) => p.id));
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.profilePic
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId != ? AND p.deleted = 0 AND p.spam_score < 0.9 ${seenClause}
          ORDER BY p.timestamp DESC LIMIT 200`
      )
      .bind(user.id, ...seenIds)
      .all();
    for (const p of rows.results || []) {
      if (!have.has(p.id)) {
        candidates.push(p);
        have.add(p.id);
      }
    }
  }

  // Average engagement per post, as a mild popularity nudge
  const engagementMap = {};
  if (candidates.length > 0) {
    const ids = candidates.map((p) => p.id);
    const ph = ids.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT postId, AVG(viewMs) AS avgView, AVG(hoverMs) AS avgHover, COUNT(*) AS n
           FROM engagement WHERE postId IN (${ph})
          GROUP BY postId HAVING n >= 2`
      )
      .bind(...ids)
      .all();
    for (const row of rows.results || []) {
      engagementMap[row.postId] = Math.min(
        0.1,
        (row.avgView / 10000) * 0.1 + (row.avgHover / 5000) * 0.03
      );
    }
  }

  // Relevance dominates; recency is only a tiebreaker
  const scored = candidates.map((p) => {
    const catScore = categoryScores[p.category_id] ?? 0;
    const spamFactor = 1 - (p.spam_score || 0);
    const ageHours = (now - p.timestamp) / 3_600_000;
    let recency;
    if (ageHours < 1) recency = 0.15;
    else if (ageHours < 6) recency = 0.10;
    else if (ageHours < 24) recency = 0.06;
    else if (ageHours < 72) recency = 0.03;
    else recency = 0.01;

    const relevance = Math.max(0.01, catScore) * spamFactor + (engagementMap[p.id] || 0);
    return { ...p, _score: relevance * 0.8 + recency * 0.2 };
  });

  scored.sort((a, b) => b._score - a._score);

  // Roughly 10% of slots explore categories adjacent to the user's interests
  const exploreSlots = Math.max(1, Math.floor(limit * 0.1));
  const mainSlots = limit - exploreSlots;

  const perUser = {};
  const chosen = [];
  let lastUserId = null;

  // Max two posts per author, and not back to back
  for (const p of scored) {
    if (chosen.length >= mainSlots) break;
    const count = perUser[p.userId] || 0;
    if (count >= 2 || p.userId === lastUserId) continue;
    perUser[p.userId] = count + 1;
    lastUserId = p.userId;
    chosen.push(p);
  }

  // Relax the adjacency rule rather than return a short feed
  if (chosen.length < mainSlots) {
    const have = new Set(chosen.map((p) => p.id));
    for (const p of scored) {
      if (chosen.length >= mainSlots) break;
      if (have.has(p.id)) continue;
      const count = perUser[p.userId] || 0;
      if (count >= 3) continue;
      perUser[p.userId] = count + 1;
      chosen.push(p);
      have.add(p.id);
    }
  }

  // Exploration picks: similar categories the user has not engaged with yet
  const explore = [];
  const topCats = Object.entries(interests)
    .filter(([, s]) => s > 0.1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([c]) => Number(c));

  if (topCats.length > 0 && exploreSlots > 0) {
    const similar = new Set();
    for (const cat of topCats) {
      for (const [simCat] of analyser.topology.getSimilarCategories(cat, 3)) {
        if (!topCats.includes(simCat)) similar.add(simCat);
      }
    }
    if (similar.size > 0) {
      const simIds = [...similar];
      const ph = simIds.map(() => '?').join(',');
      const have = new Set(chosen.map((p) => p.id));
      const rows = await db
        .prepare(
          `SELECT p.*, u.username, u.profilePic
             FROM posts p JOIN users u ON p.userId = u.id
            WHERE p.category_id IN (${ph}) AND p.userId != ?
              AND p.deleted = 0 AND p.spam_score < 0.9 ${seenClause}
            ORDER BY p.timestamp DESC LIMIT 20`
        )
        .bind(...simIds, user.id, ...seenIds)
        .all();
      for (const p of rows.results || []) {
        if (explore.length >= exploreSlots) break;
        if (have.has(p.id)) continue;
        explore.push({ ...p, _explore: true });
      }
    }
  }

  // Weave exploration posts in every 8th slot
  const finalPosts = [];
  let ei = 0;
  for (let i = 0; i < chosen.length; i++) {
    finalPosts.push(chosen[i]);
    if ((i + 1) % 8 === 0 && ei < explore.length) finalPosts.push(explore[ei++]);
  }
  while (ei < explore.length) finalPosts.push(explore[ei++]);

  // Remember what was served
  if (finalPosts.length > 0) {
    await db.batch(
      finalPosts.map((p) =>
        db
          .prepare(
            `INSERT INTO feed_seen (userId, postId, seenAt) VALUES (?, ?, ?)
             ON CONFLICT(userId, postId) DO UPDATE SET seenAt = excluded.seenAt`
          )
          .bind(user.id, p.id, now)
      )
    );
  }

  return json(await enrichPosts(db, finalPosts, user.id), { request, env });
}

/** Attach like/dislike counts and the caller's own vote. */
async function enrichPosts(db, posts, userId) {
  if (posts.length === 0) return [];

  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');

  const countRows = await db
    .prepare(
      `SELECT postId,
              SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
              SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
         FROM likes WHERE postId IN (${ph}) GROUP BY postId`
    )
    .bind(...ids)
    .all();

  const counts = {};
  for (const row of countRows.results || []) {
    counts[row.postId] = { likes: row.likes || 0, dislikes: row.dislikes || 0 };
  }

  const votes = {};
  if (userId) {
    const voteRows = await db
      .prepare(`SELECT postId, value FROM likes WHERE postId IN (${ph}) AND userId = ?`)
      .bind(...ids, userId)
      .all();
    for (const row of voteRows.results || []) votes[row.postId] = row.value;
  }

  return posts.map((p) => {
    const { _score, ...rest } = p;
    return {
      ...rest,
      likes: counts[p.id]?.likes || 0,
      dislikes: counts[p.id]?.dislikes || 0,
      userVote: votes[p.id] || 0,
    };
  });
}
