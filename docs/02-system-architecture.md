# 系统架构

本仓库为 AgentForge App 独立客户端，完整抽取边界见 [ADR：客户端抽取](23-desktop-extraction.md)。默认 start/dev 启动 Electron，自带本机控制面与全部界面；服务要求父进程 IPC 与 bootstrap 信息，不能直接启动；父进程断开时退出。

工作目录展示由 Run Files 直接读取真实任务根，取代 manifest 白名单；HTTP 按 path/offset 每页200项，界面按需展开。工作流只提供交付位置建议，Store 校验规范相对路径，CLI同步，未提供时不填 docs。Orchestrator 采集各业务路径的有限不可变快照，CHANGE 通过只读 Git 观察已提交/未提交/未跟踪文件；大媒体不因快照上限从目录/CHANGE消失。不新增索引库、文件监控服务或自动提交。

插件定时更新决策：复用本机服务生命周期和 Node 定时器，不新增系统 cron、常驻守护进程、队列或依赖。服务运行期间默认每120000ms检查，上轮结束后安排下一轮，不重叠；开关与1–1440整数分钟周期（默认2）由 Store 持久保存，设置入口独立于插件市场，检查状态/最近结果仅为当前服务进程观察。按安装来源分组，使用真实 Git 提交及外部 ref/sha 依赖判断变化；无变化不克隆/安装、不写审计。新候选经完整校验与全部当前选择者兼容检查，再由一个 Store 事务替换该来源插件引用；失败保留该来源旧版，其他来源可继续。安装不执行来源脚本/Hook，自动检出的临时源码用后清理，已冻结安装文件不删除。重置时阻止与活动更新并发，重置后清除检查状态。

原生 Skill 传输决策：完整插件安装/员工选择协议不变。Claude 使用既有 --plugin-dir 原生 Skill，不全局禁用。Codex 仅在有所选 Skill 时使用调用独占的 stdio App Server：额外根注册、原生发现、线程级启用列表、thread/turn 执行；无 Skill 的 exec 不作无关迁移，二者共用 Provider thread 身份和控制台投影。这是能力驱动的传输选择，不是旧数据兼容或失败回退。单次进程避免共享工作目录员工混用进程级根；取消/超时清理自有进程组。不新增服务、依赖、凭据副本或领域状态来源，最终完成仍由人类确认。

server/prompts.mjs 分离应用系统指令和当前输入：完整工作流仅经理持有，执行环境进系统层。Store 保存成员平台消息输入游标及上下文摘要，模型产生内容/成功返回后确认送达，后续只追加新消息和变化上下文，原生会话拥有对话历史，不重放 transcript。Runtime 分别适配 Claude 系统追加文件和 Codex developer_instructions，详细协议见 docs/22。

运行失败展示脱敏原始错误；Runtime 判定明确临时故障，Orchestrator 限制同一投递最多三次，Store 停止不可重试/耗尽投递并标记业务 Run 失败。HTTP 定时器仅唤醒到期队列，不伪造经理新派工，不在安装完整性失败后无限重试。经理的非终止安排在仍有未结束投递时顺延：Orchestrator 记录顺延说明并向经理入队一次复核投递，队列清空后基于最新状态重新决定，被顺延的决定不再静默丢失；该复核投递自身不阻塞后续交接。平台自建的协调跟进投递（顺延复核、格式纠错、交付通知）只为继续协调而存在；Run 进入验收或人类确认完成时，Store 将未执行的跟进投递取消并记录审计事件，完成状态不再残留永久不可领取的协调投递，归档门禁不受影响。

沟通工作台复用任务控制台 renderer 和按需内容读取器，但以 Conversation/Delivery/attempt 为归属。HTTP 接受同源认证二进制附件，Run Files 保存会话原文件和私有执行内容，Store 只保存元数据、消息关联与调用事实。控制台只在展开时按成员/50 条事件分页轮询，历史按 Map 分组，不重复扫描全事件。现有 CLI 未覆盖长期沟通，本轮不扩展 CLI 权限或命令；配置与任务协议不变。

CLI 仅供客户端使用，私有 endpoint 发现与实例校验统一在 cli/client.mjs；不接受 Web/Desktop 目标，不默认连接 4310。应用数据根仍隔离；默认任务根统一为 ~/agentforge，由 server/data-home.mjs 的纯路径函数供客户端自有服务使用。保存的工作根和历史路径不改写。新 Task ID 使用随机 UUID，避免独立实例共享工作根时因毫秒/进程序号相同而碰撞，不增加平台子目录。

```text
Electron renderer / CLI
        │ HTTP + SSE
server/index.mjs ─ auth.mjs
        │
      Store ─ SQLite
        │
  Orchestrator ─ Run Files / Workspace Git
        │
      Runtime ─ Claude Code / Codex CLI
```

## 分层

- 客户端界面/CLI 发命令和展示结果；Electron 另外拥有窗口与自有子服务。
- HTTP 负责认证、路由、输入边界和资源读取。
- Store 拥有 Task、Run、Trace、Message、Dispatch 等持久状态与命令。
- Orchestrator 执行经理的协调决定、调用员工、投递消息和记录事实。
- Runtime 只适配本机 Provider，不能直接更改领域状态。
- Run Files 保存文件快照，SQLite 保存元数据；Workspace Git 提供源代码差异。

平台不按业务质量、节点覆盖率或文件证据改判员工结果，不增加自动收尾复核。

## 实例

Electron 自有子服务只绑定 127.0.0.1 随机端口，鉴权仅接受实际 origin。所有 HTML 始终包含客户端样式，不按 User-Agent 切换产品模式。没有独立 Web 部署入口，认证 HTTP 仅为本机客户端/CLI 所需。

源码和安装版的默认数据根见 [桌面文档](18-electron-client.md)。HTTP API、静态应用、SSE 与文件资源经过同一认证入口。

工作目录设置由认证 HTTP 先校验非根绝对路径，递归创建缺失目录并核实实际目录及读写/进入权限，再交 Store 持久化配置和审计。创建或校验失败不改变已保存设置，诊断保留原始 cause；不删除已有文件。新目录仅用于后续 Task，不迁移旧 Task/Run，也不改变应用数据根。该常规设置没有 CLI 配置命令；CLI 创建任务仍使用服务当前的工作根。

扩展目录约定：Runtime 根中的 `installed-plugins/<批次ID>/plugins/<版本ID>/plugin/` 保存完整插件，批次 `mcps/` 保存拆分 MCP，`marketplace/<版本ID>/` 保存手动 MCP。SQLite 只冻结不可变引用/摘要。完整插件不拆成可单选 Skill；一个来源整批原子发布，不自动启用。详见 docs/15。

## 执行和恢复

### 扩展批次与传输适配（本轮）

完整来源在 `installed-plugins/<批次ID>/` 内同时准备插件和拆分 MCP，最后一次目录 rename 原子发布；目录索引从批次清单读取，不引入第二套数据库权威。插件仍为员工选择单位，拆分 MCP 为独立选择单位。原文件和派生加载文件一起冻结目录摘要，避免源目录修改影响已发布版本。

MCP 传输直接复用现有 `@modelcontextprotocol/sdk` 的 stdio/SSE/Streamable HTTP，不引入全局安装器或新的网络服务；私有启动器仅在员工执行生命周期内桥接，凭据留在私有文件而非 CLI 参数。跨来源重定向不携带服务鉴权。Claude/Codex 插件清单按同一包模型解析，Provider 专有能力通过执行参数/文件投影适配，不把格式转换等同于能力等价。

Dispatch 持久化投递与尝试状态；Trace 记录一次实际调用。失败保留原始事实，重试创建新的执行记录。启动恢复把被中断的调用记入历史，并根据持久投递恢复可继续的工作。桌面退出会停止其自有后台与执行进程，不保证离线继续运行。

## 展示性能

任务摘要排除 Runtime 日志，控制台使用成员分页接口。执行正文、提示词、文件、Diff 和图形资源按需读取。协作数据目前随任务摘要返回，UI 分批渲染，尚未实现服务端协作游标分页。
