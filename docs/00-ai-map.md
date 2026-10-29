# 代码导航

独立客户端入口：npm start/dev → apps/electron/main.mjs → 自有 server/index.mjs → web/ 与 client/。全部相对依赖、CLI、Runtime、测试在本仓库；抽取来源、保留边界与发布身份见 docs/23-desktop-extraction.md。服务只由客户端 IPC 启动，直接运行拒绝；无独立 Web 部署。renderer 始终用客户端样式，所有 UI 验收只操作 Electron。

普通沟通：communication.mjs 的回复 schema 把可空的 handoffToAgentId 与 reply 同列 required（严格 Provider 要求 required 覆盖全部键），null/省略均表示不转交；Store 仍校验真实候选及单次转交，测试覆盖省略/null/非法字段和目标，任务协议独立不变。经理决定被在途投递顺延时，orchestrator 记录说明并向经理入队复核投递，不再静默丢弃；Run 进入验收或确认完成时，Store 取消未执行的平台协调跟进投递并记录审计，归档不再被残留复核投递阻塞。

工作目录：run-files 不再读写 .agentforge-workspace.json 或限定 docs；目录按 path/offset 分页读取，界面按需展开、继续加载和同层重试。CHANGE 将所有业务路径按真实层级合并，工作根与绑定子仓库比较任务初始提交。Workflow artifactPaths 仅为规范相对交付位置，可为空；Store/CLI/提示词同步，不再改写到 docs。执行快照覆盖全部业务路径但保留大小/敏感文件限制，历史冻结文件不迁移。

插件更新：plugin-updates.mjs 以两分钟单飞检查 Git 来源及外部依赖提交；configuration 提供 ls-remote 和可清理的临时检出，marketplace 只安装已装名称的新快照且不拆装 MCP，Store 事务更新当前员工。状态/开关/分钟周期经认证 HTTP、设置 → 插件更新和 CLI plugins updates/check-updates/auto-update 共用。沟通无选择时打开最后更新会话，任务控制台首次无选择时打开最近执行者；显式选择不被刷新切走。

MCP 编辑：marketplace.mjs 复用安装校验并保留未改动脱敏值；HTTP 准备新版本与员工绑定，Store 事务更新当前员工、退役旧版本，冻结任务/排队投递不改。界面详情编辑与 CLI mcps update 同协议；团队空态仅保留创建团队引导。

原生 Skill：local-cli 保留 Claude --plugin-dir 但不禁用 Skill；所选 Codex Skill 走调用独占 codex-app-server.mjs，额外根注册、目录核对、线程级启用、精确续接，复用控制台投影。无 Skill 保留 exec，不作失败回退。prompts 不生成技能路径指引；history/mcp 的服务说明和 schema 拥有目录/分页。test-prompt-e2e 的 NATIVE_SKILLS_REAL 模式真实验证；CLI 字段不变、帮助同步。

CLI 连接集中在 cli/client.mjs 的私有 endpoint 发现与实例校验，无目标环境分支；客户端始终提供 CLI 分类。server/data-home.mjs 统一默认任务根 ~/agentforge，Electron 只复用纯路径函数；Store 随机 Task UUID 防止共享根碰撞，历史路径不变。真实 CLI 开发 E2E 启动独立 Electron 随机端口，不伪装 Web endpoint。

规则入口：[AGENTS.md](../AGENTS.md)。机器可读模块及联动文件见 `ai/module-registry.json`。

| 目录/入口 | 职责 | 文档 |
| --- | --- | --- |
| `server/index.mjs` | HTTP、认证路由、静态资源和 SSE | [架构](02-system-architecture.md) |
| `server/store.mjs` | 领域命令、持久状态、任务读模型 | [领域](03-domain-model.md) |
| `server/orchestrator.mjs` | 派工、会话续接、协作和进程执行 | [Runtime](08-real-local-agent-runtime.md) |
| `server/runtime/` | Claude Code/Codex、模型目录、Skill/MCP | [配置](15-employee-runtime-configuration.md) |
| `server/run-files.mjs` | 执行内容、提示词和交付快照 | [文件](13-local-artifact-rendering.md) |
| `server/workspace-git.mjs` | 工作区 Git 状态和 Diff | [文件](13-local-artifact-rendering.md) |
| `server/history/` | 员工历史查询和索引 | [历史](19-agent-history.md) |
| `server/communication*.mjs` | 长期会话与消息投递 | [沟通](17-communication.md) |
| `server/auth.mjs` | 管理员、会话、Origin 与登录限流 | [认证](14-console-authentication.md) |
| `client/console-projections.mjs` | 无副作用的共享展示投影 | [client](../client/README.md) |
| `web/app.js` | 任务、员工、团队、工作流与文件界面 | [web](../web/README.md) |
| `web/settings.mjs` | 外观、Runtime、仓库和 CLI 设置 | [配置](15-employee-runtime-configuration.md) |
| `apps/electron/` | 桌面窗口、自有后台和受限宿主接口 | [桌面](18-electron-client.md) |
| `cli/` | 认证 HTTP 命令、帮助与输出 | [CLI](21-configuration-cli.md) |
| `tests/`、`scripts/` | 隔离测试、构建及工程检查 | [测试](../tests/README.md) |

## 修改入口

- 失败与续接：runtime/local-cli 保留脱敏原始错误并独立判定临时故障；marketplace 提供完整性失败位置，cli-environment 禁止默认 Python 字节码写入。orchestrator 限制三次尝试，Store 停止不可重试投递；prompts 按内容摘要追加变化，模型实际活动确认输入游标。HTTP 巡检只继续已有到期队列，CLI 进度/帮助同步失败恢复语义。

- 任务目录标题由顶栏展示，index.html/styles.css 将内部任务/归档 h2 保留为无占位的可访问语义；app.js 更新归档顶栏名称。目录实机回归验证宽窄 客户端及往返搜索。Release 工作流发布成功后按构建输出的精确 artifact ID 清理 Actions 中转包，失败最多保留一天，不删除发布附件/标签。

- 真实模型验收的窄窗口截图等待 renderer 尺寸到位再保存，避免原生窗口异步调整让证据仍是宽屏；不改变产品代码或业务协议。

- 历史与后续答疑：local-cli.mjs 为 Codex 的平台历史 MCP 完整传递 Bridge 自有环境（打包版 Electron Node 标记）并设为 required，不改变 Provider 自身环境。app.js 协作流只渲染真实消息，移除固定验收副本和停止答疑按钮；styles.css 缩小人类气泡。安装包协议测试与 test-prompt-e2e 的 PACKAGED 模式覆盖真实历史调用和完成后答疑；CLI/状态机/历史可见性不变。

- 应用标志：web/icons/application.png 保留用户提供的蓝紫 A 原图字节；scripts/build-app-icon.cjs 只用 sips/iconutil 生成 ICNS 尺寸。侧栏/Dock/安装包同源，托盘用原图 alpha 轮廓；无浏览器、新依赖或业务权限，移除过时三柱 SVG。

- 紧凑工作台：团队/工作流在 app.js 搜索后分页，任务归档/新建在搜索行；共享/compact 样式上移目录操作。tracePromptMarkup 展示完整脱敏提示词及已确认原生会话 ID；工具仅按 Trace/原生调用 ID 归并重复阶段，单次调用内重复输入只显示一次，不同调用即使参数相同也保留各自输入输出，无 ID 不猜测。人类协作元信息与正文气泡分离；侧栏/安装包同源图标。CLI 字段不变，扩展隔离帮助同步。

- 控制台降噪：client/console-projections.mjs 的 isRoutineConsoleEvent 在分组前过滤无内容的常规通知，统一识别任务 Provider 类型前缀与沟通无前缀事件，任务与沟通共用；原始分页窗口、审计、日志及 CLI 不变。内容引用、工具、异常与未知消息不隐藏。

- 指令分层：server/prompts.mjs 组装系统指令/当前输入；工作流仅经理、执行环境进系统层。Store 消息游标只投递新消息，原生会话拥有历史；Bridge 准备工具指引和快照，Runtime 使用 Claude 系统追加文件/Codex developer_instructions。真实验收见 scripts/test-prompt-e2e.mjs，CLI 参数不变。

- 目录顶部一致性：index.html 为团队/工作流采用同行搜索/创建工具栏，styles.css 统一紧凑高度；compact.css 移除团队/工作流列表顶边框。scripts/test-directory-headers.mjs 以隔离数据操作六页、宽窄 客户端、跨页搜索及创建弹框；CLI/HTTP/执行协议不变。

- 沟通控制台工具栏仅保留最新/刷新；`communication.js` 隐藏唯一成员的重复标签，把群聊成员选择与更早记录入口置于工具栏外。`styles.css` 负责间距，运行/HTTP/CLI 契约不变；UI 验收覆盖单聊、群聊切换和宽窄布局。

- 沟通工作台：communication-store 拥有附件引用与每次投递/尝试的会话事实；Run Files 管理原文件和私有正文，HTTP 暴露同源上传、校验下载、成员分页控制台。communication.js 管理半屏布局/草稿/未读，app.js 注入与任务空间同一个 renderer/hydrator。详情见 docs/17；CLI 未覆盖长期沟通，本轮无 CLI 命令/字段变化。市场头像复用员工 palette。

- 员工扩展选择器的开/关及焦点归还集中在 `web/marketplace.mjs`；鼠标移出、表单外部点击与键盘焦点离开关闭列表，事件仅绑定当前表单，不扩展 HTTP/CLI 或 Runtime 协议。源码与安装包 UI 回归覆盖插件/MCP 各自的鼠标、键盘及保存回读。

- 插件来源链接在 `marketplace.mjs` 的安装复制阶段按 `configuration.mjs` 提供的 sourceRoot 展开，执行期仍拒绝链接；CLI 操作帮助同步边界。详情统一滚动区与稳定卡片布局在 `styles.css`，滚轮/键盘、跨行对齐和真实链接 Skill 加载分别由 Electron/插件 E2E 覆盖。

- 协调流程：Store → Orchestrator → Runtime；平台只执行协调决定，不评价业务结果。
- 角色：Store 拥有 roles 集合与员工 `roleId` 绑定校验/删除拒绝；Task 创建把角色文本冻结为员工快照的 `roleSnapshot`，沟通投递快照在发送/重试时嵌入；`prompts.mjs` 把快照中的角色提示词并入应用系统指令（任务与沟通共用，Claude `--append-system-prompt-file` / Codex `developer_instructions` 通道不变），Runtime 无角色状态。界面 BUILD 组有独立角色目录；CLI 为 `roles` 组与 `agents` 的 `roleId`。
- 配置能力：HTTP/Store、界面与 CLI 一起核对；当前输入协议见员工配置和 CLI 文档。员工/插件/MCP 目录共用同行搜索工具栏与卡片；插件/MCP 删除经 Store 记录 extensionRemovals 并拒绝当前员工引用，文件保留供冻结任务使用。
- 插件/MCP：`web/marketplace.mjs` → 认证目录/详情与来源整批 import → Runtime 不可变插件版本及拆分 MCP；员工只选 pluginIds/mcpIds，创建/编辑均可设置 active/inactive。`mcp-launcher.mjs` 通过现有 SDK 桥接 SSE/Streamable HTTP；`plugin-hooks.mjs` 为 Codex 执行完整性校验的选定命令 Hook，Subagent 配置投影到 Trace。Electron 数据仍由 runtime-paths 指向 ~/.agentforge。
- 市场整批导入解析 Claude/Codex 本地及 HTTPS Git 条目，ref/sha 记录实际来源；配置根先归一祖先别名。清单/Hook/Skill 分 Runtime 投影，目录/CLI 展示静态兼容性与原因，员工绑定拒绝不兼容。Codex MCP cwd 在私有启动器生效，npm/archive/command 来源仍明确拒绝，详见 docs/15。
- 展示：优先共享投影和现有样式，桌面差异放入 `compact.css`；工具命令/文件摘要解析在共享投影，可见行加载与 Read/Write 正文展示在 `web/app.js`。
- 消息方向由 renderer 的真实 sender 判断：人类右、员工左，不改变协作投影/CLI。市场整行空/错误状态在 `marketplace.mjs` 的网格外；工作根设置在 HTTP 校验并创建目录后交 Store 保存，见 docs/02、06。
- 工作目录：当前文件与 CHANGE 共用 `workingFileTree`；不再提供交付版本页面，历史文件仍由 Run Files/API/CLI 管理。提示词组装、澄清与新指令的代码路径见 [提示词组装](22-prompt-assembly.md)。
- 文件下载：`web/app.js` 的下载命令 → 认证 `content?download=1` → Run Files 的共享路径校验和流式读取；根目录间距使用 界面中两个文件面板共享的样式。现有 CLI 查询 Artifact 历史，不包含当前文件下载命令，本轮不扩展 CLI 权限或协议。
- 新增模块：先更新注册表；契约变化同步 source of truth、测试和变更记录。
- CHANGE 空态由 `renderWorkingChanges` 统一呈现，目录下不重复显示无更改；保留读取错误与 Git 未初始化提示，CLI/API 不受影响。

发布检查：`scripts/test-packaged-electron.mjs` 验证控制台默认选择最近执行者，再显式切换员工读取历史；无选择时不再期待旧的空白提示，仍触发真实按需加载。

记录可读性：`renderChatStream` 按 Trace 时间合并提示词/事件并尊重分页窗口；`collaborationRecords` 提供视觉状态投影，沟通按稳定发送者配色，共享 tokens 在 renderer、紧凑覆盖在宿主；CLI 排除视觉元数据。

源码 UI 验收先等待员工首页加载完成再遍历旧页，不把先行渲染的提示词元数据误认为历史已加载；按记录 ID 定位需要滚动读取的正文。
