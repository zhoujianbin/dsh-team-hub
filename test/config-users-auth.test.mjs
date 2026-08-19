import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, saveConfig, loadConfig } from "../src/config.mjs";
import { createUser, authenticate, changePassword, setUserStatus, resetPassword } from "../src/users.mjs";
import { issueSession, resolveSession, revokeSessionsForUser } from "../src/auth.mjs";

function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-")); }

test("config validates and persists", () => {
  const home = tempHome();
  const config = defaultConfig(home);
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  createUser(config, { name: "alice", role: "member", password: "alice-pass-1" });
  saveConfig(home, config);
  const loaded = loadConfig(home).config;
  assert.equal(loaded.users.length, 2);
  assert.equal(loaded.upstream, "http://127.0.0.1:3080");
});

test("users authenticate, change passwords, disable and reset", () => {
  const config = defaultConfig(tempHome());
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  createUser(config, { name: "alice", role: "member", password: "alice-pass-1" });
  assert.equal(authenticate(config, "alice", "wrong"), null);
  assert.equal(authenticate(config, "alice", "alice-pass-1").mustChangePassword, true);
  changePassword(config, "alice", "alice-pass-1", "new-pass-123");
  assert.equal(authenticate(config, "alice", "new-pass-123").mustChangePassword, false);
  setUserStatus(config, "alice", "disabled");
  assert.equal(authenticate(config, "alice", "new-pass-123"), null);
  const reset = resetPassword(config, "alice", "reset-pass-123");
  assert.equal(reset.user.mustChangePassword, true);
});

test("cannot disable final active admin", () => {
  const config = defaultConfig(tempHome());
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  assert.throws(() => setUserStatus(config, "admin", "disabled"), /最后一个/);
});

test("sessions expire and can be revoked per user", () => {
  const home = tempHome();
  const first = issueSession(home, "alice", 1000);
  const second = issueSession(home, "bob", 1000);
  assert.equal(resolveSession(home, first.token).username, "alice");
  assert.equal(revokeSessionsForUser(home, "alice"), 1);
  assert.equal(resolveSession(home, first.token), null);
  assert.equal(resolveSession(home, second.token).username, "bob");
});
