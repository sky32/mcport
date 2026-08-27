# Contributing to MCPort

感谢你为 MCPort 贡献代码、文档、测试或问题反馈。

## 开发环境

- Node.js 22.13 或更高版本
- npm
- macOS、Linux 或 Windows

```bash
npm ci
npm run typecheck
npm run build
npm run typecheck:desktop
```

## 提交改动

1. 从 `main` 创建分支。
2. 保持改动聚焦，并更新相关文档和 smoke test。
3. 不要提交 `node_modules`、`dist`、`release`、`.env`、Token、私钥或本地 Workspace 数据。
4. 提交前至少运行受影响模块对应的验证命令；安全、认证、公网和文件导入改动需要补充相关 smoke。
5. Pull Request 请说明改动目的、验证命令和已知限制。

## 项目约定

- Runtime 与 Desktop 的职责边界不能混淆。
- 文件和 cwd 必须保持在 Workspace 内。
- 命令使用 executable + args[]，禁止任意 shell 字符串。
- 不要降低 Workspace containment、OAuth、PKCE、Token、SSRF 或网络隔离安全策略。
- Renderer 不使用 Node integration。
- 不要把密钥、真实 Workspace 路径或生产数据放进测试和日志。

## Pull Request 检查清单

- [ ] 改动范围和兼容性影响已说明
- [ ] 已运行实际相关验证命令
- [ ] 新增行为有测试或 smoke 覆盖
- [ ] 文档已同步
- [ ] 没有提交敏感信息或构建产物
