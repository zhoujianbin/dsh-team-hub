import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

function upstreamOrigin(config) {
  const url = new URL(config.upstream);
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

export function readDshWebToken(config) {
  const origin = upstreamOrigin(config);
  if (!origin) return null;
  const file = config.dshWebLog || path.join(os.homedir(), "dsh-web.log");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) return null;
    const size = Math.min(stat.size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(size);
    const start = stat.size - size;
    const count = fs.readSync(fd, buffer, 0, size, start);
    const firstBreak = start ? buffer.indexOf(10) : -1;
    if (start && firstBreak < 0) return null;
    const text = buffer.subarray(firstBreak >= 0 ? firstBreak + 1 : 0, count).toString("utf8");
    const lines = text.split("\n");
    // A log writer may still be appending the last line. Never treat a
    // transient, unterminated token record as a committed launch URL.
    if (!text.endsWith("\n")) lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = /^dsh web: (https?:\/\/\S+)$/.exec(lines[i].trim());
      if (!match) continue;
      let url;
      try { url = new URL(match[1]); }
      catch { continue; } // A malformed log entry cannot mask an earlier valid token.
      const tokens = url.searchParams.getAll("token");
      if (url.origin === origin && url.pathname === "/" && !url.hash && url.searchParams.size === 1 && tokens.length === 1 && TOKEN.test(tokens[0])) return tokens[0];
    }
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export class DshBrowserAuth {
  constructor(config) { this.config = config; this.cookie = null; this.token = null; this.pending = null; this.lastCheck = 0; this.lastToken = null; }

  async cookieHeader() {
    const now = Date.now();
    if (now - this.lastCheck > 1000) {
      this.lastToken = readDshWebToken(this.config);
      this.lastCheck = now;
      if (!this.lastToken) this.invalidate();
    }
    const token = this.lastToken;
    if (!token) throw new Error("DSH Web private launch token unavailable");
    if (this.token === token && this.cookie) return this.cookie;
    if (this.pending && this.pendingToken === token) return this.pending;
    // On rotation, start the new exchange immediately; a hung old exchange
    // must not stall member traffic or overwrite the current cookie.
    const pending = this.exchange(token).then(cookie => {
      if (this.pending !== pending || this.lastToken !== token)
        throw new Error("DSH Web launch token rotated during exchange");
      this.cookie = cookie;
      this.token = token;
      return cookie;
    }).finally(() => { if (this.pending === pending) { this.pending = null; this.pendingToken = null; } });
    this.pendingToken = token;
    this.pending = pending;
    return pending;
  }

  async exchange(token) {
    const origin = upstreamOrigin(this.config);
    if (!origin) throw new Error("DSH Web upstream must be loopback HTTP");
    const url = new URL(origin);
    url.searchParams.set("token", token);
    let response;
    try {
      response = await fetch(url, { redirect: "manual",
        headers: { "cache-control": "no-store" }, signal: AbortSignal.timeout(5000) });
    } catch {
      // Fetch exceptions may embed a token-bearing URL in cause/diagnostics.
      throw new Error("DSH Web token exchange unavailable");
    }
    if (response.status !== 303 || response.headers.get("location") !== "./") throw new Error("DSH Web token exchange failed");
    const pair = (response.headers.get("set-cookie") || "").split(";", 1)[0];
    if (!/^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pair)) throw new Error("DSH Web token exchange returned no valid cookie");
    return pair;
  }

  invalidate() {
    this.cookie = null;
    this.token = null;
    // Revocation must invalidate in-flight exchanges as well. Retain the old
    // promise for existing callers but detach it from the current generation.
    this.pending = null;
    this.pendingToken = null;
  }
}
