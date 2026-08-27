import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { globIterate } from 'glob';
import Parser from 'web-tree-sitter';
import { DEFAULT_FILE_IGNORES } from './file-tools.js';
import { resolveExistingPath } from './security.js';

type LanguageName = 'typescript' | 'tsx' | 'javascript';

type IndexedSymbol = {
  path: string;
  name: string;
  qualifiedName: string;
  kind: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  parentSymbol: string | null;
  signature: string;
  contentHash: string;
};

type ParsedFile = {
  symbols: IndexedSymbol[];
  references: Array<{ symbolName: string; kind: string; line: number; column: number; context: string }>;
  imports: Array<{ source: string; importedName: string | null; localName: string | null; line: number }>;
  calls: Array<{ callerSymbol: string | null; calleeName: string; line: number; column: number }>;
};

type WorkspaceIndexStatus = {
  status: 'indexed' | 'indexing' | 'stale' | 'failed';
  fileCount: number;
  symbolCount: number;
  lastIndexedAt: string | null;
  languages: string[];
  error: string | null;
};

const CODE_PATTERNS = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];
const require = createRequire(import.meta.url);
const grammarRoot = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
let parserInit: Promise<void> | null = null;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function languageForPath(filePath: string): LanguageName | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  return null;
}

function grammarFile(language: LanguageName): string {
  if (language === 'typescript') return 'tree-sitter-typescript.wasm';
  if (language === 'tsx') return 'tree-sitter-tsx.wasm';
  return 'tree-sitter-javascript.wasm';
}

function compactText(value: string, max = 320): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function signatureFor(node: Parser.SyntaxNode): string {
  const text = node.text;
  const brace = text.indexOf('{');
  const bodyless = brace >= 0 ? text.slice(0, brace) : text.split(/\r?\n/, 1)[0];
  return compactText(bodyless || text);
}

function symbolKind(node: Parser.SyntaxNode): string | null {
  switch (node.type) {
    case 'class_declaration': return 'class';
    case 'function_declaration': return 'function';
    case 'method_definition': return 'method';
    case 'interface_declaration': return 'interface';
    case 'type_alias_declaration': return 'type';
    case 'enum_declaration': return 'enum';
    case 'variable_declarator': {
      const value = node.childForFieldName('value');
      return value && ['arrow_function', 'function'].includes(value.type) ? 'function' : 'variable';
    }
    default: return null;
  }

}

function symbolName(node: Parser.SyntaxNode): string | null {
  const named = node.childForFieldName('name');
  if (named?.text) return named.text;
  if (node.type === 'method_definition') {
    const first = node.namedChildren[0];
    return first?.text || null;
  }
  return null;
}

function calleeName(node: Parser.SyntaxNode): string {
  const fn = node.childForFieldName('function');
  if (!fn) return '';
  if (fn.type === 'member_expression') {
    const property = fn.childForFieldName('property');
    return property?.text || compactText(fn.text, 160);
  }
  return compactText(fn.text, 160);
}

function parseImport(node: Parser.SyntaxNode) {
  const source = node.childForFieldName('source')?.text?.replace(/^['"]|['"]$/g, '') || '';
  const clause = node.namedChildren.find((child) => child.type === 'import_clause');
  return {
    source,
    importedName: clause ? compactText(clause.text, 180) : null,
    localName: null,
    line: node.startPosition.row + 1,
  };
}

class TreeSitterPool {
  private readonly languages = new Map<LanguageName, Parser.Language>();

  private async init(): Promise<void> {
    parserInit ??= Parser.init();
    await parserInit;
  }

  async createParser(language: LanguageName): Promise<Parser> {
    await this.init();
    let grammar = this.languages.get(language);
    if (!grammar) {
      grammar = await Parser.Language.load(path.join(grammarRoot, grammarFile(language)));
      this.languages.set(language, grammar);
    }
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  }
}

function parseTree(filePath: string, source: string, tree: Parser.Tree): ParsedFile {
  const symbols: ParsedFile['symbols'] = [];
  const references: ParsedFile['references'] = [];
  const imports: ParsedFile['imports'] = [];
  const calls: ParsedFile['calls'] = [];

  const walk = (node: Parser.SyntaxNode, parents: string[]) => {
    const kind = symbolKind(node);
    const name = kind ? symbolName(node) : null;
    let nextParents = parents;
    if (kind && name) {
      const qualifiedName = [...parents, name].join('.');
      symbols.push({
        path: filePath,
        name,
        qualifiedName,
        kind,
        startByte: node.startIndex,
        endByte: node.endIndex,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parentSymbol: parents.length ? parents.join('.') : null,
        signature: signatureFor(node),
        contentHash: sha256(node.text),
      });
      nextParents = [...parents, name];
    }

    if (node.type === 'import_statement') imports.push(parseImport(node));
    if (node.type === 'call_expression') {
      const callee = calleeName(node);
      if (callee) {
        calls.push({
          callerSymbol: nextParents.length ? nextParents.join('.') : null,
          calleeName: callee,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
        });
      }
    }
    if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'property_identifier') {
      const value = node.text;
      if (value && value.length <= 200) {
        references.push({
          symbolName: value,
          kind: node.type,
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
          context: compactText(node.parent?.text || value, 240),
        });
      }
    }
    for (const child of node.namedChildren) walk(child, nextParents);
  };
  walk(tree.rootNode, []);
  return { symbols, references, imports, calls };
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS code_files (
      workspace TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      sha256 TEXT NOT NULL,
      language TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (workspace, path)
    );
    CREATE TABLE IF NOT EXISTS code_symbols (
      workspace TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      parent_symbol TEXT,
      signature TEXT NOT NULL,
      content_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_symbols_lookup ON code_symbols(workspace, name, qualified_name);
    CREATE INDEX IF NOT EXISTS idx_code_symbols_path ON code_symbols(workspace, path, start_line);
    CREATE TABLE IF NOT EXISTS code_references (
      workspace TEXT NOT NULL,
      path TEXT NOT NULL,
      symbol_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      column_no INTEGER NOT NULL,
      context TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_refs_lookup ON code_references(workspace, symbol_name);
    CREATE TABLE IF NOT EXISTS code_imports (
      workspace TEXT NOT NULL,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      imported_name TEXT,
      local_name TEXT,
      line INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_calls (
      workspace TEXT NOT NULL,
      path TEXT NOT NULL,
      caller_symbol TEXT,
      callee_name TEXT NOT NULL,
      line INTEGER NOT NULL,
      column_no INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_calls_lookup ON code_calls(workspace, callee_name);
    CREATE TABLE IF NOT EXISTS code_index_state (
      workspace TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      symbol_count INTEGER NOT NULL DEFAULT 0,
      last_indexed_at TEXT,
      languages_json TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );
  `);
}

export class CodeIndexManager {
  private readonly db: DatabaseSync;
  private readonly parsers = new TreeSitterPool();
  private readonly dirty = new Set<string>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly inflight = new Map<string, Promise<WorkspaceIndexStatus>>();
  private readonly lastChecked = new Map<string, number>();

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
    ensureSchema(this.db);
  }

  status(workspaceRoot: string): WorkspaceIndexStatus {
    const row = this.db.prepare('SELECT * FROM code_index_state WHERE workspace = ?').get(workspaceRoot) as any;
    if (!row) return { status: 'stale', fileCount: 0, symbolCount: 0, lastIndexedAt: null, languages: [], error: null };
    const stored = String(row.status || 'stale') as WorkspaceIndexStatus['status'];
    return {
      status: this.dirty.has(workspaceRoot) && stored === 'indexed' ? 'stale' : stored,
      fileCount: Number(row.file_count || 0),
      symbolCount: Number(row.symbol_count || 0),
      lastIndexedAt: row.last_indexed_at ? String(row.last_indexed_at) : null,
      languages: JSON.parse(String(row.languages_json || '[]')),
      error: row.error ? String(row.error) : null,
    };
  }

  markDirty(workspaceRoot: string): void {
    this.dirty.add(workspaceRoot);
  }

  async ensure(workspaceRoot: string): Promise<WorkspaceIndexStatus> {
    const existing = this.inflight.get(workspaceRoot);
    if (existing) return existing;
    const current = this.status(workspaceRoot);
    const now = Date.now();
    if (current.status === 'indexed' && !this.dirty.has(workspaceRoot) && now - (this.lastChecked.get(workspaceRoot) || 0) < 60_000) {
      this.startWatcher(workspaceRoot);
      return current;
    }
    const task = this.refresh(workspaceRoot).finally(() => this.inflight.delete(workspaceRoot));
    this.inflight.set(workspaceRoot, task);
    return task;
  }

  repoMap(workspaceRoot: string, input: { focusFiles?: string[]; focusSymbols?: string[]; maxFiles: number; maxSymbolsPerFile: number }) {
    const focusFiles = new Set(input.focusFiles || []);
    const focusSymbols = new Set((input.focusSymbols || []).map((value) => value.toLowerCase()));
    const rows = this.db.prepare(`
      SELECT path, name, qualified_name, kind, signature, start_line, end_line
      FROM code_symbols WHERE workspace = ? ORDER BY path, start_line
    `).all(workspaceRoot) as any[];
    const grouped = new Map<string, any[]>();
    for (const row of rows) {
      const list = grouped.get(row.path) || [];
      list.push(row);
      grouped.set(row.path, list);
    }
    const ranked = [...grouped.entries()].map(([filePath, symbols]) => {
      let score = symbols.length;
      if (focusFiles.has(filePath)) score += 10_000;
      for (const symbol of symbols) {
        if (focusSymbols.has(String(symbol.name).toLowerCase()) || focusSymbols.has(String(symbol.qualified_name).toLowerCase())) score += 2_000;
      }
      return { filePath, symbols, score };
    }).sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
    const files = ranked.slice(0, input.maxFiles).map(({ filePath, symbols }) => ({
      path: filePath,
      symbols: symbols.slice(0, input.maxSymbolsPerFile).map((row) => ({
        name: row.name,
        qualifiedName: row.qualified_name,
        kind: row.kind,
        signature: row.signature,
        startLine: row.start_line,
        endLine: row.end_line,
      })),
    }));
    return { files, totalFiles: grouped.size, totalSymbols: rows.length, truncated: ranked.length > files.length };
  }

  searchSymbols(workspaceRoot: string, query: string, limit: number) {
    const needle = `%${query.toLowerCase()}%`;
    const rows = this.db.prepare(`
      SELECT path, name, qualified_name, kind, signature, start_line, end_line
      FROM code_symbols
      WHERE workspace = ? AND (lower(name) LIKE ? OR lower(qualified_name) LIKE ? OR lower(signature) LIKE ?)
      ORDER BY CASE WHEN lower(qualified_name) = lower(?) THEN 0 WHEN lower(name) = lower(?) THEN 1 ELSE 2 END, length(qualified_name), path, start_line
      LIMIT ?
    `).all(workspaceRoot, needle, needle, needle, query, query, limit) as any[];
    return rows.map((row) => ({
      path: row.path,
      name: row.name,
      qualifiedName: row.qualified_name,
      kind: row.kind,
      signature: row.signature,
      startLine: row.start_line,
      endLine: row.end_line,
    }));
  }

  symbolsForRange(workspaceRoot: string, filePath: string, startLine: number, endLine: number) {
    const rows = this.db.prepare(`
      SELECT path, name, qualified_name, kind, signature, start_line, end_line
      FROM code_symbols
      WHERE workspace = ? AND path = ? AND end_line >= ? AND start_line <= ?
      ORDER BY (end_line - start_line), start_line
    `).all(workspaceRoot, filePath, startLine, endLine) as any[];
    return rows.map((row) => ({
      path: row.path,
      name: row.name,
      qualifiedName: row.qualified_name,
      kind: row.kind,
      signature: row.signature,
      startLine: row.start_line,
      endLine: row.end_line,
    }));
  }

  findSymbol(workspaceRoot: string, query: string, filePath?: string): any | null {
    const sql = `
      SELECT * FROM code_symbols
      WHERE workspace = ? ${filePath ? 'AND path = ?' : ''}
        AND (qualified_name = ? OR name = ?)
      ORDER BY CASE WHEN qualified_name = ? THEN 0 ELSE 1 END, start_line
      LIMIT 1
    `;
    const args = filePath ? [workspaceRoot, filePath, query, query, query] : [workspaceRoot, query, query, query];
    return this.db.prepare(sql).get(...args) as any || null;
  }

  symbolDependencies(workspaceRoot: string, row: any) {
    const imports = this.db.prepare('SELECT source, imported_name, local_name, line FROM code_imports WHERE workspace = ? AND path = ? ORDER BY line')
      .all(workspaceRoot, row.path) as any[];
    const calls = this.db.prepare('SELECT callee_name, line, column_no FROM code_calls WHERE workspace = ? AND path = ? AND caller_symbol = ? ORDER BY line')
      .all(workspaceRoot, row.path, row.qualified_name) as any[];
    return {
      imports: imports.map((item) => ({ source: item.source, importedName: item.imported_name, localName: item.local_name, line: item.line })),
      calls: calls.map((item) => ({ calleeName: item.callee_name, line: item.line, column: item.column_no })),
    };
  }

  references(workspaceRoot: string, symbolNameValue: string, limit: number) {
    const rows = this.db.prepare(`
      SELECT path, symbol_name, kind, line, column_no, context FROM code_references
      WHERE workspace = ? AND symbol_name = ? ORDER BY path, line LIMIT ?
    `).all(workspaceRoot, symbolNameValue, limit) as any[];
    return rows.map((row) => ({ path: row.path, symbol: row.symbol_name, kind: row.kind, line: row.line, column: row.column_no, context: row.context }));
  }

  callers(workspaceRoot: string, symbolNameValue: string, limit: number) {
    const rows = this.db.prepare(`
      SELECT path, caller_symbol, callee_name, line, column_no FROM code_calls
      WHERE workspace = ? AND (callee_name = ? OR callee_name LIKE ?) ORDER BY path, line LIMIT ?
    `).all(workspaceRoot, symbolNameValue, `%.${symbolNameValue}`, limit) as any[];
    return rows.map((row) => ({ path: row.path, callerSymbol: row.caller_symbol, calleeName: row.callee_name, line: row.line, column: row.column_no }));
  }

  relatedSymbols(workspaceRoot: string, row: any, limit = 12) {
    const rows = this.db.prepare(`
      SELECT path, name, qualified_name, kind, signature, start_line, end_line FROM code_symbols
      WHERE workspace = ? AND path = ? AND parent_symbol IS ? AND qualified_name <> ?
      ORDER BY abs(start_line - ?) LIMIT ?
    `).all(workspaceRoot, row.path, row.parent_symbol, row.qualified_name, row.start_line, limit) as any[];
    return rows.map((item) => ({
      path: item.path,
      name: item.name,
      qualifiedName: item.qualified_name,
      kind: item.kind,
      signature: item.signature,
      startLine: item.start_line,
      endLine: item.end_line,
    }));
  }

  projectGraph(workspaceRoot: string, input: {
    level: 'module' | 'file' | 'symbol';
    focus?: string;
    depth: number;
    maxNodes: number;
  }) {
    const fileRows = this.db.prepare('SELECT path FROM code_files WHERE workspace = ? ORDER BY path').all(workspaceRoot) as any[];
    const files = fileRows.map((row) => String(row.path));
    const fileSet = new Set(files);
    const resolveImport = (from: string, source: string): string | null => {
      if (!source.startsWith('.')) return null;
      const raw = path.posix.normalize(path.posix.join(path.posix.dirname(from), source));
      const candidates = [
        raw,
        raw.replace(/\.js$/i, '.ts'), raw.replace(/\.js$/i, '.tsx'), raw.replace(/\.jsx$/i, '.tsx'),
        `${raw}.ts`, `${raw}.tsx`, `${raw}.js`, `${raw}.jsx`, `${raw}.mjs`, `${raw}.cjs`,
        `${raw}/index.ts`, `${raw}/index.tsx`, `${raw}/index.js`, `${raw}/index.jsx`,
      ];
      return candidates.find((candidate) => fileSet.has(candidate)) || null;
    };
    const moduleOf = (filePath: string): string => {
      const parts = filePath.split('/').filter(Boolean);
      return parts.length <= 1 ? '.' : parts[0];
    };

    let nodes: Array<{ id: string; kind: string; path?: string; label: string }> = [];
    let edges: Array<{ from: string; to: string; type: string }> = [];
    if (input.level === 'symbol') {
      const symbolRows = this.db.prepare('SELECT path, qualified_name, kind FROM code_symbols WHERE workspace = ? ORDER BY path, start_line').all(workspaceRoot) as any[];
      nodes = symbolRows.map((row) => ({
        id: `${row.path}#${row.qualified_name}`,
        kind: String(row.kind),
        path: String(row.path),
        label: String(row.qualified_name),
      }));
      const byShortName = new Map<string, string[]>();
      for (const node of nodes) {
        const short = node.label.split('.').at(-1) || node.label;
        byShortName.set(short, [...(byShortName.get(short) || []), node.id]);
      }
      const calls = this.db.prepare('SELECT path, caller_symbol, callee_name FROM code_calls WHERE workspace = ? AND caller_symbol IS NOT NULL').all(workspaceRoot) as any[];
      for (const call of calls) {
        const from = `${call.path}#${call.caller_symbol}`;
        const short = String(call.callee_name).split('.').at(-1) || String(call.callee_name);
        for (const to of byShortName.get(short) || []) edges.push({ from, to, type: 'call' });
      }
    } else {
      const imports = this.db.prepare('SELECT path, source FROM code_imports WHERE workspace = ? ORDER BY path, line').all(workspaceRoot) as any[];
      if (input.level === 'file') {
        nodes = files.map((filePath) => ({ id: filePath, kind: 'file', path: filePath, label: filePath }));
        for (const item of imports) {
          const target = resolveImport(String(item.path), String(item.source));
          if (target) edges.push({ from: String(item.path), to: target, type: 'import' });
        }
      } else {
        const modules = [...new Set(files.map(moduleOf))].sort();
        nodes = modules.map((moduleName) => ({ id: moduleName, kind: 'module', label: moduleName }));
        const seen = new Set<string>();
        for (const item of imports) {
          const target = resolveImport(String(item.path), String(item.source));
          if (!target) continue;
          const from = moduleOf(String(item.path));
          const to = moduleOf(target);
          const key = `${from}\0${to}`;
          if (from === to || seen.has(key)) continue;
          seen.add(key);
          edges.push({ from, to, type: 'import' });
        }
      }
    }

    const focus = input.focus?.trim().toLowerCase();
    if (focus) {
      const seeds = nodes.filter((node) => node.id.toLowerCase().includes(focus) || node.label.toLowerCase().includes(focus)).map((node) => node.id);
      const keep = new Set(seeds);
      let frontier = [...seeds];
      for (let depth = 0; depth < input.depth && frontier.length; depth += 1) {
        const next: string[] = [];
        for (const edge of edges) {
          if (frontier.includes(edge.from) && !keep.has(edge.to)) { keep.add(edge.to); next.push(edge.to); }
          if (frontier.includes(edge.to) && !keep.has(edge.from)) { keep.add(edge.from); next.push(edge.from); }
        }
        frontier = next;
      }
      nodes = nodes.filter((node) => keep.has(node.id));
      edges = edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
    }

    const totalNodes = nodes.length;
    if (nodes.length > input.maxNodes) {
      const keep = new Set(nodes.slice(0, input.maxNodes).map((node) => node.id));
      nodes = nodes.slice(0, input.maxNodes);
      edges = edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
    }
    return { level: input.level, nodes, edges, totalNodes, truncated: totalNodes > nodes.length };
  }

  closeRoot(workspaceRoot: string): void {
    const watcher = this.watchers.get(workspaceRoot);
    if (watcher) {
      watcher.close();
      this.watchers.delete(workspaceRoot);
    }
    this.dirty.delete(workspaceRoot);
    this.lastChecked.delete(workspaceRoot);
  }

  private startWatcher(workspaceRoot: string): void {
    if (this.watchers.has(workspaceRoot)) return;
    try {
      const watcher = watch(workspaceRoot, { recursive: true }, (_event, filename) => {
        const relative = String(filename || '');
        const ignoredSegments = new Set(['.git', 'node_modules', 'vendor', 'dist', 'dist-desktop', 'release', 'build', '.next', '.venv', 'venv', '.remote-workspace-mcp']);
        if (!relative || relative.split(/[\\/]/).some((segment) => ignoredSegments.has(segment))) return;
        if (languageForPath(relative)) this.dirty.add(workspaceRoot);
      });
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(workspaceRoot);
      });
      this.watchers.set(workspaceRoot, watcher);
    } catch {
      // ensure() falls back to a bounded periodic metadata scan.
    }
  }

  private async refresh(workspaceRoot: string): Promise<WorkspaceIndexStatus> {
    const started = new Date().toISOString();
    const forceHashCheck = this.dirty.has(workspaceRoot);
    this.db.prepare(`
      INSERT INTO code_index_state(workspace, status, file_count, symbol_count, last_indexed_at, languages_json, error)
      VALUES (?, 'indexing', 0, 0, NULL, '[]', NULL)
      ON CONFLICT(workspace) DO UPDATE SET status='indexing', error=NULL
    `).run(workspaceRoot);
    try {
      const existingRows = this.db.prepare('SELECT path, size, mtime_ms, sha256 FROM code_files WHERE workspace = ?').all(workspaceRoot) as any[];
      const existing = new Map(existingRows.map((row) => [String(row.path), row]));
      const seen = new Set<string>();
      const languages = new Set<string>();
      let fileCount = 0;

      for await (const matched of globIterate(CODE_PATTERNS, {
        cwd: workspaceRoot,
        dot: false,
        follow: false,
        nodir: true,
        ignore: DEFAULT_FILE_IGNORES,
      })) {
        const relative = String(matched);
        const language = languageForPath(relative);
        if (!language) continue;
        const target = await resolveExistingPath(workspaceRoot, relative);
        const info = await lstat(target);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
        fileCount += 1;
        seen.add(relative);
        languages.add(language);
        const previous = existing.get(relative);
        if (!forceHashCheck && previous && Number(previous.size) === info.size && Number(previous.mtime_ms) === info.mtimeMs) continue;
        const sourceBuffer = await readFile(target);
        if (sourceBuffer.includes(0)) continue;
        const digest = sha256(sourceBuffer);
        if (previous && String(previous.sha256) === digest) {
          this.db.prepare('UPDATE code_files SET size=?, mtime_ms=?, indexed_at=? WHERE workspace=? AND path=?')
            .run(info.size, info.mtimeMs, started, workspaceRoot, relative);
          continue;
        }
        const source = sourceBuffer.toString('utf8');
        const parser = await this.parsers.createParser(language);
        const tree = parser.parse(source);
        const parsed = parseTree(relative, source, tree);
        tree.delete();
        parser.delete();

        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const table of ['code_symbols', 'code_references', 'code_imports', 'code_calls']) {
            this.db.prepare(`DELETE FROM ${table} WHERE workspace = ? AND path = ?`).run(workspaceRoot, relative);
          }
          this.db.prepare(`
            INSERT INTO code_files(workspace,path,size,mtime_ms,sha256,language,indexed_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(workspace,path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,language=excluded.language,indexed_at=excluded.indexed_at
          `).run(workspaceRoot, relative, info.size, info.mtimeMs, digest, language, started);
          const insertSymbol = this.db.prepare(`INSERT INTO code_symbols(workspace,path,name,qualified_name,kind,start_byte,end_byte,start_line,end_line,parent_symbol,signature,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
          for (const item of parsed.symbols) insertSymbol.run(workspaceRoot, item.path, item.name, item.qualifiedName, item.kind, item.startByte, item.endByte, item.startLine, item.endLine, item.parentSymbol, item.signature, item.contentHash);
          const insertRef = this.db.prepare(`INSERT INTO code_references(workspace,path,symbol_name,kind,line,column_no,context) VALUES (?,?,?,?,?,?,?)`);
          for (const item of parsed.references) insertRef.run(workspaceRoot, relative, item.symbolName, item.kind, item.line, item.column, item.context);
          const insertImport = this.db.prepare(`INSERT INTO code_imports(workspace,path,source,imported_name,local_name,line) VALUES (?,?,?,?,?,?)`);
          for (const item of parsed.imports) insertImport.run(workspaceRoot, relative, item.source, item.importedName, item.localName, item.line);
          const insertCall = this.db.prepare(`INSERT INTO code_calls(workspace,path,caller_symbol,callee_name,line,column_no) VALUES (?,?,?,?,?,?)`);
          for (const item of parsed.calls) insertCall.run(workspaceRoot, relative, item.callerSymbol, item.calleeName, item.line, item.column);
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }

      for (const relative of existing.keys()) {
        if (seen.has(relative)) continue;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const table of ['code_files', 'code_symbols', 'code_references', 'code_imports', 'code_calls']) {
            this.db.prepare(`DELETE FROM ${table} WHERE workspace = ? AND path = ?`).run(workspaceRoot, relative);
          }
          this.db.exec('COMMIT');
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      }

      const symbolCount = Number((this.db.prepare('SELECT count(*) AS count FROM code_symbols WHERE workspace = ?').get(workspaceRoot) as any)?.count || 0);
      this.db.prepare(`UPDATE code_index_state SET status='indexed', file_count=?, symbol_count=?, last_indexed_at=?, languages_json=?, error=NULL WHERE workspace=?`)
        .run(fileCount, symbolCount, started, JSON.stringify([...languages].sort()), workspaceRoot);
      this.dirty.delete(workspaceRoot);
      this.lastChecked.set(workspaceRoot, Date.now());
      this.startWatcher(workspaceRoot);
      return this.status(workspaceRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare(`UPDATE code_index_state SET status='failed', error=? WHERE workspace=?`).run(message, workspaceRoot);
      return this.status(workspaceRoot);
    }
  }
}

const managers = new Map<string, CodeIndexManager>();

export function getCodeIndexManager(stateDbPath: string): CodeIndexManager {
  const dbPath = `${stateDbPath}.code-index.sqlite`;
  let manager = managers.get(dbPath);
  if (!manager) {
    manager = new CodeIndexManager(dbPath);
    managers.set(dbPath, manager);
  }
  return manager;
}

export async function readSymbolSource(workspaceRoot: string, row: any): Promise<string> {
  const target = await resolveExistingPath(workspaceRoot, String(row.path));
  const source = await readFile(target, 'utf8');
  const lines = source.split(/\r?\n/);
  return lines.slice(Math.max(0, Number(row.start_line) - 1), Number(row.end_line)).join('\n');
}

export async function readContainerSource(workspaceRoot: string, manager: CodeIndexManager, row: any): Promise<{ source: string; row: any }> {
  if (!row.parent_symbol) return { source: await readSymbolSource(workspaceRoot, row), row };
  const parent = manager.findSymbol(workspaceRoot, String(row.parent_symbol), String(row.path));
  if (!parent) return { source: await readSymbolSource(workspaceRoot, row), row };
  return { source: await readSymbolSource(workspaceRoot, parent), row: parent };
}

const syntaxPool = new TreeSitterPool();

function findErrorNode(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < 5_000) {
    const node = queue.shift()!;
    visited += 1;
    if (node.type === 'ERROR' || node.isMissing()) return node;
    for (const child of node.children) queue.push(child);
  }
  return null;
}

export type SyntaxCheckResult = { path: string; status: 'pass' | 'fail' | 'skipped'; detail?: string };

/** Parse source files with the existing tree-sitter grammars to surface syntax errors without running project tooling. */
export async function syntaxCheck(workspaceRoot: string, relativePaths: string[]): Promise<SyntaxCheckResult[]> {
  const results: SyntaxCheckResult[] = [];
  for (const relative of relativePaths.slice(0, 200)) {
    const language = languageForPath(relative);
    if (!language) {
      results.push({ path: relative, status: 'skipped', detail: 'unsupported language' });
      continue;
    }
    try {
      const target = await resolveExistingPath(workspaceRoot, relative);
      const info = await lstat(target);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) {
        results.push({ path: relative, status: 'skipped', detail: 'missing or oversized' });
        continue;
      }
      const buffer = await readFile(target);
      if (buffer.includes(0)) {
        results.push({ path: relative, status: 'skipped', detail: 'binary file' });
        continue;
      }
      const parser = await syntaxPool.createParser(language);
      const tree = parser.parse(buffer.toString('utf8'));
      let detail: string | undefined;
      if (tree.rootNode.hasError()) {
        const first = findErrorNode(tree.rootNode);
        detail = first ? `line ${first.startPosition.row + 1}: ${compactText(first.text, 160)}` : 'parse error';
      }
      tree.delete();
      parser.delete();
      results.push(detail ? { path: relative, status: 'fail', detail } : { path: relative, status: 'pass' });
    } catch (error) {
      results.push({ path: relative, status: 'skipped', detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
