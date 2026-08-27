import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const dataRoot = path.join(root, 'data', `gateway-json-only-${runId}`);
const workspaceRoot = path.join(dataRoot, 'workspaces');
const workspace = path.join(workspaceRoot, 'alpha');
const token = 'gateway-json-only-smoke-token';
const publicHost = 'quick-smoke.trycloudflare.com';

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

async function waitForHealth(port, child, getStderr) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early (${child.exitCode})\n${getStderr()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Server did not become healthy\n${getStderr()}`);
}

async function localHostFetch(input, init = {}) {
  const inputRequest = input instanceof Request ? input : null;
  const url = new URL(inputRequest ? inputRequest.url : String(input));
  const method = String(init.method || inputRequest?.method || 'GET').toUpperCase();
  const headers = new Headers(inputRequest?.headers);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  headers.set('host', publicHost);
  const body = init.body;
  const signal = init.signal || inputRequest?.signal;

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers: Object.fromEntries(headers.entries()),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode || 500,
          statusText: response.statusMessage || '',
          headers: responseHeaders,
        }));
      });
    });
    const onAbort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted'));
    request.once('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (body === undefined || body === null) request.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) request.end(body);
    else if (body instanceof ArrayBuffer) request.end(Buffer.from(body));
    else request.destroy(new Error(`Unsupported smoke fetch body type: ${typeof body}`));
  });
}

await rm(dataRoot, { recursive: true, force: true });
await mkdir(workspace, { recursive: true });
const port = await freePort();
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_AUTH_MODE: 'none',
    MCP_API_TOKEN: '',
    MCP_PUBLIC_URL: '',
    MCP_WORKSPACES: '',
    MCP_ADDITIONAL_SERVICES_JSON: '[]',
    ADMIN_ENABLED: 'false',
    WORKSPACE_ROOT: workspaceRoot,
    WORKSPACE_REGISTRY_JSON: JSON.stringify({ alpha: workspace }),
    STATE_DB_PATH: path.join(dataRoot, 'state.db'),
    MCP_ALLOWED_HOSTS: `127.0.0.1,localhost,${publicHost}`,
    MCP_GATEWAY_JSON_ONLY: 'true',
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: JSON.stringify({
      alpha: { mode: 'token', token, workspace: 'alpha' },
    }),
    MCP_WORKSPACE_TOOL_TIERS_JSON: JSON.stringify({ alpha: 'readonly' }),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

const endpoint = `http://127.0.0.1:${port}/w/alpha/mcp`;
const observed = [];
function captureFetch(label) {
  return async (input, init) => {
    const inputRequest = input instanceof Request ? input : null;
    const method = String(init?.method || inputRequest?.method || 'GET').toUpperCase();
    const response = await localHostFetch(input, init);
    observed.push({ label, method, status: response.status, contentType: response.headers.get('content-type') || '' });
    return response;
  };
}
function createTransport(label) {
  return new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: captureFetch(label),
  });
}

const legacyTransport = createTransport('legacy');
const legacyClient = new Client({ name: 'gateway-json-only-legacy-smoke', version: '0.1.0' });
const modernTransport = createTransport('modern');
const modernClient = new Client(
  { name: 'gateway-json-only-modern-smoke', version: '0.1.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);

function assertTransportPolicy(info, label) {
  const payload = info.structuredContent;
  if (payload?.service?.transport?.responseMode !== 'json' || payload?.service?.transport?.legacy !== 'stateless-json' || payload?.service?.transport?.sseAllowed !== false) {
    throw new Error(`${label} server_info did not expose JSON-only transport policy: ${JSON.stringify(payload?.service)}`);
  }
}

try {
  await waitForHealth(port, child, () => stderr);

  await legacyClient.connect(legacyTransport);
  const legacyTools = await legacyClient.listTools();
  if (!legacyTools.tools.some((tool) => tool.name === 'server_info')) {
    throw new Error(`Legacy JSON gateway did not expose server_info: ${JSON.stringify(legacyTools.tools.map((tool) => tool.name))}`);
  }
  assertTransportPolicy(await legacyClient.callTool({ name: 'server_info', arguments: {} }), 'Legacy');

  await modernClient.connect(modernTransport);
  const modernTools = await modernClient.listTools();
  if (!modernTools.tools.some((tool) => tool.name === 'server_info')) {
    throw new Error(`Modern JSON gateway did not expose server_info: ${JSON.stringify(modernTools.tools.map((tool) => tool.name))}`);
  }
  assertTransportPolicy(await modernClient.callTool({ name: 'server_info', arguments: {} }), 'Modern');

  for (const label of ['legacy', 'modern']) {
    const jsonResponses = observed.filter((item) => item.label === label && item.method === 'POST' && item.status === 200);
    if (!jsonResponses.length) throw new Error(`No successful ${label} JSON POST responses were observed: ${JSON.stringify(observed)}`);
    if (jsonResponses.some((item) => !item.contentType.toLowerCase().includes('application/json'))) {
      throw new Error(`${label} gateway returned a non-JSON successful POST: ${JSON.stringify(observed)}`);
    }
  }
  if (observed.some((item) => item.contentType.toLowerCase().includes('text/event-stream'))) {
    throw new Error(`JSON-only gateway returned SSE: ${JSON.stringify(observed)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'legacy_2025_client_uses_stateless_json',
      'modern_2026_client_uses_json_response_mode',
      'gateway_never_returns_text_event_stream',
      'server_info_exposes_json_only_transport_policy',
    ],
    observed,
  }, null, 2));
} finally {
  for (const [client, transport] of [[legacyClient, legacyTransport], [modernClient, modernTransport]]) {
    try { await transport.terminateSession(); } catch {}
    try { await client.close(); } catch {}
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(dataRoot, { recursive: true, force: true });
}
