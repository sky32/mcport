import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-workspace-concurrent-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-workspace-concurrent-${runId}`);
const workspacePath = path.join(workspaceRoot, 'alpha');

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
await mkdir(workspacePath, { recursive: true });
const gatewayPort = await freePort();
let workspacePort = await freePort();
while (workspacePort === gatewayPort) workspacePort = await freePort();

await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 18,
  workspaceRoot,
  registeredWorkspaces: [{ name: 'alpha', path: workspacePath }],
  selectedWorkspace: 'alpha',
  port: gatewayPort,
  workspaceScope: [],
  workspaceServices: [{ workspace: 'alpha', enabled: true, port: workspacePort, publicEnabled: false, publicAuthMode: 'oauth', toolTier: 'full' }],
  additionalServicesJson: '',
  authMode: 'none',
  proxyMode: 'off',
  proxyScope: 'tunnel',
  proxyUrl: '',
  proxyBypass: '<local>,localhost,127.0.0.1,[::1]',
  uiLanguage: 'zh-CN',
  appearance: 'system',
  debugMode: 'off',
  lowMemoryTray: true,
  publicAccessProvider: 'external',
  publicClientMode: 'managed',
  publicClientPath: '',
  publicClientVersion: '',
  tunnelBaseDomain: '',
  frpServerAddr: '',
  frpServerPort: 7000,
  frpRemotePort: 18443,
  startTunnelWithRuntime: false,
  launchAtLogin: false,
  minimizeToTray: false,
}, null, 2)}\n`, 'utf8');

const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electronBin, ['.', '--hidden'], {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
    RW_MCP_DESKTOP_SMOKE_CONCURRENT_WORKSPACE_SAVE: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !stderr.includes('DESKTOP_CONCURRENT_WORKSPACE_SAVE_OK')) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    if (stderr.includes('DESKTOP_CONCURRENT_WORKSPACE_SAVE_FAILED=')) throw new Error(stderr);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stderr.includes('DESKTOP_CONCURRENT_WORKSPACE_SAVE_OK')) throw new Error(`Concurrent Workspace save did not complete\n${stderr}`);
  if (stderr.includes('Runtime start failed:') || stderr.includes('EADDRINUSE')) throw new Error(`Concurrent Workspace save caused Runtime start failure\n${stderr}`);
  console.log(JSON.stringify({ ok: true, checks: [
    'workspace_saves_are_serialized',
    'workspace_noop_save_does_not_restart_runtime',
    'workspace_concurrent_save_final_state_is_deterministic',
    'workspace_concurrent_save_runtime_remains_running',
  ] }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
