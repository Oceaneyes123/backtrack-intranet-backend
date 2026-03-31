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

test("listRoomsForUser includes general and direct rooms", () => {
  resetDb();
  const alice = createUser("alice@example.com", "Alice");
  const bob = createUser("bob@example.com", "Bob");

  const dmRoom = roomsRepo.getOrCreateDirectRoom(alice.id, bob.id);
  roomsRepo.ensureMembership(dmRoom.id, alice.id);
  roomsRepo.ensureMembership(dmRoom.id, bob.id);

  const firstMessageAt = new Date(Date.now() - 2_000).toISOString();
  const secondMessageAt = new Date(Date.now() - 1_000).toISOString();
  messagesRepo.insertMessage({
    roomId: dmRoom.id,
    userId: bob.id,
    body: "Hi Alice",
    createdAt: firstMessageAt,
    clientMessageId: null
  });
  messagesRepo.insertMessage({
    roomId: dmRoom.id,
    userId: bob.id,
    body: "Follow up",
    createdAt: secondMessageAt,
    clientMessageId: null
  });

  readsRepo.setLastReadAt(dmRoom.id, alice.id, firstMessageAt);
  readsRepo.setLastReadAt(dmRoom.id, bob.id, secondMessageAt);

  const rooms = roomsService.listRoomsForUser(alice);
  const general = rooms.find((room) => room.room === "general");
  assert.ok(general);

  const direct = rooms.find((room) => room.room === dmRoom.name);
  assert.ok(direct);
  assert.equal(direct.type, "dm");
  assert.equal(direct.displayName, "Bob");
  assert.equal(direct.lastMessage, "Follow up");
  assert.equal(direct.unread, 1);
  assert.equal(direct.lastReadAt, firstMessageAt);
  assert.equal(direct.otherLastReadAt, secondMessageAt);
  assert.equal(direct.members.length, 2);
  assert.ok(direct.members.some((member) => member.email === "bob@example.com"));
});
