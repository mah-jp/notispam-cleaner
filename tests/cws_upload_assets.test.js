const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cwsAssets = require('../scripts/cws-upload-assets.js');

const silentLogger = {
  log: () => {},
  error: () => {}
};

/**
 * Create a minimal valid 24-byte PNG header buffer with the specified width and height.
 */
function createDummyPngBuffer(width, height) {
  const buf = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'ascii').copy(buf, 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/**
 * Populate a temporary images directory with valid dummy PNGs for the requested locales.
 */
function createTempImagesDir(locales = ['en', 'ja']) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-assets-test-'));
  for (const loc of locales) {
    fs.writeFileSync(
      path.join(tmpDir, `notispam-cleaner_screen-1_${loc}.png`),
      createDummyPngBuffer(1280, 800)
    );
    fs.writeFileSync(
      path.join(tmpDir, `notispam-cleaner_screen-2_${loc}.png`),
      createDummyPngBuffer(1280, 800)
    );
  }
  fs.writeFileSync(
    path.join(tmpDir, 'notispam-cleaner_banner.png'),
    createDummyPngBuffer(440, 280)
  );
  fs.writeFileSync(
    path.join(tmpDir, 'notispam-cleaner_banner_en.png'),
    createDummyPngBuffer(440, 280)
  );
  return tmpDir;
}

describe('scripts/cws-upload-assets.js — Chrome Web Store Store Listing Automation', () => {
  describe('parseArgs', () => {
    it('parses CLI flags in both space-separated and = formats', () => {
      const parsed = cwsAssets.parseArgs([
        '--publisher-id', 'pub-999',
        '--extension-id=ext-888',
        '--locales', 'ja,en,zh_CN',
        '--images-dir=/tmp/imgs',
        '--listings-path', '/tmp/listings.json',
        '--skip-screenshots',
        '--skip-banner',
        '--keep-existing-screenshots',
        '--dry-run',
        '--cdp-url=http://127.0.0.1:9333',
        '--debugging-port', '9444',
        '--user-data-dir=/tmp/profile',
        '--browser-path', '/usr/bin/google-chrome',
        '--headless',
        '--login-timeout=120000',
        '--step-delay', '250'
      ]);

      assert.equal(parsed.publisherId, 'pub-999');
      assert.equal(parsed.extensionId, 'ext-888');
      assert.equal(parsed.locales, 'ja,en,zh_CN');
      assert.equal(parsed.imagesDir, '/tmp/imgs');
      assert.equal(parsed.listingsPath, '/tmp/listings.json');
      assert.equal(parsed.skipScreenshots, true);
      assert.equal(parsed.skipDescriptions, false);
      assert.equal(parsed.skipBanner, true);
      assert.equal(parsed.keepExistingScreenshots, true);
      assert.equal(parsed.dryRun, true);
      assert.equal(parsed.cdpUrl, 'http://127.0.0.1:9333');
      assert.equal(parsed.debuggingPort, 9444);
      assert.equal(parsed.userDataDir, '/tmp/profile');
      assert.equal(parsed.browserPath, '/usr/bin/google-chrome');
      assert.equal(parsed.headless, true);
      assert.equal(parsed.loginTimeoutMs, 120000);
      assert.equal(parsed.stepDelayMs, 250);
    });

    it('throws on unknown or incomplete flags, empty inline values, and invalid integer options', () => {
      assert.throws(() => cwsAssets.parseArgs(['--bogus']), /Unknown or incomplete argument: --bogus/);
      assert.throws(() => cwsAssets.parseArgs(['--locales']), /Unknown or incomplete argument: --locales/);
      assert.throws(() => cwsAssets.parseArgs(['--locales=']), /Unknown or incomplete argument: --locales=/);
      assert.throws(() => cwsAssets.parseArgs(['--images-dir=']), /Unknown or incomplete argument: --images-dir=/);
      assert.throws(() => cwsAssets.parseArgs(['--publisher-id', '-h']), /Unknown or incomplete argument: --publisher-id/);
      assert.throws(() => cwsAssets.parseArgs(['--locales', '--dry-run']), /Unknown or incomplete argument: --locales/);
      assert.throws(() => cwsAssets.parseArgs(['--debugging-port', '0']), /Invalid port "0"/);
      assert.throws(() => cwsAssets.parseArgs(['--debugging-port=70000']), /Invalid port "70000"/);
      assert.throws(() => cwsAssets.parseArgs(['--debugging-port=abc']), /Invalid port "abc"/);
      assert.throws(() => cwsAssets.parseArgs(['--login-timeout', '-10']), /Invalid login-timeout "-10"/);
    });
  });

  describe('validatePngAsset & buildUploadPlan', () => {
    it('validates PNG signature and dimensions and rejects invalid assets', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-png-'));
      try {
        const validScreen = path.join(tmpDir, 'valid-screen.png');
        const wrongSize = path.join(tmpDir, 'wrong-size.png');
        const badSig = path.join(tmpDir, 'bad-sig.png');
        const tooSmall = path.join(tmpDir, 'tiny.png');

        fs.writeFileSync(validScreen, createDummyPngBuffer(1280, 800));
        fs.writeFileSync(wrongSize, createDummyPngBuffer(800, 600));
        fs.writeFileSync(badSig, Buffer.alloc(32, 0x41));
        fs.writeFileSync(tooSmall, Buffer.from('short'));

        const res = cwsAssets.validatePngAsset(validScreen, 1280, 800);
        assert.equal(res.width, 1280);
        assert.equal(res.height, 800);

        assert.throws(
          () => cwsAssets.validatePngAsset(path.join(tmpDir, 'missing.png'), 1280, 800),
          /Missing PNG asset file/
        );
        assert.throws(
          () => cwsAssets.validatePngAsset(tooSmall, 1280, 800),
          /PNG asset is empty or too small/
        );
        assert.throws(
          () => cwsAssets.validatePngAsset(badSig, 1280, 800),
          /Invalid PNG file signature/
        );
        assert.throws(
          () => cwsAssets.validatePngAsset(wrongSize, 1280, 800),
          /Invalid PNG dimensions .* expected 1280x800, got 800x600/
        );

        const rgbaScreen = path.join(tmpDir, 'rgba-screen.png');
        const rgbaBuf = createDummyPngBuffer(1280, 800);
        rgbaBuf[24] = 8; // 8-bit depth
        rgbaBuf[25] = 6; // colorType 6 = RGBA (32-bit with alpha)
        fs.writeFileSync(rgbaScreen, rgbaBuf);
        assert.throws(
          () => cwsAssets.validatePngAsset(rgbaScreen, 1280, 800),
          /Invalid PNG color type .* requires 24-bit PNG \(no alpha channel\), got colorType=6/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('builds upload plan for all 35 locales with en and ja prioritized first', () => {
      const listings = cwsAssets.loadStoreListings();
      const allLocales = Object.keys(listings);
      assert.equal(allLocales.length, 35);

      const tmpDir = createTempImagesDir(allLocales);
      try {
        const plan = cwsAssets.buildUploadPlan(
          { imagesDir: tmpDir, publisherId: 'pub-123' },
          {}
        );

        assert.equal(plan.localePlans.length, 35);
        assert.equal(plan.localePlans[0].locale, 'en');
        assert.equal(plan.localePlans[1].locale, 'ja');
        assert.equal(
          plan.directStoreListingUrl,
          `https://chrome.google.com/webstore/devconsole/pub-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`
        );
        assert.ok(plan.localePlans[0].promoBannerFile.endsWith('notispam-cleaner_banner_en.png'));
        assert.ok(plan.localePlans[1].promoBannerFile.endsWith('notispam-cleaner_banner.png'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('rejects unsupported locales, empty --locales, or skipping all tasks', () => {
      assert.throws(
        () => cwsAssets.buildUploadPlan({
          skipScreenshots: true,
          skipDescriptions: true,
          skipBanner: true
        }),
        /Nothing to do/
      );

      assert.throws(
        () => cwsAssets.buildUploadPlan({
          locales: 'en,xx_INVALID',
          skipScreenshots: true,
          skipBanner: true
        }),
        /Unsupported locale\(s\): xx_INVALID/
      );

      assert.throws(
        () => cwsAssets.buildUploadPlan({
          locales: ' , ',
          skipScreenshots: true,
          skipBanner: true
        }),
        /Invalid --locales value/
      );
    });
  });

  describe('resolveBrowserExecutable', () => {
    it('resolves existing browser binary or throws clear error when missing', () => {
      const fakeFs = {
        existsSync: (p) => p === '/opt/google/chrome/chrome'
      };
      assert.equal(
        cwsAssets.resolveBrowserExecutable(null, fakeFs, 'linux'),
        '/opt/google/chrome/chrome'
      );

      assert.throws(
        () => cwsAssets.resolveBrowserExecutable('/nonexistent/chrome', { existsSync: () => false }, 'linux'),
        /Specified browser executable not found/
      );

      assert.throws(
        () => cwsAssets.resolveBrowserExecutable(null, { existsSync: () => false }, 'linux'),
        /Could not find Google Chrome or Chromium executable/
      );
    });
  });

  describe('In-page DOM manipulation helpers', () => {
    it('domSelectLocale disambiguates regional variants (pt_BR vs pt_PT, zh_CN vs zh_TW) in select and listbox dropdowns', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;
      const prevEvent = global.Event;

      class MockEvent {
        constructor(type, opts) {
          this.type = type;
          this.bubbles = Boolean(opts?.bubbles);
        }
      }

      const options = [
        {
          value: 'pt_PT',
          textContent: 'ポルトガル語（ポルトガル）',
          getAttribute(k) { return k === 'value' ? 'pt_PT' : null; },
          getBoundingClientRect: () => ({ width: 120, height: 24 })
        },
        {
          value: 'pt_BR',
          textContent: 'ポルトガル語（ブラジル）',
          getAttribute(k) { return k === 'value' ? 'pt_BR' : null; },
          getBoundingClientRect: () => ({ width: 120, height: 24 })
        }
      ];
      const selectEl = {
        value: 'en',
        options,
        events: [],
        dispatchEvent(ev) { this.events.push(ev.type); },
        getBoundingClientRect: () => ({ width: 200, height: 32 })
      };

      global.Event = MockEvent;
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };
      global.document = {
        querySelectorAll(sel) {
          if (sel === 'select') return [selectEl];
          return [];
        }
      };

      try {
        const res = await cwsAssets.domSelectLocale('pt_BR', [
          'Portuguese (Brazil)',
          'ポルトガル語（ブラジル）',
          'pt_BR'
        ]);
        assert.equal(res.matched, true);
        assert.equal(res.type, 'select');
        assert.equal(selectEl.value, 'pt_BR');
        assert.deepEqual(selectEl.events, ['input', 'change']);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
        global.Event = prevEvent;
      }
    });

    it('domFillDetailedDescription populates Detailed Description textarea while ignoring Short Description', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;
      const prevEvent = global.Event;

      class MockEvent {
        constructor(type) { this.type = type; }
      }

      const shortTa = {
        value: 'short',
        rows: 2,
        events: [],
        getAttribute(k) { return k === 'aria-label' ? 'Short description' : ''; },
        closest: () => ({ textContent: 'Short description' }),
        dispatchEvent(e) { this.events.push(e.type); },
        getBoundingClientRect: () => ({ width: 400, height: 50 })
      };
      const detailedTa = {
        value: '',
        rows: 12,
        events: [],
        getAttribute(k) { return k === 'aria-label' ? 'Detailed description' : ''; },
        closest: () => ({ textContent: 'Detailed description' }),
        dispatchEvent(e) { this.events.push(e.type); },
        getBoundingClientRect: () => ({ width: 400, height: 300 })
      };

      global.Event = MockEvent;
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        HTMLTextAreaElement: { prototype: {} }
      };
      global.document = {
        querySelectorAll(sel) {
          if (sel === 'textarea') return [shortTa, detailedTa];
          return [];
        }
      };

      try {
        const res = cwsAssets.domFillDetailedDescription('Full localized detailed description text');
        assert.equal(res.updated, true);
        assert.equal(shortTa.value, 'short');
        assert.equal(detailedTa.value, 'Full localized detailed description text');
        assert.deepEqual(detailedTa.events, ['input', 'change', 'blur']);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
        global.Event = prevEvent;
      }
    });

    it('domFindAssetFileInput distinguishes Screenshots input from Small Promo Tile input and Store Icon input', () => {
      const prevDocument = global.document;

      const iconInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: { textContent: 'Store icon (128x128)', parentElement: null }
      };
      const screenInput = {
        multiple: true,
        getAttribute: () => '',
        parentElement: { textContent: 'Screenshots (1280x800 or 640x400)', parentElement: null }
      };
      const promoInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: { textContent: 'Small promo tile (440x280)', parentElement: null }
      };

      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [iconInput, screenInput, promoInput];
          return [];
        }
      };

      try {
        assert.equal(cwsAssets.domFindAssetFileInput('screenshots'), screenInput);
        assert.equal(cwsAssets.domFindAssetFileInput('banner'), promoInput);
      } finally {
        global.document = prevDocument;
      }
    });

    it('domFillDetailedDescription does NOT overwrite Short Description when label is only in parent container or maxLength <= 200', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;
      const prevEvent = global.Event;

      class MockEvent {
        constructor(type) { this.type = type; }
      }

      // Short description textarea has NO aria-label on itself, only parent text "Short description"
      const shortOuter = { textContent: 'Short description (132 chars max)', parentElement: null };
      const shortInner = { textContent: '', parentElement: shortOuter };
      const shortTa = {
        value: 'Keep this summary intact',
        rows: 3,
        maxLength: 132,
        events: [],
        parentElement: shortInner,
        getAttribute: () => '',
        dispatchEvent(e) { this.events.push(e.type); },
        getBoundingClientRect: () => ({ width: 400, height: 60 })
      };
      shortOuter.querySelectorAll = () => [shortTa];
      shortInner.querySelectorAll = () => [shortTa];

      const detailedOuter = { textContent: 'Detailed description', parentElement: null };
      const detailedInner = { textContent: '', parentElement: detailedOuter };
      const detailedTa = {
        value: '',
        rows: 10,
        maxLength: 16000,
        events: [],
        parentElement: detailedInner,
        getAttribute: () => '',
        dispatchEvent(e) { this.events.push(e.type); },
        getBoundingClientRect: () => ({ width: 400, height: 260 })
      };
      detailedOuter.querySelectorAll = () => [detailedTa];
      detailedInner.querySelectorAll = () => [detailedTa];

      global.Event = MockEvent;
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
        HTMLTextAreaElement: { prototype: {} }
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'textarea') return [shortTa, detailedTa];
          return [];
        }
      };

      try {
        const res = cwsAssets.domFillDetailedDescription('Updated detailed description body');
        assert.equal(res.updated, true);
        assert.equal(shortTa.value, 'Keep this summary intact');
        assert.equal(detailedTa.value, 'Updated detailed description body');
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
        global.Event = prevEvent;
      }
    });

    it('domFindAssetFileInput does NOT return Store Icon input when all inputs share a Graphic Assets parent container', () => {
      const prevDocument = global.document;

      const sharedGraphicAssetsSection = {
        textContent: 'Graphic assets: Store icon (128x128), Screenshots (1280x800), Small promo tile (440x280)',
        parentElement: null
      };
      const iconWrapper = {
        textContent: 'Store icon (128x128)',
        parentElement: sharedGraphicAssetsSection
      };
      const screenWrapper = {
        textContent: 'Screenshots (up to 5, 1280x800)',
        parentElement: sharedGraphicAssetsSection
      };
      const promoWrapper = {
        textContent: 'Small promo tile (440x280)',
        parentElement: sharedGraphicAssetsSection
      };

      const iconInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: { textContent: 'Upload file', parentElement: iconWrapper }
      };
      const screenInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: { textContent: 'Upload file', parentElement: screenWrapper }
      };
      const promoInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: { textContent: 'Upload file', parentElement: promoWrapper }
      };

      sharedGraphicAssetsSection.querySelectorAll = () => [iconInput, screenInput, promoInput];
      iconWrapper.querySelectorAll = () => [iconInput];
      screenWrapper.querySelectorAll = () => [screenInput];
      promoWrapper.querySelectorAll = () => [promoInput];
      iconInput.parentElement.querySelectorAll = () => [iconInput];
      screenInput.parentElement.querySelectorAll = () => [screenInput];
      promoInput.parentElement.querySelectorAll = () => [promoInput];

      global.document = {
        body: sharedGraphicAssetsSection,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [iconInput, screenInput, promoInput];
          return [];
        }
      };

      try {
        assert.equal(cwsAssets.domFindAssetFileInput('screenshots'), screenInput);
        assert.equal(cwsAssets.domFindAssetFileInput('banner'), promoInput);
      } finally {
        global.document = prevDocument;
      }
    });

    it('domClearExistingScreenshots only clicks delete buttons inside Screenshots container and never falls back to document', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let iconDeleteClicked = 0;
      let screenDeleteClicked = 0;
      let promoDeleteClicked = 0;

      const iconDeleteBtn = {
        textContent: 'Delete',
        getAttribute: (k) => (k === 'aria-label' ? 'Delete icon' : ''),
        getBoundingClientRect: () => ({ width: 30, height: 30 }),
        click() { iconDeleteClicked++; }
      };
      const screenDeleteBtn = {
        textContent: 'Delete',
        getAttribute: (k) => (k === 'aria-label' ? 'Delete' : ''),
        getBoundingClientRect: () => ({ width: 30, height: 30 }),
        click() { screenDeleteClicked++; }
      };
      const promoDeleteBtn = {
        textContent: 'Delete',
        getAttribute: (k) => (k === 'aria-label' ? 'Delete' : ''),
        getBoundingClientRect: () => ({ width: 30, height: 30 }),
        click() { promoDeleteClicked++; }
      };

      const screenContainer = {
        textContent: 'Screenshots (1280x800)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{}];
          return [screenDeleteBtn];
        }
      };
      const sharedSection = {
        textContent: 'Graphic assets: Store icon, Screenshots, Small promo tile',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{}, {}, {}];
          return [iconDeleteBtn, screenDeleteBtn, promoDeleteBtn];
        }
      };

      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      global.document = {
        querySelectorAll(sel) {
          if (sel.includes('section')) return [sharedSection, screenContainer];
          return [iconDeleteBtn, screenDeleteBtn, promoDeleteBtn];
        }
      };

      try {
        const res = await cwsAssets.domClearExistingScreenshots();
        assert.equal(res.removedCount, 1);
        assert.equal(screenDeleteClicked, 1);
        assert.equal(iconDeleteClicked, 0);
        assert.equal(promoDeleteClicked, 0);

        // When no screenshot container exists at all, it must return 0 and not click document buttons
        global.document.querySelectorAll = (sel) => (sel.includes('section') ? [sharedSection] : []);
        const resEmpty = await cwsAssets.domClearExistingScreenshots();
        assert.equal(resEmpty.removedCount, 0);
        assert.equal(iconDeleteClicked, 0);
        assert.equal(promoDeleteClicked, 0);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domSelectLocale prioritizes Language combobox over Category combobox and matches normalized (Default) / check labels and iw code', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;
      const prevKeyboardEvent = global.KeyboardEvent;

      class MockKeyboardEvent {
        constructor(type, opts) {
          this.type = type;
          this.key = opts?.key;
        }
      }

      let activeListbox = null;
      let selectedItem = null;

      const categoryCombo = {
        textContent: 'Productivity',
        parentElement: { textContent: 'Category: Productivity', parentElement: null },
        getAttribute: (k) => (k === 'aria-label' ? 'Category' : ''),
        getBoundingClientRect: () => ({ width: 180, height: 36 }),
        click() { activeListbox = 'category'; },
        dispatchEvent() {}
      };
      const languageCombo = {
        textContent: 'English (Default)',
        parentElement: { textContent: 'Listing language: English (Default)', parentElement: null },
        getAttribute: (k) => (k === 'aria-label' ? 'Listing language' : ''),
        getBoundingClientRect: () => ({ width: 220, height: 36 }),
        click() { activeListbox = 'language'; },
        dispatchEvent() {}
      };

      const languageOptions = [
        {
          textContent: 'check English (Default)',
          getAttribute: () => '',
          getBoundingClientRect: () => ({ width: 200, height: 32 }),
          scrollIntoView() {},
          click() { selectedItem = 'en'; }
        },
        {
          textContent: 'עברית',
          getAttribute: (k) => (k === 'data-value' ? 'iw' : ''),
          getBoundingClientRect: () => ({ width: 200, height: 32 }),
          scrollIntoView() {},
          click() { selectedItem = 'he'; }
        }
      ];

      global.KeyboardEvent = MockKeyboardEvent;
      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };
      global.document = {
        body: { click() {} },
        dispatchEvent() {},
        querySelectorAll(sel) {
          if (sel === 'select') return [];
          if (sel.includes('[role="combobox"]')) return [categoryCombo, languageCombo];
          if (sel.includes('[role="option"]')) {
            return activeListbox === 'language' ? languageOptions : [];
          }
          return [];
        }
      };

      try {
        const resEn = await cwsAssets.domSelectLocale('en', ['English', '英語', 'en']);
        assert.equal(resEn.matched, true);
        assert.equal(selectedItem, 'en');

        const resHe = await cwsAssets.domSelectLocale('he', ['Hebrew', 'עברית', 'he', 'iw']);
        assert.equal(resHe.matched, true);
        assert.equal(selectedItem, 'he');
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
        global.KeyboardEvent = prevKeyboardEvent;
      }
    });

    it('domFindAssetFileInput prioritizes Localized Screenshots (ローカライズ版スクリーンショット) over Global Screenshots (グローバル スクリーンショット) even at depth > 6 or sibling heading layouts', () => {
      const prevDocument = global.document;

      // Global screenshots has "1280x800" at depth 1, and "グローバル スクリーンショット" at depth 3
      const globalRow = { textContent: 'グローバル スクリーンショット 1280x800', parentElement: null };
      const globalMid = { textContent: '1280x800 PNG', parentElement: globalRow };
      const globalInput = {
        multiple: true,
        getAttribute: () => '',
        parentElement: { textContent: '1280x800', parentElement: globalMid }
      };
      globalRow.querySelectorAll = () => [globalInput];
      globalMid.querySelectorAll = () => [globalInput];
      globalInput.parentElement.querySelectorAll = () => [globalInput];

      // Localized screenshots has its heading at depth 9 and in a preceding sibling
      const localizedHeadingSib = {
        textContent: 'ローカライズ版スクリーンショット (1280x800 または 640x400)',
        querySelectorAll: () => []
      };
      let locNode = {
        textContent: 'ここにファイルをドラッグ＆ドロップ',
        previousElementSibling: localizedHeadingSib,
        parentElement: null
      };
      const chainNodes = [locNode];
      for (let d = 0; d < 8; d++) {
        const child = {
          textContent: 'ここにファイルをドラッグ＆ドロップ',
          parentElement: locNode
        };
        chainNodes.push(child);
        locNode = child;
      }
      const localizedInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: locNode
      };
      for (const n of chainNodes) {
        n.querySelectorAll = () => [localizedInput];
      }

      const iconInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: {
          textContent: 'ストア アイコン (128x128)',
          parentElement: null,
          querySelectorAll: () => [iconInput]
        }
      };
      const promoInput = {
        multiple: false,
        getAttribute: () => '',
        parentElement: {
          textContent: '小プロモーション タイル (440x280)',
          parentElement: null,
          querySelectorAll: () => [promoInput]
        }
      };

      global.document = {
        body: {},
        querySelectorAll(sel) {
          // Put globalInput BEFORE localizedInput to verify priority overrides DOM order and depth
          if (sel === 'input[type="file"]') return [globalInput, iconInput, localizedInput, promoInput];
          return [];
        }
      };

      try {
        assert.equal(cwsAssets.domFindAssetFileInput('screenshots'), localizedInput);
        assert.equal(cwsAssets.domFindAssetFileInput('banner'), promoInput);
      } finally {
        global.document = prevDocument;
      }
    });

    it('domClearExistingScreenshots ignores bare leaf heading <div> and Global Screenshots, clicking delete only in Localized Screenshots', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let globalDeleteClicked = 0;
      let localizedDeleteClicked = 0;

      const globalDelBtn = {
        textContent: 'delete',
        getAttribute: () => '',
        click() { globalDeleteClicked++; }
      };
      const localizedDelBtn = {
        textContent: 'delete',
        getAttribute: () => '',
        click() { localizedDeleteClicked++; }
      };

      // Bare heading div (shortest textContent, but has NO file input and NO buttons)
      const bareHeadingDiv = {
        textContent: 'ローカライズ版スクリーンショット',
        querySelectorAll: () => []
      };
      // Global screenshots container (has file input and delete button, but must be ignored)
      const globalContainer = {
        textContent: 'グローバル スクリーンショット (1280x800)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{}];
          if (sel.includes('aria-label')) return [];
          return [globalDelBtn];
        }
      };
      // Localized screenshots container (longer text than bareHeadingDiv, owns file input + Material icon delete button)
      const localizedContainer = {
        textContent: 'ローカライズ版スクリーンショット 最大 5 個 (1280x800 または 640x400)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{}];
          if (sel.includes('aria-label')) return [];
          return [localizedDelBtn];
        }
      };

      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      global.document = {
        querySelectorAll(sel) {
          if (sel.includes('section')) return [bareHeadingDiv, globalContainer, localizedContainer];
          return [];
        }
      };

      try {
        const res = await cwsAssets.domClearExistingScreenshots();
        assert.equal(res.removedCount, 1);
        assert.equal(localizedDeleteClicked, 1);
        assert.equal(globalDeleteClicked, 0);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domClickSaveDraft waits for temporarily disabled Save Draft button to become enabled after screenshot upload', async () => {
      const prevDocument = global.document;

      let clicked = false;
      const saveBtn = {
        disabled: true,
        textContent: '下書きとして保存',
        getAttribute: () => null,
        click() { clicked = true; }
      };

      setTimeout(() => {
        saveBtn.disabled = false;
      }, 120);

      global.document = {
        querySelectorAll() {
          return [saveBtn];
        }
      };

      try {
        const res = await cwsAssets.domClickSaveDraft();
        assert.equal(res.clicked, true);
        assert.equal(res.label, '下書きとして保存');
        assert.equal(clicked, true);
      } finally {
        global.document = prevDocument;
      }
    });

    it('domFindAssetFileInput intercepts HTMLInputElement.prototype.click and clicks upload trigger inside Localized Screenshots to capture dynamic/shared file input', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let nativeOsDialogOpened = false;
      class MockHTMLInputElement {
        click() {
          nativeOsDialogOpened = true;
        }
      }
      const origProtoClick = MockHTMLInputElement.prototype.click;

      const dynamicInput = new MockHTMLInputElement();
      dynamicInput.type = 'file';

      const deleteBtn = {
        textContent: '削除',
        getAttribute: () => '',
        click() {
          throw new Error('Must never click delete button');
        }
      };
      const addFileBtn = {
        textContent: 'ファイルを追加',
        getAttribute: () => '',
        click() {
          // Simulate CWS creating/arming a detached <input type="file"> on button click
          dynamicInput.click();
        }
      };

      const localizedSection = {
        textContent: 'ローカライズ版スクリーンショット (1280x800)',
        querySelectorAll() {
          return [deleteBtn, addFileBtn];
        }
      };

      global.window = {
        HTMLInputElement: MockHTMLInputElement
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel.includes('section')) return [localizedSection];
          // No static <input type="file"> in DOM!
          if (sel === 'input[type="file"]') return [];
          return [];
        }
      };

      try {
        const found = cwsAssets.domFindAssetFileInput('screenshots');
        assert.equal(found, dynamicInput);
        assert.equal(nativeOsDialogOpened, false);
        assert.equal(MockHTMLInputElement.prototype.click, origProtoClick);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domFindAssetFileInput and domClearExistingScreenshots handle cross-referencing helper subtitles between Localized and Global Screenshots', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let globalDeleted = 0;
      let localizedDeleted = 0;

      const globalDelBtn = {
        textContent: 'delete',
        getAttribute: () => '',
        click() { globalDeleted++; }
      };
      const localizedDelBtn = {
        textContent: 'delete',
        getAttribute: () => '',
        click() { localizedDeleted++; }
      };
      // Header inside Localized section has a Help button (shorter text, no delete button)
      const localizedHeaderWithHelpBtn = {
        textContent: 'ローカライズされたスクリーンショット ?',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          if (sel.includes('aria-label')) return [];
          return [{ textContent: '?', getAttribute: () => 'Help' }];
        }
      };

      const globalInput = {
        multiple: true,
        getAttribute: () => '',
        parentElement: null
      };
      const localizedInput = {
        multiple: true,
        getAttribute: () => '',
        parentElement: null
      };

      // Global Screenshots section mentions "ローカライズ版スクリーンショット" in its fallback explanation
      const globalContainer = {
        textContent:
          'グローバル スクリーンショット (1280x800) ローカライズ版スクリーンショットが指定されていないすべての言語で表示されます。',
        parentElement: null,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [globalInput];
          if (sel.includes('aria-label')) return [];
          return [globalDelBtn];
        }
      };
      globalInput.parentElement = globalContainer;

      // Localized Screenshots section mentions "グローバル スクリーンショット" in its fallback explanation
      const localizedContainer = {
        textContent:
          'ローカライズされたスクリーンショット (1280x800) 指定しない場合はグローバル スクリーンショットが使用されます。',
        parentElement: null,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [localizedInput];
          if (sel.includes('aria-label')) return [];
          return [localizedDelBtn];
        }
      };
      localizedInput.parentElement = localizedContainer;

      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [globalInput, localizedInput];
          if (sel.includes('section')) return [localizedHeaderWithHelpBtn, globalContainer, localizedContainer];
          return [];
        }
      };

      try {
        const picked = cwsAssets.domFindAssetFileInput('screenshots');
        assert.equal(picked, localizedInput);

        const clearRes = await cwsAssets.domClearExistingScreenshots();
        assert.equal(clearRes.removedCount, 1);
        assert.equal(localizedDeleted, 1);
        assert.equal(globalDeleted, 0);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domFindAssetFileInput skips outer [jsaction*="click"] wrapper in favor of inner <label> trigger and captures <label> file input via capture listener', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      class MockHTMLInputElement {
        click() {}
      }
      const labelFileInput = new MockHTMLInputElement();
      labelFileInput.type = 'file';

      let outerWrapperClicked = 0;
      let innerLabelClicked = 0;
      let capturedListener = null;
      let defaultPrevented = false;

      const innerLabel = {
        textContent: 'ファイルを選択',
        control: labelFileInput,
        getAttribute: () => '',
        contains: () => false,
        click() {
          innerLabelClicked++;
          // Simulate Chromium native <label> activation dispatching click event directly to <input type="file">
          // without invoking HTMLInputElement.prototype.click
          if (capturedListener) {
            capturedListener({
              target: labelFileInput,
              preventDefault() { defaultPrevented = true; },
              stopPropagation() {}
            });
          }
        }
      };

      const outerJsActionDiv = {
        textContent: 'ここにドラッグ＆ドロップするか ファイルを選択',
        getAttribute: () => '',
        contains(other) {
          return other === innerLabel;
        },
        click() {
          outerWrapperClicked++;
        }
      };

      const localizedSection = {
        textContent: 'ローカライズ版スクリーンショット (1280x800)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          return [outerJsActionDiv, innerLabel];
        }
      };

      global.window = {
        HTMLInputElement: MockHTMLInputElement,
        addEventListener(type, fn, capture) {
          if (type === 'click' && capture) capturedListener = fn;
        },
        removeEventListener(type, fn) {
          if (type === 'click' && capturedListener === fn) capturedListener = null;
        }
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel.includes('section')) return [localizedSection];
          if (sel === 'input[type="file"]') return [];
          return [];
        }
      };

      try {
        const found = cwsAssets.domFindAssetFileInput('screenshots');
        assert.equal(found, labelFileInput);
        assert.equal(outerWrapperClicked, 0);
        assert.equal(innerLabelClicked, 1);
        assert.equal(defaultPrevented, true);
        assert.equal(capturedListener, null);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });
  });

  describe('uploadStoreListingAssets — End-to-End Orchestration & Dry-Run', () => {
    it('executes --dry-run and returns full validation summary without opening browser', async () => {
      const tmpDir = createTempImagesDir(['en', 'ja', 'ar']);
      try {
        const res = await cwsAssets.uploadStoreListingAssets(
          {
            dryRun: true,
            locales: 'en,ja,ar',
            imagesDir: tmpDir
          },
          {},
          { logger: silentLogger }
        );

        assert.equal(res.dryRun, true);
        assert.deepEqual(res.localesProcessed, ['en', 'ja', 'ar']);
        assert.equal(res.totalDescriptionsUpdated, 3);
        assert.equal(res.totalScreenshotsUploaded, 6);
        assert.equal(res.totalBannersUploaded, 2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('waits for Google sign-in, auto-detects publisherId from URL, and uploads descriptions, screenshots, and banners', async () => {
      const tmpDir = createTempImagesDir(['en', 'ja']);
      const uploadedFiles = [];
      const evaluatedCalls = [];
      let navCount = 0;

      const mockSession = {
        async goto(url) {
          navCount++;
          this.currentUrl = url;
        },
        async evaluate(fn, ...args) {
          if (fn === cwsAssets.domSelectLocale) {
            evaluatedCalls.push({ type: 'selectLocale', locale: args[0], names: args[1] });
            return { matched: true, type: 'listbox', label: args[1][0] };
          }
          if (fn === cwsAssets.domFillDetailedDescription) {
            evaluatedCalls.push({ type: 'fillDescription', length: args[0].length });
            return { updated: true, length: args[0].length };
          }
          if (fn === cwsAssets.domClearExistingScreenshots) {
            evaluatedCalls.push({ type: 'clearScreenshots' });
            return { removedCount: 2 };
          }
          if (fn === cwsAssets.domClickSaveDraft) {
            evaluatedCalls.push({ type: 'saveDraft' });
            return { clicked: true, label: 'Save draft' };
          }
          // Page readiness check inside ensureStoreListingPageReady
          if (navCount === 1 && evaluatedCalls.length === 0 && !this.loggedInOnce) {
            this.loggedInOnce = true;
            return {
              href: 'https://accounts.google.com/ServiceLogin',
              hasTextarea: false,
              hasFileInput: false
            };
          }
          if (navCount === 1) {
            return {
              href: 'https://chrome.google.com/webstore/devconsole/pub-auto-777',
              hasTextarea: false,
              hasFileInput: false
            };
          }
          return {
            href: this.currentUrl,
            hasTextarea: true,
            hasFileInput: true
          };
        },
        async uploadFilesToInput(finderFn, finderArgs, filePaths) {
          uploadedFiles.push({ assetType: finderArgs[0], filePaths });
        },
        async sleep() {},
        async close() {}
      };

      try {
        const res = await cwsAssets.uploadStoreListingAssets(
          {
            locales: 'en,ja',
            imagesDir: tmpDir,
            stepDelayMs: 1
          },
          {},
          {
            browserSession: mockSession,
            logger: silentLogger
          }
        );

        assert.equal(res.dryRun, false);
        assert.deepEqual(res.localesProcessed, ['en', 'ja']);
        assert.equal(res.totalDescriptionsUpdated, 2);
        assert.equal(res.totalScreenshotsUploaded, 4);
        assert.equal(res.totalBannersUploaded, 2);
        assert.equal(
          mockSession.currentUrl,
          `https://chrome.google.com/webstore/devconsole/pub-auto-777/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`
        );

        const screenshotUploads = uploadedFiles.filter((u) => u.assetType === 'screenshots');
        const bannerUploads = uploadedFiles.filter((u) => u.assetType === 'banner');
        assert.equal(screenshotUploads.length, 4);
        assert.equal(bannerUploads.length, 2);
        assert.ok(bannerUploads[0].filePaths[0].endsWith('notispam-cleaner_banner_en.png'));
        assert.ok(bannerUploads[1].filePaths[0].endsWith('notispam-cleaner_banner.png'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('ensureStoreListingPageReady handles pre-configured publisherId post-login redirect, ignores /edit/privacy, and waits after clicking Store Listing tab', async () => {
      let readinessCheckStep = 0;
      const visitedUrls = [];

      const mockSession = {
        async goto(url) {
          visitedUrls.push(url);
          this.currentUrl = url;
        },
        async evaluate() {
          readinessCheckStep++;
          if (readinessCheckStep === 1) {
            // Google login redirects to publisher root even though publisherId was pre-configured
            return {
              href: 'https://chrome.google.com/webstore/devconsole/pub-preset-123',
              hasTextarea: false,
              hasFileInput: false,
              isNonListingSubpage: false
            };
          }
          if (readinessCheckStep === 2) {
            // Landed on /edit/privacy which has a textarea, must click Store listing tab instead of stopping
            return {
              href: `https://chrome.google.com/webstore/devconsole/pub-preset-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/privacy`,
              hasTextarea: true,
              hasFileInput: false,
              isNonListingSubpage: true
            };
          }
          if (readinessCheckStep === 3) {
            // Clicks Store listing tab in sidebar
            return true;
          }
          if (readinessCheckStep === 4) {
            // Tab clicked, URL updated to /edit/listing, but form not rendered yet
            return {
              href: `https://chrome.google.com/webstore/devconsole/pub-preset-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`,
              hasTextarea: false,
              hasFileInput: false,
              isNonListingSubpage: false
            };
          }
          // Step 5: Store listing form rendered
          return {
            href: `https://chrome.google.com/webstore/devconsole/pub-preset-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`,
            hasTextarea: true,
            hasFileInput: true,
            isNonListingSubpage: false
          };
        },
        async sleep() {}
      };

      const plan = {
        publisherId: 'pub-preset-123',
        extensionId: cwsAssets.DEFAULT_EXTENSION_ID,
        directStoreListingUrl: `https://chrome.google.com/webstore/devconsole/pub-preset-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`,
        loginTimeoutMs: 5000
      };

      await cwsAssets.ensureStoreListingPageReady(mockSession, plan, silentLogger);
      assert.equal(readinessCheckStep, 5);
      assert.equal(
        visitedUrls[visitedUrls.length - 1],
        `https://chrome.google.com/webstore/devconsole/pub-preset-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`
      );
    });

    it('uploadFilesToInput injects in-memory DataTransfer File when DOM.setFileInputFiles yields 0-byte file and waits for in-flight XHR without duplicate drop', async () => {
      const prevWebSocket = global.WebSocket;
      const prevWindow = global.window;
      const prevDocument = global.document;
      const prevDataTransfer = global.DataTransfer;
      const prevFile = global.File;
      const prevEvent = global.Event;
      const prevDragEvent = global.DragEvent;

      const tmpDir = createTempImagesDir(['ja']);
      const screen1Path = path.join(tmpDir, 'notispam-cleaner_screen-1_ja.png');

      let pageReceivedFileSize = 0;
      let pageReceivedFileName = '';
      let dropEventsDispatched = 0;
      let pollCalls = 0;
      let activeXhrLoadEnd = null;

      class MockEvent {
        constructor(type, opts) {
          this.type = type;
          this.bubbles = Boolean(opts?.bubbles);
        }
      }
      class MockDragEvent extends MockEvent {
        constructor(type, opts) {
          super(type, opts);
          this.dataTransfer = opts?.dataTransfer || null;
        }
      }
      class MockFile {
        constructor(parts, name, opts) {
          const buf = Buffer.concat(parts.map((p) => Buffer.from(p)));
          this.size = buf.length;
          this.name = name;
          this.type = opts?.type || '';
        }
      }
      class MockDataTransfer {
        constructor() {
          const list = [];
          this.files = list;
          this.items = {
            add(f) {
              list.push(f);
            }
          };
        }
      }
      class MockXHR {
        constructor() {
          this.listeners = {};
        }
        addEventListener(type, fn) {
          this.listeners[type] = this.listeners[type] || [];
          this.listeners[type].push(fn);
        }
        send() {
          activeXhrLoadEnd = () => {
            for (const fn of this.listeners.loadend || []) fn();
          };
        }
      }

      const containerEl = {
        isConnected: true,
        querySelectorAll() {
          return [];
        },
        querySelector() {
          return null;
        },
        dispatchEvent(ev) {
          if (ev.type === 'drop') dropEventsDispatched++;
        }
      };

      const fileInputEl = {
        type: 'file',
        value: 'old',
        files: [],
        parentElement: containerEl,
        captureListeners: {},
        bubbleListeners: {},
        addEventListener(type, fn, opts) {
          const bucket = opts && opts.capture ? this.captureListeners : this.bubbleListeners;
          bucket[type] = bucket[type] || [];
          bucket[type].push(fn);
        },
        dispatchEvent(ev) {
          for (const fn of (this.captureListeners[ev.type] || []).splice(0)) {
            fn(ev);
          }
          for (const fn of this.bubbleListeners[ev.type] || []) {
            fn(ev);
          }
        }
      };

      // Simulate CWS page listener that starts an XHR upload when 'change' fires on <input type="file">
      fileInputEl.addEventListener('change', () => {
        pageReceivedFileSize = fileInputEl.files?.[0]?.size || 0;
        pageReceivedFileName = fileInputEl.files?.[0]?.name || '';
        const xhr = new global.window.XMLHttpRequest();
        xhr.send();
      });

      class MockWebSocket {
        constructor() {
          this.listeners = { open: [], message: [], error: [], close: [] };
          queueMicrotask(() => {
            for (const fn of this.listeners.open) fn();
          });
        }
        addEventListener(type, fn) {
          this.listeners[type] = this.listeners[type] || [];
          this.listeners[type].push(fn);
        }
        removeEventListener() {}
        send(raw) {
          const msg = JSON.parse(raw);
          let result = {};
          if (msg.method === 'Runtime.evaluate') {
            result = { result: { objectId: 'obj-input-1', subtype: 'node' } };
          } else if (msg.method === 'DOM.describeNode') {
            result = { node: { backendNodeId: 77 } };
          } else if (msg.method === 'DOM.setFileInputFiles') {
            // Simulate fuse.sshfs / Snap confinement where browser sees a 0-byte unreadable file on disk
            fileInputEl.files = [{ name: 'notispam-cleaner_screen-1_ja.png', size: 0 }];
            fileInputEl.dispatchEvent(new MockEvent('input', { bubbles: true }));
            fileInputEl.dispatchEvent(new MockEvent('change', { bubbles: true }));
            result = {};
          } else if (msg.method === 'Runtime.callFunctionOn') {
            const fn = eval(`(${msg.params.functionDeclaration})`);
            const args = (msg.params.arguments || []).map((a) => a.value);
            if (args.length === 2 && typeof args[0] === 'boolean') {
              pollCalls++;
              // Complete the in-flight XHR on poll 4 (after poll 3 where drop would otherwise fire if no XHR was tracked)
              if (pollCalls === 5 && activeXhrLoadEnd) {
                activeXhrLoadEnd();
                activeXhrLoadEnd = null;
              }
            }
            const retVal = fn.apply(fileInputEl, args);
            result = { result: { value: retVal } };
          }
          queueMicrotask(() => {
            for (const fn of this.listeners.message) {
              fn({ data: JSON.stringify({ id: msg.id, result }) });
            }
          });
        }
        close() {}
      }

      global.WebSocket = MockWebSocket;
      global.Event = MockEvent;
      global.DragEvent = MockDragEvent;
      global.File = MockFile;
      global.DataTransfer = MockDataTransfer;
      global.document = { body: {} };
      global.window = {
        XMLHttpRequest: MockXHR,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };

      try {
        const session = await cwsAssets.createCdpBrowserSession({
          cdpUrl: 'http://127.0.0.1:9222',
          fetchImpl: async () => ({
            ok: true,
            json: async () => [
              {
                type: 'page',
                url: 'https://chrome.google.com/webstore/devconsole',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1'
              }
            ]
          }),
          sleepImpl: async () => {},
          logger: silentLogger
        });

        await session.uploadFilesToInput(cwsAssets.domFindAssetFileInput, ['screenshots'], [screen1Path]);
        await session.close();

        assert.equal(pageReceivedFileName, 'notispam-cleaner_screen-1_ja.png');
        assert.equal(pageReceivedFileSize, 32);
        assert.equal(dropEventsDispatched, 0);
        assert.equal(pollCalls, 5);
      } finally {
        global.WebSocket = prevWebSocket;
        global.window = prevWindow;
        global.document = prevDocument;
        global.DataTransfer = prevDataTransfer;
        global.File = prevFile;
        global.Event = prevEvent;
        global.DragEvent = prevDragEvent;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('domClearExistingScreenshots automatically approves "画像を削除して良いですか？" confirmation dialogs (both synchronous and asynchronous, multi-screenshot, and shared preview delete buttons)', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let cancelClicked = 0;
      let closeIconClicked = 0;
      let confirmClicked = 0;
      let deleteBtnClicks = 0;
      let dialogOpen = false;

      const remainingImages = [
        { getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/screen-1' : '') },
        { getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/screen-2' : '') }
      ];

      const closeIconBtn = {
        textContent: 'close',
        getAttribute: (k) => (k === 'aria-label' ? '閉じる' : ''),
        click() { closeIconClicked++; }
      };
      const cancelBtn = {
        textContent: 'キャンセル',
        getAttribute: () => '',
        click() { cancelClicked++; }
      };
      const confirmBtn = {
        textContent: '削除',
        getAttribute: () => '',
        click() {
          confirmClicked++;
          dialogOpen = false;
          remainingImages.shift();
        }
      };

      const confirmDialog = {
        textContent: '画像を削除して良いですか？ キャンセル 削除',
        get style() {
          return { display: dialogOpen ? 'block' : 'none', visibility: 'visible', opacity: '1' };
        },
        getAttribute: (k) => (k === 'role' ? 'dialog' : ''),
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          return [closeIconBtn, cancelBtn, confirmBtn];
        }
      };

      // Shared preview delete button that deletes whichever screenshot is currently displayed
      const sharedDeleteBtn = {
        textContent: 'delete',
        get disabled() {
          return remainingImages.length === 0;
        },
        getAttribute: (k) => (k === 'aria-label' ? '画像を削除' : ''),
        click() {
          deleteBtnClicks++;
          // Simulate dialog appearing asynchronously after click
          setTimeout(() => {
            dialogOpen = true;
          }, 20);
        }
      };

      const localizedContainer = {
        textContent: 'ローカライズされたスクリーンショット (1280x800)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{ type: 'file', multiple: true }];
          if (sel.includes('img')) return remainingImages.slice();
          return remainingImages.length > 0 ? [sharedDeleteBtn] : [];
        }
      };

      global.window = {
        getComputedStyle: (el) => ({
          display: el?.style?.display || 'block',
          visibility: 'visible',
          opacity: '1'
        })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel.includes('[role="dialog"]')) return [confirmDialog];
          if (sel.includes('section')) return [localizedContainer, confirmDialog];
          return [];
        }
      };

      try {
        // Execute via serialized toString() in isolated scope to verify zero external closure dependencies
        const isolatedFn = new Function(`return (${cwsAssets.domClearExistingScreenshots.toString()})();`);
        const res = await isolatedFn();

        assert.equal(res.removedCount, 2);
        assert.equal(res.confirmedCount, 2);
        assert.equal(deleteBtnClicks, 2);
        assert.equal(confirmClicked, 2);
        assert.equal(cancelClicked, 0);
        assert.equal(closeIconClicked, 0);
        assert.equal(remainingImages.length, 0);
        assert.equal(global.window.confirm('画像を削除して良いですか？'), true);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domConfirmDeleteDialog handles Material / Wiz / Shadow DOM dialogs and ignores hidden or non-confirmation dialogs', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let hiddenDialogClicked = 0;
      let unrelatedDialogClicked = 0;
      let cancelClicked = 0;
      let acceptClicked = 0;

      const hiddenDialog = {
        textContent: '画像を削除して良いですか？',
        style: { display: 'none' },
        getAttribute: (k) => (k === 'role' ? 'alertdialog' : ''),
        querySelectorAll: () => [
          { textContent: 'OK', getAttribute: () => '', click() { hiddenDialogClicked++; } }
        ]
      };

      const unrelatedDialog = {
        textContent: 'ヘルプ情報',
        getAttribute: (k) => (k === 'role' ? 'dialog' : ''),
        querySelectorAll: () => [
          { textContent: '閉じる', getAttribute: () => '', click() { unrelatedDialogClicked++; } }
        ]
      };

      const wizCancelBtn = {
        textContent: 'いいえ',
        getAttribute: (k) => (k === 'data-mdc-dialog-action' ? 'cancel' : ''),
        click() { cancelClicked++; }
      };
      const wizAcceptBtn = {
        textContent: 'check はい',
        getAttribute: (k) => (k === 'data-mdc-dialog-action' ? 'accept' : ''),
        click() { acceptClicked++; }
      };
      const activeConfirmDialog = {
        textContent: '画像を削除していいですか？ いいえ はい',
        getAttribute: (k) => (k === 'role' ? 'alertdialog' : ''),
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          return [wizCancelBtn, wizAcceptBtn];
        }
      };

      global.window = {
        getComputedStyle: (el) => ({
          display: el?.style?.display || 'block',
          visibility: 'visible',
          opacity: '1'
        })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel.includes('[role="dialog"]') || sel.includes('section')) {
            return [hiddenDialog, unrelatedDialog, activeConfirmDialog];
          }
          return [];
        }
      };

      try {
        const res = cwsAssets.domConfirmDeleteDialog();
        assert.equal(res.clicked, true);
        assert.equal(res.label, 'はい');
        assert.equal(acceptClicked, 1);
        assert.equal(cancelClicked, 0);
        assert.equal(hiddenDialogClicked, 0);
        assert.equal(unrelatedDialogClicked, 0);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('createCdpBrowserSession automatically accepts native Page.javascriptDialogOpening events via CDP', async () => {
      const prevWebSocket = global.WebSocket;
      const handledDialogs = [];
      let wsInstance = null;

      class MockWebSocket {
        constructor() {
          wsInstance = this;
          this.listeners = { open: [], message: [], error: [], close: [] };
          queueMicrotask(() => {
            for (const fn of this.listeners.open) fn();
          });
        }
        addEventListener(type, fn) {
          this.listeners[type] = this.listeners[type] || [];
          this.listeners[type].push(fn);
        }
        removeEventListener() {}
        send(raw) {
          const msg = JSON.parse(raw);
          if (msg.method === 'Page.handleJavaScriptDialog') {
            handledDialogs.push(msg.params);
          }
          queueMicrotask(() => {
            for (const fn of this.listeners.message) {
              fn({ data: JSON.stringify({ id: msg.id, result: {} }) });
            }
          });
        }
        close() {}
      }

      global.WebSocket = MockWebSocket;
      try {
        const session = await cwsAssets.createCdpBrowserSession({
          cdpUrl: 'http://127.0.0.1:9222',
          fetchImpl: async () => ({
            ok: true,
            json: async () => [
              {
                type: 'page',
                url: 'https://chrome.google.com/webstore/devconsole',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1'
              }
            ]
          }),
          sleepImpl: async () => {},
          logger: silentLogger
        });

        // Simulate Chrome emitting Page.javascriptDialogOpening when "画像を削除して良いですか？" native confirm dialog opens
        for (const fn of wsInstance.listeners.message) {
          fn({
            data: JSON.stringify({
              method: 'Page.javascriptDialogOpening',
              params: {
                message: '画像を削除して良いですか？',
                type: 'confirm'
              }
            })
          });
        }
        await new Promise((r) => setTimeout(r, 10));
        await session.close();

        assert.equal(handledDialogs.length, 1);
        assert.deepEqual(handledDialogs[0], { accept: true });
      } finally {
        global.WebSocket = prevWebSocket;
      }
    });

    it('domClearExistingScreenshots handles real-browser <img>.click, ignores non-dialog card divs with "画像を削除" buttons, and does not click close button on nested closing dialogs', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let globalDeleteClicked = 0;
      let closeDialogBtnClicked = 0;
      let cancelDialogBtnClicked = 0;
      let confirmDialogBtnClicked = 0;
      let sharedDeleteBtnClicked = 0;
      let dialogState = 'closed'; // 'closed' | 'open' | 'closing'

      // In a real browser, every HTMLElement (including <img>) has typeof el.click === 'function'
      const remainingImgs = [
        {
          tagName: 'IMG',
          src: 'https://lh3.googleusercontent.com/real-screen-1',
          click() {},
          getAttribute(k) { return k === 'src' ? this.src : ''; }
        },
        {
          tagName: 'IMG',
          src: 'https://lh3.googleusercontent.com/real-screen-2',
          click() {},
          getAttribute(k) { return k === 'src' ? this.src : ''; }
        }
      ];

      // Global screenshot card <div> has text "画像を削除" (from its delete button) and no <input type="file"> inside the card div
      const globalDelBtn = {
        tagName: 'BUTTON',
        textContent: '画像を削除',
        getAttribute: (k) => (k === 'aria-label' ? '画像を削除' : ''),
        click() { globalDeleteClicked++; }
      };
      const globalCardDiv = {
        tagName: 'DIV',
        textContent: '画像を削除',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          return [globalDelBtn];
        }
      };
      const globalSection = {
        tagName: 'SECTION',
        textContent: 'グローバル スクリーンショット (1280x800) 画像を削除',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{ tagName: 'INPUT', type: 'file', multiple: true }];
          return [globalDelBtn];
        }
      };

      const sharedPreviewDeleteBtn = {
        tagName: 'BUTTON',
        textContent: '画像を削除',
        get disabled() { return remainingImgs.length === 0; },
        getAttribute: (k) => (k === 'aria-label' ? '画像を削除' : ''),
        click() {
          sharedDeleteBtnClicked++;
          // Dialog opens asynchronously 20ms after clicking delete
          setTimeout(() => {
            dialogState = 'open';
          }, 20);
        }
      };

      // Card wrapper <div> inside Localized Screenshots that has text "画像を削除" and no <input type="file">
      const localizedCardDiv = {
        tagName: 'DIV',
        textContent: '画像を削除',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          if (sel.includes('img')) return remainingImgs.slice();
          return remainingImgs.length > 0 ? [sharedPreviewDeleteBtn] : [];
        }
      };

      const localizedSection = {
        tagName: 'SECTION',
        textContent: 'ローカライズされたスクリーンショット (1280x800) 画像を削除',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{ tagName: 'INPUT', type: 'file', multiple: true }];
          if (sel.includes('img')) return remainingImgs.slice();
          return remainingImgs.length > 0 ? [sharedPreviewDeleteBtn] : [];
        }
      };

      // Nested Material / Wiz dialog (.mdc-dialog > [role="alertdialog"]) that takes 30ms to close after Confirm is clicked
      const headerCloseBtn = {
        tagName: 'BUTTON',
        textContent: '',
        getAttribute: (k) => (k === 'aria-label' || k === 'title' ? 'ダイアログを閉じる' : ''),
        click() { closeDialogBtnClicked++; }
      };
      const cancelBtn = {
        tagName: 'BUTTON',
        textContent: 'キャンセル',
        getAttribute: (k) => (k === 'aria-label' || k === 'title' ? 'キャンセル' : ''),
        click() { cancelDialogBtnClicked++; }
      };
      const confirmBtn = {
        tagName: 'BUTTON',
        // Simulate Angular Material empty touch-target span with whitespace
        querySelector: (sel) =>
          sel.includes('mat-mdc-button-touch-target') ? { textContent: '   ' } : null,
        textContent: '削除',
        getAttribute: (k) => (k === 'aria-label' || k === 'title' ? '削除' : ''),
        click() {
          confirmDialogBtnClicked++;
          dialogState = 'closing';
          setTimeout(() => {
            dialogState = 'closed';
            remainingImgs.shift();
          }, 30);
        }
      };

      const innerAlertDialog = {
        tagName: 'DIV',
        textContent: '画像を削除して良いですか？ キャンセル 削除',
        get style() {
          return { display: dialogState === 'closed' ? 'none' : 'block', visibility: 'visible', opacity: '1' };
        },
        getAttribute: (k) => (k === 'role' ? 'alertdialog' : ''),
        contains: (other) => other === headerCloseBtn || other === cancelBtn || other === confirmBtn,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          return [headerCloseBtn, cancelBtn, confirmBtn];
        }
      };
      innerAlertDialog.parentElement = null;

      const outerMdcDialog = {
        tagName: 'DIV',
        className: 'VfPpkd-sx9Kwc mdc-dialog mdc-dialog--open',
        textContent: '画像を削除して良いですか？ キャンセル 削除',
        get style() {
          return { display: dialogState === 'closed' ? 'none' : 'block', visibility: 'visible', opacity: '1' };
        },
        getAttribute: (k) => (k === 'class' ? 'VfPpkd-sx9Kwc mdc-dialog mdc-dialog--open' : ''),
        contains: (other) =>
          other === innerAlertDialog || other === headerCloseBtn || other === cancelBtn || other === confirmBtn,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          if (sel === '*') return [innerAlertDialog, headerCloseBtn, cancelBtn, confirmBtn];
          return [headerCloseBtn, cancelBtn, confirmBtn];
        }
      };
      innerAlertDialog.parentElement = outerMdcDialog;

      global.window = {
        getComputedStyle: (el) => ({
          display: el?.style?.display || 'block',
          visibility: 'visible',
          opacity: '1'
        })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel.includes('[role="dialog"]')) return [outerMdcDialog, innerAlertDialog];
          if (sel === 'section, [role="region"]') return [globalSection, localizedSection];
          if (sel.includes('section')) {
            return [globalSection, globalCardDiv, localizedSection, localizedCardDiv, outerMdcDialog, innerAlertDialog];
          }
          return [];
        }
      };

      try {
        const res = await cwsAssets.domClearExistingScreenshots();
        assert.equal(res.removedCount, 2);
        assert.equal(res.confirmedCount, 2);
        assert.equal(sharedDeleteBtnClicked, 2);
        assert.equal(confirmDialogBtnClicked, 2);
        assert.equal(cancelDialogBtnClicked, 0);
        assert.equal(closeDialogBtnClicked, 0);
        assert.equal(globalDeleteClicked, 0);
        assert.equal(remainingImgs.length, 0);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domConfirmDeleteDialog handles zero-height fixed-child dialog wrapper, Shadow DOM prompt text, and <input type="button"> with boolean multiple property', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let cancelClicked = 0;
      let okInputBtnClicked = 0;

      // In a real browser, <input type="button"> is an HTMLInputElement where typeof el.multiple === 'boolean' (false)
      const cancelInputBtn = {
        tagName: 'INPUT',
        type: 'button',
        multiple: false,
        value: 'キャンセル',
        getAttribute: (k) => (k === 'type' ? 'button' : ''),
        getBoundingClientRect: () => ({ width: 80, height: 36 }),
        click() { cancelClicked++; }
      };
      const okInputBtn = {
        tagName: 'INPUT',
        type: 'button',
        multiple: false,
        value: 'OK',
        getAttribute: (k) => (k === 'type' ? 'button' : ''),
        getBoundingClientRect: () => ({ width: 80, height: 36 }),
        click() { okInputBtnClicked++; }
      };

      const shadowRoot = {
        textContent: '画像を削除して良いですか？',
        querySelectorAll(sel) {
          if (sel === '*') return [cancelInputBtn, okInputBtn];
          return [cancelInputBtn, okInputBtn];
        }
      };

      // Outer <mwc-dialog> host has 0x0 bounding rect (e.g. display: contents or fixed children) and light-DOM textContent === ''
      const zeroHeightDialogHost = {
        tagName: 'MWC-DIALOG',
        textContent: '',
        shadowRoot,
        getAttribute: (k) => (k === 'role' ? 'dialog' : ''),
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          return [];
        }
      };

      global.window = {
        getComputedStyle: () => ({ display: 'contents', visibility: 'visible', opacity: '1' })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel.includes('mwc-dialog') || sel.includes('section')) return [zeroHeightDialogHost];
          return [];
        }
      };

      try {
        const res = cwsAssets.domConfirmDeleteDialog();
        assert.equal(res.clicked, true);
        assert.equal(res.label, 'OK');
        assert.equal(okInputBtnClicked, 1);
        assert.equal(cancelClicked, 0);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domSelectLocale matches zh_CN, zh_TW, and ru across half-width/full-width parens, no-space Material check icons, compound labels, and full 35-item (1680px) virtual-scrolled menus', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      const listings = cwsAssets.loadStoreListings();
      let selectedOptionLabel = null;

      // Outer scrollable .mdc-menu-surface (1680px = 35 items * 48px, clientHeight 240px)
      const menuContainer = {
        scrollHeight: 1680,
        clientHeight: 240,
        scrollTop: 0,
        overflowY: 'auto',
        parentElement: null
      };
      // Inner non-scrollable <ul role="listbox"> with overflowY: 'visible' that must be skipped by findScrollableMenuContainer
      const innerListUl = {
        scrollHeight: 1680,
        clientHeight: 240,
        scrollTop: 0,
        overflowY: 'visible',
        parentElement: menuContainer
      };

      const makeOpt = (label, offsetTop) => ({
        textContent: label,
        offsetTop,
        parentElement: innerListUl,
        getAttribute: () => '',
        getBoundingClientRect: () => ({ width: 200, height: 48 }),
        click() {
          selectedOptionLabel = label;
          langTrigger.textContent = label;
        }
      });

      const topOptions = Array.from({ length: 8 }, (_, idx) => makeOpt(`Lang ${idx + 1}`, idx * 48));
      const skOption = makeOpt('スロバキア語', 432);
      const hkOption = makeOpt('中国語 (香港)', 1344);
      const ruOption = makeOpt('checkロシア語 - Русский', 1392);
      const zhCnOption = makeOpt('check中国語 - 中国 (未完了)', 1536);
      const zhTwOption = makeOpt('中国語 (台湾) / 中文 (繁體)', 1584);

      const langTrigger = {
        textContent: 'ルーマニア語',
        parentElement: {
          textContent: '',
          previousElementSibling: { textContent: '表示言語' },
          parentElement: null
        },
        getAttribute: () => '',
        getBoundingClientRect: () => ({ width: 200, height: 40 }),
        click() {}
      };

      global.window = {
        getComputedStyle: (el) => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          overflowY: el?.overflowY || 'visible'
        })
      };
      global.document = {
        body: {},
        documentElement: {},
        querySelectorAll(sel) {
          if (sel === 'select') return [];
          if (sel.includes('combobox')) return [langTrigger];
          if (sel.includes('[role="option"]')) {
            // Simulate virtual-scrolled 35-item dropdown where bottom items at >= 1392px only render when scrollTop >= 1200
            if (menuContainer.scrollTop < 600) {
              return [...topOptions, skOption];
            }
            if (menuContainer.scrollTop < 1200) {
              return [...topOptions, hkOption];
            }
            return [hkOption, ruOption, zhCnOption, zhTwOption];
          }
          return [];
        }
      };

      try {
        const isolatedSelect = new Function(
          'localeCode',
          'languageNames',
          `return (${cwsAssets.domSelectLocale.toString()})(localeCode, languageNames);`
        );

        const resRu = await isolatedSelect('ru', listings.ru.languageNames);
        assert.equal(resRu.matched, true);
        assert.equal(selectedOptionLabel, 'checkロシア語 - Русский');

        // Menu remains scrolled near bottom; selecting top-of-list 'sk' must reset scrollTop to 0 and find 'スロバキア語'
        const resSk = await isolatedSelect('sk', listings.sk.languageNames);
        assert.equal(resSk.matched, true);
        assert.equal(selectedOptionLabel, 'スロバキア語');

        const resZhCn = await isolatedSelect('zh_CN', listings.zh_CN.languageNames);
        assert.equal(resZhCn.matched, true);
        assert.equal(selectedOptionLabel, 'check中国語 - 中国 (未完了)');

        const resZhTw = await isolatedSelect('zh_TW', listings.zh_TW.languageNames);
        assert.equal(resZhTw.matched, true);
        assert.equal(selectedOptionLabel, '中国語 (台湾) / 中文 (繁體)');
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domFillDetailedDescription and domClickSaveDraft recover when outer card mentions "概要", textarea is replaced, or screenshot upload resets textarea for zh_CN / zh_TW / ru', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;
      const prevEvent = global.Event;

      class MockEvent {
        constructor(type, opts) {
          this.type = type;
          this.bubbles = Boolean(opts?.bubbles);
        }
      }

      const listings = cwsAssets.loadStoreListings();
      let saveDraftClicked = false;
      let textareaValueAtSave = null;

      // Hidden Angular autosize measurement textarea that must be ignored
      const hiddenAutosizeTa = {
        value: '',
        disabled: false,
        readOnly: false,
        maxLength: -1,
        className: 'cdk-textarea-autosize-measuring',
        parentElement: { textContent: '説明' },
        getAttribute: (k) => (k === 'class' ? 'cdk-textarea-autosize-measuring' : ''),
        getBoundingClientRect: () => ({ width: 500, height: 100 }),
        dispatchEvent() {}
      };

      // Hidden template textarea (display: none) and Short Description textarea that must be ignored by ensureDetailedDescriptionIntact
      const hiddenDisplayNoneTa = {
        value: '',
        disabled: false,
        readOnly: false,
        maxLength: 16000,
        style: { display: 'none' },
        getAttribute: () => '',
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
        dispatchEvent() {}
      };
      const shortSummaryTa = {
        value: 'Short summary',
        disabled: false,
        readOnly: false,
        maxLength: -1,
        rows: 2,
        getAttribute: (k) => (k === 'aria-label' ? 'Short description' : ''),
        getBoundingClientRect: () => ({ width: 500, height: 60 }),
        dispatchEvent() {}
      };

      // Detailed description textarea wrapped inside an outer card that also mentions "概要 (manifest.json から自動取得)"
      const outerListingCard = {
        textContent: 'ストア掲載情報 概要 (manifest.json から自動取得) 説明 (詳細な説明文)',
        parentElement: null
      };
      const fieldWrapper = {
        textContent: '',
        previousElementSibling: { textContent: '説明 *' },
        parentElement: outerListingCard
      };
      const descTa = {
        value: '',
        disabled: false,
        readOnly: false,
        maxLength: 16000,
        rows: 12,
        className: 'mdc-text-field__input',
        isConnected: true,
        parentElement: fieldWrapper,
        getAttribute: () => '',
        getBoundingClientRect: () => ({ width: 600, height: 240 }),
        focus() {},
        dispatchEvent() {}
      };
      const replacementDescTa = {
        value: '',
        disabled: false,
        readOnly: false,
        maxLength: 16000,
        rows: 12,
        className: 'mdc-text-field__input',
        isConnected: true,
        parentElement: fieldWrapper,
        getAttribute: () => '',
        getBoundingClientRect: () => ({ width: 600, height: 240 }),
        focus() {},
        dispatchEvent() {}
      };
      let activeDescTa = descTa;

      const saveBtn = {
        disabled: false,
        textContent: '下書きとして保存',
        getAttribute: () => null,
        click() {
          saveDraftClicked = true;
          textareaValueAtSave = activeDescTa.value;
        }
      };

      global.Event = MockEvent;
      global.window = {
        HTMLTextAreaElement: { prototype: {} },
        getComputedStyle: (el) => ({
          display: el?.style?.display || 'block',
          visibility: 'visible',
          opacity: '1'
        })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'textarea') {
            return [hiddenAutosizeTa, hiddenDisplayNoneTa, shortSummaryTa, activeDescTa];
          }
          if (sel.includes('button')) return [saveBtn];
          return [];
        }
      };

      try {
        const fillRes = cwsAssets.domFillDetailedDescription(listings.zh_CN.detailedDescription);
        assert.equal(fillRes.updated, true);
        assert.equal(descTa.value, listings.zh_CN.detailedDescription);

        // Simulate SPA re-rendering the form and detaching the original textarea before Save Draft
        descTa.isConnected = false;
        activeDescTa = replacementDescTa;

        const saveRes = await cwsAssets.domClickSaveDraft();
        assert.equal(saveRes.clicked, true);
        assert.equal(saveDraftClicked, true);
        assert.equal(textareaValueAtSave, listings.zh_CN.detailedDescription);
        assert.equal(shortSummaryTa.value, 'Short summary');
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
        global.Event = prevEvent;
      }
    });

    it('domConfirmDeleteDialog and domFindAssetFileInput avoid O(N^2) scans and unnecessary trigger clicks on large DOMs', () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      let nonDialogStarQueries = 0;
      let triggerClicksWhenStaticInputExists = 0;

      // Create 2,000 non-dialog <div> elements to simulate accumulated SPA DOM nodes across 35 locales
      const largeDivs = Array.from({ length: 2000 }, (_, i) => ({
        tagName: 'DIV',
        textContent: `Store listing wrapper block ${i} `.repeat(30),
        getAttribute: () => '',
        querySelectorAll(sel) {
          if (sel === '*') nonDialogStarQueries++;
          return [];
        }
      }));

      const staticLocalizedInput = {
        type: 'file',
        multiple: true,
        getAttribute: (k) => (k === 'data-asset-type' ? 'localized-screenshots' : ''),
        parentElement: null
      };

      const localizedSection = {
        tagName: 'SECTION',
        textContent: 'ローカライズされたスクリーンショット (1280x800)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [staticLocalizedInput];
          return [
            {
              textContent: 'ファイルを追加',
              getAttribute: () => '',
              click() {
                triggerClicksWhenStaticInputExists++;
              }
            }
          ];
        }
      };
      staticLocalizedInput.parentElement = localizedSection;

      class MockHTMLInputElement {
        click() {}
      }

      global.window = {
        HTMLInputElement: MockHTMLInputElement,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [staticLocalizedInput];
          if (sel.includes('section')) return [...largeDivs, localizedSection];
          return [];
        }
      };

      try {
        const start = Date.now();
        const dlgRes = cwsAssets.domConfirmDeleteDialog();
        const foundInput = cwsAssets.domFindAssetFileInput('screenshots');
        const elapsedMs = Date.now() - start;

        assert.equal(dlgRes.clicked, false);
        assert.equal(nonDialogStarQueries, 0);
        assert.equal(foundInput, staticLocalizedInput);
        assert.equal(triggerClicksWhenStaticInputExists, 0);
        assert.ok(elapsedMs < 100, `Expected fast execution (<100ms), took ${elapsedMs}ms`);
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domInspectLocaleListing accurately inspects Detailed Description and Localized Screenshots in read-only mode', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      const listings = cwsAssets.loadStoreListings();
      const expectedJaDesc = listings.ja.detailedDescription;

      const shortTa = {
        value: listings.ja.extDesc,
        disabled: false,
        readOnly: false,
        maxLength: 132,
        rows: 2,
        getAttribute: (k) => (k === 'aria-label' ? '簡単な説明' : ''),
        getBoundingClientRect: () => ({ width: 500, height: 60 })
      };

      const detailedTa = {
        value: expectedJaDesc.replace(/\n/g, '\r\n'), // CRLF line endings should match normalized LF
        disabled: false,
        readOnly: false,
        maxLength: 16000,
        rows: 12,
        parentElement: {
          textContent: '説明 (詳細な説明)',
          parentElement: null
        },
        getAttribute: () => '',
        getBoundingClientRect: () => ({ width: 600, height: 300 })
      };

      const globalImgs = [
        { tagName: 'IMG', src: 'https://lh3.googleusercontent.com/global-1', getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/global-1' : '') },
        { tagName: 'IMG', src: 'https://lh3.googleusercontent.com/global-2', getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/global-2' : '') }
      ];
      const globalSection = {
        tagName: 'SECTION',
        textContent: 'グローバル スクリーンショット (1280x800)',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{ tagName: 'INPUT', type: 'file', multiple: true }];
          if (sel.includes('img')) return globalImgs;
          return [];
        }
      };

      let localizedImgs = [
        { tagName: 'IMG', src: 'https://lh3.googleusercontent.com/ja-1', getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/ja-1' : '') },
        { tagName: 'IMG', src: 'https://lh3.googleusercontent.com/ja-2', getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/ja-2' : '') }
      ];
      const localizedSection = {
        tagName: 'SECTION',
        textContent: 'ローカライズされたスクリーンショット (1280x800) 指定しない場合はグローバル スクリーンショットが使用されます。',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [{ tagName: 'INPUT', type: 'file', multiple: true }];
          if (sel.includes('img')) return localizedImgs;
          return [];
        }
      };

      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'textarea') return [shortTa, detailedTa];
          if (sel.includes('section')) return [globalSection, localizedSection];
          return [];
        }
      };

      try {
        // Execute via serialized toString() in isolated scope to ensure zero external closure dependencies
        const isolatedInspect = new Function(
          'expectedDesc',
          'expectedScreens',
          `return (${cwsAssets.domInspectLocaleListing.toString()})(expectedDesc, expectedScreens);`
        );

        const okRes = await isolatedInspect(expectedJaDesc, 2);
        assert.equal(okRes.inspected, true);
        assert.equal(okRes.ok, true);
        assert.equal(okRes.descriptionOk, true);
        assert.equal(okRes.descriptionStatus, 'ok');
        assert.equal(okRes.screenshotsOk, true);
        assert.equal(okRes.screenshotStatus, 'ok');
        assert.equal(okRes.screenshotCount, 2);

        // Simulate only 1 localized screenshot uploaded (even though globalSection has 2)
        localizedImgs = [localizedImgs[0]];
        const partialScreenRes = await isolatedInspect(expectedJaDesc, 2);
        assert.equal(partialScreenRes.ok, false);
        assert.equal(partialScreenRes.descriptionOk, true);
        assert.equal(partialScreenRes.screenshotsOk, false);
        assert.equal(partialScreenRes.screenshotStatus, 'insufficient');
        assert.equal(partialScreenRes.screenshotCount, 1);

        // Simulate empty description
        detailedTa.value = '   ';
        const emptyDescRes = await isolatedInspect(expectedJaDesc, 2);
        assert.equal(emptyDescRes.ok, false);
        assert.equal(emptyDescRes.descriptionOk, false);
        assert.equal(emptyDescRes.descriptionStatus, 'empty');
        assert.equal(emptyDescRes.actualDescriptionLength, 0);

        // Simulate mismatched description
        detailedTa.value = 'Wrong description text';
        const mismatchDescRes = await isolatedInspect(expectedJaDesc, 2);
        assert.equal(mismatchDescRes.ok, false);
        assert.equal(mismatchDescRes.descriptionOk, false);
        assert.equal(mismatchDescRes.descriptionStatus, 'mismatch');
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('domInspectLocaleListing and domClearExistingScreenshots handle sibling-heading layouts, button icons, empty src/background-image, nested media/buttons, and multi-textarea sections', async () => {
      const prevWindow = global.window;
      const prevDocument = global.document;

      const listings = cwsAssets.loadStoreListings();
      const expectedEnDesc = listings.en.detailedDescription;

      // Multi-textarea section titled "商品の詳細" where first textarea has aria-label="概要" (without maxLength)
      // and second textarea is inside a Shadow DOM host or read-only in --verify mode
      const summaryTaNoMaxLen = {
        value: 'Short summary',
        disabled: false,
        readOnly: false,
        rows: 3,
        getAttribute: (k) => (k === 'aria-label' ? '概要' : ''),
        getBoundingClientRect: () => ({ width: 500, height: 60 })
      };
      const detailedTaInShadow = {
        value: expectedEnDesc,
        disabled: false,
        readOnly: true, // Locked for review: domInspectLocaleListing should still read it when no editable detailed textarea matches
        rows: 12,
        getAttribute: (k) => (k === 'aria-label' ? '詳細な説明' : ''),
        getBoundingClientRect: () => ({ width: 600, height: 300 })
      };
      const productDetailsSection = {
        tagName: 'SECTION',
        textContent: '商品の詳細 概要 詳細な説明',
        querySelectorAll(sel) {
          if (sel === 'textarea') return [summaryTaNoMaxLen, detailedTaInShadow];
          return [];
        }
      };
      summaryTaNoMaxLen.parentElement = productDetailsSection;
      summaryTaNoMaxLen.closest = () => productDetailsSection;
      const shadowHost = {
        tagName: 'MD-OUTLINED-TEXT-FIELD',
        parentElement: productDetailsSection,
        shadowRoot: {
          querySelectorAll(sel) {
            if (sel === 'textarea') return [detailedTaInShadow];
            return [];
          }
        }
      };
      detailedTaInShadow.getRootNode = () => ({ host: shadowHost });

      // Flat multi-input card where <h3> heading is a previousElementSibling of the localized upload widget
      const localizedHeading = {
        tagName: 'H3',
        textContent: 'ローカライズされたスクリーンショット (1280x800)',
        querySelectorAll: () => []
      };

      // Inside localizedWidget:
      // - 1 valid screenshot wrapped in a div[style*="background-image"] > img (should count as 1, not 2)
      // - 1 nested delete button (<material-button aria-label="削除"><button aria-label="削除"><img src="trash.svg"></button></material-button>)
      // - 1 empty <img src="" style="display:block"> placeholder (should be ignored)
      // - 1 empty <div style="background-image: none"> slot (should be ignored)
      // - 1 tiny 24x24 upload icon <img> (should be ignored)
      const innerImg = {
        tagName: 'IMG',
        src: 'https://lh3.googleusercontent.com/screen-1',
        getAttribute: (k) => (k === 'src' ? 'https://lh3.googleusercontent.com/screen-1' : ''),
        getBoundingClientRect: () => ({ width: 320, height: 200 })
      };
      const bgWrapper = {
        tagName: 'DIV',
        textContent: 'ローカライズされたスクリーンショット 1',
        getAttribute: (k) => (k === 'style' ? 'background-image: url("https://lh3.googleusercontent.com/screen-1")' : ''),
        contains: (other) => other === innerImg,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [];
          if (sel.includes('img')) return [innerImg];
          return [];
        }
      };
      innerImg.parentElement = bgWrapper;

      const btnIconImg = {
        tagName: 'IMG',
        src: 'https://www.gstatic.com/icons/delete.svg',
        getAttribute: (k) => (k === 'src' ? 'https://www.gstatic.com/icons/delete.svg' : '')
      };
      let deleteClicks = 0;
      const innerDelBtn = {
        tagName: 'BUTTON',
        textContent: 'delete',
        getAttribute: (k) => (k === 'aria-label' ? '削除' : ''),
        click() {
          deleteClicks++;
        }
      };
      btnIconImg.parentElement = innerDelBtn;
      const outerDelBtnHost = {
        tagName: 'MATERIAL-BUTTON',
        textContent: 'delete',
        getAttribute: (k) => (k === 'aria-label' ? '削除' : k === 'role' ? 'button' : ''),
        contains: (other) => other === innerDelBtn || other === btnIconImg,
        click() {
          deleteClicks++;
        }
      };
      innerDelBtn.parentElement = outerDelBtnHost;
      bgWrapper.parentElement = null;

      const emptySrcImg = {
        tagName: 'IMG',
        src: '',
        getAttribute: (k) => (k === 'style' ? 'display: block; width: 128px;' : '')
      };
      const emptyBgSlot = {
        tagName: 'DIV',
        getAttribute: (k) => (k === 'style' ? 'background-image: none;' : '')
      };
      const tinyUiIcon = {
        tagName: 'IMG',
        src: 'https://www.gstatic.com/icons/help_24dp.png',
        getAttribute: (k) => (k === 'src' ? 'https://www.gstatic.com/icons/help_24dp.png' : ''),
        getBoundingClientRect: () => ({ width: 24, height: 24 })
      };

      const localizedFileInput = { tagName: 'INPUT', type: 'file', multiple: true };
      const localizedWidget = {
        tagName: 'DIV',
        textContent: 'ドラッグ＆ドロップで追加',
        previousElementSibling: localizedHeading,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [localizedFileInput];
          if (sel.includes('img')) {
            return [bgWrapper, innerImg, btnIconImg, emptySrcImg, emptyBgSlot, tinyUiIcon];
          }
          if (sel.includes('button')) {
            return [outerDelBtnHost, innerDelBtn];
          }
          return [];
        }
      };
      bgWrapper.parentElement = localizedWidget;
      outerDelBtnHost.parentElement = localizedWidget;

      const globalHeading = {
        tagName: 'H3',
        textContent: 'グローバル スクリーンショット (1280x800)',
        previousElementSibling: localizedWidget,
        querySelectorAll: () => []
      };
      const globalFileInput = { tagName: 'INPUT', type: 'file', multiple: true };
      const globalWidget = {
        tagName: 'DIV',
        textContent: 'ドラッグ＆ドロップで追加',
        previousElementSibling: globalHeading,
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [globalFileInput];
          if (sel.includes('img')) {
            return [
              { tagName: 'IMG', src: 'https://lh3.googleusercontent.com/g1', getAttribute: () => 'https://lh3.googleusercontent.com/g1' },
              { tagName: 'IMG', src: 'https://lh3.googleusercontent.com/g2', getAttribute: () => 'https://lh3.googleusercontent.com/g2' }
            ];
          }
          return [];
        }
      };

      const multiInputCard = {
        tagName: 'SECTION',
        textContent: 'ローカライズされたスクリーンショット グローバル スクリーンショット',
        querySelectorAll(sel) {
          if (sel === 'input[type="file"]') return [localizedFileInput, globalFileInput];
          return [];
        }
      };

      global.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };
      global.document = {
        body: {},
        querySelectorAll(sel) {
          if (sel === 'textarea') return [summaryTaNoMaxLen];
          if (sel === '*') return [shadowHost];
          if (sel.includes('section')) return [multiInputCard, bgWrapper, localizedWidget, globalWidget];
          return [];
        }
      };

      try {
        const res = await cwsAssets.domInspectLocaleListing(expectedEnDesc, 2);
        // Should find detailedTaInShadow (not summaryTaNoMaxLen), and count exactly 1 screenshot in localizedWidget
        assert.equal(res.descriptionOk, true);
        assert.equal(res.descriptionStatus, 'ok');
        assert.equal(res.screenshotContainerFound, true);
        assert.equal(res.screenshotMediaCount, 1);
        assert.equal(res.screenshotDeleteButtonCount, 1);
        assert.equal(res.screenshotCount, 1);
        assert.equal(res.screenshotStatus, 'insufficient');
      } finally {
        global.window = prevWindow;
        global.document = prevDocument;
      }
    });

    it('verifyStoreListingAssets (--verify) inspects all target locales read-only, outputs OK/NG summary and --locales rerun command, and sets exitCode on NG', async () => {
      const parsed = cwsAssets.parseArgs(['--verify', '--locales', 'en,ja,ru']);
      assert.equal(parsed.verify, true);
      assert.equal(parsed.locales, 'en,ja,ru');

      assert.throws(
        () => cwsAssets.buildUploadPlan({ verify: true, skipScreenshots: true, skipDescriptions: true }),
        /Nothing to verify/
      );

      const listings = cwsAssets.loadStoreListings();
      const logs = [];
      const captureLogger = {
        log: (msg) => logs.push(String(msg)),
        error: (msg) => logs.push(String(msg))
      };

      let writeActionsAttempted = 0;
      const mockSession = {
        async goto(url) {
          this.currentUrl = url;
        },
        async evaluate(fn, ...args) {
          if (fn === cwsAssets.domFillDetailedDescription || fn === cwsAssets.domClearExistingScreenshots || fn === cwsAssets.domClickSaveDraft) {
            writeActionsAttempted++;
            throw new Error('Write helper must never be called in --verify mode');
          }
          if (fn === cwsAssets.domSelectLocale) {
            const loc = args[0];
            this.activeLocale = loc;
            return { matched: true, type: 'listbox', label: args[1][0] };
          }
          if (fn === cwsAssets.domInspectLocaleListing) {
            const expectedDesc = args[0];
            const expectedScreens = args[1];
            if (this.activeLocale === 'en') {
              return {
                inspected: true,
                ok: true,
                descriptionOk: true,
                descriptionStatus: 'ok',
                actualDescriptionLength: expectedDesc.length,
                expectedDescriptionLength: expectedDesc.length,
                screenshotsOk: true,
                screenshotStatus: 'ok',
                screenshotContainerFound: true,
                screenshotCount: expectedScreens,
                expectedScreenshots: expectedScreens
              };
            }
            if (this.activeLocale === 'ja') {
              // ja has only 1/2 screenshots
              return {
                inspected: true,
                ok: false,
                descriptionOk: true,
                descriptionStatus: 'ok',
                actualDescriptionLength: expectedDesc.length,
                expectedDescriptionLength: expectedDesc.length,
                screenshotsOk: false,
                screenshotStatus: 'insufficient',
                screenshotContainerFound: true,
                screenshotCount: 1,
                expectedScreenshots: expectedScreens
              };
            }
            // ru has empty description and 0/2 screenshots
            return {
              inspected: true,
              ok: false,
              descriptionOk: false,
              descriptionStatus: 'empty',
              actualDescriptionLength: 0,
              expectedDescriptionLength: expectedDesc.length,
              screenshotsOk: false,
              screenshotStatus: 'insufficient',
              screenshotContainerFound: true,
              screenshotCount: 0,
              expectedScreenshots: expectedScreens
            };
          }
          return {
            href: `https://chrome.google.com/webstore/devconsole/pub-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`,
            hasTextarea: true,
            hasFileInput: true
          };
        },
        async uploadFilesToInput() {
          writeActionsAttempted++;
          throw new Error('uploadFilesToInput must never be called in --verify mode');
        },
        async sleep() {},
        async close() {}
      };

      const prevExitCode = process.exitCode;
      try {
        process.exitCode = 0;
        const res = await cwsAssets.main(
          ['--verify', '--locales', 'en,ja,ru', '--step-delay', '1'],
          {},
          { browserSession: mockSession, logger: captureLogger }
        );

        assert.equal(writeActionsAttempted, 0);
        assert.equal(res.verify, true);
        assert.equal(res.allOk, false);
        assert.deepEqual(res.passedLocales, ['en']);
        assert.deepEqual(res.failedLocales, ['ja', 'ru']);
        assert.equal(res.rerunCommand, 'npm run cws:assets -- --locales ja,ru');
        assert.equal(process.exitCode, 1);

        const combinedLogs = logs.join('\n');
        assert.match(combinedLogs, /\[1\/3\] OK\s+en/);
        assert.match(combinedLogs, /\[2\/3\] NG\s+ja .* screenshots: NG \(1\/2\)/);
        assert.match(combinedLogs, /\[3\/3\] NG\s+ru .* description: NG \(empty, 0\/\d+ chars\), screenshots: NG \(0\/2\)/);
        assert.match(combinedLogs, /Summary: 1\/3 locale\(s\) OK, 2 NG\./);
        assert.match(combinedLogs, /npm run cws:assets -- --locales ja,ru/);
      } finally {
        process.exitCode = prevExitCode;
      }
    });

    it('uploadStoreListingAssets verifies screenshot count after upload, retries missing screenshots, and throws if still insufficient after max attempts', async () => {
      const tmpDir = createTempImagesDir(['ja']);
      const uploadedFiles = [];
      let clearCalls = 0;
      let inspectCalls = 0;

      // Scenario 1: 1st upload attempt registers only 1/2 screenshots; retry uploads only the 2nd screenshot and reaches 2/2
      const mockSessionRecover = {
        async goto(url) {
          this.currentUrl = url;
        },
        async evaluate(fn, ...args) {
          if (fn === cwsAssets.domSelectLocale) {
            return { matched: true, type: 'listbox', label: args[1][0] };
          }
          if (fn === cwsAssets.domFillDetailedDescription) {
            return { updated: true, length: args[0].length };
          }
          if (fn === cwsAssets.domClearExistingScreenshots) {
            clearCalls++;
            return { removedCount: 0 };
          }
          if (fn === cwsAssets.domInspectLocaleListing) {
            inspectCalls++;
            // Return 1 screenshot on first check, then 2 on retry check
            const count = inspectCalls === 1 ? 1 : 2;
            return {
              inspected: true,
              ok: count === 2,
              screenshotsOk: count === 2,
              screenshotContainerFound: true,
              screenshotCount: count,
              expectedScreenshots: 2
            };
          }
          if (fn === cwsAssets.domClickSaveDraft) {
            return { clicked: true, label: 'Save draft' };
          }
          return {
            href: `https://chrome.google.com/webstore/devconsole/pub-123/${cwsAssets.DEFAULT_EXTENSION_ID}/edit/listing`,
            hasTextarea: true,
            hasFileInput: true
          };
        },
        async uploadFilesToInput(finderFn, finderArgs, filePaths) {
          uploadedFiles.push({ assetType: finderArgs[0], filePaths });
        },
        async sleep() {},
        async close() {}
      };

      try {
        const res = await cwsAssets.uploadStoreListingAssets(
          {
            locales: 'ja',
            imagesDir: tmpDir,
            skipBanner: true,
            stepDelayMs: 1
          },
          {},
          { browserSession: mockSessionRecover, logger: silentLogger }
        );

        assert.equal(res.totalScreenshotsUploaded, 2);
        assert.equal(inspectCalls, 2);
        assert.equal(clearCalls, 1);
        assert.equal(uploadedFiles.length, 3); // 2 on attempt 1 + 1 missing second screenshot on attempt 2
        assert.ok(uploadedFiles[2].filePaths[0].endsWith('notispam-cleaner_screen-2_ja.png'));

        // Scenario 2: Screenshot count remains 1/2 across all 3 attempts -> throws clear error
        const mockSessionFail = {
          ...mockSessionRecover,
          async evaluate(fn, ...args) {
            if (fn === cwsAssets.domInspectLocaleListing) {
              return {
                inspected: true,
                ok: false,
                screenshotsOk: false,
                screenshotContainerFound: true,
                screenshotCount: 1,
                expectedScreenshots: 2
              };
            }
            return mockSessionRecover.evaluate(fn, ...args);
          }
        };

        await assert.rejects(
          () =>
            cwsAssets.uploadStoreListingAssets(
              {
                locales: 'ja',
                imagesDir: tmpDir,
                skipBanner: true,
                stepDelayMs: 1
              },
              {},
              { browserSession: mockSessionFail, logger: silentLogger }
            ),
          /Failed to verify localized screenshots for locale "ja" after 3 attempts: expected 2 screenshot\(s\), but found 1/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
