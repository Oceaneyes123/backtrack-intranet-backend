import { WebSocketServer } from "ws";
import config from "./config.js";
import logger from "./logger.js";

const HEARTBEAT_INTERVAL = config.WS_HEARTBEAT_INTERVAL_MS || 30_000;
const SSE_HEARTBEAT_INTERVAL = Math.max(10_000, Math.floor(HEARTBEAT_INTERVAL / 2));
const parsedOrigins = config.ORIGIN === "*"
  ? "*"
  : config.ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);

const getSseAllowOrigin = (requestOrigin) => {
  if (parsedOrigins === "*") return "*";
  if (requestOrigin && parsedOrigins.includes(requestOrigin)) return requestOrigin;
  return parsedOrigins.length === 1 ? parsedOrigins[0] : null;
};

const attachRealtime = (server, app, deps) => {
  const {
    REQUIRE_AUTH,
    authMiddleware,
    verifyToken,
    getAnonymousUser,
    getOrCreateUserFromToken,
    getRoomOrCreatePublic,
    isPublicRoomName,
    ensureMembership,
    isMember,
    requireRoomAccess
  } = deps;

  const subscribers = new Map();
  const sseSubscribers = new Map();

  const isClosedSseResponse = (res) => (
    !res
    || res.writableEnded
    || res.destroyed
    || res.socket?.destroyed
  );

  const getSubscriberSet = (roomId) => {
    const normalized = roomId || "general";
    if (!subscribers.has(normalized)) {
      subscribers.set(normalized, new Set());
    }
    return subscribers.get(normalized);
  };

  const publish = (roomId, message) => {
    const payload = JSON.stringify(message);
    const wsSet = getSubscriberSet(roomId);
    wsSet.forEach((client) => {
      if (client.readyState === 1) {
        client.send(payload);
      }
    });

    const sseClients = sseSubscribers.get(roomId);
    if (sseClients) {
      sseClients.forEach((res) => {
        if (isClosedSseResponse(res)) {
          removeSseSubscriber(roomId, res);
          return;
        }
        try {
          res.write(`data: ${payload}\n\n`);
        } catch {
          removeSseSubscriber(roomId, res);
        }
      });
    }
  };

  const addSseSubscriber = (roomId, res) => {
    if (!sseSubscribers.has(roomId)) {
      sseSubscribers.set(roomId, new Set());
    }
    sseSubscribers.get(roomId).add(res);
  };

  const removeSseSubscriber = (roomId, res) => {
    const set = sseSubscribers.get(roomId);
    if (!set) return;
    set.delete(res);
    if (!set.size) {
      sseSubscribers.delete(roomId);
    }
  };

  app.get("/api/chat/rooms/:room/stream", authMiddleware, (req, res) => {
    const roomId = req.params.room;
    const user = req.user || getAnonymousUser();
    const room = getRoomOrCreatePublic(roomId);
    if (!requireRoomAccess(room, user, res)) return;
    const canonicalRoomName = room.name;

    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    };
    const allowOrigin = getSseAllowOrigin(req.headers.origin);
    if (allowOrigin) {
      headers["Access-Control-Allow-Origin"] = allowOrigin;
      headers.Vary = "Origin";
    }
    res.writeHead(200, headers);
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    addSseSubscriber(canonicalRoomName, res);

    const heartbeat = setInterval(() => {
      if (isClosedSseResponse(res)) {
        removeSseSubscriber(canonicalRoomName, res);
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        removeSseSubscriber(canonicalRoomName, res);
        clearInterval(heartbeat);
      }
    }, SSE_HEARTBEAT_INTERVAL);

    if (config.DEBUG_LOGS) {
      logger.debug({ roomId: canonicalRoomName, userId: user?.id }, "sse connected");
    }

    const cleanup = () => {
      removeSseSubscriber(canonicalRoomName, res);
      clearInterval(heartbeat);
      if (config.DEBUG_LOGS) {
        logger.debug({ roomId: canonicalRoomName, userId: user?.id }, "sse disconnected");
      }
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      if (protocols && protocols.has("bt-chat-v1")) return "bt-chat-v1";
      const first = protocols?.values ? protocols.values().next()?.value : null;
      return first || false;
    }
  });

  const extractWsToken = (req) => {
    // Token extraction via subprotocol header only — query params intentionally unsupported.
    const header = String(req.headers["sec-websocket-protocol"] || "");
    const parts = header
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const auth = parts.find((p) => p.startsWith("bt-auth."));
    if (!auth) return null;
    return auth.slice("bt-auth.".length);
  };

  const verifyWsConnection = async (req) => {
    const token = extractWsToken(req);
    if (!token) {
      if (REQUIRE_AUTH) throw new Error("Authentication required");
      return getAnonymousUser();
    }
    try {
      const payload = await verifyToken(token);
      return getOrCreateUserFromToken(payload);
    } catch (error) {
      if (REQUIRE_AUTH) throw error;
      return getAnonymousUser();
    }
  };

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws/chat")) {
      socket.destroy();
      return;
    }

    verifyWsConnection(req)
      .then((user) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.user = user;
          wss.emit("connection", ws, req);
        });
      })
      .catch(() => {
        if (config.DEBUG_LOGS) {
          logger.warn("ws auth failed");
        }
        socket.destroy();
      });
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const roomRef = url.searchParams.get("room") || "general";
    const room = getRoomOrCreatePublic(roomRef);
    if (!room) {
      ws.close(1008, "Room not found");
      return;
    }
    const canonicalRoomName = room.name;
    const user = ws.user || getAnonymousUser();
    if (isPublicRoomName(room.name)) {
      ensureMembership(room.id, user.id);
    } else if (!isMember(room.id, user.id)) {
      ws.close(1008, "Forbidden");
      return;
    }

    const roomSubscribers = getSubscriberSet(canonicalRoomName);
    roomSubscribers.add(ws);

    if (config.DEBUG_LOGS) {
      logger.debug({ roomId: canonicalRoomName, userId: user?.id }, "ws connected");
    }

    ws.on("close", () => {
      roomSubscribers.delete(ws);
      if (config.DEBUG_LOGS) {
        logger.debug({ roomId: canonicalRoomName, userId: user?.id }, "ws disconnected");
      }
    });

    // B6: Mark alive on pong.
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });

  // B6: Heartbeat interval — ping all clients, terminate dead sockets.
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on("close", () => clearInterval(heartbeatInterval));

  // I2: Shutdown helper — close all WS connections and clear intervals.
  const shutdown = () => {
    clearInterval(heartbeatInterval);
    wss.clients.forEach((ws) => {
      try { ws.close(1001, "Server shutting down"); } catch {}
    });
    wss.close();
  };

  return { publish, shutdown };
};

export { attachRealtime };
