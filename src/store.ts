import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AdapterPayload } from 'oidc-provider';
import {
  RuntimeRepository,
  initializeRuntimeDatabase,
  type RuntimeProfile,
  type RuntimeProfileInput,
  type RuntimeSettings,
} from '../shared/runtime-repository.js';
import type { Config } from './config.js';

export type RuntimeSettingsInput = Partial<RuntimeSettings>;
export type { RuntimeProfile, RuntimeProfileInput };

export class ConfigStore extends RuntimeRepository {
  constructor(
    db: DatabaseSync,
    private readonly base: Config,
  ) {
    super(db, {
      runtimePath: base.runtimePath,
      allowedCommands: [...base.allowedCommands].sort(),
      allowCommandExecution: base.allowCommandExecution,
      allowExternalNetwork: base.allowExternalNetwork,
      requireHighRiskConfirmation: base.requireHighRiskConfirmation,
      highRiskConfirmationMode: base.highRiskConfirmationMode,
      networkIsolationRequired: base.networkIsolationRequired,
      lspEnabled: base.lspEnabled,
      lspRequestTimeoutMs: base.lspRequestTimeoutMs,
      lspTypeScriptCommand: base.lspTypeScriptCommand,
      lspHtmlCommand: base.lspHtmlCommand,
      lspCssCommand: base.lspCssCommand,
      lspCustomServers: base.lspCustomServers,
      maxFileBytes: base.maxFileBytes,
      maxCommandOutputBytes: base.maxCommandOutputBytes,
      defaultCommandTimeoutMs: base.defaultCommandTimeoutMs,
      maxCommandTimeoutMs: base.maxCommandTimeoutMs,
    });
  }

  upsertOAuthProviderRecord(
    issuer: string,
    model: string,
    id: string,
    payload: AdapterPayload,
    expiresIn?: number,
  ): void {
    const expiresAt = typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + expiresIn : null;
    this.db.prepare(`
      INSERT INTO oauth_provider_records(
        issuer, model, id, payload, expires_at, grant_id, uid, user_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issuer, model, id) DO UPDATE SET
        payload = excluded.payload,
        expires_at = excluded.expires_at,
        grant_id = excluded.grant_id,
        uid = excluded.uid,
        user_code = excluded.user_code
    `).run(
      issuer,
      model,
      id,
      JSON.stringify(payload),
      expiresAt,
      typeof payload.grantId === 'string' ? payload.grantId : null,
      typeof payload.uid === 'string' ? payload.uid : null,
      typeof payload.userCode === 'string' ? payload.userCode : null,
    );
  }

  private purgeExpiredOAuthRecords(): void {
    this.db.prepare('DELETE FROM oauth_provider_records WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .run(Math.floor(Date.now() / 1000));
  }

  findOAuthProviderRecord(issuer: string, model: string, id: string): AdapterPayload | undefined {
    this.purgeExpiredOAuthRecords();
    const row = this.db.prepare(`
      SELECT payload FROM oauth_provider_records
      WHERE issuer = ? AND model = ? AND id = ?
    `).get(issuer, model, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AdapterPayload : undefined;
  }

  findOAuthProviderRecordByUid(issuer: string, model: string, uid: string): AdapterPayload | undefined {
    this.purgeExpiredOAuthRecords();
    const row = this.db.prepare(`
      SELECT payload FROM oauth_provider_records
      WHERE issuer = ? AND model = ? AND uid = ? LIMIT 1
    `).get(issuer, model, uid) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AdapterPayload : undefined;
  }

  findOAuthProviderRecordByUserCode(issuer: string, model: string, userCode: string): AdapterPayload | undefined {
    this.purgeExpiredOAuthRecords();
    const row = this.db.prepare(`
      SELECT payload FROM oauth_provider_records
      WHERE issuer = ? AND model = ? AND user_code = ? LIMIT 1
    `).get(issuer, model, userCode) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AdapterPayload : undefined;
  }

  consumeOAuthProviderRecord(issuer: string, model: string, id: string): void {
    const current = this.findOAuthProviderRecord(issuer, model, id);
    if (!current) return;
    current.consumed = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE oauth_provider_records SET payload = ?
      WHERE issuer = ? AND model = ? AND id = ?
    `).run(JSON.stringify(current), issuer, model, id);
  }

  destroyOAuthProviderRecord(issuer: string, model: string, id: string): void {
    this.db.prepare('DELETE FROM oauth_provider_records WHERE issuer = ? AND model = ? AND id = ?')
      .run(issuer, model, id);
  }

  revokeOAuthProviderGrant(issuer: string, grantId: string): void {
    this.db.prepare('DELETE FROM oauth_provider_records WHERE issuer = ? AND grant_id = ?').run(issuer, grantId);
  }

  countOAuthProviderRecords(issuer: string, model: string): number {
    this.purgeExpiredOAuthRecords();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM oauth_provider_records
      WHERE issuer = ? AND model = ?
    `).get(issuer, model) as { count: number };
    return Number(row.count);
  }

  getEffectiveConfig(workspace?: string): Config {
    const runtime = this.getRuntimeSettings();
    const effective: Config = {
      ...this.base,
      runtimePath: runtime.runtimePath,
      allowedCommands: new Set(runtime.allowedCommands),
      allowCommandExecution: runtime.allowCommandExecution,
      allowExternalNetwork: runtime.allowExternalNetwork,
      requireHighRiskConfirmation: runtime.requireHighRiskConfirmation,
      highRiskConfirmationMode: runtime.highRiskConfirmationMode,
      networkIsolationRequired: runtime.networkIsolationRequired,
      lspEnabled: runtime.lspEnabled,
      lspRequestTimeoutMs: runtime.lspRequestTimeoutMs,
      lspTypeScriptCommand: runtime.lspTypeScriptCommand,
      lspHtmlCommand: runtime.lspHtmlCommand,
      lspCssCommand: runtime.lspCssCommand,
      maxFileBytes: runtime.maxFileBytes,
      maxCommandOutputBytes: runtime.maxCommandOutputBytes,
      defaultCommandTimeoutMs: runtime.defaultCommandTimeoutMs,
      maxCommandTimeoutMs: runtime.maxCommandTimeoutMs,
    };
    if (!workspace) return effective;

    const profile = this.getWorkspaceProfile(workspace);
    if (!profile) return effective;
    if (profile.runtimePath !== null) effective.runtimePath = profile.runtimePath;
    if (profile.allowedCommands !== null) effective.allowedCommands = new Set(profile.allowedCommands);
    if (profile.allowCommandExecution !== null) effective.allowCommandExecution = profile.allowCommandExecution;
    if (profile.allowExternalNetwork !== null) effective.allowExternalNetwork = profile.allowExternalNetwork;
    if (profile.requireHighRiskConfirmation !== null) effective.requireHighRiskConfirmation = profile.requireHighRiskConfirmation;
    if (profile.highRiskConfirmationMode !== null) effective.highRiskConfirmationMode = profile.highRiskConfirmationMode;
    else if (profile.requireHighRiskConfirmation !== null) effective.highRiskConfirmationMode = profile.requireHighRiskConfirmation ? 'local' : 'none';
    if (profile.maxCommandOutputBytes !== null) effective.maxCommandOutputBytes = profile.maxCommandOutputBytes;
    if (profile.defaultCommandTimeoutMs !== null) effective.defaultCommandTimeoutMs = profile.defaultCommandTimeoutMs;
    if (profile.maxCommandTimeoutMs !== null) effective.maxCommandTimeoutMs = profile.maxCommandTimeoutMs;
    if (effective.defaultCommandTimeoutMs > effective.maxCommandTimeoutMs) {
      throw new Error(`Runtime profile ${profile.name} produces default timeout greater than max timeout`);
    }
    return effective;
  }
}

export async function createConfigStore(base: Config): Promise<ConfigStore> {
  await mkdir(path.dirname(base.stateDbPath), { recursive: true });
  const db = new DatabaseSync(base.stateDbPath, { enableForeignKeyConstraints: true });
  initializeRuntimeDatabase(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_provider_records (
      issuer TEXT NOT NULL,
      model TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      expires_at INTEGER,
      grant_id TEXT,
      uid TEXT,
      user_code TEXT,
      PRIMARY KEY(issuer, model, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS oauth_provider_records_expiry_idx ON oauth_provider_records(expires_at);
    CREATE INDEX IF NOT EXISTS oauth_provider_records_grant_idx ON oauth_provider_records(issuer, grant_id);
    CREATE INDEX IF NOT EXISTS oauth_provider_records_uid_idx ON oauth_provider_records(issuer, model, uid);
    CREATE INDEX IF NOT EXISTS oauth_provider_records_user_code_idx ON oauth_provider_records(issuer, model, user_code);
  `);
  db.exec('DROP TABLE IF EXISTS oauth_clients; DROP TABLE IF EXISTS oauth_refresh_tokens;');
  return new ConfigStore(db, base);
}
