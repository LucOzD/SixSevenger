// seed_interests.js — one-time: build user_interests from existing
// categorised posts (authorship) plus any existing likes/dislikes/comments.
const { initDb } = require('./db');

const POST_WEIGHT = 0.15;
const WEIGHTS = { 1: 0.20, '-1': -0.25 };

(async () => {
  const db = await initDb();

  // Reset interests so we can rebuild cleanly
  db.prepare('DELETE FROM user_interests').run();

  // 1. Authorship: each categorised post you wrote is a positive signal
  const posts = db.prepare(`
    SELECT userId, category_id FROM posts
    WHERE deleted = 0 AND category_id != -1
  `).all();

  for (const p of posts) {
    db.prepare(`
      INSERT INTO user_interests (userId, category_id, score)
      VALUES (?, ?, ?)
      ON CONFLICT(userId, category_id) DO UPDATE SET score = score + excluded.score
    `).run(p.userId, p.category_id, POST_WEIGHT);
  }

  // 2. Likes / dislikes on categorised posts
  const votes = db.prepare(`
    SELECT l.userId AS voter, p.category_id AS cat, l.value AS value
    FROM likes l JOIN posts p ON l.postId = p.id
    WHERE p.category_id != -1
  `).all();

  for (const v of votes) {
    const delta = WEIGHTS[String(v.value)] || 0;
    if (!delta) continue;
    db.prepare(`
      INSERT INTO user_interests (userId, category_id, score)
      VALUES (?, ?, ?)
      ON CONFLICT(userId, category_id) DO UPDATE SET score = score + excluded.score
    `).run(v.voter, v.cat, delta);
  }

  // 3. Comments
  const comments = db.prepare(`
    SELECT c.userId AS commenter, p.category_id AS cat
    FROM comments c JOIN posts p ON c.postId = p.id
    WHERE p.category_id != -1
  `).all();

  for (const c of comments) {
    db.prepare(`
      INSERT INTO user_interests (userId, category_id, score)
      VALUES (?, ?, ?)
      ON CONFLICT(userId, category_id) DO UPDATE SET score = score + excluded.score
    `).run(c.commenter, c.cat, 0.12);
  }

  const summary = db.prepare(`
    SELECT ui.userId, u.username, ui.category_id, ROUND(ui.score,3) AS score
    FROM user_interests ui JOIN users u ON ui.userId = u.id
    ORDER BY u.username, ui.score DESC
  `).all();

  console.log('Rebuilt user_interests:', summary.length, 'rows');
  let currentUser = null;
  summary.forEach(r => {
    if (r.username !== currentUser) { console.log(`\n${r.username}:`); currentUser = r.username; }
    console.log(`  cat ${r.category_id}: ${r.score}`);
  });
})();
