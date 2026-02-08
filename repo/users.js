import db from "../db.js";

const formatDisplayNameFromEmail = (email) => {
  if (!email) return "User";
  const handle = email.split("@")[0] || "user";
  return handle
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

const findUserByEmail = (email) => {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email);
};

const getUserByGoogleSub = (googleSub) => {
  return db.prepare("SELECT * FROM users WHERE google_sub = ?").get(googleSub);
};

const updateUserLastSeen = (userId, now) => {
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, userId);
};

const updateUserFromPending = (pendingId, payload, now) => {
  db.prepare(
    "UPDATE users SET google_sub = ?, display_name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?"
  ).run(payload.sub, payload.name || null, payload.picture || null, now, pendingId);
};

const getOrCreateUserFromToken = (payload) => {
  if (!payload?.sub) return null;
  const now = new Date().toISOString();
  const existing = getUserByGoogleSub(payload.sub);
  if (existing) {
    updateUserLastSeen(existing.id, now);
    return existing;
  }

  if (payload.email) {
    const pending = findUserByEmail(payload.email);
    if (pending && pending.google_sub?.startsWith("pending:")) {
      updateUserFromPending(pending.id, payload, now);
      return db.prepare("SELECT * FROM users WHERE id = ?").get(pending.id);
    }
  }

  const info = db
    .prepare(
      "INSERT INTO users (google_sub, email, display_name, avatar_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(payload.sub, payload.email || null, payload.name || null, payload.picture || null, now, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
};

const getOrCreatePendingUser = (email) => {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  const existing = findUserByEmail(normalized);
  if (existing) return existing;
  const now = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO users (google_sub, email, display_name, avatar_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(`pending:${normalized}`, normalized, formatDisplayNameFromEmail(normalized), null, now, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
};

const getAnonymousUser = () => {
  const existing = getUserByGoogleSub("anonymous");
  if (existing) return existing;
  const now = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO users (google_sub, email, display_name, avatar_url, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run("anonymous", "anonymous@backtrack.local", "Anonymous", null, now, now);
  return db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
};

export {
  formatDisplayNameFromEmail,
  findUserByEmail,
  getUserByGoogleSub,
  getOrCreateUserFromToken,
  getOrCreatePendingUser,
  getAnonymousUser
};
