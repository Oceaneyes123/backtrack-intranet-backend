import { WebSocketServer } from "ws";
import config from "./config.js";

const attachRealtime = (server, app, deps) => {
  const {
    ORIGIN,
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
        res.write(`data: ${payload}\n\n`);
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

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": ORIGIN
    });
    res.write("retry: 3000\n\n");

    addSseSubscriber(roomId, res);

    if (config.DEBUG_LOGS) {
      console.log(`[sse] connected room=${roomId} user=${user?.id || "unknown"}`);
    }

    req.on("close", () => {
      removeSseSubscriber(roomId, res);
      if (config.DEBUG_LOGS) {
        console.log(`[sse] disconnected room=${roomId} user=${user?.id || "unknown"}`);
      }
    });
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
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const tokenQuery = url.searchParams.get("token");
    if (tokenQuery) return tokenQuery;

    const header = String(req.headers["sec-websocket-protocol"] || "");
    // Header format: "proto1, proto2, proto3"
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
          console.warn("[ws] auth failed");
        }
        socket.destroy();
      });
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const roomId = url.searchParams.get("room") || "general";
    const room = getRoomOrCreatePublic(roomId);
    if (!room) {
      ws.close(1008, "Room not found");
      return;
    }
    const user = ws.user || getAnonymousUser();
    if (isPublicRoomName(room.name)) {
      ensureMembership(room.id, user.id);
    } else if (!isMember(room.id, user.id)) {
      ws.close(1008, "Forbidden");
      return;
    }

    const roomSubscribers = getSubscriberSet(roomId);
    roomSubscribers.add(ws);

    if (config.DEBUG_LOGS) {
      console.log(`[ws] connected room=${roomId} user=${user?.id || "unknown"}`);
    }

    ws.on("close", () => {
      roomSubscribers.delete(ws);
      if (config.DEBUG_LOGS) {
        console.log(`[ws] disconnected room=${roomId} user=${user?.id || "unknown"}`);
      }
    });
  });

  return { publish };
};

export { attachRealtime };
