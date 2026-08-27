import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { installLatestManagedBinary, installManagedBinary, latestManagedBinaryVersion, managedBinaryStatus, rollbackManagedBinary } from '../dist-desktop/managed-binaries.js';

const root = path.resolve('data', `managed-binaries-smoke-${process.pid}-${Date.now()}`);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function tar(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding, Buffer.alloc(1024, 0)]);
}

function platformArch() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  return { platform: process.platform, arch };
}

function fixture(kind, version = kind === 'frpc' ? 'vtest' : 'test') {
  const { platform, arch } = platformArch();
  const binaryName = process.platform === 'win32'
    ? kind === 'frpc' ? 'frpc.exe' : 'cloudflared.exe'
    : kind === 'frpc' ? 'frpc' : 'cloudflared';
  const content = Buffer.from(`#!/bin/sh\necho ${kind}-${version}-managed-smoke\n`);
  if (kind === 'cloudflared') {
    if (platform === 'darwin') {
      const name = `cloudflared-darwin-${arch}.tgz`;
      return { name, download: gzipSync(tar(binaryName, content)) };
    }
    if (platform === 'linux') return { name: `cloudflared-linux-${arch}`, download: content };
  }
  if (kind === 'frpc' && platform !== 'win32') {
    const cleanVersion = version.replace(/^v/, '');
    const name = `frp_${cleanVersion}_${platform}_${arch}.tar.gz`;
    return { name, download: gzipSync(tar(`frp_${cleanVersion}_${platform}_${arch}/${binaryName}`, content)) };
  }
  return null;
}

async function install(kind) {
  const version = kind === 'frpc' ? 'vtest' : 'test';
  const asset = fixture(kind, version);
  if (!asset) return { skipped: true };
  const assetUrl = `https://example.invalid/${asset.name}`;
  const release = {
    tag_name: version,
    assets: [{ name: asset.name, browser_download_url: assetUrl, digest: `sha256:${sha(asset.download)}` }],
  };
  const fetcher = async (url) => {
    if (String(url).includes('/releases/latest')) return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url) === assetUrl) return new Response(asset.download, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const installed = await installLatestManagedBinary(root, kind, fetcher);
  const status = await managedBinaryStatus(root, kind);
  if (!installed.installed || !status.installed || installed.path !== status.path) throw new Error(`${kind} managed install state mismatch`);
  return { version: installed.version, path: installed.path };
}

async function installAndRollbackCloudflared() {
  const releases = new Map();
  for (const version of ['test1', 'test2']) {
    const asset = fixture('cloudflared', version);
    if (!asset) return { skipped: true };
    const url = `https://example.invalid/${version}/${asset.name}`;
    releases.set(version, {
      release: { tag_name: version, assets: [{ name: asset.name, browser_download_url: url, digest: `sha256:${sha(asset.download)}` }] },
      url,
      download: asset.download,
    });
  }
  const fetcher = async (url) => {
    const value = String(url);
    const tag = value.match(/\/releases\/tags\/([^/?]+)/)?.[1];
    if (tag && releases.has(decodeURIComponent(tag))) {
      return new Response(JSON.stringify(releases.get(decodeURIComponent(tag)).release), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    for (const record of releases.values()) if (value === record.url) return new Response(record.download, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const progress = [];
  const first = await installManagedBinary(root, 'cloudflared', fetcher, 'test1', (event) => progress.push(event));
  const second = await installManagedBinary(root, 'cloudflared', fetcher, 'test2', (event) => progress.push(event));
  if (second.version !== 'test2' || second.previousVersion !== 'test1' || second.installedVersions.length < 2) {
    throw new Error(`Managed version history mismatch: ${JSON.stringify(second)}`);
  }
  const rolled = await rollbackManagedBinary(root, 'cloudflared');
  if (rolled.version !== 'test1' || rolled.previousVersion !== 'test2') throw new Error(`Managed rollback failed: ${JSON.stringify(rolled)}`);
  const phases = new Set(progress.map((event) => event.phase));
  for (const required of ['resolving', 'downloading', 'verifying', 'installing', 'activating', 'complete']) {
    if (!phases.has(required)) throw new Error(`Managed install progress missing phase ${required}: ${JSON.stringify(progress)}`);
  }
  if (!progress.some((event) => event.phase === 'complete' && event.percent === 100)) {
    throw new Error(`Managed install progress never reached 100%: ${JSON.stringify(progress)}`);
  }
  return { first: first.version, second: second.version, rolledBackTo: rolled.version, progressPhases: [...phases] };
}

async function verifyManagedMetadataPathIsConfined() {
  const kind = 'cloudflared';
  const installed = await install(kind);
  if (installed.skipped) return { skipped: true };
  const metadataPath = path.join(root, 'managed-tools', kind, 'current.json');
  await writeFile(metadataPath, `${JSON.stringify({ version: installed.version, path: process.execPath }, null, 2)}\n`, 'utf8');
  const status = await managedBinaryStatus(root, kind);
  if (!status.installed || status.path === process.execPath || !status.path.startsWith(path.join(root, 'managed-tools', kind))) {
    throw new Error(`Managed metadata path escaped managed-tools: ${JSON.stringify(status)}`);
  }
  return { path: status.path };
}

async function verifyDigestMismatchRejected() {
  const kind = process.platform === 'win32' ? 'cloudflared' : 'frpc';
  const version = kind === 'frpc' ? 'vbad-digest' : 'bad-digest';
  const asset = fixture(kind, version);
  if (!asset) return { skipped: true };
  const assetUrl = `https://example.invalid/bad-digest/${asset.name}`;
  const release = {
    tag_name: version,
    assets: [{ name: asset.name, browser_download_url: assetUrl, digest: `sha256:${'0'.repeat(64)}` }],
  };
  const fetcher = async (url) => {
    if (String(url).includes('/releases/tags/')) return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url) === assetUrl) return new Response(asset.download, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  let rejected = false;
  try {
    await installManagedBinary(path.join(root, 'bad-digest'), kind, fetcher, version);
  } catch (error) {
    rejected = String(error?.message || error).includes('SHA256');
  }
  if (!rejected) throw new Error('Managed installer accepted an asset with a mismatched digest');
  return { rejected: true };
}

async function verifyTruncatedTarRejected() {
  if (process.platform === 'win32') return { skipped: true };
  const kind = 'frpc';
  const version = 'vbad-tar';
  const { platform, arch } = platformArch();
  const cleanVersion = version.replace(/^v/, '');
  const assetName = `frp_${cleanVersion}_${platform}_${arch}.tar.gz`;
  const header = Buffer.alloc(512, 0);
  header.write(`frp_${cleanVersion}_${platform}_${arch}/frpc`, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${(1024 * 1024).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  const download = gzipSync(Buffer.concat([header, Buffer.from('short') ]));
  const assetUrl = `https://example.invalid/bad-tar/${assetName}`;
  const release = { tag_name: version, assets: [{ name: assetName, browser_download_url: assetUrl, digest: `sha256:${sha(download)}` }] };
  const fetcher = async (url) => {
    if (String(url).includes('/releases/tags/')) return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url) === assetUrl) return new Response(download, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  let rejected = false;
  try {
    await installManagedBinary(path.join(root, 'bad-tar'), kind, fetcher, version);
  } catch (error) {
    rejected = String(error?.message || error).includes('TAR 文件内容越界');
  }
  if (!rejected) throw new Error('Managed installer accepted a truncated TAR member');
  return { rejected: true };
}

async function verifyOversizedDownloadRejected() {
  const { platform, arch } = platformArch();
  const version = 'oversize';
  const assetName = platform === 'darwin'
    ? `cloudflared-darwin-${arch}.tgz`
    : platform === 'win32'
      ? `cloudflared-windows-${arch}.exe`
      : `cloudflared-linux-${arch}`;
  const tinyBody = Buffer.from('not-actually-large');
  const assetUrl = `https://example.invalid/oversize/${assetName}`;
  const release = { tag_name: version, assets: [{ name: assetName, browser_download_url: assetUrl, digest: `sha256:${sha(tinyBody)}` }] };
  const fetcher = async (url) => {
    if (String(url).includes('/releases/tags/')) return new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url) === assetUrl) return new Response(tinyBody, { status: 200, headers: { 'content-length': String(256 * 1024 * 1024 + 1) } });
    return new Response('not found', { status: 404 });
  };
  let rejected = false;
  try {
    await installManagedBinary(path.join(root, 'oversize'), 'cloudflared', fetcher, version);
  } catch (error) {
    rejected = String(error?.message || error).includes('下载文件过大');
  }
  if (!rejected) throw new Error('Managed installer accepted an oversized download');
  return { rejected: true };
}

async function verifyGithubApiRateLimitFallback() {
  const kind = 'cloudflared';
  const version = '2026.8.2';
  const asset = fixture(kind, version);
  if (!asset) return { skipped: true };
  const repository = 'cloudflare/cloudflared';
  const assetPath = `/${repository}/releases/download/${version}/${asset.name}`;
  const assetUrl = `https://github.com${assetPath}`;
  const expandedHtml = [
    `<a href="${assetPath}"><span class="Truncate-text text-bold">${asset.name}</span></a>`,
    `<span class="Truncate-text">sha256:${sha(asset.download)}</span>`,
  ].join('');
  let apiCalls = 0;
  let latestPageCalls = 0;
  let atomCalls = 0;
  let expandedAssetCalls = 0;
  const fetcher = async (url) => {
    const value = String(url);
    if (value === `https://api.github.com/repos/${repository}/releases/latest`) {
      apiCalls += 1;
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      });
    }
    if (value === `https://github.com/${repository}/releases/latest`) {
      latestPageCalls += 1;
      return new Response(`<html><head><meta property="og:url" content="https://github.com/${repository}/releases/tag/${version}"></head></html>`, { status: 200 });
    }
    if (value === `https://github.com/${repository}/releases.atom`) {
      atomCalls += 1;
      return new Response('unexpected atom fallback', { status: 500 });
    }
    if (value === `https://github.com/${repository}/releases/expanded_assets/${version}`) {
      expandedAssetCalls += 1;
      return new Response(expandedHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (value === assetUrl) return new Response(asset.download, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const installed = await installLatestManagedBinary(path.join(root, 'github-rate-limit-fallback'), kind, fetcher);
  if (!installed.installed || installed.version !== version) throw new Error(`GitHub API rate-limit fallback failed: ${JSON.stringify(installed)}`);
  if (apiCalls !== 1 || latestPageCalls !== 1 || atomCalls !== 0 || expandedAssetCalls !== 1) {
    throw new Error(`Unexpected GitHub fallback request counts: api=${apiCalls} latest=${latestPageCalls} atom=${atomCalls} assets=${expandedAssetCalls}`);
  }
  return { installed: true, version, apiCalls, latestPageCalls, atomCalls, expandedAssetCalls };
}

async function verifyGithubAtomFallback() {
  const kind = 'cloudflared';
  const version = '2026.8.3';
  const asset = fixture(kind, version);
  if (!asset) return { skipped: true };
  const repository = 'cloudflare/cloudflared';
  const assetPath = `/${repository}/releases/download/${version}/${asset.name}`;
  const assetUrl = `https://github.com${assetPath}`;
  const expandedHtml = [
    `<a href="${assetPath}"><span>${asset.name}</span></a>`,
    `<span>sha256:${sha(asset.download)}</span>`,
  ].join('');
  let atomCalls = 0;
  const fetcher = async (url) => {
    const value = String(url);
    if (value === `https://api.github.com/repos/${repository}/releases/latest`) {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' },
      });
    }
    if (value === `https://github.com/${repository}/releases/latest`) {
      return new Response('<html>no release tag here</html>', { status: 200 });
    }
    if (value === `https://github.com/${repository}/releases.atom`) {
      atomCalls += 1;
      return new Response(`<feed><entry><link rel="alternate" href="https://github.com/${repository}/releases/tag/${version}" /></entry></feed>`, { status: 200 });
    }
    if (value === `https://github.com/${repository}/releases/expanded_assets/${version}`) return new Response(expandedHtml, { status: 200 });
    if (value === assetUrl) return new Response(asset.download, { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const installed = await installLatestManagedBinary(path.join(root, 'github-atom-fallback'), kind, fetcher);
  if (!installed.installed || installed.version !== version || atomCalls !== 1) {
    throw new Error(`GitHub Atom fallback failed: ${JSON.stringify({ installed, atomCalls })}`);
  }
  return { installed: true, version, atomCalls };
}

async function verifyLatestVersionQueryOnly() {
  const repository = 'cloudflare/cloudflared';
  const version = '2026.8.4';
  const calls = [];
  const fetcher = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value === `https://api.github.com/repos/${repository}/releases/latest`) {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0' },
      });
    }
    if (value === `https://github.com/${repository}/releases/latest`) {
      return new Response(`<meta property="og:url" content="https://github.com/${repository}/releases/tag/${version}">`, { status: 200 });
    }
    throw new Error(`Latest-version lookup made an unexpected request: ${value}`);
  };
  const latest = await latestManagedBinaryVersion('cloudflared', fetcher);
  if (latest !== version || calls.length !== 2) throw new Error(`Latest-version query was not lookup-only: ${JSON.stringify({ latest, calls })}`);
  return { version: latest, calls: calls.length };
}

try {
  const cloudflared = await install('cloudflared');
  const frpc = await install('frpc');
  const rollback = await installAndRollbackCloudflared();
  const confinedMetadata = await verifyManagedMetadataPathIsConfined();
  const digestMismatch = await verifyDigestMismatchRejected();
  const truncatedTar = await verifyTruncatedTarRejected();
  const oversizedDownload = await verifyOversizedDownloadRejected();
  const githubApiRateLimitFallback = await verifyGithubApiRateLimitFallback();
  const githubAtomFallback = await verifyGithubAtomFallback();
  const latestVersionQueryOnly = await verifyLatestVersionQueryOnly();
  console.log(JSON.stringify({ ok: true, cloudflared, frpc, rollback, confinedMetadata, digestMismatch, truncatedTar, oversizedDownload, githubApiRateLimitFallback, githubAtomFallback, latestVersionQueryOnly, checks: ['release_digest_verified', 'release_digest_mismatch_rejected', 'managed_download_size_bound', 'atomic_managed_install', 'managed_binary_status', 'managed_metadata_path_confined', 'managed_truncated_tar_rejected', 'managed_version_pin', 'managed_version_rollback', 'github_api_rate_limit_release_html_fallback', 'github_latest_release_markup_without_response_url', 'github_release_atom_fallback', 'latest_version_query_without_download'] }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
