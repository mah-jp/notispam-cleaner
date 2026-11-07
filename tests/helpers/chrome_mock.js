const fs = require('node:fs');
const path = require('node:path');

const EXT_DIR = path.resolve(__dirname, '../../chrome_extension');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const EN_MESSAGES = JSON.parse(fs.readFileSync(path.join(EXT_DIR, '_locales/en/messages.json'), 'utf8'));

function patternToOriginKey(pattern) {
  if (!pattern || pattern === '<all_urls>') return '<all_urls>';
  let clean = pattern.trim();
  if (clean.endsWith('/*')) {
    clean = clean.slice(0, -2);
  } else if (clean.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  return clean.toLowerCase();
}

function urlToOriginKey(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.protocol}//${u.hostname.toLowerCase()}`;
  } catch (e) {
    return urlStr.replace(/\/+$/, '').toLowerCase();
  }
}

function createChromeMock(options = {}) {
  const localeMessages = options.messages || EN_MESSAGES;
  const storageState = { ...(options.initialStorage || {}) };

  // Browser-native notification rules (not cleared by extension's notifications.clear)
  const browserRules = new Map();
  let browserGlobalDefault = options.browserGlobalDefault || 'ask';

  // Extension-scoped notification rules (cleared by notifications.clear)
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
    onButtonClicked: [],
    onActivated: [],
    onUpdated: []
  };

  const chromeMock = {
    _state: {
      storageState,
      browserRules,
      extensionRules,
      getBrowserGlobalDefault: () => browserGlobalDefault,
      setBrowserGlobalDefault: (val) => { browserGlobalDefault = val; },
      setBrowserRule: (originPattern, setting) => {
        browserRules.set(patternToOriginKey(originPattern), setting);
      },
      deleteBrowserRule: (originPattern) => {
        browserRules.delete(patternToOriginKey(originPattern));
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
          for (const [k, v] of Object.entries(items)) {
            storageState[k] = JSON.parse(JSON.stringify(v));
          }
        },
        clear: async () => {
          for (const k of Object.keys(storageState)) {
            delete storageState[k];
          }
        }
      }
    },

    contentSettings: {
      notifications: {
        get: async ({ primaryUrl }) => {
          const key = urlToOriginKey(primaryUrl);
          if (extensionRules.has(key)) {
            return { setting: extensionRules.get(key) };
          }
          if (browserRules.has(key)) {
            return { setting: browserRules.get(key) };
          }
          if (extensionGlobalDefault !== null) {
            return { setting: extensionGlobalDefault };
          }
          return { setting: browserGlobalDefault };
        },
        set: async ({ primaryPattern, setting }) => {
          if (!primaryPattern) throw new Error('Missing primaryPattern');
          if (primaryPattern === '<all_urls>') {
            extensionGlobalDefault = setting;
            return;
          }
          // Chrome rejects explicit standard ports in http/https contentSettings patterns
          if (/^https?:\/\/[^/]+:\d+\//.test(primaryPattern)) {
            throw new Error(`Invalid pattern with port: ${primaryPattern}`);
          }
          const key = patternToOriginKey(primaryPattern);
          extensionRules.set(key, setting);
        },
        clear: async () => {
          extensionRules.clear();
          extensionGlobalDefault = null;
        }
      }
    },

    history: {
      search: async () => [...historyItems]
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
  EXT_DIR,
  MANIFEST,
  EN_MESSAGES
};
