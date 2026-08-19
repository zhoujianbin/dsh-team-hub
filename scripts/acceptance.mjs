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
 *   node scripts/acceptance.mjs [--port 3190] [--upstream http://127.0.0.1:3080] [--keep] [member ...]
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = path.join(root, "bin", "dsh-team-hub.js");

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const port = Number(option(args, "--port", 3190));
const upstream = option(args, "--upstream", "http://127.0.0.1:3080");
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

async function upstreamRpc(method, payload) {
  const res = await fetch(`${upstream}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
  });
  const body = await res.json();
  if (!body.result?.ok) throw new Error(`${method}: ${body.result?.error?.message || res.status}`);
  return body.result.value;
}

async function upstreamWorkspaces() {
  try {
    const value = await upstreamRpc("workspace.list", {});
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
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise(resolve => child.once("close", () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!exited) child.kill("SIGKILL");
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

async function apiAs(cookie, method, payload) {
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
  });
  return res.json();
}

// ---------------------------------------------------------------- 主流程

// realpath：macOS 的 TMPDIR 在 /var/folders 下（/var 是指向 /private/var 的符号链接），
// 与 dsh 上游的 realpath 规范化保持一致，避免归属匹配走 symlink 路径
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-acceptance-")));
const env = { ...process.env, DSH_TEAM_HUB_HOME: home };
let server = null;
let failed = false;
let unregistered = 0;

console.log(`验收目录：${home}`);
console.log(`上游：${upstream}  端口：${port}  member：${members.join(", ")}`);

try {
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

  // 2. 启动服务
  server = startServer(env);
  const ready = await waitReady();
  check("服务启动并就绪", ready, ready ? "" : server.getOutput());
  if (!ready) throw new Error("服务未就绪，中止检查");

  // 3. 冒烟检查
  const loginPage = await fetch(`${base}/login`);
  check("登录页可访问", loginPage.status === 200);

  for (const name of members) {
    const first = await login(name, memberPasswords[name]);
    check(`${name} 首次登录跳转改密`, first.status === 302 && first.location === "/change-password", `status=${first.status} location=${first.location}`);
    const changed = await fetch(`${base}/change-password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: first.cookie },
      body: new URLSearchParams({ current: memberPasswords[name], next: `Accept-${crypto.randomBytes(4).toString("hex")}` }),
      redirect: "manual",
    });
    check(`${name} 改密成功`, changed.status === 302 && changed.headers.get("location") === "/");

    const list = await apiAs(first.cookie, "workspace.list", {});
    const items = list.result?.value?.items || [];
    const ownRoot = path.join(home, "workspaces", name);
    const isolated = items.length === 1 && path.resolve(items[0].path) === path.resolve(ownRoot);
    check(`${name} 工作区隔离`, isolated, `可见 ${items.length} 个：${items.map(w => w.title).join(", ")}`);
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
} catch (error) {
  failed = true;
  console.error(`验收异常：${error.message}`);
} finally {
  // 4. teardown：停服务 → 注销本次注册的工作区 → 清理临时目录
  await stopServer(server);

  try {
    const after = await upstreamWorkspaces();
    const homeReal = fs.realpathSync(home);
    const created = after.filter(w => {
      let p;
      try { p = fs.realpathSync(w.path); } catch { p = path.resolve(w.path); }
      return p === homeReal || p.startsWith(homeReal + path.sep);
    });
    for (const w of created) {
      await upstreamRpc("workspace.delete", { workspaceId: w.workspaceId });
      unregistered += 1;
      console.log(`已注销上游工作区：${w.title}（${w.workspaceId}）`);
    }
    const leaked = after.filter(w => created.every(c => c.workspaceId !== w.workspaceId) && w.path.includes("dsh-team-hub-acceptance"));
    if (leaked.length > 0) {
      failed = true;
      console.error(`警告：仍有 ${leaked.length} 个验收残留未注销：${leaked.map(w => w.workspaceId).join(", ")}`);
    }
  } catch (error) {
    failed = true;
    console.error(`teardown 注销工作区失败（需手工清理上游注册表）：${error.message}`);
  }

  if (keep) {
    console.log(`--keep：保留验收目录 ${home}`);
  } else {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const passed = results.filter(r => r.ok).length;
  failed = failed || results.some(r => !r.ok);
  console.log(`
${failed ? "验收失败" : "验收通过"}：${passed}/${results.length} 项检查通过，注销工作区 ${unregistered} 个`);
  process.exitCode = failed ? 1 : 0;
}
