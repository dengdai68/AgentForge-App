// Isolated real-service E2E for the Runtime model catalog + effort feature.
// Forks the real server as a desktop-style child (dynamic loopback port,
// bootstrap token), creates the first admin through the real bootstrap flow,
// then exercises the new endpoints over real HTTP and the real CLI.
// Never touches the operator's 4310 instance or default data/session files.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const root = await mkdtemp(join(tmpdir(), "af-model-e2e-"));
const dataRoot = join(root, "data");
await mkdir(dataRoot, { recursive: true });
const bootstrapToken = randomBytes(32).toString("hex");
const password = "e2e-password-12345";

const child = spawn(process.execPath, ["server/index.mjs"], {
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  env: {
    ...process.env,
    AGENTFORGE_DESKTOP_PORT: "0",
    AGENTFORGE_BOOTSTRAP_TOKEN: bootstrapToken,
    AGENTFORGE_DB_PATH: join(dataRoot, "agentforge.sqlite"),
    AGENTFORGE_AUTH_DB_PATH: join(dataRoot, "auth.sqlite"),
    AGENTFORGE_RUN_FILES_ROOT: join(dataRoot, "runs"),
    AGENTFORGE_RUNTIME_CONFIG_ROOT: join(dataRoot, "runtime-configs"),
    AGENTFORGE_WORKSPACE_ROOT: join(dataRoot, "workspaces"),
    AGENTFORGE_LOG_DIR: join(dataRoot, "logs")
  }
});
child.stderr.on("data", chunk => process.stderr.write(`[server] ${chunk}`));
const ready = await new Promise((resolve, reject) => {
  child.once("message", resolve);
  child.once("exit", code => reject(new Error(`server exited ${code}`)));
  setTimeout(() => reject(new Error("server start timeout")), 30000);
});
const origin = `http://127.0.0.1:${ready.port}`;
console.log("isolated server:", origin, "instance", ready.instanceId);

const fail = (message) => { throw new Error(`E2E FAIL: ${message}`); };
let cookie = "";
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method, redirect: "error",
    headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: response.status, body: await response.json().catch(() => null) };
}

// 1. Unauthenticated catalog access is refused.
const anon = await fetch(`${origin}/api/settings/runtime-profiles/models?provider=codex`, { headers: { Origin: origin } });
if (anon.status !== 401) fail(`anonymous models query must be 401, got ${anon.status}`);
console.log("PASS unauthenticated models query refused (401)");

// 2. Real bootstrap setup flow: GET /setup with the token header issues the
// bootstrap cookie; POST /api/auth/bootstrap creates the admin + session.
const setup = await fetch(`${origin}/setup`, { headers: { "X-AgentForge-Bootstrap": bootstrapToken }, redirect: "manual" });
if (setup.status !== 303) fail(`setup redirect expected, got ${setup.status}`);
cookie = setup.headers.get("set-cookie").split(",")[0].split(";")[0];
const boot = await api("/api/auth/bootstrap", { method: "POST", body: { username: "e2e", password } });
if (boot.status !== 201) fail(`bootstrap failed: ${JSON.stringify(boot.body)}`);
console.log("PASS real bootstrap admin setup");

// 3. Real model catalogs through HTTP.
const claudeCatalog = await api("/api/settings/runtime-profiles/models?provider=claude-code");
if (claudeCatalog.status !== 200 || !claudeCatalog.body.models?.length) fail(`claude catalog: ${JSON.stringify(claudeCatalog.body)}`);
if (!claudeCatalog.body.models.some(m => m.id === "sonnet")) fail("claude catalog misses documented alias sonnet");
if (JSON.stringify(claudeCatalog.body).match(/AUTH_TOKEN":\s*"|sk-/)) fail("credential material in claude catalog");
console.log(`PASS claude catalog over HTTP: ${claudeCatalog.body.models.length} models, source: ${claudeCatalog.body.source}`);

const codexCatalog = await api("/api/settings/runtime-profiles/models?provider=codex");
if (codexCatalog.status !== 200 || !codexCatalog.body.models?.length) fail(`codex catalog: ${JSON.stringify(codexCatalog.body)}`);
if (!codexCatalog.body.models.every(m => Array.isArray(m.levels))) fail("codex models must carry per-model effort levels");
if (JSON.stringify(codexCatalog.body).includes("persistent_instructions")) fail("codex catalog leaks model_messages internals");
console.log(`PASS codex catalog over HTTP: ${codexCatalog.body.models.length} models, source: ${codexCatalog.body.source}`);

const badProvider = await api("/api/settings/runtime-profiles/models?provider=other");
if (badProvider.status !== 400) fail("invalid provider must be 400");
const controlCharPath = await api(`/api/settings/runtime-profiles/models?provider=codex&executable=${encodeURIComponent("bad\npath")}`);
if (controlCharPath.status !== 400 || !/路径格式无效/.test(controlCharPath.body?.error || "")) fail("control characters in CLI path must be 400");
const missingCli = await api("/api/settings/runtime-profiles/models?provider=codex&executable=/nonexistent/codex");
if (missingCli.status !== 400 || !/模型目录查询失败/.test(missingCli.body?.error || "")) fail(`missing CLI must fail honestly: ${JSON.stringify(missingCli.body)}`);
console.log("PASS catalog validation and honest failure over HTTP");

// PR review fix: CLI paths with spaces/non-ASCII are legitimate (execFile has
// no shell); the catalog endpoint must accept and actually use them.
const spacedDir = join(root, "Library 中文", "bin");
await mkdir(spacedDir, { recursive: true });
const spacedCodex = join(spacedDir, "codex");
await writeFile(spacedCodex, `#!/usr/bin/env node\nconsole.log('{"models":[{"slug":"spaced-model","display_name":"Spaced","description":"","visibility":"list","supported_in_api":true,"default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low","description":"x"}]}]}');\n`, { mode: 0o755 });
const spacedCatalog = await api(`/api/settings/runtime-profiles/models?provider=codex&executable=${encodeURIComponent(spacedCodex)}`);
if (spacedCatalog.status !== 200 || spacedCatalog.body.models?.[0]?.id !== "spaced-model") fail(`spaced/non-ASCII CLI path catalog: ${JSON.stringify(spacedCatalog.body)}`);
console.log("PASS catalog query works for CLI paths containing spaces and non-ASCII characters");

// 4. Save/readback profiles with effort; invalid effort rejected.
const saved = await api("/api/settings/runtime-profiles", { method: "POST", body: { name: "E2E Claude effort", provider: "claude-code", model: "sonnet", executable: "", profile: "", effort: "high" } });
if (saved.status !== 201 || saved.body.effort !== "high" || saved.body.model !== "sonnet") fail(`save: ${JSON.stringify(saved.body)}`);
const invalid = await api("/api/settings/runtime-profiles", { method: "POST", body: { name: "E2E bad", provider: "claude-code", model: "", executable: "", profile: "", effort: "ultra" } });
if (invalid.status !== 400 || !/思考等级/.test(invalid.body?.error || "")) fail("claude ultra must be rejected");
const codexSaved = await api("/api/settings/runtime-profiles", { method: "POST", body: { name: "E2E Codex effort", provider: "codex", model: codexCatalog.body.models[0].id, executable: "", profile: "", effort: "ultra" } });
if (codexSaved.status !== 201 || codexSaved.body.effort !== "ultra") fail(`codex save: ${JSON.stringify(codexSaved.body)}`);
const listed = await api("/api/settings/runtime-profiles");
const found = listed.body.profiles.find(p => p.id === saved.body.id);
if (!found || found.effort !== "high") fail("readback must preserve effort");
console.log("PASS save/readback with effort; invalid effort rejected");

// QA-RT-02 regression: a model known to the real catalog rejects effort levels
// it does not advertise; manual models keep unknown capability and are allowed.
const limited = codexCatalog.body.models.find(m => m.levels.length && !m.levels.some(l => l.id === "ultra"));
if (limited) {
  const rejected = await api("/api/settings/runtime-profiles", { method: "POST", body: { name: "E2E unsupported effort", provider: "codex", model: limited.id, executable: "", profile: "", effort: "ultra" } });
  if (rejected.status !== 400 || !/不支持思考等级/.test(rejected.body?.error || "")) fail(`known model must reject unadvertised effort: ${JSON.stringify(rejected.body)}`);
  console.log(`PASS known model ${limited.id} rejects unadvertised effort ultra (supports ${limited.levels.map(l => l.id).join("/")})`);
} else console.log("NOTE every listed codex model advertises ultra; per-model rejection covered by unit tests");
const manual = await api("/api/settings/runtime-profiles", { method: "POST", body: { name: "E2E manual model", provider: "codex", model: "manual-unknown-model", executable: "", profile: "", effort: "max" } });
if (manual.status !== 201) fail(`manual model must stay saveable (unknown capability): ${JSON.stringify(manual.body)}`);
await api(`/api/settings/runtime-profiles/${manual.body.id}`, { method: "DELETE", body: {} });
console.log("PASS manual model with in-vocabulary effort remains saveable");

// 5. Real CLI against this isolated instance via a private desktop endpoint file.
const cliDir = join(root, "cli-private");
await mkdir(cliDir, { mode: 0o700 });
const endpointFile = join(cliDir, "endpoint.json");
await writeFile(endpointFile, JSON.stringify({ origin, instanceId: ready.instanceId }), { mode: 0o600 });
const sessionFile = join(cliDir, "session.json");
async function cli(args, stdinText) {
  const result = await new Promise((resolve, reject) => {
    const run = spawn(process.execPath, ["cli/main.mjs", ...args, "--endpoint-file", endpointFile, "--session-file", sessionFile, "--json"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    run.stdout.on("data", c => { stdout += c; });
    run.stderr.on("data", c => { stderr += c; });
    run.once("error", reject);
    run.once("close", code => resolve({ code, stdout, stderr }));
    run.stdin.end(stdinText ?? "");
  });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
const login = await cli(["auth", "login", "--username", "e2e", "--password-stdin"], password + "\n");
if (login.code !== 0 || !login.json?.ok) fail(`CLI login: ${login.stderr}`);
const cliModels = await cli(["runtimes", "models", "codex"]);
if (cliModels.code !== 0 || cliModels.json.data.models[0].id !== codexCatalog.body.models[0].id) fail(`CLI models: ${cliModels.stdout} ${cliModels.stderr}`);
console.log("PASS CLI runtimes models codex against real service:", cliModels.json.data.models.length, "models");
const cliClaude = await cli(["runtimes", "models", "claude-code"]);
if (cliClaude.code !== 0 || !cliClaude.json.data.models.some(m => m.id === "opusplan")) fail("CLI claude catalog");
console.log("PASS CLI runtimes models claude-code against real service");
const cliList = await cli(["runtimes", "list"]);
const row = cliList.json.data.items.find(i => i.id === saved.body.id);
if (!row || row.effort !== "high") fail("CLI list must show effort");
console.log("PASS CLI list/get readback includes effort");

// 6. Real connection test over HTTP using the saved model+effort (real model call).
const probe = await api(`/api/settings/runtime-profiles/${saved.body.id}/test`, { method: "POST", body: {} });
if (probe.status !== 200 || probe.body.ok !== true) fail(`real claude probe with model+effort: ${JSON.stringify(probe.body)}`);
console.log(`PASS real Claude connection test with model=sonnet effort=high (${(probe.body.durationMs / 1000).toFixed(1)}s)`);
const codexProbe = await api(`/api/settings/runtime-profiles/${codexSaved.body.id}/test`, { method: "POST", body: {} });
if (codexProbe.status !== 200 || codexProbe.body.ok !== true) fail(`real codex probe with model+effort: ${JSON.stringify(codexProbe.body)}`);
console.log(`PASS real Codex connection test with model=${codexSaved.body.model} effort=ultra (${(codexProbe.body.durationMs / 1000).toFixed(1)}s)`);

child.kill("SIGTERM");
await new Promise(resolve => child.once("exit", resolve));
console.log("ALL MODEL/EFFORT E2E PASS; evidence root:", root);
