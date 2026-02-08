import { OAuth2Client } from "google-auth-library";
import config from "./config.js";
import { getAnonymousUser, getOrCreateUserFromToken } from "./repo/users.js";

const oauthClient = config.GOOGLE_CLIENT_ID ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;

const verifyToken = async (token) => {
  if (!oauthClient) {
    throw new Error("Google client ID not configured.");
  }
  const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: config.GOOGLE_CLIENT_ID });
  return ticket.getPayload();
};

const extractToken = (req) => {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (req.query?.token) {
    return String(req.query.token);
  }
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
    if (requireAuth) {
      res.status(401).json({ error: "Invalid token." });
      return;
    }
    req.user = getAnonymousUserFn();
    next();
  }
};

export { verifyToken, extractToken, createAuthMiddleware };
