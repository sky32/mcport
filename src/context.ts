import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { globIterate } from 'glob';

const EXACT_CONTEXT_FILES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'SKILL.md',
  'package.json',
  'pyproject.toml',
  'composer.json',
  'Cargo.toml',
  'go.mod',
  'Gemfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
]);

const CONTEXT_IGNORES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/release/**',
  '**/coverage/**',
  '**/out/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.remote-workspace-mcp/**',
];

export async function discoverContext(workspaceRoot: string, limit = 100) {
  const files: string[] = [];
  for await (const matched of globIterate('**/*', {
    cwd: workspaceRoot,
    nodir: true,
    dot: true,
    follow: false,
    maxDepth: 7,
    ignore: CONTEXT_IGNORES,
  })) {
    const relative = String(matched);
    const segments = relative.split(/[\\/]/);
    if (segments.some((segment) => segment.startsWith('.') && !['.github', '.cursor'].includes(segment))) continue;
    const name = path.basename(relative);
    const isSkillMarkdown = name.endsWith('.md') && segments.includes('skills');
    if (
      EXACT_CONTEXT_FILES.has(name)
      || name === 'copilot-instructions.md'
      || name.endsWith('.mdc')
      || isSkillMarkdown
    ) {
      files.push(relative);
      if (files.length >= limit) break;
    }
  }

  let packageInfo: Record<string, unknown> | undefined;
  const packagePath = path.join(workspaceRoot, 'package.json');
  try {
    if ((await stat(packagePath)).isFile()) {
      const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
      packageInfo = { name: parsed.name, packageManager: parsed.packageManager, scripts: parsed.scripts };
    }
  } catch {
    // package.json is optional and discovery must remain best-effort.
  }

  const runtimes = new Set<string>();
  for (const file of files) {
    if (file === 'package.json') runtimes.add('node');
    if (file === 'pyproject.toml') runtimes.add('python');
    if (file === 'composer.json') runtimes.add('php');
    if (file === 'Cargo.toml') runtimes.add('rust');
    if (file === 'go.mod') runtimes.add('go');
    if (file === 'Gemfile') runtimes.add('ruby');
  }

  return { contextFiles: files.sort(), runtimes: [...runtimes], package: packageInfo, truncated: files.length >= limit };
}
