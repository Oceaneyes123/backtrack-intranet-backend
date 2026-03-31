import db from "../db.js";

const MESSAGE_SELECT = `
  SELECT
    m.id,
    m.room_id,
    m.sender_user_id,
    m.body,
    m.created_at,
    m.edited_at,
    m.deleted_at,
    m.client_message_id,
    u.display_name,
    u.email,
    u.avatar_url
  FROM messages m
  JOIN users u ON u.id = m.sender_user_id
`;

const buildPlaceholders = (items) => items.map(() => "?").join(", ");

const getMessages = ({ roomId, limit, before }) => {
  if (before) {
    return db
      .prepare(
        `
        ${MESSAGE_SELECT}
        WHERE m.room_id = ? AND m.deleted_at IS NULL AND m.created_at < ?
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
      ${MESSAGE_SELECT}
      WHERE m.room_id = ? AND m.deleted_at IS NULL
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
      ${MESSAGE_SELECT}
      WHERE m.room_id = ? AND m.client_message_id = ? AND m.deleted_at IS NULL
      LIMIT 1
    `
    )
    .get(roomId, clientMessageId);
};

const getMessageRecord = (roomId, messageId) => {
  return db
    .prepare(
      `
      ${MESSAGE_SELECT}
      WHERE m.room_id = ? AND m.id = ?
      LIMIT 1
    `
    )
    .get(roomId, messageId);
};

const updateMessageBody = ({ roomId, messageId, body, editedAt }) => {
  const info = db.prepare(
    `
    UPDATE messages
    SET body = ?, edited_at = ?
    WHERE room_id = ? AND id = ? AND deleted_at IS NULL
  `
  ).run(body, editedAt, roomId, messageId);

  return {
    info,
    message: info.changes ? getMessageRecord(roomId, messageId) : null
  };
};

const softDeleteMessage = ({ roomId, messageId, deletedAt }) => {
  return db.prepare(
    `
    UPDATE messages
    SET deleted_at = ?
    WHERE room_id = ? AND id = ? AND deleted_at IS NULL
  `
  ).run(deletedAt, roomId, messageId);
};

const getLastMessageForRoom = (roomId) => {
  return db
    .prepare("SELECT body, created_at FROM messages WHERE room_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1")
    .get(roomId);
};

const getLastMessagesForRooms = (roomIds) => {
  if (!Array.isArray(roomIds) || !roomIds.length) return [];
  const placeholders = buildPlaceholders(roomIds);
  return db
    .prepare(
      `
      SELECT room_id, body, created_at
      FROM (
        SELECT
          room_id,
          body,
          created_at,
          id,
          ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC, id DESC) AS rn
        FROM messages
        WHERE deleted_at IS NULL AND room_id IN (${placeholders})
      )
      WHERE rn = 1
    `
    )
    .all(...roomIds);
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
  getMessageRecord,
  updateMessageBody,
  softDeleteMessage,
  getLastMessageForRoom,
  getLastMessagesForRooms,
  cleanupRetention
};
