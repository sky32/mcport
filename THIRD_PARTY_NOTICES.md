# Third-party notices

MCPort 使用开源依赖构建 Runtime 和 Desktop。完整依赖树及其版本记录在 `package-lock.json`；各依赖包随包发布的许可证文件是最终许可依据。

## 运行时下载的语言服务器

以下组件由用户在 Desktop 设置中主动选择安装，不随 MCPort 安装包分发：

| 组件 | 用途 | 来源/说明 |
| --- | --- | --- |
| TypeScript Language Server / TypeScript | TypeScript、JavaScript | npm registry；遵守各自 npm 包许可证 |
| vscode-langservers-extracted | HTML、CSS、JSON | npm registry；遵守上游项目许可证 |
| Pyright | Python | npm registry；遵守上游项目许可证 |
| yaml-language-server | YAML | npm registry；遵守上游项目许可证 |
| Intelephense | PHP | npm registry；使用前请确认其许可和商业条款，MCPort 不再分发其文件 |
| gopls | Go | Go 工具链 / 官方模块来源 |
| rust-analyzer | Rust | rustup 官方组件来源 |
| Marksman | Markdown | Homebrew 或上游发布渠道 |
| jdtls | Java | Homebrew 或 Eclipse 官方分发 |
| clangd / LLVM | C、C++ | Homebrew 或系统/上游 LLVM 分发 |

安装、更新和使用这些组件时，用户需要遵守对应项目、包管理器和发行渠道的许可证、商标和网络使用条款。MCPort 不对第三方语言服务器的功能、版本兼容性或许可授予作额外保证。

## Electron 与 npm 依赖

Electron、Model Context Protocol SDK、Zod、OIDC Provider、Tree-sitter WASM、Undici、Jose 等依赖的许可证随 npm 安装目录中的许可证文件提供。发布二进制前应使用当前 lockfile 生成依赖清单，并复核新增依赖的许可证兼容性。
