# MCP 工具目录

MCPort 默认注册 35 个工具，按 Workspace 的工具范围（tier）条件注册：界面中的“查看工具”对应 `readonly`（23 个），“编辑工具”对应 `standard`（32 个），“开发工具”对应 `full`（35 个）。开启 Computer Use 后，允许使用它的“开发工具”连接增加 1 个工具。实际可用工具始终以当前连接返回的 `tools/list` 为准；需要确认能力时可调用 `server_info`。

当端点只暴露一个 Workspace 时（单 Workspace 服务、公网 Gateway 路由），工具 schema 不含 `workspace` 参数；多 Workspace 端点必须显式传入。

所有分页/大结果工具共享输出预算机制：`maxTokens` 按 UTF-8 字节计（默认 4000，范围 256–64000），超预算时返回 `truncated`/`nextCursor`，单条结果超预算时返回 `blockedByBudget` 与 `minimumRequiredBytes`。

## 连接与项目引导

| 工具 | tier | 用途 |
| --- | --- | --- |
| server_info | readonly | 查看端点身份、Workspace、工具档位、Runtime 策略、索引状态和传输能力；`detail=full` 增加 source Git 信息。只在能力不明确时调用 |
| workspace_context | readonly | 多步骤工作入口：聚合 Workspace 能力、活动任务、review 证据、最近验证结果，并给出推荐 nextAction |
| operation_read | readonly | 读取持久化的 command/mutation/validation 操作记录；`action=get` 按 operationId 查单条，`action=list` 按 Workspace 列摘要（`view=recovery` 默认隐藏已成功的短命令） |
| workspace_onboarding | readonly | 每个 Workspace 客户端会话首次工作前读取项目规则文件；支持 `knownFingerprint` 去重 |
| check_exec_environment | readonly | 查看命令执行策略、网络隔离、限额和 LSP 就绪状态 |

`workspace_onboarding` 的发现范围包括根/嵌套的 `AGENTS.md`、`.CLAUDE.md`、`README.md`、`.cursor/rules/**`、`.github/copilot-instructions.md`、`skills/**/SKILL.md` 和 `.agents/skills/**/SKILL.md`，按优先级排序返回。规则未变化时传回 `guidanceFingerprint` 会得到 `unchanged: true` 的轻量响应。

## 查看项目

| 工具 | tier | 用途 |
| --- | --- | --- |
| stat_file | readonly | 不读取内容时查看文件类型、大小、mtime、符号链接和 SHA256 |
| read_file | readonly | 有界 UTF-8 文本读取（行范围 + 字节预算），返回可供后续修改复用的 `sha256`、`totalLines`、`nextStartLine`；拒绝二进制和超过 `maxFileBytes`（默认 2MiB）的文件 |
| list_dir | readonly | 浏览目录（浅层或递归，`maxDepth` 默认 4 上限 20，`limit` 默认 500 上限 5000，不跟符号链接） |
| search_files | readonly | 递归文件名/glob 搜索（多 pattern 并集，`maxResults` 默认 100） |
| search_text | readonly | 目录或单文件的文本/正则搜索，支持 glob 范围和上下文行（`contextLines` 0–5） |
| view_image | readonly | 查看 PNG/JPEG/GIF/WEBP 图片（base64 返回） |

默认忽略 `.git`、`node_modules`、`vendor`、`dist`、`dist-desktop`、`release`、`build`、`.next`、`.venv`、`venv`、`.remote-workspace-mcp` 等目录。

## 理解代码

| 工具 | tier | 用途 |
| --- | --- | --- |
| repo_map | readonly | 项目符号地图（按文件聚合，支持 focus 文件/符号加权） |
| code_search | readonly | 已知标识符优先的搜索（`mode=auto` 时标识符样式查询先查符号库，再回退文本） |
| read_symbol | readonly | 读取单个符号及上下文（`context=signature\|minimal\|dependencies\|editable\|full`） |
| find_references | readonly | 单个已索引符号的 incoming/outgoing 引用 |
| impact_analysis | readonly | 修改共享/公共 API 前的影响分析（callers、references、relatedTests、riskLevel） |
| project_graph | readonly | 跨模块/文件/符号依赖拓扑（`level=module\|file\|symbol`，仅解析相对 import） |
| lsp_query | readonly | LSP 查询：`operation=diagnostics\|hover\|definition\|source_definition\|references\|document_symbols` |

前六个工具基于 tree-sitter 代码索引，默认索引 TypeScript/TSX/JavaScript/JSX/MJS/CJS、Python、Go、Rust、Java、C/C++ 和 PHP 文件；索引语言会按 Workspace 实际文件动态出现。JSON/YAML/Markdown/Dockerfile/Shell 等格式仍使用文件/文本工具。`lsp_query` 覆盖 16 种语言，服务器启用与解析逻辑见 [LSP 语言服务器说明](lsp.md)：服务器从 Desktop 设置按需下载，其余按“配置路径 → Workspace `node_modules/.bin` → Desktop 管理目录 → Runtime PATH”顺序解析，未安装时明确报告 unavailable，不会伪造语义结果。`source_definition` 仅 TypeScript 支持。

## Git（严格只读）

| 工具 | tier | 用途 |
| --- | --- | --- |
| git_status | readonly | 分支、ahead/behind 与工作区变更 |
| git_diff | readonly | 查看差异（`mode=summary\|semantic\|patch`；semantic 会把 hunk 映射到符号）；可用 `mutationId` 限定到一次修改并与 patch 前基线精确比对 |
| git_history | readonly | `action=log\|show\|blame` 查看提交记录、提交内容或行级来源 |

这些工具不会自动提交、推送或重置项目；提交必须由用户明确要求并经 `exec_command` 执行。

## 项目历史与 Checkpoint（读）

| 工具 | tier | 用途 |
| --- | --- | --- |
| project_history_read | readonly | `action=search\|read\|verify` 搜索、分页读取或校验 AI 维护的项目历史归档 |
| checkpoint_read | readonly | `action=list\|read` 查看 Workspace 恢复检查点 |

项目历史由 AI 明确调用时记录，不在后台保存完整对话。

## 修改项目（standard 起）

| 工具 | tier | 用途 |
| --- | --- | --- |
| change_apply_and_validate | standard | 高层工作流：一个结构化 patch + 立即同 scope 验证，分别记录 mutation 与 validation 操作；不会自动完成任务 |
| apply_patch | standard | 首选结构化文本修改：`operations` 1–100 条（`write`/`replace`/`delete`/`move`/`mkdir`），支持 `dryRun` 预览和 `expectedSha256` 前置校验 |
| copy_file | standard | 二进制安全复制 Workspace 内文件（`COPYFILE_EXCL` 防意外覆盖，复制前自动建恢复检查点） |
| import_file | standard | 通过 MCP Host 授权的临时文件引用导入外部文件（见下） |
| checkpoint_write | standard | `action=create`（paths ≤100，保留最近 50 个）/`restore`（恢复前自动建 pre-restore 检查点） |
| project_history_write | standard | `action=open\|checkpoint` 记录或续写项目历史；相同内容哈希幂等去重 |

成功 mutation 返回 `mutationId`（scope 有效期 30 分钟）、`changeSummary` 和结构化 `nextActions`（定向 quick validation + semantic diff）。

`apply_patch` 是事务性的：先对全部受影响路径取基线快照，同一 envelope 内后序操作看到前序的虚拟结果，执行失败时按快照回滚（先删后建，保留文件 mode）。`replace` 要求唯一匹配，否则需 `replaceAll`；`delete` 拒绝非空目录；`move` 仅支持文件。

Checkpoint 快照保存在 MCPort 外部 Runtime State（按 Workspace 路径哈希分区；若 State 目录落在 Workspace 内部则回退到用户目录），不在用户项目中创建运行时元数据目录。单检查点总量上限 64MiB。

`import_file` 仅接受顶级 `sourceFile` 文件参数：工具通过 `_meta["openai/fileParams"]` 声明该字段，Host 在调用时提供包含临时 `download_url` 与 `file_id` 的授权文件引用。Runtime 立即下载并校验后落盘，文件内容不经过模型上下文。下载约束：仅 HTTPS、仅 443、无凭据、DNS 解析结果必须全部为公网地址（防 SSRF 与 DNS 重绑定）、重定向最多 5 次且不得离开附件域、30 秒超时、`maxBytes` 默认 50MiB 上限 100MiB、支持 `expectedSha256` 校验。没有 Base64 兜底通道。

## 任务与验证（standard 起）

| 工具 | tier | 用途 |
| --- | --- | --- |
| task_create | standard | 创建带验收条件的持久任务（记录 Git branch/HEAD/diffHash 基线）；每个 Workspace 同时只有一个活动任务 |
| task_update | standard | 更新任务（`status=completed` 触发 completion gate）；外部文件变化用 `acknowledgeExternalPaths + reason` 确认 |
| validate_changes | standard（full 模式需 full 档） | 修改后验证；`mode=quick` 做语法检查 + 有界 LSP diagnostics，`mode=full` 再运行允许的 typecheck/lint/tests/build |

验收条件分两类：manual criterion 由模型用 `satisfyCriterionIds` 满足；command criterion 由 completion gate 重跑命令验证（返回 `verified/failed` 和 `lastVerification`）。

`validate_changes(mode="quick")` 不需要开发工具范围。`mode="full"` 只有 full 档可用；否则返回 `full-validation-requires-command-execution` blocked policy 和可直接执行的 quick `nextAction`。full 模式的命令 stage：Node 项目按 `packageManager` 选择 npm/pnpm/yarn/bun 运行 `typecheck`/`lint`/`build`/`test` 脚本；Python 项目按 pyproject 配置运行 mypy/ruff/pytest。每个 stage 限时 `min(maxTimeout, 180s)`。

变更按三层分类：`expectedTaskChanges`（命中 `expectedPaths` 前缀）、`knownExternalChanges`（命中任务基线变更集或已确认路径）、`unexpectedChanges`（其余）。默认 `detail=summary` 只返回计数；`includeWorkspaceFiles=true` 才展开 Workspace 级文件名。

Completion gate 有四个守卫：验收条件全部通过、最近一次验证 pass 且 diffHash 未过期（VALIDATION_STALE_OR_FAILED）、无 unexpected 文件（UNEXPECTED_FILES）、任务 Git 上下文未漂移（TASK_CONTEXT_DRIFT）。任一失败返回结构化 `blockingReasons`，任务保持活动。

## 命令会话（full 档）

| 工具 | tier | 用途 |
| --- | --- | --- |
| exec_command | full | 运行允许列表内命令（executable + args，`cwd` 必须在 Workspace 内；`waitMs` 默认 10s；`outputMode=summary\|errors\|tail\|stream\|full`） |
| session_control | full | `action=write\|read\|status\|kill` 控制命令会话（stdin 写入、输出按字节分页读取、终止） |
| operation_recovery | full | 恢复 `outcome_unknown` 的命令操作：先 `action=reobserve` 记录观察，再 `action=reconcile` 凭理由裁决为 succeeded/failed/cancelled |

命令必须在允许列表中（精确命令名，默认 46 个），受超时（默认 30s/上限 600s）、输出上限（256KiB）和并发会话上限（100）约束。`sessionId` 与 `operationId` 指向同一执行身份，分别显式返回。

Runtime 重启后，原先 `queued/running` 的操作会变为 `outcome_unknown`：不能直接重试或当作失败。`reobserve` 记录当前可见状态（PID 存在不会被判为成功）；核对 Workspace、日志等外部证据后，才能用带理由的 `reconcile` 裁决。`reconcile` 属高风险操作，需要 Desktop 本地确认。

## Computer Use（full 档，可选）

| 工具 | tier | 用途 |
| --- | --- | --- |
| computer_use | full | `status` 检查桌面能力，`screenshot` 获取屏幕，或执行 `move` / `click` / `drag` / `type` / `key` / `scroll` |

Computer Use 默认关闭，开启后默认只在本地 MCP 服务注册。用户还可以单独允许公网使用；此时只有已认证且工具范围为“开发工具”（`full`）的 `/w/<workspace>/mcp` 路由会暴露。它不依赖本机命令开关；除 `status` 外，每次调用默认等待 Desktop 本地确认。Workspace 选择“完全静默”后可免确认；“静默确认”仍会确认 Computer Use。鼠标坐标使用截图响应中的 `coordinateWidth` / `coordinateHeight`，不能直接使用缩放后图片的像素尺寸。

## 高风险操作与本地确认

高风险命令（依赖变更、破坏性 Git 操作、网络访问）、文件覆盖/删除和 Checkpoint 恢复统一经过 Authority Engine：

- `allow`：策略允许，直接执行
- `confirm`：策略要求确认，等待 Desktop 弹出的原生对话框批准（默认 60 秒超时，超时视为拒绝）
- `deny`：Workspace 网络或确认策略拒绝

执行依赖变更命令前会自动对锁文件建恢复检查点；破坏性 Git 命令会对整个 Workspace 建检查点。
