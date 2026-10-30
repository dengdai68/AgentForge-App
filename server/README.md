# 控制面

沟通输出 schema 的 required 含 reply 与可空 handoffToAgentId 两键（严格 Provider 校验要求）；null 或省略均不转交，实际目标继续由 Store 校验。提示词与 schema 同步，不修改 Task 协议或 CLI 能力。

工作目录直接读取真实根，不再生成/读取展示清单，不预建 docs。目录查询按层/200项分页，普通根文件、业务自定义目录与大媒体可见；认证读取/下载仅保留工作根、敏感文件与链接检查。Git比较工作根初始化提交并保留绑定repos原始gitlink。Orchestrator记录各业务路径有限快照，Store工作流位置仅作建议、缺省空，不改写历史路径。

plugin-updates.mjs 属于编排层，只准备已装 Git 插件新快照并调用 Store 事务；Store 保存开关、分钟周期和绑定/审计，Runtime 负责来源校验、Git 提交查询与不可变文件。HTTP 暴露认证状态、异步检查及部分设置，不从 UI 驱动定时器；重置避开活动更新，服务重启清空观察状态。

MCP PUT 编辑由 Runtime 校验与准备新不可变文件，Store 事务核对并更新当前员工、退役旧目录版本及记录审计。HTTP 不循环保存部分员工；失败隐藏未使用候选，原配置/冻结文件保留。编辑不返回私有鉴权值。

Skill 路径不进入应用系统指令：Claude 原生插件 Skill 激活，Codex 所选技能经调用独占的原生 app-server 注册，并以线程级启用列表排除未选路径。历史 MCP 的能力目录/分页在服务定义中，不再复制进应用提示词；仅保留历史核对的行为原则。HTTP/Store 仍拥有状态，原生进程只返回执行事实。

Codex 的平台历史 MCP 接收 Bridge 全部自有环境，包含打包版 Node 模式；启动为 required，不能在指令声称有历史工具的同时静默忽略启动失败。Provider 环境隔离、员工市场选择与历史查询范围不变。协作页只展示真实经理结论消息，不再固定附加验收副本；内部验收事实、取消与审计保留。

私有提示词快照保留完整脱敏系统指令/本轮输入，共享控制台展示完整内容和已确认原生会话 ID；静态应用图标 PNG 返回正确 MIME。员工姓名/职责/能力及插件/MCP 选择变化续接原生沟通会话，下一次调用应用新配置；只有实际 Runtime 连接或启动目录变化才重建。Codex Apps 在调用级关闭，不修改全局配置。

prompts.mjs 纯组装系统指令与当前输入：身份/入口/环境进系统层，完整工作流仅经理；用户目标、职责和状态按内容摘要增量追加。员工绑定角色的共用提示词作为快照数据（`roleSnapshot`）并入身份段，组装层不查询 Store。Store 游标在模型产生内容或成功返回后确认，明确目标也不重投，不重放原生历史；派工使用经理显式员工 ID。协议见 docs/22。

Store 拥有 roles 集合：名称＋纯文本提示词，员工经 `roleId` 单选绑定（可空），绑定校验存在性；Task 创建冻结 `roleSnapshot` 文本，沟通投递在发送/重试时嵌入，删除拒绝当前员工（含停用）引用并列出名称。HTTP 提供认证 `/api/roles` CRUD 与 bootstrap 摘要；Runtime 不持有角色状态。

Runtime 原始错误脱敏后保留，分类不替换正文；已知临时错误最多三次尝试，未知/确定性错误停止自动重试，Store 保留失败投递及 Trace，由人类恢复。定时巡检只唤醒已有到期投递，不声称经理发起新工作。

沟通附件由 Run Files 保存在会话 attachments 子目录，Store 只冻结引用和摘要；认证二进制上传最多 20 MiB，下载验证归属/字节/摘要/链接。调用正文和提示词在私有 .agentforge 目录，通用事件只持引用，原生会话绑定在投递尝试元数据；分页 API 供共享控制台，不制造 Task/Run。

data-home.mjs 为客户端子服务 提供统一的默认任务根 ~/agentforge；应用数据仍按实例隔离于 ~/.agentforge。保存的工作根优先，历史路径不搬迁。Store 新 Task ID 使用随机 UUID，避免跨实例共享根目录时同毫秒/序号碰撞；HTTP/Store 命令不扩权，CLI 仅连接客户端。

插件安装在来源复制阶段展开同仓库/目录内的符号链接，断链、循环、越界和特殊文件精确报错且整批回滚；执行用不可变普通文件副本，运行期完整性校验不放宽。HTTP/CLI 使用同一路径，契约见 docs/15。

插件/MCP 目录与详情经 Store 的 extensionRemovals 过滤；认证 DELETE 验证已安装目标，再由 Store 检查当前员工引用、拒绝已删 ID 的新绑定并原子写入删除事件。Runtime 文件保留给冻结任务，不在 HTTP 层删除历史文件。

| 模块 | 职责 |
| --- | --- |
| `index.mjs` | HTTP 路由、认证、静态资源、SSE |
| `store.mjs` | 领域状态、命令和读模型 |
| `orchestrator.mjs` | 派工、协作、会话续接及执行 |
| `persistence.mjs` | SQLite 元数据 |
| `run-files.mjs` | 工作目录、执行内容、提示词和 Artifact 快照 |
| `workspace-git.mjs` | Git 状态、任务初始版本与 Diff |
| `auth.mjs` | 管理员、持久会话和登录限流 |
| `communication*.mjs` | 私聊、群聊、消息投递 |
| `history/` | 员工历史工具和派生查询索引 |
| `runtime/` | CLI、模型目录、Skill/MCP 与私有配置 |
| `data-home.mjs`、`data-reset.mjs` | 实例路径和显式数据清除 |
| `diagnostics.mjs` | 本机诊断日志 |

Store 拥有状态，Runtime 不直接写领域对象。平台执行员工和经理的协调决定，不核验业务质量、节点覆盖或文件证据；记录失败不作为拒收业务结论的理由。

任务摘要不包含 Runtime 日志；控制台按成员和游标分页，正文与提示词另行读取。读取文件时验证资源归属和完整性，避免展示错误内容。

工作目录 `content?download=1&path=...` 共用工作根、敏感路径和符号链接检查，以 attachment/octet-stream 流式返回完整当前文件，不受预览上限影响；传输错误进入诊断，不回写领域状态。

服务仅由客户端 IPC 携带 bootstrap 信息启动，固定 127.0.0.1、系统随机端口、实际 origin；普通 node 直接启动在存储初始化前拒绝，父进程断开即退出。不读取 .env/HOST/PORT/公开域名，不提供独立 Web 部署。所有 HTML 加入客户端样式。

认证工作目录 PUT 先验证非根绝对路径，再 mkdir 创建缺失父/子目录，核对实际位置和权限后由 Store 保存；失败保留原设置及诊断 cause，不清理目录或搬动旧任务。CLI 创建任务继续使用当前根，不新增设置命令。

扩展统一为插件级不可变版本：Git/本机来源中全部插件作为一个批次发布，失败不留下部分安装；自带 MCP 拆成独立市场项，不随插件启用。认证详情接口按需读组件/脱敏 JSON；员工输入仅 pluginIds/mcpIds，创建/编辑均可设置状态。stdio/SSE/Streamable HTTP 支持两种 Runtime。完整契约见 docs/15。

插件市场接受 Claude/Codex 市场中的本地条目及 HTTPS github/url/git-subdir 远程条目，保留真实 revision；不支持来源整批失败。组件按 Runtime 分别解析，API 返回 providers/compatibility 及原因，员工绑定由同一解析拒绝不兼容选择。配置根允许祖先正常别名、受管目录本身拒绝链接。含 Codex 专用 cwd/env_vars 的 MCP 仅供 Codex，工作目录由启动器应用。

手动重复导入由 HTTP 串行准备；Store 按同来源地址＋名称、MCP 按安装名称覆盖，Store.replaceImportedExtensions 事务更新当前员工（含停用）、合并重复引用并退役旧目录项。失败整批保留原状态，候选退役；冻结任务和排队调用的文件不变。回执包含 reference-only replacements/employees/historyRetained。
