import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { randomUUID } from "node:crypto";
import config from "./config.js";
import { createAuthMiddleware, verifyToken } from "./auth.js";
import { getAnonymousUser, getOrCreateUserFromToken, getOrCreatePendingUser } from "./repo/users.js";
import { getOrCreateDirectRoom, getOrCreateRoom } from "./repo/rooms.js";
import { getMessages, insertMessage, insertMessageIdempotent, getMessageByClientId, cleanupRetention } from "./repo/messages.js";
import { getLastReadAt, setLastReadAt, getOtherLastReadAt, getUnreadCount } from "./repo/reads.js";
import {
  getRoomOrCreatePublic,
  requireRoomAccess,
  ensureMembership,
  listRoomsForUser,
  getRoomMeta,
  getRoomMembers,
  getDirectRoomOtherUser,
  resolveRoomDisplayName,
  isPublicRoomName,
  isMember
} from "./services/rooms.js";
import { attachRealtime } from "./realtime.js";

const app = express();
app.use(cors({ origin: config.ORIGIN, credentials: false }));
app.use(express.json({ limit: "64kb" }));

if (config.DEBUG_LOGS) {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      console.log(`[${res.statusCode}] ${req.method} ${req.originalUrl} (${durationMs}ms)`);
    });
    next();
  });
}

const rateLimitStore = new Map();
const rateLimitMiddleware = (req, res, next) => {
  if (!config.RATE_LIMIT_ENABLED) return next();
  const key = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + config.RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > config.RATE_LIMIT_MAX) {
    res.status(429).json({ error: "Rate limit exceeded." });
    return;
  }
  res.setHeader("X-RateLimit-Limit", String(config.RATE_LIMIT_MAX));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, config.RATE_LIMIT_MAX - entry.count)));
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
  next();
};

if (config.RATE_LIMIT_ENABLED) {
  app.use(rateLimitMiddleware);
}

const authMiddleware = createAuthMiddleware();

app.get("/api/chat/rooms", authMiddleware, (req, res) => {
  const user = req.user || getAnonymousUser();
  const rooms = listRoomsForUser(user);
  res.json({ rooms });
});

app.get("/api/chat/rooms/:room/messages", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const before = req.query.before ? String(req.query.before) : null;
  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const lastReadAt = getLastReadAt(room.id, user.id);
  const otherLastReadAt = getOtherLastReadAt(room.id, user.id);
  const unreadCount = getUnreadCount(room.id, user.id, lastReadAt);
  const messages = getMessages({ roomId: room.id, limit, before });

  res.json({ room: roomName, messages, lastReadAt, otherLastReadAt, unreadCount });
});

app.post("/api/chat/rooms/:room/read", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const now = new Date().toISOString();
  setLastReadAt(room.id, user.id, now);
  const otherLastReadAt = getOtherLastReadAt(room.id, user.id);
  const unreadCount = getUnreadCount(room.id, user.id, now);
  res.json({ room: roomName, lastReadAt: now, otherLastReadAt, unreadCount });
});

app.get("/api/chat/rooms/:room/meta", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const directOther = getDirectRoomOtherUser(room.id, user.id);
  const { type, displayName } = resolveRoomDisplayName(room, directOther);
  const { lastReadAt, otherLastReadAt, unreadCount, members } = getRoomMeta(room.id, user.id);
  res.json({ room: roomName, type, displayName, members, lastReadAt, otherLastReadAt, unreadCount });
});

app.get("/api/chat/rooms/:room/members", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const members = getRoomMembers(room.id);
  res.json({ room: roomName, members });
});

app.post("/api/chat/direct", authMiddleware, (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) {
    res.status(400).json({ error: "Email required." });
    return;
  }
  const requester = req.user || getAnonymousUser();
  if (config.REQUIRE_AUTH && requester.google_sub === "anonymous") {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const targetUser = getOrCreatePendingUser(email);
  if (!targetUser) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  const room = getOrCreateDirectRoom(requester.id, targetUser.id);
  ensureMembership(room.id, requester.id);
  ensureMembership(room.id, targetUser.id);
  res.json({ room: room.name });
});

app.post("/api/chat/groups", authMiddleware, (req, res) => {
  const displayName = String(req.body?.name || "").trim();
  const members = Array.isArray(req.body?.members) ? req.body.members : [];

  const requester = req.user || getAnonymousUser();
  if (config.REQUIRE_AUTH && requester.google_sub === "anonymous") {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  if (!displayName) {
    res.status(400).json({ error: "Group name required." });
    return;
  }

  const normalizedEmails = members
    .map((e) => String(e || "").trim().toLowerCase())
    .filter(Boolean);

  if (normalizedEmails.length < 2) {
    res.status(400).json({ error: "At least two members required." });
    return;
  }

  const roomName = `group:${randomUUID()}`;
  const room = getOrCreateRoom(roomName, displayName);
  const roomId = room?.id;
  if (!roomId) {
    res.status(500).json({ error: "Failed to create group." });
    return;
  }

  ensureMembership(roomId, requester.id);
  normalizedEmails.forEach((email) => {
    const u = getOrCreatePendingUser(email);
    if (u) ensureMembership(roomId, u.id);
  });

  res.status(201).json({ room: roomName, name: displayName });
});

app.post("/api/chat/rooms/:room/messages", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const body = String(req.body?.body || "").trim();
  if (!body) {
    res.status(400).json({ error: "Message body required." });
    return;
  }

  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  cleanupRetention(config.MESSAGE_RETENTION_DAYS);

  const now = new Date().toISOString();
  setLastReadAt(room.id, user.id, now);

  const clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : null;

  if (clientMessageId) {
    const info = insertMessageIdempotent({
      roomId: room.id,
      userId: user.id,
      body,
      createdAt: now,
      clientMessageId
    });
    if (info.changes === 0) {
      const existing = getMessageByClientId(room.id, clientMessageId);
      if (!existing) {
        res.status(409).json({ error: "Duplicate message id." });
        return;
      }
      res.status(200).json(existing);
      return;
    }

    const message = {
      id: info.lastInsertRowid,
      room_id: room.id,
      body,
      created_at: now,
      client_message_id: clientMessageId,
      display_name: user.display_name || "User",
      email: user.email || "user@backtrack.local",
      avatar_url: user.avatar_url || null
    };
    publish(roomName, message);
    res.status(201).json(message);
    return;
  }

  const info = insertMessage({
    roomId: room.id,
    userId: user.id,
    body,
    createdAt: now,
    clientMessageId: null
  });
  const message = {
    id: info.lastInsertRowid,
    room_id: room.id,
    body,
    created_at: now,
    client_message_id: null,
    display_name: user.display_name || "User",
    email: user.email || "user@backtrack.local",
    avatar_url: user.avatar_url || null
  };

  publish(roomName, message);
  res.status(201).json(message);
});

const server = http.createServer(app);
const { publish } = attachRealtime(server, app, {
  ORIGIN: config.ORIGIN,
  REQUIRE_AUTH: config.REQUIRE_AUTH,
  authMiddleware,
  verifyToken,
  getAnonymousUser,
  getOrCreateUserFromToken,
  getRoomOrCreatePublic,
  isPublicRoomName,
  ensureMembership,
  isMember,
  requireRoomAccess
});

server.listen(config.PORT, () => {
  console.log(`Chat backend listening on http://localhost:${config.PORT}`);
});
