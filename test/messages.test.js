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

test("updateMessageBody edits stored message content", () => {
  resetDb();
  const user = createUser("dana@example.com", "Dana");
  const room = roomsRepo.getOrCreateRoom("general", "General");

  const createdAt = new Date().toISOString();
  const inserted = messagesRepo.insertMessage({
    roomId: room.id,
    userId: user.id,
    body: "Original body",
    createdAt,
    clientMessageId: null
  });

  const editedAt = new Date(Date.now() + 1000).toISOString();
  const { info, message } = messagesRepo.updateMessageBody({
    roomId: room.id,
    messageId: inserted.lastInsertRowid,
    body: "Edited body",
    editedAt
  });

  assert.equal(info.changes, 1);
  assert.equal(message.body, "Edited body");
  assert.equal(message.edited_at, editedAt);

  const listed = messagesRepo.getMessages({ roomId: room.id, limit: 10, before: null });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].body, "Edited body");
  assert.equal(listed[0].edited_at, editedAt);
});

test("softDeleteMessage hides deleted messages from history previews and unread counts", () => {
  resetDb();
  const sender = createUser("erin@example.com", "Erin");
  const reader = createUser("frank@example.com", "Frank");
  const room = roomsRepo.getOrCreateRoom("general", "General");
  roomsRepo.ensureMembership(room.id, sender.id);
  roomsRepo.ensureMembership(room.id, reader.id);

  const firstCreatedAt = new Date(Date.now() - 2000).toISOString();
  const secondCreatedAt = new Date(Date.now() - 1000).toISOString();
  messagesRepo.insertMessage({
    roomId: room.id,
    userId: sender.id,
    body: "First visible",
    createdAt: firstCreatedAt,
    clientMessageId: null
  });
  const second = messagesRepo.insertMessage({
    roomId: room.id,
    userId: sender.id,
    body: "Delete me",
    createdAt: secondCreatedAt,
    clientMessageId: null
  });

  assert.equal(readsRepo.getUnreadCount(room.id, reader.id, null), 2);

  const deletedAt = new Date().toISOString();
  const info = messagesRepo.softDeleteMessage({
    roomId: room.id,
    messageId: second.lastInsertRowid,
    deletedAt
  });

  assert.equal(info.changes, 1);
  assert.equal(readsRepo.getUnreadCount(room.id, reader.id, null), 1);

  const visible = messagesRepo.getMessages({ roomId: room.id, limit: 10, before: null });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].body, "First visible");

  const lastMessage = messagesRepo.getLastMessageForRoom(room.id);
  assert.equal(lastMessage.body, "First visible");
});
