import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, saveConfig } from "../src/config.mjs";
import { createUser } from "../src/users.mjs";

test("server module exposes startServer", async () => {
  const mod = await import("../src/server.mjs");
  assert.equal(typeof mod.startServer, "function");
});

test("config for server can be saved in isolated home", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-server-"));
  const config = defaultConfig(home);
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  saveConfig(home, config);
  assert.ok(fs.existsSync(path.join(home, "config.json")));
});
