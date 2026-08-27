import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a free port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitHealth(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Runtime did not become healthy');
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function data(result) {
  if (result.isError) throw new Error(`Tool failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent ?? {};
}

const port = await freePort();
const root = path.resolve(`data/agent-runtime-smoke-${process.pid}-${Date.now()}`);
const workspaceRoot = path.join(root, 'workspaces');
const workspace = path.join(workspaceRoot, 'demo');
await mkdir(path.join(workspace, 'src'), { recursive: true });
await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
  name: 'demo',
  private: true,
  scripts: { test: 'node test.js' },
}, null, 2), 'utf8');
await writeFile(path.join(workspace, 'test.js'), [
  "const assert = require('node:assert');",
  "const { add } = require('./src/calc.js');",
  'assert.strictEqual(add(2, 3), 5);',
  "console.log('tests passed');",
  '',
].join('\n'), 'utf8');
await writeFile(path.join(workspace, 'src', 'calc.js'), [
  'function add(a, b) {',
  '  return a - b;',
  '}',
  'module.exports = { add };',
  '',
].join('\n'), 'utf8');
git(workspace, 'init');
git(workspace, 'config', 'user.email', 'smoke@example.test');
git(workspace, 'config', 'user.name', 'Smoke');
git(workspace, 'add', '.');
git(workspace, 'commit', '-m', 'initial');

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_AUTH_MODE: 'none',
    MCP_TOOL_TIER: 'full',
    WORKSPACE_REGISTRY_JSON: '{}',
    MCP_WORKSPACE_TOOL_TIERS_JSON: '{}',
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: '{}',
    MCP_ADDITIONAL_SERVICES_JSON: '[]',
    ADMIN_ENABLED: 'false',
    WORKSPACE_ROOT: workspaceRoot,
    STATE_DB_PATH: path.join(root, 'state.db'),
    ALLOW_COMMAND_EXECUTION: 'true',
    REQUIRE_HIGH_RISK_CONFIRMATION: 'false',
    ALLOWED_COMMANDS: 'node,npm,git',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

const client = new Client({ name: 'agent-runtime-smoke', version: '1' });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

try {
  await waitHealth(port);
  await client.connect(transport);

  const created = data(await client.callTool({
    name: 'task_create',
    arguments: {
      goal: 'Fix add() so the demo test suite passes',
      acceptanceCriteria: [
        { description: 'node test.js exits 0', kind: 'command', command: 'node', args: ['test.js'] },
        { description: 'Only files under src/ change', kind: 'manual' },
      ],
      steps: [
        { description: 'Locate the failing implementation' },
        { description: 'Fix src/calc.js' },
        { description: 'Verify with validate_changes' },
      ],
      expectedPaths: ['src'],
      status: 'running',
    },
  }));
  const task = created.task;
  if (!task?.id || task.status !== 'running' || task.acceptanceCriteria.length !== 2 || task.steps.length !== 3) {
    throw new Error(`task_create failed: ${JSON.stringify(created)}`);
  }

  const beforeFix = data(await client.callTool({ name: 'validate_changes', arguments: {} }));
  const testsBefore = beforeFix.stages?.find((stage) => stage.name === 'tests');
  if (beforeFix.overall !== 'fail' || testsBefore?.status !== 'fail') {
    throw new Error(`validate_changes should fail before the fix: ${JSON.stringify(beforeFix)}`);
  }
  const syntaxBefore = beforeFix.stages?.find((stage) => stage.name === 'syntax');
  if (syntaxBefore?.status !== 'skipped' || beforeFix.changedFileCount !== 0) {
    throw new Error(`syntax should be skipped on an unchanged tree: ${JSON.stringify(beforeFix.stages)}`);
  }
  if (beforeFix.taskId !== task.id) throw new Error(`validate_changes did not link the active task: ${JSON.stringify(beforeFix)}`);

  const gateBlocked = data(await client.callTool({
    name: 'task_update',
    arguments: { status: 'completed', completeStepIds: ['s1'] },
  }));
  if (gateBlocked.completed !== false || gateBlocked.completionGate?.passed !== false || gateBlocked.task?.status === 'completed') {
    throw new Error(`completion gate must fail while tests fail: ${JSON.stringify(gateBlocked)}`);
  }
  const failedCheck = gateBlocked.completionGate?.checks?.find((check) => check.criterionId === 'c1');
  if (failedCheck?.status !== 'fail' || !failedCheck.summary) {
    throw new Error(`gate failure report missing details: ${JSON.stringify(gateBlocked.completionGate)}`);
  }

  const calcStat = data(await client.callTool({ name: 'stat_file', arguments: { path: 'src/calc.js' } }));
  data(await client.callTool({
    name: 'apply_patch',
    arguments: { operations: [{ op: 'replace', path: 'src/calc.js', search: 'return a - b;', replacement: 'return a + b;', expectedSha256: calcStat.sha256 }] },
  }));

  data(await client.callTool({
    name: 'apply_patch',
    arguments: { operations: [{ op: 'write', path: 'unexpected.txt', content: 'out of scope\n' }] },
  }));
  const unexpected = data(await client.callTool({ name: 'validate_changes', arguments: {} }));
  if (unexpected.overall !== 'fail' || unexpected.unexpectedFileCount !== 1 || !unexpected.unexpectedFiles?.includes('unexpected.txt')) {
    throw new Error(`unexpected files must fail validation scope: ${JSON.stringify(unexpected)}`);
  }
  data(await client.callTool({ name: 'apply_patch', arguments: { operations: [{ op: 'delete', path: 'unexpected.txt' }] } }));

  const afterFix = data(await client.callTool({ name: 'validate_changes', arguments: {} }));
  if (afterFix.overall !== 'pass' || afterFix.stages?.find((stage) => stage.name === 'tests')?.status !== 'pass') {
    throw new Error(`validate_changes should pass after the fix: ${JSON.stringify(afterFix)}`);
  }
  if (afterFix.stages?.find((stage) => stage.name === 'syntax')?.status !== 'pass') {
    throw new Error(`syntax stage should pass on the fixed source: ${JSON.stringify(afterFix.stages)}`);
  }
  if (!afterFix.changedFiles?.includes('src/calc.js') || afterFix.unexpectedFileCount !== 0) {
    throw new Error(`changed-file scope check failed: ${JSON.stringify(afterFix)}`);
  }

  const opened = data(await client.callTool({
    name: 'project_history_write',
    arguments: { action: 'open', initialUserInput: 'Fix add() so tests pass', title: 'Agent runtime smoke' },
  }));
  if (!opened.sessionKey || opened.created !== true) throw new Error(`project_history_write(open) failed: ${JSON.stringify(opened)}`);
  const checkpoint = data(await client.callTool({
    name: 'project_history_write',
    arguments: {
      action: 'checkpoint', sessionKey: opened.sessionKey,
      turnId: 'fix-add',
      rawUserInput: 'Fix add() so tests pass',
      summary: 'Fixed add() and validated.',
      changes: ['src/calc.js'],
      taskId: task.id,
    },
  }));
  if (!checkpoint.checkpointId?.startsWith('cp_') || checkpoint.taskId !== task.id) {
    throw new Error(`task checkpoint fusion failed: ${JSON.stringify(checkpoint)}`);
  }
  const history = data(await client.callTool({ name: 'project_history_read', arguments: { action: 'read', sessionKey: opened.sessionKey, maxTokens: 12000 } }));
  if (!history.text?.includes('"taskState"') || !history.text.includes('"acceptanceCriteria"') || !history.text.includes('"failedAttempts"')) {
    throw new Error(`checkpoint must persist complete task state: ${JSON.stringify(history)}`);
  }
  const withCheckpoint = data(await client.callTool({ name: 'workspace_context', arguments: {} }));
  if (withCheckpoint.task?.checkpoint?.checkpointId !== checkpoint.checkpointId) {
    throw new Error(`workspace_context did not expose the checkpoint: ${JSON.stringify(withCheckpoint)}`);
  }
  if (withCheckpoint.resume?.pendingSteps?.length !== 2 || !withCheckpoint.resume?.latestValidation) {
    throw new Error(`resume information incomplete: ${JSON.stringify(withCheckpoint.resume)}`);
  }
  if (withCheckpoint.resume.latestValidation.overall !== 'pass') {
    throw new Error(`checkpoint resume should expose the passing validation: ${JSON.stringify(withCheckpoint.resume)}`);
  }

  const satisfied = data(await client.callTool({
    name: 'task_update',
    arguments: { satisfyCriterionIds: ['c2'], completeStepIds: ['s2', 's3'], appendObservation: 'fixed operator and validated via npm test' },
  }));
  const manualCheck = satisfied.task?.acceptanceCriteria?.find((criterion) => criterion.id === 'c2');
  if (manualCheck?.status !== 'satisfied' || manualCheck?.manualSatisfied !== true || 'satisfied' in (manualCheck || {})) {
    throw new Error(`manual criterion satisfaction failed: ${JSON.stringify(satisfied)}`);
  }

  const completed = data(await client.callTool({
    name: 'task_update',
    arguments: { status: 'completed' },
  }));
  if (completed.completed !== true || completed.completionGate?.passed !== true || completed.task?.status !== 'completed') {
    throw new Error(`completion gate should pass after the fix: ${JSON.stringify(completed)}`);
  }
  if (completed.completionGate?.validationFreshness?.fresh !== true) {
    throw new Error(`validation freshness should be true right after validate_changes: ${JSON.stringify(completed.completionGate)}`);
  }
  if (completed.completionGate?.validationFreshness?.latestOverall !== 'pass') {
    throw new Error(`completion gate must require passing validation: ${JSON.stringify(completed.completionGate)}`);
  }
  const commandCheck = completed.completionGate?.checks?.find((check) => check.criterionId === 'c1');
  const commandCriterion = completed.task?.acceptanceCriteria?.find((criterion) => criterion.id === 'c1');
  if (commandCheck?.status !== 'pass' || commandCheck.exitCode !== 0
      || commandCriterion?.status !== 'verified' || commandCriterion?.lastVerification?.status !== 'pass'
      || 'satisfied' in (commandCriterion || {})) {
    throw new Error(`command criterion was not re-executed/reported by the gate: ${JSON.stringify(completed)}`);
  }

  const updateAfterCompletion = await client.callTool({
    name: 'task_update',
    arguments: { appendObservation: 'should be rejected' },
  });
  if (updateAfterCompletion.isError !== true) {
    throw new Error(`updates must be rejected on completed tasks: ${JSON.stringify(updateAfterCompletion.content)}`);
  }

  const failingTask = data(await client.callTool({
    name: 'task_create',
    arguments: {
      goal: 'Deliberately unmeetable task for gate coverage',
      acceptanceCriteria: [{ description: 'always fails', kind: 'command', command: 'node', args: ['-e', 'process.exit(3)'] }],
      status: 'running',
    },
  }));
  const failingGate = data(await client.callTool({
    name: 'task_update',
    arguments: { taskId: failingTask.task.id, status: 'completed' },
  }));
  if (failingGate.completed !== false || failingGate.task?.status !== 'running') {
    throw new Error(`gate must refuse completion on failing criteria: ${JSON.stringify(failingGate)}`);
  }
  data(await client.callTool({ name: 'task_update', arguments: { taskId: failingTask.task.id, status: 'cancelled', recordFailedAttempt: { action: 'completion gate', error: 'criterion always fails' } } }));

  const loopArgs = { query: 'add', includePatterns: ['**/*.js'] };
  const loop1 = await client.callTool({ name: 'search_text', arguments: loopArgs });
  const loop2 = await client.callTool({ name: 'search_text', arguments: loopArgs });
  const loop3 = await client.callTool({ name: 'search_text', arguments: loopArgs });
  if (JSON.stringify(loop1.content).includes('loopWarning') || JSON.stringify(loop2.content).includes('loopWarning')) {
    throw new Error('loop warning fired before the repeat threshold');
  }
  if (!JSON.stringify(loop3.content).includes('repeated_call')) {
    throw new Error(`loop detection did not warn on the third identical call: ${JSON.stringify(loop3.content)}`);
  }
  const taskAfterLoop = data(await client.callTool({ name: 'workspace_context', arguments: {} }));
  if (taskAfterLoop.loopWarning?.pattern !== 'repeated_call') {
      throw new Error(`workspace_context did not surface the active loop warning: ${JSON.stringify(taskAfterLoop)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'task_create', 'validate_changes_fail_before_fix', 'validate_changes_pass_after_fix', 'validate_changes_task_linkage',
      'completion_gate_blocks_failing_task', 'completion_gate_pass_after_fix', 'gate_reexecutes_command_criteria',
      'manual_criterion_satisfaction', 'task_checkpoint_fusion', 'workspace_context_task_resume', 'task_update_rejected_after_completion',
      'loop_detection_repeated_call', 'workspace_context_loop_warning',
    ],
  }, null, 2));
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nRuntime stderr:\n${stderr}`);
} finally {
  try { await transport.terminateSession(); } catch {}
  try { await client.close(); } catch {}
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
