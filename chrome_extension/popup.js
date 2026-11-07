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

// Localize all elements with data-i18n attributes and apply text direction
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

// Gather domains from History, Bookmarks, and Open Tabs
async function gatherDomains() {
  const domains = new Set();

  // 1. Scan History (limit to 5000 items)
  try {
    const historyItems = await chrome.history.search({
      text: '',
      maxResults: 5000,
      startTime: 0
    });
    historyItems.forEach(item => {
      if (item.url) {
        const domainAndPort = getHostAndPortFromUrl(item.url);
        if (domainAndPort) {
          domains.add(domainAndPort);
        }
      }
    });
  } catch (err) {
    console.error('History scan failed:', err);
  }

  // 2. Scan Bookmarks
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

  // 3. Scan Open Tabs
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
  try {
    // Querying a nonexistent domain with no overrides returns default setting
    const details = await chrome.contentSettings.notifications.get({
      primaryUrl: 'https://nonexistent-dummy-domain-check-notification-default.com/'
    });
    return details ? details.setting : 'ask';
  } catch (e) {
    return 'ask';
  }
}

// Block notification permissions for a domain
async function blockDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  const primaryPattern = getPrimaryPatternForDomain(cleanDomain);
  if (!cleanDomain || !primaryPattern) return;
  try {
    await chrome.contentSettings.notifications.set({
      primaryPattern,
      setting: 'block'
    });
    await addBlockedDomain(cleanDomain);
    await removeWhitelistedDomain(cleanDomain);
  } catch (e) {
    console.error(`Failed to block ${cleanDomain}:`, e);
  }
}

// Change global default setting
async function setGlobalDefault(setting) {
  try {
    await chrome.contentSettings.notifications.set({
      primaryPattern: '<all_urls>',
      setting: setting
    });
  } catch (e) {
    console.error('Failed to set global notification setting:', e);
  }
}

// Re-apply extension rules after clearing chrome.contentSettings.notifications
async function reapplyExtensionRules(blockedDomains, whitelistedDomains, previousGlobalDefault) {
  // Restore global default if clearing extension rules altered it
  if (previousGlobalDefault) {
    const currentGlobalDefault = await getGlobalDefaultSetting();
    if (currentGlobalDefault !== previousGlobalDefault) {
      await setGlobalDefault(previousGlobalDefault);
    }
  }

  // Re-apply remaining blocks (stripping ports for API calls)
  const blockPromises = blockedDomains.map(async (d) => {
    const primaryPattern = getPrimaryPatternForDomain(d);
    if (!primaryPattern) return;
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'block'
      });
    } catch (e) {
      console.error(`Failed to re-block ${d}:`, e);
    }
  });

  // Re-apply remaining whitelisted allows (stripping ports for API calls)
  const allowPromises = whitelistedDomains.map(async (d) => {
    const primaryPattern = getPrimaryPatternForDomain(d);
    if (!primaryPattern) return;
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'allow'
      });
    } catch (e) {
      console.error(`Failed to re-allow ${d}:`, e);
    }
  });

  await Promise.all([...blockPromises, ...allowPromises]);
}

// Reset notification settings for a domain to default (clears extension rules for it)
async function resetDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;

  try {
    const previousGlobalDefault = await getGlobalDefaultSetting();

    // 1. Remove from local storage lists (serialized with other storage operations)
    let newBlocked = [];
    let newWhitelist = [];
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      newBlocked = (data.blocked_domains || []).map(d => normalizeDomain(d)).filter(d => d && d !== cleanDomain);
      newWhitelist = (data.user_whitelist || []).map(d => normalizeDomain(d)).filter(d => d && d !== cleanDomain);
      await chrome.storage.local.set({
        blocked_domains: newBlocked,
        user_whitelist: newWhitelist
      });
    });

    // 2. Clear all content settings set by this extension and re-apply remaining rules
    await chrome.contentSettings.notifications.clear({});
    await reapplyExtensionRules(newBlocked, newWhitelist, previousGlobalDefault);
  } catch (err) {
    console.error(`Failed to reset domain ${domain}:`, err);
  }
}

// Clear all blocked site rules created by the extension while preserving user whitelist and global default
async function clearAllBlockedRules() {
  try {
    const previousGlobalDefault = await getGlobalDefaultSetting();

    await chrome.contentSettings.notifications.clear({});
    let whitelist = [];
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      whitelist = (data.user_whitelist || []).map(d => normalizeDomain(d)).filter(Boolean);
      await chrome.storage.local.set({ blocked_domains: [] });
    });

    await reapplyExtensionRules([], whitelist, previousGlobalDefault);

    if (currentDomain) {
      await updateCurrentSiteStatusUI(currentDomain);
    }
    await doScan();
  } catch (e) {
    console.error('Failed to clear rules:', e);
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
    if (suspiciousCount > 0) {
      statusEl.textContent = chrome.i18n.getMessage('statusAsk') || 'Ask (Standard)';
      statusEl.className = 'status-value warning';
    } else {
      statusEl.textContent = chrome.i18n.getMessage('statusAsk') || 'Ask (Standard)';
      statusEl.className = 'status-value normal';
    }
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
  const setting = await getNotificationSetting(normalizedDomain);
  const userWhitelist = (storageData.user_whitelist || []).map(d => normalizeDomain(d)).filter(Boolean);
  const blockedDomains = (storageData.blocked_domains || []).map(d => normalizeDomain(d)).filter(Boolean);

  if (setting === 'allow') {
    if (isDomainTrusted(normalizedDomain, userWhitelist)) {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowedTrusted') || 'Allowed (Trusted)';
      statusEl.className = 'status-value normal'; // Green styling for trusted allow
    } else {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowedBrowser') || 'Allowed (By Browser)';
      statusEl.className = 'status-value allowed'; // Red styling for unverified allow
    }
  } else if (setting === 'block') {
    const isAppBlocked = blockedDomains.includes(normalizedDomain);
    if (isAppBlocked) {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveBlockedApp') || 'Blocked (By App)';
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

  // Wait for any in-flight storage updates before reading storage
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

  const userWhitelist = Array.from(new Set(
    (storageData.user_whitelist || []).map(d => normalizeDomain(d)).filter(Boolean)
  ));
  const storedBlockedDomains = Array.from(new Set(
    (storageData.blocked_domains || []).map(d => normalizeDomain(d)).filter(Boolean)
  ));

  // Merge domains found by scanning with persisted blocked domains and whitelisted domains
  // Ensure all domains are normalized to lowercase during merge
  const allDomainsToCheck = Array.from(new Set([
    ...domains.map(d => normalizeDomain(d)).filter(Boolean),
    ...storedBlockedDomains,
    ...userWhitelist
  ]));

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
      if (globalDefault !== 'allow' || userWhitelist.includes(domain)) {
        if (isDomainTrusted(domain, userWhitelist)) {
          trustedAllowed.push(domain);
        } else {
          suspiciousAllowed.push(domain);
        }
      }
    } else if (setting === 'block') {
      const isAppBlocked = storedBlockedDomains.includes(domain);
      if (isAppBlocked) {
        activeBlockedInChrome.push(domain);
      }
      // When globalDefault is 'block', avoid listing every history item as an individual browser block
      if (globalDefault !== 'block' || isAppBlocked) {
        blockedSites.push(domain);
      }
    }
  }

  // Self-healing storage sync: remove domains from blocked_domains / user_whitelist if no longer active in Chrome
  const staleBlocked = storedBlockedDomains.filter(d => !activeBlockedInChrome.includes(d));
  const staleWhitelisted = userWhitelist.filter(d => !activeWhitelistInChrome.includes(d));
  if (staleBlocked.length > 0 || staleWhitelisted.length > 0) {
    await enqueueStorageOp(async () => {
      const updates = {};
      if (staleBlocked.length > 0) updates.blocked_domains = activeBlockedInChrome;
      if (staleWhitelisted.length > 0) updates.user_whitelist = activeWhitelistInChrome;
      await chrome.storage.local.set(updates);
    });
  }

  currentSuspiciousSites = suspiciousAllowed;

  const allowedSites = [...suspiciousAllowed, ...trustedAllowed];

  // Hide loader
  if (loader) loader.classList.add('hidden');
  updateListHeaders(allowedSites.length, blockedSites.length);

  // Update Health Status
  await updateGlobalStatusUI(suspiciousAllowed.length);

  // Show/Hide Clean All button
  if (cleanBtn && suspiciousAllowed.length > 0) {
    cleanBtn.classList.remove('hidden');
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
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
    try {
      const res = chrome.runtime.sendMessage({ action: 'update_active_tab_icon' });
      if (res && typeof res.catch === 'function') {
        res.catch(() => { });
      }
    } catch (e) { }
  }

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

  sites.forEach(domain => {
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
      const isTrusted = isDomainTrusted(domain, userWhitelist);
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
        actionButtons = `
          <button class="btn-icon-secondary unblock-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(unblockTitle)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 2v6h6"></path>
              <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
            </svg>
          </button>
          <button class="btn-icon-danger block-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(blockTitle)}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        `;
      }
    } else if (type === 'blocked') {
      const isAppBlocked = storedBlockedDomains.includes(normalizeDomain(domain));
      if (isAppBlocked) {
        statusText = '✖ ' + (chrome.i18n.getMessage('labelBlockedApp') || 'Blocked by App');
      } else {
        statusText = '✖ ' + (chrome.i18n.getMessage('labelBlockedBrowser') || 'Blocked by Browser');
      }
      statusClass = 'site-source warning';
      actionButtons = `
        <button class="btn-icon-secondary trust-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(trustTitle)}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>
        <button class="btn-icon-danger unblock-btn" data-domain="${escapeHtml(domain)}" title="${escapeHtml(unblockTitle)}">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 2v6h6"></path>
            <path d="M3 13a9 9 0 1 0 3-7.7L3 8"></path>
          </svg>
        </button>
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
        scheduleDelayedScan(200);
      });
    }

    // Bind unblock action
    const unblockBtn = li.querySelector('.unblock-btn');
    if (unblockBtn) {
      unblockBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');

        // If the domain is the active open tab, show a warning before resetting
        if (currentDomain && normalizeDomain(d) === normalizeDomain(currentDomain)) {
          const confirmMsg = chrome.i18n.getMessage('confirmResetActiveDomain') ||
            `This website is currently open in your browser. Resetting its notification settings in this state may cause the automatic block warning to reappear immediately. Please close the website's tab first, then perform the reset operation. Do you want to continue?`;
          if (!confirm(confirmMsg)) return;
        }

        disableRowButtons();

        li.style.transform = 'translateX(-50px)';
        li.style.opacity = '0';
        li.style.transition = 'all 0.3s ease';

        await resetDomain(d);
        scheduleDelayedScan(200);
      });
    }

    listEl.appendChild(li);
  });
}

// Clean all suspicious allowed sites
async function cleanAllSuspicious() {
  if (!currentSuspiciousSites || currentSuspiciousSites.length === 0) return;

  const confirmMsg = chrome.i18n.getMessage('confirmResetAll') || 'Revoke all suspicious permissions?';
  if (!confirm(confirmMsg)) return;

  const sitesToBlock = [...currentSuspiciousSites];
  for (const domain of sitesToBlock) {
    await blockDomain(domain);
  }

  await doScan();
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
  if (guardToggle) guardToggle.checked = storageData.guard_enabled;

  const silentToggle = document.getElementById('silent-toggle');
  if (silentToggle) silentToggle.checked = storageData.silent_guardian_enabled;

  // Background Block Log UI Bindings
  const blockLogRow = document.getElementById('block-log-row');
  const blockLogText = document.getElementById('block-log-text');
  const clearLogBtn = document.getElementById('clear-log-btn');

  function updateBlockLogUI(count) {
    if (!blockLogRow || !blockLogText) return;
    if (count > 0) {
      blockLogRow.classList.remove('hidden');
      const label = chrome.i18n.getMessage('backgroundBlockedLabel') || 'Quietly blocked: {count} sites';
      blockLogText.textContent = label.replace('{count}', count);
    } else {
      blockLogRow.classList.add('hidden');
    }
  }

  updateBlockLogUI(storageData.blocked_count);

  // Reset the extension icon badge count since user opened the popup to check settings
  await chrome.action.setBadgeText({ text: '' });

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

  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', async () => {
      await chrome.storage.local.set({ blocked_count: 0 });
      updateBlockLogUI(0);
      await chrome.action.setBadgeText({ text: '' });
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
  if (allowBtn) {
    allowBtn.addEventListener('click', async () => {
      if (!currentDomain) return;
      await allowAndTrustDomain(currentDomain);
      await doScan();
    });
  }

  const blockBtn = document.getElementById('current-site-block');
  if (blockBtn) {
    blockBtn.addEventListener('click', async () => {
      if (!currentDomain) return;
      await blockDomain(currentDomain);
      await doScan();
    });
  }

  const resetBtn = document.getElementById('current-site-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!currentDomain) return;
      const confirmMsg = chrome.i18n.getMessage('confirmResetActiveDomain') ||
        `This website is currently open in your browser. Resetting its notification settings in this state may cause the automatic block warning to reappear immediately. Please close the website's tab first, then perform the reset operation. Do you want to continue?`;
      if (!confirm(confirmMsg)) return;
      await resetDomain(currentDomain);
      await doScan();
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
      await clearAllBlockedRules();
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
      await chrome.storage.local.set({ guard_enabled: e.target.checked });
    });
  }

  if (silentToggle) {
    silentToggle.addEventListener('change', async (e) => {
      await chrome.storage.local.set({ silent_guardian_enabled: e.target.checked });
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
    getNotificationSetting,
    getGlobalDefaultSetting,
    blockDomain,
    setGlobalDefault,
    reapplyExtensionRules,
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
