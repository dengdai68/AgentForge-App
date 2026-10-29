import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

// Diagnostic JSONL lives under the private data home, not the shared system
// temporary directory: it is operator-reviewed instance state, and tmp cleanup
// must not silently discard failure evidence.
export function defaultDiagnosticRoot(home = homedir()) { return join(home, ".agentforge", "logs"); }

const context = new AsyncLocalStorage();
const privateKey = /password|passwd|secret|token|credential|authorization|cookie|api.?key|session.?id|signature|encrypted|prompt|spawnargs/i;

// No category mapping or length limit: retain diagnostic wording and stack.
// This is a best-effort local filter, not a universal secret scanner.
export function diagnosticRedactor({ secrets = [], prompt = "" } = {}) {
  let insidePrivateKey = false;
  const values = [...new Set([...secrets, ...Object.entries(process.env).filter(([key]) => privateKey.test(key)).map(([, value]) => value), prompt,
    ...prompt.split('\n').filter(line => line.length >= 24)].filter(value => typeof value === "string" && value.length >= 4))].sort((a, b) => b.length - a.length);
  function text(value) {
    let output = String(value);
    if (insidePrivateKey || /-----BEGIN [^-]*PRIVATE KEY-----/.test(output)) {
      insidePrivateKey = !/-----END [^-]*PRIVATE KEY-----/.test(output);
      return "[REDACTED PRIVATE KEY]";
    }
    for (const secret of values) output = output.replaceAll(secret, "[REDACTED]").replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]");
    return output
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
      .replace(/\bBearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,}|github_pat_[a-zA-Z0-9_]+|glpat-[a-zA-Z0-9_-]+)/g, "[REDACTED]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/((?:api[_-]?key|password|passwd|secret|token|authorization|cookie|session[_-]?id)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]");
  }
  return function clean(value, seen = new WeakSet()) {
    if (typeof value === "string") return text(value);
    if (typeof value === "bigint") return String(value);
    if (!value || typeof value !== "object") return value;
    if (["redacted_thinking", "encrypted_reasoning"].includes(value.type)) return { type: value.type, data: "[REDACTED]" };
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const entries = value instanceof Error
      ? [...new Set(["name", "message", "stack", "cause", ...Object.getOwnPropertyNames(value)])].map(key => [key, value[key]])
      : Object.entries(value);
    const result = Array.isArray(value) ? [] : {};
    for (const [key, item] of entries) result[key] = privateKey.test(key) ? "[REDACTED]" : clean(item, seen);
    seen.delete(value);
    return result;
  };
}

export function createDiagnosticLog({ directory = process.env.AGENTFORGE_LOG_DIR || defaultDiagnosticRoot(), maxBytes = 10 * 1024 * 1024 } = {}) {
  directory = resolve(directory);
  const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let part = 0, bytes = 0, filePath = join(directory, `${prefix}-${part}.jsonl`), failure = null;
  function write(event, fields = {}, redact = diagnosticRedactor()) {
    let fd;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error("Diagnostic directory must be private and owned by the current user");
      // Resolve the trusted OS temporary parent, but reject the final directory link.
      const canonical = realpathSync(directory);
      const record = JSON.stringify(redact({ timestamp: new Date().toISOString(), pid: process.pid, event, ...context.getStore()?.fields, ...fields })) + '\n';
      if (bytes >= maxBytes) { ++part; bytes = 0; }
      filePath = join(canonical, `${prefix}-${part}.jsonl`);
      fd = openSync(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const file = fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1 || (process.getuid && file.uid !== process.getuid())) throw new Error("Diagnostic log is not a private regular file");
      fchmodSync(fd, 0o600);
      appendFileSync(fd, record);
      bytes += Buffer.byteLength(record); failure = null;
      return true;
    } catch (error) {
      failure = { code: error.code || "LOG_WRITE_FAILED", message: String(error.message) };
      // Never hide a logging failure or recursively send it through this logger.
      try { writeSync(2, `AgentForge diagnostic log unavailable: ${failure.code}\n`); } catch { /* stderr may also be closed */ }
      return false;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return { write, status: () => ({ directory, filePath, available: failure === null, error: failure, format: "JSONL", retention: "10 MiB 分卷；不自动删除，由操作者手工清理。" }) };
}

let defaultLog;
export function instanceDiagnosticDirectory(databasePath) {
  const key = createHash("sha256").update(resolve(databasePath)).digest("hex").slice(0, 24);
  return join(defaultDiagnosticRoot(), key);
}
export function diagnostics() { return defaultLog ||= createDiagnosticLog(); }
export function diagnostic(event, fields = {}) {
  const current = context.getStore();
  return (current?.logger || diagnostics()).write(event, fields, current?.redact || diagnosticRedactor());
}
export function withDiagnosticContext(fields, work, { redact, logger } = {}) {
  const parent = context.getStore();
  return context.run({ fields: { ...parent?.fields, ...fields }, redact: redact || parent?.redact, logger: logger || parent?.logger }, work);
}
export function installProcessDiagnostics(component, { instancePath } = {}) {
  if (instancePath) defaultLog = createDiagnosticLog({ directory: process.env.AGENTFORGE_LOG_DIR || instanceDiagnosticDirectory(instancePath) });
  diagnostic("process.started", { component, node: process.version, platform: process.platform, arch: process.arch, cwd: process.cwd() });
  process.on("uncaughtExceptionMonitor", (error, origin) => diagnostic("process.uncaught", { component, origin, error }));
  process.on("warning", warning => diagnostic("process.warning", { component, error: warning }));
  process.on("exit", code => diagnostic("process.exit", { component, code }));
}
