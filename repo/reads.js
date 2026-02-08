import db from "../db.js";

const getLastReadAt = (roomId, userId) => {
  const row = db.prepare("SELECT last_read_at FROM room_reads WHERE room_id = ? AND user_id = ?").get(roomId, userId);
  return row?.last_read_at || null;
};

const setLastReadAt = (roomId, userId, at) => {
  db.prepare(
    "INSERT INTO room_reads (room_id, user_id, last_read_at) VALUES (?, ?, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at"
  ).run(roomId, userId, at);
};

const getOtherLastReadAt = (roomId, userId) => {
  const row = db.prepare(
    "SELECT last_read_at FROM room_reads WHERE room_id = ? AND user_id != ? ORDER BY last_read_at DESC LIMIT 1"
  ).get(roomId, userId);
  return row?.last_read_at || null;
};

const getUnreadCount = (roomId, userId, lastReadAt) => {
  if (!lastReadAt) {
    return db.prepare(
      "SELECT COUNT(1) as count FROM messages WHERE room_id = ? AND sender_user_id != ?"
    ).get(roomId, userId)?.count || 0;
  }
  return db.prepare(
    "SELECT COUNT(1) as count FROM messages WHERE room_id = ? AND sender_user_id != ? AND created_at > ?"
  ).get(roomId, userId, lastReadAt)?.count || 0;
};

export { getLastReadAt, setLastReadAt, getOtherLastReadAt, getUnreadCount };
