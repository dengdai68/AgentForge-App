# 认证与登录态

二进制写入唯一例外为认证 POST `/api/communications/chat_<ID>/attachments` 的 `application/octet-stream`，仍要求精确 Host、同源 Origin 和管理员会话，单文件最多 20 MiB；其他写路由不接受该类型。下载、控制台、执行正文与提示词仍先校验资源归属，再验证文件完整性，不允许匿名或跨域上传。

## 实例

客户端首次启动在应用内设置管理员，没有默认密码或公开注册。服务要求客户端 IPC 与一次性 bootstrap 信息；不提供终端管理员初始化。

HTTP 页面、API、静态脚本、SSE 与文件预览经过统一认证。公开入口限登录资源、健康检查和受限的首次设置状态。

## 持久会话

密码使用 scrypt 加盐摘要，随机会话 token 仅保存 SHA-256 摘要。新会话默认不因时间过期，API 的 `expiresAt=null`。浏览器使用 HttpOnly、SameSite=Strict 持久 Cookie，400 天并随认证请求续存。退出、重置账户或清除数据撤销会话。

CLI 保存独立私有会话，不读取浏览器 Cookie 或 SQLite，不保存密码。CLI 和浏览器目前不共享同一个登录态。

## HTTP 边界

写请求要求精确同源 Origin 与 JSON。服务只监听 127.0.0.1 随机端口，仅接受实际绑定的 origin；不读取公开域名、HOST 或 PORT 部署配置。登录限流持久化，不信任代理转发的客户端 IP。

SSE 在事件和心跳时检查会话。退出登录不等于终止任务。

## 首次设置与重置

Electron 自有子服务尚无管理员时，主进程以一次性私有 bootstrap token 换取短时 setup 会话；token 不写 URL、页面、日志或 Provider 环境。已有管理员不能重复使用该入口。

数据清除要求当前密码和准确确认文字；仅清理当前实例，保留外部项目及本机 CLI 凭据。此操作与普通退出不同。

主要接口：`GET /api/auth/session`、`POST /api/auth/login`、`POST /api/auth/logout`。配置路径见 [Electron](18-electron-client.md) 和 [CLI](21-configuration-cli.md)。
