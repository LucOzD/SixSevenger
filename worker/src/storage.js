// storage.js
// Persists recommender state in D1, replacing recommender_state.pkl.
//
// A Worker keeps nothing between requests, so the model is loaded from the
// database at the start of each request and written back afterwards. Two load
// modes exist because of size: the per-category `vectors` blobs (used only for
// split detection) are far larger than the centroids, so the feed path skips
// them and only the category a new post lands in has its vectors fetched.

import { PostAnalyser } from './recommender.js';
import {
  countTokens, selectPhrases, phraseToToken, PHRASE_MIN_COUNT,
} from './phrases.js';

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isMissingTable(err) {
  return /no such table/i.test(err?.message || '');
}

/**
 * Run a query, tolerating the table not existing yet.
 *
 * Phrase detection added new tables after the first deploy. Without this, a
 * database that has not had the latest schema applied throws "no such table"
 * from loadAnalyser, which took down BOTH posting and the feed while login kept
 * working — a confusing failure for an optional feature. The warning names the
 * fix rather than failing silently.
 */
async function optionalQuery(db, sql, label) {
  try {
    return await db.prepare(sql).all();
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn(
        `Schema out of date: ${label} unavailable (${err.message}). ` +
        `Run: npx wrangler d1 execute sixsevenger --file=./schema.sql --remote`
      );
      return { results: [] };
    }
    throw err;
  }
}

/**
 * Load the model. Omits per-category vectors unless asked, since they are only
 * needed when checking whether a category should split.
 */
export async function loadAnalyser(db, { withVectors = false } = {}) {
  const [catRows, metaRows, phraseRows] = await Promise.all([
    db.prepare(
      withVectors
        ? 'SELECT id, centroid, n_posts, word_counts, category_words, sentiment, sentiment_count, vectors FROM categories'
        : 'SELECT id, centroid, n_posts, word_counts, category_words, sentiment, sentiment_count FROM categories'
    ).all(),
    db.prepare('SELECT key, value FROM model_meta').all(),
    // Optional: phrase detection tables may not exist on an older schema
    optionalQuery(db, 'SELECT phrase FROM phrases', 'phrase detection'),
  ]);

  const state = {
    topology: { centroids: {}, nPosts: {} },
    categoryWords: {},
    wordCounts: {},
    categorySentiment: {},
    sentimentCounts: {},
    categoryVectors: {},
    nextId: 0,
    postCount: 0,
    phrases: new Set((phraseRows.results || []).map((r) => r.phrase)),
  };

  for (const row of catRows.results || []) {
    const id = row.id;
    state.topology.centroids[id] = parseJson(row.centroid, {});
    state.topology.nPosts[id] = row.n_posts || 0;
    state.wordCounts[id] = parseJson(row.word_counts, {});
    state.categoryWords[id] = parseJson(row.category_words, []);
    state.categorySentiment[id] = row.sentiment ?? 0;
    state.sentimentCounts[id] = row.sentiment_count || 0;
    if (withVectors) state.categoryVectors[id] = parseJson(row.vectors, []);
  }

  const meta = {};
  for (const row of metaRows.results || []) meta[row.key] = row.value;
  state.nextId = Number(meta.nextId ?? 0);
  state.postCount = Number(meta.postCount ?? 0);
  state.totalTokens = Number(meta.totalTokens ?? 0);

  const analyser = new PostAnalyser({}, state);
  analyser.totalTokens = state.totalTokens;
  return analyser;
}

/** Fetch just one category's tracked vectors, for a split check. */
export async function loadCategoryVectors(db, catId) {
  const row = await db
    .prepare('SELECT vectors FROM categories WHERE id = ?')
    .bind(catId)
    .first();
  return parseJson(row?.vectors, []);
}

/**
 * Write back only the categories the analyser marked dirty, plus the scalars.
 * Batched into a single D1 round trip.
 */
export async function saveAnalyser(db, analyser) {
  const statements = [];

  for (const catId of analyser.dirty) {
    statements.push(
      db
        .prepare(
          `INSERT INTO categories
             (id, centroid, n_posts, word_counts, category_words, sentiment, sentiment_count, vectors)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             centroid = excluded.centroid,
             n_posts = excluded.n_posts,
             word_counts = excluded.word_counts,
             category_words = excluded.category_words,
             sentiment = excluded.sentiment,
             sentiment_count = excluded.sentiment_count,
             vectors = excluded.vectors`
        )
        .bind(
          catId,
          JSON.stringify(analyser.topology.centroids[catId] || {}),
          analyser.topology.nPosts[catId] || 0,
          JSON.stringify(analyser.wordCounts[catId] || {}),
          JSON.stringify(analyser.categoryWords[catId] || []),
          analyser.categorySentiment[catId] ?? 0,
          analyser.sentimentCounts[catId] || 0,
          JSON.stringify(analyser.categoryVectors[catId] || [])
        )
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO model_meta (key, value) VALUES ('nextId', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(String(analyser.nextId)),
    db
      .prepare(
        `INSERT INTO model_meta (key, value) VALUES ('postCount', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(String(analyser.postCount)),
    db
      .prepare(
        `INSERT INTO model_meta (key, value) VALUES ('totalTokens', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(String(analyser.totalTokens ?? 0))
  );

  if (statements.length > 0) await db.batch(statements);
  analyser.dirty.clear();
}

// ---------------------------------------------------------------------------
// Phrases (collocation detection)
// ---------------------------------------------------------------------------

/** The current phrase set, used by the vectorizer to merge tokens. */
export async function loadPhrases(db) {
  const rows = await optionalQuery(db, 'SELECT phrase FROM phrases', 'phrase detection');
  return new Set((rows.results || []).map((r) => r.phrase));
}

/**
 * Fold one post's token and pair counts into the running totals.
 * Returns statements for the caller to batch alongside its other writes.
 */
export function tokenCountStatements(db, tokens) {
  const { unigrams, bigrams } = countTokens(tokens);
  const statements = [];

  for (const [token, count] of unigrams) {
    statements.push(
      db
        .prepare(
          `INSERT INTO token_counts (token, count) VALUES (?, ?)
           ON CONFLICT(token) DO UPDATE SET count = count + excluded.count`
        )
        .bind(token, count)
    );
  }

  for (const [bigram, count] of bigrams) {
    const spaceAt = bigram.indexOf(' ');
    statements.push(
      db
        .prepare(
          `INSERT INTO bigram_counts (bigram, left_token, right_token, count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(bigram) DO UPDATE SET count = count + excluded.count`
        )
        .bind(bigram, bigram.slice(0, spaceAt), bigram.slice(spaceAt + 1), count)
    );
  }

  return statements;
}

/**
 * Rescore candidate pairs and rewrite the phrase table.
 *
 * Deliberately not run on every post: it reads the top pairs and rewrites the
 * table, so it runs every PHRASE_REVIEW_EVERY posts instead.
 */
export async function promotePhrases(db, totalTokens) {
  const rows = await db
    .prepare(
      `SELECT b.bigram, b.count, l.count AS leftCount, r.count AS rightCount
         FROM bigram_counts b
         JOIN token_counts l ON l.token = b.left_token
         JOIN token_counts r ON r.token = b.right_token
        WHERE b.count >= ? AND b.left_token != b.right_token
        ORDER BY b.count DESC
        LIMIT 1000`
    )
    .bind(PHRASE_MIN_COUNT)
    .all();

  const selected = selectPhrases(rows.results || [], totalTokens);
  const now = Date.now();

  // Replace wholesale, so a pair that no longer qualifies is dropped
  const statements = [db.prepare('DELETE FROM phrases')];
  for (const p of selected) {
    statements.push(
      db
        .prepare(
          `INSERT INTO phrases (phrase, token, score, cohesion, count, created)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(p.phrase, phraseToToken(p.phrase), p.score, p.cohesion, p.count, now)
    );
  }

  await db.batch(statements);
  return selected;
}

// ---------------------------------------------------------------------------
// Interest scores
// ---------------------------------------------------------------------------

/** Add a signed delta to a user's interest in a category. Scores may go negative. */
export function recordCategoryScoreStmt(db, userId, categoryId, delta) {
  return db
    .prepare(
      `INSERT INTO user_interests (userId, category_id, score)
       VALUES (?, ?, ?)
       ON CONFLICT(userId, category_id) DO UPDATE SET score = score + excluded.score`
    )
    .bind(userId, categoryId, delta);
}

export async function getUserInterests(db, userId) {
  const rows = await db
    .prepare('SELECT category_id, score FROM user_interests WHERE userId = ?')
    .bind(userId)
    .all();
  const scores = {};
  for (const row of rows.results || []) scores[row.category_id] = row.score;
  return scores;
}

/**
 * Average sentiment of posts the user has engaged with, per category. Lets the
 * ranker tell "likes positive Geometry Dash posts" from "likes negative ones".
 */
export async function getUserSentimentPref(db, userId) {
  const [liked, authored] = await Promise.all([
    db
      .prepare(
        `SELECT p.category_id AS cat, AVG(p.sentiment) AS avgSent
           FROM likes l JOIN posts p ON l.postId = p.id
          WHERE l.userId = ? AND l.value = 1 AND p.category_id != -1
          GROUP BY p.category_id`
      )
      .bind(userId)
      .all(),
    db
      .prepare(
        `SELECT category_id AS cat, AVG(sentiment) AS avgSent
           FROM posts
          WHERE userId = ? AND category_id != -1 AND deleted = 0
          GROUP BY category_id`
      )
      .bind(userId)
      .all(),
  ]);

  const pref = {};
  for (const row of liked.results || []) pref[row.cat] = row.avgSent;
  for (const row of authored.results || []) {
    pref[row.cat] = pref[row.cat] === undefined
      ? row.avgSent
      : (pref[row.cat] + row.avgSent) / 2;
  }
  return pref;
}

/** Category-level signal from users whose interests overlap with this one. */
export async function getCollaborativeScores(db, userId, interests) {
  const topCats = Object.entries(interests)
    .filter(([, score]) => score > 0.1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat]) => Number(cat));

  if (topCats.length === 0) return {};

  const placeholders = topCats.map(() => '?').join(',');
  const simUsers = await db
    .prepare(
      `SELECT userId FROM user_interests
        WHERE category_id IN (${placeholders}) AND userId != ? AND score > 0.1
        GROUP BY userId ORDER BY SUM(score) DESC LIMIT 10`
    )
    .bind(...topCats, userId)
    .all();

  const ids = (simUsers.results || []).map((r) => r.userId);
  if (ids.length === 0) return {};

  const userPlaceholders = ids.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT category_id AS cat, AVG(score) AS avgScore
         FROM user_interests
        WHERE userId IN (${userPlaceholders}) AND score > 0.05
        GROUP BY category_id`
    )
    .bind(...ids)
    .all();

  const out = {};
  for (const row of rows.results || []) out[row.cat] = row.avgScore;
  return out;
}

/**
 * Accounts worth pulling posts from. Returns null for a brand-new user with no
 * interests, which the feed treats as "show a wide spread for discovery".
 */
export async function getRelevantAccountIds(db, userId, interests, topN = 20) {
  const topCats = Object.entries(interests)
    .filter(([, score]) => score > 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cat]) => Number(cat));

  if (topCats.length === 0) return null; // cold start

  const placeholders = topCats.map(() => '?').join(',');
  const scores = {};

  // Authors who post in the categories this user cares about
  const posters = await db
    .prepare(
      `SELECT userId, COUNT(*) AS cnt FROM posts
        WHERE category_id IN (${placeholders}) AND userId != ? AND deleted = 0
        GROUP BY userId ORDER BY cnt DESC LIMIT 30`
    )
    .bind(...topCats, userId)
    .all();
  for (const row of posters.results || []) {
    scores[row.userId] = (scores[row.userId] || 0) + row.cnt * 2;
  }

  // Explicit follows are a strong signal
  const following = await db
    .prepare('SELECT followingId FROM follows WHERE followerId = ?')
    .bind(userId)
    .all();
  for (const row of following.results || []) {
    scores[row.followingId] = (scores[row.followingId] || 0) + 5;
  }

  const ranked = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, topN - 3))
    .map(([id]) => id);

  // A few random accounts so the feed cannot stagnate
  const random = await db
    .prepare('SELECT id FROM users WHERE guest = 0 AND id != ? ORDER BY RANDOM() LIMIT 3')
    .bind(userId)
    .all();

  return [...new Set([...ranked, ...(random.results || []).map((r) => r.id)])];
}
