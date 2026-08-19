import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("package metadata is ready for public npm distribution", () => {
  assert.equal(pkg.name, "dsh-team-hub");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.bin["dsh-team-hub"], "./bin/dsh-team-hub.js");
  assert.ok(pkg.files.includes("src"));
  assert.ok(pkg.files.includes("admin-ui"));
  assert.ok(!pkg.files.includes("legacy-gateway.mjs"));
});

test("sensitive runtime files are ignored", () => {
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const pattern of ["config.json", "sessions.json", "logs/", "workspaces/", "shared/"]) {
    assert.ok(ignore.includes(pattern), pattern);
  }
});
