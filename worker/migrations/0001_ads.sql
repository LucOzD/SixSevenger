-- Personalized ads. Apply before deploying Worker code that requires it.
CREATE TABLE IF NOT EXISTS ads (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  emoji               TEXT,
  image_path          TEXT,
  cta_url             TEXT NOT NULL,
  cta_label           TEXT NOT NULL,
  keywords            TEXT NOT NULL,
  ad_vector           TEXT NOT NULL,
  active              INTEGER NOT NULL DEFAULT 0,
  starts_at           INTEGER,
  ends_at             INTEGER,
  min_similarity      REAL NOT NULL DEFAULT 0.08,
  frequency_cap       INTEGER NOT NULL DEFAULT 3,
  frequency_window_ms INTEGER NOT NULL DEFAULT 86400000,
  min_interval_ms     INTEGER NOT NULL DEFAULT 14400000,
  created_by          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_active_schedule ON ads(active, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS ad_deliveries (
  id            TEXT PRIMARY KEY,
  ad_id         TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  selected_at   INTEGER NOT NULL,
  impression_at INTEGER,
  clicked_at    INTEGER,
  FOREIGN KEY (ad_id) REFERENCES ads(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_ad_deliveries_user_ad ON ad_deliveries(user_id, ad_id, selected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_deliveries_ad ON ad_deliveries(ad_id, selected_at DESC);