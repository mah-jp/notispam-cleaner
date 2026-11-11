// Import shared configuration and whitelisting helpers
if (typeof importScripts === 'function') {
  importScripts('config.js');
}

// Block a specific contentSettings pattern and atomically persist the domain
async function blockPattern(pattern) {
  const domain = getDomainFromPattern(pattern);
  const cleanPattern = stripPortFromPattern(pattern);
  if (!cleanPattern) return;
  try {
    await blockAndRecordDomain(domain, pattern);
  } catch (e) {
    console.error(`Failed to block pattern ${cleanPattern}:`, e);
  }
}

// Serialization queue to prevent concurrent race conditions on storage & duplicate alerts
let guardQueue = Promise.resolve();

// Core handler for notification permissions granted events
async function processNotificationGranted(domain, url) {
  // Retrieve Guard state, Silent Guardian, Whitelist, and protocol map from storage first
  const data = await chrome.storage.local.get({
    guard_enabled: true,
    silent_guardian_enabled: false,
    user_whitelist: [],
    blocked_domains: [],
    domain_protocols: {}
  });

  syncDomainProtocols(data.domain_protocols);

  const domainFromUrl = url ? getHostAndPortFromUrl(url) : null;
  const targetDomain = domainFromUrl || normalizeDomain(domain);
  if (!targetDomain) return;

  // Exit if Guard is disabled
  if (!data.guard_enabled) return;

  // Exit if the domain is built-in trusted or user-whitelisted
  if (isDomainTrusted(targetDomain, data.user_whitelist)) return;

  const patternWithPort = getPatternWithPortForDomain(targetDomain);
  const checkUrl = getPrimaryUrlForDomain(targetDomain);
  if (!patternWithPort || !checkUrl) return;

  // Deduplicate concurrent messages from multiple tabs or skip if already blocked in Chrome
  try {
    const existing = await chrome.contentSettings.notifications.get({ primaryUrl: checkUrl });
    if (existing && existing.setting === 'block') {
      return;
    }
  } catch (e) { }

  // If Silent Guardian Mode is active, block silently and atomically increment badge count
  if (data.silent_guardian_enabled) {
    await blockPattern(patternWithPort);
    await updateActiveTabIcons();
    const newCount = await incrementBlockedCount();

    // Set red badge with the number of quietly blocked sites
    try {
      await chrome.action.setBadgeText({ text: String(newCount) });
      await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    } catch (e) { }
    return;
  }

  // Otherwise, block the site immediately, update active tab icon, and raise a desktop notification.
  await blockPattern(patternWithPort);
  await updateActiveTabIcons();

  const notificationId = `guard-alert:${Date.now()}:${encodeURIComponent(patternWithPort)}`;

  const title = chrome.i18n.getMessage('guardNotificationTitle') || 'NotiSpam Cleaner';
  const message = chrome.i18n.getMessage('guardNotificationMessage', targetDomain) ||
    `Automatically blocked suspicious notifications from "${targetDomain}".`;
  const trustBtnText = chrome.i18n.getMessage('guardNotificationAction') || 'Trust & Allow';
  const dismissBtnText = chrome.i18n.getMessage('guardNotificationKeep') || 'Dismiss';

  try {
    await chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title,
      message,
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
      await chrome.notifications.clear(notificationId);
      if (domain) {
        await allowAndTrustDomain(domain, pattern);
      }
      await updateActiveTabIcons();
    } catch (e) {
      console.error('Failed to trust domain:', e);
    }
  }
  // Button index 1: Dismiss
  else if (buttonIndex === 1) {
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
    const details = await chrome.contentSettings.notifications.get({
      primaryUrl: tab.url
    });

    const setting = details ? details.setting : 'default';
    let iconPrefix = 'icon';

    if (setting === 'block') {
      iconPrefix = 'icon-blocked';
    } else if (setting === 'allow') {
      iconPrefix = 'icon-allowed';
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
    chrome.runtime.onMessage.addListener((message) => {
      handleRuntimeMessage(message);
    });
  }

  if (chrome.notifications && chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
      handleNotificationButtonClicked(notificationId, buttonIndex);
    });
  }

  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await updateIconForTab(tab);
      } catch (e) {
        // Tab may have been closed immediately
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
    processNotificationGranted,
    handleNotificationGranted,
    updateActiveTabIcons,
    handleRuntimeMessage,
    handleNotificationButtonClicked,
    updateIconForTab,
    registerBackgroundListeners
  };
}
