import test from "node:test";
import assert from "node:assert/strict";
import { createOwnership } from "../src/policy.mjs";
import { defaultConfig } from "../src/config.mjs";
import { createUser } from "../src/users.mjs";
import { filterMuxFrame, filterHostFrame, isAllowedClientFrame } from "../src/ws-filter.mjs";

function fixture() {
  const config = defaultConfig("/tmp/dsh-team-hub-ws");
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  createUser(config, { name: "alice", role: "member", password: "alice-pass-1" });
  const ownership = createOwnership();
  ownership.sessionOwner.set("sa", "alice");
  ownership.sessionOwner.set("sb", "bob");
  ownership.workspaceOwner.set("wa", "alice");
  ownership.workspaceOwner.set("wb", "bob");
  return { config, ownership, user: config.users[1] };
}

test("mux frames are limited to owned sessions", () => {
  const { ownership, user } = fixture();
  const answerable = new Set();
  assert.equal(filterMuxFrame({ ownership, user, answerable, frame: { payload: { type: "session/event", sessionId: "sa" } } }), true);
  assert.equal(filterMuxFrame({ ownership, user, answerable, frame: { payload: { type: "session/event", sessionId: "sb" } } }), false);
});

test("approval request becomes answerable only for owner", () => {
  const { ownership, user } = fixture();
  const answerable = new Set();
  assert.equal(filterMuxFrame({ ownership, user, answerable, frame: { rpcId: "r1", payload: { type: "approval/requested", sessionId: "sa" } } }), true);
  assert.equal(answerable.has("r1"), true);
  assert.equal(filterMuxFrame({ ownership, user, answerable, frame: { rpcId: "r2", payload: { type: "approval/requested", sessionId: "sb" } } }), false);
  assert.equal(answerable.has("r2"), false);
});

test("host order frames are filtered in place", () => {
  const { config, ownership, user } = fixture();
  const frame = { payload: { type: "host/workspace-order-changed", workspaceIds: ["wa", "wb"] } };
  assert.equal(filterHostFrame({ config, ownership, user, frame }), true);
  assert.deepEqual(frame.payload.workspaceIds, ["wa"]);
});

test("unknown frames are dropped", () => {
  const { config, ownership, user } = fixture();
  let unknown = "";
  assert.equal(filterHostFrame({ config, ownership, user, frame: { payload: { type: "host/future" } }, onUnknown: t => unknown = t }), false);
  assert.equal(unknown, "host/future");
});

test("client can only answer registered approval ids", () => {
  const { ownership, user } = fixture();
  const answerable = new Set(["r1"]);
  assert.equal(isAllowedClientFrame({ ownership, user, answerable, frame: { type: "client-request", rpcId: "r1", method: "respond", payload: {} } }), true);
  assert.equal(isAllowedClientFrame({ ownership, user, answerable, frame: { type: "client-request", rpcId: "r2", method: "respond", payload: {} } }), false);
  assert.equal(isAllowedClientFrame({ ownership, user, answerable, frame: { type: "client-request", rpcId: "r3", method: "session/subscribe", payload: { sessionId: "sb" } } }), false);
});
