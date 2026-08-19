export const BROWSER_COMPAT_SHIM = `<script>
(() => {
  // DSH's unary RPC path calls crypto.randomUUID(), which browsers expose only in
  // secure contexts. LAN deployments usually use plain http://<lan-ip>, so provide
  // the same getRandomValues-based UUID implementation DSH uses elsewhere.
  try {
    if (window.crypto && typeof crypto.randomUUID !== "function" && typeof crypto.getRandomValues === "function") {
      crypto.randomUUID = function randomUUID() {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
        return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
      };
    }
  } catch {}
})();
</script>`;

export const USER_BAR_SHIM = `<script>
(async () => {
  // 右下角悬浮条：显示当前登录用户（displayName），提供退出登录。
  try {
    const res = await fetch("/__teamhub/whoami", { credentials: "same-origin" });
    if (!res.ok) return;
    const me = await res.json();
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;align-items:center;gap:8px;background:#111827;color:#fff;padding:6px 10px;border-radius:999px;font:12px -apple-system,sans-serif;box-shadow:0 2px 10px rgb(0 0 0/20%);opacity:.85";
    const label = document.createElement("span");
    label.textContent = (me.displayName || me.name) + (me.role === "admin" ? " · 管理员" : "");
    const out = document.createElement("a");
    out.href = "/logout";
    out.textContent = "退出";
    out.style.cssText = "color:#93c5fd;text-decoration:none";
    bar.append(label, out);
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(bar));
    if (document.readyState !== "loading") document.body.appendChild(bar);
  } catch {}
})();
</script>`;

export const AUTO_SELECT_SHIM = `<script>
(async () => {
  // Member 只有一个工作区：首次进入时自动在侧栏选中它，跳过"选择工作区"步骤。
  // 工作区列表已被网关过滤为本人可见，选择器里没有别的目标，也不允许新建。
  try {
    const res = await fetch("/__teamhub/whoami", { credentials: "same-origin" });
    if (!res.ok) return;
    const me = await res.json();
    if (me.role !== "member" || !me.name) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 90) return clearInterval(timer);
      const items = [...document.querySelectorAll('[role="treeitem"]')];
      if (items.length === 0) return;
      const composer = document.querySelector("textarea");
      if (composer) {
        const ph = composer.placeholder || "";
        // 占位符不再要求选工作区 = 已选中，停止；composer 还没渲染则继续等
        if (!ph.includes("选择工作区") && !ph.includes("选择一个工作区")) return clearInterval(timer);
      }
      const target = items.find(el => (el.getAttribute("aria-label") || el.textContent || "").trim() === me.name)
        || items.find(el => (el.getAttribute("aria-label") || el.textContent || "").trim().startsWith(me.name));
      if (target) target.click();
    }, 1000);
  } catch {}
})();
</script>`;

export function injectSpaShim(html) {
  if (html.includes("crypto.randomUUID = function randomUUID")) return html;
  const payload = BROWSER_COMPAT_SHIM + USER_BAR_SHIM + AUTO_SELECT_SHIM;
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + payload);
  return payload + html;
}
