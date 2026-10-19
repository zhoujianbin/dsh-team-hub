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
import { findDshRoot, applySettingsPatch, settingsPatchStatus } from "./patch.mjs";
import { filterHostFrame, filterMuxFrame, isAllowedClientFrame } from "./ws-filter.mjs";
import { injectSpaShim } from "./spa-shim.mjs";
import { compatibilityReport, workspaceBaseline } from "./compat.mjs";
import { DshBrowserAuth } from "./dsh-browser-auth.mjs";
import { memberWelcomeSettings } from "./member-settings.mjs";
import { guardRemoteClientFrame, filterRemoteServerFrame, consumeMemberEventResult, settleMemberEventResult } from "./remote-stream-policy.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_UI = path.join(ROOT, "admin-ui");
const COOKIE = "dsh_team_hub_session";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "content-encoding"]);

function emptyMemberUsageOverview(now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10);
  const totals = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, cost: 0 });
  const period = { from: date, to: date, totals: totals(), providers: [] };
  return {
    updatedAt: now,
    providers: [],
    current: null,
    usage: {
      today: { date, totals: totals(), providers: [] },
      days: [],
      range: period,
      availableDays: [],
      all: { ...period, totals: totals() },
      observedSpend: { cny: 0, since: now }
    }
  };
}

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

function isMemberStaticRoute(pathname, search = "") {
  // DSH 0.2 preloads client plugins via /plugins/??<module>/client.js&rev=<hash>.
  // This is a static client bundle, not a Host plugin API; restrict the full
  // URL to module names and revision hashes before forwarding it.
  if (pathname === "/plugins/" && /^\?\?[A-Za-z0-9@._/-]+\/client\.js(?:&[A-Za-z0-9@._/,-]+\/client\.js)*&rev=[a-f0-9]{12}$/.test(search) &&
      !search.includes("..")) return true;
  return pathname === "/" || pathname === "/index.html" || pathname === "/favicon.ico" || pathname === "/favicon.svg" || pathname === "/favicon-dark.svg" || pathname === "/manifest.webmanifest"
    || /^\/assets\/[A-Za-z0-9_./-]+\.(?:js|css|png|jpe?g|webp|svg|ico|woff2?|ttf|map)$/.test(pathname)
      && !pathname.split("/").includes("..")
    || /^\/plugins\/[A-Za-z0-9_./-]+\.(?:js|css|json|png|jpe?g|webp|svg|ico|woff2?|ttf|map)$/.test(pathname)
      && !pathname.split("/").includes("..");
}

function isAdminOnlyRoute(pathname) {
  const canonical = pathname.startsWith("/remote/api/") ? pathname.slice("/remote".length) : pathname;
  return ADMIN_ONLY_ROUTE_PREFIXES.some(p => canonical === p || canonical.startsWith(p + "/"));
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(text);
}

async function collect(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("request exceeds 8 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") &&
    !next.includes("\\") && !/[\x00-\x1f\x7f]/.test(next)
    ? next : "/";
}
function escapeHtmlAttribute(value) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function loginPage(next = "/", error = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-team-hub 登录</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;display:grid;place-items:center;min-height:100vh}form{background:white;padding:32px;border-radius:14px;box-shadow:0 8px 30px rgb(0 0 0/8%);display:grid;gap:14px;width:320px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #d1d5db}button{background:#111827;color:white;border:0}.error{color:#b91c1c}</style></head>
<body><form method="post" action="/login"><h1>dsh-team-hub</h1><input type="hidden" name="next" value="${escapeHtmlAttribute(safeNext(next))}"><input name="username" placeholder="用户名" autocomplete="username" required><input name="password" type="password" placeholder="密码" autocomplete="current-password" required>${error ? `<p class="error">${escapeHtmlAttribute(error)}</p>` : ""}<button>登录</button></form></body></html>`;
}

function changePasswordPage(error = "") {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>修改密码</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f3f4f6;display:grid;place-items:center;min-height:100vh}form{background:white;padding:32px;border-radius:14px;box-shadow:0 8px 30px rgb(0 0 0/8%);display:grid;gap:14px;width:340px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #d1d5db}button{background:#111827;color:white;border:0}.error{color:#b91c1c}</style></head>
<body><form method="post" action="/change-password"><h1>首次登录，请修改密码</h1><input name="current" type="password" placeholder="当前密码" required><input name="next" type="password" placeholder="新密码（至少 8 位）" required>${error ? `<p class="error">${escapeHtmlAttribute(error)}</p>` : ""}<button>保存并继续</button></form></body></html>`;
}

async function proxyRequest(context, req, res, { bodyOverride, injectShim = false } = {}) {
  const config = context.config;
  const upstream = new URL(config.upstream);
  const upstreamUrl = new URL(req.url, config.upstream);
  const loginNonce = injectShim && upstreamUrl.searchParams.size === 1 && /^\d{10,16}$/.test(upstreamUrl.searchParams.get("teamhub-login") || "");
  if (upstreamUrl.origin !== upstream.origin || upstreamUrl.searchParams.has("token") || (injectShim && upstreamUrl.search && !loginNonce)) return send(res, 400, "invalid upstream URL");
  if (loginNonce) upstreamUrl.search = "";
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(key) && !["cookie", "authorization", "x-dsh-web-token"].includes(key)) headers[key] = value;
  headers.host = upstream.host;
  const cookie = await context.browserAuth.cookieHeader();
  if (cookie) headers.cookie = cookie;
  // DSH 的自定义路由（如插件注册的 /api/task-board/state）会校验 Origin。
  // 上游只接受自己的源——网关已做认证，这里把 Origin/Referer 统一改写成上游源。
  headers.origin = upstream.origin;
  delete headers.referer;
  const body = bodyOverride !== undefined ? bodyOverride : ["GET", "HEAD"].includes(req.method) ? undefined : await collect(req);
  const response = await fetch(upstreamUrl, { method: req.method, headers, body, redirect: "manual" });
  if (response.status === 401) context.browserAuth.invalidate();
  const outHeaders = {};
  for (const [key, value] of response.headers.entries()) if (!HOP_BY_HOP.has(key) && key !== "set-cookie") outHeaders[key] = value;
  if (outHeaders.location) {
    const target = new URL(outHeaders.location, upstream);
    if (!outHeaders.location.startsWith("/") || outHeaders.location.startsWith("//") || target.origin !== upstream.origin || target.searchParams.has("token")) return send(res, 502, "unsafe upstream redirect");
  }
  let out = Buffer.from(await response.arrayBuffer());
  if (injectShim && (outHeaders["content-type"] || "").includes("text/html")) {
    out = Buffer.from(injectSpaShim(out.toString("utf8")));
    delete outHeaders["content-length"];
    delete outHeaders.etag;
    delete outHeaders["last-modified"];
    outHeaders["cache-control"] = "no-store, no-cache, must-revalidate";
    outHeaders.pragma = "no-cache";
  }
  res.writeHead(response.status, outHeaders);
  res.end(out);
}

function rpcError(res, rpcId, code, message, status = 200) {
  // DSH 客户端只认识固定的错误码集合；自定义码（如 forbidden）会让客户端
  // 连错误信封都解析不了，直接弹 zod 原始错误。统一映射为 internal，消息保留。
  const CLIENT_CODES = new Set(["bad-request", "cancelled", "session-not-found", "model-unavailable", "session-conflict", "workspace-not-found", "workspace-invalid-path", "internal"]);
  const safeCode = CLIENT_CODES.has(code) ? code : "internal";
  send(res, status, { type: "server-response", rpcId, result: { ok: false, error: { code: safeCode, message, details: {} } } });
}

async function refreshOwnership(context) {
  try {
    const workspaces = await workspaceBaseline(context.config);
    const sessions = await upstreamRpc(context.config, "session/list", { args: { _request: {} } });
    if (!Array.isArray(sessions?.items)) throw new Error("session/list returned invalid inventory");
    for (const row of sessions.items) learnSession(context.config, context.ownership, row.sessionId, row.cwd, null);
    for (const view of workspaces.items) learnWorkspace(context.config, context.ownership, view);
    return true;
  } catch (error) {
    context.audit.write("system.ownership-refresh-failed", { error: error.message });
    return false;
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
      const created = await upstreamRpc(context.config, "workspace/create", { args: { request: { path: root } } });
      learnWorkspace(context.config, context.ownership, created.workspace);
      if (created.workspace.title !== user.name) {
        const renamed = await upstreamRpc(context.config, "workspace/rename", { args: { request: { workspaceId: created.workspace.workspaceId, title: user.name } } });
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
  if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(res, null, "bad-request", "invalid RPC envelope", 400);
  const { rpcId, payload } = message;
  if (user.role === "admin") return proxyRequest(context, req, res, { bodyOverride: raw });
  // DSH 0.2 RPC methods use namespace/method and a validated structured args payload.
  if (message.type !== "client-request" || typeof rpcId !== "string" || !rpcId || rpcId.length > 128 ||
      message.method !== method || !(method === "$events/result" || new RegExp("^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+$").test(method)) ||
      Object.keys(message).sort().join() !== "method,payload,rpcId,type")
    return rpcError(res, rpcId, "bad-request", "invalid DSH RPC envelope", 400);
  if (method === "settings/describe" || method === "settings/mutate") {
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 ||
        !payload.args || typeof payload.args !== "object" || Array.isArray(payload.args))
      return rpcError(res, rpcId, "bad-request", "invalid settings args", 400);
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return rpcError(res, rpcId, "forbidden", "cross-origin settings request denied");
    if (method === "settings/describe") {
      if (Object.keys(payload.args).length) return rpcError(res, rpcId, "forbidden", "settings describe accepts no args");
      return send(res, 200, { type: "server-response", rpcId, result: { ok: true, value: context.memberSettings.describe(user.name) } });
    }
    try {
      const value = context.memberSettings.mutate(user.name, payload.args);
      if (!value) return rpcError(res, rpcId, "forbidden", "member settings mutation denied");
      return send(res, 200, { type: "server-response", rpcId, result: { ok: true, value } });
    } catch { return rpcError(res, rpcId, "internal", "member preference could not be saved", 500); }
  }
  let guard;
  let eventDecision;
  if (method === "$events/result") {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return rpcError(res, rpcId, "forbidden", "cross-origin event result denied");
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !payload.args || typeof payload.args !== "object")
      return rpcError(res, rpcId, "bad-request", "invalid event result", 400);
    const candidate = context.eventClients.get(payload.args.clientId);
    if (!candidate || candidate.user !== user.name || candidate.sessionToken !== parseCookies(req)[COOKIE] ||
        candidate.socket.readyState !== WebSocket.OPEN)
      return rpcError(res, rpcId, "forbidden", "event result not delivered");
    const authorized = consumeMemberEventResult({ ownership: context.ownership, user, streams: candidate.streams, frame: payload.args });
    if (!authorized) return rpcError(res, rpcId, "forbidden", "event result not delivered");
    eventDecision = { streams: candidate.streams, frame: authorized };
    guard = { ok: true, payload: { args: authorized } };
  } else guard = guardMemberRequest({ config: context.config, ownership: context.ownership, user, method, payload });
  if (!guard.ok) {
    context.audit.write("policy.denied", { user: user.name, method, reason: guard.message });
    return rpcError(res, rpcId, "forbidden", guard.message);
  }
  try {
    const upstream = new URL(context.config.upstream);
    const dshCookie = await context.browserAuth.cookieHeader();
    const response = await fetch(`${context.config.upstream}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: upstream.host, ...(dshCookie ? { cookie: dshCookie } : {}) },
      body: JSON.stringify({ ...message, payload: guard.payload }),
      redirect: "error", signal: AbortSignal.timeout(12000)
    });
    if (response.status === 401) context.browserAuth.invalidate();
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch {
      context.audit.write("upstream.invalid-response", { user: user.name, method, status: response.status });
      return rpcError(res, rpcId, "internal", `upstream returned non-JSON (${response.status})`);
    }
    if (!body || body.type !== "server-response" || body.rpcId !== rpcId || typeof body.result?.ok !== "boolean") return rpcError(res, rpcId, "internal", "invalid upstream RPC envelope", 502);
    if (body.result.ok) {
      if (method === "$events/result") {
        if (body.result.value !== undefined) return rpcError(res, rpcId, "internal", "invalid event acknowledgment", 502);
      } else {
        try { body.result.value = filterMemberResponse({ ownership: context.ownership, user, method, value: body.result.value }); }
        catch { return rpcError(res, rpcId, "internal", "invalid upstream RPC result", 502); }
      }
    } else {
      const error = body.result.error;
      if (!error || typeof error.code !== "string" || typeof error.message !== "string") return rpcError(res, rpcId, "internal", "invalid upstream RPC error", 502);
      // Upstream errors may echo the operator home, paths or credentials. Members
      // receive a generic failure with a known DSH wire code.
      body.result.error = { code: "internal", message: "request failed", details: {} };
    }
    if (eventDecision && body.result.ok && response.ok) {
      settleMemberEventResult({ ...eventDecision, accepted: true });
      eventDecision = null;
    }
    context.audit.write("policy.allowed", { user: user.name, method });
    send(res, response.status, { type: "server-response", rpcId, result: body.result.ok
      ? { ok: true, value: body.result.value } : { ok: false, error: body.result.error } }, { "content-type": "application/json" });
  } catch {
    // Network/timeouts and invalid Host responses are not safe to echo, and
    // browser RPC callers still need a protocol-shaped error response.
    return rpcError(res, rpcId, "internal", "upstream unavailable", 502);
  } finally {
    if (eventDecision) settleMemberEventResult({ ...eventDecision, accepted: false });
  }
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
  // readFileSync 返回 Buffer，send() 会对非 string body 走 JSON.stringify，
  // 导致 admin 页面返回 {"type":"Buffer","data":[...]} 而不是 HTML（Issue #1）。
  // 显式读成 utf8 字符串，让 send 按文本发送。
  send(res, 200, fs.readFileSync(target, "utf8"), { "content-type": type + "; charset=utf-8" });
  return true;
}

export async function startServer() {
  const { home, file: configFile, config } = loadConfig();
  let configMtime = fs.statSync(configFile).mtimeMs;
  const context = {
    home,
    config,
    browserAuth: new DshBrowserAuth(config),
    ownership: createOwnership(),
    memberSettings: memberWelcomeSettings(home),
    eventClients: new Map(),
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
      context.browserAuth = new DshBrowserAuth(context.config);
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
  // 远程设置补丁：局域网/域名访问时 dsh 客户端 settings 会走 memory 模式导致
  // 「加载提供方目录失败: settings are unavailable in this browser」（Issue #2，上游
  // 0.1.1-rc.2 回归）。启动时自动把客户端强制为 host 模式（幂等）；dsh 升级覆盖
  // bundle 后，重启网关即可自动重打。找不到 dsh 目录时不阻塞启动。
  try {
    const dshRoot = findDshRoot(context.config.dshRoot);
    if (dshRoot) {
      const result = applySettingsPatch(dshRoot);
      if (result === "applied") context.audit.write("system.settings-patch-applied", { dshRoot });
      else if (result === "missing") context.audit.write("system.settings-patch-missing", { dshRoot });
    } else {
      context.audit.write("system.settings-patch-skipped", { reason: "dsh root not found" });
    }
  } catch (error) {
    context.audit.write("system.settings-patch-error", { error: error.message });
  }

  // 启动时上游可能还没就绪（比如同时重启）：后台重试直到同步成功；
  // 之后每 5 分钟兜底重同步一次，防止事件丢失导致归属表漂移。
  const syncOwnership = async () => {
    if (await refreshOwnership(context)) await ensureMemberWorkspaces(context);
  };
  await syncOwnership();
  if (context.ownership.workspaceOwner.size === 0) {
    const retry = setInterval(async () => {
      if (await refreshOwnership(context)) {
        clearInterval(retry);
        await ensureMemberWorkspaces(context);
        context.audit.write("system.ownership-refresh-recovered", {});
      }
    }, 3000);
    retry.unref?.();
  }
  const periodic = setInterval(() => { syncOwnership(); }, 5 * 60 * 1000);
  periodic.unref?.();

  const server = http.createServer(async (req, res) => {
    try {
      reloadConfigIfChanged();
      const url = new URL(req.url, "http://local");
      if (url.searchParams.has("token")) return send(res, 400, { error: "token query not accepted" });
      const cookies = parseCookies(req);
      const session = resolveSession(home, cookies[COOKIE]);
      const user = session && context.config.users.find(u => u.name === session.username && (u.status || "active") === "active");

      if (url.pathname === "/login" && req.method === "GET") return send(res, 200, loginPage(url.searchParams.get("next") || "/"), { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, no-cache, must-revalidate", pragma: "no-cache" });
      if (url.pathname === "/login" && req.method === "POST") {
        const form = new URLSearchParams((await collect(req)).toString("utf8"));
        const found = authenticate(context.config, String(form.get("username") || ""), String(form.get("password") || ""));
        if (!found) {
          context.audit.write("auth.login-failed", { user: String(form.get("username") || "") });
          return send(res, 401, loginPage(String(form.get("next") || "/"), "用户名或密码错误"), { "content-type": "text/html; charset=utf-8" });
        }
        const issued = issueSession(home, found.name);
        context.audit.write("auth.login", { user: found.name });
        const next = found.mustChangePassword ? "/change-password" : safeNext(form.get("next"));
        const location = next === "/" ? `/?teamhub-login=${Date.now()}` : next;
        return send(res, 302, "", { location, "cache-control": "no-store",
          "set-cookie": `${COOKIE}=${encodeURIComponent(issued.token)}; Path=/; HttpOnly; SameSite=Lax` });
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
        return send(res, 200, { name: user.name, displayName: user.displayName || user.name, role: user.role }, { "cache-control": "no-store" });
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
        // 无尾斜杠的 /admin 统一 302 到 /admin/：index.html 里的资源用绝对路径
        // /admin/... 引用，若直接服务 /admin 会导致相对解析错位（Issue #1 二次修复）。
        if (url.pathname === "/admin") return send(res, 302, "", { location: "/admin/" });
        return serveAdminUi(res, url.pathname.slice("/admin".length)) || send(res, 404, "not found");
      }
      if (url.pathname.startsWith("/__teamhub/api/")) {
        if (user.role !== "admin") return send(res, 403, { error: "admin only" });
        return handleAdminApi(context, req, res, url.pathname.slice("/__teamhub/api".length), url.searchParams);
      }
      if (user.role === "admin" && ["/api/pair/status", "/remote/api/pair/status"].includes(url.pathname) &&
          ["GET", "HEAD"].includes(req.method))
        return send(res, 200, { ok: true, paired: true, requirePairingForLan: false, phase: "ready",
          lanAvailable: true, lanAddresses: [], deviceCount: 1, onlineCount: 1 }, { "cache-control": "no-store" });
      if (user.role === "admin" && ["/api/pair/heartbeat", "/remote/api/pair/heartbeat"].includes(url.pathname) &&
          req.method === "POST")
        return send(res, 200, { ok: true }, { "cache-control": "no-store" });
      if (user.role !== "admin" && ["/api/dsh-usage/overview", "/remote/api/dsh-usage/overview"].includes(url.pathname) &&
          ["GET", "HEAD"].includes(req.method))
        return send(res, 200, emptyMemberUsageOverview(), { "cache-control": "no-store" });
      if (user.role !== "admin" && isAdminOnlyRoute(url.pathname)) {
        context.audit.write("policy.denied", { user: user.name, method: "route:" + url.pathname, reason: "插件宿主路由仅 admin 可用" });
        return send(res, 403, { error: "admin only" });
      }
      const memberApiPrefix = url.pathname.startsWith("/api/") ? "/api/" :
        url.pathname.startsWith("/remote/api/") ? "/remote/api/" : null;
      if (user.role !== "admin" && memberApiPrefix && req.method === "POST")
        return handleApiPost(context, user, req, res, url.pathname.slice(memberApiPrefix.length));
      if (user.role !== "admin" && !["GET", "HEAD"].includes(req.method)) return send(res, 403, { error: "member route denied" });
      if (user.role !== "admin" && !isMemberStaticRoute(url.pathname, url.search)) return send(res, 403, { error: "member route denied" });
      return proxyRequest(context, req, res, { injectShim: url.pathname === "/" || url.pathname === "/index.html" });
    } catch (error) {
      context.audit.write("system.request-error", { error: error?.name || "Error" });
      send(res, 502, { error: "upstream request failed" });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", async (req, socket, head) => {
    reloadConfigIfChanged();
    const cookies = parseCookies(req);
    const session = resolveSession(home, cookies[COOKIE]);
    const user = session && context.config.users.find(u => u.name === session.username && (u.status || "active") === "active");
    if (!user) { socket.destroy(); return; }
    const url = new URL(req.url, "http://local");
    if (url.search || url.hash) { socket.destroy(); return; }
    const stream = url.pathname === "/api/events.mux" ? "mux" : url.pathname === "/api/events.host" ? "host" :
      ["/api/remote.mux", "/remote/api/remote.mux"].includes(url.pathname) ? "remote" : null;
    if (!stream || (user.role !== "admin" && stream !== "remote")) { socket.destroy(); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { socket.destroy(); return; }
    if (user.mustChangePassword) { socket.destroy(); return; }
    let dshCookie;
    try { dshCookie = await context.browserAuth.cookieHeader(); } catch { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, downstream => {
      const upstreamUrl = new URL(context.config.upstream);
      upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
      upstreamUrl.pathname = stream === "remote" ? "/api/remote.mux" : url.pathname;
      const upstream = new WebSocket(upstreamUrl, { headers: { host: upstreamUrl.host, origin: context.config.upstream, ...(dshCookie ? { cookie: dshCookie } : {}) } });
      const pending = [];
      const answerable = new Set();
      const remoteStreams = new Map();
      const registeredClients = new Set();
      const clearClients = () => {
        for (const id of registeredClients) {
          if (context.eventClients.get(id)?.socket === downstream) context.eventClients.delete(id);
        }
        registeredClients.clear();
        remoteStreams.clear();
      };
      upstream.on("open", () => pending.splice(0).forEach(data => upstream.send(data)));
      // 注意：DSH 协议全部使用文本帧。ws 库 send(Buffer) 会发二进制帧，
      // DSH 客户端会把二进制帧当作畸形帧丢弃——必须按原始帧类型转发。
      const sessionStillActive = () => {
        reloadConfigIfChanged();
        const current = resolveSession(home, cookies[COOKIE]);
        return current?.username === user.name && context.config.users.some(account =>
          account.name === user.name && account.role === user.role && (account.status || "active") === "active" && !account.mustChangePassword);
      };
      downstream.on("message", (data, isBinary) => {
        if (!sessionStillActive()) { clearClients(); downstream.close(1008); return; }
        let memberFrame;
        if (user.role === "member") {
          if (isBinary) return;
          try {
            const frame = JSON.parse(data.toString("utf8"));
            const allowed = stream === "remote"
              ? guardRemoteClientFrame({ ownership: context.ownership, user, streams: remoteStreams, frame })
              : isAllowedClientFrame({ ownership: context.ownership, user, frame, answerable });
            if (!allowed) {
              context.audit.write("ws.client-frame-denied", { user: user.name, stream });
              return;
            }
            memberFrame = stream === "remote" ? allowed : frame;
            if (stream === "remote" && frame.type === "cancel") {
              for (const id of registeredClients) {
                if (![...remoteStreams.values()].some(item => item.clientId === id)) {
                  if (context.eventClients.get(id)?.socket === downstream) context.eventClients.delete(id);
                  registeredClients.delete(id);
                }
              }
            }
          } catch { return; }
        }
        const out = user.role === "member" ? JSON.stringify(memberFrame) : isBinary ? data : data.toString("utf8");
        if (upstream.readyState === WebSocket.OPEN) upstream.send(out);
        else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 32) pending.push(out);
        else downstream.close();
      });
      upstream.on("message", (data, isBinary) => {
        if (!sessionStillActive()) { clearClients(); downstream.close(1008); return; }
        if (user.role === "member") {
          if (isBinary) return;
          let frame, allowed;
          try {
            frame = JSON.parse(data.toString("utf8"));
            allowed = stream === "remote"
              ? filterRemoteServerFrame({ config: context.config, ownership: context.ownership, user, streams: remoteStreams, frame })
              : stream === "mux"
                ? filterMuxFrame({ ownership: context.ownership, user, frame, answerable, onUnknown: type => context.audit.write("ws.unknown-mux-frame", { type }) })
                : filterHostFrame({ config: context.config, ownership: context.ownership, user, frame, onUnknown: type => context.audit.write("ws.unknown-host-frame", { type }) });
            if (!allowed) {
              context.audit.write("ws.frame-dropped", { user: user.name, stream });
              return;
            }
          } catch (error) {
            context.audit.write("ws.frame-filter-error", { user: user.name, stream });
            downstream.close(1008);
            return;
          }
          if (stream === "remote" && allowed.value?.type === "ready") {
            const clientId = allowed.value.clientId;
            if (context.eventClients.has(clientId)) { downstream.close(1008); return; }
            context.eventClients.set(clientId, { user: user.name, sessionToken: cookies[COOKIE], socket: downstream, streams: remoteStreams });
            registeredClients.add(clientId);
          }
          if (stream === "remote" && (allowed.type === "end" || allowed.type === "error")) {
            for (const id of registeredClients) {
              if (![...remoteStreams.values()].some(item => item.clientId === id)) {
                if (context.eventClients.get(id)?.socket === downstream) context.eventClients.delete(id);
                registeredClients.delete(id);
              }
            }
          }
          downstream.send(JSON.stringify(stream === "remote" ? allowed : frame));
          return;
        }
        downstream.send(isBinary ? data : data.toString("utf8"));
      });
      downstream.on("close", () => { clearClients(); upstream.close(); });
      upstream.on("close", () => { clearClients(); downstream.close(); });
      upstream.on("error", () => downstream.close());
      upstream.on("unexpected-response", (_request, response) => { response.resume(); downstream.close(); });
    });
  });

  await new Promise(resolve => server.listen(config.listenPort, config.listenHost, resolve));
  console.log(`dsh-team-hub listening on http://${config.listenHost}:${config.listenPort}`);
  console.log(`Admin console: http://${config.listenHost}:${config.listenPort}/admin`);
}
