import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { assertWorkspaceName, resolveWorkspace } from './security.js';

export async function listWorkspaceNames(config: Config): Promise<string[]> {
  const names = new Set(Object.keys(config.workspaceRegistry));
  const entries = await readdir(config.workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) names.add(entry.name);
  }
  return [...names].sort();
}

export async function resolveConfiguredWorkspace(config: Config, workspace: string): Promise<string> {
  assertWorkspaceName(workspace);
  const registered = config.workspaceRegistry[workspace];
  if (!registered) return resolveWorkspace(config.workspaceRoot, workspace);

  const targetReal = await realpath(registered);
  const info = await stat(targetReal);
  if (!info.isDirectory()) throw new Error('Workspace is not a directory');
  return targetReal;
}

export async function createWorkspaceInDefaultRoot(config: Config, workspace: string): Promise<string> {
  assertWorkspaceName(workspace);
  if (config.workspaceRegistry[workspace]) {
    throw new Error(`Workspace already exists in registry: ${workspace}`);
  }
  const target = path.join(config.workspaceRoot, workspace);
  await mkdir(target, { recursive: true });
  return resolveWorkspace(config.workspaceRoot, workspace);
}
