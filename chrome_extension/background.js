// Import shared configuration and whitelisting helpers
if (typeof importScripts === 'function') {
  importScripts('config.js');
}

// Function to block a specific pattern
async function blockPattern(pattern) {
  const domain = getDomainFromPattern(pattern);
  const cleanPattern = stripPortFromPattern(pattern);
  if (!cleanPattern) return;
  try {
    await chrome.contentSettings.notifications.set({
      primaryPattern: cleanPattern,
      setting: 'block'
    });
    if (domain) {
      await addBlockedDomain(domain); // Keep port in storage
      await removeWhitelistedDomain(domain);
    }
  } catch (e) {
    console.error(`Failed to block pattern ${cleanPattern}:`, e);
  }
}

// Serialization queue to prevent concurrent race conditions on storage & duplicate alerts
let guardQueue = Promise.resolve();

// Core handler for notification permissions granted events
async function processNotificationGranted(domain, url) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return;

  // Retrieve Guard state, Silent Guardian, Whitelist, and Blocked list from storage
  const data = await chrome.storage.local.get({
    guard_enabled: true,
    silent_guardian_enabled: false,
    user_whitelist: [],
    blocked_domains: [],
    domain_protocols: {},
    blocked_count: 0
  });

  syncDomainProtocols(data.domain_protocols);

  // Exit if Guard is disabled
  if (!data.guard_enabled) return;

  // Check if the domain is trusted. If yes, do nothing.
  if (isDomainTrusted(normalizedDomain, data.user_whitelist)) return;

  // Format primaryPattern from domain (which has port) or url
  let protocol = getProtocolForDomain(normalizedDomain);
  let primaryPattern = `${protocol}://${normalizedDomain}/*`;
  let checkUrl = getPrimaryUrlForDomain(normalizedDomain);
  if (url) {
    try {
      const urlObj = new URL(url);
      const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
      const cleanHost = urlObj.hostname.toLowerCase().replace(/\.+$/, '');
      rememberDomainProtocol(`${cleanHost}:${port}`, urlObj.protocol);
      primaryPattern = `${urlObj.protocol}//${cleanHost}:${port}/*`;
      checkUrl = `${urlObj.protocol}//${cleanHost}/`;
    } catch (e) { }
  }

  // Deduplicate concurrent messages from multiple tabs of the same domain if already blocked
  const storedBlocked = Array.isArray(data.blocked_domains)
    ? data.blocked_domains.map(d => normalizeDomain(d))
    : [];
  if (storedBlocked.includes(normalizedDomain) && checkUrl) {
    try {
      const existing = await chrome.contentSettings.notifications.get({ primaryUrl: checkUrl });
      if (existing && existing.setting === 'block') {
        return;
      }
    } catch (e) { }
  }

  // If Silent Guardian Mode is active, block silently and update badge count
  if (data.silent_guardian_enabled) {
    await blockPattern(primaryPattern);
    await updateActiveTabIcons();
    const newCount = (Number(data.blocked_count) || 0) + 1;
    await chrome.storage.local.set({ blocked_count: newCount });

    // Set red badge with the number of quietly blocked sites
    await chrome.action.setBadgeText({ text: String(newCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // High-visibility red
    return;
  }

  // Otherwise, block the site immediately, update active tab icon, and raise a desktop notification.
  await blockPattern(primaryPattern);
  await updateActiveTabIcons();

  const notificationId = `guard-alert:${Date.now()}:${encodeURIComponent(primaryPattern)}`;

  // Fetch localized strings
  const title = chrome.i18n.getMessage('guardNotificationTitle') || 'NotiSpam Cleaner';

  // Fetch localized string with substitution
  const message = chrome.i18n.getMessage('guardNotificationMessage', normalizedDomain) || `Automatically blocked suspicious notifications from "${normalizedDomain}".`;

  const trustBtnText = chrome.i18n.getMessage('guardNotificationAction') || 'Trust & Allow';
  const dismissBtnText = chrome.i18n.getMessage('guardNotificationKeep') || 'Dismiss';

  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: title,
      message: message,
      buttons: [
        { title: trustBtnText },
        { title: dismissBtnText }
      ],
      requireInteraction: true,
      priority: 2
    });
  } catch (err) {
    console.error('Failed to create Chrome notification:', err);
  }
}

function handleNotificationGranted(domain, url) {
  guardQueue = guardQueue
    .then(() => processNotificationGranted(domain, url))
    .catch((err) => {
      console.error('Error in handleNotificationGranted:', err);
    });
  return guardQueue;
}

// Helper to update icons for all active tabs in the current window
async function updateActiveTabIcons() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      for (const tab of tabs) {
        await updateIconForTab(tab);
      }
    }
  } catch (err) {
    console.error('Failed to update active tab icon:', err);
  }
}

// Handle incoming runtime messages
async function handleRuntimeMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.action === 'notification_granted') {
    await handleNotificationGranted(message.domain, message.url);
  } else if (message.action === 'update_active_tab_icon') {
    await updateActiveTabIcons();
  }
}

// Handle notification button clicks
async function handleNotificationButtonClicked(notificationId, buttonIndex) {
  if (!notificationId || typeof notificationId !== 'string' || !notificationId.startsWith('guard-alert:')) return;

  const parts = notificationId.split(':');
  if (parts.length < 3) return;

  let pattern = '';
  try {
    pattern = decodeURIComponent(parts.slice(2).join(':'));
  } catch (e) {
    return;
  }
  const domain = getDomainFromPattern(pattern);

  // Button index 0: Trust Site (Allow)
  if (buttonIndex === 0) {
    try {
      // 1. Clear alert notification immediately
      await chrome.notifications.clear(notificationId);

      // 2. Trust and allow domain (storage updated before contentSettings to avoid race condition)
      if (domain) {
        await allowAndTrustDomain(domain, pattern);
      }

      // 3. Update active tab icon immediately if it matches the current window
      await updateActiveTabIcons();
    } catch (e) {
      console.error('Failed to trust domain:', e);
    }
  }
  // Button index 1: Dismiss
  else if (buttonIndex === 1) {
    // Clear alert notification
    try {
      await chrome.notifications.clear(notificationId);
    } catch (e) { }
  }
}

// Function to update the extension icon dynamically based on notification settings for a tab
async function updateIconForTab(tab) {
  if (!tab || !tab.id || !tab.url) return;

  // For non-http/https pages (like chrome:// settings, empty tabs), use the default icon
  if (!tab.url.startsWith('http:') && !tab.url.startsWith('https:')) {
    try {
      await chrome.action.setIcon({
        path: {
          "16": "icons/icon-16.png",
          "48": "icons/icon-48.png",
          "128": "icons/icon-128.png"
        },
        tabId: tab.id
      });
    } catch (e) {
      // Ignore runtime errors (e.g. tab closed before call completes)
    }
    return;
  }

  try {
    // Get notification setting for this specific page URL
    const details = await chrome.contentSettings.notifications.get({
      primaryUrl: tab.url
    });

    const setting = details ? details.setting : 'default';
    let iconPrefix = 'icon'; // Default blue bell

    if (setting === 'block') {
      iconPrefix = 'icon-blocked'; // Safe/Blocked bell (green bell with slash)
    } else if (setting === 'allow') {
      iconPrefix = 'icon-allowed'; // Warning/Allowed bell (red ringing bell)
    }

    await chrome.action.setIcon({
      path: {
        "16": `icons/${iconPrefix}-16.png`,
        "48": `icons/${iconPrefix}-48.png`,
        "128": `icons/${iconPrefix}-128.png`
      },
      tabId: tab.id
    });
  } catch (err) {
    // Ignore runtime errors (e.g. tab closed/URL changed during async operation)
  }
}

// Register Chrome event listeners for the background service worker
function registerBackgroundListeners() {
  if (typeof chrome === 'undefined') return;

  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleRuntimeMessage(message);
    });
  }

  if (chrome.notifications && chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener(handleNotificationButtonClicked);
  }

  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await updateIconForTab(tab);
      } catch (err) {
        // Tab might be closed or not loaded yet
      }
    });
  }

  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' || changeInfo.url) {
        await updateIconForTab(tab);
      }
    });
  }
}

registerBackgroundListeners();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    blockPattern,
    handleNotificationGranted,
    handleRuntimeMessage,
    handleNotificationButtonClicked,
    updateIconForTab,
    updateActiveTabIcons,
    registerBackgroundListeners
  };
}
