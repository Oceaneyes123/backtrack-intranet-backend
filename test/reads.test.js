import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { default: db } = await import("../db.js");
const roomsRepo = await import("../repo/rooms.js");
const messagesRepo = await import("../repo/messages.js");
const readsRepo = await import("../repo/reads.js");

const resetDb = () => {
  db.exec(`
    DELETE FROM messages;
    DELETE FROM room_reads;
    DELETE FROM room_memberships;
    DELETE FROM direct_rooms;
    DELETE FROM rooms;
    DELETE FROM users;
  `);
};

const createUser = (email, displayName) => {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO users (google_sub, email, display_name, avatar_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(`test:${email}`, email, displayName, null, now, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
};

test("read tracking updates unread counts", () => {
  resetDb();
  const alice = createUser("alice@example.com", "Alice");
  const bob = createUser("bob@example.com", "Bob");
  const room = roomsRepo.getOrCreateRoom("general", "General");

  const createdAt = new Date().toISOString();
  messagesRepo.insertMessage({
    roomId: room.id,
    userId: bob.id,
    body: "Ping",
    createdAt,
    clientMessageId: null
  });

  const unreadBefore = readsRepo.getUnreadCount(room.id, alice.id, null);
  assert.equal(unreadBefore, 1);

  readsRepo.setLastReadAt(room.id, alice.id, createdAt);
  const unreadAfter = readsRepo.getUnreadCount(room.id, alice.id, createdAt);
  assert.equal(unreadAfter, 0);
});
