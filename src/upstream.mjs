import crypto from "node:crypto";

export async function upstreamRpc(config, method, payload) {
  const url = new URL(config.upstream);
  const response = await fetch(`${config.upstream}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: url.host },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch {
    const detail = text.trim() || response.statusText || response.status;
    throw new Error(`${method}: upstream returned non-JSON (${response.status}): ${detail}`);
  }
  if (!response.ok || !body.result?.ok) throw new Error(`${method}: ${body.result?.error?.message || response.status}`);
  return body.result.value;
}
