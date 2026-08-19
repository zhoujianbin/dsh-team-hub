import { upstreamRpc } from "./upstream.mjs";

export async function compatibilityReport(config) {
  const startedAt = Date.now();
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  try {
    const host = await upstreamRpc(config, "host.describe", {});
    add("host.describe", Boolean(host), host?.version ? `version ${host.version}` : "ok");
  } catch (error) { add("host.describe", false, error.message); }
  try {
    const workspaces = await upstreamRpc(config, "workspace.list", {});
    add("workspace.list", Array.isArray(workspaces?.items), `${workspaces?.items?.length ?? 0} workspaces`);
  } catch (error) { add("workspace.list", false, error.message); }
  try {
    const sessions = await upstreamRpc(config, "session.list", {});
    add("session.list", Array.isArray(sessions?.items), `${sessions?.items?.length ?? 0} sessions`);
  } catch (error) { add("session.list", false, error.message); }
  const ok = checks.every(check => check.ok);
  return { ok, durationMs: Date.now() - startedAt, checks };
}
