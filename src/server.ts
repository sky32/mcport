import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { loadConfig, type McpServiceDefinition } from './config.js';
import { handleAdminRequest } from './admin.js';
import { createMcpAuth } from './auth.js';
import { ProcessManager } from './runtime.js';
import { createConfigStore } from './store.js';
import { buildMcpServer, buildMcpToolCatalog } from './tools.js';
import { LspManager } from './lsp.js';
import { resolveConfiguredWorkspace } from './workspaces.js';
import { getOperationStore } from './operation-store.js';
import { listLocalConfirmations, resolveLocalConfirmation } from './local-confirmations.js';
import { acknowledgeOAuthInteractionNotice, listOAuthInteractionNotices } from './oauth-interaction-notices.js';
import { installRuntimeControlHandler } from './runtime-control.js';
import { applicationVersion } from './version.js';

const config = loadConfig();
await mkdir(config.workspaceRoot, { recursive: true });
const configStore = await createConfigStore(config);
const operationStore = await getOperationStore(
  config.stateDbPath,
  process.env.RUNTIME_INSTANCE_ID?.trim() || `runtime_${randomUUID()}`,
);
const brandIcon = await readFile(fileURLToPath(new URL('../resources/icons/MCPort-Icon.png', import.meta.url)));

function workspaceFromPublicPath(pathname: string): string | null {
  const direct = /^\/w\/([^/]+)(?:\/|$)/.exec(pathname);
  const protectedMetadata = /^\/\.well-known\/oauth-protected-resource\/w\/([^/]+)\/mcp$/.exec(pathname);
  const authorizationMetadata = /^\/\.well-known\/oauth-authorization-server\/w\/([^/]+)$/.exec(pathname);
  const raw = direct?.[1] ?? protectedMetadata?.[1] ?? authorizationMetadata?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function publicWorkspaceMcpPath(workspace: string): string {
  return `/w/${encodeURIComponent(workspace)}/mcp`;
}

function publicWorkspaceHealthPath(workspace: string): string {
  return `/w/${encodeURIComponent(workspace)}/healthz`;
}

function isLoopbackHostHeader(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.trim().toLowerCase();
  return host === 'localhost'
    || host.startsWith('localhost:')
    || host === '127.0.0.1'
    || host.startsWith('127.0.0.1:')
    || host === '[::1]'
    || host.startsWith('[::1]:');
}

function requestPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://mcp.local').pathname;
  } catch {
    return '/';
  }
}

async function createServiceRuntime(service: McpServiceDefinition) {
  const serviceConfig = service.id === 'default'
    ? config
    : {
        ...config,
        host: service.host,
        port: service.port,
        publicUrl: service.publicUrl || config.publicUrl,
      };
  const mcpAuth = await createMcpAuth(serviceConfig, configStore, service.toolTier);
  const processManager = new ProcessManager(operationStore);
  const lspManager = new LspManager();
  const handlerForService = (targetService: McpServiceDefinition, targetAuth = mcpAuth) => {
    const gatewayJsonOnly = config.gatewayJsonOnly && targetService.id.startsWith('gateway:');
    const factory = () => buildMcpServer({
      config,
      configStore,
      service: targetService,
      auth: targetAuth,
      processManager,
      operationStore,
      lspManager,
    });
    if (!gatewayJsonOnly) return toNodeHandler(createMcpHandler(factory));

    const modernHandler = createMcpHandler(factory, { responseMode: 'json', legacy: 'reject' });
    const jsonOnlyHandler: typeof modernHandler = {
      ...modernHandler,
      fetch: async (request, requestOptions) => {
        const parsedBody = requestOptions?.parsedBody ?? (
          request.method.toUpperCase() === 'POST'
            ? await request.clone().json().catch(() => undefined)
            : undefined
        );
        const legacy = await isLegacyRequest(request, parsedBody);
        if (!legacy) {
          const modernMessage = parsedBody && !Array.isArray(parsedBody) && typeof parsedBody === 'object'
            ? parsedBody as { id?: unknown; method?: unknown }
            : null;
          if (modernMessage?.method === 'subscriptions/listen') {
            return Response.json({
              jsonrpc: '2.0',
              id: modernMessage.id ?? null,
              error: {
                code: -32601,
                message: 'SSE subscriptions are disabled on this JSON-only public gateway',
              },
            });
          }
          return modernHandler.fetch(request, requestOptions);
        }
        if (request.method.toUpperCase() !== 'POST') {
          return Response.json({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32000,
              message: 'SSE streams are disabled on this JSON-only public gateway',
            },
          }, { status: 405, headers: { Allow: 'POST' } });
        }
        const product = factory();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await product.connect(transport);
        try {
          return await transport.handleRequest(request, parsedBody === undefined
            ? requestOptions
            : { ...requestOptions, parsedBody });
        } finally {
          await transport.close().catch(() => {});
          await product.close().catch(() => {});
        }
      },
    };
    return toNodeHandler(jsonOnlyHandler);
  };
  const nodeHandler = handlerForService(service);
  const toolCatalog = service.admin
    ? buildMcpToolCatalog({ config, configStore, service, auth: mcpAuth, processManager, operationStore, lspManager })
    : [];
  const gatewayEntries = service.id === 'default'
    ? new Map(await Promise.all(Object.entries(config.gatewayWorkspaceAuth).map(async ([route, authSpec]) => {
        const workspace = authSpec.workspace || route;
        const gatewayService: McpServiceDefinition = {
          ...service,
          id: `gateway:${route}`,
          name: `workspace:${workspace}`,
          admin: false,
          path: publicWorkspaceMcpPath(route),
          publicUrl: authSpec.mode === 'oauth_builtin' ? authSpec.audience : '',
          workspaceAllowlist: [workspace],
          toolTier: config.workspaceToolTiers[workspace] ?? 'full',
        };
        const gatewayAuth = await createMcpAuth({
          ...serviceConfig,
          authMode: authSpec.mode,
          apiToken: authSpec.mode === 'token' ? authSpec.token : '',
          publicUrl: gatewayService.publicUrl,
          oauthRequiredScopes: authSpec.mode === 'oauth_builtin' ? authSpec.scopes : ['mcp'],
          builtinOauthWorkspace: authSpec.mode === 'oauth_builtin' ? authSpec.workspace : '',
          builtinOauthPrivateJwk: authSpec.mode === 'oauth_builtin' ? JSON.stringify(authSpec.privateJwk) : '',
          builtinOauthAuthorizationSecretHash: authSpec.mode === 'oauth_builtin' ? authSpec.authorizationSecretHash : '',
        }, configStore, gatewayService.toolTier);
        return [route, {
          handler: handlerForService(gatewayService, gatewayAuth),
          auth: gatewayAuth,
          service: gatewayService,
        }] as const;
      })))
    : new Map<string, {
        handler: ReturnType<typeof toNodeHandler>;
        auth: typeof mcpAuth;
        service: McpServiceDefinition;
      }>();
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']).has(service.host);
  const validateHost = config.allowedHosts.length ? hostHeaderValidation(config.allowedHosts) : localhostHostValidation();
  const validateOrigin = config.allowedOrigins.length
    ? originValidation(config.allowedOrigins)
    : loopback
      ? localhostOriginValidation()
      : undefined;

  const httpServer = createServer((req, res) => {
    void (async () => {
      const pathname = requestPathname(req);
      const httpTrace = process.env.MCP_HTTP_TRACE === '1';
      const startedAt = Date.now();
      if (httpTrace) {
        res.once('finish', () => {
          console.error(`[http] ${req.method ?? 'UNKNOWN'} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms`);
        });
      }
      const isPublicGatewayRequest = service.id === 'default' && !isLoopbackHostHeader(req.headers.host);
      if (pathname === '/icon.png' || pathname === '/favicon.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
        res.end(brandIcon);
        return;
      }
      const publicWorkspace = isPublicGatewayRequest ? workspaceFromPublicPath(pathname) : null;
      const gatewayEntry = publicWorkspace ? gatewayEntries.get(publicWorkspace) : undefined;
      if (isPublicGatewayRequest && !gatewayEntry) {
        res.writeHead(404).end();
        return;
      }
      if (
        (!gatewayEntry && pathname === '/healthz')
        || (gatewayEntry && publicWorkspace && pathname === publicWorkspaceHealthPath(publicWorkspace))
      ) {
        const healthService = gatewayEntry?.service ?? service;
        const workspace = healthService.workspaceAllowlist?.length === 1 ? healthService.workspaceAllowlist[0] : '';
        let workspaceReady = true;
        let workspaceError = '';
        if (workspace) {
          try {
            await resolveConfiguredWorkspace(config, workspace);
          } catch (error) {
            workspaceReady = false;
            workspaceError = error instanceof Error ? error.message : String(error);
          }
        }
        res.writeHead(workspaceReady ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          ok: workspaceReady,
          service: 'mcport',
          version: applicationVersion(),
          instanceId: process.env.RUNTIME_INSTANCE_ID ?? '',
          serviceId: healthService.id,
          serviceName: healthService.name,
          mcpPath: healthService.path,
          workspace: workspace || null,
          workspaceReady,
          ...(workspaceError ? { workspaceError } : {}),
        }));
        return;
      }
      if (gatewayEntry) {
        if (await gatewayEntry.auth.handleMetadata(req, res)) return;
      } else if (await mcpAuth.handleMetadata(req, res)) return;
      if (pathname.startsWith('/admin')) {
        if (config.adminLocalOnly && !isLoopbackHostHeader(req.headers.host)) {
          res.writeHead(404).end();
          return;
        }
        if (!service.admin) {
          res.writeHead(404).end();
          return;
        }
        if (!validateHost(req, res)) return;
        if (validateOrigin && !validateOrigin(req, res)) return;
        await handleAdminRequest(req, res, { config, store: configStore, toolCatalog });
        return;
      }
      const expectedMcpPath = gatewayEntry?.service.path ?? service.path;
      if (pathname !== expectedMcpPath) {
        res.writeHead(404).end();
        return;
      }
      if (!validateHost(req, res)) return;
      if (validateOrigin && !validateOrigin(req, res)) return;
      if (gatewayEntry) {
        if (!(await gatewayEntry.auth.authenticate(req, res))) return;
        await gatewayEntry.handler(req, res);
        return;
      }
      if (!(await mcpAuth.authenticate(req, res))) return;
      await nodeHandler(req, res);
    })().catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  return { service, httpServer, processManager, lspManager, toolCatalog };
}

const serviceRuntimes = await Promise.all(config.mcpServices.map(createServiceRuntime));
for (const { service, httpServer } of serviceRuntimes) {
  httpServer.listen(service.port, service.host, () => {
    console.error(`${service.name} [${service.id}] listening on http://${service.host}:${service.port}${service.path}`);
  });
}

installRuntimeControlHandler(async (method, params) => {
  if (method === 'health') {
    const requestedServiceId = typeof params.serviceId === 'string' ? params.serviceId : 'default';
    const target = serviceRuntimes.find(({ service }) => service.id === requestedServiceId);
    if (!target) throw new Error(`Unknown Runtime service: ${requestedServiceId}`);
    const workspace = target.service.workspaceAllowlist?.length === 1 ? target.service.workspaceAllowlist[0] : '';
    let workspaceReady = true;
    let workspaceError = '';
    if (workspace) {
      try {
        await resolveConfiguredWorkspace(config, workspace);
      } catch (error) {
        workspaceReady = false;
        workspaceError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      ok: workspaceReady,
      service: 'mcport',
      version: applicationVersion(),
      instanceId: process.env.RUNTIME_INSTANCE_ID ?? '',
      serviceId: target.service.id,
      serviceName: target.service.name,
      workspace: workspace || null,
      workspaceReady,
      ...(workspaceError ? { workspaceError } : {}),
    };
  }
  if (method === 'tool_catalog') {
    const target = serviceRuntimes.find(({ service }) => service.id === 'default');
    const workspace = typeof params.workspace === 'string' ? params.workspace.trim() : '';
    const toolTier = workspace ? (config.workspaceToolTiers[workspace] ?? 'full') : (target?.service.toolTier ?? 'full');
    const tools = (target?.toolCatalog ?? []).map((entry) => ({
      ...entry,
      exposedToModel: entry.tiers.includes(toolTier),
    }));
    return {
      ok: true,
      workspace: workspace || null,
      toolTier,
      exposedCount: tools.filter((entry) => entry.exposedToModel).length,
      catalogCount: tools.length,
      tools,
    };
  }
  if (method === 'local_confirmations') {
    const token = String(params.token ?? '');
    if (!config.localConfirmationToken || token !== config.localConfirmationToken) throw new Error('local_confirmation_unauthorized');
    return { ok: true, confirmations: listLocalConfirmations() };
  }
  if (method === 'local_confirmation_decision') {
    const token = String(params.token ?? '');
    if (!config.localConfirmationToken || token !== config.localConfirmationToken) throw new Error('local_confirmation_unauthorized');
    const id = String(params.id ?? '');
    const approved = params.approved;
    if (typeof approved !== 'boolean') throw new Error('approved boolean required');
    if (!resolveLocalConfirmation(id, approved)) throw new Error('confirmation_not_found_or_already_resolved');
    return { ok: true, id, approved };
  }
  if (method === 'oauth_interactions') {
    const token = String(params.token ?? '');
    if (!config.localConfirmationToken || token !== config.localConfirmationToken) throw new Error('oauth_interaction_unauthorized');
    return { ok: true, interactions: listOAuthInteractionNotices() };
  }
  if (method === 'oauth_interaction_ack') {
    const token = String(params.token ?? '');
    if (!config.localConfirmationToken || token !== config.localConfirmationToken) throw new Error('oauth_interaction_unauthorized');
    const id = String(params.id ?? '');
    if (!acknowledgeOAuthInteractionNotice(id)) throw new Error('oauth_interaction_not_found_or_already_acknowledged');
    return { ok: true, id };
  }
  throw new Error(`Unsupported Runtime control method: ${method}`);
});

const smokeExitAfterMs = Number(process.env.RUNTIME_SMOKE_EXIT_AFTER_MS ?? 0);
if (Number.isFinite(smokeExitAfterMs) && smokeExitAfterMs > 0) {
  const timer = setTimeout(() => process.exit(91), smokeExitAfterMs);
  timer.unref();
}

let shuttingDown = false;
async function shutdownRuntime(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all(serviceRuntimes.map(async ({ httpServer, processManager, lspManager }) => {
    await processManager.stopAll('SIGTERM');
    lspManager.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }));
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdownRuntime().finally(() => process.exit(0));
  });
}
