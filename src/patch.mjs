// 远程设置补丁：强制 dsh 客户端 settings 进入 host 模式。
//
// 背景（对应 issue #2「加载提供方目录失败: settings are unavailable in this browser」）：
// dsh 把 settings 设计成 loopback-only。浏览器端 dsh-client-ui-settings/lib/client.js
// 用 `connection.isLoopback ? "host" : "memory"` 决定持久化模式，
// 而 isLoopback 只看 pageLocation.hostname —— 经网关用局域网 IP/域名访问时必然为 false，
// settings 走 memory 模式，view 永远是 undefined，设置页直接抛错。
// 这是 dsh 上游 0.1.1-rc.2 引入的回归（0.1.0-rc.7 正常），上游至今未修；
// 社区（dsh-passwords v2.6.0）的解法是把客户端持久化强制为 host 模式。
// 网关已把 Host/Origin 改写为上游源，主机侧栅栏对经网关的流量放行，
// 所以只需替换客户端这一处三元表达式。
//
// 信任边界：补丁只改共享客户端的持久化选择，不能作为成员设置的授权。
// Member 对宿主设置的读取和写入必须由网关分别做字段投影和默认拒绝。
// 网关启动时只识别已知表达式，其他 DSH 版本保持原样。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const BAK_SUFFIX = ".bak-teamhub";
const BAK_META_SUFFIX = ".sha256-teamhub";

const SETTINGS_PACKAGE = "@deepseek-ai/dsh-client-ui-settings";
const SETTINGS_FILE = path.join("lib", "client.js");
const SETTINGS_FROM = 'connection.isLoopback ? "host" : "memory"';
const SETTINGS_FROM_02 = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";';
const SETTINGS_TO_02 = 'const persistence = "host";';
const SETTINGS_TO = '"host"';

function patchVariant(source) {
  const legacy = source.split(SETTINGS_FROM).length - 1;
  const modern = source.split(SETTINGS_FROM_02).length - 1;
  if (legacy && !modern) return "legacy";
  if (modern === 1 && !legacy) return "0.2";
  return null;
}

function verifiedPatched(source, backup, meta) {
  try {
    const original = readFileSync(backup, "utf8");
    const hashes = JSON.parse(readFileSync(meta, "utf8"));
    if (hashes.originalSha !== contentHash(original) || hashes.patchedSha !== contentHash(source)) return false;
    const variant = patchVariant(original);
    const expected = variant === "0.2" ? original.replace(SETTINGS_FROM_02, SETTINGS_TO_02)
      : variant === "legacy" ? original.split(SETTINGS_FROM).join(SETTINGS_TO) : null;
    return expected === source;
  } catch { return false; }
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function backupMetaPath(target) {
  return target + BAK_META_SUFFIX;
}

/**
 * 保留可回滚的原始备份。备份不存在或与当前原始内容不一致（dsh 升级覆盖了
 * bundle）时刷新，避免回滚时把旧版 dsh 的原始文件恢复到新版上。
 */
function ensureOriginalBackup(target, original, originalSha, patchedSha) {
  const backup = target + BAK_SUFFIX;
  if (!existsSync(backup)) {
    writeFileSync(backup, original);
    return;
  }
  try {
    const meta = JSON.parse(readFileSync(backupMetaPath(target), "utf8"));
    // 备份与当前原始内容一致 → 无需刷新；备份是打补丁后的内容（半打状态）→ 保留真正的原始备份
    if (meta.originalSha === originalSha || meta.patchedSha === originalSha) return;
  } catch { /* 元数据缺失/损坏：走刷新逻辑，用当前内容重建备份 */ }
  writeFileSync(backup, original);
}

/** 按 Node 模块解析规则，从 dsh 包目录逐级向上找实际 bundle 文件。 */
export function findDshBundleFile(dshRoot, packageName, relativePath) {
  let dir = dshRoot;
  for (;;) {
    const candidate = path.join(dir, "node_modules", packageName, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** 找到 dsh 安装根目录（@deepseek-ai/dsh）；显式路径优先，否则 npm root -g + cwd 向上 + 常见路径。 */
export function findDshRoot(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  try {
    // Windows 上 npm 是 npm.cmd，spawnSync 不带 shell 找不到；带 shell 有注入风险，
    // 这里用 shell: true 仅执行固定命令（参数全静态），等价于手动在终端敲 npm root -g。
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const globalRoot = spawnSync(npmCmd, ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).stdout.trim();
    const candidate = path.join(globalRoot, "@deepseek-ai", "dsh");
    if (candidate && existsSync(candidate)) return candidate;
  } catch { /* npm 不可用时走兜底 */ }
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, "node_modules", "@deepseek-ai", "dsh");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of [
    "/usr/local/lib/node_modules/@deepseek-ai/dsh",
    "/usr/lib/node_modules/@deepseek-ai/dsh",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 当前 settings bundle 是否已被本补丁处理（不再含旧三元、含强制 host 串）。 */
export function settingsPatchStatus(dshRoot) {
  const file = findDshBundleFile(dshRoot, SETTINGS_PACKAGE, SETTINGS_FILE);
  if (file === null) return "missing";
  try {
    const s = readFileSync(file, "utf8");
    return verifiedPatched(s, file + BAK_SUFFIX, backupMetaPath(file)) ? "patched" : "unpatched";
  } catch {
    return "missing";
  }
}

/** 应用补丁（幂等）：返回 "applied" | "unchanged" | "missing"。 */
export function applySettingsPatch(dshRoot) {
  const file = findDshBundleFile(dshRoot, SETTINGS_PACKAGE, SETTINGS_FILE);
  if (file === null) return "missing";
  const s = readFileSync(file, "utf8");
  if (verifiedPatched(s, file + BAK_SUFFIX, backupMetaPath(file))) return "unchanged";
  const variant = patchVariant(s);
  // Unknown or mixed anchors are not evidence of a safe patch target.
  if (!variant) return "missing";
  // Legacy clients have multiple selectors; the 0.2 selector must be unique.
  const patched = variant === "0.2" ? s.replace(SETTINGS_FROM_02, SETTINGS_TO_02)
    : s.split(SETTINGS_FROM).join(SETTINGS_TO);
  const originalSha = contentHash(s);
  const patchedSha = contentHash(patched);
  ensureOriginalBackup(file, s, originalSha, patchedSha);
  writeFileSync(backupMetaPath(file), JSON.stringify({ originalSha, patchedSha }) + "\n");
  writeFileSync(file, patched);
  return "applied";
}

/** 回滚补丁：从备份恢复。备份不存在返回 "no-backup"。 */
export function rollbackSettingsPatch(dshRoot) {
  const file = findDshBundleFile(dshRoot, SETTINGS_PACKAGE, SETTINGS_FILE);
  if (file === null) return "missing";
  if (!existsSync(file + BAK_SUFFIX)) return "no-backup";
  try {
    const meta = JSON.parse(readFileSync(backupMetaPath(file), "utf8"));
    const current = readFileSync(file, "utf8");
    // 只回滚未被篡改的当前版本备份，防跨版本污染
    if (contentHash(current) !== meta.patchedSha) return "no-backup";
    writeFileSync(file, readFileSync(file + BAK_SUFFIX, "utf8"));
    return "rolled-back";
  } catch {
    return "no-backup";
  }
}

/** 供 CLI/server 使用的汇总状态（打印用）。 */
export function patchReport(dshRoot) {
  const root = findDshRoot(dshRoot);
  if (root === null) return { root: null, status: "dsh-not-found" };
  return { root, status: settingsPatchStatus(root) };
}
