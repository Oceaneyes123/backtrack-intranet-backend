import { randomUUID } from "node:crypto";
import db from "../db.js";

const getRoomByName = (roomName) => {
  const normalized = String(roomName || "").trim();
  if (!normalized) return null;
  return db.prepare("SELECT id, name, display_name FROM rooms WHERE name = ?").get(normalized) || null;
};

const getOrCreateRoom = (roomName, displayName = null) => {
  const normalized = roomName || "general";
  const row = db.prepare("SELECT id, name, display_name FROM rooms WHERE name = ?").get(normalized);
  if (row) {
    if (displayName && !row.display_name) {
      db.prepare("UPDATE rooms SET display_name = ? WHERE id = ?").run(displayName, row.id);
      row.display_name = displayName;
    }
    return row;
  }
  const now = new Date().toISOString();
  const info = db
    .prepare("INSERT INTO rooms (name, display_name, created_at) VALUES (?, ?, ?)")
    .run(normalized, displayName, now);
  return { id: info.lastInsertRowid, name: normalized, display_name: displayName };
};

const ensureMembership = (roomId, userId) => {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO room_memberships (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
  ).run(roomId, userId, "member", now);
};

const isMember = (roomId, userId) => {
  if (!roomId || !userId) return false;
  return Boolean(
    db.prepare("SELECT 1 FROM room_memberships WHERE room_id = ? AND user_id = ?").get(roomId, userId)
  );
};

const getRoomMembers = (roomId) => {
  if (!roomId) return [];
  return db
    .prepare(
      `
      SELECT u.email, u.display_name, u.avatar_url
      FROM room_memberships rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
      ORDER BY u.display_name IS NULL, u.display_name, u.email
    `
    )
    .all(roomId)
    .map((row) => ({
      email: row.email,
      displayName: row.display_name || row.email || "User",
      avatarUrl: row.avatar_url || null
    }));
};

const getDirectRoomOtherUser = (roomId, userId) => {
  if (!roomId || !userId) return null;
  return db
    .prepare(
      `
      SELECT u.display_name, u.email, u.avatar_url
      FROM direct_rooms d
      JOIN users u ON u.id = CASE WHEN d.user_a_id = ? THEN d.user_b_id ELSE d.user_a_id END
      WHERE d.room_id = ?
    `
    )
    .get(userId, roomId);
};

const getOrCreateDirectRoom = (userAId, userBId) => {
  const [a, b] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  const existing = db
    .prepare(
      "SELECT r.id, r.name, r.display_name FROM direct_rooms d JOIN rooms r ON r.id = d.room_id WHERE d.user_a_id = ? AND d.user_b_id = ?"
    )
    .get(a, b);
  if (existing) return existing;

  const now = new Date().toISOString();
  const roomName = `dm:${randomUUID()}`;
  const roomInfo = db
    .prepare("INSERT INTO rooms (name, display_name, created_at) VALUES (?, ?, ?)")
    .run(roomName, null, now);
  db.prepare(
    "INSERT INTO direct_rooms (room_id, user_a_id, user_b_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(roomInfo.lastInsertRowid, a, b, now);
  return { id: roomInfo.lastInsertRowid, name: roomName };
};

const listRoomsForUser = (userId) => {
  return db
    .prepare(
      `
      SELECT r.id, r.name, r.display_name, r.created_at, d.user_a_id, d.user_b_id,
             u.id as other_user_id, u.display_name as other_display_name, u.email as other_email
      FROM rooms r
      JOIN room_memberships rm ON rm.room_id = r.id
      LEFT JOIN direct_rooms d ON d.room_id = r.id
      LEFT JOIN users u ON u.id = CASE WHEN d.user_a_id = ? THEN d.user_b_id ELSE d.user_a_id END
      WHERE rm.user_id = ?
    `
    )
    .all(userId, userId);
};

export {
  getRoomByName,
  getOrCreateRoom,
  ensureMembership,
  isMember,
  getRoomMembers,
  getDirectRoomOtherUser,
  getOrCreateDirectRoom,
  listRoomsForUser
};
