import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntimeStore } from '../dist-desktop/runtime-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-settings-smoke-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-settings-smoke-${runId}`);

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForPortOpen(port, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsClosed(port))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Runtime port ${port} did not open`);
}

async function portIsClosed(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (closed) => {
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(300, () => done(true));
    socket.once('connect', () => done(false));
    socket.once('error', () => done(true));
  });
}

async function waitForRendererReady(getStderr, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop exited early (${child.exitCode})\n${getStderr()}`);
    if (getStderr().includes('Renderer ready')) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Renderer did not become ready');
}

await rm(dataDir, { recursive: true, force: true });
await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
const testWorkspace = path.join(workspaceRoot, 'test1');
await mkdir(testWorkspace, { recursive: true });

const preferredGatewayPort = 47877;
const port = await freePort();
let workspacePort = await freePort();
while (workspacePort === port) workspacePort = await freePort();
const previousSettings = {
  settingsVersion: 19,
  workspaceRoot,
  registeredWorkspaces: [{ name: 'test1', path: testWorkspace }],
  selectedWorkspace: 'test1',
  port,
  workspaceScope: [],
  workspaceServices: [{
    workspace: 'test1',
    enabled: true,
    port: workspacePort,
    publicAuthMode: 'oauth',
    toolTier: 'full',
  }],
  additionalServicesJson: '',
  authMode: 'none',
  tunnelBaseDomain: 'before.example.com',
  startTunnelWithRuntime: false,
  launchAtLogin: false,
  minimizeToTray: false,
};
const interruptedSettings = { ...previousSettings, tunnelBaseDomain: 'interrupted.example.com' };
const previousRuntime = {
  runtimePath: '/usr/bin:/bin',
  allowedCommands: ['git'],
  allowCommandExecution: false,
  maxFileBytes: 2 * 1024 * 1024,
  maxCommandOutputBytes: 256 * 1024,
  defaultCommandTimeoutMs: 30_000,
  maxCommandTimeoutMs: 600_000,
};
const interruptedRuntime = { ...previousRuntime, runtimePath: '/interrupted/bin' };

const dbPath = path.join(dataDir, 'runtime', 'state.db');
const store = await DesktopRuntimeStore.open(dbPath);
store.replaceRuntimeSettings(interruptedRuntime);
store.close();
await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify(interruptedSettings, null, 2)}\n`, 'utf8');
await writeFile(path.join(dataDir, 'desktop-save-journal.json'), `${JSON.stringify({
  version: 1,
  previousSettings,
  previousRuntime,
  previousSecrets: {},
}, null, 2)}\n`, 'utf8');

const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electronBin, ['--no-sandbox', '.', '--hidden'], {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  await waitForRendererReady(() => stderr, desktop);
  try {
    await waitForPortOpen(preferredGatewayPort);
  } catch (error) {
    throw new Error(`${error?.message || String(error)}\n${stderr}`);
  }
  if ((stderr.match(/Starting Runtime entry/g) || []).length < 1) throw new Error(`Managed Runtime did not start:\n${stderr}`);

  const restoredSettings = JSON.parse(await readFile(path.join(dataDir, 'desktop-settings.json'), 'utf8'));
  if (restoredSettings.tunnelBaseDomain !== previousSettings.tunnelBaseDomain) {
    throw new Error(`Desktop settings journal recovery failed: ${restoredSettings.tunnelBaseDomain}`);
  }
  if (
    restoredSettings.proxyMode !== 'off'
    || restoredSettings.proxyScope !== 'global'
    || typeof restoredSettings.proxyBypass !== 'string'
    || !restoredSettings.proxyBypass.includes('127.0.0.1')
  ) {
    throw new Error(`Current settings normalization lost safe proxy defaults: ${JSON.stringify({ proxyMode: restoredSettings.proxyMode, proxyScope: restoredSettings.proxyScope, proxyBypass: restoredSettings.proxyBypass })}`);
  }
  if (
    restoredSettings.settingsVersion !== 19
    || restoredSettings.appearance !== 'system'
    || restoredSettings.uiLanguage !== 'system'
    || restoredSettings.debugMode !== 'off'
    || restoredSettings.lowMemoryTray !== true
    || restoredSettings.computerUseEnabled !== false
    || restoredSettings.computerUsePublicEnabled !== false
    || restoredSettings.publicAccessProvider !== 'cloudflare'
    || restoredSettings.publicClientMode !== 'managed'
    || restoredSettings.publicClientVersion !== ''
    || restoredSettings.cloudflareTransportProtocol !== 'auto'
    || restoredSettings.cloudflareEdgeIpVersion !== 'auto'
    || restoredSettings.frpServerPort !== 7000
    || restoredSettings.frpRemotePort !== 18443
    || restoredSettings.frpTransportProtocol !== 'tcp'
    || restoredSettings.frpUseCompression !== false
  ) {
    throw new Error(`Current Desktop defaults were not preserved: ${JSON.stringify(restoredSettings)}`);
  }
  const restoredService = restoredSettings.workspaceServices?.find((item) => item.workspace === 'test1');
  if (!restoredService || restoredService.publicEnabled !== false || restoredService.publicAuthMode !== 'oauth') {
    throw new Error(`Workspace OAuth setting was not preserved: ${JSON.stringify(restoredService)}`);
  }
  const restoredStore = await DesktopRuntimeStore.open(dbPath);
  const restoredRuntime = restoredStore.getRuntimeSettings();
  restoredStore.close();
  if (restoredRuntime.runtimePath !== previousRuntime.runtimePath) {
    throw new Error(`Runtime settings journal recovery failed: ${restoredRuntime.runtimePath}`);
  }
  try {
    await readFile(path.join(dataDir, 'desktop-save-journal.json'), 'utf8');
    throw new Error('Save journal was not cleared after recovery');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    port,
    checks: [
      'renderer_ready_with_managed_runtime',
      'runtime_autostart_is_internal',
      'interrupted_desktop_settings_recovered',
      'interrupted_runtime_settings_recovered',
      'save_journal_cleared_after_recovery',
      'current_settings_proxy_defaults',
      'current_settings_defaults',
      'workspace_oauth_settings_preserved',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 4_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
