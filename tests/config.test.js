const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createChromeMock } = require('./helpers/chrome_mock');
const config = require('../chrome_extension/config');

describe('config.js — Domain, URL, Pattern, and Storage Helpers', () => {
  beforeEach(() => {
    config.clearKnownDomainProtocols();
    global.chrome = createChromeMock();
  });

  describe('normalizeDomain & getCleanHostname', () => {
    it('normalizes standard domain and port to lowercase and strips trailing dots', () => {
      assert.equal(config.normalizeDomain('Example.COM:443'), 'example.com:443');
      assert.equal(config.normalizeDomain('  Sub.Google.COM.:443  '), 'sub.google.com:443');
      assert.equal(config.normalizeDomain('example.com.'), 'example.com');
      assert.equal(config.getCleanHostname('Example.COM:8080'), 'example.com');
      assert.equal(config.getCleanHostname('sub.domain.co.jp.:443'), 'sub.domain.co.jp');
    });

    it('handles IPv6 addresses with and without port (including IPv4-mapped IPv6)', () => {
      assert.equal(config.normalizeDomain('[::1]:8080'), '[::1]:8080');
      assert.equal(config.normalizeDomain('[2001:DB8::1]'), '[2001:db8::1]');
      assert.equal(config.normalizeDomain('[::ffff:127.0.0.1]:3000'), '[::ffff:127.0.0.1]:3000');
      assert.equal(config.getCleanHostname('[::1]:8080'), '[::1]');
      assert.equal(config.normalizeDomain('[::1:8080'), '');
      assert.equal(config.normalizeDomain('[::1]:abc'), '');
      assert.equal(config.normalizeDomain('[:]'), '');
      assert.equal(config.normalizeDomain('[.:1]'), '');
    });

    it('rejects empty, non-string, malformed, or out-of-range port domains', () => {
      assert.equal(config.normalizeDomain(''), '');
      assert.equal(config.normalizeDomain('   '), '');
      assert.equal(config.normalizeDomain(null), '');
      assert.equal(config.normalizeDomain(undefined), '');
      assert.equal(config.normalizeDomain(':443'), '');
      assert.equal(config.normalizeDomain('example.com:abc'), '');
      assert.equal(config.normalizeDomain('example.com:0'), '');
      assert.equal(config.normalizeDomain('example.com:65536'), '');
      assert.equal(config.normalizeDomain('example.com/path:443'), '');
      assert.equal(config.normalizeDomain('bad host.com:443'), '');
      assert.equal(config.normalizeDomain('[not-ipv6]:443'), '');
      assert.equal(config.getCleanHostname(''), '');
      assert.equal(config.getCleanHostname(null), '');
    });
  });

  describe('getProtocolForDomain, getPrimaryPatternForDomain, getPrimaryUrlForDomain, getSiteDetailsUrl', () => {
    it('builds correct protocol, pattern, url, and siteDetails url for HTTP (:80), HTTPS (:443), and tracked custom ports', () => {
      assert.equal(config.getProtocolForDomain('example.com:80'), 'http');
      assert.equal(config.getProtocolForDomain('example.com:443'), 'https');
      assert.equal(config.getProtocolForDomain('example.com:8443'), 'https');

      // Custom port HTTP URL tracked via getHostAndPortFromUrl / rememberDomainProtocol
      assert.equal(config.getHostAndPortFromUrl('http://custom-http.local:3000/app'), 'custom-http.local:3000');
      assert.equal(config.getPortFromDomain('custom-http.local:3000'), '3000');
      assert.equal(config.getPortFromDomain('[::1]:8080'), '8080');
      assert.equal(config.getPortFromDomain('example.com'), '');
      assert.equal(config.getProtocolForDomain('custom-http.local:3000'), 'http');
      assert.equal(config.getPrimaryPatternForDomain('custom-http.local:3000'), 'http://custom-http.local/*');
      assert.equal(config.getPatternWithPortForDomain('custom-http.local:3000'), 'http://custom-http.local:3000/*');
      assert.equal(config.getPrimaryUrlForDomain('custom-http.local:3000'), 'http://custom-http.local:3000/');
      assert.equal(config.getPrimaryUrlForDomain('scam.example:8443'), 'https://scam.example:8443/');
      assert.equal(config.getHostAndPortFromUrl('http://[::1]:8080/app'), '[::1]:8080');
      assert.equal(config.getPrimaryUrlForDomain('[::1]:8080'), 'http://[::1]:8080/');
      assert.equal(
        config.getSiteDetailsUrl('custom-http.local:3000'),
        'chrome://settings/content/siteDetails?site=http%3A%2F%2Fcustom-http.local%3A3000'
      );

      assert.equal(config.getPrimaryPatternForDomain('Example.com:443'), 'https://example.com/*');
      assert.equal(config.getPrimaryPatternForDomain('Example.com:80'), 'http://example.com/*');
      assert.equal(config.getPrimaryPatternForDomain(''), '');

      assert.equal(config.getPrimaryUrlForDomain('Example.com:443'), 'https://example.com/');
      assert.equal(config.getPrimaryUrlForDomain('Example.com:80'), 'http://example.com/');
      assert.equal(config.getPrimaryUrlForDomain(''), '');

      assert.equal(
        config.getSiteDetailsUrl('example.com:443'),
        'chrome://settings/content/siteDetails?site=https%3A%2F%2Fexample.com%3A443'
      );
      assert.equal(
        config.getSiteDetailsUrl('example.com:80'),
        'chrome://settings/content/siteDetails?site=http%3A%2F%2Fexample.com%3A80'
      );
      assert.equal(config.getSiteDetailsUrl(''), 'chrome://settings/content/notifications');
    });
  });

  describe('isDomainTrusted', () => {
    it('returns true for exact matches and subdomains in TRUSTED_DOMAINS', () => {
      assert.equal(config.isDomainTrusted('google.com:443'), true);
      assert.equal(config.isDomainTrusted('mail.google.com:443'), true);
      assert.equal(config.isDomainTrusted('SLACK.COM:443'), true);
      assert.equal(config.isDomainTrusted('app.slack.com:443'), true);
      assert.equal(config.isDomainTrusted('yahoo.co.jp:443'), true);
    });

    it('returns false for lookalike/spoofed domains and unknown domains', () => {
      assert.equal(config.isDomainTrusted('evilgoogle.com:443'), false);
      assert.equal(config.isDomainTrusted('google.com.evil.com:443'), false);
      assert.equal(config.isDomainTrusted('not-slack.com:443'), false);
      assert.equal(config.isDomainTrusted('scam-captcha-verify.xyz:443'), false);
    });

    it('returns false for empty, null, undefined, or port-only inputs', () => {
      assert.equal(config.isDomainTrusted(''), false);
      assert.equal(config.isDomainTrusted(null), false);
      assert.equal(config.isDomainTrusted(undefined), false);
      assert.equal(config.isDomainTrusted(':443'), false);
    });

    it('checks userWhitelist accurately including subdomains and port stripping', () => {
      const whitelist = ['custom-news.org:443', 'my-company.local:8080'];
      assert.equal(config.isDomainTrusted('custom-news.org:443', whitelist), true);
      assert.equal(config.isDomainTrusted('sub.custom-news.org:443', whitelist), true);
      assert.equal(config.isDomainTrusted('my-company.local:80', whitelist), true);
      assert.equal(config.isDomainTrusted('fakecustom-news.org:443', whitelist), false);
    });
  });

  describe('getHostAndPortFromUrl', () => {
    it('extracts lowercase host and default/explicit port from HTTP and HTTPS URLs', () => {
      assert.equal(config.getHostAndPortFromUrl('https://Example.COM/path/to/page'), 'example.com:443');
      assert.equal(config.getHostAndPortFromUrl('http://Example.COM/path'), 'example.com:80');
      assert.equal(config.getHostAndPortFromUrl('https://example.com:8443/app'), 'example.com:8443');
      assert.equal(config.getHostAndPortFromUrl('http://localhost:3000'), 'localhost:3000');
      assert.equal(config.getHostAndPortFromUrl('HTTPS://Sub.Domain.Org'), 'sub.domain.org:443');
    });

    it('correctly handles query strings and hashes containing slashes without corrupting hostname', () => {
      assert.equal(
        config.getHostAndPortFromUrl('https://example.com?redirect=https://other.com/foo'),
        'example.com:443'
      );
      assert.equal(
        config.getHostAndPortFromUrl('https://example.com#section/sub/1'),
        'example.com:443'
      );
      assert.equal(
        config.getHostAndPortFromUrl('http://example.com:8080?next=/home#top'),
        'example.com:8080'
      );
    });

    it('handles userinfo, trailing dots, backslash delimiters, and IPv6 literals', () => {
      assert.equal(config.getHostAndPortFromUrl('https://user:pass@example.com/login'), 'example.com:443');
      assert.equal(config.getHostAndPortFromUrl('https://example.com./index.html'), 'example.com:443');
      assert.equal(config.getHostAndPortFromUrl('https://example.com\\path\\page'), 'example.com:443');
      assert.equal(config.getHostAndPortFromUrl('http://[::1]:8080/test'), '[::1]:8080');
      assert.equal(config.getHostAndPortFromUrl('https://[::1]/test'), '[::1]:443');
    });

    it('returns null for non-http(s) protocols, out-of-range ports, and malformed URLs', () => {
      assert.equal(config.getHostAndPortFromUrl('chrome://extensions'), null);
      assert.equal(config.getHostAndPortFromUrl('file:///home/user/index.html'), null);
      assert.equal(config.getHostAndPortFromUrl('about:blank'), null);
      assert.equal(config.getHostAndPortFromUrl('https:///no-host'), null);
      assert.equal(config.getHostAndPortFromUrl('https://:443/no-host'), null);
      assert.equal(config.getHostAndPortFromUrl('https://example.com:invalidport/'), null);
      assert.equal(config.getHostAndPortFromUrl('https://example.com:0/'), null);
      assert.equal(config.getHostAndPortFromUrl('https://example.com:99999/'), null);
      assert.equal(config.getHostAndPortFromUrl(''), null);
      assert.equal(config.getHostAndPortFromUrl(null), null);
    });
  });

  describe('stripPortFromPattern & getDomainFromPattern', () => {
    it('strips numeric and wildcard ports from primary patterns and lowercases hostname', () => {
      assert.equal(config.stripPortFromPattern('https://example.com:443/*'), 'https://example.com/*');
      assert.equal(config.stripPortFromPattern('http://Example.COM:80/*'), 'http://example.com/*');
      assert.equal(config.stripPortFromPattern('https://example.com:8443/path'), 'https://example.com/path');
      assert.equal(config.stripPortFromPattern('https://example.com:*/*'), 'https://example.com/*');
      assert.equal(config.stripPortFromPattern('http://[::1]:8080/*'), 'http://[::1]/*');
      assert.equal(config.stripPortFromPattern('*://Example.COM:8080/*'), '*://example.com/*');
      assert.equal(config.stripPortFromPattern('<all_urls>'), '<all_urls>');
      assert.equal(config.stripPortFromPattern(''), '');
    });

    it('extracts domain:port from contentSettings patterns (including *:// and IPv6 wildcard ports) and rejects wildcard-only patterns', () => {
      assert.equal(config.getDomainFromPattern('https://example.com:443/*'), 'example.com:443');
      assert.equal(config.getDomainFromPattern('http://example.com:80/*'), 'example.com:80');
      assert.equal(config.getDomainFromPattern('https://[*.]sub.example.com/*'), 'sub.example.com:443');
      assert.equal(config.getDomainFromPattern('*://[*.]example.com/*'), 'example.com:443');
      assert.equal(config.getDomainFromPattern('https://example.com:*/*'), 'example.com:443');
      assert.equal(config.getDomainFromPattern('http://[::1]:*/*'), '[::1]:80');
      assert.equal(config.getDomainFromPattern('example.com'), 'example.com:443');
      assert.equal(config.getDomainFromPattern('<all_urls>'), '');
      assert.equal(config.getDomainFromPattern('https://*/*'), '');
      assert.equal(config.getDomainFromPattern('*://*/*'), '');
      assert.equal(config.getDomainFromPattern(''), '');
    });
  });

  describe('Storage state helpers (add/remove Blocked & Whitelisted, allowAndTrustDomain, concurrency)', () => {
    it('adds and removes blocked domains without duplicates and normalizes case', async () => {
      await config.addBlockedDomain('Spam.COM:443');
      await config.addBlockedDomain('spam.com:443');
      await config.addBlockedDomain('other.com:80');

      let data = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(data.blocked_domains, ['spam.com:443', 'other.com:80']);

      await config.removeBlockedDomain('SPAM.COM:443');
      data = await chrome.storage.local.get({ blocked_domains: [] });
      assert.deepEqual(data.blocked_domains, ['other.com:80']);
    });

    it('adds and removes whitelisted domains without duplicates and normalizes case', async () => {
      await config.addWhitelistedDomain('Trusted.ORG:443');
      await config.addWhitelistedDomain('trusted.org:443');

      let data = await chrome.storage.local.get({ user_whitelist: [] });
      assert.deepEqual(data.user_whitelist, ['trusted.org:443']);

      await config.removeWhitelistedDomain('TRUSTED.ORG:443');
      data = await chrome.storage.local.get({ user_whitelist: [] });
      assert.deepEqual(data.user_whitelist, []);
    });

    it('serializes concurrent storage operations without losing updates', async () => {
      await Promise.all([
        config.addBlockedDomain('concurrent1.com:443'),
        config.addBlockedDomain('concurrent2.com:443'),
        config.addBlockedDomain('concurrent3.com:80'),
        config.addWhitelistedDomain('white1.org:443'),
        config.addWhitelistedDomain('white2.org:443')
      ]);

      const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
      assert.deepEqual(data.blocked_domains, ['concurrent1.com:443', 'concurrent2.com:443', 'concurrent3.com:80']);
      assert.deepEqual(data.user_whitelist, ['white1.org:443', 'white2.org:443']);
    });

    it('allowAndTrustDomain removes from blocked_domains, adds to user_whitelist before setting contentSettings', async () => {
      await config.addBlockedDomain('site.org:443');

      let storageAtSetCall = null;
      const origSet = chrome.contentSettings.notifications.set;
      chrome.contentSettings.notifications.set = async (args) => {
        storageAtSetCall = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
        return origSet(args);
      };

      await config.allowAndTrustDomain('Site.ORG:443');

      // Verify storage was already updated BEFORE contentSettings.notifications.set was called
      assert.deepEqual(storageAtSetCall.blocked_domains, []);
      assert.deepEqual(storageAtSetCall.user_whitelist, ['site.org:443']);

      const details = await chrome.contentSettings.notifications.get({ primaryUrl: 'https://site.org/' });
      assert.equal(details.setting, 'allow');
    });

    it('prunes domain_protocols in storage when custom-port HTTP domains are removed or cleared', async () => {
      config.rememberDomainProtocol('http-one.local:3000', 'http');
      config.rememberDomainProtocol('http-two.local:8080', 'http');
      await config.addBlockedDomain('http-one.local:3000');
      await config.addWhitelistedDomain('http-two.local:8080');

      let data = await chrome.storage.local.get({ domain_protocols: {} });
      assert.deepEqual(data.domain_protocols, {
        'http-one.local:3000': 'http',
        'http-two.local:8080': 'http'
      });

      await config.removeBlockedDomain('http-one.local:3000');
      data = await chrome.storage.local.get({ domain_protocols: {} });
      assert.deepEqual(data.domain_protocols, {
        'http-two.local:8080': 'http'
      });

      await config.removeWhitelistedDomain('http-two.local:8080');
      data = await chrome.storage.local.get({ domain_protocols: {} });
      assert.deepEqual(data.domain_protocols, {});
    });

    it('serializes concurrent resetDomainRules without losing global default block or remaining rules', async () => {
      await config.setGlobalNotificationDefault('block');
      await config.blockAndRecordDomain('spam-a.com:443');
      await config.blockAndRecordDomain('spam-b.com:443');
      await config.blockAndRecordDomain('spam-keep.com:443');
      await config.allowAndTrustDomain('trusted-keep.com:443');

      await Promise.all([
        config.resetDomainRules('spam-a.com:443'),
        config.resetDomainRules('spam-b.com:443')
      ]);

      assert.equal(await config.getGlobalNotificationDefault(), 'block');
      const keepBlocked = await chrome.contentSettings.notifications.get({ primaryUrl: 'https://spam-keep.com/' });
      const keepTrusted = await chrome.contentSettings.notifications.get({ primaryUrl: 'https://trusted-keep.com/' });
      assert.equal(keepBlocked.setting, 'block');
      assert.equal(keepTrusted.setting, 'allow');

      const storage = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [] });
      assert.deepEqual(storage.blocked_domains, ['spam-keep.com:443']);
      assert.deepEqual(storage.user_whitelist, ['trusted-keep.com:443']);
    });

    it('setGlobalNotificationDefault("ask") clears <all_urls> override so browser-native PrefProvider rules are not shadowed', async () => {
      chrome._state.setBrowserRule('https://mail.google.com/*', 'allow');
      chrome._state.setBrowserRule('https://scam.example/*', 'allow');
      await config.allowAndTrustDomain('ext-trusted.org:443');

      // Global block overrides browser-native PrefProvider rules while keeping extension whitelist
      await config.setGlobalNotificationDefault('block');
      assert.equal(await config.getGlobalNotificationDefault(), 'block');
      assert.equal((await chrome.contentSettings.notifications.get({ primaryUrl: 'https://scam.example/' })).setting, 'block');
      assert.equal((await chrome.contentSettings.notifications.get({ primaryUrl: 'https://ext-trusted.org/' })).setting, 'allow');

      // Restoring 'ask' removes <all_urls> from ExtensionProvider, restoring PrefProvider site rules
      await config.setGlobalNotificationDefault('ask');
      assert.equal(await config.getGlobalNotificationDefault(), 'ask');
      assert.equal((await chrome.contentSettings.notifications.get({ primaryUrl: 'https://mail.google.com/' })).setting, 'allow');
      assert.equal((await chrome.contentSettings.notifications.get({ primaryUrl: 'https://scam.example/' })).setting, 'allow');
      assert.equal((await chrome.contentSettings.notifications.get({ primaryUrl: 'https://ext-trusted.org/' })).setting, 'allow');
    });

    it('serializes incrementBlockedCount and resetBlockedCount atomically', async () => {
      const counts = await Promise.all([
        config.incrementBlockedCount(),
        config.incrementBlockedCount(),
        config.incrementBlockedCount()
      ]);
      assert.deepEqual(counts, [1, 2, 3]);
      await config.resetBlockedCount();
      const afterReset = await config.incrementBlockedCount();
      assert.equal(afterReset, 1);
    });
  });
});
