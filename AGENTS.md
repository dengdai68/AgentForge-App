# AgentForge App 仓库协作规则

本文件只定义贡献者的规则与约束，不是产品手册。`AGENTS.md` 是唯一规则入口，`CLAUDE.md` 只引用本文件；不要复制维护第二份规则。

## 开始前

- 本机开发直接在 `main` 上修改和提交，不新建或切换功能分支；用户明确要求其他分支时除外。
- 先检查 Git 状态和最近变更；保留用户及其他会话的修改，不覆盖、不回退、不混入提交。任务工作目录是默认上下文，不是员工权限边界。
- 读取 `ai/module-registry.json`、`docs/00-ai-map.md`，再读目标模块的局部 README、源码、测试与相关契约；优先用 `rg` 定位。
- 按需查阅：产品 `docs/01`，架构 `docs/02`，领域 `docs/03`，设计 `docs/06`；完整文件名见 [文档索引](docs/README.md)。
- 运行与安装看 [README](README.md)，工程流程与提交格式看 [CONTRIBUTING](CONTRIBUTING.md)；不要把功能说明、版本历史或验收台账堆入本文件。

## 分层与底线

- Web / Electron 负责呈现与发命令；HTTP 负责认证、路由和边界校验；Store 拥有领域规则与状态；Orchestrator 通过 Store 推进执行；Runtime 只适配 Provider，不拥有领域状态。文件内容由 Run Files 管理，SQLite 只存元数据。
- CLI 通过同一受认证 HTTP 配置资源、创建/启动任务、查询执行与协作、发送指令及精确回复澄清；不直接访问数据库、提取浏览器会话或绕过 Store。人类最终确认保留在 Web/客户端。契约见 [docs/21](docs/21-configuration-cli.md)。
- Task/Run 记录协调状态；平台只执行员工与经理的协调决定，不做业务结果、流程完整性或内容证据校验，不自动改判或增加复核。员工可用普通文字交接；任务完成由人类显式确认。
- 保留冻结快照、不可变事件、Trace/Artifact 历史及成员会话隔离；不按角色名称硬编码派工。角色、团队与 Task 不限制数字员工的本机操作；协议破坏须更新 `docs/03-domain-model.md` 与 CHANGELOG。
- 认证默认拒绝；禁止泄露凭据、完整提示或未脱敏工具输出。私有配置、诊断、扩展与历史可见性按 [docs/08](docs/08-real-local-agent-runtime.md)、[14](docs/14-console-authentication.md)、[15](docs/15-employee-runtime-configuration.md)、[17](docs/17-communication.md)、[19](docs/19-agent-history.md) 执行。
- 本机单管理员 MVP/Beta 不是多租户、生产沙箱或高可用系统；Runtime bypass 不是沙箱。Electron 保持隔离和关闭式宿主接口，不新增通用文件/进程桥；详见 [docs/18](docs/18-electron-client.md)。
- Web 与 Electron 可有独立样式，但共享真实语义与命令；复用各自设计 tokens，保持键盘可达、窄屏可用和明确空态/错误，不另造页面级设计系统。

## 修改要求

- 开始前说明 Outcome、Evidence、Scope、Non-goals；先建立事实。产品问题先实际使用相关功能，不以静态代码直觉代替用户证据。
- 每轮只做一个边界清晰的改进；优先修根因，不做无证据大重构或堆叠 Guard/Retry。新依赖、框架、服务或目录约定须有 ADR/架构说明。
- **CLI 同步**：员工、团队、工作流、插件/Skill、MCP、Runtime 等 CLI 已覆盖能力发生变化时，必须在同一改动中同步对应 CLI 命令、参数、输入校验、输出、`--help`/schema、文档与测试；不得只改 Web/API。无影响的部分无需制造改动，但交付时说明核对结果；CLI 不适用的新能力须说明边界，不能借同步扩权。
- 当前为开发阶段，不维护旧版本数据兼容、迁移或自动备份；只维护一套当前配置协议，废弃输入明确拒绝并同步所有入口。破坏性变更写明重新初始化要求，不借清理擅自重置真实实例；当前运行的冻结事实与真实 Provider 协议适配仍须正确。
- 契约变化先更新 source of truth；遵循注册表 `whenChanged.mustUpdate`，同步注册表、导航地图、局部 README、相关文档、测试及 CHANGELOG。新增源码模块先注册，不留下失效入口。
- CLI 保持渐进帮助、默认可读文本与显式 `--json`；密码仅隐藏交互输入或显式 stdin 管道，不作命令参数。详细规则见 docs/21，不在这里重复命令手册。
- 新增能力交付前须逐项 review 入口、输入输出、关联查询及成功/失败语义；CLI 关联对象按 ID/名称引用，避免嵌套倾倒其他命令可查询的详情。
- 测试、截图、日志、数据库、会话和个人配置不得提交；测试使用隔离数据，绝不清除或改造操作者真实实例、外部项目或全局 CLI 凭据。

## 验证与交付

```bash
npm test
npm run check:ai
npm run check:impact
node --check server/index.mjs
node --check server/store.mjs
node --check server/orchestrator.mjs
node --check web/app.js
git diff --check
```

- 覆盖成功及最可能的失败路径；API 改动查 health 与真实端点，UI 改动实际操作宽窄布局，CLI 改动实际运行对应命令。执行流程改动须跑真实完整任务到人类验收，不能用 Provider 夹具冒充真实模型。
- 未验证、失败或被阻塞必须如实说明；交付报告包含改动、证据、已知限制与后续事项。只有实现、同步和验证齐全才算完成。
- 本仓库是独立客户端，`npm start` 启动 Electron 及其随机端口子服务。验证使用隔离 HOME/数据目录，不占用或重启原仓库的 Web `4310`，不覆盖操作者安装。宿主关闭只管理自己的后台。
- 需要提交时使用格式 `<type>(<scope>): <imperative summary>`，正文含 Intent / Changes / Verification / Risks / History，并运行 `npm run check:commit -- <消息文件>`。提交前检查范围、凭据与无关文件。
- 平台不设置任务级操作权限或角色文件范围；数字员工以本机用户权限依据任务目标执行本地和远程操作。操作结果仍须如实记录，最终任务完成仍由人类确认。
