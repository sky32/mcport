import path from 'node:path';
import {
  additionalServicesSchema,
  gatewayWorkspaceAuthSchema,
  parseJsonWithSchema,
  toolTierSchema,
  workspaceAllowlistSchema,
  workspaceRegistrySchema,
  workspaceToolTiersSchema,
} from '../shared/schemas.js';
import { DEFAULT_ALLOWED_COMMANDS } from '../shared/runtime-repository.js';

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export type GatewayWorkspaceAuth =
  | { mode: 'token'; token: string; workspace?: string }
  | {
      mode: 'oauth_builtin';
      workspace: string;
      audience: string;
      scopes: string[];
      privateJwk: Record<string, unknown>;
      authorizationSecretHash: string;
    };

export type ToolTier = 'readonly' | 'standard' | 'full';

function normalizeGatewayJsonOnly(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error('MCP_GATEWAY_JSON_ONLY must be true/false or 1/0');
}

function normalizeToolTier(value: unknown, label = 'Tool tier'): ToolTier {
  const parsed = toolTierSchema.safeParse(String(value ?? 'full').trim().toLowerCase());
  if (!parsed.success) throw new Error(`${label} must be readonly, standard, or full`);
  return parsed.data;
}

function parseWorkspaceToolTiers(raw: string | undefined): Record<string, ToolTier> {
  if (!raw?.trim()) return {};
  return parseJsonWithSchema(raw, workspaceToolTiersSchema, 'MCP_WORKSPACE_TOOL_TIERS_JSON');
}

function parseGatewayWorkspaceAuth(raw: string | undefined): Record<string, GatewayWorkspaceAuth> {
  if (!raw?.trim()) return {};
  return parseJsonWithSchema(raw, gatewayWorkspaceAuthSchema, 'MCP_GATEWAY_WORKSPACE_AUTH_JSON') as Record<string, GatewayWorkspaceAuth>;
}

export type McpServiceDefinition = {
  id: string;
  name: string;
  host: string;
  port: number;
  path: string;
  admin: boolean;
  publicUrl: string;
  workspaceAllowlist: string[] | null;
  toolTier: ToolTier;
};

function parseWorkspaceRegistry(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const parsed = parseJsonWithSchema(raw, workspaceRegistrySchema, 'WORKSPACE_REGISTRY_JSON');
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const resolved = path.resolve(value);
    if (!path.isAbsolute(resolved)) throw new Error(`Workspace path must be absolute: ${name}`);
    result[name] = resolved;
  }
  return result;
}

function normalizeWorkspaceAllowlist(value: unknown, label: string): string[] | null {
  if (value === null || value === undefined) return null;
  const parsed = workspaceAllowlistSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${label}: ${parsed.error.issues[0]?.message ?? 'invalid workspace list'}`);
  return parsed.data;
}

function normalizeServicePath(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : '/mcp';
  if (!raw.startsWith('/')) throw new Error('MCP service path must start with /');
  if (raw.includes('?') || raw.includes('#')) throw new Error('MCP service path must not contain query or fragment');
  return raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function parseAdditionalServices(
  raw: string | undefined,
  defaults: { host: string; authMode: 'none' | 'token' | 'oauth_builtin'; allowedHosts: string[]; adminToken: string },
): McpServiceDefinition[] {
  if (!raw?.trim()) return [];
  const parsed = parseJsonWithSchema(raw, additionalServicesSchema, 'MCP_ADDITIONAL_SERVICES_JSON');

  const seenIds = new Set<string>();
  const seenListeners = new Set<string>();
  return parsed.map((item) => {
    const id = String(item.id);
    if (id === 'default' || seenIds.has(id)) throw new Error(`Duplicate MCP service id: ${id}`);
    seenIds.add(id);

    const host = typeof item.host === 'string' && item.host.trim() ? item.host.trim() : defaults.host;
    const port = Number(item.port);
    const listenerKey = `${host}:${port}`;
    if (seenListeners.has(listenerKey)) throw new Error(`Duplicate MCP service listener: ${listenerKey}`);
    seenListeners.add(listenerKey);

    const loopback = new Set(['127.0.0.1', 'localhost', '::1']).has(host);
    const admin = item.admin === true;
    if (!loopback && defaults.allowedHosts.length === 0) {
      throw new Error(`MCP_ALLOWED_HOSTS is required for non-loopback MCP service ${id}`);
    }
    if (!loopback && defaults.authMode === 'none') {
      throw new Error(`MCP service ${id} cannot use MCP_AUTH_MODE=none on a non-loopback host`);
    }
    if (!loopback && admin && !defaults.adminToken) {
      throw new Error(`ADMIN_TOKEN is required when MCP service ${id} exposes Admin on a non-loopback host`);
    }

    const publicUrl = typeof item.publicUrl === 'string' ? item.publicUrl.trim() : '';
    if (defaults.authMode === 'oauth_builtin' && !publicUrl) {
      throw new Error(`MCP service ${id} requires publicUrl when MCP_AUTH_MODE=oauth_builtin`);
    }
    if (publicUrl) {
      const parsedUrl = new URL(publicUrl);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error(`MCP service ${id} publicUrl must use http or https`);
      if (parsedUrl.username || parsedUrl.password) throw new Error(`MCP service ${id} publicUrl must not include userinfo`);
    }

    return {
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      host,
      port,
      path: normalizeServicePath(item.path),
      admin,
      publicUrl,
      workspaceAllowlist: normalizeWorkspaceAllowlist(item.workspaces, `MCP service ${id}`),
      toolTier: normalizeToolTier(item.toolTier, `MCP service ${id} toolTier`),
    };
  });
}

function authModeEnv(value: string | undefined, loopback: boolean, hasToken: boolean): 'none' | 'token' | 'oauth_builtin' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return hasToken ? 'token' : loopback ? 'none' : 'token';
  if (normalized === 'none' || normalized === 'token' || normalized === 'oauth_builtin') return normalized;
  throw new Error('MCP_AUTH_MODE must be none, token, or oauth_builtin');
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export type Config = ReturnType<typeof loadConfig> & { localConfirmationToken: string };

export function loadConfig() {
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const allowedHosts = csv(process.env.MCP_ALLOWED_HOSTS);
  const apiToken = process.env.MCP_API_TOKEN?.trim() ?? '';
  const adminEnabled = boolEnv('ADMIN_ENABLED', true);
  const adminToken = process.env.ADMIN_TOKEN?.trim() ?? '';
  const adminLocalOnly = boolEnv('ADMIN_LOCAL_ONLY', false);
  const loopback = new Set(['127.0.0.1', 'localhost', '::1']).has(host);
  const authMode = authModeEnv(process.env.MCP_AUTH_MODE, loopback, Boolean(apiToken));

  if (!loopback && allowedHosts.length === 0) {
    throw new Error('MCP_ALLOWED_HOSTS is required when MCP_HOST is non-loopback');
  }
  if (!loopback && authMode === 'none') {
    throw new Error('MCP_AUTH_MODE=none is only allowed on loopback');
  }
  if (authMode === 'token' && !apiToken) {
    throw new Error('MCP_API_TOKEN is required when MCP_AUTH_MODE=token');
  }
  if (!loopback && adminEnabled && !adminToken) {
    throw new Error('ADMIN_TOKEN is required when ADMIN_ENABLED=true and MCP_HOST is non-loopback');
  }

  const defaultTimeoutMs = intEnv('DEFAULT_COMMAND_TIMEOUT_MS', 30_000);
  const maxTimeoutMs = intEnv('MAX_COMMAND_TIMEOUT_MS', 600_000);
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error('DEFAULT_COMMAND_TIMEOUT_MS must be <= MAX_COMMAND_TIMEOUT_MS');
  }

  const publicUrl = process.env.MCP_PUBLIC_URL?.trim() ?? '';
  if (authMode === 'oauth_builtin' && !publicUrl) {
    throw new Error('MCP_PUBLIC_URL is required when MCP_AUTH_MODE uses OAuth');
  }

  const additionalServices = parseAdditionalServices(process.env.MCP_ADDITIONAL_SERVICES_JSON, {
    host,
    authMode,
    allowedHosts,
    adminToken,
  });
  const defaultService: McpServiceDefinition = {
    id: 'default',
    name: 'mcport',
    host,
    port: intEnv('MCP_PORT', 8787),
    path: '/mcp',
    admin: adminEnabled,
    publicUrl,
    toolTier: normalizeToolTier(process.env.MCP_TOOL_TIER || 'full', 'MCP_TOOL_TIER'),
    workspaceAllowlist: (() => {
      const names = csv(process.env.MCP_WORKSPACES);
      return names.length ? normalizeWorkspaceAllowlist(names, 'Default MCP service') : null;
    })(),
  };
  for (const service of additionalServices) {
    if (service.host === defaultService.host && service.port === defaultService.port) {
      throw new Error(`MCP additional service ${service.id} conflicts with the default listener ${service.host}:${service.port}`);
    }
  }

  return {
    host,
    port: defaultService.port,
    authMode,
    apiToken,
    publicUrl,
    oauthRequiredScopes: csv(process.env.OAUTH_REQUIRED_SCOPES || 'mcp'),
    oauthAllowInsecureIssuer: boolEnv('OAUTH_ALLOW_INSECURE_ISSUER', false),
    builtinOauthWorkspace: process.env.BUILTIN_OAUTH_WORKSPACE?.trim() ?? '',
    builtinOauthPrivateJwk: process.env.BUILTIN_OAUTH_PRIVATE_JWK?.trim() ?? '',
    builtinOauthAuthorizationSecretHash: process.env.BUILTIN_OAUTH_AUTHORIZATION_SECRET_HASH?.trim() ?? '',
    adminEnabled,
    adminToken,
    adminLocalOnly,
    localConfirmationToken: process.env.LOCAL_CONFIRMATION_TOKEN?.trim() ?? '',
    allowedHosts,
    allowedOrigins: csv(process.env.MCP_ALLOWED_ORIGINS),
    workspaceRoot: path.resolve(process.env.WORKSPACE_ROOT ?? './workspaces'),
    workspaceRegistry: parseWorkspaceRegistry(process.env.WORKSPACE_REGISTRY_JSON),
    workspaceToolTiers: parseWorkspaceToolTiers(process.env.MCP_WORKSPACE_TOOL_TIERS_JSON),
    gatewayWorkspaceAuth: parseGatewayWorkspaceAuth(process.env.MCP_GATEWAY_WORKSPACE_AUTH_JSON),
    gatewayJsonOnly: normalizeGatewayJsonOnly(process.env.MCP_GATEWAY_JSON_ONLY),
    stateDbPath: path.resolve(process.env.STATE_DB_PATH ?? './data/state.db'),
    runtimePath: process.env.RUNTIME_PATH ?? process.env.PATH ?? '',
    allowedCommands: new Set(
      csv(process.env.ALLOWED_COMMANDS || DEFAULT_ALLOWED_COMMANDS.join(',')),
    ),
    allowCommandExecution: boolEnv('ALLOW_COMMAND_EXECUTION', false),
    allowExternalNetwork: boolEnv('ALLOW_EXTERNAL_NETWORK', false),
    requireHighRiskConfirmation: boolEnv('REQUIRE_HIGH_RISK_CONFIRMATION', true),
    highRiskConfirmationMode: (process.env.HIGH_RISK_CONFIRMATION_MODE?.trim().toLowerCase() === 'none' || !boolEnv('REQUIRE_HIGH_RISK_CONFIRMATION', true) ? 'none' : 'local') as 'local' | 'none',
    networkIsolationRequired: boolEnv('NETWORK_ISOLATION_REQUIRED', true),
    lspEnabled: boolEnv('LSP_ENABLED', true),
    lspRequestTimeoutMs: intEnv('LSP_REQUEST_TIMEOUT_MS', 8_000),
    lspTypeScriptCommand: process.env.LSP_TYPESCRIPT_COMMAND?.trim() || 'typescript-language-server',
    lspHtmlCommand: process.env.LSP_HTML_COMMAND?.trim() || 'vscode-html-language-server',
    lspCssCommand: process.env.LSP_CSS_COMMAND?.trim() || 'vscode-css-language-server',
    lspCustomServers: process.env.LSP_CUSTOM_SERVERS?.trim() || '[]',
    lspManagedRoot: process.env.MCP_LSP_MANAGED_ROOT?.trim() || '',
    maxCheckpointBytes: intEnv('MAX_CHECKPOINT_BYTES', 64 * 1024 * 1024),
    maxFileBytes: intEnv('MAX_FILE_BYTES', 2 * 1024 * 1024),
    maxCommandOutputBytes: intEnv('MAX_COMMAND_OUTPUT_BYTES', 256 * 1024),
    defaultCommandTimeoutMs: defaultTimeoutMs,
    maxCommandTimeoutMs: maxTimeoutMs,
    mcpServices: [defaultService, ...additionalServices],
  };
}
