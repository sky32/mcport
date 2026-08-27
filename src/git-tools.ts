import type { RuntimeExecutionConfig } from './runtime.js';
import { runTrustedCommand } from './runtime.js';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function git(config: RuntimeExecutionConfig, root: string, args: string[], timeoutMs = 30_000) {
  const result = await runTrustedCommand(config, root, 'git', ['--no-pager', ...args], '.', timeoutMs);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git exited with code ${result.exitCode}`);
  return result;
}

export async function gitStatus(config: RuntimeExecutionConfig, root: string) {
  const result = await git(config, root, ['status', '--short', '--branch']);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const branch = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  return { branch, entries: lines, truncated: result.stdoutTruncated };
}

export async function gitDiff(config: RuntimeExecutionConfig, root: string, input: {
  staged: boolean;
  paths: string[];
}) {
  const args = ['diff', '--no-ext-diff', '--no-textconv', ...(input.staged ? ['--staged'] : []), ...(input.paths.length ? ['--', ...input.paths] : [])];
  const result = await git(config, root, args);
  return { diff: result.stdout, truncated: result.stdoutTruncated };
}

export async function gitDiffFromMutationBaselines(config: RuntimeExecutionConfig, root: string, baselines: Record<string, { kind: 'file' | 'missing'; content?: string }>) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mcport-mutation-diff-'));
  const chunks: string[] = [];
  let truncated = false;
  try {
    for (const [relativePath, baseline] of Object.entries(baselines)) {
      const normalizedPath = relativePath.replaceAll('\\', '/');
      const currentPath = path.resolve(root, relativePath);
      let currentContent: Buffer | null = null;
      let currentKind: 'file' | 'directory' | 'missing' = 'missing';
      try {
        const info = await stat(currentPath);
        if (info.isDirectory()) currentKind = 'directory';
        else if (info.isFile()) {
          currentKind = 'file';
          currentContent = await readFile(currentPath);
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (currentKind === 'directory') {
        if (baseline.kind === 'missing') continue;
        throw new Error(`Mutation diff cannot compare file baseline to directory: ${relativePath}`);
      }

      const beforePath = path.join(tempRoot, 'before', relativePath);
      const afterPath = path.join(tempRoot, 'after', relativePath);
      await mkdir(path.dirname(beforePath), { recursive: true });
      await mkdir(path.dirname(afterPath), { recursive: true });
      await writeFile(beforePath, baseline.kind === 'file' ? Buffer.from(baseline.content ?? '', 'base64') : '');
      await writeFile(afterPath, currentContent ?? '');

      const result = await runTrustedCommand(config, root, 'git', [
        '--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv',
        '--src-prefix', 'a/', '--dst-prefix', 'b/', beforePath, afterPath,
      ], '.', 30_000);
      if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(result.stderr.trim() || `git diff exited with code ${result.exitCode}`);

      let diff = result.stdout;
      if (!diff && baseline.kind === 'missing' && currentContent !== null) {
        diff = `diff --git a/${normalizedPath} b/${normalizedPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${normalizedPath}\n`;
      } else if (!diff && baseline.kind === 'file' && currentContent === null) {
        diff = `diff --git a/${normalizedPath} b/${normalizedPath}\ndeleted file mode 100644\n--- a/${normalizedPath}\n+++ /dev/null\n`;
      } else if (diff) {
        diff = diff.split(/\r?\n/).map((line) => {
          if (line.startsWith('diff --git ')) return `diff --git a/${normalizedPath} b/${normalizedPath}`;
          if (line.startsWith('--- ')) return baseline.kind === 'missing' ? '--- /dev/null' : `--- a/${normalizedPath}`;
          if (line.startsWith('+++ ')) return currentContent === null ? '+++ /dev/null' : `+++ b/${normalizedPath}`;
          return line;
        }).join('\n');
      }
      if (diff) chunks.push(diff.endsWith('\n') ? diff : `${diff}\n`);
      truncated ||= result.stdoutTruncated;
    }
    return { diff: chunks.join(''), truncated };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function summarizeGitDiff(diff: string) {
  type FileSummary = {
    path: string;
    oldPath: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
    hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; heading: string }>;
  };
  const files: FileSummary[] = [];
  let current: FileSummary | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], oldPath: header[1], status: 'modified', additions: 0, deletions: 0, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode ') || line === '--- /dev/null') current.status = 'added';
    else if (line.startsWith('deleted file mode ') || line === '+++ /dev/null') current.status = 'deleted';
    else if (line.startsWith('rename from ')) current.status = 'renamed';
    else if (line.startsWith('rename to ')) current.path = line.slice('rename to '.length);
    else if (line.startsWith('+') && !line.startsWith('+++')) current.additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) current.deletions += 1;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s*(.*)$/.exec(line);
    if (hunk) current.hunks.push({
      oldStart: Number(hunk[1]), oldLines: Number(hunk[2] || 1),
      newStart: Number(hunk[3]), newLines: Number(hunk[4] || 1),
      heading: hunk[5] || '',
    });
  }
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, item) => sum + item.additions, 0),
    deletions: files.reduce((sum, item) => sum + item.deletions, 0),
    files,
  };
}

export async function gitLog(config: RuntimeExecutionConfig, root: string, input: {
  limit: number;
  revision?: string;
  path?: string;
}) {
  const format = '%H%x1f%h%x1f%an%x1f%aI%x1f%s';
  const args = ['log', `--max-count=${input.limit}`, `--format=${format}`];
  if (input.revision?.trim()) args.push(input.revision.trim());
  if (input.path?.trim()) args.push('--', input.path.trim());
  const result = await git(config, root, args);
  const commits = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, shortHash, author, authoredAt, subject] = line.split('\x1f');
    return { hash, shortHash, author, authoredAt, subject };
  });
  return { commits, truncated: result.stdoutTruncated || commits.length >= input.limit };
}

export async function gitShow(config: RuntimeExecutionConfig, root: string, input: {
  revision: string;
  includeDiff: boolean;
  paths: string[];
}) {
  const format = '%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%s%n%b';
  const meta = await git(config, root, ['show', '-s', `--format=${format}`, input.revision]);
  const firstLineEnd = meta.stdout.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? meta.stdout : meta.stdout.slice(0, firstLineEnd);
  const body = firstLineEnd === -1 ? '' : meta.stdout.slice(firstLineEnd + 1).trimEnd();
  const [hash, parents, author, authorEmail, authoredAt, committer, committedAt, subject] = firstLine.split('\x1f');
  let diff = '';
  let diffTruncated = false;
  if (input.includeDiff) {
    const shown = await git(config, root, [
      'show', '--format=', '--no-ext-diff', '--no-textconv', input.revision,
      ...(input.paths.length ? ['--', ...input.paths] : []),
    ]);
    diff = shown.stdout;
    diffTruncated = shown.stdoutTruncated;
  }
  return {
    commit: { hash, parents: parents ? parents.split(' ') : [], author, authorEmail, authoredAt, committer, committedAt, subject, body },
    ...(input.includeDiff ? { diff, diffTruncated } : {}),
  };
}

export async function gitBlame(config: RuntimeExecutionConfig, root: string, input: {
  path: string;
  startLine?: number;
  endLine?: number;
}) {
  const args = ['blame', '--line-porcelain'];
  if (input.startLine !== undefined) args.push('-L', `${input.startLine},${input.endLine ?? input.startLine}`);
  args.push('--', input.path);
  const result = await git(config, root, args);
  const lines = result.stdout.split(/\r?\n/);
  const entries: Array<{ line: number; hash: string; author: string; authorTime: number | null; text: string }> = [];
  let current: { hash: string; line: number; author: string; authorTime: number | null } | null = null;
  for (const line of lines) {
    const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/.exec(line);
    if (header) {
      current = { hash: header[1], line: Number(header[2]), author: '', authorTime: null };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ')) current.author = line.slice(7);
    else if (line.startsWith('author-time ')) current.authorTime = Number(line.slice(12)) || null;
    else if (line.startsWith('\t')) {
      entries.push({ ...current, text: line.slice(1) });
      current = null;
    }
  }
  return { entries, truncated: result.stdoutTruncated };
}
