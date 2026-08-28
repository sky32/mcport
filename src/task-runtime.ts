import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as z from 'zod/v4';
import { discoverContext } from './context.js';
import { syntaxCheck } from './code-index.js';
import { summarizeGitDiff } from './git-tools.js';
import { runCommand, runTrustedCommand, type RuntimeExecutionConfig } from './runtime.js';
import { resolveExistingPath } from './security.js';
import type { LoopDetector } from './loop-detector.js';
import type { TaskBaselineContext, TaskRecord, TaskStore, ValidationStageResult } from './task-store.js';

export const acceptanceCriterionSchema = z.object({
  id: z.string().trim().regex(/^c[0-9]{1,3}$/).optional(),
  description: z.string().trim().min(1).max(500),
  kind: z.enum(['command', 'manual']).default('manual'),
  command: z.string().trim().min(1).refine(
    (value) => !value.includes('/') && !value.includes('\\'),
    'Criterion command must be a plain executable name',
  ).optional(),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === 'command' && !value.command) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'command is required when kind=command' });
  }
});

export const taskStepInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  note: z.string().trim().max(1000).optional(),
});

const STAGE_TIMEOUT_MS = 180_000;
const GATE_TIMEOUT_MS = 120_000;
const PYTEST_NO_TESTS_EXIT_CODE = 5;

type GitOutcome = { stdout: string; truncated: boolean } | null;

async function git(config: RuntimeExecutionConfig, root: string, args: string[]): Promise<GitOutcome> {
  try {
    const result = await runTrustedCommand(config, root, 'git', ['--no-pager', ...args], '.', 60_000);
    if (result.exitCode !== 0) return null;
    return { stdout: result.stdout, truncated: result.stdoutTruncated };
  } catch {
    return null;
  }
}

function parseStatusPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const body = line.slice(3);
    const rename = /^(.*) -> (.*)$/.exec(body);
    const raw = rename ? rename[2] : body;
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (unquoted) paths.push(unquoted);
  }
  return [...new Set(paths)].sort();
}

export type ChangeSnapshot = {
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  diffHash: string;
  diffSummary: ReturnType<typeof summarizeGitDiff> | null;
};

export async function collectChanges(config: RuntimeExecutionConfig, root: string): Promise<ChangeSnapshot> {
  const status = await git(config, root, ['status', '--porcelain']);
  if (!status) {
    return {
      isRepo: false, branch: null, head: null, changedFiles: [], diff: '', diffTruncated: false,
      diffHash: createHash('sha256').update('no-repo').digest('hex'), diffSummary: null,
    };
  }
  const [head, diff] = await Promise.all([
    git(config, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(config, root, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv']),
  ]);
  const headCommit = await git(config, root, ['rev-parse', 'HEAD']);
  const diffText = diff?.stdout ?? '';
  // The Runtime's own history archive is not a project change; exclude it like .git.
  const changedFiles = parseStatusPaths(status.stdout).filter((file) => !file.startsWith('.remote-workspace-mcp/'));
  const diffHash = createHash('sha256')
    .update(JSON.stringify({ status: changedFiles, diff: diffText.slice(0, 512 * 1024) }))
    .digest('hex');
  return {
    isRepo: true,
    branch: head?.stdout.trim() || null,
    head: headCommit?.stdout.trim() || null,
    changedFiles,
    diff: diffText,
    diffTruncated: Boolean(diff?.truncated),
    diffHash,
    diffSummary: summarizeGitDiff(diffText),
  };
}

const TASK_BASELINE_HASH_LIMIT = 200;
const TASK_BASELINE_HASH_MAX_BYTES = 8 * 1024 * 1024;

async function taskFileFingerprint(root: string, relativePath: string): Promise<string | null> {
  try {
    const resolved = await resolveExistingPath(root, relativePath);
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    if (info.size > TASK_BASELINE_HASH_MAX_BYTES) return `oversize:${info.size}:${Math.round(info.mtimeMs)}`;
    return createHash('sha256').update(await readFile(resolved)).digest('hex');
  } catch {
    return null;
  }
}

export async function buildTaskBaselineContext(
  root: string,
  snapshot: ChangeSnapshot,
): Promise<TaskBaselineContext> {
  const changedFileHashes: Record<string, string | null> = {};
  for (const relativePath of snapshot.changedFiles.slice(0, TASK_BASELINE_HASH_LIMIT)) {
    changedFileHashes[relativePath] = await taskFileFingerprint(root, relativePath);
  }
  return {
    branch: snapshot.branch,
    head: snapshot.head,
    diffHash: snapshot.diffHash,
    changedFileHashes,
    changedFileHashesTruncated: snapshot.changedFiles.length > TASK_BASELINE_HASH_LIMIT,
  };
}

type CommandStagePlan = {
  name: 'typecheck' | 'lint' | 'tests' | 'build';
  command?: string;
  args?: string[];
  reason?: string;
};

function nodePackageManager(project: { packageManager?: unknown }): string {
  const raw = typeof project.packageManager === 'string' ? project.packageManager : '';
  if (raw.startsWith('pnpm')) return 'pnpm';
  if (raw.startsWith('yarn')) return 'yarn';
  if (raw.startsWith('bun')) return 'bun';
  return 'npm';
}

function scriptStage(
  name: CommandStagePlan['name'],
  scripts: Record<string, unknown>,
  manager: string,
  runtime: RuntimeExecutionConfig,
): CommandStagePlan {
  const placeholder = /^echo "Error: no test specified"/;
  const script = scripts[name === 'tests' ? 'test' : name];
  if (typeof script !== 'string' || !script.trim() || (name === 'tests' && placeholder.test(script))) {
    return { name, reason: `no ${name === 'tests' ? 'test' : name} script in package.json` };
  }
  if (!runtime.allowedCommands.has(manager)) return { name, reason: `command not allowlisted: ${manager}` };
  return { name, command: manager, args: name === 'tests' ? ['test'] : ['run', name] };
}

function pythonStage(
  name: CommandStagePlan['name'],
  command: string,
  runtime: RuntimeExecutionConfig,
  configured: boolean,
  marker: string,
): CommandStagePlan {
  if (!configured) return { name, reason: marker };
  if (!runtime.allowedCommands.has(command)) return { name, reason: `command not allowlisted: ${command}` };
  return { name, command, args: name === 'lint' ? ['check', '.'] : ['.'] };
}

async function buildStagePlan(
  root: string,
  runtime: RuntimeExecutionConfig,
): Promise<{ stages: CommandStagePlan[]; runtimes: string[] }> {
  const context = await discoverContext(root);
  const plan: CommandStagePlan[] = [];
  if (context.runtimes.includes('node') && context.package) {
    const manager = nodePackageManager(context.package as { packageManager?: unknown });
    const scripts = ((context.package as { scripts?: unknown }).scripts ?? {}) as Record<string, unknown>;
    plan.push(scriptStage('typecheck', scripts, manager, runtime));
    plan.push(scriptStage('lint', scripts, manager, runtime));
    plan.push(scriptStage('tests', scripts, manager, runtime));
    plan.push(scriptStage('build', scripts, manager, runtime));
  }
  if (context.runtimes.includes('python') && context.contextFiles.includes('pyproject.toml')) {
    let mypyConfigured = false;
    try {
      const target = await resolveExistingPath(root, 'pyproject.toml');
      const content = await readFile(target, 'utf8');
      mypyConfigured = content.includes('[tool.mypy]');
    } catch {}
    plan.push(pythonStage('typecheck', 'mypy', runtime, mypyConfigured, 'no [tool.mypy] section in pyproject.toml'));
    plan.push(pythonStage('lint', 'ruff', runtime, true, ''));
    plan.push(pythonStage('tests', 'pytest', runtime, true, ''));
  }
  return { stages: plan, runtimes: context.runtimes };
}

function compactLines(text: string, head: number, tail: number, maxChars: number): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  const kept = lines.length > head + tail ? [...lines.slice(0, head), `… (+${lines.length - head - tail} more lines)`, ...lines.slice(-tail)] : lines;
  const joined = kept.join('\n');
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1)}…`;
}

type TaskChangeClassification = {
  expectedTaskChanges: string[];
  knownExternalChanges: string[];
  unexpectedChanges: string[];
};

function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

function pathMatchesScope(candidate: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => prefix === '.' || candidate === prefix || candidate.startsWith(`${prefix}/`));
}

export type TaskContextReview = {
  status: 'aligned' | 'drifted' | 'unknown';
  reasons: string[];
  baseline: { branch: string | null; head: string | null };
  current: { branch: string | null; head: string | null };
  baselineFileChanges: string[];
};

export async function inspectTaskContext(
  root: string,
  task: TaskRecord,
  snapshot: ChangeSnapshot,
): Promise<TaskContextReview> {
  const baseline = task.baselineContext;
  const hasIdentity = Boolean(baseline.branch || baseline.head || baseline.diffHash || Object.keys(baseline.changedFileHashes).length);
  if (!hasIdentity) {
    return {
      status: 'unknown',
      reasons: ['baseline_context_unavailable'],
      baseline: { branch: null, head: null },
      current: { branch: snapshot.branch, head: snapshot.head },
      baselineFileChanges: [],
    };
  }
  const reasons: string[] = [];
  if (baseline.branch !== null && snapshot.branch !== baseline.branch) reasons.push('branch_changed');
  if (baseline.head !== null && snapshot.head !== baseline.head) reasons.push('head_changed');

  const expected = task.expectedPaths.map(normalizeScopePath);
  const acknowledged = task.acknowledgedExternalPaths.map(normalizeScopePath);
  const currentChanged = new Set(snapshot.changedFiles.map(normalizeScopePath));
  const baselineFileChanges: string[] = [];
  for (const [relativePath, baselineHash] of Object.entries(baseline.changedFileHashes)) {
    const candidate = normalizeScopePath(relativePath);
    if (pathMatchesScope(candidate, expected) || pathMatchesScope(candidate, acknowledged)) continue;
    if (!currentChanged.has(candidate)) {
      baselineFileChanges.push(relativePath);
      continue;
    }
    const currentHash = await taskFileFingerprint(root, relativePath);
    if (currentHash !== baselineHash) baselineFileChanges.push(relativePath);
  }
  if (baselineFileChanges.length) reasons.push('baseline_files_changed');
  return {
    status: reasons.length ? 'drifted' : 'aligned',
    reasons,
    baseline: { branch: baseline.branch, head: baseline.head },
    current: { branch: snapshot.branch, head: snapshot.head },
    baselineFileChanges: baselineFileChanges.slice(0, 50),
  };
}

export function classifyTaskChanges(task: TaskRecord | null, changedFiles: string[]): TaskChangeClassification {
  if (!task) return { expectedTaskChanges: [], knownExternalChanges: [], unexpectedChanges: [] };
  const expected = task.expectedPaths.map(normalizeScopePath);
  const acknowledged = task.acknowledgedExternalPaths.map(normalizeScopePath);
  const baseline = new Set((task.baselineChangedFiles ?? []).map(normalizeScopePath));
  const result: TaskChangeClassification = { expectedTaskChanges: [], knownExternalChanges: [], unexpectedChanges: [] };
  for (const file of changedFiles) {
    const candidate = normalizeScopePath(file);
    if (expected.length && pathMatchesScope(candidate, expected)) {
      result.expectedTaskChanges.push(file);
    } else if (baseline.has(candidate) || pathMatchesScope(candidate, acknowledged)) {
      result.knownExternalChanges.push(file);
    } else if (!expected.length) {
      result.expectedTaskChanges.push(file);
    } else {
      result.unexpectedChanges.push(file);
    }
  }
  return result;
}

function unexpectedFilesFor(task: TaskRecord | null, changedFiles: string[]): string[] {
  return classifyTaskChanges(task, changedFiles).unexpectedChanges;
}

function filesWithinScope(changedFiles: string[], paths: string[]): string[] {
  const normalized = paths.map(normalizeScopePath);
  return changedFiles.filter((file) => {
    const candidate = normalizeScopePath(file);
    return normalized.some((prefix) => prefix === '.' || candidate === prefix || candidate.startsWith(`${prefix}/`));
  });
}

async function scopedDiffHash(config: RuntimeExecutionConfig, root: string, changedFiles: string[], paths: string[]) {
  const normalized = [...new Set(paths.map(normalizeScopePath))].sort();
  const diff = normalized.length
    ? await git(config, root, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--', ...normalized])
    : null;
  const text = diff?.stdout ?? '';
  return {
    diffHash: createHash('sha256').update(JSON.stringify({ status: changedFiles, paths: normalized, diff: text.slice(0, 512 * 1024) })).digest('hex'),
    diffTruncated: Boolean(diff?.truncated),
  };
}

function commandStageResult(
  name: string,
  result: { exitCode: number | null; stderr: string; stdout: string; durationMs: number },
): ValidationStageResult & { exitCode: number | null } {
  const failed = result.exitCode !== 0;
  const summary = failed
    ? compactLines(result.stderr || result.stdout, 5, 3, 600) || `exited with code ${result.exitCode}`
    : compactLines(result.stdout, 2, 0, 200) || undefined;
  return {
    name,
    status: failed ? 'fail' : 'pass',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(summary ? { summary } : {}),
  };
}

export type ValidateChangesReport = {
  ok: true;
  overall: 'pass' | 'fail';
  workspace: string;
  mode: 'quick' | 'full';
  scope: { kind: 'workspace' } | { kind: 'mutation'; mutationId: string; paths: string[] };
  stages: Array<ValidationStageResult & { exitCode?: number | null }>;
  changedFileCount: number;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  workspaceChangedFileCount: number;
  workspaceChangedFiles: string[];
  workspaceChangedFilesTruncated: boolean;
  expectedTaskChangedFileCount: number | null;
  expectedTaskChangedFiles: string[];
  knownExternalChangedFileCount: number | null;
  knownExternalChangedFiles: string[];
  unexpectedFileCount: number | null;
  unexpectedFiles: string[];
  lspCheckedCount: number;
  lspSkippedCount: number;
  lspSkippedFiles: string[];
  lspSkippedFilesTruncated: boolean;
  lspUnavailableCount: number;
  diffHash: string;
  remainingRisks: string[];
  taskId: string | null;
  validationRunId: string | null;
  validationOperationId: string | null;
  loopWarning: ReturnType<LoopDetector['recordValidation']>;
};

export async function runValidateChanges(input: {
  store: TaskStore;
  loop: LoopDetector;
  serviceId: string;
  workspace: string;
  root: string;
  runtime: RuntimeExecutionConfig;
  taskId?: string;
  mutationScope?: { mutationId: string; paths: string[] };
  mode?: 'quick' | 'full';
  lspDiagnostics?: (relativePath: string) => Promise<unknown>;
}): Promise<ValidateChangesReport> {
  const snapshot = await collectChanges(input.runtime, input.root);
  const mode = input.mode ?? (input.mutationScope ? 'quick' : 'full');
  const scope = input.mutationScope
    ? { kind: 'mutation' as const, mutationId: input.mutationScope.mutationId, paths: [...input.mutationScope.paths] }
    : { kind: 'workspace' as const };
  const changedFiles = input.mutationScope
    ? filesWithinScope(snapshot.changedFiles, input.mutationScope.paths)
    : snapshot.changedFiles;
  const scopedHash = input.mutationScope
    ? await scopedDiffHash(input.runtime, input.root, changedFiles, input.mutationScope.paths)
    : { diffHash: snapshot.diffHash, diffTruncated: snapshot.diffTruncated };

  let task: TaskRecord | null = null;
  if (input.taskId) {
    task = input.store.getTask(input.taskId);
    if (!task) throw new Error(`Unknown task: ${input.taskId}`);
    if (task.workspace !== input.workspace) throw new Error(`Task ${input.taskId} belongs to workspace ${task.workspace}`);
  } else {
    task = input.store.getActiveTask(input.workspace);
  }

  const stages: ValidateChangesReport['stages'] = [];
  const remainingRisks: string[] = [];
  let lspCheckedCount = 0;
  let lspSkippedFiles: string[] = [];
  let lspUnavailableCount = 0;

  if (changedFiles.length) {
    const syntax = await syntaxCheck(input.root, changedFiles);
    const failures = syntax.filter((item) => item.status === 'fail');
    stages.push({
      name: 'syntax',
      status: failures.length ? 'fail' : 'pass',
      durationMs: undefined,
      ...(failures.length
        ? { summary: failures.slice(0, 10).map((item) => `${item.path}: ${item.detail}`).join('\n') }
        : {}),
    });
  } else {
    stages.push({ name: 'syntax', status: 'skipped', reason: snapshot.isRepo ? 'no changed files in validation scope' : 'not a git repository' });
  }

  const lspCandidates = changedFiles.filter((file) => /\.(?:[cm]?[jt]sx?|html?|css|scss|less)$/i.test(file));
  if (!input.lspDiagnostics) {
    lspSkippedFiles = [...lspCandidates];
    stages.push({ name: 'lsp', status: 'skipped', reason: 'LSP diagnostics unavailable' });
  } else if (!lspCandidates.length) {
    stages.push({ name: 'lsp', status: 'skipped', reason: 'no supported changed files in validation scope' });
  } else {
    const diagnostics: string[] = [];
    const unavailable: string[] = [];
    const unavailablePaths: string[] = [];
    let warnings = 0;
    for (const file of lspCandidates.slice(0, 12)) {
      try {
        const response = await input.lspDiagnostics(file) as { result?: unknown } | null;
        const items = Array.isArray(response?.result) ? response.result : [];
        lspCheckedCount += 1;
        for (const raw of items.slice(0, 50)) {
          if (!raw || typeof raw !== 'object') continue;
          const item = raw as { severity?: unknown; message?: unknown; range?: { start?: { line?: unknown } } };
          const severity = Number(item.severity ?? 1);
          const message = typeof item.message === 'string' ? item.message : 'LSP diagnostic';
          const line = Number(item.range?.start?.line ?? -1) + 1;
          if (severity === 1) diagnostics.push(`${file}${line > 0 ? `:${line}` : ''}: ${message}`);
          else if (severity === 2) warnings += 1;
        }
      } catch (error) {
        unavailablePaths.push(file);
        unavailable.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const notChecked = lspCandidates.slice(12);
    lspSkippedFiles = [...unavailablePaths, ...notChecked];
    lspUnavailableCount = unavailablePaths.length;
    if (notChecked.length) {
      const visibleNotChecked = notChecked.slice(0, 8);
      remainingRisks.push(`lsp: limited to 12 of ${lspCandidates.length} supported changed files; not checked: ${visibleNotChecked.join(', ')}${notChecked.length > visibleNotChecked.length ? ` (+${notChecked.length - visibleNotChecked.length} more)` : ''}`);
    }
    if (unavailable.length) remainingRisks.push(`lsp: ${unavailable.length} file(s) could not be diagnosed`);
    if (!lspCheckedCount && unavailable.length) {
      stages.push({ name: 'lsp', status: 'skipped', reason: compactLines(unavailable.join('\n'), 3, 1, 600) });
    } else {
      const summaryParts = [
        `${lspCheckedCount} file(s) checked`,
        ...(warnings ? [`${warnings} warning(s)`] : []),
        ...(unavailable.length ? [`${unavailable.length} unavailable`] : []),
        ...(notChecked.length ? [`${notChecked.length} skipped by limit`] : []),
      ];
      if (diagnostics.length) summaryParts.push(compactLines(diagnostics.join('\n'), 6, 2, 900));
      stages.push({ name: 'lsp', status: diagnostics.length ? 'fail' : 'pass', summary: summaryParts.join('\n') });
    }
  }

  if (mode === 'quick') {
    for (const name of ['typecheck', 'lint', 'tests', 'build']) stages.push({ name, status: 'skipped', reason: 'quick validation mode' });
    remainingRisks.push('project-wide typecheck/lint/tests/build skipped in quick validation mode');
  } else {
    const plan = await buildStagePlan(input.root, input.runtime);
    if (!plan.stages.length) remainingRisks.push('no recognized runtime validation commands for this project');
    for (const stage of plan.stages) {
      if (!stage.command) {
        stages.push({ name: stage.name, status: 'skipped', reason: stage.reason || 'unavailable' });
        if (stage.reason && stage.reason !== 'command execution disabled') remainingRisks.push(`${stage.name}: ${stage.reason}`);
        continue;
      }
      try {
        const result = await runCommand(
          input.runtime, input.root, stage.command, stage.args ?? [], '.',
          Math.min(input.runtime.maxCommandTimeoutMs, STAGE_TIMEOUT_MS),
        );
        if (stage.name === 'tests' && stage.command === 'pytest' && result.exitCode === PYTEST_NO_TESTS_EXIT_CODE) {
          stages.push({ name: 'tests', status: 'skipped', exitCode: result.exitCode, durationMs: result.durationMs, reason: 'no tests collected' });
          remainingRisks.push('tests: no tests collected');
          continue;
        }
        stages.push(commandStageResult(stage.name, result));
      } catch (error) {
        stages.push({ name: stage.name, status: 'fail', exitCode: null, summary: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  const classification = classifyTaskChanges(task, changedFiles);
  const unexpectedFiles = classification.unexpectedChanges;
  const executed = stages.filter((stage) => stage.status !== 'skipped');
  const overall = executed.every((stage) => stage.status === 'pass') && unexpectedFiles.length === 0 ? 'pass' : 'fail';
  if (scopedHash.diffTruncated) remainingRisks.push('git diff was truncated');
  if (!snapshot.isRepo) remainingRisks.push('not a git repository; change detection unavailable');
  if (input.mutationScope) {
    const outsideScope = snapshot.changedFiles.filter((file) => !changedFiles.includes(file));
    if (outsideScope.length) remainingRisks.push(`${outsideScope.length} workspace change(s) exist outside the mutation validation scope`);
  }

  const hasUnexpectedCheck = Boolean(task && task.expectedPaths.length);
  const boundedChanged = changedFiles.slice(0, 50);
  const boundedWorkspaceChanged = snapshot.changedFiles.slice(0, 50);
  let validationRunId: string | null = null;
  let validationOperationId: string | null = `op_${randomUUID()}`;
  if (task) {
    if (task.changedFiles.join('\n') !== changedFiles.join('\n')) {
      input.store.updateTask(task.id, (current) => {
        current.changedFiles = changedFiles;
      });
    }
    const run = input.store.recordValidationRun({
      taskId: task.id,
      kind: 'validate_changes',
      overall,
      diffHash: scopedHash.diffHash,
      changedFiles,
      stages,
    });
    validationRunId = run.id;
    validationOperationId = run.operationId;
  }

  const loopWarning = input.loop.recordValidation({
    serviceId: input.serviceId,
    workspace: input.workspace,
    diffHash: scopedHash.diffHash,
    overall,
  });

  return {
    ok: true,
    overall,
    workspace: input.workspace,
    mode,
    scope,
    stages,
    changedFileCount: changedFiles.length,
    changedFiles: boundedChanged,
    changedFilesTruncated: changedFiles.length > boundedChanged.length,
    workspaceChangedFileCount: snapshot.changedFiles.length,
    workspaceChangedFiles: boundedWorkspaceChanged,
    workspaceChangedFilesTruncated: snapshot.changedFiles.length > boundedWorkspaceChanged.length,
    expectedTaskChangedFileCount: task ? classification.expectedTaskChanges.length : null,
    expectedTaskChangedFiles: classification.expectedTaskChanges.slice(0, 50),
    knownExternalChangedFileCount: task ? classification.knownExternalChanges.length : null,
    knownExternalChangedFiles: classification.knownExternalChanges.slice(0, 50),
    unexpectedFileCount: hasUnexpectedCheck ? unexpectedFiles.length : null,
    unexpectedFiles: unexpectedFiles.slice(0, 50),
    lspCheckedCount,
    lspSkippedCount: lspSkippedFiles.length,
    lspSkippedFiles: lspSkippedFiles.slice(0, 50),
    lspSkippedFilesTruncated: lspSkippedFiles.length > 50,
    lspUnavailableCount,
    diffHash: scopedHash.diffHash,
    remainingRisks,
    taskId: task?.id ?? null,
    validationRunId,
    validationOperationId,
    loopWarning,
  };
}

export type CompletionGateReport = {
  passed: boolean;
  operationId: string;
  checks: Array<{
    criterionId: string;
    description: string;
    kind: 'command' | 'manual';
    status: 'pass' | 'fail';
    exitCode?: number | null;
    durationMs?: number;
    summary?: string;
  }>;
  validationFreshness: {
    fresh: boolean | null;
    latestDiffHash: string | null;
    latestOverall: 'pass' | 'fail' | null;
    currentDiffHash: string;
    latestValidationAt: string | null;
    unexpectedFiles: string[];
  };
  taskContext: TaskContextReview;
  blockingReasons: Array<{ code: string; summary: string }>;
};

export async function runCompletionGate(input: {
  store: TaskStore;
  serviceId: string;
  workspace: string;
  root: string;
  runtime: RuntimeExecutionConfig;
  task: TaskRecord;
}): Promise<CompletionGateReport> {
  const snapshot = await collectChanges(input.runtime, input.root);
  const latest = input.store
    .listValidationRuns(input.task.id, 10)
    .find((run) => run.kind === 'validate_changes') ?? null;
  const unexpectedFiles = unexpectedFilesFor(input.task, snapshot.changedFiles);
  const taskContext = await inspectTaskContext(input.root, input.task, snapshot);

  const checks: CompletionGateReport['checks'] = [];
  for (const criterion of input.task.acceptanceCriteria) {
    if (criterion.kind === 'manual') {
      checks.push({
        criterionId: criterion.id,
        description: criterion.description,
        kind: 'manual',
        status: input.task.satisfiedCriteria.includes(criterion.id) ? 'pass' : 'fail',
        ...(input.task.satisfiedCriteria.includes(criterion.id) ? {} : { summary: 'manual criterion was not marked satisfied' }),
      });
      continue;
    }
    if (!criterion.command || !input.runtime.allowedCommands.has(criterion.command)) {
      checks.push({ criterionId: criterion.id, description: criterion.description, kind: 'command', status: 'fail', summary: `command not allowlisted: ${criterion.command ?? '(missing)'}` });
      continue;
    }
    try {
      const result = await runCommand(
        input.runtime, input.root, criterion.command, criterion.args ?? [], '.',
        Math.min(input.runtime.maxCommandTimeoutMs, criterion.timeoutMs ?? GATE_TIMEOUT_MS),
      );
      checks.push({
        criterionId: criterion.id,
        description: criterion.description,
        kind: 'command',
        status: result.exitCode === 0 ? 'pass' : 'fail',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.exitCode === 0 ? {} : { summary: compactLines(result.stderr || result.stdout, 5, 3, 400) || `exited with code ${result.exitCode}` }),
      });
    } catch (error) {
      checks.push({
        criterionId: criterion.id, description: criterion.description, kind: 'command', status: 'fail',
        summary: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const freshValidation = Boolean(latest && latest.overall === 'pass' && latest.diffHash === snapshot.diffHash);
  const contextAllowsCompletion = taskContext.status !== 'drifted';
  const blockingReasons: CompletionGateReport['blockingReasons'] = [];
  if (checks.some((check) => check.status === 'fail')) blockingReasons.push({ code: 'CRITERIA_FAILED', summary: 'One or more acceptance criteria failed.' });
  if (!freshValidation) blockingReasons.push({ code: 'VALIDATION_STALE_OR_FAILED', summary: 'A passing validate_changes result for the current Workspace diff is required.' });
  if (unexpectedFiles.length) blockingReasons.push({ code: 'UNEXPECTED_FILES', summary: `Unexpected changed files: ${unexpectedFiles.slice(0, 10).join(', ')}` });
  if (!contextAllowsCompletion) blockingReasons.push({ code: 'TASK_CONTEXT_DRIFT', summary: `Task baseline drift detected: ${taskContext.reasons.join(', ')}` });
  const guardStages: ValidationStageResult[] = [
    {
      name: 'validation_freshness',
      status: freshValidation ? 'pass' : 'fail',
      ...(freshValidation ? {} : { summary: latest ? `latest validation ${latest.overall} at ${latest.diffHash}; current diff ${snapshot.diffHash}` : 'no validate_changes evidence exists' }),
    },
    {
      name: 'unexpected_files',
      status: unexpectedFiles.length ? 'fail' : 'pass',
      ...(unexpectedFiles.length ? { summary: unexpectedFiles.slice(0, 10).join(', ') } : {}),
    },
    {
      name: 'task_context',
      status: contextAllowsCompletion ? 'pass' : 'fail',
      ...(taskContext.status === 'unknown' ? { summary: 'task baseline context unavailable; not blocking completion' } : taskContext.reasons.length ? { summary: taskContext.reasons.join(', ') } : {}),
    },
  ];
  const passed = checks.length > 0
    && checks.every((check) => check.status === 'pass')
    && freshValidation
    && unexpectedFiles.length === 0
    && contextAllowsCompletion;
  const completionRun = input.store.recordValidationRun({
    taskId: input.task.id,
    kind: 'completion_gate',
    overall: passed ? 'pass' : 'fail',
    diffHash: snapshot.diffHash,
    changedFiles: snapshot.changedFiles,
    stages: [
      ...checks.map((check) => ({
        name: check.criterionId,
        status: check.status,
        ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
        ...(check.durationMs !== undefined ? { durationMs: check.durationMs } : {}),
        ...(check.summary ? { summary: check.summary } : {}),
      })),
      ...guardStages,
    ],
  });

  return {
    passed,
    operationId: completionRun.operationId,
    checks,
    validationFreshness: {
      fresh: latest ? freshValidation : null,
      latestDiffHash: latest?.diffHash ?? null,
      latestOverall: latest?.overall ?? null,
      currentDiffHash: snapshot.diffHash,
      latestValidationAt: latest?.createdAt ?? null,
      unexpectedFiles: unexpectedFiles.slice(0, 50),
    },
    taskContext,
    blockingReasons,
  };
}

export type TaskCheckpointData = {
  taskId: string;
  status: string;
  goal: string;
  taskState: {
    acceptanceCriteria: TaskRecord['acceptanceCriteria'];
    steps: TaskRecord['steps'];
    expectedPaths: string[];
    acknowledgedExternalPaths: string[];
    baselineChangedFiles: string[];
    baselineContext: TaskRecord['baselineContext'];
    changedFiles: string[];
    observations: TaskRecord['observations'];
    failedAttempts: TaskRecord['failedAttempts'];
    satisfiedCriteria: string[];
    checkpoint: TaskRecord['checkpoint'];
  };
  gitHead: string | null;
  branch: string | null;
  diffSummary: {
    filesChanged: number;
    additions: number;
    deletions: number;
    files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  } | null;
  changedFiles: string[];
  fileHashes: Array<{ path: string; sha256: string; missing?: boolean }>;
  latestValidation: { id: string; kind: string; overall: string; diffHash: string; createdAt: string } | null;
  capturedAt: string;
};

export async function buildTaskCheckpointData(input: {
  store: TaskStore;
  root: string;
  runtime: RuntimeExecutionConfig;
  task: TaskRecord;
}): Promise<TaskCheckpointData> {
  const snapshot = await collectChanges(input.runtime, input.root);
  const fileHashes: TaskCheckpointData['fileHashes'] = [];
  for (const file of snapshot.changedFiles.slice(0, 100)) {
    try {
      const target = await resolveExistingPath(input.root, file);
      const buffer = await readFile(target);
      if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) continue;
      fileHashes.push({ path: file, sha256: createHash('sha256').update(buffer).digest('hex') });
    } catch {
      fileHashes.push({ path: file, sha256: '', missing: true });
    }
  }
  const latestRun = input.store
    .listValidationRuns(input.task.id, 10)
    .find((run) => run.kind === 'validate_changes') ?? null;
  return {
    taskId: input.task.id,
    status: input.task.status,
    goal: input.task.goal,
    taskState: {
      acceptanceCriteria: input.task.acceptanceCriteria,
      steps: input.task.steps,
      expectedPaths: input.task.expectedPaths,
      acknowledgedExternalPaths: input.task.acknowledgedExternalPaths,
      baselineChangedFiles: input.task.baselineChangedFiles.slice(0, 100),
      baselineContext: input.task.baselineContext,
      changedFiles: input.task.changedFiles.slice(0, 100),
      observations: input.task.observations,
      failedAttempts: input.task.failedAttempts,
      satisfiedCriteria: input.task.satisfiedCriteria,
      checkpoint: input.task.checkpoint,
    },
    gitHead: snapshot.head,
    branch: snapshot.branch,
    diffSummary: snapshot.diffSummary
      ? {
        filesChanged: snapshot.diffSummary.filesChanged,
        additions: snapshot.diffSummary.additions,
        deletions: snapshot.diffSummary.deletions,
        files: snapshot.diffSummary.files.slice(0, 50).map((file) => ({
          path: file.path, status: file.status, additions: file.additions, deletions: file.deletions,
        })),
      }
      : null,
    changedFiles: snapshot.changedFiles.slice(0, 100),
    fileHashes,
    latestValidation: latestRun
      ? { id: latestRun.id, kind: latestRun.kind, overall: latestRun.overall, diffHash: latestRun.diffHash, createdAt: latestRun.createdAt }
      : null,
    capturedAt: new Date().toISOString(),
  };
}
