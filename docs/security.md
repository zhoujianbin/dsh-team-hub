# Security model

## Deployment boundary

dsh-team-hub v0.1 is designed for a trusted LAN. DSH grants powerful local capabilities, including workspace file changes and command execution. Do not expose the gateway directly to the public internet.

If remote access is required, place it behind a trusted HTTPS reverse proxy with network-level access control.

## Trust model

Members are trusted to work inside their assigned workspace. They may modify files and run commands there. The gateway prevents them from accessing:

- Other members' workspaces and sessions
- Host file pickers and arbitrary host paths
- DSH settings and credentials
- Workspace creation/deletion
- Privileged DSH loopback-only methods
- Other members' approvals, questions, and event streams

Admins can see all users, workspaces, and audit events.

## Default deny

Every DSH RPC method is denied unless explicitly classified:

- plain read-only methods
- guarded methods with ownership checks
- explicitly denied privileged methods

Unknown WebSocket event types are dropped and audited. This biases upgrades toward temporary feature unavailability rather than data leakage.

## Authentication

- Passwords are hashed with scrypt.
- Initial passwords are random and must be changed at first login.
- Cookies are HttpOnly and SameSite=Lax.
- Session tokens are random 256-bit values.
- Config/session files are mode 0600.

## Audit

Audit events include login, denial, allowed RPC summary, admin operations, workspace creation, and compatibility checks.

Fields matching password/token/secret/credential/api-key patterns are redacted before writing.

## Remaining limitations

- v0.1 does not provide HTTPS by itself.
- Login rate limiting is intentionally minimal and should be hardened before broader deployment.
- Members can execute commands in their assigned workspace by design.
- A malicious member may still abuse compute, model quota, or LAN-accessible services from the host.
- The gateway relies on internal DSH protocols; run selftest after every DSH upgrade.
