import fs from "node:fs";
import path from "node:path";

export function auditPath(home) { return path.join(home, "logs", "audit.jsonl"); }

export class AuditLog {
  constructor(home, { maxBytes = 10 * 1024 * 1024, keepFiles = 3 } = {}) {
    this.home = home;
    this.file = auditPath(home);
    this.maxBytes = maxBytes;
    this.keepFiles = keepFiles;
  }

  write(type, details = {}) {
    const entry = { at: new Date().toISOString(), type, ...redact(details) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.rotateIfNeeded();
    fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  }

  rotateIfNeeded() {
    try {
      if (!fs.existsSync(this.file) || fs.statSync(this.file).size < this.maxBytes) return;
      for (let i = this.keepFiles - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {}
  }

  query({ user, type, limit = 200 } = {}) {
    if (!fs.existsSync(this.file)) return [];
    const lines = fs.readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const entry = JSON.parse(lines[i]);
        if (user && entry.user !== user) continue;
        if (type && entry.type !== type) continue;
        out.push(entry);
      } catch {}
    }
    return out;
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|secret|credential|apikey|api_key/i.test(key)) out[key] = "[redacted]";
    else out[key] = redact(item);
  }
  return out;
}
