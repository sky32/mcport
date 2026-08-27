import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: 'fake cloudflared recovery smoke currently uses a POSIX test executable' }, null, 2));
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-tunnel-recovery-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-tunnel-recovery-${runId}`);
const fakeCloudflared = path.join(dataDir, 'fake-cloudflared');

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
await writeFile(fakeCloudflared, '#!/bin/sh\nsleep 1.5\nexit 92\n', 'utf8');
await chmod(fakeCloudflared, 0o755);
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
  tunnelBaseDomain: 'mcp.demo.com',
  startTunnelWithRuntime: true,
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
    RW_MCP_DESKTOP_SMOKE_CLOUDFLARED_PATH: fakeCloudflared,
    RW_MCP_DESKTOP_SMOKE_TUNNEL_TOKEN: 'smoke-token',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    const starts = (stderr.match(/Starting cloudflared/g) || []).length;
    if (starts >= 2 && stderr.includes('Tunnel auto-recovery scheduled')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const starts = (stderr.match(/Starting cloudflared/g) || []).length;
  if (starts < 2) throw new Error(`Tunnel was not restarted after an unexpected cloudflared exit\n${stderr}`);
  if (!stderr.includes('Tunnel auto-recovery scheduled')) throw new Error(`Tunnel recovery backoff was not scheduled\n${stderr}`);
  if (stderr.includes('Runtime auto-recovery scheduled')) throw new Error(`Tunnel crash incorrectly scheduled Runtime recovery\n${stderr}`);

  console.log(JSON.stringify({
    ok: true,
    tunnelStarts: starts,
    checks: [
      'tunnel_unexpected_exit_detected',
      'tunnel_recovery_backoff_scheduled',
      'tunnel_restarted_automatically',
      'tunnel_recovery_does_not_use_runtime_recovery',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
