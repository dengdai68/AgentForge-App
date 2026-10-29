# 数字员工与扩展配置

设置 → 插件更新提供自动更新开关、检查周期（整数分钟，1–1440，默认2分钟）、立即检查和最近结果；插件市场仅管理安装项。只更新已安装 Git 来源插件；本地目录不自动轮询，固定 sha 不追随 HEAD。以来源及依赖 Git 提交判断变化，版本号不变仍可更新。仅安装仍在当前列表中的名称，已删除项不重装；来源移除某已装插件、读取失败、格式/完整性/Runtime兼容或并发绑定冲突时保留该来源当前版本并记录诊断。其他来源仍检查。MCP 不随自动插件更新拆装或改变选择；Task/Run/排队投递不改写。服务运行时有效，退出后不运行，重启后重新计时；开关与周期持久化，最近结果不伪装为跨重启历史。GET/POST /api/runtime/marketplace/updates 查询/请求检查（POST返回202，之后查询结果）；PUT .../updates/settings 接受非空部分对象 {enabled?:boolean,intervalMinutes?:integer}，拒绝未知字段。上轮结束后按已保存周期再计时；保存设置重新计时，关闭不取消已开始检查，关闭时仍可立即检查。设置草稿不被状态刷新覆盖。

MCP 详情提供编辑名称、说明及 JSON；保存生成新版本并原子更新当前员工的 mcpIds，列表只保留新的当前版本，已启动任务和排队调用保持旧快照。PUT /api/runtime/mcp-marketplace/:id 接受非空部分对象 {name?,description?,content?}；content 是完整单服务 JSON 字符串，省略保留配置。GET 中未改动的脱敏值在相同 JSON 位置保留，删除字段清除，重命名服务或鉴权字段须填写真实新值。失败保留旧绑定；新候选退役且文件不作历史改写。返回新 id、previousId、employees（仅 ID/名称）、historyRetained。旧 ID 再编辑返回404；不兼容时整次拒绝。

未填写扩展选择等同于空选择，不继承用户/项目的全局 MCP 和插件。Codex 每次调用显式关闭账号 Apps（`features.apps=false`）；Claude 使用 strict-mcp-config 与空 setting-sources，并仅沿用模型连接环境。所选 MCP 与平台历史服务仍加载，Runtime 基础文件、Shell、原生搜索工具不在此扩展清单中；这不是 OS 沙箱。员工资料/插件/MCP 编辑不重建原生沟通记忆，下一轮应用新配置。参见 [Codex 官方配置](https://developers.openai.com/codex/config-reference/) 与 [Claude CLI](https://code.claude.com/docs/en/cli-reference)。

## 已安装项管理

员工插件/MCP 的搜索下拉在鼠标移出选择区、点击表单其他区域、Tab 离开或 Escape 时收起，不再遮住后续字段；点击已聚焦输入可重开。鼠标选择、方向键/Enter、多选和移除仍保留，收起不改已选 ID。仅共享 renderer 交互调整，HTTP/CLI 输入输出、兼容性校验和 Runtime 加载不变。

卡片的名称区、三行简介、Runtime 信息和操作区保持稳定位置；长内容在卡片省略，插件/MCP 详情及员工编辑保留完整信息。插件详情采用一个有界正文滚动区，概览和组件随正文滚动，标签页吸顶，标题及删除/关闭按钮固定可见；多 Skill、长简介和窄窗口均不裁掉末尾组件。

员工、插件和 MCP 页面均提供同行搜索与创建/安装操作；按名称和说明不区分大小写过滤，再按每页 20 项分页，输入变化回到第一页。员工也匹配能力标签。插件/MCP 复用员工卡片样式，详情底部「删除」使用应用确认框。CLI 对应 `plugins delete ID --yes` / `mcps delete ID --yes`。

删除前须在所有当前员工中移除该版本选择（停用员工也计入），否则返回引用员工名称。成功后从已安装目录和选择器移除，详情返回 404，禁止新绑定；独立 MCP 不随插件删除。历史任务/执行的冻结引用和不可变文件保留，删除不是清理历史文件或撤销正在运行的历史执行。

## 当前迭代契约：仓库整批安装与跨 Runtime 加载

安装入口仅输入 HTTPS Git 地址或本机目录，直接安装来源中全部插件，不再提供信任勾选、候选读取或单插件选择。识别 Claude `.claude-plugin`、Codex `.codex-plugin`/`.agents/plugins` 和 Agent Plugins 根 manifest；组件标准化后按 Runtime 生成加载投影，不改全局 CLI 配置。可共用 Skill；Subagent/Hook 使用本机 Provider 的真实能力，不能映射的事件明确报告兼容性，不用提示词冒充已执行。

来源作为一次原子安装发布，失败时不暴露部分已安装版本。插件自带 MCP 拆为独立市场版本，仍须员工单独选择，不随插件加载。MCP 接受 stdio、sse、streamableHttp（及标准 http/streamable-http 拼写），复用已有 MCP SDK 的客户端传输，在私有 stdio 启动器中桥接，供两种 Runtime 统一加载；不自动配置 OAuth 或安装依赖。

员工新建和编辑均支持 active/inactive；插件与 MCP 搜索器分行排列。员工、插件和 MCP 改为响应式卡片，不改变既有信息或分页语义。插件详情顶部概要，下方 Skill/Subagent/Hook 标签页切换列表。旧的单插件安装/读取来源协议废弃，CLI 同轮同步；开发阶段不转换旧安装版本、不改冻结历史或真实实例。

## 当前唯一写入协议

员工只引用共享 Runtime，并独立选择完整插件及 MCP：

```json
{"runtime":{"profileId":"<Runtime ID>","extensionSelection":{"pluginIds":[],"mcpIds":[]}}}
```

HTTP/CLI 拒绝 `skillIds`、员工 `mcpJson`、连接字段、手工路径及派生 manifest。省略 runtime 或更新字段时保留现有绑定；显式 extensionSelection 必须包含两个数组并完整替换。新员工默认使用现有 Claude 连接，无连接时先在设置创建；不隐式新建连接。

安装、列表、员工选择均以插件版本为单位；Skill/Subagent/Hook 只在插件详情中查看，不可单选。插件自带 MCP 会拆为独立市场项，选插件不会隐式启用服务。

## 安装与详情

- 插件首页只列已安装项。HTTPS Git 仓库或本机绝对目录直接一次安装全部条目。识别 `.claude-plugin/marketplace.json`、`.agents/plugins/marketplace.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 和根 `plugin.json`。市场支持相对目录、Codex `local/path`、`url` 的同仓库 `./` 来源，以及 HTTPS `github`、`url`、`git-subdir` 远程来源。远程来源按 URL+ref/sha 复用检出，sha 优先；记录真实仓库与提交 ID。不提供读取来源/单插件选择/信任勾选。npm/archive/command 来源尚不支持，明确整批拒绝，不跳过条目或执行清单命令。
- 安装复制完整插件及支持文件到 Runtime 根下 `installed-plugins/<批次ID>/plugins/<版本ID>/plugin/`，拆分 MCP 在同批次 `mcps/<版本ID>/`，独立手动 MCP 在 `marketplace/<版本ID>/`。默认根位于 `~/.agentforge/<实例>/runtime-configs/`。准备完整批次后一次 rename 发布，失败清理临时批次，不暴露部分已安装项。版本不可变，保存 manifest 及完整目录摘要；受管副本篡改会拒绝执行。
- 配置根的祖先目录允许 macOS `/tmp` → `/private/tmp`、卷挂载等正常别名，先解析实际位置再创建与记录路径；配置根本身及受管子目录仍拒绝符号链接，运行中实际位置改变则报错。目录错误在诊断中保留具体路径和错误码，不自动删除或重建真实数据。
- 导入不运行安装脚本、Hook、依赖安装或 MCP，不自动绑定员工。拆分时解析默认或声明的 MCP JSON，把插件根变量替换成已安装目录；清空加载副本的默认 MCP 文件并移除 manifest 的 MCP 声明，避免 Provider 自动启用。选中员工实际执行 Hook，以本机用户权限运行；bypass 不是沙箱。
- 插件卡片、详情及员工选择器分别标记 Claude Code/Codex 支持情况；详情给出不兼容原因，组件标记适用 Runtime。列表只给组件数量与兼容性；详情按需读取 Skill、Subagent、Hook 元信息及 manifest。支持表示静态组件可加载，不代表本机 CLI、依赖、模型账号已实测。在线市场浏览本轮不提供。
- 共享市场根目录且显式声明 Skill 子目录时，只加载该条目声明的 Skill；普通独立插件的自定义 Skill 路径仍补充默认目录。遵循 [Claude 插件清单规则](https://code.claude.com/docs/en/plugins-reference#marketplace-entries-and-the-manifest)，不会把同仓库其他插件的 Skill 自动混入所选插件。
- MCP 通过单服务 `mcpServers` JSON 安装为独立不可变版本，私有文件权限0600。详情接口隐藏 env/headers 等鉴权值；列表不携带 JSON。stdio、SSE、Streamable HTTP 均支持两种 Runtime；`streamableHttp`、`streamable-http` 归一为 Provider 的 `http` 类型。URL 未写 type 时按 HTTP 解析。stdio 的 `cwd`/`env_vars` 是 Codex 专用字段，含这些字段的版本只标记 Codex；手动 cwd 必须绝对路径，插件相对 cwd 固定为不可变插件目录。子进程继承当前本机环境，env_vars 不是沙箱白名单。两套清单同名 MCP 若定义不同，拆成独立 Runtime 标记的版本，由员工选择一个，不互相覆盖。Codex 私有启动器复用现有 MCP SDK 桥接远程传输；鉴权不进入命令行，拒绝重定向，不自动配置 OAuth。
- 员工编辑通过可搜索下拉添加插件/MCP，已选项以可移除标签展示。加载失败、版本缺失或 Provider 不兼容时阻止保存，不静默丢弃选择。
- 市场别名（如 stable/dev）可分别安装，但同一员工不能同时选择原生名称相同的两个插件版本，避免 Runtime 命名空间互相覆盖。

接口（均需管理员认证）：插件 `GET /api/runtime/marketplace`、`POST ...`（url/path 二选一）、`GET .../:id`；安装返回 `{plugins:[摘要],mcps:[拆分摘要]}`。废弃 discover/sourceId/pluginName，不保留旧输入兼容。MCP `GET/POST /api/runtime/mcp-marketplace`、`GET .../:id`。CLI 同步使用 `plugins list/get/import`、`mcps list/get/create`、`agents create/update`；安装无额外信任参数，删除与真实 Runtime 测试仍须 `--yes`。

## Runtime 加载与隔离

安装允许来源仓库/本机市场目录内部的文件与目录符号链接（包括同仓库共享资源），将目标内容按链接原路径复制成普通文件/目录，保留字节与可执行标记；中文、空格等合法文件名保持不变。来源边界为本次传入的目录或各条目所属的 Git 仓库，不是任意上级目录。断链、循环链接、来源外目标及 socket/FIFO/设备等特殊文件明确报告插件名和相对路径，整批不发布，不静默漏装。展开后的文件仍计入原有大小/数量限制。安装副本和受管配置目录仍不允许符号链接，执行前摘要/完整性校验不放宽；不执行来源中的脚本或 Hook。既有安装无需迁移，失败的来源重新安装即可。

安装时分别解析 Claude 与 Codex 清单，不把优先发现的清单组件覆盖到另一个 Runtime。Codex 根 manifest 的 `extensions.com.openai` 或 `.codex-plugin` 配置用于 Codex 投影；显式 `hooks: {}` 关闭默认 Hook，不继承 Claude 的启动 Hook。组件并集只用于详情展示，实际 Skill/Subagent/Hook 按员工所选 Runtime 投影并随任务冻结。切换 Runtime 不自动删除原选择；不兼容时 UI 和服务端均拒绝保存，须移除或更换插件。

Claude 使用所选 --plugin-dir 原生加载 Skill/Subagent/Hook，空 setting-sources 排除宿主设置、关闭可关闭的 bundled skills，不禁用全部 Skill。Codex 所选 Skill 通过调用独占 App Server 原生注册额外根，发现后以线程级 skills.config 仅启用所选路径；不把路径和逐一读取指令放进系统提示词。无 Skill 保留 exec，同一会话身份可续接，原生加载失败不退回读文件指令。既有 agents/共同 command Hook 投影保留，不改全局配置；Provider 专有前处理、参数替换和生命周期不保证跨端等价。不支持原生接口的 CLI 明确报错，当前目标 Codex 0.164.0。

格式互通不等于所有生命周期/工具名等价；Skill、共同命令 Hook 和 Subagent 正文可适配，但 Provider 专有功能须分别验证。参考 [Codex 插件规范](https://developers.openai.com/plugins/build/plugins)、[官方跨格式说明](https://developers.openai.com/plugins/guides/submit-claude-plugin)、[Claude 规范](https://code.claude.com/docs/en/plugins-reference)。已审阅的 [claude-codex-converter](https://github.com/achammah/claude-codex-converter) 侧重全局迁移，不作为员工隔离加载器；本轮复用现有官方 MCP SDK，不新增依赖。

只加载员工明确选择的扩展引用。选择变更只影响后续 Task/沟通；既有 Task/Run 与已排队投递冻结事实不重写。冻结快照的读取适配不是重新开放废弃的写入协议。开发期不自动转换旧 Skill 选择或安装版本：旧配置需重新安装插件/MCP并明确选择；不擅自重置真实实例。

这是加载隔离，不是 OS 沙箱：同一系统用户的员工仍可能主动访问其他本机文件。插件来源、Hook 和 MCP 均须可信。

## 集中 Runtime

设置拥有具名连接的 Provider、模型、CLI路径、Codex profile、effort；员工只引用 profileId。连接更新投影到当前员工，不改冻结工作。Provider 创建后不可改；切换 Provider 选择另一个连接并重新核对扩展兼容性。任何连接只要没有当前员工引用即可显式删除（含默认项），不会自动补回或修改 CLI 凭据。

测试按钮使用保存配置、新会话与空扩展调用真实 CLI/模型；成功须验证结构化应答。失败/超时写本机日志，页面只显示结果和日志路径。不创建业务任务，也不等于任务可交付。沿用各 CLI 自身登录，不新增模型 Token/Base URL 存储。

## Runtime 模型目录与思考等级（2026-10-25）

Runtime 配置新增可选 `effort`（思考等级，空 = CLI 默认），随 model 一同保存、回读、投影给绑定员工并进入真实调用；已有 Task/Run/排队沟通快照保持冻结。Store 按 Provider 校验 effort 档位集合（Claude Code：low/medium/high/xhigh/max；Codex：加 ultra，均来自真实 CLI 观察），明显非法值拒绝；模型仍是自由文本——2026-10-25 人类裁决允许手工输入，服务端不做列表成员硬校验，但 UI/CLI 如实标注"不在当前列表"。

模型列表只来自真实来源，经受认证 `GET /api/settings/runtime-profiles/models?provider=…&executable=…` 提供（server/runtime/model-catalog.mjs）：Codex 用与真实 spawn 相同的 cliEnvironment 执行 `codex debug models`（0.160.0 起），投影 slug/名称/可见性/逐模型 supported_reasoning_levels；visibility 为 hide 的模型不列出，目录可见不等于账号可用（实测 gpt-5.5 在目录中但被 ChatGPT 账号拒绝，返回明确 model_not_found），实际可用性以连接测试/调用为准。Claude Code 无离线列表命令（官方文档确认），目录 = 文档内置别名（default/best/fable/sonnet/opus/haiku/sonnet[1m]/opus[1m]/opusplan）+ settings.json `model`/env 与进程环境（进程优先，与 claudeMarketEnvironment 同边界）中的 ANTHROPIC_MODEL 与 ANTHROPIC_DEFAULT_*_MODEL 别名钉住及 _SUPPORTED_CAPABILITIES 能力声明；只读模型/名称/说明/能力键，凭据键绝不读取或回显。查询失败、空列表如实返回错误/空集，不编造列表。市场扩展执行带 `--setting-sources ''`，settings.json 的 model 字段在该模式下不生效（ANTHROPIC_* 环境键仍按同一优先级生效），目录说明已如实标注。

生效链路：Claude 调用追加 `--model`/`--effort`（2.1.216 实测，非法档位 CLI 仅告警回退，故保存侧必须校验）；Codex 追加 `--model` 与 `-c model_reasoning_effort="<level>"`（0.160.0 实测该键被识别、非法值不被本地拒绝，故保存侧必须校验）。保存校验分两层：Store 按 Provider 档位集合拒绝明显非法值；HTTP 在模型存在于真实目录时按该模型声明的档位拒绝不适用值（Codex 逐模型、Claude 按能力声明），模型不在目录（手工输入）或目录查询失败时不臆造拒绝。连接测试使用保存的 model+effort。resume 会话照常携带两参数：Claude `--resume` 下 `--model`/`--effort` 覆盖原会话选择（官方文档机制，已实测参数接受）；Codex `exec resume` 下 `-c`/`--model` 覆盖同理。切换模型时 UI 清除不在新模型档位集合内的旧 effort 并明示；模型能力未知（无声明/不在目录）时不臆造拒绝，如实标注由 CLI 解析回退。

目录与执行环境一致性：市场扩展执行（`--setting-sources ''`）经 claudeMarketEnvironment 只回注明确列举的连接键，该白名单与目录读取键一致——ANTHROPIC_MODEL、四个 ANTHROPIC_DEFAULT_*_MODEL 别名钉住及对应 _SUPPORTED_CAPABILITIES 能力声明、地址与代理键；进程环境优先。目录声明的别名钉住/能力在实际 spawn 同样生效（回归测试锁定）。

Web 设置模型字段为可搜索筛选的原生 datalist 下拉 + 手工输入，思考等级为联动 select，加载中/空/失败三态与"手工输入不在列表"标注齐备；目录请求带序号，切换 Provider/CLI 路径或连续刷新时过期响应不覆盖新列表。CLI `runtimes models PROVIDER [--executable PATH]` 返回同一目录，schema/help/输出同步 effort 字段与 models 操作。桌面共用该设置页，无新增 IPC/桥。目录与保存校验的 CLI 路径仅拒绝控制字符（execFile 不经 shell，空格/中文路径合法）；Codex 目录为全局目录，`codex debug models` 不接受 --profile（实测 CLI 明确拒绝），命名 profile 只影响调用时配置。


### GitHub / GitLab 私有仓库拉取 Token（2026-10-12）

「设置 → 仓库访问」（`/settings/repositories`）管理本机 `git-credentials.json`，它位于 `AGENTFORGE_RUNTIME_CONFIG_ROOT` 下、权限为 0600，格式固定为版本号和 GitHub/GitLab Token。`GET /api/runtime/git-credentials` 只返回两个公共 HTTPS 主机的 `{ id, label, host, configured }` 状态；`PUT`/`DELETE /api/runtime/git-credentials/github|gitlab` 仅在已登录管理员会话中写入或移除，读取后绝不回显 Token。托管根目录和文件均拒绝链接，文件拒绝异常结构与过大内容，并以临时文件重命名提交；它不是 Store 数据、员工配置字段或可导出的业务 metadata。主题和导航偏好使用单独的浏览器本地存储，绝不混入 Token；离开设置清除输入，页面刷新只恢复配置状态。

Task 继续冻结不含凭据的 repository URL/ref。`server/index.mjs` 只把 URL 解析能力交给 Run Files；Run Files 只在 URL 精确匹配 `https://github.com/...` 或 `https://gitlab.com/...` 时，在 clone/fetch 子进程中以临时 credential helper 传入 Token（GitHub 用户名 `x-access-token`，GitLab 用户名 `oauth2`），按主机拒绝重定向/其他主机请求并在检出后删除 helper。Token 不进入 URL、命令参数、workspace-ready 标记、Task/Run/Trace/Event/Artifact、日志或 Agent Prompt。clone 禁用 Git hooks、子模块与 LFS 自动下载；既有本机 Git URL 重写并不成为平台 Token 授权。

这仅解决公共 GitHub/GitLab HTTPS 的读取：SSH、自托管实例、GitHub App/OAuth、Token 轮换和写权限不在范围；已有本机 Git/SSH 认证仍可照常工作。拉取 Token 不等于 `deliveryAuthorization`，不授权 push、合并或部署；这些外部操作仍需 Task 明确的人类授权。由于 Runtime 是用户授权的本机 bypass，0600 私有文件和临时 helper 不是沙箱，也不能防御同一 OS 用户的直接读取。
