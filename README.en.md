# dsh-team-hub

Turn a single-user [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web instance into a secure, workspace-isolated team service.

dsh-team-hub sits between browsers and one local DSH instance. It adds login, roles, workspace isolation, RPC filtering, WebSocket event filtering, an admin console, shared workspaces, and audit logging without modifying DSH itself.

[中文 README](README.md)

![dsh-team-hub admin console](docs/assets/admin-console.png)

> **dsh-team-hub is a team collaboration gateway for DSH.** Administrators manage members, workspaces, sharing grants, and audit records. Team members share one DSH service while keeping private workspaces and explicitly shared project workspaces.

> **Version and compatibility: v0.3.1 (shared-workspace collaboration shipped in v0.3.0) supports DSH 0.2.0 or newer (currently verified on DSH 0.2.x).** This is not OS-level multi-tenant isolation; agents still run under the same host account. See the security boundaries below.

## Why

DSH Web is intentionally single-user and normally binds to loopback. Sharing that URL directly would give every team member the same high-privilege host access.

dsh-team-hub provides:

- Username/password login with forced first-login password change
- Admin / Member / Disabled roles
- Per-member workspace and session isolation
- **Admin-managed per-workspace sharing grants**: members see their own workspaces plus workspaces shared with them
- Shared history, text-file previews, and queued messages
- Default-deny RPC policy and per-frame WebSocket filtering
- Independent admin console and structured audit logs
- macOS launchd and Linux systemd service setup
- DSH compatibility self-test

## Shared workspaces (v0.3.0)

Some projects need more than one person. An administrator can grant a specific workspace to one or more members. After signing in, a member sees:

- Their own workspace
- Any workspace the administrator shared with them

### Configure sharing

1. Open the admin console at `/admin`
2. Open **Workspaces**
3. Click **Set shared members** on a workspace
4. Use the two-column picker:
   - Left: members with access
   - Right: members without access
   - Select members and move them with `←` / `→`
5. Save; signed-in members see the change after refreshing

The workspace owner never needs a self-grant. Grants are stored in the gateway's private configuration and written to the audit log.

### What shared members can do

| Action | Workspace owner | Shared member |
| --- | --- | --- |
| View the workspace and history | Yes | Yes |
| Preview text files in the workspace | Yes | Yes |
| Send a text message | Yes | Yes (queued) |
| Interrupt a running turn | Yes | No |
| Approve tool requests / answer questions | Yes | No |
| Rename, create, delete, archive, or pin sessions | Yes | No |
| Rename, reorder, or configure the workspace | Yes | No |

Sending a message is the only write operation granted to collaborators. It accepts reviewed plain text only; images, file attachments, and cross-session references are rejected. Shared members cannot approve tool calls on the owner's behalf or modify the workspace itself.

### Revocation

Revocation takes effect immediately:

- New workspace/session requests are denied
- Open shared session streams stop
- File previews and shared message sending fail immediately

### Security boundaries

Shared access is keyed by workspace identity and trusted session/path mappings, not by a simple directory prefix:

- Workspace ownership and paths must come from the trusted DSH inventory
- Shared sessions must belong to a granted workspace
- Subagent sessions inherit access only when the parent is accessible and the child cwd stays strictly inside the parent workspace
- File previews reject absolute paths, `../` traversal, missing files, directories, and symlink escapes
- Authorization is rechecked after the upstream response to close revocation races
- Host absolute paths are replaced with workspace-relative paths
- Images and file attachments in shared history are replaced with safe placeholders

## Requirements

- Node.js 22 or newer
- **DSH Web 0.2.0 or newer** (currently verified on DSH 0.2.x; DSH 0.1 is not supported)
- macOS or Linux for service installation
- One reachable DSH Web instance, default `http://127.0.0.1:3080`
- A trusted LAN. Do not expose it directly to the public internet without HTTPS, a reverse proxy, and additional access controls

## DSH 0.2+ compatibility

This release targets DSH 0.2.0 and newer and uses DSH 0.2's private browser authentication, slash RPC, workspace/session inventory, and remote stream protocols. Verified on DSH 0.2.x:

- Member login, forced password change, and workspace isolation
- Session creation, model/reasoning selection, prompt submission, and history replay in private workspaces
- Cross-member history denial
- Shared-workspace history loading, text-file previews, and queued messages
- Immediate invalidation after sharing is revoked

DSH RPC and event protocols are internal and may change. New unknown methods are denied by default; an upgrade can temporarily disable a new feature but does not silently expand member privileges.

The gateway automatically reads the DSH Web launch token from an owner-only `0600` log. If the log is not in the default location, set:

```json
{ "dshWebLog": "/absolute/path/to/private/launch.log" }
```

The DSH upstream must be a credential-free loopback URL such as `http://127.0.0.1:3080`. Never put a token in the upstream URL or send DSH credentials to a member browser.

## Security boundaries and limitations

- **Not OS-level multi-tenant isolation.** All DSH agents run under the same host account and share model quota, host processes, and other host resources.
- Unknown DSH RPC methods are denied for members.
- Unknown WebSocket event types are dropped.
- Host file-picker, system settings, credential, workspace-creation, and workspace-deletion methods are member-disabled.
- Host-level plugin routes (pet, task board, SSH, skill center, etc.) are not exposed to members; corresponding UI entries are hidden.
- Shared members cannot approve tool requests on behalf of the owner.
- Images and file attachments in shared history are shown as placeholders to avoid leaking host or foreign file paths.
- Member settings remain read-only/limited; host model-provider, built-in plugin, and agent-preset settings are not exposed.
- `selftest` checks inventory and connectivity only, not every browser workflow.

Read the full threat model in [docs/security.md](docs/security.md).

## Quick start

```bash
npm install -g dsh-team-hub@0.3.1

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

Every user must change their initial password on first login. The administrator can then configure shared members under **Workspaces**.

## Upgrade

```bash
npm install -g dsh-team-hub@latest
```

Restart the gateway service (for example the macOS launchd service or Linux systemd unit) and refresh the browser. Admin assets are served with `no-store`, so a normal refresh loads the new UI.

Upgrading to v0.3.1 keeps existing members, workspaces, and sessions. New sharing grants start empty.

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

### Remote settings patch

DSH settings are designed for loopback access. When accessed through a LAN IP or domain, the settings page may report that settings are unavailable. This release recognizes known DSH 0.2 client expressions and applies the patch automatically; unknown versions are left untouched.

```bash
dsh-team-hub patch status
dsh-team-hub patch apply
dsh-team-hub patch rollback
```

If the DSH installation cannot be found, pass `--dsh-root <path>` or set `"dshRoot": "<path>"` in `config.json`.

Runtime data is stored in:

```text
~/.dsh-team-hub
```

Override it with:

```bash
export DSH_TEAM_HUB_HOME=/path/to/data
```

## Security model

- Unknown DSH RPC methods are denied for members
- Unknown WebSocket event types are dropped
- Every guarded parameter is checked for session/workspace ownership
- Member-facing lists contain only the member's own resources plus explicitly shared resources
- Shared file reads are confined to granted workspaces
- Shared messages are queued text only; interrupts, approvals, and workspace mutations remain owner-only
- Passwords use scrypt
- Runtime config and session files are mode 0600
- Audit events redact password/token/secret-like fields

## Admin console

The console is served by the gateway at `/admin`:

- Overview
- User create/disable/enable/reset-password
- Workspace ownership
- **Workspace sharing grants (two-column picker)**
- Audit query
- System status and DSH compatibility self-test

Members keep using the normal DSH interface; they do not need to understand the gateway.

## Shared directories

The runtime home contains:

```text
shared/knowledge
shared/repo
```

These are base shared locations available to member agents. Shared workspaces solve per-project collaboration; team knowledge publishing, versioning, and automatic injection remain on the roadmap.

## Upgrading DSH

This release supports DSH 0.2.0 and newer, but DSH's internal RPC and event protocols may still change. After upgrading DSH:

```bash
dsh-team-hub selftest
npm test
```

Unknown new methods are denied by default. If a new DSH version adds a safe feature that members should use, the gateway's allowlist and projections must be updated.

## Roadmap

### v0.3 — Shared workspace collaboration (current)

- Admin-managed workspace sharing grants
- Shared workspace, history, and text-file previews
- Queued text messages from shared members
- Immediate revocation

### Later

- Collaborative approvals and controlled interrupts for shared sessions
- Team knowledge base, prompts, skills, and templates with publishing/versioning/injection
- Codex/KimiWork read-only session aggregation
- Team analytics
- HTTPS reverse-proxy deployment guidance
- Multi-host management

## Disclaimer

This is an independent community project and is not an official DeepSeek product.

## License

MIT
