import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_UPSTREAM = "http://127.0.0.1:3080";
export const DEFAULT_PORT = 3090;

export function defaultHome(env = process.env) {
  return env.DSH_TEAM_HUB_HOME || path.join(os.homedir(), ".dsh-team-hub");
}

export function defaultConfig(home = defaultHome()) {
  return {
    listenHost: "0.0.0.0",
    listenPort: DEFAULT_PORT,
    upstream: DEFAULT_UPSTREAM,
    // 可选的 dsh 安装目录（@deepseek-ai/dsh）。缺省时自动探测：
    // npm root -g → 当前目录向上 → 常见路径。用于远程设置补丁。
    dshRoot: null,
    dshWebLog: null,
    workspaceRoot: path.join(home, "workspaces"),
    sharedRoot: path.join(home, "shared"),
    users: [],
    workspaceShares: {}
  };
}

export function configPath(home = defaultHome()) {
  return path.join(home, "config.json");
}

export function loadConfig(home = defaultHome()) {
  const file = configPath(home);
  if (!fs.existsSync(file)) throw new Error(`配置文件不存在：${file}，请先运行 dsh-team-hub init`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const config = { ...defaultConfig(home), ...raw };
  // dsh 上游注册工作区时会用 fs.realpath 规范化路径；这里同步规范化，
  // 否则 HOME/workspaceRoot 经过符号链接（如 macOS 的 /tmp→/private/tmp、/var→/private/var）时
  // ownerOfPath 匹配失败，member 会看不到自己的工作区（归属被误判为 admin）。
  for (const key of ["workspaceRoot", "sharedRoot"]) {
    try { config[key] = fs.realpathSync(config[key]); } catch { config[key] = path.resolve(config[key]); }
  }
  validateConfig(config);
  return { home, file, config };
}

export function validateConfig(config) {
  if (!Number.isInteger(config.listenPort) || config.listenPort <= 0 || config.listenPort > 65535) throw new Error("listenPort 必须是 1-65535");
  if (!URL.canParse(config.upstream)) throw new Error("upstream 不是合法 URL");
  const upstream = new URL(config.upstream);
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname) || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) throw new Error("upstream 必须是无凭据、路径和查询参数的本机 HTTP 地址");
  if (config.dshWebLog !== null && config.dshWebLog !== undefined && (typeof config.dshWebLog !== "string" || !path.isAbsolute(config.dshWebLog))) throw new Error("dshWebLog 必须是绝对路径或 null");
  if (!Array.isArray(config.users)) throw new Error("users 必须是数组");
  for (const user of config.users) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}$/.test(user.name || "")) throw new Error(`非法用户名：${user.name}`);
    if (!["admin", "member"].includes(user.role)) throw new Error(`非法角色：${user.name}`);
    if (!["active", "disabled"].includes(user.status || "active")) throw new Error(`非法用户状态：${user.name}`);
  }
  if (!config.users.some(u => u.role === "admin" && (u.status || "active") === "active")) throw new Error("至少需要一个启用状态的 admin");
  const shares = config.workspaceShares ?? {};
  if (!shares || typeof shares !== "object" || Array.isArray(shares)) throw new Error("workspaceShares 必须是对象");
  for (const [workspaceId, members] of Object.entries(shares)) {
    if (!workspaceId || workspaceId.length > 256 ||
        ["__proto__", "constructor", "prototype"].includes(workspaceId) ||
        !Array.isArray(members) || members.length > config.users.length ||
        members.some(name => typeof name !== "string" ||
          !config.users.some(user => user.name === name && user.role === "member")) ||
        new Set(members).size !== members.length)
      throw new Error(`无效的工作区共享授权：${workspaceId}`);
  }
  return true;
}

export function saveConfig(home, config) {
  validateConfig(config);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = configPath(home);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}
