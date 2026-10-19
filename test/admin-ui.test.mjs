import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("admin UI is zero-build and uses namespaced API", () => {
  const html = fs.readFileSync(path.join(root, "admin-ui", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "admin-ui", "app.js"), "utf8");
  assert.ok(app.includes('/__teamhub/api'));
  assert.ok(!html.includes("cdn."));
});

test("admin workspace sharing uses a two-column picker instead of free-text usernames", () => {
  const app = fs.readFileSync(path.join(root, "admin-ui", "app.js"), "utf8");
  assert.ok(app.includes('role="dialog"'), "sharing must open a modal dialog");
  assert.ok(app.includes('data-list="granted"') && app.includes('data-list="available"'), "dialog must render two member columns");
  assert.ok(app.includes('data-move="grant" aria-label="授权所选成员" title="授权所选成员" disabled>←</button>'),
    "the left arrow must grant the selected right-column member");
  assert.ok(app.includes('data-move="revoke" aria-label="移除所选成员的权限" title="移除所选成员的权限" disabled>→</button>'),
    "the right arrow must revoke the selected left-column member");
  assert.ok(!app.includes("prompt(`设置"), "sharing must not ask the administrator to type usernames");
});

test("admin UI references assets via absolute /admin/ paths (no relative-path misresolution)", () => {
  const html = fs.readFileSync(path.join(root, "admin-ui", "index.html"), "utf8");
  assert.ok(html.includes('href="/admin/styles.css"'), "stylesheet must use absolute /admin/ path");
  assert.ok(html.includes('src="/admin/app.js"'), "script must use absolute /admin/ path");
  assert.ok(!html.includes("./styles.css") && !html.includes("./app.js"), "no relative asset refs");
});
