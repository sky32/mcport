import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';
import { assertWorkspaceName } from './security.js';
import type { ConfigStore, RuntimeProfileInput, RuntimeSettingsInput } from './store.js';
import { createWorkspaceInDefaultRoot, listWorkspaceNames, resolveConfiguredWorkspace } from './workspaces.js';
import { listLocalConfirmations, resolveLocalConfirmation } from './local-confirmations.js';

type AdminDeps = {
  config: Config;
  store: ConfigStore;
  toolCatalog?: unknown[];
};

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function secretMatches(actualValue: string | string[] | undefined, expectedToken: string): boolean {
  if (!expectedToken || Array.isArray(actualValue)) return false;
  const actual = Buffer.from(String(actualValue ?? ''));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function tokenMatches(req: IncomingMessage, expectedToken: string): boolean {
  if (!expectedToken) return true;
  const raw = req.headers.authorization ?? '';
  if (!raw.startsWith('Bearer ')) return false;
  const actual = Buffer.from(raw.slice(7));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}

export async function handleAdminRequest(req: IncomingMessage, res: ServerResponse, deps: AdminDeps): Promise<boolean> {
  if (!deps.config.adminEnabled || !req.url?.startsWith('/admin')) return false;

  if (req.url === '/admin' || req.url === '/admin/') {
    res.writeHead(404, { 'cache-control': 'no-store' });
    res.end();
    return true;
  }

  if (!tokenMatches(req, deps.config.adminToken)) {
    json(res, 401, { error: 'unauthorized' });
    return true;
  }

  try {
    if (req.url === '/admin/api/settings' && req.method === 'GET') {
      json(res, 200, {
        ok: true,
        runtime: deps.store.getRuntimeSettings(),
        bootstrap: {
          host: deps.config.host,
          port: deps.config.port,
          authMode: deps.config.authMode,
          publicUrl: deps.config.publicUrl,
          workspaceRoot: deps.config.workspaceRoot,
          stateDbPath: deps.config.stateDbPath,
          executionMode: 'local',
          mcpServices: deps.config.mcpServices.map((service) => ({
            id: service.id,
            name: service.name,
            host: service.host,
            port: service.port,
            path: service.path,
            admin: service.admin,
            publicUrl: service.publicUrl,
            workspaces: service.workspaceAllowlist,
          })),
        },
      });
      return true;
    }

    if (req.url === '/admin/api/settings' && req.method === 'PUT') {
      const input = (await readJson(req)) as RuntimeSettingsInput;
      json(res, 200, { ok: true, runtime: deps.store.updateRuntimeSettings(input) });
      return true;
    }

    if (req.url === '/admin/api/settings' && req.method === 'DELETE') {
      json(res, 200, { ok: true, runtime: deps.store.resetRuntimeSettings() });
      return true;
    }

    if (req.url === '/admin/api/local-confirmations' && req.method === 'GET') {
      if (!secretMatches(req.headers['x-mcport-local-confirmation-token'], deps.config.localConfirmationToken)) {
        json(res, 401, { error: 'local_confirmation_unauthorized' });
        return true;
      }
      json(res, 200, { ok: true, confirmations: listLocalConfirmations() });
      return true;
    }

    const localConfirmationMatch = req.url?.match(/^\/admin\/api\/local-confirmations\/([^/?]+)$/);
    if (localConfirmationMatch && req.method === 'POST') {
      if (!secretMatches(req.headers['x-mcport-local-confirmation-token'], deps.config.localConfirmationToken)) {
        json(res, 401, { error: 'local_confirmation_unauthorized' });
        return true;
      }
      const id = decodeURIComponent(localConfirmationMatch[1]);
      const body = await readJson(req, 1024);
      if (typeof body.approved !== 'boolean') throw new Error('approved boolean required');
      const resolved = resolveLocalConfirmation(id, body.approved);
      if (!resolved) {
        json(res, 404, { error: 'confirmation_not_found_or_already_resolved' });
        return true;
      }
      json(res, 200, { ok: true, id, approved: body.approved });
      return true;
    }

    if (req.url === '/admin/api/tool-catalog' && req.method === 'GET') {
      json(res, 200, { ok: true, tools: deps.toolCatalog ?? [] });
      return true;
    }

    if (req.url === '/admin/api/workspaces' && req.method === 'GET') {
      const names = await listWorkspaceNames(deps.config);
      const workspaces = names
        .map((name) => {
          const profile = deps.store.getWorkspaceProfile(name);
          return { name, profile: profile ? { id: profile.id, name: profile.name } : null };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      json(res, 200, { ok: true, workspaces });
      return true;
    }

    if (req.url === '/admin/api/workspaces' && req.method === 'POST') {
      const body = await readJson(req);
      const workspace = String(body.workspace ?? '');
      assertWorkspaceName(workspace);
      await createWorkspaceInDefaultRoot(deps.config, workspace);
      json(res, 201, { ok: true, workspace });
      return true;
    }

    if (req.url === '/admin/api/runtime-profiles' && req.method === 'GET') {
      json(res, 200, { ok: true, profiles: deps.store.listRuntimeProfiles() });
      return true;
    }

    if (req.url === '/admin/api/runtime-profiles' && req.method === 'POST') {
      const body = (await readJson(req)) as RuntimeProfileInput;
      json(res, 201, { ok: true, profile: deps.store.createRuntimeProfile(body) });
      return true;
    }

    const profileMatch = req.url?.match(/^\/admin\/api\/runtime-profiles\/([^/?]+)$/);
    if (profileMatch) {
      const id = decodeURIComponent(profileMatch[1]);
      if (req.method === 'PUT') {
        const body = (await readJson(req)) as RuntimeProfileInput;
        json(res, 200, { ok: true, profile: deps.store.updateRuntimeProfile(id, body) });
        return true;
      }
      if (req.method === 'DELETE') {
        deps.store.deleteRuntimeProfile(id);
        json(res, 200, { ok: true });
        return true;
      }
    }

    const assignmentMatch = req.url?.match(/^\/admin\/api\/workspaces\/([^/?]+)\/runtime-profile$/);
    if (assignmentMatch && req.method === 'PUT') {
      const workspace = decodeURIComponent(assignmentMatch[1]);
      assertWorkspaceName(workspace);
      await resolveConfiguredWorkspace(deps.config, workspace);
      const body = await readJson(req);
      const profileId = body.profileId === null || body.profileId === undefined || body.profileId === ''
        ? null
        : String(body.profileId);
      const profile = deps.store.assignWorkspaceProfile(workspace, profileId);
      json(res, 200, { ok: true, workspace, profile });
      return true;
    }
  } catch (error) {
    console.error('[admin] request failed', error);
    json(res, 400, { error: 'invalid_request' });
    return true;
  }

  json(res, 404, { error: 'not_found' });
  return true;
}
