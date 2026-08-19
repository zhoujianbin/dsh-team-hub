import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { issueSession, resolveSession, revokeSession } from "../src/auth.mjs";
import { defaultConfig } from "../src/config.mjs";
import { createUser, setDisplayName, publicUser } from "../src/users.mjs";
import { injectSpaShim } from "../src/spa-shim.mjs";

test("logout revokes only the current session token", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-logout-"));
  const a = issueSession(home, "lilei");
  const b = issueSession(home, "lilei");
  assert.equal(revokeSession(home, a.token), true);
  assert.equal(resolveSession(home, a.token), null);
  assert.equal(resolveSession(home, b.token).username, "lilei");
});

test("displayName is editable and exposed in public view", () => {
  const config = defaultConfig("/tmp/dth-dn");
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  createUser(config, { name: "lilei", role: "member", password: "lilei-pass-1" });
  assert.equal(publicUser(config.users[1]).displayName, "lilei");
  setDisplayName(config, "lilei", "李雷");
  assert.equal(publicUser(config.users[1]).displayName, "李雷");
  assert.throws(() => setDisplayName(config, "lilei", ""), /显示名/);
});

test("spa shim includes user bar with logout and whoami", () => {
  const html = injectSpaShim("<head><title>x</title>");
  assert.ok(html.includes("/__teamhub/whoami"));
  assert.ok(html.includes("/logout"));
});
