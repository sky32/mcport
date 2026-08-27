# MCPort — Agent Guide

This repository implements a generic local Workspace MCP Runtime plus an Electron Desktop shell.

## Product model

- Desktop owns Workspace registration, Runtime lifecycle (Electron `utilityProcess`), Tunnel lifecycle, managed tunnel binaries (`cloudflared`/`frpc`), proxy settings, secure secrets, tray/login integration, health checks, and UI.
- Runtime owns MCP transport, tools, Workspace safety, command execution, Git, project history, authentication, and SQLite runtime state.
- AI clients own reasoning and project-specific knowledge.
- Project-specific instructions and Skills live in target Workspaces, not in this server.

## Invariants

1. Runtime executes as the local OS user.
2. File and cwd operations remain inside the selected Workspace after realpath/symlink validation.
3. Commands use executable + args[] with `shell: false`.
4. Executables are plain command names (no `/` or `\`) and must pass Allowed Commands with exact-name matching.
5. The command allowlist is not an OS sandbox; child processes inherit the Runtime user's permissions.
6. Single-Workspace MCP endpoints may infer Workspace; ambiguous multi-Workspace endpoints require an explicit Workspace.
7. Desktop automatically manages Runtime startup and recovery; users control Tunnel exposure, not Runtime lifecycle.
8. Public Workspaces share one hostname and route by `/w/<workspace>/...` on the default listener's non-loopback Host path.
9. Public authentication is per Workspace: built-in OAuth or Bearer Token. There is no unauthenticated public access.
10. Built-in OAuth uses `oidc-provider`; application code supplies Workspace policy, interaction UI, persistence adapter, and MCP resource binding.
11. Runtime configuration belongs in SQLite; Desktop routing/preferences belong in Desktop settings; secrets use `safeStorage`.
12. Tool tiers (`readonly`/`standard`/`full`) are part of the public MCP API and must stay internally consistent with `tools/list` and `src/tool-tier-smoke.ts`.
13. Project history is model-mediated; Desktop never records chat text in the background.

## Source map

Runtime core:

- `src/server.ts` — HTTP services, public Gateway routing, JSON-only transport mode, admin mount, runtime-control IPC.
- `src/config.ts` — environment configuration, additional MCP services, startup validation.
- `src/tools.ts` — Tool Catalog, tier-gated registration, server instructions, MCP resource guide.
- `src/security.ts` — Workspace/path/command safety.
- `src/runtime.ts` — Execa-backed command sessions, per-OS network isolation, bounded output paging.
- `src/workspaces.ts` — registry/root Workspace resolution.

Tools and intelligence:

- `src/file-tools.ts` — bounded file/list/search/image helpers.
- `src/patch.ts` — validated transactional patch envelopes with baseline snapshots and rollback.
- `src/mutation-tools.ts` — `copy_file`/`import_file` mutations, including the SSRF-guarded HTTPS attachment download.
- `src/git-tools.ts` — fixed read-only Git helpers via trusted internal commands.
- `src/code-index.ts` — tree-sitter code index (TypeScript/JavaScript only) with its own SQLite database.
- `src/lsp.ts` — language-server manager: resolves Desktop-managed TS/HTML/CSS servers plus Workspace/PATH servers.
- `src/task-runtime.ts` / `src/task-store.ts` — tasks, validation stages, completion gate, drift detection.
- `src/operation-store.ts` — persistent command/mutation/validation operations and `outcome_unknown` migration on restart.
- `src/checkpoints.ts` — external-state recovery checkpoints.
- `src/project-history.ts` — AI-invoked project history archives.
- `src/context.ts` — onboarding guidance discovery.

Safety and observability:

- `src/risk-policy.ts` — command/mutation risk classification.
- `src/authority.ts` — allow/confirm/deny authorization decisions.
- `src/local-confirmations.ts` — in-memory pending local confirmations polled by Desktop.
- `src/loop-detector.ts` — advisory loop warnings attached to tool results.
- `src/output-budget.ts` — UTF-8-byte output budgets and pagination.
- `src/tool-trace.ts` — ndjson tool tracing, stats aggregation, argument redaction.

Auth and admin:

- `src/auth.ts` — MCP bearer challenge and access-token verification.
- `src/builtin-oauth.ts` — built-in OAuth (`oidc-provider`) integration and consent UI.
- `src/admin.ts` — `/admin/api/*` surface.
- `src/runtime-control.ts` — `process.parentPort` IPC methods for Desktop.
- `src/oauth-interaction-notices.ts` — interaction notices consumed by Desktop polling.
- `src/store.ts` — runtime SQLite: effective config, workspace/runtime profiles, OAuth provider records.

Shared and smoke entrypoints:

- `shared/runtime-repository.js` — shared Runtime settings/Profile repository, defaults, and state-db migrations.
- `shared/schemas.js` — shared Zod validation.
- `src/tool-tier-smoke.ts`、`src/multi-service-smoke.ts` — compiled smoke entrypoints.

Desktop:

- `desktop/main.ts` — Electron Main Process and managed Runtime/Tunnel lifecycle, settings persistence, native confirmation dialogs.
- `desktop/managed-binaries.ts` — `cloudflared`/`frpc` download, SHA256 verification, versioning, rollback.
- `desktop/runtime-store.ts` — thin Desktop wrapper over the shared Runtime repository.
- `desktop/preload.cjs` — narrow IPC bridge.
- `desktop/renderer/` — Desktop UI (`app.js`, `i18n.js`, `index.html`, `styles.css`).

## Editing rules

- Keep TypeScript strict and ESM-compatible.
- Prefer shared Zod schemas over handwritten runtime validation.
- Prefer mature protocol/infrastructure libraries over custom implementations when they materially reduce correctness risk.
- Do not add arbitrary shell-string execution.
- Do not expose secrets, private signing keys, bearer tokens, OAuth tokens, or Tunnel tokens in normal UI/API responses or logs.
- Do not silently overwrite a user-customized Runtime Profile or command allowlist.
- Do not weaken Workspace containment, Host routing, OAuth resource binding, PKCE, token verification, or rate limits.
- Do not reintroduce removed legacy configuration (Tool Surface Profiles, proxy scope, `frpRemotePort`); tool exposure is governed by tiers alone.
- Keep Renderer free of Node integration.
- Renderer 文案必须遵守 `docs/renderer-i18n.md`：固定文案使用 `data-i18n`/key，动态文案使用 `t()`、`localizedText()` 或 `localizedMultiline()`；禁止新增裸中文 DOM 写入、Toast/confirm 属性文案或 MutationObserver 翻译循环。修改 Renderer 后运行 `npm run check:renderer-i18n`。
- Do not package Desktop artifacts unless explicitly requested.

## Tool API

The active Tool Catalog is documented in `docs/ai-usage.md` and `docs/architecture/tools-and-execution.md`.

Workspace lifecycle tools are intentionally absent. Desktop owns Workspace add/remove/configuration.

## Validation

Source changes:

```bash
npm run typecheck
npm run build
```

Desktop changes:

```bash
npm run typecheck:desktop
npm run build:desktop
npm run smoke:desktop
```

Tool changes:

```bash
npm run smoke:core-tools
npm run smoke:tool-tiers
npm run smoke:core-lsp
npm run smoke:patch-validation
npm run smoke:agent-runtime
npm run smoke:operation-store
npm run smoke:tool-trace
npm run smoke:safety-controls
```

Routing changes:

```bash
npm run smoke:gateway
npm run smoke:gateway:json-only
npm run smoke:multi-service
```

OAuth changes:

```bash
npm run smoke:oauth:builtin
npm run smoke:desktop:oauth-builtin
```

Settings/lifecycle changes:

```bash
npm run smoke:desktop:settings
npm run smoke:desktop:workspace-services
npm run smoke:desktop:workspace-atomic-save
npm run smoke:desktop:workspace-concurrent-save
npm run smoke:desktop:corrupt-storage
npm run smoke:desktop:port-conflict
npm run smoke:desktop:runtime-recovery
npm run smoke:desktop:tunnel-recovery
npm run smoke:desktop:tunnel-preflight-failure
npm run smoke:desktop:low-memory-tray
npm run smoke:desktop:close
npm run smoke:desktop:mcp-flow
npm run smoke:desktop:tool-debug
npm run smoke:desktop:managed-binaries
npm run smoke:desktop:frp-provider
npm run smoke:desktop:trycloudflare
```

Never report a test as passing unless it was actually executed successfully.
