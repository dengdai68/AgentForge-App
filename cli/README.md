# CLI

本仓库仅提供客户端。CLI 配置/任务/auth 命令和参数不变，连接私有 endpoint，不提供服务器部署目标。

Task 进度与帮助同步原始脱敏错误、临时故障最多三次尝试和人工恢复语义；确定性/未知错误不自动重试，不再宣称必然升级经理。

工作流 artifactPaths 是规范工作目录相对文件/目录建议，可省略为空；任意业务根均可使用，不再强制docs。create/update/schema/帮助/文本标签同步；任务artifacts仍按实际不可变快照查询，大文件当前目录浏览/下载属于客户端，不新增CLI越权入口。

plugins 新增 updates（状态）、check-updates（立即请求异步检查）、auto-update --file settings.json（enabled布尔值和intervalMinutes整数分钟1–1440，至少一项，默认2）。帮助/schema/参数与认证HTTP、设置 → 插件更新同步；更新回执只含插件ID/原ID/名称，不倾倒其他资源，检查不会创建任务或确认完成。CLI只访问客户端，Git网络由服务处理。沟通和任务控制台的默认选中仅为 UI 行为，不更改任务/协作命令。

MCP 新增 update ID --file patch.json，渐进帮助/schema 描述 name/description/content 部分更新、隐藏值保留与新版本回执。命令通过认证 PUT，不访问市场私有文件；省略 JSON 保留配置，成功后使用返回的新 ID。

pluginIds 仍选择完整插件：所选 Skill 原生注册、按需触发，不作为路径提示追加到应用系统指令；CLI 帮助/schema 同步此语义，输入字段和输出不变。内置历史工具通过 MCP tools/list 和服务说明提供能力，不在应用提示词重复工具清单。

员工扩展选择为空或省略时，不继承全局 MCP/插件或 Codex 账号 Apps；只加载所选服务与平台历史工具，保留 Runtime 基础文件/Shell 工具。`agents create/update --help` 和 schema 的 mcpIds 说明已同步；字段、输出与认证协议不变。普通资料和扩展选择变化不重建沟通原生会话，Runtime 连接变化另行记录。

员工 systemPrompt 作为 Runtime 的应用系统指令传递；完整工作流仅项目经理持有，执行环境及可咨询成员目录也属于应用系统指令。CLI 字段不新增，帮助/schema 已同步含义；任务消息和精确澄清仍走同一认证 HTTP。

CLI 仅连接运行中的客户端；源码/安装版统一通过私有 endpoint 发现、验证实例后才读取会话或发送凭据。不连接 Web、无 --target 或目标环境分支、不回退 4310；离线帮助/输入校验不访问服务。开发测试可指定 --endpoint-file。会话统一 ~/.agentforge/cli-session.json；旧安装版 CLI 需重新登录，不搬迁会话。

`plugins import` 同样支持来源目录/所属 Git 仓库内的文件与目录链接，安装为普通文件，中文/空格文件名不变；断链、循环、越界、特殊文件明确定位并整批回滚，操作帮助/schema 说明该语义。无新参数，不扩大员工选择或 Runtime 权限。

插件和 MCP 增加 `delete ID --yes`；帮助说明当前员工引用会阻止删除、冻结历史文件保留，插件与独立 MCP 不连带删除。搜索继续使用 `list --search 文本`，UI 布局不引入额外 CLI 协议。

`main.mjs` 处理命令；`commands.mjs` 定义帮助与 schema；`client.mjs` 负责认证 HTTP；`output.mjs` 渲染文本/JSON；`password.mjs` 隐藏终端密码输入。`agentforge` 是安装包内的 Electron Node 启动器。

`roles` 组管理员工可共用的纯文本提示词角色（list/get/create/update/delete，update 部分更新，delete 需 `--yes` 且被绑定时拒绝）；员工经 `agents create/update` 的 `roleId` 绑定至多一个角色，显式 null 解绑。角色文本并入应用系统/developer 指令，冻结任务保持原文本；语义详见 docs/03、22。


根帮助列命令组，操作帮助列字段，`--json` 返回机器输出。登录态独立持久保存，不读取浏览器 Cookie 或 SQLite。密码仅隐藏交互输入或显式 stdin，不作命令参数。

任务命令经过同一 HTTP；创建和启动分开，写入不自动重试。最终验收确认保留在 客户端。完整命令和失败语义见 [CLI 指南](../docs/21-configuration-cli.md)。

共享协作投影的颜色和界面状态码不进入 CLI 输出；`tasks collaboration` 保留状态文字和原有 JSON 字段。

扩展按完整插件：`plugins import --file source.json` 直接整批安装 Git/本机目录中全部 Claude/Codex 插件；自带 MCP 拆分后仍由员工单独选择。`plugins get ID` 查组件，`mcps get ID` 查脱敏 JSON，stdio/SSE/Streamable HTTP 均支持。员工只写 pluginIds/mcpIds，创建和更新均可设置 active/inactive；操作帮助/schema 同步当前协议。

市场内相对目录和 HTTPS github/url/git-subdir 条目一起安装，保留 ref/sha；不支持的 npm/archive/command 整批报错。plugins list 只加 Runtime 摘要列，get 按需展开 compatibility/reasons，help/schema 说明静态兼容不等于真实调用已通过。含 cwd/env_vars 的 stdio MCP 只支持 Codex；员工选择与 UI/API 使用同一兼容性规则。

重复 plugins import 按同来源地址＋插件名称覆盖；mcps create（含插件拆分 MCP）按安装名称覆盖，去首尾空格并区分大小写。当前员工引用原子切换，冻结历史不变，不兼容时整批拒绝。输入参数保持；help/schema、文本覆盖计数及 JSON replacements/employees/historyRetained 回执同步。
