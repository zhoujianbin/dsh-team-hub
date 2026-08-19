# dsh-team-hub

Turn a single-user [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web instance into a secure, workspace-isolated team service.

dsh-team-hub sits between browsers and one local DSH instance. It adds login, roles, workspace isolation, RPC filtering, WebSocket event filtering, an admin console, and audit logging without modifying DSH itself.

> Status: v0.1. The first release focuses on secure shared access. Team knowledge/asset evolution is planned for v0.2.

## Why

DSH Web is intentionally single-user and normally binds to loopback. Sharing that URL directly would give every team member the same high-privilege host access.

dsh-team-hub provides:

- Username/password login
- First-login password change
- Admin / Member / Disabled roles
- Per-member workspace and session isolation
- Default-deny RPC policy
- Per-frame WebSocket event filtering
- Shared knowledge and repository directories
- Independent admin console
- Structured audit logs
- macOS launchd and Linux systemd service setup
- DSH compatibility self-test

## Requirements

- Node.js 22 or newer
- One reachable DSH Web instance, default `http://127.0.0.1:3080`
- macOS or Linux for service installation
- A trusted LAN. Do not expose v0.1 directly to the public internet.

## Quick start

```bash
npm install -g dsh-team-hub

dsh-team-hub init alice bob
dsh-team-hub start
```

The initializer prints an initial admin password once. Open:

```text
http://<server-lan-ip>:3090
```

Admin console:

```text
http://<server-lan-ip>:3090/admin
```

Every user must change their initial password on first login.

## CLI

```bash
dsh-team-hub init [--port 3090] [--upstream http://127.0.0.1:3080] [member ...]
dsh-team-hub start
dsh-team-hub selftest
dsh-team-hub user add <name> [--role member|admin]
dsh-team-hub user disable <name>
dsh-team-hub user enable <name>
dsh-team-hub user reset-password <name>
dsh-team-hub service install
dsh-team-hub service status
dsh-team-hub service uninstall
```

Runtime data is stored in:

```text
~/.dsh-team-hub
```

Override it with:

```bash
export DSH_TEAM_HUB_HOME=/path/to/data
```

## Security model

- Unknown DSH RPC methods are denied for members.
- Unknown WebSocket event types are dropped.
- Session/workspace ownership is checked for every guarded parameter.
- Member-facing list responses are filtered to their own resources.
- Privileged host, settings, credential, workspace-creation, and file-picker methods are member-disabled.
- Passwords use scrypt.
- Runtime config and session files are mode 0600.
- Audit events redact password/token/secret-like fields.

Read the full threat model in [docs/security.md](docs/security.md).

## Admin console

The console is served by the gateway at `/admin`:

- Overview
- User create/disable/enable/reset-password
- Workspace ownership
- Audit query
- System status and DSH compatibility self-test

Members keep using the normal DSH interface; they do not need to understand the gateway.

## Shared directories

The runtime home contains:

```text
shared/knowledge
shared/repo
```

These are the base shared locations available to member agents. Publishing/versioning/injecting reusable team assets is planned for v0.2.

## Upgrading DSH

DSH RPC and event protocols are internal and may change. After upgrading DSH:

```bash
dsh-team-hub selftest
npm test
```

Unknown new DSH methods are denied by default, which prevents accidental data exposure but may require a gateway update to expose new safe features.

## Roadmap

### v0.2 — Team knowledge evolution

- Candidate asset submission
- Admin review and publication
- Versioning and rollback
- AGENTS, prompts, skills, and templates
- Automatic injection into member sessions
- Usage feedback

### Later

- Codex/KimiWork read-only session aggregation
- Team analytics
- Optional HTTPS termination guidance
- Multi-host management

## Disclaimer

This is an independent community project and is not an official DeepSeek product.

## License

MIT
