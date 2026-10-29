import test from "node:test";
import assert from "node:assert/strict";
import { executionLogs } from "../server/execution-logs.mjs";
import { createStore } from "../server/store.mjs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const fixture = () => ({ runs: [{ id: "r", taskId: "t" }], tasks: [{ id: "t", title: "代码开发" }],
  communicationConversations: [{ id: "c", kind: "agent", name: "员工" }, { id: "g", kind: "team", name: "团队" }],
  communicationDeliveries: [{ id: "d", status: "done" }],
  events: [{ id: "e1", runId: "r", type: "trace.failed", timestamp: "2026-10-15T01:00:00Z", message: "ENOENT SECRET_SENTINEL", data: { traceId: "tr", raw: "SECRET_SENTINEL" } }],
  communicationEvents: [{ id: "e2", conversationId: "c", deliveryId: "d", type: "failed", createdAt: "2026-10-15T02:00:00Z", content: "401 SECRET_SENTINEL", attempt: 1 }, { id: "e3", conversationId: "g", type: "completed", createdAt: "2026-10-15T03:00:00Z", content: "SECRET_SENTINEL" }] });

test("global logs merge task/private/group facts without content or credentials", () => {
  const state = fixture(), original = structuredClone(state), result = executionLogs(state);
  assert.deepEqual(result.items.map(row => row.source), ["group", "private", "task"]);
  assert.equal(result.items[1].currentStatus, "done");
  assert.equal(result.items[1].level, "error");
  assert.match(result.items[1].message, /登录已失效/);
  assert.match(result.items[2].message, /CLI 不可启动/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_SENTINEL/);
  assert.deepEqual(state, original);
});

test("log filters and stable older cursor reject invalid queries", () => {
  const state = fixture();
  assert.equal(executionLogs(state, { source: "private", level: "error" }).items.length, 1);
  const first = executionLogs(state, { limit: 1 });
  assert.equal(first.hasMore, true);
  state.communicationEvents.push({ id: "e4", conversationId: "g", type: "started", createdAt: "2026-10-15T04:00:00Z" });
  assert.equal(executionLogs(state, { before: first.nextBefore, limit: 1 }).items[0].id, "e2");
  for (const query of [{ limit: 201 }, { limit: 0 }, { source: "invalid" }, { level: "secret" }, { before: "missing" }]) assert.throws(() => executionLogs(state, query));
});

test("tool failure is not described as provider failure and unknown failures stay generic", () => {
  const state = fixture();
  state.events.push({id: "tool", runId: "r", type: "runtime.event", timestamp: "2026-10-15T05:00:00Z", message: "SECRET_SENTINEL", data: {auditVersion: 2, status: "failed", toolName: "Bash", input: "SECRET_SENTINEL"}});
  const row = executionLogs(state, {source: "task", level: "error"}).items[0];
  assert.equal(row.level, "error");
  assert.match(row.message, /工具执行失败/);
  assert.doesNotMatch(JSON.stringify(row), /SECRET_SENTINEL/);
  state.communicationEvents[0].content = "SECRET_SENTINEL";
  assert.match(executionLogs(state, {source: "private"}).items[0].message, /执行未完成/);
});

test("Store audit logs survive reopening with failure and recovery facts intact", async () => {
  await mkdir('.data', {recursive: true});
  const root = await mkdtemp(resolve('.data/execution-logs-test-'));
  const options = {databasePath: join(root, 'state.sqlite')};
  const store = createStore(options);
  const agent = store.listAgents().find(row => !row.system);
  const conversation = store.openCommunication({kind: 'agent', targetId: agent.id});
  store.sendCommunication(conversation.id, {content: 'SECRET_SENTINEL', clientRequestId: 'logging-test-message'});
  const delivery = store.claimCommunication(conversation.id);
  store.failCommunication(conversation.id, delivery.id, 'ENOENT SECRET_SENTINEL');
  store.retryCommunication(conversation.id, delivery.id);
  store.claimCommunication(conversation.id);
  store.completeCommunication(conversation.id, delivery.id, 'SECRET_SENTINEL');
  const reopened = createStore(options).getExecutionLogs({source: 'private'});
  assert.ok(reopened.items.some(row => row.type === 'failed' && row.currentStatus === 'done'));
  assert.ok(reopened.items.some(row => row.type === 'retry'));
  assert.ok(reopened.items.some(row => row.type === 'completed'));
  assert.doesNotMatch(JSON.stringify(reopened), /SECRET_SENTINEL/);
});
