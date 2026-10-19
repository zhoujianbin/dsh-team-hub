import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { defaultConfig } from "../src/config.mjs";
import { createUser } from "../src/users.mjs";
import { memberWelcomeSettings } from "../src/member-settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("member welcome preferences survive restart and reject unsafe files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teamhub-welcome-test-"));
  const file = path.join(home, "member-welcome.json");
  const value = "2026-09-28.1";
  const args = { ns: "ui-settings-general", ops: [{ op: "set", path: ["welcomeNoticeVersion"], value }], expectedRevision: 0 };
  try {
    assert.equal(memberWelcomeSettings(home).mutate("alice", args).revision, 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const restarted = memberWelcomeSettings(home);
    assert.equal(restarted.describe("alice").namespaces[0].value.welcomeNoticeVersion, value);
    assert.deepEqual(restarted.describe("bob").namespaces[0].value, {});
    assert.equal(restarted.mutate("alice", args), null);
    assert.equal(restarted.mutate("bob", { ...args, ops: [{ ...args.ops[0], path: ["__proto__"] }] }), null);
    assert.equal(restarted.mutate("bob", { ...args, ops: [{ ...args.ops[0], value: "2026-09-28.2" }] }), null);
    assert.equal(restarted.mutate("bob", { ...args, ns: "host-settings" }), null);
    assert.equal(restarted.mutate("__proto__", args), null);
    fs.chmodSync(file, 0o644);
    assert.throws(() => memberWelcomeSettings(home), /unsafe member settings file/);
    fs.chmodSync(file, 0o600);
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(home, "target.json"), file);
    assert.throws(() => memberWelcomeSettings(home));
    assert.throws(() => restarted.mutate("bob", args), /unsafe member settings file/);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    fs.unlinkSync(file);
    fs.writeFileSync(file, '{"__proto__":{"version":"2026-09-28.1","revision":1}}', { mode: 0o600 });
    assert.throws(() => memberWelcomeSettings(home), /invalid member settings file/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
});
const close = server => new Promise(resolve => server.close(() => resolve()));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function availablePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function socketFrames(socket) {
  const inbox = [];
  const waiters = [];
  socket.on("message", data => {
    const frame = JSON.parse(data.toString("utf8"));
    const waiter = waiters.findIndex(w => w.predicate(frame));
    if (waiter < 0) inbox.push(frame);
    else waiters.splice(waiter, 1)[0].resolve(frame);
  });
  return {
    next(predicate, timeout = 1500) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const entry = { predicate, resolve: frame => { clearTimeout(timer); resolve(frame); } };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(entry);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("expected WebSocket frame did not arrive"));
        }, timeout);
        waiters.push(entry);
      });
    },
    has(predicate) { return inbox.some(predicate); }
  };
}

async function connect(url, cookie, origin) {
  const socket = new WebSocket(url, { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

// All DSH credentials, paths, sockets and processes exist only inside this fixture.
test("gateway enforces HTTP and remote.mux member boundaries end to end", { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "teamhub-gateway-test-"));
  const sockets = new Set();
  const upstreamSockets = new Set();
  let child;
  let upstream;
  let upstreamWs;
  try {
    const config = defaultConfig(home);
    config.listenHost = "127.0.0.1";
    config.listenPort = await availablePort();
    config.dshRoot = path.join(home, "nonexistent-dsh-root"); // Never patch a real DSH installation.
    config.dshWebLog = path.join(home, "dsh-web.log");
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
    const passwords = new Map();
    for (const [name, role] of [["admin", "admin"], ["alice", "member"], ["bob", "member"]]) {
      const password = crypto.randomBytes(20).toString("hex");
      const { user } = createUser(config, { name, role, password });
      user.mustChangePassword = false;
      passwords.set(name, password);
      if (role === "member") fs.mkdirSync(path.join(config.workspaceRoot, name), { recursive: true });
    }
    const roots = Object.fromEntries(["alice", "bob"].map(name => [name, path.join(config.workspaceRoot, name)]));
    const views = ["alice", "bob"].map(name => ({ workspaceId: "workspace-" + name, path: roots[name], title: name, sessionIds: ["session-" + name], createdAt: 1, updatedAt: 1 }));
    const sessions = ["alice", "bob"].map(name => ({ sessionId: "session-" + name, cwd: roots[name] }));
    const token = crypto.randomBytes(32).toString("base64url");
    const dshCookie = "dsh-auth-test=v1." + crypto.randomBytes(12).toString("base64url") + "." + crypto.randomBytes(12).toString("base64url");
    const seen = { exchange: 0, rpc: [], opens: [], cookies: [], eventReplies: [], rejectNextEventResult: false, peers: new Set(), prompts: [] };
    upstream = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/" && url.searchParams.get("token") === token) {
        seen.exchange++;
        res.writeHead(303, { location: "./", "set-cookie": dshCookie + "; HttpOnly; Path=/" });
        res.end();
        return;
      }
      seen.cookies.push(req.headers.cookie || "");
      if (req.headers.cookie !== dshCookie || url.searchParams.has("token")) { res.writeHead(401).end(); return; }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        let body;
        try { body = JSON.parse(await new Promise((resolve, reject) => { let chunks = ""; req.on("data", c => { chunks += c; }); req.on("end", () => resolve(chunks)); req.on("error", reject); })); }
        catch { res.writeHead(400).end(); return; }
        seen.rpc.push(body.method);
        if (body.method === "$events/result") {
          seen.eventReplies.push(body.payload.args);
          if (seen.rejectNextEventResult) {
            seen.rejectNextEventResult = false;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: {
              ok: false, error: { code: "internal", message: "temporary upstream failure", details: {} } } }));
            return;
          }
        }
        if (body.method === "session/prompt") seen.prompts.push(body.payload.args.request);
        const value = body.method === "$events/result" ? undefined
          : body.method === "session/create" ? { sessionId: "session-created-alice", hostSecret: "tenant-leak" }
          : body.method === "session/prompt" ? { accepted: true, hostSecret: "tenant-leak" }
          : body.method === "session/page" ? { records: [{ type: "event", event: {
            type: "vendor/private", seq: 1, time: 2, data: { credential: "tenant-leak" }, ignorable: true } }],
            hasMore: false, hostSecret: "tenant-leak" }
          : body.method === "session/list" ? { items: sessions, total: 2, operatorHome: "/operator/private" }
          : body.method === "settings/describe" ? { writable: true, hasDocument: true, namespaces: [{ ns: "llm", schema: { apiKey: "tenant-leak" }, value: { apiKey: "tenant-leak" } }] }
          : body.method === "workspace/create" ? { workspace: { workspaceId: "created", title: "alice", path: body.payload.args.request.path, sessionIds: [] } }
          : { unknown: true };
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream-secret=hidden" });
        res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }));
        return;
      }
      if (url.pathname === "/api/skin-center/v2/active") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: url.pathname }));
        return;
      }
      if (url.pathname === "/plugins/") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end("/* isolated static client bundle */");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><head></head><body>upstream page</body></html>");
    });
    upstreamWs = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (req, socket, head) => {
      if (req.url !== "/api/remote.mux" || req.headers.cookie !== dshCookie) { socket.destroy(); return; }
      seen.cookies.push(req.headers.cookie);
      upstreamWs.handleUpgrade(req, socket, head, peer => {
        upstreamSockets.add(peer);
        seen.peers.add(peer);
        peer.on("close", () => { upstreamSockets.delete(peer); seen.peers.delete(peer); });
        peer.on("message", data => {
          let frame;
          try { frame = JSON.parse(data.toString()); } catch { return; }
          if (frame.type !== "open") return;
          seen.opens.push(frame.endpoint);
          if (frame.endpoint === "workspace/follow") {
            const baselineFrame = { type: "item", streamId: frame.streamId, value: { type: "baseline", value: {
              items: views, archivedSessionIds: ["session-alice", "session-bob"], pinnedSessionIds: ["session-bob", "session-alice"]
            } } };
            peer.send(JSON.stringify(baselineFrame));
          } else if (frame.endpoint === "session/follow") {
            const id = frame.payload.args.request.address.sessionId;
            peer.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "snapshot",
              header: { id, version: 1, createdAt: 1, cwd: roots.alice, isSeeded: false, hostSecret: "tenant-leak" },
              cursor: 0, records: [], hasMore: false, assistantStream: { revision: 0 },
              projections: { asOfSeq: 0, values: { title: null,
                modelSelection: { lastUsed: null, next: null, hostSecret: "tenant-leak" },
                hostPlugin: { secret: "tenant-leak" } } } } }));
          } else if (frame.endpoint === "session/control") {
            peer.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "baseline", value: {
              projections: { "session-created-alice": { asOfSeq: 0, values: { title: null } },
                "session-bob": { asOfSeq: 0, values: { title: "bob-private" } } } } } }));
          } else if (frame.endpoint === "$events") {
            seen.eventPeer = peer;
            seen.eventStreamId = frame.streamId;
            peer.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "ready", clientId: "mock-client", host: { home: "/operator/private", secret: "hidden" } } }));
            peer.send(JSON.stringify({ type: "item", streamId: frame.streamId, value: { type: "emit", event: "session/added", args: [sessions[1]] } }));
          }
        });
      });
    });
    config.upstream = "http://127.0.0.1:" + await listen(upstream);
    fs.writeFileSync(config.dshWebLog, "dsh web: " + config.upstream + "/?token=" + token + "\n", { mode: 0o600 });
    fs.chmodSync(config.dshWebLog, 0o600);
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
    child = spawn(process.execPath, [path.join(ROOT, "bin/dsh-team-hub.js"), "start"], {
      cwd: ROOT, env: { ...process.env, DSH_TEAM_HUB_HOME: home }, stdio: ["ignore", "pipe", "pipe"]
    });
    // Never emit child stdout/stderr: they might contain private tokens on failure.
    let childOutput = "";
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", data => { childOutput = (childOutput + data.toString()).slice(-4096); });
    const gateway = "http://127.0.0.1:" + config.listenPort;
    const request = (route, options = {}) => fetch(gateway + route, { redirect: "manual", ...options });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error("gateway child exited before readiness");
      try { const response = await request("/__teamhub/whoami"); await response.arrayBuffer(); ready = true; break; }
      catch { await delay(50); }
    }
    assert.ok(ready, "gateway did not become ready");
    const login = async name => {
      const response = await request("/login", { method: "POST", body: new URLSearchParams({ username: name, password: passwords.get(name) }) });
      assert.equal(response.status, 302);
      const cookie = response.headers.get("set-cookie").split(";", 1)[0];
      assert.match(cookie, /^dsh_team_hub_session=/);
      assert.ok(!cookie.includes(token) && !cookie.includes(dshCookie));
      return cookie;
    };
    const anonymous = await request("/api/session/list", { method: "POST", body: "{}" });
    assert.equal(anonymous.status, 401);
    const invalid = await request("/login", { method: "POST", body: new URLSearchParams({ username: "alice", password: "wrong" }) });
    assert.equal(invalid.status, 401);
    const attack = `/"><img src=x onerror=alert(1)>`;
    const loginHtml = await (await request("/login?next=" + encodeURIComponent(attack))).text();
    assert.ok(!loginHtml.includes('"><img') && loginHtml.includes("&quot;&gt;&lt;img"), "login next HTML attribute is escaped");
    const safeRedirect = await request("/login", { method: "POST", body: new URLSearchParams({ username: "alice", password: passwords.get("alice"), next: "//evil.invalid" }) });
    assert.match(safeRedirect.headers.get("location"), /^\/\?teamhub-login=\d+$/, "external login return path is rejected and shell cache is busted");
    const alice = await login("alice"), bob = await login("bob"), admin = await login("admin");
    assert.equal((await (await request("/__teamhub/whoami", { headers: { cookie: alice } })).json()).role, "member");
    assert.equal((await (await request("/__teamhub/whoami", { headers: { cookie: admin } })).json()).role, "admin");
    const normalizedAdminRoute = await request("/remote/api/skin-center/v2/active", { headers: { cookie: admin } });
    assert.equal(normalizedAdminRoute.status, 200);
    assert.deepEqual(await normalizedAdminRoute.json(), { path: "/api/skin-center/v2/active" });
    const freshShell = await request("/?teamhub-login=1234567890123", { headers: { cookie: admin } });
    assert.equal(freshShell.status, 200);
    assert.equal(freshShell.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
    assert.ok((await freshShell.text()).includes('nativeFetch("/__teamhub/whoami"'));
    assert.equal((await request("/?teamhub-login=bad", { headers: { cookie: admin } })).status, 400);
    for (const pairPath of ["/api/pair/status", "/remote/api/pair/status"]) {
      const pairResponse = await request(pairPath, { headers: { cookie: admin } });
      assert.equal(pairResponse.status, 200);
      assert.equal(pairResponse.headers.get("cache-control"), "no-store");
      assert.deepEqual(await pairResponse.json(), { ok: true, paired: true, requirePairingForLan: false, phase: "ready",
        lanAvailable: true, lanAddresses: [], deviceCount: 1, onlineCount: 1 });
      assert.equal((await request(pairPath, { headers: { cookie: alice } })).status, 403);
    }
    for (const heartbeatPath of ["/api/pair/heartbeat", "/remote/api/pair/heartbeat"]) {
      const heartbeat = await request(heartbeatPath, { method: "POST", headers: { cookie: admin, "content-type": "application/json" }, body: "{}" });
      assert.equal(heartbeat.status, 200);
      assert.equal(heartbeat.headers.get("cache-control"), "no-store");
      assert.deepEqual(await heartbeat.json(), { ok: true });
      assert.equal((await request(heartbeatPath, { method: "POST", headers: { cookie: alice, "content-type": "application/json" }, body: "{}" })).status, 403);
    }
    assert.equal((await request("/__teamhub/api/users", { headers: { cookie: alice } })).status, 403);
    for (const usagePath of ["/api/dsh-usage/overview", "/remote/api/dsh-usage/overview"]) {
      const usageResponse = await request(usagePath, { headers: { cookie: alice } });
      assert.equal(usageResponse.status, 200);
      assert.equal(usageResponse.headers.get("cache-control"), "no-store");
      const usage = await usageResponse.json();
      assert.deepEqual(usage.providers, []);
      assert.equal(usage.current, null);
      assert.deepEqual(usage.usage.today.totals, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0, cost: 0 });
      assert.equal(JSON.stringify(usage).includes("tenant-leak"), false);
    }
    const staticBundle = await request("/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=214e67cfa4da",
      { headers: { cookie: alice } });
    assert.equal(staticBundle.status, 200);
    assert.equal(await staticBundle.text(), "/* isolated static client bundle */");
    assert.equal((await request("/index.html?token=fake", { headers: { cookie: alice } })).status, 400);
    assert.equal((await request("/assets/app.js?token=fake", { headers: { cookie: alice } })).status, 400);
    for (const bad of ["/plugins/??@deepseek-ai/dsh-client-modules/server.js&rev=214e67cfa4da",
      "/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=bad",
      "/plugins/??@deepseek-ai/../private/client.js&rev=214e67cfa4da"])
      assert.equal((await request(bad, { headers: { cookie: alice } })).status, 403);
    assert.equal((await request("/admin/", { headers: { cookie: alice } })).status, 403);
    assert.equal((await request("/admin", { headers: { cookie: admin } })).status, 302);
    assert.equal((await request("/__teamhub/api/users", { headers: { cookie: admin } })).status, 200);
    assert.equal((await request("/api/session/list?token=" + token, { headers: { cookie: admin } })).status, 400);
    const rpc = async (cookie, method, payload = { args: { _request: {} } }, prefix = "/api/") => {
      const rpcId = crypto.randomUUID();
      const response = await request(prefix + method, { method: "POST", headers: { cookie, "content-type": "application/json", authorization: "Bearer client-secret", "x-dsh-web-token": "client-secret" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload }) });
      return { response, body: await response.json(), rpcId };
    };
    for (const [cookie, own] of [[alice, "alice"], [bob, "bob"]]) {
      const { response, body } = await rpc(cookie, "session/list");
      assert.equal(response.status, 200);
      assert.equal(body.result.ok, true);
      assert.deepEqual(body.result.value, { items: [sessions.find(s => s.sessionId === "session-" + own)] });
      assert.equal(response.headers.get("set-cookie"), null);
      assert.ok(!JSON.stringify(body).includes("/operator/private"));
      const settings = await rpc(cookie, "settings/describe", { args: {} });
      assert.equal(settings.body.result.value.writable, false);
      assert.equal(settings.body.result.value.hasDocument, false);
      assert.equal(settings.body.result.value.namespaces.length, 1);
      assert.equal(settings.body.result.value.namespaces[0].ns, "ui-settings-general");
      assert.deepEqual(settings.body.result.value.namespaces[0].value, {});
      assert.ok(!JSON.stringify(settings.body).includes("tenant-leak"), "host settings secret was projected");
    }
    const mutationArgs = { ns: "ui-settings-general", ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "2026-09-28.1" }], expectedRevision: 0 };
    const beforeSettingsRpc = seen.rpc.length;
    const saved = await rpc(alice, "settings/mutate", { args: mutationArgs });
    assert.equal(saved.body.result.ok, true);
    assert.deepEqual(saved.body.result.value.value, { welcomeNoticeVersion: "2026-09-28.1" });
    assert.equal((await rpc(bob, "settings/describe", { args: {} })).body.result.value.namespaces[0].revision, 0);
    assert.equal((await rpc(alice, "settings/describe", { args: {} })).body.result.value.namespaces[0].revision, 1);
    for (const args of [
      { ...mutationArgs, ns: "llm" }, { ...mutationArgs, expectedRevision: 0 },
      { ...mutationArgs, ops: [{ op: "set", path: ["other"], value: "2026-09-28.1" }] },
      { ...mutationArgs, ops: [{ op: "set", path: ["welcomeNoticeVersion"], value: "future-version" }] }
    ]) assert.equal((await rpc(alice, "settings/mutate", { args })).body.result.ok, false);
    assert.equal(seen.rpc.length, beforeSettingsRpc, "private member preferences reached shared Host");
    const remoteList = await rpc(alice, "session/list", { args: { _request: {} } }, "/remote/api/");
    assert.equal(remoteList.body.result.ok, true);
    assert.deepEqual(remoteList.body.result.value.items.map(item => item.sessionId), ["session-alice"]);
    const full = await rpc(admin, "session/list");
    assert.deepEqual(full.body.result.value.items, sessions);
    assert.equal(full.response.headers.get("set-cookie"), null);
    const beforeRpc = seen.rpc.length;
    for (const method of ["settings/update", "host.describe", "session.create",
      "dynamicCordisRunner/inventory", "pluginInventory/list", "dsh-web-ui-settings/describe", "agentPresets/list"]) {
      const denied = await rpc(alice, method, { args: {} });
      assert.equal(denied.body.result.ok, false, `${method} must not reach the shared Host`);
    }
    assert.equal(seen.rpc.length, beforeRpc, "unknown member RPC reached upstream");
    const injected = await request("/api/session/list", { method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "injected", method: "session/list", payload: { args: { _request: {} } }, metadata: { credential: "secret" } }) });
    assert.equal(injected.status, 400);
    assert.equal(seen.rpc.length, beforeRpc, "member metadata reached upstream");
    assert.ok(seen.exchange > 0, "gateway did not exchange launch token");
    assert.ok(seen.cookies.length > 0 && seen.cookies.every(cookie => cookie === dshCookie), "upstream received a non-DSH cookie");

    const wsUrl = gateway.replace("http:", "ws:") + "/api/remote.mux";
    const hostile = new WebSocket(wsUrl, { headers: { cookie: alice, origin: "https://attacker.invalid" } });
    assert.equal(await new Promise(resolve => { hostile.once("open", () => resolve("opened")); hostile.once("error", () => resolve("rejected")); }), "rejected", "cross-origin WebSocket upgrade must fail");
    hostile.terminate();
    const remoteAliasUrl = gateway.replace("http:", "ws:") + "/remote/api/remote.mux";
    const remoteAlias = await connect(remoteAliasUrl, alice, gateway);
    sockets.add(remoteAlias);
    const remoteAliasFrames = socketFrames(remoteAlias);
    remoteAlias.send(JSON.stringify({ type: "open", streamId: "remote-work", endpoint: "workspace/follow", payload: { args: {} } }));
    const remoteAliasBaseline = await remoteAliasFrames.next(frame => frame.streamId === "remote-work" && frame.value?.type === "baseline");
    assert.deepEqual(remoteAliasBaseline.value.value.items.map(item => item.workspaceId), ["workspace-alice"]);
    remoteAlias.close();
    const memberWs = await connect(wsUrl, alice);
    sockets.add(memberWs);
    const frames = socketFrames(memberWs);
    const open = (streamId, endpoint, args = {}) => memberWs.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    open("work", "workspace/follow");
    const baseline = await frames.next(frame => frame.streamId === "work" && frame.value?.type === "baseline");
    assert.deepEqual(baseline.value.value.items.map(item => item.workspaceId), ["workspace-alice"]);
    assert.deepEqual(baseline.value.value.items[0].sessionIds, ["session-alice"]);
    assert.deepEqual(baseline.value.value.archivedSessionIds, ["session-alice"]);
    assert.deepEqual(baseline.value.value.pinnedSessionIds, ["session-alice"]);
    const created = await rpc(alice, "session/create", { args: { request: {} } });
    assert.deepEqual(created.body.result.value, { sessionId: "session-created-alice" });
    assert.equal((await rpc(bob, "session/prompt", { args: { request: { sessionId: "session-created-alice",
      requestId: "forged", mode: "queue", content: [{ type: "text", text: "steal" }] } } })).body.result.ok, false);
    assert.equal(seen.prompts.length, 0);
    const prompted = await rpc(alice, "session/prompt", { args: { request: { sessionId: "session-created-alice",
      requestId: "own", mode: "queue", content: [{ type: "text", text: "hello" }] } } });
    assert.equal(prompted.body.result.ok, true);
    assert.deepEqual(prompted.body.result.value, { accepted: true });
    assert.deepEqual(seen.prompts.map(prompt => prompt.sessionId), ["session-created-alice"]);
    open("control", "session/control");
    const control = await frames.next(frame => frame.streamId === "control" && frame.value?.type === "baseline");
    assert.deepEqual(Object.keys(control.value.value.projections), ["session-created-alice"]);
    open("follow", "session/follow", { request: { address: { kind: "session", sessionId: "session-created-alice" }, assistantStream: true } });
    const follow = await frames.next(frame => frame.streamId === "follow" && frame.value?.type === "snapshot");
    assert.equal(follow.value.header.id, "session-created-alice");
    assert.equal(JSON.stringify(follow).includes("tenant-leak"), false);
    assert.deepEqual(follow.value.projections.values.modelSelection, { lastUsed: null, next: null });
    // This Host response cannot be parsed into a reviewed member result.
    // Keep the browser on the DSH RPC contract rather than returning raw HTML.
    const malformedHost = await rpc(alice, "session/modelCatalog", { args: {} });
    assert.equal(malformedHost.body.type, "server-response");
    assert.equal(malformedHost.body.result.ok, false);
    assert.equal(malformedHost.body.result.error.code, "internal");
    const page = await rpc(alice, "session/page", { args: { request: { address: { kind: "session",
      sessionId: "session-created-alice" }, throughSeq: 1 } } });
    assert.equal(page.body.result.ok, true);
    assert.equal(JSON.stringify(page.body).includes("tenant-leak"), false);
    assert.deepEqual(page.body.result.value.records[0].event, { type: "teamhub/redacted-event",
      seq: 1, time: 2, data: {}, ignorable: true });
    const beforeForeignFollow = seen.opens.length;
    open("foreign-follow", "session/follow", { request: { address: { kind: "session", sessionId: "session-bob" } } });
    await delay(30);
    assert.equal(seen.opens.length, beforeForeignFollow, "other member follow never reaches upstream");
    open("events", "$events");
    const event = await frames.next(frame => frame.streamId === "events" && frame.value?.type === "ready");
    assert.deepEqual(event.value, { type: "ready", clientId: "mock-client", host: { home: fs.realpathSync(roots.alice) } });
    const beforeOpens = seen.opens.length;
    open("unrecognized", "operator/secrets");
    open("injected", "workspace/follow", { extra: true });
    await delay(100);
    assert.equal(seen.opens.length, beforeOpens, "unknown or malformed streams reached upstream");
    assert.equal(frames.has(frame => frame.streamId === "events" && frame.value?.type === "emit"), false);
    assert.equal(frames.has(frame => frame.streamId === "unrecognized" || frame.streamId === "injected"), false);
    const answer = { clientId: "mock-client", eventId: "approval-owned", outcome: { kind: "result", value: "allowed-once" } };
    const forged = await rpc(alice, "$events/result", { args: answer });
    assert.equal(forged.body.result.ok, false, "member cannot reply before actual delivery");
    assert.equal(seen.eventReplies.length, 0);
    const injectEvent = (eventId, agentId) => seen.eventPeer.send(JSON.stringify({ type: "item", streamId: seen.eventStreamId, value: {
      type: "waterfall", event: "approval/request", eventId, agentId, request: { toolName: "bash", reason: "Review" }
    } }));
    injectEvent("approval-foreign", "session-bob");
    await delay(30);
    assert.equal(frames.has(frame => frame.value?.eventId === "approval-foreign"), false);
    assert.equal((await rpc(alice, "$events/result", { args: { ...answer, eventId: "approval-foreign" } })).body.result.ok, false);
    injectEvent("approval-owned", "session-alice");
    const delivered = await frames.next(frame => frame.value?.eventId === "approval-owned");
    assert.equal(delivered.value.agentId, "session-alice");
    assert.equal((await rpc(bob, "$events/result", { args: answer })).body.result.ok, false, "other member cannot steal decision");
    assert.equal((await rpc(alice, "$events/result", { args: { ...answer, eventId: "wrong" } })).body.result.ok, false);
    const hostileReply = await request("/api/$events/result", { method: "POST", headers: { cookie: alice, origin: "https://attacker.invalid", "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method: "$events/result", payload: { args: answer } }) });
    assert.equal((await hostileReply.json()).result.ok, false, "cross-origin event result cannot claim approval");
    seen.rejectNextEventResult = true;
    assert.equal((await rpc(alice, "$events/result", { args: answer })).body.result.ok, false);
    assert.equal((await rpc(alice, "$events/result", { args: answer })).body.result.ok, true,
      "upstream rejection must not consume member decision");
    assert.deepEqual(seen.eventReplies, [answer, answer]);
    assert.equal((await rpc(alice, "$events/result", { args: answer })).body.result.ok, false, "reply is one-use");
    assert.deepEqual(seen.eventReplies, [answer, answer]);
    const question = { clientId: "mock-client", eventId: "question-owned",
      outcome: { kind: "result", value: { answers: [{ id: "q1", selected: ["Yes"] }] } } };
    seen.eventPeer.send(JSON.stringify({ type: "item", streamId: seen.eventStreamId,
      value: { type: "waterfall", event: "user-questions/request",
        eventId: "question-owned", agentId: "session-alice",
        request: { questions: [{ id: "q1", question: "Continue?",
          options: [{ label: "Yes" }, { label: "No" }] }] } } }));
    assert.equal((await frames.next(frame => frame.value?.eventId === "question-owned")).value.agentId,
      "session-alice");
    assert.equal((await rpc(bob, "$events/result", { args: question })).body.result.ok, false);
    assert.equal((await rpc(alice, "$events/result", { args: { ...question,
      outcome: { kind: "result", value: { answers: [{ id: "q1", selected: ["unlisted"] }] } } } })).body.result.ok, false);
    assert.equal((await rpc(alice, "$events/result", { args: question })).body.result.ok, true);
    assert.equal((await rpc(alice, "$events/result", { args: question })).body.result.ok, false);
    assert.deepEqual(seen.eventReplies, [answer, answer, question]);
    const abandoned = { ...answer, eventId: "approval-abandoned" };
    injectEvent("approval-abandoned", "session-alice");
    await frames.next(frame => frame.value?.eventId === "approval-abandoned");
    memberWs.send(JSON.stringify({ type: "cancel", streamId: "events" }));
    await delay(40);
    assert.equal((await rpc(alice, "$events/result", { args: abandoned })).body.result.ok, false,
      "cancelled event stream must revoke outstanding approval");
    assert.deepEqual(seen.eventReplies, [answer, answer, question]);
    assert.equal((await request("/logout", { headers: { cookie: alice } })).status, 302);
    const afterLogout = seen.opens.length;
    open("after-logout", "workspace/follow");
    await delay(80);
    assert.equal(seen.opens.length, afterLogout, "logged-out socket cannot open another stream");
    assert.ok(!childOutput.includes(token) && !childOutput.includes(dshCookie), "gateway output exposed upstream credentials");
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const socket of upstreamSockets) socket.terminate();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(1500)]);
      if (child.exitCode === null) { child.kill("SIGKILL"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(500)]); }
    }
    if (upstreamWs) await Promise.race([close(upstreamWs), delay(500)]);
    if (upstream) { upstream.closeAllConnections(); await Promise.race([close(upstream), delay(500)]); }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
