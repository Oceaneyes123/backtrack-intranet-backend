import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_PATH = process.env.DATABASE_PATH || "./data/test-chat.db";
process.env.GOOGLE_CLIENT_ID = "";
process.env.REQUIRE_AUTH = "false";

const { extractToken, createAuthMiddleware } = await import("../auth.js");

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

test("extractToken reads bearer header and query string", () => {
  assert.equal(extractToken({ headers: { authorization: "Bearer abc" }, query: {} }), "abc");
  assert.equal(extractToken({ headers: {}, query: { token: "xyz" } }), "xyz");
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
