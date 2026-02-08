import db from "../db.js";

const getMessages = ({ roomId, limit, before }) => {
  if (before) {
    return db
      .prepare(
        `
        SELECT m.id, m.body, m.created_at, m.client_message_id, u.display_name, u.email, u.avatar_url
        FROM messages m
        JOIN users u ON u.id = m.sender_user_id
        WHERE m.room_id = ? AND m.created_at < ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `
      )
      .all(roomId, before, limit)
      .reverse();
  }

  return db
    .prepare(
      `
      SELECT m.id, m.body, m.created_at, m.client_message_id, u.display_name, u.email, u.avatar_url
      FROM messages m
      JOIN users u ON u.id = m.sender_user_id
      WHERE m.room_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `
    )
    .all(roomId, limit)
    .reverse();
};

const insertMessage = ({ roomId, userId, body, createdAt, clientMessageId }) => {
  const insert = db.prepare(
    "INSERT INTO messages (room_id, sender_user_id, body, created_at, client_message_id) VALUES (?, ?, ?, ?, ?)"
  );
  return insert.run(roomId, userId, body, createdAt, clientMessageId);
};

const insertMessageIdempotent = ({ roomId, userId, body, createdAt, clientMessageId }) => {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO messages (room_id, sender_user_id, body, created_at, client_message_id) VALUES (?, ?, ?, ?, ?)"
  );
  return insert.run(roomId, userId, body, createdAt, clientMessageId);
};

const getMessageByClientId = (roomId, clientMessageId) => {
  return db
    .prepare(
      `
      SELECT m.id, m.body, m.created_at, m.client_message_id, u.display_name, u.email, u.avatar_url
      FROM messages m
      JOIN users u ON u.id = m.sender_user_id
      WHERE m.room_id = ? AND m.client_message_id = ?
      LIMIT 1
    `
    )
    .get(roomId, clientMessageId);
};

const getLastMessageForRoom = (roomId) => {
  return db
    .prepare("SELECT body, created_at FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(roomId);
};

const cleanupRetention = (retentionDays) => {
  if (!retentionDays || Number.isNaN(retentionDays)) return;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
};

export {
  getMessages,
  insertMessage,
  insertMessageIdempotent,
  getMessageByClientId,
  getLastMessageForRoom,
  cleanupRetention
};
