# CLI 指南

本仓库仅提供客户端；首次管理员设置在应用内。CLI 继续连接客户端私有 endpoint，配置/任务/auth 命令和字段不变。

任务 progress 的 lastError 保留脱敏原始错误；仅明确临时故障最多共三次尝试，确定性/未知错误停止自动重试。修复后通过客户端已有人工恢复入口继续，不自动升级或另派员工；CLI 不新增恢复权限。

workflows create/update/schema/--help 的 artifactPaths 支持任意规范工作目录相对文件或目录（artifacts/media/、reports/、summary.md），缺省为空；不再限定docs或作为接纳白名单。任务artifacts可查询非docs业务快照；CLI没有当前目录浏览/下载命令，本轮不扩权。

插件更新命令：plugins updates 查询当前服务检查状态、周期、下次检查、最近更新回执与错误摘要；plugins check-updates 请求立即检查（异步返回，随后 updates 查询）；plugins auto-update --file settings.json 接受 {enabled?:boolean,intervalMinutes?:integer}，至少一项，周期1–1440分钟（默认2）。三个操作的 --help 逐层展示参数，默认可读文本、显式 --json。设置与客户端「设置 → 插件更新」一致，CLI仍只连接客户端，不直接访问Git。关闭时可立即检查，保存后按新周期计时；当前员工统一切换新版本，冻结任务、排队调用及 MCP 选择不变；退出服务后不继续检查。

mcps update ID --file patch.json 编辑名称/说明/单服务 JSON，至少提供一项；省略 content 保留配置。完整参数与脱敏值保留规则见 mcps update --help。成功返回新 id、previousId 和更新员工 ID/名称，不倾倒员工详情；后续用新 ID get。当前员工原子切换，冻结任务和排队调用不变，不兼容或并发修改时拒绝。安装仍用 create，不自动绑定。

pluginIds 仍选择完整插件；所选 Skill 经 Runtime 原生注册、按需激活，不向应用系统指令追加路径和逐一读取说明。内置历史 MCP 通过真实工具定义提供能力。CLI 字段、输出和关联查询不变，agents 帮助/schema 同步语义；原生注册/触发须真实验证，不能仅凭安装或静态兼容标签判断。

平台历史工具由任务/沟通 Runtime 自动提供，不需 CLI 安装或员工额外选择；打包版启动环境修复不增加命令、输入字段或输出。任务继续使用原有 messages/send/reply 语义：未归档可发送，归档只读；移除 Web 的停止答疑按钮不改变 CLI/API 或人类最终确认边界。

员工 `runtime.extensionSelection` 省略或空数组均表示不加载市场扩展，不继承全局 MCP、插件或 Codex Apps。MCP 选择帮助已同步隔离边界；基础文件/Shell 工具仍可用，CLI 无新参数或输出字段。员工资料/扩展编辑不重建沟通原生会话，下一次调用应用新配置；实际 Runtime 连接变化才重建。

员工 `systemPrompt` 表示通过 Runtime 系统/developer 指令传递的长期工作法，而不是每轮用户正文。完整工作流只给经理；环境与可咨询成员目录在指令层。已有配置、任务新指令和精确澄清命令不新增参数或权限，帮助/schema 同步该含义。

CLI 专属于客户端：源码和安装版都只发现运行中的客户端，校验私有 endpoint 的实例 ID 后才读取会话/发送凭据；无 Web 目标、无 4310 回退。客户端退出、连接文件不安全或实例失配返回 CLIENT_UNAVAILABLE（退出码 5）。已移除 --target，废弃选项明确拒绝；help/schema 和输入校验保持离线。开发/隔离测试可用 --endpoint-file 指定客户端私有连接文件，不手填 origin。默认会话统一为 ~/.agentforge/cli-session.json（可显式 --session-file）；旧安装版 CLI 需要重新登录，不搬迁会话。普通 Web 设置不提供 CLI 安装入口。

新实例默认任务工作根统一为 ~/agentforge，不分 Web/Desktop；设置中已保存的目录仍优先，已有 Task/Run 路径不改写。CLI 创建任务使用当前实例工作根，应用数据仍按实例隔离于 ~/.agentforge。

`plugins import --file source.json` 安装时展开来源目录/所属 Git 仓库内的符号链接，形成不依赖原目录的普通文件副本；中文、空格等文件名保留。断链、循环、越界目标和特殊文件返回插件名/相对路径，整批不发布，不静默忽略。输入仍只有 url/path 二选一，`--help` 和 schema 同步说明，无额外兼容开关；员工选择及详情查询协议不变。

插件和 MCP 支持 `agentforge plugins delete ID --yes`、`agentforge mcps delete ID --yes`。先 `list --search 文本` 或 `get ID` 核对目标；没有 `--yes` 不发删除请求。当前员工仍选择该版本时服务拒绝并指出员工，需先 `agents update` 移除选择。成功回执包含 ID、名称、deleted 与 historyRetained；再 list 不显示、get 返回 404。历史冻结引用和文件保留，插件删除不影响独立 MCP。各操作的 `--help`/schema 与认证 HTTP 同步。

任务协作的界面配色不进入 CLI 文本/JSON；仍输出真实状态文字，不输出 `tone` / `statusCode` 等视觉元数据。

## 安装与连接

桌面「设置 → 命令行 CLI」可安装用户级命令。源码运行 `npm run cli -- help`。


```bash
agentforge auth login --username admin
agentforge auth status
agentforge teams list
agentforge agents create --help
agentforge schema agents --json
```

TTY 隐藏输入密码；脚本使用显式 `--password-stdin`。没有密码命令行参数。会话私有持久保存，默认不因时间到期；不读取浏览器 Cookie、数据库或全局 Provider 凭据。`auth logout` 撤销本 CLI 会话。

## 配置

命令组包含员工、角色、团队、工作流、Runtime、插件和 MCP。根帮助列组，组帮助列操作，操作 `--help` 和 `schema` 提供字段与 JSON 模板。默认可读文本，机器消费者显式 `--json`。

角色：`roles list/get/create/update/delete` 管理只有名称和纯文本提示词的共用角色；update 为部分更新（至少 name/prompt 一项），delete 需要 `--yes` 且仍有员工（含停用）绑定时拒绝并列出员工。员工以 `roleId` 绑定至多一个角色，显式 null 解除绑定；角色提示词并入该员工沟通与任务执行的应用系统/developer 指令，不进入每轮用户消息。角色编辑只影响之后创建的任务与后续沟通投递，冻结 Task/Run 快照保持原文本；删除角色不改写历史快照。

员工通过 `runtime.profileId` 引用连接，扩展只接受完整 `extensionSelection:{pluginIds:[],mcpIds:[]}`。拒绝单 Skill、员工 `mcpJson`、手工路径及派生字段。工作流用 `staffingGuidance` 表达人员需求；仓库绑定研发员工。`pluginSources`、工作流 `ownerRole/repositoryPath/reuseOwnerFrom` 不属于当前写入协议。

插件：`plugins list` 只列已装摘要；`plugins get ID` 按需返回 Skill/Subagent/Hook 详情。`plugins import --file source.json` 接受 `{"url":"https://…git"}` 或 `{"path":"/absolute/plugins"}`，一次原子安装来源全部 Claude/Codex 插件，返回插件摘要与拆分 MCP 摘要；任何条目失败则整批不发布。不再接受 discover/sourceId/pluginName 或安装信任参数。自带 MCP 另入 MCP 市场，员工单独选择，不随插件启用。`mcps create --file mcp.json` 安装单服务 JSON，支持 stdio/SSE/Streamable HTTP，两种 Runtime 均可用；`mcps get ID` 返回脱敏 JSON。安装不执行 Hook/依赖、不自动绑定。员工 create/update 可指定 status 为 active/inactive。详细字段用操作后的 `--help` 查看，在线市场暂不提供。

市场来源遵循 Claude/Codex 的 Git/本地部分规范：相对目录、local/path、HTTPS github/url/git-subdir，支持 ref 和完整 sha（sha 优先），安装所有条目并保留真实提交。不执行 npm/archive/command 来源，遇到时整批失败。`plugins list` 的 Runtime 列只列支持项；`plugins get ID` 的 compatibility 给出两种 Runtime 的 supported/reasons，组件注明 providers。静态支持不代表依赖、CLI 或账号已实测。不兼容的员工选择由 HTTP 拒绝。stdio MCP 额外提供 cwd（绝对路径）/env_vars（变量名数组）时仅支持 Codex；普通 stdio/远程传输的两 Runtime 支持不变。

`runtimes models PROVIDER [--executable PATH]` 返回真实模型/思考等级目录；`effort` 空值使用 CLI 默认。详细参数以当前命令帮助为准。

## 任务

- `tasks create/start`：创建与启动分开。
- `tasks list/get/progress`：摘要、任务事实和当前进展。
- `tasks collaboration/questions/artifacts`：协作、未答问题与交付元数据。
- `tasks message/reply`：给指定成员发消息，或精确回复待答人类问题。
- `tasks terminate/delete`：终止后保留历史，删除须显式 `--yes` 且任务已停止。

历史执行可用 `--run RUN_ID` 指定，Run 须属于任务。写消息需要已启动的 Run；回复必须匹配当前未答问题。最终任务完成由 客户端的人类确认。

任务输出不递归展开员工提示词或完整冻结配置，关联信息通过 ID/名称引用，按需用对应命令查询。

## 输出与失败

`--json` 成功为 `{ok:true,data:...}`，失败为 `{ok:false,error:...}`。普通文本错误写 stderr；交互密码提示也只写 stderr。

退出码：0 成功，2 输入/用法，3 登录/会话，4 服务拒绝，5 连接/超时/不确定响应，130 交互取消。写入不自动重试；连接中断后先读取核实，再决定是否重发。

输入文件最大 1 MiB，HTTP 响应最大 16 MiB，请求限时 120 秒。会话目录/文件要求当前用户、0700/0600，拒绝符号链接。命令只走认证 HTTP，不直接访问 Store 或 Runtime。
