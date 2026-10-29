import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { probeRuntime } from '../server/runtime/probe.mjs';
import { registerExecution } from '../server/runtime/registry.mjs';

test('Runtime deletion is atomic, protects real references and preserves frozen work across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-profile-delete-'));
  const options = { databasePath: join(root, 'state.sqlite'), workspaceRoot: root };
  let store = createStore(options);
  const defaults = store.listRuntimeProfiles();
  assert.equal(defaults.length, 2);
  const profile = store.saveRuntimeProfile({ name: 'Disposable', provider: 'claude-code', model: 'frozen' });
  const worker = store.createAgent({ name: 'Worker', role: 'writer', runtime: { profileId: profile.id } });
  const team = store.createTeam({ name: 'T', memberAgentIds: [worker.id] });
  const flow = store.createWorkflowTemplate({ name: 'F', nodes: [{ id: 'write', title: 'Write', staffingGuidance: 'Writer' }] });
  const task = store.createTask({ title: 'Frozen', objective: 'Write', teamId: team.id, workflowTemplateId: flow.id });
  const chat = store.openCommunication({ kind: 'agent', targetId: worker.id });
  store.sendCommunication(chat.id, { content: 'Question', clientRequestId: randomUUID(), mentionAgentIds: [] });
  assert.throws(() => store.deleteRuntimeProfile(profile.id), /仍被/);
  store.updateAgent(worker.id, { status: 'inactive' });
  assert.throws(() => store.deleteRuntimeProfile(profile.id), /停用/);
  store.updateAgent(worker.id, { status: 'active', runtime: { profileId: defaults[0].id } });
  const before = store.snapshot();
  assert.throws(() => store.transaction(() => { store.deleteRuntimeProfile(profile.id); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.deleteRuntimeProfile(profile.id).id, profile.id);
  assert.ok(!store.listRuntimeProfiles().some(item => item.id === profile.id));
  assert.equal(store.getTask(task.id).memberSnapshots[0].runtime.profileId, profile.id);
  const delivery = store.claimCommunication(chat.id);
  assert.equal(delivery.agentSnapshot.runtime.profileId, profile.id);
  assert.equal(store.snapshot().events.filter(event => event.type === 'settings.runtime_deleted').length, 1);
  assert.throws(() => store.deleteRuntimeProfile(profile.id), /不存在/);
  const unusedDefault = defaults.find(item => item.provider === 'codex');
  store.saveRuntimeProfile({ name: 'Renamed Codex', provider: 'codex' }, unusedDefault.id);
  store.deleteRuntimeProfile(unusedDefault.id);
  assert.throws(() => store.deleteRuntimeProfile(defaults[0].id), /仍被/);
  store.close(); store = createStore(options);
  assert.ok(!store.listRuntimeProfiles().some(item => item.id === profile.id));
  assert.ok(!store.listRuntimeProfiles().some(item => item.id === unusedDefault.id));
  assert.ok(store.listRuntimeProfiles().every(item => !item.system));
  store.close();
});

test('central runtime edits update bound employees but preserve queued work and survive restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentforge-profiles-'));
  const options = { databasePath: join(root, 'state.sqlite'), workspaceRoot: root };
  let store = createStore(options);
  const profile = store.saveRuntimeProfile({ name: 'Shared Claude', provider: 'claude-code', model: 'test-model' });
  const a = store.createAgent({ name: 'A', role: 'writer', runtime: { profileId: profile.id } });
  const b = store.createAgent({ name: 'B', role: 'writer', runtime: { profileId: profile.id, skillPaths: [join(root, 'skill.md')] } });
  const team = store.createTeam({ name: 'Test', memberAgentIds: [a.id, b.id] });
  const flow = store.createWorkflowTemplate({ name: 'Write', nodes: [{ id: 'write', title: 'Write', staffingGuidance: 'writer', dependsOn: [] }] });
  const task = store.createTask({ title: 'Frozen', objective: 'Write a document', teamId: team.id, workflowTemplateId: flow.id });
  store.saveRuntimeProfile({ name: 'Changed', provider: 'claude-code', model: 'next-model' }, profile.id);
  assert.equal(store.listAgents().find(item => item.id === a.id).runtime.model, 'next-model');
  assert.deepEqual(store.listAgents().find(item => item.id === b.id).runtime.skillPaths, [join(root, 'skill.md')]);
  assert.equal(store.getTask(task.id).memberSnapshots[0].runtime.model, 'test-model');
  assert.throws(() => store.saveRuntimeProfile({ name: 'Bad', provider: 'codex' }, profile.id), /Provider/);
  assert.throws(() => store.saveRuntimeProfile({ name: 'Bad', token: 'secret' }), /字段/);
  assert.throws(() => store.saveRuntimeProfile({ name: 'Changed', provider: 'claude-code' }), /名称已存在/);
  assert.throws(() => store.createAgent({ name: 'Bad', role: 'writer', runtime: { profileId: 'missing' } }), /不存在/);
  const expected = store.listRuntimeProfiles(); store = createStore(options);
  assert.deepEqual(store.listRuntimeProfiles(), expected);
  assert.equal(store.listAgents().find(item => item.id === a.id).runtime.profileId, profile.id);
  assert.equal(store.getTask(task.id).memberSnapshots[0].runtime.model, 'test-model');
});

test('legacy concrete runtime configurations remain distinct and do not overwrite peers', () => {
  const store = createStore();
  const a = store.createAgent({ name: 'A', role: 'a', runtime: { model: 'one', executable: '/one/claude' } });
  const b = store.createAgent({ name: 'B', role: 'a', runtime: { model: 'two', executable: '/two/claude' } });
  assert.notEqual(a.runtime.profileId, b.runtime.profileId);
  store.updateAgent(a.id, { runtime: { model: 'three' } });
  assert.equal(store.listAgents().find(item => item.id === b.id).runtime.model, 'two');
});

test('runtime probe checks structured response, isolates extensions, and exposes only result/path', async () => {
  const profile = { id: 'probe', provider: 'claude-code', model: 'test' };
  const success = await probeRuntime(profile, { invoke: async input => {
    assert.deepEqual(input.runtime.extensionSelection, { pluginIds: [], mcpIds: [] });
    assert.equal(input.session, undefined);
    assert.equal(JSON.parse(await readFile(input.schemaPath)).additionalProperties, false);
    return { finalText: '{"status":"ok"}' };
  } });
  assert.equal(success.ok, true); assert.match(success.logPath, /\.jsonl$/);
  const invalid = await probeRuntime(profile, { invoke: async () => ({ finalText: 'model says done' }) });
  assert.equal(invalid.ok, false); assert.equal(invalid.error, undefined);
  const missing = await probeRuntime({ ...profile, executable: '/agentforge-test-missing-cli' });
  assert.equal(missing.ok, false);
  assert.match(await readFile(missing.logPath, 'utf8'), /provider.spawn_error/);
  const codexMissing = await probeRuntime({ ...profile, provider: 'codex', executable: '/agentforge-test-missing-codex' });
  assert.equal(codexMissing.ok, false);
  assert.match(await readFile(codexMissing.logPath, 'utf8'), /provider.configuration_probe_failed/);
});

test('new communication uses changed profile and resets the model session, queued delivery keeps its snapshot', () => {
  const store = createStore();
  const employee = store.listAgents().find(item => item.id === 'agent_analyst');
  const thread = store.openCommunication({ kind: 'agent', targetId: employee.id });
  const send = () => store.sendCommunication(thread.id, { content: 'hello', clientRequestId: randomUUID(), mentionAgentIds: [] });
  send();
  const first = store.claimCommunication(thread.id);
  const session = store.prepareCommunicationSession(thread.id, first.id, '/tmp/probe-chat');
  store.confirmCommunicationSession(thread.id, first.id, session.sessionId);
  store.completeCommunication(thread.id, first.id, 'reply');
  send();
  const profile = store.listRuntimeProfiles().find(item => item.id === employee.runtime.profileId);
  const { id, employeeCount, system, ...input } = profile;
  store.saveRuntimeProfile({ ...input, model: 'changed-model' }, id);
  const queued = store.claimCommunication(thread.id);
  assert.equal(queued.agentSnapshot.runtime.model, employee.runtime.model);
  assert.equal(store.prepareCommunicationSession(thread.id, queued.id, '/tmp/probe-chat').resume, true);
  store.completeCommunication(thread.id, queued.id, 'reply');
  send();
  const next = store.claimCommunication(thread.id);
  assert.equal(next.agentSnapshot.runtime.model, 'changed-model');
  const fresh = store.prepareCommunicationSession(thread.id, next.id, '/tmp/probe-chat');
  assert.equal(fresh.resume, false); assert.notEqual(fresh.sessionId, session.sessionId);
});

test('runtime probe deadline terminates only its own invocation and never reports late success', async () => {
  let terminated = false;
  const result = await probeRuntime({ id: 'timeout', provider: 'claude-code' }, { timeoutMs: 10, invoke: input => new Promise(resolve => {
    const unregister = registerExecution(input.executionKey, { terminate() { terminated = true; unregister(); resolve({ finalText: '{"status":"ok"}' }); } });
  }) });
  assert.equal(terminated, true); assert.equal(result.ok, false); assert.equal(result.timedOut, true);
});

test('runtime effort is validated per provider, reprojected to employees and frozen in existing work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-profile-effort-'));
  const options = { databasePath: join(root, 'state.sqlite'), workspaceRoot: root };
  let store = createStore(options);
  const claude = store.saveRuntimeProfile({ name: 'Effort Claude', provider: 'claude-code', model: 'sonnet', effort: 'high' });
  assert.equal(claude.effort, 'high');
  const codex = store.saveRuntimeProfile({ name: 'Effort Codex', provider: 'codex', effort: 'ultra' });
  assert.equal(codex.effort, 'ultra');
  for (const [input, pattern] of [
    [{ name: 'Bad 1', provider: 'claude-code', effort: 'ultra' }, /思考等级/],
    [{ name: 'Bad 2', provider: 'codex', effort: 'nonsense' }, /思考等级/],
    [{ name: 'Bad 3', provider: 'claude-code', effort: 'high\nrm' }, /单行/],
    [{ name: 'Bad 4', provider: 'claude-code', effort: 'high', token: 'x' }, /字段/]
  ]) assert.throws(() => store.saveRuntimeProfile(input), pattern);
  const worker = store.createAgent({ name: 'W', runtime: { profileId: claude.id } });
  assert.equal(store.listAgents().find(item => item.id === worker.id).runtime.effort, 'high');
  const team = store.createTeam({ name: 'T', memberAgentIds: [worker.id] });
  const flow = store.createWorkflowTemplate({ name: 'F', nodes: [{ id: 'write', title: 'Write', staffingGuidance: 'Writer' }] });
  const task = store.createTask({ title: 'Frozen', objective: 'Write', teamId: team.id, workflowTemplateId: flow.id });
  store.saveRuntimeProfile({ name: 'Effort Claude', provider: 'claude-code', model: 'opus', effort: 'max' }, claude.id);
  assert.equal(store.listAgents().find(item => item.id === worker.id).runtime.effort, 'max', 'profile edit reprojects effort to bound employees');
  assert.equal(store.getTask(task.id).memberSnapshots[0].runtime.effort, 'high', 'frozen task snapshot keeps the previous effort');
  assert.throws(() => store.saveRuntimeProfile({ name: 'Effort Claude', provider: 'claude-code', effort: 'ultra' }, claude.id), /思考等级/);
  const cleared = store.saveRuntimeProfile({ name: 'Effort Claude', provider: 'claude-code', effort: '' }, claude.id);
  assert.equal(cleared.effort, '');
  store.saveRuntimeProfile({ name: 'Effort Claude', provider: 'claude-code', effort: 'low' }, claude.id);
  store.close(); store = createStore(options);
  assert.equal(store.listRuntimeProfiles().find(item => item.id === claude.id).effort, 'low', 'effort survives restart');
  assert.equal(store.listRuntimeProfiles().find(item => item.id === codex.id).effort, 'ultra');
  store.close();
});

test('runtime probe passes the saved model and effort to the real invocation', async () => {
  const seen = [];
  const result = await probeRuntime({ id: 'effort-probe', provider: 'codex', model: 'gpt-real', effort: 'high' }, { invoke: async input => {
    seen.push(input.runtime);
    return { finalText: '{"status":"ok"}' };
  } });
  assert.equal(result.ok, true);
  assert.equal(seen[0].model, 'gpt-real');
  assert.equal(seen[0].effort, 'high');
});
