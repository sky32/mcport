import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveExistingPath } from './security.js';
import { MACOS_LOCAL_ONLY_NETWORK_PROFILE } from './runtime.js';

export type LspKind =
  | 'typescript' | 'html' | 'css'
  | 'python' | 'json' | 'yaml' | 'markdown'
  | 'go' | 'rust' | 'java' | 'c' | 'cpp' | 'php' | 'custom';
export type LspOperation = 'diagnostics' | 'hover' | 'definition' | 'source_definition' | 'references' | 'document_symbols';
export type LspExecutableSource = 'configured-path' | 'workspace' | 'managed' | 'runtime-path';

export type ResolvedLspExecutable = {
  path: string;
  source: LspExecutableSource;
  launchMode: 'direct' | 'embedded-node';
};

export type LspRuntimeConfig = {
  runtimePath: string;
  maxFileBytes: number;
  lspEnabled?: boolean;
  lspRequestTimeoutMs?: number;
  lspTypeScriptCommand?: string;
  lspHtmlCommand?: string;
  lspCssCommand?: string;
  lspManagedRoot?: string;
  lspCustomServers?: string;
  allowExternalNetwork?: boolean;
  networkIsolationRequired?: boolean;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type OpenDocument = { version: number; text: string };

const DEFAULT_COMMANDS: Record<LspKind, string> = {
  typescript: 'typescript-language-server',
  html: 'vscode-html-language-server',
  css: 'vscode-css-language-server',
  python: 'pyright-langserver',
  json: 'vscode-json-language-server',
  yaml: 'yaml-language-server',
  markdown: 'marksman',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
  c: 'clangd',
  cpp: 'clangd',
  php: 'intelephense',
  custom: '',
};

const DEFAULT_ARGS: Record<LspKind, string[]> = {
  typescript: ['--stdio'],
  html: ['--stdio'],
  css: ['--stdio'],
  python: ['--stdio'],
  json: ['--stdio'],
  yaml: ['--stdio'],
  markdown: ['server'],
  go: ['serve'],
  rust: [],
  java: [],
  c: ['--stdio'],
  cpp: ['--stdio'],
  php: ['--stdio'],
  custom: [],
};

type CustomLspServer = { id: string; extensions: string[]; languageId: string; command: string; args: string[] };

function customServers(config: LspRuntimeConfig): CustomLspServer[] {
  try {
    const parsed = JSON.parse(config.lspCustomServers || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({ ...item, id: typeof item?.languageId === 'string' ? item.languageId : '' })).filter((item): item is CustomLspServer => item && typeof item.id === 'string' && item.id.length > 0 && Array.isArray(item.extensions) && item.extensions.every((value: unknown) => typeof value === 'string') && typeof item.languageId === 'string' && typeof item.command === 'string' && !item.command.includes('/') && !item.command.includes('\\') && Array.isArray(item.args) && item.args.every((value: unknown) => typeof value === 'string'));
  } catch { return []; }
}

const LANGUAGE_IDS: Record<string, { kind: LspKind; languageId: string }> = {
  '.ts': { kind: 'typescript', languageId: 'typescript' },
  '.tsx': { kind: 'typescript', languageId: 'typescriptreact' },
  '.js': { kind: 'typescript', languageId: 'javascript' },
  '.jsx': { kind: 'typescript', languageId: 'javascriptreact' },
  '.mjs': { kind: 'typescript', languageId: 'javascript' },
  '.cjs': { kind: 'typescript', languageId: 'javascript' },
  '.mts': { kind: 'typescript', languageId: 'typescript' },
  '.cts': { kind: 'typescript', languageId: 'typescript' },
  '.html': { kind: 'html', languageId: 'html' },
  '.htm': { kind: 'html', languageId: 'html' },
  '.css': { kind: 'css', languageId: 'css' },
  '.scss': { kind: 'css', languageId: 'scss' },
  '.less': { kind: 'css', languageId: 'less' },
  '.py': { kind: 'python', languageId: 'python' },
  '.pyi': { kind: 'python', languageId: 'python' },
  '.json': { kind: 'json', languageId: 'json' },
  '.jsonc': { kind: 'json', languageId: 'jsonc' },
  '.yaml': { kind: 'yaml', languageId: 'yaml' },
  '.yml': { kind: 'yaml', languageId: 'yaml' },
  '.md': { kind: 'markdown', languageId: 'markdown' },
  '.markdown': { kind: 'markdown', languageId: 'markdown' },
  '.go': { kind: 'go', languageId: 'go' },
  '.rs': { kind: 'rust', languageId: 'rust' },
  '.java': { kind: 'java', languageId: 'java' },
  '.c': { kind: 'c', languageId: 'c' },
  '.h': { kind: 'c', languageId: 'c' },
  '.cc': { kind: 'cpp', languageId: 'cpp' },
  '.cp': { kind: 'cpp', languageId: 'cpp' },
  '.cpp': { kind: 'cpp', languageId: 'cpp' },
  '.cxx': { kind: 'cpp', languageId: 'cpp' },
  '.hpp': { kind: 'cpp', languageId: 'cpp' },
  '.hh': { kind: 'cpp', languageId: 'cpp' },
  '.hxx': { kind: 'cpp', languageId: 'cpp' },
  '.php': { kind: 'php', languageId: 'php' },
};

function commandFor(config: LspRuntimeConfig, kind: LspKind): string {
  if (kind === 'typescript') return config.lspTypeScriptCommand?.trim() || DEFAULT_COMMANDS.typescript;
  if (kind === 'html') return config.lspHtmlCommand?.trim() || DEFAULT_COMMANDS.html;
  if (kind === 'css') return config.lspCssCommand?.trim() || DEFAULT_COMMANDS.css;
  return DEFAULT_COMMANDS[kind];
}

async function executableExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableName(command: string): string {
  return process.platform === 'win32' && !command.toLowerCase().endsWith('.cmd') ? `${command}.cmd` : command;
}

async function regularFileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function managedPackageRoot(command: string, managedRoot: string): string {
  const id = command === DEFAULT_COMMANDS.typescript ? 'typescript' : command === DEFAULT_COMMANDS.html ? 'html' : command === DEFAULT_COMMANDS.css ? 'css' : command;
  return path.join(managedRoot, id);
}

function managedEntryPoint(command: string, managedRoot: string): string | null {
  const packageRoot = managedPackageRoot(command, managedRoot);
  if (command === DEFAULT_COMMANDS.typescript) {
    return path.join(packageRoot, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
  }
  if (command === DEFAULT_COMMANDS.html) {
    return path.join(packageRoot, 'node_modules', 'vscode-langservers-extracted', 'bin', 'vscode-html-language-server');
  }
  if (command === DEFAULT_COMMANDS.css) {
    return path.join(packageRoot, 'node_modules', 'vscode-langservers-extracted', 'bin', 'vscode-css-language-server');
  }
  return null;
}

export async function resolveLspExecutable(
  root: string,
  command: string,
  runtimePath: string,
  managedRoot = '',
): Promise<ResolvedLspExecutable | null> {
  if (path.isAbsolute(command)) {
    return await executableExists(command) ? { path: command, source: 'configured-path', launchMode: 'direct' } : null;
  }
  if (command.includes('/') || command.includes('\\')) {
    const workspaceCandidate = path.resolve(root, command);
    return await executableExists(workspaceCandidate) ? { path: workspaceCandidate, source: 'configured-path', launchMode: 'direct' } : null;
  }

  const name = executableName(command);
  const workspaceLocal = path.join(root, 'node_modules', '.bin', name);
  if (await executableExists(workspaceLocal)) return { path: workspaceLocal, source: 'workspace', launchMode: 'direct' };

  if (managedRoot) {
    const managed = managedEntryPoint(command, managedRoot);
    if (managed && await regularFileExists(managed)) return { path: managed, source: 'managed', launchMode: 'embedded-node' };
    const managedBin = path.join(managedPackageRoot(command, managedRoot), 'node_modules', '.bin', name);
    if (await executableExists(managedBin)) return { path: managedBin, source: 'managed', launchMode: 'direct' };
  }

  for (const entry of runtimePath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, name);
    if (await executableExists(candidate)) return { path: candidate, source: 'runtime-path', launchMode: 'direct' };
  }
  return null;
}

function documentKind(relativePath: string, config: LspRuntimeConfig): { kind: LspKind; languageId: string; custom?: CustomLspServer } {
  const ext = path.extname(relativePath).toLowerCase();
  const custom = customServers(config).find((server) => server.extensions.map((value) => value.toLowerCase().startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`).includes(ext));
  if (custom) return { kind: 'custom', languageId: custom.languageId, custom };
  const value = LANGUAGE_IDS[ext];
  if (!value) throw new Error(`No configured language server for ${ext || 'extensionless file'}`);
  return value;
}

export type TypeScriptServerSelection = {
  path?: string;
  fallbackPath: string;
  workspaceVersion: string | null;
  managedVersion: string | null;
  source: 'workspace-compatible' | 'managed' | 'fallback';
  selectedVersion: string | null;
  selectedTsserver: string | null;
  ready: boolean;
  missingRuntimeFiles: string[];
};

const TYPESCRIPT_RUNTIME_REQUIRED_FILES = [
  'tsserver.js',
  'lib.d.ts',
  'lib.es5.d.ts',
  'lib.es2015.d.ts',
  'lib.esnext.d.ts',
] as const;

async function inspectTypeScriptRuntime(tsserverPath: string | null): Promise<{ ready: boolean; missingRuntimeFiles: string[] }> {
  if (!tsserverPath) return { ready: false, missingRuntimeFiles: [...TYPESCRIPT_RUNTIME_REQUIRED_FILES] };
  const libDir = path.dirname(tsserverPath);
  const missingRuntimeFiles = [];
  for (const file of TYPESCRIPT_RUNTIME_REQUIRED_FILES) {
    if (!await regularFileExists(path.join(libDir, file))) missingRuntimeFiles.push(file);
  }
  return { ready: missingRuntimeFiles.length === 0, missingRuntimeFiles };
}

async function readPackageVersion(packagePath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && /^\d+\.\d+/.test(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function resolveTypeScriptServerOptions(
  root: string,
  managedRoot = '',
): Promise<TypeScriptServerSelection> {
  const fallbackPath = managedRoot ? path.join(managedPackageRoot(DEFAULT_COMMANDS.typescript, managedRoot), 'node_modules', 'typescript', 'lib') : '';
  const managedTsserver = path.join(fallbackPath, 'tsserver.js');
  const managedVersion = managedRoot ? await readPackageVersion(path.join(managedPackageRoot(DEFAULT_COMMANDS.typescript, managedRoot), 'node_modules', 'typescript', 'package.json')) : null;

  let workspaceVersion: string | null = null;
  let workspaceTsserver: string | null = null;
  try {
    const packagePath = await resolveExistingPath(root, 'node_modules/typescript/package.json');
    workspaceVersion = await readPackageVersion(packagePath);
    const candidate = path.join(path.dirname(packagePath), 'lib', 'tsserver.js');
    if (await regularFileExists(candidate)) workspaceTsserver = candidate;
  } catch {
    // A Workspace does not need to install TypeScript locally. In that case the managed runtime is used.
  }

  const major = workspaceVersion ? Number.parseInt(workspaceVersion.split('.')[0] || '', 10) : Number.NaN;
  if (workspaceVersion && Number.isFinite(major) && major <= 6 && workspaceTsserver) {
    const health = await inspectTypeScriptRuntime(workspaceTsserver);
    return {
      fallbackPath,
      workspaceVersion,
      managedVersion,
      source: 'workspace-compatible',
      selectedVersion: workspaceVersion,
      selectedTsserver: workspaceTsserver,
      ...health,
    };
  }

  const health = managedRoot ? await inspectTypeScriptRuntime(managedTsserver) : { ready: false, missingRuntimeFiles: [...TYPESCRIPT_RUNTIME_REQUIRED_FILES] };
  return {
    path: managedRoot ? managedTsserver : undefined,
    fallbackPath,
    workspaceVersion,
    managedVersion,
    source: managedRoot ? 'managed' : 'fallback',
    selectedVersion: managedVersion,
    selectedTsserver: managedRoot ? managedTsserver : null,
    ...health,
  };
}

async function runtimeExecutable(command: string, runtimePath: string): Promise<string | null> {
  for (const entry of runtimePath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, process.platform === 'win32' ? `${command}.exe` : command);
    if (await executableExists(candidate)) return candidate;
  }
  return null;
}

type LspSpawnPlan = {
  command: string;
  args: string[];
  embeddedNode: boolean;
};

async function lspSpawnPlan(executable: ResolvedLspExecutable, args: string[], config: LspRuntimeConfig): Promise<LspSpawnPlan> {
  const base = executable.launchMode === 'embedded-node'
    ? { command: process.execPath, args: [executable.path, ...args], embeddedNode: true }
    : { command: executable.path, args, embeddedNode: false };
  if (config.allowExternalNetwork) return base;
  if (process.platform === 'darwin' && await executableExists('/usr/bin/sandbox-exec')) {
    return { command: '/usr/bin/sandbox-exec', args: ['-p', MACOS_LOCAL_ONLY_NETWORK_PROFILE, base.command, ...base.args], embeddedNode: base.embeddedNode };
  }
  if (process.platform === 'linux') {
    const bwrap = await runtimeExecutable('bwrap', config.runtimePath);
    if (bwrap) return { command: bwrap, args: ['--die-with-parent', '--unshare-net', '--bind', '/', '/', '--', base.command, ...base.args], embeddedNode: base.embeddedNode };
    const unshare = await runtimeExecutable('unshare', config.runtimePath);
    if (unshare) return { command: unshare, args: ['--user', '--map-root-user', '--net', '--', base.command, ...base.args], embeddedNode: base.embeddedNode };
  }
  if (config.networkIsolationRequired !== false) throw new Error(`LSP network isolation is required but unavailable on ${process.platform}`);
  return base;
}

function offlineEnvironment(config: LspRuntimeConfig): NodeJS.ProcessEnv {
  if (config.allowExternalNetwork) return { ...process.env, PATH: config.runtimePath };
  return {
    ...process.env,
    PATH: config.runtimePath,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'socks5://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost,::1',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'socks5://127.0.0.1:9',
    no_proxy: '127.0.0.1,localhost,::1',
    RW_MCP_NETWORK_ACCESS: 'deny',
  };
}

class LspSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly diagnostics = new Map<string, unknown[]>();
  private readonly documents = new Map<string, OpenDocument>();
  private initialized = false;
  private stderrTail = '';

  constructor(
    private readonly root: string,
    private readonly kind: LspKind,
    private readonly executable: ResolvedLspExecutable,
    private readonly config: LspRuntimeConfig,
    private readonly custom?: CustomLspServer,
  ) {}

  private timeoutMs(): number {
    return Math.max(250, Math.min(this.config.lspRequestTimeoutMs ?? 8_000, 60_000));
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.kind} language server is not running`);
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.kind} LSP request timed out: ${method}`));
      }, this.timeoutMs());
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  private onMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `LSP error ${message.error.code ?? ''}`.trim()));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics') {
      const uri = String(message.params?.uri ?? '');
      this.diagnostics.set(uri, Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : []);
      return;
    }

    if (message.id !== undefined && message.method) {
      if (message.method === 'workspace/configuration') {
        const items = Array.isArray(message.params?.items) ? message.params.items : [];
        this.respond(message.id, items.map(() => null));
      } else if (message.method === 'workspace/workspaceFolders') {
        this.respond(message.id, [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }]);
      } else {
        this.respond(message.id, null);
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // Ignore malformed server frames; subsequent valid frames remain parseable.
      }
    }
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.child) throw new Error(`${this.kind} language server is starting`);
    const plan = await lspSpawnPlan(this.executable, this.custom?.args ?? DEFAULT_ARGS[this.kind], this.config);
    const env = offlineEnvironment(this.config);
    if (plan.embeddedNode && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawn(plan.command, plan.args, {
      cwd: this.root,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-8_192);
    });
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      const stderr = this.stderrTail.trim();
      const suffix = stderr ? `: ${stderr}` : '';
      this.failAll(new Error(`${this.kind} language server exited (${code ?? signal ?? 'unknown'})${suffix}`));
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 25);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const tsserver = this.kind === 'typescript' ? await resolveTypeScriptServerOptions(this.root, this.config.lspManagedRoot) : null;
    const initializationOptions = this.kind === 'typescript'
      ? {
          hostInfo: 'mcport',
          disableAutomaticTypingAcquisition: true,
          tsserver: tsserver ? { path: tsserver.path, fallbackPath: tsserver.fallbackPath } : undefined,
        }
      : undefined;
    try {
      await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'mcport', version: process.env.APP_VERSION || '0.1.0' },
        rootUri: pathToFileURL(this.root).href,
        workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: false },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            publishDiagnostics: { relatedInformation: true },
            hover: { dynamicRegistration: false },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          },
        },
        initializationOptions,
      });
      this.notify('initialized', {});
      this.initialized = true;
    } catch (error) {
      try { child.kill('SIGTERM'); } catch {}
      const message = error instanceof Error ? error.message : String(error);
      const stderr = this.stderrTail.trim();
      this.failAll(error instanceof Error ? error : new Error(message));
      throw new Error(stderr && !message.includes(stderr) ? `${message}: ${stderr}` : message);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.initialized = false;
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    this.diagnostics.clear();
  }

  async syncDocument(relativePath: string, absolutePath: string, text: string, languageId: string): Promise<string> {
    await this.start();
    const uri = pathToFileURL(absolutePath).href;
    const current = this.documents.get(uri);
    if (!current) {
      this.diagnostics.delete(uri);
      this.documents.set(uri, { version: 1, text });
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
    } else if (current.text !== text) {
      const version = current.version + 1;
      this.diagnostics.delete(uri);
      this.documents.set(uri, { version, text });
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    void relativePath;
    return uri;
  }

  async query(operation: LspOperation, uri: string, line: number, character: number): Promise<unknown> {
    const position = { line: Math.max(0, line - 1), character: Math.max(0, character) };
    if (operation === 'hover') return this.request('textDocument/hover', { textDocument: { uri }, position });
    if (operation === 'definition') return this.request('textDocument/definition', { textDocument: { uri }, position });
    if (operation === 'source_definition') {
      return this.request('workspace/executeCommand', {
        command: '_typescript.goToSourceDefinition',
        arguments: [uri, position],
      });
    }
    if (operation === 'references') {
      return this.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } });
    }
    if (operation === 'document_symbols') return this.request('textDocument/documentSymbol', { textDocument: { uri } });

    let pulled: unknown[] | null = null;
    try {
      const result = await this.request('textDocument/diagnostic', { textDocument: { uri } }) as { items?: unknown[] } | null;
      if (result && Array.isArray(result.items)) pulled = result.items;
    } catch {
      // Servers using push diagnostics may not implement textDocument/diagnostic.
    }
    if (pulled) return pulled;
    const deadline = Date.now() + Math.min(this.timeoutMs(), 1_000);
    while (Date.now() < deadline) {
      if (this.diagnostics.has(uri)) return this.diagnostics.get(uri) ?? [];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.diagnostics.get(uri) ?? [];
  }

  stop(): void {
    try { this.notify('exit'); } catch {}
    this.child?.kill('SIGTERM');
    this.failAll(new Error(`${this.kind} language server stopped`));
  }
}

export class LspManager {
  private readonly sessions = new Map<string, LspSession>();
  private readonly statusCache = new Map<string, { expiresAt: number; value: Awaited<ReturnType<LspManager['statusUncached']>> }>();

  private key(root: string, kind: string): string {
    return `${root}\0${kind}`;
  }

  private async statusUncached(root: string, config: LspRuntimeConfig) {
    const enabled = config.lspEnabled !== false;
    const entries = await Promise.all((Object.keys(DEFAULT_COMMANDS) as LspKind[]).filter((kind) => kind !== 'custom').map(async (kind) => {
      const configuredCommand = commandFor(config, kind);
      const executable = enabled ? await resolveLspExecutable(root, configuredCommand, config.runtimePath, config.lspManagedRoot) : null;
      const typescriptRuntime = enabled && kind === 'typescript' ? await resolveTypeScriptServerOptions(root, config.lspManagedRoot) : null;
      const runtimeProblem = kind === 'typescript' && typescriptRuntime && !typescriptRuntime.ready
        ? `TypeScript runtime is incomplete: missing ${typescriptRuntime.missingRuntimeFiles.join(', ')}`
        : null;
      return {
        kind,
        command: configuredCommand,
        available: Boolean(executable) && !runtimeProblem,
        source: executable?.source ?? null,
        launchMode: executable?.launchMode ?? null,
        executable: executable ? executable.path : null,
        typescriptRuntime,
        unavailableReason: !enabled
          ? 'LSP disabled by runtime policy'
          : !executable
            ? 'Language-server executable unavailable'
            : runtimeProblem,
      };
    }));
    const customEntries = await Promise.all(customServers(config).map(async (custom) => {
      const executable = enabled ? await resolveLspExecutable(root, custom.command, config.runtimePath, config.lspManagedRoot) : null;
      return { kind: 'custom', id: custom.id, command: custom.command, languageId: custom.languageId, extensions: custom.extensions, available: Boolean(executable), source: executable?.source ?? null, launchMode: executable?.launchMode ?? null, executable: executable?.path ?? null, typescriptRuntime: null, unavailableReason: !enabled ? 'LSP disabled by runtime policy' : !executable ? 'Language-server executable unavailable' : null };
    }));
    return {
      enabled,
      servers: [...entries, ...customEntries],
      fallback: 'When a language server is unavailable, Tree-sitter code intelligence remains available through repo_map/code_search/read_symbol/find_references; semantic diagnostics/hover are not fabricated.',
    };
  }

  async status(root: string, config: LspRuntimeConfig) {
    const cacheKey = JSON.stringify({
      root,
      enabled: config.lspEnabled !== false,
      runtimePath: config.runtimePath,
      managedRoot: config.lspManagedRoot || '',
      commands: [
        config.lspTypeScriptCommand, config.lspHtmlCommand, config.lspCssCommand,
        config.lspCustomServers,
        ...Object.entries(DEFAULT_COMMANDS)
          .filter(([kind]) => !['typescript', 'html', 'css'].includes(kind))
          .map(([, command]) => command),
      ],
    });
    const cached = this.statusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await this.statusUncached(root, config);
    this.statusCache.set(cacheKey, { value, expiresAt: Date.now() + 30_000 });
    return value;
  }

  async query(input: {
    root: string;
    config: LspRuntimeConfig;
    relativePath: string;
    operation: LspOperation;
    line?: number;
    character?: number;
  }) {
    if (input.config.lspEnabled === false) throw new Error('LSP is disabled by runtime policy');
    const absolutePath = await resolveExistingPath(input.root, input.relativePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) throw new Error('LSP path must be a file');
    if (fileStat.size > input.config.maxFileBytes) throw new Error(`File exceeds MAX_FILE_BYTES (${input.config.maxFileBytes})`);
    const text = await readFile(absolutePath, 'utf8');
    const { kind, languageId, custom } = documentKind(input.relativePath, input.config);
    if (input.operation === 'source_definition' && kind !== 'typescript') {
      throw new Error('source_definition is only supported for TypeScript/JavaScript files');
    }
    const configuredCommand = custom?.command || commandFor(input.config, kind);
    const executable = await resolveLspExecutable(input.root, configuredCommand, input.config.runtimePath, input.config.lspManagedRoot);
    if (!executable) {
      throw new Error(`${kind === 'custom' ? 'custom' : kind} language server unavailable. Install it from Desktop settings, configure a Workspace/PATH server, or add a custom LSP definition.`);
    }
    const typescriptRuntime = kind === 'typescript' ? await resolveTypeScriptServerOptions(input.root, input.config.lspManagedRoot) : null;
    if (typescriptRuntime && !typescriptRuntime.ready) {
      throw new Error(`typescript language server unavailable because the selected TypeScript runtime is incomplete (missing ${typescriptRuntime.missingRuntimeFiles.join(', ')}). Install or repair the managed LSP package from Desktop settings.`);
    }
    const key = this.key(input.root, custom ? `custom:${custom.id}` : kind);
    let session = this.sessions.get(key);
    if (!session) {
      session = new LspSession(input.root, kind, executable, input.config, custom);
      this.sessions.set(key, session);
    }
    try {
      const uri = await session.syncDocument(input.relativePath, absolutePath, text, languageId);
      const result = await session.query(input.operation, uri, input.line ?? 1, input.character ?? 0);
      return { kind, languageId, server: configuredCommand, serverSource: executable.source, launchMode: executable.launchMode, executable: executable.path, typescriptRuntime, path: input.relativePath, operation: input.operation, result };
    } catch (error) {
      session.stop();
      this.sessions.delete(key);
      throw error;
    }
  }

  closeRoot(root: string): void {
    for (const key of this.statusCache.keys()) {
      if (key.includes(`\"root\":\"${root.replaceAll('\\', '\\\\')}\"`)) this.statusCache.delete(key);
    }
    for (const [key, session] of this.sessions.entries()) {
      if (!key.startsWith(`${root}\0`)) continue;
      session.stop();
      this.sessions.delete(key);
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
