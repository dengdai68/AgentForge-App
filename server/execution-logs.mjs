import { runtimeFailureSummary } from "./runtime/local-cli.mjs";

// Read-only diagnostics: deliberately never copy arbitrary event data/content.
export function executionLogs(state, { source = "all", level = "all", before = null, limit = 100 } = {}) {
  if (!["all", "task", "private", "group"].includes(source) || !["all", "error"].includes(level)) throw new Error("日志筛选无效");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("分页大小必须为 1–200");
  const runs = new Map(state.runs.map(row => [row.id, row]));
  const tasks = new Map(state.tasks.map(row => [row.id, row]));
  const conversations = new Map(state.communicationConversations.map(row => [row.id, row]));
  const deliveries = new Map(state.communicationDeliveries.map(row => [row.id, row]));
  const labels = { started: "开始执行", completed: "回复已保存", failed: "执行失败", retry: "请求重试", recovered: "重启后恢复", cancelled: "已取消", session_reset: "重建成员会话", handoff_queued: "成员转交已入队" };
  const rows = [];
  const append = (event, context) => {
    const data = event.data || {}, type = event.type;
    const failed = /(?:^|\.)failed$/.test(type) || data.presentation === "error" || data.status === "failed";
    const rowLevel = failed ? "error" : "info";
    if ((source !== "all" && source !== context.source) || (level !== "all" && level !== rowLevel)) return;
    const runtime = type === "runtime.event" || (context.source !== "task" && !labels[type]);
    const failure = runtimeFailureSummary(event.message || event.content);
    let message = failed
      ? data.phase === "workspace_preparation" ? "工作目录或仓库准备失败；请检查仓库来源、基线与本机权限。" : data.status === "failed" ? "工具执行失败；失败工具不等于整个任务失败。" : failure === "Provider 执行失败，请稍后重试。" ? "执行未完成；请检查关联执行及运行配置，历史记录不代表当前状态。" : failure
      : runtime ? (data.auditVersion === 2 ? ({ tool: "工具调用", tool_result: "工具返回", thinking: "公开思考进展", assistant: "模型回复进展", system: "运行时进展", output: "返回结果" }[data.presentation] || "运行时进展") : "历史运行摘要（原始内容已隐藏）")
        : labels[type] || ({ "trace.started": "开始执行", "trace.completed": "执行已接纳", "trace.cancelled": "执行已停止", "run.completed": "人类已确认完成", "dispatch.retry_scheduled": "已安排重试", "run.recovered": "重启后恢复", "run.failed": "运行失败" }[type] || "任务状态更新");
    const toolName = data.auditVersion === 2 && /^[A-Za-z0-9_.:-]{1,200}$/.test(data.toolName || "") ? data.toolName : null;
    if (toolName) message += ` · ${toolName} · ${{running: "进行中", completed: "已完成", failed: "失败"}[data.status] || "已记录"}`;
    rows.push({ id: event.id, timestamp: event.timestamp || event.createdAt, type, level: rowLevel, message, ...context,
      toolName,
      toolStatus: data.auditVersion === 2 && ["running", "completed", "failed"].includes(data.status) ? data.status : null,
      traceId: typeof data.traceId === "string" ? data.traceId : null });
  };
  for (const event of state.events) {
    if (!event.runId) continue;
    const run = runs.get(event.runId);
    append(event, { source: "task", runId: event.runId, taskId: run?.taskId || null, name: tasks.get(run?.taskId)?.title || "任务", agentId: event.actor?.id || null, conversationId: null, deliveryId: null, currentStatus: run?.status || null });
  }
  for (const event of state.communicationEvents) {
    const thread = conversations.get(event.conversationId), delivery = deliveries.get(event.deliveryId);
    if (!thread) continue;
    append(event, { source: thread.kind === "team" ? "group" : "private", runId: null, taskId: null, name: thread.name, agentId: event.agentId, conversationId: thread.id, deliveryId: event.deliveryId, attempt: event.attempt, currentStatus: delivery?.status || null, nextAttemptAt: delivery?.nextAttemptAt || null });
  }
  rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
  const start = before ? rows.findIndex(row => row.id === before) + 1 : 0;
  if (before && !start) throw new Error("日志游标不存在，请刷新最新记录");
  const items = rows.slice(start, start + limit);
  return { items, hasMore: start + limit < rows.length, nextBefore: items.at(-1)?.id || null };
}
