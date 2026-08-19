import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchdPlist } from "../src/service-launchd.mjs";
import { systemdUnit } from "../src/service-systemd.mjs";
import { runCli } from "../src/cli.mjs";

test("launchd plist contains home and keepalive", () => {
  const plist = launchdPlist({ home: "/tmp/hub", node: "/usr/bin/node", entry: "/tmp/bin.js" });
  assert.ok(plist.includes("DSH_TEAM_HUB_HOME"));
  assert.ok(plist.includes("<key>KeepAlive</key><true/>"));
  assert.ok(plist.includes("/tmp/hub"));
});

test("systemd unit contains restart policy", () => {
  const unit = systemdUnit({ home: "/tmp/hub", node: "/usr/bin/node", entry: "/tmp/bin.js" });
  assert.ok(unit.includes("Restart=always"));
  assert.ok(unit.includes("Environment=DSH_TEAM_HUB_HOME=/tmp/hub"));
});

test("cli init creates config and initial admin", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-cli-"));
  process.env.DSH_TEAM_HUB_HOME = home;
  await runCli(["init", "--port", "3999", "alice"]);
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(config.listenPort, 3999);
  assert.deepEqual(config.users.map(u => u.name).sort(), ["admin", "alice"]);
  assert.equal(config.users.find(u => u.name === "admin").mustChangePassword, true);
  delete process.env.DSH_TEAM_HUB_HOME;
});
