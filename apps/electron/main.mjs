import { app, BrowserWindow, Menu, Tray, nativeImage, shell, session, screen, ipcMain, clipboard } from "electron";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isConsoleURL, isExternalURL, isPreferencesSender, isCliSender, health, initialRoute } from "./policy.mjs";
import { desktopBrowserPaths, desktopControlPlaneEnvironment, desktopStoragePaths, legacyDesktopDataRoot, resolveDesktopDataRoot } from "./runtime-paths.mjs";
import { diagnostic, diagnostics, installProcessDiagnostics } from "../../server/diagnostics.mjs";
import { legacyDataRequiresMigration, migrationGuidance } from "../../server/data-home.mjs";
import { createInterface } from "node:readline";
import { closeModes, readCloseMode, saveCloseMode } from "./preferences.mjs";
import { loadLoginShellEnvironment } from "./login-shell-env.mjs";
import { createCliInstallation } from "./cli-installation.mjs";
import { confirmCliInstallation } from "./cli-confirmation.mjs";
import { showAppDialog } from "./app-dialog.mjs";

// Shared dialog context: every app-styled dialog gets the screen work area so
// it can size to its content without ever clipping (no parent-ratio cap).
function workAreaHeight() {
  const display = window && !window.isDestroyed() ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
  return display.workAreaSize.height;
}
const appDialog = (options) => showAppDialog({ BrowserWindow, workAreaHeight, ...options });

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
let window, child, tray, childBootstrapToken = null, controlOrigin = null, childInstanceId = null, connecting = false, quitting = false, closeMode = null, savingCloseMode = false, closingPrompt = false;
let shellEnvironment;
let installingCli = false;
const shellEnvironmentAbort = new AbortController();
app.setName("AgentForge");
const storage = desktopStoragePaths(resolveDesktopDataRoot({ packaged: app.isPackaged, env: process.env }));
const previousUserData = app.getPath('userData');
// Set before the single-instance lock and before any Electron session exists.
for(const [name,path] of Object.entries(desktopBrowserPaths(storage.dataRoot))) { mkdirSync(path,{recursive:true,mode:0o700}); app.setPath(name,path); }
const endpointFile = join(storage.dataRoot, "desktop-endpoint.json");
const preferencesFile = join(storage.dataRoot, "desktop-preferences.json");
installProcessDiagnostics("desktop", { instancePath: storage.AGENTFORGE_DB_PATH });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.whenReady().then(start).catch(async error => {
    diagnostic("desktop.start_failed", { error });
    // Documented last resort: if even the app-styled error window cannot be
    // created (process-level failure), exit with the diagnostic log only.
    try { await appDialog({ kind: "error", title: "AgentForge 启动失败", message: "桌面客户端启动失败。", detail: `日志：${diagnostics().status().filePath}`, buttons: ["退出"], cancelIndex: 0 }); }
    catch (dialogError) { diagnostic("desktop.start_dialog_failed", { error: dialogError }); }
    app.quit();
  });
}

async function startControlPlane() {
  if (child) throw new Error("后台仍在启动或退出，请稍后重试。");
  shellEnvironment ||= loadLoginShellEnvironment({ signal: shellEnvironmentAbort.signal, onDiagnostic: fields => diagnostic("desktop.shell_environment", fields) });
  const inherited = await shellEnvironment;
  if (quitting) return;
  const root = app.isPackaged ? app.getAppPath() : sourceRoot;
  await mkdir(storage.dataRoot, { recursive: true, mode: 0o700 });
  await chmod(storage.dataRoot, 0o700);
  if (quitting) return;
  const bootstrapToken = randomBytes(32).toString("hex");
  const environment = desktopControlPlaneEnvironment({ environment: inherited, storage, electronExecutable: process.execPath, bootstrapToken });
  childBootstrapToken = bootstrapToken;
  child = fork(join(root, "server/index.mjs"), [], {
    cwd: storage.dataRoot, env: { ...environment, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  const owned = child;
  for (const stream of ["stdout", "stderr"]) createInterface({ input: owned[stream] }).on("line", text => diagnostic(`desktop.server_${stream}`, { text, childPid: owned.pid }));
  owned.once("exit", (code, signal) => { diagnostic("desktop.server_exit", { code, signal }); if (child === owned) { child = null; childBootstrapToken = null; controlOrigin = null; childInstanceId = null; } });
  owned.once("error", error => { diagnostic("desktop.server_error", { error }); if (child === owned) { child = null; childBootstrapToken = null; controlOrigin = null; childInstanceId = null; } });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("本地后台启动超时，请检查服务日志。")), 30000);
    const onMessage = message => { if (message?.type === "agentforge-ready") finish(null, message); };
    const onExit = () => finish(new Error("本地后台启动失败，请检查服务日志。"));
    const finish = (error, message) => { clearTimeout(timer); owned.off("message", onMessage); owned.off("exit", onExit); error ? reject(error) : resolve(message); };
    owned.on("message", onMessage); owned.once("exit", onExit);
  }).catch(error => { owned.kill(); throw error; });
  if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 || typeof ready.instanceId !== "string") { owned.kill(); throw new Error("本地后台返回了无效连接信息。"); }
  controlOrigin = `http://127.0.0.1:${ready.port}`;
  childInstanceId = ready.instanceId;
  if (!await health(controlOrigin, childInstanceId)) { owned.kill(); throw new Error("本地后台身份校验失败。"); }
  try {
    const existing = await lstat(endpointFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("桌面连接文件不是常规文件");
    const temporary = `${endpointFile}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ origin: controlOrigin, instanceId: childInstanceId }), { flag: "wx", mode: 0o600 });
      await rename(temporary, endpointFile);
    } finally { await unlink(temporary).catch(() => {}); }
  } catch (error) { owned.kill(); throw new Error(`无法安全保存桌面连接信息：${error.message}`); }
}

async function connect() {
  if (connecting || quitting) return;
  connecting = true;
  window?.setTitle("AgentForge · 正在连接本机服务…");
  try {
    if (!child || !await health(controlOrigin, childInstanceId)) await startControlPlane();
    if (!quitting) {
      const route = await initialRoute(controlOrigin);
      if (route === "/setup") await window.loadURL(`${controlOrigin}/setup`, { extraHeaders: `X-AgentForge-Bootstrap: ${childBootstrapToken}\n` });
      else await window.loadURL(controlOrigin);
      window.setTitle("AgentForge");
    }
  } catch (error) {
    diagnostic("desktop.connection_failed", { error });
    if (!quitting && window && !window.isDestroyed()) {
      const response = await appDialog({ parent: window, kind: "error", title: "无法连接 AgentForge", message: "无法连接本机服务。", detail: `日志：${diagnostics().status().filePath}`, buttons: ["重试", "关闭"], defaultIndex: 0, cancelIndex: 1 });
      connecting = false;
      if (response === 0) return connect();
      app.quit();
    }
  } finally { connecting = false; }
}

async function external(url) {
  if (!isExternalURL(url, controlOrigin)) return;
  const response = await appDialog({ parent: window, kind: "question", title: "打开外部链接", message: "在系统浏览器打开外部链接？", detail: new URL(url).origin, buttons: ["取消", "打开"], defaultIndex: 0, cancelIndex: 0 });
  if (response === 1) await shell.openExternal(url);
}

function showWindow() {
  if (!window || window.isDestroyed()) return;
  app.dock?.show(); window.restore(); window.show(); window.focus();
}

function showWindowFromTray() {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("desktop:tray-restore");
  showWindow();
}

function ensureTray() {
  if (tray) return;
  // macOS templates use the supplied mark's alpha, adapting to light/dark bars.
  const image = nativeImage.createFromPath(join(sourceRoot, 'web/icons/application.png')).resize({ width: 18, height: 18 });
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("AgentForge");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 AgentForge", click: showWindowFromTray },
    { label: "设置…", click: openSettings },
    { type: "separator" },
    { label: "退出 AgentForge", click: () => app.quit() }
  ]));
}

async function changeCloseMode(mode) {
  if (typeof mode !== "string" || !Object.hasOwn(closeModes, mode)) throw new Error("关闭行为无效");
  if (savingCloseMode) throw new Error("正在保存，请稍后重试");
  savingCloseMode = true;
  try {
    if (mode === "tray") ensureTray();
    await saveCloseMode(preferencesFile, mode);
    closeMode = mode;
    if (mode === "quit") { showWindow(); tray?.destroy(); tray = null; }
    diagnostic("desktop.close_mode_changed", { closeMode });
    return desktopPreferences();
  } catch (error) {
    diagnostic("desktop.close_mode_failed", { error });
    if (closeMode !== "tray") { tray?.destroy(); tray = null; }
    showWindow();
    throw new Error("关闭行为未保存，保留原设置。请查看运行日志。");
  } finally { savingCloseMode = false; }
}

function desktopPreferences() { return { platform: process.platform, closeMode }; }
function cliInstallation() {
  if (!app.isPackaged || process.platform !== 'darwin') return null;
  const launcher = join(dirname(app.getAppPath()), 'cli/agentforge');
  if (launcher.startsWith('/Volumes/') || launcher.includes('/AppTranslocation/')) return null;
  return createCliInstallation({ home: app.getPath('home'), launcher, shell: userInfo().shell || '/bin/zsh', zdotdir: process.env.ZDOTDIR });
}
const cliUnavailable = () => ({ supported: false, canInstall: false, installed: false, message: '请先将 Mac 安装包移到持久位置（建议应用程序），从打包客户端打开；Web/源码模式不安装 Shell 命令。' });
function openSettings() { showWindow(); if (controlOrigin) void window.loadURL(`${controlOrigin}/settings/general`); else void connect(); }
function applyCloseMode() {
  if (closeMode === "quit") { app.quit(); return; }
  if (closeMode !== "tray") return;
  try { ensureTray(); window.hide(); app.dock?.hide(); diagnostic("desktop.window_hidden"); }
  catch (error) { diagnostic("desktop.tray_failed", { error }); showWindow(); }
}
async function closeWindow() {
  if (savingCloseMode || closingPrompt) return;
  if (closeMode) { applyCloseMode(); return; }
  closingPrompt = true;
  try {
    const response = await appDialog({ parent: window,
      kind: "question", title: "关闭 AgentForge", message: "关闭主窗口时，你希望如何处理？",
      detail: "选择会保存，可随时在「设置 → 常规」修改。保留在菜单栏会继续运行本机后台；Cmd+Q 始终退出。",
      buttons: ["退出程序", "保留在菜单栏", "取消"], defaultIndex: 2, cancelIndex: 2
    });
    if (quitting || ![0, 1].includes(response)) return;
    await changeCloseMode(response === 0 ? "quit" : "tray");
    if (!quitting) applyCloseMode();
  } catch (error) {
    diagnostic("desktop.close_failed", { error }); showWindow();
    if (!quitting) await appDialog({ parent: window, kind: "error", title: "关闭行为未保存", message: "关闭行为未保存，窗口保持打开。", detail: `日志：${diagnostics().status().filePath}`, buttons: ["知道了"], cancelIndex: 0 });
  } finally { closingPrompt = false; }
}

// App-styled About window reusing the app-dialog system; the macOS menu no
// longer triggers the system About panel (orderFrontStandardAboutPanel).
function showAboutDialog() {
  const parent = window && !window.isDestroyed() ? window : null;
  void appDialog({ parent, kind: "question",
    title: "关于 AgentForge", message: `AgentForge 桌面客户端\n版本 ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    buttons: ["好"], cancelIndex: 0
  }).catch(error => diagnostic("desktop.about_failed", { error }));
}

function installMenu() {
  const contents = window.webContents;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: "AgentForge", submenu: [
      { id: "about-agentforge", label: "关于 AgentForge", click: showAboutDialog }, { type: "separator" },
      { label: "设置…", accelerator: "Command+,", click: openSettings },
      { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { label: "退出 AgentForge", accelerator: "Command+Q", click: () => app.quit() }
    ] }] : []),
    { role: "editMenu" },
    { label: "导航", submenu: [
      { label: "首页 / 重新连接", accelerator: "CmdOrCtrl+0", click: () => { showWindow(); void connect(); } },
      { label: "刷新", accelerator: "CmdOrCtrl+R", click: () => contents.reload() },
      { label: "后退", accelerator: "CmdOrCtrl+[", click: () => { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); } },
      { label: "前进", accelerator: "CmdOrCtrl+]", click: () => { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); } },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }
    ] }, { role: "windowMenu" }
  ]));
}

async function start() {
  // Hard protection: a legacy default location with real instance data must
  // never be silently replaced by a fresh instance under the new data home.
  const legacyRoot = legacyDesktopDataRoot({ packaged: app.isPackaged, userData: previousUserData, env: process.env, sourceRoot });
  if (legacyRoot && await legacyDataRequiresMigration({ legacyRoot, currentDatabasePath: storage.AGENTFORGE_DB_PATH })) {
    const command = app.isPackaged
      ? `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${join(process.resourcesPath, "scripts", "migrate-data-home.mjs")}" --yes`
      : "node scripts/migrate-data-home.mjs --yes";
    diagnostic("desktop.legacy_data_detected", { legacyRoot, dataRoot: storage.dataRoot });
    await appDialog({ kind: "error", title: "需要先搬迁实例数据", message: "检测到旧默认位置的应用数据，客户端未按新实例启动。",
      detail: migrationGuidance({ legacyRoot, targetRoot: storage.dataRoot, command }), buttons: ["退出"], cancelIndex: 0 });
    app.quit();
    return;
  }
  try { closeMode = await readCloseMode(preferencesFile); }
  catch (error) { diagnostic("desktop.preferences_read_failed", { error }); }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.dock?.setIcon(join(sourceRoot, 'web/icons/application.png'));
  window = new BrowserWindow({ width: 1320, height: 860, minWidth: 760, minHeight: 560, title: "AgentForge", icon: join(sourceRoot, 'web/icons/application.png'), backgroundColor: "#faf9f5",
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)) }
  });
  const contents = window.webContents;
  ipcMain.handle("desktop:preferences:get", event => {
    if (!isPreferencesSender(event, contents, controlOrigin)) throw new Error("仅允许客户端常规设置访问");
    return desktopPreferences();
  });
  ipcMain.handle("desktop:preferences:set", (event, mode) => {
    if (!isPreferencesSender(event, contents, controlOrigin) || process.platform !== "darwin") throw new Error("仅允许 Mac 客户端常规设置修改");
    return changeCloseMode(mode);
  });
  ipcMain.handle("desktop:workspace:copy-path", (event, text) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame
      || !isConsoleURL(event.senderFrame?.url, controlOrigin)
      || !new URL(event.senderFrame.url).pathname.startsWith("/runs/")
      || typeof text !== "string" || !text || text.length > 32768) throw new Error("无法复制工作目录");
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle('desktop:cli:status', async (event, ...args) => {
    if (args.length || !isCliSender(event, contents, controlOrigin)) throw new Error('仅允许客户端 CLI 设置读取 CLI 安装状态');
    return cliInstallation()?.status() || cliUnavailable();
  });
  ipcMain.handle('desktop:cli:install', async (event, ...args) => {
    if (args.length || !isCliSender(event, contents, controlOrigin) || quitting) throw new Error('仅允许客户端 CLI 设置安装 CLI');
    if (installingCli) throw new Error('CLI 安装正在进行，请稍后重试');
    const installer = cliInstallation();
    if (!installer) return cliUnavailable();
    installingCli = true;
    try {
      const status = await installer.status();
      if (!status.canInstall) return status;
      const accepted = await confirmCliInstallation({ BrowserWindow, parent: window, status, signal: shellEnvironmentAbort.signal });
      if (!accepted || quitting || !isCliSender(event, contents, controlOrigin)) return { ...status, cancelled: true };
      const result = await installer.install(status.profilePaths);
      diagnostic('desktop.cli_installed', { installed: result.installed });
      return result;
    } catch (error) {
      diagnostic('desktop.cli_install_failed', { code: error.code || 'unknown' });
      return { ...(await installer.status()), installed: false, message: error.code?.startsWith('CLI_') ? error.message : 'CLI 安装未完成，请检查安装目录和配置文件权限后重试；不使用 sudo。' };
    } finally { installingCli = false; }
  });
  // Presentation only: the authenticated server includes desktop CSS before
  // first paint, including login redirects. This marker grants no authority.
  contents.setUserAgent(`${contents.getUserAgent()} AgentForgeDesktop/1`);
  contents.on("will-navigate", (event, url) => { if (!isConsoleURL(url, controlOrigin)) { event.preventDefault(); void external(url); } });
  contents.on("will-redirect", (event, url) => { if (!isConsoleURL(url, controlOrigin)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (isConsoleURL(url, controlOrigin)) void window.loadURL(url);
    else void external(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("render-process-gone", (_event, details) => { diagnostic("desktop.renderer_gone", { details }); if (!quitting) void connect(); });
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    diagnostic("desktop.load_failed", { code, description, isMainFrame });
    if (isMainFrame && code !== -3 && !connecting && !quitting) void connect();
  });
  window.on("close", event => {
    if (quitting || process.platform !== "darwin") return;
    event.preventDefault();
    void closeWindow();
  });
  if (process.platform === "darwin" && closeMode === "tray") {
    try { ensureTray(); } catch (error) { diagnostic("desktop.tray_failed", { error }); }
  }
  installMenu();
  await connect();
}

app.on("window-all-closed", () => app.quit());
app.on("activate", showWindow);
app.on("before-quit", () => { quitting = true; shellEnvironmentAbort.abort(); tray?.destroy(); tray = null; child?.kill(); });
