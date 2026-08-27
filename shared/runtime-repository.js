import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimeProfilePatchSchema, runtimeSettingsPatchSchema, runtimeSettingsSchema } from './schemas.js';

export const PREVIOUS_DEFAULT_ALLOWED_COMMANDS = Object.freeze([
  'cargo', 'cmd', 'eslint', 'git', 'go', 'gradle', 'gradlew', 'make', 'mvn', 'mvnw', 'mypy', 'node', 'npm', 'npx',
  'pnpm', 'powershell', 'pwsh', 'pytest', 'python', 'python3', 'ruff', 'tsc', 'yarn',
].sort());

export const DEFAULT_ALLOWED_COMMANDS = Object.freeze([
  'bundle', 'bun', 'cargo', 'clang', 'clang++', 'cmake', 'composer', 'deno', 'dotnet', 'eslint', 'g++', 'gcc', 'git',
  'go', 'gradle', 'gradlew', 'java', 'javac', 'jest', 'make', 'mvn', 'mvnw', 'mypy', 'ninja', 'node', 'npm', 'npx',
  'pdm', 'php', 'pip', 'pip3', 'pnpm', 'poetry', 'pytest', 'python', 'python3', 'rake', 'ruby', 'ruff', 'rustc', 'swift',
  'tsc', 'uv', 'vitest', 'xcodebuild', 'yarn',
].sort());

export const RUNTIME_KEYS = Object.freeze({
  runtimePath: 'runtime.runtimePath',
  allowedCommands: 'runtime.allowedCommands',
  allowCommandExecution: 'runtime.allowCommandExecution',
  allowExternalNetwork: 'runtime.allowExternalNetwork',
  requireHighRiskConfirmation: 'runtime.requireHighRiskConfirmation',
  highRiskConfirmationMode: 'runtime.highRiskConfirmationMode',
  networkIsolationRequired: 'runtime.networkIsolationRequired',
  lspEnabled: 'runtime.lspEnabled',
  lspRequestTimeoutMs: 'runtime.lspRequestTimeoutMs',
  lspTypeScriptCommand: 'runtime.lspTypeScriptCommand',
  lspHtmlCommand: 'runtime.lspHtmlCommand',
  lspCssCommand: 'runtime.lspCssCommand',
  lspCustomServers: 'runtime.lspCustomServers',
  maxFileBytes: 'runtime.maxFileBytes',
  maxCommandOutputBytes: 'runtime.maxCommandOutputBytes',
  defaultCommandTimeoutMs: 'runtime.defaultCommandTimeoutMs',
  maxCommandTimeoutMs: 'runtime.maxCommandTimeoutMs',
});

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function profileFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    runtimePath: row.runtime_path,
    allowedCommands: row.allowed_commands ? JSON.parse(row.allowed_commands) : null,
    allowCommandExecution: row.allow_command_execution === null ? null : row.allow_command_execution === 1,
    allowExternalNetwork: row.allow_external_network === null ? null : row.allow_external_network === 1,
    requireHighRiskConfirmation: row.require_high_risk_confirmation === null ? null : row.require_high_risk_confirmation === 1,
    highRiskConfirmationMode: row.high_risk_confirmation_mode === 'none' ? 'none' : row.high_risk_confirmation_mode === null && row.require_high_risk_confirmation === null ? null : 'local',
    maxCommandOutputBytes: row.max_command_output_bytes,
    defaultCommandTimeoutMs: row.default_command_timeout_ms,
    maxCommandTimeoutMs: row.max_command_timeout_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function defaultRuntimeSettingsFromEnv(env = process.env) {
  const int = (name, fallback) => {
    const value = Number.parseInt(env[name] ?? '', 10);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const bool = (name, fallback) => {
    const value = env[name];
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return fallback;
  };
  const commands = [...new Set(String(env.ALLOWED_COMMANDS || DEFAULT_ALLOWED_COMMANDS.join(',')).split(',').map((item) => item.trim()).filter(Boolean))].sort();
  const explicitRuntimePath = String(env.RUNTIME_PATH || '').trim();
  const inheritedPath = String(env.PATH || '').trim();
  const runtimePath = explicitRuntimePath || (() => {
    const entries = inheritedPath.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
    if (process.platform === 'darwin') {
      entries.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin');
      if (env.HOME) entries.push(path.join(env.HOME, '.local', 'bin'), path.join(env.HOME, '.cargo', 'bin'), path.join(env.HOME, '.volta', 'bin'));
    }
    return [...new Set(entries)].join(path.delimiter);
  })();
  return runtimeSettingsSchema.parse({
    runtimePath,
    allowedCommands: commands,
    allowCommandExecution: bool('ALLOW_COMMAND_EXECUTION', false),
    allowExternalNetwork: bool('ALLOW_EXTERNAL_NETWORK', false),
    requireHighRiskConfirmation: bool('REQUIRE_HIGH_RISK_CONFIRMATION', true),
    highRiskConfirmationMode: String(env.HIGH_RISK_CONFIRMATION_MODE || (bool('REQUIRE_HIGH_RISK_CONFIRMATION', true) ? 'local' : 'none')).trim().toLowerCase() === 'none' ? 'none' : 'local',
    networkIsolationRequired: bool('NETWORK_ISOLATION_REQUIRED', true),
    lspEnabled: bool('LSP_ENABLED', true),
    lspRequestTimeoutMs: int('LSP_REQUEST_TIMEOUT_MS', 8_000),
    lspTypeScriptCommand: String(env.LSP_TYPESCRIPT_COMMAND || 'typescript-language-server').trim(),
    lspHtmlCommand: String(env.LSP_HTML_COMMAND || 'vscode-html-language-server').trim(),
    lspCssCommand: String(env.LSP_CSS_COMMAND || 'vscode-css-language-server').trim(),
    lspCustomServers: String(env.LSP_CUSTOM_SERVERS || '[]').trim(),
    maxFileBytes: int('MAX_FILE_BYTES', 2 * 1024 * 1024),
    maxCommandOutputBytes: int('MAX_COMMAND_OUTPUT_BYTES', 256 * 1024),
    defaultCommandTimeoutMs: int('DEFAULT_COMMAND_TIMEOUT_MS', 30_000),
    maxCommandTimeoutMs: int('MAX_COMMAND_TIMEOUT_MS', 600_000),
  });
}

export function initializeRuntimeDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runtime_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      runtime_path TEXT,
      allowed_commands TEXT,
      allow_command_execution INTEGER CHECK(allow_command_execution IN (0, 1) OR allow_command_execution IS NULL),
      allow_external_network INTEGER CHECK(allow_external_network IN (0, 1) OR allow_external_network IS NULL),
      require_high_risk_confirmation INTEGER CHECK(require_high_risk_confirmation IN (0, 1) OR require_high_risk_confirmation IS NULL),
      high_risk_confirmation_mode TEXT CHECK(high_risk_confirmation_mode IN ('client', 'local', 'none') OR high_risk_confirmation_mode IS NULL),
      max_command_output_bytes INTEGER,
      default_command_timeout_ms INTEGER,
      max_command_timeout_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_runtime_profiles (
      workspace TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES runtime_profiles(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  const profileColumns = new Set(db.prepare('PRAGMA table_info(runtime_profiles)').all().map((row) => row.name));
  if (!profileColumns.has('allow_external_network')) db.exec('ALTER TABLE runtime_profiles ADD COLUMN allow_external_network INTEGER CHECK(allow_external_network IN (0, 1) OR allow_external_network IS NULL)');
  if (!profileColumns.has('require_high_risk_confirmation')) db.exec('ALTER TABLE runtime_profiles ADD COLUMN require_high_risk_confirmation INTEGER CHECK(require_high_risk_confirmation IN (0, 1) OR require_high_risk_confirmation IS NULL)');
  if (!profileColumns.has('high_risk_confirmation_mode')) db.exec("ALTER TABLE runtime_profiles ADD COLUMN high_risk_confirmation_mode TEXT CHECK(high_risk_confirmation_mode IN ('client', 'local', 'none') OR high_risk_confirmation_mode IS NULL)");

  if (!tableExists(db, 'executor_profiles')) return;
  db.exec('PRAGMA foreign_keys=OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      INSERT OR IGNORE INTO runtime_profiles(
        id, name, runtime_path, allowed_commands, allow_command_execution,
        max_command_output_bytes, default_command_timeout_ms, max_command_timeout_ms,
        created_at, updated_at
      )
      SELECT
        id, name, runtime_path, allowed_commands, allow_command_execution,
        max_command_output_bytes, default_command_timeout_ms, max_command_timeout_ms,
        created_at, updated_at
      FROM executor_profiles
    `);
    if (tableExists(db, 'workspace_executor_profiles')) {
      db.exec(`
        INSERT OR REPLACE INTO workspace_runtime_profiles(workspace, profile_id, updated_at)
        SELECT w.workspace, w.profile_id, w.updated_at
        FROM workspace_executor_profiles w
        JOIN runtime_profiles p ON p.id = w.profile_id
      `);
      db.exec('DROP TABLE workspace_executor_profiles');
    }
    db.exec('DROP TABLE executor_profiles');
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }

}

export async function openRuntimeDatabase(dbPath, defaults = defaultRuntimeSettingsFromEnv()) {
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  initializeRuntimeDatabase(db);
  return new RuntimeRepository(db, defaults);
}

export function normalizeRuntimeSettings(input, current) {
  const patch = runtimeSettingsPatchSchema.parse(input);
  return runtimeSettingsSchema.parse({ ...current, ...patch });
}

export class RuntimeRepository {
  constructor(db, defaults) {
    this.db = db;
    this.defaults = runtimeSettingsSchema.parse(defaults);
  }

  close() { this.db.close(); }

  getJson(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  setJson(key, value) {
    this.db.prepare(`
      INSERT INTO settings(key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getRuntimeSettings() {
    return runtimeSettingsSchema.parse({
      runtimePath: this.getJson(RUNTIME_KEYS.runtimePath) ?? this.defaults.runtimePath,
      allowedCommands: this.getJson(RUNTIME_KEYS.allowedCommands) ?? this.defaults.allowedCommands,
      allowCommandExecution: this.getJson(RUNTIME_KEYS.allowCommandExecution) ?? this.defaults.allowCommandExecution,
      allowExternalNetwork: this.getJson(RUNTIME_KEYS.allowExternalNetwork) ?? this.defaults.allowExternalNetwork,
      requireHighRiskConfirmation: this.getJson(RUNTIME_KEYS.requireHighRiskConfirmation) ?? this.defaults.requireHighRiskConfirmation,
      highRiskConfirmationMode: this.getJson(RUNTIME_KEYS.highRiskConfirmationMode) === 'none'
        || (this.getJson(RUNTIME_KEYS.highRiskConfirmationMode) == null && this.getJson(RUNTIME_KEYS.requireHighRiskConfirmation) === false)
        ? 'none'
        : 'local',
      networkIsolationRequired: this.getJson(RUNTIME_KEYS.networkIsolationRequired) ?? this.defaults.networkIsolationRequired,
      lspEnabled: this.getJson(RUNTIME_KEYS.lspEnabled) ?? this.defaults.lspEnabled,
      lspRequestTimeoutMs: this.getJson(RUNTIME_KEYS.lspRequestTimeoutMs) ?? this.defaults.lspRequestTimeoutMs,
      lspTypeScriptCommand: this.getJson(RUNTIME_KEYS.lspTypeScriptCommand) ?? this.defaults.lspTypeScriptCommand,
      lspHtmlCommand: this.getJson(RUNTIME_KEYS.lspHtmlCommand) ?? this.defaults.lspHtmlCommand,
      lspCssCommand: this.getJson(RUNTIME_KEYS.lspCssCommand) ?? this.defaults.lspCssCommand,
      lspCustomServers: this.getJson(RUNTIME_KEYS.lspCustomServers) ?? this.defaults.lspCustomServers,
      maxFileBytes: this.getJson(RUNTIME_KEYS.maxFileBytes) ?? this.defaults.maxFileBytes,
      maxCommandOutputBytes: this.getJson(RUNTIME_KEYS.maxCommandOutputBytes) ?? this.defaults.maxCommandOutputBytes,
      defaultCommandTimeoutMs: this.getJson(RUNTIME_KEYS.defaultCommandTimeoutMs) ?? this.defaults.defaultCommandTimeoutMs,
      maxCommandTimeoutMs: this.getJson(RUNTIME_KEYS.maxCommandTimeoutMs) ?? this.defaults.maxCommandTimeoutMs,
    });
  }

  updateRuntimeSettings(input) {
    const patch = runtimeSettingsPatchSchema.parse(input);
    const next = normalizeRuntimeSettings(patch, this.getRuntimeSettings());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [field, key] of Object.entries(RUNTIME_KEYS)) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) this.setJson(key, next[field]);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
  }

  replaceRuntimeSettings(input) {
    const next = runtimeSettingsSchema.parse(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [field, key] of Object.entries(RUNTIME_KEYS)) this.setJson(key, next[field]);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return next;
  }

  resetRuntimeSettings() {
    const keys = Object.values(RUNTIME_KEYS);
    this.db.prepare(`DELETE FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
    return this.getRuntimeSettings();
  }

  revokeOAuthProviderIssuer(issuer) {
    if (!tableExists(this.db, 'oauth_provider_records')) return 0;
    const result = this.db.prepare('DELETE FROM oauth_provider_records WHERE issuer = ?').run(String(issuer));
    return Number(result.changes || 0);
  }

  listRuntimeProfiles() {
    return this.db.prepare('SELECT * FROM runtime_profiles ORDER BY name COLLATE NOCASE, id').all().map(profileFromRow);
  }

  getRuntimeProfile(id) {
    const row = this.db.prepare('SELECT * FROM runtime_profiles WHERE id = ?').get(id);
    return row ? profileFromRow(row) : null;
  }

  normalizeProfile(input, current) {
    const parsed = runtimeProfilePatchSchema.parse(input);
    const has = (key) => Object.prototype.hasOwnProperty.call(parsed, key);
    const next = {
      name: has('name') ? parsed.name : current?.name ?? '',
      runtimePath: has('runtimePath') ? parsed.runtimePath : current?.runtimePath ?? null,
      allowedCommands: has('allowedCommands') ? parsed.allowedCommands : current?.allowedCommands ?? null,
      allowCommandExecution: has('allowCommandExecution') ? parsed.allowCommandExecution : current?.allowCommandExecution ?? null,
      allowExternalNetwork: has('allowExternalNetwork') ? parsed.allowExternalNetwork : current?.allowExternalNetwork ?? null,
      requireHighRiskConfirmation: has('requireHighRiskConfirmation') ? parsed.requireHighRiskConfirmation : current?.requireHighRiskConfirmation ?? null,
      highRiskConfirmationMode: has('highRiskConfirmationMode') ? parsed.highRiskConfirmationMode : current?.highRiskConfirmationMode ?? null,
      maxCommandOutputBytes: has('maxCommandOutputBytes') ? parsed.maxCommandOutputBytes : current?.maxCommandOutputBytes ?? null,
      defaultCommandTimeoutMs: has('defaultCommandTimeoutMs') ? parsed.defaultCommandTimeoutMs : current?.defaultCommandTimeoutMs ?? null,
      maxCommandTimeoutMs: has('maxCommandTimeoutMs') ? parsed.maxCommandTimeoutMs : current?.maxCommandTimeoutMs ?? null,
    };
    if (!next.name) throw new Error('Runtime profile name is required');
    if (
      typeof next.defaultCommandTimeoutMs === 'number'
      && typeof next.maxCommandTimeoutMs === 'number'
      && next.defaultCommandTimeoutMs > next.maxCommandTimeoutMs
    ) throw new Error('defaultCommandTimeoutMs must be <= maxCommandTimeoutMs');
    return next;
  }

  createRuntimeProfile(input) {
    const next = this.normalizeProfile(input, null);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO runtime_profiles(
        id, name, runtime_path, allowed_commands, allow_command_execution, allow_external_network, require_high_risk_confirmation, high_risk_confirmation_mode,
        max_command_output_bytes, default_command_timeout_ms, max_command_timeout_ms,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, next.name, next.runtimePath,
      next.allowedCommands === null ? null : JSON.stringify(next.allowedCommands),
      next.allowCommandExecution === null ? null : next.allowCommandExecution ? 1 : 0,
      next.allowExternalNetwork === null ? null : next.allowExternalNetwork ? 1 : 0,
      next.requireHighRiskConfirmation === null ? null : next.requireHighRiskConfirmation ? 1 : 0,
      next.highRiskConfirmationMode,
      next.maxCommandOutputBytes, next.defaultCommandTimeoutMs, next.maxCommandTimeoutMs,
      now, now,
    );
    return this.getRuntimeProfile(id);
  }

  updateRuntimeProfile(id, input) {
    const current = this.getRuntimeProfile(id);
    if (!current) throw new Error('Unknown runtime profile');
    const next = this.normalizeProfile(input, current);
    this.db.prepare(`
      UPDATE runtime_profiles SET
        name = ?, runtime_path = ?, allowed_commands = ?, allow_command_execution = ?, allow_external_network = ?, require_high_risk_confirmation = ?, high_risk_confirmation_mode = ?,
        max_command_output_bytes = ?, default_command_timeout_ms = ?, max_command_timeout_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(
      next.name, next.runtimePath,
      next.allowedCommands === null ? null : JSON.stringify(next.allowedCommands),
      next.allowCommandExecution === null ? null : next.allowCommandExecution ? 1 : 0,
      next.allowExternalNetwork === null ? null : next.allowExternalNetwork ? 1 : 0,
      next.requireHighRiskConfirmation === null ? null : next.requireHighRiskConfirmation ? 1 : 0,
      next.highRiskConfirmationMode,
      next.maxCommandOutputBytes, next.defaultCommandTimeoutMs, next.maxCommandTimeoutMs,
      new Date().toISOString(), id,
    );
    return this.getRuntimeProfile(id);
  }

  deleteRuntimeProfile(id) {
    const result = this.db.prepare('DELETE FROM runtime_profiles WHERE id = ?').run(id);
    if (Number(result.changes) === 0) throw new Error('Unknown runtime profile');
  }

  assignWorkspaceProfile(workspace, profileId) {
    if (profileId === null) {
      this.db.prepare('DELETE FROM workspace_runtime_profiles WHERE workspace = ?').run(workspace);
      return null;
    }
    const profile = this.getRuntimeProfile(profileId);
    if (!profile) throw new Error('Unknown runtime profile');
    this.db.prepare(`
      INSERT INTO workspace_runtime_profiles(workspace, profile_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(workspace) DO UPDATE SET profile_id = excluded.profile_id, updated_at = excluded.updated_at
    `).run(workspace, profileId, new Date().toISOString());
    return profile;
  }

  getWorkspaceProfile(workspace) {
    const row = this.db.prepare(`
      SELECT p.* FROM runtime_profiles p
      JOIN workspace_runtime_profiles w ON w.profile_id = p.id
      WHERE w.workspace = ?
    `).get(workspace);
    return row ? profileFromRow(row) : null;
  }

  listWorkspaceProfileAssignments() {
    return this.db.prepare(`
      SELECT w.workspace, p.id AS profile_id, p.name AS profile_name
      FROM workspace_runtime_profiles w
      JOIN runtime_profiles p ON p.id = w.profile_id
      ORDER BY w.workspace
    `).all().map((row) => ({ workspace: row.workspace, profileId: row.profile_id, profileName: row.profile_name }));
  }

  listAssignments() {
    return this.listWorkspaceProfileAssignments().map((row) => ({
      workspace: row.workspace,
      profile: { id: row.profileId, name: row.profileName },
    }));
  }
}
