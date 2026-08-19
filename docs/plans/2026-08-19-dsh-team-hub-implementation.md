# dsh-team-hub v0.1 实施计划

> 目标：把当前 PMHub 原型整理为可公开发布的 dsh-team-hub npm CLI 项目。

**Architecture:** 独立 Node.js 网关位于浏览器和 DSH Web 之间，负责认证、权限、RPC/WS 过滤、审计和 Admin 控制台。首版不修改 DSH，不包含团队资产进化闭环。

**Tech Stack:** Node.js >=22、原生 HTTP/WebSocket 服务、ws、vanilla JS Admin UI、node:test、GitHub Actions。

---

## 总体策略

- 先搭建干净仓库和测试基础设施
- 将当前可工作的 gateway.mjs 按职责拆分
- 每一步保持 selftest 可运行
- 敏感配置和运行数据永不进入 Git
- Admin UI 首版使用零构建 vanilla JS，避免引入前端工具链
- 所有外部命令以跨 macOS/Linux 为前提

---

## Task 1: 初始化发布仓库

**Files:**
- Create: package.json
- Create: .gitignore
- Create: LICENSE
- Create: bin/dsh-team-hub.js
- Test: test/package.test.mjs

**Steps:**
1. 初始化 Git。
2. package name 改为 dsh-team-hub。
3. bin 指向 bin/dsh-team-hub.js。
4. 添加 files 白名单，避免误发布运行数据。
5. 添加 MIT LICENSE。
6. .gitignore 忽略 config、sessions、logs、workspaces、shared、node_modules。
7. 编写 package 元数据测试。
8. npm test 验证。

Commit: chore: initialize dsh-team-hub package

---

## Task 2: 建立配置模块

**Files:**
- Create: src/config.mjs
- Create: test/config.test.mjs

**Steps:**
1. 定义默认配置。
2. 支持 DSH_TEAM_HUB_HOME 指定运行目录。
3. 默认运行目录为 ~/.dsh-team-hub。
4. 加载 config.json。
5. 校验端口、上游地址、工作区根目录。
6. 测试默认路径和环境变量覆盖。

Commit: feat: add configuration loading

---

## Task 3: 建立用户和密码模块

**Files:**
- Create: src/users.mjs
- Create: src/passwords.mjs
- Create: test/users.test.mjs

**Steps:**
1. 实现 scrypt 哈希和校验。
2. 实现随机初始密码。
3. 实现用户 CRUD。
4. 支持 mustChangePassword。
5. 支持 disabled 状态。
6. 测试哈希、错误密码、禁用用户。

Commit: feat: add local user management

---

## Task 4: 建立登录和会话模块

**Files:**
- Create: src/auth.mjs
- Create: test/auth.test.mjs

**Steps:**
1. 实现持久 session token。
2. HttpOnly Cookie。
3. SameSite=Lax。
4. 登录失败限流。
5. 首次登录强制改密流程。
6. 管理端重置密码。
7. 测试过期、禁用、限流和改密。

Commit: feat: add authentication and sessions

---

## Task 5: 抽取策略和资源归属模块

**Files:**
- Create: src/policy.mjs
- Create: test/policy.test.mjs

**Steps:**
1. 从 gateway.mjs 迁移 RPC 白名单。
2. 迁移 workspace/session 归属表。
3. 迁移危险参数扫描。
4. 迁移 filterPmResponse。
5. 测试放行、拦截、跨用户访问。

Commit: feat: add policy engine

---

## Task 6: 抽取 HTTP RPC 网关

**Files:**
- Create: src/rpc-guard.mjs
- Create: src/gateway.mjs
- Test: test/rpc-guard.test.mjs

**Steps:**
1. 迁移 /api POST 处理。
2. 迁移 envelope 解析。
3. 迁移上游转发。
4. 迁移 PM 响应过滤。
5. 保留 host.describe 等必要启动方法。
6. 测试合法和非法 RPC。

Commit: feat: add guarded RPC gateway

---

## Task 7: 抽取 WebSocket 过滤器

**Files:**
- Create: src/ws-filter.mjs
- Test: test/ws-filter.test.mjs

**Steps:**
1. 使用 ws 处理 downstream handshake。
2. 使用 Node WebSocket 连接 upstream。
3. 下游请求逐帧校验。
4. 上游事件逐帧过滤。
5. 未知事件默认丢弃。
6. 测试会话事件和跨用户事件。

Commit: feat: add websocket filtering

---

## Task 8: 注入浏览器兼容 shim

**Files:**
- Create: src/spa-shim.mjs
- Test: test/spa-shim.test.mjs

**Steps:**
1. 在 index.html 注入 crypto.randomUUID shim。
2. 移除临时 verbose probe。
3. 保留错误级 clientlog。
4. 测试 shim 只注入一次。

Commit: fix: support insecure LAN origins

---

## Task 9: 审计日志模块

**Files:**
- Create: src/audit.mjs
- Test: test/audit.test.mjs

**Steps:**
1. JSONL 审计日志。
2. 登录、拦截、放行、管理操作、自检事件。
3. 按用户、类型、时间过滤。
4. 日志轮转。
5. 测试敏感信息不写入日志。

Commit: feat: add audit logging

---

## Task 10: Admin API

**Files:**
- Create: src/admin-api.mjs
- Test: test/admin-api.test.mjs

**Steps:**
1. 总览接口。
2. 用户管理接口。
3. 工作区接口。
4. 审计查询接口。
5. 系统状态接口。
6. 全部要求 admin。
7. 测试 member 访问被拒绝。

Commit: feat: add admin API

---

## Task 11: Admin UI

**Files:**
- Create: admin-ui/index.html
- Create: admin-ui/app.js
- Create: admin-ui/styles.css
- Test: test/admin-ui.test.mjs

**Steps:**
1. 实现登录跳转。
2. 实现总览页。
3. 实现用户页。
4. 实现工作区页。
5. 实现审计页。
6. 实现系统页。
7. 不引入构建工具。
8. 测试静态资源和 API 对接。

Commit: feat: add admin console

---

## Task 12: CLI

**Files:**
- Create: src/cli.mjs
- Modify: bin/dsh-team-hub.js
- Test: test/cli.test.mjs

**Commands:**
- init
- start
- user add/disable/enable/reset-password
- selftest
- service install/uninstall/status

**Steps:**
1. 解析命令和参数。
2. init 生成随机 admin 密码。
3. user 管理命令。
4. selftest 调用兼容性模块。
5. 测试 CLI 输出和退出码。

Commit: feat: add CLI

---

## Task 13: 系统服务

**Files:**
- Create: src/service-launchd.mjs
- Create: src/service-systemd.mjs
- Test: test/service.test.mjs

**Steps:**
1. macOS launchd plist 生成。
2. Linux systemd unit 生成。
3. install/uninstall/status。
4. 不自动启动未确认服务。
5. 测试生成内容。

Commit: feat: add service installers

---

## Task 14: 兼容性自检

**Files:**
- Create: src/compat.mjs
- Test: test/compat.test.mjs

**Steps:**
1. 检测 DSH 可达。
2. 调用 host.describe。
3. 调用 workspace.list。
4. 验证 RPC envelope。
5. 验证 WS upgrade。
6. 输出版本和通过/失败。

Commit: feat: add compatibility selftest

---

## Task 15: 文档

**Files:**
- Create: README.md
- Create: docs/security.md
- Create: docs/deployment.md
- Create: docs/compatibility.md
- Create: docs/admin-console.md
- Create: docs/roadmap.md
- Create: CHANGELOG.md
- Create: CONTRIBUTING.md

**Steps:**
1. 写项目定位。
2. 写快速开始。
3. 写威胁模型。
4. 写局域网部署。
5. 写 DSH 升级回归。
6. 写 v0.2 团队进化计划。

Commit: docs: add public documentation

---

## Task 16: CI 和发布准备

**Files:**
- Create: .github/workflows/test.yml
- Create: .github/workflows/release.yml
- Modify: package.json

**Steps:**
1. Node 22/24 测试。
2. npm pack 检查。
3. LICENSE/README/files 校验。
4. tag 触发发布。
5. 不自动发布 npm，先生成 artifact。

Commit: ci: add test and release workflows

---

## Task 17: 最终验收

**Steps:**
1. npm test。
2. npm pack --dry-run。
3. 初始化全新 DSH_TEAM_HUB_HOME。
4. 启动服务。
5. 创建 admin 和 member。
6. 浏览器验证登录、改密、隔离、控制台。
7. 停止测试服务。
8. 打 v0.1.0 tag。

Commit: chore: prepare v0.1.0 release
