# 共享展示投影

`console-projections.mjs` 将已认证读模型转为任务状态、员工执行状态、协作记录、工具分组、Shell 和 Diff 展示数据。

纯函数不访问 DOM、网络、文件、数据库或 Runtime，不发领域命令。Web 和 Electron 使用同一投影；HTTP 始终负责认证。测试见 `tests/client-projections.test.mjs`。

`isRoutineConsoleEvent` 在 `buildConsoleEntries` 中隐藏无正文的常规状态通知（开始/保存、普通会话连接、空 Provider 进度和诊断占位），不删除源事件。正文引用、工具、错误、重试、会话重建、恢复与未知记录仍保留；原始分页边界不按可见条数重算。任务和沟通共用此规则，CLI/API/日志不变。

任务审计的精确 Provider 类型前缀在识别通知前归一；无正文的 trace.accepted 同属常规确认，不重复回显交接保存状态。

本次提示词完整展示已脱敏系统层和本轮输入。工具阶段按 Trace + 原生调用 ID 合并，不把重复阶段计为多次调用；不同 ID 的真实调用保留。空 tool_progress 摘要隐藏，真实工具/正文引用仍保留。

协作投影的 `tone` / `statusCode` 仅供界面按真实消息/投递状态配色；CLI 不输出视觉元数据，原有文本/JSON 契约不变。

`toolCommandSummary` 提取已脱敏 Shell 命令或 Read/Write 文件路径；`toolFileInput` 提取完整 JSON 中的文件路径与写入文本，无法解析不猜测。
