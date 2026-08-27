import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-runtime-recovery-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-runtime-recovery-${runId}`);

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
  settingsVersion: 16,
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
  tunnelBaseDomain: '',
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
    RUNTIME_SMOKE_EXIT_AFTER_MS: '450',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    const starts = (stderr.match(/Starting Runtime entry/g) || []).length;
    if (starts >= 2 && stderr.includes('Runtime auto-recovery scheduled')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const starts = (stderr.match(/Starting Runtime entry/g) || []).length;
  if (starts < 2) throw new Error(`Runtime was not restarted after an unexpected exit\n${stderr}`);
  if (!stderr.includes('Runtime auto-recovery scheduled')) throw new Error(`Runtime recovery backoff was not scheduled\n${stderr}`);
  if (stderr.includes('Tunnel auto-recovery scheduled')) throw new Error(`Runtime crash incorrectly scheduled Tunnel recovery\n${stderr}`);

  console.log(JSON.stringify({
    ok: true,
    runtimeStarts: starts,
    checks: [
      'runtime_unexpected_exit_detected',
      'runtime_recovery_backoff_scheduled',
      'runtime_restarted_automatically',
      'runtime_recovery_does_not_use_tunnel_recovery',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
