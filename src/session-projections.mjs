// DSH 0.2 per-session projection names reviewed for member visibility.
// Unknown plugin projections are host-managed data and must stay private.
import { projectUserMessage } from "./session-user-message.mjs";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

export const MEMBER_PROJECTION_KEYS = new Set([
  "subagentCatalog", "title", "sessionListMetadata", "modelSelection",
  "sessionStats", "agentPreset", "todos", "goal", "agentTeam",
  "subagentModelSelectionPolicy", "turnOutline", "userQuestions", "inbox"
]);

const textOrNull = value => value === null || typeof value === "string";
const selection = value => value === null ? null : record(value) &&
  typeof value.provider === "string" && typeof value.model === "string" &&
  (value.reasoningEffort === undefined || typeof value.reasoningEffort === "string")
    ? { provider: value.provider, model: value.model,
        ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}) }
    : undefined;

function projectQuestion(question) {
  if (!record(question) || typeof question.id !== "string" ||
      typeof question.question !== "string" ||
      (question.detail !== undefined && typeof question.detail !== "string") ||
      (question.header !== undefined && typeof question.header !== "string") ||
      (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean"))
    return undefined;
  let options;
  if (question.options !== undefined) {
    if (!Array.isArray(question.options) || !question.options.every(option =>
        record(option) && typeof option.label === "string" &&
        (option.description === undefined || typeof option.description === "string")))
      return undefined;
    options = question.options.map(option => ({ label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}) }));
  }
  let intent;
  if (question.intent !== undefined) {
    if (!record(question.intent) || question.intent.kind !== "plan-review" ||
        typeof question.intent.approve !== "string" ||
        (question.intent.callId !== undefined && (typeof question.intent.callId !== "string" ||
          !question.intent.callId || question.intent.callId.length > 128)))
      return undefined;
    intent = { kind: "plan-review", approve: question.intent.approve,
      ...(question.intent.callId !== undefined ? { callId: question.intent.callId } : {}) };
  }
  return { id: question.id, question: question.question,
    ...(question.detail !== undefined ? { detail: question.detail } : {}),
    ...(question.header !== undefined ? { header: question.header } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
    ...(intent !== undefined ? { intent } : {}) };
}
export function projectGoalSnapshot(goal) {
  if (!record(goal) || typeof goal.id !== "string" || !goal.id ||
      !Number.isSafeInteger(goal.revision) || goal.revision < 1 ||
      typeof goal.objective !== "string" ||
      !["active", "paused", "blocked", "complete"].includes(goal.phase) ||
      !Number.isSafeInteger(goal.maxGoalRounds) || goal.maxGoalRounds < 1 ||
      (goal.phase === "blocked" && (!record(goal.blockedReason) ||
        typeof goal.blockedReason.code !== "string" ||
        typeof goal.blockedReason.message !== "string"))) return undefined;
  return { id: goal.id, revision: goal.revision, objective: goal.objective,
    phase: goal.phase, maxGoalRounds: goal.maxGoalRounds,
    ...(goal.phase === "blocked" ? { blockedReason: {
      code: goal.blockedReason.code, message: goal.blockedReason.message } } : {}) };
}
/** Return reviewed member-visible fields; undefined means unsupported or malformed. */
export function projectMemberProjection({ key, value, ownsSession }) {
  if (!MEMBER_PROJECTION_KEYS.has(key)) return undefined;
  if (key === "subagentCatalog") {
    if (!Array.isArray(value)) return undefined;
    const own = value.filter(entry => record(entry) && typeof entry.id === "string" && ownsSession(entry.id));
    if (own.some(entry => !["one-shot", "continuable", "unknown"].includes(entry.mode) ||
        !Number.isFinite(entry.createdAt) || entry.createdAt < 0 ||
        (entry.label !== undefined && typeof entry.label !== "string"))) return undefined;
    return own.map(entry => ({ id: entry.id, mode: entry.mode, createdAt: entry.createdAt,
      ...(entry.label !== undefined ? { label: entry.label } : {}) }));
  }
  if (key === "inbox") {
    if (!record(value) || !Array.isArray(value["next-turn"]) ||
        !Array.isArray(value["next-step"])) return undefined;
    const nextTurn = value["next-turn"].map(message => projectUserMessage(message, ownsSession));
    const nextStep = value["next-step"].map(message => projectUserMessage(message, ownsSession));
    return nextTurn.some(message => !message) || nextStep.some(message => !message)
      ? undefined : { "next-turn": nextTurn, "next-step": nextStep };
  }
  if (key === "userQuestions") {
    if (!record(value) || !Array.isArray(value.active) || !Array.isArray(value.settled))
      return undefined;
    const active = value.active.map(call => {
      if (!record(call) || typeof call.callId !== "string" ||
          !["open", "continued"].includes(call.state) ||
          !Array.isArray(call.questions)) return null;
      const questions = call.questions.map(projectQuestion);
      return questions.some(question => !question) ? null :
        { callId: call.callId, state: call.state, questions };
    });
    const settled = value.settled.map(call => {
      if (!record(call) || typeof call.callId !== "string" ||
          !Array.isArray(call.answers)) return null;
      const answers = call.answers.map(answer => {
        if (!record(answer) || typeof answer.id !== "string" ||
            !Array.isArray(answer.selected) ||
            !answer.selected.every(label => typeof label === "string") ||
            (answer.custom !== undefined && typeof answer.custom !== "string"))
          return null;
        return { id: answer.id, selected: [...answer.selected],
          ...(answer.custom !== undefined ? { custom: answer.custom } : {}) };
      });
      return answers.some(answer => !answer) ? null : { callId: call.callId, answers };
    });
    return active.some(call => !call) || settled.some(call => !call)
      ? undefined : { active, settled };
  }
  if (key === "turnOutline") {
    if (!Array.isArray(value) || !value.every(entry => record(entry) &&
        Number.isSafeInteger(entry.turn) && entry.turn >= 0 &&
        Number.isSafeInteger(entry.seq) && entry.seq >= 0 &&
        typeof entry.prompt === "string" && typeof entry.response === "string"))
      return undefined;
    return value.map(entry => ({ turn: entry.turn, seq: entry.seq,
      prompt: entry.prompt, response: entry.response }));
  }
  if (key === "subagentModelSelectionPolicy") {
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every(route => record(route) &&
        typeof route.provider === "string" && typeof route.model === "string"))
      return undefined;
    return value.map(route => ({ provider: route.provider, model: route.model }));
  }
  if (key === "agentTeam") {
    if (!record(value) || !Array.isArray(value.members) || !Array.isArray(value.tasks))
      return undefined;
    // A foreign teammate in a Lead roster invalidates the whole snapshot:
    // filtering it alone leaves task owner names and dependency state misleading.
    const members = value.members.map(member => {
      if (!record(member) || typeof member.id !== "string" || !ownsSession(member.id) ||
          typeof member.name !== "string" || !["lead", "teammate"].includes(member.role) ||
          !["provisioning", "active", "failed"].includes(member.phase)) return null;
      return { id: member.id, name: member.name, role: member.role, phase: member.phase,
        ...(member.phase === "failed" ? { error: "Team member failed" } : {}) };
    });
    const tasks = value.tasks.map(task => {
      if (!record(task) || typeof task.id !== "string" ||
          !Number.isSafeInteger(task.revision) || task.revision < 1 ||
          typeof task.subject !== "string" || typeof task.description !== "string" ||
          !["pending", "in_progress", "completed", "deleted"].includes(task.status) ||
          !Array.isArray(task.blockedBy) ||
          !task.blockedBy.every(id => typeof id === "string") ||
          !Array.isArray(task.writeScopes) ||
          !task.writeScopes.every(scope => typeof scope === "string") ||
          typeof task.ready !== "boolean" ||
          !Array.isArray(task.writeScopeWarnings) ||
          !task.writeScopeWarnings.every(warning => typeof warning === "string")) return null;
      return { id: task.id, revision: task.revision, subject: task.subject,
        description: task.description, status: task.status, blockedBy: [...task.blockedBy],
        // Raw scope strings may contain absolute paths into another member's
        // workspace. Preserve the shape without forwarding shared Host paths.
        writeScopes: [], ready: task.ready,
        writeScopeWarnings: [] };
    });
    if (members.some(member => !member) || tasks.some(task => !task)) return undefined;
    return { members, tasks,
      ...(value.failure !== undefined ? { failure: "Team state failed" } : {}) };
  }
  if (key === "goal") {
    if (value === null) return null;
    if (!record(value) || !Number.isSafeInteger(value.roundsStarted) ||
        value.roundsStarted < 0 || !Number.isFinite(value.createdAt) ||
        !Number.isFinite(value.updatedAt)) return undefined;
    const goal = projectGoalSnapshot(value.goal);
    return goal ? { goal, roundsStarted: value.roundsStarted,
      createdAt: value.createdAt, updatedAt: value.updatedAt } : undefined;
  }
  if (key === "todos") {
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every(todo => record(todo) &&
        typeof todo.content === "string" &&
        ["pending", "in_progress", "completed"].includes(todo.status))) return undefined;
    return value.map(todo => ({ content: todo.content, status: todo.status }));
  }
  if (key === "title" || key === "agentPreset") return textOrNull(value) ? value : undefined;
  if (key === "sessionListMetadata") return record(value) && typeof value.blank === "boolean" &&
    (value.lastPromptAt === null || Number.isFinite(value.lastPromptAt))
      ? { blank: value.blank, lastPromptAt: value.lastPromptAt } : undefined;
  if (key === "sessionStats") {
    if (!record(value)) return undefined;
    const fields = ["turns", "steps", "llmMs", "toolMs", "ttftMs", "ttftSteps", "decodeMs", "decodeTokens"];
    return fields.every(field => Number.isFinite(value[field]) && value[field] >= 0)
      ? Object.fromEntries(fields.map(field => [field, value[field]])) : undefined;
  }
  if (key === "modelSelection") {
    if (!record(value)) return undefined;
    const lastUsed = selection(value.lastUsed), next = selection(value.next);
    return lastUsed === undefined || next === undefined ? undefined : { lastUsed, next };
  }
  // Other projection schemas contain nested data not yet audited for Host IDs
  // or credential fields. Deny rather than forwarding arbitrary plugin values.
  return undefined;
}
