# DSH compatibility

dsh-team-hub integrates with internal DSH HTTP RPC and WebSocket event protocols. These protocols are not yet a stable public API.

## Verified workflow

The v0.1 policy was derived from the DSH Web boot and collaboration flow:

- host.describe
- workspace.list
- session.list/search/history/create/prompt/cancel
- plugin and command inventory
- settings.mutate limited to ui-onboarding
- mux and host event streams

## After upgrading DSH

Run:

```bash
dsh-team-hub selftest
npm test
```

Then manually verify:

1. Admin login
2. Member login and forced password change
3. Member sees only their own workspace
4. Member can create a session and receive a streamed response
5. Member cannot access another member's session ID
6. Admin console shows users, workspaces, and audit events

## Failure policy

Unknown methods and events are denied/dropped. After an upgrade, a new DSH feature may be unavailable to members until the gateway policy is reviewed and updated.
