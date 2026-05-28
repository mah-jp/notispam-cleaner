// Monitor notification permission changes on the page
if (navigator.permissions) {
  navigator.permissions.query({ name: 'notifications' })
    .then((permissionStatus) => {
      // Helper to send message if notifications are granted
      function checkAndSendPermission() {
        if (permissionStatus.state === 'granted') {
          if (chrome.runtime && chrome.runtime.id) {
            try {
              const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
              chrome.runtime.sendMessage({
                action: 'notification_granted',
                domain: `${window.location.hostname}:${port}`,
                url: window.location.href
              });
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
    })
    .catch((err) => {
      console.warn('Failed to query notification permissions:', err);
    });
}
