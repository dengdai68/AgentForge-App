#!/usr/bin/env node
// Test entry point (`npm test`). Guarantees the suite never reads or writes the
// operator's real instance data: a shell spawned by the desktop client inherits
// the live instance's AGENTFORGE_* locations, and bare diagnostics would land in
// the real ~/.agentforge data home instead of a disposable fixture.
//
// - Inherited instance-binding variables are stripped; tests that need them set
//   their own fixture values per case.
// - AGENTFORGE_LOG_DIR is pinned to a fresh system-temp directory unless the
//   operator explicitly set one, so test diagnostics never touch the real home.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const testFiles = readdirSync(join(repoRoot, "tests")).filter(name => name.endsWith(".test.mjs")).map(name => join("tests", name));

const inheritedInstanceVariables = [
  "AGENTFORGE_DB_PATH",
  "AGENTFORGE_AUTH_DB_PATH",
  "AGENTFORGE_RUN_FILES_ROOT",
  "AGENTFORGE_RUNTIME_CONFIG_ROOT",
  "AGENTFORGE_WORKSPACE_ROOT",
  "AGENTFORGE_DESKTOP_DATA_ROOT",
  "AGENTFORGE_DESKTOP_PORT",
  "AGENTFORGE_ELECTRON_NODE",
  "AGENTFORGE_BOOTSTRAP_TOKEN"
];
export function testEnvironment(inherited = process.env) {
  const env = { ...inherited };
  for (const name of inheritedInstanceVariables) delete env[name];
  // Git hooks export repository selectors. Leaving them set makes fixture
  // git -C commands operate on the caller's worktree/index instead.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE", "GIT_SHALLOW_FILE"]) delete env[name];
  env.AGENTFORGE_LOG_DIR ||= mkdtempSync(join(tmpdir(), "agentforge-test-logs-"));
  return env;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit", env: testEnvironment(), cwd: repoRoot });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
