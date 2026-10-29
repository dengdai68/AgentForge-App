const active = new Map();

export function registerExecution(runId, execution) {
  if (active.has(runId)) throw new Error("该 Run 已有本地 Agent 进程在执行");
  active.set(runId, execution);
  return () => active.delete(runId);
}

export function terminateExecution(runId, reason = "用户终止") {
  const execution = active.get(runId);
  if (!execution) return false;
  execution.terminate(reason);
  return true;
}

export function hasActiveExecution(runId) {
  return active.has(runId);
}
