import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HISTORY_DIR = '.remote-workspace-mcp/history';
const MANIFEST_VERSION = 1;

type SessionEntry = {
  file: string;
  createdAt: string;
  updatedAt: string;
  archiveHash: string;
  turns: Record<string, { revision: number; contentHash: string }>;
};

type Manifest = {
  version: 1;
  sessions: Record<string, SessionEntry>;
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function paths(root: string, storageDir?: string) {
  const dir = storageDir ? path.resolve(storageDir) : path.join(root, HISTORY_DIR);
  return { dir, sessions: path.join(dir, 'sessions'), manifest: path.join(dir, 'manifest.json') };
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, target);
}

async function loadManifest(root: string, storageDir?: string): Promise<Manifest> {
  try {
    const value = JSON.parse(await readFile(paths(root, storageDir).manifest, 'utf8')) as Manifest;
    if (value?.version === MANIFEST_VERSION && value.sessions && typeof value.sessions === 'object') return value;
  } catch {}
  return { version: MANIFEST_VERSION, sessions: {} };
}

async function saveManifest(root: string, manifest: Manifest, storageDir?: string): Promise<void> {
  await atomicWrite(paths(root, storageDir).manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

function safeSessionKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(key)) throw new Error('Invalid history session key');
  return key;
}

function rawBlock(label: string, value: string): string {
  return `\n**${label} (JSON string, lossless):**\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
}

function boundedTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

export async function openProjectHistory(input: {
  root: string;
  sessionKey?: string;
  initialUserInput: string;
  title?: string;
  storageDir?: string;
}) {
  const store = paths(input.root, input.storageDir);
  await mkdir(store.sessions, { recursive: true });
  const manifest = await loadManifest(input.root, input.storageDir);
  const requested = input.sessionKey?.trim();
  if (requested) {
    const key = safeSessionKey(requested);
    const entry = manifest.sessions[key];
    if (entry) {
      const archive = await readFile(path.join(store.dir, entry.file), 'utf8');
      return {
        sessionKey: key,
        created: false,
        archive: entry.file,
        archiveHash: entry.archiveHash,
        currentTail: boundedTail(archive, 8 * 1024),
      };
    }
  }

  const key = requested ? safeSessionKey(requested) : randomUUID();
  const file = `sessions/${key}.md`;
  const now = new Date().toISOString();
  const title = input.title?.trim() || 'Project session';
  const archive = `# ${title}\n\n- Session: \`${key}\`\n- Created: ${now}\n${rawBlock('Initial user input', input.initialUserInput)}`;
  const archiveHash = sha256(archive);
  await atomicWrite(path.join(store.dir, file), archive);
  manifest.sessions[key] = { file, createdAt: now, updatedAt: now, archiveHash, turns: {} };
  await saveManifest(input.root, manifest, input.storageDir);
  return { sessionKey: key, created: true, archive: file, archiveHash, currentTail: archive };
}

export async function checkpointProjectHistory(input: {
  root: string;
  sessionKey: string;
  turnId: string;
  rawUserInput: string;
  summary?: string;
  findings?: string[];
  changes?: string[];
  tests?: string[];
  nextActions?: string[];
  taskSnapshot?: Record<string, unknown>;
  storageDir?: string;
}) {
  const key = safeSessionKey(input.sessionKey);
  const turnId = input.turnId.trim();
  if (!turnId || turnId.length > 160) throw new Error('turnId is required and must be <= 160 characters');
  const store = paths(input.root, input.storageDir);
  await mkdir(store.sessions, { recursive: true });
  const manifest = await loadManifest(input.root, input.storageDir);
  let entry = manifest.sessions[key];
  let createdSession = false;
  if (!entry) {
    const now = new Date().toISOString();
    const file = `sessions/${key}.md`;
    const archive = `# Project session\n\n- Session: \`${key}\`\n- Created: ${now}\n`;
    await atomicWrite(path.join(store.dir, file), archive);
    entry = { file, createdAt: now, updatedAt: now, archiveHash: sha256(archive), turns: {} };
    manifest.sessions[key] = entry;
    await saveManifest(input.root, manifest, input.storageDir);
    createdSession = true;
  }
  const contentHash = sha256(JSON.stringify({
    rawUserInput: input.rawUserInput,
    summary: input.summary ?? '',
    findings: input.findings ?? [],
    changes: input.changes ?? [],
    tests: input.tests ?? [],
    nextActions: input.nextActions ?? [],
    task: input.taskSnapshot ?? null,
  }));
  const previous = entry.turns[turnId];
  const checkpointIdFor = (revision: number) => `cp_${sha256(`${key}\0${turnId}\0${revision}`).slice(0, 24)}`;
  if (previous?.contentHash === contentHash) {
    return {
      ok: true,
      duplicate: true,
      sessionKey: key,
      turnId,
      revision: previous.revision,
      archiveHash: entry.archiveHash,
      checkpointId: input.taskSnapshot ? checkpointIdFor(previous.revision) : null,
    };
  }
  const revision = (previous?.revision ?? 0) + 1;
  const checkpointId = input.taskSnapshot ? checkpointIdFor(revision) : null;
  const timestamp = new Date().toISOString();
  const sections = [
    `\n---\n\n## Checkpoint · ${timestamp}\n\n- Turn: \`${turnId}\`\n- Revision: ${revision}${previous ? `\n- Supersedes revision: ${previous.revision}` : ''}${checkpointId ? `\n- Checkpoint ID: \`${checkpointId}\`` : ''}\n- Content hash: \`${contentHash}\`\n`,
    input.summary?.trim() ? `\n### Summary\n\n${input.summary.trim()}\n` : '',
    input.findings?.length ? `\n### Findings\n\n${input.findings.map((value) => `- ${value}`).join('\n')}\n` : '',
    input.changes?.length ? `\n### Changes\n\n${input.changes.map((value) => `- ${value}`).join('\n')}\n` : '',
    input.tests?.length ? `\n### Tests\n\n${input.tests.map((value) => `- ${value}`).join('\n')}\n` : '',
    input.nextActions?.length ? `\n### Next actions\n\n${input.nextActions.map((value) => `- ${value}`).join('\n')}\n` : '',
    input.taskSnapshot ? `\n### Task checkpoint\n\n\`\`\`json\n${JSON.stringify(input.taskSnapshot, null, 2)}\n\`\`\`\n` : '',
    rawBlock('Raw user input', input.rawUserInput),
  ].join('');
  const archivePath = path.join(store.dir, entry.file);
  const current = await readFile(archivePath, 'utf8');
  const next = current + sections;
  await atomicWrite(archivePath, next);
  entry.turns[turnId] = { revision, contentHash };
  entry.updatedAt = timestamp;
  entry.archiveHash = sha256(next);
  await saveManifest(input.root, manifest, input.storageDir);
  return { ok: true, duplicate: false, createdSession, sessionKey: key, turnId, revision, archiveHash: entry.archiveHash, checkpointId };
}

export async function searchProjectHistory(input: { root: string; query: string; limit: number; storageDir?: string }) {
  const query = input.query.trim().toLowerCase();
  if (!query) throw new Error('History search query is required');
  const terms = query.split(/\s+/).filter(Boolean);
  const manifest = await loadManifest(input.root, input.storageDir);
  const matches: Array<{ sessionKey: string; archive: string; line: number; snippet: string; score: number }> = [];
  for (const [sessionKey, entry] of Object.entries(manifest.sessions)) {
    let archive: string;
    try { archive = await readFile(path.join(paths(input.root, input.storageDir).dir, entry.file), 'utf8'); } catch { continue; }
    const lines = archive.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const lower = lines[index].toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (!score) continue;
      matches.push({ sessionKey, archive: entry.file, line: index + 1, snippet: lines[index].slice(0, 500), score });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.sessionKey.localeCompare(b.sessionKey) || a.line - b.line);
  return { matches: matches.slice(0, input.limit), truncated: matches.length > input.limit };
}

function utf8Slice(buffer: Buffer, cursor: number, maxTokens: number): { text: string; nextOffset: number | null } {
  let start = Math.min(Math.max(0, cursor), buffer.length);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  let end = Math.min(buffer.length, start + maxTokens);
  if (end < buffer.length) while (end > start && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(start, end).toString('utf8'), nextOffset: end < buffer.length ? end : null };
}

export async function readProjectHistory(input: {
  root: string;
  sessionKey: string;
  cursor: number;
  maxTokens: number;
  storageDir?: string;
}) {
  const key = safeSessionKey(input.sessionKey);
  const manifest = await loadManifest(input.root, input.storageDir);
  const entry = manifest.sessions[key];
  if (!entry) throw new Error('Unknown history session key');
  const buffer = await readFile(path.join(paths(input.root, input.storageDir).dir, entry.file));
  const page = utf8Slice(buffer, input.cursor, input.maxTokens);
  return {
    sessionKey: key,
    archive: entry.file,
    offset: input.cursor,
    totalBytes: buffer.length,
    text: page.text,
    nextOffset: page.nextOffset,
    archiveHash: entry.archiveHash,
  };
}

export async function verifyProjectHistory(root: string, storageDir?: string) {
  const manifest = await loadManifest(root, storageDir);
  const store = paths(root, storageDir);
  const issues: string[] = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(manifest.sessions)) {
    try {
      const content = await readFile(path.join(store.dir, entry.file));
      checked += 1;
      const actual = sha256(content);
      if (actual !== entry.archiveHash) issues.push(`${key}: archive hash mismatch`);
    } catch {
      issues.push(`${key}: archive file missing`);
    }
  }
  try {
    const files = await readdir(store.sessions);
    const known = new Set(Object.values(manifest.sessions).map((entry) => path.basename(entry.file)));
    for (const file of files.filter((name) => name.endsWith('.md'))) if (!known.has(file)) issues.push(`orphan archive: sessions/${file}`);
  } catch (error) {
    if (Object.keys(manifest.sessions).length) issues.push(`sessions directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let manifestUpdatedAt: string | null = null;
  try { manifestUpdatedAt = (await stat(store.manifest)).mtime.toISOString(); } catch {}
  return { ok: issues.length === 0, checkedSessions: checked, manifestUpdatedAt, issues };
}
