import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-workspace-services-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-workspace-services-${runId}`);
const externalWorkspace = path.join(root, 'data', `desktop-external-workspace-${runId}`, 'workspace-b');

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

async function waitHealth(port, expectedUp = true, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { cache: 'no-store' });
      if (expectedUp && response.ok) return await response.json();
    } catch {
      if (!expectedUp) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Port ${port} did not become ${expectedUp ? 'healthy' : 'closed'}`);
}

async function inspectWorkspaceService(port, expectedWorkspace, deniedWorkspace, expectedTier, expectedMarker = null) {
  const client = new Client({ name: 'desktop-workspace-service-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await client.connect(transport);
    const info = await client.callTool({ name: 'server_info', arguments: {} });
    const infoPayload = info.structuredContent;
    if (info.isError || infoPayload?.service?.name !== `workspace:${expectedWorkspace}`) {
      throw new Error(`Unexpected service identity on ${port}: ${JSON.stringify(infoPayload)}`);
    }
    if (infoPayload?.service?.toolTier !== expectedTier || infoPayload?.workspace?.name !== expectedWorkspace) {
      throw new Error(`Unexpected tool tier on ${port}: ${JSON.stringify(infoPayload)}`);
    }
    const tools = await client.listTools();
    const names = new Set(tools.tools.map((tool) => tool.name));
    if (expectedTier === 'readonly') {
      if (names.has('apply_patch') || names.has('exec_command')) throw new Error(`Readonly Workspace exposed mutation/command tools on ${port}`);
    } else if (!names.has('apply_patch') || !names.has('exec_command')) {
      throw new Error(`Full Workspace did not expose full tool surface on ${port}`);
    }
    if (names.has('workspace_list') || names.has('workspace_info') || names.has('workspace_create')) {
      throw new Error(`Legacy Workspace catalog tools are still exposed on ${port}`);
    }
    const denied = await client.callTool({ name: 'read_file', arguments: { workspace: deniedWorkspace, path: 'registry-marker.txt' } });
    if (denied.isError !== true) throw new Error(`Out-of-scope Workspace ${deniedWorkspace} was accessible on ${port}`);
    if (expectedMarker) {
      const file = await client.callTool({ name: 'read_file', arguments: { path: 'registry-marker.txt' } });
      if (file.isError || !JSON.stringify(file.structuredContent).includes(expectedMarker)) {
        throw new Error(`Workspace ${expectedWorkspace} did not resolve to its registered local path`);
      }
    }
  } finally {
    try { await transport.terminateSession(); } catch {}
    await client.close();
  }
}

await rm(dataDir, { recursive: true, force: true });
await rm(workspaceRoot, { recursive: true, force: true });
await rm(path.dirname(externalWorkspace), { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(path.join(workspaceRoot, 'workspace-a'), { recursive: true });
await mkdir(externalWorkspace, { recursive: true });
await writeFile(path.join(externalWorkspace, 'registry-marker.txt'), 'external-workspace-registry-ok', 'utf8');

const defaultPort = await freePort();
const presetWorkspaceBPort = await freePort();
await writeFile(path.join(dataDir, 'desktop-settings.json'), `${JSON.stringify({
  settingsVersion: 7,
  workspaceRoot,
  registeredWorkspaces: [{ name: 'workspace-b', path: externalWorkspace }],
  selectedWorkspace: '',
  port: defaultPort,
  workspaceScope: [],
  workspaceServices: [{
    workspace: 'workspace-b',
    enabled: true,
    port: presetWorkspaceBPort,
    publicEnabled: false,
    publicAuthMode: 'token',
    toolTier: 'readonly',
  }],
  additionalServicesJson: '',
  authMode: 'none',
  tunnelBaseDomain: '',
  startTunnelWithRuntime: false,
  launchAtLogin: false,
  minimizeToTray: false,
}, null, 2)}\n`, 'utf8');

const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electronBin, ['.', '--hidden', '--no-sandbox', '--disable-gpu'], {
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
  await waitHealth(defaultPort);
  let generatedSettings;
  const settingsDeadline = Date.now() + 8_000;
  while (Date.now() < settingsDeadline) {
    generatedSettings = JSON.parse(await readFile(path.join(dataDir, 'desktop-settings.json'), 'utf8'));
    if (generatedSettings.workspaceServices?.length === 2 && generatedSettings.selectedWorkspace) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const serviceA = generatedSettings?.workspaceServices?.find((item) => item.workspace === 'workspace-a');
  const serviceB = generatedSettings?.workspaceServices?.find((item) => item.workspace === 'workspace-b');
  if (!serviceA || serviceA.enabled !== false) throw new Error('Newly discovered Workspace MCP service must default to disabled');
  if (!serviceB?.enabled) throw new Error('Existing Workspace MCP enabled state was not preserved');
  if (generatedSettings.selectedWorkspace !== 'workspace-a') throw new Error(`Unexpected selected Workspace: ${generatedSettings.selectedWorkspace}`);
  const portA = serviceA.port;
  const portB = serviceB.port;
  await waitHealth(portB);
  if (stderr.includes('workspace:workspace-a') || stderr.includes(`127.0.0.1:${portA}/mcp`)) {
    throw new Error(`Disabled workspace-a unexpectedly started an MCP listener on ${portA}`);
  }
  await inspectWorkspaceService(portB, 'workspace-b', 'workspace-a', 'readonly', 'external-workspace-registry-ok');
  desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await Promise.all([waitHealth(defaultPort, false), waitHealth(portB, false)]);
  console.log(JSON.stringify({
    ok: true,
    ports: { default: defaultPort, workspaceA: portA, workspaceB: portB },
    checks: [
      'new_workspace_mcp_defaults_disabled',
      'disabled_workspace_runtime_not_started',
      'workspace_service_b_listener',
      'existing_workspace_mcp_enabled_preserved',
      'workspace_services_auto_provisioned',
      'arbitrary_workspace_directory_registered',
      'registered_workspace_file_access',
      'current_workspace_auto_selected',
      'workspace_b_scope',
      'workspace_tool_tier_persisted',
      'workspace_readonly_tool_surface',
      'cross_workspace_access_rejected',
      'desktop_exit_closes_all_workspace_services',
    ],
  }, null, 2));
} catch (error) {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nstderr:\n${stderr}`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(path.dirname(externalWorkspace), { recursive: true, force: true });
}
