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
    workspaceRoot: path.join(home, "workspaces"),
    sharedRoot: path.join(home, "shared"),
    users: []
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
  validateConfig(config);
  return { home, file, config };
}

export function validateConfig(config) {
  if (!Number.isInteger(config.listenPort) || config.listenPort <= 0 || config.listenPort > 65535) throw new Error("listenPort 必须是 1-65535");
  if (!URL.canParse(config.upstream)) throw new Error("upstream 不是合法 URL");
  if (!Array.isArray(config.users)) throw new Error("users 必须是数组");
  for (const user of config.users) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,31}$/.test(user.name || "")) throw new Error(`非法用户名：${user.name}`);
    if (!["admin", "member"].includes(user.role)) throw new Error(`非法角色：${user.name}`);
    if (!["active", "disabled"].includes(user.status || "active")) throw new Error(`非法用户状态：${user.name}`);
  }
  if (!config.users.some(u => u.role === "admin" && (u.status || "active") === "active")) throw new Error("至少需要一个启用状态的 admin");
  return true;
}

export function saveConfig(home, config) {
  validateConfig(config);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(home), JSON.stringify(config, null, 2), { mode: 0o600 });
}
