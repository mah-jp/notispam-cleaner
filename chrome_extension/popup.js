// Simple HTML escaping helper to prevent XSS
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper to escape HTML and preserve string line breaks for accessibility reading
function escapeHtmlAndPreserveLineBreaks(str) {
  return escapeHtml(str).replace(/\n/g, '<br>');
}

// Localize all elements with data-i18n attributes
function localizeUI() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const tag = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(tag);
    if (msg) {
      if (el.tagName === 'INPUT' && el.getAttribute('type') === 'placeholder') {
        el.placeholder = msg;
      } else {
        // Keep HTML formatting for the reassuring safe state message
        if (tag === 'safeStateMsg') {
          el.innerHTML = escapeHtmlAndPreserveLineBreaks(msg);
        } else {
          el.textContent = msg;
        }
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

  allowEl.textContent = allowMsg.replace('{count}', allowedCount);
  blockEl.textContent = blockMsg.replace('{count}', blockedCount);
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
  const protocol = domain.endsWith(':80') ? 'http' : 'https';
  const cleanDomain = domain.split(':')[0]; // Strip port for chrome.contentSettings API compatibility
  return new Promise((resolve) => {
    try {
      chrome.contentSettings.notifications.get({
        primaryUrl: `${protocol}://${cleanDomain}/`
      }, (details) => {
        if (chrome.runtime.lastError) {
          resolve('default');
        } else {
          resolve(details ? details.setting : 'default');
        }
      });
    } catch (e) {
      resolve('default');
    }
  });
}

// Check the global default notification setting
async function getGlobalDefaultSetting() {
  return new Promise((resolve) => {
    try {
      // Querying a nonexistent domain with no overrides returns default setting
      chrome.contentSettings.notifications.get({
        primaryUrl: 'https://nonexistent-dummy-domain-check-notification-default.com/'
      }, (details) => {
        if (chrome.runtime.lastError) {
          resolve('ask');
        } else {
          resolve(details ? details.setting : 'ask');
        }
      });
    } catch (e) {
      resolve('ask');
    }
  });
}

// Block notification permissions for a domain
async function blockDomain(domain) {
  const protocol = domain.endsWith(':80') ? 'http' : 'https';
  const cleanDomain = domain.split(':')[0]; // Strip port for chrome.contentSettings API compatibility
  return new Promise((resolve) => {
    try {
      chrome.contentSettings.notifications.set({
        primaryPattern: `${protocol}://${cleanDomain}/*`,
        setting: 'block'
      }, async () => {
        await addBlockedDomain(domain);
        // Remove from user whitelist since it is blocked
        const storageData = await chrome.storage.local.get({ user_whitelist: [] });
        const userWhitelist = storageData.user_whitelist.filter(d => d !== domain);
        await chrome.storage.local.set({ user_whitelist: userWhitelist });
        resolve();
      });
    } catch (e) {
      console.error(`Failed to block ${domain}:`, e);
      resolve();
    }
  });
}

// Change global default setting
async function setGlobalDefault(setting) {
  return new Promise((resolve) => {
    try {
      chrome.contentSettings.notifications.set({
        primaryPattern: '<all_urls>',
        setting: setting
      }, () => {
        resolve();
      });
    } catch (e) {
      console.error('Failed to set global notification setting:', e);
      resolve();
    }
  });
}

// Reset notification settings for a domain to default (clears extension rules for it)
async function resetDomain(domain) {
  if (!domain) return;
  const cleanDomain = domain.toLowerCase();

  // 1. Remove from local storage lists
  const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
  const newBlocked = data.blocked_domains.filter(d => d !== cleanDomain);
  const newWhitelist = data.user_whitelist.filter(d => d !== cleanDomain);
  await chrome.storage.local.set({
    blocked_domains: newBlocked,
    user_whitelist: newWhitelist
  });

  // 2. Clear all content settings set by this extension and re-apply remaining
  return new Promise((resolve) => {
    chrome.contentSettings.notifications.clear({}, () => {
      // Re-apply remaining blocks (stripping ports for API calls)
      const blockPromises = newBlocked.map(d => {
        const protocol = d.endsWith(':80') ? 'http' : 'https';
        const cleanD = d.split(':')[0];
        return new Promise((res) => {
          try {
            chrome.contentSettings.notifications.set({
              primaryPattern: `${protocol}://${cleanD}/*`,
              setting: 'block'
            }, res);
          } catch (e) {
            console.error(`Failed to re-block ${cleanD}:`, e);
            res();
          }
        });
      });

      // Re-apply remaining whitelisted allows (stripping ports for API calls)
      const allowPromises = newWhitelist.map(d => {
        const protocol = d.endsWith(':80') ? 'http' : 'https';
        const cleanD = d.split(':')[0];
        return new Promise((res) => {
          try {
            chrome.contentSettings.notifications.set({
              primaryPattern: `${protocol}://${cleanD}/*`,
              setting: 'allow'
            }, res);
          } catch (e) {
            console.error(`Failed to re-allow ${cleanD}:`, e);
            res();
          }
        });
      });

      Promise.all([...blockPromises, ...allowPromises]).then(resolve);
    });
  });
}

// Update UI state of global notification setting and health status
async function updateGlobalStatusUI(suspiciousCount = 0) {
  const globalSetting = await getGlobalDefaultSetting();
  const statusEl = document.getElementById('global-status');
  const toggleEl = document.getElementById('default-toggle');

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
  const setting = await getNotificationSetting(domain);
  const statusEl = document.getElementById('current-site-status');

  // Fetch lists from storage to check setting sources
  const storageData = await chrome.storage.local.get({
    user_whitelist: [],
    blocked_domains: []
  });
  const userWhitelist = storageData.user_whitelist;
  const blockedDomains = storageData.blocked_domains;

  if (setting === 'allow') {
    if (isDomainTrusted(domain, userWhitelist)) {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowedTrusted') || 'Allowed (Trusted)';
      statusEl.className = 'status-value normal'; // Green styling for trusted allow
    } else {
      statusEl.textContent = chrome.i18n.getMessage('statusActiveAllowedBrowser') || 'Allowed (By Browser)';
      statusEl.className = 'status-value allowed'; // Red styling for unverified allow
    }
  } else if (setting === 'block') {
    const isAppBlocked = blockedDomains.includes(domain.toLowerCase());
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

// Execute scanning and populate UI
async function doScan() {
  const loader = document.getElementById('scan-loader');
  const allowedList = document.getElementById('allowed-list');
  const blockedList = document.getElementById('blocked-list');
  const cleanBtn = document.getElementById('reset-all-btn');

  // Show loader, clear lists
  loader.classList.remove('hidden');
  allowedList.classList.add('hidden');
  blockedList.classList.add('hidden');
  cleanBtn.classList.add('hidden');

  updateListHeaders('...', '...');

  const domains = await gatherDomains();
  const globalDefault = await getGlobalDefaultSetting();

  // Retrieve whitelist and stored blocked domains from storage
  const storageData = await chrome.storage.local.get({
    user_whitelist: [],
    blocked_domains: []
  });
  const userWhitelist = storageData.user_whitelist;
  const storedBlockedDomains = storageData.blocked_domains;

  // Merge domains found by scanning with persisted blocked domains and whitelisted domains
  const allDomainsToCheck = Array.from(new Set([...domains, ...storedBlockedDomains, ...userWhitelist]));

  const suspiciousAllowed = [];
  const trustedAllowed = [];
  const blockedSites = [];
  const activeBlockedInChrome = [];

  for (const domain of allDomainsToCheck) {
    const setting = await getNotificationSetting(domain);
    if (setting === 'allow') {
      if (globalDefault !== 'allow') {
        if (isDomainTrusted(domain, userWhitelist)) {
          trustedAllowed.push(domain);
        } else {
          suspiciousAllowed.push(domain);
        }
      }
    } else if (setting === 'block') {
      blockedSites.push(domain);
      if (storedBlockedDomains.includes(domain)) {
        activeBlockedInChrome.push(domain);
      }
    }
  }

  // Self-healing storage sync: remove domains from blocked_domains if no longer blocked in Chrome
  const staleBlocked = storedBlockedDomains.filter(d => !activeBlockedInChrome.includes(d));
  if (staleBlocked.length > 0) {
    const updatedBlocked = storedBlockedDomains.filter(d => activeBlockedInChrome.includes(d));
    await chrome.storage.local.set({ blocked_domains: updatedBlocked });
  }

  currentSuspiciousSites = suspiciousAllowed;

  const allowedSites = [...suspiciousAllowed, ...trustedAllowed];

  // Hide loader
  loader.classList.add('hidden');
  updateListHeaders(allowedSites.length, blockedSites.length);

  // Update Health Status
  await updateGlobalStatusUI(suspiciousAllowed.length);

  // Show/Hide Clean All button
  if (suspiciousAllowed.length > 0) {
    cleanBtn.classList.remove('hidden');
  }

  // Determine active tab list to render
  const isAllowedTabActive = document.getElementById('tab-allowed').classList.contains('active');
  const isBlockedTabActive = document.getElementById('tab-blocked').classList.contains('active');

  if (isAllowedTabActive) {
    allowedList.classList.remove('hidden');
  } else if (isBlockedTabActive) {
    blockedList.classList.remove('hidden');
  }

  // Populate Lists
  renderList(allowedList, allowedSites, 'allowed', userWhitelist, storedBlockedDomains);
  renderList(blockedList, blockedSites, 'blocked', userWhitelist, storedBlockedDomains);

  // Trigger active tab icon update to sync popup actions
  if (chrome.runtime && chrome.runtime.id) {
    chrome.runtime.sendMessage({ action: 'update_active_tab_icon' });
  }

  // Update current site card status if active tab domain is known
  if (currentDomain) {
    await updateCurrentSiteStatusUI(currentDomain);
  }
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
      const isAppBlocked = storedBlockedDomains.includes(domain.toLowerCase());
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
          url: `chrome://settings/content/siteDetails?site=https%3A%2F%2F${encodeURIComponent(d)}`
        });
      });
    }

    // Bind block action
    const blockBtn = li.querySelector('.block-btn');
    if (blockBtn) {
      blockBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');
        btn.disabled = true;

        li.style.transform = 'translateX(50px)';
        li.style.opacity = '0';
        li.style.transition = 'all 0.3s ease';

        setTimeout(async () => {
          await blockDomain(d);
          await doScan();
        }, 200);
      });
    }

    // Bind trust action
    const trustBtn = li.querySelector('.trust-btn');
    if (trustBtn) {
      trustBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');
        btn.disabled = true;

        li.style.transform = 'scale(0.95)';
        li.style.opacity = '0.5';
        li.style.transition = 'all 0.2s ease';

        await removeBlockedDomain(d);

        const storageData = await chrome.storage.local.get({ user_whitelist: [] });
        const userWhitelist = storageData.user_whitelist;
        if (!userWhitelist.includes(d)) {
          userWhitelist.push(d);
          await chrome.storage.local.set({ user_whitelist: userWhitelist });
        }

        await chrome.contentSettings.notifications.set({
          primaryPattern: `https://${d}/*`,
          setting: 'allow'
        });

        setTimeout(async () => {
          await doScan();
        }, 200);
      });
    }

    // Bind unblock action
    const unblockBtn = li.querySelector('.unblock-btn');
    if (unblockBtn) {
      unblockBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const d = btn.getAttribute('data-domain');

        // If the domain is the active open tab, show a warning before resetting
        if (currentDomain && d.toLowerCase() === currentDomain.toLowerCase()) {
          const confirmMsg = chrome.i18n.getMessage('confirmResetActiveDomain') ||
            `This website is currently open in your browser. Resetting its notification settings in this state may cause the automatic block warning to reappear immediately. Please close the website's tab first, then perform the reset operation. Do you want to continue?`;
          if (!confirm(confirmMsg)) return;
        }

        btn.disabled = true;

        li.style.transform = 'translateX(-50px)';
        li.style.opacity = '0';
        li.style.transition = 'all 0.3s ease';

        setTimeout(async () => {
          await resetDomain(d);
          await doScan();
        }, 200);
      });
    }

    listEl.appendChild(li);
  });
}

// Clean all suspicious allowed sites
async function cleanAllSuspicious() {
  const confirmMsg = chrome.i18n.getMessage('confirmResetAll') || 'Revoke all suspicious permissions?';
  if (!confirm(confirmMsg)) return;

  for (const domain of currentSuspiciousSites) {
    await blockDomain(domain);
  }

  await doScan();
}

// Initial Setup
document.addEventListener('DOMContentLoaded', async () => {
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
    blocked_count: 0
  });

  const guardToggle = document.getElementById('guard-toggle');
  guardToggle.checked = storageData.guard_enabled;

  const silentToggle = document.getElementById('silent-toggle');
  silentToggle.checked = storageData.silent_guardian_enabled;

  // Background Block Log UI Bindings
  const blockLogRow = document.getElementById('block-log-row');
  const blockLogText = document.getElementById('block-log-text');
  const clearLogBtn = document.getElementById('clear-log-btn');

  function updateBlockLogUI(count) {
    if (count > 0) {
      blockLogRow.classList.remove('hidden');
      const label = chrome.i18n.getMessage('backgroundBlockedLabel') || 'Quietly blocked: {count} sites';
      blockLogText.textContent = label.replace('{count}', count);
    } else {
      blockLogRow.classList.add('hidden');
    }
  }

  updateBlockLogUI(storageData.blocked_count);

  // Clear log event handler
  clearLogBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ blocked_count: 0 });
    updateBlockLogUI(0);
    chrome.action.setBadgeText({ text: '' });
  });

  // Reset the extension icon badge count since user opened the popup to check settings
  chrome.action.setBadgeText({ text: '' });

  // 3. Initialize global status UI
  await updateGlobalStatusUI();

  // 4. Query active tab and initialize current site card
  currentDomain = null;
  try {
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTabs.length > 0 && activeTabs[0].url) {
      const urlStr = activeTabs[0].url;
      if (urlStr.startsWith('http:') || urlStr.startsWith('https:')) {
        const url = new URL(urlStr);
        const port = url.port || (url.protocol === 'https:' ? '443' : '80');
        currentDomain = `${url.hostname}:${port}`;
        document.getElementById('current-site-card').classList.remove('hidden');
        const currentSiteDomainEl = document.getElementById('current-site-domain');
        currentSiteDomainEl.textContent = currentDomain;
        currentSiteDomainEl.addEventListener('click', () => {
          chrome.tabs.create({
            url: `chrome://settings/content/siteDetails?site=${encodeURIComponent(`${url.protocol}//${currentDomain}`)}`
          });
        });
        await updateCurrentSiteStatusUI(currentDomain);
      }
    }
  } catch (err) {
    console.error('Failed to query active tab:', err);
  }

  // 5. Initial Scan
  await doScan();

  // 6. Event Listeners
  if (currentDomain) {
    document.getElementById('current-site-allow').addEventListener('click', async () => {
      // 1. Remove from blocked domains and add to user whitelist in storage first (to avoid race condition)
      await removeBlockedDomain(currentDomain);
      const storageData = await chrome.storage.local.get({ user_whitelist: [] });
      const userWhitelist = storageData.user_whitelist;
      if (!userWhitelist.includes(currentDomain)) {
        userWhitelist.push(currentDomain);
        await chrome.storage.local.set({ user_whitelist: userWhitelist });
      }

      // 2. Set chrome setting to 'allow' only after storage is updated (stripping port for API call)
      const protocol = currentDomain.endsWith(':80') ? 'http' : 'https';
      const cleanCurrentDomain = currentDomain.split(':')[0];
      await chrome.contentSettings.notifications.set({
        primaryPattern: `${protocol}://${cleanCurrentDomain}/*`,
        setting: 'allow'
      });

      await updateCurrentSiteStatusUI(currentDomain);
      await doScan();
    });

    document.getElementById('current-site-block').addEventListener('click', async () => {
      const protocol = currentDomain.endsWith(':80') ? 'http' : 'https';
      const cleanCurrentDomain = currentDomain.split(':')[0];
      await chrome.contentSettings.notifications.set({
        primaryPattern: `${protocol}://${cleanCurrentDomain}/*`,
        setting: 'block'
      });
      await addBlockedDomain(currentDomain);

      // Remove from user whitelist since it is blocked
      const storageData = await chrome.storage.local.get({ user_whitelist: [] });
      const userWhitelist = storageData.user_whitelist.filter(d => d !== currentDomain);
      await chrome.storage.local.set({ user_whitelist: userWhitelist });

      await updateCurrentSiteStatusUI(currentDomain);
      await doScan();
    });

    document.getElementById('current-site-reset').addEventListener('click', async () => {
      if (currentDomain) {
        const confirmMsg = chrome.i18n.getMessage('confirmResetActiveDomain') ||
          `This website is currently open in your browser. Resetting its notification settings in this state may cause the automatic block warning to reappear immediately. Please close the website's tab first, then perform the reset operation. Do you want to continue?`;
        if (!confirm(confirmMsg)) return;
      }
      await resetDomain(currentDomain);
      await updateCurrentSiteStatusUI(currentDomain);
      await doScan();
    });
  }

  document.getElementById('scan-btn').addEventListener('click', doScan);

  document.getElementById('reset-all-btn').addEventListener('click', cleanAllSuspicious);

  document.getElementById('clear-all-rules-btn').addEventListener('click', async () => {
    const confirmMsg = chrome.i18n.getMessage('confirmClearAllRules') || 'Reset all blocked sites?';
    if (!confirm(confirmMsg)) return;

    // Clear all custom site settings (blocks and allows) set by this extension
    chrome.contentSettings.notifications.clear({}, async () => {
      await chrome.storage.local.set({ blocked_domains: [] });
      if (currentDomain) {
        await updateCurrentSiteStatusUI(currentDomain);
      }
      await doScan();
    });
  });

  document.getElementById('default-toggle').addEventListener('change', async (e) => {
    const isChecked = e.target.checked;
    const newSetting = isChecked ? 'ask' : 'block';
    await setGlobalDefault(newSetting);
    await updateGlobalStatusUI(currentSuspiciousSites.length);
  });

  guardToggle.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ guard_enabled: e.target.checked });
  });

  silentToggle.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ silent_guardian_enabled: e.target.checked });
  });

  // Open browser native notifications settings page when button is clicked
  document.getElementById('open-settings-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://settings/content/notifications' });
  });

  // Tab control switching
  const tabAllowed = document.getElementById('tab-allowed');
  const tabBlocked = document.getElementById('tab-blocked');

  const listAllowed = document.getElementById('allowed-list');
  const listBlocked = document.getElementById('blocked-list');

  function switchTab(activeTab, tabs, activeList, lists) {
    tabs.forEach(t => t.classList.remove('active'));
    activeTab.classList.add('active');

    lists.forEach(l => l.classList.add('hidden'));
    activeList.classList.remove('hidden');
  }

  tabAllowed.addEventListener('click', () => {
    switchTab(tabAllowed, [tabAllowed, tabBlocked], listAllowed, [listAllowed, listBlocked]);
  });

  tabBlocked.addEventListener('click', () => {
    switchTab(tabBlocked, [tabAllowed, tabBlocked], listBlocked, [listAllowed, listBlocked]);
  });

  // Help Panel Drawer Overlay Triggering
  const helpOverlay = document.getElementById('help-overlay');
  const helpBtn = document.getElementById('help-btn');
  const closeHelpBtn = document.getElementById('close-help-btn');

  helpBtn.addEventListener('click', () => {
    helpOverlay.classList.remove('hidden');
  });

  closeHelpBtn.addEventListener('click', () => {
    helpOverlay.classList.add('hidden');
  });

  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) {
      helpOverlay.classList.add('hidden');
    }
  });
});
