# dsh-team-hub v0.1 设计文档

日期：2026-08-19  
状态：已确认范围，进入实施

## 定位

dsh-team-hub 把单用户、默认高权限的 DeepSeek Harness Web 实例，变成局域网内可安全共用的团队系统。

它不是 DSH 插件，而是位于浏览器和 DSH 之间的独立网关。首版重点是身份认证、权限隔离、管理员控制台和审计；团队知识进化闭环放到后续版本。

## 目标用户

- 小型研发团队
- 产品/运营/研发团队
- 使用 DSH 的个人或小组织
- 需要多人共用一套本地 Agent 环境，但不希望共享同一个高权限上下文的团队

## v0.1 范围

### 包含

- 用户名/密码登录
- 首次登录强制修改密码
- Admin / Member / Disabled 状态
- Member 工作区和会话隔离
- HTTP RPC 方法白名单
- 请求参数归属校验
- RPC 响应过滤
- WebSocket 事件逐帧过滤
- 独立 Admin 控制台
- 用户管理、工作区查看和分配
- 审计日志查看
- 系统状态与 DSH 兼容性自检
- 共享知识库和共享代码仓库基础挂载
- npm CLI 发布
- macOS launchd 和 Linux systemd 服务安装
- 安全模型、部署和升级文档

### 不包含

- 团队资产生命周期
- 候选资产提交、发布、版本和回滚
- Skills/模板自动注入
- Codex、KimiWork 会话聚合
- 多主机管理
- 任务看板
- 公网部署和 HTTPS 终止
- SSO / LDAP / OIDC

## 架构

```text
团队成员浏览器
    │ HTTP / WebSocket（局域网）
    ▼
dsh-team-hub
    │ 认证、权限、过滤、审计
    ▼
DSH Web（默认 127.0.0.1:3080）
```

核心模块：

- server：HTTP 路由、静态资源、WebSocket upgrade
- auth：登录、首次改密、会话 Cookie、限流
- gateway：RPC 与 WS 转发
- policy：用户、角色、资源和 RPC 权限判断
- audit：结构化审计日志和查询
- admin-api：控制台 API
- admin-ui：控制台前端
- service：launchd / systemd
- compat：DSH 版本探测和自检

原则：不修改 DSH；默认拒绝；无法识别的协议内容不转发；Admin 可审计。

## 权限模型

角色：

- Admin：全部用户、工作区、审计、系统配置
- Member：自己的私有工作区、共享知识库、共享代码库
- Disabled：保留数据，禁止登录和使用

核心归属关系：

```text
User → Workspace
Workspace → Session
Session → Approval / Question / Event
```

所有包含 workspaceId、sessionId、cwd、parentSessionId、childSessionId、beforeSessionId、beforeWorkspaceId 的请求必须映射到当前用户。

## 数据流

请求生命周期：

1. 解析 Cookie 和登录态
2. 检查用户是否禁用
3. 判断路由类型
4. 执行权限评估
5. 转发 DSH 或本地处理
6. 过滤响应
7. 写入审计日志

WebSocket 生命周期：

1. 握手时验证 Cookie
2. 建立到 DSH 的上游连接
3. 下游帧进行方法、会话和归属校验
4. 上游事件逐帧判断是否属于当前用户
5. 未知事件默认丢弃并审计

## Admin 控制台

首版为独立页面，不嵌入 DSH 前端。

功能：

- 总览：DSH 状态、在线用户、工作区数量、审计摘要
- 用户：创建、禁用、启用、重置密码、查看最近活跃
- 工作区：查看路径、绑定用户、会话数量、最近活跃
- 审计：登录、拦截、放行、管理操作、自检结果
- 系统：配置摘要、兼容性检查、服务状态

## 共享目录

首版只提供基础共享路径：

- shared/knowledge：团队知识库
- shared/repo：团队代码仓库

Member Agent 可以读取共享目录；共享资产的发布、版本化和自动注入在 v0.2 实现。

## 安全模型

- 默认拒绝未知 RPC 方法
- 默认拒绝未知 WS 事件
- 会话 Cookie 使用 HttpOnly、SameSite=Lax
- 密码使用 scrypt 哈希
- 配置文件权限为 0600
- 登录限流和失败审计
- 管理操作全部审计
- 网关只监听管理员指定地址，推荐局域网
- 公网部署必须在可信反向代理后启用 HTTPS

## 兼容性策略

DSH 的内部 RPC 和事件协议可能变化，因此：

- 每次启动检测 DSH 可达性
- 提供 selftest 命令
- 升级 DSH 后运行兼容性检查
- 未知方法默认不可用，但不会泄露数据
- README 明确列出验证过的 DSH 版本

## 项目结构

```text
bin/dsh-team-hub.js
src/
  cli.mjs
  server.mjs
  config.mjs
  auth.mjs
  users.mjs
  policy.mjs
  gateway.mjs
  rpc-guard.mjs
  ws-filter.mjs
  audit.mjs
  admin-api.mjs
  compat.mjs
  service-launchd.mjs
  service-systemd.mjs
admin-ui/
  index.html
  app.js
  styles.css
test/
docs/
.github/workflows/
```

## 发布形态

- GitHub 开源仓库
- npm 包：dsh-team-hub
- CLI：dsh-team-hub
- License：MIT
- Node.js：>=22

典型使用：

```bash
npm install -g dsh-team-hub
dsh-team-hub init
dsh-team-hub start
dsh-team-hub service install
dsh-team-hub selftest
```

## v0.2 预告

- 团队资产生命周期
- 候选资产提交和 Admin 发布
- 资产版本、回滚和使用统计
- AGENTS、提示词、Skills、模板自动注入

## 成功标准

- 新用户按 README 15 分钟内完成部署
- Member 无法看到其他成员工作区
- Admin 可以完整审计登录、拦截和管理操作
- DSH 升级后能运行 selftest 快速确认兼容性
- 所有测试在 CI 中通过
