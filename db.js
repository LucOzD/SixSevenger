const initSqlJs = require('sql.js');
const fs = require('fs-extra');
const path = require('path');

let db = null;

// Database lives in DATA_DIR so it can sit on a persistent volume when
// deployed. Defaults to the project folder for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const dbPath = path.join(DATA_DIR, 'database.db');

class DbWrapper {
  constructor(sqlDb) {
    this.sqlDb = sqlDb;
  }

  prepare(sql) {
    return {
      run: (...params) => {
        try {
          this.sqlDb.run(sql, params);
          this.save();
        } catch (err) {
          // Ignore errors like column already exists
        }
      },
      get: (...params) => {
        const stmt = this.sqlDb.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          return stmt.getAsObject();
        }
        return undefined;
      },
      all: (...params) => {
        const stmt = this.sqlDb.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      }
    };
  }

  save() {
    const data = this.sqlDb.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

// Add any missing columns to an existing table.
// definitions = { columnName: 'TYPE DEFAULT ...' }
function migrateColumns(db, table, definitions) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  for (const [name, type] of Object.entries(definitions)) {
    if (!existing.includes(name)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
      console.log(`[migration] Added column ${table}.${name}`);
    }
  }
}

// Initialize database
async function initDb() {
  const SQL = await initSqlJs();
  
  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DbWrapper(sqlDb);

  // Create tables
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      passwordHash TEXT,
      bio TEXT,
      profilePic TEXT,
      guest INTEGER,
      created INTEGER
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      userId TEXT,
      text TEXT,
      timestamp INTEGER,
      deleted INTEGER DEFAULT 0,
      category_id INTEGER DEFAULT -1,
      spam_score REAL DEFAULT 0,
      post_vector TEXT,
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `).run();

  // Migrations: add columns that may be missing on databases created
  // before these fields existed. Errors (column already exists) are
  // safely ignored by the wrapper's run().
  migrateColumns(db, 'posts', {
    deleted:     'INTEGER DEFAULT 0',
    category_id: 'INTEGER DEFAULT -1',
    spam_score:  'REAL DEFAULT 0',
    post_vector: 'TEXT',
    sentiment:   'REAL DEFAULT 0',
  });

  db.prepare(`
    CREATE TABLE IF NOT EXISTS likes (
      id TEXT PRIMARY KEY,
      postId TEXT,
      userId TEXT,
      value INTEGER,
      created INTEGER,
      UNIQUE(postId, userId),
      FOREIGN KEY(postId) REFERENCES posts(id),
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      postId TEXT,
      userId TEXT,
      text TEXT,
      timestamp INTEGER,
      FOREIGN KEY(postId) REFERENCES posts(id),
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS follow_requests (
      id TEXT PRIMARY KEY,
      fromUserId TEXT,
      toUserId TEXT,
      created INTEGER,
      UNIQUE(fromUserId, toUserId),
      FOREIGN KEY(fromUserId) REFERENCES users(id),
      FOREIGN KEY(toUserId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS follows (
      id TEXT PRIMARY KEY,
      followerId TEXT,
      followingId TEXT,
      created INTEGER,
      UNIQUE(followerId, followingId),
      FOREIGN KEY(followerId) REFERENCES users(id),
      FOREIGN KEY(followingId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      userId TEXT,
      type TEXT,
      payload TEXT,
      read INTEGER DEFAULT 0,
      created INTEGER,
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_interests (
      userId TEXT,
      category_id INTEGER,
      score REAL DEFAULT 0,
      PRIMARY KEY (userId, category_id),
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS engagement (
      id TEXT PRIMARY KEY,
      postId TEXT,
      userId TEXT,
      viewMs INTEGER DEFAULT 0,
      hoverMs INTEGER DEFAULT 0,
      created INTEGER,
      FOREIGN KEY(postId) REFERENCES posts(id),
      FOREIGN KEY(userId) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS feed_seen (
      userId TEXT,
      postId TEXT,
      seenAt INTEGER,
      PRIMARY KEY(userId, postId),
      FOREIGN KEY(userId) REFERENCES users(id),
      FOREIGN KEY(postId) REFERENCES posts(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS hashtags (
      tag TEXT PRIMARY KEY,
      category_id INTEGER DEFAULT -1,
      post_count INTEGER DEFAULT 0
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS post_hashtags (
      postId TEXT,
      tag TEXT,
      PRIMARY KEY(postId, tag),
      FOREIGN KEY(postId) REFERENCES posts(id)
    )
  `).run();

  // Older posts and posts saved while the Python recommender was unavailable
  // may contain hashtags without index rows. Backfill those associations from
  // source text, then rebuild each hashtag's count/category idempotently.
  const hashtagPosts = db.prepare(`
    SELECT id, text FROM posts
    WHERE deleted = 0 AND text LIKE '%#%'
  `).all();
  const indexed = new Set(
    db.prepare('SELECT postId, tag FROM post_hashtags').all()
      .map((row) => `${row.postId}\u0000${row.tag}`)
  );
  for (const post of hashtagPosts) {
    const tags = new Set(
      [...String(post.text || '').matchAll(/#([a-zA-Z0-9_]+)/g)]
        .map((match) => match[1].toLowerCase())
    );
    for (const tag of tags) {
      const key = `${post.id}\u0000${tag}`;
      if (indexed.has(key)) continue;
      db.prepare(`
        INSERT INTO post_hashtags (postId, tag) VALUES (?, ?)
        ON CONFLICT(postId, tag) DO NOTHING
      `).run(post.id, tag);
      indexed.add(key);
    }
  }

  // Clear stale aggregate counts first, then rebuild them from live posts.
  db.prepare('UPDATE hashtags SET post_count = 0').run();

  const hashtagStats = db.prepare(`
    SELECT ph.tag, COUNT(*) AS post_count,
           COALESCE((
             SELECT p2.category_id
             FROM post_hashtags ph2
             JOIN posts p2 ON p2.id = ph2.postId
             WHERE ph2.tag = ph.tag AND p2.deleted = 0 AND p2.category_id != -1
             ORDER BY p2.timestamp DESC LIMIT 1
           ), -1) AS category_id
    FROM post_hashtags ph
    JOIN posts p ON p.id = ph.postId
    WHERE p.deleted = 0
    GROUP BY ph.tag
  `).all();
  for (const stat of hashtagStats) {
    db.prepare(`
      INSERT INTO hashtags (tag, category_id, post_count) VALUES (?, ?, ?)
      ON CONFLICT(tag) DO UPDATE SET
        category_id = excluded.category_id,
        post_count = excluded.post_count
    `).run(stat.tag, stat.category_id, stat.post_count);
  }

  return db;
}

module.exports = { initDb, getDb: () => db };