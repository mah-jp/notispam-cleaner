// Import shared configuration and whitelisting helpers
importScripts('config.js');

// Helper to extract clean domain/host from a pattern string
function getDomainFromPattern(pattern) {
  if (!pattern) return '';
  // Clean up pattern parts like [*.] or wildcards
  let clean = pattern.replace('[*.]', '');
  if (!clean.includes('://')) {
    clean = 'https://' + clean;
  }
  try {
    const url = new URL(clean);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.hostname}:${port}`;
  } catch (e) {
    let parts = clean.split('://');
    let host = parts[1] || parts[0];
    let hostPart = host.split('/')[0];
    let hostOnly = hostPart.split(':')[0];
    let port = hostPart.split(':')[1] || (clean.startsWith('http:') ? '80' : '443');
    return `${hostOnly}:${port}`;
  }
}

// Function to block a specific pattern
async function blockPattern(pattern) {
  const domain = getDomainFromPattern(pattern);
  const cleanPattern = stripPortFromPattern(pattern);
  return new Promise((resolve) => {
    try {
      chrome.contentSettings.notifications.set({
        primaryPattern: cleanPattern,
        setting: 'block'
      }, async () => {
        if (domain) {
          await addBlockedDomain(domain); // Keep port in storage
        }
        resolve();
      });
    } catch (e) {
      console.error(`Failed to block pattern ${cleanPattern}:`, e);
      resolve();
    }
  });
}

// Async handler for notification permissions granted events
async function handleNotificationGranted(domain, url) {
  if (!domain) return;

  // Retrieve Guard state, Silent Guardian, and Whitelist from storage
  const data = await chrome.storage.local.get({
    guard_enabled: true,
    silent_guardian_enabled: false,
    user_whitelist: [],
    blocked_count: 0
  });

  // Exit if Guard is disabled
  if (!data.guard_enabled) return;

  // Check if the domain is trusted. If yes, do nothing.
  if (isDomainTrusted(domain, data.user_whitelist)) return;

  // Format primaryPattern from domain (which has port) or url
  const protocol = domain.endsWith(':80') ? 'http' : 'https';
  let primaryPattern = `${protocol}://${domain}/*`;
  if (url) {
    try {
      const urlObj = new URL(url);
      const port = urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80');
      primaryPattern = `${urlObj.protocol}//${urlObj.hostname}:${port}/*`;
    } catch (e) { }
  }

  // If Silent Guardian Mode is active, block silently and update badge count
  if (data.silent_guardian_enabled) {
    await blockPattern(primaryPattern);
    const newCount = data.blocked_count + 1;
    await chrome.storage.local.set({ blocked_count: newCount });

    // Set red badge with the number of quietly blocked sites
    chrome.action.setBadgeText({ text: String(newCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // High-visibility red
    return;
  }

  // Otherwise, block the site immediately and raise a desktop notification.
  await blockPattern(primaryPattern);

  const notificationId = `guard-alert:${Date.now()}:${encodeURIComponent(primaryPattern)}`;

  // Fetch localized strings
  const title = chrome.i18n.getMessage('guardNotificationTitle') || 'NotiSpam Cleaner';

  // Fetch localized string with substitution
  const message = chrome.i18n.getMessage('guardNotificationMessage', domain) || `Automatically blocked suspicious notifications from "${domain}".`;

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

// Listen for messages from content scripts or popup UI (Fire-and-forget, no response needed)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'notification_granted') {
    handleNotificationGranted(message.domain, message.url);
  } else if (message.action === 'update_active_tab_icon') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs && tabs.length > 0) {
        await updateIconForTab(tabs[0]);
      }
    });
  }
});

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith('guard-alert:')) return;

  const parts = notificationId.split(':');
  const pattern = decodeURIComponent(parts.slice(2).join(':'));
  const domain = getDomainFromPattern(pattern);

  // Button index 0: Trust Site (Allow)
  if (buttonIndex === 0) {
    try {
      // 1. Clear alert notification immediately
      chrome.notifications.clear(notificationId);

      // 2. Remove from blocked list and add to whitelist in storage first (to avoid race condition with content script)
      await removeBlockedDomain(domain);
      const data = await chrome.storage.local.get({ user_whitelist: [] });
      if (!data.user_whitelist.includes(domain)) {
        data.user_whitelist.push(domain);
        await chrome.storage.local.set({ user_whitelist: data.user_whitelist });
      }

      // 3. Set setting to 'allow' only after storage is successfully updated (stripping port for API compatibility)
      const cleanPattern = stripPortFromPattern(pattern);

      chrome.contentSettings.notifications.set({
        primaryPattern: cleanPattern,
        setting: 'allow'
      }, () => {
        // Update active tab icon immediately if it matches the current window
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
          if (tabs && tabs.length > 0) {
            await updateIconForTab(tabs[0]);
          }
        });
      });
    } catch (e) {
      console.error('Failed to trust domain:', e);
    }
  }
  // Button index 1: Dismiss
  else if (buttonIndex === 1) {
    // Clear alert notification
    chrome.notifications.clear(notificationId);
  }
});

// Function to update the extension icon dynamically based on notification settings for a tab
async function updateIconForTab(tab) {
  if (!tab || !tab.id || !tab.url) return;

  // For non-http/https pages (like chrome:// settings, empty tabs), use the default icon
  if (!tab.url.startsWith('http:') && !tab.url.startsWith('https:')) {
    chrome.action.setIcon({
      path: {
        "16": "icons/icon-16.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png"
      },
      tabId: tab.id
    }, () => {
      // Ignore runtime errors (e.g. tab closed before callback)
      if (chrome.runtime.lastError) { }
    });
    return;
  }

  try {
    // Get notification setting for this specific page URL
    chrome.contentSettings.notifications.get({
      primaryUrl: tab.url
    }, (details) => {
      if (chrome.runtime.lastError) return;

      const setting = details ? details.setting : 'default';
      let iconPrefix = 'icon'; // Default blue bell

      if (setting === 'block') {
        iconPrefix = 'icon-blocked'; // Safe/Blocked bell (green bell with slash)
      } else if (setting === 'allow') {
        iconPrefix = 'icon-allowed'; // Warning/Allowed bell (red ringing bell)
      }

      chrome.action.setIcon({
        path: {
          "16": `icons/${iconPrefix}-16.png`,
          "48": `icons/${iconPrefix}-48.png`,
          "128": `icons/${iconPrefix}-128.png`
        },
        tabId: tab.id
      }, () => {
        if (chrome.runtime.lastError) { }
      });
    });
  } catch (err) {
    console.error('Failed to update tab icon:', err);
  }
}

// Listen to tab activation changes (when user switches tabs)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    await updateIconForTab(tab);
  } catch (err) {
    // Tab might be closed or not loaded yet
  }
});

// Listen to tab updates (when a page loads or URL changes)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    await updateIconForTab(tab);
  }
});
