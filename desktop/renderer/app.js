const $ = (id) => document.getElementById(id);
let state = null;
let runtimeAdmin = null;
let runtimeAdminLoading = false;
let workspaceListCache = [];
let toastTimer = null;
let formDirty = false;
let savingSettings = false;
let healthChecking = false;
let healthRefreshPending = false;
let workspaceHealthCache = new Map();
let healthTimer = null;
let automaticHealthTimer = null;
let automaticHealthDeferred = false;
let lastHealthCheckedAt = 0;
const INITIAL_HEALTH_WARMUP_MS = 8000;
const HEALTH_SETTLE_MS = 3500;
const HEALTH_REFRESH_INTERVAL_MS = 90_000;
const HEALTH_MIN_AUTO_INTERVAL_MS = 15_000;
let automaticHealthReadyAt = Date.now() + INITIAL_HEALTH_WARMUP_MS;
let editingWorkspaceName = null;
let lastRuntimePhase = null;
let lastTunnelPhase = null;
let lastTunnelReadinessStage = null;
let logRenderTimer = null;
let debugTimer = null;
let debugSnapshot = null;
let currentDebugTab = 'stats';
let debugStatusFilter = 'all';
let debugToolFilter = '';
let selectedDebugTraceId = null;
let savingWorkspaceSettings = false;
let managedClientInstallProgress = null;
let managedClientInstallHideTimer = null;
const latestManagedClientVersions = new Map();
let managedLspProgress = null;
const managedLspProgressByLanguage = Object.create(null);
let customLspDraft = [];
let appUpdateResult = null;
let appUpdateChecking = false;
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const i18n = window.desktopI18n;

function t(key, vars) { return i18n.t(key, vars); }
function localizedText(value) {
  return i18n.text(value);
}

let autoScrollResizeTimer = null;

function updateAutoScroll(element) {
  const track = element?.querySelector(':scope > .auto-scroll-track');
  if (!track) return;
  element.classList.remove('auto-scrolling');
  track.style.removeProperty('--auto-scroll-distance');
  track.style.removeProperty('--auto-scroll-duration');
  const distance = Math.max(0, track.scrollWidth - element.clientWidth);
  if (distance <= 4) return;
  track.style.setProperty('--auto-scroll-distance', `${distance}px`);
  track.style.setProperty('--auto-scroll-duration', `${Math.min(18, Math.max(8, 7 + distance / 28))}s`);
  element.classList.add('auto-scrolling');
}

function setAutoScrollText(element, value, tagName = 'span') {
  if (!element) return;
  const text = String(value ?? '');
  const track = document.createElement(tagName);
  track.className = 'auto-scroll-track';
  track.textContent = text;
  element.classList.add('auto-scroll-text');
  element.title = text;
  element.replaceChildren(track);
  requestAnimationFrame(() => updateAutoScroll(element));
}

function refreshAutoScroll(root = document) {
  for (const element of root.querySelectorAll?.('.auto-scroll-text') || []) updateAutoScroll(element);
}

function localizedMultiline(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => localizedText(line))
    .join('\n');
}
function applyUiLanguage(mode = 'system') { return i18n.setLanguage(mode); }

function renderAppUpdate() {
  const version = $('appUpdateVersion');
  const status = $('appUpdateStatus');
  const check = $('checkAppUpdateButton');
  const checkLabel = $('checkAppUpdateLabel');
  const open = $('openAppUpdateButton');
  if (!version || !status || !check || !checkLabel || !open) return;
  const showStatus = (message = '') => {
    status.textContent = message;
    status.classList.toggle('ui-hidden', !message);
  };
  check.disabled = appUpdateChecking;
  checkLabel.textContent = appUpdateChecking ? t('appUpdate.checking') : t('appUpdate.check');
  open.disabled = !appUpdateResult?.updateAvailable || !appUpdateResult?.releaseUrl || appUpdateChecking;
  if (appUpdateChecking) {
    version.textContent = t('appUpdate.checking');
    showStatus();
    return;
  }
  if (!appUpdateResult) {
    version.textContent = t('appUpdate.notChecked');
    showStatus();
    return;
  }
  if (appUpdateResult.error === 'not_configured') {
    version.textContent = t('appUpdate.notChecked');
    showStatus(t('appUpdate.notConfigured'));
    return;
  }
  if (appUpdateResult.error === 'not_found') {
    version.textContent = `v${appUpdateResult.currentVersion}`;
    showStatus(t('appUpdate.notFound'));
    return;
  }
  if (appUpdateResult.error === 'rate_limited') {
    version.textContent = `v${appUpdateResult.currentVersion}`;
    showStatus(t('appUpdate.rateLimited'));
    return;
  }
  if (appUpdateResult.error) {
    version.textContent = `v${appUpdateResult.currentVersion}`;
    showStatus(t(appUpdateResult.error === 'invalid_response' ? 'appUpdate.invalidResponse' : 'appUpdate.networkError'));
    return;
  }
  version.textContent = appUpdateResult.updateAvailable
    ? t('appUpdate.available', { version: `v${appUpdateResult.latestVersion}` })
    : t('appUpdate.current', { version: `v${appUpdateResult.currentVersion}` });
  showStatus(appUpdateResult.updateAvailable
    ? t('appUpdate.downloadHint', { target: appUpdateResult.downloadUrl ? 'GitHub Release asset' : 'GitHub Release page' })
    : '');
}

async function checkAppUpdate() {
  if (appUpdateChecking) return;
  appUpdateChecking = true;
  renderAppUpdate();
  try {
    appUpdateResult = await window.desktop.checkForAppUpdate();
    renderAppUpdate();
  } catch (error) {
    appUpdateResult = { currentVersion: state?.version || '—', updateAvailable: false, error: error?.message || String(error) };
    renderAppUpdate();
  } finally {
    appUpdateChecking = false;
    renderAppUpdate();
  }
}

function sameVersion(left, right) {
  return String(left || '').replace(/^v/, '') === String(right || '').replace(/^v/, '');
}

function resolvedTheme(appearance = 'system') {
  if (appearance === 'light' || appearance === 'dark') return appearance;
  return systemThemeQuery.matches ? 'dark' : 'light';
}

function currentAllowedCommands() {
  return $('runtimeConfigCommandsInput').value.split(',').map((value) => value.trim()).filter(Boolean);
}

function renderAllowedCommandsHint() {
  const current = [...new Set(currentAllowedCommands())].sort();
  const defaults = [...new Set(runtimeAdmin?.defaultAllowedCommands || [])].sort();
  const isDefault = defaults.length > 0
    && current.length === defaults.length
    && current.every((value, index) => value === defaults[index]);
  $('runtimeCommandsHint').textContent = isDefault
    ? t('runtime.commandsDefault', { count: current.length })
    : `${t('runtime.commandsCustom', { count: current.length })}${current.length === 1 ? t('runtime.commandsExample') : ''}`;
}

function applyAppearanceTheme(appearance = 'system') {
  const theme = resolvedTheme(appearance);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const brandLogo = $('brandLogo');
  if (brandLogo) brandLogo.src = theme === 'light' ? './MCPort-Logo-Light.png' : './MCPort-Logo-Dark.png';
}

applyAppearanceTheme('system');
systemThemeQuery.addEventListener('change', () => {
  if ((state?.settings?.appearance || 'system') === 'system') applyAppearanceTheme('system');
});
$('revokeWorkspaceOauthAuthorizationsButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast(t('workspace.openSettingsFirst'));
  const prompt = t('workspace.oauthRevokeConfirm', { name: workspaceName });
  if (!confirm(prompt)) return;
  const button = $('revokeWorkspaceOauthAuthorizationsButton');
  button.disabled = true;
  try {
    const result = await window.desktop.revokeWorkspaceOauthAuthorizations(workspaceName);
    if (result?.state) render(result.state);
    toast(t('workspace.oauthRevoked'));
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    button.disabled = false;
  }
});

const statusLabels = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  error: '启动失败',
};
function iconMarkup(name) {
  return `<span class="button-icon">${window.RemoteWorkspaceIcons?.render(name) || ''}</span>`;
}

function scheduleLogRender() {
  if (logRenderTimer) return;
  logRenderTimer = setTimeout(() => {
    logRenderTimer = null;
    renderLogs();
  }, 24);
}

let helpTooltip = null;
function hideHelpTooltip() {
  if (!helpTooltip) return;
  helpTooltip.classList.remove('show');
}

function showHelpTooltip(target) {
  const text = target?.dataset?.help;
  if (!text) return;
  if (!helpTooltip) {
    helpTooltip = document.createElement('div');
    helpTooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(helpTooltip);
  }
  const structuredTip = target.classList?.contains('workspace-status-item');
  helpTooltip.className = 'help-tooltip-popover';
  helpTooltip.replaceChildren();
  for (const line of String(text).split('\n').filter(Boolean)) {
    const row = document.createElement('div');
    row.className = 'help-tooltip-line';
    if (structuredTip) {
      const zhColon = line.indexOf('：');
      const enColon = line.indexOf(':');
      const separator = zhColon >= 0 ? zhColon : enColon;
      if (separator > 0) {
        row.classList.add('structured');
        const key = document.createElement('span');
        key.className = 'help-tooltip-key';
        key.textContent = line.slice(0, separator).trim();
        const value = document.createElement('span');
        value.className = 'help-tooltip-value';
        value.textContent = line.slice(separator + 1).trim();
        row.append(key, value);
      } else {
        row.textContent = line;
      }
    } else {
      row.textContent = line;
    }
    helpTooltip.appendChild(row);
  }
  helpTooltip.classList.add('show');
  helpTooltip.style.left = '12px';
  helpTooltip.style.top = '12px';
  const anchor = target.getBoundingClientRect();
  const tip = helpTooltip.getBoundingClientRect();
  const margin = 12;
  const left = Math.min(
    Math.max(margin, anchor.left + anchor.width / 2 - tip.width / 2),
    window.innerWidth - tip.width - margin,
  );
  const above = anchor.top - tip.height - 8;
  const below = anchor.bottom + 8;
  const top = above >= margin
    ? above
    : Math.min(below, window.innerHeight - tip.height - margin);
  helpTooltip.style.left = `${left}px`;
  helpTooltip.style.top = `${Math.max(margin, top)}px`;
}

document.addEventListener('mouseover', (event) => {
  const tip = event.target.closest?.('.help-tip, .workspace-status-item[data-help]');
  if (tip) showHelpTooltip(tip);
});
document.addEventListener('mouseout', (event) => {
  const tip = event.target.closest?.('.help-tip, .workspace-status-item[data-help]');
  if (tip && !tip.contains(event.relatedTarget)) hideHelpTooltip();
});
document.addEventListener('focusin', (event) => {
  const tip = event.target.closest?.('.help-tip, .workspace-status-item[data-help]');
  if (tip) showHelpTooltip(tip);
});
document.addEventListener('focusout', (event) => {
  if (event.target.closest?.('.help-tip, .workspace-status-item[data-help]')) hideHelpTooltip();
});
window.addEventListener('resize', hideHelpTooltip);
window.addEventListener('scroll', hideHelpTooltip, true);

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector(':scope > .button-icon')) return;
    el.insertAdjacentHTML('afterbegin', iconMarkup(el.dataset.icon));
  });
}

function setButtonIcon(button, name) {
  if (!button) return;
  button.dataset.icon = name;
  const current = button.querySelector(':scope > .button-icon');
  if (current) current.outerHTML = iconMarkup(name);
  else button.insertAdjacentHTML('afterbegin', iconMarkup(name));
}

function flashCopied(button) {
  if (!button) return;
  button.classList.add('copied');
  setTimeout(() => button.classList.remove('copied'), 900);
}

function userFacingMessage(message) {
  return String(message ?? '')
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '')
    .replace(/^Error:\s*/i, '');
}

function toast(message) {
  const el = $('toast');
  el.textContent = localizedText(userFacingMessage(message));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function setSaveStatus(message, tone = '') {
  const el = $('saveStatus');
  if (!el) return;
  el.textContent = localizedText(message);
  el.className = `save-status ${tone}`.trim();
}

function setFormDirty() {
  formDirty = true;
  setSaveStatus('有未保存的更改', 'dirty');
}

function makeEmptyState({ title, message, error = false, actionLabel = '', action = null } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = `empty-state${error ? ' error-state' : ''}`;
  const icon = document.createElement('div');
  icon.className = 'empty-state-icon';
  icon.innerHTML = iconMarkup(error ? 'alert' : 'folder-plus');
  const heading = document.createElement('strong');
  heading.textContent = title ? localizedText(title) : t(error ? 'common.loadFailed' : 'common.noContent');
  const copy = document.createElement('p');
  copy.textContent = localizedText(message || '');
  wrapper.append(icon, heading, copy);
  if (actionLabel && action) {
    const button = document.createElement('button');
    button.className = `button ${error ? '' : 'primary'}`.trim();
    button.dataset.icon = error ? 'refresh' : 'folder-plus';
    button.textContent = localizedText(actionLabel);
    button.addEventListener('click', action);
    wrapper.appendChild(button);
    hydrateIcons(wrapper);
  }
  return wrapper;
}

function workspaceHealth(workspaceName) {
  return workspaceHealthCache.get(workspaceName) || null;
}

function probePresentation(probe, fallback = t('health.pending')) {
  if (!probe) return { label: fallback, tone: 'muted' };
  if (probe.status === 'healthy') return {
    label: probe.latencyMs == null ? t('health.available') : t('health.availableLatency', { latency: probe.latencyMs }),
    tone: 'good',
  };
  if (probe.status === 'unhealthy') return { label: t('health.issue'), tone: 'bad' };
  if (probe.status === 'disabled') return { label: t('health.disabled'), tone: 'muted' };
  return { label: t('health.notRunning'), tone: 'bad' };
}

function healthLastCheckedText() {
  if (!lastHealthCheckedAt) return t('health.notChecked');
  const language = i18n.getLanguage?.() || document.documentElement.lang || 'zh-CN';
  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(lastHealthCheckedAt));
  return t('health.lastChecked', { time });
}

function healthErrorCount() {
  let count = 0;
  for (const health of workspaceHealthCache.values()) {
    if (health.local?.status !== 'healthy') count += 1;
    const service = state?.settings?.workspaceServices?.find((item) => item.workspace === health.workspace);
    const publicConfigured = state?.settings?.publicAccessProvider === 'trycloudflare'
      ? Boolean(state?.tunnel?.publicUrl)
      : Boolean(state?.settings?.tunnelBaseDomain);
    if (service?.enabled && service.publicEnabled && publicConfigured && health.public?.status !== 'healthy') count += 1;
  }
  return count;
}

function renderGlobalStatus() {
  if (state) $('navWorkspaceCount').textContent = String(workspaceListCache.length);
}

function logSeverity(line) {
  if (/error|failed|failure|exception|失败|错误|timed?\s*out|timeout|eaddrinuse/i.test(line)) return 'error';
  if (/warn|warning|警告/i.test(line)) return 'warn';
  return '';
}

function logSource(line) {
  if (/\]\s+runtime:/i.test(line)) return 'runtime';
  if (/\]\s+tunnel:/i.test(line)) return 'tunnel';
  return 'desktop';
}

function filteredLogs() {
  const logs = state?.logs || [];
  const filter = $('logFilterInput')?.value || 'all';
  if (filter === 'all') return logs;
  if (filter === 'errors') return logs.filter((line) => logSeverity(line) === 'error');
  return logs.filter((line) => logSource(line) === filter);
}

function renderLogs() {
  const container = $('logs');
  if (!container) return;
  const visible = filteredLogs();
  const autoScroll = $('logAutoScrollInput').checked;
  const previousScrollTop = container.scrollTop;
  container.replaceChildren();
  $('logsCount').textContent = t('logs.count', { visible: visible.length, total: state?.logs?.length || 0 });
  $('copyLogsButton').disabled = !visible.length;
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = t((state?.logs?.length || 0) ? 'logs.emptyFiltered' : 'logs.empty');
    container.appendChild(empty);
    return;
  }
  for (const line of visible) {
    const row = document.createElement('div');
    const severity = logSeverity(line);
    row.className = `log-line ${logSource(line)} ${severity}`.trim();
    row.textContent = localizedText(line);
    container.appendChild(row);
  }
  requestAnimationFrame(() => {
    if (autoScroll) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(previousScrollTop, maxScrollTop);
  });
}

function renderWorkspaceAuthFields() {
  const mode = $('currentWorkspacePublicAuthModeInput').value;
  $('workspaceTokenAuthSection').classList.toggle('ui-hidden', mode !== 'token');
  $('workspaceBuiltinOauthAuthSection').classList.toggle('ui-hidden', mode !== 'oauth');
  const service = currentWorkspaceService();
  const publicEnabled = $('currentWorkspacePublicEnabledInput')?.checked === true;
  const publicUrl = workspacePublicUrl({ ...(service || {}), publicEnabled, publicAuthMode: mode });
  const copyOauthMcpButton = $('copyWorkspaceOauthMcpButton');
  if (copyOauthMcpButton) copyOauthMcpButton.disabled = !publicEnabled || !publicUrl;
  const copyTokenMcpButton = $('copyWorkspaceTokenMcpButton');
  if (copyTokenMcpButton) copyTokenMcpButton.disabled = !publicEnabled || !publicUrl;
  const savedToken = state?.workspaceTokenWorkspaces?.includes(editingWorkspaceName || '') === true;
  const copyTokenButton = $('copyWorkspaceTokenButton');
  if (copyTokenButton) copyTokenButton.disabled = !savedToken;
  updateWorkspaceBuiltinOauthPreview();
  renderWorkspaceSecuritySummary({ ...(service || {}), publicEnabled, publicAuthMode: mode });
  renderWorkspaceConnectionCard();
  renderWorkspaceQuickStatus();
}

function currentPublicHost() {
  const baseDomain = $('tunnelBaseDomainInput')?.value.trim() || state?.settings?.tunnelBaseDomain || '';
  const provider = $('publicAccessProviderInput')?.value || state?.settings?.publicAccessProvider || 'cloudflare';
  if (provider === 'trycloudflare') {
    try { return state?.tunnel?.publicUrl ? new URL(state.tunnel.publicUrl).host : ''; } catch { return ''; }
  }
  const frpSubdomain = $('frpSubdomainInput')?.value.trim() || state?.settings?.frpSubdomain || 'mcp';
  return provider === 'frp' && baseDomain ? `${frpSubdomain}.${baseDomain}` : baseDomain;
}

function updateWorkspacePublicHostPrefix() {
  const prefix = $('currentWorkspacePublicHostPrefix');
  if (!prefix) return;
  const publicHost = currentPublicHost();
  prefix.textContent = publicHost ? `https://${publicHost}/w/` : 'https://Public Host/w/';
  prefix.title = publicHost ? `https://${publicHost}/w/` : '';
}

function updateWorkspaceBuiltinOauthPreview() {
  const publicHost = currentPublicHost();
  const workspaceName = editingWorkspaceName || state?.selectedWorkspace || '';
  const publicPath = $('currentWorkspacePublicPathInput')?.value.trim() || workspaceName;
  $('workspaceBuiltinOauthIssuer').textContent = publicHost && publicPath
    ? `https://${publicHost}/w/${encodeURIComponent(publicPath)}`
    : t('gateway.hostAfterSave');
}

function renderWorkspaceToolTier() {
  const tier = $('currentWorkspaceCommandInput')?.checked
    ? 'full'
    : $('currentWorkspaceEditInput')?.checked ? 'standard' : 'readonly';
  const edit = $('currentWorkspaceEditInput');
  const command = $('currentWorkspaceCommandInput');
  if (edit && command) {
    if (command.checked) edit.checked = true;
  }
  const hints = {
    readonly: t('workspace.tier.readonly'),
    standard: t('workspace.tier.standard'),
    full: t('workspace.tier.full'),
  };
  if ($('workspaceToolTierHint')) $('workspaceToolTierHint').textContent = hints[tier] || hints.full;
  const service = currentWorkspaceService();
  if (service) renderWorkspaceSecuritySummary({ ...service, toolTier: tier }, workspaceProfile(editingWorkspaceName || service.workspace));
  renderWorkspaceConnectionCard();
}

function syncWorkspacePermissionChecks(changedId) {
  const edit = $('currentWorkspaceEditInput');
  const command = $('currentWorkspaceCommandInput');
  if (!edit || !command) return;
  if (changedId === 'currentWorkspaceCommandInput' && command.checked) edit.checked = true;
  if (changedId === 'currentWorkspaceEditInput' && !edit.checked) command.checked = false;
  renderWorkspaceToolTier();
}

function workspaceToolTierLabel(tier) {
  return t(({ readonly: 'workspace.tier.readonlyLabel', standard: 'workspace.tier.standardLabel', full: 'workspace.tier.fullLabel' })[tier] || 'workspace.tier.fullLabel');
}

function workspacePublicAuthLabel(mode) {
  return mode === 'oauth' ? 'OAuth' : 'Bearer Token';
}

function renderWorkspaceConnectionCard() {
  // Endpoint summaries and copy actions live in the Workspace list.
}

function updateWorkspacePublicPreview() {
  const enabled = $('currentWorkspacePublicEnabledInput').checked;
  const publicSettings = $('workspacePublicSettings');
  publicSettings.classList.toggle('ui-hidden', !enabled);
  const workspaceName = editingWorkspaceName || state?.selectedWorkspace || '';
  const routeInput = $('currentWorkspacePublicPathInput');
  if (routeInput && !routeInput.value.trim()) routeInput.value = workspaceName;
  updateWorkspacePublicHostPrefix();

  if (enabled) renderWorkspaceAuthFields();
  else renderWorkspaceConnectionCard();
  renderWorkspaceSecuritySummary({ ...(currentWorkspaceService() || {}), publicEnabled: enabled, publicAuthMode: $('currentWorkspacePublicAuthModeInput')?.value || 'oauth' });
  renderWorkspaceQuickStatus();
}

async function removeWorkspace(workspace) {
  if (!workspace?.name) return;
  const prompt = t('workspace.removeConfirm', { name: workspace.name, path: workspace.path });
  if (!confirm(prompt)) return;
  try {
    const next = await window.desktop.removeWorkspace(workspace.name);
    render(next);
    runtimeAdmin = null;
    await loadRuntimeAdmin();
    workspaceHealthCache.delete(workspace.name);
    await loadWorkspaces();
    requestHealthRefresh(HEALTH_SETTLE_MS);
    toast(t('workspace.removed'));
  } catch (error) {
    toast(error?.message || String(error));
  }
}

function makeWorkspaceStatus(label, value, tone = '', detail = '', action = null, icon = '') {
  const item = document.createElement('div');
  item.className = `workspace-status-item ${tone}`.trim();
  if (detail) {
    item.dataset.help = localizedMultiline(detail);
    item.tabIndex = 0;
  }
  const head = document.createElement('div');
  head.className = 'workspace-status-head';
  const key = document.createElement('span');
  key.textContent = localizedText(label);
  head.appendChild(key);
  if (action) {
    const button = document.createElement('button');
    button.className = 'workspace-status-copy-button';
    button.type = 'button';
    button.dataset.icon = 'copy';
    button.title = localizedText(action.title || `复制${label}`);
    button.setAttribute('aria-label', button.title);
    button.disabled = action.disabled === true;
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (button.disabled) return;
      button.disabled = true;
      try {
        await action.run();
        flashCopied(button);
        if (action.successMessage) toast(action.successMessage);
      } catch (error) {
        toast(error?.message || String(error));
      } finally {
        button.disabled = false;
      }
    });
    head.appendChild(button);
  }
  const content = document.createElement('strong');
  if (icon) content.insertAdjacentHTML('afterbegin', iconMarkup(icon));
  const statusValue = localizedText(value);
  content.title = detail ? '' : statusValue;
  const healthyValue = /^(?:正常|Healthy)(?:\s*·\s*(\d+)ms)?$/.exec(statusValue);
  if (healthyValue) {
    const statusWord = document.createElement('span');
    statusWord.className = 'workspace-status-word';
    statusWord.textContent = localizedText('正常');
    content.appendChild(statusWord);
    if (healthyValue[1]) {
      const separator = document.createElement('span');
      separator.className = 'workspace-status-separator';
      separator.textContent = ' · ';
      const latency = document.createElement('span');
      const latencyMs = Number(healthyValue[1]);
      latency.className = `workspace-status-latency ${latencyMs >= 1000 ? 'warn' : ''}`.trim();
      latency.textContent = `${healthyValue[1]}ms`;
      content.append(separator, latency);
    }
  } else if (statusValue.length > 24) {
    const track = document.createElement('span');
    track.className = 'workspace-status-scroll-track';
    track.textContent = statusValue;
    content.appendChild(track);
    requestAnimationFrame(() => {
      const distance = Math.max(0, track.scrollWidth - content.clientWidth);
      if (distance <= 4) return;
      item.classList.add('scrolling');
      track.style.setProperty('--workspace-status-scroll-distance', `${distance}px`);
    });
  } else {
    const statusText = document.createElement('span');
    statusText.textContent = statusValue;
    content.appendChild(statusText);
  }
  if (action?.retry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'workspace-status-inline-action';
    retry.textContent = t('common.checkAgain');
    retry.title = t('common.checkAgain');
    retry.addEventListener('click', async (event) => {
      event.stopPropagation();
      retry.disabled = true;
      try { await action.retry(); } catch (error) { toast(error?.message || String(error)); } finally { retry.disabled = false; }
    });
    content.appendChild(retry);
  }
  item.append(head, content);
  return item;
}

function makeWorkspaceCapability(label, value, tone = '', detail = '', icon = '') {
  const item = document.createElement('div');
  item.className = `workspace-status-item workspace-capability-item ${tone}`.trim();
  if (detail) {
    item.dataset.help = localizedMultiline(detail);
    item.tabIndex = 0;
  }
  const title = document.createElement('span');
  title.className = 'workspace-capability-title';
  const titleText = document.createElement('span');
  titleText.textContent = label;
  title.appendChild(titleText);
  const content = document.createElement('strong');
  if (Array.isArray(icon)) {
    content.classList.add('workspace-capability-icon-group');
    for (const entry of icon) {
      const iconName = typeof entry === 'string' ? entry : entry?.name;
      if (!iconName) continue;
      const iconBox = document.createElement('span');
      iconBox.className = `workspace-capability-icon ${typeof entry === 'object' && entry.tone ? entry.tone : tone}`.trim();
      iconBox.innerHTML = iconMarkup(iconName);
      iconBox.title = typeof entry === 'object' && entry.label ? entry.label : value;
      content.appendChild(iconBox);
    }
  } else {
    if (icon) content.insertAdjacentHTML('afterbegin', iconMarkup(icon));
    const valueText = document.createElement('span');
    valueText.textContent = value;
    content.appendChild(valueText);
  }
  content.title = value;
  item.append(title, content);
  return item;
}

function workspaceProfile(workspaceName) {
  if (!runtimeAdmin || !workspaceName) return null;
  const assignment = runtimeAdmin.workspaces.find((item) => item.name === workspaceName)?.profile;
  return assignment ? runtimeAdmin.profiles.find((profile) => profile.id === assignment.id) || assignment : null;
}

function profileHasOverrides(profile) {
  if (!profile) return false;
  return profile.runtimePath != null
    || profile.allowedCommands != null
    || profile.allowExternalNetwork != null
    || profile.requireHighRiskConfirmation != null
    || profile.highRiskConfirmationMode != null
    || profile.defaultCommandTimeoutMs != null
    || profile.maxCommandTimeoutMs != null
    || profile.maxCommandOutputBytes != null;
}

function workspaceRuntimeLabel(profile) {
  return profileHasOverrides(profile) ? (profile.name || t('common.custom')) : t('workspaceSettings.runtime.inherit');
}

function suggestedWorkspacePort(workspaceName) {
  const current = state?.settings.workspaceServices.find((item) => item.workspace === workspaceName);
  if (current) return current.port;
  const used = new Set((state?.settings.workspaceServices || []).filter((item) => item.enabled).map((item) => item.port));
  let port = 8788;
  while (used.has(port)) port += 1;
  return port;
}

function currentWorkspaceService(workspaceName = editingWorkspaceName || state?.selectedWorkspace || '') {
  if (!state || !workspaceName) return null;
  return state.settings.workspaceServices.find((item) => item.workspace === workspaceName) || null;
}

function workspacePublicUrl(service) {
  if (!service?.enabled || !service.publicEnabled) return '';
  if (state?.settings.publicAccessProvider === 'trycloudflare') {
    const base = String(state?.tunnel?.publicUrl || '').replace(/\/+$/, '');
    return base ? `${base}/w/${encodeURIComponent(service.publicPath || service.workspace)}/mcp` : '';
  }
  if (!state?.settings.tunnelBaseDomain) return '';
  const host = state.settings.publicAccessProvider === 'frp'
    ? `${state.settings.frpSubdomain || 'mcp'}.${state.settings.tunnelBaseDomain}`
    : state.settings.tunnelBaseDomain;
  return `https://${host}/w/${encodeURIComponent(service.publicPath || service.workspace)}/mcp`;
}

function workspaceLocalUrl(service) {
  return service?.enabled && service?.port ? `http://127.0.0.1:${service.port}/mcp` : '';
}

function workspaceSecurityPresentation(service, profile) {
  if (!service?.enabled) return { label: t('security.disabled'), detail: t('security.disabledDetail'), tone: 'muted', labelKey: 'security.disabled' };
  const toolTier = ['readonly', 'standard', 'full'].includes(service?.toolTier) ? service.toolTier : 'full';
  const commandExecution = toolTier === 'full';
  const externalNetwork = profile?.allowExternalNetwork == null
    ? Boolean(runtimeAdmin?.runtime?.allowExternalNetwork)
    : profile.allowExternalNetwork === true;
  const rawConfirmationMode = profile?.highRiskConfirmationMode
    || (profile?.requireHighRiskConfirmation === false ? 'none' : null)
    || runtimeAdmin?.runtime?.highRiskConfirmationMode
    || (runtimeAdmin?.runtime?.requireHighRiskConfirmation === false ? 'none' : 'local');
  const confirmationMode = rawConfirmationMode === 'none_with_computer_use'
    ? 'none_with_computer_use'
    : rawConfirmationMode === 'none' ? 'none' : 'local';
  const confirmationDisabled = confirmationMode !== 'local';
  const allowedCommands = profile?.allowedCommands || runtimeAdmin?.runtime?.allowedCommands || runtimeAdmin?.defaultAllowedCommands || [];
  const localValue = t(commandExecution ? 'common.allow' : 'security.off');
  const networkValue = t(externalNetwork ? 'common.allow' : 'security.offIsolated');
  const confirmationValue = t(confirmationMode === 'local'
    ? 'security.localConfirmation'
    : confirmationMode === 'none_with_computer_use'
      ? 'security.noConfirmationWithComputerUse'
      : 'security.off');
  const commandValue = Array.isArray(allowedCommands) ? t('security.commandCount', { count: allowedCommands.length }) : t('workspaceSettings.runtime.inherit');
  const detailLines = [
    t('security.toolRange', { value: workspaceToolTierLabel(toolTier) }),
    toolTier === 'full'
      ? t('security.localCommands', { value: localValue })
      : t('security.commandToolsUnavailable'),
    t('security.externalNetwork', { value: networkValue }),
    t('security.highRiskConfirmation', { value: confirmationValue }),
    t('security.commandAllowlist', { value: commandValue }),
  ];
  const detail = detailLines.join(t('security.separator'));
  const computerUseEnabled = state?.settings?.computerUseEnabled === true;
  const computerUseReady = toolTier === 'full' && computerUseEnabled && state?.computerUse?.available === true;
  const computerUseDetail = !computerUseEnabled
    ? t('computerUse.disabled')
    : toolTier !== 'full'
      ? t('computerUse.developerToolsRequired')
      : computerUseReady
        ? t('computerUse.ready')
        : t('computerUse.permissionsRequired');
  const toolIcons = [
    { name: 'notebook-text', tone: 'good', label: t('security.capability.toolReadonly') },
    { name: 'notebook-pen', tone: toolTier === 'readonly' ? 'muted' : 'good', label: t('security.capability.toolStandard') },
    { name: 'terminal', tone: toolTier === 'full' ? 'good' : 'muted', label: t('security.capability.toolFull') },
  ];
  const capabilities = [
    { label: t('workspace.permissions.cardTitle'), value: '', tone: 'good', icon: [
      ...toolIcons,
      { name: externalNetwork ? 'globe-check' : 'globe-x', tone: externalNetwork ? 'good' : 'warn', label: t('security.externalNetwork', { value: networkValue }) },
      { name: computerUseReady ? 'square-mouse-pointer' : 'mouse-pointer-2-off', tone: computerUseReady ? 'good' : 'warn', label: computerUseDetail },
    ], detail: [...detailLines, `${t('security.capability.computerUse')}：${computerUseDetail}`].join('\n') },
    { label: t('security.capability.highRiskConfirmation'), value: confirmationMode === 'local' ? t('security.capability.localApproval') : confirmationMode === 'none_with_computer_use' ? t('security.capability.noApprovalWithComputerUse') : t('security.capability.noApproval'), tone: confirmationMode === 'local' ? 'good' : 'bad', icon: confirmationMode === 'local' ? 'message-circle-question-mark' : confirmationMode === 'none_with_computer_use' ? 'message-circle-dashed' : 'message-circle-off', detail: t('security.highRiskConfirmation', { value: confirmationValue }) },
  ];
  if (toolTier === 'readonly') {
    return { label: t('security.viewOnly'), detail, tone: 'good', labelKey: 'security.viewOnly', capabilities };
  }
  if (toolTier === 'standard') {
    const label = confirmationDisabled
      ? t('security.withoutConfirmation', { capability: t('security.edit') })
      : t('security.edit');
    return { label, detail, tone: confirmationDisabled ? 'bad' : 'good', capabilities };
  }
  if (!commandExecution) {
    const label = confirmationDisabled
      ? t('security.withoutConfirmation', { capability: t('security.editCommandsOff') })
      : t('security.editCommandsOff');
    return { label, detail, tone: confirmationDisabled ? 'bad' : 'good', labelKey: confirmationDisabled ? null : 'security.editCommandsOff', capabilities };
  }
  const separator = t('security.separator');
  if (confirmationDisabled) return { label: t('security.withoutConfirmation', { capability: t(externalNetwork ? 'security.executeOnline' : 'security.executeIsolated') }), detail: `${detail}${separator}${t('security.noConfirmationDetail')}`, tone: 'bad', capabilities };
  if (externalNetwork) return { label: t('security.executeOnline'), detail: `${detail}${separator}${t('security.externalAllowedDetail')}`, tone: 'warn', labelKey: 'security.executeOnline', capabilities };
  return { label: t('security.executeIsolated'), detail: `${detail}${separator}${t('security.externalBlockedDetail')}`, tone: 'good', labelKey: 'security.executeIsolated', capabilities };
}

function renderWorkspaceSecuritySummary(service = currentWorkspaceService(), profile = workspaceProfile(editingWorkspaceName || state?.selectedWorkspace || '')) {
  const label = $('workspaceSecurityLabel');
  const detail = $('workspaceSecurityDetail');
  const box = $('workspaceSecuritySummary');
  if (!label || !detail || !box) return;
  const security = workspaceSecurityPresentation(service, profile);
  label.textContent = security.label;
  detail.textContent = security.detail;
  box.className = `workspace-security-summary ${security.tone || ''}`.trim();
}

function workspaceRecoveryAdvice(workspace, service, health) {
  if (!service?.enabled) return null;
  if (state?.runtime?.phase !== 'running') {
    return { tone: 'bad', titleKey: 'recovery.runtimeNotReady', detail: state?.runtime?.error || t('recovery.runtimeNotReadyDetail'), actionKey: 'common.checkAgain', run: () => refreshHealthChecks() };
  }
  if (health?.local && !health.local.ok && health.local.status !== 'disabled') {
    return { tone: 'bad', titleKey: 'recovery.localIssue', detail: health.local.message || t('recovery.localIssueDetail'), actionKey: 'common.checkAgain', run: () => refreshHealthChecks() };
  }
  if (!service.publicEnabled) return null;
  if (state?.settings?.publicAccessProvider === 'trycloudflare' && !state?.tunnel?.publicUrl) {
    return { tone: 'warn', titleKey: 'recovery.waitingPublicAddress', detailKey: 'recovery.waitingPublicAddressDetail', action: '打开公网设置', actionKey: 'recovery.openPublicSettings', run: () => { setPage('settings'); setSettingsTab('connection'); } };
  }
  if (state?.settings?.publicAccessProvider !== 'trycloudflare' && !state?.settings?.tunnelBaseDomain) {
    return { tone: 'warn', titleKey: 'recovery.missingPublicHost', detailKey: 'recovery.missingPublicHostDetail', action: '打开公网设置', actionKey: 'recovery.openPublicSettings', run: () => { setPage('settings'); setSettingsTab('connection'); } };
  }
  if (state.settings.publicAccessProvider !== 'external' && state?.tunnel?.phase !== 'running') {
    return { tone: 'warn', title: '公网客户端未运行', titleKey: 'recovery.publicClientNotRunning', detail: state?.tunnel?.error || 'Cloudflare / TryCloudflare / FRP 客户端未运行，公网地址暂不可达。', detailKey: state?.tunnel?.error ? null : 'recovery.publicClientNotRunningDetail', action: '打开公网设置', actionKey: 'recovery.openPublicSettings', run: () => { setPage('settings'); setSettingsTab('connection'); } };
  }
  if (health?.public && !health.public.ok && health.public.status !== 'disabled') {
    const authIssue = /oauth|authorization|issuer|token|401|403|认证/i.test(String(health.public.message || ''));
    return { tone: 'bad', titleKey: authIssue ? 'recovery.publicAuthIssue' : 'recovery.publicIssue', detail: health.public.message || t('recovery.publicProbeFailed'), actionKey: 'common.checkAgain', run: () => refreshHealthChecks() };
  }
  return null;
}

function makeWorkspaceRecoveryCard(advice) {
  const box = document.createElement('div');
  box.className = `workspace-recovery-card ${advice.tone || ''}`.trim();
  const text = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = advice.titleKey ? t(advice.titleKey) : localizedText(advice.title);
  const detail = document.createElement('span');
  detail.textContent = advice.detailKey ? t(advice.detailKey) : localizedText(advice.detail);
  text.append(title, detail);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button subtle';
  button.textContent = advice.actionKey ? t(advice.actionKey) : localizedText(advice.action);
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    button.disabled = true;
    try { await advice.run(); } catch (error) { toast(error?.message || String(error)); } finally { button.disabled = false; }
  });
  box.append(text, button);
  return box;
}

function setWorkspaceExpandControl(workspaceName, expanded) {
  const card = Array.from(document.querySelectorAll('.workspace-item')).find((item) => item.dataset.workspaceName === workspaceName);
  if (!card) return;
  const button = card.querySelector('.workspace-expand-control');
  if (!button) return;
  button.classList.toggle('active', expanded);
  button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  button.textContent = localizedText(expanded ? '收起设置' : '展开设置');
  hydrateIcons(button);
}

function closeWorkspaceSettingsModal() {
  const panel = $('workspaceSettingsModal');
  document.querySelectorAll('.workspace-item.settings-expanded').forEach((card) => card.classList.remove('settings-expanded'));
  panel.classList.remove('show');
  panel.classList.add('ui-hidden');
  panel.setAttribute('aria-hidden', 'true');
  document.body.appendChild(panel);
  $('currentWorkspaceStatus').textContent = '';
  editingWorkspaceName = null;
}

async function openWorkspaceSettingsModal(workspace) {
  if (!workspace?.name) return;
  const panel = $('workspaceSettingsModal');
  const currentCard = Array.from(document.querySelectorAll('.workspace-item')).find((card) => card.dataset.workspaceName === workspace.name);
  if (editingWorkspaceName === workspace.name && panel.classList.contains('show') && panel.parentElement === currentCard) {
    closeWorkspaceSettingsModal();
    return;
  }
  document.querySelectorAll('.workspace-item.settings-expanded').forEach((card) => card.classList.remove('settings-expanded'));
  editingWorkspaceName = workspace.name;
  if (!runtimeAdmin) await loadRuntimeAdmin();
  $('currentWorkspaceStatus').textContent = '';
  const profile = workspaceProfile(workspace.name);
  $('currentWorkspaceProfileNameInput').value = profile?.name || `${workspace.name} Runtime`;
  $('currentWorkspaceRuntimePathInput').value = profile?.runtimePath || '';
  $('currentWorkspaceCommandsInput').value = profile?.allowedCommands?.join(',') || '';
  $('currentWorkspaceExternalNetworkInput').checked = profile?.allowExternalNetwork == null
    ? Boolean(runtimeAdmin?.runtime?.allowExternalNetwork)
    : profile.allowExternalNetwork === true;
  const storedConfirmationMode = profile?.highRiskConfirmationMode
    || (profile?.requireHighRiskConfirmation === false ? 'none' : null)
    || runtimeAdmin?.runtime?.highRiskConfirmationMode
    || (runtimeAdmin?.runtime?.requireHighRiskConfirmation === false ? 'none' : 'local');
  $('currentWorkspaceHighRiskConfirmationModeInput').value = ['local', 'none', 'none_with_computer_use'].includes(storedConfirmationMode)
    ? storedConfirmationMode
    : 'local';
  $('currentWorkspaceDefaultTimeoutInput').value = profile?.defaultCommandTimeoutMs == null ? '' : String(profile.defaultCommandTimeoutMs);
  $('currentWorkspaceMaxTimeoutInput').value = profile?.maxCommandTimeoutMs == null ? '' : String(profile.maxCommandTimeoutMs);
  $('currentWorkspaceMaxOutputInput').value = profile?.maxCommandOutputBytes == null ? '' : String(profile.maxCommandOutputBytes);
  const service = state?.settings.workspaceServices.find((item) => item.workspace === workspace.name) || null;
  $('currentWorkspacePublicEnabledInput').checked = Boolean(service?.publicEnabled);
  const publicPath = service?.publicPath || workspace.name;
  $('currentWorkspacePublicPathInput').value = publicPath;
  const savedToken = state?.workspaceTokenWorkspaces?.includes(workspace.name) === true;
  $('currentWorkspacePublicAuthModeInput').value = service?.publicAuthMode === 'oauth'
    ? 'oauth'
    : service?.publicEnabled || savedToken
      ? 'token'
      : 'oauth';
  $('currentWorkspaceTokenInput').value = '';
  $('workspaceTokenSavedHint').textContent = localizedText(savedToken ? '已安全保存' : '尚未设置');
  const tokenCopyButton = $('copyWorkspaceTokenButton');
  if (tokenCopyButton) tokenCopyButton.disabled = !savedToken;
  const tokenResetButton = $('generateWorkspaceTokenButton');
  if (tokenResetButton) tokenResetButton.textContent = localizedText(savedToken ? '重新生成 Bearer Token' : '生成 Bearer Token');
  $('currentWorkspaceEditInput').checked = service?.toolTier === 'standard' || service?.toolTier === 'full';
  $('currentWorkspaceCommandInput').checked = service?.toolTier === 'full';
  renderWorkspaceToolTier();
  updateWorkspacePublicPreview();
  renderWorkspaceSecuritySummary(service, profile);
  if (currentCard) {
    currentCard.classList.add('settings-expanded');
    setWorkspaceExpandControl(currentCard, true);
    currentCard.appendChild(panel);
  }
  panel.classList.remove('ui-hidden');
  panel.classList.add('show');
  panel.setAttribute('aria-hidden', 'false');
  renderWorkspaceQuickStatus();
}

function setPage(page) {
  if (page === 'debug' && state?.settings?.debugMode === 'off') page = 'workspaces';
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
  if (page === 'workspaces') void loadWorkspaces();
  if (page === 'settings') void loadRuntimeAdmin();
  if (page === 'logs') renderLogs();
  if (debugTimer) {
    clearInterval(debugTimer);
    debugTimer = null;
  }
  if (page === 'debug') {
    void refreshDebugSnapshot();
    debugTimer = setInterval(() => void refreshDebugSnapshot(), 2000);
  }
}

function setSettingsTab(tab) {
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === tab);
  });
}

function setDebugTab(tab) {
  currentDebugTab = tab === 'traces' ? 'traces' : 'stats';
  document.querySelectorAll('[data-debug-tab]').forEach((button) => {
    const active = button.dataset.debugTab === currentDebugTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-debug-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.debugPanel === currentDebugTab);
  });
}

function updateDebugNavigation() {
  const debugNav = document.querySelector('.nav-item[data-page="debug"]');
  if (!debugNav) return;
  const enabled = state?.settings?.debugMode !== 'off';
  debugNav.classList.toggle('ui-hidden', !enabled);
  debugNav.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  if (!enabled && document.querySelector('#page-debug.active')) setPage('workspaces');
}

function updatePublicProviderFields() {
  const provider = $('publicAccessProviderInput').value;
  const clientMode = $('publicClientModeInput').value;
  $('cloudflareProviderFields').classList.toggle('ui-hidden', provider !== 'cloudflare');
  $('tryCloudflareProviderFields').classList.toggle('ui-hidden', provider !== 'trycloudflare');
  $('cloudflareTransportFields').classList.toggle('ui-hidden', provider !== 'cloudflare' && provider !== 'trycloudflare');
  $('frpProviderFields').classList.toggle('ui-hidden', provider !== 'frp');
  $('publicHostField').classList.toggle('ui-hidden', provider === 'trycloudflare');
  $('publicClientModeField').classList.toggle('ui-hidden', provider === 'external');
  $('publicClientVersionField').classList.toggle('ui-hidden', provider === 'external' || clientMode !== 'managed');
  $('publicClientPathField').classList.toggle('ui-hidden', provider === 'external' || clientMode !== 'custom');
  $('autoStartPublicClientRow').classList.toggle('ui-hidden', provider === 'external');
  $('publicClientActionField').classList.toggle('ui-hidden', provider === 'external');
  $('installPublicClientButton').classList.toggle('ui-hidden', provider === 'external' || clientMode === 'custom');
  const kind = provider === 'frp' ? 'frpc' : 'cloudflared';
  const managed = state?.managedBinaries?.[kind];
  $('publicClientKindLabel').textContent = kind;
  const latestVersion = latestManagedClientVersions.get(kind) || '';
  const currentVersion = managed?.installed ? String(managed.version || '') : '';
  const latestMatchesCurrent = Boolean(latestVersion && currentVersion && sameVersion(latestVersion, currentVersion));
  setAutoScrollText($('publicClientCurrentVersion'), currentVersion || t('publicClient.notInstalled'));
  setAutoScrollText($('publicClientLatestVersion'), latestVersion
    ? latestMatchesCurrent
      ? t('publicClient.upToDate', { version: latestVersion })
      : currentVersion
        ? t('publicClient.updateAvailable', { version: latestVersion })
        : latestVersion
    : t('publicClient.notQueried'));
  const versionMode = $('publicClientVersionModeInput').value || 'latest';
  const specificVersion = $('publicClientVersionInput').value.trim();
  $('publicClientSpecificVersionField').classList.toggle('ui-hidden', versionMode !== 'specific');
  const managedMissing = provider !== 'external' && clientMode === 'managed' && !managed?.installed;
  const desiredVersion = versionMode === 'specific' ? specificVersion.replace(/^v/, '') : '';
  const managedVersionMismatch = provider !== 'external'
    && clientMode === 'managed'
    && Boolean(managed?.installed && desiredVersion && String(managed.version || '').replace(/^v/, '') !== desiredVersion);
  const installNotice = $('publicClientInstallNotice');
  installNotice.classList.toggle('ui-hidden', !managedMissing && !managedVersionMismatch);
  installNotice.textContent = localizedText(managedMissing
    ? `尚未安装 ${kind}。请在版本管理中选择“最新版本”或“指定版本”后安装；公网 Host、${provider === 'cloudflare' ? 'Tunnel Token' : 'FRP Server / Token'} 等配置可以先填写并保存。`
    : managedVersionMismatch
      ? `${kind} 当前已安装 ${managed.version}，与固定版本 ${$('publicClientVersionInput').value.trim()} 不一致。请先安装对应版本再启动；其他公网配置仍可先填写并保存。`
      : '');
  const installButton = $('installPublicClientButton');
  const updateAvailable = Boolean(latestVersion && currentVersion && !latestMatchesCurrent && !desiredVersion);
  const installedVersions = Array.isArray(managed?.installedVersions) ? managed.installedVersions : [];
  const targetAlreadyInstalled = Boolean(desiredVersion && installedVersions.some((version) => sameVersion(version, desiredVersion)));
  const specificMatchesCurrent = Boolean(desiredVersion && currentVersion && sameVersion(desiredVersion, currentVersion));
  const installRequired = managedMissing || managedVersionMismatch || updateAvailable;
  installButton.classList.toggle('primary', installRequired);
  installButton.classList.toggle('subtle', !installRequired);
  if (versionMode === 'specific') {
    installButton.textContent = !specificVersion
      ? t('publicClient.enterVersion')
      : specificMatchesCurrent
        ? t('publicClient.currentVersion', { version: specificVersion })
        : targetAlreadyInstalled
          ? `切换到 ${specificVersion}`
          : `安装 ${specificVersion}`;
    installButton.disabled = !specificVersion || specificMatchesCurrent;
  } else {
    installButton.textContent = localizedText(managedMissing
      ? latestVersion ? `安装 ${latestVersion}` : t('publicClient.installLatest')
      : updateAvailable
        ? `更新到 ${latestVersion}`
        : latestMatchesCurrent
          ? t('publicClient.currentLatest')
          : t('publicClient.installOrUpdateLatest'));
    installButton.disabled = latestMatchesCurrent;
  }
  setButtonIcon(installButton,
    (versionMode === 'specific' && specificMatchesCurrent) || (versionMode === 'latest' && latestMatchesCurrent)
      ? 'check'
      : targetAlreadyInstalled && versionMode === 'specific'
        ? 'refresh'
        : 'download');
  $('rollbackPublicClientButton').classList.toggle('ui-hidden', provider === 'external' || clientMode === 'custom' || !managed?.previousVersion);
  $('rollbackPublicClientButton').textContent = managed?.previousVersion ? `回滚到 ${managed.previousVersion}` : t('publicClient.rollbackPrevious');
  setButtonIcon($('rollbackPublicClientButton'), 'refresh');
  const publicClientStatus = $('publicClientStatus');
  publicClientStatus.textContent = provider === 'external'
    ? t('publicClient.managedByUser')
    : clientMode === 'custom'
      ? t('publicClient.customPath')
      : managed?.installed
        ? managed.installedVersions?.length > 1 ? t('publicClient.versionCount', { count: managed.installedVersions.length }) : t('publicClient.verified')
        : t('publicClient.notInstalled');
  publicClientStatus.className = `public-client-inline-status ${managed?.installed ? 'good' : ''}`.trim();
  const tunnelPhase = state?.tunnel?.phase || 'stopped';
  const tunnelActionButton = $('tunnelActionButton');
  const tunnelRunning = tunnelPhase === 'running';
  tunnelActionButton.textContent = localizedText(tunnelRunning ? '停止公网客户端' : tunnelPhase === 'starting' ? '启动中…' : tunnelPhase === 'stopping' ? '停止中…' : '启动公网客户端');
  tunnelActionButton.classList.toggle('danger', tunnelRunning);
  setButtonIcon(tunnelActionButton, tunnelRunning ? 'stop' : 'cloud');
  tunnelActionButton.disabled = tunnelPhase === 'starting'
    || tunnelPhase === 'stopping'
    || (!tunnelRunning && (managedMissing || managedVersionMismatch));

  const progressKind = provider === 'frp' ? 'frpc' : 'cloudflared';
  const progress = managedClientInstallProgress?.kind === progressKind ? managedClientInstallProgress : null;
  const progressBox = $('publicClientInstallProgress');
  const progressActive = progress && progress.phase !== 'complete' && progress.phase !== 'failed';
  if (progress) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    progressBox.classList.remove('ui-hidden');
    progressBox.classList.toggle('failed', progress.phase === 'failed');
    $('publicClientInstallProgressMessage').textContent = localizedText(progress.message || '正在安装…');
    $('publicClientInstallProgressPercent').textContent = localizedText(progress.phase === 'failed' ? '失败' : `${Math.round(percent)}%`);
    $('publicClientInstallProgressBar').style.width = `${percent}%`;
    publicClientStatus.textContent = localizedText(progress.message || '正在安装…');
    publicClientStatus.className = `public-client-inline-status ${progress.phase === 'failed' ? '' : progress.phase === 'complete' ? 'good' : 'working'}`.trim();
    if (progressActive) {
      installButton.disabled = true;
      installButton.textContent = t('publicClient.installingPercent', { percent: Math.round(percent) });
      setButtonIcon(installButton, 'loader');
      $('rollbackPublicClientButton').disabled = true;
    } else {
      $('rollbackPublicClientButton').disabled = false;
    }
  } else {
    progressBox.classList.add('ui-hidden');
    progressBox.classList.remove('failed');
    $('rollbackPublicClientButton').disabled = false;
  }
}

function renderDebugSnapshot(snapshot) {
  debugSnapshot = snapshot;
  const isEnglish = i18n.getLanguage() === 'en-US';
  const modeLabels = { off: t('debug.mode.off'), basic: t('debug.mode.basic'), detailed: t('debug.mode.detailed') };
  $('debugModeSummary').textContent = modeLabels[snapshot?.debugMode] || snapshot?.debugMode || modeLabels.off;
  const traces = Array.isArray(snapshot?.traces) ? snapshot.traces : [];
  const visibleTraces = filteredDebugTraces(traces);
  const totalDuration = traces.reduce((sum, trace) => sum + Number(trace.durationMs || 0), 0);
  const slowest = traces.reduce((max, trace) => Math.max(max, Number(trace.durationMs || 0)), 0);
  $('debugTraceSummary').textContent = t('debug.traceSummary', {
    count: traces.length,
    total: Math.round(totalDuration),
    slow: slowest > 0 ? t('debug.traceSlowest', { value: Math.round(slowest) }) : '',
  });
  const toolStats = $('debugToolStats');
  toolStats.replaceChildren();
  const retainedByTool = new Map();
  let retainedErrors = 0;
  for (const trace of traces) {
    const name = trace.tool || 'unknown';
    const current = retainedByTool.get(name) || { total: 0, errors: 0, durations: [] };
    current.total += 1;
    const durationMs = Number(trace.durationMs);
    if (Number.isFinite(durationMs)) current.durations.push(durationMs);
    if (trace.status !== 'ok') {
      current.errors += 1;
      retainedErrors += 1;
    }
    retainedByTool.set(name, current);
  }
  const persistedStats = snapshot?.toolStats && typeof snapshot.toolStats === 'object' && snapshot.toolStats.tools && typeof snapshot.toolStats.tools === 'object'
    ? snapshot.toolStats.tools
    : {};
  const normalizeToolStat = (stat) => ({
    total: Number(stat?.total || 0),
    errors: Number(stat?.failures || 0),
    durationTotalMs: Number(stat?.durationTotalMs || 0),
    fastestMs: Number.isFinite(Number(stat?.fastestMs)) ? Number(stat.fastestMs) : null,
    slowestMs: Number.isFinite(Number(stat?.slowestMs)) ? Number(stat.slowestMs) : null,
    durations: Array.isArray(stat?.recentDurationsMs) ? stat.recentDurationsMs.map(Number).filter(Number.isFinite) : [],
    failureCodes: stat?.failureCodes && typeof stat.failureCodes === 'object' ? stat.failureCodes : {},
    recentFailures: Array.isArray(stat?.recentFailures) ? stat.recentFailures : [],
  });
  const byTool = new Map(Object.entries(persistedStats).map(([name, stat]) => [name, normalizeToolStat(stat)]));
  const persistedVariants = snapshot?.toolStats && typeof snapshot.toolStats === 'object' && snapshot.toolStats.variants && typeof snapshot.toolStats.variants === 'object'
    ? snapshot.toolStats.variants
    : {};
  const variantsByTool = new Map();
  for (const [key, rawStat] of Object.entries(persistedVariants)) {
    const separator = key.indexOf('::');
    if (separator <= 0) continue;
    const toolName = key.slice(0, separator);
    const operation = key.slice(separator + 2);
    if (!operation) continue;
    const list = variantsByTool.get(toolName) || [];
    list.push({ operation, stat: normalizeToolStat(rawStat) });
    variantsByTool.set(toolName, list);
  }
  for (const list of variantsByTool.values()) list.sort((a, b) => a.operation.localeCompare(b.operation));
  if (!byTool.size) {
    for (const [name, stat] of retainedByTool) byTool.set(name, { ...stat, durationTotalMs: stat.durations.reduce((sum, value) => sum + value, 0), fastestMs: stat.durations.length ? Math.min(...stat.durations) : null, slowestMs: stat.durations.length ? Math.max(...stat.durations) : null });
  }
  const errors = [...byTool.values()].reduce((sum, stat) => sum + stat.errors, 0) || retainedErrors;
  const rawCatalog = Array.isArray(snapshot?.toolCatalog) ? snapshot.toolCatalog : [];
  const catalogByName = new Map(rawCatalog
    .filter((entry) => entry && typeof entry.name === 'string')
    .map((entry) => [entry.name, entry]));
  for (const name of byTool.keys()) {
    if (!catalogByName.has(name)) catalogByName.set(name, { name, description: '', tiers: [] });
  }
  const catalog = [...catalogByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!catalog.length) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = t('debug.catalogUnavailable');
    toolStats.append(empty);
  } else {
    const header = document.createElement('div');
    header.className = 'debug-tool-stat-row debug-tool-stat-header';
    const statLabels = ['debug.stat.tool', 'debug.stat.function', 'debug.stat.exposure', 'debug.stat.lastFive', 'debug.stat.average', 'debug.stat.total', 'debug.stat.fastest', 'debug.stat.slowest', 'debug.stat.errors'].map((key) => t(key));
    for (const label of statLabels) {
      const cell = document.createElement('span');
      cell.textContent = label;
      header.append(cell);
    }
    toolStats.append(header);
    for (const entry of catalog) {
      const stat = byTool.get(entry.name) || { total: 0, errors: 0, durationTotalMs: 0, fastestMs: null, slowestMs: null, durations: [] };
      const durations = stat.durations;
      const avg = stat.total ? Math.round(stat.durationTotalMs / stat.total) : null;
      const fastest = stat.fastestMs;
      const slowestTool = stat.slowestMs;
      const recentFive = durations.slice(-5).reverse().map((value) => `${Math.round(value)}ms`).join(' · ');
      const row = document.createElement('div');
      row.className = `debug-tool-stat-row${stat.errors ? ' error' : ''}`;
      const nameCell = document.createElement('div');
      nameCell.className = 'debug-tool-name-cell';
      const name = document.createElement('strong');
      name.textContent = entry.name;
      nameCell.append(name);
      if (Array.isArray(entry.tiers) && entry.tiers.length) {
        const tiers = document.createElement('small');
        tiers.className = 'debug-tool-tiers';
        tiers.textContent = `TIER ${entry.tiers.join(' · ')}`;
        nameCell.append(tiers);
      }
      if (Array.isArray(entry.surfaces) && entry.surfaces.length) {
        const surfaces = document.createElement('small');
        surfaces.className = 'debug-tool-surfaces';
        surfaces.textContent = `SURFACE ${entry.surfaces.join(' · ')}`;
        nameCell.append(surfaces);
      }
      const description = document.createElement('span');
      description.className = 'debug-tool-description';
      description.textContent = entry.description || t('debug.noDescription');
      description.title = entry.description || '';
      const exposure = document.createElement('div');
      exposure.className = 'debug-tool-exposure';
      const exposureWorkspace = snapshot?.toolExposure?.workspace || state?.selectedWorkspace || '';
      const exposureService = currentWorkspaceService(exposureWorkspace);
      const effectiveTier = snapshot?.toolExposure?.toolTier || exposureService?.toolTier || 'full';
      const tierAllowed = Array.isArray(entry.tiers) && entry.tiers.includes(effectiveTier);
      const localEnabled = exposureService?.enabled !== false;
      // Runtime's catalog currently exposes tier membership and the effective
      // model exposure flag. It does not emit a `surfaces` field, so requiring
      // it here incorrectly marks every local tool as not exposed.
      const localVisible = Boolean(localEnabled && tierAllowed);
      const publicEnabled = localEnabled && exposureService?.publicEnabled === true;
      const publicVisible = Boolean(publicEnabled && entry.exposedToModel === true);
      const addExposureChip = (label, visible, enabled = true) => {
        const chip = document.createElement('span');
        chip.className = `debug-tool-exposure-chip ${enabled ? (visible ? 'visible' : 'hidden') : 'disabled'}`;
        chip.textContent = localizedText(enabled ? `${label} ${visible ? '可见' : '未暴露'}` : `${label} 未启用`);
        exposure.append(chip);
      };
      addExposureChip(localizedText('本地'), localVisible, localEnabled);
      addExposureChip(localizedText('公网'), publicVisible, publicEnabled);
      exposure.title = [
        `Workspace: ${exposureWorkspace || '—'}`,
        `Tool Tier: ${effectiveTier}`,
        `Public Surface: ${snapshot?.toolExposure?.surfaceProfile || 'core'}`,
        `Surface membership: ${Array.isArray(entry.surfaces) ? entry.surfaces.join(', ') : '—'}`,
      ].join('\n');
      const recent = document.createElement('span');
      recent.className = 'debug-tool-recent';
      recent.textContent = recentFive || '—';
      const values = [avg === null ? '—' : `${avg}ms`, String(stat.total), fastest === null ? '—' : `${Math.round(fastest)}ms`, slowestTool === null ? '—' : `${Math.round(slowestTool)}ms`];
      row.append(nameCell, description, exposure, recent);
      for (const value of values) {
        const cell = document.createElement('span');
        cell.textContent = value;
        row.append(cell);
      }
      const errorCell = document.createElement(stat.errors ? 'button' : 'span');
      errorCell.className = stat.errors ? 'debug-tool-error-button' : '';
      errorCell.textContent = String(stat.errors);
      if (stat.errors) {
        errorCell.type = 'button';
        errorCell.title = t('debug.showFailure');
        errorCell.setAttribute('aria-expanded', 'false');
      }
      row.append(errorCell);
      toolStats.append(row);
      const variants = variantsByTool.get(entry.name) || [];
      for (const variant of variants) {
        const variantStat = variant.stat;
        const variantAvg = variantStat.total ? Math.round(variantStat.durationTotalMs / variantStat.total) : null;
        const variantRecent = variantStat.durations.slice(-5).reverse().map((value) => `${Math.round(value)}ms`).join(' · ');
        const variantRow = document.createElement('div');
        variantRow.className = `debug-tool-stat-row debug-tool-variant-row${variantStat.errors ? ' error' : ''}`;
        const variantName = document.createElement('div');
        variantName.className = 'debug-tool-variant-name';
        const marker = document.createElement('span');
        marker.textContent = '↳';
        const label = document.createElement('strong');
        label.textContent = variant.operation;
        variantName.append(marker, label);
        const variantDescription = document.createElement('span');
        variantDescription.className = 'debug-tool-variant-description';
        variantDescription.textContent = t('debug.operationMode');
        const variantExposure = document.createElement('span');
        variantExposure.className = 'debug-tool-variant-exposure';
        variantExposure.textContent = t('debug.sameTool');
        const variantRecentCell = document.createElement('span');
        variantRecentCell.className = 'debug-tool-recent';
        variantRecentCell.textContent = variantRecent || '—';
        const variantValues = [
          variantAvg === null ? '—' : `${variantAvg}ms`,
          String(variantStat.total),
          variantStat.fastestMs === null ? '—' : `${Math.round(variantStat.fastestMs)}ms`,
          variantStat.slowestMs === null ? '—' : `${Math.round(variantStat.slowestMs)}ms`,
          String(variantStat.errors),
        ];
        variantRow.append(variantName, variantDescription, variantExposure, variantRecentCell);
        for (const value of variantValues) {
          const cell = document.createElement('span');
          cell.textContent = value;
          variantRow.append(cell);
        }
        toolStats.append(variantRow);
      }
      if (stat.errors) {
        const detail = document.createElement('div');
        detail.className = 'debug-tool-failure-detail';
        detail.hidden = true;
        const codes = Object.entries(stat.failureCodes || {})
          .map(([code, count]) => [code, Number(count) || 0])
          .filter(([, count]) => count > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        const codeTitle = document.createElement('strong');
        codeTitle.textContent = t('debug.topFailureReasons');
        detail.append(codeTitle);
        const codeList = document.createElement('div');
        codeList.className = 'debug-tool-failure-codes';
        if (codes.length) {
          for (const [code, count] of codes) {
            const chip = document.createElement('span');
            chip.textContent = `${code} × ${count}`;
            codeList.append(chip);
          }
        } else {
          codeList.textContent = t('debug.noFailureData');
        }
        detail.append(codeList);
        const recentFailures = Array.isArray(stat.recentFailures) ? [...stat.recentFailures].slice(-5).reverse() : [];
        const recentTitle = document.createElement('strong');
        recentTitle.textContent = t('debug.recentFailures');
        detail.append(recentTitle);
        const recentList = document.createElement('div');
        recentList.className = 'debug-tool-failure-list';
        if (recentFailures.length) {
          for (const failure of recentFailures) {
            const item = document.createElement('div');
            const when = failure?.timestamp ? new Date(failure.timestamp).toLocaleString() : '—';
            const duration = Number.isFinite(Number(failure?.durationMs)) ? `${Math.round(Number(failure.durationMs))}ms` : '—';
            const retry = failure?.retryable ? t('debug.failureRetryable') : '';
            item.textContent = `${when} · ${failure?.errorCode || 'TOOL_ERROR'} · ${duration}${retry}${failure?.error ? ` · ${failure.error}` : ''}`;
            recentList.append(item);
          }
        } else {
          recentList.textContent = t('debug.noFailureSamples');
        }
        detail.append(recentList);
        toolStats.append(detail);
        errorCell.addEventListener('click', () => {
          detail.hidden = !detail.hidden;
          errorCell.setAttribute('aria-expanded', String(!detail.hidden));
        });
      }
    }
  }
  $('debugTraceSummary').textContent += t('debug.traceCatalogSummary', { count: catalog.length, errors });
  const container = $('debugTraces');
  const previousScrollTop = container.scrollTop;
  const restoreScroll = () => {
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(previousScrollTop, maxScrollTop);
  };
  const focusedTraceId = document.activeElement?.dataset?.traceId;
  container.replaceChildren();
  if (!traces.length) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = t(snapshot?.debugMode === 'off' ? 'debug.modeClosedHint' : 'debug.noCalls');
    container.append(empty);
    restoreScroll();
    updateDebugSelection();
    return;
  }
  if (!visibleTraces.length) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = t('debug.noFilteredCalls');
    container.append(empty);
    restoreScroll();
    updateDebugSelection();
    return;
  }
  for (const trace of [...visibleTraces].reverse()) {
    const item = document.createElement('div');
    item.className = 'debug-trace';
    item.dataset.traceId = trace.id || '';
    item.classList.toggle('selected', item.dataset.traceId === selectedDebugTraceId);
    item.setAttribute('aria-expanded', item.dataset.traceId === selectedDebugTraceId ? 'true' : 'false');
    item.tabIndex = 0;
    const toggleTrace = () => {
      selectedDebugTraceId = selectedDebugTraceId === (trace.id || null) ? null : (trace.id || null);
      updateDebugSelection();
    };
    item.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      toggleTrace();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleTrace();
    });
    const main = document.createElement('div');
    main.className = 'debug-trace-main';
    const time = document.createElement('span');
    time.textContent = trace.timestamp ? new Date(trace.timestamp).toLocaleTimeString() : '—';
    const workspace = document.createElement('span');
    workspace.textContent = trace.workspace || trace.serviceId || '—';
    const tool = document.createElement('strong');
    tool.textContent = trace.tool || 'unknown';
    const duration = document.createElement('span');
    duration.textContent = (trace.durationMs ?? 0) + 'ms';
    const bytes = document.createElement('span');
    bytes.textContent = formatBytes(trace.resultBytes);
    const status = document.createElement('span');
    status.className = trace.status === 'ok' ? 'good' : 'bad';
    status.textContent = t(trace.status === 'ok' ? 'common.success' : 'common.failed');
    const copy = document.createElement('button');
    copy.className = 'icon-button compact-icon debug-copy-button';
    copy.dataset.icon = 'copy';
    copy.title = t('debug.copyCall');
    copy.setAttribute('aria-label', copy.title);
    copy.addEventListener('click', async () => {
      await copyDebugText([trace]);
      flashCopied(copy);
      toast(t('debug.callCopied'));
    });
    main.append(time, workspace, tool, duration, bytes, status, copy);
    item.append(main);
    const detail = document.createElement('div');
    detail.className = 'debug-trace-detail';
    const detailTitle = document.createElement('div');
    detailTitle.className = 'debug-trace-detail-title';
    detailTitle.textContent = t('debug.traceDetails');
    const phases = trace.phases && typeof trace.phases === 'object' ? trace.phases : {};
    const phaseEntries = Object.entries(phases).filter(([, value]) => Number(value) > 0);
    if (trace.resultSerializationMs) phaseEntries.push(['resultSerialization', trace.resultSerializationMs]);
    if (phaseEntries.length) {
      const phaseList = document.createElement('div');
      phaseList.className = 'debug-trace-phases';
      for (const [name, value] of phaseEntries.sort((left, right) => Number(right[1]) - Number(left[1]))) {
        const phase = document.createElement('span');
        phase.textContent = `${name}: ${Number(value).toFixed(1)}ms`;
        phaseList.append(phase);
      }
      detail.appendChild(phaseList);
    }
    const pre = document.createElement('pre');
    pre.textContent = debugText(trace);
    detail.append(detailTitle, pre);
    item.append(detail);
    container.append(item);
    setButtonIcon(copy, 'copy');
  }
  updateDebugSelection();
  restoreScroll();
  if (focusedTraceId) {
    requestAnimationFrame(() => {
      const nextFocused = Array.from(container.querySelectorAll('[data-trace-id]')).find((element) => element.dataset.traceId === focusedTraceId);
      nextFocused?.focus({ preventScroll: true });
    });
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function filteredDebugTraces(traces) {
  const query = debugToolFilter.trim().toLowerCase();
  return traces.filter((trace) => {
    const statusMatch = debugStatusFilter === 'all' || trace.status === debugStatusFilter;
    const textMatch = !query || [trace.tool, trace.workspace, trace.serviceId].some((value) => String(value || '').toLowerCase().includes(query));
    return statusMatch && textMatch;
  });
}

function updateDebugSelection() {
  document.querySelectorAll('.debug-trace').forEach((element) => {
    const expanded = element.dataset.traceId === selectedDebugTraceId;
    element.classList.toggle('selected', expanded);
    element.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
}

function debugText(trace) {
  return JSON.stringify({
    timestamp: trace.timestamp,
    tool: trace.tool,
    workspace: trace.workspace || trace.serviceId,
    status: trace.status,
    durationMs: trace.durationMs,
    arguments: trace.arguments,
    resultBytes: trace.resultBytes,
    phases: trace.phases,
    resultSerializationMs: trace.resultSerializationMs,
    ...(trace.error ? { error: trace.error } : {}),
  }, null, 2);
}

async function copyDebugText(traces) {
  if (!traces.length) return;
  await window.desktop.copyText(traces.map(debugText).join('\n\n'));
}

async function refreshDebugSnapshot() {
  try {
    renderDebugSnapshot(await window.desktop.getDebugSnapshot());
  } catch (error) {
    const empty = document.createElement('div');
    empty.className = 'logs-empty';
    empty.textContent = error?.message || String(error);
    $('debugTraces').replaceChildren(empty);
  }
}

function nullableNumber(id) {
  const value = $(id).value.trim();
  return value === '' ? null : Number(value);
}

function displayLspPath(item) {
  if (!item.path) return t('lsp.executableNotFound');
  return item.command;
}

function displayLspVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return t('lsp.versionUnknown');
  const semanticVersion = raw.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  if (semanticVersion) return semanticVersion[1];
  const dateVersion = raw.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return dateVersion?.[0] || raw.replace(/^version\s+/i, '').replace(/^v(?=\d)/i, '');
}

const LSP_LANGUAGE_FALLBACKS = {
  typescript: 'TS', html: 'HTML', css: 'CSS', python: 'PY', json: '{}', yaml: 'YML', markdown: 'MD', go: 'GO',
  rust: 'RS', java: 'JV', c: 'C', cpp: 'C++', php: 'PHP', vue: 'VUE', bash: '$', dockerfile: 'DKR',
};

function renderRuntimeAdmin(snapshot) {
  runtimeAdmin = snapshot;
  if (!snapshot) return;
  const runtime = snapshot.runtime;
  const progressBanner = $('managedLspProgressBanner');
  if (progressBanner) {
    const progress = managedLspProgress;
    progressBanner.textContent = progress?.message || '';
    progressBanner.className = `lsp-progress-banner${progress ? ` ${progress.phase}` : ''}`;
  }
  const managedLspList = $('managedLspList');
  if (managedLspList) {
    managedLspList.replaceChildren(...(state?.managedLsp?.languages || []).map((item) => {
      const row = document.createElement('div');
      row.className = 'lsp-managed-row';
      const label = document.createElement('span');
      label.className = 'lsp-managed-label';
      const languageBadge = document.createElement('span');
      languageBadge.className = 'lsp-language-icon';
      const devicon = window.MCPortLanguageIcons?.render(item.id) || '';
      if (devicon) languageBadge.innerHTML = devicon;
      else languageBadge.textContent = LSP_LANGUAGE_FALLBACKS[item.id] || String(item.id || '?').slice(0, 3).toUpperCase();
      const labelText = document.createElement('span');
      labelText.className = 'lsp-managed-label-text';
      setAutoScrollText(labelText, item.label);
      label.append(languageBadge, labelText);
      const pathValue = document.createElement('span');
      pathValue.className = 'lsp-managed-path';
      setAutoScrollText(pathValue, displayLspPath(item), 'code');
      const version = document.createElement('span');
      version.className = 'lsp-managed-version';
      setAutoScrollText(version, displayLspVersion(item.version));
      const status = document.createElement('span');
      const progress = managedLspProgressByLanguage[item.id] || null;
      setAutoScrollText(status, progress?.message || t(item.installed ? 'lsp.installed' : 'lsp.notInstalled'));
      status.classList.toggle('good', item.installed);
      const busy = progress?.phase === 'checking' || progress?.phase === 'installing';
      const button = document.createElement('button');
      button.className = 'button subtle';
      button.type = 'button';
      button.dataset.lspLanguage = item.id;
      button.textContent = localizedText(busy ? '处理中…' : item.installed ? '更新' : '下载');
      button.disabled = busy;
      const openButton = document.createElement('button');
      openButton.className = 'button subtle lsp-open-button';
      openButton.type = 'button';
      openButton.dataset.openLspLanguage = item.id;
      openButton.textContent = localizedText('打开目录');
      row.append(label, pathValue, version, status, button, openButton);
      return row;
    }));
  }
  if (!formDirty) {
    $('runtimeConfigPathInput').value = runtime.runtimePath;
    $('runtimeConfigCommandsInput').value = runtime.allowedCommands.join(',');
    $('runtimeNetworkIsolationRequiredInput').checked = runtime.networkIsolationRequired;
    $('runtimeLspEnabledInput').checked = runtime.lspEnabled;
    $('runtimeLspTimeoutInput').value = String(runtime.lspRequestTimeoutMs);
    $('runtimeLspCustomServersInput').value = runtime.lspCustomServers || '[]';
    try { customLspDraft = JSON.parse(runtime.lspCustomServers || '[]'); } catch { customLspDraft = []; }
    renderCustomLspEditor();
    $('runtimeDefaultTimeoutInput').value = String(runtime.defaultCommandTimeoutMs);
    $('runtimeMaxTimeoutInput').value = String(runtime.maxCommandTimeoutMs);
    $('runtimeMaxFileInput').value = String(runtime.maxFileBytes);
    $('runtimeMaxOutputInput').value = String(runtime.maxCommandOutputBytes);
  }
  renderAllowedCommandsHint();

  const services = $('mcpServicesSummary');
  services.replaceChildren();
  for (const service of snapshot.mcpServices) {
    const item = document.createElement('div');
    item.className = 'mini-item';
    const scope = service.workspaces === null ? '全部 Workspace' : (service.workspaces.join(', ') || '无 Workspace');
    item.textContent = `${service.name} · ${service.host}:${service.port}${service.path} · ${scope}`;
    services.appendChild(item);
  }
}

$('customLspEditor')?.addEventListener('input', (event) => {
  const input = event.target.closest('[data-custom-index]');
  if (!input) return;
  const index = Number(input.dataset.customIndex);
  const key = input.dataset.customKey;
  if (!customLspDraft[index] || !key) return;
  customLspDraft[index][key] = key === 'extensions' || key === 'args'
    ? input.value.split(',').map((value) => value.trim()).filter(Boolean)
    : input.value.trim();
  $('runtimeLspCustomServersInput').value = JSON.stringify(customLspDraft);
  setFormDirty();
});
$('customLspEditor')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-custom-lsp]');
  if (!button) return;
  customLspDraft.splice(Number(button.dataset.removeCustomLsp), 1);
  renderCustomLspEditor();
  setFormDirty();
});
$('addCustomLspButton')?.addEventListener('click', () => {
  customLspDraft.push({ extensions: [], languageId: '', command: '', args: ['--stdio'] });
  renderCustomLspEditor();
  setFormDirty();
  $('customLspEditor input')?.focus();
});

function renderCustomLspEditor() {
  const editor = $('customLspEditor');
  if (!editor) return;
  editor.replaceChildren(...customLspDraft.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'custom-lsp-row';
    const fields = [
      [t('lsp.extensions'), 'extensions', '.lua'], [t('lsp.languageId'), 'languageId', 'lua'], [t('lsp.command'), 'command', 'lua-language-server'], [t('lsp.args'), 'args', '--stdio'],
    ];
    for (const [labelText, key, placeholder] of fields) {
      const label = document.createElement('label');
      label.textContent = localizedText(labelText);
      const input = document.createElement('input');
      input.placeholder = placeholder;
      input.value = Array.isArray(item[key]) ? item[key].join(', ') : item[key] || '';
      input.dataset.customIndex = String(index);
      input.dataset.customKey = key;
      label.append(input);
      row.append(label);
    }
    const remove = document.createElement('button');
    remove.className = 'button subtle custom-lsp-remove';
    remove.type = 'button';
    remove.dataset.removeCustomLsp = String(index);
    remove.textContent = t('lsp.remove');
    row.append(remove);
    return row;
  }));
  $('runtimeLspCustomServersInput').value = JSON.stringify(customLspDraft);
}

async function loadRuntimeAdmin() {
  if (runtimeAdminLoading) return runtimeAdmin;
  runtimeAdminLoading = true;
  try {
    const snapshot = await window.desktop.getRuntimeAdmin();
    renderRuntimeAdmin(snapshot);
    return snapshot;
  } catch (error) {
    $('runtimeSettingsStatus').textContent = error?.message || String(error);
    return null;
  } finally {
    runtimeAdminLoading = false;
  }
}

function automaticHealthWarmupActive() {
  return Date.now() < automaticHealthReadyAt;
}

function scheduleAutomaticHealthRefresh(settleMs = 0) {
  automaticHealthReadyAt = Math.max(automaticHealthReadyAt, Date.now() + Math.max(0, settleMs));
  if (automaticHealthTimer) clearTimeout(automaticHealthTimer);
  const delay = Math.max(0, automaticHealthReadyAt - Date.now());
  automaticHealthTimer = setTimeout(() => {
    automaticHealthTimer = null;
    if (document.visibilityState === 'visible' && state?.runtime.phase === 'running' && workspaceListCache.length) {
      automaticHealthDeferred = false;
      void refreshHealthChecks({ quiet: true });
    } else if (document.visibilityState !== 'visible') {
      automaticHealthDeferred = true;
    }
  }, delay);
}

function renderWorkspaceQuickStatus() {
  const box = $('workspaceMcpQuickStatus');
  const label = $('workspaceMcpQuickStatusLabel');
  const detail = $('workspaceMcpQuickStatusDetail');
  if (!box || !label || !detail) return;
  const workspaceName = editingWorkspaceName || state?.selectedWorkspace || '';
  const service = currentWorkspaceService(workspaceName);
  const health = workspaceHealth(workspaceName);
  let tone = 'muted';
  let titleKey = 'quick.ready';
  let messageKey = 'quick.readyDetail';
  let message = '';
  if (!service?.enabled) {
    titleKey = 'quick.disabled';
    messageKey = 'quick.disabledDetail';
  } else if (state?.runtime?.phase !== 'running') {
    titleKey = state?.runtime?.phase === 'starting' ? 'quick.runtimeStarting' : 'quick.runtimeNotReady';
    message = state?.runtime?.error || '';
    messageKey = 'quick.runtimeDetail';
  } else if (automaticHealthWarmupActive() && !health) {
    titleKey = 'quick.waiting';
    messageKey = 'quick.waitingDetail';
  } else if (health?.local && !health.local.ok) {
    tone = 'bad';
    titleKey = 'quick.localIssue';
    message = health.local.message || '';
    messageKey = 'quick.localDetail';
  } else if (service.publicEnabled && health?.public && !health.public.ok) {
    tone = 'bad';
    titleKey = 'quick.publicIssue';
    message = health.public.message || '';
    messageKey = 'quick.publicDetail';
  } else if (health?.local?.ok && (!service.publicEnabled || health?.public?.ok)) {
    tone = 'good';
    titleKey = 'quick.passed';
    messageKey = service.publicEnabled ? 'quick.bothAvailable' : 'quick.localAvailable';
  } else if (healthChecking) {
    titleKey = 'quick.checking';
    messageKey = 'quick.checkingDetail';
  } else {
    titleKey = 'quick.pending';
    messageKey = service.publicEnabled ? 'quick.pendingPublic' : 'quick.pendingLocal';
  }
  label.textContent = t(titleKey);
  detail.textContent = message || t(messageKey);
  box.className = `workspace-mcp-quick-status ${tone}`.trim();
}

async function changeWorkspaceDirectory(workspace) {
  if (!workspace?.name) return;
  try {
    const next = await window.desktop.changeWorkspaceDirectory(workspace.name);
    if (!next) return;
    render(next);
    runtimeAdmin = null;
    await loadRuntimeAdmin();
    await loadWorkspaces();
    requestHealthRefresh(HEALTH_SETTLE_MS);
    toast(t('workspace.folderChanged'));
  } catch (error) {
    toast(error?.message || String(error));
  }
}

async function refreshHealthChecks({ quiet = false } = {}) {
  if (healthChecking) {
    healthRefreshPending = true;
    return;
  }
  if (!workspaceListCache.length) {
    renderGlobalStatus();
    if (!quiet) toast('暂无 Workspace 可检查');
    return;
  }
  if (quiet && lastHealthCheckedAt && Date.now() - lastHealthCheckedAt < HEALTH_MIN_AUTO_INTERVAL_MS) {
    scheduleAutomaticHealthRefresh(HEALTH_MIN_AUTO_INTERVAL_MS - (Date.now() - lastHealthCheckedAt));
    return;
  }
  healthChecking = true;
  const button = $('refreshHealthButton');
  button.disabled = true;
  setButtonIcon(button, 'loader');
  button.classList.add('loading');
  renderGlobalStatus();
  renderWorkspaceManagement(workspaceListCache);
  try {
    const results = await window.desktop.checkWorkspaceHealth();
    workspaceHealthCache = new Map(results.map((item) => [item.workspace, item]));
    lastHealthCheckedAt = Date.now();
    renderWorkspaceManagement(workspaceListCache);
    if (!quiet) {
      const errors = healthErrorCount();
      toast(errors ? t('health.checkComplete', { count: errors }) : t('health.allWorkspacesHealthy'));
    }
  } catch (error) {
    if (!quiet) toast(error?.message || String(error));
  } finally {
    healthChecking = false;
    button.disabled = false;
    button.classList.remove('loading');
    setButtonIcon(button, 'refresh');
    renderGlobalStatus();
    renderWorkspaceManagement(workspaceListCache);
    renderWorkspaceQuickStatus();
    if (healthRefreshPending) {
      healthRefreshPending = false;
      queueMicrotask(() => void refreshHealthChecks({ quiet: true }));
    }
  }
}

function requestHealthRefresh(settleMs = 0) {
  if (!workspaceListCache.length) return;
  if (healthChecking) {
    healthRefreshPending = true;
    return;
  }
  scheduleAutomaticHealthRefresh(settleMs);
}

function setPublicGatewayVisualState(phase) {
  const card = $('publicGatewayCard');
  const badge = $('publicGatewayHealthBadge');
  if (!card || !badge) return;
  card.classList.remove('checking', 'good', 'bad');
  if (phase !== 'unchecked') card.classList.add(phase);
  const config = phase === 'good'
    ? { icon: 'check', key: 'gateway.stateHealthy' }
    : phase === 'bad'
      ? { icon: 'alert', key: 'gateway.stateError' }
      : phase === 'checking'
        ? { icon: 'loader', key: 'gateway.stateChecking' }
        : { icon: 'pulse', key: 'gateway.stateUnchecked' };
  badge.className = `gateway-health-badge ${phase === 'unchecked' ? '' : phase}`.trim();
  badge.innerHTML = `${iconMarkup(config.icon)}<span>${t(config.key)}</span>`;
}

async function runPublicAccessCheck() {
  if (state?.settings?.publicAccessProvider !== 'trycloudflare') {
    const savedDomain = state?.settings.tunnelBaseDomain || '';
    const currentDomain = $('tunnelBaseDomainInput').value.trim();
    if (currentDomain !== savedDomain) return toast('请先保存公网 Host，再检查实际公网配置');
  }
  const button = $('checkPublicAccessButton');
  const status = $('publicAccessCheckStatus');
  button.disabled = true;
  button.classList.add('loading');
  setButtonIcon(button, 'loader');
  setPublicGatewayVisualState('checking');
  status.className = 'config-check-status ui-hidden';
  status.textContent = '';
  try {
    const result = await window.desktop.checkPublicConfig();
    const failures = [];
    if (!result.localGateway.ok) failures.push(`Gateway: ${result.localGateway.message}`);
    failures.push(...result.routes.filter((item) => !item.probe.ok).map((item) => `${item.workspace}: ${item.probe.message}`));
    setPublicGatewayVisualState(result.ok ? 'good' : 'bad');
    if (result.ok) {
      status.className = 'config-check-status ui-hidden';
      status.textContent = '';
    } else {
      status.className = 'config-check-status bad';
      status.textContent = failures.length ? `${result.summary} · ${failures.join('；')}` : result.summary;
    }
    toast(result.ok ? t('gateway.okToast') : t('gateway.badToast'));
    await refreshHealthChecks({ quiet: true });
  } catch (error) {
    setPublicGatewayVisualState('bad');
    status.className = 'config-check-status bad';
    status.textContent = error?.message || String(error);
  } finally {
    button.disabled = false;
    button.classList.remove('loading');
    setButtonIcon(button, 'pulse');
  }
}

async function setWorkspaceMcpEnabled(workspace, enabled, control) {
  if (!workspace?.name || !window.desktop.setWorkspaceEnabled) return;
  if (control) control.disabled = true;
  try {
    const next = await window.desktop.setWorkspaceEnabled(workspace.name, enabled);
    render(next);
    toast(t(enabled ? 'workspace.mcpEnabled' : 'workspace.mcpDisabled', { name: workspace.name }));
    requestHealthRefresh(HEALTH_SETTLE_MS);
  } catch (error) {
    toast(error?.message || String(error));
    if (control) control.checked = !enabled;
  } finally {
    if (control) control.disabled = false;
  }
}

function renderWorkspaceManagement(workspaces) {
  const list = $('workspaceList');
  const inlinePanel = $('workspaceSettingsModal');
  const expandedWorkspace = inlinePanel.classList.contains('show') ? editingWorkspaceName : null;
  if (inlinePanel.parentElement?.classList.contains('workspace-item')) inlinePanel.remove();
  list.replaceChildren();
  if (!workspaces.length) {
    inlinePanel.classList.add('ui-hidden');
    document.body.appendChild(inlinePanel);
    list.appendChild(makeEmptyState({
      title: '还没有项目',
      message: '选择任意已有目录即可注册，不会移动或修改你的项目文件。',
      actionLabel: '添加已有目录',
      action: () => $('addExistingWorkspaceButton').click(),
    }));
    return;
  }

  let restoredExpandedPanel = false;
  for (const workspace of workspaces) {
    const service = state?.settings.workspaceServices.find((item) => item.workspace === workspace.name) || null;
    const serviceEnabled = service?.enabled !== false;
    const expanded = expandedWorkspace === workspace.name;
    const card = document.createElement('div');
    card.className = 'card workspace-item';
    card.dataset.workspaceName = workspace.name;
    card.classList.toggle('workspace-disabled', !serviceEnabled);
    card.classList.toggle('settings-expanded', expanded);
    card.addEventListener('click', (event) => {
      if (event.target.closest('button, input, label, select, textarea, a, .workspace-settings-inline')) return;
      void openWorkspaceSettingsModal(workspace).catch((error) => toast(error?.message || String(error)));
    });

    const top = document.createElement('div');
    top.className = 'workspace-main-row';

    const master = document.createElement('label');
    master.className = 'workspace-mcp-pill';
    master.title = t(serviceEnabled ? 'workspace.disableMcp' : 'workspace.enableMcp');
    const masterInput = document.createElement('input');
    masterInput.type = 'checkbox';
    masterInput.checked = serviceEnabled;
    masterInput.setAttribute('aria-label', t('workspace.masterLabel', { name: workspace.name }));
    const masterTrack = document.createElement('span');
    masterTrack.className = 'workspace-mcp-pill-track';
    const masterText = document.createElement('strong');
    masterText.textContent = 'MCP';
    masterInput.addEventListener('change', (event) => {
      event.stopPropagation();
      void setWorkspaceMcpEnabled(workspace, masterInput.checked, masterInput);
    });
    master.append(masterInput, masterTrack, masterText);

    const info = document.createElement('div');
    info.className = 'workspace-primary-info';
    const name = document.createElement('strong');
    name.className = 'workspace-name';
    name.textContent = workspace.name;
    const workspacePath = document.createElement('button');
    workspacePath.className = 'workspace-path-button';
    workspacePath.dataset.icon = 'folder-code';
    workspacePath.textContent = workspace.path;
    workspacePath.title = t('workspace.openFolder', { name: workspace.name });
    workspacePath.setAttribute('aria-label', workspacePath.title);
    workspacePath.addEventListener('click', () => runAction(() => window.desktop.openWorkspace(workspace.name)));
    info.append(name, workspacePath);

    const actions = document.createElement('div');
    actions.className = 'workspace-row-actions';
    const changeDirectory = document.createElement('button');
    changeDirectory.className = 'workspace-row-action';
    changeDirectory.title = t('workspace.changeFolderTitle');
    changeDirectory.setAttribute('aria-label', t('workspace.changeFolder', { name: workspace.name }));
    changeDirectory.dataset.icon = 'folder-pen';
    changeDirectory.textContent = t('workspace.changeFolderButton');
    changeDirectory.addEventListener('click', (event) => {
      event.stopPropagation();
      void changeWorkspaceDirectory(workspace);
    });
    const remove = document.createElement('button');
    remove.className = 'workspace-row-action danger';
    remove.title = t('workspace.removeTitle');
    remove.setAttribute('aria-label', t('workspace.removeLabel', { name: workspace.name }));
    remove.dataset.icon = 'trash';
    remove.textContent = t('workspace.deleteButton');
    remove.addEventListener('click', () => removeWorkspace(workspace));
    actions.append(changeDirectory, remove);
    top.append(master, info, actions);
    hydrateIcons(top);

    const publicUrl = workspacePublicUrl(service);
    const health = workspaceHealth(workspace.name);
    const warmingUp = automaticHealthWarmupActive() && !health;
    const localFallback = state?.runtime.phase === 'running'
      ? t(warmingUp ? 'health.preparing' : healthChecking ? 'health.checking' : 'health.pending')
      : t('health.notRunning');
    const publicFallback = t(warmingUp ? 'health.preparing' : healthChecking ? 'health.checking' : 'health.pending');
    const localHealth = serviceEnabled ? probePresentation(health?.local, localFallback) : { label: t('health.closed'), tone: 'muted' };
    const tryCloudflareStage = state?.settings?.publicAccessProvider === 'trycloudflare' ? state?.tunnel?.readinessStage : null;
    const tryCloudflareStabilizing = Boolean(
      state?.settings?.publicAccessProvider === 'trycloudflare'
      && (state?.tunnel?.phase === 'starting' || tryCloudflareStage === 'requesting_url' || tryCloudflareStage === 'runtime_reload' || tryCloudflareStage === 'propagating')
    );
    const tryCloudflareStageLabel = tryCloudflareStage === 'runtime_reload'
      ? '重载 Runtime…'
      : tryCloudflareStage === 'propagating'
        ? '公网/OAuth 生效中…'
        : t('tunnel.establishing');
    const publicHealth = !serviceEnabled
      ? { label: t('health.closed'), tone: 'muted' }
      : tryCloudflareStabilizing
        ? { label: tryCloudflareStageLabel, tone: 'muted' }
        : publicUrl ? probePresentation(health?.public, publicFallback) : { label: t('health.disabled'), tone: 'muted' };
    const profile = workspaceProfile(workspace.name);
    const security = workspaceSecurityPresentation(service, profile);
    const providerLabel = ({
      cloudflare: 'Cloudflare Tunnel',
      trycloudflare: 'TryCloudflare',
      frp: 'FRP Client',
      external: '外部 / 自建',
    })[state?.settings?.publicAccessProvider || 'cloudflare'] || '公网通道';
    const authLabel = serviceEnabled ? (publicUrl ? workspacePublicAuthLabel(service?.publicAuthMode) : '未启用') : '已关闭';
    const publicDetail = [
      t('workspace.publicAddress', { value: publicUrl || t('security.disabled') }),
      `通道：${providerLabel}`,
      `认证：${authLabel}`,
      `状态：${health?.public?.message || publicHealth.label}`,
      health ? healthLastCheckedText() : '',
      service?.publicAuthMode === 'oauth' ? t('workspace.oauthDetail') : service?.publicAuthMode === 'token' ? t('workspace.tokenDetail') : '',
    ].filter(Boolean).join('\n');
    const publicNeedsRetry = Boolean(health?.public && !health.public.ok && health.public.status !== 'disabled');
    const publicAction = publicUrl
      ? {
        title: '复制公网 MCP 地址',
        successMessage: '公网 MCP 地址已复制',
        run: () => window.desktop.copyWorkspaceEndpoint(workspace.name, 'public'),
        ...(publicNeedsRetry ? { retry: () => refreshHealthChecks() } : {}),
      }
      : publicNeedsRetry ? { retry: () => refreshHealthChecks() } : null;
    if (serviceEnabled && (localHealth.tone === 'bad' || publicHealth.tone === 'bad')) card.classList.add('health-error');
    const statusGrid = document.createElement('div');
    statusGrid.className = 'workspace-status-grid compact';
    statusGrid.append(
      makeWorkspaceStatus('公网 MCP', publicHealth.label, publicHealth.tone, publicDetail, publicAction, 'workflow'),
    );
    for (const capability of security.capabilities || []) {
      statusGrid.append(makeWorkspaceCapability(capability.label, capability.value, capability.tone, capability.detail, capability.icon));
    }
    hydrateIcons(statusGrid);
    card.append(top, statusGrid);
    const recovery = workspaceRecoveryAdvice(workspace, service, health);
    if (recovery && !['recovery.publicIssue', 'recovery.publicAuthIssue', 'recovery.publicClientNotRunning'].includes(recovery.titleKey)) card.append(makeWorkspaceRecoveryCard(recovery));
    list.appendChild(card);

    if (expanded) {
      card.appendChild(inlinePanel);
      inlinePanel.classList.remove('ui-hidden');
      renderWorkspaceConnectionCard();
      restoredExpandedPanel = true;
    }
  }
  if (expandedWorkspace && !restoredExpandedPanel) closeWorkspaceSettingsModal();
  i18n.apply(document);
}

function renderWorkspaceLoadError(message) {
  const config = { title: t('workspace.loadFailed'), message, error: true, actionLabel: t('workspace.retry'), action: () => loadWorkspaces() };
  $('workspaceList').replaceChildren(makeEmptyState(config));
}

async function loadWorkspaces() {
  try {
    const workspaces = await window.desktop.listWorkspaces();
    workspaceListCache = workspaces;
    const workspaceNames = new Set(workspaces.map((workspace) => workspace.name));
    workspaceHealthCache = new Map(
      [...workspaceHealthCache].filter(([workspace]) => workspaceNames.has(workspace)),
    );
    if (!workspaces.length) lastHealthCheckedAt = 0;
    renderWorkspaceManagement(workspaces);
    renderGlobalStatus();
    if (workspaces.length && state?.runtime.phase === 'running' && !workspaceHealthCache.size) requestHealthRefresh();
  } catch (error) {
    const message = error?.message || String(error);
    renderWorkspaceLoadError(message);
    toast(message);
  }
}

function render(next) {
  if (state && Number.isFinite(next?.revision) && Number.isFinite(state?.revision) && next.revision < state.revision) return;
  const previousRuntimePhase = lastRuntimePhase;
  const previousTunnelPhase = lastTunnelPhase;
  const previousTunnelReadinessStage = lastTunnelReadinessStage;
  state = next;
  if (!state) return;
  updateDebugNavigation();
  applyAppearanceTheme(state.settings?.appearance || 'system');
  applyUiLanguage(formDirty && $('uiLanguageInput')?.value ? $('uiLanguageInput').value : (state.settings?.uiLanguage || 'system'));
  const warnings = Array.isArray(state.warnings) ? state.warnings : [];
  $('startupWarningBanner').classList.toggle('ui-hidden', warnings.length === 0);
  $('startupWarningText').textContent = warnings.join('\n\n');
  lastRuntimePhase = state.runtime.phase;
  lastTunnelPhase = state.tunnel.phase;
  lastTunnelReadinessStage = state.tunnel.readinessStage || null;
  if (state.runtime.phase !== 'running' && workspaceHealthCache.size) workspaceHealthCache = new Map();
  if (workspaceListCache.length) {
    renderWorkspaceManagement(workspaceListCache);
  }
  const phase = state.runtime.phase;
  $('endpoint').textContent = state.endpoint || t('workspace.select');
  $('appVersion').textContent = `v${state.version}`;
  $('platform').textContent = state.platform === 'darwin' ? 'macOS' : state.platform === 'win32' ? 'Windows' : state.platform;
  document.querySelectorAll('.save-shortcut').forEach((el) => { el.textContent = state.platform === 'darwin' ? '⌘S' : 'Ctrl+S'; });
  $('runtimeMeta').textContent = phase === 'running'
    ? `PID ${state.runtime.pid || '—'} · 启动于 ${state.runtime.startedAt ? new Date(state.runtime.startedAt).toLocaleTimeString() : '—'}`
    : state.runtime.error || 'Runtime 未启动';
  if (phase === 'running' && !runtimeAdmin) void loadRuntimeAdmin();
  if (
    phase === 'running'
    && previousRuntimePhase !== 'running'
    && workspaceListCache.length
  ) {
    requestHealthRefresh(HEALTH_SETTLE_MS);
  }

  const tunnelPhase = state.tunnel.phase;
  if (
    previousTunnelPhase !== null
    && previousTunnelPhase !== tunnelPhase
    && workspaceListCache.length
  ) {
    requestHealthRefresh(HEALTH_SETTLE_MS);
  }
  if (
    previousTunnelReadinessStage === 'propagating'
    && state.tunnel.readinessStage === 'ready'
    && workspaceListCache.length
  ) {
    workspaceHealthCache = new Map();
    requestHealthRefresh(0);
  }
  const publicRoutes = state.settings.workspaceServices.filter((item) => item.enabled && item.publicEnabled && (state.settings.publicAccessProvider === 'trycloudflare' ? state.tunnel.publicUrl : state.settings.tunnelBaseDomain));
  const tryCloudflareStage = state.settings.publicAccessProvider === 'trycloudflare' ? state.tunnel.readinessStage : null;
  $('tunnelStatusBadge').textContent = tryCloudflareStage === 'requesting_url'
    ? t('tunnel.requestingUrl')
    : tryCloudflareStage === 'runtime_reload'
      ? t('tunnel.runtimeReload')
      : tryCloudflareStage === 'propagating'
        ? t('tunnel.propagating')
        : localizedText(statusLabels[tunnelPhase] || tunnelPhase);
  $('tunnelRouteSummary').textContent = localizedText(publicRoutes.length
    ? `${publicRoutes.length} 个 Workspace 公网入口`
    : '0 个 Workspace 公网入口');
  const publicHost = state.settings.publicAccessProvider === 'trycloudflare'
    ? (() => { try { return state.tunnel.publicUrl ? new URL(state.tunnel.publicUrl).host : ''; } catch { return ''; } })()
    : state.settings.tunnelBaseDomain
      ? (state.settings.publicAccessProvider === 'frp'
        ? `${state.settings.frpSubdomain || 'mcp'}.${state.settings.tunnelBaseDomain}`
        : state.settings.tunnelBaseDomain)
      : '';
  $('tunnelGatewayHostname').textContent = publicHost || t('gateway.hostPlaceholder');
  $('tunnelGatewayOrigin').textContent = `http://127.0.0.1:${state.settings.port}`;
  const tunnelProxy = state.settings.proxyMode === 'manual'
    ? state.settings.tunnelProxyEnabled
      ? t('status.tunnelProxy', { url: state.settings.proxyUrl || t('status.notConfigured') })
      : t('status.tunnelDirect')
    : state.settings.proxyMode === 'system'
      ? t('status.tunnelSystem', { mode: t(state.settings.tunnelProxyEnabled ? 'status.followSystem' : 'status.direct') })
      : '';
  const tunnelActionHint = $('tunnelActionHint');
  const tunnelRetrying = tunnelPhase === 'error' && Number(state.tunnel.retryDelayMs) > 0 && state.tunnel.retryAt;
  const tunnelRetryText = tunnelRetrying
    ? t('status.retry', { mode: t(state.tunnel.retryMode === 'quick' ? 'status.quickRetry' : 'status.autoRecovery'), attempt: state.tunnel.retryAttempt || 1, seconds: Math.max(1, Math.ceil(Number(state.tunnel.retryDelayMs) / 1000)) })
    : '';
  tunnelActionHint.textContent = tunnelRetryText || tunnelProxy;
  tunnelActionHint.classList.toggle('ui-hidden', (!tunnelRetryText && !tunnelProxy) || state.settings.publicAccessProvider === 'external');
  const providerLabel = state.settings.publicAccessProvider === 'frp'
    ? 'frpc'
    : state.settings.publicAccessProvider === 'trycloudflare'
      ? 'TryCloudflare'
      : state.settings.publicAccessProvider === 'external' ? '外部接入' : 'cloudflared';
  const tunnelPublicUrl = state.tunnel.publicUrl ? ` · ${state.tunnel.publicUrl}` : '';
  $('tunnelMeta').textContent = tryCloudflareStage === 'requesting_url'
    ? t('tunnel.requestingMeta')
    : tryCloudflareStage === 'runtime_reload'
      ? t('tunnel.runtimeReloadMeta', { url: tunnelPublicUrl })
      : tryCloudflareStage === 'propagating'
        ? t('tunnel.propagatingMeta', { url: tunnelPublicUrl })
        : tunnelPhase === 'running'
          ? t('tunnel.available', { provider: providerLabel, pid: state.tunnel.pid ? ` · PID ${state.tunnel.pid}` : '' })
          : tunnelRetryText
            ? `${providerLabel} · ${tunnelRetryText}${state.tunnel.error ? ` · ${state.tunnel.error}` : ''}`
            : state.tunnel.error || t('tunnel.notRunning', { provider: providerLabel });
  if (!formDirty) {
    $('portInput').value = String(state.settings.port);
    $('workspaceScopeInput').value = state.settings.workspaceScope.join(',');
    $('additionalServicesInput').value = state.settings.additionalServicesJson || '';
    $('authModeInput').value = state.settings.authMode;
    $('proxyModeInput').value = state.settings.proxyMode || 'off';
    $('proxyUrlInput').value = state.settings.proxyUrl || '';
    $('proxyBypassInput').value = state.settings.proxyBypass || '<local>,localhost,127.0.0.1,[::1]';
    $('proxyManualSettings').classList.toggle('ui-hidden', $('proxyModeInput').value !== 'manual');
    $('uiLanguageInput').value = state.settings.uiLanguage || 'system';
    $('appearanceInput').value = state.settings.appearance || 'system';
    $('debugModeInput').value = state.settings.debugMode || 'off';
    $('lowMemoryTrayInput').checked = state.settings.lowMemoryTray !== false;
    $('computerUseEnabledInput').checked = state.settings.computerUseEnabled === true;
    $('computerUsePublicEnabledInput').checked = state.settings.computerUsePublicEnabled === true;
    $('publicAccessProviderInput').value = state.settings.publicAccessProvider || 'cloudflare';
    $('tunnelProxyEnabledInput').checked = state.settings.tunnelProxyEnabled === true;
    $('publicClientModeInput').value = state.settings.publicClientMode || 'managed';
    $('publicClientPathInput').value = state.settings.publicClientPath || '';
    $('publicClientVersionInput').value = state.settings.publicClientVersion || '';
    $('cloudflareTransportProtocolInput').value = state.settings.cloudflareTransportProtocol || 'auto';
    $('cloudflareEdgeIpVersionInput').value = state.settings.cloudflareEdgeIpVersion || 'auto';
    $('publicClientVersionModeInput').value = state.settings.publicClientVersion ? 'specific' : 'latest';
    $('tunnelBaseDomainInput').value = state.settings.tunnelBaseDomain || '';
    $('frpServerAddrInput').value = state.settings.frpServerAddr || '';
    $('frpServerPortInput').value = String(state.settings.frpServerPort || 7000);
    $('frpSubdomainInput').value = state.settings.frpSubdomain || 'mcp';
    $('frpTransportProtocolInput').value = state.settings.frpTransportProtocol || 'tcp';
    $('frpUseCompressionInput').checked = state.settings.frpUseCompression === true;
    $('startTunnelWithRuntimeInput').checked = state.settings.startTunnelWithRuntime;
    $('launchAtLoginInput').checked = state.settings.launchAtLogin;
    $('minimizeToTrayInput').checked = state.settings.minimizeToTray;
    $('tokenSection').style.display = state.settings.authMode === 'token' ? 'block' : 'none';
    updatePublicProviderFields();
    setSaveStatus('没有未保存的更改');
  }
  $('tokenSavedHint').textContent = localizedText(state.hasApiToken ? '· 已安全保存' : '· 尚未设置');
  $('tunnelTokenSavedHint').textContent = localizedText(state.hasTunnelToken ? '· 已安全保存' : '· 尚未设置');
  $('frpTokenSavedHint').textContent = localizedText(state.hasFrpToken ? '· 已安全保存' : '· 尚未设置');
  renderComputerUseAvailability();
  updateComputerUseControls(false);
  updatePublicProviderFields();
  renderGlobalStatus();
  renderLogs();
}

function renderComputerUseAvailability() {
  const status = $('computerUseStatus');
  if (!status || !state) return;
  const enabled = state.settings.computerUseEnabled === true;
  const ready = enabled && state.computerUse?.available === true;
  status.textContent = !enabled
    ? t('computerUse.disabled')
    : ready
      ? t(state.settings.computerUsePublicEnabled ? 'computerUse.readyPublic' : 'computerUse.ready')
      : state.platform === 'darwin'
        ? t('computerUse.permissionsRequired')
        : t('computerUse.unavailable');
  status.classList.toggle('good', ready);
  const needsMacPermissions = state.platform === 'darwin' && enabled && !ready;
  $('openComputerUseSettingsButton')?.classList.toggle('ui-hidden', !needsMacPermissions);
}

async function refreshComputerUseAvailability() {
  if (!state?.settings?.computerUseEnabled || state.platform !== 'darwin') return;
  try {
    state.computerUse = { ...(state.computerUse || {}), ...(await window.desktop.getComputerUseStatus()) };
    renderComputerUseAvailability();
  } catch {
    // Keep the last known state; the next Desktop state refresh will retry.
  }
}

function updateComputerUseControls(clearPublicWhenDisabled = false) {
  const enabled = Boolean($('computerUseEnabledInput')?.checked);
  const publicInput = $('computerUsePublicEnabledInput');
  if (!publicInput) return;
  if (!enabled && clearPublicWhenDisabled) publicInput.checked = false;
  publicInput.disabled = !enabled;
  $('computerUsePublicWarning')?.classList.toggle('ui-hidden', !enabled || !publicInput.checked);
}

function collectSettings() {
  return {
    port: Number($('portInput').value),
    workspaceScope: $('workspaceScopeInput').value.split(',').map((x) => x.trim()).filter(Boolean),
    additionalServicesJson: $('additionalServicesInput').value.trim(),
    authMode: $('authModeInput').value,
    proxyMode: $('proxyModeInput').value,
    proxyUrl: $('proxyUrlInput').value.trim(),
    proxyBypass: $('proxyBypassInput').value.trim(),
    uiLanguage: $('uiLanguageInput').value,
    appearance: $('appearanceInput').value,
    debugMode: $('debugModeInput').value,
    lowMemoryTray: $('lowMemoryTrayInput').checked,
    computerUseEnabled: $('computerUseEnabledInput').checked,
    computerUsePublicEnabled: $('computerUsePublicEnabledInput').checked,
    publicAccessProvider: $('publicAccessProviderInput').value,
    tunnelProxyEnabled: $('tunnelProxyEnabledInput').checked,
    publicClientMode: $('publicClientModeInput').value,
    publicClientPath: $('publicClientPathInput').value.trim(),
    publicClientVersion: $('publicClientVersionModeInput').value === 'specific' ? $('publicClientVersionInput').value.trim() : '',
    cloudflareTransportProtocol: $('cloudflareTransportProtocolInput').value,
    cloudflareEdgeIpVersion: $('cloudflareEdgeIpVersionInput').value,
    tunnelBaseDomain: $('tunnelBaseDomainInput').value.trim(),
    frpServerAddr: $('frpServerAddrInput').value.trim(),
    frpServerPort: Number($('frpServerPortInput').value),
    frpSubdomain: $('frpSubdomainInput').value.trim(),
    frpTransportProtocol: $('frpTransportProtocolInput').value,
    frpUseCompression: $('frpUseCompressionInput').checked,
    startTunnelWithRuntime: $('startTunnelWithRuntimeInput').checked,
    launchAtLogin: $('launchAtLoginInput').checked,
    minimizeToTray: $('minimizeToTrayInput').checked,
    apiToken: $('tokenInput').value.trim(),
    tunnelToken: $('tunnelTokenInput').value.trim(),
    frpToken: $('frpTokenInput').value.trim(),
  };
}

async function runAction(action, successMessage) {
  try {
    const next = await action();
    if (next && next.settings) render(next);
    if (successMessage) toast(successMessage);
    return next;
  } catch (error) {
    toast(error?.message || String(error));
    return null;
  }
}

document.querySelectorAll('.nav-item').forEach((el) => el.addEventListener('click', () => setPage(el.dataset.page)));
document.querySelectorAll('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab)));
document.querySelectorAll('[data-debug-tab]').forEach((button) => button.addEventListener('click', () => setDebugTab(button.dataset.debugTab)));
setDebugTab(currentDebugTab);
hydrateIcons();
$('tunnelActionButton').addEventListener('click', async () => {
  const running = state?.tunnel?.phase === 'running';
  if (!running && state?.settings?.startTunnelWithRuntime !== true) {
    const remember = confirm(t('tunnel.autoStartConfirm'));
    if (remember) {
      $('startTunnelWithRuntimeInput').checked = true;
      setFormDirty();
    }
  }
  await runAction(
    () => running ? window.desktop.stopTunnel() : window.desktop.startTunnel(),
    running ? '公网客户端已停止' : t('tunnel.clientStarted'),
  );
  requestHealthRefresh(HEALTH_SETTLE_MS);
});
$('publicAccessProviderInput').addEventListener('change', updatePublicProviderFields);
$('publicClientModeInput').addEventListener('change', updatePublicProviderFields);
$('getLatestPublicClientVersionButton').addEventListener('click', async () => {
  const button = $('getLatestPublicClientVersionButton');
  const kind = $('publicAccessProviderInput').value === 'frp' ? 'frpc' : 'cloudflared';
  button.disabled = true;
  $('publicClientLatestVersion').textContent = t('publicClient.latestChecking');
  try {
    const version = await window.desktop.getLatestManagedClientVersion(kind);
    latestManagedClientVersions.set(kind, String(version || ''));
    updatePublicProviderFields();
    toast(`${kind} 最新版本：${version}`);
  } catch (error) {
    $('publicClientLatestVersion').textContent = t('publicClient.latestFailed');
    toast(error?.message || String(error));
  } finally {
    button.disabled = false;
  }
});
$('installPublicClientButton').addEventListener('click', async () => {
  const kind = $('publicAccessProviderInput').value === 'frp' ? 'frpc' : 'cloudflared';
  const versionMode = $('publicClientVersionModeInput').value;
  const version = versionMode === 'specific' ? $('publicClientVersionInput').value.trim() : '';
  if (managedClientInstallHideTimer) {
    clearTimeout(managedClientInstallHideTimer);
    managedClientInstallHideTimer = null;
  }
  managedClientInstallProgress = { kind, phase: 'resolving', percent: 1, message: t('lsp.installVersion', { kind, version: version || 'latest' }) };
  updatePublicProviderFields();
  try {
    const installed = await window.desktop.installManagedClient(kind, version);
    if (!version) latestManagedClientVersions.set(kind, installed.version);
    $('publicClientVersionInput').value = version || '';
    $('publicClientStatus').textContent = `当前 ${installed.version}`;
    toast(`${kind} ${installed.version} 已安装并通过 SHA256 校验`);
    render(await window.desktop.getState());
  } catch (error) {
    managedClientInstallProgress = { kind, phase: 'failed', percent: 0, message: t('publicClient.installFailed', { error: error?.message || String(error) }) };
    updatePublicProviderFields();
    toast(error?.message || String(error));
  }
});
$('rollbackPublicClientButton').addEventListener('click', async () => {
  const kind = $('publicAccessProviderInput').value === 'frp' ? 'frpc' : 'cloudflared';
  try {
    const result = await window.desktop.rollbackManagedClient(kind);
    render(result.state);
    $('publicClientVersionModeInput').value = 'specific';
    $('publicClientVersionInput').value = result.binary.version;
    updatePublicProviderFields();
    toast(t('publicClient.rolledBack', { kind, version: result.binary.version }));
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('refreshDebugButton').addEventListener('click', () => void refreshDebugSnapshot());
$('debugStatusFilterInput').addEventListener('change', () => {
  debugStatusFilter = $('debugStatusFilterInput').value;
  if (debugSnapshot) renderDebugSnapshot(debugSnapshot);
});
$('debugToolFilterInput').addEventListener('input', () => {
  debugToolFilter = $('debugToolFilterInput').value;
  if (debugSnapshot) renderDebugSnapshot(debugSnapshot);
});
$('copyVisibleDebugButton').addEventListener('click', async () => {
  const traces = filteredDebugTraces(Array.isArray(debugSnapshot?.traces) ? debugSnapshot.traces : []);
  if (!traces.length) return toast('当前没有可复制的调用');
  await copyDebugText(traces);
  flashCopied($('copyVisibleDebugButton'));
  toast('当前列表已复制');
});
$('clearToolTracesButton').addEventListener('click', async () => {
  try {
    renderDebugSnapshot(await window.desktop.clearToolTraces());
    toast('Tool Trace 已清空');
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('refreshHealthButton').addEventListener('click', () => refreshHealthChecks());
$('checkPublicAccessButton').addEventListener('click', runPublicAccessCheck);
$('logFilterInput').addEventListener('change', renderLogs);
$('logAutoScrollInput').addEventListener('change', renderLogs);
$('copyLogsButton').addEventListener('click', async () => {
  const text = filteredLogs().join('\n');
  if (!text) return;
  await window.desktop.copyText(text);
  flashCopied($('copyLogsButton'));
  toast('当前日志已复制');
});
$('clearLogsButton').addEventListener('click', async () => {
  if (!state?.logs?.length) return;
  if (!confirm(t('logs.clearConfirm'))) return;
  const next = await window.desktop.clearLogs();
  render(next);
  toast('日志已清空');
});
$('currentWorkspacePublicAuthModeInput').addEventListener('change', renderWorkspaceAuthFields);
$('currentWorkspacePublicEnabledInput').addEventListener('change', updateWorkspacePublicPreview);
$('currentWorkspacePublicPathInput').addEventListener('input', updateWorkspacePublicPreview);
for (const id of ['currentWorkspaceEditInput', 'currentWorkspaceCommandInput', 'currentWorkspaceExternalNetworkInput', 'currentWorkspaceHighRiskConfirmationModeInput']) {
  $(id).addEventListener('change', () => {
    if (id === 'currentWorkspaceEditInput' || id === 'currentWorkspaceCommandInput') syncWorkspacePermissionChecks(id);
    const service = currentWorkspaceService();
    const profile = workspaceProfile(editingWorkspaceName || service?.workspace || '') || {};
    const mode = $('currentWorkspaceHighRiskConfirmationModeInput').value;
    const selectedTier = $('currentWorkspaceCommandInput').checked
      ? 'full'
      : $('currentWorkspaceEditInput').checked ? 'standard' : 'readonly';
    renderWorkspaceSecuritySummary({ ...service, toolTier: selectedTier }, {
      ...profile,
      allowExternalNetwork: $('currentWorkspaceExternalNetworkInput').checked,
      requireHighRiskConfirmation: mode !== 'none',
      highRiskConfirmationMode: mode,
    });
  });
}
$('generateWorkspaceTokenButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast(t('workspace.openSettingsFirst'));
  const alreadySaved = state?.workspaceTokenWorkspaces?.includes(workspaceName) === true;
  if (alreadySaved && !confirm(t('workspace.tokenRegenerateConfirm'))) return;
  const button = $('generateWorkspaceTokenButton');
  button.disabled = true;
  try {
    await window.desktop.generateWorkspaceToken(workspaceName);
    $('currentWorkspaceTokenInput').value = '';
    $('workspaceTokenSavedHint').textContent = t('security.saved');
    $('copyWorkspaceTokenButton').disabled = false;
    button.textContent = t('workspace.tokenRegenerateButton');
    toast(alreadySaved ? t('workspace.tokenRegenerated') : t('workspace.tokenGenerated'));
    render(await window.desktop.getState());
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    button.disabled = false;
  }
});
$('copyWorkspaceTokenMcpButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast('请先打开 Workspace 设置');
  try {
    await window.desktop.copyWorkspaceEndpoint(workspaceName, 'public');
    flashCopied($('copyWorkspaceTokenMcpButton'));
    toast('公网 MCP 地址已复制');
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('copyWorkspaceTokenButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast('请先打开 Workspace 设置');
  try {
    const result = await window.desktop.copyWorkspaceAuth(workspaceName);
    if (result?.mode !== 'token') throw new Error('当前 Workspace 不是 Bearer Token 认证');
    flashCopied($('copyWorkspaceTokenButton'));
    toast('Bearer Token 已复制');
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('copyWorkspaceOauthMcpButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast('请先打开 Workspace 设置');
  try {
    await window.desktop.copyWorkspaceEndpoint(workspaceName, 'public');
    flashCopied($('copyWorkspaceOauthMcpButton'));
    toast('公网 MCP 地址已复制');
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('copyWorkspaceOauthSecretButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast('请先打开 Workspace 设置');
  try {
    await window.desktop.copyWorkspaceAuth(workspaceName);
    flashCopied($('copyWorkspaceOauthSecretButton'));
    toast('OAuth 授权密钥已复制');
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('regenerateWorkspaceOauthSecretButton').addEventListener('click', async () => {
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast('请先打开 Workspace 设置');
  const prompt = t('workspace.oauthRegenerateConfirm');
  if (!confirm(prompt)) return;
  const button = $('regenerateWorkspaceOauthSecretButton');
  button.disabled = true;
  try {
    await window.desktop.regenerateWorkspaceOauthAuthorizationSecret(workspaceName);
    toast(t('workspace.oauthRegenerated'));
  } catch (error) {
    toast(error?.message || String(error));
  } finally {
    button.disabled = false;
  }
});
document.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') {
    if ($('workspaceSettingsModal').classList.contains('show')) closeWorkspaceSettingsModal();
  }
  if (modifier && event.key === ',') {
    event.preventDefault();
    setPage('settings');
    return;
  }
  if (modifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if ($('workspaceSettingsModal').classList.contains('show')) {
      $('saveCurrentWorkspaceButton').click();
    } else if (formDirty) {
      $('saveSettingsButton').click();
    } else {
      toast(t('workspace.noChanges'));
    }
  }
});
$('addExistingWorkspaceButton').addEventListener('click', async () => {
  const previousNames = new Set(workspaceListCache.map((item) => item.name));
  try {
    const next = await window.desktop.addExistingWorkspace();
    if (!next) return;
    render(next);
    runtimeAdmin = null;
    await loadRuntimeAdmin();
    await loadWorkspaces();
    const addedWorkspace = workspaceListCache.find((item) => !previousNames.has(item.name));
    requestHealthRefresh(HEALTH_SETTLE_MS);
    toast(t('workspace.added'));
    if (!addedWorkspace) return;

    const enablePublic = confirm(t('workspace.enablePublicConfirm', { name: addedWorkspace.name }));
    if (!enablePublic) return;
    if (state.settings.publicAccessProvider !== 'trycloudflare' && !state.settings.tunnelBaseDomain) {
      toast(t('workspace.publicHostFirst'));
      await openWorkspaceSettingsModal(addedWorkspace);
      return;
    }

    const currentService = currentWorkspaceService(addedWorkspace.name);
    const result = await window.desktop.saveWorkspaceSettings(addedWorkspace.name, {
      enabled: true,
      publicEnabled: true,
      publicPath: currentService?.publicPath || addedWorkspace.name,
      publicAuthMode: 'oauth',
      toolTier: currentService?.toolTier || 'full',
    }, {});
    render(result.state);
    runtimeAdmin = result.runtimeAdmin;
    renderRuntimeAdmin(runtimeAdmin);
    await loadWorkspaces();
    requestHealthRefresh(HEALTH_SETTLE_MS);
    await openWorkspaceSettingsModal(addedWorkspace);

    const publicUrl = workspacePublicUrl(currentWorkspaceService(addedWorkspace.name));
    if (!publicUrl) {
      toast(t('workspace.publicEnabledStartClient'));
      return;
    }
    const copyNow = confirm(t('workspace.copyPublicConfirm', { name: addedWorkspace.name }));
    if (copyNow) {
      await window.desktop.copyWorkspaceEndpoint(addedWorkspace.name, 'public');
      toast(t('workspace.publicCopied'));
    }
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('generateTokenButton').addEventListener('click', async () => {
  const token = await window.desktop.generateToken();
  $('tokenInput').value = token;
  toast('已生成并安全保存 Token');
});
$('authModeInput').addEventListener('change', () => {
  setFormDirty();
  $('tokenSection').style.display = $('authModeInput').value === 'token' ? 'block' : 'none';
});
$('proxyModeInput').addEventListener('change', () => {
  setFormDirty();
  $('proxyManualSettings').classList.toggle('ui-hidden', $('proxyModeInput').value !== 'manual');
  $('proxyTestStatus').textContent = '';
});
$('tunnelProxyEnabledInput').addEventListener('change', setFormDirty);
$('proxyUrlInput').addEventListener('input', () => { setFormDirty(); $('proxyTestStatus').textContent = ''; });
$('proxyBypassInput').addEventListener('input', () => { setFormDirty(); $('proxyTestStatus').textContent = ''; });
$('testProxyButton').addEventListener('click', async () => {
  const button = $('testProxyButton');
  const status = $('proxyTestStatus');
  button.disabled = true;
  status.textContent = localizedText('正在测试…');
  try {
    const result = await window.desktop.testProxy({
      proxyMode: $('proxyModeInput').value,
      proxyUrl: $('proxyUrlInput').value.trim(),
      proxyBypass: $('proxyBypassInput').value.trim(),
    });
    status.textContent = `${result.summary}${result.resolvedProxy ? ` · ${result.resolvedProxy}` : ''}`;
    status.className = `save-status ${result.ok ? 'success' : 'error'}`;
  } catch (error) {
    status.textContent = error?.message || String(error);
    status.className = 'save-status error';
  } finally {
    button.disabled = false;
  }
});
$('portInput').addEventListener('input', setFormDirty);
$('workspaceScopeInput').addEventListener('input', setFormDirty);
$('additionalServicesInput').addEventListener('input', setFormDirty);
$('tunnelBaseDomainInput').addEventListener('input', () => {
  setFormDirty();
  $('tunnelGatewayHostname').textContent = currentPublicHost() || '配置公网 Host 后显示';
  $('tunnelGatewayOrigin').textContent = `http://127.0.0.1:${state.settings.port}`;
  updateWorkspacePublicHostPrefix();
  updateWorkspaceBuiltinOauthPreview();
});
$('tunnelTokenInput').addEventListener('input', setFormDirty);
$('frpTokenInput').addEventListener('input', setFormDirty);
$('frpServerAddrInput').addEventListener('input', setFormDirty);
$('frpServerPortInput').addEventListener('input', setFormDirty);
$('cloudflareTransportProtocolInput').addEventListener('change', setFormDirty);
$('cloudflareEdgeIpVersionInput').addEventListener('change', setFormDirty);
$('frpTransportProtocolInput').addEventListener('change', setFormDirty);
$('frpUseCompressionInput').addEventListener('change', setFormDirty);
$('frpSubdomainInput').addEventListener('input', () => {
  setFormDirty();
  $('tunnelGatewayHostname').textContent = currentPublicHost() || '配置公网 Host 后显示';
  updateWorkspacePublicHostPrefix();
  updateWorkspaceBuiltinOauthPreview();
});
$('publicClientPathInput').addEventListener('input', setFormDirty);
$('publicClientVersionInput').addEventListener('input', () => {
  setFormDirty();
  updatePublicProviderFields();
});
$('publicClientVersionModeInput').addEventListener('change', () => {
  setFormDirty();
  updatePublicProviderFields();
});
$('publicAccessProviderInput').addEventListener('change', () => {
  setFormDirty();
  $('tunnelGatewayHostname').textContent = currentPublicHost() || '配置公网 Host 后显示';
  updateWorkspacePublicHostPrefix();
  updateWorkspaceBuiltinOauthPreview();
});
$('publicClientModeInput').addEventListener('change', setFormDirty);
$('uiLanguageInput').addEventListener('change', () => {
  setFormDirty();
  applyUiLanguage($('uiLanguageInput').value);
  if (state) render(state);
  if (runtimeAdmin) renderRuntimeAdmin(runtimeAdmin);
  if (workspaceListCache.length) renderWorkspaceManagement(workspaceListCache);
  updatePublicProviderFields();
  renderAppUpdate();
});
$('appearanceInput').addEventListener('change', () => {
  setFormDirty();
  applyAppearanceTheme($('appearanceInput').value);
});
$('debugModeInput').addEventListener('change', setFormDirty);
$('startTunnelWithRuntimeInput').addEventListener('change', setFormDirty);
$('launchAtLoginInput').addEventListener('change', setFormDirty);
$('minimizeToTrayInput').addEventListener('change', setFormDirty);
$('lowMemoryTrayInput').addEventListener('change', setFormDirty);
$('computerUseEnabledInput')?.addEventListener('change', () => {
  updateComputerUseControls(true);
  setFormDirty();
});
$('computerUsePublicEnabledInput')?.addEventListener('change', () => {
  updateComputerUseControls(false);
  setFormDirty();
});
$('openComputerUseSettingsButton')?.addEventListener('click', async () => {
  try {
    await window.desktop.openComputerUseSettings();
    setTimeout(() => void refreshComputerUseAvailability(), 1000);
  } catch (error) {
    toast(error?.message || String(error));
  }
});
$('checkAppUpdateButton')?.addEventListener('click', () => { void checkAppUpdate(); });
$('openAppUpdateButton')?.addEventListener('click', async () => {
  if (!appUpdateResult?.releaseUrl) return;
  try { await window.desktop.openAppUpdate(appUpdateResult.downloadUrl || appUpdateResult.releaseUrl); }
  catch (error) { toast(error?.message || String(error)); }
});
for (const id of [
  'runtimeConfigPathInput',
  'runtimeLspTimeoutInput',
  'runtimeLspCustomServersInput',
  'runtimeDefaultTimeoutInput',
  'runtimeMaxTimeoutInput',
  'runtimeMaxFileInput',
  'runtimeMaxOutputInput',
]) $(id).addEventListener('input', setFormDirty);
$('runtimeConfigCommandsInput').addEventListener('input', () => {
  setFormDirty();
  renderAllowedCommandsHint();
});
$('runtimeNetworkIsolationRequiredInput').addEventListener('change', setFormDirty);
$('runtimeLspEnabledInput').addEventListener('change', setFormDirty);
$('saveCurrentWorkspaceButton').addEventListener('click', async () => {
  if (savingWorkspaceSettings) return;
  const workspaceName = editingWorkspaceName;
  if (!workspaceName) return toast('请先打开 Workspace 设置');
  const publicEnabled = $('currentWorkspacePublicEnabledInput').checked;
  if (publicEnabled && state.settings.publicAccessProvider !== 'trycloudflare' && !state.settings.tunnelBaseDomain) {
    $('currentWorkspaceStatus').textContent = localizedText('请先在全局设置中保存公网 Host');
    return;
  }
  const publicAuthMode = $('currentWorkspacePublicAuthModeInput').value;
  if (
    publicEnabled
    && publicAuthMode === 'token'
    && !$('currentWorkspaceTokenInput').value.trim()
    && !state?.workspaceTokenWorkspaces?.includes(workspaceName)
  ) {
    $('currentWorkspaceStatus').textContent = localizedText('请先点击“生成 Token”，再保存公网配置');
    return;
  }
  $('currentWorkspaceStatus').textContent = t('workspaceSettings.saving');
  savingWorkspaceSettings = true;
  const saveButton = $('saveCurrentWorkspaceButton');
  saveButton.disabled = true;
  saveButton.classList.add('loading');
  setButtonIcon(saveButton, 'loader');
  try {
    const currentService = currentWorkspaceService(workspaceName);
    const result = await window.desktop.saveWorkspaceSettings(workspaceName, {
      enabled: currentService?.enabled !== false,
      publicEnabled,
      publicPath: $('currentWorkspacePublicPathInput').value.trim() || workspaceName,
      publicAuthMode,
      toolTier: $('currentWorkspaceCommandInput').checked ? 'full' : $('currentWorkspaceEditInput').checked ? 'standard' : 'readonly',
      apiToken: $('currentWorkspaceTokenInput').value.trim(),
    }, {
      name: $('currentWorkspaceProfileNameInput').value.trim() || `${workspaceName} Runtime`,
      runtimePath: $('currentWorkspaceRuntimePathInput').value.trim() || null,
      allowedCommands: $('currentWorkspaceCommandsInput').value.trim()
        ? $('currentWorkspaceCommandsInput').value.split(',').map((x) => x.trim()).filter(Boolean)
        : null,
      allowExternalNetwork: $('currentWorkspaceExternalNetworkInput').checked,
      requireHighRiskConfirmation: $('currentWorkspaceHighRiskConfirmationModeInput').value !== 'none',
      highRiskConfirmationMode: $('currentWorkspaceHighRiskConfirmationModeInput').value,
      defaultCommandTimeoutMs: nullableNumber('currentWorkspaceDefaultTimeoutInput'),
      maxCommandTimeoutMs: nullableNumber('currentWorkspaceMaxTimeoutInput'),
      maxCommandOutputBytes: nullableNumber('currentWorkspaceMaxOutputInput'),
    });
    render(result.state);
    runtimeAdmin = result.runtimeAdmin;
    renderRuntimeAdmin(runtimeAdmin);
    renderWorkspaceConnectionCard();
    updateWorkspaceBuiltinOauthPreview();
    $('currentWorkspaceStatus').textContent = t('workspaceSettings.saved');
    toast(t('workspaceSettings.savedToast'));
    await loadWorkspaces();
    requestHealthRefresh(HEALTH_SETTLE_MS);
  } catch (error) {
    $('currentWorkspaceStatus').textContent = error?.message || String(error);
  } finally {
    savingWorkspaceSettings = false;
    saveButton.disabled = false;
    saveButton.classList.remove('loading');
    setButtonIcon(saveButton, 'save');
  }
});
$('resetRuntimeSettingsButton').addEventListener('click', async () => {
  if (!confirm(t('runtime.restoreConfirm'))) return;
  try {
    renderRuntimeAdmin(await window.desktop.resetRuntimeSettings());
    toast('Runtime 配置已恢复');
  } catch (error) { toast(error?.message || String(error)); }
});
$('resetAllowedCommandsButton').addEventListener('click', () => {
  const defaults = runtimeAdmin?.defaultAllowedCommands || [];
  if (!defaults.length) return toast(t('runtime.commandsNotLoaded'));
  $('runtimeConfigCommandsInput').value = defaults.join(',');
  setFormDirty();
  renderAllowedCommandsHint();
  toast(t('runtime.commandsRestored', { count: defaults.length }));
});
$('saveSettingsButton').addEventListener('click', async () => {
  if (savingSettings) return;
  const runtimePath = $('runtimeConfigPathInput').value.trim();
  const defaultTimeout = Number($('runtimeDefaultTimeoutInput').value);
  const maxTimeout = Number($('runtimeMaxTimeoutInput').value);
  const lspTimeout = Number($('runtimeLspTimeoutInput').value);
  if (!runtimePath) return toast('Runtime PATH 不能为空');
  if (!Number.isFinite(defaultTimeout) || !Number.isFinite(maxTimeout) || defaultTimeout <= 0 || maxTimeout <= 0) return toast('Runtime 超时必须是大于 0 的数字');
  if (!Number.isFinite(lspTimeout) || lspTimeout < 250) return toast('LSP 请求超时不能小于 250 ms');
  try { const custom = JSON.parse($('runtimeLspCustomServersInput').value || '[]'); if (!Array.isArray(custom)) throw new Error(); } catch { return toast(t('runtime.customLspJsonError')); }
  if (defaultTimeout > maxTimeout) return toast('默认命令超时不能大于最大命令超时');
  savingSettings = true;
  $('saveSettingsButton').disabled = true;
  setButtonIcon($('saveSettingsButton'), 'loader');
  $('saveSettingsButton').classList.add('loading');
  setSaveStatus('正在保存并应用…');
  $('runtimeSettingsStatus').textContent = localizedText('正在保存…');
  try {
    const result = await window.desktop.saveAllSettings(collectSettings(), {
      runtimePath,
      allowedCommands: $('runtimeConfigCommandsInput').value.split(',').map((x) => x.trim()).filter(Boolean),
      allowExternalNetwork: runtimeAdmin?.runtime?.allowExternalNetwork ?? false,
      requireHighRiskConfirmation: runtimeAdmin?.runtime?.requireHighRiskConfirmation ?? true,
      highRiskConfirmationMode: runtimeAdmin?.runtime?.highRiskConfirmationMode === 'none' ? 'none' : 'local',
      networkIsolationRequired: $('runtimeNetworkIsolationRequiredInput').checked,
      lspEnabled: $('runtimeLspEnabledInput').checked,
      lspRequestTimeoutMs: lspTimeout,
      lspCustomServers: $('runtimeLspCustomServersInput').value.trim() || '[]',
      defaultCommandTimeoutMs: defaultTimeout,
      maxCommandTimeoutMs: maxTimeout,
      maxFileBytes: Number($('runtimeMaxFileInput').value),
      maxCommandOutputBytes: Number($('runtimeMaxOutputInput').value),
    });
    $('tokenInput').value = '';
    $('tunnelTokenInput').value = '';
    $('frpTokenInput').value = '';
    formDirty = false;
    render(result.state);
    renderRuntimeAdmin(result.runtimeAdmin);
    $('runtimeSettingsStatus').textContent = localizedText('已保存');
    await loadWorkspaces();
    requestHealthRefresh(HEALTH_SETTLE_MS);
    if (result.warning) {
      setSaveStatus(result.warning, 'error');
      toast(result.warning);
    } else {
      setSaveStatus('已保存并应用', 'success');
      toast('全部设置已保存');
    }
  } catch (error) {
    const message = error?.message || String(error);
    setSaveStatus(message, 'error');
    $('runtimeSettingsStatus').textContent = message;
    toast(`保存失败：${message}`);
  } finally {
    savingSettings = false;
    $('saveSettingsButton').disabled = false;
    $('saveSettingsButton').classList.remove('loading');
    setButtonIcon($('saveSettingsButton'), 'save');
  }
});
$('managedLspList')?.addEventListener('click', async (event) => {
  const openButton = event.target.closest('[data-open-lsp-language]');
  if (openButton) {
    try { await window.desktop.openManagedLsp(openButton.dataset.openLspLanguage); } catch (error) { toast(error?.message || String(error)); }
    return;
  }
  const button = event.target.closest('[data-lsp-language]');
  const languageId = button?.dataset.lspLanguage;
  const currentProgress = languageId ? managedLspProgressByLanguage[languageId] : null;
  if (!languageId || currentProgress?.phase === 'checking' || currentProgress?.phase === 'installing') return;
  managedLspProgress = { language: languageId, phase: 'installing', message: t('lsp.installing') };
  managedLspProgressByLanguage[languageId] = managedLspProgress;
  renderRuntimeAdmin(runtimeAdmin);
  try {
    const result = await window.desktop.installManagedLsp(languageId);
    state = result ? { ...state, managedLsp: result } : state;
    managedLspProgress = { language: languageId, phase: 'complete', message: '已完成，Runtime 已重新加载' };
    managedLspProgressByLanguage[languageId] = managedLspProgress;
    renderRuntimeAdmin(runtimeAdmin);
  } catch (error) {
    managedLspProgress = { language: languageId, phase: 'error', message: t('lsp.installFailed', { error: error?.message || String(error) }) };
    managedLspProgressByLanguage[languageId] = managedLspProgress;
    renderRuntimeAdmin(runtimeAdmin);
  }
});

window.desktop.onState(render);
window.addEventListener('languagechange', () => {
  const mode = formDirty && $('uiLanguageInput')?.value
    ? $('uiLanguageInput').value
    : (state?.settings?.uiLanguage || 'system');
  if (mode !== 'system') return;
  applyUiLanguage('system');
  if (state) render(state);
  if (runtimeAdmin) renderRuntimeAdmin(runtimeAdmin);
  if (workspaceListCache.length) renderWorkspaceManagement(workspaceListCache);
  renderAppUpdate();
});
window.desktop.onLog((line) => {
  if (!state) return;
  const nextLogs = [...(state.logs || []), String(line)].slice(-300);
  state = { ...state, logs: nextLogs };
  scheduleLogRender();
});
window.desktop.onManagedClientProgress?.((progress) => {
  if (!progress || typeof progress !== 'object') return;
  if (managedClientInstallHideTimer && progress.phase !== 'complete' && progress.phase !== 'failed') {
    clearTimeout(managedClientInstallHideTimer);
    managedClientInstallHideTimer = null;
  }
  managedClientInstallProgress = progress;
  updatePublicProviderFields();
  if (progress.phase === 'complete' || progress.phase === 'failed') {
    if (managedClientInstallHideTimer) clearTimeout(managedClientInstallHideTimer);
    managedClientInstallHideTimer = setTimeout(() => {
      if (managedClientInstallProgress === progress) managedClientInstallProgress = null;
      managedClientInstallHideTimer = null;
      updatePublicProviderFields();
    }, progress.phase === 'complete' ? 1800 : 5000);
  }
});
window.desktop.onManagedLspProgress?.((progress) => {
  if (!progress || typeof progress !== 'object') return;
  managedLspProgress = progress;
  if (progress.language) managedLspProgressByLanguage[progress.language] = progress;
  if (runtimeAdmin) renderRuntimeAdmin(runtimeAdmin);
});
window.desktop.getState().then((initialState) => {
  render(initialState);
  renderAppUpdate();
  void loadRuntimeAdmin().then(() => loadWorkspaces());
  if (!healthTimer) {
    healthTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || state?.runtime.phase !== 'running' || !workspaceListCache.length) return;
      if (automaticHealthWarmupActive()) requestHealthRefresh();
      else void refreshHealthChecks({ quiet: true });
    }, HEALTH_REFRESH_INTERVAL_MS);
  }
  window.desktop.markRendererReady();
}).catch((error) => toast(error?.message || String(error)));

document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible'
    && state?.runtime.phase === 'running'
    && workspaceListCache.length
    && (automaticHealthDeferred || !lastHealthCheckedAt || Date.now() - lastHealthCheckedAt >= HEALTH_REFRESH_INTERVAL_MS)
  ) {
    automaticHealthDeferred = false;
    requestHealthRefresh(0);
  }
});

window.addEventListener('resize', () => {
  if (autoScrollResizeTimer) clearTimeout(autoScrollResizeTimer);
  autoScrollResizeTimer = setTimeout(() => {
    autoScrollResizeTimer = null;
    refreshAutoScroll();
  }, 120);
});

window.addEventListener('focus', () => {
  void refreshComputerUseAvailability();
});
