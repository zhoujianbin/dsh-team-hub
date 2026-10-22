# Changelog

## 0.3.2 (2026-10-22)

- Fix shared-session history stuck on `载入历史…` for ordinary DSH 0.2.1 journals. The member projection now covers every DSH 0.2.1 event type and user-message source that appears in normal agent work: `job/registered`, `job/settled` (labels, spawning calls and terminal details withheld), `working-directory/change` (withheld; can name operator paths), `time-context`, `working-directory`, PTC deferred-image `ptc-mode` messages and inbox splices, `skill-invocation` and `tool-goal` notices (prompt text replaced with placeholders), `compact-checkpoint` (correlated by compaction ID), image/file blocks inside `tool/ptc-dispatch` results (replaced with placeholders), `deliverables/presented` (absolute or parent-traversing paths reduced to the trailing name), and compaction summaries whose `shadowedRange` is a surface-position span (`start` may exceed `end`) with an authoritative non-contiguous `shadowedSeqs` set. A single unprojected entry previously failed the whole snapshot closed and left the chat loading forever.
- A rejected history snapshot now terminates the member stream with a sanitized `stream unavailable` error instead of being dropped silently, so the chat reports 历史加载失败 rather than hanging. `ws.frame-dropped` audit rows now carry protocol-only diagnostics (endpoint, frame/item/event type, projection key, session ID) to make future compatibility gaps diagnosable without recording payloads.

## 0.3.1 (2026-10-19)

- Fix shared session history failing with `session wire event requires headerSeq exactly when tool additions are present`. Developer messages that project tool removals, or whose tool-registry changes are replaced by a generic notice, now omit `headerSeq`; it is included only when the projected message still contains tool additions. This matches DSH's wire validator and keeps affected shared histories loadable.

## 0.3.0 (2026-10-19)

- Support DSH 0.2.0 and newer. Add admin-managed shared workspaces so members can see their own and granted workspaces, load shared history, preview text files, and send queued text messages while owners retain approvals and workspace mutations.
- Restore shared workspace history when sessions contain subagents or newer journal entries. Subagent sessions now inherit access from an accessible parent only while their canonical cwd stays inside that parent workspace; image and file attachments are replaced with member-safe placeholders, agent-instruction, tool-job notice, and host tool-registry messages are reduced to generic notices, model-selection notices are redacted, and fractional retry delays are accepted. This fixes the shared workspace being stuck on `Loading history` for sessions with delegated work.
- Allow members to preview text files in their own and shared sessions through `workspaceFiles/read`. The requested path is resolved inside the session's accessible workspace, rejecting absolute paths, traversal, missing files, symlink escapes, oversized ranges, and revoked grants; responses replace the Host absolute path with the workspace-relative path and recheck authorization after the upstream read.
- Replace the free-text workspace sharing prompt with a two-column picker: granted members on the left, the remaining enabled members on the right, multi-select rows and arrow buttons to move them. The dialog identifies the project by title and path, excludes the owner, reports save failures in place, and keeps keyboard and screen-reader semantics for the dialog and both listboxes. Admin UI assets are served with `no-store` so a deployment takes effect on a normal refresh.
- Add admin-managed per-workspace sharing grants for enabled members. Shared workspaces and their sessions appear alongside private workspaces, with authorized session history and live follow streams; grants persist in the private configuration and take effect after refresh or revocation. Shared members can view history, preview files, and send queued text prompts; they cannot interrupt a running turn, create sessions, rename, approve, or mutate workspaces. Enforce workspace/path/session binding and filter every member RPC or streamed response through current grants.

- Restore existing-session history for DSH 0.2 journals containing `skill-catalog` and `user-approval` user-message sources. Skill catalog prompt text and entries are replaced with a member-safe placeholder; unknown plugin sources remain denied.
- Downgrade historical Host `danger-full-access` permission and sandbox journal entries to the member-visible `workspace-write` projection instead of dropping the entire gap-sensitive history snapshot. Add a real Chrome existing-session probe that requires a `session/follow` snapshot and can verify prompt acceptance.
- Stop the member workspace auto-selector immediately after one expansion. DSH 0.2 uses a contenteditable composer, so the previous textarea-based completion test kept clicking the workspace once per second and toggled it open and closed.
- Creating a member account from the admin console now synchronously creates its private directory and DSH workspace before returning success, and includes the workspace in the response. Admin accounts do not receive a private workspace. If provisioning fails, the response reports failure and retains the new account disabled for administrator review; background reconciliation remains as a recovery path once the account is re-enabled.
- Treat an authenticated Team Hub administrator as paired for DSH browser status checks on both local and LAN API prefixes. This removes the upstream Device pairing required modal while leaving pairing routes denied to members; upstream launch tokens and cookies remain server-side. Successful logins now use a validated cache-busting shell URL, injected HTML and identity responses are non-cacheable, and a role-verified pre-app fetch guard prevents a persistent browser from reusing an older unpaired response. Authenticated administrators also receive a successful `/api/pair/heartbeat` response; previously its delayed `401 unpaired` caused the UI to enter the workspace briefly and then jump back to the pairing page. All authenticated administrator `/remote/*` HTTP requests are now normalized to their trusted loopback equivalents, preventing skin, usage, Git, filesystem events, and other Host routes from independently returning pairing-related 403 responses.

## 0.2.11

- Replace the member-visible `GET /api/dsh-usage/overview` and LAN `/remote/api/dsh-usage/overview` 403 response with a schema-compatible, zeroed, non-cacheable overview. Shared Host provider credentials, balances, model selection, spend, and other members’ usage remain withheld.
- Assert the usage request returns HTTP 200 in real Chrome acceptance and cover both route variants in the isolated gateway integration test.

## 0.2.10

- Accept DSH 0.2 non-loopback browser routes under `/remote/api/`: normalize the LAN WebSocket endpoint `/remote/api/remote.mux` to the authenticated upstream `/api/remote.mux`, and apply the same tenant-reviewed member RPC policy to `/remote/api/<method>`. This fixes an empty workspace sidebar when members access Team Hub through its LAN address while preserving same-origin, ownership, and credential isolation checks.
- Add integration coverage for the remote HTTP/WebSocket prefixes with a browser Origin and verify the real `lilei` test account through Chrome over the production LAN address.

## 0.2.9 (DSH 0.2.0-rc.2 adaptation)

- Read the owner-only DSH Web launch log privately; exchange its launch token for a DSH auth cookie without exposing either credential to members. Bound authenticated upstream RPC waits and member-proxied unary RPCs, returning sanitized DSH error envelopes for Host/network failures; sanitize diagnostics before logging or rendering compatibility checks; token-bearing static requests are rejected before private authentication.
- Move member RPCs to typed slash methods and remote.mux streams; project member-owned workspace/session data, deny unknown requests, host plugins, preset changes, and unscoped host events. Member session prompts accept reviewed text blocks only, denying attachments, cross-session references, and unreviewed options. Fork, queue update, workspace reordering, and message feedback editing requests remain disabled until their nested payloads and message IDs are tenant-reviewed. Feedback listing accepts only an owned session ID. Archive and pin operations accept only an owned session ID. Session/workspace rename accepts only an owned ID and a string title, denying injected nested fields; cancellation, projection reads, skill listing, and command inventory accept only their owned session/agent ID. Allowed slash commands accept only the owned agent ID, command line, and empty attachments. Model selection request fields are restricted to an owned session and flattened primitive provider, model, and optional reasoning effort; interactive model switching was verified in disposable Chrome against DSH 0.2. Only explicitly projected known session values (catalog, title, list metadata, model selection, stats, preset) pass; owned child catalog descriptors validate mode, timestamp and label types before exposure; skill catalog results remove absolute paths and unrecognized provider fields; message-feedback results whitelist fields and reduce conflict failures to codes; slash command catalogs and execution results strip unrecognized metadata; session rename and model-selection receipts whitelist their reviewed fields; workspace mutation receipts keep owned rows and IDs only; public model catalogs drop unknown fields and opaque provider failure diagnostics; other provider projections are withheld pending review, and history-page subagent addresses require both parent and child ownership; page responses reject foreign child catalog records and discard unrecognized outer metadata. Follow snapshots, opted-in assistant reconnect baselines/live frame envelopes and typed chunk fields, and prompt/cancel/queue acknowledgments whitelist outer fields rather than forwarding Host-added metadata; missing baselines and assistant revision gaps fail closed. Assistant finish chunks remove adapter-private replay envelopes and raw failure diagnostics; durable assistant-message source replayState and assistant attempt/message compact stream record metadata are also omitted from follow and history pages while supported tool-call argument runs and standard raw model block/usage chunks retain their browser semantics; durable assistant message blocks, token accounting and tool/call events and tool/result message sources and text blocks now strip unknown metadata; journal surface replacements and source sequence citations are schema-validated, required for message-producing events, forbidden on log-only events, and include projected developer-message tool changes without inline schemas and typed system-prompt text/source fields; user message provenance now enforces owned sender IDs and text-only blocks, projecting fully owned recall metadata while denying foreign references and unreviewed attachments; turn and step boundaries whitelist counters and redact raw failure/hook diagnostics; approval/question decisions reserve their delivered event until upstream acknowledgment, allowing retry on rejection while preventing concurrent replies and late-settlement races. Completed assistant text/reasoning/tool blocks omit extra fields; unsupported assistant attachment blocks terminate follow and member attachment fetch and unprojected file-reference candidate RPCs are denied until authorization is reviewed. Foreign child IDs in ordinary journal event data or snapshot/page records are rejected; midstream ownership loss and journal sequence gaps terminate the follow stream instead of silently dropping events. Unknown ignorable plugin journal entries retain sequence positions but replace opaque event data with a browser-skippable empty marker; known event types retain their semantics even if flagged ignorable in follow and history pages; unknown non-ignorable event types fail closed and known event envelopes drop Host-added fields. Owned subagent/catalog events use the installed versioned child schema and strip unknown fields; child subagent/descriptor events strip private persona, tool scoping, and model options; tool/result events omit opaque tool metadata and raw failure reasons, and request/header removes assembled tool schemas, adapter defaults and Host request configuration in follow and paged history.
- Remove generic raw passthrough for browser-known session journal events without tenant-reviewed data schemas; fail closed on history/follow instead of leaking nested Host or foreign member metadata. Title, model selection, workspace-write permission preset, plan mode, agent preset, approval audit/policy, workspace-write sandbox, owned message/session feedback, slash command audit, LLM retry lifecycle, redacted auxiliary title/search requests, changed-workspace turn markers, pending inbox splices, team peer messages and late question replies with reviewed user-message sources, todo and goal lifecycle journals with member-only typed projection mirrors, pending/settled question histories, and typed turn outlines, legacy reminder schedule events, owned team-member/task/queued-text/delivery events and a member-only typed team projection mirror that withholds raw task write scopes in both history and live projections, child model-selection policies containing only provider/model pairs, image-offload sequence/index targets without Host image paths, hook lifecycle entries without stderr, nested tool dispatch with opaque arguments replaced by `{}`, workflow lifecycle records requiring owned child Sessions, compaction lifecycle/summary metering without raw model output, owned log-delivery receipts and seed-end events now receive typed projections (command/provider failure diagnostics are generic); other follow/browser event families remain incomplete until projected and tested.
- Add isolated mock-DSH gateway integration tests (including member create → prompt → follow/control, cross-owner denial and nested secret filtering) and live, disposable two-member acceptance with authenticated workspace cleanup (including session inventory, settings read/deny, cross-member session creation denial, and admin overview workspace/audit checks). Durable browser test sessions are created only on a dedicated disposable DSH_HOME (never the production Host), after which the isolated Host is stopped and its home removed. Two-member Chrome acceptance opens the per-session model and reasoning selector, submits prompts, reads gap-free session history and rejects cross-member history access. Runtime-context snapshots retain sequence but redact Host-wide assembled text and section metadata; system/developer journal messages keep their sequence and shape but replace potentially shared instruction text with placeholders; an isolated loopback Anthropic Messages fixture now verifies successful `READY` assistant replies in both Chrome member profiles without production model credentials. The fixture does not prove real DeepSeek credentials or inference.
- Add owner-attributed member approval/question waterfalls and one-use replies bound to authenticated browser event streams; reject cross-member responses, replay, cancellation, duplicated multi-select choices, empty/oversized plan-review and approval call IDs in persisted question and approval histories, and unknown event metadata (including approval display-reason map keys) in isolated tests. Also validate login return paths, WebSocket Origin and logout revocation.
- Recognize and verify the DSH 0.2 settings persistence selector with exact backup/rollback checks; return members only a synthetic per-member welcome-acknowledgement namespace, never Host schemas/values. Persist this exact preview acknowledgement in a private gateway file, verified in isolated Chrome acceptance; other member settings forms and preferences remain unsupported.
- Known gap: member General settings renders and private preview acknowledgement works; Host model-provider, built-in plugin and agent preset settings tabs are hidden because the corresponding routes remain denied, while other settings mutations and real-browser approval/question flows remain unverified. Do not claim full DSH 0.2 compatibility until real-browser approval/question interactions, remaining unsupported operations, and production inference are verified.

## 0.2.8 (deprecated on npm: incomplete DSH 0.2 auth/RPC compatibility)

- 兼容 DSH 0.2.x 及更高版本的非 JSON 上游响应：网关和兼容性自检现在会安全处理 HTML/纯文本错误页，不再因 `response.json()` 直接崩溃。
- 上游 RPC 失败时保留 HTTP 状态和可读错误信息，便于定位 DSH 版本、认证或启动顺序问题。
- 发布流程继续由 `v*` Git tag 触发，并校验 tag 与 `package.json` 版本一致后通过 npm Trusted Publishing 发布。

## 0.2.7

- 修复 Admin 控制台「重置密码 / 创建用户」点击后提示不显示的问题：renderUsers
  重写 #app.innerHTML 会清空 #message，改用 pendingMessage 在渲染后恢复提示

## 0.2.6

- 修复 /admin 二次问题：admin-ui 资源改为绝对路径 /admin/...，
  /admin 精确匹配 302 到 /admin/（杜绝无尾斜杠时相对路径解析到根目录导致
  样式/脚本 404、页面显示「加载中…」）

## 0.2.5

- 修复管理后台 /admin 返回 Buffer JSON 而非 HTML 的异常（Issue #1）
- 新增远程设置补丁：启动时自动将 dsh 客户端 settings 强制为 host 模式，
  修复局域网/域名访问时「加载提供方目录失败: settings are unavailable in this browser」
  （Issue #2，对应 dsh 上游 0.1.1-rc.2 回归，参考 dsh-passwords v2.6.0 方案）。
  提供 `dsh-team-hub patch status|apply|rollback` 命令（幂等、带备份、可回滚）
- 新增 config.dshRoot 可选字段，用于显式指定 dsh 安装目录

## 0.2.4

- 修复网关重启时上游未就绪导致成员工作区消失（启动重试 + 每 5 分钟兜底重同步）
- 拒绝响应的错误码映射为 DSH 客户端可识别的值，不再弹 zod 原始错误

## 0.2.3

- 宿主级插件功能（任务看板/SSH/技能中心/移动端远程）对成员隐藏并拦截路由

## 0.2.2

- 转发请求统一改写 Origin/Referer 为上游源，修复插件自定义路由 403

## 0.2.1

- 放行 dsh-web-ui 插件套件的只读设置描述

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
