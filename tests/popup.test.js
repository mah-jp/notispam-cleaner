const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createChromeMock } = require('./helpers/chrome_mock');
const { createPopupDocument } = require('./helpers/dom_mock');
const config = require('../chrome_extension/config');

Object.assign(global, config);
global.chrome = createChromeMock();
global.document = createPopupDocument();
global.confirm = () => true;

const popup = require('../chrome_extension/popup');

describe('popup.js — UI Localization, Scanning, Classification, Self-Healing, and User Actions', () => {
  beforeEach(() => {
    config.clearKnownDomainProtocols();
    global.document = createPopupDocument();
    global.confirm = () => true;
    global.chrome = createChromeMock({
      historyItems: [
        { url: 'https://scam-alerts.xyz/verify' },
        { url: 'https://mail.google.com/mail/u/0' },
        { url: 'http://legacy-http.example/news' }
      ],
      bookmarkTree: [
        {
          id: '0',
          children: [
            { id: '1', title: 'Bookmarks Bar', children: [{ id: '2', url: 'https://bookmarked-spam.net/home' }] }
          ]
        }
      ],
      tabs: [
        { id: 1, url: 'https://active-site.io/dashboard', active: true, windowId: 1 }
      ]
    });
    popup.setCurrentDomain(null);
  });

  describe('escapeHtml, escapeHtmlAndPreserveLineBreaks, and localizeUI', () => {
    it('escapes XSS characters and preserves line breaks as <br>', () => {
      const payload = `<script>alert("xss" & '1')</script>\nLine 2`;
      const escaped = popup.escapeHtml(payload);
      assert.equal(escaped, '&lt;script&gt;alert(&quot;xss&quot; &amp; &#039;1&#039;)&lt;/script&gt;\nLine 2');

      const withBreaks = popup.escapeHtmlAndPreserveLineBreaks(payload);
      assert.equal(withBreaks, '&lt;script&gt;alert(&quot;xss&quot; &amp; &#039;1&#039;)&lt;/script&gt;<br>Line 2');
      assert.equal(popup.escapeHtml(null), '');
      assert.equal(popup.escapeHtml(undefined), '');
    });

    it('localizes all data-i18n elements and preserves line breaks in multi-line messages (helpDesc)', () => {
      popup.localizeUI();
      const titleEl = document.querySelector('[data-i18n="appTitle"]');
      assert.equal(titleEl.textContent, 'NotiSpam Cleaner');

      const helpDescEl = document.querySelector('[data-i18n="helpDesc"]');
      assert.ok(helpDescEl.innerHTML.includes('<br><br>'));
      assert.equal(document.documentElement.getAttribute('dir'), 'ltr');
      assert.equal(document.body.getAttribute('dir'), 'ltr');
      assert.equal(document.body.classList.contains('rtl'), false);
    });

    it('detects RTL locales (ar, he, fa) and applies dir="rtl" and .rtl class on document', () => {
      for (const rtlLang of ['ar', 'he', 'fa']) {
        global.chrome = createChromeMock({ uiLanguage: rtlLang });
        popup.localizeUI();
        assert.equal(popup.detectTextDirection(), 'rtl');
        assert.equal(document.documentElement.getAttribute('dir'), 'rtl');
        assert.equal(document.body.getAttribute('dir'), 'rtl');
        assert.equal(document.body.classList.contains('rtl'), true);
      }

      // Fallback when @@bidi_dir returns empty string but getUILanguage returns 'ar-SA'
      global.chrome = createChromeMock({ uiLanguage: 'ar-SA' });
      global.chrome.i18n.getMessage = () => '';
      assert.equal(popup.detectTextDirection(), 'rtl');

      // Switch back to LTR (e.g. 'ro')
      global.chrome = createChromeMock({ uiLanguage: 'ro' });
      popup.localizeUI();
      assert.equal(popup.detectTextDirection(), 'ltr');
      assert.equal(document.documentElement.getAttribute('dir'), 'ltr');
      assert.equal(document.body.getAttribute('dir'), 'ltr');
      assert.equal(document.body.classList.contains('rtl'), false);
    });
  });

  describe('gatherDomains', () => {
    it('harvests unique normalized host:port domains from history, nested bookmarks, and open tabs', async () => {
      const domains = await popup.gatherDomains();
      assert.deepEqual(domains.sort(), [
        'active-site.io:443',
        'bookmarked-spam.net:443',
        'legacy-http.example:80',
        'mail.google.com:443',
        'scam-alerts.xyz:443'
      ]);
    });

    it('gracefully continues scanning remaining sources if history or bookmarks API rejects', async () => {
      chrome.history.search = async () => { throw new Error('History unavailable'); };
      chrome.bookmarks.getTree = async () => { throw new Error('Bookmarks unavailable'); };
      const domains = await popup.gatherDomains();
      assert.deepEqual(domains, ['active-site.io:443']);
    });
  });

  describe('doScan — Classification, Self-Healing, and Global Default Handling', () => {
    it('separates allowed sites into Suspicious and Trusted, and classifies App-Blocked vs Browser-Blocked', async () => {
      // Browser-allowed suspicious site
      chrome._state.setBrowserRule('https://scam-alerts.xyz/*', 'allow');
      // Browser-allowed built-in trusted site
      chrome._state.setBrowserRule('https://mail.google.com/*', 'allow');
      // Browser-blocked site
      chrome._state.setBrowserRule('https://bookmarked-spam.net/*', 'block');
      // App-blocked site
      await popup.blockDomain('legacy-http.example:80');

      await popup.doScan();

      assert.deepEqual(popup.getCurrentSuspiciousSites(), ['scam-alerts.xyz:443']);
      assert.equal(document.getElementById('label-allowed').textContent, 'Allowed (2)');
      assert.equal(document.getElementById('label-blocked').textContent, 'Blocked (2)');

      // Clean All button should be visible when suspicious sites exist
      assert.equal(document.getElementById('reset-all-btn').classList.contains('hidden'), false);
      // Global status should show warning class when suspicious sites > 0
      assert.equal(document.getElementById('global-status').className, 'status-value warning');
    });

    it('does not pollute blocked list with all history domains when globalDefault is block', async () => {
      // User blocks all notifications globally via toggle
      await popup.setGlobalDefault('block');
      // And has 1 explicitly app-blocked site
      await popup.blockDomain('scam-alerts.xyz:443');

      await popup.doScan();

      // Only the 1 explicitly blocked site should appear in Blocked list, NOT all 5 history/tab/bookmark sites!
      assert.equal(document.getElementById('label-blocked').textContent, 'Blocked (1)');
      const storage = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(storage.blocked_domains, ['scam-alerts.xyz:443']);
    });

    it('self-heals both blocked_domains and user_whitelist when browser settings change externally', async () => {
      // Suppose stale-blocked.com is in storage blocked_domains, and stale-trusted.com is in storage user_whitelist,
      // but in Chrome their settings were reset to 'ask' by the user in chrome://settings
      await chrome.storage.local.set({
        blocked_domains: ['stale-blocked.com:443', 'still-blocked.com:443'],
        user_whitelist: ['stale-trusted.com:443', 'still-trusted.com:443']
      });
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://still-blocked.com/*',
        setting: 'block'
      });
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://still-trusted.com/*',
        setting: 'allow'
      });

      await popup.doScan();

      const storage = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
      assert.deepEqual(storage.blocked_domains, ['still-blocked.com:443']);
      assert.deepEqual(storage.user_whitelist, ['still-trusted.com:443']);
    });

    it('preserves HTTP protocol for non-standard ports (e.g. :8080, :3000) across background blocks and popup scans', async () => {
      // Simulate a site on http://http-spam.test:8080 blocked by background.js (persisted with domain_protocols)
      await chrome.storage.local.set({
        blocked_domains: ['http-spam.test:8080'],
        domain_protocols: { 'http-spam.test:8080': 'http' }
      });
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'http://http-spam.test/*',
        setting: 'block'
      });

      await popup.doScan();

      // Must NOT be falsely deleted by self-healing (which previously queried https:// instead of http://)
      const storage = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(storage.blocked_domains, ['http-spam.test:8080']);
      assert.equal(document.getElementById('label-blocked').textContent, 'Blocked (1)');

      await popup.updateCurrentSiteStatusUI('http-spam.test:8080');
      assert.equal(document.getElementById('current-site-status').textContent, 'Blocked (By App)');
    });

    it('detects and cleans browser-granted permissions on non-standard ports (:3000, :8443) where port 80/443 is not allowed', async () => {
      chrome._state.historyItems.push(
        { url: 'http://port-scam.local:3000/push' },
        { url: 'https://tls-scam.example:8443/offer' }
      );
      // Browser permission granted ONLY on :3000 and :8443 (NOT on :80 or :443)
      chrome._state.setBrowserRule('http://port-scam.local:3000/*', 'allow');
      chrome._state.setBrowserRule('https://tls-scam.example:8443/*', 'allow');

      await popup.doScan();

      assert.deepEqual(popup.getCurrentSuspiciousSites().sort(), [
        'port-scam.local:3000',
        'tls-scam.example:8443'
      ]);

      await popup.cleanAllSuspicious();
      assert.equal(await popup.getNotificationSetting('port-scam.local:3000'), 'block');
      assert.equal(await popup.getNotificationSetting('tls-scam.example:8443'), 'block');
      assert.deepEqual(popup.getCurrentSuspiciousSites(), []);
    });

    it('renders Reset (.unblock-btn) only for user-whitelisted trusted sites and not for built-in browser-allowed trusted sites', async () => {
      chrome._state.setBrowserRule('https://mail.google.com/*', 'allow');
      await config.allowAndTrustDomain('custom-trusted.org:443');

      await popup.doScan();

      const allowedItems = document.getElementById('allowed-list').querySelectorAll('.site-item');
      const googleItem = allowedItems.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'mail.google.com:443');
      const customItem = allowedItems.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'custom-trusted.org:443');

      assert.ok(googleItem, 'Built-in trusted site should appear in Allowed list');
      assert.equal(googleItem.querySelector('.unblock-btn'), null, 'Built-in browser-allowed site must not show dead Reset button');
      assert.ok(googleItem.querySelector('.block-btn'), 'Built-in trusted site can still be explicitly blocked');

      assert.ok(customItem, 'User-whitelisted site should appear in Allowed list');
      assert.ok(customItem.querySelector('.unblock-btn'), 'User-whitelisted site must show Reset button');
    });

    it('renders Unblock (.unblock-btn) only for app-blocked sites and not for browser-blocked sites, and distinguishes global vs browser status on Active Website card', async () => {
      chrome._state.setBrowserRule('https://bookmarked-spam.net/*', 'block');
      await popup.blockDomain('legacy-http.example:80');

      await popup.doScan();

      const blockedItems = document.getElementById('blocked-list').querySelectorAll('.site-item');
      const browserBlockedItem = blockedItems.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'bookmarked-spam.net:443');
      const appBlockedItem = blockedItems.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'legacy-http.example:80');

      assert.ok(browserBlockedItem);
      assert.equal(browserBlockedItem.querySelector('.unblock-btn'), null, 'Browser-blocked site cannot be reset via extension clear()');
      assert.ok(browserBlockedItem.querySelector('.trust-btn'), 'Browser-blocked site can still be trusted/allowed via extension rule');

      assert.ok(appBlockedItem);
      assert.ok(appBlockedItem.querySelector('.unblock-btn'), 'App-blocked site must render Unblock button');

      // Active Website status & Reset button state:
      // 1. Browser-blocked site (no app rule) -> statusActiveBlockedBrowser, reset disabled
      await popup.updateCurrentSiteStatusUI('bookmarked-spam.net:443');
      assert.equal(document.getElementById('current-site-status').textContent, 'Blocked (By Browser)');
      assert.equal(document.getElementById('current-site-reset').disabled, true);

      // 2. Global default set to 'block' on normal site -> statusActiveBlocked ("Blocked (Safe)"), reset disabled
      await popup.setGlobalDefault('block');
      await popup.updateCurrentSiteStatusUI('active-site.io:443');
      assert.equal(document.getElementById('current-site-status').textContent, 'Blocked (Safe)');
      assert.equal(document.getElementById('current-site-reset').disabled, true);

      // 3. App-blocked site -> statusActiveBlockedApp ("Blocked (By App)"), reset enabled
      await popup.updateCurrentSiteStatusUI('legacy-http.example:80');
      assert.equal(document.getElementById('current-site-status').textContent, 'Blocked (By App)');
      assert.equal(document.getElementById('current-site-reset').disabled, false);

      // 4. Global default set to 'allow' on unverified site -> statusActiveAllowed ("Allowed (Caution)"), reset disabled
      await popup.setGlobalDefault('allow');
      await popup.updateCurrentSiteStatusUI('active-site.io:443');
      assert.equal(document.getElementById('current-site-status').textContent, 'Allowed (Caution)');
      assert.equal(document.getElementById('current-site-reset').disabled, true);

      // 5. Global default 'ask' + Browser-allowed unverified site -> statusActiveAllowedBrowser ("Allowed (By Browser - Unverified)"), reset disabled
      await popup.setGlobalDefault('ask');
      chrome._state.setBrowserRule('https://scam-alerts.xyz/*', 'allow');
      await popup.updateCurrentSiteStatusUI('scam-alerts.xyz:443');
      assert.equal(document.getElementById('current-site-status').textContent, 'Allowed (By Browser - Unverified)');
      assert.equal(document.getElementById('current-site-reset').disabled, true);
    });

    it('accurately attributes cross-port Chrome extension rules (localhost:3000 -> localhost:8080) as App-managed without affecting HTTPS (:8443)', async () => {
      chrome._state.historyItems.push(
        { url: 'http://localhost:3000/app' },
        { url: 'http://localhost:8080/api' },
        { url: 'https://localhost:8443/secure' }
      );
      config.rememberDomainProtocol('localhost:3000', 'http');
      config.rememberDomainProtocol('localhost:8080', 'http');

      // Block localhost:3000 via extension -> sets http://localhost/* (port wildcard across all HTTP ports)
      await popup.blockDomain('localhost:3000');
      await popup.doScan();

      // Visiting http://localhost:8080 must show "Blocked (By App)" with Reset ENABLED (not "Blocked (By Browser)")
      await popup.updateCurrentSiteStatusUI('localhost:8080');
      assert.equal(document.getElementById('current-site-status').textContent, 'Blocked (By App)');
      assert.equal(document.getElementById('current-site-reset').disabled, false);

      // And in the Blocked list, localhost:8080 must also show an Unblock button
      const blockedItems = document.getElementById('blocked-list').querySelectorAll('.site-item');
      const item8080 = blockedItems.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'localhost:8080');
      assert.ok(item8080, 'localhost:8080 should appear in Blocked list');
      assert.ok(item8080.querySelector('.unblock-btn'), 'Cross-port HTTP site blocked by extension rule must show Unblock button');

      // Meanwhile https://localhost:8443 is a different scheme and remains standard 'ask'
      await popup.updateCurrentSiteStatusUI('localhost:8443');
      assert.equal(document.getElementById('current-site-status').textContent, 'Ask before sending (Standard)');
      assert.equal(document.getElementById('current-site-reset').disabled, true);
    });

    it('renders full multi-paragraph safeStateMsg text when no unverified sites are allowed, and handles global Allow All status', async () => {
      await popup.doScan();
      const emptyP = document.querySelector('#allowed-list .empty-state p');
      assert.ok(emptyP);
      // Verify dom_mock preserves all paragraphs separated by <br><br> (not just the first paragraph)
      assert.ok(emptyP.textContent.includes('\n\n'), 'Multi-paragraph safeStateMsg must retain all paragraphs across <br><br>');

      await popup.setGlobalDefault('allow');
      await popup.doScan();
      assert.equal(document.getElementById('global-status').textContent, 'Allow All (Highly Dangerous!)');
      assert.equal(document.getElementById('global-status').className, 'status-value allowed');
    });
  });

  describe('resetDomain, clearAllBlockedRules, and cleanAllSuspicious', () => {
    it('resetDomain removes a single domain while preserving other blocks, whitelist, and global default', async () => {
      await popup.setGlobalDefault('block');
      await popup.blockDomain('site1.com:443');
      await popup.blockDomain('site2.com:80');
      await config.allowAndTrustDomain('trusted1.com:443');

      await popup.resetDomain('site1.com:443');

      // Global default 'block' must be preserved!
      assert.equal(await popup.getGlobalDefaultSetting(), 'block');
      // site2.com:80 must still be blocked
      assert.equal(await popup.getNotificationSetting('site2.com:80'), 'block');
      // trusted1.com:443 must still be allowed
      assert.equal(await popup.getNotificationSetting('trusted1.com:443'), 'allow');

      const storage = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
      assert.deepEqual(storage.blocked_domains, ['site2.com:80']);
      assert.deepEqual(storage.user_whitelist, ['trusted1.com:443']);
    });

    it('clearAllBlockedRules clears all extension blocks while preserving user_whitelist and global default', async () => {
      await popup.setGlobalDefault('block');
      await popup.blockDomain('spam1.com:443');
      await popup.blockDomain('spam2.com:443');
      await config.allowAndTrustDomain('keep-allowed.com:443');

      await popup.clearAllBlockedRules();

      const storage = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
      assert.deepEqual(storage.blocked_domains, []);
      assert.deepEqual(storage.user_whitelist, ['keep-allowed.com:443']);
      assert.equal(await popup.getNotificationSetting('keep-allowed.com:443'), 'allow');
      assert.equal(await popup.getGlobalDefaultSetting(), 'block');
    });

    it('cleanAllSuspicious blocks all suspicious allowed sites while leaving trusted sites intact', async () => {
      // When no suspicious sites exist, cleanAllSuspicious returns immediately without prompting confirm
      let confirmCalled = false;
      global.confirm = () => { confirmCalled = true; return true; };
      await popup.doScan();
      await popup.cleanAllSuspicious();
      assert.equal(confirmCalled, false);

      chrome._state.setBrowserRule('https://scam-alerts.xyz/*', 'allow');
      chrome._state.setBrowserRule('https://mail.google.com/*', 'allow');

      await popup.doScan();
      assert.deepEqual(popup.getCurrentSuspiciousSites(), ['scam-alerts.xyz:443']);

      await popup.cleanAllSuspicious();

      assert.equal(confirmCalled, true);
      assert.equal(await popup.getNotificationSetting('scam-alerts.xyz:443'), 'block');
      assert.equal(await popup.getNotificationSetting('mail.google.com:443'), 'allow');
      assert.deepEqual(popup.getCurrentSuspiciousSites(), []);
    });
  });

  describe('initPopup — End-to-End Popup UI Interactions', () => {
    it('initializes active site card, handles Allow / Block / Reset buttons, toggles, and siteDetails links', async () => {
      await chrome.storage.local.set({
        guard_enabled: true,
        silent_guardian_enabled: true,
        blocked_count: 5
      });

      await popup.initPopup();

      // Version tag updated from manifest.json
      assert.equal(document.querySelector('.version-tag').textContent, 'v1.0.5');

      // Badge cleared on popup open, and background block log shown with count 5
      assert.equal(chrome._state.getBadgeText(), '');
      const logRow = document.getElementById('block-log-row');
      assert.equal(logRow.classList.contains('hidden'), false);
      assert.ok(document.getElementById('block-log-text').textContent.includes('5'));

      // Clear log button resets count to 0 and hides row
      await document.getElementById('clear-log-btn').click();
      assert.equal(logRow.classList.contains('hidden'), true);
      const afterClearLog = await chrome.storage.local.get({ blocked_count: 0 });
      assert.equal(afterClearLog.blocked_count, 0);

      // Active website card is visible for https://active-site.io/dashboard
      const currentSiteCard = document.getElementById('current-site-card');
      assert.equal(currentSiteCard.classList.contains('hidden'), false);
      assert.equal(document.getElementById('current-site-domain').textContent, 'active-site.io:443');

      // Click Allow on Active Website
      await document.getElementById('current-site-allow').click();
      assert.equal(await popup.getNotificationSetting('active-site.io:443'), 'allow');
      assert.equal(
        document.getElementById('current-site-status').textContent,
        'Allowed (Trusted by App)'
      );

      // Click Block on Active Website
      await document.getElementById('current-site-block').click();
      assert.equal(await popup.getNotificationSetting('active-site.io:443'), 'block');
      assert.equal(
        document.getElementById('current-site-status').textContent,
        'Blocked (By App)'
      );

      // Click Reset on Active Website (cancelled first, then confirmed)
      global.confirm = () => false;
      await document.getElementById('current-site-reset').click();
      assert.equal(await popup.getNotificationSetting('active-site.io:443'), 'block');

      global.confirm = () => true;
      await document.getElementById('current-site-reset').click();
      assert.equal(await popup.getNotificationSetting('active-site.io:443'), 'ask');

      // Click current-site-domain opens siteDetails
      await document.getElementById('current-site-domain').click();
      assert.equal(
        chrome._state.createdTabs.at(-1).url,
        'chrome://settings/content/siteDetails?site=https%3A%2F%2Factive-site.io%3A443'
      );

      // Help drawer open & close
      const helpOverlay = document.getElementById('help-overlay');
      assert.equal(helpOverlay.classList.contains('hidden'), true);
      await document.getElementById('help-btn').click();
      assert.equal(helpOverlay.classList.contains('hidden'), false);
      await document.getElementById('close-help-btn').click();
      assert.equal(helpOverlay.classList.contains('hidden'), true);

      // Help drawer also closes when clicking the overlay backdrop directly or pressing Escape
      await document.getElementById('help-btn').click();
      assert.equal(helpOverlay.classList.contains('hidden'), false);
      await helpOverlay.trigger('click', { target: helpOverlay });
      assert.equal(helpOverlay.classList.contains('hidden'), true);

      await document.getElementById('help-btn').click();
      assert.equal(helpOverlay.classList.contains('hidden'), false);
      await document.dispatchEvent({ type: 'keydown', key: 'Escape' });
      assert.equal(helpOverlay.classList.contains('hidden'), true);

      // Help button title & aria-label localized via data-i18n-title
      assert.equal(document.getElementById('help-btn').getAttribute('title'), 'What is Notification Abuse?');
      assert.equal(document.getElementById('help-btn').getAttribute('aria-label'), 'What is Notification Abuse?');

      // Open browser notification settings button
      await document.getElementById('open-settings-btn').click();
      assert.equal(
        chrome._state.createdTabs.at(-1).url,
        'chrome://settings/content/notifications'
      );

      // Tab switching between Allowed and Blocked
      await document.getElementById('tab-blocked').click();
      assert.equal(document.getElementById('tab-blocked').classList.contains('active'), true);
      assert.equal(document.getElementById('blocked-list').classList.contains('hidden'), false);
      assert.equal(document.getElementById('allowed-list').classList.contains('hidden'), true);
    });

    it('immediately persists list item Block, Trust, and Unblock actions before animation timeout and disables sibling buttons', async () => {
      chrome._state.setBrowserRule('https://scam-alerts.xyz/*', 'allow');
      chrome._state.setBrowserRule('http://legacy-http.example/*', 'allow');

      await popup.initPopup();

      const allowedList = document.getElementById('allowed-list');
      const items = allowedList.querySelectorAll('.site-item');
      assert.equal(items.length, 2);

      // 1. Click domain link on HTTP (:80) site -> opens http:// in siteDetails (not hardcoded https://)
      const httpItem = items.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'legacy-http.example:80');
      await httpItem.querySelector('.site-domain').click();
      assert.equal(
        chrome._state.createdTabs.at(-1).url,
        'chrome://settings/content/siteDetails?site=http%3A%2F%2Flegacy-http.example%3A80'
      );

      // 2. Click Block button on scam-alerts.xyz:443 -> immediately blocks in Chrome & storage before 200ms timeout
      const scamItem = items.find(li => li.querySelector('.site-domain').getAttribute('data-domain') === 'scam-alerts.xyz:443');
      const blockBtn = scamItem.querySelector('.block-btn');
      const trustBtn = scamItem.querySelector('.trust-btn');
      await blockBtn.click();

      // Both buttons on the row must be disabled immediately to prevent double-click race
      assert.equal(blockBtn.disabled, true);
      assert.equal(trustBtn.disabled, true);
      assert.equal(await popup.getNotificationSetting('scam-alerts.xyz:443'), 'block');

      // 3. Click Trust button on legacy-http.example:80 -> immediately trusts & allows
      await httpItem.querySelector('.trust-btn').click();
      assert.equal(await popup.getNotificationSetting('legacy-http.example:80'), 'allow');
      const storage = await chrome.storage.local.get({ user_whitelist: [] });
      assert.ok(storage.user_whitelist.includes('legacy-http.example:80'));

      // 4. Re-scan and test .unblock-btn on blocked item & clear-all-rules-btn
      await popup.doScan();
      const blockedList = document.getElementById('blocked-list');
      const blockedItems = blockedList.querySelectorAll('.site-item');
      assert.equal(blockedItems.length, 1);

      const unblockBtn = blockedItems[0].querySelector('.unblock-btn');
      await unblockBtn.click();
      assert.equal(unblockBtn.disabled, true);
      // Extension block rule cleared, reverting scam-alerts.xyz to browser rule ('allow')
      assert.equal(await popup.getNotificationSetting('scam-alerts.xyz:443'), 'allow');

      // 5. Block again and test #clear-all-rules-btn (cancelled then confirmed)
      await popup.blockDomain('scam-alerts.xyz:443');
      await popup.doScan();
      global.confirm = () => false;
      await document.getElementById('clear-all-rules-btn').click();
      assert.equal(await popup.getNotificationSetting('scam-alerts.xyz:443'), 'block');

      global.confirm = () => true;
      await document.getElementById('clear-all-rules-btn').click();
      assert.equal(await popup.getNotificationSetting('scam-alerts.xyz:443'), 'allow');
    });

    it('enforces the Real-time Protection -> Silent Guardian dependency invariant across UI and storage', async () => {
      await popup.initPopup();

      const defaultToggle = document.getElementById('default-toggle');
      defaultToggle.checked = false;
      await defaultToggle.trigger('change');
      assert.equal(await popup.getGlobalDefaultSetting(), 'block');
      assert.equal(document.getElementById('global-status').className, 'status-value blocked');

      const guardToggle = document.getElementById('guard-toggle');
      const silentToggle = document.getElementById('silent-toggle');
      const silentRow = document.getElementById('silent-guardian-row');

      // 1. While Real-time Protection is ON, Silent Guardian can be turned ON
      assert.equal(guardToggle.checked, true);
      assert.equal(silentToggle.disabled, false);
      assert.equal(silentRow.classList.contains('is-disabled'), false);
      silentToggle.checked = true;
      await silentToggle.trigger('change');

      let storage = await chrome.storage.local.get({ guard_enabled: true, silent_guardian_enabled: false });
      assert.equal(storage.guard_enabled, true);
      assert.equal(storage.silent_guardian_enabled, true);

      // 2. Turning Real-time Protection OFF automatically unchecks & disables Silent Guardian in UI and storage
      guardToggle.checked = false;
      await guardToggle.trigger('change');

      assert.equal(silentToggle.checked, false);
      assert.equal(silentToggle.disabled, true);
      assert.equal(silentRow.classList.contains('is-disabled'), true);
      assert.equal(silentRow.getAttribute('aria-disabled'), 'true');
      storage = await chrome.storage.local.get({ guard_enabled: true, silent_guardian_enabled: false });
      assert.equal(storage.guard_enabled, false);
      assert.equal(storage.silent_guardian_enabled, false);

      // 3. Even a synthetic change event attempting to enable Silent Guardian while Guard is OFF is rejected
      silentToggle.checked = true;
      await silentToggle.trigger('change');
      assert.equal(silentToggle.checked, false);
      assert.equal(silentToggle.disabled, true);
      storage = await chrome.storage.local.get({ guard_enabled: true, silent_guardian_enabled: false });
      assert.equal(storage.guard_enabled, false);
      assert.equal(storage.silent_guardian_enabled, false);

      // 4. Re-enabling Real-time Protection unlocks Silent Guardian (leaving it safely unchecked until user opts in)
      guardToggle.checked = true;
      await guardToggle.trigger('change');
      assert.equal(silentToggle.disabled, false);
      assert.equal(silentToggle.checked, false);
      assert.equal(silentRow.classList.contains('is-disabled'), false);
      assert.equal(silentRow.getAttribute('aria-disabled'), 'false');
    });

    it('heals legacy { guard_enabled: false, silent_guardian_enabled: true } storage on initPopup and syncs via storage.onChanged', async () => {
      await chrome.storage.local.set({ guard_enabled: false, silent_guardian_enabled: true });
      await popup.initPopup();

      const guardToggle = document.getElementById('guard-toggle');
      const silentToggle = document.getElementById('silent-toggle');
      const silentRow = document.getElementById('silent-guardian-row');
      assert.equal(guardToggle.checked, false);
      assert.equal(silentToggle.checked, false);
      assert.equal(silentToggle.disabled, true);
      assert.equal(silentRow.classList.contains('is-disabled'), true);

      const healed = await chrome.storage.local.get({ guard_enabled: true, silent_guardian_enabled: true });
      assert.equal(healed.guard_enabled, false);
      assert.equal(healed.silent_guardian_enabled, false);

      // Live storage.onChanged updates toggle UI state
      await chrome.storage.local.set({ guard_enabled: true, silent_guardian_enabled: true });
      assert.equal(guardToggle.checked, true);
      assert.equal(silentToggle.checked, true);
      assert.equal(silentToggle.disabled, false);
      assert.equal(silentRow.classList.contains('is-disabled'), false);
    });

    it('warns on cross-port active-tab reset when primaryPattern matches, skips warning across different schemes, and immediately syncs toolbar icon on row actions', async () => {
      config.rememberDomainProtocol('dev.local:3000', 'http');
      await config.blockAndRecordDomain('dev.local:3000');

      // Active tab is on port :8080 over HTTP (shares http://dev.local/* rule with dev.local:3000)
      chrome._state.openTabs.splice(0, chrome._state.openTabs.length, {
        id: 1,
        active: true,
        windowId: 1,
        url: 'http://dev.local:8080/dashboard'
      });
      await popup.initPopup();

      let confirmCalls = 0;
      global.confirm = () => {
        confirmCalls++;
        return false; // cancel reset
      };

      const blockedItems = document.getElementById('blocked-list').querySelectorAll('.site-item');
      assert.equal(blockedItems.length, 2);
      const port3000Row = blockedItems.find(
        li => li.querySelector('.site-domain').getAttribute('data-domain') === 'dev.local:3000'
      );
      assert.ok(port3000Row);
      await port3000Row.querySelector('.unblock-btn').click();
      assert.equal(confirmCalls, 1, 'Must prompt confirmation when resetting a port-wildcard rule affecting the open HTTP tab on :8080');
      assert.equal(await popup.getNotificationSetting('dev.local:3000'), 'block');

      // Now switch active tab to HTTPS on :8443 (https://dev.local/* is unaffected by resetting http://dev.local/*)
      chrome._state.openTabs.splice(0, chrome._state.openTabs.length, {
        id: 1,
        active: true,
        windowId: 1,
        url: 'https://dev.local:8443/secure'
      });
      // Rebuild fresh DOM for clean re-init
      document.body.removeAttribute('data-listeners-bound');
      await popup.initPopup();

      confirmCalls = 0;
      const beforeMsgCount = chrome._state.sentMessages.filter(m => m && m.action === 'update_active_tab_icon').length;
      const updatedBlockedItems = document.getElementById('blocked-list').querySelectorAll('.site-item');
      await updatedBlockedItems[0].querySelector('.unblock-btn').click();
      assert.equal(confirmCalls, 0, 'Must NOT prompt confirmation when open tab uses HTTPS and reset rule is HTTP');
      assert.equal(await popup.getNotificationSetting('dev.local:3000'), 'ask');
      const afterMsgCount = chrome._state.sentMessages.filter(m => m && m.action === 'update_active_tab_icon').length;
      assert.equal(afterMsgCount, beforeMsgCount + 1, 'Row action must immediately dispatch update_active_tab_icon before delayed scan timer');
    });

    it('preserves concurrent background blocks during performScan self-healing, honors gatherDomains protocol precedence, and exports no dangling symbols', async () => {
      assert.equal('reapplyExtensionRules' in popup, false, 'popup.js must not export undefined/global reapplyExtensionRules');
      assert.equal(typeof popup.syncGuardAndSilentUI, 'function');
      assert.equal(typeof popup.notifyActiveTabIconSync, 'function');

      // 1. Verify gatherDomains protocol precedence: Bookmarks (http) -> History older (http) -> History newer (https) -> Open Tab (http)
      chrome._state.bookmarkTree.splice(0, chrome._state.bookmarkTree.length, {
        id: '0',
        children: [
          { id: '1', url: 'http://hist-upgrade.local:3000/' },
          { id: '2', url: 'https://tab-downgrade.local:3000/' }
        ]
      });
      chrome._state.historyItems.splice(
        0,
        chrome._state.historyItems.length,
        { url: 'https://hist-upgrade.local:3000/new', lastVisitTime: 2000 },
        { url: 'http://hist-upgrade.local:3000/old', lastVisitTime: 1000 }
      );
      chrome._state.openTabs.splice(0, chrome._state.openTabs.length, {
        id: 10,
        active: true,
        windowId: 1,
        url: 'http://tab-downgrade.local:3000/live'
      });

      await popup.gatherDomains();
      assert.equal(config.getProtocolForDomain('hist-upgrade.local:3000'), 'https');
      assert.equal(config.getProtocolForDomain('tab-downgrade.local:3000'), 'http');

      // 2. Concurrent background block arriving mid-scan during performScan self-healing must NOT be lost
      await config.blockAndRecordDomain('keep-active.example:443');
      // Inject a stale entry into storage that has no rule in Chrome so self-healing triggers
      await chrome.storage.local.set({
        blocked_domains: ['keep-active.example:443', 'stale-ghost.example:443']
      });

      let injectedConcurrentBlock = false;
      const origGet = chrome.contentSettings.notifications.get;
      chrome.contentSettings.notifications.get = async (details) => {
        if (!injectedConcurrentBlock && details && details.primaryUrl === 'https://stale-ghost.example/') {
          injectedConcurrentBlock = true;
          await config.blockAndRecordDomain('concurrent-bg.local:8080', 'http://concurrent-bg.local:8080/*');
        }
        return origGet(details);
      };

      await popup.doScan();
      chrome.contentSettings.notifications.get = origGet;

      const afterScan = await chrome.storage.local.get({ blocked_domains: [], domain_protocols: {} });
      assert.equal(afterScan.blocked_domains.includes('stale-ghost.example:443'), false, 'Stale domain should be pruned');
      assert.equal(afterScan.blocked_domains.includes('keep-active.example:443'), true, 'Active domain should remain');
      assert.equal(afterScan.blocked_domains.includes('concurrent-bg.local:8080'), true, 'Concurrent background block must not be overwritten');
      assert.equal(afterScan.domain_protocols['concurrent-bg.local:8080'], 'http');

      // 3. clearAllBlockedRules recovers button disabled state via finally even if contentSettings.clear throws
      document.body.removeAttribute('data-listeners-bound');
      await popup.initPopup();
      const clearBtn = document.getElementById('clear-all-rules-btn');
      assert.equal(clearBtn.disabled, false);

      const origClear = chrome.contentSettings.notifications.clear;
      chrome.contentSettings.notifications.clear = async () => {
        throw new Error('Transient Chrome clear error');
      };
      global.confirm = () => true;
      await clearBtn.click();
      chrome.contentSettings.notifications.clear = origClear;

      assert.equal(clearBtn.disabled, false, '#clear-all-rules-btn must not remain stuck disabled after transient clear error');
    });

    it('keeps help modal open when clicking inside .help-card (event bubbling), live-updates blocked_count via storage.onChanged, and batches cleanAllSuspicious into 1 storage write', async () => {
      chrome._state.historyItems.push(
        { url: 'https://spam-batch-1.xyz/' },
        { url: 'https://spam-batch-2.xyz/' }
      );
      chrome._state.setBrowserRule('https://spam-batch-1.xyz/*', 'allow');
      chrome._state.setBrowserRule('https://spam-batch-2.xyz/*', 'allow');

      await popup.initPopup();

      // 1. Open Help modal and click inside .help-card -> event bubbles to #help-overlay,
      //    where e.target !== helpOverlay so modal MUST remain open!
      const helpOverlay = document.getElementById('help-overlay');
      const helpCard = helpOverlay.querySelector('.help-card');
      await document.getElementById('help-btn').click();
      assert.equal(helpOverlay.classList.contains('hidden'), false);
      await helpCard.click();
      assert.equal(helpOverlay.classList.contains('hidden'), false, 'Clicking inside .help-card must not dismiss #help-overlay');
      await helpOverlay.click();
      assert.equal(helpOverlay.classList.contains('hidden'), true, 'Clicking backdrop directly dismisses #help-overlay');

      // 2. Live storage.onChanged updates #block-log-row while popup is open
      const logRow = document.getElementById('block-log-row');
      assert.equal(logRow.classList.contains('hidden'), true);
      await chrome.storage.local.set({ blocked_count: 9 });
      assert.equal(logRow.classList.contains('hidden'), false);
      assert.ok(document.getElementById('block-log-text').textContent.includes('9'));

      // 3. cleanAllSuspicious via #reset-all-btn writes to chrome.storage.local.set only ONCE for multiple sites
      let setCalls = 0;
      const origSet = chrome.storage.local.set;
      chrome.storage.local.set = async (items) => {
        setCalls++;
        return origSet(items);
      };
      await document.getElementById('reset-all-btn').click();
      assert.equal(setCalls, 1, 'cleanAllSuspicious must batch storage updates into 1 write');
      assert.equal(await popup.getNotificationSetting('spam-batch-1.xyz:443'), 'block');
      assert.equal(await popup.getNotificationSetting('spam-batch-2.xyz:443'), 'block');

      // 4. Switching to Blocked tab and rescanning preserves active Blocked tab visibility
      await document.getElementById('tab-blocked').click();
      await document.getElementById('scan-btn').click();
      assert.equal(document.getElementById('blocked-list').classList.contains('hidden'), false);
      assert.equal(document.getElementById('allowed-list').classList.contains('hidden'), true);
    });
  });
});
