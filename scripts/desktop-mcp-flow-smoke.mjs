import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acknowledgeOAuthInteractionNotice,
  listOAuthInteractionNotices,
  recordOAuthInteractionNotice,
} from '../dist/oauth-interaction-notices.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [html, renderer, styles, icons, devicons, desktopMain, runtimeControl, server, builtinOauth, tools, computerUse, desktopActions] = await Promise.all([
  readFile(path.join(root, 'desktop/renderer/index.html'), 'utf8'),
  readFile(path.join(root, 'desktop/renderer/app.js'), 'utf8'),
  readFile(path.join(root, 'desktop/renderer/styles.css'), 'utf8'),
  readFile(path.join(root, 'desktop/renderer/vendor/lucide-icons.js'), 'utf8'),
  readFile(path.join(root, 'desktop/renderer/vendor/devicon-icons.js'), 'utf8'),
  readFile(path.join(root, 'desktop/main.ts'), 'utf8'),
  readFile(path.join(root, 'src/runtime-control.ts'), 'utf8'),
  readFile(path.join(root, 'src/server.ts'), 'utf8'),
  readFile(path.join(root, 'src/builtin-oauth.ts'), 'utf8'),
  readFile(path.join(root, 'src/tools.ts'), 'utf8'),
  readFile(path.join(root, 'desktop/computer-use.ts'), 'utf8'),
  readFile(path.join(root, 'src/desktop-actions.ts'), 'utf8'),
]);

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expect(!html.includes('workspaceContextMenu'), 'Workspace context menu must be removed from renderer HTML');
expect(!renderer.includes('contextmenu'), 'Workspace list must not bind right-click contextmenu handlers');
expect(!styles.includes('.context-menu'), 'Removed Workspace context menu CSS should not remain');
expect(renderer.includes("changeDirectory.textContent = t('workspace.changeFolderButton')"), 'Workspace list must expose the localized change-directory action directly');
expect(renderer.includes("changeDirectory.dataset.icon = 'folder-pen'"), 'Change-directory list action should remain visually identifiable');
expect(renderer.includes("workspacePath.dataset.icon = 'folder-code'"), 'Workspace directory paths must use the folder-code icon');
for (const label of ['公网 MCP', '安全']) {
  expect(renderer.includes(`makeWorkspaceStatus('${label}'`), `Workspace outer list must expose ${label} status`);
}
for (const removed of ['本地 MCP', '认证', '工具', '运行环境']) {
  expect(!renderer.includes(`makeWorkspaceStatus('${removed}'`), `Workspace outer list must not expose low-frequency ${removed} status`);
}
expect(styles.includes('repeat(2, minmax(0, 1fr))'), 'Workspace status grid must render only public MCP and security cells');
expect(renderer.includes(".workspace-status-item[data-help]"), 'Workspace status cells must participate in rich hover tips');
expect(renderer.includes("t('workspace.publicAddress'") && renderer.includes('通道：${providerLabel}') && renderer.includes('认证：${authLabel}'), 'Public MCP tip must expose URL, provider and authentication');
expect(renderer.includes("t('security.restricted')") && renderer.includes("t('security.controlled')") && renderer.includes("t('security.highRisk')"), 'Security presentation must use one consistent runtime-security taxonomy');
expect(!renderer.includes("label: '公网 Token'") && !renderer.includes("label: '公网 OAuth'"), 'Security presentation must not mix authentication modes into security labels');
expect(renderer.includes("exposure.className = 'debug-tool-exposure'"), 'Debug Tool Catalog must include a model-exposure column');
expect(renderer.includes("'可见' : '未暴露'"), 'Debug Tool Catalog must distinguish visible vs hidden tools');
expect(desktopMain.includes('toolExposureByWorkspace'), 'Desktop runtime admin snapshot must expose per-Workspace Tool exposure counts');

expect(renderer.includes('const INITIAL_HEALTH_WARMUP_MS = 8000'), 'Renderer must delay initial automatic health checks');
expect(!html.includes('class="sidebar-status"') && !html.includes('id="globalLatencyCard"'), 'Duplicate Runtime, tunnel, health, and latency summaries must stay out of the sidebar');
expect(renderer.includes('const HEALTH_REFRESH_INTERVAL_MS = 90_000'), 'Automatic health checks must use a low-frequency interval');
expect(renderer.includes("document.visibilityState === 'visible'"), 'Background windows must not run display-only health checks');
expect(renderer.includes('automaticHealthDeferred'), 'Health checks deferred in the background must resume in the foreground');
const healthRefreshStart = renderer.indexOf('async function refreshHealthChecks');
const healthRequestStart = renderer.indexOf('const results = await window.desktop.checkWorkspaceHealth()', healthRefreshStart);
expect(healthRefreshStart >= 0 && healthRequestStart > healthRefreshStart && !renderer.slice(healthRefreshStart, healthRequestStart).includes('workspaceHealthCache = new Map'), 'Health refreshes must retain the previous visible result');
expect(renderer.includes('automaticHealthReadyAt'), 'Renderer must track automatic health warm-up');
expect(renderer.includes('scheduleAutomaticHealthRefresh'), 'Automatic health checks must be scheduled instead of running immediately');
expect(html.includes('id="refreshHealthButton"'), 'Workspace list must keep an explicit immediate connection-check button');
expect(!html.includes('<h3>MCP 校验</h3>'), 'Removed duplicate Workspace MCP validation section must not return');

expect(html.includes('workspace-advanced-settings'), 'Tool/runtime settings must be inside the Advanced disclosure');
expect(html.includes('高级设置 · 工具权限 / 本机命令 / 运行环境'), 'Advanced disclosure must describe the low-frequency permissions it contains');
expect(html.indexOf('workspace-advanced-settings') < html.indexOf('currentWorkspaceToolTierInput'), 'Tool tier must be nested after the Advanced disclosure starts');
expect(html.indexOf('workspace-advanced-settings') < html.indexOf('currentWorkspaceExecutionInput'), 'Local command execution must be nested after the Advanced disclosure starts');
expect(!html.includes('认证方式与连接高级设置') && html.includes('workspace-connection-fields'), 'Authentication mode and route details must be directly visible without a disclosure group');
expect(html.includes('OAuth 管理与协议详情'), 'Regenerate/revoke/protocol details must be collapsed');
expect(html.indexOf('workspace-connection-fields') < html.indexOf('workspaceBuiltinOauthAuthSection'), 'Connection settings must appear before authentication-specific management');
expect(html.includes('公网认证 <span class="field-recommendation" data-i18n="workspace.oauthRecommended">'), 'OAuth recommendation must sit beside the public-authentication label');
expect(!html.includes('Bearer Token 与 OAuth 使用相同的 Workspace 公网地址'), 'Bearer Token copy must not repeat the shared public-address implementation detail');
expect(html.includes('复制 MCP 地址') && html.includes('复制授权密钥'), 'OAuth primary flow must foreground MCP and secret copy actions');
expect(styles.includes('.workspace-oauth-management .oauth-secret-actions, .workspace-token-management .oauth-secret-actions'), 'Bearer Token management actions must share OAuth left alignment');
expect(html.includes('撤销此 Workspace 全部授权'), 'OAuth revoke action must make Workspace scope explicit');
expect(renderer.includes("t('workspace.oauthRevokeConfirm'"), 'OAuth revoke confirmation must use the localized Workspace-isolation message');
expect(html.includes('id="copyWorkspaceTokenMcpButton"') && html.includes('id="copyWorkspaceTokenButton"'), 'Bearer Token flow must mirror OAuth with MCP URL and credential copy actions');
expect(html.includes('Bearer Token 管理与认证详情') && html.includes('重新生成 Bearer Token'), 'Bearer Token reset/details must mirror OAuth management layout');
expect(renderer.includes("toast('Bearer Token 已复制')") && renderer.includes("t('workspace.tokenRegenerateConfirm')"), 'Bearer Token copy/reset interaction must be explicit');
expect(desktopMain.includes('Workspace ${name} Bearer Token 已轮换') && desktopMain.includes('await restartRuntime()'), 'Bearer Token rotation must reload a running Runtime');
expect(html.includes('id="publicClientInstallProgress"') && styles.includes('.public-client-install-progress-track'), 'Managed client installation must expose a visible progress bar');
expect(renderer.includes('onManagedClientProgress') && renderer.includes("t('publicClient.installingPercent'"), 'Renderer must consume managed-client progress events');

expect(renderer.includes("t('workspace.enablePublicConfirm'"), 'Adding a Workspace must prompt to enable public MCP');
expect(renderer.includes("publicAuthMode: 'oauth'"), 'Add-project onboarding must prefer OAuth');
expect(renderer.includes("t('workspace.copyPublicConfirm'"), 'Add-project onboarding must offer MCP URL copy');

expect(runtimeControl.includes("'oauth_interactions'") && runtimeControl.includes("'oauth_interaction_ack'"), 'Runtime Control must expose OAuth interaction notice methods');
expect(server.includes("method === 'oauth_interactions'") && server.includes("method === 'oauth_interaction_ack'"), 'Runtime must serve OAuth interaction notices over local control IPC');
expect(builtinOauth.includes('onAuthorizationInteraction?.'), 'OAuth interaction page must emit a Desktop notice hook');
expect(desktopMain.includes('pollOAuthInteractionNotices'), 'Desktop must poll local OAuth interaction notices');
expect(desktopMain.includes('复制授权密钥'), 'Desktop OAuth notice must foreground copying the authorization secret');
expect(desktopMain.includes('clipboard.writeText(credentials.authorizationSecret)'), 'OAuth secret copy must stay inside Desktop safe-storage ownership');
expect(desktopMain.includes("challengeAttempts = settings.publicAccessProvider === 'trycloudflare' ? 4 : 1"), 'TryCloudflare OAuth challenge must tolerate a bounded propagation window');
expect(desktopMain.includes('OAuth MCP Challenge 异常：HTTP'), 'OAuth challenge failures must expose diagnostic HTTP/header details instead of a generic error');
expect(desktopMain.includes('TUNNEL_STABLE_RESET_MS = 60_000'), 'Tunnel recovery backoff must reset only after a stable connection');
expect(desktopMain.includes('0.85 + Math.random() * 0.3'), 'Tunnel recovery delays must include jitter');
expect(html.includes('id="cloudflareTransportProtocolInput"') && html.includes('id="cloudflareEdgeIpVersionInput"'), 'Cloudflare network transport settings must be configurable');
expect(html.includes('id="frpTransportProtocolInput"') && html.includes('id="frpUseCompressionInput"'), 'FRP transport and compression settings must be configurable');
expect(renderer.includes('function setAutoScrollText') && styles.includes('@keyframes auto-text-pan'), 'Overflowing status text must use measured auto-scroll instead of ellipsis');
expect(html.includes('vendor/devicon-icons.js') && renderer.includes('window.MCPortLanguageIcons?.render(item.id)'), 'Managed LSP rows must use the offline Devicon subset');
for (const language of ['typescript', 'html', 'css', 'python', 'json', 'yaml', 'markdown', 'go', 'rust', 'java', 'c', 'cpp', 'php', 'vue', 'bash', 'dockerfile']) {
  expect(devicons.includes(`"${language}"`), `Vendored Devicon subset must include ${language}`);
}
expect(html.includes('id="computerUseEnabledInput"') && html.includes('id="computerUsePublicEnabledInput"') && html.includes('id="computerUseStatus"'), 'Desktop settings must expose Computer Use local/public switches and readiness status');
for (const icon of ['square-mouse-pointer', 'file-scan', 'log-in', 'monitor-cog', 'memory-stick', 'languages', 'palette', 'link', 'shield-question-mark', 'fingerprint-pattern', 'key-round', 'triangle-alert', 'folder-code']) {
  expect(icons.includes(`'${icon}'`) || icons.includes(`${icon}:`), `Vendored Lucide subset must include ${icon}`);
}
expect(html.indexOf('id="computerUseEnabledInput"') > html.indexOf('data-settings-panel="runtime"') && html.indexOf('id="computerUseEnabledInput"') < html.indexOf('data-settings-panel="app"'), 'Computer Use controls must stay with high-privilege Runtime settings');
expect(renderer.includes('computerUseEnabled: $(\'computerUseEnabledInput\').checked') && renderer.includes('computerUsePublicEnabled: $(\'computerUsePublicEnabledInput\').checked'), 'Computer Use settings must persist through the common settings save');
expect(desktopMain.includes("type: 'mcport:desktop-action-response'") && desktopActions.includes("type: 'mcport:desktop-action-request'"), 'Computer Use must use the Desktop/Runtime IPC channel');
expect(tools.includes("mcp.registerTool('computer_use'") && tools.includes("!service.id.startsWith('gateway:') || config.computerUsePublicEnabled"), 'Computer Use public exposure must require the explicit public setting');
expect(tools.includes("publicRequest ? 'public' : 'local'") && desktopMain.includes("desktopRequest.source === 'public' && !settings.computerUsePublicEnabled"), 'Desktop must independently reject public Computer Use after the public setting is disabled');
expect(computerUse.includes('MAX_SCREENSHOT_BYTES') && computerUse.includes("value.length > 5_000"), 'Computer Use must bound screenshot and typed-text payloads');

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
    'health_checks_are_throttled_and_background_aware',
    'health_refresh_retains_previous_result',
    'tunnel_recovery_uses_jitter_and_stable_reset',
    'tunnel_transport_preferences_are_configurable',
    'overflowing_status_text_auto_scrolls',
    'computer_use_settings_and_ipc',
    'computer_use_public_gateway_opt_in',
    'computer_use_payloads_bounded',
    'manual_mcp_check_remains_immediate',
    'workspace_context_menu_removed',
    'change_directory_visible_on_workspace_row',
    'workspace_outer_public_and_security_statuses',
    'security_taxonomy_excludes_auth_mode',
    'bearer_token_copy_and_rotation_matches_oauth',
    'managed_client_install_progress_visible',
    'debug_tool_catalog_marks_model_exposure',
    'workspace_list_keeps_manual_connection_check',
    'auth_management_collapsed',
    'tool_and_runtime_permissions_collapsed_under_advanced',
    'add_workspace_prompts_for_public_oauth',
    'add_workspace_offers_mcp_url_copy',
    'oauth_interaction_notifies_desktop',
    'oauth_secret_stays_desktop_owned',
    'oauth_interaction_notice_queue',
  ],
}, null, 2));
