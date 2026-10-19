import test from "node:test";
import assert from "node:assert/strict";
import { createShareState, moveShareMembers } from "../admin-ui/share-state.js";

const users = [
  { name: "alice", displayName: "Alice" },
  { name: "bob", displayName: "Bob" },
  { name: "carol", displayName: "Carol" },
  { name: "admin", displayName: "Admin" }
];

test("share picker excludes the owner and unknown grants from both columns", () => {
  const state = createShareState(users, "alice", ["bob", "mallory", "bob"]);
  assert.deepEqual(state.candidates.map(user => user.name), ["bob", "carol", "admin"]);
  assert.deepEqual(state.granted, ["bob"]);
  assert.deepEqual(state.available, ["carol", "admin"]);
});

test("share picker moves selected members in both directions and keeps candidate order", () => {
  const state = createShareState(users, "alice", []);
  const granted = moveShareMembers(state, "grant", ["carol", "bob", "unknown"]);
  assert.deepEqual(granted.granted, ["bob", "carol"]);
  assert.deepEqual(granted.available, ["admin"]);
  const restored = moveShareMembers(granted, "revoke", ["bob"]);
  assert.deepEqual(restored.granted, ["carol"]);
  assert.deepEqual(restored.available, ["bob", "admin"]);
  assert.equal(moveShareMembers(restored, "revoke", ["admin"]), restored, "no-op moves keep the state");
});

test("share picker ignores names that are already on the target side", () => {
  const state = createShareState(users, "alice", ["bob"]);
  assert.equal(moveShareMembers(state, "grant", ["bob"]), state);
  assert.equal(moveShareMembers(state, "revoke", ["carol"]), state);
});
