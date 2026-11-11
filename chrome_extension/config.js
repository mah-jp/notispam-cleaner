// Built-in list of trusted domains that commonly send notifications legitimately.
const TRUSTED_DOMAINS = [
  // Search, Infrastructure & Information
  'google.com', 'yahoo.com', 'yahoo.co.jp', 'wikipedia.org',

  // Email & Personal Infrastructure
  'gmail.com', 'outlook.com', 'proton.me', 'protonmail.com', 'live.com', 'icloud.com',

  // Social Media & Messaging
  'facebook.com', 'instagram.com', 'messenger.com', 'twitter.com', 'x.com',
  'linkedin.com', 'whatsapp.com', 'telegram.org', 'line.me', 'discord.com',

  // Collaboration & Business Tools
  'microsoft.com', 'office.com', 'office365.com', 'slack.com', 'zoom.us', 'zoom.com',
  'webex.com', 'asana.com', 'trello.com', 'notion.so', 'monday.com',

  // Developer Tools & Platforms
  'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net',

  // E-commerce & Entertainment
  'amazon.com', 'amazon.co.jp', 'apple.com', 'netflix.com', 'youtube.com'
];

const GLOBAL_DEFAULT_PROBE_URL = 'https://nonexistent-dummy-domain-check-notification-default.com/';

// In-memory map of normalized "hostname:port" -> "http" | "https"
const knownDomainProtocols = new Map();

// Validate TCP port string (1..65535)
function isValidPort(portStr) {
  if (!portStr || !/^\d+$/.test(portStr)) return false;
  const portNum = Number(portStr);
  return Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
}

// Validate clean hostname (IPv6 bracket literal or standard hostname without path/whitespace/invalid chars)
function isValidHostname(host) {
  if (!host || typeof host !== 'string') return false;
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return false;
    const inner = host.slice(1, -1);
    if (
      inner.length <= 1 ||
      !inner.includes(':') ||
      inner.startsWith('.') ||
      inner.endsWith('.') ||
      !/^[0-9a-f:.]+$/i.test(inner)
    ) {
      return false;
    }
    try {
      const parsed = new URL(`http://${host}`);
      return Boolean(parsed.hostname && parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']'));
    } catch (e) {
      return false;
    }
  }
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false;
  if (/[\s/\\?#@<>'"`[\]:*%]/.test(host)) return false;
  const labels = host.split('.');
  if (labels.some(label => !label || label.startsWith('-') || label.endsWith('-'))) {
    return false;
  }
  try {
    const parsed = new URL(`http://${host}`);
    return Boolean(parsed.hostname);
  } catch (e) {
    return false;
  }
}

// Normalize a domain (with optional port) to lowercase and strip trailing dots on hostname
function normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') return '';
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return '';

  // Handle IPv6 with port (e.g., "[::1]:8080") or without port (e.g., "[::1]")
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return '';
    const ipv6Host = trimmed.substring(0, closeIdx + 1);
    if (!isValidHostname(ipv6Host)) return '';
    const rest = trimmed.substring(closeIdx + 1);
    if (!rest) return ipv6Host;
    if (rest.startsWith(':')) {
      const port = rest.substring(1);
      return isValidPort(port) ? `${ipv6Host}:${port}` : '';
    }
    return '';
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    const cleanHost = trimmed.replace(/\.+$/, '');
    return isValidHostname(cleanHost) ? cleanHost : '';
  }

  const host = trimmed.substring(0, colonIdx).replace(/\.+$/, '');
  const port = trimmed.substring(colonIdx + 1);
  if (!isValidHostname(host)) return '';
  if (!port) return host;
  if (!isValidPort(port)) return '';
  return `${host}:${port}`;
}

// Extract clean hostname without port suffix (e.g., "Example.com:443" -> "example.com")
function getCleanHostname(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  if (normalized.startsWith('[')) {
    const closeIdx = normalized.indexOf(']');
    return closeIdx === -1 ? '' : normalized.substring(0, closeIdx + 1);
  }
  return normalized.split(':')[0];
}

// Extract explicit port string from normalized domain if present, otherwise empty string
function getPortFromDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  if (normalized.startsWith('[')) {
    const closeIdx = normalized.indexOf(']');
    if (closeIdx === -1) return '';
    const rest = normalized.substring(closeIdx + 1);
    return rest.startsWith(':') ? rest.substring(1) : '';
  }
  const colonIdx = normalized.indexOf(':');
  return colonIdx === -1 ? '' : normalized.substring(colonIdx + 1);
}

// Record the protocol ('http' or 'https') observed for a normalized domain:port
function rememberDomainProtocol(domain, protocol) {
  const normalized = normalizeDomain(domain);
  if (!normalized || !protocol) return;
  const cleanProto = String(protocol).toLowerCase().replace(/:$/, '');
  if (cleanProto === 'http' || cleanProto === 'https') {
    knownDomainProtocols.set(normalized, cleanProto);
  }
}

// Sync protocol map from storage object into in-memory lookup table
function syncDomainProtocols(protocolsMap) {
  if (!protocolsMap || typeof protocolsMap !== 'object') return;
  for (const [domain, proto] of Object.entries(protocolsMap)) {
    rememberDomainProtocol(domain, proto);
  }
}

// Clear in-memory protocol cache (useful for isolated tests / cold-start simulation)
function clearKnownDomainProtocols() {
  knownDomainProtocols.clear();
}

// Determine protocol ('http' or 'https') from a domain:port string
function getProtocolForDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return 'https';
  if (knownDomainProtocols.has(normalized)) {
    return knownDomainProtocols.get(normalized);
  }
  return normalized.endsWith(':80') ? 'http' : 'https';
}

// Build primaryPattern for chrome.contentSettings.notifications.set (port omitted = wildcard across ports)
function getPrimaryPatternForDomain(domain) {
  const cleanHost = getCleanHostname(domain);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(domain);
  return `${protocol}://${cleanHost}/*`;
}

// Build self-contained pattern including explicit port (for lossless round-tripping in notification IDs)
function getPatternWithPortForDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  const cleanHost = getCleanHostname(normalized);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(normalized);
  const port = getPortFromDomain(normalized) || (protocol === 'http' ? '80' : '443');
  return `${protocol}://${cleanHost}:${port}/*`;
}

// Build canonical origin URL for chrome.contentSettings.notifications.get
// Standard ports (:80 for http, :443 for https) are omitted; non-standard ports are preserved so
// browser-granted origin permissions on custom ports (e.g., :3000, :8080, :8443) are accurately queried.
function getPrimaryUrlForDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  const cleanHost = getCleanHostname(normalized);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(normalized);
  const port = getPortFromDomain(normalized);
  const defaultPort = protocol === 'http' ? '80' : '443';
  const portSuffix = port && port !== defaultPort ? `:${port}` : '';
  return `${protocol}://${cleanHost}${portSuffix}/`;
}

// Build Chrome native site details settings URL for a domain
function getSiteDetailsUrl(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return 'chrome://settings/content/notifications';
  const protocol = getProtocolForDomain(normalized);
  return `chrome://settings/content/siteDetails?site=${encodeURIComponent(`${protocol}://${normalized}`)}`;
}

// Helper to check if a domain is in the built-in or user whitelists
function isDomainTrusted(domain, userWhitelist = []) {
  const cleanDomain = getCleanHostname(domain);
  if (!cleanDomain) return false;

  // Check user whitelist
  if (Array.isArray(userWhitelist) && userWhitelist.some(d => {
    const cleanD = getCleanHostname(d);
    if (!cleanD) return false;
    return cleanDomain === cleanD || cleanDomain.endsWith('.' + cleanD);
  })) {
    return true;
  }

  // Check built-in whitelist
  return TRUSTED_DOMAINS.some(d => cleanDomain === d || cleanDomain.endsWith('.' + d));
}

// Normalize and deduplicate an array of domain strings while preserving order
function normalizeDomainList(domains) {
  if (!Array.isArray(domains)) return [];
  const seen = new Set();
  const result = [];
  for (const item of domains) {
    const clean = normalizeDomain(item);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

// Check whether a domain matches any entry in domainList either by exact normalized domain:port
// or by identical extension contentSettings primaryPattern (scheme + host port-wildcard).
function matchesDomainRuleList(domain, domainList) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain || !Array.isArray(domainList) || domainList.length === 0) return false;
  const targetPattern = getPrimaryPatternForDomain(cleanDomain);
  return domainList.some((entry) => {
    const cleanEntry = normalizeDomain(entry);
    if (!cleanEntry) return false;
    if (cleanEntry === cleanDomain) return true;
    return Boolean(targetPattern && getPrimaryPatternForDomain(cleanEntry) === targetPattern);
  });
}

// Build a clean domain_protocols map retaining only active blocked/whitelisted HTTP custom-port domains
function buildPrunedDomainProtocols(rawProtocols, blockedList, whitelist) {
  syncDomainProtocols(rawProtocols);
  const retained = new Set([
    ...normalizeDomainList(blockedList),
    ...normalizeDomainList(whitelist)
  ]);
  const nextProtocols = {};
  for (const d of retained) {
    if (!d.endsWith(':80') && getProtocolForDomain(d) === 'http') {
      nextProtocols[d] = 'http';
    }
  }
  return nextProtocols;
}

function shallowEqualStringMap(a, b) {
  const aObj = a && typeof a === 'object' ? a : {};
  const bObj = b && typeof b === 'object' ? b : {};
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(k => aObj[k] === bObj[k]);
}

// Serialization queue for storage read-modify-write operations to prevent lost updates
let storageQueue = Promise.resolve();

function enqueueStorageOp(op) {
  const next = storageQueue.then(() => op());
  storageQueue = next.catch(() => { });
  return next;
}

// Outer serialization queue for contentSettings + storage rule mutations (never called from inside enqueueStorageOp)
let ruleQueue = Promise.resolve();

function enqueueRuleOp(op) {
  const next = ruleQueue.then(() => op());
  ruleQueue = next.catch(() => { });
  return next;
}

// Add a domain to the persistent blocked domains list in local storage
async function addBlockedDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: {} });
    syncDomainProtocols(data.domain_protocols);
    const list = Array.isArray(data.blocked_domains) ? data.blocked_domains.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const whitelist = Array.isArray(data.user_whitelist) ? data.user_whitelist.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const updates = {};
    if (!list.includes(cleanDomain)) {
      list.push(cleanDomain);
      updates.blocked_domains = list;
    }
    const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, list, whitelist);
    if (!shallowEqualStringMap(data.domain_protocols, nextProtocols)) {
      updates.domain_protocols = nextProtocols;
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  });
}

// Remove a domain from the persistent blocked domains list in local storage
async function removeBlockedDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: {} });
    syncDomainProtocols(data.domain_protocols);
    const list = Array.isArray(data.blocked_domains) ? data.blocked_domains : [];
    const whitelist = Array.isArray(data.user_whitelist) ? data.user_whitelist.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const newList = list.map(d => normalizeDomain(d)).filter(d => d && d !== cleanDomain);
    const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, newList, whitelist);
    const updates = { blocked_domains: newList };
    if (!shallowEqualStringMap(data.domain_protocols, nextProtocols)) {
      updates.domain_protocols = nextProtocols;
    }
    await chrome.storage.local.set(updates);
  });
}

// Add a domain to the persistent user whitelist in local storage
async function addWhitelistedDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: {} });
    syncDomainProtocols(data.domain_protocols);
    const blocked = Array.isArray(data.blocked_domains) ? data.blocked_domains.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const list = Array.isArray(data.user_whitelist) ? data.user_whitelist.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const updates = {};
    if (!list.includes(cleanDomain)) {
      list.push(cleanDomain);
      updates.user_whitelist = list;
    }
    const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blocked, list);
    if (!shallowEqualStringMap(data.domain_protocols, nextProtocols)) {
      updates.domain_protocols = nextProtocols;
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
    }
  });
}

// Remove a domain from the persistent user whitelist in local storage
async function removeWhitelistedDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: {} });
    syncDomainProtocols(data.domain_protocols);
    const blocked = Array.isArray(data.blocked_domains) ? data.blocked_domains.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const list = Array.isArray(data.user_whitelist) ? data.user_whitelist : [];
    const newList = list.map(d => normalizeDomain(d)).filter(d => d && d !== cleanDomain);
    const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blocked, newList);
    const updates = { user_whitelist: newList };
    if (!shallowEqualStringMap(data.domain_protocols, nextProtocols)) {
      updates.domain_protocols = nextProtocols;
    }
    await chrome.storage.local.set(updates);
  });
}

// Atomically increment Silent Guardian blocked_count in storage and return the new count
async function incrementBlockedCount() {
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ blocked_count: 0 });
    const newCount = (Number(data.blocked_count) || 0) + 1;
    await chrome.storage.local.set({ blocked_count: newCount });
    return newCount;
  });
}

// Atomically reset Silent Guardian blocked_count to 0 in storage
async function resetBlockedCount() {
  return enqueueStorageOp(async () => {
    await chrome.storage.local.set({ blocked_count: 0 });
    return 0;
  });
}

// Block multiple domains in parallel and atomically record them in a single storage transaction
async function blockAndRecordDomains(domains) {
  const cleanDomains = normalizeDomainList(domains);
  if (cleanDomains.length === 0) return;

  return enqueueRuleOp(async () => {
    const uniquePatterns = Array.from(new Set(
      cleanDomains.map(d => getPrimaryPatternForDomain(d)).filter(Boolean)
    ));
    if (uniquePatterns.length === 0) return;

    await Promise.all(
      uniquePatterns.map(primaryPattern =>
        chrome.contentSettings.notifications.set({
          primaryPattern,
          setting: 'block'
        })
      )
    );

    const patternSet = new Set(uniquePatterns);
    const domainSet = new Set(cleanDomains);

    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      const blockedList = normalizeDomainList([
        ...(Array.isArray(data.blocked_domains) ? data.blocked_domains : []),
        ...cleanDomains
      ]);
      const whitelist = normalizeDomainList(data.user_whitelist).filter(
        d => !domainSet.has(d) && !patternSet.has(getPrimaryPatternForDomain(d))
      );
      const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blockedList, whitelist);
      await chrome.storage.local.set({
        blocked_domains: blockedList,
        user_whitelist: whitelist,
        domain_protocols: nextProtocols
      });
    });
  });
}

// Block a domain and atomically record it in storage (removing any conflicting whitelist entry)
async function blockAndRecordDomain(domain, customPattern = null) {
  if (!customPattern) {
    const cleanOnly = normalizeDomain(domain);
    if (!cleanOnly) return;
    return blockAndRecordDomains([cleanOnly]);
  }

  return enqueueRuleOp(async () => {
    const patternDomain = customPattern ? getDomainFromPattern(customPattern) : '';
    const cleanDomain = normalizeDomain(domain) || patternDomain;
    if (!cleanDomain && !customPattern) return;

    if (customPattern && typeof customPattern === 'string' && cleanDomain) {
      const lowerPattern = customPattern.trim().toLowerCase();
      if (lowerPattern.startsWith('http://')) {
        rememberDomainProtocol(cleanDomain, 'http');
      } else if (lowerPattern.startsWith('https://')) {
        rememberDomainProtocol(cleanDomain, 'https');
      }
    }

    const primaryPattern = customPattern
      ? stripPortFromPattern(customPattern)
      : getPrimaryPatternForDomain(cleanDomain);
    if (!primaryPattern) return;

    await chrome.contentSettings.notifications.set({
      primaryPattern,
      setting: 'block'
    });

    if (cleanDomain) {
      await enqueueStorageOp(async () => {
        const data = await chrome.storage.local.get({
          blocked_domains: [],
          user_whitelist: [],
          domain_protocols: {}
        });
        syncDomainProtocols(data.domain_protocols);
        const blockedList = normalizeDomainList([
          ...(Array.isArray(data.blocked_domains) ? data.blocked_domains : []),
          cleanDomain
        ]);
        const whitelist = normalizeDomainList(data.user_whitelist).filter(
          d => d !== cleanDomain && getPrimaryPatternForDomain(d) !== primaryPattern
        );
        const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blockedList, whitelist);
        await chrome.storage.local.set({
          blocked_domains: blockedList,
          user_whitelist: whitelist,
          domain_protocols: nextProtocols
        });
      });
    }
  });
}

// Trust and allow a domain: atomically updates storage first (avoiding content-script race condition), then sets Chrome permission
async function allowAndTrustDomain(domain, customPattern = null) {
  return enqueueRuleOp(async () => {
    const patternDomain = customPattern ? getDomainFromPattern(customPattern) : '';
    const cleanDomain = normalizeDomain(domain) || patternDomain;
    if (!cleanDomain) return;

    if (customPattern && typeof customPattern === 'string') {
      const lowerPattern = customPattern.trim().toLowerCase();
      if (lowerPattern.startsWith('http://')) {
        rememberDomainProtocol(cleanDomain, 'http');
      } else if (lowerPattern.startsWith('https://')) {
        rememberDomainProtocol(cleanDomain, 'https');
      }
    }

    const primaryPattern = customPattern
      ? stripPortFromPattern(customPattern)
      : getPrimaryPatternForDomain(cleanDomain);

    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      const blockedList = (Array.isArray(data.blocked_domains) ? data.blocked_domains : [])
        .map(d => normalizeDomain(d))
        .filter(d => d && d !== cleanDomain && (!primaryPattern || getPrimaryPatternForDomain(d) !== primaryPattern));
      const whitelist = Array.from(new Set(
        (Array.isArray(data.user_whitelist) ? data.user_whitelist : [])
          .map(d => normalizeDomain(d))
          .filter(Boolean)
      ));
      if (!whitelist.includes(cleanDomain)) {
        whitelist.push(cleanDomain);
      }
      const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blockedList, whitelist);
      await chrome.storage.local.set({
        blocked_domains: blockedList,
        user_whitelist: whitelist,
        domain_protocols: nextProtocols
      });
    });

    if (primaryPattern) {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'allow'
      });
    }
  });
}

// Query the effective global default notification setting ('ask', 'block', or 'allow')
async function getGlobalNotificationDefault() {
  try {
    const details = await chrome.contentSettings.notifications.get({
      primaryUrl: GLOBAL_DEFAULT_PROBE_URL
    });
    return details ? details.setting : 'ask';
  } catch (e) {
    return 'ask';
  }
}

// Set global default notification setting serialized with rule operations.
// Clears <all_urls> first and only sets an extension <all_urls> rule if it differs from
// Chrome's native default, preventing an unnecessary <all_urls> extension rule from
// shadowing browser-native per-site PrefProvider permissions.
async function setGlobalNotificationDefault(setting) {
  return enqueueRuleOp(async () => {
    let blockedList = [];
    let whitelist = [];
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      blockedList = (Array.isArray(data.blocked_domains) ? data.blocked_domains : [])
        .map(d => normalizeDomain(d))
        .filter(Boolean);
      whitelist = (Array.isArray(data.user_whitelist) ? data.user_whitelist : [])
        .map(d => normalizeDomain(d))
        .filter(Boolean);
    });

    await chrome.contentSettings.notifications.clear({});
    await reapplyExtensionRules(blockedList, whitelist, setting);
  });
}

// Re-apply extension rules after clearing chrome.contentSettings.notifications
async function reapplyExtensionRules(blockedDomains, whitelistedDomains, previousGlobalDefault) {
  if (previousGlobalDefault) {
    const currentGlobalDefault = await getGlobalNotificationDefault();
    if (currentGlobalDefault !== previousGlobalDefault) {
      await chrome.contentSettings.notifications.set({
        primaryPattern: '<all_urls>',
        setting: previousGlobalDefault
      });
    }
  }

  const blockPromises = (Array.isArray(blockedDomains) ? blockedDomains : []).map(async (d) => {
    const primaryPattern = getPrimaryPatternForDomain(d);
    if (!primaryPattern) return;
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'block'
      });
    } catch (e) {
      console.error(`Failed to re-block ${d}:`, e);
    }
  });

  const allowPromises = (Array.isArray(whitelistedDomains) ? whitelistedDomains : []).map(async (d) => {
    const primaryPattern = getPrimaryPatternForDomain(d);
    if (!primaryPattern) return;
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'allow'
      });
    } catch (e) {
      console.error(`Failed to re-allow ${d}:`, e);
    }
  });

  await Promise.all([...blockPromises, ...allowPromises]);
}

// Reset notification settings for a single domain to browser default while preserving all other extension rules
async function resetDomainRules(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;

  return enqueueRuleOp(async () => {
    const previousGlobalDefault = await getGlobalNotificationDefault();

    let newBlocked = [];
    let newWhitelist = [];
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      const targetPattern = getPrimaryPatternForDomain(cleanDomain);
      newBlocked = (Array.isArray(data.blocked_domains) ? data.blocked_domains : [])
        .map(d => normalizeDomain(d))
        .filter(d => d && d !== cleanDomain && (!targetPattern || getPrimaryPatternForDomain(d) !== targetPattern));
      newWhitelist = (Array.isArray(data.user_whitelist) ? data.user_whitelist : [])
        .map(d => normalizeDomain(d))
        .filter(d => d && d !== cleanDomain && (!targetPattern || getPrimaryPatternForDomain(d) !== targetPattern));
      const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, newBlocked, newWhitelist);
      await chrome.storage.local.set({
        blocked_domains: newBlocked,
        user_whitelist: newWhitelist,
        domain_protocols: nextProtocols
      });
    });

    await chrome.contentSettings.notifications.clear({});
    await reapplyExtensionRules(newBlocked, newWhitelist, previousGlobalDefault);
  });
}

// Clear all extension-created site blocks while preserving user_whitelist and global default
async function clearAllExtensionBlockRules() {
  return enqueueRuleOp(async () => {
    const previousGlobalDefault = await getGlobalNotificationDefault();

    let whitelist = [];
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        user_whitelist: [],
        domain_protocols: {}
      });
      syncDomainProtocols(data.domain_protocols);
      whitelist = (Array.isArray(data.user_whitelist) ? data.user_whitelist : [])
        .map(d => normalizeDomain(d))
        .filter(Boolean);
      const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, [], whitelist);
      await chrome.storage.local.set({
        blocked_domains: [],
        domain_protocols: nextProtocols
      });
    });

    await chrome.contentSettings.notifications.clear({});
    await reapplyExtensionRules([], whitelist, previousGlobalDefault);
  });
}

// Fast string-based host & port extractor
function parseUrlHostAndPort(urlString, recordProtocol = true) {
  if (!urlString || typeof urlString !== 'string') return null;
  const trimmed = urlString.trim();
  const lowerPrefix = trimmed.substring(0, 8).toLowerCase();

  let protocol = '';
  let rest = '';
  if (lowerPrefix === 'https://') {
    protocol = 'https';
    rest = trimmed.substring(8);
  } else if (lowerPrefix.startsWith('http://')) {
    protocol = 'http';
    rest = trimmed.substring(7);
  } else {
    return null;
  }

  // Find the earliest path, backslash, query, or hash delimiter
  let endIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '/' || ch === '\\' || ch === '?' || ch === '#') {
      endIdx = i;
      break;
    }
  }

  let hostPart = endIdx === -1 ? rest : rest.substring(0, endIdx);
  if (!hostPart) return null;

  // Strip userinfo (e.g., "user:pass@example.com") if present
  const atIdx = hostPart.lastIndexOf('@');
  if (atIdx !== -1) {
    hostPart = hostPart.substring(atIdx + 1);
  }
  if (!hostPart) return null;

  let hostname = '';
  let port = '';

  if (hostPart.startsWith('[')) {
    const closeIdx = hostPart.indexOf(']');
    if (closeIdx === -1) return null;
    hostname = hostPart.substring(0, closeIdx + 1);
    const afterBracket = hostPart.substring(closeIdx + 1);
    if (afterBracket.startsWith(':')) {
      port = afterBracket.substring(1);
    } else if (afterBracket) {
      return null;
    }
  } else {
    const colonIdx = hostPart.indexOf(':');
    if (colonIdx !== -1) {
      hostname = hostPart.substring(0, colonIdx);
      port = hostPart.substring(colonIdx + 1);
    } else {
      hostname = hostPart;
    }
    hostname = hostname.replace(/\.+$/, '');
  }

  if (!isValidHostname(hostname)) return null;

  if (!port) {
    port = protocol === 'https' ? '443' : '80';
  } else if (!isValidPort(port)) {
    return null;
  }

  const domainWithPort = `${hostname.toLowerCase()}:${port}`;
  if (recordProtocol) {
    rememberDomainProtocol(domainWithPort, protocol);
  }
  return domainWithPort;
}

function getHostAndPortFromUrl(urlString) {
  return parseUrlHostAndPort(urlString, true);
}

// Fast string-based port stripper from primary patterns
function stripPortFromPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return '';
  const trimmed = pattern.trim();
  const lowerPrefix = trimmed.substring(0, 8).toLowerCase();

  let protocol = '';
  let rest = '';
  if (lowerPrefix === 'https://') {
    protocol = 'https://';
    rest = trimmed.substring(8);
  } else if (lowerPrefix.startsWith('http://')) {
    protocol = 'http://';
    rest = trimmed.substring(7);
  } else if (lowerPrefix.startsWith('*://')) {
    protocol = '*://';
    rest = trimmed.substring(4);
  } else {
    return trimmed;
  }

  const slashIdx = rest.indexOf('/');
  let hostPart = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
  const pathPart = slashIdx === -1 ? '' : rest.substring(slashIdx);

  if (hostPart.startsWith('[')) {
    const closeIdx = hostPart.indexOf(']');
    if (closeIdx !== -1) {
      const afterBracket = hostPart.substring(closeIdx + 1);
      if (afterBracket.startsWith(':')) {
        const portCandidate = afterBracket.substring(1);
        if (/^(\d+|\*)$/.test(portCandidate)) {
          hostPart = hostPart.substring(0, closeIdx + 1);
        }
      }
    }
  } else {
    const colonIdx = hostPart.indexOf(':');
    if (colonIdx !== -1) {
      const portCandidate = hostPart.substring(colonIdx + 1);
      if (/^(\d+|\*)$/.test(portCandidate)) {
        hostPart = hostPart.substring(0, colonIdx);
      }
    }
  }

  return protocol + hostPart.toLowerCase() + pathPart;
}

// Helper to extract clean domain:port from a contentSettings pattern string
function getDomainFromPattern(pattern) {
  if (!pattern || typeof pattern !== 'string') return '';
  const trimmed = pattern.trim();
  if (!trimmed || trimmed === '<all_urls>') return '';

  // Clean up pattern parts like [*.], wildcard scheme *://, and wildcard port :*
  let clean = trimmed.replace('[*.]', '');
  const lowerClean = clean.toLowerCase();
  const hasExplicitHttpScheme = lowerClean.startsWith('http://') || lowerClean.startsWith('https://');
  if (lowerClean.startsWith('*://')) {
    clean = 'https://' + clean.slice(4);
  } else if (!clean.includes('://')) {
    clean = 'https://' + clean;
  }
  clean = clean.replace(/:\*(?=[/?#\\]|$)/, '');

  const parsed = parseUrlHostAndPort(clean, hasExplicitHttpScheme);
  if (parsed) {
    const hostOnly = getCleanHostname(parsed);
    if (!hostOnly || hostOnly === '*' || hostOnly.includes('*')) {
      if (hasExplicitHttpScheme) {
        knownDomainProtocols.delete(parsed);
      }
      return '';
    }
    return parsed;
  }

  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TRUSTED_DOMAINS,
    GLOBAL_DEFAULT_PROBE_URL,
    isValidPort,
    isValidHostname,
    normalizeDomain,
    normalizeDomainList,
    matchesDomainRuleList,
    getPortFromDomain,
    rememberDomainProtocol,
    syncDomainProtocols,
    clearKnownDomainProtocols,
    getCleanHostname,
    getProtocolForDomain,
    getPrimaryPatternForDomain,
    getPatternWithPortForDomain,
    getPrimaryUrlForDomain,
    getSiteDetailsUrl,
    isDomainTrusted,
    buildPrunedDomainProtocols,
    enqueueStorageOp,
    enqueueRuleOp,
    addBlockedDomain,
    removeBlockedDomain,
    addWhitelistedDomain,
    removeWhitelistedDomain,
    incrementBlockedCount,
    resetBlockedCount,
    blockAndRecordDomains,
    blockAndRecordDomain,
    allowAndTrustDomain,
    getGlobalNotificationDefault,
    setGlobalNotificationDefault,
    reapplyExtensionRules,
    resetDomainRules,
    clearAllExtensionBlockRules,
    getHostAndPortFromUrl,
    stripPortFromPattern,
    getDomainFromPattern
  };
}
