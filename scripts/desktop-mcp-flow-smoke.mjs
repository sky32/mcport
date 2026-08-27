import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeOAuthInteractionNotice,
  listOAuthInteractionNotices,
  recordOAuthInteractionNotice,
} from '../dist/oauth-interaction-notices.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [html, renderer, styles, desktopMain, runtimeControl, server, builtinOauth] = await Promise.all([
  readFile(path.join(root, 'desktop/renderer/index.html'), 'utf8'),
  readFile(path.join(root, 'desktop/renderer/app.js'), 'utf8'),
  readFile(path.join(root, 'desktop/renderer/styles.css'), 'utf8'),
  readFile(path.join(root, 'desktop/main.ts'), 'utf8'),
  readFile(path.join(root, 'src/runtime-control.ts'), 'utf8'),
  readFile(path.join(root, 'src/server.ts'), 'utf8'),
  readFile(path.join(root, 'src/builtin-oauth.ts'), 'utf8'),
]);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expect(!html.includes('workspaceContextMenu'), 'Workspace context menu must be removed from renderer HTML');
expect(!renderer.includes('contextmenu'), 'Workspace list must not bind right-click contextmenu handlers');
expect(!styles.includes('.context-menu'), 'Removed Workspace context menu CSS should not remain');
expect(renderer.includes("changeDirectory.textContent = '更换目录'"), 'Workspace list must expose change-directory directly');
expect(renderer.includes("changeDirectory.dataset.icon = 'folder-pen'"), 'Change-directory list action should remain visually identifiable');
for (const label of ['公网 MCP', '安全']) {
  expect(renderer.includes(`makeWorkspaceStatus('${label}'`), `Workspace outer list must expose ${label} status`);
}
for (const removed of ['本地 MCP', '认证', '工具', '运行环境']) {
  expect(!renderer.includes(`makeWorkspaceStatus('${removed}'`), `Workspace outer list must not expose low-frequency ${removed} status`);
}
expect(styles.includes('repeat(2, minmax(0, 1fr))'), 'Workspace status grid must render only public MCP and security cells');
expect(renderer.includes(".workspace-status-item[data-help]"), 'Workspace status cells must participate in rich hover tips');
expect(renderer.includes('地址：${publicUrl') && renderer.includes('通道：${providerLabel}') && renderer.includes('认证：${authLabel}'), 'Public MCP tip must expose URL, provider and authentication');
expect(renderer.includes("return { label: '受限'") && renderer.includes("return { label: '命令受控'") && renderer.includes("return { label: '高风险'"), 'Security presentation must use one consistent runtime-security taxonomy');
expect(!renderer.includes("return { label: '公网 Token'") && !renderer.includes("return { label: '公网 OAuth'"), 'Security presentation must not mix authentication modes into security labels');
expect(renderer.includes("'模型暴露'"), 'Debug Tool Catalog must include a model-exposure column');
expect(renderer.includes("'可见' : '未暴露'"), 'Debug Tool Catalog must distinguish visible vs hidden tools');
expect(desktopMain.includes('toolExposureByWorkspace'), 'Desktop runtime admin snapshot must expose per-Workspace Tool exposure counts');

expect(renderer.includes('const INITIAL_HEALTH_WARMUP_MS = 4500'), 'Renderer must delay initial automatic health checks');
expect(renderer.includes('automaticHealthReadyAt'), 'Renderer must track automatic health warm-up');
expect(renderer.includes('scheduleAutomaticHealthRefresh'), 'Automatic health checks must be scheduled instead of running immediately');
expect(html.includes('id="currentWorkspaceCheckMcpButton"'), 'Workspace settings must keep an explicit immediate MCP check button');
expect(html.includes('<h3>MCP 校验</h3>'), 'Workspace settings high-frequency section must be MCP validation');

expect(html.includes('workspace-advanced-settings'), 'Tool/runtime settings must be inside the Advanced disclosure');
expect(html.includes('高级设置 · 工具权限 / 本机命令 / 运行环境'), 'Advanced disclosure must describe the low-frequency permissions it contains');
expect(html.indexOf('workspace-advanced-settings') < html.indexOf('currentWorkspaceToolTierInput'), 'Tool tier must be nested after the Advanced disclosure starts');
expect(html.indexOf('workspace-advanced-settings') < html.indexOf('currentWorkspaceExecutionInput'), 'Local command execution must be nested after the Advanced disclosure starts');
expect(html.includes('认证方式与连接高级设置'), 'Authentication mode and route details must be collapsed');
expect(html.includes('OAuth 管理与协议详情'), 'Regenerate/revoke/protocol details must be collapsed');
expect(html.includes('复制 MCP 地址') && html.includes('复制授权密钥'), 'OAuth primary flow must foreground MCP and secret copy actions');
expect(styles.includes('.workspace-oauth-management .oauth-secret-actions, .workspace-token-management .oauth-secret-actions'), 'Bearer Token management actions must share OAuth left alignment');
expect(html.includes('撤销此 Workspace 全部授权'), 'OAuth revoke action must make Workspace scope explicit');
expect(renderer.includes('只影响当前 Workspace') && renderer.includes('其他 Workspace 不受影响'), 'OAuth revoke confirmation must explain Workspace isolation');
expect(html.includes('id="copyWorkspaceTokenMcpButton"') && html.includes('id="copyWorkspaceTokenButton"'), 'Bearer Token flow must mirror OAuth with MCP URL and credential copy actions');
expect(html.includes('Bearer Token 管理与认证详情') && html.includes('重新生成 Bearer Token'), 'Bearer Token reset/details must mirror OAuth management layout');
expect(renderer.includes("toast('Bearer Token 已复制')") && renderer.includes('旧 Token 会立即失效'), 'Bearer Token copy/reset interaction must be explicit');
expect(desktopMain.includes('Workspace ${name} Bearer Token 已轮换') && desktopMain.includes('await restartRuntime()'), 'Bearer Token rotation must reload a running Runtime');
expect(html.includes('id="publicClientInstallProgress"') && styles.includes('.public-client-install-progress-track'), 'Managed client installation must expose a visible progress bar');
expect(renderer.includes('onManagedClientProgress') && renderer.includes('安装中 · ${Math.round(percent)}%'), 'Renderer must consume managed-client progress events');

expect(renderer.includes('是否立即开启公网 MCP'), 'Adding a Workspace must prompt to enable public MCP');
expect(renderer.includes("publicAuthMode: 'oauth'"), 'Add-project onboarding must prefer OAuth');
expect(renderer.includes('是否立即复制'), 'Add-project onboarding must offer MCP URL copy');

expect(runtimeControl.includes("'oauth_interactions'") && runtimeControl.includes("'oauth_interaction_ack'"), 'Runtime Control must expose OAuth interaction notice methods');
expect(server.includes("method === 'oauth_interactions'") && server.includes("method === 'oauth_interaction_ack'"), 'Runtime must serve OAuth interaction notices over local control IPC');
expect(builtinOauth.includes('onAuthorizationInteraction?.'), 'OAuth interaction page must emit a Desktop notice hook');
expect(desktopMain.includes('pollOAuthInteractionNotices'), 'Desktop must poll local OAuth interaction notices');
expect(desktopMain.includes('复制授权密钥'), 'Desktop OAuth notice must foreground copying the authorization secret');
expect(desktopMain.includes('clipboard.writeText(credentials.authorizationSecret)'), 'OAuth secret copy must stay inside Desktop safe-storage ownership');
expect(desktopMain.includes("challengeAttempts = settings.publicAccessProvider === 'trycloudflare' ? 4 : 1"), 'TryCloudflare OAuth challenge must tolerate a bounded propagation window');
expect(desktopMain.includes('OAuth MCP Challenge 异常：HTTP'), 'OAuth challenge failures must expose diagnostic HTTP/header details instead of a generic error');

const sample = recordOAuthInteractionNotice({
  interactionId: 'smoke-interaction',
  workspace: 'alpha',
  clientName: 'Smoke Client',
  clientId: 'https://example.invalid/client.json',
});
const duplicate = recordOAuthInteractionNotice({
  interactionId: 'smoke-interaction',
  workspace: 'alpha',
  clientName: 'Smoke Client',
  clientId: 'https://example.invalid/client.json',
});
expect(sample.id === duplicate.id, 'OAuth interaction notice recording must be idempotent while pending');
expect(listOAuthInteractionNotices().some((item) => item.id === sample.id), 'OAuth interaction notice must be observable by Desktop');
expect(acknowledgeOAuthInteractionNotice(sample.id) === true, 'OAuth interaction notice must be acknowledgeable');
expect(!listOAuthInteractionNotices().some((item) => item.id === sample.id), 'Acknowledged OAuth interaction notice must leave the pending queue');

console.log(JSON.stringify({
  ok: true,
  checks: [
    'startup_health_warmup',
    'manual_mcp_check_remains_immediate',
    'workspace_context_menu_removed',
    'change_directory_visible_on_workspace_row',
    'workspace_outer_public_and_security_statuses',
    'security_taxonomy_excludes_auth_mode',
    'bearer_token_copy_and_rotation_matches_oauth',
    'managed_client_install_progress_visible',
    'debug_tool_catalog_marks_model_exposure',
    'workspace_settings_focus_on_mcp_validation',
    'auth_management_collapsed',
    'tool_and_runtime_permissions_collapsed_under_advanced',
    'add_workspace_prompts_for_public_oauth',
    'add_workspace_offers_mcp_url_copy',
    'oauth_interaction_notifies_desktop',
    'oauth_secret_stays_desktop_owned',
    'oauth_interaction_notice_queue',
  ],
}, null, 2));
