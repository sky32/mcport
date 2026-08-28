import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopRuntimeStore } from '../dist-desktop/runtime-store.js';
import { DEFAULT_ALLOWED_COMMANDS, PREVIOUS_DEFAULT_ALLOWED_COMMANDS } from '../shared/runtime-repository.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preferredGatewayPort = 47877;
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-smoke-user-data-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-app-smoke-${runId}`);

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

async function guardPreferredGatewayPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    });
    server.listen(preferredGatewayPort, '127.0.0.1', () => resolve(server));
  });
}

async function waitForHealth(port, expectedUp, timeoutMs = 12_000, child = null) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (expectedUp && child && child.exitCode !== null) {
      throw new Error(`Electron exited before Runtime became healthy (exit=${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { cache: 'no-store' });
      if (expectedUp && response.ok) return await response.json();
      if (!expectedUp) last = `HTTP ${response.status}`;
    } catch (error) {
      if (!expectedUp) return null;
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(expectedUp ? `Desktop Runtime did not start: ${last}` : `Desktop Runtime did not stop: ${last}`);
}

await rm(dataDir, { recursive: true, force: true });
await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
const preferredGatewayPortGuard = await guardPreferredGatewayPort();
const port = await freePort();
await writeFile(
  path.join(dataDir, 'desktop-settings.json'),
  `${JSON.stringify({
    settingsVersion: 19,
    workspaceRoot,
    registeredWorkspaces: [],
    selectedWorkspace: '',
    port,
    workspaceScope: [],
    workspaceServices: [],
    additionalServicesJson: '',
    authMode: 'none',
    proxyMode: 'manual',
    proxyScope: 'global',
    proxyUrl: 'http://127.0.0.1:1',
    proxyBypass: '',
    tunnelBaseDomain: '',
    launchAtLogin: false,
    minimizeToTray: true,
  }, null, 2)}\n`,
  'utf8',
);
const runtimeDbPath = path.join(dataDir, 'runtime', 'state.db');
const seedStore = await DesktopRuntimeStore.open(runtimeDbPath);
const seedRuntime = seedStore.getRuntimeSettings();
seedStore.replaceRuntimeSettings({ ...seedRuntime, allowedCommands: [...PREVIOUS_DEFAULT_ALLOWED_COMMANDS] });
seedStore.close();

const packagedExecutable = process.env.RW_MCP_DESKTOP_EXECUTABLE?.trim();
const electronBin = packagedExecutable
  ? path.resolve(packagedExecutable)
  : path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const electronArgs = packagedExecutable ? ['--hidden'] : ['.', '--hidden'];
const desktop = spawn(electronBin, electronArgs, {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
desktop.stdout.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  stdout += text;
  process.stdout.write(text);
});
desktop.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  stderr += text;
  process.stderr.write(text);
});

try {
  const health = await waitForHealth(port, true, 12_000, desktop);
  if (health?.serviceId !== 'default') throw new Error(`Unexpected service identity: ${JSON.stringify(health)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (/Unable to load preload script|Uncaught (TypeError|ReferenceError|SyntaxError)/.test(stderr)) {
    throw new Error('Desktop renderer/preload reported an uncaught error');
  }
  if (!stderr.includes('Renderer ready')) throw new Error('Desktop Renderer did not complete preload/IPC startup');
  desktop.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    timer.unref();
    desktop.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await waitForHealth(port, false);
  const migratedStore = await DesktopRuntimeStore.open(runtimeDbPath);
  const migratedCommands = migratedStore.getRuntimeSettings().allowedCommands;
  migratedStore.close();
  if (JSON.stringify(migratedCommands) !== JSON.stringify([...DEFAULT_ALLOWED_COMMANDS])) {
    throw new Error(`Default Allowed Commands were not upgraded: ${JSON.stringify(migratedCommands)}`);
  }
  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    port,
    mode: packagedExecutable ? 'packaged' : 'development',
    checks: [
      'electron_app_launch',
      'desktop_starts_runtime',
      'runtime_healthz',
      'manual_proxy_bypasses_loopback_runtime',
      'default_allowed_commands_upgraded',
      'preload_renderer_ready',
      'desktop_exit_stops_runtime',
    ],
  }, null, 2));
} catch (error) {
  desktop.kill('SIGTERM');
  const detail = [
    error instanceof Error ? error.message : String(error),
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n');
  throw new Error(detail);
} finally {
  await new Promise((resolve) => {
    if (!preferredGatewayPortGuard) return resolve();
    preferredGatewayPortGuard.close(resolve);
  });
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
