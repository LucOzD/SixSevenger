-- schema.sql — D1 schema for SixSevenger
-- Apply with:  npx wrangler d1 execute sixsevenger --file=./schema.sql --remote
--
-- D1 is SQLite, so this mirrors the original db.js schema closely. Two things
-- are new: the `categories` and `model_meta` tables, which hold the recommender
-- state that used to live in recommender_state.pkl. A Worker has no disk, so
-- the model is persisted here instead.

-- ---------------------------------------------------------------- users
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE,
  passwordHash TEXT,
  bio          TEXT,
  profilePic   TEXT,
  guest        INTEGER DEFAULT 1,
  created      INTEGER
);

-- ---------------------------------------------------------------- posts
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  userId      TEXT,
  text        TEXT,
  timestamp   INTEGER,
  deleted     INTEGER DEFAULT 0,
  category_id INTEGER DEFAULT -1,
  spam_score  REAL DEFAULT 0,
  post_vector TEXT,              -- JSON sparse vector
  sentiment   REAL DEFAULT 0,    -- VADER compound, -1 to 1
  FOREIGN KEY (userId) REFERENCES users(id)
);

-- The feed filters on deleted/spam and orders by recency
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(deleted, spam_score, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(userId, deleted);
CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category_id);

-- ---------------------------------------------------------------- likes
CREATE TABLE IF NOT EXISTS likes (
  id      TEXT PRIMARY KEY,
  postId  TEXT,
  userId  TEXT,
  value   INTEGER,               -- 1 like, -1 dislike
  created INTEGER,
  UNIQUE (postId, userId),
  FOREIGN KEY (postId) REFERENCES posts(id),
  FOREIGN KEY (userId) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(postId);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(userId, value);

-- ---------------------------------------------------------------- comments
CREATE TABLE IF NOT EXISTS comments (
  id        TEXT PRIMARY KEY,
  postId    TEXT,
  userId    TEXT,
  text      TEXT,
  timestamp INTEGER,
  FOREIGN KEY (postId) REFERENCES posts(id),
  FOREIGN KEY (userId) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(postId, timestamp);

-- ---------------------------------------------------------------- follows
CREATE TABLE IF NOT EXISTS follow_requests (
  id         TEXT PRIMARY KEY,
  fromUserId TEXT,
  toUserId   TEXT,
  created    INTEGER,
  UNIQUE (fromUserId, toUserId)
);

CREATE TABLE IF NOT EXISTS follows (
  id          TEXT PRIMARY KEY,
  followerId  TEXT,
  followingId TEXT,
  created     INTEGER,
  UNIQUE (followerId, followingId)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(followerId);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(followingId);

-- ---------------------------------------------------------------- notifications
CREATE TABLE IF NOT EXISTS notifications (
  id      TEXT PRIMARY KEY,
  userId  TEXT,
  type    TEXT,
  payload TEXT,
  read    INTEGER DEFAULT 0,
  created INTEGER
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId, read, created DESC);

-- ---------------------------------------------------------------- interests
CREATE TABLE IF NOT EXISTS user_interests (
  userId      TEXT,
  category_id INTEGER,
  score       REAL DEFAULT 0,
  PRIMARY KEY (userId, category_id)
);

-- ---------------------------------------------------------------- engagement
CREATE TABLE IF NOT EXISTS engagement (
  id      TEXT PRIMARY KEY,
  postId  TEXT,
  userId  TEXT,
  viewMs  INTEGER DEFAULT 0,
  hoverMs INTEGER DEFAULT 0,
  created INTEGER
);

CREATE INDEX IF NOT EXISTS idx_engagement_post ON engagement(postId);

-- Posts already served to a user, so the feed can avoid repeats
CREATE TABLE IF NOT EXISTS feed_seen (
  userId TEXT,
  postId TEXT,
  seenAt INTEGER,
  PRIMARY KEY (userId, postId)
);

CREATE INDEX IF NOT EXISTS idx_feed_seen_user ON feed_seen(userId, seenAt);

-- ---------------------------------------------------------------- hashtags
CREATE TABLE IF NOT EXISTS hashtags (
  tag         TEXT PRIMARY KEY,
  category_id INTEGER DEFAULT -1,
  post_count  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hashtags_category ON hashtags(category_id);

CREATE TABLE IF NOT EXISTS post_hashtags (
  postId TEXT,
  tag    TEXT,
  PRIMARY KEY (postId, tag)
);

CREATE INDEX IF NOT EXISTS idx_post_hashtags_tag ON post_hashtags(tag);

-- ---------------------------------------------------------------- model state
-- Replaces recommender_state.pkl. One row per discovered category.
CREATE TABLE IF NOT EXISTS categories (
  id              INTEGER PRIMARY KEY,
  centroid        TEXT,            -- JSON sparse vector (pruned to 128 features)
  n_posts         INTEGER DEFAULT 0,
  word_counts     TEXT,            -- JSON {word: count}
  category_words  TEXT,            -- JSON [top 10 words]
  sentiment       REAL DEFAULT 0,
  sentiment_count INTEGER DEFAULT 0,
  vectors         TEXT             -- JSON array of recent vectors, for split checks
);

-- Scalars that used to be PostAnalyser instance fields (nextId, postCount)
CREATE TABLE IF NOT EXISTS model_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------- sessions
-- Express used a signed cookie backed by in-process state. A Worker has no
-- memory between requests, so sessions are explicit rows.
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  userId  TEXT,
  created INTEGER,
  expires INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
