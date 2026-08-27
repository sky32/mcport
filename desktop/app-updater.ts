import { app } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type AppUpdateResult = {
  configured: boolean;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  downloadUrl?: string;
  publishedAt?: string;
  error?: 'not_configured' | 'not_found' | 'rate_limited' | 'network' | 'invalid_response';
};

// Set this in the release environment once the public GitHub repository is chosen.
// It deliberately has no guessed default: a wrong update source is worse than a
// visible configuration state.
type PackageUpdateConfig = { appUpdate?: { githubRepository?: string } };

function configuredRepository(): string {
  if (process.env.MCPORT_GITHUB_REPOSITORY) return process.env.MCPORT_GITHUB_REPOSITORY.trim();
  try {
    const packagePath = path.join(app.getAppPath(), 'package.json');
    const packageConfig = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageUpdateConfig;
    return String(packageConfig.appUpdate?.githubRepository || '').trim();
  } catch {
    return '';
  }
}

const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'MCPort Desktop',
  'X-GitHub-Api-Version': '2022-11-28',
};

function normalizeVersion(value: string): string {
  return String(value || '').trim().replace(/^v/i, '').split('+', 1)[0];
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => normalizeVersion(value).split('.').map((part) => {
    const match = /^(\d+)/.exec(part);
    return match ? Number(match[1]) : 0;
  });
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function platformAssetName(): { extensions: string[]; markers: string[] } {
  if (process.platform === 'darwin') {
    return { extensions: ['.dmg'], markers: [process.arch === 'arm64' ? 'arm64' : 'x64'] };
  }
  if (process.platform === 'win32') {
    return { extensions: ['.exe', '.msi'], markers: [process.arch === 'arm64' ? 'arm64' : 'x64'] };
  }
  return { extensions: ['.AppImage'], markers: [process.arch === 'arm64' ? 'arm64' : 'x64'] };
}

function chooseDownloadUrl(assets: unknown): string | undefined {
  if (!Array.isArray(assets)) return undefined;
  const { extensions, markers } = platformAssetName();
  const candidates = assets.filter((asset): asset is { name: string; browser_download_url: string } => {
    if (!asset || typeof asset !== 'object') return false;
    const item = asset as Record<string, unknown>;
    const name = String(item.name || '');
    const url = String(item.browser_download_url || '');
    return Boolean(url) && extensions.some((extension) => name.endsWith(extension))
      && markers.some((marker) => name.toLowerCase().includes(marker));
  });
  return candidates.length === 1 ? candidates[0].browser_download_url : undefined;
}

export async function checkForAppUpdate(currentVersion = app.getVersion()): Promise<AppUpdateResult> {
  const current = normalizeVersion(currentVersion);
  const repository = configuredRepository();
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    return { configured: false, currentVersion: current, updateAvailable: false, error: 'not_configured' };
  }
  const endpoint = `https://api.github.com/repos/${repository}/releases/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(endpoint, { headers: GITHUB_API_HEADERS, signal: controller.signal });
    if (response.status === 403 || response.status === 429) {
      return { configured: true, currentVersion: current, updateAvailable: false, error: 'rate_limited' };
    }
    if (response.status === 404) {
      return { configured: true, currentVersion: current, updateAvailable: false, error: 'not_found' };
    }
    if (!response.ok) {
      return { configured: true, currentVersion: current, updateAvailable: false, error: 'network' };
    }
    const payload = await response.json() as Record<string, unknown>;
    const tag = typeof payload.tag_name === 'string' ? payload.tag_name : '';
    const releaseUrl = typeof payload.html_url === 'string' ? payload.html_url : '';
    if (!tag || !new RegExp(`^https:\\/\\/github\\.com\\/${repository.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\/releases\\/`).test(releaseUrl)) {
      return { configured: true, currentVersion: current, updateAvailable: false, error: 'invalid_response' };
    }
    const latest = normalizeVersion(tag);
    return {
      configured: true,
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: compareVersions(latest, current) > 0,
      releaseUrl,
      downloadUrl: chooseDownloadUrl(payload.assets),
      publishedAt: typeof payload.published_at === 'string' ? payload.published_at : undefined,
    };
  } catch (error) {
    return {
      configured: true,
      currentVersion: current,
      updateAvailable: false,
      error: error instanceof Error && error.name === 'AbortError' ? 'network' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}
