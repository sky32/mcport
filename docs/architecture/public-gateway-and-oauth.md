# 公网接入与 OAuth

## 公网地址

公网 Gateway 复用 Runtime 默认监听：请求的 Host 头不是 loopback 时进入 Gateway 模式，Workspace 通过路径区分：

    https://mcp.example.com/w/<workspace>/mcp

每条路由是独立的服务条目（`gateway:<workspace>`）：独立认证配置、独立工具档位、Workspace allowlist 限定为该 Workspace。未知路由返回 404。这种方式便于用一个固定域名同时管理多个项目的访问权限。

Gateway 路径下的健康检查为 `/w/<workspace>/healthz`。

## 公网通道

支持四种方式：

- **Cloudflare Tunnel**：`cloudflared tunnel run`，Token 从安全存储读取并经环境变量注入，适合固定域名与长期使用
- **TryCloudflare Quick Tunnel**：`cloudflared tunnel --url http://127.0.0.1:<port>`，无需账号、域名或 Token；Desktop 从输出中提取随机 `*.trycloudflare.com` 地址后重载 Runtime 的公网 Host/Issuer/audience。地址属于临时运行时状态，重启后变化。用户目录存在 `.cloudflared/config.yml` 时拒绝启动，避免与正式 Tunnel 混用
- **FRP Client**：Desktop 生成 TOML 配置（TLS 强制、token 加密存储、http 类型 subdomain 代理），进程退出时删除配置文件
- **外部自建**：Desktop 不启动进程，只按配置的公网 Host 生成地址

`cloudflared` 和 `frpc` 可由 Desktop 托管安装：从 GitHub Releases 下载，强制校验 SHA256（无 digest 拒绝安装），支持固定版本与回滚。Tunnel 崩溃后 Desktop 按指数退避自动恢复（TryCloudflare 的瞬时网络错误前两次快速重试）；预检失败（客户端未安装/版本不匹配）不自动重试。

## JSON-only 传输模式

TryCloudflare 不支持 SSE，该模式下 Desktop 将公网 Gateway 切到 JSON-only：

- 2026-07-28 及之后的 modern 请求使用 `responseMode=json`
- 2025 系列请求每次 POST 走无会话的 StreamableHTTP JSON response
- legacy 客户端的 GET SSE 请求得到 JSON `405`，`subscriptions/listen` 以 JSON-RPC 错误明确拒绝
- 普通 `initialize`、`tools/list`、`tools/call` 正常工作，成功的 MCP POST 不返回 `text/event-stream`

## OAuth

每个公网 Workspace 使用独立的 OAuth Issuer（`https://<host>/w/<workspace>`）、独立的 ES256 P-256 签名密钥和授权口令，互不共享。客户端连接时先读取 protected-resource 和 authorization-server 发现文档，再打开授权页完成授权。

端点布局（`/w/<ws>` 为 Issuer 基路径）：

- 授权：`/w/<ws>/oauth/authorize`，consent 页 `/w/<ws>/oauth/interaction/:uid`
- 令牌：`/w/<ws>/oauth/token`；公钥：`/w/<ws>/oauth/jwks`
- 客户端注册：`/w/<ws>/oauth/register`（开放 DCR，支持 CIMD draft-02）
- 发现：`/.well-known/oauth-authorization-server/w/<ws>` 与 `/w/<ws>/.well-known/openid-configuration`

协议要点：PKCE 强制（S256）；授权码 5 分钟、access token 15 分钟（ES256 JWT，audience 绑定 resource 地址）；refresh token 30 天且每次使用轮换；授权只授予唯一 resource indicator。

授权页由 Runtime 渲染（跟随系统明暗模式），展示客户端名、注册方式、回调、resource 和按工具档位伸缩的权限清单，需输入 Desktop 显示的授权口令。Desktop 同时轮询 Runtime 的待处理授权请求，弹出原生对话框提示并可一键复制授权口令。

限流（超限返回 429 + Retry-After）：授权尝试 20 次/5 分钟、错误口令 5 次/5 分钟、客户端注册 20 次/10 分钟且每个 Workspace 最多 256 个客户端。

撤销与轮换：Desktop 的“撤销全部授权”会删除该 Issuer 的全部 OAuth 记录、轮换签名密钥并重启 Runtime，旧 access token 因签名验证失败全部失效；“重新生成授权密钥”只影响新授权。凭据变更通过重启 Runtime 生效。

## Bearer Token

不支持 OAuth 的客户端可以使用 Workspace Bearer Token（`publicAuthMode=token`）。Token 为 32 字节随机值、安全存储，重新生成后旧 Token 立即失效。缺失或无效的 Token 得到 `401` 与 `WWW-Authenticate: Bearer` challenge；OAuth 模式下 challenge 附带 `resource_metadata` 指向发现文档。

## 多项目访问

公网 Host 可以同时提供多个项目，但每个项目仍独立进行公开开关、工具档位和认证管理。
