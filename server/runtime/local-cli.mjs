import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCodexAppServer } from "./codex-app-server.mjs";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { registerExecution, hasActiveExecution } from "./registry.mjs";
import { selectedExtensions, codexMarketArgs, claudeMarketEnvironment } from "./extensions.mjs";
import { diagnostic, diagnosticRedactor, withDiagnosticContext } from "../diagnostics.mjs";
import { diagnoseLaunch } from "./launch-diagnostics.mjs";
import { cliEnvironment } from "./cli-environment.mjs";

export class RuntimeCancelledError extends Error {
  constructor(message = "Agent 进程已被终止") {
    super(message);
    this.name = "RuntimeCancelledError";
  }
}

export class RuntimeSessionMissingError extends Error {}

// Preserve diagnostic wording. Classification controls scheduling separately;
// it must never replace the error shown to the operator.
export function runtimeFailureDetail(value, prompt = '') {
  return diagnosticRedactor({ prompt })(value instanceof Error ? value.message : String(value || 'Unknown runtime error'));
}
export function retryableRuntimeFailure(error) {
  if (typeof error?.retryable === 'boolean') return error.retryable;
  const text = String(error?.message || error || '');
  if (/ENOENT|EACCES|EPERM|EXTENSION_|(?:\b401\b|\b403\b)|invalid.api.key|authentication|permission denied|unknown option|unrecognized (?:option|argument)/i.test(`${error?.code || ''} ${text}`)) return false;
  return /\b(?:429|502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|rate[_ -]?limit|too many requests|overloaded|temporarily unavailable/i.test(text);
}

const sensitiveAssignment = /(?:api[_-]?key|authorization|token|secret|password|cookie|session(?:[_-]?id)?|sid)\s*["']?\s*[:=]/i;
const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s/]+@/i;
const sensitiveLineAssignment = /[A-Z0-9_-]*(?:SECRET|PASSWORD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Z0-9_-]*\s*["']?\s*[:=]/i;
const sensitiveCliFlag = /--(?:password|token|api-key|secret)\s+\S/i;

function bounded(value, max = 12000) {
  const text = String(value ?? "").split(/\r?\n/).map((line) => {
    if (sensitiveAssignment.test(line) || credentialUrl.test(line)) return "[REDACTED]";
    return line.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  }).join("\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function redactCredentialPatterns(raw) {
  return raw.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[PRIVATE KEY REDACTED]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[UUID REDACTED]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/gi, "[CREDENTIAL URL REDACTED]");
}

function redactSensitiveLines(raw) {
  return raw.split(/\r?\n/).map(line => sensitiveLineAssignment.test(line) || sensitiveCliFlag.test(line) ? '[REDACTED]' : line).join('\n');
}

// Final chat replies retain their complete length while applying the same filter.
export function redactExternalText(value) { return bounded(value, Infinity); }

// The dispatch prompt snapshot is the exact platform-assembled prompt handed
// to the runtime, filtered by the same credential patterns as execution
// content. It is persisted redacted and byte-bounded; pattern redaction
// cannot guarantee detection of every unmarked secret.
export function promptSnapshot(value, { maxBytes = 150000 } = {}) {
  const original = value && typeof value === "object" ? `[应用系统指令]\n${value.systemPrompt || ""}\n\n[本轮输入]\n${value.prompt || ""}` : String(value ?? "");
  const cleaned = bounded(redactSensitiveLines(redactCredentialPatterns(original)), Infinity).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const buffer = Buffer.from(cleaned, "utf8");
  let text = cleaned, truncated = false;
  if (buffer.length > maxBytes) {
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    text = `${buffer.subarray(0, end).toString("utf8")}…`;
    truncated = true;
  }
  const snapshot = () => ({ version: 1, kind: "prompt-snapshot", prompt: { text, truncated, redacted: text !== original } });
  if (Buffer.byteLength(JSON.stringify(snapshot()), "utf8") > 300000) {
    const points = Array.from(text);
    let low = 0, high = points.length;
    truncated = true;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      text = `${points.slice(0, mid).join("")}…`;
      if (Buffer.byteLength(JSON.stringify(snapshot()), "utf8") <= 300000) low = mid;
      else high = mid - 1;
    }
    text = `${points.slice(0, low).join("")}…`;
  }
  return snapshot();
}

// Only explicitly emitted content blocks are eligible. Never serialize an
// entire provider frame (it can contain prompts, signatures and credentials).
export function executionContent(fields, prompt = "") {
  const result = { version: 1, fields: {} };
  for (const [kind, value] of Object.entries(fields)) {
    if (!["text", "thinking", "input", "output"].includes(kind) || value == null) continue;
    let raw = typeof value === "string" ? value : JSON.stringify(value, (key, item) =>
      /password|secret|token|credential|private.?key|authorization|cookie|api.?key|session.?id|signature|encrypted|prompt/i.test(key) ? "[REDACTED]" : item, 2);
    if (!raw) continue;
    if (prompt) {
      raw = raw.replaceAll(prompt, "[PROMPT REDACTED]").replaceAll(JSON.stringify(prompt).slice(1, -1), "[PROMPT REDACTED]");
      for (const line of prompt.split('\n').filter(line => line.length >= 80)) raw = raw.replaceAll(line, '[PROMPT EXCERPT REDACTED]');
    }
    raw = redactCredentialPatterns(raw);
    const safeLines = redactSensitiveLines(raw);
    const cleaned = bounded(safeLines, Infinity).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    result.fields[kind] = { text: cleaned.slice(0, 12000), truncated: cleaned.length > 12000, redacted: cleaned !== raw || raw !== (typeof value === "string" ? value : JSON.stringify(value, null, 2)) };
  }
  return Object.keys(result.fields).length ? result : null;
}

function publicIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(normalized) ? normalized : null;
}

function sessionIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9-]{16,100}$/.test(normalized) ? normalized : null;
}

function publicEventType(value, fallback) {
  const normalized = publicIdentifier(value);
  return normalized && /^[A-Za-z][A-Za-z0-9_.-]{0,120}$/.test(normalized) ? normalized : fallback;
}

function compact(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null && value !== undefined));
}

// This is intentionally the only conversion from transient provider diagnostics
// to a durable-facing failure category. Callers may use it at their persistence
// boundary, but must never retain the input text alongside the summary.
export function runtimeFailureSummary(value) {
  const text = String(value || "").trim();
  for (const [pattern, summary] of [
    [/市场扩展|所选 MCP|未选择的 MCP|Codex 市场|不支持市场技能加载隔离/, "市场扩展不可用：检查所选版本完整性、MCP 连接及 CLI 兼容性，修复后重试。"],
    [/CLI 不可启动|ENOENT|command not found/i, "CLI 不可启动：在设置 → 本机运行时检查 CLI 路径，并按运行日志中的启动诊断排查。"],
    [/CLI 无执行权限|EACCES|EPERM/i, "CLI 无执行权限：检查可执行文件及任务目录权限。"],
    [/登录已失效|not logged in|login required|invalid api key|401|403/i, "CLI 登录已失效或请求未授权：请在本机终端检查登录与模型访问权限。"],
    [/网络连接失败|ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network error/i, "网络连接失败：检查本机网络、代理和 Provider 服务地址。"],
    [/CLI 参数不兼容|unknown option|unrecognized (?:option|argument)/i, "CLI 参数不兼容：检查本机 CLI 版本与数字员工运行配置。"],
    [/未返回可验证的最终结构化结果/, "CLI 未返回可验证的最终结构化结果：检查模型与 CLI 配置后重试。"],
  ]) if (pattern.test(text)) return summary;
  if (/Provider 请求受限/.test(text)) return "Provider 请求受限，请稍后重试。";
  if (/Provider 服务暂时不可用/.test(text)) return "Provider 服务暂时不可用，请稍后重试。";
  if (/Provider 请求超时/.test(text)) return "Provider 请求超时，请稍后重试。";
  if (/Provider 鉴权或权限失败/.test(text)) return "Provider 鉴权或权限失败，请检查本机运行时配置。";
  if (/Provider 执行失败/.test(text)) return "Provider 执行失败，请稍后重试。";
  if (/(?:429|rate limit|capacity|overload|overloaded|too many requests)/i.test(text)) return "Provider 请求受限，请稍后重试。";
  if (/(?:502|503|504|service unavailable|temporarily unavailable|upstream service|gateway)/i.test(text)) return "Provider 服务暂时不可用，请稍后重试。";
  if (/(?:timeout|timed out|deadline exceeded)/i.test(text)) return "Provider 请求超时，请稍后重试。";
  if (/(?:authentication|unauthori[sz]ed|forbidden|permission denied|access denied)/i.test(text)) return "Provider 鉴权或权限失败，请检查本机运行时配置。";
  return "Provider 执行失败，请稍后重试。";
}

function runtimeMessage({ providerEventType, presentation, subtype, failure }) {
  if (failure) return runtimeFailureSummary(failure);
  if (providerEventType === "system" && subtype === "api_retry") return "Provider 正在重试请求";
  if (providerEventType === "system") return "Provider 会话已初始化";
  if (providerEventType === "thread.started") return "成员会话已连接";
  if (presentation === "tool") return "已请求本机工具";
  if (presentation === "tool_result") return "本机工具已返回结果";
  if (presentation === "thinking") return "模型正在整理执行方案";
  if (presentation === "error") return "Provider 返回了失败事件";
  if (providerEventType === "result" || providerEventType === "item.completed") return "Provider 已返回结构化结果";
  return "模型已更新执行进展";
}

// A session ID is a short-lived transport value for Store-owned session binding,
// not an audit field. Callers bind it first, then persist only auditEvent.
export function separateRuntimeSession(event) {
  const data = event?.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {};
  const { sessionId, ...auditData } = data;
  const { content, ...summary } = event;
  return { content, sessionId: typeof sessionId === "string" ? sessionId : null, auditEvent: { ...summary, data: auditData } };
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => contentText(item?.text ?? item?.content ?? item)).filter(Boolean).join("\n");
  return value?.text || value?.content || "";
}

function claudeDetails(event) {
  const content = event.message?.content;
  const stream = event.event || {};
  const block = Array.isArray(content) ? content.find((item) => item.type === "tool_use") : null;
  const toolResult = Array.isArray(content) ? content.find((item) => item.type === "tool_result") : null;
  const resultOutput = contentText(toolResult?.content || event.tool_result);
  const text = typeof content === "string" ? content : content?.find?.((item) => item.type === "text")?.text || resultOutput || stream.delta?.text || stream.delta?.thinking || stream.content_block?.text;
  const thinking = stream.delta?.thinking || content?.find?.((item) => item.type === "thinking")?.thinking;
  const presentation = block ? "tool" : toolResult ? "tool_result" : thinking ? "thinking" : /error|failed/i.test(event.type || "") ? "error" : event.type === "system" ? "system" : "output";
  return { block, toolResult, text, presentation };
}

function claudeEvent(event, prompt = "") {
  const { block, toolResult, presentation } = claudeDetails(event);
  const providerEventType = publicEventType(event.type, "claude.event");
  const subtype = event.type === "system" && ["init", "api_retry"].includes(event.subtype) ? event.subtype : null;
  const failure = presentation === "error" ? event.error?.message || event.message?.error?.message || event.result?.error?.message : null;
  return {
    providerEventType,
    message: runtimeMessage({ providerEventType, presentation, subtype, failure }),
    data: compact({ auditVersion: 2, subtype, sessionId: sessionIdentifier(event.session_id), presentation, toolUseId: publicIdentifier(block?.id), toolResultId: publicIdentifier(toolResult?.tool_use_id), toolName: publicIdentifier(block?.name), status: block ? "running" : toolResult ? (toolResult.is_error ? "failed" : "completed") : undefined }),
    content: claudeTerminalFailure(event) ? null : executionContent(block ? { input: block.input } : toolResult ? { output: contentText(toolResult.content) } : event.type === "assistant" ? { text: event.message?.content?.find?.(item => item.type === "text")?.text, thinking: event.message?.content?.find?.(item => item.type === "thinking")?.thinking } : {}, prompt)
  };
}

function claudeTerminalFailure(event) {
  // A failed tool is an observation the Agent may recover from, not a failed
  // Provider turn. In particular its output can legitimately start with Error:.
  if (!["assistant", "error", "result"].includes(event.type)) return null;
  if (claudeDetails(event).block || claudeDetails(event).toolResult) return null;
  const { text } = claudeDetails(event);
  const message = text || "";
  const subtype = String(event.subtype || "").toLowerCase();
  const explicitFailure = event.type === "error" || /(?:error|fail)/.test(subtype);
  if (explicitFailure) {
    const detail = event.error?.message || event.message?.error?.message || event.result?.error?.message || message;
    return detail || `Claude Code ${event.type}: ${subtype}`;
  }
  // Claude can finish a JSONL stream with a non-zero exit and no stderr after
  // emitting an assistant-visible provider failure (for example, a transient
  // gateway error). Preserve only clearly provider-shaped terminal text; do
  // not mistake an arbitrary Agent response for an execution failure.
  if (/^(?:api\s+error\b|error\s*:|failed\s*:|failure\s*:|rate limit(?:ed)?\b|overloaded\b|service unavailable\b|upstream service\b|timeout\b|timed out\b|authentication(?: failed)?\b|permission denied\b)/i.test(message)) return message;
  return null;
}

async function verifyPaths(paths, label) {
  for (const path of paths || []) {
    try {
      await access(path, constants.R_OK);
    } catch (error) {
      diagnostic("provider.path_error", { error, path, label });
      throw new Error(`${label} 不可读取：${path}`);
    }
  }
}

async function executeJsonl({ runId, executionKey = runId, command, args, cwd, env, onEvent, normalizeEvent, getFinal, getTerminalFailure = () => null, provider, session, canStart = () => true, apiRetryTimeoutMs = 300000, idleTimeoutMs = 600000 }) {
  let cancelled = false;
  let cancellationReason = null;
  let stderr = "";
  let sessionObserved = false;
  let stderrReported = false;
  let stdoutReported = false;
  let spawnFailure = null;
  const pendingTools = new Map();
  // No await between the caller's cancellation fence and spawn/registration.
  // Runtime does not know domain state; the caller supplies the lifecycle fence.
  if (!canStart()) throw new RuntimeCancelledError("执行在启动前已暂停或终止");
  if (hasActiveExecution(executionKey)) throw new Error("该执行会话已有本地 Agent 进程在执行");
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let watchdogError = null;
  let apiRetryTimer = null;
  let idleTimer = null;
  const stopWatchdogs = () => { clearTimeout(apiRetryTimer); clearTimeout(idleTimer); apiRetryTimer = null; idleTimer = null; };
  const stopForWatchdog = (message) => {
    if (watchdogError || closed) return;
    watchdogError = new Error(message);
    diagnostic("provider.watchdog", { error: watchdogError });
    child.kill("SIGTERM");
    setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 3000).unref();
  };
  const resetIdleWatchdog = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stopForWatchdog(`Provider 超过 ${Math.round(idleTimeoutMs / 1000)} 秒未产生可审计进展事件`), idleTimeoutMs);
    idleTimer.unref();
  };
  let closed = false;
  const exitTask = new Promise((resolve) => child.once("close", (code, signal) => { closed = true; diagnostic("provider.exit", { code, signal, childPid: child.pid }); resolve({ code, signal }); }));
  diagnostic("provider.spawn", { command, cwd, searchPath: env.PATH, childPid: child.pid, provider });
  resetIdleWatchdog();
  const unregister = registerExecution(executionKey, {
    terminate(reason) {
      cancelled = true;
      cancellationReason = reason;
      diagnostic("provider.cancel", { reason });
      child.kill("SIGTERM");
      setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 3000).unref();
    }
  });
  try {
    child.on("error", (error) => { diagnostic("provider.spawn_error", { error }); spawnFailure = error; });
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity });
    const stderrTask = (async () => {
      for await (const line of stderrLines) {
        diagnostic("provider.stderr", { text: line });
        stderr = `${stderr}${line}\n`.slice(-8000);
        if (!stderrReported) {
          stderrReported = true;
          await onEvent({ providerEventType: "stderr", message: "Provider 诊断输出已隐藏", data: { auditVersion: 2, presentation: "system" } });
        }
      }
    })();
    for await (const line of stdout) {
      if (!line.trim()) continue;
      let providerEvent;
      try { providerEvent = JSON.parse(line); }
      catch (error) {
        diagnostic("provider.stdout_invalid_json", { text: line, error });
        if (!stdoutReported) {
          stdoutReported = true;
          await onEvent({ providerEventType: "stdout", message: "Provider 输出无法作为审计事件解析", data: { auditVersion: 2, presentation: "system" } });
        }
        continue;
      }
      diagnostic("provider.stdout", { frame: providerEvent });
      try {
        const normalizedEvents = normalizeEvent(providerEvent);
        for (const normalized of (Array.isArray(normalizedEvents) ? normalizedEvents : [normalizedEvents]).filter(Boolean)) {
          if (providerEvent.type === "thread.started") {
            sessionObserved = true;
            if (session?.resume && providerEvent.thread_id !== session.sessionId) throw new Error("Provider 返回的会话 ID 与当前成员绑定不一致");
          }
          if (providerEvent.type === "system" && providerEvent.subtype === "init" && providerEvent.session_id) {
            sessionObserved = true;
            if (session && providerEvent.session_id !== session.sessionId) stopForWatchdog("Provider 返回的会话 ID 与当前成员绑定不一致");
          }
          const isApiRetry = normalized.providerEventType === "system" && normalized.data?.subtype === "api_retry";
          if (isApiRetry && !apiRetryTimer) {
            apiRetryTimer = setTimeout(() => stopForWatchdog(`Provider API 连续重试超过 ${Math.round(apiRetryTimeoutMs / 1000)} 秒，已释放执行槽位并交由节点自动重试`), apiRetryTimeoutMs);
            apiRetryTimer.unref();
          }
          if (!isApiRetry) {
            clearTimeout(apiRetryTimer);
            apiRetryTimer = null;
            resetIdleWatchdog();
          }
          if (normalized.data?.toolUseId) pendingTools.set(normalized.data.toolUseId, { toolName: normalized.data.toolName });
          if (normalized.data?.toolResultId) {
            const tool = pendingTools.get(normalized.data.toolResultId);
            normalized.data.toolName = tool?.toolName || normalized.data.toolName || "工具返回";
            normalized.data.status ||= "completed";
            pendingTools.delete(normalized.data.toolResultId);
          }
          await onEvent(normalized);
        }
      } catch (error) {
        diagnostic("provider.event_error", { error });
        stopForWatchdog(error.message || "Provider 事件处理失败");
      }
    }
    const exit = await exitTask;
    await stderrTask;
    if (spawnFailure || [126, 127].includes(exit.code)) {
      try { diagnostic("provider.launch_diagnostic", await diagnoseLaunch({ command, cwd, searchPath: env.PATH, provider })); }
      catch (error) { diagnostic("provider.launch_diagnostic_error", { error }); }
    }
    if (cancelled) throw new RuntimeCancelledError(cancellationReason || "Agent 进程已被终止");
    if (spawnFailure) throw spawnFailure;
    if (watchdogError) throw watchdogError;
    if (exit.code !== 0 && session?.resume && !sessionObserved && /(?:^|\n)(?:no conversation found|session (?:not found|does not exist)|could not find (?:a |the )?session)/i.test(stderr)) throw new RuntimeSessionMissingError(`${provider} 未找到指定会话`);
    if (exit.code !== 0 && session && !session.resume && !sessionObserved && stderr.includes(`Session ID ${session.sessionId} is already in use`)) {
      const error = new Error("指定的新会话已存在，需要显式续接"); error.code = "SESSION_ALREADY_EXISTS"; throw error;
    }
    // Codex can write a specific terminal failure to JSONL, then append a generic
    // stdin notice to stderr while exiting non-zero. Prefer the structured reason
    // after preserving the two session-recovery signals above.
    const terminalFailure = getTerminalFailure();
    if (terminalFailure) throw new Error(terminalFailure);
    if (exit.code !== 0) throw new Error(`${provider} exit=${exit.code ?? exit.signal}\n${stderr.trim() || '(stderr empty)'}`);
    const finalText = await getFinal();
    if (!finalText?.trim()) throw new Error(`${provider} 未返回可验证的最终结构化结果`);
    return { finalText };
  } finally {
    stopWatchdogs();
    unregister();
  }
}

async function invokeClaudeCodeCli(input) {
  const { runtime, workspacePath, traceDirectory, finalPath, outputSchema, prompt, runId, onEvent, apiRetryTimeoutMs, idleTimeoutMs } = input;
  const extensions = await selectedExtensions(runtime);
  const connectionEnv = await claudeMarketEnvironment();
  await verifyPaths(runtime.skillPaths, "Claude Code 技能文件");
  await verifyPaths(runtime.pluginPaths, "Claude Code 插件目录");
  await verifyPaths(runtime.mcpConfigPaths, "Claude Code MCP 配置");
  const args = ["--print", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--permission-mode", "bypassPermissions", "--add-dir", traceDirectory];
  if (input.systemPrompt) {
    const instructionsPath = join(traceDirectory, "agentforge-instructions.md");
    await writeFile(instructionsPath, input.systemPrompt, { mode: 0o600 });
    // Environment and invocation mode can change while the native session ID
    // stays the same. Do not retain a stale first-turn system prompt snapshot.
    args.push("--append-system-prompt-file", instructionsPath, "--system-prompt-snapshot", "off");
  }
  if (outputSchema) args.push("--json-schema", JSON.stringify(outputSchema));
  args.push('--strict-mcp-config', '--setting-sources', '', '--settings', '{"disableBundledSkills":true}');
  if (input.session) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.session.sessionId)) throw new Error("Claude Code 会话 ID 必须为 UUID");
    args.push(input.session.resume ? "--resume" : "--session-id", input.session.sessionId);
  }
  if (runtime.model) args.push("--model", runtime.model);
  if (runtime.effort) {
    if (!/^[a-z]{1,20}$/.test(runtime.effort)) throw new Error("思考等级配置无效");
    args.push("--effort", runtime.effort);
  }
  for (const pluginPath of runtime.pluginPaths || []) args.push("--plugin-dir", pluginPath);
  for (const mcpPath of runtime.mcpConfigPaths || []) args.push("--mcp-config", mcpPath);
  if (input.historyMcp) args.push("--mcp-config",input.historyMcp.configPath);
  // --mcp-config/--plugin-dir are variadic; separate the positional prompt.
  args.push("--", prompt);
  let finalText = "", terminalFailure = null;
  return executeJsonl({
    runId, command: runtime.executable || "claude", args, cwd: workspacePath, env: cliEnvironment(runtime.executable || "claude", { ...connectionEnv, ...(input.historyMcp ? { MCP_TIMEOUT: process.env.MCP_TIMEOUT || "120000", MCP_CONNECT_TIMEOUT_MS: process.env.MCP_CONNECT_TIMEOUT_MS || "120000", MCP_CONNECTION_NONBLOCKING: "0", ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || "false" } : {}), AGENTFORGE_TRACE_OUTPUT_DIR: `${traceDirectory}/output` }), provider: "Claude Code", apiRetryTimeoutMs, idleTimeoutMs,
    onEvent, executionKey: input.executionKey, canStart: input.canStart, session: input.session,
    normalizeEvent: (event) => {
      if (event.type === "result" && event.structured_output) finalText = JSON.stringify(event.structured_output);
      else if (event.type === "result" && typeof event.result === "string") finalText = event.result;
      // Claude can emit thousands of character deltas and token counter ticks
      // for one thought or tool argument. Neither is a separately auditable
      // action, and persisting each would delay Run completion after exit.
      if (event.type === "stream_event" && event.event?.type === "content_block_delta") return null;
      if (event.type === "system" && event.subtype === "thinking_tokens") return null;
      if (event.type === "stream_event") return null;
      const normalized = claudeEvent(event, [input.systemPrompt, prompt].filter(Boolean).join("\n"));
      terminalFailure ||= claudeTerminalFailure(event);
      if (event.type === 'system' && event.subtype === 'init') {
        const allowed = new Set([...Object.keys(extensions), ...(input.historyMcp ? ['agentforge_history'] : [])]);
        if ((event.mcp_servers || []).some(server => !allowed.has(server.name))) throw new Error('运行时加载了未选择的 MCP，已停止执行');
        if (Object.keys(extensions).some(name => !event.mcp_servers?.some(server => server.name === name && server.status === 'connected'))) throw new Error('所选 MCP 未就绪，请检查市场配置和本机服务');
        normalized.data.extensionIds = (runtime.extensionManifest || []).map(ref => ref.id);
        normalized.data.selectedMcpCount = Object.keys(extensions).length;
      }
      if (event.type === "system" && event.subtype === "init" && input.historyMcp) {
        const historyServerStatus = event.mcp_servers?.find(server => server.name === "agentforge_history")?.status || "unreported";
        const historyToolsAvailable = (event.tools || []).some(name => name.startsWith("mcp__agentforge_history__"));
        normalized.data.historyServerStatus = historyServerStatus === "connected" ? "connected" : historyServerStatus === "unreported" ? "unreported" : "unavailable";
        normalized.data.historyToolsAvailable = historyToolsAvailable;
        if (historyServerStatus !== "unreported" && historyServerStatus !== "connected") throw new Error("平台历史 MCP 未就绪，保留当前投递重试");
        if (historyServerStatus === "connected" && Array.isArray(event.tools) && !historyToolsAvailable) throw new Error("平台历史 MCP 工具未装载，保留当前投递重试");
      }
      // A message may contain several text/thinking/tool blocks. Preserve all
      // blocks in provider order rather than choosing just the first tool.
      if (["assistant", "user"].includes(event.type) && Array.isArray(event.message?.content)) {
        return event.message.content.filter(block => event.type === "assistant" ? ["text", "thinking", "tool_use"].includes(block.type) : block.type === "tool_result")
          .map(block => claudeEvent({ ...event, message: { content: [block] } }, prompt));
      }
      return normalized;
    },
    getTerminalFailure: () => terminalFailure,
    getFinal: async () => {
      await readFile(finalPath, "utf8").catch(error => { diagnostic("provider.final_file_error", { error }); return null; });
      return finalText;
    }
  }).catch(async (error) => {
    if (error.code !== "SESSION_ALREADY_EXISTS" || input.session?.resume) throw error;
    await onEvent({ providerEventType: "session_recovery", message: "会话已创建但未确认，续接同一会话", data: { auditVersion: 2, sessionId: input.session.sessionId } });
    return runClaudeCodeCli({ ...input, session: { ...input.session, resume: true } });
  });
}

async function invokeCodexCli(input) {
  const { runtime, workspacePath, traceDirectory, schemaPath, finalPath, prompt, runId, onEvent } = input;
  const extensions = await selectedExtensions(runtime);
  await verifyPaths(runtime.skillPaths, "Codex 技能文件");
  const args = runtime.profile ? ["--profile", runtime.profile, "exec"] : ["exec"];
  if (input.systemPrompt) args.push("-c", `developer_instructions=${JSON.stringify(input.systemPrompt)}`);
  args.push(...await codexMarketArgs(runtime, extensions, workspacePath, traceDirectory));
  if (input.historyMcp) {
    const {command,args:commandArgs,env} = input.historyMcp;
    // The bridge owns this small environment. In packaged builds its command
    // is Electron: only the MCP child receives Node mode, never Codex itself.
    const configuration = { command, args: commandArgs, enabled: true, required: true, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [`env.${key}`, value])) };
    for (const [key,value] of Object.entries(configuration)) args.push("-c",`mcp_servers.agentforge_history.${key}=${JSON.stringify(value)}`);
  }
  // Hook trust is a root CLI flag, not an app-server subcommand option.
  const nativeArgs = args.filter(arg => arg !== '--dangerously-bypass-hook-trust');
  nativeArgs[nativeArgs.indexOf('exec')] = 'app-server';
  if (args.includes('--dangerously-bypass-hook-trust')) nativeArgs.unshift('--dangerously-bypass-hook-trust');
  if (input.session?.resume) args.push("resume", input.session.sessionId);
  args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--output-last-message", finalPath);
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (!input.session?.resume) args.push("--add-dir", traceDirectory);
  if (runtime.model) args.push("--model", runtime.model);
  if (runtime.effort) {
    if (!/^[a-z]{1,20}$/.test(runtime.effort)) throw new Error("思考等级配置无效");
    args.push("-c", `model_reasoning_effort=${JSON.stringify(runtime.effort)}`);
  }
  args.push(prompt);
  let finalText = "", terminalFailure = null;
  const toolInputs = new Map();
  const transport = {
    runId, command: runtime.executable || "codex", args, cwd: workspacePath, env: cliEnvironment(runtime.executable || "codex", { AGENTFORGE_TRACE_OUTPUT_DIR: `${traceDirectory}/output` }), provider: "Codex",
    onEvent, executionKey: input.executionKey, canStart: input.canStart, session: input.session, apiRetryTimeoutMs: input.apiRetryTimeoutMs, idleTimeoutMs: input.idleTimeoutMs,
    normalizeEvent(event) {
      if (event.type === "item.updated") return null; // completed items carry the full public body
      if (event.type === "thread.started") {
        const sessionId = sessionIdentifier(event.thread_id);
        if (!sessionId) throw new Error("Provider 返回的会话 ID 无效");
        return { providerEventType: "thread.started", message: "成员会话已连接", data: { auditVersion: 2, presentation: "system", sessionId } };
      }
      const rawFailure = event.type === "turn.failed" || event.type === "error" ? event.error?.message || event.message || "Codex 执行失败" : null;
      if (rawFailure) terminalFailure ||= rawFailure;
      const item = event.item || {}, tool = ["command_execution", "mcp_tool_call", "file_change", "web_search"].includes(item.type), completed = event.type === "item.completed";
      if (completed && item.type === "agent_message") finalText = item.text || "";
      const presentation = tool ? (completed ? "tool_result" : "tool") : item.type === "reasoning" ? "thinking" : rawFailure || terminalFailure ? "error" : "output";
      const providerEventType = publicEventType(event.type, "codex.event");
      let toolInput = item.command ?? item.arguments ?? item.changes ?? item.query ?? item.action;
      if (tool && item.id) {
        const serialized = JSON.stringify(toolInput);
        // A completed item repeats its started arguments. Preserve arguments
        // first revealed/changed at completion, but don't persist a second copy.
        if (completed && toolInputs.get(item.id) === serialized) toolInput = undefined;
        if (completed) toolInputs.delete(item.id);
        else if (serialized !== undefined) toolInputs.set(item.id, serialized);
      }
      return {
        providerEventType,
        message: runtimeMessage({ providerEventType, presentation, failure: rawFailure || (presentation === "error" ? terminalFailure : null) }),
        data: compact({ auditVersion: 2, presentation, toolName: tool ? publicIdentifier(item.tool || item.type) || "本机工具" : null, toolUseId: tool && !completed ? publicIdentifier(item.id) : null, toolResultId: tool && completed ? publicIdentifier(item.id) : null, status: tool ? (item.status === "failed" || (Number.isInteger(item.exit_code) && item.exit_code !== 0) ? "failed" : completed ? "completed" : "running") : undefined }),
        content: executionContent(tool ? { input: toolInput, output: completed ? item.aggregated_output ?? item.result ?? item.error : null } : completed && item.type === "agent_message" ? { text: item.text } : completed && item.type === "reasoning" ? { thinking: item.text } : {}, [input.systemPrompt, prompt].filter(Boolean).join("\n"))
      };
    },
    getTerminalFailure: () => terminalFailure,
    async getFinal() { return (await readFile(finalPath, "utf8").catch(error => { diagnostic("provider.final_file_error", { error }); return ""; })) || finalText; }
  };
  return runtime.skillPaths?.length
    ? runCodexAppServer(input, {args:nativeArgs, normalizeEvent:transport.normalizeEvent, cancelledError:message=>new RuntimeCancelledError(message), missingSessionError:message=>new RuntimeSessionMissingError(message)})
    : executeJsonl(transport);
}

async function loggedInvocation(input, invoke) {
  const secrets = [input.prompt, input.systemPrompt, input.session?.sessionId].filter(Boolean);
  for (const path of input.runtime.mcpConfigPaths || []) {
    try {
      const collect = (value, sensitive = false) => {
        if (typeof value === "string" && sensitive) secrets.push(value);
        else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collect(item, sensitive || /env|headers|password|secret|token|key|authorization/i.test(key));
      };
      collect(JSON.parse(await readFile(path, "utf8")));
    } catch (error) { diagnostic("provider.config_read_error", { error }); }
  }
  return withDiagnosticContext({ executionKey: input.executionKey || input.runId, provider: input.runtime.provider, model: input.runtime.model, traceDirectory: input.traceDirectory }, async () => {
    diagnostic("provider.invocation_started", { command: input.runtime.executable, cwd: input.workspacePath });
    try {
      const result = await invoke(input);
      diagnostic("provider.invocation_completed");
      return result;
    } catch (error) {
      diagnostic("provider.invocation_failed", { error });
      error.message = diagnosticRedactor({ secrets, prompt: [input.systemPrompt, input.prompt].filter(Boolean).join('\n') })(error.message);
      throw error;
    }
  }, { redact: diagnosticRedactor({ secrets, prompt: [input.systemPrompt, input.prompt].filter(Boolean).join("\n") }) });
}

export function runClaudeCodeCli(input) { return loggedInvocation(input, invokeClaudeCodeCli); }
export function runCodexCli(input) { return loggedInvocation(input, invokeCodexCli); }
