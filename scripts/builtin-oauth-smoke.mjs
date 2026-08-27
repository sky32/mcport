import { createHash, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeRepository, defaultRuntimeSettingsFromEnv } from '../shared/runtime-repository.js';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate port');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

function updateCookieJar(jar, response) {
  const values = response.headers['set-cookie'] || [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const pair = String(value).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (cookieValue) jar.set(name, cookieValue);
    else jar.delete(name);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function request(port, host, pathname, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        Host: host,
        ...headers,
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function waitHealth(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, '127.0.0.1', '/healthz');
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Runtime did not become healthy');
}

function encodeForm(values) {
  return new URLSearchParams(values).toString();
}

const port = await freePort();
const root = path.resolve(`data/builtin-oauth-smoke-${process.pid}-${Date.now()}`);
const workspaceRoot = path.join(root, 'workspaces');
const workspace = 'alpha';
const host = 'mcp.example.test';
const issuer = `https://${host}/w/${workspace}`;
const resource = `${issuer}/mcp`;
const mcpPath = `/w/${workspace}/mcp`;
const protectedMetadataPath = `/.well-known/oauth-protected-resource/w/${workspace}/mcp`;
const authorizationMetadataPath = `/.well-known/oauth-authorization-server/w/${workspace}`;
const oauthPath = (suffix) => `/w/${workspace}${suffix}`;
const authorizationSecret = 'smoke-authorization-secret';
const salt = randomBytes(16);
const authorizationSecretHash = `scrypt$${salt.toString('base64url')}$${scryptSync(authorizationSecret, salt, 32).toString('base64url')}`;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateJwk = privateKey.export({ format: 'jwk' });
privateJwk.kid = 'builtin-oauth-smoke-key';
privateJwk.alg = 'ES256';
privateJwk.use = 'sig';

await mkdir(path.join(workspaceRoot, workspace), { recursive: true });

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port),
    MCP_AUTH_MODE: 'none',
    ADMIN_ENABLED: 'false',
    WORKSPACE_ROOT: workspaceRoot,
    STATE_DB_PATH: path.join(root, 'state.db'),
    MCP_ALLOWED_HOSTS: `127.0.0.1,127.0.0.1:${port},localhost,localhost:${port},${host}`,
    MCP_GATEWAY_WORKSPACE_AUTH_JSON: JSON.stringify({
      [workspace]: {
        mode: 'oauth_builtin',
        workspace,
        audience: resource,
        scopes: ['mcp'],
        privateJwk,
        authorizationSecretHash,
      },
    }),
    MCP_WORKSPACE_TOOL_TIERS_JSON: JSON.stringify({ [workspace]: 'readonly' }),
    ALLOW_COMMAND_EXECUTION: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

try {
  await waitHealth(port);

  const unauthenticated = await request(port, host, mcpPath, {
    method: 'POST',
    headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'builtin-oauth-smoke', version: '1' } },
    }),
  });
  if (unauthenticated.status !== 401 || !String(unauthenticated.headers['www-authenticate'] ?? '').includes('resource_metadata=')) {
    throw new Error(`Missing OAuth bearer challenge: ${unauthenticated.status} ${JSON.stringify(unauthenticated.headers)}`);
  }

  const protectedMetadata = await request(port, host, protectedMetadataPath);
  const protectedPayload = JSON.parse(protectedMetadata.body);
  if (protectedMetadata.status !== 200 || protectedPayload.resource !== resource || !protectedPayload.authorization_servers?.includes(issuer)) {
    throw new Error(`Protected resource metadata mismatch: ${protectedMetadata.body}`);
  }

  const metadataResponse = await request(port, host, authorizationMetadataPath);
  const metadata = JSON.parse(metadataResponse.body);
  if (
    metadataResponse.status !== 200
    || metadata.issuer !== issuer
    || metadata.authorization_endpoint !== `${issuer}/oauth/authorize`
    || metadata.token_endpoint !== `${issuer}/oauth/token`
    || metadata.registration_endpoint !== `${issuer}/oauth/register`
    || metadata.client_id_metadata_document_supported !== true
    || !metadata.code_challenge_methods_supported?.includes('S256')
    || !metadata.scopes_supported?.includes('offline_access')
    || !metadata.token_endpoint_auth_methods_supported?.includes('private_key_jwt')
  ) {
    throw new Error(`Authorization Server metadata mismatch: ${metadataResponse.body}`);
  }

  const jwksResponse = await request(port, host, oauthPath('/oauth/jwks'));
  const jwks = JSON.parse(jwksResponse.body);
  if (jwksResponse.status !== 200 || jwks.keys?.[0]?.kid !== privateJwk.kid || jwks.keys?.[0]?.d) {
    throw new Error(`JWKS response is invalid: ${jwksResponse.body}`);
  }

  const callback = 'https://chatgpt.example.test/connector/oauth/callback-smoke';
  const registrationResponse = await request(port, host, oauthPath('/oauth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT Smoke Client',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const registration = JSON.parse(registrationResponse.body);
  if (registrationResponse.status !== 201 || !registration.client_id || registration.client_secret) {
    throw new Error(`Dynamic Client Registration failed: ${registrationResponse.body}`);
  }

  const { privateKey: privateJwtPrivateKey, publicKey: privateJwtPublicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwtJwk = privateJwtPublicKey.export({ format: 'jwk' });
  privateJwtJwk.kid = 'private-key-jwt-smoke';
  privateJwtJwk.alg = 'ES256';
  privateJwtJwk.use = 'sig';
  const privateJwtRegistrationResponse = await request(port, host, oauthPath('/oauth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Private Key JWT Smoke Client',
      redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      jwks: { keys: [privateJwtJwk] },
    }),
  });
  const privateJwtRegistration = JSON.parse(privateJwtRegistrationResponse.body);
  if (privateJwtRegistrationResponse.status !== 201 || !privateJwtRegistration.client_id) {
    throw new Error(`private_key_jwt client metadata rejected: ${privateJwtRegistrationResponse.body}`);
  }

  async function privateJwtAssertion() {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: privateJwtJwk.kid })
      .setIssuer(privateJwtRegistration.client_id)
      .setSubject(privateJwtRegistration.client_id)
      .setAudience(`${issuer}/oauth/token`)
      .setJti(randomBytes(16).toString('base64url'))
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateJwtPrivateKey);
  }

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = 'state-smoke';
  const authorizeQuery = new URLSearchParams({
    response_type: 'code',
    client_id: privateJwtRegistration.client_id,
    redirect_uri: callback,
    scope: 'mcp offline_access',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  });
  const cookies = new Map();
  const authorizeStart = await request(port, host, `${oauthPath('/oauth/authorize')}?${authorizeQuery}`);
  updateCookieJar(cookies, authorizeStart);
  if (![302, 303].includes(authorizeStart.status) || !authorizeStart.headers.location) {
    throw new Error(`Authorization did not enter interaction flow: ${authorizeStart.status} ${authorizeStart.body.slice(0, 500)}`);
  }
  const interactionPath = new URL(authorizeStart.headers.location, issuer).pathname;
  const authorizePage = await request(port, host, interactionPath, { headers: { Cookie: cookieHeader(cookies) } });
  updateCookieJar(cookies, authorizePage);
  if (
    authorizePage.status !== 200
    || !authorizePage.body.includes('Private Key JWT Smoke Client')
    || !authorizePage.body.includes('授权口令')
    || !authorizePage.body.includes('工具权限档位')
    || !authorizePage.body.includes('允许的操作')
    || !authorizePage.body.includes('正在授权并返回 MCP 客户端')
    || !authorizePage.body.includes(resource)
  ) {
    throw new Error(`Authorization interaction page failed: ${authorizePage.status} ${authorizePage.body.slice(0, 500)}`);
  }
  const interactionCsp = String(authorizePage.headers['content-security-policy'] ?? '');
  if (
    !interactionCsp.includes(`form-action 'self' ${new URL(issuer).origin}`)
    || !interactionCsp.includes(new URL(callback).origin)
  ) {
    throw new Error(`Authorization interaction CSP does not restrict form targets correctly: ${interactionCsp}`);
  }

  const wrongSecret = await request(port, host, interactionPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(cookies) },
    body: encodeForm({ decision: 'approve', authorization_secret: 'wrong' }),
  });
  if (wrongSecret.status !== 401 || !wrongSecret.body.includes('授权口令不正确')) {
    throw new Error(`Wrong authorization secret was not rejected: ${wrongSecret.status}`);
  }

  let approval = await request(port, host, interactionPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(cookies) },
    body: encodeForm({ decision: 'approve', authorization_secret: authorizationSecret }),
  });
  updateCookieJar(cookies, approval);
  for (let redirects = 0; redirects < 5 && [302, 303].includes(approval.status) && approval.headers.location; redirects += 1) {
    const target = new URL(approval.headers.location, issuer);
    if (target.origin !== new URL(issuer).origin) break;
    approval = await request(port, host, `${target.pathname}${target.search}`, { headers: { Cookie: cookieHeader(cookies) } });
    updateCookieJar(cookies, approval);
  }
  if (![302, 303].includes(approval.status) || !approval.headers.location) {
    throw new Error(`Authorization approval did not reach client callback: ${approval.status} ${approval.body.slice(0, 500)}`);
  }
  const callbackUrl = new URL(approval.headers.location);
  const code = callbackUrl.searchParams.get('code');
  if (!code || callbackUrl.searchParams.get('state') !== state || callbackUrl.searchParams.get('iss') !== issuer) {
    throw new Error(`Authorization callback mismatch: ${callbackUrl.href}`);
  }
  const duplicateApproval = await request(port, host, interactionPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(cookies) },
    body: encodeForm({ decision: 'approve', authorization_secret: authorizationSecret }),
  });
  if (duplicateApproval.status !== 409 || !duplicateApproval.body.includes('授权请求已处理或已过期')) {
    throw new Error(`Duplicate authorization submit was not handled gracefully: ${duplicateApproval.status} ${duplicateApproval.body.slice(0, 500)}`);
  }

  const tokenResponse = await request(port, host, oauthPath('/oauth/token'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-Proto': 'http',
      'X-Forwarded-Host': 'internal-proxy.invalid',
    },
    body: encodeForm({
      grant_type: 'authorization_code',
      code,
      client_id: privateJwtRegistration.client_id,
      redirect_uri: callback,
      code_verifier: verifier,
      resource,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await privateJwtAssertion(),
    }),
  });
  const tokens = JSON.parse(tokenResponse.body);
  if (tokenResponse.status !== 200 || !tokens.access_token || !tokens.refresh_token || tokens.token_type !== 'Bearer') {
    throw new Error(`Token exchange failed: ${tokenResponse.body}`);
  }

  const authenticated = await request(port, host, mcpPath, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'builtin-oauth-smoke', version: '1' } },
    }),
  });
  if (authenticated.status !== 200 || !authenticated.body.includes(`workspace:${workspace}`)) {
    throw new Error(`JWT access token did not authenticate MCP: ${authenticated.status} ${authenticated.body.slice(0, 500)}`);
  }

  const refreshResponse = await request(port, host, oauthPath('/oauth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: privateJwtRegistration.client_id,
      resource,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await privateJwtAssertion(),
    }),
  });
  const refreshed = JSON.parse(refreshResponse.body);
  if (refreshResponse.status !== 200 || !refreshed.access_token || !refreshed.refresh_token || refreshed.refresh_token === tokens.refresh_token) {
    throw new Error(`Refresh-token rotation failed: ${refreshResponse.body}`);
  }

  const replayResponse = await request(port, host, oauthPath('/oauth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: privateJwtRegistration.client_id,
      resource,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await privateJwtAssertion(),
    }),
  });
  if (replayResponse.status !== 400 || JSON.parse(replayResponse.body).error !== 'invalid_grant') {
    throw new Error(`Rotated refresh token replay was not rejected: ${replayResponse.status} ${replayResponse.body}`);
  }

  const revokeDb = new DatabaseSync(path.join(root, 'state.db'), { enableForeignKeyConstraints: true });
  const revokeStore = new RuntimeRepository(revokeDb, defaultRuntimeSettingsFromEnv());
  const revokedRecords = revokeStore.revokeOAuthProviderIssuer(issuer);
  revokeStore.close();
  if (revokedRecords < 1) throw new Error(`OAuth issuer revocation removed no records for ${issuer}`);

  const revokedRefresh = await request(port, host, oauthPath('/oauth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      grant_type: 'refresh_token',
      refresh_token: refreshed.refresh_token,
      client_id: privateJwtRegistration.client_id,
      resource,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await privateJwtAssertion(),
    }),
  });
  const revokedRefreshError = JSON.parse(revokedRefresh.body).error;
  if (![400, 401].includes(revokedRefresh.status) || !['invalid_grant', 'invalid_client'].includes(revokedRefreshError)) {
    throw new Error(`Issuer revocation did not invalidate refresh token: ${revokedRefresh.status} ${revokedRefresh.body}`);
  }

  const { publicKey: rotatedPublicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let oldAccessAcceptedByRotatedKey = false;
  try {
    await jwtVerify(tokens.access_token, rotatedPublicKey, { issuer, audience: resource });
    oldAccessAcceptedByRotatedKey = true;
  } catch {}
  if (oldAccessAcceptedByRotatedKey) throw new Error('Old OAuth access token unexpectedly verified with a rotated signing key');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'oauth_bearer_challenge',
      'protected_resource_metadata',
      'authorization_server_metadata',
      'cimd_advertised',
      'jwks_public_key',
      'dynamic_client_registration',
      'private_key_jwt_client_metadata',
      'private_key_jwt_token_exchange',
      'proxy_headers_cannot_override_canonical_oauth_issuer',
      'pkce_s256_authorization',
      'authorization_secret_gate',
      'authorization_form_action_is_restricted',
      'authorization_single_submit_feedback',
      'resource_parameter_binding',
      'jwt_access_token_mcp_auth',
      'offline_access_refresh_token',
      'refresh_token_rotation',
      'refresh_token_replay_rejected',
      'issuer_revocation_invalidates_refresh_token',
      'signing_key_rotation_invalidates_access_token_signature',
    ],
  }, null, 2));
} catch (error) {
  throw new Error(`${error instanceof Error ? error.message : String(error)}\nRuntime stderr:\n${stderr}`);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}
