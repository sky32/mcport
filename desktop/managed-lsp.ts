import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';

export type ManagedLspStrategy = 'npm' | 'brew' | 'go' | 'rustup' | 'system';
export type ManagedLspDefinition = { id: string; label: string; command: string; strategy: ManagedLspStrategy; packages: string[]; description: string };
export type ManagedLspPackageStatus = { name: string; version: string | null; available: boolean };
export type ManagedLspStatus = { root: string; languages: Array<Omit<ManagedLspDefinition, 'packages'> & { installed: boolean; path: string | null; directory: string; version: string | null; packages: ManagedLspPackageStatus[] }> };
export type ManagedLspProgress = { language: string; phase: 'checking' | 'installing' | 'complete' | 'error'; message: string };

export const MANAGED_LSP_DEFINITIONS: readonly ManagedLspDefinition[] = [
  { id: 'typescript', label: 'TypeScript / JavaScript', command: 'typescript-language-server', strategy: 'npm', packages: ['typescript-language-server@latest', 'typescript@latest'], description: 'TypeScript 与 JavaScript 语义服务' },
  { id: 'html', label: 'HTML', command: 'vscode-html-language-server', strategy: 'npm', packages: ['vscode-langservers-extracted@latest'], description: 'HTML 语言服务' },
  { id: 'css', label: 'CSS / SCSS / LESS', command: 'vscode-css-language-server', strategy: 'npm', packages: ['vscode-langservers-extracted@latest'], description: 'CSS、SCSS 与 LESS 语言服务' },
  { id: 'python', label: 'Python', command: 'pyright-langserver', strategy: 'npm', packages: ['pyright@latest'], description: 'Pyright Python 语言服务' },
  { id: 'json', label: 'JSON', command: 'vscode-json-language-server', strategy: 'npm', packages: ['vscode-langservers-extracted@latest'], description: 'JSON / JSONC 语言服务' },
  { id: 'yaml', label: 'YAML', command: 'yaml-language-server', strategy: 'npm', packages: ['yaml-language-server@latest'], description: 'YAML 语言服务' },
  { id: 'markdown', label: 'Markdown', command: 'marksman', strategy: 'system', packages: [], description: 'Marksman Markdown 语言服务' },
  { id: 'go', label: 'Go', command: 'gopls', strategy: 'go', packages: [], description: '官方 gopls 语言服务' },
  { id: 'rust', label: 'Rust', command: 'rust-analyzer', strategy: 'rustup', packages: [], description: 'rust-analyzer 语言服务' },
  { id: 'java', label: 'Java', command: 'jdtls', strategy: 'system', packages: [], description: 'Eclipse JDT Language Server' },
  { id: 'c', label: 'C', command: 'clangd', strategy: 'system', packages: [], description: 'LLVM clangd 语言服务' },
  { id: 'cpp', label: 'C++', command: 'clangd', strategy: 'system', packages: [], description: 'LLVM clangd 语言服务' },
  { id: 'php', label: 'PHP', command: 'intelephense', strategy: 'npm', packages: ['intelephense@latest'], description: 'Intelephense PHP 语言服务' },
] as const;

function rootPath(userData: string): string { return path.join(userData, 'managed-tools', 'lsp'); }
function languageRoot(userData: string, id: string): string { return path.join(rootPath(userData), id); }
function npmCommand(): string { return process.platform === 'win32' ? 'npm.cmd' : 'npm'; }

async function linuxPackageManager(): Promise<{ command: string; installArgs: string[] } | null> {
  let release = '';
  try { release = await readFile('/etc/os-release', 'utf8'); } catch { /* use executable probing below */ }
  const id = /^(?:ID|ID_LIKE)=(.*)$/m.exec(release)?.[1]?.replaceAll('"', '').toLowerCase() || '';
  const candidates = id.includes('alpine')
    ? [{ name: 'apk', args: ['add'] }]
    : id.includes('arch') || id.includes('manjaro')
      ? [{ name: 'pacman', args: ['-S', '--noconfirm'] }]
      : id.includes('fedora') || id.includes('rhel') || id.includes('centos') || id.includes('rocky') || id.includes('suse')
        ? [{ name: id.includes('suse') ? 'zypper' : 'dnf', args: ['install', '-y'] }]
        : [{ name: 'apt-get', args: ['install', '-y'] }, { name: 'dnf', args: ['install', '-y'] }, { name: 'pacman', args: ['-S', '--noconfirm'] }];
  for (const candidate of candidates) {
    for (const directory of ['/usr/bin', '/bin', '/usr/local/bin']) {
      try { await access(path.join(directory, candidate.name), fs.constants.X_OK); return { command: candidate.name, installArgs: candidate.args }; } catch {}
    }
  }
  return null;
}

async function systemInstallPlan(definition: ManagedLspDefinition): Promise<{ command: string; args: string[] }> {
  if (process.platform === 'win32') {
    const ids: Record<string, string> = { markdown: 'artempyanykh.marksman', c: 'LLVM.LLVM', cpp: 'LLVM.LLVM' };
    const packageId = ids[definition.id];
    if (!packageId) throw new Error(`${definition.label} 在 Windows 没有可靠的内置安装包；请安装 ${definition.command} 后加入 Runtime PATH，或使用自定义 LSP。`);
    return { command: 'winget.exe', args: ['install', '--id', packageId, '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements'] };
  }
  if (process.platform === 'linux') {
    const packages: Record<string, string> = { markdown: 'marksman', java: 'jdtls', c: 'clangd', cpp: 'clangd' };
    const packageName = packages[definition.id];
    const manager = await linuxPackageManager();
    if (!packageName || !manager) throw new Error(`${definition.label} 在当前 Linux 系统没有可用的自动安装包管理器；请手动安装 ${definition.command} 后加入 Runtime PATH，或使用自定义 LSP。`);
    return { command: 'sudo', args: ['-n', manager.command, ...manager.installArgs, packageName] };
  }
  throw new Error(`${definition.label} 暂不支持当前操作系统的自动安装；请使用自定义 LSP。`);
}

async function packageVersion(root: string, name: string): Promise<string | null> {
  try { const value = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }; return typeof value.version === 'string' ? value.version : null; } catch { return null; }
}

async function executablePath(root: string, command: string, runtimePath: string): Promise<string | null> {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(root, 'node_modules', '.bin', `${command}${suffix}`);
  try { await access(local, fs.constants.X_OK); return local; } catch {}
  const fallbackEntries = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/opt/homebrew/opt/marksman/bin', '/opt/homebrew/opt/jdtls/bin', '/opt/homebrew/opt/llvm/bin', '/usr/local/bin', '/usr/local/sbin', '/usr/local/opt/marksman/bin', '/usr/local/opt/jdtls/bin', '/usr/local/opt/llvm/bin']
    : [path.join(process.env.HOME || process.env.USERPROFILE || '', 'go', 'bin'), path.join(process.env.HOME || process.env.USERPROFILE || '', '.cargo', 'bin'), path.join(process.env.HOME || process.env.USERPROFILE || '', '.local', 'bin'), path.join(process.env.HOME || process.env.USERPROFILE || '', '.dotnet', 'tools')];
  const searchEntries = [...new Set([...runtimePath.split(path.delimiter), ...fallbackEntries].filter(Boolean))];
  for (const entry of searchEntries) {
    const candidate = path.join(entry, process.platform === 'win32' ? `${command}.exe` : command);
    try { await access(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

async function executableVersion(executable: string | null, definition: ManagedLspDefinition): Promise<string | null> {
  if (!executable || definition.id === 'java') return null;
  const args = definition.id === 'go' ? ['version'] : ['--version'];
  return await new Promise((resolve) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(value); } };
    const timeout = setTimeout(() => { child.kill(); finish(null); }, 3_000);
    child.stdout.on('data', (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(0, 300); });
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code === 0 ? output.trim().split(/\r?\n/)[0] || null : null));
  });
}

async function runInstaller(command: string, args: string[], cwd: string, runtimePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const installerPath = [...new Set([runtimePath, process.env.PATH].filter(Boolean))].join(path.delimiter);
    const child = spawn(command, args, { cwd, env: { ...process.env, PATH: installerPath }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk.toString('utf8')}`.slice(-4000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000); });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${command} 安装超时（超过 10 分钟）；请检查网络、包管理器锁或系统权限。`));
    }, 10 * 60 * 1000);
    child.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
    child.once('exit', (code) => code === 0 ? finish() : finish(new Error(`${command} 安装失败（退出码 ${code ?? 'unknown'}）：${(stderr || stdout).trim() || '安装器未返回详细原因'}`)));
  });
}

async function verifyBrewFormula(formula: string, runtimePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const installerPath = [...new Set([runtimePath, process.env.PATH].filter(Boolean))].join(path.delimiter);
    const child = spawn('brew', ['list', '--versions', formula], { env: { ...process.env, PATH: installerPath }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(-1000); });
    child.stderr.on('data', (chunk) => { output = `${output}${chunk.toString('utf8')}`.slice(-1000); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 && output.trim()) resolve();
      else reject(new Error(`Homebrew 未确认 ${formula} 已安装${output.trim() ? `：${output.trim()}` : ''}`));
    });
  });
}

async function statusFor(userData: string, definition: ManagedLspDefinition, runtimePath: string) {
  const root = languageRoot(userData, definition.id);
  const packages = await Promise.all(definition.packages.map(async (spec) => {
    const name = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1)) : spec.split('@')[0];
    return { name, version: await packageVersion(root, name), available: Boolean(await executablePath(root, definition.command, runtimePath)) };
  }));
  const executable = await executablePath(root, definition.command, runtimePath);
  return { ...definition, installed: Boolean(executable), path: executable, directory: executable ? path.dirname(executable) : root, version: await executableVersion(executable, definition), packages };
}

export async function managedLspStatus(userData: string, runtimePath = process.env.PATH || ''): Promise<ManagedLspStatus> {
  return { root: rootPath(userData), languages: await Promise.all(MANAGED_LSP_DEFINITIONS.map((item) => statusFor(userData, item, runtimePath))) };
}

export async function installManagedLsp(userData: string, languageId: string, runtimePath: string, onProgress?: (progress: ManagedLspProgress) => void): Promise<ManagedLspStatus> {
  const definition = MANAGED_LSP_DEFINITIONS.find((item) => item.id === languageId);
  if (!definition) throw new Error(`未知的 LSP 语言：${languageId}`);
  const root = languageRoot(userData, definition.id);
  await mkdir(root, { recursive: true });
  onProgress?.({ language: definition.id, phase: 'checking', message: `正在检查 ${definition.label} 安装环境…` });
  onProgress?.({ language: definition.id, phase: 'installing', message: `正在下载或更新 ${definition.label}…` });
  if (definition.strategy === 'npm') await runInstaller(npmCommand(), ['install', '--prefix', root, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund', ...definition.packages], root, runtimePath);
  else if (definition.strategy === 'go') await runInstaller('go', ['install', 'golang.org/x/tools/gopls@latest'], root, runtimePath);
  else if (definition.strategy === 'rustup') await runInstaller('rustup', ['component', 'add', 'rust-analyzer'], root, runtimePath);
  else if (definition.strategy === 'system' && process.platform === 'darwin') {
    const formula = definition.id === 'c' || definition.id === 'cpp' ? 'llvm' : definition.id === 'markdown' ? 'marksman' : definition.id;
    const current = Boolean(await executablePath(root, definition.command, runtimePath));
    await runInstaller('brew', [current ? 'upgrade' : 'install', formula], root, runtimePath);
    await verifyBrewFormula(formula, runtimePath);
    await runInstaller('brew', ['link', '--overwrite', '--force', formula], root, runtimePath);
  } else if (definition.strategy === 'system') {
    const plan = await systemInstallPlan(definition);
    await runInstaller(plan.command, plan.args, root, runtimePath);
  } else throw new Error(`${definition.label} 的自动安装需要 ${definition.command} 或对应工具链；请将其加入 Runtime PATH，或使用自定义 LSP。`);
  const status = await managedLspStatus(userData, runtimePath);
  const result = status.languages.find((item) => item.id === definition.id);
  if (!result?.installed) throw new Error(`${definition.label} 安装命令已返回成功，但未找到可执行文件 ${definition.command}。请检查安装器输出、系统架构和 Runtime PATH。`);
  await writeFile(path.join(root, 'mcport-managed.json'), `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), language: definition.id, packages: result.packages }, null, 2)}\n`, 'utf8');
  onProgress?.({ language: definition.id, phase: 'complete', message: `${definition.label} 已安装或更新` });
  return status;
}
