import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-close-smoke-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-close-smoke-${runId}`);

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

await mkdir(dataDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
const port = await freePort();
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
const child = spawn(electron, ['.'], {
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
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Desktop did not exit after window close\n${stderr}`)), 12_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Desktop exited with code ${code}\n${stderr}`));
    });
  });
  let stillUp = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    stillUp = response.ok;
  } catch {}
  if (stillUp) throw new Error('Runtime remained reachable after desktop window closed');
  console.log(JSON.stringify({ ok: true, port, checks: ['window_close_exits_app', 'window_close_stops_runtime'] }, null, 2));
} finally {
  child.kill('SIGTERM');
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
