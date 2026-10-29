# 领域模型

工作流 artifactPaths 是工作目录内建议交付位置（文件或目录），可为空，不再限定/补齐 docs。持久化与冻结配置保留原路径，不进行路径迁移或重置。当前文件/CHANGE覆盖所有普通业务路径，repos仅保留研发员工检出及初始提交关系；读取排除内部元数据、凭据和符号链接。执行快照记录各业务路径，仍受20MiB单文件与5000文件上限，快照失败不是员工执行权限或任务结论；大文件可在工作目录查看元数据并下载，不能冒充已保存不可变快照。

Store 保存 pluginAutoUpdate 开关（默认开启）与 pluginUpdateIntervalMinutes（默认2，整数1–1440），非空部分设置经过同一命令校验并记录 configuration.plugin_auto_update；按来源替换插件时核对员工 Runtime 未被并发编辑，原子更新当前选择者并退役旧目录版本，configuration.plugins_updated 的 actor 是系统插件更新而非人类。Task/Run/排队调用的冻结 manifest 与原始文件不改。关闭开关仅停止后续定时检查，已开始检查仍完成；退出本机服务不再检查。

MCP 编辑生成不可变新版本；Store.replaceMcpExtension 在一个事务中核对当前员工 Runtime 未被并发修改、更新所有当前选择者并退役旧版本，记录 configuration.mcp_updated。Task/Run/排队投递的冻结 manifest、原始私有文件及历史消息不改写；不兼容或配置冲突拒绝整次更新。新版本 ID 由回执提供，旧 ID 从当前目录退役。

沟通附件属于 Conversation，消息冻结 ID、名称、相对路径、字节和 SHA-256，引用只能来自同会话。CommunicationDelivery 每次 attempt 保存自己的原生会话绑定，ID 不进入通用审计事件；控制台投影实际投递/尝试，不创建 Task/Run。只有员工新回复计入未读，人类发送与 pending 均不计入。

任务默认工作根统一为 `~/agentforge`，不分 Web/Desktop；配置与鉴权仍按实例隔离。新 taskId 使用 `task_<随机UUID>` 这一不透明引用，避免跨实例同毫秒任务共用目录；目录层次仍为 `<workspaceRoot>/<taskId>/<runId>`。清除受管目录同步接受 UUID 连字符，仍要求路径和标记归属完全匹配、拒绝路径穿越，不删除外部兄弟文件。保存的工作根与已有任务/运行路径不变，不自动搬迁。

已安装插件/MCP 可由人类删除：认证 HTTP 验证安装 ID 后调用 Store `removeExtension`。当前员工（包括停用员工）仍选择该版本时拒绝，不隐式解除绑定；Store 同步拒绝删除后到达的过期绑定写入。`extensionRemovals` 与 `configuration.extension_deleted` 事件在同一事务持久化，目录与详情不再暴露已删项。不可变文件与冻结 Task/Run 不变，历史执行仍可核验/恢复；插件删除不连带删除独立 MCP。

插件安装版本是员工扩展的选择单位，包含完整 Skill/Subagent/Hook 文件与摘要。员工新配置只接受 `extensionSelection.pluginIds/mcpIds`，不接受 Skill ID 或私有 MCP JSON；扩展内部路径/摘要由服务解析并随任务冻结。安装插件不绑定员工，不把组件单独安装为员工可选资源。旧任务事实不重写，废弃输入明确拒绝。

一个来源整批发布多个插件版本；自带 MCP 拆为独立版本，仍需员工明确选择，不继承插件选择。员工 create/update 均可设置 active/inactive（默认 active）；停用不改变冻结任务和投递事实。

| 对象 | 含义 |
| --- | --- |
| Agent | 数字员工及当前运行配置 |
| Team | 项目经理与业务成员 |
| Workflow | 节点、人员需求、自然语言交付及交接关系 |
| Task | 人类目标、团队和冻结配置 |
| Run | 一次任务执行与整体协调状态 |
| Dispatch | 持久化投递、尝试和重试安排 |
| Trace | 一次员工调用、原生会话和提示词引用 |
| Message | 带发送者、接收者和 conversationId 的协作消息 |
| Artifact | 绑定 Trace 的不可变文件快照元数据 |
| Defect / Decision | 员工报告的问题与决定 |
| Event | 生命周期与执行审计事实 |

## 协调

经理通过协调决定安排后续节点、员工和人类交接。没有下一步时可请求人类验收；平台记录决定，不核对节点完成率、业务结论或文件证据。员工可以普通文字交接。任务完成只能由人类确认。

Run 不持久化一套独立的节点状态机；界面的当前焦点由 Trace、消息和经理安排投影。节点依赖是预期交接信息，不能作为员工本机操作权限。

## 冻结配置和工作目录

Task 创建时冻结团队、员工、工作流及仓库配置。修改配置仅影响后续任务。

受管工作根：`<workspaceRoot>/<taskId>/<runId>`。`taskId` 区分任务，`runId` 区分该任务的一次执行。研发员工从自己的 `repos/<仓库>` 启动，其余成员从 Run 根启动；未准备好绑定仓库时使用工作根。启动目录不是访问限制。

新 Run 工作根初始化 Git，克隆仓库注册为 `repos/` 下的 gitlink。初始化失败记诊断，不阻止员工交接或替经理评价任务。

## 会话和历史

应用指令和当前输入分离：员工身份、入口规则、执行环境进入 Provider 指令层；完整工作流仅进入经理指令，其他员工只接收本轮职责，不注入全工作流或预绑定人员表。经理明确选择下一位员工，不能由 Task 的旧节点分配覆盖。

原生会话拥有其对话历史，平台不重放聊天记录。成员会话记录已投递的平台消息游标和上下文内容摘要：跨员工交接、广播和人类回复仍须首次送达。模型本轮产生实际正文/思考/工具内容或成功返回结果后确认；启动失败、快照或连接事件不确认。确认后即使执行失败也不重投；关联目标 ID 不绕过游标。会话不存在时清空上下文摘要并记录重建事实，不伪称原生历史仍在；可通过真实历史工具按需查询。

不可自动重试的 Runtime 失败或三次临时失败耗尽时，Store 将原 Dispatch 置为 cancelled、保留原始脱敏错误和所有 Trace，记录 dispatch.retry_stopped；活跃业务 Run 失败、Task blocked，等待人类恢复。独立答疑失败只停止该投递，不改变已完成任务。现有手动恢复入口继续由经理基于保留事实重新评估，不自动换人或重派业务。

每位成员独立会话，后续 Trace 可续接已绑定的原生 Claude Code/Codex ID。Codex 创建阶段的内部占位 UUID 不写入 Trace.providerSessionId，原生 thread.started 确认后才绑定。沟通员工资料和插件/MCP 选择变化不改变会话身份；下次调用重新应用指令与所选扩展。实际 Runtime 连接或启动目录变化才重建，历史记录与已确认消息游标保留。

Task、Run、Trace、Artifact 和历史消息保留关联。删除配置时保留实际引用关系；归档与终止不抹去历史。清除数据只能通过显式管理员入口。

## 读模型

`GET /api/bootstrap` 返回目录摘要；`GET /api/runs/:id/workspace?view=summary` 排除 Runtime 日志；`GET /api/runs/:id/console` 按成员、Trace 与游标分页。完整执行正文与提示词使用各自按需读取接口。
