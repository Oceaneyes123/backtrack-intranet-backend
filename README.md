# Backtrack Chat Backend (Dev)

This Node server matches the extension's chat widget API with persistence +
Google SSO.

## Endpoints

- GET /api/chat/rooms/:room/messages?limit=50
- POST /api/chat/rooms/:room/messages
- GET /api/chat/rooms/:room/stream (SSE)
- WS /ws/chat?room=general

## Run

1. Install dependencies:
   - npm install
2. Start server:
   - Set env vars (example):
     - GOOGLE_CLIENT_ID=your-client-id
     - REQUIRE_AUTH=true
     - ALLOWED_ORIGIN=*
   - npm run dev

Default port is 8787. Set `PORT` and `ALLOWED_ORIGIN` as needed.

## Local end-to-end testing

1. Create a Google OAuth client (Web application) in GCP:
    - Open Google Cloud Console → APIs & Services → Credentials.
    - Configure OAuth consent screen (Internal or External).
    - Add scopes: openid, email, profile.
    - Create OAuth client ID → Application type: Web application.
    - Authorized redirect URIs:
       - https://<EXTENSION_ID>.chromiumapp.org/
2. Load the extension unpacked in chrome://extensions and copy the extension ID.
3. Add redirect URI: `https://ldmlhnilhhjdgichjhcjanncgfefnmdd.chromiumapp.org/`.
4. Set `GOOGLE_CLIENT_ID` in the backend environment.
5. Update manifest oauth2 `client_id` with the same value.
6. Start the backend with `REQUIRE_AUTH=true` and `ALLOWED_ORIGIN=*`.
7. In the popup, set Chat backend URL to `http://localhost:8787`.
8. Click “Sign in” in the popup and authorize the account.
9. Open the intranet page and toggle the chat widget.
10. Send a message and verify it appears in history on reload.

## Google SSO

Set the following environment variables:

- `GOOGLE_CLIENT_ID` (OAuth client ID)
- `REQUIRE_AUTH=true` to enforce auth

The server accepts an ID token via:

- `Authorization: Bearer <id_token>` header
- `?token=<id_token>` query parameter for SSE/WS

## Notes

- SQLite persistence at `DATABASE_PATH` (default ./data/chat.db).
- Retention via `MESSAGE_RETENTION_DAYS` (default 30).
- For production, use HTTPS, proper CORS origin, and hardened auth.
