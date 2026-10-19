import { publicUser, createUser, setUserStatus, resetPassword, setDisplayName } from "./users.mjs";
import { revokeSessionsForUser } from "./auth.mjs";
import { ownerOfPath } from "./policy.mjs";

export function createAdminApi({ home, getConfig, save, ownership, audit, ensureUserWorkspace }) {
  return {
    overview() {
      const config = getConfig();
      return {
        upstream: config.upstream,
        users: config.users.map(publicUser),
        workspaces: [...ownership.workspaceOwner.entries()].map(([workspaceId, owner]) => ({ workspaceId, owner })),
        sessions: ownership.sessionOwner.size,
        recentAudit: audit.query({ limit: 20 })
      };
    },
    users() { return getConfig().users.map(publicUser); },
    async createUser(input) {
      const config = getConfig();
      const result = createUser(config, { name: input.name, role: input.role || "member" });
      save(config);
      let workspace = null;
      if (result.user.role === "member") {
        try {
          if (!ensureUserWorkspace) throw new Error("workspace provisioner unavailable");
          workspace = await ensureUserWorkspace(result.user);
          if (!workspace || typeof workspace.workspaceId !== "string" || !workspace.workspaceId)
            throw new Error("workspace creation returned no ID");
        } catch {
          // Never report success for an unusable account or expose its one-time
          // password. Keep it disabled for an administrator to inspect/retry.
          result.user.status = "disabled";
          result.user.updatedAt = new Date().toISOString();
          save(config);
          audit.write("admin.user-workspace-failed", { user: result.user.name });
          throw new Error("账号已创建但工作区未就绪；账号已禁用，请检查 DSH 后重试");
        }
      }
      audit.write("admin.user-created", { user: input.name, role: result.user.role, workspaceCreated: Boolean(workspace) });
      return { user: publicUser(result.user), initialPassword: result.initialPassword, workspace };
    },
    setUserStatus(name, status) {
      const config = getConfig();
      const user = setUserStatus(config, name, status);
      if (status === "disabled") revokeSessionsForUser(home, name);
      save(config);
      audit.write("admin.user-status", { user: name, status });
      return publicUser(user);
    },
    setDisplayName(name, displayName) {
      const config = getConfig();
      const user = setDisplayName(config, name, displayName);
      save(config);
      audit.write("admin.display-name", { user: name, displayName });
      return publicUser(user);
    },
    resetPassword(name) {
      const config = getConfig();
      const result = resetPassword(config, name);
      revokeSessionsForUser(home, name);
      save(config);
      audit.write("admin.password-reset", { user: name });
      return { user: publicUser(result.user), initialPassword: result.initialPassword };
    },
    workspaces() {
      const config = getConfig();
      return [...ownership.workspaceOwner.entries()].map(([workspaceId, owner]) => ({
        workspaceId, owner, title: ownership.workspaceTitle?.get(workspaceId) || workspaceId,
        path: ownership.workspacePath?.get(workspaceId) || "",
        members: Object.hasOwn(config.workspaceShares || {}, workspaceId) ? config.workspaceShares[workspaceId] : []
      }));
    },
    setWorkspaceShares(workspaceId, members, actor) {
      const config = getConfig();
      if (!Array.isArray(members) || members.length > config.users.length ||
          members.some(name => typeof name !== "string" ||
            !config.users.some(user => user.name === name && user.role === "member" &&
              (user.status || "active") === "active")) || new Set(members).size !== members.length)
        throw new Error("共享成员必须是不重复的已启用普通成员");
      const owner = ownership.workspaceOwner.get(workspaceId);
      if (!workspaceId || workspaceId.length > 256 || ["__proto__", "constructor", "prototype"].includes(workspaceId) ||
          !owner || owner === "ambiguous" || !ownership.workspacePath.get(workspaceId) ||
          ownership.workspacePath.get(workspaceId) === "ambiguous" ||
          (ownerOfPath(config, ownership.workspacePath.get(workspaceId)) || "admin") !== owner)
        throw new Error("工作区不存在或归属不明确");
      if (members.includes(owner)) throw new Error("工作区所有者无需重复授权");
      const shares = { ...(config.workspaceShares || {}) };
      if (members.length) Object.defineProperty(shares, workspaceId, { value: [...members], enumerable: true, writable: true, configurable: true });
      else delete shares[workspaceId];
      save({ ...config, workspaceShares: shares });
      audit.write("admin.workspace-shares", { user: actor, workspaceId, members });
      return { workspaceId, owner, members };
    },
    ownershipDebug() {
      return {
        workspaces: Object.fromEntries(ownership.workspaceOwner),
        sessions: Object.fromEntries(ownership.sessionOwner)
      };
    },
    audit(query) { return audit.query(query); }
  };
}
