import test from "node:test";
import assert from "node:assert/strict";
import { createOwnership, guardMemberRequest, filterMemberResponse, learnWorkspace, learnSession } from "../src/policy.mjs";
import { defaultConfig } from "../src/config.mjs";
import { createUser } from "../src/users.mjs";

function fixture() {
  const config = defaultConfig("/tmp/dsh-team-hub-test");
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  createUser(config, { name: "alice", role: "member", password: "alice-pass-1" });
  createUser(config, { name: "bob", role: "member", password: "bob-pass-123" });
  const ownership = createOwnership();
  learnWorkspace(config, ownership, { workspaceId: "wa", path: "/tmp/dsh-team-hub-test/workspaces/alice", sessionIds: ["sa"] });
  learnWorkspace(config, ownership, { workspaceId: "wb", path: "/tmp/dsh-team-hub-test/workspaces/bob", sessionIds: ["sb"] });
  return { config, ownership, alice: config.users[1], bob: config.users[2] };
}

test("member can list only own workspaces and sessions", () => {
  const { ownership, alice } = fixture();
  const value = filterMemberResponse({ ownership, user: alice, method: "workspace.list", value: {
    items: [{ workspaceId: "wa" }, { workspaceId: "wb" }], archivedSessionIds: ["sa", "sb"]
  }});
  assert.deepEqual(value.items, [{ workspaceId: "wa" }]);
  assert.deepEqual(value.archivedSessionIds, ["sa"]);
});

test("member cannot use another member session", () => {
  const { config, ownership, alice } = fixture();
  const result = guardMemberRequest({ config, ownership, user: alice, method: "session.prompt", payload: { sessionId: "sb", text: "x" } });
  assert.equal(result.ok, false);
});

test("session.create defaults to own workspace", () => {
  const { config, ownership, alice } = fixture();
  const result = guardMemberRequest({ config, ownership, user: alice, method: "session.create", payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.payload.workspaceId, "wa");
});

test("unknown or privileged methods are denied", () => {
  const { config, ownership, alice } = fixture();
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "settings.describe", payload: {} }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "future.method", payload: {} }).ok, false);
});

test("ui-onboarding settings mutation is the only settings exception", () => {
  const { config, ownership, alice } = fixture();
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "settings.mutate", payload: { ns: "ui-onboarding", ops: [] } }).ok, true);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "settings.mutate", payload: { ns: "llm", ops: [] } }).ok, false);
});

test("cwd ownership is based on member workspace roots", () => {
  const { config, ownership } = fixture();
  learnSession(config, ownership, "s2", "/tmp/dsh-team-hub-test/workspaces/bob/project", null);
  assert.equal(ownership.sessionOwner.get("s2"), "bob");
});
