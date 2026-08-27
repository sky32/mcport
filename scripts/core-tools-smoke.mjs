import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { defaultRuntimeSettingsFromEnv } from '../shared/runtime-repository.js';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate port');
  server.close();
  await once(server, 'close');
  return address.port;
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

async function waitUntil(fn, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition did not become true: ${JSON.stringify(value)}`);
}

const port = await freePort();
if (process.platform === 'darwin') {
  const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  const defaultRuntime = defaultRuntimeSettingsFromEnv({ PATH: finderPath, HOME: '/Users/smoke' });
  if (!defaultRuntime.runtimePath.split(':').includes('/opt/homebrew/bin') || !defaultRuntime.runtimePath.split(':').includes('/usr/local/bin')) {
    throw new Error(`macOS default Runtime PATH was not augmented: ${defaultRuntime.runtimePath}`);
  }
  const explicitRuntime = defaultRuntimeSettingsFromEnv({ PATH: finderPath, HOME: '/Users/smoke', RUNTIME_PATH: '/custom/runtime/bin' });
  if (explicitRuntime.runtimePath !== '/custom/runtime/bin') throw new Error(`Explicit RUNTIME_PATH was overwritten: ${explicitRuntime.runtimePath}`);
}
const root = path.resolve(`data/core-tools-smoke-${process.pid}-${Date.now()}`);
const workspaceRoot = path.join(root, 'workspaces');
const workspace = path.join(workspaceRoot, 'alpha');
await mkdir(path.join(workspace, 'src'), { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Alpha\n\nCore tools smoke.\n', 'utf8');
await writeFile(path.join(workspace, 'src', 'alpha.ts'), `export const alpha = 42;

export function normalize(value: number) {
  return value + 1;
}

export class WorkspaceService {
  save(value: number) {
    return normalize(value);
  }
}

export function updateWorkspace() {
  const service = new WorkspaceService();
  return service.save(alpha);
}
`, 'utf8');
await writeFile(path.join(workspace, 'src', 'beta.ts'), `export function beta(value: string) {
  return value.toUpperCase();
}
`, 'utf8');
await writeFile(path.join(workspace, 'src', 'graph-target.ts'), `export const graphTarget = 7;\n`, 'utf8');
await writeFile(path.join(workspace, 'src', 'graph-source.ts'), `import { graphTarget } from './graph-target.js';\nexport const graphSource = graphTarget;\n`, 'utf8');
await writeFile(path.join(workspace, 'tiny.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Y6sAAAAASUVORK5CYII=', 'base64'));
await mkdir(path.join(workspace, 'release', 'generated-app'), { recursive: true });
await writeFile(path.join(workspace, 'release', 'generated-app', 'package.json'), '{"name":"should-be-ignored"}\n', 'utf8');
git(workspace, 'init');
git(workspace, 'config', 'user.email', 'smoke@example.test');
git(workspace, 'config', 'user.name', 'Smoke');
git(workspace, 'add', '.');
git(workspace, 'commit', '-m', 'initial');

const stateDbPath = path.join(root, 'state.db');
// Simulate a state database created by a Runtime before task baseline/context
// and durable validation operation columns existed. Runtime startup/task access
// must upgrade this database in place rather than fail with a missing column.
const legacyStateDb = new DatabaseSync(stateDbPath);
legacyStateDb.exec(`
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planning','running','validating','blocked','completed','failed','cancelled')),
    acceptance_criteria TEXT NOT NULL,
    steps TEXT NOT NULL,
    expected_paths TEXT NOT NULL,
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
  CREATE TABLE task_validation_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('validate_changes','completion_gate')),
    overall TEXT NOT NULL CHECK(overall IN ('pass','fail')),
    diff_hash TEXT NOT NULL,
    changed_files TEXT NOT NULL,
    stages TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
legacyStateDb.close();

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_AUTH_MODE: 'none',
    MCP_TOOL_TIER: 'full',
    MCP_WORKSPACES: 'alpha',
    WORKSPACE_REGISTRY_JSON: '{}',
    MCP_WORKSPACE_TOOL_TIERS_JSON: '{}',
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: '{}',
    MCP_ADDITIONAL_SERVICES_JSON: '[]',
    ADMIN_ENABLED: 'false',
    WORKSPACE_ROOT: workspaceRoot,
    STATE_DB_PATH: stateDbPath,
    ALLOW_COMMAND_EXECUTION: 'true',
    REQUIRE_HIGH_RISK_CONFIRMATION: 'false',
    ALLOWED_COMMANDS: 'node',
    MAX_COMMAND_OUTPUT_BYTES: '65536',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

const client = new Client({ name: 'core-tools-smoke', version: '1' });
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

try {
  await waitHealth(port);
  await client.connect(transport);

  const info = data(await client.callTool({ name: 'server_info', arguments: {} }));
  if (info.workspace?.name !== 'alpha' || info.workspaceParameterRequired !== false || !Array.isArray(info.lspSupportedLanguages) || !info.lspSupportedLanguages.some((item) => item.kind === 'typescript')) throw new Error(`server_info inference/LSP capability failed: ${JSON.stringify(info)}`);
  if (
    info.onboarding?.policy !== 'once-per-workspace-client-session'
    || info.onboarding?.nextTool !== 'workspace_onboarding'
    || !info.onboarding?.requiredBefore?.includes('project-content-read')
    || !info.onboarding?.repeatWhen?.includes('guidance-may-have-changed')
  ) {
    throw new Error(`server_info onboarding policy failed: ${JSON.stringify(info.onboarding)}`);
  }
  if (info.features?.quickValidation !== true || info.features?.fullValidation !== true || info.features?.safeFileCopy !== true || info.features?.onboardingFingerprint !== true) {
    throw new Error(`server_info feature flags failed: ${JSON.stringify(info.features)}`);
  }
  if (!info.runtime?.generation || !info.runtime?.startedAt || !/^sha256:[a-f0-9]{64}$/.test(info.runtime?.buildFingerprint || '')
      || !(info.tools?.count > 0) || !/^sha256:[a-f0-9]{64}$/.test(info.tools?.fingerprint || '')) {
    throw new Error(`server_info runtime/catalog identity failed: ${JSON.stringify({ runtime: info.runtime, tools: info.tools })}`);
  }
  const fullInfo = data(await client.callTool({ name: 'server_info', arguments: { detail: 'full' } }));
  if (fullInfo.detail !== 'full' || !fullInfo.projectContext || !fullInfo.runtime?.networkIsolation || !fullInfo.features?.lspServers
      || fullInfo.runtime?.generation !== info.runtime?.generation || fullInfo.runtime?.buildFingerprint !== info.runtime?.buildFingerprint
      || !/^[a-f0-9]{7}$/.test(fullInfo.runtime?.sourceGit?.shortCommit || '') || typeof fullInfo.runtime?.sourceGit?.dirty !== 'boolean'
      || fullInfo.projectContext?.contextFiles?.some((file) => file.startsWith('release/'))
      || fullInfo.tools?.fingerprint !== info.tools?.fingerprint) {
    throw new Error(`server_info full detail failed: ${JSON.stringify(fullInfo)}`);
  }
  const surface = data(await client.callTool({ name: 'workspace_context', arguments: {} }));
  if (surface.protocol !== 'mcport.workspace-context.v1' || surface.workspace?.name !== 'alpha'
      || !surface.capabilities?.canWrite || !surface.workflow?.some((item) => item.includes('workspace_context'))
      || surface.nextAction?.tool !== 'task_create') {
    throw new Error(`workspace_context failed: ${JSON.stringify(surface)}`);
  }
  const emptyReview = data(await client.callTool({ name: 'workspace_context', arguments: {} }));
  if (emptyReview.task !== null || emptyReview.review !== null || emptyReview.nextAction?.tool !== 'task_create') {
    throw new Error(`empty workspace_context failed: ${JSON.stringify(emptyReview)}`);
  }
  const unknownOperation = await client.callTool({ name: 'operation_read', arguments: { action: 'get', operationId: 'operation-does-not-exist' } });
  const unknownOperationError = unknownOperation.structuredContent ?? {};
  if (!unknownOperation.isError || unknownOperationError.ok !== false || unknownOperationError.errorCode !== 'TOOL_ERROR'
      || unknownOperationError.phase !== 'handler' || typeof unknownOperationError.retryable !== 'boolean'
      || !String(unknownOperationError.error || '').includes('Unknown operation id')) {
    throw new Error(`operation_read structured error contract failed: ${JSON.stringify(unknownOperation)}`);
  }
  const onboarding = data(await client.callTool({ name: 'workspace_onboarding', arguments: {} }));
  if (
    onboarding.workspace !== 'alpha'
    || !onboarding.guidanceFingerprint?.startsWith('sha256:')
    || onboarding.unchanged !== false
    || !onboarding.files?.some((item) => item.path === 'README.md' && item.text?.includes('# Alpha'))
  ) {
    throw new Error(`workspace_onboarding failed: ${JSON.stringify(onboarding)}`);
  }
  const onboardingReuse = data(await client.callTool({
    name: 'workspace_onboarding',
    arguments: { knownFingerprint: onboarding.guidanceFingerprint },
  }));
  if (
    onboardingReuse.guidanceFingerprint !== onboarding.guidanceFingerprint
    || onboardingReuse.unchanged !== true
    || onboardingReuse.files?.length !== 0
    || onboardingReuse.meta?.matchedKnownFingerprint !== true
  ) {
    throw new Error(`workspace_onboarding fingerprint reuse failed: ${JSON.stringify(onboardingReuse)}`);
  }
  if (onboarding.git?.branch !== 'master' && onboarding.git?.branch !== 'main') throw new Error(`workspace_onboarding git summary failed: ${JSON.stringify(onboarding.git)}`);
  const execEnv = data(await client.callTool({ name: 'check_exec_environment', arguments: {} }));
  if (execEnv.commandExecutionEnabled !== true || !execEnv.allowedCommands?.includes('node')) throw new Error(`exec environment mismatch: ${JSON.stringify(execEnv)}`);
  const workflow = data(await client.callTool({
    name: 'change_apply_and_validate',
    arguments: { operations: [{ op: 'write', path: 'src/workflow.js', content: 'export const workflow = true;\n' }], mode: 'quick' },
  }));
  if (workflow.workflow !== 'change_apply_and_validate' || !workflow.mutation?.mutationId
      || !workflow.validation?.validationOperationId || workflow.validation.overall !== 'pass'
      || workflow.nextAction?.tool !== 'workspace_context') {
    throw new Error(`change workflow failed: ${JSON.stringify(workflow)}`);
  }

  const listedDir = data(await client.callTool({ name: 'list_dir', arguments: { recursive: true, maxDepth: 3 } }));
  if (!listedDir.entries?.some((entry) => entry.path === 'src/alpha.ts')) throw new Error('list_dir missed src/alpha.ts');
  const listedFiles = data(await client.callTool({ name: 'search_files', arguments: { patterns: ['**/*.ts'] } }));
  if (!listedFiles.files?.some((item) => item.path === 'src/alpha.ts') || !listedFiles.files.some((item) => item.path === 'src/beta.ts')) throw new Error(`search_files glob mismatch: ${JSON.stringify(listedFiles)}`);
  const filesPage1 = data(await client.callTool({ name: 'search_files', arguments: { patterns: ['**/*.ts'], maxResults: 1, maxTokens: 256 } }));
  if (filesPage1.files?.length !== 1 || filesPage1.meta?.nextCursor !== 1 || filesPage1.meta?.budgetUsed > 256) throw new Error(`search_files pagination failed: ${JSON.stringify(filesPage1)}`);
  const filesPage2 = data(await client.callTool({ name: 'search_files', arguments: { patterns: ['**/*.ts'], maxResults: 1, cursor: filesPage1.meta.nextCursor, maxTokens: 256 } }));
  if (filesPage2.files?.length !== 1 || filesPage2.files[0].path === filesPage1.files[0].path) throw new Error(`search_files cursor failed: ${JSON.stringify(filesPage2)}`);
  const read = data(await client.callTool({ name: 'read_file', arguments: { path: 'src/alpha.ts' } }));
  if (!read.text?.includes('alpha = 42')) throw new Error('read_file failed');
  const boundedRead = data(await client.callTool({ name: 'read_file', arguments: { path: 'src/alpha.ts', maxTokens: 256 } }));
  if (boundedRead.meta?.budgetUsed > 256 || boundedRead.truncated !== true || !boundedRead.nextStartLine) throw new Error(`read_file hard budget failed: ${JSON.stringify(boundedRead)}`);
  const statAlpha = data(await client.callTool({ name: 'stat_file', arguments: { path: 'src/alpha.ts' } }));
  if (statAlpha.type !== 'file' || !/^[a-f0-9]{64}$/.test(statAlpha.sha256 || '') || statAlpha.encoding !== 'utf-8') {
    throw new Error(`stat_file failed: ${JSON.stringify(statAlpha)}`);
  }
  const searched = data(await client.callTool({ name: 'search_text', arguments: { query: 'alpha\\s*=\\s*42', regex: true, includePatterns: ['**/*.ts'] } }));
  if (searched.matches?.length !== 1) throw new Error(`regex search failed: ${JSON.stringify(searched)}`);
  const searchedFile = data(await client.callTool({ name: 'search_text', arguments: { path: 'src/alpha.ts', query: 'alpha = 42' } }));
  if (searchedFile.matches?.length !== 1 || searchedFile.matches[0].path !== 'src/alpha.ts') throw new Error(`file search failed: ${JSON.stringify(searchedFile)}`);

  const repoMap = data(await client.callTool({
    name: 'repo_map',
    arguments: { focusFiles: ['src/alpha.ts'], focusSymbols: ['WorkspaceService.save'], maxResults: 10, maxSymbolsPerFile: 20 },
  }));
  const mappedFile = repoMap.files?.find((item) => item.path === 'src/alpha.ts');
  if (!mappedFile?.symbols?.some((item) => item.qualifiedName === 'WorkspaceService.save')) {
    throw new Error(`repo_map missed WorkspaceService.save: ${JSON.stringify(repoMap)}`);
  }

  const codeSearch = data(await client.callTool({ name: 'code_search', arguments: { query: 'WorkspaceService.save', mode: 'symbol' } }));
  if (codeSearch.modeUsed !== 'symbol' || !codeSearch.results?.some((item) => item.qualifiedName === 'WorkspaceService.save')) {
    throw new Error(`code_search symbol lookup failed: ${JSON.stringify(codeSearch)}`);
  }

  const symbolRead = data(await client.callTool({ name: 'read_symbol', arguments: { symbol: 'WorkspaceService.save', context: 'dependencies' } }));
  if (!symbolRead.source?.includes('save(value: number)') || symbolRead.source?.includes('updateWorkspace')) {
    throw new Error(`read_symbol did not stay symbol-scoped: ${JSON.stringify(symbolRead)}`);
  }
  if (!symbolRead.calls?.some((item) => item.calleeName === 'normalize')) {
    throw new Error(`read_symbol dependencies missed normalize(): ${JSON.stringify(symbolRead)}`);
  }

  const impact = data(await client.callTool({ name: 'impact_analysis', arguments: { symbol: 'WorkspaceService.save' } }));
  if (!impact.callers?.some((item) => item.callerSymbol === 'updateWorkspace' && item.calleeName === 'save')) {
    throw new Error(`impact_analysis missed updateWorkspace caller: ${JSON.stringify(impact)}`);
  }
  const references = data(await client.callTool({ name: 'find_references', arguments: { symbol: 'WorkspaceService.save', direction: 'both' } }));
  if (!references.references?.some((item) => item.callerSymbol === 'updateWorkspace' && item.calleeName === 'save')) {
    throw new Error(`find_references missed updateWorkspace caller: ${JSON.stringify(references)}`);
  }
  const graph = data(await client.callTool({ name: 'project_graph', arguments: { level: 'file', focus: 'src', depth: 3 } }));
  if (!graph.nodes?.some((item) => item.id === 'src/graph-source.ts') || !graph.edges?.some((item) => item.from === 'src/graph-source.ts' && item.to === 'src/graph-target.ts')) {
    throw new Error(`project_graph missed graph-source -> graph-target import: ${JSON.stringify(graph)}`);
  }
  const image = await client.callTool({ name: 'view_image', arguments: { path: 'tiny.png' } });
  if (image.isError || !image.content?.some((item) => item.type === 'image')) throw new Error('view_image did not return an image content block');
  const tinyStat = data(await client.callTool({ name: 'stat_file', arguments: { path: 'tiny.png' } }));
  const copiedImage = data(await client.callTool({
    name: 'copy_file',
    arguments: { from: 'tiny.png', to: 'tiny-copy.png', expectedSha256: tinyStat.sha256 },
  }));
  if (
    !copiedImage.mutationId
    || !copiedImage.recoveryCheckpoint?.id
    || copiedImage.changeSummary?.changedPathCount !== 1
    || copiedImage.nextActions?.quickValidation?.arguments?.mutationId !== copiedImage.mutationId
    || copiedImage.nextActions?.diff?.arguments?.mutationId !== copiedImage.mutationId
  ) {
    throw new Error(`copy_file mutation metadata failed: ${JSON.stringify(copiedImage)}`);
  }
  const [originalImageBytes, copiedImageBytes] = await Promise.all([
    readFile(path.join(workspace, 'tiny.png')),
    readFile(path.join(workspace, 'tiny-copy.png')),
  ]);
  if (!originalImageBytes.equals(copiedImageBytes)) throw new Error('copy_file did not preserve binary contents');

  const dryPatch = data(await client.callTool({
    name: 'apply_patch',
    arguments: { dryRun: true, operations: [{ op: 'write', path: 'src/new.ts', content: 'export const beta = 7;\n' }] },
  }));
  if (dryPatch.dryRun !== true) throw new Error('apply_patch dry-run failed');
  const appliedPatch = data(await client.callTool({
    name: 'apply_patch',
    arguments: {
      operations: [
        { op: 'write', path: 'src/new.ts', content: 'export const beta = 7;\n' },
        { op: 'replace', path: 'src/alpha.ts', search: '42', replacement: '43', expectedSha256: statAlpha.sha256 },
        { op: 'replace', path: 'src/alpha.ts', search: '43', replacement: '44' },
        { op: 'mkdir', path: 'notes' },
      ],
    },
  }));
  if (!appliedPatch.mutationId || appliedPatch.mutationScope?.id !== appliedPatch.mutationId) {
    throw new Error(`apply_patch mutation scope missing: ${JSON.stringify(appliedPatch)}`);
  }
  const mutationOperation = data(await client.callTool({ name: 'operation_read', arguments: { action: 'get', operationId: appliedPatch.mutationId } }));
  if (mutationOperation.kind !== 'mutation' || mutationOperation.operation?.status !== 'succeeded') {
    throw new Error(`mutation operation registry failed: ${JSON.stringify(mutationOperation)}`);
  }
  const recentOperations = data(await client.callTool({ name: 'operation_read', arguments: { action: 'list', limit: 10 } }));
  if (!recentOperations.operations?.some((operation) => operation.id === appliedPatch.mutationId && operation.kind === 'mutation')) {
    throw new Error(`operation_read list missed mutation: ${JSON.stringify(recentOperations)}`);
  }
  if (appliedPatch.mutationScope?.baselineFiles !== undefined || appliedPatch.mutationScope?.createdAtMs !== undefined) {
    throw new Error(`apply_patch leaked internal mutation baseline/state: ${JSON.stringify(appliedPatch.mutationScope)}`);
  }
  if (
    appliedPatch.changeSummary?.changedPathCount < 2
    || appliedPatch.nextActions?.quickValidation?.arguments?.mutationId !== appliedPatch.mutationId
    || appliedPatch.nextActions?.diff?.arguments?.mutationId !== appliedPatch.mutationId
  ) {
    throw new Error(`apply_patch mutation follow-up metadata failed: ${JSON.stringify(appliedPatch)}`);
  }
  if (appliedPatch.operations?.map((item) => item.op).join(',') !== 'write,replace,replace,mkdir'
      || appliedPatch.operations?.some((item) => item.status !== 'applied')) {
    throw new Error(`apply_patch operation results lost request semantics: ${JSON.stringify(appliedPatch.operations)}`);
  }
  const patched = data(await client.callTool({ name: 'read_file', arguments: { path: 'src/alpha.ts' } }));
  if (!patched.text?.includes('44')) throw new Error('apply_patch sequential replace operations did not compose');
  const mutationDiff = data(await client.callTool({ name: 'git_diff', arguments: { mutationId: appliedPatch.mutationId, mode: 'patch' } }));
  if (!mutationDiff.diff?.includes('44') || !mutationDiff.diff?.includes('src/new.ts')) {
    throw new Error(`mutation-scoped exact diff failed: ${JSON.stringify(mutationDiff)}`);
  }
  const mutationSemanticDiff = data(await client.callTool({ name: 'git_diff', arguments: { mutationId: appliedPatch.mutationId, mode: 'semantic' } }));
  if (
    mutationSemanticDiff.filesChanged < 2
    || !mutationSemanticDiff.files?.some((file) => file.path === 'src/alpha.ts')
    || !mutationSemanticDiff.files?.some((file) => file.path === 'src/new.ts' && file.status === 'added')
  ) {
    throw new Error(`mutation-scoped semantic diff failed: ${JSON.stringify(mutationSemanticDiff)}`);
  }
  const validationClient = new Client({ name: 'core-tools-smoke-validation', version: '1' });
  const validationTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await validationClient.connect(validationTransport);
  const scopedValidation = data(await validationClient.callTool({ name: 'validate_changes', arguments: { mutationId: appliedPatch.mutationId } }));
  try { await validationTransport.terminateSession(); } catch {}
  try { await validationClient.close(); } catch {}
  if (scopedValidation.mode !== 'quick' || scopedValidation.scope?.kind !== 'mutation'
      || scopedValidation.scope?.mutationId !== appliedPatch.mutationId
      || !scopedValidation.changedFiles?.includes('src/alpha.ts')
      || scopedValidation.workspaceChangedFileCount < scopedValidation.changedFileCount
      || !scopedValidation.stages?.some((stage) => stage.name === 'lsp')) {
    throw new Error(`mutation-scoped quick validation failed: ${JSON.stringify(scopedValidation)}`);
  }
  const stalePatch = await client.callTool({
    name: 'apply_patch',
    arguments: {
      operations: [{ op: 'replace', path: 'src/alpha.ts', search: '44', replacement: '45', expectedSha256: statAlpha.sha256 }],
    },
  });
  if (stalePatch.isError !== true || !JSON.stringify(stalePatch.content).includes('SHA256 precondition failed')) {
    throw new Error(`apply_patch stale SHA256 was not rejected: ${JSON.stringify(stalePatch.content)}`);
  }

  data(await client.callTool({ name: 'apply_patch', arguments: { operations: [{ op: 'mkdir', path: 'scratch' }] } }));
  data(await client.callTool({ name: 'apply_patch', arguments: { operations: [{ op: 'write', path: 'scratch/source.txt', content: 'move me\n' }] } }));
  const moveStat = data(await client.callTool({ name: 'stat_file', arguments: { path: 'scratch/source.txt' } }));
  data(await client.callTool({ name: 'apply_patch', arguments: { operations: [{ op: 'move', from: 'scratch/source.txt', to: 'scratch/moved.txt', expectedSha256: moveStat.sha256 }] } }));
  const moved = data(await client.callTool({ name: 'read_file', arguments: { path: 'scratch/moved.txt' } }));
  if (!moved.text?.includes('move me')) throw new Error('apply_patch move failed');
  data(await client.callTool({ name: 'apply_patch', arguments: { operations: [{ op: 'delete', path: 'scratch/moved.txt', expectedSha256: moved.sha256 }] } }));

  const gitStatusResult = data(await client.callTool({ name: 'git_status', arguments: {} }));
  if (!gitStatusResult.entries?.some((line) => line.includes('src/alpha.ts'))) throw new Error(`git_status failed: ${JSON.stringify(gitStatusResult)}`);
  const gitDiffResult = data(await client.callTool({ name: 'git_diff', arguments: { mode: 'patch' } }));
  if (!gitDiffResult.diff?.includes('44')) throw new Error('git_diff failed');
  const semanticDiff = data(await client.callTool({ name: 'git_diff', arguments: { mode: 'semantic' } }));
  if (!semanticDiff.files?.some((item) => item.path === 'src/alpha.ts' && item.symbols?.some((symbol) => symbol.name === 'alpha'))) {
    throw new Error(`git_diff semantic mode missed alpha symbol: ${JSON.stringify(semanticDiff)}`);
  }
  const gitLogResult = data(await client.callTool({ name: 'git_history', arguments: { action: 'log', maxResults: 5 } }));
  if (gitLogResult.commits?.[0]?.subject !== 'initial') throw new Error(`git_history log failed: ${JSON.stringify(gitLogResult)}`);
  const gitShowResult = data(await client.callTool({ name: 'git_history', arguments: { action: 'show', revision: 'HEAD' } }));
  if (gitShowResult.commit?.subject !== 'initial') throw new Error('git_history show failed');
  const gitBlameResult = data(await client.callTool({ name: 'git_history', arguments: { action: 'blame', path: 'README.md', startLine: 1, endLine: 1 } }));
  if (gitBlameResult.entries?.length !== 1) throw new Error(`git_history blame failed: ${JSON.stringify(gitBlameResult)}`);

  const opened = data(await client.callTool({
    name: 'project_history_write',
    arguments: { action: 'open', sessionKey: 'alpha-smoke-session', initialUserInput: 'Please inspect alpha exactly: 你好 👋', title: 'Alpha smoke' },
  }));
  if (!opened.sessionKey || opened.created !== true) throw new Error('project_history_write(open) failed');
  const checkpointArgs = {
    sessionKey: opened.sessionKey,
    turnId: 'smoke-turn',
    rawUserInput: 'Update alpha to 43',
    summary: 'Changed alpha.',
    tests: ['core smoke'],
  };
  const checkpoint1 = data(await client.callTool({ name: 'project_history_write', arguments: { ...checkpointArgs, action: 'checkpoint' } }));
  const duplicate = data(await client.callTool({ name: 'project_history_write', arguments: { ...checkpointArgs, action: 'checkpoint' } }));
  const revision = data(await client.callTool({ name: 'project_history_write', arguments: { ...checkpointArgs, action: 'checkpoint', summary: 'Changed alpha and verified it.' } }));
  if (checkpoint1.revision !== 1 || duplicate.duplicate !== true || revision.revision !== 2) throw new Error('history checkpoint idempotency/revision failed');
  const autoCreatedCheckpoint = data(await client.callTool({
    name: 'project_history_write',
    arguments: { action: 'checkpoint', sessionKey: 'checkpoint-auto-session', turnId: 'first-turn', rawUserInput: 'Create this history session from checkpoint.', summary: 'Auto-created.' },
  }));
  if (autoCreatedCheckpoint.createdSession !== true || autoCreatedCheckpoint.revision !== 1) {
    throw new Error(`history checkpoint did not auto-create session: ${JSON.stringify(autoCreatedCheckpoint)}`);
  }
  const historySearch = data(await client.callTool({ name: 'project_history_read', arguments: { action: 'search', query: 'verified' } }));
  if (!historySearch.matches?.length) throw new Error('project_history_read search failed');
  const historyRead = data(await client.callTool({ name: 'project_history_read', arguments: { action: 'read', sessionKey: opened.sessionKey, maxTokens: 1024 } }));
  if (!historyRead.text?.includes('Alpha smoke')) throw new Error('project_history_read read failed');
  const historyVerify = data(await client.callTool({ name: 'project_history_read', arguments: { action: 'verify' } }));
  if (historyVerify.ok !== true) throw new Error(`project_history_read verify failed: ${JSON.stringify(historyVerify)}`);
  const workspaceStatusAfterRuntimeState = spawnSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' });
  let runtimeStateInWorkspace = false;
  try {
    await access(path.join(workspace, '.remote-workspace-mcp'));
    runtimeStateInWorkspace = true;
  } catch {}
  if (workspaceStatusAfterRuntimeState.status !== 0 || runtimeStateInWorkspace) {
    throw new Error(`MCPort runtime state polluted the Workspace: ${workspaceStatusAfterRuntimeState.stdout || workspaceStatusAfterRuntimeState.stderr}`);
  }

  const quickExec = data(await client.callTool({
    name: 'exec_command',
    arguments: { command: 'node', args: ['-e', "console.log('exec-ok')"], waitMs: 10000 },
  }));
  if (quickExec.running !== false || quickExec.status !== 'succeeded' || quickExec.operationId !== quickExec.id || quickExec.sessionId !== quickExec.id || !quickExec.stdout?.includes('exec-ok')) {
    throw new Error(`exec_command quick completion failed: ${JSON.stringify(quickExec)}`);
  }

  const compactExec = data(await client.callTool({
    name: 'exec_command',
    arguments: {
      command: 'node',
      args: ['-e', "for(let i=0;i<200;i++) console.log('line-'+i+'-'+('x'.repeat(24)))"],
      waitMs: 10000,
      outputMode: 'summary',
      maxTokens: 256,
    },
  }));
  if (compactExec.running !== false || compactExec.meta?.budgetUsed > 256 || compactExec.outputOmitted !== true || !compactExec.next?.sessionId) {
    throw new Error(`exec_command summary budget failed: ${JSON.stringify(compactExec)}`);
  }
  const compactOutput = data(await client.callTool({ name: 'session_control', arguments: { action: 'read', sessionId: compactExec.id, cursor: 0, maxTokens: 256 } }));
  if (!compactOutput.text?.includes('line-0-') || compactOutput.meta?.budgetUsed > 256 || compactOutput.nextCursor === null) {
    throw new Error(`session_control(read) cursor budget failed: ${JSON.stringify(compactOutput)}`);
  }
  const errorsOnly = data(await client.callTool({
    name: 'exec_command',
    arguments: { command: 'node', args: ['-e', "console.log('not-an-error')"], waitMs: 10000, outputMode: 'errors', maxTokens: 256 },
  }));
  if (errorsOnly.stdout !== '' || errorsOnly.stderr !== '') throw new Error(`exec_command errors mode leaked successful stdout: ${JSON.stringify(errorsOnly)}`);

  const interactive = data(await client.callTool({
    name: 'exec_command',
    arguments: {
      command: 'node',
      args: ['-e', "process.stdin.on('data',d=>{process.stdout.write('echo:'+d);if(d.toString().includes('bye'))process.exit(0)})"],
      waitMs: 0,
      timeoutMs: 5000,
    },
  }));
  if (!interactive.id || interactive.running !== true) throw new Error('interactive exec session was not retained');
  const interactiveStatus = data(await client.callTool({ name: 'session_control', arguments: { action: 'status', sessionId: interactive.id } }));
  if (interactiveStatus.status !== 'running' || interactiveStatus.operationId !== interactive.id || interactiveStatus.sessionId !== interactive.id || typeof interactiveStatus.elapsedMs !== 'number') {
    throw new Error(`session_control(status) running failed: ${JSON.stringify(interactiveStatus)}`);
  }
  data(await client.callTool({ name: 'session_control', arguments: { action: 'write', sessionId: interactive.id, data: 'bye\n', close: true } }));
  const output = await waitUntil(
    () => client.callTool({ name: 'session_control', arguments: { action: 'read', sessionId: interactive.id, stream: 'stdout' } }).then(data),
    (value) => value.running === false && value.text?.includes('echo:bye'),
  );
  if (!output.text.includes('echo:bye')) throw new Error('session_control(write/read) failed');

  const longRunning = data(await client.callTool({
    name: 'exec_command',
    arguments: { command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], waitMs: 0, timeoutMs: 10000 },
  }));
  if (!longRunning.id || longRunning.running !== true) throw new Error('long exec session was not retained');
  const killed = data(await client.callTool({ name: 'session_control', arguments: { action: 'kill', sessionId: longRunning.id } }));
  if (killed.running !== false) throw new Error(`session_control(kill) failed: ${JSON.stringify(killed)}`);
  const killedStatus = data(await client.callTool({ name: 'session_control', arguments: { action: 'status', sessionId: longRunning.id } }));
  if (killedStatus.status !== 'cancelled' || killedStatus.processState !== 'exited') throw new Error(`session_control(status) cancelled failed: ${JSON.stringify(killedStatus)}`);

  await writeFile(path.join(workspace, 'preexisting-dirty.txt'), 'dirty before task creation\n', 'utf8');
  const createdTask = data(await client.callTool({
    name: 'task_create',
    arguments: {
      goal: 'Adjust alpha and keep the workspace green',
      acceptanceCriteria: [{ description: 'node gate probe exits 0', kind: 'command', command: 'node', args: ['-e', "console.log('gate-ok')"] }],
      steps: [{ description: 'Patch alpha' }, { description: 'Verify' }],
      expectedPaths: ['src'],
      status: 'running',
    },
  }));
  if (!createdTask.task?.id || createdTask.task.status !== 'running' || createdTask.task.acceptanceCriteria[0].id !== 'c1'
      || !createdTask.task.baselineChangedFiles?.includes('preexisting-dirty.txt')) {
    throw new Error(`task_create baseline failed: ${JSON.stringify(createdTask)}`);
  }
  const taskReview = data(await client.callTool({ name: 'workspace_context', arguments: {} }));
  if (taskReview.task?.id !== createdTask.task.id || taskReview.review?.readyForCompletion !== false
      || taskReview.nextAction?.tool !== 'validate_changes') {
    throw new Error(`workspace_context active task failed: ${JSON.stringify(taskReview)}`);
  }
  await writeFile(path.join(workspace, 'UI.png'), Buffer.from('external-ui-reference'), 'utf8');
  const validationBeforeAck = data(await client.callTool({ name: 'validate_changes', arguments: { detail: 'full' } }));
  if (validationBeforeAck.overall !== 'fail' || !validationBeforeAck.unexpectedFiles?.includes('UI.png')) {
    throw new Error(`validate_changes did not detect external change: ${JSON.stringify(validationBeforeAck)}`);
  }
  const acknowledgedTask = data(await client.callTool({
    name: 'task_update',
    arguments: { taskId: createdTask.task.id, acknowledgeExternalPaths: ['UI.png'], reason: 'User-added UI reference file' },
  }));
  if (!acknowledgedTask.task?.acknowledgedExternalPaths?.includes('UI.png') || acknowledgedTask.task?.expectedPaths?.includes('UI.png')) {
    throw new Error(`task external change acknowledgement polluted expectedPaths: ${JSON.stringify(acknowledgedTask)}`);
  }
  const validation = data(await client.callTool({ name: 'validate_changes', arguments: { detail: 'full' } }));
  const syntaxStage = validation.stages?.find((stage) => stage.name === 'syntax');
  if (validation.overall !== 'pass' || syntaxStage?.status !== 'pass' || !validation.changedFiles?.includes('src/alpha.ts')) {
    throw new Error(`validate_changes failed: ${JSON.stringify(validation)}`);
  }
  if (validation.detail !== 'full' || validation.taskId !== createdTask.task.id || !validation.validationRunId || !validation.validationOperationId || validation.unexpectedFileCount !== 0
      || !validation.expectedTaskChangedFiles?.includes('src/alpha.ts') || !validation.knownExternalChangedFiles?.includes('UI.png')
      || !validation.knownExternalChangedFiles?.includes('preexisting-dirty.txt')) {
    throw new Error(`validate_changes task classification failed: ${JSON.stringify(validation)}`);
  }
  if (typeof validation.lspCheckedCount !== 'number' || typeof validation.lspSkippedCount !== 'number' || !Array.isArray(validation.lspSkippedFiles)) {
    throw new Error(`validate_changes structured LSP summary failed: ${JSON.stringify(validation)}`);
  }
  if (validation.workspaceChangedFilesIncluded !== false || 'workspaceChangedFiles' in validation) {
    throw new Error(`validate_changes should omit workspace file names by default: ${JSON.stringify(validation)}`);
  }
  if (validation.completion?.ready !== true || validation.completion?.nextAction?.tool !== 'task_update') {
    throw new Error(`validate_changes did not expose completion readiness: ${JSON.stringify(validation.completion)}`);
  }
  const readyReview = data(await client.callTool({ name: 'workspace_context', arguments: { taskId: createdTask.task.id } }));
  if (readyReview.review?.readyForCompletion !== true || readyReview.review?.readyToAttemptCompletion !== true
      || readyReview.review?.latestCompletionGatePassed !== false || readyReview.review?.validationFresh !== true
      || readyReview.nextAction?.tool !== 'task_update' || readyReview.nextAction?.arguments?.status !== 'completed') {
    throw new Error(`workspace_context completion semantics failed: ${JSON.stringify(readyReview)}`);
  }
  const validationWithWorkspaceFiles = data(await client.callTool({ name: 'validate_changes', arguments: { mode: 'quick', detail: 'summary', includeWorkspaceFiles: true } }));
  if (validationWithWorkspaceFiles.detail !== 'summary' || validationWithWorkspaceFiles.workspaceChangedFilesIncluded !== true
      || !Array.isArray(validationWithWorkspaceFiles.workspaceChangedFiles) || !validationWithWorkspaceFiles.workspaceChangedFiles.includes('src/alpha.ts')
      || 'expectedTaskChangedFiles' in validationWithWorkspaceFiles || 'knownExternalChangedFiles' in validationWithWorkspaceFiles) {
    throw new Error(`validate_changes summary/includeWorkspaceFiles failed: ${JSON.stringify(validationWithWorkspaceFiles)}`);
  }

  const alphaBeforeStaleGate = await readFile(path.join(workspace, 'src', 'alpha.ts'), 'utf8');
  await writeFile(path.join(workspace, 'src', 'alpha.ts'), `${alphaBeforeStaleGate}\n// stale completion gate probe\n`, 'utf8');
  const staleCompletion = data(await client.callTool({
    name: 'task_update',
    arguments: { taskId: createdTask.task.id, status: 'completed' },
  }));
  if (staleCompletion.completed !== false || staleCompletion.task?.status === 'completed'
      || !staleCompletion.completionGate?.blockingReasons?.some((item) => item.code === 'VALIDATION_STALE_OR_FAILED')) {
    throw new Error(`completion gate did not explain stale validation: ${JSON.stringify(staleCompletion)}`);
  }
  const staleGateRun = staleCompletion.task?.recentValidationRuns?.find?.((run) => run.kind === 'completion_gate');
  if (staleGateRun && !staleGateRun.stages?.some((stage) => stage.name === 'validation_freshness' && stage.status === 'fail')) {
    throw new Error(`completion gate stale guard stage missing: ${JSON.stringify(staleCompletion)}`);
  }
  const revalidation = data(await client.callTool({ name: 'validate_changes', arguments: { detail: 'full' } }));
  if (revalidation.overall !== 'pass' || revalidation.completion?.ready !== true) {
    throw new Error(`revalidation after stale gate failed: ${JSON.stringify(revalidation)}`);
  }

  const completedTask = data(await client.callTool({
    name: 'task_update',
    arguments: { taskId: createdTask.task.id, status: 'completed', completeStepIds: ['s1', 's2'], appendObservation: 'alpha updated and validated' },
  }));
  if (completedTask.completed !== true || completedTask.completionGate?.passed !== true || !completedTask.completionGate?.operationId || completedTask.task?.status !== 'completed') {
    throw new Error(`completion gate failed: ${JSON.stringify(completedTask)}`);
  }
  const taskAfter = data(await client.callTool({ name: 'workspace_context', arguments: { taskId: createdTask.task.id } }));
  const persistedGate = taskAfter.recentValidationRuns?.find((run) => run.kind === 'completion_gate');
  if (taskAfter.detail !== 'summary' || taskAfter.task?.status !== 'completed' || !persistedGate?.operationId
      || !['validation_freshness', 'unexpected_files', 'task_context'].every((name) => persistedGate.stages?.some((stage) => stage.name === name && stage.status === 'pass'))
      || typeof taskAfter.task?.changedFileCount !== 'number' || 'changedFiles' in taskAfter.task
      || taskAfter.recentValidationRuns.some((run) => 'changedFiles' in run || typeof run.changedFileCount !== 'number')
      || taskAfter.task?.acceptanceCriteria?.[0]?.status !== 'verified'
      || taskAfter.task?.acceptanceCriteria?.[0]?.lastVerification?.status !== 'pass'
      || 'satisfied' in (taskAfter.task?.acceptanceCriteria?.[0] || {})) {
    throw new Error(`workspace_context task compact view failed: ${JSON.stringify(taskAfter)}`);
  }
  const taskAfterFull = data(await client.callTool({ name: 'workspace_context', arguments: { taskId: createdTask.task.id, detail: 'full' } }));
  if (taskAfterFull.detail !== 'full' || !Array.isArray(taskAfterFull.task?.changedFiles) || !Array.isArray(taskAfterFull.task?.expectedPaths)
      || !taskAfterFull.task?.acknowledgedExternalPaths?.includes('UI.png')
      || !taskAfterFull.task?.baselineContext?.head || !taskAfterFull.task?.baselineContext?.branch
      || !taskAfterFull.recentValidationRuns?.every((run) => Array.isArray(run.changedFiles))) {
    throw new Error(`workspace_context task full view failed: ${JSON.stringify(taskAfterFull)}`);
  }

  await writeFile(path.join(workspace, 'baseline-external.txt'), 'baseline one\n', 'utf8');
  const driftTask = data(await client.callTool({
    name: 'task_create',
    arguments: {
      goal: 'Detect task context drift',
      acceptanceCriteria: [{ description: 'node gate probe exits 0', kind: 'command', command: 'node', args: ['-e', "process.exit(0)"] }],
      expectedPaths: ['src'],
      status: 'running',
    },
  }));
  if (!driftTask.task?.baselineContext?.head || !driftTask.task?.baselineChangedFiles?.includes('baseline-external.txt')) {
    throw new Error(`task baseline context missing: ${JSON.stringify(driftTask)}`);
  }
  await writeFile(path.join(workspace, 'baseline-external.txt'), 'baseline changed after task creation\n', 'utf8');
  git(workspace, 'commit', '--allow-empty', '-m', 'external head drift');
  const driftReview = data(await client.callTool({ name: 'workspace_context', arguments: { taskId: driftTask.task.id, detail: 'full' } }));
  if (driftReview.review?.taskContext?.status !== 'drifted'
      || !driftReview.review.taskContext.reasons?.includes('head_changed')
      || !driftReview.review.taskContext.reasons?.includes('baseline_files_changed')
      || !driftReview.review.taskContext.baselineFileChanges?.includes('baseline-external.txt')
      || driftReview.nextAction?.tool !== 'task_update' || driftReview.nextAction?.arguments?.status !== 'cancelled') {
    throw new Error(`task context drift detection failed: ${JSON.stringify(driftReview)}`);
  }
  data(await client.callTool({ name: 'task_update', arguments: { taskId: driftTask.task.id, status: 'cancelled' } }));

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'server_info_workspace_inference', 'server_info_runtime_catalog_identity', 'server_info_runtime_git_identity', 'context_ignores_release_artifacts', 'workspace_context', 'operation_read', 'structured_tool_error_contract', 'change_apply_and_validate', 'check_exec_environment',
      ...(process.platform === 'darwin' ? ['macos_runtime_path_augmented', 'explicit_runtime_path_preserved'] : []),
      'list_dir', 'search_files_glob', 'search_files_cursor_budget', 'stat_file_sha256', 'read_file', 'read_file_hard_budget', 'search_text_regex',
      'repo_map_symbols', 'code_search_symbol', 'read_symbol_dependencies', 'impact_analysis_callers', 'find_references_both', 'project_graph_file_imports', 'view_image',
      'apply_patch_dry_run', 'apply_patch_write_replace_mkdir', 'apply_patch_sequential_replace', 'apply_patch_operation_results', 'apply_patch_mutation_scope', 'mutation_scope_cross_mcp_session', 'validate_changes_quick_scope_lsp', 'apply_patch_expected_sha256_conflict',
      'git_status', 'git_diff_patch', 'git_diff_semantic_symbols', 'git_history',
      'project_history_open_named_session', 'project_history_checkpoint_idempotency', 'project_history_revision', 'project_history_checkpoint_auto_create',
      'project_history_read', 'project_history_external_storage',
      'exec_command_quick', 'exec_command_summary_budget', 'exec_command_errors_mode', 'exec_command_session', 'session_control_status_running', 'session_control_write', 'session_control_read_cursor_budget', 'session_control_kill', 'session_control_status_cancelled',
      'task_create', 'task_dirty_baseline', 'task_baseline_context', 'task_context_drift', 'task_review_completion_semantics', 'task_external_change_acknowledgement', 'validate_changes_change_classification', 'validate_changes_structured_lsp', 'validate_changes_syntax_scope', 'validate_changes_compact_workspace_context', 'validate_changes_workspace_files_opt_in', 'validate_changes_completion_ready', 'completion_gate_stale_reason', 'completion_gate_guard_evidence', 'completion_gate_pass', 'task_command_criterion_verified',
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
