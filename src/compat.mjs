import { WebSocket } from "ws";
import { DshBrowserAuth } from "./dsh-browser-auth.mjs";
import { upstreamRpc } from "./upstream.mjs";

export async function workspaceBaseline(config) {
  const upstream = new URL(config.upstream);
  upstream.protocol = "ws:";
  upstream.pathname = "/api/remote.mux";
  const cookie = await new DshBrowserAuth(config).cookieHeader();
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(upstream, { headers: { cookie, origin: new URL(config.upstream).origin }, handshakeTimeout: 5000 });
    let done = false;
    const deadline = setTimeout(() => finish(new Error("workspace/follow timed out")), 5000);
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(deadline); socket.terminate(); if (error) reject(error); else resolve(value); };
    socket.on("open", () => socket.send(JSON.stringify({ type: "open", streamId: "workspace-check", endpoint: "workspace/follow", payload: { args: {} } })));
    socket.on("message", data => {
      let frame;
      try { frame = JSON.parse(data.toString("utf8")); } catch { return finish(new Error("invalid workspace stream frame")); }
      if (frame.streamId !== "workspace-check") return;
      if (frame.type === "error") return finish(new Error("workspace/follow failed"));
      if (frame.type === "item" && frame.value?.type === "baseline" && Array.isArray(frame.value?.value?.items)) finish(null, frame.value.value);
    });
    socket.on("error", () => finish(new Error("workspace/follow connection failed")));
    socket.on("close", () => finish(new Error("workspace/follow closed early")));
  });
}

export async function compatibilityReport(config) {
  const startedAt = Date.now();
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok, detail });
  try {
    const sessions = await upstreamRpc(config, "session/list", { args: { _request: {} } });
    add("session/list", Array.isArray(sessions?.items), `${sessions?.items?.length ?? 0} sessions`);
  } catch (error) { add("session/list", false, error.message); }
  try {
    const workspaces = await workspaceBaseline(config);
    add("workspace/follow", true, `${workspaces.items.length} workspaces`);
  } catch (error) { add("workspace/follow", false, error.message); }
  return { ok: checks.every(check => check.ok), durationMs: Date.now() - startedAt, checks };
}
