# Changelog

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
