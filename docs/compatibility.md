# DSH compatibility

dsh-team-hub integrates with internal DSH HTTP RPC and WebSocket event protocols. These protocols are not yet a stable public API.

## Verified workflow

dsh-team-hub v0.3.0 supports DSH 0.2.0 and newer and is verified against DSH 0.2.x. Shared workspaces were verified through real Chrome for history loading, text-file preview, queued prompt submission, and immediate revocation.

DSH 0.2.0-rc.2 is verified with isolated Chrome profiles for two members: login, preview acknowledgement, own-workspace sidebar, General settings, session creation, a submitted prompt and gap-free session history. Cross-member history access is denied. With a synthetic loopback Anthropic Messages provider and test-only key, both profiles receive the rendered `READY` assistant response through the real DSH Host. This does not validate production DeepSeek inference. Real-browser approval/question interactions remain unverified. The original v0.1 policy covered:

- host.describe
- workspace.list
- session.list/search/history/create/prompt/cancel
- plugin and command inventory
- DSH 0.2 `settings/describe` exposes only a gateway-private, per-member `ui-settings-general.welcomeNoticeVersion`; `settings/mutate` accepts only its exact current preview acknowledgement. Legacy `settings.mutate` is denied.
- mux and host event streams

Member `session/fork`, `session/updateQueue`, workspace reordering, and message feedback editing RPCs are disabled until their nested payloads and message IDs receive a tenant-scope review; the browser may show an unavailable action. The member UI hides Host-wide plugin controls, model-provider configuration, built-in plugin and agent preset settings tabs, and the Host-wide usage card; unsupported routes stay denied server-side. The chat model and reasoning selector uses a separate reviewed per-session catalogue, and its controls render and change the per-session model in disposable Chrome acceptance; synthetic loopback model replies are verified, not real DeepSeek inference. `/api/dsh-usage/overview` remains denied (403); there is no per-member usage service. `permissionPresets/catalog` returns a fixed `workspace-write` choice. Durable sessions and streamed user-message history were tested only on a dedicated DSH Host with a disposable DSH_HOME, never the production Host. The installed production API lacks a safe session deletion endpoint; streamed approval/question interactions remain untested. Runtime-context snapshots retain provenance and sequence but redact assembled text and section metadata because they may contain Host-wide data. System and developer instruction text is likewise withheld from member history.

## After upgrading DSH

Run:

```bash
dsh-team-hub selftest
npm test
# From the repository checkout, with Chrome installed:
node scripts/acceptance.mjs --isolated-host --mock-model --browser alice bob
```

Then manually verify:

1. Admin login
2. Member login and forced password change
3. Member sees only their own workspace
4. Member can create a session and receive a successful streamed model response with configured production credentials (isolated acceptance uses a synthetic loopback provider only)
5. Member cannot access another member's session ID
6. Browser approval and user-question prompts are shown only to the session owner, accept one authorized answer, and reject replay/cross-member replies
7. Admin console shows users, workspaces, and audit events

## Failure policy

Unknown methods and events are denied/dropped. After an upgrade, a new DSH feature may be unavailable to members until the gateway policy is reviewed and updated.
