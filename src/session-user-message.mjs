/** Reviewed member-visible user message projection shared by journal and inbox. */
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function projectUserMessage(data, ownsSession) {
  if (!record(data) || data.role !== "user" || typeof data.id !== "string" ||
      !record(data.source) || !Array.isArray(data.content)) return null;
  const content = data.content.map(block => record(block) && block.type === "text" &&
    typeof block.text === "string" ? { type: "text", text: block.text } : null);
  if (content.some(block => !block)) return null;
  const source = data.source;
  let projectedSource;
  if (source.kind === "user" &&
    (source.rpcId === undefined || typeof source.rpcId === "string") &&
    (source.clientTimeZone === undefined || typeof source.clientTimeZone === "string"))
    projectedSource = { kind: "user",
      ...(source.rpcId !== undefined ? { rpcId: source.rpcId } : {}),
      ...(source.clientTimeZone !== undefined ? { clientTimeZone: source.clientTimeZone } : {}) };
  else if (source.kind === "runtime-context" && source.form === "snapshot" &&
    Array.isArray(source.sections) && source.sections.every(section => record(section) &&
      typeof section.name === "string" && typeof section.text === "string"))
    projectedSource = { kind: "runtime-context", form: "snapshot", sections: [] };
  else if (source.kind === "agent-message" && source.form === "relay" &&
      typeof source.senderSessionId === "string" && ownsSession(source.senderSessionId))
    projectedSource = { kind: "agent-message", form: "relay", senderSessionId: source.senderSessionId };
  else if (source.kind === "subagent-settled" && source.form === "notice" &&
      typeof source.senderSessionId === "string" && ownsSession(source.senderSessionId))
    projectedSource = { kind: "subagent-settled", form: "notice",
      summary: "Subagent settled", senderSessionId: source.senderSessionId };
  else if (source.kind === "schedule" && source.form === undefined)
    projectedSource = { kind: "schedule" };
  else if (source.kind === "schedule" && source.form === "notice" &&
    typeof source.summary === "string")
    projectedSource = { kind: "schedule", form: "notice", summary: "Scheduled reminder" };
  else if (source.kind === "goal" && typeof source.goalId === "string" &&
    Number.isSafeInteger(source.revision) && source.revision > 0 &&
    Number.isSafeInteger(source.round) && source.round > 0)
    projectedSource = { kind: "goal", goalId: source.goalId,
      revision: source.revision, round: source.round };
  else if (source.kind === "user-question-reply" &&
    typeof source.callId === "string" && source.outcome === "answered")
    projectedSource = { kind: "user-question-reply", callId: source.callId, outcome: "answered" };
  else if (source.kind === "team-message" &&
    typeof source.teamId === "string" && ownsSession(source.teamId) &&
    typeof source.senderId === "string" && ownsSession(source.senderId) &&
    typeof source.messageId === "string" && typeof source.senderName === "string")
    projectedSource = { kind: "team-message", teamId: source.teamId,
      messageId: source.messageId, senderId: source.senderId, senderName: source.senderName };
  else if (source.kind === "skill-catalog" && source.form === "catalog" &&
      Array.isArray(source.entries) && source.entries.every(entry => record(entry) &&
        typeof entry.name === "string" && typeof entry.description === "string"))
    projectedSource = { kind: "skill-catalog", form: "catalog", entries: [] };
  else if (source.kind === "user-approval" && Object.keys(source).length === 1)
    projectedSource = { kind: "user-approval" };
  else if (source.kind === "session-reference" && source.form === "recall" &&
      source.version === 1 && Array.isArray(source.references) &&
      source.references.every(ref => record(ref) && typeof ref.sessionId === "string" &&
        ownsSession(ref.sessionId) && typeof ref.label === "string" &&
        (ref.capturedFormatVersion === undefined || Number.isSafeInteger(ref.capturedFormatVersion) && ref.capturedFormatVersion >= 0) &&
        (ref.capturedThroughSeq === null || Number.isSafeInteger(ref.capturedThroughSeq) && ref.capturedThroughSeq >= 0) &&
        typeof ref.compacted === "boolean" && typeof ref.truncated === "boolean" &&
        ["originalMessages", "retainedMessages", "omittedMessages", "omittedBytes", "inputIndex"].every(key =>
          Number.isSafeInteger(ref[key]) && ref[key] >= 0)))
    projectedSource = { kind: "session-reference", form: "recall", version: 1,
      references: source.references.map(ref => ({ sessionId: ref.sessionId, label: ref.label,
        ...(ref.capturedFormatVersion !== undefined ? { capturedFormatVersion: ref.capturedFormatVersion } : {}),
        capturedThroughSeq: ref.capturedThroughSeq, compacted: ref.compacted,
        originalMessages: ref.originalMessages, retainedMessages: ref.retainedMessages,
        omittedMessages: ref.omittedMessages, omittedBytes: ref.omittedBytes,
        truncated: ref.truncated, inputIndex: ref.inputIndex })) };
  else return null; // Other plugin user sources need dedicated schema review.
  // Context snapshots may embed operator-wide environment and plugin data.
  // Keep their journal sequence and provenance, but never forward assembled text.
  return { id: data.id, role: "user",
    content: projectedSource.kind === "runtime-context" ? [{ type: "text", text: "[Runtime context withheld by Team Hub]" }] :
      projectedSource.kind === "skill-catalog" ? [{ type: "text", text: "[Skill catalog withheld by Team Hub]" }] : content,
    source: projectedSource };
}
