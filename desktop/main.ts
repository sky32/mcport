import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  nativeImage,
  net,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { createHash, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer as createNetServer } from 'node:net';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toolTierSchema,
  workspaceNameSchema,
  workspaceServiceSchema,
} from '../shared/schemas.js';
import {
  DEFAULT_ALLOWED_COMMANDS,
  PREVIOUS_DEFAULT_ALLOWED_COMMANDS,
} from '../shared/runtime-repository.js';
import { DesktopRuntimeStore, defaultRuntimeSettings, normalizeRuntimeSettings } from './runtime-store.js';
import {
  installManagedBinary,
  installLatestManagedBinary,
  latestManagedBinaryVersion,
  managedBinaryStatus,
  rollbackManagedBinary,
  type ManagedBinaryKind,
  type ManagedBinaryStatus,
  type ManagedBinaryInstallProgress,
} from './managed-binaries.js';
import { installManagedLsp, managedLspStatus, type ManagedLspProgress, type ManagedLspStatus } from './managed-lsp.js';
import { checkForAppUpdate } from './app-updater.js';
import { computerUseStatus, performComputerAction, requestComputerUsePermissions, type ComputerAction } from './computer-use.js';

type AuthMode = 'none' | 'token';
type ProxyMode = 'off' | 'system' | 'manual';
type ProxyScope = 'global' | 'tunnel' | 'runtime';
type AppearanceMode = 'system' | 'light' | 'dark';
type UiLanguageMode = 'system' | 'zh-CN' | 'en-US';
type DebugMode = 'off' | 'basic' | 'detailed';
type PublicAccessProvider = 'cloudflare' | 'trycloudflare' | 'frp' | 'external';
type PublicClientMode = 'managed' | 'custom';
type CloudflareTransportProtocol = 'auto' | 'quic' | 'http2';
type CloudflareEdgeIpVersion = 'auto' | '4' | '6';
type FrpTransportProtocol = 'tcp' | 'quic' | 'kcp';
type WorkspacePublicAuthMode = 'token' | 'oauth';
type WorkspaceToolTier = 'readonly' | 'standard' | 'full';
type RuntimePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

const INTERNAL_GATEWAY_PORT = 47877;
const FIRST_WORKSPACE_MCP_PORT = 8788;

type DesktopSettings = {
  settingsVersion: number;
  workspaceRoot: string;
  registeredWorkspaces: DesktopWorkspace[];
  selectedWorkspace: string;
  port: number;
  workspaceScope: string[];
  workspaceServices: WorkspaceServiceSettings[];
  additionalServicesJson: string;
  authMode: AuthMode;
  proxyMode: ProxyMode;
  /** @deprecated retained for settings-file compatibility; proxy now applies globally. */
  proxyScope: ProxyScope;
  tunnelProxyEnabled: boolean;
  proxyUrl: string;
  proxyBypass: string;
  appearance: AppearanceMode;
  uiLanguage: UiLanguageMode;
  debugMode: DebugMode;
  lowMemoryTray: boolean;
  computerUseEnabled: boolean;
  computerUsePublicEnabled: boolean;
  publicAccessProvider: PublicAccessProvider;
  publicClientMode: PublicClientMode;
  publicClientPath: string;
  publicClientVersion: string;
  cloudflareTransportProtocol: CloudflareTransportProtocol;
  cloudflareEdgeIpVersion: CloudflareEdgeIpVersion;
  tunnelBaseDomain: string;
  frpServerAddr: string;
  frpServerPort: number;
  frpSubdomain: string;
  frpTransportProtocol: FrpTransportProtocol;
  frpUseCompression: boolean;
  /** @deprecated retained for settings-file compatibility; HTTP FRP no longer uses it. */
  frpRemotePort: number;
  startTunnelWithRuntime: boolean;
  launchAtLogin: boolean;
  minimizeToTray: boolean;
};

type DesktopWorkspace = {
  name: string;
  path: string;
};

type WorkspaceServiceSettings = {
  workspace: string;
  enabled: boolean;
  port: number;
  publicEnabled: boolean;
  publicPath: string;
  publicAuthMode: WorkspacePublicAuthMode;
  toolTier: WorkspaceToolTier;
};

type RuntimeSettings = {
  runtimePath: string;
  allowedCommands: string[];
  allowCommandExecution: boolean;
  allowExternalNetwork: boolean;
  requireHighRiskConfirmation: boolean;
  highRiskConfirmationMode: 'local' | 'none' | 'none_with_computer_use';
  networkIsolationRequired: boolean;
  lspEnabled: boolean;
  lspRequestTimeoutMs: number;
  lspTypeScriptCommand: string;
  lspHtmlCommand: string;
  lspCssCommand: string;
  lspCustomServers: string;
  maxFileBytes: number;
  maxCommandOutputBytes: number;
  defaultCommandTimeoutMs: number;
  maxCommandTimeoutMs: number;
};

type RuntimeProfile = {
  id: string;
  name: string;
  runtimePath: string | null;
  allowedCommands: string[] | null;
  allowCommandExecution: boolean | null;
  allowExternalNetwork: boolean | null;
  requireHighRiskConfirmation: boolean | null;
  highRiskConfirmationMode: 'local' | 'none' | 'none_with_computer_use' | null;
  maxCommandOutputBytes: number | null;
  defaultCommandTimeoutMs: number | null;
  maxCommandTimeoutMs: number | null;
};

type RuntimeAdminSnapshot = {
  runtime: RuntimeSettings;
  defaultAllowedCommands: string[];
  profiles: RuntimeProfile[];
  workspaces: Array<{ name: string; profile: { id: string; name: string } | null }>;
  mcpServices: Array<{
    id: string;
    name: string;
    host: string;
    port: number;
    path: string;
    admin: boolean;
    publicUrl: string;
    workspaces: string[] | null;
  }>;
  toolExposureByWorkspace: Record<string, {
    toolTier: WorkspaceToolTier;
    localSurface: 'full';
    publicSurface: 'core';
    localExposedCount: number | null;
    publicExposedCount: number | null;
    catalogCount: number | null;
  }>;
};

type SecretFile = {
  apiToken?: string;
  tunnelToken?: string;
  frpToken?: string;
  workspaceApiTokens?: Record<string, string>;
  workspaceOauthAuthorizationSecrets?: Record<string, string>;
  workspaceOauthSigningKeys?: Record<string, string>;
};

type SaveJournal = {
  version: 1;
  previousSettings: DesktopSettings;
  previousRuntime: RuntimeSettings;
  previousSecrets: SecretFile;
};

type RuntimeState = {
  phase: RuntimePhase;
  pid: number | null;
  startedAt: string | null;
  error: string | null;
  publicUrl?: string | null;
  ephemeral?: boolean;
  retryAt?: string | null;
  retryDelayMs?: number | null;
  retryAttempt?: number | null;
  retryMode?: 'quick' | 'recovery' | null;
  readinessStage?: 'requesting_url' | 'runtime_reload' | 'propagating' | 'ready' | null;
  readyAt?: string | null;
};

type HealthProbeStatus = 'healthy' | 'unhealthy' | 'disabled' | 'stopped';

type HealthProbeResult = {
  ok: boolean;
  status: HealthProbeStatus;
  url: string;
  latencyMs: number | null;
  httpStatus: number | null;
  message: string;
};

type WorkspaceHealthResult = {
  workspace: string;
  local: HealthProbeResult;
  public: HealthProbeResult;
};

type PublicAccessCheckResult = {
  ok: boolean;
  summary: string;
  localGateway: HealthProbeResult;
  routes: Array<{ workspace: string; probe: HealthProbeResult }>;
};

type DesktopState = {
  revision: number;
  warnings: string[];
  platform: NodeJS.Platform;
  version: string;
  settings: DesktopSettings;
  runtime: RuntimeState;
  tunnel: RuntimeState;
  endpoint: string;
  selectedWorkspace: string;
  workspacePath: string;
  hasApiToken: boolean;
  workspaceTokenWorkspaces: string[];
  workspaceOauthWorkspaces: string[];
  hasTunnelToken: boolean;
  hasFrpToken: boolean;
  managedBinaries: Record<ManagedBinaryKind, ManagedBinaryStatus>;
  managedLsp: ManagedLspStatus;
  computerUse: { enabled: boolean; available: boolean; platform: NodeJS.Platform; screen: unknown; permissions: unknown; error?: unknown };
  encryptionAvailable: boolean;
  logs: string[];
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_LINES = 300;

const userDataOverride = process.env.RW_MCP_DESKTOP_USER_DATA?.trim();
if (userDataOverride) app.setPath('userData', path.resolve(userDataOverride));
if (process.platform === 'win32') app.setAppUserModelId('com.mcport.app');
if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_MAIN_LOADED');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let runtimeProcess: UtilityProcess | null = null;
let runtimeGeneration = 0;
let tunnelProcess: ChildProcess | null = null;
let settings: DesktopSettings;
let runtimeState: RuntimeState = { phase: 'stopped', pid: null, startedAt: null, error: null };
let tunnelState: RuntimeState = { phase: 'stopped', pid: null, startedAt: null, error: null };
let logs: string[] = [];
let isQuitting = false;
let desktopRuntimeStore: DesktopRuntimeStore | null = null;
let runtimeMutationQueue: Promise<void> = Promise.resolve();
let runtimeRecoveryTimer: NodeJS.Timeout | null = null;
let runtimeRecoveryAttempt = 0;
let tunnelRecoveryTimer: NodeJS.Timeout | null = null;
let tunnelRecoveryResetTimer: NodeJS.Timeout | null = null;
let tunnelRecoveryAttempt = 0;
const TUNNEL_STABLE_RESET_MS = 60_000;
let tunnelDesiredRunning = false;
let tunnelAutostartSuppressed = false;
let localConfirmationPollTimer: NodeJS.Timeout | null = null;
let oauthInteractionPollTimer: NodeJS.Timeout | null = null;
const localConfirmationToken = randomBytes(32).toString('base64url');
let localConfirmationBusy = false;
let oauthInteractionBusy = false;

type RuntimeControlMethod = 'health' | 'tool_catalog' | 'local_confirmations' | 'local_confirmation_decision' | 'oauth_interactions' | 'oauth_interaction_ack';
type RuntimeControlResponse = { type: 'mcport:runtime-control-response'; id: string; ok: boolean; result?: unknown; error?: string };
type DesktopActionRequest = {
  type: 'mcport:desktop-action-request';
  id: string;
  action: ComputerAction;
  params?: Record<string, unknown>;
  source?: 'local' | 'public';
};
const runtimeControlPending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let runtimeControlSequence = 0;

function rejectRuntimeControlRequests(error: Error): void {
  for (const [id, pending] of runtimeControlPending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    runtimeControlPending.delete(id);
  }
}

function handleRuntimeControlMessage(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const desktopRequest = raw as Partial<DesktopActionRequest>;
  if (desktopRequest.type === 'mcport:desktop-action-request' && typeof desktopRequest.id === 'string' && typeof desktopRequest.action === 'string') {
    const child = runtimeProcess;
    void (async () => {
      if (!settings.computerUseEnabled) throw new Error('Computer Use is disabled in MCPort settings');
      if (desktopRequest.source === 'public' && !settings.computerUsePublicEnabled) {
        throw new Error('Public Computer Use is disabled in MCPort settings');
      }
      return performComputerAction(desktopRequest.action as ComputerAction, desktopRequest.params && typeof desktopRequest.params === 'object' ? desktopRequest.params : {});
    })()
      .then((result) => child?.postMessage({ type: 'mcport:desktop-action-response', id: desktopRequest.id, ok: true, result }))
      .catch((error) => child?.postMessage({ type: 'mcport:desktop-action-response', id: desktopRequest.id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  const message = raw as Partial<RuntimeControlResponse>;
  if (message.type !== 'mcport:runtime-control-response' || typeof message.id !== 'string') return;
  const pending = runtimeControlPending.get(message.id);
  if (!pending) return;
  runtimeControlPending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.ok) pending.resolve(message.result);
  else pending.reject(new Error(message.error || 'Runtime IPC request failed'));
}

function requestRuntimeControl<T>(method: RuntimeControlMethod, params: Record<string, unknown> = {}, timeoutMs = 2_000): Promise<T> {
  const child = runtimeProcess;
  if (!child || runtimeState.phase === 'stopped' || runtimeState.phase === 'error') return Promise.reject(new Error('Runtime IPC is unavailable'));
  const id = `desktop-control-${process.pid}-${++runtimeControlSequence}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      runtimeControlPending.delete(id);
      reject(new Error(`Runtime IPC request timed out: ${method}`));
    }, timeoutMs);
    timer.unref();
    runtimeControlPending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      child.postMessage({ type: 'mcport:runtime-control-request', id, method, params });
    } catch (error) {
      clearTimeout(timer);
      runtimeControlPending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

type LocalConfirmationPayload = {
  id: string;
  workspace: string;
  action: string;
  risk: { categories?: string[]; reasons?: string[] };
  expiresAt: string;
};

type OAuthInteractionPayload = {
  id: string;
  workspace: string;
  clientName: string;
  clientId: string;
  openedAt: string;
  expiresAt: string;
};

const localConfirmationCategoryLabels: Record<string, string> = {
  dependency_change: '依赖变更：可能下载、安装或更新项目依赖',
  destructive_command: '破坏性命令：可能丢弃或破坏现有工作区改动',
  network_access: '外部网络：会连接互联网或远程服务',
  file_delete: '文件删除：会删除 Workspace 内的文件或目录',
  overwrite: '内容覆盖：可能替换已有文件内容',
  checkpoint_restore: '检查点恢复：会把文件恢复到历史状态',
  operation_reconcile: '操作裁决：会根据外部证据确认未知操作的最终状态',
  screen_capture: '屏幕截图：可能包含项目之外的窗口或敏感信息',
  desktop_control: '桌面控制：会操作 Workspace 之外的本机应用',
};

function localConfirmationDetail(request: LocalConfirmationPayload): string {
  const categories = [...new Set(request.risk.categories ?? [])]
    .map((category) => localConfirmationCategoryLabels[category] || category);
  const reasons = [...new Set(request.risk.reasons ?? [])];
  const expiresAt = new Date(request.expiresAt);
  const expiryText = Number.isNaN(expiresAt.getTime())
    ? '本次请求将在短时间后自动拒绝。'
    : `本次请求将在 ${expiresAt.toLocaleTimeString()} 自动拒绝。`;
  const sections = [
    '这是一次高风险操作，请确认你了解它的影响。',
    categories.length ? `风险类型\n${categories.map((item) => `• ${item}`).join('\n')}` : '',
    reasons.length ? `触发原因\n${reasons.map((item) => `• ${item}`).join('\n')}` : '',
    '授权范围\n• 仅允许当前这一次操作\n• 不会改变其他 Workspace 的权限设置',
    expiryText,
  ];
  return sections.filter(Boolean).join('\n\n');
}

async function postLocalConfirmationDecision(id: string, approved: boolean): Promise<void> {
  await requestRuntimeControl('local_confirmation_decision', { id, approved, token: localConfirmationToken });
}

async function pollLocalConfirmations(): Promise<void> {
  if (isQuitting) return;
  try {
    if (runtimeState.phase !== 'running' || localConfirmationBusy) return;
    const payload = await requestRuntimeControl<{ confirmations?: LocalConfirmationPayload[] }>('local_confirmations', { token: localConfirmationToken });
    const request = payload.confirmations?.[0];
    if (!request) return;
    localConfirmationBusy = true;
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    const options = {
      type: 'warning' as const,
      title: 'MCPort · 高风险操作确认',
      message: `Workspace：${request.workspace}\n\n即将执行\n${request.action}`,
      detail: localConfirmationDetail(request),
      buttons: ['拒绝', '允许本次'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    try {
      await postLocalConfirmationDecision(request.id, result.response === 1);
    } catch (error) {
      appendLog('desktop', `Local confirmation response failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch {
    // Runtime may be starting/restarting; the pending request is fail-closed by its own timeout.
  } finally {
    localConfirmationBusy = false;
    if (!isQuitting) {
      localConfirmationPollTimer = setTimeout(() => { void pollLocalConfirmations(); }, 400);
      localConfirmationPollTimer.unref();
    }
  }
}

async function pollOAuthInteractionNotices(): Promise<void> {
  if (isQuitting) return;
  try {
    if (runtimeState.phase !== 'running' || oauthInteractionBusy) return;
    const payload = await requestRuntimeControl<{ interactions?: OAuthInteractionPayload[] }>('oauth_interactions', { token: localConfirmationToken });
    const request = payload.interactions?.[0];
    if (!request) return;
    oauthInteractionBusy = true;
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    const options = {
      type: 'info' as const,
      title: 'MCPort · OAuth 授权',
      message: `${request.workspace} 正在请求 OAuth 授权`,
      detail: `客户端：${request.clientName || 'MCP Client'}\n\n浏览器授权页已打开。复制当前 Workspace 的授权密钥，然后粘贴到浏览器授权页即可继续。`,
      buttons: ['关闭', '复制授权密钥'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 1) {
      try {
        const credentials = await ensureWorkspaceBuiltinOauthSecrets(request.workspace);
        clipboard.writeText(credentials.authorizationSecret);
        appendLog('desktop', `OAuth authorization secret copied for Workspace ${request.workspace}`);
      } catch (error) {
        appendLog('desktop', `OAuth authorization secret copy failed: ${error instanceof Error ? error.message : String(error)}`);
        dialog.showErrorBox('MCPort · OAuth 授权', `无法复制授权密钥：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await requestRuntimeControl('oauth_interaction_ack', { id: request.id, token: localConfirmationToken });
    } catch (error) {
      appendLog('desktop', `OAuth interaction acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch {
    // Runtime may be starting/restarting; retry on the next local IPC poll.
  } finally {
    oauthInteractionBusy = false;
    if (!isQuitting) {
      oauthInteractionPollTimer = setTimeout(() => { void pollOAuthInteractionNotices(); }, 500);
      oauthInteractionPollTimer.unref();
    }
  }
}

function queueRuntimeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = runtimeMutationQueue.then(operation, operation);
  runtimeMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function workspaceOauthIssuer(service: WorkspaceServiceSettings): string {
  const resource = workspacePublicEndpoint(service);
  if (!resource) throw new Error(`Workspace ${service.workspace} 尚未配置 OAuth 公网地址`);
  const url = new URL(resource);
  url.pathname = url.pathname.replace(/\/mcp\/?$/, '') || '/';
  url.search = '';
  url.hash = '';
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
let stateRevision = 0;
let broadcastQueued = false;
let desktopOnlySaveSmokeRan = false;
const startupWarnings: string[] = [];

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function normalizeFrpServerAddr(value: unknown): string {
  const address = String(value ?? '').trim();
  if (!address) return '';
  const colonCount = (address.match(/:/g) || []).length;
  if (address.length > 253 || /\s/.test(address) || address.includes('://') || /[/?#@\[\]]/.test(address) || colonCount === 1) {
    throw new Error('FRP Server 只填写域名或 IP，不带协议、端口、路径或认证信息');
  }
  return address;
}

function toolTraceFilePath(): string {
  return path.join(app.getPath('userData'), 'runtime', 'tool-traces.ndjson');
}

async function readToolTraces(limit = 500): Promise<unknown[]> {
  try {
    const lines = (await readFile(toolTraceFilePath(), 'utf8')).split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(limit, 1000)));
    return lines.map((line) => {
      try { return JSON.parse(line); } catch { return { status: 'error', error: '无法解析 Trace 记录' }; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readToolTraceStats(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(`${toolTraceFilePath()}.stats.json`, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw error;
  }
}

type RuntimeToolCatalogEntry = {
  name: string;
  title?: string | null;
  description?: string;
  tiers?: string[];
  surfaces?: string[];
  exposedToModel?: boolean;
  annotations?: Record<string, boolean> | null;
};

type RuntimeToolCatalogSnapshot = {
  workspace: string | null;
  toolTier: string;
  surfaceProfile: string;
  exposedCount: number;
  catalogCount: number;
  tools: RuntimeToolCatalogEntry[];
};

async function readRuntimeToolCatalog(workspace = ''): Promise<RuntimeToolCatalogSnapshot> {
  const empty = { workspace: workspace || null, toolTier: 'full', surfaceProfile: workspace ? 'core' : 'full', exposedCount: 0, catalogCount: 0, tools: [] };
  if (runtimeState.phase !== 'running') return empty;
  const deadline = Date.now() + 2_000;
  do {
    try {
      const payload = await requestRuntimeControl<Partial<RuntimeToolCatalogSnapshot> & { tools?: unknown }>('tool_catalog', workspace ? { workspace } : {}, 500);
      if (Array.isArray(payload.tools)) {
        const tools = payload.tools.filter((item): item is RuntimeToolCatalogEntry => Boolean(item && typeof item === 'object' && typeof (item as RuntimeToolCatalogEntry).name === 'string'));
        return {
          workspace: typeof payload.workspace === 'string' ? payload.workspace : workspace || null,
          toolTier: typeof payload.toolTier === 'string' ? payload.toolTier : 'full',
          surfaceProfile: typeof payload.surfaceProfile === 'string' ? payload.surfaceProfile : workspace ? 'core' : 'full',
          exposedCount: Number.isFinite(Number(payload.exposedCount)) ? Number(payload.exposedCount) : tools.filter((item) => item.exposedToModel === true).length,
          catalogCount: Number.isFinite(Number(payload.catalogCount)) ? Number(payload.catalogCount) : tools.length,
          tools,
        };
      }
    } catch {}
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return empty;
}

async function debugSnapshot(): Promise<Record<string, unknown>> {
  const [traces, toolCatalogSnapshot, toolStats] = await Promise.all([
    settings.debugMode === 'off' ? Promise.resolve([]) : readToolTraces(1000),
    readRuntimeToolCatalog(settings.selectedWorkspace),
    readToolTraceStats(),
  ]);
  return {
    debugMode: settings.debugMode,
    traces,
    toolCatalog: toolCatalogSnapshot.tools,
    toolExposure: {
      workspace: toolCatalogSnapshot.workspace,
      toolTier: toolCatalogSnapshot.toolTier,
      surfaceProfile: toolCatalogSnapshot.surfaceProfile,
      exposedCount: toolCatalogSnapshot.exposedCount,
      catalogCount: toolCatalogSnapshot.catalogCount,
    },
    toolStats,
  };
}

async function clearToolTraces(): Promise<void> {
  await Promise.all([
    rm(toolTraceFilePath(), { force: true }),
    rm(`${toolTraceFilePath()}.stats.json`, { force: true }),
  ]);
}

type ManagedClientProgress = Omit<ManagedBinaryInstallProgress, 'phase'> & {
  phase: ManagedBinaryInstallProgress['phase'] | 'restarting' | 'failed';
};

function emitManagedClientInstallProgress(progress: ManagedClientProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:managed-client-progress', progress);
}

function emitManagedLspProgress(progress: ManagedLspProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:managed-lsp-progress', progress);
}

async function installLsp(languageId: string): Promise<ManagedLspStatus> {
  const task = managedLspInstallQueue.then(() => installLspNow(languageId));
  managedLspInstallQueue = task.then(() => undefined, () => undefined);
  return task;
}

let managedLspInstallQueue: Promise<void> = Promise.resolve();

async function installLspNow(languageId: string): Promise<ManagedLspStatus> {
  try {
    const runtime = await runtimeStore();
    const result = await installManagedLsp(app.getPath('userData'), languageId, runtime.getRuntimeSettings().runtimePath, emitManagedLspProgress);
    appendLog('desktop', 'Managed LSP 已安装');
    broadcastState();
    if (runtimeState.phase === 'running' || runtimeState.phase === 'starting') await restartRuntime();
    return result;
  } catch (error) {
    emitManagedLspProgress({ language: languageId, phase: 'error', message: `LSP 安装失败：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
}

let managedClientMutationQueue: Promise<void> = Promise.resolve();

function queueManagedClientMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = managedClientMutationQueue.then(operation, operation);
  managedClientMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function installManagedClientNow(kindValue: unknown, versionValue: unknown = ''): Promise<ManagedBinaryStatus> {
  const kind = String(kindValue) === 'frpc' ? 'frpc' : 'cloudflared';
  const version = String(versionValue || '').trim();
  const activeKind: ManagedBinaryKind = settings.publicAccessProvider === 'frp' ? 'frpc' : 'cloudflared';
  const wasRunning = settings.publicAccessProvider !== 'external' && activeKind === kind
    && (tunnelState.phase === 'running' || tunnelState.phase === 'starting');
  const before = await managedBinaryStatus(app.getPath('userData'), kind);
  const report = (progress: ManagedBinaryInstallProgress) => emitManagedClientInstallProgress(progress);
  let installed: ManagedBinaryStatus;
  try {
    installed = version
      ? await installManagedBinary(app.getPath('userData'), kind, managedDownloadFetch, version, report)
      : await installLatestManagedBinary(app.getPath('userData'), kind, managedDownloadFetch, report);
  } catch (error) {
    emitManagedClientInstallProgress({ kind, phase: 'failed', percent: 0, message: `安装失败：${error instanceof Error ? error.message : String(error)}` });
    throw error;
  }
  if (settings.publicClientMode === 'managed' && activeKind === kind) {
    settings = { ...settings, publicClientVersion: version ? installed.version : '' };
    await persistSettings(settings);
    const changedVersion = !before.installed || before.version.replace(/^v/, '') !== installed.version.replace(/^v/, '');
    if (wasRunning && changedVersion) {
      emitManagedClientInstallProgress({ kind, phase: 'restarting', percent: 99, message: '客户端已安装，正在重启公网连接…', version: installed.version });
      await stopTunnel();
      const restarted = await startTunnel();
      if (restarted.tunnel.phase !== 'running') {
        const failedReason = restarted.tunnel.error || `${kind} 更新后未成功启动`;
        try {
          await stopTunnel();
          const rolledBack = await rollbackManagedBinary(app.getPath('userData'), kind);
          settings = { ...settings, publicClientVersion: rolledBack.version };
          await persistSettings(settings);
          const recovered = await startTunnel();
          if (recovered.tunnel.phase === 'running') {
            throw new Error(`${kind} ${installed.version} 启动失败，已自动回滚到 ${rolledBack.version}：${failedReason}`);
          }
          throw new Error(`${kind} ${installed.version} 启动失败，回滚到 ${rolledBack.version} 后仍未恢复：${recovered.tunnel.error || recovered.tunnel.phase}`);
        } catch (rollbackError) {
          if (rollbackError instanceof Error && rollbackError.message.includes('已自动回滚到')) throw rollbackError;
          throw new Error(`${kind} ${installed.version} 启动失败，自动回滚也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}；原始错误：${failedReason}`);
        }
      }
    }
  }
  emitManagedClientInstallProgress({ kind, phase: 'complete', percent: 100, message: `${kind} ${installed.version} 已安装完成`, version: installed.version });
  appendLog('desktop', `${kind} ${installed.version} 动态安装完成`);
  broadcastState();
  return installed;
}

async function rollbackManagedClientNow(kindValue: unknown): Promise<{ state: DesktopState; binary: ManagedBinaryStatus }> {
  const kind: ManagedBinaryKind = String(kindValue) === 'frpc' ? 'frpc' : 'cloudflared';
  const activeKind: ManagedBinaryKind = settings.publicAccessProvider === 'frp' ? 'frpc' : 'cloudflared';
  const wasRunning = settings.publicAccessProvider !== 'external' && activeKind === kind
    && (tunnelState.phase === 'running' || tunnelState.phase === 'starting');
  const binary = await rollbackManagedBinary(app.getPath('userData'), kind);
  if (settings.publicClientMode === 'managed' && activeKind === kind) {
    settings = { ...settings, publicClientVersion: binary.version };
    await persistSettings(settings);
    if (wasRunning) {
      await stopTunnel();
      const restarted = await startTunnel();
      if (restarted.tunnel.phase !== 'running') throw new Error(restarted.tunnel.error || `${kind} 回滚后未成功启动`);
    }
  }
  appendLog('desktop', `${kind} 已回滚到 ${binary.version}`);
  broadcastState();
  return { state: await stateWithSecrets(), binary };
}

function installManagedClient(kindValue: unknown, versionValue: unknown = ''): Promise<ManagedBinaryStatus> {
  return queueManagedClientMutation(() => installManagedClientNow(kindValue, versionValue));
}

function rollbackManagedClient(kindValue: unknown): Promise<{ state: DesktopState; binary: ManagedBinaryStatus }> {
  return queueManagedClientMutation(() => rollbackManagedClientNow(kindValue));
}

async function probeMcpInitializeUrl(endpoint: string, token = ''): Promise<HealthProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'desktop-health-check', version: app.getVersion() },
      },
    });
    const response = await net.fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
    const latencyMs = Date.now() - startedAt;
    const sessionId = response.headers.get('mcp-session-id') || '';
    if (!response.ok) {
      return { ok: false, status: 'unhealthy', url: endpoint, latencyMs, httpStatus: response.status, message: `MCP initialize HTTP ${response.status}` };
    }
    const text = await response.text();
    if (sessionId) {
      void net.fetch(endpoint, {
        method: 'DELETE',
        cache: 'no-store',
        headers: {
          Accept: 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId,
          'MCP-Protocol-Version': '2025-06-18',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }).catch(() => {});
    }
    if (!text.includes('"result"') || text.includes('"error"')) {
      return { ok: false, status: 'unhealthy', url: endpoint, latencyMs, httpStatus: response.status, message: 'MCP initialize 未返回成功结果' };
    }
    return { ok: true, status: 'healthy', url: endpoint, latencyMs, httpStatus: response.status, message: `MCP initialize 正常 · ${latencyMs} ms` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      status: 'unhealthy',
      url: endpoint,
      latencyMs,
      httpStatus: null,
      message: error instanceof Error && error.name === 'AbortError' ? 'MCP initialize 超时' : `MCP initialize 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeOauthBootstrap(endpoint: string): Promise<HealthProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.publicAccessProvider === 'trycloudflare' ? 8_000 : 5_000);
  timeout.unref();
  try {
    const endpointUrl = new URL(endpoint);
    const workspacePath = endpointUrl.pathname.replace(/\/mcp\/?$/, '');
    const protectedMetadata = new URL(endpointUrl);
    protectedMetadata.pathname = `/.well-known/oauth-protected-resource${endpointUrl.pathname}`;
    const authorizationMetadata = new URL(endpointUrl);
    authorizationMetadata.pathname = `/.well-known/oauth-authorization-server${workspacePath}`;
    const expectedIssuer = `${endpointUrl.origin}${workspacePath}`;
    const initializeBody = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop-health-check', version: app.getVersion() } },
    });
    const challengeAttempts = settings.publicAccessProvider === 'trycloudflare' ? 4 : 1;
    let challenge: Response | null = null;
    let challengeAuth = '';
    for (let attempt = 0; attempt < challengeAttempts; attempt += 1) {
      challenge = await net.fetch(endpoint, {
        method: 'POST',
        cache: 'no-store',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
        body: initializeBody,
      });
      challengeAuth = challenge.headers.get('www-authenticate') || '';
      if (challenge.status === 401 && challengeAuth.toLowerCase().includes('bearer')) break;
      if (attempt < challengeAttempts - 1) {
        const retryDelay = [350, 700, 1_200][attempt] || 1_200;
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
    if (!challenge || challenge.status !== 401 || !challengeAuth.toLowerCase().includes('bearer')) {
      const httpStatus = challenge?.status ?? null;
      const contentType = challenge?.headers.get('content-type') || 'unknown';
      const authSummary = challengeAuth ? challengeAuth.slice(0, 120) : '缺失';
      return {
        ok: false,
        status: 'unhealthy',
        url: endpoint,
        latencyMs: Date.now() - startedAt,
        httpStatus,
        message: `OAuth MCP Challenge 异常：HTTP ${httpStatus ?? 'unknown'} · WWW-Authenticate=${authSummary} · Content-Type=${contentType}`,
      };
    }
    const resourceResponse = await net.fetch(protectedMetadata.toString(), { cache: 'no-store', redirect: 'manual', signal: controller.signal });
    if (!resourceResponse.ok) {
      return { ok: false, status: 'unhealthy', url: endpoint, latencyMs: Date.now() - startedAt, httpStatus: resourceResponse.status, message: `Protected Resource Metadata HTTP ${resourceResponse.status}` };
    }
    const resourceMetadata = await resourceResponse.json() as { resource?: string; authorization_servers?: string[] };
    if (resourceMetadata.resource !== endpoint || !resourceMetadata.authorization_servers?.includes(expectedIssuer)) {
      return { ok: false, status: 'unhealthy', url: endpoint, latencyMs: Date.now() - startedAt, httpStatus: resourceResponse.status, message: 'Protected Resource Metadata 与 Workspace 不匹配' };
    }
    const authResponse = await net.fetch(authorizationMetadata.toString(), { cache: 'no-store', redirect: 'manual', signal: controller.signal });
    if (!authResponse.ok) {
      return { ok: false, status: 'unhealthy', url: endpoint, latencyMs: Date.now() - startedAt, httpStatus: authResponse.status, message: `Authorization Server Metadata HTTP ${authResponse.status}` };
    }
    const authMetadata = await authResponse.json() as {
      issuer?: string;
      token_endpoint?: string;
      authorization_endpoint?: string;
      client_id_metadata_document_supported?: boolean;
    };
    if (
      authMetadata.issuer !== expectedIssuer
      || !authMetadata.token_endpoint
      || !authMetadata.authorization_endpoint
      || authMetadata.client_id_metadata_document_supported !== true
    ) {
      return { ok: false, status: 'unhealthy', url: endpoint, latencyMs: Date.now() - startedAt, httpStatus: authResponse.status, message: 'OAuth Discovery/CIMD 元数据不完整' };
    }
    const latencyMs = Date.now() - startedAt;
    return { ok: true, status: 'healthy', url: endpoint, latencyMs, httpStatus: 200, message: `OAuth Discovery 正常 · ${latencyMs} ms` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      ok: false,
      status: 'unhealthy',
      url: endpoint,
      latencyMs,
      httpStatus: null,
      message: error instanceof Error && error.name === 'AbortError' ? 'OAuth Discovery 超时' : `OAuth Discovery 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function backupCorruptFile(filePath: string, label: string, error: unknown): Promise<string> {
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.corrupt-${suffix}`;
  try {
    await copyFile(filePath, backupPath);
  } catch (backupError) {
    throw new Error(`${label} 无法读取，并且备份失败：${backupError instanceof Error ? backupError.message : String(backupError)}`);
  }
  const reason = error instanceof Error ? error.message : String(error);
  const warning = `${label} 无法读取，原文件已备份到：\n${backupPath}\n\n原因：${reason}`;
  startupWarnings.push(warning);
  appendLog('desktop', warning);
  return backupPath;
}

function isTransientTryCloudflareFailure(reason: string): boolean {
  return /connection reset|reset by peer|connection refused|network is unreachable|temporary|temporarily|timeout|timed out|tls handshake|unexpected eof|\beof\b|api\.trycloudflare\.com|trycloudflare.*request/i.test(reason);
}

function scheduleTunnelRecovery(reason = tunnelState.error || ''): void {
  if (
    isQuitting
    || !tunnelDesiredRunning
    || tunnelRecoveryTimer
    || tunnelState.phase === 'running'
    || tunnelState.phase === 'starting'
    || tunnelState.phase === 'stopping'
  ) return;
  const attemptIndex = tunnelRecoveryAttempt;
  const quickRetry = settings.publicAccessProvider === 'trycloudflare'
    && isTransientTryCloudflareFailure(reason)
    && attemptIndex < 2;
  const baseDelay = quickRetry
    ? [750, 2_000][attemptIndex]
    : settings.publicAccessProvider === 'trycloudflare'
      ? Math.min(30_000, 8_000 * (2 ** Math.min(Math.max(0, attemptIndex - 2), 2)))
      : Math.min(30_000, 1_000 * (2 ** Math.min(attemptIndex, 5)));
  const delay = quickRetry
    ? baseDelay
    : Math.min(30_000, Math.max(1_000, Math.round(baseDelay * (0.85 + Math.random() * 0.3))));
  tunnelRecoveryAttempt += 1;
  const retryAttempt = tunnelRecoveryAttempt;
  const retryMode: 'quick' | 'recovery' = quickRetry ? 'quick' : 'recovery';
  tunnelState = {
    ...tunnelState,
    retryAt: new Date(Date.now() + delay).toISOString(),
    retryDelayMs: delay,
    retryAttempt,
    retryMode,
  };
  appendLog('desktop', quickRetry
    ? `TryCloudflare transient failure · quick retry ${retryAttempt}/2 in ${delay}ms`
    : `Tunnel auto-recovery scheduled in ${delay}ms (attempt ${retryAttempt})`);
  broadcastState();
  tunnelRecoveryTimer = setTimeout(() => {
    tunnelRecoveryTimer = null;
    if (!isQuitting && tunnelDesiredRunning) void startTunnel(true);
  }, delay);
  tunnelRecoveryTimer.unref();
}

function scheduleRuntimeRecovery(): void {
  if (isQuitting || runtimeRecoveryTimer || runtimeState.phase === 'running' || runtimeState.phase === 'starting' || runtimeState.phase === 'stopping') return;
  const delay = Math.min(30_000, 1_000 * (2 ** Math.min(runtimeRecoveryAttempt, 5)));
  runtimeRecoveryAttempt += 1;
  appendLog('desktop', `Runtime auto-recovery scheduled in ${delay}ms`);
  runtimeRecoveryTimer = setTimeout(() => {
    runtimeRecoveryTimer = null;
    if (!isQuitting) void startRuntime();
  }, delay);
  runtimeRecoveryTimer.unref();
}

function normalizeProxyScope(value: unknown): ProxyScope {
  const scope = String(value ?? 'global').trim().toLowerCase();
  if (scope === 'global' || scope === 'tunnel' || scope === 'runtime') return scope;
  throw new Error('代理作用范围必须是全局、仅 Runtime 出站或仅公网客户端');
}

function normalizeProxyMode(value: unknown): ProxyMode {
  const mode = String(value ?? 'off').trim().toLowerCase();
  if (mode === 'off' || mode === 'system' || mode === 'manual') return mode;
  throw new Error('代理模式必须是关闭、跟随系统或手动代理');
}

function normalizeAppearance(value: unknown): AppearanceMode {
  const mode = String(value ?? 'system').trim().toLowerCase();
  if (mode === 'system' || mode === 'light' || mode === 'dark') return mode;
  throw new Error('外观必须是跟随系统、亮色或暗色');
}

function normalizeUiLanguage(value: unknown): UiLanguageMode {
  const raw = String(value ?? 'system').trim();
  if (raw === 'system' || raw === 'zh-CN' || raw === 'en-US') return raw;
  const lower = raw.toLowerCase();
  if (lower === 'zh-cn') return 'zh-CN';
  if (lower === 'en-us') return 'en-US';
  throw new Error('界面语言必须是跟随系统、简体中文或 English');
}

function normalizeDebugMode(value: unknown): DebugMode {
  const mode = String(value ?? 'off').trim().toLowerCase();
  if (mode === 'off' || mode === 'basic' || mode === 'detailed') return mode;
  throw new Error('调试模式必须是关闭、基础或详细');
}

function normalizePublicAccessProvider(value: unknown): PublicAccessProvider {
  const provider = String(value ?? 'cloudflare').trim().toLowerCase();
  if (provider === 'cloudflare' || provider === 'trycloudflare' || provider === 'frp' || provider === 'external') return provider;
  throw new Error('公网接入方式必须是 Cloudflare Tunnel、TryCloudflare、FRP 或外部自建');
}

function normalizePublicClientMode(value: unknown): PublicClientMode {
  const mode = String(value ?? 'managed').trim().toLowerCase();
  if (mode === 'managed' || mode === 'custom') return mode;
  throw new Error('公网客户端模式必须是 App 管理或自定义路径');
}

function normalizeCloudflareTransportProtocol(value: unknown): CloudflareTransportProtocol {
  const protocol = String(value ?? 'auto').trim().toLowerCase();
  if (protocol === 'auto' || protocol === 'quic' || protocol === 'http2') return protocol;
  throw new Error('Cloudflare 传输协议必须是 Auto、QUIC 或 HTTP/2');
}

function normalizeCloudflareEdgeIpVersion(value: unknown): CloudflareEdgeIpVersion {
  const version = String(value ?? 'auto').trim().toLowerCase();
  if (version === 'auto' || version === '4' || version === '6') return version;
  throw new Error('Cloudflare Edge IP 版本必须是 Auto、IPv4 或 IPv6');
}

function normalizeFrpTransportProtocol(value: unknown): FrpTransportProtocol {
  const protocol = String(value ?? 'tcp').trim().toLowerCase();
  if (protocol === 'tcp' || protocol === 'quic' || protocol === 'kcp') return protocol;
  throw new Error('FRP 传输协议必须是 TCP、QUIC 或 KCP');
}

function normalizeProxyUrl(value: unknown, mode: ProxyMode): string {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (mode !== 'manual') return raw;
  if (!raw) throw new Error('手动代理需要填写代理地址');
  const candidate = raw.includes('://') ? new URL(raw) : new URL(`http://${raw}`);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(candidate.protocol)) {
    throw new Error('代理地址仅支持 HTTP、HTTPS、SOCKS4 或 SOCKS5');
  }
  if (!candidate.hostname || !candidate.port) throw new Error('代理地址必须包含主机和端口，例如 http://127.0.0.1:7890');
  if (candidate.username || candidate.password || candidate.pathname !== '/' || candidate.search || candidate.hash) {
    throw new Error('代理地址暂不支持账号密码、路径、查询参数或片段');
  }
  return `${candidate.protocol}//${candidate.hostname}:${candidate.port}`;
}

function normalizeProxyBypass(value: unknown): string {
  const items = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const required = ['<local>', 'localhost', '127.0.0.1', '[::1]'];
  return [...new Set([...items, ...required])].join(',');
}

function proxyConfigFor(input: Pick<DesktopSettings, 'proxyMode' | 'proxyUrl' | 'proxyBypass'>) {
  if (input.proxyMode === 'off') return { mode: 'direct' as const };
  if (input.proxyMode === 'system') return { mode: 'system' as const };
  return {
    mode: 'fixed_servers' as const,
    proxyRules: input.proxyUrl,
    proxyBypassRules: input.proxyBypass,
  };
}

async function applyNetworkProxy(input: Pick<DesktopSettings, 'proxyMode' | 'proxyUrl' | 'proxyBypass'>): Promise<void> {
  const proxy = proxyConfigFor(input);
  await Promise.all([
    session.defaultSession.setProxy(proxy),
    app.setProxy(proxy),
  ]);
}

async function managedDownloadFetch(url: string, init?: RequestInit): Promise<Response> {
  const downloadSession = session.fromPartition('rw-mcp-managed-download', { cache: false });
  const proxy = proxyConfigFor(settings);
  await downloadSession.setProxy(proxy);
  return downloadSession.fetch(url, init);
}

function environmentWithProxy(
  base: NodeJS.ProcessEnv,
  input: Pick<DesktopSettings, 'proxyMode' | 'proxyUrl' | 'proxyBypass' | 'tunnelProxyEnabled'>,
  target: 'runtime' | 'tunnel',
): NodeJS.ProcessEnv {
  const env = { ...base };
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const shouldApply = target === 'runtime' || input.tunnelProxyEnabled;
  if (input.proxyMode === 'off' || !shouldApply) {
    for (const key of keys) delete env[key];
    return env;
  }
  if (input.proxyMode === 'system') return env;
  const noProxy = input.proxyBypass
    .replaceAll('<local>', 'localhost,127.0.0.1,::1')
    .replaceAll('[::1]', '::1');
  env.HTTP_PROXY = input.proxyUrl;
  env.HTTPS_PROXY = input.proxyUrl;
  env.ALL_PROXY = input.proxyUrl;
  env.NO_PROXY = noProxy;
  env.http_proxy = input.proxyUrl;
  env.https_proxy = input.proxyUrl;
  env.all_proxy = input.proxyUrl;
  env.no_proxy = noProxy;
  return env;
}

async function testProxyConfiguration(input: Partial<DesktopSettings>): Promise<{ ok: boolean; summary: string; resolvedProxy: string }> {
  const mode = normalizeProxyMode(input.proxyMode);
  const scope = normalizeProxyScope(input.proxyScope);
  void scope;
  const proxyUrl = normalizeProxyUrl(input.proxyUrl, mode);
  const proxyBypass = normalizeProxyBypass(input.proxyBypass);
  const testSession = session.fromPartition('proxy-test', { cache: false });
  await testSession.setProxy(proxyConfigFor({ proxyMode: mode, proxyUrl, proxyBypass }));
  const resolvedProxy = await testSession.resolveProxy('https://www.cloudflare.com/');
  if (mode === 'manual') {
    const target = new URL(proxyUrl);
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection({ host: target.hostname, port: Number(target.port) });
      const timeout = setTimeout(() => probe.destroy(new Error('代理端口连接超时')), 3_000);
      probe.once('connect', () => { clearTimeout(timeout); probe.destroy(); resolve(); });
      probe.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
    });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  timeout.unref();
  try {
    const response = await testSession.fetch('https://www.cloudflare.com/cdn-cgi/trace', { cache: 'no-store', signal: controller.signal });
    const successSummary = mode === 'off'
      ? '直连正常'
      : mode === 'system'
        ? '系统代理连接正常'
          : '全局代理连接正常';
    return {
      ok: response.ok,
      summary: response.ok ? successSummary : `网络规则已应用，但联网检查返回 HTTP ${response.status}`,
      resolvedProxy,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function persistSecretFile(file: SecretFile): Promise<void> {
  await atomicWriteJson(secretsPath(), file);
}

async function asyncSecretStorageAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}

async function encryptSecretValue(value: string): Promise<string> {
  if (!(await asyncSecretStorageAvailable())) throw new Error('System credential encryption is not available');
  return (await safeStorage.encryptStringAsync(value)).toString('base64');
}

async function decryptSecretValue(encoded: string): Promise<{ value: string; reencrypted?: string }> {
  if (!encoded) return { value: '' };
  const encrypted = Buffer.from(encoded, 'base64');
  if (await asyncSecretStorageAvailable()) {
    try {
      const result = await safeStorage.decryptStringAsync(encrypted);
      return {
        value: result.result,
        ...(result.shouldReEncrypt ? { reencrypted: await encryptSecretValue(result.result) } : {}),
      };
    } catch {
    // Async decryption may be unavailable for older Electron versions; use the
    // current synchronous safeStorage API as the local runtime fallback.
    }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统凭据解密当前不可用，已保存的 Secret 不能安全读取');
  }
  try {
    const value = safeStorage.decryptString(encrypted);
    return { value, ...(await asyncSecretStorageAvailable() ? { reencrypted: await encryptSecretValue(value) } : {}) };
  } catch (error) {
    throw new Error(`已保存的加密凭据无法解密：${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveJournalPath(): string {
  return path.join(app.getPath('userData'), 'desktop-save-journal.json');
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

async function runtimeStore(): Promise<DesktopRuntimeStore> {
  if (!desktopRuntimeStore) {
    desktopRuntimeStore = await DesktopRuntimeStore.open(runtimeStateDbPath());
    const runtime = desktopRuntimeStore.getRuntimeSettings();
    const inheritedPath = String(process.env.PATH || '').trim();
    const enhancedDefaultPath = defaultRuntimeSettings().runtimePath;
    if (process.platform === 'darwin' && inheritedPath && runtime.runtimePath === inheritedPath && enhancedDefaultPath !== inheritedPath) {
      desktopRuntimeStore.updateRuntimeSettings({ runtimePath: enhancedDefaultPath });
      appendLog('desktop', 'Runtime PATH 已从 macOS Finder 最小 PATH 自动升级为增强默认值');
    }
    const current = [...runtime.allowedCommands].sort();
    const previous = [...PREVIOUS_DEFAULT_ALLOWED_COMMANDS].sort();
    if (current.length === previous.length && current.every((value, index) => value === previous[index])) {
      desktopRuntimeStore.updateRuntimeSettings({ allowedCommands: [...DEFAULT_ALLOWED_COMMANDS] });
    }
  }
  return desktopRuntimeStore;
}

async function ensureWorkspaceApiToken(workspace: string): Promise<string> {
  const smokeToken = process.env.RW_MCP_DESKTOP_SMOKE_API_TOKEN?.trim();
  if (smokeToken) return smokeToken;
  const current = await readWorkspaceApiToken(workspace);
  if (current) return current;
  const fallback = await readApiToken();
  if (!fallback) return '';
  await writeWorkspaceApiToken(workspace, fallback);
  return fallback;
}

async function readWorkspaceApiToken(workspace: string): Promise<string> {
  const file = await loadSecretFile();
  const encrypted = file.workspaceApiTokens?.[workspace];
  if (!encrypted) return '';
  const decoded = await decryptSecretValue(encrypted);
  if (decoded.reencrypted) {
    file.workspaceApiTokens = { ...(file.workspaceApiTokens ?? {}), [workspace]: decoded.reencrypted };
    await persistSecretFile(file);
  }
  return decoded.value;
}

async function writeWorkspaceApiToken(workspace: string, token: string): Promise<void> {
  const file = await loadSecretFile();
  file.workspaceApiTokens = { ...(file.workspaceApiTokens ?? {}) };
  if (token) file.workspaceApiTokens[workspace] = await encryptSecretValue(token);
  else delete file.workspaceApiTokens[workspace];
  await persistSecretFile(file);
}

async function readEncryptedWorkspaceSecret(mapName: 'workspaceOauthAuthorizationSecrets' | 'workspaceOauthSigningKeys', workspace: string): Promise<string> {
  const file = await loadSecretFile();
  const encrypted = file[mapName]?.[workspace];
  if (!encrypted) return '';
  const decoded = await decryptSecretValue(encrypted);
  if (decoded.reencrypted) {
    file[mapName] = { ...(file[mapName] ?? {}), [workspace]: decoded.reencrypted };
    await persistSecretFile(file);
  }
  return decoded.value;
}

async function writeEncryptedWorkspaceSecret(
  mapName: 'workspaceOauthAuthorizationSecrets' | 'workspaceOauthSigningKeys',
  workspace: string,
  value: string,
): Promise<void> {
  const file = await loadSecretFile();
  const map = { ...(file[mapName] ?? {}) };
  if (value) map[workspace] = await encryptSecretValue(value);
  else delete map[workspace];
  file[mapName] = map;
  await persistSecretFile(file);
}

function generateWorkspaceOauthAuthorizationSecret(): string {
  return randomBytes(18).toString('base64url');
}

function generateWorkspaceOauthSigningJwk(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = `rw-${randomBytes(8).toString('hex')}`;
  jwk.alg = 'ES256';
  jwk.use = 'sig';
  return JSON.stringify(jwk);
}

function hashWorkspaceOauthAuthorizationSecret(secret: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(secret, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${digest.toString('base64url')}`;
}

async function ensureWorkspaceBuiltinOauthSecrets(workspace: string): Promise<{ authorizationSecret: string; privateJwk: string }> {
  let authorizationSecret = await readEncryptedWorkspaceSecret('workspaceOauthAuthorizationSecrets', workspace);
  let privateJwk = await readEncryptedWorkspaceSecret('workspaceOauthSigningKeys', workspace);
  if (!authorizationSecret) {
    authorizationSecret = generateWorkspaceOauthAuthorizationSecret();
    await writeEncryptedWorkspaceSecret('workspaceOauthAuthorizationSecrets', workspace, authorizationSecret);
  }
  if (!privateJwk) {
    privateJwk = generateWorkspaceOauthSigningJwk();
    await writeEncryptedWorkspaceSecret('workspaceOauthSigningKeys', workspace, privateJwk);
  }
  return { authorizationSecret, privateJwk };
}

async function portAvailable(port: number): Promise<boolean> {
  try {
    await assertPortAvailable(port);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('已被其他程序占用')) return false;
    throw error;
  }
}

async function nextAvailablePort(start: number, reserved: Set<number>): Promise<number> {
  for (let port = start; port <= 65535; port += 1) {
    if (reserved.has(port)) continue;
    if (await portAvailable(port)) return port;
  }
  throw new Error(`从端口 ${start} 开始没有找到可用端口`);
}

async function ensureRuntimePortsAvailable(): Promise<void> {
  let changed = false;
  const reserved = new Set<number>();

  const preferredGatewayPortAvailable = settings.port !== INTERNAL_GATEWAY_PORT
    && await portAvailable(INTERNAL_GATEWAY_PORT);
  if (preferredGatewayPortAvailable) {
    const previous = settings.port;
    settings.port = INTERNAL_GATEWAY_PORT;
    changed = true;
    appendLog('desktop', `Gateway port ${previous} replaced with preferred fixed port ${settings.port}`);
  } else if (!(await portAvailable(settings.port))) {
    const previous = settings.port;
    settings.port = await nextAvailablePort(INTERNAL_GATEWAY_PORT, reserved);
    changed = true;
    appendLog('desktop', `Gateway port ${previous} occupied; switched to ${settings.port}`);
  }
  reserved.add(settings.port);

  const services: WorkspaceServiceSettings[] = [];
  for (const service of settings.workspaceServices) {
    if (!service.enabled) {
      services.push(service);
      continue;
    }
    let port = service.port;
    if (reserved.has(port) || !(await portAvailable(port))) {
      const previous = port;
      port = await nextAvailablePort(FIRST_WORKSPACE_MCP_PORT, reserved);
      changed = true;
      appendLog('desktop', `Workspace ${service.workspace} port ${previous} occupied; switched to ${port}`);
    }
    reserved.add(port);
    services.push({ ...service, port });
  }

  if (changed) {
    settings = { ...settings, workspaceServices: services };
    await persistSettings(settings);
    broadcastState();
  }
}

function workspacePathForName(workspace: string): string {
  const registered = settings.registeredWorkspaces.find((item) => item.name === workspace);
  return registered?.path ?? path.join(settings.workspaceRoot, workspace);
}

function normalizeRegisteredWorkspaces(value: unknown): DesktopWorkspace[] {
  const source = Array.isArray(value) ? value : [];
  const names = new Set<string>();
  const paths = new Set<string>();
  const result: DesktopWorkspace[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Registered Workspaces must be an array');
    const item = entry as Record<string, unknown>;
    const name = normalizeWorkspaceName(item.name);
    const workspacePath = path.resolve(String(item.path ?? '').trim());
    if (!String(item.path ?? '').trim()) throw new Error(`Workspace path is required: ${name}`);
    if (names.has(name)) throw new Error(`Workspace name is already registered: ${name}`);
    if (paths.has(workspacePath)) throw new Error(`Workspace path is already registered: ${workspacePath}`);
    names.add(name);
    paths.add(workspacePath);
    result.push({ name, path: workspacePath });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function canonicalizeRegisteredWorkspacePaths(workspaces: DesktopWorkspace[]): Promise<DesktopWorkspace[]> {
  const seenPaths = new Set<string>();
  const result: DesktopWorkspace[] = [];
  for (const workspace of workspaces) {
    let canonicalPath = path.resolve(workspace.path);
    try {
      canonicalPath = await realpath(canonicalPath);
    } catch {
      // Preserve missing/offline paths so health checks can surface the actual failure.
    }
    if (seenPaths.has(canonicalPath)) {
      startupWarnings.push(`Workspace ${workspace.name} 与其他 Workspace 指向同一个真实目录，已忽略重复注册：${canonicalPath}`);
      continue;
    }
    seenPaths.add(canonicalPath);
    result.push({ ...workspace, path: canonicalPath });
  }
  return result;
}

function normalizeWorkspaceServices(value: unknown, defaultPort: number): WorkspaceServiceSettings[] {
  const source = Array.isArray(value) ? value : [];
  const seenWorkspaces = new Set<string>();
  const seenPorts = new Set<number>();
  const seenPublicPaths = new Set<string>();
  const result: WorkspaceServiceSettings[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Workspace MCP Service 配置必须是对象数组');
    const item = entry as Record<string, unknown>;
    const parsed = workspaceServiceSchema.safeParse({
      ...item,
      publicAuthMode: item.publicAuthMode === 'token' ? 'token' : 'oauth',
      publicEnabled: item.publicEnabled,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Workspace MCP Service 配置无效${issue?.path?.length ? ` (${issue.path.join('.')})` : ''}: ${issue?.message ?? 'unknown error'}`);
    }
    const workspace = String(parsed.data.workspace);
    if (seenWorkspaces.has(workspace)) throw new Error(`Workspace MCP Service 重复: ${workspace}`);
    seenWorkspaces.add(workspace);
    const enabled = Boolean(parsed.data.enabled);
    const port = Number(parsed.data.port);
    if (enabled && port === defaultPort) throw new Error(`Workspace ${workspace} 的独立 MCP 端口不能与默认端口 ${defaultPort} 相同`);
    if (enabled && seenPorts.has(port)) throw new Error(`Workspace MCP 端口重复: ${port}`);
    if (enabled) seenPorts.add(port);
    const publicAuthMode = parsed.data.publicAuthMode as WorkspacePublicAuthMode;
    const toolTier = parsed.data.toolTier as WorkspaceToolTier;
    const publicEnabled = Boolean(parsed.data.publicEnabled);
    const publicPath = String(parsed.data.publicPath || workspace);
    if (enabled && publicEnabled && seenPublicPaths.has(publicPath)) throw new Error(`Workspace 公网路径重复: ${publicPath}`);
    if (enabled && publicEnabled) seenPublicPaths.add(publicPath);
    result.push({
      workspace,
      enabled,
      port,
      publicEnabled,
      publicPath,
      publicAuthMode,
      toolTier,
    });
  }
  return result.sort((a, b) => a.workspace.localeCompare(b.workspace));
}

function workspaceServiceId(workspace: string): string {
  return `ws-${createHash('sha256').update(workspace).digest('hex').slice(0, 16)}`;
}

function normalizeTunnelBaseDomain(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return '';
  const candidate = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
  if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port || candidate.search || candidate.hash) {
    throw new Error('公网 Host 只填写域名，例如 mcp.demo.com');
  }
  if (candidate.pathname !== '/' && candidate.pathname !== '') throw new Error('公网 Host 不能包含路径');
  const hostname = candidate.hostname.toLowerCase().replace(/\.$/, '');
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('公网 Host 无效，例如 mcp.demo.com');
  }
  return hostname;
}

function normalizeWorkspaceToolTier(value: unknown): WorkspaceToolTier {
  const parsed = toolTierSchema.safeParse(String(value ?? 'full').trim().toLowerCase());
  if (!parsed.success) throw new Error('Workspace 工具档位必须是 readonly、standard 或 full');
  return parsed.data;
}

function normalizeWorkspaceScope(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  const names = [...new Set(source.map((item) => String(item).trim()).filter(Boolean))].sort();
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === '.' || name === '..') {
      throw new Error(`Invalid Workspace name in scope: ${name}`);
    }
  }
  return names;
}

function normalizeWorkspaceName(value: unknown): string {
  const parsed = workspaceNameSchema.safeParse(String(value ?? ''));
  if (!parsed.success) {
    throw new Error('Workspace 名称只能使用字母、数字、点、下划线和短横线');
  }
  return parsed.data;
}

function workspaceNameFromPath(workspacePath: string): string {
  const base = path.basename(workspacePath);
  const candidate = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 128);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate) && candidate !== '.' && candidate !== '..') {
    return candidate;
  }
  return `workspace-${createHash('sha256').update(workspacePath).digest('hex').slice(0, 10)}`;
}

async function listDesktopWorkspaces(): Promise<DesktopWorkspace[]> {
  return [...settings.registeredWorkspaces].sort((a, b) => a.name.localeCompare(b.name));
}

async function syncWorkspaceServices(preferredWorkspace?: string): Promise<void> {
  settings = reconcileWorkspaceServices(settings, preferredWorkspace);
  await persistSettings(settings);
}

function reconcileWorkspaceServices(base: DesktopSettings, preferredWorkspace?: string): DesktopSettings {
  const workspaces = [...base.registeredWorkspaces].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set(workspaces.map((item) => item.name));
  const currentByWorkspace = new Map(base.workspaceServices.map((item) => [item.workspace, item]));
  const usedPorts = new Set<number>([base.port]);
  const next: WorkspaceServiceSettings[] = [];

  for (const workspace of workspaces) {
    const current = currentByWorkspace.get(workspace.name);
    let port = current?.port ?? FIRST_WORKSPACE_MCP_PORT;
    while (usedPorts.has(port)) port += 1;
    usedPorts.add(port);
    next.push({
      workspace: workspace.name,
      enabled: current?.enabled ?? false,
      port,
      publicEnabled: current?.publicEnabled ?? false,
      publicPath: current?.publicPath || workspace.name,
      publicAuthMode: current?.publicAuthMode ?? 'oauth',
      toolTier: current?.toolTier ?? 'full',
    });
  }

  const requested = preferredWorkspace && names.has(preferredWorkspace) ? preferredWorkspace : base.selectedWorkspace;
  const selectedWorkspace = requested && names.has(requested)
    ? requested
    : workspaces[0]?.name ?? '';
  return normalizeSettings({ ...base, selectedWorkspace, workspaceServices: next }, base);
}

async function openDesktopWorkspace(value: unknown): Promise<string> {
  const name = normalizeWorkspaceName(value);
  const workspace = (await listDesktopWorkspaces()).find((item) => item.name === name);
  if (!workspace) throw new Error(`Unknown Workspace: ${name}`);
  const target = workspace.path;
  return shell.openPath(target);
}

async function registerExistingWorkspace(workspacePathValue: unknown): Promise<DesktopState> {
  const requestedPath = path.resolve(String(workspacePathValue ?? '').trim());
  const workspacePath = await realpath(requestedPath);
  const info = await stat(workspacePath);
  if (!info.isDirectory()) throw new Error('请选择一个目录作为 Workspace');
  let name = workspaceNameFromPath(workspacePath);
  const existing = await listDesktopWorkspaces();
  const sameName = existing.find((item) => item.name === name);
  if (sameName && path.resolve(sameName.path) !== workspacePath) {
    name = `${name.slice(0, 116)}-${createHash('sha256').update(workspacePath).digest('hex').slice(0, 10)}`;
  }
  const registered = settings.registeredWorkspaces.filter((item) => item.name !== name && path.resolve(item.path) !== workspacePath);
  settings = normalizeSettings({
    ...settings,
    registeredWorkspaces: [...registered, { name, path: workspacePath }],
    selectedWorkspace: name,
  }, settings);
  await syncWorkspaceServices(name);
  const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
  if (wasRunning) await restartRuntime();
  broadcastState();
  return stateWithSecrets();
}

async function changeWorkspaceDirectory(workspaceValue: unknown, workspacePathValue: unknown): Promise<DesktopState> {
  const name = normalizeWorkspaceName(workspaceValue);
  const requestedPath = path.resolve(String(workspacePathValue ?? '').trim());
  const workspacePath = await realpath(requestedPath);
  const info = await stat(workspacePath);
  if (!info.isDirectory()) throw new Error('请选择一个目录作为 Workspace');
  const current = settings.registeredWorkspaces.find((item) => item.name === name);
  if (!current) throw new Error(`Unknown Workspace: ${name}`);
  if (settings.registeredWorkspaces.some((item) => item.name !== name && path.resolve(item.path) === workspacePath)) {
    throw new Error('这个目录已经注册为其他 Workspace');
  }
  settings = normalizeSettings({
    ...settings,
    registeredWorkspaces: settings.registeredWorkspaces.map((item) => item.name === name ? { ...item, path: workspacePath } : item),
    selectedWorkspace: name,
  }, settings);
  await persistSettings(settings);
  const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
  if (wasRunning) await restartRuntime();
  broadcastState();
  return stateWithSecrets();
}

async function saveWorkspaceRuntimeProfile(workspaceValue: unknown, input: Partial<RuntimeProfile>): Promise<RuntimeAdminSnapshot> {
  const workspace = normalizeWorkspaceName(workspaceValue);
  const available = await listDesktopWorkspaces();
  if (!available.some((item) => item.name === workspace)) throw new Error(`Unknown Workspace: ${workspace}`);
  const store = await runtimeStore();
  const assignment = store.getWorkspaceProfile(workspace);
  const payload = {
    name: String(input.name || `${workspace} Runtime`).trim(),
    runtimePath: input.runtimePath?.trim() || null,
    allowedCommands: input.allowedCommands ?? null,
    allowCommandExecution: input.allowCommandExecution ?? null,
    allowExternalNetwork: input.allowExternalNetwork ?? null,
    requireHighRiskConfirmation: input.requireHighRiskConfirmation ?? null,
    highRiskConfirmationMode: input.highRiskConfirmationMode ?? null,
    defaultCommandTimeoutMs: input.defaultCommandTimeoutMs ?? null,
    maxCommandTimeoutMs: input.maxCommandTimeoutMs ?? null,
    maxCommandOutputBytes: input.maxCommandOutputBytes ?? null,
  };
  const hasOverrides = payload.runtimePath !== null
    || payload.allowedCommands !== null
    || payload.allowCommandExecution !== null
    || payload.allowExternalNetwork !== null
    || payload.requireHighRiskConfirmation !== null
    || payload.highRiskConfirmationMode !== null
    || payload.defaultCommandTimeoutMs !== null
    || payload.maxCommandTimeoutMs !== null
    || payload.maxCommandOutputBytes !== null;
  if (!hasOverrides) {
    if (assignment) store.assignWorkspaceProfile(workspace, null);
    return getRuntimeAdminSnapshot();
  }
  if (assignment) {
    store.updateRuntimeProfile(assignment.id, payload);
  } else {
    const created = store.createRuntimeProfile(payload);
    store.assignWorkspaceProfile(workspace, created.id);
  }
  return getRuntimeAdminSnapshot();
}

async function saveWorkspaceSettingsAtomic(
  workspaceValue: unknown,
  serviceInput: Partial<WorkspaceServiceSettings> & { apiToken?: string },
  runtimeInput: Partial<RuntimeProfile>,
): Promise<{ state: DesktopState; runtimeAdmin: RuntimeAdminSnapshot }> {
  const workspace = normalizeWorkspaceName(workspaceValue);
  const store = await runtimeStore();
  const previousSettings = settings;
  const previousSecrets = await loadSecretFile();
  const previousProfile = store.getWorkspaceProfile(workspace);
  const previousService = settings.workspaceServices.find((item) => item.workspace === workspace) ?? null;
  const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
  try {
    await saveWorkspaceService(workspace, serviceInput, { restart: false, broadcast: false });
    const runtimeAdmin = await saveWorkspaceRuntimeProfile(workspace, runtimeInput);
    const nextService = settings.workspaceServices.find((item) => item.workspace === workspace) ?? null;
    const nextProfile = store.getWorkspaceProfile(workspace);
    const comparableProfile = (profile: RuntimeProfile | null) => profile ? {
      runtimePath: profile.runtimePath,
      allowedCommands: profile.allowedCommands,
      allowCommandExecution: profile.allowCommandExecution,
      allowExternalNetwork: profile.allowExternalNetwork,
      requireHighRiskConfirmation: profile.requireHighRiskConfirmation,
      highRiskConfirmationMode: profile.highRiskConfirmationMode,
      defaultCommandTimeoutMs: profile.defaultCommandTimeoutMs,
      maxCommandTimeoutMs: profile.maxCommandTimeoutMs,
      maxCommandOutputBytes: profile.maxCommandOutputBytes,
    } : null;
    const runtimeAffectingChanged = JSON.stringify(previousService) !== JSON.stringify(nextService)
      || JSON.stringify(comparableProfile(previousProfile)) !== JSON.stringify(comparableProfile(nextProfile))
      || Boolean(serviceInput.apiToken?.trim());
    if (wasRunning && runtimeAffectingChanged) {
      const restarted = await restartRuntime();
      if (restarted.runtime.phase !== 'running') throw new Error(restarted.runtime.error || 'Runtime 未成功恢复');
    }
    broadcastState();
    return { state: await stateWithSecrets(), runtimeAdmin };
  } catch (error) {
    const currentProfile = store.getWorkspaceProfile(workspace);
    try {
      settings = previousSettings;
      await persistSettings(previousSettings);
      await persistSecretFile(previousSecrets);
      if (previousProfile) {
        store.updateRuntimeProfile(previousProfile.id, previousProfile);
        store.assignWorkspaceProfile(workspace, previousProfile.id);
      } else if (currentProfile) {
        store.assignWorkspaceProfile(workspace, null);
        store.deleteRuntimeProfile(currentProfile.id);
      }
      if (wasRunning) await restartRuntime();
      broadcastState();
    } catch (rollbackError) {
      appendLog('desktop', `Workspace 设置回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
}

async function unregisterWorkspace(value: unknown): Promise<DesktopState> {
  const name = normalizeWorkspaceName(value);
  const workspaces = await listDesktopWorkspaces();
  if (!workspaces.some((item) => item.name === name)) throw new Error(`Unknown Workspace: ${name}`);
  const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
  const registeredWorkspaces = settings.registeredWorkspaces.filter((item) => item.name !== name);
  const workspaceServices = settings.workspaceServices.filter((item) => item.workspace !== name);
  const selectedWorkspace = settings.selectedWorkspace === name
    ? (registeredWorkspaces[0]?.name ?? '')
    : settings.selectedWorkspace;
  settings = normalizeSettings({
    ...settings,
    registeredWorkspaces,
    workspaceServices,
    selectedWorkspace,
  }, settings);
  await persistSettings(settings);
  await writeWorkspaceApiToken(name, '');
  await writeEncryptedWorkspaceSecret('workspaceOauthAuthorizationSecrets', name, '');
  await writeEncryptedWorkspaceSecret('workspaceOauthSigningKeys', name, '');
  if (wasRunning) await restartRuntime();
  broadcastState();
  return stateWithSecrets();
}

async function saveWorkspaceService(
  workspaceValue: unknown,
  input: Partial<WorkspaceServiceSettings> & { apiToken?: string },
  options: { restart?: boolean; broadcast?: boolean } = {},
): Promise<DesktopState> {
  const workspace = normalizeWorkspaceName(workspaceValue);
  const available = await listDesktopWorkspaces();
  if (!available.some((item) => item.name === workspace)) throw new Error(`Unknown Workspace: ${workspace}`);
  const current = settings.workspaceServices.find((item) => item.workspace === workspace);
  const usedPorts = new Set(settings.workspaceServices.filter((item) => item.workspace !== workspace && item.enabled).map((item) => item.port));
  let suggestedPort = FIRST_WORKSPACE_MCP_PORT;
  while (usedPorts.has(suggestedPort)) suggestedPort += 1;
  const candidate: WorkspaceServiceSettings = {
    workspace,
    enabled: input.enabled === undefined ? current?.enabled ?? true : Boolean(input.enabled),
    port: input.port === undefined ? current?.port ?? suggestedPort : Number(input.port),
    publicEnabled: input.publicEnabled === undefined ? current?.publicEnabled ?? false : Boolean(input.publicEnabled),
    publicPath: input.publicPath === undefined ? current?.publicPath || workspace : normalizeWorkspaceName(input.publicPath),
    publicAuthMode: input.publicAuthMode === undefined ? current?.publicAuthMode ?? 'oauth' : input.publicAuthMode,
    toolTier: input.toolTier === undefined ? current?.toolTier ?? 'full' : normalizeWorkspaceToolTier(input.toolTier),
  };
  if (candidate.enabled && candidate.publicEnabled) {
    const conflictingRoute = settings.workspaceServices.find((item) => item.workspace !== workspace && item.enabled && item.publicEnabled && (item.publicPath || item.workspace) === candidate.publicPath);
    if (conflictingRoute) throw new Error(`公网路径 ${candidate.publicPath} 已被 Workspace ${conflictingRoute.workspace} 使用`);
  }
  if (candidate.publicEnabled && settings.publicAccessProvider !== 'trycloudflare' && !settings.tunnelBaseDomain) {
    throw new Error('请先在全局设置中配置公网 Host');
  }
  if (candidate.publicEnabled && candidate.publicAuthMode === 'token') {
    const pendingToken = typeof input.apiToken === 'string' ? input.apiToken.trim() : '';
    if (!pendingToken && !(await ensureWorkspaceApiToken(workspace))) {
      throw new Error(`请先为 Workspace ${workspace} 生成或保存 Bearer Token`);
    }
  }
  const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
  const nextSettings = normalizeSettings({
    ...settings,
    workspaceServices: [
      ...settings.workspaceServices.filter((item) => item.workspace !== workspace),
      candidate,
    ],
  }, settings);
  if (candidate.publicEnabled && candidate.publicAuthMode === 'oauth') await ensureWorkspaceBuiltinOauthSecrets(workspace);
  settings = nextSettings;
  await persistSettings(settings);
  if (typeof input.apiToken === 'string' && input.apiToken.trim()) {
    await writeWorkspaceApiToken(workspace, input.apiToken.trim());
  }
  if (wasRunning && options.restart !== false) await restartRuntime();
  if (options.broadcast !== false) broadcastState();
  return stateWithSecrets();
}

function normalizeAdditionalServices(value: unknown): string {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (!raw) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Additional MCP Services must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('Additional MCP Services must be a JSON array');
  return JSON.stringify(parsed);
}

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'desktop-secrets.json');
}

function runtimeStateDbPath(): string {
  return path.join(app.getPath('userData'), 'runtime', 'state.db');
}

function defaultWorkspaceRoot(): string {
  const override = process.env.RW_MCP_DESKTOP_DEFAULT_WORKSPACE_ROOT?.trim();
  if (override) return path.resolve(override);
  return path.join(app.getPath('documents'), 'MCPort', 'workspaces');
}

async function selectedPublicClientExecutable(kind: ManagedBinaryKind): Promise<string> {
  const smokeOverride = kind === 'cloudflared'
    ? process.env.RW_MCP_DESKTOP_SMOKE_CLOUDFLARED_PATH?.trim()
    : process.env.RW_MCP_DESKTOP_SMOKE_FRPC_PATH?.trim();
  if (smokeOverride) return path.resolve(smokeOverride);
  if (settings.publicClientMode === 'custom') {
    const customPath = path.resolve(settings.publicClientPath);
    const info = await stat(customPath);
    if (!info.isFile()) throw new Error('自定义公网客户端路径不是文件');
    return customPath;
  }
  let managed = await managedBinaryStatus(app.getPath('userData'), kind);
  const desiredVersion = settings.publicClientVersion.trim();
  const versionMismatch = desiredVersion && managed.installed
    ? managed.version.replace(/^v/, '') !== desiredVersion.replace(/^v/, '')
    : false;
  if (!managed.installed) throw new Error(`尚未安装 ${kind}，请先在“全局设置 → 公网接入”中点击“下载安装 / 更新客户端”`);
  if (versionMismatch) throw new Error(`${kind} 当前版本为 ${managed.version}，与固定版本 ${desiredVersion} 不一致，请先点击“下载安装 / 更新客户端”`);
  return managed.path;
}

function frpConfigPath(): string {
  return path.join(app.getPath('userData'), 'runtime', 'frpc.generated.toml');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function writeFrpConfig(): Promise<string> {
  if (!settings.frpServerAddr) throw new Error('请先填写 FRP Server 地址');
  const token = await readFrpToken();
  if (!token) throw new Error('请先保存 FRP Token');
  const filePath = frpConfigPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = [
    `serverAddr = ${tomlString(settings.frpServerAddr)}`,
    `serverPort = ${settings.frpServerPort}`,
    'loginFailExit = true',
    'auth.method = "token"',
    `auth.token = ${tomlString(token)}`,
    'transport.tls.enable = true',
    `transport.protocol = ${tomlString(settings.frpTransportProtocol)}`,
    'transport.tcpMux = true',
    'transport.tcpMuxKeepaliveInterval = 30',
    '',
    '[[proxies]]',
    'name = "w-mcp"',
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${settings.port}`,
    `subdomain = ${tomlString(settings.frpSubdomain)}`,
    `transport.useCompression = ${settings.frpUseCompression ? 'true' : 'false'}`,
    '',
  ].join('\n');
  await writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

function defaultSettings(): DesktopSettings {
  return {
    settingsVersion: 19,
    workspaceRoot: defaultWorkspaceRoot(),
    registeredWorkspaces: [],
    selectedWorkspace: '',
    port: INTERNAL_GATEWAY_PORT,
    workspaceScope: [],
    workspaceServices: [],
    additionalServicesJson: '',
    authMode: 'none',
    proxyMode: 'off',
    proxyScope: 'global',
    tunnelProxyEnabled: false,
    proxyUrl: '',
    proxyBypass: '<local>,localhost,127.0.0.1,[::1]',
    appearance: 'system',
    uiLanguage: 'system',
    debugMode: 'off',
    lowMemoryTray: true,
    computerUseEnabled: false,
    computerUsePublicEnabled: false,
    publicAccessProvider: 'cloudflare',
    publicClientMode: 'managed',
    publicClientPath: '',
    publicClientVersion: '',
    cloudflareTransportProtocol: 'auto',
    cloudflareEdgeIpVersion: 'auto',
    tunnelBaseDomain: '',
    frpServerAddr: '',
    frpServerPort: 7000,
    frpSubdomain: 'mcp',
    frpTransportProtocol: 'tcp',
    frpUseCompression: false,
    frpRemotePort: 18443,
    startTunnelWithRuntime: false,
    launchAtLogin: false,
    minimizeToTray: false,
  };
}

function normalizeSettings(input: Partial<DesktopSettings>, current: DesktopSettings): DesktopSettings {
  const port = input.port === undefined ? current.port : Number(input.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Port must be between 1 and 65535');
  const workspaceRoot = input.workspaceRoot === undefined ? current.workspaceRoot : path.resolve(String(input.workspaceRoot).trim());
  if (!workspaceRoot) throw new Error('Default workspace creation directory is required');
  const authMode = input.authMode === undefined ? current.authMode : input.authMode;
  if (authMode !== 'none' && authMode !== 'token') throw new Error('Unsupported auth mode');
  const proxyMode = normalizeProxyMode(input.proxyMode === undefined ? current.proxyMode : input.proxyMode);
  const proxyScope: ProxyScope = 'global';
  const tunnelProxyEnabled = input.tunnelProxyEnabled === undefined
    ? Boolean(current.tunnelProxyEnabled)
    : Boolean(input.tunnelProxyEnabled);
  const proxyUrl = normalizeProxyUrl(input.proxyUrl === undefined ? current.proxyUrl : input.proxyUrl, proxyMode);
  const proxyBypass = normalizeProxyBypass(input.proxyBypass === undefined ? current.proxyBypass : input.proxyBypass);
  const appearance = normalizeAppearance(input.appearance === undefined ? current.appearance : input.appearance);
  const uiLanguage = normalizeUiLanguage(input.uiLanguage === undefined ? current.uiLanguage : input.uiLanguage);
  const debugMode = normalizeDebugMode(input.debugMode === undefined ? current.debugMode : input.debugMode);
  const computerUseEnabled = input.computerUseEnabled === undefined ? Boolean(current.computerUseEnabled) : Boolean(input.computerUseEnabled);
  const computerUsePublicEnabled = computerUseEnabled && (input.computerUsePublicEnabled === undefined
    ? Boolean(current.computerUsePublicEnabled)
    : Boolean(input.computerUsePublicEnabled));
  const publicAccessProvider = normalizePublicAccessProvider(input.publicAccessProvider === undefined ? current.publicAccessProvider : input.publicAccessProvider);
  const publicClientMode = normalizePublicClientMode(input.publicClientMode === undefined ? current.publicClientMode : input.publicClientMode);
  const publicClientPath = input.publicClientPath === undefined ? String(current.publicClientPath || '').trim() : String(input.publicClientPath || '').trim();
  const publicClientVersion = input.publicClientVersion === undefined ? String(current.publicClientVersion || '').trim() : String(input.publicClientVersion || '').trim();
  const cloudflareTransportProtocol = normalizeCloudflareTransportProtocol(
    input.cloudflareTransportProtocol === undefined ? current.cloudflareTransportProtocol : input.cloudflareTransportProtocol,
  );
  const cloudflareEdgeIpVersion = normalizeCloudflareEdgeIpVersion(
    input.cloudflareEdgeIpVersion === undefined ? current.cloudflareEdgeIpVersion : input.cloudflareEdgeIpVersion,
  );
  if (publicClientVersion && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(publicClientVersion)) throw new Error('公网客户端版本号格式无效');
  if (publicClientMode === 'custom' && publicAccessProvider !== 'external' && !publicClientPath) throw new Error('使用自定义公网客户端时必须填写路径');
  const tunnelBaseDomain = input.tunnelBaseDomain === undefined
    ? normalizeTunnelBaseDomain(current.tunnelBaseDomain)
    : normalizeTunnelBaseDomain(input.tunnelBaseDomain);
  const workspaceServices = input.workspaceServices === undefined
    ? normalizeWorkspaceServices(current.workspaceServices, port)
    : normalizeWorkspaceServices(input.workspaceServices, port);
  if (workspaceServices.some((service) => service.publicEnabled) && publicAccessProvider !== 'trycloudflare' && !tunnelBaseDomain) {
    throw new Error('启用 Workspace 公网 MCP 前请先设置公网 Host；TryCloudflare 会在启动后自动生成临时 Host');
  }
  const frpServerPort = input.frpServerPort === undefined ? Number(current.frpServerPort || 7000) : Number(input.frpServerPort);
  const frpTransportProtocol = normalizeFrpTransportProtocol(
    input.frpTransportProtocol === undefined ? current.frpTransportProtocol : input.frpTransportProtocol,
  );
  const frpSubdomain = input.frpSubdomain === undefined
    ? String(current.frpSubdomain || 'mcp').trim().toLowerCase()
    : String(input.frpSubdomain || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(frpSubdomain)) throw new Error('FRP Subdomain 必须是合法的 DNS 单标签');
  const frpRemotePort = input.frpRemotePort === undefined ? Number(current.frpRemotePort || 18443) : Number(input.frpRemotePort);
  if (!Number.isInteger(frpServerPort) || frpServerPort <= 0 || frpServerPort > 65535) throw new Error('FRP Server Port 必须在 1-65535');
  if (!Number.isInteger(frpRemotePort) || frpRemotePort <= 0 || frpRemotePort > 65535) throw new Error('FRP Remote Port 必须在 1-65535');
  return {
    settingsVersion: 19,
    workspaceRoot,
    registeredWorkspaces: input.registeredWorkspaces === undefined
      ? normalizeRegisteredWorkspaces(current.registeredWorkspaces)
      : normalizeRegisteredWorkspaces(input.registeredWorkspaces),
    selectedWorkspace: input.selectedWorkspace === undefined ? current.selectedWorkspace : String(input.selectedWorkspace).trim(),
    port,
    workspaceScope: input.workspaceScope === undefined ? current.workspaceScope : normalizeWorkspaceScope(input.workspaceScope),
    workspaceServices,
    additionalServicesJson: input.additionalServicesJson === undefined
      ? current.additionalServicesJson
      : normalizeAdditionalServices(input.additionalServicesJson),
    authMode,
    proxyMode,
    proxyScope,
    tunnelProxyEnabled,
    proxyUrl,
    proxyBypass,
    appearance,
    uiLanguage,
    debugMode,
    lowMemoryTray: input.lowMemoryTray === undefined ? current.lowMemoryTray : Boolean(input.lowMemoryTray),
    computerUseEnabled,
    computerUsePublicEnabled,
    publicAccessProvider,
    publicClientMode,
    publicClientPath,
    publicClientVersion,
    cloudflareTransportProtocol,
    cloudflareEdgeIpVersion,
    tunnelBaseDomain,
    frpServerAddr: normalizeFrpServerAddr(input.frpServerAddr === undefined ? current.frpServerAddr : input.frpServerAddr),
    frpServerPort,
    frpSubdomain,
    frpTransportProtocol,
    frpUseCompression: input.frpUseCompression === undefined
      ? Boolean(current.frpUseCompression)
      : Boolean(input.frpUseCompression),
    frpRemotePort,
    startTunnelWithRuntime: input.startTunnelWithRuntime === undefined
      ? current.startTunnelWithRuntime
      : Boolean(input.startTunnelWithRuntime),
    launchAtLogin: input.launchAtLogin === undefined ? current.launchAtLogin : Boolean(input.launchAtLogin),
    minimizeToTray: input.minimizeToTray === undefined ? current.minimizeToTray : Boolean(input.minimizeToTray),
  };
}

async function loadSettings(): Promise<DesktopSettings> {
  const defaults = defaultSettings();
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<DesktopSettings>;
    if (Number(raw.settingsVersion) !== 19) throw new Error('Desktop settings version is unsupported; reset settings to start with the current schema');
    const normalized = normalizeSettings(raw, defaults);
    normalized.registeredWorkspaces = await canonicalizeRegisteredWorkspacePaths(normalized.registeredWorkspaces);
    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return defaults;
    await backupCorruptFile(settingsPath(), 'Desktop 配置', error);
    return defaults;
  }
}

async function persistSettings(next: DesktopSettings): Promise<void> {
  await atomicWriteJson(settingsPath(), next);
}

async function loadSecretFile(): Promise<SecretFile> {
  try {
    const parsed = JSON.parse(await readFile(secretsPath(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Secret 文件必须是 JSON 对象');
    return parsed as SecretFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    await backupCorruptFile(secretsPath(), '加密凭据文件', error);
    await atomicWriteJson(secretsPath(), {});
    return {};
  }
}

async function readApiToken(): Promise<string> {
  const file = await loadSecretFile();
  const encrypted = file.apiToken;
  if (!encrypted) return '';
  const decoded = await decryptSecretValue(encrypted);
  if (decoded.reencrypted) {
    file.apiToken = decoded.reencrypted;
    await persistSecretFile(file);
  }
  return decoded.value;
}

async function writeApiToken(token: string): Promise<void> {
  const file = await loadSecretFile();
  file.apiToken = await encryptSecretValue(token);
  await persistSecretFile(file);
}

async function readTunnelToken(): Promise<string> {
  const smokeToken = process.env.RW_MCP_DESKTOP_SMOKE_TUNNEL_TOKEN?.trim();
  if (smokeToken) return smokeToken;
  const file = await loadSecretFile();
  const encrypted = file.tunnelToken;
  if (!encrypted) return '';
  const decoded = await decryptSecretValue(encrypted);
  if (decoded.reencrypted) {
    file.tunnelToken = decoded.reencrypted;
    await persistSecretFile(file);
  }
  return decoded.value;
}

async function writeTunnelToken(token: string): Promise<void> {
  const file = await loadSecretFile();
  file.tunnelToken = await encryptSecretValue(token);
  await persistSecretFile(file);
}

async function readFrpToken(): Promise<string> {
  const smokeToken = process.env.RW_MCP_DESKTOP_SMOKE_FRP_TOKEN?.trim();
  if (smokeToken) return smokeToken;
  const file = await loadSecretFile();
  const encrypted = file.frpToken;
  if (!encrypted) return '';
  const decoded = await decryptSecretValue(encrypted);
  if (decoded.reencrypted) {
    file.frpToken = decoded.reencrypted;
    await persistSecretFile(file);
  }
  return decoded.value;
}

async function writeFrpToken(token: string): Promise<void> {
  const file = await loadSecretFile();
  file.frpToken = await encryptSecretValue(token);
  await persistSecretFile(file);
}

function runtimeEndpoint(): string {
  return `http://127.0.0.1:${settings.port}/mcp`;
}

function selectedWorkspaceService(): WorkspaceServiceSettings | null {
  if (!settings.selectedWorkspace) return null;
  return settings.workspaceServices.find((item) => item.workspace === settings.selectedWorkspace && item.enabled) ?? null;
}

function selectedWorkspaceEndpoint(): string {
  const service = selectedWorkspaceService();
  return service ? workspaceLocalEndpoint(service) : '';
}

function workspaceLocalEndpoint(service: WorkspaceServiceSettings): string {
  return `http://127.0.0.1:${service.port}/mcp`;
}

function workspacePublicEndpoint(service: WorkspaceServiceSettings): string {
  if (!service.publicEnabled) return '';
  if (settings.publicAccessProvider === 'trycloudflare') {
    const base = String(tunnelState.publicUrl || '').replace(/\/+$/, '');
    return base ? `${base}/w/${encodeURIComponent(service.publicPath || service.workspace)}/mcp` : '';
  }
  if (!settings.tunnelBaseDomain) return '';
  const host = settings.publicAccessProvider === 'frp'
    ? `${settings.frpSubdomain}.${settings.tunnelBaseDomain}`
    : settings.tunnelBaseDomain;
  return `https://${host}/w/${encodeURIComponent(service.publicPath || service.workspace)}/mcp`;
}

function tryCloudflareReadinessPending(): boolean {
  if (settings.publicAccessProvider !== 'trycloudflare' || tunnelState.phase !== 'running') return false;
  const readyAt = tunnelState.readyAt ? Date.parse(tunnelState.readyAt) : 0;
  return Boolean(readyAt && Date.now() < readyAt);
}

function publicAccessReady(): boolean {
  if (settings.publicAccessProvider === 'external') return true;
  if (tunnelState.phase !== 'running') return false;
  return !tryCloudflareReadinessPending();
}

function healthUrlFromEndpoint(endpoint: string): string {
  const target = new URL(endpoint);
  target.pathname = target.pathname.endsWith('/mcp')
    ? `${target.pathname.slice(0, -4)}/healthz`
    : '/healthz';
  target.search = '';
  target.hash = '';
  return target.toString();
}

function inactiveHealthProbe(status: 'disabled' | 'stopped', message: string, url = ''): HealthProbeResult {
  return { ok: false, status, url, latencyMs: null, httpStatus: null, message };
}

async function probeRuntimeHealth(url: string, serviceId: string): Promise<HealthProbeResult> {
  const startedAt = Date.now();
  try {
    const payload = await requestRuntimeControl<{ ok?: boolean; serviceId?: string; workspaceError?: string }>('health', { serviceId }, 2_000);
    const latencyMs = Date.now() - startedAt;
    if (payload.serviceId && payload.serviceId !== serviceId) {
      return { ok: false, status: 'unhealthy', url, latencyMs, httpStatus: null, message: `IPC 响应来自其他 Service (${payload.serviceId})` };
    }
    if (payload.ok === false) {
      return { ok: false, status: 'unhealthy', url, latencyMs, httpStatus: null, message: payload.workspaceError || 'Runtime Workspace 不可用' };
    }
    return { ok: true, status: 'healthy', url, latencyMs, httpStatus: null, message: `Runtime IPC 正常 · ${latencyMs} ms` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return { ok: false, status: 'unhealthy', url, latencyMs, httpStatus: null, message: error instanceof Error ? error.message : String(error) };
  }
}

function clarifyPublicHealthProbe(probe: HealthProbeResult): HealthProbeResult {
  if (probe.ok) return probe;
  if (probe.httpStatus === 404) {
    return { ...probe, message: '公网 Workspace 路径未路由到本地 Gateway (HTTP 404)' };
  }
  if ([502, 503, 504].includes(probe.httpStatus ?? 0)) {
    return { ...probe, message: `公网反向代理已命中 Host，但无法连接本地 Gateway (HTTP ${probe.httpStatus})` };
  }
  if (probe.httpStatus === 530) {
    return {
      ...probe,
      message: settings.publicAccessProvider === 'cloudflare'
        ? 'Cloudflare 公网 DNS / Hostname 配置异常 (HTTP 530)'
        : '公网 Provider 返回 HTTP 530；请检查 DNS 与反向代理配置',
    };
  }
  return probe;
}

async function probeHealthUrl(url: string, expectedServiceId?: string): Promise<HealthProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    const response = await net.fetch(url, {
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const payload = await response.json().catch(() => null) as { ok?: boolean; serviceId?: string } | null;
    if (!response.ok) {
      return { ok: false, status: 'unhealthy', url, latencyMs, httpStatus: response.status, message: `HTTP ${response.status}` };
    }
    if (payload?.ok === false) {
      return { ok: false, status: 'unhealthy', url, latencyMs, httpStatus: response.status, message: 'healthz 返回异常状态' };
    }
    if (expectedServiceId && payload?.serviceId && payload.serviceId !== expectedServiceId) {
      return {
        ok: false,
        status: 'unhealthy',
        url,
        latencyMs,
        httpStatus: response.status,
        message: `响应来自其他 Service (${payload.serviceId})`,
      };
    }
    return { ok: true, status: 'healthy', url, latencyMs, httpStatus: response.status, message: `${latencyMs} ms` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const cause = error instanceof Error && error.cause && typeof error.cause === 'object'
      ? error.cause as { code?: string; message?: string }
      : null;
    const host = (() => {
      try { return new URL(url).hostname; } catch { return ''; }
    })();
    const message = error instanceof Error
      ? error.name === 'AbortError'
        ? '连接超时'
        : cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN'
          ? `DNS 未解析 ${host || '公网 Host'}；请检查公网 DNS 与 Provider 路由`
          : cause?.code === 'ECONNREFUSED'
            ? `连接被拒绝${host ? ` (${host})` : ''}`
            : error.message === 'fetch failed' && cause?.message
              ? cause.message
              : error.message
      : String(error);
    return { ok: false, status: 'unhealthy', url, latencyMs, httpStatus: null, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkWorkspaceHealth(): Promise<WorkspaceHealthResult[]> {
  const services = settings.workspaceServices.filter((service) => service.enabled);
  return Promise.all(services.map(async (service) => {
    const localEndpoint = workspaceLocalEndpoint(service);
    const publicEndpoint = workspacePublicEndpoint(service);
    let local = runtimeState.phase === 'running'
      ? await probeRuntimeHealth(healthUrlFromEndpoint(localEndpoint), workspaceServiceId(service.workspace))
      : inactiveHealthProbe('stopped', 'Runtime 未运行', healthUrlFromEndpoint(localEndpoint));
    if (local.ok) {
      local = { ...local, message: `${local.message} · Desktop 使用 Runtime IPC 控制面` };
    }
    const publicProbe = !publicEndpoint
      ? inactiveHealthProbe('disabled', '未启用公网 MCP')
      : publicAccessReady()
        ? clarifyPublicHealthProbe(await probeHealthUrl(healthUrlFromEndpoint(publicEndpoint), `gateway:${service.workspace}`))
        : inactiveHealthProbe(
            'stopped',
            tryCloudflareReadinessPending() ? 'TryCloudflare 已连接，等待公网路由与 OAuth 生效' : '公网客户端未运行',
            healthUrlFromEndpoint(publicEndpoint),
          );
    let deepPublic = publicProbe;
    if (publicProbe.ok) {
      try {
        deepPublic = service.publicAuthMode === 'oauth'
          ? await probeOauthBootstrap(publicEndpoint)
          : await probeMcpInitializeUrl(publicEndpoint, await readWorkspaceApiToken(service.workspace));
      } catch (error) {
        deepPublic = { ...publicProbe, ok: false, status: 'unhealthy', message: `公网认证凭据不可用：${error instanceof Error ? error.message : String(error)}` };
      }
    }
    return { workspace: service.workspace, local, public: clarifyPublicHealthProbe(deepPublic) };
  }));
}

async function checkPublicAccessConfiguration(): Promise<PublicAccessCheckResult> {
  const gatewayHealthUrl = `http://127.0.0.1:${settings.port}/healthz`;
  const localGateway = runtimeState.phase === 'running'
    ? await probeRuntimeHealth(gatewayHealthUrl, 'default')
    : inactiveHealthProbe('stopped', 'Runtime 未运行', gatewayHealthUrl);
  if (settings.publicAccessProvider === 'trycloudflare' && !tunnelState.publicUrl) {
    return { ok: false, summary: 'TryCloudflare 尚未启动或还未生成临时公网 URL', localGateway, routes: [] };
  }
  if (tryCloudflareReadinessPending()) {
    return { ok: false, summary: 'TryCloudflare 已连接，Runtime 已重载，正在等待公网路由与 OAuth 生效', localGateway, routes: [] };
  }
  if (settings.publicAccessProvider !== 'trycloudflare' && !settings.tunnelBaseDomain) {
    return { ok: false, summary: '尚未配置公网 Host', localGateway, routes: [] };
  }
  const publicServices = settings.workspaceServices.filter((service) => service.enabled && service.publicEnabled);
  if (!publicServices.length) {
    return { ok: false, summary: '公网 Host 已配置，但尚无启用公网 MCP 的 Workspace', localGateway, routes: [] };
  }
  const routes = await Promise.all(publicServices.map(async (service) => {
    const endpoint = workspacePublicEndpoint(service);
    let probe = clarifyPublicHealthProbe(await probeHealthUrl(
      healthUrlFromEndpoint(endpoint),
      `gateway:${service.workspace}`,
    ));
    if (probe.ok) {
      try {
        probe = service.publicAuthMode === 'oauth'
          ? await probeOauthBootstrap(endpoint)
          : await probeMcpInitializeUrl(endpoint, await readWorkspaceApiToken(service.workspace));
      } catch (error) {
        probe = { ...probe, ok: false, status: 'unhealthy', message: `公网认证凭据不可用：${error instanceof Error ? error.message : String(error)}` };
      }
      probe = clarifyPublicHealthProbe(probe);
    }
    return { workspace: service.workspace, probe };
  }));
  const passed = routes.filter((item) => item.probe.ok).length;
  const ok = localGateway.ok && passed === routes.length;
  const summary = ok
    ? `公网配置正常 · ${passed}/${routes.length} 个 Workspace 可访问`
    : `公网配置异常 · ${passed}/${routes.length} 个 Workspace 可访问`;
  return { ok, summary, localGateway, routes };
}

function workspaceServiceDefinitions(): Array<Record<string, unknown>> {
  return settings.workspaceServices
    .filter((service) => service.enabled)
    .map((service) => ({
      id: workspaceServiceId(service.workspace),
      name: `workspace:${service.workspace}`,
      host: '127.0.0.1',
      port: service.port,
      path: '/mcp',
      admin: false,
      publicUrl: '',
      workspaces: [service.workspace],
      toolTier: service.toolTier,
    }));
}

function mergedAdditionalServicesJson(): string {
  const advanced = settings.additionalServicesJson ? JSON.parse(settings.additionalServicesJson) as unknown[] : [];
  return JSON.stringify([...workspaceServiceDefinitions(), ...advanced]);
}

function appendLog(source: string, value: string | Buffer): void {
  const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  // Managed clients such as frpc emit ANSI SGR color/reset sequences even when
  // stdout/stderr is piped. Strip them before splitting so reset-only chunks do
  // not become visually empty log rows like "tunnel: \x1b[0m".
  const text = raw.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  for (const line of text.split(/\r?\n/).filter((item) => item.trim().length > 0)) {
    const stamp = new Date().toLocaleTimeString();
    const rendered = `[${stamp}] ${source}: ${line}`;
    logs.push(rendered);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:log', rendered);
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error(rendered);
  }
  if (logs.length > MAX_LOG_LINES) logs = logs.slice(-MAX_LOG_LINES);
}

function currentState(): DesktopState {
  return {
    revision: stateRevision,
    warnings: [...startupWarnings],
    platform: process.platform,
    version: app.getVersion(),
    settings,
    runtime: runtimeState,
    tunnel: tunnelState,
    endpoint: selectedWorkspaceEndpoint(),
    selectedWorkspace: settings.selectedWorkspace,
    workspacePath: settings.selectedWorkspace ? workspacePathForName(settings.selectedWorkspace) : settings.workspaceRoot,
    hasApiToken: false,
    workspaceTokenWorkspaces: [],
    workspaceOauthWorkspaces: [],
    hasTunnelToken: false,
    hasFrpToken: false,
    managedBinaries: {
      cloudflared: { kind: 'cloudflared', installed: false, version: '', path: '', previousVersion: '', installedVersions: [] },
      frpc: { kind: 'frpc', installed: false, version: '', path: '', previousVersion: '', installedVersions: [] },
    },
    managedLsp: { root: path.join(app.getPath('userData'), 'managed-tools', 'lsp'), languages: [] },
    computerUse: { enabled: settings.computerUseEnabled, available: false, platform: process.platform, screen: null, permissions: null },
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    logs: [...logs],
  };
}

async function stateWithSecrets(): Promise<DesktopState> {
  const file = await loadSecretFile();
  const apiToken = Boolean(file.apiToken);
  const workspaceTokens = Object.keys(file.workspaceApiTokens ?? {}).sort();
  const oauthSecrets = new Set(Object.keys(file.workspaceOauthAuthorizationSecrets ?? {}));
  const oauthKeys = new Set(Object.keys(file.workspaceOauthSigningKeys ?? {}));
  const oauthWorkspaces = [...oauthSecrets].filter((workspace) => oauthKeys.has(workspace)).sort();
  const tunnelToken = Boolean(process.env.RW_MCP_DESKTOP_SMOKE_TUNNEL_TOKEN?.trim() || file.tunnelToken);
  const [cloudflared, frpc] = await Promise.all([
    managedBinaryStatus(app.getPath('userData'), 'cloudflared'),
    managedBinaryStatus(app.getPath('userData'), 'frpc'),
  ]);
  const managedLsp = await managedLspStatus(app.getPath('userData'), desktopRuntimeStore?.getRuntimeSettings().runtimePath || defaultRuntimeSettings().runtimePath);
  const computerUse = settings.computerUseEnabled
    ? computerUseStatus()
    : { available: false, platform: process.platform, screen: null, permissions: null };
  return {
    ...currentState(),
    hasApiToken: apiToken,
    workspaceTokenWorkspaces: workspaceTokens,
    workspaceOauthWorkspaces: oauthWorkspaces,
    hasTunnelToken: tunnelToken,
    hasFrpToken: Boolean(process.env.RW_MCP_DESKTOP_SMOKE_FRP_TOKEN?.trim() || file.frpToken),
    managedBinaries: { cloudflared, frpc },
    managedLsp,
    computerUse: {
      enabled: settings.computerUseEnabled,
      available: computerUse.available === true,
      platform: process.platform,
      screen: computerUse.screen ?? null,
      permissions: computerUse.permissions ?? null,
      ...('error' in computerUse && computerUse.error ? { error: computerUse.error } : {}),
    },
  };
}

function scheduleStateBroadcast(): void {
  if (!broadcastQueued) {
    broadcastQueued = true;
    setTimeout(() => {
      broadcastQueued = false;
      const requestedRevision = stateRevision;
      void stateWithSecrets().then((snapshot) => {
        if (requestedRevision !== stateRevision) {
          scheduleStateBroadcast();
          return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:state', snapshot);
      }).catch((error) => {
        appendLog('desktop', `State broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 50).unref();
  }
}

function broadcastState(): void {
  stateRevision += 1;
  scheduleStateBroadcast();
  updateTrayMenu();
}

function runtimeEntryPath(): string {
  return path.join(app.getAppPath(), 'dist', 'server.js');
}

async function runtimeEnvironment(instanceId: string): Promise<NodeJS.ProcessEnv> {
  const apiToken = settings.authMode === 'token' ? await readApiToken() : '';
  if (settings.authMode === 'token' && !apiToken) throw new Error('Token authentication is enabled but no MCP token is stored');
  await mkdir(settings.workspaceRoot, { recursive: true });
  await mkdir(path.dirname(runtimeStateDbPath()), { recursive: true });
  const desktopWorkspaces = await listDesktopWorkspaces();
  const workspaceRegistry = Object.fromEntries(desktopWorkspaces.map((item) => [item.name, item.path]));
  const publicOrigins = settings.workspaceServices
    .map((service) => workspacePublicEndpoint(service))
    .filter(Boolean)
    .map((endpoint) => new URL(endpoint));
  const workspaceToolTiers = Object.fromEntries(
    settings.workspaceServices
      .filter((service) => service.enabled)
      .map((service) => [service.workspace, service.toolTier]),
  );
  const gatewayWorkspaceAuth: Record<string, Record<string, unknown>> = {};
  for (const service of settings.workspaceServices.filter((item) => item.enabled && item.publicEnabled && Boolean(workspacePublicEndpoint(item)))) {
    const route = service.publicPath || service.workspace;
    const audience = workspacePublicEndpoint(service);
    if (service.publicAuthMode === 'oauth') {
      const credentials = await ensureWorkspaceBuiltinOauthSecrets(service.workspace);
      gatewayWorkspaceAuth[route] = {
        mode: 'oauth_builtin',
        workspace: service.workspace,
        audience,
        scopes: ['mcp'],
        privateJwk: JSON.parse(credentials.privateJwk),
        authorizationSecretHash: hashWorkspaceOauthAuthorizationSecret(credentials.authorizationSecret),
      };
    } else {
      const workspaceToken = await ensureWorkspaceApiToken(service.workspace);
      if (!workspaceToken) throw new Error(`Workspace ${service.workspace} 的公网认证为 Bearer Token，但尚未生成或保存 Token`);
      gatewayWorkspaceAuth[route] = { mode: 'token', token: workspaceToken, workspace: service.workspace };
    }
  }
  const allowedHosts = [
    '127.0.0.1',
    `127.0.0.1:${settings.port}`,
    'localhost',
    `localhost:${settings.port}`,
    ...publicOrigins.map((origin) => origin.hostname),
  ];
  const allowedOrigins = [
    `http://127.0.0.1:${settings.port}`,
    `http://localhost:${settings.port}`,
    ...publicOrigins.map((origin) => origin.origin),
  ];
  return {
    ...environmentWithProxy(process.env, settings, 'runtime'),
    WORKSPACE_ROOT: settings.workspaceRoot,
    WORKSPACE_REGISTRY_JSON: JSON.stringify(workspaceRegistry),
    STATE_DB_PATH: runtimeStateDbPath(),
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(settings.port),
    MCP_AUTH_MODE: settings.authMode,
    MCP_API_TOKEN: apiToken,
    MCP_PUBLIC_URL: '',
    MCP_ALLOWED_HOSTS: allowedHosts.join(','),
    MCP_ALLOWED_ORIGINS: allowedOrigins.join(','),
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: JSON.stringify(gatewayWorkspaceAuth),
    MCP_GATEWAY_JSON_ONLY: settings.publicAccessProvider === 'trycloudflare' ? 'true' : 'false',
    MCP_WORKSPACE_TOOL_TIERS_JSON: JSON.stringify(workspaceToolTiers),
    MCP_LSP_MANAGED_ROOT: path.join(app.getPath('userData'), 'managed-tools', 'lsp'),
    LSP_CUSTOM_SERVERS: desktopRuntimeStore?.getRuntimeSettings().lspCustomServers || '[]',
    ADMIN_ENABLED: 'true',
    ADMIN_LOCAL_ONLY: 'true',
    MCP_WORKSPACES: settings.workspaceScope.join(','),
    MCP_ADDITIONAL_SERVICES_JSON: mergedAdditionalServicesJson(),
    RUNTIME_INSTANCE_ID: instanceId,
    APP_VERSION: app.getVersion(),
    MCP_TRACE_MODE: settings.debugMode,
    COMPUTER_USE_ENABLED: settings.computerUseEnabled ? 'true' : 'false',
    COMPUTER_USE_PUBLIC_ENABLED: settings.computerUseEnabled && settings.computerUsePublicEnabled ? 'true' : 'false',
    HIGH_RISK_CONFIRMATION_MODE: 'local',
    LOCAL_CONFIRMATION_TOKEN: localConfirmationToken,
    MCP_TRACE_FILE: path.join(app.getPath('userData'), 'runtime', 'tool-traces.ndjson'),
    MCP_HTTP_TRACE: settings.debugMode === 'off' ? '0' : '1',
  };
}

async function getRuntimeAdminSnapshot(): Promise<RuntimeAdminSnapshot> {
  const store = await runtimeStore();
  const assignments = new Map(store.listAssignments().map((item) => [item.workspace, item.profile]));
  const mcpServices: RuntimeAdminSnapshot['mcpServices'] = [
    {
      id: 'default',
      name: 'mcport',
      host: '127.0.0.1',
      port: settings.port,
      path: '/mcp',
      admin: true,
      publicUrl: '',
      workspaces: settings.workspaceScope.length ? [...settings.workspaceScope] : null,
    },
    ...settings.workspaceServices.filter((service) => service.enabled).map((service) => ({
      id: workspaceServiceId(service.workspace),
      name: `workspace:${service.workspace}`,
      host: '127.0.0.1',
      port: service.port,
      path: '/mcp',
      admin: false,
      publicUrl: '',
      workspaces: [service.workspace],
    })),
  ];
  const catalogSnapshot = await readRuntimeToolCatalog();
  const toolExposureByWorkspace = Object.fromEntries(settings.workspaceServices.map((service) => {
    const tier = service.toolTier;
    const available = catalogSnapshot.tools.length > 0;
    const allowed = (entry: RuntimeToolCatalogEntry) => (
      Array.isArray(entry.tiers) && entry.tiers.includes(tier)
    );
    return [service.workspace, {
      toolTier: tier,
      localSurface: 'full' as const,
      publicSurface: 'core' as const,
      localExposedCount: available ? catalogSnapshot.tools.filter(allowed).length : null,
      publicExposedCount: available ? catalogSnapshot.tools.filter((entry) => allowed(entry) && entry.exposedToModel === true).length : null,
      catalogCount: available ? catalogSnapshot.tools.length : null,
    }];
  }));
  return {
    runtime: store.getRuntimeSettings(),
    defaultAllowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
    profiles: store.listRuntimeProfiles(),
    workspaces: settings.registeredWorkspaces.map((workspace) => ({
      name: workspace.name,
      profile: assignments.get(workspace.name) ?? null,
    })),
    mcpServices,
    toolExposureByWorkspace,
  };
}

async function recoverInterruptedSave(): Promise<void> {
  let journal: SaveJournal;
  try {
    journal = JSON.parse(await readFile(saveJournalPath(), 'utf8')) as SaveJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    await backupCorruptFile(saveJournalPath(), '设置回滚日志', error);
    await rm(saveJournalPath(), { force: true });
    return;
  }
  if (journal?.version !== 1 || !journal.previousSettings || !journal.previousRuntime || !journal.previousSecrets) {
    await backupCorruptFile(saveJournalPath(), '设置回滚日志', new Error('回滚日志结构无效'));
    await rm(saveJournalPath(), { force: true });
    return;
  }
  const store = await runtimeStore();
  store.replaceRuntimeSettings(journal.previousRuntime);
  await persistSecretFile(journal.previousSecrets);
  await persistSettings(journal.previousSettings);
  await rm(saveJournalPath(), { force: true });
}

async function saveAllSettings(
  desktopInput: Partial<DesktopSettings> & { apiToken?: string; tunnelToken?: string; frpToken?: string },
  runtimeInput: Partial<RuntimeSettings>,
): Promise<{ state: DesktopState; runtimeAdmin: RuntimeAdminSnapshot; warning: string }> {
  const store = await runtimeStore();
  const previousSettings = settings;
  const previousRuntime = store.getRuntimeSettings();
  const previousSecrets = await loadSecretFile();
  const publicWasActive = previousSettings.publicAccessProvider === 'external'
    ? Boolean(previousSettings.tunnelBaseDomain)
    : tunnelState.phase === 'running' || tunnelState.phase === 'starting';
  let nextSettings = normalizeSettings(desktopInput, settings);
  nextSettings = reconcileWorkspaceServices(nextSettings, nextSettings.selectedWorkspace || undefined);
  const nextRuntime = normalizeRuntimeSettings(runtimeInput, previousRuntime);
  const runtimeDesktopKeys = [
    'port', 'workspaceScope', 'additionalServicesJson', 'authMode', 'debugMode', 'tunnelBaseDomain', 'computerUseEnabled', 'computerUsePublicEnabled',
    'proxyMode', 'proxyScope', 'proxyUrl', 'proxyBypass',
  ];
  const runtimeConfigChanged = JSON.stringify(previousRuntime) !== JSON.stringify(nextRuntime)
    || runtimeDesktopKeys.some((key) => JSON.stringify((previousSettings as unknown as Record<string, unknown>)[key]) !== JSON.stringify((nextSettings as unknown as Record<string, unknown>)[key]))
    || Boolean(desktopInput.apiToken?.trim());
  const publicConfigChanged = [
    'publicAccessProvider', 'publicClientMode', 'publicClientPath', 'publicClientVersion', 'tunnelBaseDomain',
    'cloudflareTransportProtocol', 'cloudflareEdgeIpVersion',
    'frpServerAddr', 'frpServerPort', 'frpSubdomain', 'frpRemotePort', 'frpTransportProtocol', 'frpUseCompression',
    'proxyMode', 'tunnelProxyEnabled', 'proxyUrl', 'proxyBypass',
  ].some((key) => (previousSettings as unknown as Record<string, unknown>)[key] !== (nextSettings as unknown as Record<string, unknown>)[key])
    || Boolean(desktopInput.tunnelToken?.trim())
    || Boolean(desktopInput.frpToken?.trim());

  const nextSecrets: SecretFile = {
    ...previousSecrets,
    workspaceApiTokens: { ...(previousSecrets.workspaceApiTokens ?? {}) },
    workspaceOauthAuthorizationSecrets: { ...(previousSecrets.workspaceOauthAuthorizationSecrets ?? {}) },
    workspaceOauthSigningKeys: { ...(previousSecrets.workspaceOauthSigningKeys ?? {}) },
  };
  if (typeof desktopInput.apiToken === 'string' && desktopInput.apiToken.trim()) {
    nextSecrets.apiToken = await encryptSecretValue(desktopInput.apiToken.trim());
  }
  if (typeof desktopInput.tunnelToken === 'string' && desktopInput.tunnelToken.trim()) {
    nextSecrets.tunnelToken = await encryptSecretValue(desktopInput.tunnelToken.trim());
  }
  if (typeof desktopInput.frpToken === 'string' && desktopInput.frpToken.trim()) {
    nextSecrets.frpToken = await encryptSecretValue(desktopInput.frpToken.trim());
  }
  if (nextSettings.authMode === 'token' && !nextSecrets.apiToken) {
    throw new Error('请先点击“生成”创建并保存 MCP Token');
  }

  const journal: SaveJournal = { version: 1, previousSettings, previousRuntime, previousSecrets };
  await atomicWriteJson(saveJournalPath(), journal);
  const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
  try {
    store.replaceRuntimeSettings(nextRuntime);
    await persistSecretFile(nextSecrets);
    await persistSettings(nextSettings);
    settings = nextSettings;
    nativeTheme.themeSource = settings.appearance;
    await applyNetworkProxy(settings);
    await rm(saveJournalPath(), { force: true });
    updateLoginItem();
  } catch (error) {
    try {
      store.replaceRuntimeSettings(previousRuntime);
      await persistSecretFile(previousSecrets);
      await persistSettings(previousSettings);
      settings = previousSettings;
      nativeTheme.themeSource = settings.appearance;
      await applyNetworkProxy(settings);
      await rm(saveJournalPath(), { force: true });
    } catch {
      // Keep the journal so the next app startup can restore the previous state.
    }
    throw error;
  }
  let warning = '';
  if (wasRunning && runtimeConfigChanged) {
    try {
      const restarted = await restartRuntime();
      if (restarted.runtime.phase !== 'running') {
        warning = `设置已保存，但 Runtime 未成功恢复：${restarted.runtime.error || restarted.runtime.phase}`;
        appendLog('desktop', warning);
      }
    } catch (error) {
      warning = `设置已保存，但 Runtime 重启失败：${error instanceof Error ? error.message : String(error)}`;
      appendLog('desktop', warning);
    }
  }
  if (publicConfigChanged && publicWasActive) {
    try {
      await stopTunnel();
      await startTunnel();
    } catch (error) {
      const message = `公网接入设置已保存，但客户端重新启动失败：${error instanceof Error ? error.message : String(error)}`;
      warning = warning ? `${warning}；${message}` : message;
      appendLog('desktop', message);
    }
  } else if (settings.publicAccessProvider === 'external' && settings.tunnelBaseDomain) {
    tunnelState = { phase: 'running', pid: null, startedAt: new Date().toISOString(), error: null };
  }
  broadcastState();
  return { state: await stateWithSecrets(), runtimeAdmin: await getRuntimeAdminSnapshot(), warning };
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') reject(new Error(`端口 ${port} 已被其他程序占用，请先关闭旧 Runtime 或在设置中更换 MCP 端口`));
      else reject(error);
    });
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function waitForRuntimeHealthy(child: UtilityProcess, instanceId: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'Runtime did not become healthy';
  while (Date.now() < deadline) {
    if (runtimeProcess !== child) throw new Error('Runtime process exited before becoming healthy');
    try {
      const payload = await requestRuntimeControl<{ ok?: boolean; instanceId?: string; workspaceError?: string }>('health', { serviceId: 'default' }, 500);
      if (payload.ok && payload.instanceId === instanceId) return;
      lastError = payload.instanceId && payload.instanceId !== instanceId
        ? 'Runtime IPC responded from a different Runtime instance'
        : payload.workspaceError || 'Runtime IPC health check failed';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(lastError);
}

async function waitForTunnelStarted(child: ChildProcess, timeoutMs = 1_200): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`公网客户端在启动完成前退出 (code=${code ?? 'unknown'})`));
    child.once('error', onError);
    child.once('exit', onExit);
    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();
  });
}

async function assertTryCloudflareCompatible(): Promise<void> {
  const configDir = path.join(app.getPath('home'), '.cloudflared');
  for (const name of ['config.yml', 'config.yaml']) {
    try {
      const info = await stat(path.join(configDir, name));
      if (info.isFile()) {
        throw new Error(`TryCloudflare Quick Tunnel 与 ~/.cloudflared/${name} 不兼容；请临时移走该配置文件，或改用正式 Cloudflare Tunnel`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('TryCloudflare Quick Tunnel')) throw error;
    }
  }
}

function waitForTryCloudflareUrl(child: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let captured = '';
    const pattern = /https:\/\/(?!api\.trycloudflare\.com\b)[a-z0-9-]+\.trycloudflare\.com\b/i;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
      child.removeListener('exit', onExit);
      error ? reject(error) : resolve(String(value));
    };
    const onData = (chunk: Buffer | string) => {
      captured = `${captured}${String(chunk)}`.slice(-32_768);
      const match = captured.match(pattern);
      if (match) finish(undefined, match[0]);
    };
    const onExit = (code: number | null) => {
      const detail = captured
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(' | ');
      finish(new Error(`TryCloudflare 在生成公网 URL 前退出 (code=${code ?? 'unknown'})${detail ? `：${detail}` : ''}`));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
    const timer = setTimeout(() => finish(new Error('TryCloudflare 启动超时：未收到 trycloudflare.com 公网 URL')), timeoutMs);
    timer.unref();
  });
}

async function startTunnel(recovery = false): Promise<DesktopState> {
  if (tunnelState.phase === 'running' || tunnelState.phase === 'starting') return stateWithSecrets();
  if (!recovery) tunnelRecoveryAttempt = 0;
  if (tunnelRecoveryResetTimer) {
    clearTimeout(tunnelRecoveryResetTimer);
    tunnelRecoveryResetTimer = null;
  }
  if (tunnelRecoveryTimer) {
    clearTimeout(tunnelRecoveryTimer);
    tunnelRecoveryTimer = null;
  }
  const publicRoutes = settings.workspaceServices.filter((service) => service.enabled && service.publicEnabled);
  if (settings.publicAccessProvider === 'external') {
    tunnelDesiredRunning = false;
    tunnelState = { phase: 'running', pid: null, startedAt: new Date().toISOString(), error: null };
    appendLog('tunnel', `外部公网接入已启用 · ${publicRoutes.length} 个 Workspace 使用 ${settings.tunnelBaseDomain || '未配置 Host'}`);
    broadcastState();
    return stateWithSecrets();
  }
  tunnelDesiredRunning = true;
  if (runtimeState.phase !== 'running') {
    const next = await startRuntime(false);
    if (next.runtime.phase !== 'running') {
      scheduleTunnelRecovery(next.runtime.error || 'Runtime 启动失败');
      throw new Error(next.runtime.error || 'Runtime 启动失败');
    }
  }

  tunnelState = {
    phase: 'starting',
    pid: null,
    startedAt: null,
    error: null,
    readinessStage: settings.publicAccessProvider === 'trycloudflare' ? 'requesting_url' : null,
    readyAt: null,
  };
  broadcastState();
  let clientLaunched = false;
  try {
    const provider = settings.publicAccessProvider;
    const kind: ManagedBinaryKind = provider === 'frp' ? 'frpc' : 'cloudflared';
    const executable = await selectedPublicClientExecutable(kind);
    let args: string[] = [];
    let childEnv = environmentWithProxy(process.env, settings, 'tunnel');
    if (provider === 'cloudflare') {
      const token = await readTunnelToken();
      if (!token) throw new Error('请先保存 Cloudflare Tunnel Token');
      args = [
        'tunnel', '--no-autoupdate', '--loglevel', 'info',
        '--protocol', settings.cloudflareTransportProtocol,
        '--edge-ip-version', settings.cloudflareEdgeIpVersion,
        'run',
      ];
      childEnv = { ...childEnv, TUNNEL_TOKEN: token };
    } else if (provider === 'trycloudflare') {
      await assertTryCloudflareCompatible();
      args = [
        'tunnel',
        '--protocol', settings.cloudflareTransportProtocol,
        '--edge-ip-version', settings.cloudflareEdgeIpVersion,
        '--url', `http://127.0.0.1:${settings.port}`,
      ];
    } else {
      const configPath = await writeFrpConfig();
      args = ['-c', configPath];
    }
    appendLog('tunnel', `Starting ${kind} · 当前 App 已配置 ${publicRoutes.length} 个 Workspace 公网路由`);
    const child = spawn(executable, args, {
      env: childEnv,
      cwd: app.getPath('userData'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    clientLaunched = child.pid != null;
    tunnelProcess = child;
    const quickTunnelUrlPromise = provider === 'trycloudflare' ? waitForTryCloudflareUrl(child) : null;
    child.stdout?.on('data', (chunk) => appendLog('tunnel', chunk));
    child.stderr?.on('data', (chunk) => appendLog('tunnel', chunk));
    child.once('exit', (code) => {
      appendLog('tunnel', `${kind} exited (code=${code})`);
      if (kind === 'frpc') void rm(frpConfigPath(), { force: true });
      tunnelProcess = null;
      if (tunnelState.phase !== 'stopping') {
        const exitedDuringStartup = tunnelState.phase === 'starting';
        tunnelState = {
          phase: code === 0 ? 'stopped' : 'error',
          pid: null,
          startedAt: null,
          error: code === 0 ? null : `${kind} exited with code ${code}`,
          publicUrl: null,
          ephemeral: provider === 'trycloudflare',
        };
        broadcastState();
        if (!(provider === 'trycloudflare' && exitedDuringStartup)) scheduleTunnelRecovery(tunnelState.error || '');
      }
    });
    let quickTunnelUrl: string | null = null;
    if (quickTunnelUrlPromise) quickTunnelUrl = await quickTunnelUrlPromise;
    else await waitForTunnelStarted(child);
    if (quickTunnelUrl) {
      tunnelState = {
        phase: 'starting',
        pid: child.pid ?? null,
        startedAt: null,
        error: null,
        publicUrl: quickTunnelUrl,
        ephemeral: true,
        readinessStage: 'runtime_reload',
        readyAt: null,
      };
      broadcastState();
      appendLog('tunnel', `TryCloudflare URL: ${quickTunnelUrl}`);
      await stopRuntime({ stopManagedTunnel: false });
      const restarted = await startRuntime(false);
      if (restarted.runtime.phase !== 'running') {
        tunnelAutostartSuppressed = true;
        tunnelDesiredRunning = false;
        throw new Error(restarted.runtime.error || 'Runtime 未能使用 TryCloudflare URL 重新启动');
      }
      tunnelAutostartSuppressed = false;
    }
    const readinessDelayMs = provider === 'trycloudflare' ? 2_500 : 0;
    const readinessUrl = quickTunnelUrl;
    tunnelState = {
      phase: 'running',
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      error: null,
      publicUrl: quickTunnelUrl,
      ephemeral: provider === 'trycloudflare',
      readinessStage: provider === 'trycloudflare' ? 'propagating' : 'ready',
      readyAt: readinessDelayMs ? new Date(Date.now() + readinessDelayMs).toISOString() : null,
    };
    if (readinessDelayMs) {
      const readinessTimer = setTimeout(() => {
        if (
          tunnelState.phase === 'running'
          && tunnelState.publicUrl === readinessUrl
          && tunnelState.readinessStage === 'propagating'
        ) {
          tunnelState = { ...tunnelState, readinessStage: 'ready', readyAt: null };
          appendLog('tunnel', 'TryCloudflare 公网路由与 OAuth readiness grace 已完成');
          broadcastState();
        }
      }, readinessDelayMs);
      readinessTimer.unref();
    }
    if (recovery) {
      tunnelRecoveryResetTimer = setTimeout(() => {
        tunnelRecoveryResetTimer = null;
        if (tunnelState.phase === 'running' && tunnelProcess === child) {
          tunnelRecoveryAttempt = 0;
          appendLog('desktop', 'Tunnel recovery backoff reset after stable connection');
        }
      }, TUNNEL_STABLE_RESET_MS);
      tunnelRecoveryResetTimer.unref();
    } else {
      tunnelRecoveryAttempt = 0;
    }
    const providerLabel = provider === 'frp' ? 'FRP Client' : provider === 'trycloudflare' ? 'TryCloudflare Quick Tunnel' : 'Cloudflare Tunnel';
    appendLog('tunnel', `${providerLabel} running · 当前 App 已配置 ${publicRoutes.length} 个 Workspace 公网路由`);
  } catch (error) {
    tunnelProcess?.kill('SIGTERM');
    tunnelProcess = null;
    await rm(frpConfigPath(), { force: true });
    tunnelState = {
      phase: 'error',
      pid: null,
      startedAt: null,
      error: error instanceof Error ? error.message : String(error),
      publicUrl: null,
      ephemeral: settings.publicAccessProvider === 'trycloudflare',
    };
    appendLog('tunnel', `Tunnel start failed: ${tunnelState.error}`);
    if (clientLaunched) scheduleTunnelRecovery(tunnelState.error || '');
  }
  broadcastState();
  return stateWithSecrets();
}

async function stopTunnel(): Promise<DesktopState> {
  tunnelDesiredRunning = false;
  if (tunnelRecoveryResetTimer) {
    clearTimeout(tunnelRecoveryResetTimer);
    tunnelRecoveryResetTimer = null;
  }
  if (tunnelRecoveryTimer) {
    clearTimeout(tunnelRecoveryTimer);
    tunnelRecoveryTimer = null;
  }
  const child = tunnelProcess;
  if (!child) {
    await rm(frpConfigPath(), { force: true });
    tunnelState = { phase: 'stopped', pid: null, startedAt: null, error: null, publicUrl: null, ephemeral: settings.publicAccessProvider === 'trycloudflare' };
    broadcastState();
    return stateWithSecrets();
  }
  tunnelState = { ...tunnelState, phase: 'stopping', error: null };
  broadcastState();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve();
    };
    child.once('exit', finish);
    child.kill('SIGTERM');
    const termTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    termTimer.unref();
    const killTimer = setTimeout(finish, 5_000);
    killTimer.unref();
  });
  tunnelProcess = null;
  await rm(frpConfigPath(), { force: true });
  tunnelState = { phase: 'stopped', pid: null, startedAt: null, error: null, publicUrl: null, ephemeral: settings.publicAccessProvider === 'trycloudflare' };
  appendLog('tunnel', '公网客户端已停止');
  broadcastState();
  return stateWithSecrets();
}

async function startRuntime(startConfiguredTunnel = true): Promise<DesktopState> {
  if (runtimeState.phase === 'running' || runtimeState.phase === 'starting') return stateWithSecrets();
  const generation = ++runtimeGeneration;
  if (runtimeRecoveryTimer) {
    clearTimeout(runtimeRecoveryTimer);
    runtimeRecoveryTimer = null;
  }
  runtimeState = { phase: 'starting', pid: null, startedAt: null, error: null };
  broadcastState();
  let child: UtilityProcess | null = null;
  const runtimeDiagnostics: string[] = [];
  const captureRuntimeDiagnostics = (chunk: Buffer | string) => {
    const text = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk)
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/(MCP_API_TOKEN|LOCAL_CONFIRMATION_TOKEN|BEARER_TOKEN|PRIVATE_JWK)\s*[:=]\s*\S+/gi, '$1=[redacted]');
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) runtimeDiagnostics.push(line);
    if (runtimeDiagnostics.length > 8) runtimeDiagnostics.splice(0, runtimeDiagnostics.length - 8);
  };
  try {
    await ensureRuntimePortsAvailable();
    const instanceId = randomBytes(16).toString('hex');
    appendLog('desktop', `Starting Runtime entry ${runtimeEntryPath()} on 127.0.0.1:${settings.port}`);
    child = utilityProcess.fork(runtimeEntryPath(), [], {
      env: await runtimeEnvironment(instanceId),
      stdio: 'pipe',
    });
    runtimeProcess = child;
    child.on('message', handleRuntimeControlMessage);
    appendLog('desktop', `Utility process created (pid=${child.pid ?? 'unknown'})`);
    child.stdout?.on('data', (chunk) => { captureRuntimeDiagnostics(chunk); appendLog('runtime', chunk); });
    child.stderr?.on('data', (chunk) => { captureRuntimeDiagnostics(chunk); appendLog('runtime', chunk); });
    child.once('exit', (code) => {
      child?.removeListener('message', handleRuntimeControlMessage);
      rejectRuntimeControlRequests(new Error(`Runtime exited with code ${code}`));
      appendLog('desktop', `Utility process exited (code=${code})`);
      if (generation !== runtimeGeneration || runtimeProcess !== child) return;
      runtimeProcess = null;
      if (runtimeState.phase !== 'stopping') {
        const diagnostic = runtimeDiagnostics.length ? ` · ${runtimeDiagnostics.slice(-4).join(' | ')}` : '';
        runtimeState = {
          phase: code === 0 ? 'stopped' : 'error',
          pid: null,
          startedAt: null,
          error: code === 0 ? null : `Runtime exited with code ${code}${diagnostic}`,
        };
        broadcastState();
        scheduleRuntimeRecovery();
      }
    });
    await waitForRuntimeHealthy(child, instanceId);
    if (generation !== runtimeGeneration || runtimeProcess !== child) return stateWithSecrets();
    runtimeState = {
      phase: 'running',
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      error: null,
    };
    runtimeRecoveryAttempt = 0;
    appendLog('desktop', `Runtime started at ${runtimeEndpoint()}`);
    if (process.env.RW_MCP_DESKTOP_SMOKE_DESKTOP_ONLY_SAVE === '1' && !desktopOnlySaveSmokeRan) {
      desktopOnlySaveSmokeRan = true;
      setTimeout(() => {
        void (async () => {
          const beforeProcess = runtimeProcess;
          const store = await runtimeStore();
          const nextAppearance: AppearanceMode = settings.appearance === 'dark' ? 'light' : 'dark';
          const saved = await saveAllSettings({ ...settings, appearance: nextAppearance }, store.getRuntimeSettings());
          if (runtimeProcess !== beforeProcess || saved.state.runtime.phase !== 'running') {
            throw new Error('Desktop-only settings save restarted or stopped Runtime');
          }
          console.error(`DESKTOP_DESKTOP_ONLY_SAVE_OK appearance=${nextAppearance}`);
        })().catch((error) => console.error(`DESKTOP_DESKTOP_ONLY_SAVE_FAILED=${error instanceof Error ? error.message : String(error)}`));
      }, 3000).unref();
    }
    if (startConfiguredTunnel && settings.startTunnelWithRuntime && !tunnelAutostartSuppressed) {
      try {
        await startTunnel();
      } catch (error) {
        tunnelState = {
          phase: 'error',
          pid: null,
          startedAt: null,
          error: error instanceof Error ? error.message : String(error),
        };
        appendLog('tunnel', `Tunnel autostart failed: ${tunnelState.error}`);
      }
    }
  } catch (error) {
    if (generation !== runtimeGeneration || (child && runtimeProcess !== child)) return stateWithSecrets();
    child?.kill();
    runtimeProcess = null;
    runtimeState = {
      phase: 'error',
      pid: null,
      startedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
    appendLog('desktop', `Runtime start failed: ${runtimeState.error}`);
    scheduleRuntimeRecovery();
  }
  broadcastState();
  return stateWithSecrets();
}

async function stopRuntime({ stopManagedTunnel = true }: { stopManagedTunnel?: boolean } = {}): Promise<DesktopState> {
  runtimeGeneration += 1;
  if (stopManagedTunnel && (tunnelProcess || tunnelState.phase !== 'stopped')) await stopTunnel();
  const child = runtimeProcess;
  if (!child) {
    runtimeState = { phase: 'stopped', pid: null, startedAt: null, error: null };
    broadcastState();
    return stateWithSecrets();
  }
  runtimeState = { ...runtimeState, phase: 'stopping', error: null };
  broadcastState();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', finish);
    child.kill();
    const timer = setTimeout(finish, 3_000);
    timer.unref();
  });
  runtimeProcess = null;
  runtimeState = { phase: 'stopped', pid: null, startedAt: null, error: null };
  appendLog('desktop', 'Runtime stopped');
  broadcastState();
  return stateWithSecrets();
}

async function restartRuntime(): Promise<DesktopState> {
  const preserveTunnel = Boolean(tunnelProcess) || tunnelState.phase === 'running' || tunnelState.phase === 'starting';
  await stopRuntime({ stopManagedTunnel: false });
  return startRuntime(!preserveTunnel);
}

function updateLoginItem(): void {
  if (process.env.RW_MCP_DESKTOP_SKIP_LOGIN_ITEM === '1') return;
  const current = app.getLoginItemSettings();
  if (current.openAtLogin === settings.launchAtLogin) return;
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    args: ['--hidden'],
  });
}

function trayImage() {
  const width = process.platform === 'darwin' ? 25 : 18;
  const height = process.platform === 'darwin' ? 25 : 18;
  const appIcon = nativeImage.createFromPath(path.join(app.getAppPath(), 'desktop', 'renderer', 'MCPort-Tray-Icon.png'));
  if (!appIcon.isEmpty()) {
    const image = appIcon.resize({ width, height, quality: 'best' });
    if (process.platform === 'darwin') image.setTemplateImage(true);
    return image;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2h7A2.5 2.5 0 0 1 16 4.5v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 15.5v-11Zm3 2.3v6.4h2V11h1.2c2.5 0 4.1-1.2 4.1-3.1 0-1.8-1.5-3.1-4-3.1H7Zm2 0h1.2c1.2 0 1.9.4 1.9 1.2s-.7 1.2-1.9 1.2H9V6.8Z" fill="#111827"/></svg>`;
  const fallback = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    .resize({ width, height, quality: 'best' });
  if (process.platform === 'darwin') fallback.setTemplateImage(true);
  return fallback;
}

function updateTrayMenu(): void {
  if (!tray) return;
  const tunnelRunning = tunnelState.phase === 'running';
  const providerName = settings.publicAccessProvider === 'frp'
    ? 'FRP'
    : settings.publicAccessProvider === 'trycloudflare'
      ? 'TryCloudflare'
      : settings.publicAccessProvider === 'external' ? '外部公网' : 'Cloudflare';
  tray.setToolTip(`MCPort — Runtime ${runtimeState.phase} · ${providerName} ${tunnelState.phase}`);
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: '显示窗口', click: () => showWindow() },
    { type: 'separator' },
  ];
  if (settings.publicAccessProvider !== 'external') {
    template.push(
      { label: tunnelRunning ? `${providerName} 运行中` : `启动 ${providerName}`, enabled: !tunnelRunning, click: () => { tunnelAutostartSuppressed = false; void startTunnel(); } },
      { label: `停止 ${providerName}`, enabled: tunnelRunning || tunnelState.phase === 'starting', click: () => void stopTunnel() },
      { type: 'separator' },
    );
  }
  template.push(
    { label: '退出', click: () => void quitApplication() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  updateTrayMenu();
}

function createWindow(forceShow = false): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (forceShow) showWindow();
    return;
  }
  const preloadPath = path.join(app.getAppPath(), 'desktop', 'preload.cjs');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'MCPort',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1020' : '#f5f7fb',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(path.join(app.getAppPath(), 'desktop', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (forceShow || !process.argv.includes('--hidden')) mainWindow?.show();
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    if (settings.minimizeToTray && settings.lowMemoryTray) mainWindow?.destroy();
    else if (settings.minimizeToTray) mainWindow?.hide();
    else void quitApplication();
  });
  mainWindow.on('closed', () => {
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_WINDOW_DESTROYED');
    mainWindow = null;
  });
}

async function quitApplication(): Promise<void> {
  if (isQuitting) return;
  isQuitting = true;
  if (runtimeRecoveryTimer) {
    clearTimeout(runtimeRecoveryTimer);
    runtimeRecoveryTimer = null;
  }
  await stopTunnel();
  await stopRuntime();
  desktopRuntimeStore?.close();
  desktopRuntimeStore = null;
  tray?.destroy();
  tray = null;
  app.quit();
}

function installIpcHandlers(): void {
  ipcMain.on('desktop:renderer-ready', () => {
    appendLog('desktop', 'Renderer ready');
    if (process.env.RW_MCP_DESKTOP_SMOKE_TOOL_DEBUG === '1') {
      void (async () => {
        const snapshot = await debugSnapshot() as { traces?: unknown[]; debugMode?: string; toolCatalog?: Array<{ name?: string; description?: string; tiers?: string[] }> };
        if (!Array.isArray(snapshot.traces)) throw new Error('Tool debug snapshot does not expose traces');
        if (!Array.isArray(snapshot.toolCatalog) || snapshot.toolCatalog.length === 0) throw new Error('Tool debug snapshot does not expose the MCP Tool Catalog');
        if (!snapshot.toolCatalog.some((tool) => tool.name === 'server_info' && typeof tool.description === 'string' && tool.description.length > 0)) {
          throw new Error('Tool debug snapshot catalog is missing server_info description');
        }
        if (snapshot.debugMode !== settings.debugMode || nativeTheme.themeSource !== settings.appearance) {
          throw new Error(`Debug/theme state mismatch: debug=${snapshot.debugMode}/${settings.debugMode} theme=${nativeTheme.themeSource}/${settings.appearance}`);
        }
        const runtimeAdminSnapshot = await getRuntimeAdminSnapshot();
        if (!runtimeAdminSnapshot.defaultAllowedCommands.includes('git') || !runtimeAdminSnapshot.defaultAllowedCommands.includes('node') || !runtimeAdminSnapshot.defaultAllowedCommands.includes('npm')) {
          throw new Error('Runtime admin snapshot does not expose the canonical default command set');
        }
        const rendererTheme = await mainWindow?.webContents.executeJavaScript(`(async () => {
          try {
          const waitFor = async (predicate, timeoutMs = 2500) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (predicate()) return true;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return Boolean(predicate());
          };
          setPage('debug');
          await refreshDebugSnapshot();
          await waitFor(() => document.querySelectorAll('#debugToolStats .debug-tool-stat-row:not(.debug-tool-stat-header)').length > 0);
          const styleOf = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const style = getComputedStyle(node);
            return { background: style.backgroundColor, color: style.color };
          };
          return {
            theme: document.documentElement.dataset.theme || '',
            control: styleOf('#authModeInput'),
            button: styleOf('#testProxyButton'),
            primaryButton: styleOf('#saveSettingsButton'),
            disabledButton: styleOf('#tunnelActionButton'),
            logsToolbar: styleOf('.logs-toolbar'),
            runtimeCardPresent: Boolean(document.querySelector('#globalRuntimeCard')),
            sidebarStatusPresent: Boolean(document.querySelector('.sidebar-status')),
            secondarySettingsColumns: (() => {
              const grid = document.querySelector('.global-secondary-settings-grid');
              return grid instanceof Element ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0;
            })(),
            allowedCommandsResetPresent: Boolean(document.querySelector('#resetAllowedCommandsButton')),
            managedClientVersionControlsPresent: (() => {
              const manager = document.querySelector('#publicClientVersionField');
              const grid = manager?.querySelector('.public-client-version-grid');
              const install = document.querySelector('#installPublicClientButton');
              return Boolean(
                manager
                && grid instanceof HTMLElement
                && getComputedStyle(grid).display === 'grid'
                && manager.querySelector('#publicClientCurrentVersion')
                && manager.querySelector('#publicClientLatestVersion')
                && manager.querySelector('#getLatestPublicClientVersionButton')
                && manager.querySelector('#publicClientVersionModeInput')
                && manager.querySelector('#publicClientVersionInput')
                && grid.contains(manager.querySelector('#publicClientCurrentVersion'))
                && grid.contains(manager.querySelector('#publicClientLatestVersion'))
                && grid.contains(manager.querySelector('#publicClientVersionModeInput'))
                && manager.contains(install)
              );
            })(),
            managedClientTargetInteraction: (() => {
              const provider = document.querySelector('#publicAccessProviderInput');
              const source = document.querySelector('#publicClientModeInput');
              const mode = document.querySelector('#publicClientVersionModeInput');
              const version = document.querySelector('#publicClientVersionInput');
              const specific = document.querySelector('#publicClientSpecificVersionField');
              const install = document.querySelector('#installPublicClientButton');
              if (!(provider instanceof HTMLSelectElement)
                || !(source instanceof HTMLSelectElement)
                || !(mode instanceof HTMLSelectElement)
                || !(version instanceof HTMLInputElement)
                || !(specific instanceof HTMLElement)
                || !(install instanceof HTMLButtonElement)) return false;
              provider.value = 'cloudflare';
              source.value = 'managed';
              mode.value = 'specific';
              version.value = '2026.8.2';
              updatePublicProviderFields();
              const specificOk = !specific.classList.contains('ui-hidden') && install.textContent.includes('2026.8.2') && !install.disabled;
              mode.value = 'latest';
              updatePublicProviderFields();
              const latestOk = specific.classList.contains('ui-hidden') && /最新版本/.test(install.textContent || '');
              return specificOk && latestOk;
            })(),
            rendererI18nInteraction: (() => {
              const language = document.querySelector('#uiLanguageInput');
              const publicTitle = document.querySelector('[data-i18n="settings.publicAccess.title"]');
              const localTitle = document.querySelector('[data-i18n="settings.localMcp.title"]');
              if (!(language instanceof HTMLSelectElement) || !publicTitle || !localTitle) return false;
              applyUiLanguage('en-US');
              const englishOk = publicTitle.textContent === 'Public access' && localTitle.textContent === 'Local MCP';
              applyUiLanguage('zh-CN');
              const chineseOk = publicTitle.textContent === '公网接入' && localTitle.textContent === '本地 MCP';
              return englishOk && chineseOk;
            })(),
            englishUiHanResiduals: (() => {
              applyUiLanguage('en-US');
              const residuals = [];
              const ignored = '#logs, .debug-traces, code, pre, script, style, .path, #startupWarningText';
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                const value = String(node.nodeValue || '').trim();
                if (!/[\u3400-\u9fff]/.test(value)) continue;
                const parent = node.parentElement;
                if (parent?.closest(ignored)) continue;
                residuals.push('text:' + (parent?.id || parent?.className || parent?.tagName) + ':' + value);
              }
              for (const element of document.querySelectorAll('[placeholder], [title], [aria-label], [data-help]')) {
                if (element.closest(ignored)) continue;
                for (const attr of ['placeholder', 'title', 'aria-label', 'data-help']) {
                  const value = element.getAttribute(attr) || '';
                  if (/[\u3400-\u9fff]/.test(value)) residuals.push(attr + ':' + (element.id || element.className || element.tagName) + ':' + value);
                }
              }
              applyUiLanguage('zh-CN');
              return residuals.slice(0, 40);
            })(),
            dynamicI18nSamples: (() => {
              applyUiLanguage('en-US');
              const samples = [
                '当前使用默认命令集 · 46 项',
                '尚未安装 cloudflared。请在版本管理中选择“最新版本”或“指定版本”后安装；公网 Host、Tunnel Token 等配置可以先填写并保存。',
                '公网接入：外部 / 自建；状态：运行中。公网 Host：mcp.demo.com。',
                '连接检查完成：2 项异常',
                '已恢复默认命令集（46 项），保存后生效',
                '保存失败：test error',
                '已撤销全部 OAuth 授权，客户端需要重新授权',
              ];
              const ok = samples.every((value) => !/[\u3400-\u9fff]/.test(localizedText(value)));
              applyUiLanguage('zh-CN');
              return ok;
            })(),
            workspaceSaveShortcutBorderless: (() => {
              const shortcut = document.querySelector('#saveCurrentWorkspaceButton .save-shortcut');
              if (!(shortcut instanceof HTMLElement)) return false;
              const style = getComputedStyle(shortcut);
              return style.borderTopWidth === '0px' && style.backgroundColor === 'rgba(0, 0, 0, 0)';
            })(),
            workspaceOauthRevokeControlPresent: Boolean(document.getElementById('revokeWorkspaceOauthAuthorizationsButton')),
            debugTabsInteraction: (() => {
              const statsTab = document.querySelector('[data-debug-tab="stats"]');
              const tracesTab = document.querySelector('[data-debug-tab="traces"]');
              const statsPanel = document.querySelector('[data-debug-panel="stats"]');
              const tracesPanel = document.querySelector('[data-debug-panel="traces"]');
              if (!(statsTab instanceof HTMLButtonElement) || !(tracesTab instanceof HTMLButtonElement) || !statsPanel || !tracesPanel) return false;
              const initialOk = statsTab.classList.contains('active') && statsPanel.classList.contains('active') && !tracesPanel.classList.contains('active');
              tracesTab.click();
              const tracesOk = tracesTab.classList.contains('active') && tracesPanel.classList.contains('active') && !statsPanel.classList.contains('active');
              statsTab.click();
              const statsOk = statsTab.classList.contains('active') && statsPanel.classList.contains('active') && !tracesPanel.classList.contains('active');
              return initialOk && tracesOk && statsOk;
            })(),
            debugStatsCatalogRendered: (() => {
              const rows = [...document.querySelectorAll('#debugToolStats .debug-tool-stat-row:not(.debug-tool-stat-header)')];
              const header = document.querySelector('#debugToolStats .debug-tool-stat-header');
              return rows.length > 0 && header?.children.length === 8 && rows.some((row) => row.textContent?.includes('server_info'));
            })(),
            adaptivePageWidths: ['#page-settings', '#page-logs', '#page-debug'].every((selector) => {
              const page = document.querySelector(selector);
              return page instanceof HTMLElement
                && getComputedStyle(page).maxWidth === '1180px';
            }),
            debugStatsResponsive: (() => {
              const row = document.querySelector('#debugToolStats .debug-tool-stat-row:not(.debug-tool-stat-header)');
              return row instanceof HTMLElement && getComputedStyle(row).minWidth === '0px';
            })(),
            debugInternalScroll: (() => {
              const content = document.querySelector('.content');
              const tracesTab = document.querySelector('[data-debug-tab="traces"]');
              const statsTab = document.querySelector('[data-debug-tab="stats"]');
              const tracesPanel = document.querySelector('[data-debug-panel="traces"]');
              const traces = document.querySelector('#debugTraces');
              if (!(content instanceof HTMLElement) || !(tracesTab instanceof HTMLButtonElement) || !(statsTab instanceof HTMLButtonElement) || !(tracesPanel instanceof HTMLElement) || !(traces instanceof HTMLElement)) return false;
              setPage('debug');
              tracesTab.click();
              const ok = getComputedStyle(content).overflowY === 'hidden'
                && getComputedStyle(tracesPanel).display === 'flex'
                && getComputedStyle(traces).overflowY === 'auto';
              statsTab.click();
              setPage('settings');
              return ok;
            })(),
            englishDecorativeLabelsHidden: (() => {
              const eyebrow = document.querySelector('.eyebrow');
              const kicker = document.querySelector('.section-kicker');
              return (!eyebrow || getComputedStyle(eyebrow).display === 'none')
                && (!kicker || getComputedStyle(kicker).display === 'none');
            })(),
          };
          } catch (error) {
            return { scriptError: String(error?.stack || error) };
          }
        })()`);
        if (rendererTheme?.scriptError) throw new Error(`Renderer tool-debug self-test failed: ${rendererTheme.scriptError}`);
        if (
          rendererTheme?.theme !== 'light'
          || rendererTheme?.control?.background !== 'rgb(255, 255, 255)'
          || rendererTheme?.button?.background !== 'rgb(248, 250, 252)'
          || rendererTheme?.primaryButton?.background !== 'rgb(52, 120, 246)'
          || rendererTheme?.primaryButton?.color !== 'rgb(255, 255, 255)'
          || !rendererTheme?.disabledButton?.background
          || rendererTheme?.logsToolbar?.background !== 'rgb(255, 255, 255)'
          || rendererTheme?.runtimeCardPresent !== false
          || rendererTheme?.sidebarStatusPresent !== false
          || Number(rendererTheme?.secondarySettingsColumns || 0) < 2
          || rendererTheme?.allowedCommandsResetPresent !== true
          || rendererTheme?.managedClientVersionControlsPresent !== true
          || rendererTheme?.managedClientTargetInteraction !== true
          || rendererTheme?.rendererI18nInteraction !== true
          || !Array.isArray(rendererTheme?.englishUiHanResiduals)
          || rendererTheme.englishUiHanResiduals.length !== 0
          || rendererTheme?.dynamicI18nSamples !== true
          || rendererTheme?.workspaceSaveShortcutBorderless !== true
          || rendererTheme?.workspaceOauthRevokeControlPresent !== true
          || rendererTheme?.debugTabsInteraction !== true
          || rendererTheme?.debugStatsCatalogRendered !== true
          || rendererTheme?.adaptivePageWidths !== true
          || rendererTheme?.debugStatsResponsive !== true
          || rendererTheme?.debugInternalScroll !== true
          || rendererTheme?.englishDecorativeLabelsHidden !== true
        ) {
          throw new Error(`Renderer light theme styles mismatch: ${JSON.stringify(rendererTheme)}`);
        }
        console.error(`DESKTOP_TOOL_DEBUG_OK traces=${snapshot.traces.length} tools=${snapshot.toolCatalog.length} theme=${nativeTheme.themeSource} rendererTheme=${rendererTheme.theme} provider=${settings.publicAccessProvider} public=${tunnelState.phase}`);
      })().catch((error) => console.error(`DESKTOP_TOOL_DEBUG_FAILED=${error instanceof Error ? error.message : String(error)}`));
    }
    if (process.env.RW_MCP_DESKTOP_SMOKE_ATOMIC_WORKSPACE_SAVE === '1') {
      void (async () => {
        const workspace = settings.registeredWorkspaces[0]?.name;
        if (!workspace) throw new Error('Atomic Workspace smoke requires one registered Workspace');
        const beforeService = settings.workspaceServices.find((item) => item.workspace === workspace);
        const store = await runtimeStore();
        const beforeProfile = store.getWorkspaceProfile(workspace);
        let failed = false;
        try {
          await saveWorkspaceSettingsAtomic(
            workspace,
            { toolTier: beforeService?.toolTier === 'readonly' ? 'full' : 'readonly' },
            { name: `${workspace} Runtime`, defaultCommandTimeoutMs: 5_000, maxCommandTimeoutMs: 1_000 },
          );
        } catch {
          failed = true;
        }
        const afterService = settings.workspaceServices.find((item) => item.workspace === workspace);
        const afterProfile = store.getWorkspaceProfile(workspace);
        if (!failed || afterService?.toolTier !== beforeService?.toolTier || Boolean(afterProfile) !== Boolean(beforeProfile)) {
          throw new Error('Atomic Workspace save rollback smoke failed');
        }
        console.error('DESKTOP_ATOMIC_WORKSPACE_ROLLBACK_OK');
      })().catch((error) => console.error(`DESKTOP_ATOMIC_WORKSPACE_ROLLBACK_FAILED=${error instanceof Error ? error.message : String(error)}`));
    }
    if (process.env.RW_MCP_DESKTOP_SMOKE_CONCURRENT_WORKSPACE_SAVE === '1') {
      void (async () => {
        const workspace = settings.registeredWorkspaces[0]?.name;
        if (!workspace) throw new Error('Concurrent Workspace smoke requires one registered Workspace');
        const service = settings.workspaceServices.find((item) => item.workspace === workspace);
        if (!service) throw new Error('Concurrent Workspace smoke requires one Workspace service');
        const beforeStarts = logs.filter((line) => line.includes('Starting Runtime entry')).length;
        await Promise.all([
          queueRuntimeMutation(() => saveWorkspaceSettingsAtomic(workspace, { toolTier: 'readonly' }, {})),
          queueRuntimeMutation(() => saveWorkspaceSettingsAtomic(workspace, { toolTier: 'full' }, {})),
          queueRuntimeMutation(() => saveWorkspaceSettingsAtomic(workspace, { toolTier: 'full' }, {})),
        ]);
        const afterService = settings.workspaceServices.find((item) => item.workspace === workspace);
        const afterStarts = logs.filter((line) => line.includes('Starting Runtime entry')).length;
        if (afterService?.toolTier !== 'full') throw new Error(`Concurrent Workspace save final tier mismatch: ${afterService?.toolTier}`);
        if (runtimeState.phase !== 'running') throw new Error(`Concurrent Workspace save left Runtime ${runtimeState.phase}: ${runtimeState.error || ''}`);
        if (afterStarts - beforeStarts !== 2) throw new Error(`Concurrent Workspace saves should perform two serialized restarts and skip the no-op save, got ${afterStarts - beforeStarts}`);
        console.error('DESKTOP_CONCURRENT_WORKSPACE_SAVE_OK');
      })().catch((error) => console.error(`DESKTOP_CONCURRENT_WORKSPACE_SAVE_FAILED=${error instanceof Error ? error.message : String(error)}`));
    }
    if (process.env.RW_MCP_DESKTOP_SMOKE_CLOSE_WINDOW === '1') {
      setTimeout(() => mainWindow?.close(), 250).unref();
    }
  });
  ipcMain.handle('desktop:get-state', () => stateWithSecrets());
  ipcMain.handle('desktop:check-app-update', () => checkForAppUpdate(app.getVersion()));
  ipcMain.handle('desktop:open-app-update', async (_event, value: unknown) => {
    const url = String(value || '');
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\//.test(url)) {
      throw new Error('Invalid GitHub release URL');
    }
    return shell.openExternal(url);
  });
  ipcMain.handle('desktop:open-computer-use-settings', async () => {
    if (process.platform === 'darwin') {
      const permissions = (await requestComputerUsePermissions()).permissions;
      const pane = permissions.screen === 'granted' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
      return true;
    }
    return false;
  });
  ipcMain.handle('desktop:get-computer-use-status', () => {
    const status = computerUseStatus();
    return status;
  });
  ipcMain.handle('desktop:check-workspace-health', () => checkWorkspaceHealth());
  ipcMain.handle('desktop:check-public-config', () => checkPublicAccessConfiguration());
  ipcMain.handle('desktop:test-proxy', (_event, input: Partial<DesktopSettings>) => testProxyConfiguration(input));
  ipcMain.handle('desktop:get-debug-snapshot', () => debugSnapshot());
  ipcMain.handle('desktop:clear-tool-traces', async () => {
    await clearToolTraces();
    return debugSnapshot();
  });
  ipcMain.handle('desktop:install-managed-client', (_event, kind: ManagedBinaryKind, version = '') => installManagedClient(kind, version));
  ipcMain.handle('desktop:get-managed-lsp-status', () => managedLspStatus(app.getPath('userData'), desktopRuntimeStore?.getRuntimeSettings().runtimePath || defaultRuntimeSettings().runtimePath));
  ipcMain.handle('desktop:install-managed-lsp', (_event, languageId: string) => installLsp(String(languageId || '').trim()));
  ipcMain.handle('desktop:open-managed-lsp', async (_event, languageId: string) => {
    const status = await managedLspStatus(app.getPath('userData'), desktopRuntimeStore?.getRuntimeSettings().runtimePath || defaultRuntimeSettings().runtimePath);
    const language = status.languages.find((item) => item.id === String(languageId || '').trim());
    if (!language) throw new Error('未知的 LSP 语言');
    return shell.openPath(language.directory);
  });
  ipcMain.handle('desktop:get-latest-managed-client-version', async (_event, kindValue: unknown) => {
    const kind: ManagedBinaryKind = String(kindValue) === 'frpc' ? 'frpc' : 'cloudflared';
    return latestManagedBinaryVersion(kind, managedDownloadFetch);
  });
  ipcMain.handle('desktop:rollback-managed-client', (_event, kind: ManagedBinaryKind) => rollbackManagedClient(kind));
  ipcMain.handle('desktop:clear-logs', async () => {
    logs = [];
    broadcastState();
    return stateWithSecrets();
  });
  ipcMain.handle('desktop:copy-text', (_event, value: unknown) => {
    clipboard.writeText(String(value ?? ''));
    return true;
  });
  ipcMain.handle('desktop:start-tunnel', () => {
    tunnelAutostartSuppressed = false;
    return startTunnel();
  });
  ipcMain.handle('desktop:stop-tunnel', () => stopTunnel());
  ipcMain.handle('desktop:list-workspaces', () => listDesktopWorkspaces());
  ipcMain.handle('desktop:add-existing-workspace', async () => {
    const options = {
      title: '添加已有 Workspace',
      properties: ['openDirectory'] as Array<'openDirectory'>,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return queueRuntimeMutation(() => registerExistingWorkspace(result.filePaths[0]));
  });
  ipcMain.handle('desktop:change-workspace-directory', async (_event, name: string) => {
    const options = {
      title: `更换 ${name} 的 Workspace 目录`,
      properties: ['openDirectory'] as Array<'openDirectory'>,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return queueRuntimeMutation(() => changeWorkspaceDirectory(name, result.filePaths[0]));
  });
  ipcMain.handle('desktop:remove-workspace', (_event, name: string) => queueRuntimeMutation(() => unregisterWorkspace(name)));
  ipcMain.handle('desktop:open-workspace', (_event, name: string) => openDesktopWorkspace(name));
  ipcMain.handle('desktop:set-workspace-enabled', (_event, workspace: string, enabled: boolean) =>
    queueRuntimeMutation(() => saveWorkspaceService(workspace, { enabled })));
  ipcMain.handle('desktop:save-workspace-settings', (
    _event,
    workspace: string,
    serviceInput: Partial<WorkspaceServiceSettings> & { apiToken?: string },
    runtimeInput: Partial<RuntimeProfile>,
  ) => queueRuntimeMutation(() => saveWorkspaceSettingsAtomic(workspace, serviceInput, runtimeInput)));
  ipcMain.handle('desktop:generate-workspace-token', (_event, workspace: string) => queueRuntimeMutation(async () => {
    const name = normalizeWorkspaceName(workspace);
    const workspaces = await listDesktopWorkspaces();
    if (!workspaces.some((item) => item.name === name)) throw new Error(`Unknown Workspace: ${name}`);
    const token = randomBytes(32).toString('base64url');
    await writeWorkspaceApiToken(name, token);
    const service = settings.workspaceServices.find((item) => item.workspace === name && item.enabled && item.publicEnabled && item.publicAuthMode === 'token');
    const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
    if (service && wasRunning) {
      const restarted = await restartRuntime();
      if (restarted.runtime.phase !== 'running') throw new Error(restarted.runtime.error || 'Runtime 未成功恢复');
    }
    appendLog('desktop', `Workspace ${name} Bearer Token 已轮换${service && wasRunning ? '并已重新加载 Runtime' : ''}`);
    broadcastState();
    return token;
  }));
  ipcMain.handle('desktop:regenerate-workspace-oauth-authorization-secret', (_event, workspace: string) => queueRuntimeMutation(async () => {
    const name = normalizeWorkspaceName(workspace);
    const workspaces = await listDesktopWorkspaces();
    if (!workspaces.some((item) => item.name === name)) throw new Error(`Unknown Workspace: ${name}`);
    const authorizationSecret = generateWorkspaceOauthAuthorizationSecret();
    await writeEncryptedWorkspaceSecret('workspaceOauthAuthorizationSecrets', name, authorizationSecret);
    const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
    if (wasRunning) await restartRuntime();
    broadcastState();
    return authorizationSecret;
  }));
  ipcMain.handle('desktop:revoke-workspace-oauth-authorizations', (_event, workspace: string) => queueRuntimeMutation(async () => {
    const name = normalizeWorkspaceName(workspace);
    const service = settings.workspaceServices.find((item) => item.workspace === name && item.enabled);
    if (!service) throw new Error(`Unknown Workspace: ${name}`);
    if (!service.publicEnabled || service.publicAuthMode !== 'oauth') throw new Error(`Workspace ${name} 当前未启用内置 OAuth 公网认证`);
    const issuer = workspaceOauthIssuer(service);
    const store = await runtimeStore();
    const revokedRecords = store.revokeOAuthProviderIssuer(issuer);
    await writeEncryptedWorkspaceSecret('workspaceOauthSigningKeys', name, generateWorkspaceOauthSigningJwk());
    const wasRunning = runtimeState.phase === 'running' || runtimeState.phase === 'starting';
    if (wasRunning) {
      const restarted = await restartRuntime();
      if (restarted.runtime.phase !== 'running') throw new Error(restarted.runtime.error || 'Runtime 未成功恢复');
    }
    appendLog('desktop', `Workspace ${name} OAuth 授权已全部撤销（清理 ${revokedRecords} 条 Provider 记录并轮换签名密钥）`);
    broadcastState();
    return { ok: true, revokedRecords, state: await stateWithSecrets() };
  }));
  ipcMain.handle('desktop:get-runtime-admin', async () => {
    if (isQuitting) return null;
    try {
      return await getRuntimeAdminSnapshot();
    } catch (error) {
      if (isQuitting) return null;
      throw error;
    }
  });
  ipcMain.handle('desktop:reset-runtime-settings', () => queueRuntimeMutation(async () => {
    const store = await runtimeStore();
    store.resetRuntimeSettings();
    return getRuntimeAdminSnapshot();
  }));
  ipcMain.handle('desktop:save-all-settings', (_event, desktopInput: Partial<DesktopSettings> & { apiToken?: string; tunnelToken?: string; frpToken?: string }, runtimeInput: Partial<RuntimeSettings>) =>
    queueRuntimeMutation(() => saveAllSettings(desktopInput, runtimeInput)));
  ipcMain.handle('desktop:copy-endpoint', () => {
    const value = selectedWorkspaceEndpoint();
    if (!value) throw new Error('请先选择 Workspace');
    clipboard.writeText(value);
    return value;
  });
  ipcMain.handle('desktop:copy-workspace-endpoint', (_event, workspace: string, kind: 'local' | 'public') => {
    const name = normalizeWorkspaceName(workspace);
    const service = settings.workspaceServices.find((item) => item.workspace === name && item.enabled);
    if (!service) throw new Error(`Workspace ${name} 尚未启用独立 MCP Service`);
    const value = kind === 'public' ? workspacePublicEndpoint(service) : workspaceLocalEndpoint(service);
    if (!value) throw new Error(`Workspace ${name} 尚未配置公网地址`);
    clipboard.writeText(value);
    return value;
  });
  ipcMain.handle('desktop:copy-workspace-auth', async (_event, workspace: string) => {
    const name = normalizeWorkspaceName(workspace);
    const service = settings.workspaceServices.find((item) => item.workspace === name && item.enabled && item.publicEnabled);
    if (!service) throw new Error(`Workspace ${name} 尚未启用公网 MCP`);
    if (service.publicAuthMode === 'oauth') {
      const authorizationSecret = await readEncryptedWorkspaceSecret('workspaceOauthAuthorizationSecrets', name);
      if (!authorizationSecret) throw new Error(`Workspace ${name} 尚未生成 OAuth 授权口令`);
      clipboard.writeText(authorizationSecret);
      return { mode: 'oauth' };
    }
    const token = await readWorkspaceApiToken(name);
    if (!token) throw new Error(`Workspace ${name} 尚未设置 Workspace Token`);
    clipboard.writeText(token);
    return { mode: 'token' };
  });
  ipcMain.handle('desktop:generate-token', async () => {
    const token = randomBytes(32).toString('base64url');
    await writeApiToken(token);
    broadcastState();
    return token;
  });
  ipcMain.handle('desktop:show-window', () => showWindow());
}

const hasSingleInstanceLock = process.env.RW_MCP_DESKTOP_ALLOW_MULTIPLE === '1'
  ? true
  : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (process.env.RW_MCP_DESKTOP_ALLOW_MULTIPLE !== '1') app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {
    if (!settings?.minimizeToTray) void quitApplication();
  });
  app.on('before-quit', (event) => {
    if (!isQuitting && (runtimeProcess || tunnelProcess)) {
      event.preventDefault();
      void quitApplication();
    }
  });
  if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_WAITING_READY');
  void app.whenReady().then(async () => {
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_READY');
    await recoverInterruptedSave();
    settings = await loadSettings();
    nativeTheme.themeSource = settings.appearance;
    if (settings.publicAccessProvider === 'external' && settings.tunnelBaseDomain) {
      tunnelState = { phase: 'running', pid: null, startedAt: new Date().toISOString(), error: null };
    }
    await applyNetworkProxy(settings);
    await syncWorkspaceServices(settings.selectedWorkspace || undefined);
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_SETTINGS_LOADED');
    await persistSettings(settings);
    updateLoginItem();
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_LOGIN_ITEM_UPDATED');
    installIpcHandlers();
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_IPC_READY');
    createWindow();
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_WINDOW_CREATED');
    void pollLocalConfirmations();
    void pollOAuthInteractionNotices();
    createTray();
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_TRAY_CREATED');
    void startRuntime();
    if (process.env.RW_MCP_DESKTOP_DEBUG === '1') console.error('DESKTOP_RUNTIME_MANAGED=true');
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}
