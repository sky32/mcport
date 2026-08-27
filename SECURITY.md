# Security Policy

## 支持的版本

安全修复优先支持 `main` 分支和最新 GitHub Release。旧版本是否修复取决于问题影响和维护成本。

## 报告漏洞

请不要通过公开 Issue 报告未修复的安全漏洞。优先使用 GitHub 仓库的 **Security → Report a vulnerability** 创建私密报告；如果仓库尚未启用该功能，请联系维护者后再提供细节。

报告中请包含：

- 受影响的版本、操作系统和运行方式
- 可复现步骤或最小化示例
- 潜在影响和攻击前置条件
- 可能的修复建议（如果有）

请先删除 Token、OAuth 私钥、Tunnel 凭据、真实 Workspace 路径和其他个人数据。

我们会尽快确认收到报告，并在修复完成后通过 GitHub Security Advisory 或 Release Notes 公布影响范围和修复版本。请不要在修复前公开披露可利用细节。

## 安全边界

MCPort 可以读写本地 Workspace、启动受控命令并将指定 Workspace 暴露到公网。请在报告中明确说明漏洞是否涉及：Workspace 越界、命令执行、认证绕过、Token/OAuth、SSRF、网络隔离或敏感信息泄露。
