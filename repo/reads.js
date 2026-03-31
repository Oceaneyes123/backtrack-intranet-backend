import db from "../db.js";

const buildPlaceholders = (items) => items.map(() => "?").join(", ");

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
      "SELECT COUNT(1) as count FROM messages WHERE room_id = ? AND sender_user_id != ? AND deleted_at IS NULL"
    ).get(roomId, userId)?.count || 0;
  }
  return db.prepare(
    "SELECT COUNT(1) as count FROM messages WHERE room_id = ? AND sender_user_id != ? AND created_at > ? AND deleted_at IS NULL"
  ).get(roomId, userId, lastReadAt)?.count || 0;
};

const getRoomReadStatesForUser = (roomIds, userId) => {
  if (!Array.isArray(roomIds) || !roomIds.length) return [];
  const placeholders = buildPlaceholders(roomIds);
  return db
    .prepare(
      `
      WITH reads AS (
        SELECT
          room_id,
          MAX(CASE WHEN user_id = ? THEN last_read_at END) AS last_read_at,
          MAX(CASE WHEN user_id != ? THEN last_read_at END) AS other_last_read_at
        FROM room_reads
        WHERE room_id IN (${placeholders})
        GROUP BY room_id
      ),
      unread AS (
        SELECT
          m.room_id,
          COUNT(1) AS unread_count
        FROM messages m
        LEFT JOIN reads r ON r.room_id = m.room_id
        WHERE m.room_id IN (${placeholders})
          AND m.sender_user_id != ?
          AND m.deleted_at IS NULL
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
        GROUP BY m.room_id
      )
      SELECT
        r.room_id,
        r.last_read_at,
        r.other_last_read_at,
        COALESCE(u.unread_count, 0) AS unread_count
      FROM reads r
      LEFT JOIN unread u ON u.room_id = r.room_id
      UNION ALL
      SELECT
        u.room_id,
        NULL AS last_read_at,
        NULL AS other_last_read_at,
        u.unread_count
      FROM unread u
      LEFT JOIN reads r ON r.room_id = u.room_id
      WHERE r.room_id IS NULL
    `
    )
    .all(
      userId,
      userId,
      ...roomIds,
      ...roomIds,
      userId
    )
    .map((row) => ({
      roomId: row.room_id,
      lastReadAt: row.last_read_at || null,
      otherLastReadAt: row.other_last_read_at || null,
      unreadCount: Number(row.unread_count) || 0
    }));
};

export { getLastReadAt, setLastReadAt, getOtherLastReadAt, getUnreadCount, getRoomReadStatesForUser };
