# Backtrack Chat Backend

Node.js/Express REST API and WebSocket server with SQLite persistence and Google SSO authentication. Powers the real-time chat widget in the [Backtrack Intranet Extension](../README.md).

---

## Tech Stack

| Package | Version | Purpose |
|---------|---------|---------|
| [Express](https://expressjs.com/) | 4.22 | HTTP server & routing |
| [ws](https://github.com/websockets/ws) | 8.18 | WebSocket server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 11.3 | Synchronous SQLite driver |
| [pino](https://getpino.io/) | 10.3 | Structured JSON logging |
| [helmet](https://helmetjs.github.io/) | 8.1 | Security headers |
| [zod](https://zod.dev/) | 4.3 | Request body validation |
| [google-auth-library](https://github.com/googleapis/google-auth-library-nodejs) | 9.10 | Google OAuth2 token verification |
| [cors](https://github.com/expressjs/cors) | 2.8 | CORS middleware |

---

## Quick Start

```bash
cd backend
npm install

# Create .env (see Environment Variables below)
cp .env.example .env   # or create manually

npm run dev             # starts with nodemon on port 8787
```

Available scripts:

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `nodemon server.js` | Development server with auto-reload |
| `start` | `node server.js` | Production server |
| `test` | `node --test ...` | Run all tests (backend + chat widget) |

---

## Environment Variables

All variables are loaded from `.env` via [dotenv](https://github.com/motdotla/dotenv). See `config.js` for the source of truth.

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `PORT` | `8787` | HTTP server port |
| `ORIGIN` | `*` | Allowed CORS origins. Comma-separated list in production (e.g. `https://sites.google.com,https://example.com`). **Must not be `*` in production.** |
| `DATABASE_PATH` | `./data/chat.db` | SQLite database file path |
| `GOOGLE_CLIENT_ID` | — | Google OAuth2 client ID. **Required in production when auth is enabled.** |
| `REQUIRE_AUTH` | `false` | Enforce authentication on all endpoints. **Must be `true` in production.** |
| `MESSAGE_RETENTION_DAYS` | `30` | Auto-delete messages older than this |
| `MAX_MESSAGE_LENGTH` | `4000` | Maximum message body length (characters) |
| `RATE_LIMIT_ENABLED` | `false` | Enable per-IP rate limiting |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit time window (ms) |
| `RATE_LIMIT_MAX` | `120` | Max requests per window per IP |
| `DEBUG_LOGS` | `false` | Enable debug-level log output |
| `WS_HEARTBEAT_INTERVAL_MS` | `30000` | WebSocket ping interval (ms) |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers (set to `true` behind a reverse proxy) |

### Production validation

When `NODE_ENV=production`, the server exits on startup if:
- `ORIGIN` is `*`
- `REQUIRE_AUTH` is `false`
- `REQUIRE_AUTH` is `true` but `GOOGLE_CLIENT_ID` is empty

---

## API Reference

All `/api/chat/*` endpoints require authentication when `REQUIRE_AUTH=true`. The token is sent via the `Authorization: Bearer <id_token>` header.

### Health Check

```
GET /health
```

Returns `200` with `{ "status": "ok" }` if the database is reachable.

### Rooms

```
GET /api/chat/rooms
```

Lists all rooms the authenticated user is a member of, including unread counts and last-message previews.

### Messages

```
GET /api/chat/rooms/:room/messages?limit=50&before=<iso_timestamp>
```

Fetches messages for a room. Supports cursor-based pagination via `before`. `limit` range: 1–200, default 50.

```
POST /api/chat/rooms/:room/messages
Content-Type: application/json

{
  "body": "Hello!",
  "clientMessageId": "optional-uuid-for-idempotency"
}
```

Sends a message. `body` is required (1–4000 characters). `clientMessageId` enables idempotent sends — duplicate `(room_id, clientMessageId)` pairs return the existing message instead of creating a new one.

### Read Receipts

```
POST /api/chat/rooms/:room/read
```

Marks the room as read for the authenticated user. Returns updated unread count and the other user's last-read timestamp (for DMs).

### Room Metadata

```
GET /api/chat/rooms/:room/meta
```

Returns room display name, member list, unread count, and read timestamps.

### Room Members

```
GET /api/chat/rooms/:room/members
```

Lists all members of a room with their user details.

### Create Direct Message

```
POST /api/chat/direct
Content-Type: application/json

{
  "email": "colleague@backtrack.com"
}
```

Creates or retrieves a DM room with the specified user. If the user doesn't exist yet, a pending user record is created.

### Create Group Chat

```
POST /api/chat/groups
Content-Type: application/json

{
  "displayName": "Project Alpha",
  "memberEmails": ["alice@backtrack.com", "bob@backtrack.com"]
}
```

Creates a new group room. Requires a display name (1–100 characters) and at least 2 member emails. The creator is automatically included.

### Server-Sent Events (SSE)

```
GET /api/chat/rooms/:room/stream
```

Opens a persistent SSE connection. Receives `message` events as JSON. Used as a fallback when WebSocket is unavailable.

### WebSocket

```
ws://<host>/ws/chat?room=<room_name>
Sec-WebSocket-Protocol: bt-chat-v1, bt-auth.<id_token>
```

Opens a real-time WebSocket connection for a room. Authentication is done via the `sec-websocket-protocol` header — tokens are **never** sent as query parameters. The server sends JSON-encoded message events and performs heartbeat pings every 30 seconds (configurable).

---

## Authentication

### Google OAuth2 (OIDC)

1. The Chrome extension obtains an ID token via `chrome.identity.launchWebAuthFlow()`
2. The token is sent to the backend in the `Authorization: Bearer <id_token>` header
3. The backend verifies the token with Google's public keys using `google-auth-library`
4. On first login, a user record is created (upserted by Google `sub` claim)
5. For WebSocket connections, the token is passed via the `sec-websocket-protocol` header as `bt-auth.<token>`

Tokens are never stored server-side. Each request is verified independently.

---

## Database

SQLite with WAL (Write-Ahead Logging) mode and foreign keys enabled.

### Schema (6 tables)

| Table | Purpose |
|-------|---------|
| `users` | User profiles (Google sub, email, display name, avatar) |
| `rooms` | Chat rooms (general, DM, group) with unique names |
| `direct_rooms` | Maps DM rooms to user pairs (unique constraint) |
| `room_memberships` | Room ↔ user membership with join timestamp |
| `room_reads` | Per-user last-read timestamp per room |
| `messages` | Message content, timestamps, idempotency key, attachment placeholder |

### Key indexes

- `idx_messages_room_created` — fast message pagination by room
- `idx_messages_sender_created` — messages by sender
- `idx_messages_room_client_message_id` — unique partial index for idempotent sends

### Retention

Messages older than `MESSAGE_RETENTION_DAYS` are automatically deleted when new messages are sent.

---

## Realtime

### WebSocket

- **Endpoint:** `ws://<host>/ws/chat?room=<room_name>`
- **Protocol:** `bt-chat-v1`
- **Auth:** Token in `sec-websocket-protocol` header (`bt-auth.<token>`)
- **Heartbeat:** Ping every `WS_HEARTBEAT_INTERVAL_MS` (default 30s). Connections that don't respond with pong are terminated.
- Room-scoped: each connection is bound to one room. Messages are broadcast only to connections in the same room.

### SSE (Fallback)

- **Endpoint:** `GET /api/chat/rooms/:room/stream`
- **Headers:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`
- Used when WebSocket is blocked by network restrictions.

---

## Security

| Layer | Implementation |
|-------|---------------|
| **Headers** | Helmet sets security headers (HSTS, X-Content-Type-Options, etc.). CSP is disabled for this API-only server. |
| **CORS** | Origin whitelist via `ORIGIN` env var. Supports comma-separated origins. `*` is rejected in production. |
| **Input validation** | Zod schemas validate all POST request bodies (message body length, email format, member list size). |
| **Body size limit** | 16 KB max request body via Express. |
| **Rate limiting** | Optional per-IP rate limiting (configurable window and max requests). |
| **Trust proxy** | Configurable via `TRUST_PROXY` for deployments behind reverse proxies (Render, nginx, etc.). |
| **Token handling** | Tokens accepted only in headers, never in URLs. No server-side token storage. |

---

## Logging

Structured JSON logging via [Pino](https://getpino.io/).

- **Development:** pretty-printed output via `pino-pretty`
- **Production:** raw JSON lines (suitable for log aggregation services)
- **Request logging:** every HTTP request is logged with a unique request ID, method, URL, status code, and response time
- **Log level:** `debug` when `DEBUG_LOGS=true`, otherwise `info`

---

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` signals:

1. Stops accepting new HTTP connections
2. Closes all active WebSocket connections
3. Clears the heartbeat interval
4. Performs a SQLite WAL checkpoint (flushes pending writes)
5. Exits cleanly

This ensures zero data loss during deployments on platforms like Render.

---

## Testing

```bash
cd backend
npm test
```

Runs **24 tests** (18 backend + 6 chat widget utility tests) using Node.js built-in test runner:

| Suite | Tests | Coverage |
|-------|-------|----------|
| `auth.test.js` | 5 | Token extraction, auth middleware, anonymous fallback |
| `messages.test.js` | 3 | Idempotent sends, pagination, retention cleanup |
| `reads.test.js` | 1 | Unread count tracking |
| `rooms-access.test.js` | 3 | Public/private room access, membership enforcement |
| `list-rooms.test.js` | 1 | Room listing with DM rooms |
| `room-meta.test.js` | 2 | Metadata and display name resolution |
| `users.test.js` | 3 | Pending users, token upgrade, anonymous reuse |
| `utils.test.js` | 6 | Sanitize, slugify, initials, message keys, JWT decode |

Tests use an in-memory SQLite database and run sequentially (`--test-concurrency=1`).

---

## Production Deployment

The backend is deployed on [Render](https://render.com).

### Required environment variables

```env
NODE_ENV=production
GOOGLE_CLIENT_ID=<your-oauth-client-id>
REQUIRE_AUTH=true
ORIGIN=https://sites.google.com
TRUST_PROXY=true
```

### Checklist

- [ ] `ORIGIN` is set to the exact origin(s) of the intranet pages
- [ ] `REQUIRE_AUTH=true`
- [ ] `GOOGLE_CLIENT_ID` matches the extension's `manifest.json` OAuth client ID
- [ ] `TRUST_PROXY=true` (Render terminates TLS at the proxy)
- [ ] `DATABASE_PATH` points to a persistent disk location
- [ ] HTTPS is enforced (handled by Render)

---

## Google SSO Setup

Step-by-step setup for Google OAuth2:

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**
2. Configure the **OAuth consent screen**:
   - User type: Internal (for Workspace) or External
   - Add scopes: `openid`, `email`, `profile`
3. Create an **OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: `https://<EXTENSION_ID>.chromiumapp.org/`
4. Copy the **Client ID**
5. Set `GOOGLE_CLIENT_ID` in the backend `.env`
6. Set the same Client ID in the extension's `manifest.json` → `oauth2.client_id`
7. Load the extension in Chrome, copy the extension ID from `chrome://extensions`
8. Add the redirect URI with the real extension ID to the OAuth client
9. Start the backend with `REQUIRE_AUTH=true`
10. Click **Sign In** in the extension popup and authorize

---

## Roadmap

Planned improvements and future features:

- **Message edit & delete** — endpoints and WS events for modifying/removing messages
- **Full-text search** — SQLite FTS5 index for searching message content
- **Typing indicators** — WS broadcast when a user is composing
- **User presence / online status** — track and display who's online
- **Room management** — leave, invite, rename rooms; admin roles
- **File & image attachments** — upload endpoint with storage backend
- **Notification webhooks** — email digests for missed messages
- **Database migrations** — versioned schema migration framework
- **PostgreSQL migration path** — optional Postgres adapter for scale
- **Redis pub/sub** — multi-instance scaling with shared message bus
- **Integration & load tests** — end-to-end API tests and stress testing
- **CI/CD pipeline** — automated testing and deployment on push

---

## License

Internal use only — Backtrack.
