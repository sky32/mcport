# 隐私说明

## 当前行为

MCPort 是本地优先的开发工具。项目文件、Runtime 状态、Desktop 设置、OAuth 数据和凭据默认保存在用户本机，不会因为普通使用自动上传到 MCPort 服务器。

MCPort 不在后台记录聊天内容，也不建立默认的产品分析或广告追踪。工具 Trace 和运行日志用于本机诊断，可能包含工具名称、耗时、结果摘要和脱敏后的参数；请不要把真实密钥放入命令参数、项目文件或调试日志。

## 用户主动发起的网络访问

以下行为会产生用户主动选择的网络访问：

- Cloudflare、TryCloudflare 或 FRP Tunnel
- 公网 MCP 请求和内置 OAuth 流程
- Desktop 中下载 LSP 或 Tunnel 二进制
- `import_file` 对符合安全策略的 HTTPS 附件下载
- Runtime 中明确允许的外部网络命令

这些访问可能经过对应的第三方服务，其数据处理受第三方隐私政策约束。

## 凭据

OAuth 私钥、Bearer Token、Tunnel Token 和 FRP Token 使用 Electron `safeStorage` 保存。请保护操作系统账户，不要把凭据提交到 Git、Issue、日志或截图中。

## Workspace 数据

Workspace 内容只有在用户连接的 MCP 客户端调用相应工具、或用户主动开启公网访问时才会被读取或传输。公网 Workspace 必须启用 OAuth 或 Bearer Token；用户应只暴露信任的目录和工具档位。

Computer Use 默认关闭且默认不在公网路由暴露。用户可以通过独立开关允许已认证的公网 `full` 档客户端调用。用户逐次批准的屏幕截图会返回给发起调用的 MCP 客户端，因此可能包含 Workspace 之外的窗口、通知或凭据；使用前应关闭无关敏感窗口。MCPort 不在后台保存这些截图。

## 变更

隐私行为发生实质变化时，会在 CHANGELOG 和 Release Notes 中说明。问题或疑虑请通过仓库的 Issue（非敏感问题）或 Security Advisory（敏感问题）反馈。
