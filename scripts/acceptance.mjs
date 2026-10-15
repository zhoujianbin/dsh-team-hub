#!/usr/bin/env node
/**
 * 最终验收脚本（对应 docs/plans Task 17）。
 *
 * 流程：
 *   1. 在系统临时目录创建全新 DSH_TEAM_HUB_HOME（mktemp dsh-team-hub-acceptance-XXXXXX）
 *   2. init（admin + member）→ 启动服务 → 冒烟检查（登录页 / member 登录改密 / 工作区隔离 / admin 控制台 API）
 *   3. 【teardown，关键】无论成败：
 *      a. 停止服务进程；
 *      b. 在上游调用 workspace.delete，注销本次验收注册的全部工作区
 *         （按“路径位于临时 HOME 内”判定，绝不误删既有工作区）；
 *      c. 删除临时目录（--keep 可保留用于调试）。
 *
 * 早期手工验收缺第 3 步，每跑一次就在上游注册表留下一个 alice 残留，本脚本根治该问题。
 *
 * 用法：
 *   node scripts/acceptance.mjs [--port 3190] [--upstream http://127.0.0.1:3080] [--browser] [--keep] [member ...]
 *   node scripts/acceptance.mjs --isolated-host --browser alice bob
 *   node scripts/acceptance.mjs --isolated-host --mock-model --browser alice bob
 *   --isolated-host starts a separate DSH_HOME on port 3191; never use it with --upstream.
 *   --mock-model uses only a loopback Messages fixture and a synthetic test key.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upstreamRpc as authenticatedRpc } from "../src/upstream.mjs";
import { workspaceBaseline } from "../src/compat.mjs";
import { WebSocket } from "ws";
import { browserCheck } from "./browser-check.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "bin", "dsh-team-hub.js");

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const browser = args.includes("--browser");
const isolatedHost = args.includes("--isolated-host");
const mockModel = args.includes("--mock-model");
if (mockModel && (!isolatedHost || !browser))
  throw new Error("--mock-model requires --isolated-host --browser");
if (isolatedHost && args.some(value => value === "--upstream" || value.startsWith("--upstream=")))
  throw new Error("--isolated-host forbids --upstream: never create disposable sessions on production");
const port = Number(option(args, "--port", 3190));
const upstream = isolatedHost ? "http://127.0.0.1:3191" : option(args, "--upstream", "http://127.0.0.1:3080");
if (isolatedHost && (!Number.isInteger(port) || port < 1024 || port > 65535 || [3080, 3090, 3191].includes(port)))
  throw new Error("isolated gateway port invalid or conflicts with a protected service");
const optionValues = new Set(["--port", "--upstream"].map(name => args.indexOf(name)).filter(i => i >= 0).map(i => args[i + 1]));
const members = args.filter(a => !a.startsWith("--") && !optionValues.has(a));
if (members.length === 0) members.push("alice");

const base = `http://127.0.0.1:${port}`;
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}

// ---------------------------------------------------------------- 上游 RPC

const upstreamConfig = { upstream };
async function upstreamRpc(method, payload) {
  return authenticatedRpc(upstreamConfig, method, payload);
}

async function upstreamWorkspaces() {
  try {
    const value = await workspaceBaseline(upstreamConfig);
    return value.items || [];
  } catch (error) {
    throw new Error(`上游不可达（${upstream}）：${error.message}`);
  }
}

// ---------------------------------------------------------------- 子进程

function run(cliArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...cliArgs], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve(stdout) : reject(new Error(`${cliArgs.join(" ")} 退出码 ${code}: ${stderr || stdout}`))));
  });
}

function startServer(env) {
  const child = spawn(process.execPath, [entry, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  child.getOutput = () => output;
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForClose = ms => new Promise(resolve => {
    const timer = setTimeout(() => { child.off("close", onClose); resolve(false); }, ms);
    const onClose = () => { clearTimeout(timer); resolve(true); };
    child.once("close", onClose);
  });
  const close = waitForClose(3000);
  child.kill("SIGTERM");
  if (!await close && child.exitCode === null && child.signalCode === null) {
    const killed = waitForClose(2000);
    child.kill("SIGKILL");
    await killed;
  }
}

async function waitIsolatedHost(child, log, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("isolated DSH Host exited early");
    if (fs.existsSync(log)) {
      const text = fs.readFileSync(log, "utf8");
      if (new RegExp(`dsh web: ${upstream.replaceAll(".", "\\.")}/\\?token=[A-Za-z0-9_-]{43}(?:\\r?\\n|$)`).test(text)) return true;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("isolated DSH Host did not become ready");
}

async function waitReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/login`);
      if (res.status === 200) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------- 登录辅助

async function login(username, password) {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
    redirect: "manual",
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { status: res.status, location: res.headers.get("location"), cookie };
}

async function memberWorkspaces(cookie) {
  const url = new URL(base);
  url.protocol = "ws:"; url.pathname = "/api/remote.mux";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie }, handshakeTimeout: 5000 });
    let settled = false;
    const timer = setTimeout(() => finish(new Error("member workspace feed timed out")), 5000);
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.terminate();
      if (error) reject(error); else resolve(value);
    };
    socket.on("open", () => socket.send(JSON.stringify({ type: "open", streamId: "member-workspaces", endpoint: "workspace/follow", payload: { args: {} } })));
    socket.on("message", data => {
      let frame; try { frame = JSON.parse(data.toString("utf8")); } catch { return finish(new Error("malformed member workspace frame")); }
      if (frame.streamId !== "member-workspaces") return;
      if (frame.type === "error") return finish(new Error("member workspace feed failed"));
      if (frame.type === "item" && frame.value?.type === "baseline" && Array.isArray(frame.value.value?.items)) finish(null, frame.value.value.items);
    });
    socket.on("error", () => finish(new Error("member workspace connection failed")));
    socket.on("close", () => finish(new Error("member workspace feed closed early")));
  });
}

async function memberRpc(cookie, method, args) {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`${base}/api/${method}`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
    redirect: "manual", signal: AbortSignal.timeout(12000)
  });
  const body = await response.json();
  if (body.type !== "server-response" || body.rpcId !== rpcId) throw new Error(`invalid ${method} RPC envelope`);
  return { status: response.status, result: body.result };
}

// ---------------------------------------------------------------- 主流程

// realpath：macOS 的 TMPDIR 在 /var/folders 下（/var 是指向 /private/var 的符号链接），
// 与 dsh 上游的 realpath 规范化保持一致，避免归属匹配走 symlink 路径
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-acceptance-")));
const env = { ...process.env, DSH_TEAM_HUB_HOME: home };
const hostHome = path.join(home, "isolated-dsh-host");
const hostLog = path.join(home, "isolated-dsh-web.log");
let mockProvider = null;
let mockRequests = 0;
let hostServer = null;
let server = null;
let failed = false;
let unregistered = 0;
let leakedWorkspaces = true;
if (isolatedHost) upstreamConfig.dshWebLog = hostLog;

console.log(`验收目录：${home}`);
console.log(`上游：${upstream}  端口：${port}  member：${members.join(", ")}`);

try {
  let mockUrl;
  if (mockModel) {
    mockProvider = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/messages" ||
          req.headers["x-api-key"] !== "team-hub-synthetic-test-only") { res.writeHead(403).end(); return; }
      try { for await (const _ of req) {} } catch { res.destroy(); return; }
      mockRequests += 1;
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "READY" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" }
      ];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
    await new Promise((resolve, reject) => {
      mockProvider.once("error", reject);
      mockProvider.listen(0, "127.0.0.1", () => { mockProvider.off("error", reject); resolve(); });
    });
    mockUrl = `http://127.0.0.1:${mockProvider.address().port}`;
  }
  if (isolatedHost) {
    fs.mkdirSync(hostHome, { mode: 0o700 });
    fs.writeFileSync(hostLog, "", { mode: 0o600, flag: "wx" });
    const logFd = fs.openSync(hostLog, "a");
    try {
      hostServer = spawn("dsh", ["web", "--host", "127.0.0.1", "--port", "3191", "--no-open"],
        { env: { ...process.env, DSH_HOME: hostHome, HOME: hostHome,
          ...(mockModel ? { DEEPSEEK_BASE_URL: mockUrl, DEEPSEEK_API_KEY: "team-hub-synthetic-test-only" } : {}) },
          stdio: ["ignore", logFd, logFd] });
    } finally { fs.closeSync(logFd); }
    await waitIsolatedHost(hostServer, hostLog);
    check("独立 DSH Host 就绪", true);
  }
  // 1. init + 拿到 admin 初始密码；reset-password 拿到 member 已知密码
  const initOut = await run(["init", "--port", String(port), "--upstream", upstream, ...members], env);
  // 口令后紧跟全角括号说明文字，\S+ 会误吞，按非空白非全角括号截取
  const adminPassword = (initOut.match(/admin 初始密码：([^\s（]+)/) || [])[1];
  check("init 初始化", Boolean(adminPassword), adminPassword ? "" : initOut);
  const memberPasswords = {};
  for (const name of members) {
    const out = await run(["user", "reset-password", name], env);
    memberPasswords[name] = (out.match(/新初始密码：(\S+)/) || [])[1];
  }

  if (isolatedHost) {
    const configFile = path.join(home, "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.dshWebLog = hostLog;
    config.dshRoot = path.join(home, "absent-dsh-installation"); // Never patch installed DSH.
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  // 2. 启动服务
  server = startServer(env);
  const ready = await waitReady();
  check("服务启动并就绪", ready, ready ? "" : server.getOutput());
  if (!ready) throw new Error("服务未就绪，中止检查");

  // 3. 冒烟检查
  const loginPage = await fetch(`${base}/login`);
  check("登录页可访问", loginPage.status === 200);

  const memberCookies = new Map();
  const memberViews = new Map();
  for (const name of members) {
    const first = await login(name, memberPasswords[name]);
    memberCookies.set(name, first.cookie);
    check(`${name} 首次登录跳转改密`, first.status === 302 && first.location === "/change-password", `status=${first.status} location=${first.location}`);
    const changed = await fetch(`${base}/change-password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: first.cookie },
      body: new URLSearchParams({ current: memberPasswords[name], next: `Accept-${crypto.randomBytes(4).toString("hex")}` }),
      redirect: "manual",
    });
    check(`${name} 改密成功`, changed.status === 302 && changed.headers.get("location") === "/");

    const items = await memberWorkspaces(first.cookie);
    const ownRoot = path.join(home, "workspaces", name);
    const isolated = items.length === 1 && path.resolve(items[0].path) === path.resolve(ownRoot);
    check(`${name} 工作区隔离`, isolated, `可见 ${items.length} 个：${items.map(w => w.title).join(", ")}`);
    if (isolated) memberViews.set(name, items[0]);
    const inventory = await memberRpc(first.cookie, "session/list", { _request: {} });
    check(`${name} 会话列表无跨成员数据`, inventory.result?.ok === true &&
      Array.isArray(inventory.result.value?.items) && inventory.result.value.items.length === 0);
    const settings = await memberRpc(first.cookie, "settings/describe", {});
    check(`${name} 宿主设置只读隔离`, settings.result?.ok === true &&
      settings.result.value?.writable === false && settings.result.value?.hasDocument === false &&
      settings.result.value?.namespaces?.length === 1 &&
      settings.result.value.namespaces[0].ns === "ui-settings-general" &&
      JSON.stringify(settings.result.value.namespaces[0].value) === "{}");
    const deniedSettings = await memberRpc(first.cookie, "settings/update", {});
    check(`${name} 禁止修改宿主设置`, deniedSettings.result?.ok === false);
  }
  if (members.length > 1 && memberViews.has(members[1])) {
    const denied = await memberRpc(memberCookies.get(members[0]), "session/create",
      { request: { workspaceId: memberViews.get(members[1]).workspaceId } });
    check(`${members[0]} 不能在 ${members[1]} 工作区创建会话`, denied.result?.ok === false);
  }

  if (browser) {
    await browserCheck(base, memberCookies, { isolatedHost, mockModel });
    check("Chrome 真实页面加载", true);
    if (mockModel) check("本地模拟模型收到请求", mockRequests >= members.length, `requests=${mockRequests}`);
    if (isolatedHost) {
      const sessionIds = new Map();
      const inventories = new Map();
      for (const [name, cookie] of memberCookies) {
        const inventory = await memberRpc(cookie, "session/list", { _request: {} });
        check(`${name} 独立 Host 会话创建`, inventory.result?.ok === true && inventory.result.value?.items?.length > 0,
          `sessions=${inventory.result?.value?.items?.length ?? 0}`);
        sessionIds.set(name, inventory.result?.value?.items?.[0]?.sessionId);
        inventories.set(name, inventory.result?.value?.items || []);
      }
      if (members.length > 1 && sessionIds.get(members[1])) {
        const foreign = await memberRpc(memberCookies.get(members[0]), "session/history",
          { request: { address: { kind: "session", sessionId: sessionIds.get(members[1]) } } });
        check(`${members[0]} 无法读取 ${members[1]} 浏览器会话`, foreign.result?.ok === false);
        check(`${members[0]} 会话列表不含 ${members[1]}`, !inventories.get(members[0]).some(item => item.sessionId === sessionIds.get(members[1])));
      }
    }
  }

  const admin = await login("admin", adminPassword);
  check("admin 登录", admin.status === 302, `status=${admin.status}`);
  // admin 同样带 mustChangePassword，先改密否则其它请求一律被 302 到 /change-password
  await fetch(`${base}/change-password`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: admin.cookie },
    body: new URLSearchParams({ current: adminPassword, next: `Admin-${crypto.randomBytes(4).toString("hex")}` }),
    redirect: "manual",
  });
  const usersRes = await fetch(`${base}/__teamhub/api/users`, { headers: { cookie: admin.cookie } });
  const usersBody = await usersRes.json().catch(() => null);
  const names = (usersBody?.users || usersBody || []).map(u => u.name);
  check("admin 控制台用户列表", usersRes.status === 200 && members.every(m => names.includes(m)), `users=${names.join(",")}`);
  const overviewRes = await fetch(`${base}/__teamhub/api/overview`, { headers: { cookie: admin.cookie } });
  const overview = await overviewRes.json().catch(() => null);
  check("admin 总览含成员工作区和审计", overviewRes.status === 200 &&
    members.every(name => overview?.workspaces?.some(workspace => workspace.owner === name)) &&
    Array.isArray(overview?.recentAudit) && overview.recentAudit.length > 0);
} catch (error) {
  failed = true;
  console.error(`验收异常：${error.message}`);
  // Errors are summarized without exposing upstream logs or credentials.
} finally {
  if (mockModel) console.log(`本地模拟模型请求数：${mockRequests}`);
  // 4. teardown：停服务 → 注销本次注册的工作区 → 清理临时目录
  await stopServer(server);

  try {
    const after = await upstreamWorkspaces();
    const homeReal = fs.realpathSync(home);
    const created = after.filter(w => {
      let p;
      try { p = fs.realpathSync(w.path); } catch { p = path.resolve(w.path); }
      return p.startsWith(path.join(homeReal, "workspaces") + path.sep) &&
        members.some(name => p === path.join(homeReal, "workspaces", name));
    });
    for (const w of created) {
      await upstreamRpc("workspace/delete", { args: { request: { workspaceId: w.workspaceId } } });
      unregistered += 1;
      console.log(`已注销上游工作区：${w.title}（${w.workspaceId}）`);
    }
    const remaining = await upstreamWorkspaces();
    const leaked = remaining.filter(w => created.some(c => c.workspaceId === w.workspaceId));
    leakedWorkspaces = leaked.length > 0;
    if (leakedWorkspaces) {
      failed = true;
      console.error(`警告：本次验收仍有 ${leaked.length} 个工作区未注销`);
    }
  } catch (error) {
    failed = true;
    console.error(`teardown 注销工作区失败（需手工清理上游注册表）：${error.message}`);
  }

  await stopServer(hostServer);
  if (mockProvider) await new Promise(resolve => mockProvider.close(resolve));
  const hostStopped = !hostServer || hostServer.exitCode !== null || hostServer.signalCode !== null;
  if (!hostStopped) { failed = true; console.error("isolated DSH Host did not stop; preserving its home"); }
  failed = failed || results.some(r => !r.ok);
  if (keep || !hostStopped || (!isolatedHost && leakedWorkspaces)) {
    console.log(`验收目录保留用于排查：${home}`);
  } else {
    // A failed check alone is not a reason to retain temporary passwords.
    // Never delete while a created workspace is still registered upstream.
    fs.rmSync(home, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.ok).length;
  console.log(`
${failed ? "验收失败" : "验收通过"}：${passed}/${results.length} 项检查通过，注销工作区 ${unregistered} 个`);
  process.exitCode = failed ? 1 : 0;
}
