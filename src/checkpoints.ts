import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type CheckpointEntry = {
  path: string;
  state: 'file' | 'directory' | 'missing';
  size: number;
  sha256?: string;
};

export type WorkspaceCheckpointManifest = {
  version: 1;
  id: string;
  createdAt: string;
  label: string;
  requestedPaths: string[];
  entries: CheckpointEntry[];
  totalBytes: number;
};

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'dist-desktop', 'release']);
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function normalizeRelative(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (!normalized || normalized === '.') return '.';
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) throw new Error(`Invalid checkpoint path: ${value}`);
  return normalized;
}

function ensureInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Checkpoint path escapes workspace');
  return target;
}

function assertCheckpointId(id: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid checkpoint id');
}

function checkpointDir(root: string, id: string, storageRoot?: string): string {
  assertCheckpointId(id);
  const base = storageRoot ? path.resolve(storageRoot) : path.join(root, '.mcport', 'checkpoints');
  return path.join(base, id);
}

function checkpointBase(root: string, storageRoot?: string): string {
  return storageRoot ? path.resolve(storageRoot) : path.join(root, '.mcport', 'checkpoints');
}

function snapshotPathFromDir(dir: string, relativePath: string): string {
  const base = path.join(dir, 'files');
  return relativePath === '.' ? base : path.join(base, ...relativePath.split('/'));
}

async function readCheckpointAtDir(dir: string, id: string): Promise<WorkspaceCheckpointManifest> {
  const raw = await readFile(path.join(dir, 'manifest.json'), 'utf8');
  const parsed = JSON.parse(raw) as WorkspaceCheckpointManifest;
  if (parsed.version !== 1 || parsed.id !== id || !Array.isArray(parsed.entries)) throw new Error('Invalid checkpoint manifest');
  return parsed;
}

async function findCheckpointRecord(root: string, id: string, storageRoot?: string): Promise<{ manifest: WorkspaceCheckpointManifest; dir: string }> {
  assertCheckpointId(id);
  const dir = checkpointDir(root, id, storageRoot);
  try {
    return { manifest: await readCheckpointAtDir(dir, id), dir };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  throw new Error(`Checkpoint not found: ${id}`);
}

async function listCheckpointRecords(root: string, storageRoot?: string): Promise<Array<{ manifest: WorkspaceCheckpointManifest; dir: string }>> {
  const records = new Map<string, { manifest: WorkspaceCheckpointManifest; dir: string }>();
  const base = checkpointBase(root, storageRoot);
  if (await exists(base)) {
    for (const item of await readdir(base, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const dir = path.join(base, item.name);
      try {
        records.set(item.name, { manifest: await readCheckpointAtDir(dir, item.name), dir });
      } catch {}
    }
  }
  return [...records.values()].sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function collectPath(input: {
  root: string;
  relativePath: string;
  explicit: boolean;
  maxFileBytes: number;
  entries: CheckpointEntry[];
  files: Array<{ relativePath: string; absolutePath: string; size: number }>;
}): Promise<void> {
  const relativePath = normalizeRelative(input.relativePath);
  const absolutePath = ensureInside(input.root, relativePath);
  if (!(await exists(absolutePath))) {
    input.entries.push({ path: relativePath, state: 'missing', size: 0 });
    return;
  }
  const info = await stat(absolutePath);
  if (info.isFile()) {
    if (info.size > input.maxFileBytes) throw new Error(`Checkpoint file exceeds MAX_FILE_BYTES: ${relativePath}`);
    input.entries.push({ path: relativePath, state: 'file', size: info.size, sha256: await hashFile(absolutePath) });
    input.files.push({ relativePath, absolutePath, size: info.size });
    return;
  }
  if (!info.isDirectory()) throw new Error(`Checkpoint only supports files and directories: ${relativePath}`);
  input.entries.push({ path: relativePath, state: 'directory', size: 0 });
  for (const item of await readdir(absolutePath, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (!input.explicit && DEFAULT_EXCLUDES.has(item.name)) continue;
    const child = relativePath === '.' ? item.name : `${relativePath}/${item.name}`;
    await collectPath({ ...input, relativePath: child });
  }
}

export async function createWorkspaceCheckpoint(input: {
  root: string;
  storageRoot?: string;
  paths?: string[];
  label?: string;
  maxFileBytes: number;
  maxTotalBytes?: number;
}): Promise<WorkspaceCheckpointManifest> {
  const requestedPaths = [...new Set((input.paths?.length ? input.paths : ['.']).map(normalizeRelative))];
  const entries: CheckpointEntry[] = [];
  const files: Array<{ relativePath: string; absolutePath: string; size: number }> = [];
  for (const relativePath of requestedPaths) {
    await collectPath({ root: input.root, relativePath, explicit: relativePath !== '.', maxFileBytes: input.maxFileBytes, entries, files });
  }
  const deduped = new Map(entries.map((entry) => [entry.path, entry]));
  const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  const maxTotalBytes = input.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (totalBytes > maxTotalBytes) throw new Error(`Checkpoint exceeds maximum snapshot size (${maxTotalBytes} bytes)`);

  const id = `cp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const dir = checkpointDir(input.root, id, input.storageRoot);
  await mkdir(path.join(dir, 'files'), { recursive: true });
  for (const item of files) {
    const destination = snapshotPathFromDir(dir, item.relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(item.absolutePath, destination, { force: true, preserveTimestamps: true });
  }

  const manifest: WorkspaceCheckpointManifest = {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    label: input.label?.trim().slice(0, 200) || 'workspace checkpoint',
    requestedPaths,
    entries: [...deduped.values()].sort((a, b) => a.path.localeCompare(b.path)),
    totalBytes,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

export async function readWorkspaceCheckpoint(root: string, id: string, storageRoot?: string): Promise<WorkspaceCheckpointManifest> {
  return (await findCheckpointRecord(root, id, storageRoot)).manifest;
}

export async function listWorkspaceCheckpoints(root: string, limit = 50, storageRoot?: string): Promise<WorkspaceCheckpointManifest[]> {
  const records = await listCheckpointRecords(root, storageRoot);
  return records.slice(0, Math.max(1, Math.min(limit, 200))).map((record) => record.manifest);
}

export async function pruneWorkspaceCheckpoints(root: string, keep = 50, storageRoot?: string): Promise<string[]> {
  const records = await listCheckpointRecords(root, storageRoot);
  const removed: string[] = [];
  for (const record of records.slice(Math.max(1, keep))) {
    await rm(record.dir, { recursive: true, force: true });
    removed.push(record.manifest.id);
  }
  return removed;
}

export async function restoreWorkspaceCheckpoint(input: { root: string; id: string; paths?: string[]; storageRoot?: string }) {
  const record = await findCheckpointRecord(input.root, input.id, input.storageRoot);
  const manifest = record.manifest;
  const selected = input.paths?.length ? new Set(input.paths.map(normalizeRelative)) : null;
  const entries = manifest.entries.filter((entry) => !selected || [...selected].some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)));
  if (!entries.length) throw new Error('No checkpoint entries matched the requested restore paths');

  const removed: string[] = [];
  const restored: string[] = [];
  for (const entry of entries.filter((item) => item.state === 'missing').sort((a, b) => b.path.length - a.path.length)) {
    if (entry.path === '.') throw new Error('Refusing to remove the workspace root');
    const target = ensureInside(input.root, entry.path);
    if (await exists(target)) {
      await rm(target, { recursive: true, force: true });
      removed.push(entry.path);
    }
  }
  for (const entry of entries.filter((item) => item.state === 'directory').sort((a, b) => a.path.length - b.path.length)) {
    if (entry.path !== '.') await mkdir(ensureInside(input.root, entry.path), { recursive: true });
  }
  for (const entry of entries.filter((item) => item.state === 'file')) {
    const source = snapshotPathFromDir(record.dir, entry.path);
    if (!(await exists(source))) throw new Error(`Checkpoint payload missing: ${entry.path}`);
    const target = ensureInside(input.root, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { force: true, preserveTimestamps: true });
    restored.push(entry.path);
  }
  return { checkpoint: manifest, restored, removed };
}

export function checkpointPathsForPatch(operations: Array<Record<string, unknown>>): string[] {
  const paths = new Set<string>();
  for (const operation of operations) {
    if (operation.op === 'move') {
      if (typeof operation.from === 'string') paths.add(operation.from);
      if (typeof operation.to === 'string') paths.add(operation.to);
    } else if (typeof operation.path === 'string') {
      paths.add(operation.path);
    }
  }
  return [...paths];
}
