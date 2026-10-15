# dsh-team-hub

Turn a single-user [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) Web instance into a secure, workspace-isolated team service.

dsh-team-hub sits between browsers and one local DSH instance. It adds login, roles, workspace isolation, RPC filtering, WebSocket event filtering, an admin console, and audit logging without modifying DSH itself.

[中文 README](README.md)

> **Release status: npm v0.2.8 is deprecated; do not use it with DSH 0.2. v0.2.9 targets DSH 0.2.0-rc.2.** Real-browser approval/question interactions and production model credentials remain unverified; see limitations below. This is not OS-level multi-tenant isolation.

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

## DSH 0.2 authentication and limitations

The unreleased source has been tested against DSH 0.2.0-rc.2 for private token-to-cookie authentication, slash RPC, workspace/session inventory, and filtered remote streams. Two separate Chrome profiles against a disposable DSH_HOME also verified session creation, display of the per-session model and reasoning selector, prompt submission, readable history and rejection of cross-member history access. The disposable Host uses a loopback Anthropic Messages fixture with a test-only key; both real Chrome profiles received their own `READY` assistant replies. Production DeepSeek credentials and live inference remain unverified. The gateway automatically reads the DSH Web launch token from an owner-only `0600` log (default `~/dsh-web.log`). If necessary, set `"dshWebLog": "/absolute/path/to/private/launch.log"` in the gateway `config.json`. Use a credential-free loopback HTTP upstream such as `http://127.0.0.1:3080`; never put a token in the upstream URL, expose the log, or send DSH credentials to a member browser.

**In development:** DSH 0.2 enforces Agent ID = Session ID. The source now forwards only owner-attributed approval/question requests and binds replies to a previously delivered event, the current login cookie, and a live browser stream. Cross-member, unknown, and replayed results are rejected. Approval and question bridging has isolated mock tests but no complete real-browser validation yet; member messages accept reviewed text only, not image/file attachments or cross-session references; member session fork, queue update, workspace reordering and message feedback editing are disabled pending nested-payload and message-ownership review; Host-wide plugins, usage statistics and unreviewed settings mutations remain denied. Runtime-context snapshots retain sequence and source provenance, but assembled text and section metadata are redacted; shared system and developer instruction text is also withheld from member history to prevent Host-wide disclosure. A DSH 0.2 browser patch now recognizes the known settings selector in isolated tests; members receive only a synthetic member-owned preview-acknowledgement namespace, never shared Host settings. This exact acknowledgement is stored in a gateway-private mode-0600 file and was verified in a disposable Chrome browser. Host model-provider, built-in plugin, and agent preset settings tabs are hidden from members, and their routes remain denied. Other member settings forms and saved preferences remain unsupported pending comprehensive browser testing. This is not a verified production multi-tenant security boundary; `selftest` verifies inventory only, not full browser workflows. DSH agents still run under a shared host OS identity and share model quota and other host resources.

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

The in-development source targets DSH 0.2.0-rc.2 private browser authentication and stream/RPC protocols, not untested future DSH versions. Unauthenticated, starting, or failing plugin routes may return HTML/plain text; the gateway converts those to RPC errors, but the scoped member approval and question bridge still requires live browser verification.

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
