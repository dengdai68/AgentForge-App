import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentforgeDataHome, legacyDataRequiresMigration, migrationGuidance, standaloneDataRoot, standaloneStoragePaths } from "../server/data-home.mjs";

test("standalone storage defaults isolate the Web instance under ~/.agentforge/web", () => {
  const home = "/fixture-home";
  assert.equal(agentforgeDataHome(home), "/fixture-home/.agentforge");
  assert.equal(standaloneDataRoot(home), "/fixture-home/.agentforge/web");
  const storage = standaloneStoragePaths({ home, env: {} });
  assert.equal(storage.databasePath, "/fixture-home/.agentforge/web/agentforge.sqlite");
  assert.equal(storage.authDatabasePath, "/fixture-home/.agentforge/web/auth.sqlite");
  assert.equal(storage.runFilesRoot, "/fixture-home/.agentforge/web/agentforge-runs");
  assert.equal(storage.runtimeConfigRoot, "/fixture-home/.agentforge/web/runtime-configs");
  assert.equal(storage.workspaceRoot, "/fixture-home/agentforge");
});

test("explicit environment overrides always win over the new defaults", () => {
  const env = {
    AGENTFORGE_DB_PATH: "/override/state.sqlite",
    AGENTFORGE_AUTH_DB_PATH: "/override/auth.sqlite",
    AGENTFORGE_RUN_FILES_ROOT: "/override/runs",
    AGENTFORGE_RUNTIME_CONFIG_ROOT: "/override/runtime",
    AGENTFORGE_WORKSPACE_ROOT: "/override/workspaces"
  };
  const storage = standaloneStoragePaths({ home: "/fixture-home", env });
  assert.equal(storage.databasePath, "/override/state.sqlite");
  assert.equal(storage.authDatabasePath, "/override/auth.sqlite");
  assert.equal(storage.runFilesRoot, "/override/runs");
  assert.equal(storage.runtimeConfigRoot, "/override/runtime");
  assert.equal(storage.workspaceRoot, "/override/workspaces");
});

test("legacy data detection blocks only a real legacy instance with an empty new location", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-data-home-"));
  const legacy = join(root, "legacy"), current = join(root, "new", "agentforge.sqlite");
  await mkdir(legacy, { recursive: true });
  assert.equal(await legacyDataRequiresMigration({ legacyRoot: legacy, currentDatabasePath: current }), false, "empty legacy root never blocks");
  await writeFile(join(legacy, "agentforge.sqlite"), "metadata");
  assert.equal(await legacyDataRequiresMigration({ legacyRoot: legacy, currentDatabasePath: current }), true, "legacy database with empty new location blocks startup");
  await mkdir(join(root, "new"), { recursive: true });
  await writeFile(current, "fresh");
  assert.equal(await legacyDataRequiresMigration({ legacyRoot: legacy, currentDatabasePath: current }), false, "an existing new database means the instance already moved");
});

test("legacy detection also blocks on an authentication-only legacy instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-data-home-auth-"));
  await writeFile(join(root, "auth.sqlite"), "auth");
  assert.equal(await legacyDataRequiresMigration({ legacyRoot: root, currentDatabasePath: join(root, "new", "agentforge.sqlite") }), true);
});

test("migration guidance names both locations and the one-time script without deleting anything", () => {
  const text = migrationGuidance({ legacyRoot: "/legacy", targetRoot: "/new", command: "node scripts/migrate-data-home.mjs --yes" });
  assert.match(text, /\/legacy/);
  assert.match(text, /\/new/);
  assert.match(text, /migrate-data-home\.mjs --yes/);
  assert.match(text, /绝不删除|不会被删除/);
});

test("auth-setup shares the standalone storage defaults and the legacy refusal", async () => {
  const source = await readFile(new URL("../scripts/auth-setup.mjs", import.meta.url), "utf8");
  assert.match(source, /standaloneStoragePaths/, "auth-setup must resolve the same ~/.agentforge/web defaults as the service");
  assert.match(source, /legacyDataRequiresMigration/, "auth-setup must refuse to seed a fresh admin over unmigrated legacy data");
  assert.match(source, /createAuth\(\{ databasePath: storage\.authDatabasePath \}\)/, "auth-setup writes the same default auth database as the service");
  assert.doesNotMatch(source, /databasePath:[^;]*\.data/, "auth-setup no longer defaults into the repository .data directory");
  // Non-interactive invocation still refuses before touching any database.
  const result = await spawnAuthSetup([]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /交互终端/);
});

async function spawnAuthSetup(args) {
  const { execFile } = await import("node:child_process");
  const script = new URL("../scripts/auth-setup.mjs", import.meta.url);
  return new Promise((resolvePromise) => {
    execFile(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(script.href)})`, ...args], { env: { ...process.env, AGENTFORGE_LOG_DIR: join(tmpdir(), "af-auth-setup-test-logs") } },
      (error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, stdout, stderr }));
  });
}
