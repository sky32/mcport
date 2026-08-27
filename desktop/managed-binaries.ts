import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

export type ManagedBinaryKind = 'cloudflared' | 'frpc';

export type ManagedBinaryStatus = {
  kind: ManagedBinaryKind;
  installed: boolean;
  version: string;
  path: string;
  previousVersion: string;
  installedVersions: string[];
};

export type ManagedBinaryInstallProgress = {
  kind: ManagedBinaryKind;
  phase: 'resolving' | 'downloading' | 'verifying' | 'installing' | 'activating' | 'complete';
  percent: number;
  message: string;
  version?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

type ManagedBinaryProgressReporter = (progress: ManagedBinaryInstallProgress) => void;

type ManagedBinaryMetadata = {
  version: string;
  path: string;
  installedAt?: string;
  previousVersion?: string;
  previousPath?: string;
};

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
  digest?: string | null;
};

type GithubRelease = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const REPOSITORIES: Record<ManagedBinaryKind, string> = {
  cloudflared: 'cloudflare/cloudflared',
  frpc: 'fatedier/frp',
};
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_RELEASE_HTML_BYTES = 2 * 1024 * 1024;

function platformArch(): { platform: string; arch: string } {
  const platform = process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return { platform, arch };
}

async function readBoundedDownload(
  response: Response,
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`下载文件过大：${declared} bytes，最大允许 ${MAX_DOWNLOAD_BYTES} bytes`);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error(`下载文件超过 ${MAX_DOWNLOAD_BYTES} bytes 上限`);
    onProgress?.(buffer.length, declared > 0 ? declared : buffer.length);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel('download size limit exceeded').catch(() => {});
        throw new Error(`下载文件超过 ${MAX_DOWNLOAD_BYTES} bytes 上限`);
      }
      chunks.push(chunk);
      onProgress?.(total, declared > 0 ? declared : null);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedText(response: Response, maxBytes = MAX_RELEASE_HTML_BYTES): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Release 页面过大：${declared} bytes，最大允许 ${maxBytes} bytes`);
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`Release 页面超过 ${maxBytes} bytes 上限`);
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('release html size limit exceeded').catch(() => {});
        throw new Error(`Release 页面超过 ${maxBytes} bytes 上限`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function expectedAssetName(kind: ManagedBinaryKind, version: string): string {
  const { platform, arch } = platformArch();
  const cleanVersion = version.replace(/^v/, '');
  if (kind === 'cloudflared') {
    if (platform === 'darwin') return `cloudflared-darwin-${arch}.tgz`;
    if (platform === 'win32') return `cloudflared-windows-${arch}.exe`;
    return `cloudflared-linux-${arch}`;
  }
  const frpPlatform = platform === 'win32' ? 'windows' : platform;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return `frp_${cleanVersion}_${frpPlatform}_${arch}.${ext}`;
}

function selectAsset(kind: ManagedBinaryKind, version: string, assets: ReleaseAsset[]): ReleaseAsset {
  const expected = expectedAssetName(kind, version);
  const asset = assets.find((item) => item.name === expected);
  if (!asset?.browser_download_url) throw new Error(`没有找到当前平台对应的 ${kind} Release 资产：${expected}`);
  if (!asset.digest?.startsWith('sha256:')) throw new Error(`${kind} Release 未提供 SHA256 digest，拒绝安装`);
  return asset;
}

function githubApiFailure(kind: ManagedBinaryKind, response: Response): string {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const limit = response.headers.get('x-ratelimit-limit');
  const reset = Number(response.headers.get('x-ratelimit-reset') || 0);
  const rateLimited = (response.status === 403 || response.status === 429) && remaining === '0';
  if (!rateLimited) return `${kind} Release 查询失败：HTTP ${response.status}`;
  const resetText = Number.isFinite(reset) && reset > 0 ? `，预计 ${new Date(reset * 1000).toISOString()} 恢复` : '';
  return `${kind} GitHub API 已限流（剩余 ${remaining}/${limit || '?'}）${resetText}`;
}

function shouldFallbackFromGithubApi(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function releaseTagFromGithubText(repository: string, value: string): string {
  if (!value) return '';
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:https://github\\.com)?/${escapedRepository}/releases/tag/([^"'<>/?#\\s]+)`, 'i').exec(value);
  if (!match?.[1]) return '';
  try {
    return normalizeVersionTag(decodeURIComponent(match[1]));
  } catch {
    return '';
  }
}

async function resolveLatestGithubReleaseTag(repository: string, fetcher: FetchLike): Promise<string> {
  const failures: string[] = [];
  const latestResponse = await fetcher(`https://github.com/${repository}/releases/latest`, {
    headers: { 'User-Agent': 'MCPort' },
    cache: 'no-store',
    redirect: 'follow',
  });
  if (latestResponse.ok) {
    const redirectedTag = releaseTagFromGithubText(repository, latestResponse.url);
    if (redirectedTag) return redirectedTag;
    try {
      const latestHtml = await readBoundedText(latestResponse);
      const markupTag = releaseTagFromGithubText(repository, latestHtml);
      if (markupTag) return markupTag;
      failures.push('latest 页面未包含 Release tag');
    } catch (error) {
      failures.push(`latest 页面读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    failures.push(`latest 页面 HTTP ${latestResponse.status}`);
  }

  const atomResponse = await fetcher(`https://github.com/${repository}/releases.atom`, {
    headers: { Accept: 'application/atom+xml', 'User-Agent': 'MCPort' },
    cache: 'no-store',
  });
  if (atomResponse.ok) {
    try {
      const atom = await readBoundedText(atomResponse);
      const atomTag = releaseTagFromGithubText(repository, atom);
      if (atomTag) return atomTag;
      failures.push('releases.atom 未包含 Release tag');
    } catch (error) {
      failures.push(`releases.atom 读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    failures.push(`releases.atom HTTP ${atomResponse.status}`);
  }
  throw new Error(`GitHub 无法解析最新 Release 版本：${failures.join('；')}`);
}

async function releaseFromGithubHtml(
  repository: string,
  kind: ManagedBinaryKind,
  fetcher: FetchLike,
  requested: string,
): Promise<GithubRelease> {
  let version = requested;
  if (!version) version = await resolveLatestGithubReleaseTag(repository, fetcher);

  const assetName = expectedAssetName(kind, version);
  const expandedResponse = await fetcher(`https://github.com/${repository}/releases/expanded_assets/${encodeURIComponent(version)}`, {
    headers: { 'User-Agent': 'MCPort' },
    cache: 'no-store',
  });
  if (!expandedResponse.ok) throw new Error(`GitHub Release 资产页面查询失败：HTTP ${expandedResponse.status}`);
  const html = await readBoundedText(expandedResponse);
  const escapedAssetName = assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hrefPattern = new RegExp(`href="([^"]*\\/releases\\/download\\/[^"]*\\/${escapedAssetName})"`, 'i');
  const hrefMatch = hrefPattern.exec(html);
  if (!hrefMatch || hrefMatch.index < 0) throw new Error(`GitHub Release 页面未找到资产：${assetName}`);
  const nextAssetIndex = html.indexOf('/releases/download/', hrefMatch.index + hrefMatch[0].length);
  const assetBlock = html.slice(hrefMatch.index, nextAssetIndex >= 0 ? nextAssetIndex : Math.min(html.length, hrefMatch.index + 8192));
  const digestMatch = assetBlock.match(/sha256:([a-f0-9]{64})/i);
  if (!digestMatch) throw new Error(`${kind} Release 页面未提供 ${assetName} 的 SHA256 digest，拒绝安装`);
  const downloadUrl = new URL(hrefMatch[1], 'https://github.com').toString();
  return {
    tag_name: version,
    assets: [{ name: assetName, browser_download_url: downloadUrl, digest: `sha256:${digestMatch[1].toLowerCase()}` }],
  };
}

function verifyDigest(buffer: Buffer, digest: string): void {
  const expected = digest.replace(/^sha256:/, '').toLowerCase();
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) throw new Error(`下载文件 SHA256 校验失败：expected=${expected} actual=${actual}`);
}

function tarString(buffer: Buffer, start: number, length: number): string {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function extractTarFile(archive: Buffer, basename: string): Buffer {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header, 124, 12).replace(/\0/g, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('TAR 文件大小字段无效');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error('TAR 文件内容越界');
    if (path.posix.basename(fullName) === basename) return archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`压缩包中未找到 ${basename}`);
}

function extractZipFile(archive: Buffer, basename: string): Buffer {
  let eocd = -1;
  const minOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 缺少 End of Central Directory');
  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount && offset + 46 <= archive.length; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP Central Directory 结构无效');
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (path.posix.basename(name) === basename) {
      if (localHeaderOffset + 30 > archive.length || archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error('ZIP Local Header 结构无效');
      }
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > archive.length) throw new Error('ZIP 压缩数据越界');
      const payload = archive.subarray(dataStart, dataEnd);
      if (uncompressedSize > MAX_EXTRACTED_BYTES) throw new Error(`ZIP 解压文件超过 ${MAX_EXTRACTED_BYTES} bytes 上限`);
      const result = method === 0 ? payload : method === 8 ? inflateRawSync(payload, { maxOutputLength: MAX_EXTRACTED_BYTES }) : null;
      if (!result) throw new Error(`不支持的 ZIP 压缩算法：${method}`);
      if (uncompressedSize && result.length !== uncompressedSize) throw new Error('ZIP 解压后的文件大小不匹配');
      return result;
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP 中未找到 ${basename}`);
}

function binaryFromDownload(kind: ManagedBinaryKind, assetName: string, download: Buffer): Buffer {
  const binaryName = kind === 'cloudflared'
    ? process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
    : process.platform === 'win32' ? 'frpc.exe' : 'frpc';
  if (assetName.endsWith('.tgz') || assetName.endsWith('.tar.gz')) {
    return extractTarFile(gunzipSync(download, { maxOutputLength: MAX_EXTRACTED_BYTES }), binaryName);
  }
  if (assetName.endsWith('.zip')) return extractZipFile(download, binaryName);
  return download;
}

function binaryName(kind: ManagedBinaryKind): string {
  if (process.platform !== 'win32') return kind === 'frpc' ? 'frpc' : 'cloudflared';
  return kind === 'frpc' ? 'frpc.exe' : 'cloudflared.exe';
}

function toolRoot(userData: string, kind: ManagedBinaryKind): string {
  return path.join(userData, 'managed-tools', kind);
}

function currentMetadataPath(userData: string, kind: ManagedBinaryKind): string {
  return path.join(toolRoot(userData, kind), 'current.json');
}

function normalizeVersionTag(value: string): string {
  const version = value.trim();
  if (!version) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)) throw new Error(`非法版本号：${version}`);
  return version;
}

function versionsEquivalent(a: string, b: string): boolean {
  return a.replace(/^v/, '') === b.replace(/^v/, '');
}

async function readCurrentMetadata(userData: string, kind: ManagedBinaryKind): Promise<ManagedBinaryMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(currentMetadataPath(userData, kind), 'utf8')) as ManagedBinaryMetadata;
    const version = normalizeVersionTag(String(parsed?.version || ''));
    if (!version) return null;
    const normalized: ManagedBinaryMetadata = {
      version,
      path: path.join(toolRoot(userData, kind), version, binaryName(kind)),
      ...(parsed.installedAt ? { installedAt: String(parsed.installedAt) } : {}),
    };
    try {
      const previousVersion = normalizeVersionTag(String(parsed.previousVersion || ''));
      if (previousVersion) {
        normalized.previousVersion = previousVersion;
        normalized.previousPath = path.join(toolRoot(userData, kind), previousVersion, binaryName(kind));
      }
    } catch {}
    return normalized;
  } catch {
    return null;
  }
}

async function installedVersions(userData: string, kind: ManagedBinaryKind): Promise<string[]> {
  const root = toolRoot(userData, kind);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const versions: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, binaryName(kind));
      try {
        const info = await stat(candidate);
        if (info.isFile()) versions.push(entry.name);
      } catch {}
    }
    return versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function writeCurrentMetadata(userData: string, kind: ManagedBinaryKind, metadata: ManagedBinaryMetadata): Promise<void> {
  const metadataPath = currentMetadataPath(userData, kind);
  const metadataTemp = `${metadataPath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await writeFile(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await rename(metadataTemp, metadataPath);
}

async function activateInstalledVersion(
  userData: string,
  kind: ManagedBinaryKind,
  version: string,
  previous: ManagedBinaryMetadata | null,
): Promise<ManagedBinaryStatus> {
  const finalPath = path.join(toolRoot(userData, kind), version, binaryName(kind));
  const info = await stat(finalPath);
  if (!info.isFile()) throw new Error(`${kind} ${version} 已安装路径不是文件`);
  const same = previous && versionsEquivalent(previous.version, version);
  await writeCurrentMetadata(userData, kind, {
    version,
    path: finalPath,
    installedAt: new Date().toISOString(),
    ...(!same && previous?.version && previous.path ? { previousVersion: previous.version, previousPath: previous.path } : {
      ...(previous?.previousVersion ? { previousVersion: previous.previousVersion } : {}),
      ...(previous?.previousPath ? { previousPath: previous.previousPath } : {}),
    }),
  });
  return managedBinaryStatus(userData, kind);
}
export async function managedBinaryStatus(userData: string, kind: ManagedBinaryKind): Promise<ManagedBinaryStatus> {
  const versions = await installedVersions(userData, kind);
  try {
    const metadata = await readCurrentMetadata(userData, kind);
    if (!metadata) throw new Error('missing metadata');
    const binaryPath = String(metadata.path || '');
    if (!binaryPath) throw new Error('missing path');
    const info = await stat(binaryPath);
    if (!info.isFile()) throw new Error('not a file');
    return {
      kind,
      installed: true,
      version: String(metadata.version || ''),
      path: binaryPath,
      previousVersion: String(metadata.previousVersion || ''),
      installedVersions: versions,
    };
  } catch {
    return { kind, installed: false, version: '', path: '', previousVersion: '', installedVersions: versions };
  }
}

export async function latestManagedBinaryVersion(
  kind: ManagedBinaryKind,
  fetcher: FetchLike,
): Promise<string> {
  const repository = REPOSITORIES[kind];
  const releaseResponse = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MCPort' },
    cache: 'no-store',
  });
  if (releaseResponse.ok) {
    const release = await releaseResponse.json() as GithubRelease;
    const version = String(release.tag_name || '').trim();
    if (!version) throw new Error(`${kind} Release 缺少版本号`);
    return normalizeVersionTag(version);
  }
  if (!shouldFallbackFromGithubApi(releaseResponse.status)) {
    throw new Error(githubApiFailure(kind, releaseResponse));
  }
  const apiFailure = githubApiFailure(kind, releaseResponse);
  try {
    return await resolveLatestGithubReleaseTag(repository, fetcher);
  } catch (fallbackError) {
    throw new Error(`${apiFailure}；最新版本 fallback 也失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
  }
}

export async function installManagedBinary(
  userData: string,
  kind: ManagedBinaryKind,
  fetcher: FetchLike,
  requestedVersion = '',
  onProgress?: ManagedBinaryProgressReporter,
): Promise<ManagedBinaryStatus> {
  const report = (phase: ManagedBinaryInstallProgress['phase'], percent: number, message: string, extra: Partial<ManagedBinaryInstallProgress> = {}) => {
    onProgress?.({ kind, phase, percent: Math.max(0, Math.min(100, Math.round(percent))), message, ...extra });
  };
  report('resolving', 5, `正在查询 ${kind} Release…`);
  const repository = REPOSITORIES[kind];
  const requested = normalizeVersionTag(requestedVersion);
  const releaseEndpoint = requested
    ? `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(requested)}`
    : `https://api.github.com/repos/${repository}/releases/latest`;
  const releaseResponse = await fetcher(releaseEndpoint, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MCPort' },
    cache: 'no-store',
  });
  let release: GithubRelease;
  if (releaseResponse.ok) {
    release = await releaseResponse.json() as GithubRelease;
  } else if (shouldFallbackFromGithubApi(releaseResponse.status)) {
    const apiFailure = githubApiFailure(kind, releaseResponse);
    try {
      release = await releaseFromGithubHtml(repository, kind, fetcher, requested);
    } catch (fallbackError) {
      throw new Error(`${apiFailure}；Release 页面 fallback 也失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  } else {
    throw new Error(githubApiFailure(kind, releaseResponse));
  }
  const version = String(release.tag_name || '').trim();
  if (!version) throw new Error(`${kind} Release 缺少版本号`);
  report('resolving', 18, `已解析版本 ${version}`, { version });
  normalizeVersionTag(version);
  if (requested && !versionsEquivalent(requested, version)) throw new Error(`${kind} Release 版本不匹配：requested=${requested} actual=${version}`);
  const previous = await readCurrentMetadata(userData, kind);
  const existingPath = path.join(toolRoot(userData, kind), version, binaryName(kind));
  try {
    if ((await stat(existingPath)).isFile()) {
      report('activating', 90, `本地已有 ${version}，正在切换…`, { version });
      const activated = await activateInstalledVersion(userData, kind, version, previous);
      report('complete', 100, `${kind} ${version} 已就绪`, { version });
      return activated;
    }
  } catch {}
  const asset = selectAsset(kind, version, Array.isArray(release.assets) ? release.assets : []);
  const assetName = String(asset.name);
  report('downloading', 25, `正在下载 ${assetName}…`, { version });
  const downloadResponse = await fetcher(String(asset.browser_download_url), {
    headers: { 'User-Agent': 'MCPort' },
    cache: 'no-store',
    redirect: 'follow',
  });
  if (!downloadResponse.ok) throw new Error(`${kind} 下载失败：HTTP ${downloadResponse.status}`);
  const download = await readBoundedDownload(downloadResponse, (downloadedBytes, totalBytes) => {
    const ratio = totalBytes && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0;
    report('downloading', totalBytes ? 25 + ratio * 50 : 45, totalBytes
      ? `正在下载 ${assetName} · ${Math.round(ratio * 100)}%`
      : `正在下载 ${assetName} · ${(downloadedBytes / 1024 / 1024).toFixed(1)} MiB`, {
      version,
      downloadedBytes,
      ...(totalBytes ? { totalBytes } : {}),
    });
  });
  report('verifying', 80, '正在校验 SHA256…', { version, downloadedBytes: download.length });
  verifyDigest(download, String(asset.digest));
  report('installing', 88, '正在解压并准备客户端文件…', { version });
  const binary = binaryFromDownload(kind, assetName, download);
  if (!binary.length) throw new Error(`${kind} Release 中的客户端文件为空`);
  const versionDir = path.join(toolRoot(userData, kind), version);
  const finalPath = path.join(versionDir, binaryName(kind));
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  report('installing', 94, `正在安装 ${kind} ${version}…`, { version });
  await mkdir(versionDir, { recursive: true });
  await writeFile(tempPath, binary, { mode: 0o755 });
  if (process.platform !== 'win32') await chmod(tempPath, 0o755);
  await rename(tempPath, finalPath);
  report('activating', 98, `正在激活 ${kind} ${version}…`, { version });
  const activated = await activateInstalledVersion(userData, kind, version, previous);
  report('complete', 100, `${kind} ${version} 已安装并通过校验`, { version });
  return activated;
}

export async function installLatestManagedBinary(
  userData: string,
  kind: ManagedBinaryKind,
  fetcher: FetchLike,
  onProgress?: ManagedBinaryProgressReporter,
): Promise<ManagedBinaryStatus> {
  return installManagedBinary(userData, kind, fetcher, '', onProgress);
}

export async function rollbackManagedBinary(userData: string, kind: ManagedBinaryKind): Promise<ManagedBinaryStatus> {
  const current = await readCurrentMetadata(userData, kind);
  if (!current?.previousVersion || !current.previousPath) throw new Error(`${kind} 没有可回滚的上一版本`);
  const previousInfo = await stat(current.previousPath);
  if (!previousInfo.isFile()) throw new Error(`${kind} 上一版本文件已不存在：${current.previousVersion}`);
  await writeCurrentMetadata(userData, kind, {
    version: current.previousVersion,
    path: current.previousPath,
    installedAt: new Date().toISOString(),
    previousVersion: current.version,
    previousPath: current.path,
  });
  return managedBinaryStatus(userData, kind);
}
