import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const digest = value => createHash("sha256").update(value).digest("hex");
const sessionCookieName = "agentforge_session";
const bootstrapCookieName = "agentforge_bootstrap";
// Browser cookie storage is finite; renew it on authenticated requests.
// Server-side sessions have no time deadline (expires_at = 0).
const cookieLifetimeSeconds = 400 * 24 * 60 * 60;
const windowMs = 15 * 60 * 1000;
const hashPassword = (password, salt) => derive(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
function tokenFrom(request, name = sessionCookieName) {
  const values = (request.headers.cookie || "").split(";").map(x => x.trim()).filter(x => x.startsWith(name + "="));
  const token = values.length === 1 ? values[0].slice(name.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(token) ? token : "";
}
function sameToken(actual, expected) {
  return typeof actual === "string" && typeof expected === "string" && actual.length === expected.length && actual.length === 64 && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
async function credentials(request) {
  let body = "";
  for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 4096) throw new Error("invalid_body"); }
  return JSON.parse(body);
}
export function createAuth({ databasePath, origins = ["http://127.0.0.1:4310", "http://localhost:4310"], bootstrapToken = "", now = Date.now }) {
  if (!origins.length || origins.some(value => {
    const url = new URL(value);
    return value !== url.origin || !["https:", "http:"].includes(url.protocol) || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  })) throw new Error("认证 origin 必须为精确 HTTPS 地址，HTTP 仅允许 loopback");
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS administrator (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, count INTEGER NOT NULL);`);
  const originSet = new Set(origins.map(value => new URL(value).origin));
  const hosts = new Set([...originSet].map(value => new URL(value).host));
  const bootstrapSecret = /^[a-f0-9]{64}$/.test(bootstrapToken) ? bootstrapToken : "";
  let bootstrapSessionToken = "", bootstrapSessionExpiresAt = 0;
  const cookie = (name, token, maxAge, origin) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
  const account = () => db.prepare("SELECT * FROM administrator WHERE id=1").get();
  const revoke = request => db.prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(tokenFrom(request)));
  const bootstrapEnabled = () => Boolean(bootstrapSecret || (bootstrapSessionToken && bootstrapSessionExpiresAt > now())) && !account();
  const bootstrapAuthorized = request => bootstrapEnabled() && bootstrapSessionExpiresAt > now() && sameToken(tokenFrom(request, bootstrapCookieName), bootstrapSessionToken);
  const bootstrapHeaderAuthorized = request => sameToken(typeof request.headers["x-agentforge-bootstrap"] === "string" ? request.headers["x-agentforge-bootstrap"] : "", bootstrapSecret);
  const issueBootstrapSession = () => {
    bootstrapSessionToken = randomBytes(32).toString("hex");
    bootstrapSessionExpiresAt = now() + 10 * 60 * 1000;
    return bootstrapSessionToken;
  };
  const revokeBootstrapSession = () => { bootstrapSessionToken = ""; bootstrapSessionExpiresAt = 0; };
  function session(request) {
    const token = tokenFrom(request);
    if (!token) return null;
    const row = db.prepare("SELECT expires_at FROM sessions WHERE token_hash=? AND (expires_at=0 OR expires_at>?)").get(digest(token), now());
    return row ? { username: account()?.username, expiresAt: row.expires_at === 0 ? null : row.expires_at } : null;
  }
  function consumeAttempt(ip) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM login_limits WHERE started_at<=?").run(now() - windowMs);
      const keys = [["all", 50], [digest(ip), 10]];
      for (const [key, limit] of keys) {
        if ((db.prepare("SELECT count FROM login_limits WHERE key=?").get(key)?.count || 0) >= limit) { db.exec("COMMIT"); return false; }
      }
      for (const [key] of keys) db.prepare("INSERT INTO login_limits VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET count=count+1").run(key, now());
      db.exec("COMMIT"); return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function validateAdministrator(username, password) {
    if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(username)) throw new Error("用户名需为 1–64 位字母、数字、点、下划线或连字符");
    if (typeof password !== "string" || password.length < 10 || password.length > 128) throw new Error("密码长度需为 10–128 字符");
  }
  async function createInitialAdministrator(username, password) {
    validateAdministrator(username, password);
    const salt = randomBytes(32).toString("hex"), hash = await hashPassword(password, salt);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (account()) throw new Error("管理员已设置");
      db.prepare("INSERT INTO administrator VALUES (1, ?, ?, ?)").run(username, salt, hash.toString("hex"));
      db.exec("DELETE FROM sessions; DELETE FROM login_limits; COMMIT;");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function issueSession(request, response, origin, extraCookies = []) {
    revoke(request);
    db.prepare("DELETE FROM sessions WHERE expires_at>0 AND expires_at<=?").run(now());
    const token = randomBytes(32).toString("hex"), expiresAt = 0;
    db.prepare("INSERT INTO sessions VALUES (?, ?)").run(digest(token), expiresAt);
    const cookies = [cookie(sessionCookieName, token, cookieLifetimeSeconds, origin), ...extraCookies];
    response.setHeader("Set-Cookie", cookies.length === 1 ? cookies[0] : cookies);
    return { username: account().username, expiresAt: null };
  }
  return {
    close: () => db.close(),
    session,
    configured: () => Boolean(account()),
    async reauthenticate(request, password) {
      const current = session(request), admin = account();
      if (!current || !admin || !consumeAttempt(request.socket.remoteAddress || "unknown")) throw new Error("请重新登录或稍后重试");
      if (typeof password !== "string" || password.length > 128) throw new Error("当前密码不正确");
      const hash = await hashPassword(password, admin.salt);
      if (!timingSafeEqual(hash, Buffer.from(admin.password_hash, "hex")) || !session(request) || account()?.password_hash !== admin.password_hash) throw new Error("当前密码不正确");
    },
    establishResetSetup(response, origin) {
      if (account() || !originSet.has(origin)) throw new Error("无法创建首次设置会话");
      response.setHeader("Set-Cookie", [cookie(sessionCookieName, "", 0, origin), cookie(bootstrapCookieName, issueBootstrapSession(), 600, origin)]);
    },
    async setAdministrator(username, password) {
      validateAdministrator(username, password);
      const salt = randomBytes(32).toString("hex"), hash = await hashPassword(password, salt);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR REPLACE INTO administrator VALUES (1, ?, ?, ?)").run(username, salt, hash.toString("hex"));
        db.exec("DELETE FROM sessions; DELETE FROM login_limits; COMMIT;");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async guard(request, response, url) {
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Cache-Control", "no-store");
      if (!hosts.has(request.headers.host)) { json(response, 403, { error: "host_not_allowed" }); return true; }
      const path = url.pathname;
      const write = !["GET", "HEAD"].includes(request.method);
      const attachmentUpload = request.method === 'POST' && /^\/api\/communications\/chat_[A-Za-z0-9_-]+\/attachments$/.test(path) && /^application\/octet-stream(?:;|$)/i.test(request.headers['content-type'] || '');
      if (write && (!originSet.has(request.headers.origin) || new URL(request.headers.origin).host !== request.headers.host || (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "") && !attachmentUpload))) {
        json(response, 403, { error: "same_origin_json_required" }); return true;
      }
      if (request.method === "GET" && path === "/api/auth/bootstrap-status") {
        json(response, 200, { available: bootstrapEnabled(), configured: Boolean(account()) }); return true;
      }
      if (request.method === "GET" && path === "/setup") {
        if (!bootstrapEnabled() || !bootstrapHeaderAuthorized(request)) { json(response, 404, { error: "not_found" }); return true; }
        response.setHeader("Set-Cookie", cookie(bootstrapCookieName, issueBootstrapSession(), 600, `http://${request.headers.host}`));
        response.writeHead(303, { Location: "/setup.html" }); response.end(); return true;
      }
      if (request.method === "GET" && ["/setup.html", "/setup.js"].includes(path)) {
        if (!bootstrapEnabled() || !bootstrapAuthorized(request)) { json(response, 404, { error: "not_found" }); return true; }
        return false;
      }
      if (request.method === "POST" && path === "/api/auth/bootstrap") {
        if (!bootstrapEnabled() || !bootstrapAuthorized(request)) { json(response, 404, { error: "not_found" }); return true; }
        let input;
        try { input = await credentials(request); await createInitialAdministrator(input?.username, input?.password); }
        catch (error) {
          if (error.message === "管理员已设置") revokeBootstrapSession();
          json(response, error.message === "管理员已设置" ? 409 : 400, { error: error.message === "管理员已设置" ? "管理员已设置，请使用登录入口" : error.message || "无效初始化请求" }); return true;
        }
        revokeBootstrapSession();
        json(response, 201, issueSession(request, response, request.headers.origin, [cookie(bootstrapCookieName, "", 0, request.headers.origin)])); return true;
      }
      if (request.method === "POST" && path === "/api/auth/login") {
        if (!consumeAttempt(request.socket.remoteAddress || "unknown")) { response.setHeader("Retry-After", "900"); json(response, 429, { error: "尝试过于频繁，请 15 分钟后重试" }); return true; }
        const admin = account();
        if (!admin) { json(response, 503, { error: "管理员尚未设置。请先进入启动当前服务的 AgentForge 项目目录，再运行 npm run auth:setup。" }); return true; }
        let input;
        try { input = await credentials(request); } catch { json(response, 400, { error: "无效登录请求" }); return true; }
        if (!input || typeof input.username !== "string" || typeof input.password !== "string" || input.password.length > 128) { json(response, 401, { error: "用户名或密码错误" }); return true; }
        const hash = await hashPassword(input.password, admin.salt);
        if (!timingSafeEqual(hash, Buffer.from(admin.password_hash, "hex")) || input.username !== admin.username || account()?.password_hash !== admin.password_hash) {
          json(response, 401, { error: "用户名或密码错误" }); return true;
        }
        json(response, 200, issueSession(request, response, request.headers.origin)); return true;
      }
      if (request.method === "POST" && path === "/api/auth/logout") {
        revoke(request); response.setHeader("Set-Cookie", cookie(sessionCookieName, "", 0, request.headers.origin)); json(response, 200, { ok: true }); return true;
      }
      if (request.method === "GET" && ["/login", "/login.js", "/login.css", "/api/health"].includes(path)) return false;
      const current = session(request);
      if (!current) {
        if (path.startsWith("/api/")) json(response, 401, { error: "authentication_required" });
        else { response.writeHead(303, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` }); response.end(); }
        return true;
      }
      if (current.expiresAt === null) response.setHeader("Set-Cookie", cookie(sessionCookieName, tokenFrom(request), cookieLifetimeSeconds, origins.find(value => new URL(value).host === request.headers.host) || origins[0]));
      if (path === "/api/auth/session" && request.method === "GET") { json(response, 200, current); return true; }
      return false;
    }
  };
}
