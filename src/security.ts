import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid workspace name. Use letters, digits, dot, underscore, and hyphen only.');
  }
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export async function resolveWorkspace(root: string, workspace: string): Promise<string> {
  assertWorkspaceName(workspace);
  const rootReal = await realpath(root);
  const target = path.join(rootReal, workspace);
  const targetReal = await realpath(target);
  if (!inside(rootReal, targetReal)) throw new Error('Workspace escapes WORKSPACE_ROOT');
  const info = await stat(targetReal);
  if (!info.isDirectory()) throw new Error('Workspace is not a directory');
  return targetReal;
}

export async function resolveExistingPath(workspaceRoot: string, relativePath: string): Promise<string> {
  const rootReal = await realpath(workspaceRoot);
  const candidate = path.resolve(rootReal, relativePath || '.');
  const candidateReal = await realpath(candidate);
  if (!inside(rootReal, candidateReal)) throw new Error('Path escapes workspace');
  return candidateReal;
}

export async function resolveWritablePath(
  workspaceRoot: string,
  relativePath: string,
  plannedDirectories?: ReadonlySet<string>,
): Promise<string> {
  if (!relativePath || relativePath === '.') throw new Error('A file path is required');
  const rootReal = await realpath(workspaceRoot);
  const candidate = path.resolve(rootReal, relativePath);
  if (!inside(rootReal, candidate)) throw new Error('Path escapes workspace');

  let exists = true;
  try {
    const existing = await lstat(candidate);
    if (existing.isSymbolicLink()) throw new Error('Refusing to write through a symbolic link');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false;
    else throw error;
  }

  if (exists) {
    const candidateReal = await realpath(candidate);
    if (!inside(rootReal, candidateReal)) throw new Error('Existing path escapes workspace');
    return candidateReal;
  }

  let parent = path.dirname(candidate);
  while (true) {
    try {
      const parentReal = await realpath(parent);
      if (!inside(rootReal, parentReal)) throw new Error('Parent directory escapes workspace');
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      if (!plannedDirectories?.has(parent)) throw error;
      const nextParent = path.dirname(parent);
      if (nextParent === parent) throw error;
      parent = nextParent;
    }
  }
}

export function assertCommandAllowed(command: string, allowed: Set<string>): void {
  if (!command || command.includes('/') || command.includes('\\')) {
    throw new Error('Executable must be a plain command name, not a path');
  }
  if (!allowed.has(command)) {
    throw new Error(`Command is not allowlisted: ${command}`);
  }
}
