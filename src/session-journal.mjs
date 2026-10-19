/** DSH 0.2 browser-safe journal projection for reviewed events. */
import { projectGoalSnapshot } from "./session-projections.mjs";
import { projectUserMessage } from "./session-user-message.mjs";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const FEEDBACK_CATEGORIES = new Set(["task-result", "instruction-following", "product-interaction",
  "service-stability", "resource-cost", "security-privacy-permission", "other"]);
// Mirrors DSH 0.2 browser validator KNOWN_SESSION_EVENT_TYPES; update together on upgrade.
const KNOWN_SESSION_EVENT_TYPES = new Set(["agent-preset/selected","agent/inbox/spliced","approval/asked","approval/decided","approval/policy","assistant/attempt","assistant/message","command/done","command/run","compaction/end","compaction/prune","compaction/start","compaction/summary","deliverables/presented","developer/message","feedback/message-delete","feedback/message-put","feedback/record","goal/change","hook/invoked","hook/result","image/offload","llm/retry","llm/retry-started","model/selection","permission/preset","plan/mode","request/context","request/header","sandbox/mode","schedule/change","session-log-deepseek/delivery-accepted","session/end-seed","session/title","session/title-llm-request","step/end","step/start","subagent/catalog","subagent/descriptor","subagent/model-selection-policy","system/message","team/member","team/message/delivered","team/message/queued","team/task","todo/write","tool-workflow/agent-end","tool-workflow/agent-start","tool-workflow/run-end","tool-workflow/run-start","tool/call","tool/ptc-dispatch","tool/ptc-dispatch-start","tool/result","turn/end","turn/start","user/message","web/deepseek-search-llm-request","workspace/changes"]);


function projectAssistantContentBlock(block) {
  if (!record(block)) return null;
  if (["text", "reasoning"].includes(block.type) && typeof block.text === "string")
    return { type: block.type, text: block.text };
  if (block.type === "tool-call" && typeof block.id === "string" &&
      typeof block.name === "string" && typeof block.arguments === "string")
    return { type: "tool-call", id: block.id, name: block.name, arguments: block.arguments };
  // Model-generated attachments and extension blocks lack member authorization.
  return null;
}
function projectAssistantTokenUsage(usage) {
  if (!record(usage) || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens))
    return null;
  const result = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  for (const key of ["totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"])
    if (Number.isFinite(usage[key])) result[key] = usage[key];
  return result;
}
function projectJournalChunk(chunk) {
  if (!record(chunk)) return null;
  if (["text-delta", "reasoning-delta"].includes(chunk.type) &&
      Number.isSafeInteger(chunk.index) && chunk.index >= 0 && typeof chunk.text === "string")
    return { type: chunk.type, index: chunk.index, text: chunk.text };
  if (chunk.type === "tool-call-delta" && Number.isSafeInteger(chunk.index) && chunk.index >= 0 &&
      typeof chunk.id === "string" && typeof chunk.argumentsDelta === "string" &&
      (chunk.name === undefined || typeof chunk.name === "string"))
    return { type: "tool-call-delta", index: chunk.index, id: chunk.id,
      ...(chunk.name !== undefined ? { name: chunk.name } : {}), argumentsDelta: chunk.argumentsDelta };
  if (chunk.type === "block-start" && Number.isSafeInteger(chunk.index) && chunk.index >= 0 &&
      ["text", "reasoning", "tool-call"].includes(chunk.blockType))
    return { type: "block-start", index: chunk.index, blockType: chunk.blockType };
  if (chunk.type === "block-end" && Number.isSafeInteger(chunk.index) && chunk.index >= 0 &&
      record(chunk.block)) {
    const block = chunk.block;
    if (["text", "reasoning"].includes(block.type) && typeof block.text === "string")
      return { type: "block-end", index: chunk.index, block: { type: block.type, text: block.text } };
    if (block.type === "tool-call" && typeof block.id === "string" &&
        typeof block.name === "string" && typeof block.arguments === "string")
      return { type: "block-end", index: chunk.index, block: { type: "tool-call",
        id: block.id, name: block.name, arguments: block.arguments } };
  }
  if (chunk.type === "usage" && record(chunk.usage) &&
      Number.isFinite(chunk.usage.inputTokens) && Number.isFinite(chunk.usage.outputTokens)) {
    const usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens };
    for (const key of ["totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"])
      if (Number.isFinite(chunk.usage[key])) usage[key] = chunk.usage[key];
    return { type: "usage", usage };
  }
  if (chunk.type === "finish" && record(chunk.reason) &&
      ["stop", "tool-calls", "max-tokens", "aborted", "error"].includes(chunk.reason.kind))
    return { type: "finish", reason: { kind: chunk.reason.kind } };
  return null;
}
function projectJournalStream(stream) {
  if (!Array.isArray(stream)) return null;
  const projected = stream.map(record => {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (["text-chunks", "reasoning-chunks"].includes(record.type) &&
        Number.isSafeInteger(record.time0) && Number.isSafeInteger(record.index) && record.index >= 0 &&
        Array.isArray(record.dt) && record.dt.every(Number.isSafeInteger) &&
        Array.isArray(record.texts) && record.texts.length > 0 &&
        record.texts.every(text => typeof text === "string") && record.dt.length === record.texts.length - 1)
      return { type: record.type, time0: record.time0, index: record.index, dt: record.dt, texts: record.texts };
    if (record.type === "tool-call-chunks" && Number.isSafeInteger(record.time0) &&
        Number.isSafeInteger(record.index) && record.index >= 0 &&
        typeof record.id === "string" && record.id.length > 0 &&
        (record.name === undefined || typeof record.name === "string" && record.name.length > 0) &&
        Array.isArray(record.args) && record.args.length > 0 &&
        record.args.every(arg => typeof arg === "string") &&
        Array.isArray(record.dt) && record.dt.every(Number.isSafeInteger) &&
        record.dt.length === record.args.length - 1)
      return { type: "tool-call-chunks", time0: record.time0, index: record.index,
        dt: record.dt, id: record.id,
        ...(record.name !== undefined ? { name: record.name } : {}), args: record.args };
    if (record.type === "chunk" && Number.isSafeInteger(record.time)) {
      const chunk = projectJournalChunk(record.chunk);
      return chunk ? { type: "chunk", time: record.time, chunk } : null;
    }
    return null;
  });
  return projected.some(record => !record) ? null : projected;
}
function projectSurfaceEnvelope(event) {
  const eligible = ["system/message", "developer/message", "user/message", "assistant/message", "tool/result"].includes(event.type);
  if (!eligible && (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined)) return null;
  const op = event.surfaceOp;
  if (op === undefined) {
    if (eligible || event.sourceEventSeqs !== undefined) return null;
    return {};
  }
  let surfaceOp;
  if (op === "append") surfaceOp = "append";
  else if (record(op) && op.op === "replace" &&
      Number.isSafeInteger(op.startSeq) && op.startSeq >= 0 &&
      Number.isSafeInteger(op.endSeq) && op.endSeq >= op.startSeq && op.endSeq < event.seq)
    surfaceOp = { op: "replace", startSeq: op.startSeq, endSeq: op.endSeq };
  else return null;
  if (event.sourceEventSeqs === undefined) return { surfaceOp };
  if (event.type === "assistant/message" || !Array.isArray(event.sourceEventSeqs) ||
      !event.sourceEventSeqs.length ||
      new Set(event.sourceEventSeqs).size !== event.sourceEventSeqs.length ||
      event.sourceEventSeqs.some(seq =>
        !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq)) return null;
  return { surfaceOp, sourceEventSeqs: [...event.sourceEventSeqs] };
}
function projectTeamTask(task, ownsSession) {
  if (!record(task) || typeof task.id !== "string" || !task.id ||
      !Number.isSafeInteger(task.revision) || task.revision < 1 ||
      typeof task.subject !== "string" || typeof task.description !== "string" ||
      !["pending", "in_progress", "completed", "deleted"].includes(task.status) ||
      (task.ownerId !== undefined && (typeof task.ownerId !== "string" || !ownsSession(task.ownerId))) ||
      !Array.isArray(task.blockedBy) ||
      !task.blockedBy.every(id => typeof id === "string") ||
      !Array.isArray(task.writeScopes) ||
      !task.writeScopes.every(scope => typeof scope === "string")) return null;
  return { id: task.id, revision: task.revision, subject: task.subject,
    description: task.description, status: task.status,
    ...(task.ownerId !== undefined ? { ownerId: task.ownerId } : {}),
    blockedBy: [...task.blockedBy], writeScopes: [] }; // Raw scopes may contain Host or foreign paths.
}
export function projectMemberJournalEvent(event, ownsSession) {
  if (!record(event) || typeof event.type !== "string" || !event.type ||
      !Number.isSafeInteger(event.seq) || event.seq < 0 || Object.is(event.seq, -0) ||
      !Number.isSafeInteger(event.time) ||
      !Object.hasOwn(event, "data") || event.data === undefined ||
      (Object.hasOwn(event, "ignorable") && event.ignorable !== true)) return null;
  const surface = projectSurfaceEnvelope(event);
  if (!surface) return null;
  if (event.type === "user/message") {
    const data = projectUserMessage(event.data, ownsSession);
    if (!data) return null;
    return { type: event.type, seq: event.seq, time: event.time, data,
      ...(event.ignorable === true ? { ignorable: true } : {}), ...surface };
  }
  if (event.type === "developer/message") {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step) ||
        !record(data.message) || data.message.role !== "developer" ||
        typeof data.message.id !== "string" || !record(data.message.source) ||
        !Array.isArray(data.message.content)) return null;
    const content = data.message.content.map(block => {
      if (!record(block)) return null;
      if (["tool-addition", "tool-removal"].includes(block.type) && typeof block.toolName === "string")
        return { type: block.type, toolName: block.toolName };
      if (block.type === "text" && typeof block.text === "string")
        return { type: "text", text: block.text };
      return null;
    });
    if (content.some(block => !block) ||
        (content.some(block => block.type === "tool-addition") &&
          (!Number.isSafeInteger(data.headerSeq) || data.headerSeq < 0 || data.headerSeq >= event.seq))) return null;
    if (data.headerSeq !== undefined &&
        (!Number.isSafeInteger(data.headerSeq) || data.headerSeq < 0 || data.headerSeq >= event.seq)) return null;
    const source = data.message.source;
    if (source.kind !== "user") return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      turn: data.turn, step: data.step, message: { id: data.message.id, role: "developer",
        content: content.map(block => block.type === "text"
          ? { type: "text", text: "[Developer message withheld by Team Hub]" } : block),
        source: { kind: "user" } },
      ...(data.headerSeq !== undefined ? { headerSeq: data.headerSeq } : {}) },
      ...(event.ignorable === true ? { ignorable: true } : {}), ...surface };
  }
  if (event.type === "system/message") {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step) ||
        !record(data.message) || data.message.role !== "system" ||
        typeof data.message.id !== "string" || !record(data.message.source) ||
        data.message.source.kind !== "system-prompt" ||
        !Array.isArray(data.message.content)) return null;
    const content = data.message.content.map(block => record(block) && block.type === "text" &&
      typeof block.text === "string" ? { type: "text", text: block.text } : null);
    if (content.some(block => !block)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      turn: data.turn, step: data.step, message: { id: data.message.id, role: "system",
        content: [{ type: "text", text: "[System prompt withheld by Team Hub]" }],
        source: { kind: "system-prompt" } } },
      ...(event.ignorable === true ? { ignorable: true } : {}), ...surface };
  }
  if (["turn/start", "step/start", "step/end", "turn/end"].includes(event.type)) {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || data.turn < 0 ||
        (event.type.startsWith("step/") && (!Number.isSafeInteger(data.step) || data.step < 0))) return null;
    const result = { turn: data.turn,
      ...(event.type.startsWith("step/") ? { step: data.step } : {}) };
    if (event.type === "turn/end") {
      if (!record(data.reason)) return null;
      const kind = data.reason.kind;
      if (["completed", "blocked", "max-tokens", "interrupted", "forked"].includes(kind))
        result.reason = { kind };
      else if (kind === "error" && record(data.reason.error) &&
          typeof data.reason.error.code === "string")
        result.reason = { kind: "error", error: { code: data.reason.error.code, message: "request failed" } };
      else if (kind === "aborted" && record(data.reason.reason) &&
          ["user", "parent", "hook", "disposed", "legacy"].includes(data.reason.reason.kind))
        result.reason = { kind: "aborted", reason: { kind: data.reason.reason.kind,
          ...(data.reason.reason.kind === "hook" ? { reason: "cancelled by hook" } : {}) } };
      else return null;
    }
    return { type: event.type, seq: event.seq, time: event.time, data: result,
      ...(event.ignorable === true ? { ignorable: true } : {}) };
  }
  if (event.type === "assistant/attempt" || event.type === "assistant/message") {
    const data = event.data;
    const stream = projectJournalStream(data?.stream);
    if (!record(data) || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step) || !stream) return null;
    if (event.type === "assistant/attempt") return { type: event.type, seq: event.seq, time: event.time,
      data: { turn: data.turn, step: data.step, stream },
      ...(event.ignorable === true ? { ignorable: true } : {}) };
    if (!record(data) || !record(data.message) || data.message.role !== "assistant" ||
        !record(data.message.source) || data.message.source.kind !== "model" ||
        typeof data.message.source.provider !== "string" ||
        typeof data.message.source.model !== "string" || typeof data.message.id !== "string" ||
        !Array.isArray(data.message.content)) return null;
    const content = data.message.content.map(projectAssistantContentBlock);
    const usage = data.usage === undefined ? undefined : projectAssistantTokenUsage(data.usage);
    if (content.some(block => !block) || data.usage !== undefined && !usage) return null;
    // Replay state is adapter-private; do not return it in follow or pages.
    return { type: event.type, seq: event.seq, time: event.time,
      data: { turn: data.turn, step: data.step, stream,
        ...(data.interrupted === true ? { interrupted: true } : {}),
        message: { id: data.message.id, role: "assistant", content, source: { kind: "model",
          provider: data.message.source.provider, model: data.message.source.model } },
        ...(usage !== undefined ? { usage } : {}) },
      ...(event.ignorable === true ? { ignorable: true } : {}),
      ...surface };
  }
  if (event.type === "subagent/catalog") {
    const data = event.data;
    if (!record(data) || typeof data.childId !== "string" || !ownsSession(data.childId) ||
        !Number.isSafeInteger(data.childCreatedAt) || ![0, 1].includes(data.version) ||
        !["one-shot", "continuable", "unknown"].includes(data.mode) ||
        (data.mode === "unknown" && data.version !== 1) ||
        (data.mode === "continuable" && typeof data.label !== "string") ||
        (data.label !== undefined && typeof data.label !== "string")) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { childId: data.childId, childCreatedAt: data.childCreatedAt,
        version: data.version, mode: data.mode,
        ...(data.label !== undefined ? { label: data.label } : {}) } };
  }
  if (event.type === "subagent/descriptor") {
    const data = event.data;
    if (!record(data) || data.version !== 3 ||
        !["one-shot", "continuable"].includes(data.mode) ||
        typeof data.provider !== "string" ||
        (data.label !== undefined && typeof data.label !== "string") ||
        (data.mode === "continuable" && typeof data.label !== "string")) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { version: 3, mode: data.mode, provider: data.provider,
        ...(data.label !== undefined ? { label: data.label } : {}) } };
  }
  if (event.type === "tool/call") {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step) ||
        typeof data.callId !== "string" || typeof data.name !== "string" ||
        typeof data.arguments !== "string") return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { turn: data.turn, step: data.step, callId: data.callId,
        name: data.name, arguments: data.arguments },
      ...(event.ignorable === true ? { ignorable: true } : {}),
      ...surface };
  }
  if (event.type === "tool/result") {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || !Number.isSafeInteger(data.step) ||
        !record(data.message) || data.message.role !== "tool" ||
        typeof data.message.id !== "string" || typeof data.message.toolCallId !== "string" ||
        !record(data.message.source) || data.message.source.kind !== "tool" ||
        data.message.source.callId !== data.message.toolCallId ||
        !Array.isArray(data.message.content)) return null;
    const content = data.message.content.map(block => record(block) && block.type === "text" &&
      typeof block.text === "string" ? { type: "text", text: block.text } : null);
    if (content.some(block => !block)) return null;
    // Tool-private meta is JSON, but may include Host paths, credentials, or
    // other members' context. Keep only the model-facing message and error ID.
    return { type: event.type, seq: event.seq, time: event.time,
      data: { turn: data.turn, step: data.step, message: { id: data.message.id, role: "tool",
        source: { kind: "tool", callId: data.message.toolCallId },
        toolCallId: data.message.toolCallId, content,
        ...(data.message.isError === true ? { isError: true } : {}) },
        ...(record(data.error) && typeof data.error.name === "string" && typeof data.error.code === "string"
          ? { error: { name: data.error.name, code: data.error.code } } : {}) },
      ...surface };
  }
  if (event.type === "request/header") {
    const data = event.data;
    if (!record(data) || !record(data.header) || !record(data.header.config) ||
        !["initial", "resume", "change", "series"].includes(data.reason)) return null;
    // Header tool schemas and adapter defaults are internal request material.
    // Browser validation only requires a nonempty header object without these.
    return { type: event.type, seq: event.seq, time: event.time,
      data: { header: { config: {} }, reason: data.reason,
        ...(data.startsSeries === true ? { startsSeries: true } : {}) } };
  }
  if (event.type === "request/context") {
    if (!record(event.data) || typeof event.data.provider !== "string" ||
        typeof event.data.model !== "string") return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      provider: event.data.provider, model: event.data.model,
      ...(Number.isSafeInteger(event.data.contextWindow) ? { contextWindow: event.data.contextWindow } : {}) } };
  }
  if (event.type === "compaction/start" || event.type === "compaction/end") {
    const data = event.data;
    if (!record(data) || typeof data.compactionId !== "string" ||
        (data.sourceCommandId !== undefined && typeof data.sourceCommandId !== "string") ||
        !(data.turn === null || Number.isSafeInteger(data.turn) && data.turn >= 0)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      compactionId: data.compactionId, turn: data.turn,
      ...(data.sourceCommandId !== undefined ? { sourceCommandId: data.sourceCommandId } : {}),
      ...(event.type === "compaction/end" && data.error !== undefined ?
        { error: "Compaction failed" } : {}) } };
  }
  if (event.type === "compaction/prune" || event.type === "compaction/summary") {
    const data = event.data, range = data?.shadowedRange;
    if (!record(data) || !record(range) ||
        !Number.isSafeInteger(range.start) || range.start < 0 ||
        !Number.isSafeInteger(range.end) || range.end < range.start ||
        range.end >= event.seq || !Array.isArray(data.shadowedSeqs) ||
        !data.shadowedSeqs.every(seq => Number.isSafeInteger(seq) && seq >= range.start && seq <= range.end) ||
        !Number.isSafeInteger(data.shadowedTokenCount) || data.shadowedTokenCount < 0) return null;
    const safe = { shadowedRange: { start: range.start, end: range.end },
      shadowedSeqs: [...data.shadowedSeqs], shadowedTokenCount: data.shadowedTokenCount };
    if (event.type === "compaction/summary") {
      if (typeof data.compactionId !== "string" ||
          (data.sourceCommandId !== undefined && typeof data.sourceCommandId !== "string") ||
          !Array.isArray(data.summary) || typeof data.provider !== "string" ||
          typeof data.model !== "string") return null;
      const summary = data.summary.map(block => record(block) && block.type === "text" &&
        typeof block.text === "string" ? { type: "text", text: block.text } : null);
      if (summary.some(block => !block)) return null;
      Object.assign(safe, { compactionId: data.compactionId, summary,
        provider: data.provider, model: data.model,
        ...(data.sourceCommandId !== undefined ? { sourceCommandId: data.sourceCommandId } : {}) });
    }
    return { type: event.type, seq: event.seq, time: event.time, data: safe };
  }
  if (event.type.startsWith("tool-workflow/")) {
    const data = event.data;
    if (!record(data) || typeof data.runId !== "string" || !data.runId) return null;
    let projected;
    if (event.type === "tool-workflow/run-start" && typeof data.name === "string")
      projected = { runId: data.runId, name: data.name };
    else if (event.type === "tool-workflow/agent-start" &&
        Number.isSafeInteger(data.seq) && data.seq >= 0 &&
        typeof data.label === "string" &&
        (data.phase === undefined || typeof data.phase === "string") &&
        typeof data.childId === "string" && ownsSession(data.childId))
      projected = { runId: data.runId, seq: data.seq, label: data.label,
        ...(data.phase !== undefined ? { phase: data.phase } : {}),
        childId: data.childId };
    else if (event.type === "tool-workflow/agent-end" &&
        Number.isSafeInteger(data.seq) && data.seq >= 0 &&
        ["completed", "failed", "cancelled"].includes(data.outcome))
      projected = { runId: data.runId, seq: data.seq, outcome: data.outcome };
    else if (event.type === "tool-workflow/run-end" &&
        ["completed", "cancelled", "error"].includes(data.stopReason))
      projected = { runId: data.runId, stopReason: data.stopReason };
    if (!projected) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: projected };
  }
  if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
    const data = event.data;
    if (!record(data) || typeof data.rootCallId !== "string" ||
        typeof data.parentCallId !== "string" || typeof data.subCallId !== "string" ||
        typeof data.name !== "string" || !Object.hasOwn(data, "arguments")) return null;
    const safe = { rootCallId: data.rootCallId, parentCallId: data.parentCallId,
      subCallId: data.subCallId, name: data.name, arguments: {} };
    // Nested arbitrary JSON can embed other member IDs and Host credentials;
    // a placeholder preserves the browser validator shape without exposing it.
    if (event.type === "tool/ptc-dispatch") {
      if (typeof data.isError !== "boolean" || !Array.isArray(data.content)) return null;
      const content = data.content.map(block => record(block) && block.type === "text" &&
        typeof block.text === "string" ? { type: "text", text: block.text } : null);
      if (content.some(block => !block)) return null;
      Object.assign(safe, { isError: data.isError, content });
      if (data.error !== undefined) {
        if (!record(data.error) || typeof data.error.name !== "string" ||
            typeof data.error.code !== "string") return null;
        safe.error = { name: data.error.name, code: data.error.code };
      }
    }
    return { type: event.type, seq: event.seq, time: event.time, data: safe };
  }
  if (event.type === "hook/invoked") {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || data.turn < 0 ||
        typeof data.point !== "string" ||
        !["claude-code", "codex"].includes(data.dialect) ||
        (data.matcher !== undefined && typeof data.matcher !== "string") ||
        typeof data.handlerId !== "string") return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      turn: data.turn, point: data.point, dialect: data.dialect,
      ...(data.matcher !== undefined ? { matcher: data.matcher } : {}),
      handlerId: data.handlerId } };
  }
  if (event.type === "hook/result") {
    const data = event.data;
    if (!record(data) || !Number.isSafeInteger(data.turn) || data.turn < 0 ||
        typeof data.point !== "string" || typeof data.handlerId !== "string" ||
        typeof data.decision !== "string" ||
        (data.exitCode !== undefined && !Number.isSafeInteger(data.exitCode)) ||
        !Number.isFinite(data.durationMs) || data.durationMs < 0) return null;
    // stderrSummary may include command output, Host paths and credentials.
    return { type: event.type, seq: event.seq, time: event.time, data: {
      turn: data.turn, point: data.point, handlerId: data.handlerId,
      decision: data.decision, durationMs: data.durationMs,
      ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}) } };
  }
  if (event.type === "image/offload") {
    const data = event.data;
    if (!record(data) || !Array.isArray(data.targets) || !data.targets.length ||
        !data.targets.every(target => record(target) &&
          Number.isSafeInteger(target.seq) && target.seq >= 0 && target.seq < event.seq &&
          Array.isArray(target.imageIndexes) && target.imageIndexes.length > 0 &&
          target.imageIndexes.every((index, position) => Number.isSafeInteger(index) &&
            index >= 0 && (position === 0 || index > target.imageIndexes[position - 1])))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      targets: data.targets.map(target => ({ seq: target.seq,
        imageIndexes: [...target.imageIndexes] })) } };
  }
  if (event.type === "subagent/model-selection-policy") {
    const data = event.data;
    if (!record(data) || !Array.isArray(data.allowedModels) ||
        !data.allowedModels.every(route => record(route) &&
          typeof route.provider === "string" && typeof route.model === "string")) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      allowedModels: data.allowedModels.map(route => ({
        provider: route.provider, model: route.model })) } };
  }
  if (event.type === "team/task") {
    const data = event.data;
    if (!record(data) || data.version !== 2 ||
        typeof data.teamId !== "string" || !ownsSession(data.teamId)) return null;
    const task = projectTeamTask(data.task, ownsSession);
    if (!task) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      version: 2, teamId: data.teamId, task } };
  }
  if (event.type === "team/message/queued") {
    const data = event.data, message = data?.message;
    if (!record(data) || data.version !== 2 ||
        typeof data.teamId !== "string" || !ownsSession(data.teamId) ||
        !record(message) || typeof message.id !== "string" ||
        typeof message.senderId !== "string" || !ownsSession(message.senderId) ||
        typeof message.targetId !== "string" || !ownsSession(message.targetId) ||
        typeof message.senderName !== "string" || !Array.isArray(message.content)) return null;
    const content = message.content.map(block => record(block) && block.type === "text" &&
      typeof block.text === "string" ? { type: "text", text: block.text } : null);
    if (content.some(block => !block)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      version: 2, teamId: data.teamId, message: { id: message.id,
        senderId: message.senderId, senderName: message.senderName,
        targetId: message.targetId, content } } };
  }
  if (event.type === "team/message/delivered") {
    const data = event.data;
    if (!record(data) || data.version !== 2 ||
        typeof data.teamId !== "string" || !ownsSession(data.teamId) ||
        typeof data.messageId !== "string" ||
        typeof data.targetId !== "string" || !ownsSession(data.targetId)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      version: 2, teamId: data.teamId, messageId: data.messageId, targetId: data.targetId } };
  }
  if (event.type === "team/member") {
    const data = event.data;
    if (!record(data) || data.version !== 2 ||
        typeof data.teamId !== "string" || !ownsSession(data.teamId) ||
        !record(data.member) || typeof data.member.id !== "string" ||
        !ownsSession(data.member.id) ||
        typeof data.member.name !== "string" || typeof data.member.description !== "string" ||
        typeof data.member.provider !== "string" ||
        !["fresh", "fork"].includes(data.member.context) ||
        !["provisioning", "active", "failed"].includes(data.member.phase)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      version: 2, teamId: data.teamId, member: { id: data.member.id,
        name: data.member.name, description: data.member.description,
        provider: data.member.provider, context: data.member.context,
        phase: data.member.phase,
        ...(data.member.phase === "failed" ? { error: "Team member failed" } : {}) } } };
  }
  if (event.type === "schedule/change") {
    const data = event.data;
    if (!record(data) || data.version !== 1) return null;
    if (["delete", "dispatch"].includes(data.operation) &&
        typeof data.id === "string" && data.id &&
        (data.acceptedAt === undefined || typeof data.acceptedAt === "string"))
      return { type: event.type, seq: event.seq, time: event.time, data: {
        version: 1, operation: data.operation, id: data.id,
        ...(data.acceptedAt !== undefined ? { acceptedAt: data.acceptedAt } : {}) } };
    const schedule = data.schedule;
    if (data.operation !== "create" || !record(schedule) ||
        typeof schedule.id !== "string" || !schedule.id ||
        !["after", "at", "every"].includes(schedule.kind) ||
        (schedule.title !== undefined && typeof schedule.title !== "string") ||
        typeof schedule.prompt !== "string" || typeof schedule.scheduledAt !== "string" ||
        (schedule.kind === "after" && (!Number.isSafeInteger(schedule.afterSeconds) || schedule.afterSeconds <= 0)) ||
        (schedule.kind === "every" && (!Number.isSafeInteger(schedule.everySeconds) || schedule.everySeconds <= 0))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      version: 1, operation: "create", schedule: { id: schedule.id, kind: schedule.kind,
        ...(schedule.title !== undefined ? { title: schedule.title } : {}),
        prompt: schedule.prompt, scheduledAt: schedule.scheduledAt,
        ...(schedule.kind === "after" ? { afterSeconds: schedule.afterSeconds } : {}),
        ...(schedule.kind === "every" ? { everySeconds: schedule.everySeconds } : {}) } } };
  }
  if (event.type === "goal/change") {
    const data = event.data;
    if (!record(data) || data.kind !== "goal/change" || data.version !== 1) return null;
    if (data.operation === "clear") {
      if (!record(data.cleared) || typeof data.cleared.id !== "string" ||
          !Number.isSafeInteger(data.cleared.revision) || data.cleared.revision < 1 ||
          !Number.isFinite(data.clearedAt)) return null;
      return { type: event.type, seq: event.seq, time: event.time, data: {
        kind: "goal/change", version: 1, operation: "clear",
        cleared: { id: data.cleared.id, revision: data.cleared.revision },
        clearedAt: data.clearedAt } };
    }
    if (!["create", "edit", "pause", "resume", "complete", "block"].includes(data.operation) ||
        !Number.isSafeInteger(data.roundsStarted) || data.roundsStarted < 0 ||
        !Number.isFinite(data.createdAt) || !Number.isFinite(data.updatedAt)) return null;
    const goal = projectGoalSnapshot(data.goal);
    if (!goal) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      kind: "goal/change", version: 1, operation: data.operation, goal,
      roundsStarted: data.roundsStarted, createdAt: data.createdAt, updatedAt: data.updatedAt } };
  }
  if (event.type === "todo/write") {
    const data = event.data;
    if (!record(data) || !Array.isArray(data.todos) ||
        !data.todos.every(todo => record(todo) && typeof todo.content === "string" &&
          ["pending", "in_progress", "completed"].includes(todo.status))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      todos: data.todos.map(todo => ({ content: todo.content, status: todo.status })) } };
  }
  if (event.type === "agent/inbox/spliced") {
    const data = event.data;
    if (!record(data) || !["next-turn", "next-step"].includes(data.target) ||
        !Number.isSafeInteger(data.start) || data.start < 0 ||
        (data.removedCount !== undefined && (!Number.isSafeInteger(data.removedCount) || data.removedCount < 0)) ||
        (data.outcome !== undefined && data.outcome !== "canceled") ||
        !Array.isArray(data.inserted)) return null;
    const inserted = data.inserted.map(message => projectUserMessage(message, ownsSession));
    if (inserted.some(message => !message)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      target: data.target, start: data.start, inserted,
      ...(data.removedCount !== undefined ? { removedCount: data.removedCount } : {}),
      ...(data.outcome !== undefined ? { outcome: data.outcome } : {}) } };
  }
  if (event.type === "workspace/changes") {
    if (!record(event.data) || !Number.isSafeInteger(event.data.turn) || event.data.turn < 0) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: { turn: event.data.turn } };
  }
  if (event.type === "session-log-deepseek/delivery-accepted") {
    const data = event.data;
    if (!record(data) || typeof data.sessionId !== "string" || !ownsSession(data.sessionId) ||
        !Number.isSafeInteger(data.throughSeq) || data.throughSeq < 0 ||
        (data.sessionFormatVersion !== undefined && (!Number.isSafeInteger(data.sessionFormatVersion) ||
          data.sessionFormatVersion < 0))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      sessionId: data.sessionId, throughSeq: data.throughSeq,
      ...(data.sessionFormatVersion !== undefined ? { sessionFormatVersion: data.sessionFormatVersion } : {}) } };
  }
  if (event.type === "web/deepseek-search-llm-request") {
    const data = event.data;
    if (!record(data) || typeof data.endpoint !== "string" ||
        typeof data.apiVersion !== "string" || !record(data.body) ||
        typeof data.body.model !== "string" ||
        !Number.isSafeInteger(data.body.max_tokens) || data.body.max_tokens < 0 ||
        !Array.isArray(data.body.messages) || data.body.messages.length !== 1 ||
        !record(data.body.messages[0]) || data.body.messages[0].role !== "user" ||
        !Array.isArray(data.body.messages[0].content) ||
        data.body.messages[0].content.length !== 1 ||
        !record(data.body.messages[0].content[0]) ||
        data.body.messages[0].content[0].type !== "text" ||
        typeof data.body.messages[0].content[0].text !== "string" ||
        !Array.isArray(data.body.tools) || data.body.tools.length !== 1 ||
        !record(data.body.tools[0]) || data.body.tools[0].type !== "web_search_20250305" ||
        data.body.tools[0].name !== "web_search" ||
        !Number.isSafeInteger(data.body.tools[0].max_uses) || data.body.tools[0].max_uses < 0) return null;
    // The endpoint and query can reveal private deployment and search terms.
    return { type: event.type, seq: event.seq, time: event.time, data: {
      endpoint: "", apiVersion: data.apiVersion, body: { model: data.body.model,
        max_tokens: data.body.max_tokens, messages: [{ role: "user",
          content: [{ type: "text", text: "" }] }],
        tools: [{ type: "web_search_20250305", name: "web_search",
          max_uses: data.body.tools[0].max_uses }] } } };
  }
  if (event.type === "session/title-llm-request") {
    const data = event.data;
    if (!record(data) || typeof data.titleProvider !== "string" || !data.titleProvider ||
        !Array.isArray(data.messageSeqs) || data.messageSeqs.some(seq =>
          !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq) ||
        !record(data.route) || typeof data.route.provider !== "string" ||
        typeof data.route.model !== "string" || typeof data.system !== "string" ||
        !Array.isArray(data.messages) || !Number.isSafeInteger(data.maxTokens) || data.maxTokens < 0) return null;
    // Auxiliary prompts and model messages may embed private Host instructions.
    return { type: event.type, seq: event.seq, time: event.time, data: {
      titleProvider: data.titleProvider, messageSeqs: [...data.messageSeqs],
      route: { provider: data.route.provider, model: data.route.model },
      system: "", messages: [], maxTokens: data.maxTokens } };
  }
  if (event.type === "llm/retry" || event.type === "llm/retry-started") {
    const data = event.data;
    if (!record(data) || typeof data.retryId !== "string" || !data.retryId ||
        !["turn", "step", "retry"].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)) return null;
    const projected = { retryId: data.retryId, turn: data.turn, step: data.step, retry: data.retry };
    if (event.type === "llm/retry") {
      if (typeof data.provider !== "string" || !data.provider ||
          !["normal", "always"].includes(data.mode) ||
          typeof data.policyKey !== "string" || !data.policyKey ||
          !Number.isFinite(data.delayMs) || data.delayMs < 0 ||
          (data.mode === "normal" && (!Number.isSafeInteger(data.maxRetries) || data.maxRetries < 0)) ||
          !record(data.failure) || typeof data.failure.code !== "string" ||
          typeof data.failure.message !== "string") return null;
      Object.assign(projected, { provider: data.provider, mode: data.mode,
        policyKey: data.policyKey, delayMs: data.delayMs,
        ...(data.mode === "normal" ? { maxRetries: data.maxRetries } : {}),
        failure: { code: data.failure.code, message: "Model request failed" } });
    }
    return { type: event.type, seq: event.seq, time: event.time, data: projected };
  }
  if (event.type === "command/run") {
    const data = event.data;
    if (!record(data) || typeof data.commandId !== "string" || !data.commandId ||
        typeof data.name !== "string" || !data.name || !record(data.source) ||
        data.source.kind !== "user" || (data.args !== undefined && typeof data.args !== "string")) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      commandId: data.commandId, name: data.name, source: { kind: "user" },
      ...(data.args !== undefined ? { args: data.args } : {}) } };
  }
  if (event.type === "command/done") {
    const data = event.data;
    if (!record(data) || typeof data.commandId !== "string" || !data.commandId ||
        !["success", "error"].includes(data.kind) ||
        (data.text !== undefined && typeof data.text !== "string") ||
        (data.kind === "error" && typeof data.text !== "string") ||
        (data.sourceEventSeq !== undefined && (!Number.isSafeInteger(data.sourceEventSeq) ||
          data.sourceEventSeq < 0 || data.sourceEventSeq >= event.seq || data.kind !== "success"))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      commandId: data.commandId, kind: data.kind,
      ...(data.kind === "error" ? { text: "Command failed" } :
        data.text !== undefined ? { text: data.text } : {}),
      ...(data.sourceEventSeq !== undefined ? { sourceEventSeq: data.sourceEventSeq } : {}) } };
  }
  if (event.type === "feedback/record") {
    const data = event.data;
    if (!record(data) || (data.text !== undefined && typeof data.text !== "string") ||
        (data.category !== undefined && !FEEDBACK_CATEGORIES.has(data.category))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      ...(data.text !== undefined ? { text: data.text } : {}),
      ...(data.category !== undefined ? { category: data.category } : {}) } };
  }
  if (event.type === "feedback/message-put" || event.type === "feedback/message-delete") {
    const data = event.data;
    if (!record(data) || typeof data.sessionId !== "string" || !ownsSession(data.sessionId)) return null;
    if (event.type === "feedback/message-delete") {
      if (typeof data.messageId !== "string") return null;
      return { type: event.type, seq: event.seq, time: event.time,
        data: { sessionId: data.sessionId, messageId: data.messageId } };
    }
    const item = data.item;
    if (!record(item) || typeof item.messageId !== "string" ||
        !["positive", "negative"].includes(item.rating) || typeof item.version !== "string" ||
        !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) ||
        (item.note !== undefined && typeof item.note !== "string") ||
        (item.category !== undefined && !FEEDBACK_CATEGORIES.has(item.category))) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: { sessionId: data.sessionId,
      item: { messageId: item.messageId, rating: item.rating, version: item.version,
        createdAt: item.createdAt, updatedAt: item.updatedAt,
        ...(item.note !== undefined ? { note: item.note } : {}),
        ...(item.category !== undefined ? { category: item.category } : {}) } } };
  }
  if (event.type === "approval/asked") {
    const data = event.data;
    if (!record(data) || typeof data.id !== "string" || !data.id ||
        typeof data.toolName !== "string" || !data.toolName ||
        (data.callId !== undefined && (typeof data.callId !== "string" ||
          !data.callId || data.callId.length > 128)) ||
        (data.reason !== undefined && typeof data.reason !== "string")) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      id: data.id, toolName: data.toolName,
      ...(data.callId !== undefined ? { callId: data.callId } : {}),
      ...(data.reason !== undefined ? { reason: data.reason } : {}) } };
  }
  if (event.type === "approval/decided") {
    const data = event.data;
    if (!record(data) || typeof data.id !== "string" || !data.id ||
        !["allowed-once", "rejected", "cancelled", "unavailable"].includes(data.outcome)) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { id: data.id, outcome: data.outcome } };
  }
  if (event.type === "session/end-seed") {
    if (!record(event.data) || (event.data.inherited !== undefined && event.data.inherited !== true)) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { ...(event.data.inherited === true ? { inherited: true } : {}) } };
  }
  if (event.type === "sandbox/mode") {
    const data = event.data;
    if (!record(data) || !["workspace-write", "danger-full-access"].includes(data.mode) ||
        (data.source !== undefined && data.source !== "delegation")) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { mode: "workspace-write",
        ...(data.source === "delegation" ? { source: "delegation" } : {}) } };
  }
  if (event.type === "approval/policy") {
    const data = event.data;
    if (!record(data) || !["ask", "never"].includes(data.policy) ||
        (data.source !== undefined && data.source !== "delegation")) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { policy: data.policy,
        ...(data.source === "delegation" ? { source: "delegation" } : {}) } };
  }
  if (event.type === "permission/preset") {
    if (!record(event.data) || !["workspace-write", "danger-full-access"].includes(event.data.preset)) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: { preset: "workspace-write" } };
  }
  if (event.type === "model/selection") {
    const data = event.data;
    if (!record(data) || typeof data.provider !== "string" || !data.provider ||
        typeof data.model !== "string" || !data.model ||
        (data.reasoningEffort !== undefined && typeof data.reasoningEffort !== "string")) return null;
    return { type: event.type, seq: event.seq, time: event.time, data: {
      provider: data.provider, model: data.model,
      ...(data.reasoningEffort !== undefined ? { reasoningEffort: data.reasoningEffort } : {}) } };
  }
  if (event.type === "plan/mode") {
    if (!record(event.data) || typeof event.data.active !== "boolean") return null;
    return { type: event.type, seq: event.seq, time: event.time, data: { active: event.data.active } };
  }
  if (event.type === "agent-preset/selected") {
    if (!record(event.data) || typeof event.data.agentPreset !== "string" ||
        !event.data.agentPreset) return null;
    return { type: event.type, seq: event.seq, time: event.time,
      data: { agentPreset: event.data.agentPreset } };
  }
  if (event.type === "session/title") {
    const data = event.data;
    if (!record(data) || typeof data.title !== "string" || !data.title ||
        !Array.isArray(data.messageSeqs) || data.messageSeqs.some(seq =>
          !Number.isSafeInteger(seq) || seq < 0 || seq >= event.seq) ||
        !record(data.source) || !["user", "fallback", "provider"].includes(data.source.kind) ||
        (data.source.kind === "provider" && (typeof data.source.provider !== "string" ||
          (data.source.model !== undefined && (!record(data.source.model) ||
            typeof data.source.model.provider !== "string" || typeof data.source.model.model !== "string"))))) return null;
    const source = { kind: data.source.kind };
    if (data.source.kind === "provider") {
      source.provider = data.source.provider;
      if (data.source.model !== undefined) source.model = {
        provider: data.source.model.provider, model: data.source.model.model };
    }
    return { type: event.type, seq: event.seq, time: event.time,
      data: { title: data.title, messageSeqs: [...data.messageSeqs], source } };
  }
  if (event.ignorable === true && !KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
    // Only unknown plugin events are browser-skippable. A known event marked
    // ignorable must retain its semantics and receive its own schema review.
    return { type: "teamhub/redacted-event", seq: event.seq, time: event.time, data: {}, ignorable: true };
  }
  // Browser-known does not mean tenant-reviewed. Unknown non-ignorable events
  // and unreviewed known events must fail closed; replacing the latter with an
  // ignorable marker would destroy their required browser semantics.
  return null;
}
