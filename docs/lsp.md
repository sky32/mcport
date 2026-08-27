# LSP 语言服务器说明

`lsp_query` 与 quick validation 的 LSP 阶段由 Runtime 的语言服务器管理器（`src/lsp.ts`）提供。TypeScript、HTML、CSS 服务器通过 Desktop 设置按需下载到用户数据目录，不再打进应用安装包。

## 支持的语言与默认服务器

| 语言 | 文件扩展名 | 默认服务器 | 内置 |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` `.mts` `.cts` | `typescript-language-server --stdio` | 按需下载 |
| HTML | `.html` `.htm` | `vscode-html-language-server --stdio` | 按需下载 |
| CSS / SCSS / LESS | `.css` `.scss` `.less` | `vscode-css-language-server --stdio` | 按需下载 |
| Python | `.py` `.pyi` | `pyright-langserver --stdio` | 否 |
| JSON | `.json` `.jsonc` | `vscode-json-language-server --stdio` | 否 |
| YAML | `.yaml` `.yml` | `yaml-language-server --stdio` | 否 |
| Markdown | `.md` `.markdown` | `marksman server` | 否 |
| Go | `.go` | `gopls serve` | 否 |
| Rust | `.rs` | `rust-analyzer` | 否 |
| Java | `.java` | `jdtls` | 否 |
| C | `.c` `.h` | `clangd --stdio` | 否 |
| C++ | `.cc` `.cp` `.cpp` `.cxx` `.hpp` `.hh` `.hxx` | `clangd --stdio` | 否 |
| PHP | `.php` | `intelephense --stdio` | 否 |

其他扩展名的文件没有配置语言服务器，`lsp_query` 会直接报错。

## 启用开关

- `lspEnabled`（默认开启）：Desktop “设置 → 运行环境” 中的 LSP 开关，写入全局 Runtime 设置。关闭时所有语言报 `LSP disabled by runtime policy`，`validate_changes` 跳过 LSP 阶段（不计为失败）。
- `lspRequestTimeoutMs`（默认 8000ms，有效范围 250–60000）：单次 LSP 请求超时。
- `lspTypeScriptCommand` / `lspHtmlCommand` / `lspCssCommand`：仅 TypeScript、HTML、CSS 三个语言的启动命令可覆盖（其余语言使用固定默认命令）。环境变量对应 `LSP_TYPESCRIPT_COMMAND` / `LSP_HTML_COMMAND` / `LSP_CSS_COMMAND`。

## 服务器解析顺序

对每种语言，按以下顺序找到第一个可执行文件（`resolveLspExecutable`）：

1. **配置的绝对路径**（configured-path）：覆盖命令是绝对路径且可执行
2. **配置的相对路径**（configured-path）：覆盖命令含 `/` 或 `\` 时，相对 Workspace 根解析
3. **Workspace 本地**（workspace）：`<workspace>/node_modules/.bin/<命令>`
4. **Desktop 管理的 LSP**（managed）：从设置下载的 TypeScript、HTML、CSS 默认服务器位于用户数据目录，以 embedded-node 方式启动。覆盖命令不是默认命令名时不使用该入口
5. **Runtime PATH**（runtime-path）：按 Runtime PATH 逐目录查找

都找不到时该语言不可用。因此 Python、Go、Rust 等语言需要 Workspace 安装了对应服务器（如 devDependencies 里的 pyright）或系统 PATH 中可用。

## 如何安装

在 Desktop“设置 → 运行环境 → LSP”中，每种语言都有独立的“下载/更新”按钮。npm 型服务器安装到对应的用户数据目录；Go、Rust、Java、C/C++、Markdown 使用本机工具链或包管理器。安装包本身不包含这些依赖。新增或更新 LSP 后，应让 AI 重新调用 `server_info`，获取当前 Workspace 动态支持的语言类型和可用状态。

**方式一：Workspace 本地安装**（npm 分发的服务器，推荐写进项目 devDependencies，命中 `node_modules/.bin` 解析）：

| 语言 | 安装 |
| --- | --- |
| Python | `npm i -D pyright`（提供 `pyright-langserver`） |
| JSON | `npm i -D vscode-langservers-extracted`（提供 `vscode-json-language-server`） |
| YAML | `npm i -D yaml-language-server` |
| PHP | `npm i -D intelephense` |

**方式二：系统安装**（进入 Runtime PATH；默认 PATH 已包含 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin`、`~/.volta/bin`，其余目录在 Desktop“设置 → 运行环境”的 PATH 中补充）：

| 语言 | 安装示例 |
| --- | --- |
| Go | `go install golang.org/x/tools/gopls@latest`（Windows、Linux、macOS 均支持；用户级安装目录会自动探测） |
| Rust | `rustup component add rust-analyzer`（Windows、Linux、macOS 均支持；用户级安装目录会自动探测） |
| C / C++ | Windows：`winget` 安装 LLVM；Linux：`sudo apt-get install clangd`；macOS：`brew install llvm` |
| Java | Linux：`sudo apt-get install jdtls`；macOS：`brew install jdtls`；Windows 请自行安装 `jdtls` 后加入 Runtime PATH |
| Markdown | Windows：`winget` 安装 Marksman；Linux：`sudo apt-get install marksman`；macOS：`brew install marksman` |

注意服务器名是固定的：必须安装上表对应的实现（例如 Python 只认 `pyright-langserver`，安装 `python-lsp-server`/`pylsp` 不会被识别）。需要接入未列出的语言时，在“设置 → 运行环境 → 高级：添加自定义 LSP”中填写定义。

## 自定义冷门 LSP

在“高级：添加自定义 LSP”中按行填写即可扩展语言，不需要修改 Runtime。`languageId` 同时作为唯一标识，例如 Lua：

```json
[{"extensions":[".lua"],"languageId":"lua","command":"lua-language-server","args":["--stdio"]}]
```

自定义命令必须是纯可执行文件名，服务器需要位于 Workspace 的 `node_modules/.bin` 或 Runtime PATH；不接受路径和 shell 字符串。

## TypeScript 运行时选择

`typescript-language-server` 还需要一个 `tsserver` 运行时，选择逻辑（`resolveTypeScriptServerOptions`）：

1. Workspace 安装了 `node_modules/typescript` 且主版本 ≤ 6、`tsserver` 健康检查通过（`tsserver.js`、`lib.d.ts`、`lib.es5.d.ts`、`lib.es2015.d.ts`、`lib.esnext.d.ts` 五个文件齐全）→ 使用 Workspace 版本（workspace-compatible）
2. 否则使用 Desktop 管理的 TypeScript 运行时；Workspace 版本 > 6 时记录为 managed

管理运行时未安装或文件缺失时 TypeScript 整体不可用，并明确列出缺失文件——在 Desktop 设置中重新安装可恢复。

## 会话与网络隔离

- 会话按（Workspace 根, 语言）懒创建：首次查询该语言时启动服务器进程，后续复用；查询出错时终止并移除会话；Checkpoint 恢复等场景会重置该 Workspace 的全部会话
- 查询前 Runtime 把文件内容同步给服务器（didOpen/didChange），因此结果基于磁盘上的最新内容
- 未允许外部网络时，语言服务器进程与命令执行使用同样的网络隔离：macOS 用 `sandbox-exec`（仅放行 localhost），Linux 依次尝试 bwrap（`--unshare-net`）和 `unshare`；都不可用且策略要求隔离时直接报错。子进程环境同时注入指向 `127.0.0.1:9` 的黑洞代理变量
- 文件必须位于 Workspace 内、是普通文件且不超过 `maxFileBytes`（默认 2MiB）

## 支持的操作

`operation` 取值：`diagnostics`、`hover`、`definition`、`source_definition`、`references`、`document_symbols`。

- `diagnostics` 优先使用拉取式 `textDocument/diagnostic`，服务器不支持时等待推送诊断（最多约 1 秒）
- `source_definition` 仅 TypeScript/JavaScript 支持，通过 `workspace/executeCommand` 调用 `_typescript.goToSourceDefinition`，用于跳过 import alias 定位真实源码定义；其他语言调用会直接报错

## 不可用时的行为

- `lsp_query` 对不可用语言返回明确错误，不会伪造语义结果；错误信息会提示从 Desktop 设置安装受管理服务器，或配置显式命令
- `check_exec_environment` 与 `server_info` 返回每语言的 `available`、`source`（解析来源）、`launchMode`、`unavailableReason` 与 TypeScript 运行时选择详情（结果缓存 30 秒）
- 语言服务器不可用不影响 tree-sitter 代码索引：`repo_map`、`code_search`、`read_symbol`、`find_references` 仍可用于 TS/JS（见 [tools.md](tools.md)）

## 与 quick validation 的关系

`validate_changes(mode="quick")` 的 LSP 阶段只诊断变更文件中扩展名匹配 `.[cm]?[jt]sx?|html?|css|scss|less` 的文件，且最多取前 12 个（超出的记入 remainingRisks）；某一文件的语言服务器不可用时跳过该文件并计入 `lspUnavailableCount`，不视为验证失败。
