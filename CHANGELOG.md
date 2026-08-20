# Changelog

## 0.2.0

- 修复 WebSocket 帧以二进制转发导致成员看不到实时回复的关键缺陷
- 修复新会话事件订阅与归属学习的竞态
- 修复运行中新增成员无工作区的问题（配置热加载时就地创建）
- 新增退出登录（成员页悬浮条 + Admin 控制台）
- 新增 displayName（中文显示名）与 /__teamhub/whoami
- 成员唯一工作区首次进入自动选中
- 成员消息反馈（👍/👎）与斜杠命令按会话归属放行
- 成员会话权限模式锁定 workspace-write
- Typert remote 嵌套归属字段（args/args.request）守卫
- Admin API 新增归属表调试端点；帧丢弃写入审计
- npm Trusted Publishing 自动发布

## 0.1.1

- 新增退出登录：/logout 路由、DSH 页面右下角用户悬浮条、Admin 控制台退出入口
- 新增 displayName：界面显示中文名（如"李雷"），登录名保持英文（如 lilei）
- Admin 控制台支持修改显示名；CLI 新增 --display-name 与 user set-display-name
- 新增 /__teamhub/whoami 接口

## 0.1.0 — Unreleased

Initial public release.

- Username/password login and forced first-login password change
- Admin/Member roles and disabled state
- Workspace and session isolation
- Default-deny DSH RPC policy
- WebSocket event filtering
- Shared knowledge/repo base directories
- Admin console
- Structured audit logs
- macOS launchd and Linux systemd installers
- DSH compatibility self-test
