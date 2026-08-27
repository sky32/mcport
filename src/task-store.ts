import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type TaskStatus = 'planning' | 'running' | 'validating' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['planning', 'running', 'validating', 'blocked'];
export const TASK_STATUSES: readonly TaskStatus[] = [...ACTIVE_TASK_STATUSES, 'completed', 'failed', 'cancelled'];

export type AcceptanceCriterion = {
  id: string;
  description: string;
  kind: 'command' | 'manual';
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

export type TaskStep = {
  id: string;
  description: string;
  status: 'pending' | 'completed' | 'failed';
  note?: string;
};

export type TaskObservation = { at: string; note: string };
export type TaskFailedAttempt = { at: string; action: string; error: string };

export type TaskCheckpointRef = {
  checkpointId: string;
  sessionKey: string;
  turnId: string;
  at: string;
};

export type TaskBaselineContext = {
  branch: string | null;
  head: string | null;
  diffHash: string | null;
  changedFileHashes: Record<string, string | null>;
  changedFileHashesTruncated: boolean;
};

export type TaskRecord = {
  id: string;
  workspace: string;
  goal: string;
  status: TaskStatus;
  acceptanceCriteria: AcceptanceCriterion[];
  steps: TaskStep[];
  expectedPaths: string[];
  acknowledgedExternalPaths: string[];
  baselineChangedFiles: string[];
  baselineContext: TaskBaselineContext;
  changedFiles: string[];
  observations: TaskObservation[];
  failedAttempts: TaskFailedAttempt[];
  satisfiedCriteria: string[];
  checkpoint: TaskCheckpointRef | null;
  createdAt: string;
  updatedAt: string;
};

export type ValidationStageResult = {
  name: string;
  status: 'pass' | 'fail' | 'skipped';
  exitCode?: number | null;
  durationMs?: number;
  summary?: string;
  reason?: string;
};

export type ValidationRun = {
  id: string;
  operationId: string;
  taskId: string;
  kind: 'validate_changes' | 'completion_gate';
  overall: 'pass' | 'fail';
  diffHash: string;
  changedFiles: string[];
  stages: ValidationStageResult[];
  createdAt: string;
};

function taskFromRow(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    workspace: String(row.workspace),
    goal: String(row.goal),
    status: String(row.status) as TaskStatus,
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria)) as AcceptanceCriterion[],
    steps: JSON.parse(String(row.steps)) as TaskStep[],
    expectedPaths: JSON.parse(String(row.expected_paths)) as string[],
    acknowledgedExternalPaths: row.acknowledged_external_paths ? JSON.parse(String(row.acknowledged_external_paths)) as string[] : [],
    baselineChangedFiles: row.baseline_changed_files ? JSON.parse(String(row.baseline_changed_files)) as string[] : [],
    baselineContext: row.baseline_context
      ? {
        branch: null,
        head: null,
        diffHash: null,
        changedFileHashes: {},
        changedFileHashesTruncated: false,
        ...(JSON.parse(String(row.baseline_context)) as Partial<TaskBaselineContext>),
      }
      : { branch: null, head: null, diffHash: null, changedFileHashes: {}, changedFileHashesTruncated: false },
    changedFiles: JSON.parse(String(row.changed_files)) as string[],
    observations: JSON.parse(String(row.observations)) as TaskObservation[],
    failedAttempts: JSON.parse(String(row.failed_attempts)) as TaskFailedAttempt[],
    satisfiedCriteria: JSON.parse(String(row.satisfied_criteria)) as string[],
    checkpoint: row.checkpoint_id
      ? {
        checkpointId: String(row.checkpoint_id),
        sessionKey: String(row.checkpoint_session_key),
        turnId: String(row.checkpoint_turn_id),
        at: String(row.checkpoint_at),
      }
      : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function runFromRow(row: Record<string, unknown>): ValidationRun {
  return {
    id: String(row.id),
    operationId: String(row.operation_id || row.id),
    taskId: String(row.task_id),
    kind: String(row.kind) as ValidationRun['kind'],
    overall: String(row.overall) as ValidationRun['overall'],
    diffHash: String(row.diff_hash),
    changedFiles: JSON.parse(String(row.changed_files)) as string[],
    stages: JSON.parse(String(row.stages)) as ValidationStageResult[],
    createdAt: String(row.created_at),
  };
}

export class TaskStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('planning','running','validating','blocked','completed','failed','cancelled')),
        acceptance_criteria TEXT NOT NULL,
        steps TEXT NOT NULL,
        expected_paths TEXT NOT NULL,
        acknowledged_external_paths TEXT NOT NULL DEFAULT '[]',
        baseline_changed_files TEXT NOT NULL DEFAULT '[]',
        baseline_context TEXT NOT NULL DEFAULT '{}',
        changed_files TEXT NOT NULL,
        observations TEXT NOT NULL,
        failed_attempts TEXT NOT NULL,
        satisfied_criteria TEXT NOT NULL,
        checkpoint_session_key TEXT,
        checkpoint_turn_id TEXT,
        checkpoint_id TEXT,
        checkpoint_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_active_workspace
        ON tasks(workspace)
        WHERE status IN ('planning','running','validating','blocked');
      CREATE TABLE IF NOT EXISTS task_validation_runs (
        id TEXT PRIMARY KEY,
        operation_id TEXT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('validate_changes','completion_gate')),
        overall TEXT NOT NULL CHECK(overall IN ('pass','fail')),
        diff_hash TEXT NOT NULL,
        changed_files TEXT NOT NULL,
        stages TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_validation_runs_task ON task_validation_runs(task_id, created_at);
    `);

    // CREATE TABLE IF NOT EXISTS does not upgrade tables created by an older Runtime.
    // Keep these additive schema upgrades idempotent so an existing state.db can be
    // opened safely after new task-runtime columns are introduced.
    const taskColumns = new Set(
      (this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name?: unknown }>).map((row) => String(row.name || '')),
    );
    if (!taskColumns.has('acknowledged_external_paths')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN acknowledged_external_paths TEXT NOT NULL DEFAULT '[]'");
    }
    if (!taskColumns.has('baseline_changed_files')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN baseline_changed_files TEXT NOT NULL DEFAULT '[]'");
    }
    if (!taskColumns.has('baseline_context')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN baseline_context TEXT NOT NULL DEFAULT '{}'");
    }

    const validationColumns = new Set(
      (this.db.prepare('PRAGMA table_info(task_validation_runs)').all() as Array<{ name?: unknown }>).map((row) => String(row.name || '')),
    );
    if (!validationColumns.has('operation_id')) {
      this.db.exec('ALTER TABLE task_validation_runs ADD COLUMN operation_id TEXT');
    }
  }

  createTask(input: {
    workspace: string;
    goal: string;
    acceptanceCriteria: Array<Omit<AcceptanceCriterion, 'id'> & { id?: string }>;
    steps?: Array<{ description: string; note?: string }>;
    expectedPaths?: string[];
    baselineChangedFiles?: string[];
    baselineContext?: TaskBaselineContext;
    status?: Extract<TaskStatus, 'planning' | 'running'>;
  }): TaskRecord {
    const active = this.getActiveTask(input.workspace);
    if (active) {
      throw new Error(
        `Workspace ${input.workspace} already has active task ${active.id} (status ${active.status}). Resume it via workspace_context/task_update, or set it to failed/cancelled before creating a new one.`,
      );
    }
    const now = new Date().toISOString();
    const acceptanceCriteria = input.acceptanceCriteria.map((criterion, index) => ({
      ...criterion,
      id: criterion.id?.trim() || `c${index + 1}`,
    }));
    const steps = (input.steps ?? []).map((step, index) => ({
      id: `s${index + 1}`,
      description: step.description,
      status: 'pending' as const,
      ...(step.note ? { note: step.note } : {}),
    }));
    const record: TaskRecord = {
      id: `task_${randomUUID()}`,
      workspace: input.workspace,
      goal: input.goal,
      status: input.status ?? 'planning',
      acceptanceCriteria,
      steps,
      expectedPaths: input.expectedPaths ?? [],
      acknowledgedExternalPaths: [],
      baselineChangedFiles: [...new Set(input.baselineChangedFiles ?? [])].sort(),
      baselineContext: input.baselineContext ?? { branch: null, head: null, diffHash: null, changedFileHashes: {}, changedFileHashesTruncated: false },
      changedFiles: [],
      observations: [],
      failedAttempts: [],
      satisfiedCriteria: [],
      checkpoint: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO tasks(
        id, workspace, goal, status, acceptance_criteria, steps, expected_paths, acknowledged_external_paths,
        baseline_changed_files, baseline_context, changed_files, observations, failed_attempts, satisfied_criteria,
        checkpoint_session_key, checkpoint_turn_id, checkpoint_id, checkpoint_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, '[]', '[]', '[]', '[]', NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      record.id, record.workspace, record.goal, record.status,
      JSON.stringify(record.acceptanceCriteria), JSON.stringify(record.steps), JSON.stringify(record.expectedPaths),
      JSON.stringify(record.baselineChangedFiles), JSON.stringify(record.baselineContext), record.createdAt, record.updatedAt,
    );
    return record;
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? taskFromRow(row) : null;
  }

  getActiveTask(workspace: string): TaskRecord | null {
    const placeholders = ACTIVE_TASK_STATUSES.map(() => '?').join(',');
    const row = this.db.prepare(`
      SELECT * FROM tasks WHERE workspace = ? AND status IN (${placeholders})
      ORDER BY updated_at DESC LIMIT 1
    `).get(workspace, ...ACTIVE_TASK_STATUSES) as Record<string, unknown> | undefined;
    return row ? taskFromRow(row) : null;
  }

  private save(record: TaskRecord): TaskRecord {
    const next = { ...record, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      UPDATE tasks SET
        goal = ?, status = ?, acceptance_criteria = ?, steps = ?, expected_paths = ?, acknowledged_external_paths = ?,
        baseline_changed_files = ?, baseline_context = ?, changed_files = ?, observations = ?, failed_attempts = ?, satisfied_criteria = ?,
        checkpoint_session_key = ?, checkpoint_turn_id = ?, checkpoint_id = ?, checkpoint_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.goal, next.status, JSON.stringify(next.acceptanceCriteria), JSON.stringify(next.steps), JSON.stringify(next.expectedPaths), JSON.stringify(next.acknowledgedExternalPaths),
      JSON.stringify(next.baselineChangedFiles), JSON.stringify(next.baselineContext), JSON.stringify(next.changedFiles), JSON.stringify(next.observations), JSON.stringify(next.failedAttempts), JSON.stringify(next.satisfiedCriteria),
      next.checkpoint?.sessionKey ?? null, next.checkpoint?.turnId ?? null, next.checkpoint?.checkpointId ?? null, next.checkpoint?.at ?? null,
      next.updatedAt, next.id,
    );
    return next;
  }

  updateTask(id: string, patch: (task: TaskRecord) => TaskRecord | void): TaskRecord {
    const current = this.getTask(id);
    if (!current) throw new Error(`Unknown task: ${id}`);
    const mutated = patch(current) ?? current;
    return this.save(mutated);
  }

  recordCheckpoint(id: string, checkpoint: TaskCheckpointRef): TaskRecord {
    return this.updateTask(id, (task) => {
      task.checkpoint = checkpoint;
    });
  }

  recordValidationRun(run: Omit<ValidationRun, 'id' | 'createdAt' | 'operationId'> & { operationId?: string }): ValidationRun {
    const record: ValidationRun = {
      ...run,
      id: `val_${randomUUID()}`,
      operationId: run.operationId || `op_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO task_validation_runs(id, operation_id, task_id, kind, overall, diff_hash, changed_files, stages, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.operationId, record.taskId, record.kind, record.overall, record.diffHash,
      JSON.stringify(record.changedFiles), JSON.stringify(record.stages), record.createdAt,
    );
    return record;
  }

  listValidationRuns(taskId: string, limit = 5): ValidationRun[] {
    const rows = this.db.prepare(`
      SELECT * FROM task_validation_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(taskId, limit) as Record<string, unknown>[];
    return rows.map(runFromRow);
  }
}

const stores = new Map<string, TaskStore>();

export async function getTaskStore(stateDbPath: string): Promise<TaskStore> {
  const dbPath = `${stateDbPath}.tasks.sqlite`;
  let store = stores.get(dbPath);
  if (!store) {
    await mkdir(path.dirname(dbPath), { recursive: true });
    store = new TaskStore(dbPath);
    stores.set(dbPath, store);
  }
  return store;
}
