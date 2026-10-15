import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDshBundleFile, applySettingsPatch, rollbackSettingsPatch, settingsPatchStatus } from "../src/patch.mjs";

const SETTINGS_FROM = 'connection.isLoopback ? "host" : "memory"';
const SETTINGS_TO = '"host"';

function makeFakeDsh() {
  // 模拟「dsh 包内含嵌套依赖」的常规全局安装布局：
  //   <root>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-patch-"));
  const dshRoot = path.join(root, "node_modules", "@deepseek-ai", "dsh");
  const nested = path.join(dshRoot, "node_modules", "@deepseek-ai", "dsh-client-ui-settings", "lib");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, "client.js");
  const original = `const controller = new SettingsScopeController(connection.api, spec, ${SETTINGS_FROM});
const mirror = new SettingsDescribeMirror(connection.api, ${SETTINGS_FROM});`;
  fs.writeFileSync(file, original);
  return { root, dshRoot, file, original };
}

test("findDshBundleFile finds nested bundle from dsh root", () => {
  const { dshRoot, file } = makeFakeDsh();
  const found = findDshBundleFile(dshRoot, "@deepseek-ai/dsh-client-ui-settings", path.join("lib", "client.js"));
  assert.equal(found, file);
});

test("findDshBundleFile finds hoisted bundle by walking up", () => {
  // 模拟 npm install --prefix 提升布局：bundle 在 <root>/node_modules/@deepseek-ai/...
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-patch-hoist-"));
  const dshRoot = path.join(root, "node_modules", "@deepseek-ai", "dsh");
  fs.mkdirSync(dshRoot, { recursive: true });
  const hoisted = path.join(root, "node_modules", "@deepseek-ai", "dsh-client-ui-settings", "lib");
  fs.mkdirSync(hoisted, { recursive: true });
  const file = path.join(hoisted, "client.js");
  fs.writeFileSync(file, "x");
  const found = findDshBundleFile(dshRoot, "@deepseek-ai/dsh-client-ui-settings", path.join("lib", "client.js"));
  assert.equal(found, file);
});

test("DSH 0.2 selector is patched once, verified and safely rolled back", () => {
  const { dshRoot, file } = makeFakeDsh();
  const original = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n';
  fs.writeFileSync(file, original);
  assert.equal(settingsPatchStatus(dshRoot), "unpatched");
  assert.equal(applySettingsPatch(dshRoot), "applied");
  assert.equal(fs.readFileSync(file, "utf8"), 'const persistence = "host";\n');
  assert.equal(settingsPatchStatus(dshRoot), "patched");
  assert.equal(applySettingsPatch(dshRoot), "unchanged");
  assert.equal(rollbackSettingsPatch(dshRoot), "rolled-back");
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("unknown and repeated selectors never claim patched or mutate files", () => {
  const { dshRoot, file } = makeFakeDsh();
  for (const original of [
    'const persistence = ctx.remote.$host.isLoopback ? "memory" : "host";',
    'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\nconst persistence = ctx.remote.$host.isLoopback ? "host" : "memory";',
    'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";\n' + SETTINGS_FROM,
    'const unrelated = "host";'
  ]) {
    fs.writeFileSync(file, original);
    assert.equal(settingsPatchStatus(dshRoot), "unpatched");
    assert.equal(applySettingsPatch(dshRoot), "missing");
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("applySettingsPatch replaces all occurrences and is idempotent", () => {
  const { dshRoot, file, original } = makeFakeDsh();
  assert.equal(settingsPatchStatus(dshRoot), "unpatched");
  assert.equal(applySettingsPatch(dshRoot), "applied");
  const patched = fs.readFileSync(file, "utf8");
  assert.ok(!patched.includes(SETTINGS_FROM));
  assert.ok(patched.includes(SETTINGS_TO));
  // 两处三元都替换了（split/join 全量替换，不能只改第一处）
  assert.ok(patched.includes('SettingsDescribeMirror(connection.api, "host")'));
  assert.equal(settingsPatchStatus(dshRoot), "patched");
  // 幂等：再打一次返回 unchanged
  assert.equal(applySettingsPatch(dshRoot), "unchanged");
});

test("rollbackSettingsPatch restores original from backup", () => {
  const { dshRoot, file, original } = makeFakeDsh();
  applySettingsPatch(dshRoot);
  assert.equal(rollbackSettingsPatch(dshRoot), "rolled-back");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(settingsPatchStatus(dshRoot), "unpatched");
  // 无备份时返回 no-backup
  assert.equal(rollbackSettingsPatch(dshRoot), "no-backup");
});

test("backup refreshes when dsh bundle upgraded between applies", () => {
  const { dshRoot, file } = makeFakeDsh();
  applySettingsPatch(dshRoot);
  // 模拟 dsh 升级：bundle 被新版本原始内容覆盖（三元仍存在，但整体内容变了）
  const upgraded = `// new dsh version
const controller = new SettingsScopeController(connection.api, spec, ${SETTINGS_FROM});
const mirror = new SettingsDescribeMirror(connection.api, ${SETTINGS_FROM});
const extra = 1;`;
  fs.writeFileSync(file, upgraded);
  applySettingsPatch(dshRoot);
  // 回滚应恢复到「升级后的原始内容」，而不是旧版 dsh 的原始内容
  rollbackSettingsPatch(dshRoot);
  assert.equal(fs.readFileSync(file, "utf8"), upgraded);
});

test("applySettingsPatch returns missing when bundle absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-team-hub-patch-missing-"));
  const dshRoot = path.join(root, "node_modules", "@deepseek-ai", "dsh");
  fs.mkdirSync(dshRoot, { recursive: true });
  assert.equal(applySettingsPatch(dshRoot), "missing");
  assert.equal(settingsPatchStatus(dshRoot), "missing");
});
