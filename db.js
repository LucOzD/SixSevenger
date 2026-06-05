const initSqlJs = require('sql.js');
const fs = require('fs-extra');
const path = require('path');

let db = null;

const dbPath = path.join(__dirname, 'database.db');

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

  return db;
}

module.exports = { initDb, getDb: () => db };