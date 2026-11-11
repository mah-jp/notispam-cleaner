#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const DEFAULT_EXTENSION_ID = 'dahnhdiabhegihofjijbchegffnkiaap';
const CWS_DEVCONSOLE_BASE = 'https://chrome.google.com/webstore/devconsole';
const DEFAULT_LISTINGS_PATH = path.resolve(__dirname, 'cws-store-listings.json');
const DEFAULT_IMAGES_DIR = path.resolve(__dirname, '..', 'images');
const DEFAULT_LOCALES_DIR = path.resolve(__dirname, '..', 'chrome_extension', '_locales');
const DEFAULT_USER_DATA_DIR = path.join(os.homedir(), '.cache', 'notispam-cleaner-cws-profile');

const PNG_SIGNATURE_HEX = '89504e470d0a1a0a';
const SCREENSHOT_WIDTH = 1280;
const SCREENSHOT_HEIGHT = 800;
const BANNER_WIDTH = 440;
const BANNER_HEIGHT = 280;
const MAX_DETAILED_DESC_LENGTH = 16000;
const MIN_DETAILED_DESC_LENGTH = 200;

/**
 * Parse CLI arguments for `scripts/cws-upload-assets.js`.
 * @param {string[]} argv
 */
function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    publisherId: null,
    extensionId: null,
    locales: null,
    imagesDir: null,
    listingsPath: null,
    skipScreenshots: false,
    skipDescriptions: false,
    skipBanner: false,
    keepExistingScreenshots: false,
    verify: false,
    dryRun: false,
    cdpUrl: null,
    debuggingPort: 9222,
    userDataDir: null,
    browserPath: null,
    headless: false,
    loginTimeoutMs: 300000,
    stepDelayMs: 600,
    help: false
  };

  let i = 0;

  function readValue(flagName) {
    if (
      i + 1 >= argv.length ||
      argv[i + 1].startsWith('--') ||
      /^-[a-zA-Z]/.test(argv[i + 1]) ||
      String(argv[i + 1]).trim() === ''
    ) {
      throw new Error(`Unknown or incomplete argument: ${flagName}`);
    }
    return argv[++i];
  }

  function readInlineValue(arg, prefix) {
    const val = arg.slice(prefix.length);
    if (!val.trim()) {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    return val;
  }

  function parsePositiveInt(rawVal, label, max = Number.MAX_SAFE_INTEGER) {
    const trimmed = String(rawVal).trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid ${label} "${rawVal}". Must be a positive integer.`);
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < 1 || num > max) {
      throw new Error(`Invalid ${label} "${rawVal}". Must be between 1 and ${max}.`);
    }
    return num;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--verify') {
      opts.verify = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--skip-screenshots') {
      opts.skipScreenshots = true;
    } else if (arg === '--skip-descriptions') {
      opts.skipDescriptions = true;
    } else if (arg === '--skip-banner') {
      opts.skipBanner = true;
    } else if (arg === '--keep-existing-screenshots') {
      opts.keepExistingScreenshots = true;
    } else if (arg === '--headless') {
      opts.headless = true;
    } else if (arg === '--publisher-id') {
      opts.publisherId = readValue(arg);
    } else if (arg.startsWith('--publisher-id=')) {
      opts.publisherId = readInlineValue(arg, '--publisher-id=');
    } else if (arg === '--extension-id') {
      opts.extensionId = readValue(arg);
    } else if (arg.startsWith('--extension-id=')) {
      opts.extensionId = readInlineValue(arg, '--extension-id=');
    } else if (arg === '--locales') {
      opts.locales = readValue(arg);
    } else if (arg.startsWith('--locales=')) {
      opts.locales = readInlineValue(arg, '--locales=');
    } else if (arg === '--images-dir') {
      opts.imagesDir = readValue(arg);
    } else if (arg.startsWith('--images-dir=')) {
      opts.imagesDir = readInlineValue(arg, '--images-dir=');
    } else if (arg === '--listings-path') {
      opts.listingsPath = readValue(arg);
    } else if (arg.startsWith('--listings-path=')) {
      opts.listingsPath = readInlineValue(arg, '--listings-path=');
    } else if (arg === '--cdp-url') {
      opts.cdpUrl = readValue(arg);
    } else if (arg.startsWith('--cdp-url=')) {
      opts.cdpUrl = readInlineValue(arg, '--cdp-url=');
    } else if (arg === '--debugging-port') {
      opts.debuggingPort = parsePositiveInt(readValue(arg), 'port', 65535);
    } else if (arg.startsWith('--debugging-port=')) {
      opts.debuggingPort = parsePositiveInt(arg.slice('--debugging-port='.length), 'port', 65535);
    } else if (arg === '--user-data-dir') {
      opts.userDataDir = readValue(arg);
    } else if (arg.startsWith('--user-data-dir=')) {
      opts.userDataDir = readInlineValue(arg, '--user-data-dir=');
    } else if (arg === '--browser-path') {
      opts.browserPath = readValue(arg);
    } else if (arg.startsWith('--browser-path=')) {
      opts.browserPath = readInlineValue(arg, '--browser-path=');
    } else if (arg === '--login-timeout') {
      opts.loginTimeoutMs = parsePositiveInt(readValue(arg), 'login-timeout');
    } else if (arg.startsWith('--login-timeout=')) {
      opts.loginTimeoutMs = parsePositiveInt(arg.slice('--login-timeout='.length), 'login-timeout');
    } else if (arg === '--step-delay') {
      opts.stepDelayMs = parsePositiveInt(readValue(arg), 'step-delay');
    } else if (arg.startsWith('--step-delay=')) {
      opts.stepDelayMs = parsePositiveInt(arg.slice('--step-delay='.length), 'step-delay');
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return opts;
}

/**
 * Load and validate the 35-locale Store Listings metadata JSON.
 * @param {string} listingsPath
 * @param {typeof fs} fsImpl
 */
function loadStoreListings(listingsPath = DEFAULT_LISTINGS_PATH, fsImpl = fs) {
  const resolved = path.resolve(listingsPath);
  if (!fsImpl.existsSync(resolved)) {
    throw new Error(`Store listings metadata file not found at: ${resolved}`);
  }
  const raw = fsImpl.readFileSync(resolved, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse store listings JSON at ${resolved}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid store listings JSON structure at ${resolved}: expected an object keyed by locale.`);
  }
  return parsed;
}

/**
 * Read PNG dimensions and validate signature.
 * @param {string} filePath
 * @param {number} expectedWidth
 * @param {number} expectedHeight
 * @param {typeof fs} fsImpl
 */
function validatePngAsset(filePath, expectedWidth, expectedHeight, fsImpl = fs) {
  const resolved = path.resolve(filePath);
  if (!fsImpl.existsSync(resolved)) {
    throw new Error(`Missing PNG asset file: ${resolved}`);
  }
  const stat = fsImpl.statSync(resolved);
  if (!stat.isFile() || stat.size < 24) {
    throw new Error(`PNG asset is empty or too small: ${resolved}`);
  }
  let buf;
  if (typeof fsImpl.openSync === 'function' && typeof fsImpl.readSync === 'function' && typeof fsImpl.closeSync === 'function') {
    const fd = fsImpl.openSync(resolved, 'r');
    try {
      buf = Buffer.alloc(26);
      fsImpl.readSync(fd, buf, 0, Math.min(26, stat.size), 0);
    } finally {
      fsImpl.closeSync(fd);
    }
  } else {
    buf = fsImpl.readFileSync(resolved);
  }
  const sig = buf.subarray(0, 8).toString('hex');
  if (sig !== PNG_SIGNATURE_HEX) {
    throw new Error(`Invalid PNG file signature in: ${resolved}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `Invalid PNG dimensions for ${path.basename(resolved)}: expected ${expectedWidth}x${expectedHeight}, got ${width}x${height}`
    );
  }
  // Chrome Web Store requires 24-bit PNG (no alpha channel; colorType 2, not 4 or 6)
  if (buf.length >= 26 && buf[24] > 0 && (buf[25] === 4 || buf[25] === 6)) {
    throw new Error(
      `Invalid PNG color type for ${path.basename(resolved)}: Chrome Web Store requires 24-bit PNG (no alpha channel), got colorType=${buf[25]}`
    );
  }
  return { path: resolved, width, height, size: stat.size };
}

/**
 * Resolve configuration and validate all target locales, descriptions, screenshots, and banners.
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 * @param {object} deps
 */
function buildUploadPlan(options = {}, env = process.env, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const publisherId = (options.publisherId ?? env.CWS_PUBLISHER_ID ?? '').trim() || null;
  const extensionId = (
    options.extensionId !== undefined && options.extensionId !== null
      ? String(options.extensionId)
      : (env.CWS_EXTENSION_ID || DEFAULT_EXTENSION_ID)
  ).trim();

  if (!extensionId) {
    throw new Error('Missing required CWS_EXTENSION_ID (or --extension-id).');
  }

  const listingsPath = path.resolve(options.listingsPath || env.CWS_LISTINGS_PATH || DEFAULT_LISTINGS_PATH);
  const imagesDir = path.resolve(options.imagesDir || env.CWS_IMAGES_DIR || DEFAULT_IMAGES_DIR);
  const userDataDir = path.resolve(options.userDataDir || env.CWS_USER_DATA_DIR || DEFAULT_USER_DATA_DIR);
  const browserPath = (options.browserPath ?? env.CHROME_BIN ?? '').trim() || null;
  const cdpUrl = (options.cdpUrl ?? env.CWS_CDP_URL ?? '').trim() || null;

  const skipScreenshots = Boolean(options.skipScreenshots);
  const skipDescriptions = Boolean(options.skipDescriptions);
  const skipBanner = Boolean(options.skipBanner);
  const keepExistingScreenshots = Boolean(options.keepExistingScreenshots);
  const verify = Boolean(options.verify);
  const dryRun = Boolean(options.dryRun);
  const headless = Boolean(options.headless);
  const debuggingPort = options.debuggingPort || 9222;
  const loginTimeoutMs = options.loginTimeoutMs || 300000;
  const stepDelayMs = options.stepDelayMs || 600;

  if (verify && skipScreenshots && skipDescriptions) {
    throw new Error('Nothing to verify: --skip-screenshots and --skip-descriptions cannot both be set with --verify.');
  }
  if (!verify && skipScreenshots && skipDescriptions && skipBanner) {
    throw new Error('Nothing to do: --skip-screenshots, --skip-descriptions, and --skip-banner cannot all be set.');
  }

  const listings = loadStoreListings(listingsPath, fsImpl);
  const allSupportedLocales = Object.keys(listings).sort();
  if (allSupportedLocales.length === 0) {
    throw new Error(`No locales found in ${listingsPath}`);
  }

  let targetLocales = allSupportedLocales;
  if (options.locales !== undefined && options.locales !== null && String(options.locales).trim() !== '') {
    const requested = String(options.locales)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (requested.length === 0) {
      throw new Error('Invalid --locales value: must specify at least one locale code.');
    }
    const unknown = requested.filter((loc) => !listings[loc]);
    if (unknown.length > 0) {
      throw new Error(
        `Unsupported locale(s): ${unknown.join(', ')}. Supported locales (${allSupportedLocales.length}): ${allSupportedLocales.join(', ')}`
      );
    }
    // Preserve requested order while deduplicating
    targetLocales = [...new Set(requested)];
  } else {
    // Put 'en' (primary locale) and 'ja' first so default/global assets are set immediately
    const priority = ['en', 'ja'].filter((l) => allSupportedLocales.includes(l));
    const rest = allSupportedLocales.filter((l) => !priority.includes(l));
    targetLocales = [...priority, ...rest];
  }

  const validatedPngCache = new Set();
  function ensureValidPng(filePath, w, h) {
    const key = `${path.resolve(filePath)}:${w}x${h}`;
    if (!validatedPngCache.has(key)) {
      validatePngAsset(filePath, w, h, fsImpl);
      validatedPngCache.add(key);
    }
  }

  const localePlans = [];
  for (const locale of targetLocales) {
    const entry = listings[locale];
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Missing listing entry for locale "${locale}".`);
    }
    if (!Array.isArray(entry.languageNames) || entry.languageNames.length === 0) {
      throw new Error(`Missing languageNames array for locale "${locale}".`);
    }

    const detailedDescription = String(entry.detailedDescription || '').trim();
    if (!skipDescriptions) {
      if (detailedDescription.length < MIN_DETAILED_DESC_LENGTH) {
        throw new Error(
          `Detailed description for locale "${locale}" is too short (${detailedDescription.length} chars, minimum ${MIN_DETAILED_DESC_LENGTH}).`
        );
      }
      if (detailedDescription.length > MAX_DETAILED_DESC_LENGTH) {
        throw new Error(
          `Detailed description for locale "${locale}" exceeds Chrome Web Store limit (${detailedDescription.length} > ${MAX_DETAILED_DESC_LENGTH} chars).`
        );
      }
    }

    let screenshotFiles = [];
    if (!skipScreenshots) {
      const s1 = path.join(imagesDir, `notispam-cleaner_screen-1_${locale}.png`);
      const s2 = path.join(imagesDir, `notispam-cleaner_screen-2_${locale}.png`);
      if (!verify || fsImpl.existsSync(s1)) {
        ensureValidPng(s1, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
      }
      if (!verify || fsImpl.existsSync(s2)) {
        ensureValidPng(s2, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
      }
      screenshotFiles = [s1, s2];
    }

    let promoBannerFile = null;
    if (!skipBanner) {
      const bannerName = locale === 'ja' ? 'notispam-cleaner_banner.png' : 'notispam-cleaner_banner_en.png';
      const bp = path.join(imagesDir, bannerName);
      if (!verify || fsImpl.existsSync(bp)) {
        ensureValidPng(bp, BANNER_WIDTH, BANNER_HEIGHT);
      }
      promoBannerFile = bp;
    }

    localePlans.push({
      locale,
      languageNames: entry.languageNames,
      extName: entry.extName || '',
      extDesc: entry.extDesc || '',
      detailedDescription,
      screenshotFiles,
      promoBannerFile
    });
  }

  const directStoreListingUrl = publisherId
    ? `${CWS_DEVCONSOLE_BASE}/${encodeURIComponent(publisherId)}/${encodeURIComponent(extensionId)}/edit/listing`
    : null;

  return {
    publisherId,
    extensionId,
    listingsPath,
    imagesDir,
    userDataDir,
    browserPath,
    cdpUrl,
    debuggingPort,
    headless,
    loginTimeoutMs,
    stepDelayMs,
    skipScreenshots,
    skipDescriptions,
    skipBanner,
    keepExistingScreenshots,
    verify,
    dryRun,
    directStoreListingUrl,
    dashboardEntryUrl: directStoreListingUrl || CWS_DEVCONSOLE_BASE,
    localePlans
  };
}

/**
 * Find an installed Google Chrome or Chromium binary on the host machine.
 * @param {string|null} customPath
 * @param {typeof fs} fsImpl
 * @param {NodeJS.Platform} platform
 */
function resolveBrowserExecutable(customPath = null, fsImpl = fs, platform = process.platform) {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (!fsImpl.existsSync(resolved)) {
      throw new Error(`Specified browser executable not found at: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (platform === 'win32') {
    const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(progFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(progFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      localAppData ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') : ''
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/brave-browser',
      '/usr/bin/microsoft-edge'
    );
  }

  for (const candidate of candidates) {
    if (candidate && fsImpl.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not find Google Chrome or Chromium executable. ' +
    'Install Google Chrome, set CHROME_BIN=/path/to/chrome, or connect to an existing browser with --cdp-url http://127.0.0.1:9222.'
  );
}

/**
 * Minimal RFC 6455 WebSocket client fallback using built-in `node:net` (used if global `WebSocket` is absent).
 */
function connectRawWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(wsUrl);
    const port = Number(parsed.port || 80);
    const host = parsed.hostname;
    const key = crypto.randomBytes(16).toString('base64');

    const socket = net.createConnection({ host, port }, () => {
      const req = [
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ].join('\r\n');
      socket.write(req);
    });

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);
    const listeners = { message: [], close: [], error: [] };

    function emit(type, arg) {
      for (const fn of listeners[type] || []) {
        fn(arg);
      }
    }

    function parseFrames() {
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) return;
          payloadLen = buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) return;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }

        const maskLen = isMasked ? 4 : 0;
        if (buffer.length < offset + maskLen + payloadLen) return;

        let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (isMasked) {
          const mask = buffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
          }
        }
        buffer = buffer.subarray(offset + maskLen + payloadLen);

        if (opcode === 0x01) {
          emit('message', { data: payload.toString('utf8') });
        } else if (opcode === 0x09) {
          // Respond to Ping with masked Pong frame (RFC 6455)
          const pongMask = crypto.randomBytes(4);
          const pongHeader = Buffer.from([0x8a, 0x80 | (payload.length & 0x7f)]);
          const pongBody = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) {
            pongBody[i] = payload[i] ^ pongMask[i % 4];
          }
          socket.write(Buffer.concat([pongHeader, pongMask, pongBody]));
        } else if (opcode === 0x08) {
          socket.end();
          emit('close', {});
          return;
        }
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const idx = buffer.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headerStr = buffer.subarray(0, idx).toString('utf8');
        buffer = buffer.subarray(idx + 4);
        if (!headerStr.startsWith('HTTP/1.1 101')) {
          socket.destroy();
          reject(new Error(`WebSocket handshake failed: ${headerStr.split('\r\n')[0]}`));
          return;
        }
        handshakeDone = true;
        resolve({
          send(dataStr) {
            const payload = Buffer.from(String(dataStr), 'utf8');
            const mask = crypto.randomBytes(4);
            let header;
            if (payload.length < 126) {
              header = Buffer.alloc(2);
              header[0] = 0x81;
              header[1] = 0x80 | payload.length;
            } else if (payload.length < 65536) {
              header = Buffer.alloc(4);
              header[0] = 0x81;
              header[1] = 0x80 | 126;
              header.writeUInt16BE(payload.length, 2);
            } else {
              header = Buffer.alloc(10);
              header[0] = 0x81;
              header[1] = 0x80 | 127;
              header.writeBigUInt64BE(BigInt(payload.length), 2);
            }
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) {
              masked[i] = payload[i] ^ mask[i % 4];
            }
            socket.write(Buffer.concat([header, mask, masked]));
          },
          close() {
            socket.end();
          },
          addEventListener(type, fn) {
            if (listeners[type]) listeners[type].push(fn);
          }
        });
        if (buffer.length > 0) {
          queueMicrotask(parseFrames);
        }
        return;
      }
      parseFrames();
    });

    socket.on('error', (err) => {
      if (!handshakeDone) reject(err);
      else emit('error', err);
    });
    socket.on('close', () => emit('close', {}));
  });
}

/**
 * Connect to a Chrome DevTools Protocol WebSocket endpoint and provide a promise-based RPC client.
 * @param {string} wsUrl
 */
async function createCdpConnection(wsUrl) {
  let ws;
  if (typeof WebSocket === 'function') {
    ws = await new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      const onOpen = () => {
        sock.removeEventListener('error', onError);
        resolve(sock);
      };
      const onError = (err) => {
        reject(new Error(`Failed to connect to CDP WebSocket at ${wsUrl}: ${err?.message || 'connection error'}`));
      };
      sock.addEventListener('open', onOpen, { once: true });
      sock.addEventListener('error', onError, { once: true });
    });
  } else {
    ws = await connectRawWebSocket(wsUrl);
  }

  let nextId = 1;
  const pending = new Map();
  const eventListeners = new Map();

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : String(event.data);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
      } else {
        resolve(msg.result || {});
      }
      return;
    }
    if (msg.method && eventListeners.has(msg.method)) {
      for (const fn of eventListeners.get(msg.method)) {
        try {
          fn(msg.params || {});
        } catch {
          // Ignore event listener errors
        }
      }
    }
  });

  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) {
      reject(new Error('CDP WebSocket connection closed unexpectedly.'));
    }
    pending.clear();
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      if (!eventListeners.has(method)) {
        eventListeners.set(method, []);
      }
      eventListeners.get(method).push(fn);
    },
    close() {
      ws.close();
    }
  };
}

/**
 * Launch or connect to Chrome via CDP and return a high-level `BrowserSession`.
 */
async function createCdpBrowserSession({
  cdpUrl = null,
  debuggingPort = 9222,
  userDataDir = DEFAULT_USER_DATA_DIR,
  browserPath = null,
  headless = false,
  fetchImpl = fetch,
  fsImpl = fs,
  spawnImpl = spawn,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  logger = console
}) {
  let baseHttpUrl = cdpUrl ? cdpUrl.replace(/\/+$/, '') : `http://127.0.0.1:${debuggingPort}`;
  let childProc = null;

  async function findPageWebSocketUrl() {
    const listRes = await fetchImpl(`${baseHttpUrl}/json/list`);
    if (!listRes.ok) {
      throw new Error(`HTTP ${listRes.status}`);
    }
    const targets = await listRes.json();
    const internalRe = /^(chrome:\/\/(omnibox|tab-search|new-tab-page-third-party)|chrome-untrusted:\/\/|chrome-extension:\/\/|devtools:\/\/)/i;
    const validPages = Array.isArray(targets)
      ? targets.filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl && !internalRe.test(String(t.url || '')))
      : [];
    const cwsTarget = validPages.find((t) => String(t.url || '').includes('/webstore/devconsole'));
    const pageTarget = cwsTarget || validPages[0] || null;
    if (pageTarget) {
      return pageTarget.webSocketDebuggerUrl;
    }
    const newRes = await fetchImpl(`${baseHttpUrl}/json/new?about:blank`, { method: 'PUT' });
    if (newRes.ok) {
      const created = await newRes.json();
      if (created && created.webSocketDebuggerUrl) {
        return created.webSocketDebuggerUrl;
      }
    }
    throw new Error('No inspectable page target available yet.');
  }

  let wsDebuggerUrl = null;
  try {
    wsDebuggerUrl = await findPageWebSocketUrl();
    logger.log(`[CWS Assets] Connected to existing Chrome DevTools instance at ${baseHttpUrl}.`);
  } catch {
    if (cdpUrl) {
      throw new Error(`Could not connect to Chrome DevTools endpoint at ${cdpUrl}. Ensure Chrome is running with --remote-debugging-port.`);
    }
    const exe = resolveBrowserExecutable(browserPath, fsImpl);
    fsImpl.mkdirSync(userDataDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1360,920'
    ];
    if (headless) {
      args.push('--headless=new');
    }
    args.push('about:blank');

    logger.log(`[CWS Assets] Launching browser: ${exe} (profile: ${userDataDir})...`);
    childProc = spawnImpl(exe, args, { stdio: 'ignore', detached: false });

    for (let attempt = 1; attempt <= 40; attempt++) {
      await sleepImpl(350);
      try {
        wsDebuggerUrl = await findPageWebSocketUrl();
        break;
      } catch {
        // Keep polling until Chrome opens debugging port
      }
    }
    if (!wsDebuggerUrl) {
      if (childProc) childProc.kill();
      throw new Error(`Timed out waiting for Chrome DevTools Protocol on port ${debuggingPort}.`);
    }
  }

  const cdp = await createCdpConnection(wsDebuggerUrl);
  if (typeof cdp.on === 'function') {
    cdp.on('Page.javascriptDialogOpening', () => {
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
  }
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp
    .send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'try { window.confirm = () => true; window.alert = () => {}; } catch {}'
    })
    .catch(() => {});

  return {
    async goto(url) {
      await cdp.send('Page.navigate', { url });
      await sleepImpl(800);
    },
    async evaluate(fn, ...args) {
      const expr = typeof fn === 'function'
        ? `(${fn.toString()})(...${JSON.stringify(args)})`
        : String(fn);
      const res = await cdp.send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true
      });
      if (res.exceptionDetails) {
        const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime evaluation error';
        throw new Error(`Browser page evaluation failed: ${msg}`);
      }
      return res.result ? res.result.value : undefined;
    },
    async uploadFilesToInput(finderFn, finderArgs, filePaths) {
      const expr = `(${finderFn.toString()})(...${JSON.stringify(finderArgs)})`;
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: false
      });
      if (evalRes.exceptionDetails) {
        const msg = evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text || 'Failed to locate file input';
        throw new Error(msg);
      }
      const objectId = evalRes.result?.objectId;
      if (!objectId || evalRes.result?.subtype === 'null') {
        throw new Error('Could not find target <input type="file"> element on the Store Listing page.');
      }

      const resolvedFiles = filePaths.map((p) => path.resolve(p));
      const filePayloads = [];
      if (fsImpl && typeof fsImpl.readFileSync === 'function') {
        for (const fp of resolvedFiles) {
          try {
            const buf = fsImpl.readFileSync(fp);
            if (Buffer.isBuffer(buf) && buf.length > 0) {
              filePayloads.push({
                name: path.basename(fp),
                mimeType: 'image/png',
                base64: buf.toString('base64'),
                size: buf.length
              });
            }
          } catch {
            // Ignore read errors in mock environments where paths are synthetic
          }
        }
      }

      // Snapshot the upload section state before setting files, install lightweight XHR/fetch in-flight tracking,
      // prepare an in-memory DataTransfer FileList fallback (so fuse.sshfs / Snap / remote CDP always receives full PNG bytes),
      // and reset input.value so reused SPA file inputs always detect a change.
      const prepRes = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        returnByValue: true,
        functionDeclaration: `function(payloads, assetType) {
          if (typeof window !== 'undefined') {
            try {
              window.confirm = () => true;
              window.alert = () => {};
            } catch {}
          }
          if (typeof window !== 'undefined' && !window.__cwsNetTrackerInstalled) {
            window.__cwsInFlightRequests = 0;
            window.__cwsTotalRequestsStarted = 0;
            window.__cwsLastNetworkActivityTs = 0;
            window.__cwsActiveRequests = new Map();
            window.__cwsNextReqId = 1;
            const MAX_REQ_TTL_MS = 6000;
            const IGNORE_URL_RE = /play\\.google\\.com\\/log|google-analytics|doubleclick|clearcut|favicon\\.ico/i;

            window.__cwsGetActiveReqCount = function() {
              const map = window.__cwsActiveRequests;
              if (!map || typeof map.entries !== 'function') {
                return Math.max(0, window.__cwsInFlightRequests || 0);
              }
              const now = Date.now();
              for (const [id, ts] of map.entries()) {
                if (now - ts > MAX_REQ_TTL_MS) {
                  map.delete(id);
                }
              }
              window.__cwsInFlightRequests = map.size;
              return map.size;
            };

            const trackStart = (urlStr) => {
              if (urlStr && IGNORE_URL_RE.test(String(urlStr))) {
                return null;
              }
              window.__cwsGetActiveReqCount();
              const id = window.__cwsNextReqId++;
              const now = Date.now();
              window.__cwsActiveRequests.set(id, now);
              window.__cwsInFlightRequests = window.__cwsActiveRequests.size;
              window.__cwsTotalRequestsStarted = (window.__cwsTotalRequestsStarted || 0) + 1;
              window.__cwsLastNetworkActivityTs = now;
              return id;
            };

            const trackEnd = (id) => {
              if (id !== null && window.__cwsActiveRequests) {
                window.__cwsActiveRequests.delete(id);
                window.__cwsInFlightRequests = window.__cwsActiveRequests.size;
              } else {
                window.__cwsInFlightRequests = Math.max(0, (window.__cwsInFlightRequests || 1) - 1);
              }
              window.__cwsLastNetworkActivityTs = Date.now();
            };

            if (typeof window.fetch === 'function') {
              const origFetch = window.fetch;
              window.fetch = function(...args) {
                const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const reqId = trackStart(reqUrl);
                let settled = false;
                const done = () => {
                  if (settled) return;
                  settled = true;
                  trackEnd(reqId);
                };
                try {
                  const p = origFetch.apply(this, args);
                  if (p && typeof p.then === 'function') {
                    p.then(done, done);
                  } else {
                    done();
                  }
                  return p;
                } catch (err) {
                  done();
                  throw err;
                }
              };
            }
            if (typeof window.XMLHttpRequest === 'function' && window.XMLHttpRequest.prototype) {
              const origOpen = window.XMLHttpRequest.prototype.open;
              if (typeof origOpen === 'function') {
                window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                  this.__cwsReqUrl = String(url || '');
                  return origOpen.call(this, method, url, ...rest);
                };
              }
              const origSend = window.XMLHttpRequest.prototype.send;
              if (typeof origSend === 'function') {
                window.XMLHttpRequest.prototype.send = function(...args) {
                  const reqId = trackStart(this.__cwsReqUrl || '');
                  let settled = false;
                  const done = () => {
                    if (settled) return;
                    settled = true;
                    trackEnd(reqId);
                  };
                  if (typeof this.addEventListener === 'function') {
                    this.addEventListener('loadend', done, { once: true });
                    this.addEventListener('error', done, { once: true });
                    this.addEventListener('abort', done, { once: true });
                  }
                  try {
                    return origSend.apply(this, args);
                  } catch (err) {
                    done();
                    throw err;
                  }
                };
              }
            }
            window.__cwsNetTrackerInstalled = true;
          }

          function getParentOrHost(el) {
            if (!el) return null;
            if (el.parentElement) return el.parentElement;
            if (typeof el.getRootNode === 'function') {
              const r = el.getRootNode();
              if (r && r.host) return r.host;
            }
            return null;
          }

          function findUploadWidgetContainer(el) {
            let cur = getParentOrHost(el);
            let best = cur;
            const bodyEl = typeof document !== 'undefined' ? document.body : null;
            for (let d = 0; d < 12 && cur && cur !== bodyEl; d++) {
              if (typeof cur.querySelectorAll === 'function' && cur.querySelectorAll('input[type="file"]').length > 1) {
                break;
              }
              best = cur;
              const tag = String(cur.tagName || '').toLowerCase();
              const role = String(cur.getAttribute?.('role') || '').toLowerCase();
              const txtLen = (cur.textContent || '').length;
              if (tag === 'section' || role === 'region' || txtLen > 800) {
                break;
              }
              cur = getParentOrHost(cur);
            }
            if (!best && typeof window !== 'undefined' && window.__cwsLastTargetSection) {
              return window.__cwsLastTargetSection;
            }
            return best;
          }

          function getContainerAssetState(container) {
            if (!container || typeof container.querySelectorAll !== 'function') {
              return { count: 0, delCount: 0, sig: '' };
            }
            const imgs = Array.from(container.querySelectorAll('img, [style*="background-image"]')).filter((el) => {
              const src = el.getAttribute?.('src') || '';
              return !/upload_illustration|empty_state|placeholder_icon/i.test(src);
            });
            const explicitDelBtns = Array.from(
              container.querySelectorAll(
                'button[aria-label*="Delete" i], button[aria-label*="Remove" i], button[aria-label*="削除"], ' +
                '[role="button"][aria-label*="Delete" i], [role="button"][aria-label*="Remove" i], [role="button"][aria-label*="削除"], ' +
                'button[title*="Delete" i], button[title*="Remove" i], button[title*="削除"], [data-action="delete-screenshot"]'
              )
            );
            const iconDelBtns = Array.from(container.querySelectorAll('button, [role="button"]')).filter((btn) => {
              const iconTxt = (btn.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
              return iconTxt === 'delete' || iconTxt === 'delete_outline' || iconTxt === '削除';
            });
            const delSet = new Set([...explicitDelBtns, ...iconDelBtns]);
            const sig = imgs
              .map((el) => el.getAttribute?.('src') || el.getAttribute?.('style') || '')
              .join('|');
            return {
              count: Math.max(imgs.length, delSet.size),
              delCount: delSet.size,
              sig
            };
          }

          const container = findUploadWidgetContainer(this);
          const state = getContainerAssetState(container);
          this.__cwsPrevItemCount = state.count;
          this.__cwsPrevDelCount = state.delCount;
          this.__cwsPrevAssetSig = state.sig;
          this.__cwsUsedInCurrentLocale = true;

          if (typeof window !== 'undefined') {
            if (typeof window.__cwsGetActiveReqCount === 'function') {
              window.__cwsGetActiveReqCount();
            }
            window.__cwsActiveUploadContainer = container;
            window.__cwsActiveUploadInput = this;
            window.__cwsPrevUploadState = {
              count: state.count,
              delCount: state.delCount,
              sig: state.sig,
              requestsStarted: window.__cwsTotalRequestsStarted || 0,
              inFlightAtStart: window.__cwsInFlightRequests || 0
            };
          }

          let fallbackFiles = null;
          if (
            Array.isArray(payloads) &&
            payloads.length > 0 &&
            typeof DataTransfer === 'function' &&
            typeof File === 'function' &&
            typeof atob === 'function'
          ) {
            try {
              const dt = new DataTransfer();
              for (const p of payloads) {
                const binStr = atob(p.base64);
                const bytes = new Uint8Array(binStr.length);
                for (let i = 0; i < binStr.length; i++) {
                  bytes[i] = binStr.charCodeAt(i);
                }
                const f = new File([bytes], p.name, {
                  type: p.mimeType || 'image/png',
                  lastModified: Date.now()
                });
                dt.items.add(f);
              }
              fallbackFiles = dt.files;
              this.__cwsFallbackDataTransfer = dt;
              this.__cwsFallbackFiles = fallbackFiles;
              if (typeof window !== 'undefined') {
                window.__cwsActiveFallbackDataTransfer = dt;
              }
            } catch {}
          }

          try { this.value = ''; } catch {}
          this.__cwsChangeFired = false;

          if (typeof this.removeEventListener === 'function') {
            if (this.__cwsInputCaptureHandler) {
              try { this.removeEventListener('input', this.__cwsInputCaptureHandler, true); } catch {}
              delete this.__cwsInputCaptureHandler;
            }
            if (this.__cwsChangeCaptureHandler) {
              try { this.removeEventListener('change', this.__cwsChangeCaptureHandler, true); } catch {}
              delete this.__cwsChangeCaptureHandler;
            }
          }

          if (typeof this.addEventListener === 'function') {
            const ensureInMemoryFiles = () => {
              if (this.__cwsFallbackFiles && this.__cwsFallbackFiles.length > 0) {
                const curLen = this.files ? this.files.length : 0;
                const firstSize = curLen > 0 && this.files[0] ? this.files[0].size : 0;
                if (curLen === 0 || firstSize === 0) {
                  try { this.files = this.__cwsFallbackFiles; } catch {}
                }
              }
            };
            const onChangeCapture = () => {
              ensureInMemoryFiles();
              this.__cwsChangeFired = true;
            };
            this.__cwsInputCaptureHandler = ensureInMemoryFiles;
            this.__cwsChangeCaptureHandler = onChangeCapture;
            this.addEventListener('input', ensureInMemoryFiles, { capture: true, once: true });
            this.addEventListener('change', onChangeCapture, { capture: true, once: true });
          }

          return {
            hasDom: typeof document !== 'undefined' && Boolean(container || (this && this.parentElement))
          };
        }`,
        arguments: [{ value: filePayloads }, { value: finderArgs?.[0] || 'screenshots' }]
      });

      const hasDom = Boolean(prepRes?.result?.value?.hasDom);

      let backendNodeId = null;
      try {
        const descRes = await cdp.send('DOM.describeNode', { objectId });
        backendNodeId = descRes?.node?.backendNodeId || null;
      } catch {
        // Ignore if DOM.describeNode is unsupported by mock or target
      }

      try {
        await cdp.send('DOM.setFileInputFiles', {
          objectId,
          ...(backendNodeId ? { backendNodeId } : {}),
          files: resolvedFiles
        });
      } catch (cdpErr) {
        if (filePayloads.length === 0) {
          throw cdpErr;
        }
      }

      await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          if (this.__cwsFallbackFiles && this.__cwsFallbackFiles.length > 0) {
            const curLen = this.files ? this.files.length : 0;
            const firstSize = curLen > 0 && this.files[0] ? this.files[0].size : 0;
            if (curLen === 0 || firstSize === 0 || !this.__cwsChangeFired) {
              try { this.files = this.__cwsFallbackFiles; } catch {}
            }
          }
          if (!this.__cwsChangeFired) {
            this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
          if (typeof this.removeEventListener === 'function') {
            if (this.__cwsInputCaptureHandler) {
              try { this.removeEventListener('input', this.__cwsInputCaptureHandler, true); } catch {}
              delete this.__cwsInputCaptureHandler;
            }
            if (this.__cwsChangeCaptureHandler) {
              try { this.removeEventListener('change', this.__cwsChangeCaptureHandler, true); } catch {}
              delete this.__cwsChangeCaptureHandler;
            }
          }
          delete this.__cwsChangeFired;
        }`
      });

      // Wait for the CWS upload widget to process the file(s) and finish any in-flight XHR/fetch or upload spinner.
      // Only dispatch a fallback DragEvent('drop') if neither a network upload request nor a DOM/spinner change was initiated.
      let dropDispatched = false;
      for (let poll = 0; poll < 32; poll++) {
        if (hasDom) {
          await sleepImpl(250);
        }
        let status = null;
        try {
          const checkRes = await cdp.send('Runtime.callFunctionOn', {
            objectId,
            returnByValue: true,
            functionDeclaration: `function(shouldDispatchDrop, pollIdx) {
              if (typeof document === 'undefined') {
                return { done: true, hasDom: false };
              }
              function getParentOrHost(el) {
                if (!el) return null;
                if (el.parentElement) return el.parentElement;
                if (typeof el.getRootNode === 'function') {
                  const r = el.getRootNode();
                  if (r && r.host) return r.host;
                }
                return null;
              }
              function findUploadWidgetContainer(el) {
                let cur = getParentOrHost(el);
                let best = cur;
                for (let d = 0; d < 12 && cur && cur !== document.body; d++) {
                  if (typeof cur.querySelectorAll === 'function' && cur.querySelectorAll('input[type="file"]').length > 1) {
                    break;
                  }
                  best = cur;
                  const tag = String(cur.tagName || '').toLowerCase();
                  const role = String(cur.getAttribute?.('role') || '').toLowerCase();
                  const txtLen = (cur.textContent || '').length;
                  if (tag === 'section' || role === 'region' || txtLen > 800) {
                    break;
                  }
                  cur = getParentOrHost(cur);
                }
                return best;
              }
              function isSpinnerActuallyVisible(el, stopAt) {
                if (!el) return false;
                if (el.hidden === true || String(el.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') {
                  return false;
                }
                const cls = String(el.className || el.getAttribute?.('class') || '');
                if (/\\b(mdc-linear-progress--closed|hidden|ng-hide)\\b/i.test(cls)) {
                  return false;
                }
                if (typeof el.getBoundingClientRect === 'function') {
                  try {
                    const r = el.getBoundingClientRect();
                    if (r && (r.width <= 0 || r.height <= 0)) return false;
                  } catch {}
                }
                let cur = el;
                const bodyEl = typeof document !== 'undefined' ? document.body : null;
                for (let d = 0; d < 8 && cur && cur !== bodyEl; d++) {
                  if (cur.hidden === true || String(cur.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') {
                    return false;
                  }
                  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
                    try {
                      const st = window.getComputedStyle(cur);
                      if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) {
                        return false;
                      }
                    } catch {}
                  }
                  if (cur === stopAt) break;
                  cur = getParentOrHost(cur);
                }
                return true;
              }
              function getContainerAssetState(container) {
                if (!container || typeof container.querySelectorAll !== 'function') {
                  return { count: 0, delCount: 0, sig: '' };
                }
                const imgs = Array.from(container.querySelectorAll('img, [style*="background-image"]')).filter((el) => {
                  const src = el.getAttribute?.('src') || '';
                  return !/upload_illustration|empty_state|placeholder_icon/i.test(src);
                });
                const explicitDelBtns = Array.from(
                  container.querySelectorAll(
                    'button[aria-label*="Delete" i], button[aria-label*="Remove" i], button[aria-label*="削除"], ' +
                    '[role="button"][aria-label*="Delete" i], [role="button"][aria-label*="Remove" i], [role="button"][aria-label*="削除"], ' +
                    'button[title*="Delete" i], button[title*="Remove" i], button[title*="削除"], [data-action="delete-screenshot"]'
                  )
                );
                const iconDelBtns = Array.from(container.querySelectorAll('button, [role="button"]')).filter((btn) => {
                  const iconTxt = (btn.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                  return iconTxt === 'delete' || iconTxt === 'delete_outline' || iconTxt === '削除';
                });
                const delSet = new Set([...explicitDelBtns, ...iconDelBtns]);
                const sig = imgs
                  .map((el) => el.getAttribute?.('src') || el.getAttribute?.('style') || '')
                  .join('|');
                return {
                  count: Math.max(imgs.length, delSet.size),
                  delCount: delSet.size,
                  sig
                };
              }

              const win = typeof window !== 'undefined' ? window : {};
              const container =
                (win.__cwsActiveUploadContainer && win.__cwsActiveUploadContainer.isConnected !== false
                  ? win.__cwsActiveUploadContainer
                  : null) ||
                findUploadWidgetContainer(this) ||
                win.__cwsLastTargetSection ||
                null;

              if (!container) {
                return { done: true, hasDom: false };
              }

              const state = getContainerAssetState(container);
              const prev = win.__cwsPrevUploadState || {
                count: typeof this?.__cwsPrevItemCount === 'number' ? this.__cwsPrevItemCount : 0,
                delCount: typeof this?.__cwsPrevDelCount === 'number' ? this.__cwsPrevDelCount : 0,
                sig: typeof this?.__cwsPrevAssetSig === 'string' ? this.__cwsPrevAssetSig : '',
                requestsStarted: 0,
                inFlightAtStart: 0
              };

              const spinnerSelector =
                '[role="progressbar"], mat-spinner, mat-progress-spinner, mat-progress-bar, .mdc-linear-progress, .mdc-circular-progress, [aria-busy="true"]';
              const spinners = typeof container.querySelectorAll === 'function'
                ? Array.from(container.querySelectorAll(spinnerSelector)).filter((el) => isSpinnerActuallyVisible(el, container))
                : [];
              const inFlightReqs = typeof win.__cwsGetActiveReqCount === 'function'
                ? win.__cwsGetActiveReqCount()
                : (typeof win.__cwsInFlightRequests === 'number' ? win.__cwsInFlightRequests : 0);
              const totalReqs = typeof win.__cwsTotalRequestsStarted === 'number' ? win.__cwsTotalRequestsStarted : 0;
              const networkStarted = totalReqs > (prev.requestsStarted || 0);
              const activeUploadReqs = networkStarted ? inFlightReqs : Math.max(0, inFlightReqs - (prev.inFlightAtStart || 0));
              const isUploading = spinners.length > 0 || activeUploadReqs > 0;
              const itemChanged =
                state.count > prev.count ||
                state.delCount > prev.delCount ||
                state.sig !== prev.sig;

              if ((itemChanged || networkStarted) && !isUploading) {
                delete this.__cwsFallbackDataTransfer;
                delete this.__cwsFallbackFiles;
                if (win.__cwsActiveFallbackDataTransfer) delete win.__cwsActiveFallbackDataTransfer;
                return { done: true, itemChanged, networkStarted, isUploading: false };
              }

              if (itemChanged && activeUploadReqs === 0 && pollIdx >= 3) {
                delete this.__cwsFallbackDataTransfer;
                delete this.__cwsFallbackFiles;
                if (win.__cwsActiveFallbackDataTransfer) delete win.__cwsActiveFallbackDataTransfer;
                return { done: true, itemChanged, networkStarted, isUploading: false };
              }

              if (shouldDispatchDrop && !itemChanged && !networkStarted && !isUploading) {
                try {
                  let dt = this?.__cwsFallbackDataTransfer || win.__cwsActiveFallbackDataTransfer || null;
                  if (!dt && typeof DataTransfer === 'function' && this?.files && this.files.length > 0) {
                    dt = new DataTransfer();
                    for (const f of Array.from(this.files)) {
                      dt.items.add(f);
                    }
                  }
                  if (dt && typeof DragEvent === 'function') {
                    const dropTarget =
                      (container && container.querySelector?.('[jsaction*="drop" i], [ondrop], .dropzone')) ||
                      container;
                    for (const evType of ['dragenter', 'dragover', 'drop']) {
                      dropTarget.dispatchEvent(
                        new DragEvent(evType, {
                          bubbles: true,
                          cancelable: true,
                          composed: true,
                          dataTransfer: dt
                        })
                      );
                    }
                    return { done: false, dropSent: true, isUploading };
                  }
                } catch {}
              }

              if (pollIdx >= 8 && !isUploading) {
                delete this.__cwsFallbackDataTransfer;
                delete this.__cwsFallbackFiles;
                if (win.__cwsActiveFallbackDataTransfer) delete win.__cwsActiveFallbackDataTransfer;
                return { done: true, itemChanged, networkStarted, isUploading: false };
              }

              return { done: false, itemChanged, networkStarted, isUploading };
            }`,
            arguments: [{ value: !dropDispatched && poll >= 3 }, { value: poll }]
          });
          status = checkRes?.result?.value || { done: true };
          if (status.dropSent) {
            dropDispatched = true;
          }
        } catch {
          // If objectId became stale because the SPA re-rendered the component after upload, upload completed
          break;
        }
        if (status.done) {
          break;
        }
      }
      if (typeof cdp.send === 'function') {
        cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
      }
    },
    async sleep(ms) {
      await sleepImpl(ms);
    },
    async close() {
      try {
        cdp.close();
      } catch {
        // Ignore close errors
      }
      if (childProc) {
        try {
          childProc.kill();
        } catch {
          // Ignore kill errors
        }
      }
    }
  };
}

/**
 * In-page DOM helper: Select the target locale from the Chrome Web Store Developer Dashboard
 * Store Listing language selector dropdown.
 * Executed inside the browser page context via `session.evaluate(...)`.
 */
async function domSelectLocale(localeCode, languageNames) {
  if (typeof window !== 'undefined') {
    window.__cwsExpectedDetailedDescription = null;
    delete window.__cwsLastTargetSection;
    delete window.__cwsActiveUploadContainer;
    delete window.__cwsActiveUploadInput;
    delete window.__cwsPrevUploadState;
    delete window.__cwsActiveFallbackDataTransfer;
    if (window.__cwsActiveRequests && typeof window.__cwsActiveRequests.clear === 'function') {
      window.__cwsActiveRequests.clear();
    }
    window.__cwsInFlightRequests = 0;
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      for (const inp of Array.from(document.querySelectorAll('input[type="file"]'))) {
        delete inp.__cwsUsedInCurrentLocale;
      }
    }

    if (!window.__cwsNetTrackerInstalled) {
      window.__cwsTotalRequestsStarted = 0;
      window.__cwsLastNetworkActivityTs = 0;
      window.__cwsActiveRequests = new Map();
      window.__cwsNextReqId = 1;
      const MAX_REQ_TTL_MS = 12000;
      const IGNORE_URL_RE =
        /play\.google\.com\/log|google-analytics|doubleclick|clearcut|favicon\.ico|\/channel\/|\/bind\b|webchannel/i;

      window.__cwsGetActiveReqCount = function () {
        const map = window.__cwsActiveRequests;
        if (!map || typeof map.entries !== 'function') {
          return Math.max(0, window.__cwsInFlightRequests || 0);
        }
        const now = Date.now();
        for (const [id, ts] of map.entries()) {
          if (now - ts > MAX_REQ_TTL_MS) {
            map.delete(id);
          }
        }
        window.__cwsInFlightRequests = map.size;
        return map.size;
      };

      const trackStart = (urlStr) => {
        if (urlStr && IGNORE_URL_RE.test(String(urlStr))) {
          return null;
        }
        window.__cwsGetActiveReqCount();
        const id = window.__cwsNextReqId++;
        const now = Date.now();
        window.__cwsActiveRequests.set(id, now);
        window.__cwsInFlightRequests = window.__cwsActiveRequests.size;
        window.__cwsTotalRequestsStarted = (window.__cwsTotalRequestsStarted || 0) + 1;
        window.__cwsLastNetworkActivityTs = now;
        return id;
      };

      const trackEnd = (id) => {
        if (id !== null && window.__cwsActiveRequests) {
          window.__cwsActiveRequests.delete(id);
          window.__cwsInFlightRequests = window.__cwsActiveRequests.size;
        } else {
          window.__cwsInFlightRequests = Math.max(0, (window.__cwsInFlightRequests || 1) - 1);
        }
        window.__cwsLastNetworkActivityTs = Date.now();
      };

      if (typeof window.fetch === 'function') {
        const origFetch = window.fetch;
        window.fetch = function (...args) {
          const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
          const reqId = trackStart(reqUrl);
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            trackEnd(reqId);
          };
          try {
            const p = origFetch.apply(this, args);
            if (p && typeof p.then === 'function') {
              p.then(done, done);
            } else {
              done();
            }
            return p;
          } catch (err) {
            done();
            throw err;
          }
        };
      }
      if (typeof window.XMLHttpRequest === 'function' && window.XMLHttpRequest.prototype) {
        const origOpen = window.XMLHttpRequest.prototype.open;
        if (typeof origOpen === 'function') {
          window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__cwsReqUrl = String(url || '');
            return origOpen.call(this, method, url, ...rest);
          };
        }
        const origSend = window.XMLHttpRequest.prototype.send;
        if (typeof origSend === 'function') {
          window.XMLHttpRequest.prototype.send = function (...args) {
            const reqId = trackStart(this.__cwsReqUrl || '');
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              trackEnd(reqId);
            };
            if (typeof this.addEventListener === 'function') {
              this.addEventListener('loadend', done, { once: true });
              this.addEventListener('error', done, { once: true });
              this.addEventListener('abort', done, { once: true });
            }
            try {
              return origSend.apply(this, args);
            } catch (err) {
              done();
              throw err;
            }
          };
        }
      }
      window.__cwsNetTrackerInstalled = true;
    }
  }

  function normalizeText(str) {
    return String(str || '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/（/g, '(')
      .replace(/）/g, ')')
      .replace(/［/g, '[')
      .replace(/］/g, ']')
      .replace(/[–—―－]/g, '-')
      .replace(/[、，]/g, ',')
      .replace(/：/g, ':')
      .replace(/\s*\(\s*/g, ' (')
      .replace(/\s*\)\s*/g, ')')
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function compactText(str) {
    return normalizeText(str).replace(/\s*\(\s*/g, '(');
  }

  function cleanOptionLabel(str) {
    return normalizeText(str)
      .replace(
        /^(?:check_circle_outline|check_circle|done_all|radio_button_checked|radio_button_unchecked|check|done|[✓✔☑])\s*/i,
        ''
      )
      .replace(
        /(?:\s*-\s*|\s*[\(\[])(?:default|デフォルト|既定|主言語|primary|完了|未完了|未入力|下書き|draft|completed|incomplete)[\)\]]?$/i,
        ''
      )
      .trim();
  }

  const normCode = String(localeCode).trim().toLowerCase().replace(/_/g, '-');
  const rawCode = String(localeCode).trim().toLowerCase();
  const exactLabels = (languageNames || []).map(normalizeText).filter(Boolean);
  const compactLabels = new Set(exactLabels.map(compactText));

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function matchesTextCandidate(rawCandidate) {
    const text = normalizeText(rawCandidate);
    const cleaned = cleanOptionLabel(rawCandidate);
    if (!text && !cleaned) return 0;
    const textCompact = compactText(text);
    const cleanedCompact = compactText(cleaned);

    if (
      exactLabels.includes(text) ||
      exactLabels.includes(cleaned) ||
      compactLabels.has(textCompact) ||
      compactLabels.has(cleanedCompact)
    ) {
      return 2; // Exact label match
    }

    for (const lbl of exactLabels) {
      if (
        lbl.length >= 2 &&
        (text === `${lbl} (${rawCode})` ||
          text === `${lbl} (${normCode})` ||
          cleaned === `${lbl} (${rawCode})` ||
          cleaned === `${lbl} (${normCode})` ||
          text === `${rawCode} - ${lbl}` ||
          text === `${normCode} - ${lbl}` ||
          cleaned === `${rawCode} - ${lbl}` ||
          cleaned === `${normCode} - ${lbl}`)
      ) {
        return 2;
      }
    }

    // Handle compound labels such as "中国語 (簡体) - 中文 (简体)" or "ロシア語 - Русский"
    if (cleaned.includes(' - ') || cleaned.includes(' / ')) {
      const parts = cleaned
        .split(/\s+(?:-|\/)\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (
        parts.length >= 2 &&
        parts.some((p) => exactLabels.includes(p) || compactLabels.has(compactText(p)))
      ) {
        return 2;
      }
    }

    // Unambiguous regional / language disambiguation fallbacks for zh_CN, zh_TW, and ru
    if (normCode === 'zh-cn') {
      const isChinese = /chinese|中国語|中文|汉语|漢語|簡体|简体|\bzh\b/i.test(cleaned);
      const isSimplifiedOrChina =
        /simplified|簡体|简体|china|prc|中華人民共和国|中国(?!語)|zh-cn|zh_cn|zh-hans|\bhans\b/i.test(
          cleaned
        );
      const isOtherChinese =
        /traditional|繁体|繁體|taiwan|台湾|台灣|hong\s*kong|香港|macau|マカオ|澳門|zh-tw|zh_tw|zh-hant|zh-hk|\bhant\b/i.test(
          cleaned
        );
      if (isChinese && isSimplifiedOrChina && !isOtherChinese) {
        return 1;
      }
    } else if (normCode === 'zh-tw') {
      const isChinese = /chinese|中国語|中文|汉语|漢語|繁体|繁體|\bzh\b/i.test(cleaned);
      const isTraditionalOrTaiwan =
        /traditional|繁体|繁體|taiwan|台湾|台灣|zh-tw|zh_tw|zh-hant|\bhant\b/i.test(cleaned);
      const isOtherChinese =
        /simplified|簡体|简体|china|prc|中華人民共和国|中国(?!語)|hong\s*kong|香港|macau|マカオ|澳門|zh-cn|zh_cn|zh-hans|zh-hk|\bhans\b/i.test(
          cleaned
        );
      if (isChinese && isTraditionalOrTaiwan && !isOtherChinese) {
        return 1;
      }
    } else if (normCode === 'ru') {
      if (
        /^(?:ロシア語|russian|русский)(?:\s*\((?:ロシア|russia|россия|ru|ru-ru)\))?$/i.test(cleaned) &&
        !/belarus|ベラルーシ|беларусь/i.test(cleaned)
      ) {
        return 2;
      }
    }

    return 0;
  }

  function matchesOption(optEl) {
    if (!optEl) return 0;
    const valAttr = (
      optEl.getAttribute?.('data-value') ||
      optEl.getAttribute?.('data-locale') ||
      optEl.getAttribute?.('value') ||
      optEl.getAttribute?.('lang') ||
      optEl.getAttribute?.('data-code') ||
      optEl.getAttribute?.('data-language') ||
      ''
    )
      .trim()
      .toLowerCase();
    const valNorm = valAttr.replace(/_/g, '-');
    if (
      valAttr &&
      (valAttr === rawCode ||
        valNorm === normCode ||
        (valAttr.length <= 12 && exactLabels.includes(valAttr)) ||
        (valNorm.length <= 12 && exactLabels.includes(valNorm)))
    ) {
      return 3; // Highest priority: exact code attribute match (including iw -> he, nb -> no, zh-Hans -> zh_CN)
    }

    const primaryChild = optEl.querySelector?.(
      '.mdc-list-item__primary-text, .mat-option-text, .VfPpkd-StrnGf-rymPhb-b9t22c, .mdc-deprecated-list-item__text, .goog-menuitem-content, [jsname="K4r5Ff"]'
    );
    if (primaryChild && primaryChild.textContent) {
      const childScore = matchesTextCandidate(primaryChild.textContent);
      if (childScore > 0) return childScore;
    }
    return matchesTextCandidate(optEl.textContent);
  }

  // 1. Check native <select> elements first
  const selects = Array.from(document.querySelectorAll('select')).filter(isVisible);
  for (const sel of selects) {
    const options = Array.from(sel.options || []);
    let bestOpt = null;
    let bestScore = 0;
    for (const opt of options) {
      const score = matchesOption(opt);
      if (score > bestScore) {
        bestScore = score;
        bestOpt = opt;
      }
    }
    if (bestOpt) {
      sel.value = bestOpt.value;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { matched: true, type: 'select', label: (bestOpt.textContent || '').trim() };
    }
  }

  // 2. Check custom Material / Closure dropdowns ([role="combobox"], [role="listbox"], mat-select, [aria-haspopup="listbox"])
  const langTriggerRe = /language|locale|言語|表示言語|english|日本語/i;
  const nonLangExcludeRe = /category|カテゴリ|mature|visibility|公開範囲|region/i;

  const rawTriggers = Array.from(
    document.querySelectorAll(
      '[role="combobox"], [role="listbox"], mat-select, [aria-haspopup="listbox"], [data-locale-selector]'
    )
  ).filter(isVisible);

  const cachedTrigger =
    typeof window !== 'undefined' && window.__cwsLangTrigger && window.__cwsLangTrigger.isConnected !== false
      ? window.__cwsLangTrigger
      : null;

  const triggers = rawTriggers.sort((a, b) => {
    function scoreTrigger(el) {
      if (cachedTrigger && el === cachedTrigger) return 10;
      const metaParts = [
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('data-locale-selector') || '',
        el.textContent || ''
      ];
      let cur = el.parentElement;
      for (let d = 0; d < 4 && cur && cur !== document.body; d++) {
        const txt = (cur.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt && txt.length <= 250) metaParts.push(txt);
        const prevSib = cur.previousElementSibling;
        if (prevSib) {
          const sibTxt = (prevSib.textContent || '').replace(/\s+/g, ' ').trim();
          if (sibTxt && sibTxt.length <= 120) metaParts.push(sibTxt);
        }
        cur = cur.parentElement;
      }
      const meta = metaParts.join(' ');
      if (nonLangExcludeRe.test(meta) && !langTriggerRe.test(el.getAttribute?.('aria-label') || '')) return -1;
      if (langTriggerRe.test(meta)) return 2;
      return 0;
    }
    return scoreTrigger(b) - scoreTrigger(a);
  });

  const isFullDom = typeof document !== 'undefined' && typeof document.createElement === 'function';

  function getPrimaryTextareaValue() {
    if (!isFullDom || typeof document.querySelectorAll !== 'function') return '';
    const tas = Array.from(document.querySelectorAll('textarea')).filter((el) => {
      if (!el || el.disabled || el.readOnly) return false;
      if (el.maxLength > 0 && el.maxLength <= 200) return false;
      const cls = String(el.className || el.getAttribute?.('class') || '');
      if (/\bcdk-textarea-autosize-measuring\b/i.test(cls)) return false;
      return isVisible(el);
    });
    return tas.length > 0 ? String(tas[0].value || '') : '';
  }

  function clickElementWithMouseEvents(el) {
    if (!el || typeof el.click !== 'function') return;
    if (typeof el.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
      try {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      } catch {}
    }
    el.click();
  }

  function findScrollableMenuContainer(el) {
    let cur = el ? el.parentElement : null;
    let firstOverflowCandidate = null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (
        typeof cur.scrollHeight === 'number' &&
        typeof cur.clientHeight === 'number' &&
        cur.scrollHeight > cur.clientHeight + 4
      ) {
        if (!firstOverflowCandidate) {
          firstOverflowCandidate = cur;
        }
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          try {
            const ov = window.getComputedStyle(cur)?.overflowY;
            if (ov === 'auto' || ov === 'scroll' || ov === 'overlay') {
              return cur;
            }
          } catch {}
        } else {
          return cur;
        }
      }
      cur = cur.parentElement;
    }
    return firstOverflowCandidate;
  }

  function scrollOptionIntoMenuContainer(optEl) {
    if (!optEl) return false;
    const menuContainer = findScrollableMenuContainer(optEl);
    if (menuContainer) {
      try {
        const optRect = typeof optEl.getBoundingClientRect === 'function' ? optEl.getBoundingClientRect() : null;
        const curRect =
          typeof menuContainer.getBoundingClientRect === 'function' ? menuContainer.getBoundingClientRect() : null;
        if (
          optRect &&
          curRect &&
          curRect.height > 0 &&
          typeof optRect.top === 'number' &&
          typeof curRect.top === 'number'
        ) {
          const relativeTop = optRect.top - curRect.top + (menuContainer.scrollTop || 0);
          menuContainer.scrollTop = Math.max(0, relativeTop - Math.floor(menuContainer.clientHeight / 2));
        } else {
          const targetTop = Math.max(0, (optEl.offsetTop || 0) - Math.floor(menuContainer.clientHeight / 2));
          menuContainer.scrollTop = targetTop;
        }
        if (typeof menuContainer.dispatchEvent === 'function' && typeof Event === 'function') {
          try {
            menuContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
          } catch {}
        }
        return true;
      } catch {}
    }
    optEl.scrollIntoView?.({ block: 'nearest' });
    return false;
  }

  function findBestMatchingOption(optionList) {
    let bestOpt = null;
    let bestScore = 0;
    for (const opt of optionList) {
      const score = matchesOption(opt);
      if (score > bestScore) {
        bestScore = score;
        bestOpt = opt;
      }
    }
    return { bestOpt, bestScore };
  }

  const optionSelector = '[role="option"], mat-option, .goog-menuitem, li[data-value], [data-locale]';

  for (const trigger of triggers) {
    const prevTriggerText = normalizeText(trigger.textContent || '');
    const wasAlreadyOnTargetLocale = matchesOption(trigger) > 0;
    const prevTextareaValue = getPrimaryTextareaValue();
    trigger.click();

    let options = [];
    for (let poll = 0; poll < 5; poll++) {
      await new Promise((r) => setTimeout(r, 150));
      options = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
      if (options.length > 1) break;
      if (options.length === 1 && (!isFullDom || matchesOption(options[0]) > 0)) break;
      if (poll === 1 && options.length <= 1) {
        clickElementWithMouseEvents(trigger);
      }
    }

    let { bestOpt } = findBestMatchingOption(options);

    if (!bestOpt && typeof document.querySelectorAll === 'function') {
      const allDomOpts = Array.from(document.querySelectorAll(optionSelector));
      const hiddenMatch = findBestMatchingOption(allDomOpts);
      if (hiddenMatch.bestOpt) {
        scrollOptionIntoMenuContainer(hiddenMatch.bestOpt);
        await new Promise((r) => setTimeout(r, 50));
        if (isVisible(hiddenMatch.bestOpt)) {
          bestOpt = hiddenMatch.bestOpt;
        }
      }
    }

    // If the dropdown uses virtual scrolling or clips off-screen bottom items (such as ru, zh_CN, zh_TW),
    // scroll the menu container from top to bottom in steps to bring all options into the DOM/viewport.
    if (!bestOpt && options.length > 0) {
      const menuContainer = findScrollableMenuContainer(options[0]);
      if (menuContainer) {
        if ((menuContainer.scrollTop || 0) > 0) {
          menuContainer.scrollTop = 0;
          if (typeof menuContainer.dispatchEvent === 'function' && typeof Event === 'function') {
            try {
              menuContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 50));
          options = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
          bestOpt = findBestMatchingOption(options).bestOpt;
        }
        for (let step = 0; !bestOpt && step < 20; step++) {
          const prevScrollTop = menuContainer.scrollTop || 0;
          const stepDelta = Math.max(120, Math.floor((menuContainer.clientHeight || 240) * 0.8));
          menuContainer.scrollTop = prevScrollTop + stepDelta;
          if (typeof menuContainer.dispatchEvent === 'function' && typeof Event === 'function') {
            try {
              menuContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 60));
          options = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
          const found = findBestMatchingOption(options);
          if (found.bestOpt) {
            bestOpt = found.bestOpt;
            break;
          }
          if ((menuContainer.scrollTop || 0) <= prevScrollTop) break;
        }
      }
    }

    if (bestOpt) {
      if (typeof window !== 'undefined') {
        window.__cwsLangTrigger = trigger;
      }
      const scrolledMenu = scrollOptionIntoMenuContainer(bestOpt);
      if (scrolledMenu && isFullDom) {
        await new Promise((r) => setTimeout(r, 40));
      }
      clickElementWithMouseEvents(bestOpt);
      await new Promise((r) => setTimeout(r, 200));

      if (isFullDom) {
        const curTriggerText = normalizeText(trigger.textContent || '');
        if (!wasAlreadyOnTargetLocale && curTriggerText === prevTriggerText && matchesOption(trigger) === 0) {
          if (!isVisible(bestOpt)) {
            clickElementWithMouseEvents(trigger);
            await new Promise((r) => setTimeout(r, 150));
            const reopenedOpts = Array.from(document.querySelectorAll(optionSelector)).filter(isVisible);
            const reFound = findBestMatchingOption(reopenedOpts);
            if (reFound.bestOpt) {
              bestOpt = reFound.bestOpt;
              scrollOptionIntoMenuContainer(bestOpt);
              await new Promise((r) => setTimeout(r, 40));
            }
          }
          const primaryChild = bestOpt.querySelector?.(
            '.mdc-list-item__primary-text, .mat-option-text, .VfPpkd-StrnGf-rymPhb-b9t22c, .mdc-deprecated-list-item__text, .goog-menuitem-content, [jsname="K4r5Ff"]'
          );
          if (primaryChild && typeof primaryChild.click === 'function') {
            clickElementWithMouseEvents(primaryChild);
          } else {
            clickElementWithMouseEvents(bestOpt);
          }
          await new Promise((r) => setTimeout(r, 150));
        }

        // Wait briefly for any locale-switch network fetch and form re-render to settle before filling the form
        for (let settlePoll = 0; settlePoll < 12; settlePoll++) {
          const activeReqs =
            typeof window !== 'undefined' && typeof window.__cwsGetActiveReqCount === 'function'
              ? window.__cwsGetActiveReqCount()
              : (typeof window !== 'undefined' && typeof window.__cwsInFlightRequests === 'number'
                  ? window.__cwsInFlightRequests
                  : 0);
          const curTaVal = getPrimaryTextareaValue();
          const taStillHasPrevLocaleText =
            !wasAlreadyOnTargetLocale &&
            prevTextareaValue.length > 0 &&
            curTaVal === prevTextareaValue &&
            settlePoll < 8;
          if (activeReqs === 0 && !taStillHasPrevLocaleText) break;
          await new Promise((r) => setTimeout(r, 80));
        }
      }

      return { matched: true, type: 'listbox', label: (bestOpt.textContent || '').replace(/\s+/g, ' ').trim() };
    }

    // Close non-matching dropdown overlay before trying the next trigger
    const backdrop = document.querySelector?.('.cdk-overlay-backdrop, .mdc-menu-surface--open');
    if (backdrop && typeof backdrop.click === 'function') {
      backdrop.click();
    } else if (typeof KeyboardEvent === 'function') {
      trigger.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return { matched: false, type: null, label: null };
}

/**
 * In-page DOM helper: Fill the Detailed Description textarea in the Store Listing page.
 * Executed inside the browser page context via `session.evaluate(...)`.
 */
function domFillDetailedDescription(descriptionText) {
  function isVisible(el) {
    if (!el) return false;
    if (el.hidden === true || String(el.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') return false;
    const cls = String(el.className || el.getAttribute?.('class') || '');
    if (/\bcdk-textarea-autosize-measuring\b/i.test(cls)) return false;
    let cur = el;
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 10 && cur && cur !== bodyEl; d++) {
      if (cur.hidden === true || String(cur.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') {
        return false;
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const st = window.getComputedStyle(cur);
          if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
        } catch {}
      }
      cur = cur.parentElement;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    return true;
  }

  const textareas = Array.from(document.querySelectorAll('textarea')).filter(
    (el) => isVisible(el) && !el.disabled && !el.readOnly && !(el.maxLength > 0 && el.maxLength <= 200)
  );

  const explicitDetailedRe = /detailed\s*description|詳細な説明|商品の詳細/i;
  const generalDescRe = /description|説明|product\s*details/i;
  const summaryExclude = /short\s*description|summary|簡単な説明|概要|single\s*purpose|単一の目的|justification|申告理由/i;

  function getParentOrHost(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    if (typeof el.getRootNode === 'function') {
      const r = el.getRootNode();
      if (r && r.host) return r.host;
    }
    return null;
  }

  function getFieldContext(ta) {
    const aria = [
      ta.getAttribute?.('aria-label') || '',
      ta.getAttribute?.('placeholder') || '',
      ta.getAttribute?.('name') || '',
      ta.id || ''
    ].join(' ');

    const ancestors = [];
    if (typeof ta.closest === 'function') {
      const closestEl = ta.closest('section, div, label');
      const closestTaCount =
        closestEl && typeof closestEl.querySelectorAll === 'function'
          ? closestEl.querySelectorAll('textarea').length
          : 1;
      const closestLabel = closestTaCount <= 1 ? (closestEl?.textContent || '') : '';
      if (closestLabel && closestLabel.length <= 600) {
        ancestors.push(closestLabel.slice(0, 400));
      }
    }
    let node = getParentOrHost(ta);
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      if (typeof node.querySelectorAll === 'function' && node.querySelectorAll('textarea').length > 1) {
        break;
      }
      const ownTxt = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (ownTxt && ownTxt.length <= 600) {
        ancestors.push(ownTxt.slice(0, 400));
      }
      let sib = node.previousElementSibling;
      for (let s = 0; s < 4 && sib; s++) {
        if (typeof sib.querySelectorAll === 'function' && sib.querySelectorAll('textarea').length > 0) {
          break;
        }
        const sibTxt = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (sibTxt && sibTxt.length <= 300) {
          ancestors.push(sibTxt);
        }
        sib = sib.previousElementSibling;
      }
      node = getParentOrHost(node);
    }
    const containerText = ancestors.join(' ');
    return { aria, containerText };
  }

  let target = null;
  const nonSummaryCandidates = [];

  for (const ta of textareas) {
    const { aria, containerText } = getFieldContext(ta);
    const isDirectSummaryAria = summaryExclude.test(aria) && !explicitDetailedRe.test(aria);
    const isContainerSummary =
      summaryExclude.test(containerText) &&
      !explicitDetailedRe.test(aria) &&
      !explicitDetailedRe.test(containerText);
    const isSummary =
      isDirectSummaryAria ||
      isContainerSummary ||
      /\b132\s*(?:chars?|文字|\/\s*132)\b/i.test(containerText);
    if (isSummary) {
      continue;
    }
    nonSummaryCandidates.push({ ta, aria, containerText });
  }

  for (const item of nonSummaryCandidates) {
    if (explicitDetailedRe.test(item.aria)) {
      target = item.ta;
      break;
    }
  }

  if (!target) {
    for (const item of nonSummaryCandidates) {
      if (explicitDetailedRe.test(item.containerText)) {
        target = item.ta;
        break;
      }
    }
  }

  if (!target) {
    for (const item of nonSummaryCandidates) {
      if (generalDescRe.test(item.aria) || generalDescRe.test(item.containerText)) {
        target = item.ta;
        break;
      }
    }
  }

  if (!target && nonSummaryCandidates.length > 0) {
    // Pick the largest editable non-summary textarea (Detailed description allows up to 16,000 chars)
    target = nonSummaryCandidates.sort((a, b) => {
      const maxDiff = (b.ta.maxLength > 200 ? b.ta.maxLength : 0) - (a.ta.maxLength > 200 ? a.ta.maxLength : 0);
      if (maxDiff !== 0) return maxDiff;
      return (b.ta.rows || 5) - (a.ta.rows || 5);
    })[0].ta;
  }

  // Fallback if there is only one editable non-short textarea on the page and an outer section heading contained "概要"/"Summary"
  if (!target && textareas.length === 1) {
    const onlyTa = textareas[0];
    const { aria, containerText } = getFieldContext(onlyTa);
    if (
      !summaryExclude.test(aria) &&
      !/\b132\b/.test(containerText) &&
      (generalDescRe.test(aria) || generalDescRe.test(containerText) || !(onlyTa.maxLength > 0 && onlyTa.maxLength <= 200))
    ) {
      target = onlyTa;
    }
  }

  if (!target) {
    return { updated: false, reason: 'No editable Detailed Description <textarea> found on page.' };
  }

  try {
    target.focus?.();
  } catch {}
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype || {}, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(target, descriptionText);
  } else {
    target.value = descriptionText;
  }
  if (typeof InputEvent === 'function') {
    try {
      target.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: descriptionText
        })
      );
    } catch {
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } else {
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  target.dispatchEvent(new Event('change', { bubbles: true }));
  target.dispatchEvent(new Event('blur', { bubbles: true }));

  if (typeof window !== 'undefined') {
    window.__cwsExpectedDetailedDescription = descriptionText;
    window.__cwsLastDetailedTextarea = target;
  }

  return { updated: true, length: target.value.length };
}

/**
 * In-page DOM helper: Detect and confirm any open delete/replace confirmation dialog
 * (e.g., "画像を削除して良いですか？" / "画像を削除しますか？" / "Delete image?" / "Are you sure?").
 * Executed inside the browser page context via `session.evaluate(...)`.
 */
function domConfirmDeleteDialog(excludedButtons = null) {
  if (typeof window !== 'undefined') {
    try {
      window.confirm = () => true;
      window.alert = () => {};
    } catch {}
  }
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
    return { clicked: false, dialog: null, button: null, label: null };
  }

  const confirmQuestionPromptRe =
    /削除して(?:も)?(?:よろしい|良い|よい|いい)ですか|削除しますか|削除します。|消去して(?:も)?(?:よろしい|良い|よい|いい)ですか|消去しますか|本当に削除|削除の確認|置き換えて(?:も)?(?:よろしい|良い|よい|いい)ですか|置き換えますか|置換しますか|(?:画像|スクリーンショット|タイル|バナー|アイテム|ファイル)を削除.*(?:ですか|ますか|\?|？|確認)|(?:delete|remove|replace)\s*(?:this\s*)?(?:image|screenshot|tile|banner|item|asset|file|photo|media).*\?|are\s*you\s*sure.*(?:delete|remove|replace)|do\s*you\s*want\s*to\s*(?:delete|remove|replace)|confirm\s*(?:delete|deletion|removal|replace)|want\s*to\s*(?:delete|remove)/i;
  const confirmTopicRe =
    /画像を削除|画像を消去|スクリーンショットを削除|タイルを削除|バナーを削除|アイテムを削除|(?:delete|remove)\s*(?:this\s*)?(?:image|screenshot|tile|banner|item|asset|file|photo|media)/i;
  const genericQuestionRe =
    /よろしいですか|良いですか|よいですか|いいですか|しますか|確認|本当に|are\s*you\s*sure|confirm\b|\?|？/i;
  const cancelActionRe = /^(cancel|close|dismiss|no|secondaryaction|reject|false)$/i;
  const cancelLabelRe =
    /^(cancel|キャンセル|いいえ|no|中止|やめる|戻る|閉じる|close|dismiss|back|never\s*mind|×|✕|✖|clear)$/i;
  const cancelAriaPhraseRe =
    /^(?:close|dismiss|cancel)\b|(?:dialog|modal)\s*を?\s*閉じる|ダイアログを閉じる|モーダルを閉じる|キャンセルする/i;
  const confirmActionRe = /^(accept|confirm|ok|yes|delete|remove|primaryaction|true|submit)$/i;
  const exactConfirmLabelRe =
    /^(削除|削除する|画像を削除|画像を削除する|スクリーンショットを削除|はい|ok|ｏｋ|確認|実行|続行|了解|同意する|delete|delete\s*image|delete\s*screenshot|remove|remove\s*image|remove\s*screenshot|confirm|yes|accept|continue|replace|置換|置き換え)$/i;
  const partialConfirmLabelRe = /削除|消去|はい|確認|delete|remove|confirm|accept|\bok\b/i;

  const excludedSet =
    excludedButtons instanceof Set
      ? excludedButtons
      : new Set(Array.isArray(excludedButtons) ? excludedButtons : []);

  function getParentOrHost(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    if (typeof el.getRootNode === 'function') {
      const r = el.getRootNode();
      if (r && r.host) return r.host;
    }
    return null;
  }

  function containsDeep(parent, child) {
    if (!parent || !child) return false;
    if (parent === child) return true;
    if (typeof parent.contains === 'function' && parent.contains(child)) return true;
    let cur = getParentOrHost(child);
    for (let d = 0; d < 20 && cur; d++) {
      if (cur === parent) return true;
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function queryAllDeep(root, selector) {
    if (!root) return [];
    let found = [];
    if (typeof root.querySelectorAll === 'function') {
      try {
        found = Array.from(root.querySelectorAll(selector));
      } catch {
        found = [];
      }
    }
    if (root.shadowRoot) {
      found.push(...queryAllDeep(root.shadowRoot, selector));
    }
    let allNodes = [];
    if (typeof root.querySelectorAll === 'function') {
      try {
        allNodes = Array.from(root.querySelectorAll('*'));
      } catch {
        allNodes = [];
      }
    }
    for (const node of allNodes) {
      if (node && node.shadowRoot) {
        found.push(...queryAllDeep(node.shadowRoot, selector));
      }
    }
    return found;
  }

  function getDeepText(el) {
    if (!el) return '';
    const parts = [String(el.textContent || '')];
    if (el.shadowRoot) {
      parts.push(getDeepText(el.shadowRoot));
    }
    if (typeof el.querySelectorAll === 'function') {
      try {
        for (const node of Array.from(el.querySelectorAll('*'))) {
          if (node && node.shadowRoot) {
            parts.push(getDeepText(node.shadowRoot));
          }
        }
      } catch {}
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isControlVisible(el, checkOpacity = true) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean' && !el.isConnected) return false;
    let cur = el;
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 15 && cur && cur !== bodyEl; d++) {
      if (cur.hidden === true || String(cur.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') {
        return false;
      }
      if (cur.style) {
        if (
          cur.style.display === 'none' ||
          cur.style.visibility === 'hidden' ||
          (checkOpacity && cur.style.opacity === '0')
        ) {
          return false;
        }
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const st = window.getComputedStyle(cur);
          if (
            st &&
            (st.display === 'none' || st.visibility === 'hidden' || (checkOpacity && st.opacity === '0'))
          ) {
            return false;
          }
        } catch {}
      }
      cur = getParentOrHost(cur);
    }
    if (typeof el.getBoundingClientRect === 'function') {
      try {
        const rect = el.getBoundingClientRect();
        if (rect && (rect.width <= 0 || rect.height <= 0)) {
          const descEls = queryAllDeep(el, '*');
          const hasVisibleDescendant = descEls.some((child) => {
            if (!child || typeof child.getBoundingClientRect !== 'function') return false;
            try {
              const cr = child.getBoundingClientRect();
              return Boolean(cr && cr.width > 0 && cr.height > 0);
            } catch {
              return false;
            }
          });
          if (!hasVisibleDescendant) return false;
        }
      } catch {}
    }
    return true;
  }

  function isExplicitDialogElement(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    const role = String(el.getAttribute?.('role') || el.role || '').toLowerCase();
    if (role === 'dialog' || role === 'alertdialog') return true;
    if (String(el.getAttribute?.('aria-modal') || '').toLowerCase() === 'true') return true;
    const tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (
      tag === 'dialog' ||
      tag === 'mat-dialog-container' ||
      tag === 'mwc-dialog' ||
      tag === 'md-dialog' ||
      tag === 'material-dialog' ||
      tag === 'modal'
    ) {
      if (tag === 'dialog' && el.open === false && el.getAttribute?.('open') === null) {
        return false;
      }
      return true;
    }
    const cls = String(el.className || el.getAttribute?.('class') || '');
    if (
      /\b(mdc-dialog|mat-dialog-container|mat-mdc-dialog-container|goog-modalpopup|VfPpkd-sx9Kwc|VfPpkd-P5QLlc)\b/i.test(
        cls
      )
    ) {
      return true;
    }
    return false;
  }

  function isFileOrTextareaControl(el) {
    if (!el) return false;
    const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
    const tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (type === 'file' || tag === 'textarea') {
      return true;
    }
    if (tag === 'input' || tag === 'button') {
      return false;
    }
    if (typeof el.multiple === 'boolean' || typeof el.rows === 'number') {
      return true;
    }
    if (!el.textContent && typeof el.click !== 'function') {
      return true;
    }
    return false;
  }

  function hasFormControls(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    try {
      const inputs = Array.from(el.querySelectorAll('input[type="file"]')).filter(isFileOrTextareaControl);
      return inputs.length > 0;
    } catch {
      return false;
    }
  }

  const dialogSelector =
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog, mat-dialog-container, mwc-dialog, md-dialog, ' +
    'material-dialog, modal, .mdc-dialog, .mat-dialog-container, .mat-mdc-dialog-container, .goog-modalpopup, ' +
    '.VfPpkd-sx9Kwc, .VfPpkd-P5QLlc, .cdk-overlay-pane';
  const rawCandidates = new Set([
    ...queryAllDeep(document, dialogSelector),
    ...Array.from(document.querySelectorAll('section, [role="region"], div'))
  ]);

  const dialogCandidates = [];
  for (const el of rawCandidates) {
    if (!el || typeof el.querySelectorAll !== 'function') continue;
    const isExplicit = isExplicitDialogElement(el);
    if (!isExplicit && !el.shadowRoot) {
      const fastTxt = String(el.textContent || '');
      if (fastTxt.length > 800 || !confirmQuestionPromptRe.test(fastTxt)) continue;
    }
    const txt = getDeepText(el);
    const matchesQuestionPrompt = Boolean(txt && confirmQuestionPromptRe.test(txt));
    const matchesPrompt = matchesQuestionPrompt || (isExplicit && Boolean(txt && confirmTopicRe.test(txt)));
    if (!isExplicit && (!matchesQuestionPrompt || txt.length > 800)) continue;
    if (!isControlVisible(el, true)) continue;
    if (!isExplicit && hasFormControls(el)) continue;
    const priority = (isExplicit ? 2 : 0) + (matchesPrompt ? 3 : 0);
    dialogCandidates.push({ el, isExplicit, matchesPrompt, txt, priority, len: txt.length || 9999 });
  }

  dialogCandidates.sort((a, b) => b.priority - a.priority || a.len - b.len);

  const btnSelector =
    'button, [role="button"], input[type="button"], input[type="submit"], material-button, ' +
    'md-filled-button, md-text-button, md-tonal-button, md-outlined-button, md-elevated-button, mwc-button, ' +
    '[data-mdc-dialog-action], [mat-dialog-close]';

  for (const cand of dialogCandidates) {
    const rawBtns = queryAllDeep(cand.el, btnSelector).filter((btn) => {
      if (!btn || typeof btn.click !== 'function') return false;
      if (isFileOrTextareaControl(btn)) return false;
      if (btn.disabled || String(btn.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true') return false;
      return isControlVisible(btn, true);
    });
    if (rawBtns.length === 0) continue;

    const leafBtns = rawBtns.filter(
      (btn) => !rawBtns.some((other) => other !== btn && containsDeep(btn, other))
    );
    const buttons = leafBtns.length > 0 ? leafBtns : rawBtns;

    function getButtonMeta(btn) {
      const rootNode = typeof btn.getRootNode === 'function' ? btn.getRootNode() : null;
      const host = rootNode && rootNode.host ? rootNode.host : null;
      const actionAttr = String(
        btn.getAttribute?.('data-mdc-dialog-action') ||
        btn.getAttribute?.('data-action') ||
        btn.getAttribute?.('data-id') ||
        btn.getAttribute?.('slot') ||
        btn.name ||
        host?.getAttribute?.('data-mdc-dialog-action') ||
        host?.getAttribute?.('data-action') ||
        host?.getAttribute?.('slot') ||
        ''
      )
        .trim()
        .toLowerCase();
      const labelChild =
        typeof btn.querySelector === 'function'
          ? btn.querySelector('.mdc-button__label, .VfPpkd-vQzf8d, .mat-button-wrapper, .content')
          : null;
      const labelChildText = String(labelChild?.textContent || '').replace(/\s+/g, ' ').trim();
      const fallbackText = String(btn.textContent || btn.value || host?.textContent || getDeepText(btn) || '')
        .replace(/\s+/g, ' ')
        .trim();
      const rawLabel = labelChildText || fallbackText;
      const cleanedLabel = rawLabel
        .replace(/^(?:delete_outline|delete_forever|delete|check_circle|check|done|warning|info|help_outline|close|clear)\s+/i, '')
        .replace(/\s+(?:delete_outline|delete_forever|delete|check_circle|check|done|warning|info|help_outline|close|clear)$/i, '')
        .trim();
      const ariaParts = [
        btn.getAttribute?.('aria-label') || '',
        btn.getAttribute?.('title') || '',
        host?.getAttribute?.('aria-label') || '',
        host?.getAttribute?.('title') || ''
      ]
        .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const uniqueAriaParts = [...new Set(ariaParts)];
      const ariaLabel = uniqueAriaParts[0] || '';
      const matClose = btn.getAttribute?.('mat-dialog-close');
      const isCancel =
        cancelActionRe.test(actionAttr) ||
        cancelLabelRe.test(cleanedLabel) ||
        cancelLabelRe.test(rawLabel) ||
        uniqueAriaParts.some(
          (a) => (!cleanedLabel && cancelLabelRe.test(a)) || cancelAriaPhraseRe.test(a)
        ) ||
        matClose === 'false';
      return { actionAttr, rawLabel, cleanedLabel, ariaLabel, uniqueAriaParts, isCancel };
    }

    const metas = buttons.map((btn) => ({ btn, ...getButtonMeta(btn) }));
    const hasExplicitCancel = metas.some((m) => m.isCancel);

    let bestBtn = null;
    let bestLabel = null;
    let bestScore = 0;

    for (const m of metas) {
      if (excludedSet.has(m.btn) || m.isCancel) continue;
      let score = 0;
      if (confirmActionRe.test(m.actionAttr)) {
        score = 4;
      } else if (
        exactConfirmLabelRe.test(m.cleanedLabel) ||
        exactConfirmLabelRe.test(m.rawLabel) ||
        m.uniqueAriaParts.some((a) => exactConfirmLabelRe.test(a))
      ) {
        score = 3;
      } else if (
        partialConfirmLabelRe.test(m.cleanedLabel) ||
        m.uniqueAriaParts.some((a) => partialConfirmLabelRe.test(a))
      ) {
        score = 2;
      } else if (hasExplicitCancel && cand.matchesPrompt) {
        score = 1;
      }

      if (score > 0) {
        const cls = String(m.btn.className || m.btn.getAttribute?.('class') || '');
        if (
          /\b(mdc-dialog__button--default|goog-buttonset-default|mat-flat-button|mat-raised-button|mdc-button--raised|mdc-button--unelevated|primary|btn-yes)\b/i.test(
            cls
          ) ||
          m.btn.hasAttribute?.('autofocus') ||
          m.btn.getAttribute?.('color') === 'primary' ||
          m.btn.getAttribute?.('color') === 'warn'
        ) {
          score += 0.5;
        }
        if (score >= bestScore) {
          bestScore = score;
          bestBtn = m.btn;
          bestLabel = m.cleanedLabel || m.rawLabel || m.ariaLabel || m.actionAttr || 'confirm';
        }
      }
    }

    const isSafeConfirmationDialog =
      cand.matchesPrompt ||
      (cand.isExplicit && bestScore >= 3 && (hasExplicitCancel || genericQuestionRe.test(cand.txt)));

    if (bestBtn && isSafeConfirmationDialog) {
      try {
        bestBtn.focus?.();
      } catch {}
      if (typeof bestBtn.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
        try {
          bestBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          bestBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        } catch {}
      }
      bestBtn.click();
      return { clicked: true, dialog: cand.el, button: bestBtn, label: bestLabel };
    }
  }

  return { clicked: false, dialog: null, button: null, label: null };
}

/**
 * In-page DOM helper: Remove existing uploaded screenshots in the Localized Screenshots section
 * for the active locale before uploading new ones, automatically confirming any deletion confirmation dialogs.
 */
async function domClearExistingScreenshots() {
  if (typeof window !== 'undefined') {
    try {
      window.confirm = () => true;
      window.alert = () => {};
    } catch {}
  }

  const localizedScreenshotRe =
    /localized\s*screenshots?|language-specific\s*screenshots?|ローカライズ(?:版|された)?\s*スクリーンショット|言語別のスクリーンショット|この言語のスクリーンショット/i;
  const globalScreenshotRe =
    /global\s*screenshots?|default\s*screenshots?|グローバル(?:版|な)?\s*スクリーンショット|すべての言語共通のスクリーンショット|共通のスクリーンショット/i;
  const screenshotHeadingRe = /screenshots?|スクリーンショット|1280\s*[x×]\s*800|640\s*[x×]\s*400/i;
  const promoExcludeRe =
    /promo\s*tile|プロモーション\s*タイル|440\s*[x×]\s*280|marquee|マーキー|1400\s*[x×]\s*560|store\s*icon|ストア\s*アイコン|128\s*[x×]\s*128/i;

  const confirmQuestionPromptRe =
    /削除して(?:も)?(?:よろしい|良い|よい|いい)ですか|削除しますか|削除します。|消去して(?:も)?(?:よろしい|良い|よい|いい)ですか|消去しますか|本当に削除|削除の確認|置き換えて(?:も)?(?:よろしい|良い|よい|いい)ですか|置き換えますか|置換しますか|(?:画像|スクリーンショット|タイル|バナー|アイテム|ファイル)を削除.*(?:ですか|ますか|\?|？|確認)|(?:delete|remove|replace)\s*(?:this\s*)?(?:image|screenshot|tile|banner|item|asset|file|photo|media).*\?|are\s*you\s*sure.*(?:delete|remove|replace)|do\s*you\s*want\s*to\s*(?:delete|remove|replace)|confirm\s*(?:delete|deletion|removal|replace)|want\s*to\s*(?:delete|remove)/i;
  const confirmTopicRe =
    /画像を削除|画像を消去|スクリーンショットを削除|タイルを削除|バナーを削除|アイテムを削除|(?:delete|remove)\s*(?:this\s*)?(?:image|screenshot|tile|banner|item|asset|file|photo|media)/i;
  const genericQuestionRe =
    /よろしいですか|良いですか|よいですか|いいですか|しますか|確認|本当に|are\s*you\s*sure|confirm\b|\?|？/i;
  const cancelActionRe = /^(cancel|close|dismiss|no|secondaryaction|reject|false)$/i;
  const cancelLabelRe =
    /^(cancel|キャンセル|いいえ|no|中止|やめる|戻る|閉じる|close|dismiss|back|never\s*mind|×|✕|✖|clear)$/i;
  const cancelAriaPhraseRe =
    /^(?:close|dismiss|cancel)\b|(?:dialog|modal)\s*を?\s*閉じる|ダイアログを閉じる|モーダルを閉じる|キャンセルする/i;
  const confirmActionRe = /^(accept|confirm|ok|yes|delete|remove|primaryaction|true|submit)$/i;
  const exactConfirmLabelRe =
    /^(削除|削除する|画像を削除|画像を削除する|スクリーンショットを削除|はい|ok|ｏｋ|確認|実行|続行|了解|同意する|delete|delete\s*image|delete\s*screenshot|remove|remove\s*image|remove\s*screenshot|confirm|yes|accept|continue|replace|置換|置き換え)$/i;
  const partialConfirmLabelRe = /削除|消去|はい|確認|delete|remove|confirm|accept|\bok\b/i;

  function getParentOrHost(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    if (typeof el.getRootNode === 'function') {
      const r = el.getRootNode();
      if (r && r.host) return r.host;
    }
    return null;
  }

  function containsDeep(parent, child) {
    if (!parent || !child) return false;
    if (parent === child) return true;
    if (typeof parent.contains === 'function' && parent.contains(child)) return true;
    let cur = getParentOrHost(child);
    for (let d = 0; d < 20 && cur; d++) {
      if (cur === parent) return true;
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function queryAllDeep(root, selector) {
    if (!root) return [];
    let found = [];
    if (typeof root.querySelectorAll === 'function') {
      try {
        found = Array.from(root.querySelectorAll(selector));
      } catch {
        found = [];
      }
    }
    if (root.shadowRoot) {
      found.push(...queryAllDeep(root.shadowRoot, selector));
    }
    let allNodes = [];
    if (typeof root.querySelectorAll === 'function') {
      try {
        allNodes = Array.from(root.querySelectorAll('*'));
      } catch {
        allNodes = [];
      }
    }
    for (const node of allNodes) {
      if (node && node.shadowRoot) {
        found.push(...queryAllDeep(node.shadowRoot, selector));
      }
    }
    return found;
  }

  function getDeepText(el) {
    if (!el) return '';
    const parts = [String(el.textContent || '')];
    if (el.shadowRoot) {
      parts.push(getDeepText(el.shadowRoot));
    }
    if (typeof el.querySelectorAll === 'function') {
      try {
        for (const node of Array.from(el.querySelectorAll('*'))) {
          if (node && node.shadowRoot) {
            parts.push(getDeepText(node.shadowRoot));
          }
        }
      } catch {}
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function isControlVisible(el, checkOpacity = false) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean' && !el.isConnected) return false;
    let cur = el;
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 15 && cur && cur !== bodyEl; d++) {
      if (cur.hidden === true || String(cur.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') {
        return false;
      }
      if (cur.style) {
        if (
          cur.style.display === 'none' ||
          cur.style.visibility === 'hidden' ||
          (checkOpacity && cur.style.opacity === '0')
        ) {
          return false;
        }
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const st = window.getComputedStyle(cur);
          if (
            st &&
            (st.display === 'none' || st.visibility === 'hidden' || (checkOpacity && st.opacity === '0'))
          ) {
            return false;
          }
        } catch {}
      }
      cur = getParentOrHost(cur);
    }
    if (typeof el.getBoundingClientRect === 'function') {
      try {
        const rect = el.getBoundingClientRect();
        if (rect && (rect.width <= 0 || rect.height <= 0)) {
          const descEls = queryAllDeep(el, '*');
          const hasVisibleDescendant = descEls.some((child) => {
            if (!child || typeof child.getBoundingClientRect !== 'function') return false;
            try {
              const cr = child.getBoundingClientRect();
              return Boolean(cr && cr.width > 0 && cr.height > 0);
            } catch {
              return false;
            }
          });
          if (!hasVisibleDescendant) return false;
        }
      } catch {}
    }
    return true;
  }

  function isExplicitDialogElement(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    const role = String(el.getAttribute?.('role') || el.role || '').toLowerCase();
    if (role === 'dialog' || role === 'alertdialog') return true;
    if (String(el.getAttribute?.('aria-modal') || '').toLowerCase() === 'true') return true;
    const tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (
      tag === 'dialog' ||
      tag === 'mat-dialog-container' ||
      tag === 'mwc-dialog' ||
      tag === 'md-dialog' ||
      tag === 'material-dialog' ||
      tag === 'modal'
    ) {
      if (tag === 'dialog' && el.open === false && el.getAttribute?.('open') === null) {
        return false;
      }
      return true;
    }
    const cls = String(el.className || el.getAttribute?.('class') || '');
    if (
      /\b(mdc-dialog|mat-dialog-container|mat-mdc-dialog-container|goog-modalpopup|VfPpkd-sx9Kwc|VfPpkd-P5QLlc)\b/i.test(
        cls
      )
    ) {
      return true;
    }
    return false;
  }

  function isInsideDialog(el) {
    let cur = getParentOrHost(el);
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 15 && cur && cur !== bodyEl; d++) {
      if (isExplicitDialogElement(cur)) return true;
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function isDialogAlreadyConfirmed(el, confirmedDialogs) {
    if (!el || !confirmedDialogs || confirmedDialogs.size === 0) return false;
    for (const confirmed of confirmedDialogs) {
      if (containsDeep(confirmed, el) || containsDeep(el, confirmed)) {
        return true;
      }
    }
    return false;
  }

  function isFileOrTextareaControl(el) {
    if (!el) return false;
    const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
    const tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (type === 'file' || tag === 'textarea') {
      return true;
    }
    if (tag === 'input' || tag === 'button') {
      return false;
    }
    if (typeof el.multiple === 'boolean' || typeof el.rows === 'number') {
      return true;
    }
    if (!el.textContent && typeof el.click !== 'function') {
      return true;
    }
    return false;
  }

  function hasFormControls(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    try {
      const inputs = Array.from(el.querySelectorAll('input[type="file"]')).filter(isFileOrTextareaControl);
      return inputs.length > 0;
    } catch {
      return false;
    }
  }

  function findAndClickConfirmDialogButton(excludedBtns, confirmedDialogs) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return { clicked: false, dialog: null, button: null, label: null };
    }
    const dialogSelector =
      '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog, mat-dialog-container, mwc-dialog, md-dialog, ' +
      'material-dialog, modal, .mdc-dialog, .mat-dialog-container, .mat-mdc-dialog-container, .goog-modalpopup, ' +
      '.VfPpkd-sx9Kwc, .VfPpkd-P5QLlc, .cdk-overlay-pane';
    const rawCandidates = new Set([
      ...queryAllDeep(document, dialogSelector),
      ...Array.from(document.querySelectorAll('section, [role="region"], div'))
    ]);

    const dialogCandidates = [];
    for (const el of rawCandidates) {
      if (!el || typeof el.querySelectorAll !== 'function') continue;
      if (isDialogAlreadyConfirmed(el, confirmedDialogs)) continue;
      const isExplicit = isExplicitDialogElement(el);
      if (!isExplicit && !el.shadowRoot) {
        const fastTxt = String(el.textContent || '');
        if (fastTxt.length > 800 || !confirmQuestionPromptRe.test(fastTxt)) continue;
      }
      const txt = getDeepText(el);
      const matchesQuestionPrompt = Boolean(txt && confirmQuestionPromptRe.test(txt));
      const matchesPrompt = matchesQuestionPrompt || (isExplicit && Boolean(txt && confirmTopicRe.test(txt)));
      if (!isExplicit && (!matchesQuestionPrompt || txt.length > 800)) continue;
      if (!isControlVisible(el, true)) continue;
      if (!isExplicit && hasFormControls(el)) continue;
      const priority = (isExplicit ? 2 : 0) + (matchesPrompt ? 3 : 0);
      dialogCandidates.push({ el, isExplicit, matchesPrompt, txt, priority, len: txt.length || 9999 });
    }

    dialogCandidates.sort((a, b) => b.priority - a.priority || a.len - b.len);

    const btnSelector =
      'button, [role="button"], input[type="button"], input[type="submit"], material-button, ' +
      'md-filled-button, md-text-button, md-tonal-button, md-outlined-button, md-elevated-button, mwc-button, ' +
      '[data-mdc-dialog-action], [mat-dialog-close]';

    for (const cand of dialogCandidates) {
      const rawBtns = queryAllDeep(cand.el, btnSelector).filter((btn) => {
        if (!btn || typeof btn.click !== 'function') return false;
        if (isFileOrTextareaControl(btn)) return false;
        if (btn.disabled || String(btn.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true') return false;
        return isControlVisible(btn, true);
      });
      if (rawBtns.length === 0) continue;

      const leafBtns = rawBtns.filter(
        (btn) => !rawBtns.some((other) => other !== btn && containsDeep(btn, other))
      );
      const buttons = leafBtns.length > 0 ? leafBtns : rawBtns;

      function getButtonMeta(btn) {
        const rootNode = typeof btn.getRootNode === 'function' ? btn.getRootNode() : null;
        const host = rootNode && rootNode.host ? rootNode.host : null;
        const actionAttr = String(
          btn.getAttribute?.('data-mdc-dialog-action') ||
          btn.getAttribute?.('data-action') ||
          btn.getAttribute?.('data-id') ||
          btn.getAttribute?.('slot') ||
          btn.name ||
          host?.getAttribute?.('data-mdc-dialog-action') ||
          host?.getAttribute?.('data-action') ||
          host?.getAttribute?.('slot') ||
          ''
        )
          .trim()
          .toLowerCase();
        const labelChild =
          typeof btn.querySelector === 'function'
            ? btn.querySelector('.mdc-button__label, .VfPpkd-vQzf8d, .mat-button-wrapper, .content')
            : null;
        const labelChildText = String(labelChild?.textContent || '').replace(/\s+/g, ' ').trim();
        const fallbackText = String(btn.textContent || btn.value || host?.textContent || getDeepText(btn) || '')
          .replace(/\s+/g, ' ')
          .trim();
        const rawLabel = labelChildText || fallbackText;
        const cleanedLabel = rawLabel
          .replace(/^(?:delete_outline|delete_forever|delete|check_circle|check|done|warning|info|help_outline|close|clear)\s+/i, '')
          .replace(/\s+(?:delete_outline|delete_forever|delete|check_circle|check|done|warning|info|help_outline|close|clear)$/i, '')
          .trim();
        const ariaParts = [
          btn.getAttribute?.('aria-label') || '',
          btn.getAttribute?.('title') || '',
          host?.getAttribute?.('aria-label') || '',
          host?.getAttribute?.('title') || ''
        ]
          .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const uniqueAriaParts = [...new Set(ariaParts)];
        const ariaLabel = uniqueAriaParts[0] || '';
        const matClose = btn.getAttribute?.('mat-dialog-close');
        const isCancel =
          cancelActionRe.test(actionAttr) ||
          cancelLabelRe.test(cleanedLabel) ||
          cancelLabelRe.test(rawLabel) ||
          uniqueAriaParts.some(
            (a) => (!cleanedLabel && cancelLabelRe.test(a)) || cancelAriaPhraseRe.test(a)
          ) ||
          matClose === 'false';
        return { actionAttr, rawLabel, cleanedLabel, ariaLabel, uniqueAriaParts, isCancel };
      }

      const metas = buttons.map((btn) => ({ btn, ...getButtonMeta(btn) }));
      const hasExplicitCancel = metas.some((m) => m.isCancel);

      let bestBtn = null;
      let bestLabel = null;
      let bestScore = 0;

      for (const m of metas) {
        if ((excludedBtns && excludedBtns.has(m.btn)) || m.isCancel) continue;
        let score = 0;
        if (confirmActionRe.test(m.actionAttr)) {
          score = 4;
        } else if (
          exactConfirmLabelRe.test(m.cleanedLabel) ||
          exactConfirmLabelRe.test(m.rawLabel) ||
          m.uniqueAriaParts.some((a) => exactConfirmLabelRe.test(a))
        ) {
          score = 3;
        } else if (
          partialConfirmLabelRe.test(m.cleanedLabel) ||
          m.uniqueAriaParts.some((a) => partialConfirmLabelRe.test(a))
        ) {
          score = 2;
        } else if (hasExplicitCancel && cand.matchesPrompt) {
          score = 1;
        }

        if (score > 0) {
          const cls = String(m.btn.className || m.btn.getAttribute?.('class') || '');
          if (
            /\b(mdc-dialog__button--default|goog-buttonset-default|mat-flat-button|mat-raised-button|mdc-button--raised|mdc-button--unelevated|primary|btn-yes)\b/i.test(
              cls
            ) ||
            m.btn.hasAttribute?.('autofocus') ||
            m.btn.getAttribute?.('color') === 'primary' ||
            m.btn.getAttribute?.('color') === 'warn'
          ) {
            score += 0.5;
          }
          if (score >= bestScore) {
            bestScore = score;
            bestBtn = m.btn;
            bestLabel = m.cleanedLabel || m.rawLabel || m.ariaLabel || m.actionAttr || 'confirm';
          }
        }
      }

      const isSafeConfirmationDialog =
        cand.matchesPrompt ||
        (cand.isExplicit && bestScore >= 3 && (hasExplicitCancel || genericQuestionRe.test(cand.txt)));

      if (bestBtn && isSafeConfirmationDialog) {
        if (confirmedDialogs) confirmedDialogs.add(cand.el);
        if (excludedBtns) excludedBtns.add(bestBtn);
        try {
          bestBtn.focus?.();
        } catch {}
        if (typeof bestBtn.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
          try {
            bestBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            bestBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          } catch {}
        }
        bestBtn.click();
        return { clicked: true, dialog: cand.el, button: bestBtn, label: bestLabel };
      }
    }

    return { clicked: false, dialog: null, button: null, label: null };
  }

  function classifyScreenshotSectionText(txt) {
    const norm = String(txt || '').replace(/\s+/g, ' ').trim();
    if (!norm) return 'none';
    const locIdx = norm.search(localizedScreenshotRe);
    const globIdx = norm.search(globalScreenshotRe);
    if (locIdx !== -1 && (globIdx === -1 || locIdx < globIdx)) {
      return 'localized';
    }
    if (globIdx !== -1 && (locIdx === -1 || globIdx < locIdx)) {
      return 'global';
    }
    if (screenshotHeadingRe.test(norm)) {
      return 'generic';
    }
    return 'none';
  }

  function getDeleteButtonsInContainer(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const filterValidBtn = (btn) => {
      if (!btn || typeof btn.click !== 'function') return false;
      if (isFileOrTextareaControl(btn)) return false;
      if (btn.disabled || String(btn.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true') return false;
      if (isInsideDialog(btn)) return false;
      return isControlVisible(btn, false);
    };
    const explicitBtns = queryAllDeep(
      root,
      'button[aria-label*="Delete" i], button[aria-label*="Remove" i], button[aria-label*="削除"], ' +
      '[role="button"][aria-label*="Delete" i], [role="button"][aria-label*="Remove" i], [role="button"][aria-label*="削除"], ' +
      'button[title*="Delete" i], button[title*="Remove" i], button[title*="削除"], [data-action="delete-screenshot"]'
    ).filter(filterValidBtn);
    const matched =
      explicitBtns.length > 0
        ? explicitBtns
        : queryAllDeep(root, 'button, [role="button"], material-button').filter((btn) => {
            if (!filterValidBtn(btn)) return false;
            const iconTxt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return (
              iconTxt === 'delete' ||
              iconTxt === 'delete_outline' ||
              iconTxt === 'delete_forever' ||
              iconTxt === '削除' ||
              iconTxt === '画像を削除'
            );
          });
    const leafBtns = matched.filter(
      (btn) => !matched.some((other) => other !== btn && containsDeep(btn, other))
    );
    return leafBtns.length > 0 ? leafBtns : matched;
  }

  function isInsideButtonControl(el, stopAt) {
    let cur = getParentOrHost(el);
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 10 && cur && cur !== stopAt && cur !== bodyEl; d++) {
      const tag = String(cur.tagName || cur.nodeName || '').toLowerCase();
      if (tag === 'button' || tag === 'material-button' || tag === 'mwc-button' || tag === 'md-icon-button') {
        return true;
      }
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function getContainerMediaSnapshot(root) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return { imgCount: 0, sig: '' };
    }
    let mediaEls = [];
    try {
      const rawMedia = queryAllDeep(root, 'img, [style*="background-image"]').filter((el) => {
        if (!el) return false;
        const tag = String(el.tagName || el.nodeName || '').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        if (tag === 'button' || tag === 'input' || role === 'button') return false;
        if (!tag && typeof el.click === 'function') return false;
        if (isInsideDialog(el) || isInsideButtonControl(el, root)) return false;
        if (!isControlVisible(el, false)) return false;
        if (typeof el.getBoundingClientRect === 'function') {
          try {
            const r = el.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0 && r.width <= 32 && r.height <= 32) {
              return false;
            }
          } catch {}
        }
        const src = String(
          el.getAttribute?.('src') || el.src || el.currentSrc || el.getAttribute?.('srcset') || ''
        ).trim();
        const style = String(el.getAttribute?.('style') || el.style?.backgroundImage || '').trim();
        const hasBgUrl =
          /url\s*\(\s*['"]?\s*(?!['"]?\s*\))[^)'"]+['"]?\s*\)/i.test(style) ||
          (/background-image\s*:/i.test(style) &&
            !/background-image\s*:\s*(?:none|initial|inherit|unset)\b/i.test(style) &&
            !/url\s*\(\s*['"]?\s*['"]?\s*\)/i.test(style));
        const hasValidMedia = tag === 'img' ? Boolean(src) || hasBgUrl : hasBgUrl || Boolean(src);
        if (!hasValidMedia) return false;
        const combined = `${src} ${style}`.trim();
        return Boolean(combined) && !/upload_illustration|empty_state|placeholder_icon/i.test(combined);
      });
      mediaEls = rawMedia.filter(
        (el) => !rawMedia.some((other) => other !== el && containsDeep(el, other))
      );
    } catch {
      mediaEls = [];
    }
    const sig = mediaEls
      .map((el) => el.getAttribute?.('src') || el.src || el.getAttribute?.('style') || '')
      .filter(Boolean)
      .join('|');
    return { imgCount: mediaEls.length, sig };
  }

  function getPrecedingHeadingText(sec) {
    let sib = sec ? sec.previousElementSibling : null;
    const parts = [];
    for (let s = 0; s < 4 && sib; s++) {
      if (typeof sib.querySelectorAll === 'function') {
        const sibInputs = Array.from(sib.querySelectorAll('input[type="file"]')).filter(isFileOrTextareaControl);
        if (sibInputs.length > 0) break;
      }
      const st = String(sib.textContent || '').replace(/\s+/g, ' ').trim();
      if (st && st.length <= 400) {
        parts.unshift(st);
        if (classifyScreenshotSectionText(st) !== 'none' || promoExcludeRe.test(st)) {
          break;
        }
      }
      sib = sib.previousElementSibling;
    }
    return parts.join(' ');
  }

  function findTargetScreenshotContainer() {
    const sections = Array.from(document.querySelectorAll('section, [role="region"], div'));
    const matchingContainers = [];
    for (const sec of sections) {
      if (!sec) continue;
      const rawTxt = String(sec.textContent || '');
      if (rawTxt.length > 2500) continue;
      if (isExplicitDialogElement(sec) || isInsideDialog(sec)) continue;
      const txt = rawTxt.replace(/\s+/g, ' ').trim();
      if (promoExcludeRe.test(txt)) {
        continue;
      }

      let hasValidControls = true;
      let hasFileInput = 0;
      let delCount = 0;
      if (typeof sec.querySelectorAll === 'function') {
        const fileInputs = Array.from(sec.querySelectorAll('input[type="file"]')).filter(isFileOrTextareaControl);
        if (fileInputs.length > 1) {
          continue;
        }
        hasFileInput = fileInputs.length > 0 ? 1 : 0;
        const delBtns = getDeleteButtonsInContainer(sec);
        delCount = delBtns.length;
        hasValidControls = hasFileInput > 0 || delCount > 0;
      }
      if (!hasValidControls) {
        continue;
      }

      let effectiveTxt = txt;
      let kind = classifyScreenshotSectionText(effectiveTxt);
      if (kind === 'none') {
        const sibHeading = getPrecedingHeadingText(sec);
        if (sibHeading) {
          effectiveTxt = `${sibHeading} ${txt}`.trim();
          if (promoExcludeRe.test(effectiveTxt)) continue;
          kind = classifyScreenshotSectionText(effectiveTxt);
        }
      }
      if (kind === 'none' || kind === 'global') {
        continue;
      }
      const priority = kind === 'localized' ? 2 : 1;
      matchingContainers.push({ sec, priority, delCount, hasFileInput, len: effectiveTxt.length || 1 });
    }

    // Prioritize explicit Localized Screenshots containers and containers holding the most delete buttons, then most specific
    matchingContainers.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.delCount - a.delCount ||
        b.hasFileInput - a.hasFileInput ||
        a.len - b.len
    );
    return matchingContainers.length > 0 ? matchingContainers[0].sec : null;
  }

  if (typeof document.querySelectorAll === 'function') {
    for (const inp of Array.from(document.querySelectorAll('input[type="file"]'))) {
      delete inp.__cwsUsedInCurrentLocale;
    }
  }

  const clickedDeleteBtns = new Set();
  let removedCount = 0;
  let confirmedCount = 0;
  const isFullDom = typeof document !== 'undefined' && typeof document.createElement === 'function';
  const maxDialogPolls = isFullDom ? 20 : 3;
  const maxClosePolls = isFullDom ? 12 : 1;
  const pollIntervalMs = isFullDom ? 60 : 50;

  let container = findTargetScreenshotContainer();

  for (let pass = 0; pass < 10; pass++) {
    let activeContainer =
      container && container.isConnected !== false ? container : findTargetScreenshotContainer();
    let deleteButtons = [];
    if (activeContainer) {
      deleteButtons = getDeleteButtonsInContainer(activeContainer);
      if (deleteButtons.length === 0) {
        const refreshed = findTargetScreenshotContainer();
        if (refreshed && refreshed !== activeContainer) {
          container = refreshed;
          activeContainer = refreshed;
          deleteButtons = getDeleteButtonsInContainer(activeContainer);
        }
      }
    } else if (pass === 0 && typeof document.querySelectorAll === 'function') {
      deleteButtons = Array.from(document.querySelectorAll('[data-action="delete-screenshot"]')).filter(
        (el) => el && typeof el.click === 'function' && !isInsideDialog(el)
      );
    }

    const nextBtn = deleteButtons.find((btn) => !clickedDeleteBtns.has(btn));
    if (!nextBtn) {
      break;
    }

    // Exclude all pre-existing non-dialog asset delete buttons on the page from being treated as dialog confirm buttons
    const pageDeleteButtonsBeforeClick = new Set(deleteButtons);
    if (typeof document.querySelectorAll === 'function') {
      for (const sec of Array.from(document.querySelectorAll('section, [role="region"]'))) {
        if (!sec || isExplicitDialogElement(sec) || isInsideDialog(sec)) continue;
        for (const b of getDeleteButtonsInContainer(sec)) {
          pageDeleteButtonsBeforeClick.add(b);
        }
      }
    }

    const snapBefore = getContainerMediaSnapshot(activeContainer);
    clickedDeleteBtns.add(nextBtn);
    nextBtn.click();
    removedCount++;

    const confirmedDialogsInStep = new Set();
    const excludedBtnsInStep = new Set([...clickedDeleteBtns, ...pageDeleteButtonsBeforeClick]);
    let stepConfirmed = false;

    const immediateConfirm = findAndClickConfirmDialogButton(excludedBtnsInStep, confirmedDialogsInStep);
    if (immediateConfirm.clicked) {
      stepConfirmed = true;
      confirmedCount++;
    }

    for (let poll = 0; poll < maxDialogPolls; poll++) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const pollConfirm = findAndClickConfirmDialogButton(excludedBtnsInStep, confirmedDialogsInStep);
      if (pollConfirm.clicked) {
        stepConfirmed = true;
        confirmedCount++;
      }
      if (stepConfirmed) {
        break;
      }
      if (poll >= 1 && activeContainer) {
        const snapNow = getContainerMediaSnapshot(activeContainer);
        const btnsNow = getDeleteButtonsInContainer(activeContainer);
        if (
          (snapBefore.imgCount > 0 && snapNow.imgCount < snapBefore.imgCount) ||
          btnsNow.length < deleteButtons.length
        ) {
          break;
        }
      }
    }

    if (stepConfirmed) {
      for (let closePoll = 0; closePoll < maxClosePolls; closePoll++) {
        const anyOpenDialogRemaining = Array.from(confirmedDialogsInStep).some((dlg) => isControlVisible(dlg, true));
        if (!anyOpenDialogRemaining) {
          const followUp = findAndClickConfirmDialogButton(excludedBtnsInStep, confirmedDialogsInStep);
          if (followUp.clicked) {
            confirmedCount++;
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            continue;
          }
        }
        const inFlight =
          typeof window !== 'undefined' && typeof window.__cwsGetActiveReqCount === 'function'
            ? window.__cwsGetActiveReqCount()
            : typeof window !== 'undefined' && typeof window.__cwsInFlightRequests === 'number'
              ? window.__cwsInFlightRequests
              : 0;
        if (!anyOpenDialogRemaining && inFlight === 0) {
          break;
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      if (isFullDom) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
    }

    const snapAfter = getContainerMediaSnapshot(activeContainer);
    const deleteButtonsAfter = activeContainer ? getDeleteButtonsInContainer(activeContainer) : [];
    const mediaChanged =
      snapAfter.imgCount > 0 &&
      (snapAfter.imgCount < snapBefore.imgCount || (snapAfter.sig && snapAfter.sig !== snapBefore.sig));
    const btnCountDecreased = deleteButtonsAfter.length > 0 && deleteButtonsAfter.length < deleteButtons.length;
    if (mediaChanged || btnCountDecreased || (stepConfirmed && snapAfter.imgCount > 0)) {
      clickedDeleteBtns.delete(nextBtn);
    }
  }

  if (removedCount === 0) {
    const strayConfirm = findAndClickConfirmDialogButton(clickedDeleteBtns, new Set());
    if (strayConfirm.clicked) {
      confirmedCount++;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return { removedCount, confirmedCount };
}

/**
 * In-page DOM finder: Return the `<input type="file">` element for either `'screenshots'` (Localized screenshots) or `'banner'` (Small promo tile).
 * Used with `session.uploadFilesToInput(domFindAssetFileInput, [assetType], filePaths)`.
 */
function domFindAssetFileInput(assetType) {
  const isScreenshot = assetType === 'screenshots';
  const localizedScreenshotRe =
    /localized\s*screenshots?|language-specific\s*screenshots?|ローカライズ(?:版|された)?\s*スクリーンショット|言語別のスクリーンショット|この言語のスクリーンショット/i;
  const globalScreenshotRe =
    /global\s*screenshots?|default\s*screenshots?|グローバル(?:版|な)?\s*スクリーンショット|すべての言語共通のスクリーンショット|共通のスクリーンショット/i;
  const genericScreenshotRe = /screenshots?|スクリーンショット|1280\s*[x×]\s*800|640\s*[x×]\s*400/i;
  const smallPromoRe = /small\s*promo\s*tile|小プロモーション\s*タイル|プロモーション\s*タイル\s*[（(]小[)）]|440\s*[x×]\s*280/i;
  const marqueePromoRe = /marquee\s*promo\s*tile|マーキー\s*プロモーション\s*タイル|プロモーション\s*タイル\s*[（(]大[)）]|marquee|マーキー|1400\s*[x×]\s*560/i;
  const storeIconRe = /store\s*icon|ストア\s*アイコン|128\s*[x×]\s*128/i;

  const excludeForScreenshotRe =
    /small\s*promo\s*tile|小プロモーション|440\s*[x×]\s*280|marquee|マーキー|1400\s*[x×]\s*560|store\s*icon|ストア\s*アイコン|128\s*[x×]\s*128/i;
  const excludeForBannerRe =
    /screenshots?|スクリーンショット|1280\s*[x×]\s*800|640\s*[x×]\s*400|marquee|マーキー|1400\s*[x×]\s*560|store\s*icon|ストア\s*アイコン|128\s*[x×]\s*128/i;

  function classifyScreenshotSectionText(txt) {
    const norm = String(txt || '').replace(/\s+/g, ' ').trim();
    if (!norm) return 'none';
    const locIdx = norm.search(localizedScreenshotRe);
    const globIdx = norm.search(globalScreenshotRe);
    if (locIdx !== -1 && (globIdx === -1 || locIdx < globIdx)) {
      return 'localized';
    }
    if (globIdx !== -1 && (locIdx === -1 || globIdx < locIdx)) {
      return 'global';
    }
    if (genericScreenshotRe.test(norm)) {
      return 'generic';
    }
    return 'none';
  }

  function pickPreferredInput(candidates) {
    if (!candidates || candidates.length === 0) return null;
    const enabled = candidates.filter((el) => !el.disabled && el.getAttribute?.('aria-disabled') !== 'true');
    return enabled[0] || candidates[0];
  }

  function getParentOrHost(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    if (typeof node.getRootNode === 'function') {
      const root = node.getRootNode();
      if (root && root.host) return root.host;
    }
    return null;
  }

  function collectFileInputs(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const found = Array.from(root.querySelectorAll('input[type="file"]'));
    let allNodes = [];
    try {
      allNodes = Array.from(root.querySelectorAll('*'));
    } catch {
      allNodes = [];
    }
    for (const el of allNodes) {
      if (el && el.shadowRoot) {
        found.push(...collectFileInputs(el.shadowRoot));
      }
    }
    return found;
  }

  function getSingleInputContexts(input) {
    const contexts = [];
    let node = getParentOrHost(input);
    for (let depth = 1; depth <= 15 && node && node !== document.body; depth++) {
      if (typeof node.querySelectorAll === 'function' && node.querySelectorAll('input[type="file"]').length > 1) {
        break;
      }
      const ownText = (node.textContent || '').replace(/\s+/g, ' ').trim();
      const sibTexts = [];
      let sib = node.previousElementSibling;
      for (let s = 0; s < 8 && sib; s++) {
        if (typeof sib.querySelectorAll === 'function' && sib.querySelectorAll('input[type="file"]').length > 0) {
          break;
        }
        const st = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (st) sibTexts.unshift(st);
        sib = sib.previousElementSibling;
      }
      const combinedText = [...sibTexts, ownText].filter(Boolean).join(' ');
      contexts.push({ depth, node, ownText, combinedText });
      node = getParentOrHost(node);
    }
    return contexts;
  }

  const allFileInputs = collectFileInputs(typeof document !== 'undefined' ? document : null);
  const inputMetaMap = new Map();

  if (allFileInputs.length > 0) {
    for (const input of allFileInputs) {
      const contexts = getSingleInputContexts(input);
      const fullSingleText = contexts.map((c) => c.combinedText).join(' ');
      let resolvedKind = 'none';
      for (const ctx of contexts) {
        if (excludeForScreenshotRe.test(ctx.combinedText)) break;
        const k = classifyScreenshotSectionText(ctx.combinedText);
        if (k === 'localized' || k === 'global') {
          resolvedKind = k;
          break;
        }
        if (k === 'generic' && resolvedKind === 'none') {
          resolvedKind = 'generic';
        }
      }
      inputMetaMap.set(input, {
        contexts,
        fullSingleText,
        isLocalizedScreenshot: resolvedKind === 'localized',
        isGlobalScreenshot: resolvedKind === 'global',
        isStoreIcon: storeIconRe.test(fullSingleText),
        isSmallPromo: smallPromoRe.test(fullSingleText),
        isMarquee: marqueePromoRe.test(fullSingleText)
      });
    }

    // Pass 1: Direct attribute match on input element
    if (isScreenshot) {
      const directLocalized = allFileInputs.filter((input) => {
        const dataAsset = (
          input.getAttribute?.('data-asset-type') ||
          input.getAttribute?.('aria-label') ||
          input.name ||
          input.id ||
          ''
        ).toLowerCase();
        return classifyScreenshotSectionText(dataAsset) === 'localized';
      });
      if (directLocalized.length > 0) return pickPreferredInput(directLocalized);

      const directGeneric = allFileInputs.filter((input) => {
        const meta = inputMetaMap.get(input);
        if (meta?.isGlobalScreenshot) return false;
        const dataAsset = (
          input.getAttribute?.('data-asset-type') ||
          input.getAttribute?.('aria-label') ||
          input.name ||
          input.id ||
          ''
        ).toLowerCase();
        return /screenshot|スクリーンショット/.test(dataAsset) && classifyScreenshotSectionText(dataAsset) !== 'global';
      });
      if (directGeneric.length > 0) return pickPreferredInput(directGeneric);
    } else {
      for (const input of allFileInputs) {
        const dataAsset = (
          input.getAttribute?.('data-asset-type') ||
          input.getAttribute?.('aria-label') ||
          input.name ||
          input.id ||
          ''
        ).toLowerCase();
        if (/promo|banner|プロモーション|440/.test(dataAsset) && !/marquee|マーキー|1400/.test(dataAsset)) {
          return input;
        }
      }
    }

    // Pass 2: Single-input container & sibling context search up to depth 15
    if (isScreenshot) {
      // Pass 2A: Explicit Localized Screenshots container (even if helper subtitle mentions Global Screenshots)
      for (let depth = 1; depth <= 15; depth++) {
        const matches = [];
        for (const input of allFileInputs) {
          const meta = inputMetaMap.get(input);
          if (meta?.isGlobalScreenshot) continue;
          const ctx = meta?.contexts.find((c) => c.depth === depth);
          if (!ctx) continue;
          if (
            classifyScreenshotSectionText(ctx.combinedText) === 'localized' &&
            !excludeForScreenshotRe.test(ctx.combinedText)
          ) {
            matches.push(input);
          }
        }
        if (matches.length > 0) return pickPreferredInput(matches);
      }
      // Pass 2B: Generic Screenshots container excluding Global Screenshots, Store Icon, and Promo Tiles
      for (let depth = 1; depth <= 15; depth++) {
        const matches = [];
        for (const input of allFileInputs) {
          const meta = inputMetaMap.get(input);
          if (meta?.isGlobalScreenshot || meta?.isStoreIcon || meta?.isSmallPromo || meta?.isMarquee) {
            continue;
          }
          const ctx = meta?.contexts.find((c) => c.depth === depth);
          if (!ctx) continue;
          const kind = classifyScreenshotSectionText(ctx.combinedText);
          if ((kind === 'generic' || kind === 'localized') && !excludeForScreenshotRe.test(ctx.combinedText)) {
            matches.push(input);
          }
        }
        if (matches.length > 0) return pickPreferredInput(matches);
      }
    } else {
      for (let depth = 1; depth <= 15; depth++) {
        for (const input of allFileInputs) {
          const meta = inputMetaMap.get(input);
          if (meta?.isLocalizedScreenshot || meta?.isStoreIcon || meta?.isMarquee) {
            continue;
          }
          const ctx = meta?.contexts.find((c) => c.depth === depth);
          if (!ctx) continue;
          if (smallPromoRe.test(ctx.combinedText) && !excludeForBannerRe.test(ctx.combinedText)) {
            return input;
          }
        }
      }
    }

    // Pass 3A: Closest preceding section heading in document order (for flat multi-input sections)
    if (typeof document.querySelectorAll === 'function' && typeof allFileInputs[0]?.compareDocumentPosition === 'function') {
      const anySectionHeadingRe = new RegExp(
        [
          localizedScreenshotRe.source,
          globalScreenshotRe.source,
          storeIconRe.source,
          smallPromoRe.source,
          marqueePromoRe.source,
          genericScreenshotRe.source
        ].join('|'),
        'i'
      );
      const headings = Array.from(
        document.querySelectorAll('h1, h2, h3, h4, h5, h6, label, legend, [role="heading"], div, span, p')
      ).filter((el) => {
        if (!el) return false;
        if (typeof el.querySelectorAll === 'function' && el.querySelectorAll('input[type="file"]').length > 0) {
          return false;
        }
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return txt.length > 0 && txt.length <= 180 && anySectionHeadingRe.test(txt);
      });

      if (headings.length > 0) {
        const closestHeadingForInput = new Map();
        for (const input of allFileInputs) {
          let lastPreceding = null;
          for (const h of headings) {
            const pos = h.compareDocumentPosition(input);
            if ((pos & 4) !== 0 && (pos & 8) === 0) {
              lastPreceding = (h.textContent || '').replace(/\s+/g, ' ').trim();
            }
          }
          if (lastPreceding) {
            closestHeadingForInput.set(input, lastPreceding);
          }
        }

        if (isScreenshot) {
          const locHeadingMatches = [];
          const genHeadingMatches = [];
          for (const [input, hTxt] of closestHeadingForInput.entries()) {
            const kind = classifyScreenshotSectionText(hTxt);
            if (kind === 'localized') {
              locHeadingMatches.push(input);
            } else if (kind === 'generic' && !excludeForScreenshotRe.test(hTxt)) {
              genHeadingMatches.push(input);
            }
          }
          if (locHeadingMatches.length > 0) return pickPreferredInput(locHeadingMatches);
          if (genHeadingMatches.length > 0) return pickPreferredInput(genHeadingMatches);
        } else {
          for (const [input, hTxt] of closestHeadingForInput.entries()) {
            if (smallPromoRe.test(hTxt) && !excludeForBannerRe.test(hTxt)) {
              return input;
            }
          }
        }
      }
    }

    // Pass 3B: Breadth-first ancestor search allowing multi-input widget containers if excludeRe is still clean
    const excludeRe = isScreenshot ? excludeForScreenshotRe : excludeForBannerRe;
    if (isScreenshot) {
      for (let depth = 1; depth <= 8; depth++) {
        const matches = [];
        for (const input of allFileInputs) {
          let node = input;
          for (let d = 0; d < depth && node; d++) {
            node = getParentOrHost(node);
          }
          if (!node || node === document.body) continue;
          const txt = (node.textContent || '').replace(/\s+/g, ' ');
          if (classifyScreenshotSectionText(txt) === 'localized' && !excludeRe.test(txt)) {
            matches.push(input);
          }
        }
        if (matches.length > 0) return pickPreferredInput(matches);
      }
      for (let depth = 1; depth <= 8; depth++) {
        const matches = [];
        for (const input of allFileInputs) {
          let node = input;
          for (let d = 0; d < depth && node; d++) {
            node = getParentOrHost(node);
          }
          if (!node || node === document.body) continue;
          const txt = (node.textContent || '').replace(/\s+/g, ' ');
          if (classifyScreenshotSectionText(txt) === 'generic' && !excludeRe.test(txt)) {
            matches.push(input);
          }
        }
        if (matches.length > 0) return pickPreferredInput(matches);
      }
    } else {
      for (let depth = 1; depth <= 8; depth++) {
        for (const input of allFileInputs) {
          let node = input;
          for (let d = 0; d < depth && node; d++) {
            node = getParentOrHost(node);
          }
          if (!node || node === document.body) continue;
          const txt = (node.textContent || '').replace(/\s+/g, ' ');
          if (smallPromoRe.test(txt) && !excludeRe.test(txt)) {
            return input;
          }
        }
      }
    }
  }

  // Intercept HTMLInputElement.prototype.click and capture-phase click events on <input type="file">
  // so clicking an Upload/Add button or <label> inside the target section never opens a native OS file picker
  // and captures dynamically created or shared file inputs. Always restore prototypes/listeners in `finally`.
  if (typeof window !== 'undefined' && typeof window.HTMLInputElement?.prototype?.click === 'function') {
    const origClick = window.HTMLInputElement.prototype.click;
    let capturedInput = null;
    const onCaptureClick = (ev) => {
      const t = ev?.target;
      if (t && String(t.type || '').toLowerCase() === 'file') {
        capturedInput = t;
        window.__cwsLastTriggeredFileInput = t;
        ev.preventDefault?.();
        ev.stopPropagation?.();
      }
    };

    window.HTMLInputElement.prototype.click = function (...args) {
      if (this && String(this.type || '').toLowerCase() === 'file') {
        capturedInput = this;
        window.__cwsLastTriggeredFileInput = this;
        return undefined;
      }
      return origClick.apply(this, args);
    };
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('click', onCaptureClick, true);
    }
    window.__cwsLastTriggeredFileInput = null;

    try {
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        const triggerIncludeRe =
          /add|upload|browse|select\s*file|choose\s*file|ファイルを追加|ファイルを選択|アップロード|追加|ドラッグ/i;
        const triggerExcludeRe =
          /delete|remove|clear|trash|replace|change|edit|削除|クリア|置換|置き換え|変更|編集|preview|プレビュー|help|ヘルプ|save|保存|cancel|キャンセル|youtube|video|動画/i;

        const candidateSections = [];
        for (const sec of Array.from(document.querySelectorAll('section, [role="region"], div'))) {
          const rawTxt = String(sec.textContent || '');
          if (!rawTxt || rawTxt.length > 1500) continue;
          const txt = rawTxt.replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 1500) continue;
          if (typeof sec.querySelectorAll === 'function') {
            const secFileInputs = Array.from(sec.querySelectorAll('input[type="file"]')).filter(
              (el) => el && (String(el.type || '').toLowerCase() === 'file' || typeof el.multiple === 'boolean')
            );
            if (secFileInputs.length > 1) {
              continue;
            }
          }
          if (isScreenshot) {
            if (excludeForScreenshotRe.test(txt)) continue;
            const kind = classifyScreenshotSectionText(txt);
            if (kind === 'none' || kind === 'global') continue;
            const priority = kind === 'localized' ? 2 : 1;
            candidateSections.push({ sec, priority, len: txt.length });
          } else {
            if (excludeForBannerRe.test(txt) || !smallPromoRe.test(txt)) continue;
            candidateSections.push({ sec, priority: 2, len: txt.length });
          }
        }
        candidateSections.sort((a, b) => b.priority - a.priority || a.len - b.len);

        const clickedTriggers = new Set();
        for (const { sec } of candidateSections) {
          if (typeof sec.querySelectorAll !== 'function') continue;
          const rawTriggers = Array.from(
            sec.querySelectorAll(
              'button, [role="button"], label, [jsaction*="click" i], [data-action*="upload" i], [data-action*="add" i]'
            )
          ).filter((el) => {
            if (!el || el.disabled || el.getAttribute?.('aria-disabled') === 'true') return false;
            const meta = [
              el.textContent || '',
              el.getAttribute?.('aria-label') || '',
              el.getAttribute?.('title') || '',
              el.getAttribute?.('data-action') || ''
            ]
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (triggerExcludeRe.test(meta)) return false;
            return triggerIncludeRe.test(meta);
          });

          // Prefer innermost leaf triggers (buttons/labels that do not wrap another matching trigger)
          const leafTriggers = rawTriggers.filter(
            (el) => !rawTriggers.some((other) => other !== el && typeof el.contains === 'function' && el.contains(other))
          );
          const triggers = leafTriggers.length > 0 ? leafTriggers : rawTriggers;

          for (const trig of triggers) {
            if (clickedTriggers.has(trig)) continue;
            clickedTriggers.add(trig);
            try {
              window.__cwsLastTargetSection = sec;
              trig.click?.();
            } catch {}
            if (capturedInput || window.__cwsLastTriggeredFileInput) {
              return capturedInput || window.__cwsLastTriggeredFileInput;
            }
            if (trig.control && String(trig.control.type || '').toLowerCase() === 'file') {
              return trig.control;
            }
            if (typeof trig.querySelector === 'function') {
              const nestedInput = trig.querySelector('input[type="file"]');
              if (nestedInput) return nestedInput;
            }
          }
        }
      }
    } finally {
      window.HTMLInputElement.prototype.click = origClick;
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('click', onCaptureClick, true);
      }
    }
  }

  if (allFileInputs.length === 0) return null;

  // Pass 4: Fallback by index / non-excluded inputs
  // Standard 4+ input CWS Store Listing layout: [0]=localized screenshots, [1]=store icon(128x128), [2]=global screenshots, [3]=small promo(440x280)
  // 3-input Graphic assets layout: [0]=icon(128x128), [1]=screenshots(1280x800), [2]=small promo(440x280)
  if (isScreenshot) {
    const nonExcluded = allFileInputs.filter((el) => {
      const m = inputMetaMap.get(el);
      return !(m?.isStoreIcon || m?.isSmallPromo || m?.isMarquee || m?.isGlobalScreenshot);
    });
    if (nonExcluded.length > 0) {
      if (allFileInputs.length >= 4) {
        return pickPreferredInput(nonExcluded);
      }
      return nonExcluded.find((el) => el.multiple) || pickPreferredInput(nonExcluded);
    }
    // If only Global Screenshots exists on the page (e.g., primary locale without a separate Localized Screenshots section),
    // prefer Global Screenshots over Store Icon (128x128) or Promo Tiles.
    const globalFallback = allFileInputs.filter((el) => inputMetaMap.get(el)?.isGlobalScreenshot);
    if (globalFallback.length > 0) {
      return pickPreferredInput(globalFallback);
    }
    if (allFileInputs.length >= 4) {
      return allFileInputs[0];
    }
    return allFileInputs.find((el) => el.multiple) || allFileInputs[1] || allFileInputs[0];
  }
  if (allFileInputs.length >= 4) {
    return allFileInputs[3] || allFileInputs[2];
  }
  return allFileInputs[2] || (allFileInputs.length === 1 ? allFileInputs[0] : null);
}

/**
 * In-page DOM helper: Click "Save draft" (`下書きとして保存` / `Save draft`) button,
 * waiting briefly if the button is temporarily disabled or an asset upload is still in flight.
 */
async function domClickSaveDraft() {
  const saveRe = /^(save\s*draft|下書きとして保存|下書きを保存|下書き保存)$/i;
  const partialSaveRe = /save\s*draft|下書きとして保存|下書きを保存/i;
  const isFullDom = typeof document !== 'undefined' && typeof document.createElement === 'function';

  function getActiveReqCount() {
    if (typeof window !== 'undefined' && typeof window.__cwsGetActiveReqCount === 'function') {
      return window.__cwsGetActiveReqCount();
    }
    if (typeof window !== 'undefined' && typeof window.__cwsInFlightRequests === 'number') {
      return window.__cwsInFlightRequests;
    }
    return 0;
  }

  function findEditableDetailedTextarea() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    const summaryExclude = /short\s*description|summary|簡単な説明|概要|single\s*purpose|単一の目的|justification|申告理由/i;
    const explicitDetailedRe = /detailed\s*description|詳細な説明|商品の詳細/i;
    const candidates = Array.from(document.querySelectorAll('textarea')).filter((ta) => {
      if (!ta || ta.disabled || ta.readOnly) return false;
      if (ta.hidden === true || String(ta.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') return false;
      if (ta.maxLength > 0 && ta.maxLength <= 200) return false;
      const cls = String(ta.className || ta.getAttribute?.('class') || '');
      if (/\bcdk-textarea-autosize-measuring\b/i.test(cls)) return false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const st = window.getComputedStyle(ta);
          if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
        } catch {}
      }
      if (typeof ta.getBoundingClientRect === 'function') {
        try {
          const r = ta.getBoundingClientRect();
          if (r && (r.width <= 0 || r.height <= 0)) return false;
        } catch {}
      }
      const aria = [
        ta.getAttribute?.('aria-label') || '',
        ta.getAttribute?.('placeholder') || '',
        ta.getAttribute?.('name') || '',
        ta.id || ''
      ].join(' ');
      if (summaryExclude.test(aria) && !explicitDetailedRe.test(aria)) return false;
      return true;
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      return candidates.sort((a, b) => {
        const maxDiff = (b.maxLength > 200 ? b.maxLength : 0) - (a.maxLength > 200 ? a.maxLength : 0);
        if (maxDiff !== 0) return maxDiff;
        return (b.rows || 5) - (a.rows || 5);
      })[0];
    }
    return null;
  }

  function ensureDetailedDescriptionIntact() {
    if (
      typeof window === 'undefined' ||
      typeof window.__cwsExpectedDetailedDescription !== 'string' ||
      window.__cwsExpectedDetailedDescription.length === 0
    ) {
      return false;
    }
    const expectedDesc = window.__cwsExpectedDetailedDescription;
    let targetTa = window.__cwsLastDetailedTextarea;
    if (!targetTa || targetTa.isConnected === false) {
      targetTa = findEditableDetailedTextarea();
      if (targetTa) {
        window.__cwsLastDetailedTextarea = targetTa;
      }
    }
    if (!targetTa || targetTa.isConnected === false || targetTa.value === expectedDesc) {
      return false;
    }
    try {
      targetTa.focus?.();
      const proto = typeof window.HTMLTextAreaElement === 'function' ? window.HTMLTextAreaElement.prototype : null;
      const setter = proto
        ? Object.getOwnPropertyDescriptor(proto, 'value')?.set
        : Object.getOwnPropertyDescriptor(Object.getPrototypeOf(targetTa) || {}, 'value')?.set;
      if (typeof setter === 'function') {
        setter.call(targetTa, expectedDesc);
      } else {
        targetTa.value = expectedDesc;
      }
      if (typeof targetTa.dispatchEvent === 'function' && typeof Event === 'function') {
        if (typeof InputEvent === 'function') {
          try {
            targetTa.dispatchEvent(
              new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: expectedDesc })
            );
          } catch {
            targetTa.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else {
          targetTa.dispatchEvent(new Event('input', { bubbles: true }));
        }
        targetTa.dispatchEvent(new Event('change', { bubbles: true }));
        targetTa.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      return true;
    } catch {
      return false;
    }
  }

  function findSaveButtons(includeDisabled = false) {
    return Array.from(document.querySelectorAll('button, [role="button"]')).filter((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!saveRe.test(txt) && !partialSaveRe.test(txt)) return false;
      if (includeDisabled) return true;
      return !el.disabled && el.getAttribute?.('aria-disabled') !== 'true';
    });
  }

  if (ensureDetailedDescriptionIntact() && isFullDom) {
    await new Promise((r) => setTimeout(r, 120));
  }

  for (let poll = 0; poll < 16; poll++) {
    const inFlight = getActiveReqCount();
    if (inFlight > 0 && poll < 12) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (ensureDetailedDescriptionIntact() && isFullDom) {
      await new Promise((r) => setTimeout(r, 120));
    }
    const enabled = findSaveButtons(false);
    let btn = enabled.find((el) => saveRe.test((el.textContent || '').replace(/\s+/g, ' ').trim()));
    if (!btn) {
      btn = enabled[0];
    }
    if (btn) {
      if (typeof btn.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
        try {
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        } catch {}
      }
      btn.click();
      if (isFullDom) {
        await new Promise((r) => setTimeout(r, 100));
        for (let w = 0; w < 12; w++) {
          if (getActiveReqCount() === 0) break;
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      return { clicked: true, label: (btn.textContent || '').replace(/\s+/g, ' ').trim() };
    }
    const anySaveBtn = findSaveButtons(true);
    if (anySaveBtn.length === 0) {
      return { clicked: false };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return { clicked: false };
}

/**
 * In-page DOM helper: Read-only inspection of the active locale's Detailed Description
 * and Localized Screenshots count on the Chrome Web Store Developer Dashboard Store Listing page.
 * Executed inside the browser page context via `session.evaluate(...)`.
 */
async function domInspectLocaleListing(expectedDescription = null, expectedScreenshots = 2) {
  const localizedScreenshotRe =
    /localized\s*screenshots?|language-specific\s*screenshots?|ローカライズ(?:版|された)?\s*スクリーンショット|言語別のスクリーンショット|この言語のスクリーンショット/i;
  const globalScreenshotRe =
    /global\s*screenshots?|default\s*screenshots?|グローバル(?:版|な)?\s*スクリーンショット|すべての言語共通のスクリーンショット|共通のスクリーンショット/i;
  const screenshotHeadingRe = /screenshots?|スクリーンショット|1280\s*[x×]\s*800|640\s*[x×]\s*400/i;
  const promoExcludeRe =
    /promo\s*tile|プロモーション\s*タイル|小プロモーション|440\s*[x×]\s*280|marquee|マーキー|1400\s*[x×]\s*560|store\s*icon|ストア\s*アイコン|128\s*[x×]\s*128/i;

  const explicitDetailedRe = /detailed\s*description|詳細な説明|商品の詳細/i;
  const generalDescRe = /description|説明|product\s*details/i;
  const summaryExclude =
    /short\s*description|summary|簡単な説明|概要|single\s*purpose|単一の目的|justification|申告理由/i;

  function normalizeDesc(str) {
    return String(str || '').replace(/\r\n?/g, '\n').trim();
  }

  function getParentOrHost(el) {
    if (!el) return null;
    if (el.parentElement) return el.parentElement;
    if (typeof el.getRootNode === 'function') {
      const r = el.getRootNode();
      if (r && r.host) return r.host;
    }
    return null;
  }

  function queryAllDeep(root, selector) {
    if (!root) return [];
    let found = [];
    if (typeof root.querySelectorAll === 'function') {
      try {
        found = Array.from(root.querySelectorAll(selector));
      } catch {
        found = [];
      }
    }
    if (root.shadowRoot) {
      found.push(...queryAllDeep(root.shadowRoot, selector));
    }
    let allNodes = [];
    if (typeof root.querySelectorAll === 'function') {
      try {
        allNodes = Array.from(root.querySelectorAll('*'));
      } catch {
        allNodes = [];
      }
    }
    for (const node of allNodes) {
      if (node && node.shadowRoot) {
        found.push(...queryAllDeep(node.shadowRoot, selector));
      }
    }
    return found;
  }

  function isControlVisible(el, checkOpacity = false) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean' && !el.isConnected) return false;
    const cls = String(el.className || el.getAttribute?.('class') || '');
    if (/\bcdk-textarea-autosize-measuring\b/i.test(cls)) return false;
    let cur = el;
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 15 && cur && cur !== bodyEl; d++) {
      if (cur.hidden === true || String(cur.getAttribute?.('aria-hidden') || '').toLowerCase() === 'true') {
        return false;
      }
      if (cur.style) {
        if (
          cur.style.display === 'none' ||
          cur.style.visibility === 'hidden' ||
          (checkOpacity && cur.style.opacity === '0')
        ) {
          return false;
        }
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const st = window.getComputedStyle(cur);
          if (
            st &&
            (st.display === 'none' || st.visibility === 'hidden' || (checkOpacity && st.opacity === '0'))
          ) {
            return false;
          }
        } catch {}
      }
      cur = getParentOrHost(cur);
    }
    if (typeof el.getBoundingClientRect === 'function') {
      try {
        const rect = el.getBoundingClientRect();
        if (rect && (rect.width <= 0 || rect.height <= 0)) {
          const descEls = queryAllDeep(el, '*');
          const hasVisibleDescendant = descEls.some((child) => {
            if (!child || typeof child.getBoundingClientRect !== 'function') return false;
            try {
              const cr = child.getBoundingClientRect();
              return Boolean(cr && cr.width > 0 && cr.height > 0);
            } catch {
              return false;
            }
          });
          if (!hasVisibleDescendant) return false;
        }
      } catch {}
    }
    return true;
  }

  function isExplicitDialogElement(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return false;
    const role = String(el.getAttribute?.('role') || el.role || '').toLowerCase();
    if (role === 'dialog' || role === 'alertdialog') return true;
    if (String(el.getAttribute?.('aria-modal') || '').toLowerCase() === 'true') return true;
    const tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (
      tag === 'dialog' ||
      tag === 'mat-dialog-container' ||
      tag === 'mwc-dialog' ||
      tag === 'md-dialog' ||
      tag === 'material-dialog' ||
      tag === 'modal'
    ) {
      if (tag === 'dialog' && el.open === false && el.getAttribute?.('open') === null) {
        return false;
      }
      return true;
    }
    const cls = String(el.className || el.getAttribute?.('class') || '');
    if (
      /\b(mdc-dialog|mat-dialog-container|mat-mdc-dialog-container|goog-modalpopup|VfPpkd-sx9Kwc|VfPpkd-P5QLlc)\b/i.test(
        cls
      )
    ) {
      return true;
    }
    return false;
  }

  function isInsideDialog(el) {
    let cur = getParentOrHost(el);
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 15 && cur && cur !== bodyEl; d++) {
      if (isExplicitDialogElement(cur)) return true;
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function isFileOrTextareaControl(el) {
    if (!el) return false;
    const type = String(el.type || el.getAttribute?.('type') || '').toLowerCase();
    const tag = String(el.tagName || el.nodeName || '').toLowerCase();
    if (type === 'file' || tag === 'textarea') return true;
    if (tag === 'input' || tag === 'button') return false;
    if (typeof el.multiple === 'boolean' || typeof el.rows === 'number') return true;
    if (!el.textContent && typeof el.click !== 'function') return true;
    return false;
  }

  function classifyScreenshotSectionText(txt) {
    const norm = String(txt || '').replace(/\s+/g, ' ').trim();
    if (!norm) return 'none';
    const locIdx = norm.search(localizedScreenshotRe);
    const globIdx = norm.search(globalScreenshotRe);
    if (locIdx !== -1 && (globIdx === -1 || locIdx < globIdx)) {
      return 'localized';
    }
    if (globIdx !== -1 && (locIdx === -1 || globIdx < locIdx)) {
      return 'global';
    }
    if (screenshotHeadingRe.test(norm)) {
      return 'generic';
    }
    return 'none';
  }

  function containsDeep(parent, child) {
    if (!parent || !child) return false;
    if (parent === child) return true;
    if (typeof parent.contains === 'function' && parent.contains(child)) return true;
    let cur = getParentOrHost(child);
    for (let d = 0; d < 20 && cur; d++) {
      if (cur === parent) return true;
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function getDeleteButtonsInContainer(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const filterValidBtn = (btn) => {
      if (!btn || typeof btn.click !== 'function') return false;
      if (isFileOrTextareaControl(btn)) return false;
      if (btn.disabled || String(btn.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true') return false;
      if (isInsideDialog(btn)) return false;
      return isControlVisible(btn, false);
    };
    const explicitBtns = queryAllDeep(
      root,
      'button[aria-label*="Delete" i], button[aria-label*="Remove" i], button[aria-label*="削除"], ' +
      '[role="button"][aria-label*="Delete" i], [role="button"][aria-label*="Remove" i], [role="button"][aria-label*="削除"], ' +
      'button[title*="Delete" i], button[title*="Remove" i], button[title*="削除"], [data-action="delete-screenshot"]'
    ).filter(filterValidBtn);
    const matched =
      explicitBtns.length > 0
        ? explicitBtns
        : queryAllDeep(root, 'button, [role="button"], material-button').filter((btn) => {
            if (!filterValidBtn(btn)) return false;
            const iconTxt = (btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return (
              iconTxt === 'delete' ||
              iconTxt === 'delete_outline' ||
              iconTxt === 'delete_forever' ||
              iconTxt === '削除' ||
              iconTxt === '画像を削除'
            );
          });
    const leafBtns = matched.filter(
      (btn) => !matched.some((other) => other !== btn && containsDeep(btn, other))
    );
    return leafBtns.length > 0 ? leafBtns : matched;
  }

  function isInsideButtonControl(el, stopAt) {
    let cur = getParentOrHost(el);
    const bodyEl = typeof document !== 'undefined' ? document.body : null;
    for (let d = 0; d < 10 && cur && cur !== stopAt && cur !== bodyEl; d++) {
      const tag = String(cur.tagName || cur.nodeName || '').toLowerCase();
      if (tag === 'button' || tag === 'material-button' || tag === 'mwc-button' || tag === 'md-icon-button') {
        return true;
      }
      cur = getParentOrHost(cur);
    }
    return false;
  }

  function getContainerMediaSnapshot(root) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return { imgCount: 0, sig: '' };
    }
    let mediaEls = [];
    try {
      const rawMedia = queryAllDeep(root, 'img, [style*="background-image"]').filter((el) => {
        if (!el) return false;
        const tag = String(el.tagName || el.nodeName || '').toLowerCase();
        const role = String(el.getAttribute?.('role') || '').toLowerCase();
        if (tag === 'button' || tag === 'input' || role === 'button') return false;
        if (!tag && typeof el.click === 'function') return false;
        if (isInsideDialog(el) || isInsideButtonControl(el, root)) return false;
        if (!isControlVisible(el, false)) return false;
        if (typeof el.getBoundingClientRect === 'function') {
          try {
            const r = el.getBoundingClientRect();
            if (r && r.width > 0 && r.height > 0 && r.width <= 32 && r.height <= 32) {
              return false;
            }
          } catch {}
        }
        const src = String(
          el.getAttribute?.('src') || el.src || el.currentSrc || el.getAttribute?.('srcset') || ''
        ).trim();
        const style = String(el.getAttribute?.('style') || el.style?.backgroundImage || '').trim();
        const hasBgUrl =
          /url\s*\(\s*['"]?\s*(?!['"]?\s*\))[^)'"]+['"]?\s*\)/i.test(style) ||
          (/background-image\s*:/i.test(style) &&
            !/background-image\s*:\s*(?:none|initial|inherit|unset)\b/i.test(style) &&
            !/url\s*\(\s*['"]?\s*['"]?\s*\)/i.test(style));
        const hasValidMedia = tag === 'img' ? Boolean(src) || hasBgUrl : hasBgUrl || Boolean(src);
        if (!hasValidMedia) return false;
        const combined = `${src} ${style}`.trim();
        return Boolean(combined) && !/upload_illustration|empty_state|placeholder_icon/i.test(combined);
      });
      mediaEls = rawMedia.filter(
        (el) => !rawMedia.some((other) => other !== el && containsDeep(el, other))
      );
    } catch {
      mediaEls = [];
    }
    const sig = mediaEls
      .map((el) => el.getAttribute?.('src') || el.src || el.getAttribute?.('style') || '')
      .filter(Boolean)
      .join('|');
    return { imgCount: mediaEls.length, sig };
  }

  function isSpinnerVisibleInContainer(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return false;
    const spinnerSelector =
      '[role="progressbar"], mat-spinner, mat-progress-spinner, mat-progress-bar, .mdc-linear-progress, .mdc-circular-progress, [aria-busy="true"]';
    try {
      const spinners = Array.from(container.querySelectorAll(spinnerSelector));
      return spinners.some((el) => {
        if (!el) return false;
        const cls = String(el.className || el.getAttribute?.('class') || '');
        if (/\b(mdc-linear-progress--closed|hidden|ng-hide)\b/i.test(cls)) return false;
        return isControlVisible(el, true);
      });
    } catch {
      return false;
    }
  }

  function getPrecedingHeadingText(sec) {
    let sib = sec ? sec.previousElementSibling : null;
    const parts = [];
    for (let s = 0; s < 4 && sib; s++) {
      if (typeof sib.querySelectorAll === 'function') {
        const sibInputs = Array.from(sib.querySelectorAll('input[type="file"]')).filter(isFileOrTextareaControl);
        if (sibInputs.length > 0) break;
      }
      const st = String(sib.textContent || '').replace(/\s+/g, ' ').trim();
      if (st && st.length <= 400) {
        parts.unshift(st);
        if (classifyScreenshotSectionText(st) !== 'none' || promoExcludeRe.test(st)) {
          break;
        }
      }
      sib = sib.previousElementSibling;
    }
    return parts.join(' ');
  }

  function findTargetScreenshotContainer() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const sections = Array.from(document.querySelectorAll('section, [role="region"], div'));
    const matchingContainers = [];
    for (const sec of sections) {
      if (!sec) continue;
      const rawTxt = String(sec.textContent || '');
      if (rawTxt.length > 2500) continue;
      if (isExplicitDialogElement(sec) || isInsideDialog(sec)) continue;
      const txt = rawTxt.replace(/\s+/g, ' ').trim();
      if (promoExcludeRe.test(txt)) {
        continue;
      }

      let fileInputs = [];
      let delCount = 0;
      let imgCount = 0;
      if (typeof sec.querySelectorAll === 'function') {
        fileInputs = Array.from(sec.querySelectorAll('input[type="file"]')).filter(isFileOrTextareaControl);
        if (fileInputs.length > 1) {
          continue;
        }
        delCount = getDeleteButtonsInContainer(sec).length;
        imgCount = getContainerMediaSnapshot(sec).imgCount;
      }

      const itemCount = Math.max(imgCount, delCount);
      const hasFileInput = fileInputs.length > 0 ? 1 : 0;
      const hasControlsOrMedia = hasFileInput > 0 || itemCount > 0 ? 1 : 0;

      let effectiveTxt = txt;
      let kind = classifyScreenshotSectionText(effectiveTxt);
      if (kind === 'none' && hasControlsOrMedia > 0) {
        const sibHeading = getPrecedingHeadingText(sec);
        if (sibHeading) {
          effectiveTxt = `${sibHeading} ${txt}`.trim();
          if (promoExcludeRe.test(effectiveTxt)) continue;
          kind = classifyScreenshotSectionText(effectiveTxt);
        }
      }
      if (kind === 'none' || kind === 'global') {
        continue;
      }

      const priority = kind === 'localized' ? 2 : 1;
      const tag = String(sec.tagName || sec.nodeName || '').toLowerCase();
      const role = String(sec.getAttribute?.('role') || '').toLowerCase();
      const isSection = tag === 'section' || role === 'region' ? 1 : 0;

      matchingContainers.push({
        sec,
        priority,
        hasControlsOrMedia,
        itemCount,
        hasFileInput,
        isSection,
        len: effectiveTxt.length || 1
      });
    }

    matchingContainers.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.hasControlsOrMedia - a.hasControlsOrMedia ||
        b.itemCount - a.itemCount ||
        b.hasFileInput - a.hasFileInput ||
        b.isSection - a.isSection ||
        a.len - b.len
    );
    if (matchingContainers.length > 0) {
      return matchingContainers[0].sec;
    }
    if (typeof window !== 'undefined') {
      if (window.__cwsActiveUploadContainer && window.__cwsActiveUploadContainer.isConnected !== false) {
        return window.__cwsActiveUploadContainer;
      }
      if (window.__cwsLastTargetSection && window.__cwsLastTargetSection.isConnected !== false) {
        return window.__cwsLastTargetSection;
      }
    }
    return null;
  }

  function findDetailedDescriptionTextarea() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
      return null;
    }
    const textareas = queryAllDeep(document, 'textarea').filter(
      (el) => isControlVisible(el, false) && !(el.maxLength > 0 && el.maxLength <= 200)
    );
    const isEditable = (el) => !el.disabled && !el.readOnly;

    function getFieldContext(ta) {
      const aria = [
        ta.getAttribute?.('aria-label') || '',
        ta.getAttribute?.('placeholder') || '',
        ta.getAttribute?.('name') || '',
        ta.id || ''
      ].join(' ');

      const ancestors = [];
      if (typeof ta.closest === 'function') {
        const closestEl = ta.closest('section, div, label');
        const closestTaCount =
          closestEl && typeof closestEl.querySelectorAll === 'function'
            ? closestEl.querySelectorAll('textarea').length
            : 1;
        const closestLabel = closestTaCount <= 1 ? (closestEl?.textContent || '') : '';
        if (closestLabel && closestLabel.length <= 600) {
          ancestors.push(closestLabel.slice(0, 400));
        }
      }
      let node = getParentOrHost(ta);
      for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
        if (typeof node.querySelectorAll === 'function' && node.querySelectorAll('textarea').length > 1) {
          break;
        }
        const ownTxt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (ownTxt && ownTxt.length <= 600) {
          ancestors.push(ownTxt.slice(0, 400));
        }
        let sib = node.previousElementSibling;
        for (let s = 0; s < 4 && sib; s++) {
          if (typeof sib.querySelectorAll === 'function' && sib.querySelectorAll('textarea').length > 0) {
            break;
          }
          const sibTxt = (sib.textContent || '').replace(/\s+/g, ' ').trim();
          if (sibTxt && sibTxt.length <= 300) {
            ancestors.push(sibTxt);
          }
          sib = sib.previousElementSibling;
        }
        node = getParentOrHost(node);
      }
      const containerText = ancestors.join(' ');
      return { aria, containerText };
    }

    let target = null;
    const nonSummaryCandidates = [];

    for (const ta of textareas) {
      const { aria, containerText } = getFieldContext(ta);
      const isDirectSummaryAria = summaryExclude.test(aria) && !explicitDetailedRe.test(aria);
      const isContainerSummary =
        summaryExclude.test(containerText) &&
        !explicitDetailedRe.test(aria) &&
        !explicitDetailedRe.test(containerText);
      const isSummary =
        isDirectSummaryAria ||
        isContainerSummary ||
        /\b132\s*(?:chars?|文字|\/\s*132)\b/i.test(containerText);
      if (isSummary) {
        continue;
      }
      nonSummaryCandidates.push({ ta, aria, containerText });
    }

    nonSummaryCandidates.sort((a, b) => (isEditable(b.ta) ? 1 : 0) - (isEditable(a.ta) ? 1 : 0));

    for (const item of nonSummaryCandidates) {
      if (explicitDetailedRe.test(item.aria)) {
        target = item.ta;
        break;
      }
    }

    if (!target) {
      for (const item of nonSummaryCandidates) {
        if (explicitDetailedRe.test(item.containerText)) {
          target = item.ta;
          break;
        }
      }
    }

    if (!target) {
      for (const item of nonSummaryCandidates) {
        if (generalDescRe.test(item.aria) || generalDescRe.test(item.containerText)) {
          target = item.ta;
          break;
        }
      }
    }

    if (!target && nonSummaryCandidates.length > 0) {
      target = nonSummaryCandidates.sort((a, b) => {
        const maxDiff = (b.ta.maxLength > 200 ? b.ta.maxLength : 0) - (a.ta.maxLength > 200 ? a.ta.maxLength : 0);
        if (maxDiff !== 0) return maxDiff;
        return (b.ta.rows || 5) - (a.ta.rows || 5);
      })[0].ta;
    }

    if (!target && textareas.length === 1) {
      const onlyTa = textareas[0];
      const { aria, containerText } = getFieldContext(onlyTa);
      if (
        !summaryExclude.test(aria) &&
        !/\b132\b/.test(containerText) &&
        (generalDescRe.test(aria) || generalDescRe.test(containerText) || !(onlyTa.maxLength > 0 && onlyTa.maxLength <= 200))
      ) {
        target = onlyTa;
      }
    }

    return target;
  }

  function inspectOnce() {
    const checkDesc = expectedDescription !== null && expectedDescription !== undefined;
    const expectedNorm = checkDesc ? normalizeDesc(expectedDescription) : '';
    const ta = findDetailedDescriptionTextarea();
    const textareaFound = Boolean(ta);
    const actualNorm = ta ? normalizeDesc(ta.value ?? ta.textContent ?? '') : '';

    let descriptionOk = true;
    let descriptionStatus = 'skipped';
    if (checkDesc) {
      if (!textareaFound) {
        descriptionOk = false;
        descriptionStatus = 'missing_textarea';
      } else if (actualNorm.length === 0) {
        descriptionOk = false;
        descriptionStatus = 'empty';
      } else if (actualNorm !== expectedNorm) {
        descriptionOk = false;
        descriptionStatus = 'mismatch';
      } else {
        descriptionOk = true;
        descriptionStatus = 'ok';
      }
    }

    const checkScreens =
      typeof expectedScreenshots === 'number' && expectedScreenshots > 0;
    const container = findTargetScreenshotContainer();
    const screenshotContainerFound = Boolean(container);
    const mediaSnap = container ? getContainerMediaSnapshot(container) : { imgCount: 0, sig: '' };
    const delBtns = container ? getDeleteButtonsInContainer(container) : [];
    const screenshotMediaCount = mediaSnap.imgCount;
    const screenshotDeleteButtonCount = delBtns.length;
    const screenshotCount = Math.max(screenshotMediaCount, screenshotDeleteButtonCount);

    let screenshotsOk = true;
    let screenshotStatus = 'skipped';
    if (checkScreens) {
      if (!screenshotContainerFound) {
        screenshotsOk = false;
        screenshotStatus = 'missing_container';
      } else if (screenshotCount === expectedScreenshots) {
        screenshotsOk = true;
        screenshotStatus = 'ok';
      } else if (screenshotCount < expectedScreenshots) {
        screenshotsOk = false;
        screenshotStatus = 'insufficient';
      } else {
        screenshotsOk = false;
        screenshotStatus = 'excess';
      }
    }

    const activeReqs =
      typeof window !== 'undefined' && typeof window.__cwsGetActiveReqCount === 'function'
        ? window.__cwsGetActiveReqCount()
        : typeof window !== 'undefined' && typeof window.__cwsInFlightRequests === 'number'
          ? window.__cwsInFlightRequests
          : 0;
    const isUploading = isSpinnerVisibleInContainer(container);
    const ok = descriptionOk && screenshotsOk;

    return {
      inspected: true,
      ok,
      descriptionOk,
      descriptionStatus,
      textareaFound,
      actualDescriptionLength: actualNorm.length,
      expectedDescriptionLength: expectedNorm.length,
      screenshotsOk,
      screenshotStatus,
      screenshotContainerFound,
      screenshotCount,
      expectedScreenshots: checkScreens ? expectedScreenshots : 0,
      screenshotMediaCount,
      screenshotDeleteButtonCount,
      activeReqs,
      isUploading
    };
  }

  const isFullDom = typeof document !== 'undefined' && typeof document.createElement === 'function';
  let result = inspectOnce();
  if (isFullDom && (!result.ok || result.activeReqs > 0 || result.isUploading)) {
    for (let poll = 0; poll < 6; poll++) {
      await new Promise((r) => setTimeout(r, 120));
      result = inspectOnce();
      if (result.ok && result.activeReqs === 0 && !result.isUploading) {
        break;
      }
    }
  }

  return result;
}

/**
 * Wait until the browser is authenticated on the Chrome Web Store Developer Dashboard
 * and navigated to the target extension's Store Listing edit page.
 */
async function ensureStoreListingPageReady(session, plan, logger = console) {
  await session.goto(plan.dashboardEntryUrl);

  const deadline = Date.now() + plan.loginTimeoutMs;
  let promptedLogin = false;
  let clickedListingTab = false;
  let navigatedToDirectListing = Boolean(plan.directStoreListingUrl && plan.dashboardEntryUrl === plan.directStoreListingUrl);

  while (Date.now() < deadline) {
    const pageState = await session.evaluate(() => {
      const href = String(window.location.href || '');
      const hasTextarea = document.querySelectorAll('textarea').length > 0;
      const hasFileInput = document.querySelectorAll('input[type="file"]').length > 0;
      return { href, hasTextarea, hasFileInput };
    });

    const href = pageState?.href || '';
    if (href.includes('accounts.google.com') || href.includes('ServiceLogin')) {
      if (!promptedLogin) {
        logger.log(
          '[CWS Assets] Google sign-in required. Please log into your Google Account in the opened browser window...'
        );
        promptedLogin = true;
        navigatedToDirectListing = false;
      }
      await session.sleep(1500);
      continue;
    }

    // Extract publisherId if omitted, and navigate to Store Listing if on dashboard root after login
    if (href.includes('/webstore/devconsole/')) {
      if (!plan.publisherId) {
        const m = href.match(/\/webstore\/devconsole\/([^/?#]+)/i);
        if (m && m[1] && m[1] !== 'items') {
          plan.publisherId = m[1];
          plan.directStoreListingUrl = `${CWS_DEVCONSOLE_BASE}/${encodeURIComponent(plan.publisherId)}/${encodeURIComponent(plan.extensionId)}/edit/listing`;
        }
      }
      if (plan.directStoreListingUrl && !href.includes(`/${plan.extensionId}`) && !navigatedToDirectListing) {
        navigatedToDirectListing = true;
        logger.log(`[CWS Assets] Navigating to Store Listing for extension ${plan.extensionId}...`);
        await session.goto(plan.directStoreListingUrl);
        continue;
      }
    }

    const isOtherSubpage = /\/edit\/(package|privacy|distribution|analytics)\b/i.test(href);
    if (!isOtherSubpage && (pageState.hasTextarea || pageState.hasFileInput)) {
      return;
    }

    // Try clicking "Store listing" / "ストア掲載情報" tab if on the item overview or another tab
    if (!clickedListingTab) {
      const clickedTab = await session.evaluate(() => {
        const tabRe = /store\s*listing|ストア掲載情報|ストアの掲載情報/i;
        const links = Array.from(document.querySelectorAll('a, [role="tab"], [role="menuitem"], button'));
        const target = links.find((el) => tabRe.test((el.textContent || '').trim()));
        if (target) {
          target.click();
          return true;
        }
        return false;
      });
      if (clickedTab) {
        clickedListingTab = true;
        await session.sleep(1000);
        continue;
      }
    }

    await session.sleep(1000);
  }

  throw new Error(
    `Timed out after ${plan.loginTimeoutMs}ms waiting for Chrome Web Store Developer Dashboard Store Listing page.`
  );
}

/**
 * Execute read-only verification of Store Listing descriptions and localized screenshots across target locales.
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 * @param {object} deps
 */
async function verifyStoreListingAssets(options = {}, env = process.env, deps = {}) {
  const plan = buildUploadPlan({ ...options, verify: true }, env, deps);
  const logger = deps.logger || console;

  logger.log(
    `[CWS Verify] Inspecting ${plan.localePlans.length} locale(s) ` +
    `(descriptions: ${!plan.skipDescriptions}, screenshots: ${!plan.skipScreenshots})...`
  );

  if (plan.dryRun) {
    logger.log(`[CWS Verify] --dry-run enabled. Skipping browser inspection.`);
    const allLocales = plan.localePlans.map((lp) => lp.locale);
    return {
      verify: true,
      dryRun: true,
      allOk: true,
      extensionId: plan.extensionId,
      localesChecked: allLocales,
      passedLocales: allLocales,
      failedLocales: [],
      rerunCommand: null,
      results: [],
      plan
    };
  }

  const session = deps.browserSession || await createCdpBrowserSession({
    cdpUrl: plan.cdpUrl,
    debuggingPort: plan.debuggingPort,
    userDataDir: plan.userDataDir,
    browserPath: plan.browserPath,
    headless: plan.headless,
    fetchImpl: deps.fetchImpl,
    fsImpl: deps.fsImpl,
    spawnImpl: deps.spawnImpl,
    sleepImpl: deps.sleepImpl,
    logger
  });

  const results = [];
  const passedLocales = [];
  const failedLocales = [];

  try {
    await ensureStoreListingPageReady(session, plan, logger);

    for (let idx = 0; idx < plan.localePlans.length; idx++) {
      const lp = plan.localePlans[idx];
      const expectedScreenshots = plan.skipScreenshots ? 0 : (lp.screenshotFiles.length || 2);
      const expectedDesc = plan.skipDescriptions ? null : lp.detailedDescription;

      const selResult = await session.evaluate(domSelectLocale, lp.locale, lp.languageNames);
      if (!selResult || !selResult.matched) {
        failedLocales.push(lp.locale);
        const failEntry = {
          locale: lp.locale,
          languageLabel: lp.languageNames[0],
          localeSelected: false,
          ok: false,
          descriptionOk: false,
          descriptionStatus: 'locale_not_selected',
          actualDescriptionLength: 0,
          expectedDescriptionLength: lp.detailedDescription.length,
          screenshotsOk: false,
          screenshotStatus: 'locale_not_selected',
          screenshotCount: 0,
          expectedScreenshots
        };
        results.push(failEntry);
        logger.log(
          `[CWS Verify] [${idx + 1}/${plan.localePlans.length}] NG  ${lp.locale} (${lp.languageNames[0]}) — ` +
          `failed to select language in dropdown`
        );
        continue;
      }

      await session.sleep(plan.stepDelayMs);

      const inspection = await session.evaluate(
        domInspectLocaleListing,
        expectedDesc,
        expectedScreenshots
      );

      const descriptionOk = plan.skipDescriptions ? true : Boolean(inspection?.descriptionOk);
      const actualDescLen = inspection?.actualDescriptionLength ?? 0;
      const expectedDescLen = lp.detailedDescription.length;
      const descriptionStatus = plan.skipDescriptions
        ? 'skipped'
        : (inspection?.descriptionStatus || (descriptionOk ? 'ok' : 'mismatch'));

      const screenshotCount = inspection?.screenshotCount ?? 0;
      const screenshotsOk = plan.skipScreenshots
        ? true
        : (plan.keepExistingScreenshots
            ? Boolean(inspection?.screenshotContainerFound && screenshotCount >= expectedScreenshots)
            : Boolean(inspection?.screenshotsOk));
      const screenshotStatus = plan.skipScreenshots
        ? 'skipped'
        : screenshotsOk
          ? 'ok'
          : (inspection?.screenshotStatus || 'insufficient');

      const ok = descriptionOk && screenshotsOk;
      if (ok) {
        passedLocales.push(lp.locale);
      } else {
        failedLocales.push(lp.locale);
      }

      const descLabel = plan.skipDescriptions
        ? 'skipped'
        : descriptionOk
          ? `OK (${actualDescLen} chars)`
          : `NG (${descriptionStatus}, ${actualDescLen}/${expectedDescLen} chars)`;
      const screenLabel = plan.skipScreenshots
        ? 'skipped'
        : screenshotsOk
          ? `OK (${screenshotCount}/${expectedScreenshots})`
          : `NG (${screenshotCount}/${expectedScreenshots})`;

      logger.log(
        `[CWS Verify] [${idx + 1}/${plan.localePlans.length}] ${ok ? 'OK' : 'NG'}  ${lp.locale} (${selResult.label || lp.languageNames[0]}) — ` +
        `description: ${descLabel}, screenshots: ${screenLabel}`
      );

      results.push({
        locale: lp.locale,
        languageLabel: selResult.label || lp.languageNames[0],
        localeSelected: true,
        ok,
        descriptionOk,
        descriptionStatus,
        actualDescriptionLength: actualDescLen,
        expectedDescriptionLength: expectedDescLen,
        screenshotsOk,
        screenshotStatus,
        screenshotCount,
        expectedScreenshots
      });
    }

    const allOk = failedLocales.length === 0;
    const rerunCommand = allOk
      ? null
      : `npm run cws:assets -- --locales ${failedLocales.join(',')}`;

    logger.log(
      `[CWS Verify] Summary: ${passedLocales.length}/${results.length} locale(s) OK, ${failedLocales.length} NG.`
    );
    if (allOk) {
      logger.log(`[CWS Verify] All ${results.length} locale(s) verified successfully!`);
    } else {
      logger.log(`[CWS Verify] Failed locales (${failedLocales.length}): ${failedLocales.join(', ')}`);
      logger.log(`[CWS Verify] Re-run command for failed locales:\n  ${rerunCommand}`);
    }

    return {
      verify: true,
      dryRun: false,
      allOk,
      extensionId: plan.extensionId,
      localesChecked: results.map((r) => r.locale),
      passedLocales,
      failedLocales,
      rerunCommand,
      results
    };
  } finally {
    if (!deps.browserSession) {
      await session.close();
    }
  }
}

/**
 * Execute the full Store Listing automation flow across all target locales.
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 * @param {object} deps
 */
async function uploadStoreListingAssets(options = {}, env = process.env, deps = {}) {
  if (options && options.verify) {
    return verifyStoreListingAssets(options, env, deps);
  }

  const plan = buildUploadPlan(options, env, deps);
  const logger = deps.logger || console;

  logger.log(
    `[CWS Assets] Validated ${plan.localePlans.length} locale(s) ` +
    `(descriptions: ${!plan.skipDescriptions}, screenshots: ${!plan.skipScreenshots}, banner: ${!plan.skipBanner}).`
  );

  if (plan.dryRun) {
    logger.log(`[CWS Assets] --dry-run enabled. Skipping browser automation.`);
    return {
      dryRun: true,
      extensionId: plan.extensionId,
      localesProcessed: plan.localePlans.map((lp) => lp.locale),
      totalDescriptionsUpdated: plan.skipDescriptions ? 0 : plan.localePlans.length,
      totalScreenshotsUploaded: plan.skipScreenshots ? 0 : plan.localePlans.length * 2,
      totalBannersUploaded: plan.skipBanner ? 0 : plan.localePlans.filter((lp) => lp.locale === 'en' || lp.locale === 'ja').length || 1,
      plan
    };
  }

  const session = deps.browserSession || await createCdpBrowserSession({
    cdpUrl: plan.cdpUrl,
    debuggingPort: plan.debuggingPort,
    userDataDir: plan.userDataDir,
    browserPath: plan.browserPath,
    headless: plan.headless,
    fetchImpl: deps.fetchImpl,
    fsImpl: deps.fsImpl,
    spawnImpl: deps.spawnImpl,
    sleepImpl: deps.sleepImpl,
    logger
  });

  const results = [];
  let totalDescriptionsUpdated = 0;
  let totalScreenshotsUploaded = 0;
  let totalBannersUploaded = 0;
  let bannerUploadedGlobal = false;

  try {
    await ensureStoreListingPageReady(session, plan, logger);

    for (let idx = 0; idx < plan.localePlans.length; idx++) {
      const lp = plan.localePlans[idx];
      logger.log(
        `[CWS Assets] [${idx + 1}/${plan.localePlans.length}] Processing locale "${lp.locale}" (${lp.languageNames[0]})...`
      );

      const selResult = await session.evaluate(domSelectLocale, lp.locale, lp.languageNames);
      if (!selResult || !selResult.matched) {
        throw new Error(
          `Failed to select language "${lp.locale}" (${lp.languageNames.join(' / ')}) in Store Listing language dropdown.`
        );
      }
      await session.sleep(plan.stepDelayMs);

      let descriptionUpdated = false;
      if (!plan.skipDescriptions) {
        const descRes = await session.evaluate(domFillDetailedDescription, lp.detailedDescription);
        if (!descRes || !descRes.updated) {
          throw new Error(
            `Failed to fill Detailed Description for locale "${lp.locale}": ${descRes?.reason || 'unknown error'}`
          );
        }
        descriptionUpdated = true;
        totalDescriptionsUpdated++;
        await session.sleep(Math.min(300, plan.stepDelayMs));
      }

      let screenshotsUploaded = 0;
      if (!plan.skipScreenshots && lp.screenshotFiles.length > 0) {
        const expectedScreenshots = lp.screenshotFiles.length;
        const maxScreenshotAttempts = 3;
        let verifiedCount = null;

        for (let attempt = 1; attempt <= maxScreenshotAttempts; attempt++) {
          let filesToUpload = lp.screenshotFiles;
          if (attempt === 1) {
            if (!plan.keepExistingScreenshots) {
              await session.evaluate(domClearExistingScreenshots);
              await session.sleep(Math.min(250, plan.stepDelayMs));
            }
          } else if (
            verifiedCount !== null &&
            verifiedCount > 0 &&
            verifiedCount < expectedScreenshots &&
            (attempt === 2 || plan.keepExistingScreenshots)
          ) {
            filesToUpload = lp.screenshotFiles.slice(verifiedCount);
          } else if (!plan.keepExistingScreenshots) {
            await session.evaluate(domClearExistingScreenshots);
            await session.sleep(Math.min(250, plan.stepDelayMs));
            filesToUpload = lp.screenshotFiles;
          }

          try {
            for (const screenFile of filesToUpload) {
              await session.uploadFilesToInput(domFindAssetFileInput, ['screenshots'], [screenFile]);
              await session.sleep(plan.stepDelayMs);
            }
          } catch (uploadErr) {
            if (attempt >= maxScreenshotAttempts) {
              throw uploadErr;
            }
            logger.log(
              `[CWS Assets] Locale "${lp.locale}": screenshot upload error on attempt ${attempt}/${maxScreenshotAttempts} (${uploadErr.message}). Retrying...`
            );
            verifiedCount = 0;
            await session.sleep(plan.stepDelayMs);
            continue;
          }

          const postCheck = await session.evaluate(domInspectLocaleListing, null, expectedScreenshots);
          if (!postCheck || typeof postCheck.screenshotCount !== 'number') {
            verifiedCount = expectedScreenshots;
            break;
          }

          verifiedCount = postCheck.screenshotCount;
          const countOk = plan.keepExistingScreenshots
            ? verifiedCount >= expectedScreenshots
            : verifiedCount === expectedScreenshots;

          if (countOk) {
            break;
          }

          if (attempt < maxScreenshotAttempts) {
            logger.log(
              `[CWS Assets] Locale "${lp.locale}": localized screenshots count is ${verifiedCount}/${expectedScreenshots} after upload (attempt ${attempt}/${maxScreenshotAttempts}). Retrying...`
            );
            await session.sleep(plan.stepDelayMs);
          } else {
            throw new Error(
              `Failed to verify localized screenshots for locale "${lp.locale}" after ${maxScreenshotAttempts} attempts: expected ${expectedScreenshots} screenshot(s), but found ${verifiedCount}.`
            );
          }
        }

        screenshotsUploaded = expectedScreenshots;
        totalScreenshotsUploaded += screenshotsUploaded;
      }

      let bannerUploaded = false;
      if (!plan.skipBanner && lp.promoBannerFile) {
        // Upload promo banner on primary/en locale, ja locale (localized banner), or first locale in custom subset
        if (lp.locale === 'en' || lp.locale === 'ja' || !bannerUploadedGlobal) {
          try {
            await session.uploadFilesToInput(domFindAssetFileInput, ['banner'], [lp.promoBannerFile]);
            bannerUploaded = true;
            bannerUploadedGlobal = true;
            totalBannersUploaded++;
            await session.sleep(plan.stepDelayMs);
          } catch (err) {
            // If Small Promo Tile is global-only and only editable on the primary locale, log and continue on secondary locales
            if (!bannerUploadedGlobal && idx === 0) {
              throw err;
            }
          }
        }
      }

      // Re-verify Detailed Description before clicking Save Draft in case an async locale load
      // or media upload re-render reset the textarea.
      if (!plan.skipDescriptions) {
        const reDescRes = await session.evaluate(domFillDetailedDescription, lp.detailedDescription);
        if (!reDescRes || !reDescRes.updated) {
          throw new Error(
            `Failed to verify Detailed Description before saving draft for locale "${lp.locale}": ${reDescRes?.reason || 'unknown error'}`
          );
        }
      }

      const saveRes = await session.evaluate(domClickSaveDraft);
      if (saveRes && saveRes.clicked) {
        await session.sleep(plan.stepDelayMs);
      }

      results.push({
        locale: lp.locale,
        languageLabel: selResult.label,
        descriptionUpdated,
        screenshotsUploaded,
        bannerUploaded,
        draftSaved: Boolean(saveRes?.clicked)
      });
    }

    logger.log(
      `[CWS Assets] Completed ${results.length} locale(s): ` +
      `${totalDescriptionsUpdated} detailed description(s), ` +
      `${totalScreenshotsUploaded} screenshot(s), ` +
      `${totalBannersUploaded} promo banner(s).`
    );

    return {
      dryRun: false,
      extensionId: plan.extensionId,
      localesProcessed: results.map((r) => r.locale),
      totalDescriptionsUpdated,
      totalScreenshotsUploaded,
      totalBannersUploaded,
      results
    };
  } finally {
    if (!deps.browserSession) {
      await session.close();
    }
  }
}

function printHelp(logger = console) {
  logger.log(`Usage:
  node scripts/cws-upload-assets.js [options]
  npm run cws:assets -- [options]

Automates populating Chrome Web Store Developer Dashboard "Store listing" across all 35 locales:
  1. Detailed Description (詳細な説明文) for all 35 languages (from scripts/cws-store-listings.json)
  2. Localized Screenshots (35 languages × 2 PNGs, 1280×800) (from images/notispam-cleaner_screen-{1,2}_<locale>.png)
  3. Small Promo Tile Banner (440×280) (from images/notispam-cleaner_banner_en.png & notispam-cleaner_banner.png)

Options:
  --verify                      Read-only inspection of Detailed Descriptions and Localized Screenshots across target locales
  --dry-run                     Validate all 35 descriptions and 72 PNG assets without launching a browser
  --locales <loc1,loc2,...>     Process only specific locales (default: all 35 locales)
  --publisher-id <id>           Chrome Web Store Publisher ID (or CWS_PUBLISHER_ID env var)
  --extension-id <id>           Chrome Extension ID (defaults to ${DEFAULT_EXTENSION_ID})
  --listings-path <path>        Path to store listings JSON (default: ${DEFAULT_LISTINGS_PATH})
  --images-dir <dir>            Path to directory containing screenshot/banner PNGs (default: ${DEFAULT_IMAGES_DIR})
  --skip-descriptions           Skip filling/verifying Detailed Description text
  --skip-screenshots            Skip uploading/verifying localized screenshots
  --skip-banner                 Skip uploading Small Promo Tile banner
  --keep-existing-screenshots   Do not clear existing screenshots before uploading
  --cdp-url <http://host:port>  Connect to an already-running Chrome instance with --remote-debugging-port
  --debugging-port <port>       Remote debugging port when launching Chrome (default: 9222)
  --user-data-dir <dir>         Persistent browser profile dir (default: ${DEFAULT_USER_DATA_DIR})
  --browser-path <path>         Path to Chrome/Chromium executable (or CHROME_BIN env var)
  --headless                    Run browser in headless mode
  --login-timeout <ms>          Max wait time for manual Google sign-in (default: 300000)
  --step-delay <ms>             Wait time between UI steps in ms (default: 600)
  --help, -h                    Show this help message`);
}

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp(deps.logger || console);
    return;
  }
  const res = await uploadStoreListingAssets(opts, env, deps);
  if (res && res.verify && !res.allOk) {
    process.exitCode = 1;
  }
  return res;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[CWS Assets Error] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_EXTENSION_ID,
  CWS_DEVCONSOLE_BASE,
  DEFAULT_LISTINGS_PATH,
  DEFAULT_IMAGES_DIR,
  DEFAULT_LOCALES_DIR,
  DEFAULT_USER_DATA_DIR,
  SCREENSHOT_WIDTH,
  SCREENSHOT_HEIGHT,
  BANNER_WIDTH,
  BANNER_HEIGHT,
  MAX_DETAILED_DESC_LENGTH,
  MIN_DETAILED_DESC_LENGTH,
  parseArgs,
  loadStoreListings,
  validatePngAsset,
  buildUploadPlan,
  resolveBrowserExecutable,
  createCdpBrowserSession,
  domSelectLocale,
  domFillDetailedDescription,
  domConfirmDeleteDialog,
  domClearExistingScreenshots,
  domFindAssetFileInput,
  domClickSaveDraft,
  domInspectLocaleListing,
  ensureStoreListingPageReady,
  verifyStoreListingAssets,
  uploadStoreListingAssets,
  printHelp,
  main
};
