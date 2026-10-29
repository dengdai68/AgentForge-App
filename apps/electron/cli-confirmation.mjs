import { fileURLToPath } from "node:url";

// This window belongs to main, not to the authenticated Console renderer. The
// only result is one fixed choice from its exact trusted local main frame.
export function confirmCliInstallation({ BrowserWindow, parent, status, signal }) {
  if (signal?.aborted || parent.isDestroyed()) return Promise.resolve(false);
  const page = new URL("./cli-confirmation.html", import.meta.url);
  page.searchParams.set("commandPath", status.commandPath);
  for (const path of status.profilePaths) page.searchParams.append("profilePath", path);
  const allowedFiles = new Set([
    new URL("./cli-confirmation.html", import.meta.url).href,
    new URL("./cli-confirmation.js", import.meta.url).href,
    new URL("./cli-confirmation.css", import.meta.url).href,
    new URL("./compact.css", import.meta.url).href,
  ]);
  const dialog = new BrowserWindow({
    parent, modal: true, show: false, width: 560, height: 470,
    minWidth: 420, minHeight: 360, resizable: true, minimizable: false,
    maximizable: false, fullscreenable: false, title: "安装 AgentForge CLI",
    backgroundColor: "#ffffff", autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, partition: "agentforge-cli-confirmation" },
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
    function finish(accepted = false) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      parent.off("closed", cancel);
      if (!dialog.isDestroyed()) dialog.destroy();
      resolve(accepted);
    }
    const cancel = () => finish(false);
    signal?.addEventListener("abort", cancel, { once: true });
    parent.once("closed", cancel);
    dialog.once("closed", cancel);
    contents.once("render-process-gone", cancel);
    contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) cancel(); });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame || contents.mainFrame.url !== url) return;
      try {
        const selected = new URL(url), choice = selected.hash; selected.hash = "";
        if (selected.href !== page.href || !["#install", "#cancel"].includes(choice)) return;
        finish(choice === "#install");
      } catch { /* no result from an invalid URL */ }
    });
    dialog.once("ready-to-show", () => { if (!settled) { dialog.show(); dialog.focus(); } });
    if (signal?.aborted || parent.isDestroyed()) cancel();
    else void dialog.loadFile(fileURLToPath(new URL("./cli-confirmation.html", import.meta.url)), {
      search: page.search,
    }).catch(cancel);
  });
}
