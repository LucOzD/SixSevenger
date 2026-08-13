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
import { selectPersonalizedAd } from './ad-routes.js';
import {
  SPAM_HIDE_THRESHOLD, SPAM_QUARANTINE_THRESHOLD, POST_MUTE_MS,
  POST_VIOLATION_MEMORY_MS, IDENTICAL_POST_WINDOW_MS, assessPostingSpam,
  assessExistingSpam, filterFeedSpam, findPostingRetry, isFeedEligiblePost,
  isPostingRateLimited, matchingIdenticalPosts, postingLimitViolation,
  spamRankMultiplier,
} from '../spam.js';

export const MAX_POST_LENGTH = 100;
export const MAX_COMMENT_LENGTH = 100;

const HASHTAG_INTEREST_WEIGHT = 0.05;

// How often to rescore collocations. Doing it on every post would mean an extra
// read of the top pairs plus a full rewrite of the phrase table each time.
const PHRASE_REVIEW_EVERY = 20;
const MAX_FEED_CANDIDATES = 80;
const MAX_POPULAR_CANDIDATES = 20;
const MAX_FEED_SCAN_CANDIDATES = MAX_FEED_CANDIDATES * 3;

// Reject known spam before LIMIT is applied, so a legacy flood cannot occupy
// the whole candidate window and hide clean posts below it. The nested window
// mirrors the five-identical-posts-in-five-hours moderation rule.
const FEED_ELIGIBILITY_SQL = `
  p.deleted = 0
  AND p.spam_score >= 0
  AND p.spam_score < ${SPAM_QUARANTINE_THRESHOLD}
  AND p.category_id != -1
  AND NOT EXISTS (
    SELECT 1 FROM posts anchor
     WHERE anchor.userId = p.userId
       AND anchor.deleted = 0
       AND LOWER(TRIM(anchor.text)) = LOWER(TRIM(p.text))
       AND anchor.timestamp BETWEEN p.timestamp - ${IDENTICAL_POST_WINDOW_MS} AND p.timestamp
       AND (
         SELECT COUNT(*) FROM posts repeated
          WHERE repeated.userId = p.userId
            AND repeated.deleted = 0
            AND LOWER(TRIM(repeated.text)) = LOWER(TRIM(p.text))
            AND repeated.timestamp BETWEEN anchor.timestamp
                                       AND anchor.timestamp + ${IDENTICAL_POST_WINDOW_MS}
       ) >= 5
  )`;

// Popularity candidate windows must account for spam before LIMIT. Otherwise a
// bot can manufacture enough reactions to occupy the entire SQL window even
// though the final (1 - spam)^4 multiplier would rank it below clean content.
const POPULARITY_JOINS_SQL = `
  LEFT JOIN (
    SELECT postId,
           SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END) AS likes,
           SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END) AS dislikes
      FROM likes GROUP BY postId
  ) community_votes ON community_votes.postId = p.id
  LEFT JOIN (
    SELECT postId, COUNT(*) AS comments FROM comments GROUP BY postId
  ) community_comments ON community_comments.postId = p.id`;

// This is a SQL-safe approximation of the bounded interaction component used
// by scoreFeedPost. Exact tanh scoring and recency are still applied in JS.
const SPAM_AWARE_POPULARITY_ORDER_SQL = `
  MAX(0.0001,
      0.006 + 0.35 * MIN(1.0, MAX(-1.0,
        (COALESCE(community_votes.likes, 0) +
         COALESCE(community_comments.comments, 0) * 2 -
         COALESCE(community_votes.dislikes, 0) * 1.5) / 5.0
      ))) *
  (1.0 - p.spam_score) * (1.0 - p.spam_score) *
  (1.0 - p.spam_score) * (1.0 - p.spam_score)`;

// ---------------------------------------------------------------------------
// Create a post
// ---------------------------------------------------------------------------
async function createProgressivePostingMute(db, userId, reason, baseMuteMs, now) {
  const prior = await db
    .prepare(
      'SELECT COUNT(*) AS c FROM posting_violations WHERE userId = ? AND created > ?'
    )
    .bind(userId, now - POST_VIOLATION_MEMORY_MS)
    .first();
  const multiplier = Math.pow(2, Math.min(4, Number(prior?.c) || 0));
  const muteMs = Math.min(24 * 60 * 60 * 1000, baseMuteMs * multiplier);
  const mutedUntil = now + muteMs;

  await db.batch([
    db
      .prepare('INSERT INTO posting_violations (id, userId, reason, created) VALUES (?, ?, ?, ?)')
      .bind(uuid(), userId, reason, now),
    db
      .prepare(
        `INSERT INTO posting_mutes (userId, muted_until, created) VALUES (?, ?, ?)
         ON CONFLICT(userId) DO UPDATE SET
           muted_until = excluded.muted_until,
           created = excluded.created`
      )
      .bind(userId, mutedUntil, now),
  ]);

  return { muteMs, mutedUntil };
}

function postingLimitResponse(ctx, { code, mutedUntil, retryAfterMs, error }) {
  const { request, env } = ctx;
  return json({ error, code, mutedUntil, retryAfterMs }, {
    status: 429,
    request,
    env,
    extraHeaders: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) },
  });
}

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

  // Read actual inserted rows, including quarantined and deleted rows. Those
  // rows still count toward abuse limits; otherwise soft-deleting would let an
  // account evade both controls.
  const recentRows = await db
    .prepare(
      `SELECT id, text, timestamp, deleted, spam_score, category_id, sentiment
         FROM posts WHERE userId = ? AND timestamp > ?
        ORDER BY timestamp DESC`
    )
    .bind(user.id, timestamp - 24 * 60 * 60 * 1000)
    .all();
  const recentPosts = recentRows.results || [];

  // Browser retries inside 30 seconds represent the same request. Resolve this
  // before checking the mute/rate limit so a retry never adds a strike or
  // extends an active mute.
  const retry = findPostingRetry(text, recentPosts, timestamp);
  if (retry) {
    const autoDeleted = Number(retry.deleted) === 1;
    return json({
      success: true,
      duplicate: true,
      autoDeleted,
      deletedCount: autoDeleted ? 0 : undefined,
      deletedPostIds: autoDeleted ? [retry.id] : undefined,
      moderationMessage: autoDeleted
        ? 'This repeated post was already removed by the duplicate-post rule.'
        : undefined,
      post: {
        ...retry,
        userId: user.id,
        username: user.username,
        avatar: user.avatar,
        deleted: autoDeleted ? 1 : 0,
        likes: 0,
        dislikes: 0,
        userVote: 0,
      },
      id: retry.id,
      timestamp: retry.timestamp,
      category_id: retry.category_id,
      sentiment: retry.sentiment,
      spam_score: retry.spam_score || 0,
    }, { request, env });
  }

  const mute = await db
    .prepare('SELECT muted_until FROM posting_mutes WHERE userId = ?')
    .bind(user.id)
    .first();
  if (Number(mute?.muted_until) > timestamp) {
    const retryAfterMs = Number(mute.muted_until) - timestamp;
    return postingLimitResponse(ctx, {
      error: 'Posting is muted temporarily because this account posted too quickly.',
      code: 'POSTING_MUTED',
      mutedUntil: Number(mute.muted_until),
      retryAfterMs,
    });
  }

  // This edge-local limit is keyed by Cloudflare's verified client address and
  // catches account rotation. D1 account limits below remain authoritative.
  if (env.POST_NETWORK_RATE_LIMITER) {
    const networkKey = request.headers.get('CF-Connecting-IP') || `user:${user.id}`;
    const edgeResult = await env.POST_NETWORK_RATE_LIMITER.limit({ key: networkKey });
    if (!edgeResult.success) {
      return postingLimitResponse(ctx, {
        error: 'Too many posts are coming from this network. Try again shortly.',
        code: 'POST_NETWORK_RATE_LIMIT',
        mutedUntil: timestamp + 60_000,
        retryAfterMs: 60_000,
      });
    }
  }

  if (isPostingRateLimited(recentPosts, timestamp)) {
    const progressive = await createProgressivePostingMute(
      db, user.id, 'one_minute', POST_MUTE_MS, timestamp
    );
    return postingLimitResponse(ctx, {
      error: 'Posting muted after five posts in one minute.',
      code: 'POSTING_MUTED',
      mutedUntil: progressive.mutedUntil,
      retryAfterMs: progressive.muteMs,
    });
  }

  const longLimit = postingLimitViolation(recentPosts, user.created, timestamp);
  if (longLimit) {
    const progressive = await createProgressivePostingMute(
      db, user.id, longLimit.code, longLimit.muteMs, timestamp
    );
    return postingLimitResponse(ctx, {
      error: longLimit.probation
        ? 'New accounts have a lower posting limit while trust is established.'
        : 'This account reached a longer-term posting limit.',
      code: longLimit.code,
      mutedUntil: progressive.mutedUntil,
      retryAfterMs: progressive.muteMs,
    });
  }

  // On the fifth normalized-identical post in five hours, persist this attempt
  // as a tombstone and remove every still-visible match as one set. The new row
  // deliberately bypasses the analyser, interests, hashtags and phrase model.
  const identical = matchingIdenticalPosts(
    text, recentPosts, timestamp, IDENTICAL_POST_WINDOW_MS
  );
  if (identical.length >= 4) {
    const activeMatches = identical.filter((post) => Number(post.deleted) !== 1);
    const statements = [
      db
        .prepare(
          `INSERT INTO posts (id, userId, text, timestamp, deleted, category_id, spam_score, post_vector, sentiment)
           VALUES (?, ?, ?, ?, 1, -1, 0.99, '{}', ?)`
        )
        .bind(id, user.id, text, timestamp, sentimentScore(text)),
    ];
    if (activeMatches.length > 0) {
      const placeholders = activeMatches.map(() => '?').join(',');
      statements.push(
        db
          .prepare(
            `UPDATE posts SET deleted = 1, category_id = -1 WHERE id IN (${placeholders})`
          )
          .bind(...activeMatches.map((post) => post.id))
      );
    }
    await db.batch(statements);

    const deletedPostIds = [...activeMatches.map((post) => post.id), id];
    const post = {
      id,
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      text,
      timestamp,
      deleted: 1,
      category_id: -1,
      spam_score: 0.99,
      sentiment: sentimentScore(text),
      likes: 0,
      dislikes: 0,
      userVote: 0,
    };
    return json({
      success: true,
      autoDeleted: true,
      deletedCount: deletedPostIds.length,
      deletedPostIds,
      moderationMessage: 'Five identical posts within five hours were automatically removed.',
      post,
      id,
      timestamp,
      category_id: -1,
      spam_score: 0.99,
      hashtags: [],
      splitInto: null,
      phrasesReviewed: null,
    }, { request, env });
  }

  // Score the post before it can train categories. Medium/high-confidence spam
  // is quarantined rather than being allowed to affect recommendations.
  const antiSpam = assessPostingSpam(text, recentPosts, timestamp);

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

export async function handleMyComments(ctx) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const rows = await db
    .prepare(
      `SELECT c.id, c.postId, c.text, c.timestamp,
              p.text AS postText, p.userId AS postAuthorId,
              pu.username AS postAuthorUsername, pu.avatar AS postAuthorAvatar,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.commentId = c.id) AS likes,
              EXISTS(
                SELECT 1 FROM comment_likes mine
                 WHERE mine.commentId = c.id AND mine.userId = ?
              ) AS userLiked
         FROM comments c
         JOIN posts p ON p.id = c.postId AND p.deleted = 0
         LEFT JOIN users pu ON pu.id = p.userId
        WHERE c.userId = ?
        ORDER BY c.timestamp DESC LIMIT 100`
    )
    .bind(user.id, user.id)
    .all();

  return json((rows.results || []).map((comment) => ({
    ...comment,
    likes: Number(comment.likes) || 0,
    userLiked: Boolean(comment.userLiked),
  })), { request, env });
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
    .prepare('SELECT id, userId, category_id FROM posts WHERE id = ? AND deleted = 0')
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
        `SELECT id, text, timestamp, deleted, spam_score FROM posts
          WHERE userId = ? AND id != ?
            AND timestamp > ? AND timestamp <= ?
          ORDER BY timestamp DESC`
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
  const { request, env, db, user } = ctx;
  const rows = await db
    .prepare(
      `SELECT c.id, c.text, c.timestamp, u.id AS userId, u.username, u.avatar,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.commentId = c.id) AS likes,
              EXISTS(
                SELECT 1 FROM comment_likes mine
                 WHERE mine.commentId = c.id AND mine.userId = ?
              ) AS userLiked
         FROM comments c
         JOIN users u ON c.userId = u.id
         JOIN posts p ON p.id = c.postId AND p.deleted = 0
        WHERE c.postId = ? ORDER BY c.timestamp ASC LIMIT 200`
    )
    .bind(user?.id || '', params.id)
    .all();
  return json((rows.results || []).map((comment) => ({
    ...comment,
    likes: Number(comment.likes) || 0,
    userLiked: Boolean(comment.userLiked),
  })), { request, env });
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
    .prepare('SELECT userId, category_id FROM posts WHERE id = ? AND deleted = 0')
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
      likes: 0,
      userLiked: false,
    },
  }, { request, env });
}

export async function handleCommentLike(ctx, params) {
  const { request, env, db, user } = ctx;
  if (!user) return unauthorized(null, ctx);

  const body = await readJson(request);
  const value = parseInt(body.value, 10);
  if (![0, 1].includes(value)) return badRequest('Invalid comment like value', ctx);

  const comment = await db
    .prepare(
      `SELECT c.id FROM comments c
        JOIN posts p ON p.id = c.postId
       WHERE c.id = ? AND p.deleted = 0`
    )
    .bind(params.id)
    .first();
  if (!comment) return notFound('Comment not found', ctx);

  if (value === 1) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO comment_likes (commentId, userId, created)
         VALUES (?, ?, ?)`
      )
      .bind(params.id, user.id, Date.now())
      .run();
  } else {
    await db
      .prepare('DELETE FROM comment_likes WHERE commentId = ? AND userId = ?')
      .bind(params.id, user.id)
      .run();
  }

  const state = await db
    .prepare(
      `SELECT COUNT(*) AS likes,
              MAX(CASE WHEN userId = ? THEN 1 ELSE 0 END) AS userLiked
         FROM comment_likes WHERE commentId = ?`
    )
    .bind(user.id, params.id)
    .first();

  return json({
    likes: Number(state?.likes) || 0,
    userLiked: Boolean(state?.userLiked),
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
function feedRecencyValue(timestamp, now) {
  const ageHours = Math.max(0, now - Number(timestamp)) / 3_600_000;
  if (ageHours < 1) return 0.15;
  if (ageHours < 6) return 0.10;
  if (ageHours < 24) return 0.06;
  if (ageHours < 72) return 0.03;
  return 0.01;
}

async function loadFeedInteractions(db, posts) {
  if (posts.length === 0) return {};
  const interactions = {};

  // Keep each IN clause within the same conservative D1 binding budget used
  // by personalized candidate selection while allowing a longer guest cursor.
  for (let start = 0; start < posts.length; start += MAX_FEED_CANDIDATES) {
    const ids = posts.slice(start, start + MAX_FEED_CANDIDATES).map((post) => post.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db
      .prepare(
        `SELECT p.id AS postId,
                (SELECT COUNT(*) FROM likes l WHERE l.postId = p.id AND l.value = 1) AS likes,
                (SELECT COUNT(*) FROM likes l WHERE l.postId = p.id AND l.value = -1) AS dislikes,
                (SELECT COUNT(*) FROM comments c WHERE c.postId = p.id) AS comments
           FROM posts p WHERE p.id IN (${placeholders})`
      )
      .bind(...ids)
      .all();
    for (const row of rows.results || []) {
      interactions[row.postId] = {
        likes: Number(row.likes) || 0,
        dislikes: Number(row.dislikes) || 0,
        comments: Number(row.comments) || 0,
      };
    }
  }

  return interactions;
}

function scoreFeedPost(post, now, relevance, interactions, extraFactor = 1) {
  const base = feedCandidateScore(
    relevance,
    feedRecencyValue(post.timestamp, now),
    interactions
  );
  // Spam is applied last, so manufactured likes/comments cannot rescue a bot.
  return base * spamRankMultiplier(post.spam_score) * extraFactor;
}

export async function handleGlobalFeed(ctx) {
  const { request, env, db, user } = ctx;
  const url = new URL(request.url);
  const limit = Math.min(50, parseInt(url.searchParams.get('limit')) || 20);
  const guestOffset = Math.max(
    0,
    Math.min(10_000_000, parseInt(url.searchParams.get('offset'), 10) || 0)
  );
  const guestWindowStart = Math.floor(guestOffset / MAX_FEED_SCAN_CANDIDATES) *
    MAX_FEED_SCAN_CANDIDATES;
  const guestWindowOffset = guestOffset - guestWindowStart;
  const now = Date.now();

  // Guests traverse successive popularity-ranked windows. The extra SQL row
  // tells the browser whether another window exists, so a complete cycle can
  // restart without either stopping or getting trapped on the first few posts.
  if (!user) {
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
           ${POPULARITY_JOINS_SQL}
          WHERE ${FEED_ELIGIBILITY_SQL}
          ORDER BY ${SPAM_AWARE_POPULARITY_ORDER_SQL} DESC, p.timestamp DESC
          LIMIT ${MAX_FEED_SCAN_CANDIDATES + 1} OFFSET ${guestWindowStart}`
      )
      .all();
    const rawRows = rows.results || [];
    const hasMoreWindows = rawRows.length > MAX_FEED_SCAN_CANDIDATES;
    const candidates = filterFeedSpam(rawRows.slice(0, MAX_FEED_SCAN_CANDIDATES));
    const interactions = await loadFeedInteractions(db, candidates);
    const rankedWindow = candidates
      .map((post) => ({
        ...post,
        _score: scoreFeedPost(post, now, 0.01, interactions[post.id] || {}),
      }))
      .sort((left, right) => right._score - left._score);
    const pagePosts = rankedWindow.slice(guestWindowOffset, guestWindowOffset + limit);

    // An ad occupies the final slot of a full page rather than increasing the
    // page size. The displaced organic post remains first on the next page.
    const ad = pagePosts.length >= limit
      ? await selectPersonalizedAd(db, null, {}, null, now)
      : null;
    const postLimit = ad ? Math.max(0, limit - 1) : limit;
    const servedPosts = pagePosts.slice(0, postLimit);
    const exhaustedWindow = guestWindowOffset + servedPosts.length >= rankedWindow.length;
    const nextWindowOffset = guestWindowStart + MAX_FEED_SCAN_CANDIDATES;
    const nextOffset = exhaustedWindow
      ? nextWindowOffset
      : guestWindowStart + guestWindowOffset + servedPosts.length;
    const cycleEnd = exhaustedWindow && !hasMoreWindows;

    const enrichedPosts = await enrichPosts(db, servedPosts, null);
    if (ad) enrichedPosts.push(ad);
    return json(enrichedPosts, {
      request,
      env,
      extraHeaders: {
        'Cache-Control': 'no-store',
        'X-Feed-Next-Offset': String(cycleEnd ? 0 : nextOffset),
        'X-Feed-Cycle-End': cycleEnd ? '1' : '0',
      },
    });
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

  // A served post stays seen for this account. New posts continue to enter the
  // feed, but exhausting the current pool no longer unlocks an endless cycle.
  const recentCutoff = 0;

  // Pin the author's latest just-created post once so a refresh confirms that
  // it was saved. NOT EXISTS avoids large dynamic NOT IN parameter lists.
  let ownPostToPin = await db
    .prepare(
      `SELECT p.*, u.username, u.avatar
         FROM posts p JOIN users u ON p.userId = u.id
        WHERE p.userId = ? AND ${FEED_ELIGIBILITY_SQL}
          AND p.timestamp > ?
          AND NOT EXISTS (
            SELECT 1 FROM feed_seen fs
             WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
          )
        ORDER BY p.timestamp DESC LIMIT 1`
    )
    .bind(user.id, now - 15 * 60 * 1000, user.id, recentCutoff)
    .first();
  if (ownPostToPin && !isFeedEligiblePost(ownPostToPin)) ownPostToPin = null;
  if (ownPostToPin) ownPostToPin._ownRecent = true;

  let candidates = [];
  let recycledFeedCycle = false;

  if (relevantIds === null) {
    // Cold start: spread across categories so first interactions are informative
    const rows = await db
      .prepare(
        `SELECT p.*, u.username, u.avatar
           FROM posts p JOIN users u ON p.userId = u.id
          WHERE p.userId != ? AND ${FEED_ELIGIBILITY_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM feed_seen fs
               WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
            )
          ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_SCAN_CANDIDATES}`
      )
      .bind(user.id, user.id, recentCutoff)
      .all();

    const perCategory = new Set();
    const spread = [];
    const rest = [];
    for (const p of filterFeedSpam(rows.results || []).slice(0, MAX_FEED_CANDIDATES)) {
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
            AND ${FEED_ELIGIBILITY_SQL}
            AND NOT EXISTS (
              SELECT 1 FROM feed_seen fs
               WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
            )
          ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_SCAN_CANDIDATES}`
      )
      .bind(...relevantIds, user.id, user.id, recentCutoff)
      .all();
    candidates = filterFeedSpam(rows.results || []).slice(0, MAX_FEED_CANDIDATES);
  }

  // Reserve part of the candidate set for proven community favorites. This
  // lets older liked/commented posts compete with the newest SQL window.
  candidates = candidates.slice(0, MAX_FEED_CANDIDATES - MAX_POPULAR_CANDIDATES);
  const candidateIds = new Set(candidates.map((post) => post.id));
  const popularRows = await db
    .prepare(
      `SELECT p.*, u.username, u.avatar
         FROM posts p JOIN users u ON p.userId = u.id
         ${POPULARITY_JOINS_SQL}
        WHERE p.userId != ? AND ${FEED_ELIGIBILITY_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM feed_seen fs
             WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
          )
        ORDER BY ${SPAM_AWARE_POPULARITY_ORDER_SQL} DESC, p.timestamp DESC
        LIMIT ${MAX_FEED_SCAN_CANDIDATES}`
    )
    .bind(user.id, user.id, recentCutoff)
    .all();
  let popularAdded = 0;
  for (const post of filterFeedSpam(popularRows.results || [])) {
    if (popularAdded >= MAX_POPULAR_CANDIDATES) break;
    if (candidateIds.has(post.id)) continue;
    candidates.push({ ...post, _popular: true });
    candidateIds.add(post.id);
    popularAdded++;
  }

  // Fill relevant-account gaps with unseen posts from the whole network. This
  // query can advance beyond the newest posts because seen rows are excluded
  // in SQL rather than fetched into a capped in-memory list.
  const unseenPool = await db
    .prepare(
      `SELECT p.*, u.username, u.avatar
         FROM posts p JOIN users u ON p.userId = u.id
        WHERE p.userId != ? AND ${FEED_ELIGIBILITY_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM feed_seen fs
             WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
          )
        ORDER BY p.timestamp DESC LIMIT ${MAX_FEED_SCAN_CANDIDATES}`
    )
    .bind(user.id, user.id, recentCutoff)
    .all();

  for (const p of filterFeedSpam(unseenPool.results || [])) {
    if (candidates.length >= MAX_FEED_CANDIDATES) break;
    if (candidateIds.has(p.id)) continue;
    candidates.push({ ...p, _fallback: true });
    candidateIds.add(p.id);
  }

  // After every unseen post has been traversed, begin a new cycle from the
  // least-recently-served posts. Updating seenAt for each served page rotates
  // the whole pool instead of repeating the same high-ranked handful forever.
  if (candidates.length === 0) {
    const recycledRows = await db
      .prepare(
        `SELECT p.*, u.username, u.avatar
           FROM posts p
           JOIN users u ON p.userId = u.id
           LEFT JOIN feed_seen fs ON fs.userId = ? AND fs.postId = p.id
          WHERE p.userId != ? AND ${FEED_ELIGIBILITY_SQL}
          ORDER BY COALESCE(fs.seenAt, 0) ASC, p.timestamp DESC
          LIMIT ${MAX_FEED_SCAN_CANDIDATES}`
      )
      .bind(user.id, user.id)
      .all();
    candidates = filterFeedSpam(recycledRows.results || [])
      .slice(0, MAX_FEED_CANDIDATES)
      .map((post) => ({ ...post, _fallback: true }));
    recycledFeedCycle = candidates.length > 0;
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
    const relevance = Math.max(0.01, catScore) + (engagementMap[p.id] || 0);
    const fallbackFactor = p._fallback ? 0.85 : 1;
    return {
      ...p,
      _score: scoreFeedPost(
        p,
        now,
        relevance,
        interactionMap[p.id] || {},
        fallbackFactor
      ),
    };
  });

  // Keep one score order so a fresh spam post cannot bypass the spam
  // multiplier while candidate sources are combined.
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
              AND ${FEED_ELIGIBILITY_SQL}
              AND NOT EXISTS (
                SELECT 1 FROM feed_seen fs
                 WHERE fs.userId = ? AND fs.postId = p.id AND fs.seenAt > ?
              )
            ORDER BY p.timestamp DESC LIMIT 20`
        )
        .bind(...simIds, user.id, user.id, recentCutoff)
        .all();
      const explorationCandidates = filterFeedSpam(rows.results || [])
        .filter((post) => !have.has(post.id));
      const explorationInteractions = await loadFeedInteractions(db, explorationCandidates);
      const rankedExploration = explorationCandidates
        .map((post) => ({
          ...post,
          _explore: true,
          _score: scoreFeedPost(
            post,
            now,
            Math.max(0.01, categoryScores[post.category_id] ?? 0.01),
            explorationInteractions[post.id] || {},
            0.9
          ),
        }))
        .sort((left, right) => right._score - left._score)
        .slice(0, exploreSlots);
      explore.push(...rankedExploration);
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

  if (ownPostToPin) {
    const duplicateIndex = finalPosts.findIndex((p) => p.id === ownPostToPin.id);
    if (duplicateIndex !== -1) finalPosts.splice(duplicateIndex, 1);
    finalPosts.unshift(ownPostToPin);
  }

  // Fail closed even if a future candidate path forgets the SQL guard. An ad
  // replaces the final organic slot only when a complete page is available;
  // short final pages contain only their remaining posts.
  const eligiblePosts = filterFeedSpam(finalPosts);
  const ad = eligiblePosts.length >= limit
    ? await selectPersonalizedAd(db, user.id, interests, analyser.topology, now)
    : null;
  const postLimit = ad ? Math.max(0, limit - 1) : limit;
  const servedPosts = eligiblePosts.slice(0, postLimit);

  // Remember only the organic posts that were actually served. A post displaced
  // by an ad remains unseen and becomes eligible for the next page.
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

  const enrichedPosts = await enrichPosts(db, servedPosts, user.id);
  if (ad) enrichedPosts.push(ad);
  return json(enrichedPosts, {
    request,
    env,
    extraHeaders: {
      'Cache-Control': 'no-store',
      ...(recycledFeedCycle ? { 'X-Feed-Cycle-Reset': '1' } : {}),
    },
  });
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
    const { _score, _fallback, _explore, _ownRecent, _popular, ...rest } = p;
    return {
      ...rest,
      likes: counts[p.id]?.likes || 0,
      dislikes: counts[p.id]?.dislikes || 0,
      userVote: votes[p.id] || 0,
    };
  });
}
