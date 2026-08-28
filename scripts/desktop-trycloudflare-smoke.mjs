import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  console.log(JSON.stringify({ ok: true, skipped: 'fake cloudflared smoke currently uses a POSIX test executable' }, null, 2));
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-trycloudflare-${runId}`);
const workspacePath = path.join(root, 'workspaces', `desktop-trycloudflare-${runId}`, 'alpha');
const fakeCloudflared = path.join(dataDir, 'fake-cloudflared');
const marker = path.join(dataDir, 'cloudflared-marker.txt');
const attemptFile = path.join(dataDir, 'cloudflared-attempt.txt');
const publicHost = 'quick-smoke.trycloudflare.com';
const publicBase = `https://${publicHost}`;

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

function request(port, hostname, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      headers: { Host: hostname, Accept: 'application/json, text/event-stream' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

await rm(dataDir, { recursive: true, force: true });
await rm(path.dirname(workspacePath), { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspacePath, { recursive: true });
await writeFile(path.join(workspacePath, 'README.md'), '# TryCloudflare smoke\n', 'utf8');
await writeFile(fakeCloudflared, `#!/bin/sh\ncount=0\nif [ -f "${attemptFile}" ]; then count=$(cat "${attemptFile}"); fi\ncount=$((count + 1))\necho "$count" > "${attemptFile}"\necho "$@" >> "${marker}"\necho "2026-08-24T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2\nif [ "$count" -eq 1 ]; then\n  echo 'failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": read tcp 192.168.0.117:62106->104.16.231.132:443: read: connection reset by peer' >&2\n  exit 1\nfi\necho "2026-08-24T00:00:00Z INF +------------------------------------------------------------+" >&2\necho "2026-08-24T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at:          |" >&2\necho "2026-08-24T00:00:00Z INF |  ${publicBase}                         |" >&2\necho "2026-08-24T00:00:00Z INF +------------------------------------------------------------+" >&2\nsleep 30\n`, 'utf8');
await chmod(fakeCloudflared, 0o755);

const gatewayPort = await freePort();
let workspacePort = await freePort();
while (workspacePort === gatewayPort) workspacePort = await freePort();

await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 19,
  workspaceRoot: path.dirname(workspacePath),
  registeredWorkspaces: [{ name: 'alpha', path: workspacePath }],
  selectedWorkspace: 'alpha',
  port: gatewayPort,
  workspaceScope: [],
  workspaceServices: [{
    workspace: 'alpha',
    enabled: true,
    port: workspacePort,
    publicEnabled: true,
    publicPath: 'alpha',
    publicAuthMode: 'token',
    toolTier: 'readonly',
  }],
  additionalServicesJson: '',
  authMode: 'none',
  proxyMode: 'off',
  proxyScope: 'global',
  tunnelProxyEnabled: false,
  proxyUrl: '',
  proxyBypass: '<local>,localhost,127.0.0.1,[::1]',
  appearance: 'system',
  debugMode: 'off',
  lowMemoryTray: true,
  publicAccessProvider: 'trycloudflare',
  publicClientMode: 'custom',
  publicClientPath: fakeCloudflared,
  publicClientVersion: '',
  cloudflareTransportProtocol: 'http2',
  cloudflareEdgeIpVersion: '4',
  tunnelBaseDomain: '',
  frpServerAddr: '',
  frpServerPort: 7000,
  frpSubdomain: 'mcp',
  frpRemotePort: 18443,
  startTunnelWithRuntime: true,
  launchAtLogin: false,
  minimizeToTray: false,
}, null, 2)}\n`, 'utf8');

const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electronBin, ['--no-sandbox', '.', '--hidden'], {
  cwd: root,
  env: {
    ...process.env,
    HOME: dataDir,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
    RW_MCP_DESKTOP_SMOKE_API_TOKEN: 'trycloudflare-smoke-token',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !stderr.includes('TryCloudflare Quick Tunnel running')) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stderr.includes(`TryCloudflare URL: ${publicBase}`) || !stderr.includes('TryCloudflare Quick Tunnel running')) {
    throw new Error(`TryCloudflare provider did not become ready\n${stderr}`);
  }
  const readinessDeadline = Date.now() + 5_000;
  while (Date.now() < readinessDeadline && !stderr.includes('TryCloudflare 公网路由与 OAuth readiness grace 已完成')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!stderr.includes('TryCloudflare 公网路由与 OAuth readiness grace 已完成')) {
    throw new Error(`TryCloudflare readiness grace was not observable\n${stderr}`);
  }
  const markerDeadline = Date.now() + 2_000;
  while (Date.now() < markerDeadline && !(await stat(marker).catch(() => null))) await new Promise((resolve) => setTimeout(resolve, 50));
  const args = await readFile(marker, 'utf8');
  if (!args.includes(`tunnel --protocol http2 --edge-ip-version 4 --url http://127.0.0.1:${gatewayPort}`)) {
    throw new Error(`cloudflared did not receive Quick Tunnel args: ${args}`);
  }
  const attempts = Number((await readFile(attemptFile, 'utf8')).trim());
  if (attempts < 2) throw new Error(`TryCloudflare transient failure did not trigger a retry: attempts=${attempts}`);
  if (!stderr.includes('TryCloudflare transient failure · quick retry 1/2')) {
    throw new Error(`TryCloudflare transient failure did not use fast retry policy\n${stderr}`);
  }

  const routeDeadline = Date.now() + 8_000;
  let healthResponse = null;
  while (Date.now() < routeDeadline) {
    try {
      const response = await request(gatewayPort, publicHost, '/w/alpha/healthz');
      if (response.status === 200) { healthResponse = response; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!healthResponse) throw new Error(`Runtime did not restart with TryCloudflare gateway routing\n${stderr}`);
  const health = JSON.parse(healthResponse.body);
  if (health.serviceId !== 'gateway:alpha') throw new Error(`TryCloudflare route resolved to the wrong service: ${healthResponse.body}`);

  const persisted = JSON.parse(await readFile(path.join(dataDir, 'desktop-settings.json'), 'utf8'));
  if (persisted.publicAccessProvider !== 'trycloudflare' || persisted.tunnelBaseDomain !== '') {
    throw new Error(`TryCloudflare settings should not require a static Host: ${JSON.stringify(persisted)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'trycloudflare_requires_no_domain_or_token',
      'trycloudflare_uses_official_quick_tunnel_args',
      'trycloudflare_applies_transport_preferences',
      'trycloudflare_transient_network_failure_fast_retries',
      'trycloudflare_parses_ephemeral_public_url',
      'trycloudflare_waits_for_runtime_oauth_readiness_grace',
      'trycloudflare_restarts_runtime_with_dynamic_gateway_host',
      'trycloudflare_workspace_gateway_uses_dynamic_origin',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (desktop.exitCode === null) desktop.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
  await rm(path.dirname(workspacePath), { recursive: true, force: true });
}
