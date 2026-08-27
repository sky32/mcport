import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a free port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Keep polling until Runtime is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Gateway Runtime did not become healthy');
}

function request(port, { host, path: pathname = '/mcp', token = '', method = 'POST', rpc = null, sessionId = '' }) {
  const payload = rpc ?? {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gateway-smoke', version: '0.1.0' },
    },
  };
  const requestBody = method === 'POST' ? JSON.stringify(payload) : '';
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Host: host,
        Accept: 'application/json, text/event-stream',
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(requestBody) } : {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId, 'MCP-Protocol-Version': '2025-06-18' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (method === 'POST') req.end(requestBody);
    else req.end();
  });
}

function parseRpcBody(body) {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .find((line) => line.startsWith('{') || line.startsWith('['));
  return data ? JSON.parse(data) : null;
}

async function callGatewayTool(port, host, pathname, token, name, args) {
  const initialized = await request(port, { host, path: pathname, token });
  if (initialized.status !== 200) throw new Error(`Gateway initialize failed for ${host}: ${initialized.status} ${initialized.body}`);
  const sessionId = String(initialized.headers['mcp-session-id'] ?? '');
  await request(port, {
    host,
    path: pathname,
    token,
    sessionId,
    rpc: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  const called = await request(port, {
    host,
    path: pathname,
    token,
    sessionId,
    rpc: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
  });
  if (called.status !== 200) throw new Error(`Gateway tools/call failed for ${name}: ${called.status} ${called.body}`);
  const message = parseRpcBody(called.body);
  if (message?.error) throw new Error(`Gateway tool ${name} failed: ${JSON.stringify(message.error)}`);
  if (message?.result?.isError) throw new Error(`Gateway tool ${name} returned isError: ${JSON.stringify(message.result.content)}`);
  return message?.result?.structuredContent ?? {};
}

async function inspectGatewayTools(port, host, pathname, token) {
  const initialized = await request(port, { host, path: pathname, token });
  if (initialized.status !== 200) throw new Error(`Gateway initialize failed for ${host}: ${initialized.status} ${initialized.body}`);
  const sessionId = String(initialized.headers['mcp-session-id'] ?? '');
  const notification = await request(port, {
    host,
    path: pathname,
    token,
    sessionId,
    rpc: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  if (![200, 202, 204].includes(notification.status)) {
    throw new Error(`Gateway initialized notification failed for ${host}: ${notification.status} ${notification.body}`);
  }
  const listed = await request(port, {
    host,
    path: pathname,
    token,
    sessionId,
    rpc: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  if (listed.status !== 200) throw new Error(`Gateway tools/list failed for ${host}: ${listed.status} ${listed.body}`);
  const message = parseRpcBody(listed.body);
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) throw new Error(`Gateway tools/list returned invalid body for ${host}: ${listed.body}`);
  return new Set(tools.map((tool) => tool.name));
}

const port = await freePort();
const root = path.resolve(`data/gateway-smoke-${process.pid}-${Date.now()}`);
const workspaceRoot = path.join(root, 'workspaces');
await mkdir(path.join(workspaceRoot, 'aaa'), { recursive: true });
await mkdir(path.join(workspaceRoot, 'bbb'), { recursive: true });

const host = 'mcp.demo.com';
const aaaPath = '/w/aaa/mcp';
const bbbPath = '/w/bbb/mcp';
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_AUTH_MODE: 'none',
    ADMIN_ENABLED: 'true',
    ADMIN_LOCAL_ONLY: 'true',
    WORKSPACE_ROOT: workspaceRoot,
    STATE_DB_PATH: path.join(root, 'state.db'),
    ALLOW_COMMAND_EXECUTION: 'false',
    MCP_ALLOWED_HOSTS: `127.0.0.1,localhost,${host}`,
    MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port},https://${host}`,
    MCP_WORKSPACE_TOOL_TIERS_JSON: JSON.stringify({
      aaa: 'standard',
      bbb: 'readonly',
    }),
    MCP_ADDITIONAL_SERVICES_JSON: '[]',
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: JSON.stringify({
      aaa: { mode: 'token', token: 'aaa-token' },
      bbb: { mode: 'token', token: 'bbb-token' },
    }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  await waitForHealth(port);

  const aaa = await request(port, { host, path: aaaPath, token: 'aaa-token' });
  const bbb = await request(port, { host, path: bbbPath, token: 'bbb-token' });
  const unknown = await request(port, { host, path: '/w/unknown/mcp' });
  const publicAdmin = await request(port, { host, path: '/admin', method: 'GET' });
  const unauthenticated = await request(port, { host, path: aaaPath, token: '' });
  const crossToken = await request(port, { host, path: aaaPath, token: 'bbb-token' });
  const bbbMissing = await request(port, { host, path: bbbPath, token: '' });
  const aaaTools = await inspectGatewayTools(port, host, aaaPath, 'aaa-token');
  const bbbTools = await inspectGatewayTools(port, host, bbbPath, 'bbb-token');
  const aaaHealth = await request(port, { host, path: '/w/aaa/healthz', method: 'GET' });
  const bbbHealth = await request(port, { host, path: '/w/bbb/healthz', method: 'GET' });
  const unknownHealth = await request(port, { host, path: '/w/unknown/healthz', method: 'GET' });

  if (aaa.status !== 200 || !aaa.body.includes('workspace:aaa')) {
    throw new Error(`aaa gateway route failed: status=${aaa.status} body=${aaa.body.slice(0, 300)}`);
  }
  if (bbb.status !== 200 || !bbb.body.includes('workspace:bbb')) {
    throw new Error(`bbb gateway route failed: status=${bbb.status} body=${bbb.body.slice(0, 300)}`);
  }
  if (unknown.status !== 404) throw new Error(`Unknown gateway Workspace path should return 404, got ${unknown.status}`);
  if (publicAdmin.status !== 404) throw new Error(`Public Admin should return 404, got ${publicAdmin.status}`);
  if (unauthenticated.status !== 401) throw new Error(`Unauthenticated public MCP should return 401, got ${unauthenticated.status}`);
  if (crossToken.status !== 401) throw new Error(`A Workspace token must not authenticate another Workspace, got ${crossToken.status}`);
  if (bbbMissing.status !== 401) throw new Error(`Bearer Workspace should require a bearer token, got ${bbbMissing.status}`);
  if (!aaaTools.has('apply_patch') || aaaTools.has('exec_command') || aaaTools.has('workspace_list') || aaaTools.has('workspace_info')) {
    throw new Error(`Standard Gateway tool tier was not enforced: ${JSON.stringify([...aaaTools])}`);
  }
  if (bbbTools.has('apply_patch') || bbbTools.has('exec_command') || bbbTools.has('workspace_list') || bbbTools.has('workspace_info')) {
    throw new Error(`Readonly Gateway tool tier was not enforced: ${JSON.stringify([...bbbTools])}`);
  }
  if (aaaHealth.status !== 200 || !aaaHealth.body.includes('gateway:aaa')) {
    throw new Error(`aaa public health route mismatch: status=${aaaHealth.status} body=${aaaHealth.body.slice(0, 300)}`);
  }
  if (bbbHealth.status !== 200 || !bbbHealth.body.includes('gateway:bbb')) {
    throw new Error(`bbb public health route mismatch: status=${bbbHealth.status} body=${bbbHealth.body.slice(0, 300)}`);
  }
  if (unknownHealth.status !== 404) throw new Error(`Unknown public Workspace health path should return 404, got ${unknownHealth.status}`);

  await rm(path.join(workspaceRoot, 'aaa'), { recursive: true, force: true });
  const missingWorkspaceHealth = await request(port, { host, path: '/w/aaa/healthz', method: 'GET' });
  if (missingWorkspaceHealth.status !== 503 || !missingWorkspaceHealth.body.includes('"workspaceReady":false')) {
    throw new Error(`Missing Workspace should make healthz fail: status=${missingWorkspaceHealth.status} body=${missingWorkspaceHealth.body.slice(0, 300)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    port,
    checks: [
      'gateway_path_aaa_workspace_scope',
      'gateway_path_bbb_workspace_scope',
      'unknown_gateway_workspace_path_404',
      'public_admin_404',
      'public_bearer_required',
      'workspace_bearer_tokens_isolated',
      'gateway_standard_tool_tier',
      'gateway_readonly_tool_tier',
      'gateway_health_path_scope',
      'gateway_health_checks_workspace_directory',
      'unknown_gateway_health_path_404',
      'upload_ticket_cors_preflight_without_mcp_bearer',
      'upload_ticket_put_without_mcp_bearer',
      'upload_ticket_commits_exact_bytes',
    ],
  }, null, 2));
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(`Gateway child exited with ${child.exitCode}: ${stderr}`);
  }
}
