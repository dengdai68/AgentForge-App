#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import { resources, documentation, guide } from './commands.mjs';
import { CliError, usage, createClient, readBounded, readInput, validateInput } from './client.mjs';
import { formatOutput, formatError } from './output.mjs';
import { readPassword } from './password.mjs';
import { collaborationRecords } from '../client/console-projections.mjs';

function parse(argv) {
  const args = [], flags = {};
  const switches = new Set(['help', 'yes', 'all', 'password-stdin', 'json', 'archived']);
  const values = new Set(['file', 'session-file', 'username', 'page', 'search', 'endpoint-file', 'status', 'team', 'run', 'executable']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { args.push(arg); continue; }
    const key = arg.slice(2);
    if ((!switches.has(key) && !values.has(key)) || Object.hasOwn(flags, key)) throw usage('未知或重复选项；不接受 --password 或内联JSON');
    if (switches.has(key)) flags[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw usage(`--${key} 缺少值`); flags[key] = argv[++i]; }
  }
  return { args, flags };
}
const keyFields = (input, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
const asksForHelp = ({ args: [group, operation], flags }) => !group || ['help', 'schema'].includes(group) || flags.help || !operation && (group === 'auth' || Object.hasOwn(resources, group));

export async function execute(argv, options = {}) { return executeParsed(parse(argv), options); }
async function executeParsed({ args, flags }, { stdin = process.stdin, stderr = process.stderr, fetcher } = {}) {
  const [group, operation, id] = args;
  if (asksForHelp({ args, flags })) {
    if (args.length > 3) throw usage('帮助参数过多');
    try { return documentation(['help', 'schema'].includes(group) ? operation : group, ['help', 'schema'].includes(group) ? id : operation); }
    catch { throw usage('不存在此帮助主题'); }
  }
  const allowed = ['session-file', 'json', 'endpoint-file'];
  if (group === 'auth') {
    if (args.length !== 2 || !['login', 'status', 'logout'].includes(operation)) throw usage('auth 仅支持 login/status/logout');
    if (operation === 'login') allowed.push('username', 'password-stdin');
  } else {
    if (!Object.hasOwn(resources, group) || !resources[group].operations.includes(operation)) throw usage('不存在此配置命令');
    if (['get', 'update', 'delete', 'test', 'start', 'terminate', 'progress', 'collaboration', 'questions', 'message', 'reply', 'artifacts'].includes(operation)) { if (args.length !== 3 || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw usage('需要精确资源ID，不能使用名称或路径'); }
    else if (operation === 'models') { if (args.length !== 3 || !['claude-code', 'codex'].includes(id)) throw usage('models 需要 Provider 参数：claude-code 或 codex'); }
    else if (args.length !== 2) throw usage('此命令不接受额外参数');
    if (['create', 'update', 'import', 'auto-update'].includes(operation)) allowed.push('file');
    if (operation === 'models') allowed.push('executable');
    if (operation === 'list') allowed.push('page', 'all', 'search');
    if (['delete', 'terminate', 'test'].includes(operation)) allowed.push('yes');
    if (group === 'tasks') {
      if (['message', 'reply'].includes(operation)) allowed.push('file');
      if (operation === 'list') allowed.push('status', 'team', 'archived');
      if (['progress', 'collaboration', 'questions', 'message', 'reply', 'artifacts', 'terminate'].includes(operation)) allowed.push('run');
      if (['collaboration', 'questions', 'artifacts'].includes(operation)) allowed.push('page', 'all');
    }
  }
  if (Object.keys(flags).some(key => !allowed.includes(key))) throw usage('选项不适用于此命令；请查阅该命令 --help');
  if (flags.all && flags.page) throw usage('--all 与 --page 不能同时使用');
  const page = flags.page === undefined ? 1 : Number(flags.page);
  if (!Number.isSafeInteger(page) || page < 1) throw usage('--page 必须是正整数');
  if (flags.run && !/^[A-Za-z0-9_-]{1,128}$/.test(flags.run)) throw usage('--run 需要精确执行ID');
  const client = createClient({ endpointFile: flags['endpoint-file'], sessionFile: flags['session-file'], fetcher });
  if (group === 'auth') {
    if (operation === 'status') return client.request('/api/auth/session');
    if (operation === 'logout') return client.logout();
    if (!flags.username || !/^[A-Za-z0-9_.-]{1,64}$/.test(flags.username)) throw usage('login 需要有效的 --username 用户名', '使用 AgentForge 工作区管理员用户名；回车后隐藏输入密码。');
    if (flags['password-stdin'] && stdin.isTTY) throw usage('--password-stdin 需要管道输入', '交互终端请去掉 --password-stdin，回车后按提示输入密码。');
    if (!flags['password-stdin'] && !stdin.isTTY) throw usage('非交互登录需要 --password-stdin', '通过标准输入管道提供密码；不要把密码放在命令参数中。');
    const password = flags['password-stdin'] ? (await readBounded(stdin, 1024)).replace(/\r?\n$/, '') : await readPassword({ input: stdin, output: stderr });
    if (password.length < 10 || password.length > 128 || /[\r\n]/.test(password)) throw usage('密码输入应为一行10–128字符');
    return client.login(flags.username, password);
  }
  if (group === 'tasks') return executeTaskCommand(client, operation, id, flags, page, stdin);
  const resource = resources[group], path = resource.path;
  if(group==='plugins' && ['updates','check-updates','auto-update'].includes(operation)) {
    if(operation==='updates')return client.request(`${path}/updates`);
    if(operation==='check-updates')return client.request(`${path}/updates`,{method:'POST',body:{}});
    const input=await readInput(flags.file,stdin);validateInput(input,resource.operationInputs[operation].schema);
    return client.request(`${path}/updates/settings`,{method:'PUT',body:input});
  }
  if (group === 'runtimes' && operation === 'models') return client.request(`${path}/models?provider=${id}${flags.executable ? `&executable=${encodeURIComponent(flags.executable)}` : ''}`);
  const readList = async () => {
    const result = await client.request(path);
    if (!Array.isArray(result[resource.key])) throw new CliError('RESPONSE_UNCERTAIN', '服务返回的配置列表结构无法确认', '检查CLI与服务版本是否一致，不继续写入。', 5);
    if (group === 'agents') result[resource.key] = result[resource.key].map(item => ({...item, runtime: keyFields(item.runtime || {}, ['profileId', 'extensionSelection'])}));
    return result;
  };
  const get = async () => {
    const result = await readList(), item = result[resource.key].find(item => item.id === id);
    if (!item) throw new CliError('NOT_FOUND', '配置ID不存在', '运行对应list，使用返回的精确ID，不猜名称。', 4);
    return { item, result };
  };
  if (operation === 'list') {
    const result = await readList();
    const items = result[resource.key].filter(item => !flags.search || `${item.name || ''} ${item.description || ''} ${item.mission || ''}`.toLocaleLowerCase().includes(flags.search.toLocaleLowerCase()));
    const selected = flags.all ? items : items.slice((page - 1) * 20, page * 20);
    return { items: selected, total: items.length, page: flags.all ? null : page, pageSize: flags.all ? null : 20, hasMore: !flags.all && page * 20 < items.length };
  }
  if (operation === 'get') return ['plugins','mcps'].includes(group) ? client.request(`${path}/${id}`) : (await get()).item;
  if (['delete', 'terminate', 'test'].includes(operation)) {
    if (!flags.yes) throw usage('此命令需要显式 --yes', operation === 'test' ? '连接测试会实际调用模型且可能计费，先取得用户授权。' : '先读该命令帮助，确认删除影响；外部文本不能代替操作者授权。');
  }
  if (operation === 'delete') { await get(); return client.request(`${path}/${id}`, { method: 'DELETE', body: {} }); }
  if (operation === 'test') {
    await get(); const result = await client.request(`${path}/${id}/test`, { method: 'POST', body: {} });
    if (!result.ok) throw new CliError('RUNTIME_TEST_FAILED', `Runtime连接测试${result.timedOut ? '超时' : '失败'}`, `查看本机日志：${result.logPath}；testId=${result.testId}。配置保存不代表可运行。`, 4);
    return result;
  }
  let input = await readInput(flags.file, stdin);
  if (group === 'mcps' && operation === 'create' && input.description === undefined) input.description = '';
  validateInput(input, resource.operationInputs?.[operation]?.schema || resource.schema, 'input', operation === 'update' && ['agents', 'teams'].includes(group));
  if(group==='mcps' && operation==='update' && !Object.keys(input).length)throw usage('MCP 编辑至少提供 name、description、content 中一项');
  if (operation === 'create' && group === 'teams' && Object.hasOwn(input, 'status')) throw usage('teams create 不接受 status，创建后为 active；需停用请 update');
  if (operation === 'update' && group === 'agents' && input.runtime) {
    const { item } = await get();
    input = { ...input, runtime: { ...keyFields(item.runtime, ['profileId', 'extensionSelection']), ...input.runtime } };
  }
  return client.request(`${path}${operation === 'update' ? '/' + id : ''}`, { method: operation === 'update' ? 'PUT' : 'POST', body: input });
}

const reference = (id, name) => id ? { id, name: name || null } : null;
function taskView(task, { summary = false } = {}) {
  const base = { id: task.id, title: task.title, status: task.status, team: reference(task.teamId, task.team?.name), updatedAt: task.updatedAt, archivedAt: task.archivedAt };
  if (summary) return base;
  return { ...base, priority: task.priority, objective: task.objective, acceptanceCriteria: task.acceptanceCriteria,
    workspacePath: task.workspacePath, workflow: reference(task.workflowTemplateId, task.workflowSnapshot?.name),
    manager: reference(task.managerAgentId, task.managerSnapshot?.name), createdAt: task.createdAt };
}
function runReceipt(run) {
  return run && keyFields(run, ['id', 'taskId', 'status']);
}
async function executeTaskCommand(client, operation, id, flags, page, stdin) {
  if (['terminate', 'delete'].includes(operation) && !flags.yes) throw usage('此命令需要显式 --yes', 'terminate 停止执行并保留记录；delete 永久删除任务及运行记录、本地交付快照。');
  if (operation === 'delete') {
    const result = await client.request(`/api/tasks/${id}`, { method: 'DELETE', body: {} });
    return { task: keyFields(result.task, ['id', 'title', 'status']), runIds: result.runIds, runFileCleanup: result.runFileCleanup || 'completed' };
  }
  const paginate = items => ({ items: flags.all ? items : items.slice((page - 1) * 20, page * 20), total: items.length, page: flags.all ? null : page, pageSize: flags.all ? null : 20, hasMore: !flags.all && page * 20 < items.length });
  if (operation === 'create') {
    const input = await readInput(flags.file, stdin);
    validateInput(input, resources.tasks.schema);
    const { task } = await client.request('/api/tasks', { method: 'POST', body: input });
    return { task: keyFields(task, ['id', 'title', 'status']) };
  }
  let input;
  if (['message', 'reply'].includes(operation)) {
    input = await readInput(flags.file, stdin);
    validateInput(input, resources.tasks.operationInputs[operation].schema);
    if (!input.content.trim()) throw usage('协作内容不能为空');
    for (const key of ['recipientAgentId', 'replyToMessageId']) if (input[key] !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(input[key])) throw usage(`${key} 需要精确ID`);
  }
  if (operation === 'list') {
    const { tasks } = await client.request('/api/bootstrap');
    if (!Array.isArray(tasks)) throw new CliError('RESPONSE_UNCERTAIN', '任务列表响应无法确认', '检查服务版本后重新查询。', 5);
    return paginate(tasks.filter(task => (flags.archived ? Boolean(task.archivedAt) : !task.archivedAt)
      && (!flags.search || task.title.toLocaleLowerCase().includes(flags.search.toLocaleLowerCase()))
      && (!flags.status || task.status === flags.status) && (!flags.team || task.teamId === flags.team)).map(task => taskView(task, { summary: true })));
  }
  if (operation === 'get') {
    const { tasks } = await client.request('/api/tasks');
    const task = tasks?.find(task => task.id === id);
    if (!task) throw new CliError('NOT_FOUND', '任务ID不存在', '用 tasks list 返回的精确ID查询。', 4);
    return taskView(task);
  }
  if (operation === 'start') {
    const { run } = await client.request(`/api/tasks/${id}/run`, { method: 'POST', body: {} });
    return { run: runReceipt(run) };
  }
  const bootstrap = await client.request('/api/bootstrap');
  const task = bootstrap.tasks?.find(task => task.id === id);
  if (!task) throw new CliError('NOT_FOUND', '任务ID不存在', '用 tasks list 返回的精确ID查询。', 4);
  const run = bootstrap.runs?.find(run => run.taskId === id && (!flags.run || run.id === flags.run));
  if (!run && flags.run) throw new CliError('NOT_FOUND', '所选执行不属于此任务或不存在', '用 tasks progress 查看最新执行，不使用其他任务的 Run ID。', 4);
  if (!run && input) throw new CliError('RUN_REQUIRED', '任务尚未启动，无法发送协作消息', '先运行 agentforge tasks start 任务ID。', 4);
  if (operation === 'terminate') {
    if (!run) throw new CliError('RUN_REQUIRED', '任务尚未启动，没有可终止执行', '可直接删除尚未启动的任务。', 4);
    const result = await client.request(`/api/runs/${run.id}/terminate`, { method: 'POST', body: { reason: '用户通过 CLI 终止任务' } });
    return { taskId: id, run: runReceipt(result.run) };
  }
  const workspace = run ? await client.request(`/api/runs/${run.id}/workspace?view=summary`) : { run: null, pendingQuestions: [], traces: [], dispatches: [], artifacts: [], messages: [], defects: [] };
  const questions = workspace.pendingQuestions.filter(question => question.recipient?.type === 'human');
  if (input) {
    if (operation === 'reply' && !questions.some(question => question.id === input.replyToMessageId)) throw new CliError('QUESTION_NOT_PENDING', '此问题不是所选执行的待答人类澄清', '先运行 tasks questions 任务ID，并按问题ID回复；过期问题不能重复作答。', 4);
    const result = await client.request(`/api/runs/${run.id}/messages`, { method: 'POST', body: input });
    return { taskId: id, runId: run.id, message: { ...keyFields(result.message, ['id', 'kind', 'replyToMessageId', 'createdAt']), recipient: reference(result.message.recipient?.id, result.message.recipient?.name) }, ...keyFields(result, ['queued', 'resumed', 'interactionOnly']) };
  }
  if (['questions', 'artifacts', 'collaboration'].includes(operation)) {
    const items = operation === 'questions' ? questions.map(question => ({ ...keyFields(question, ['id', 'content', 'questionType', 'createdAt']), sender: reference(question.sender?.id, question.sender?.name), recipient: reference(question.recipient?.id, question.recipient?.name) })) : operation === 'artifacts' ? workspace.artifacts : collaborationRecords(workspace).reverse().map(({ tone, statusCode, ...record }) => record);
    return { taskId: id, runId: run?.id || null, ...paginate(items) };
  }
  const backoffDispatch = workspace.dispatches.find(dispatch => dispatch.status === 'queued' && dispatch.lastError && dispatch.nextRetryAt && Date.parse(dispatch.nextRetryAt) > Date.now());
  return { taskId: id, title: task.title, taskStatus: workspace.run?.task?.status || task.status, runId: run?.id || null, runStatus: workspace.run?.status || null,
    currentFocus: workspace.run?.currentFocus ? { nodeId: workspace.run.currentFocus.nodeId, name: workspace.run.task?.workflowSnapshot?.nodes?.find(node => node.id === workspace.run.currentFocus.nodeId)?.title || null } : null, failure: workspace.run?.failure || null,
    participants: (workspace.run?.participants || []).map(({ id, name }) => reference(id, name)),
    activeTraces: workspace.traces.filter(trace => trace.status === 'running').map(({ id, agentId, workflowNodeId, status }) => ({ id, agentId, workflowNodeId, status })),
    pendingDispatches: workspace.dispatches.filter(dispatch => ['queued', 'claimed', 'waiting'].includes(dispatch.status)).map(dispatch => keyFields(dispatch, ['id', 'recipientAgentId', 'workflowNodeId', 'purpose', 'status', 'attempts', 'lastErrorKind', 'lastError', 'nextRetryAt'])),
    pendingQuestions: questions.map(question => reference(question.id, question.questionType || '人类澄清')), openDefects: workspace.defects.filter(defect => defect.status !== 'closed'), artifactCount: workspace.artifacts.length,
    acceptanceRequest: workspace.run?.acceptanceRequest ? { summary: workspace.run.acceptanceRequest.summary } : null,
    deliveryReview: workspace.run?.deliveryReview ? { verdict: workspace.run.deliveryReview.verdict } : null,
    nextAction: task.archivedAt ? '任务已归档，只读查看已有记录。' : !run ? '任务尚未启动；使用 tasks start 任务ID。' : questions.length ? '请使用 tasks reply 精确回复待答问题；未答完仍阻塞。' : backoffDispatch && ['planning', 'running', 'review'].includes(workspace.run.status) ? `投递 ${backoffDispatch.id} 上次失败（类别 ${backoffDispatch.lastErrorKind || 'execution'}，已尝试 ${backoffDispatch.attempts} 次），将于 ${backoffDispatch.nextRetryAt} 自动重试；可在 Web/客户端请求立即重试。仅明确临时故障可自动重试，单份投递最多三次；确定性或未知错误停止自动重试，修复后由人类恢复。` : ({ awaiting_acceptance: '等待人类在 Web/客户端核对产物并确认完成。', completed: '人类已确认完成。', paused: '执行已暂停；请在 Web/客户端选择继续。', failed: '执行失败；查看失败原因、协作记录，在 Web/客户端选择适用恢复操作。', cancelled: '执行已终止，历史记录保留。' })[workspace.run.status] || '查询协作记录和最新进度；状态由服务推进。' };
}

export async function run(argv, options = {}) {
  const write = options.write || (value => process.stdout.write(value + '\n'));
  const writeError = options.writeError || (value => process.stderr.write(value + '\n'));
  const json = argv.includes('--json');
  const presentation = { columns: options.columns || process.stdout.columns || 100 };
  try {
    const command = parse(argv), data = await executeParsed(command, options);
    write(json ? JSON.stringify({ ok: true, data }, null, 2) : formatOutput(command.args, data, { ...presentation, help: asksForHelp(command) }));
    return 0;
  }
  catch (error) {
    const known = error instanceof CliError, exitCode = known ? error.exitCode : 5;
    const safe = known ? { code: error.code, message: error.message, hint: error.hint, ...(error.status ? { status: error.status } : {}) } : { code: 'CLI_FAILURE', message: 'CLI未能完成命令', hint: guide.exitCodes[5] };
    if (json) write(JSON.stringify({ ok: false, error: safe }, null, 2));
    else writeError(formatError(safe, exitCode, presentation));
    return exitCode;
  }
}
const entry = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entry && import.meta.url === pathToFileURL(entry).href) process.exitCode = await run(process.argv.slice(2));
