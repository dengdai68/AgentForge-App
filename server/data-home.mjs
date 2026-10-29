// Default persistent data home layout shared by the standalone Web service and
// the Electron desktop host. All application-controlled mutable state lives
// under per-instance subdirectories of ~/.agentforge; explicit environment
// overrides and saved settings always win over these defaults.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";

export function agentforgeDataHome(home = homedir()) { return join(home, ".agentforge"); }
export function standaloneDataRoot(home = homedir()) { return join(agentforgeDataHome(home), "web"); }
export function defaultTaskWorkspaceRoot(home = homedir()) { return join(home, "agentforge"); }

export function standaloneStoragePaths({ home = homedir(), env = process.env } = {}) {
  const dataRoot = standaloneDataRoot(home);
  return {
    dataRoot,
    databasePath: env.AGENTFORGE_DB_PATH || join(dataRoot, "agentforge.sqlite"),
    authDatabasePath: env.AGENTFORGE_AUTH_DB_PATH || join(dataRoot, "auth.sqlite"),
    runFilesRoot: env.AGENTFORGE_RUN_FILES_ROOT || join(dataRoot, "agentforge-runs"),
    runtimeConfigRoot: env.AGENTFORGE_RUNTIME_CONFIG_ROOT || join(dataRoot, "runtime-configs"),
    workspaceRoot: env.AGENTFORGE_WORKSPACE_ROOT || defaultTaskWorkspaceRoot(home)
  };
}

// Marker files that prove a previous default location holds a real instance.
const legacyMarkers = ["agentforge.sqlite", "auth.sqlite"];

async function present(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Hard protection against silently treating a legacy instance as a fresh one:
// when the old default root still holds a database but the new default database
// does not exist yet, startup must refuse and point at the one-time migration
// script instead of creating an empty instance. Callers skip this check
// whenever the database path was explicitly overridden.
export async function legacyDataRequiresMigration({ legacyRoot, currentDatabasePath }) {
  let legacy = false;
  for (const marker of legacyMarkers) legacy ||= await present(join(legacyRoot, marker));
  if (!legacy) return false;
  return !(await present(resolve(currentDatabasePath)));
}

export function migrationGuidance({ legacyRoot, targetRoot, command }) {
  return `检测到旧默认目录 ${legacyRoot} 中存在实例数据，而新默认目录 ${targetRoot} 尚无数据。`
    + `为保护现有实例，本次未按新实例启动。请先退出所有 AgentForge 实例，再运行一次性搬迁：${command}`
    + `（复制并逐项校验后把旧文件改名为备份，绝不删除旧数据；详见 README「数据目录」。）`;
}
