import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { EnvHttpProxyAgent } from 'undici';
import { resolveExistingPath, resolveWritablePath } from './security.js';

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function copyWorkspaceFile(input: {
  root: string;
  from: string;
  to: string;
  overwrite: boolean;
  expectedSha256?: string;
  dryRun?: boolean;
}) {
  const source = await resolveExistingPath(input.root, input.from);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile()) throw new Error('copy_file supports files only');

  const target = await resolveWritablePath(input.root, input.to);
  if (source === target) throw new Error('copy_file source and destination must be different');

  let targetExists = true;
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile()) throw new Error('copy_file destination must be a file path');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') targetExists = false;
    else throw error;
  }
  if (targetExists && !input.overwrite) throw new Error(`Destination already exists: ${input.to}`);

  let actualSha256: string | undefined;
  if (input.expectedSha256) {
    actualSha256 = sha256(await readFile(source));
    if (actualSha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
      throw new Error(`SHA256 precondition failed for ${input.from}: expected ${input.expectedSha256.toLowerCase()}, actual ${actualSha256}`);
    }
  }

  if (!input.dryRun) {
    await copyFile(source, target, input.overwrite ? 0 : fsConstants.COPYFILE_EXCL);
  }

  return {
    ok: true,
    from: input.from,
    to: input.to,
    size: sourceInfo.size,
    overwrite: input.overwrite,
    dryRun: Boolean(input.dryRun),
    ...(actualSha256 ? { sha256: actualSha256 } : {}),
  };
}

const DEFAULT_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_IMPORT_MAX_BYTES = 100 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 30_000;
const MAX_IMPORT_REDIRECTS = 5;
const OPENAI_ATTACHMENT_HOST_SUFFIX = '.blob.core.windows.net';

const attachmentProxyAgent = new EnvHttpProxyAgent({
  httpProxy: process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy,
  httpsProxy: process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy,
});

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice('::ffff:'.length));
  return false;
}

async function resolvePublicHttpsTarget(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== 'https:') throw new Error('import_file attachment download URL must use HTTPS');
  if (url.username || url.password) throw new Error('import_file attachment download URL must not contain credentials');
  if (url.port && url.port !== '443') throw new Error('import_file attachment download URL only allows the default HTTPS port');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('import_file attachment download URL must resolve to a public host');
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isPrivateAddress(hostname)) throw new Error('import_file attachment download URL must not target a private or local address');
    return { address: hostname, family: literalFamily as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('import_file attachment download URL must resolve only to public addresses');
  }
  const selected = addresses[0];
  return { address: selected.address, family: selected.family as 4 | 6 };
}

function isOpenAiAttachmentUrl(url: URL, fileId: string): boolean {
  return fileId.startsWith('sediment://file_')
    && url.hostname.toLowerCase().endsWith(OPENAI_ATTACHMENT_HOST_SUFFIX);
}

function validateAttachmentUrl(url: URL, fileId: string): boolean {
  if (url.protocol !== 'https:') throw new Error('import_file attachment download URL must use HTTPS');
  if (url.username || url.password) throw new Error('import_file attachment download URL must not contain credentials');
  if (url.port && url.port !== '443') throw new Error('import_file attachment download URL only allows the default HTTPS port');
  return isOpenAiAttachmentUrl(url, fileId);
}

async function downloadViaAttachmentProxy(url: URL, maxBytes: number, redirects: number, fileId: string): Promise<{ data: Buffer; finalUrl: string; contentType: string | null }> {
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': 'MCPort-import_file/1.0', accept: '*/*' },
    signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
    dispatcher: attachmentProxyAgent,
  } as RequestInit & { dispatcher: EnvHttpProxyAgent });
  const status = response.status;
  if (status >= 300 && status < 400 && response.headers.get('location')) {
    if (redirects >= MAX_IMPORT_REDIRECTS) throw new Error(`import_file exceeded ${MAX_IMPORT_REDIRECTS} HTTPS redirects`);
    const nextUrl = new URL(response.headers.get('location')!, url);
    response.body?.cancel();
    if (!validateAttachmentUrl(nextUrl, fileId)) {
      throw new Error('import_file attachment redirect left the authorized OpenAI attachment host');
    }
    return downloadViaAttachmentProxy(nextUrl, maxBytes, redirects + 1, fileId);
  }
  if (status < 200 || status >= 300) throw new Error(`import_file HTTPS download failed with status ${status}`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.body?.cancel();
    throw new Error(`import_file source exceeds maxBytes (${maxBytes})`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`import_file source exceeds maxBytes (${maxBytes})`);
  return {
    data,
    finalUrl: url.toString(),
    contentType: response.headers.get('content-type'),
  };
}

async function downloadAttachmentFile(downloadUrl: string, maxBytes: number, redirects = 0, fileId = ''): Promise<{ data: Buffer; finalUrl: string; contentType: string | null }> {
  if (redirects > MAX_IMPORT_REDIRECTS) throw new Error(`import_file exceeded ${MAX_IMPORT_REDIRECTS} HTTPS redirects`);
  const url = new URL(downloadUrl);
  const isOpenAiAttachment = validateAttachmentUrl(url, fileId);
  if (isOpenAiAttachment) return downloadViaAttachmentProxy(url, maxBytes, redirects, fileId);
  const resolved = await resolvePublicHttpsTarget(url);
  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options?.all) {
          callback(null, [{ address: resolved.address, family: resolved.family }]);
          return;
        }
        callback(null, resolved.address, resolved.family);
      },
      headers: { 'user-agent': 'MCPort-import_file/1.0', accept: '*/*' },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        void downloadAttachmentFile(nextUrl, maxBytes, redirects + 1, fileId).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`import_file HTTPS download failed with status ${status}`));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        reject(new Error(`import_file source exceeds maxBytes (${maxBytes})`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer | Uint8Array) => {
        const buffer = Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
          response.destroy(new Error(`import_file source exceeds maxBytes (${maxBytes})`));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => resolve({
        data: Buffer.concat(chunks, total),
        finalUrl: url.toString(),
        contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null,
      }));
      response.on('error', reject);
    });
    req.setTimeout(IMPORT_TIMEOUT_MS, () => req.destroy(new Error(`import_file HTTPS download timed out after ${IMPORT_TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

export async function importWorkspaceFile(input: {
  root: string;
  downloadUrl: string;
  fileId: string;
  to: string;
  overwrite: boolean;
  expectedSha256?: string;
  maxBytes?: number;
  dryRun?: boolean;
}) {
  const maxBytes = Math.min(Math.max(1, input.maxBytes ?? DEFAULT_IMPORT_MAX_BYTES), MAX_IMPORT_MAX_BYTES);
  const target = await resolveWritablePath(input.root, input.to);
  let targetExists = true;
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isFile()) throw new Error('import_file destination must be a file path');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') targetExists = false;
    else throw error;
  }
  if (targetExists && !input.overwrite) throw new Error(`Destination already exists: ${input.to}`);

  if (input.dryRun) {
    const url = new URL(input.downloadUrl);
    if (!validateAttachmentUrl(url, input.fileId)) await resolvePublicHttpsTarget(url);
    return {
      ok: true,
      sourceType: 'client_file',
      to: input.to,
      overwrite: input.overwrite,
      maxBytes,
      dryRun: true,
    };
  }

  const imported = await downloadAttachmentFile(input.downloadUrl, maxBytes, 0, input.fileId);
  const data = imported.data;
  if (data.length > maxBytes) throw new Error(`import_file source exceeds maxBytes (${maxBytes})`);
  const actualSha256 = sha256(data);
  if (input.expectedSha256 && actualSha256 !== input.expectedSha256.toLowerCase()) {
    throw new Error(`SHA256 precondition failed for import source: expected ${input.expectedSha256.toLowerCase()}, actual ${actualSha256}`);
  }
  await writeFile(target, data, { flag: input.overwrite ? 'w' : 'wx' });
  return {
    ok: true,
    sourceType: 'client_file',
    to: input.to,
    size: data.length,
    sha256: actualSha256,
    contentType: input.downloadUrl && 'contentType' in imported ? imported.contentType : null,
    finalUrl: input.downloadUrl && 'finalUrl' in imported ? imported.finalUrl : null,
    overwrite: input.overwrite,
    maxBytes,
    dryRun: false,
  };
}
