import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-tunnel-preflight-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-tunnel-preflight-${runId}`);

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
  settingsVersion: 19,
  workspaceRoot,
  registeredWorkspaces: [], selectedWorkspace: '', port, workspaceScope: [], workspaceServices: [], additionalServicesJson: '',
  authMode: 'none', proxyMode: 'off', proxyScope: 'tunnel', proxyUrl: '', proxyBypass: '<local>,localhost,127.0.0.1,[::1]',
  appearance: 'system', debugMode: 'off', lowMemoryTray: true,
  publicAccessProvider: 'cloudflare', publicClientMode: 'managed', publicClientPath: '', publicClientVersion: '', tunnelBaseDomain: 'mcp.demo.com',
  frpServerAddr: '', frpServerPort: 7000, frpRemotePort: 18443,
  startTunnelWithRuntime: true, launchAtLogin: false, minimizeToTray: false,
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
    RW_MCP_DESKTOP_SMOKE_TUNNEL_TOKEN: 'smoke-token',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !stderr.includes('Tunnel start failed:')) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stderr.includes('Tunnel start failed:')) throw new Error(`Expected tunnel preflight failure was not observed\n${stderr}`);
  if (!stderr.includes('尚未安装 cloudflared')) throw new Error(`Missing managed-client guidance was not emitted\n${stderr}`);
  if (stderr.includes('api.github.com') || stderr.includes('正在下载并校验 cloudflared')) throw new Error(`Tunnel start attempted an implicit managed-client download\n${stderr}`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (stderr.includes('Tunnel auto-recovery scheduled')) throw new Error(`Tunnel preflight failure incorrectly scheduled recovery\n${stderr}`);
  if ((stderr.match(/Tunnel start failed:/g) || []).length !== 1) throw new Error(`Tunnel preflight failure was retried unexpectedly\n${stderr}`);
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'tunnel_preflight_failure_detected',
      'missing_managed_client_requires_explicit_install',
      'tunnel_start_does_not_implicitly_download_client',
      'tunnel_preflight_failure_not_auto_retried',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
