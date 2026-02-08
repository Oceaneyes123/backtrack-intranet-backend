import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import config from "./config.js";

const resolvedDbPath = path.resolve(config.DATABASE_PATH);
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
const db = new Database(resolvedDbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT UNIQUE,
    email TEXT,
    display_name TEXT,
    avatar_url TEXT,
    created_at TEXT,
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    display_name TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS direct_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER,
    user_a_id INTEGER,
    user_b_id INTEGER,
    created_at TEXT,
    UNIQUE(user_a_id, user_b_id)
  );
  CREATE TABLE IF NOT EXISTS room_memberships (
    room_id INTEGER,
    user_id INTEGER,
    role TEXT,
    joined_at TEXT,
    UNIQUE(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS room_reads (
    room_id INTEGER,
    user_id INTEGER,
    last_read_at TEXT,
    UNIQUE(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER,
    sender_user_id INTEGER,
    body TEXT,
    created_at TEXT,
    edited_at TEXT,
    deleted_at TEXT,
    client_message_id TEXT,
    attachments_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_user_id, created_at);
`);

try {
  db.exec("ALTER TABLE rooms ADD COLUMN display_name TEXT");
} catch {
  // Column already exists or migration not needed.
}
try {
  db.prepare("UPDATE rooms SET display_name = ? WHERE name = ? AND display_name IS NULL").run("General", "general");
} catch {}

// Best-effort idempotency support for client_message_id.
// If a dev DB already contains duplicates, keep the earliest row and enforce uniqueness going forward.
try {
  db.exec(`
    DELETE FROM messages
    WHERE client_message_id IS NOT NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM messages
        WHERE client_message_id IS NOT NULL
        GROUP BY room_id, client_message_id
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_room_client_message_id
      ON messages(room_id, client_message_id)
      WHERE client_message_id IS NOT NULL;
  `);
} catch {
  // Ignore if SQLite doesn't support partial indexes or any other local dev constraint.
}

export default db;
