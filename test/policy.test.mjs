import test from "node:test";
import assert from "node:assert/strict";
import { createOwnership, guardMemberRequest, filterMemberResponse, learnWorkspace, learnSession, userRoot } from "../src/policy.mjs";
import { defaultConfig } from "../src/config.mjs";
import { createUser } from "../src/users.mjs";

function fixture() {
  const config = defaultConfig("/tmp/dsh-team-hub-test");
  createUser(config, { name: "admin", role: "admin", password: "admin-pass-1" });
  createUser(config, { name: "alice", role: "member", password: "alice-pass-1" });
  createUser(config, { name: "bob", role: "member", password: "bob-pass-123" });
  const ownership = createOwnership();
  learnWorkspace(config, ownership, { workspaceId: "wa", path: "/tmp/dsh-team-hub-test/workspaces/alice", sessionIds: ["sa"] });
  learnWorkspace(config, ownership, { workspaceId: "wb", path: "/tmp/dsh-team-hub-test/workspaces/bob", sessionIds: ["sb"] });
  return { config, ownership, alice: config.users[1], bob: config.users[2] };
}

test("member can list only own workspaces and sessions", () => {
  const { ownership, alice } = fixture();
  const value = filterMemberResponse({ ownership, user: alice, method: "workspace.list", value: {
    items: [{ workspaceId: "wa" }, { workspaceId: "wb" }], archivedSessionIds: ["sa", "sb"]
  }});
  assert.deepEqual(value.items, [{ workspaceId: "wa" }]);
  assert.deepEqual(value.archivedSessionIds, ["sa"]);
});

test("workspace mutation receipts retain only owned IDs and reviewed row fields", () => {
  const { ownership, alice } = fixture();
  const project = (method, value) => filterMemberResponse({ ownership, user: alice, method, value });
  const workspace = { workspaceId: "wa", path: "/tmp/dsh-team-hub-test/workspaces/alice",
    title: "Alice", createdAt: "now", updatedAt: "now", sessionIds: ["sa", "sb"], secret: "hidden" };
  assert.deepEqual(project("workspace/rename", { workspace, secret: "hidden" }),
    { workspace: { workspaceId: "wa", path: workspace.path, title: "Alice",
      createdAt: "now", updatedAt: "now", sessionIds: ["sa"] } });
  assert.deepEqual(project("workspace/archiveSession", { archivedSessionIds: ["sa", "sb"] }),
    { archivedSessionIds: ["sa"] });
  assert.deepEqual(project("workspace/pinSession", { pinnedSessionIds: ["sb", "sa"] }),
    { pinnedSessionIds: ["sa"] });
  assert.throws(() => project("workspace/rename", { workspace: { ...workspace, workspaceId: "wb" } }));
});
test("member cannot use another member session", () => {
  const { config, ownership, alice } = fixture();
  const result = guardMemberRequest({ config, ownership, user: alice, method: "session.prompt", payload: { sessionId: "sb", text: "x" } });
  assert.equal(result.ok, false);
});

test("rename RPCs accept only their scoped ID and title", () => {
  const { config, ownership, alice } = fixture();
  const guard = (method, request, extra = {}) => guardMemberRequest({ config, ownership, user: alice, method,
    payload: { args: { request, ...extra } } }).ok;
  assert.equal(guard("session/rename", { sessionId: "sa", title: "mine" }), true);
  assert.equal(guard("workspace/rename", { workspaceId: "wa", title: "ours" }), true);
  assert.equal(guard("session/rename", { sessionId: "sa", title: "mine", foreign: { sessionId: "sb" } }), false);
  assert.equal(guard("workspace/rename", { workspaceId: "wa", title: "ours", foreign: { workspaceId: "wb" } }), false);
  assert.equal(guard("session/rename", { sessionId: "sa", title: "mine" }, { foreign: { sessionId: "sb" } }), false);
  assert.equal(guard("workspace/rename", { workspaceId: "wa", title: "ours" }, { foreign: { workspaceId: "wb" } }), false);
});

test("workspace archive and pin mutations accept only owned session ID", () => {
  const { config, ownership, alice } = fixture();
  for (const method of ["workspace/archiveSession", "workspace/unarchiveSession",
    "workspace/pinSession", "workspace/unpinSession"]) {
    const guard = (request, extra = {}) => guardMemberRequest({ config, ownership, user: alice, method,
      payload: { args: { request, ...extra } } }).ok;
    assert.equal(guard({ sessionId: "sa" }), true, method);
    assert.equal(guard({ sessionId: "sb" }), false, method);
    assert.equal(guard({ sessionId: "sa", linked: { sessionId: "sb" } }), false, method);
    assert.equal(guard({ sessionId: "sa" }, { linked: { sessionId: "sb" } }), false, method);
  }
});

test("session projection, skill, and feedback list only accept owned session IDs", () => {
  const { config, ownership, alice } = fixture();
  for (const method of ["session/projections", "skills/list", "messageFeedback/list"]) {
    const guard = (request, extra = {}) => guardMemberRequest({ config, ownership, user: alice, method,
      payload: { args: { request, ...extra } } }).ok;
    assert.equal(guard({ sessionId: "sa" }), true, method);
    assert.equal(guard({ sessionId: "sb" }), false, method);
    assert.equal(guard({ sessionId: "sa", include: { sessionId: "sb" } }), false, method);
    assert.equal(guard({ sessionId: "sa" }, { include: { sessionId: "sb" } }), false, method);
  }
});

test("command inventory accepts only the owned agent ID", () => {
  const { config, ownership, alice } = fixture();
  const guard = args => guardMemberRequest({ config, ownership, user: alice,
    method: "commands/list", payload: { args } }).ok;
  assert.equal(guard({ agentId: "sa" }), true);
  assert.equal(guard({ agentId: "sb" }), false);
  assert.equal(guard({ agentId: "sa", context: { sessionId: "sb" } }), false);
});

test("session model selection only accepts reviewed primitive model fields", () => {
  const { config, ownership, alice } = fixture();
  const guard = (request, extra = {}) => guardMemberRequest({ config, ownership, user: alice,
    method: "session/selectModel", payload: { args: { request, ...extra } } }).ok;
  const base = { sessionId: "sa", provider: "p", model: "m", reasoningEffort: "low" };
  assert.equal(guard(base), true);
  assert.equal(guard({ ...base, sessionId: "sb" }), false);
  assert.equal(guard({ ...base, selected: { provider: "p", model: "m", sessionId: "sb" } }), false);
  assert.equal(guard({ ...base, metadata: { sessionId: "sb" } }), false);
  assert.equal(guard(base, { metadata: { sessionId: "sb" } }), false);
});

test("session cancellation cannot carry extra Host fields", () => {
  const { config, ownership, alice } = fixture();
  const guard = request => guardMemberRequest({ config, ownership, user: alice, method: "session/cancel",
    payload: { args: { request } } }).ok;
  assert.equal(guard({ sessionId: "sa" }), true);
  assert.equal(guard({ sessionId: "sb" }), false);
  assert.equal(guard({ sessionId: "sa", context: { sessionId: "sb" } }), false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "session/cancel",
    payload: { args: { request: { sessionId: "sa" }, context: { sessionId: "sb" } } } }).ok, false);
});

test("member prompt accepts reviewed text only and denies nested foreign references", () => {
  const { config, ownership, alice } = fixture();
  const guard = request => guardMemberRequest({ config, ownership, user: alice, method: "session/prompt",
    payload: { args: { request } } });
  const base = { sessionId: "sa", requestId: "own", mode: "queue",
    content: [{ type: "text", text: "hello" }] };
  assert.equal(guard(base).ok, true);
  assert.equal(guard({ ...base, clientTimeZone: "Asia/Shanghai" }).ok, true);
  for (const request of [
    { ...base, clientTimeZone: { sessionId: "sb" } },
    { ...base, clientTimeZone: "Asia/../../foreign" },
    { ...base, content: [{ type: "image", attachmentId: "foreign" }] },
    { ...base, content: [{ type: "text", text: "hello", sessionId: "sb" }] },
    { ...base, content: [{ type: "text", text: "hello", metadata: { sessionId: "sb" } }] },
    { ...base, references: [{ sessionId: "sb" }] },
    { ...base, model: { provider: "private", model: "secret" } },
    { ...base, content: [] },
    { ...base, mode: "unsafe" },
  ]) assert.equal(guard(request).ok, false);
});

test("session.create defaults to own workspace", () => {
  const { config, ownership, alice } = fixture();
  const result = guardMemberRequest({ config, ownership, user: alice, method: "session.create", payload: {} });
  assert.equal(result.ok, true);
  assert.equal(result.payload.workspaceId, "wa");
});

test("unknown or privileged methods are denied", () => {
  const { config, ownership, alice } = fixture();
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "settings.describe", payload: {} }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "future.method", payload: {} }).ok, false);
  for (const method of ["workspace/insertBefore", "workspace/insertSessionBefore"])
    assert.equal(guardMemberRequest({ config, ownership, user: alice, method,
      payload: { args: { request: { workspaceId: "wa", sessionId: "sa", foreign: { sessionId: "sb" } } } } }).ok, false, method);
  for (const method of ["session/fork", "session/updateQueue"])
    assert.equal(guardMemberRequest({ config, ownership, user: alice, method,
      payload: { args: { request: { sessionId: "sa", metadata: { sessionId: "sb" } } } } }).ok, false, method);
  for (const method of ["session/attachment", "session.attachment"])
    assert.equal(guardMemberRequest({ config, ownership, user: alice, method,
      payload: { args: { request: { sessionId: "sa", attachmentId: "foreign" } } } }).ok, false, method);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "fileReferences/list",
    payload: { args: { agentId: "sa", query: "@" } } }).ok, false);
});

test("skill catalog omits absolute Host paths and plugin extras", () => {
  const { ownership, alice } = fixture();
  const project = value => filterMemberResponse({ ownership, user: alice, method: "skills/list", value });
  assert.deepEqual(project({ skills: [{ name: "safe", description: "Use safely",
    whenToUse: "when asked", modelInvocable: true, path: "/other/member/private/SKILL.md",
    providerSecrets: { token: "hidden" } }], hostSecret: "hidden" }),
    { skills: [{ name: "safe", description: "Use safely",
      whenToUse: "when asked", modelInvocable: true }] });
  assert.throws(() => project({ skills: [{ name: "unsafe", description: 1, modelInvocable: false }] }));
});
test("legacy settings mutations never reach the shared Host", () => {
  const { config, ownership, alice } = fixture();
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "settings.mutate", payload: { ns: "ui-onboarding", ops: [] } }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "settings.mutate", payload: { ns: "llm", ops: [] } }).ok, false);
});

test("member preset catalog allows only workspace-write without Host custom values", () => {
  const { config, ownership, alice } = fixture();
  const request = payload => guardMemberRequest({ config, ownership, user: alice, method: "permissionPresets/catalog", payload });
  assert.equal(request({ args: {} }).ok, true);
  assert.equal(request({ args: { id: "admin" } }).ok, false);
  const value = { options: [{ value: "danger-full-access", name: "Host secret", description: "tenant-leak" }], defaultOptions: [], defaultPreset: "danger-full-access" };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "permissionPresets/catalog", value }),
    { options: [{ value: "workspace-write", name: "Workspace Write" }],
      defaultOptions: [{ value: "workspace-write", name: "Workspace Write" }], defaultPreset: "workspace-write" });
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "permissionPresets/catalog", value: {} }));
});

test("settings/describe exposes only a synthetic read-only member mirror", () => {
  const { config, ownership, alice } = fixture();
  const guard = (method, payload) => guardMemberRequest({ config, ownership, user: alice, method, payload });
  assert.equal(guard("settings/describe", { args: {} }).ok, true);
  assert.equal(guard("settings/describe", { args: { ns: "secrets" } }).ok, false);
  for (const method of ["settings/update", "settings/replace", "settings/mutate", "settings/openDocument"])
    assert.equal(guard(method, { args: {} }).ok, false, method);
  const value = { writable: true, hasDocument: true, namespaces: [{ ns: "llm", schema: { secret: "tenant-leak" }, value: { apiKey: "tenant-leak" } }] };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "settings/describe", value }),
    { writable: false, hasDocument: false, namespaces: [] });
  assert.equal(value.namespaces[0].value.apiKey, "tenant-leak", "projection does not mutate host response");
  for (const malformed of [null, {}, { namespaces: {} }, { writable: 1, hasDocument: false, namespaces: [] }])
    assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "settings/describe", value: malformed }));
});

test("model provider catalog strips Host metadata and opaque failure details", () => {
  const { ownership, alice } = fixture();
  const project = (method, value) => filterMemberResponse({ ownership, user: alice, method, value });
  assert.deepEqual(project("llm/listProviders", [{ id: "p", name: "Provider", credentials: "hidden" }]),
    [{ id: "p", name: "Provider" }]);
  const result = project("session/modelCatalog", { default: { provider: "p", model: "m", secret: "hidden" },
    routableProviders: ["p"], groups: [{ id: "p", name: "Provider", secret: "hidden", models: [{
      id: "m", name: "Model", reasoning: { efforts: [{ id: "low", name: "Low", secret: "hidden" }],
        defaultEffort: "low", secret: "hidden" }, secret: "hidden" }] }],
    failures: [{ id: "bad", name: "Broken", message: "/private/token=hidden", secret: "hidden" }],
    secret: "hidden" });
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.deepEqual(result.failures, [{ id: "bad", name: "Broken", message: "模型目录暂不可用" }]);
  assert.deepEqual(result.groups[0].models[0].reasoning, {
    efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" });
});
test("session rename and model receipts discard Host-added fields", () => {
  const { ownership, alice } = fixture();
  const project = (method, value) => filterMemberResponse({ ownership, user: alice, method, value });
  assert.deepEqual(project("session/rename", { title: "Own", seq: 4, secret: "hidden" }),
    { title: "Own", seq: 4 });
  assert.deepEqual(project("session/selectModel", { selected: { provider: "p", model: "m",
    reasoningEffort: "low", secret: "hidden" }, secret: "hidden" }),
    { selected: { provider: "p", model: "m", reasoningEffort: "low" } });
  assert.throws(() => project("session/selectModel", { selected: { provider: "p", model: 1 } }));
});
test("member command catalog and outcome strip Host-added fields", () => {
  const { ownership, alice } = fixture();
  const project = (method, value) => filterMemberResponse({ ownership, user: alice, method, value });
  assert.deepEqual(project("commands/list", [{ name: "help", description: "Help",
    definitionId: "builtin-help", input: { hint: "topic", attachments: false, secret: "hidden" },
    hostSecret: "hidden" }]),
    [{ name: "help", description: "Help", definitionId: "builtin-help",
      input: { hint: "topic", attachments: false } }]);
  assert.deepEqual(project("commands/execute", { commandId: "id", hostSecret: "hidden",
    result: { kind: "success", text: "ok", sourceEventSeq: 3, secret: "hidden" } }),
    { commandId: "id", result: { kind: "success", text: "ok", sourceEventSeq: 3 } });
  assert.throws(() => project("commands/list", [{ name: "x", description: "ok", input: { hint: {} } }]));
});
test("member feedback responses remove Host extensions and conflict payload", () => {
  const { ownership, alice } = fixture();
  const project = (method, value) => filterMemberResponse({ ownership, user: alice, method, value });
  const entry = { messageId: "m", rating: "positive", version: "v", createdAt: 1,
    updatedAt: 2, note: "good", hostSecret: "hidden" };
  const expected = { messageId: "m", rating: "positive", version: "v",
    createdAt: 1, updatedAt: 2, note: "good" };
  assert.deepEqual(project("messageFeedback/list", { ok: true, value: { items: [entry], hostSecret: "hidden" } }),
    { ok: true, value: { items: [expected] } });
  assert.throws(() => project("messageFeedback/list", { ok: true, value: { items: [{ ...entry, note: {} }] } }));
});
test("feedback list is scoped and feedback mutations remain unavailable", () => {
  const { config, ownership, alice } = fixture();
  const guard = (method, request) => guardMemberRequest({ config, ownership, user: alice, method,
    payload: { args: { request } } }).ok;
  assert.equal(guard("messageFeedback/list", { sessionId: "sa" }), true);
  assert.equal(guard("messageFeedback/list", { sessionId: "sb" }), false);
  for (const method of ["messageFeedback/put", "messageFeedback/delete"]) {
    assert.equal(guard(method, { sessionId: "sa" }), false, method);
    assert.equal(guard(method, { sessionId: "sa", messageId: "foreign" }), false, method);
  }
});

test("members cannot switch permission preset away from workspace-write", () => {
  const { config, ownership, alice } = fixture();
  const exec = line => ({ args: { agentId: "sa", line, submittedAttachments: [] } });
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: exec("/permission") }).ok, true);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: exec("/permission workspace-write") }).ok, true);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: exec("/permission danger-full-access") }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: exec("/permission custom") }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: exec("/compact") }).ok, true);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute",
    payload: { args: { ...exec("/compact").args, context: { sessionId: "sb" } } } }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute",
    payload: { args: { ...exec("/permission").args, permission: "danger-full-access" } } }).ok, false);
});

test("nested args.request ownership fields are guarded (Typert remotes)", () => {
  const { config, ownership, alice } = fixture();
  const own = { args: { request: { sessionId: "sa", title: "mine" } } };
  const other = { args: { request: { sessionId: "sb", title: "not mine" } } };
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "session/rename", payload: own }).ok, true);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "session/rename", payload: other }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: { args: { agentId: "sb", line: "/x" } } }).ok, false);
});

test("agentId is treated as session ownership (commands/execute)", () => {
  const { config, ownership, alice } = fixture();
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: { args: { agentId: "sa", line: "/help", submittedAttachments: [] } } }).ok, true);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "commands/execute", payload: { args: { agentId: "sb", line: "/help", submittedAttachments: [] } } }).ok, false);
});

test("workspace view overrides earlier admin guess for its sessions", () => {
  const { config, ownership } = fixture();
  ownership.sessionOwner.set("s9", "admin"); // host/session-added 缺 cwd 时的猜测
  learnWorkspace(config, ownership, { workspaceId: "wx", path: "/tmp/dsh-team-hub-test/workspaces/alice", sessionIds: ["s9"] });
  assert.equal(ownership.sessionOwner.get("s9"), "alice");
});

test("cwd ownership is based on member workspace roots", () => {
  const { config, ownership } = fixture();
  learnSession(config, ownership, "s2", "/tmp/dsh-team-hub-test/workspaces/bob/project", null);
  assert.equal(ownership.sessionOwner.get("s2"), "bob");
});


test("conflicting workspace claims quarantine session and workspace IDs", () => {
  const { config, ownership, alice, bob } = fixture();
  learnWorkspace(config, ownership, { workspaceId: "wa", path: userRoot(config, bob), sessionIds: ["sa"] });
  assert.equal(ownership.workspaceOwner.get("wa"), "ambiguous");
  assert.equal(ownership.sessionOwner.get("sa"), "ambiguous");
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "session/rename", payload: { args: { request: { sessionId: "sa", title: "x" } } } }).ok, false);
  assert.equal(filterMemberResponse({ ownership, user: alice, method: "session/list", value: { items: [{ sessionId: "sa" }] } }).items.length, 0);
  assert.equal(filterMemberResponse({ ownership, user: bob, method: "session/list", value: { items: [{ sessionId: "sa" }] } }).items.length, 0);
  learnWorkspace(config, ownership, { workspaceId: "wa", path: userRoot(config, alice), sessionIds: ["sa"] });
  assert.equal(ownership.workspaceOwner.get("wa"), "ambiguous");
  assert.equal(ownership.sessionOwner.get("sa"), "ambiguous");
});

test("cwd claims conflicting with existing session ownership remain quarantined", () => {
  const { config, ownership } = fixture();
  learnSession(config, ownership, "sb", userRoot(config, { name: "alice" }));
  assert.equal(ownership.sessionOwner.get("sb"), "ambiguous");
  learnSession(config, ownership, "sb", userRoot(config, { name: "bob" }));
  assert.equal(ownership.sessionOwner.get("sb"), "ambiguous");
});

test("canonical cwd rejects symlinks crossing member boundaries", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-team-policy-"));
  try {
    const { config, ownership, alice } = fixture();
    config.workspaceRoot = path.join(base, "workspaces");
    const own = path.join(config.workspaceRoot, "alice");
    const foreign = path.join(config.workspaceRoot, "bob");
    await fs.mkdir(own, { recursive: true });
    await fs.mkdir(foreign, { recursive: true });
    await fs.symlink(foreign, path.join(own, "foreign"));
    const guard = guardMemberRequest({ config, ownership, user: alice, method: "session/create", payload: { args: { request: { cwd: path.join(own, "foreign"), workspaceId: "wa" } } } });
    assert.equal(guard.ok, false);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("slash RPC lists filter IDs, drop aggregate metadata and reject malformed data", () => {
  const { config, ownership, alice } = fixture();
  const allowed = payload => guardMemberRequest({ config, ownership, user: alice, method: "session/list", payload }).ok;
  assert.equal(allowed({ args: { _request: {} } }), true);
  assert.equal(allowed({ args: { _request: {}, injected: "sb" } }), false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "workspace/follow", payload: { args: {} } }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "future/unsafe", payload: { args: {} } }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "agentPresets/list", payload: { args: {} } }).ok, false);
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/list", value: { items: [{ sessionId: "sa" }, { sessionId: "sb" }], cursor: "secret", total: 2 } }), { items: [{ sessionId: "sa" }] });
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/search", value: { items: [{ sessionId: "sa" }, { sessionId: "sb" }], hasMore: true, total: 2 } }), { items: [{ sessionId: "sa" }], hasMore: false });
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/list", value: { items: [{ sessionId: "sa", updatedAt: 1, secret: "operator-token" }] } }), { items: [{ sessionId: "sa", updatedAt: 1 }] });
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/list", value: { total: 2 } }), /invalid/);
});

test("session projections unary result removes foreign child catalog metadata", () => {
  const { ownership, alice } = fixture();
  const value = { asOfSeq: 4, values: { subagentCatalog: [{ id: "sb", mode: "continuable", label: "private" },
    { id: "sa", mode: "one-shot", createdAt: 3, secret: "host" }], unknownHostPlugin: { secret: "private" },
    modelSelection: { lastUsed: { provider: "mock", model: "model", apiKey: "private" }, next: null, host: "private" },
    sessionListMetadata: { blank: true, lastPromptAt: null, operatorHome: "private" },
    inbox: { "next-turn": [{ id: "u1", role: "user", content: [{ type: "text", text: "queued", secret: "private" }],
      source: { kind: "user", rpcId: "request-1", secret: "private" }, secret: "private" }],
      "next-step": [], secret: "private" },
    userQuestions: { active: [{ callId: "call-1", state: "open", questions: [{
      id: "q1", question: "Proceed?", options: [{ label: "Yes", hostSecret: "private" }],
      hostSecret: "private" }], hostSecret: "private" }], settled: [{ callId: "call-2",
      answers: [{ id: "q2", selected: ["No"], custom: "own answer", hostSecret: "private" }] }],
      hostSecret: "private" }, todos: [{ content: "own task", status: "pending",
      operatorSecret: "private" }], goal: { goal: { id: "goal-1", revision: 1,
      objective: "owned work", phase: "active", maxGoalRounds: 3, operatorSecret: "private" },
      roundsStarted: 1, createdAt: 1, updatedAt: 2, operatorSecret: "private" },
    agentTeam: { members: [{ id: "sa", name: "Alice", role: "lead", phase: "active",
      operatorSecret: "private" }], tasks: [{ id: "t1", revision: 1, subject: "task",
      description: "work", status: "pending", blockedBy: [], writeScopes: [],
      ready: true, writeScopeWarnings: ["/private/host/path"], operatorSecret: "private" }],
      operatorSecret: "private" }, subagentModelSelectionPolicy: [
      { provider: "mock", model: "model", apiKey: "private" }],
    turnOutline: [{ turn: 1, seq: 0, prompt: "own prompt", response: "own response",
      hostSecret: "private" }] } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/projections",
    value: { ...value, asOfSeq: -1 } }), /invalid session projections/);
  const projected = filterMemberResponse({ ownership, user: alice, method: "session/projections", value });
  assert.deepEqual(projected.values.subagentCatalog, [{ id: "sa", mode: "one-shot", createdAt: 3 }]);
  assert.deepEqual(projected.values.modelSelection, { lastUsed: { provider: "mock", model: "model" }, next: null });
  assert.deepEqual(projected.values.subagentModelSelectionPolicy, [{ provider: "mock", model: "model" }]);
  assert.deepEqual(projected.values.turnOutline, [{ turn: 1, seq: 0,
    prompt: "own prompt", response: "own response" }]);
  assert.deepEqual(projected.values.sessionListMetadata, { blank: true, lastPromptAt: null });
  assert.deepEqual(projected.values.inbox, { "next-turn": [{ id: "u1", role: "user",
    content: [{ type: "text", text: "queued" }], source: { kind: "user", rpcId: "request-1" } }],
    "next-step": [] });
  assert.deepEqual(projected.values.userQuestions, { active: [{ callId: "call-1",
    state: "open", questions: [{ id: "q1", question: "Proceed?",
      options: [{ label: "Yes" }] }] }], settled: [{ callId: "call-2",
    answers: [{ id: "q2", selected: ["No"], custom: "own answer" }] }] });
  assert.deepEqual(projected.values.todos, [{ content: "own task", status: "pending" }]);
  assert.deepEqual(projected.values.goal, { goal: { id: "goal-1", revision: 1,
    objective: "owned work", phase: "active", maxGoalRounds: 3 },
    roundsStarted: 1, createdAt: 1, updatedAt: 2 });
  assert.deepEqual(projected.values.agentTeam, {
    members: [{ id: "sa", name: "Alice", role: "lead", phase: "active" }],
    tasks: [{ id: "t1", revision: 1, subject: "task", description: "work",
      status: "pending", blockedBy: [], writeScopes: [], ready: true,
      writeScopeWarnings: [] }] });
  const foreignTeam = { ...value.values.agentTeam, members: [
    { id: "sb", name: "foreign", role: "teammate", phase: "active" }] };
  assert.equal(filterMemberResponse({ ownership, user: alice, method: "session/projections",
    value: { asOfSeq: 4, values: { agentTeam: foreignTeam } } }).values.agentTeam, undefined);
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/projections",
    value: { asOfSeq: 4, values: { todos: null } } }).values, { todos: null });
  assert.equal(JSON.stringify(projected).includes("private"), false);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/projections",
    value: { asOfSeq: 4, values: { subagentCatalog: { secret: "private" } } } }), /invalid/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/projections",
    value: { asOfSeq: 4, values: { subagentCatalog: [{ id: "sa", createdAt: 1, mode: "unknown", secret: "private" }] }, host: "private" } }), /invalid/);
});

test("slash creation chooses owned workspace and rejects client-selected IDs", () => {
  const { config, ownership, alice } = fixture();
  const guard = payload => guardMemberRequest({ config, ownership, user: alice, method: "session/create", payload });
  assert.deepEqual(guard({ args: { request: {} } }).payload, { args: { request: { workspaceId: "wa" } } });
  assert.equal(guard({ args: { request: { sessionId: "sb", workspaceId: "wa" } } }).ok, false);
  assert.equal(guard({ args: { request: { agentPreset: "danger", workspaceId: "wa" } } }).ok, false);
  assert.equal(guardMemberRequest({ config, ownership, user: alice, method: "agentPresets/select", payload: { args: { agentId: "sa", agentPreset: "danger" } } }).ok, false);
  assert.equal(guard({ args: { request: { workspaceId: "wb" } } }).ok, false);
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/create", value: { sessionId: "new", secret: "host" } }), { sessionId: "new" });
  assert.equal(ownership.sessionOwner.get("new"), alice.name);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/create", value: { sessionId: "sb" } }), /ownership conflict/);
  assert.equal(ownership.sessionOwner.get("sb"), "bob");
});

test("member history pages reject foreign child catalog and strip Host metadata", () => {
  const { ownership, alice } = fixture();
  const good = { type: "event", event: { type: "assistant/message", seq: 1, time: 1, surfaceOp: "append",
    data: { turn: 1, step: 0, message: { id: "m", role: "assistant", content: [{ type: "text", text: "hello" }],
      source: { kind: "model", provider: "mock", model: "test" } }, stream: [] } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [good], hasMore: false, operatorSecret: "private" } }), { records: [good], hasMore: false });
  const userMessage = { type: "event", event: { type: "user/message", seq: 3, time: 4,
    surfaceOp: "append", data: { id: "u", role: "user",
      content: [{ type: "text", text: "hello", hostSecret: "private" }],
      source: { kind: "agent-message", form: "relay", senderSessionId: "sa", hostSecret: "private" } } } };
  const projectedUser = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [userMessage], hasMore: false } }).records[0].event.data;
  assert.deepEqual(projectedUser, { id: "u", role: "user", content: [{ type: "text", text: "hello" }],
    source: { kind: "agent-message", form: "relay", senderSessionId: "sa" } });
  const prompt = { ...userMessage, event: { ...userMessage.event,
    data: { ...userMessage.event.data, source: { kind: "user", rpcId: "request-1",
      clientTimeZone: "Asia/Shanghai", hostSecret: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [prompt], hasMore: false } }).records[0].event.data.source,
    { kind: "user", rpcId: "request-1", clientTimeZone: "Asia/Shanghai" });
  const questionReply = { ...userMessage, event: { ...userMessage.event,
    data: { ...userMessage.event.data, source: { kind: "user-question-reply",
      callId: "call-1", outcome: "answered", hostSecret: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [questionReply], hasMore: false } }).records[0].event.data.source,
    { kind: "user-question-reply", callId: "call-1", outcome: "answered" });
  const reminder = { ...userMessage, event: { ...userMessage.event,
    data: { ...userMessage.event.data, source: { kind: "schedule", form: "notice",
      summary: "operator/private", hostSecret: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [reminder], hasMore: false } }).records[0].event.data.source,
    { kind: "schedule", form: "notice", summary: "Scheduled reminder" });
  const goalContinuation = { ...userMessage, event: { ...userMessage.event,
    data: { ...userMessage.event.data, source: { kind: "goal", goalId: "g1",
      revision: 2, round: 3, hostSecret: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [goalContinuation], hasMore: false } }).records[0].event.data.source,
    { kind: "goal", goalId: "g1", revision: 2, round: 3 });
  const teamMessage = { ...userMessage, event: { ...userMessage.event,
    data: { ...userMessage.event.data, source: { kind: "team-message", teamId: "sa",
      senderId: "sa", senderName: "Alice", messageId: "m1", hostSecret: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [teamMessage], hasMore: false } }).records[0].event.data.source,
    { kind: "team-message", teamId: "sa", senderId: "sa",
      senderName: "Alice", messageId: "m1" });
  for (const source of [{ ...teamMessage.event.data.source, senderId: "sb" },
    { ...teamMessage.event.data.source, teamId: "sb" }]) {
    assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
      value: { records: [{ ...teamMessage, event: { ...teamMessage.event,
        data: { ...teamMessage.event.data, source } } }], hasMore: false } }), /unauthorized/);
  }
  const inbox = { type: "event", event: { type: "agent/inbox/spliced", seq: 3, time: 4,
    data: { target: "next-turn", start: 0, inserted: [userMessage.event.data],
      hostSecret: "private" } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [inbox], hasMore: false } }).records[0].event.data,
    { target: "next-turn", start: 0, inserted: [projectedUser] });
  const foreignInbox = { ...inbox, event: { ...inbox.event,
    data: { ...inbox.event.data, inserted: [{ ...userMessage.event.data,
      source: { kind: "agent-message", form: "relay", senderSessionId: "sb" } }] } } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [foreignInbox], hasMore: false } }), /unauthorized/);
  const pluginInbox = { ...inbox, event: { ...inbox.event,
    data: { ...inbox.event.data, inserted: [{ ...userMessage.event.data,
      source: { kind: "plugin-secret", sessionId: "sb" } }] } } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [pluginInbox], hasMore: false } }), /unauthorized/);

  const foreignUser = { ...userMessage, event: { ...userMessage.event, data: { ...userMessage.event.data,
    source: { kind: "agent-message", form: "relay", senderSessionId: "sb" } } } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [foreignUser], hasMore: false } }), /unauthorized/);
  const foreignRecall = { ...userMessage, event: { ...userMessage.event, data: { ...userMessage.event.data,
    source: { kind: "session-reference", form: "recall", version: 1,
      references: [{ sessionId: "sb", label: "private" }] } } } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [foreignRecall], hasMore: false } }), /unauthorized/);
  const ownRecall = { ...foreignRecall, event: { ...foreignRecall.event,
    data: { ...foreignRecall.event.data, source: { kind: "session-reference", form: "recall",
      version: 1, hostSecret: "private", references: [{ sessionId: "sa", label: "owned",
        capturedThroughSeq: null, compacted: false, originalMessages: 1, retainedMessages: 1,
        omittedMessages: 0, omittedBytes: 0, truncated: false, inputIndex: 0,
        token: "private" }] } } } };
  const recall = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [ownRecall], hasMore: false } }).records[0].event.data.source;
  assert.deepEqual(recall, { kind: "session-reference", form: "recall", version: 1,
    references: [{ sessionId: "sa", label: "owned", capturedThroughSeq: null,
      compacted: false, originalMessages: 1, retainedMessages: 1, omittedMessages: 0,
      omittedBytes: 0, truncated: false, inputIndex: 0 }] });


  for (const seq of [good.event.seq, good.event.seq + 2])
    assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
      value: { records: [good, { ...good, event: { ...good.event, seq } }], hasMore: false } }), /unauthorized/);
  assert.equal(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [good, { ...good, event: { ...good.event, seq: good.event.seq + 1 } }],
      hasMore: false } }).records.length, 2);
  const replay = { ...good, event: { ...good.event, data: { ...good.event.data, message: {
    ...good.event.data.message, source: { ...good.event.data.message.source,
      replayState: { token: "private" }, hostSecret: "private" } } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [replay], hasMore: false } }).records, [good]);
  const nestedMessage = { ...good, event: { ...good.event, data: { ...good.event.data,
    usage: { inputTokens: 1, outputTokens: 2, hostSecret: "private" },
    message: { ...good.event.data.message, hostSecret: "private",
      content: [{ type: "text", text: "hello", hostSecret: "private" }] } } } };
  const sanitizedMessage = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [nestedMessage], hasMore: false } }).records[0].event.data;
  assert.deepEqual(sanitizedMessage.message, good.event.data.message);
  assert.deepEqual(sanitizedMessage.usage, { inputTokens: 1, outputTokens: 2 });

  const streamSecret = { ...good, event: { ...good.event, data: { ...good.event.data,
    hostSecret: "private", stream: [{ type: "chunk", time: 2,
      chunk: { type: "finish", reason: { kind: "stop", hostSecret: "private" },
        replayState: { token: "private" } }, hostSecret: "private" }] } } };
  const streamed = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [streamSecret], hasMore: false } }).records[0].event;
  assert.deepEqual(streamed.data.stream, [{ type: "chunk", time: 2,
    chunk: { type: "finish", reason: { kind: "stop" } } }]);
  assert.equal(JSON.stringify(streamed).includes("private"), false);
  const toolRun = { ...good, event: { ...good.event, data: { ...good.event.data,
    stream: [{ type: "tool-call-chunks", time0: 2, index: 0, dt: [1],
      id: "call", name: "bash", args: ["{", "}"], secret: "private" }] } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [toolRun], hasMore: false } }).records[0].event.data.stream,
    [{ type: "tool-call-chunks", time0: 2, index: 0, dt: [1],
      id: "call", name: "bash", args: ["{", "}"] }]);
  const blockRun = { ...good, event: { ...good.event, data: { ...good.event.data,
    stream: [{ type: "chunk", time: 3, chunk: { type: "block-end", index: 0,
      block: { type: "tool-call", id: "call", name: "bash", arguments: "{}", secret: "private" },
      secret: "private" } }, { type: "chunk", time: 4, chunk: { type: "usage",
      usage: { inputTokens: 1, outputTokens: 2, secret: "private" } } }] } } };
  const sanitizedBlocks = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [blockRun], hasMore: false } }).records[0].event.data.stream;
  assert.deepEqual(sanitizedBlocks, [{ type: "chunk", time: 3, chunk: { type: "block-end",
    index: 0, block: { type: "tool-call", id: "call", name: "bash", arguments: "{}" } } },
  { type: "chunk", time: 4, chunk: { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } } }]);




  const known = { type: "event", event: { type: "turn/start", seq: 1, time: 1,
    data: { turn: 1 }, ignorable: true } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [known], hasMore: false } }).records, [known]);
  const ended = { type: "event", event: { type: "turn/end", seq: 2, time: 3,
    data: { turn: 1, reason: { kind: "error", error: { code: "UNKNOWN",
      message: "operator password/private path", requestId: "private" } },
      hostSecret: "private" } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [ended], hasMore: false } }).records[0].event.data,
    { turn: 1, reason: { kind: "error", error: { code: "UNKNOWN", message: "request failed" } } });
  const aborted = { ...ended, event: { ...ended.event, data: { turn: 1,
    reason: { kind: "aborted", reason: { kind: "hook", reason: "operator/private" } } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [aborted], hasMore: false } }).records[0].event.data,
    { turn: 1, reason: { kind: "aborted", reason: { kind: "hook", reason: "cancelled by hook" } } });

  const replaced = { ...good, event: { ...good.event, seq: 4,
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 2, hostSecret: "private" } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [replaced], hasMore: false } }).records[0].event.surfaceOp,
    { op: "replace", startSeq: 1, endSeq: 2 });
  const developer = { type: "event", event: { type: "developer/message", seq: 4, time: 6,
    data: { turn: 1, step: 1, message: { id: "dev", role: "developer",
      source: { kind: "user" }, content: [] } }, surfaceOp: "append", sourceEventSeqs: [1] } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [developer], hasMore: false } }).records[0].event, developer.event);
  const developerSecret = { ...developer, event: { ...developer.event, data: { ...developer.event.data,
    message: { ...developer.event.data.message, content: [{ type: "text", text: "HOST_PRIVATE_PROMPT" }] } } } };
  const sanitizedDeveloper = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [developerSecret], hasMore: false } }).records[0].event;
  assert.equal(sanitizedDeveloper.data.message.content[0].text, "[Developer message withheld by Team Hub]");
  assert.equal(JSON.stringify(sanitizedDeveloper).includes("HOST_PRIVATE_PROMPT"), false);
  const duplicateSources = { ...developer, event: { ...developer.event,
    sourceEventSeqs: [1, 1] } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [duplicateSources], hasMore: false } }), /unauthorized/);
  for (const event of [
    { ...developer.event, seq: -0 },
    { ...developer.event, time: 0.5 },
    { ...developer.event, ignorable: false },
  ]) assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event }], hasMore: false } }), /unauthorized/);
  const systemMessage = { type: "event", event: { type: "system/message", seq: 4, time: 6,
    surfaceOp: "append", data: { turn: 1, step: 0, hostSecret: "private", message: {
      id: "sys", role: "system", source: { kind: "system-prompt", hostSecret: "private" },
      content: [{ type: "text", text: "instructions", hostSecret: "private" }],
      hostSecret: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [systemMessage], hasMore: false } }).records[0].event.data,
    { turn: 1, step: 0, message: { id: "sys", role: "system",
      source: { kind: "system-prompt" }, content: [{ type: "text", text: "[System prompt withheld by Team Hub]" }] } });

  const toolChange = { ...developer, event: { ...developer.event, data: {
    ...developer.event.data, headerSeq: 1, hostSecret: "private", message: {
      ...developer.event.data.message, source: { kind: "user", hostSecret: "private" },
      content: [{ type: "tool-addition", toolName: "bash", tool: { apiKey: "private" } }],
      hostSecret: "private" } } } };
  const safeChange = filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [toolChange], hasMore: false } }).records[0].event;
  assert.deepEqual(safeChange.data, { turn: 1, step: 1, headerSeq: 1,
    message: { id: "dev", role: "developer", source: { kind: "user" },
      content: [{ type: "tool-addition", toolName: "bash" }] } });
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ ...toolChange, event: { ...toolChange.event,
      data: { ...toolChange.event.data, headerSeq: undefined } } }], hasMore: false } }), /unauthorized/);

  const missingSurface = { ...good, event: { ...good.event, surfaceOp: undefined } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [missingSurface], hasMore: false } }), /unauthorized/);


  const malformed = { ...known, event: { ...known.event, seq: 4,
    surfaceOp: { op: "replace", startSeq: 1, endSeq: 2, hostSecret: "private" },
    sourceEventSeqs: [1, "private"] } };
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [malformed], hasMore: false } }), /unauthorized/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { ...known.event, surfaceOp: "append" } }],
      hasMore: false } }), /unauthorized/);


  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { ...known.event, hostSecret: "private" } }], hasMore: false } }).records, [known]);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "vendor/unknown", seq: 1, time: 1, data: {} } }], hasMore: false } }), /unauthorized/);
  const plugin = { type: "event", event: { type: "vendor/private", seq: 2, time: 5, data: { credential: "private" }, ignorable: true } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [plugin], hasMore: false } }).records,
    [{ type: "event", event: { type: "teamhub/redacted-event", seq: 2, time: 5, data: {}, ignorable: true } }]);
  for (const type of ["team/member", "team/message/delivered", "workspace/changes"]) {
    const unsafe = { type: "event", event: { type, seq: 2, time: 5,
      data: { memberSessionId: "sb", credential: "private" }, ignorable: true } };
    assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
      value: { records: [unsafe], hasMore: false } }), /unauthorized/);
  }

  for (const [type, data] of [
    ["approval/asked", { id: "approval-1", toolName: "bash", callId: "" }],
    ["approval/asked", { id: "approval-2", toolName: "bash", callId: "x".repeat(129) }],
    ["tool-workflow/agent-start", { runId: "run-1", seq: 1, label: "foreign",
      childId: "sb" }],
    ["team/task", { version: 2, teamId: "sa", task: { id: "t1", revision: 1,
      subject: "task", description: "private", status: "in_progress",
      ownerId: "sb", blockedBy: [], writeScopes: [] } }],
    ["team/message/queued", { version: 2, teamId: "sa", message: { id: "m1",
      senderId: "sa", senderName: "Alice", targetId: "sb",
      content: [{ type: "text", text: "private" }] } }],
    ["team/member", { version: 2, teamId: "sa", member: { id: "sb",
      name: "foreign", description: "secret", provider: "mock", context: "fresh", phase: "active" } }],
    ["team/message/delivered", { version: 2, teamId: "sa", messageId: "m1", targetId: "sb" }]
  ]) {
    assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
      value: { records: [{ type: "event", event: { type, seq: 3, time: 5, data } }],
        hasMore: false } }), /unauthorized/);
  }
  for (const [type, data, safe] of [
    ["compaction/start", { compactionId: "c1", turn: 1,
      hostSecret: "private" }, { compactionId: "c1", turn: 1 }],
    ["compaction/end", { compactionId: "c1", turn: 1, error: "private",
      hostSecret: "private" }, { compactionId: "c1", turn: 1,
        error: "Compaction failed" }],
    ["compaction/prune", { shadowedRange: { start: 0, end: 1, secret: "private" },
      shadowedSeqs: [0, 1], shadowedTokenCount: 4, hostSecret: "private" },
      { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1],
        shadowedTokenCount: 4 }],
    ["compaction/summary", { compactionId: "c1",
      summary: [{ type: "text", text: "owned summary", secret: "private" }],
      shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1],
      shadowedTokenCount: 4, provider: "mock", model: "m",
      rawOutput: [{ type: "text", text: "private" }] },
      { compactionId: "c1", summary: [{ type: "text", text: "owned summary" }],
        shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1],
        shadowedTokenCount: 4, provider: "mock", model: "m" }],
    ["tool-workflow/run-start", { runId: "run-1", name: "own flow",
      hostSecret: "private" }, { runId: "run-1", name: "own flow" }],
    ["tool-workflow/agent-start", { runId: "run-1", seq: 1,
      label: "child", phase: "build", childId: "sa", hostSecret: "private" },
      { runId: "run-1", seq: 1, label: "child", phase: "build", childId: "sa" }],
    ["tool-workflow/agent-end", { runId: "run-1", seq: 1, outcome: "completed",
      hostSecret: "private" }, { runId: "run-1", seq: 1, outcome: "completed" }],
    ["tool-workflow/run-end", { runId: "run-1", stopReason: "completed",
      hostSecret: "private" }, { runId: "run-1", stopReason: "completed" }],
    ["tool/ptc-dispatch-start", { rootCallId: "root", parentCallId: "parent",
      subCallId: "child", name: "bash", arguments: { token: "private" } },
      { rootCallId: "root", parentCallId: "parent", subCallId: "child",
        name: "bash", arguments: {} }],
    ["tool/ptc-dispatch", { rootCallId: "root", parentCallId: "parent",
      subCallId: "child", name: "bash", arguments: { token: "private" },
      isError: true, content: [{ type: "text", text: "owned output", secret: "private" }],
      error: { name: "Error", code: "FAILED", reason: "private" } },
      { rootCallId: "root", parentCallId: "parent", subCallId: "child",
        name: "bash", arguments: {}, isError: true,
        content: [{ type: "text", text: "owned output" }],
        error: { name: "Error", code: "FAILED" } }],
    ["hook/invoked", { turn: 1, point: "Stop", dialect: "codex",
      matcher: "tool", handlerId: "hook-1", hostSecret: "private" },
      { turn: 1, point: "Stop", dialect: "codex",
        matcher: "tool", handlerId: "hook-1" }],
    ["hook/result", { turn: 1, point: "Stop", handlerId: "hook-1",
      decision: "pass", exitCode: 0, durationMs: 3,
      stderrSummary: "private", hostSecret: "private" },
      { turn: 1, point: "Stop", handlerId: "hook-1", decision: "pass",
        exitCode: 0, durationMs: 3 }],
    ["image/offload", { targets: [{ seq: 1, imageIndexes: [0, 2],
      hostImagePath: "private" }], hostSecret: "private" },
      { targets: [{ seq: 1, imageIndexes: [0, 2] }] }],
    ["subagent/model-selection-policy", { allowedModels: [
      { provider: "mock", model: "model", secret: "private" }], secret: "private" },
      { allowedModels: [{ provider: "mock", model: "model" }] }],
    ["team/task", { version: 2, teamId: "sa", task: {
      id: "t1", revision: 1, subject: "task", description: "do work",
      status: "in_progress", ownerId: "sa", blockedBy: [],
      writeScopes: ["/private/bob/secret"], hostSecret: "private" }, hostSecret: "private" },
      { version: 2, teamId: "sa", task: {
        id: "t1", revision: 1, subject: "task", description: "do work",
        status: "in_progress", ownerId: "sa", blockedBy: [], writeScopes: [] } }],
    ["team/message/queued", { version: 2, teamId: "sa", message: {
      id: "m1", senderId: "sa", senderName: "Alice", targetId: "sa",
      content: [{ type: "text", text: "hello", hostSecret: "private" }],
      hostSecret: "private" } }, { version: 2, teamId: "sa", message: {
        id: "m1", senderId: "sa", senderName: "Alice", targetId: "sa",
        content: [{ type: "text", text: "hello" }] } }],
    ["team/member", { version: 2, teamId: "sa", member: {
      id: "sa", name: "owned", description: "teammate", provider: "mock",
      context: "fresh", phase: "failed", error: "Host secret", hostSecret: "private" },
      hostSecret: "private" }, { version: 2, teamId: "sa", member: {
        id: "sa", name: "owned", description: "teammate", provider: "mock",
        context: "fresh", phase: "failed", error: "Team member failed" } }],
    ["team/message/delivered", { version: 2, teamId: "sa", messageId: "m1",
      targetId: "sa", hostSecret: "private" },
      { version: 2, teamId: "sa", messageId: "m1", targetId: "sa" }],
    ["schedule/change", { version: 1, operation: "create", schedule: {
      id: "timer-1", kind: "after", title: "owned timer", prompt: "remember",
      afterSeconds: 60, scheduledAt: "2026-01-01T00:00:00.000Z", hostSecret: "private" },
      hostSecret: "private" },
      { version: 1, operation: "create", schedule: {
        id: "timer-1", kind: "after", title: "owned timer", prompt: "remember",
        afterSeconds: 60, scheduledAt: "2026-01-01T00:00:00.000Z" } }],
    ["schedule/change", { version: 1, operation: "dispatch", id: "timer-1",
      acceptedAt: "2026-01-01T00:00:00.000Z", hostSecret: "private" },
      { version: 1, operation: "dispatch", id: "timer-1", acceptedAt: "2026-01-01T00:00:00.000Z" }],
    ["todo/write", { todos: [{ content: "own task", status: "in_progress",
      hostSecret: "private" }], secret: "private" },
      { todos: [{ content: "own task", status: "in_progress" }] }],
    ["goal/change", { kind: "goal/change", version: 1, operation: "create",
      goal: { id: "goal-1", revision: 1, objective: "owned work",
        phase: "active", maxGoalRounds: 3, secret: "private" },
      roundsStarted: 0, createdAt: 1, updatedAt: 2, secret: "private" },
      { kind: "goal/change", version: 1, operation: "create",
        goal: { id: "goal-1", revision: 1, objective: "owned work",
          phase: "active", maxGoalRounds: 3 },
        roundsStarted: 0, createdAt: 1, updatedAt: 2 }],
    ["goal/change", { kind: "goal/change", version: 1, operation: "clear",
      cleared: { id: "goal-1", revision: 2, secret: "private" },
      clearedAt: 3, secret: "private" },
      { kind: "goal/change", version: 1, operation: "clear",
        cleared: { id: "goal-1", revision: 2 }, clearedAt: 3 }],
    ["workspace/changes", { turn: 1, secret: "private" }, { turn: 1 }],
    ["session-log-deepseek/delivery-accepted", { sessionId: "sa", throughSeq: 1,
      sessionFormatVersion: 1, secret: "private" },
      { sessionId: "sa", throughSeq: 1, sessionFormatVersion: 1 }],
    ["web/deepseek-search-llm-request", { endpoint: "http://private-host/v1/messages",
      apiVersion: "2023-06-01", body: { model: "search", max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "private query", secret: "private" }] }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3,
          secret: "private" }], token: "private" }, secret: "private" },
      { endpoint: "", apiVersion: "2023-06-01", body: { model: "search", max_tokens: 100,
        messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] } }],
    ["session/title-llm-request", { titleProvider: "mock", messageSeqs: [1],
      route: { provider: "mock", model: "small", token: "private" },
      system: "private Host instructions", messages: [{ role: "user",
        content: [{ type: "text", text: "private" }] }], maxTokens: 32, secret: "private" },
      { titleProvider: "mock", messageSeqs: [1], route: { provider: "mock", model: "small" },
        system: "", messages: [], maxTokens: 32 }],
    ["llm/retry", { retryId: "retry-1", turn: 1, step: 0, provider: "mock",
      mode: "normal", policyKey: "rate-limit", retry: 1, maxRetries: 3, delayMs: 100,
      failure: { code: "THROTTLE", message: "Host credential", requestId: "private" },
      secret: "private" },
      { retryId: "retry-1", turn: 1, step: 0, provider: "mock", mode: "normal",
        policyKey: "rate-limit", retry: 1, maxRetries: 3, delayMs: 100,
        failure: { code: "THROTTLE", message: "Model request failed" } }],
    ["llm/retry-started", { retryId: "retry-1", turn: 1, step: 0, retry: 1, secret: "private" },
      { retryId: "retry-1", turn: 1, step: 0, retry: 1 }],
    ["command/run", { commandId: "cmd", name: "help", args: " hello",
      source: { kind: "user", secret: "private" }, secret: "private" },
      { commandId: "cmd", name: "help", args: " hello", source: { kind: "user" } }],
    ["command/done", { commandId: "cmd", kind: "success", text: "done",
      sourceEventSeq: 1, secret: "private" },
      { commandId: "cmd", kind: "success", text: "done", sourceEventSeq: 1 }],
    ["command/done", { commandId: "cmd", kind: "error",
      text: "host path and credential", secret: "private" },
      { commandId: "cmd", kind: "error", text: "Command failed" }],
    ["feedback/record", { text: "works", category: "task-result", secret: "private" },
      { text: "works", category: "task-result" }],
    ["feedback/message-put", { sessionId: "sa", item: { messageId: "msg", rating: "positive",
      version: "version", createdAt: 1, updatedAt: 2, note: "useful", secret: "private" },
      secret: "private" }, { sessionId: "sa", item: { messageId: "msg", rating: "positive",
      version: "version", createdAt: 1, updatedAt: 2, note: "useful" } }],
    ["feedback/message-delete", { sessionId: "sa", messageId: "msg", secret: "private" },
      { sessionId: "sa", messageId: "msg" }],
    ["approval/asked", { id: "approval-1", toolName: "bash", callId: "call-1",
      reason: "needs consent", secret: "private" },
      { id: "approval-1", toolName: "bash", callId: "call-1", reason: "needs consent" }],
    ["approval/decided", { id: "approval-1", outcome: "rejected", secret: "private" },
      { id: "approval-1", outcome: "rejected" }],
    ["session/end-seed", { inherited: true, secret: "private" }, { inherited: true }],
    ["permission/preset", { preset: "workspace-write", secret: "private" }, { preset: "workspace-write" }],
    ["sandbox/mode", { mode: "workspace-write", source: "delegation", secret: "private" },
      { mode: "workspace-write", source: "delegation" }],
    ["approval/policy", { policy: "ask", source: "delegation", secret: "private" },
      { policy: "ask", source: "delegation" }],
    ["plan/mode", { active: true, secret: "private" }, { active: true }],
    ["agent-preset/selected", { agentPreset: "default", secret: "private" }, { agentPreset: "default" }],
    ["model/selection", { provider: "mock", model: "small", reasoningEffort: "high", secret: "private" },
      { provider: "mock", model: "small", reasoningEffort: "high" }],
    ["session/title", { title: "owned title", messageSeqs: [1], source: { kind: "provider",
      provider: "mock", model: { provider: "mock", model: "small", secret: "private" }, secret: "private" },
      secret: "private" },
      { title: "owned title", messageSeqs: [1], source: { kind: "provider",
        provider: "mock", model: { provider: "mock", model: "small" } } }]
  ]) {
    const event = { type, seq: 3, time: 6, data };
    assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
      value: { records: [{ type: "event", event }], hasMore: false } }).records[0].event,
      { type, seq: 3, time: 6, data: safe });
  }
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "permission/preset", seq: 3, time: 6,
      data: { preset: "danger-full-access" } } }], hasMore: false } }), /unauthorized/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "sandbox/mode", seq: 3, time: 6,
      data: { mode: "danger-full-access" } } }], hasMore: false } }), /unauthorized/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "feedback/message-delete", seq: 3, time: 6,
      data: { sessionId: "sb", messageId: "msg" } } }], hasMore: false } }), /unauthorized/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "session-log-deepseek/delivery-accepted",
      seq: 3, time: 6, data: { sessionId: "sb", throughSeq: 1 } } }], hasMore: false } }), /unauthorized/);
  const catalog = { type: "event", event: { type: "subagent/catalog", seq: 3, time: 6,
    data: { childId: "sa", childCreatedAt: 5, version: 0, mode: "one-shot", hostSecret: "private" },
    hostSecret: "private" } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [catalog], hasMore: false } }).records[0].event,
    { type: "subagent/catalog", seq: 3, time: 6,
      data: { childId: "sa", childCreatedAt: 5, version: 0, mode: "one-shot" } });
  const descriptor = { type: "event", event: { type: "subagent/descriptor", seq: 4, time: 7,
    data: { version: 3, mode: "continuable", provider: "mock", label: "child",
      persona: "private", toolFilter: { secret: "private" }, agentModel: "private" } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [descriptor], hasMore: false } }).records[0].event.data,
    { version: 3, mode: "continuable", provider: "mock", label: "child" });
  const toolCall = { type: "event", event: { type: "tool/call", seq: 4, time: 8,
    data: { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}", hostSecret: "private" } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [toolCall], hasMore: false } }).records[0].event.data,
    { turn: 1, step: 1, callId: "c", name: "bash", arguments: "{}" });
  const tool = { type: "event", event: { type: "tool/result", seq: 5, time: 8, surfaceOp: "append",
    data: { turn: 1, step: 1, message: { id: "tool-message", role: "tool", toolCallId: "call",
        source: { kind: "tool", callId: "call", hostSecret: "private" },
        content: [{ type: "text", text: "result", hostSecret: "private" }],
        isError: true, hostSecret: "private" },
      error: { name: "PermissionError", code: "EACCES", reason: "private" }, meta: { token: "private" } } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [tool], hasMore: false } }).records[0].event,
    { type: "tool/result", seq: 5, time: 8, surfaceOp: "append",
      data: { turn: 1, step: 1, message: { id: "tool-message", role: "tool",
        source: { kind: "tool", callId: "call" }, toolCallId: "call",
        content: [{ type: "text", text: "result" }], isError: true },
        error: { name: "PermissionError", code: "EACCES" } } });
  const header = { type: "event", event: { type: "request/header", seq: 6, time: 9,
    data: { header: { config: { apiKey: "private" }, tools: [{ description: "private" }],
      adapterDefaults: { secret: "private" } }, reason: "initial" } } };
  assert.deepEqual(filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [header], hasMore: false } }).records[0].event,
    { type: "request/header", seq: 6, time: 9, data: { header: { config: {} }, reason: "initial" } });
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { ...plugin.event, time: "not-a-timestamp" } }], hasMore: false } }),
    /unauthorized/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "subagent/catalog", data: { childId: "sb" } } }], hasMore: false } }), /unauthorized/);
  assert.throws(() => filterMemberResponse({ ownership, user: alice, method: "session/page",
    value: { records: [{ type: "event", event: { type: "assistant/message", data: { childSessionId: "sb" } } }], hasMore: false } }), /unauthorized/);
});

test("slash session history pages are owned and bounded", () => {
  const { config, ownership, alice } = fixture();
  const guard = request => guardMemberRequest({ config, ownership, user: alice, method: "session/page", payload: { args: { request } } });
  const page = { address: { kind: "session", sessionId: "sa" }, throughSeq: 100 };
  assert.equal(guard(page).payload.args.request.maxMessages, 500);
  assert.equal(guard({ ...page, maxMessages: 200 }).ok, true);
  assert.equal(guard({ ...page, maxMessages: 100000 }).ok, false);
  assert.equal(guard({ ...page, throughSeq: -1 }).ok, false);
  assert.equal(guard({ ...page, address: { kind: "session", sessionId: "sb" } }).ok, false);
  assert.equal(guard({ ...page, address: { kind: "session", sessionId: "sa", childSessionId: "sb" } }).ok, false);
  assert.equal(guard({ ...page, address: { kind: "subagent", parentSessionId: "sa", childSessionId: "sb", mode: "one-shot" } }).ok, false);
  assert.equal(guard({ ...page, address: { kind: "unknown", sessionId: "sa" } }).ok, false);
});
