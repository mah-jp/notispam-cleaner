const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createChromeMock } = require('./helpers/chrome_mock');
const { initContentPermissionMonitor } = require('../chrome_extension/content');

describe('content.js — Real-time Notification Permission Monitor', () => {
  let permissionStatus;

  beforeEach(() => {
    global.chrome = createChromeMock();
    permissionStatus = {
      state: 'prompt',
      onchange: null
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        permissions: {
          query: async ({ name }) => {
            assert.equal(name, 'notifications');
            return permissionStatus;
          }
        }
      },
      configurable: true,
      writable: true
    });
    global.window = {
      location: {
        hostname: 'Scam-Site.Example.',
        port: '',
        protocol: 'https:',
        href: 'https://Scam-Site.Example./landing'
      }
    };
  });

  it('sends notification_granted immediately on page load if permission is already granted', async () => {
    permissionStatus.state = 'granted';
    await initContentPermissionMonitor();

    assert.equal(chrome._state.sentMessages.length, 1);
    assert.deepEqual(chrome._state.sentMessages[0], {
      action: 'notification_granted',
      domain: 'scam-site.example:443',
      url: 'https://Scam-Site.Example./landing'
    });
  });

  it('does not send message on load when state is prompt or denied, but sends when onchange transitions to granted', async () => {
    permissionStatus.state = 'prompt';
    await initContentPermissionMonitor();
    assert.equal(chrome._state.sentMessages.length, 0);

    // Transition to denied -> still no message
    permissionStatus.state = 'denied';
    permissionStatus.onchange();
    assert.equal(chrome._state.sentMessages.length, 0);

    // Transition to granted -> sends message with normalized domain and port
    global.window.location = {
      hostname: 'http-spam.test',
      port: '8080',
      protocol: 'http:',
      href: 'http://http-spam.test:8080/popup'
    };
    permissionStatus.state = 'granted';
    permissionStatus.onchange();

    assert.equal(chrome._state.sentMessages.length, 1);
    assert.deepEqual(chrome._state.sentMessages[0], {
      action: 'notification_granted',
      domain: 'http-spam.test:8080',
      url: 'http://http-spam.test:8080/popup'
    });
  });

  it('uses port 80 by default for http: protocol when window.location.port is empty', async () => {
    global.window.location = {
      hostname: 'plain-http.example',
      port: '',
      protocol: 'http:',
      href: 'http://plain-http.example/'
    };
    permissionStatus.state = 'granted';
    await initContentPermissionMonitor();

    assert.equal(chrome._state.sentMessages.length, 1);
    assert.equal(chrome._state.sentMessages[0].domain, 'plain-http.example:80');
  });

  it('brackets bare IPv6 window.location.hostname literals so background normalizeDomain accepts IPv6 origins', async () => {
    global.window.location = {
      hostname: '::1',
      port: '8080',
      protocol: 'http:',
      href: 'http://[::1]:8080/dev'
    };
    permissionStatus.state = 'granted';
    await initContentPermissionMonitor();

    assert.equal(chrome._state.sentMessages.length, 1);
    assert.deepEqual(chrome._state.sentMessages[0], {
      action: 'notification_granted',
      domain: '[::1]:8080',
      url: 'http://[::1]:8080/dev'
    });

    // Already-bracketed IPv6 hostname is also preserved without double brackets
    global.window.location = {
      hostname: '[2001:db8::1]',
      port: '',
      protocol: 'https:',
      href: 'https://[2001:db8::1]/'
    };
    await initContentPermissionMonitor();
    assert.equal(chrome._state.sentMessages[1].domain, '[2001:db8::1]:443');
  });

  it('gracefully handles missing hostname, missing navigator.permissions, or rejected sendMessage promise', async () => {
    // 1. Empty hostname (e.g. about:blank)
    global.window.location.hostname = '';
    permissionStatus.state = 'granted';
    await initContentPermissionMonitor();
    assert.equal(chrome._state.sentMessages.length, 0);

    // 2. Non-http(s) protocol with non-empty hostname (e.g. chrome://settings) is ignored
    global.window.location = {
      hostname: 'settings',
      port: '',
      protocol: 'chrome:',
      href: 'chrome://settings/content/notifications'
    };
    await initContentPermissionMonitor();
    assert.equal(chrome._state.sentMessages.length, 0);

    // 3. Rejected sendMessage promise does not cause unhandled rejection
    global.window.location = {
      hostname: 'valid.example',
      port: '',
      protocol: 'https:',
      href: 'https://valid.example/'
    };
    chrome.runtime.sendMessage = () => Promise.reject(new Error('Extension context invalidated'));
    await initContentPermissionMonitor();

    // 4. navigator.permissions without .query method or rejected .query() returns null cleanly
    Object.defineProperty(globalThis, 'navigator', {
      value: { permissions: {} },
      configurable: true,
      writable: true
    });
    assert.equal(await initContentPermissionMonitor(), null);

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        permissions: {
          query: () => Promise.reject(new Error('Permissions API blocked'))
        }
      },
      configurable: true,
      writable: true
    });
    assert.equal(await initContentPermissionMonitor(), null);

    // 5. Missing navigator.permissions
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true
    });
    const res = await initContentPermissionMonitor();
    assert.equal(res, null);
  });
});
