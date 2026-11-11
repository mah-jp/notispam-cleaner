// Simple HTML escaping helper to prevent XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper to escape HTML and preserve string line breaks for accessibility reading
function escapeHtmlAndPreserveLineBreaks(str) {
  return escapeHtml(str).replace(/\n/g, '<br>');
}

const RTL_LOCALES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi']);
const BIDI_DIR_KEY = '@@bidi_dir';

// Detect text direction ('rtl' or 'ltr') from Chrome i18n API
function detectTextDirection() {
  if (typeof chrome !== 'undefined' && chrome.i18n) {
    if (typeof chrome.i18n.getMessage === 'function') {
      const bidiDir = chrome.i18n.getMessage(BIDI_DIR_KEY);
      if (bidiDir === 'rtl' || bidiDir === 'ltr') {
        return bidiDir;
      }
    }
    if (typeof chrome.i18n.getUILanguage === 'function') {
      const uiLang = String(chrome.i18n.getUILanguage() || '').split(/[-_]/)[0].toLowerCase();
      if (RTL_LOCALES.has(uiLang)) {
        return 'rtl';
      }
    }
  }
  return 'ltr';
}

// Localize all elements with data-i18n / data-i18n-title attributes and apply text direction
function localizeUI() {
  const dir = detectTextDirection();
  if (typeof document !== 'undefined') {
    if (document.documentElement && typeof document.documentElement.setAttribute === 'function') {
      document.documentElement.setAttribute('dir', dir);
    }
    if (document.body) {
      if (typeof document.body.setAttribute === 'function') {
        document.body.setAttribute('dir', dir);
      }
      if (document.body.classList) {
        if (dir === 'rtl') {
          document.body.classList.add('rtl');
        } else {
          document.body.classList.remove('rtl');
        }
      }
    }
  }

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const tag = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(tag);
    if (msg) {
      if (el.tagName === 'INPUT' && (el.getAttribute('type') === 'placeholder' || el.hasAttribute('placeholder'))) {
        el.placeholder = msg;
      } else if (tag === 'safeStateMsg' || msg.includes('\n')) {
        // Keep HTML line-break formatting for multi-line messages (e.g. safeStateMsg, helpDesc)
        el.innerHTML = escapeHtmlAndPreserveLineBreaks(msg);
      } else {
        el.textContent = msg;
      }
    }
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const tag = el.getAttribute('data-i18n-title');
    const msg = chrome.i18n.getMessage(tag);
    if (msg) {
      el.setAttribute('title', msg);
      el.setAttribute('aria-label', msg);
    }
  });
}

// Update list count indicators in tabs
function updateListHeaders(allowedCount, blockedCount) {
  const allowEl = document.getElementById('label-allowed');
  const blockEl = document.getElementById('label-blocked');

  const allowMsg = chrome.i18n.getMessage('allowedLabel') || 'Allowed ({count})';
  const blockMsg = chrome.i18n.getMessage('blockedLabel') || 'Blocked ({count})';

  if (allowEl) allowEl.textContent = allowMsg.replace('{count}', allowedCount);
  if (blockEl) blockEl.textContent = blockMsg.replace('{count}', blockedCount);
}

// Gather domains from Bookmarks, History, and Open Tabs
// Ordered so live Open Tabs > Most Recent History > Older History > Bookmarks when recording custom-port protocols
async function gatherDomains() {
  const domains = new Set();

  // 1. Scan Bookmarks
  try {
    const bookmarkNodes = await chrome.bookmarks.getTree();
    function traverse(nodes) {
      nodes.forEach(node => {
        if (node.url) {
          const domainAndPort = getHostAndPortFromUrl(node.url);
          if (domainAndPort) {
            domains.add(domainAndPort);
          }
        }
        if (node.children) traverse(node.children);
      });
    }
    traverse(bookmarkNodes);
  } catch (err) {
    console.error('Bookmarks scan failed:', err);
  }

  // 2. Scan History (limit to 5000 items; process oldest-to-newest so newer scheme observations win)
  try {
    const historyItems = await chrome.history.search({
      text: '',
      maxResults: 5000,
      startTime: 0
    });
    const orderedHistory = [...historyItems].reverse();
    if (orderedHistory.some(item => item && typeof item.lastVisitTime === 'number')) {
      orderedHistory.sort((a, b) => (Number(a.lastVisitTime) || 0) - (Number(b.lastVisitTime) || 0));
    }
    orderedHistory.forEach(item => {
      if (item && item.url) {
        const domainAndPort = getHostAndPortFromUrl(item.url);
        if (domainAndPort) {
          domains.add(domainAndPort);
        }
      }
    });
  } catch (err) {
    console.error('History scan failed:', err);
  }

  // 3. Scan Open Tabs (processed last so currently open tab URLs take highest protocol precedence)
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      if (tab.url) {
        const domainAndPort = getHostAndPortFromUrl(tab.url);
        if (domainAndPort) {
          domains.add(domainAndPort);
        }
      }
    });
  } catch (err) {
    console.error('Tabs scan failed:', err);
  }

  return Array.from(domains);
}

// Notify background service worker to immediately refresh active tab toolbar icons
function notifyActiveTabIconSync() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    try {
      const res = chrome.runtime.sendMessage({ action: 'update_active_tab_icon' });
      if (res && typeof res.catch === 'function') {
        res.catch(() => { });
      }
    } catch (e) { }
  }
}

// Synchronize Real-time Guard and dependent Silent Guardian toggle UI states
function syncGuardAndSilentUI(guardEnabled, silentEnabled) {
  const isGuardOn = Boolean(guardEnabled);
  const isSilentOn = isGuardOn && Boolean(silentEnabled);
  const guardToggle = document.getElementById('guard-toggle');
  const silentToggle = document.getElementById('silent-toggle');
  const silentRow = document.getElementById('silent-guardian-row');

  if (guardToggle) {
    guardToggle.checked = isGuardOn;
  }
  if (silentToggle) {
    silentToggle.checked = isSilentOn;
    silentToggle.disabled = !isGuardOn;
  }
  if (silentRow) {
    silentRow.classList.toggle('is-disabled', !isGuardOn);
    silentRow.setAttribute('aria-disabled', isGuardOn ? 'false' : 'true');
  }
  return { guardEnabled: isGuardOn, silentEnabled: isSilentOn };
}

// Check notification setting for a specific domain
async function getNotificationSetting(domain) {
  const primaryUrl = getPrimaryUrlForDomain(domain);
  if (!primaryUrl) return 'default';
  try {
    const details = await chrome.contentSettings.notifications.get({
      primaryUrl
    });
    return details ? details.setting : 'default';
  } catch (e) {
    return 'default';
  }
}

// Check the global default notification setting
async function getGlobalDefaultSetting() {
  return getGlobalNotificationDefault();
}

// Block notification permissions for a domain
async function blockDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  try {
    await blockAndRecordDomain(cleanDomain);
  } catch (e) {
    console.error(`Failed to block ${cleanDomain}:`, e);
  }
}

// Change global default setting
async function setGlobalDefault(setting) {
  try {
    await setGlobalNotificationDefault(setting);
  } catch (e) {
    console.error('Failed to set global notification setting:', e);
  }
}

// Reset notification settings for a domain to default (clears extension rules for it)
async function resetDomain(domain) {
  try {
    await resetDomainRules(domain);
  } catch (err) {
    console.error(`Failed to reset domain ${domain}:`, err);
  }
}

// Clear all blocked site rules created by the extension while preserving user whitelist and global default
async function clearAllBlockedRules() {
  try {
    await clearAllExtensionBlockRules();
  } catch (e) {
    console.error('Failed to clear rules:', e);
  } finally {
    if (currentDomain) {
      await updateCurrentSiteStatusUI(currentDomain);
    }
    await doScan();
  }
}

// Update UI state of global notification setting and health status
async function updateGlobalStatusUI(suspiciousCount = 0) {
  const globalSetting = await getGlobalDefaultSetting();
  const statusEl = document.getElementById('global-status');
  const toggleEl = document.getElementById('default-toggle');
  if (!statusEl || !toggleEl) return;

  if (globalSetting === 'block') {
    statusEl.textContent = chrome.i18n.getMessage('statusBlocked') || 'Blocked (Safe)';
    statusEl.className = 'status-value blocked';
    toggleEl.checked = false;
  } else if (globalSetting === 'ask') {
    statusEl.textContent = chrome.i18n.getMessage('statusAsk') || 'Ask (Standard)';
    statusEl.className = suspiciousCount > 0 ? 'status-value warning' : 'status-value normal';
    toggleEl.checked = true;
  } else if (globalSetting === 'allow') {
    statusEl.textContent = chrome.i18n.getMessage('statusAllowed') || 'Allow All (Dangerous)';
    statusEl.className = 'status-value allowed';
    toggleEl.checked = true;
  }
}

// Update UI state for the current active website
async function updateCurrentSiteStatusUI(domain) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return;
  const statusEl = document.getElementById('current-site-status');
  if (!statusEl) return;

  // Fetch lists and known protocols from storage before querying notification setting
  const storageData = await chrome.storage.local.get({
    user_whitelist: [],
    blocked_domains: [],
    domain_protocols: {}
  });
  syncDomainProtocols(storageData.domain_protocols);
  const [setting, globalDefault] = await Promise.all([
    getNotificationSetting(normalizedDomain),
    getGlobalDefaultSetting()
  ]);
  const userWhitelist = normalizeDomainList(storageData.user_whitelist);
  const blockedDomains = normalizeDomainList(storageData.blocked_domains);
  const isUserWhitelisted = matchesDomainRuleList(normalizedDomain, userWhitelist);
  const isAppBlocked = matchesDomainRuleList(normalizedDomain, blockedDomains);

  const resetBtn = document.getElementById('current-site-reset');
  if (resetBtn) {
    resetBtn.disabled = !(isUserWhitelisted || isAppBlocked);
  }

  if (setting === 'allow') {
    if (isDomainTrusted(normalizedDomain, userWhitelist)) {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowedTrusted') || 'Allowed (Trusted)';
      statusEl.className = 'status-value normal';
    } else if (globalDefault === 'allow') {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowed') || 'Allowed (Caution)';
      statusEl.className = 'status-value allowed';
    } else {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowedBrowser') || 'Allowed (By Browser)';
      statusEl.className = 'status-value allowed';
    }
  } else if (setting === 'block') {
    if (isAppBlocked) {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveBlockedApp') || 'Blocked (By App)';
      statusEl.className = 'status-value blocked';
    } else if (globalDefault === 'block') {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveBlocked') || 'Blocked (Safe)';
      statusEl.className = 'status-value blocked';
    } else {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveBlockedBrowser') || 'Blocked (By Browser)';
      statusEl.className = 'status-value blocked';
    }
  } else if (setting === 'ask') {
    statusEl.textContent = chrome.i18n.getMessage('statusActiveAsk') || 'Ask (Standard)';
    statusEl.className = 'status-value normal';
  } else {
    statusEl.textContent = chrome.i18n.getMessage('statusActiveDefault') || 'Browser Default';
    statusEl.className = 'status-value normal';
  }
}

// Global reference for current active website domain
let currentDomain = null;

// Global reference for current suspicious domains list (for one-click clean)
let currentSuspiciousSites = [];

// Serialization queue and timer for scanning
let scanQueue = Promise.resolve();
let delayedScanTimer = null;

function scheduleDelayedScan(delayMs = 200) {
  if (delayedScanTimer !== null) {
    clearTimeout(delayedScanTimer);
  }
  delayedScanTimer = setTimeout(() => {
    delayedScanTimer = null;
    doScan();
  }, delayMs);
}

// Core scanning implementation
async function performScan() {
  const loader = document.getElementById('scan-loader');
  const allowedList = document.getElementById('allowed-list');
  const blockedList = document.getElementById('blocked-list');
  const cleanBtn = document.getElementById('reset-all-btn');

  // Show loader, clear lists
  if (loader) loader.classList.remove('hidden');
  if (allowedList) allowedList.classList.add('hidden');
  if (blockedList) blockedList.classList.add('hidden');
  if (cleanBtn) cleanBtn.classList.add('hidden');

  updateListHeaders('...', '...');

  // Wait for any in-flight rule/storage updates before reading storage & Chrome settings
  await enqueueRuleOp(async () => { });
  await enqueueStorageOp(async () => { });

  const domains = await gatherDomains();
  const globalDefault = await getGlobalDefaultSetting();

  // Retrieve whitelist, stored blocked domains, and custom port protocols from storage
  const storageData = await chrome.storage.local.get({
    user_whitelist: [],
    blocked_domains: [],
    domain_protocols: {}
  });
  syncDomainProtocols(storageData.domain_protocols);

  const userWhitelist = normalizeDomainList(storageData.user_whitelist);
  const storedBlockedDomains = normalizeDomainList(storageData.blocked_domains);

  // Merge domains found by scanning with persisted blocked domains and whitelisted domains
  const allDomainsToCheck = normalizeDomainList([
    ...domains,
    ...storedBlockedDomains,
    ...userWhitelist
  ]);

  const suspiciousAllowed = [];
  const trustedAllowed = [];
  const blockedSites = [];
  const activeBlockedInChrome = [];
  const activeWhitelistInChrome = [];

  // Scan all domains in parallel to improve performance and prevent UI freeze
  const scanResults = await Promise.all(
    allDomainsToCheck.map(async (domain) => {
      const setting = await getNotificationSetting(domain);
      return { domain, setting };
    })
  );

  for (const { domain, setting } of scanResults) {
    if (setting === 'allow') {
      if (userWhitelist.includes(domain)) {
        activeWhitelistInChrome.push(domain);
      }
      const hasAppAllowRule = matchesDomainRuleList(domain, userWhitelist);
      if (globalDefault !== 'allow' || hasAppAllowRule) {
        if (isDomainTrusted(domain, userWhitelist)) {
          trustedAllowed.push(domain);
        } else {
          suspiciousAllowed.push(domain);
        }
      }
    } else if (setting === 'block') {
      if (storedBlockedDomains.includes(domain)) {
        activeBlockedInChrome.push(domain);
      }
      const hasAppBlockRule = matchesDomainRuleList(domain, storedBlockedDomains);
      // When globalDefault is 'block', avoid listing every history item as an individual browser block
      if (globalDefault !== 'block' || hasAppBlockRule) {
        blockedSites.push(domain);
      }
    }
  }

  // Self-healing storage sync: remove domains & stale protocols if no longer active in Chrome
  const staleBlocked = storedBlockedDomains.filter(d => !activeBlockedInChrome.includes(d));
  const staleWhitelisted = userWhitelist.filter(d => !activeWhitelistInChrome.includes(d));
  const prunedSnapshotProtocols = buildPrunedDomainProtocols(
    storageData.domain_protocols,
    activeBlockedInChrome,
    activeWhitelistInChrome
  );
  const protocolsChanged = !shallowEqualStringMap(storageData.domain_protocols, prunedSnapshotProtocols);

  if (staleBlocked.length > 0 || staleWhitelisted.length > 0 || protocolsChanged) {
    const staleBlockedSet = new Set(staleBlocked);
    const staleWhitelistedSet = new Set(staleWhitelisted);
    await enqueueStorageOp(async () => {
      const fresh = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(fresh.domain_protocols);
      const currentBlocked = normalizeDomainList(fresh.blocked_domains);
      const currentWhitelist = normalizeDomainList(fresh.user_whitelist);
      const nextBlocked = staleBlockedSet.size > 0
        ? currentBlocked.filter(d => !staleBlockedSet.has(d))
        : currentBlocked;
      const nextWhitelist = staleWhitelistedSet.size > 0
        ? currentWhitelist.filter(d => !staleWhitelistedSet.has(d))
        : currentWhitelist;
      const nextProtocols = buildPrunedDomainProtocols(
        fresh.domain_protocols,
        nextBlocked,
        nextWhitelist
      );
      const updates = {};
      if (nextBlocked.length !== currentBlocked.length) {
        updates.blocked_domains = nextBlocked;
      }
      if (nextWhitelist.length !== currentWhitelist.length) {
        updates.user_whitelist = nextWhitelist;
      }
      if (!shallowEqualStringMap(fresh.domain_protocols, nextProtocols)) {
        updates.domain_protocols = nextProtocols;
      }
      if (Object.keys(updates).length > 0) {
        await chrome.storage.local.set(updates);
      }
    });
  }

  currentSuspiciousSites = suspiciousAllowed;

  const allowedSites = [...suspiciousAllowed, ...trustedAllowed];

  // Hide loader
  if (loader) loader.classList.add('hidden');
  updateListHeaders(allowedSites.length, blockedSites.length);

  // Update Health Status
  await updateGlobalStatusUI(suspiciousAllowed.length);

  // Show/Hide Clean All button & enable/disable Reset Blocked Sites button
  if (cleanBtn) {
    if (suspiciousAllowed.length > 0) {
      cleanBtn.classList.remove('hidden');
    } else {
      cleanBtn.classList.add('hidden');
    }
  }
  const clearAllRulesBtnEl = document.getElementById('clear-all-rules-btn');
  if (clearAllRulesBtnEl) {
    clearAllRulesBtnEl.disabled = activeBlockedInChrome.length === 0;
  }

  // Determine active tab list to render
  const tabAllowedEl = document.getElementById('tab-allowed');
  const tabBlockedEl = document.getElementById('tab-blocked');
  const isAllowedTabActive = tabAllowedEl ? tabAllowedEl.classList.contains('active') : true;
  const isBlockedTabActive = tabBlockedEl ? tabBlockedEl.classList.contains('active') : false;

  if (isAllowedTabActive && allowedList) {
    allowedList.classList.remove('hidden');
  } else if (isBlockedTabActive && blockedList) {
    blockedList.classList.remove('hidden');
  }

  // Populate Lists
  if (allowedList) {
    renderList(allowedList, allowedSites, 'allowed', activeWhitelistInChrome, activeBlockedInChrome);
  }
  if (blockedList) {
    renderList(blockedList, blockedSites, 'blocked', activeWhitelistInChrome, activeBlockedInChrome);
  }

  // Trigger active tab icon update to sync popup actions
  notifyActiveTabIconSync();

  // Update current site card status if active tab domain is known
  if (currentDomain) {
    await updateCurrentSiteStatusUI(currentDomain);
  }
}

// Execute scanning and populate UI (serialized to prevent overlapping scans)
function doScan() {
  const next = scanQueue.then(() => performScan());
  scanQueue = next.catch((err) => {
    console.error('Scan failed:', err);
  });
  return next;
}

// Render list helper
function renderList(listEl, sites, type, userWhitelist = [], storedBlockedDomains = []) {
  listEl.innerHTML = '';

  if (sites.length === 0) {
    let emptyMsgTag = 'emptyStateMsg';
    let svgPath = `<circle cx="12" cy="12" r="10"></circle><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>`;

    if (type === 'allowed') {
      emptyMsgTag = 'safeStateMsg';
      svgPath = `<path d="M22 11.08V12a10 10 0 11-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>`;
    } else if (type === 'blocked') {
      emptyMsgTag = 'emptyStateBlockedMsg';
      svgPath = `<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>`;
    }

    const emptyText = chrome.i18n.getMessage(emptyMsgTag) || 'Empty';
    const isAllowed = type === 'allowed';

    listEl.innerHTML = `
      <li class="empty-state ${isAllowed ? 'safe-state' : ''}">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5">
          ${svgPath}
        </svg>
        <p>${isAllowed ? escapeHtmlAndPreserveLineBreaks(emptyText) : escapeHtml(emptyText)}</p>
      </li>
    `;
    return;
  }

  const normalizedWhitelist = normalizeDomainList(userWhitelist);
  const normalizedBlocked = normalizeDomainList(storedBlockedDomains);

  sites.forEach(domain => {
    const normalizedItemDomain = normalizeDomain(domain);
    const li = document.createElement('li');
    li.className = 'site-item';

    const blockTitle = chrome.i18n.getMessage('blockBtnTooltip') || 'Block';
    const trustTitle = chrome.i18n.getMessage('trustBtnTooltip') || 'Trust';
    const unblockTitle = chrome.i18n.getMessage('unblockBtnTooltip') || 'Unblock';

    let statusText = '';
    let statusClass = '';
    let statusTooltip = '';
    let actionButtons = '';

    if (type === 'allowed') {
      const isTrusted = isDomainTrusted(domain, normalizedWhitelist);
      if (!isTrusted) {
        statusText = '★ ' + (chrome.i18n.getMessage('labelAllowedBrowser') || 'Allowed by Browser');
        statusClass = 'site-source warning';
        statusTooltip = chrome.i18n.getMessage('tooltipAllowedBrowser') || '';
        actionButtons = `
          <button class="btn-icon-secondary trust-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(trustTitle)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </button>
          <button class="btn-icon-danger block-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(blockTitle)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        `;
      } else {
        statusText = '✔ ' + (chrome.i18n.getMessage('labelAllowedTrusted') || 'Trusted by App');
        statusClass = 'site-source trusted';
        const hasUserExtensionRule = matchesDomainRuleList(normalizedItemDomain, normalizedWhitelist);
        const resetButtonHtml = hasUserExtensionRule ? `
          <button class="btn-icon-secondary unblock-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(unblockTitle)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 2v6h6"></path>
              <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
            </svg>
          </button>` : '';
        actionButtons = `
          ${resetButtonHtml}
          <button class="btn-icon-danger block-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(blockTitle)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        `;
      }
    } else if (type === 'blocked') {
      const isAppBlocked = matchesDomainRuleList(normalizedItemDomain, normalizedBlocked);
      if (isAppBlocked) {
        statusText = '✖ ' + (chrome.i18n.getMessage('labelBlockedApp') || 'Blocked by App');
      } else {
        statusText = '✖ ' + (chrome.i18n.getMessage('labelBlockedBrowser') || 'Blocked by Browser');
      }
      statusClass = 'site-source warning';
      const unblockButtonHtml = isAppBlocked ? `
        <button class="btn-icon-danger unblock-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(unblockTitle)}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 2v6h6"></path>
            <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
          </svg>
        </button>` : '';
      actionButtons = `
        <button class="btn-icon-secondary trust-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(trustTitle)}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>
        ${unblockButtonHtml}
      `;
    }

    li.innerHTML = `
      <div class="site-info">
        <span class="site-domain" title="${escapeHtml(domain)}" data-domain="${escapeHtml(domain)}">
          ${escapeHtml(domain)}
          <svg class="external-link-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </span>
        <span class="${statusClass}" title="${escapeHtml(statusTooltip)}">
          ${escapeHtml(statusText)}
        </span>
      </div>
      <div class="item-actions">
        ${actionButtons}
      </div>
    `;

    // Bind domain settings page navigation action
    const domainEl = li.querySelector('.site-domain');
    if (domainEl) {
      domainEl.addEventListener('click', (e) => {
        const d = e.currentTarget.getAttribute('data-domain');
        chrome.tabs.create({
          url: getSiteDetailsUrl(d)
        });
      });
    }

    const disableRowButtons = () => {
      li.querySelectorAll('button').forEach(b => { b.disabled = true; });
    };

    // Bind block action
    const blockBtn = li.querySelector('.block-btn');
    if (blockBtn) {
      blockBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');
        disableRowButtons();

        li.style.transform = 'translateX(50px)';
        li.style.opacity = '0';
        li.style.transition = 'all 0.3s ease';

        await blockDomain(d);
        notifyActiveTabIconSync();
        scheduleDelayedScan(200);
      });
    }

    // Bind trust action
    const trustBtn = li.querySelector('.trust-btn');
    if (trustBtn) {
      trustBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');
        disableRowButtons();

        li.style.transform = 'scale(0.95)';
        li.style.opacity = '0.5';
        li.style.transition = 'all 0.2s ease';

        await allowAndTrustDomain(d);
        notifyActiveTabIconSync();
        scheduleDelayedScan(200);
      });
    }

    // Bind unblock action
    const unblockBtn = li.querySelector('.unblock-btn');
    if (unblockBtn) {
      unblockBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');

        // If the domain rule applies to the active open tab (including shared host/scheme across ports), show a warning before resetting
        if (currentDomain && matchesDomainRuleList(d, [currentDomain])) {
          const confirmMsg = chrome.i18n.getMessage('confirmResetActiveDomain') ||
            `This website is currently open in your browser. Resetting its notification settings in this state may cause the automatic block warning to reappear immediately. Please close the website's tab first, then perform the reset operation. Do you want to continue?`;
          if (!confirm(confirmMsg)) return;
        }

        disableRowButtons();

        li.style.transform = 'translateX(-50px)';
        li.style.opacity = '0';
        li.style.transition = 'all 0.3s ease';

        await resetDomain(d);
        notifyActiveTabIconSync();
        scheduleDelayedScan(200);
      });
    }

    listEl.appendChild(li);
  });
}

let isCleaningSuspicious = false;

// Clean all suspicious allowed sites atomically in a single batch storage update
async function cleanAllSuspicious() {
  if (isCleaningSuspicious || !currentSuspiciousSites || currentSuspiciousSites.length === 0) return;

  const confirmMsg = chrome.i18n.getMessage('confirmResetAll') || 'Revoke all suspicious permissions?';
  if (!confirm(confirmMsg)) return;

  const cleanBtn = document.getElementById('reset-all-btn');
  isCleaningSuspicious = true;
  if (cleanBtn) cleanBtn.disabled = true;
  try {
    const sitesToBlock = [...currentSuspiciousSites];
    await blockAndRecordDomains(sitesToBlock);
    await doScan();
  } catch (err) {
    console.error('Failed to clean suspicious sites:', err);
  } finally {
    isCleaningSuspicious = false;
    if (cleanBtn) cleanBtn.disabled = false;
  }
}

// Initialize Popup UI
async function initPopup() {
  // 1. Localize UI
  localizeUI();

  // Dynamic Version Tag from manifest.json
  const manifest = chrome.runtime.getManifest();
  const versionTag = document.querySelector('.version-tag');
  if (versionTag && manifest && manifest.version) {
    versionTag.textContent = `v${manifest.version}`;
  }

  // 2. Initialize UI components with storage states
  const storageData = await chrome.storage.local.get({
    guard_enabled: true,
    silent_guardian_enabled: false,
    domain_protocols: {},
    blocked_count: 0
  });
  syncDomainProtocols(storageData.domain_protocols);

  const guardToggle = document.getElementById('guard-toggle');
  const silentToggle = document.getElementById('silent-toggle');
  const syncedToggles = syncGuardAndSilentUI(
    storageData.guard_enabled,
    storageData.silent_guardian_enabled
  );
  if (!syncedToggles.guardEnabled && Boolean(storageData.silent_guardian_enabled)) {
    await enqueueStorageOp(async () => {
      await chrome.storage.local.set({ silent_guardian_enabled: false });
    });
  }

  // Background Block Log UI Bindings
  const clearLogBtn = document.getElementById('clear-log-btn');

  function updateBlockLogUI(count) {
    const rowEl = document.getElementById('block-log-row');
    const textEl = document.getElementById('block-log-text');
    if (!rowEl || !textEl) return;
    if (count > 0) {
      rowEl.classList.remove('hidden');
      const label = chrome.i18n.getMessage('backgroundBlockedLabel') || 'Quietly blocked: {count} sites';
      textEl.textContent = label.replace('{count}', count);
    } else {
      rowEl.classList.add('hidden');
    }
  }

  updateBlockLogUI(storageData.blocked_count);

  // Reset the extension icon badge count since user opened the popup to check settings
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch (e) { }

  // 3. Initialize global status UI
  await updateGlobalStatusUI();

  // 4. Query active tab and initialize current site card
  currentDomain = null;
  const currentSiteCard = document.getElementById('current-site-card');
  const currentSiteDomainEl = document.getElementById('current-site-domain');
  if (currentSiteCard) currentSiteCard.classList.add('hidden');

  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0 && activeTabs[0].url) {
      const domainAndPort = getHostAndPortFromUrl(activeTabs[0].url);
      if (domainAndPort) {
        currentDomain = domainAndPort;
        if (currentSiteCard) currentSiteCard.classList.remove('hidden');
        if (currentSiteDomainEl) {
          currentSiteDomainEl.textContent = currentDomain;
        }
        await updateCurrentSiteStatusUI(currentDomain);
      }
    }
  } catch (err) {
    console.error('Failed to query active tab:', err);
  }

  // 5. Initial Scan
  await doScan();

  // 6. Event Listeners (guard against duplicate bindings on the same document)
  if (document.body && document.body.getAttribute('data-listeners-bound') === 'true') {
    return;
  }
  if (document.body) {
    document.body.setAttribute('data-listeners-bound', 'true');
  }

  // Live-sync storage changes (Silent Guardian blocked_count and toggle states) while popup is open
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes) return;
      if (changes.guard_enabled || changes.silent_guardian_enabled) {
        const liveGuardEl = document.getElementById('guard-toggle');
        const liveSilentEl = document.getElementById('silent-toggle');
        const nextGuard = changes.guard_enabled
          ? Boolean(changes.guard_enabled.newValue)
          : (liveGuardEl ? Boolean(liveGuardEl.checked) : true);
        const nextSilent = changes.silent_guardian_enabled
          ? Boolean(changes.silent_guardian_enabled.newValue)
          : (liveSilentEl ? Boolean(liveSilentEl.checked) : false);
        syncGuardAndSilentUI(nextGuard, nextSilent);
      }
      if (changes.blocked_count) {
        const nextCount = Number(changes.blocked_count.newValue) || 0;
        updateBlockLogUI(nextCount);
        if (nextCount > 0 && chrome.action && typeof chrome.action.setBadgeText === 'function') {
          try {
            const res = chrome.action.setBadgeText({ text: '' });
            if (res && typeof res.catch === 'function') res.catch(() => { });
          } catch (e) { }
        }
      }
    });
  }

  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', async () => {
      await resetBlockedCount();
      updateBlockLogUI(0);
      try {
        await chrome.action.setBadgeText({ text: '' });
      } catch (e) { }
    });
  }

  if (currentSiteDomainEl) {
    currentSiteDomainEl.addEventListener('click', () => {
      if (!currentDomain) return;
      chrome.tabs.create({
        url: getSiteDetailsUrl(currentDomain)
      });
    });
  }

  const allowBtn = document.getElementById('current-site-allow');
  const blockBtn = document.getElementById('current-site-block');
  const resetBtn = document.getElementById('current-site-reset');

  async function runCurrentSiteAction(actionFn) {
    if (!currentDomain) return;
    if (allowBtn) allowBtn.disabled = true;
    if (blockBtn) blockBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    try {
      await actionFn(currentDomain);
      await updateCurrentSiteStatusUI(currentDomain);
      await doScan();
    } finally {
      if (allowBtn) allowBtn.disabled = false;
      if (blockBtn) blockBtn.disabled = false;
      if (currentDomain) {
        await updateCurrentSiteStatusUI(currentDomain);
      }
    }
  }

  if (allowBtn) {
    allowBtn.addEventListener('click', () => runCurrentSiteAction(allowAndTrustDomain));
  }

  if (blockBtn) {
    blockBtn.addEventListener('click', () => runCurrentSiteAction(blockDomain));
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!currentDomain) return;
      const confirmMsg = chrome.i18n.getMessage('confirmResetActiveDomain') ||
        `This website is currently open in your browser. Resetting its notification settings in this state may cause the automatic block warning to reappear immediately. Please close the website's tab first, then perform the reset operation. Do you want to continue?`;
      if (!confirm(confirmMsg)) return;
      await runCurrentSiteAction(resetDomain);
    });
  }

  const scanBtn = document.getElementById('scan-btn');
  if (scanBtn) scanBtn.addEventListener('click', doScan);

  const resetAllBtn = document.getElementById('reset-all-btn');
  if (resetAllBtn) resetAllBtn.addEventListener('click', cleanAllSuspicious);

  const clearAllRulesBtn = document.getElementById('clear-all-rules-btn');
  if (clearAllRulesBtn) {
    clearAllRulesBtn.addEventListener('click', async () => {
      const confirmMsg = chrome.i18n.getMessage('confirmClearAllRules') || 'Reset all blocked sites?';
      if (!confirm(confirmMsg)) return;
      clearAllRulesBtn.disabled = true;
      try {
        await clearAllBlockedRules();
      } finally {
        // performScan inside clearAllBlockedRules sets accurate disabled state based on activeBlockedInChrome
      }
    });
  }

  const defaultToggle = document.getElementById('default-toggle');
  if (defaultToggle) {
    defaultToggle.addEventListener('change', async (e) => {
      const isChecked = e.target.checked;
      const newSetting = isChecked ? 'ask' : 'block';
      await setGlobalDefault(newSetting);
      await doScan();
    });
  }

  if (guardToggle) {
    guardToggle.addEventListener('change', async (e) => {
      const checked = Boolean(e.target.checked);
      const nextSilent = checked && silentToggle ? Boolean(silentToggle.checked) : false;
      syncGuardAndSilentUI(checked, nextSilent);
      await enqueueStorageOp(async () => {
        const updates = { guard_enabled: checked };
        if (!checked) {
          updates.silent_guardian_enabled = false;
        }
        await chrome.storage.local.set(updates);
      });
    });
  }

  if (silentToggle) {
    silentToggle.addEventListener('change', async (e) => {
      const isGuardOn = guardToggle ? Boolean(guardToggle.checked) : true;
      if (!isGuardOn) {
        syncGuardAndSilentUI(false, false);
        await enqueueStorageOp(async () => {
          await chrome.storage.local.set({ guard_enabled: false, silent_guardian_enabled: false });
        });
        return;
      }
      const checked = Boolean(e.target.checked);
      syncGuardAndSilentUI(true, checked);
      await enqueueStorageOp(async () => {
        await chrome.storage.local.set({ silent_guardian_enabled: checked });
      });
    });
  }

  // Open browser native notifications settings page when button is clicked
  const openSettingsBtn = document.getElementById('open-settings-btn');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://settings/content/notifications' });
    });
  }

  // Tab control switching
  const tabAllowed = document.getElementById('tab-allowed');
  const tabBlocked = document.getElementById('tab-blocked');

  const listAllowed = document.getElementById('allowed-list');
  const listBlocked = document.getElementById('blocked-list');

  function switchTab(activeTab, tabs, activeList, lists) {
    tabs.forEach(t => t && t.classList.remove('active'));
    if (activeTab) activeTab.classList.add('active');

    lists.forEach(l => l && l.classList.add('hidden'));
    if (activeList) activeList.classList.remove('hidden');
  }

  if (tabAllowed && tabBlocked && listAllowed && listBlocked) {
    tabAllowed.addEventListener('click', () => {
      switchTab(tabAllowed, [tabAllowed, tabBlocked], listAllowed, [listAllowed, listBlocked]);
    });

    tabBlocked.addEventListener('click', () => {
      switchTab(tabBlocked, [tabAllowed, tabBlocked], listBlocked, [listAllowed, listBlocked]);
    });
  }

  // Help Panel Drawer Overlay Triggering
  const helpOverlay = document.getElementById('help-overlay');
  const helpBtn = document.getElementById('help-btn');
  const closeHelpBtn = document.getElementById('close-help-btn');

  if (helpBtn && helpOverlay) {
    helpBtn.addEventListener('click', () => {
      helpOverlay.classList.remove('hidden');
    });
  }

  if (closeHelpBtn && helpOverlay) {
    closeHelpBtn.addEventListener('click', () => {
      helpOverlay.classList.add('hidden');
    });
  }

  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => {
      if (e.target === helpOverlay) {
        helpOverlay.classList.add('hidden');
      }
    });

    if (typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', (e) => {
        if (e && e.key === 'Escape' && !helpOverlay.classList.contains('hidden')) {
          helpOverlay.classList.add('hidden');
        }
      });
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initPopup);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml,
    escapeHtmlAndPreserveLineBreaks,
    detectTextDirection,
    localizeUI,
    updateListHeaders,
    gatherDomains,
    notifyActiveTabIconSync,
    syncGuardAndSilentUI,
    getNotificationSetting,
    getGlobalDefaultSetting,
    blockDomain,
    setGlobalDefault,
    resetDomain,
    clearAllBlockedRules,
    updateGlobalStatusUI,
    updateCurrentSiteStatusUI,
    doScan,
    renderList,
    cleanAllSuspicious,
    initPopup,
    getCurrentDomain: () => currentDomain,
    setCurrentDomain: (d) => { currentDomain = d; },
    getCurrentSuspiciousSites: () => currentSuspiciousSites
  };
}
