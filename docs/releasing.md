# 发布指南

## 发布前检查

1. 更新 `package.json` 版本号。
2. 更新 `CHANGELOG.md`。
3. 确认 `npm ci`、Runtime/Desktop 类型检查、构建和核心 smoke 全部通过。
4. 确认 README、许可证和第三方 LSP 说明与本次版本一致。
5. 确认没有 Token、私钥、`.env`、Workspace 数据或构建产物进入提交。

## GitHub Release

推送 `v` 开头的 tag 后，`.github/workflows/release.yml` 会在 Linux、macOS Intel（x64）DMG、macOS Apple Silicon（arm64）DMG、Windows x64、Windows arm64 构建桌面产物，生成 `SHA256SUMS.txt`，并创建 GitHub Release。

Desktop 的“应用设置 → 软件更新”会读取 `package.json` 的 `appUpdate.githubRepository`，访问该仓库的 GitHub Releases API，比较当前版本和最新 Release，并按当前平台打开对应安装包；找不到唯一匹配的安装包时打开 Release 页面。仓库地址必须填写为 `owner/repository`，也可以在诊断启动时用 `MCPORT_GITHUB_REPOSITORY` 临时覆盖。

当前更新流程不会在后台替换正在运行的 App。正式启用自动安装前，需先完成 macOS/Windows 签名、公证和可回滚的更新策略；未签名产物直接自更新容易被系统拦截并造成启动失败。检查失败、仓库未配置、Release 不存在和 GitHub 限流都会在界面中明确显示，不会伪造“已是最新”。

```bash
git tag v0.1.0
git push origin v0.1.0
```

当前 Release 使用未签名 macOS DMG。由于没有 Apple Developer 证书，用户首次打开时需要手动移除下载隔离属性；DMG 中不能自动运行脚本绕过 macOS 安全检查。

安装步骤：将 `MCPort.app` 拖入 `/Applications`，然后在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/MCPort.app"
```

仅对从可信 Release 下载并通过 SHA256 校验的文件执行此操作。以后如果配置 Apple Developer 签名和公证，便可以移除这一步。

未配置签名时，macOS Gatekeeper 和 Windows SmartScreen 可能显示安全警告。不要把证书、私钥、Apple 密码或 token 写进仓库或 workflow 文件。

## 手工构建

```bash
npm run desktop:linux
npm run desktop:mac:x64
npm run desktop:mac:arm64
npm run desktop:win
npm run desktop:win:arm64
```

## 第三方 LSP

LSP 由用户在 Desktop 中按语言选择安装，不随 MCPort 安装包分发。发布说明应记录本版本支持的安装策略和已知兼容性；用户仍需遵守各语言服务器及其包管理器的许可证和使用条款。
