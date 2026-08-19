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

export function injectSpaShim(html) {
  if (html.includes("crypto.randomUUID = function randomUUID")) return html;
  if (html.includes("<head>")) return html.replace("<head>", "<head>" + BROWSER_COMPAT_SHIM);
  return BROWSER_COMPAT_SHIM + html;
}
