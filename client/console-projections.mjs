// Browser-safe view models shared by Web and desktop hosts. These functions only
// project already-authoritative API payloads; they never own domain state.

// Validate JSON, then format its original tokens: parsing and re-stringifying
// would silently round large integers in tool output. Never interpret HTML.
export function consoleContentTokens(value, { json = true, truncated = false } = {}) {
  const text = String(value ?? "");
  const plain = { json: false, tokens: [{ kind: "plain", text }] };
  if (!json || truncated || text.length > 12000) return plain;
  try { JSON.parse(text); } catch { return plain; }
  const raw = text.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g) || [];
  const tokens = [];
  let depth = 0;
  const add = (text, kind = "plain") => tokens.push({ kind, text });
  const newline = () => add("\n" + "  ".repeat(depth));
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (token === "{" || token === "[") {
      if (++depth > 40) return plain;
      add(token);
      if (!["}", "]"].includes(raw[i + 1])) newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (!["{", "["].includes(raw[i - 1])) newline();
      add(token);
    } else if (token === ",") { add(token); newline(); }
    else if (token === ":") add(": ");
    else add(token, token.startsWith('"') ? raw[i + 1] === ":" ? "attr" : "string" : /^(true|false|null)$/.test(token) ? "literal" : "number");
  }
  return { json: true, tokens };
}

export const STATUS_TEXT = {
  backlog: "待开始", planning: "规划中", running: "执行中", awaiting_human: "等待你的澄清",
  review: "经理协调中", awaiting_acceptance: "待你验收", paused: "已暂停", done: "已完成",
  blocked: "已阻塞", failed: "失败", completed: "已完成", cancelled: "已终止"
};

// Shell-like tools whose already-redacted input carries a real command line.
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "command_execution", "exec", "local_shell", "terminal", "powershell", "cmd"]);

export function isShellTool(toolName) {
  return SHELL_TOOL_NAMES.has(String(toolName || "").toLowerCase());
}

// The raw multi-line command carried by a shell tool's redacted input. Same
// honesty rules as toolCommandSummary: unparseable (for example truncated)
// JSON and non-command fields return null rather than a fabricated fragment.
export function shellCommandText(toolName, inputText) {
  if (!isShellTool(toolName)) return null;
  const text = String(inputText ?? "").trim();
  if (!text) return null;
  let command = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.command === "string") command = parsed.command;
  } catch {
    // Codex command_execution input is the raw command string, not JSON.
    if (!text.startsWith("{") && !text.startsWith("[")) command = text;
  }
  return command && command.trim() ? command : null;
}

// Lightweight browser-safe Shell coloring for already-redacted commands and
// output. Tokens only re-segment the original text; joining every token's
// text must reproduce the input exactly so copying loses nothing.
export function shellTokens(value) {
  const text = String(value ?? "");
  const tokens = [];
  let index = 0, fresh = true; // fresh: start of a command position (line start or after a separator)
  const push = (kind, tokenText) => { if (tokenText) tokens.push({ kind, text: tokenText }); };
  while (index < text.length) {
    const rest = text.slice(index);
    let match = rest.match(/^\s+/);
    if (match) { push("plain", match[0]); fresh = fresh || match[0].includes("\n"); index += match[0].length; continue; }
    if (rest.startsWith("#")) {
      match = rest.match(/^#[^\n]*/);
      push("comment", match[0]); fresh = false; index += match[0].length; continue;
    }
    if (rest.startsWith('"') || rest.startsWith("'") || rest.startsWith("`")) {
      const quote = rest[0];
      match = rest.match(quote === "`" ? /^`[^`]*`?/ : quote === '"' ? /^"(?:\\.|[^"\\])*"?/ : /^'[^']*'?/);
      push("string", match[0]); fresh = false; index += match[0].length; continue;
    }
    match = rest.match(/^(?:&&|\|\||[|;&<>]|\(|\))/);
    if (match) { push("operator", match[0]); fresh = true; index += match[0].length; continue; }
    match = rest.match(/^-[^\s|;&<>()]*/);
    if (match && !fresh) { push("option", match[0]); index += match[0].length; continue; }
    match = rest.match(/^\$(?:\{[^}\n]*\}|\w+|\?)/);
    if (match) { push("variable", match[0]); fresh = false; index += match[0].length; continue; }
    match = rest.match(/^[^\s"'`$#|;&<>()]+/);
    if (match) { push(fresh ? "command" : "plain", match[0]); fresh = false; index += match[0].length; continue; }
    push("plain", rest[0]); index += 1;
  }
  return tokens;
}

// Curated vscode-icons subset vendored under web/icons/vscode/ (MIT, see the
// LICENSE and README beside the icons). Unknown names/extensions fall back to
// the default file/folder glyphs instead of guessing a brand logo.
const DIRECTORY_ICON_BY_NAME = new Map(Object.entries({
  ".gitignore": "file_type_git", ".gitattributes": "file_type_git", ".gitmodules": "file_type_git",
  "license": "file_type_text", "readme": "file_type_markdown", "changelog": "file_type_markdown",
}));
const DIRECTORY_ICON_BY_EXTENSION = new Map(Object.entries({
  md: "file_type_markdown", mdx: "file_type_markdown", markdown: "file_type_markdown",
  js: "file_type_js", mjs: "file_type_js", cjs: "file_type_js", jsx: "file_type_js",
  ts: "file_type_typescript", tsx: "file_type_typescript",
  json: "file_type_json", map: "file_type_json",
  css: "file_type_css", html: "file_type_html", htm: "file_type_html",
  py: "file_type_python",
  sh: "file_type_shell", bash: "file_type_shell", zsh: "file_type_shell",
  yml: "file_type_yaml", yaml: "file_type_yaml",
  png: "file_type_image", jpg: "file_type_image", jpeg: "file_type_image", gif: "file_type_image", webp: "file_type_image", svg: "file_type_image",
  txt: "file_type_text", log: "file_type_text",
  xml: "file_type_xml", sql: "file_type_sql",
  java: "file_type_java", go: "file_type_go", rs: "file_type_rust",
  c: "file_type_c", h: "file_type_c", cpp: "file_type_cpp", hpp: "file_type_cpp", cc: "file_type_cpp",
  vue: "file_type_vue", pdf: "file_type_pdf", zip: "file_type_binary", gz: "file_type_binary",
}));
export function workingDirectoryIcon(name, type) {
  if (type === "directory") return { closed: "default_folder", open: "default_folder_opened" };
  const base = String(name || "").split("/").filter(Boolean).at(-1) || "";
  const lower = base.toLowerCase();
  const stem = lower.replace(/\.[^.]*$/, "");
  const icon = DIRECTORY_ICON_BY_NAME.get(lower) || DIRECTORY_ICON_BY_NAME.get(stem) || DIRECTORY_ICON_BY_EXTENSION.get(lower.includes(".") ? lower.split(".").at(-1) : "") || "default_file";
  return { closed: icon, open: icon };
}

// Title summaries only restate console content the client already fetched and
// the runtime already redacted. Any parse failure (for example a truncated
// field) must fall back to no summary rather than show a fabricated fragment.
export function toolCommandSummary(toolName, inputText) {
  const name = String(toolName || "").toLowerCase();
  if (["read", "write"].includes(name)) return toolFileInput(toolName, inputText)?.filePath || null;
  if (!SHELL_TOOL_NAMES.has(name)) return null;
  const text = String(inputText ?? "").trim();
  if (!text) return null;
  let command = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.command === "string") command = parsed.command;
  } catch {
    // Codex command_execution input is the raw command string, not JSON. A
    // truncated JSON payload starts with a brace and must not be shown as a
    // half command, so only clearly non-JSON text qualifies.
    if (!text.startsWith("{") && !text.startsWith("[")) command = text;
  }
  if (!command || !command.trim()) return null;
  return command.trim().replace(/\s*\r?\n\s*/g, " ⏎ ");
}

// Only interpret complete, already-redacted file-tool input. Never extract
// fragments from truncated JSON or infer content from the current filesystem.
export function toolFileInput(toolName, inputText) {
  if (!["read", "write"].includes(String(toolName || "").toLowerCase())) return null;
  let input;
  try { input = JSON.parse(String(inputText ?? "")); } catch { return null; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const filePath = input.file_path ?? input.path;
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  return { filePath, content: typeof input.content === "string" ? input.content : null };
}

// Real Edit invocations carry file_path/old_string/new_string in their
// redacted input. Missing or non-string fields mean the record cannot support
// a truthful diff and the caller must fall back to the generic sections.
export function toolEditInput(toolName, inputText) {
  if (String(toolName || "") !== "Edit") return null;
  let parsed;
  try { parsed = JSON.parse(String(inputText ?? "")); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { file_path, old_string, new_string } = parsed;
  if (typeof old_string !== "string" || typeof new_string !== "string") return null;
  if (!old_string && !new_string) return null;
  return { filePath: typeof file_path === "string" ? file_path : "", oldText: old_string, newText: new_string };
}

// Line-oriented LCS diff for already-bounded Edit inputs (≤12,000 chars per
// field). Common prefixes/suffixes stay context; an oversized middle degrades
// to an honest deletions-then-additions block instead of expensive alignment.
export function editDiff(oldText, newText, { maxCells = 2000000 } = {}) {
  if (typeof oldText !== "string" || typeof newText !== "string") return null;
  const oldLines = oldText.split("\n"), newLines = newText.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const context = (text) => ({ type: "context", text });
  const removed = (text) => ({ type: "del", text });
  const added = (text) => ({ type: "add", text });
  const head = oldLines.slice(0, prefix).map(context);
  const tail = oldLines.slice(oldEnd).map(context);
  const oldMiddle = oldLines.slice(prefix, oldEnd), newMiddle = newLines.slice(prefix, newEnd);
  if (!oldMiddle.length && !newMiddle.length) return { aligned: true, lines: [...head, ...tail] };
  if (oldMiddle.length * newMiddle.length > maxCells) return { aligned: false, lines: [...head, ...oldMiddle.map(removed), ...newMiddle.map(added), ...tail] };
  const rows = oldMiddle.length, columns = newMiddle.length, width = columns + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--) table[i * width + j] = oldMiddle[i] === newMiddle[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const middle = [];
  let i = 0, j = 0;
  while (i < rows && j < columns) {
    if (oldMiddle[i] === newMiddle[j]) { middle.push(context(oldMiddle[i])); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { middle.push(removed(oldMiddle[i])); i++; }
    else { middle.push(added(newMiddle[j])); j++; }
  }
  while (i < rows) middle.push(removed(oldMiddle[i++]));
  while (j < columns) middle.push(added(newMiddle[j++]));
  return { aligned: true, lines: [...head, ...middle, ...tail] };
}

// These categories are display-only. Store remains the authority for every
// Task/Run transition; clients use them only to make human next actions clear.
export const TASK_FILTERS = Object.freeze([
  { id: "all", label: "全部" },
  { id: "attention", label: "待你处理" },
  { id: "active", label: "执行中" },
  { id: "backlog", label: "待开始" },
  { id: "done", label: "已完成" },
  { id: "cancelled", label: "已终止" }
]);

const taskAttentionStatuses = new Set(["awaiting_human", "awaiting_acceptance", "paused", "blocked", "failed"]);
const taskActiveStatuses = new Set(["planning", "running", "review"]);
const terminalRunStatuses = new Set(["completed", "cancelled", "failed"]);

export function taskNeedsAttention(status) {
  return taskAttentionStatuses.has(status);
}

export function taskMatchesFilter(status, filter) {
  if (filter === "all") return true;
  if (filter === "attention") return taskNeedsAttention(status);
  if (filter === "active") return taskActiveStatuses.has(status);
  return status === filter;
}

export function taskActionLabel(status) {
  return {
    awaiting_human: "去澄清",
    awaiting_acceptance: "去验收",
    paused: "查看并继续",
    blocked: "查看恢复选项",
    failed: "查看恢复选项",
    done: "查看结果",
    cancelled: "查看记录"
  }[status] || "进入任务空间";
}

export const EVENT_KIND_LABEL = { output: "输出", thinking: "推理片段", tool: "工具调用", deliver: "交付", system: "系统" };

const asArray = (value) => Array.isArray(value) ? value : [];
const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function providerLabel(agent) {
  return agent?.runtime?.provider === "codex" ? "Codex" : "Claude Code";
}

export function formatRelativeTime(iso, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

export function formatExactTime(iso) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function classifyEvent(event = {}) {
  if (event.type === "node.completed") return "deliver";
  if (event.type !== "runtime.event") return "system";
  if (event.data?.presentation === "tool_result") return "tool";
  // Claude Code can label natural-language assistant content as thinking. It is
  // still visible output in a client console, not hidden model reasoning.
  if (event.data?.presentation === "thinking" && event.data?.providerEventType === "assistant") return "output";
  if (event.data?.presentation) return event.data.presentation;
  const type = String(event.data?.providerEventType || "").toLowerCase();
  if (type === "system") return "system";
  if (/tool|command|bash|exec|edit|write|read|patch|shell|stderr|stdout/.test(type)) return "tool";
  if (/think|reason/.test(type)) return "thinking";
  if (/result|complete|deliver|artifact/.test(type)) return "deliver";
  return "output";
}

export function displayText(event = {}) {
  const message = String(event.message || "");
  const type = event.data?.providerEventType;
  if (event.type === "runtime.event" && type) {
    const marker = ` · ${type}: `;
    const index = message.indexOf(marker);
    if (index !== -1) return message.slice(index + marker.length);
  }
  // Old audit records lack a provider event type. Only remove an exact actor
  // prefix so URLs, JSON and command text retain their leading content.
  const actorName = event.actor?.name;
  return actorName ? message.replace(new RegExp(`^${escapeRegExp(actorName)}(?: · [^:\n]+)?:\\s*`), "") : message;
}

export function isTransportFrame(event = {}) {
  if (event.data?.providerEventType === "stream_event") return true;
  const type = event.data?.providerEventType;
  if (event.type !== "runtime.event" || !type) return false;
  const text = displayText(event).trim();
  return text === type || /^(thinking_tokens|status|init|message_start|message_stop|content_block_start|content_block_stop)$/.test(text);
}

// Console content is not the full audit log. Suppress only known, empty
// bookkeeping notifications; never discard recorded bodies, tools, abnormal
// lifecycle events or unfamiliar messages. The source events stay untouched.
export function isRoutineConsoleEvent(event = {}) {
  const data = event.data || {};
  if (data.contentRef || ["tool", "tool_result", "error"].includes(data.presentation)) return false;
  if (/error|fail|cancel|reset|recover|retry|timeout|interrupt|escalat|blocked/i.test([event.type, data.providerEventType, data.subtype, data.status].join(" "))) return false;
  if (["session.created", "session.resumed", "communication.started", "communication.completed", "trace.started", "trace.completed", "trace.accepted"].includes(event.type)) return true;
  if (event.type !== "runtime.event" || data.auditVersion !== 2) return false;
  const type = data.providerEventType;
  if (type === "stderr" && data.presentation === "system") return true; // diagnostic text remains in the private log
  if (!["system", "thread.started", "turn.started", "turn.completed", "result", "item.started", "item.completed", "assistant", "tool_progress"].includes(type)) return false;
  const text = displayText(event).trim();
  // Task audits prefix their message with the exact Provider event type;
  // communication audits do not. Normalize that envelope, not business text.
  const summary = text.startsWith(`${type}: `) ? text.slice(type.length + 2) : text;
  return ["Provider 会话已初始化", "成员会话已连接", "Provider 已返回结构化结果", "模型已更新执行进展", "模型正在整理执行方案"].includes(summary);
}

export function workspaceAgents(workspace = {}, agents = []) {
  const run = workspace.run;
  if (!run) return [];
  const assigned = Array.isArray(run.participants)
    ? run.participants.filter((member) => member.type === "agent" && member.id !== run.manager?.id)
    : Object.values(run.task?.nodeAssignments || {}).map((agentId) => asArray(agents).find((agent) => agent.id === agentId));
  const members = new Map();
  for (const agent of [run.manager, ...assigned, ...asArray(workspace.traces).map((trace) => trace.agent)].filter(Boolean)) if (!members.has(agent.id)) members.set(agent.id, agent);
  return [...members.values()];
}

// A running Trace is an invocation fact, but a terminal Run is the lifecycle
// authority for the whole workspace. A late read model must not make a
// cancelled, failed, or completed Run look as though a member is still active.
export function roleExecutionStatus(run = {}, traces = [], agentId) {
  const agentTraces = asArray(traces).filter((trace) => trace.agentId === agentId);
  const terminal = terminalRunStatuses.has(run.status);
  const activeTrace = terminal ? null : agentTraces.find((trace) => trace.status === "running") || null;
  const terminalLabel = terminal ? (STATUS_TEXT[run.status] || run.status) : null;
  return {
    active: Boolean(activeTrace),
    activeTrace,
    traceCount: agentTraces.length,
    label: activeTrace
      ? `● 执行中 · ${activeTrace.workflowNodeId}`
      : `○ ${terminalLabel || "空闲"} · ${agentTraces.length} 条 Trace`,
  };
}

export function workflowFocus(run = {}, traces = [], defects = []) {
  const focus = {};
  for (const trace of asArray(traces)) if (trace.workflowNodeId && trace.agentId !== run.manager?.id) focus[trace.workflowNodeId] = trace.status === "running" ? "active" : "recent";
  for (const defect of asArray(defects).filter((item) => item.status !== "closed")) for (const nodeId of asArray(defect.affectedNodeIds)) focus[nodeId] = "attention";
  if (run.waitingNodeId) focus[run.waitingNodeId] = run.status === "awaiting_human" ? "waiting_human" : "waiting_agent";
  if (run.currentFocus?.nodeId && !run.waitingNodeId && !asArray(traces).some((trace) => trace.workflowNodeId === run.currentFocus.nodeId && trace.status === "running")) focus[run.currentFocus.nodeId] = "current";
  return focus;
}

export function buildConsoleEntries(events = []) {
  const entries = [];
  const calls = new Map();
  for (const event of asArray(events)) {
    if (isRoutineConsoleEvent(event)) continue;
    if (classifyEvent(event) !== "tool") { entries.push({ type: "event", event }); continue; }
    const result = event.data?.presentation === "tool_result" || Boolean(event.data?.toolResultId);
    if (result) {
      const key = `${event.data?.traceId || ""}:${event.data?.toolResultId}`;
      const invocation = event.data?.toolResultId && calls.get(key);
      if (invocation) {
        if (invocation.event.data?.presentation === 'tool_result' || invocation.event.data?.toolResultId) invocation.event = event;
        else invocation.result = event;
      }
      else {
        const entry = { type: "tool", event, result: null };
        entries.push(entry);
        if (event.data?.toolResultId) calls.set(key, entry);
      }
      continue;
    }
    const key = `${event.data?.traceId || ""}:${event.data?.toolUseId}`;
    const previous = event.data?.toolUseId && calls.get(key);
    if (previous) {
      // Provider phases with the same native call ID are one invocation, not
      // repeated calls. Distinct IDs (even for the same tool) stay separate.
      if (previous.event.data?.presentation === 'tool_result') { previous.result = previous.event; previous.event = event; }
      else if (event.data?.contentRef) previous.event = event;
      continue;
    }
    const entry = { type: "tool", event, result: null };
    entries.push(entry);
    if (event.data?.toolUseId) calls.set(key, entry);
  }
  return groupConsecutiveToolEntries(entries);
}

function groupConsecutiveToolEntries(entries) {
  const grouped = [];
  let index = 0;
  while (index < entries.length) {
    const current = entries[index];
    if (current.type !== "tool") { grouped.push(current); index += 1; continue; }
    const toolName = current.event.data?.toolName || current.event.data?.providerEventType || "工具";
    if (toolName === "StructuredOutput") { grouped.push(current); index += 1; continue; }
    // A group is one visual run of identical calls within a single invocation;
    // merging across Trace boundaries would hide later invocations' entries.
    const traceId = current.event.data?.traceId || null;
    const tools = [current];
    let next = index + 1;
    while (next < entries.length) {
      const candidate = entries[next];
      const candidateName = candidate.type === "tool" ? (candidate.event.data?.toolName || candidate.event.data?.providerEventType || "工具") : null;
      if (candidateName !== toolName || (candidate.event.data?.traceId || null) !== traceId) break;
      tools.push(candidate);
      next += 1;
    }
    grouped.push(tools.length > 1 ? { type: "tool-group", toolName, tools, timestamp: current.event.timestamp } : current);
    index = next;
  }
  return grouped;
}

export function mentionables(agents = []) {
  return [...new Map(asArray(agents).filter(Boolean).map((agent) => [agent.id, { id: agent.id, name: agent.name, color: agent.color }])).values()];
}

export function collaborationRecords(workspace = {}) {
  const messages = asArray(workspace.messages), dispatches = asArray(workspace.dispatches);
  const statuses = { queued: "排队中", claimed: "执行中", waiting: "等待答复", done: "已处理", cancelled: "已取消" };
  const kinds = { inquiry: "人类咨询", inquiry_answer: "答疑回复", agent_consultation: "角色咨询", clarification_question: "询问人类", consultation_answer: "咨询答复", clarification_answer: "人类答复", human_instruction: "追加指令", instruction: "追加指令", handoff: "交接", manager_decision: "经理决策", escalation: "自动升级" };
  const records = messages.filter((item) => item.kind !== "automatic_retry" && (item.sender?.type === "agent" ? ["agent", "human", "team"].includes(item.recipient?.type) : item.sender?.type === "human" && item.recipient?.type === "agent")).map((item) => {
    const delivery = dispatches.find((entry) => asArray(entry.messageIds).includes(item.id));
    const waiting = dispatches.find((entry) => entry.waitingMessageId === item.id);
    const answer = messages.find((entry) => entry.replyToMessageId === item.id);
    const question = messages.find((entry) => entry.id === item.replyToMessageId);
    const statusCode = answer ? "answered" : waiting?.status === "waiting" ? "waiting" : delivery?.status || "recorded";
    const tone = statusCode === "waiting" || item.kind === "escalation" ? "warning" : item.sender?.type === "human" ? "info" : ["manager_decision", "agent_consultation"].includes(item.kind) ? "violet" : "teal";
    return { id: item.id, timestamp: item.createdAt, category: "message", tone, statusCode, human: item.sender?.type === "human" || item.recipient?.type === "human", from: item.sender?.name || "团队", to: item.recipient?.name || "团队", title: kinds[item.kind] || (item.replyToMessageId ? "答复" : "协作消息"), content: item.content || "", status: answer ? "已回答" : waiting?.status === "waiting" ? "等待答复" : delivery ? statuses[delivery.status] || delivery.status : "已记录", questionType: item.questionType, routingReason: item.routingReason, reply: question ? `${question.sender?.name || "团队"}：${question.content || ""}` : null, replyId: item.id, canReply: Boolean(waiting?.status === "waiting" && item.recipient?.type === "human"), traceId: item.traceId };
  });
  return records.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}
