# 历史查询

Bridge 的 env 是历史 MCP 自己的启动环境，Codex 必须全部转发；打包版的 ELECTRON_RUN_AS_NODE 不得遗漏，也不能泄漏到 Provider 环境。required=true 将历史初始化失败交回原有执行错误链。提示词里的能力说明不是工具就绪证据，验收必须实际调用。

Bridge 仅保留简短的历史核对行为规则；工具名、连接说明和分页参数不再重复注入应用系统指令，而由 MCP tools/list 的描述/schema 及服务 instructions 提供。原生注册后回调保存平台脱敏分层快照，不包含 Provider 自动生成的技能目录和工具定义。历史不重放，需要过去资料时按需查询。

`index.mjs` 提供 Store 历史投影和派生 SQLite 索引；`bridge.mjs` 管理调用级 socket/config；`mcp.mjs` 适配 stdio MCP。

当前全部数字员工可查询平台保存的历史，身份用于调用归属。查询只读，索引可重建，Store 是权威。分页先筛选紧凑元数据，再加载有限正文；协调仍包含内存扫描。

Artifact 按冻结信息验证。派发提示词快照及私有凭据不进入历史工具。临时目录 0700、配置 0600，调用结束清理；强杀可能留下无监听者的临时文件。

契约和范围见 [历史查询](../../docs/19-agent-history.md)。
