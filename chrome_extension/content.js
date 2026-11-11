// Monitor notification permission changes on the page
function initContentPermissionMonitor() {
  if (
    typeof navigator === 'undefined' ||
    !navigator.permissions ||
    typeof navigator.permissions.query !== 'function'
  ) {
    return null;
  }

  return navigator.permissions.query({ name: 'notifications' })
    .then((permissionStatus) => {
      // Helper to send message if notifications are granted on an HTTP(S) page
      function checkAndSendPermission() {
        if (permissionStatus.state === 'granted') {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            try {
              const loc = typeof window !== 'undefined' && window ? window.location : null;
              if (!loc) return;
              const protocol = String(loc.protocol || '').toLowerCase();
              if (protocol !== 'http:' && protocol !== 'https:') return;
              const hostname = loc.hostname ? String(loc.hostname).toLowerCase().replace(/\.+$/, '') : '';
              if (!hostname) return;
              const port = loc.port || (protocol === 'https:' ? '443' : '80');
              const result = chrome.runtime.sendMessage({
                action: 'notification_granted',
                domain: `${hostname}:${port}`,
                url: loc.href
              });
              if (result && typeof result.catch === 'function') {
                result.catch(() => { });
              }
            } catch (e) {
              // Ignore extension context invalidation errors
            }
          }
        }
      }

      // 1. Initial check on page load
      checkAndSendPermission();

      // 2. Event handler for permission state changes
      permissionStatus.onchange = () => {
        checkAndSendPermission();
      };

      return permissionStatus;
    })
    .catch((err) => {
      console.warn('Failed to query notification permissions:', err);
      return null;
    });
}

initContentPermissionMonitor();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initContentPermissionMonitor
  };
}
