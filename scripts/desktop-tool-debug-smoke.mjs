import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-tool-debug-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-tool-debug-${runId}`);

const rendererSource = await readFile(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
const workspaceSaveStart = rendererSource.indexOf("$('saveCurrentWorkspaceButton').addEventListener('click'");
const workspaceSaveEnd = rendererSource.indexOf("$('resetRuntimeSettingsButton').addEventListener", workspaceSaveStart);
const workspaceSaveBlock = workspaceSaveStart >= 0 && workspaceSaveEnd > workspaceSaveStart
  ? rendererSource.slice(workspaceSaveStart, workspaceSaveEnd)
  : '';
if (!workspaceSaveBlock || workspaceSaveBlock.includes('closeWorkspaceSettingsModal()')) {
  throw new Error('Workspace settings save must keep the modal open after a successful save');
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate free port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

await rm(dataDir, { recursive: true, force: true });
await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
const port = await freePort();
await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 17,
  workspaceRoot,
  registeredWorkspaces: [], selectedWorkspace: '', port, workspaceScope: [], workspaceServices: [], additionalServicesJson: '',
  authMode: 'none', proxyMode: 'off', proxyScope: 'tunnel', proxyUrl: '', proxyBypass: '<local>,localhost,127.0.0.1,[::1]',
  appearance: 'light', debugMode: 'basic', lowMemoryTray: true,
  publicAccessProvider: 'external', publicClientMode: 'managed', publicClientPath: '', publicClientVersion: '', tunnelBaseDomain: 'mcp.demo.com',
  frpServerAddr: '', frpServerPort: 7000, frpRemotePort: 18443,
  startTunnelWithRuntime: false, launchAtLogin: false, minimizeToTray: false,
}, null, 2)}\n`, 'utf8');

const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electron, ['.', '--hidden', '--no-sandbox', '--disable-gpu'], {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
    RW_MCP_DESKTOP_SMOKE_TOOL_DEBUG: '1',
    RW_MCP_DESKTOP_SMOKE_DESKTOP_ONLY_SAVE: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && (!stderr.includes('DESKTOP_TOOL_DEBUG_OK') || !stderr.includes('DESKTOP_DESKTOP_ONLY_SAVE_OK'))) {
    if (stderr.includes('DESKTOP_TOOL_DEBUG_FAILED=')) throw new Error(stderr);
    if (stderr.includes('DESKTOP_DESKTOP_ONLY_SAVE_FAILED=')) throw new Error(stderr);
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stderr.includes('DESKTOP_TOOL_DEBUG_OK') || !/tools=\d+/.test(stderr) || stderr.includes('tools=0') || !stderr.includes('theme=light') || !stderr.includes('rendererTheme=light') || !stderr.includes('provider=external public=running')) throw new Error(`Tool debug/theme smoke failed\n${stderr}`);
  if (!stderr.includes('DESKTOP_DESKTOP_ONLY_SAVE_OK') || (stderr.match(/Starting Runtime entry/g) || []).length !== 1) throw new Error(`Desktop-only settings save restarted Runtime\n${stderr}`);
  if (stderr.includes('Starting cloudflared') || stderr.includes('Starting frpc')) throw new Error(`External provider unexpectedly started a local public client\n${stderr}`);
  console.log(JSON.stringify({ ok: true, checks: ['tool_debug_snapshot_available', 'tool_debug_catalog_available', 'tool_debug_stats_and_details_tabs', 'tool_debug_all_catalog_rows_rendered', 'all_main_pages_width_adaptive', 'tool_debug_stats_responsive', 'tool_debug_trace_internal_scroll', 'native_theme_light_source_applied', 'renderer_light_theme_applied', 'renderer_light_controls_are_light', 'renderer_primary_buttons_match_button_system', 'renderer_disabled_buttons_have_readable_contrast', 'renderer_logs_toolbar_is_light', 'renderer_i18n_zh_en_switches_static_labels', 'renderer_english_ui_has_no_han_residuals', 'renderer_dynamic_i18n_samples', 'renderer_hides_english_decorative_labels', 'workspace_save_shortcut_is_borderless', 'workspace_save_keeps_modal_open', 'workspace_oauth_revoke_control_present', 'sidebar_hides_redundant_runtime_status', 'sidebar_uses_mcp_response_latency_label', 'local_access_controls_share_one_row', 'allowed_commands_defaults_exposed', 'allowed_commands_reset_control_present', 'managed_client_version_controls_present', 'managed_client_latest_specific_interaction', 'desktop_debug_mode_loaded', 'desktop_only_settings_do_not_restart_runtime', 'external_public_provider_requires_no_local_client'] }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
