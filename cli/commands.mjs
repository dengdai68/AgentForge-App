const str = description => ({ type: 'string', description });
const strings = description => ({ type: 'array', items: { type: 'string' }, description });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const selection = object({
  pluginIds: strings('已安装插件版本 ID；完整插件中的 Skill 交给所选 Runtime 原生注册、按需激活，不把安装路径写入应用系统指令，不强制读取全部 Skill。先 plugins list/get 查看。'),
  mcpIds: strings('独立 MCP 版本 ID；从 mcps list 查询，可多个，必须兼容所选 Runtime。仅加载员工所选服务和平台历史工具，不继承全局 MCP 或 Codex Apps；Runtime 基础文件/Shell 工具仍可用。')
}, ['pluginIds', 'mcpIds']);
const runtime = object({
  profileId: str('具名 Runtime 配置 ID，先 runtimes list。新建省略时选择现有Claude默认连接，没有连接须先在设置创建；员工不拥有连接参数。'),
  extensionSelection: selection
});
const agent = object({
  name: str('员工名称，必填；get/update 使用精确 ID，不用名称作标识。'),
  kind: { type: 'string', enum: ['business', 'manager', 'developer'], description: '默认 business；manager 可被团队选择为经理；developer 必须绑定 repository。' },
  description: str('能力简介，项目经理据此判断谁适合承担工作。'),
  systemPrompt: str('员工长期执行与协作规则，通过 Runtime 应用系统指令传递；工作流仅经理持有。不是权限来源，不覆盖当前入口或授予额外操作权限。'),
  roleId: { type: ['string', 'null'], description: '可选：roles list 返回的角色 ID，最多绑定一个；该角色的共用提示词并入此员工沟通与任务执行的应用系统/developer 指令，与员工自身提示词共存。create 省略或 null 为不绑定；update 省略保持不变，显式 null 解除绑定。' },
  capabilities: strings('能力标签，如中文编辑、事实核查、Node.js；用于人员选择说明。'),
  status: { type: 'string', enum: ['active', 'inactive'], description: '创建和编辑均支持可用/停用，默认 active；不改冻结历史。' },
  repository: object({ url: str('developer 必填，无凭据 Git URL；读取凭据在设置管理，不授权 push。'), ref: str('可选分支/tag/commit；留空使用仓库默认。') }, ['url']),
  runtime
}, ['name']);
const team = object({
  name: str('团队名称，必填。'), mission: str('团队目标/协作说明。'),
  memberAgentIds: strings('至少一位 active 的 business/developer 员工 ID；不要放人类或多个经理。人类由系统添加。'),
  managerAgentId: str('一位 active、kind=manager 的员工 ID；推荐明确选择。没有可用经理时先创建经理员工。'),
  status: { type: 'string', enum: ['active', 'inactive'], description: '仅 update 支持停用/启用；历史任务不变。' }
}, ['name', 'memberAgentIds']);
const node = object({
  id: { ...str('当前工作流内唯一的小写字母开头 ID，字母/数字/下划线。'), pattern: '^[a-z][a-z0-9_]*$' },
  title: str('节点展示名称。'), staffingGuidance: str('必填自然语言人员需求：技能、输入、约束；项目经理按此选择成员，不绑定固定角色。'),
  dependsOn: strings('本工作流前置节点 ID；不能引用自己/不存在节点或形成环。'),
  handoffFrom: strings('需读取交接的节点 ID；不是硬编码成员指派。'),
  deliverable: str('明确交付定义、验收方式和失败如何反馈；模型摘要不能代替实际文件。'),
  artifactPaths: {type:'array',items:{type:'string',pattern:/^(?!\/)(?!.*\\)(?!.*\/\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*(?:^|\/)(?:\.git|\.agentforge|\.agentforge-workspace\.json)(?:\/|$))[^\0]+$/.source},description:'建议交付位置：工作目录内的规范相对文件或目录路径，如 artifacts/video/、reports/ 或 summary.md；缺省为空，由职责交付要求决定。不限定 docs，不是文件操作或接纳白名单，不能包含 .git/.agentforge 内部目录。'}
}, ['id', 'title', 'staffingGuidance']);
const workflow = object({ name: str('唯一工作流名称。'), description: str('适用目标和边界。'), nodes: { type: 'array', minItems: 1, items: node, description: '完整职责图；update 也是完整定义替换，先 get 再编辑。' } }, ['name', 'nodes']);
const connection = object({
  name: { ...str('唯一配置名称，最多120字符。'), maxLength: 120 },
  provider: { type: 'string', enum: ['claude-code', 'codex'], description: '默认 claude-code；创建后不可更改。认证沿用本机 CLI。' },
  model: str('模型名；空字符串使用 CLI 默认。建议取自 runtimes models PROVIDER 的真实列表，也接受手工输入。'), executable: { type: ['string', 'null'], description: 'CLI 绝对路径或可执行名，不附参数；空值使用服务 PATH。' },
  profile: str('仅 Codex：本机 config.toml 的 profile 名称。'),
  effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], description: '思考等级；空字符串使用 CLI 默认。Claude Code 支持 low–max，Codex 另有 ultra；逐模型可用档位见 runtimes models PROVIDER，模型不支持的档位在调用时由 CLI 回退或拒绝。' }
}, ['name']);
const exampleAgent = { name: '内容编辑', kind: 'business', description: '中文知识文章编辑与结构化改写', systemPrompt: '只根据提供的事实和可核验材料交付；事实不足时向项目经理澄清。', roleId: null, capabilities: ['中文编辑', '事实核查'], runtime: { profileId: '<runtimes-list返回的ID>', extensionSelection: { pluginIds: [], mcpIds: [] } } };
const role = object({
  name: { ...str('角色名称，必填，最多 80 字符；不要求唯一，引用以 ID 为准。'), maxLength: 80 },
  prompt: str('共用系统提示词纯文本，必填；绑定员工的沟通与任务执行都会把它并入应用系统/developer 指令，与员工自身提示词共存，不进入每轮用户消息。')
}, ['name', 'prompt']);
const task = object({ title: str('任务名称。'), objective: str('完整用户目标、输入事实和约束。'), teamId: str('teams list 返回的可用团队 ID。'), workflowTemplateId: str('workflows list 返回的工作流 ID。'), acceptanceCriteria: { ...strings('可选的明确验收要求，最多20条；由人类核对真实产物。'), minItems: 1, maxItems: 20 }, priority: { type: 'string', enum: ['low', 'medium', 'high'], description: '可选优先级，默认 medium。' } }, ['title', 'objective', 'teamId', 'workflowTemplateId']);
const taskExample = { title: '整理内部知识简报', objective: '根据提供的材料生成简报，缺失事实先询问人类，交付真实文件并独立复核。', teamId: '<teams-list返回的ID>', workflowTemplateId: '<workflows-list返回的ID>', acceptanceCriteria: ['引用输入事实，未知事项明确标注'] };
const message = object({ content: str('本次协作内容，非空文本。'), recipientAgentId: str('必填：progress 返回的当前 Run 成员 ID；每条消息只发送给一位成员。') }, ['content', 'recipientAgentId']);
const reply = object({ content: str('对指定人类澄清问题的回答。'), replyToMessageId: str('questions 返回的未答人类问题 ID，精确指定，不猜名称。') }, ['content', 'replyToMessageId']);
export const resources = {
  tasks: { description: '创建和启动任务，查询进度、协作、待答澄清及交付；人类在界面最终确认。', path: '/api/tasks', key: 'tasks', operations: ['list', 'get', 'create', 'start', 'terminate', 'delete', 'progress', 'collaboration', 'questions', 'message', 'reply', 'artifacts'], schema: task, example: taskExample,
    disclosure: 'get 只展示任务自身字段及团队/工作流/经理的 ID、名称；相应配置用对应 get 命令查询。list 为摘要，create/start/message/reply 为回执，progress 只引用成员和待答问题；正文按需查 questions/collaboration/artifacts。文本与 JSON 使用同一投影，不返回内部冻结快照。',
    operationInputs: { message: { schema: message, example: { content: '补充资料：本次内容面向企业内部同事。', recipientAgentId: '<progress返回的成员ID>' } }, reply: { schema: reply, example: { replyToMessageId: '<questions返回的问题ID>', content: '采用中文，面向内部知识团队。' } } },
    notes: ['terminate TASK_ID --yes 终止指定任务的最新执行（可用 --run 选择同任务执行），保留历史；delete TASK_ID --yes 永久删除任务、运行记录和本地交付快照。活跃任务先 terminate，再 delete；删除不会代替终止。', 'create 只创建待启动任务，不调用模型；start ID 才启动真实执行，可能消耗已配置模型额度。', 'progress ID 读取权威状态、重心、成员、待答问题、风险和交付；无虚构百分比。失败投递展示类别、尝试次数、原因和下次重试时间；仅明确临时错误最多尝试三次；确定性或未知错误停止自动重试，原始错误脱敏保留，修复后在客户端人工恢复。', 'collaboration ID 最新在前，每页20项；questions ID 仅未答人类问题；artifacts ID 只列已接纳交付信息。', 'message ID 是普通指令，只入队；人类澄清未答时仍阻塞。', 'reply ID 必须精确指定未答人类问题，过期或跨执行问题拒绝；剩余问题未答仍阻塞。', 'progress 及协作读写默认最新 Run；--run 明确选择同任务历史 Run，并回显 runId。', '归档任务只读；最终完成须由人类在 客户端核对产物并确认。'] },
  runtimes: { description: '共享 Claude Code/Codex 连接；扩展仍属于员工，冻结工作不变。', path: '/api/settings/runtime-profiles', key: 'profiles', operations: ['list', 'get', 'create', 'update', 'delete', 'test', 'models'], schema: connection, example: { name: '内容团队 Claude', provider: 'claude-code', model: '', executable: '', profile: '', effort: '' }, notes: ['update 完整连接字段替换，先 get；Provider 不可变。', 'delete 无当前员工引用的连接，需要 --yes；默认名称不构成保护，不删除CLI凭据或改写冻结历史。', 'test ID --yes 会实际调用模型，最长约90秒且可能消耗额度，不是业务交付。', 'models PROVIDER [--executable PATH] 查询 Provider 当前可用模型与逐模型思考档位；来源真实——Codex 用本机 codex debug models 目录，Claude Code 无离线列表命令，用内置别名加 settings.json/环境变量中的模型配置（绝不读取凭据键）；加载失败或空列表如实返回，不编造。', 'model 建议取自 models 查询结果，也接受手工输入并原样回读；模型与 effort 是否被账号/模型实际接受，以 test 和真实调用为准。'] },
  agents: { description: '数字员工：连接、提示词、能力、仓库、角色绑定和插件/MCP选择。', path: '/api/agents', key: 'agents', operations: ['list', 'get', 'create', 'update', 'delete'], schema: agent, example: exampleAgent, notes: ['先 runtimes list、plugins list、mcps list 取得精确ID；需要绑定角色时先 roles list。', 'create/update 均可指定 active/inactive，默认 active；停用不改变冻结历史。', 'roleId 绑定至多一个角色：省略保持不变，显式 null 解除绑定；角色提示词与员工提示词共同进入应用系统/developer 指令，冻结任务保持创建时的角色文本。', 'update 合并提供的顶层字段及 runtime 顶层字段；显式 extensionSelection 完整替换，必须含 pluginIds/mcpIds。', '不再接受 skillIds、mcpJson 或手工路径；插件和 MCP 必须先安装再选择。', 'delete ID --yes 仅删除无真实引用的员工，不改变历史Task/Run。'] },
  roles: { description: '角色：一组数字员工可共用的纯文本系统提示词；不是员工类型、职责标签或权限规则。', path: '/api/roles', key: 'roles', operations: ['list', 'get', 'create', 'update', 'delete'], schema: role, example: { name: '事实核查员', prompt: '凡引用外部事实必须给出来源；无法核实时明确标注，不猜测。' }, notes: ['员工通过 roleId 绑定至多一个角色，也可不绑定；解绑用 agents update 显式 roleId: null。', '角色编辑只影响之后创建的任务与后续沟通投递；已创建 Task/Run 的冻结快照保持原提示词，历史仍可核验。', '角色变化不重建员工原生会话，下次调用生效；不承诺旧指令从原生历史中消除。', 'update ID --file role.json 为部分更新，至少提供 name 或 prompt 一项。', 'delete ID --yes 删除未被任何员工（含停用）绑定的角色；仍有绑定时服务拒绝并列出员工，须先解除绑定。'] },
  teams: { description: '团队人员池及唯一经理；自动包含本机人类，不是执行权限系统。', path: '/api/teams', key: 'teams', operations: ['list', 'get', 'create', 'update', 'delete'], schema: team, example: { name: '企业知识内容组', mission: '将可信内部资料整理为可核验内容', managerAgentId: '<kind=manager的员工ID>', memberAgentIds: ['<内容编辑员工ID>', '<独立审校员工ID>'] }, notes: ['至少一名可用业务成员和一位可用经理；新任务冻结当时成员。', 'update 未提交的字段保持原值；create 不接受 status。', 'delete ID --yes 删除未被使用的团队；存在真实引用时服务拒绝，不删除历史Task/Run或自动调整其他配置。'] },
  workflows: { description: '工作流自然语言职责图；不预绑定员工，项目经理负责按能力选人。', path: '/api/workflow-templates', key: 'workflowTemplates', operations: ['list', 'get', 'create', 'update', 'delete'], schema: workflow, example: { name: '知识简报与独立核查', description: '内容团队从材料到可核验简报', nodes: [{ id: 'write', title: '整理知识简报', staffingGuidance: '适合擅长中文内容编辑、区分事实与推断的成员', dependsOn: [], handoffFrom: [], artifactPaths: ['docs/brief/'], deliverable: '写 docs/brief/brief.md，逐条引用输入事实，列出无法确定事项。' }, { id: 'review', title: '独立事实核查', staffingGuidance: '选择非作者、能审查事实与表达的成员', dependsOn: ['write'], handoffFrom: ['write'], artifactPaths: ['docs/review/'], deliverable: '写 docs/review/review.md，记录逐项核验和需要返工之处。' }] }, notes: ['update 是完整替换，先 get 再编辑。', 'delete ID --yes 显式确认；存在真实引用时服务拒绝，不删除历史Task/Run。示例身份不构成保护。'] },
  plugins: { description: '插件市场：安装 Git 仓库或本地目录中的全部 Claude/Codex 插件。', path: '/api/runtime/marketplace', key: 'plugins', operations: ['list', 'get', 'import', 'delete', 'updates', 'check-updates', 'auto-update'], schema: object({ url: str('无凭据 HTTPS Git 插件或市场仓库地址，与 path 二选一；市场中的全部插件一起安装。'), path: str('本机插件或市场的绝对目录，与 url 二选一。') }), example: { url: 'https://github.com/obra/superpowers.git' }, operationInputs: { 'auto-update': {schema:{...object({enabled:{type:'boolean',description:'启用或关闭后续Git插件自动检查；已开始的检查仍完成。'},intervalMinutes:{type:'integer',minimum:1,maximum:1440,description:'检查周期，整数分钟1–1440，默认2；保存后重新计时。'}}),minProperties:1},example:{enabled:true,intervalMinutes:2}}, updates:{schema:object({}),example:{},inputMode:'无输入；查询检查状态与最近结果'}, 'check-updates':{schema:object({}),example:{},inputMode:'无输入；立即请求一次检查，不等待全部网络操作完成'} }, notes: ['updates 查询Git插件检查状态（默认2分钟，可配置）、最近更新和错误摘要；不触发网络操作。', 'check-updates 无需等待下一轮定时检查（默认2分钟），立即由本机服务检查Git来源，返回正在检查状态；随后使用 plugins updates 查询结果，不等待全部网络请求完成。', 'auto-update --file settings.json 设置 enabled 或 intervalMinutes，至少提供一项；默认2分钟，周期为1–1440整数分钟。关闭后已开始的检查仍完成，仍可立即检查。', '仅更新当前已安装Git插件；本地目录不自动重装，固定sha不追随HEAD。新版本统一更新当前员工，已启动任务及排队调用不变；不自动更新或启用插件自带MCP。失败保留当前版本并写日志。','来源目录内的文件/目录链接安装为普通文件；中文、空格等文件名保持原样。断链、循环、来源外链接及管道/套接字等特殊文件报具体位置并整批回滚。', 'import --file source.json 安装来源中的全部插件，任一失败则整批不安装；不执行安装脚本、不安装依赖。', '支持 Claude .claude-plugin、Codex .agents/plugins 市场及 .codex-plugin/根 plugin.json；本地相对来源及 HTTPS github/url/git-subdir 来源，保留 ref/sha，sha 优先。不支持 npm/archive/command 来源，遇到时整批报错。', '两套 Runtime 清单分别解析；list 返回支持的 Runtime，get ID 返回每种 Runtime 的兼容性及不兼容原因。支持表示静态组件可加载，不代表本机依赖和账号已实测。', '自带 MCP 单独进入 MCP 市场，员工必须另选；不会随插件自动加载。', 'list 为摘要，get ID 按需返回 Skill/Subagent/Hook 详情。手动安装不自动绑定员工；自动更新切换当前员工，不修改冻结任务；在线市场暂未开放。', 'delete ID --yes 从已安装列表移除；员工仍选用时拒绝，须先调整员工。保留历史任务所需文件，不删除独立 MCP。'] },
  mcps: { description: 'MCP 市场：安装、查询与编辑独立服务，员工可选择多个。', path: '/api/runtime/mcp-marketplace', key: 'entries', operations: ['list', 'get', 'create', 'update', 'delete'], schema: object({ name: str('名称，最多80字符。'), description: str('说明，最多500字符。'), content: str('JSON字符串：只含一个mcpServers服务。stdio、SSE、Streamable HTTP 两种 Runtime 均支持；HTTP 类型接受 http/streamableHttp/streamable-http。stdio 可选 cwd（绝对目录）、env_vars（环境变量名数组），含这些字段时仅支持 Codex，安装后标记 Runtime。') }, ['name', 'content']), operationInputs: { update: { schema: object({ name: str('可选新名称，最多80字符。'), description: str('可选新说明，最多500字符；空串清除。'), content: str('可选完整 MCP JSON 字符串；省略保留配置。get 中未改动的隐藏值在相同 JSON 位置保留原值；删除字段清除，修改服务名或凭据字段时填写真实新值。支持 stdio/SSE/HTTP，字段规则与 create 相同。') }), example: { description: '更新后的知识服务说明' }, inputMode: '部分更新；至少提供 name、description、content 中一项' } }, example: { name: '本机知识查询', description: '可信本机工具服务', content: '{"mcpServers":{"knowledge":{"command":"node","args":["/absolute/server.mjs"]}}}' }, notes: ['create --file mcp.json 安装独立服务；不安装依赖、不自动绑定员工。', 'update ID --file patch.json 保存为新版本，原子更新当前员工选择；返回新 id、previousId 和员工 ID/名称。之后使用新 ID 查询。已启动任务、排队调用和历史私有文件不变；不兼容或员工并发变化时拒绝，旧配置不变。', 'list只返回摘要；get ID按需返回JSON详情，鉴权值隐藏。原值仅保存在私有文件供Runtime使用。', '员工只选mcpIds，不再填写独立mcpJson。编辑不会读取或改写全局CLI配置。', 'delete ID --yes 从已安装列表移除；员工仍选用时拒绝，须先调整员工。保留历史任务所需私有文件。'] }
};

export const guide = {
  title: 'AgentForge — AI 团队操作系统', version: 5,
  product: {
    summary: 'AgentForge 是一个 AI 团队操作系统：让负责人组织具备不同能力的数字员工，协作完成代码开发、企业知识整理、调研和内容生产，并拿到可核验的交付物，而不只是聊天回复。',
    workflow: '用户提出目标 → 选择团队与工作流 → 项目经理按节点人员需求选择成员 → Agent 执行、交接、独立复核或返工 → 保存真实 Artifact 与执行证据 → 人类最终确认完成。',
    concepts: [
      ['Agent / 数字员工', '有职责、能力和执行提示词的成员；选择共享 Runtime，并独立选择完整插件和一个或多个 MCP。'],
      ['Team / 团队', '至少一位活跃业务成员、一位项目经理和本机人类组成的协作人员池。'],
      ['Workflow / 工作流', '用节点、依赖、自然语言人员需求、交接和交付要求描述如何协作，不按角色名称强制绑人。'],
      ['Task / 任务', '用户目标、验收标准和团队/工作流的冻结配置；模型不能自行将任务标记为已完成。'],
      ['Run / 执行', '某次任务推进的状态、调度、成员会话和协作记录；失败/中断须按产品规则恢复。'],
      ['Trace / 调用记录', '一次真实 Runtime 调用的证据关联，不等于整个任务或成员会话。'],
      ['Artifact / 交付物', '从实际文件接纳并带来源/校验信息的交付快照；文件被接纳仍不等于人类已验收。']
    ],
    interfaces: 'CLI 配置员工、团队、工作流与扩展，创建/启动任务、查询执行和协作并回复澄清；Web 与 Mac 客户端提供工作目录、控制台和人类最终验收。',
    maturity: '当前为本机单管理员 MVP/Beta：SQLite 保存元数据，交付与 Trace 是本地文件，Claude Code 为默认 Runtime，显式配置后也支持 Codex CLI。不是多租户、生产沙箱、高可用或远程队列；bypass 不等于沙箱。'
  },
  sourceEntry: 'node cli/main.mjs ... 或 npm --silent run cli -- ...；普通 npm run 会打印脚本标题，AI解析JSON时使用静默入口。',
  purpose: '供人类和受信任 AI 配置团队并操作任务；先读分组 help/schema，用返回 ID 写入并重新读取验证。配置成功不等于模型、Skill/MCP 已执行或任务已完成。',
  transport: 'CLI 专属于客户端；源码和安装版均通过私有连接文件发现运行中的客户端，校验实例 ID 后才发送凭据。不连接 Web、不自动启动或切换服务；help/schema 离线可用。',
  sequence: ['help / schema', '操作者 auth login --username 用户名（终端隐藏输入密码）；脚本显式 --password-stdin', 'runtimes list', 'runtimes models claude-code|codex（查询真实可用模型与思考档位）', 'plugins import --file source.json；plugins get PLUGIN_ID', 'mcps create --file mcp.json', 'roles create/update --file role.json（可选：共用提示词角色，供员工 roleId 绑定）', 'agents create/update --file employee.json', 'teams create/update --file team.json', 'workflows create/update --file workflow.json', '分别 get ID 回读核验；需要时经用户授权 runtimes test ID --yes'],
  syntax: 'agentforge [--json] <group> <operation> [ID] [--file path|-] [--yes] [--page 1|--all] [--search text] [--session-file /absolute/path]',
  help: ['help', 'agents', 'agents create --help', 'schema --json', 'schema workflows'],
  auth: { login: 'auth login --username 用户名：回车后提示输入密码，隐藏输入；Ctrl+C/EOF 取消。脚本/AI通过显式 --password-stdin 管道输入；不接受 --password，不读取浏览器会话，复用目标实例的管理员认证。', status: 'auth status：验证本CLI会话；不输出cookie。', logout: 'auth logout：撤销本CLI会话，不停止任务/退出其他客户端。', storage: '默认 ~/.agentforge/cli-session.json；0600/目录0700，新登录会话默认不过期，主动退出或撤销后失效；可用--session-file隔离。切勿把会话交给不可信Agent。' },
  input: 'create/update/import/message/reply 仅用--file JSON文件或--file - stdin对象；最多1MiB；不接受内联秘密。list默认每页20项，--all显式全部，--search仅过滤名称/说明。',
  readBeforeWrite: 'get含只读id/system/color/createdAt/employeeCount等元信息，不要原样回写整个读模型；按schema.properties构造输入。员工runtime只返回profileId/extensionSelection，不回写派生执行路径或manifest。',
  flags: [
    ['--help', '查看根、分组或当前命令的详细说明；不需要服务或登录。'],
    ['--json', '显式机器输出；成功/失败均在 stdout 写单个 JSON envelope；交互密码提示仅写 stderr。可放在命令前后，管道不会自动启用。'],
    ['--file PATH | -', 'create/update/import 的 JSON 对象文件；- 表示从 stdin 读取，最多 1MiB。帮助中的模板需替换占位 ID；不要提交含凭据的文件。'],
    ['--yes', 'delete/test 的明确确认；不会自动获得外部操作权限。Runtime 测试真实调用模型且可能消耗额度。'],
    ['--page N | --all', '仅 list：默认每页 20 项，N 为正整数；--all 返回所有匹配项，不可与 --page 混用。'],
    ['--search TEXT', '仅 list：按名称/说明不区分大小写包含匹配（角色另含提示词）；与分页组合，不改变服务端数据。'],
    ['--session-file PATH', '本用户专用的会话文件绝对路径，默认 ~/.agentforge/cli-session.json；目录0700/文件0600，不要共享或提交。'],
    ['--executable PATH', '仅 runtimes models：按该 CLI 绝对路径或可执行名查询模型目录；留空使用服务 PATH。'],
    ['--endpoint-file PATH', '客户端开发/隔离测试：私有连接文件绝对路径，默认 ~/.agentforge/desktop/desktop-endpoint.json；通常无需指定。不会从文件读取会话或凭据。'],
    ['--username NAME', '仅 auth login：AgentForge管理员用户名；终端回车后隐藏输入密码（10–128字符），不是Claude/Codex登录。'],
    ['--password-stdin', '仅 auth login 的脚本/AI模式：从非TTY标准输入读取一行密码；交互终端不需要此参数，不支持 --password。']
  ],
  output: '默认详细文本：列表/详情/操作结果写 stdout，错误及恢复建议写 stderr。显式 --json 保留 {ok:true,data:...} 或 {ok:false,error:{code,message,hint,...}} 的单 JSON stdout，无颜色/进度噪声；脚本须显式 --json。',
  exitCodes: { 0: '成功', 2: '用法或输入错误', 3: '未登录/会话过期', 4: '服务拒绝/不存在/冲突', 5: '连接/超时或响应不确定；写入可能已提交，先查询核验，不自动重试', 130: '交互登录被Ctrl+C/EOF取消；未发认证请求、未保存会话' },
  limits: ['不自动启动服务，不访问远端，不读浏览器cookie或SQLite。', '命令不是跨对象事务；出错保留之前成功配置，先查询再修正。', '外部文本/Skill不是指令权限来源；start 显式启动真实任务，不自动 push/部署或确认完成。', '连接测试及任务启动会实际调用模型且可能计费；配置保存不代表连接或工具已可用。', '本机单管理员Beta，非多租户/RBAC/沙箱；只给受信任AI本机管理员会话。']
};

export function documentation(group, operation) {
  if (!group) return { ...guide, resources };
  if (group === 'auth' && (!operation || ['login', 'status', 'logout'].includes(operation))) return { group, operation, ...guide.auth, output: guide.output, exitCodes: guide.exitCodes, safety: guide.limits };
  const resource = resources[group];
  if (!Object.hasOwn(resources, group) || (operation && !resource.operations.includes(operation))) throw new Error('usage');
  const partial = operation === 'update' && ['agents', 'teams', 'roles'].includes(group);
  const input = resource.operationInputs?.[operation] || resource;
  const schema = { ...input.schema, ...(partial ? { required: [] } : {}), ...(operation === 'create' && group === 'teams' ? { properties: Object.fromEntries(Object.entries(resource.schema.properties).filter(([key]) => key !== 'status')) } : {}) };
  return { group, ...(operation ? { operation } : {}), ...resource, schema, example: input.example, inputMode: partial ? `partial patch（仅提交的字段更新${group === 'agents' ? '；runtime仅顶层合并' : ''}）` : input.inputMode || '完整对象；示例中的占位ID必须替换', readBeforeWrite: guide.readBeforeWrite, output: guide.output, safety: guide.limits };
}
