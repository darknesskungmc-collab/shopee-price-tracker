CREATE TABLE IF NOT EXISTS tracked_items (
  item_key TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT 'มาตรฐาน',
  product_url TEXT NOT NULL,
  image_url TEXT,
  initial_price REAL NOT NULL,
  current_price REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tracked_items_updated_at
  ON tracked_items(updated_at);
