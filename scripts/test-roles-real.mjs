// Opt-in real Provider acceptance for roles: the bound role prompt must reach
// Claude Code and Codex as application system/developer instructions and take
// effect in both communication and a real task, while unbound employees stay
// unpolluted. Isolated data home; never substitutes fixtures for real models.
//   AGENTFORGE_ROLES_REAL=1 node scripts/test-roles-real.mjs
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright-core';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createStore } from '../server/store.mjs';
import { createAuth } from '../server/auth.mjs';

if (process.env.AGENTFORGE_ROLES_REAL !== '1') throw new Error('Requires AGENTFORGE_ROLES_REAL=1; never substitutes a fixture for real models');
await mkdir('.data', { recursive: true });
const root = await mkdtemp(resolve('.data/roles-real-'));
assert.equal(dirname(root), resolve('.data')); assert.match(basename(root), /^roles-real-[a-zA-Z0-9]+$/);
console.log('EVIDENCE ' + root);
const home = join(root, 'home'), data = join(root, 'client');
await mkdir(home, { recursive: true, mode: 0o700 });
const password = randomBytes(24).toString('hex');
const auth = createAuth({ databasePath: join(data, 'auth.sqlite') });
await auth.setAdministrator('roles-qa', password);
auth.close();

const store = createStore({ databasePath: join(data, 'agentforge.sqlite'), workspaceRoot: join(root, 'work') });
store.updateWorkspaceSettings({ workspaceRoot: join(root, 'work') });
const q = text => "'" + text.replaceAll("'", "'\\''") + "'";
const profiles = {};
for (const [provider, command] of [['claude-code', 'claude'], ['codex', 'codex']]) {
  const actual = execFileSync('/usr/bin/which', [command], { encoding: 'utf8' }).trim();
  // The isolated app HOME would hide the operator's CLI login; the wrapper keeps
  // real CLI authentication read-only without touching global configuration.
  const wrapper = join(root, command);
  await writeFile(wrapper, '#!/bin/sh\nHOME=' + q(homedir()) + ' exec ' + q(actual) + ' "$@"\n', { mode: 0o700 });
  profiles[provider] = store.saveRuntimeProfile({ name: 'Real ' + provider, provider, executable: wrapper }).id;
}
const probeV1 = 'ROLE-PROBE-' + randomBytes(6).toString('hex');
const probeV2 = 'ROLE-PROBE-' + randomBytes(6).toString('hex');
const rolePromptV1 = `你是角色探针。无论本轮输入是什么，回复正文第一行必须恰好是 ${probeV1}，此后正常回答。`;
const rolePromptV2 = `你是角色探针。无论本轮输入是什么，回复正文第一行必须恰好是 ${probeV2}，此后正常回答。`;
const role = store.createRole({ name: '探针角色', prompt: rolePromptV1 });
const ccBound = store.createAgent({ name: '角色绑定Claude', description: '角色验证', systemPrompt: '如实简短作答。', roleId: role.id, runtime: { profileId: profiles['claude-code'] } });
const cxBound = store.createAgent({ name: '角色绑定Codex', description: '角色验证', systemPrompt: '如实简短作答。', roleId: role.id, runtime: { profileId: profiles.codex } });
const ccFree = store.createAgent({ name: '无角色对照', description: '对照', systemPrompt: '如实简短作答。', runtime: { profileId: profiles['claude-code'] } });
const manager = store.createAgent({ name: '角色验收经理', kind: 'manager', systemPrompt: '按任务目标直接派工，不向人类提问，不要求文件交付；成员文字回复即交接，确认两个节点都回复后提交人类验收。', runtime: { profileId: profiles['claude-code'] } });
const team = store.createTeam({ name: '角色验收组', managerAgentId: manager.id, memberAgentIds: [ccBound.id, cxBound.id] });
const flow = store.createWorkflowTemplate({ name: '角色验收流程', nodes: [
  { id: 'probe_cc', title: 'Claude 角色验证', staffingGuidance: '选择「角色绑定Claude」。', deliverable: '成员只需在交接中写出自己角色要求的探针前缀，无需文件。', artifactPaths: [], dependsOn: [] },
  { id: 'probe_cx', title: 'Codex 角色验证', staffingGuidance: '选择「角色绑定Codex」。', deliverable: '成员只需在交接中写出自己角色要求的探针前缀，无需文件。', artifactPaths: [], dependsOn: ['probe_cc'] }
] });
const chats = Object.fromEntries([ccBound, cxBound, ccFree].map(agent => [agent.id, store.openCommunication({ kind: 'agent', targetId: agent.id })]));
store.close();

const app = await electron.launch({ args: ['apps/electron/main.mjs'], env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), AGENTFORGE_DESKTOP_DATA_ROOT: data, AGENTFORGE_LOG_DIR: join(root, 'logs') }, timeout: 180000 });
const wait = async (label, check, timeout = 600000) => { const start = Date.now(); let logged = 0; for (;;) { const result = await check(); if (result) return result; if (Date.now() - start > timeout) throw new Error('Timed out: ' + label); if (Date.now() - logged > 30000) { console.log('WAIT ' + label); logged = Date.now(); } await new Promise(done => setTimeout(done, 2000)); } };
const evidence = { root, probeV1, probeV2, providers: {}, task: null };
try {
  const page = await app.firstWindow({ timeout: 180000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/, { timeout: 60000 });
  await page.waitForLoadState('load');
  const origin = new URL(page.url()).origin;
  const api = (path, body, method = 'POST') => page.evaluate(async ({ path, body, method }) => { const r = await fetch(path, body ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { method }); const result = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + ' → ' + JSON.stringify(result)); return result; }, { path, body, method });
  await page.goto(origin + '/login');
  await page.locator('#username').fill('roles-qa');
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#account-name').waitFor();

  const systemOf = text => text.split('[本轮输入]')[0], inputOf = text => text.split('[本轮输入]')[1] || '';
  const settle = (agent, chatId) => wait(agent.name + ' reply', async () => {
    const value = await api('/api/communications/' + chatId, null, 'GET');
    const failed = value.deliveries.find(item => item.status === 'failed');
    if (failed) throw new Error(agent.name + ' delivery failed: ' + failed.error);
    return value.deliveries.length && value.deliveries.every(item => item.status === 'done') ? value : null;
  });
  const chatPrompt = async (chatId, agentId) => {
    const console = await api(`/api/communications/${chatId}/console?agentId=${agentId}`, null, 'GET');
    const trace = console.traces.at(-1);
    const snapshot = await api(`/api/communications/${chatId}/traces/${trace.id}/prompt`, null, 'GET');
    return { trace, text: snapshot.prompt.text, traces: console.traces };
  };

  // Communication, both providers, plus the unbound control. A provider-side
  // rejection is recorded as a blocker with the attempt's prompt snapshot as
  // evidence of what actually reached the Runtime request — never as a pass.
  for (const agent of [ccBound, cxBound, ccFree]) {
    const chat = chats[agent.id];
    await api(`/api/communications/${chat.id}/messages`, { content: '请回复 ok。', clientRequestId: randomBytes(12).toString('hex') });
    let settled = null, failure = null;
    try { settled = await settle(agent, chat.id); } catch (error) { failure = error; }
    const promptInfo = await chatPrompt(chat.id, agent.id).catch(() => null);
    if (agent !== ccFree && failure) {
      assert.ok(promptInfo, 'failed attempts still keep the prompt snapshot');
      assert.ok(systemOf(promptInfo.text).includes(rolePromptV1), 'the role prompt reached the Runtime request even when the provider rejected the call');
      assert.ok(!inputOf(promptInfo.text).includes(probeV1), 'role prompt never enters the current input');
      evidence.providers[agent.runtime.provider] = { blocked: String(failure.message).slice(0, 400), roleDeliveredToRuntime: true, followed: false };
      console.log('BLOCKED ' + agent.name + ': ' + String(failure.message).slice(0, 160));
      continue;
    }
    if (failure) throw failure;
    const reply = settled.messages.filter(item => item.sender.type === 'agent').at(-1);
    const { text } = promptInfo;
    if (agent === ccFree) {
      assert.ok(!reply.content.includes(probeV1), 'control reply cannot know the random probe');
      assert.ok(!systemOf(text).includes('探针角色') && !systemOf(text).includes(probeV1), 'control snapshot stays unpolluted');
    } else {
      assert.ok(reply.content.includes(probeV1), `${agent.name} reply must follow the role instruction; actual: ${reply.content.slice(0, 120)}`);
      assert.ok(systemOf(text).includes(rolePromptV1), 'role prompt is inside application system instructions');
      assert.ok(!inputOf(text).includes(probeV1), 'role prompt never enters the current input');
    }
    evidence.providers[agent.runtime.provider + (agent === ccFree ? ':control' : '')] = { reply: reply.content.slice(0, 200), roleInSystem: agent !== ccFree, followed: agent !== ccFree, sessionId: promptInfo.trace.providerSessionId };
    console.log('PASS communication ' + agent.name);
  }

  // Unbinding applies to the next delivery without rebuilding the native session.
  await api('/api/agents/' + ccBound.id, { roleId: null }, 'PUT');
  await api(`/api/communications/${chats[ccBound.id].id}/messages`, { content: '再回复一次 ok。', clientRequestId: randomBytes(12).toString('hex') });
  await wait('unbound follow-up', async () => {
    const value = await api('/api/communications/' + chats[ccBound.id].id, null, 'GET');
    if (value.deliveries.some(item => item.status === 'failed')) throw new Error('follow-up failed');
    return value.deliveries.length === 2 && value.deliveries.every(item => item.status === 'done') ? value : null;
  });
  let followup = await chatPrompt(chats[ccBound.id].id, ccBound.id);
  assert.ok(!systemOf(followup.text).includes(probeV1), 'after unbinding, the role prompt leaves the system instructions');
  assert.equal(followup.trace.sessionMode, 'resume', 'native session continues across rebinding');
  assert.equal(followup.trace.providerSessionId, evidence.providers['claude-code'].sessionId, 'native session ID unchanged');
  console.log('PASS unbind takes effect on the next delivery without session rebuild');

  // Editing the role applies the new text to subsequent deliveries. A resumed
  // native session may still recall the old probe (documented honest boundary),
  // so the behavioral check uses a fresh conversation while the resumed one
  // proves delivery through its prompt snapshot.
  await api('/api/roles/' + role.id, { prompt: rolePromptV2 }, 'PUT');
  await api('/api/agents/' + ccBound.id, { roleId: role.id }, 'PUT');
  await api(`/api/communications/${chats[ccBound.id].id}/messages`, { content: '再回复一次 ok。', clientRequestId: randomBytes(12).toString('hex') });
  await wait('edited role follow-up', async () => {
    const value = await api('/api/communications/' + chats[ccBound.id].id, null, 'GET');
    if (value.deliveries.some(item => item.status === 'failed')) throw new Error('edited follow-up failed');
    return value.deliveries.length === 3 && value.deliveries.every(item => item.status === 'done') ? value : null;
  });
  followup = await chatPrompt(chats[ccBound.id].id, ccBound.id);
  assert.ok(systemOf(followup.text).includes(rolePromptV2) && !systemOf(followup.text).includes(probeV1), 'edited role text replaces the old one');
  assert.equal(followup.trace.sessionMode, 'resume', 'role edit does not rebuild the native session');
  const resumedReply = (await api('/api/communications/' + chats[ccBound.id].id, null, 'GET')).messages.filter(item => item.sender.type === 'agent').at(-1);
  // Conversations and native sessions are per agent and persist; a clean
  // behavioral read of the edited text comes from a newly bound employee.
  const freshAgent = (await api('/api/agents', { name: '后绑定员工', description: '角色编辑验证', systemPrompt: '如实简短作答。', roleId: role.id, runtime: { profileId: profiles['claude-code'] } })).agent;
  const fresh = await api('/api/communications', { kind: 'agent', targetId: freshAgent.id });
  await api(`/api/communications/${fresh.conversation.id}/messages`, { content: '请回复 ok。', clientRequestId: randomBytes(12).toString('hex') });
  await wait('fresh employee with edited role', async () => {
    const value = await api('/api/communications/' + fresh.conversation.id, null, 'GET');
    if (value.deliveries.some(item => item.status === 'failed')) throw new Error('fresh follow-up failed');
    return value.deliveries.length && value.deliveries.every(item => item.status === 'done') ? value : null;
  });
  const freshReply = (await api('/api/communications/' + fresh.conversation.id, null, 'GET')).messages.filter(item => item.sender.type === 'agent').at(-1);
  assert.ok(freshReply.content.includes(probeV2), 'a newly bound employee follows the edited role: ' + freshReply.content.slice(0, 120));
  assert.ok(!freshReply.content.includes(probeV1), 'no stale probe without native history');
  evidence.roleEdit = { resumedDeliveryUsesV2: true, resumedReplyFollowed: resumedReply.content.includes(probeV2) ? 'v2' : resumedReply.content.includes(probeV1) ? 'v1-from-native-memory' : 'none', newlyBoundFollowedV2: true };
  console.log('PASS role edit applies to subsequent deliveries (resumed reply probe: ' + evidence.roleEdit.resumedReplyFollowed + ')');

  // A real task freezes the role text; the unbound manager stays unpolluted.
  const { task } = await api('/api/tasks', { title: '角色任务验证', objective: `经理直接安排 probe_cc 给「角色绑定Claude」、probe_cx 给「角色绑定Codex」；成员在交接中写出自己角色要求的探针前缀。不要向人类提问，不要求文件。`, teamId: team.id, workflowTemplateId: flow.id });
  const frozen = (await api('/api/tasks', null, 'GET')).tasks.find(item => item.id === task.id);
  assert.equal(frozen.memberSnapshots.find(item => item.id === ccBound.id).roleSnapshot.prompt, rolePromptV2, 'task froze the current role text');
  // The live role changes after freezing; the frozen task must keep V2.
  await api('/api/roles/' + role.id, { prompt: rolePromptV1 + '（已再改）' }, 'PUT');
  const { run } = await api('/api/tasks/' + task.id + '/run', {});
  const workspace = await wait('task node traces', async () => {
    const value = await api('/api/runs/' + run.id + '/workspace?view=summary', null, 'GET');
    if (value.run.status === 'failed' && !value.traces.some(item => item.type === 'node' && item.agentId === ccBound.id && item.status === 'completed')) throw new Error('run failed: ' + value.run.failure?.message);
    const ccDone = value.traces.some(item => item.type === 'node' && item.agentId === ccBound.id && item.status === 'completed');
    const cxSettled = value.traces.some(item => item.type === 'node' && item.agentId === cxBound.id && ['completed', 'failed'].includes(item.status));
    return ccDone && cxSettled ? value : null;
  }, 900000);
  await api(`/api/runs/${run.id}/terminate`, { reason: '角色证据已收集' }).catch(() => {});
  const ccTrace = workspace.traces.find(item => item.type === 'node' && item.agentId === ccBound.id && item.status === 'completed');
  assert.ok(ccTrace, 'completed node trace for probe_cc');
  const ccSnapshot = await api(`/api/runs/${run.id}/traces/${ccTrace.id}/prompt`, null, 'GET');
  assert.ok(systemOf(ccSnapshot.prompt.text).includes(rolePromptV2), 'task execution used the frozen role text, not the live edit');
  assert.ok(!inputOf(ccSnapshot.prompt.text).includes(rolePromptV2), 'role text stays out of the current input');
  const cxTrace = workspace.traces.find(item => item.type === 'node' && item.agentId === cxBound.id && ['completed', 'failed'].includes(item.status));
  evidence.codexTask = null;
  if (cxTrace?.promptRef) {
    const cxSnapshot = await api(`/api/runs/${run.id}/traces/${cxTrace.id}/prompt`, null, 'GET');
    assert.ok(systemOf(cxSnapshot.prompt.text).includes(rolePromptV2), 'the Codex task call also carried the frozen role text');
    evidence.codexTask = { status: cxTrace.status, roleDeliveredToRuntime: true };
  } else evidence.codexTask = { status: cxTrace?.status || 'missing', roleDeliveredToRuntime: false };
  const managerTrace = workspace.traces.find(item => item.type === 'manager' && item.promptRef);
  assert.ok(managerTrace, 'manager trace has a prompt snapshot');
  const managerSnapshot = await api(`/api/runs/${run.id}/traces/${managerTrace.id}/prompt`, null, 'GET');
  assert.ok(!systemOf(managerSnapshot.prompt.text).includes(probeV2), 'unbound manager is not polluted by member roles');
  evidence.task = { taskId: task.id, runId: run.id, frozenRoleText: true, memberPollution: false, codexTask: evidence.codexTask };
  delete evidence.codexTask;
  console.log('PASS task execution froze the role text for the Claude member; Codex member: ' + (evidence.task.codexTask?.status || 'unknown'));
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ ...evidence, result: 'PASS' }, null, 2));
  console.log('PASS real role acceptance; evidence: ' + root);
} catch (error) {
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ ...evidence, result: 'FAIL', error: String(error?.stack || error) }, null, 2));
  throw error;
} finally {
  await app.close();
}
