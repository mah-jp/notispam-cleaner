const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createChromeMock } = require('./helpers/chrome_mock');
const config = require('../chrome_extension/config');

// Bind shared config functions to global scope as importScripts('config.js') does in Service Worker
Object.assign(global, config);
global.chrome = createChromeMock();

const background = require('../chrome_extension/background');

describe('background.js — Real-Time Guard, Silent Guardian, Notification Actions, and Icon Sync', () => {
  beforeEach(() => {
    config.clearKnownDomainProtocols();
    global.chrome = createChromeMock({
      tabs: [{ id: 1, url: 'https://suspicious.example/page', active: true, windowId: 1 }]
    });
    background.registerBackgroundListeners();
  });

  describe('handleNotificationGranted — Normal Guard Mode', () => {
    it('immediately blocks unverified site, records in blocked_domains, updates active tab icon, and shows alert notification', async () => {
      await background.handleNotificationGranted('Suspicious.Example:443', 'https://Suspicious.Example/page');

      // 1. Content setting set to block (port stripped)
      const setting = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://suspicious.example/'
      });
      assert.equal(setting.setting, 'block');

      // 2. Stored in blocked_domains with port and lowercase
      const storage = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(storage.blocked_domains, ['suspicious.example:443']);

      // 3. Active tab icon immediately updated to icon-blocked
      assert.ok(chrome._state.iconCalls.length > 0);
      assert.equal(chrome._state.iconCalls.at(-1).tabId, 1);
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-blocked-16.png');

      // 4. System notification created with localized message and 2 buttons
      assert.equal(chrome._state.createdNotifications.size, 1);
      const [notifId, notifOpts] = Array.from(chrome._state.createdNotifications.entries())[0];
      assert.ok(notifId.startsWith('guard-alert:'));
      assert.ok(notifOpts.message.includes('suspicious.example:443'));
      assert.equal(notifOpts.buttons.length, 2);
      assert.equal(notifOpts.requireInteraction, true);
    });

    it('does nothing when guard_enabled is false', async () => {
      await chrome.storage.local.set({ guard_enabled: false });
      await background.handleNotificationGranted('suspicious.example:443', 'https://suspicious.example/');

      const setting = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://suspicious.example/'
      });
      assert.equal(setting.setting, 'ask');
      assert.equal(chrome._state.createdNotifications.size, 0);
    });

    it('does nothing for built-in trusted domains or user whitelisted domains', async () => {
      await chrome.storage.local.set({ user_whitelist: ['my-trusted.org:443'] });

      await background.handleNotificationGranted('mail.google.com:443', 'https://mail.google.com/');
      await background.handleNotificationGranted('sub.my-trusted.org:443', 'https://sub.my-trusted.org/');

      assert.equal(chrome._state.createdNotifications.size, 0);
      const storage = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(storage.blocked_domains, []);
    });

    it('deduplicates concurrent notification_granted events for the same domain across tabs', async () => {
      await Promise.all([
        background.handleNotificationGranted('spam-concurrent.com:443', 'https://spam-concurrent.com/tab1'),
        background.handleNotificationGranted('spam-concurrent.com:443', 'https://spam-concurrent.com/tab2'),
        background.handleNotificationGranted('spam-concurrent.com:443', 'https://spam-concurrent.com/tab3')
      ]);

      // Only 1 alert notification should be created
      assert.equal(chrome._state.createdNotifications.size, 1);
      const storage = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(storage.blocked_domains, ['spam-concurrent.com:443']);
    });

    it('preserves non-standard HTTP port (:3000) across MV3 service worker cold-start when user clicks Trust & Allow', async () => {
      chrome._state.openTabs[0] = { id: 1, url: 'http://dev-app.local:3000/dashboard', active: true, windowId: 1 };
      chrome._state.setBrowserRule('http://dev-app.local:3000/*', 'allow');

      await background.handleNotificationGranted('dev-app.local:3000', 'http://dev-app.local:3000/dashboard');

      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'http://dev-app.local:3000/' })).setting,
        'block'
      );
      let storage = await chrome.storage.local.get({ blocked_domains: [], domain_protocols: {} });
      assert.deepEqual(storage.blocked_domains, ['dev-app.local:3000']);
      assert.deepEqual(storage.domain_protocols, { 'dev-app.local:3000': 'http' });

      const [notifId] = Array.from(chrome._state.createdNotifications.keys());

      // Simulate MV3 service worker termination & cold-start clearing in-memory protocol cache
      config.clearKnownDomainProtocols();

      await background.handleNotificationButtonClicked(notifId, 0);

      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'http://dev-app.local:3000/' })).setting,
        'allow'
      );
      storage = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: {} });
      assert.deepEqual(storage.blocked_domains, []);
      assert.deepEqual(storage.user_whitelist, ['dev-app.local:3000']);
      assert.deepEqual(storage.domain_protocols, { 'dev-app.local:3000': 'http' });
    });

    it('silently re-enforces block rule without firing duplicate alert or inflating blocked_count if domain is already in blocked_domains', async () => {
      // Simulate transient rule-clear window: domain is already recorded in storage blocked_domains,
      // while browser PrefProvider had 'allow' and extension rules were momentarily cleared
      chrome._state.setBrowserRule('https://already-blocked.example/*', 'allow');
      await chrome.storage.local.set({
        guard_enabled: true,
        silent_guardian_enabled: false,
        blocked_domains: ['already-blocked.example:443'],
        blocked_count: 7
      });

      await background.handleNotificationGranted('already-blocked.example:443', 'https://already-blocked.example/');
      assert.equal(chrome._state.createdNotifications.size, 0, 'Must not fire duplicate Security Alert for already-blocked domain');
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'https://already-blocked.example/' })).setting,
        'block'
      );

      // Same invariant in Silent Guardian mode (also across cross-port HTTP rule match)
      config.rememberDomainProtocol('localhost:3000', 'http');
      config.rememberDomainProtocol('localhost:8080', 'http');
      await chrome.storage.local.set({
        guard_enabled: true,
        silent_guardian_enabled: true,
        blocked_domains: ['localhost:3000'],
        blocked_count: 7
      });
      await background.handleNotificationGranted('localhost:8080', 'http://localhost:8080/');
      const storage = await chrome.storage.local.get({ blocked_count: 0 });
      assert.equal(storage.blocked_count, 7, 'Must not inflate blocked_count for already-blocked domain rule');
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'http://localhost:8080/' })).setting,
        'block'
      );
    });

    it('treats HTTPS notification grant on custom port (:3000) as a new threat even when HTTP on the same host:port is already in blocked_domains', async () => {
      // http://dual-guard.local:3000 was previously blocked
      await config.blockAndRecordDomain('dual-guard.local:3000', 'http://dual-guard.local:3000/*');
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'http://dual-guard.local:3000/' })).setting,
        'block'
      );

      // Now user visits https://dual-guard.local:3000/ and grants notifications in Normal Guard mode
      await background.handleNotificationGranted('dual-guard.local:3000', 'https://dual-guard.local:3000/push');
      assert.equal(
        chrome._state.createdNotifications.size,
        1,
        'Must raise Security Alert when HTTPS grants notifications even if HTTP on same host:port was in blocked_domains'
      );
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'https://dual-guard.local:3000/' })).setting,
        'block'
      );

      // Verify same cross-scheme distinction in Silent Guardian mode (blocked_count MUST increment)
      await config.blockAndRecordDomain('dual-silent.local:3000', 'http://dual-silent.local:3000/*');
      await chrome.storage.local.set({
        guard_enabled: true,
        silent_guardian_enabled: true,
        blocked_count: 3
      });
      await background.handleNotificationGranted('dual-silent.local:3000', 'https://dual-silent.local:3000/push');
      const state = await chrome.storage.local.get({ blocked_count: 0 });
      assert.equal(
        state.blocked_count,
        4,
        'Silent Guardian must increment blocked_count when HTTPS grants notifications on same host:port as prior HTTP block'
      );
    });
  });

  describe('handleNotificationGranted — Silent Guardian (Family Mode)', () => {
    it('blocks silently without desktop alert, increments blocked_count, and sets red badge', async () => {
      await chrome.storage.local.set({
        guard_enabled: true,
        silent_guardian_enabled: true,
        blocked_count: 2
      });

      await background.handleNotificationGranted('silent-spam.com:443', 'https://silent-spam.com/');

      // Blocked in contentSettings and storage
      const setting = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://silent-spam.com/'
      });
      assert.equal(setting.setting, 'block');

      const storage = await chrome.storage.local.get({ blocked_domains: [], blocked_count: 0 });
      assert.deepEqual(storage.blocked_domains, ['silent-spam.com:443']);
      assert.equal(storage.blocked_count, 3);

      // Badge updated to '3' and red (#ef4444), and NO desktop notification shown
      assert.equal(chrome._state.getBadgeText(), '3');
      assert.equal(chrome._state.getBadgeColor(), '#ef4444');
      assert.equal(chrome._state.createdNotifications.size, 0);
    });

    it('serializes concurrent Silent Guardian blocks for different domains without losing count updates', async () => {
      await chrome.storage.local.set({
        guard_enabled: true,
        silent_guardian_enabled: true,
        blocked_count: 0
      });

      await Promise.all([
        background.handleNotificationGranted('spam1.example:443', 'https://spam1.example/'),
        background.handleNotificationGranted('spam2.example:443', 'https://spam2.example/'),
        background.handleNotificationGranted('spam3.example:443', 'https://spam3.example/')
      ]);

      const storage = await chrome.storage.local.get({ blocked_domains: [], blocked_count: 0 });
      assert.equal(storage.blocked_count, 3);
      assert.equal(storage.blocked_domains.length, 3);
      assert.equal(chrome._state.getBadgeText(), '3');
    });
  });

  describe('handleNotificationButtonClicked — User Action on Desktop Alert', () => {
    it('button 0 (Trust & Allow) clears alert, moves domain from blocked to whitelist, sets allow, and updates icon', async () => {
      await background.handleNotificationGranted('false-positive.org:443', 'https://false-positive.org/');
      assert.equal(chrome._state.createdNotifications.size, 1);
      const [notifId] = Array.from(chrome._state.createdNotifications.keys());

      chrome._state.openTabs[0] = { id: 10, url: 'https://false-positive.org/home', active: true, windowId: 1 };

      await background.handleNotificationButtonClicked(notifId, 0);

      // Notification cleared
      assert.equal(chrome._state.createdNotifications.size, 0);

      // Storage updated: removed from blocked_domains, added to user_whitelist
      const storage = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
      assert.deepEqual(storage.blocked_domains, []);
      assert.deepEqual(storage.user_whitelist, ['false-positive.org:443']);

      // Content setting updated to 'allow'
      const setting = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://false-positive.org/'
      });
      assert.equal(setting.setting, 'allow');

      // Active tab icon updated to icon-allowed
      assert.ok(chrome._state.iconCalls.length > 0);
      const lastIcon = chrome._state.iconCalls[chrome._state.iconCalls.length - 1];
      assert.equal(lastIcon.tabId, 10);
      assert.equal(lastIcon.path['16'], 'icons/icon-allowed-16.png');
    });

    it('button 1 (Dismiss) clears alert while keeping domain blocked', async () => {
      await background.handleNotificationGranted('keep-blocked.org:443', 'https://keep-blocked.org/');
      const [notifId] = Array.from(chrome._state.createdNotifications.keys());

      await background.handleNotificationButtonClicked(notifId, 1);

      assert.equal(chrome._state.createdNotifications.size, 0);
      const setting = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://keep-blocked.org/'
      });
      assert.equal(setting.setting, 'block');
      const storage = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(storage.blocked_domains, ['keep-blocked.org:443']);
    });

    it('safely ignores unrelated or malformed notificationIds', async () => {
      await background.handleNotificationButtonClicked('other-notification:123', 0);
      await background.handleNotificationButtonClicked('guard-alert:only-two-parts', 0);
      await background.handleNotificationButtonClicked('guard-alert:123:%E0%A4%A', 0);
      await background.handleNotificationButtonClicked(null, 0);
      assert.equal(chrome._state.createdNotifications.size, 0);
    });
  });

  describe('updateIconForTab & handleRuntimeMessage', () => {
    it('sets default icon for non-http(s) URLs and state-specific icons for ask/block/allow', async () => {
      // 1. chrome:// URL -> default icon
      await background.updateIconForTab({ id: 1, url: 'chrome://extensions' });
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-16.png');

      // 2. HTTP(S) URL with default ('ask') -> default icon
      await background.updateIconForTab({ id: 2, url: 'https://normal.example/' });
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-16.png');

      // 3. Blocked URL -> icon-blocked
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://blocked.example/*',
        setting: 'block'
      });
      await background.updateIconForTab({ id: 3, url: 'https://blocked.example/' });
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-blocked-16.png');

      // 4. Allowed URL -> icon-allowed
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://allowed.example/*',
        setting: 'allow'
      });
      await background.updateIconForTab({ id: 4, url: 'https://allowed.example/' });
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-allowed-16.png');
    });

    it('handles update_active_tab_icon runtime message', async () => {
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://suspicious.example/*',
        setting: 'block'
      });
      await background.handleRuntimeMessage({ action: 'update_active_tab_icon' });

      assert.ok(chrome._state.iconCalls.length > 0);
      assert.equal(chrome._state.iconCalls.at(-1).path['48'], 'icons/icon-blocked-48.png');
    });

    it('updates tab icon via registered chrome.tabs.onActivated and chrome.tabs.onUpdated listeners', async () => {
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://suspicious.example/*',
        setting: 'allow'
      });

      // Trigger onActivated listener for tab 1
      assert.equal(chrome._state.listeners.onActivated.length, 1);
      await chrome._state.listeners.onActivated[0]({ tabId: 1 });
      assert.equal(chrome._state.iconCalls.at(-1).tabId, 1);
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-allowed-16.png');

      // Trigger onUpdated listener with status 'complete'
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://suspicious.example/*',
        setting: 'block'
      });
      assert.equal(chrome._state.listeners.onUpdated.length, 1);
      await chrome._state.listeners.onUpdated[0](1, { status: 'complete' }, { id: 1, url: 'https://suspicious.example/page' });
      assert.equal(chrome._state.iconCalls.at(-1).path['16'], 'icons/icon-blocked-16.png');

      // Loading status (not 'complete') does not trigger redundant icon update
      const prevCallCount = chrome._state.iconCalls.length;
      await chrome._state.listeners.onUpdated[0](1, { status: 'loading' }, { id: 1, url: 'https://suspicious.example/page' });
      assert.equal(chrome._state.iconCalls.length, prevCallCount);
    });

    it('updates active tabs across ALL open browser windows, syncs on onInstalled/onStartup, and guards duplicate listener registration', async () => {
      global.chrome = createChromeMock({
        tabs: [
          { id: 101, url: 'https://win1-blocked.example/', active: true, windowId: 1 },
          { id: 102, url: 'https://win1-bg.example/', active: false, windowId: 1 },
          { id: 201, url: 'https://win2-allowed.example/', active: true, windowId: 2 }
        ]
      });
      await chrome.contentSettings.notifications.set({ primaryPattern: 'https://win1-blocked.example/*', setting: 'block' });
      await chrome.contentSettings.notifications.set({ primaryPattern: 'https://win2-allowed.example/*', setting: 'allow' });

      // Calling registerBackgroundListeners multiple times on the same chrome instance must remain idempotent
      background.registerBackgroundListeners();
      background.registerBackgroundListeners();
      assert.equal(chrome._state.listeners.onMessage.length, 1);
      assert.equal(chrome._state.listeners.onInstalled.length, 1);
      assert.equal(chrome._state.listeners.onStartup.length, 1);

      await chrome._state.listeners.onStartup[0]();

      const updatedTabIds = chrome._state.iconCalls.map(c => c.tabId);
      assert.deepEqual(updatedTabIds, [101, 201], 'Active tabs in both Window 1 and Window 2 must be synced');
      assert.equal(chrome._state.iconCalls.find(c => c.tabId === 101).path['16'], 'icons/icon-blocked-16.png');
      assert.equal(chrome._state.iconCalls.find(c => c.tabId === 201).path['16'], 'icons/icon-allowed-16.png');

      // Edge-case no-ops
      await background.updateIconForTab(null);
      await background.updateIconForTab({});
      await background.handleNotificationGranted('', '');
      await background.handleRuntimeMessage(null);
    });

    it('integrates end-to-end with content.js permission grant message through onMessage and onButtonClicked', async () => {
      const { initContentPermissionMonitor } = require('../chrome_extension/content');

      // Wire chrome.runtime.sendMessage to dispatch directly to registered background onMessage listeners
      const baseSendMessage = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async (msg) => {
        await baseSendMessage(msg);
        for (const fn of chrome._state.listeners.onMessage) {
          await fn(msg, { tab: chrome._state.openTabs[0] }, () => {});
        }
      };

      const permissionStatus = { state: 'prompt', onchange: null };
      Object.defineProperty(globalThis, 'navigator', {
        value: { permissions: { query: async () => permissionStatus } },
        configurable: true,
        writable: true
      });
      global.window = {
        location: {
          hostname: 'e2e-scam.example',
          port: '8443',
          protocol: 'https:',
          href: 'https://e2e-scam.example:8443/offer'
        }
      };
      chrome._state.openTabs[0] = { id: 1, url: 'https://e2e-scam.example:8443/offer', active: true, windowId: 1 };

      await initContentPermissionMonitor();
      permissionStatus.state = 'granted';
      permissionStatus.onchange();

      // Wait for async message pipeline to settle
      await new Promise(resolve => setTimeout(resolve, 20));

      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'https://e2e-scam.example:8443/' })).setting,
        'block'
      );
      assert.equal(chrome._state.createdNotifications.size, 1);
      const [notifId] = Array.from(chrome._state.createdNotifications.keys());

      // User clicks Button 0 ("Trust & Allow") via chrome.notifications.onButtonClicked
      await chrome._state.listeners.onButtonClicked[0](notifId, 0);
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'https://e2e-scam.example:8443/' })).setting,
        'allow'
      );
    });
  });
});
