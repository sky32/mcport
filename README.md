<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="resources/MCPort-Logo-Dark.png">
    <source media="(prefers-color-scheme: light)" srcset="resources/MCPort-Logo-Light.png">
    <img src="resources/MCPort-Logo-Light.png" alt="MCPort" width="360">
  </picture>
</p>

<p align="center">把本机项目安全地连接到支持 MCP 的 AI 客户端。</p>

# MCPort

MCPort 是一个本地优先的 MCP 工具。它让 AI 客户端能够在你明确选择的项目目录中读取代码、搜索文件、理解符号、查看 Git、修改文件，并在授权后执行受控命令。

项目文件、运行状态和凭据默认留在本机。你可以只使用本地 MCP，也可以为指定 Workspace 开启 OAuth 或 Bearer Token 公网访问。

## 适合做什么

- 让 AI 阅读和搜索项目文件、代码、图片及目录
- 提供代码索引、定义跳转、引用查找、Hover 和文档符号
- 查看 Git 状态、差异、提交记录和 blame
- 在 Workspace 内创建、修改、复制、移动和删除文件
- 通过任务、Checkpoint 和验证流程跟踪修改结果
- 在权限允许时执行受控开发命令
- 将一个或多个 Workspace 连接到本地或公网 MCP 客户端
- 按需安装和更新常见语言的 LSP，冷门语言可手动扩展

## 三分钟开始

### 从源码运行

需要 Node.js 22.13 或更高版本：

```bash
npm install
npm run desktop
```

1. 打开 MCPort，在“项目”中添加你的项目目录。
2. 确认 Workspace 的 MCP 开关已开启。
3. 在项目卡片中复制本地 MCP 地址。
4. 把地址添加到 AI 客户端，然后开始协作。

默认本地地址是：

```text
http://127.0.0.1:47877/mcp
```

如果只注册了一个 Workspace，客户端通常可以直接使用该 Workspace 的专用地址，不需要额外传入 `workspace` 参数。

## 连接方式

### 本地连接

本地访问默认只接受 loopback 请求，并且默认不要求 Token。若在全局设置中启用了 Bearer Token，客户端必须携带对应凭据。

### 公网连接

在“设置 → 连接与公网”中选择 Cloudflare Tunnel、TryCloudflare、FRP Client 或外部自建通道。公网访问按 Workspace 单独配置，支持：

- OAuth（推荐，支持 PKCE 和 Workspace 绑定）
- Bearer Token

公网地址使用 `/w/<workspace>/mcp` 路由，例如：

```text
https://mcp.example.com/w/my-project/mcp
```

TryCloudflare 适合临时测试，会生成临时 `trycloudflare.com` 地址；重启后地址可能变化，并使用 JSON-only 传输。

## 文件和代码能力

MCPort 只允许在选定 Workspace 内操作文件，并会在真实路径和符号链接解析后再次检查边界。基础代码索引当前支持 TypeScript、TSX、JavaScript、JSX、MJS 和 CJS。

语言智能通过独立 LSP 提供，支持 TypeScript/JavaScript、HTML、CSS/SCSS/LESS、Python、JSON、YAML、Markdown、Go、Rust、Java、C、C++ 和 PHP。LSP 在设置中按语言独立下载和更新，不会把所有语言服务器塞进安装包。

新增或更新 LSP 后，请让 AI 重新调用 `server_info`，获取当前 Workspace 最新的 LSP 支持类型和状态。

## 权限档位

每个 Workspace 可以单独选择工具权限：

- `readonly`：查看项目、搜索、代码理解、Git 只读和历史查询
- `standard`：增加文件修改、导入、Checkpoint、任务和快速验证
- `full`：增加受控命令、命令会话、操作恢复和完整验证

命令执行仍受全局开关、精确命令白名单、超时、输出大小和高风险确认控制。命令以 executable + args 数组执行，不使用任意 shell 字符串。

## 安全边界

- Workspace 文件操作经过 realpath 和符号链接边界检查
- 文件修改支持 SHA256 前置校验、事务回滚和外部 Checkpoint
- 公网 Workspace 不支持无认证访问
- OAuth、Bearer Token 和 Tunnel 凭据使用系统安全存储
- 日志和 Tool Trace 会脱敏 Token、密码、授权口令和私钥
- Runtime 以当前登录用户运行；命令白名单不是操作系统级沙箱
- 关闭外部网络时，Runtime 会按操作系统尝试施加网络隔离

## 应用更新

设置 → 应用 → 软件更新可以检查 GitHub Release，并按当前平台打开对应安装包下载。更新源配置在 `package.json`：

```json
{
  "appUpdate": {
    "githubRepository": "owner/repository"
  }
}
```

## 常见问题

### 公网连接失败

在设置中先确认公网 Host、Workspace 公网开关、公网客户端和认证方式。连接检查会区分本地 Runtime、Tunnel、Gateway 路由和认证问题；`404` 通常表示 Host 或 Workspace 路径没有映射到本地 Gateway。

### 工具显示“未暴露”

这表示工具存在，但当前 Workspace 的工具权限档位没有将它暴露给对应连接。它不是文件丢失，也不代表 MCP 服务没有启动。

### LSP 安装后仍不可用

先确认安装结果中确实找到可执行文件，再让 AI 重新调用 `server_info`。如果使用自定义 LSP，确认命令名可被 Runtime PATH 找到，并检查该语言服务器自己的启动参数。

### 命令无法执行

确认 Workspace 使用 `full` 档、全局命令执行已开启、命令名称在允许列表中，且高风险操作已完成 MCPort 本地确认。

## 文档

- [Desktop 使用指南](docs/desktop-app.md)
- [AI 客户端使用指南](docs/ai-usage.md)
- [MCP 工具目录](docs/tools.md)
- [LSP 语言服务器说明](docs/lsp.md)
- [安全说明](docs/security.md)
- [公网接入与 OAuth](docs/architecture/public-gateway-and-oauth.md)
- [工具与权限](docs/architecture/tools-and-execution.md)
- [设置与数据](docs/architecture/desktop-and-persistence.md)
- [发布指南](docs/releasing.md)

## 开源协作

MCPort 由 Sky 维护，采用 MIT License。欢迎提交 Issue 和 Pull Request。贡献流程、安全漏洞报告、行为准则、隐私说明和第三方许可见：

- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [行为准则](CODE_OF_CONDUCT.md)
- [隐私说明](docs/privacy.md)
- [第三方许可说明](THIRD_PARTY_NOTICES.md)

第三方 LSP 按用户选择从各自生态的官方包管理器或发布渠道安装，不随 MCPort 安装包分发；使用时请遵守对应项目的许可证和条款。

## 开发验证

```bash
npm run typecheck
npm run build
npm run typecheck:desktop
npm run smoke:desktop
npm run smoke:gateway
npm run smoke:oauth:builtin
```

不同功能的专项验证命令见 [AGENTS.md](AGENTS.md) 和 `package.json`。
