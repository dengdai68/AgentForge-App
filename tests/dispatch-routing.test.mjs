import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogFixtureStore, createFixtureStore } from "./fixture-store.mjs";
import { createSqlitePersistence } from "../server/persistence.mjs";
import { createRunFiles } from "../server/run-files.mjs";
import { dispatchBlocksHandoff, executeRun, requestHumanIntervention, scheduleManagerFollowup } from "../server/orchestrator.mjs";

test('transient retries are bounded and consumed inputs are not replayed after a failed turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-retry-receipt-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const executable=join(root,'provider.mjs'), capture=join(root,'inputs.jsonl');
  await writeFile(executable, `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.at(-1))+'\\n');
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'I received this assignment.'}]}}));
console.error('API Error: 503 temporarily unavailable');
process.exitCode=1;
`, {mode:0o700});
  const store=createCatalogFixtureStore({workspaceRoot:join(root,'work')}); t.after(()=>store.close());
  store.updateAgent('agent_analyst',{runtime:{provider:'claude-code',executable}});
  const task=store.createTask({title:'续接验证',objective:'OBJECTIVE_ONCE',teamId:store.listTeams()[0].id,workflowTemplateId:'software_delivery'});
  const run=store.createRun(task.id); store.updateRun(run.id,{status:'running'});store.setTaskStatus(task.id,'running');
  const message=store.addMessage({runId:run.id,recipientAgentId:'agent_analyst',content:'ASSIGNMENT_ONCE'});
  const delivery=store.enqueueDispatch(run.id,{recipientAgentId:'agent_analyst',workflowNodeId:'requirements',purpose:'node',messageIds:[message.id]});
  for(let attempt=1;attempt<=3;attempt++) {
    await executeRun(store,run.id,{runFilesRoot:join(root,'audit')});
    if(attempt<3)store.retryScheduledDispatches(run.id);
  }
  const inputs=(await readFile(capture,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(inputs.length,3);
  assert.match(inputs[0],/OBJECTIVE_ONCE|ASSIGNMENT_ONCE/);
  for(const input of inputs.slice(1))assert.doesNotMatch(input,/OBJECTIVE_ONCE|ASSIGNMENT_ONCE|职责交付定义/);
  const final=store.getDispatch(delivery.id);
  assert.equal(final.status,'cancelled');assert.equal(final.attempts,3);assert.equal(final.nextRetryAt,null);
  assert.match(final.lastError,/API Error: 503 temporarily unavailable/);
  assert.equal(store.getRun(run.id).status,'failed');
  await executeRun(store,run.id,{runFilesRoot:join(root,'audit')});
  assert.equal(store.getDispatch(delivery.id).attempts,3);
});

test("an unanswered human question blocks every queued dispatch through messages, retry, pause and resume", () => {
  const store = createFixtureStore();
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const parent = store.enqueueDispatch(run.id, { recipientAgentId: "agent_analyst", workflowNodeId: "requirements", purpose: "node", messageIds: [] });
  assert.equal(store.claimDispatch(run.id).id, parent.id);
  const question = store.askQuestion(parent.id, { audience: "human", question: "请确认范围", questionType: "scope", routingReason: "需人类决定", consideredMemberIds: ["agent_analyst"] }, "trace_fixture");
  assert.equal(store.getRun(run.id).status, "awaiting_human");
  const ordinary = store.submitHumanMessage(run.id, { content: "这是新指令，不是答复", recipientAgentId: run.manager.id });
  const directed = store.submitHumanMessage(run.id, { recipientAgentId: "agent_tester", content: "请先测试" });
  assert.equal(ordinary.resumed, false);
  assert.equal(directed.resumed, false);
  assert.equal(store.getRun(run.id).status, "awaiting_human");
  assert.equal(store.claimDispatch(run.id), null);
  assert.equal(store.getRunRecoveryPlan(run.id).shouldExecute, false);
  assert.throws(() => store.answerQuestion(run.id, "missing", "答复", { type: "human", id: "human_operator" }), /待回答问题/);
  assert.throws(() => store.answerQuestion(run.id, question.id, "答复", { type: "agent", id: "agent_analyst" }), /待回答问题/);
  assert.throws(() => store.answerQuestion(run.id, question.id, " ", { type: "human", id: "human_operator" }), /消息内容/);
  store.pauseRun(run.id); store.resumeRun(run.id);
  assert.equal(store.getRun(run.id).status, "awaiting_human");
  assert.equal(store.claimDispatch(run.id), null);
  const answer = store.answerQuestion(run.id, question.id, "确认范围", { type: "human", id: "human_operator", name: "你" });
  assert.equal(answer.replyToMessageId, question.id);
  assert.equal(store.getRun(run.id).status, "running");
  assert.equal(store.claimDispatch(run.id).id, parent.id);
  assert.throws(() => store.answerQuestion(run.id, question.id, "重复", { type: "human", id: "human_operator" }), /待回答问题/);
  assert.ok(store.getRunWorkspace(run.id).messages.some((item) => item.id === ordinary.message.id));
});

test('a malformed consultation inside managerDecision cannot request human acceptance', () => {
  const store=createFixtureStore();
  try {
    const run=store.createRun(store.listTasks()[0].id);store.updateRun(run.id,{status:'running'});
    assert.throws(()=>scheduleManagerFollowup(store,run.id,{traceIds:[]},{nextNodeId:null,nextAgentId:null,type:'consultation',question:'请确认',audience:'human'}),/顶层 consultation/);
    assert.equal(store.getRun(run.id).status,'running');
    assert.equal(store.getRun(run.id).acceptanceRequest ?? null,null);
  } finally {store.close();}
});

test("a team message reaches the next real subprocess without broadcasting or leaking a private message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-team-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "provider.mjs"), capture = join(root, "prompt.txt");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
writeFileSync(${JSON.stringify(capture)}, prompt);
const result = { kind: "node_result", summary: "need human clarification", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: true, consultation: { audience: "human", recipientAgentId: "", question: "确认下一步", questionType: "scope", routingReason: "需人类确认", consideredMemberIds: ["agent_analyst"] }, inputAssessment: { sufficient: false, sourceNodeIds: [], rationale: "需澄清", missingEvidence: ["人类范围"] }, deliveryReview: null, managerDecision: null };
console.log(JSON.stringify({ type: "result", result: JSON.stringify(result) }));
`);
  await chmod(executable, 0o755);
  const store = createCatalogFixtureStore({ workspaceRoot: join(root, "workspaces") });
  store.updateAgent("agent_analyst", { runtime: { provider: "claude-code", executable } });
  const workflow = store.createWorkflowTemplate({ name: "共享消息验证", nodes: [{ id: "requirements", title: "需求", staffingGuidance: "需求成员", artifactPaths: ["docs/requirements/"], dependsOn: [] }] });
  const task = store.createTask({ title: "团队共享", objective: "验证下一成员上下文", teamId: store.listTeams()[0].id, workflowTemplateId: workflow.id, nodeAssignments: { requirements: "agent_analyst" }, managerRuntime: { provider: "claude-code", executable } });
  const run = store.createRun(task.id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(task.id, "running");
  const shared = store.addMessage({ runId: run.id, sender: { type: "agent", id: run.manager.id, name: run.manager.name }, content: "TEAM_SHARED_SENTINEL", kind: "manager_decision" });
  store.addMessage({ runId: run.id, sender: { type: "agent", id: run.manager.id, name: run.manager.name }, recipientAgentId: "agent_tester", content: "PRIVATE_TESTER_SENTINEL", kind: "instruction" });
  assert.equal(store.listDispatches(run.id).length, 0, "broadcast creates no deliveries");
  store.enqueueDispatch(run.id, { recipientAgentId: "agent_analyst", workflowNodeId: "requirements", purpose: "node", messageIds: [], dedupeKey: "next-real-work" });
  await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });
  const prompt = await (await import("node:fs/promises")).readFile(capture, "utf8");
  assert.match(prompt, /TEAM_SHARED_SENTINEL/);
  assert.doesNotMatch(prompt, /PRIVATE_TESTER_SENTINEL/);
  assert.equal(store.getRunWorkspace(run.id).traces.filter((trace) => trace.agentId === "agent_tester").length, 0);
  assert.equal(store.getRun(run.id).status, "awaiting_human");
  assert.equal(store.getRunWorkspace(run.id).messages.find((message) => message.id === shared.id).recipient.type, "team");
});

test("persistent restart and multiple unanswered questions retain the gate until each exact human answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-multi-human-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "state.sqlite");
  const store = createFixtureStore({ databasePath });
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const parent = store.enqueueDispatch(run.id, { recipientAgentId: "agent_analyst", workflowNodeId: "requirements", purpose: "node", messageIds: [] });
  store.claimDispatch(run.id);
  const first = store.askQuestion(parent.id, { audience: "human", question: "第一问", questionType: "scope", routingReason: "待人类", consideredMemberIds: ["agent_analyst"] }, "trace_first");
  store.submitHumanMessage(run.id, { content: "这只是普通消息", recipientAgentId: run.manager.id });
  const snapshot = store.snapshot(); store.close();
  const second = { ...first, id: "message_second_question", conversationId: "conversation_second", content: "第二问", sender: { type: "agent", id: "agent_tester", name: "测试" } };
  snapshot.messages.push(second);
  snapshot.dispatches.push({ ...snapshot.dispatches.find((item) => item.id === parent.id), id: "dispatch_second_question", recipientAgentId: "agent_tester", workflowNodeId: "testing", messageIds: [second.id], status: "waiting", waitingMessageId: second.id });
  const persistence = createSqlitePersistence(databasePath); persistence.save(snapshot); persistence.close();
  const restored = createFixtureStore({ databasePath });
  assert.equal(restored.getRunRecoveryPlan(run.id).shouldExecute, false);
  assert.equal(restored.pendingQuestions(run.id).length, 2);
  restored.answerQuestion(run.id, first.id, "第一答", { type: "human", id: "human_operator", name: "你" });
  assert.equal(restored.getRun(run.id).status, "awaiting_human");
  assert.equal(restored.claimDispatch(run.id), null);
  restored.answerQuestion(run.id, second.id, "第二答", { type: "human", id: "human_operator", name: "你" });
  assert.equal(restored.getRun(run.id).status, "running");
  assert.equal(restored.pendingQuestions(run.id).length, 0);
  assert.ok(restored.getRunWorkspace(run.id).messages.some((item) => item.id === first.id));
  restored.close();
});

// P1: a direct @ instruction must never be silently bound to nodes[0] when the
// addressed member has no assigned node (empty or partial nodeAssignments). It
// goes to the manager for formal dispatch; the @ intent stays on the message.
// P3 scope note (human ruling message_mvj08do9_1u0): retry backoff only stops
// blocking NON-TERMINAL handoff/review scheduling; completion eligibility
// (canCompleteRun/confirmRunCompletion/archiveTask) stays strict — every
// dispatch must be done or legitimately cancelled before completion.

test("direct @ to an unassigned member routes to the manager, never fabricates a nodes[0] instruction", () => {
  const store = createCatalogFixtureStore();
  const task = store.createTask({ title: "Unassigned fixture", objective: "Routing without nodeAssignments", workspacePath: mkdtempSync(join(tmpdir(), "af-routing-unassigned-")), teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery" });
  assert.deepEqual(task.nodeAssignments, {});
  const run = store.createRun(task.id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const firstNode = task.workflowSnapshot.nodes[0];

  // A non-test-role member (no role-name hardcoding) and the test-role member
  // behave identically: no instruction dispatch, one manager dispatch each.
  for (const recipientId of ["agent_engineer", "agent_tester"]) {
    const sent = store.submitHumanMessage(run.id, { recipientAgentId: recipientId, content: "@成员 请直接验证交付" });
    const dispatches = store.listDispatches(run.id).filter((item) => item.messageIds.includes(sent.message.id));
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].purpose, "manager");
    assert.equal(dispatches[0].recipientAgentId, run.manager.id);
    assert.equal(sent.message.recipient.id, recipientId, "original @ intent stays visible on the message");
    assert.equal(sent.message.kind, "instruction");
    assert.ok(!store.listDispatches(run.id).some((item) => item.purpose === "instruction" && item.recipientAgentId === recipientId), "no instruction dispatch to the unassigned member");
    assert.ok(!store.listDispatches(run.id).some((item) => item.purpose === "instruction" && item.workflowNodeId === firstNode.id), "nothing is silently bound to nodes[0]");
  }
  // requestHumanIntervention follows the same rule.
  const message = store.addMessage({ runId: run.id, recipientAgentId: "agent_designer", content: "@成员 请复核", kind: "instruction" });
  requestHumanIntervention(store, run.id, message.id);
  const followup = store.listDispatches(run.id).filter((item) => item.messageIds.includes(message.id));
  assert.equal(followup.length, 1);
  assert.equal(followup[0].purpose, "manager");
  assert.equal(followup[0].recipientAgentId, run.manager.id);
});

test("manager recipient without any assigned node never throws and binds as a manager dispatch (regression ①)", () => {
  const store = createCatalogFixtureStore();
  const task = store.createTask({ title: "Manager recipient fixture", objective: "Manager routing without nodeAssignments", workspacePath: mkdtempSync(join(tmpdir(), "af-routing-manager-")), teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery" });
  assert.deepEqual(task.nodeAssignments, {});
  const run = store.createRun(task.id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  // Human message addressed to the manager (submitHumanMessage path).
  const sent = store.submitHumanMessage(run.id, { recipientAgentId: run.manager.id, content: "请安排下一步" });
  const viaSubmit = store.listDispatches(run.id).find((item) => item.messageIds.includes(sent.message.id));
  assert.equal(viaSubmit.purpose, "manager");
  assert.equal(viaSubmit.recipientAgentId, run.manager.id);
  assert.equal(viaSubmit.workflowNodeId, task.workflowSnapshot.nodes[0].id, "manager deliveries use the conventional first node; they open no Artifact boundary");
  // requestHumanIntervention path previously threw TypeError: ownNode.id (human QA exit 1).
  const message = store.addMessage({ runId: run.id, recipientAgentId: run.manager.id, content: "请重新安排", kind: "instruction" });
  requestHumanIntervention(store, run.id, message.id);
  const viaIntervention = store.listDispatches(run.id).find((item) => item.messageIds.includes(message.id));
  assert.equal(viaIntervention.purpose, "manager");
  assert.equal(viaIntervention.recipientAgentId, run.manager.id);
});

test("direct @ follows actual dispatch responsibility, not static Task assignments", () => {
  const store = createFixtureStore();
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  for (const [recipientAgentId, workflowNodeId] of [["agent_tester", "testing"], ["agent_analyst", "requirements"]]) {
    const item = store.enqueueDispatch(run.id, { recipientAgentId, workflowNodeId, purpose: "node" });
    store.claimDispatch(run.id); store.completeDispatch(item.id);
  }
  const sent = store.submitHumanMessage(run.id, { recipientAgentId: "agent_tester", content: "@成员 请验证" });
  const dispatch = store.listDispatches(run.id).find((item) => item.messageIds.includes(sent.message.id));
  assert.equal(dispatch.purpose, "instruction");
  assert.equal(dispatch.recipientAgentId, "agent_tester");
  assert.equal(dispatch.workflowNodeId, "testing", "assigned node binding is preserved");
  const intervention = store.addMessage({ runId: run.id, recipientAgentId: "agent_analyst", content: "@成员 请补充", kind: "instruction" });
  requestHumanIntervention(store, run.id, intervention.id);
  const followup = store.listDispatches(run.id).find((item) => item.messageIds.includes(intervention.id));
  assert.equal(followup.purpose, "instruction");
  assert.equal(followup.workflowNodeId, "requirements");
  // Messages to the manager stay manager dispatches.
  const toManager = store.submitHumanMessage(run.id, { content: "请安排下一步", recipientAgentId: run.manager.id });
  assert.equal(store.listDispatches(run.id).find((item) => item.messageIds.includes(toManager.message.id)).purpose, "manager");
});

test("read-only inquiries still reach an unassigned member directly without opening any Artifact boundary", () => {
  const store = createCatalogFixtureStore();
  const task = store.createTask({ title: "Inquiry fixture", objective: "Inquiry routing", workspacePath: mkdtempSync(join(tmpdir(), "af-routing-inquiry-")), teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery" });
  const run = store.createRun(task.id);
  store.pauseRun(run.id);
  const sent = store.submitHumanMessage(run.id, { recipientAgentId: "agent_engineer", content: "只读咨询：目前的取舍是什么？" });
  assert.equal(sent.interactionOnly, true);
  const dispatch = store.listDispatches(run.id).find((item) => item.messageIds.includes(sent.message.id));
  assert.equal(dispatch.purpose, "inquiry");
  assert.equal(dispatch.recipientAgentId, "agent_engineer");
  assert.equal(dispatch.interactionOnly, true);
});

// P2: the Artifact boundary is NOT widened. After P1 routes work correctly, a
// member's legitimate artifacts under their bound node are accepted, while
// out-of-bounds writes are still rejected with the declared paths named.

test("artifact boundary accepts declared roots and still rejects out-of-bounds writes with declared paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-artifact-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), audit = join(root, "audit");
  await mkdir(join(workspace, "docs", "testing"), { recursive: true });
  await mkdir(join(workspace, "docs", "requirements"), { recursive: true });
  await mkdir(join(workspace, "repos", "app"), { recursive: true });
  const files = createRunFiles({ root: audit });
  const allowed = ["docs/testing/", "repos/app"];

  const before = await files.snapshotWorkspace(workspace, { excludeRunFiles: true, includeRoots: ["docs", "repos"] });
  await writeFile(join(workspace, "docs", "testing", "review.md"), "# 独立测试报告\n");
  const accepted = await files.captureWorkspaceChanges({ runId: "run_p2", traceId: "trace_accept", workspacePath: workspace, before, includeRoots: ["docs", "repos"], allowedRoots: allowed });
  assert.deepEqual(accepted.artifacts.map((item) => item.name), ["docs/testing/review.md"]);

  const before2 = await files.snapshotWorkspace(workspace, { excludeRunFiles: true, includeRoots: ["docs", "repos"] });
  await writeFile(join(workspace, "docs", "requirements", "brief.md"), "# 越界写入\n");
  await assert.rejects(
    files.captureWorkspaceChanges({ runId: "run_p2", traceId: "trace_reject", workspacePath: workspace, before: before2, includeRoots: ["docs", "repos"], allowedRoots: allowed }),
    (error) => {
      assert.match(error.message, /只能验收声明的 Artifact 路径/);
      assert.match(error.message, /docs\/testing/, "error names the declared paths");
      assert.match(error.message, /repos\/app/, "error names the declared repository root");
      assert.match(error.message, /docs\/requirements\/brief\.md/, "error names the out-of-bounds change");
      return true;
    }
  );

  // Management/consultation calls still accept nothing at all.
  const before3 = await files.snapshotWorkspace(workspace, { excludeRunFiles: true, includeRoots: ["docs", "repos"] });
  await writeFile(join(workspace, "docs", "testing", "sneak.md"), "x");
  await assert.rejects(
    files.captureWorkspaceChanges({ runId: "run_p2", traceId: "trace_none", workspacePath: workspace, before: before3, includeRoots: ["docs", "repos"], allowedRoots: [] }),
    /无（本次调用不允许修改业务文件）/
  );
});

// P3: an accepted managerDecision must materialize even while a failed dispatch
// sits in retry backoff; real pending work still takes priority.

function backoffDispatch(store, run, nodeId, agentId) {
  const delivery = store.enqueueDispatch(run.id, { recipientAgentId: agentId, workflowNodeId: nodeId, purpose: "instruction", dedupeKey: "backoff:" + nodeId });
  store.claimDispatch(run.id);
  const trace = store.createTrace(run.id, { workflowNodeId: nodeId, agentId, type: "instruction" });
  store.attachDispatchTrace(delivery.id, trace.id);
  store.completeTrace(trace.id, { status: "failed", error: "Artifact 边界拒收" });
  store.retryDispatch(delivery.id, "Artifact 边界拒收", 300000);
  return { delivery, trace };
}

test("dispatchBlocksHandoff distinguishes real pending work from retry backoff", () => {
  const future = new Date(Date.now() + 300000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(dispatchBlocksHandoff({ status: "done" }), false);
  assert.equal(dispatchBlocksHandoff({ status: "cancelled" }), false);
  assert.equal(dispatchBlocksHandoff({ status: "claimed" }), true, "in-flight work blocks");
  assert.equal(dispatchBlocksHandoff({ status: "waiting" }), true, "an open consultation blocks");
  assert.equal(dispatchBlocksHandoff({ status: "queued" }), true, "a freshly queued instruction blocks");
  assert.equal(dispatchBlocksHandoff({ status: "queued", nextRetryAt: past, lastError: "x" }), true, "an immediately claimable retry blocks");
  assert.equal(dispatchBlocksHandoff({ status: "queued", nextRetryAt: future, lastError: "x" }), false, "retry backoff never blocks");
  assert.equal(dispatchBlocksHandoff({ status: "queued", nextRetryAt: future }), true, "queued without a recorded failure still blocks");
});

test("manager redispatch materializes during retry backoff while failed evidence is preserved", () => {
  const store = createFixtureStore();
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const failed = backoffDispatch(store, run, "testing", "agent_tester");
  const managerDelivery = store.enqueueDispatch(run.id, { recipientAgentId: run.manager.id, workflowNodeId: "requirements", purpose: "manager", dedupeKey: "manager-decision" });
  store.claimDispatch(run.id);
  store.completeDispatch(managerDelivery.id);

  const result = scheduleManagerFollowup(store, run.id, managerDelivery, { nextNodeId: "requirements", nextAgentId: "agent_analyst", rationale: "返工重派产品" });
  assert.equal(result.scheduled, "handoff");
  const handoff = store.listDispatches(run.id).find((item) => item.dedupeKey === "handoff:" + managerDelivery.id);
  assert.ok(handoff, "the redispatch dispatch really exists");
  assert.equal(handoff.purpose, "node");
  assert.equal(handoff.recipientAgentId, "agent_analyst");
  assert.equal(handoff.workflowNodeId, "requirements");
  // The failed dispatch, its failure and its retry schedule are untouched.
  const preserved = store.getDispatch(failed.delivery.id);
  assert.equal(preserved.status, "queued");
  assert.ok(preserved.nextRetryAt);
  assert.equal(preserved.lastError, "Artifact 边界拒收");
  assert.equal(store.getRunWorkspace(run.id).traces.find((item) => item.id === failed.trace.id).status, "failed");
});

test("real pending work still blocks a non-terminal handoff; backoff does not", () => {
  const store = createFixtureStore();
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const managerDelivery = store.enqueueDispatch(run.id, { recipientAgentId: run.manager.id, workflowNodeId: "requirements", purpose: "manager", dedupeKey: "manager-decision-2" });
  store.claimDispatch(run.id);
  store.completeDispatch(managerDelivery.id);

  // A freshly queued instruction (new work) keeps priority: followup blocked,
  // and the deferral is revisited by a queued manager redispatch, never dropped.
  store.enqueueDispatch(run.id, { recipientAgentId: "agent_tester", workflowNodeId: "testing", purpose: "instruction", dedupeKey: "fresh-instruction" });
  const deferred = scheduleManagerFollowup(store, run.id, managerDelivery, { nextNodeId: "requirements", nextAgentId: "agent_analyst", rationale: "重派" });
  assert.equal(deferred.scheduled, "blocked"); assert.equal(deferred.requeued, true);
  assert.ok(!store.listDispatches(run.id).some((item) => item.dedupeKey === "handoff:" + managerDelivery.id));
  const redispatch = store.listDispatches(run.id).find((item) => item.dedupeKey === "redispatch:" + managerDelivery.id);
  assert.ok(redispatch && redispatch.recipientAgentId === run.manager.id && redispatch.purpose === "manager", "a blocked decision queues a manager re-evaluation");
  const note = store.getRunWorkspace(run.id).messages.find((item) => redispatch.messageIds.includes(item.id));
  assert.match(note.content, /暂未建立派工/);
  assert.equal(dispatchBlocksHandoff(redispatch), false, "the redispatch never blocks the handoff it revisits");

  // Once only backoff remains, the non-terminal handoff materializes.
  const fresh = store.listDispatches(run.id).find((item) => item.dedupeKey === "fresh-instruction");
  store.claimDispatch(run.id);
  const failedTrace = store.createTrace(run.id, { workflowNodeId: "testing", agentId: "agent_tester", type: "instruction" });
  store.attachDispatchTrace(fresh.id, failedTrace.id);
  store.completeTrace(failedTrace.id, { status: "failed", error: "临时失败" });
  store.retryDispatch(fresh.id, "临时失败", 300000);
  assert.equal(scheduleManagerFollowup(store, run.id, managerDelivery, { nextNodeId: "requirements", nextAgentId: "agent_analyst", rationale: "重派" }).scheduled, "handoff");
  assert.ok(store.listDispatches(run.id).some((item) => item.dedupeKey === "handoff:" + managerDelivery.id));
});

test("a deferred manager decision materializes after pending work drains instead of stalling the run", () => {
  const store = createFixtureStore();
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const managerDelivery = store.enqueueDispatch(run.id, { recipientAgentId: run.manager.id, workflowNodeId: "requirements", purpose: "manager", dedupeKey: "manager-decision-3" });
  store.claimDispatch(run.id);
  store.completeDispatch(managerDelivery.id);

  // An ordinary instruction queued while the manager was answering keeps
  // priority; the decision waits and queues its own re-evaluation.
  const blocker = store.enqueueDispatch(run.id, { recipientAgentId: run.manager.id, workflowNodeId: "requirements", purpose: "instruction", dedupeKey: "queued-instruction" });
  assert.equal(scheduleManagerFollowup(store, run.id, managerDelivery, { nextNodeId: "requirements", nextAgentId: "agent_analyst", rationale: "安排需求" }).scheduled, "blocked");
  assert.ok(!store.listDispatches(run.id).some((item) => item.purpose === "node"));
  const redispatch = store.listDispatches(run.id).find((item) => item.dedupeKey === "redispatch:" + managerDelivery.id);
  assert.ok(redispatch);

  // The queued instruction drains first, then the re-evaluation can hand off.
  store.claimDispatch(run.id);
  store.completeDispatch(blocker.id);
  assert.equal(scheduleManagerFollowup(store, run.id, redispatch, { nextNodeId: "requirements", nextAgentId: "agent_analyst", rationale: "重新安排" }).scheduled, "handoff");
  const handoff = store.listDispatches(run.id).find((item) => item.purpose === "node" && item.workflowNodeId === "requirements");
  assert.ok(handoff && handoff.recipientAgentId === "agent_analyst");
  store.close();
});

// R11② (brief v6 §4.6 P3, human ruling message_mvj00z8c_1se): the terminal
// delivery_review may only be scheduled once every dispatch is done or
// cancelled. With any unfinished dispatch — including one in retry backoff —
// the manager's next:null decision waits honestly ("blocked"), never loops
// final reviews and never fakes completion.

test("the manager handoff directly requests acceptance without a final review gate", () => {
  const store = createFixtureStore(), run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const failed = backoffDispatch(store, run, "testing", "agent_tester");
  const delivery = { id: "manager-finish", traceIds: [] };
  assert.equal(scheduleManagerFollowup(store, run.id, delivery, { nextNodeId: null, rationale: "提交人类验收" }).scheduled, "acceptance");
  assert.equal(store.getRun(run.id).status, "awaiting_acceptance");
  assert.equal(store.getDispatch(failed.delivery.id).status, "queued");
  assert.equal(store.listDispatches(run.id).some(item => item.purpose === "delivery_review"), false);
});

test("human acceptance is not vetoed by a platform result gate", () => {
  const store = createFixtureStore(), run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const failed = backoffDispatch(store, run, "testing", "agent_tester");
  store.requestHumanAcceptance(run.id);
  assert.equal(store.confirmRunCompletion(run.id).status, "completed");
  assert.equal(store.getDispatch(failed.delivery.id).status, "queued");
});

test("formal routing chain: direct @ → manager dispatch → node delivery → legitimate artifact accepted, out-of-bounds rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-routing-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createCatalogFixtureStore();
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const task = store.createTask({ title: "Chain fixture", objective: "Formal routing chain", workspacePath: workspace, teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery" });
  assert.deepEqual(task.nodeAssignments, {});
  const run = store.createRun(task.id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");

  // Link 1 (P1): direct @ to the unassigned tester becomes a manager dispatch.
  const sent = store.submitHumanMessage(run.id, { recipientAgentId: "agent_tester", content: "@Sora · 测试工程师 请独立验证交付并写 docs/testing/review.md" });
  const managerDelivery = store.listDispatches(run.id).find((item) => item.messageIds.includes(sent.message.id));
  assert.equal(managerDelivery.purpose, "manager");
  assert.equal(managerDelivery.recipientAgentId, run.manager.id);
  assert.equal(sent.message.recipient.id, "agent_tester", "@ intent stays visible on the original message");

  // Link 2 (P3): the manager formally assigns the testing node to the tester;
  // the decision materializes as a real node delivery.
  store.claimDispatch(run.id);
  store.completeDispatch(managerDelivery.id);
  assert.equal(scheduleManagerFollowup(store, run.id, managerDelivery, { nextNodeId: "testing", nextAgentId: "agent_tester", rationale: "正式派发独立测试" }).scheduled, "handoff");
  const nodeDelivery = store.listDispatches(run.id).find((item) => item.dedupeKey === "handoff:" + managerDelivery.id);
  assert.equal(nodeDelivery.purpose, "node");
  assert.equal(nodeDelivery.recipientAgentId, "agent_tester");
  assert.equal(nodeDelivery.workflowNodeId, "testing");

  // Link 3 (P2): under that bound node the legitimate artifact is accepted by
  // the un-widened boundary; an out-of-bounds write is still rejected.
  const node = task.workflowSnapshot.nodes.find((item) => item.id === nodeDelivery.workflowNodeId);
  const allowed = [...new Set([...(node.artifactPaths || []), ...(node.repositoryPath ? [node.repositoryPath] : [])])];
  assert.deepEqual(allowed, ["docs/testing/"], "boundary stays the bound node's declared paths (no repository binding with empty nodeAssignments)");
  await mkdir(join(workspace, "docs", "testing"), { recursive: true });
  await mkdir(join(workspace, "docs", "requirements"), { recursive: true });
  const files = createRunFiles({ root: join(root, "audit") });
  const before = await files.snapshotWorkspace(workspace, { excludeRunFiles: true, includeRoots: ["docs", "repos"] });
  await writeFile(join(workspace, "docs", "testing", "review.md"), "# 独立测试报告\n");
  const accepted = await files.captureWorkspaceChanges({ runId: run.id, traceId: "trace_chain", workspacePath: workspace, before, includeRoots: ["docs", "repos"], allowedRoots: allowed });
  assert.deepEqual(accepted.artifacts.map((item) => item.name), ["docs/testing/review.md"], "the formally routed member's legitimate artifact is accepted");
  const before2 = await files.snapshotWorkspace(workspace, { excludeRunFiles: true, includeRoots: ["docs", "repos"] });
  await writeFile(join(workspace, "docs", "requirements", "brief.md"), "越界");
  await assert.rejects(
    files.captureWorkspaceChanges({ runId: run.id, traceId: "trace_chain_2", workspacePath: workspace, before: before2, includeRoots: ["docs", "repos"], allowedRoots: allowed }),
    /只能验收声明的 Artifact 路径：docs\/testing；检测到 1 个越界变更：docs\/requirements\/brief\.md/
  );
});

// R9 (brief v6): the REAL orchestration chain — executeRun → claimDispatch →
// invokeDispatch (executable provider fixture) → parse → capture → accept —
// not a hand-assembled allowedRoots composition. Covers the formally routed
// developer with a bound repository writing into that repository (node
// purpose), the assigned-member @ regression (instruction purpose), and the
// real capture rejecting an out-of-bounds write.

test("real orchestration chain: formally routed developer's repo write is accepted by invokeDispatch→capture; assigned @ regression", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-real-chain-"));
  const envKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"], previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const key of envKeys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  });
  const executable = join(root, "provider.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const promptHash = createHash("sha256").update(prompt, "utf8").digest("hex");
const out = { kind: "node_result", summary: "fixture 交付", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "输入充分", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes("任务：失败重试代码")) {
  if (prompt.includes('"purpose":"delivery_review"')) out.deliveryReview = { verdict: "pass", restartFromNodeId: "", findings: ["源码、测试和报告均已接纳"] };
  else if (prompt.includes("任务级项目经理")) out.managerDecision = { nextNodeId: prompt.includes('"type":"node"') ? null : "development", nextAgentId: "agent_engineer", rationale: "核对代码交付" };
  else if (!existsSync("../../retry-marker")) {
    writeFileSync("../../retry-marker", "failed");
    writeFileSync("SOURCE.js", "export const value = 1;\\n");
    writeFileSync("SOURCE.test.js", "assert.equal(value, 1);\\n");
    console.error('API Error: 503 temporarily unavailable');
    process.exit(1);
  } else { mkdirSync("../../docs/development", { recursive: true }); writeFileSync("../../docs/development/report.md", "# Retried code delivery\\n"); }
} else if (prompt.includes('"purpose":"delivery_review"')) {
  out.deliveryReview = { verdict: "pass", restartFromNodeId: "requirements", findings: ["fixture 已核对整体交付及独立测试"] };
} else if (prompt.includes("任务级项目经理")) {
  out.managerDecision = prompt.includes("独立测试已完成") ? { nextNodeId: null, nextAgentId: null, rationale: "交付已接纳，进入复核" } : prompt.includes("已在绑定仓库完成研发交付") ? { nextNodeId: "testing", nextAgentId: "agent_tester", rationale: "交独立成员测试" } : { nextNodeId: "development", nextAgentId: "agent_engineer", rationale: "正式派发研发" };
} else {
  if (prompt.includes('"purpose":"instruction"')) { mkdirSync("../../docs/requirements", { recursive: true }); writeFileSync("../../docs/requirements/brief.md", "越界写入\\n"); }
  else if (prompt.includes('"workflowNodeId":"testing"')) { mkdirSync("docs/testing", { recursive: true }); writeFileSync("docs/testing/review.md", "# 独立测试报告\\n"); out.summary = "独立测试已完成"; }
  else { writeFileSync("FEATURE.md", "# 真实研发交付\\nPROMPT_SHA256:" + promptHash + "\\n"); out.summary = "已在绑定仓库完成研发交付"; }
}
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) out.managerDecision.nextAgentId = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[out.managerDecision.nextNodeId] || "agent_analyst";
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
  await chmod(executable, 0o755);
  const origin = join(root, "origin");
  await mkdir(origin);
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("-C", origin, "init", "-b", "main");
  await writeFile(join(origin, "README.md"), "baseline\n");
  git("-C", origin, "add", "README.md");
  git("-C", origin, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://example.test/app.git";

  const store = createCatalogFixtureStore({ workspaceRoot: join(root, "work") });
  for (const agent of store.listAgents().filter((agent) => agent.kind !== "manager")) store.updateAgent(agent.id, { runtime: { provider: "claude-code", executable } });
  store.updateAgent("agent_engineer", { kind: "developer", repository: { url: "https://example.test/app.git", ref: "main" } });

  // Run 1: empty nodeAssignments — direct @ routes through the manager.
  const task = store.createTask({ title: "真实链路", objective: "真实编排链路", teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery", managerRuntime: { provider: "claude-code", executable } });
  assert.deepEqual(task.nodeAssignments, {});
  const run = store.createRun(task.id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const sent = store.submitHumanMessage(run.id, { recipientAgentId: "agent_engineer", content: "@Kai · 研发工程师 请在绑定仓库完成研发交付" });
  assert.equal(store.listDispatches(run.id).find((item) => item.messageIds.includes(sent.message.id)).purpose, "manager");

  await executeRun(store, run.id, { runFilesRoot: join(root, "audit") });

  const workspace = store.getRunWorkspace(run.id);
  assert.equal(workspace.run.status, "awaiting_acceptance", "manager controls the handoff to the human");
  const engineerTrace = workspace.traces.find((trace) => trace.agentId === "agent_engineer" && trace.type === "node");
  assert.ok(engineerTrace, "the engineer ran a real node delivery through invokeDispatch");
  assert.equal(engineerTrace.workflowNodeId, "development", "formally dispatched node, never nodes[0]");
  assert.ok(!workspace.traces.some((trace) => trace.agentId === "agent_engineer" && trace.workflowNodeId === "requirements"), "no silent first-node binding anywhere");
  assert.ok(workspace.artifacts.some((artifact) => artifact.name === "repos/app/FEATURE.md"), "the developer's legitimate write in the bound repository was accepted by the real capture");
  assert.ok(workspace.messages.some((message) => message.kind === "manager_decision"), "the formal manager dispatch is visible in the collaboration record");

  // The console prompt snapshot must equal the platform-assembled dispatch
  // prompt (fixture hashes argv, which adds only the fixed history wrapper).
  assert.ok(engineerTrace.promptRef, "the dispatch persisted a prompt snapshot reference");
  const snapshotFiles = createRunFiles({ root: join(root, "audit") });
  const snapshot = await snapshotFiles.readConsoleContent(store.getTracePromptReference(run.id, engineerTrace.id));
  assert.equal(snapshot.kind, "prompt-snapshot");
  assert.equal(snapshot.prompt.redacted, false, "fixture prompt contains no credential shapes");
  assert.equal(snapshot.prompt.truncated, false);
  assert.match(snapshot.prompt.text, /真实链路/);
  assert.match(snapshot.prompt.text, /当前投递：/);
  const received = snapshot.prompt.text;
  const receivedHash = createHash("sha256").update(received, "utf8").digest("hex");
  const delivered = await readFile(join(workspace.run.task.workspacePath, "repos/app/FEATURE.md"), "utf8");
  assert.ok(delivered.includes(`PROMPT_SHA256:${receivedHash}`), "the snapshot matches the dispatch prompt the provider actually received");

  // Run 2: assigned-member @ regression — the declared directory is guidance,
  // not an execution permission boundary.
  const task2 = store.createTask({ title: "真实链路回归", objective: "已分配成员回归与越界", teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery", nodeAssignments: { requirements: "agent_analyst", design: "agent_designer", development: "agent_engineer", testing: "agent_tester", bug_fix: "agent_engineer", regression: "agent_tester" }, managerRuntime: { provider: "claude-code", executable } });
  const run2 = store.createRun(task2.id);
  store.updateRun(run2.id, { status: "running" }); store.setTaskStatus(run2.taskId, "running");
  const prior = store.enqueueDispatch(run2.id, { recipientAgentId: "agent_engineer", workflowNodeId: "development", purpose: "node" });
  store.claimDispatch(run2.id); store.completeDispatch(prior.id);
  const sent2 = store.submitHumanMessage(run2.id, { recipientAgentId: "agent_engineer", content: "@Kai · 研发工程师 请继续研发" });
  const instruction = store.listDispatches(run2.id).find((item) => item.messageIds.includes(sent2.message.id));
  assert.equal(instruction.purpose, "instruction");
  assert.equal(instruction.workflowNodeId, "development");

  await executeRun(store, run2.id, { runFilesRoot: join(root, "audit") });

  const workspace2 = store.getRunWorkspace(run2.id);
  const instructionTrace = workspace2.traces.find((trace) => trace.type === "instruction");
  assert.ok(instructionTrace, "the instruction ran through the real invokeDispatch");
  assert.ok(instructionTrace.promptRef, "the completed Trace keeps its prompt snapshot");
  assert.equal(instructionTrace.status, "completed", "a cross-directory write is accepted");
  assert.equal(instructionTrace.workflowNodeId, "development");
  const retried = workspace2.dispatches.find((item) => item.id === instruction.id);
  assert.equal(retried.status, "done");
  assert.ok(workspace2.artifacts.some((artifact) => artifact.name === "docs/requirements/brief.md"));

  // Run 3: a failed developer subprocess writes repository source/tests; its
  // retry writes only a report. The original code files must still be captured.
  const task3 = store.createTask({ title: "失败重试代码", objective: "失败后源码和测试仍应接纳", teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery", nodeAssignments: { requirements: "agent_analyst", design: "agent_designer", development: "agent_engineer", testing: "agent_tester", bug_fix: "agent_engineer", regression: "agent_tester" }, managerRuntime: { provider: "claude-code", executable } });
  const run3 = store.createRun(task3.id);
  await executeRun(store, run3.id, { runFilesRoot: join(root, "audit") });
  const first3 = store.getRunWorkspace(run3.id);
  const failed3 = first3.traces.find((trace) => trace.type === "node" && trace.status === "failed");
  assert.ok(failed3, "the first developer invocation actually failed after writing code");
  assert.equal(first3.artifacts.length, 0);
  store.retryScheduledDispatches(run3.id);
  await executeRun(store, run3.id, { runFilesRoot: join(root, "audit") });
  const complete3 = store.getRunWorkspace(run3.id);
  assert.equal(complete3.run.status, "awaiting_acceptance");
  assert.equal(complete3.traces.find((trace) => trace.id === failed3.id).status, "failed");
  assert.deepEqual(complete3.artifacts.map((artifact) => artifact.name).sort(), ["docs/development/report.md", "repos/app/SOURCE.js", "repos/app/SOURCE.test.js",'retry-marker']);
  assert.equal(complete3.artifacts.filter((artifact) => artifact.category === "code").length, 2);
});

// Deterministic failure self-healing (task_mvlrlhko_16o): the same
// workspace/protocol rejection twice in a row must stop the identical backoff
// loop and escalate to the manager with the failure facts; transient provider
// failures keep the existing retry behaviour and never escalate.

test("store records failure signatures and only claimed business dispatches can escalate", () => {
  const store = createFixtureStore();
  const run = store.createRun(store.listTasks()[0].id);
  store.updateRun(run.id, { status: "running" }); store.setTaskStatus(run.taskId, "running");
  const delivery = store.enqueueDispatch(run.id, { recipientAgentId: "agent_tester", workflowNodeId: "testing", purpose: "instruction" });
  store.claimDispatch(run.id);
  const retried = store.retryDispatch(delivery.id, "协议错误A", 300000, { kind: "protocol", signature: "protocol:协议错误", streak: 1 });
  assert.equal(retried.lastErrorKind, "protocol");
  assert.equal(retried.lastErrorSignature, "protocol:协议错误");
  assert.equal(retried.errorStreak, 1);
  assert.equal(retried.status, "queued");
  assert.throws(() => store.escalateFailedDispatch(delivery.id, { error: "x", kind: "protocol", signature: "s" }), /未领取/, "a queued dispatch is not mid-invocation and cannot escalate");
  const managerDelivery = store.enqueueDispatch(run.id, { recipientAgentId: run.manager.id, workflowNodeId: "requirements", purpose: "manager" });
  assert.equal(store.claimDispatch(run.id).id, managerDelivery.id);
  assert.throws(() => store.escalateFailedDispatch(managerDelivery.id, { error: "x", kind: "protocol", signature: "s" }), /只有业务投递/, "manager/review dispatches keep the existing retry semantics");
  store.completeDispatch(managerDelivery.id);
  store.retryScheduledDispatches(run.id);
  assert.equal(store.claimDispatch(run.id).id, delivery.id);
  const escalated = store.escalateFailedDispatch(delivery.id, { error: "协议错误A", kind: "protocol", signature: "protocol:协议错误", streak: 2 });
  assert.equal(escalated.status, "cancelled");
  assert.equal(escalated.errorStreak, 2);
  assert.ok(escalated.escalatedAt);
  assert.equal(escalated.nextRetryAt, null, "no further automatic retry is scheduled");
  const escalation = store.listDispatches(run.id).find((item) => item.dedupeKey === "escalate:" + delivery.id);
  assert.equal(escalation.purpose, "manager");
  assert.equal(escalation.recipientAgentId, run.manager.id);
  assert.equal(escalation.messageIds.length, 1, "the escalation dispatch carries the failure facts message");
  const note = store.getRunWorkspace(run.id).messages.find((item) => item.id === escalation.messageIds[0]);
  assert.equal(note.kind, "escalation");
  assert.match(note.content, /自动升级/);
  assert.match(note.content, /协议错误A/, "the manager receives the real failure summary");
  const event = store.timeline(run.id).find((item) => item.type === "dispatch.escalated");
  assert.equal(event.data.failureKind, "protocol");
  assert.equal(event.data.dispatchId, delivery.id);
  assert.ok(store.getRunWorkspace(run.id, { summary: true }).events.some((item) => item.type === "dispatch.escalated"), "the summary projection keeps escalation visible to CLI/Web");
  assert.equal(store.claimDispatch(run.id).id, escalation.id, "the cancelled dispatch is never claimed again; the manager escalation is next");
});

test("real orchestration keeps provider retries and protocol escalation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-escalation-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const executable = join(root, "provider.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const userPrompt = process.argv.at(-1) || "";
const instructionFlag = process.argv.indexOf("--append-system-prompt-file");
const systemPrompt = instructionFlag < 0 ? "" : (await import("node:fs")).readFileSync(process.argv[instructionFlag+1],"utf8");
const prompt = "[应用系统指令]" + String.fromCharCode(10) + systemPrompt + String.fromCharCode(10,10) + "[本轮输入]" + String.fromCharCode(10) + userPrompt;
const out = { kind: "node_result", summary: "fixture", artifacts: [], decisions: [], defects: [], resolvesDefectIds: [], verifiedDefectIds: [], needsHuman: false, consultation: null, inputAssessment: { sufficient: true, sourceNodeIds: [], rationale: "输入充分", missingEvidence: [] }, deliveryReview: null, managerDecision: null };
if (prompt.includes('"purpose":"delivery_review"')) {
  out.deliveryReview = { verdict: "pass", restartFromNodeId: "testing", findings: ["团队已修复并复核真实交付"] };
} else if (prompt.includes("任务级项目经理") && prompt.includes("确定性工作区失败")) {
  if (prompt.includes("已清理本轮越界暂存并重新交付")) {
    out.managerDecision = { nextNodeId: null, nextAgentId: null, rationale: "成员修复已接纳" };
  } else {
    out.summary = "自动升级后由测试成员清理本轮越界暂存";
    out.managerDecision = { nextNodeId: "testing", nextAgentId: "agent_tester", rationale: "团队内部可修复" };
  }
} else if (prompt.includes("任务级项目经理")) {
  out.needsHuman = true;
  out.inputAssessment = { sufficient: false, sourceNodeIds: [], rationale: "需要人类决策", missingEvidence: ["人类判断"] };
  out.consultation = { audience: "human", recipientAgentId: "", question: "确定性失败已升级，请人类决策", questionType: "escalation", routingReason: "团队无法修复的确定性失败", consideredMemberIds: ["agent_tester"] };
} else if (prompt.includes('"workflowNodeId":"testing"')) {
  if (prompt.includes("变动错误") && prompt.includes('"lastErrorKind":"workspace_artifact"')) {
    console.log(JSON.stringify({ type: "result", result: "这不是合法JSON" }));
    process.exit(0);
  }
  if ((prompt.includes("自动修复") && prompt.includes('"lastErrorKind":"workspace_artifact"') && prompt.includes("这是本次优先处理的修复事项")) || prompt.includes("自动升级后由测试成员清理本轮越界暂存")) {
    rmSync("docs/requirements", { recursive: true, force: true });
    mkdirSync("docs/testing", { recursive: true });
    writeFileSync("docs/testing/report.md", "已清理本轮越界暂存并重新交付\\n");
    out.summary = "已清理本轮越界暂存并重新交付";
  } else {
    mkdirSync("docs/requirements", { recursive: true });
    writeFileSync("docs/requirements/brief.md", "越界写入\\n");
  }
} else if (prompt.includes('"workflowNodeId":"requirements"')) {
  process.exit(1);
} else if (prompt.includes('"workflowNodeId":"design"')) {
  console.log(JSON.stringify({ type: "result", result: "这不是合法JSON" }));
  process.exit(0);
}
if(out.managerDecision?.nextNodeId && !out.managerDecision.nextAgentId) out.managerDecision.nextAgentId = ({development:"agent_engineer",develop:"agent_engineer",testing:"agent_tester",regression:"agent_tester",architecture:"agent_designer"})[out.managerDecision.nextNodeId] || "agent_analyst";
console.log(JSON.stringify({ type: "result", result: JSON.stringify(out) }));
`);
  await chmod(executable, 0o755);
  const store = createCatalogFixtureStore({ workspaceRoot: join(root, "workspaces") });
  for (const agent of store.listAgents()) store.updateAgent(agent.id, { runtime: { provider: "claude-code", executable } });
  const assignments = { requirements: "agent_analyst", design: "agent_designer", development: "agent_engineer", testing: "agent_tester", bug_fix: "agent_engineer", regression: "agent_tester" };
  const makeRun = (title) => {
    const task = store.createTask({ title, objective: "自愈验证", teamId: store.listTeams()[0].id, workflowTemplateId: "software_delivery", nodeAssignments: assignments });
    const run = store.createRun(task.id);
    store.updateRun(run.id, { status: "running" }); store.setTaskStatus(task.id, "running");
    return run;
  };

  // Unknown process failures stop automatically; they are not assumed transient.
  const run2 = makeRun("Provider 抖动");
  const flaky = store.enqueueDispatch(run2.id, { recipientAgentId: "agent_analyst", workflowNodeId: "requirements", purpose: "node", dedupeKey: "flaky" });
  await executeRun(store, run2.id, { runFilesRoot: join(root, "audit") });
  assert.throws(() => store.retryScheduledDispatches(run2.id), /没有等待退避/);
  let current = store.getDispatch(flaky.id);
  assert.equal(current.status, "cancelled", "unknown failures must not loop");
  assert.equal(current.lastErrorKind, "provider");
  assert.equal(current.errorStreak, 1);
  assert.equal(current.nextRetryAt, null);
  assert.equal(store.getRun(run2.id).status, 'failed');
  assert.match(current.lastError, /exit=1/);
  assert.ok(!store.listDispatches(run2.id).some((item) => item.dedupeKey === "escalate:" + flaky.id));
  assert.ok(!store.timeline(run2.id).some((item) => item.type === "dispatch.escalated"));

  const run3 = makeRun("普通文字交接");
  const delivery = store.enqueueDispatch(run3.id, { recipientAgentId: "agent_designer", workflowNodeId: "design", purpose: "node", dedupeKey: "text" });
  await executeRun(store, run3.id, { runFilesRoot: join(root, "audit") });
  assert.equal(store.getDispatch(delivery.id).status, "done");
  assert.ok(store.getRunWorkspace(run3.id).messages.some(item => item.content === "这不是合法JSON"));
  assert.equal(store.timeline(run3.id).some(item => item.type === "dispatch.escalated"), false);
});
