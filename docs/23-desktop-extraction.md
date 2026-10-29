# 客户端独立仓库决策

状态：实施；来源提交 `dengdai68/AgentForge@c1277e57a715d31ae6d64f15ecb4d7fbecd8ec31`。目标仓库为 `https://github.com/dengdai68/AgentForge-App`。这是源码抽取，不是原仓库的历史镜像。

## 边界与依赖

Electron 当前从自己的本机 HTTP 服务加载页面，界面通过认证 HTTP/SSE 操作领域对象。只复制宿主会缺少任务、沟通、鉴权、执行和插件能力，因此以下代码必须共同维护：

| 目录 | 客户端用途 |
| --- | --- |
| apps/electron | 窗口、菜单栏、宿主确认、登录 shell 环境、CLI 安装和自有后台生命周期 |
| web | 随应用打包的全部页面、组件、图标与样式；名称不表示依赖外部 Web 部署 |
| client | 任务/沟通共用的控制台与协作展示投影 |
| server | 自有 loopback 服务、认证、Store、SQLite、编排、文件、历史 MCP、Runtime 与插件/MCP |
| cli | 面向 AI/操作者的配置与任务命令，经认证 HTTP 连接客户端 |
| scripts / tests | 构建、契约、隔离 UI/API/CLI 与真实模型验收工具及夹具 |
| docs / ai | 当前契约、模块注册表和贡献指引 |

保持既有分层和相对 import，所有 npm 依赖在本仓库锁定；没有到兄弟目录、原工作区、原仓库服务的源码引用、软链或运行时下载。没有新增服务或框架。后续功能在本仓库演进，不要求两个仓库保持代码同步。

## 入口与发布

npm start/dev 是客户端入口。已移除独立服务命令、终端管理员初始化、公开域名配置和独立浏览器产品验收。保留客户端内部的认证 HTTP；子服务要求 IPC 所有者，固定 loopback 主机与随机端口，断开父进程即停止。renderer 始终加载客户端样式。

发布链路使用当前仓库 `github.repository`；下载位于 AgentForge-App 的相同版本标签，package 元信息与锁文件同步。安装包包含宿主、界面、本机服务、CLI 及所需资源，不依赖全局 Node；Claude/Codex 仍由操作者安装授权。

## 身份和数据

保留 `com.agentforge.desktop`、产品名 AgentForge、CLI 名 agentforge 和既有 `~/.agentforge/desktop` 数据位置，以保持当前应用语义。源码开发实例为 `desktop-dev`。两份相同身份的安装版不能作为并行隔离实例，安装或测试不能覆盖活动实例；本轮不修改或迁移操作者数据。任务根继续由设置决定。

## 来源与开源审查

只从来源提交导出受跟踪源码；原 `.git` 不导入，保留新仓库初始提交。排除所有未跟踪/ignored 内容，包括 `.data`、数据库、会话、Token、运行日志、截图、node_modules 和 release。原版本历史保留于 CHANGELOG 以注明功能来源。

本地测试夹具中的占位凭据、合成用户/任务和故障字符串是测试数据；发布前仍须审阅差异和包内文件。本项目由所有者选择 Apache-2.0，完整 LICENSE 与 NOTICE 随源码和应用包分发。依赖许可证见安装后各 npm 包的 LICENSE，已复制的 vscode-icons 保留原 MIT 许可证，不改第三方版权。

Electron Builder 默认不会保留 Electron 分发根目录的许可证，因此 extraResources 显式将锁定 Electron 的 LICENSE 与 LICENSES.chromium.html 原文复制到应用 Resources/licenses/electron/；包验收核对其与安装依赖的字节一致。依赖审计基线有历史告警，抽取不自动升级依赖；具体数量与可达性单独列入交付证据，不将抽取通过表述为安全审计通过。

## 验收

1. 在新克隆独立安装锁定依赖，运行全部单测、契约与语法检查。
2. 隔离运行源码 Electron，验证首次设置、任务、沟通、市场、CLI 与宽窄界面；已有原仓库服务保持原样。
3. 单独构建 DMG/ZIP，验收打包后的首次运行、自有子服务、CLI、任务和人类确认；真实模型验收与受控夹具分开记录。
4. 对照来源提交核对未改业务文件及改动白名单，检查所有发布链接、许可证和开源内容。
5. 完成后由独立 Agent 重新 Review，修复其有效发现；本轮审查记录保存在忽略的验收证据目录，结论在交付中披露。

原仓库保持可运行；不在新项目完成验收前删除原客户端代码。此决策不代表自动发布、安装覆盖或重启现有任务。
