import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, chmod, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execute as executeCommand, run as runCommand } from '../cli/main.mjs';
import { createClient, defaultEndpointFile, readInput, resolveEndpoint } from '../cli/client.mjs';
import { resources } from '../cli/commands.mjs';

test('employee extension help states selected-only tools without expanding the input protocol', () => {
  const selection = resources.agents.schema.properties.runtime.properties.extensionSelection;
  assert.deepEqual(Object.keys(selection.properties), ['pluginIds', 'mcpIds']);
  assert.match(selection.properties.mcpIds.description, /不继承全局 MCP 或 Codex Apps/);
  assert.match(selection.properties.mcpIds.description, /基础文件\/Shell/);
});
import { formatOutput } from '../cli/output.mjs';

test('workflow CLI documents and validates arbitrary relative delivery locations without docs defaults',async()=>{
  const {validateInput}=await import('../cli/client.mjs');
  const value={name:'媒体交付',nodes:[{id:'media',title:'制作',staffingGuidance:'媒体制作',artifactPaths:['artifacts/preparation/','reports/质检/','summary.md']}]};
  validateInput(value,resources.workflows.schema);
  for(const path of ['/absolute','../escape','a/../b','a//b','a\\b','.git/config','.agentforge/private'])assert.throws(()=>validateInput({...value,nodes:[{...value.nodes[0],artifactPaths:[path]}]},resources.workflows.schema));
  assert.match(resources.workflows.schema.properties.nodes.items.properties.artifactPaths.description,/不限定 docs/);
});

const input = value => Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]);
const cookie = 'agentforge_session=' + 'a'.repeat(64);
const origin = 'http://127.0.0.1:51983', instanceId = '11111111-2222-4333-8444-555555555555';
const endpointRoot = await mkdtemp(join(tmpdir(), 'af-cli-endpoint-')), endpointFile = join(endpointRoot, 'endpoint.json');
await writeFile(endpointFile, JSON.stringify({ origin, instanceId }), { mode: 0o600 });
after(() => rm(endpointRoot, { recursive: true, force: true }));
// Resource tests use a real private discovery file. Only the verified health
// response is infrastructure; existing spies still count resource requests.
function connected(command, args, options = {}) {
  if (!args.includes('--session-file')) return command(args, options);
  const fetcher = async (url, init) => {
    if (url === origin + '/api/health') {
      assert.equal(init.headers, undefined, 'discovery never sends a session');
      assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ service: 'agentforge-control-plane', instanceId }));
    }
    return options.fetcher(url, init);
  };
  return command([...args, '--endpoint-file', endpointFile], { ...options, fetcher });
}
const execute = (args, options) => connected(executeCommand, args, options);
const run = (args, options) => connected(runCommand, args, options);

test('CLI rejects removed targets offline and never contacts a service when the client is unavailable', async () => {
  for (const target of ['web', 'desktop']) await assert.rejects(executeCommand(['agents', 'list', '--target', target], { fetcher() { assert.fail('removed option is offline'); } }), error => error.code === 'USAGE');
  const unavailable = ['agents', 'list', '--endpoint-file', join(endpointRoot, 'absent.json')];
  await assert.rejects(executeCommand(unavailable, { fetcher() { assert.fail('no fallback to Web'); } }), error => error.code === 'CLIENT_UNAVAILABLE' && error.exitCode === 5);
  let calls = 0;
  await assert.rejects(executeCommand(['auth', 'login', '--username', 'operator', '--password-stdin', '--endpoint-file', endpointFile], { stdin: input('synthetic-password'), fetcher: async (url, init) => {
    calls++; assert.equal(url, origin + '/api/health'); assert.equal(init.headers, undefined);
    return new Response(JSON.stringify({ service: 'agentforge-control-plane', instanceId: 'stale' }));
  } }), error => error.code === 'CLIENT_UNAVAILABLE');
  assert.equal(calls, 1, 'stale instance never receives credentials');
});
test('plugin CLI exposes Runtime support progressively and documents source-wide Git imports',async()=>{
  const f=await fixture(),compatibility={'claude-code':{supported:true,reasons:[]},codex:{supported:false,reasons:['Codex 适配器不支持 settings']}};
  const entry={id:'plugin_one',name:'Claude-only',description:'proof',providers:['claude-code'],compatibility,components:{skills:1,agents:0,hooks:0,commands:0}};
  const fetcher=async url=>new Response(JSON.stringify(url.endsWith('/plugin_one')?entry:{plugins:[entry]}));
  const listed=await captured(['plugins','list','--session-file',f.sessionFile],{fetcher});
  assert.match(listed.stdout,/Runtime/);assert.match(listed.stdout,/Claude Code/);assert.doesNotMatch(listed.stdout,/settings/);
  const detail=await captured(['plugins','get',entry.id,'--session-file',f.sessionFile],{fetcher});assert.match(detail.stdout,/不兼容原因/);assert.match(detail.stdout,/settings/);
  const json=await captured(['plugins','get',entry.id,'--session-file',f.sessionFile,'--json'],{fetcher});assert.deepEqual(JSON.parse(json.stdout).data.compatibility,compatibility);
  const help=await captured(['plugins','import','--help']);assert.match(help.stdout,/全部插件/);assert.match(help.stdout,/github\/url\/git-subdir/);assert.match(help.stdout,/npm\/archive\/command/);
  assert.match(help.stdout,/链接安装为普通文件/);assert.match(help.stdout,/来源外链接/);assert.match(help.stdout,/整批回滚/);
});
test('all task commands progressively disclose their own data and compact related references in text and JSON', async () => {
  const f = await fixture(), marker = 'INTERNAL_EMPLOYEE_PROMPT_MUST_NOT_EXPAND';
  const employee = { id: 'agent_one', name: '作者', systemPrompt: marker, runtime: { profileId: 'runtime_one', extensions: marker } };
  const manager = { ...employee, id: 'manager_one', name: '经理' };
  const task = { id: 'task_one', title: '简报任务', objective: '完整用户目标', acceptanceCriteria: ['核对真实产物'], status: 'awaiting_human', priority: 'medium', teamId: 'team_one', team: { id: 'team_one', name: '内容组', members: [employee], secretInternal: marker }, memberSnapshots: [employee], managerAgentId: manager.id, managerSnapshot: manager, managerRuntime: { profileId: 'runtime_one', internal: marker }, workflowTemplateId: 'flow_one', workflowSnapshot: { id: 'flow_one', name: '写作流程', nodes: [{ id: 'write', title: '撰写', deliverable: marker }] }, repositoryBindings: { internal: marker }, futureNestedField: marker };
  const question = { id: 'question_one', content: '报告使用什么标题？', questionType: '标题', recipient: { id: 'human_operator', name: '你', type: 'human' }, sender: manager, consideredMemberIds: [marker], routingReason: marker, createdAt: '2026-10-23T00:00:00Z' };
  const run = { id: 'run_one', taskId: task.id, status: 'awaiting_human', task, manager, participants: [employee, manager], currentFocus: { nodeId: 'write', reason: marker }, deliveryReview: { verdict: 'pass', findings: [marker] }, summary: marker };
  const workspace = { run, pendingQuestions: [question], traces: [], dispatches: [], messages: [{ ...question, sender: { id: manager.id, name: manager.name, type: 'agent' } }], artifacts: [{ id: 'artifact_one', name: 'docs/report.md', sha256: 'abc' }], defects: [], events: [] };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Cookie, cookie);
    const path = url.slice(origin.length);
    const value = path === '/api/bootstrap' ? { tasks: [task], runs: [run] } : path === '/api/tasks' ? options.method === 'POST' ? { task } : { tasks: [task] } : path.endsWith('/run') ? { run } : path.endsWith('/messages') ? { message: { id: 'message_one', content: marker, recipient: manager, kind: 'instruction' }, run, queued: true, resumed: false } : workspace;
    return new Response(JSON.stringify(value));
  };
  const args = operation => ['tasks', operation, ...(['list', 'create'].includes(operation) ? [] : [task.id]), '--session-file', f.sessionFile];
  const invoke = (operation, value) => execute([...args(operation), ...(value ? ['--file', '-'] : [])], { fetcher, stdin: input(value ?? '') });
  const detail = await invoke('get');
  assert.deepEqual(detail.team, { id: 'team_one', name: '内容组' });
  assert.deepEqual(detail.workflow, { id: 'flow_one', name: '写作流程' });
  assert.deepEqual(detail.manager, { id: manager.id, name: manager.name });
  assert.equal(detail.objective, task.objective); assert.deepEqual(detail.acceptanceCriteria, task.acceptanceCriteria);
  for (const operation of ['get', 'list', 'progress', 'create', 'start', 'message', 'reply', 'questions']) {
    const value = operation === 'create' ? { title: task.title, objective: task.objective, teamId: task.teamId, workflowTemplateId: task.workflowTemplateId } : operation === 'message' ? { content: '追加资料', recipientAgentId: manager.id } : operation === 'reply' ? { content: '标题采用知识简报', replyToMessageId: question.id } : undefined;
    const result = await invoke(operation, value);
    assert.ok(!JSON.stringify(result).includes(marker), operation);
    assert.ok(!JSON.stringify(result).includes('memberSnapshots'), operation);
    if (operation === 'create') assert.deepEqual(Object.keys(result.task), ['id', 'title', 'status']);
    if (operation === 'start') assert.deepEqual(result.run, { id: run.id, taskId: task.id, status: run.status });
    if (operation === 'message') { assert.equal(result.queued, true); assert.equal(result.resumed, false); }
    if (operation === 'progress') { assert.deepEqual(result.pendingQuestions, [{ id: question.id, name: '标题' }]); assert.deepEqual(result.participants[0], { id: employee.id, name: employee.name }); }
    if (operation === 'questions') assert.equal(result.items[0].content, question.content);
  }
  const text = await captured(args('get'), { fetcher });
  assert.match(text.stdout, /agentforge teams get team_one/); assert.match(text.stdout, /agentforge workflows get flow_one/); assert.match(text.stdout, /agentforge agents get manager_one/);
  assert.doesNotMatch(text.stdout, /systemPrompt|memberSnapshots|workflowSnapshot|runtime|INTERNAL_EMPLOYEE/);
  const json = await captured([...args('get'), '--json'], { fetcher });
  assert.deepEqual(JSON.parse(json.stdout).data, JSON.parse(JSON.stringify(detail)));
  const collaboration = (await invoke('collaboration')).items[0];
  assert.equal(collaboration.content, question.content);
  assert.equal('tone' in collaboration, false, 'UI palette metadata is not a CLI field');
  assert.equal('statusCode' in collaboration, false);
  assert.equal((await invoke('artifacts')).items[0].sha256, 'abc');
});
test('task CLI queries scoped progress, filters and collaboration and rejects stale/cross-run replies without writing', async () => {
  const f = await fixture(), writes = [];
  const task = { id: 'task_one', title: '中文知识任务', status: 'awaiting_human', teamId: 'team_one', objective: '完整目标' };
  const question = { id: 'question_one', content: '请选择报告标题', recipient: { type: 'human' }, sender: { type: 'agent', name: '经理' }, createdAt: '2026-10-23T00:00:00Z' };
  const workspace = { run: { id: 'run_one', task, status: 'awaiting_human', participants: [{ id: 'manager_one', name: '经理' }], currentFocus: { nodeId: 'write' } }, pendingQuestions: [question], traces: [], dispatches: [], messages: [question], events: [], defects: [], artifacts: [{ id: 'artifact_one', name: 'docs/report.md', sha256: 'hash' }] };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Cookie, cookie);
    const path = url.slice(origin.length);
    if (options.method === 'POST') { writes.push({ path, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ message: { id: 'answer_one' } })); }
    const data = path === '/api/bootstrap' ? { tasks: [task, { ...task, id: 'archived', archivedAt: '2026-10-22' }], runs: [{ id: 'run_one', taskId: task.id }] } : path === '/api/tasks' ? { tasks: [task] } : workspace;
    return new Response(JSON.stringify(data));
  };
  const invoke = (args, value) => execute(['tasks', ...args, '--session-file', f.sessionFile], { fetcher, stdin: input(value ?? '') });
  assert.equal((await invoke(['list', '--search', '知识', '--status', 'awaiting_human', '--team', 'team_one'])).total, 1);
  assert.equal((await invoke(['list', '--archived'])).items[0].id, 'archived');
  assert.equal((await invoke(['get', task.id])).objective, '完整目标');
  const progress = await invoke(['progress', task.id]);
  assert.equal(progress.runId, 'run_one'); assert.equal(progress.pendingQuestions[0].id, 'question_one'); assert.match(progress.nextAction, /仍阻塞/);
  assert.equal((await invoke(['collaboration', task.id])).items[0].id, question.id);
  assert.equal((await invoke(['artifacts', task.id])).items[0].id, 'artifact_one');
  assert.equal((await invoke(['questions', task.id])).items[0].id, question.id);
  for (const replyToMessageId of ['other_question', 'already_answered']) await assert.rejects(invoke(['reply', task.id, '--file', '-'], { content: '回答', replyToMessageId }), error => error.code === 'QUESTION_NOT_PENDING');
  await assert.rejects(invoke(['reply', task.id, '--run', 'other_run', '--file', '-'], { content: '回答', replyToMessageId: question.id }), error => error.code === 'NOT_FOUND');
  await assert.rejects(invoke(['message', task.id, '--file', '-'], { content: '普通消息', replyToMessageId: question.id }), error => error.code === 'USAGE');
  await assert.rejects(invoke(['message', task.id, '--file', '-'], { content: '普通消息' }), error => error.code === 'USAGE');
  assert.equal(writes.length, 0);
  await invoke(['reply', task.id, '--file', '-'], { content: '采用内部简报', replyToMessageId: question.id });
  assert.equal(writes[0].path, '/api/runs/run_one/messages'); assert.equal(writes[0].body.replyToMessageId, question.id);
  await invoke(['message', task.id, '--file', '-'], { content: '补充资料', recipientAgentId: 'manager_one' });
  assert.equal(writes[1].body.recipientAgentId, 'manager_one');
  await invoke(['start', task.id]); assert.equal(writes[2].path, '/api/tasks/task_one/run');
  for (const operation of ['confirm', 'complete', 'delete']) await assert.rejects(invoke([operation, task.id]), error => error.code === 'USAGE');
});
test('desktop CLI verifies its private live endpoint and never falls back to Web', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-desktop-cli-'));
  const directory = join(root, 'private'); await mkdir(directory, { mode: 0o700 });
  const endpointFile = join(directory, 'desktop-endpoint.json');
  const desktopOrigin = 'http://127.0.0.1:51983', instanceId = '11111111-2222-4333-8444-555555555555';
  await writeFile(endpointFile, JSON.stringify({ origin: desktopOrigin, instanceId }), { mode: 0o600 });
  const fetcher = async url => { assert.equal(url, `${desktopOrigin}/api/health`); return new Response(JSON.stringify({ service: 'agentforge-control-plane', instanceId }), { status: 200 }); };
  assert.equal(await resolveEndpoint(endpointFile, fetcher), desktopOrigin);
  await assert.rejects(resolveEndpoint(endpointFile, async () => new Response(JSON.stringify({ service: 'agentforge-control-plane', instanceId: 'other' }))), error => error.code === 'CLIENT_UNAVAILABLE');
  await chmod(endpointFile, 0o644);
  await assert.rejects(resolveEndpoint(endpointFile, fetcher), error => error.code === 'CLIENT_UNAVAILABLE');
  await chmod(endpointFile, 0o600);
  await assert.rejects(resolveEndpoint(join(directory, 'missing.json'), fetcher), error => error.code === 'CLIENT_UNAVAILABLE');
  assert.equal(defaultEndpointFile('/fixture-home'), '/fixture-home/.agentforge/desktop/desktop-endpoint.json');
});
async function captured(args, options = {}) {
  let stdout = '', stderr = '';
  const code = await run(args, { ...options, write: value => { stdout += value; }, writeError: value => { stderr += value; } });
  return { code, stdout, stderr };
}
test('default CLI help progressively discloses root, groups and operation details offline', async () => {
  for (const args of [[], ['help'], ['--help'], ['schema']]) {
    const result = await captured(args, { fetcher() { assert.fail('help must stay offline'); } });
    assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.ok(!result.stdout.startsWith('{'));
    for (const phrase of ['AI 团队操作系统', '数字员工', 'MCP 市场', '插件市场', '工作流', '团队', 'Runtime', '会话状态', '查看具体操作参数：在命令后加 --help，例如 agentforge agents get --help。']) assert.ok(result.stdout.includes(phrase), phrase);
    assert.doesNotMatch(result.stdout, /逐层查看|GROUP|OPERATION/);
    assert.equal(result.stdout.split('\n').filter(line => line.includes('--help')).length, 1);
    assert.ok(result.stdout.indexOf('AI 团队操作系统') < result.stdout.indexOf('命令目录'));
    for (const hidden of ['典型交付流程', '核心概念', 'SQLite', '--password-stdin', '建议配置顺序', 'JSON 输入模板']) assert.ok(!result.stdout.includes(hidden), hidden);
    assert.ok(result.stdout.length < 1000 && result.stdout.split('\n').length < 24, 'root is a short directory, not the entire manual');
    assert.ok(result.stdout.split('\n')[0].endsWith('而不只是聊天回复。'), 'product purpose is one logical line');
  }
  for (const group of Object.keys(resources)) {
    const result = await captured(['help', group], { columns: 160 });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /子命令/); assert.match(result.stdout, new RegExp(`例如 agentforge ${group} list --help`));
    assert.doesNotMatch(result.stdout, /下一层帮助|GROUP|OPERATION/);
    assert.ok(!result.stdout.includes('完整字段说明') && !result.stdout.includes('JSON 输入模板'));
    for (const operation of resources[group].operations) assert.ok(result.stdout.includes(operation));
    assert.equal((await captured([group])).stdout, result.stdout);
    const schema = await captured(['schema', group], { columns: 160 });
    assert.match(schema.stdout, /完整字段说明/); assert.match(schema.stdout, /JSON 输入模板/); assert.match(schema.stdout, /失败恢复/);
    for (const name of Object.keys(resources[group].schema.properties)) assert.ok(schema.stdout.includes(name), group + '.' + name);
    for (const operation of resources[group].operations) assert.equal((await captured([group, operation, '--help'])).code, 0);
  }
  const auth = (await captured(['auth'])).stdout;
  assert.match(auth, /管理员会话/); assert.match(auth, /login/); assert.match(auth, /status/); assert.match(auth, /logout/);
  assert.match(auth, /例如 agentforge auth login --help/); assert.doesNotMatch(auth, /GROUP|OPERATION/);
  assert.ok(!auth.includes('--password-stdin') && !auth.includes('AF_LOGIN_PASSWORD'));
  const login = (await captured(['auth', 'login', '--help'])).stdout;
  assert.match(login, /--username NAME \[--password-stdin\]/); assert.match(login, /交互登录/); assert.match(login, /隐藏输入/); assert.match(login, /AF_LOGIN_PASSWORD/); assert.match(login, /stdin/);
  for (const operation of ['status', 'logout']) {
    const text = (await captured(['auth', operation, '--help'])).stdout;
    assert.ok(!text.includes('--username') && !text.includes('--password-stdin') && !text.includes('AF_LOGIN_PASSWORD'));
    assert.match(text, /--session-file/);
  }
  const employee = await captured(['agents', 'create', '--help'], { columns: 160 });
  assert.match(employee.stdout, /runtime.extensionSelection.pluginIds/); assert.match(employee.stdout, /父项提供时必填/);
  assert.match(employee.stdout, /完整替换/); assert.ok(!employee.stdout.includes('--username')); assert.match(employee.stdout, /roleId/); assert.ok(!/^ {2}role {2}/m.test(employee.stdout), 'the retired role label stays absent; only roleId references a shared role');
  assert.match((await captured(['workflows', 'create', '--help'])).stdout, /staffingGuidance/);
  for (const operation of ['list', 'get', 'delete']) {
    const text = (await captured(['agents', operation, '--help'])).stdout;
    assert.ok(!text.includes('完整字段说明') && !text.includes('JSON 输入模板') && !text.includes('--file'));
    assert.equal(text.includes('--yes'), operation === 'delete');
    assert.equal(text.includes('--search'), operation === 'list');
    if (operation !== 'list') assert.match(text, /ID：必填精确资源ID/);
  }
});
test('displayed help examples are executable offline; usage errors do not recommend placeholder commands', async () => {
  const offline = { fetcher() { assert.fail('help must not authenticate or make requests'); } };
  const root = (await captured([], offline)).stdout;
  const example = root.match(/例如 (agentforge [a-z -]+)--help/)[1].trim().split(/\s+/).slice(1);
  const detail = await captured([...example, '--help'], offline);
  assert.equal(detail.code, 0); assert.match(detail.stdout, /ID：必填精确资源ID/);
  for (const args of [['agents', 'get'], ['GROUP'], ['GROUP', 'agents'], ['agents', 'help']]) {
    const result = await captured(args, offline);
    assert.equal(result.code, 2); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /GROUP|OPERATION|<group>|<operation>/);
    assert.match(result.stderr, /agentforge agents get --help/);
  }
});
test('explicit --json works before/after commands, including malformed usage; piped default stays text', async () => {
  for (const args of [['--json', 'schema', 'agents'], ['schema', 'agents', '--json'], ['agents', 'create', '--help', '--json']]) {
    const result = await captured(args); assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).data.group, 'agents');
  }
  for (const args of [['--json', '--json'], ['help', '--unknown', '--json'], ['--json', 'tasks', 'confirm', 'x']]) {
    const result = await captured(args); assert.equal(result.code, 2); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).error.code, 'USAGE');
  }
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../cli/main.mjs', import.meta.url)), 'help']);
  assert.match(stdout, /^AgentForge/); assert.equal(stderr, '');
});
test('CLI executable works through an npm-style symlink and keeps stdout machine-readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-cli-link-'));
  const link = join(root, 'agentforge');
  await symlink(fileURLToPath(new URL('../cli/main.mjs', import.meta.url)), link);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [link, 'schema', 'workflows', '--json']);
  assert.equal(JSON.parse(stdout).data.group, 'workflows'); assert.equal(stderr, '');
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'af-config-cli-')), sessionFile = join(root, 'private', 'session.json');
  const calls = [], state = { agents: [{ id: 'agent_one', name: '原员工', kind: 'business', runtime: { profileId: 'runtime_one', extensionSelection: { mcpIds: ['private-id'], pluginIds: [] } } }], teams: [{ id: 'team_one', name: '内容团队', memberAgentIds: ['agent_one'] }], profiles: [{ id: 'runtime_one', name: 'default', provider: 'claude-code' }], workflowTemplates: [], plugins: [{ id: 'plugin_one', name: '编辑插件', skillIds: ['skill_one'], unsupported: ['hooks'] }], entries: [{ id: 'skill_one', kind: 'skill', name: '编辑', description: '中文' }] };
  const fetcher = async (url, options) => {
    assert.ok(url.startsWith(origin + '/api/')); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Origin, origin);
    const path = url.slice(origin.length), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body });
    const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
    if (path === '/api/auth/login') return response({ username: 'operator', expiresAt: null }, 200, { 'set-cookie': cookie + '; Path=/; HttpOnly' });
    assert.equal(options.headers.Cookie, cookie);
    if (path === '/api/auth/logout') return response({ ok: true });
    if (path === '/api/auth/session') return response({ username: 'operator', expiresAt: null });
    const resource = Object.values(resources).find(item => path === item.path || path.startsWith(item.path + '/'));
    if (path.endsWith('/test')) return response({ ok: false, logPath: '/private/probe.jsonl', testId: 'probe-1' });
    if (options.method === 'GET') return response({ [resource.key]: state[resource.key], ...(resource.key === 'plugins' ? { entries: state.entries } : {}) });
    return response(body || { deleted: true });
  };
  const options = { fetcher };
  const invoke = (args, stdin) => execute([...args, '--session-file', sessionFile], { ...options, stdin: input(stdin ?? '') });
  await invoke(['auth', 'login', '--username', 'operator', '--password-stdin'], 'synthetic-password\n');
  return { root, sessionFile, invoke, calls, state, fetcher };
}
test('MCP update is progressive, accepts partial input and sends an authenticated PUT without nested resources',async()=>{
  const f=await fixture();try{
    const help=await captured(['mcps','update','--help']);assert.match(help.stdout,/update ID --file/);assert.match(help.stdout,/隐藏值/);assert.match(help.stdout,/新版本/);
    await f.invoke(['mcps','update','skill_one','--file','-'],{description:'新的说明'});
    assert.deepEqual(f.calls.at(-1),{path:'/api/runtime/mcp-marketplace/skill_one',method:'PUT',body:{description:'新的说明'}});
    const count=f.calls.length;await assert.rejects(f.invoke(['mcps','update','skill_one','--file','-'],{}),/至少提供/);assert.equal(f.calls.length,count);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test('plugin update controls expose progressive help and authenticated status, trigger and settings commands',async()=>{
  const f=await fixture();try{
    for(const operation of ['updates','check-updates','auto-update']){
      const help=await captured(['plugins',operation,'--help']);assert.match(help.stdout,/2分钟/);if(operation==='auto-update'){assert.match(help.stdout,/--file/);assert.match(help.stdout,/enabled/);}
    }
    await f.invoke(['plugins','updates']);assert.deepEqual(f.calls.at(-1),{path:'/api/runtime/marketplace/updates',method:'GET',body:null});
    await f.invoke(['plugins','check-updates']);assert.deepEqual(f.calls.at(-1),{path:'/api/runtime/marketplace/updates',method:'POST',body:{}});
    await f.invoke(['plugins','auto-update','--file','-'],{enabled:false});assert.deepEqual(f.calls.at(-1),{path:'/api/runtime/marketplace/updates/settings',method:'PUT',body:{enabled:false}});
    await f.invoke(['plugins','auto-update','--file','-'],{intervalMinutes:15});assert.deepEqual(f.calls.at(-1).body,{intervalMinutes:15});
    const count=f.calls.length;for(const input of [{},{enabled:'false'},{enabled:true,extra:1},{intervalMinutes:0},{intervalMinutes:1441},{intervalMinutes:1.5},{intervalMinutes:'2'}])await assert.rejects(f.invoke(['plugins','auto-update','--file','-'],input));assert.equal(f.calls.length,count);
  }finally{await rm(f.root,{recursive:true,force:true})}
});
test('plugin and MCP deletion exposes progressive help and requires explicit confirmation before authenticated DELETE', async () => {
  const f=await fixture();
  try {
    for(const [group,id,path] of [['plugins','plugin_one','/api/runtime/marketplace/plugin_one'],['mcps','skill_one','/api/runtime/mcp-marketplace/skill_one']]) {
      const help=await captured([group,'delete','--help']);
      assert.match(help.stdout,/delete ID --yes/);assert.match(help.stdout,/历史任务/);
      const before=f.calls.length;
      await assert.rejects(f.invoke([group,'delete',id]),error=>error.code==='USAGE');
      assert.equal(f.calls.length,before,'missing confirmation never accesses service');
      await f.invoke([group,'delete',id,'--yes']);
      assert.deepEqual(f.calls.at(-1),{path,method:'DELETE',body:{}});
    }
  } finally {await rm(f.root,{recursive:true,force:true});}
});
test('text lists, complete details and mutation feedback preserve IDs, prompts and configuration-only semantics', async () => {
  const f = await fixture(), invoke = (args, options = {}) => captured([...args, '--session-file', f.sessionFile], { fetcher: f.fetcher, ...options });
  const list = await invoke(['agents', 'list']);
  assert.match(list.stdout, /数字员工列表/); assert.match(list.stdout, /agent_one/); assert.match(list.stdout, /共 1 项/); assert.match(list.stdout, /agents get ID/);
  assert.equal(list.stderr, '');
  f.state.agents[0].systemPrompt = '第一条要求\n' + '需要完整保留的详细交付要求。'.repeat(50) + '\n最终要求';
  const detail = await invoke(['agents', 'get', 'agent_one']);
  assert.match(detail.stdout, /执行与协作提示词/); assert.match(detail.stdout, /最终要求/); assert.match(detail.stdout, /private-id/); assert.ok(detail.stdout.length > 800);
  assert.match(detail.stdout, /systemPrompt\)：\n  第一条要求/);
  const created = await invoke(['teams', 'create', '--file', '-'], { stdin: input(resources.teams.example) });
  assert.match(created.stdout, /已创建团队配置/); assert.match(created.stdout, /企业知识内容组/); assert.match(created.stdout, /不代表 Task\s+已完成/);
  const status = await invoke(['auth', 'status']); assert.match(status.stdout, /CLI 会话有效/); assert.match(status.stdout, /operator/); assert.match(status.stdout, /不过期/); assert.ok(!status.stdout.includes(cookie));
  const json = await invoke(['agents', 'list', '--json']); assert.equal(JSON.parse(json.stdout).data.items[0].id, 'agent_one');
  const result = await invoke(['agents', 'list', '--search', 'missing']); assert.match(result.stdout, /没有匹配的配置/);
});
test('text tables handle CJK, narrow/long values, empty/out-of-range pages, and escape terminal controls', () => {
  const data = { items: [{ id: 'agent_one', name: '中文', status: 'active' }, { id: 'agent_two', name: 'Edit', status: 'active' }], total: 21, page: 1, pageSize: 20, hasMore: true };
  const table = formatOutput(['agents', 'list'], data);
  assert.ok(table.includes('中文  ') && table.includes('Edit  ')); assert.match(table, /--page 2/);
  data.items[0].name = '完整长名称'.repeat(50) + '\x1b[31m\rPRIVATE_CONTROL\u202e';
  const narrow = formatOutput(['agents', 'list'], data, { columns: 40 });
  assert.ok(!narrow.includes('\x1b') && !narrow.includes('\r') && !narrow.includes('\u202e'));
  assert.ok(narrow.includes('完整长名称'.repeat(50))); assert.match(narrow, /\\u001b/); assert.match(narrow, /ID：agent_one/);
  assert.match(formatOutput(['teams', 'list'], { ...data, items: [], page: 99 }), /本页没有记录/);
  assert.match(formatOutput(['teams', 'list'], { ...data, total: 0, items: [], page: null }), /--all/);
});
test('text failures go only to stderr with exit code and recovery; no raw errors or input secrets', async () => {
  const f = await fixture(), session = ['--session-file', f.sessionFile];
  for (const [status, code] of [[401, 3], [409, 4]]) {
    const result = await captured(['teams', 'list', ...session], { fetcher: async () => new Response('{"error":"safe rejection"}', { status }) });
    assert.equal(result.code, code); assert.equal(result.stdout, ''); assert.match(result.stderr, /HTTP 状态/); assert.match(result.stderr, /处理建议/);
  }
  const malformed = await captured(['teams', 'create', '--file', '-', ...session], { stdin: input('{"secret":"never-echo'), fetcher: f.fetcher });
  assert.equal(malformed.code, 2); assert.equal(malformed.stdout, ''); assert.ok(!malformed.stderr.includes('never-echo'));
  const uncertain = await captured(['teams', 'create', '--file', '-', ...session], { stdin: input(resources.teams.example), fetcher: () => { throw new Error('raw-cookie-secret'); } });
  assert.equal(uncertain.code, 5); assert.equal(uncertain.stdout, ''); assert.match(uncertain.stderr, /可能已经提交/); assert.ok(!uncertain.stderr.includes('raw-cookie-secret'));
});

test('AI CLI provides offline comprehensive group/command schemas and safe examples', async () => {
  const failFetch = () => { throw new Error('help must be offline'); };
  const help = await execute(['help'], { fetcher: failFetch });
  assert.equal(Object.keys(help.resources).length, 8); assert.match(help.sequence.join(' '), /runtimes.*plugins.*mcps.*roles.*agents.*teams.*workflows/);
  for (const group of Object.keys(resources)) {
    const schema = await execute(['schema', group], { fetcher: failFetch });
    assert.equal(schema.schema.additionalProperties, false); assert.ok(schema.notes.length);
    for (const operation of resources[group].operations) assert.equal((await execute([group, operation, '--help'])).operation, operation);
  }
  assert.match((await execute(['auth', 'login', '--help'])).login, /stdin/);
  assert.match(JSON.stringify(help), /staffingGuidance/); assert.match(JSON.stringify(help), /extensionSelection/);
  for (const args of [['schema', 'missing'], ['help', 'agents', 'missing'], ['--password', 'secret'], ['agents', 'delete', 'x'], ['tasks', 'confirm', 'x']]) await assert.rejects(execute(args), error => error.code === 'USAGE');
});

test('CLI login stores only a private expiring session, authenticates commands and revokes logout', async () => {
  const f = await fixture();
  assert.equal((await stat(f.sessionFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, 'private'))).mode & 0o777, 0o700);
  const saved = await readFile(f.sessionFile, 'utf8'); assert.ok(!saved.includes('synthetic-password'));
  assert.equal((await f.invoke(['auth', 'status'])).username, 'operator');
  assert.deepEqual(await f.invoke(['auth', 'logout']), { loggedOut: true });
  await assert.rejects(stat(f.sessionFile), { code: 'ENOENT' });
  await assert.rejects(f.invoke(['agents', 'list']), error => error.code === 'AUTH_REQUIRED');
});

test('CLI rejects insecure/expired/foreign-origin/symlink session files without leaking cookie', async () => {
  const f = await fixture();
  await chmod(f.sessionFile, 0o644);
  await assert.rejects(f.invoke(['agents', 'list']), error => error.code === 'AUTH_REQUIRED');
  await chmod(f.sessionFile, 0o600);
  await writeFile(f.sessionFile, JSON.stringify({ origin: 'https://example.com', cookie, expiresAt: Date.now() + 10000 }));
  await assert.rejects(f.invoke(['agents', 'list']), error => error.code === 'AUTH_REQUIRED');
  const link = join(f.root, 'private', 'link.json'); await symlink(f.sessionFile, link);
  await assert.rejects(execute(['agents', 'list', '--session-file', link], { fetcher: f.fetcher }), error => error.code === 'AUTH_REQUIRED');
  await writeFile(f.sessionFile, JSON.stringify({ origin, cookie, expiresAt: null }));
  await f.invoke(['agents', 'list']);
  await writeFile(f.sessionFile, JSON.stringify({ origin, cookie, expiresAt: 1 }));
  await assert.rejects(f.invoke(['agents', 'list']), error => error.code === 'AUTH_REQUIRED');
  await chmod(join(f.root, 'private'), 0o755);
  await assert.rejects(f.invoke(['agents', 'list']), error => error.code === 'SESSION_FILE');
});

test('CLI paginates/searches config lists and resolves exact IDs and plugin Skills', async () => {
  const f = await fixture();
  f.state.teams = Array.from({ length: 43 }, (_, n) => ({ id: 't_' + n, name: '内容团队' + n }));
  assert.equal((await f.invoke(['teams', 'list'])).items.length, 20);
  assert.equal((await f.invoke(['teams', 'list', '--page', '3'])).items.length, 3);
  assert.equal((await f.invoke(['teams', 'list', '--all'])).items.length, 43);
  assert.equal((await f.invoke(['teams', 'list', '--search', '团队42'])).total, 1);
  assert.equal((await f.invoke(['teams', 'get', 't_42'])).name, '内容团队42');
  await assert.rejects(f.invoke(['teams', 'get', 'missing']), error => error.code === 'NOT_FOUND');
  await f.invoke(['plugins', 'get', 'plugin_one']);
  assert.equal(f.calls.at(-1).path,'/api/runtime/marketplace/plugin_one');
  await f.invoke(['plugins','import','--file','-'],{path:'/absolute/plugin'});
  assert.equal(f.calls.at(-1).path,'/api/runtime/marketplace');
  await assert.rejects(f.invoke(['plugins','discover','--file','-']),error=>error.code==='USAGE');
  await assert.rejects(f.invoke(['plugins','skills','plugin_one']),error=>error.code==='USAGE');
  await assert.rejects(f.invoke(['agents', 'plugins', 'agent_one']), error => error.code === 'USAGE');
  for (const args of [['teams', 'list', '--page', '0'], ['teams', 'list', '--page', '1', '--all'], ['teams', 'list', '--file', '-'], ['teams', 'get', '../secret']]) await assert.rejects(f.invoke(args), error => error.code === 'USAGE');
});

test('CLI writes all five configuration areas, confirms trust/deletion/test and keeps employee runtime selections', async () => {
  const f = await fixture();
  for (const group of ['agents', 'teams', 'workflows', 'runtimes', 'mcps', 'plugins']) {
    const operation = group === 'plugins' ? 'import' : 'create';
    await f.invoke([group, operation, '--file', '-'], resources[group].example);
  }
  await f.invoke(['agents', 'update', 'agent_one', '--file', '-'], { runtime: { profileId: 'runtime_two' } });
  const payload = f.calls.at(-1).body;
  assert.equal(payload.runtime.profileId, 'runtime_two'); assert.deepEqual(payload.runtime.extensionSelection.mcpIds, ['private-id']);
  await f.invoke(['agents', 'update', 'agent_one', '--file', '-'], { runtime: { extensionSelection: { mcpIds: [], pluginIds: [] } } });
  assert.deepEqual(f.calls.at(-1).body.runtime.extensionSelection.mcpIds, []);
  assert.equal(f.calls.at(-1).body.runtime.profileId, 'runtime_one');
  await f.invoke(['runtimes', 'delete', 'runtime_one', '--yes']); assert.equal(f.calls.at(-1).method, 'DELETE');
  for (const args of [['runtimes', 'delete', 'runtime_one'], ['runtimes', 'test', 'runtime_one']]) await assert.rejects(f.invoke(args, {}), error => error.code === 'USAGE');
  await f.invoke(['agents','create','--file','-'],{name:'Disabled at creation',status:'inactive'});
  assert.equal(f.calls.at(-1).body.status,'inactive');
  await assert.rejects(f.invoke(['runtimes', 'test', 'runtime_one', '--yes']), error => error.code === 'RUNTIME_TEST_FAILED' && error.hint.includes('probe.jsonl'));
});

test('CLI deletes employees and teams only after confirmation and propagates reference rejection', async () => {
  const f = await fixture();
  for (const [group, id, path] of [['agents', 'agent_one', '/api/agents/agent_one'], ['teams', 'team_one', '/api/teams/team_one']]) {
    const before = f.calls.length;
    await assert.rejects(f.invoke([group, 'delete', id]), error => error.code === 'USAGE');
    assert.equal(f.calls.length, before, 'missing confirmation must not perform an HTTP request');
    await f.invoke([group, 'delete', id, '--yes']);
    assert.deepEqual(f.calls.at(-1), { path, method: 'DELETE', body: {} });
    const blocked = await captured([group, 'delete', id, '--yes', '--session-file', f.sessionFile], {
      fetcher: (url, options) => options.method === 'DELETE'
        ? new Response('{"error":"仍有真实引用，请先解除引用"}', { status: 409 })
        : f.fetcher(url, options)
    });
    assert.equal(blocked.code, 4); assert.equal(blocked.stdout, ''); assert.match(blocked.stderr, /仍有真实引用/);
  }
});

test('employee schemas and writes use abilities and prompts without a role label', async () => {
  const f = await fixture();
  assert.deepEqual(resources.agents.schema.required, ['name']);
  assert.ok(!Object.hasOwn(resources.agents.schema.properties, 'role'));
  assert.ok(!Object.hasOwn(resources.agents.example, 'role'));
  await f.invoke(['agents', 'create', '--file', '-'], { name: '无职责标签员工', description: '中文编辑', capabilities: ['编辑'] });
  assert.equal(f.calls.at(-1).body.name, '无职责标签员工');
  const before = f.calls.length;
  for (const [operation, args] of [['create', []], ['update', ['agent_one']]]) {
    await assert.rejects(f.invoke(['agents', operation, ...args, '--file', '-'], { name: '旧输入', role: 'legacy' }), error => error.code === 'USAGE');
  }
  assert.equal(f.calls.length, before, 'removed fields are rejected before HTTP');
  const machine = await captured(['schema', 'agents', '--json']);
  const schema = JSON.parse(machine.stdout).data;
  assert.equal(schema.schema.additionalProperties, false); assert.ok(schema.schema.properties.runtime.properties.extensionSelection);
  assert.ok(!Object.hasOwn(schema.schema.properties, 'role'));
  assert.ok(!(await captured(['agents', 'list', '--session-file', f.sessionFile], { fetcher: f.fetcher })).stdout.includes('职责'));
});

test('CLI accepts only current employee/workflow inputs and never replays derived runtime paths', async () => {
  const f = await fixture(), before = f.calls.length;
  for (const key of ['skillPaths', 'mcpConfigPaths', 'pluginPaths', 'pluginSources', 'provider', 'model', 'executable', 'extensionManifest']) {
    await assert.rejects(f.invoke(['agents', 'update', 'agent_one', '--file', '-'], {runtime:{[key]:[]}}), error => error.code === 'USAGE');
  }
  for (const key of ['ownerRole', 'repositoryPath', 'reuseOwnerFrom']) {
    const value = {...resources.workflows.example, nodes:[{...resources.workflows.example.nodes[0], [key]:'not-supported'}]};
    await assert.rejects(f.invoke(['workflows', 'create', '--file', '-'], value), error => error.code === 'USAGE');
  }
  assert.equal(f.calls.length, before, 'unsupported fields must not make HTTP writes');
  assert.ok(!resources.agents.operations.includes('plugins'));
  const help = await captured(['agents', 'create', '--help']);
  assert.doesNotMatch(help.stdout, /兼容旧|skillPaths|mcpConfigPaths|pluginPaths|pluginSources/);
  Object.assign(f.state.agents[0].runtime, {skillPaths:['/internal/file'],pluginSources:[],extensionManifest:[]});
  const read = await f.invoke(['agents', 'get', 'agent_one']);
  assert.deepEqual(Object.keys(read.runtime), ['profileId', 'extensionSelection']);
  await f.invoke(['agents', 'update', 'agent_one', '--file', '-'], {runtime:{profileId:'runtime_one'}});
  assert.deepEqual(Object.keys(f.calls.at(-1).body.runtime), ['profileId', 'extensionSelection']);
});

test('CLI input errors do not echo malformed JSON/secrets or silently accept unknown fields', async () => {
  const f = await fixture(), before = f.calls.length;
  for (const value of ['{ "token":"synthetic-secret"', '[]', 'null', '{"name":"x","role":"y","token":"synthetic-secret"}', '{"name":"x","role":"y","runtime":{"extensionSelection":{"mcpIds":[]}}}']) {
    let output;
    assert.equal(await run(['agents', 'create', '--file', '-', '--session-file', f.sessionFile, '--json'], { fetcher: f.fetcher, stdin: input(value), write: x => { output = x; } }), 2);
    assert.ok(!output.includes('synthetic-secret')); assert.equal(JSON.parse(output).ok, false);
  }
  assert.equal(f.calls.length, before);
  await assert.rejects(readInput('-', input('x'.repeat(1024 * 1024 + 1))), error => error.code === 'USAGE');
  const path = join(f.root, 'input.json'); await writeFile(path, '{}');
  const link = join(f.root, 'link-input.json'); await symlink(path, link);
  await assert.rejects(readInput(link, input('')), error => error.code === 'USAGE');
  assert.deepEqual(await readInput(path, input('')), {});
});

test('CLI reports auth/rejection/uncertain network outcomes without retries or raw errors', async () => {
  const f = await fixture();
  for (const [status, exit] of [[401, 3], [403, 3], [409, 4], [413, 4]]) {
    let output;
    const result = await run(['teams', 'list', '--session-file', f.sessionFile, '--json'], { fetcher: async () => new Response('{"error":"safe rejection"}', { status }), write: value => { output = JSON.parse(value); } });
    assert.equal(result, exit); assert.equal(output.error.status, status);
  }
  let count = 0, output;
  const code = await run(['teams', 'create', '--file', '-', '--session-file', f.sessionFile, '--json'], { stdin: input(resources.teams.example), fetcher: () => { count++; throw new Error('raw-cookie-secret'); }, write: value => { output = value; } });
  assert.equal(code, 5); assert.equal(count, 1); assert.ok(!output.includes('raw-cookie-secret')); assert.match(output, /可能已经提交/);
  assert.equal(createClient({ sessionFile: f.sessionFile }).request instanceof Function, true);
});

test('task lifecycle CLI terminates the selected run and deletes through authenticated HTTP without implicit retries', async () => {
  const f = await fixture(), writes = [];
  const task = { id: 'task_old', title: '旧任务', status: 'awaiting_acceptance' };
  const runs = [{ id: 'run_latest', taskId: task.id }, { id: 'run_old', taskId: task.id }];
  let refuseDelete = true;
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Cookie, cookie);
    const path = url.slice(origin.length);
    if (options.method === 'GET') return new Response(JSON.stringify({ tasks: [task], runs }));
    writes.push({ path, method: options.method });
    if (options.method === 'DELETE') return new Response(JSON.stringify(refuseDelete ? { error: '存在活跃 Run' } : { task, runIds: runs.map(x => x.id), runFileCleanup: 'pending' }), { status: refuseDelete ? 409 : 202 });
    return new Response(JSON.stringify({ run: { ...runs.find(x => path.includes(x.id)), status: 'cancelled', manager: { systemPrompt: 'private' } } }));
  };
  const invoke = args => execute(['tasks', ...args, '--session-file', f.sessionFile], { fetcher });
  for (const op of ['terminate', 'delete']) await assert.rejects(invoke([op, task.id]), e => e.code === 'USAGE');
  await assert.rejects(invoke(['terminate', task.id, '--run', 'foreign_run', '--yes']), e => e.code === 'NOT_FOUND');
  assert.equal(writes.length, 0);
  await assert.rejects(invoke(['delete', task.id, '--yes']));
  assert.deepEqual(writes, [{ path: '/api/tasks/task_old', method: 'DELETE' }]);
  const terminated = await invoke(['terminate', task.id, '--run', 'run_old', '--yes']);
  assert.deepEqual(terminated, { taskId: task.id, run: { id: 'run_old', taskId: task.id, status: 'cancelled' } });
  assert.equal(writes.at(-1).path, '/api/runs/run_old/terminate');
  refuseDelete = false;
  const deleted = await invoke(['delete', task.id, '--yes']);
  assert.equal(deleted.runFileCleanup, 'pending');
  assert.deepEqual(deleted.runIds, ['run_latest', 'run_old']);
  assert.match(formatOutput(['tasks', 'delete'], deleted), /任务已删除/);
  assert.match(formatOutput(['tasks', 'terminate'], terminated), /已终止/);
});

test('runtimes models queries the real provider catalog endpoint with provider validation and no fabricated list', async () => {
  const f = await fixture();
  const catalog = { provider: 'codex', source: 'codex debug models（本机 CLI 目录）', notes: ['目录来自本机 codex CLI'], models: [{ id: 'gpt-real', label: 'GPT Real', levels: [{ id: 'high', default: true }] }] };
  const fetcher = async (url, options) => {
    const path = url.slice(origin.length);
    if (path.startsWith('/api/settings/runtime-profiles/models')) return new Response(JSON.stringify(catalog));
    return f.fetcher(url, options);
  };
  const invoke = (args) => execute([...args, '--session-file', f.sessionFile], { fetcher });
  const result = await invoke(['runtimes', 'models', 'codex']);
  assert.equal(result.models[0].id, 'gpt-real');
  assert.equal(result.models[0].levels[0].id, 'high');
  await invoke(['runtimes', 'models', 'claude-code', '--executable', '/custom/claude']);
  let seenUrl;
  const spy = async (url, options) => { seenUrl = url; return fetcher(url, options); };
  await execute(['runtimes', 'models', 'codex', '--executable', '/custom/codex', '--session-file', f.sessionFile], { fetcher: spy });
  const requested = new URL(seenUrl);
  assert.equal(requested.pathname, '/api/settings/runtime-profiles/models');
  assert.equal(requested.searchParams.get('provider'), 'codex');
  assert.equal(requested.searchParams.get('executable'), '/custom/codex');
  for (const args of [['runtimes', 'models'], ['runtimes', 'models', 'gpt-5'], ['runtimes', 'models', 'codex', '--yes'], ['runtimes', 'models', 'codex', 'extra']]) await assert.rejects(invoke(args), error => error.code === 'USAGE');
  const help = await captured(['runtimes', 'models', '--help'], { fetcher: () => { throw new Error('help must be offline'); } });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /models PROVIDER \[--executable PATH\]/);
  assert.match(help.stdout, /codex debug models/);
  assert.match(help.stdout, /不编造/);
  const text = await captured(['runtimes', 'models', 'codex', '--session-file', f.sessionFile], { fetcher });
  assert.match(text.stdout, /Provider 模型目录/);
  assert.match(text.stdout, /gpt-real/);
  assert.match(text.stdout, /思考档位|可选档位/);
});

test('runtime connection schema validates effort vocabulary and model stays free text', async () => {
  const f = await fixture();
  const base = { name: 'x', provider: 'claude-code', model: 'any-model-name', executable: '', profile: '', effort: '' };
  await f.invoke(['runtimes', 'create', '--file', '-'], base);
  assert.equal(f.calls.at(-1).body.model, 'any-model-name', 'manual model values are accepted');
  await f.invoke(['runtimes', 'create', '--file', '-'], { ...base, name: 'y', effort: 'max' });
  assert.equal(f.calls.at(-1).body.effort, 'max');
  await assert.rejects(f.invoke(['runtimes', 'create', '--file', '-'], { ...base, name: 'z', effort: 'extreme' }), error => error.code === 'USAGE');
  await assert.rejects(f.invoke(['runtimes', 'create', '--file', '-'], { ...base, name: 'z', effort: undefined, unknown: 1 }), error => error.code === 'USAGE');
  const schema = await execute(['schema', 'runtimes']);
  assert.deepEqual(schema.schema.properties.effort.enum, ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.match(schema.schema.properties.model.description, /runtimes models/);
});

test('repeat-import help and receipts expose overwrite behavior without changing input authority',async()=>{
  for(const [group,operation] of [['plugins','import'],['mcps','create']]){
    const result=await captured([group,operation,'--help']);assert.match(result.stdout,/覆盖/);assert.match(result.stdout,/replacements/);
    const receipt={replacements:[{kind:group==='plugins'?'plugin':'mcp',id:'new-version',previousId:'old-version',name:'同名项'}],employees:[{id:'employee-id',name:'员工'}],historyRetained:true};
    const output=formatOutput([group,operation],receipt);assert.match(output,/覆盖 1 个已有版本/);assert.match(output,/更新 1 位员工/);assert.match(output,/old-version/);
  }
});
