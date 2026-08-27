import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type PackageMetadata = { version?: unknown };

export function applicationVersion(): string {
  const fromEnvironment = String(process.env.APP_VERSION || '').trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageMetadata;
    const version = String(packageMetadata.version || '').trim();
    if (version) return version;
  } catch {}
  return '0.1.0';
}
