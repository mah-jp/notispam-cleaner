// Monitor notification permission changes on the page
function initContentPermissionMonitor() {
  if (typeof navigator === 'undefined' || !navigator.permissions) return null;

  return navigator.permissions.query({ name: 'notifications' })
    .then((permissionStatus) => {
      // Helper to send message if notifications are granted
      function checkAndSendPermission() {
        if (permissionStatus.state === 'granted') {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            try {
              const hostname = window.location.hostname ? window.location.hostname.toLowerCase().replace(/\.+$/, '') : '';
              if (!hostname) return;
              const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
              const result = chrome.runtime.sendMessage({
                action: 'notification_granted',
                domain: `${hostname}:${port}`,
                url: window.location.href
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
