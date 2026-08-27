import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-port-conflict-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-port-conflict-${runId}`);

await mkdir(dataDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });

const blocker = net.createServer();
await new Promise((resolve, reject) => {
  blocker.once('error', reject);
  blocker.listen(0, '127.0.0.1', resolve);
});
const address = blocker.address();
const port = typeof address === 'object' && address ? address.port : 0;
if (!port) throw new Error('Unable to allocate occupied test port');

await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 6,
  workspaceRoot,
  registeredWorkspaces: [],
  selectedWorkspace: '',
  port,
  workspaceScope: [],
  workspaceServices: [],
  additionalServicesJson: '',
  authMode: 'none',
  tunnelBaseDomain: '',
  startTunnelWithRuntime: false,
  launchAtLogin: false,
  minimizeToTray: false,
}, null, 2)}\n`, 'utf8');

const electron = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(electron, ['.', '--hidden'], {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 12_000;
  let switchedPort = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited unexpectedly (${child.exitCode})\n${stderr}`);
    try {
      const saved = JSON.parse(await readFile(path.join(dataDir, 'desktop-settings.json'), 'utf8'));
      if (Number(saved.port) && Number(saved.port) !== port) {
        const candidate = Number(saved.port);
        const health = await fetch(`http://127.0.0.1:${candidate}/healthz`).catch(() => null);
        if (health?.ok) {
          switchedPort = candidate;
          break;
        }
      }
    } catch {
      // Settings/runtime may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!switchedPort) throw new Error(`Desktop did not switch away from occupied Gateway port ${port}\n${stderr}`);
  if (!stderr.includes(`Gateway port ${port} occupied; switched to ${switchedPort}`)) {
    throw new Error(`Automatic Gateway port switch was not logged\n${stderr}`);
  }
  console.log(JSON.stringify({
    ok: true,
    occupiedPort: port,
    switchedPort,
    checks: ['occupied_gateway_port_detected', 'gateway_port_auto_switched', 'runtime_started_on_replacement_port'],
  }, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  await new Promise((resolve) => blocker.close(resolve));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  await rm(workspaceRoot, { recursive: true, force: true });
}
