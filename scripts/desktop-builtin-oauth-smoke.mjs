import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-builtin-oauth-${runId}`);
const workspacePath = path.join(root, 'workspaces', `desktop-builtin-oauth-${runId}`, 'alpha');
const host = 'mcp.example.test';
const issuer = `https://${host}/w/alpha`;

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

function request(port, hostname, pathname, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Host: hostname,
        Accept: 'application/json, text/event-stream',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function waitForMetadata(port, child, getStderr) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Desktop exited early (${child.exitCode})\n${getStderr()}`);
    try {
      const response = await request(port, host, '/.well-known/oauth-authorization-server/w/alpha');
      if (response.status === 200) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Built-in OAuth metadata did not become available\n${getStderr()}`);
}

await rm(dataDir, { recursive: true, force: true });
await rm(path.dirname(workspacePath), { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspacePath, { recursive: true });

const gatewayPort = await freePort();
let workspacePort = await freePort();
while (workspacePort === gatewayPort) workspacePort = await freePort();

await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 12,
  workspaceRoot: path.dirname(workspacePath),
  registeredWorkspaces: [{ name: 'alpha', path: workspacePath }],
  selectedWorkspace: 'alpha',
  port: gatewayPort,
  workspaceScope: [],
  workspaceServices: [{
    workspace: 'alpha',
    enabled: true,
    port: workspacePort,
    publicSubdomain: 'alpha',
    publicAuthMode: 'oauth',
    toolTier: 'readonly',
  }],
  additionalServicesJson: '',
  authMode: 'none',
  tunnelBaseDomain: 'mcp.example.test',
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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  const metadataResponse = await waitForMetadata(gatewayPort, desktop, () => stderr);
  const metadata = JSON.parse(metadataResponse.body);
  if (
    metadata.issuer !== issuer
    || metadata.authorization_endpoint !== `${issuer}/oauth/authorize`
    || metadata.token_endpoint !== `${issuer}/oauth/token`
    || metadata.registration_endpoint !== `${issuer}/oauth/register`
    || metadata.client_id_metadata_document_supported !== true
    || !metadata.scopes_supported?.includes('offline_access')
    || !metadata.token_endpoint_auth_methods_supported?.includes('private_key_jwt')
  ) {
    throw new Error(`Unexpected built-in OAuth metadata: ${metadataResponse.body}`);
  }

  const resourceUrl = `https://${host}/w/alpha/mcp`;
  const protectedResponse = await request(gatewayPort, host, '/.well-known/oauth-protected-resource/w/alpha/mcp');
  if (protectedResponse.status !== 200) throw new Error(`Protected Resource Metadata failed: ${protectedResponse.status} ${protectedResponse.body}`);
  const protectedMetadata = JSON.parse(protectedResponse.body);
  if (protectedMetadata.resource !== resourceUrl || !protectedMetadata.authorization_servers?.includes(issuer)) {
    throw new Error(`Unexpected Protected Resource Metadata: ${protectedResponse.body}`);
  }

  const challengeBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'oauth-health-smoke', version: '0.1.0' } },
  });
  const challenge = await request(gatewayPort, host, '/w/alpha/mcp', { method: 'POST', body: challengeBody });
  if (challenge.status !== 401 || !String(challenge.headers['www-authenticate'] ?? '').toLowerCase().includes('bearer')) {
    throw new Error(`OAuth MCP did not issue a Bearer challenge: ${challenge.status} ${JSON.stringify(challenge.headers)} ${challenge.body}`);
  }

  const secrets = JSON.parse(await readFile(path.join(dataDir, 'desktop-secrets.json'), 'utf8'));
  const encryptedSecret = secrets.workspaceOauthAuthorizationSecrets?.alpha;
  const encryptedKey = secrets.workspaceOauthSigningKeys?.alpha;
  if (!encryptedSecret || !encryptedKey) throw new Error(`Desktop did not generate encrypted OAuth credentials: ${JSON.stringify(secrets)}`);
  if (String(encryptedSecret).includes('oauth') || String(encryptedKey).includes('"kty"')) {
    throw new Error('Built-in OAuth credentials appear to be stored in plaintext');
  }

  const persistedSettings = JSON.parse(await readFile(path.join(dataDir, 'desktop-settings.json'), 'utf8'));
  const service = persistedSettings.workspaceServices?.find((item) => item.workspace === 'alpha');
  if (service?.publicAuthMode !== 'oauth' || service?.publicEnabled !== true || 'oauthMetadataUrl' in service || 'oauthJwksUrl' in service || 'oauthAudience' in service) {
    throw new Error(`Desktop did not preserve zero-config built-in OAuth settings: ${JSON.stringify(service)}`);
  }
  if (stderr.includes('Tunnel autostart')) throw new Error(`Built-in OAuth unexpectedly coupled to Tunnel startup:\n${stderr}`);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'desktop_builtin_oauth_zero_config',
      'desktop_generates_authorization_secret',
      'desktop_generates_es256_signing_key',
      'desktop_safe_storage_credentials',
      'runtime_builtin_oauth_metadata_from_public_host',
      'runtime_builtin_oauth_cimd_advertised',
      'runtime_builtin_oauth_protected_resource_metadata',
      'runtime_builtin_oauth_bearer_challenge',
      'builtin_oauth_independent_of_tunnel_process',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(path.dirname(workspacePath), { recursive: true, force: true });
}
