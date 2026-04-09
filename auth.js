import { OAuth2Client } from "google-auth-library";
import config from "./config.js";
import logger from "./logger.js";
import { getAnonymousUser, getOrCreateUserFromToken, normalizeEmail } from "./repo/users.js";

const oauthClient = config.GOOGLE_CLIENT_ID ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;
const TOKEN_VERIFY_TTL_MS = 5 * 60 * 1000;
const tokenVerifyCache = new Map();

class AuthPolicyError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.name = "AuthPolicyError";
    this.status = status;
    this.cause = options.cause;
    this.code = options.code || null;
  }
}

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

const enforceTenantPolicy = (payload, { allowedDomains = config.ALLOWED_EMAIL_DOMAINS } = {}) => {
  if (payload?.email_verified !== true) {
    throw new AuthPolicyError(401, "Email not verified.", { code: "email_not_verified" });
  }

  const email = normalizeEmail(payload?.email);
  if (!email) {
    throw new AuthPolicyError(403, "Account email not permitted.", { code: "missing_email" });
  }

  if (allowedDomains.length > 0) {
    const domain = email.split("@")[1] || "";
    if (!allowedDomains.includes(domain)) {
      throw new AuthPolicyError(403, "Account domain not permitted.", { code: "domain_not_permitted" });
    }
  }

  return { ...payload, email };
};

const authenticateToken = async (
  token,
  {
    requireAuth = config.REQUIRE_AUTH,
    verify = verifyToken,
    allowedDomains = config.ALLOWED_EMAIL_DOMAINS,
    getAnonymousUserFn = getAnonymousUser,
    getOrCreateUserFromTokenFn = getOrCreateUserFromToken
  } = {}
) => {
  if (!token) {
    if (requireAuth) {
      throw new AuthPolicyError(401, "Authentication required.", { code: "missing_token" });
    }
    return getAnonymousUserFn();
  }

  try {
    const payload = await verify(token);
    const verifiedPayload = enforceTenantPolicy(payload, { allowedDomains });
    return getOrCreateUserFromTokenFn(verifiedPayload);
  } catch (error) {
    if (error instanceof AuthPolicyError) {
      if (requireAuth) throw error;
      return getAnonymousUserFn();
    }
    if (config.DEBUG_LOGS) {
      logger.warn("Auth token verification failed");
    }
    if (requireAuth) {
      throw new AuthPolicyError(401, "Invalid token.", { cause: error, code: "invalid_token" });
    }
    return getAnonymousUserFn();
  }
};

const createAuthMiddleware = ({
  requireAuth = config.REQUIRE_AUTH,
  verify = verifyToken,
  allowedDomains = config.ALLOWED_EMAIL_DOMAINS,
  getAnonymousUserFn = getAnonymousUser,
  getOrCreateUserFromTokenFn = getOrCreateUserFromToken
} = {}) => async (req, res, next) => {
  const token = extractToken(req);
  try {
    req.user = await authenticateToken(token, {
      requireAuth,
      verify,
      allowedDomains,
      getAnonymousUserFn,
      getOrCreateUserFromTokenFn
    });
    next();
  } catch (error) {
    if (error instanceof AuthPolicyError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(401).json({ error: "Invalid token." });
  }
};

export {
  AuthPolicyError,
  verifyToken,
  extractToken,
  enforceTenantPolicy,
  authenticateToken,
  createAuthMiddleware,
  createCachedVerifier,
  pruneTokenVerifyCache
};
