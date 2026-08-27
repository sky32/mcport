import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { globIterate } from 'glob';
import { resolveExistingPath } from './security.js';
import { truncateTextToBudget } from './output-budget.js';

export const DEFAULT_FILE_IGNORES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/dist-desktop/**',
  '**/release/**',
  '**/build/**',
  '**/.next/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.remote-workspace-mcp/**',
];

function relativeFromRoot(root: string, full: string): string {
  const value = path.relative(root, full);
  return value || '.';
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function sha256File(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export async function statWorkspacePath(input: {
  root: string;
  relativePath: string;
}) {
  const candidate = path.resolve(input.root, input.relativePath || '.');
  if (!isInside(input.root, candidate)) throw new Error('Path escapes workspace');
  const info = await lstat(candidate);
  const symlink = info.isSymbolicLink();
  const resolved = await realpath(candidate);
  if (!isInside(input.root, resolved)) throw new Error('Path escapes workspace');
  const targetInfo = symlink ? await stat(resolved) : info;
  const type = targetInfo.isDirectory() ? 'directory' : targetInfo.isFile() ? 'file' : 'other';
  let encoding: 'utf-8' | 'binary' | null = null;
  let sha256: string | null = null;
  if (type === 'file') {
    sha256 = await sha256File(resolved);
    if (targetInfo.size === 0) {
      encoding = 'utf-8';
    } else {
      const handle = await open(resolved, 'r');
      try {
        const sample = Buffer.alloc(Math.min(8192, targetInfo.size));
        await handle.read(sample, 0, sample.length, 0);
        encoding = sample.includes(0) ? 'binary' : 'utf-8';
      } finally {
        await handle.close();
      }
    }
  }
  return {
    path: input.relativePath || '.',
    type,
    size: type === 'file' ? targetInfo.size : null,
    mtime: targetInfo.mtime.toISOString(),
    mode: `0${(targetInfo.mode & 0o777).toString(8)}`,
    symlink,
    symlinkTarget: symlink ? relativeFromRoot(input.root, resolved) : null,
    sha256,
    encoding,
  };
}

export async function listDirectory(input: {
  root: string;
  relativePath: string;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
  limit: number;
}) {
  const start = await resolveExistingPath(input.root, input.relativePath || '.');
  const startInfo = await stat(start);
  if (!startInfo.isDirectory()) throw new Error('List path must be a directory');
  const entries: Array<{ path: string; type: 'file' | 'directory' | 'symlink'; size?: number }> = [];
  const pattern = input.recursive ? '**/*' : '*';
  for await (const matched of globIterate(pattern, {
    cwd: start,
    dot: input.includeHidden,
    follow: false,
    ignore: DEFAULT_FILE_IGNORES,
    maxDepth: input.recursive ? input.maxDepth : 1,
  })) {
    if (entries.length >= input.limit) break;
    const full = path.join(start, String(matched));
    const info = await lstat(full);
    const type = info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file';
    entries.push({
      path: relativeFromRoot(input.root, full),
      type,
      ...(type === 'file' ? { size: info.size } : {}),
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, truncated: entries.length >= input.limit };
}

export async function searchFiles(input: {
  root: string;
  relativePath: string;
  patterns: string[];
  excludePatterns: string[];
  includeHidden: boolean;
  maxDepth?: number;
  limit: number;
}) {
  const start = await resolveExistingPath(input.root, input.relativePath || '.');
  const startInfo = await stat(start);
  if (!startInfo.isDirectory()) throw new Error('List path must be a directory');
  const files: Array<{ path: string; size: number }> = [];
  const seen = new Set<string>();
  for await (const matched of globIterate(input.patterns.length ? input.patterns : ['**/*'], {
    cwd: start,
    dot: input.includeHidden,
    follow: false,
    nodir: true,
    ignore: [...DEFAULT_FILE_IGNORES, ...input.excludePatterns],
    ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
  })) {
    if (files.length >= input.limit) break;
    const full = path.join(start, String(matched));
    const relative = relativeFromRoot(input.root, full);
    if (seen.has(relative)) continue;
    seen.add(relative);
    const info = await lstat(full);
    if (!info.isFile()) continue;
    files.push({ path: relative, size: info.size });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated: files.length >= input.limit };
}

export async function readTextFile(input: {
  root: string;
  relativePath: string;
  startLine: number;
  endLine?: number;
  maxFileBytes: number;
  maxOutputBytes?: number;
}) {
  const target = await resolveExistingPath(input.root, input.relativePath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('Path is not a file');
  if (info.size > input.maxFileBytes) throw new Error(`File exceeds maxFileBytes (${input.maxFileBytes})`);
  let endsWithNewline = false;
  if (info.size > 0) {
    const handle = await open(target, 'r');
    try {
      const sample = Buffer.alloc(Math.min(8192, info.size));
      await handle.read(sample, 0, sample.length, 0);
      if (sample.includes(0)) throw new Error('Binary file cannot be read as UTF-8 text');
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      endsWithNewline = last[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }
  const requestedEnd = input.endLine ?? Number.MAX_SAFE_INTEGER;
  const selectedLines: string[] = [];
  const outputBudget = Math.max(256, Math.min(input.maxOutputBytes ?? input.maxFileBytes, input.maxFileBytes));
  let selectedBytes = 0;
  let outputTruncated = false;
  let nextStartLine: number | null = null;
  let oversizedLine = false;
  let physicalLines = 0;
  const reader = createInterface({ input: createReadStream(target), crlfDelay: Infinity });
  for await (const line of reader) {
    if (line.includes('\0')) throw new Error('Binary file cannot be read as UTF-8 text');
    physicalLines += 1;
    if (physicalLines >= input.startLine && physicalLines <= requestedEnd && !outputTruncated) {
      const separatorBytes = selectedLines.length ? 1 : 0;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (selectedBytes + separatorBytes + lineBytes <= outputBudget) {
        selectedLines.push(line);
        selectedBytes += separatorBytes + lineBytes;
      } else if (!selectedLines.length) {
        const clipped = truncateTextToBudget(line, outputBudget);
        selectedLines.push(clipped.text);
        selectedBytes = clipped.budgetUsed;
        outputTruncated = true;
        nextStartLine = physicalLines;
        oversizedLine = true;
      } else {
        outputTruncated = true;
        nextStartLine = physicalLines;
      }
    }
  }
  const totalLines = physicalLines + (endsWithNewline || physicalLines === 0 ? 1 : 0);
  if (endsWithNewline && totalLines >= input.startLine && totalLines <= requestedEnd && !outputTruncated) selectedLines.push('');
  const logicalEnd = outputTruncated && nextStartLine !== null && !oversizedLine
    ? Math.max(input.startLine, nextStartLine - 1)
    : Math.min(input.endLine ?? totalLines, totalLines);
  const end = Math.min(logicalEnd, totalLines);
  if (end < input.startLine) throw new Error('endLine must be >= startLine');
  return {
    path: input.relativePath,
    size: info.size,
    mtime: info.mtime.toISOString(),
    sha256: await sha256File(target),
    encoding: 'utf-8' as const,
    startLine: input.startLine,
    endLine: end,
    totalLines,
    text: selectedLines.join('\n'),
    truncated: outputTruncated,
    nextStartLine,
    oversizedLine,
    budgetUsed: selectedBytes,
  };
}

export async function searchTextFiles(input: {
  root: string;
  relativePath: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  includePatterns: string[];
  excludePatterns: string[];
  includeHidden: boolean;
  maxFileBytes: number;
  maxResults: number;
  contextLines: number;
}) {
  const start = await resolveExistingPath(input.root, input.relativePath || '.');
  const startInfo = await stat(start);
  if (!startInfo.isDirectory() && !startInfo.isFile()) throw new Error('Search path must be a file or directory');
  let expression: RegExp | null = null;
  if (input.regex) {
    try {
      expression = new RegExp(input.query, input.caseSensitive ? '' : 'i');
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
  const matches: Array<{
    path: string;
    line: number;
    text: string;
    before?: string[];
    after?: string[];
  }> = [];
  let scannedFiles = 0;
  const iterator = globIterate(input.includePatterns.length ? input.includePatterns : ['**/*'], {
    cwd: start,
    dot: input.includeHidden,
    follow: false,
    nodir: true,
    ignore: [...DEFAULT_FILE_IGNORES, ...input.excludePatterns],
  });
  const scanOne = async (matched: string, base = start) => {
    const full = path.join(base, matched);
    const info = await lstat(full);
    if (!info.isFile() || info.size > input.maxFileBytes) return null;
    const buffer = await readFile(full);
    if (buffer.includes(0)) return null;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    const fileMatches: typeof matches = [];
    for (let index = 0; index < lines.length && fileMatches.length < input.maxResults; index += 1) {
      const line = lines[index];
      const hit = expression ? expression.test(line) : (input.caseSensitive ? line : line.toLowerCase()).includes(needle);
      if (!hit) continue;
      fileMatches.push({
        path: relativeFromRoot(input.root, full),
        line: index + 1,
        text: line.slice(0, 1000),
        ...(input.contextLines ? { before: lines.slice(Math.max(0, index - input.contextLines), index).map((item) => item.slice(0, 1000)) } : {}),
        ...(input.contextLines ? { after: lines.slice(index + 1, index + 1 + input.contextLines).map((item) => item.slice(0, 1000)) } : {}),
      });
    }
    return fileMatches;
  };
  if (startInfo.isFile()) {
    const fileMatches = await scanOne(path.basename(start), path.dirname(start));
    return {
      matches: fileMatches || [],
      scannedFiles: fileMatches === null ? 0 : 1,
      truncated: Boolean(fileMatches && fileMatches.length >= input.maxResults),
    };
  }
  let batch: string[] = [];
  const flushBatch = async () => {
    const results = await Promise.all(batch.map((matched) => scanOne(matched)));
    scannedFiles += results.filter((item) => item !== null).length;
    for (const result of results) {
      if (!result) continue;
      for (const match of result) {
        if (matches.length >= input.maxResults) break;
        matches.push(match);
      }
      if (matches.length >= input.maxResults) break;
    }
    batch = [];
  };
  for await (const matched of iterator) {
    batch.push(String(matched));
    if (batch.length >= 8) {
      await flushBatch();
      if (matches.length >= input.maxResults) break;
    }
  }
  if (batch.length && matches.length < input.maxResults) await flushBatch();
  matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.text.localeCompare(b.text));
  return { matches, scannedFiles, truncated: matches.length >= input.maxResults };
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export async function readImageFile(root: string, relativePath: string, maxBytes: number) {
  const target = await resolveExistingPath(root, relativePath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('Path is not a file');
  if (info.size > maxBytes) throw new Error(`Image exceeds maxFileBytes (${maxBytes})`);
  const mimeType = IMAGE_TYPES[path.extname(target).toLowerCase()];
  if (!mimeType) throw new Error('Supported image formats: PNG, JPEG, GIF, WEBP');
  const buffer = await readFile(target);
  return { path: relativePath, size: info.size, mimeType, data: buffer.toString('base64') };
}
