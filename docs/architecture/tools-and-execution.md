# 工具与权限

MCPort 的工具围绕项目开发流程组织，让只读、修改、快速验证和命令执行保持独立的权限边界。完整工具目录见 [docs/tools.md](../tools.md)。

## 工具目录与档位

工具在服务启动时按档位条件注册：`readonly` 档暴露 23 个读工具，`standard` 增加 9 个写工具，`full` 再增加 3 个命令会话工具，共 35 个。`tools/list` 因此与档位天然一致，该一致性由 `src/tool-tier-smoke.ts` 固定断言。每个工具带 MCP annotations（readonly/safeWrite/write/execution/taskWrite），并注册进 Tool Catalog（含跨档位合并的 `tiers[]`），供 admin API 和 Desktop 调试页使用。

工具暴露只由档位决定。历史上存在过的 Tool Surface Profile（core/advanced/full）配置已删除，不再有任何独立的“模型可见面”维度。

## 项目引导

每个 Workspace 的客户端会话在第一次读取项目内容、修改文件或执行命令前调用一次 `workspace_onboarding`。后续工作复用已有引导；仅在 Workspace/规则范围变化或已有上下文丢失时重新调用。

`workspace_onboarding` 返回 `guidanceFingerprint`。传回 `knownFingerprint` 且规则未变化时，会得到轻量的 `unchanged: true` 响应。

`server_info` 用于查询 Workspace、工具档位、Runtime 策略、索引和端点能力；`check_exec_environment` 用于查询执行策略和 LSP 就绪状态。两者都不要求作为固定第一步。

## 查看项目与理解代码

- 文件工具（stat/read/list/search/view_image）有界执行：默认忽略构建产物目录、2MiB 文件上限、UTF-8 字节输出预算、结果分页
- 读取文件内容时直接复用 `read_file.sha256`；只有不读取内容而仅需要元数据/哈希时才调用 `stat_file`
- tree-sitter 代码索引只覆盖 TypeScript/TSX/JavaScript/JSX/MJS/CJS：`repo_map`、`code_search`、`read_symbol`、`find_references`、`impact_analysis`、`project_graph` 的符号级智能仅对这些语言可用；索引存放在独立的 SQLite 数据库并随文件监听/变更标记增量更新
- `lsp_query` 覆盖 13 种语言；服务器启用条件、解析顺序、TypeScript 运行时选择与不可用行为见 [LSP 语言服务器说明](../lsp.md)

## Git 与历史

- `git_status` / `git_diff` / `git_history` 严格只读，通过内部可信命令执行（不占用 MCP 允许列表，也不开放任意命令）
- `git_diff` 支持 mutation 作用域：用 patch 前基线精确比对一次修改
- 项目历史由 AI 明确调用 `project_history_*` 记录，按内容哈希幂等去重，存放在外部 Runtime State

## 修改项目

- `apply_patch` 是事务性结构化补丁：基线快照 + 失败回滚、`expectedSha256` 前置校验、dryRun 预览；成功返回 `mutationId`（30 分钟有效）、`changeSummary` 与结构化 `nextActions`
- `copy_file` 二进制安全复制 Workspace 内文件，复制前自动建恢复检查点
- `import_file` 仅支持 Host 文件参数（`_meta["openai/fileParams"]` 声明的 `sourceFile`）：HTTPS-only、DNS 全公网校验（SSRF/DNS 重绑定防护）、重定向限制、大小上限与 SHA256 校验，落盘前建恢复检查点
- Checkpoint 保存在 MCPort 外部 Runtime State（按 Workspace 路径哈希分区，保留最近 50 个，单次上限 64MiB）；不向用户项目写入运行时元数据目录

## 变更验证

`validate_changes(mode="quick")` 属于 standard 能力：tree-sitter 语法检查（≤200 文件）+ 有界 LSP diagnostics（仅 Web 类文件、最多 12 个），不启动项目命令。

`validate_changes(mode="full")` 在此基础上运行命令 stage：Node 项目按 `packageManager` 执行 typecheck/lint/build/test 脚本，Python 项目按 pyproject 执行 mypy/ruff/pytest；每个 stage 限时 180 秒。full 模式要求 full 档且命令执行已开启，否则返回结构化 blocked policy（`full-validation-requires-command-execution`）和 quick `nextAction`。

变更按三层分类：expected（命中任务 `expectedPaths`）、knownExternal（命中任务基线或已确认路径）、unexpected（其余）。MCP 响应默认只返回计数，Workspace 级文件名需显式 `includeWorkspaceFiles=true`。

## 任务与 Completion Gate

`task_create` 记录 Git branch/HEAD/diffHash 基线和任务前脏文件指纹；每个 Workspace 同时只有一个活动任务。验收条件分 manual（模型用 `satisfyCriterionIds` 满足）和 command（completion gate 重跑命令验证）两类。

`task_update(status="completed")` 触发 completion gate，四个守卫：验收条件全过、最新验证 pass 且 diffHash 未过期、无 unexpected 文件、任务 Git 上下文未漂移（branch/HEAD/基线脏文件变化会判定 drifted，'unknown' 不阻塞）。守卫失败返回结构化 `blockingReasons`，任务保持活动。

`workspace_context` 聚合能力、活动任务、review 证据、最近验证和推荐 nextAction，是多步骤工作的统一入口。`operation_read` 统一读取 command/mutation/validation 三类持久化操作（`view=recovery` 默认隐藏已成功的短命令）。

## 命令执行

full 档可以运行允许列表中的命令。执行链：风险评估 → 授权 → （高风险时）预置恢复检查点 → spawn。

- 命令以 executable + args 传入，`shell: false`；允许列表精确匹配命令名，禁止路径形式
- 默认允许 46 个开发命令，不含任何 shell 程序
- 超时默认 30s（上限 600s）、输出 256KiB、并发会话上限 100
- 禁止外部网络时按 OS 施加网络隔离（macOS `sandbox-exec`、Linux bwrap/unshare；工具不可用且策略要求时拒绝执行）
- 会话控制（write/read/status/kill）支持 stdin、按字节分页的输出读取和终止；`sessionId` 与 `operationId` 同值
- `npx --version` 等仅查询自身的调用视为低风险；一旦指定 package，按依赖变更高风险处理

## 风险与授权（Authority Engine）

风险评估与执行许可分离：

- `assessCommandRisk` 分类：依赖变更（npm/pip/cargo 等安装升级）、破坏性命令（reset --hard、clean、checkout --force 等）、网络访问（clone/fetch/push、curl 等）；任一命中即为 high
- 授权顺序：网络类且禁止外部网络 → deny；非 high 或确认模式 none → allow；high 且需要确认但 Desktop 确认通道未配置 → deny；否则请求本地确认 → confirm
- 本地确认由 Desktop 轮询并弹原生对话框（60 秒超时视为拒绝）；执行前自动对锁文件或整个 Workspace 建恢复检查点

## 操作恢复

长时间命令操作持久化在独立的 SQLite 中。Runtime 重启后，遗留的 `queued/running` 操作变为 `outcome_unknown`，不能直接重试或当作失败：

1. `operation_recovery(action=reobserve)` 记录当前可见状态（进程存活不会被判为成功）
2. 核对 Workspace、日志等外部证据后，`operation_recovery(action=reconcile)` 凭明确理由裁决为 succeeded/failed/cancelled（高风险，需本地确认）

命令会话状态机：`queued/running/succeeded/failed/cancelled/timeout/outcome_unknown`。

## 可观测性

- 输出预算：`maxTokens` 按 UTF-8 字节计（默认 4000，256–64000），分页返回 `nextCursor`，超预算返回结构化 blocked 信息
- 循环检测：连续重复相同调用、重复失败或验证停滞时，向工具结果附加 advisory `loopWarning`（不拦截）
- 工具 Trace：调试模式下按 ndjson 记录每次调用（阶段耗时、状态、参数脱敏、2MiB 轮转），并维护按工具/变体聚合的统计，供 Desktop 调试页展示
