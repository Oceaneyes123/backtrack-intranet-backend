import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import config from "./config.js";

const resolvedDbPath = path.resolve(config.DATABASE_PATH);
fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
const db = new Database(resolvedDbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const repairDuplicateUsers = () => {
  // Load all users with email, normalize, and group by normalized email
  const allUsers = db.prepare("SELECT id, google_sub, email, created_at FROM users WHERE email IS NOT NULL").all();

  const groups = new Map();
  const toNormalize = [];

  allUsers.forEach((user) => {
    const normalized = String(user.email || "").trim().toLowerCase();
    if (!normalized) return;
    if (normalized !== user.email) {
      toNormalize.push({ id: user.id, normalized });
    }
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push({ ...user, normalizedEmail: normalized });
  });

  const updateEmail = db.prepare("UPDATE users SET email = ? WHERE id = ?");
  const updateMessagesSender = db.prepare("UPDATE messages SET sender_user_id = ? WHERE sender_user_id = ?");
  const updateMemberships = db.prepare(
    "UPDATE room_memberships SET user_id = ? WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM room_memberships AS rm WHERE rm.room_id = room_memberships.room_id AND rm.user_id = ?)"
  );
  const deleteMemberships = db.prepare("DELETE FROM room_memberships WHERE user_id = ?");
  const updateReads = db.prepare(
    "UPDATE room_reads SET user_id = ? WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM room_reads AS rr WHERE rr.room_id = room_reads.room_id AND rr.user_id = ?)"
  );
  const deleteReads = db.prepare("DELETE FROM room_reads WHERE user_id = ?");
  const updateDirectA = db.prepare("UPDATE direct_rooms SET user_a_id = ? WHERE user_a_id = ?");
  const updateDirectB = db.prepare("UPDATE direct_rooms SET user_b_id = ? WHERE user_b_id = ?");
  const deleteUser = db.prepare("DELETE FROM users WHERE id = ?");

  const transaction = db.transaction(() => {
    // Step 3: normalize stored emails
    toNormalize.forEach(({ id, normalized }) => updateEmail.run(normalized, id));

    // Step 5-6: deduplicate
    groups.forEach((users) => {
      if (users.length <= 1) return;

      // Pick canonical: prefer non-pending, then earliest created_at, then lowest id
      const sorted = [...users].sort((a, b) => {
        const aPending = a.google_sub?.startsWith("pending:") ? 1 : 0;
        const bPending = b.google_sub?.startsWith("pending:") ? 1 : 0;
        if (aPending !== bPending) return aPending - bPending;
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.id - b.id;
      });

      const canonical = sorted[0];
      const duplicates = sorted.slice(1);

      duplicates.forEach((dup) => {
        updateMessagesSender.run(canonical.id, dup.id);
        updateMemberships.run(canonical.id, dup.id, canonical.id);
        deleteMemberships.run(dup.id);
        updateReads.run(canonical.id, dup.id, canonical.id);
        deleteReads.run(dup.id);
        updateDirectA.run(canonical.id, dup.id);
        updateDirectB.run(canonical.id, dup.id);
        deleteUser.run(dup.id);
      });
    });
  });

  transaction();
};

const repairDirectRooms = () => {
  const rows = db
    .prepare("SELECT id, room_id, user_a_id, user_b_id, created_at FROM direct_rooms ORDER BY COALESCE(created_at, ''), room_id, id")
    .all();

  const copyMemberships = db.prepare(
    "INSERT OR IGNORE INTO room_memberships (room_id, user_id, role, joined_at) SELECT ?, user_id, role, joined_at FROM room_memberships WHERE room_id = ?"
  );
  const deleteMemberships = db.prepare("DELETE FROM room_memberships WHERE room_id = ?");
  const readRowsForRoom = db.prepare("SELECT user_id, last_read_at FROM room_reads WHERE room_id = ?");
  const readRowForUser = db.prepare("SELECT last_read_at FROM room_reads WHERE room_id = ? AND user_id = ?");
  const upsertRead = db.prepare(
    "INSERT INTO room_reads (room_id, user_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at"
  );
  const deleteReads = db.prepare("DELETE FROM room_reads WHERE room_id = ?");
  const moveMessages = db.prepare("UPDATE messages SET room_id = ? WHERE room_id = ?");
  const updateDirectPair = db.prepare("UPDATE direct_rooms SET user_a_id = ?, user_b_id = ? WHERE id = ?");
  const deleteDirectRoom = db.prepare("DELETE FROM direct_rooms WHERE id = ?");
  const deleteRoom = db.prepare("DELETE FROM rooms WHERE id = ?");

  const groups = new Map();
  rows.forEach((row) => {
    const lowUserId = Math.min(row.user_a_id, row.user_b_id);
    const highUserId = Math.max(row.user_a_id, row.user_b_id);
    const key = `${lowUserId}:${highUserId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...row, lowUserId, highUserId });
  });

  const transaction = db.transaction(() => {
    groups.forEach((groupRows) => {
      if (!groupRows.length) return;
      const [keeper, ...duplicates] = groupRows;

      if (keeper.user_a_id !== keeper.lowUserId || keeper.user_b_id !== keeper.highUserId) {
        updateDirectPair.run(keeper.lowUserId, keeper.highUserId, keeper.id);
      }

      duplicates.forEach((duplicate) => {
        if (duplicate.room_id !== keeper.room_id) {
          moveMessages.run(keeper.room_id, duplicate.room_id);
          copyMemberships.run(keeper.room_id, duplicate.room_id);
          deleteMemberships.run(duplicate.room_id);

          readRowsForRoom.all(duplicate.room_id).forEach((readRow) => {
            const existing = readRowForUser.get(keeper.room_id, readRow.user_id);
            const nextReadAt = !existing?.last_read_at
              ? readRow.last_read_at
              : !readRow.last_read_at
                ? existing.last_read_at
                : (readRow.last_read_at > existing.last_read_at ? readRow.last_read_at : existing.last_read_at);
            upsertRead.run(keeper.room_id, readRow.user_id, nextReadAt);
          });
          deleteReads.run(duplicate.room_id);
        }

        deleteDirectRoom.run(duplicate.id);
        if (duplicate.room_id !== keeper.room_id) {
          deleteRoom.run(duplicate.room_id);
        }
      });
    });
  });

  transaction();
};

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
    room_id INTEGER REFERENCES rooms(id),
    user_a_id INTEGER REFERENCES users(id),
    user_b_id INTEGER REFERENCES users(id),
    created_at TEXT,
    UNIQUE(user_a_id, user_b_id)
  );
  CREATE TABLE IF NOT EXISTS room_memberships (
    room_id INTEGER REFERENCES rooms(id),
    user_id INTEGER REFERENCES users(id),
    role TEXT,
    joined_at TEXT,
    UNIQUE(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS room_reads (
    room_id INTEGER REFERENCES rooms(id),
    user_id INTEGER REFERENCES users(id),
    last_read_at TEXT,
    UNIQUE(room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id),
    sender_user_id INTEGER REFERENCES users(id),
    body TEXT,
    created_at TEXT,
    edited_at TEXT,
    deleted_at TEXT,
    client_message_id TEXT,
    attachments_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_created ON messages(sender_user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_room_memberships_user_room ON room_memberships(user_id, room_id);
`);

try {
  db.exec("ALTER TABLE rooms ADD COLUMN display_name TEXT");
} catch {
  // Column already exists or migration not needed.
}
try {
  db.prepare("UPDATE rooms SET display_name = ? WHERE name = ? AND display_name IS NULL").run("General", "general");
} catch {}

try {
  repairDirectRooms();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_direct_rooms_user_pair
      ON direct_rooms(user_a_id, user_b_id);
  `);
} catch {
  // Ignore if SQLite cannot add the index to an existing local dev DB.
}
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

if (config.NODE_ENV === "production") {
  try {
    repairDuplicateUsers();
    repairDirectRooms();
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;");
  } catch (err) {
    console.error("Database repair failed:", err);
    process.exit(1);
  }
} else {
  try {
    repairDuplicateUsers();
    repairDirectRooms();
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;");
  } catch {
    // Best-effort in development.
  }
}

export { repairDirectRooms, repairDuplicateUsers };
export default db;
