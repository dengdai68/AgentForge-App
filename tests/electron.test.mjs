import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { isConsoleURL, isExternalURL, isPreferencesSender, isCliSender, health, initialRoute } from "../apps/electron/policy.mjs";
import { desktopBrowserPaths, desktopControlPlaneEnvironment, desktopStoragePaths, legacyDesktopDataRoot, resolveDesktopDataRoot } from "../apps/electron/runtime-paths.mjs";
import { normalizeCloseMode, readCloseMode, saveCloseMode } from "../apps/electron/preferences.mjs";
import { confirmCliInstallation } from "../apps/electron/cli-confirmation.mjs";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

test("CLI and close preferences accept only their own Settings entry", () => {
  const origin = "http://127.0.0.1:51983", mainFrame = { url: `${origin}/settings/cli` }, contents = { mainFrame };
  const event = { sender: contents, senderFrame: mainFrame };
  assert.equal(isCliSender(event, contents, origin), true);
  assert.equal(isPreferencesSender(event, contents, origin), false);
  assert.equal(isCliSender({ ...event, sender: {} }, contents, origin), false);
  assert.equal(isCliSender({ ...event, senderFrame: { ...mainFrame } }, contents, origin), false);
  for (const path of ["general", "appearance", "workspace", "cli/other"]) {
    mainFrame.url = `${origin}/settings/${path}`;
    assert.equal(isCliSender(event, contents, origin), false);
    assert.equal(isPreferencesSender(event, contents, origin), path === "general");
  }
  mainFrame.url = "http://127.0.0.1:4310/settings/cli";
  assert.equal(isCliSender(event, contents, origin), false);
});

test("desktop first-run routing never treats unknown state as configured", async () => {
  const response = (body, ok = true) => async () => ({ ok, json: async () => body });
  assert.equal(await initialRoute("http://127.0.0.1:12345", response({ configured: false, available: true })), "/setup");
  assert.equal(await initialRoute("http://127.0.0.1:12345", response({ configured: true, available: false })), "/");
  for (const body of [{}, { configured: false, available: false }]) {
    await assert.rejects(initialRoute("http://127.0.0.1:12345", response(body)));
  }
  await assert.rejects(initialRoute("http://127.0.0.1:12345", response({}, false)));
  await assert.rejects(initialRoute("http://127.0.0.1:12345", async () => { throw new Error("timeout"); }), /timeout/);
});

test("desktop login and unconfigured fallback never expose source setup instructions", async () => {
  const source = await readFile(new URL("../web/login.js", import.meta.url), "utf8");
  for (const desktop of [true, false]) for (const status of [{ configured: true }, { configured: false, available: true }, { configured: false, available: false }]) {
    const elements = new Map();
    const get = selector => {
      if (!elements.has(selector)) elements.set(selector, { hidden: true, focus() {}, addEventListener() {}, querySelector: get, username: { focus() {} } });
      return elements.get(selector);
    };
    vm.runInNewContext(source, {
      document: { querySelector: get }, navigator: { userAgent: desktop ? "AgentForgeDesktop/1" : "Browser" },
      AbortSignal, fetch: async () => ({ ok: true, json: async () => status })
    });
    await new Promise(resolve => setImmediate(resolve));
    if (desktop) {
      assert.equal(get("#login-help").hidden, true);
      assert.equal(get("#source-setup-guidance").hidden, true);
    }
    if (!status.configured) assert.equal(get("#desktop-setup-guidance").hidden, !desktop);
    if (!desktop && status.available === false) assert.equal(get("#source-setup-guidance").hidden, false);
  }
});

test("Mac download links and package lock track the release version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  const url = `https://github.com/dengdai68/AgentForge-App/releases/tag/v${manifest.version}`;
  for (const page of ["index.html", "login.html"]) {
    const html = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    assert.ok(html.includes(`href="${url}"`), `${page} must link to the packaged release`);
  }
});

test("Mac close preference is explicit, persistent and fails without changing saved state", async t => {
  const root = await mkdtemp(join((await import("node:os")).tmpdir(), "af-close-preference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "desktop-preferences.json");
  assert.equal(await readCloseMode(path), null);
  assert.equal(normalizeCloseMode("unknown"), null);
  await saveCloseMode(path, "tray");
  assert.equal(await readCloseMode(path), "tray");
  await assert.rejects(saveCloseMode(path, "unknown"), /无效/);
  for (const invalid of [null, {}, ["tray"], new String("tray")]) {
    assert.equal(normalizeCloseMode(invalid), null);
    await assert.rejects(saveCloseMode(path, invalid), /无效/);
  }
  assert.equal(await readCloseMode(path), "tray");
  await writeFile(path, "invalid JSON");
  assert.equal(await readCloseMode(path), null);
  await writeFile(path, "null");
  assert.equal(await readCloseMode(path), null);
  await saveCloseMode(path, "quit");
  assert.equal(await readCloseMode(path), "quit", "preserve an existing explicit choice");
  await writeFile(join(root, "blocked"), "not a directory");
  await assert.rejects(saveCloseMode(join(root, "blocked", "preferences.json"), "tray"));
});

test("desktop new-conversation button owns zero padding and centered icon layout", async () => {
  const css = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  assert.match(css, /\.communication-sidebar-heading button \{ display:flex; align-items:center; justify-content:center; padding:0; width:28px; height:28px;/);
  assert.match(css, /#run-workspace \.collaboration-row \{ padding:12px 0; \}/);
});

test("tray restore suppresses only navigation focus until the next interaction", async () => {
  const source = await readFile(new URL("../apps/electron/preload.cjs", import.meta.url), "utf8");
  const handlers = new Map(), dom = new Map(); let exposed;
  const fixture = (mainFrame = true, origin = "http://127.0.0.1:4310") => {
    handlers.clear(); dom.clear();
    const document = { activeElement: null, addEventListener: (name, callback) => dom.set(name, callback) };
    const window = { addEventListener: (name, callback) => dom.set(name, callback) };
    vm.runInNewContext(source, { process: { isMainFrame: mainFrame }, location: { origin }, document, window,
      require: () => ({ ipcRenderer: { on: (name, callback) => handlers.set(name, callback), invoke() {} }, contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } } }) });
    return document;
  };
  const document = fixture();
  assert.deepEqual(Object.keys(exposed).sort(), ["copyWorkspacePath", "getCliInstallation", "getPreferences", "installCli", "setCloseMode"]);
  const attributes = new Map(), navigation = { matches: selector => selector === ".nav-item", setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key), blur: () => assert.fail("must not move focus") };
  const restore = handlers.get("desktop:tray-restore"), marked = () => attributes.has("data-desktop-restored-focus");
  document.activeElement = navigation;
  restore(); restore(); assert.equal(marked(), true); assert.equal(document.activeElement, navigation);
  dom.get("keydown")({ key: "Shift" }); assert.equal(marked(), true);
  for (const key of ["Tab", "Enter", "ArrowDown", " "]) {
    restore(); dom.get("keydown")({ key }); assert.equal(marked(), false, key);
  }
  restore(); dom.get("pointerdown")(); assert.equal(marked(), false);
  restore(); dom.get("focusout")({ target: navigation }); assert.equal(marked(), false);
  document.activeElement = { matches: () => false, value: "draft", selectionStart: 2, selectionEnd: 4, blur: () => assert.fail("text field must retain focus") };
  restore(); assert.equal(marked(), false); assert.equal(document.activeElement.value, "draft"); assert.equal(document.activeElement.selectionStart, 2); assert.equal(document.activeElement.selectionEnd, 4);
  document.activeElement = null; restore();
  fixture(false); assert.equal(handlers.size, 0); assert.equal(dom.size, 0);
  fixture(true, "https://example.com"); assert.equal(handlers.size, 0); assert.equal(dom.size, 0);
  const css = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  assert.match(css, /:focus-visible \{ outline:2px solid var\(--desktop-focus\)/);
  assert.match(css, /\.nav-item\[data-desktop-restored-focus\]:focus-visible \{ outline:none; \}/);
  const main = await readFile(new URL("../apps/electron/main.mjs", import.meta.url), "utf8");
  assert.match(main, /label: "打开 AgentForge", click: showWindowFromTray/);
  const calls = [], host = { window: { isDestroyed: () => false, webContents: { send: (...args) => calls.push(args) } }, showWindow: () => calls.push("show") };
  const restoreHost = vm.runInNewContext(`${main.slice(main.indexOf("function showWindowFromTray()"), main.indexOf("function ensureTray()"))}\nshowWindowFromTray`, host);
  restoreHost(); assert.deepEqual(calls, [["desktop:tray-restore"], "show"], "notify before showing the window");
  host.window.isDestroyed = () => true; restoreHost(); assert.equal(calls.length, 2);
  host.window = null; restoreHost(); assert.equal(calls.length, 2);
});

test("first-close controller cancels, deduplicates, saves before action and keeps failures visible", async () => {
  const source = await readFile(new URL("../apps/electron/main.mjs", import.meta.url), "utf8");
  const controller = source.slice(source.indexOf("async function closeWindow()"), source.indexOf("function installMenu()"));
  const fixture = (show, fail = false) => {
    const calls = [], context = { savingCloseMode: false, closingPrompt: false, quitting: false, closeMode: null, window: {}, BrowserWindow: function BrowserWindow() {},
      appDialog: show, diagnostic() {}, diagnostics: () => ({ status: () => ({ filePath: "/test/log" }) }),
      showWindow: () => calls.push("visible"), changeCloseMode: async mode => { calls.push(`save:${mode}`); if (fail) throw new Error("write failed"); context.closeMode = mode; },
      applyCloseMode: () => calls.push(`apply:${context.closeMode}`) };
    return { calls, context, close: vm.runInNewContext(`${controller}\ncloseWindow`, context) };
  };
  for (const response of [0, 1]) {
    const f = fixture(async () => response); await f.close();
    assert.deepEqual(f.calls, [`save:${response === 0 ? 'quit' : 'tray'}`, `apply:${response === 0 ? 'quit' : 'tray'}`]);
  }
  let answer, questions = 0;
  const cancel = fixture(() => { questions++; return new Promise(resolve => { answer = resolve; }); });
  const closing = cancel.close(); await cancel.close(); assert.equal(questions, 1);
  answer(2); await closing;
  assert.deepEqual(cancel.calls, []); assert.equal(cancel.context.closeMode, null); assert.equal(cancel.context.closingPrompt, false);
  const failed = fixture(async () => 1, true); await failed.close();
  assert.deepEqual(failed.calls, ['save:tray', 'visible']); assert.equal(failed.context.closeMode, null);
});

test("packaged acceptance follows dynamic staffing and the task action menu", async () => {
  const source = await readFile(new URL("../scripts/test-packaged-electron.mjs", import.meta.url), "utf8");
  assert.match(source, /nextAgentId:[^\n]*roster\.find/);
  assert.match(source, /assert\.deepEqual\(workspace\.run\.task\.nodeAssignments, \{\}\)/);
  assert.match(source, /trace\.agentId === worker\.agent\.id/);
  assert.doesNotMatch(source, /nodeAssignment_packaged_verify/);
  assert.match(source, /manager conclusion is a normal collaboration message/);
  const archive = source.slice(source.indexOf('data-task-center-page="archive"'));
  assert.ok(archive.indexOf('的更多操作') < archive.indexOf('data-unarchive-task='));
});

test("Electron accepts only its owned credential-free Console origin", () => {
  const owned = "http://127.0.0.1:51983";
  assert.equal(isConsoleURL(`${owned}/tasks?q=1`, owned), true);
  for (const url of ["http://127.0.0.1:4310", "http://localhost:51983", "http://127.0.0.1.evil:51983", "file:///etc/passwd", "javascript:alert(1)", "http://user:pass@127.0.0.1:51983"]) assert.equal(isConsoleURL(url, owned), false);
  assert.equal(isExternalURL("https://example.com", owned), true);
  assert.equal(isExternalURL("file:///tmp/a", owned), false);
});
test("Electron health rejects wrong services and network errors", async () => {
  const owned = "http://127.0.0.1:51983", id = "owned-instance";
  assert.equal(await health(owned, id, async () => ({ ok: true, json: async () => ({ service: "agentforge-control-plane", instanceId: id }) })), true);
  assert.equal(await health(owned, id, async () => ({ ok: true, json: async () => ({ service: "agentforge-control-plane", instanceId: "another" }) })), false);
  assert.equal(await health(owned, id, async () => ({ ok: true, json: async () => ({ service: "other", instanceId: id }) })), false);
  assert.equal(await health(owned, id, async () => { throw new Error("offline"); }), false);
});
test("Electron preferences IPC rejects other windows, subframes and non-General routes", () => {
  const owned = "http://127.0.0.1:51983";
  const mainFrame = { url: `${owned}/settings/general` }, contents = { mainFrame };
  assert.equal(isPreferencesSender({ sender: contents, senderFrame: mainFrame }, contents, owned), true);
  assert.equal(isPreferencesSender({ sender: {}, senderFrame: mainFrame }, contents, owned), false);
  assert.equal(isPreferencesSender({ sender: contents, senderFrame: { ...mainFrame } }, contents, owned), false);
  for (const url of ["https://evil.test/settings/general", "http://localhost:4310/settings/general", "http://u:p@127.0.0.1:4310/settings/general", "http://127.0.0.1:4310/login", "http://127.0.0.1:4310/settings", "http://127.0.0.1:4310/settings/appearance", "file:///settings/general", "data:text/html,test"]) {
    mainFrame.url = url;
    assert.equal(isPreferencesSender({ sender: contents, senderFrame: mainFrame }, contents, owned), false, url);
  }
});
test("Electron renderer has no Node and only closed preference/CLI installation/workspace-copy methods", async () => {
  const source = await readFile(new URL("../apps/electron/main.mjs", import.meta.url), "utf8");
  assert.match(source, /nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true/);
  assert.doesNotMatch(source, /createStore/);
  assert.equal((source.match(/ipcMain\.handle\(/g) || []).length, 5);
  assert.equal((source.match(/isPreferencesSender\(event, contents, controlOrigin\)/g) || []).length, 2);
  assert.equal((source.match(/isCliSender\(event, contents, controlOrigin\)/g) || []).length, 3);
  const preload = await readFile(new URL("../apps/electron/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /process.isMainFrame && \/\^http:/);
  assert.match(preload, /getPreferences: \(\) => ipcRenderer.invoke\("desktop:preferences:get"\)/);
  assert.match(preload, /setCloseMode: \(mode\) => ipcRenderer.invoke\("desktop:preferences:set", mode\)/);
  assert.equal((preload.match(/ipcRenderer\.invoke\(/g) || []).length, 5);
  assert.match(preload, /getCliInstallation: \(\) => ipcRenderer.invoke\("desktop:cli:status"\)/);
  assert.match(preload, /installCli: \(\) => ipcRenderer.invoke\("desktop:cli:install"\)/);
  assert.match(source, /args.length \|\| !isCliSender/);
  assert.match(source, /await confirmCliInstallation\(\{ BrowserWindow, parent: window, status, signal: shellEnvironmentAbort.signal \}\)/);
  assert.doesNotMatch(preload, /node:|send:|invoke:|require\("(?:fs|child_process)"/);
  assert.doesNotMatch(source, /\bdialog\.(?:showMessageBox|showErrorBox|showOpenDialog|showSaveDialog)/, "no system dialogs remain in the desktop host");
  assert.match(source, /buttons: \["退出程序", "保留在菜单栏", "取消"\], defaultIndex: 2, cancelIndex: 2/);
  assert.match(source, /child\?\.kill\(\)/);
  assert.match(source, /requestSingleInstanceLock/);
  assert.match(source, /setUserAgent\(.*AgentForgeDesktop\/1/);
  assert.doesNotMatch(source, /insertCSS|did-finish-load/);
  const server = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  assert.match(server, /agentforge-desktop-style/);
  assert.match(server, /!desktop \|\| extension !== "\.html"/);
  assert.ok(server.indexOf("auth.guard") < server.indexOf("await serveStatic"));
  const web = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(web, /compact.css/);
});
test('CLI host bridge requires isolated host consent, rejects arguments/navigation and serializes writes', async () => {
  const source = await readFile(new URL('../apps/electron/main.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf("  ipcMain.handle('desktop:cli:status'"), source.indexOf('  // Presentation only:'));
  const handlers = new Map(); let writes = 0, allowed = true, accepted = false, answer;
  const status = { canInstall: true, installed: false, commandPath: '/fixture/bin/agentforge', profilePaths: ['/fixture/.zshrc'] };
  const context = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, isCliSender: () => allowed,
    contents: {}, controlOrigin: "http://127.0.0.1:51983", quitting: false, installingCli: false, window: {}, BrowserWindow() {}, shellEnvironmentAbort: new AbortController(), diagnostic() {}, cliUnavailable() {},
    cliInstallation: () => ({ status: async () => status, install: async paths => { assert.equal(JSON.stringify(paths), JSON.stringify(status.profilePaths)); writes++; return { ...status, installed: true }; } }),
    confirmCliInstallation: async () => answer ? new Promise(resolve => { answer.resolve = resolve; }) : accepted };
  vm.runInNewContext(code, context);
  const install = handlers.get('desktop:cli:install'), read = handlers.get('desktop:cli:status');
  assert.equal((await install({})).cancelled, true); assert.equal(writes, 0);
  accepted = true; assert.equal((await install({})).installed, true); assert.equal(writes, 1);
  for (const fn of [read, install]) await assert.rejects(fn({}, '/arbitrary/path'), /仅允许/);
  allowed = false; for (const fn of [read, install]) await assert.rejects(fn({}), /仅允许/);
  allowed = true; answer = {}; const pending = install({});
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(install({}), /正在进行/);
  allowed = false; answer.resolve(true); await pending;
  assert.equal(writes, 1, 'navigation while consent is open prevents writes');
});

test('CLI confirmation accepts only exact local main-frame choices and cancels on close or abort', async () => {
  const fixture = () => {
    const parent = new EventEmitter(); parent.isDestroyed = () => false;
    const signal = new AbortController(); let child, request;
    class BrowserWindow extends EventEmitter {
      constructor(options) {
        super(); child = this; this.options = options; this.destroyed = false;
        this.webContents = new EventEmitter();
        this.webContents.mainFrame = { url: "" };
        this.webContents.session = { setPermissionRequestHandler(callback) { this.permissions = callback; }, setPermissionCheckHandler(callback) { this.check = callback; }, webRequest: { onBeforeRequest(callback) { request = callback; } } };
        this.webContents.setWindowOpenHandler = callback => { this.openWindow = callback; };
      }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; this.emit('closed'); }
      async loadFile(path, { search }) { this.path = path; this.url = new URL(`file://${path}`); this.url.search = search; this.webContents.mainFrame.url = this.url.href; }
      show() { this.visible = true; }
      focus() { this.focused = true; }
    }
    const status = { commandPath: '/fixture/名字 <x>/agentforge', profilePaths: ['/fixture/.zshrc'] };
    const pending = confirmCliInstallation({ BrowserWindow, parent, status, signal: signal.signal });
    const choose = (hash, main = true, base = child.url) => {
      const url = new URL(base); url.hash = hash;
      child.webContents.mainFrame.url = url.href;
      child.webContents.emit('did-navigate-in-page', {}, url.href, main);
    };
    return { child, pending, signal, choose, parent, request: (url) => { let result; request({ url }, value => { result = value; }); return result; } };
  };
  const accepted = fixture();
  assert.equal(accepted.child.options.modal, true);
  assert.equal(accepted.child.options.webPreferences.sandbox, true);
  assert.equal(accepted.child.options.webPreferences.nodeIntegration, false);
  assert.equal(accepted.child.options.webPreferences.preload, undefined);
  assert.deepEqual(accepted.child.openWindow({ url: 'https://example.com' }), { action: 'deny' });
  assert.equal(accepted.request('https://example.com').cancel, true);
  assert.equal(accepted.request(new URL('../compact.css', accepted.child.url).href).cancel, true);
  assert.equal(accepted.request(new URL('./compact.css', accepted.child.url).href).cancel, false);
  accepted.choose('install', false); assert.equal(accepted.child.destroyed, false);
  accepted.choose('install', true, 'file:///arbitrary/cli-confirmation.html'); assert.equal(accepted.child.destroyed, false);
  accepted.choose('other'); assert.equal(accepted.child.destroyed, false);
  accepted.choose('install'); assert.equal(await accepted.pending, true);
  for (const action of [f => f.choose('cancel'), f => f.child.destroy(), f => f.signal.abort(), f => f.parent.emit('closed')]) {
    const cancelled = fixture(); action(cancelled); assert.equal(await cancelled.pending, false);
  }
  const html = await readFile(new URL('../apps/electron/cli-confirmation.html', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../apps/electron/cli-confirmation.js', import.meta.url), 'utf8');
  assert.match(html, /data-choice="cancel" autofocus/);
  assert.match(html, /connect-src 'none'/);
  assert.match(renderer, /textContent = path/);
  assert.doesNotMatch(renderer, /innerHTML|ipcRenderer|fetch\(/);
});
test('app dialog accepts only exact local main-frame choices, sizes to content and cancels on close or abort', async () => {
  const { showAppDialog } = await import('../apps/electron/app-dialog.mjs');
  const fixture = ({ measured = 320, remeasured, parentHeight = 800, workArea } = {}) => {
    const parent = new EventEmitter(); parent.isDestroyed = () => false; parent.getContentSize = () => [1280, parentHeight];
    const signal = new AbortController(); let child, request, measurements = 0;
    class BrowserWindow extends EventEmitter {
      constructor(options) {
        super(); child = this; this.options = options; this.destroyed = false; this.sizes = [];
        this.webContents = new EventEmitter();
        this.webContents.mainFrame = { url: "" };
        this.webContents.session = { setPermissionRequestHandler(callback) { this.permissions = callback; }, setPermissionCheckHandler(callback) { this.check = callback; }, webRequest: { onBeforeRequest(callback) { request = callback; } } };
        this.webContents.setWindowOpenHandler = callback => { this.openWindow = callback; };
        this.webContents.executeJavaScript = async () => { measurements += 1; return measurements > 1 && remeasured !== undefined ? remeasured : measured; };
      }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; this.emit('closed'); }
      setContentSize(width, height) { this.sizes.push([width, height]); }
      async loadFile(path, { search }) { this.path = path; this.url = new URL(`file://${path}`); this.url.search = search; this.webContents.mainFrame.url = this.url.href; }
      show() { this.visible = true; }
      focus() { this.focused = true; }
    }
    const pending = showAppDialog({ BrowserWindow, parent, kind: 'error', title: '无法连接 AgentForge', message: '无法连接本机服务。', detail: '日志：/fixture/log.jsonl', buttons: ['重试', '关闭'], defaultIndex: 0, cancelIndex: 1, signal: signal.signal, workAreaHeight: workArea ? () => workArea : undefined });
    const choose = (hash, main = true, base = child.url) => {
      const url = new URL(base); url.hash = hash;
      child.webContents.mainFrame.url = url.href;
      child.webContents.emit('did-navigate-in-page', {}, url.href, main);
    };
    return { child, pending, signal, choose, parent, request: (url) => { let result; request({ url }, value => { result = value; }); return result; } };
  };
  const picked = fixture();
  assert.equal(picked.child.options.modal, true);
  assert.equal(picked.child.options.resizable, false);
  assert.equal(picked.child.options.webPreferences.sandbox, true);
  assert.equal(picked.child.options.webPreferences.nodeIntegration, false);
  assert.equal(picked.child.options.webPreferences.preload, undefined);
  assert.deepEqual(picked.child.openWindow({ url: 'https://example.com' }), { action: 'deny' });
  assert.equal(picked.request('https://example.com').cancel, true);
  assert.equal(picked.request(new URL('../compact.css', picked.child.url).href).cancel, true);
  assert.equal(picked.request(new URL('./app-dialog.css', picked.child.url).href).cancel, false);
  assert.equal(picked.request(new URL('./compact.css', picked.child.url).href).cancel, false);
  picked.choose('choice-0', false); assert.equal(picked.child.destroyed, false);
  picked.choose('choice-0', true, 'file:///arbitrary/app-dialog.html'); assert.equal(picked.child.destroyed, false);
  picked.choose('choice-9'); assert.equal(picked.child.destroyed, false, 'out-of-range choice is ignored');
  picked.choose('other'); assert.equal(picked.child.destroyed, false);
  picked.choose('choice-0'); assert.equal(await picked.pending, 0);
  for (const action of [f => f.choose('choice-1'), f => f.child.destroy(), f => f.signal.abort(), f => f.parent.emit('closed')]) {
    const cancelled = fixture(); action(cancelled); assert.equal(await cancelled.pending, 1, 'cancel paths resolve the cancel index');
  }
  const sized = fixture({ measured: 300 });
  sized.child.emit('ready-to-show');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sized.child.sizes, [[480, 300]]); assert.equal(sized.child.visible, true);
  sized.child.destroy(); await sized.pending;
  const tall = fixture({ measured: 9999, parentHeight: 800 });
  tall.child.emit('ready-to-show');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(tall.child.sizes, [[480, 9999]], 'no parent-ratio cap: the window follows the measured content');
  tall.child.destroy(); await tall.pending;
  const floored = fixture({ measured: 40 });
  floored.child.emit('ready-to-show');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(floored.child.sizes, [[480, 148]], 'height keeps a readable floor');
  floored.child.destroy(); await floored.pending;
  const widened = fixture({ measured: 9999, remeasured: 300, workArea: 500 });
  widened.child.emit('ready-to-show');
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(widened.child.sizes, [[720, 436], [720, 300]], 'too tall for the work area: widen to min(parent-48, 720), re-measure, then size to content');
  assert.equal(widened.child.visible, true);
  widened.child.destroy(); await widened.pending;
  const ceiling = fixture({ measured: 9999, remeasured: 9999, workArea: 500 });
  ceiling.child.emit('ready-to-show');
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(ceiling.child.sizes, [[720, 436], [720, 436]], 'the only ceiling is the work area minus margin, never a parent ratio');
  ceiling.child.destroy(); await ceiling.pending;
  const html = await readFile(new URL('../apps/electron/app-dialog.html', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../apps/electron/app-dialog.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../apps/electron/app-dialog.css', import.meta.url), 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.match(styles, /html, body \{ overflow:hidden; \}/);
  assert.match(renderer, /textContent = label/);
  assert.match(renderer, /location\.hash = `choice-\$\{cancelIndex\}`/);
  assert.doesNotMatch(renderer, /innerHTML|ipcRenderer|fetch\(/);
  const module = await readFile(new URL('../apps/electron/app-dialog.mjs', import.meta.url), 'utf8');
  assert.match(module, /Math\.max\(document\.documentElement\.scrollHeight, document\.body\.scrollHeight\)/);
  const main = await readFile(new URL('../apps/electron/main.mjs', import.meta.url), 'utf8');
  assert.equal((main.match(/appDialog\(\{/g) || []).length, 7, 'all five former system dialog scenes plus About and the legacy-data refusal use the app dialog');
  assert.match(main, /需要先搬迁实例数据/);
  assert.doesNotMatch(main, /role:\s*["']about["']/, 'the macOS menu no longer triggers the system About panel');
  assert.match(main, /关于 AgentForge/);
  assert.match(main, /showAboutDialog/);
});

test('Web confirmation flows use the in-app dialog, never native dialogs', async () => {
  for (const file of ['../web/app.js', '../web/settings.mjs', '../web/communication.js', '../web/marketplace.mjs', '../web/login.js', '../web/setup.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?<![\w$.-])(?:window\.)?(?:confirm|alert|prompt)\(/, `${file} must not call native dialogs`);
  }
  const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /function confirmDialog\(\{ title, message, confirmLabel = "确认", danger = false \}\)/);
  assert.match(app, /openModal, closeModal, confirmDialog,/);
  assert.match(app, /confirmDialog\(\{ title: "删除工作流"/);
  assert.match(app, /confirmDialog\(\{ title: "归档任务"/);
  const settings = await readFile(new URL('../web/settings.mjs', import.meta.url), 'utf8');
  assert.match(settings, /await confirmDialog\(\{ title: "移除拉取 Token"/);
  const shared = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  assert.match(shared, /\.modal\.confirm-dialog \{[^}]*overflow:hidden/);
  const desktop = await readFile(new URL('../apps/electron/compact.css', import.meta.url), 'utf8');
  assert.match(desktop, /\.modal\.confirm-dialog/);
});

test("Electron workbench stays host-only and preserves the narrow fallback", async () => {
  const css = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  assert.match(css, /--desktop-density:compact/);
  assert.match(css, /--desktop-presentation:workbench/);
  assert.match(css, /\.table th \{[^}]*background:var\(--bg\)/);
  assert.match(css, /#run-workspace \.workspace-grid \{ grid-template-columns:220px/);
  assert.match(css, /@media \(max-width:1000px\) \{[\s\S]*\.sidebar \{ width:64px/);
  assert.doesNotMatch(css, /web\/styles\.css/);
});
test("Electron reduces chrome spacing without shrinking reading text or scaling pages", async () => {
  const css = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  assert.match(css, /--desktop-sidebar-width:216px/);
  assert.match(css, /\.main-content \{[^}]*width:calc\(100% - var\(--desktop-sidebar-width\)\);[^}]*padding:0/);
  assert.match(css, /\.topbar \{ height:44px/);
  assert.match(css, /\.main-content:has\(#workspace-view\.active\) > \.topbar \{ height:44px; min-height:44px/);
  assert.match(css, /\.table td \{ padding:8px 10px;[^}]*font-size:13px/);
  assert.match(css, /\.table \{ min-width:820px/);
  assert.match(css, /\.table \.col-actions \{ width:14%/);
  assert.match(css, /\.table-actions \{ flex-wrap:wrap; gap:4px/);
  assert.match(css, /\.team-card,\.agent-card \{ min-height:0; padding:10px 12px/);
  assert.match(css, /body \{[^}]*font:13px\/1.5/);
  assert.match(css, /\.communication-body \{[^}]*font-size:13px/);
  assert.doesNotMatch(css, /(?:zoom|font-size-adjust)\s*:|transform\s*:\s*scale|\.markdown-preview[^}]*font-size/);
  assert.match(css, /@media \(max-width:760px\) \{\s*\.communication-layout \{ grid-template-columns:minmax\(0,1fr\); height:auto; min-height:0/);
  assert.match(css, /@media \(max-width:760px\), \(max-height:620px\) \{\s*\.collaboration-row \{ grid-template-columns:minmax\(0,1fr\); gap:4px/);
  const shared = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(shared, /#run-workspace \.markdown-preview \{ font-size:14px/);
  assert.match(shared, /@media \(max-width:780px\), \(max-height:620px\)[\s\S]*#run-workspace \.workspace-grid \{ display:flex; flex-direction:column/);
});

test('application branding preserves the supplied PNG for sidebar, Dock, tray and packaged icon', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(manifest.build.mac.icon, 'apps/electron/application.icns');
  const png = await readFile(new URL('web/icons/application.png', root));
  const icns = await readFile(new URL('apps/electron/application.icns', root));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1254);
  assert.equal(png.readUInt32BE(20), 1254);
  assert.equal(createHash('sha256').update(png).digest('hex'), '35d0d4489508658eb2ba854fdecdb4d5c2f60240c5ce7b5569e20044add0eaf3', 'do not redraw or overwrite the operator-supplied mark');
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const html = await readFile(new URL('web/index.html', root), 'utf8');
  assert.match(html, /class="application-icon" src="\/icons\/application.png"/);
  assert.doesNotMatch(html, /class="brand-mark"/);
  const host = await readFile(new URL('apps/electron/main.mjs', root), 'utf8');
  assert.match(host, /app\.dock\?\.setIcon\(join\(sourceRoot, 'web\/icons\/application.png'\)\)/);
  assert.match(host, /nativeImage\.createFromPath\(join\(sourceRoot, 'web\/icons\/application.png'\)\)\.resize/);
  assert.match(host, /image\.setTemplateImage\(true\)/);
});

test('team and workflow actions share directory toolbar spacing without a desktop list divider', async () => {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../apps/electron/compact.css', import.meta.url), 'utf8');
  for (const [view, action] of [['teams', 'new-team'], ['workflows', 'new-workflow']]) {
    const section = html.match(new RegExp(`<section class="view" id="${view}-view">([\\s\\S]*?)<\\/section>`))[1];
    assert.match(section, /class="page-heading">[\s\S]*?<h2>/, 'semantic heading remains available');
    assert.match(section, new RegExp(`<div class="directory-toolbar"><input id="${view}-search"[^>]*type="search"[^>]*><button[^>]*data-action="${action}"`));
    assert.equal((section.match(new RegExp(`data-action="${action}"`, 'g')) || []).length, 1);
  }
  assert.match(css, /\.team-cards \{[^}]*border-top:0/);
  assert.doesNotMatch(css.match(/#workflows-grid \{[^}]+\}/)[0], /border-top:1px/);
});
test("Electron applies one component language to forms, reference and short windows", async () => {
  const css = await readFile(new URL("../apps/electron/compact.css", import.meta.url), "utf8");
  assert.match(css, /\.modal-scroll \{ display:block; padding:2px; \}/);
  assert.match(css, /\.modal \.form-actions \{ margin:0; padding:10px 0 0/);
  assert.match(css, /\.modal\.workflow-detail-modal,\.modal\.workflow-editor-modal,\.modal\.team-config-modal \{ max-height:/, "long configuration dialogs are bounded by the viewport");
  assert.match(css, /\.check-option\.checked \{ border-color:var\(--ink\); background:var\(--selection-bg\)/);
  assert.match(css, /\.manual-tab\.active \{ background:transparent; color:var\(--ink\)/);
  assert.match(css, /\.login-card \.submit \{[^}]*background:var\(--desktop-action\)/);
  assert.match(css, /\.user-card \{ flex-direction:column; align-items:center/);
  assert.match(css, /#run-workspace \.artifact-layout \{ flex:none; height:440px; min-height:440px/);
  assert.match(css, /#run-workspace \.log-meta \{ min-width:0; white-space:normal; font:11px/);
  assert.match(css, /#run-workspace \.console-tool-call \{ display:block/);
  assert.match(css, /html \.client-download \{ display:none/);
  const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /body\.className = "modal-scroll"/);
  assert.match(app, /data-task-more/);
  assert.match(app, /本机人类/);
  const shared = await readFile(new URL("../web/styles.css", import.meta.url), "utf8");
  assert.match(shared, /\.modal-scroll \{ display:contents/);
  assert.match(shared, /\.modal \{ position:relative; width:min\(560px,100%\); margin:auto;/);
  assert.doesNotMatch(shared, /\.modal \{[^}]*(?:max-height|overflow:auto)/, "Web modals size to their content and never scroll");
  assert.match(shared, /\.modal-backdrop \{[^}]*overflow:auto/, "the backdrop carries extreme overflow at page level");
});
test("packaged Electron keeps mutable control-plane data outside its resources", async () => {
  const storage = desktopStoragePaths("/private/var/folders/agentforge-profile", { home: "/fixture-home" });
  assert.equal(storage.AGENTFORGE_AUTH_DB_PATH, "/private/var/folders/agentforge-profile/auth.sqlite");
  assert.equal(storage.AGENTFORGE_RUNTIME_CONFIG_ROOT, "/private/var/folders/agentforge-profile/runtime-configs");
  assert.equal(storage.AGENTFORGE_WORKSPACE_ROOT, "/fixture-home/agentforge");
  const environment = desktopControlPlaneEnvironment({ environment: { PATH: "/usr/bin", AGENTFORGE_DB_PATH: "/existing/state.sqlite", AGENTFORGE_RUNTIME_CONFIG_ROOT: "/existing/config", AGENTFORGE_PUBLIC_ORIGIN: "https://unexpected.example", HOST: "0.0.0.0" }, storage, electronExecutable: "/Applications/AgentForge.app/Contents/MacOS/AgentForge", bootstrapToken: "a".repeat(64) });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.AGENTFORGE_DB_PATH, storage.AGENTFORGE_DB_PATH);
  assert.equal(environment.AGENTFORGE_AUTH_DB_PATH, storage.AGENTFORGE_AUTH_DB_PATH);
  assert.equal(environment.AGENTFORGE_RUNTIME_CONFIG_ROOT, storage.AGENTFORGE_RUNTIME_CONFIG_ROOT);
  assert.equal(environment.AGENTFORGE_PUBLIC_ORIGIN, undefined);
  assert.equal(environment.HOST, "127.0.0.1");
  assert.equal(environment.AGENTFORGE_DESKTOP_PORT, "0");
  assert.equal(environment.AGENTFORGE_ELECTRON_NODE, "/Applications/AgentForge.app/Contents/MacOS/AgentForge");
  assert.equal(environment.AGENTFORGE_BOOTSTRAP_TOKEN, "a".repeat(64));
  assert.throws(() => desktopStoragePaths("relative/profile"), /绝对路径/);
});
test("desktop data roots default under ~/.agentforge with per-instance isolation", () => {
  const home = "/private/var/fixture-home";
  assert.equal(resolveDesktopDataRoot({ packaged: true, env: {}, home }), "/private/var/fixture-home/.agentforge/desktop");
  assert.equal(resolveDesktopDataRoot({ packaged: false, env: {}, home }), "/private/var/fixture-home/.agentforge/desktop-dev");
  assert.equal(resolveDesktopDataRoot({ packaged: false, env: { AGENTFORGE_DESKTOP_DATA_ROOT: "/isolated/e2e" }, home }), "/isolated/e2e");
  // The packaged instance never follows an inherited development override.
  assert.equal(resolveDesktopDataRoot({ packaged: true, env: { AGENTFORGE_DESKTOP_DATA_ROOT: "/isolated/e2e" }, home }), "/private/var/fixture-home/.agentforge/desktop");
  assert.equal(legacyDesktopDataRoot({ packaged: true, userData: "/legacy/userData", env: {}, sourceRoot: "/repo" }), "/legacy/userData");
  assert.equal(legacyDesktopDataRoot({ packaged: false, env: {}, sourceRoot: "/repo" }), "/repo/.data/desktop-dev");
  assert.equal(legacyDesktopDataRoot({ packaged: false, env: { AGENTFORGE_DESKTOP_DATA_ROOT: "/isolated/e2e" }, sourceRoot: "/repo" }), null);
  const storage = desktopStoragePaths(resolveDesktopDataRoot({ packaged: true, env: {}, home }), { home });
  assert.equal(storage.AGENTFORGE_DB_PATH, "/private/var/fixture-home/.agentforge/desktop/agentforge.sqlite");
  assert.equal(storage.AGENTFORGE_WORKSPACE_ROOT, "/private/var/fixture-home/agentforge");
});
test("macOS package configuration is local-only and contains the control plane", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.main, "apps/electron/main.mjs");
  assert.match(manifest.scripts["package:mac"], /--publish never/);
  assert.equal(manifest.scripts["desktop:install"], "node node_modules/electron/install.js");
  assert.equal(manifest.scripts["prepackage:mac"], "npm run desktop:install");
  assert.equal(manifest.scripts["predesktop:test"], "npm run desktop:install");
  assert.equal(manifest.scripts.postinstall, undefined, "server-only installation must not download the desktop runtime");
  assert.equal(manifest.build.appId, "com.agentforge.desktop");
  assert.equal(manifest.build.electronDist, "node_modules/electron/dist");
  assert.equal(manifest.build.asar, true);
  assert.equal(manifest.build.mac.identity, "-", "the full Beta bundle must be explicitly ad-hoc signed");
  for (const path of ["apps/electron/**/*", "server/**/*", "web/**/*", "client/**/*"]) assert.ok(manifest.build.files.includes(path));
  assert.ok(manifest.build.extraResources.some(item => item.from === "scripts/migrate-data-home.mjs"), "the one-time data migration script ships outside the asar");
  const source = await readFile(new URL("../apps/electron/main.mjs", import.meta.url), "utf8");
  assert.match(source, /app\.isPackaged \? app\.getAppPath\(\) : sourceRoot/);
  assert.match(source, /fork\(join\(root, "server\/index\.mjs"\)/);
  assert.match(source, /ELECTRON_RUN_AS_NODE: "1"/);
  assert.doesNotMatch(source, /utilityProcess/);
  const server = await readFile(new URL("../server/index.mjs", import.meta.url), "utf8");
  assert.match(server, /const candidateBootstrapToken = process\.env\.AGENTFORGE_BOOTSTRAP_TOKEN;\s*delete process\.env\.AGENTFORGE_BOOTSTRAP_TOKEN;/);
  assert.match(source, /X-AgentForge-Bootstrap/);
  assert.doesNotMatch(source, /setup\?token=/);
  const packagedCheck = await readFile(new URL("../scripts/test-packaged-electron.mjs", import.meta.url), "utf8");
  assert.match(packagedCheck, /\["--verify", "--deep", "--strict", appBundle\]/);
  assert.match(packagedCheck, /assert\.rejects\(execute\("\/usr\/bin\/codesign"/);
  assert.ok(packagedCheck.indexOf('"--strict", appBundle') < packagedCheck.indexOf("await electron.launch"));
});

test("packaging stops before builder when the locked Electron installer is unavailable", async () => {
  await mkdir(new URL("../.data/", import.meta.url), { recursive: true });
  const fixture = await mkdtemp(new URL("../.data/electron-installer-failure-", import.meta.url));
  try {
    await writeFile(join(fixture, "package.json"), await readFile(new URL("../package.json", import.meta.url)));
    await assert.rejects(promisify(execFile)("npm", ["run", "package:mac"], { cwd: fixture }),
      (error) => error.code === 1 && /Cannot find module/.test(error.stderr) && !/>\s*electron-builder/.test(error.stdout));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release lockfile includes optional signing dependencies on every build platform", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  for (const name of ["@electron/windows-sign", "@electron/windows-sign/node_modules/fs-extra", "cross-dirname", "postject", "postject/node_modules/commander"]) {
    assert.ok(lock.packages[`node_modules/${name}`]?.integrity, `missing locked signing dependency: ${name}`);
  }
});

test("macOS GitHub Release workflow is manual, verified, and explicit about Beta trust", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-macos-beta.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  push:/);
  assert.match(workflow, /confirmation:/);
  assert.match(workflow, /UNSIGNED_BETA/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /permissions:\n      contents: write/);
  assert.match(workflow, /runs-on: macos-14/);
  assert.match(workflow, /git show-ref --tags --verify --quiet/);
  assert.match(workflow, /Release tag must match package\.json version/);
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /NOT Developer ID signed or Apple notarized/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run check:impact/);
  assert.match(workflow, /npm run package:mac/);
  assert.match(workflow, /npm run package:mac:check/);
  assert.match(workflow, /shasum -a 256/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /release-artifact-id: \$\{\{ steps\.release-artifact\.outputs\.artifact-id \}\}/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /ARTIFACT_ID: \$\{\{ needs\.build\.outputs\.release-artifact-id \}\}/);
  const cleanup = workflow.slice(workflow.indexOf('      - name: Remove transferred artifact'));
  assert.ok(workflow.indexOf('gh release create') < workflow.indexOf('      - name: Remove transferred artifact'));
  assert.doesNotMatch(cleanup, /always\(\)|continue-on-error|--paginate|releases\/assets/);
  assert.match(cleanup, /\^\[0-9\]\+\$/);
  assert.match(cleanup, /gh api --method DELETE "repos\/\$GH_REPO\/actions\/artifacts\/\$ARTIFACT_ID"/);
  assert.match(workflow, /retention-days: 1/);
});

test("release artifact cleanup accepts only its exact numeric build output", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-macos-beta.yml", import.meta.url), "utf8");
  const script = workflow.slice(workflow.indexOf('      - name: Remove transferred artifact')).split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const run = promisify(execFile);
  const command = 'gh() { printf "<%s>\\n" "$@"; };\n' + script;
  const env = { ...process.env, GH_REPO: 'fixture/agentforge', ARTIFACT_ID: '123456' };
  const result = await run('bash', ['-e', '-c', command], { env });
  assert.equal(result.stdout, '<api>\n<--method>\n<DELETE>\n<repos/fixture/agentforge/actions/artifacts/123456>\n');
  for (const id of ['', 'all', '../releases', '123/456', '123; echo unexpected']) {
    await assert.rejects(run('bash', ['-e', '-c', command], { env: { ...env, ARTIFACT_ID: id } }), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '', 'invalid IDs must never invoke gh');
      assert.match(error.stderr, /Missing exact build artifact ID/);
      return true;
    });
  }
});

test("GitHub quality workflow installs the supported runtime before desktop checks", async () => {
  const workflow = await readFile(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8");
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /cache: npm/);
  assert.match(workflow, /- run: npm ci/);
  assert.match(workflow, /- run: npm run desktop:check/);
});

test("workspace copy writes the exact path and rejects unrelated frames", async () => {
  const source = await readFile(new URL("../apps/electron/main.mjs", import.meta.url), "utf8");
  const code = source.slice(source.indexOf('  ipcMain.handle("desktop:workspace:copy-path"'), source.indexOf("  ipcMain.handle('desktop:cli:status'"));
  let handler, copied;
  const controlOrigin = "http://127.0.0.1:51983";
  const mainFrame = { url: `${controlOrigin}/runs/run_one` }, contents = { mainFrame };
  vm.runInNewContext(code, { ipcMain: { handle: (_name, fn) => { handler = fn; } }, contents, controlOrigin, isConsoleURL, URL, clipboard: { writeText: text => { copied = text; } } });
  const event = { sender: contents, senderFrame: mainFrame };
  const path = "/Users/test/workspaces/任务/run_one";
  assert.equal(handler(event, path), true);
  assert.equal(copied, path);
  assert.throws(() => handler({ ...event, senderFrame: { ...mainFrame } }, path));
  assert.throws(() => handler({ ...event, sender: {} }, path));
  for (const url of [`${controlOrigin}/settings/general`, "https://example.com/runs/one"]) {
    mainFrame.url = url;
    assert.throws(() => handler(event, path));
  }
  assert.equal(copied, path);
});

test("all Chromium persistent and diagnostic paths stay in the instance data root",async()=>{
  const paths=desktopBrowserPaths('/fixture/.agentforge/desktop');
  assert.deepEqual(paths,{userData:'/fixture/.agentforge/desktop/browser',sessionData:'/fixture/.agentforge/desktop/browser',logs:'/fixture/.agentforge/desktop/electron-logs',crashDumps:'/fixture/.agentforge/desktop/crash-dumps'});
  assert.throws(()=>desktopBrowserPaths('relative'),/绝对路径/);
  const source=await readFile(new URL('../apps/electron/main.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('app.setPath(name,path)')<source.indexOf('app.whenReady'));
});
