import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { DshBrowserAuth, readDshWebToken } from "../src/dsh-browser-auth.mjs";
import { upstreamRpc } from "../src/upstream.mjs";

const A = "A".repeat(43);
const B = "B".repeat(43);
const C = "C".repeat(43);
const line = (origin, token) => 'dsh web: ' + origin + '/?token=' + token + '\n';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-browser-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "dsh-web.log");
  const config = { upstream: "http://127.0.0.1:3080", dshWebLog: file };
  function write(text, mode = 0o600) {
    fs.writeFileSync(file, text, { mode });
    fs.chmodSync(file, mode);
  }
  return { dir, file, config, write };
}

async function mockServer(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { origin: 'http://127.0.0.1:' + server.address().port, requests };
}

function respond(res, { status = 303, location = "./", cookie = "dsh-auth-test=v1.signature.payload" } = {}) {
  res.writeHead(status, { location, "set-cookie": cookie });
  res.end();
}

test("reads only a private regular log, not a symlink or missing file", (t) => {
  const f = fixture(t);
  f.write(line(f.config.upstream, A));
  assert.equal(readDshWebToken(f.config), A);
  fs.chmodSync(f.file, 0o640);
  assert.equal(readDshWebToken(f.config), null);
  fs.chmodSync(f.file, 0o600);
  const link = path.join(f.dir, "link.log");
  fs.symlinkSync(f.file, link);
  assert.equal(readDshWebToken({ ...f.config, dshWebLog: link }), null);
  assert.equal(readDshWebToken({ ...f.config, dshWebLog: path.join(f.dir, "absent") }), null);
  assert.equal(readDshWebToken({ ...f.config, dshWebLog: f.dir }), null);
});

test("rejects unsafe upstream URLs and wrong log origins", (t) => {
  const f = fixture(t);
  f.write(line(f.config.upstream, A));
  for (const upstream of ["https://127.0.0.1:3080", "http://example.com:3080", "http://127.0.0.2:3080", "http://user@127.0.0.1:3080", "http://127.0.0.1:3080/path", "http://127.0.0.1:3080/?x=1", "http://127.0.0.1:3080/#part"]) {
    assert.equal(readDshWebToken({ ...f.config, upstream }), null, upstream);
  }
  for (const wrong of ["http://localhost:3080", "http://127.0.0.1:3081", "https://127.0.0.1:3080", "http://127.0.0.2:3080"]) {
    f.write(line(wrong, B));
    assert.equal(readDshWebToken(f.config), null, wrong);
  }
});

test("matches IPv6 loopback origin exactly", (t) => {
  const f = fixture(t);
  const config = { ...f.config, upstream: "http://[::1]:3080" };
  f.write(line("http://127.0.0.1:3080", A) + line("http://[::1]:3080", B));
  assert.equal(readDshWebToken(config), B);
  assert.equal(readDshWebToken(f.config), A);
});

test("newest valid token wins, ignoring malformed later lines", (t) => {
  const f = fixture(t);
  const o = f.config.upstream;
  f.write(line(o, A) + line(o, B) + line(o, "short") + line(o, C + "&token=" + A) +
    'dsh web: ' + o + '/other?token=' + C + '\n' +
    'dsh web: ' + o + '/?token=' + C + '%21\n' +
    'not dsh web: ' + o + '/?token=' + C + '\n' +
    'dsh web: http://[invalid/?token=' + C + '\n');
  assert.equal(readDshWebToken(f.config), B);
  f.write(line(o, A) + "dsh web: " + o + "/?token=" + C);
  assert.equal(readDshWebToken(f.config), A, "unterminated launch log record is not committed");
  f.write(line(o, A) + line(o, B));
  fs.appendFileSync(f.file, line(o, C));
  assert.equal(readDshWebToken(f.config), C);
});

test("bounded log tail skips a partial first line", (t) => {
  const f = fixture(t);
  const o = f.config.upstream;
  f.write(line(o, A) + "x".repeat(8 * 1024 * 1024 + 37) + "\n" + line(o, B));
  assert.equal(readDshWebToken(f.config), B);
  f.write(line(o, A) + "x".repeat(8 * 1024 * 1024 + 37));
  assert.equal(readDshWebToken(f.config), null);
});

test("explicit cookie invalidation detaches a pending exchange", async (t) => {
  const f = fixture(t);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const server = await mockServer(t, async (_req, res) => {
    started();
    await gate;
    respond(res);
  });
  f.config.upstream = server.origin;
  f.write(line(server.origin, A));
  const auth = new DshBrowserAuth(f.config);
  const stale = auth.cookieHeader();
  await seen;
  auth.invalidate();
  release();
  await assert.rejects(stale, /rotated during exchange/);
  assert.equal(auth.cookie, null);
  assert.equal(auth.pending, null);
  assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1.signature.payload");
  assert.equal(server.requests.length, 2);
});

test("network failures never expose the launch token in errors", async (t) => {
  const f = fixture(t);
  f.write(line(f.config.upstream, A));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("request failed for token=" + A); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const auth = new DshBrowserAuth(f.config);
  await assert.rejects(auth.cookieHeader(), error =>
    error.message === "DSH Web token exchange unavailable" && !String(error).includes(A));
  assert.equal(auth.cookie, null);
});

test("token rotation while exchange is pending never returns an old cookie", async (t) => {
  const f = fixture(t);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { started = resolve; });
  const server = await mockServer(t, async (req, res) => {
    const token = new URL(req.url, "http://localhost").searchParams.get("token");
    if (token === A) { started(); await gate; }
    respond(res, { cookie: "dsh-auth-test=v1." + token + ".signature" });
  });
  f.config.upstream = server.origin;
  f.write(line(server.origin, A));
  const auth = new DshBrowserAuth(f.config);
  const old = auth.cookieHeader();
  await seen;
  f.write(line(server.origin, B));
  auth.lastCheck = Date.now() - 1001;
  const current = auth.cookieHeader();
  // The new exchange must complete while the obsolete response is held.
  assert.equal(await Promise.race([current, new Promise((_, reject) =>
    setTimeout(() => reject(new Error("new exchange blocked by old token")), 1000))]),
    "dsh-auth-test=v1." + B + ".signature");
  release();
  await assert.rejects(old, /rotated during exchange/);
  assert.equal(auth.cookie, "dsh-auth-test=v1." + B + ".signature");
  assert.equal(server.requests.length, 2);
});

test("parallel calls exchange one token once and cache cookie", async (t) => {
  const f = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = await mockServer(t, async (_req, res) => { await gate; respond(res); });
  f.config.upstream = server.origin;
  f.write(line(server.origin, A));
  const auth = new DshBrowserAuth(f.config);
  const calls = Array.from({ length: 12 }, () => auth.cookieHeader());
  release();
  assert.deepEqual(await Promise.all(calls), Array(12).fill("dsh-auth-test=v1.signature.payload"));
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, '/?token=' + A);
  assert.equal(server.requests[0].headers["cache-control"], "no-store");
  assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1.signature.payload");
  assert.equal(server.requests.length, 1);
});

test("rejects invalid redirects and cookies, then retries successfully", async (t) => {
  for (const invalid of [
    { status: 302 }, { location: "/" },
    { cookie: "other=v1.signature.payload" }, { cookie: "dsh-auth-test=bad" },
    { cookie: "dsh-auth-test=v1.signature.payload, other=unsafe" },
  ]) {
    const f = fixture(t);
    let bad = true;
    const server = await mockServer(t, (_req, res) => respond(res, bad ? invalid : {}));
    f.config.upstream = server.origin;
    f.write(line(server.origin, A));
    const auth = new DshBrowserAuth(f.config);
    await assert.rejects(auth.cookieHeader(), /token exchange/);
    assert.equal(auth.cookie, null);
    assert.equal(auth.pending, null);
    bad = false;
    assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1.signature.payload");
    assert.equal(server.requests.length, 2);
  }
});

test("token rotation and expired discovery cache trigger new exchanges", async (t) => {
  const f = fixture(t);
  const server = await mockServer(t, (req, res) => respond(res, { cookie: "dsh-auth-test=v1." + new URL(req.url, "http://localhost").searchParams.get("token") + ".signature" }));
  f.config.upstream = server.origin;
  f.write(line(server.origin, A));
  const auth = new DshBrowserAuth(f.config);
  assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1." + A + ".signature");
  fs.appendFileSync(f.file, line(server.origin, B));
  assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1." + A + ".signature");
  auth.lastCheck = Date.now() - 1001;
  assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1." + B + ".signature");
  assert.equal(server.requests.length, 2);
  fs.chmodSync(f.file, 0o644);
  auth.lastCheck = Date.now() - 1001;
  await assert.rejects(auth.cookieHeader(), /private launch token unavailable/);
  assert.equal(auth.cookie, null);
  assert.equal(auth.token, null);
  fs.chmodSync(f.file, 0o600);
  auth.lastCheck = Date.now() - 1001;
  assert.equal(await auth.cookieHeader(), "dsh-auth-test=v1." + B + ".signature");
  assert.equal(server.requests.length, 3);
});


test("upstream RPC never includes Host response text or error metadata in diagnostics", async (t) => {
  const f = fixture(t);
  const secret = "host-private-token-marker";
  let failure = "html";
  const server = await mockServer(t, (req, res) => {
    if (req.url === "/?token=" + A) return respond(res);
    assert.equal(req.headers.cookie, "dsh-auth-test=v1.signature.payload");
    if (failure === "html") { res.writeHead(503); res.end("<html>" + secret + "</html>"); return; }
    if (failure === "disconnect") { req.socket.destroy(); return; }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: { ok: false, error: { code: "internal", message: secret } } }));
  });
  f.config.upstream = server.origin;
  f.write(line(server.origin, A));
  await assert.rejects(upstreamRpc(f.config, "session/list", { args: { _request: {} } }), error =>
    error.message.includes("non-JSON") && !error.message.includes(secret));
  failure = "json";
  await assert.rejects(upstreamRpc(f.config, "session/list", { args: { _request: {} } }), error =>
    error.message.includes("request failed") && !error.message.includes(secret));
  failure = "disconnect";
  await assert.rejects(upstreamRpc(f.config, "session/list", { args: { _request: {} } }), error =>
    error.message.includes("connection failed") && !error.message.includes(secret));
});
