import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execa, type ResultPromise } from 'execa';
import { assertCommandAllowed, resolveExistingPath } from './security.js';
import type { CommandOperation, OperationStore } from './operation-store.js';

export type RuntimeExecutionConfig = {
  runtimePath: string;
  allowedCommands: Set<string>;
  allowCommandExecution: boolean;
  allowExternalNetwork: boolean;
  networkIsolationRequired: boolean;
  maxCommandOutputBytes: number;
  defaultCommandTimeoutMs: number;
  maxCommandTimeoutMs: number;
};

export type CommandOutputMode = 'summary' | 'errors' | 'tail' | 'stream' | 'full';
export type NetworkIsolationStrategy = 'none' | 'sandbox-exec' | 'bwrap' | 'unshare' | 'environment';

export const MACOS_LOCAL_ONLY_NETWORK_PROFILE = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(allow network-bind (local ip "localhost:*"))',
  '(allow network-inbound (local ip "localhost:*"))',
  '(allow network-outbound (remote ip "localhost:*"))',
].join('');

type ExecutionPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  strategy: NetworkIsolationStrategy;
};

function restrictedEnvironment(config: RuntimeExecutionConfig): NodeJS.ProcessEnv {
  if (config.allowExternalNetwork) return { ...process.env, PATH: config.runtimePath, RW_MCP_NETWORK_ACCESS: 'allow' };
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

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function executableOnRuntimePath(command: string, runtimePath: string): Promise<string | null> {
  for (const entry of runtimePath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(entry, process.platform === 'win32' ? `${command}.exe` : command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function executionPlan(config: RuntimeExecutionConfig, command: string, args: string[], enforceNetworkPolicy: boolean): Promise<ExecutionPlan> {
  const env = restrictedEnvironment(config);
  if (!enforceNetworkPolicy || config.allowExternalNetwork) return { command, args, env, strategy: 'none' };
  if (!config.networkIsolationRequired) return { command, args, env, strategy: 'environment' };

  if (process.platform === 'darwin' && await isExecutable('/usr/bin/sandbox-exec')) {
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', MACOS_LOCAL_ONLY_NETWORK_PROFILE, command, ...args],
      env,
      strategy: 'sandbox-exec',
    };
  }

  if (process.platform === 'linux') {
    const bwrap = await executableOnRuntimePath('bwrap', config.runtimePath);
    if (bwrap) {
      return {
        command: bwrap,
        args: ['--die-with-parent', '--unshare-net', '--bind', '/', '/', '--', command, ...args],
        env,
        strategy: 'bwrap',
      };
    }
    const unshare = await executableOnRuntimePath('unshare', config.runtimePath);
    if (unshare) {
      return {
        command: unshare,
        args: ['--user', '--map-root-user', '--net', '--', command, ...args],
        env,
        strategy: 'unshare',
      };
    }
  }

  if (config.networkIsolationRequired) {
    throw new Error(`External network is denied but no enforceable network sandbox is available on ${process.platform}. Install bwrap/unshare on Linux or explicitly enable external network access.`);
  }
  return { command, args, env, strategy: 'environment' };
}

export async function networkIsolationStatus(config: RuntimeExecutionConfig) {
  if (config.allowExternalNetwork) return { externalNetworkAllowed: true, loopbackNetworkAllowed: true, required: config.networkIsolationRequired, supported: true, strategy: 'none' as const };
  if (!config.networkIsolationRequired) return { externalNetworkAllowed: false, loopbackNetworkAllowed: true, required: false, supported: true, strategy: 'environment' as const };
  if (process.platform === 'darwin' && await isExecutable('/usr/bin/sandbox-exec')) return { externalNetworkAllowed: false, loopbackNetworkAllowed: true, required: config.networkIsolationRequired, supported: true, strategy: 'sandbox-exec' as const };
  if (process.platform === 'linux') {
    if (await executableOnRuntimePath('bwrap', config.runtimePath)) return { externalNetworkAllowed: false, loopbackNetworkAllowed: false, required: config.networkIsolationRequired, supported: true, strategy: 'bwrap' as const };
    if (await executableOnRuntimePath('unshare', config.runtimePath)) return { externalNetworkAllowed: false, loopbackNetworkAllowed: false, required: config.networkIsolationRequired, supported: true, strategy: 'unshare' as const };
  }
  return { externalNetworkAllowed: false, loopbackNetworkAllowed: true, required: config.networkIsolationRequired, supported: !config.networkIsolationRequired, strategy: 'environment' as const };
}

function safeTailUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function compactLineSummary(value: string, maxLines = 40): string {
  const lines = value.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= maxLines) return lines.join('\n');
  return [`… ${lines.length - maxLines} earlier lines omitted …`, ...lines.slice(-maxLines)].join('\n');
}

type BoundedOutput = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

function appendBounded(current: BoundedOutput, chunk: Buffer, maxBytes: number): BoundedOutput {
  const totalBytes = current.totalBytes + chunk.byteLength;
  if (current.truncated) return { ...current, totalBytes };
  const next = Buffer.concat([Buffer.from(current.text), chunk]);
  if (next.byteLength <= maxBytes) return { text: next.toString('utf8'), truncated: false, totalBytes };
  return { text: next.subarray(0, maxBytes).toString('utf8'), truncated: true, totalBytes };
}

export type CommandResult = {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

async function executeSubprocess(
  config: RuntimeExecutionConfig,
  resolvedCwd: string,
  command: string,
  args: string[],
  cwdLabel: string,
  timeout: number,
  enforceNetworkPolicy: boolean,
): Promise<CommandResult> {
  const start = performance.now();
  let stdout: BoundedOutput = { text: '', truncated: false, totalBytes: 0 };
  let stderr: BoundedOutput = { text: '', truncated: false, totalBytes: 0 };
  const plan = await executionPlan(config, command, args, enforceNetworkPolicy);
  const child = execa(plan.command, plan.args, {
    cwd: resolvedCwd,
    env: plan.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
    timeout,
    forceKillAfterDelay: 2_000,
    killSignal: 'SIGTERM',
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk, config.maxCommandOutputBytes);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk, config.maxCommandOutputBytes);
  });
  const result = await child;
  return {
    command,
    args,
    cwd: cwdLabel,
    exitCode: result.exitCode ?? null,
    signal: (result.signal ?? null) as NodeJS.Signals | null,
    timedOut: result.timedOut,
    durationMs: Math.round(performance.now() - start),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

export async function runCommand(
  config: RuntimeExecutionConfig,
  workspaceRoot: string,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
): Promise<CommandResult> {
  assertCommandAllowed(command, config.allowedCommands);
  const resolvedCwd = await resolveExistingPath(workspaceRoot, cwd || '.');
  const timeout = Math.min(timeoutMs ?? config.defaultCommandTimeoutMs, config.maxCommandTimeoutMs);
  return executeSubprocess(config, resolvedCwd, command, args, cwd, timeout, true);
}

/** Run a fixed internal executable without opening arbitrary command execution to the MCP client. */
export async function runTrustedCommand(
  config: RuntimeExecutionConfig,
  workspaceRoot: string,
  command: string,
  args: string[],
  cwd = '.',
  timeoutMs = 30_000,
): Promise<CommandResult> {
  const resolvedCwd = await resolveExistingPath(workspaceRoot, cwd || '.');
  const timeout = Math.min(timeoutMs, config.maxCommandTimeoutMs);
  return executeSubprocess(config, resolvedCwd, command, args, cwd, timeout, false);
}

type ManagedProcess = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  child: ResultPromise;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  failed?: boolean;
  stopRequested?: boolean;
  stdout: BoundedOutput;
  stderr: BoundedOutput;
};

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly operationStore?: OperationStore) {}

  async start(
    config: RuntimeExecutionConfig,
    workspaceRoot: string,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
  ) {
    assertCommandAllowed(command, config.allowedCommands);
    const resolvedCwd = await resolveExistingPath(workspaceRoot, cwd || '.');
    this.prune();
    const id = randomUUID();
    this.operationStore?.createCommand({
      id,
      command,
      args,
      cwd,
      workspaceRoot,
      runtimeInstanceId: this.operationStore?.runtimeInstanceId || process.env.RUNTIME_INSTANCE_ID?.trim() || 'runtime-unknown',
    });
    let plan: ExecutionPlan;
    try {
      plan = await executionPlan(config, command, args, true);
    } catch (error) {
      const now = new Date().toISOString();
      this.operationStore?.complete(id, {
        status: 'failed',
        exitedAt: now,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(error instanceof Error ? error.message : String(error), 'utf8'),
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      throw error;
    }
    const child = execa(plan.command, plan.args, {
      cwd: resolvedCwd,
      env: plan.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
      forceKillAfterDelay: 2_000,
      ...(timeoutMs ? { timeout: Math.min(timeoutMs, config.maxCommandTimeoutMs) } : {}),
    });
    const processState: ManagedProcess = {
      id,
      command,
      args,
      cwd,
      child,
      startedAt: new Date().toISOString(),
      stdout: { text: '', truncated: false, totalBytes: 0 },
      stderr: { text: '', truncated: false, totalBytes: 0 },
    };
    this.processes.set(id, processState);
    this.operationStore?.markRunning(id, child.pid);

    child.stdout?.on('data', (chunk: Buffer) => {
      processState.stdout = appendBounded(processState.stdout, chunk, config.maxCommandOutputBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      processState.stderr = appendBounded(processState.stderr, chunk, config.maxCommandOutputBytes);
    });
    void child.then((result) => {
      processState.exitCode = result.exitCode ?? null;
      processState.signal = (result.signal ?? null) as NodeJS.Signals | null;
      processState.timedOut = Boolean(result.timedOut);
      processState.exitedAt = new Date().toISOString();
      this.operationStore?.complete(id, {
        status: processState.stopRequested
          ? 'cancelled'
          : processState.timedOut
            ? 'timeout'
            : processState.exitCode === 0
              ? 'succeeded'
              : 'failed',
        exitedAt: processState.exitedAt,
        exitCode: processState.exitCode,
        signal: processState.signal,
        stdout: processState.stdout.text,
        stderr: processState.stderr.text,
        stdoutBytes: processState.stdout.totalBytes,
        stderrBytes: processState.stderr.totalBytes,
        stdoutTruncated: processState.stdout.truncated,
        stderrTruncated: processState.stderr.truncated,
      });
    }).catch((error: Error) => {
      processState.exitCode = null;
      processState.signal = null;
      processState.failed = true;
      processState.exitedAt = new Date().toISOString();
      processState.stderr = appendBounded(processState.stderr, Buffer.from(`\nProcess error: ${error.message}\n`), config.maxCommandOutputBytes);
      this.operationStore?.complete(id, {
        status: processState.stopRequested ? 'cancelled' : 'failed',
        exitedAt: processState.exitedAt,
        exitCode: null,
        signal: null,
        stdout: processState.stdout.text,
        stderr: processState.stderr.text,
        stdoutBytes: processState.stdout.totalBytes,
        stderrBytes: processState.stderr.totalBytes,
        stdoutTruncated: processState.stdout.truncated,
        stderrTruncated: processState.stderr.truncated,
      });
    });

    return this.describe(processState);
  }

  async execute(
    config: RuntimeExecutionConfig,
    workspaceRoot: string,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
    waitMs = 10_000,
  ) {
    const started = await this.start(config, workspaceRoot, command, args, cwd, timeoutMs ?? config.defaultCommandTimeoutMs);
    const item = this.processes.get(started.id)!;
    await Promise.race([
      item.child.then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, waitMs))),
    ]);
    return this.status(started.id);
  }

  status(id: string) {
    const item = this.processes.get(id);
    if (!item) {
      const persisted = this.operationStore?.get(id);
      if (persisted) return this.describePersisted(persisted);
      throw new Error('Unknown process id');
    }
    return this.describe(item);
  }

  sessionStatus(id: string) {
    const item = this.processes.get(id);
    if (!item) {
      const persisted = this.operationStore?.get(id);
      if (!persisted) throw new Error('Unknown process id');
      return {
        id: persisted.id,
        operationId: persisted.id,
        sessionId: persisted.id,
        status: persisted.status,
        processState: persisted.status === 'queued' || persisted.status === 'running' ? 'running' : 'exited',
        pid: persisted.pid,
        command: persisted.command,
        args: persisted.args,
        cwd: persisted.cwd,
        startedAt: persisted.startedAt,
        elapsedMs: Math.max(0, new Date(persisted.exitedAt || persisted.updatedAt).getTime() - new Date(persisted.startedAt).getTime()),
        exitedAt: persisted.exitedAt,
        exitCode: persisted.exitCode,
        signal: persisted.signal,
        stdoutBytes: persisted.stdoutBytes,
        stderrBytes: persisted.stderrBytes,
        stdoutTruncated: persisted.stdoutTruncated,
        stderrTruncated: persisted.stderrTruncated,
        recoverable: false,
        recovery: persisted.status === 'outcome_unknown' ? 'reobserve_or_reconcile' : null,
      };
    }
    const running = item.exitCode === undefined && item.signal === undefined && !item.exitedAt;
    const status = running
      ? 'running'
      : item.timedOut
        ? 'timeout'
        : item.stopRequested
          ? 'cancelled'
          : item.failed || item.exitCode !== 0
            ? 'failed'
            : 'succeeded';
    return {
      id: item.id,
      operationId: item.id,
      sessionId: item.id,
      status,
      processState: running ? 'running' : 'exited',
      pid: item.child.pid,
      command: item.command,
      args: item.args,
      cwd: item.cwd,
      startedAt: item.startedAt,
      elapsedMs: Math.max(0, new Date(item.exitedAt || new Date().toISOString()).getTime() - new Date(item.startedAt).getTime()),
      exitedAt: item.exitedAt ?? null,
      exitCode: item.exitCode ?? null,
      signal: item.signal ?? null,
      stdoutBytes: item.stdout.totalBytes,
      stderrBytes: item.stderr.totalBytes,
      stdoutTruncated: item.stdout.truncated,
      stderrTruncated: item.stderr.truncated,
      recoverable: running,
      recovery: null,
    };
  }

  reobserve(id: string) {
    const item = this.processes.get(id);
    if (item) {
      const status = this.sessionStatus(id);
      return {
        ...status,
        observation: { kind: 'in_memory_process', checkedAt: new Date().toISOString(), processState: status.status },
      };
    }
    const persisted = this.operationStore?.get(id);
    if (!persisted) throw new Error('Unknown process id');
    const operationStore = this.operationStore;
    if (!operationStore) throw new Error('Operation re-observation is unavailable');
    let pidExists: boolean | null = null;
    if (persisted.pid !== null) {
      try {
        process.kill(persisted.pid, 0);
        pidExists = true;
      } catch (error) {
        pidExists = (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    const observation = {
      kind: 'persisted_process',
      checkedAt: new Date().toISOString(),
      pid: persisted.pid,
      pidExists,
      conclusion: 'operation_outcome_remains_unknown',
    } as const;
    operationStore.observe(id, JSON.stringify(observation));
    return { ...this.sessionStatus(id), observation };
  }

  reconcile(id: string, status: 'succeeded' | 'failed' | 'cancelled', reason: string) {
    if (this.processes.has(id)) throw new Error('Running in-memory process must be observed or stopped before reconciliation');
    const record = this.operationStore?.reconcile(id, status, reason);
    if (!record) throw new Error('Operation reconciliation is unavailable');
    return {
      ...this.describePersisted(record),
      reconciliation: { status, reason, at: record.lastObservedAt },
    };
  }

  present(id: string, outputMode: CommandOutputMode, maxOutputBytes: number) {
    const item = this.processes.get(id);
    if (!item) {
      const persisted = this.operationStore?.get(id);
      if (!persisted) throw new Error('Unknown process id');
      return this.presentPersisted(persisted, outputMode, maxOutputBytes);
    }
    const status = this.sessionStatus(id);
    const budget = Math.max(256, maxOutputBytes);
    const running = status.status === 'running';
    let stdout = '';
    let stderr = '';

    if (outputMode === 'summary') {
      const stdoutSummary = compactLineSummary(item.stdout.text);
      const stderrSummary = compactLineSummary(item.stderr.text);
      const stderrBudget = stderrSummary ? Math.max(128, Math.floor(budget * 0.4)) : 0;
      const stdoutBudget = Math.max(0, budget - stderrBudget);
      stdout = safeTailUtf8(stdoutSummary, stdoutBudget);
      stderr = safeTailUtf8(stderrSummary, stderrBudget);
    } else if (outputMode === 'errors') {
      const failed = status.status === 'failed' || status.status === 'timeout' || (status.exitCode !== null && status.exitCode !== 0);
      if (failed || item.stderr.text) {
        const stderrBudget = Math.max(128, Math.floor(budget * 0.8));
        stderr = safeTailUtf8(item.stderr.text, stderrBudget);
        stdout = failed ? safeTailUtf8(item.stdout.text, Math.max(0, budget - Buffer.byteLength(stderr, 'utf8'))) : '';
      }
    } else if (outputMode === 'tail') {
      const half = Math.max(128, Math.floor(budget / 2));
      stdout = safeTailUtf8(item.stdout.text, half);
      stderr = safeTailUtf8(item.stderr.text, Math.max(0, budget - Buffer.byteLength(stdout, 'utf8')));
    } else if (outputMode === 'full') {
      stdout = Buffer.byteLength(item.stdout.text, 'utf8') <= budget ? item.stdout.text : safeTailUtf8(item.stdout.text, budget);
      const remaining = Math.max(0, budget - Buffer.byteLength(stdout, 'utf8'));
      stderr = remaining ? (Buffer.byteLength(item.stderr.text, 'utf8') <= remaining ? item.stderr.text : safeTailUtf8(item.stderr.text, remaining)) : '';
    }

    const returnedBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
    const outputOmitted = outputMode === 'stream'
      || returnedBytes < item.stdout.totalBytes + item.stderr.totalBytes
      || item.stdout.truncated
      || item.stderr.truncated;
    return {
      id: item.id,
      operationId: item.id,
      sessionId: item.id,
      command: item.command,
      args: item.args,
      cwd: item.cwd,
      pid: item.child.pid,
      running,
      status: status.status,
      startedAt: item.startedAt,
      exitedAt: item.exitedAt ?? null,
      exitCode: item.exitCode ?? null,
      signal: item.signal ?? null,
      elapsedMs: status.elapsedMs,
      outputMode,
      stdout,
      stderr,
      stdoutBytes: item.stdout.totalBytes,
      stderrBytes: item.stderr.totalBytes,
      outputOmitted,
      next: outputOmitted ? { tool: 'session_control', action: 'read', sessionId: item.id, cursor: 0 } : null,
      meta: {
        truncated: outputOmitted,
        budgetMode: 'utf8-byte-hard-limit',
        maxTokens: budget,
        budgetUsed: returnedBytes,
        returnedResults: returnedBytes ? 1 : 0,
        totalResults: null,
        nextCursor: outputOmitted ? 0 : null,
        blockedByBudget: false,
        minimumRequiredBytes: null,
      },
    };
  }

  writeStdin(id: string, data: string, close = false) {
    const item = this.processes.get(id);
    if (!item) throw new Error('Unknown process id');
    if (item.exitCode !== undefined || item.signal !== undefined) throw new Error('Process is no longer running');
    if (!item.child.stdin) throw new Error('Process stdin is not available');
    if (data) item.child.stdin.write(data);
    if (close) item.child.stdin.end();
    return this.describe(item);
  }

  readOutput(id: string, stream: 'stdout' | 'stderr', offset: number, maxBytes: number) {
    const item = this.processes.get(id);
    if (!item) {
      const persisted = this.operationStore?.get(id);
      if (!persisted) throw new Error('Unknown process id');
      const output = stream === 'stdout'
        ? { text: persisted.stdout, totalBytes: persisted.stdoutBytes, truncated: persisted.stdoutTruncated }
        : { text: persisted.stderr, totalBytes: persisted.stderrBytes, truncated: persisted.stderrTruncated };
      return this.readPersistedOutput(id, stream, offset, maxBytes, output);
    }
    const output = stream === 'stdout' ? item.stdout : item.stderr;
    const buffer = Buffer.from(output.text, 'utf8');
    if (offset < 0 || offset > buffer.length) throw new Error(`offset must be between 0 and retained ${stream} bytes (${buffer.length})`);
    let start = offset;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    let end = Math.min(buffer.length, start + maxBytes);
    if (end < buffer.length) while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return {
      id,
      stream,
      offset: start,
      text: buffer.subarray(start, end).toString('utf8'),
      nextOffset: end < buffer.length ? end : null,
      retainedBytes: buffer.length,
      totalBytes: output.totalBytes,
      truncated: output.truncated,
      running: item.exitCode === undefined && item.signal === undefined,
    };
  }

  async stop(id: string, signal: NodeJS.Signals = 'SIGTERM') {
    const item = this.processes.get(id);
    if (!item) throw new Error('Unknown process id');
    if (item.exitCode === undefined && item.signal === undefined) {
      item.stopRequested = true;
      item.child.kill(signal);
      await Promise.race([
        item.child.then(() => undefined).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, signal === 'SIGKILL' ? 1_000 : 3_000)),
      ]);
    }
    return this.describe(item);
  }

  async stopAll(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const running = [...this.processes.values()]
      .filter((item) => item.exitCode === undefined && item.signal === undefined)
      .map((item) => item.id);
    await Promise.all(
      running.map((id) => this.stop(id, signal).then(() => undefined).catch(() => undefined)),
    );
  }

  private prune(): void {
    const completed = [...this.processes.values()]
      .filter((item) => item.exitCode !== undefined || item.signal !== undefined)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (this.processes.size >= 100 && completed.length) {
      const oldest = completed.shift();
      if (oldest) this.processes.delete(oldest.id);
    }
    if (this.processes.size >= 100) {
      throw new Error('Too many active command sessions; stop an existing session before starting another');
    }
  }

  private describe(item: ManagedProcess) {
    return {
      id: item.id,
      operationId: item.id,
      sessionId: item.id,
      command: item.command,
      args: item.args,
      cwd: item.cwd,
      pid: item.child.pid,
      running: item.exitCode === undefined && item.signal === undefined,
      startedAt: item.startedAt,
      exitedAt: item.exitedAt,
      exitCode: item.exitCode,
      signal: item.signal,
      stdout: item.stdout.text,
      stderr: item.stderr.text,
      stdoutTruncated: item.stdout.truncated,
      stderrTruncated: item.stderr.truncated,
      stdoutBytes: item.stdout.totalBytes,
      stderrBytes: item.stderr.totalBytes,
    };
  }

  private describePersisted(item: CommandOperation) {
    return {
      id: item.id,
      operationId: item.id,
      sessionId: item.id,
      command: item.command,
      args: item.args,
      cwd: item.cwd,
      pid: item.pid,
      running: item.status === 'queued' || item.status === 'running',
      status: item.status,
      startedAt: item.startedAt,
      exitedAt: item.exitedAt,
      exitCode: item.exitCode,
      signal: item.signal,
      stdout: item.stdout,
      stderr: item.stderr,
      stdoutTruncated: item.stdoutTruncated,
      stderrTruncated: item.stderrTruncated,
      stdoutBytes: item.stdoutBytes,
      stderrBytes: item.stderrBytes,
      recoverable: false,
      recovery: item.status === 'outcome_unknown' ? 'reobserve_or_reconcile' : null,
    };
  }

  private presentPersisted(item: CommandOperation, outputMode: CommandOutputMode, maxOutputBytes: number) {
    const budget = Math.max(256, maxOutputBytes);
    const stdout = outputMode === 'stream' ? '' : safeTailUtf8(item.stdout, budget);
    const stderrBudget = Math.max(0, budget - Buffer.byteLength(stdout, 'utf8'));
    const stderr = outputMode === 'stream' ? '' : safeTailUtf8(item.stderr, stderrBudget);
    const returnedBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
    const outputOmitted = outputMode === 'stream' || returnedBytes < item.stdoutBytes + item.stderrBytes || item.stdoutTruncated || item.stderrTruncated;
    return {
      ...this.describePersisted(item),
      outputMode,
      stdout,
      stderr,
      outputOmitted,
      next: outputOmitted ? { tool: 'session_control', action: 'read', sessionId: item.id, cursor: 0 } : null,
      meta: {
        truncated: outputOmitted,
        budgetMode: 'utf8-byte-hard-limit',
        maxTokens: budget,
        budgetUsed: returnedBytes,
        returnedResults: returnedBytes ? 1 : 0,
        totalResults: null,
        nextCursor: outputOmitted ? 0 : null,
        blockedByBudget: false,
        minimumRequiredBytes: null,
      },
    };
  }

  private readPersistedOutput(id: string, stream: 'stdout' | 'stderr', offset: number, maxBytes: number, output: { text: string; totalBytes: number; truncated: boolean }) {
    const buffer = Buffer.from(output.text, 'utf8');
    if (offset < 0 || offset > buffer.length) throw new Error(`offset must be between 0 and retained ${stream} bytes (${buffer.length})`);
    let start = offset;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    let end = Math.min(buffer.length, start + maxBytes);
    if (end < buffer.length) while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
    return {
      id,
      stream,
      offset: start,
      text: buffer.subarray(start, end).toString('utf8'),
      nextOffset: end < buffer.length ? end : null,
      retainedBytes: buffer.length,
      totalBytes: output.totalBytes,
      truncated: output.truncated,
      running: false,
    };
  }
}
