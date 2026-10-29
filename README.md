# AgentForge App

本项目采用 [Apache-2.0](LICENSE)，第三方资源保留各自许可证，见 [NOTICE](NOTICE)。

AgentForge 是本机 AI 团队操作系统：配置数字员工、插件和 MCP，组成团队并选择工作流，让 Claude Code / Codex 协作完成开发、企业知识整理和内容生产，产出真实文件，最终由人类确认交付。

这是从 [AgentForge](https://github.com/dengdai68/AgentForge) 独立拆出的客户端项目。Electron 宿主、完整界面、本机服务、SQLite、Runtime、CLI 和测试均在本仓库，运行与构建不依赖原仓库。拆分来源、目录边界见 [拆分说明](docs/23-desktop-extraction.md)。

## 安装

从本仓库的 [Releases](https://github.com/dengdai68/AgentForge-App/releases) 下载 DMG，将 AgentForge 拖入 Applications。当前支持 macOS 13+ / Apple Silicon；安装包采用 ad-hoc 签名，尚未经过 Apple 公证。首次发布完成前 Releases 可能为空。

使用前安装并登录 Claude Code 或 Codex CLI。安装包自带本机服务和 Node 运行能力，无需额外安装服务器。首次打开在应用内创建管理员，随后在设置中配置 Runtime、工作目录和扩展。任务完成须在界面明确确认。

## 从源码运行

需要 Node.js 22.12+（推荐 Node 24）、npm、Git，以及支持当前参数的 Claude Code / Codex CLI。图形客户端目前以 macOS 为验收平台。

```bash
git clone https://github.com/dengdai68/AgentForge-App.git
cd AgentForge-App
npm ci
npm start
```

`npm start` 和 `npm run dev` 均启动桌面客户端。客户端自动启动独立 loopback 子服务，使用系统分配的端口；不依赖或复用 4310，也不需要先运行 `auth:setup`。`web/` 是随应用打包的界面源码。

安装版数据在 `~/.agentforge/desktop/`，源码开发版在 `~/.agentforge/desktop-dev/`；任务工作目录默认 `~/agentforge`，可在设置中修改。继续使用现有 AgentForge 应用身份和数据位置，两份安装版不会被当成两个隔离实例；测试必须使用独立 HOME/数据目录。

## CLI

在「设置 → 命令行 CLI」安装用户级命令后：

```bash
agentforge auth login --username admin
agentforge teams list
agentforge tasks create --help
```

源码也可执行 `npm run cli -- help`。CLI 连接运行中的客户端，用于员工、团队、工作流、插件、MCP、Runtime 及任务操作；帮助逐级展开，完整契约见 [CLI 指南](docs/21-configuration-cli.md)。

## 开发与打包

```bash
npm test
npm run check:ai
npm run check:impact
npm run desktop:check
npm run package:mac
npm run package:mac:check
```

安装包位于 `release/`。贡献说明见 [CONTRIBUTING](CONTRIBUTING.md)、[AGENTS](AGENTS.md) 和 [文档索引](docs/README.md)。GitHub Actions 在本仓库独立检查和构建，发布使用本仓库的标签与附件。

`npm run start:server` / `dev:server` 是本机服务诊断入口，沿用独立服务的认证初始化与数据隔离；普通客户端使用者无需执行这些命令。

数字员工以当前系统用户权限执行本机操作。当前是本机单管理员 Beta，Runtime bypass 不等于沙箱；运行中的任务依赖本机服务，不具备云端高可用或多租户能力。
