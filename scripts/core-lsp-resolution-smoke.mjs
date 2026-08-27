import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LspManager, resolveLspExecutable, resolveTypeScriptServerOptions } from '../dist/lsp.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'rw-mcp-lsp-'));
const workspace = path.join(root, 'workspace');
const managedRoot = path.join(root, 'managed-lsp');
const runtimeBin = path.join(root, 'runtime-bin');
const command = process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server';

async function makeExecutable(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
  if (process.platform !== 'win32') await chmod(filePath, 0o755);
}

try {
  const workspaceExecutable = path.join(workspace, 'node_modules', '.bin', command);
  const managedEntryPoint = path.join(managedRoot, 'typescript', 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs');
  const managedHtmlEntryPoint = path.join(managedRoot, 'html', 'node_modules', 'vscode-langservers-extracted', 'bin', 'vscode-html-language-server');
  const managedCssEntryPoint = path.join(managedRoot, 'css', 'node_modules', 'vscode-langservers-extracted', 'bin', 'vscode-css-language-server');
  const runtimeExecutable = path.join(runtimeBin, command);
  await makeExecutable(workspaceExecutable);
  await mkdir(path.dirname(managedEntryPoint), { recursive: true });
  await writeFile(managedEntryPoint, 'process.exit(0);\n', 'utf8');
  await mkdir(path.dirname(managedHtmlEntryPoint), { recursive: true });
  await writeFile(managedHtmlEntryPoint, 'process.exit(0);\n', 'utf8');
  await mkdir(path.dirname(managedCssEntryPoint), { recursive: true });
  await writeFile(managedCssEntryPoint, 'process.exit(0);\n', 'utf8');
  await makeExecutable(runtimeExecutable);

  const managedTypeScriptPackage = path.join(managedRoot, 'typescript', 'node_modules', 'typescript', 'package.json');
  const managedTypeScriptPath = path.join(managedRoot, 'typescript', 'node_modules', 'typescript', 'lib');
  const managedTsserver = path.join(managedTypeScriptPath, 'tsserver.js');
  await mkdir(path.dirname(managedTsserver), { recursive: true });
  await writeFile(managedTypeScriptPackage, JSON.stringify({ version: '6.0.3' }), 'utf8');
  await writeFile(managedTsserver, 'process.exit(0);\n', 'utf8');
  for (const name of ['lib.d.ts', 'lib.es5.d.ts', 'lib.es2015.d.ts', 'lib.esnext.d.ts']) {
    await writeFile(path.join(managedTypeScriptPath, name), '// fixture\n', 'utf8');
  }

  const workspaceTypeScriptPackage = path.join(workspace, 'node_modules', 'typescript', 'package.json');
  const workspaceTsserver = path.join(workspace, 'node_modules', 'typescript', 'lib', 'tsserver.js');
  await mkdir(path.dirname(workspaceTypeScriptPackage), { recursive: true });
  await writeFile(workspaceTypeScriptPackage, JSON.stringify({ version: '7.0.2' }), 'utf8');
  let tsserverOptions = await resolveTypeScriptServerOptions(workspace, managedRoot);
  if (
    tsserverOptions.source !== 'managed'
    || tsserverOptions.workspaceVersion !== '7.0.2'
    || tsserverOptions.selectedVersion !== '6.0.3'
    || tsserverOptions.path !== managedTsserver
    || tsserverOptions.selectedTsserver !== managedTsserver
    || tsserverOptions.fallbackPath !== managedTypeScriptPath
    || !tsserverOptions.ready
    || tsserverOptions.missingRuntimeFiles.length !== 0
  ) {
    throw new Error(`TypeScript 7 compatibility fallback failed: ${JSON.stringify(tsserverOptions)}`);
  }

  await mkdir(path.dirname(workspaceTsserver), { recursive: true });
  await writeFile(workspaceTypeScriptPackage, JSON.stringify({ version: '6.0.3' }), 'utf8');
  await writeFile(workspaceTsserver, 'process.exit(0);\n', 'utf8');
  for (const name of ['lib.d.ts', 'lib.es5.d.ts', 'lib.es2015.d.ts', 'lib.esnext.d.ts']) {
    await writeFile(path.join(path.dirname(workspaceTsserver), name), '// fixture\n', 'utf8');
  }
  tsserverOptions = await resolveTypeScriptServerOptions(workspace, managedRoot);
  const workspaceTsserverReal = await realpath(workspaceTsserver);
  if (
    tsserverOptions.source !== 'workspace-compatible'
    || tsserverOptions.workspaceVersion !== '6.0.3'
    || tsserverOptions.selectedVersion !== '6.0.3'
    || tsserverOptions.selectedTsserver !== workspaceTsserverReal
    || tsserverOptions.path !== undefined
    || !tsserverOptions.ready
    || tsserverOptions.missingRuntimeFiles.length !== 0
  ) {
    throw new Error(`compatible Workspace TypeScript precedence failed: ${JSON.stringify(tsserverOptions)}`);
  }

  await rm(path.join(workspace, 'node_modules', 'typescript'), { recursive: true, force: true });
  tsserverOptions = await resolveTypeScriptServerOptions(workspace, managedRoot);
  if (
    tsserverOptions.source !== 'managed'
    || tsserverOptions.workspaceVersion !== null
    || tsserverOptions.selectedVersion !== '6.0.3'
    || tsserverOptions.path !== managedTsserver
    || tsserverOptions.selectedTsserver !== managedTsserver
    || !tsserverOptions.ready
    || tsserverOptions.missingRuntimeFiles.length !== 0
  ) {
    throw new Error(`managed TypeScript fallback selection failed: ${JSON.stringify(tsserverOptions)}`);
  }

  await rm(path.join(managedTypeScriptPath, 'lib.es5.d.ts'), { force: true });
  tsserverOptions = await resolveTypeScriptServerOptions(workspace, managedRoot);
  if (tsserverOptions.ready || !tsserverOptions.missingRuntimeFiles.includes('lib.es5.d.ts')) {
    throw new Error(`incomplete managed TypeScript runtime was not detected: ${JSON.stringify(tsserverOptions)}`);
  }
  await writeFile(path.join(managedTypeScriptPath, 'lib.es5.d.ts'), '// fixture\n', 'utf8');

  let resolved = await resolveLspExecutable(workspace, 'typescript-language-server', runtimeBin, managedRoot);
  if (resolved?.source !== 'workspace' || resolved.launchMode !== 'direct' || resolved.path !== workspaceExecutable) {
    throw new Error(`workspace precedence failed: ${JSON.stringify(resolved)}`);
  }

  await rm(workspaceExecutable, { force: true });
  resolved = await resolveLspExecutable(workspace, 'typescript-language-server', runtimeBin, managedRoot);
  if (resolved?.source !== 'managed' || resolved.launchMode !== 'embedded-node' || resolved.path !== managedEntryPoint) {
    throw new Error(`managed precedence failed: ${JSON.stringify(resolved)}`);
  }

  resolved = await resolveLspExecutable(workspace, 'vscode-html-language-server', runtimeBin, managedRoot);
  if (resolved?.source !== 'managed' || resolved.launchMode !== 'embedded-node' || resolved.path !== managedHtmlEntryPoint) {
    throw new Error(`managed HTML resolution failed: ${JSON.stringify(resolved)}`);
  }
  resolved = await resolveLspExecutable(workspace, 'vscode-css-language-server', runtimeBin, managedRoot);
  if (resolved?.source !== 'managed' || resolved.launchMode !== 'embedded-node' || resolved.path !== managedCssEntryPoint) {
    throw new Error(`managed CSS resolution failed: ${JSON.stringify(resolved)}`);
  }

  await rm(managedEntryPoint, { force: true });
  resolved = await resolveLspExecutable(workspace, 'typescript-language-server', runtimeBin, managedRoot);
  if (resolved?.source !== 'runtime-path' || resolved.launchMode !== 'direct' || resolved.path !== runtimeExecutable) {
    throw new Error(`runtime PATH fallback failed: ${JSON.stringify(resolved)}`);
  }

  resolved = await resolveLspExecutable(workspace, runtimeExecutable, '', managedRoot);
  if (resolved?.source !== 'configured-path' || resolved.launchMode !== 'direct' || resolved.path !== runtimeExecutable) {
    throw new Error(`explicit path resolution failed: ${JSON.stringify(resolved)}`);
  }

  const customManager = new LspManager();
  const customStatus = await customManager.status(workspace, {
    runtimePath: runtimeBin,
    lspEnabled: true,
    lspCustomServers: JSON.stringify([{ id: 'lua', extensions: ['.lua'], languageId: 'lua', command: command, args: ['--stdio'] }]),
    maxFileBytes: 2 * 1024 * 1024,
  });
  customManager.closeAll();
  const custom = customStatus.servers.find((item) => item.kind === 'custom' && item.id === 'lua');
  if (!custom?.available || custom.command !== command || !custom.extensions.includes('.lua')) {
    throw new Error(`custom LSP resolution failed: ${JSON.stringify(customStatus)}`);
  }

  console.log('core LSP managed resolution smoke passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
