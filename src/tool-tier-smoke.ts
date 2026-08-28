import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

async function freePort(): Promise<number> {
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

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Service ${port} did not become healthy`);
}

async function inspect(port: number, options: { url?: string; token?: string; hostHeader?: string } = {}) {
  const client = new Client({ name: 'tool-tier-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(options.url || `http://127.0.0.1:${port}/mcp`), {
    ...(options.token ? { requestInit: { headers: { Authorization: `Bearer ${options.token}` } } } : {}),
    ...(options.hostHeader ? {
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const target = new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url);
        const headers = new Headers(init?.headers);
        headers.set('host', options.hostHeader!);
        return new Promise<Response>((resolve, reject) => {
          const request = httpRequest({
            hostname: '127.0.0.1',
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: init?.method || 'GET',
            headers: Object.fromEntries(headers.entries()),
            signal: init?.signal ?? undefined,
          }, (response) => {
            resolve(new Response(Readable.toWeb(response) as ReadableStream, {
              status: response.statusCode || 500,
              statusText: response.statusMessage,
              headers: response.headers as HeadersInit,
            }));
          });
          request.once('error', reject);
          if (typeof init?.body === 'string' || init?.body instanceof Uint8Array) request.write(init.body);
          request.end();
        });
      },
    } : {}),
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const info = await client.callTool({ name: 'server_info', arguments: {} });
    const payload = info.structuredContent as { service?: { toolTier?: string } } | undefined;
    return {
      tier: payload?.service?.toolTier ?? '',
      tools: new Map(listed.tools.map((tool) => [tool.name, tool])),
      client,
      transport,
    };
  } catch (error) {
    try { await transport.terminateSession(); } catch {}
    await client.close();
    throw error;
  }
}

function expectHas(tools: Map<string, unknown>, names: string[], label: string): void {
  for (const name of names) if (!tools.has(name)) throw new Error(`${label} should expose ${name}`);
}

function expectMissing(tools: Map<string, unknown>, names: string[], label: string): void {
  for (const name of names) if (tools.has(name)) throw new Error(`${label} must not expose ${name}`);
}

const readonlyNames = [
  'server_info', 'workspace_onboarding', 'lsp_query', 'check_exec_environment',
  'stat_file', 'read_file', 'list_dir', 'search_files', 'search_text', 'view_image',
  'repo_map', 'code_search', 'read_symbol', 'find_references', 'impact_analysis', 'project_graph',
  'git_status', 'git_diff', 'git_history',
  'project_history_read',
  'checkpoint_read',
  'workspace_context', 'operation_read',
];
const writeNames = [
  'apply_patch', 'copy_file', 'import_file',
  'checkpoint_write',
  'project_history_write',
  'task_create', 'task_update', 'validate_changes', 'change_apply_and_validate',
];
const executeNames = ['exec_command', 'session_control', 'operation_recovery', 'computer_use'];
const removedWorkspaceNames = ['workspace_list', 'workspace_info', 'workspace_create'];

const fullPort = await freePort();
const readonlyPort = await freePort();
const standardPort = await freePort();
const corePort = await freePort();
const root = path.resolve(`data/tool-tier-smoke-${process.pid}-${Date.now()}`);
const workspaceRoot = path.join(root, 'workspaces');
const traceFile = path.join(root, 'tool-traces.ndjson');
await mkdir(path.join(workspaceRoot, 'workspace-a'), { recursive: true });
await writeFile(path.join(workspaceRoot, 'workspace-a', 'hello.txt'), 'hello tool tier\n', 'utf8');
await writeFile(path.join(workspaceRoot, 'workspace-a', 'asset.bin'), Buffer.from([0, 255, 1, 2, 3, 128, 10]));

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(fullPort),
    MCP_AUTH_MODE: 'none',
    MCP_TOOL_TIER: 'full',
    ADMIN_ENABLED: 'true',
    WORKSPACE_ROOT: workspaceRoot,
    STATE_DB_PATH: path.join(root, 'state.db'),
    MCP_TRACE_MODE: 'detailed',
    MCP_TRACE_FILE: traceFile,
    COMPUTER_USE_ENABLED: 'true',
    COMPUTER_USE_PUBLIC_ENABLED: 'true',
    MCP_ADDITIONAL_SERVICES_JSON: JSON.stringify([
      {
        id: 'readonly', name: 'readonly', host: '127.0.0.1', port: readonlyPort,
        path: '/mcp', workspaces: ['workspace-a'], toolTier: 'readonly',
      },
      {
        id: 'standard', name: 'standard', host: '127.0.0.1', port: standardPort,
        path: '/mcp', workspaces: ['workspace-a'], toolTier: 'standard',
      },
      {
        id: 'core', name: 'core', host: '127.0.0.1', port: corePort,
        path: '/mcp', workspaces: ['workspace-a'], toolTier: 'full',
      },
    ]),
    MCP_ALLOWED_HOSTS: ['127.0.0.1', 'localhost', 'localtest.me', ...[fullPort, readonlyPort, standardPort, corePort].flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`]), `localtest.me:${fullPort}`].join(','),
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: JSON.stringify({
      'workspace-a': { mode: 'token', token: 'computer-use-public-smoke-token', workspace: 'workspace-a' },
    }),
    MCP_WORKSPACE_TOOL_TIERS_JSON: JSON.stringify({ 'workspace-a': 'full' }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
let full: Awaited<ReturnType<typeof inspect>> | null = null;
let readonly: Awaited<ReturnType<typeof inspect>> | null = null;
let standard: Awaited<ReturnType<typeof inspect>> | null = null;
let core: Awaited<ReturnType<typeof inspect>> | null = null;
let publicGateway: Awaited<ReturnType<typeof inspect>> | null = null;

try {
  await Promise.all([waitForHealth(fullPort), waitForHealth(readonlyPort), waitForHealth(standardPort), waitForHealth(corePort)]);
  [full, readonly, standard, core, publicGateway] = await Promise.all([
    inspect(fullPort),
    inspect(readonlyPort),
    inspect(standardPort),
    inspect(corePort),
    inspect(fullPort, { url: `http://localtest.me:${fullPort}/w/workspace-a/mcp`, hostHeader: `localtest.me:${fullPort}`, token: 'computer-use-public-smoke-token' }),
  ]);

  if (full.tier !== 'full' || readonly.tier !== 'readonly' || standard.tier !== 'standard' || core.tier !== 'full') {
    throw new Error(`server_info tool tier mismatch: ${full.tier}/${readonly.tier}/${standard.tier}/${core.tier}`);
  }
  if (core.tools.size !== full.tools.size) throw new Error(`Tool tier exposure mismatch: ${core.tools.size}/${full.tools.size}`);
  if (!publicGateway.tools.has('computer_use') || publicGateway.tools.size !== full.tools.size) {
    throw new Error(`Public Gateway must expose explicitly enabled Computer Use: ${publicGateway.tools.size}/${full.tools.size}`);
  }

  expectHas(readonly.tools, readonlyNames, 'readonly');
  expectMissing(readonly.tools, [...writeNames, ...executeNames, ...removedWorkspaceNames], 'readonly');
  expectHas(standard.tools, [...readonlyNames, ...writeNames], 'standard');
  expectMissing(standard.tools, [...executeNames, ...removedWorkspaceNames], 'standard');
  const importTool = standard.tools.get('import_file') as { inputSchema?: { properties?: Record<string, unknown>; required?: string[] }; _meta?: Record<string, unknown> } | undefined;
  const importProperties = importTool?.inputSchema?.properties ?? {};
  if (!importProperties.sourceFile) throw new Error('import_file must expose top-level sourceFile input');
  for (const removedInput of ['operation', 'sourceUrl', 'sourcePath', 'sourceBase64', 'filename', 'mimeType', 'size', 'sha256']) {
    if (removedInput in importProperties) throw new Error(`import_file must not expose removed input ${removedInput}`);
  }
  if (!importTool?.inputSchema?.required?.includes('sourceFile')) {
    throw new Error('import_file sourceFile must be required');
  }
  const fileParams = importTool?._meta?.['openai/fileParams'];
  if (!Array.isArray(fileParams) || fileParams.length !== 1 || fileParams[0] !== 'sourceFile') {
    throw new Error(`import_file must advertise sourceFile via openai/fileParams: ${JSON.stringify(importTool?._meta)}`);
  }
  expectHas(full.tools, [...readonlyNames, ...writeNames, ...executeNames], 'full');
  expectMissing(full.tools, removedWorkspaceNames, 'full');

  if (
    readonly.tools.size !== readonlyNames.length
    || standard.tools.size !== readonlyNames.length + writeNames.length
    || full.tools.size !== readonlyNames.length + writeNames.length + executeNames.length
  ) {
    throw new Error(`Unexpected tool counts: readonly=${readonly.tools.size} standard=${standard.tools.size} full=${full.tools.size}`);
  }

  const catalogResponse = await fetch(`http://127.0.0.1:${fullPort}/admin/api/tool-catalog`);
  if (!catalogResponse.ok) throw new Error(`Tool Catalog admin endpoint failed: ${catalogResponse.status}`);
  const catalogPayload = await catalogResponse.json() as { tools?: Array<{ name?: string; description?: string; tiers?: string[] }> };
  const catalog = Array.isArray(catalogPayload.tools) ? catalogPayload.tools : [];
  const catalogByName = new Map(catalog.map((tool) => [tool.name ?? '', tool]));
  const expectedCatalogNames = new Set([...readonlyNames, ...writeNames, ...executeNames]);
  if (catalog.length !== expectedCatalogNames.size || [...expectedCatalogNames].some((name) => !catalogByName.has(name))) {
    throw new Error(`Tool Catalog drifted from tools/list: ${JSON.stringify(catalog.map((tool) => tool.name))}`);
  }
  for (const name of expectedCatalogNames) {
    const entry = catalogByName.get(name);
    if (!entry || typeof entry.description !== 'string' || !entry.description.trim()) {
      throw new Error(`Tool Catalog entry ${name} must expose a description`);
    }
    const expectedTiers = [
      ...(readonlyNames.includes(name) ? ['readonly', 'standard', 'full'] : []),
      ...(writeNames.includes(name) ? ['standard', 'full'] : []),
      ...(executeNames.includes(name) ? ['full'] : []),
    ];
    if (JSON.stringify(entry.tiers) !== JSON.stringify(expectedTiers)) {
      throw new Error(`Tool Catalog tiers mismatch for ${name}: ${JSON.stringify(entry.tiers)} expected ${JSON.stringify(expectedTiers)}`);
    }
  }

  for (const [name, tool] of full.tools) {
    const annotations = (tool as { annotations?: Record<string, boolean> }).annotations;
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (typeof annotations?.[key] !== 'boolean') throw new Error(`${name} must advertise ${key}`);
    }
  }
  for (const name of readonlyNames) {
    const annotations = (readonly.tools.get(name) as { annotations?: { readOnlyHint?: boolean } })?.annotations;
    if (annotations?.readOnlyHint !== true) throw new Error(`${name} must advertise readOnlyHint=true`);
  }
  for (const name of writeNames) {
    const annotations = (standard.tools.get(name) as { annotations?: { readOnlyHint?: boolean } })?.annotations;
    if (annotations?.readOnlyHint !== false) throw new Error(`${name} must advertise readOnlyHint=false`);
  }
  const commandAnnotations = (full.tools.get('exec_command') as { annotations?: { openWorldHint?: boolean } })?.annotations;
  if (commandAnnotations?.openWorldHint !== true) throw new Error('exec_command must advertise openWorldHint=true');

  const firstOnboarding = await readonly.client.callTool({ name: 'workspace_onboarding', arguments: {} });
  const firstOnboardingPayload = firstOnboarding.structuredContent as { guidanceFingerprint?: string; unchanged?: boolean } | undefined;
  if (!firstOnboardingPayload?.guidanceFingerprint?.startsWith('sha256:') || firstOnboardingPayload.unchanged !== false) {
    throw new Error(`workspace_onboarding must return a guidance fingerprint: ${JSON.stringify(firstOnboarding.structuredContent)}`);
  }
  const secondOnboarding = await readonly.client.callTool({
    name: 'workspace_onboarding',
    arguments: { knownFingerprint: firstOnboardingPayload.guidanceFingerprint },
  });
  const secondOnboardingPayload = secondOnboarding.structuredContent as { guidanceFingerprint?: string; unchanged?: boolean; files?: unknown[] } | undefined;
  if (
    secondOnboardingPayload?.guidanceFingerprint !== firstOnboardingPayload.guidanceFingerprint
    || secondOnboardingPayload.unchanged !== true
    || secondOnboardingPayload.files?.length !== 0
  ) {
    throw new Error(`workspace_onboarding fingerprint reuse failed: ${JSON.stringify(secondOnboarding.structuredContent)}`);
  }

  const assetStat = await standard.client.callTool({ name: 'stat_file', arguments: { path: 'asset.bin' } });
  const assetStatPayload = assetStat.structuredContent as { sha256?: string } | undefined;
  if (!assetStatPayload?.sha256) throw new Error(`stat_file did not return asset sha256: ${JSON.stringify(assetStat.structuredContent)}`);
  const copied = await standard.client.callTool({
    name: 'copy_file',
    arguments: { from: 'asset.bin', to: 'copied.bin', expectedSha256: assetStatPayload.sha256 },
  });
  const copiedPayload = copied.structuredContent as {
    mutationId?: string;
    recoveryCheckpoint?: { id?: string };
    nextActions?: { quickValidation?: { arguments?: { mutationId?: string } }; diff?: { arguments?: { mutationId?: string } } };
  } | undefined;
  if (
    !copiedPayload?.mutationId
    || !copiedPayload.recoveryCheckpoint?.id
    || copiedPayload.nextActions?.quickValidation?.arguments?.mutationId !== copiedPayload.mutationId
    || copiedPayload.nextActions?.diff?.arguments?.mutationId !== copiedPayload.mutationId
  ) {
    throw new Error(`copy_file did not return mutation follow-up metadata: ${JSON.stringify(copied.structuredContent)}`);
  }
  const [sourceBytes, copiedBytes] = await Promise.all([
    readFile(path.join(workspaceRoot, 'workspace-a', 'asset.bin')),
    readFile(path.join(workspaceRoot, 'workspace-a', 'copied.bin')),
  ]);
  if (!sourceBytes.equals(copiedBytes)) throw new Error('copy_file did not preserve binary file contents');

  const standardQuickValidation = await standard.client.callTool({ name: 'validate_changes', arguments: { mode: 'quick' } });
  const standardQuickPayload = standardQuickValidation.structuredContent as { ok?: boolean; mode?: string } | undefined;
  if (standardQuickPayload?.ok !== true || standardQuickPayload.mode !== 'quick') {
    throw new Error(`standard quick validation failed: ${JSON.stringify(standardQuickValidation.structuredContent)}`);
  }
  const standardFullValidation = await standard.client.callTool({ name: 'validate_changes', arguments: { mode: 'full' } });
  const standardFullPayload = standardFullValidation.structuredContent as { blocked?: boolean; policy?: string } | undefined;
  if (standardFullPayload?.blocked !== true || standardFullPayload.policy !== 'full-validation-requires-command-execution') {
    throw new Error(`standard full validation must be blocked: ${JSON.stringify(standardFullValidation.structuredContent)}`);
  }

  const implicitWorkspaceRead = await readonly.client.callTool({ name: 'read_file', arguments: { path: 'hello.txt' } });
  if (!JSON.stringify(implicitWorkspaceRead.structuredContent).includes('hello tool tier')) {
    throw new Error(`Single-workspace service did not infer workspace: ${JSON.stringify(implicitWorkspaceRead.structuredContent)}`);
  }
  const readonlyReadSchema = (readonly.tools.get('read_file') as { inputSchema?: { properties?: Record<string, unknown> } })?.inputSchema;
  if (readonlyReadSchema?.properties && 'workspace' in readonlyReadSchema.properties) {
    throw new Error(`Single-Workspace tool schema should omit workspace: ${JSON.stringify(readonlyReadSchema)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const traces = (await readFile(traceFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const readTrace = traces.find((item) => item.tool === 'read_file' && item.workspace === 'workspace-a');
  if (!readTrace || readTrace.status !== 'ok' || typeof readTrace.durationMs !== 'number' || !readTrace.arguments?.path) {
    throw new Error(`Detailed Tool Trace missing expected fields: ${JSON.stringify(traces.slice(-5))}`);
  }

  console.log(JSON.stringify({
    ok: true,
    counts: { readonly: readonly.tools.size, standard: standard.tools.size, full: full.tools.size, core: core.tools.size },
    checks: [
      'readonly_tool_surface',
      'standard_tool_surface',
      'full_tool_surface',
      'computer_use_public_opt_in',
      'server_info_tool_tier',
      'readonly_annotations',
      'write_annotations',
      'all_tools_have_complete_annotations',
      'tool_catalog_matches_actual_registered_tools',
      'tool_catalog_descriptions_and_tiers',
      'workspace_catalog_removed',
      'single_workspace_parameter_inferred',
      'single_workspace_schema_omits_workspace',
      'tool_trace_detailed_redacted_metrics',
      'exec_command_open_world_annotation',
      'workspace_onboarding_fingerprint_reuse',
      'standard_binary_safe_copy_file',
      'standard_https_import_file_schema',
      'standard_host_file_import',
      'standard_quick_validation',
      'standard_full_validation_blocked',
    ],
  }, null, 2));
} finally {
  for (const inspected of [full, readonly, standard, core, publicGateway]) {
    if (!inspected) continue;
    try { await inspected.transport.terminateSession(); } catch {}
    try { await inspected.client.close(); } catch {}
  }
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0) throw new Error(`Tool tier child exited with ${child.exitCode}: ${stderr}`);
}
