import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createCatalogFixtureStore as createStore } from "./fixture-store.mjs";
import { executeRun } from "../server/orchestrator.mjs";

async function fixture(t, persistent = false) {
  await mkdir(resolve(".data"), { recursive: true });
  const root = await mkdtemp(resolve(".data/run-recovery-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = persistent ? join(root, "state.sqlite") : ":memory:";
  const store = createStore({ databasePath, workspaceRoot: join(root, "workspaces") });
  const task = store.createTask({ title: "Recovery fixture", objective: "Do not invoke a Provider", teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery" });
  const run = store.createRun(task.id);
  return { root, databasePath, store, task, run };
}

function startTrace(store, run, delivery) {
  const trace = store.createTrace(run.id, { agentId: delivery.recipientAgentId, workflowNodeId: delivery.workflowNodeId, type: delivery.purpose });
  store.attachDispatchTrace(delivery.id, trace.id);
  return trace;
}

test("paused startup without inquiries is a read-only no-op before file preparation", async (t) => {
  const { store, run, root } = await fixture(t);
  store.pauseRun(run.id);
  const before = store.getRunWorkspace(run.id);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(store.getRunRecoveryPlan(run.id), { shouldExecute: false, interruptedTraceIds: [], recoveredDispatchIds: [] });
    store.recoverInterruptedRun(run.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
  }
  assert.deepEqual(store.getRunWorkspace(run.id), before);
  await assert.rejects(access(run.workspacePath), { code: "ENOENT" });
  await assert.rejects(access(join(root, "run-files")), { code: "ENOENT" });
});

test("paused claimed inquiry recovers across SQLite restart without claiming business work", async (t) => {
  const { store, databasePath, run } = await fixture(t, true);
  store.initializeDispatches(run.id);
  const business = store.listDispatches(run.id)[0];
  store.pauseRun(run.id);
  const sent = store.submitHumanMessage(run.id, { content: "Read-only inquiry after pause", recipientAgentId: run.manager.id });
  const inquiry = store.claimDispatch(run.id);
  assert.equal(inquiry.interactionOnly, true);
  const trace = startTrace(store, run, inquiry);
  const restored = createStore({ databasePath });
  assert.equal(restored.getRunRecoveryPlan(run.id).shouldExecute, true);
  const result = restored.recoverInterruptedRun(run.id);
  assert.deepEqual(result.interruptedTraceIds, [trace.id]);
  assert.deepEqual(result.recoveredDispatchIds, [inquiry.id]);
  const after = restored.getRunWorkspace(run.id);
  restored.recoverInterruptedRun(run.id);
  assert.deepEqual(restored.getRunWorkspace(run.id), after);
  const retry = restored.claimDispatch(run.id);
  assert.equal(retry.id, inquiry.id);
  assert.equal(retry.attempts, 2);
  assert.deepEqual(retry.messageIds, [sent.message.id]);
  assert.equal(restored.getDispatch(business.id).status, "queued");
  restored.completeDispatch(retry.id);
  assert.equal(restored.claimDispatch(run.id), null);
  assert.equal(restored.getRunRecoveryPlan(run.id).shouldExecute, false);
  assert.equal(restored.getRun(run.id).status, "paused");
  const event = after.events.find((item) => item.type === "run.recovered");
  assert.equal(event.data.status, "paused");
  assert.match(event.message, /保持暂停/);
});

test("active crash recovery is atomic, retryable after persistence failure and idempotent", async (t) => {
  const { store, databasePath, run } = await fixture(t, true);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.initializeDispatches(run.id);
  const delivery = store.claimDispatch(run.id), trace = startTrace(store, run, delivery);
  const restored = createStore({ databasePath });
  const database = new DatabaseSync(databasePath);
  t.after(() => database.close());
  const before = restored.getRunWorkspace(run.id);
  database.exec("CREATE TRIGGER reject_recovery BEFORE UPDATE ON workspace_snapshots BEGIN SELECT RAISE(ABORT,'recovery rollback'); END");
  assert.throws(() => restored.recoverInterruptedRun(run.id), /recovery rollback/);
  assert.deepEqual(restored.getRunWorkspace(run.id), before);
  database.exec("DROP TRIGGER reject_recovery");
  const recovery = restored.recoverInterruptedRun(run.id);
  assert.deepEqual(recovery.interruptedTraceIds, [trace.id]);
  assert.equal(restored.getRunWorkspace(run.id).traces[0].status, "failed");
  const after = restored.getRunWorkspace(run.id);
  restored.recoverInterruptedRun(run.id);
  assert.deepEqual(restored.getRunWorkspace(run.id), after);
  const retry = restored.claimDispatch(run.id);
  assert.equal(retry.id, delivery.id);
  assert.equal(retry.attempts, 2);
  assert.equal(restored.getRun(run.id).status, "running");
});

test("interrupted business work stays parked when recovered while paused", async (t) => {
  const { store, run } = await fixture(t);
  store.initializeDispatches(run.id);
  const delivery = store.claimDispatch(run.id), trace = startTrace(store, run, delivery);
  store.pauseRun(run.id);
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, false);
  store.recoverInterruptedRun(run.id);
  assert.equal(store.getDispatch(delivery.id).status, "queued");
  assert.equal(store.getRunWorkspace(run.id).traces.find((item) => item.id === trace.id).status, "failed");
  assert.equal(store.claimDispatch(run.id), null);
  assert.equal(store.getRun(run.id).status, "paused");
  store.resumeRun(run.id);
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, true);
  assert.equal(store.claimDispatch(run.id).id, delivery.id);
});

test("waiting for a human and stopped Runs do not prepare files on empty scheduling", async (t) => {
  const { store, run, root } = await fixture(t);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.updateRun(run.id, { status: "awaiting_human" }); store.setTaskStatus(run.taskId, "awaiting_human");
  for (const status of ["awaiting_human", "cancelled"]) {
    if (status === "cancelled") { store.updateRun(run.id, { status }); store.setTaskStatus(run.taskId, status); }
    const before = store.getRunWorkspace(run.id);
    assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, false);
    store.recoverInterruptedRun(run.id);
    await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
    assert.deepEqual(store.getRunWorkspace(run.id), before);
  }
  await assert.rejects(access(run.workspacePath), { code: "ENOENT" });
});

test("terminal inquiry recovery leaves unrelated stale business Traces unchanged", async (t) => {
  const { store, run } = await fixture(t);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.initializeDispatches(run.id);
  const business = store.claimDispatch(run.id), staleTrace = startTrace(store, run, business);
  store.completeDispatch(business.id);
  store.updateRun(run.id, { status: "failed" }); store.setTaskStatus(run.taskId, "blocked");
  store.submitHumanMessage(run.id, { content: "Explain the preserved evidence without restarting work", recipientAgentId: run.manager.id });
  const inquiry = store.claimDispatch(run.id), inquiryTrace = startTrace(store, run, inquiry);
  const recovery = store.recoverInterruptedRun(run.id);
  assert.deepEqual(recovery.interruptedTraceIds, [inquiryTrace.id]);
  assert.deepEqual(recovery.recoveredDispatchIds, [inquiry.id]);
  assert.equal(store.getRunWorkspace(run.id).traces.find((item) => item.id === staleTrace.id).status, "running");
  assert.equal(store.claimDispatch(run.id).id, inquiry.id);
  assert.equal(store.getRun(run.id).status, "failed");
});

test("paused inquiries in backoff do not prepare files before their retry time", async (t) => {
  const { store, run, root } = await fixture(t);
  store.pauseRun(run.id);
  store.submitHumanMessage(run.id, { content: "Read-only question", recipientAgentId: run.manager.id });
  const inquiry = store.claimDispatch(run.id);
  store.retryDispatch(inquiry.id, "temporary failure", 300000);
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, false);
  const before = store.getRunWorkspace(run.id);
  await executeRun(store, run.id, { runFilesRoot: join(root, "run-files") });
  assert.deepEqual(store.getRunWorkspace(run.id), before);
  await assert.rejects(access(run.workspacePath), { code: "ENOENT" });
  store.retryScheduledDispatches(run.id);
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, true);
});

test("active empty work and answered human waits retain established scheduling semantics", async (t) => {
  const { store, run } = await fixture(t);
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, true);
  store.initializeDispatches(run.id);
  const queued = store.listDispatches(run.id)[0];
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  store.updateRun(run.id, { status: "awaiting_human" }); store.setTaskStatus(run.taskId, "awaiting_human");
  assert.equal(store.claimDispatch(run.id), null);
  // Existing syncWaiting treats a queued continuation as an answered wait;
  // drainRun calls it before claiming, unlike a paused business queue.
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, true);
  store.syncWaiting(run.id);
  assert.equal(store.getRun(run.id).status, "running");
  assert.equal(store.claimDispatch(run.id).id, queued.id);
});
