import { guide } from './commands.mjs';

// Plain text only: untrusted names/errors must never emit terminal control codes.
export const text = value => String(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const width = value => Array.from(value).reduce((n, char) => n + (/\p{Mark}/u.test(char) || /[\u200d\ufe0f]/u.test(char) ? 0 : char.codePointAt(0) >= 0x1100 ? 2 : 1), 0);
function paragraph(value, columns, indent = '') {
  return text(value).split('\n').map(line => {
    const lines = []; let current = indent;
    for (const token of line.match(/[A-Za-z0-9_./~<>{}:\[\]@|+\-]+|[^\S\n]+|./gu) || []) {
      if (width(current + token) > columns && current !== indent) { lines.push(current.trimEnd()); current = indent; }
      if (current === indent && /^\s+$/.test(token)) continue;
      if (width(token) > columns - width(indent)) {
        for (const char of token) {
          if (width(current + char) > columns && current !== indent) { lines.push(current); current = indent; }
          current += char;
        }
      } else current += token;
    }
    return [...lines, current].join('\n');
  }).join('\n');
}
const groups = { tasks: '任务', agents: '数字员工', roles: '角色', teams: '团队', workflows: '工作流', runtimes: 'Runtime', plugins: '插件', mcps: 'MCP' };
const operations = { list: '列出与搜索配置', get: '读取完整详情', create: '创建配置', update: '更新配置', delete: '删除允许删除的配置', test: '真实测试模型连接', import: '安装来源中的全部插件', models: '查询 Provider 可用模型与思考档位' };
Object.assign(operations, {updates:'查询插件更新状态','check-updates':'立即检查Git插件更新','auto-update':'设置自动更新开关与周期'});
const labels = { id: 'ID', name: '名称', description: '说明', kind: '类型', status: '状态', provider: 'Provider', model: '模型', executable: 'CLI 路径', profile: 'Codex profile', profileId: 'Runtime 配置 ID', runtime: '执行配置', systemPrompt: '执行与协作提示词', roleId: '绑定角色 ID', prompt: '共用系统提示词', capabilities: '能力', repository: '绑定仓库', memberAgentIds: '业务成员 ID', managerAgentId: '项目经理 ID', mission: '团队目标', nodes: '工作流节点', staffingGuidance: '人员需求', dependsOn: '前置节点', handoffFrom: '交接来源', deliverable: '交付要求', artifactPaths: '建议交付位置', extensionSelection: '扩展选择', pluginIds: '整插件版本 ID', mcpIds: 'MCP 版本 ID', username: '管理员', expiresAt: '会话到期时间', sessionFile: '私有会话文件', system: '系统配置', createdAt: '创建时间', updatedAt: '更新时间', logPath: '本机日志', testId: '连接测试 ID', unsupported: '未加载组件', plugins: '插件', skills: '技能', entries: '组件', effort: '思考等级', levels: '可选档位', models: '模型', notes: '来源说明', source: '来源', current: '当前生效', resolvedTo: '解析到模型', supportedInApi: 'API 可用', default: '默认档位' };
Object.assign(labels, { deleted: '已删除', historyRetained: '历史文件保留' });
Object.assign(labels, { previousId: '更新前 ID', employees: '已更新的员工引用' });
Object.assign(labels, {enabled:'自动更新',intervalMinutes:'检查周期（分钟）',intervalMs:'检查间隔（毫秒）',running:'正在检查',lastCheckedAt:'最近检查',nextCheckAt:'下次检查',lastResult:'最近结果',checkedSources:'已检查来源',updatedPlugins:'已更新插件数',updates:'更新记录',errors:'未应用的来源',message:'说明'});
Object.assign(labels, { compatibility:'Runtime 兼容性', supported:'支持', reasons:'不兼容原因', 'claude-code':'Claude Code', codex:'Codex', providers:'支持的 Runtime' });
const label = key => labels[key] ? `${labels[key]} (${key})` : text(key);
Object.assign(labels, { team: '团队', workflow: '工作流', manager: '项目经理', workspacePath: '工作目录', title: '任务名称', objective: '用户目标', teamId: '团队 ID', workflowTemplateId: '工作流 ID', acceptanceCriteria: '验收要求', priority: '优先级', attempts: '尝试次数', lastErrorKind: '失败类别', lastError: '上次失败', nextRetryAt: '下次重试时间', taskId: '任务 ID', runId: '执行 ID', taskStatus: '任务状态', runStatus: '执行状态', currentFocus: '当前重心', pendingQuestions: '待答人类问题', pendingDispatches: '未结束投递', activeTraces: '正在执行', participants: '执行成员', openDefects: '未关闭缺陷', artifactCount: '已接纳交付数', acceptanceRequest: '经理验收交接', deliveryReview: '历史交付复核', nextAction: '下一步', content: '内容', replyToMessageId: '所回复问题 ID', recipientAgentId: '接收成员 ID', items: '记录', total: '总数', summary: '交付摘要', failure: '失败原因', timestamp: '时间', from: '发送方', to: '接收方' });
function scalar(value, key) {
  if (key === 'expiresAt' && value === null) return '不过期（主动退出或撤销后失效）';
  if (value === null) return '未设置 (null)';
  if (value === undefined) return '未提供';
  if (typeof value === 'boolean') return value ? '是 (true)' : '否 (false)';
  if (value === '') return '空字符串';
  if (key === 'expiresAt' && typeof value === 'number' && Number.isFinite(new Date(value).getTime())) return `${new Date(value).toISOString()} (${value})`;
  return String(value);
}
function details(value, columns, indent = '', key = '') {
  if (!value || typeof value !== 'object') return paragraph(scalar(value, key), columns, indent);
  const entries = Object.entries(value);
  if (!entries.length) return indent + (Array.isArray(value) ? '无（空列表）' : '无（空对象）');
  return entries.map(([name, item]) => {
    const title = Array.isArray(value) ? `${Number(name) + 1}.` : `${label(name)}：`;
    if (item && typeof item === 'object') return `${indent}${title}\n${details(item, columns, indent + '  ', name)}`;
    if (typeof item === 'string' && item.includes('\n')) return `${indent}${title}\n${text(item).split('\n').map(line => indent + '  ' + line).join('\n')}`;
    return paragraph(`${title} ${scalar(item, name)}`, columns, indent);
  }).join('\n');
}
export function commandUsage(group, operation) {
  if (group === 'tasks') return `agentforge tasks ${operation}${['list', 'create'].includes(operation) ? '' : ' TASK_ID'}${['create', 'message', 'reply'].includes(operation) ? ' --file FILE.json' : ''}${operation === 'list' ? ' [--search TEXT] [--status STATUS] [--team ID] [--archived] [--page N | --all]' : ['collaboration', 'questions', 'artifacts'].includes(operation) ? ' [--run RUN_ID] [--page N | --all]' : ['progress', 'message', 'reply', 'terminate'].includes(operation) ? ' [--run RUN_ID]' : ''}${['terminate', 'delete'].includes(operation) ? ' --yes' : ''}`;
  if (group === 'auth') return `agentforge auth ${operation}${operation === 'login' ? ' --username NAME [--password-stdin]' : ''}`;
  const id = ['get', 'update', 'delete', 'test'].includes(operation) ? ' ID' : operation === 'models' ? ' PROVIDER' : '';
  const file = ['create', 'update', 'import', 'auto-update'].includes(operation) ? ' --file FILE.json' : '';
  const yes = ['delete', 'test'].includes(operation) ? ' --yes' : '';
  return `agentforge ${group} ${operation}${id}${file}${yes}${operation === 'models' ? ' [--executable PATH]' : ''}${operation === 'list' ? ' [--page N | --all] [--search TEXT]' : ''}`;
}
function fields(schema, columns, prefix = '', nested = false) {
  return Object.entries(schema.properties || {}).flatMap(([name, field]) => {
    const path = prefix + name, type = Array.isArray(field.type) ? field.type.join(' | ') : field.type;
    const required = schema.required?.includes(name) ? (nested ? '父项提供时必填' : '必填') : '可选';
    const constraints = [field.enum && `可选值：${field.enum.join(' / ')}`, field.pattern && `格式：${field.pattern}`, field.minItems && `至少 ${field.minItems} 项`, field.maxLength && `最多 ${field.maxLength} 字符`].filter(Boolean);
    const description = field.description || '按类型提供；详见输入模板。';
    const output = [paragraph(`${path}  ${type}${field.items ? '<' + field.items.type + '>' : ''} · ${required}`, columns, '  '), paragraph([constraints.length ? description.replace(/[。；]$/, '') : description, ...constraints].join('；'), columns, '    ')];
    if (field.properties) output.push(...fields(field, columns, path + '.', true));
    if (field.items?.properties) output.push(...fields(field.items, columns, path + '[].', true));
    return output;
  });
}
const section = (heading, content) => `${heading}\n${content}`;
const bullets = (values, columns) => values.map(value => paragraph('• ' + value, columns, '  ')).join('\n');
function applicableFlags(group, ops) {
  if (group === 'tasks') return [
    ...(ops.some(op => ['terminate', 'delete'].includes(op)) ? ['--yes：显式确认终止执行或永久删除任务及本地交付记录；活跃任务须先 terminate。'] : []),
    ...guide.flags.filter(([flag]) => ['--help', '--json', '--session-file PATH', '--endpoint-file PATH'].includes(flag)).map(([flag, description]) => `${flag}：${description}`),
    ...(ops.some(op => ['create', 'message', 'reply'].includes(op)) ? ['--file PATH | -：JSON 对象文件；- 从 stdin 读取，最多1MiB；字段与示例见下方。'] : []),
    ...(ops.includes('list') ? ['--search TEXT：任务名称不区分大小写包含匹配。', '--status STATUS：精确任务状态：backlog/planning/running/awaiting_human/review/awaiting_acceptance/paused/blocked/done/cancelled。', '--team ID：精确团队ID，可与名称/状态组合。', '--archived：仅查询已归档任务，默认只显示未归档。'] : []),
    ...(ops.some(op => ['list', 'collaboration', 'questions', 'artifacts'].includes(op)) ? ['--page N | --all：默认每页20项；--all 显式读取全部，不可与 --page 混用。协作记录最新在前。'] : []),
    ...(ops.some(op => ['progress', 'collaboration', 'questions', 'artifacts', 'message', 'reply', 'terminate'].includes(op)) ? ['--run RUN_ID：可选，选择同一任务的指定执行；默认最新执行，输出回显所选 runId。'] : [])
  ];
  return guide.flags.filter(([flag]) => {
    if (flag.startsWith('--file')) return ops.some(op => ['create', 'update', 'import', 'auto-update'].includes(op));
    if (flag === '--yes') return ops.some(op => ['delete', 'test'].includes(op));
    if (flag.startsWith('--page') || flag.startsWith('--search')) return ops.includes('list');
    if (flag.startsWith('--username')) return group === 'auth' && ops.includes('login');
    if (flag === '--password-stdin') return group === 'auth' && ops.includes('login');
    if (flag.startsWith('--executable')) return ops.includes('models');
    return true;
  }).map(([flag, description]) => {
    if (flag === '--yes' && ops.length === 1) description = ops[0] === 'delete'
      ? '显式确认删除该 ID 的配置；真实引用仍由服务校验，不自动解除引用或删除历史。'
      : '授权一次真实模型连接测试，可能消耗账号额度；不是业务交付。';
    return `${flag}：${description}`;
  });
}
function help(data, columns, { schema = false } = {}) {
  if (!data.group) return [
    text(data.product.summary),
    section('命令目录', [
      '  tasks      任务 / 进度 / 协作 / 澄清', '  agents     数字员工', '  roles      角色（共用系统提示词）', '  mcps       MCP 市场', '  plugins    插件市场',
      '  workflows  工作流', '  teams      团队', '  runtimes   Runtime 配置与连接查询',
      '  auth       登录 / 会话状态 / 退出登录'
    ].join('\n')),
    '查看具体操作参数：在命令后加 --help，例如 agentforge agents get --help。'
  ].join('\n\n');
  if (!data.operation && (!schema || data.group === 'auth')) return [
    `AgentForge CLI — ${data.group === 'auth' ? '管理员会话' : groups[data.group]}`,
    ...(data.group === 'auth' ? [] : [paragraph(data.description, columns)]),
    section('子命令', (data.group === 'auth' ? [
      ['login', '登录已有管理员账号'], ['status', '验证本 CLI 会话状态'], ['logout', '退出本 CLI 会话']
    ] : data.operations.map(op => [op, data.group === 'tasks' ? ({ list: '搜索任务列表', get: '读取任务目标与要求', create: '创建待启动任务', start: '启动真实任务执行', terminate: '终止执行并保留记录', delete: '永久删除任务及本地记录', progress: '读取当前执行进度与下一步', collaboration: '查看协作消息（最新在前）', questions: '查询未答人类澄清', message: '向一位指定成员发送指令', reply: '按问题 ID 精确回复澄清', artifacts: '查询已接纳交付信息' })[op] : operations[op]])).map(([op, description]) => `  ${op.padEnd(14)} ${description}`).join('\n')),
    `查看具体操作参数：在命令后加 --help，例如 agentforge ${data.group} ${data.group === 'auth' ? 'login' : 'list'} --help。`
  ].join('\n\n');
  if (data.group === 'auth') return [
    'AgentForge CLI — 管理员会话',
    section('用法', '  ' + commandUsage('auth', data.operation || 'status')),
    section('参数与前置条件', bullets([guide.transport, ...applicableFlags('auth', [data.operation || 'status'])], columns)),
    section('行为与会话', bullets([guide.auth[data.operation || 'status'], guide.auth.storage], columns)),
    ...(data.operation === 'login' ? [section('交互登录', '  agentforge auth login --username 你的用户名\n  回车后按提示输入密码，输入不回显；Ctrl+C 取消。'), section('脚本/AI模式（密码不放命令参数，变量由操作者安全提供）', '  printf "%s\\n" "$AF_LOGIN_PASSWORD" | agentforge auth login --username 你的用户名 --password-stdin\n  unset AF_LOGIN_PASSWORD')] : []),
    section('输出', paragraph(guide.output, columns, '  ')),
    section('退出码与恢复', bullets(Object.entries(guide.exitCodes).map(([code, value]) => `${code}：${value}`), columns)),
    section('安全边界', bullets(guide.limits, columns))
  ].join('\n\n');
  const ops = data.operation ? [data.operation] : data.operations;
  const writing = schema || ['create', 'update', 'import', 'message', 'reply', 'auto-update'].includes(data.operation);
  const notes = schema ? data.notes : writing
    ? data.notes.filter(note => !/^(delete |test )/.test(note))
    : data.notes.filter(note => note.startsWith(`${data.operation} `));
  const id = ['get', 'update', 'delete', 'test', 'start', 'progress', 'collaboration', 'questions', 'message', 'reply', 'artifacts'].includes(data.operation);
  return [
    `AgentForge CLI — ${groups[data.group]}${data.operation ? ' / ' + data.operation : ''}`,
    paragraph(data.description, columns),
    ...(data.disclosure ? [paragraph(data.disclosure, columns)] : []),
    section('用法', ops.map(op => `  ${commandUsage(data.group, op)}${data.group !== 'tasks' && operations[op] ? ' — ' + operations[op] : ''}`).join('\n')),
    section('参数与前置条件', bullets([guide.transport, ...(id ? ['ID：必填精确资源ID，从本组 list/get 返回值获取；不能使用名称或路径。'] : []), ...applicableFlags(data.group, ops), '认证会话与客户端独立。用法未列的专用参数不可混用。'], columns)),
    ...(writing ? [section('输入模式', paragraph(data.inputMode, columns, '  ')), section('完整字段说明', fields(data.schema, columns).join('\n')), section('JSON 输入模板（替换占位 ID 后保存到 FILE.json）', JSON.stringify(data.example, null, 2).split('\n').map(line => '  ' + line).join('\n'))] : []),
    ...((data.group === 'tasks' ? data.notes : notes).length ? [section('行为、限制与更新语义', bullets(data.group === 'tasks' ? data.notes : notes, columns))] : []),
    section('回读与下一步', bullets([...(writing ? [data.readBeforeWrite] : []), `查看${groups[data.group]}：agentforge ${data.group} list；详情：agentforge ${data.group} get ID。`, `完整字段：agentforge schema ${data.group}；机器目录加 --json。配置保存不代表已执行，也不确认任何 Task 完成。`], columns)),
    section('输出', paragraph(guide.output, columns, '  ')),
    section('失败恢复', bullets(Object.entries(guide.exitCodes).map(([code, value]) => `${code}：${value}`), columns)),
    section('安全与非效果', bullets(data.safety, columns))
  ].join('\n\n');
}
function list(group, data, columns) {
  const count = value => Array.isArray(value) ? value.length : '—';
  const extra = {
    tasks: [['状态', item => item.status], ['团队', item => item.team?.name || item.teamId]],
    agents: [['类型', item => item.kind], ['状态', item => item.status], ['角色', item => item.roleId || '不绑定']],
    roles: [['提示词', item => (item.prompt || '').length > 60 ? item.prompt.slice(0, 60) + '…' : item.prompt || '—']],
    teams: [['状态', item => item.status]],
    runtimes: [['Provider', item => item.provider], ['模型', item => item.model || 'CLI 默认'], ['思考等级', item => item.effort || 'CLI 默认']],
    workflows: [['节点数', item => count(item.nodes)]],
    plugins: [['Runtime',item=>(item.providers || []).map(provider=>provider==='codex'?'Codex':'Claude Code').join(' / ') || '暂无兼容 Runtime'],['组件', item => `Skill ${item.components?.skills || 0} / Agent ${item.components?.agents || 0} / Hook ${item.components?.hooks || 0}`]],
    mcps: [['说明', item => item.description]]
  }[group];
  const headings = ['ID', '名称', ...extra.map(([heading]) => heading)];
  const rows = data.items.map(item => [item.id, item.name || item.title, ...extra.map(([, read]) => read(item))].map(value => text(value ?? '—').replaceAll('\n', ' ↵ ')));
  const widths = headings.map((head, i) => rows.reduce((max, row) => Math.max(max, width(row[i])), width(head)));
  const body = rows.length ? widths.reduce((a, b) => a + b, 4) <= columns
    ? [headings, ...rows].map(row => row.map((cell, i) => cell + ' '.repeat(Math.max(0, widths[i] - width(cell)))).join('  ').trimEnd()).join('\n')
    : rows.map((row, index) => `${index + 1}. ${row[1]}\n${row.map((cell, i) => i === 1 ? null : `   ${headings[i]}：${cell}`).filter(Boolean).join('\n')}`).join('\n\n')
    : data.total ? '本页没有记录；请检查页码。' : group === 'tasks' ? '没有匹配的任务；请检查名称、状态、团队和归档条件。' : '没有匹配的配置；若使用了 --search，请检查或清除搜索条件。';
  return [
    `${groups[group]}列表`, body,
    `共 ${data.total} 项；本次展示 ${data.items.length} 项${data.page === null ? '（--all）' : `；第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))} 页，每页 ${data.pageSize} 项`}。`,
    data.hasMore ? `下一页：agentforge ${group} list --page ${data.page + 1}（若使用了 --search，请保留相同条件）。` : '当前页没有下一页；可用 --page 1 返回首页，或 --all 显式读取全部匹配项。',
    `完整详情：agentforge ${group} get ID；搜索：agentforge ${group} list --search TEXT；字段说明：agentforge help ${group}。`,
    group === 'tasks' ? '进度：agentforge tasks progress 任务ID；协作：agentforge tasks collaboration 任务ID。任务完成以人类确认为准。' : '这里只显示配置摘要；存在配置不代表 Runtime/扩展已执行或任务已完成。'
  ].join('\n\n');
}
export function formatOutput(args, data, { columns = 100, help: isHelp = false } = {}) {
  columns = Math.max(40, Math.min(160, columns || 100));
  if (!args.length || ['help', 'schema'].includes(args[0]) || isHelp) return help(data, columns, { schema: args[0] === 'schema' });
  const [group, operation] = args;
  if (operation === 'list') return list(group, data, columns);
  if (group === 'tasks') {
    const title = { get: '任务详情', create: '任务已创建（尚未启动）', start: '任务执行已启动', terminate: '任务执行已终止（记录保留）', delete: '任务已删除', progress: '任务进度', collaboration: '协作记录（最新在前）', questions: '待答人类澄清', message: '协作指令已提交', reply: '澄清回答已提交', artifacts: '已接纳交付信息' }[operation];
    const task = operation === 'get' ? data : data.task;
    const taskId = task?.id || data.taskId || data.run?.taskId || args[2];
    const commands = operation === 'delete' ? ['任务列表：agentforge tasks list'] : [
      ...(operation === 'create' ? [`任务详情：agentforge tasks get ${taskId}`, `启动任务：agentforge tasks start ${taskId}`] : []),
      ...(operation === 'get' ? [['team', 'teams'], ['workflow', 'workflows'], ['manager', 'agents']].filter(([key]) => task[key]?.id).map(([key, group]) => `${labels[key]}配置：agentforge ${group} get ${task[key].id}`) : []),
      `执行进度：agentforge tasks progress ${taskId}`,
      `协作记录：agentforge tasks collaboration ${taskId}`,
      ...(operation === 'progress' ? [`澄清正文：agentforge tasks questions ${taskId}${data.runId ? ` --run ${data.runId}` : ''}`, `交付信息：agentforge tasks artifacts ${taskId}${data.runId ? ` --run ${data.runId}` : ''}`] : [])
    ];
    return [title, details(data, columns), section('按需查看', commands.map(command => '  ' + text(command)).join('\n'))].join('\n\n');
  }
  const title = group === 'auth' ? { login: 'CLI 登录成功', status: 'CLI 会话有效', logout: 'CLI 已退出登录' }[operation]
    : { get: `${groups[group]}详情`, create: `已创建${groups[group]}配置`, update: `已更新${groups[group]}配置`, delete: `已删除${groups[group]}配置`, import: '插件安装结果', test: 'Runtime 连接测试通过', models: 'Provider 模型目录' }[operation];
  const next = group === 'auth' ? operation === 'logout' ? '仅撤销本 CLI 会话，不退出客户端、不停止任务。' : 'CLI 会话与浏览器独立；会话文件相当于本机管理员访问权限，切勿分享。下一步：agentforge runtimes list。'
    : `下一步：agentforge ${group} list / get ID 回读；详细行为见 agentforge help ${group}。配置操作不代表 Task 已完成；连接与工具可用性须另外验证。`;
  return [title, details(data, columns), paragraph(next, columns)].join('\n\n');
}
export function formatError(error, exitCode, { columns = 100 } = {}) {
  return [`错误 [${text(error.code)}]：${text(error.message)}`, ...(error.status ? [`HTTP 状态：${error.status}`] : []), `处理建议：${text(error.hint)}`, `退出码：${exitCode}`, '查看参数：在命令后加 --help，例如 agentforge agents get --help；脚本需显式 --json。'].map(value => paragraph(value, columns)).join('\n');
}
