# 产品结构说明

MCPort 由三部分组成：

- Desktop（Electron）：管理 Workspace 注册、Runtime 生命周期（utilityProcess 托管）、公网通道、托管二进制、代理、凭据安全存储、托盘和 UI
- Workspace MCP Runtime（Node）：单进程多监听，提供 MCP 传输、工具目录、Workspace 安全、命令执行、Git、任务/验证和 SQLite 运行时状态
- 公网 Gateway：Runtime 默认监听上的非 loopback Host 路由（`/w/<workspace>/...`），把选定 Workspace 提供给公网 AI 客户端，认证方式为内置 OAuth 或 Bearer Token

## 典型使用路径

项目目录 → Desktop 注册 Workspace → 选择本地或公网地址 → AI 客户端授权 → 使用项目工具。

## 进程与端口

Desktop 启动的 Runtime 默认监听 `127.0.0.1:47877`（被占用时自动顺延）；每个启用的 Workspace 另有独立本地端点，从 8788 起分配。公网流量经 Tunnel 转发到默认监听，按路径路由到对应 Workspace。

相关说明：

- [项目空间与本地访问](runtime-and-workspaces.md)
- [公网接入与 OAuth](public-gateway-and-oauth.md)
- [工具与权限](tools-and-execution.md)
- [设置与数据](desktop-and-persistence.md)
