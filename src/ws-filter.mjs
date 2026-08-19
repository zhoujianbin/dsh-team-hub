import { ownerOfPath, learnWorkspace } from "./policy.mjs";

export function filterMuxFrame({ ownership, user, frame, answerable, onUnknown = () => {} }) {
  const payload = frame?.payload;
  if (!payload || typeof payload.type !== "string") return false;
  switch (payload.type) {
    case "session/event":
    case "session/subscribed":
    case "session/queue":
    case "session/jobs":
    case "session/projection":
    case "approval/resolved":
    case "question/resolved":
      return ownership.sessionOwner.get(payload.sessionId) === user.name;
    case "approval/requested":
    case "question/requested": {
      const owned = ownership.sessionOwner.get(payload.sessionId) === user.name;
      if (owned && typeof frame.rpcId === "string") answerable.add(frame.rpcId);
      return owned;
    }
    case "stream/error":
      return true;
    default:
      onUnknown(payload.type);
      return false;
  }
}

export function filterHostFrame({ config, ownership, user, frame, onUnknown = () => {} }) {
  const payload = frame?.payload;
  if (!payload || typeof payload.type !== "string") return false;
  switch (payload.type) {
    case "host/session-added": {
      const owner = (payload.cwd ? ownerOfPath(config, payload.cwd) : null) || ownership.sessionOwner.get(payload.sessionId) || "admin";
      if (!ownership.sessionOwner.has(payload.sessionId)) ownership.sessionOwner.set(payload.sessionId, owner);
      return owner === user.name;
    }
    case "host/session-removed":
    case "host/session-status":
    case "host/agent-error":
      return ownership.sessionOwner.get(payload.sessionId) === user.name;
    case "host/workspace-changed": {
      learnWorkspace(config, ownership, payload.workspace);
      return ownership.workspaceOwner.get(payload.workspace?.workspaceId) === user.name;
    }
    case "host/workspace-removed":
      return ownership.workspaceOwner.get(payload.workspaceId) === user.name;
    case "host/workspace-order-changed":
      payload.workspaceIds = (payload.workspaceIds || []).filter(id => ownership.workspaceOwner.get(id) === user.name);
      return true;
    case "host/archived-sessions-changed":
      payload.archivedSessionIds = (payload.archivedSessionIds || []).filter(id => ownership.sessionOwner.get(id) === user.name);
      return true;
    case "host/remote-event":
    case "stream/error":
      return true;
    default:
      onUnknown(payload.type);
      return false;
  }
}

export function isAllowedClientFrame({ ownership, user, frame, answerable }) {
  const payload = frame?.payload;
  if (!payload || typeof payload !== "object") return false;
  if (frame.type === "client-request" && typeof frame.rpcId === "string" && typeof frame.method === "string") {
    if (frame.method === "respond") return answerable.has(frame.rpcId);
    if (frame.method === "session/subscribe" || frame.method === "session/unsubscribe") {
      return ownership.sessionOwner.get(payload.sessionId) === user.name;
    }
    return false;
  }
  return false;
}
