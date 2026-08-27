import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  verifyBearerToken,
  type AuthInfo,
  type AuthMetadataOptions,
} from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import { createBuiltinOAuthServer } from './builtin-oauth.js';
import { recordOAuthInteractionNotice } from './oauth-interaction-notices.js';
import type { ConfigStore } from './store.js';

type NodeRequestWithAuth = IncomingMessage & { auth?: AuthInfo };

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function validateOAuthUrl(value: string, label: string, allowInsecure: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must not include userinfo or a fragment`);
  }
  const insecureLoopback = allowInsecure && parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== 'https:' && !insecureLoopback) {
    throw new Error(`${label} must use HTTPS${allowInsecure ? ' (HTTP is only allowed for loopback development)' : ''}`);
  }
  return parsed;
}

export type McpAuth = {
  mode: 'none' | 'token' | 'oauth_builtin';
  authenticate(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  handleMetadata(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = await response.arrayBuffer();
  res.writeHead(response.status, headers);
  res.end(Buffer.from(body));
}

export async function createMcpAuth(
  config: Config,
  store?: ConfigStore,
  toolTier: 'readonly' | 'standard' | 'full' = 'full',
): Promise<McpAuth> {
  if (config.authMode === 'none') {
    return {
      mode: 'none',
      async authenticate() {
        return true;
      },
      async handleMetadata() {
        return false;
      },
    };
  }

  if (config.authMode === 'token') {
    return {
      mode: 'token',
      async authenticate(req, res) {
        const raw = req.headers.authorization ?? '';
        const prefix = 'Bearer ';
        if (raw.startsWith(prefix)) {
          const actual = Buffer.from(raw.slice(prefix.length));
          const expected = Buffer.from(config.apiToken);
          if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
        }
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return false;
      },
      async handleMetadata() {
        return false;
      },
    };
  }

  if (config.authMode === 'oauth_builtin') {
    if (!store) throw new Error('Built-in OAuth requires the Runtime ConfigStore');
    const resourceServerUrl = validateOAuthUrl(
      config.publicUrl,
      'MCP public resource URL',
      config.oauthAllowInsecureIssuer,
    );
    if (!config.builtinOauthWorkspace) throw new Error('BUILTIN_OAUTH_WORKSPACE is required for built-in OAuth');
    if (!config.builtinOauthPrivateJwk) throw new Error('BUILTIN_OAUTH_PRIVATE_JWK is required for built-in OAuth');
    if (!config.builtinOauthAuthorizationSecretHash) {
      throw new Error('BUILTIN_OAUTH_AUTHORIZATION_SECRET_HASH is required for built-in OAuth');
    }
    let privateJwk: Record<string, unknown>;
    try {
      const parsed = JSON.parse(config.builtinOauthPrivateJwk) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      privateJwk = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`BUILTIN_OAUTH_PRIVATE_JWK must be valid JWK JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const issuerUrl = new URL(resourceServerUrl);
    issuerUrl.pathname = resourceServerUrl.pathname.replace(/\/mcp\/?$/, '') || '/';
    issuerUrl.search = '';
    issuerUrl.hash = '';
    const builtin = await createBuiltinOAuthServer({
      issuer: issuerUrl.href,
      resource: resourceServerUrl.href,
      workspace: config.builtinOauthWorkspace,
      toolTier,
      requiredScopes: config.oauthRequiredScopes,
      privateJwk,
      authorizationSecretHash: config.builtinOauthAuthorizationSecretHash,
      store,
      onAuthorizationInteraction: recordOAuthInteractionNotice,
    });
    const metadataOptions: AuthMetadataOptions = {
      oauthMetadata: builtin.oauthMetadata,
      resourceServerUrl,
      scopesSupported: config.oauthRequiredScopes,
      resourceName: `MCPort · ${config.builtinOauthWorkspace}`,
      dangerouslyAllowInsecureIssuerUrl: config.oauthAllowInsecureIssuer,
    };
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
    const bearerOptions = {
      verifier: builtin.verifier,
      requiredScopes: config.oauthRequiredScopes,
      resourceMetadataUrl,
    };
    oauthMetadataResponse(new Request(resourceMetadataUrl), metadataOptions);

    return {
      mode: 'oauth_builtin',
      async authenticate(req, res) {
        try {
          const auth = await verifyBearerToken(req.headers.authorization, bearerOptions);
          (req as NodeRequestWithAuth).auth = auth;
          return true;
        } catch (error) {
          await writeWebResponse(
            res,
            bearerAuthChallengeResponse(error, {
              requiredScopes: config.oauthRequiredScopes,
              resourceMetadataUrl,
            }),
          );
          return false;
        }
      },
      async handleMetadata(req, res) {
        if (!req.url) return false;
        const publicRequestUrl = new URL(req.url, resourceServerUrl.origin);
        if (publicRequestUrl.pathname === new URL(resourceMetadataUrl).pathname) {
          const metadataResponse = oauthMetadataResponse(
            new Request(publicRequestUrl, { method: req.method, headers: req.headers as HeadersInit }),
            metadataOptions,
          );
          if (metadataResponse) {
            await writeWebResponse(res, metadataResponse);
            return true;
          }
        }
        return builtin.handleRequest(req, res);
      },
    };
  }

  throw new Error(`Unsupported MCP auth mode: ${config.authMode}`);
}
