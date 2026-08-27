import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: 'fake frpc provider smoke currently uses a POSIX test executable' }, null, 2));
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-frp-provider-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-frp-provider-${runId}`);
const fakeFrpc = path.join(dataDir, 'fake-frpc');
const marker = path.join(dataDir, 'frpc-marker.txt');

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
await writeFile(fakeFrpc, `#!/bin/sh\necho "$@" > "${marker}"\nsleep 30\n`, 'utf8');
await chmod(fakeFrpc, 0o755);
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
  publicAccessProvider: 'frp',
  publicClientMode: 'custom',
  publicClientPath: fakeFrpc,
  tunnelBaseDomain: 'mcp.demo.com',
  frpServerAddr: 'frps.demo.com',
  frpServerPort: 7000,
  frpSubdomain: 'w-mcp',
  frpRemotePort: 18443,
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
    RW_MCP_DESKTOP_SMOKE_FRP_TOKEN: 'frp-smoke-token',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && !stderr.includes('FRP Client running')) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stderr.includes('Starting frpc') || !stderr.includes('FRP Client running')) throw new Error(`FRP provider did not start\n${stderr}`);
  const markerDeadline = Date.now() + 2_000;
  while (Date.now() < markerDeadline && !(await stat(marker).catch(() => null))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!(await stat(marker).catch(() => null))) throw new Error(`frpc marker was not created\n${stderr}`);
  const args = await readFile(marker, 'utf8');
  const configPath = path.join(dataDir, 'runtime', 'frpc.generated.toml');
  if (!args.includes(`-c ${configPath}`)) throw new Error(`frpc did not receive generated config: ${args}`);
  const config = await readFile(configPath, 'utf8');
  for (const expected of [
    'serverAddr = "frps.demo.com"',
    'serverPort = 7000',
    'auth.method = "token"',
    'auth.token = "frp-smoke-token"',
    'transport.tls.enable = true',
    'type = "http"',
    'name = "w-mcp"',
    'subdomain = "w-mcp"',
    `localPort = ${port}`,
  ]) {
    if (!config.includes(expected)) throw new Error(`Generated frpc config missing ${expected}:\n${config}`);
  }
  const mode = (await stat(configPath)).mode & 0o777;
  if (mode !== 0o600) throw new Error(`Generated frpc config must be mode 0600, got ${mode.toString(8)}`);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'frp_provider_uses_custom_frpc',
      'frp_provider_generates_runtime_config',
      'frp_provider_uses_safe_config_permissions',
      'frp_provider_passes_expected_http_subdomain_config',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  const configPath = path.join(dataDir, 'runtime', 'frpc.generated.toml');
  try {
    await readFile(configPath, 'utf8');
    throw new Error('Generated frpc config containing the token was not removed during shutdown');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
