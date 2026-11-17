import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id  INTEGER PRIMARY KEY,
  first_name   TEXT,
  last_name    TEXT,
  username     TEXT,
  city         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS users_username ON users(username);

CREATE TABLE IF NOT EXISTS venues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  address     TEXT NOT NULL,
  phone       TEXT,
  lat         REAL,
  lng         REAL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS venue_partners (
  venue_id   INTEGER NOT NULL REFERENCES venues(id),
  user_id    INTEGER NOT NULL REFERENCES users(telegram_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (venue_id, user_id)
);

-- pickup_start / pickup_end: местное время заведения, 'YYYY-MM-DDTHH:MM'.
-- quantity: сколько ещё можно забронировать. Брони живут в order_items.
CREATE TABLE IF NOT EXISTS offers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id         INTEGER NOT NULL REFERENCES venues(id),
  name             TEXT NOT NULL,
  photo            TEXT NOT NULL,
  description      TEXT NOT NULL,
  ingredients      TEXT NOT NULL,
  category         TEXT NOT NULL,
  price_original   INTEGER NOT NULL,
  price_discounted INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity >= 0),
  pickup_start     TEXT NOT NULL,
  pickup_end       TEXT NOT NULL,
  is_published     INTEGER NOT NULL DEFAULT 1,
  is_hidden        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS offers_venue ON offers(venue_id);
CREATE INDEX IF NOT EXISTS offers_pickup ON offers(pickup_end);

CREATE TABLE IF NOT EXISTS favorites (
  user_id          INTEGER NOT NULL REFERENCES users(telegram_id),
  offer_id         INTEGER NOT NULL REFERENCES offers(id),
  last_notified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, offer_id)
);
CREATE INDEX IF NOT EXISTS favorites_offer ON favorites(offer_id);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(telegram_id),
  venue_id        INTEGER NOT NULL REFERENCES venues(id),
  code            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('booked','received','cancelled','not_picked_up')),
  total           INTEGER NOT NULL,
  pickup_start    TEXT NOT NULL,
  pickup_end      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  stock_released  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS orders_venue ON orders(venue_id, status);
CREATE INDEX IF NOT EXISTS orders_status_pickup ON orders(status, pickup_end);

-- Название и цены копируются: правка предложения не меняет уже сделанный заказ.
CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  offer_id       INTEGER NOT NULL REFERENCES offers(id),
  name           TEXT NOT NULL,
  price          INTEGER NOT NULL,
  price_original INTEGER NOT NULL,
  quantity       INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    INTEGER,
  actor_role  TEXT NOT NULL,
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS order_history_order ON order_status_history(order_id);

-- Очередь уведомлений: запись идёт в одной транзакции с изменением заказа,
-- а сбой Telegram не может сломать бронирование.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  button_path TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(sent_at, attempts);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Встроенные LOWER/LIKE в SQLite не понимают регистр кириллицы.
  db.function('ru_lower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
  db.exec(SCHEMA);
  return db;
}

export function likePattern(query) {
  const escaped = query.trim().toLowerCase().replace(/[\\%_]/g, '\\$&');
  return `%${escaped}%`;
}
