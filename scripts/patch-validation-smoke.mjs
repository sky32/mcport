import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatchEnvelope } from '../dist/patch.js';
import { runValidateChanges } from '../dist/task-runtime.js';

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

async function patchEnvelopeSmoke() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mcport-patch-smoke-'));
  const root = await realpath(temp);
  try {
    await writeFile(path.join(root, 'a.txt'), 'left=1; right=1\n');
    await chmod(path.join(root, 'a.txt'), 0o640);

    const dryRun = await applyPatchEnvelope({
      root,
      operations: [
        { op: 'replace', path: 'a.txt', search: 'left=1', replacement: 'left=2' },
        { op: 'replace', path: 'a.txt', search: 'right=1', replacement: 'right=2' },
      ],
      maxFileBytes: 1024 * 1024,
      dryRun: true,
    });
    assert(dryRun.operations.every((item) => item.status === 'planned'), 'dry-run operations were not reported as planned', dryRun.operations);
    assert(await readFile(path.join(root, 'a.txt'), 'utf8') === 'left=1; right=1\n', 'dry-run mutated the file');

    const previousUmask = process.umask(0o077);
    let applied;
    try {
      applied = await applyPatchEnvelope({
        root,
        operations: [
          { op: 'replace', path: 'a.txt', search: 'left=1', replacement: 'left=2' },
          { op: 'replace', path: 'a.txt', search: 'right=1', replacement: 'right=2' },
          { op: 'write', path: 'b.txt', content: 'value=1\n' },
          { op: 'replace', path: 'b.txt', search: 'value=1', replacement: 'value=2' },
        ],
        maxFileBytes: 1024 * 1024,
        dryRun: false,
      });
    } finally {
      process.umask(previousUmask);
    }

    const a = await readFile(path.join(root, 'a.txt'), 'utf8');
    const b = await readFile(path.join(root, 'b.txt'), 'utf8');
    assert(a === 'left=2; right=2\n', 'sequential replace operations did not compose', { a });
    assert(b === 'value=2\n', 'write followed by replace did not compose', { b });
    assert(applied.operations.map((item) => item.op).join(',') === 'replace,replace,write,replace', 'operation result types were collapsed', applied.operations);
    assert(applied.operations.every((item) => item.status === 'applied'), 'applied operation status missing', applied.operations);
    assert(applied.changedPaths.join(',') === 'a.txt,b.txt', 'changedPaths were not deduplicated', applied.changedPaths);
    assert(((await stat(path.join(root, 'a.txt'))).mode & 0o777) === 0o640, 'existing file mode was not preserved');
    assert(((await stat(path.join(root, 'b.txt'))).mode & 0o777) === 0o600, 'new file mode ignored process umask after write+replace');

    const nested = await applyPatchEnvelope({
      root,
      operations: [
        { op: 'mkdir', path: 'generated' },
        { op: 'mkdir', path: 'generated/nested' },
        { op: 'write', path: 'generated/nested/config.txt', content: 'ok=1\n' },
      ],
      maxFileBytes: 1024 * 1024,
      dryRun: false,
    });
    assert(await readFile(path.join(root, 'generated', 'nested', 'config.txt'), 'utf8') === 'ok=1\n', 'mkdir followed by nested write in one patch did not apply');
    assert(nested.operations.map((item) => item.op).join(',') === 'mkdir,mkdir,write', 'nested mkdir/write operation ordering changed', nested.operations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

async function validationScopeSmoke() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mcport-validation-smoke-'));
  const root = await realpath(temp);
  try {
    git(root, 'init');
    git(root, 'config', 'user.email', 'smoke@example.test');
    git(root, 'config', 'user.name', 'Smoke');
    await mkdir(path.join(root, 'dir'));
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    await writeFile(path.join(root, 'dir', 'file.ts'), 'export const nested = 1;\n');
    await writeFile(path.join(root, 'other.txt'), 'base\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'initial');
    await writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');
    await writeFile(path.join(root, 'dir', 'file.ts'), 'export const nested = 2;\n');
    await writeFile(path.join(root, 'other.txt'), 'changed\n');

    const runtime = {
      runtimePath: process.env.PATH || '',
      allowedCommands: new Set(['git']),
      allowCommandExecution: false,
      allowExternalNetwork: false,
      networkIsolationRequired: false,
      maxCommandOutputBytes: 262144,
      defaultCommandTimeoutMs: 30000,
      maxCommandTimeoutMs: 60000,
    };
    const store = {
      getTask: () => null,
      getActiveTask: () => null,
      updateTask: () => {},
      recordValidationRun: () => { throw new Error('unexpected validation record without a task'); },
    };
    const loop = { recordValidation: () => null };
    const baseInput = {
      store,
      loop,
      serviceId: 'patch-validation-smoke',
      workspace: 'smoke',
      root,
      runtime,
      mutationScope: { mutationId: 'mut_smoke_scope', paths: ['a.ts'] },
    };

    const passing = await runValidateChanges({ ...baseInput, lspDiagnostics: async () => ({ result: [] }) });
    assert(passing.mode === 'quick', 'mutation scope did not default to quick validation', passing.mode);
    assert(passing.scope.kind === 'mutation' && passing.scope.mutationId === 'mut_smoke_scope', 'mutation scope metadata missing', passing.scope);
    assert(passing.changedFiles.join(',') === 'a.ts', 'scoped changed files included unrelated workspace changes', passing.changedFiles);
    assert(passing.workspaceChangedFiles.includes('other.txt'), 'workspace dirty-file context was lost', passing.workspaceChangedFiles);
    assert(passing.stages.find((stage) => stage.name === 'lsp')?.status === 'pass', 'LSP stage did not pass for clean diagnostics', passing.stages);
    assert(passing.stages.find((stage) => stage.name === 'typecheck')?.status === 'skipped', 'quick validation unexpectedly ran project-wide commands', passing.stages);
    assert(passing.overall === 'pass', 'clean scoped validation did not pass', passing);

    const unavailable = await runValidateChanges({ ...baseInput, lspDiagnostics: async () => { throw new Error('language server unavailable'); } });
    assert(unavailable.stages.find((stage) => stage.name === 'lsp')?.status === 'skipped', 'unavailable LSP should be reported as skipped, not fabricated', unavailable.stages);
    assert(unavailable.overall === 'pass', 'unavailable LSP incorrectly failed otherwise clean quick validation', unavailable);

    const failing = await runValidateChanges({
      ...baseInput,
      lspDiagnostics: async () => ({ result: [{ severity: 1, message: 'synthetic semantic error', range: { start: { line: 0 } } }] }),
    });
    assert(failing.stages.find((stage) => stage.name === 'lsp')?.status === 'fail', 'LSP error diagnostic did not fail the LSP stage', failing.stages);
    assert(failing.overall === 'fail', 'LSP error diagnostic did not fail validation', failing);

    const task = {
      id: 'task_scope_paths', workspace: 'smoke', goal: 'scope smoke', status: 'running',
      acceptanceCriteria: [], steps: [], expectedPaths: ['dir/'], acknowledgedExternalPaths: [], baselineChangedFiles: ['other.txt'], changedFiles: [], observations: [], failedAttempts: [],
      satisfiedCriteria: [], checkpoint: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const taskStore = {
      getTask: () => null,
      getActiveTask: () => task,
      updateTask: (_id, updater) => updater(task),
      recordValidationRun: () => ({ id: 'val_scope_paths' }),
    };
    const expectedPathReport = await runValidateChanges({
      store: taskStore,
      loop,
      serviceId: 'patch-validation-smoke',
      workspace: 'smoke',
      root,
      runtime,
      mode: 'quick',
      lspDiagnostics: async () => ({ result: [] }),
    });
    assert(!expectedPathReport.unexpectedFiles.includes('dir/file.ts'), 'expectedPaths trailing slash was not normalized', expectedPathReport.unexpectedFiles);
    assert(expectedPathReport.unexpectedFiles.includes('a.ts'), 'unexpected-file scope check lost unrelated task changes', expectedPathReport.unexpectedFiles);
    assert(!expectedPathReport.unexpectedFiles.includes('other.txt'), 'pre-task dirty baseline was incorrectly reported as an unexpected task change', expectedPathReport.unexpectedFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await patchEnvelopeSmoke();
await validationScopeSmoke();
console.log(JSON.stringify({
  ok: true,
  checks: [
    'dry_run_no_mutation',
    'mkdir_then_nested_write_same_patch',
    'same_file_replace_composition',
    'write_then_replace_composition',
    'operation_result_semantics',
    'file_mode_preservation',
    'mutation_scope_filtering',
    'workspace_dirty_context',
    'quick_validation_defaults',
    'lsp_pass_skip_fail_semantics',
    'expected_paths_trailing_slash_normalization',
    'pre_task_dirty_baseline_ignored',
  ],
}));
