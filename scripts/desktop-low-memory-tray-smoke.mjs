import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-low-memory-tray-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-low-memory-tray-${runId}`);

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

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message());
}

await rm(dataDir, { recursive: true, force: true });
await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
const port = await freePort();
await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 17,
  workspaceRoot,
  registeredWorkspaces: [],
  selectedWorkspace: '',
  port,
  workspaceScope: [],
  workspaceServices: [],
  additionalServicesJson: '',
  authMode: 'none',
  proxyMode: 'off',
  proxyScope: 'tunnel',
  proxyUrl: '',
  proxyBypass: '<local>,localhost,127.0.0.1,[::1]',
  appearance: 'system',
  debugMode: 'off',
  lowMemoryTray: true,
  publicAccessProvider: 'external',
  publicClientMode: 'managed',
  publicClientPath: '',
  tunnelBaseDomain: '',
  frpServerAddr: '',
  frpServerPort: 7000,
  frpRemotePort: 18443,
  startTunnelWithRuntime: false,
  launchAtLogin: false,
  minimizeToTray: true,
}, null, 2)}\n`, 'utf8');

const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electron, ['.'], {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
    RW_MCP_DESKTOP_SMOKE_CLOSE_WINDOW: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  await waitFor(() => stderr.includes('DESKTOP_WINDOW_DESTROYED'), 12_000, () => `Renderer window was not destroyed in low-memory tray mode\n${stderr}`);
  if (desktop.exitCode !== null) throw new Error(`Desktop exited after low-memory tray close (${desktop.exitCode})\n${stderr}`);
  let runtimeHealthy = false;
  const runtimeDeadline = Date.now() + 8_000;
  while (Date.now() < runtimeDeadline) {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    if (response?.ok) {
      runtimeHealthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!runtimeHealthy) throw new Error(`Runtime was not reachable after Renderer destruction\n${stderr}`);
  console.log(JSON.stringify({
    ok: true,
    port,
    checks: [
      'low_memory_tray_destroys_renderer_window',
      'low_memory_tray_keeps_desktop_process_alive',
      'low_memory_tray_keeps_runtime_alive',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
