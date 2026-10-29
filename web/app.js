import { disposeManualGraphs, disposeWorkflowGraphs, fitManualGraph, mountManualGraph, mountWorkflowGraph, zoomManualGraph } from "./manual-graphs.mjs";
import { createCommunicationUI, formatCommunicationContent, memberMentionMarkup } from "./communication.js";
import { applyPreferences, normalizePreferences, PREFERENCES_KEY, readPreferences, savePreferences } from "./preferences.mjs";
import { createSettingsUI } from "./settings.mjs";
import { createMarketplaceUI, createMcpMarketplaceUI } from "./marketplace.mjs";
import { paginate, paginationMarkup } from "./pagination.mjs";
import { consoleContentTokens, editDiff, isShellTool, shellCommandText, shellTokens, toolCommandSummary, toolEditInput, toolFileInput, workingDirectoryIcon } from "/client/console-projections.mjs";
import { EVENT_KIND_LABEL as KIND_LABEL, STATUS_TEXT as statusText, buildConsoleEntries, classifyEvent, collaborationRecords, displayText, formatExactTime as exactTime, formatRelativeTime as timeAgo, isTransportFrame, mentionables, providerLabel, roleExecutionStatus, taskActionLabel, taskMatchesFilter, taskNeedsAttention, workspaceAgents, workflowFocus } from "/client/console-projections.mjs";

/* AgentForge Console：任务空间信息架构 + 轻盈视觉系统。
   视图：overview / tasks / teams / agents / workspace（任务空间仅从任务中心进入）。 */
function routeFromLocation() {
  const settings = location.pathname.match(/^\/settings(?:\/(general|appearance|workspace|cli|repositories|runtime|plugins|logs))?$/);
  if (settings) return { view: "settings", runId: null, settingsPage: settings[1] || "general" };
  const chat = location.pathname.match(/^\/communication(?:\/([^/]+))?$/);
  if (chat) return { view: "communication", runId: null, chatId: chat[1] || null };
  const match = location.pathname.match(/^\/runs\/([^/]+)$/);
  if (match) return { view: "workspace", runId: decodeURIComponent(match[1]) };
  const manualMatch = location.pathname.match(/^\/manual\/(data-model|system-architecture|task-flow)$/);
  if (manualMatch) return { view: "manual", runId: null, manualPage: manualMatch[1] };
  if (location.pathname === "/tasks/archive") return { view: "tasks", runId: null, taskArchiveView: true };
  const view = location.pathname.replace(/^\//, "") || location.hash.slice(1) || "tasks";
  return { view: ["overview", "tasks", "teams", "workflows", "agents", "manual", "marketplace", "mcp-marketplace"].includes(view) ? view : "tasks", runId: null, manualPage: "data-model" };
}
const initialRoute = routeFromLocation();
const state = {
  agents: [], teams: [], tasks: [], runs: [], events: [], workflowTemplates: [],
  workspace: null, selectedRunId: initialRoute.runId, selectedAgentId: null,
  taskSearch: { name: "", status: "all", teamId: "" }, taskArchiveView: Boolean(initialRoute.taskArchiveView),
  currentView: initialRoute.view, manualPage: initialRoute.manualPage || "data-model",
  settingsPage: initialRoute.settingsPage || "general",
  selectedChatId: initialRoute.chatId || null,
  eventSource: null, listPages: { tasks: 1, archive: 1, teams: 1, workflows: 1, agents: 1 },
};
// Local interaction state is scoped to a Run; it never changes domain state.
const workspaceViews = new Map();
const consolePages = new Map();
const vendorLoads = new Map();
function loadVendor(name) {
  if (!vendorLoads.has(name)) vendorLoads.set(name, new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = `/vendor/${name}.js`; script.async = true;
    script.onload = resolve; script.onerror = () => { script.remove(); vendorLoads.delete(name); reject(new Error("展示组件加载失败，请刷新重试")); };
    document.head.append(script);
  }));
  return vendorLoads.get(name);
}
let workspaceRequest = 0;
let workspaceRefreshTimer;
let consoleRenderTimer;
let bootstrapPromise;
let resetRequestActive = false;
function consolePage(runId, agentId) {
  const key = `${runId}:${agentId}`;
  if (!consolePages.has(key)) consolePages.set(key, { events: [], loaded: false, loading: false, hasMore: false, nextBefore: null, request: 0, traceId: null });
  return consolePages.get(key);
}
function workspaceView(runId = state.selectedRunId) {
  if (!workspaceViews.has(runId)) workspaceViews.set(runId, { draft: "", disclosures: {}, consoleViews: new Map(), collaborationFilter: "all", collaborationScroll: null, directory: null, directoryRequest: 0, fileRequest: 0, selectedPath: null, filePreview: null, directoryOpen: Object.create(null), directoryScroll: Object.create(null), changes: null, changesLoading: false, changesRequest: 0, diffRequest: 0, selectedDiffPath: null, diffPreview: null, tab: "collaboration" });
  return workspaceViews.get(runId);
}
function retryableDispatches(workspace = {}) {
  const run = workspace.run;
  if (!run || run.task?.archivedAt) return [];
  return (workspace.dispatches || []).filter((item) => item.status === "queued" && item.nextRetryAt && (["planning", "running", "review"].includes(run.status) || item.interactionOnly));
}
function failedRunRecovery(workspace = {}) {
  const run = workspace.run;
  if (!run || run.status !== "failed" || run.task?.archivedAt) return null;
  if (run.failure?.phase === "workspace_baseline_missing") return null;
  const nodeIds = [...new Set((workspace.traces || []).filter((trace) => trace.status === "failed" && ["node", "instruction", "consultation"].includes(trace.type)).map((trace) => trace.workflowNodeId))];
  return nodeIds.length ? { type: "node", nodeIds } : { type: "orchestration", nodeIds: [] };
}
function failedRunMessage(workspace = {}) {
  const failure = workspace.run?.failure;
  if (failure?.message) return failure.message;
  return failedRunRecovery(workspace)?.type === "node"
    ? "已有失败的业务 Trace；请选择需要由项目经理重新评估的职责。"
    : "本轮没有完成；请查看保留的 Trace 与协作记录。";
}
function acceptanceReview(workspace = {}, { history = false } = {}) {
  const run = workspace.run;
  if (!run || !(history ? ["awaiting_acceptance", "completed"].includes(run.status) : run.status === "awaiting_acceptance" && !run.task?.archivedAt)) return null;
  const review = run.deliveryReview && typeof run.deliveryReview === "object" && !Array.isArray(run.deliveryReview) ? run.deliveryReview : {};
  const findings = run.acceptanceRequest?.summary ? [run.acceptanceRequest.summary] : Array.isArray(review.findings)
    ? review.findings.filter((finding) => typeof finding === "string" && finding.trim()).map((finding) => finding.trim())
    : [];
  const criteria = Array.isArray(run.task?.acceptanceCriteria)
    ? run.task.acceptanceCriteria.filter((criterion) => typeof criterion === "string" && criterion.trim()).map((criterion) => criterion.trim())
    : [];
  const artifacts = workspace.artifacts || [];
  const reviewTrace = (workspace.traces || []).find((trace) => trace.id === (run.acceptanceRequest?.traceId || review.traceId)) || (workspace.traces || []).find((trace) => trace.type === "delivery_review" && trace.status === "completed");
  return {
    verified: true,
    findings,
    criteria,
    artifactCount: artifacts.length,
    reviewTraceId: reviewTrace?.id || null,
  };
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const pill = (status) => `<span class="status-pill ${esc(status)}">${statusText[status] || status}</span>`;
const roleColor = (agent) => `color-${agent?.color || "system"}`;
const initialsOf = (agent) => agent?.initials || (agent?.name || "?").slice(0, 1);
const workspaceSummary = (task = {}) => task.workspaceKind === "managed" ? "系统受管目录" : "既有工作目录";

// Frozen user requirements remain visible at human confirmation.
function acceptanceCriteriaMarkup(acceptance) {
  const standards = acceptance.criteria.length ? `<ul>${acceptance.criteria.map((criterion) => `<li>${esc(criterion)}</li>`).join("")}</ul>` : "<p>此任务没有单独记录验收标准。</p>";
  return standards;
}


/* ---------- API ---------- */
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (response.status === 401) { if (!resetRequestActive) location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); throw new Error("登录已失效，请重新登录"); }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}
async function refresh({ quiet = false } = {}) {
  try {
    if (!bootstrapPromise) bootstrapPromise = api("/api/bootstrap").finally(() => { bootstrapPromise = null; });
    const result = await bootstrapPromise;
    try {
      const previous = localStorage.getItem("agentforge.installation");
      if (previous && previous !== result.installationId) { localStorage.removeItem(PREFERENCES_KEY); presentationPreferences = readPreferences(); applyPreferences(document, presentationPreferences); }
      if (result.installationId) localStorage.setItem("agentforge.installation", result.installationId);
    } catch { /* Storage may be unavailable in this container. */ }
    Object.assign(state, result);
    state.navigationNotifications = null;
    render();
    return true;
  } catch (error) {
    if (!quiet) toast(error.message, true);
    return false;
  }
}
const runOfTask = (taskId) => state.runs.find((run) => run.taskId === taskId || run.task?.id === taskId);
const communicationUI = createCommunicationUI({ api, notify: toast,
  renderConsole: (stream, result, agent) => {
    if (result.refresh) for (const cache of [consoleContentCache, promptSnapshotCache]) for (const key of cache.keys()) if (key.startsWith(result.basePath + '/')) cache.delete(key);
    renderChatStream(result.events.map(event => ({ ...event, contentBase: result.basePath })), agent, { stream, runId: null, traces: result.traces.map(trace => ({ ...trace, contentBase: result.basePath })), hasMore: result.hasMore });
  },
  onRead: () => refreshNavigation(),
  prepareContent: () => Promise.all([loadVendor("marked"), loadVendor("dompurify")]),
  renderContent: (content, mentions) => formatCommunicationContent(content, { parse: window.marked?.parse, sanitize: window.DOMPurify?.sanitize, mentions }),
  navigate: (id) => { state.selectedChatId = id; setView("communication"); }
});
let presentationPreferences = readPreferences();
applyPreferences(document, presentationPreferences);
const mcpMarketplaceUI = createMcpMarketplaceUI({api, esc, openModal, closeModal, confirmDialog, toast});
const marketplaceUI = createMarketplaceUI({api, esc, openModal, closeModal, confirmDialog, toast});
const settingsUI = createSettingsUI({
  api, notify: toast, clearInvalid, setInvalid,
  openModal, closeModal, confirmDialog,
  onResetStarted: () => { resetRequestActive = true; $("#modal-close").disabled = true; state.eventSource?.close(); communicationUI.unmount(); },
  onResetFailed: () => { resetRequestActive = false; $("#modal-close").disabled = false; },
  onDataReset: (next) => { try { localStorage.removeItem(PREFERENCES_KEY); } catch {} location.replace(next); },
  onWorkspaceSaved: (settings) => { state.settings = settings; },
  navigate: (page) => { state.settingsPage = page; setView("settings"); },
  getPreferences: () => presentationPreferences,
  updatePreferences: (value) => {
    presentationPreferences = normalizePreferences(value);
    applyPreferences(document, presentationPreferences);
    return savePreferences(presentationPreferences);
  },
});
window.addEventListener("storage", (event) => {
  if (event.key !== PREFERENCES_KEY && event.key !== null) return;
  presentationPreferences = readPreferences();
  applyPreferences(document, presentationPreferences);
  settingsUI.syncPreferences();
});

/* ---------- 反馈 ---------- */
let toastTimer;
function toast(message, isError = false) {
  const box = $("#toast");
  box.textContent = message;
  box.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = "toast"; }, 3600);
}
function openModal(content) {
  modalCancel?.(); modalCancel = null;
  disposeWorkflowGraphs("details");
  $("#modal-content").closest(".modal")?.classList.remove("workflow-detail-modal", "workflow-editor-modal", "team-config-modal", "employee-config-modal", "extension-detail-modal", "confirm-dialog");
  $("#modal-content").innerHTML = content;
  // Shared semantic grouping; Web keeps display:contents, desktop bounds body scrolling.
  const host = $("#modal-content"), container = host.querySelector(":scope > form") || host;
  const actions = container.querySelector(":scope > .form-actions");
  if (actions) {
    const body = document.createElement("div");
    body.className = "modal-scroll";
    const children = [...container.children].filter((child) => child !== actions && (container !== host || !child.matches("h2, .modal-intro")));
    children.forEach((child) => body.append(child));
    container.insertBefore(body, actions);
  }
  $("#modal-backdrop").classList.add("open");
  $("#modal-backdrop").setAttribute("aria-hidden", "false");
  $("#modal-backdrop").scrollTop = 0;
  $("#modal-content").closest(".modal").scrollTop = 0;
  $("#modal-content").querySelector("input, textarea, select, button:not(.modal-close)")?.focus();
}
function closeModal() {
  if (resetRequestActive) return;
  disposeWorkflowGraphs("details");
  $("#modal-content").closest(".modal")?.classList.remove("workflow-detail-modal", "workflow-editor-modal", "team-config-modal", "employee-config-modal", "extension-detail-modal", "confirm-dialog");
  $("#modal-backdrop").classList.remove("open");
  $("#modal-backdrop").setAttribute("aria-hidden", "true");
  $("#modal-content").replaceChildren();
  const cancel = modalCancel; modalCancel = null;
  cancel?.();
}
// Promise-style in-app confirmation; short content only, no scrolling body.
// Escape, backdrop click and the close button all resolve as cancelled.
let modalCancel = null;
function confirmDialog({ title, message, confirmLabel = "确认", danger = false }) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2><p class="modal-intro confirm-dialog-message">${esc(message)}</p><div class="confirm-dialog-actions"><button class="ghost-button" type="button" data-confirm-dialog-cancel>取消</button><button class="${danger ? "small-button danger" : "primary-button"}" type="button" data-confirm-dialog-accept>${esc(confirmLabel)}</button></div>`);
    $("#modal-content").closest(".modal")?.classList.add("confirm-dialog");
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      modalCancel = null;
      resolve(accepted);
    };
    modalCancel = () => finish(false);
    $("#modal-content").querySelector("[data-confirm-dialog-cancel]").addEventListener("click", () => { finish(false); closeModal(); });
    $("#modal-content").querySelector("[data-confirm-dialog-accept]").addEventListener("click", () => { finish(true); closeModal(); });
  });
}
function clearInvalidField(input) {
  const field = input.closest(".form-field");
  if (!field) return;
  field.classList.remove("invalid");
  const error = field.querySelector(".field-error");
  if (error) error.textContent = "";
}
function setInvalid(input, message) {
  const field = input.closest(".form-field");
  if (!field) return;
  field.classList.add("invalid");
  const error = field.querySelector(".field-error");
  if (error) error.textContent = message;
  field.scrollIntoView?.({ block: "nearest" });
  const events = input.matches("input, textarea") ? ["input", "change"] : ["change"];
  const clear = () => {
    for (const eventName of events) input.removeEventListener(eventName, clear);
    clearInvalidField(input);
  };
  for (const eventName of events) input.addEventListener(eventName, clear);
}
function clearInvalid(form) {
  form.querySelectorAll(".form-field.invalid").forEach((field) => {
    field.classList.remove("invalid");
    const error = field.querySelector(".field-error");
    if (error) error.textContent = "";
  });
}

/* ---------- 壳层 ---------- */
function renderShell() {
  const attentionRuns = state.runs.filter((run) => !run.task?.archivedAt && taskNeedsAttention(run.status));
  const count = state.navigationNotifications?.taskAttentionCount ?? new Set(attentionRuns.map(run => run.taskId)).size;
  $("#nav-task-count").textContent = count;
  $("#nav-task-count").hidden = !count;
  $("#nav-task-count").setAttribute("aria-label", `${count} 项待你处理`);
  const unread = state.navigationNotifications?.communicationUnreadCount ?? state.communicationUnreadCount ?? 0;
  $("#nav-communication-count").textContent = unread;
  $("#nav-communication-count").hidden = !unread;
  $("#nav-communication-count").setAttribute("aria-label", `${unread} 条未读消息`);
  const taskHint = $("#nav-ws-hint");
  taskHint.style.display = count ? "" : "none";
  taskHint.textContent = "待你处理";
  const names = { overview: "总览", tasks: "任务中心", teams: "团队", workflows: "工作流", agents: "数字员工", manual: "开发手册", workspace: "任务空间", settings: "设置", marketplace: "插件市场", "mcp-marketplace": "MCP 市场" };
  $("#breadcrumb-current").textContent = state.currentView === "communication" ? "沟通"
    : state.currentView === "tasks" && state.taskArchiveView ? "归档历史" : names[state.currentView];
}

let navigationRequest = null;
async function refreshNavigation() {
  if (resetRequestActive || document.visibilityState === "hidden" || navigationRequest) return;
  navigationRequest = api("/api/notifications");
  try { state.navigationNotifications = await navigationRequest; renderShell(); }
  catch { /* Keep the last confirmed count until the next visible poll. */ }
  finally { navigationRequest = null; }
}

function setView(view, { replace = false, taskArchiveView = state.taskArchiveView } = {}) {
  if (view !== "communication") communicationUI.unmount();
  if (view !== "settings") settingsUI.unmount();
  if (view !== "mcp-marketplace") mcpMarketplaceUI.unmount();
  if (view !== "marketplace") marketplaceUI.unmount();
  if (view !== "workspace") {
    state.eventSource?.close(); state.eventSource = null;
    clearTimeout(workspaceRefreshTimer); clearTimeout(consoleRenderTimer);
    workspaceRefreshTimer = null; consoleRenderTimer = null;
    workspaceRequest++;
  }
  if (view !== "manual") disposeManualGraphs();
  if (view !== "workflows") disposeWorkflowGraphs("templates");
  if (view !== "workspace") disposeWorkflowGraphs("task");
  state.currentView = view;
  if (view === "tasks") state.taskArchiveView = Boolean(taskArchiveView);
  const path = view === "workspace" && state.selectedRunId ? `/runs/${encodeURIComponent(state.selectedRunId)}`
    : view === "communication" ? "/communication" + (state.selectedChatId ? "/" + encodeURIComponent(state.selectedChatId) : "")
    : view === "tasks" && state.taskArchiveView ? "/tasks/archive"
    : view === "settings" ? `/settings/${state.settingsPage}`
    : view === "manual" ? `/manual/${state.manualPage}` : `/${view}`;
  if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
  const navFor = view === "workspace" ? "tasks" : view; /* 任务空间从任务中心进入，高亮任务中心 */
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === navFor));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}-view`));
  render();
  if (view !== "workspace" && view !== "communication") refresh({ quiet: true });
  window.scrollTo({ top: 0 });
}

/* ---------- 总览 ---------- */
function renderOverview() {
  const active = state.runs.filter((run) => taskMatchesFilter(run.status, "active"));
  const attention = state.runs.filter((run) => taskNeedsAttention(run.status));
  const awaitingAcceptance = attention.filter((run) => run.status === "awaiting_acceptance").length;
  const attentionSummary = awaitingAcceptance
    ? `含 <b>${awaitingAcceptance}</b> 个待你验收`
    : attention.length ? `有 <b>${attention.length}</b> 个需要你处理` : "没有等待你的决策";
  const stats = [
    { label: "执行中 Run", value: active.length, sub: attentionSummary },
    { label: "已完成任务", value: state.tasks.filter((task) => task.status === "done").length, sub: `共 ${state.tasks.length} 个任务` },
    { label: "文件产物", value: state.runs.reduce((total, run) => total + (run.artifactCount || 0), 0), sub: "已接纳的 Run 内快照" },
    { label: "可用数字员工", value: state.agents.filter((agent) => agent.status === "active").length, sub: "可按需要编辑、停用或删除" },
  ];
  $("#stats-grid").innerHTML = stats.map((stat) => `
    <div class="stat-card"><div class="stat-top"><span>${stat.label}</span></div>
    <div class="stat-value">${stat.value}</div><div class="stat-sub">${stat.sub}</div></div>`).join("");

  const current = attention[0] || active[0];
  const currentNeedsAttention = current && taskNeedsAttention(current.status);
  $("#active-run-panel").innerHTML = `
    <div class="panel-header"><div><div class="panel-kicker">${currentNeedsAttention ? "NEEDS YOUR ACTION" : "ACTIVE RUN"}</div><h3 class="panel-title">${currentNeedsAttention ? "需要你处理" : "当前进行"}</h3></div>
    ${current ? `<button class="panel-link" data-open-run="${current.id}">${currentNeedsAttention ? taskActionLabel(current.status) : "进入任务空间"} →</button>` : ""}</div>
    ${current ? `<div class="run-card">
        <div class="run-card-top"><span class="run-name">${esc(current.task?.title || "执行中")}</span>${pill(current.status)}</div>
        <p class="run-objective">${esc(current.task?.objective || "")}</p>
        <div class="run-meta"><span>${statusText[current.status] || current.status} · ${current.traceCount || 0} 条 Trace · ${current.artifactCount || 0} 个文件</span><span>${esc(current.id)}</span></div>
      </div>` : `<div class="empty-state"><strong>没有进行中或待处理任务</strong>创建一个任务，AgentForge 会自动组建流程并开始交付。<br /><button class="primary-button compact" data-goto="tasks">去任务中心创建</button></div>`}`;

  const latest = state.events.slice(-6).reverse();
  $("#activity-panel").innerHTML = `
    <div class="panel-header"><div><div class="panel-kicker">SIGNAL</div><h3 class="panel-title">团队信号</h3></div></div>
    <div class="activity-list">${latest.length ? latest.map((event) => `
      <div class="activity-row">
        <div class="activity-avatar ${roleColor(event.actor)}">${esc((event.actor?.name || "AF").slice(0, 1))}</div>
        <div class="activity-copy"><p><strong>${esc(event.actor?.name || "AgentForge")}</strong> · ${esc(runtimeAuditText(event).slice(0, 56))}${runtimeAuditText(event).length > 56 ? "…" : ""}</p>
        <time>${timeAgo(event.timestamp)} · ${KIND_LABEL[classifyEvent(event)] || esc(event.type)}</time></div>
      </div>`).join("") : `<div class="empty-state" style="margin:0"><strong>暂无记录</strong>执行事件会出现在这里。</div>`}</div>`;

  const team = state.teams[0];
  $("#team-panel").innerHTML = `
    <div class="panel-header"><div><div class="panel-kicker">TEAM</div><h3 class="panel-title">${esc(team?.name || "团队")}</h3></div>
    <button class="panel-link" data-goto="teams">全部团队 →</button></div>
    <div class="panel-body">
      ${(team?.members || []).map((agent) => `
        <div class="member-row">
          <div class="member-avatar ${roleColor(agent)}">${esc(initialsOf(agent))}</div>
          <div><span class="member-name">${esc(agent.name)}</span><span class="member-role">${agent.type === "human" || agent.id === "human_operator" ? "本机人类" : providerLabel(agent)}</span></div>
          <span class="member-status">${agent.type === "human" || agent.id === "human_operator" ? "人类成员" : `● ${agent.status === "active" ? "可用" : "停用"}`}</span>
        </div>`).join("") || `<div class="empty-state" style="margin:0"><strong>还没有团队</strong>先创建业务数字员工，再组合成团队。</div>`}
      ${team ? `<div class="sysrole-note">每次 Run 冻结团队成员与所选项目经理；最终交付由人类确认。</div>` : ""}
    </div>`;

  $("#task-panel").innerHTML = `
    <div class="panel-header"><div><div class="panel-kicker">TASKS</div><h3 class="panel-title">最近任务</h3></div>
    <button class="panel-link" data-goto="tasks">任务中心 →</button></div>
    <div class="panel-body">
      ${[...state.tasks].sort((left, right) => Number(taskNeedsAttention(right.status)) - Number(taskNeedsAttention(left.status))).slice(0, 3).map((task) => `
        <button class="task-row" data-open-task="${task.id}" title="打开该任务的任务空间">
          <span class="task-priority ${taskNeedsAttention(task.status) ? "high" : ""}"></span>
          <span class="task-row-copy"><span class="task-row-title">${esc(task.title)}</span><span class="task-row-meta">${workspaceSummary(task)} · ${timeAgo(task.updatedAt)}</span></span>
          ${pill(task.status)}
        </button>`).join("") || `<div class="empty-state" style="margin:0"><strong>还没有任务</strong>从「新建任务」开始。</div>`}
    </div>`;
}

/* ---------- 任务中心 ---------- */
function taskMatchesSearch(task, { name = "", status = "all", teamId = "" } = {}) {
  return String(task.title || "").toLocaleLowerCase().includes(name.trim().toLocaleLowerCase())
    && (status === "all" || task.status === status)
    && (!teamId || (task.teamId || task.team?.id) === teamId);
}

function renderTasks() {
  closeTaskMenu();
  const activeTasks = state.tasks.filter((task) => !task.archivedAt);
  const archivedTasks = state.tasks.filter((task) => task.archivedAt);
  const archiveView = state.taskArchiveView;
  $("#tasks-heading").innerHTML = archiveView
    ? `<h2>归档历史</h2>` : `<h2>任务中心</h2>`;
  // Keep the form mounted so live refreshes preserve unsubmitted input and focus.
  const mountSearch = !$("#task-search-form");
  if (mountSearch) {
    const search = state.taskSearch || {};
    $("#task-filter-bar").innerHTML = `<form id="task-search-form" class="task-search-form" role="search" aria-label="搜索任务">
      <label class="task-search-name"><span class="sr-only">任务名称</span><input type="search" name="name" placeholder="任务名称" value="${esc(search.name || "")}" /></label>
      <label><span class="sr-only">任务状态</span><select name="status"><option value="all">全部状态</option>${["backlog", "planning", "running", "awaiting_human", "review", "awaiting_acceptance", "paused", "blocked", "failed", "done", "cancelled"].map((id) => `<option value="${id}" ${search.status === id ? "selected" : ""}>${statusText[id]}</option>`).join("")}</select></label>
      <label><span class="sr-only">团队</span><select name="teamId"><option value="">全部团队</option></select></label>
      <button type="submit" class="primary-button">搜索</button><button type="reset" class="ghost-button">重置</button>
      <span class="task-directory-actions"></span>
    </form>`;
  }
  const actionMarkup = archiveView
    ? `<button type="button" class="ghost-button" data-task-center-page="current">返回任务中心</button>`
    : `<button type="button" class="ghost-button" data-task-center-page="archive">归档历史</button><button type="button" class="primary-button" data-action="new-task">＋ 新建任务</button>`;
  const actionHost = $("#task-search-form .task-directory-actions");
  if (actionHost.innerHTML !== actionMarkup) actionHost.innerHTML = actionMarkup;
  const teamSelect = $("#task-search-form select[name='teamId']");
  const teams = new Map(state.tasks.map((task) => [task.teamId || task.team?.id, task.team?.name]).filter(([id]) => id));
  const options = `<option value="">全部团队</option>${[...teams].map(([id, name]) => `<option value="${esc(id)}">${esc(name || "未命名团队")}</option>`).join("")}`;
  if (teamSelect && teamSelect.innerHTML !== options) {
    const selected = mountSearch ? state.taskSearch?.teamId || "" : teamSelect.value;
    teamSelect.innerHTML = options;
    if (selected && !teams.has(selected)) teamSelect.add(new Option("团队已不在当前列表", selected));
    teamSelect.value = selected;
  }
  const rows = (archiveView ? archivedTasks : activeTasks).filter((task) => taskMatchesSearch(task, state.taskSearch)).sort((left, right) => archiveView ? new Date(right.archivedAt) - new Date(left.archivedAt) : new Date(right.updatedAt) - new Date(left.updatedAt));
  if (!rows.length) {
    $("#tasks-table").innerHTML = `<div class="empty-state" style="margin:20px"><strong>没有匹配的任务</strong>请调整搜索条件，或点击重置查看全部${archiveView ? "归档" : ""}任务。</div>`;
    return;
  }
  const pageKey = archiveView ? "archive" : "tasks";
  const page = paginate(rows, state.listPages[pageKey]);
  state.listPages[pageKey] = page.page;
 $("#tasks-table").innerHTML = `<table class="table task-inventory"><colgroup><col class="col-task" /><col class="col-team" /><col class="col-status" /><col class="col-updated" /><col class="col-actions" /></colgroup><thead><tr>
      <th>任务名称</th><th>团队</th><th>状态</th><th>${archiveView ? "归档时间" : "更新"}</th><th style="text-align:right">操作</th>
    </tr></thead><tbody>
    ${page.items.map((task) => {
      const run = runOfTask(task.id);
      const canDelete = task.deletionBlockedBy === null;
      const openAction = task.status === "backlog"
        ? `<button class="small-button" data-run-task="${task.id}">启动</button>` : "";
      const deleteAction = canDelete ? `<button class="small-button danger" data-delete-task="${task.id}">删除任务</button>` : "";
      const deletionNotice = task.deletionBlockedBy === "active_inquiries" ? `<span class="task-deletion-notice" title="请等待当前答疑完成后重试删除。">答疑进行中</span>` : "";
      const secondary = archiveView
        ? `<button class="small-button" data-unarchive-task="${task.id}">恢复任务</button>${deleteAction}`
        : `${task.status === "done" ? `<button class="small-button" data-archive-task="${task.id}">归档</button>` : ""}${deleteAction}`;
      const action = `${openAction}${deletionNotice}${secondary ? `<button type="button" class="small-button task-more-trigger" data-task-more aria-label="${esc(task.title)}的更多操作" aria-haspopup="menu" aria-expanded="false">更多 <span aria-hidden="true">⌄</span></button><template data-task-menu-content>${secondary}</template>` : ""}`;
      return `<tr>
        <td>${run ? `<button class="table-title task-title-link" data-open-task="${task.id}" title="${esc(task.title)}">${esc(task.title)}</button>` : `<span class="table-title">${esc(task.title)}</span>`}</td>
        <td><span class="team-name" title="${esc(task.team?.name || "")}">${esc(task.team?.name || "—")}</span></td>
        <td>${pill(task.status)}</td>
        <td style="white-space:nowrap" title="${esc(archiveView ? exactTime(task.archivedAt) : exactTime(task.updatedAt))}">${archiveView ? exactTime(task.archivedAt) : timeAgo(task.updatedAt)}</td>
        <td><div class="table-actions">${action}</div></td>
      </tr>`;
    }).join("")}</tbody></table>${paginationMarkup(page, pageKey)}`;
}

let taskMenu = null;
let taskMenuTrigger = null;
function closeTaskMenu() {
  taskMenu?.remove(); taskMenu = null;
  taskMenuTrigger?.setAttribute("aria-expanded", "false"); taskMenuTrigger = null;
}
function openTaskMenu(button) {
  if (taskMenuTrigger === button) { closeTaskMenu(); return; }
  closeTaskMenu();
  const template = button.parentElement.querySelector("[data-task-menu-content]");
  if (!template) return;
  const menu = document.createElement("div");
  menu.className = "task-actions-menu"; menu.setAttribute("role", "menu");
  menu.innerHTML = template.innerHTML.replaceAll('class="small-button', 'role="menuitem" class="task-menu-item small-button');
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const top = rect.bottom + 6 + menu.offsetHeight <= window.innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - menu.offsetHeight - 6);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  taskMenu = menu; taskMenuTrigger = button; button.setAttribute("aria-expanded", "true");
  menu.querySelector("button")?.focus();
}
window.addEventListener("keydown", (event) => { if (event.key === "Escape" && taskMenu) { const trigger = taskMenuTrigger; closeTaskMenu(); trigger?.focus(); } });
window.addEventListener("scroll", () => closeTaskMenu(), true);
window.addEventListener("resize", closeTaskMenu);

function renderListPager(key, page) {
  const grid = $(`#${key}-grid`);
  let pager = grid?.nextElementSibling;
  if (!pager?.matches(`[data-list-pager="${key}"]`)) {
    pager = document.createElement("div"); pager.dataset.listPager = key; grid.after(pager);
  }
  pager.innerHTML = paginationMarkup(page, key);
}

/* ---------- 团队 ---------- */
function renderTeams() {
  const query = ($("#teams-search")?.value || "").trim().toLocaleLowerCase();
  const rows = state.teams.filter(team => `${team.name} ${team.mission || ""}`.toLocaleLowerCase().includes(query));
  const page = paginate(rows, state.listPages.teams); state.listPages.teams = page.page;
  $("#teams-grid").innerHTML = page.items.map((team) => `
    <div class="team-card">
      <div class="team-card-header"><h3>${esc(team.name)}</h3><div class="directory-card-actions"><button class="small-button primary" data-chat-team="${team.id}">群聊</button><button class="small-button" data-edit-team="${team.id}">编辑</button><button class="small-button danger" data-delete-team="${team.id}">删除</button></div></div>
      <p>${esc(team.mission || "（未填写使命）")}</p>
      <div class="team-member-stack">${team.members.map((agent) => `<span class="stack-avatar ${roleColor(agent)}" title="${esc(agent.name)}">${esc(initialsOf(agent))}</span>`).join("")}</div>
      <div class="team-roles">${team.members.map((agent) => `<span class="capability">${esc(agent.name)}</span>`).join("")}</div>
      <div class="team-footer"><span>${team.members.length} 名团队成员（含人类）</span><span>经理：${esc(team.members.find((member) => member.id === team.managerAgentId)?.name || "项目经理")}</span></div>
    </div>`).join("") || (query ? `<div class="empty-state"><strong>没有匹配的团队</strong>请调整搜索条件。</div>` : `<div class="empty-state" style="margin:0"><strong>还没有团队</strong>点击右上角「创建团队」添加。</div>`);
  renderListPager("teams", page);
}

/* ---------- 工作流管理 ---------- */
function renderWorkflows() {
  disposeWorkflowGraphs("templates");
  const host = $("#workflows-grid");
  const query = ($("#workflows-search")?.value || "").trim().toLocaleLowerCase();
  const rows = state.workflowTemplates.filter(flow => `${flow.name} ${flow.description || ""}`.toLocaleLowerCase().includes(query));
  const page = paginate(rows, state.listPages.workflows); state.listPages.workflows = page.page;
  host.innerHTML = page.items.map((template) => {
    const referenceCount = state.tasks.filter((task) => task.workflowTemplateId === template.id).length;
    const deleteAction = !referenceCount ? `<button class="small-button danger" data-delete-workflow="${esc(template.id)}">删除</button>` : "";
    return `
    <article class="workflow-list-row">
      <div class="workflow-list-brief"><div><button class="workflow-title-button" data-workflow-details="${esc(template.id)}">${esc(template.name)}</button></div><p>${esc(template.description || "尚未填写说明")}</p><small>${template.nodes.length} 个节点 · ${template.nodes.filter((node) => !node.dependsOn?.length).length} 个起始节点${referenceCount ? ` · 已被 ${referenceCount} 个任务引用` : ""}</small></div>
      <div class="workflow-actions"><button class="small-button" data-workflow-details="${esc(template.id)}">查看详情</button><button class="small-button" data-edit-workflow="${esc(template.id)}">编辑</button>${deleteAction}</div>
   </article>`;
  }).join("") || (query ? `<div class="empty-state"><strong>没有匹配的工作流</strong>请调整搜索条件。</div>` : `<div class="empty-state"><strong>还没有工作流</strong>创建一个工作流，再把它用于新任务。</div>`);
  renderListPager("workflows", page);
}

function workflowDetails(template, { frozen = false } = {}) {
  openModal(`<h2>${esc(template.name)}</h2><p class="modal-intro">${esc(template.description || "工作流定义团队的职责与预期交接；项目经理根据实际交付推进协作。")}</p>
    ${frozen ? '<p class="field-hint">本任务创建时的工作流快照 · 只读</p>' : workflowDiagramCanvas("details", template.id, "职责交接总览", "workflow-template-viewport")}
    <div class="workflow-detail-body"><nav class="workflow-detail-nav" aria-label="工作流节点">${template.nodes.map((node, index) => `<button type="button" data-detail-node="${esc(node.id)}"><span>${String(index + 1).padStart(2, "0")}</span><div><strong>${esc(node.title)}</strong></div></button>`).join("")}</nav><section id="workflow-node-detail" aria-live="polite"></section></div>
    <div class="form-actions"><button class="ghost-button" data-close-modal>关闭</button>${frozen ? "" : `<button class="primary-button" data-edit-workflow="${esc(template.id)}">编辑工作流</button>`}</div>`);
  const content = $("#modal-content");
  content.closest(".modal")?.classList.add("workflow-detail-modal");
  const showNode = (id) => {
    const node = template.nodes.find((item) => item.id === id);
    if (!node) return;
    content.querySelectorAll("[data-detail-node]").forEach((button) => button.setAttribute("aria-current", String(button.dataset.detailNode === id)));
    const names = (ids) => (ids || []).map((value) => template.nodes.find((item) => item.id === value)?.title || value).join("、");
    $("#workflow-node-detail").innerHTML = `<h3>${esc(node.title)}</h3><dl>
      <dt>人员需求</dt><dd>${esc(node.staffingGuidance || node.ownerRole || "根据交付定义选择")}</dd>
      <dt>职责与交付目标</dt><dd>${esc(node.deliverable || "尚未填写交付目标，请编辑补充。")}</dd>
      <dt>前置交接</dt><dd>${esc(names(node.dependsOn) || "起始职责，无前置依赖")}</dd>
      <dt>接收上下文</dt><dd>${esc(names(node.handoffFrom?.length ? node.handoffFrom : node.dependsOn) || "任务需求与团队共享上下文")}</dd>
      <dt>工作目录</dt><dd class="path-mono">${esc((node.artifactPaths || []).join("\n") || "按节点交付要求组织文件")}</dd>
      <dt>后续协作</dt><dd>${esc(names(template.nodes.filter((item) => item.dependsOn?.includes(node.id)).map((item) => item.id)) || "由项目经理安排下一步")}</dd></dl>
      <p class="field-hint">接收方依据自己的目标检查交接是否充分；有疑问可咨询任意相关成员，必要时向人类澄清。箭头不是不可回退的状态锁。</p>`;
  };
  content.querySelectorAll("[data-detail-node]").forEach((button) => button.addEventListener("click", () => showNode(button.dataset.detailNode)));
  showNode(template.nodes[0]?.id);
  if (!frozen) mountWorkflowDiagram("details", template.id, template);
}

/* ---------- 数字员工 ---------- */
function renderAgents() {
  const query = ($("#agents-search").value || "").trim().toLowerCase();
  const filtered = state.agents.filter(agent => `${agent.name} ${agent.description || ""} ${(agent.capabilities || []).join(" ")}`.toLowerCase().includes(query));
  const page = paginate(filtered, state.listPages.agents); state.listPages.agents = page.page;
  $("#agents-grid").innerHTML = page.items.map((agent) => `
    <div class="agent-card employee-card">
      <div class="agent-card-top">
        <div class="agent-card-avatar ${roleColor(agent)}">${esc(initialsOf(agent))}</div>
        <div class="agent-card-identity"><h3>${esc(agent.name)}</h3></div>
      </div>
      <p>${esc(agent.description || "（未填写简介）")}</p>
      <div class="capabilities">${(agent.capabilities || []).map((capability) => `<span class="capability">${esc(capability)}</span>`).join("")}</div>
      <div class="agent-runtime"><span>${providerLabel(agent)}${agent.runtime?.model ? " · " + esc(agent.runtime.model) : " · CLI 默认模型"}${agent.runtime?.effort ? " · 思考 " + esc(agent.runtime.effort) : ""}${agent.runtime?.profile ? " · profile: " + esc(agent.runtime.profile) : ""}</span><span>插件 ${agent.runtime?.extensionSelection?.pluginIds?.length || 0} · MCP ${agent.runtime?.extensionSelection?.mcpIds?.length || 0}</span></div>
      <div class="agent-footer"><span class="agent-status">● ${agent.status === "active" ? "可用" : "已停用"}</span><span>${agent.kind === "manager" ? "项目经理" : agent.kind === "developer" ? "研发工程师 · 已绑定仓库" : "其他 · 能力标签非工具权限"}</span></div>
      <div class="directory-card-actions"><button class="small-button primary" data-chat-agent="${agent.id}">对话</button><button class="small-button" data-edit-agent="${agent.id}">编辑</button><button class="small-button danger" data-delete-agent="${agent.id}">删除</button></div>
    </div>`).join("") || (query ? `<div class="empty-state" style="margin:0">没有匹配的数字员工</div>` : `<div class="empty-state" style="margin:0"><strong>还没有数字员工</strong>创建第一位数字员工并绑定本机 Runtime。<br /><button class="small-button primary" data-action="new-agent">＋ 创建数字员工</button></div>`);
  renderListPager("agents", page);
}

/* ---------- 开发手册：当前实现的可检查系统图 ---------- */
const manualPages = {
  "data-model": {
    label: "数据模型 ER 图",
    title: "数据模型与文件边界",
    intro: "关系以当前 Store 的 node-less Run 模型为准。SQLite 只保存状态与索引；Trace、结果与 Artifact 内容始终是 Run 文件。",
  },
  "system-architecture": {
    label: "系统架构图",
    title: "系统模块、调用方向与边界",
    intro: "这是当前单机 Node.js 实现，而不是未来生产拓扑。实线表示同步调用或数据流，虚线表示事件推送；模型 Provider 永远不能直接写领域状态。",
  },
  "task-flow": {
    label: "任务流转图",
    title: "任务如何被项目经理驱动",
    intro: "工作流定义职责与交接参考；项目经理每轮依据 Trace、产物、消息、决策和缺陷选择下一次协作，任何角色都可被重新选择。",
  },
};

function diagramCanvas(key, title) {
  return `<section class="diagram-panel panel">
    <div class="diagram-panel-head">
      <div><div class="panel-kicker">INTERACTIVE DIAGRAM</div><h3>${esc(title)}</h3></div>
      <div class="diagram-controls" aria-label="图表缩放控制">
        <button class="diagram-control" type="button" data-diagram-action="zoom-out" data-diagram-key="${key}" aria-label="缩小">−</button>
        <span class="diagram-scale" data-diagram-scale="${key}">—</span>
        <button class="diagram-control" type="button" data-diagram-action="zoom-in" data-diagram-key="${key}" aria-label="放大">＋</button>
        <button class="diagram-fit" type="button" data-diagram-action="fit" data-diagram-key="${key}">适应画布</button>
      </div>
    </div>
    <div class="diagram-viewport" tabindex="0" aria-label="${esc(title)}；滚轮缩放，左键拖动画布，按加号或减号缩放，按零适应画布，并可使用下方小地图定位">
      <div class="diagram-graph" data-diagram-graph="${key}"></div>
    </div>
    <div class="diagram-panel-foot"><p class="diagram-gesture">滚轮缩放 · 左键拖动画布 · ＋/− 缩放 · 0 适应画布 · 小地图定位</p>
      <div class="diagram-minimap" data-diagram-minimap="${key}" aria-label="关系图小地图"></div>
    </div>
  </section>`;
}

function workflowDiagramCanvas(scope, key, title, className = "workflow-diagram-viewport") {
  const id = `${scope}:${key}`;
  return `<section class="workflow-diagram" aria-label="${esc(title)}">
    <div class="workflow-diagram-head"><div><span>WORKFLOW MAP</span><strong>${esc(title)}</strong></div>
    </div>
    <div class="diagram-viewport ${esc(className)}" aria-label="${esc(title)}；只读固定总览，箭头表示职责之间的交接参考。">
      <div class="diagram-graph" data-workflow-diagram-graph="${esc(id)}"></div>
    </div>
    <div class="workflow-diagram-foot"><p class="workflow-diagram-note">箭头表示职责之间的预期交接；项目经理可依据 Trace 与产物重新选择任意职责。</p></div>
  </section>`;
}

async function mountWorkflowDiagram(scope, key, workflow, options = {}) {
  const id = `${scope}:${key}`;
  const container = $(`[data-workflow-diagram-graph="${id}"]`);
  if (!container || container.dataset.mounting) return;
  container.dataset.mounting = "true";
  try {
    await Promise.all([loadVendor("x6"), loadVendor("elk")]);
    if (!container.isConnected) return;
    mountWorkflowGraph(scope, key, container, null, workflow, options);
  } catch (error) { if (container.isConnected) container.textContent = error.message; }
}

function svgFrame(label, body, viewBox = "0 0 1600 980") {
  return `<svg class="architecture-svg" viewBox="${viewBox}" role="img" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">
    <defs><marker id="diagram-arrow" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L9,4 L0,8 z" /></marker></defs>${body}
  </svg>`;
}

function dataModelSvg() {
  return svgFrame("AgentForge 当前数据模型 ER 图", `
    <text class="svg-caption" x="50" y="48">领域 metadata（SQLite 快照）</text>
    <rect class="diagram-boundary" x="36" y="64" width="1518" height="765" rx="24" />
    <g class="diagram-edge"><path d="M422 211 L304 211" marker-end="url(#diagram-arrow)" /><text x="334" y="197">memberAgentIds[]</text>
      <path d="M700 211 L970 211" marker-end="url(#diagram-arrow)" /><text x="785" y="197">workflowSnapshot</text>
      <path d="M422 293 L970 258" marker-end="url(#diagram-arrow)" /><text x="654" y="266">teamId</text>
      <path d="M1175 315 L1175 411" marker-end="url(#diagram-arrow)" /><text x="1190" y="368">taskId · 1:N</text>
      <path d="M1175 315 L1222 648" marker-end="url(#diagram-arrow)" /><text x="1200" y="500">nodeAssignments</text>
      <path d="M1072 532 L250 650" marker-end="url(#diagram-arrow)" /><text x="590" y="574">1:N · node / manager / consultation / reflection</text>
      <path d="M1090 568 L500 650" marker-end="url(#diagram-arrow)" /><text x="762" y="633">1:N · conversationId</text>
      <path d="M1175 594 L808 650" marker-end="url(#diagram-arrow)" /><text x="958" y="634">1:N · traceId</text>
      <path d="M1255 594 L1086 650" marker-end="url(#diagram-arrow)" /><text x="1190" y="633">1:N · traceId</text>
      <path d="M1295 594 L1360 650" marker-end="url(#diagram-arrow)" /><text x="1323" y="633">1:N</text>
      <path d="M330 745 L1250 745" marker-end="url(#diagram-arrow)" /><text x="752" y="732">Trace.outputArtifactIds[] · Artifact.traceId</text>
      <path d="M1370 806 L1370 882" marker-end="url(#diagram-arrow)" /><text x="1382" y="856">storagePath</text></g>
    <g class="diagram-node agent"><rect x="72" y="120" width="232" height="180" rx="16" /><text class="node-title" x="92" y="153">Agent</text><text class="node-field" x="92" y="182">id · name · status · kind</text><text class="node-field" x="92" y="205">runtime (Claude Code)</text><text class="node-field" x="92" y="228">skills / plugins / MCP paths</text><text class="node-note" x="92" y="270">提示词与能力定义员工工作方式</text></g>
    <g class="diagram-node"><rect x="422" y="120" width="278" height="205" rx="16" /><text class="node-title" x="442" y="153">Team</text><text class="node-field" x="442" y="182">id · name · mission · status</text><text class="node-field" x="442" y="205">memberAgentIds[]</text><text class="node-note" x="442" y="258">仅业务数字员工；不含项目经理</text><text class="node-note" x="442" y="280">与 WorkflowTemplate 可复用</text></g>
    <g class="diagram-node workflow"><rect x="700" y="120" width="270" height="205" rx="16" /><text class="node-title" x="720" y="153">WorkflowTemplate</text><text class="node-field" x="720" y="182">id · name · system · nodes[]</text><text class="node-field" x="720" y="205">dependsOn / handoffFrom</text><text class="node-field" x="720" y="228">deliverable · artifactPaths[]</text><text class="node-note" x="720" y="270">repositoryPath: repos/&lt;repo&gt;</text></g>
    <g class="diagram-node task"><rect x="970" y="120" width="410" height="195" rx="16" /><text class="node-title" x="990" y="153">Task</text><text class="node-field" x="990" y="182">id · objective · workspacePath · status</text><text class="node-field" x="990" y="205">teamId · workflowTemplateId</text><text class="node-field" x="990" y="228">workflowSnapshot · nodeAssignments{}</text><text class="node-note" x="990" y="270">快照冻结历史工作流定义</text></g>
    <g class="diagram-node run"><rect x="970" y="411" width="410" height="183" rx="16" /><text class="node-title" x="990" y="444">Run</text><text class="node-field" x="990" y="473">id · taskId · status · nodeStates{}</text><text class="node-field" x="990" y="496">manager · reflectionAgent</text><text class="node-field" x="990" y="519">waitingNode / waitingAgent / conversation</text><text class="node-note" x="990" y="557">一次真实交付的状态权威</text></g>
    <g class="diagram-node trace"><rect x="72" y="650" width="258" height="155" rx="16" /><text class="node-title" x="92" y="683">Trace</text><text class="node-field" x="92" y="712">runId · workflowNodeId · agentId</text><text class="node-field" x="92" y="735">type · status · tracePath</text><text class="node-note" x="92" y="770">每次 Claude Code 调用一条</text></g>
    <g class="diagram-node message"><rect x="390" y="650" width="254" height="155" rx="16" /><text class="node-title" x="410" y="683">Message</text><text class="node-field" x="410" y="712">runId · conversationId · nodeId</text><text class="node-field" x="410" y="735">sender · recipient · kind</text><text class="node-note" x="410" y="770">协作内容；不同于 Event</text></g>
    <g class="diagram-node decision"><rect x="704" y="650" width="208" height="155" rx="16" /><text class="node-title" x="724" y="683">Decision</text><text class="node-field" x="724" y="712">runId · traceId</text><text class="node-field" x="724" y="735">impact · affectedNodeIds[]</text><text class="node-note" x="724" y="770">已确认的关键决策</text></g>
    <g class="diagram-node defect"><rect x="972" y="650" width="208" height="155" rx="16" /><text class="node-title" x="992" y="683">Defect</text><text class="node-field" x="992" y="712">runId · traceId · severity</text><text class="node-field" x="992" y="735">open → fixed → closed</text><text class="node-note" x="992" y="770">缺陷清单同时是 Artifact</text></g>
    <g class="diagram-node artifact"><rect x="1240" y="650" width="260" height="155" rx="16" /><text class="node-title" x="1260" y="683">Artifact</text><text class="node-field" x="1260" y="712">runId · traceId · ownerAgentId</text><text class="node-field" x="1260" y="735">hash · bytes · version</text><text class="node-note" x="1260" y="770">metadata，不保存文件内容</text></g>
    <text class="svg-caption" x="1070" y="872">Run 文件目录（真实文件，不入 SQLite）</text>
    <g class="diagram-node storage"><rect x="1110" y="882" width="390" height="74" rx="16" /><text class="node-title" x="1130" y="912">runs/&lt;runId&gt;/traces/&lt;traceId&gt;/</text><text class="node-field" x="1130" y="936">events.ndjson · agent-result.json · output/ · workspace/</text></g>
  `);
}

function systemArchitectureSvg() {
  return svgFrame("AgentForge 当前系统架构图", `
    <rect class="diagram-boundary soft" x="46" y="72" width="400" height="800" rx="25" /><text class="svg-caption" x="72" y="110">本机浏览器边界</text>
    <rect class="diagram-boundary" x="490" y="72" width="698" height="800" rx="25" /><text class="svg-caption" x="516" y="110">AgentForge Node.js 进程边界</text>
    <rect class="diagram-boundary storage-boundary" x="1230" y="72" width="324" height="800" rx="25" /><text class="svg-caption" x="1254" y="110">本机持久化边界</text>
    <g class="diagram-edge"><path d="M400 250 L555 250" marker-end="url(#diagram-arrow)" /><text x="438" y="235">HTTP /api</text><path class="dashed" d="M555 292 L400 292" marker-end="url(#diagram-arrow)" /><text x="438" y="315">SSE run-event</text>
      <path d="M765 326 L765 410" marker-end="url(#diagram-arrow)" /><text x="780" y="370">命令 / 只读聚合</text><path d="M946 326 L946 410" marker-end="url(#diagram-arrow)" /><text x="960" y="370">启动 / 恢复 Run</text>
      <path d="M830 550 L830 634" marker-end="url(#diagram-arrow)" /><text x="845" y="596">Provider invocation</text><path class="dashed" d="M870 634 L870 550" marker-end="url(#diagram-arrow)" /><text x="884" y="596">规范化流式事件</text>
      <path d="M1060 498 L1275 498" marker-end="url(#diagram-arrow)" /><text x="1110" y="484">SQLite metadata</text><path d="M1060 715 L1275 715" marker-end="url(#diagram-arrow)" /><text x="1110" y="700">trace / artifact 文件</text>
      <path d="M830 744 L830 796" marker-end="url(#diagram-arrow)" /><text x="845" y="782">Claude Code CLI</text></g>
    <g class="diagram-node ui"><rect x="92" y="180" width="308" height="154" rx="18" /><text class="node-title" x="116" y="216">web/ Console</text><text class="node-field" x="116" y="246">路由、渲染、用户命令</text><text class="node-field" x="116" y="269">任务空间 / SSE / 文件预览</text><text class="node-note" x="116" y="302">不拥有领域状态，不直接调用 Provider</text></g>
    <g class="diagram-node http"><rect x="555" y="180" width="430" height="146" rx="18" /><text class="node-title" x="579" y="216">server/index.mjs · HTTP transport</text><text class="node-field" x="579" y="246">API 路由、静态文件、SSE、错误边界</text><text class="node-note" x="579" y="280">只转换协议；不放编排策略或提示词</text></g>
    <g class="diagram-node store"><rect x="555" y="410" width="350" height="140" rx="18" /><text class="node-title" x="579" y="446">server/store.mjs · Domain Store</text><text class="node-field" x="579" y="476">状态机、ID、校验、Event、metadata</text><text class="node-note" x="579" y="510">唯一可变更 Task / Run / Trace 状态的模块</text></g>
    <g class="diagram-node orchestration"><rect x="945" y="410" width="198" height="140" rx="18" /><text class="node-title" x="968" y="446">Orchestrator</text><text class="node-field" x="968" y="476">候选节点、推进、循环</text><text class="node-field" x="968" y="499">校验 node_result</text><text class="node-note" x="968" y="526">只通过 Store 写状态</text></g>
    <g class="diagram-node runtime"><rect x="650" y="634" width="350" height="110" rx="18" /><text class="node-title" x="674" y="670">server/runtime/ · Local Runtime</text><text class="node-field" x="674" y="700">Claude Code JSONL → 标准化 Provider Event</text><text class="node-note" x="674" y="726">无 Store 写权限；仅任务工作目录</text></g>
    <g class="diagram-node provider"><rect x="650" y="796" width="350" height="56" rx="18" /><text class="node-title" x="674" y="830">Claude Code CLI · 用户授权 bypass 模式</text></g>
    <g class="diagram-node persistence"><rect x="1275" y="410" width="230" height="112" rx="18" /><text class="node-title" x="1298" y="446">SQLite</text><text class="node-field" x="1298" y="475">Agent / Team / Task / Run</text><text class="node-note" x="1298" y="501">只保存 metadata 与状态</text></g>
    <g class="diagram-node files"><rect x="1275" y="634" width="230" height="112" rx="18" /><text class="node-title" x="1298" y="670">Run Files</text><text class="node-field" x="1298" y="699">Trace、结果、Artifact 快照</text><text class="node-note" x="1298" y="725">受限读取与预览</text></g>
    <g class="diagram-callout"><rect x="92" y="430" width="308" height="172" rx="18" /><text class="node-title" x="116" y="465">边界规则</text><text class="node-field" x="116" y="496">• UI 不写 Store</text><text class="node-field" x="116" y="522">• Runtime 不决定领域状态</text><text class="node-field" x="116" y="548">• SQLite 不保存 Trace / 文件内容</text><text class="node-field" x="116" y="574">• 外部发布、删除、凭证仍受限</text></g>
  `);
}

function taskFlowSvg() {
  return svgFrame("AgentForge 任务执行与协作流程图", `
    <text class="svg-caption" x="60" y="48">正常推进：项目经理在依赖护栏内选择候选节点</text>
    <g class="diagram-edge"><path d="M240 150 L350 150" marker-end="url(#diagram-arrow)" /><path d="M595 150 L700 150" marker-end="url(#diagram-arrow)" /><path d="M960 150 L1060 150" marker-end="url(#diagram-arrow)" /><path d="M1310 150 L1400 150" marker-end="url(#diagram-arrow)" />
      <path d="M1488 215 L1488 300 L1060 300" marker-end="url(#diagram-arrow)" /><text x="1230" y="286">下一候选节点</text>
      <path d="M1185 215 L1185 355" marker-end="url(#diagram-arrow)" /><text x="1198" y="292">node_result</text>
      <path d="M1060 422 L882 422" marker-end="url(#diagram-arrow)" /><text x="923" y="408">Agent 咨询</text><path d="M700 422 L530 422" marker-end="url(#diagram-arrow)" /><text x="584" y="408">答复后重入队</text>
      <path d="M1185 488 L1185 570" marker-end="url(#diagram-arrow)" /><text x="1198" y="532">needsHuman</text><path d="M1185 660 L1185 745 L965 745" marker-end="url(#diagram-arrow)" /><text x="1050" y="731">人类回答后恢复原节点</text>
      <path d="M1375 422 L1455 422 L1455 530" marker-end="url(#diagram-arrow)" /><text x="1391" y="408">错误</text><path d="M1455 630 L1455 745 L965 745" marker-end="url(#diagram-arrow)" /><text x="1322" y="731">保留失败 Trace，仅重排该节点</text>
      <path d="M965 422 L965 815" marker-end="url(#diagram-arrow)" /><text x="980" y="626">验收 Artifact / Decision / Defect</text>
      <path d="M965 882 L1140 882" marker-end="url(#diagram-arrow)" /><path d="M1385 882 L1470 882" marker-end="url(#diagram-arrow)" /><path d="M1265 948 L1265 970 L965 970" marker-end="url(#diagram-arrow)" /><text x="1100" y="958">rework：从指定节点回队</text></g>
    <g class="diagram-node task"><rect x="60" y="96" width="180" height="108" rx="18" /><text class="node-title" x="82" y="132">创建 Task</text><text class="node-field" x="82" y="160">工作流快照 + 节点分配</text><text class="node-note" x="82" y="183">状态：backlog</text></g>
    <g class="diagram-node run"><rect x="350" y="96" width="245" height="108" rx="18" /><text class="node-title" x="372" y="132">创建 Run</text><text class="node-field" x="372" y="160">复制项目经理、反思 Agent</text><text class="node-note" x="372" y="183">planning → running</text></g>
    <g class="diagram-node orchestration"><rect x="700" y="96" width="260" height="108" rx="18" /><text class="node-title" x="722" y="132">计算合格候选集</text><text class="node-field" x="722" y="160">依赖满足、节点非 completed</text><text class="node-note" x="722" y="183">工作流只限制“不能开始什么”</text></g>
    <g class="diagram-node manager"><rect x="1060" y="96" width="250" height="108" rx="18" /><text class="node-title" x="1082" y="132">项目经理 Trace</text><text class="node-field" x="1082" y="160">managerDecision.nextNodeId</text><text class="node-note" x="1082" y="183">只能选候选集合里的节点</text></g>
    <g class="diagram-node agent"><rect x="1400" y="96" width="150" height="108" rx="18" /><text class="node-title" x="1422" y="132">业务 Agent</text><text class="node-field" x="1422" y="160">真实 Claude Code</text><text class="node-note" x="1422" y="183">一条 Trace</text></g>
    <g class="diagram-node consultation"><rect x="700" y="355" width="182" height="132" rx="18" /><text class="node-title" x="722" y="391">角色协作</text><text class="node-field" x="722" y="420">Message</text><text class="node-field" x="722" y="443">conversationId</text><text class="node-note" x="722" y="466">等待被咨询 Agent</text></g>
    <g class="diagram-node queue"><rect x="350" y="355" width="180" height="132" rx="18" /><text class="node-title" x="372" y="391">节点重新入队</text><text class="node-field" x="372" y="420">nodeStates[node] = queued</text><text class="node-note" x="372" y="453">新调用必创建新 Trace</text></g>
    <g class="diagram-node result"><rect x="1060" y="355" width="250" height="132" rx="18" /><text class="node-title" x="1082" y="391">Orchestrator 验收</text><text class="node-field" x="1082" y="420">校验结构化 node_result</text><text class="node-field" x="1082" y="443">捕获真实文件与仓库变更</text><text class="node-note" x="1082" y="466">接受后节点 completed</text></g>
    <g class="diagram-node human"><rect x="1060" y="570" width="250" height="90" rx="18" /><text class="node-title" x="1082" y="606">等待人类澄清</text><text class="node-field" x="1082" y="634">Human Channel 只显示需人处理的消息</text></g>
    <g class="diagram-node retry"><rect x="1355" y="530" width="195" height="100" rx="18" /><text class="node-title" x="1377" y="566">项目经理巡检</text><text class="node-field" x="1377" y="595">五分钟检查无活跃角色</text><text class="node-note" x="1377" y="615">事件审计，不混入澄清</text></g>
    <g class="diagram-node outputs"><rect x="755" y="815" width="210" height="132" rx="18" /><text class="node-title" x="777" y="851">交付与质量闭环</text><text class="node-field" x="777" y="880">Artifact / Decision / Defect</text><text class="node-field" x="777" y="903">Defect：open → fixed → closed</text><text class="node-note" x="777" y="926">有开放缺陷则修复 → 回归</text></g>
    <g class="diagram-node reflection"><rect x="1140" y="828" width="245" height="108" rx="18" /><text class="node-title" x="1162" y="864">独立交付反思</text><text class="node-field" x="1162" y="892">pass 或 rework + restartFromNodeId</text><text class="node-note" x="1162" y="916">无开放缺陷才可进入</text></g>
    <g class="diagram-node completed"><rect x="1470" y="828" width="100" height="108" rx="18" /><text class="node-title" x="1490" y="874">完成</text><text class="node-note" x="1490" y="902">Run completed</text></g>
  `, "0 0 1620 1010");
}

function manualDetails(key) {
  const content = {
    "data-model": [
      ["员工历史与可见性", "每个员工以稳定 Agent ID 查询自己的私聊、可见群聊与参与任务；临时项目经理映射 sourceAgentId。群消息 visibleToAgentIds 冻结可见成员，@ 只决定谁回复。旧群记录仅按已保存证据开放，不替新成员补造历史权限。"],
      ["长期沟通", "员工私聊按 Agent 唯一，团队群聊按 Team 唯一；消息、投递和操作事件长期保存，不随任务删除。Provider 会话与 Run 隔离；模型上下文长度不等于完整历史保留期限。"],
      ["状态权威", "Task / Run 整体状态与 Trace metadata 由 Store 校验并写入 SQLite；currentFocus 由项目经理判断并持久化，节点是职责定义而非永久完成状态。Event 是追加事实，Message 是协作内容。"],
      ["关联方式", "Artifact、Decision、Defect 都以 runId / traceId 关联一次真实调用；Message 以 conversationId 关联一次协作或澄清。"],
      ["文件边界", "Artifact 的 storagePath 指向 Run Files；数据库不保存内容。代码仅在任务目录的 repos/<子目录> Git 仓库中工作。"],
      ["员工与任务快照", "员工包含名称、执行类型、能力说明、系统提示词和 Runtime 连接选择。研发员工绑定一个 Git 仓库；Task 冻结团队、工作流与仓库来源，Run 启动前检出仓库，研发从绑定仓库执行。工作流管理列表只展示摘要，详情解释节点职责和交接。"],
      ["会话与投递", "Dispatch 保证排队、领取、等待与重试；不是 Step 或 NodeExecution。同一 Run 的同一成员续接自己的 Provider 会话，不与其他成员共享私有模型上下文。"],
    ],
    "system-architecture": [
      ["只读历史工具", "Store 内 history 模块提供完整分页、中文关键词搜索、全部 Trace 与交付读取，SQLite 搜索索引可重建。每次 CLI 调用通过私有 Unix socket + MCP 标注员工，不暴露管理员 Cookie；历史查询不共享模型会话、不更改任务状态。"],
      ["沟通执行", "三个入口打开同一会话；communication-store 是 Store 内部命令，communication 服务驱动独立本机 CLI。群聊有 @ 定向回复，无 @ 全部活跃数字成员回复，没有默认经理。失败按成员排队重试，不阻塞其他成员；可取消待回复而不删除消息。"],
      ["写入边界", "web 只通过 HTTP 发命令；index 只做传输；Store 是唯一能改变领域状态的模块；Orchestrator 不直改内部数组。"],
      ["运行边界", "Runtime 启动本机 Claude Code（默认）或 Codex，并标准化 JSONL 事件。最终 node_result 必须被 Orchestrator 验证后才能成为交付事实。Provider 登录和模型可用性由本机配置决定。"],
      ["登录与执行", "客户端自带本机服务，仅监听随机 loopback 端口；页面、API 和 SSE 均需单管理员登录。数字员工以本机用户权限执行，平台不设置任务级操作权限。"],
      ["插件与 MCP", "一个员工可绑定多个插件来源仓库，分别启停并逐插件选择；来源、版本和选择持久化。更新创建新检出，历史任务保持原版本；拒绝同时启用同名插件。当前仅支持仓库内插件，不自动安装外部包。MCP 接受多服务 JSON，私有文件保存。Claude 配置不传给 Codex。"],
      ["当前限制", "这是单机单用户平台，不是多租户系统。SQLite、共享本机文件与 bypass 执行不提供租户隔离或完整审批。插件会执行代码，只有可信来源才能启用。"],
    ],
    "task-flow": [
      ["按需找回历史", "沟通和任务中均可使用 8 个内置历史工具。先搜索，再按 recordId 读取原文；hasMore 时继续分页或分段。历史内容是证据，不是当前指令或发布授权。归档记录仍可读，物理删除后不再返回。"],
      ["协作不是固定串行", "项目经理每次从所有职责定义中依据当前事实作出结构化选择；它负责流程，不替业务角色完成交付。"],
      ["澄清与回路", "业务问题优先点对点咨询相应角色；只有团队无法回答的产品取舍、验收标准或外部事实才等待人类。测试 Defect 则驱动修复与回归循环。"],
      ["恢复与暂停", "Provider、工具或结构化输出错误封存失败 Trace 并重试原 Dispatch；五分钟无活跃成员巡检恢复调度。人类可暂停全部执行并手动继续，也可终止；等待澄清不会被巡检强行跳过。"],
      ["完成与后续咨询", "经理提交人类验收后进入 awaiting_acceptance，只有人类确认才 completed。未归档仍能咨询，停止状态下答疑不恢复开发；普通新指令进入队列，不打断正在执行的成员。归档后只读。"],
    ],
  };
  return content[key].map(([title, text]) => `<article class="manual-detail"><h4>${esc(title)}</h4><p>${esc(text)}</p></article>`).join("");
}

function bindDiagramInteractions() {
  $$('[data-diagram-viewport]').forEach((viewport) => {
    if (viewport.dataset.bound) return;
    viewport.dataset.bound = "true";
    const key = viewport.dataset.diagramViewport;
    let pointer = null;
    viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      updateDiagram(key, event.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
    viewport.addEventListener("pointerdown", (event) => {
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add("dragging");
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const view = state.diagramViews[key] || { scale: 1, x: 0, y: 0 };
      state.diagramViews[key] = { ...view, x: view.x + event.clientX - pointer.x, y: view.y + event.clientY - pointer.y };
      pointer = { ...pointer, x: event.clientX, y: event.clientY };
      applyDiagram(key);
    });
    const release = (event) => { if (!pointer || pointer.id !== event.pointerId) return; pointer = null; viewport.classList.remove("dragging"); };
    viewport.addEventListener("pointerup", release); viewport.addEventListener("pointercancel", release);
  });
}

function applyDiagram(key) {
  const view = state.diagramViews[key] || { scale: 1, x: 0, y: 0 };
  const canvas = $(`[data-diagram-canvas="${key}"]`), label = $(`[data-diagram-scale="${key}"]`);
  if (canvas) canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  if (label) label.textContent = `${Math.round(view.scale * 100)}%`;
}
function updateDiagram(key, factor) {
  const view = state.diagramViews[key] || { scale: 1, x: 0, y: 0 };
  state.diagramViews[key] = { ...view, scale: Math.max(.55, Math.min(1.9, view.scale * factor)) };
  applyDiagram(key);
}
function resetDiagram(key) { state.diagramViews[key] = { scale: 1, x: 0, y: 0 }; applyDiagram(key); }

async function renderManual() {
  const page = manualPages[state.manualPage] || manualPages["data-model"];
  disposeManualGraphs();
  $("#manual-content").innerHTML = `
    <nav class="manual-tabs" aria-label="开发手册章节">${Object.entries(manualPages).map(([key, item]) => `<button class="manual-tab ${key === state.manualPage ? "active" : ""}" type="button" data-manual-page="${key}" aria-current="${key === state.manualPage ? "page" : "false"}">${esc(item.label)}</button>`).join("")}</nav>
    <section class="manual-intro"><div><div class="panel-kicker">${esc(page.label)}</div><h3>${esc(page.title)}</h3><p>${esc(page.intro)}</p></div><a href="${state.manualPage === "data-model" ? "/manual/system-architecture" : state.manualPage === "system-architecture" ? "/manual/task-flow" : "/manual/data-model"}" data-manual-next>继续阅读 →</a></section>
    ${diagramCanvas(state.manualPage, page.title)}
    <section class="manual-details">${manualDetails(state.manualPage)}</section>`;
  const key = state.manualPage;
  const container = $(`[data-diagram-graph="${key}"]`);
  try { await loadVendor("x6"); } catch (error) { if (container.isConnected) container.textContent = error.message; return; }
  if (!container.isConnected) return;
  mountManualGraph(key, container, $(`[data-diagram-minimap="${key}"]`), (scale) => {
    const label = $(`[data-diagram-scale="${key}"]`); if (label) label.textContent = `${Math.round(scale * 100)}%`;
  });
}

/* ---------- 任务空间 ---------- */
function latestExecutedAgentId(agents, traces) {
  const ids=new Set(agents.map(agent=>agent.id));
  const latest=traces.reduce((found,trace)=>{
    if(!ids.has(trace.agentId))return found;
    const timestamp=Date.parse(trace.startedAt || trace.createdAt)||0;
    return !found || timestamp>=(Date.parse(found.startedAt || found.createdAt)||0)?trace:found;
  },null);
  return latest?.agentId || null;
}

function workspaceDirectoryDetails(task) {
  const absolute = task.workspacePath || "";
  const taskRoot = (task.taskWorkspacePath || "").replace(/\/+$/, "");
  const relative = taskRoot && absolute.startsWith(`${taskRoot}/`)
    ? `${taskRoot.split("/").at(-1)}/${absolute.slice(taskRoot.length + 1)}`
    : absolute.replace(/\/+$/, "").split("/").at(-1) || ".";
  return `<h5>工作目录</h5><div class="workspace-path"><span>${esc(relative)}</span><button class="text-action" data-copy="${esc(absolute)}">复制</button></div>`;
}

function taskDescriptionMarkup(task, view) {
  const characters = Array.from(task.objective || "");
  const long = characters.length > 100;
  const expanded = Boolean(view.descriptionExpanded);
  const text = long && !expanded ? `${characters.slice(0, 100).join("")}…` : characters.join("");
  return `<h5>任务描述</h5><div id="task-description-content" class="workspace-brief"><p>${esc(text)}</p></div>${long ? `<button class="text-action" data-toggle-task-description aria-expanded="${expanded}" aria-controls="task-description-content">${expanded ? "收起" : "展开"}</button>` : ""}`;
}

function workspaceDetailsMarkup(workspace, { agents, currentFocusNode, view, artifactCount, teamName }) {
  const { run } = workspace;
  return `<aside id="workspace-details" class="workspace-details" aria-label="任务详情" ${view.detailsOpen ? "" : "hidden"}>
      <h4>任务详情</h4>
      <dl class="workspace-properties">
        <div><dt>团队</dt><dd>${esc(run.task.team?.name || teamName || "当前团队")}</dd></div>
        <div><dt>工作流</dt><dd><button class="text-action task-workflow-link" data-task-workflow-details>${esc(run.task.workflowSnapshot.name || "当前工作流")} ↗</button></dd></div>
        <div><dt>当前重心</dt><dd>${esc(currentFocusNode?.title || "暂无指定重心")}</dd></div>
        <div><dt>数字员工</dt><dd>${agents.length} 位</dd></div>
        <div><dt>交付快照</dt><dd>${artifactCount} 项</dd></div>
      </dl>
      <section class="workspace-directory-details" id="workspace-directory-details">${workspaceDirectoryDetails(run.task)}</section>
      <section class="workspace-context">${taskDescriptionMarkup(run.task, view)}</section>
      ${qualityRiskMarkup(workspace)}
    </aside>`;
}

function renderWorkspace() {
  const box = $("#run-workspace");
  const workspace = state.workspace?.run?.id === state.selectedRunId ? state.workspace : null;
  if (!workspace) {
    disposeWorkflowGraphs("task");
    box.innerHTML = state.selectedRunId ? `<div class="empty-state" role="status"><strong>${state.workspaceError ? "任务加载失败" : "正在加载任务…"}</strong>${esc(state.workspaceError || "正在读取协作记录与当前状态")}${state.workspaceError ? '<button class="small-button" data-reload-workspace>重试</button>' : ""}</div>` : `<div class="empty-state"><strong>还没有选择任务</strong>请从任务中心进入一个任务。</div>`;
    return;
  }
  const { run, artifacts, messages, events, traces = [], defects = [] } = workspace;
  const view = workspaceView(run.id);
  const oldStream = box.querySelector("#trace-stream");
  if (box.dataset.runId === run.id) {
    rememberDirectoryReading(view);
    rememberDiffReading(view);
    for (const details of box.querySelectorAll("[data-workspace-disclosure]")) view.disclosures[details.dataset.workspaceDisclosure] = details.open;
    if (oldStream?.clientHeight) view.consoleViews.set(box.dataset.agentId, {
      top: oldStream.scrollTop,
      following: oldStream.scrollHeight - oldStream.scrollTop - oldStream.clientHeight < 48,
      open: [...oldStream.querySelectorAll("details[open][data-console-key]")].map((item) => item.dataset.consoleKey),
      closed: [...oldStream.querySelectorAll("details[data-default-open]:not([open])")].map((item) => item.dataset.consoleKey),
    });
  }
  const draftFocused = document.activeElement?.id === "instruction-text" && box.dataset.runId === run.id;
  const draftSelection = draftFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  const humanScroll = box.dataset.runId === run.id ? box.querySelector(".human-message-list") : null;
  const humanScrollState = humanScroll?.clientHeight ? { top: humanScroll.scrollTop, following: humanScroll.scrollHeight - humanScroll.scrollTop - humanScroll.clientHeight < 48 } : null;
  if (humanScrollState) view.collaborationScroll = humanScrollState;
  if (view.jumpLatest) { view.consoleViews.delete(state.selectedAgentId); view.collaborationScroll = null; }
  const focus = workflowFocus(run, traces, defects);
  const agents = workspaceAgents(workspace, state.agents);
  const tab = view.tab;
  if (!agents.some((agent) => agent.id === state.selectedAgentId)) state.selectedAgentId = tab === 'console' ? latestExecutedAgentId(agents,traces) : null;
  const selected = agents.find((agent) => agent.id === state.selectedAgentId);
  const businessArtifacts = artifacts;
  const currentFocusNode = run.currentFocus?.nodeId ? run.task.workflowSnapshot.nodes.find((node) => node.id === run.currentFocus.nodeId) : null;
  const activeStatus = ["planning", "running", "awaiting_human", "review"].includes(run.status);
  const scheduledRetries = retryableDispatches(workspace);
  const failedRecovery = failedRunRecovery(workspace);
  const failureMessage = run.status === "failed" ? failedRunMessage(workspace) : null;
  const acceptance = acceptanceReview(workspace);

  box.innerHTML = `
    <div class="workspace-summary">
      <div class="workspace-title">
        <button class="workspace-back" data-back-to-tasks aria-label="返回任务列表" title="返回任务列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
        <h3>${esc(run.task.title)}</h3>
      </div>
      <div class="workspace-summary-meta">
        ${pill(run.status)}
        ${acceptance?.verified ? `<button class="primary-button compact" data-open-completion-confirm="${esc(run.id)}">确认完成</button>` : ""}
        ${scheduledRetries.length ? `<button class="small-button amber" data-retry-scheduled="${run.id}" title="立即启动等待退避的调用；失败 Trace 与原投递会保留。">立即重试 ${scheduledRetries.length} 项调用</button>` : ""}
        ${failedRecovery?.type === "orchestration" ? `<button class="small-button amber" data-retry-orchestration="${run.id}" title="重新准备运行环境，并由项目经理基于保留事实重新评估。">修复后重新尝试</button>` : ""}
        ${failedRecovery?.type === "node" ? failedRecovery.nodeIds.map((nodeId) => {
          const node = run.task.workflowSnapshot.nodes.find((item) => item.id === nodeId);
          return `<button class="small-button amber" data-retry-failed-node="${run.id}" data-workflow-node-id="${esc(nodeId)}" title="由项目经理重新评估此职责；历史 Trace 与产物会保留。">从「${esc(node?.title || nodeId)}」恢复</button>`;
        }).join("") : ""}
        ${activeStatus ? `<button class="small-button amber" data-pause-run="${run.id}">Ⅱ 暂停</button><button class="danger-button" data-terminate-run="${run.id}">■ 终止 Run</button>` : run.status === "paused" ? `<button class="small-button primary" data-resume-run="${run.id}">▶ 继续 Run</button><button class="danger-button" data-terminate-run="${run.id}">■ 终止 Run</button>` : run.status === "awaiting_acceptance" ? `<button class="danger-button" data-terminate-run="${run.id}">■ 终止 Run</button>` : ""}
      </div>
    </div>
    <div class="workspace-body ${view.detailsOpen ? "details-open" : ""}">
    <div class="workspace-main">
    ${failureMessage ? `<div class="workspace-failure" role="alert"><strong>本轮未完成</strong><span>${esc(failureMessage)}</span><small>${run.failure?.phase === "workspace_baseline_missing" ? "旧 Run、Trace 和 Artifact 保留供核对；此 Run 无法安全重试。" : failedRecovery ? "修复原因后可请求项目经理重新评估；历史 Trace、产物和消息都会保留。" : "任务已归档，不能重新启动。"}</small>${run.failure?.phase === "workspace_baseline_missing" ? '<button class="small-button" data-action="new-task">新建任务</button>' : ""}</div>` : ""}
    <div class="ws-tabs workspace-mode-tabs" role="tablist" aria-label="任务工作区">
      <button id="collaboration-mode" class="ws-tab ${tab === "collaboration" ? "active" : ""}" data-ws-tab="collaboration" role="tab" aria-controls="collaboration-panel" aria-selected="${tab === "collaboration"}">协作记录${workspace.pendingQuestions?.some((item) => item.recipient.type === "human") ? `<span class="collaboration-unread">${workspace.pendingQuestions.filter((item) => item.recipient.type === "human").length} 待你回复</span>` : ""}</button>
      <button id="directory-mode" class="ws-tab ${["directory", "diff"].includes(tab) ? "active" : ""}" data-ws-tab="directory" role="tab" aria-controls="working-directory-panel working-diff-panel" aria-selected="${["directory", "diff"].includes(tab)}">工作目录</button>
      <button id="console-mode" class="ws-tab ${tab === "console" ? "active" : ""}" data-ws-tab="console" role="tab" aria-controls="console-panel" aria-selected="${tab === "console"}">控制台${workspace.failureEvents?.length ? '<span class="console-failure-marker" title="包含历史失败，不代表当前任务仍然失败">有失败记录</span>' : ""}</button>
      <button class="text-action workspace-details-toggle" data-toggle-task-details aria-expanded="${Boolean(view.detailsOpen)}" aria-controls="workspace-details">任务详情${defects.filter(item => item.status !== "closed").length ? ` · ${defects.filter(item => item.status !== "closed").length} 项风险` : ""} ${view.detailsOpen ? "‹" : "›"}</button>
    </div>
    <div class="workspace-grid" id="console-panel" role="tabpanel" aria-labelledby="console-mode" ${tab !== "console" ? "hidden" : ""}>
      <nav class="role-nav" aria-label="角色与执行">
        <div class="role-nav-heading"><strong>${esc(run.task.team?.name || state.teams.find(team => team.id === run.task.teamId)?.name || "任务团队")}</strong><span>${agents.length}</span></div>
        <div class="role-list">
          ${agents.map((agent) => {
            const execution = roleExecutionStatus(run, traces, agent.id);
            const lastTraceFailed = traces.filter((trace) => trace.agentId === agent.id).at(-1)?.status === "failed";
            return `<button class="role-card ${agent.id === selected?.id ? "selected" : ""}" data-execution-state="${execution.active ? "running" : "idle"}" data-select-agent="${agent.id}" aria-pressed="${agent.id === selected?.id}">
              <span class="role-avatar ${roleColor(agent)}">${esc(initialsOf(agent))}</span>
              <span><strong title="${esc(agent.name)}">${esc(agent.name)}</strong><small>${providerLabel(agent)}</small></span>
              <em class="agent-runtime-status ${execution.active ? "active" : ""}">${esc(execution.label)}${lastTraceFailed ? " · 最近调用失败" : ""}</em>
            </button>`;
          }).join("")}
        </div>
      </nav>
      <div class="console-main">
        ${selected ? `<div class="console-heading"><div><strong>${esc(selected.name)}</strong><span>${providerLabel(selected)} · ${traces.filter((trace) => trace.agentId === selected.id).length} 次执行</span></div><button class="small-button" data-console-latest>↓ 回到最新</button></div>
        ${consoleFailurePanel(workspace, selected.id)}` : '<div class="chat-empty">请选择一位员工查看控制台。</div>'}
        <div id="tab-console">
          <div class="chat-stream" id="trace-stream" aria-live="polite" tabindex="0" aria-label="控制台"></div>
        </div>
      </div>
    </div>
    ${["directory", "diff"].includes(tab) ? `<nav class="file-source-switch" aria-label="文件来源"><button class="text-action" data-ws-tab="directory" aria-pressed="${tab === "directory"}">当前文件</button><button class="text-action" data-ws-tab="diff" aria-pressed="${tab === "diff"}">CHANGE</button></nav>` : ""}
    <section id="working-directory-panel" class="working-directory-panel" role="tabpanel" aria-labelledby="directory-mode" ${tab !== "directory" ? "hidden" : ""}></section>
    <section id="working-diff-panel" class="working-diff-panel" role="tabpanel" aria-labelledby="directory-mode" ${tab !== "diff" ? "hidden" : ""}></section>
    <section class="collaboration-panel" id="collaboration-panel" role="tabpanel" aria-labelledby="collaboration-mode" ${tab !== "collaboration" ? "hidden" : ""}></section>
    </div>
    ${view.detailsOpen ? workspaceDetailsMarkup(workspace, { agents, currentFocusNode, view, artifactCount: businessArtifacts.length, teamName: state.teams.find((team) => team.id === run.task.teamId)?.name }) : ""}
    </div>`;
  box.dataset.runId = run.id;
  box.dataset.agentId = selected?.id || "";

  if (tab === "console") renderConsolePage();
  if (tab === "directory") renderWorkingDirectory(run.id);
  if (tab === "diff") { renderWorkingChanges(run.id); if (!view.changes && !view.changesLoading) void loadWorkingChanges(run.id); }
  if (tab === "collaboration") renderCollaboration(workspace, agents);
  const stream = $("#trace-stream");
  const consoleView = view.consoleViews.get(selected?.id);
  if (consoleView) {
    for (const details of stream.querySelectorAll("details[data-console-key]")) details.open = consoleView.open.includes(details.dataset.consoleKey) || (details.dataset.defaultOpen !== undefined && !(consoleView.closed || []).includes(details.dataset.consoleKey));
    stream.scrollTop = consoleView.following ? stream.scrollHeight : consoleView.top;
  }
  const messageList = $(".human-message-list");
  if (messageList) messageList.scrollTop = view.collaborationScroll && !view.collaborationScroll.following ? view.collaborationScroll.top : messageList.scrollHeight;
  const followConsole = !consoleView || consoleView.following || view.jumpLatest;
  const followCollaboration = !view.collaborationScroll || view.collaborationScroll.following || view.jumpLatest;
  view.jumpLatest = false;
  requestAnimationFrame(() => {
    if (stream.isConnected && tab === "console" && followConsole) stream.scrollTop = stream.scrollHeight;
    if (messageList?.isConnected && followCollaboration) messageList.scrollTop = messageList.scrollHeight;
  });
  if (draftFocused && $("#instruction-text")) {
    $("#instruction-text").focus({ preventScroll: true });
    $("#instruction-text").setSelectionRange(...draftSelection);
  }
  disposeWorkflowGraphs("task");
  if (tab === "directory" && !view.directory && !view.directoryLoading && !view.directoryError) loadWorkingDirectory(run.id);
  if (tab === "console" && selected) { const page = consolePage(run.id, selected.id); if (!page.loaded && !page.loading && !page.error) loadConsolePage(run.id, selected.id); }
}

// The console shows the redacted snapshot of the exact prompt each Trace was
// dispatched with, as a per-invocation entry inside the timeline: browsing
// older invocations keeps every entry bound to its own Trace. Records predating
// the capability (or whose snapshot save failed) say so instead of
// fabricating content.
function tracePromptMarkup(trace, runId, agent = null) {
  const label = `本次提示词 · ${trace.workflowNodeId || trace.type || "调用"}`;
  const provider = trace.agent?.runtime?.provider || agent?.runtime?.provider;
  const sessionLabel = `${provider === "codex" ? "Codex" : provider === "claude-code" ? "Claude Code" : "Runtime"} 会话 ID`;
  const session = `<div class="console-session-id"><span>${esc(sessionLabel)}</span><code>${esc(trace.providerSessionId || "未记录")}</code></div>`;
  const body = trace.promptRef
    ? `<div class="prompt-snapshot-body" data-prompt-snapshot="${esc(trace.id)}" data-content-run="${esc(runId)}"${trace.contentBase ? ` data-content-url="${esc(trace.contentBase)}/traces/${esc(trace.id)}/prompt"` : ""}><span class="muted">正在读取提示词快照…</span></div>${session}`
    : `<p class="tool-audit-note">该次调用未保存提示词快照。</p>${session}`;
  return `<div class="log-row log-row-trace-prompt"><div class="log-meta"><time class="log-time">${esc(exactTime(trace.startedAt))}</time><span class="log-level system">TRACE</span></div><div class="log-body"><details data-console-key="prompt:${esc(trace.id)}" class="prompt-snapshot"><summary><span class="console-tool-chevron">▶</span><strong>${esc(label)}</strong><small>本次调用提示词 · 已脱敏</small></summary>${body}</details></div></div>`;
}

function tracePromptFallbackMarkup(traceId) {
  return `<div class="log-row log-row-trace-prompt"><div class="log-meta"><span class="log-level system">TRACE</span></div><div class="log-body"><p class="tool-audit-note">调用的 Trace 记录不在当前读取范围内，其提示词快照不可定位。</p></div></div>`;
}

function consoleFailurePanel(workspace, agentId) {
  const failure = [...(workspace.failureEvents || [])].reverse().find((event) => event.actor?.id === agentId);
  if (!failure) return "";
  const dispatch = (workspace.dispatches || []).find(item => item.traceIds?.includes(failure.data?.traceId));
  const pending = dispatch?.status === 'queued' && dispatch.nextRetryAt ? dispatch : null;
  const terminal = ['completed', 'done', 'awaiting_acceptance', 'cancelled'].includes(workspace.run?.status);
  const historical = dispatch?.status === 'done' || dispatch?.status === 'cancelled' || terminal;
  const content = `<div><strong>${historical ? '历史失败详情' : '最近一次失败'}</strong><time>${esc(new Date(failure.timestamp).toLocaleString())}</time></div><p>${esc(failure.data?.auditVersion === 2 ? failure.message : "历史失败未保留安全诊断，不能从旧日志推断具体原因。")}</p><small>${historical ? '该次调用已结束，当前任务无需因这条历史记录重试；原始记录保留供追溯。' : pending ? `等待重试 · 已尝试 ${pending.attempts} 次 · 下次 ${new Date(pending.nextRetryAt).toLocaleString()}` : dispatch?.status === 'claimed' ? '正在重新执行，等待本次调用结果。' : '请结合当前任务状态查看该次调用。'}</small><div>${failure.data?.traceId ? `<button class="text-action trace-link" data-open-collaboration-trace="${esc(failure.data.traceId)}">${historical ? "查看原始记录" : "定位失败记录"}</button>` : ""}${historical ? '' : '<button class="small-button" data-open-runtime-settings>运行设置</button>'}</div>`;
  return historical ? `<details class="console-failure console-failure-history"><summary>历史失败 · ${dispatch?.status === 'done' ? '后续重试已完成' : '非当前故障'}</summary>${content}</details>` : `<section class="console-failure" aria-label="最近执行失败">${content}</section>`;
}

function renderConsolePage({ prepend = false } = {}) {
  if (state.currentView !== "workspace" || workspaceView().tab !== "console") return;
  const stream = $("#trace-stream"), agent = workspaceAgents(state.workspace, state.agents).find((item) => item.id === state.selectedAgentId);
  if (!stream || !agent) return;
  const page = consolePage(state.selectedRunId, agent.id);
  const top = stream.scrollTop, height = stream.scrollHeight, following = height - top - stream.clientHeight < 48;
  const open = new Set([...stream.querySelectorAll("details[open][data-console-key]")].map((item) => item.dataset.consoleKey));
  const closed = new Set([...stream.querySelectorAll("details[data-default-open]:not([open])")].map((item) => item.dataset.consoleKey));
  renderChatStream(page.events, agent, { traceId: page.traceId, hasMore: page.hasMore });
  const controls = document.createElement("div"); controls.className = "console-history-controls";
  controls.innerHTML = `${page.hasMore ? '<button class="small-button" data-console-older>加载更早记录</button>' : ""}${page.traceId ? '<button class="small-button" data-console-reset>查看该角色全部执行</button>' : ""}${page.loading ? '<span role="status">正在加载记录…</span>' : ""}${page.error ? `<span role="alert">${esc(page.error)}</span><button class="small-button" data-console-retry>重试</button>` : ""}`;
  for (const button of controls.querySelectorAll("button")) button.disabled = page.loading;
  stream.prepend(controls);
  for (const details of stream.querySelectorAll("details[data-console-key]")) details.open = open.has(details.dataset.consoleKey) || (details.dataset.defaultOpen !== undefined && !closed.has(details.dataset.consoleKey));
  stream.scrollTop = prepend ? top + stream.scrollHeight - height : following ? stream.scrollHeight : top;
}

async function loadConsolePage(runId, agentId, { older = false, reset = false, traceId } = {}) {
  const page = consolePage(runId, agentId);
  if (page.loading && !reset) return;
  if (reset) { page.events = []; page.loaded = false; page.hasMore = false; page.nextBefore = null; page.browsingHistory = false; }
  if (older) page.browsingHistory = true;
  if (traceId !== undefined) page.traceId = traceId;
  const request = ++page.request;
  const query = new URLSearchParams({ agentId, limit: "50" });
  if (older && page.nextBefore) query.set("before", page.nextBefore);
  if (page.traceId) query.set("traceId", page.traceId);
  page.loading = true; page.error = null;
  if (state.selectedRunId === runId && state.selectedAgentId === agentId) renderConsolePage();
  try {
    const result = await api(`/api/runs/${encodeURIComponent(runId)}/console?${query}`);
    if (request !== page.request) return;
    page.events = [...new Map([...result.events, ...page.events].map((event) => [event.id, event])).values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    page.loaded = true; page.hasMore = result.hasMore; page.nextBefore = result.nextBefore;
  } catch (error) { if (request === page.request) page.error = error.message; }
  finally { if (request === page.request) { page.loading = false; if (state.selectedRunId === runId && state.selectedAgentId === agentId) renderConsolePage({ prepend: older }); } }
}

function isCurrentRuntimeAudit(event) {
  return event?.type === "runtime.event" && event.data?.auditVersion === 2;
}

function runtimeAuditText(event) {
  if (event?.type === "runtime.event" && !isCurrentRuntimeAudit(event)) return "历史运行记录已按当前审计边界隐藏原始内容。";
  if (event?.type === "trace.failed" && event.data?.auditVersion !== 2) return "历史 Trace 失败原因已按当前审计边界隐藏原始内容。";
  return displayText(event) || "收到运行时事件";
}

function historicalAuditEntry(entry) {
  const event = entry?.type === "event" ? entry.event : null;
  return event?.type === "runtime.event" && !isCurrentRuntimeAudit(event) ? event : null;
}

function summarizeHistoricalAuditEntries(entries) {
  const summarized = [];
  for (const entry of entries) {
    const event = historicalAuditEntry(entry);
    if (!event) { summarized.push(entry); continue; }
    const previous = summarized.at(-1);
    if (previous?.type === "historical-audit-summary") {
      previous.count += 1;
      previous.lastTimestamp = event.timestamp;
      continue;
    }
    summarized.push({ type: "historical-audit-summary", count: 1, firstTimestamp: event.timestamp, lastTimestamp: event.timestamp });
  }
  return summarized;
}

function renderHistoricalAuditSummary(summary) {
  const first = exactTime(summary.firstTimestamp);
  const last = exactTime(summary.lastTimestamp);
  const time = first === last ? first : `${first} — ${last}`;
  return `<div class="log-row log-row-historical-audit"><div class="log-meta"><time class="log-time">${esc(time)}</time><span class="log-level">HISTORICAL</span></div><div class="log-body"><div class="historical-audit-summary"><strong>已隐藏 ${summary.count} 条历史运行明细</strong><span>这些记录产生于当前审计边界前；原始内容不会在控制台回显。</span></div></div></div>`;
}

function renderToolCall(entry, { compact = false } = {}) {
  const event = entry.event;
  const result = entry.result;
  const current = isCurrentRuntimeAudit(event);
  const toolName = current ? event.data?.toolName || result?.data?.toolName || "本机工具" : "历史工具调用";
  const resultType = String(result?.data?.providerEventType || result?.data?.presentation || "");
  const status = /error|failed/i.test(resultType) || ["failed", "error"].includes(result?.data?.status) || event.data?.status === "failed" || event.data?.status === "error"
    ? "failed" : result || event.data?.status === "completed" ? "completed" : "running";
  const rightStatus = status === "running" ? `<span class="console-tool-running" title="运行中"></span><span class="console-tool-lines">运行中</span>`
    : status === "failed" ? `<span class="console-tool-failed">失败</span>`
    : `<span class="console-tool-lines">已完成</span>`;
  const hasContent = Boolean(event.data?.contentRef || result?.data?.contentRef);
  const direct = toolName === "StructuredOutput" && hasContent;
  const tag = direct ? "div" : "details", heading = direct ? "div" : "summary";
  // Edit invocations open by default so the real diff is visible without a
  // click; data-default-open lets refresh logic respect a manual collapse.
  const defaultOpen = !direct && toolName === "Edit";
  const summary = current && event.data?.contentRef && (isShellTool(toolName) || ["read", "write"].includes(toolName.toLowerCase()))
    ? `<code class="console-tool-summary" data-console-summary="${esc(event.id)}" data-content-run="${esc(event.runId)}"${event.contentBase ? ` data-content-url="${esc(event.contentBase)}/console-content/${esc(event.id)}"` : ""}></code>` : "";
  const body = current && toolName.toLowerCase() === "read" && status === "completed"
    ? '<p class="tool-audit-note">Done</p>'
    : `${consoleContentMarkup(event)}${result ? consoleContentMarkup(result) : ""}`;
  const call = `<${tag} data-console-key="tool:${esc(event.id)}" data-tool-name="${esc(toolName)}"${defaultOpen ? " data-default-open open" : ""} class="console-tool-call ${direct ? "structured-output" : ""} ${status === "running" ? "pending" : ""} ${status === "failed" ? "failed" : ""}"><${heading}${direct ? ' class="console-tool-heading"' : ""}>${direct ? "" : '<span class="console-tool-chevron">▶</span>'}<strong>${esc(toolName)}</strong>${summary}${rightStatus}</${heading}><div class="console-tool-body">${body}${!hasContent ? '<p class="tool-audit-note">此记录当时仅保存工具名称、状态与关联；参数和输出未保存。</p>' : ""}</div></${tag}>`;
  if (compact) return `<div class="console-tool-group-item">${call}</div>`;
  const time = exactTime(event.timestamp);
  return `<div class="log-row log-row-tool"><div class="log-meta"><time class="log-time">${esc(time)}</time><span class="log-level tool">TOOL</span></div><div class="log-body">${call}</div></div>`;
}

function renderToolEntry(entry) {
  return renderToolCall(entry);
}

function renderToolGroup(group) {
  const toolName = isCurrentRuntimeAudit(group.tools[0].event) ? group.toolName : "历史工具调用";
  const time = exactTime(group.timestamp);
  const defaultOpen = isShellTool(toolName) || ["read", "write"].includes(toolName.toLowerCase());
  return `<div class="log-row log-row-tool-group"><div class="log-meta"><time class="log-time">${esc(time)}</time><span class="log-level tool">TOOL ×${group.tools.length}</span></div><div class="log-body"><details data-console-key="group:${esc(group.tools[0].event.id)}"${defaultOpen ? " data-default-open open" : ""} class="console-tool-group"><summary><span class="console-tool-chevron">▶</span><span class="console-tool-symbol">›</span><strong>${esc(toolName)}</strong><span class="tool-group-count">×${group.tools.length}</span><code class="console-tool-preview">状态摘要</code></summary><div class="console-tool-group-body">${group.tools.map((entry) => renderToolCall(entry, { compact: true })).join("")}</div></details></div></div>`;
}

function consoleSessionMarkup(event, trace, agent) {
  const created = event.type === 'session.created', resumed = event.type === 'session.resumed';
  const initialized = event.type === 'runtime.event' && event.data?.auditVersion === 2 && (event.data.providerEventType === 'thread.started' || (event.data.providerEventType === 'system' && event.data.subtype === 'init'));
  if (!created && !resumed && !initialized) return '';
  if (trace && (trace.id !== event.data?.traceId || trace.agentId !== event.actor?.id)) return '';
  const provider = trace?.agent?.runtime?.provider || agent?.runtime?.provider;
  if (!['claude-code','codex'].includes(provider)) return '';
  const label = provider === 'codex' ? 'Codex' : 'Claude Code';
  let id = trace?.providerSessionId || (provider === 'claude-code' || resumed ? event.data?.sessionId : null);
  // Codex allocates its native thread ID only on thread.started. Its initial
  // platform placeholder must never be presented as a resumable provider ID.
  if (provider === 'codex' && created && (!trace?.providerSessionId || (trace.sessionMode !== 'resume' && trace.providerSessionId === event.data?.sessionId))) id = null;
  if (!id) return `<small class="console-session-id">${label} 会话 ID：${created ? '等待 Provider 初始化' : '未记录'}</small>`;
  return `<div class="console-session-id"><span>${label} 会话 ID</span><code>${esc(id)}</code></div>`;
}

function renderChatEvent(event, trace, agent) {
  const kind = classifyEvent(event);
  const time = exactTime(event.timestamp);
  const text = runtimeAuditText(event);
  const providerType = event.data?.providerEventType || "system";
  const legacyRuntime = event.type === "runtime.event" && !isCurrentRuntimeAudit(event);
  const recordType = legacyRuntime ? "HISTORICAL EVENT" : event.data?.presentation === "thinking" ? "THINKING" : providerType === "assistant" ? "TEXT" : providerType === "user" ? "USER EVENT" : providerType === "stderr" ? "STDERR" : (KIND_LABEL[kind] || providerType).toUpperCase();
  const meta = `<time class="log-time">${esc(time)}</time><span class="log-level ${kind}">${esc(recordType)}</span>`;
  let body = "";
  if (legacyRuntime) {
    body = `<div class="log-message">${esc(text)}</div>`;
  } else if (kind === "tool") {
    return renderToolEntry({ type: "tool", event, result: null });
  } else if (event.data?.contentRef) {
    body = consoleContentMarkup(event);
  } else if (event.type === "runtime.event" && providerType === "assistant") {
    body = `<div class="log-message">${esc(text)}</div><small class="tool-audit-note">此记录当时未保存正文或思考内容，仅有状态摘要。</small>`;
  } else if (kind === "deliver") {
    body = `<div class="log-message deliver">✓ ${esc(text)}</div>`;
  } else if (kind === "thinking") {
    body = `<div class="log-message">${esc(text)}</div>`;
  } else if (kind === "error") {
    body = `<div class="log-message error">${esc(text)}</div>`;
  } else {
    body = `<div class="log-message">${esc(text)}</div>`;
  }
  return `<div class="log-row"><div class="log-meta">${meta}</div><div class="log-body">${body}${consoleSessionMarkup(event, trace, agent)}</div></div>`;
}

/* 初次进入跟随最新；后续由 Run 的本地阅读状态决定是否跟随。 */
function renderChatStream(events, agent, { traceId = null, hasMore = false, stream = $("#trace-stream"), runId = state.selectedRunId, traces = null } = {}) {
  if (!stream) return;
  // Collaboration content has its own view; echoing message.sent here repeats
  // the Provider's final TEXT as a second, misleading "system" response.
  const list = events.filter((event) => event.actor?.id === agent.id && event.type !== "message.sent" && !isTransportFrame(event)).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const entries = summarizeHistoricalAuditEntries(buildConsoleEntries(list));
  const workspaceTraces = traces || (state.workspace?.run?.id === runId ? state.workspace.traces || [] : []);
  const traceById = new Map(workspaceTraces.map((trace) => [trace.id, trace]));
  const entryTraceId = (entry) => entry.type === "tool-group" ? entry.tools[0].event.data?.traceId : entry.event?.data?.traceId || null;
  const timestamp = (value) => { const time = Date.parse(value); return Number.isFinite(time) ? time : null; };
  const entryTime = (entry) => timestamp(entry.event?.timestamp || entry.timestamp || entry.firstTimestamp);
  // Page boundaries come from the raw member page, including hidden transport
  // frames. A prompt is an ordinary timestamped entry, not a header for a
  // partially loaded invocation. Reveal it only when history reaches its time.
  const pageTimes = events.filter((event) => event.actor?.id === agent.id).map((event) => timestamp(event.timestamp)).filter((time) => time !== null);
  const windowStart = pageTimes.length ? Math.min(...pageTimes) : null;
  const encountered = new Map();
  const rows = [];
  for (const entry of entries) {
    const currentTraceId = entryTraceId(entry);
    if (currentTraceId && !encountered.has(currentTraceId)) encountered.set(currentTraceId, entryTime(entry));
    rows.push({ time: entryTime(entry), html: entry.type === "historical-audit-summary" ? renderHistoricalAuditSummary(entry) : entry.type === "tool" ? renderToolEntry(entry) : entry.type === "tool-group" ? renderToolGroup(entry) : renderChatEvent(entry.event, traceById.get(currentTraceId), agent) });
  }
  const candidates = new Set([...encountered.keys(), ...workspaceTraces.filter((trace) => trace.agentId === agent.id).map((trace) => trace.id)]);
  for (const id of candidates) {
    if (traceId && id !== traceId) continue;
    const trace = traceById.get(id);
    const time = timestamp(trace?.startedAt) ?? encountered.get(id) ?? null;
    if (hasMore && (time === null || (windowStart !== null && time < windowStart))) continue;
    rows.push({ time, prompt: true, html: trace ? tracePromptMarkup(trace, runId, agent) : tracePromptFallbackMarkup(id) });
  }
  rows.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || Number(Boolean(b.prompt)) - Number(Boolean(a.prompt)));
  stream.innerHTML = rows.length ? rows.map((row) => row.html).join("")
    : `<div class="chat-empty">尚无执行内容。<br />正文、思考、工具调用和异常将在这里显示。</div>`;
  stream.scrollTop = stream.scrollHeight;
  queueMicrotask(() => observeConsoleContent(stream));
}

const consoleContentCache = new Map();
function consoleContentMarkup(event) {
  if (!event?.data?.contentRef) return "";
  const body = `<div class="execution-content" data-console-content="${esc(event.id)}" data-content-run="${esc(event.runId)}"${event.contentBase ? ` data-content-url="${esc(event.contentBase)}/console-content/${esc(event.id)}"` : ""}><span class="muted">正在读取执行内容…</span></div>`;
  return body;
}

const markdownReady = () => typeof window.marked?.parse === "function" && typeof window.DOMPurify?.sanitize === "function";
let markdownUpgradeScheduled = false;
// Console bodies and collaboration records render Markdown once the vendored
// parser is in; until then (or if loading fails) the escaped plain text stays.
function ensureMarkdownVendors() {
  if (markdownReady() || markdownUpgradeScheduled) return;
  markdownUpgradeScheduled = true;
  Promise.all([loadVendor("marked"), loadVendor("dompurify")]).then(() => {
    markdownUpgradeScheduled = false;
    if (state.currentView === "workspace" && state.workspace?.run) renderWorkspace();
  }).catch(() => { markdownUpgradeScheduled = false; });
}
function markdownContent(text) {
  return formatCommunicationContent(text, { parse: window.marked?.parse, sanitize: window.DOMPurify?.sanitize });
}

// Shell tool input/output is terminal content, never Markdown: the command
// keeps its real line breaks and light Shell coloring; output stays verbatim.
function shellFieldMarkup(kind, field, toolName) {
  const note = field.redacted || field.truncated ? `<small>${field.redacted ? "已脱敏 " : ""}${field.truncated ? "内容过长，已截断" : ""}</small>` : "";
  if (kind === "input") {
    const command = shellCommandText(toolName, field.text);
    const text = command ?? String(field.text ?? "");
    const html = shellTokens(text).map((token) => token.kind === "plain" ? esc(token.text) : `<span class="shell-token-${token.kind}">${esc(token.text)}</span>`).join("");
    return `<section data-execution-kind="${kind}"><small>${command ? "命令" : "输入 · 原始内容"} · Shell</small><pre class="shell-code shell-command" tabindex="0"><code>${html}</code></pre>${command ? "" : "<small>命令参数不可解析，如实显示原始已脱敏输入。</small>"}${note}</section>`;
  }
  return `<section data-execution-kind="${kind}"><small>输出 · Shell</small><pre class="shell-code shell-output" tabindex="0"><code>${esc(String(field.text ?? ""))}</code></pre>${note}</section>`;
}

function fileToolFieldMarkup(kind, field, toolName) {
  if (kind !== "input") return null;
  const input = toolFileInput(toolName, field.text);
  if (!input) return null;
  if (toolName.toLowerCase() === "read") return "";
  if (input.content === null) return null;
  const note = field.redacted || field.truncated ? `<small>${field.redacted ? "已脱敏 " : ""}${field.truncated ? "内容过长，已截断" : ""}</small>` : "";
  return `<section data-execution-kind="input"><small>写入内容</small><pre class="execution-text"><code>${esc(input.content)}</code></pre>${note}</section>`;
}

// Git-style diff for a real Edit invocation. Every line comes from the
// already-redacted input; nothing is invented or re-aligned silently.
function editDiffMarkup(edit) {
  const diff = editDiff(edit.oldText, edit.newText);
  if (!diff) return "";
  const signs = { add: "+", del: "-", context: " " };
  const path = edit.filePath || "未记录路径";
  const lines = [
    `<span class="diff-line diff-meta">--- a/${esc(path)}</span>`,
    `<span class="diff-line diff-meta">+++ b/${esc(path)}</span>`,
    ...diff.lines.map((line) => `<span class="diff-line diff-${line.type}">${signs[line.type]}${esc(line.text) || " "}</span>`),
  ];
  return `<pre class="edit-diff" tabindex="0"><code>${lines.join("")}</code></pre>${diff.aligned ? "" : "<small>变更行较多，已按删除后新增顺序如实排列</small>"}`;
}

// Read heavy bodies only when visible and all enclosing disclosures are open.
function consoleContentVisible(node) {
  const communication = state.currentView === 'communication' && node.closest?.('[data-communication-console]')?.dataset.open === 'true';
  if (!node.isConnected || (!communication && (state.currentView !== "workspace" || workspaceView().tab !== "console"))) return false;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    // A summary is visible even when its own tool is closed. Outer groups
    // still gate their descendants; bodies and prompt snapshots remain lazy.
    if (node.dataset?.consoleSummary && parent === node.parentElement?.parentElement && parent.dataset?.toolName) continue;
    if (parent.tagName === "DETAILS" && !parent.open) return false;
  }
  return true;
}
let consoleContentObserver;
function observeConsoleContent(stream = $("#trace-stream")) {
  consoleContentObserver?.disconnect();
  if (!stream || (state.currentView === 'workspace' && workspaceView().tab !== "console")) return;
  consoleContentObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter(entry => entry.isIntersecting && consoleContentVisible(entry.target)).map(entry => entry.target);
    for (const node of visible) consoleContentObserver.unobserve(node);
    void hydrateConsoleContent(visible.filter(node => node.dataset.consoleContent || node.dataset.consoleSummary));
    void hydratePromptSnapshots(visible.filter(node => node.dataset.promptSnapshot));
  }, { root: stream, rootMargin: "200px" });
  for (const node of stream.querySelectorAll("[data-console-content], [data-console-summary], [data-prompt-snapshot]")) {
    if (!node.dataset.contentLoading && consoleContentVisible(node)) consoleContentObserver.observe(node);
  }
}

async function hydrateConsoleContent(nodes = []) {
  // Four workers bound per-page reads; promises also deduplicate live refreshes.
  async function worker() {
    while (nodes.length) {
      const node = nodes.shift();
      if (!consoleContentVisible(node) || node.dataset.contentLoading) continue;
      node.dataset.contentLoading = "1";
      const eventId = node.dataset.consoleSummary || node.dataset.consoleContent;
      const url = node.dataset.contentUrl || `/api/runs/${encodeURIComponent(node.dataset.contentRun)}/console-content/${encodeURIComponent(eventId)}`;
      const key = url;
      if (!consoleContentCache.has(key)) {
        consoleContentCache.set(key, api(url).then(value => ({ value }), () => ({ error: "执行内容不可读取或校验失败；刷新后可重试。" })));
        if (consoleContentCache.size > 1000) consoleContentCache.delete(consoleContentCache.keys().next().value);
      }
      const result = await consoleContentCache.get(key);
      if (!node.isConnected) continue;
      const stream = node.closest('#trace-stream, [data-communication-stream]');
      const following = stream && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48;
      const toolDetails = node.closest("[data-tool-name]");
      const toolName = toolDetails?.dataset.toolName || "";
      if (node.dataset.consoleSummary) {
        const summary = !result.error && toolCommandSummary(toolName, result.value.fields?.input?.text);
        node.textContent = result.error ? result.error : summary || "";
        node.title = node.textContent;
        continue;
      }
      const labels = { text: "正文", thinking: "思考 · Provider 公开内容", input: "输入", output: "输出" };
      const shell = isShellTool(toolName);
      node.innerHTML = result.error ? `<p role="alert">${esc(result.error)}</p>` : Object.entries(result.value.fields || {}).filter(([kind]) => labels[kind]).map(([kind, field]) => {
        const edit = kind === "input" ? toolEditInput(toolName, field.text) : null;
        if (edit) return `<section data-execution-kind="${kind}"><small>${labels[kind]} · 变更差异</small>${editDiffMarkup(edit)}${field.redacted || field.truncated ? `<small>${field.redacted ? "已脱敏 " : ""}${field.truncated ? "内容过长，已截断" : ""}</small>` : ""}</section>`;
        if (shell && (kind === "input" || kind === "output")) return shellFieldMarkup(kind, field, toolName);
        const file = fileToolFieldMarkup(kind, field, toolName);
        if (file !== null) return file;
        if (kind === "text") {
          const note = field.redacted || field.truncated ? `<small>${field.redacted ? "已脱敏 " : ""}${field.truncated ? "内容过长，已截断" : ""}</small>` : "";
          if (markdownReady()) return `<section data-execution-kind="${kind}"><small>${labels[kind]} · Markdown</small><div class="console-markdown">${markdownContent(field.text)}</div>${note}</section>`;
          ensureMarkdownVendors();
          return `<section data-execution-kind="${kind}"><small>${labels[kind]}</small><pre class="execution-text"><code>${esc(field.text)}</code></pre>${note}</section>`;
        }
        const formatted = consoleContentTokens(field.text, { json: kind === "input" || kind === "output", truncated: field.truncated });
        const html = formatted.tokens.map(token => token.kind === "plain" ? esc(token.text) : `<span class="hljs-${token.kind}">${esc(token.text)}</span>`).join("");
        const content = `<pre class="execution-text${formatted.json ? " execution-json" : ""}"><code>${html}</code></pre>${field.redacted || field.truncated ? `<small>${field.redacted ? "已脱敏 " : ""}${field.truncated ? "内容过长，已截断" : ""}</small>` : ""}`;
        return `<section data-execution-kind="${kind}"><small>${labels[kind]}${formatted.json ? " · JSON" : ""}</small>${content}</section>`;
      }).join("");
      // Older immutable audits may contain arguments in both native phases.
      // Hide only an identical public input within this exact tool call; keep
      // distinct/changed arguments and every independently identified call.
      if (toolDetails) {
        const seen = new Set();
        for (const section of toolDetails.querySelectorAll('[data-execution-kind="input"]')) {
          const input = section.querySelector('pre')?.textContent;
          if (input === undefined) continue;
          if (seen.has(input)) section.hidden = true;
          else { seen.add(input); section.hidden = false; }
        }
      }
      if (following) stream.scrollTop = stream.scrollHeight;
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
}

const promptSnapshotCache = new Map();
async function hydratePromptSnapshots(nodes = []) {
  for (const node of nodes) {
    if (!consoleContentVisible(node) || node.dataset.contentLoading) continue;
    node.dataset.contentLoading = "1";
    const url = node.dataset.contentUrl || `/api/runs/${encodeURIComponent(node.dataset.contentRun)}/traces/${encodeURIComponent(node.dataset.promptSnapshot)}/prompt`;
    const key = url;
    if (!promptSnapshotCache.has(key)) {
      promptSnapshotCache.set(key, api(url).then((value) => ({ value }), (error) => ({ error: `${error?.message || "提示词快照不可读取或完整性校验失败"}；刷新后可重试。` })));
      if (promptSnapshotCache.size > 200) promptSnapshotCache.delete(promptSnapshotCache.keys().next().value);
    }
    const result = await promptSnapshotCache.get(key);
    if (!node.isConnected) continue;
    const prompt = result.value?.prompt || {};
    node.innerHTML = result.error
      ? `<p role="alert">${esc(result.error)}</p>`
      : `<pre class="prompt-snapshot-text">${esc(prompt.text || "")}</pre>${prompt.truncated ? '<small>快照已截断。</small>' : ""}`;
  }
}


function rememberDirectoryReading(view) {
  const host = $("#working-directory-panel");
  if (!host || host.hidden) return;
  host.querySelectorAll("details[data-directory-path]").forEach((item) => { view.directoryOpen[item.dataset.directoryPath] = item.open; });
  view.directoryScroll.tree = host.querySelector(".artifact-files")?.scrollTop || 0;
  const reader = host.querySelector(".markdown-preview, .artifact-preview");
  if (reader && view.previewPath) view.directoryScroll[view.previewPath] = reader.scrollTop;
}

function directoryNodeIcon(entry, theme) {
    if (theme === "classic") return entry.type === "directory" ? `<span class="file-icon" aria-hidden="true">▱</span>` : `<span class="file-icon" aria-hidden="true">▫</span>`;
    const icon = workingDirectoryIcon(entry.name, entry.type);
    return entry.type === "directory"
      ? `<img class="file-icon-svg directory-icon-closed" src="/icons/vscode/${icon.closed}.svg" alt="" aria-hidden="true" loading="lazy" /><img class="file-icon-svg directory-icon-open" src="/icons/vscode/${icon.open}.svg" alt="" aria-hidden="true" loading="lazy" />`
      : `<img class="file-icon-svg" src="/icons/vscode/${icon.closed}.svg" alt="" aria-hidden="true" loading="lazy" />`;
}

// One explorer for both current files and CHANGE. Only selection, disclosure
// state and the optional change badge differ; hierarchy and icons stay shared.
function workingFileTree(entries = [], view, theme, changes = false) {
  const selected = changes ? view.selectedDiffPath : view.selectedPath;
  const open = (changes ? view.diffTreeOpen : view.directoryOpen) || {};
  const folderAttribute = changes ? "data-diff-directory" : "data-directory-path";
  const fileAttribute = changes ? "data-select-diff" : "data-select-working-file";
  const badge = entry => changes && entry.change ? `<span class="source-status-${esc(entry.change.status)}" aria-label="${esc({ A: "新增", M: "修改", D: "删除" }[entry.change.status] || "更改")}">${esc(entry.change.status)}</span>` : "";
  return `<ul class="artifact-tree-list">${[...entries].sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name)).map(entry => entry.type === "directory"
    ? `<li><details class="explorer-folder" ${folderAttribute}="${esc(entry.path)}" ${(changes ? open[entry.path] !== false : open[entry.path] === true) ? "open" : ""}><summary><span class="folder-chevron" aria-hidden="true">›</span>${directoryNodeIcon(entry, theme)}${esc(entry.name)}${entry.change ? `<button class="text-action source-change-marker" data-select-diff="${esc(entry.path)}" aria-label="查看 ${esc(entry.path)} 的仓库提交变化" title="查看仓库提交变化">${badge(entry)}</button>` : ""}</summary>${changes || entry.children ? workingFileTree(entry.children, view, theme, changes) : directoryPageMarkup(entry.path,view,theme)}</details></li>`
    : `<li><button class="artifact-tree-file ${selected === entry.path ? "selected" : ""}" ${fileAttribute}="${esc(entry.path)}" title="${esc(entry.path)}"><strong>${directoryNodeIcon(entry, theme)}${esc(entry.name)}</strong>${badge(entry)}</button></li>`).join("")}</ul>`;
}

function directoryPageMarkup(path,view,theme) {
  const page=path?view.directoryPages?.[path]:view.directory;
  const entries=page?.entries || [];
  return `${workingFileTree(entries,view,theme)}${page?.loading?'<p role="status">正在读取…</p>':page?.error?`<p role="alert">${esc(page.error)}</p><button class="text-action" data-load-directory="${esc(path)}">重试</button>`:!page?'<p>展开后读取</p>':!entries.length?'<p class="muted">空目录</p>':''}${page?.nextOffset!=null?`<button class="text-action" data-load-more-directory="${esc(path)}" ${page.loading?'disabled':''}>加载更多</button>`:''}`;
}

function renderWorkingDirectory(runId) {
  if (state.selectedRunId !== runId) return;
  const host = $("#working-directory-panel"), view = workspaceView(runId);
  if (!host) return;
  rememberDirectoryReading(view);
  const preview = view.filePreview;
  // The directory theme is a local display preference scoped strictly to this
  // panel: icons plus the selected file's content colors, nothing else.
  const theme = presentationPreferences.directoryTheme || "vscode-light";
  host.dataset.directoryTheme = theme;
  let content = '<div class="artifact-placeholder">选择文件查看内容</div>';
  if (preview) {
    if (preview.error || preview.loading) content = `<div class="artifact-placeholder">${esc(preview.error || "正在读取文件…")}</div>`;
    else if (preview.image) content = `<img class="artifact-image-preview" src="/api/runs/${encodeURIComponent(runId)}/working-directory/content?raw=1&path=${encodeURIComponent(view.selectedPath)}" alt="${esc(view.selectedPath)}" />`;
    else if (preview.content == null) content = '<div class="artifact-placeholder">二进制文件不支持文本预览</div>';
    else if (/\.md$/i.test(view.selectedPath) && window.marked && window.DOMPurify) content = `<article class="markdown-preview">${window.DOMPurify.sanitize(window.marked.parse(preview.content))}</article>`;
    else content = `<pre class="artifact-preview code-preview hljs"><code>${preview.highlightedHtml || esc(preview.content)}</code></pre>`;
  }
  host.innerHTML = `<div class="directory-toolbar"><div><strong>文件</strong></div><div class="directory-actions"><button class="ghost-button" data-download-working-file ${!view.selectedPath || view.downloadingPath ? "disabled" : ""} ${view.downloadingPath ? 'aria-busy="true"' : ""}>${view.downloadingPath ? "下载中…" : "下载"}</button><button class="ghost-button" data-refresh-directory ${view.directoryLoading ? "disabled" : ""}>${view.directoryLoading ? "读取中…" : "刷新"}</button></div></div>
    ${view.directoryError ? `<p role="alert">${esc(view.directoryError)}</p>` : ""}
    <div class="artifact-layout"><div class="artifact-files"><section class="artifact-root">${directoryPageMarkup('',view,theme)}</section></div><div class="artifact-viewer document"><div class="artifact-viewer-head"><strong>${esc(view.selectedPath || "文件预览")}</strong><small>当前工作文件 ${preview?.modifiedAt ? "· " + esc(preview.modifiedAt) : ""}</small></div>${content}</div></div>`;
  host.querySelector(".artifact-files").scrollTop = view.directoryScroll.tree || 0;
  const reader = host.querySelector(".markdown-preview, .artifact-preview");
  if (reader) reader.scrollTop = view.directoryScroll[view.selectedPath] || 0;
  view.previewPath = view.selectedPath;
}

async function loadWorkingDirectory(runId,{path='',more=false}={}) {
  const view=workspaceView(runId);
  if(!path && !more){rememberDirectoryReading(view);++view.directoryRequest;view.directoryPages=Object.create(null);view.directory=null;}
  if(!path)view.directoryError=null;
  view.directoryPages ||= Object.create(null);
  const page=path?(view.directoryPages[path] ||= {entries:[]}):(view.directory ||= {entries:[]});
  if(page.loading)return;
  const request=view.directoryRequest;
  page.loading=true;page.error=null;if(!path)view.directoryLoading=true;renderWorkingDirectory(runId);
  try{
    const data=await api(`/api/runs/${encodeURIComponent(runId)}/working-directory?path=${encodeURIComponent(path)}&offset=${more?page.nextOffset || 0:0}`);
    if(request!==view.directoryRequest)return;
    page.entries=more?[...new Map([...page.entries,...data.entries].map(entry=>[entry.path,entry])).values()]:data.entries;page.nextOffset=data.nextOffset;
    for(const entry of page.entries)if(entry.type==='directory' && view.directoryOpen[entry.path] && !view.directoryPages[entry.path])void loadWorkingDirectory(runId,{path:entry.path});
  }catch(error){if(request===view.directoryRequest){page.error=error.message;if(!path)view.directoryError=error.message;}}
  finally{if(request===view.directoryRequest){page.loading=false;if(!path)view.directoryLoading=false;renderWorkingDirectory(runId);}}
  if(!path && view.selectedPath && request===view.directoryRequest)await loadWorkingFile(runId,view.selectedPath);
}

async function downloadWorkingFile(runId) {
  const view = workspaceView(runId), path = view.selectedPath;
  if (!path || view.downloadingPath) return;
  view.downloadingPath = path; renderWorkingDirectory(runId);
  let url, link;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/working-directory/content?download=1&path=${encodeURIComponent(path)}`);
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || "文件下载失败"); }
    url = URL.createObjectURL(await response.blob());
    link = document.createElement("a"); link.href = url; link.download = path.split("/").at(-1);
    document.body.append(link); link.click();
  } catch (error) { toast(`下载失败：${error.message}`, true); }
  finally {
    link?.remove();
    // Give the browser download handler time to take ownership of the Blob.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    view.downloadingPath = null; renderWorkingDirectory(runId);
  }
}

async function loadWorkingFile(runId, path) {
  const view = workspaceView(runId), request = ++view.fileRequest;
  view.selectedPath = path; view.filePreview = { loading: true }; renderWorkingDirectory(runId);
  try { const [data] = await Promise.all([api(`/api/runs/${encodeURIComponent(runId)}/working-directory/content?path=${encodeURIComponent(path)}`), /\.md$/i.test(path) ? Promise.all([loadVendor("marked"), loadVendor("dompurify")]) : Promise.resolve()]); if (request === view.fileRequest) view.filePreview = data; }
  catch (error) { if (request === view.fileRequest) view.filePreview = { error: error.message }; }
  if (request === view.fileRequest) renderWorkingDirectory(runId);
}

function workingDiffMarkup(preview, layout = "unified") {
  if (!preview) return '<div class="artifact-placeholder">选择文件查看修改内容</div>';
  if (preview.loading || preview.error) return `<div class="artifact-placeholder"${preview.error ? ' role="alert"' : ''}>${esc(preview.error || "正在读取 CHANGE…")}</div>`;
  if (preview.binary || preview.tooLarge) return `<div class="artifact-placeholder">${preview.binary ? "二进制文件已更改，暂不支持文本 CHANGE。" : "文件较大，请在本机 Git 中查看 CHANGE。"}</div>`;
  if (!preview.patch) return '<div class="artifact-placeholder">当前内容与比较版本一致，没有文本改动。</div>';
  let oldLine = 0, newLine = 0, inHunk = false;
  const rows = [], deleted = [], added = [];
  const sideCell = (item, kind) => item ? `<td class="source-line-number source-diff-${kind}">${item.number}</td><td class="source-diff-${kind}"><code>${esc(item.text)}</code></td>` : '<td class="source-line-number"></td><td class="source-diff-empty"></td>';
  const flush = () => {
    for (let i = 0; i < Math.max(deleted.length, added.length); i++) rows.push(`<tr>${sideCell(deleted[i], 'del')}${sideCell(added[i], 'add')}</tr>`);
    deleted.length = 0; added.length = 0;
  };
  for (const line of preview.patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush(); inHunk = true; oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
      rows.push(`<tr class="source-diff-hunk"><td colspan="${layout === 'split' ? 4 : 3}">${esc(line)}</td></tr>`); continue;
    }
    if ((!inHunk && /^(diff |index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line)) || !line) continue;
    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith(' ') ? 'context' : 'note';
    const left = ['del','context'].includes(kind) ? oldLine++ : '';
    const right = ['add','context'].includes(kind) ? newLine++ : '';
    if (layout === 'split') {
      if (kind === 'del') { deleted.push({number:left,text:line.slice(1)}); continue; }
      if (kind === 'add') { added.push({number:right,text:line.slice(1)}); continue; }
      if (kind === 'note') { flush(); rows.push(`<tr class="source-diff-note"><td colspan="4">${esc(line)}</td></tr>`); continue; }
      flush(); rows.push(`<tr>${sideCell({number:left,text:line.slice(1)},'context')}${sideCell({number:right,text:line.slice(1)},'context')}</tr>`);
    } else rows.push(`<tr class="source-diff-${kind}"><td class="source-line-number">${left}</td><td class="source-line-number">${right}</td><td><code>${esc(line)}</code></td></tr>`);
  }
  flush();
  return `<div class="source-diff-reader" tabindex="0" aria-label="文件修改差异"><table class="source-diff-table ${layout === 'split' ? 'source-diff-split' : ''}">${layout === 'split' ? '<colgroup><col class="diff-number-col"><col><col class="diff-number-col"><col></colgroup><thead><tr><th colspan="2">修改前</th><th colspan="2">当前文件</th></tr></thead>' : ''}<tbody>${rows.join('')}</tbody></table></div>`;
}

function workingChangesTree(repo, view, theme) {
    const root = { path: '', children: new Map() };
    for (const change of repo.changes) {
      const parts = change.path.split("/");
      let node = root;
      for (const [index, name] of parts.entries()) {
        const path = node.path ? node.path + "/" + name : name;
        if (!node.children.has(name)) node.children.set(name, { name, path, type: index === parts.length - 1 && !change.submodule ? "file" : "directory", children: new Map() });
        node = node.children.get(name);
      }
      node.change = change;
    }
    const entries = node => ({ ...node, children: [...node.children.values()].map(entries) });
    return workingFileTree([...root.children.values()].map(entries), view, theme, true);
}

function rememberDiffReading(view) {
  const host = $("#working-diff-panel");
  if (!host || host.hidden) return;
  view.diffTreeOpen ||= Object.create(null);
  host.querySelectorAll('[data-diff-directory]').forEach(item => { view.diffTreeOpen[item.dataset.diffDirectory] = item.open; });
  view.diffTreeScroll = host.querySelector('.artifact-files')?.scrollTop || 0;
}

function renderWorkingChanges(runId) {
  if (state.selectedRunId !== runId) return;
  const host = $("#working-diff-panel"), view = workspaceView(runId);
  if (!host) return;
  if (host.querySelector('.artifact-files')) rememberDiffReading(view);
  const treeScroll = view.diffTreeScroll || 0;
  const theme = presentationPreferences.directoryTheme || "vscode-light";
  host.dataset.directoryTheme = theme;
  const rawRepositories = view.changes?.repositories || [];
  const repositories = rawRepositories;
  const count = repositories.reduce((sum, repo) => sum + repo.changes.length, 0);
  const empty = !view.changesLoading && !view.changesError && rawRepositories.length > 0 && rawRepositories.every(repo => repo.initialized && !repo.error && !repo.changes.length);
  host.innerHTML = `<div class="directory-toolbar"><div><strong>更改 · ${count}</strong><small>工作目录中的新增、修改与删除；包含本任务已提交的更改</small></div><div class="diff-view-controls"><div role="group" aria-label="CHANGE 布局"><button class="diff-icon-button" data-diff-layout="unified" aria-pressed="${view.diffLayout !== 'split'}" aria-label="行内" title="行内"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h8"/></svg></button><button class="diff-icon-button" data-diff-layout="split" aria-pressed="${view.diffLayout === 'split'}" aria-label="左右对比" title="左右对比"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M6 9h3M15 9h3M6 14h3M15 14h3"/></svg></button></div><div role="group" aria-label="CHANGE 范围"><button class="diff-icon-button" data-diff-scope="changes" aria-pressed="${!view.diffFull}" aria-label="仅差异" title="仅差异"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h6M7 4v6M4 17h6M14 7h6M14 17h6"/><path d="M14 12h6" opacity=".4"/></svg></button><button class="diff-icon-button" data-diff-scope="full" aria-pressed="${Boolean(view.diffFull)}" aria-label="完整文件" title="完整文件"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8M8 16h8"/></svg></button></div><button class="diff-icon-button diff-refresh-button" data-refresh-changes aria-label="刷新" title="刷新" ${view.changesLoading ? 'disabled aria-busy="true"' : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7M20 7l-2.3-2.3"/></svg></button></div></div>${view.changesError ? `<p role="alert">${esc(view.changesError)}</p>` : ""}<div class="artifact-layout"><div class="artifact-files source-control-files">${repositories.length?`<section class="artifact-root">${workingChangesTree({changes:repositories.flatMap(repo=>repo.changes)},view,theme)}</section>${repositories.map(repo=>repo.error?`<p role="alert">${esc(repo.path || "工作目录")}：${esc(repo.error)}</p>`:!repo.initialized?`<p>${esc(repo.path || "工作目录")}尚未初始化 Git</p>`:"").join("")}`:`<p>${view.changesLoading ? "正在读取更改…" : "暂无仓库记录"}</p>`}${empty ? '<p class="muted" role="status" data-changes-empty>没有更改</p>' : ""}</div><div class="artifact-viewer document"><div class="artifact-viewer-head"><strong>${esc(view.selectedDiffPath || "修改内容")}</strong><small>${view.diffPreview?.submodule ? "HEAD → 当前子模块提交" : `${esc(view.diffPreview?.baseLabel || "比较版本")} → 当前文件`}</small></div>${workingDiffMarkup(view.diffPreview, view.diffLayout)}</div></div>`;
  host.querySelector(".artifact-files").scrollTop = treeScroll;
}

async function loadWorkingChanges(runId) {
  const view = workspaceView(runId), request = ++view.changesRequest;
  view.changesLoading = true; view.changesError = null; renderWorkingChanges(runId);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(runId)}/working-directory/changes`);
    if (request !== view.changesRequest) return;
    view.changes = data;
    const paths = data.repositories.flatMap(repo => repo.changes.map(change => change.path));
    if (view.selectedDiffPath && !paths.includes(view.selectedDiffPath)) { ++view.diffRequest; view.selectedDiffPath = null; view.diffPreview = null; }
  } catch (error) { if (request === view.changesRequest) view.changesError = error.message; }
  finally { if (request === view.changesRequest) { view.changesLoading = false; renderWorkingChanges(runId); } }
  if (view.selectedDiffPath && request === view.changesRequest) await loadWorkingDiff(runId, view.selectedDiffPath);
}

async function loadWorkingDiff(runId, path) {
  const view = workspaceView(runId), request = ++view.diffRequest;
  view.selectedDiffPath = path; view.diffPreview = { loading: true }; renderWorkingChanges(runId);
  try {
    const data = await api(`/api/runs/${encodeURIComponent(runId)}/working-directory/diff?path=${encodeURIComponent(path)}${view.diffFull ? "&full=1" : ""}`);
    if (request === view.diffRequest) view.diffPreview = data;
  } catch (error) { if (request === view.diffRequest) view.diffPreview = { error: error.message }; }
  if (request === view.diffRequest) renderWorkingChanges(runId);
}

const DEFECT_STATUS_TEXT = { open: "待修复", fixing: "修复中", fixed: "待回归验证", verified: "已验证", closed: "已关闭" };
const DEFECT_SEVERITY_TEXT = { critical: "严重", high: "高", medium: "中", low: "低" };

function defectEvidenceMarkup(defect, artifacts) {
  const evidenceIds = Array.isArray(defect.evidenceArtifactIds) ? defect.evidenceArtifactIds : [];
  const evidence = evidenceIds.map((artifactId) => artifacts.find((artifact) => artifact.id === artifactId)).filter((artifact) => artifact && !artifact.deleted && artifact.storagePath);
  if (!evidence.length) return `<span class="defect-evidence-missing">${evidenceIds.length ? "证据快照暂不可读取" : "历史 Defect 未记录可读取证据"}</span>`;
  return `<div class="defect-evidence-actions"><span>已记录文件：${evidence.map(artifact => esc(artifact.name)).join("、")}</span>${[...new Set(evidence.map(artifact => artifact.traceId).filter(traceId => traceId && traceId !== defect.traceId))].map(traceId => `<button class="text-action trace-link" data-open-collaboration-trace="${esc(traceId)}">来源控制台 ↗</button>`).join("")}</div>`;
}

function defectRiskCard(defect, nodes, artifacts) {
  const affected = (Array.isArray(defect.affectedNodeIds) ? defect.affectedNodeIds : []).map((nodeId) => nodes.find((node) => node.id === nodeId)?.title || nodeId).filter(Boolean);
  const reproduction = Array.isArray(defect.reproduction) ? defect.reproduction.filter(Boolean) : [];
  const severity = DEFECT_SEVERITY_TEXT[defect.severity] || defect.severity || "未分级";
  const status = DEFECT_STATUS_TEXT[defect.status] || defect.status || "待确认";
  return `<article class="defect-risk-card ${defect.status === "closed" ? "closed" : ""}">
    <header><span class="defect-severity ${esc(defect.severity || "medium")}">${esc(severity)}优先级</span><span class="defect-status ${esc(defect.status || "open")}">${esc(status)}</span></header>
    <strong>${esc(defect.title || "未命名 Defect")}</strong>
    ${defect.description ? `<p>${esc(defect.description)}</p>` : ""}
    <small>影响职责：${esc(affected.join("、") || "未标注")}</small>
    ${reproduction.length ? `<details class="defect-reproduction"><summary>复现线索 · ${reproduction.length} 条</summary><ol>${reproduction.map((item) => `<li>${esc(item)}</li>`).join("")}</ol></details>` : ""}
    <footer>${defectEvidenceMarkup(defect, artifacts)}${defect.traceId ? `<button class="text-action trace-link" data-open-collaboration-trace="${esc(defect.traceId)}">查看来源 Trace</button>` : ""}</footer>
  </article>`;
}

function qualityRiskMarkup(workspace) {
  const defects = Array.isArray(workspace.defects) ? workspace.defects : [];
  const artifacts = Array.isArray(workspace.artifacts) ? workspace.artifacts : [];
  const nodes = workspace.run?.task?.workflowSnapshot?.nodes || [];
  const unresolved = defects.filter((defect) => defect.status !== "closed");
  const closed = defects.filter((defect) => defect.status === "closed");
  return `<section class="quality-risk-panel" aria-labelledby="quality-risk-heading">
    <header><div><span class="panel-kicker">质量风险</span><h4 id="quality-risk-heading">${unresolved.length ? `${unresolved.length} 个待处理 Defect` : "当前没有未关闭 Defect"}</h4></div><span class="quality-risk-count">${defects.length} 项已记录</span></header>
    <p class="quality-risk-note">${unresolved.length ? "缺陷是员工报告的待处理事项；可通过协作记录追加处理要求。" : "这里显示员工报告的问题，后续安排由项目经理协调。"}</p>
    ${unresolved.length ? `<div class="defect-risk-list">${unresolved.map((defect) => defectRiskCard(defect, nodes, artifacts)).join("")}</div>` : ""}
    ${closed.length ? `<details class="closed-defect-list"><summary>已关闭 ${closed.length} 项历史 Defect</summary><div class="defect-risk-list">${closed.map((defect) => defectRiskCard(defect, nodes, artifacts)).join("")}</div></details>` : ""}
  </section>`;
}

function collaborationMessageMarkup(content, mentions = []) {
  // Same parse/sanitize/fallback path as the communication view; when the
  // vendored Markdown runtime is not loaded yet the honest escaped text shows
  // first and is upgraded in place once loading finishes.
  if (!markdownReady()) { ensureMarkdownVendors(); return memberMentionMarkup(`<p class="collaboration-plain">${esc(content)}</p>`, mentions); }
  return memberMentionMarkup(`<div class="communication-markdown collaboration-markdown">${markdownContent(content)}</div>`, mentions);
}

function renderCollaboration(workspace, agents) {
  const { run } = workspace;
  const dock = $("#collaboration-panel");
  const questions = (state.workspace?.pendingQuestions || []).filter((message) => message.recipient.type === "human");
  const view = workspaceView(run.id);
  if (view.replyToMessageId === undefined || (view.replyToMessageId && !questions.some((item) => item.id === view.replyToMessageId))) view.replyToMessageId = questions[0]?.id || "";
  const records = collaborationRecords(workspace).filter((item) => view.collaborationFilter === "human" ? item.human : true);
  const visibleRecords = records.slice(-(view.collaborationLimit || 30));
  const humanMessageIds = new Set((workspace.messages || []).filter(message => message.sender?.type === "human").map(message => message.id));
  dock.innerHTML = `
    <div class="collaboration-toolbar"><div><strong>团队协作</strong><small>成员之间及你与成员的消息 · ${records.length} 条</small></div><div class="collaboration-filters">${[["all", "全部"], ["human", "涉及人类"]].map(([value, label]) => `<button class="small-button ${view.collaborationFilter === value ? "primary" : ""}" data-collaboration-filter="${value}" aria-pressed="${view.collaborationFilter === value}">${label}</button>`).join("")}<button class="small-button" data-collaboration-latest>↓ 最新</button></div></div>
    ${questions.length ? `<div class="await-banner"><strong>${questions.length} 个问题待你回答</strong>回答后恢复对应成员的协作；也可以选择追加新指令。${run.status === "paused" ? "任务已暂停，回复不会启动执行。" : ""}</div>` : `<p class="human-guide">发送新消息时，请 @ 一位当前任务成员。</p>`}
    <div class="human-message-list">
      ${records.length > visibleRecords.length ? '<button class="small-button" data-collaboration-older>加载更早协作记录</button>' : ""}
      ${records.length ? visibleRecords.map((item) => `<article class="collaboration-row ${humanMessageIds.has(item.id) ? "from-human" : ""} ${item.canReply ? "needs-answer" : ""}" data-tone="${esc(item.tone)}" data-record-status="${esc(item.statusCode)}"><time>${exactTime(item.timestamp)}</time><div><header><span class="collaboration-kind">${esc(item.title)}</span><strong>${esc(item.from)} <span aria-label="发送给">→</span> ${esc(item.to)}</strong><span class="collaboration-status">${esc(item.status)}</span></header><div class="collaboration-content">${item.questionType ? `<small>问题类型：${esc(item.questionType)} · 路由依据：${esc(item.routingReason)}</small>` : ""}${item.reply ? `<details class="collaboration-reference"><summary>回复的问题</summary><p>${esc(item.reply)}</p></details>` : ""}${collaborationMessageMarkup(item.content, agents.map(agent => agent.name))}${item.canReply ? `<button class="small-button primary" data-answer-message="${esc(item.replyId)}">回复此问题</button>` : ""}${item.traceId ? `<button class="text-action trace-link" data-open-collaboration-trace="${esc(item.traceId)}" title="查看角色控制台">控制台 ↗</button>` : ""}</div></div></article>`).join("") : `<div class="human-empty"><strong>暂无协作消息</strong><p>你与成员、成员之间的消息会出现在这里；执行细节请查看角色控制台。</p></div>`}
    </div>
    <form class="instruction-form" id="instruction-form">
        ${questions.length ? `<label for="reply-question">消息用途</label><select id="reply-question" name="replyToMessageId"><option value="">追加新指令（排队）</option>${questions.map((item) => `<option value="${item.id}" ${view.replyToMessageId === item.id ? "selected" : ""}>回复 ${esc(item.sender.name)}：${esc(item.content.slice(0, 70))}</option>`).join("")}</select>` : ""}
        <label for="instruction-text">消息内容</label>
        <div class="mention-wrap">
          <textarea id="instruction-text" name="content" required placeholder="输入回答；新消息请 @ 一位任务成员…"></textarea>
          <div class="mention-list" id="mention-list"></div>
        </div>
        <button class="primary-button compact" type="submit" data-send-instruction ${run.task.archivedAt ? "disabled" : ""}>发送</button>
        <p class="directive-note">${run.task.archivedAt ? "任务已归档，协作记录只读。" : ["completed", "cancelled", "failed", "paused"].includes(run.status) ? "可继续咨询；仅答疑，不恢复业务流程。Enter 发送，Shift / Cmd / Alt + Enter 换行。" : "新指令入队，不打断当前成员。Enter 发送，Shift / Cmd / Alt + Enter 换行。"}</p>
    </form>`;
  $("#instruction-form").addEventListener("submit", sendInstruction);
  $("#reply-question")?.addEventListener("change", (event) => { view.replyToMessageId = event.target.value; });
  $("#instruction-text").value = workspaceView(run.id).draft;
  $("#instruction-text").disabled = Boolean(run.task.archivedAt);
}

/* ---------- 任务空间数据与动作 ---------- */
async function loadWorkspace(runId = state.selectedRunId, { quiet = false } = {}) {
  if (!runId) { renderWorkspace(); return; }
  const request = ++workspaceRequest;
  state.selectedRunId = runId;
  state.workspaceError = null;
  if (state.currentView === "workspace" && state.workspace?.run.id !== runId) renderWorkspace();
  connectEvents(runId);
  try {
    const workspace = await api(`/api/runs/${runId}/workspace?view=summary`);
    if (request !== workspaceRequest || state.selectedRunId !== runId || state.currentView !== "workspace") return;
    state.workspace = workspace;
    const task = state.tasks.find((item) => item.id === workspace.run.taskId);
    if (task) { task.status = workspace.run.task.status; task.archivedAt = workspace.run.task.archivedAt; task.deletionBlockedBy = workspace.run.task.deletionBlockedBy; task.updatedAt = workspace.run.task.updatedAt; }
    const run = state.runs.find((item) => item.id === runId);
    if (run) { run.status = workspace.run.status; run.traceCount = workspace.traces.length; run.artifactCount = workspace.artifacts.length; }
    if (state.currentView === "workspace" && location.pathname !== `/runs/${encodeURIComponent(runId)}`) history.replaceState({}, "", `/runs/${encodeURIComponent(runId)}`);
    render();
  } catch (error) {
    if (request !== workspaceRequest || state.selectedRunId !== runId) return;
    state.workspaceError = error.message;
    if (!state.workspace || state.workspace.run.id !== runId) renderWorkspace();
    if (!quiet) toast(error.message, true);
  }
}
function setLiveIndicator(connected) {
  const indicator = $("#live-indicator");
  indicator.classList.toggle("off", !connected);
  indicator.lastChild.textContent = connected ? "实时同步" : "已断开";
}
function connectEvents(runId) {
  if (state.eventSource?.runId === runId) return;
  state.eventSource?.close();
  clearTimeout(workspaceRefreshTimer); workspaceRefreshTimer = null;
  clearTimeout(consoleRenderTimer); consoleRenderTimer = null;
  for (const [key, page] of consolePages) if (key.startsWith(`${runId}:`)) { page.request++; page.loading = false; page.loaded = false; page.events = []; page.error = null; page.hasMore = false; page.nextBefore = null; }
  const source = new EventSource(`/api/runs/${runId}/events`);
  source.addEventListener("auth-expired", () => { source.close(); location.replace(`/login?next=${encodeURIComponent(location.pathname)}`); });
  source.runId = runId;
  let connected = false;
  source.addEventListener("open", () => {
    if (state.eventSource !== source) return;
    setLiveIndicator(true);
    if (connected) {
      scheduleWorkspaceRefresh(runId);
      for (const [key, page] of consolePages) if (key.startsWith(`${runId}:`)) { page.request++; page.loading = false; page.loaded = false; page.events = []; page.error = null; }
      if (workspaceView(runId).tab === "console" && state.selectedAgentId) loadConsolePage(runId, state.selectedAgentId, { reset: true });
    }
    connected = true;
  });
  source.addEventListener("error", () => setLiveIndicator(false));
  source.addEventListener("run-event", (message) => {
    if (state.eventSource !== source || state.currentView !== "workspace" || state.selectedRunId !== runId) return;
    const event = JSON.parse(message.data);
    const page = consolePages.get(`${runId}:${event.actor?.id}`);
    if (page && (page.loaded || page.loading) && (!page.traceId || page.traceId === event.data?.traceId) && !page.events.some((item) => item.id === event.id)) {
      page.events.push(event);
      // Keep the automatic live window bounded; older events remain available through pagination.
      if (!page.browsingHistory && page.events.length > 200) { page.events = page.events.slice(-200); page.nextBefore = page.events[0].id; page.hasMore = true; }
      if (event.actor?.id === state.selectedAgentId && workspaceView(runId).tab === "console" && !consoleRenderTimer) consoleRenderTimer = setTimeout(() => { consoleRenderTimer = null; renderConsolePage(); }, 100);
    }
    if (event.type !== "runtime.event" || event.data?.subtype === "init") scheduleWorkspaceRefresh(runId);
  });
  state.eventSource = source;
}
function scheduleWorkspaceRefresh(runId) {
  if (workspaceRefreshTimer) return;
  workspaceRefreshTimer = setTimeout(() => {
    workspaceRefreshTimer = null;
    if (state.currentView === "workspace" && state.selectedRunId === runId) loadWorkspace(runId, { quiet: true });
  }, 500);
}
async function runTask(taskId, { taskCreated = false } = {}) {
  try {
    const { run } = await api(`/api/tasks/${taskId}/run`, { method: "POST", body: "{}" });
    state.selectedRunId = run.id;
    state.selectedAgentId = null;
    toast("真实本机 Run 已启动");
    await refresh({ quiet: true });
    setView("workspace");
    await loadWorkspace(run.id);
  } catch (error) {
    if (!taskCreated) { toast(error.message, true); return; }
    // Task creation and Run launch are separate commands. A rejected launch
    // leaves a real backlog Task behind; a lost response might still have
    // started the Run. Re-read the authoritative summary before telling the
    // human which recovery action is safe.
    const refreshed = await refresh({ quiet: true });
    if (!refreshed) {
      toast(`任务已创建，但启动响应未确认：${error.message}。无法重新读取任务中心，请恢复连接后刷新再确认。`, true);
      return;
    }
    const task = state.tasks.find((item) => item.id === taskId);
    const run = runOfTask(taskId);
    if (task?.status === "backlog" && !run) {
      toast(`任务已创建，但未能启动 Run：${error.message}。任务已保留在任务中心，可再次启动。`, true);
      return;
    }
    toast(`任务已创建，但启动响应未确认：${error.message}。已重新读取任务中心，请以当前状态继续。`, true);
  }
}
async function sendInstruction(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const content = String(form.get("content") || "").trim();
  if (!content) return;
  /* 新消息须明确 @ 一位成员；精确回复由问题 ID 决定接收人。 */
  const agents = state.workspace ? workspaceAgents(state.workspace, state.agents) : [];
  const replyToMessageId = form.get("replyToMessageId") || null;
  const targets = agents.filter((agent) => new RegExp(`@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\s|[，,。.!！?？:：;；])`).test(content));
  if (!replyToMessageId && targets.length !== 1) { toast("新消息必须 @ 一位当前任务成员", true); return; }
  const target = targets[0];
  const runId = state.selectedRunId;
  const view = workspaceView(runId);
  if (view.sending || state.workspace?.run.task.archivedAt) return;
  const draft = view.draft;
  view.sending = true;
  try {
    const result = await api(`/api/runs/${runId}/messages`, {
      method: "POST",
      body: JSON.stringify({ recipientAgentId: replyToMessageId ? null : target.id, replyToMessageId, content }),
    });
    toast(result.interactionOnly ? "问题已发送，仅答疑，不恢复业务流程" : result.resumed ? "澄清已发送，对应协作将继续" : "消息已入队，不打断正在执行的成员");
    if (workspaceView(runId).draft === draft) workspaceView(runId).draft = "";
    if (state.selectedRunId === runId) await loadWorkspace(runId);
  } catch (error) { toast(error.message, true); }
  finally { view.sending = false; }
}
function openCompletionModal(runId) {
  const workspace = state.workspace?.run?.id === runId ? state.workspace : null;
  const acceptance = acceptanceReview(workspace || {});
  if (!acceptance?.verified) return toast("当前任务尚未提交人类验收。", true);
  const findings = acceptance.findings.map((finding) => `<li>${esc(finding)}</li>`).join("");
  const criteria = acceptanceCriteriaMarkup(acceptance);
  openModal(`
    <h2>确认任务完成</h2>
    <p class="modal-intro">你正在代表人类确认「${esc(workspace.run.task.title)}」的交付。确认后 Run 会变为已完成；Trace、Artifact、消息和审计记录会继续保留。</p>
    <section class="completion-review" aria-label="待确认的经理交接">
      <strong>经理交接说明</strong><ul>${findings}</ul>
      <strong class="completion-review-criteria-title">任务验收标准</strong>${criteria}
      <small>${acceptance.artifactCount} 项已接纳交付快照 · ${acceptance.criteria.length} 条原任务要求</small>
    </section>
    <label class="ack-row"><input type="checkbox" id="ack-completion" /> 我已阅读复核结论，并已核对需要的交付快照。</label>
    <div class="form-actions">
      <button type="button" class="ghost-button" data-close-modal>返回核验</button>
      <button type="button" class="primary-button" id="confirm-completion" disabled>确认完成</button>
    </div>`);
  const button = $("#confirm-completion");
  $("#ack-completion").addEventListener("change", (event) => { button.disabled = !event.target.checked; });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api(`/api/runs/${runId}/confirm-completion`, { method: "POST", body: "{}" });
      closeModal();
      await refresh({ quiet: true });
      await loadWorkspace(runId);
      toast("已由你确认任务完成");
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });
}
async function retryScheduledWorkspace(runId) {
  try {
    const result = await api(`/api/runs/${runId}/retry-now`, { method: "POST", body: "{}" });
    toast(`已请求立即重试 ${result.dispatchIds.length} 项调用；失败 Trace 已保留。`);
    if (state.selectedRunId === runId) await loadWorkspace(runId);
  } catch (error) { toast(error.message, true); }
}
async function retryFailedWorkspace(runId, workflowNodeId) {
  try {
    await api(`/api/runs/${runId}/retry-failed-node`, { method: "POST", body: JSON.stringify({ workflowNodeId }) });
    toast("已请求项目经理重新评估失败职责；历史证据已保留。");
    await refresh({ quiet: true });
    if (state.selectedRunId === runId) await loadWorkspace(runId);
  } catch (error) { toast(error.message, true); }
}
async function retryFailedOrchestration(runId) {
  try {
    await api(`/api/runs/${runId}/retry-orchestration`, { method: "POST", body: "{}" });
    toast("已请求重新准备运行环境，并由项目经理重新评估。");
    await refresh({ quiet: true });
    if (state.selectedRunId === runId) await loadWorkspace(runId);
  } catch (error) { toast(error.message, true); }
}
function openDeleteTaskModal(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const runs = state.runs.filter((item) => item.taskId === taskId || item.task?.id === taskId);
  if (task.deletionBlockedBy) {
    toast(task.deletionBlockedBy === "active_inquiries" ? "答疑进行中，请等待答复完成后重试删除。" : "存在活跃 Run，不能删除 Task。", true);
    return;
  }
  const artifactCount = runs.reduce((total, item) => total + (item.artifactCount || 0), 0);
  openModal(`
    <h2>删除任务</h2>
    <p class="modal-intro">将永久删除「${esc(task.title)}」及其 ${runs.length} 个 Run${artifactCount ? `、${artifactCount} 项已接纳交付快照` : ""}。这只适用于没有活跃 Run 或未结束答疑的任务。</p>
    <ul class="confirm-list">
      <li>Task、Run、Trace、Artifact、消息、Decision、Defect 和 Event 都会被移除</li>
      <li>同一 Run 的本地文件快照会被删除，无法恢复</li>
      <li>若本机文件系统暂时无法清理，快照会先被服务端隔离，Console 会明确提示后续清理</li>
      <li>不会取消或终止正在执行的本机 Agent；活跃 Run 或答疑进行中时根本不能删除</li>
    </ul>
    <label class="ack-row"><input id="delete-task-acknowledged" type="checkbox" />我理解这会永久删除本地交付与审计记录</label>
    <div class="form-actions"><button type="button" class="ghost-button" data-close-modal>取消</button><button type="button" class="danger-button" id="confirm-delete-task" disabled>永久删除任务</button></div>`);
  const acknowledgement = $("#delete-task-acknowledged"), confirmButton = $("#confirm-delete-task");
  acknowledgement.addEventListener("change", () => { confirmButton.disabled = !acknowledgement.checked; });
  confirmButton.addEventListener("click", async () => {
    try {
      const result = await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      closeModal();
      if (runs.some((item) => item.id === state.selectedRunId)) {
        state.selectedRunId = null;
        state.selectedAgentId = null;
        state.workspace = null;
        setView("tasks", { replace: true, taskArchiveView: false });
      }
      toast(result.runFileCleanup === "pending" ? "任务记录已删除；本地快照已隔离，服务将在下次启动时继续清理。" : "任务及其本地运行记录已删除。");
      await refresh({ quiet: true });
    } catch (error) { toast(error.message, true); }
  });
}
function openTerminateModal(runId) {
  const run = state.workspace?.run?.id === runId ? state.workspace.run : state.runs.find((item) => item.id === runId);
  const title = run?.task?.title || runId;
  openModal(`
    <h2>终止 Run</h2>
    <p class="modal-intro">「${esc(title)}」正在被终止。这是一个不可恢复的破坏性操作：</p>
    <ul class="confirm-list">
      <li>立即终止正在运行的本机 Agent 进程</li>
      <li>将本次 Run 标记为已终止，并取消尚未完成的协作投递</li>
      <li>已接收的 Trace、Artifact、消息与终止审计记录会保留，可继续查看</li>
    </ul>
    <label class="ack-row"><input type="checkbox" id="ack-terminate" /> 我理解此操作不可恢复</label>
    <div class="form-actions">
      <button type="button" class="ghost-button" data-close-modal>再想想</button>
      <button type="button" class="danger-button" id="confirm-terminate" disabled style="opacity:.5">确认终止</button>
    </div>`);
  $("#ack-terminate").addEventListener("change", (event) => {
    const button = $("#confirm-terminate");
    button.disabled = !event.target.checked;
    button.style.opacity = event.target.checked ? "1" : ".5";
  });
  $("#confirm-terminate").addEventListener("click", async () => {
    try {
      await api(`/api/runs/${runId}/terminate`, { method: "POST", body: JSON.stringify({ reason: "用户在任务空间终止" }) });
      closeModal();
      toast("Run 已终止；协作记录保留了终止事实，已接收的交付仍可查看。");
      await refresh({ quiet: true });
      await loadWorkspace(runId);
    } catch (error) { toast(error.message, true); }
  });
}

async function pauseWorkspaceRun(runId) {
  try {
    await api(`/api/runs/${runId}/pause`, { method: "POST", body: JSON.stringify({ reason: "用户在任务空间暂停" }) });
    toast("Run 已暂停；所有本机角色执行已停止，未完成节点可继续。");
    await refresh({ quiet: true });
    await loadWorkspace(runId);
  } catch (error) { toast(error.message, true); }
}

async function resumeWorkspaceRun(runId) {
  try {
    await api(`/api/runs/${runId}/resume`, { method: "POST" });
    toast("Run 已继续；项目经理正在依据当前状态重新评估。");
    await refresh({ quiet: true });
    await loadWorkspace(runId);
  } catch (error) { toast(error.message, true); }
}

/* ---------- 创建弹窗 ---------- */
const pathList = (value) => String(value || "").split("\n").map((item) => item.trim()).filter(Boolean);

function taskAssignmentMarkup(form) {
  const template = state.workflowTemplates.find((item) => item.id === form.workflowTemplateId.value);
  if (!template) return "";
  return `<div class="assignment-head"><strong>由项目经理选择执行成员</strong><small>创建任务时无需指定每个节点的负责人。项目经理将在每次派发时根据人员需求、团队成员提示词与能力选择。</small></div><div class="assignment-list">${template.nodes.map((node) => `<div class="assignment-row"><span><strong>${esc(node.title)}</strong><small>${esc(node.staffingGuidance || node.ownerRole || "根据交付定义选择")}</small></span></div>`).join("")}</div>`;
}

function syncTaskAssignments(form) { const host = $("#node-assignment-panel"); if (host) host.innerHTML = taskAssignmentMarkup(form); }

function newTaskModal() {
  if (!state.teams.length) { toast("还没有可用团队：请先创建业务数字员工和团队。", true); return; }
  if (!state.workflowTemplates.length) { toast("还没有工作流：请先创建工作流。", true); return; }
  openModal(`
    <h2>新建任务</h2>
    <p class="modal-intro">提交后立即启动真实本机任务，由所选团队协作；最终完成仍需你验收确认。</p>
    <form id="task-form" novalidate>
    <section class="settings-note" aria-label="本机执行与资料边界" data-task-execution-boundary>
      <strong>启动前请确认资料可用于本机 AI 执行</strong>
      <p>CLI 从任务目录启动，以本机用户权限在 bypass 模式执行；工作目录不是沙箱，工具可能访问目录外文件和网络。</p>
      <p>任务资料可能发送至配置的模型服务。数字员工以当前本机用户权限执行，平台不限制其文件、网络或远程交付操作；请只使用可信员工、插件与 MCP。</p>
    </section>
      <div class="form-field full"><label>任务标题 <b>*</b></label>
        <input name="title" placeholder="例如：订单结算页重构" /><div class="field-error"></div></div>
      <div class="form-field full"><label>目标描述 <b>*</b></label>
        <textarea name="objective" placeholder="要达成什么结果？范围、背景和关键约束是什么？"></textarea><div class="field-error"></div></div>
      <div class="form-field full"><label>验收标准（每行一条）</label>
        <textarea name="acceptanceCriteria" placeholder="例如：\n登录页通过键盘可完整操作\n新增与修改的路径有可重复测试证据"></textarea><p class="field-hint">会随 Task 冻结，供对应业务与测试节点执行，并供你最终验收。项目经理依据成员交接推进协作。</p><div class="field-error"></div></div>
      <div class="form-field full"><label>系统工作根目录</label><div class="field-hint">${esc(state.settings?.workspaceRoot || "/tmp/AgentForge")}/任务ID/RunID · 系统自动创建独立目录，任务不可指定路径。</div></div>
      <div class="form-grid">
        <div class="form-field"><label>流程模板 <b>*</b></label>
          <select name="workflowTemplateId">${state.workflowTemplates.map((template) => `<option value="${template.id}">${esc(template.name)}</option>`).join("")}</select></div>
        <div class="form-field"><label>业务团队 <b>*</b></label>
          <select name="teamId">${state.teams.map((team) => `<option value="${team.id}">${esc(team.name)}（${team.members.length} 人）</option>`).join("")}</select></div>
        <div class="form-field"><label>团队项目经理</label>
          <div class="field-hint">项目经理会使用“数字员工”页面中配置的 Runtime，并在本次 Task 创建快照。</div></div>
      </div>
      <div class="form-field full"><div id="node-assignment-panel"></div><div class="field-error"></div></div>
      <div class="form-actions">
        <button type="button" class="ghost-button" data-close-modal>取消</button>
        <button type="submit" class="primary-button">创建并开始</button>
      </div>
    </form>`);
  const form = $("#task-form");
  syncTaskAssignments(form);
  form.addEventListener("change", (event) => {
    if (["workflowTemplateId", "teamId"].includes(event.target.name)) syncTaskAssignments(form, { reset: event.target.name === "workflowTemplateId" });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearInvalid(form);
    let valid = true;
    if (!form.title.value.trim()) { setInvalid(form.title, "请填写任务标题。"); valid = false; }
    if (!form.objective.value.trim()) { setInvalid(form.objective, "请描述任务目标、范围或关键约束。"); valid = false; }
    const acceptanceCriteria = form.elements.acceptanceCriteria.value.split(/\r?\n/).map((criterion) => criterion.trim()).filter(Boolean);
    if (acceptanceCriteria.length > 20) { setInvalid(form.elements.acceptanceCriteria, "验收标准最多 20 条。"); valid = false; }
    if (acceptanceCriteria.some((criterion) => criterion.length > 500)) { setInvalid(form.elements.acceptanceCriteria, "每条验收标准不能超过 500 字符。"); valid = false; }

    if (!valid) return;
    try {
      const data = new FormData(form);
      const input = Object.fromEntries(data);
      input.acceptanceCriteria = acceptanceCriteria;
      const template = state.workflowTemplates.find((item) => item.id === input.workflowTemplateId);
      const created = await api("/api/tasks", { method: "POST", body: JSON.stringify(input) });
      closeModal();
      await runTask(created.task.id, { taskCreated: true });
    } catch (error) { toast(error.message, true); }
  });
}

function workflowNodeRow(node, index, allNodes) {
  const candidates = allNodes.filter((candidate) => candidate.id !== node.id);
  return `<details class="workflow-edit-node" data-workflow-node ${index === 0 ? "open" : ""}>
    <summary class="workflow-edit-node-head"><strong>${String(index + 1).padStart(2, "0")} · ${esc(node.title || "新节点")}</strong><button type="button" class="icon-text-button" data-remove-workflow-node title="移除此节点">移除</button></summary>
    <input type="hidden" name="nodeId" value="${esc(node.id)}" />
    <div class="form-grid compact-grid"><div class="form-field"><label>节点标题 <b>*</b></label><input name="nodeTitle" value="${esc(node.title || "")}" placeholder="例如：功能实现" /></div>
    <div class="form-field"><label>人员需求提示 <b>*</b></label><textarea name="nodeStaffingGuidance" placeholder="例如：熟悉测试方案设计、能复现问题并提供证据；由项目经理判断具体人选。">${esc(node.staffingGuidance || "")}</textarea></div></div>
    <div class="form-field"><label>交付定义 <b>*</b></label><textarea name="nodeDeliverable" placeholder="用自然语言说明此节点要交付什么、如何被下游使用。">${esc(node.deliverable || "")}</textarea><div class="field-hint">供负责该节点的员工理解目标和交接要求。</div></div>
    <div class="form-grid compact-grid"><div class="form-field"><label>建议交付位置（每行一条）</label><textarea name="nodeArtifactPaths" placeholder="artifacts/media/\nreports/">${esc((node.artifactPaths || []).join("\n"))}</textarea><div class="field-hint">工作目录内的相对路径，目录由工作流约定；可留空，不限定 docs，也不是文件操作或 Artifact 接纳白名单。</div></div>
    <div class="form-field"><label>代码仓库</label><p class="field-hint">从节点分配的研发数字员工绑定配置派生，不由工作流指定。</p></div></div>
    <div class="form-field"><label>依赖节点（可多选）</label><select name="nodeDependencies" multiple size="${Math.min(Math.max(candidates.length, 1), 3)}">${candidates.map((candidate) => `<option value="${esc(candidate.id)}" ${(node.dependsOn || []).includes(candidate.id) ? "selected" : ""}>${esc(candidate.id)} · ${esc(candidate.title || `节点 ${candidate.id}`)}</option>`).join("")}</select><div class="field-hint">供项目经理安排交接顺序时参考。</div></div>
  </details>`;
}

function workflowFormNodes(form) {
  return [...form.querySelectorAll("[data-workflow-node]")].map((row, index) => ({
    id: row.querySelector("[name=nodeId]").value,
    title: row.querySelector("[name=nodeTitle]").value.trim(),
    staffingGuidance: row.querySelector("[name=nodeStaffingGuidance]").value.trim(),
    deliverable: row.querySelector("[name=nodeDeliverable]").value.trim(),
    artifactPaths: pathList(row.querySelector("[name=nodeArtifactPaths]").value),
    dependsOn: [...row.querySelector("[name=nodeDependencies]").selectedOptions].map((option) => option.value),
    handoffFrom: [...row.querySelector("[name=nodeDependencies]").selectedOptions].map((option) => option.value),
    index
  }));
}

function replaceWorkflowNodes(form, nodes) {
  $("#workflow-edit-nodes").innerHTML = nodes.map((node, index) => workflowNodeRow(node, index, nodes)).join("");
  form.querySelectorAll("[data-remove-workflow-node]").forEach((button) => button.addEventListener("click", () => {
    const remaining = workflowFormNodes(form).filter((node, index) => index !== [...form.querySelectorAll("[data-remove-workflow-node]")].indexOf(button));
    if (!remaining.length) { toast("工作流至少需要一个节点。", true); return; }
    replaceWorkflowNodes(form, remaining);
  }));
}

function workflowModal(template = null) {
  const initialNodes = template?.nodes?.length ? template.nodes : [
    { id: "requirements", title: "需求与验收标准", staffingGuidance: "熟悉需求澄清与验收标准编写，能将目标整理成可验证的交付要求。", deliverable: "交付需求、边界和验收标准。", artifactPaths: ["docs/requirements/"], dependsOn: [] },
    { id: "development", title: "功能开发", staffingGuidance: "熟悉代码仓库与实现方案，能完成开发和必要的测试。", deliverable: "在指定 Git 仓库实现功能与测试。", artifactPaths: ["docs/development/"], dependsOn: ["requirements"] },
    { id: "testing", title: "质量验证", staffingGuidance: "能制定测试方案、复现问题并提交可验证的测试证据；不限定成员的角色名称。", deliverable: "验证功能并输出测试报告。", artifactPaths: ["docs/testing/"], dependsOn: ["development"] }
  ];
  openModal(`<h2>${template ? "编辑工作流" : "新建工作流"}</h2>
    <p class="modal-intro">工作流定义节点、依赖和人员需求。运行时由项目经理依据成员交接决定下一步。</p>
    <form id="workflow-form" novalidate><div class="form-field full"><label>工作流名称 <b>*</b></label><input name="name" value="${esc(template?.name || "")}" placeholder="例如：前端交互功能交付" /><div class="field-error"></div></div>
    <div class="form-field full"><label>说明</label><textarea name="description" placeholder="说明适合处理的任务类型与交付目标">${esc(template?.description || "")}</textarea></div>
    <div class="workflow-edit-head"><strong>工作流节点</strong><button type="button" class="small-button" id="add-workflow-node">＋ 添加节点</button></div><div id="workflow-edit-nodes"></div>
    <div class="form-actions"><button type="button" class="ghost-button" data-close-modal>取消</button><button type="submit" class="primary-button">${template ? "保存工作流" : "创建工作流"}</button></div></form>`);
  const form = $("#workflow-form");
  form.closest(".modal").classList.add("workflow-editor-modal");
  replaceWorkflowNodes(form, initialNodes);
  $("#add-workflow-node").addEventListener("click", () => {
    const current = workflowFormNodes(form);
    const next = current.length + 1;
    replaceWorkflowNodes(form, [...current, { id: `node_${next}`, title: "", staffingGuidance: "", deliverable: "", artifactPaths: [], dependsOn: current.length ? [current[current.length - 1].id] : [] }]);
    const added = form.querySelector("[data-workflow-node]:last-child"); added.open = true; added.scrollIntoView({ block: "nearest" });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault(); clearInvalid(form);
    const nodes = workflowFormNodes(form);
    if (!form.name.value.trim()) { setInvalid(form.name, "请填写工作流名称。"); return; }
    if (nodes.some((node) => !node.title || !node.staffingGuidance || !node.deliverable)) { toast("请为每个工作流节点填写标题、人员需求提示和交付定义。", true); return; }
    const payload = { name: form.name.value.trim(), description: form.description.value.trim(), nodes: nodes.map(({ index, ...node }) => node) };
    try {
      if (template) await api(`/api/workflow-templates/${template.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/workflow-templates", { method: "POST", body: JSON.stringify(payload) });
      closeModal(); toast(template ? "工作流已更新。" : "工作流已创建，可用于新任务。"); await refresh();
    } catch (error) { toast(error.message, true); }
  });
}

async function agentModal(existing = null) {
  let profiles;
  try { profiles = (await api('/api/settings/runtime-profiles')).profiles; }
  catch (error) { toast(`Runtime 配置读取失败：${error.message}`, true); return; }
  if (!profiles.length) { toast("还没有 Runtime 配置，请先在设置 → Runtime 添加连接。", true); return; }
  const runtime = existing?.runtime || {};

  openModal(`
    <h2>${existing ? "编辑数字员工" : "创建数字员工"}</h2>
    <p class="modal-intro">数字员工可加入团队并承担工作流节点；修改仅影响后续新任务和沟通。</p>
    <form id="agent-form" novalidate>
      <div class="employee-identity-row"><div class="form-field"><label>名称 <b>*</b></label><input name="name" value="${esc(existing?.name || "")}" placeholder="例如：周航" /><div class="field-error"></div></div><fieldset class="employee-status-choice"><legend>状态</legend><label><input type="radio" name="status" value="active" ${!existing || existing.status==='active'?'checked':''}>可用</label><label><input type="radio" name="status" value="inactive" ${existing?.status==='inactive'?'checked':''}>停用</label></fieldset></div>
      <div class="employee-properties-row"><div class="form-field"><label>员工类型</label><select name="kind"><option value="business">其他</option><option value="manager" ${existing?.kind === "manager" ? "selected" : ""}>项目经理</option><option value="developer" ${existing?.kind === "developer" ? "selected" : ""}>研发工程师</option></select></div><div class="form-field"><label for="employee-runtime-profile">Runtime 配置 <b>*</b></label><select id="employee-runtime-profile" name="runtimeProfileId">${profiles.map(item => `<option value="${esc(item.id)}" ${item.id === runtime.profileId ? 'selected' : ''}>${esc(item.name)} · ${item.provider === 'codex' ? 'Codex' : 'Claude Code'}</option>`).join('')}</select></div></div>
      <p class="field-hint">Runtime 在设置中管理和测试；停用不改写冻结任务与沟通。插件和 MCP 按员工独立选择。</p>
      <div id="employee-repository-fields" ${existing?.kind === "developer" ? "" : "hidden"}>
        <div class="form-field full"><label for="employee-repository-url">绑定 Git 仓库 <b>*</b></label><input id="employee-repository-url" name="repositoryUrl" value="${esc(existing?.repository?.url || "")}" placeholder="https://github.com/owner/repository.git" /><div class="field-error"></div></div>
        <div class="form-field full"><label for="employee-repository-ref">基线分支或提交</label><input id="employee-repository-ref" name="repositoryRef" value="${esc(existing?.repository?.ref || "main")}" /><p class="field-hint">一个研发员工绑定一个默认仓库。新任务启动前检出，员工从此仓库目录执行；仓库绑定不限制其他操作。</p></div>
      </div>
      <div class="form-field full"><label>系统提示词（职责与协作边界）</label><textarea name="systemPrompt">${esc(existing?.systemPrompt || "")}</textarea></div>
      <div class="form-field full"><label>能力与简介</label><textarea name="description" placeholder="擅长什么、能解决哪些问题、何时应咨询这位员工">${esc([existing?.description, ...(existing?.capabilities || []).filter((item) => !existing?.description?.includes(item))].filter(Boolean).join("\n"))}</textarea><p class="field-hint">统一描述业务能力；系统提示词保留具体工作规则和协作边界。</p></div>
      <div class="form-field full" id="employee-market-selection"></div>
      <div class="form-actions">
        <button type="button" class="ghost-button" data-close-modal>取消</button>
        <button type="submit" class="primary-button">${existing ? "保存修改" : "创建数字员工"}</button>
      </div>
    </form>`);
  const form = $("#agent-form");
  form.closest(".modal").classList.add("employee-config-modal");
  form.querySelectorAll(".form-field").forEach((field, index) => {
    const input = field.querySelector("input,textarea,select"), label = field.querySelector("label");
    if (input && label && !label.htmlFor) { input.id ||= `employee-field-${index}`; label.htmlFor = input.id; }
  });
  form.kind.addEventListener("change", () => { $("#employee-repository-fields").hidden = form.kind.value !== "developer"; });
  let provider = profiles.find(item => item.id === form.elements.runtimeProfileId.value).provider;
  const selection = marketplaceUI.select($("#employee-market-selection"), runtime, provider);
  form.elements.runtimeProfileId.addEventListener("change", () => {
    provider = profiles.find(item => item.id === form.elements.runtimeProfileId.value).provider;
    selection.provider(provider);
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearInvalid(form);
    let extensionSelection;
    try { extensionSelection = selection.value(); } catch (error) { toast(error.message, true); return; }
    let valid = true;
    if (!form.name.value.trim()) { setInvalid(form.name, "请填写名称。"); valid = false; }

    if (form.kind.value === "developer" && !form.repositoryUrl.value.trim()) { setInvalid(form.repositoryUrl, "请填写此研发员工的 Git 仓库地址。"); valid = false; }

    if (!valid) return;
    const data = new FormData(form);
    const input = Object.fromEntries(data);
    input.repository = input.kind === "developer" ? { url: data.get("repositoryUrl"), ref: data.get("repositoryRef") } : null;
    delete input.repositoryUrl; delete input.repositoryRef;
    input.capabilities = [];
    input.runtime = {
      profileId: data.get("runtimeProfileId"),
      extensionSelection
    };
    delete input.runtimeProfileId;
    delete input.provider;
    delete input.executable;
    try {
      await api(existing ? `/api/agents/${existing.id}` : "/api/agents", { method: existing ? "PUT" : "POST", body: JSON.stringify(input) });
      closeModal();
      toast(`数字员工「${input.name}」${existing ? "已更新" : "已创建"}并绑定 ${provider === "codex" ? "Codex" : "Claude Code"} Runtime。`);
      await refresh();
    } catch (error) { toast(error.message, true); }
  });
}

const newAgentModal = () => agentModal();

function configurationDeletionModal(kind, id) {
  const employee = kind === "agent", item = (employee ? state.agents : state.teams).find(item => item.id === id);
  if (!item) return toast("配置不存在，请刷新列表。", true);
  const label = employee ? "数字员工" : "团队";
  openModal(`<h2>删除${label}</h2><p class="modal-intro">确认删除「${esc(item.name)}」？此操作不可恢复。</p><p class="field-hint">仍被团队、任务或沟通历史引用时会拒绝删除；不会删除外部工作文件、Runtime 凭据或改写历史。</p><p data-delete-error role="alert"></p><div class="form-actions"><button class="ghost-button" data-close-modal>取消</button><button class="small-button danger" data-confirm-configuration-delete>删除${label}</button></div>`);
  const button = $("[data-confirm-configuration-delete]"), message = $("[data-delete-error]");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api(`/api/${employee ? "agents" : "teams"}/${encodeURIComponent(id)}`, { method: "DELETE" }); if (button.isConnected) closeModal(); toast(`${label}已删除。`); await refresh(); }
    catch (error) { if (button.isConnected) { message.textContent = error.message; button.disabled = false; } else toast(error.message, true); }
  });
}

function employeeSearchResults(agents, query, selectedIds, limit = 20) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  return agents.filter(agent => agent.status === "active" && !selectedIds.has(agent.id) &&
    [agent.name, agent.description, ...(agent.capabilities || [])].join(" ").toLocaleLowerCase().includes(term)).slice(0, limit);
}

function mountEmployeePicker(host, { agents, selectedIds, name, inputId, multiple }) {
  const selected = new Set(selectedIds);
  host.classList.add("employee-picker");
  host.innerHTML = `<div class="employee-search"><input id="${inputId}" type="search" autocomplete="off" placeholder="搜索员工姓名或能力…" aria-controls="${inputId}-results" /><div class="employee-search-results" id="${inputId}-results" hidden></div><small class="field-hint" data-search-status role="status">输入关键词搜索，每次最多显示 20 位。</small></div><div class="selected-employees" data-selected-employees></div>`;
  const input = host.querySelector("input"), results = host.querySelector(".employee-search-results"), picked = host.querySelector("[data-selected-employees]");
  const renderSelected = () => {
    const items = agents.filter(agent => selected.has(agent.id));
    picked.innerHTML = `<div class="employee-selection-count">${multiple ? `已选 ${items.length} 位员工` : "当前项目经理"}</div>` + (items.length ? items.map(agent => `<div class="selected-employee"><input type="hidden" name="${name}" value="${esc(agent.id)}" /><span class="check-avatar ${roleColor(agent)}">${esc(initialsOf(agent))}</span><div class="employee-picker-copy"><strong>${esc(agent.name)}${agent.status === "active" ? "" : "（已停用）"}</strong><small>${esc(agent.description || "未填写简介")}</small></div><button type="button" class="text-action" data-remove-employee="${esc(agent.id)}" aria-label="移除${esc(agent.name)}">移除</button></div>`).join("") : '<p class="field-hint">尚未选择员工，请在上方搜索添加。</p>');
  };
  const search = () => {
    const matches = employeeSearchResults(agents, input.value, selected);
    results.hidden = !input.value.trim();
    results.innerHTML = matches.length ? matches.map(agent => `<button type="button" data-pick-employee="${esc(agent.id)}"><span class="check-avatar ${roleColor(agent)}">${esc(initialsOf(agent))}</span><span class="employee-picker-copy"><strong>${esc(agent.name)}</strong><small>${esc(agent.description || "未填写简介")}</small></span><span>${multiple ? "添加" : "选择"}</span></button>`).join("") : '<p class="field-hint">未找到可添加的员工，试试其他关键词。</p>';
    host.querySelector("[data-search-status]").textContent = input.value.trim() ? `显示 ${matches.length} 位候选员工，最多 20 位；可继续输入缩小范围。` : "输入关键词搜索，每次最多显示 20 位。";
  };
  input.addEventListener("input", search);
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector("button")?.focus(); }
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") { event.stopPropagation(); input.value = ""; search(); }
  });
  results.addEventListener("keydown", event => {
    const buttons = [...results.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
    if (event.key === "Escape") { event.stopPropagation(); input.focus(); input.value = ""; search(); }
  });
  host.addEventListener("click", event => {
    const add = event.target.closest("[data-pick-employee]"), remove = event.target.closest("[data-remove-employee]");
    if (add) { if (!multiple) selected.clear(); selected.add(add.dataset.pickEmployee); input.value = ""; }
    else if (remove) selected.delete(remove.dataset.removeEmployee);
    else return;
    renderSelected(); search(); input.focus(); clearInvalidField(input);
  });
  renderSelected();
}

function teamModal(existing = null) {
  const managers = state.agents.filter(agent => agent.kind === "manager" && agent.status === "active");
  if (!managers.length) { toast("还没有可用项目经理，请先在数字员工中创建或启用一位项目经理。", true); return; }
  const selectedManagerId = existing ? existing.managerAgentId : managers[0].id;
  const managerOptions = state.agents.filter(agent => agent.kind === "manager" && (agent.status === "active" || agent.id === selectedManagerId));
  const memberOptions = state.agents.filter(agent => agent.kind !== "manager" && (agent.status === "active" || existing?.memberAgentIds.includes(agent.id)));
  openModal(`
    <h2>${existing ? "编辑团队" : "创建团队"}</h2>
    <p class="modal-intro">团队包含业务成员、你选择的项目经理和本机用户。项目经理负责人员协调和工作流收束，不判断业务结果。</p>
    <form id="team-form" novalidate>
      <div class="form-field full"><label>团队名称 <b>*</b></label>
        <input name="name" value="${esc(existing?.name || "")}" placeholder="例如：产品交付组" /><div class="field-error"></div></div>
      <div class="form-field full"><label>团队使命</label>
        <textarea name="mission" placeholder="这个团队负责什么类型的交付？（帮助后续任务分派）">${esc(existing?.mission || "")}</textarea></div>
      <div class="form-field full"><label for="team-manager-search">团队项目经理</label><div id="team-manager-picker"></div><div class="field-error"></div></div>
      <div class="form-field full"><label for="team-members-search">业务执行成员 <b>*</b>（至少 1 名）</label><div id="team-member-picker"></div><div class="field-error"></div></div>
      <div class="form-actions">
        <button type="button" class="ghost-button" data-close-modal>取消</button>
        <button type="submit" class="primary-button">${existing ? "保存修改" : "创建团队"}</button>
      </div>
    </form>`);
  const form = $("#team-form");
  form.closest(".modal").classList.add("team-config-modal");
  mountEmployeePicker($("#team-manager-picker"), { agents: managerOptions, selectedIds: selectedManagerId ? [selectedManagerId] : [], name: "managerAgentId", inputId: "team-manager-search", multiple: false });
  mountEmployeePicker($("#team-member-picker"), { agents: memberOptions, selectedIds: existing?.memberAgentIds || [], name: "memberAgentIds", inputId: "team-members-search", multiple: true });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearInvalid(form);
    const data = new FormData(form);
    const memberAgentIds = data.getAll("memberAgentIds");
    let valid = true;
    if (!form.name.value.trim()) { setInvalid(form.name, "请填写团队名称。"); valid = false; }
    if (!managers.some(agent => agent.id === data.get("managerAgentId"))) { setInvalid($("#team-manager-search"), "请选择一位可用的项目经理。"); valid = false; }
    if (!memberAgentIds.some(id => state.agents.some(agent => agent.id === id && agent.status === "active" && agent.kind !== "manager"))) { setInvalid($("#team-members-search"), "至少选择一名可用业务数字员工。"); valid = false; }
    if (!valid) return;
    try {
      await api(existing ? `/api/teams/${existing.id}` : "/api/teams", { method: existing ? "PUT" : "POST", body: JSON.stringify({ name: data.get("name"), mission: data.get("mission"), managerAgentId: data.get("managerAgentId"), memberAgentIds }) });
      closeModal();
      toast(`团队「${data.get("name")}」${existing ? "已更新" : "已创建"}。`);
      await refresh();
    } catch (error) { toast(error.message, true); }
  });
}

const newTeamModal = () => teamModal();

/* ---------- 全局交互 ---------- */
document.addEventListener("toggle", event => {
  const folder=event.target;
  if(folder.isConnected && folder.hasAttribute?.('data-directory-path')){
    const path=folder.dataset.directoryPath,view=workspaceView();view.directoryOpen[path]=folder.open;
    if(folder.open && !view.directoryPages?.[path])void loadWorkingDirectory(state.selectedRunId,{path});
  }
  const stream = event.target.closest?.('#trace-stream, [data-communication-stream]');
  if (stream) observeConsoleContent(stream);
}, true);

function render() {
  renderShell();
  const views = { overview: renderOverview, tasks: renderTasks, teams: renderTeams, workflows: renderWorkflows, agents: renderAgents, manual: renderManual, workspace: renderWorkspace };
  if (state.currentView === "communication") communicationUI.mount($("#communication-root"), state, state.selectedChatId);
  if (state.currentView === "settings") settingsUI.mount($("#settings-root"), state.settingsPage);
  if (state.currentView === "mcp-marketplace") mcpMarketplaceUI.mount($("#mcp-marketplace-root"));
  if (state.currentView === "marketplace") marketplaceUI.mount($("#marketplace-root"));
  views[state.currentView]?.();
}

$("#agents-search").addEventListener("input", () => {
  state.listPages.agents = 1;
  renderAgents();
});
for (const [key, render] of [["teams", renderTeams], ["workflows", renderWorkflows]]) $("#" + key + "-search").addEventListener("input", () => {
  state.listPages[key] = 1;
  render();
});
document.addEventListener("submit", (event) => {
  if (event.target.id !== "task-search-form") return;
  event.preventDefault();
  const fields = new FormData(event.target);
  state.taskSearch = { name: String(fields.get("name") || ""), status: String(fields.get("status") || "all"), teamId: String(fields.get("teamId") || "") };
  state.listPages[state.taskArchiveView ? "archive" : "tasks"] = 1;
  renderTasks();
});
document.addEventListener("reset", (event) => {
  if (event.target.id !== "task-search-form") return;
  event.preventDefault();
  state.taskSearch = { name: "", status: "all", teamId: "" };
  state.listPages[state.taskArchiveView ? "archive" : "tasks"] = 1;
  event.target.elements.name.value = "";
  event.target.elements.status.value = "all";
  event.target.elements.teamId.value = "";
  renderTasks();
});

document.addEventListener("click", (event) => {
  const el = (selector) => event.target.closest(selector);
  let target;
  if (event.target.closest(".task-actions-menu") || (taskMenu && !event.target.closest("[data-task-more]"))) closeTaskMenu();
  if ((target = el("[data-task-more]"))) return openTaskMenu(target);
  if ((target = el("[data-pagination] [data-page]"))) { const key = target.closest("[data-pagination]").dataset.pagination; state.listPages[key] = Number(target.dataset.page); ({ tasks: renderTasks, archive: renderTasks, teams: renderTeams, workflows: renderWorkflows, agents: renderAgents })[key]?.(); return; }
  if ((target = el("[data-chat-agent]"))) return communicationUI.open("agent", target.dataset.chatAgent);
  if ((target = el("[data-chat-team]"))) return communicationUI.open("team", target.dataset.chatTeam);
  if ((target = el("#logout-button"))) {
    target.disabled = true; target.textContent = "退出中…";
    api("/api/auth/logout", { method: "POST", body: "{}" }).then(() => location.replace("/login")).catch(error => { toast(error.message, true); target.disabled = false; target.textContent = "退出登录"; });
    return;
  }
  if ((target = el("[data-send-instruction]"))) {
    event.preventDefault();
    return sendInstruction({ preventDefault() {}, currentTarget: target.closest("form") });
  }
  if ((target = el(".nav-item[data-view]"))) return setView(target.dataset.view, { taskArchiveView: target.dataset.view === "tasks" ? false : state.taskArchiveView });
  if ((target = el("[data-goto]"))) return setView(target.dataset.goto, { taskArchiveView: target.dataset.goto === "tasks" ? false : state.taskArchiveView });
  if ((target = el("[data-open-runtime-settings]"))) { state.settingsPage = "runtime"; return setView("settings"); }
  if ((target = el("[data-manual-page]"))) {
    state.manualPage = target.dataset.manualPage;
    return setView("manual");
  }
  if ((target = el("[data-manual-next]"))) {
    event.preventDefault();
    state.manualPage = state.manualPage === "data-model" ? "system-architecture" : state.manualPage === "system-architecture" ? "task-flow" : "data-model";
    return setView("manual");
  }
  if ((target = el("[data-diagram-action]"))) {
    const key = target.dataset.diagramKey;
    const update = (scale) => { const label = $(`[data-diagram-scale="${key}"]`); if (label) label.textContent = `${Math.round(scale * 100)}%`; };
    if (target.dataset.diagramAction === "fit") return fitManualGraph(key, update);
    return zoomManualGraph(key, target.dataset.diagramAction === "zoom-in" ? .16 : -.16, update);
  }
  if ((target = el('[data-action="new-task"]'))) return newTaskModal();
  if ((target = el('[data-action="new-team"]'))) return newTeamModal();
  if ((target = el('[data-action="new-workflow"]'))) return workflowModal();
  if ((target = el('[data-action="new-agent"]'))) return newAgentModal();
  if ((target = el("[data-edit-agent]"))) {
    const agent = state.agents.find((item) => item.id === target.dataset.editAgent);
    return agent ? agentModal(agent) : toast("数字员工不存在。", true);
  }
  if ((target = el("[data-edit-team]"))) {
    const team = state.teams.find((item) => item.id === target.dataset.editTeam);
    return team ? teamModal(team) : toast("团队不存在。", true);
  }
  if ((target = el("[data-delete-agent]"))) return configurationDeletionModal("agent", target.dataset.deleteAgent);
  if ((target = el("[data-delete-team]"))) return configurationDeletionModal("team", target.dataset.deleteTeam);
  if ((target = el("[data-edit-workflow]"))) {
    closeModal();
    const workflow = state.workflowTemplates.find((item) => item.id === target.dataset.editWorkflow);
    return workflow ? workflowModal(workflow) : toast("工作流不存在。", true);
  }
  if ((target = el("[data-workflow-details]"))) {
    const workflow = state.workflowTemplates.find((item) => item.id === target.dataset.workflowDetails);
    return workflow ? workflowDetails(workflow) : toast("工作流不存在。", true);
  }
  if ((target = el("[data-delete-workflow]"))) {
    const workflow = state.workflowTemplates.find((item) => item.id === target.dataset.deleteWorkflow);
    if (!workflow) return;
    return confirmDialog({ title: "删除工作流", message: `删除工作流「${workflow.name}」？该操作不可恢复。`, confirmLabel: "删除工作流", danger: true })
      .then((accepted) => accepted ? api(`/api/workflow-templates/${workflow.id}`, { method: "DELETE" }).then(async () => { toast("工作流已删除。"); await refresh(); }).catch((error) => toast(error.message, true)) : undefined);
  }
  if ((target = el("[data-close-modal]")) || event.target.id === "modal-close" || event.target.id === "modal-backdrop") return closeModal();
  if (event.target.id === "notify-button") return toast("通知中心即将支持。");
  if ((target = el("#live-indicator"))) return toast(state.eventSource ? "SSE 事件流已连接当前 Run。" : "尚未订阅 Run 事件流。");
  if ((target = el("[data-open-run]"))) {
    state.selectedAgentId = null;
    state.selectedRunId = target.dataset.openRun;
    setView("workspace");
    return loadWorkspace(target.dataset.openRun);
  }
  if ((target = el("[data-open-task]"))) {
    const run = runOfTask(target.dataset.openTask);
    state.selectedAgentId = null;
    state.selectedRunId = run?.id || null;
    setView("workspace");
    return run ? loadWorkspace(run.id) : renderWorkspace();
  }
  if ((target = el("[data-run-task]"))) return runTask(target.dataset.runTask);
  if ((target = el("[data-task-center-page]"))) return setView("tasks", { taskArchiveView: target.dataset.taskCenterPage === "archive" });
  if ((target = el("[data-archive-task]"))) {
    const task = state.tasks.find((item) => item.id === target.dataset.archiveTask);
    if (!task) return;
    return confirmDialog({ title: "归档任务", message: `归档已完成任务「${task.title}」？它会从默认列表移入归档历史，全部交付记录仍可查看。`, confirmLabel: "归档任务" })
      .then((accepted) => accepted ? api(`/api/tasks/${task.id}/archive`, { method: "POST", body: "{}" }).then(async () => { toast("任务已归档，交付记录已保留。"); await refresh(); }).catch((error) => toast(error.message, true)) : undefined);
  }
  if ((target = el("[data-unarchive-task]"))) return api(`/api/tasks/${target.dataset.unarchiveTask}/unarchive`, { method: "POST", body: "{}" }).then(async () => { toast("任务已恢复到任务中心。"); await refresh(); }).catch((error) => toast(error.message, true));
  if ((target = el("[data-delete-task]"))) return openDeleteTaskModal(target.dataset.deleteTask);
  if ((target = el("[data-toggle-task-details]"))) { workspaceView().detailsOpen = !workspaceView().detailsOpen; return renderWorkspace(); }
  if ((target = el("[data-toggle-task-description]"))) { workspaceView().descriptionExpanded = !workspaceView().descriptionExpanded; return renderWorkspace(); }
  if ((target = el("[data-task-workflow-details]"))) return workflowDetails(state.workspace.run.task.workflowSnapshot, { frozen: true });
  if ((target = el("[data-ws-tab]"))) { workspaceView().jumpLatest = true; workspaceView().tab = target.dataset.wsTab; renderWorkspace(); if (target.dataset.wsTab === "diff" && workspaceView().changes && !workspaceView().changesLoading) return loadWorkingChanges(state.selectedRunId); if (target.dataset.wsTab === "directory" && workspaceView().directory && !workspaceView().directoryLoading) return loadWorkingDirectory(state.selectedRunId); return; }
  if ((target = el("[data-reload-workspace]"))) return loadWorkspace();
  if ((target = el("[data-load-directory]"))) return loadWorkingDirectory(state.selectedRunId,{path:target.dataset.loadDirectory});
  if ((target = el("[data-load-more-directory]"))) return loadWorkingDirectory(state.selectedRunId,{path:target.dataset.loadMoreDirectory,more:true});
  if ((target = el("[data-console-older]"))) return loadConsolePage(state.selectedRunId, state.selectedAgentId, { older: true });
  if ((target = el("[data-console-reset]"))) return loadConsolePage(state.selectedRunId, state.selectedAgentId, { reset: true, traceId: null });
  if ((target = el("[data-console-retry]"))) return loadConsolePage(state.selectedRunId, state.selectedAgentId, { older: consolePage(state.selectedRunId, state.selectedAgentId).loaded });
  if ((target = el("[data-back-to-tasks]"))) return setView("tasks");
  if ((target = el("[data-open-acceptance-directory]"))) { workspaceView().tab = "directory"; return renderWorkspace(); }
  if ((target = el("[data-select-working-file]"))) return loadWorkingFile(state.selectedRunId, target.dataset.selectWorkingFile);
  if ((target = el("[data-download-working-file]"))) return downloadWorkingFile(state.selectedRunId);
  if ((target = el("[data-select-diff]"))) return loadWorkingDiff(state.selectedRunId, target.dataset.selectDiff);
  if ((target = el("[data-diff-layout]"))) { workspaceView().diffLayout = target.dataset.diffLayout; return renderWorkingChanges(state.selectedRunId); }
  if ((target = el("[data-diff-scope]"))) { const view = workspaceView(); view.diffFull = target.dataset.diffScope === 'full'; return view.selectedDiffPath ? loadWorkingDiff(state.selectedRunId, view.selectedDiffPath) : renderWorkingChanges(state.selectedRunId); }
  if ((target = el("[data-refresh-changes]"))) return loadWorkingChanges(state.selectedRunId);
  if ((target = el("[data-refresh-directory]"))) return loadWorkingDirectory(state.selectedRunId);
  if ((target = el("[data-collaboration-filter]"))) { workspaceView().collaborationFilter = target.dataset.collaborationFilter; workspaceView().collaborationScroll = null; return renderWorkspace(); }
  if ((target = el("[data-collaboration-latest]"))) { const list = $(".human-message-list"); list.scrollTop = list.scrollHeight; return; }
  if ((target = el("[data-answer-message]"))) { workspaceView().replyToMessageId = target.dataset.answerMessage; renderWorkspace(); $("#instruction-text").focus({ preventScroll: true }); return; }
  if ((target = el("[data-open-collaboration-trace]"))) { const trace = state.workspace.traces.find((item) => item.id === target.dataset.openCollaborationTrace); if (!trace) return toast("来源 Trace 在当前 Run 中不可读取。", true); state.selectedAgentId = trace.agentId; workspaceView().jumpLatest = true; workspaceView().tab = "console"; loadConsolePage(state.selectedRunId, trace.agentId, { reset: true, traceId: trace.id }); renderWorkspace(); return; }
  if ((target = el("[data-open-acceptance-review]"))) { const trace = state.workspace?.traces.find((item) => item.id === target.dataset.openAcceptanceReview); if (!trace) return toast("经理交接记录在当前 Run 中不可读取。", true); state.selectedAgentId = trace.agentId; workspaceView().jumpLatest = true; workspaceView().tab = "console"; loadConsolePage(state.selectedRunId, trace.agentId, { reset: true, traceId: trace.id }); renderWorkspace(); return; }
  if ((target = el("[data-console-latest]"))) { workspaceView().jumpLatest = true; workspaceView().tab = "console"; loadConsolePage(state.selectedRunId, state.selectedAgentId, { reset: true, traceId: null }); renderWorkspace(); const stream = $("#trace-stream"); stream.scrollTop = stream.scrollHeight; return; }
  if ((target = el("[data-collaboration-older]"))) {
    const list = $(".human-message-list"), top = list.scrollTop, height = list.scrollHeight;
    workspaceView().collaborationLimit = (workspaceView().collaborationLimit || 30) + 30;
    renderWorkspace();
    const updated = $(".human-message-list"); updated.scrollTop = top + updated.scrollHeight - height;
    return;
  }
  if ((target = el("[data-select-agent]"))) { state.selectedAgentId = target.dataset.selectAgent; workspaceView().jumpLatest = true; return renderWorkspace(); }
  if ((target = el("[data-mention-insert]"))) {
    const textarea = $("#instruction-text");
    if (!textarea || textarea.disabled) return;
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const prefix = upto.replace(/@[^\s@]{0,12}$/, `@${target.dataset.mentionInsert} `);
    textarea.value = prefix + textarea.value.slice(textarea.selectionStart);
    textarea.setSelectionRange(prefix.length, prefix.length);
    workspaceView().draft = textarea.value;
    textarea.focus();
    $("#mention-list")?.classList.remove("show");
    return;
  }
  if ((target = el("[data-copy]"))) {
    const button = target;
    button.disabled = true;
    const copy = window.agentforgeDesktop?.copyWorkspacePath
      ? () => window.agentforgeDesktop.copyWorkspacePath(button.dataset.copy)
      : () => navigator.clipboard?.writeText ? navigator.clipboard.writeText(button.dataset.copy) : Promise.reject(new Error("当前环境不支持剪贴板"));
    Promise.resolve().then(copy).then(() => {
      button.textContent = "已复制";
      toast("已复制工作目录的绝对路径。");
      setTimeout(() => { if (button.isConnected) button.textContent = "复制"; }, 2000);
    }).catch(() => { button.textContent = "重试"; toast("复制失败，请重试。", true); })
      .finally(() => { button.disabled = false; });
    return;
  }
  if ((target = el("[data-open-completion-confirm]"))) return openCompletionModal(target.dataset.openCompletionConfirm);
  if ((target = el("[data-retry-scheduled]"))) return retryScheduledWorkspace(target.dataset.retryScheduled);
  if ((target = el("[data-retry-failed-node]"))) return retryFailedWorkspace(target.dataset.retryFailedNode, target.dataset.workflowNodeId);
  if ((target = el("[data-retry-orchestration]"))) return retryFailedOrchestration(target.dataset.retryOrchestration);
  if ((target = el("[data-pause-run]"))) return pauseWorkspaceRun(target.dataset.pauseRun);
  if ((target = el("[data-resume-run]"))) return resumeWorkspaceRun(target.dataset.resumeRun);
  if ((target = el("[data-terminate-run]"))) return openTerminateModal(target.dataset.terminateRun);
});

document.addEventListener("input", (event) => {
  if (event.target.id !== "instruction-text") return;
  workspaceView().draft = event.target.value;
  /* @ 提及：光标前文本以 @xxx 结尾时弹出角色建议 */
  const list = $("#mention-list");
  if (!list || !state.workspace) return;
  const upto = event.target.value.slice(0, event.target.selectionStart);
  const match = upto.match(/@([^\s@]{0,12})$/);
  if (!match) { list.classList.remove("show"); return; }
  const items = mentionables(workspaceAgents(state.workspace, state.agents)).filter((item) => item.name.includes(match[1]));
  list.innerHTML = items.length ? items.map((item, index) => `
    <button type="button" class="mention-item ${index === 0 ? "selected" : ""}" aria-selected="${index === 0}" data-mention-insert="${esc(item.name)}">
      <span class="check-avatar color-${esc(item.color || "system")}">${esc(item.name.slice(0, 1))}</span>
      ${esc(item.name)}<small>${esc(item.description || "")}</small>
    </button>`).join("") : '<div class="mention-empty">没有匹配的角色</div>';
  list.classList.add("show");
});

document.addEventListener("keydown", (event) => {
  if (event.target.id === "instruction-text" && !event.isComposing && event.keyCode !== 229) {
    const list = $("#mention-list");
    const items = list?.classList.contains("show") ? [...list.querySelectorAll("[data-mention-insert]")] : [];
    const modified = event.shiftKey || event.metaKey || event.altKey || event.ctrlKey;
    if (items.length && !modified && ["Enter", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      let index = Math.max(0, items.findIndex((item) => item.classList.contains("selected")));
      if (["Enter", "Tab"].includes(event.key)) items[index].click();
      else { index = (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items.forEach((item, i) => { item.classList.toggle("selected", i === index); item.setAttribute("aria-selected", String(i === index)); }); items[index].scrollIntoView({ block: "nearest" }); }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (modified) { const input = event.target; input.setRangeText("\n", input.selectionStart, input.selectionEnd, "end"); input.dispatchEvent(new Event("input", { bubbles: true })); }
      else if (!state.workspace?.run.task.archivedAt) event.target.form.requestSubmit();
      return;
    }
  }
  if (event.key !== "Escape") return;
  if ($("#mention-list")?.classList.contains("show")) { $("#mention-list").classList.remove("show"); return; }
  $("#mention-list")?.classList.remove("show");
  if ($("#modal-backdrop").classList.contains("open")) closeModal();
});
window.addEventListener("popstate", () => {
  const route = routeFromLocation();
  state.currentView = route.view;
  state.selectedChatId = route.chatId || null;
  state.selectedRunId = route.runId;
  state.manualPage = route.manualPage || "data-model";
  state.settingsPage = route.settingsPage || "general";
  state.taskArchiveView = Boolean(route.taskArchiveView);
  setView(route.view, { replace: true, taskArchiveView: state.taskArchiveView });
  if (route.view === "workspace" && route.runId) loadWorkspace(route.runId, { quiet: true });
});

/* ---------- 初始化：骨架屏 → bootstrap → 渲染 ---------- */
async function init() {
  if (location.pathname === "/settings") history.replaceState({}, "", "/settings/general");
  if (location.pathname === "/" && state.currentView === "tasks") history.replaceState({}, "", "/tasks");
  api("/api/auth/session").then(account => { $("#account-name").textContent = account.username; }).catch(() => {});
  setInterval(() => { if (!resetRequestActive) api("/api/auth/session").catch(() => {}); }, 60000);
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const now = new Date();
  $("#hero-date").textContent = `${now.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })} · 星期${days[now.getDay()]}`;
  $("#stats-grid").innerHTML = Array.from({ length: 4 }, () =>
    '<div class="stat-card"><div class="skeleton" style="width:60px;height:10px">·</div><div class="skeleton" style="width:44px;height:26px;margin-top:10px">·</div><div class="skeleton" style="width:110px;height:9px;margin-top:9px">·</div></div>').join("");
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === (state.currentView === "workspace" ? "tasks" : state.currentView)));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${state.currentView}-view`));
  const initialData = refresh();
  setInterval(refreshNavigation, 5000);
  if (state.currentView === "workspace" && state.selectedRunId) await Promise.all([initialData, loadWorkspace(state.selectedRunId, { quiet: true })]);
  else if (state.currentView === "workspace") renderWorkspace();
}
init();
