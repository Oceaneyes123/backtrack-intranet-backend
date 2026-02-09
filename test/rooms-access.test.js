import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { default: db } = await import("../db.js");
const roomsRepo = await import("../repo/rooms.js");
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

const createRes = () => ({
  statusCode: 200,
  jsonBody: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.jsonBody = body; }
});

test("requireRoomAccess allows public room and ensures membership", () => {
  resetDb();
  const user = createUser("alice@example.com", "Alice");
  const room = roomsService.getRoomOrCreatePublic("general");
  const res = createRes();

  const allowed = roomsService.requireRoomAccess(room, user, res);
  assert.equal(allowed, true);
  assert.equal(res.statusCode, 200);
  assert.equal(roomsRepo.isMember(room.id, user.id), true);
});

test("requireRoomAccess blocks private room without membership", () => {
  resetDb();
  const user = createUser("bob@example.com", "Bob");
  const room = roomsRepo.getOrCreateRoom("group:1", "Secret");
  const res = createRes();

  const allowed = roomsService.requireRoomAccess(room, user, res);
  assert.equal(allowed, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.error, "Forbidden.");
});

test("requireRoomAccess handles missing room or user", () => {
  resetDb();
  const resMissingRoom = createRes();
  const allowedRoom = roomsService.requireRoomAccess(null, { id: 1 }, resMissingRoom);
  assert.equal(allowedRoom, false);
  assert.equal(resMissingRoom.statusCode, 404);

  const resMissingUser = createRes();
  const room = roomsRepo.getOrCreateRoom("group:2", "Team");
  const allowedUser = roomsService.requireRoomAccess(room, null, resMissingUser);
  assert.equal(allowedUser, false);
  assert.equal(resMissingUser.statusCode, 401);
});
