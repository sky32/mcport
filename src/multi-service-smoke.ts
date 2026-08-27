import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a free TCP port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForHealth(url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError ?? 'not ready')}`);
}

async function inspectMcp(url: string, deniedWorkspace?: string) {
  const client = new Client({ name: 'multi-service-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const info = await client.callTool({ name: 'server_info', arguments: {} });
    if (info.isError) throw new Error(`server_info failed for ${url}`);
    const payload = info.structuredContent as {
      service?: { id?: string; name?: string; path?: string };
      exposedWorkspaces?: string[];
      workspace?: { name?: string } | null;
    } | undefined;
    if (!payload) throw new Error(`server_info returned no structuredContent for ${url}`);
    if (!Array.isArray(payload.exposedWorkspaces)) throw new Error(`server_info returned invalid Workspace scope for ${url}`);
    let outOfScopeDenied: boolean | null = null;
    if (deniedWorkspace) {
      const denied = await client.callTool({ name: 'read_file', arguments: { workspace: deniedWorkspace, path: 'missing.txt' } });
      outOfScopeDenied = denied.isError === true;
    }
    return {
      serviceId: String(payload.service?.id ?? ''),
      serviceName: String(payload.service?.name ?? ''),
      servicePath: String(payload.service?.path ?? ''),
      workspaces: payload.exposedWorkspaces,
      inferredWorkspace: payload.workspace?.name ?? null,
      toolCount: tools.tools.length,
      protocolEra: client.getProtocolEra(),
      outOfScopeDenied,
    };
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      // Stateless sessions may have nothing to terminate.
    }
    await client.close();
  }
}

const primaryPort = await freePort();
let secondaryPort = await freePort();
while (secondaryPort === primaryPort) secondaryPort = await freePort();

const root = path.resolve('data/multi-service-smoke');
const workspaceRoot = path.join(root, 'workspaces');
const stateDbPath = path.join(root, 'state.db');
await rm(root, { recursive: true, force: true });
await mkdir(workspaceRoot, { recursive: true });
await mkdir(path.join(workspaceRoot, 'workspace-a'), { recursive: true });
await mkdir(path.join(workspaceRoot, 'workspace-b'), { recursive: true });

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(primaryPort),
    MCP_AUTH_MODE: 'none',
    ADMIN_ENABLED: 'false',
    WORKSPACE_ROOT: workspaceRoot,
    STATE_DB_PATH: stateDbPath,
    ALLOW_COMMAND_EXECUTION: 'false',
    MCP_ADDITIONAL_SERVICES_JSON: JSON.stringify([
      {
        id: 'secondary',
        name: 'secondary-workspace-mcp',
        host: '127.0.0.1',
        port: secondaryPort,
        path: '/mcp',
        workspaces: ['workspace-a'],
      },
    ]),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk: Buffer) => {
  stderr += chunk.toString('utf8');
});

try {
  const primaryHealth = await waitForHealth(`http://127.0.0.1:${primaryPort}/healthz`);
  const secondaryHealth = await waitForHealth(`http://127.0.0.1:${secondaryPort}/healthz`);
  if (primaryHealth.serviceId !== 'default') throw new Error('Primary service health did not report serviceId=default');
  if (secondaryHealth.serviceId !== 'secondary') throw new Error('Secondary service health did not report serviceId=secondary');

  const primary = await inspectMcp(`http://127.0.0.1:${primaryPort}/mcp`);
  const secondary = await inspectMcp(`http://127.0.0.1:${secondaryPort}/mcp`, 'workspace-b');
  if (primary.serviceId !== 'default' || primary.serviceName !== 'mcport') {
    throw new Error('Primary MCP identity is incorrect');
  }
  if (secondary.serviceId !== 'secondary' || secondary.serviceName !== 'secondary-workspace-mcp') {
    throw new Error('Secondary MCP identity is incorrect');
  }
  if (primary.toolCount === 0 || primary.toolCount !== secondary.toolCount) {
    throw new Error('MCP services did not expose the same generic tool surface');
  }
  if (!primary.workspaces.includes('workspace-a') || !primary.workspaces.includes('workspace-b')) {
    throw new Error('Primary MCP server_info did not expose both Workspaces');
  }
  if (secondary.workspaces.length !== 1 || secondary.workspaces[0] !== 'workspace-a') {
    throw new Error('Secondary MCP workspace scope was not enforced in server_info');
  }
  if (secondary.inferredWorkspace !== 'workspace-a' || primary.inferredWorkspace !== null) {
    throw new Error('Single-vs-multi Workspace inference in server_info is incorrect');
  }
  if (secondary.outOfScopeDenied !== true) {
    throw new Error('Secondary MCP service allowed access to an out-of-scope workspace');
  }

  console.log(JSON.stringify({
    ok: true,
    services: [
      { id: primary.serviceId, name: primary.serviceName, port: primaryPort, path: primary.servicePath },
      { id: secondary.serviceId, name: secondary.serviceName, port: secondaryPort, path: secondary.servicePath },
    ],
    toolCount: primary.toolCount,
    checks: [
      'simultaneous_listeners',
      'independent_health_identity',
      'independent_mcp_identity',
      'tools_list_both_services',
      'server_info_both_services',
      'per_service_workspace_scope',
      'single_workspace_inference',
      'out_of_scope_workspace_rejected',
    ],
  }, null, 2));
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(`Multi-service child exited with ${child.exitCode}: ${stderr}`);
  }
}
