import { publicUser, createUser, setUserStatus, resetPassword, setDisplayName } from "./users.mjs";
import { revokeSessionsForUser } from "./auth.mjs";

export function createAdminApi({ home, getConfig, save, ownership, audit }) {
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
    createUser(input) {
      const config = getConfig();
      const result = createUser(config, { name: input.name, role: input.role || "member" });
      save(config);
      audit.write("admin.user-created", { user: input.name, role: result.user.role });
      return { user: publicUser(result.user), initialPassword: result.initialPassword };
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
    audit(query) { return audit.query(query); }
  };
}
