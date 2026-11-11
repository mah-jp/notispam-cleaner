const fs = require('node:fs');
const path = require('node:path');

const EXT_DIR = path.resolve(__dirname, '../../chrome_extension');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const EN_MESSAGES = JSON.parse(fs.readFileSync(path.join(EXT_DIR, '_locales/en/messages.json'), 'utf8'));

const VALID_SETTINGS = new Set(['allow', 'block', 'ask']);

function parseUrlTarget(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new Error(`Invalid primaryUrl: ${urlStr}`);
  }
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    throw new Error(`Invalid primaryUrl: ${urlStr}`);
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error(`Unsupported scheme in primaryUrl: ${urlStr}`);
  }
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  const defaultPort = scheme === 'http' ? '80' : '443';
  const port = u.port || defaultPort;
  return { scheme, host, port };
}

function isValidPortNum(portStr) {
  if (!/^\d+$/.test(portStr)) return false;
  const n = Number(portStr);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isValidPatternHostname(host, isIpv6 = false) {
  if (!host || typeof host !== 'string') return false;
  if (isIpv6) {
    if (!host.startsWith('[') || !host.endsWith(']')) return false;
    const inner = host.slice(1, -1);
    if (inner.length <= 1 || !inner.includes(':') || !/^[0-9a-f:.]+$/i.test(inner)) {
      return false;
    }
    try {
      const u = new URL(`http://${host}`);
      return Boolean(u.hostname && u.hostname.startsWith('['));
    } catch (e) {
      return false;
    }
  }
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  if (/[\s/\\?#@<>'"`[\]:*%]/.test(host)) return false;
  const labels = host.split('.');
  if (labels.some(l => !l || l.startsWith('-') || l.endsWith('-'))) return false;
  try {
    const u = new URL(`http://${host}`);
    return Boolean(u.hostname);
  } catch (e) {
    return false;
  }
}

/**
 * Parse a Chromium ContentSettingsPattern (or browser origin rule).
 * - Extension patterns (`mode = 'extension'`): omitted port or `:*` is a port wildcard matching all ports
 *   on that scheme+host; redundant default ports (`https://...:443/*`, `http://...:80/*`) are rejected.
 * - Browser permission rules (`mode = 'browser'`): origin-scoped permissions granted by the browser
 *   (`Notification.requestPermission()`) bind to a concrete port (defaulting to 80 for http, 443 for https
 *   unless `:*` is explicitly passed).
 */
function parseContentSettingsPattern(pattern, mode = 'extension') {
  if (!pattern || typeof pattern !== 'string') {
    throw new Error('Missing primaryPattern');
  }
  const trimmed = pattern.trim();
  if (trimmed === '<all_urls>') {
    return {
      key: '<all_urls>',
      isAllUrls: true,
      scheme: '*',
      host: '*',
      domainWildcard: true,
      port: '*'
    };
  }

  const m = trimmed.match(/^(\*|https?):\/\/([^/]+)\/\*$/i);
  if (!m) {
    throw new Error(`Invalid contentSettings pattern: ${pattern}`);
  }

  const scheme = m[1].toLowerCase();
  let authority = m[2];
  let domainWildcard = false;

  if (authority === '*') {
    return {
      key: `${scheme}://*/*`,
      isAllUrls: false,
      scheme,
      host: '*',
      domainWildcard: true,
      port: '*'
    };
  }

  if (authority.startsWith('[*.]')) {
    domainWildcard = true;
    authority = authority.slice(4);
  }

  let host = '';
  let portSpec = '';
  let isIpv6 = false;

  if (authority.startsWith('[')) {
    if (domainWildcard) {
      throw new Error(`Invalid domain wildcard with IPv6 literal: ${pattern}`);
    }
    const closeIdx = authority.indexOf(']');
    if (closeIdx === -1) {
      throw new Error(`Invalid IPv6 host in pattern: ${pattern}`);
    }
    host = authority.slice(0, closeIdx + 1).toLowerCase();
    isIpv6 = true;
    const rest = authority.slice(closeIdx + 1);
    if (rest.startsWith(':')) {
      portSpec = rest.slice(1);
    } else if (rest) {
      throw new Error(`Invalid primaryPattern (authority): ${pattern}`);
    }
  } else {
    const colonIdx = authority.indexOf(':');
    if (colonIdx !== -1) {
      host = authority.slice(0, colonIdx).toLowerCase().replace(/\.+$/, '');
      portSpec = authority.slice(colonIdx + 1);
    } else {
      host = authority.toLowerCase().replace(/\.+$/, '');
    }
  }

  if (!isValidPatternHostname(host, isIpv6)) {
    throw new Error(`Invalid primaryPattern (host): ${pattern}`);
  }

  let port = '*';
  if (mode === 'extension') {
    if (portSpec === '' || portSpec === '*') {
      port = '*';
    } else if (isValidPortNum(portSpec)) {
      if ((scheme === 'https' && portSpec === '443') || (scheme === 'http' && portSpec === '80')) {
        throw new Error(`Invalid pattern with redundant default port: ${pattern}`);
      }
      port = portSpec;
    } else {
      throw new Error(`Invalid port in pattern: ${pattern}`);
    }
  } else {
    // Browser-native origin permission
    if (portSpec === '*') {
      port = '*';
    } else if (portSpec === '') {
      if (scheme === 'http') port = '80';
      else if (scheme === 'https') port = '443';
      else port = '*';
    } else if (isValidPortNum(portSpec)) {
      port = portSpec;
    } else {
      throw new Error(`Invalid port in browser rule: ${pattern}`);
    }
  }

  const key = `${scheme}://${domainWildcard ? '[*.]' : ''}${host}:${port}/*`;
  return {
    key,
    isAllUrls: false,
    scheme,
    host,
    domainWildcard,
    port
  };
}

/**
 * Compare two parsed ContentSettingsPatterns by Chromium's exact precedence order
 * (`ContentSettingsPattern::Compare` in `components/content_settings/core/common/content_settings_pattern.cc`):
 * 1. Host specificity: exact host > `[*.]domain` (more labels / longer host wins) > `*` > `<all_urls>`
 * 2. Scheme specificity: explicit scheme (`http`/`https`) > wildcard scheme (`*`)
 * 3. Port specificity: explicit port > wildcard port (`*`)
 * Returns > 0 if `a` is more specific than `b`, < 0 if less specific, 0 if equal specificity.
 */
function comparePatternPrecedence(a, b) {
  const hostRank = (p) => {
    if (p.isAllUrls) return 0;
    if (p.host === '*') return 1;
    return p.domainWildcard ? 2 : 3;
  };
  const hrA = hostRank(a);
  const hrB = hostRank(b);
  if (hrA !== hrB) return hrA - hrB;

  if (hrA === 2) {
    const labelsA = a.host.split('.').length;
    const labelsB = b.host.split('.').length;
    if (labelsA !== labelsB) return labelsA - labelsB;
    if (a.host.length !== b.host.length) return a.host.length - b.host.length;
  }

  const schemeRankA = a.scheme === '*' ? 0 : 1;
  const schemeRankB = b.scheme === '*' ? 0 : 1;
  if (schemeRankA !== schemeRankB) return schemeRankA - schemeRankB;

  const portRankA = a.port === '*' ? 0 : 1;
  const portRankB = b.port === '*' ? 0 : 1;
  return portRankA - portRankB;
}

function patternMatchesTarget(parsedRule, target) {
  if (parsedRule.isAllUrls) return true;
  if (parsedRule.scheme !== '*' && parsedRule.scheme !== target.scheme) {
    return false;
  }
  if (parsedRule.host !== '*') {
    if (parsedRule.domainWildcard) {
      if (target.host !== parsedRule.host && !target.host.endsWith('.' + parsedRule.host)) {
        return false;
      }
    } else if (target.host !== parsedRule.host) {
      return false;
    }
  }
  if (parsedRule.port !== '*' && parsedRule.port !== target.port) {
    return false;
  }
  return true;
}

function findMostSpecificMatch(ruleMap, target) {
  let bestEntry = null;
  for (const entry of ruleMap.values()) {
    if (patternMatchesTarget(entry.parsed, target)) {
      if (!bestEntry || comparePatternPrecedence(entry.parsed, bestEntry.parsed) >= 0) {
        bestEntry = entry;
      }
    }
  }
  return bestEntry ? bestEntry.setting : null;
}

function createChromeMock(options = {}) {
  const localeMessages = options.messages || EN_MESSAGES;
  const storageState = { ...(options.initialStorage || {}) };

  // Browser-native notification rules (PREF_PROVIDER — not cleared by extension's notifications.clear)
  const browserRules = new Map();
  let browserGlobalDefault = options.browserGlobalDefault || 'ask';

  // Extension-scoped notification rules (CUSTOM_EXTENSION_PROVIDER — cleared by notifications.clear)
  const extensionRules = new Map();
  let extensionGlobalDefault = null;

  const historyItems = [...(options.historyItems || [])];
  const bookmarkTree = options.bookmarkTree || [{ id: '0', title: 'root', children: [] }];
  const openTabs = [...(options.tabs || [])];

  const createdNotifications = new Map();
  const createdTabs = [];
  const sentMessages = [];
  const iconCalls = [];
  let badgeText = '';
  let badgeColor = '';

  const listeners = {
    onMessage: [],
    onInstalled: [],
    onStartup: [],
    onButtonClicked: [],
    onActivated: [],
    onUpdated: [],
    onStorageChanged: []
  };

  const chromeMock = {
    _state: {
      storageState,
      browserRules,
      extensionRules,
      getBrowserGlobalDefault: () => browserGlobalDefault,
      setBrowserGlobalDefault: (val) => {
        if (!VALID_SETTINGS.has(val)) throw new Error(`Invalid setting: ${val}`);
        browserGlobalDefault = val;
      },
      setBrowserRule: (originPattern, setting) => {
        if (!VALID_SETTINGS.has(setting)) throw new Error(`Invalid setting: ${setting}`);
        const parsed = parseContentSettingsPattern(originPattern, 'browser');
        browserRules.set(parsed.key, { parsed, setting });
      },
      deleteBrowserRule: (originPattern) => {
        const parsed = parseContentSettingsPattern(originPattern, 'browser');
        browserRules.delete(parsed.key);
      },
      historyItems,
      bookmarkTree,
      openTabs,
      createdNotifications,
      createdTabs,
      sentMessages,
      iconCalls,
      getBadgeText: () => badgeText,
      getBadgeColor: () => badgeColor,
      listeners
    },

    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ ...MANIFEST }),
      sendMessage: async (msg) => {
        sentMessages.push(msg);
        for (const fn of listeners.onMessage) {
          await fn(msg, { id: 'test-extension-id' }, () => {});
        }
      },
      onMessage: {
        addListener: (fn) => {
          listeners.onMessage.push(fn);
        }
      },
      onInstalled: {
        addListener: (fn) => {
          listeners.onInstalled.push(fn);
        }
      },
      onStartup: {
        addListener: (fn) => {
          listeners.onStartup.push(fn);
        }
      }
    },

    i18n: {
      getUILanguage: () => options.uiLanguage || 'en',
      getMessage: (key, substitutions) => {
        if (key === '@@bidi_dir') {
          if (options.bidiDir) return options.bidiDir;
          const lang = String(options.uiLanguage || 'en').split(/[-_]/)[0].toLowerCase();
          return ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi'].includes(lang) ? 'rtl' : 'ltr';
        }
        const entry = localeMessages[key];
        if (!entry || !entry.message) return '';
        let msg = entry.message;
        if (substitutions !== undefined) {
          const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
          if (entry.placeholders) {
            for (const [phName, phDef] of Object.entries(entry.placeholders)) {
              const idxMatch = phDef.content && phDef.content.match(/^\$(\d+)$/);
              if (idxMatch) {
                const idx = parseInt(idxMatch[1], 10) - 1;
                const val = subs[idx] !== undefined ? String(subs[idx]) : '';
                msg = msg.replace(new RegExp(`\\$${phName}\\$`, 'gi'), val);
              }
            }
          }
          subs.forEach((s, i) => {
            msg = msg.replace(new RegExp(`\\$${i + 1}`, 'g'), String(s));
          });
        }
        return msg;
      }
    },

    storage: {
      local: {
        get: async (defaults) => {
          if (defaults === null || defaults === undefined) {
            return JSON.parse(JSON.stringify(storageState));
          }
          if (typeof defaults === 'string') {
            return { [defaults]: storageState[defaults] !== undefined ? JSON.parse(JSON.stringify(storageState[defaults])) : undefined };
          }
          if (Array.isArray(defaults)) {
            const res = {};
            for (const k of defaults) {
              if (storageState[k] !== undefined) {
                res[k] = JSON.parse(JSON.stringify(storageState[k]));
              }
            }
            return res;
          }
          const res = {};
          for (const [k, defVal] of Object.entries(defaults)) {
            res[k] = storageState[k] !== undefined
              ? JSON.parse(JSON.stringify(storageState[k]))
              : JSON.parse(JSON.stringify(defVal));
          }
          return res;
        },
        set: async (items) => {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            const hasOld = Object.prototype.hasOwnProperty.call(storageState, k);
            const oldVal = hasOld ? JSON.parse(JSON.stringify(storageState[k])) : undefined;
            const newVal = JSON.parse(JSON.stringify(v));
            storageState[k] = newVal;
            if (!hasOld || JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
              changes[k] = {
                ...(hasOld ? { oldValue: oldVal } : {}),
                newValue: JSON.parse(JSON.stringify(newVal))
              };
            }
          }
          if (Object.keys(changes).length > 0) {
            for (const fn of listeners.onStorageChanged) {
              await fn(changes, 'local');
            }
          }
        },
        remove: async (keys) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of keyList) {
            if (Object.prototype.hasOwnProperty.call(storageState, k)) {
              changes[k] = {
                oldValue: JSON.parse(JSON.stringify(storageState[k]))
              };
              delete storageState[k];
            }
          }
          if (Object.keys(changes).length > 0) {
            for (const fn of listeners.onStorageChanged) {
              await fn(changes, 'local');
            }
          }
        },
        clear: async () => {
          const changes = {};
          for (const k of Object.keys(storageState)) {
            changes[k] = { oldValue: JSON.parse(JSON.stringify(storageState[k])) };
            delete storageState[k];
          }
          if (Object.keys(changes).length > 0) {
            for (const fn of listeners.onStorageChanged) {
              await fn(changes, 'local');
            }
          }
        }
      },
      onChanged: {
        addListener: (fn) => {
          listeners.onStorageChanged.push(fn);
        }
      }
    },

    contentSettings: {
      notifications: {
        get: async ({ primaryUrl }) => {
          const target = parseUrlTarget(primaryUrl);
          // 1. CUSTOM_EXTENSION_PROVIDER: site-specific rules by specificity, then <all_urls>
          const extMatch = findMostSpecificMatch(extensionRules, target);
          if (extMatch !== null) {
            return { setting: extMatch };
          }
          if (extensionGlobalDefault !== null) {
            return { setting: extensionGlobalDefault };
          }
          // 2. PREF_PROVIDER: browser-native per-origin rules by specificity
          const browserMatch = findMostSpecificMatch(browserRules, target);
          if (browserMatch !== null) {
            return { setting: browserMatch };
          }
          // 3. DEFAULT_PROVIDER: browser global default
          return { setting: browserGlobalDefault };
        },
        set: async ({ primaryPattern, setting }) => {
          if (!VALID_SETTINGS.has(setting)) {
            throw new Error(`Invalid notification setting: ${setting}`);
          }
          const parsed = parseContentSettingsPattern(primaryPattern, 'extension');
          if (parsed.isAllUrls) {
            extensionGlobalDefault = setting;
            return;
          }
          extensionRules.set(parsed.key, { parsed, setting });
        },
        clear: async () => {
          extensionRules.clear();
          extensionGlobalDefault = null;
        }
      }
    },

    history: {
      search: async (query) => {
        if (!query || typeof query !== 'object' || typeof query.text !== 'string') {
          throw new TypeError('chrome.history.search requires { text: string }');
        }
        const needle = query.text.toLowerCase();
        let results = historyItems.filter((item) => {
          if (!needle) return true;
          const url = String(item.url || '').toLowerCase();
          const title = String(item.title || '').toLowerCase();
          return url.includes(needle) || title.includes(needle);
        });
        if (typeof query.maxResults === 'number' && query.maxResults >= 0) {
          results = results.slice(0, query.maxResults);
        }
        return results.map(item => ({ ...item }));
      }
    },

    bookmarks: {
      getTree: async () => JSON.parse(JSON.stringify(bookmarkTree))
    },

    tabs: {
      query: async (queryInfo = {}) => {
        return openTabs.filter(t => {
          if (queryInfo.active !== undefined && Boolean(t.active) !== Boolean(queryInfo.active)) {
            return false;
          }
          if (queryInfo.currentWindow !== undefined && queryInfo.currentWindow && t.windowId !== undefined && t.windowId !== 1) {
            return false;
          }
          return true;
        });
      },
      get: async (tabId) => {
        const found = openTabs.find(t => t.id === tabId);
        if (!found) throw new Error(`No tab with id: ${tabId}`);
        return found;
      },
      create: async (createProps) => {
        createdTabs.push(createProps);
        return { id: createdTabs.length + 100, ...createProps };
      },
      onActivated: {
        addListener: (fn) => {
          listeners.onActivated.push(fn);
        }
      },
      onUpdated: {
        addListener: (fn) => {
          listeners.onUpdated.push(fn);
        }
      }
    },

    notifications: {
      create: async (id, options) => {
        const notifId = id || `notif-${Date.now()}`;
        createdNotifications.set(notifId, options);
        return notifId;
      },
      clear: async (id) => {
        const existed = createdNotifications.has(id);
        createdNotifications.delete(id);
        return existed;
      },
      onButtonClicked: {
        addListener: (fn) => {
          listeners.onButtonClicked.push(fn);
        }
      }
    },

    action: {
      setBadgeText: async ({ text }) => {
        badgeText = text;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        badgeColor = color;
      },
      setIcon: async (details) => {
        iconCalls.push(details);
      }
    }
  };

  return chromeMock;
}

module.exports = {
  createChromeMock,
  parseContentSettingsPattern,
  comparePatternPrecedence,
  parseUrlTarget,
  EXT_DIR,
  MANIFEST,
  EN_MESSAGES
};
