import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createFixtureStore, fixtureTaskInput } from './fixture-store.mjs';
import { taskPrompt, communicationPrompt } from '../server/prompts.mjs';
import { resources, documentation } from '../cli/commands.mjs';
import { execute as executeCommand, run as runCommand } from '../cli/main.mjs';

const input = value => Readable.from([typeof value === 'string' ? value : JSON.stringify(value ?? '')]);

test('role CRUD validates input, updates partially and records audit events', () => {
  const store = createFixtureStore();
  try {
    assert.throws(() => store.createRole({ name: '', prompt: 'x' }), /角色名称不能为空/);
    assert.throws(() => store.createRole({ name: 'x', prompt: '  ' }), /角色提示词不能为空/);
    assert.throws(() => store.createRole({ name: '长'.repeat(81), prompt: 'x' }), /最多 80 字符/);
    const role = store.createRole({ name: ' 事实核查员 ', prompt: '凡引用外部事实必须给出来源。' });
    assert.equal(role.name, '事实核查员');
    assert.match(role.id, /^role_/);
    assert.deepEqual(store.getRole(role.id).prompt, '凡引用外部事实必须给出来源。');
    assert.throws(() => store.updateRole(role.id, {}), /至少提供名称或提示词/);
    assert.throws(() => store.updateRole('role_missing', { name: 'x' }), /角色不存在/);
    const renamed = store.updateRole(role.id, { name: '独立核查' });
    assert.equal(renamed.prompt, '凡引用外部事实必须给出来源。', 'partial update keeps the prompt');
    assert.equal(store.updateRole(role.id, { prompt: '无法核实时明确标注。' }).name, '独立核查');
    const types = store.snapshot().events.filter(event => event.type.startsWith('configuration.role_')).map(event => event.type);
    assert.deepEqual(types, ['configuration.role_created', 'configuration.role_updated', 'configuration.role_updated']);
    store.deleteRole(role.id);
    assert.deepEqual(store.listRoles(), []);
    assert.equal(store.snapshot().events.at(-1).type, 'configuration.role_deleted');
    assert.throws(() => store.deleteRole(role.id), /角色不存在/);
  } finally { store.close(); }
});

test('employees bind at most one role; unknown roles are rejected and omission keeps the binding', () => {
  const store = createFixtureStore();
  try {
    const role = store.createRole({ name: '核查员', prompt: 'ROLE_PROMPT' });
    assert.throws(() => store.createAgent({ name: '坏绑定', roleId: 'role_missing' }), /绑定的角色不存在/);
    assert.throws(() => store.createAgent({ name: '坏绑定', roleId: 42 }), /绑定的角色不存在/);
    const created = store.createAgent({ name: '绑定员工', roleId: role.id });
    assert.equal(created.roleId, role.id);
    assert.equal(Object.hasOwn(created, 'role'), false, 'the retired legacy field name stays unused');
    assert.equal(created.roleSnapshot, undefined, 'live rows never embed role text');
    const plain = store.createAgent({ name: '无角色员工' });
    assert.equal(plain.roleId, null);
    store.updateAgent(created.id, { description: '只改简介' });
    assert.equal(store.listAgents().find(item => item.id === created.id).roleId, role.id, 'omitted roleId keeps the binding');
    assert.throws(() => store.updateAgent(created.id, { roleId: 'role_missing' }), /绑定的角色不存在/);
    store.updateAgent(created.id, { roleId: null });
    assert.equal(store.listAgents().find(item => item.id === created.id).roleId, null, 'explicit null clears the binding');
  } finally { store.close(); }
});

test('role deletion rejects any current employee reference by name, including inactive employees', () => {
  const store = createFixtureStore();
  try {
    const role = store.createRole({ name: '核查员', prompt: 'ROLE_PROMPT' });
    const active = store.createAgent({ name: '活跃员工', roleId: role.id });
    const inactive = store.createAgent({ name: '停用员工', roleId: role.id, status: 'inactive' });
    assert.throws(() => store.deleteRole(role.id), error => {
      assert.match(error.message, /活跃员工/); assert.match(error.message, /停用员工/); assert.match(error.message, /解除绑定/);
      return true;
    });
    store.deleteAgent(active.id);
    assert.throws(() => store.deleteRole(role.id), /停用员工/, 'deleted employees release the reference, inactive ones do not');
    store.updateAgent(inactive.id, { roleId: null });
    store.deleteRole(role.id);
    assert.deepEqual(store.listRoles(), []);
  } finally { store.close(); }
});

test('Task creation freezes the role prompt with the member and manager snapshots', () => {
  const store = createFixtureStore();
  try {
    const before = store.listTasks()[0];
    assert.equal(before.memberSnapshots.every(member => member.roleSnapshot === null), true, 'tasks created before binding stay untouched');
    const role = store.createRole({ name: '核查员', prompt: 'FROZEN_ROLE_TEXT' });
    store.updateAgent('agent_analyst', { roleId: role.id });
    store.updateAgent('system_project_manager', { roleId: role.id });
    const task = store.createTask(fixtureTaskInput(store));
    const member = task.memberSnapshots.find(item => item.id === 'agent_analyst');
    assert.deepEqual(member.roleSnapshot, { id: role.id, name: '核查员', prompt: 'FROZEN_ROLE_TEXT' });
    assert.equal(task.memberSnapshots.find(item => item.id === 'agent_designer').roleSnapshot, null);
    assert.deepEqual(task.managerSnapshot.roleSnapshot, { id: role.id, name: '核查员', prompt: 'FROZEN_ROLE_TEXT' });
    const run = store.createRun(task.id);
    assert.equal(store.getRunAgent(run.id, 'agent_analyst').roleSnapshot.prompt, 'FROZEN_ROLE_TEXT');
    store.updateRole(role.id, { prompt: 'EDITED_ROLE_TEXT' });
    assert.equal(store.getRunAgent(run.id, 'agent_analyst').roleSnapshot.prompt, 'FROZEN_ROLE_TEXT', 'frozen participants keep the original text');
    assert.equal(store.getTask(task.id).memberSnapshots.find(item => item.id === 'agent_analyst').roleSnapshot.prompt, 'FROZEN_ROLE_TEXT');
    const next = store.createTask({ ...fixtureTaskInput(store), title: '第二个任务' });
    assert.equal(next.memberSnapshots.find(item => item.id === 'agent_analyst').roleSnapshot.prompt, 'EDITED_ROLE_TEXT', 'new tasks use the edited text');
  } finally { store.close(); }
});

test('a deleted role remains verifiable in frozen snapshots without dangling live references', () => {
  const store = createFixtureStore();
  try {
    const role = store.createRole({ name: '核查员', prompt: 'DELETE_ME_TEXT' });
    store.updateAgent('agent_analyst', { roleId: role.id });
    const task = store.createTask(fixtureTaskInput(store));
    store.updateAgent('agent_analyst', { roleId: null });
    store.deleteRole(role.id);
    assert.equal(store.getTask(task.id).memberSnapshots.find(item => item.id === 'agent_analyst').roleSnapshot.prompt, 'DELETE_ME_TEXT', 'frozen history survives role deletion');
    assert.equal(store.listAgents().find(item => item.id === 'agent_analyst').roleId, null);
  } finally { store.close(); }
});

test('communication delivery snapshots embed the role at send and refresh on explicit retry only', () => {
  const store = createFixtureStore();
  try {
    const role = store.createRole({ name: '核查员', prompt: 'CHAT_ROLE_ONE' });
    store.updateAgent('agent_analyst', { roleId: role.id });
    const chat = store.openCommunication({ kind: 'agent', targetId: 'agent_analyst' });
    store.sendCommunication(chat.id, { content: '第一条', clientRequestId: 'role-send-1' });
    const first = () => store.snapshot().communicationDeliveries[0];
    assert.equal(first().agentSnapshot.roleSnapshot.prompt, 'CHAT_ROLE_ONE');
    store.updateRole(role.id, { prompt: 'CHAT_ROLE_TWO' });
    assert.equal(first().agentSnapshot.roleSnapshot.prompt, 'CHAT_ROLE_ONE', 'queued deliveries keep the send-time snapshot');
    store.claimCommunication(chat.id);
    store.failCommunication(chat.id, first().id, 'controlled failure');
    store.retryCommunication(chat.id, first().id);
    assert.equal(first().agentSnapshot.roleSnapshot.prompt, 'CHAT_ROLE_TWO', 'explicit retry refreshes the whole employee snapshot');
    store.updateAgent('agent_analyst', { roleId: null });
    store.sendCommunication(chat.id, { content: '第二条', clientRequestId: 'role-send-2' });
    assert.equal(store.snapshot().communicationDeliveries.at(-1).agentSnapshot.roleSnapshot, null, 'unbound employees get no role text');
    assert.equal(first().agentSnapshot.roleSnapshot.prompt, 'CHAT_ROLE_TWO', 'earlier snapshots are never rewritten');
  } finally { store.close(); }
});

test('role prompts join application system instructions for both task and communication, never the current input', () => {
  const agent = { id: 'worker', name: '员工', kind: 'business', systemPrompt: 'PERSONA_RULE', roleSnapshot: { id: 'role_one', name: '核查员', prompt: 'SHARED_ROLE_MARK' } };
  const task = taskPrompt({
    task: { title: '目标', objective: 'TASK_OBJECTIVE', workspacePath: '/work', repositorySources: [], repositoryBindings: {}, acceptanceCriteria: [], workflowSnapshot: { nodes: [{ id: 'first', title: 'N', deliverable: 'D' }] } },
    run: { id: 'run-one' }, node: { id: 'first', title: 'N', deliverable: 'D' }, trace: { id: 'trace-one' }, agent, directory: '/trace', cwd: '/work',
    workspace: { traces: [], pendingQuestions: [], defects: [], decisions: [], artifacts: [] }, messages: [], roster: [{ id: 'worker', name: '员工' }], mode: 'node', delivery: { messageIds: [], attempts: 1 }, session: { resume: false }
  });
  assert.match(task.systemPrompt, /PERSONA_RULE/);
  assert.match(task.systemPrompt, /绑定角色「核查员」的共用系统提示词：SHARED_ROLE_MARK/);
  assert.doesNotMatch(task.prompt, /SHARED_ROLE_MARK|PERSONA_RULE/);
  const message = { id: 'message-one', content: 'USER_ORIGINAL', sender: { type: 'human' } };
  const chat = communicationPrompt({ agent, root: '/chat', cwd: '/chat/worker', context: { conversation: { kind: 'agent' }, handoffCandidates: [], message }, messages: [message] });
  assert.match(chat.systemPrompt, /SHARED_ROLE_MARK/);
  assert.doesNotMatch(chat.prompt, /SHARED_ROLE_MARK|PERSONA_RULE/);
  const unbound = { ...agent };
  delete unbound.roleSnapshot;
  assert.doesNotMatch(communicationPrompt({ agent: unbound, root: '/chat', cwd: '/chat/worker', context: { conversation: { kind: 'agent' }, handoffCandidates: [], message }, messages: [message] }).systemPrompt, /绑定角色/);
  const legacy = { ...unbound, role: 'LEGACY_STRING_LABEL' };
  assert.doesNotMatch(communicationPrompt({ agent: legacy, root: '/chat', cwd: '/chat/worker', context: { conversation: { kind: 'agent' }, handoffCandidates: [], message }, messages: [message] }).systemPrompt, /LEGACY_STRING_LABEL/, 'the retired legacy role property is never injected');
});

test('role CLI exposes progressive help, schema and partial update offline', async () => {
  assert.ok(resources.roles);
  assert.deepEqual(Object.keys(resources.roles.schema.properties), ['name', 'prompt']);
  const update = documentation('roles', 'update');
  assert.deepEqual(update.schema.required, [], 'role update is a partial patch');
  assert.equal(documentation('roles', 'create').schema.required.includes('prompt'), true);
  assert.ok(resources.agents.schema.properties.roleId, 'agent schema accepts roleId');
  const captured = async (args) => {
    let stdout = '', stderr = '';
    const code = await runCommand(args, { write: value => { stdout += value; }, writeError: value => { stderr += value; }, fetcher() { assert.fail('help stays offline'); } });
    return { code, stdout, stderr };
  };
  const root = await captured([]);
  assert.equal(root.code, 0); assert.match(root.stdout, /角色/);
  const help = await captured(['roles', 'create', '--help']);
  assert.equal(help.code, 0); assert.match(help.stdout, /共用系统提示词/); assert.match(help.stdout, /--file/);
  const deleteHelp = await captured(['roles', 'delete', '--help']);
  assert.match(deleteHelp.stdout, /--yes/); assert.match(deleteHelp.stdout, /解除绑/);
  const schema = await captured(['schema', 'agents', '--json']);
  assert.equal(JSON.parse(schema.stdout).data.schema.properties.roleId.type.includes('null'), true);
});

test('role CLI runs authenticated CRUD over HTTP with reference-style output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'af-roles-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = join(root, 'session.json'), endpointFile = join(root, 'endpoint.json');
  const origin = 'http://127.0.0.1:51983', instanceId = '11111111-2222-4333-8444-555555555555';
  const cookie = 'agentforge_session=' + 'a'.repeat(64);
  await writeFile(endpointFile, JSON.stringify({ origin, instanceId }), { mode: 0o600 });
  const state = { roles: [{ id: 'role_one', name: '核查员', prompt: 'ROLE_ONE' }] };
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const path = url.slice(origin.length), body = options.body ? JSON.parse(options.body) : null;
    if (path === '/api/health') { assert.equal(options.headers, undefined); return new Response(JSON.stringify({ service: 'agentforge-control-plane', instanceId })); }
    calls.push({ path, method: options.method || 'GET', body });
    if (path === '/api/auth/login') return new Response(JSON.stringify({ username: 'operator', expiresAt: null }), { headers: { 'set-cookie': cookie + '; Path=/; HttpOnly' } });
    assert.equal(options.headers.Cookie, cookie, 'every resource request is authenticated');
    if (path === '/api/roles' && (!options.method || options.method === 'GET')) return new Response(JSON.stringify({ roles: state.roles }));
    return new Response(JSON.stringify(body || { deleted: true }));
  };
  const invoke = (args, stdin) => executeCommand([...args, '--session-file', sessionFile, '--endpoint-file', endpointFile], { fetcher, stdin: input(stdin) });
  await invoke(['auth', 'login', '--username', 'operator', '--password-stdin'], 'synthetic-password\n');
  const list = await invoke(['roles', 'list']);
  assert.equal(list.items[0].id, 'role_one');
  assert.deepEqual(calls.at(-1), { path: '/api/roles', method: 'GET', body: null });
  assert.equal((await invoke(['roles', 'list', '--search', 'ROLE_ONE'])).items.length, 1, 'search matches the prompt text like the UI');
  assert.deepEqual((await invoke(['roles', 'list', '--search', '没有匹配'])).items, []);
  assert.equal((await invoke(['roles', 'get', 'role_one'])).prompt, 'ROLE_ONE');
  await invoke(['roles', 'create', '--file', '-'], { name: '审校', prompt: 'ROLE_TWO' });
  assert.deepEqual(calls.at(-1), { path: '/api/roles', method: 'POST', body: { name: '审校', prompt: 'ROLE_TWO' } });
  await invoke(['roles', 'update', 'role_one', '--file', '-'], { prompt: 'ROLE_EDITED' });
  assert.deepEqual(calls.at(-1), { path: '/api/roles/role_one', method: 'PUT', body: { prompt: 'ROLE_EDITED' } });
  const count = calls.length;
  await assert.rejects(invoke(['roles', 'delete', 'role_one']), /--yes/);
  assert.equal(calls.length, count, 'delete without --yes never contacts the service');
  await invoke(['roles', 'delete', 'role_one', '--yes']);
  assert.deepEqual(calls.at(-1), { path: '/api/roles/role_one', method: 'DELETE', body: {} });
  await assert.rejects(invoke(['roles', 'create', '--file', '-'], { name: 'x', prompt: 'y', extra: true }), /未知字段/);
  await assert.rejects(invoke(['roles', 'create', '--file', '-'], { name: 'x' }), /prompt 必填/);
});
