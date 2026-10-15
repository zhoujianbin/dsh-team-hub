import crypto from "node:crypto";
import { DshBrowserAuth } from "./dsh-browser-auth.mjs";

const browserAuth = new WeakMap();

function authentication(config) {
  let auth = browserAuth.get(config);
  if (!auth) { auth = new DshBrowserAuth(config); browserAuth.set(config, auth); }
  return auth;
}

export async function upstreamRpc(config, method, payload) {
  const url = new URL(config.upstream);
  const auth = authentication(config);
  const cookie = await auth.cookieHeader();
  let response;
  try {
    response = await fetch(`${config.upstream}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: url.host, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
      redirect: "error", signal: AbortSignal.timeout(12000)
    });
  } catch { throw new Error(`${method}: upstream connection failed`); }
  if (response.status === 401) auth.invalidate();
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch {
    // Host HTML/diagnostics can contain private launch URLs or credentials.
    throw new Error(`${method}: upstream returned non-JSON (${response.status})`);
  }
  if (!response.ok || !body.result?.ok) throw new Error(`${method}: upstream request failed (${response.status})`);
  return body.result.value;
}
