import crypto from "node:crypto";

export async function upstreamRpc(config, method, payload) {
  const url = new URL(config.upstream);
  const response = await fetch(`${config.upstream}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: url.host },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload })
  });
  const body = await response.json();
  if (!body.result?.ok) throw new Error(`${method}: ${body.result?.error?.message || response.status}`);
  return body.result.value;
}
