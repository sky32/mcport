import { z } from 'zod/v4';

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const workspaceNameSchema = z.string().trim().refine(
  (value) => WORKSPACE_NAME.test(value) && value !== '.' && value !== '..',
  'Workspace name must use letters, digits, dot, underscore, or hyphen',
);

export const toolTierSchema = z.enum(['readonly', 'standard', 'full']);
export const workspaceToolTiersSchema = z.record(workspaceNameSchema, toolTierSchema);
export const workspaceAllowlistSchema = z.array(workspaceNameSchema).transform((items) => [...new Set(items)].sort());
export const positiveIntegerSchema = z.number().int().positive();
export const portSchema = z.number().int().min(1).max(65535);
export const plainCommandSchema = z.string().trim().min(1).refine(
  (value) => !value.includes('/') && !value.includes('\\'),
  'Command must be a plain executable name',
);

export const highRiskConfirmationModeSchema = z.enum(['local', 'none']);

export const runtimeSettingsShape = {
  runtimePath: z.string().trim().min(1),
  allowedCommands: z.array(plainCommandSchema).transform((items) => [...new Set(items)].sort()),
  allowCommandExecution: z.boolean(),
  allowExternalNetwork: z.boolean().default(false),
  requireHighRiskConfirmation: z.boolean().default(true),
  highRiskConfirmationMode: highRiskConfirmationModeSchema.default('local'),
  networkIsolationRequired: z.boolean().default(true),
  lspEnabled: z.boolean().default(true),
  lspRequestTimeoutMs: positiveIntegerSchema.default(8_000),
  lspTypeScriptCommand: z.string().trim().min(1).default('typescript-language-server'),
  lspHtmlCommand: z.string().trim().min(1).default('vscode-html-language-server'),
  lspCssCommand: z.string().trim().min(1).default('vscode-css-language-server'),
  lspCustomServers: z.string().trim().default('[]'),
  maxFileBytes: positiveIntegerSchema,
  maxCommandOutputBytes: positiveIntegerSchema,
  defaultCommandTimeoutMs: positiveIntegerSchema,
  maxCommandTimeoutMs: positiveIntegerSchema,
};

export const runtimeSettingsSchema = z.object(runtimeSettingsShape).superRefine((value, ctx) => {
  if (value.defaultCommandTimeoutMs > value.maxCommandTimeoutMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultCommandTimeoutMs'],
      message: 'defaultCommandTimeoutMs must be <= maxCommandTimeoutMs',
    });
  }
});

export const runtimeSettingsPatchSchema = z.object({
  runtimePath: runtimeSettingsShape.runtimePath.optional(),
  allowedCommands: runtimeSettingsShape.allowedCommands.optional(),
  allowCommandExecution: runtimeSettingsShape.allowCommandExecution.optional(),
  allowExternalNetwork: runtimeSettingsShape.allowExternalNetwork.optional(),
  requireHighRiskConfirmation: runtimeSettingsShape.requireHighRiskConfirmation.optional(),
  highRiskConfirmationMode: runtimeSettingsShape.highRiskConfirmationMode.optional(),
  networkIsolationRequired: runtimeSettingsShape.networkIsolationRequired.optional(),
  lspEnabled: runtimeSettingsShape.lspEnabled.optional(),
  lspRequestTimeoutMs: runtimeSettingsShape.lspRequestTimeoutMs.optional(),
  lspTypeScriptCommand: runtimeSettingsShape.lspTypeScriptCommand.optional(),
  lspHtmlCommand: runtimeSettingsShape.lspHtmlCommand.optional(),
  lspCssCommand: runtimeSettingsShape.lspCssCommand.optional(),
  lspCustomServers: runtimeSettingsShape.lspCustomServers.optional(),
  maxFileBytes: runtimeSettingsShape.maxFileBytes.optional(),
  maxCommandOutputBytes: runtimeSettingsShape.maxCommandOutputBytes.optional(),
  defaultCommandTimeoutMs: runtimeSettingsShape.defaultCommandTimeoutMs.optional(),
  maxCommandTimeoutMs: runtimeSettingsShape.maxCommandTimeoutMs.optional(),
});

export const runtimeProfilePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  runtimePath: z.union([z.string().trim().min(1), z.null()]).optional(),
  allowedCommands: z.union([z.array(plainCommandSchema).transform((items) => [...new Set(items)].sort()), z.null()]).optional(),
  allowCommandExecution: z.boolean().nullable().optional(),
  allowExternalNetwork: z.boolean().nullable().optional(),
  requireHighRiskConfirmation: z.boolean().nullable().optional(),
  highRiskConfirmationMode: highRiskConfirmationModeSchema.nullable().optional(),
  maxCommandOutputBytes: positiveIntegerSchema.nullable().optional(),
  defaultCommandTimeoutMs: positiveIntegerSchema.nullable().optional(),
  maxCommandTimeoutMs: positiveIntegerSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  if (
    typeof value.defaultCommandTimeoutMs === 'number'
    && typeof value.maxCommandTimeoutMs === 'number'
    && value.defaultCommandTimeoutMs > value.maxCommandTimeoutMs
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultCommandTimeoutMs'],
      message: 'defaultCommandTimeoutMs must be <= maxCommandTimeoutMs',
    });
  }
});

export const workspaceServiceSchema = z.object({
  workspace: workspaceNameSchema,
  enabled: z.boolean().default(true),
  port: portSchema,
  publicEnabled: z.boolean().default(false),
  publicPath: workspaceNameSchema.optional(),
  publicAuthMode: z.enum(['token', 'oauth']).default('oauth'),
  toolTier: toolTierSchema.default('full'),
}).passthrough();

export const gatewayTokenAuthSchema = z.object({
  mode: z.literal('token'),
  token: z.string().trim().min(1),
  workspace: workspaceNameSchema.optional(),
});

export const gatewayBuiltinOAuthSchema = z.object({
  mode: z.literal('oauth_builtin'),
  workspace: workspaceNameSchema,
  audience: z.string().trim().url(),
  scopes: z.array(z.string().trim().min(1)).default(['mcp']).transform((items) => [...new Set(items)]),
  privateJwk: z.record(z.string(), z.unknown()),
  authorizationSecretHash: z.string().trim().min(1),
});

export const gatewayWorkspaceAuthSchema = z.record(
  workspaceNameSchema,
  z.union([gatewayTokenAuthSchema, gatewayBuiltinOAuthSchema]),
);
export const workspaceRegistrySchema = z.record(workspaceNameSchema, z.string().trim().min(1));

export const additionalServiceSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  name: z.string().trim().min(1).optional(),
  host: z.string().trim().min(1).optional(),
  port: portSchema,
  path: z.string().trim().default('/mcp'),
  admin: z.boolean().default(false),
  publicUrl: z.string().trim().default(''),
  workspaces: z.array(workspaceNameSchema).nullable().optional(),
  toolTier: toolTierSchema.default('full'),
}).passthrough();

export const additionalServicesSchema = z.array(additionalServiceSchema);

export function parseJsonWithSchema(raw, schema, label) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path?.length ? ` at ${issue.path.join('.')}` : '';
    throw new Error(`${label}${at}: ${issue?.message ?? 'invalid value'}`);
  }
  return parsed.data;
}
