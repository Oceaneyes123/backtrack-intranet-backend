import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { extractToken, createAuthMiddleware, createCachedVerifier } = await import("../auth.js");

const runMiddleware = async (middleware, reqOverrides = {}) => {
  const req = { headers: {}, query: {}, ...reqOverrides };
  const res = {
    statusCode: 200,
    jsonBody: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.jsonBody = body; }
  };
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
};

test("extractToken reads bearer header only", () => {
  assert.equal(extractToken({ headers: { authorization: "Bearer abc" }, query: {} }), "abc");
  // Token in query params intentionally unsupported (security: tokens must not appear in URLs).
  assert.equal(extractToken({ headers: {}, query: { token: "xyz" } }), null);
  assert.equal(extractToken({ headers: {}, query: {} }), null);
});

test("auth middleware enforces REQUIRE_AUTH when missing token", async () => {
  const middleware = createAuthMiddleware({
    requireAuth: true,
    verify: async () => ({}),
    getAnonymousUserFn: () => ({ id: "anon" }),
    getOrCreateUserFromTokenFn: () => ({ id: "user" })
  });
  const { res, nextCalled } = await runMiddleware(middleware);
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("auth middleware allows anonymous when auth is optional", async () => {
  const middleware = createAuthMiddleware({
    requireAuth: false,
    verify: async () => ({}),
    getAnonymousUserFn: () => ({ id: "anon" }),
    getOrCreateUserFromTokenFn: () => ({ id: "user" })
  });
  const { req, res, nextCalled } = await runMiddleware(middleware);
  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, true);
  assert.equal(req.user.id, "anon");
});

test("auth middleware rejects invalid token when required", async () => {
  const middleware = createAuthMiddleware({
    requireAuth: true,
    verify: async () => { throw new Error("bad"); },
    getAnonymousUserFn: () => ({ id: "anon" }),
    getOrCreateUserFromTokenFn: () => ({ id: "user" })
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    headers: { authorization: "Bearer nope" }
  });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("auth middleware falls back to anonymous when optional and invalid token", async () => {
  const middleware = createAuthMiddleware({
    requireAuth: false,
    verify: async () => { throw new Error("bad"); },
    getAnonymousUserFn: () => ({ id: "anon" }),
    getOrCreateUserFromTokenFn: () => ({ id: "user" })
  });
  const { req, res, nextCalled } = await runMiddleware(middleware, {
    headers: { authorization: "Bearer nope" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(nextCalled, true);
  assert.equal(req.user.id, "anon");
});

test("createCachedVerifier reuses successful token verification results until expiry", async () => {
  let now = 1_000;
  let calls = 0;
  const verify = createCachedVerifier(async (token) => {
    calls += 1;
    return { sub: token, exp: 10_000 };
  }, { nowFn: () => now, ttlMs: 5_000 });

  const first = await verify("cached-token");
  const second = await verify("cached-token");
  assert.equal(first.sub, "cached-token");
  assert.equal(second.sub, "cached-token");
  assert.equal(calls, 1);

  now = 7_000;
  const third = await verify("cached-token");
  assert.equal(third.sub, "cached-token");
  assert.equal(calls, 2);
});

test("createCachedVerifier does not cache failed verifications", async () => {
  let calls = 0;
  const verify = createCachedVerifier(async () => {
    calls += 1;
    throw new Error("bad token");
  }, { nowFn: () => 1_000, ttlMs: 5_000 });

  await assert.rejects(() => verify("bad-token"), /bad token/);
  await assert.rejects(() => verify("bad-token"), /bad token/);
  assert.equal(calls, 2);
});
