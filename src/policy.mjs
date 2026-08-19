import path from "node:path";

export const MEMBER_DENY = new Set([
  "agentPreset.read", "agentPreset.copy", "agentPreset.openDocument", "agentPreset.remove",
  "host.pickDirectory", "host.openPath", "host.listDirectory", "host.createDirectory",
  "settings.describe", "settings.openDocument", "settings.update", "settings.replace", "settings.mutate",
  "credentials.describe", "credentials.set", "credentials.unset",
  "llm.discoverModels", "workspace.create", "workspace.delete"
]);

export const MEMBER_PLAIN_ALLOW = new Set([
  "host.describe", "llm.providers", "llm.models",
  "dynamicCordisRunner/syncInspectManifest", "dynamicCordisRunner/inventory", "pluginInventory/list",
  "agentPreset.list", "commands/list"
]);

export const MEMBER_GUARDED = new Set([
  "workspace.list", "workspace.rename", "workspace.archiveSession",
  "workspace.insertBefore", "workspace.insertSessionBefore",
  "session.list", "session.search", "session.history", "session.create",
  "session.prompt", "session.cancel", "session.rename", "session.fork",
  "session.attachment", "session.models", "session.selectModel", "session.updateQueue",
  "skill.list", "subagent.list", "subagent.history", "subagent.prompt", "subagent.interrupt",
  "agentPreset.select",
  // 消息反馈（👍/👎）与斜杠命令执行：均按会话归属守卫
  "messageFeedback/list", "messageFeedback/put", "messageFeedback/delete",
  "commands/execute",
  "goal.create", "goal.edit", "goal.pause", "goal.resume", "goal.complete", "goal.clear"
]);

export function createOwnership() {
  return { workspaceOwner: new Map(), sessionOwner: new Map() };
}

export function userRoot(config, user) {
  return path.join(config.workspaceRoot, user.name);
}

export function ownerOfPath(config, candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  const normalized = path.resolve(candidate);
  for (const user of config.users) {
    if (user.role !== "member") continue;
    const root = path.resolve(userRoot(config, user));
    if (normalized === root || normalized.startsWith(root + path.sep)) return user.name;
  }
  return null;
}

export function learnWorkspace(config, ownership, view) {
  if (!view || typeof view.workspaceId !== "string") return;
  const owner = ownerOfPath(config, view.path) || "admin";
  ownership.workspaceOwner.set(view.workspaceId, owner);
  for (const sessionId of view.sessionIds || []) {
    // 工作区路径能解析到成员时是权威归属：覆盖 host/session-added 在缺 cwd 时的 admin 猜测。
    if (owner !== "admin" || !ownership.sessionOwner.has(sessionId)) ownership.sessionOwner.set(sessionId, owner);
  }
}

export function learnSession(config, ownership, sessionId, cwd, fallbackOwner = null) {
  if (typeof sessionId !== "string") return;
  const owner = (cwd && ownerOfPath(config, cwd)) || fallbackOwner;
  if (owner && !ownership.sessionOwner.has(sessionId)) ownership.sessionOwner.set(sessionId, owner);
}

export function ownedBy(ownership, user, kind, id) {
  const map = kind === "session" ? ownership.sessionOwner : ownership.workspaceOwner;
  const owner = map.get(id);
  if (owner === user.name) return true;
  if (owner === undefined) return "unknown";
  return false;
}

export function guardMemberRequest({ config, ownership, user, method, payload }) {
  if (method === "settings.mutate") {
    const p = payload && typeof payload === "object" ? payload : {};
    if (p.ns === "ui-onboarding" && Array.isArray(p.ops)) return { ok: true, payload: p };
    return { ok: false, message: "Member 的设置面只读（仅可确认引导提示）" };
  }
  if (MEMBER_DENY.has(method)) return { ok: false, message: `方法 ${method} 对 Member 禁用` };
  if (MEMBER_PLAIN_ALLOW.has(method)) return { ok: true, payload };
  if (!MEMBER_GUARDED.has(method)) return { ok: false, message: `方法 ${method} 不在 Member 白名单` };
  const p = payload && typeof payload === "object" ? payload : {};

  if (method === "session.create") {
    const out = { ...p };
    if (out.workspaceId !== undefined) {
      if (ownedBy(ownership, user, "workspace", out.workspaceId) !== true) return { ok: false, message: "不能在他人工作区创建会话" };
    } else if (out.cwd !== undefined) {
      if (ownerOfPath(config, out.cwd) !== user.name) return { ok: false, message: "不能在他人目录创建会话" };
    } else {
      const own = [...ownership.workspaceOwner.entries()].find(([, owner]) => owner === user.name);
      if (!own) return { ok: false, message: "你的工作区尚未就绪，请联系管理员" };
      out.workspaceId = own[0];
    }
    return { ok: true, payload: out };
  }

  // agentId 在 Typert remote 中是 SessionId 的线上字段名（如 commands/execute）
  for (const key of ["sessionId", "parentSessionId", "childSessionId", "beforeSessionId", "agentId"]) {
    if (typeof p[key] === "string") {
      const owned = ownedBy(ownership, user, "session", p[key]);
      if (owned === false) return { ok: false, message: "无权访问该会话" };
      if (owned === "unknown") return { ok: false, message: "会话归属未知，已拒绝（请刷新后重试）" };
    }
  }
  for (const key of ["workspaceId", "beforeWorkspaceId"]) {
    if (typeof p[key] === "string" && ownedBy(ownership, user, "workspace", p[key]) !== true) {
      return { ok: false, message: "无权访问该工作区" };
    }
  }
  if (typeof p.cwd === "string" && ownerOfPath(config, p.cwd) !== user.name) return { ok: false, message: "无权访问该目录" };
  return { ok: true, payload: p };
}

export function filterMemberResponse({ ownership, user, method, value }) {
  if (value === null || typeof value !== "object") return value;
  if (method === "workspace.list") {
    return {
      ...value,
      items: (value.items || []).filter(w => ownership.workspaceOwner.get(w.workspaceId) === user.name),
      archivedSessionIds: (value.archivedSessionIds || []).filter(id => ownership.sessionOwner.get(id) === user.name)
    };
  }
  if (method === "session.list" || method === "session.search") {
    return { ...value, items: (value.items || []).filter(s => ownership.sessionOwner.get(s.sessionId) === user.name) };
  }
  if ((method === "session.create" || method === "session.fork") && typeof value.sessionId === "string") {
    ownership.sessionOwner.set(value.sessionId, user.name);
  }
  return value;
}
