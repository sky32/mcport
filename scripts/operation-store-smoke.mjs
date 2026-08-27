import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationStore } from '../dist/operation-store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'mcport-operation-store-'));
const dbPath = path.join(root, 'operations.sqlite');
try {
  const first = new OperationStore(dbPath, 'runtime-one');
  first.createCommand({
    id: 'operation-one',
    command: 'npm',
    args: ['test'],
    cwd: '.',
    workspaceRoot: root,
    runtimeInstanceId: 'runtime-one',
  });
  first.markRunning('operation-one', 1234);
  assert.equal(first.get('operation-one')?.status, 'running');
  first.close();

  const restarted = new OperationStore(dbPath, 'runtime-two');
  const unknown = restarted.get('operation-one');
  assert.equal(unknown?.status, 'outcome_unknown');
  assert.equal(unknown?.command, 'npm');
  assert.throws(
    () => restarted.reconcile('operation-one', 'failed', 'premature reconciliation'),
    /Re-observe the outcome_unknown operation before reconciliation/,
  );
  const observed = restarted.observe('operation-one', JSON.stringify({ conclusion: 'operation_outcome_remains_unknown' }));
  assert.equal(observed.lastObservation, JSON.stringify({ conclusion: 'operation_outcome_remains_unknown' }));
  const reconciled = restarted.reconcile('operation-one', 'failed', 'The workspace diff shows the command did not complete the requested change.');
  assert.equal(reconciled.status, 'failed');
  assert.equal(reconciled.reconciliationReason, 'The workspace diff shows the command did not complete the requested change.');
  assert.equal(restarted.get('operation-one')?.status, 'failed');
  restarted.createCommand({
    id: 'operation-success',
    command: 'git',
    args: ['status'],
    cwd: '.',
    workspaceRoot: root,
    runtimeInstanceId: 'runtime-two',
  });
  restarted.markRunning('operation-success', 4321);
  restarted.complete('operation-success', {
    status: 'succeeded', exitedAt: new Date().toISOString(), exitCode: 0, signal: null,
    stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
  });
  const mutation = restarted.recordEvent({
    id: 'mutation-one',
    kind: 'mutation',
    status: 'succeeded',
    workspace: 'alpha',
    paths: ['src/alpha.ts'],
    details: { tool: 'apply_patch' },
  });
  assert.equal(restarted.getAny('mutation-one')?.kind, 'mutation');
  assert.deepEqual(mutation.paths, ['src/alpha.ts']);
  const listed = restarted.list('alpha', root, 10);
  assert.equal(listed.some((item) => item.id === 'mutation-one' && item.kind === 'mutation'), true);
  assert.equal(listed.some((item) => item.id === 'operation-one' && item.kind === 'command'), true);
  assert.equal(listed.some((item) => item.id === 'operation-success'), false, 'recovery view should omit successful short-lived commands');
  const allListed = restarted.list('alpha', root, 10, 'all');
  assert.equal(allListed.some((item) => item.id === 'operation-success' && item.status === 'succeeded'), true);
  restarted.close();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('operation-store smoke passed');
