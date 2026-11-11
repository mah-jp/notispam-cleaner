const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createChromeMock,
  parseContentSettingsPattern,
  comparePatternPrecedence
} = require('./helpers/chrome_mock');
const { createPopupDocument } = require('./helpers/dom_mock');

describe('Platform Contract Verification — Chromium ContentSettings & W3C DOM', () => {
  describe('Chromium ContentSettingsPattern & HostContentSettingsMap precedence', () => {
    it('enforces lexicographic Host > Scheme > Port precedence matching Chromium ContentSettingsPattern::operator<', async () => {
      const chrome = createChromeMock();

      // Exact host with wildcard scheme (*://mail.google.com/*) MUST beat subdomain wildcard with exact scheme (https://[*.]google.com/*)
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'https://[*.]google.com/*',
        setting: 'block'
      });
      await chrome.contentSettings.notifications.set({
        primaryPattern: '*://mail.google.com/*',
        setting: 'allow'
      });

      const mailRes = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://mail.google.com/'
      });
      const docsRes = await chrome.contentSettings.notifications.get({
        primaryUrl: 'https://docs.google.com/'
      });
      assert.equal(mailRes.setting, 'allow', 'Exact host must win over [*.] wildcard regardless of scheme wildcard');
      assert.equal(docsRes.setting, 'block', 'Sibling subdomain still matches [*.]google.com');

      // Deep subdomain specificity: [*.]a.b.example.com beats [*.]b.example.com even for long 60+ char domain names
      const longRoot = 'very-long-enterprise-organization-subdomain-portal-service.example.com';
      const deeperSub = `auth.${longRoot}`;
      await chrome.contentSettings.notifications.set({
        primaryPattern: `https://[*.]${longRoot}/*`,
        setting: 'block'
      });
      await chrome.contentSettings.notifications.set({
        primaryPattern: `*://[*.]${deeperSub}/*`,
        setting: 'allow'
      });
      const deepRes = await chrome.contentSettings.notifications.get({
        primaryUrl: `https://login.${deeperSub}/`
      });
      assert.equal(deepRes.setting, 'allow', 'Deeper subdomain wildcard must beat shallower wildcard regardless of length or scheme');

      // Same host + same scheme: explicit non-default port beats wildcard port
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'http://localhost/*',
        setting: 'block'
      });
      await chrome.contentSettings.notifications.set({
        primaryPattern: 'http://localhost:3000/*',
        setting: 'allow'
      });
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'http://localhost:3000/' })).setting,
        'allow'
      );
      assert.equal(
        (await chrome.contentSettings.notifications.get({ primaryUrl: 'http://localhost:8080/' })).setting,
        'block'
      );

      // Direct comparator symmetry check
      const pExactHost = parseContentSettingsPattern('*://mail.google.com/*');
      const pWildcardSub = parseContentSettingsPattern('https://[*.]google.com/*');
      assert.ok(comparePatternPrecedence(pExactHost, pWildcardSub) > 0);
      assert.ok(comparePatternPrecedence(pWildcardSub, pExactHost) < 0);
    });

    it('rejects malformed ContentSettingsPatterns that Chromium rejects (bare *.domain, redundant default ports, invalid hosts)', async () => {
      const chrome = createChromeMock();

      await assert.rejects(
        () => chrome.contentSettings.notifications.set({ primaryPattern: 'https://*.example.com/*', setting: 'block' }),
        /Invalid primaryPattern/
      );
      await assert.rejects(
        () => chrome.contentSettings.notifications.set({ primaryPattern: 'https://example.com:443/*', setting: 'block' }),
        /default port/
      );
      await assert.rejects(
        () => chrome.contentSettings.notifications.set({ primaryPattern: 'http://example.com:80/*', setting: 'block' }),
        /default port/
      );
      await assert.rejects(
        () => chrome.contentSettings.notifications.set({ primaryPattern: 'https://example..com/*', setting: 'block' }),
        /Invalid primaryPattern/
      );
      await assert.rejects(
        () => chrome.contentSettings.notifications.set({ primaryPattern: 'https://-bad.com/*', setting: 'block' }),
        /Invalid primaryPattern/
      );
      await assert.rejects(
        () => chrome.contentSettings.notifications.set({ primaryPattern: 'https://[1:::2]/*', setting: 'block' }),
        /Invalid primaryPattern/
      );
    });

    it('emits chrome.storage.onChanged diffs and validates chrome.history.search queries', async () => {
      const chrome = createChromeMock({
        historyItems: [
          { url: 'https://alpha.example/news', title: 'Alpha News' },
          { url: 'https://beta.example/shop', title: 'Beta Store' }
        ]
      });

      const observed = [];
      chrome.storage.onChanged.addListener((changes, areaName) => {
        observed.push({ changes, areaName });
      });

      await chrome.storage.local.set({ blocked_count: 1 });
      await chrome.storage.local.set({ blocked_count: 1 }); // identical primitive -> no change event
      await chrome.storage.local.set({ blocked_count: 4 });
      await chrome.storage.local.remove('blocked_count');

      assert.equal(observed.length, 3);
      assert.equal(observed[0].areaName, 'local');
      assert.deepEqual(observed[0].changes.blocked_count, { newValue: 1 });
      assert.deepEqual(observed[1].changes.blocked_count, { oldValue: 1, newValue: 4 });
      assert.deepEqual(observed[2].changes.blocked_count, { oldValue: 4 });

      await assert.rejects(() => chrome.history.search(null), /requires \{ text: string \}/);
      await assert.rejects(() => chrome.history.search({ maxResults: 10 }), /requires \{ text: string \}/);

      const filtered = await chrome.history.search({ text: 'beta', maxResults: 1 });
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].url, 'https://beta.example/shop');
    });
  });

  describe('W3C DOM — Mixed TextNodes, <br>/<svg> siblings, and Event Bubbling', () => {
    it('preserves all text nodes across <br> line breaks and after <svg> elements in document order', () => {
      const doc = createPopupDocument();
      const box = doc.createElement('div');
      box.innerHTML = '<p>Paragraph 1<br><br>Paragraph 2<br><br>Paragraph 3</p>';
      assert.equal(box.querySelector('p').textContent, 'Paragraph 1\n\nParagraph 2\n\nParagraph 3');

      const btn = doc.createElement('button');
      btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg> Scan Now';
      assert.equal(btn.textContent.trim(), 'Scan Now');
    });

    it('bubbles click events up ancestor chain to document and honors stopPropagation()', async () => {
      const doc = createPopupDocument();
      const outer = doc.createElement('div');
      const inner = doc.createElement('div');
      const btn = doc.createElement('button');
      outer.appendChild(inner);
      inner.appendChild(btn);
      doc.body.appendChild(outer);

      const trace = [];
      outer.addEventListener('click', (e) => trace.push(`outer:${e.target.tagName}:${e.currentTarget.tagName}`));
      inner.addEventListener('click', (e) => trace.push(`inner:${e.target.tagName}:${e.currentTarget.tagName}`));
      btn.addEventListener('click', (e) => trace.push(`btn:${e.target.tagName}:${e.currentTarget.tagName}`));

      await btn.click();
      assert.deepEqual(trace, [
        'btn:BUTTON:BUTTON',
        'inner:BUTTON:DIV',
        'outer:BUTTON:DIV'
      ]);

      trace.length = 0;
      inner.addEventListener('click', (e) => e.stopPropagation());
      await btn.click();
      assert.deepEqual(trace, [
        'btn:BUTTON:BUTTON',
        'inner:BUTTON:DIV'
      ]);
    });
  });
});
