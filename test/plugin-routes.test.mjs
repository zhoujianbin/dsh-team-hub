import test from "node:test";
import assert from "node:assert/strict";

// 从 server.mjs 导不出内部函数，这里复刻匹配逻辑做契约测试——保持两处一致。
const PREFIXES = ["/api/task-board", "/api/dsh-ssh", "/api/dsh-skill-explorer", "/api/pair", "/api/approvals", "/api/events"];
const isAdminOnly = p => PREFIXES.some(x => p === x || p.startsWith(x + "/"));

test("plugin host routes are admin-only", () => {
  assert.equal(isAdminOnly("/api/task-board/state"), true);
  assert.equal(isAdminOnly("/api/task-board"), true);
  assert.equal(isAdminOnly("/api/dsh-ssh/exec"), true);
  assert.equal(isAdminOnly("/api/dsh-skill-explorer/list"), true);
  assert.equal(isAdminOnly("/api/pair/heartbeat"), true);
});

test("core DSH routes are not caught", () => {
  assert.equal(isAdminOnly("/api/events.mux"), false);
  assert.equal(isAdminOnly("/api/events.host"), false);
  assert.equal(isAdminOnly("/api/session.list"), false);
  assert.equal(isAdminOnly("/api/workspace.list"), false);
});

test("shim hides plugin entries for members", async () => {
  const { injectSpaShim } = await import("../src/spa-shim.mjs");
  const html = injectSpaShim("<head><title>x</title>");
  assert.ok(html.includes("任务看板"));
  assert.ok(html.includes("HIDDEN_ENTRIES"));
});
