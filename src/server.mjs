import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig, saveConfig } from "./config.mjs";
import { authenticate, changePassword, publicUser } from "./users.mjs";
import { parseCookies, resolveSession, issueSession, revokeSession } from "./auth.mjs";
import { AuditLog } from "./audit.mjs";
import { createAdminApi } from "./admin-api.mjs";
import { createOwnership, guardMemberRequest, filterMemberResponse, learnWorkspace, learnSession } from "./policy.mjs";
import { upstreamRpc } from "./upstream.mjs";
import { filterHostFrame, filterMuxFrame, isAllowedClientFrame } from "./ws-filter.mjs";
import { injectSpaShim } from "./spa-shim.mjs";
import { compatibilityReport } from "./compat.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_UI = path.join(ROOT, "admin-ui");
const COOKIE = "dsh_team_hub_session";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"]);

// 插件注册的宿主级 HTTP 路由：只对 admin 开放（GET/POST/WS 全拦）。
// 精确匹配或路径边界匹配，避免误伤 /api/events.mux 等核心路由。
const ADMIN_ONLY_ROUTE_PREFIXES = [
  "/api/task-board",
  "/api/dsh-ssh",
  "/api/dsh-skill-explorer",
  "/api/pair",
  "/api/approvals",
  "/api/events", // dsh-remote-web-ui 的 SSE（注意不带 .mux/.host 后缀）
];

function isAdminOnlyRoute(pathname) {
  return ADMIN_ONLY_ROUTE_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(text);
}

async function collect(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function loginPage(next = "/", error = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-team-hub 登录</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;display:grid;place-items:center;min-height:100vh}form{background:white;padding:32px;border-radius:14px;box-shadow:0 8px 30px rgb(0 0 0/8%);display:grid;gap:14px;width:320px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #d1d5db}button{background:#111827;color:white;border:0}.error{color:#b91c1c}</style></head>
<body><form method="post" action="/login"><h1>dsh-team-hub</h1><input type="hidden" name="next" value="${next}"><input name="username" placeholder="用户名" autocomplete="username" required><input name="password" type="password" placeholder="密码" autocomplete="current-password" required>${error ? `<p class="error">${error}</p>` : ""}<button>登录</button></form></body></html>`;
}

function changePasswordPage(error = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>修改密码</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;display:grid;place-items:center;min-height:100vh}form{background:white;padding:32px;border-radius:14px;box-shadow:0 8px 30px rgb(0 0 0/8%);display:grid;gap:14px;width:340px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #d1d5db}button{background:#111827;color:white;border:0}.error{color:#b91c1c}</style></head>
<body><form method="post" action="/change-password"><h1>首次登录，请修改密码</h1><input name="current" type="password" placeholder="当前密码" required><input name="next" type="password" placeholder="新密码（至少 8 位）" required>${error ? `<p class="error">${error}</p>` : ""}<button>保存并继续</button></form></body></html>`;
}

async function proxyRequest(config, req, res, { bodyOverride, injectShim = false } = {}) {
  const upstream = new URL(config.upstream);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(key)) headers[key] = value;
  headers.host = upstream.host;
  // DSH 的自定义路由（如插件注册的 /api/task-board/state）会校验 Origin。
  // 上游只接受自己的源——网关已做认证，这里把 Origin/Referer 统一改写成上游源。
  headers.origin = upstream.origin;
  if (typeof headers.referer === "string") {
    const reqOrigin = new URL(req.url, "http://local").origin;
    headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, upstream.origin);
  }
  const body = bodyOverride !== undefined ? bodyOverride : ["GET", "HEAD"].includes(req.method) ? undefined : await collect(req);
  const response = await fetch(config.upstream + req.url, { method: req.method, headers, body, redirect: "manual" });
  const outHeaders = {};
  for (const [key, value] of response.headers.entries()) if (!HOP_BY_HOP.has(key)) outHeaders[key] = value;
  let out = Buffer.from(await response.arrayBuffer());
  if (injectShim && (outHeaders["content-type"] || "").includes("text/html")) {
    out = Buffer.from(injectSpaShim(out.toString("utf8")));
    delete outHeaders["content-length"];
  }
  res.writeHead(response.status, outHeaders);
  res.end(out);
}

function rpcError(res, rpcId, code, message, status = 200) {
  send(res, status, { type: "server-response", rpcId, result: { ok: false, error: { code, message } } });
}

async function refreshOwnership(context) {
  try {
    const workspaces = await upstreamRpc(context.config, "workspace.list", {});
    for (const view of workspaces.items || []) learnWorkspace(context.config, context.ownership, view);
    const sessions = await upstreamRpc(context.config, "session.list", {});
    for (const row of sessions.items || []) learnSession(context.config, context.ownership, row.sessionId, row.cwd, null);
  } catch (error) {
    context.audit.write("system.ownership-refresh-failed", { error: error.message });
  }
}

async function ensureMemberWorkspaces(context) {
  for (const user of context.config.users) {
    if (user.role !== "member" || (user.status || "active") !== "active") continue;
    const root = path.join(context.config.workspaceRoot, user.name);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const existing = [...context.ownership.workspaceOwner.entries()].find(([, owner]) => owner === user.name);
    if (existing) continue;
    try {
      const created = await upstreamRpc(context.config, "workspace.create", { path: root });
      learnWorkspace(context.config, context.ownership, created.workspace);
      if (created.workspace.title !== user.name) {
        const renamed = await upstreamRpc(context.config, "workspace.rename", { workspaceId: created.workspace.workspaceId, title: user.name });
        learnWorkspace(context.config, context.ownership, renamed.workspace);
      }
      context.audit.write("workspace.created", { user: user.name });
    } catch (error) {
      context.audit.write("workspace.create-failed", { user: user.name, error: error.message });
    }
  }
}

async function handleApiPost(context, user, req, res, method) {
  const raw = await collect(req);
  let message;
  try { message = JSON.parse(raw.toString("utf8")); } catch { return rpcError(res, null, "bad-request", "invalid JSON", 400); }
  const { rpcId, payload } = message;
  if (user.role === "admin") return proxyRequest(context.config, req, res, { bodyOverride: raw });
  const guard = guardMemberRequest({ config: context.config, ownership: context.ownership, user, method, payload });
  if (!guard.ok) {
    context.audit.write("policy.denied", { user: user.name, method, reason: guard.message });
    return rpcError(res, rpcId, "forbidden", guard.message);
  }
  const upstream = new URL(context.config.upstream);
  const response = await fetch(`${context.config.upstream}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: upstream.host },
    body: JSON.stringify({ ...message, payload: guard.payload })
  });
  const body = await response.json();
  if (body.result?.ok) body.result.value = filterMemberResponse({ ownership: context.ownership, user, method, value: body.result.value });
  context.audit.write("policy.allowed", { user: user.name, method });
  send(res, response.status, body, { "content-type": "application/json" });
}

async function handleAdminApi(context, req, res, pathname, query) {
  const api = context.adminApi;
  if (req.method === "GET" && pathname === "/overview") return send(res, 200, api.overview());
  if (req.method === "GET" && pathname === "/users") return send(res, 200, api.users());
  if (req.method === "POST" && pathname === "/users") {
    const body = JSON.parse((await collect(req)).toString("utf8") || "{}");
    return send(res, 200, api.createUser(body));
  }
  const statusMatch = pathname.match(/^\/users\/([^/]+)\/status$/);
  if (req.method === "POST" && statusMatch) {
    const body = JSON.parse((await collect(req)).toString("utf8") || "{}");
    return send(res, 200, api.setUserStatus(decodeURIComponent(statusMatch[1]), body.status));
  }
  const resetMatch = pathname.match(/^\/users\/([^/]+)\/reset-password$/);
  if (req.method === "POST" && resetMatch) return send(res, 200, api.resetPassword(decodeURIComponent(resetMatch[1])));
  const nameMatch = pathname.match(/^\/users\/([^/]+)\/display-name$/);
  if (req.method === "POST" && nameMatch) {
    const body = JSON.parse((await collect(req)).toString("utf8") || "{}");
    return send(res, 200, api.setDisplayName(decodeURIComponent(nameMatch[1]), body.displayName));
  }
  if (req.method === "GET" && pathname === "/workspaces") return send(res, 200, api.workspaces());
  if (req.method === "GET" && pathname === "/debug/ownership") return send(res, 200, api.ownershipDebug());
  if (req.method === "GET" && pathname === "/audit") return send(res, 200, api.audit({ limit: Number(query.get("limit") || 200), user: query.get("user"), type: query.get("type") }));
  if (req.method === "GET" && pathname === "/system") return send(res, 200, { upstream: context.config.upstream, users: context.config.users.length, node: process.version });
  if (req.method === "POST" && pathname === "/selftest") return send(res, 200, await compatibilityReport(context.config));
  send(res, 404, { error: "not found" });
}

function serveAdminUi(res, pathname) {
  const file = pathname === "/" || pathname === "/index.html" ? "index.html" : pathname.slice(1);
  const target = path.resolve(ADMIN_UI, file);
  if (!target.startsWith(ADMIN_UI) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
  send(res, 200, fs.readFileSync(target), { "content-type": type + "; charset=utf-8" });
  return true;
}

export async function startServer() {
  const { home, file: configFile, config } = loadConfig();
  let configMtime = fs.statSync(configFile).mtimeMs;
  const context = {
    home,
    config,
    ownership: createOwnership(),
    audit: new AuditLog(home),
    adminApi: null
  };
  // CLI（user add/disable 等）直接改 config.json；运行中的网关需要在下次请求时感知。
  let ensuring = false;
  function reloadConfigIfChanged() {
    try {
      const mtime = fs.statSync(configFile).mtimeMs;
      if (mtime === configMtime) return;
      configMtime = mtime;
      context.config = loadConfig(home).config;
      context.audit.write("system.config-reloaded", {});
      // 新增的成员需要就地建工作区，否则要等下次重启
      if (!ensuring) {
        ensuring = true;
        ensureMemberWorkspaces(context).finally(() => { ensuring = false; });
      }
    } catch {}
  }
  context.adminApi = createAdminApi({
    home,
    getConfig: () => context.config,
    save: next => { context.config = next; saveConfig(home, next); },
    ownership: context.ownership,
    audit: context.audit
  });
  await refreshOwnership(context);
  await ensureMemberWorkspaces(context);

  const server = http.createServer(async (req, res) => {
    try {
      reloadConfigIfChanged();
      const url = new URL(req.url, "http://local");
      const cookies = parseCookies(req);
      const session = resolveSession(home, cookies[COOKIE]);
      const user = session && context.config.users.find(u => u.name === session.username && (u.status || "active") === "active");

      if (url.pathname === "/login" && req.method === "GET") return send(res, 200, loginPage(url.searchParams.get("next") || "/"), { "content-type": "text/html; charset=utf-8" });
      if (url.pathname === "/login" && req.method === "POST") {
        const form = new URLSearchParams((await collect(req)).toString("utf8"));
        const found = authenticate(context.config, String(form.get("username") || ""), String(form.get("password") || ""));
        if (!found) {
          context.audit.write("auth.login-failed", { user: String(form.get("username") || "") });
          return send(res, 401, loginPage(String(form.get("next") || "/"), "用户名或密码错误"), { "content-type": "text/html; charset=utf-8" });
        }
        const issued = issueSession(home, found.name);
        context.audit.write("auth.login", { user: found.name });
        const next = found.mustChangePassword ? "/change-password" : String(form.get("next") || "/");
        return send(res, 302, "", { location: next, "set-cookie": `${COOKIE}=${encodeURIComponent(issued.token)}; Path=/; HttpOnly; SameSite=Lax` });
      }
      if (url.pathname === "/logout") {
        revokeSession(home, cookies[COOKIE]);
        context.audit.write("auth.logout", { user: session?.username || "" });
        return send(res, 302, "", { location: "/login", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
      if (!user) {
        if (url.pathname.startsWith("/api/")) return rpcError(res, null, "unauthorized", "not logged in", 401);
        return send(res, 302, "", { location: "/login?next=" + encodeURIComponent(req.url) });
      }
      if (url.pathname === "/__teamhub/whoami") {
        return send(res, 200, { name: user.name, displayName: user.displayName || user.name, role: user.role });
      }
      if (user.mustChangePassword && url.pathname !== "/change-password") return send(res, 302, "", { location: "/change-password" });
      if (url.pathname === "/change-password") {
        if (req.method === "GET") return send(res, 200, changePasswordPage(), { "content-type": "text/html; charset=utf-8" });
        const form = new URLSearchParams((await collect(req)).toString("utf8"));
        try {
          changePassword(context.config, user.name, String(form.get("current") || ""), String(form.get("next") || ""));
          saveConfig(home, context.config);
          context.audit.write("auth.password-changed", { user: user.name });
          return send(res, 302, "", { location: "/" });
        } catch (error) { return send(res, 400, changePasswordPage(error.message), { "content-type": "text/html; charset=utf-8" }); }
      }
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
        if (user.role !== "admin") return send(res, 403, "admin only");
        return serveAdminUi(res, url.pathname === "/admin" ? "/" : url.pathname.slice("/admin".length)) || send(res, 404, "not found");
      }
      if (url.pathname.startsWith("/__teamhub/api/")) {
        if (user.role !== "admin") return send(res, 403, { error: "admin only" });
        return handleAdminApi(context, req, res, url.pathname.slice("/__teamhub/api".length), url.searchParams);
      }
      if (user.role !== "admin" && isAdminOnlyRoute(url.pathname)) {
        context.audit.write("policy.denied", { user: user.name, method: "route:" + url.pathname, reason: "插件宿主路由仅 admin 可用" });
        return send(res, 403, { error: "admin only" });
      }
      if (url.pathname.startsWith("/api/") && req.method === "POST") return handleApiPost(context, user, req, res, url.pathname.slice("/api/".length));
      return proxyRequest(context.config, req, res, { injectShim: url.pathname === "/" || url.pathname === "/index.html" });
    } catch (error) {
      context.audit.write("system.request-error", { error: error.message });
      send(res, 500, { error: error.message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    reloadConfigIfChanged();
    const cookies = parseCookies(req);
    const session = resolveSession(home, cookies[COOKIE]);
    const user = session && context.config.users.find(u => u.name === session.username && (u.status || "active") === "active");
    if (!user) { socket.destroy(); return; }
    const url = new URL(req.url, "http://local");
    const stream = url.pathname === "/api/events.mux" ? "mux" : url.pathname === "/api/events.host" ? "host" : null;
    if (!stream) { socket.destroy(); return; }
    if (user.mustChangePassword) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, downstream => {
      const upstreamUrl = new URL(context.config.upstream);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      upstreamUrl.pathname = url.pathname;
      const upstream = new WebSocket(upstreamUrl);
      const pending = [];
      const answerable = new Set();
      upstream.on("open", () => pending.splice(0).forEach(data => upstream.send(data)));
      // 注意：DSH 协议全部使用文本帧。ws 库 send(Buffer) 会发二进制帧，
      // DSH 客户端会把二进制帧当作畸形帧丢弃——必须按原始帧类型转发。
      downstream.on("message", (data, isBinary) => {
        if (user.role === "member") {
          if (isBinary) return;
          try {
            const frame = JSON.parse(data.toString("utf8"));
            if (!isAllowedClientFrame({ ownership: context.ownership, user, frame, answerable })) {
              context.audit.write("ws.client-frame-denied", { user: user.name, stream });
              return;
            }
          } catch { return; }
        }
        const out = isBinary ? data : data.toString("utf8");
        if (upstream.readyState === WebSocket.OPEN) upstream.send(out); else pending.push(out);
      });
      upstream.on("message", (data, isBinary) => {
        if (user.role === "member") {
          if (isBinary) return;
          let frame;
          try {
            frame = JSON.parse(data.toString("utf8"));
            const allowed = stream === "mux"
              ? filterMuxFrame({ ownership: context.ownership, user, frame, answerable, onUnknown: type => context.audit.write("ws.unknown-mux-frame", { type }) })
              : filterHostFrame({ config: context.config, ownership: context.ownership, user, frame, onUnknown: type => context.audit.write("ws.unknown-host-frame", { type }) });
            if (!allowed) {
              context.audit.write("ws.frame-dropped", {
                user: user.name, stream,
                frameType: frame?.payload?.type || "unknown",
                sessionId: frame?.payload?.sessionId || "",
                mappedOwner: frame?.payload?.sessionId ? (context.ownership.sessionOwner.get(frame.payload.sessionId) || "unknown") : ""
              });
              return;
            }
          } catch { return; }
          downstream.send(JSON.stringify(frame));
          return;
        }
        downstream.send(isBinary ? data : data.toString("utf8"));
      });
      downstream.on("close", () => upstream.close());
      upstream.on("close", () => downstream.close());
    });
  });

  await new Promise(resolve => server.listen(config.listenPort, config.listenHost, resolve));
  console.log(`dsh-team-hub listening on http://${config.listenHost}:${config.listenPort}`);
  console.log(`Admin console: http://${config.listenHost}:${config.listenPort}/admin`);
}
