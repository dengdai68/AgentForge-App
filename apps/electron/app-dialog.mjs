import { fileURLToPath } from "node:url";

// Main-owned app-styled confirmation/notice window, replacing system dialogs.
// The only result is one fixed button index from its exact trusted local main
// frame. The content height is measured before first paint and the window is
// sized to it, so the dialog never shows scrollbars. There is no parent-ratio
// cap: the only ceiling is the screen work area (minus a margin), supplied by
// the caller as workAreaHeight. When the measured height would exceed that
// ceiling the window first widens (wrapping shrinks the content) and measures
// again before the final height is set. Content taller than the physical work
// area is outside the reach of every current call site (log paths and origins)
// and is documented as a limit rather than clipped into a false "fits".
const WIDTH = 480, MAX_WIDTH = 720, MIN_HEIGHT = 148, WORK_AREA_MARGIN = 64;
const MEASURE = "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)";

export function showAppDialog({ BrowserWindow, parent = null, kind = "question", title, message, detail = "", buttons, defaultIndex = 0, cancelIndex = buttons.length - 1, signal, workAreaHeight }) {
  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.some(label => typeof label !== "string" || !label)) throw new Error("对话框按钮无效");
  for (const index of [defaultIndex, cancelIndex]) if (!Number.isInteger(index) || index < 0 || index >= buttons.length) throw new Error("对话框按钮索引无效");
  if (signal?.aborted || parent?.isDestroyed()) return Promise.resolve(cancelIndex);
  const page = new URL("./app-dialog.html", import.meta.url);
  page.searchParams.set("kind", kind === "error" ? "error" : "question");
  page.searchParams.set("title", title);
  page.searchParams.set("message", message);
  if (detail) page.searchParams.set("detail", detail);
  page.searchParams.set("default", String(defaultIndex));
  page.searchParams.set("cancel", String(cancelIndex));
  for (const label of buttons) page.searchParams.append("button", label);
  const allowedFiles = new Set([
    new URL("./app-dialog.html", import.meta.url).href,
    new URL("./app-dialog.js", import.meta.url).href,
    new URL("./app-dialog.css", import.meta.url).href,
    new URL("./compact.css", import.meta.url).href,
  ]);
  const dialog = new BrowserWindow({
    ...(parent ? { parent, modal: true } : {}),
    show: false, width: WIDTH, height: MIN_HEIGHT,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: String(title), backgroundColor: "#ffffff", autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, partition: "agentforge-app-dialog" },
  });
  const contents = dialog.webContents;
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    let permitted = false;
    try {
      const resource = new URL(details.url); resource.search = ""; resource.hash = "";
      permitted = allowedFiles.has(resource.href);
    } catch { /* malformed and non-file requests are denied */ }
    callback({ cancel: !permitted });
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-redirect", "will-attach-webview"]) contents.on(event, event => event.preventDefault());
  return new Promise(resolve => {
    let settled = false;
    function finish(choice = cancelIndex) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      parent?.off("closed", cancel);
      if (!dialog.isDestroyed()) dialog.destroy();
      resolve(choice);
    }
    const cancel = () => finish(cancelIndex);
    signal?.addEventListener("abort", cancel, { once: true });
    parent?.once("closed", cancel);
    dialog.once("closed", cancel);
    contents.once("render-process-gone", cancel);
    contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) cancel(); });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame || contents.mainFrame.url !== url) return;
      try {
        const selected = new URL(url), choice = selected.hash; selected.hash = "";
        if (selected.href !== page.href) return;
        const match = /^#choice-(\d+)$/.exec(choice);
        if (!match) return;
        const index = Number(match[1]);
        if (index >= buttons.length) return;
        finish(index);
      } catch { /* no result from an invalid URL */ }
    });
    dialog.once("ready-to-show", () => {
      if (settled) return;
      // Size the window to the measured content so nothing scrolls or clips.
      const ceiling = () => {
        const workArea = Number(workAreaHeight?.());
        return Number.isFinite(workArea) && workArea > 0 ? Math.max(MIN_HEIGHT, Math.floor(workArea) - WORK_AREA_MARGIN) : Number.POSITIVE_INFINITY;
      };
      const show = () => { dialog.show(); dialog.focus(); };
      const sizeTo = (width, measured) => {
        const height = Math.max(MIN_HEIGHT, Math.min(Math.ceil(Number(measured) || MIN_HEIGHT), ceiling()));
        dialog.setContentSize(width, height);
        return height;
      };
      void contents.executeJavaScript(MEASURE).then(measured => {
        if (settled || dialog.isDestroyed()) return;
        const parentWidth = parent && !parent.isDestroyed() ? Number(parent.getContentSize()[0]) : 0;
        const wideWidth = Math.min(parentWidth > 48 ? parentWidth - 48 : MAX_WIDTH, MAX_WIDTH);
        if (Math.ceil(Number(measured) || MIN_HEIGHT) > ceiling() && wideWidth > WIDTH) {
          // Too tall at the default width: widen first (wrapping shrinks the
          // content), then measure again before fixing the final height.
          sizeTo(wideWidth, measured);
          void contents.executeJavaScript(MEASURE).then(remeasured => {
            if (settled || dialog.isDestroyed()) return;
            sizeTo(wideWidth, remeasured);
            show();
          }, () => { if (!settled && !dialog.isDestroyed()) show(); });
          return;
        }
        sizeTo(WIDTH, measured);
        show();
      }, () => { if (!settled && !dialog.isDestroyed()) show(); });
    });
    if (signal?.aborted || parent?.isDestroyed()) cancel();
    else void dialog.loadFile(fileURLToPath(new URL("./app-dialog.html", import.meta.url)), {
      search: page.search,
    }).catch(cancel);
  });
}
