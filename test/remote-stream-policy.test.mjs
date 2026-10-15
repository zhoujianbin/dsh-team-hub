import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/config.mjs";
import { createOwnership } from "../src/policy.mjs";
import { guardRemoteClientFrame, filterRemoteServerFrame, consumeMemberEventResult, settleMemberEventResult } from "../src/remote-stream-policy.mjs";

function fixture() {
  const config = defaultConfig("/tmp/dsh-team-hub-remote-fixture");
  config.users = [{ name: "admin", role: "admin" }, { name: "alice", role: "member" }, { name: "bob", role: "member" }];
  const ownership = createOwnership();
  const user = config.users[1];
  const streams = new Map();
  const client = frame => guardRemoteClientFrame({ ownership, user, streams, frame });
  const host = frame => filterRemoteServerFrame({ config, ownership, user, streams, frame });
  return { config, ownership, streams, client, host };
}

test("remote stream opens only recognized scoped endpoints", () => {
  const { client, streams } = fixture();
  assert.equal(client({ type: "open", streamId: "bad", endpoint: "$events", payload: { args: { leak: true } } }), null);
  assert.equal(client({ type: "open", streamId: "bad", endpoint: "session/follow", payload: { args: {} } }), null);
  assert.equal(client({ type: "open", streamId: "bad", endpoint: "workspace/follow", payload: { args: { leak: true } } }), null);
  const open = { type: "open", streamId: "ok", endpoint: "workspace/follow", payload: { args: {} } };
  assert.deepEqual(client(open), open);
  assert.equal(client(open), null);
  assert.equal(streams.size, 1);
  assert.equal(client({ type: "item", streamId: "ok", value: { evil: true } }), null);
  assert.equal(client({ type: "cancel", streamId: "other" }), null);
  assert.equal(client({ type: "cancel", streamId: "ok" }).type, "cancel");
});

test("remote workspace frames never disclose other members or admin IDs", () => {
  const { ownership, client, host } = fixture();
  client({ type: "open", streamId: "s", endpoint: "workspace/follow", payload: { args: {} } });
  const own = { workspaceId: "wa", path: "/tmp/dsh-team-hub-remote-fixture/workspaces/alice", title: "alice", sessionIds: ["sa", "sb"] };
  const other = { workspaceId: "wb", path: "/tmp/dsh-team-hub-remote-fixture/workspaces/bob", title: "bob", sessionIds: ["sb"] };
  const baseline = host({ type: "item", streamId: "s", value: { type: "baseline", value: { items: [own, other], archivedSessionIds: ["sa", "sb"], pinnedSessionIds: ["sa", "sb"] } } });
  assert.deepEqual(baseline.value.value.items.map(x => x.workspaceId), ["wa"]);
  assert.deepEqual(baseline.value.value.items[0].sessionIds, ["sa"]);
  assert.deepEqual(baseline.value.value.archivedSessionIds, ["sa"]);
  assert.deepEqual(baseline.value.value.pinnedSessionIds, ["sa"]);
  assert.equal(host({ type: "item", streamId: "s", value: { type: "upsert", workspace: other } }), null);
  assert.deepEqual(host({ type: "item", streamId: "s", value: { type: "upsert", workspace: own } }).value.workspace.sessionIds, ["sa"]);
  assert.equal(host({ type: "item", streamId: "s", value: { type: "remove", workspaceId: "wb" } }), null);
  assert.deepEqual(host({ type: "item", streamId: "s", value: { type: "order", workspaceIds: ["wb", "wa"] } }).value.workspaceIds, ["wa"]);
  assert.equal(host({ type: "item", streamId: "s", value: { type: "secrets", value: other } }), null);
  assert.equal(host({ type: "item", streamId: "unknown", value: { type: "baseline", value: {} } }), null);
  assert.equal(host({ type: "end", streamId: "s" }).type, "end");
  assert.equal(ownership.workspaceOwner.get("wb"), "bob");
});

test("scoped session follow requires both subagent owners and validates snapshot identity", () => {
  const { ownership, client, host } = fixture();
  ownership.sessionOwner.set("sa", "alice");
  ownership.sessionOwner.set("sb", "bob");
  const open = (streamId, address) => ({ type: "open", streamId, endpoint: "session/follow", payload: { args: { request: { address, assistantStream: true } } } });
  assert.equal(client(open("foreign", { kind: "session", sessionId: "sb" })), null);
  assert.equal(client(open("unknown", { kind: "session", sessionId: "unknown" })), null);
  assert.equal(client(open("cross", { kind: "subagent", parentSessionId: "sa", childSessionId: "sb", mode: "one-shot" })), null);
  assert.deepEqual(client(open("owned", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "event", event: { secret: "premature" } } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "snapshot", header: { id: "sb" }, records: [{ secret: "foreign" }] } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "snapshot", header: { id: "sa", cwd: "/tmp/dsh-team-hub-remote-fixture/workspaces/bob" } } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "snapshot", header: { id: "sa", parentSession: "sb" } } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "snapshot", header: { id: "sa" }, records: [
    { event: { type: "subagent/catalog", data: { childId: "sb" } } }] } }), null);
  const validShape = { type: "snapshot", header: { id: "sa", version: 1, createdAt: 2, isSeeded: false },
    cursor: 3, records: [], hasMore: false, projections: { asOfSeq: 3, values: {} }, assistantStream: { revision: 0 } };
  for (const patch of [{ agentPreset: { secret: "private" } }, { delegationDepth: "foreign" },
    { cwd: { secret: "private" } }, { origin: "host" }, { createdAt: -1 }]) {
    assert.equal(host({ type: "item", streamId: "owned", value: { ...validShape,
      header: { ...validShape.header, ...patch } } }), null);
  }
  assert.equal(host({ type: "item", streamId: "owned", value: { ...validShape, records: "forged" } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { ...validShape, cursor: "forged" } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { ...validShape,
    projections: { asOfSeq: 4, values: {} } } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { ...validShape, records: [
    { type: "event", event: { type: "assistant/message", data: { childSessionId: "sb" } } }] } }), null);
  const row = seq => ({ type: "event", event: { type: "session/title", seq, time: 2,
    data: { title: "safe", messageSeqs: [], source: { kind: "user" } } } });
  for (const rows of [[row(1), row(3)], [row(2), row(2)], [row(4)]])
    assert.equal(host({ type: "item", streamId: "owned", value: { ...validShape,
      records: rows } }), null);
  assert.deepEqual(client(open("paged", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.equal(host({ type: "item", streamId: "paged", value: { ...validShape,
    records: [row(2), row(3)] } }).value.records.length, 2);
  // A second snapshot on an opened stream must be rejected.
  assert.equal(host({ type: "item", streamId: "paged", value: validShape }), null);
  const snapshot = host({ type: "item", streamId: "owned", value: { type: "snapshot",
    header: { id: "sa", version: 1, createdAt: 2, isSeeded: false, secret: "hidden" }, cursor: 3, records: [], hasMore: false, hostSecret: "hidden",
    assistantStream: { revision: 0, hostSecret: "hidden" },
    projections: { asOfSeq: 3, values: { subagentCatalog: [{ id: "sb", mode: "continuable", label: "private" },
      { id: "sa", mode: "one-shot", createdAt: 2 }], unknownHostPlugin: { secret: "hidden" } } } } });
  assert.deepEqual(client(open("active", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.deepEqual(host({ type: "item", streamId: "active", value: { ...validShape,
    assistantStream: { revision: 4, activeAttempt: { attemptId: "attempt-1", startedAfterSeq: 3,
      turn: 1, step: 1, nextIndex: 1, stream: [{ type: "text-chunks", time0: 1, index: 0,
        dt: [], texts: ["safe"], hostSecret: "hidden" }], hostSecret: "hidden" }, hostSecret: "hidden" } } }).value.assistantStream,
    { revision: 4, activeAttempt: { attemptId: "attempt-1", startedAfterSeq: 3,
      turn: 1, step: 1, nextIndex: 1, stream: [{ type: "text-chunks", time0: 1,
        index: 0, dt: [], texts: ["safe"] }] } });
  assert.equal(snapshot.value.header.id, "sa");
  assert.deepEqual(snapshot.value.assistantStream, { revision: 0 });
  const chunk = { type: "assistant-stream", hostSecret: "hidden", frame: {
    type: "chunk", attemptId: "attempt-1", revision: 1, index: 0, time: 6,
    chunk: { type: "text-delta", index: 0, text: "visible", secret: "hidden" }, hostSecret: "hidden" } };
  assert.deepEqual(host({ type: "item", streamId: "owned", value: chunk }).value,
    { type: "assistant-stream", frame: { type: "chunk", attemptId: "attempt-1",
      revision: 1, index: 0, time: 6, chunk: { type: "text-delta", index: 0, text: "visible" } } });
  assert.deepEqual(client(open("block", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "block", value: validShape }));
  assert.deepEqual(host({ type: "item", streamId: "block", value: { type: "assistant-stream", frame: {
    type: "chunk", attemptId: "a", revision: 1, index: 0, time: 1, chunk: {
      type: "block-end", index: 0, block: { type: "text", text: "safe", hostSecret: "hidden" } } } } }).value.frame.chunk,
    { type: "block-end", index: 0, block: { type: "text", text: "safe" } });
  assert.deepEqual(client(open("attachment", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "attachment", value: validShape }));
  assert.equal(host({ type: "item", streamId: "attachment", value: { type: "assistant-stream", frame: {
    type: "chunk", attemptId: "a", revision: 1, index: 0, time: 1, chunk: {
      type: "block-end", index: 0, block: { type: "image", attachment: { secret: "hidden" } } } } } }).type, "error");
  assert.deepEqual(client(open("finish", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "finish", value: validShape }));
  assert.deepEqual(host({ type: "item", streamId: "finish", value: { type: "assistant-stream", frame: {
    type: "chunk", attemptId: "a", revision: 1, index: 0, time: 1, chunk: {
      type: "finish", reason: { kind: "error", failure: { token: "hidden" } },
      replayState: { response: { token: "hidden" } } } } } }).value.frame.chunk,
    { type: "finish", reason: { kind: "error" } });
  assert.deepEqual(client(open("usage", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "usage", value: validShape }));
  assert.deepEqual(host({ type: "item", streamId: "usage", value: { type: "assistant-stream", frame: {
    type: "chunk", attemptId: "a", revision: 1, index: 0, time: 1, chunk: {
      type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, secret: "hidden" } } } } }).value.frame.chunk,
    { type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
  assert.deepEqual(client(open("gap", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "gap", value: validShape }));
  assert.deepEqual(client(open("missing", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.equal(host({ type: "item", streamId: "missing", value: { ...validShape, assistantStream: undefined } }), null);
  assert.equal(host({ type: "item", streamId: "missing", value: { ...validShape,
    assistantStream: { revision: 1, activeAttempt: { attemptId: "a", startedAfterSeq: 3,
      turn: 1, step: 1, nextIndex: 2, stream: [{ type: "text-chunks", time0: 1, index: 0,
        dt: [], texts: ["one"] }] } } } }), null);
  assert.equal(host({ type: "item", streamId: "gap", value: { ...chunk,
    frame: { ...chunk.frame, revision: 2 } } }).type, "error");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.equal(JSON.stringify(snapshot).includes("hidden"), false);
  assert.deepEqual(snapshot.value.projections.values.subagentCatalog, [{ id: "sa", mode: "one-shot", createdAt: 2 }]);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "event",
    event: { type: "turn/start", seq: 4, time: 4, data: { turn: 1 } } } }).value.type, "event");
  assert.deepEqual(client(open("prompt-correlation", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "prompt-correlation", value: validShape }));
  const promptEvent = { type: "user/message", seq: 4, time: 4, surfaceOp: "append",
    data: { id: "user-prompt", role: "user", content: [{ type: "text", text: "hello" }],
      source: { kind: "user", rpcId: "client-request-1", clientTimeZone: "Asia/Shanghai", hostSecret: "hidden" } } };
  assert.deepEqual(host({ type: "item", streamId: "prompt-correlation",
    value: { type: "event", event: promptEvent } }).value.event.data.source,
    { kind: "user", rpcId: "client-request-1", clientTimeZone: "Asia/Shanghai" });
  const runtime = host({ type: "item", streamId: "prompt-correlation", value: { type: "event", event: {
    type: "user/message", seq: 5, time: 5, surfaceOp: "append", data: {
      id: "context", role: "user", content: [{ type: "text", text: "HOST_SECRET" }],
      source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "host", text: "HOST_SECRET" }] } } } } });
  assert.equal(runtime.value.event.seq, 5);
  assert.deepEqual(runtime.value.event.data.source, { kind: "runtime-context", form: "snapshot", sections: [] });
  assert.equal(JSON.stringify(runtime).includes("HOST_SECRET"), false);
  assert.equal(host({ type: "item", streamId: "prompt-correlation", value: { type: "event", event: {
    type: "user/message", seq: 6, time: 6, surfaceOp: "append", data: {
      id: "bad-context", role: "user", content: [{ type: "text", text: "secret" }],
      source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "host", text: 1 }] } } } } }).type, "error");
  assert.deepEqual(client(open("catalog", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "catalog", value: validShape }));
  const catalog = { type: "subagent/catalog", seq: 4, time: 5,
    data: { childId: "sa", childCreatedAt: 4, version: 0, mode: "one-shot", secret: "hidden" } };
  assert.deepEqual(host({ type: "item", streamId: "catalog", value: { type: "event", event: catalog } }).value.event,
    { type: "subagent/catalog", seq: 4, time: 5,
      data: { childId: "sa", childCreatedAt: 4, version: 0, mode: "one-shot" } });
  assert.deepEqual(client(open("descriptor", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "descriptor", value: validShape }));
  assert.deepEqual(host({ type: "item", streamId: "descriptor", value: { type: "event", event: {
    type: "subagent/descriptor", seq: 4, time: 6, data: { version: 3, mode: "continuable",
      provider: "mock", label: "child", persona: "hidden", toolFilter: { secret: "hidden" } } } } }).value.event.data,
    { version: 3, mode: "continuable", provider: "mock", label: "child" });
  assert.deepEqual(client(open("tool", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "tool", value: validShape }));
  const toolResult = { type: "tool/result", seq: 4, time: 7, surfaceOp: "append", data: {
    turn: 1, step: 1, message: { id: "tool-message", role: "tool", toolCallId: "call",
      source: { kind: "tool", callId: "call" }, content: [] }, meta: { apiKey: "hidden" } } };
  assert.deepEqual(host({ type: "item", streamId: "tool", value: { type: "event", event: toolResult } }).value.event,
    { type: "tool/result", seq: 4, time: 7, surfaceOp: "append", data: {
      turn: 1, step: 1, message: { id: "tool-message", role: "tool", toolCallId: "call",
        source: { kind: "tool", callId: "call" }, content: [] } } });
  assert.deepEqual(client(open("known", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  const known = { type: "turn/start", seq: 3, time: 4, data: { turn: 1 }, ignorable: true };
  assert.deepEqual(host({ type: "item", streamId: "known", value: { ...validShape, records: [
    { type: "event", event: known }] } }).value.records[0].event, known);
  assert.deepEqual(client(open("header", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "header", value: validShape }));
  assert.deepEqual(host({ type: "item", streamId: "header", value: { type: "event", event: {
    type: "request/header", seq: 4, time: 6, data: { reason: "change",
      header: { config: { apiKey: "hidden" }, tools: [{ secret: "hidden" }] } } } } }).value.event,
    { type: "request/header", seq: 4, time: 6,
      data: { header: { config: {} }, reason: "change" } });
  assert.deepEqual(client(open("unknown", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "unknown", value: validShape }));
  assert.equal(host({ type: "item", streamId: "unknown", value: { type: "event",
    event: { type: "vendor/unknown", seq: 4, time: 6, data: { secret: "hidden" } } } }).type, "error");
  assert.deepEqual(client(open("known-private", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "known-private", value: validShape }));
  assert.equal(host({ type: "item", streamId: "known-private", value: { type: "event",
    event: { type: "goal/change", seq: 4, time: 6,
      data: { childSessionId: "sb", credential: "private" }, ignorable: true } } }).type, "error");
  assert.deepEqual(client(open("plugin", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  const pluginEvent = { type: "vendor/private", seq: 4, time: 10, data: { secret: "hidden" }, ignorable: true };
  assert.deepEqual(host({ type: "item", streamId: "plugin", value: { ...validShape, records: [
    { type: "event", event: { ...pluginEvent, seq: 3 } }] } }).value.records[0].event,
    { type: "teamhub/redacted-event", seq: 3, time: 10, data: {}, ignorable: true });
  assert.deepEqual(host({ type: "item", streamId: "plugin", value: { type: "event", event: pluginEvent } }).value.event,
    { type: "teamhub/redacted-event", seq: 4, time: 10, data: {}, ignorable: true });
  assert.deepEqual(client(open("bad-plugin", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.equal(host({ type: "item", streamId: "bad-plugin", value: { ...validShape, records: [
    { type: "event", event: { ...pluginEvent, seq: 3, time: "broken" } }] } }), null);
  assert.ok(host({ type: "item", streamId: "bad-plugin", value: validShape }));
  assert.equal(host({ type: "item", streamId: "bad-plugin", value: { type: "event",
    event: { ...pluginEvent, time: "broken" } } }).type, "error");
  assert.deepEqual(client(open("gap", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "gap", value: validShape }));
  assert.equal(host({ type: "item", streamId: "gap", value: { type: "event", event: { type: "message", seq: 5 } } }).type, "error");
  assert.equal(host({ type: "item", streamId: "gap", value: { type: "event", event: { type: "message", seq: 4 } } }), null);
  assert.deepEqual(client(open("nested", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "nested", value: validShape }));
  const nestedStopped = host({ type: "item", streamId: "nested", value: { type: "event",
    event: { type: "assistant/message", data: { childSessionId: "sb" } } } });
  assert.equal(nestedStopped.type, "error");
  assert.equal(JSON.stringify(nestedStopped).includes("sb"), false);
  const stopped = host({ type: "item", streamId: "owned", value: { type: "event", event: { type: "subagent/catalog", data: { childId: "sb" } } } });
  assert.equal(stopped.type, "error", "foreign durable event terminates rather than gaps feed");
  assert.equal(JSON.stringify(stopped).includes("sb"), false);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "event", event: { type: "message" } } }), null);
  assert.equal(host({ type: "item", streamId: "owned", value: { type: "snapshot", header: { id: "sa" } } }), null);
  assert.deepEqual(client(open("revoked", { kind: "session", sessionId: "sa" })).endpoint, "session/follow");
  assert.ok(host({ type: "item", streamId: "revoked", value: validShape }));
  ownership.sessionOwner.set("sa", "ambiguous");
  assert.equal(host({ type: "item", streamId: "revoked", value: { type: "event", event: { secret: true } } }).type, "error");
  assert.equal(host({ type: "item", streamId: "revoked", value: { type: "event", event: { secret: true } } }), null);
});

test("global event readiness hides operator home and drops unscoped events", () => {
  const { client, host } = fixture();
  client({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } });
  assert.deepEqual(host({ type: "item", streamId: "ev", value: { type: "ready", clientId: "client1", host: { home: "/operator/secret" } } }).value,
    { type: "ready", clientId: "client1", host: { home: "/tmp/dsh-team-hub-remote-fixture/workspaces/alice" } });
  assert.equal(host({ type: "item", streamId: "ev", value: { type: "emit", event: "session/added", args: [{ path: "/operator/secret" }] } }), null);
  assert.equal(host({ type: "item", streamId: "ev", value: { type: "waterfall", eventId: "approval1", request: { secret: true } } }), null);
  assert.equal(host({ type: "item", streamId: "ev", value: { type: "ready", clientId: "client2", host: { home: "/operator/secret" } } }), null);
});

test("member receives only own typed session notifications with redacted metadata", () => {
  const { ownership, client, host } = fixture();
  ownership.sessionOwner.set("sa", "alice"); ownership.sessionOwner.set("sb", "bob");
  client({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } });
  host({ type: "item", streamId: "ev", value: { type: "ready", clientId: "client", host: { home: "secret" } } });
  const emit = (event, args) => host({ type: "item", streamId: "ev", value: { type: "emit", event, args } });
  assert.equal(emit("api-session/added", [{ sessionId: "sb", cwd: "/operator", secret: true }]), null);
  assert.equal(emit("api-session/added", [{ sessionId: "sa", parentSessionId: "sb" }]), null);
  const own = emit("api-session/added", [{ sessionId: "sa", cwd: "/tmp/dsh-team-hub-remote-fixture/workspaces/alice", updatedAt: 1, running: false, secret: "leak" }]);
  assert.equal(own.value.args[0].sessionId, "sa");
  assert.equal(JSON.stringify(own).includes("leak"), false);
  assert.equal(emit("api-session/status", ["sb", true]), null);
  assert.deepEqual(emit("api-session/status", ["sa", true]).value.args, ["sa", true]);
  assert.equal(emit("api-session/error", ["sa", "operator /home/private"]), null);
  assert.equal(emit("approval/request", ["sa", "approve"]), null);
});

test("session control baseline and deltas remove foreign projections", () => {
  const { ownership, client, host } = fixture();
  ownership.sessionOwner.set("sa", "alice");
  ownership.sessionOwner.set("sb", "bob");
  assert.equal(client({ type: "open", streamId: "c", endpoint: "session/control", payload: { args: {} } }).endpoint, "session/control");
  const filtered = host({ type: "item", streamId: "c", value: { type: "baseline", value: { projections: {
    sa: { asOfSeq: 3, values: { subagentCatalog: [{ id: "sa", mode: "one-shot", createdAt: 1 }, { id: "sb", mode: "continuable", createdAt: 2, label: "private" }], hostPlugin: { secret: "private" }, modelSelection: { lastUsed: null, next: { provider: "p", model: "m", apiKey: "private" } }, userQuestions: [{ secret: "private" }] } },
    sb: { asOfSeq: 1, values: { secret: true } }
  } } } });
  assert.deepEqual(Object.keys(filtered.value.value.projections), ["sa"]);
  assert.deepEqual(filtered.value.value.projections.sa.values.subagentCatalog, [{ id: "sa", mode: "one-shot", createdAt: 1 }]);
  assert.equal(JSON.stringify(filtered).includes("hostPlugin"), false);
  assert.equal(host({ type: "item", streamId: "c", value: { type: "baseline",
    value: { projections: { sa: { asOfSeq: -1, values: {} } } } } }), null);
  for (const seq of [-1, "3"])
    assert.equal(host({ type: "item", streamId: "c", value: { type: "projection",
      sessionId: "sa", key: "title", value: "owned", seq } }), null);

  assert.equal(JSON.stringify(filtered).includes("private"), false);
  assert.deepEqual(filtered.value.value.projections.sa.values.modelSelection, { lastUsed: null, next: { provider: "p", model: "m" } });
  assert.equal(filtered.value.value.projections.sa.values.userQuestions, undefined);
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sa",
    value: [{ content: "own task", status: "completed", hostSecret: "private" }],
    key: "todos", seq: 7 } }).value.value, [{ content: "own task", status: "completed" }]);
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "turnOutline", seq: 11,
    value: [{ turn: 1, seq: 0, prompt: "own prompt", response: "own response",
      hostSecret: "private" }] } }).value.value,
    [{ turn: 1, seq: 0, prompt: "own prompt", response: "own response" }]);
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "subagentModelSelectionPolicy", seq: 10,
    value: [{ provider: "mock", model: "model", apiKey: "private" }] } }).value.value,
    [{ provider: "mock", model: "model" }]);
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "agentTeam", seq: 8, value: { members: [
      { id: "sa", name: "Alice", role: "lead", phase: "active", secret: "private" }],
      tasks: [], failure: "/private/host/path" } } }).value.value,
    { members: [{ id: "sa", name: "Alice", role: "lead", phase: "active" }],
      tasks: [], failure: "Team state failed" });
  const teamTask = { id: "task-1", revision: 1, subject: "Work", description: "Mine",
    status: "pending", blockedBy: [], writeScopes: ["/private/bob/secret"], ready: true,
    writeScopeWarnings: ["/private/bob/private"] };
  const teamWithTask = host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "agentTeam", seq: 9, value: { members: [
      { id: "sa", name: "Alice", role: "lead", phase: "active" }], tasks: [teamTask] } } });
  assert.deepEqual(teamWithTask.value.value.tasks[0], { ...teamTask, writeScopes: [], writeScopeWarnings: [] });
  assert.equal(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "agentTeam", seq: 9, value: { members: [
      { id: "sb", name: "foreign", role: "teammate", phase: "active" }],
      tasks: [] } } }), null);
  assert.equal(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sb", value: { secret: true }, seq: 1 } }), null);
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sa",
    value: [{ id: "sb", label: "private", mode: "continuable", createdAt: 2 }], key: "subagentCatalog", seq: 4 } }).value.value, []);
  for (const bad of [{ id: "sa", mode: { sessionId: "sb" }, createdAt: 2 },
    { id: "sa", mode: "one-shot", createdAt: { secret: "hidden" } },
    { id: "sa", mode: "one-shot", createdAt: 2, label: { secret: "hidden" } }])
    assert.equal(host({ type: "item", streamId: "c", value: { type: "projection",
      sessionId: "sa", key: "subagentCatalog", seq: 4, value: [bad] } }), null);
  assert.equal(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sa", value: "private", key: "hostPlugin", seq: 2 } }), null);
  assert.equal(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sa", value: "owned", key: "title", seq: 2 } }).value.sessionId, "sa");
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sa",
    value: { lastUsed: null, next: { provider: "p", model: "m", apiKey: "private" } }, key: "modelSelection", seq: 5 } }).value.value,
    { lastUsed: null, next: { provider: "p", model: "m" } });
  assert.equal(host({ type: "item", streamId: "c", value: { type: "projection", sessionId: "sa",
    value: [{ secret: "private" }], key: "userQuestions", seq: 6 } }), null);
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "userQuestions", seq: 12, value: { active: [{
      callId: "call-1", state: "continued", questions: [{ id: "q1",
        question: "Proceed?", intent: { kind: "plan-review", approve: "Yes",
          hostSecret: "private" }, hostSecret: "private" }] }],
      settled: [], hostSecret: "private" } } }).value.value,
    { active: [{ callId: "call-1", state: "continued", questions: [{
      id: "q1", question: "Proceed?", intent: { kind: "plan-review",
        approve: "Yes" } }] }], settled: [] });

  for (const callId of ["", "x".repeat(129)])
    assert.equal(host({ type: "item", streamId: "c", value: { type: "projection",
      sessionId: "sa", key: "userQuestions", seq: 12, value: { active: [{
        callId: "call-1", state: "open", questions: [{ id: "q1", question: "Proceed?",
          intent: { kind: "plan-review", approve: "Yes", callId } }] }], settled: [] } } }), null);
  const inbox = { "next-turn": [{ id: "u1", role: "user", content: [{ type: "text", text: "queued", secret: "private" }],
    source: { kind: "user", rpcId: "request-1", secret: "private" } }], "next-step": [] };
  assert.deepEqual(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "inbox", seq: 13, value: inbox } }).value.value,
    { "next-turn": [{ id: "u1", role: "user", content: [{ type: "text", text: "queued" }],
      source: { kind: "user", rpcId: "request-1" } }], "next-step": [] });
  const foreignInbox = { ...inbox, "next-turn": [{ ...inbox["next-turn"][0],
    source: { kind: "agent-message", form: "relay", senderSessionId: "sb" } }] };
  assert.equal(host({ type: "item", streamId: "c", value: { type: "projection",
    sessionId: "sa", key: "inbox", seq: 14, value: foreignInbox } }), null);
  assert.equal(client({ type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } }).endpoint, "$events");
});

test("owned approval request can be answered only once by its event stream", () => {
  const { ownership, user, streams, client, host } = fixture();
  ownership.sessionOwner.set("sa", "alice");
  ownership.sessionOwner.set("sb", "bob");
  client({ type: "open", streamId: "event-stream", endpoint: "$events", payload: { args: {} } });
  host({ type: "item", streamId: "event-stream", value: { type: "ready", clientId: "generation", host: { home: "/private" } } });
  const request = { type: "waterfall", event: "approval/request", eventId: "approval-1", agentId: "sa",
    request: { toolName: "bash", reason: "Review command" } };
  const delivered = host({ type: "item", streamId: "event-stream", value: request });
  assert.deepEqual(delivered.value, request);
  assert.equal(host({ type: "item", streamId: "event-stream", value: { ...request, eventId: "other", agentId: "sb" } }), null);
  assert.equal(host({ type: "item", streamId: "event-stream", value: { ...request, eventId: "injected", request: { ...request.request, secret: "/private" } } }), null);
  assert.equal(host({ type: "item", streamId: "event-stream", value: { ...request, eventId: "nested", request: { ...request.request, displayReason: { title: { secret: "/private" } } } } }), null);
  assert.equal(host({ type: "item", streamId: "event-stream", value: { ...request, eventId: "metadata-key", request: { ...request.request, displayReason: { metadata: "/private" } } } }), null);
  const withDisplay = { ...request, eventId: "shown", request: { ...request.request, displayReason: { title: "Review", detail: "Execute" } } };
  assert.deepEqual(host({ type: "item", streamId: "event-stream", value: withDisplay }).value, withDisplay);
  assert.equal(host({ type: "item", streamId: "event-stream", value: { ...request, agentId: "sb" } }), null, "a conflicting event ID must revoke its earlier delivery");
  const reply = frame => consumeMemberEventResult({ ownership, user: { name: "alice", role: "member" }, streams, frame });
  const frame = { clientId: "generation", eventId: "approval-1", outcome: { kind: "result", value: "allowed-once" } };
  assert.equal(reply({ ...frame, clientId: "foreign-generation" }), null);
  assert.equal(reply({ ...frame, eventId: "injected" }), null);
  assert.equal(reply({ ...frame, outcome: { kind: "result", value: "always" } }), null);
  ownership.sessionOwner.set("sa", "ambiguous");
  assert.equal(reply(frame), null);
  ownership.sessionOwner.set("sa", "alice");
  assert.equal(reply(frame), null, "conflicting event delivery revoked earlier pending decision");
  assert.deepEqual(host({ type: "item", streamId: "event-stream", value: { ...request, eventId: "approval-2" } }).value.eventId, "approval-2");
  const fresh = { ...frame, eventId: "approval-2" };
  const first = reply(fresh);
  assert.deepEqual(first, fresh);
  assert.equal(reply(fresh), null, "concurrent decision must be rejected");
  settleMemberEventResult({ streams, frame: first, accepted: false });
  const retry = reply(fresh);
  assert.deepEqual(retry, fresh, "failed upstream acknowledgment permits retry");
  settleMemberEventResult({ streams, frame: first, accepted: true });
  assert.equal(reply(fresh), null, "late old acknowledgment cannot release newer reservation");
  settleMemberEventResult({ streams, frame: retry, accepted: true });
  assert.equal(reply(fresh), null, "acknowledged decision cannot be replayed");
});

test("questions require owned agent, validated answer IDs and cancellation", () => {
  const { ownership, streams, client, host } = fixture();
  const user = { name: "alice", role: "member" };
  ownership.sessionOwner.set("sa", "alice");
  client({ type: "open", streamId: "ev", endpoint: "$events", payload: { args: {} } });
  host({ type: "item", streamId: "ev", value: { type: "ready", clientId: "gen", host: { home: "/private" } } });
  const waterfall = { type: "waterfall", event: "user-questions/request", eventId: "q1", agentId: "sa",
    request: { questions: [{ id: "id1", question: "Choose", options: [{ label: "Yes" }] }] } };
  assert.deepEqual(host({ type: "item", streamId: "ev", value: waterfall }).value, waterfall);
  const malformed = { ...waterfall, eventId: "bad-plan", request: { questions: [{ id: "id2", question: "Approve", intent: { kind: "plan-review", approve: "Yes", callId: { secret: "/private" } } }] } };
  assert.equal(host({ type: "item", streamId: "ev", value: malformed }), null);
  const reply = frame => consumeMemberEventResult({ ownership, user, streams, frame });
  const result = { clientId: "gen", eventId: "q1", outcome: { kind: "result", value: { answers: [{ id: "id1", selected: ["Yes"] }] } } };
  assert.equal(reply({ ...result, outcome: { kind: "result", value: { answers: [{ id: "wrong", selected: ["Yes"] }] } } }), null);
  assert.equal(reply({ ...result, outcome: { kind: "result", value: { answers: [{ id: "id1", selected: ["Other"] }] } } }), null);
  assert.equal(reply({ ...result, outcome: { kind: "result", value: { answers: [{ id: "id1", selected: ["Yes"], custom: 1 }] } } }), null);
  assert.equal(reply({ ...result, outcome: { kind: "result", value: { answers: [{ id: "id1", selected: ["Yes", "Yes"] }] } } }), null);
  const multi = { ...waterfall, eventId: "multi", request: { questions: [{ id: "choices", question: "Select", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] } };
  assert.deepEqual(host({ type: "item", streamId: "ev", value: multi }).value, multi);
  const multiReply = selected => reply({ clientId: "gen", eventId: "multi", outcome: { kind: "result", value: { answers: [{ id: "choices", selected }] } } });
  assert.equal(multiReply(["A", "A"]), null);
  const reservedMulti = multiReply(["A", "B"]);
  assert.deepEqual(reservedMulti.outcome.value.answers[0].selected, ["A", "B"]);
  settleMemberEventResult({ streams, frame: reservedMulti, accepted: true });
  const next = { clientId: "gen", eventId: "q1", outcome: { kind: "next" } };
  const reservedNext = reply(next);
  assert.deepEqual(reservedNext.outcome, { kind: "next" });
  assert.equal(reply(result), null);
  settleMemberEventResult({ streams, frame: reservedNext, accepted: true });
  assert.equal(streams.get("ev").pending.has("q1"), false, "acknowledged next removes reservation");
  assert.equal(reply(result), null);
  assert.deepEqual(host({ type: "item", streamId: "ev", value: { ...waterfall, eventId: "q2" } }).value.eventId, "q2");
  assert.deepEqual(host({ type: "item", streamId: "ev", value: { type: "cancel", eventId: "q2" } }).value, { type: "cancel", eventId: "q2" });
  assert.equal(reply({ ...result, eventId: "q2" }), null);
  assert.deepEqual(host({ type: "item", streamId: "ev", value: { ...waterfall, eventId: "q3" } }).value.eventId, "q3");
  client({ type: "cancel", streamId: "ev" });
  assert.equal(reply({ ...result, eventId: "q3" }), null);
});
