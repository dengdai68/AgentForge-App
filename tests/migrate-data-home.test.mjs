import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/migrate-data-home.mjs", import.meta.url));
const run = (args) => promisify(execFile)(process.execPath, [script, ...args]);
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "af-migrate-test-"));
  const home = join(root, "home"), legacy = join(root, "legacy-userData");
  await mkdir(home, { mode: 0o700 });
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  return { root, home, legacy, target: join(home, ".agentforge", "desktop") };
}
async function seedLegacy(legacy) {
  await writeFile(join(legacy, "agentforge.sqlite"), "metadata-database");
  await writeFile(join(legacy, "agentforge.sqlite-wal"), "wal-bytes");
  await writeFile(join(legacy, "auth.sqlite"), "auth-database");
  await writeFile(join(legacy, "desktop-preferences.json"), JSON.stringify({ closeMode: "tray" }));
  await mkdir(join(legacy, "agentforge-runs", "run_one"), { recursive: true });
  await writeFile(join(legacy, "agentforge-runs", "run_one", "trace.jsonl"), "trace-line\n");
  await mkdir(join(legacy, "runtime-configs", "mcp"), { recursive: true });
  await writeFile(join(legacy, "runtime-configs", "mcp", "private.json"), "{}");
  // Chromium-managed files must never be touched.
  await mkdir(join(legacy, "Cache"));
  await writeFile(join(legacy, "Cache", "chromium"), "cache");
  await writeFile(join(legacy, "Local State"), "chromium");
  // Frozen task workspaces stay behind as well.
  await mkdir(join(legacy, "workspaces", "task_one"), { recursive: true });
}

test("dry-run plans the whitelist copy without changing either side", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  const { stdout } = await run(["--home", home, "--user-data", legacy, "--only", "desktop"]);
  assert.match(stdout, /演练/);
  assert.match(stdout, /agentforge\.sqlite/);
  assert.match(stdout, /agentforge-runs/);
  assert.equal(await readFile(join(legacy, "agentforge.sqlite"), "utf8"), "metadata-database");
  await assert.rejects(lstat(target), { code: "ENOENT" });
  await assert.rejects(lstat(join(home, ".agentforge", "web", "agentforge.sqlite")), { code: "ENOENT" });
});

test("migration copies with SHA-256 verification, renames legacy entries to backups and is idempotent", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  const { stdout } = await run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]);
  assert.match(stdout, /已复制并校验/);
  assert.equal(await sha256(join(target, "agentforge.sqlite")), await sha256(join(legacy, await backupName(legacy, "agentforge.sqlite"))));
  assert.equal(await readFile(join(target, "runtime-configs", "mcp", "private.json"), "utf8"), "{}");
  assert.equal(await readFile(join(target, "agentforge-runs", "run_one", "trace.jsonl"), "utf8"), "trace-line\n");
  assert.equal((await lstat(target)).mode & 0o777, 0o700);
  await assert.rejects(lstat(join(legacy, "agentforge.sqlite")), { code: "ENOENT" });
  await assert.rejects(lstat(join(legacy, "auth.sqlite")), { code: "ENOENT" });
  // Chromium files and frozen workspaces are never migrated or renamed.
  assert.equal(await readFile(join(legacy, "Cache", "chromium"), "utf8"), "cache");
  assert.ok((await lstat(join(legacy, "workspaces", "task_one"))).isDirectory());
  // Second run: nothing left to migrate, exit 0 without touching the target.
  const again = await run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]);
  assert.match(again.stdout, /旧位置无应用数据/);
  assert.equal(await readFile(join(target, "agentforge.sqlite"), "utf8"), "metadata-database");
});

async function backupName(root, name) {
  const match = (await readdir(root)).find(entry => entry.startsWith(`${name}.migrated-backup-`));
  assert.ok(match, `expected a renamed backup for ${name}`);
  return match;
}

test("a different pre-existing target database aborts without touching either side", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "agentforge.sqlite"), "different-instance");
  await assert.rejects(run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]),
    (error) => error.code === 1 && /已存在且内容不一致/.test(error.stderr));
  assert.equal(await readFile(join(legacy, "agentforge.sqlite"), "utf8"), "metadata-database");
  assert.equal(await readFile(join(target, "agentforge.sqlite"), "utf8"), "different-instance");
});

test("an identical pre-existing target entry resumes safely instead of aborting", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "agentforge.sqlite"), "metadata-database");
  const { stdout } = await run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]);
  assert.match(stdout, /已存在且一致/);
  assert.equal(await readFile(join(target, "auth.sqlite"), "utf8"), "auth-database");
  await assert.rejects(lstat(join(legacy, "auth.sqlite")), { code: "ENOENT" });
});

test("symbolic links in the source are rejected before any copy", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  await rm(join(legacy, "agentforge.sqlite"));
  await symlink("/etc/passwd", join(legacy, "agentforge.sqlite"));
  await assert.rejects(run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]),
    (error) => error.code === 1 && /符号链接/.test(error.stderr));
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.equal(await readFile(join(legacy, "auth.sqlite"), "utf8"), "auth-database");
});

test("a nested symbolic link inside an existing target directory is rejected, never reused", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  await mkdir(join(target, "agentforge-runs"), { recursive: true });
  // The link target has byte-identical content to the source entry; the
  // migration must still refuse instead of keeping a symlink in the data home.
  await writeFile(join(root, "outside"), "trace-line\n");
  await symlink(join(root, "outside"), join(target, "agentforge-runs", "trace.jsonl"));
  await assert.rejects(run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]),
    (error) => error.code === 1 && /符号链接/.test(error.stderr));
  assert.equal(await readFile(join(legacy, "agentforge.sqlite"), "utf8"), "metadata-database");
  assert.ok((await lstat(join(legacy, "agentforge-runs"))).isDirectory(), "legacy source is not renamed");
  assert.ok((await lstat(join(target, "agentforge-runs", "trace.jsonl"))).isSymbolicLink(), "target left untouched");
});

test("a target type mismatch is rejected with a clear error", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "agentforge-runs"), "not-a-directory");
  await assert.rejects(run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]),
    (error) => error.code === 1 && /类型不符/.test(error.stderr));
  assert.equal(await readFile(join(legacy, "agentforge.sqlite"), "utf8"), "metadata-database");
  assert.equal(await readFile(join(target, "agentforge-runs"), "utf8"), "not-a-directory");
});

test("a live desktop instance refuses migration and keeps legacy data untouched", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  const instanceId = "11111111-2222-4333-8444-555555555555";
  const server = createServer((request, response) => {
    if (request.url === "/api/health") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ service: "agentforge-control-plane", instanceId })); }
    else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(join(legacy, "desktop-endpoint.json"), JSON.stringify({ origin, instanceId }), { mode: 0o600 });
  await assert.rejects(run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]),
    (error) => error.code === 1 && /仍在运行/.test(error.stderr));
  assert.equal(await readFile(join(legacy, "agentforge.sqlite"), "utf8"), "metadata-database");
  await assert.rejects(lstat(target), { code: "ENOENT" });
});

test("a stale endpoint file does not block migration and is copied with the whitelist", async (t) => {
  const { root, home, legacy, target } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedLegacy(legacy);
  await writeFile(join(legacy, "desktop-endpoint.json"), JSON.stringify({ origin: "http://127.0.0.1:9", instanceId: "11111111-2222-4333-8444-555555555555" }), { mode: 0o600 });
  await run(["--home", home, "--user-data", legacy, "--only", "desktop", "--yes"]);
  assert.equal(JSON.parse(await readFile(join(target, "desktop-endpoint.json"), "utf8")).instanceId, "11111111-2222-4333-8444-555555555555");
  assert.ok(await backupName(legacy, "desktop-endpoint.json"));
});

test("the packaged userData legacy root follows platform conventions", async () => {
  const { packagedUserDataRoot } = await import("../scripts/migrate-data-home.mjs");
  assert.equal(packagedUserDataRoot({ home: "/h", platform: "darwin" }), "/h/Library/Application Support/AgentForge");
  assert.equal(packagedUserDataRoot({ home: "/h", platform: "win32", env: { APPDATA: "/roaming" } }), "/roaming/AgentForge");
  assert.equal(packagedUserDataRoot({ home: "/h", platform: "linux", env: {} }), "/h/.config/AgentForge");
});
