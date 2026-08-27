import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export type ToolTraceMode = 'off' | 'basic' | 'detailed';

type TraceRecord = {
  id: string;
  timestamp: string;
  serviceId: string;
  workspace: string | null;
  tool: string;
  operation?: string;
  status: 'ok' | 'error';
  durationMs: number;
  resultBytes: number;
  phases?: Record<string, number>;
  resultSerializationMs?: number;
  arguments: unknown;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
};

type ToolTraceAggregate = {
  total: number;
  failures: number;
  durationTotalMs: number;
  fastestMs: number | null;
  slowestMs: number | null;
  recentDurationsMs: number[];
  failureCodes: Record<string, number>;
  recentFailures: Array<{
    timestamp: string;
    durationMs: number;
    errorCode: string;
    error?: string;
    retryable?: boolean;
  }>;
};

type ToolTraceStatsFile = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  tools: Record<string, ToolTraceAggregate>;
  variants?: Record<string, ToolTraceAggregate>;
};

const SENSITIVE_KEY = /^(authorization|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|secret|password|private[-_]?key|api[-_]?key|cookie)$/i;
const CONTENT_KEY = /^(content|replacement|data|stdin|patch|raw.?user.?input|initial.?user.?input)$/i;
const SENSITIVE_ARG_FLAG = /^(--?(?:token|password|passwd|secret|api[-_]?key|authorization|cookie)|-p)$/i;
const MAX_STRING = 500;
const MAX_TRACE_FILE_BYTES = 2 * 1024 * 1024;
let traceWrites = 0;
let traceWriteQueue: Promise<void> = Promise.resolve();
type TraceContext = { phases: Record<string, number> };
const traceContext = new AsyncLocalStorage<TraceContext>();

export async function tracePhase<T>(name: string, invoke: () => Promise<T> | T): Promise<T> {
  const current = traceContext.getStore();
  if (!current) return invoke();
  const started = performance.now();
  try {
    return await invoke();
  } finally {
    current.phases[name] = Math.round(((current.phases[name] || 0) + performance.now() - started) * 10) / 10;
  }
}

function summarizeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  const label = value instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value.name) ? value.name : 'ToolError';
  return `[${label} ${text.length} chars sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}]`;
}

function errorCode(value: unknown): string {
  if (value && typeof value === 'object' && 'errorCode' in value && typeof (value as { errorCode?: unknown }).errorCode === 'string') {
    return String((value as { errorCode: string }).errorCode);
  }
  if (value && typeof value === 'object' && 'code' in value && typeof (value as { code?: unknown }).code === 'string') {
    return String((value as { code: string }).code);
  }
  if (value instanceof Error && value.name && value.name !== 'Error') return value.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return 'TOOL_ERROR';
}

function retryableError(value: unknown): boolean {
  return new Set(['EAGAIN', 'EBUSY', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH', 'EAI_AGAIN']).has(errorCode(value));
}

function mode(): ToolTraceMode {
  const value = String(process.env.MCP_TRACE_MODE || 'off').toLowerCase();
  return value === 'basic' || value === 'detailed' ? value : 'off';
}

function traceStatsPath(filePath: string): string {
  return `${filePath}.stats.json`;
}

function traceOperation(tool: string, args: unknown): string | null {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (tool === 'validate_changes') {
    const mode = String(input.mode || '').trim();
    if (mode === 'quick' || mode === 'full') return mode;
    return input.mutationId ? 'quick' : 'default';
  }
  if (tool === 'task_update') return String(input.status || '') === 'completed' ? 'completion_gate' : 'update';
  if (tool === 'workspace_context') return String(input.detail || 'summary') === 'full' ? 'full' : 'summary';
  if (tool === 'git_diff') {
    const mode = String(input.mode || 'semantic');
    return mode === 'summary' || mode === 'patch' ? mode : 'semantic';
  }
  return null;
}

function emptyAggregate(): ToolTraceAggregate {
  return {
    total: 0,
    failures: 0,
    durationTotalMs: 0,
    fastestMs: null,
    slowestMs: null,
    recentDurationsMs: [],
    failureCodes: {},
    recentFailures: [],
  };
}

function updateAggregate(current: ToolTraceAggregate, record: TraceRecord): void {
  current.total += 1;
  if (record.status !== 'ok') {
    current.failures += 1;
    const code = record.errorCode || 'TOOL_ERROR';
    current.failureCodes = current.failureCodes && typeof current.failureCodes === 'object' ? current.failureCodes : {};
    current.failureCodes[code] = (current.failureCodes[code] || 0) + 1;
    current.recentFailures = Array.isArray(current.recentFailures) ? current.recentFailures : [];
    current.recentFailures = [...current.recentFailures, {
      timestamp: record.timestamp,
      durationMs: record.durationMs,
      errorCode: code,
      ...(record.error ? { error: record.error } : {}),
      ...(record.retryable !== undefined ? { retryable: record.retryable } : {}),
    }].slice(-5);
  }
  current.durationTotalMs = Math.round((current.durationTotalMs + record.durationMs) * 10) / 10;
  current.fastestMs = current.fastestMs === null ? record.durationMs : Math.min(current.fastestMs, record.durationMs);
  current.slowestMs = current.slowestMs === null ? record.durationMs : Math.max(current.slowestMs, record.durationMs);
  current.recentDurationsMs = [...current.recentDurationsMs, record.durationMs].slice(-5);
}

function applyTraceToStats(stats: ToolTraceStatsFile, record: TraceRecord): void {
  const current = stats.tools[record.tool] ?? emptyAggregate();
  updateAggregate(current, record);
  stats.tools[record.tool] = current;
  if (record.operation) {
    stats.variants = stats.variants && typeof stats.variants === 'object' ? stats.variants : {};
    const key = `${record.tool}::${record.operation}`;
    const variant = stats.variants[key] ?? emptyAggregate();
    updateAggregate(variant, record);
    stats.variants[key] = variant;
  }
  stats.updatedAt = record.timestamp;
}

async function loadTraceStats(filePath: string): Promise<ToolTraceStatsFile> {
  const statsFile = traceStatsPath(filePath);
  try {
    const parsed = JSON.parse(await readFile(statsFile, 'utf8')) as ToolTraceStatsFile;
    if (parsed?.version === 1 && parsed.tools && typeof parsed.tools === 'object') {
      for (const stat of [...Object.values(parsed.tools), ...Object.values(parsed.variants || {})]) {
        stat.failureCodes = stat.failureCodes && typeof stat.failureCodes === 'object' ? stat.failureCodes : {};
        stat.recentFailures = Array.isArray(stat.recentFailures) ? stat.recentFailures : [];
      }
      parsed.variants = parsed.variants && typeof parsed.variants === 'object' ? parsed.variants : {};
      return parsed;
    }
  } catch {}

  const now = new Date().toISOString();
  const stats: ToolTraceStatsFile = { version: 1, startedAt: now, updatedAt: now, tools: {}, variants: {} };
  try {
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as TraceRecord;
        if (record && typeof record.tool === 'string' && typeof record.durationMs === 'number' && (record.status === 'ok' || record.status === 'error')) {
          applyTraceToStats(stats, record);
        }
      } catch {}
    }
    if (lines.length) stats.startedAt = (() => {
      try { return String((JSON.parse(lines[0]) as TraceRecord).timestamp || now); } catch { return now; }
    })();
  } catch {}
  return stats;
}

async function persistTraceStats(filePath: string, record: TraceRecord): Promise<void> {
  const stats = await loadTraceStats(filePath);
  applyTraceToStats(stats, record);
  const statsFile = traceStatsPath(filePath);
  const temp = `${statsFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(stats)}\n`, 'utf8');
  await rename(temp, statsFile);
}

function enqueueTrace(filePath: string, record: TraceRecord): void {
  traceWriteQueue = traceWriteQueue.then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await persistTraceStats(filePath, record);
    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    await compactIfNeeded(filePath);
  }).catch(() => {});
}

function sanitizeCommandArgs(args: unknown[]): unknown[] {
  const output: unknown[] = [];
  let redactNext = false;
  for (const raw of args.slice(0, 100)) {
    if (typeof raw !== 'string') {
      output.push(sanitizeValue(raw, 1));
      redactNext = false;
      continue;
    }
    if (redactNext) {
      output.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const equals = raw.match(/^(--?(?:token|password|passwd|secret|api[-_]?key|authorization|cookie))=(.*)$/i);
    if (equals) {
      output.push(`${equals[1]}=[REDACTED]`);
      continue;
    }
    output.push(raw.length > MAX_STRING ? `${raw.slice(0, MAX_STRING)}…` : raw);
    if (SENSITIVE_ARG_FLAG.test(raw)) redactNext = true;
  }
  return output;
}

function tracePath(): string {
  return String(process.env.MCP_TRACE_FILE || '').trim();
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[DEPTH_LIMIT]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = '[REDACTED]';
      } else if (CONTENT_KEY.test(key) && typeof item === 'string') {
        result[key] = `[TEXT ${item.length} chars sha256:${createHash('sha256').update(item).digest('hex').slice(0, 12)}]`;
      } else if (key === 'args' && Array.isArray(item)) {
        result[key] = sanitizeCommandArgs(item);
      } else {
        result[key] = sanitizeValue(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

function summarizeArguments(value: unknown, traceMode: ToolTraceMode): unknown {
  if (traceMode === 'detailed') return sanitizeValue(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return typeof value;
  return { keys: Object.keys(value as Record<string, unknown>).filter((key) => !SENSITIVE_KEY.test(key)).sort() };
}

function resultSummary(result: unknown): { bytes: number; isError: boolean; serializationMs: number; error?: string; errorCode?: string; retryable?: boolean } {
  const started = performance.now();
  let serialized = '';
  try { serialized = JSON.stringify(result); } catch { serialized = String(result); }
  const isError = Boolean((result as { isError?: boolean } | null)?.isError);
  let error = '';
  if (isError && result && typeof result === 'object') {
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured && typeof structured === 'object' && 'error' in structured) error = String((structured as { error?: unknown }).error || '');
    if (structured && typeof structured === 'object' && 'errorCode' in structured) {
      return {
        bytes: Buffer.byteLength(serialized), isError, serializationMs: Math.round((performance.now() - started) * 10) / 10,
        ...(error ? { error: summarizeError(error) } : {}),
        errorCode: errorCode(structured),
        retryable: Boolean((structured as { retryable?: unknown }).retryable),
      };
    }
  }
  return {
    bytes: Buffer.byteLength(serialized),
    isError,
    serializationMs: Math.round((performance.now() - started) * 10) / 10,
    ...(error ? { error: summarizeError(error) } : {}),
  };
}

async function compactIfNeeded(filePath: string): Promise<void> {
  traceWrites += 1;
  if (traceWrites !== 1 && traceWrites % 25 !== 0) return;
  try {
    const info = await stat(filePath);
    if (info.size <= MAX_TRACE_FILE_BYTES) return;
    const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-1000);
    const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${lines.join('\n')}\n`, 'utf8');
    await rename(temp, filePath);
  } catch {}
}

export async function traceToolCall<T>(input: {
  serviceId: string;
  workspace: string | null;
  tool: string;
  arguments: unknown;
  invoke: () => Promise<T>;
}): Promise<T> {
  const traceMode = mode();
  const filePath = tracePath();
  if (traceMode === 'off' || !filePath) return input.invoke();
  const started = performance.now();
  const context: TraceContext = { phases: {} };
  let result: T;
  let thrown: unknown = null;
  try {
    result = await traceContext.run(context, () => tracePhase('handler', input.invoke));
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    const durationMs = Math.max(0, Math.round((performance.now() - started) * 10) / 10);
    const summary = thrown
      ? { bytes: 0, isError: true, serializationMs: 0, error: summarizeError(thrown), errorCode: errorCode(thrown), retryable: retryableError(thrown) }
      : resultSummary(result!);
    const record: TraceRecord = {
      id: `tr_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      serviceId: input.serviceId,
      workspace: input.workspace,
      tool: input.tool,
      ...(traceOperation(input.tool, input.arguments) ? { operation: traceOperation(input.tool, input.arguments)! } : {}),
      status: summary.isError ? 'error' : 'ok',
      durationMs,
      resultBytes: summary.bytes,
      phases: Object.keys(context.phases).length ? context.phases : undefined,
      resultSerializationMs: summary.serializationMs || undefined,
      arguments: summarizeArguments(input.arguments, traceMode),
      ...(summary.error ? { error: summary.error } : {}),
      ...(summary.errorCode ? { errorCode: summary.errorCode } : {}),
      ...(summary.retryable !== undefined ? { retryable: summary.retryable } : {}),
    };
    enqueueTrace(filePath, record);
  }
  return result!;
}
