import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { default: db } = await import("../db.js");
const roomsRepo = await import("../repo/rooms.js");
const messagesRepo = await import("../repo/messages.js");
const readsRepo = await import("../repo/reads.js");
const roomsService = await import("../services/rooms.js");

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

test("getRoomMeta returns unread counts and read timestamps", () => {
  resetDb();
  const alice = createUser("alice@example.com", "Alice");
  const bob = createUser("bob@example.com", "Bob");
  const room = roomsRepo.getOrCreateRoom("general", "General");
  roomsRepo.ensureMembership(room.id, alice.id);
  roomsRepo.ensureMembership(room.id, bob.id);

  const createdAt = new Date().toISOString();
  messagesRepo.insertMessage({
    roomId: room.id,
    userId: bob.id,
    body: "Hello",
    createdAt,
    clientMessageId: null
  });

  let meta = roomsService.getRoomMeta(room.id, alice.id);
  assert.equal(meta.unreadCount, 1);
  assert.equal(meta.lastReadAt, null);

  const readAt = new Date().toISOString();
  readsRepo.setLastReadAt(room.id, alice.id, readAt);
  readsRepo.setLastReadAt(room.id, bob.id, readAt);
  meta = roomsService.getRoomMeta(room.id, alice.id);
  assert.equal(meta.unreadCount, 0);
  assert.equal(meta.lastReadAt, readAt);
  assert.equal(meta.otherLastReadAt, readAt);
});

test("resolveRoomDisplayName matches direct, group, and public rooms", () => {
  const direct = roomsService.resolveRoomDisplayName(
    { name: "dm:1", display_name: null },
    { display_name: "Dana", email: "dana@example.com" }
  );
  assert.equal(direct.type, "dm");
  assert.equal(direct.displayName, "Dana");

  const general = roomsService.resolveRoomDisplayName(
    { name: "general", display_name: null },
    null
  );
  assert.equal(general.type, "group");
  assert.equal(general.displayName, "General");

  const group = roomsService.resolveRoomDisplayName(
    { name: "group:1", display_name: null },
    null
  );
  assert.equal(group.type, "group");
  assert.equal(group.displayName, "Group");
});
