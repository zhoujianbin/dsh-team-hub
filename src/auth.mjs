import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sessionsPath(home) { return path.join(home, "sessions.json"); }

export function loadSessions(home) {
  const file = sessionsPath(home);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function saveSessions(home, sessions) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionsPath(home), JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

export function issueSession(home, username, ttlMs = 1000 * 60 * 60 * 24 * 14) {
  const sessions = loadSessions(home);
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions[token] = { username, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
  saveSessions(home, sessions);
  return { token, ...sessions[token] };
}

export function resolveSession(home, token) {
  if (!token) return null;
  const sessions = loadSessions(home);
  const session = sessions[token];
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    delete sessions[token];
    saveSessions(home, sessions);
    return null;
  }
  return session;
}

export function revokeSessionsForUser(home, username) {
  const sessions = loadSessions(home);
  let count = 0;
  for (const [token, session] of Object.entries(sessions)) {
    if (session.username === username) { delete sessions[token]; count += 1; }
  }
  saveSessions(home, sessions);
  return count;
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
