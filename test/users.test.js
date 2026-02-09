import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { default: db } = await import("../db.js");
const usersRepo = await import("../repo/users.js");

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

test("getOrCreatePendingUser creates and formats display name", () => {
  resetDb();
  const pending = usersRepo.getOrCreatePendingUser("jane.doe@example.com");
  assert.ok(pending);
  assert.equal(pending.email, "jane.doe@example.com");
  assert.equal(pending.display_name, "Jane Doe");
  assert.ok(pending.google_sub.startsWith("pending:"));
});

test("getOrCreateUserFromToken upgrades pending user", () => {
  resetDb();
  const pending = usersRepo.getOrCreatePendingUser("sam@example.com");
  assert.ok(pending);

  const payload = {
    sub: "google-sub-123",
    email: "sam@example.com",
    name: "Sam Example",
    picture: "https://example.com/sam.png"
  };
  const user = usersRepo.getOrCreateUserFromToken(payload);
  assert.equal(user.google_sub, "google-sub-123");
  assert.equal(user.display_name, "Sam Example");
  assert.equal(user.avatar_url, "https://example.com/sam.png");
});

test("getAnonymousUser reuses the same record", () => {
  resetDb();
  const first = usersRepo.getAnonymousUser();
  const second = usersRepo.getAnonymousUser();
  assert.equal(first.id, second.id);
  assert.equal(first.google_sub, "anonymous");
});
