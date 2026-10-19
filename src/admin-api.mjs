import { publicUser, createUser, setUserStatus, resetPassword, setDisplayName } from "./users.mjs";
import { revokeSessionsForUser } from "./auth.mjs";

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
      return [...ownership.workspaceOwner.entries()].map(([workspaceId, owner]) => ({ workspaceId, owner }));
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
