const { contextBridge, ipcRenderer } = require("electron");

// Closed host operations. Main validates frame/route; install requires native consent.
if (process.isMainFrame && /^http:\/\/127\.0\.0\.1:\d+$/.test(location.origin)) {
  // Native tray clicks do not enter Chromium's pointer modality. Suppress only
  // the restored navigation ring, without moving focus or touching text fields.
  let restoredNavigation = null;
  const clearRestoredFocus = () => {
    restoredNavigation?.removeAttribute("data-desktop-restored-focus");
    restoredNavigation = null;
  };
  ipcRenderer.on("desktop:tray-restore", () => {
    clearRestoredFocus();
    const active = document.activeElement;
    if (active?.matches(".nav-item")) {
      restoredNavigation = active;
      active.setAttribute("data-desktop-restored-focus", "");
    }
  });
  window.addEventListener("keydown", event => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) clearRestoredFocus();
  }, true);
  window.addEventListener("pointerdown", clearRestoredFocus, true);
  document.addEventListener("focusout", event => {
    if (event.target === restoredNavigation) clearRestoredFocus();
  }, true);
  contextBridge.exposeInMainWorld("agentforgeDesktop", Object.freeze({
    copyWorkspacePath: (text) => ipcRenderer.invoke("desktop:workspace:copy-path", text),
    getPreferences: () => ipcRenderer.invoke("desktop:preferences:get"),
    setCloseMode: (mode) => ipcRenderer.invoke("desktop:preferences:set", mode),
    getCliInstallation: () => ipcRenderer.invoke("desktop:cli:status"),
    installCli: () => ipcRenderer.invoke("desktop:cli:install")
  }));
}
