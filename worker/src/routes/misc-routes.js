// misc-routes.js — hashtag lookup and the admin views.

import { json, forbidden, notFound } from '../http.js';
import { loadAnalyser } from '../storage.js';

// ---------------------------------------------------------------------------
// Hashtags
// ---------------------------------------------------------------------------
export async function handleHashtag(ctx, params) {
  const { request, env, db, user } = ctx;
  const tag = params.tag.toLowerCase().replace(/^#/, '');

  const info = await db.prepare('SELECT * FROM hashtags WHERE tag = ?').bind(tag).first();

  const postRows = await db
    .prepare(
      `SELECT p.*, u.username, u.avatar
         FROM post_hashtags ph
         JOIN posts p ON ph.postId = p.id
         JOIN users u ON p.userId = u.id
        WHERE ph.tag = ? AND p.deleted = 0
        ORDER BY p.timestamp DESC LIMIT 50`
    )
    .bind(tag)
    .all();
  const posts = postRows.results || [];

  // Attach counts and the viewer's own votes
  let enriched = posts;
  if (posts.length > 0) {
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
    if (user) {
      const voteRows = await db
        .prepare(`SELECT postId, value FROM likes WHERE postId IN (${ph}) AND userId = ?`)
        .bind(...ids, user.id)
        .all();
      for (const row of voteRows.results || []) votes[row.postId] = row.value;
    }

    enriched = posts.map((p) => ({
      ...p,
      likes: counts[p.id]?.likes || 0,
      dislikes: counts[p.id]?.dislikes || 0,
      userVote: votes[p.id] || 0,
    }));
  }

  // Similar hashtags: same category first, then categories the topology says
  // are related
  const similar = [];
  const catId = info?.category_id ?? -1;

  if (catId !== -1) {
    const sameCat = await db
      .prepare(
        'SELECT tag, post_count FROM hashtags WHERE category_id = ? AND tag != ? ORDER BY post_count DESC LIMIT 10'
      )
      .bind(catId, tag)
      .all();
    for (const row of sameCat.results || []) {
      similar.push({ tag: row.tag, post_count: row.post_count, reason: 'same category' });
    }

    const analyser = await loadAnalyser(db);
    const related = analyser.topology.getSimilarCategories(catId, 3).map(([c]) => c);
    if (related.length > 0) {
      const ph = related.map(() => '?').join(',');
      const rows = await db
        .prepare(
          `SELECT tag, post_count FROM hashtags
            WHERE category_id IN (${ph}) AND tag != ?
            ORDER BY post_count DESC LIMIT 10`
        )
        .bind(...related, tag)
        .all();
      for (const row of rows.results || []) {
        similar.push({ tag: row.tag, post_count: row.post_count, reason: 'similar topic' });
      }
    }
  }

  const seen = new Set();
  const similarHashtags = similar
    .filter((h) => (seen.has(h.tag) ? false : (seen.add(h.tag), true)))
    .slice(0, 15);

  return json({
    tag,
    category_id: catId,
    post_count: info?.post_count ?? 0,
    posts: enriched,
    similar_hashtags: similarHashtags,
  }, { request, env });
}

// ---------------------------------------------------------------------------
// Admin. Gated on the reserved "admin" username, matching the Express version.
// ---------------------------------------------------------------------------
function requireAdmin(ctx) {
  const { user } = ctx;
  if (!user || user.username !== 'admin') return forbidden('Admin access required', ctx);
  return null;
}

export async function handleAdminUsers(ctx) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;

  const { request, env, db } = ctx;
  const rows = await db
    .prepare('SELECT id, username, avatar, guest, created FROM users WHERE guest = 0 ORDER BY username')
    .all();
  return json(rows.results || [], { request, env });
}

export async function handleAdminCategories(ctx) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;

  const { request, env, db } = ctx;
  const analyser = await loadAnalyser(db);
  return json(analyser.categoriesOverview(), { request, env });
}

/** Learned collocations, strongest first, for inspecting what the model found. */
export async function handleAdminPhrases(ctx) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;

  const { request, env, db } = ctx;
  const rows = await db
    .prepare(
      `SELECT phrase, token, score, cohesion, count FROM phrases
        ORDER BY count DESC LIMIT 200`
    )
    .all();

  const totals = await db
    .prepare("SELECT value FROM model_meta WHERE key = 'totalTokens'")
    .first();

  return json({
    total_tokens: Number(totals?.value ?? 0),
    phrase_count: (rows.results || []).length,
    phrases: (rows.results || []).map((r) => ({
      phrase: r.phrase,
      token: r.token,
      occurrences: r.count,
      score: Math.round(r.score * 10) / 10,
      cohesion: Math.round(r.cohesion * 100) / 100,
    })),
  }, { request, env });
}

export async function handleAdminUserInterests(ctx, params) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;

  const { request, env, db } = ctx;
  const target = await db
    .prepare('SELECT id, username FROM users WHERE id = ?')
    .bind(params.id)
    .first();
  if (!target) return notFound('User not found', ctx);

  const [interestRows, postRows] = await Promise.all([
    db
      .prepare('SELECT category_id, score FROM user_interests WHERE userId = ? ORDER BY score DESC')
      .bind(params.id)
      .all(),
    db
      .prepare('SELECT id, text, timestamp, category_id, sentiment FROM posts WHERE userId = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 100')
      .bind(params.id)
      .all(),
  ]);

  const analyser = await loadAnalyser(db);
  const interests = (interestRows.results || []).map((row) => ({
    category_id: row.category_id,
    score: row.score,
    words: analyser.categoryWords[row.category_id] || [],
    description: analyser.describe(row.category_id),
    category_sentiment: analyser.getCategorySentiment(row.category_id),
  }));

  return json({
    user: target,
    interests,
    posts: postRows.results || [],
  }, { request, env });
}


/** Soft-delete one post as moderation while retaining its abuse history. */
export async function handleAdminDeletePost(ctx, params) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;

  const { request, env, db } = ctx;
  const post = await db.prepare('SELECT id FROM posts WHERE id = ?').bind(params.id).first();
  if (!post) return notFound('Post not found', ctx);

  await db.batch([
    db
      .prepare('UPDATE posts SET deleted = 1, category_id = -1, spam_score = 0.99 WHERE id = ?')
      .bind(params.id),
    db.prepare('DELETE FROM post_hashtags WHERE postId = ?').bind(params.id),
    db.prepare('DELETE FROM feed_seen WHERE postId = ?').bind(params.id),
    db
      .prepare(
        `DELETE FROM notifications
          WHERE CASE WHEN json_valid(payload)
                     THEN json_extract(payload, '$.postId') END = ?`
      )
      .bind(params.id),
    db.prepare(
      `UPDATE hashtags SET post_count = (
         SELECT COUNT(*) FROM post_hashtags ph
         JOIN posts p ON p.id = ph.postId
          WHERE ph.tag = hashtags.tag AND p.deleted = 0
       )`
    ),
    db.prepare('DELETE FROM hashtags WHERE post_count <= 0'),
  ]);

  return json({ success: true, postId: params.id }, { request, env });
}

/** Permanently remove an account and every directly related row. */
export async function handleAdminDeleteUser(ctx, params) {
  const denied = requireAdmin(ctx);
  if (denied) return denied;

  const { request, env, db, user } = ctx;
  const target = await db
    .prepare(
      `SELECT u.id, u.username,
              (SELECT COUNT(*) FROM posts p WHERE p.userId = u.id) AS postCount
         FROM users u WHERE u.id = ?`
    )
    .bind(params.id)
    .first();
  if (!target) return notFound('User not found', ctx);
  if (target.id === user.id || target.username === 'admin') {
    return forbidden('The admin account cannot be deleted', ctx);
  }

  const id = target.id;
  await db.batch([
    db
      .prepare(
        `DELETE FROM notifications
          WHERE userId = ?
             OR CASE WHEN json_valid(payload)
                     THEN json_extract(payload, '$.fromUserId') END = ?
             OR CASE WHEN json_valid(payload)
                     THEN json_extract(payload, '$.postId') END IN
                (SELECT id FROM posts WHERE userId = ?)
             OR CASE WHEN json_valid(payload)
                     THEN json_extract(payload, '$.commentId') END IN
                (SELECT c.id FROM comments c
                  WHERE c.userId = ?
                     OR c.postId IN (SELECT id FROM posts WHERE userId = ?))`
      )
      .bind(id, id, id, id, id),
    db
      .prepare(
        `DELETE FROM comment_likes
          WHERE userId = ?
             OR commentId IN (
               SELECT c.id FROM comments c
                WHERE c.userId = ?
                   OR c.postId IN (SELECT id FROM posts WHERE userId = ?)
             )`
      )
      .bind(id, id, id),
    db
      .prepare(
        `DELETE FROM likes
          WHERE userId = ? OR postId IN (SELECT id FROM posts WHERE userId = ?)`
      )
      .bind(id, id),
    db
      .prepare(
        `DELETE FROM engagement
          WHERE userId = ? OR postId IN (SELECT id FROM posts WHERE userId = ?)`
      )
      .bind(id, id),
    db
      .prepare(
        `DELETE FROM feed_seen
          WHERE userId = ? OR postId IN (SELECT id FROM posts WHERE userId = ?)`
      )
      .bind(id, id),
    db
      .prepare('DELETE FROM post_hashtags WHERE postId IN (SELECT id FROM posts WHERE userId = ?)')
      .bind(id),
    db
      .prepare(
        `DELETE FROM comments
          WHERE userId = ? OR postId IN (SELECT id FROM posts WHERE userId = ?)`
      )
      .bind(id, id),
    db
      .prepare('DELETE FROM follow_requests WHERE fromUserId = ? OR toUserId = ?')
      .bind(id, id),
    db
      .prepare('DELETE FROM follows WHERE followerId = ? OR followingId = ?')
      .bind(id, id),
    db.prepare('DELETE FROM user_interests WHERE userId = ?').bind(id),
    db.prepare('DELETE FROM sessions WHERE userId = ?').bind(id),
    db.prepare('DELETE FROM posting_mutes WHERE userId = ?').bind(id),
    db.prepare('DELETE FROM posting_violations WHERE userId = ?').bind(id),
    db.prepare('DELETE FROM posts WHERE userId = ?').bind(id),
    db.prepare('DELETE FROM users WHERE id = ?').bind(id),
    db.prepare(
      `UPDATE hashtags SET post_count = (
         SELECT COUNT(*) FROM post_hashtags ph
         JOIN posts p ON p.id = ph.postId
          WHERE ph.tag = hashtags.tag AND p.deleted = 0
       )`
    ),
    db.prepare('DELETE FROM hashtags WHERE post_count <= 0'),
  ]);

  return json({
    success: true,
    userId: id,
    username: target.username,
    deletedPosts: Number(target.postCount) || 0,
  }, { request, env });
}
