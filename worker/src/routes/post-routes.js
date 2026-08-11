// post-routes.js — creating, reading, voting on and commenting on posts,
// plus the ranked feed and engagement tracking.

import { json, badRequest, unauthorized, forbidden, notFound, readJson, uuid } from '../http.js';
import {
  loadAnalyser, saveAnalyser, recordCategoryScoreStmt,
  getUserInterests, getUserSentimentPref, getCollaborativeScores,
  getRelevantAccountIds, tokenCountStatements, promotePhrases,
} from '../storage.js';
import {
  UserProfiler, SIGNAL_WEIGHTS, POST_INTEREST_WEIGHT, feedCandidateScore,
} from '../recommender.js';
import { extractHashtags } from '../vectorizer.js';
import { sentimentScore } from '../sentiment.js';
import {
  SPAM_HIDE_THRESHOLD, SPAM_QUARANTINE_THRESHOLD,
  assessPostingSpam, assessExistingSpam, spamRankMultiplier,
} from '../spam.js';

export const MAX_POST_LENGTH = 100;
export const MAX_COMMENT_LENGTH = 100;

const HASHTAG_INTEREST_WEIGHT = 0.05;

// How often to rescore collocations. Doing it on every post would mean an extra
// read of the top pairs plus a full rewrite of the phrase table each time.
const PHRASE_REVIEW_EVERY = 20;
const MAX_FEED_CANDIDATES = 80;
const RECENT_SEEN_MS = 5 * 60 * 1000;

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

  // Score the post before it can train categories. Repeated submissions inside
  // 30 seconds are treated as one idempotent request; floods and repeated
  // content are heavily penalised immediately rather than waiting for votes.
  const recentRows = await db
    .prepare(
      `SELECT id, text, timestamp, spam_score, category_id, sentiment
         FROM posts WHERE userId = ? AND deleted = 0 AND timestamp > ?
        ORDER BY timestamp DESC LIMIT 50`
    )
    .bind(user.id, timestamp - 24 * 60 * 60 * 1000)
    .all();
  const antiSpam = assessPostingSpam(text, recentRows.results || [], timestamp);

  if (antiSpam.retry) {
    const existing = antiSpam.retry;
    return json({
      success: true,
      duplicate: true,
      post: {
        ...existing,
        userId: user.id,
        username: user.username,
        avatar: user.avatar,
        deleted: 0,
        likes: 0,
        dislikes: 0,
        userVote: 0,
      },
      id: existing.id,
      timestamp: existing.timestamp,
      category_id: existing.category_id,
      sentiment: existing.sentiment,
      spam_score: existing.spam_score || 0,
    }, { request, env });
  }

  // Medium/high-confidence spam is stored for the author to inspect, but it is
  // quarantined before it can train categories, interests, or phrase counts.
  if (antiSpam.score >= SPAM_QUARANTINE_THRESHOLD) {
    const sentiment = sentimentScore(text);
    const hashtags = extractHashtags(text);
    await db
      .prepare(
        `INSERT INTO posts (id, userId, text, timestamp, deleted, category_id, spam_score, post_vector, sentiment)
         VALUES (?, ?, ?, ?, 0, -1, ?, '{}', ?)`
      )
      .bind(id, user.id, text, timestamp, antiSpam.score, sentiment)
      .run();

    const post = {
      id, userId: user.id, username: user.username, avatar: user.avatar,
      text, timestamp, deleted: 0, category_id: -1,
      spam_score: antiSpam.score, sentiment, likes: 0, dislikes: 0, userVote: 0,
    };
    return json({
      success: true,
      post,
      id,
      timestamp,
      category_id: -1,
      sentiment,
      hashtags,
      spam_score: antiSpam.score,
      spamReasons: antiSpam.reasons,
      quarantined: true,
      hidden: antiSpam.score >= SPAM_HIDE_THRESHOLD,
      splitInto: null,
      phrasesReviewed: null,
    }, { request, env });
  }

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
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
      )
      .bind(id, user.id, text, timestamp, result.categoryId, antiSpam.score,
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

  // Save the post itself first. Everything below is enrichment, and must not be
  // able to lose the user's post if it fails.
  await db.batch(statements);
  await saveAnalyser(db, analyser);

  // Phrase counting is deliberately a separate batch. It writes to tables added
  // after the first release, so on an un-migrated database these statements
  // throw — and if they shared a batch with the INSERT above, the post would be
  // lost rather than merely unanalysed.
  let newPhrases = null;
  try {
    analyser.totalTokens = (analyser.totalTokens || 0) + result.tokens.length;
    await db.batch(tokenCountStatements(db, result.tokens));

    // Periodically rescore which word pairs count as phrases
    if (analyser.postCount % PHRASE_REVIEW_EVERY === 0) {
      const selected = await promotePhrases(db, analyser.totalTokens);
      newPhrases = selected.map((p) => p.phrase);
    }
  } catch (err) {
    console.error('Phrase analysis skipped:', err?.message || err);
  }

  const createdPost = {
    id,
    userId: user.id,
    username: user.username,
    avatar: user.avatar,
    text,
    timestamp,
    deleted: 0,
    category_id: result.categoryId,
    spam_score: antiSpam.score,
    sentiment: result.sentiment,
    likes: 0,
    dislikes: 0,
    userVote: 0,
  };

  return json({
    success: true,
    post: createdPost,
    id,
    timestamp,
    category_id: result.categoryId,
    sentiment: result.sentiment,
    spam_score: antiSpam.score,
    spamReasons: antiSpam.reasons,
    hashtags: result.hashtags,
    splitInto: result.splitInto,
    phrasesReviewed: newPhrases, // null unless a review ran on this post
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

  if (oldValue !== value) await updateSpamScore(db, params.id);

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

/** Recompute behavior plus community evidence after every vote transition. */
async function updateSpamScore(db, postId) {
  const post = await db
    .prepare('SELECT userId, text, timestamp FROM posts WHERE id = ?')
    .bind(postId)
    .first();
  if (!post) return;

  const [votes, priorRows] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
           SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
         FROM likes WHERE postId = ?`
      )
      .bind(postId)
      .first(),
    db
      .prepare(
        `SELECT id, text, timestamp, spam_score FROM posts
          WHERE userId = ? AND id != ? AND deleted = 0
            AND timestamp > ? AND timestamp <= ?
          ORDER BY timestamp DESC LIMIT 50`
      )
      .bind(post.userId, postId, Number(post.timestamp) - 24 * 60 * 60 * 1000,
            Number(post.timestamp))
      .all(),
  ]);

  const assessment = assessExistingSpam(post, priorRows.results || [], votes || {});
  await db
    .prepare('UPDATE posts SET spam_score = ? WHERE id = ?')
    .bind(assessment.score, postId)
    .run();
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
export async function handleGetComments(ctx, params) {
  const { request, env, db } = ctx;
  const rows = await db
    .prepare(
      `SELECT c.id, c.text, c.timestamp, u.id AS userId, u.username, u.avatar
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
    success: true,
    comment: {
      id, text, timestamp,
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
    },
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
      `SELECT p.*, u.username, u.avatar
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
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.deleted = 0 AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
            AND p.category_id != -1
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

  const recentCutoff = now - RECENT_SEEN_MS;

  // Pin the author's latest just-created post once so a refresh confirms that
  // it was saved. NOT EXISTS avoids large dynamic NOT IN parameter lists.
  const ownPostToPin = await db
    .prepare(
      `SELECT p.*, u.username, u.avatar
         FROM posts p JOIN users u ON p.userId = u.id
        WHERE p.userId = ? AND p.deleted = 0
          AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
          AND p.timestamp > ?
          AND NOT EXISTS (
            SELECT 1 FROM feed_seen fs
             WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
          )
        ORDER BY p.timestamp DESC LIMIT 1`
    )
    .bind(user.id, now - 15 * 60 * 1000, user.id, recentCutoff)
    .first();
  if (ownPostToPin) ownPostToPin._ownRecent = true;

  let candidates = [];

  if (relevantIds === null) {
    // Cold start: spread across categories so first interactions are informative
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId != ? AND p.deleted = 0
            AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
            AND p.category_id != -1
            AND NOT EXISTS (
              SELECT 1 FROM feed_seen fs
               WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
            )
          ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_CANDIDATES}`
      )
      .bind(user.id, user.id, recentCutoff)
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
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId IN (${ph}) AND p.userId != ?
            AND p.deleted = 0 AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
            AND p.category_id != -1
            AND NOT EXISTS (
              SELECT 1 FROM feed_seen fs
               WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
            )
          ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_CANDIDATES}`
      )
      .bind(...relevantIds, user.id, user.id, recentCutoff)
      .all();
    candidates = rows.results || [];
  }

  // Fill relevant-account gaps with unseen posts from the whole network. This
  // query can advance beyond the newest posts because seen rows are excluded
  // in SQL rather than fetched into a capped in-memory list.
  const unseenPool = await db
    .prepare(
      `SELECT p.*, u.username, u.avatar
         FROM posts p JOIN users u ON p.userId = u.id
        WHERE p.userId != ? AND p.deleted = 0
          AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
          AND p.category_id != -1
          AND NOT EXISTS (
            SELECT 1 FROM feed_seen fs
             WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
          )
        ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_CANDIDATES}`
    )
    .bind(user.id, user.id, recentCutoff)
    .all();

  const candidateIds = new Set(candidates.map((p) => p.id));
  for (const p of unseenPool.results || []) {
    if (candidates.length >= MAX_FEED_CANDIDATES) break;
    if (candidateIds.has(p.id)) continue;
    candidates.push({ ...p, _fallback: true });
    candidateIds.add(p.id);
  }

  // Once all unseen content is exhausted, deliberately recycle eligible posts
  // so a finite database still supports infinite scrolling.
  if (candidates.length < MAX_FEED_CANDIDATES) {
    const repeatPool = await db
      .prepare(
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId != ? AND p.deleted = 0
            AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
            AND p.category_id != -1
          ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_CANDIDATES}`
      )
      .bind(user.id)
      .all();
    for (const p of repeatPool.results || []) {
      if (candidates.length >= MAX_FEED_CANDIDATES) break;
      if (candidateIds.has(p.id)) continue;
      candidates.push({ ...p, _fallback: true, _recentlySeen: true });
      candidateIds.add(p.id);
    }
  }

  // Last-resort liveness for tiny/private datasets: if this account owns every
  // eligible post, recycle its own history rather than render an empty page.
  if (candidates.length === 0) {
    const emergencyRows = await db
      .prepare(
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.deleted = 0 AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
            AND p.category_id != -1
          ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_CANDIDATES}`
      )
      .all();
    candidates = (emergencyRows.results || []).map((p) => ({
      ...p,
      _fallback: true,
      _recentlySeen: true,
    }));
  }

  // Passive dwell remains a mild nudge. Explicit likes and comments are
  // queried separately and receive substantially more weight below.
  const engagementMap = {};
  const interactionMap = {};
  if (candidates.length > 0) {
    const ids = candidates.map((p) => p.id);
    const ph = ids.map(() => '?').join(',');
    const [engagementRows, interactionRows] = await Promise.all([
      db
        .prepare(
          `SELECT postId, AVG(viewMs) AS avgView, AVG(hoverMs) AS avgHover, COUNT(*) AS n
             FROM engagement WHERE postId IN (${ph})
            GROUP BY postId HAVING n >= 2`
        )
        .bind(...ids)
        .all(),
      db
        .prepare(
          `SELECT p.id AS postId,
                  (SELECT COUNT(*) FROM likes l WHERE l.postId = p.id AND l.value = 1) AS likes,
                  (SELECT COUNT(*) FROM likes l WHERE l.postId = p.id AND l.value = -1) AS dislikes,
                  (SELECT COUNT(*) FROM comments c WHERE c.postId = p.id) AS comments
             FROM posts p WHERE p.id IN (${ph})`
        )
        .bind(...ids)
        .all(),
    ]);

    for (const row of engagementRows.results || []) {
      engagementMap[row.postId] = Math.min(
        0.1,
        (row.avgView / 10000) * 0.1 + (row.avgHover / 5000) * 0.03
      );
    }
    for (const row of interactionRows.results || []) {
      interactionMap[row.postId] = {
        likes: row.likes || 0,
        dislikes: row.dislikes || 0,
        comments: row.comments || 0,
      };
    }
  }

  // Relevance dominates; recency is only a tiebreaker. Spam multiplies the
  // complete result, including recency, likes, comments and dwell engagement.
  const scored = candidates.map((p) => {
    const catScore = categoryScores[p.category_id] ?? 0;
    const ageHours = (now - p.timestamp) / 3_600_000;
    let recency;
    if (ageHours < 1) recency = 0.15;
    else if (ageHours < 6) recency = 0.10;
    else if (ageHours < 24) recency = 0.06;
    else if (ageHours < 72) recency = 0.03;
    else recency = 0.01;

    const relevance = Math.max(0.01, catScore) + (engagementMap[p.id] || 0);
    const baseScore = feedCandidateScore(relevance, recency, interactionMap[p.id]);
    const spamPenalty = spamRankMultiplier(p.spam_score);
    const fallbackFactor = p._fallback ? 0.85 : 1;
    const repeatFactor = p._recentlySeen ? 0.08 : 1;
    return { ...p, _score: baseScore * spamPenalty * fallbackFactor * repeatFactor };
  });

  // Repeat backfill is strongly penalised but can still outrank spam. Keeping
  // one score order prevents a fresh spam post bypassing the spam multiplier.
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
          `SELECT p.*, u.username, u.avatar
             FROM posts p JOIN users u ON p.userId = u.id
            WHERE p.category_id IN (${ph}) AND p.userId != ?
              AND p.deleted = 0 AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
              AND NOT EXISTS (
                SELECT 1 FROM feed_seen fs
                 WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
              )
            ORDER BY p.timestamp DESC LIMIT 20`
        )
        .bind(...simIds, user.id, user.id, recentCutoff)
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
  while (ei < explore.length && finalPosts.length < limit) {
    finalPosts.push(explore[ei++]);
  }

  // Exploration can be unavailable, and strict author diversity can leave
  // holes. Fill those holes from the ranked pool in increasingly relaxed
  // passes, while never duplicating a post within one response.
  const finalIds = new Set(finalPosts.map((p) => p.id));
  const finalPerUser = {};
  for (const p of finalPosts) {
    finalPerUser[p.userId] = (finalPerUser[p.userId] || 0) + 1;
  }

  const topUp = (maxPerUser, avoidAdjacent) => {
    for (const p of scored) {
      if (finalPosts.length >= limit) break;
      if (finalIds.has(p.id)) continue;
      if ((finalPerUser[p.userId] || 0) >= maxPerUser) continue;
      if (avoidAdjacent && finalPosts.at(-1)?.userId === p.userId) continue;
      finalPosts.push(p);
      finalIds.add(p.id);
      finalPerUser[p.userId] = (finalPerUser[p.userId] || 0) + 1;
    }
  };

  topUp(3, true);
  topUp(3, false);
  topUp(Number.POSITIVE_INFINITY, false);

  if (ownPostToPin) {
    const duplicateIndex = finalPosts.findIndex((p) => p.id === ownPostToPin.id);
    if (duplicateIndex !== -1) finalPosts.splice(duplicateIndex, 1);
    finalPosts.unshift(ownPostToPin);
  }

  const servedPosts = finalPosts.slice(0, limit);

  // Remember what was served
  if (servedPosts.length > 0) {
    await db.batch(
      servedPosts.map((p) =>
        db
          .prepare(
            `INSERT INTO feed_seen (userId, postId, seenAt) VALUES (?, ?, ?)
             ON CONFLICT(userId, postId) DO UPDATE SET seenAt = excluded.seenAt`
          )
          .bind(user.id, p.id, now)
      )
    );
  }

  return json(await enrichPosts(db, servedPosts, user.id), { request, env });
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
    const { _score, _fallback, _recentlySeen, _explore, _ownRecent, ...rest } = p;
    return {
      ...rest,
      likes: counts[p.id]?.likes || 0,
      dislikes: counts[p.id]?.dislikes || 0,
      userVote: votes[p.id] || 0,
    };
  });
}
