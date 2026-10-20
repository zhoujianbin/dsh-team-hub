# Security model

## Deployment boundary

dsh-team-hub v0.3.1 is designed for a trusted LAN. DSH grants powerful local capabilities, including workspace file changes and command execution. Do not expose the gateway directly to the public internet.

If remote access is required, place it behind a trusted HTTPS reverse proxy with network-level access control.

## Trust model

Members are expected to work inside their assigned workspace. The gateway applies default-deny routing and ownership filters to the audited DSH browser protocol, rather than providing OS-process or filesystem sandboxing. DSH agents run as the same host user and can execute tools; a malicious prompt or plugin may reach other host files. The filters block the following *browser API routes*, not every possible Agent side effect:

- Other members' workspaces and sessions
- Host file pickers and arbitrary host paths
- DSH settings and credentials
- Workspace creation/deletion
- Privileged DSH loopback-only methods
- Other members' approvals, questions, and event streams

Admins can grant a specific workspace to selected members. Shared members can view that workspace's sessions, preview text files through the scoped file API, and send queued text prompts. Workspace owners retain approval, interrupt, rename, and workspace-mutation rights. Shared subagent access is inherited only when the child cwd is canonically inside the accessible parent workspace; file previews reject traversal, absolute paths, missing paths, directories, symlink escapes, and revoked grants. Shared history replaces host absolute paths, images, files, and host-level instruction notices with safe placeholders.

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

- dsh-team-hub v0.3.1 supports DSH 0.2.0 and newer and is verified against DSH 0.2.x. DSH 0.1 and the deprecated v0.2.8 package are not supported with DSH 0.2.
- DSH `$events` approvals/questions are broadcast upstream. The gateway forwards only events whose Agent ID equals an owned Session ID and projects their known request fields. It permits one result only after delivery to a live, authenticated browser stream with a matching cookie, client ID and event ID; cancellation, disconnection, logout and ambiguous ownership fail closed. This bridge is mock-tested but has not passed full real-browser verification and is not production-ready.
- The private DSH launch-token log must be owned by the gateway user and mode `0600`; never leak its token or upstream session cookie downstream. Session projection keys alone are not a security boundary: only reviewed primitive/numeric/catalog/model fields pass, and unreviewed nested projections (including Host/plugin additions) are withheld. Pending/settled question mirrors retain typed prompts, options, plan intent, and answers without Host-added fields. Turn outlines retain only turn/seq and bounded prompt/response previews. Todo snapshots retain only content/status in history and the per-session projection mirror; goal lifecycle events and snapshots retain reviewed IDs, objective, phase, counters, and blocked-reason text without extension fields. Team roster/task mirrors require every member Session to be owned and redact failure diagnostics, raw task write scopes (which can contain foreign Host paths), and write-scope warnings; a foreign roster invalidates the entire mirror. Other browser functionality may be incomplete until safe per-tenant projections and real-browser validation are implemented. Provider/model catalogs retain reviewed selector fields and replace potentially sensitive provider failure diagnostics with generic messages. Workspace mutation results return only the member-owned workspace row or filtered owned IDs, never the complete shared Host order/archive/pin set. Member feedback responses retain only reviewed feedback item fields; rejected mutations return only a failure code, so conflict-current UI may be incomplete. Command catalog and execution responses retain only installed browser fields, including user-facing result text, not Host-added fields. Member skill catalog entries retain only name, description, routing hint and invocability; absolute skill paths and Host-added fields are omitted. Unknown ignorable plugin journal events are replaced by empty sequence-preserving markers in follow/page responses. Browser-known events without an explicit tenant-reviewed schema now fail closed rather than forwarding extensible data (or being disguised as ignorable); audited title, model selection, workspace-write permission preset, and seed-end events keep only typed fields; this can terminate session follow and history until their event families receive compatible projections. User message events project text-only content and reviewed provenance: agent/subagent sender IDs must be owned; session-reference recall requires every cited session to be member-owned and keeps only reviewed snapshot counters; attachments and unknown plugin source kinds currently fail closed, so some history and follow views may be incomplete. Developer message events keep reviewed text/tool-name change blocks and require a prior header citation for tool additions; private inline tool schemas and unreviewed producer sources are excluded. Turn and step boundary events retain only counters and reviewed reason kinds; raw provider failure messages and hook cancellation reasons are replaced with generic text. Audited subagent/catalog and subagent/descriptor events strip unknown fields, including continuation persona and tool scoping; tool/result removes tool-private meta and raw failure reason, projects only text model-facing result blocks, and drops unreviewed source fields (non-text result blocks currently fail closed), while request/header replaces internal tool schemas and configuration with a minimal browser-valid header; assistant reconnect baseline, compact run record shells, and live frame envelopes are schema-projected and revision-checked; reconnect chunk indices are checked against expanded run counts. Durable assistant/message content blocks and token usage retain only reviewed fields; assistant/attempt and assistant/message journal entries project reviewed compact text/tool-call and raw block/usage/finish stream records and strip adapter-private source replayState; other compact record kinds currently fail closed in follow and history pages. Live assistant chunks now strip unknown outer fields and project token usage to reviewed numeric counters, completed assistant text/reasoning/tool blocks now drop extra fields, and unsupported model attachment blocks terminate the follow stream until per-member attachment authorization exists; both session attachment fetch RPC variants and the unaudited file-reference candidate RPC are denied to members during that audit (image display and file autocomplete may be unavailable); model-authored text/tool arguments (finish frames now withhold adapter-private replay and failure metadata), model-facing tool messages and other recognized event data still contain extensible JSON, so do not claim comprehensive tenant isolation from these checks.
- DSH 0.2 known client selector is patchable in isolated tests; member settings/describe exposes only a synthetic per-member welcome-acknowledgement row, because raw rows contain shared Host configuration. The exact current preview notice acknowledgement is saved in a mode-0600 gateway-private file; all other settings and general member preferences remain unavailable. The preview acknowledgement was verified in a disposable real Chrome browser, but comprehensive browser workflows remain unverified. A separate DSH_HOME and Host on port 3191 permit real two-member Chrome session creation, prompt submission and history streaming. Its process is stopped and its entire temporary home removed after workspace unregister; no test sessions are left in the production Host, whose installed API has no supported session deletion RPC. A test-only loopback Anthropic Messages fixture now provides a successful `READY` assistant answer in both isolated Chrome member profiles. This is not a test of production DeepSeek credentials or live model inference. Runtime-context journal snapshots keep sequence and source shape but replace model-facing text and section metadata with safe placeholders. System and developer journal messages also preserve event shape and sequence while withholding their possibly shared instruction text.
- Member `session/fork`, `session/updateQueue`, workspace reordering, and message feedback editing RPCs are denied until nested request fields and message IDs are reviewed for cross-member references. Workspace archive and pin RPCs accept only an owned session ID.
- Member prompts currently support reviewed text blocks only; image/file attachments, cross-session references, and unreviewed prompt options are denied until their tenant scope is validated.
- The gateway does not provide HTTPS itself; use a trusted TLS and network boundary for any remote access.
- Login rate limiting is minimal.
- Agents share the host OS user, process access, compute, model quota, and LAN services; workspace API checks are **not** a filesystem sandbox.
- Selftest checks only the upstream inventory; independently test browser sessions, approvals, failure modes, and security policy after any DSH upgrade.
