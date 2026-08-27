import type { DatabaseSync } from 'node:sqlite';

export type RuntimeSettings = {
  runtimePath: string;
  allowedCommands: string[];
  allowCommandExecution: boolean;
  allowExternalNetwork: boolean;
  requireHighRiskConfirmation: boolean;
  highRiskConfirmationMode: 'local' | 'none';
  networkIsolationRequired: boolean;
  lspEnabled: boolean;
  lspRequestTimeoutMs: number;
  lspTypeScriptCommand: string;
  lspHtmlCommand: string;
  lspCssCommand: string;
  lspCustomServers: string;
  maxFileBytes: number;
  maxCommandOutputBytes: number;
  defaultCommandTimeoutMs: number;
  maxCommandTimeoutMs: number;
};

export type RuntimeProfile = {
  id: string;
  name: string;
  runtimePath: string | null;
  allowedCommands: string[] | null;
  allowCommandExecution: boolean | null;
  allowExternalNetwork: boolean | null;
  requireHighRiskConfirmation: boolean | null;
  highRiskConfirmationMode: 'local' | 'none' | null;
  maxCommandOutputBytes: number | null;
  defaultCommandTimeoutMs: number | null;
  maxCommandTimeoutMs: number | null;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeProfileInput = Partial<Omit<RuntimeProfile, 'id' | 'createdAt' | 'updatedAt'>>;
export const PREVIOUS_DEFAULT_ALLOWED_COMMANDS: readonly string[];
export const DEFAULT_ALLOWED_COMMANDS: readonly string[];
export const RUNTIME_KEYS: Readonly<Record<keyof RuntimeSettings, string>>;
export function defaultRuntimeSettingsFromEnv(env?: NodeJS.ProcessEnv): RuntimeSettings;
export function initializeRuntimeDatabase(db: DatabaseSync): void;
export function openRuntimeDatabase(dbPath: string, defaults?: RuntimeSettings): Promise<RuntimeRepository>;
export function normalizeRuntimeSettings(input: Partial<RuntimeSettings>, current: RuntimeSettings): RuntimeSettings;

export class RuntimeRepository {
  protected readonly db: DatabaseSync;
  protected readonly defaults: RuntimeSettings;
  constructor(db: DatabaseSync, defaults: RuntimeSettings);
  close(): void;
  getRuntimeSettings(): RuntimeSettings;
  updateRuntimeSettings(input: Partial<RuntimeSettings>): RuntimeSettings;
  replaceRuntimeSettings(input: RuntimeSettings): RuntimeSettings;
  resetRuntimeSettings(): RuntimeSettings;
  revokeOAuthProviderIssuer(issuer: string): number;
  listRuntimeProfiles(): RuntimeProfile[];
  getRuntimeProfile(id: string): RuntimeProfile | null;
  createRuntimeProfile(input: RuntimeProfileInput): RuntimeProfile;
  updateRuntimeProfile(id: string, input: RuntimeProfileInput): RuntimeProfile;
  deleteRuntimeProfile(id: string): void;
  assignWorkspaceProfile(workspace: string, profileId: string | null): RuntimeProfile | null;
  getWorkspaceProfile(workspace: string): RuntimeProfile | null;
  listWorkspaceProfileAssignments(): Array<{ workspace: string; profileId: string; profileName: string }>;
  listAssignments(): Array<{ workspace: string; profile: { id: string; name: string } | null }>;
}
