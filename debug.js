const { initDb, getDb } = require('./db');

(async () => {
  await initDb();
  const db = getDb();
  
  console.log('Testing database queries...\n');
  
  // Get a real user ID from the database
  const user = db.prepare('SELECT id FROM users LIMIT 1').get();
  const userId = user?.id || 'unknown';
  console.log('Using user ID:', userId, '\n');
  
  // Test the complex global-feed query
  const limit = 20;
  const pool = limit * 3;
  const offset = 0;
  
  console.log('Executing complex query with:');
  console.log(`  pool=${pool}, offset=${offset}, userId=${userId}\n`);
  
  const posts = db.prepare(`
    SELECT
      posts.*,
      users.username,
      users.profilePic,
      COALESCE(ui.score, 0) * (1 - posts.spam_score) AS interest_score
    FROM posts
    JOIN users ON posts.userId = users.id
    LEFT JOIN user_interests ui
      ON ui.userId = ?
      AND ui.category_id = posts.category_id
    WHERE posts.userId != ? AND posts.deleted = 0
      AND posts.spam_score < 0.9
    ORDER BY
      interest_score DESC,
      posts.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, pool, offset);
  
  console.log('Posts returned:', posts.length);
  if (posts.length > 0) {
    console.log('First post:', posts[0]);
  }
  
  process.exit(0);
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
