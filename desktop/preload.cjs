const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  checkForAppUpdate: () => ipcRenderer.invoke('desktop:check-app-update'),
  openAppUpdate: (url) => ipcRenderer.invoke('desktop:open-app-update', url),
  openComputerUseSettings: () => ipcRenderer.invoke('desktop:open-computer-use-settings'),
  getComputerUseStatus: () => ipcRenderer.invoke('desktop:get-computer-use-status'),
  startTunnel: () => ipcRenderer.invoke('desktop:start-tunnel'),
  stopTunnel: () => ipcRenderer.invoke('desktop:stop-tunnel'),
  checkWorkspaceHealth: () => ipcRenderer.invoke('desktop:check-workspace-health'),
  checkPublicConfig: () => ipcRenderer.invoke('desktop:check-public-config'),
  testProxy: (settings) => ipcRenderer.invoke('desktop:test-proxy', settings),
  getDebugSnapshot: () => ipcRenderer.invoke('desktop:get-debug-snapshot'),
  clearToolTraces: () => ipcRenderer.invoke('desktop:clear-tool-traces'),
  getLatestManagedClientVersion: (kind) => ipcRenderer.invoke('desktop:get-latest-managed-client-version', kind),
  installManagedClient: (kind, version = '') => ipcRenderer.invoke('desktop:install-managed-client', kind, version),
  getManagedLspStatus: () => ipcRenderer.invoke('desktop:get-managed-lsp-status'),
  installManagedLsp: (languageId) => ipcRenderer.invoke('desktop:install-managed-lsp', languageId),
  openManagedLsp: (languageId) => ipcRenderer.invoke('desktop:open-managed-lsp', languageId),
  rollbackManagedClient: (kind) => ipcRenderer.invoke('desktop:rollback-managed-client', kind),
  clearLogs: () => ipcRenderer.invoke('desktop:clear-logs'),
  copyText: (value) => ipcRenderer.invoke('desktop:copy-text', value),
  saveAllSettings: (settings, runtimeSettings) => ipcRenderer.invoke('desktop:save-all-settings', settings, runtimeSettings),
  listWorkspaces: () => ipcRenderer.invoke('desktop:list-workspaces'),
  addExistingWorkspace: () => ipcRenderer.invoke('desktop:add-existing-workspace'),
  changeWorkspaceDirectory: (name) => ipcRenderer.invoke('desktop:change-workspace-directory', name),
  removeWorkspace: (name) => ipcRenderer.invoke('desktop:remove-workspace', name),
  openWorkspace: (name) => ipcRenderer.invoke('desktop:open-workspace', name),
  setWorkspaceEnabled: (workspace, enabled) => ipcRenderer.invoke('desktop:set-workspace-enabled', workspace, enabled),
  saveWorkspaceSettings: (workspace, serviceInput, runtimeInput) => ipcRenderer.invoke('desktop:save-workspace-settings', workspace, serviceInput, runtimeInput),
  generateWorkspaceToken: (workspace) => ipcRenderer.invoke('desktop:generate-workspace-token', workspace),
  regenerateWorkspaceOauthAuthorizationSecret: (workspace) => ipcRenderer.invoke('desktop:regenerate-workspace-oauth-authorization-secret', workspace),
  revokeWorkspaceOauthAuthorizations: (workspace) => ipcRenderer.invoke('desktop:revoke-workspace-oauth-authorizations', workspace),
  copyWorkspaceEndpoint: (workspace, kind) => ipcRenderer.invoke('desktop:copy-workspace-endpoint', workspace, kind),
  copyWorkspaceAuth: (workspace) => ipcRenderer.invoke('desktop:copy-workspace-auth', workspace),
  getRuntimeAdmin: () => ipcRenderer.invoke('desktop:get-runtime-admin'),
  resetRuntimeSettings: () => ipcRenderer.invoke('desktop:reset-runtime-settings'),
  copyEndpoint: () => ipcRenderer.invoke('desktop:copy-endpoint'),
  generateToken: () => ipcRenderer.invoke('desktop:generate-token'),
  showWindow: () => ipcRenderer.invoke('desktop:show-window'),
  markRendererReady: () => ipcRenderer.send('desktop:renderer-ready'),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop:state', handler);
    return () => ipcRenderer.removeListener('desktop:state', handler);
  },
  onLog: (listener) => {
    const handler = (_event, line) => listener(line);
    ipcRenderer.on('desktop:log', handler);
    return () => ipcRenderer.removeListener('desktop:log', handler);
  },
  onManagedClientProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('desktop:managed-client-progress', handler);
    return () => ipcRenderer.removeListener('desktop:managed-client-progress', handler);
  },
  onManagedLspProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('desktop:managed-lsp-progress', handler);
    return () => ipcRenderer.removeListener('desktop:managed-lsp-progress', handler);
  },
};

contextBridge.exposeInMainWorld('desktop', api);
