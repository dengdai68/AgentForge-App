import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createAuth } from "../server/auth.mjs";

test("local service requires an owning client before opening storage", async () => {
  const {execFile}=await import("node:child_process");
  const {promisify}=await import("node:util");
  await assert.rejects(promisify(execFile)(process.execPath,["server/index.mjs"],{env:{...process.env,AGENTFORGE_BOOTSTRAP_TOKEN:"",HOST:"0.0.0.0",PORT:"4310"}}),error=>error.code===1 && /只能由 AgentForge 客户端启动/.test(error.stderr));
});

test("owned service binds only its random loopback origin and exits with the owner", async t => {
  const {fork}=await import('node:child_process');
  const {randomBytes}=await import('node:crypto');
  const root=await mkdtemp(join(tmpdir(),'af-owned-service-'));
  const child=fork(new URL('../server/index.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,HOME:root,HOST:'0.0.0.0',PORT:'4310',AGENTFORGE_PUBLIC_ORIGIN:'https://unused.invalid',AGENTFORGE_DESKTOP_PORT:'0',AGENTFORGE_BOOTSTRAP_TOKEN:randomBytes(32).toString('hex'),AGENTFORGE_DB_PATH:join(root,'state.sqlite'),AGENTFORGE_AUTH_DB_PATH:join(root,'auth.sqlite'),AGENTFORGE_RUN_FILES_ROOT:join(root,'runs'),AGENTFORGE_RUNTIME_CONFIG_ROOT:join(root,'runtime'),AGENTFORGE_WORKSPACE_ROOT:join(root,'work') }});
  t.after(()=>{child.kill();return rm(root,{recursive:true,force:true});});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('owned startup timeout')),30000);child.once('message',value=>{clearTimeout(timer);resolve(value)});child.once('exit',code=>{clearTimeout(timer);reject(Error('unexpected exit '+code))});});
  const origin='http://127.0.0.1:'+ready.port;
  assert.equal(ready.type,'agentforge-ready');assert.ok(ready.port>0);
  assert.equal((await fetch(origin+'/api/health')).status,200);
  assert.match(await (await fetch(origin+'/login')).text(),/agentforge-desktop-style/);
  const rejected=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:'https://unused.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(rejected.status,403);
  const exited=new Promise(resolve=>child.once('exit',resolve));child.disconnect();
  assert.equal(await exited,143);
});

test("omitted origins allow offline setup but deny every HTTP host", async t => {
  const root=await mkdtemp(join(tmpdir(),'af-deny-origin-'));
  const auth=createAuth({databasePath:join(root,'auth.sqlite')});
  const server=createServer((req,res)=>{void auth.guard(req,res,new URL(req.url,'http://localhost'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));auth.close();await rm(root,{recursive:true,force:true});});
  await auth.setAdministrator('fixture-admin','Disposable-only-setup-519');
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/auth/session');
  assert.equal(response.status,403);
});

test("authentication gates real HTTP, persists revocable sessions and never stores passwords/tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentforge-auth-test-")), databasePath = join(root, "auth.sqlite");
  let clock = Date.now(), auth;
  const server = createServer(async (req, res) => {
    try { if (await auth.guard(req, res, new URL(req.url, "http://localhost"))) return; res.writeHead(200); res.end("protected-resource"); }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  auth = createAuth({ databasePath, origins:[origin], now:() => clock });
  const get = (path, cookie) => fetch(origin + path, { redirect:"manual", headers: cookie ? { Cookie:cookie } : {} });
  const post = (path, body, cookie, requestOrigin = origin) => fetch(origin + path, { method:"POST", headers:{"Content-Type":"application/json", Origin:requestOrigin, ...(cookie ? {Cookie:cookie} : {})}, body:JSON.stringify(body) });
  const password = "Test-only-not-production-1937";
  try {
    for (const path of ["/", "/tasks", "/runs/example", "/manual/data-model", "/app.js", "/login.html"]) {
      const res = await get(path); assert.equal(res.status, 303); assert.ok(res.headers.get("location").startsWith("/login?next="));
    }
    for (const path of ["/api/bootstrap", "/api/runs/example/events", "/api/runs/example/artifacts/a/raw", "/api/auth/session"]) assert.equal((await get(path)).status, 401);
    assert.equal((await get("/login")).status, 200);
    assert.equal((await get("/api/health")).status, 200);
    assert.deepEqual(await (await get("/api/auth/bootstrap-status")).json(), { available: false, configured: false });
    const unconfigured = await post("/api/auth/login", {username:"admin",password});
    assert.equal(unconfigured.status, 503);
    const setupMessage=(await unconfigured.json()).error;
    assert.match(setupMessage, /客户端.*重新连接.*首次设置/);
    assert.doesNotMatch(setupMessage,/项目目录|auth:setup/);
    await assert.rejects(auth.setAdministrator("admin", "short"));
    await auth.setAdministrator("admin", password);
    assert.deepEqual(await (await get("/api/auth/bootstrap-status")).json(), { available: false, configured: true });
    assert.equal((await post("/api/auth/login", {username:"other",password})).status, 401);
    assert.equal((await post("/api/auth/login", {username:"admin",password:"incorrect"})).status, 401);
    assert.equal((await post("/api/auth/login", {username:"admin",password}, null, "https://evil.example")).status, 403);
    const login = await post("/api/auth/login", {username:"admin",password});
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=34560000/);
    assert.equal((await get("/api/bootstrap",cookie)).status, 200);
    assert.equal((await get("/api/bootstrap", "agentforge_session=invalid")).status, 401);
    const invalidHostStatus = await new Promise((resolve, reject) => {
      const request = httpRequest(origin + "/api/bootstrap", {headers:{Host:"evil.example",Cookie:cookie}}, response => { response.resume(); resolve(response.statusCode); });
      request.on("error",reject); request.end();
    });
    assert.equal(invalidHostStatus, 403);
    assert.equal((await fetch(origin + "/api/tasks", {method:"POST",headers:{Cookie:cookie,"Content-Type":"application/json"},body:"{}"})).status, 403);
    assert.equal((await post("/api/tasks", {}, cookie, "https://evil.example")).status, 403);
    assert.equal((await post("/api/tasks", {}, cookie)).status, 200);
    const stored = new DatabaseSync(databasePath);
    assert.notEqual(stored.prepare("SELECT password_hash FROM administrator").get().password_hash, password);
    assert.notEqual(stored.prepare("SELECT token_hash FROM sessions").get().token_hash, cookie.split("=")[1]);
    stored.close();
    auth.close(); auth = createAuth({databasePath,origins:[origin],now:() => clock});
    const before = await (await get("/api/auth/session",cookie)).json();
    clock += 60000;
    assert.equal((await (await get("/api/auth/session",cookie)).json()).expiresAt, before.expiresAt);
    assert.equal((await post("/api/auth/logout", {}, cookie)).status, 200);
    assert.equal((await get("/api/bootstrap",cookie)).status, 401);
    const login2 = await post("/api/auth/login",{username:"admin",password});
    const cookie2 = login2.headers.get("set-cookie").split(";")[0];
    clock += 10*365*24*60*60*1000;
    auth.close(); auth = createAuth({databasePath,origins:[origin],now:() => clock});
    const persistent = await get("/api/auth/session",cookie2);
    assert.equal(persistent.status, 200);
    assert.equal((await persistent.json()).expiresAt, null);
    assert.match(persistent.headers.get("set-cookie"), /Max-Age=34560000/);
    const login3 = await post("/api/auth/login",{username:"admin",password});
    const cookie3 = login3.headers.get("set-cookie").split(";")[0];
    await auth.setAdministrator("admin",password + "reset");
    assert.equal((await get("/api/bootstrap",cookie3)).status, 401);
    for(let i=0;i<10;i++) assert.equal((await post("/api/auth/login",{username:"admin",password:"bad"})).status,401);
    auth.close(); auth = createAuth({databasePath,origins:[origin],now:() => clock});
    assert.equal((await post("/api/auth/login",{username:"admin",password:password+"reset"})).status,429);
    clock += 15*60*1000;
    assert.equal((await post("/api/auth/login",{username:"admin",password:password+"reset"})).status,200);
  } finally { await new Promise(resolve => server.close(resolve)); auth.close(); await rm(root,{recursive:true,force:true}); }
});

test("reset setup requires password reauthentication and grants only the requesting browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-reset-auth-")), databasePath = join(root, "auth.sqlite");
  let auth, clock = Date.now();
  const server = createServer(async (request, response) => {
    try {
      if (await auth.guard(request, response, new URL(request.url, "http://localhost"))) return;
      if (request.url === "/api/test-reset") {
        let body = ""; for await (const chunk of request) body += chunk;
        await auth.reauthenticate(request, JSON.parse(body).password);
        auth.close(); await rm(databasePath);
        auth = createAuth({ databasePath, origins: [origin], now: () => clock });
        auth.establishResetSetup(response, origin);
      }
      response.writeHead(200); response.end("ok");
    } catch (error) { response.writeHead(400); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  auth = createAuth({ databasePath, origins: [origin], now: () => clock });
  const post = (path, body, cookie = "") => fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  const get = (path, cookie = "") => fetch(origin + path, { headers: { Cookie: cookie }, redirect: "manual" });
  const password = "Disposable-reset-auth-7391";
  try {
    await auth.setAdministrator("fixture", password);
    assert.throws(() => auth.establishResetSetup({ setHeader() {} }, origin), /无法创建/);
    const login = await post("/api/auth/login", { username: "fixture", password });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await post("/api/test-reset", { password })).status, 401);
    assert.equal((await post("/api/test-reset", { password: "wrong" }, cookie)).status, 400);
    assert.equal(auth.configured(), true);
    const cleared = await post("/api/test-reset", { password }, cookie);
    assert.equal(cleared.status, 200);
    const setupCookie = cleared.headers.getSetCookie().find(value => value.startsWith("agentforge_bootstrap=")).split(";")[0];
    assert.equal((await get("/api/bootstrap", cookie)).status, 401);
    assert.equal((await get("/setup.html")).status, 404);
    assert.equal((await get("/setup.html", setupCookie)).status, 200);
    clock += 10 * 60 * 1000;
    assert.equal((await get("/setup.html", setupCookie)).status, 404);
    assert.equal(auth.configured(), false);
  } finally { await new Promise(resolve => server.close(resolve)); auth.close(); await rm(root, { recursive: true, force: true }); }
});

test("desktop bootstrap can create exactly one initial local administrator", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentforge-auth-bootstrap-")), databasePath = join(root, "auth.sqlite"), secret = "a".repeat(64);
  let auth;
  const server = createServer(async (req, res) => {
    try { if (await auth.guard(req, res, new URL(req.url, "http://localhost"))) return; res.writeHead(200); res.end("bootstrap-page"); }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = {}) => fetch(origin + path, { redirect: "manual", headers });
  const post = (path, body, headers = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(body) });
  try {
    auth = createAuth({ databasePath, origins: [origin], bootstrapToken: secret });
    const status = await get("/api/auth/bootstrap-status");
    assert.deepEqual(await status.json(), { available: true, configured: false });
    assert.equal(await (await get("/setup")).status, 404);
    assert.equal(await (await get("/setup", { "X-AgentForge-Bootstrap": "b".repeat(64) })).status, 404);
    const handoff = await get("/setup", { "X-AgentForge-Bootstrap": secret });
    assert.equal(handoff.status, 303);
    assert.equal(handoff.headers.get("location"), "/setup.html");
    const bootstrapCookie = handoff.headers.get("set-cookie").match(/agentforge_bootstrap=[a-f0-9]{64}/)[0];
    assert.notEqual(bootstrapCookie.split("=")[1], secret, "the Electron handoff secret must never be persisted as a browser cookie");
    assert.doesNotMatch(handoff.headers.get("set-cookie"), new RegExp(secret));
    assert.equal(await (await get("/setup.html", { Cookie: bootstrapCookie })).status, 200);
    assert.equal(await (await post("/api/auth/bootstrap", { username: "first-admin", password: "Bootstrap-password-1937" })).status, 404);
    assert.equal(await (await post("/api/auth/bootstrap", { username: "first-admin", password: "short" }, { Cookie: bootstrapCookie })).status, 400);
    const created = await post("/api/auth/bootstrap", { username: "first-admin", password: "Bootstrap-password-1937" }, { Cookie: bootstrapCookie });
    assert.equal(created.status, 201);
    const sessionCookie = created.headers.get("set-cookie").match(/agentforge_session=[a-f0-9]{64}/)[0];
    assert.ok(created.headers.get("set-cookie").includes("agentforge_bootstrap=;"));
    assert.equal((await get("/api/bootstrap", { Cookie: sessionCookie })).status, 200);
    assert.deepEqual(await (await get("/api/auth/bootstrap-status")).json(), { available: false, configured: true });
    assert.equal(await (await get("/setup", { "X-AgentForge-Bootstrap": secret })).status, 404);
    assert.equal(await (await post("/api/auth/bootstrap", { username: "attacker", password: "Bootstrap-password-1937" }, { Cookie: bootstrapCookie })).status, 404);
    const login = await post("/api/auth/login", { username: "first-admin", password: "Bootstrap-password-1937" });
    assert.equal(login.status, 200);
    const db = new DatabaseSync(databasePath);
    assert.equal(db.prepare("SELECT username FROM administrator").get().username, "first-admin");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM administrator").get().count, 1);
    db.close();
  } finally { await new Promise(resolve => server.close(resolve)); auth?.close(); await rm(root, { recursive: true, force: true }); }
});

test("HTTP authentication precedes business routes and active content is sandboxed", async () => {
  const source = await readFile(new URL("../server/index.mjs",import.meta.url),"utf8");
  const handler = source.slice(source.indexOf("const server = createServer"));
  assert.ok(handler.indexOf("auth.guard") < handler.indexOf("routeApi"));
  assert.ok(source.includes("auth.session(request)"));
  assert.ok(!source.includes('"Access-Control-Allow-Origin": "*"'));
  const raw = source.slice(source.indexOf("const artifactRawMatch"), source.indexOf("const artifactRawMatch") + 1000);
  assert.match(raw, /Content-Security-Policy/);
  assert.match(await readFile(new URL("../web/login.js",import.meta.url),"utf8"), /password.value = ""/);
  const setup = await readFile(new URL("../web/setup.js", import.meta.url), "utf8");
  assert.match(setup, /password\.value = ""/);
  assert.match(setup, /confirmation\.value = ""/);
});

test("remote configuration requires exact HTTPS origins and sets Secure cookies", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentforge-auth-secure-")), databasePath = join(root,"auth.sqlite");
  let auth;
  try {
    for (const origin of ["http://example.com", "https://example.com/path", "https://user:password@example.com"]) assert.throws(() => createAuth({databasePath,origins:[origin]}));
    auth = createAuth({databasePath,origins:["https://example.com", "http://127.0.0.1:4310", "http://localhost:4310"]});
    const password = "Secure-test-only-1937";
    await auth.setAdministrator("admin",password);
    const headers = {};
    const request = {method:"POST",headers:{host:"example.com",origin:"https://example.com","content-type":"application/json"},socket:{remoteAddress:"127.0.0.1"},async *[Symbol.asyncIterator]() {yield JSON.stringify({username:"admin",password});}};
    const response = {setHeader:(k,v)=>headers[k]=v,writeHead:status=>assert.equal(status,200),end:()=>{}};
    await auth.guard(request,response,new URL("https://example.com/api/auth/login"));
    assert.match(headers["Set-Cookie"], /; Secure$/);
    for (const host of ["127.0.0.1:4310", "localhost:4310"]) {
      request.headers.host = host; request.headers.origin = `http://${host}`;
      await auth.guard(request,response,new URL(`http://${host}/api/auth/login`));
      assert.doesNotMatch(headers["Set-Cookie"], /; Secure/);
      assert.match(headers["Set-Cookie"], /HttpOnly; SameSite=Strict/);
      request.headers.cookie = headers["Set-Cookie"].split(";")[0];
      assert.ok(auth.session(request));
      await auth.guard(request,response,new URL(`http://${host}/api/auth/logout`));
      assert.equal(auth.session(request), null);
      assert.match(headers["Set-Cookie"], /Max-Age=0/);
    }
    request.headers.host = "example.com"; request.headers.origin = "http://127.0.0.1:4310";
    await auth.guard(request,{...response,writeHead:status=>assert.equal(status,403)},new URL("https://example.com/api/auth/login"));
    request.headers.origin = "https://attacker.example";
    await auth.guard(request,{...response,writeHead:status=>assert.equal(status,403)},new URL("https://example.com/api/auth/login"));
  } finally { auth?.close(); await rm(root,{recursive:true,force:true}); }
});
