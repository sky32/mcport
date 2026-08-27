import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `${process.pid}-${Date.now()}`;
const dataDir = path.join(root, 'data', `desktop-corrupt-storage-${runId}`);
const workspaceRoot = path.join(root, 'workspaces', `desktop-corrupt-storage-${runId}`);
const settingsPath = path.join(dataDir, 'desktop-settings.json');
const secretsPath = path.join(dataDir, 'desktop-secrets.json');
const journalPath = path.join(dataDir, 'desktop-save-journal.json');

await rm(dataDir, { recursive: true, force: true });
await rm(workspaceRoot, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await writeFile(settingsPath, '{broken-settings\n', 'utf8');
await writeFile(secretsPath, '["broken-secret-shape"]\n', 'utf8');
await writeFile(journalPath, '{broken-journal\n', 'utf8');

const electronBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const desktop = spawn(electronBin, ['.', '--hidden'], {
  cwd: root,
  env: {
    ...process.env,
    RW_MCP_DESKTOP_USER_DATA: dataDir,
    RW_MCP_DESKTOP_DEFAULT_WORKSPACE_ROOT: workspaceRoot,
    RW_MCP_DESKTOP_DEBUG: '1',
    RW_MCP_DESKTOP_ALLOW_MULTIPLE: '1',
    RW_MCP_DESKTOP_SKIP_LOGIN_ITEM: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

async function waitForRecoveredFiles() {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    try {
      const names = await readdir(dataDir);
      const settingsBackup = names.find((name) => name.startsWith('desktop-settings.json.corrupt-'));
      const secretsBackup = names.find((name) => name.startsWith('desktop-secrets.json.corrupt-'));
      const journalBackup = names.find((name) => name.startsWith('desktop-save-journal.json.corrupt-'));
      if (settingsBackup && secretsBackup && journalBackup) return { settingsBackup, secretsBackup, journalBackup };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Corrupt storage was not backed up in time\n${stderr}`);
}

async function waitForRecoveredState() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (desktop.exitCode !== null) throw new Error(`Desktop exited early (${desktop.exitCode})\n${stderr}`);
    try {
      const recoveredSettings = JSON.parse(await readFile(settingsPath, 'utf8'));
      const recoveredSecrets = JSON.parse(await readFile(secretsPath, 'utf8'));
      if (
        recoveredSettings?.settingsVersion === 18
        && recoveredSecrets
        && typeof recoveredSecrets === 'object'
        && !Array.isArray(recoveredSecrets)
      ) return { recoveredSettings, recoveredSecrets };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Recovered storage was not fully rewritten in time\n${stderr}`);
}

try {
  const { settingsBackup, secretsBackup, journalBackup } = await waitForRecoveredFiles();
  const backedSettings = await readFile(path.join(dataDir, settingsBackup), 'utf8');
  const backedSecrets = await readFile(path.join(dataDir, secretsBackup), 'utf8');
  const backedJournal = await readFile(path.join(dataDir, journalBackup), 'utf8');
  if (backedSettings !== '{broken-settings\n') throw new Error('Corrupt settings backup does not preserve the original bytes');
  if (backedSecrets !== '["broken-secret-shape"]\n') throw new Error('Corrupt secret backup does not preserve the original bytes');
  if (backedJournal !== '{broken-journal\n') throw new Error('Corrupt save-journal backup does not preserve the original bytes');

  const { recoveredSettings, recoveredSecrets } = await waitForRecoveredState();
  if (recoveredSettings.settingsVersion !== 18) throw new Error(`Unexpected recovered settings version: ${recoveredSettings.settingsVersion}`);
  if (recoveredSettings.workspaceRoot !== workspaceRoot) throw new Error(`Recovery used the wrong isolated Workspace root: ${recoveredSettings.workspaceRoot}`);
  if (
    recoveredSettings.appearance !== 'system'
    || recoveredSettings.uiLanguage !== 'system'
    || recoveredSettings.debugMode !== 'off'
    || recoveredSettings.lowMemoryTray !== true
    || recoveredSettings.publicAccessProvider !== 'cloudflare'
    || recoveredSettings.publicClientMode !== 'managed'
  ) {
    throw new Error(`Recovered settings do not use safe v18 defaults: ${JSON.stringify(recoveredSettings)}`);
  }
  if (!recoveredSecrets || typeof recoveredSecrets !== 'object' || Array.isArray(recoveredSecrets)) {
    throw new Error('Recovered secret file is not a JSON object');
  }

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'corrupt_settings_backed_up_before_recovery',
      'corrupt_secrets_backed_up_before_recovery',
      'corrupt_save_journal_backed_up_before_discard',
      'settings_recovered_to_valid_current_schema',
      'settings_recovered_with_v18_safe_defaults',
      'secrets_recovered_to_valid_object',
      'recovery_does_not_touch_real_documents_workspace',
    ],
  }, null, 2));
} finally {
  if (desktop.exitCode === null) desktop.kill('SIGTERM');
  await Promise.race([once(desktop, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
