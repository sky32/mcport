# 安全说明

MCPort 的安全目标是：让 AI 能够协助项目开发，同时把文件、命令和公网访问限制在你明确选择的范围内。

## 项目目录边界

文件工具只访问选定的项目目录。所有路径先做 realpath 解析再做容器检查，目录遍历、指向 Workspace 外部的符号链接和越界路径会被拒绝。命令的 `cwd` 同样必须落在 Workspace 内。移除项目空间不会删除原目录。

文本修改是事务性的：`apply_patch` 先对受影响路径取基线快照，失败时自动回滚；`expectedSha256` 前置校验防止覆盖已经变化的文件。

## 工具范围与操作限制

项目有 readonly、standard 和 full 三档，在界面中分别显示为“查看工具”“编辑工具”和“开发工具”。这三档只决定 `tools/list` 向 AI 提供哪些工具，不代表所有工具都可以无条件执行。

- 查看工具：浏览、搜索和状态检查，不能修改文件
- 编辑工具：增加文件与目录修改能力，不提供命令入口
- 开发工具：增加命令与进程入口，并允许执行白名单内的命令；同时受联网策略和高风险确认约束

操作限制只会收紧已提供工具的能力，不会增加工具。选择“开发工具”即允许命令和进程执行，但命令仍必须通过白名单；外部网络开关同时约束受管命令和语言服务器。Computer Use 是独立能力：需要选择“开发工具”；高风险确认分为“需要确认”“静默确认”和“完全静默”。

命令必须通过允许列表：精确命令名匹配，禁止路径形式（含 `/` 或 `\` 的命令名直接拒绝）。默认允许列表包含 46 个常见开发命令（node、npm、git、python、cargo、go 等），不包含 `bash`、`sh`、`zsh` 或 PowerShell。命令以 executable + args[] 执行，不经过 shell。

命令受默认超时 30 秒（上限 600 秒）、单流输出上限 256KiB 和最多 100 个并发会话约束。

## 网络隔离

默认禁止命令访问外部网络。启用隔离时按操作系统施加：

- macOS：`sandbox-exec` 策略，仅放行 localhost
- Linux：bubblewrap（`--unshare-net`）或 `unshare`
- 隔离工具都不可用且策略要求隔离时，命令直接拒绝执行

`import_file` 的附件下载是唯一的外部下载通道：仅 HTTPS、仅 443 端口、禁止 URL 凭据、DNS 解析结果必须全部为公网地址（防 SSRF 和 DNS 重绑定）、重定向不得离开附件域、强制大小上限和可选 SHA256 校验。

## 高风险确认

高风险操作经过 Authority Engine 评估：

- 依赖变更类命令（npm/pip/cargo 等安装、升级）执行前自动对锁文件建恢复检查点
- 破坏性 Git 命令（reset --hard、clean、checkout --force 等）对整个 Workspace 建检查点
- 文件覆盖/删除和 Checkpoint 恢复需要确认
- Computer Use 默认使用“需要确认”；选择“静默确认”时普通高风险操作不弹窗，但 Computer Use 仍需确认；选择“完全静默”后，截图和鼠标键盘操作也会直接执行

确认模式为 local 时，Desktop 弹出原生对话框等待批准（默认 60 秒超时，超时视为拒绝）；确认模式为 none 时高风险操作直接放行但会附说明；网络类命令在禁止外部网络时直接拒绝。

## 公网访问

公网 Workspace 必须启用 OAuth 或 Bearer Token，没有匿名公网访问。每个 Workspace 拥有独立的认证配置、公网开关和工具档位。

内置 OAuth 的安全属性：

- PKCE 强制开启（S256）
- 授权码模式，access token 为 ES256 签名的 JWT，audience 绑定到该 Workspace 的 resource 地址（resource indicator）
- 授权口令以 scrypt 哈希存储，只在 Desktop 中显示
- refresh token 每次使用轮换；access token 有效期 15 分钟，refresh token 30 天
- 每条公网路由独立的签名密钥；撤销授权 = 删除该 Workspace 的 OAuth 记录 + 轮换签名密钥 + 重启 Runtime
- 授权端点限流：授权尝试 20 次/5 分钟、错误口令 5 次/5 分钟、客户端注册 20 次/10 分钟且每个 Workspace 最多 256 个客户端，超限返回 429
- 授权页带 CSP nonce，`frame-ancestors 'none'`；转发头会被强制覆写为规范 issuer，防止中间层毒化

## 凭据与日志

OAuth 授权口令、签名私钥、Bearer Token、Tunnel Token 和 FRP Token 使用系统安全存储（Electron `safeStorage`）加密保存。普通界面和日志不会展示完整密钥、Token 或授权码；工具 Trace 记录会脱敏敏感参数。

请避免把凭据放进命令参数、项目文件、截图或调试日志中。

## 需要你注意的边界

命令执行不是操作系统沙箱。允许执行的程序仍以当前登录用户的权限运行，因此只应开启自己信任的命令和 Workspace。

公网 Host、DNS、TLS、Tunnel 服务和客户端权限仍由使用者负责配置和维护。

模型可能重复失败或停滞；Runtime 会附加 advisory 循环警告提示模型调整策略，但不会替你终止会话。

Computer Use 默认关闭，开启后默认仅在本地“开发工具”（`full`）连接中注册。用户可以单独允许公网暴露，但只有已认证且选择“开发工具”的 Workspace 路由会看到该工具。Computer Use 不依赖本机命令开关；默认使用“需要确认”，选择“完全静默”后才会关闭确认。Desktop 持有系统屏幕录制和辅助功能权限，Runtime 只能通过受类型约束的 IPC 请求单次动作，不能直接取得系统权限。
