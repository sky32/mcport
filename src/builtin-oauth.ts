import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { importJWK, jwtVerify, type JWK } from 'jose';
import Provider, {
  type Adapter,
  type AdapterPayload,
  type Configuration as OidcConfiguration,
} from 'oidc-provider';
import { EnvHttpProxyAgent } from 'undici';
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible';
import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { ConfigStore } from './store.js';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FAILED_AUTH_ATTEMPTS = 5;
const AUTH_ATTEMPT_WINDOW_SECONDS = 5 * 60;
const MAX_AUTH_ATTEMPTS_PER_WINDOW = 20;
const REGISTRATION_WINDOW_SECONDS = 10 * 60;
const MAX_REGISTRATIONS_PER_WINDOW = 20;
const MAX_REGISTERED_CLIENTS_PER_ISSUER = 256;
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;

export type BuiltinOAuthOptions = {
  issuer: string;
  resource: string;
  workspace: string;
  toolTier: 'readonly' | 'standard' | 'full';
  requiredScopes: string[];
  privateJwk: Record<string, unknown>;
  authorizationSecretHash: string;
  store: ConfigStore;
  onAuthorizationInteraction?: (notice: {
    interactionId: string;
    workspace: string;
    clientName: string;
    clientId: string;
  }) => void;
};

export type BuiltinOAuthServer = {
  oauthMetadata: OAuthMetadata;
  verifier: OAuthTokenVerifier;
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
};

function cleanIssuer(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Built-in OAuth issuer must use HTTPS except for loopback development');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Built-in OAuth issuer must not contain userinfo, query, or fragment');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname || '/';
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
}

function retryAfterSeconds(error: unknown): number {
  const limiter = error as Partial<RateLimiterRes> | undefined;
  return Math.max(1, Math.ceil(Number(limiter?.msBeforeNext ?? 1000) / 1000));
}

function cleanResource(value: string): string {
  const url = new URL(value);
  if (url.hash) throw new Error('Built-in OAuth resource must not contain a fragment');
  return url.href;
}

function createProxyFetch(): OidcConfiguration['fetch'] | undefined {
  if (!PROXY_ENV_KEYS.some((key) => process.env[key]?.trim())) return undefined;

  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy,
    httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy,
    noProxy: process.env.NO_PROXY || process.env.no_proxy,
  });

  return ((url, init) => globalThis.fetch(url, {
    ...init,
    dispatcher,
  } as RequestInit & { dispatcher: EnvHttpProxyAgent })) as OidcConfiguration['fetch'];
}

function validateSigningJwk(value: Record<string, unknown>): JWK & Record<string, unknown> {
  if (value.kty !== 'EC' || value.crv !== 'P-256') throw new Error('Built-in OAuth signing key must be EC P-256');
  if (typeof value.x !== 'string' || typeof value.y !== 'string' || typeof value.d !== 'string') {
    throw new Error('Built-in OAuth signing JWK is incomplete');
  }
  if (typeof value.kid !== 'string' || !value.kid) throw new Error('Built-in OAuth signing JWK requires kid');
  return value as JWK & Record<string, unknown>;
}

function publicJwkFromPrivate(value: JWK & Record<string, unknown>): JWK {
  const result = { ...value } as JWK & Record<string, unknown>;
  for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth']) delete result[field];
  return result;
}

function parseAuthorizationSecretHash(value: string): { salt: Buffer; expected: Buffer } {
  const [scheme, saltValue, digestValue] = value.split('$');
  if (scheme !== 'scrypt' || !saltValue || !digestValue) throw new Error('Built-in OAuth authorization secret hash is invalid');
  const salt = Buffer.from(saltValue, 'base64url');
  const expected = Buffer.from(digestValue, 'base64url');
  if (salt.length < 16 || expected.length !== 32) throw new Error('Built-in OAuth authorization secret hash is invalid');
  return { salt, expected };
}

function verifyAuthorizationSecret(value: string, encodedHash: string): boolean {
  const { salt, expected } = parseAuthorizationSecretHash(encodedHash);
  const actual = scryptSync(value, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestIdentity(req: IncomingMessage): string {
  const cloudflareIp = req.headers['cf-connecting-ip'];
  if (typeof cloudflareIp === 'string' && cloudflareIp.trim()) return cloudflareIp.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw new Error('content-type must be application/x-www-form-urlencoded');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function interactionPage(input: {
  workspace: string;
  uid: string;
  actionPath: string;
  clientName: string;
  clientId: string;
  redirectHost: string;
  resource: string;
  toolTier: 'readonly' | 'standard' | 'full';
  scopes: string[];
  nonce: string;
  error?: string;
}): string {
  const scopes = input.scopes.map((scope) => `<code>${htmlEscape(scope)}</code>`).join(' ');
  const tierLabel = ({ readonly: '查看工具', standard: '编辑工具', full: '开发工具' } as const)[input.toolTier];
  const permissions = [
    '读取当前 Workspace 的文件、目录、图片与项目上下文',
    '搜索项目内容并查看 Git 状态、差异、历史与归因信息',
    '读取项目历史会话记录',
    ...(input.toolTier === 'standard' || input.toolTier === 'full'
      ? ['修改当前 Workspace 内的文件和目录，并保存项目历史检查点']
      : []),
    ...(input.toolTier === 'full'
      ? ['调用 Runtime 允许的本机命令；仍受 Allowed Commands、联网策略和超时限制']
      : []),
  ];
  const permissionItems = permissions.map((permission) => `<li>${htmlEscape(permission)}</li>`).join('');
  const clientRegistration = input.clientId.startsWith('https://') ? 'CIMD' : 'Dynamic Client Registration';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" type="image/png" href="/icon.png"><title>MCPort · 授权 ${htmlEscape(input.workspace)}</title><style>
body{margin:0;background:#0b1020;color:#e5e7eb;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(620px,100%);background:#121a2d;border:1px solid #273451;border-radius:16px;padding:24px;box-sizing:border-box;box-shadow:0 18px 60px rgba(0,0,0,.32)}h1{font-size:20px;margin:0 0 8px}.muted{color:#94a3b8;line-height:1.55}.box{margin:18px 0;padding:14px;background:#0c1426;border:1px solid #24324d;border-radius:12px;display:grid;gap:10px}.row{display:grid;gap:4px}.row span{font-size:11px;color:#7f8da8;text-transform:uppercase}.row strong{overflow-wrap:anywhere}.scopes{display:flex;gap:6px;flex-wrap:wrap}.scopes code{padding:3px 7px;border-radius:6px;background:#1d2942;color:#bfdbfe}.permissions{margin:0;padding-left:19px;color:#cbd5e1;line-height:1.65}.permissions li+li{margin-top:4px}.notice{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:#101d34;color:#aebbd3;font-size:12px;line-height:1.55}.notice strong{color:#dbeafe}label{display:block;margin:15px 0 7px;font-weight:600}input{width:100%;box-sizing:border-box;background:#0b1324;color:#fff;border:1px solid #334564;border-radius:10px;padding:12px 13px;font:inherit;outline:none}.error{margin-top:10px;color:#fda4af}.actions{display:flex;gap:10px;margin-top:18px}button{flex:1;border:0;border-radius:10px;padding:11px 14px;font:inherit;font-weight:700;cursor:pointer}.approve{background:#6f8cff;color:white}.deny{background:#202b42;color:#cbd5e1}button:disabled{opacity:.58;cursor:wait}.submit-status{min-height:20px;margin-top:10px;color:#bfdbfe;font-size:12px;line-height:1.5}:root{color-scheme:dark}@media (prefers-color-scheme:light){:root{color-scheme:light}body{background:#f4f7fb;color:#172033}.card{background:#fff;border-color:rgba(15,23,42,.14);box-shadow:0 24px 70px rgba(15,23,42,.14)}.muted{color:#64748b}.box{background:#f8fafc;border-color:rgba(15,23,42,.12)}.row span{color:#64748b}.scopes code{background:#eef2ff;color:#4058a8}.permissions{color:#475569}.notice{background:#f8fafc;color:#64748b}.notice strong{color:#334155}input{background:#fff;color:#172033;border-color:rgba(15,23,42,.14)}input::placeholder{color:#94a3b8}.error{color:#be123c}.approve{background:#526fd6}.deny{background:#f1f5f9;color:#475569}.submit-status{color:#4058a8}}</style></head><body><main class="card"><div style="display:flex;align-items:center;gap:12px;margin-bottom:18px"><img src="/icon.png" alt="MCPort" style="width:48px;height:48px;border-radius:12px;object-fit:cover"><div><strong style="font-size:18px">MCPort</strong><span style="display:block;margin-top:3px;color:#94a3b8;font-size:12px">Model Context Protocol</span></div></div><h1>授权 MCPort</h1><p class="muted">确认下面的 MCP 客户端可以访问 Workspace <strong>${htmlEscape(input.workspace)}</strong>。授权仅作用于这个 Workspace，不会授予其他 Workspace 的访问权限。</p><div class="box"><div class="row"><span>客户端</span><strong>${htmlEscape(input.clientName)}</strong></div><div class="row"><span>客户端注册</span><strong>${clientRegistration}</strong></div><div class="row"><span>回调地址</span><strong>${htmlEscape(input.redirectHost)}</strong></div><div class="row"><span>MCP Resource</span><strong>${htmlEscape(input.resource)}</strong></div><div class="row"><span>工具范围</span><strong>${tierLabel}</strong></div><div class="row"><span>OAuth Scope</span><div class="scopes">${scopes}</div></div><div class="row"><span>允许的操作</span><ul class="permissions">${permissionItems}</ul></div></div><div class="notice"><strong>授权后：</strong>客户端只能调用当前范围内的 MCP tools。文件操作仍限制在 Workspace 目录内；开发工具中的命令还会经过本机命令开关、命令白名单、联网和确认规则。</div><form id="authorizationForm" method="post" action="${htmlEscape(input.actionPath)}"><input id="decision" name="decision" type="hidden" value=""><label for="secret">授权口令</label><input id="secret" name="authorization_secret" type="password" autocomplete="current-password" autofocus required placeholder="从 MCPort App 复制">${input.error ? `<div class="error">${htmlEscape(input.error)}</div>` : ''}<div class="actions"><button class="deny" type="submit" value="deny">取消</button><button class="approve" type="submit" value="approve">授权</button></div><div class="submit-status" id="submitStatus" role="status" aria-live="polite"></div></form></main><script nonce="${htmlEscape(input.nonce)}">(()=>{const form=document.getElementById('authorizationForm');const decision=document.getElementById('decision');const status=document.getElementById('submitStatus');let submitted=false;form.addEventListener('submit',(event)=>{if(submitted){event.preventDefault();return;}submitted=true;decision.value=event.submitter&&event.submitter.value==='deny'?'deny':'approve';for(const button of form.querySelectorAll('button'))button.disabled=true;status.textContent=decision.value==='deny'?'正在取消授权…':'正在授权并返回 MCP 客户端…';if(decision.value==='approve')document.getElementById('secret').readOnly=true;setTimeout(()=>{if(document.visibilityState==='visible')status.textContent=decision.value==='deny'?'取消请求已提交，请返回 MCP 客户端。':'授权请求已提交；如果窗口没有自动关闭，请返回 MCP 客户端查看连接状态。';},8000);});})();</script></body></html>`;
}

function interactionUnavailablePage(): string {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权请求已处理</title><style>body{margin:0;background:#0b1020;color:#e5e7eb;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(520px,100%);background:#121a2d;border:1px solid #273451;border-radius:16px;padding:24px;box-sizing:border-box}h1{font-size:20px;margin:0 0 10px}p{margin:0;color:#94a3b8;line-height:1.65}@media (prefers-color-scheme:light){body{background:#f4f7fb;color:#172033}.card{background:#fff;border-color:rgba(15,23,42,.14);box-shadow:0 24px 70px rgba(15,23,42,.14)}p{color:#64748b}}</style></head><body><main class="card"><h1>授权请求已处理或已过期</h1><p>请返回 MCP 客户端查看连接状态。如果连接仍未完成，请从客户端重新发起授权，不要重复提交当前页面。</p></main></body></html>';
}

class SqliteOidcAdapter implements Adapter {
  constructor(
    private readonly issuer: string,
    private readonly model: string,
    private readonly store: ConfigStore,
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    this.store.upsertOAuthProviderRecord(this.issuer, this.model, id, payload, expiresIn);
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return this.store.findOAuthProviderRecord(this.issuer, this.model, id);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.store.findOAuthProviderRecordByUid(this.issuer, this.model, uid);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.store.findOAuthProviderRecordByUserCode(this.issuer, this.model, userCode);
  }

  async consume(id: string): Promise<void> {
    this.store.consumeOAuthProviderRecord(this.issuer, this.model, id);
  }

  async destroy(id: string): Promise<void> {
    this.store.destroyOAuthProviderRecord(this.issuer, this.model, id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    this.store.revokeOAuthProviderGrant(this.issuer, grantId);
  }
}

class BuiltinAccessTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly publicKey: Awaited<ReturnType<typeof importJWK>>,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly resource: URL,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['ES256'],
        requiredClaims: ['exp'],
      });
      if (typeof payload.exp !== 'number') throw new Error('JWT exp claim is required');
      const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
      if (!clientId) throw new Error('JWT client_id claim is required');
      const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
      return {
        token,
        clientId,
        scopes,
        expiresAt: payload.exp,
        resource: this.resource,
        extra: { subject: payload.sub, issuer: payload.iss, builtInAuthorizationServer: true },
      };
    } catch (error) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, error instanceof Error ? error.message : 'Invalid access token');
    }
  }
}

export async function createBuiltinOAuthServer(options: BuiltinOAuthOptions): Promise<BuiltinOAuthServer> {
  const issuer = cleanIssuer(options.issuer);
  const issuerUrl = new URL(issuer);
  const routeBase = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname;
  const route = (suffix: string) => `${routeBase}${suffix}`;
  const resource = cleanResource(options.resource);
  const resourceUrl = new URL(resource);
  const privateJwk = validateSigningJwk(options.privateJwk);
  const publicJwk = publicJwkFromPrivate(privateJwk);
  const publicKey = await importJWK(publicJwk, 'ES256');
  parseAuthorizationSecretHash(options.authorizationSecretHash);
  const kid = String(privateJwk.kid);
  const requiredScopes = [...new Set(options.requiredScopes.length ? options.requiredScopes : ['mcp'])];
  const supportedScopes = [...new Set([...requiredScopes, 'offline_access'])];
  const proxyFetch = createProxyFetch();
  const cookieKey = createHash('sha256')
    .update('remote-workspace-mcp:oidc-provider:cookie:v1\0')
    .update(String(privateJwk.d))
    .digest('base64url');

  const configuration: OidcConfiguration = {
    ...(proxyFetch ? { fetch: proxyFetch } : {}),
    adapter: (model) => new SqliteOidcAdapter(issuer, model, options.store),
    jwks: { keys: [privateJwk] },
    cookies: { keys: [cookieKey] },
    responseTypes: ['code'],
    clientAuthMethods: ['none', 'private_key_jwt'],
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'ES256',
    },
    routes: {
      authorization: route('/oauth/authorize'),
      token: route('/oauth/token'),
      jwks: route('/oauth/jwks'),
      registration: route('/oauth/register'),
    },
    interactions: {
      url: (_ctx, interaction) => route(`/oauth/interaction/${interaction.uid}`),
    },
    pkce: { required: () => true },
    issueRefreshToken: () => true,
    rotateRefreshToken: true,
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL_SECONDS,
      AuthorizationCode: 5 * 60,
      RefreshToken: REFRESH_TOKEN_TTL_SECONDS,
      Interaction: 10 * 60,
    },
    features: {
      devInteractions: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
      },
      dPoP: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      introspection: { enabled: false },
      revocation: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: {
        enabled: true,
        initialAccessToken: false,
        issueRegistrationAccessToken: false,
      },
      registrationManagement: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => false,
        getResourceServerInfo: (_ctx, indicator) => {
          if (indicator !== resource) throw new Error('Unknown OAuth resource indicator');
          return {
            scope: requiredScopes.join(' '),
            audience: resource,
            accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256', kid } },
          };
        },
      },
    },
    extraTokenClaims: (_ctx, token) => ({ client_id: token.clientId }),
    findAccount: async (_ctx, accountId) => ({
      accountId,
      claims: async () => ({ sub: accountId }),
    }),
  };

  const provider = new Provider(issuer, configuration);
  provider.proxy = true;
  const oidcHandler = provider.callback();
  const authorizationAttemptRate = new RateLimiterMemory({
    keyPrefix: `oauth-auth-${options.workspace}`,
    points: MAX_AUTH_ATTEMPTS_PER_WINDOW,
    duration: AUTH_ATTEMPT_WINDOW_SECONDS,
  });
  const failedAuthorizationRate = new RateLimiterMemory({
    keyPrefix: `oauth-secret-${options.workspace}`,
    points: MAX_FAILED_AUTH_ATTEMPTS,
    duration: AUTH_ATTEMPT_WINDOW_SECONDS,
  });
  const registrationRate = new RateLimiterMemory({
    keyPrefix: `oauth-register-${options.workspace}`,
    points: MAX_REGISTRATIONS_PER_WINDOW,
    duration: REGISTRATION_WINDOW_SECONDS,
  });

  async function renderInteraction(req: IncomingMessage, res: ServerResponse, uid: string, error = ''): Promise<void> {
    const details = await provider.interactionDetails(req, res);
    if (details.uid !== uid) throw new Error('OAuth interaction mismatch');
    const clientId = String(details.params.client_id ?? '');
    const client = await provider.Client.find(clientId);
    if (!client) throw new Error('Unknown OAuth client');
    if (!error) {
      try {
        options.onAuthorizationInteraction?.({
          interactionId: uid,
          workspace: options.workspace,
          clientName: client.clientName || 'MCP Client',
          clientId,
        });
      } catch {
        // Desktop guidance is best-effort and must never block OAuth rendering.
      }
    }
    const redirectUri = String(details.params.redirect_uri ?? '');
    const redirectOrigin = redirectUri ? new URL(redirectUri).origin : '';
    const allowedFormOrigins = [...new Set([issuerUrl.origin, redirectOrigin].filter(Boolean))];
    const resourceScopes = details.prompt.details.missingResourceScopes as Record<string, string[]> | undefined;
    const scopes = [...new Set([
      ...requiredScopes,
      ...(resourceScopes?.[resource] ?? []),
      ...(Array.isArray(details.prompt.details.missingOIDCScope) ? details.prompt.details.missingOIDCScope : []),
    ])];
    const nonce = randomBytes(18).toString('base64url');
    res.writeHead(error ? 401 : 200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self' ${allowedFormOrigins.join(' ')}; base-uri 'none'; frame-ancestors 'none'`,
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    });
    res.end(interactionPage({
      workspace: options.workspace,
      uid,
      actionPath: `${issuerUrl.origin}${route(`/oauth/interaction/${uid}`)}`,
      clientName: client.clientName || 'MCP Client',
      clientId,
      redirectHost: redirectUri ? new URL(redirectUri).host : 'MCP Client',
      resource,
      toolTier: options.toolTier,
      scopes,
      nonce,
      error,
    }));
  }

  async function submitInteraction(req: IncomingMessage, res: ServerResponse, uid: string): Promise<void> {
    const details = await provider.interactionDetails(req, res);
    if (details.uid !== uid) throw new Error('OAuth interaction mismatch');
    const form = await readForm(req);
    if (form.get('decision') === 'deny') {
      await provider.interactionFinished(req, res, {
        error: 'access_denied',
        error_description: 'The Workspace owner denied this authorization request',
      }, { mergeWithLastSubmission: false });
      return;
    }

    const identity = requestIdentity(req);
    try {
      await authorizationAttemptRate.consume(identity);
    } catch (error) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(retryAfterSeconds(error)) });
      res.end('Too many authorization attempts. Try again later.');
      return;
    }
    const secret = form.get('authorization_secret') ?? '';
    if (!verifyAuthorizationSecret(secret, options.authorizationSecretHash)) {
      try {
        await failedAuthorizationRate.consume(identity);
      } catch (error) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(retryAfterSeconds(error)) });
        res.end('Too many failed authorization attempts. Return to the MCP client and try again later.');
        return;
      }
      await renderInteraction(req, res, uid, '授权口令不正确。');
      return;
    }
    await Promise.all([
      authorizationAttemptRate.delete(identity),
      failedAuthorizationRate.delete(identity),
    ]);

    const clientId = String(details.params.client_id ?? '');
    const grant = new provider.Grant({ accountId: 'workspace-owner', clientId });
    const missingResourceScopes = details.prompt.details.missingResourceScopes as Record<string, string[]> | undefined;
    for (const [indicator, scopes] of Object.entries(missingResourceScopes ?? { [resource]: requiredScopes })) {
      if (indicator !== resource) throw new Error('Unexpected OAuth resource indicator');
      grant.addResourceScope(indicator, scopes.join(' '));
    }
    const missingOidcScope = details.prompt.details.missingOIDCScope;
    if (Array.isArray(missingOidcScope) && missingOidcScope.length) grant.addOIDCScope(missingOidcScope.join(' '));
    const grantId = await grant.save();
    await provider.interactionFinished(req, res, {
      login: { accountId: 'workspace-owner', remember: false },
      consent: { grantId },
    }, { mergeWithLastSubmission: false });
  }

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    jwks_uri: `${issuer}/oauth/jwks`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: supportedScopes,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  } as OAuthMetadata & Record<string, unknown>;

  return {
    oauthMetadata: metadata,
    verifier: new BuiltinAccessTokenVerifier(publicKey, issuer, resource, resourceUrl),
    async handleRequest(req, res) {
      if (!req.url) return false;
      const requestUrl = new URL(req.url, issuerUrl.origin);
      const escapedRouteBase = routeBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const interactionMatch = new RegExp(`^${escapedRouteBase}\\/oauth\\/interaction\\/([^/]+)$`).exec(requestUrl.pathname);
      if (interactionMatch) {
        const uid = decodeURIComponent(interactionMatch[1]);
        try {
          if (req.method === 'GET') await renderInteraction(req, res, uid);
          else if (req.method === 'POST') await submitInteraction(req, res, uid);
          else res.writeHead(405, { allow: 'GET, POST' }).end();
        } catch (error) {
          const candidate = error as { error?: unknown; error_description?: unknown; message?: unknown };
          const code = String(candidate?.error ?? '');
          const description = String(candidate?.error_description ?? candidate?.message ?? '');
          if (code === 'invalid_request' || /interaction|invalid_request|already.*(used|consumed)|expired/i.test(description)) {
            res.writeHead(409, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
              'x-frame-options': 'DENY',
              'referrer-policy': 'no-referrer',
            });
            res.end(interactionUnavailablePage());
          } else {
            throw error;
          }
        }
        return true;
      }

      const providerPaths = new Set([
        `/.well-known/oauth-authorization-server${routeBase}`,
        route('/.well-known/openid-configuration'),
        route('/oauth/authorize'),
        route('/oauth/token'),
        route('/oauth/jwks'),
        route('/oauth/register'),
      ]);
      if (!providerPaths.has(requestUrl.pathname) && !requestUrl.pathname.startsWith(`${route('/oauth/authorize')}/`)) return false;

      if (
        requestUrl.pathname === `/.well-known/oauth-authorization-server${routeBase}`
        || requestUrl.pathname === route('/.well-known/openid-configuration')
      ) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(metadata));
        return true;
      }

      if (requestUrl.pathname === route('/oauth/register') && req.method === 'POST') {
        const identity = requestIdentity(req);
        let rateError: unknown;
        try {
          await registrationRate.consume(identity);
        } catch (error) {
          rateError = error;
        }
        if (rateError || options.store.countOAuthProviderRecords(issuer, 'Client') >= MAX_REGISTERED_CLIENTS_PER_ISSUER) {
          res.writeHead(429, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': String(rateError ? retryAfterSeconds(rateError) : REGISTRATION_WINDOW_SECONDS),
          });
          res.end(JSON.stringify({ error: 'temporarily_unavailable', error_description: 'Dynamic client registration limit reached' }));
          return true;
        }
      }

      // The provider runs behind the loopback Gateway / Cloudflare / FRP chain. The configured
      // public issuer is authoritative. Intermediate HTTP hops may send X-Forwarded-Proto=http,
      // which would otherwise make private_key_jwt audience validation compare against an
      // internal HTTP token URL instead of the published HTTPS token endpoint.
      req.headers['x-forwarded-proto'] = issuerUrl.protocol.slice(0, -1);
      req.headers['x-forwarded-host'] = issuerUrl.host;
      await oidcHandler(req, res);
      return true;
    },
  };
}
