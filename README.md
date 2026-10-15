# dsh-team-hub

把单用户的 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web 实例，变成局域网内可安全共用的团队服务。

dsh-team-hub 位于浏览器和本地 DSH 实例之间。它不修改 DSH，而是在外层提供登录、角色、工作区隔离、RPC 过滤、WebSocket 事件过滤、Admin 控制台和审计日志。

[English README](README.en.md)

![dsh-team-hub Admin 控制台](docs/assets/admin-console.png)

> **dsh-team-hub 是一个面向团队的 DSH 协作网关。** 管理员可以统一管理成员、工作区、权限和审计记录；团队成员在各自隔离的工作区中共享同一个 DSH 服务，不再把个人机器上的单用户环境直接暴露给所有人。

> **发布状态：v0.2.8 已标记废弃，请勿安装用于 DSH 0.2；v0.2.9 针对 DSH 0.2.0-rc.2 适配。** 成员审批/提问的真实浏览器交互及生产模型凭据尚未验证，详见下方使用限制；本项目不提供 OS 级多租户隔离。

## 为什么需要它

DSH Web 默认是单用户形态，通常只监听本机回环地址。直接把 DSH 地址分享给团队成员，会让所有人都获得同一个高权限宿主上下文。

dsh-team-hub 提供：

- 用户名/密码登录
- 首次登录强制修改密码
- Admin / Member / Disabled 角色状态
- 按成员隔离工作区和会话
- DSH RPC 默认拒绝策略
- WebSocket 事件逐帧过滤
- 共享知识库和代码仓库目录
- 独立 Admin 控制台
- 结构化审计日志
- macOS launchd / Linux systemd 服务安装
- DSH 兼容性自检

## 环境要求

- Node.js 22 或更高版本
- 一个可访问的 DSH Web 实例，默认 `http://127.0.0.1:3080`
- macOS 或 Linux（用于系统服务安装）
- 可信局域网。v0.1 不建议直接暴露到公网

## DSH 0.2 安全边界与使用限制

当前源码对 DSH 0.2.0-rc.2 验证了私有 token→cookie 认证、斜杠 RPC、会话/工作区清单及远程流过滤；独立 DSH_HOME 上的双成员 Chrome 还验证了会话创建、每会话模型/推理等级选择界面、提交消息、回放历史和跨成员历史拒绝。独立 Host 使用仅供测试的回环 Anthropic Messages 模型模拟器，双成员真实 Chrome 均收到了独立的 `READY` 回复；尚未验证生产 DeepSeek 模型凭据和真实推理。网关自动从运行账户持有、权限为 `0600` 的 DSH Web 启动日志读取 token；日志如不在默认 `~/dsh-web.log`，可在网关 `config.json` 中设置 `"dshWebLog": "/绝对路径/私有启动日志"`。DSH 上游必须为不带凭证的回环地址 `http://127.0.0.1:3080`（也支持 `localhost`/`[::1]`），不能将 token 放入 URL 或发给成员浏览器。日志需由网关运行用户拥有，不能公开或纳入版本控制。

**开发中：** 已验证 DSH 0.2 的 Agent ID 等于 Session ID，源码现仅投递归属明确的审批/提问事件，并将结果绑定到已投递事件、当前登录 cookie 和存活的浏览器连接；跨成员、未知事件及重放默认拒绝。审批/提问桥接目前只有隔离 mock 测试，尚未完成真实浏览器交互验证；成员发送消息仅支持已审核的纯文本，不支持图片、文件附件与跨会话引用；会话 fork、队列修改、工作区排序及消息反馈编辑尚未审查嵌套参数或消息归属，对成员禁用；成员设置除私有预览确认外仍不支持，模型供应商配置、内置插件、Agent 预设的宿主级设置页已对成员隐藏且接口继续拒绝；宿主级插件和使用统计亦拒绝。独立 Host 的运行时上下文消息保留序号与来源，但其组装文本和章节元数据会脱敏；系统和开发者消息中可能共用的指令文本同样会被遮蔽，防止宿主级信息外泄。不要将网关作为已验证的生产级多租户隔离边界，也不要依赖 `selftest`（只检查清单）判断全部功能正常。DSH Agent 依然运行在同一个宿主账户，可访问共享的模型额度及其他宿主资源。

## 快速开始

```bash
npm install -g dsh-team-hub

dsh-team-hub init alice bob
dsh-team-hub start
```

初始化时会打印一次 admin 初始密码。打开：

```text
http://<服务器局域网IP>:3090
```

Admin 控制台：

```text
http://<服务器局域网IP>:3090/admin
```

所有用户使用初始密码首次登录后，都必须设置新密码。

## CLI

```bash
dsh-team-hub init [--port 3090] [--upstream http://127.0.0.1:3080] [member ...]
dsh-team-hub start
dsh-team-hub selftest
dsh-team-hub user add <name> [--role member|admin]
dsh-team-hub user disable <name>
dsh-team-hub user enable <name>
dsh-team-hub user reset-password <name>
dsh-team-hub patch status [--dsh-root <path>]
dsh-team-hub patch apply [--dsh-root <path>]
dsh-team-hub patch rollback [--dsh-root <path>]
dsh-team-hub service install
dsh-team-hub service status
dsh-team-hub service uninstall
```

### 远程设置补丁（patch）

dsh 上游把 settings 设计为仅本机（loopback）可用：通过局域网 IP/域名访问时，
设置页会报「加载提供方目录失败: settings are unavailable in this browser」
（旧版 dsh 的回归）。当前源码可识别旧版及 DSH 0.2.0-rc.2 的已知客户端表达式并自动打补丁；未知版本保持原样。成员仅收到网关私有的引导确认命名空间，不可读写共享宿主设置；首次预览提示的确认会以权限 `0600` 存在网关本地、按成员隔离。**其他成员设置表单与偏好保存仍不支持**。独立 DSH_HOME 的双成员 Chrome 已验证预览提示消失及「General」设置页渲染；其他设置标签页和偏好保存未完成真实浏览器验收。

```bash
dsh-team-hub patch status    # 查看补丁状态
dsh-team-hub patch apply     # 手动应用
dsh-team-hub patch rollback  # 回滚（恢复 dsh 原始文件）
```

找不到 dsh 安装目录时，用 `--dsh-root <path>` 显式指定，或在 config.json 里设置
`"dshRoot": "<path>"`。

运行数据默认保存到：

```text
~/.dsh-team-hub
```

可以通过环境变量修改：

```bash
export DSH_TEAM_HUB_HOME=/path/to/data
```

## 安全模型

- Member 未明确允许的 DSH RPC 方法默认拒绝
- 未识别的 WebSocket 事件类型默认丢弃
- 所有受保护参数都会校验会话/工作区归属
- Member 可见列表只包含自己的资源
- 宿主文件选择、系统设置、凭证、工作区创建/删除等特权方法对 Member 禁用
- 密码使用 scrypt 哈希
- 配置和会话文件权限为 0600
- 审计日志会脱敏 password/token/secret/api-key 类字段

完整威胁模型见 [docs/security.md](docs/security.md)。

## Admin 控制台

控制台由网关提供，地址为 `/admin`：

- 总览
- 用户创建、禁用、启用、重置密码
- 工作区归属查看
- 审计查询
- 系统状态和 DSH 兼容性自检

Member 继续使用正常的 DSH 界面，不需要理解网关内部实现。

## 共享目录

运行目录中包含：

```text
shared/knowledge
shared/repo
```

它们是 Member Agent 可读取的基础共享位置。团队资产的发布、版本化和自动注入计划在 v0.2 实现。

## 升级 DSH 后

开发中的源码适配 DSH 0.2.0-rc.2 的私有浏览器认证和流协议，不承诺未来 DSH 0.2.x/更高版本兼容。上游未认证、启动中或插件路由失败时可能返回 HTML/纯文本错误页；网关会将其转换成 RPC 错误，但成员审批/提问桥接还需真实浏览器验收。

DSH 的 RPC 和事件协议仍属于内部协议，升级后可能变化。请运行：

```bash
dsh-team-hub selftest
npm test
```

未识别的新 DSH 方法会默认拒绝。这样升级后最多导致新功能暂时不可用，而不会意外泄露其他成员的数据。

## 路线图

### v0.2 — 团队知识进化

- 成员提交候选资产
- Admin 审阅并发布
- 版本管理和回滚
- AGENTS、提示词、Skills、模板
- 自动注入到成员会话
- 使用效果反馈

### 后续版本

- Codex / KimiWork 会话只读聚合
- 团队使用统计
- HTTPS 反向代理部署模板
- 多 DSH 主机管理

## 免责声明

这是独立社区项目，不是 DeepSeek 官方产品。

## License

MIT
