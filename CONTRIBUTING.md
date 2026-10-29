# Contributing

本仓库是 AgentForge 客户端的独立源码，默认 `npm start` 启动 Electron。`web/` 和 `server/` 均是应用的本机组成部分；不要求检出 AgentForge 原仓库。抽取边界见 [docs/23](docs/23-desktop-extraction.md)。测试与包构建使用隔离数据，不覆盖现有安装。

先阅读 [AGENTS.md](AGENTS.md)、[代码导航](docs/00-ai-map.md) 和目标模块的 README。

## 开发流程

1. 确认问题、影响范围和现有测试。
2. 实现改动，同步相关文档与 `ai/module-registry.json`。
3. 运行 `npm test`、`npm run check:ai`、`npm run check:impact` 和 `git diff --check`。
4. UI 改动检查宽窄窗口；API/CLI 改动验证受影响的入口。涉及执行行为时，用隔离数据验证真实流程。
5. 提交 PR，说明行为变化、验证结果及已知限制。

客户端 renderer、Electron、CLI 共享 HTTP 和领域语义。已被 CLI 覆盖的功能变更须同时更新命令、帮助、schema、输出与测试。

测试使用临时目录，不能清理操作者数据、外部项目或全局 CLI 凭据。开发阶段不承诺旧协议兼容；破坏性变更须明确说明，不能自动重置真实实例。

## 提交格式

```text
<type>(<scope>): <summary>

Intent:
Changes:
Verification:
Risks:
History:
```

提交前执行 `npm run check:commit -- <消息文件>`。类型包括 `feat`、`fix`、`perf`、`refactor`、`docs`、`test`、`chore`、`arch`、`security`。

## 发布

版本与锁文件保持一致。macOS 构建使用 `npm run package:mac`，产物位于 `release/`。发布标签与源码提交绑定，上传 DMG、ZIP 和 SHA-256 清单；不得把本机数据或凭据打入安装包。

Release 工作流只在发布成功后删除本次构建输出 ID 对应的 Actions 中转产物；失败时保留最多一天以便重试。正式 Release 附件与 Actions 存储独立，不批量删除其他构建、日志、Git 标签或源码历史。
