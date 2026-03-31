import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import http from "http";
import { randomUUID } from "node:crypto";
import config from "./config.js";
import logger from "./logger.js";
import { createAuthMiddleware, verifyToken } from "./auth.js";
import { getAnonymousUser, getOrCreateUserFromToken, getOrCreatePendingUser } from "./repo/users.js";
import { getOrCreateDirectRoom, getOrCreateRoom } from "./repo/rooms.js";
import {
  getMessages,
  insertMessage,
  insertMessageIdempotent,
  getMessageByClientId,
  getMessageRecord,
  updateMessageBody,
  softDeleteMessage,
  cleanupRetention
} from "./repo/messages.js";
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
import { requireMessageOwnership } from "./services/messages.js";
import { attachRealtime } from "./realtime.js";
import { validate, sendMessageSchema, editMessageSchema, createDirectSchema, createGroupSchema } from "./validation.js";
import db from "./db.js";

const app = express();

// S3: Trust proxy — required behind reverse proxies (Render, Heroku, nginx) so
// req.ip reflects the real client address, not the proxy.
if (config.TRUST_PROXY) {
  app.set("trust proxy", config.TRUST_PROXY === "true" ? 1 : config.TRUST_PROXY);
}

// S1: Security headers — prevent common attacks (XSS, clickjacking, MIME sniffing).
app.use(helmet({
  contentSecurityPolicy: false, // Not applicable for API-only server
  crossOriginEmbedderPolicy: false
}));

// S5: CORS origin whitelist — support comma-separated origins for multi-domain.
const parsedOrigins = config.ORIGIN === "*"
  ? "*"
  : config.ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

const corsOriginFn = parsedOrigins === "*"
  ? "*"
  : (origin, callback) => {
      if (!origin || parsedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed"));
      }
    };

app.use(cors({ origin: corsOriginFn, credentials: parsedOrigins !== "*" }));

// S2: Request body size limit — 16kb is generous for chat messages (max 4000 chars).
app.use(express.json({ limit: "16kb" }));

// I1: Structured request logging via pino.
app.use((req, res, next) => {
  req.id = randomUUID();
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    logger.info({ reqId: req.id, method: req.method, url: req.originalUrl, status: res.statusCode, durationMs }, "request");
  });
  next();
});

const rateLimitStore = new Map();

// B5: Periodically prune expired rate-limit entries to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

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

const toMessagePayload = (message) => {
  if (!message) return null;
  return {
    id: message.id,
    room_id: message.room_id,
    body: message.body,
    created_at: message.created_at,
    edited_at: message.edited_at || null,
    client_message_id: message.client_message_id || null,
    display_name: message.display_name || "User",
    email: message.email || "user@backtrack.local",
    avatar_url: message.avatar_url || null
  };
};

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

  res.json({ room: room.name, messages, lastReadAt, otherLastReadAt, unreadCount });
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
  res.json({ room: room.name, lastReadAt: now, otherLastReadAt, unreadCount });
});

app.get("/api/chat/rooms/:room/meta", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const directOther = getDirectRoomOtherUser(room.id, user.id);
  const { type, displayName } = resolveRoomDisplayName(room, directOther);
  const { lastReadAt, otherLastReadAt, unreadCount, members } = getRoomMeta(room.id, user.id);
  res.json({ room: room.name, type, displayName, members, lastReadAt, otherLastReadAt, unreadCount });
});

app.get("/api/chat/rooms/:room/members", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const members = getRoomMembers(room.id);
  res.json({ room: room.name, members });
});

app.post("/api/chat/direct", authMiddleware, validate(createDirectSchema), (req, res) => {
  const email = req.validated.email;
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

app.post("/api/chat/groups", authMiddleware, validate(createGroupSchema), (req, res) => {
  const { name: displayName, members: normalizedEmails } = req.validated;

  const requester = req.user || getAnonymousUser();
  if (config.REQUIRE_AUTH && requester.google_sub === "anonymous") {
    res.status(401).json({ error: "Authentication required." });
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

app.post("/api/chat/rooms/:room/messages", authMiddleware, validate(sendMessageSchema), (req, res) => {
  const roomName = req.params.room;
  const { body, clientMessageId } = req.validated;

  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const canonicalRoomName = room.name;
  cleanupRetention(config.MESSAGE_RETENTION_DAYS);

  const now = new Date().toISOString();
  setLastReadAt(room.id, user.id, now);

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
      res.status(200).json(toMessagePayload(existing));
      return;
    }

    const message = toMessagePayload({
      id: info.lastInsertRowid,
      room_id: room.id,
      body,
      created_at: now,
      edited_at: null,
      client_message_id: clientMessageId,
      display_name: user.display_name || "User",
      email: user.email || "user@backtrack.local",
      avatar_url: user.avatar_url || null
    });
    publish(canonicalRoomName, message);
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
  const message = toMessagePayload({
    id: info.lastInsertRowid,
    room_id: room.id,
    body,
    created_at: now,
    edited_at: null,
    client_message_id: null,
    display_name: user.display_name || "User",
    email: user.email || "user@backtrack.local",
    avatar_url: user.avatar_url || null
  });

  publish(canonicalRoomName, message);
  res.status(201).json(message);
});

app.patch("/api/chat/rooms/:room/messages/:messageId", authMiddleware, validate(editMessageSchema), (req, res) => {
  const roomName = req.params.room;
  const messageId = Number(req.params.messageId);
  const { body } = req.validated;

  if (!Number.isInteger(messageId) || messageId <= 0) {
    res.status(400).json({ error: "Invalid message id." });
    return;
  }

  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const canonicalRoomName = room.name;

  const existing = getMessageRecord(room.id, messageId);
  if (!requireMessageOwnership(existing, user, res)) return;

  if (existing.body === body) {
    res.json(toMessagePayload(existing));
    return;
  }

  const editedAt = new Date().toISOString();
  const { message } = updateMessageBody({ roomId: room.id, messageId, body, editedAt });
  if (!message) {
    res.status(404).json({ error: "Message not found." });
    return;
  }

  const payload = toMessagePayload(message);
  publish(canonicalRoomName, { type: "message.edited", room: canonicalRoomName, message: payload });
  res.json(payload);
});

app.delete("/api/chat/rooms/:room/messages/:messageId", authMiddleware, (req, res) => {
  const roomName = req.params.room;
  const messageId = Number(req.params.messageId);

  if (!Number.isInteger(messageId) || messageId <= 0) {
    res.status(400).json({ error: "Invalid message id." });
    return;
  }

  const user = req.user || getAnonymousUser();
  const room = getRoomOrCreatePublic(roomName);
  if (!requireRoomAccess(room, user, res)) return;
  const canonicalRoomName = room.name;

  const existing = getMessageRecord(room.id, messageId);
  if (!requireMessageOwnership(existing, user, res)) return;

  const deletedAt = new Date().toISOString();
  const info = softDeleteMessage({ roomId: room.id, messageId, deletedAt });
  if (!info.changes) {
    res.status(404).json({ error: "Message not found." });
    return;
  }

  publish(canonicalRoomName, {
    type: "message.deleted",
    room: canonicalRoomName,
    messageId: existing.id,
    clientMessageId: existing.client_message_id || null
  });
  res.json({ ok: true, messageId: existing.id, clientMessageId: existing.client_message_id || null });
});

// I3: Health check endpoint — unauthenticated, used by load balancers & monitoring.
app.get("/health", (req, res) => {
  let dbOk = false;
  try {
    db.prepare("SELECT 1").get();
    dbOk = true;
  } catch {}
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? "ok" : "degraded",
    uptime: Math.floor(process.uptime()),
    dbConnected: dbOk
  });
});

const server = http.createServer(app);
const { publish, shutdown: shutdownRealtime } = attachRealtime(server, app, {
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
  logger.info({ port: config.PORT }, "Chat backend listening");
});

// B4: Run retention cleanup periodically (hourly) + once at startup.
cleanupRetention(config.MESSAGE_RETENTION_DAYS);
const retentionInterval = setInterval(() => cleanupRetention(config.MESSAGE_RETENTION_DAYS), 60 * 60 * 1000);

// I2: Graceful shutdown — drain connections, flush WAL, close DB.
const gracefulShutdown = (signal) => {
  logger.info({ signal }, "Shutdown signal received — draining");
  clearInterval(retentionInterval);
  server.close(() => {
    shutdownRealtime();
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    } catch {}
    logger.info("Shutdown complete");
    process.exit(0);
  });
  // Force exit after 10 seconds if drain doesn't finish.
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
