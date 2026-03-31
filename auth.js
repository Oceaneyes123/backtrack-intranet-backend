import { OAuth2Client } from "google-auth-library";
import config from "./config.js";
import logger from "./logger.js";
import { getAnonymousUser, getOrCreateUserFromToken } from "./repo/users.js";

const oauthClient = config.GOOGLE_CLIENT_ID ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;
const TOKEN_VERIFY_TTL_MS = 5 * 60 * 1000;
const tokenVerifyCache = new Map();

const pruneTokenVerifyCache = (now = Date.now()) => {
  for (const [token, entry] of tokenVerifyCache) {
    if (!entry || entry.expiresAt <= now) {
      tokenVerifyCache.delete(token);
    }
  }
};

const getCacheExpiry = (payload, now = Date.now(), ttlMs = TOKEN_VERIFY_TTL_MS) => {
  const tokenExpiry = payload?.exp ? Number(payload.exp) * 1000 : Number.POSITIVE_INFINITY;
  return Math.min(tokenExpiry, now + ttlMs);
};

const createCachedVerifier = (verify, { nowFn = Date.now, ttlMs = TOKEN_VERIFY_TTL_MS } = {}) => async (token) => {
  const now = nowFn();
  const cached = tokenVerifyCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.payload;
  }
  if (cached) {
    tokenVerifyCache.delete(token);
  }

  const payload = await verify(token);
  const expiresAt = getCacheExpiry(payload, now, ttlMs);
  if (expiresAt > now) {
    tokenVerifyCache.set(token, { payload, expiresAt });
  }
  return payload;
};

const cachePruneInterval = setInterval(() => pruneTokenVerifyCache(), TOKEN_VERIFY_TTL_MS);
cachePruneInterval.unref?.();

const verifyToken = createCachedVerifier(async (token) => {
  if (!oauthClient) {
    throw new Error("Google client ID not configured.");
  }
  const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: config.GOOGLE_CLIENT_ID });
  return ticket.getPayload();
});

const extractToken = (req) => {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  // Token in query params intentionally removed — tokens must not appear in URLs.
  return null;
};

const createAuthMiddleware = ({
  requireAuth = config.REQUIRE_AUTH,
  verify = verifyToken,
  getAnonymousUserFn = getAnonymousUser,
  getOrCreateUserFromTokenFn = getOrCreateUserFromToken
} = {}) => async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    if (requireAuth) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    req.user = getAnonymousUserFn();
    next();
    return;
  }

  try {
    const payload = await verify(token);
    const user = getOrCreateUserFromTokenFn(payload);
    req.user = user;
    next();
  } catch {
    if (config.DEBUG_LOGS) {
      logger.warn("Auth token verification failed");
    }
    if (requireAuth) {
      res.status(401).json({ error: "Invalid token." });
      return;
    }
    req.user = getAnonymousUserFn();
    next();
  }
};

export { verifyToken, extractToken, createAuthMiddleware, createCachedVerifier, pruneTokenVerifyCache };
