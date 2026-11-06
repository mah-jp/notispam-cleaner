const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'chrome_extension');

describe('Extension Package & Localization Integrity', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const enMessages = JSON.parse(fs.readFileSync(path.join(EXT_DIR, '_locales/en/messages.json'), 'utf8'));

  it('manifest.json conforms to Manifest V3 and references existing files and icons', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.default_locale, 'en');
    assert.ok(fs.existsSync(path.join(EXT_DIR, manifest.background.service_worker)));
    assert.ok(fs.existsSync(path.join(EXT_DIR, manifest.action.default_popup)));

    for (const cs of manifest.content_scripts) {
      for (const jsFile of cs.js) {
        assert.ok(fs.existsSync(path.join(EXT_DIR, jsFile)), `Missing content script: ${jsFile}`);
      }
    }

    for (const iconPath of Object.values(manifest.icons)) {
      assert.ok(fs.existsSync(path.join(EXT_DIR, iconPath)), `Missing manifest icon: ${iconPath}`);
    }

    // Dynamic status icons used by background.js
    for (const prefix of ['icon', 'icon-allowed', 'icon-blocked']) {
      for (const size of [16, 48, 128]) {
        const p = path.join(EXT_DIR, `icons/${prefix}-${size}.png`);
        assert.ok(fs.existsSync(p), `Missing dynamic icon: ${p}`);
      }
    }
  });

  it('all 13 supported locales exist and have identical keys and valid placeholders', () => {
    const expectedLocales = [
      'ar', 'de', 'en', 'es', 'fr', 'he', 'ja', 'ko', 'pt', 'ru', 'uk', 'zh_CN', 'zh_TW'
    ];
    const actualLocales = fs.readdirSync(path.join(EXT_DIR, '_locales')).sort();
    assert.deepEqual(actualLocales, expectedLocales);

    const enKeys = Object.keys(enMessages).sort();

    for (const locale of expectedLocales) {
      const msgPath = path.join(EXT_DIR, '_locales', locale, 'messages.json');
      const data = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
      const keys = Object.keys(data).sort();
      assert.deepEqual(keys, enKeys, `Key mismatch in locale ${locale}`);

      for (const [k, v] of Object.entries(enMessages)) {
        assert.ok(typeof data[k].message === 'string' && data[k].message.length > 0, `Empty message for ${locale}.${k}`);
        if (v.message.includes('{count}')) {
          assert.ok(data[k].message.includes('{count}'), `Missing {count} in ${locale}.${k}`);
        }
        if (v.message.includes('$domain$')) {
          assert.ok(data[k].message.includes('$domain$'), `Missing $domain$ in ${locale}.${k}`);
          assert.ok(data[k].placeholders && data[k].placeholders.domain, `Missing domain placeholder in ${locale}.${k}`);
        }
      }
    }
  });

  it('every data-i18n attribute in popup.html and chrome.i18n.getMessage call in JS exists in messages.json', () => {
    const html = fs.readFileSync(path.join(EXT_DIR, 'popup.html'), 'utf8');
    const popupJs = fs.readFileSync(path.join(EXT_DIR, 'popup.js'), 'utf8');
    const bgJs = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');

    const htmlMatches = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
    for (const key of htmlMatches) {
      assert.ok(key in enMessages, `popup.html data-i18n="${key}" missing from messages.json`);
    }

    const jsMatches = [...(popupJs + '\n' + bgJs).matchAll(/getMessage\(['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const key of jsMatches) {
      assert.ok(key in enMessages, `JS getMessage("${key}") missing from messages.json`);
    }
  });
});
