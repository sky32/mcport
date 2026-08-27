# 设置与数据

## Desktop 保存什么

Desktop 在用户数据目录（Electron `userData`）保存项目注册信息、界面偏好、连接方式和诊断所需的状态。项目原目录仍由你管理，不会因为注册而被复制或移动。

| 文件/目录 | 内容 |
| --- | --- |
| `desktop-settings.json` | 全部 Desktop 设置（含 Workspace 列表）；版本不匹配或损坏时自动备份并重置为默认值 |
| `desktop-secrets.json` | 全局与各 Workspace 的 Token/授权密钥/签名私钥/Tunnel Token，值经 `safeStorage` 加密 |
| `desktop-save-journal.json` | 保存中断恢复日志（保存前写入，成功后删除） |
| `runtime/state.db` | Runtime SQLite：全局 Runtime 设置、Runtime Profile 与 Workspace 绑定、OAuth 记录 |
| `runtime/*.tasks.sqlite`、`*.operations.sqlite`、`*.code-index.sqlite` | 任务、操作记录和代码索引的独立数据库 |
| `runtime/checkpoints/` | Workspace 恢复检查点（按 Workspace 路径哈希分区） |
| `runtime/tool-traces.ndjson` | 调试模式下的工具 Trace 与统计 |
| `runtime/frpc.generated.toml` | FRP 生成的运行时配置（进程退出时删除） |
| `managed-tools/` | 托管安装的 `cloudflared`/`frpc` 各版本 |

所有 JSON 写入都是原子写（临时文件 + rename）。全局保存走三段式日志：先把三份状态的前值写入 journal，成功后删除；启动时发现残留 journal 会整体回滚。Workspace 设置保存先快照前值，任何失败（设置、密钥、SQLite Profile 或 Runtime 重启）都会同步回滚。所有保存与 Runtime 变更经过串行队列，并发保存不会交错；无实际变化的保存不会重启 Runtime。

## 敏感信息

OAuth 授权密钥、OAuth 签名私钥、Bearer Token、Tunnel Token 和 FRP Token 使用系统提供的安全存储（`safeStorage`）加密。它们不会作为普通设置展示，也不出现在日志中；工具 Trace 会脱敏敏感参数。

## 设置分工

- Desktop 设置（JSON）：端口、本地认证、公网通道、代理、语言、主题、托盘/自启
- Runtime 设置（SQLite `settings` 表）：PATH、允许命令、命令执行开关、外部网络、高风险确认、LSP、超时与大小限额
- Workspace Runtime Profile（SQLite `workspace_runtime_profiles` 表）：单 Workspace 覆盖项，字段为 null 时继承全局

全局“运行环境”设置页写全局 Runtime 设置；Workspace 高级设置写 Profile。

## Runtime 生命周期

Runtime 由 Desktop 以 Electron `utilityProcess` 托管启动，通过进程内 IPC 控制面（健康检查、工具目录、本地确认、OAuth 交互轮询）通信，不额外开放管理端口。崩溃后按指数退避自动重启（上限 30 秒）；网关端口优先使用固定的 47877，被占用时自动顺延，Workspace 端口从 8788 起分配。凭据或档位变更通过重启 Runtime 生效。

## 移除项目

从 Desktop 移除项目空间会删除注册关系、该 Workspace 的 API Token、OAuth 授权密钥与签名密钥，不会删除项目目录、Git 历史或项目文件。

## 诊断

日志按来源（Runtime/Tunnel/Desktop）采集（环形缓冲 300 行）；调试模式（off/basic/detailed）开启后显示调试页（工具统计与调用明细）并记录 MCP HTTP trace。展示内容会避开敏感凭据。
