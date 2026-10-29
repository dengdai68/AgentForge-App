import { join, resolve } from "node:path";
import { withHistoryTools } from "./history/bridge.mjs";
import { desktopServiceDataRoot } from "./data-home.mjs";
import { createRunFiles } from "./run-files.mjs";
import { runClaudeCodeCli, runCodexCli, promptSnapshot, RuntimeCancelledError, RuntimeSessionMissingError, runtimeFailureDetail, retryableRuntimeFailure, separateRuntimeSession } from "./runtime/local-cli.mjs";
import { diagnostic, withDiagnosticContext } from "./diagnostics.mjs";
import { terminateExecution } from "./runtime/registry.mjs";
import { taskPrompt } from "./prompts.mjs";

// Interpret coordination fields without accepting/rejecting the employee's work.
// Plain text and extra report fields are kept as ordinary handoff content.
export function readNodeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = { summary: String(value ?? "") };
  const output = { ...value, kind: "node_result", summary: typeof value.summary === "string" ? value.summary : JSON.stringify(value) };
  for (const field of ["artifacts", "decisions", "defects", "resolvesDefectIds", "verifiedDefectIds"]) output[field] = Array.isArray(value[field]) ? value[field] : [];
  output.consultation = value.consultation && typeof value.consultation === "object" ? value.consultation : null;
  output.managerDecision = value.managerDecision && typeof value.managerDecision === "object" ? value.managerDecision : null;
  output.deliveryReview = value.deliveryReview && typeof value.deliveryReview === "object" ? value.deliveryReview : null;
  return output;
}
export function parseEmployeeResponse(value) {
  const raw = String(value ?? "").trim();
  const candidates = [raw, ...Array.from(raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi), match => match[1])];
  for (const candidate of candidates) {
    try { return readNodeResult({ ...JSON.parse(candidate), rawResponse: raw }); }
    catch { /* Ordinary text remains a valid employee handoff. */ }
  }
  // CLI text may put one coordination envelope after a natural-language
  // preface. Parse balanced JSON, not a greedy brace regex (strings may contain
  // braces/escaped quotes). Multiple objects or trailing prose stay plain text.
  const objects = [];
  let depth = 0, start = -1, quoted = false, escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (depth && quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (depth && char === '"') quoted = true;
    else if (char === "{") { if (!depth) start = index; depth++; }
    else if (char === "}" && depth && --depth === 0) {
      try { objects.push({ value: JSON.parse(raw.slice(start, index + 1)), start, end: index + 1 }); } catch { /* Not an envelope. */ }
    }
  }
  if (objects.length === 1) {
    const item = objects[0];
    if (!raw.slice(item.end).trim() && /(?:^|\n)\s*$/.test(raw.slice(0, item.start)) &&
        ["managerDecision", "consultation", "deliveryReview"].some(key => item.value[key] && typeof item.value[key] === "object")) {
      return readNodeResult({ ...item.value, rawResponse: raw });
    }
  }
  return readNodeResult({ summary: raw });
}
function nodeInfo(task, nodeId) { return task.workflowSnapshot.nodes.find((node) => node.id === nodeId); }
async function provider(input) { if (input.runtime.provider === "codex") return runCodexCli(input); if (input.runtime.provider !== "claude-code") throw new Error(`不支持的真实运行时：${input.runtime.provider}`); return runClaudeCodeCli(input); }

// Keep redacted original wording separate from automatic retry eligibility.
class RuntimeInvocationError extends Error {
  constructor(error, input) {
    super(runtimeFailureDetail(error, [input.systemPrompt, input.prompt].filter(Boolean).join('\n')));
    this.name = "RuntimeInvocationError";
    this.retryable = retryableRuntimeFailure(error);
    this.code = error?.code;
  }
}
export function failureKindOf(error) {
  if (error instanceof RuntimeInvocationError) return "provider";
  if (error instanceof RuntimeSessionMissingError) return "session";
  return "execution";
}
export function failureSignature(kind, message) {
  const line = String(message || "").split("\n")[0].slice(0, 240);
  return `${kind}:${line.replace(/(?:\/[\w.@+-]+)+\/?/g, "<path>").replace(/\b[a-z]+_[a-z0-9]+_[a-z0-9]+\b/gi, "<id>").replace(/\b[0-9a-f]{8,64}\b/gi, "<hex>").replace(/\d+/g, "<n>")}`;
}
async function invokeRuntime(store, agent, input, files) {
  try {
    return await withDiagnosticContext({ traceId: input.traceId }, () => withHistoryTools(store, agent, input, provider, files));
  } catch (error) {
    if (error instanceof RuntimeCancelledError || error instanceof RuntimeSessionMissingError) throw error;
    diagnostic("task.runtime_error", { error });
    throw new RuntimeInvocationError(error, input);
  }
}
function traceFailureSummary(error) {
  if (error instanceof RuntimeInvocationError || error instanceof RuntimeSessionMissingError || error instanceof RuntimeCancelledError) return error.message || "本机执行未完成。";
  return error?.message || "本次执行未完成，已保留投递重试。";
}
async function capture(files, runId, traceId, workspacePath, before, output, node, purpose) {
  await files.writeInternalTraceFile(runId, traceId, "accepted-node-result.json", JSON.stringify(output, null, 2));
  let changed;
  try { changed = await files.captureWorkspaceChanges({ runId, traceId, workspacePath, before }); }
  catch (error) {
    diagnostic("task.artifact_recording_failed", { error, traceId });
    return [];
  }
  return changed.artifacts;
}

function acceptedWorkspaceBaseline(initial, artifacts) {
  const entries = new Map(initial);
  for (const artifact of artifacts) {
    if (!artifact.name) continue;
    if (artifact.deleted) entries.delete(artifact.name);
    else entries.set(artifact.name, { hash: artifact.sha256, bytes: artifact.bytes });
  }
  Object.defineProperty(entries, "restrictedEntries", { value: initial.restrictedEntries });
  return entries;
}

function managerDispatch(store, runId, dedupeKey, messageIds = []) {
  const run = store.getRun(runId), task = store.getRunTask(runId);
  return store.enqueueDispatch(runId, { recipientAgentId: run.manager.id, workflowNodeId: task.workflowSnapshot.nodes[0].id, purpose: "manager", dedupeKey, messageIds });
}

// Queue ordering for concurrent coordination messages. A redispatch is the
// deferred-decision re-evaluation itself: it must never block the handoff it
// exists to revisit, or the deferral would be self-sustaining.
export function dispatchBlocksHandoff(item, now = Date.now()) {
  if (["done", "cancelled"].includes(item.status)) return false;
  if (typeof item.dedupeKey === "string" && item.dedupeKey.startsWith("redispatch:")) return false;
  return !(item.status === "queued" && item.lastError && item.nextRetryAt && Date.parse(item.nextRetryAt) > now);
}

// Post-decision scheduling for an accepted managerDecision. Returns what was
// scheduled ("blocked" when the decision must wait). Never rewrites or cancels
// failed dispatches, frozen history or older deliveries.
export function scheduleManagerFollowup(store, runId, delivery, decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).some(key => !['nextNodeId', 'nextAgentId', 'rationale'].includes(key))) {
    throw new Error('managerDecision 仅接受 nextNodeId、nextAgentId、rationale；咨询必须使用顶层 consultation，不能嵌入 managerDecision');
  }
  const run = store.getRun(runId), task = store.getRunTask(runId);
  const next = decision.nextNodeId;
  if (next !== null) {
    // Non-terminal handoff: real pending work keeps priority; a failed
    // dispatch in retry backoff never blocks it.
    if (store.listDispatches(runId).some((item) => dispatchBlocksHandoff(item))) {
      // A deferred decision must never be dropped silently: record the fact
      // and queue a manager re-evaluation behind the pending work.
      const note = store.addMessage({ runId, traceId: delivery.traceIds?.at(-1) || null, sender: { type: "system", id: "agentforge", name: "AgentForge" }, recipientAgentId: run.manager.id, kind: "coordination_notice", content: `上一项安排（节点 ${decision.nextNodeId} → 成员 ${decision.nextAgentId}）因当时仍有未结束投递而暂未建立派工；请在当前队列清空后基于最新状态重新决定下一步，不要假设该安排已执行。` });
      managerDispatch(store, runId, "redispatch:" + delivery.id, [note.id]);
      return { scheduled: "blocked", requeued: true };
    }
    const recipientId = decision.nextAgentId;
    store.setCurrentFocus(runId, next, decision.rationale || "项目经理安排下一次协作");
    store.enqueueDispatch(runId, { recipientAgentId: recipientId, workflowNodeId: next, purpose: "node", dedupeKey: "handoff:" + delivery.id });
    return { scheduled: "handoff" };
  }
  store.requestHumanAcceptance(runId, { traceId: delivery.traceIds?.at(-1) || null, summary: decision.rationale || "项目经理已提交人类验收。" });
  return { scheduled: "acceptance" };
}

function acceptDelivery(store, delivery, trace, output, artifacts) {
  const runId = delivery.runId, run = store.getRun(runId);
  if (!store.canExecuteDispatch(delivery.id)) throw new RuntimeCancelledError("当前投递已停止");
  const agent = store.getRunAgent(runId, delivery.recipientAgentId);
  const sender = { type: "agent", id: agent.id, name: agent.name };
  store.acceptNodeResult(runId, delivery.workflowNodeId, trace.id, output, artifacts);
  const content = output.summary || "本轮工作已返回。";
  if (output.consultation) {
    try {
      store.askQuestion(delivery.id, output.consultation, trace.id);
      store.completeTrace(trace.id);
      return;
    } catch (error) {
      store.addMessage({ runId, traceId: trace.id, sender: { type: "system", id: "agentforge", name: "AgentForge" }, recipientAgentId: run.manager.id, kind: "coordination_notice", content: `消息未能投递：${error.message}。员工原文：${content}` });
    }
  }
  if (delivery.purpose === "inquiry") {
    store.addMessage({ runId, traceId: trace.id, sender, recipientHuman: true, replyToMessageId: delivery.messageIds[0], kind: "inquiry_answer", content });
  } else if (delivery.purpose === "consultation" && !output.consultation) {
    const parent = store.getDispatch(delivery.parentDispatchId);
    store.answerQuestion(runId, parent.waitingMessageId, content, sender, trace.id);
  } else {
    store.addMessage({ runId, workflowNodeId: delivery.workflowNodeId, traceId: trace.id, sender, kind: ["manager", "delivery_review"].includes(delivery.purpose) ? "manager_decision" : "handoff", content });
  }
  store.completeTrace(trace.id); store.completeDispatch(delivery.id);
  if (["manager", "delivery_review"].includes(delivery.purpose)) {
    if (output.deliveryReview) store.recordDeliveryReview(runId, trace.id, output.deliveryReview);
    const decision = output.managerDecision || (output.deliveryReview?.verdict === "pass" ? { nextNodeId: null, rationale: content } : null);
    if (decision && Object.hasOwn(decision, "nextNodeId")) {
      try { scheduleManagerFollowup(store, runId, { ...delivery, traceIds: [trace.id] }, decision); }
      catch (error) {
        const note = store.addMessage({ runId, traceId: trace.id, sender: { type: "system", id: "agentforge", name: "AgentForge" }, recipientAgentId: run.manager.id, kind: "coordination_notice", content: `派发未能送达：${error.message}。请指定下一位接收成员与节点。` });
        managerDispatch(store, runId, "routing:" + delivery.id, [note.id]);
      }
    } else if (output.deliveryReview?.verdict === "rework" || output.consultation) {
      managerDispatch(store, runId, "followup:" + delivery.id);
    }
  } else if (!["consultation", "inquiry"].includes(delivery.purpose) || output.consultation) {
    store.addEvent({ type: "trace.accepted", runId, actor: sender, message: "已记录员工交接。", data: { traceId: trace.id, workflowNodeId: delivery.workflowNodeId, artifactCount: artifacts.length } });
    managerDispatch(store, runId, "delivery:" + delivery.id);
  }
  store.syncWaiting(runId);
}

async function invokeDispatch(store, files, delivery, runBaseline) {
  const runId = delivery.runId, run = store.getRun(runId), task = store.getRunTask(runId);
  const agent = store.getRunAgent(runId, delivery.recipientAgentId), node = nodeInfo(task, delivery.workflowNodeId);
  const trace = store.createTrace(runId, { workflowNodeId: node.id, agentId: agent.id, type: delivery.purpose });
  store.attachDispatchTrace(delivery.id, trace.id);
  try {
    const directory = await files.prepareTrace(runId, trace.id);
    const finalPath = await files.writeInternalTraceFile(runId, trace.id, "provider-final.json", "");
    const workspace = store.getRunWorkspace(runId);
    const before = ["node", "instruction"].includes(delivery.purpose)
      ? acceptedWorkspaceBaseline(runBaseline, workspace.artifacts)
      : await files.snapshotWorkspace(task.workspacePath, { excludeRunFiles: true }).catch(() => new Map());
    // Only explicit inbox/chain messages or this responsibility's handoffs are
    // shared. Other members' private model context is never forwarded.
    const roster = run.participants.map(({ id, type, name, kind, description, capabilities }) => ({ id, type, name, kind, description, capabilities }));
    // A member keeps one cwd/session even when answering another node's question.
    const cwd = task.repositoryMode === "agent" ? (task.repositoryBindings[agent.id] ? resolve(task.workspacePath, task.repositoryBindings[agent.id].path) : task.workspacePath) : task.workspacePath;
    const session = store.prepareMemberSession(delivery.id, trace.id, cwd);
    const messages = store.memberInputMessages(delivery.id);
    const inputThroughMessageId = store.getRunWorkspace(runId).messages.at(-1)?.id || null;
    let input, inputAcknowledged = false;
    const acknowledgeInput = () => {
      if (!inputAcknowledged) {
        store.confirmMemberInput(trace.id, inputThroughMessageId, input.inputContext, messages.map(item => item.id));
        inputAcknowledged = true;
      }
    };
    const onEvent = async (event) => {
      const { sessionId, auditEvent, content } = separateRuntimeSession(event);
      // Init/thread-connected is not proof of input consumption. New model
      // content/tool activity is; preserve this receipt even if the turn fails.
      if (content && ['text', 'thinking', 'input', 'output'].some(key => content.fields?.[key]?.text)) acknowledgeInput();
      if (content) auditEvent.data.contentRef = await files.writeConsoleContent(runId, trace.id, content);
      if (agent.runtime.provider === "codex" && auditEvent.providerEventType === "thread.started" && sessionId) store.bindProviderSession(trace.id, sessionId);
      await files.appendTrace(runId, trace.id, { occurredAt: new Date().toISOString(), runId, traceId: trace.id, workflowNodeId: node.id, agentId: agent.id, provider: agent.runtime.provider, type: auditEvent.providerEventType, message: auditEvent.message, data: auditEvent.data });
      store.addEvent({ type: "runtime.event", runId, actor: { type: "agent", id: agent.id, name: agent.name }, message: auditEvent.providerEventType + ": " + (auditEvent.message || "收到运行时事件"), data: { traceId: trace.id, workflowNodeId: node.id, providerEventType: auditEvent.providerEventType, ...auditEvent.data } });
    };
    const effectiveNode = delivery.purpose === "node" && task.repositoryMode === "agent" ? { ...node, repositoryPath: task.repositoryBindings?.[agent.id]?.path || null } : node;
    input = taskPrompt({ task, run, node: effectiveNode, trace, agent, directory, cwd, workspace, messages, roster, mode: delivery.purpose, delivery, session });
    const onPrompt = async value => {
      try { store.attachTracePrompt(trace.id, await files.writePromptSnapshot(runId, trace.id, promptSnapshot(value))); }
      catch (error) { diagnostic("task.prompt_snapshot_failed", { error, runId, traceId: trace.id }); }
    };
    // The runtime returns text; coordination fields are interpreted when present.
    const runtimeResult = await invokeRuntime(store, agent, { ...input, onPrompt, traceId: trace.id, session, canStart: () => store.canExecuteDispatch(delivery.id), runtime: agent.runtime, workspacePath: cwd, traceDirectory: directory, finalPath, runId, onEvent }, files);
    const output = parseEmployeeResponse(runtimeResult.finalText);
    const artifacts = await capture(files, runId, trace.id, task.workspacePath, before, output, effectiveNode, delivery.purpose);
    store.transaction(() => { acceptDelivery(store, delivery, trace, output, artifacts); acknowledgeInput(); });
  } catch (error) {
    const cancelled = error instanceof RuntimeCancelledError;
    diagnostic("task.dispatch_failed", { error, traceId: trace.id, agentId: agent.id, workflowNodeId: node.id });
    const failure = traceFailureSummary(error);
    store.completeTrace(trace.id, { status: cancelled ? "cancelled" : "failed", error: failure });
    if (error instanceof RuntimeSessionMissingError) store.resetMemberSession(trace.id, failure);
    const kind = cancelled ? null : failureKindOf(error);
    const immediate = error instanceof RuntimeSessionMissingError || ["paused", "cancelled"].includes(store.getRun(runId).status);
    const failureFact = kind ? { kind, signature: failureSignature(kind, failure) } : null;
    if (failureFact) failureFact.streak = delivery.lastErrorSignature === failureFact.signature ? (delivery.errorStreak || 1) + 1 : 1;
    const retrySession = error instanceof RuntimeSessionMissingError && delivery.lastErrorKind !== 'session';
    const retryTransient = error instanceof RuntimeInvocationError && error.retryable && delivery.attempts < 3;
    if (cancelled || immediate && !(error instanceof RuntimeSessionMissingError) || retrySession || retryTransient) {
      store.retryDispatch(delivery.id, failure, immediate ? 0 : 300000, failureFact);
    } else {
      store.stopFailedDispatch(delivery.id, failure, failureFact);
    }
    store.addEvent({ type: cancelled ? "trace.cancelled" : "trace.failed", runId, actor: { type: "agent", id: agent.id, name: agent.name }, message: (cancelled ? "Trace 已停止：" : "Trace 未完成：") + failure, data: { traceId: trace.id, dispatchId: delivery.id, workflowNodeId: node.id, ...(cancelled ? {} : { auditVersion: 2, failureKind: kind }) } });
    if (store.getRun(runId).status === "cancelled" && !delivery.interactionOnly) throw error;
  }
}

// In-process guard complements the persisted single-claim invariant. No polling
// may create a second invocation while file preparation is still in progress.
const executions = new WeakMap();
export function executeRun(store, runId, options = {}) {
  let active = executions.get(store); if (!active) { active = new Map(); executions.set(store, active); }
  if (active.has(runId)) return active.get(runId);
  const promise = withDiagnosticContext({ source: "task", runId }, () => drainRun(store, runId, options)).finally(() => active.delete(runId));
  active.set(runId, promise); return promise;
}
async function drainRun(store, runId, { runFilesRoot = process.env.AGENTFORGE_RUN_FILES_ROOT || join(desktopServiceDataRoot(), "agentforge-runs"), resolveGitCredential = null } = {}) {
  const files = createRunFiles({ root: runFilesRoot, resolveGitCredential });
  try {
    let run = store.getRun(runId);
    if (!store.getRunRecoveryPlan(runId).shouldExecute) return;
    try {
      await files.prepareRun(runId);
      await files.prepareRunWorkspace(store.getRunTask(runId));
    } catch (error) {
      diagnostic("task.workspace_failed", { error, runId });
      const current = store.getRun(runId);
      if (["planning", "running", "review"].includes(current.status)) {
        store.failRun(runId, "运行文件或冻结仓库尚未准备好。请核对仓库来源、基线和本机文件权限后重试。");
      }
      return;
    }
    const workspace = store.getRunWorkspace(runId);
    let runBaseline;
    try {
      runBaseline = await files.loadOrCreateWorkspaceBaseline(runId, store.getRunTask(runId).workspacePath, { allowCreate: workspace.traces.length === 0 });
    } catch (error) {
      diagnostic("task.workspace_baseline_failed", { error, runId });
      runBaseline = await files.snapshotWorkspace(store.getRunTask(runId).workspacePath, { excludeRunFiles: true }).catch(() => new Map());
    }
    store.initializeDispatches(runId);
    run = store.getRun(runId);
    if (run.status === "planning") { store.updateRun(runId, { status: "running" }); store.setTaskStatus(run.taskId, "running"); }
    for (let turn = 0; turn < 80; turn += 1) {
      store.syncWaiting(runId);
      run = store.getRun(runId);
      if (store.getRunTask(runId).archivedAt) return;
      const delivery = store.claimDispatch(runId);
      if (!delivery) return;
      await withDiagnosticContext({ source: "task", runId, taskId: run.taskId, dispatchId: delivery.id, workflowNodeId: delivery.workflowNodeId, agentId: delivery.recipientAgentId, attempt: delivery.attempts }, async () => {
        diagnostic("task.dispatch_started");
        await invokeDispatch(store, files, delivery, runBaseline);
        diagnostic("task.dispatch_settled");
      });
    }
    store.addEvent({ type: "run.manager_patrol_queued", runId, message: "本轮投递达到上限，剩余队列由巡检继续。", data: {} });
  } catch (error) {
    if (store.getRun(runId).status === "cancelled") throw error;
    diagnostic("task.orchestration_error", { runId, error });
    store.addEvent({ type: "run.manager_patrol_queued", runId, message: "编排未完成，保留队列等待巡检。", data: { auditVersion: 2, error: traceFailureSummary(error) } });
  }
}
export function requestHumanIntervention(store, runId, messageId) {
  const message = store.getRunWorkspace(runId).messages.find((item) => item.id === messageId);
  if (!message) throw new Error("人工消息不存在");
  const run = store.getRun(runId), task = store.getRunTask(runId), recipientId = message.recipient.type === "agent" ? message.recipient.id : run.manager.id;
  const ownNode = store.memberResponsibility(runId, recipientId);
  // Same rule as submitHumanMessage: without an assigned node there is no
  // fabricated nodes[0] binding — the manager picks the message up for formal
  // dispatch (managerDecision chooses node + member). A manager recipient is
  // bound as a manager-purpose dispatch on the conventional first node:
  // manager deliveries open no Artifact boundary, so there is no mismatch and
  // node resolution must never throw.
  if (recipientId !== run.manager.id && !ownNode) {
    store.enqueueDispatch(runId, { recipientAgentId: run.manager.id, workflowNodeId: task.workflowSnapshot.nodes[0].id, purpose: "manager", messageIds: [messageId], dedupeKey: "message:" + messageId });
    return store.getRun(runId);
  }
  store.enqueueDispatch(runId, { recipientAgentId: recipientId, workflowNodeId: ownNode || task.workflowSnapshot.nodes[0].id, purpose: recipientId === run.manager.id ? "manager" : "instruction", messageIds: [messageId], dedupeKey: "message:" + messageId });
  return store.getRun(runId);
}
export function terminateRun(store, runId, reason) {
  if (["completed", "cancelled", "failed"].includes(store.getRun(runId).status)) return stopInquiries(store, runId);
  const run = store.cancelRun(runId, reason); terminateExecution(runId, reason); return run;
}
export function stopInquiries(store, runId) {
  const executing = store.listDispatches(runId).some((item) => item.interactionOnly && item.status === "claimed");
  store.cancelInquiries(runId);
  if (executing) terminateExecution(runId, "用户停止答疑");
  return store.getRun(runId);
}
export function pauseRun(store, runId, reason) { const run = store.pauseRun(runId, reason); store.cancelInquiries(runId); terminateExecution(runId, reason); return run; }
export function resumeRun(store, runId) { return store.resumeRun(runId); }
