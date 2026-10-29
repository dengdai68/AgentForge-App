# 员工历史查询

打包版 Bridge 的命令是客户端内置 Electron，MCP env 包含 ELECTRON_RUN_AS_NODE=1。Codex 适配器完整转发该 Bridge 自有 env，并设置 required=true；缺失/无法初始化会真实失败，不能只在提示词写「已注册」后忽略故障。Codex 本身不继承 Node 模式；不用全局 Node、不改操作者配置。安装包测试实际握手并调用八工具目录及已存随机记录，真实模型验收另需显式运行。

历史工具目录、连接、身份绑定说明、schema 和分页由 MCP tools/list 与服务 instructions 提供，不再在应用系统指令重复列工具名和参数；应用只保留简短核对行为规则。平台不重放历史，快照只证明平台系统/当前输入，不包含 Provider 自动生成的技能/工具目录。

数字员工自动获得平台历史查询能力，可读取已保存的私聊、群聊、任务、Trace 和交付；无需手工添加平台 MCP。调用身份用于归属记录，当前历史查询不按员工身份隔离已保存数据。

## 实现

- `server/history/index.mjs`：只读投影和派生 SQLite 索引。
- `bridge.mjs`：调用级 Unix socket 与私有 MCP 配置。
- `mcp.mjs`：stdio 协议适配。

派生索引不是领域权威数据。每次查询根据 Store 修正变更与删除；分页先筛选元数据，再读取有限条正文。首次建立或协调索引仍需扫描内存元数据，不承诺大规模负载 SLA。

## 读取规则

列表每页 1–100 条，文本/Artifact 读取每次 1–16000 字符，使用游标继续。稳定记录 ID 可用于来源追溯。Artifact 按冻结 SHA-256 与字节验证，损坏或缺失返回明确错误。

派发提示词快照不进入历史工具；控制台通过单独的 Trace 快照接口查看。私有凭据与原始 Provider 诊断不进入查询。

每次调用在系统临时目录创建私有 socket/config，结束后清理。打包使用 Electron 内置 Node，避免依赖系统 Node；不会把管理员会话交给员工。

测试见 `tests/history.test.mjs`；真实模型专项入口为 `scripts/test-history-e2e.mjs`。
