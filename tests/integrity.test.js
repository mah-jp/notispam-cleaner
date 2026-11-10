const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT_DIR, 'chrome_extension');

describe('Extension Package & Localization Integrity', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const enMessages = JSON.parse(fs.readFileSync(path.join(EXT_DIR, '_locales/en/messages.json'), 'utf8'));

  it('manifest.json conforms to Manifest V3, syncs version with package.json and README badges, and references existing files and icons', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.default_locale, 'en');

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.equal(manifest.version, pkg.version, 'manifest.json and package.json versions must match');

    const expectedBadge = `Chrome_Web_Store-v${manifest.version}-blue.svg`;
    const readmeEn = fs.readFileSync(path.join(ROOT_DIR, 'README.md'), 'utf8');
    const readmeJa = fs.readFileSync(path.join(ROOT_DIR, 'README.ja.md'), 'utf8');
    assert.ok(readmeEn.includes(expectedBadge), `README.md missing badge ${expectedBadge}`);
    assert.ok(readmeJa.includes(expectedBadge), `README.ja.md missing badge ${expectedBadge}`);
    assert.ok(!readmeEn.includes('images/'), 'README.md must not reference gitignored images/ files');
    assert.ok(!readmeJa.includes('images/'), 'README.ja.md must not reference gitignored images/ files');

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

  it('all 35 supported locales exist, conform to Chrome Web Store limits, and have identical keys and valid placeholders', () => {
    const expectedLocales = [
      'ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'fa', 'fi',
      'fr', 'he', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'ms',
      'nl', 'no', 'pl', 'pt_BR', 'pt_PT', 'ro', 'ru', 'sk', 'sl',
      'sv', 'tr', 'uk', 'vi', 'zh_CN', 'zh_TW'
    ];
    const actualLocales = fs.readdirSync(path.join(EXT_DIR, '_locales')).sort();
    assert.deepEqual(actualLocales, expectedLocales);

    const enKeys = Object.keys(enMessages).sort();

    for (const locale of expectedLocales) {
      const msgPath = path.join(EXT_DIR, '_locales', locale, 'messages.json');
      const data = JSON.parse(fs.readFileSync(msgPath, 'utf8'));
      const keys = Object.keys(data).sort();
      assert.deepEqual(keys, enKeys, `Key mismatch in locale ${locale}`);

      assert.ok(
        data.extName.message.length <= 75,
        `extName exceeds 75 chars in ${locale}: ${data.extName.message.length}`
      );
      assert.ok(
        data.extDesc.message.length <= 132,
        `extDesc exceeds 132 chars in ${locale}: ${data.extDesc.message.length}`
      );

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

  it('every data-i18n attribute in popup.html, chrome.i18n.getMessage call in JS, and message key in store asset generator exists in messages.json', () => {
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

    const storePyPath = path.join(EXT_DIR, 'scripts/generate_store_assets.py');
    if (fs.existsSync(storePyPath)) {
      const storePy = fs.readFileSync(storePyPath, 'utf8');
      const pyMatches = [...storePy.matchAll(/messages\.get\(['"]([^'"]+)['"]/g)].map(m => m[1]);
      for (const key of pyMatches) {
        assert.ok(key in enMessages, `Python script messages.get("${key}") missing from messages.json`);
      }

      assert.ok(storePy.includes('good.example.com:443'), 'Store asset generator should use RFC 2606 benign domain good.example.com:443');
      assert.ok(storePy.includes('spam.example.com:443'), 'Store asset generator should use RFC 2606 malicious domain spam.example.com:443');
      assert.ok(!storePy.includes('spam-example.com'), 'Store asset generator must not use non-reserved domain spam-example.com');
      assert.ok(!storePy.includes('www.google.com'), 'Store asset generator must not use www.google.com in screenshots');
      assert.ok(!storePy.includes('www.example.com'), 'Store asset generator should use spam.example.com instead of www.example.com');
    }
  });

  it('all 35 localized store screenshots (1280x800), promo banners (440x280), and sanitized notification captures exist and have valid PNG dimensions', (t) => {
    const imagesDir = path.join(ROOT_DIR, 'images');
    if (!fs.existsSync(imagesDir)) {
      t.skip('images/ directory is gitignored in CI checkout');
      return;
    }
    const locales = fs.readdirSync(path.join(EXT_DIR, '_locales')).sort();

    function readPngDimensions(filePath) {
      assert.ok(fs.existsSync(filePath), `Missing PNG asset: ${filePath}`);
      const buf = fs.readFileSync(filePath);
      assert.equal(buf.subarray(0, 4).toString('hex'), '89504e47', `Invalid PNG signature in ${filePath}`);
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      const bitDepth = buf[24];
      const colorType = buf[25];
      return { width, height, bitDepth, colorType };
    }

    for (const locale of locales) {
      for (const screenNum of [1, 2]) {
        const p = path.join(imagesDir, `notispam-cleaner_screen-${screenNum}_${locale}.png`);
        const { width, height, bitDepth, colorType } = readPngDimensions(p);
        assert.equal(width, 1280, `Invalid width for ${p}`);
        assert.equal(height, 800, `Invalid height for ${p}`);
        assert.equal(bitDepth, 8, `Expected 8-bit channel depth for ${p}`);
        assert.equal(colorType, 2, `Expected 24-bit RGB PNG (no alpha, colorType=2) for ${p}, got colorType=${colorType}`);
      }
    }

    for (const bannerFile of ['notispam-cleaner_banner.png', 'notispam-cleaner_banner_en.png']) {
      const bannerDim = readPngDimensions(path.join(imagesDir, bannerFile));
      assert.equal(bannerDim.width, 440, `Invalid width for ${bannerFile}`);
      assert.equal(bannerDim.height, 280, `Invalid height for ${bannerFile}`);
      assert.equal(bannerDim.bitDepth, 8, `Expected 8-bit channel depth for ${bannerFile}`);
      assert.equal(bannerDim.colorType, 2, `Expected 24-bit RGB PNG (no alpha, colorType=2) for ${bannerFile}`);
    }

    for (const origToast of ['Screenshot 2026-05-29 at 1.25.47.png', 'スクリーンショット 2026-05-29 1.29.26.png']) {
      const toastDim = readPngDimensions(path.join(imagesDir, '_original', origToast));
      assert.equal(toastDim.width, 728, `Invalid width for ${origToast}`);
      assert.equal(toastDim.height, 252, `Invalid height for ${origToast}`);
    }
  });

  it('scripts/cws-store-listings.json contains valid Detailed Descriptions and asset mappings for all 35 locales', () => {
    const listingsPath = path.join(ROOT_DIR, 'scripts/cws-store-listings.json');
    assert.ok(fs.existsSync(listingsPath), 'Missing scripts/cws-store-listings.json');
    const listings = JSON.parse(fs.readFileSync(listingsPath, 'utf8'));

    const expectedLocales = fs.readdirSync(path.join(EXT_DIR, '_locales')).sort();
    assert.deepEqual(Object.keys(listings).sort(), expectedLocales);

    for (const locale of expectedLocales) {
      const entry = listings[locale];
      const msgData = JSON.parse(fs.readFileSync(path.join(EXT_DIR, '_locales', locale, 'messages.json'), 'utf8'));

      assert.equal(entry.locale, locale);
      assert.ok(Array.isArray(entry.languageNames) && entry.languageNames.length >= 2, `Missing languageNames for ${locale}`);
      assert.equal(entry.extName, msgData.extName.message, `extName mismatch in cws-store-listings.json for ${locale}`);
      assert.equal(entry.extDesc, msgData.extDesc.message, `extDesc mismatch in cws-store-listings.json for ${locale}`);

      assert.ok(
        typeof entry.detailedDescription === 'string' &&
        entry.detailedDescription.length >= 400 &&
        entry.detailedDescription.length <= 16000,
        `Invalid detailedDescription length for ${locale}: ${entry.detailedDescription?.length}`
      );
      assert.ok(
        entry.detailedDescription.includes('https://github.com/mah-jp/notispam-cleaner'),
        `Missing GitHub repository URL in detailedDescription for ${locale}`
      );

      for (const uiKey of ['scanBtn', 'cleanAllBtn', 'realtimeGuardLabel', 'silentGuardianLabel', 'openSettingsBtn']) {
        const label = msgData[uiKey].message;
        assert.ok(
          entry.detailedDescription.toLowerCase().includes(label.toLowerCase()),
          `detailedDescription for ${locale} should reference localized ${uiKey} ("${label}")`
        );
      }

      for (const prefixKey of ['suspiciousLabel', 'trustedLabel']) {
        const prefix = msgData[prefixKey].message.split('(')[0].split('（')[0].trim();
        assert.ok(
          entry.detailedDescription.toLowerCase().includes(prefix.toLowerCase()),
          `detailedDescription for ${locale} should reference localized ${prefixKey} ("${prefix}")`
        );
      }

      assert.deepEqual(entry.screenshots, [
        `images/notispam-cleaner_screen-1_${locale}.png`,
        `images/notispam-cleaner_screen-2_${locale}.png`
      ]);
      assert.equal(
        entry.promoBanner,
        locale === 'ja' ? 'images/notispam-cleaner_banner.png' : 'images/notispam-cleaner_banner_en.png'
      );
    }

    const cwsEnPath = path.join(ROOT_DIR, 'CHROMEWEBSTORE.md');
    if (fs.existsSync(cwsEnPath)) {
      const cwsEn = fs.readFileSync(cwsEnPath, 'utf8');
      assert.ok(cwsEn.includes(listings.en.extName), 'CHROMEWEBSTORE.md must include English extName');
      assert.ok(cwsEn.includes(listings.en.extDesc), 'CHROMEWEBSTORE.md must include English extDesc');
      assert.ok(cwsEn.includes(listings.en.detailedDescription), 'CHROMEWEBSTORE.md must match en.detailedDescription');
    }

    const cwsJaPath = path.join(ROOT_DIR, 'CHROMEWEBSTORE_JA.md');
    if (fs.existsSync(cwsJaPath)) {
      const cwsJa = fs.readFileSync(cwsJaPath, 'utf8');
      assert.ok(cwsJa.includes(listings.ja.extName), 'CHROMEWEBSTORE_JA.md must include Japanese extName');
      assert.ok(cwsJa.includes(listings.ja.extDesc), 'CHROMEWEBSTORE_JA.md must include Japanese extDesc');
      assert.ok(cwsJa.includes(listings.ja.detailedDescription), 'CHROMEWEBSTORE_JA.md must match ja.detailedDescription');
    }
  });
});
