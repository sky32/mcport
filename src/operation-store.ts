import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'outcome_unknown';
export type OperationEventKind = 'mutation' | 'validation';

export type OperationEvent = {
  id: string;
  kind: OperationEventKind;
  status: Extract<OperationStatus, 'succeeded' | 'failed' | 'cancelled'>;
  workspace: string;
  paths: string[];
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type OperationSummary = {
  id: string;
  kind: 'command' | OperationEventKind;
  status: OperationStatus;
  workspace: string;
  paths: string[];
  startedAt: string;
  updatedAt: string;
  command?: string;
  exitCode?: number | null;
  recovery?: 'reobserve_or_reconcile' | null;
  details?: Record<string, unknown>;
};

export type CommandOperation = {
  id: string;
  kind: 'command';
  status: OperationStatus;
  command: string;
  args: string[];
  cwd: string;
  workspaceRoot: string;
  runtimeInstanceId: string;
  pid: number | null;
  startedAt: string;
  updatedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  lastObservedAt: string | null;
  lastObservation: string | null;
  reconciliationReason: string | null;
};

type OperationRow = Record<string, unknown>;

function operationFromRow(row: OperationRow): CommandOperation {
  return {
    id: String(row.id),
    kind: 'command',
    status: String(row.status) as OperationStatus,
    command: String(row.command),
    args: JSON.parse(String(row.args)) as string[],
    cwd: String(row.cwd),
    workspaceRoot: String(row.workspace_root),
    runtimeInstanceId: String(row.runtime_instance_id),
    pid: row.pid === null ? null : Number(row.pid),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    exitedAt: row.exited_at ? String(row.exited_at) : null,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    signal: row.signal ? String(row.signal) as NodeJS.Signals : null,
    stdout: String(row.stdout ?? ''),
    stderr: String(row.stderr ?? ''),
    stdoutBytes: Number(row.stdout_bytes ?? 0),
    stderrBytes: Number(row.stderr_bytes ?? 0),
    stdoutTruncated: Boolean(row.stdout_truncated),
    stderrTruncated: Boolean(row.stderr_truncated),
    lastObservedAt: row.last_observed_at ? String(row.last_observed_at) : null,
    lastObservation: row.last_observation ? String(row.last_observation) : null,
    reconciliationReason: row.reconciliation_reason ? String(row.reconciliation_reason) : null,
  };
}

export class OperationStore {
  private readonly db: DatabaseSync;
  readonly runtimeInstanceId: string;

  constructor(dbPath: string, runtimeInstanceId: string) {
    this.runtimeInstanceId = runtimeInstanceId;
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('command')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','timeout','outcome_unknown')),
        command TEXT NOT NULL,
        args TEXT NOT NULL,
        cwd TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        runtime_instance_id TEXT NOT NULL,
        pid INTEGER,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        exited_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '',
        stdout_bytes INTEGER NOT NULL DEFAULT 0,
        stderr_bytes INTEGER NOT NULL DEFAULT 0,
        stdout_truncated INTEGER NOT NULL DEFAULT 0,
        stderr_truncated INTEGER NOT NULL DEFAULT 0
        ,last_observed_at TEXT
        ,last_observation TEXT
        ,reconciliation_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_operations_updated ON operations(updated_at);
      CREATE TABLE IF NOT EXISTS operation_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('mutation','validation')),
        status TEXT NOT NULL CHECK(status IN ('succeeded','failed','cancelled')),
        workspace TEXT NOT NULL,
        paths TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_operation_events_updated ON operation_events(updated_at);
    `);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE operations SET status = 'outcome_unknown', updated_at = ?, exited_at = COALESCE(exited_at, ?)
      WHERE status IN ('queued', 'running')
    `).run(now, now);
  }

  createCommand(input: {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    workspaceRoot: string;
    runtimeInstanceId: string;
  }): CommandOperation {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO operations(id, kind, status, command, args, cwd, workspace_root, runtime_instance_id, pid, started_at, updated_at)
      VALUES (?, 'command', 'queued', ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(input.id, input.command, JSON.stringify(input.args), input.cwd, input.workspaceRoot, input.runtimeInstanceId, now, now);
    return this.get(input.id)!;
  }

  markRunning(id: string, pid: number | undefined): void {
    this.db.prepare('UPDATE operations SET status = \'running\', pid = ?, updated_at = ? WHERE id = ?')
      .run(pid ?? null, new Date().toISOString(), id);
  }

  complete(id: string, input: {
    status: Exclude<OperationStatus, 'queued' | 'running' | 'outcome_unknown'>;
    exitedAt: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    stdoutBytes: number;
    stderrBytes: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  }): void {
    this.db.prepare(`
      UPDATE operations SET status = ?, updated_at = ?, exited_at = ?, exit_code = ?, signal = ?,
        stdout = ?, stderr = ?, stdout_bytes = ?, stderr_bytes = ?, stdout_truncated = ?, stderr_truncated = ?
      WHERE id = ?
    `).run(
      input.status, input.exitedAt, input.exitedAt, input.exitCode, input.signal,
      input.stdout, input.stderr, input.stdoutBytes, input.stderrBytes,
      input.stdoutTruncated ? 1 : 0, input.stderrTruncated ? 1 : 0, id,
    );
  }

  get(id: string): CommandOperation | null {
    const row = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined;
    return row ? operationFromRow(row) : null;
  }

  observe(id: string, observation: string): CommandOperation {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE operations SET last_observed_at = ?, last_observation = ?, updated_at = ? WHERE id = ?')
      .run(now, observation, now, id);
    const record = this.get(id);
    if (!record) throw new Error('Unknown operation id');
    return record;
  }

  reconcile(id: string, status: Extract<OperationStatus, 'succeeded' | 'failed' | 'cancelled'>, reason: string): CommandOperation {
    const current = this.get(id);
    if (!current) throw new Error('Unknown operation id');
    if (current.status !== 'outcome_unknown') throw new Error('Only outcome_unknown operations can be reconciled');
    if (!current.lastObservedAt) throw new Error('Re-observe the outcome_unknown operation before reconciliation');
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE operations SET status = ?, updated_at = ?, exited_at = COALESCE(exited_at, ?),
        last_observed_at = ?, last_observation = ?, reconciliation_reason = ?
      WHERE id = ? AND status = 'outcome_unknown'
    `).run(status, now, now, now, 'manually reconciled', reason, id);
    const record = this.get(id);
    if (!record) throw new Error('Unknown operation id');
    return record;
  }

  recordEvent(input: {
    id: string;
    kind: OperationEventKind;
    status: OperationEvent['status'];
    workspace: string;
    paths?: string[];
    details?: Record<string, unknown>;
  }): OperationEvent {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO operation_events(id, kind, status, workspace, paths, details, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, paths = excluded.paths, details = excluded.details, updated_at = excluded.updated_at
    `).run(
      input.id, input.kind, input.status, input.workspace, JSON.stringify(input.paths ?? []), JSON.stringify(input.details ?? {}), now, now,
    );
    return this.getEvent(input.id)!;
  }

  getEvent(id: string): OperationEvent | null {
    const row = this.db.prepare('SELECT * FROM operation_events WHERE id = ?').get(id) as OperationRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      kind: String(row.kind) as OperationEventKind,
      status: String(row.status) as OperationEvent['status'],
      workspace: String(row.workspace),
      paths: JSON.parse(String(row.paths)) as string[],
      details: JSON.parse(String(row.details)) as Record<string, unknown>,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  getAny(id: string): { kind: 'command'; operation: CommandOperation } | { kind: OperationEventKind; operation: OperationEvent } | null {
    const command = this.get(id);
    if (command) return { kind: 'command', operation: command };
    const event = this.getEvent(id);
    return event ? { kind: event.kind, operation: event } : null;
  }

  list(workspace: string, workspaceRoot: string, limit = 20, view: 'recovery' | 'all' = 'recovery'): OperationSummary[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const commands = (this.db.prepare(`
      SELECT id, status, command, workspace_root, started_at, updated_at, exit_code
      FROM operations WHERE workspace_root = ? ORDER BY updated_at DESC LIMIT ?
    `).all(workspaceRoot, boundedLimit) as OperationRow[]).map((row): OperationSummary => ({
      id: String(row.id),
      kind: 'command',
      status: String(row.status) as OperationStatus,
      workspace,
      paths: [],
      startedAt: String(row.started_at),
      updatedAt: String(row.updated_at),
      command: String(row.command),
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      recovery: row.status === 'outcome_unknown' ? 'reobserve_or_reconcile' : null,
    }));
    const events = (this.db.prepare(`
      SELECT id, kind, status, paths, details, created_at, updated_at
      FROM operation_events WHERE workspace = ? ORDER BY updated_at DESC LIMIT ?
    `).all(workspace, boundedLimit) as OperationRow[]).map((row): OperationSummary => ({
      id: String(row.id),
      kind: String(row.kind) as OperationEventKind,
      status: String(row.status) as OperationStatus,
      workspace,
      paths: JSON.parse(String(row.paths)) as string[],
      startedAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      details: JSON.parse(String(row.details)) as Record<string, unknown>,
    }));
    const visibleCommands = view === 'all'
      ? commands
      : commands.filter((item) => item.status !== 'succeeded');
    return [...visibleCommands, ...events]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))
      .slice(0, boundedLimit);
  }

  close(): void {
    this.db.close();
  }
}

const stores = new Map<string, OperationStore>();

export async function getOperationStore(stateDbPath: string, runtimeInstanceId: string): Promise<OperationStore> {
  const dbPath = `${stateDbPath}.operations.sqlite`;
  let store = stores.get(dbPath);
  if (!store) {
    await mkdir(path.dirname(dbPath), { recursive: true });
    store = new OperationStore(dbPath, runtimeInstanceId);
    stores.set(dbPath, store);
  }
  return store;
}
