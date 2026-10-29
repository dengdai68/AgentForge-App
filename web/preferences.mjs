// Browser-container presentation only. Never put credentials or domain facts here.
export const PREFERENCES_KEY = "agentforge.presentation.v1";
export const NAVIGATION = [
  { id: "overview", label: "总览", group: "OPERATIONS" },
  { id: "tasks", label: "任务中心", group: "OPERATIONS" },
  { id: "communication", label: "沟通", group: "OPERATIONS" },
  { id: "teams", label: "团队", group: "OPERATIONS" },
  { id: "workflows", label: "工作流", group: "OPERATIONS" },
  { id: "agents", label: "数字员工", group: "BUILD" },
  { id: "mcp-marketplace", label: "MCP 市场", group: "BUILD" },
  { id: "marketplace", label: "插件市场", group: "BUILD" },
  { id: "manual", label: "开发手册", group: "REFERENCE" },
];

export const DIRECTORY_THEMES = [
  { id: "vscode-light", label: "VS Code 图标 · 浅色", description: "vscode-icons 彩色文件/文件夹图标，文件内容保持浅色代码配色。" },
  { id: "vscode-dark", label: "VS Code 图标 · 深色", description: "同样的 vscode-icons 图标，选中文件的内容区使用深色代码配色（仅工作目录预览区）。" },
  { id: "classic", label: "经典", description: "不加彩色图标的文字符号与原有配色，作为低装饰回退。" },
];
const DIRECTORY_THEME_IDS = new Set(DIRECTORY_THEMES.map((theme) => theme.id));

export function normalizePreferences(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) && [1, 2].includes(value.version) ? value : {};
  return {
    version: 2,
    theme: input.theme === "minimal" ? "minimal" : "warm",
    hiddenViews: NAVIGATION.filter(({ id }) => ["overview", "manual"].includes(id) && input.version !== 2 ? true : Array.isArray(input.hiddenViews) && input.hiddenViews.includes(id)).map(({ id }) => id),
    showGroups: input.showGroups !== false,
    showIcons: input.showIcons !== false,
    showCounts: input.showCounts !== false,
    showUnread: input.showUnread !== false,
    directoryTheme: DIRECTORY_THEME_IDS.has(input.directoryTheme) ? input.directoryTheme : "vscode-light",
  };
}

export function readPreferences(getStorage = () => window.localStorage) {
  try { return normalizePreferences(JSON.parse(getStorage().getItem(PREFERENCES_KEY))); }
  catch { return normalizePreferences(null); }
}

export function savePreferences(value, getStorage = () => window.localStorage) {
  try { getStorage().setItem(PREFERENCES_KEY, JSON.stringify(normalizePreferences(value))); return true; }
  catch { return false; }
}

export function applyPreferences(document, value) {
  const preferences = normalizePreferences(value);
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.navGroups = preferences.showGroups ? "show" : "hide";
  root.dataset.navIcons = preferences.showIcons ? "show" : "hide";
  root.dataset.navCounts = preferences.showCounts ? "show" : "hide";
  root.dataset.navUnread = preferences.showUnread ? "show" : "hide";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", preferences.theme === "minimal" ? "#f7f8f6" : "#faf9f5");
  for (const item of document.querySelectorAll(".sidebar .nav-item[data-view]")) {
    item.hidden = preferences.hiddenViews.includes(item.dataset.view);
  }
  for (const group of document.querySelectorAll("[data-navigation-group]")) {
    group.hidden = [...group.querySelectorAll(".nav-item")].every((item) => item.hidden);
  }
}
