import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defaultTaskWorkspaceRoot } from "../../server/data-home.mjs";

// Application-controlled desktop state lives under ~/.agentforge, isolated per
// instance kind, including Chromium-managed cookies, cache and preferences.
export function desktopDataHome(home = homedir()) { return join(home, ".agentforge"); }

export function resolveDesktopDataRoot({ packaged, env = {}, home = homedir() } = {}) {
  if (!packaged && typeof env.AGENTFORGE_DESKTOP_DATA_ROOT === "string" && env.AGENTFORGE_DESKTOP_DATA_ROOT) return env.AGENTFORGE_DESKTOP_DATA_ROOT;
  return join(desktopDataHome(home), packaged ? "desktop" : "desktop-dev");
}

export function desktopBrowserPaths(dataRoot) {
  if(typeof dataRoot!=='string' || !isAbsolute(dataRoot)) throw new Error('桌面数据目录必须是绝对路径');
  return {userData:join(dataRoot,'browser'),sessionData:join(dataRoot,'browser'),logs:join(dataRoot,'electron-logs'),crashDumps:join(dataRoot,'crash-dumps')};
}

// The previous default location whose data must be migrated explicitly; an
// explicit AGENTFORGE_DESKTOP_DATA_ROOT override has no legacy default.
export function legacyDesktopDataRoot({ packaged, userData, env = {}, sourceRoot }) {
  if (packaged) return userData;
  if (env.AGENTFORGE_DESKTOP_DATA_ROOT) return null;
  return join(sourceRoot, ".data", "desktop-dev");
}

export function desktopStoragePaths(userDataDirectory, { home = homedir() } = {}) {
  if (typeof userDataDirectory !== "string" || !isAbsolute(userDataDirectory)) throw new Error("桌面数据目录必须是绝对路径");
  const dataRoot = resolve(userDataDirectory);
  return {
    dataRoot,
    AGENTFORGE_AUTH_DB_PATH: join(dataRoot, "auth.sqlite"),
    AGENTFORGE_DB_PATH: join(dataRoot, "agentforge.sqlite"),
    AGENTFORGE_RUN_FILES_ROOT: join(dataRoot, "agentforge-runs"),
    AGENTFORGE_RUNTIME_CONFIG_ROOT: join(dataRoot, "runtime-configs"),
    AGENTFORGE_WORKSPACE_ROOT: defaultTaskWorkspaceRoot(home)
  };
}

export function desktopControlPlaneEnvironment({ environment = {}, storage, electronExecutable, bootstrapToken }) {
  if (!storage?.dataRoot || typeof electronExecutable !== "string" || !electronExecutable) throw new Error("桌面控制面启动配置无效");
  const inherited = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => key !== "HOST" && !key.startsWith("AGENTFORGE_")));
  const values = Object.fromEntries(Object.entries(storage)
    .filter(([key]) => key !== "dataRoot")
    .map(([key, value]) => [key, value]));
  return {
    ...inherited,
    ...values,
    HOST: "127.0.0.1",
    AGENTFORGE_DESKTOP_PORT: "0",
    AGENTFORGE_ELECTRON_NODE: electronExecutable,
    ...(bootstrapToken ? { AGENTFORGE_BOOTSTRAP_TOKEN: bootstrapToken } : {})
  };
}
