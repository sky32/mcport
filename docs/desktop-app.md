# Desktop 使用指南

Desktop 是 MCPort 的主要操作入口，负责管理项目目录、连接方式、公网通道、凭据和运行状态。Runtime 的工具执行、Workspace 安全和运行时数据由 Runtime 负责。

Desktop 界面有四个页面：项目空间、设置、日志和调试。调试页默认隐藏，只有在“设置 → 应用”中把调试模式设为 basic 或 detailed 后才显示。侧边栏常驻公网通道、连接健康和响应延迟三张状态卡。

## 项目空间

在“项目空间”中可以：

- 添加已有项目目录（名称由目录名推导；同名冲突时自动加哈希后缀）
- 更换 Workspace 对应的本机目录
- 启用或停用某个 Workspace
- 开启或关闭公网 MCP
- 查看本地、公网和认证状态（“检查连接”重新探测当前可达性）
- 复制本地或公网 MCP 地址
- 复制当前 Workspace 的 OAuth 授权密钥或 Bearer Token
- 移除项目注册

移除项目空间只会取消注册并清除该 Workspace 的 Token、OAuth 授权密钥和签名密钥，不会删除原项目目录。项目目录不会被复制或移动。

每个 Workspace 的内联设置面板包含三部分：

- **MCP 校验与公网**：本地端点状态与重新校验；启用公网 MCP 开关
- **认证**：OAuth 模式下复制 MCP 地址/授权密钥，可重新生成授权密钥或撤销全部授权；Token 模式下复制 MCP 地址/Bearer Token，可重新生成或手动设置自定义 Token；折叠区显示协议细节（Issuer、Scope、客户端注册方式、Token 算法与 Refresh 轮换）
- **高级设置**：公网路径与认证方式选择；工具权限档位（readonly/standard/full）与安全状态摘要；运行环境覆盖（允许本机命令、允许外部网络、高风险确认方式 local/none、PATH、命令白名单、默认/最大超时、最大输出）

连接检查只负责报告当前可达性，不代替 OAuth 授权或工具权限验证。

## 设置

设置页分三个标签。

### 连接与公网

- **公网接入方式**：Cloudflare Tunnel、TryCloudflare、FRP Client 或外部自建
- **客户端模式**：managed（由 Desktop 托管安装）或 custom（自定义二进制路径）
- **客户端版本管理**：查看当前/最新版本，安装指定版本或回滚到上一版本
- **Cloudflare**：Tunnel Token（安全存储）
- **FRP**：Server 地址、端口、Token、Subdomain
- **公网连接拓扑**：本地网关与公网地址的连通检查
- **本地 MCP**：认证方式（本机免 Token 或 Bearer Token + Token 生成）
- **网络代理**：模式 off/system/manual、代理地址、绕过列表、测试代理

### 运行环境

全局默认值：PATH、允许执行的命令列表（含恢复默认按钮）、缺少强网络隔离时拒绝执行、LSP 开关与请求超时（可覆盖 TS/HTML/CSS 服务器命令）、默认/最大命令超时、最大文件字节数、最大命令输出字节数。

### 应用

界面语言（跟随系统/中文/英文）、外观（跟随系统/浅色/深色）、调试模式（off/basic/detailed）、开机自启、Runtime 启动后自动启动公网客户端、关闭窗口时后台运行、后台低内存模式。

正式使用建议使用固定 Host。TryCloudflare 的 URL 只在当前运行周期有效，重启后变化，不适合长期配置；若用户目录下存在 `.cloudflared/config.yml`，Desktop 会拒绝启动 Quick Tunnel，避免与本机正式 Tunnel 配置混用。

## 公网接入

- **Cloudflare Tunnel**：适合已有 Cloudflare Tunnel、固定域名和稳定入口。token 经环境变量注入 `cloudflared tunnel run`。
- **TryCloudflare**：无需账号、域名和 Tunnel Token，启动后从 `cloudflared` 输出提取随机 `*.trycloudflare.com` 地址并重载 Runtime。该模式使用 JSON-only 公网 Gateway（不支持 SSE）。
- **FRP Client**：Desktop 生成 `frpc` 配置（token 加密存储，TLS 强制开启），通过 subdomain 映射到本机网关。
- **外部自建**：不启动任何进程，由用户自行维护公网转发。

`cloudflared` 和 `frpc` 的托管安装从 GitHub Releases 下载，强制校验 SHA256（Release 未提供 digest 时拒绝安装），支持版本固定、回滚；安装目录在用户数据目录的 `managed-tools/` 下。Tunnel 客户端不会自动获得 Runtime 的命令权限。

OAuth 是公网认证的默认推荐方式。客户端添加 MCP 地址后，会先访问 protected-resource 和 authorization-server metadata，再打开浏览器完成授权；Runtime 渲染授权页时，Desktop 会弹出原生对话框提示，并提供“复制授权密钥”按钮。授权完成后，客户端必须在 MCP 请求中携带 Bearer access token。

Bearer Token 适合无法完成 OAuth 的客户端。重新生成后旧 Token 立即失效，Desktop 会重启 Runtime 加载新凭据。撤销全部 OAuth 授权会删除该 Workspace 的 OAuth 记录、轮换签名密钥并重启 Runtime，已签发的 access token 全部失效。

## 日志与诊断

“日志”页面按来源（Runtime/Tunnel/Desktop）过滤展示最近的输出（环形缓冲 300 行），可复制或清空。“调试”页面在调试模式开启后提供工具统计（按工具聚合的调用次数、耗时、失败与变体）和调用明细（每次工具调用的阶段耗时与脱敏后的参数）。

公网连接检查的错误归类：

- `401`：认证缺失、无效或过期
- `404`：公网 Host 或路径未映射到本机网关
- `502/503/504`：反向代理无法连接到本机网关
- `530`：Cloudflare 侧 Tunnel/DNS 异常

日志和工具 Trace 不会显示 Token、授权码、私钥或 Tunnel 密钥；Trace 记录中的敏感参数会被替换为 `[REDACTED]`，大段文本内容替换为长度与哈希摘要。

## 后台运行与托盘

启用“关闭窗口时后台运行”后，关闭窗口会最小化到托盘；同时启用“后台低内存模式”时会销毁渲染进程释放内存，Runtime 和 Tunnel 继续运行，从托盘可重新打开窗口。托盘菜单提供显示窗口、启动/停止公网客户端和退出。

## 相关文档

- [AI 客户端使用指南](ai-usage.md)
- [公网接入与 OAuth](architecture/public-gateway-and-oauth.md)
- [工具与权限](architecture/tools-and-execution.md)
- [设置与数据](architecture/desktop-and-persistence.md)
