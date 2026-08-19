import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "../src/audit.mjs";
import { createAdminApi } from "../src/admin-api.mjs";
import { defaultConfig, saveConfig } from "../src/config.mjs";
import { createUser } from "../src/users.mjs";
import { createOwnership } from "../src/policy.mjs";

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-admin-")); }

test("audit redacts secrets and queries newest first", () => {
  const dir = home();
  const audit = new AuditLog(dir);
  audit.write("auth.login", { user: "alice", password: "secret", token: "abc" });
  audit.write("policy.denied", { user: "alice", method: "settings.describe" });
  const rows = audit.query({ user: "alice" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "policy.denied");
  assert.equal(rows[1].password, "[redacted]");
  assert.equal(rows[1].token, "[redacted]");
});

test("admin API manages users and audits operations", () => {
  const dir = home();
  const config = defaultConfig(dir);
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  saveConfig(dir, config);
  const audit = new AuditLog(dir);
  let current = config;
  const api = createAdminApi({
    home: dir,
    getConfig: () => current,
    save: next => { current = next; saveConfig(dir, next); },
    ownership: createOwnership(),
    audit
  });
  const created = api.createUser({ name: "alice", role: "member" });
  assert.equal(created.user.mustChangePassword, true);
  assert.equal(created.initialPassword.length >= 8, true);
  api.setUserStatus("alice", "disabled");
  assert.equal(api.users().find(u => u.name === "alice").status, "disabled");
  const reset = api.resetPassword("alice");
  assert.equal(reset.user.mustChangePassword, true);
  const actions = audit.query({}).map(row => row.type);
  assert.ok(actions.includes("admin.user-created"));
  assert.ok(actions.includes("admin.user-status"));
  assert.ok(actions.includes("admin.password-reset"));
});
