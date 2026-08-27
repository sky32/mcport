import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { assessCommandRisk, patchRisk } from '../dist/risk-policy.js';
import { createWorkspaceCheckpoint, listWorkspaceCheckpoints, restoreWorkspaceCheckpoint } from '../dist/checkpoints.js';
import { MACOS_LOCAL_ONLY_NETWORK_PROFILE } from '../dist/runtime.js';
import { describeToolError, highRiskConfirmationMode, shouldRequireHighRiskConfirmation, withToolBoundary } from '../dist/tools.js';
import { listLocalConfirmations, requestLocalConfirmation, resolveLocalConfirmation } from '../dist/local-confirmations.js';
import { authorizeOperation } from '../dist/authority.js';

for (const flag of ['--version', '-v', '--help', '-h']) {
  const informationalNpx = assessCommandRisk('npx', [flag]);
  assert.equal(informationalNpx.level, 'low', `expected npx ${flag} to be low risk`);
  assert.deepEqual(informationalNpx.categories, []);
  assert.equal(informationalNpx.networkIntent, false);

  for (const packageName of ['hyperframes', '@scope/tool']) {
    const packageExecution = assessCommandRisk('npx', [packageName, flag]);
    assert.equal(packageExecution.level, 'high', `expected npx ${packageName} ${flag} to remain package execution`);
    assert.equal(packageExecution.categories.includes('dependency_change'), true);
    assert.equal(packageExecution.categories.includes('network_access'), true);
    assert.equal(packageExecution.networkIntent, true);
  }
}

const executableNpx = assessCommandRisk('npx', ['hyperframes', 'preview']);
assert.equal(executableNpx.level, 'high');
assert.equal(executableNpx.categories.includes('dependency_change'), true);
assert.equal(executableNpx.categories.includes('network_access'), true);
assert.equal(executableNpx.networkIntent, true);
assert.equal(highRiskConfirmationMode({ requireHighRiskConfirmation: true, highRiskConfirmationMode: 'local' }), 'local');
assert.equal(highRiskConfirmationMode({ requireHighRiskConfirmation: true, highRiskConfirmationMode: 'client' }), 'local');
assert.equal(highRiskConfirmationMode({ requireHighRiskConfirmation: false, highRiskConfirmationMode: 'none' }), 'none');
assert.equal(shouldRequireHighRiskConfirmation(executableNpx, { requireHighRiskConfirmation: true, highRiskConfirmationMode: 'local' }), true);
assert.equal(shouldRequireHighRiskConfirmation(executableNpx, { requireHighRiskConfirmation: true, highRiskConfirmationMode: 'client' }), true);
assert.equal(shouldRequireHighRiskConfirmation(executableNpx, { requireHighRiskConfirmation: false, highRiskConfirmationMode: 'none' }), false);

const localApproval = requestLocalConfirmation('alpha', 'Run high-risk command: npx hyperframes preview', executableNpx, 1000);
const pendingApproval = listLocalConfirmations();
assert.equal(pendingApproval.length, 1);
assert.equal(pendingApproval[0].workspace, 'alpha');
assert.equal(resolveLocalConfirmation(pendingApproval[0].id, true), true);
assert.equal(resolveLocalConfirmation(pendingApproval[0].id, false), false);
assert.equal(await localApproval, true);
assert.equal(listLocalConfirmations().length, 0);
const localTimeout = requestLocalConfirmation('alpha', 'Timeout test', executableNpx, 10);
await new Promise((resolve) => setTimeout(resolve, 25));
assert.equal(await localTimeout, false);
assert.equal(listLocalConfirmations().length, 0);

const install = assessCommandRisk('npm', ['install', 'left-pad']);
assert.equal(install.level, 'high');
assert.equal(install.categories.includes('dependency_change'), true);
assert.equal(install.networkIntent, true);

const uninstall = assessCommandRisk('npm', ['uninstall', 'left-pad']);
assert.equal(uninstall.level, 'high');
assert.equal(uninstall.categories.includes('dependency_change'), true);
assert.equal(uninstall.networkIntent, false);

const reset = assessCommandRisk('git', ['reset', '--hard', 'HEAD']);
assert.equal(reset.categories.includes('destructive_command'), true);

const deletion = patchRisk([{ op: 'delete', path: 'src/old.ts' }]);
assert.equal(deletion.categories.includes('file_delete'), true);

const authorityDenied = await authorizeOperation({
  workspace: 'alpha',
  action: 'Network operation',
  risk: executableNpx,
  runtime: { allowExternalNetwork: false, highRiskConfirmationMode: 'local', requireHighRiskConfirmation: true },
  localConfirmationAvailable: true,
});
assert.equal(authorityDenied.policy, 'deny');
assert.equal(authorityDenied.approved, false);
const authorityApproval = authorizeOperation({
  workspace: 'alpha',
  action: 'Destructive operation',
  risk: deletion,
  runtime: { allowExternalNetwork: false, highRiskConfirmationMode: 'local', requireHighRiskConfirmation: true },
  localConfirmationAvailable: true,
  timeoutMs: 1000,
});
const authorityPending = listLocalConfirmations();
assert.equal(authorityPending.length, 1);
assert.equal(resolveLocalConfirmation(authorityPending[0].id, true), true);
assert.equal((await authorityApproval).approved, true);

assert.equal(MACOS_LOCAL_ONLY_NETWORK_PROFILE.includes('(deny network*)'), true);
assert.equal(MACOS_LOCAL_ONLY_NETWORK_PROFILE.includes('(allow network-bind (local ip "localhost:*"))'), true);
assert.equal(MACOS_LOCAL_ONLY_NETWORK_PROFILE.includes('(allow network-inbound (local ip "localhost:*"))'), true);
assert.equal(MACOS_LOCAL_ONLY_NETWORK_PROFILE.includes('(allow network-outbound (remote ip "localhost:*"))'), true);

const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', phase: 'codeIndex' });
const aggregate = new AggregateError([timeout, Object.assign(new Error('secondary failure'), { code: 'EIO' })], 'parallel work failed');
const errorDetails = describeToolError(aggregate);
assert.equal(errorDetails.errorCode, 'AGGREGATE_ERROR');
assert.equal(errorDetails.retryable, true);
assert.equal(errorDetails.causes?.some((cause) => cause.code === 'ETIMEDOUT' && cause.message === 'timed out'), true);
const phased = describeToolError(timeout);
assert.equal(phased.phase, 'codeIndex');
const boundaryError = await withToolBoundary(async () => {
  throw aggregate;
});
assert.equal(boundaryError.isError, true);
assert.equal(boundaryError.structuredContent?.ok, false);
assert.equal(boundaryError.structuredContent?.errorCode, 'AGGREGATE_ERROR');
assert.equal(boundaryError.structuredContent?.phase, 'toolBoundary');
assert.equal(boundaryError.structuredContent?.retryable, true);

const checkpointSmokeRoot = path.join(os.tmpdir(), `rw-mcp-checkpoint-smoke-${process.pid}-${Date.now()}`);
const root = path.join(checkpointSmokeRoot, 'workspace');
const storageRoot = path.join(checkpointSmokeRoot, 'runtime-state', 'checkpoints');
await mkdir(path.join(root, 'src'), { recursive: true });
try {
  const target = path.join(root, 'src', 'value.txt');
  await writeFile(target, 'before\n');
  const checkpoint = await createWorkspaceCheckpoint({
    root,
    storageRoot,
    paths: ['src/value.txt'],
    label: 'smoke',
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
  });
  await writeFile(target, 'after\n');
  await restoreWorkspaceCheckpoint({ root, storageRoot, id: checkpoint.id });
  assert.equal(await readFile(target, 'utf8'), 'before\n');
  const listed = await listWorkspaceCheckpoints(root, 10, storageRoot);
  assert.equal(listed.some((item) => item.id === checkpoint.id), true);
  await assert.rejects(access(path.join(root, '.remote-workspace-mcp')), { code: 'ENOENT' });
  await access(path.join(storageRoot, checkpoint.id, 'manifest.json'));
} finally {
  await rm(checkpointSmokeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, checks: ['risk-classification', 'macos-localhost-network-policy', 'structured-tool-errors', 'checkpoint-create-list-restore'] }, null, 2));
