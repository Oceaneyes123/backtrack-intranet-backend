import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { default: db, repairDirectRooms } = await import("../db.js");
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

const createRoom = (name, createdAt) => {
  const info = db
    .prepare("INSERT INTO rooms (name, display_name, created_at) VALUES (?, ?, ?)")
    .run(name, null, createdAt);
  return Number(info.lastInsertRowid);
};

test("repairDirectRooms merges duplicate DM rooms into one canonical room", () => {
  resetDb();

  db.exec(`
    DROP INDEX IF EXISTS idx_direct_rooms_user_pair;
    DROP TABLE IF EXISTS direct_rooms;
    CREATE TABLE direct_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES rooms(id),
      user_a_id INTEGER REFERENCES users(id),
      user_b_id INTEGER REFERENCES users(id),
      created_at TEXT
    );
  `);

  const alice = createUser("alice@example.com", "Alice");
  const bob = createUser("bob@example.com", "Bob");
  const firstCreatedAt = new Date(Date.now() - 10_000).toISOString();
  const secondCreatedAt = new Date(Date.now() - 5_000).toISOString();
  const firstRoomId = createRoom("dm:first", firstCreatedAt);
  const secondRoomId = createRoom("dm:second", secondCreatedAt);

  db.prepare(
    "INSERT INTO direct_rooms (room_id, user_a_id, user_b_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(firstRoomId, alice.id, bob.id, firstCreatedAt);
  db.prepare(
    "INSERT INTO direct_rooms (room_id, user_a_id, user_b_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(secondRoomId, bob.id, alice.id, secondCreatedAt);

  db.prepare(
    "INSERT INTO room_memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
  ).run(firstRoomId, alice.id, "member", firstCreatedAt);
  db.prepare(
    "INSERT INTO room_memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
  ).run(firstRoomId, bob.id, "member", firstCreatedAt);
  db.prepare(
    "INSERT INTO room_memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
  ).run(secondRoomId, alice.id, "member", secondCreatedAt);
  db.prepare(
    "INSERT INTO room_memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
  ).run(secondRoomId, bob.id, "member", secondCreatedAt);

  db.prepare(
    "INSERT INTO room_reads (room_id, user_id, last_read_at) VALUES (?, ?, ?)"
  ).run(secondRoomId, alice.id, secondCreatedAt);

  db.prepare(
    "INSERT INTO messages (room_id, sender_user_id, body, created_at, client_message_id) VALUES (?, ?, ?, ?, ?)"
  ).run(firstRoomId, alice.id, "Hello", firstCreatedAt, null);
  db.prepare(
    "INSERT INTO messages (room_id, sender_user_id, body, created_at, client_message_id) VALUES (?, ?, ?, ?, ?)"
  ).run(secondRoomId, bob.id, "Test", secondCreatedAt, null);

  repairDirectRooms();

  const directRooms = db.prepare("SELECT * FROM direct_rooms ORDER BY id").all();
  assert.equal(directRooms.length, 1);
  assert.equal(directRooms[0].room_id, firstRoomId);
  assert.equal(directRooms[0].user_a_id, alice.id);
  assert.equal(directRooms[0].user_b_id, bob.id);

  const mergedMessages = db.prepare("SELECT room_id, body FROM messages ORDER BY created_at").all();
  assert.equal(mergedMessages.length, 2);
  assert.ok(mergedMessages.every((message) => message.room_id === firstRoomId));

  const reads = db.prepare("SELECT room_id, user_id, last_read_at FROM room_reads").all();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].room_id, firstRoomId);

  const survivingRooms = db.prepare("SELECT id, name FROM rooms ORDER BY id").all();
  assert.equal(survivingRooms.length, 1);
  assert.equal(survivingRooms[0].id, firstRoomId);

  const rooms = roomsService.listRoomsForUser(alice);
  const dmRooms = rooms.filter((room) => room.type === "dm");
  assert.equal(dmRooms.length, 1);
  assert.equal(dmRooms[0].lastMessage, "Test");
  assert.equal(dmRooms[0].room, "dm:first");
});
