import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolveExistingPath, resolveWritablePath } from './security.js';

export type PatchOperation =
  | { op: 'write'; path: string; content: string; overwrite?: boolean; expectedSha256?: string }
  | { op: 'replace'; path: string; search: string; replacement: string; replaceAll?: boolean; expectedSha256?: string }
  | { op: 'delete'; path: string; expectedSha256?: string }
  | { op: 'move'; from: string; to: string; overwrite?: boolean; expectedSha256?: string }
  | { op: 'mkdir'; path: string };

type Snapshot =
  | { kind: 'missing' }
  | { kind: 'file'; data: Buffer; mode?: number }
  | { kind: 'directory'; mode: number };

export type PatchOperationResult =
  | { index: number; op: 'write'; path: string; existed: boolean; bytes: number; changed: boolean; status: 'planned' | 'applied' }
  | { index: number; op: 'replace'; path: string; matches: number; replacements: number; bytesBefore: number; bytesAfter: number; changed: boolean; status: 'planned' | 'applied' }
  | { index: number; op: 'delete'; path: string; kind: 'file' | 'directory'; changed: true; status: 'planned' | 'applied' }
  | { index: number; op: 'move'; from: string; to: string; destinationExisted: boolean; changed: boolean; status: 'planned' | 'applied' }
  | { index: number; op: 'mkdir'; path: string; alreadyExists: boolean; changed: boolean; status: 'planned' | 'applied' };

type PlannedOperation =
  | { op: 'write'; target: string; relativePath: string; content: Buffer; overwrite: boolean; mode?: number; changed: boolean }
  | { op: 'delete'; target: string; relativePath: string; directory: boolean; changed: true }
  | { op: 'move'; from: string; to: string; fromRelative: string; toRelative: string; overwrite: boolean; changed: boolean }
  | { op: 'mkdir'; target: string; relativePath: string; alreadyExists: boolean; changed: boolean };

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function assertExpectedSha256(relativePath: string, before: Snapshot, expectedSha256?: string): void {
  if (!expectedSha256) return;
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error(`expectedSha256 must be a 64-character SHA256 hex digest: ${relativePath}`);
  if (before.kind !== 'file') throw new Error(`SHA256 precondition failed because target is not a file: ${relativePath}`);
  const actual = sha256(before.data);
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA256 precondition failed for ${relativePath}: expected ${expectedSha256.toLowerCase()}, actual ${actual}`);
  }
}

async function snapshot(target: string): Promise<Snapshot> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Refusing to patch symbolic link: ${target}`);
    if (info.isDirectory()) return { kind: 'directory', mode: info.mode };
    if (!info.isFile()) throw new Error(`Unsupported patch target type: ${target}`);
    return { kind: 'file', data: await readFile(target), mode: info.mode };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

async function atomicWrite(target: string, content: Buffer, mode?: number): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.rw-mcp-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content);
    if (mode !== undefined) await chmod(temp, mode);
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function restoreSnapshots(snapshots: Map<string, Snapshot>): Promise<void> {
  const paths = [...snapshots.keys()];
  const byDepthDesc = [...paths].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const target of byDepthDesc) {
    const initial = snapshots.get(target)!;
    try {
      const current = await lstat(target);
      if (initial.kind === 'missing') {
        if (current.isDirectory()) await rm(target, { recursive: false, force: true });
        else await rm(target, { force: true });
      } else if (current.isFile() || current.isSymbolicLink()) {
        await rm(target, { force: true });
      }
    } catch {}
  }
  const byDepthAsc = [...paths].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  for (const target of byDepthAsc) {
    const initial = snapshots.get(target)!;
    if (initial.kind === 'directory') {
      await mkdir(target, { recursive: true, mode: initial.mode });
      await chmod(target, initial.mode).catch(() => undefined);
    } else if (initial.kind === 'file') {
      await mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, initial.data, initial.mode);
    }
  }
}

export async function applyPatchEnvelope(input: {
  root: string;
  operations: PatchOperation[];
  maxFileBytes: number;
  dryRun: boolean;
}) {
  if (!input.operations.length) throw new Error('Patch requires at least one operation');
  if (input.operations.length > 100) throw new Error('Patch supports at most 100 operations');
  const planned: PlannedOperation[] = [];
  const affected = new Set<string>();
  const affectedRelative = new Set<string>();
  const changedRelative = new Set<string>();
  const baselineSnapshots = new Map<string, Snapshot>();
  const virtualSnapshots = new Map<string, Snapshot>();
  const plannedDirectories = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  const baselineSnapshot = async (target: string): Promise<Snapshot> => {
    const cached = baselineSnapshots.get(target);
    if (cached) return cached;
    const value = await snapshot(target);
    baselineSnapshots.set(target, value);
    return value;
  };
  const currentSnapshot = async (target: string): Promise<Snapshot> => virtualSnapshots.get(target) ?? baselineSnapshot(target);
  const touch = (target: string, relativePath: string, changed: boolean) => {
    affected.add(target);
    affectedRelative.add(relativePath);
    if (changed) changedRelative.add(relativePath);
  };

  for (const [index, operation] of input.operations.entries()) {
    if (operation.op === 'write') {
      const target = await resolveWritablePath(input.root, operation.path, plannedDirectories);
      const baseline = await baselineSnapshot(target);
      assertExpectedSha256(operation.path, baseline, operation.expectedSha256);
      const before = await currentSnapshot(target);
      if (before.kind === 'directory') throw new Error(`Cannot write file over directory: ${operation.path}`);
      if (before.kind !== 'missing' && operation.overwrite === false) throw new Error(`File already exists: ${operation.path}`);
      const content = Buffer.from(operation.content, 'utf8');
      if (content.byteLength > input.maxFileBytes) throw new Error(`Result exceeds maxFileBytes: ${operation.path}`);
      const changed = before.kind !== 'file' || !before.data.equals(content);
      planned.push({ op: 'write', target, relativePath: operation.path, content, overwrite: operation.overwrite !== false, changed, ...(before.kind === 'file' ? { mode: before.mode } : {}) });
      virtualSnapshots.set(target, { kind: 'file', data: content, ...(before.kind === 'file' && before.mode !== undefined ? { mode: before.mode } : {}) });
      results.push({ index, op: 'write', path: operation.path, existed: before.kind === 'file', bytes: content.byteLength, changed });
      touch(target, operation.path, changed);
      continue;
    }
    if (operation.op === 'replace') {
      if (!operation.search) throw new Error(`Replace search cannot be empty: ${operation.path}`);
      const target = await resolveWritablePath(input.root, operation.path, plannedDirectories);
      const baseline = await baselineSnapshot(target);
      assertExpectedSha256(operation.path, baseline, operation.expectedSha256);
      const before = await currentSnapshot(target);
      if (before.kind !== 'file') throw new Error(`Replace target must be a file: ${operation.path}`);
      if (before.data.includes(0)) throw new Error(`Replace target must be UTF-8 text: ${operation.path}`);
      const text = before.data.toString('utf8');
      const count = text.split(operation.search).length - 1;
      if (!count) throw new Error(`Search text not found: ${operation.path}`);
      if (!operation.replaceAll && count !== 1) throw new Error(`Search text matched ${count} times in ${operation.path}; make it unique or set replaceAll=true`);
      const replacements = operation.replaceAll ? count : 1;
      const next = operation.replaceAll ? text.split(operation.search).join(operation.replacement) : text.replace(operation.search, operation.replacement);
      const content = Buffer.from(next, 'utf8');
      if (content.byteLength > input.maxFileBytes) throw new Error(`Result exceeds maxFileBytes: ${operation.path}`);
      const changed = !before.data.equals(content);
      planned.push({ op: 'write', target, relativePath: operation.path, content, overwrite: true, mode: before.mode, changed });
      virtualSnapshots.set(target, { kind: 'file', data: content, mode: before.mode });
      results.push({ index, op: 'replace', path: operation.path, matches: count, replacements, bytesBefore: before.data.byteLength, bytesAfter: content.byteLength, changed });
      touch(target, operation.path, changed);
      continue;
    }
    if (operation.op === 'delete') {
      const target = await resolveWritablePath(input.root, operation.path, plannedDirectories);
      const baseline = await baselineSnapshot(target);
      assertExpectedSha256(operation.path, baseline, operation.expectedSha256);
      const before = await currentSnapshot(target);
      if (before.kind === 'directory') {
        if (baseline.kind === 'directory' && (await readdir(target)).length) throw new Error(`Refusing to delete non-empty directory: ${operation.path}`);
        planned.push({ op: 'delete', target, relativePath: operation.path, directory: true, changed: true });
        results.push({ index, op: 'delete', path: operation.path, kind: 'directory', changed: true });
      } else if (before.kind === 'file') {
        planned.push({ op: 'delete', target, relativePath: operation.path, directory: false, changed: true });
        results.push({ index, op: 'delete', path: operation.path, kind: 'file', changed: true });
      } else throw new Error(`Delete target does not exist: ${operation.path}`);
      virtualSnapshots.set(target, { kind: 'missing' });
      touch(target, operation.path, true);
      continue;
    }
    if (operation.op === 'move') {
      const from = await resolveWritablePath(input.root, operation.from, plannedDirectories);
      const baselineFrom = await baselineSnapshot(from);
      assertExpectedSha256(operation.from, baselineFrom, operation.expectedSha256);
      const fromSnapshot = await currentSnapshot(from);
      if (fromSnapshot.kind !== 'file') throw new Error(`Move currently supports files only: ${operation.from}`);
      const to = await resolveWritablePath(input.root, operation.to, plannedDirectories);
      const toSnapshot = await currentSnapshot(to);
      const sameTarget = from === to;
      if (!sameTarget && toSnapshot.kind === 'directory') throw new Error(`Move destination is a directory: ${operation.to}`);
      if (!sameTarget && toSnapshot.kind !== 'missing' && !operation.overwrite) throw new Error(`Move destination already exists: ${operation.to}`);
      const changed = !sameTarget;
      planned.push({ op: 'move', from, to, fromRelative: operation.from, toRelative: operation.to, overwrite: Boolean(operation.overwrite), changed });
      if (changed) {
        virtualSnapshots.set(from, { kind: 'missing' });
        virtualSnapshots.set(to, fromSnapshot);
      }
      results.push({ index, op: 'move', from: operation.from, to: operation.to, destinationExisted: !sameTarget && toSnapshot.kind !== 'missing', changed });
      touch(from, operation.from, changed);
      touch(to, operation.to, changed);
      continue;
    }
    const target = await resolveWritablePath(input.root, operation.path, plannedDirectories);
    const before = await currentSnapshot(target);
    if (before.kind === 'file') throw new Error(`Directory path is an existing file: ${operation.path}`);
    const alreadyExists = before.kind === 'directory';
    const changed = !alreadyExists;
    planned.push({ op: 'mkdir', target, relativePath: operation.path, alreadyExists, changed });
    virtualSnapshots.set(target, before.kind === 'directory' ? before : { kind: 'directory', mode: 0o777 });
    plannedDirectories.add(target);
    results.push({ index, op: 'mkdir', path: operation.path, alreadyExists, changed });
    touch(target, operation.path, changed);
  }

  const status = input.dryRun ? 'planned' : 'applied';
  const operationResults = results.map((result) => ({ ...result, status })) as PatchOperationResult[];
  const affectedPaths = [...affectedRelative];
  const changedPaths = [...changedRelative];
  const baselineForDiff: Record<string, { kind: 'file' | 'missing'; content?: string }> = {};
  const addBaselineForDiff = async (relativePath: string, target: string) => {
    const value = await baselineSnapshot(target);
    if (value.kind === 'file' && value.data.byteLength <= 512 * 1024) {
      baselineForDiff[relativePath] = { kind: 'file', content: value.data.toString('base64') };
    } else if (value.kind === 'missing') {
      baselineForDiff[relativePath] = { kind: 'missing' };
    }
  };
  for (const operation of planned) {
    if (operation.op === 'move') {
      await addBaselineForDiff(operation.fromRelative, operation.from);
      await addBaselineForDiff(operation.toRelative, operation.to);
    } else {
      await addBaselineForDiff(operation.relativePath, operation.target);
    }
  }
  if (input.dryRun) return { ok: true, dryRun: true, operations: operationResults, affectedPaths, changedPaths, baselineForDiff };

  const snapshots = new Map<string, Snapshot>();
  for (const target of affected) snapshots.set(target, await baselineSnapshot(target));
  try {
    for (const operation of planned) {
      if (!operation.changed) continue;
      if (operation.op === 'write') {
        await atomicWrite(operation.target, operation.content, operation.mode);
      } else if (operation.op === 'delete') {
        await rm(operation.target, { recursive: false, force: false });
      } else if (operation.op === 'move') {
        if (operation.overwrite) await rm(operation.to, { force: true }).catch(() => undefined);
        await rename(operation.from, operation.to);
      } else {
        await mkdir(operation.target, { recursive: false });
      }
    }
  } catch (error) {
    await restoreSnapshots(snapshots).catch(() => undefined);
    throw error;
  }
  return { ok: true, dryRun: false, operations: operationResults, affectedPaths, changedPaths, baselineForDiff };
}
