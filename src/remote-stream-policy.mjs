import { ownedBy, learnWorkspace, ownerOfPath, userRoot } from "./policy.mjs";
import { MEMBER_PROJECTION_KEYS, projectMemberProjection } from "./session-projections.mjs";
import { projectMemberJournalEvent } from "./session-journal.mjs";

const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const ownSession = (ownership, user, id) => typeof id === "string" && ownedBy(ownership, user, "session", id) === true;
const ownWorkspace = (ownership, user, id) => typeof id === "string" && ownedBy(ownership, user, "workspace", id) === true;
const exact = (value, keys) => record(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const nonempty = value => typeof value === "string" && value.length > 0 && value.length <= 128;

const sequence = value => Number.isSafeInteger(value) && value >= 0;
function projectCompletedAssistantBlock(value) {
  if (!record(value)) return null;
  if (["text", "reasoning"].includes(value.type) && typeof value.text === "string")
    return { type: value.type, text: value.text };
  if (value.type === "tool-call" && typeof value.id === "string" &&
      typeof value.name === "string" && typeof value.arguments === "string")
    return { type: "tool-call", id: value.id, name: value.name, arguments: value.arguments };
  // Production model adapters emit text and tool calls only. Unknown extension
  // blocks and attachments require a per-tenant attachment authorization review.
  return null;
}
function projectAssistantChunk(value) {
  if (!record(value)) return null;
  if (["text-delta", "reasoning-delta"].includes(value.type) &&
      sequence(value.index) && typeof value.text === "string")
    return { type: value.type, index: value.index, text: value.text };
  if (value.type === "tool-call-delta" && sequence(value.index) &&
      typeof value.id === "string" && typeof value.argumentsDelta === "string" &&
      (value.name === undefined || typeof value.name === "string"))
    return { type: value.type, index: value.index, id: value.id,
      ...(value.name !== undefined ? { name: value.name } : {}), argumentsDelta: value.argumentsDelta };
  if (value.type === "block-start" && sequence(value.index) &&
      ["text", "reasoning", "tool-call"].includes(value.blockType))
    return { type: value.type, index: value.index, blockType: value.blockType };
  if (value.type === "block-end" && sequence(value.index)) {
    const block = projectCompletedAssistantBlock(value.block);
    return block ? { type: value.type, index: value.index, block } : null;
  }
  if (value.type === "usage" && record(value.usage) &&
      Number.isFinite(value.usage.inputTokens) && Number.isFinite(value.usage.outputTokens)) {
    const usage = { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens };
    for (const key of ["totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"])
      if (Number.isFinite(value.usage[key])) usage[key] = value.usage[key];
    return { type: "usage", usage };
  }
  if (value.type === "finish" && record(value.reason) &&
      ["stop", "tool-calls", "max-tokens", "aborted", "error"].includes(value.reason.kind)) {
    // Provider replayState and failure diagnostics are adapter-private data.
    return { type: "finish", reason: { kind: value.reason.kind } };
  }
  return null;
}
function projectCompactAssistantRecord(value) {
  if (!record(value)) return null;
  if (value.type === "chunk") {
    if (!Number.isSafeInteger(value.time)) return null;
    const chunk = projectAssistantChunk(value.chunk);
    return chunk ? { type: "chunk", time: value.time, chunk } : null;
  }
  if (!["text-chunks", "reasoning-chunks", "tool-call-chunks"].includes(value.type) ||
      !Number.isSafeInteger(value.time0) || !sequence(value.index) || !Array.isArray(value.dt) ||
      value.dt.some(dt => !Number.isSafeInteger(dt))) return null;
  const members = value.type === "tool-call-chunks" ? value.args : value.texts;
  if (!Array.isArray(members) || members.length === 0 ||
      members.some(member => typeof member !== "string") || value.dt.length !== members.length - 1) return null;
  let time = value.time0;
  for (const gap of value.dt) { time += gap; if (!Number.isSafeInteger(time)) return null; }
  if (value.type === "tool-call-chunks") {
    if (!nonempty(value.id) || value.name !== undefined && !nonempty(value.name)) return null;
    return { type: value.type, time0: value.time0, index: value.index, dt: value.dt,
      id: value.id, ...(value.name !== undefined ? { name: value.name } : {}), args: members };
  }
  return { type: value.type, time0: value.time0, index: value.index, dt: value.dt, texts: members };
}
function projectAssistantBaseline(value) {
  if (!record(value) || !sequence(value.revision)) return null;
  if (value.activeAttempt === undefined) return { revision: value.revision };
  const attempt = value.activeAttempt;
  if (!record(attempt) || !nonempty(attempt.attemptId) || !Number.isSafeInteger(attempt.startedAfterSeq) ||
      attempt.startedAfterSeq < -1 || !sequence(attempt.turn) || !sequence(attempt.step) ||
      !sequence(attempt.nextIndex) || !Array.isArray(attempt.stream)) return null;
  const stream = attempt.stream.map(projectCompactAssistantRecord);
  if (stream.some(entry => !entry) || stream.reduce((count, entry) =>
      count + (entry.type === "chunk" ? 1 : entry.type === "tool-call-chunks" ? entry.args.length : entry.texts.length), 0) !== attempt.nextIndex) return null;
  return { revision: value.revision, activeAttempt: {
    attemptId: attempt.attemptId, startedAfterSeq: attempt.startedAfterSeq,
    turn: attempt.turn, step: attempt.step, nextIndex: attempt.nextIndex, stream } };
}
function projectAssistantFrame(value) {
  if (!record(value) || !sequence(value.revision) || !nonempty(value.attemptId)) return null;
  if (value.type === "start" && Number.isSafeInteger(value.startedAfterSeq) && value.startedAfterSeq >= -1 &&
      sequence(value.turn) && sequence(value.step)) return { type: "start", revision: value.revision,
    attemptId: value.attemptId, startedAfterSeq: value.startedAfterSeq, turn: value.turn, step: value.step };
  if (value.type === "chunk" && sequence(value.index) && Number.isSafeInteger(value.time)) {
    const chunk = projectAssistantChunk(value.chunk);
    return chunk ? { type: "chunk", revision: value.revision,
      attemptId: value.attemptId, index: value.index, time: value.time, chunk } : null;
  }
  if (value.type === "end" && sequence(value.index) && record(value.outcome) &&
      (value.outcome.kind === "abandoned" || value.outcome.kind === "committed" &&
        ["assistant/message", "assistant/attempt"].includes(value.outcome.eventType) && sequence(value.outcome.seq)))
    return { type: "end", revision: value.revision, attemptId: value.attemptId, index: value.index,
      outcome: value.outcome.kind === "abandoned" ? { kind: "abandoned" } :
        { kind: "committed", eventType: value.outcome.eventType, seq: value.outcome.seq } };
  return null;
}

function projectBaseline(ownership, user, baseline) {
  if (!record(baseline) || !sequence(baseline.asOfSeq) || !record(baseline.values)) return null;
  const values = {};
  for (const [key, value] of Object.entries(baseline.values)) {
    if (!MEMBER_PROJECTION_KEYS.has(key)) continue;
    const projected = projectMemberProjection({ key, value, ownsSession: id => ownSession(ownership, user, id) });
    if (projected !== undefined) values[key] = projected;
  }
  return { asOfSeq: baseline.asOfSeq, values };
}

function projectedWaterfall(value) {
  if (!exact(value, ["type", "event", "eventId", "agentId", "request"]) ||
      !nonempty(value.eventId) || !nonempty(value.agentId) || !record(value.request)) return null;
  const request = value.request;
  if (value.event === "approval/request") {
    if (Object.keys(request).some(key => !["toolName", "callId", "reason", "displayReason"].includes(key)) ||
        typeof request.toolName !== "string" || !request.toolName ||
        (request.callId !== undefined && typeof request.callId !== "string") ||
        (request.reason !== undefined && typeof request.reason !== "string") ||
        (request.displayReason !== undefined && (!record(request.displayReason) ||
          Object.keys(request.displayReason).some(key => !["title", "detail"].includes(key)) ||
          Object.values(request.displayReason).some(text => typeof text !== "string")))) return null;
    return { type: "waterfall", event: value.event, eventId: value.eventId, agentId: value.agentId, request: {
      toolName: request.toolName, ...(request.callId !== undefined ? { callId: request.callId } : {}),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      ...(request.displayReason !== undefined ? { displayReason: request.displayReason } : {})
    } };
  }
  if (value.event === "user-questions/request") {
    if (Object.keys(request).some(key => !["questions", "wait"].includes(key)) ||
        !Array.isArray(request.questions) || !request.questions.length || request.questions.length > 20 ||
        new Set(request.questions.map(q => q?.id)).size !== request.questions.length ||
        !request.questions.every(q => record(q) && nonempty(q.id) && typeof q.question === "string" &&
          Object.keys(q).every(key => ["id", "question", "detail", "header", "options", "multiSelect", "intent"].includes(key)) &&
          (q.detail === undefined || typeof q.detail === "string") && (q.header === undefined || typeof q.header === "string") &&
          (q.multiSelect === undefined || typeof q.multiSelect === "boolean") &&
          (q.intent === undefined || (record(q.intent) && q.intent.kind === "plan-review" &&
            typeof q.intent.approve === "string" &&
            (q.intent.callId === undefined || nonempty(q.intent.callId)) &&
            Object.keys(q.intent).every(key => ["kind", "approve", "callId"].includes(key)))) &&
          (q.options === undefined || (Array.isArray(q.options) && q.options.every(option => record(option) &&
            typeof option.label === "string" && (option.description === undefined || typeof option.description === "string") &&
            Object.keys(option).every(key => ["label", "description"].includes(key)))))) ||
        (request.wait !== undefined && (!record(request.wait) || !nonempty(request.wait.callId) ||
          Object.keys(request.wait).some(key => !["callId", "timed"].includes(key)) ||
          (request.wait.timed !== undefined && typeof request.wait.timed !== "boolean")))) return null;
    return { type: "waterfall", event: value.event, eventId: value.eventId, agentId: value.agentId, request: {
      questions: request.questions, ...(request.wait !== undefined ? { wait: request.wait } : {})
    } };
  }
  return null;
}

export function consumeMemberEventResult({ ownership, user, streams, frame }) {
  if (!exact(frame, ["clientId", "eventId", "outcome"]) || !nonempty(frame.clientId) || !nonempty(frame.eventId)) return null;
  for (const stream of streams.values()) {
    if (stream.endpoint !== "$events" || !stream.opened || stream.clientId !== frame.clientId) continue;
    const pending = stream.pending?.get(frame.eventId);
    if (!pending || pending.inFlight || !ownSession(ownership, user, pending.agentId)) return null;
    const outcome = frame.outcome;
    if (!record(outcome)) return null;
    if (outcome.kind === "next" && exact(outcome, ["kind"])) {
      pending.inFlight = true;
      pending.decision = { kind: "next" };
      return { clientId: frame.clientId, eventId: frame.eventId, outcome: pending.decision };
    }
    if (outcome.kind !== "result" || !exact(outcome, ["kind", "value"])) return null;
    if (pending.event === "approval/request" && !["allowed-once", "rejected", "cancelled", "unavailable"].includes(outcome.value)) return null;
    if (pending.event === "user-questions/request" && (!exact(outcome.value, ["answers"]) || !Array.isArray(outcome.value.answers) ||
      outcome.value.answers.length !== pending.questions.length ||
      !outcome.value.answers.every((answer, index) =>
        (exact(answer, ["id", "selected"]) || exact(answer, ["id", "selected", "custom"])) &&
        answer.id === pending.questions[index] && Array.isArray(answer.selected) &&
        new Set(answer.selected).size === answer.selected.length &&
        answer.selected.every(item => typeof item === "string" &&
          pending.options[index].includes(item)) &&
        (pending.multiSelect[index] || answer.selected.length <= 1) &&
        (answer.custom === undefined || typeof answer.custom === "string")))) return null;
    pending.inFlight = true;
    pending.decision = { kind: "result", value: outcome.value };
    return { clientId: frame.clientId, eventId: frame.eventId, outcome: pending.decision };
  }
  return null;
}
export function settleMemberEventResult({ streams, frame, accepted }) {
  for (const stream of streams.values()) {
    if (stream.endpoint !== "$events" || !stream.opened || stream.clientId !== frame.clientId) continue;
    const pending = stream.pending?.get(frame.eventId);
    if (!pending?.inFlight || pending.decision !== frame.outcome) return;
    if (accepted) stream.pending.delete(frame.eventId);
    else { pending.inFlight = false; pending.decision = undefined; }
    return;
  }
}
const memberWorkspace = (ownership, user, view) => ({
  workspaceId: view.workspaceId, path: view.path, title: view.title,
  sessionIds: view.sessionIds.filter(id => ownSession(ownership, user, id)),
  createdAt: view.createdAt, updatedAt: view.updatedAt
});

function ownAddress(ownership, user, address) {
  if (!record(address)) return null;
  if (address.kind === "session" && Object.keys(address).sort().join() === "kind,sessionId" && ownSession(ownership, user, address.sessionId)) return address.sessionId;
  if (address.kind === "subagent" && Object.keys(address).sort().join() === "childSessionId,kind,mode,parentSessionId" &&
      ["one-shot", "continuable", "unknown"].includes(address.mode) &&
      ownSession(ownership, user, address.parentSessionId) && ownSession(ownership, user, address.childSessionId)) return address.childSessionId;
  return null;
}

export function guardRemoteClientFrame({ ownership, user, streams, frame }) {
  if (!record(frame) || typeof frame.streamId !== "string" || !frame.streamId || frame.streamId.length > 128) return null;
  if (frame.type === "open") {
    if (streams.has(frame.streamId) || streams.size >= 32 || !record(frame.payload) || Object.keys(frame.payload).length !== 1 || !record(frame.payload.args)) return null;
    const args = frame.payload.args;
    if (["workspace/follow", "session/control", "$events"].includes(frame.endpoint)) {
      if (Object.keys(args).length) return null;
      streams.set(frame.streamId, { endpoint: frame.endpoint });
      return { type: "open", streamId: frame.streamId, endpoint: frame.endpoint, payload: { args: {} } };
    }
    if (frame.endpoint === "session/follow" && Object.keys(args).length === 1 && record(args.request)) {
      const request = args.request;
      const id = ownAddress(ownership, user, request.address);
      if (!id || Object.keys(request).some(key => !["address", "assistantStream", "maxMessages", "turnWindow"].includes(key)) ||
          (request.assistantStream !== undefined && request.assistantStream !== true) ||
          (request.maxMessages !== undefined && (!Number.isInteger(request.maxMessages) || request.maxMessages < 1 || request.maxMessages > 500)) ||
          (request.turnWindow !== undefined && (!record(request.turnWindow) || Object.keys(request.turnWindow).sort().join() !== "minMessages,minTurns" ||
            !Number.isInteger(request.turnWindow.minMessages) || request.turnWindow.minMessages < 0 || request.turnWindow.minMessages > 200 ||
            !Number.isInteger(request.turnWindow.minTurns) || request.turnWindow.minTurns < 0 || request.turnWindow.minTurns > 100))) return null;
      streams.set(frame.streamId, { endpoint: frame.endpoint, id, address: request.address,
        assistantStream: request.assistantStream === true, opened: false });
      return { type: "open", streamId: frame.streamId, endpoint: frame.endpoint, payload: { args: { request } } };
    }
    return null;
  }
  if (!streams.has(frame.streamId)) return null;
  if (frame.type === "cancel") { streams.delete(frame.streamId); return { type: "cancel", streamId: frame.streamId }; }
  return null;
}

export function filterRemoteServerFrame({ config, ownership, user, streams, frame }) {
  if (!record(frame) || typeof frame.streamId !== "string") return null;
  const stream = streams.get(frame.streamId);
  if (!stream) return null;
  if (frame.type === "error" || frame.type === "end") {
    streams.delete(frame.streamId);
    return frame.type === "end" ? { type: "end", streamId: frame.streamId }
      : { type: "error", streamId: frame.streamId, error: { code: "internal", message: "stream unavailable", details: {} } };
  }
  if (frame.type !== "item" || !record(frame.value)) return null;
  const value = frame.value;
  if (stream.endpoint === "$events") {
    if (value.type === "ready" && !stream.opened && typeof value.clientId === "string" && value.clientId) {
      stream.opened = true;
      stream.clientId = value.clientId;
      stream.pending = new Map();
      // The operator DSH home is never a member-visible path. DSH needs a
      // host.home string to finish boot; supply only this member's root.
      return { type: "item", streamId: frame.streamId, value: { type: "ready", clientId: value.clientId, host: { home: userRoot(config, user) } } };
    }
    if (!stream.opened) return null;
    if (value.type === "cancel" && nonempty(value.eventId)) {
      if (!stream.pending.delete(value.eventId)) return null;
      return { type: "item", streamId: frame.streamId, value: { type: "cancel", eventId: value.eventId } };
    }
    if (value.type === "waterfall") {
      const projected = projectedWaterfall(value);
      // A duplicate ID can no longer authorize the earlier decision: the new
      // delivery might refer to a different owner or different request.
      if (nonempty(value.eventId) && stream.pending.has(value.eventId)) {
        stream.pending.delete(value.eventId);
        return null;
      }
      if (!projected || !ownSession(ownership, user, value.agentId) ||
          stream.pending.size >= 32) return null;
      stream.pending.set(value.eventId, { event: value.event, agentId: value.agentId,
        questions: value.event === "user-questions/request" ? projected.request.questions.map(q => q.id) : [],
        options: value.event === "user-questions/request" ? projected.request.questions.map(q => (q.options || []).map(o => o.label)) : [],
        multiSelect: value.event === "user-questions/request" ? projected.request.questions.map(q => q.multiSelect === true) : [] });
      return { type: "item", streamId: frame.streamId, value: projected };
    }
    if (value.type !== "emit" || !Array.isArray(value.args)) return null;
    const args = value.args;
    if (value.event === "api-session/added" && args.length === 1 && record(args[0]) &&
        ownSession(ownership, user, args[0].sessionId) &&
        (!args[0].parentSessionId || ownSession(ownership, user, args[0].parentSessionId))) {
      const summary = args[0];
      if (summary.cwd !== undefined && (typeof summary.cwd !== "string" || ownerOfPath(config, summary.cwd) !== user.name)) return null;
      if (typeof summary.updatedAt !== "number" || !Number.isFinite(summary.updatedAt)) return null;
      // SessionSummary is extensible upstream; project only the public list
      // fields we currently know, not arbitrary plugin-added metadata.
      const row = { sessionId: summary.sessionId, agentAvailable: summary.agentAvailable === true,
        updatedAt: summary.updatedAt, running: summary.running === true, blank: summary.blank === true,
        ...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
        ...(summary.origin === "subagent" ? { origin: "subagent" } : {}),
        ...(summary.cwd ? { cwd: summary.cwd } : {}) };
      return { type: "item", streamId: frame.streamId, value: { type: "emit", event: value.event, args: [row] } };
    }
    if (["api-session/removed", "api-session/status", "api-session/activity"].includes(value.event) &&
        ownSession(ownership, user, args[0]) &&
        ((value.event === "api-session/removed" && args.length === 1) ||
         (value.event === "api-session/status" && args.length === 2 && typeof args[1] === "boolean") ||
         (value.event === "api-session/activity" && args.length === 2 && Number.isFinite(args[1]))))
      return { type: "item", streamId: frame.streamId, value: { type: "emit", event: value.event, args } };
    // All other host-wide event names remain denied by default.
    return null;
  }
  if (stream.endpoint === "session/follow") {
    if (!ownSession(ownership, user, stream.id)) {
      streams.delete(frame.streamId);
      return { type: "error", streamId: frame.streamId, error: { code: "internal", message: "stream unavailable", details: {} } };
    }
    if (value.type === "snapshot") {
      if (stream.opened || !record(value.header) || value.header.id !== stream.id ||
          !Number.isSafeInteger(value.cursor) || value.cursor < 0 ||
          !Array.isArray(value.records) || typeof value.hasMore !== "boolean" ||
          !Number.isSafeInteger(value.header.version) ||
          !Number.isSafeInteger(value.header.createdAt) || value.header.createdAt < 0 ||
          typeof value.header.isSeeded !== "boolean" ||
          (value.header.cwd !== undefined && (typeof value.header.cwd !== "string" || !value.header.cwd)) ||
          (value.header.parentSession !== undefined && typeof value.header.parentSession !== "string") ||
          (value.header.origin !== undefined && value.header.origin !== "subagent") ||
          (value.header.delegationDepth !== undefined &&
            (!Number.isSafeInteger(value.header.delegationDepth) || value.header.delegationDepth < 0)) ||
          (value.header.agentPreset !== undefined && typeof value.header.agentPreset !== "string") ||
          (stream.address.kind === "subagent" && value.header.parentSession !== stream.address.parentSessionId) ||
          (value.header.parentSession && !ownSession(ownership, user, value.header.parentSession)) ||
          (typeof value.header.cwd === "string" && value.header.cwd && ownerOfPath(config, value.header.cwd) !== user.name)) return null;
      const projections = projectBaseline(ownership, user, value.projections);
      if (value.projections !== undefined && (!projections || projections.asOfSeq > value.cursor)) return null;
      const assistantStream = value.assistantStream === undefined ? undefined : projectAssistantBaseline(value.assistantStream);
      if (value.assistantStream !== undefined && !assistantStream ||
          stream.assistantStream && !assistantStream) return null;
      const records = value.records.map(row => !record(row) || row.type !== "event" ||
        typeof row.event?.data?.childSessionId === "string" && !ownSession(ownership, user, row.event.data.childSessionId)
          ? null : { type: "event", event: projectMemberJournalEvent(row.event, id => ownSession(ownership, user, id)) });
      if (records.some(row => !row?.event) ||
          records.some((row, index) => index > 0 && row.event.seq !== records[index - 1].event.seq + 1) ||
          records.length && records.at(-1).event.seq > value.cursor) return null;
      stream.opened = true;
      stream.cursor = value.cursor;
      stream.assistantRevision = assistantStream?.revision;
      return { type: "item", streamId: frame.streamId, value: { type: "snapshot",
        cursor: value.cursor, records, hasMore: value.hasMore,
        ...(assistantStream ? { assistantStream } : {}),
        header: { version: value.header.version, id: value.header.id, createdAt: value.header.createdAt,
          ...(value.header.cwd ? { cwd: value.header.cwd } : {}),
          ...(value.header.parentSession ? { parentSession: value.header.parentSession } : {}),
          isSeeded: value.header.isSeeded,
          ...(value.header.origin === "subagent" ? { origin: "subagent" } : {}),
          ...(value.header.delegationDepth !== undefined ? { delegationDepth: value.header.delegationDepth } : {}),
          ...(value.header.agentPreset !== undefined ? { agentPreset: value.header.agentPreset } : {}) },
        ...(projections ? { projections } : {}) } };
    }
    if (stream.opened && value.type === "event" &&
        (value.event?.type === "subagent/catalog" && !ownSession(ownership, user, value.event.data?.childId) ||
         typeof value.event?.data?.childSessionId === "string" && !ownSession(ownership, user, value.event.data.childSessionId))) {
      // Dropping one durable journal event would leave an unfillable sequence
      // gap in the browser. Terminate instead of resuming an inconsistent feed.
      streams.delete(frame.streamId);
      return { type: "error", streamId: frame.streamId, error: { code: "internal", message: "stream unavailable", details: {} } };
    }
    if (stream.opened && value.type === "event") {
      const event = projectMemberJournalEvent(value.event, id => ownSession(ownership, user, id));
      if (!event || value.event.seq !== stream.cursor + 1) {
        streams.delete(frame.streamId);
        return { type: "error", streamId: frame.streamId, error: { code: "internal", message: "stream unavailable", details: {} } };
      }
      stream.cursor = value.event.seq;
      return { type: "item", streamId: frame.streamId, value: { type: "event", event } };
    }
    if (stream.opened && value.type === "assistant-stream") {
      const assistantFrame = stream.assistantStream ? projectAssistantFrame(value.frame) : null;
      if (!assistantFrame || assistantFrame.revision !== stream.assistantRevision + 1) {
        streams.delete(frame.streamId);
        return { type: "error", streamId: frame.streamId, error: { code: "internal", message: "stream unavailable", details: {} } };
      }
      stream.assistantRevision = assistantFrame.revision;
      return { type: "item", streamId: frame.streamId, value: { type: "assistant-stream", frame: assistantFrame } };
    }
    return null;
  }
  if (stream.endpoint === "session/control") {
    if (value.type === "baseline" && record(value.value) && record(value.value.projections)) {
      const projections = {};
      for (const [id, baseline] of Object.entries(value.value.projections)) {
        if (!ownSession(ownership, user, id)) continue;
        const projected = projectBaseline(ownership, user, baseline);
        if (!projected) return null;
        projections[id] = projected;
      }
      return { type: "item", streamId: frame.streamId, value: { type: "baseline", value: { projections } } };
    }
    if (value.type === "projection" && ownSession(ownership, user, value.sessionId)) {
      if (!sequence(value.seq) || !MEMBER_PROJECTION_KEYS.has(value.key)) return null;
      const projected = projectMemberProjection({ key: value.key, value: value.value,
        ownsSession: id => ownSession(ownership, user, id) });
      if (projected === undefined) return null;
      return { type: "item", streamId: frame.streamId, value: { type: "projection", sessionId: value.sessionId, key: value.key, value: projected, seq: value.seq } };
    }
    return null;
  }
  if (stream.endpoint !== "workspace/follow") return null;
  if (value.type === "baseline") {
    const baseline = value.value;
    if (!record(baseline) || !Array.isArray(baseline.items) || !Array.isArray(baseline.archivedSessionIds) || !Array.isArray(baseline.pinnedSessionIds)) return null;
    if (!baseline.items.every(item => record(item) && typeof item.workspaceId === "string" && typeof item.path === "string" && Array.isArray(item.sessionIds))) return null;
    for (const item of baseline.items) learnWorkspace(config, ownership, item);
    return { type: "item", streamId: frame.streamId, value: { type: "baseline", value: {
      items: baseline.items.filter(w => ownWorkspace(ownership, user, w.workspaceId)).map(w => memberWorkspace(ownership, user, w)),
      archivedSessionIds: baseline.archivedSessionIds.filter(id => ownSession(ownership, user, id)),
      pinnedSessionIds: baseline.pinnedSessionIds.filter(id => ownSession(ownership, user, id))
    } } };
  }
  if (value.type === "upsert" && record(value.workspace) && Array.isArray(value.workspace.sessionIds)) {
    learnWorkspace(config, ownership, value.workspace);
    if (!ownWorkspace(ownership, user, value.workspace.workspaceId)) return null;
    return { type: "item", streamId: frame.streamId, value: { type: "upsert", workspace: memberWorkspace(ownership, user, value.workspace) } };
  }
  if (value.type === "remove") return ownWorkspace(ownership, user, value.workspaceId) ? { type: "item", streamId: frame.streamId, value: { type: "remove", workspaceId: value.workspaceId } } : null;
  if (value.type === "order" && Array.isArray(value.workspaceIds)) return { type: "item", streamId: frame.streamId, value: { type: "order", workspaceIds: value.workspaceIds.filter(id => ownWorkspace(ownership, user, id)) } };
  if (value.type === "archived" && Array.isArray(value.archivedSessionIds)) return { type: "item", streamId: frame.streamId, value: { type: "archived", archivedSessionIds: value.archivedSessionIds.filter(id => ownSession(ownership, user, id)) } };
  if (value.type === "pinned" && Array.isArray(value.pinnedSessionIds)) return { type: "item", streamId: frame.streamId, value: { type: "pinned", pinnedSessionIds: value.pinnedSessionIds.filter(id => ownSession(ownership, user, id)) } };
  return null;
}
