import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { default: db } = await import("../db.js");
const roomsRepo = await import("../repo/rooms.js");
const messagesRepo = await import("../repo/messages.js");

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

test("insertMessageIdempotent avoids duplicates", () => {
  resetDb();
  const user = createUser("alice@example.com", "Alice");
  const room = roomsRepo.getOrCreateRoom("general", "General");

  const createdAt = new Date().toISOString();
  const first = messagesRepo.insertMessageIdempotent({
    roomId: room.id,
    userId: user.id,
    body: "Hello",
    createdAt,
    clientMessageId: "client-1"
  });
  assert.equal(first.changes, 1);

  const second = messagesRepo.insertMessageIdempotent({
    roomId: room.id,
    userId: user.id,
    body: "Hello",
    createdAt,
    clientMessageId: "client-1"
  });
  assert.equal(second.changes, 0);

  const existing = messagesRepo.getMessageByClientId(room.id, "client-1");
  assert.equal(existing.body, "Hello");

  const count = db.prepare("SELECT COUNT(1) as count FROM messages WHERE room_id = ?").get(room.id).count;
  assert.equal(count, 1);
});

test("getMessages respects before and returns ascending order", () => {
  resetDb();
  const user = createUser("bob@example.com", "Bob");
  const room = roomsRepo.getOrCreateRoom("general", "General");

  const base = Date.now();
  const timestamps = [
    new Date(base - 3000).toISOString(),
    new Date(base - 2000).toISOString(),
    new Date(base - 1000).toISOString()
  ];

  timestamps.forEach((createdAt, index) => {
    messagesRepo.insertMessage({
      roomId: room.id,
      userId: user.id,
      body: `Msg ${index + 1}`,
      createdAt,
      clientMessageId: null
    });
  });

  const before = timestamps[2];
  const messages = messagesRepo.getMessages({ roomId: room.id, limit: 10, before });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].body, "Msg 1");
  assert.equal(messages[1].body, "Msg 2");
});

test("cleanupRetention removes old messages", () => {
  resetDb();
  const user = createUser("carl@example.com", "Carl");
  const room = roomsRepo.getOrCreateRoom("general", "General");

  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  messagesRepo.insertMessage({
    roomId: room.id,
    userId: user.id,
    body: "Old message",
    createdAt: oldDate,
    clientMessageId: null
  });

  messagesRepo.cleanupRetention(1);
  const count = db.prepare("SELECT COUNT(1) as count FROM messages WHERE room_id = ?").get(room.id).count;
  assert.equal(count, 0);
});
