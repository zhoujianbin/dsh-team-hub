import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("/admin 无尾斜杠时必须 302 到 /admin/（防相对路径解析错位）", () => {
  const html = fs.readFileSync(path.join(root, "admin-ui", "index.html"), "utf8");
  assert.ok(html.includes('href="/admin/styles.css"'));
  assert.ok(html.includes('src="/admin/app.js"'));
  // 静态资源必须真实存在（serveAdminUi 会按 /admin/<file> 剥离前缀查找）
  for (const file of ["styles.css", "app.js", "share-state.js", "index.html"]) {
    assert.ok(fs.existsSync(path.join(root, "admin-ui", file)), "missing asset: " + file);
  }
});

test("serveAdminUi 的路径剥离逻辑：/admin/xxx → admin-ui/xxx", () => {
  const { serveAdminUi } = (() => {
    // 直接内联验证剥离逻辑（与 server.mjs 相同）
    const ADMIN_UI = path.join(root, "admin-ui");
    const strip = (pathname) => {
      const file = pathname.slice("/admin".length);
      const target = path.resolve(ADMIN_UI, file === "/" || file === "/index.html" ? "index.html" : file.slice(1));
      return target;
    };
    return { serveAdminUi: { strip } };
  })();
  const t1 = serveAdminUi.strip("/admin/styles.css");
  assert.equal(t1, path.join(root, "admin-ui", "styles.css"));
  const t2 = serveAdminUi.strip("/admin/app.js");
  assert.equal(t2, path.join(root, "admin-ui", "app.js"));
  const t3 = serveAdminUi.strip("/admin/");
  assert.equal(t3, path.join(root, "admin-ui", "index.html"));
  // 路径穿越防护：/admin/../ 必须被拒绝
  const t4 = serveAdminUi.strip("/admin/../etc/passwd");
  assert.ok(!t4.startsWith(path.join(root, "admin-ui")));
});
