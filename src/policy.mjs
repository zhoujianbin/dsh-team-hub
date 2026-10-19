import path from "node:path";
import fs from "node:fs";
import { MEMBER_PROJECTION_KEYS, projectMemberProjection } from "./session-projections.mjs";
import { projectMemberJournalEvent } from "./session-journal.mjs";

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
  // dsh-web-ui 插件套件的只读设置描述（插件开关/皮肤状态，宿主级共享，只读安全）
  "dsh-web-ui-settings/describe",
  "agentPreset.list", "commands/list"
]);

export const MEMBER_GUARDED = new Set([
  "workspace.list", "workspace.rename", "workspace.archiveSession",
  "workspace.insertBefore", "workspace.insertSessionBefore",
  "session.list", "session.search", "session.history", "session.create",
  "session.prompt", "session.cancel", "session.rename", "session.fork",
  "session.models", "session.selectModel", "session.updateQueue",
  "skill.list", "subagent.list", "subagent.history", "subagent.prompt", "subagent.interrupt",
  "agentPreset.select",
  // 消息反馈（👍/👎）与斜杠命令执行：均按会话归属守卫
  "messageFeedback/list", "messageFeedback/put", "messageFeedback/delete",
  "commands/execute",
  "goal.create", "goal.edit", "goal.pause", "goal.resume", "goal.complete", "goal.clear"
]);

export function createOwnership() {
  return { workspaceOwner: new Map(), sessionOwner: new Map(), sessionWorkspace: new Map(), workspacePath: new Map(), workspaceTitle: new Map() };
}

export function userRoot(config, user) {
  return path.join(config.workspaceRoot, user.name);
}

export function ownerOfPath(config, candidate) {
  if (typeof candidate !== "string" || !candidate) return null;
  // A lexical prefix is insufficient: an owned directory may contain a
  // symlink into another member's files. Only existing, canonical paths count.
  let normalized;
  try { normalized = fs.realpathSync(candidate); } catch {
    // Workspaces can be learned before their directories are created. Do not
    // trust a missing path that traverses a symlink at any existing ancestor.
    const target = path.resolve(candidate);
    let current = target;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    try { normalized = path.join(fs.realpathSync(current), path.relative(current, target)); } catch { return null; }
  }
  for (const user of config.users) {
    if (user.role !== "member") continue;
    let root;
    try { root = fs.realpathSync(userRoot(config, user)); } catch {
      const lexical = path.resolve(userRoot(config, user));
      let current = lexical;
      while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      try { root = path.join(fs.realpathSync(current), path.relative(current, lexical)); } catch { continue; }
    }
    if (normalized === root || normalized.startsWith(root + path.sep)) return user.name;
  }
  return null;
}

export function learnWorkspace(config, ownership, view) {
  if (!view || typeof view.workspaceId !== "string" || !view.workspaceId) return;
  const owner = ownerOfPath(config, view.path) || "admin";
  const priorWorkspaceOwner = ownership.workspaceOwner.get(view.workspaceId);
  // Conflicting member claims must never turn another member's ID into ours.
  ownership.workspaceOwner.set(view.workspaceId,
    priorWorkspaceOwner === "ambiguous" ||
    (priorWorkspaceOwner && priorWorkspaceOwner !== owner && priorWorkspaceOwner !== "admin" && owner !== "admin")
      ? "ambiguous" : owner);
  if (typeof view.path === "string") {
    const previousPath = ownership.workspacePath.get(view.workspaceId);
    if (previousPath && previousPath !== view.path && previousPath !== "ambiguous")
      ownership.workspacePath.set(view.workspaceId, "ambiguous");
    else if (!previousPath) ownership.workspacePath.set(view.workspaceId, view.path);
  }
  if (typeof view.title === "string") ownership.workspaceTitle.set(view.workspaceId, view.title);
  for (const sessionId of view.sessionIds || []) {
    if (typeof sessionId !== "string" || !sessionId) continue;
    const priorWorkspace = ownership.sessionWorkspace.get(sessionId);
    if (!priorWorkspace) ownership.sessionWorkspace.set(sessionId, view.workspaceId);
    else if (priorWorkspace !== view.workspaceId) ownership.sessionWorkspace.set(sessionId, "ambiguous");
    const prior = ownership.sessionOwner.get(sessionId);
    if (prior === "ambiguous") continue;
    if (!prior || prior === "admin") {
      // A previously guessed admin owner can be corrected by a member path.
      if (owner !== "admin" || !prior) ownership.sessionOwner.set(sessionId, owner);
    } else if (owner !== "admin" && prior !== owner) {
      ownership.sessionOwner.set(sessionId, "ambiguous");
    }
  }
}

export function learnSession(config, ownership, sessionId, cwd, fallbackOwner = null) {
  if (typeof sessionId !== "string" || !sessionId) return;
  const owner = (cwd && ownerOfPath(config, cwd)) || fallbackOwner;
  if (!owner || ownership.sessionOwner.get(sessionId) === "ambiguous") return;
  const prior = ownership.sessionOwner.get(sessionId);
  if (!prior || prior === "admin") ownership.sessionOwner.set(sessionId, owner);
  else if (owner !== "admin" && prior !== owner) ownership.sessionOwner.set(sessionId, "ambiguous");
}

export function canAccessWorkspace(config, ownership, user, id) {
  const owner = ownership.workspaceOwner.get(id);
  if (!owner || owner === "ambiguous") return false;
  if (owner === user.name) return true;
  const workspacePath = ownership.workspacePath.get(id);
  if (typeof workspacePath !== "string" || workspacePath === "ambiguous" ||
      (owner !== "admin" && ownerOfPath(config, workspacePath) !== owner) ||
      (owner === "admin" && ownerOfPath(config, workspacePath))) return false;
  if (user.role !== "member" || (user.status || "active") !== "active" ||
      !config.users.some(account => account.name === user.name && account.role === "member" &&
        (account.status || "active") === "active")) return false;
  const grant = config.workspaceShares?.[id];
  return Object.hasOwn(config.workspaceShares || {}, id) && Array.isArray(grant) && grant.includes(user.name);
}

export function canAccessSession(config, ownership, user, id) {
  const owner = ownership.sessionOwner.get(id);
  if (!owner || owner === "ambiguous") return false;
  if (owner === user.name) return true;
  const workspaceId = ownership.sessionWorkspace.get(id);
  return typeof workspaceId === "string" && workspaceId !== "ambiguous" &&
    ownership.workspaceOwner.get(workspaceId) === owner &&
    canAccessWorkspace(config, ownership, user, workspaceId);
}

export function canAccessPath(config, ownership, user, candidate, workspaceId) {
  if (workspaceId === undefined && ownerOfPath(config, candidate) === user.name) return true;
  if (typeof candidate !== "string") return false;
  let realPath;
  try { realPath = fs.realpathSync(candidate); } catch { return false; }
  return [...ownership.workspacePath.entries()].some(([id, workspacePath]) => {
    if ((workspaceId !== undefined && id !== workspaceId) ||
        !canAccessWorkspace(config, ownership, user, id) || workspacePath === "ambiguous") return false;
    try {
      const root = fs.realpathSync(workspacePath);
      return realPath === root || realPath.startsWith(root + path.sep);
    } catch { return false; }
  });
}

export function ownedBy(ownership, user, kind, id) {
  const map = kind === "session" ? ownership.sessionOwner : ownership.workspaceOwner;
  const owner = map.get(id);
  if (owner === user.name) return true;
  if (owner === undefined) return "unknown";
  return false;
}

// Only unary RPCs whose 0.2 wire schema is understood may be exposed. Stream
// endpoints (workspace/follow, session/follow, session/control) belong to
// /api/remote.mux and require separate per-frame filtering before exposure.
const RPC_PLAIN_ALLOW = new Set(["llm/listProviders", "session/modelCatalog", "settings/describe", "permissionPresets/catalog"]);
const RPC_SESSION_METHODS = new Set([
  "session/cancel", "session/page", "session/projections",
  "session/prompt", "session/rename", "session/selectModel",
  "skills/list", "messageFeedback/list",
  "commands/list",
  "commands/execute"
]);
const RPC_WORKSPACE_METHODS = new Set([
  "workspace/rename", "workspace/archiveSession", "workspace/unarchiveSession",
  "workspace/pinSession", "workspace/unpinSession"
]);
const RPC_LIST_METHODS = new Set(["session/list", "session/search"]);
function projectModelSelection(value) {
  if (!record(value) || typeof value.provider !== "string" || typeof value.model !== "string" ||
      value.reasoningEffort !== undefined && typeof value.reasoningEffort !== "string")
    throw new TypeError("invalid model selection");
  return { provider: value.provider, model: value.model,
    ...(value.reasoningEffort !== undefined ? { reasoningEffort: value.reasoningEffort } : {}) };
}
function projectModelEntry(value) {
  if (!record(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
      value.description !== undefined && typeof value.description !== "string")
    throw new TypeError("invalid model entry");
  const model = { id: value.id, name: value.name,
    ...(value.description !== undefined ? { description: value.description } : {}) };
  if (value.reasoning !== undefined) {
    if (!record(value.reasoning) || !Array.isArray(value.reasoning.efforts) ||
        value.reasoning.defaultEffort !== undefined && typeof value.reasoning.defaultEffort !== "string")
      throw new TypeError("invalid model reasoning");
    model.reasoning = { efforts: value.reasoning.efforts.map(entry => {
      if (!record(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" ||
          entry.description !== undefined && typeof entry.description !== "string")
        throw new TypeError("invalid reasoning effort");
      return { id: entry.id, name: entry.name,
        ...(entry.description !== undefined ? { description: entry.description } : {}) };
    }), ...(value.reasoning.defaultEffort !== undefined
      ? { defaultEffort: value.reasoning.defaultEffort } : {}) };
  }
  return model;
}
const FEEDBACK_CATEGORIES = new Set(["task-result", "instruction-following", "product-interaction",
  "service-stability", "resource-cost", "security-privacy-permission", "other"]);
function projectFeedbackItem(item) {
  if (!record(item) || typeof item.messageId !== "string" ||
      !["positive", "negative"].includes(item.rating) || typeof item.version !== "string" ||
      !Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt) ||
      item.note !== undefined && typeof item.note !== "string" ||
      item.category !== undefined && !FEEDBACK_CATEGORIES.has(item.category))
    throw new TypeError("invalid member message feedback item");
  return { messageId: item.messageId, rating: item.rating, version: item.version,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
    ...(item.note !== undefined ? { note: item.note } : {}),
    ...(item.category !== undefined ? { category: item.category } : {}) };
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function guardedIds(config, ownership, user, object, readOnly = false) {
  for (const key of ["sessionId", "parentSessionId", "childSessionId", "beforeSessionId", "agentId"]) {
    if (Object.hasOwn(object, key)) {
      if (typeof object[key] !== "string" || !object[key] ||
          !(readOnly ? canAccessSession(config, ownership, user, object[key]) :
            ownedBy(ownership, user, "session", object[key]) === true)) return false;
    }
  }
  for (const key of ["workspaceId", "beforeWorkspaceId"]) {
    if (Object.hasOwn(object, key)) {
      if (typeof object[key] !== "string" || !object[key] ||
          !(readOnly ? canAccessWorkspace(config, ownership, user, object[key]) :
            ownedBy(ownership, user, "workspace", object[key]) === true)) return false;
    }
  }
  return true;
}

function guardRpcMemberRequest({ config, ownership, user, method, payload }) {
  if (!record(payload) || Object.keys(payload).length !== 1 || !record(payload.args))
    return { ok: false, message: "Remote 请求必须只有对象 args" };
  const args = payload.args;
  if (RPC_PLAIN_ALLOW.has(method)) {
    if (Object.keys(args).length !== 0) return { ok: false, message: "只读方法不接受额外参数" };
    return { ok: true, payload };
  }
  if (RPC_LIST_METHODS.has(method)) {
    const key = method === "session/list" ? "_request" : "request";
    if (!record(args[key]) || Object.keys(args).length !== 1) return { ok: false, message: "列表参数无效" };
    if (method === "session/list" && (Object.keys(args._request).some(k => k !== "cursor") ||
      (Object.hasOwn(args._request, "cursor") && typeof args._request.cursor !== "string")))
      return { ok: false, message: "会话列表参数无效" };
    if (method === "session/search" && (typeof args.request.query !== "string" || Object.keys(args.request).some(k => k !== "query")))
      return { ok: false, message: "会话搜索参数无效" };
    return { ok: true, payload };
  }
  if (method === "session/create") {
    const request = args.request;
    if (!record(request) || Object.keys(args).length !== 1) return { ok: false, message: "创建会话参数无效" };
    if (Object.keys(request).some(key => !["workspaceId", "cwd"].includes(key))) return { ok: false, message: "创建会话不允许指定 ID、预设或未知参数" };
    if (Object.hasOwn(request, "workspaceId") && ownedBy(ownership, user, "workspace", request.workspaceId) !== true)
      return { ok: false, message: "不能在他人工作区创建会话" };
    if (Object.hasOwn(request, "cwd") &&
        (!fs.existsSync(request.cwd) || ownerOfPath(config, request.cwd) !== user.name))
      return { ok: false, message: "不能在他人目录创建会话" };
    if (!Object.hasOwn(request, "workspaceId") && !Object.hasOwn(request, "cwd")) {
      const own = [...ownership.workspaceOwner.entries()].find(([, owner]) => owner === user.name);
      if (!own) return { ok: false, message: "你的工作区尚未就绪，请联系管理员" };
      return { ok: true, payload: { args: { request: { ...request, workspaceId: own[0] } } } };
    }
    return { ok: true, payload };
  }
  if (!RPC_SESSION_METHODS.has(method) && !RPC_WORKSPACE_METHODS.has(method))
    return { ok: false, message: `方法 ${method} 不在 Member 白名单` };
  // Each guarded unary method has a known, mandatory ownership-bearing wire
  // field. Checking arbitrary optional fields alone permits unscoped calls.
  const scope = method === "session/page" ? args.request?.address :
    method === "commands/list" || method === "commands/execute" ||
    method === "agentPresets/select" || method === "fileReferences/list" ? args : args.request;
  if (!record(scope)) return { ok: false, message: "缺少会话或工作区归属参数" };
  const isWorkspaceOnly = method === "workspace/rename";
  const requiresAgent = ["commands/list", "commands/execute", "agentPresets/select", "fileReferences/list"].includes(method);
  const required = isWorkspaceOnly ? "workspaceId" : requiresAgent ? "agentId" :
    method === "session/page" && scope.kind === "subagent" ? "parentSessionId" : "sessionId";
  if (typeof scope[required] !== "string")
    return { ok: false, message: "缺少会话或工作区归属参数" };
  const readOnly = ["session/page", "session/projections", "skills/list", "messageFeedback/list", "commands/list"].includes(method);
  if (!guardedIds(config, ownership, user, args, readOnly) ||
      !guardedIds(config, ownership, user, args.request || {}, readOnly) ||
      !guardedIds(config, ownership, user, scope, readOnly))
    return { ok: false, message: "无权访问该会话或工作区" };
  if (record(args.request?.address) && !guardedIds(config, ownership, user, args.request.address, readOnly))
    return { ok: false, message: "无权访问该会话" };
  if (method === "session/rename" && (Object.keys(args).length !== 1 ||
      Object.keys(args.request).sort().join() !== "sessionId,title" ||
      typeof args.request.title !== "string"))
    return { ok: false, message: "会话重命名参数无效" };
  if (method === "workspace/rename" && (Object.keys(args).length !== 1 ||
      Object.keys(args.request).sort().join() !== "title,workspaceId" ||
      typeof args.request.title !== "string"))
    return { ok: false, message: "工作区重命名参数无效" };
  if (["workspace/archiveSession", "workspace/unarchiveSession",
      "workspace/pinSession", "workspace/unpinSession"].includes(method) &&
      (Object.keys(args).length !== 1 || Object.keys(args.request).length !== 1 ||
        !Object.hasOwn(args.request, "sessionId")))
    return { ok: false, message: "工作区会话操作参数无效" };
  if (method === "session/cancel" && (Object.keys(args).length !== 1 ||
      Object.keys(args.request).length !== 1 || !Object.hasOwn(args.request, "sessionId")))
    return { ok: false, message: "取消会话参数无效" };
  if (["session/projections", "skills/list", "messageFeedback/list"].includes(method) &&
      (Object.keys(args).length !== 1 || Object.keys(args.request).length !== 1 ||
        !Object.hasOwn(args.request, "sessionId")))
    return { ok: false, message: "会话只读请求参数无效" };
  if (method === "commands/list" &&
      (Object.keys(args).length !== 1 || !Object.hasOwn(args, "agentId")))
    return { ok: false, message: "命令列表参数无效" };
  if (method === "session/selectModel") {
    const request = args.request;
    if (Object.keys(args).length !== 1 ||
        Object.keys(request).some(key => !["sessionId", "provider", "model", "reasoningEffort"].includes(key)) ||
        typeof request.provider !== "string" || !request.provider ||
        typeof request.model !== "string" || !request.model ||
        request.reasoningEffort !== undefined && typeof request.reasoningEffort !== "string")
      return { ok: false, message: "模型选择参数无效" };
  }
  if (method === "session/prompt") {
    const request = args.request;
    // Only reviewed text turns: image/file/reference blocks and extra fields
    // could point at another member's Host-level resource.
    if (Object.keys(args).length !== 1 ||
        Object.keys(request).some(key => !["sessionId", "requestId", "mode", "content", "clientTimeZone"].includes(key)) ||
        (request.clientTimeZone !== undefined &&
          (typeof request.clientTimeZone !== "string" || request.clientTimeZone.length > 80 ||
            !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(request.clientTimeZone))) ||
        typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 128 ||
        !["queue", "interrupt"].includes(request.mode) ||
        !Array.isArray(request.content) || !request.content.length ||
        !request.content.every(block => record(block) &&
          Object.keys(block).sort().join() === "text,type" &&
          block.type === "text" && typeof block.text === "string"))
      return { ok: false, message: "成员仅支持已审核的纯文本会话请求" };
  }
  if (method === "session/page") {
    const page = args.request;
    const address = page?.address;
    if (!record(page) || !record(address) ||
        !(address.kind === "session" && Object.keys(address).sort().join() === "kind,sessionId" ||
          address.kind === "subagent" && Object.keys(address).sort().join() === "childSessionId,kind,mode,parentSessionId" &&
          ["one-shot", "continuable", "unknown"].includes(address.mode) &&
          (config ? canAccessSession(config, ownership, user, address.childSessionId) &&
            canAccessSession(config, ownership, user, address.parentSessionId) &&
            ownership.sessionWorkspace.get(address.childSessionId) === ownership.sessionWorkspace.get(address.parentSessionId) :
            ownedBy(ownership, user, "session", address.childSessionId) === true)) ||
        Object.keys(args).length !== 1 || Object.keys(page).some(key => !["address", "throughSeq", "beforeSeq", "maxMessages", "turnWindow"].includes(key)) ||
        !Number.isSafeInteger(page.throughSeq) || page.throughSeq < 0 ||
        (page.beforeSeq !== undefined && (!Number.isSafeInteger(page.beforeSeq) || page.beforeSeq < 0)) ||
        (page.maxMessages !== undefined && (!Number.isInteger(page.maxMessages) || page.maxMessages < 1 || page.maxMessages > 500)) ||
        (page.turnWindow !== undefined && (!record(page.turnWindow) ||
          Object.keys(page.turnWindow).sort().join() !== "minMessages,minTurns" ||
          !Number.isInteger(page.turnWindow.minMessages) || page.turnWindow.minMessages < 0 || page.turnWindow.minMessages > 200 ||
          !Number.isInteger(page.turnWindow.minTurns) || page.turnWindow.minTurns < 0 || page.turnWindow.minTurns > 100)))
      return { ok: false, message: "历史分页参数无效" };
    if (page.maxMessages === undefined) return { ok: true, payload: { args: { request: { ...page, maxMessages: 500 } } } };
  }
  if (method === "commands/execute") {
    if (Object.keys(args).sort().join() !== "agentId,line,submittedAttachments" ||
        typeof args.line !== "string" || !Array.isArray(args.submittedAttachments) || args.submittedAttachments.length)
      return { ok: false, message: "斜杠命令参数无效（不允许附件）" };
    // Allow known, bounded commands only: plugins can register arbitrary
    // commands, which may alter host settings or escalate permissions.
    const match = args.line.trim().match(/^\/([\w-]+)(?:\s+(.*))?$/s);
    if (!match || !["help", "compact", "goal", "permission"].includes(match[1]))
      return { ok: false, message: "成员不可执行未审核的斜杠命令" };
    if ((match[1] === "help" || match[1] === "compact") && match[2])
      return { ok: false, message: "该命令不接受参数" };
    if (match[1] === "permission" && !["", "workspace-write"].includes((match[2] || "").trim()))
      return { ok: false, message: "成员会话的权限模式已锁定为 workspace-write" };
  }
  return { ok: true, payload };
}

export function guardMemberRequest({ config, ownership, user, method, payload }) {
  if (typeof method !== "string") return { ok: false, message: "方法无效" };
  if (method.includes("/")) return guardRpcMemberRequest({ config, ownership, user, method, payload });
  if (method === "settings.mutate") return { ok: false, message: "Member 无权修改共享宿主设置" };
  if (MEMBER_DENY.has(method)) return { ok: false, message: `方法 ${method} 对 Member 禁用` };
  if (MEMBER_PLAIN_ALLOW.has(method)) return { ok: true, payload };
  if (!MEMBER_GUARDED.has(method)) return { ok: false, message: `方法 ${method} 不在 Member 白名单` };
  const p = payload && typeof payload === "object" ? payload : {};

  if (method === "commands/execute") {
    // 权限模式锁定：成员会话只能用 workspace-write。
    // /permission 无参数是查询（放行）；切到 danger-full-access/custom 一律拒绝。
    const line = (p.args && typeof p.args === "object" ? p.args.line : undefined) ?? p.line;
    if (typeof line === "string") {
      const match = line.trim().match(/^\/permission(?:\s+(.*))?$/);
      if (match) {
        const target = (match[1] || "").trim();
        if (target !== "" && target !== "workspace-write") {
          return { ok: false, message: "成员会话的权限模式已锁定为 workspace-write，不能切换到 " + target };
        }
      }
    }
  }

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

  // Typert remote 的归属字段嵌套在 args / args.request 里（如 messageFeedback/list、commands/execute）。
  const candidates = [p];
  if (p.args && typeof p.args === "object" && !Array.isArray(p.args)) {
    candidates.push(p.args);
    if (p.args.request && typeof p.args.request === "object" && !Array.isArray(p.args.request)) candidates.push(p.args.request);
  }
  // agentId 在 Typert remote 中是 SessionId 的线上字段名（如 commands/execute）
  for (const obj of candidates) {
    for (const key of ["sessionId", "parentSessionId", "childSessionId", "beforeSessionId", "agentId"]) {
      if (typeof obj[key] === "string") {
        const owned = ownedBy(ownership, user, "session", obj[key]);
        if (owned === false) return { ok: false, message: "无权访问该会话" };
        if (owned === "unknown") return { ok: false, message: "会话归属未知，已拒绝（请刷新后重试）" };
      }
    }
    for (const key of ["workspaceId", "beforeWorkspaceId"]) {
      if (typeof obj[key] === "string" && ownedBy(ownership, user, "workspace", obj[key]) !== true) {
        return { ok: false, message: "无权访问该工作区" };
      }
    }
    if (typeof obj.cwd === "string" && ownerOfPath(config, obj.cwd) !== user.name) return { ok: false, message: "无权访问该目录" };
  }
  return { ok: true, payload: p };
}

export function filterMemberResponse({ config, ownership, user, method, value }) {
  if (method === "permissionPresets/catalog") {
    if (!record(value) || !Array.isArray(value.options) || !Array.isArray(value.defaultOptions) ||
        typeof value.defaultPreset !== "string") throw new TypeError("invalid permission catalog");
    // Never advertise admin-level permission modes to members. No Host-provided
    // labels or custom preset definitions cross the tenant boundary.
    const safe = { value: "workspace-write", name: "Workspace Write" };
    return { options: [safe], defaultOptions: [safe], defaultPreset: "workspace-write" };
  }
  if (method === "llm/listProviders") {
    if (!Array.isArray(value)) throw new TypeError("invalid provider list");
    return value.map(entry => {
      if (!record(entry) || typeof entry.id !== "string" || typeof entry.name !== "string")
        throw new TypeError("invalid provider entry");
      return { id: entry.id, name: entry.name };
    });
  }
  if (method === "session/modelCatalog") {
    if (!record(value) || !Array.isArray(value.groups) ||
        !Array.isArray(value.routableProviders) || !Array.isArray(value.failures) ||
        value.routableProviders.some(id => typeof id !== "string"))
      throw new TypeError("invalid model catalog");
    const groups = value.groups.map(group => {
      if (!record(group) || typeof group.id !== "string" || typeof group.name !== "string" ||
          !Array.isArray(group.models)) throw new TypeError("invalid model group");
      return { id: group.id, name: group.name, models: group.models.map(projectModelEntry) };
    });
    // Provider error messages may contain paths or adapter diagnostics.
    const failures = value.failures.map(entry => {
      if (!record(entry) || typeof entry.id !== "string" || typeof entry.name !== "string")
        throw new TypeError("invalid model catalog failure");
      return { id: entry.id, name: entry.name, message: "模型目录暂不可用" };
    });
    return { default: projectModelSelection(value.default),
      routableProviders: value.routableProviders, groups, failures };
  }
  if (RPC_WORKSPACE_METHODS.has(method)) {
    if (!record(value)) throw new TypeError("invalid workspace mutation receipt");
    if (method === "workspace/rename") {
      const row = value.workspace;
      if (!record(row) || typeof row.workspaceId !== "string" ||
          ownedBy(ownership, user, "workspace", row.workspaceId) !== true ||
          typeof row.path !== "string" || typeof row.title !== "string" ||
          typeof row.createdAt !== "string" || typeof row.updatedAt !== "string" ||
          !Array.isArray(row.sessionIds) || row.sessionIds.some(id => typeof id !== "string"))
        throw new TypeError("invalid workspace mutation row");
      return { workspace: { workspaceId: row.workspaceId, path: row.path, title: row.title,
        createdAt: row.createdAt, updatedAt: row.updatedAt,
        sessionIds: row.sessionIds.filter(id => ownedBy(ownership, user, "session", id) === true) } };
    }
    const key = ["workspace/archiveSession", "workspace/unarchiveSession"].includes(method)
      ? "archivedSessionIds" : "pinnedSessionIds";
    if (!Array.isArray(value[key]) || value[key].some(id => typeof id !== "string"))
      throw new TypeError("invalid workspace mutation IDs");
    return { [key]: value[key].filter(id => ownedBy(ownership, user, "session", id) === true) };
  }
  if (method === "session/rename") {
    if (!record(value) || typeof value.title !== "string" ||
        !Number.isSafeInteger(value.seq) || value.seq < 0)
      throw new TypeError("invalid session rename receipt");
    return { title: value.title, seq: value.seq };
  }
  if (method === "session/selectModel") {
    const selected = value?.selected;
    if (!record(value) || !record(selected) || typeof selected.provider !== "string" ||
        typeof selected.model !== "string" ||
        selected.reasoningEffort !== undefined && typeof selected.reasoningEffort !== "string")
      throw new TypeError("invalid session model selection receipt");
    return { selected: { provider: selected.provider, model: selected.model,
      ...(selected.reasoningEffort !== undefined ? { reasoningEffort: selected.reasoningEffort } : {}) } };
  }
  if (method === "commands/list") {
    if (!Array.isArray(value)) throw new TypeError("invalid command list");
    return value.map(entry => {
      if (!record(entry) || typeof entry.name !== "string" ||
          typeof entry.description !== "string" ||
          entry.definitionId !== undefined && typeof entry.definitionId !== "string" ||
          entry.input !== undefined && (!record(entry.input) ||
            typeof entry.input.hint !== "string" ||
            entry.input.attachments !== undefined && typeof entry.input.attachments !== "boolean"))
        throw new TypeError("invalid command descriptor");
      return { name: entry.name, description: entry.description,
        ...(entry.definitionId !== undefined ? { definitionId: entry.definitionId } : {}),
        ...(entry.input !== undefined ? { input: { hint: entry.input.hint,
          ...(entry.input.attachments !== undefined ? { attachments: entry.input.attachments } : {}) } } : {}) };
    });
  }
  if (method === "commands/execute") {
    if (value === undefined) return undefined;
    if (!record(value) || typeof value.commandId !== "string" ||
        !record(value.result) || !["success", "error"].includes(value.result.kind) ||
        value.result.text !== undefined && typeof value.result.text !== "string" ||
        value.result.kind === "error" && typeof value.result.text !== "string" ||
        value.result.sourceEventSeq !== undefined && (!Number.isSafeInteger(value.result.sourceEventSeq) ||
          value.result.sourceEventSeq < 0)) throw new TypeError("invalid command execution");
    return { commandId: value.commandId, result: { kind: value.result.kind,
      ...(value.result.text !== undefined ? { text: value.result.text } : {}),
      ...(value.result.kind === "success" && value.result.sourceEventSeq !== undefined
        ? { sourceEventSeq: value.result.sourceEventSeq } : {}) } };
  }
  if (method === "messageFeedback/list") {
    if (!record(value) || typeof value.ok !== "boolean") throw new TypeError("invalid feedback result");
    if (!value.ok) {
      if (!record(value.error) || !["session-not-found", "target-not-found",
          "version-conflict", "note-blank", "note-too-large"].includes(value.error.code))
        throw new TypeError("invalid feedback failure");
      // Do not forward an unreviewed conflict current item or Host diagnostics.
      return { ok: false, error: { code: value.error.code } };
    }
    if (!record(value.value) || !Array.isArray(value.value.items))
      throw new TypeError("invalid feedback list");
    return { ok: true, value: { items: value.value.items.map(projectFeedbackItem) } };
  }
  if (method === "settings/describe") {
    if (!record(value) || !Array.isArray(value.namespaces) || typeof value.writable !== "boolean" ||
        typeof value.hasDocument !== "boolean") throw new TypeError("invalid settings descriptor");
    // All upstream namespaces belong to the shared Host. Even redacted rows
    // may carry secrets in undeclared schema/value fields; never copy a row.
    return { writable: false, hasDocument: false, namespaces: [] };
  }
  if (method === "skills/list") {
    if (!record(value) || !Array.isArray(value.skills)) throw new TypeError("invalid skill catalog");
    const skills = value.skills.map(entry => {
      if (!record(entry) || typeof entry.name !== "string" ||
          typeof entry.description !== "string" || typeof entry.modelInvocable !== "boolean" ||
          entry.whenToUse !== undefined && typeof entry.whenToUse !== "string")
        throw new TypeError("invalid skill catalog entry");
      return { name: entry.name, description: entry.description,
        ...(entry.whenToUse !== undefined ? { whenToUse: entry.whenToUse } : {}),
        modelInvocable: entry.modelInvocable };
    });
    return { skills };
  }
  if (method === "session/page") {
    if (!record(value) || !Array.isArray(value.records) || typeof value.hasMore !== "boolean")
      throw new TypeError("invalid session page");
    const records = value.records.map(row => !record(row) || row.type !== "event" ||
      typeof row.event?.data?.childSessionId === "string" &&
        !(config ? canAccessSession(config, ownership, user, row.event.data.childSessionId) :
          ownedBy(ownership, user, "session", row.event.data.childSessionId) === true)
        ? null : { type: "event", event: projectMemberJournalEvent(row.event, id =>
          config ? canAccessSession(config, ownership, user, id) : ownedBy(ownership, user, "session", id) === true) });
    if (records.some(row => !row?.event) ||
        records.some((row, index) => index > 0 && row.event.seq !== records[index - 1].event.seq + 1))
      throw new TypeError("unauthorized session page");
    return { records, hasMore: value.hasMore };
  }
  if (["session/prompt", "session/cancel", "session/updateQueue"].includes(method)) {
    if (!record(value) || value.accepted !== true) throw new TypeError(`${method} returned an invalid receipt`);
    return { accepted: true };
  }
  if ((RPC_LIST_METHODS.has(method) || method === "session/create" || method === "session/fork") && !record(value))
    throw new TypeError(`${method} returned an invalid result`);
  if (method === "session/projections") {
    if (value === null) return null;
    if (!record(value) || !Number.isSafeInteger(value.asOfSeq) || value.asOfSeq < 0 ||
        !record(value.values) ||
        Object.keys(value).some(key => !["asOfSeq", "values"].includes(key)) ||
        (Object.hasOwn(value.values, "subagentCatalog") && !Array.isArray(value.values.subagentCatalog)))
      throw new TypeError("invalid session projections");
    const values = {};
    for (const [key, original] of Object.entries(value.values)) {
      if (!MEMBER_PROJECTION_KEYS.has(key)) continue;
      const projected = projectMemberProjection({ key, value: original,
        ownsSession: id => config ? canAccessSession(config, ownership, user, id) :
          ownedBy(ownership, user, "session", id) === true });
      if (projected !== undefined) values[key] = projected;
    }
    return { asOfSeq: value.asOfSeq, values };
  }
  if (value === null || typeof value !== "object") return value;
  // 0.2 session/list is a unary RPC. Unknown sessions and
  // cross-member subagents cannot be returned even if their cwd looks local.
  if (method === "session/list" || method === "session/search") {
    if (!Array.isArray(value.items)) throw new TypeError(`${method} returned an invalid member-filterable result`);
    const items = value.items.filter(s =>
      record(s) && (config ? canAccessSession(config, ownership, user, s.sessionId) :
        ownership.sessionOwner.get(s.sessionId) === user.name) &&
      (!s.parentSessionId || (config ? canAccessSession(config, ownership, user, s.parentSessionId) :
        ownership.sessionOwner.get(s.parentSessionId) === user.name)) &&
      (!config || ownership.sessionOwner.get(s.sessionId) === user.name ||
        (!s.parentSessionId || ownership.sessionWorkspace.get(s.parentSessionId) === ownership.sessionWorkspace.get(s.sessionId)) &&
        (typeof s.cwd !== "string" || canAccessPath(config, ownership, user, s.cwd, ownership.sessionWorkspace.get(s.sessionId))))).map(s => {
      if (method === "session/search") return { sessionId: s.sessionId, ...(typeof s.snippet === "string" ? { snippet: s.snippet } : {}) };
      return { sessionId: s.sessionId,
        ...(typeof s.agentAvailable === "boolean" ? { agentAvailable: s.agentAvailable } : {}),
        ...(Number.isFinite(s.updatedAt) ? { updatedAt: s.updatedAt } : {}),
        ...(typeof s.running === "boolean" ? { running: s.running } : {}),
        ...(typeof s.blank === "boolean" ? { blank: s.blank } : {}),
        ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
        ...(s.origin === "subagent" ? { origin: "subagent" } : {}),
        ...(typeof s.cwd === "string" ? { cwd: s.cwd } : {}) };
    });
    // Project audited fields only: no aggregate totals or unknown metadata.
    return method === "session/search" ? { items, hasMore: false } : { items };
  }
  if (method === "session/create" || method === "session/fork") {
    if (typeof value.sessionId !== "string" || !value.sessionId) throw new TypeError(`${method} returned an invalid session ID`);
    const prior = ownership.sessionOwner.get(value.sessionId);
    if (prior && prior !== user.name) throw new TypeError("session ownership conflict");
    ownership.sessionOwner.set(value.sessionId, user.name);
    return { sessionId: value.sessionId };
  }
  if (method === "workspace.list") {
    return {
      ...value,
      items: (value.items || []).filter(w => config ? canAccessWorkspace(config, ownership, user, w.workspaceId) :
        ownership.workspaceOwner.get(w.workspaceId) === user.name),
      archivedSessionIds: (value.archivedSessionIds || []).filter(id => config ? canAccessSession(config, ownership, user, id) :
        ownership.sessionOwner.get(id) === user.name)
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
