import test from "node:test";
import assert from "node:assert/strict";

const { getMessageMutationError } = await import("../services/messages.js");

test("getMessageMutationError rejects deleted or missing messages", () => {
  assert.deepEqual(getMessageMutationError(null, { id: 1, google_sub: "user-1" }), {
    status: 404,
    error: "Message not found."
  });
  assert.deepEqual(getMessageMutationError({ deleted_at: new Date().toISOString(), sender_user_id: 1 }, { id: 1, google_sub: "user-1" }), {
    status: 404,
    error: "Message not found."
  });
});

test("getMessageMutationError requires an authenticated non-anonymous owner", () => {
  assert.deepEqual(getMessageMutationError({ deleted_at: null, sender_user_id: 1 }, { id: 1, google_sub: "anonymous" }), {
    status: 401,
    error: "Authentication required."
  });
  assert.deepEqual(getMessageMutationError({ deleted_at: null, sender_user_id: 1 }, { id: 2, google_sub: "user-2" }), {
    status: 403,
    error: "Forbidden."
  });
  assert.equal(getMessageMutationError({ deleted_at: null, sender_user_id: 1 }, { id: 1, google_sub: "user-1" }), null);
});