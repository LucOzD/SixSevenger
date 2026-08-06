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
      .prepare('SELECT id, text, category_id, sentiment FROM posts WHERE userId = ? AND deleted = 0 ORDER BY timestamp DESC LIMIT 100')
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
