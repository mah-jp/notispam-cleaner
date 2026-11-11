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

// Record explicit http:// or https:// scheme from a contentSettings pattern string
function rememberProtocolFromPattern(domain, pattern) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain || !pattern || typeof pattern !== 'string') return;
  const lowerPattern = pattern.trim().toLowerCase();
  if (lowerPattern.startsWith('http://')) {
    rememberDomainProtocol(cleanDomain, 'http');
  } else if (lowerPattern.startsWith('https://')) {
    rememberDomainProtocol(cleanDomain, 'https');
  }
}

// Sync protocol map from storage object into in-memory lookup table without clobbering newer live observations
function syncDomainProtocols(protocolsMap, overwrite = false) {
  if (!protocolsMap || typeof protocolsMap !== 'object') return;
  for (const [domain, proto] of Object.entries(protocolsMap)) {
    const normalized = normalizeDomain(domain);
    if (!normalized) continue;
    if (!overwrite && knownDomainProtocols.has(normalized)) continue;
    rememberDomainProtocol(normalized, proto);
  }
}

// Clear in-memory protocol cache (useful for isolated tests / cold-start simulation)
function clearKnownDomainProtocols() {
  knownDomainProtocols.clear();
}

function snapshotKnownDomainProtocols() {
  return new Map(knownDomainProtocols);
}

function restoreKnownDomainProtocols(snapshot) {
  knownDomainProtocols.clear();
  if (snapshot instanceof Map) {
    for (const [k, v] of snapshot.entries()) {
      knownDomainProtocols.set(k, v);
    }
  }
}

// Determine protocol ('http' or 'https') from a domain:port string.
// When protocolsMap (e.g. storage.domain_protocols) is provided as a non-null object,
// resolves the persisted rule protocol deterministically without cross-scheme clobbering.
function getProtocolForDomain(domain, protocolsMap = null) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return 'https';
  if (protocolsMap && typeof protocolsMap === 'object') {
    const mapped = String(protocolsMap[normalized] || '').toLowerCase().replace(/:$/, '');
    if (mapped === 'http' || mapped === 'https') {
      return mapped;
    }
    return normalized.endsWith(':80') ? 'http' : 'https';
  }
  if (knownDomainProtocols.has(normalized)) {
    return knownDomainProtocols.get(normalized);
  }
  return normalized.endsWith(':80') ? 'http' : 'https';
}

// Build primaryPattern for chrome.contentSettings.notifications.set (port omitted = wildcard across ports)
function getPrimaryPatternForDomain(domain, protocolsMap = null) {
  const normalized = normalizeDomain(domain);
  const cleanHost = getCleanHostname(normalized);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(normalized, protocolsMap);
  return `${protocol}://${cleanHost}/*`;
}

// Build self-contained pattern including explicit port (for lossless round-tripping in notification IDs)
function getPatternWithPortForDomain(domain, protocolsMap = null) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  const cleanHost = getCleanHostname(normalized);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(normalized, protocolsMap);
  const port = getPortFromDomain(normalized) || (protocol === 'http' ? '80' : '443');
  return `${protocol}://${cleanHost}:${port}/*`;
}

// Build canonical origin URL for chrome.contentSettings.notifications.get
// Standard ports (:80 for http, :443 for https) are omitted; non-standard ports are preserved so
// browser-granted origin permissions on custom ports (e.g., :3000, :8080, :8443) are accurately queried.
function getPrimaryUrlForDomain(domain, protocolsMap = null) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return '';
  const cleanHost = getCleanHostname(normalized);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(normalized, protocolsMap);
  const port = getPortFromDomain(normalized);
  const defaultPort = protocol === 'http' ? '80' : '443';
  const portSuffix = port && port !== defaultPort ? `:${port}` : '';
  return `${protocol}://${cleanHost}${portSuffix}/`;
}

// Build Chrome native site details settings URL for a domain
function getSiteDetailsUrl(domain, protocolsMap = null) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return 'chrome://settings/content/notifications';
  const protocol = getProtocolForDomain(normalized, protocolsMap);
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

// Check whether a domain matches any entry in domainList by extension contentSettings primaryPattern
// (scheme + host port-wildcard). Optional listProtocolsMap resolves persisted schemes for domainList entries,
// and optional domainProtocol overrides the target domain's scheme.
function matchesDomainRuleList(domain, domainList, listProtocolsMap = null, domainProtocol = null) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain || !Array.isArray(domainList) || domainList.length === 0) return false;
  const targetPattern = domainProtocol
    ? getPrimaryPatternForDomain(cleanDomain, { [cleanDomain]: domainProtocol })
    : getPrimaryPatternForDomain(cleanDomain);
  if (!targetPattern) return false;
  return domainList.some((entry) => {
    const cleanEntry = normalizeDomain(entry);
    if (!cleanEntry) return false;
    return getPrimaryPatternForDomain(cleanEntry, listProtocolsMap) === targetPattern;
  });
}

// Build a clean domain_protocols map retaining only active blocked/whitelisted HTTP custom-port domains.
// Domains in mutatedDomains use the live observed protocol; untouched retained domains preserve rawProtocols.
function buildPrunedDomainProtocols(rawProtocols, blockedList, whitelist, mutatedDomains = null) {
  syncDomainProtocols(rawProtocols);
  const retained = new Set([
    ...normalizeDomainList(blockedList),
    ...normalizeDomainList(whitelist)
  ]);
  const hasRawMap = Boolean(rawProtocols && typeof rawProtocols === 'object');
  const mutatedSet = Array.isArray(mutatedDomains)
    ? new Set(normalizeDomainList(mutatedDomains))
    : null;
  const nextProtocols = {};
  for (const d of retained) {
    if (d.endsWith(':80')) continue;
    let proto;
    if (mutatedSet && mutatedSet.has(d)) {
      proto = getProtocolForDomain(d);
    } else if (hasRawMap) {
      proto = getProtocolForDomain(d, rawProtocols);
    } else {
      proto = getProtocolForDomain(d);
    }
    if (proto === 'http') {
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
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: null });
    syncDomainProtocols(data.domain_protocols);
    const list = normalizeDomainList(data.blocked_domains);
    const whitelist = normalizeDomainList(data.user_whitelist);
    const updates = {};
    if (!list.includes(cleanDomain)) {
      list.push(cleanDomain);
      updates.blocked_domains = list;
    }
    const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, list, whitelist, [cleanDomain]);
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
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: null });
    syncDomainProtocols(data.domain_protocols);
    const newList = normalizeDomainList(data.blocked_domains).filter(d => d !== cleanDomain);
    const whitelist = normalizeDomainList(data.user_whitelist);
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
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: null });
    syncDomainProtocols(data.domain_protocols);
    const blocked = normalizeDomainList(data.blocked_domains);
    const list = normalizeDomainList(data.user_whitelist);
    const updates = {};
    if (!list.includes(cleanDomain)) {
      list.push(cleanDomain);
      updates.user_whitelist = list;
    }
    const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blocked, list, [cleanDomain]);
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
    const data = await chrome.storage.local.get({ blocked_domains: [], user_whitelist: [], domain_protocols: null });
    syncDomainProtocols(data.domain_protocols);
    const blocked = normalizeDomainList(data.blocked_domains);
    const newList = normalizeDomainList(data.user_whitelist).filter(d => d !== cleanDomain);
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

async function restoreRuleStorageSnapshot(snapshot, prevKnownProtocols, includeWhitelist = true) {
  restoreKnownDomainProtocols(prevKnownProtocols);
  if (!snapshot) return;
  await enqueueStorageOp(async () => {
    const toSet = {
      blocked_domains: snapshot.blocked_domains || []
    };
    if (includeWhitelist) {
      toSet.user_whitelist = snapshot.user_whitelist || [];
    }
    if (snapshot.domain_protocols && typeof snapshot.domain_protocols === 'object') {
      toSet.domain_protocols = snapshot.domain_protocols;
      await chrome.storage.local.set(toSet);
    } else {
      await chrome.storage.local.set(toSet);
      if (chrome.storage.local && typeof chrome.storage.local.remove === 'function') {
        await chrome.storage.local.remove('domain_protocols');
      }
    }
  });
}

// Return true if any domain in the list uses a non-standard port (neither 80 nor 443)
function hasNonStandardPortDomain(domains) {
  if (!Array.isArray(domains)) return false;
  return domains.some((d) => {
    const p = getPortFromDomain(d);
    return Boolean(p && p !== '80' && p !== '443');
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
    const persistProtocolMap = hasNonStandardPortDomain(cleanDomains);

    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: null
      });
      syncDomainProtocols(data.domain_protocols);
      const blockedList = normalizeDomainList([
        ...(Array.isArray(data.blocked_domains) ? data.blocked_domains : []),
        ...cleanDomains
      ]);
      const whitelist = normalizeDomainList(data.user_whitelist).filter(
        d => !domainSet.has(d) && !patternSet.has(getPrimaryPatternForDomain(d, data.domain_protocols))
      );
      const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blockedList, whitelist, cleanDomains);
      const updates = {
        blocked_domains: blockedList,
        user_whitelist: whitelist
      };
      if (
        persistProtocolMap ||
        data.domain_protocols !== null ||
        !shallowEqualStringMap(data.domain_protocols, nextProtocols)
      ) {
        updates.domain_protocols = nextProtocols;
      }
      await chrome.storage.local.set(updates);
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

    rememberProtocolFromPattern(cleanDomain, customPattern);

    const primaryPattern = customPattern
      ? stripPortFromPattern(customPattern)
      : getPrimaryPatternForDomain(cleanDomain);
    if (!primaryPattern) return;

    await chrome.contentSettings.notifications.set({
      primaryPattern,
      setting: 'block'
    });

    if (cleanDomain) {
      const persistProtocolMap = hasNonStandardPortDomain([cleanDomain]);
      await enqueueStorageOp(async () => {
        const data = await chrome.storage.local.get({
          blocked_domains: [],
          user_whitelist: [],
          domain_protocols: null
        });
        syncDomainProtocols(data.domain_protocols);
        const blockedList = normalizeDomainList([
          ...(Array.isArray(data.blocked_domains) ? data.blocked_domains : []),
          cleanDomain
        ]);
        const whitelist = normalizeDomainList(data.user_whitelist).filter(
          d => d !== cleanDomain && getPrimaryPatternForDomain(d, data.domain_protocols) !== primaryPattern
        );
        const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blockedList, whitelist, [cleanDomain]);
        const updates = {
          blocked_domains: blockedList,
          user_whitelist: whitelist
        };
        if (
          persistProtocolMap ||
          data.domain_protocols !== null ||
          !shallowEqualStringMap(data.domain_protocols, nextProtocols)
        ) {
          updates.domain_protocols = nextProtocols;
        }
        await chrome.storage.local.set(updates);
      });
    }
  });
}

// Trust and allow a domain: atomically updates storage first (avoiding content-script race condition), then sets Chrome permission
async function allowAndTrustDomain(domain, customPattern = null) {
  return enqueueRuleOp(async () => {
    const prevKnownProtocols = snapshotKnownDomainProtocols();
    const patternDomain = customPattern ? getDomainFromPattern(customPattern) : '';
    const cleanDomain = normalizeDomain(domain) || patternDomain;
    if (!cleanDomain) return;

    rememberProtocolFromPattern(cleanDomain, customPattern);

    const primaryPattern = customPattern
      ? stripPortFromPattern(customPattern)
      : getPrimaryPatternForDomain(cleanDomain);
    const persistProtocolMap = hasNonStandardPortDomain([cleanDomain]);

    let prevStorageSnapshot = null;
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: null
      });
      prevStorageSnapshot = data;
      syncDomainProtocols(data.domain_protocols);
      const blockedList = normalizeDomainList(data.blocked_domains).filter(
        d => d !== cleanDomain && (!primaryPattern || getPrimaryPatternForDomain(d, data.domain_protocols) !== primaryPattern)
      );
      const whitelist = normalizeDomainList([
        ...(Array.isArray(data.user_whitelist) ? data.user_whitelist : []),
        cleanDomain
      ]);
      const nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, blockedList, whitelist, [cleanDomain]);
      const updates = {
        blocked_domains: blockedList,
        user_whitelist: whitelist
      };
      if (
        persistProtocolMap ||
        data.domain_protocols !== null ||
        !shallowEqualStringMap(data.domain_protocols, nextProtocols)
      ) {
        updates.domain_protocols = nextProtocols;
      }
      await chrome.storage.local.set(updates);
    });

    if (primaryPattern) {
      try {
        await chrome.contentSettings.notifications.set({
          primaryPattern,
          setting: 'allow'
        });
      } catch (err) {
        await restoreRuleStorageSnapshot(prevStorageSnapshot, prevKnownProtocols, true);
        throw err;
      }
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
    let storedProtocols = null;
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: null
      });
      syncDomainProtocols(data.domain_protocols);
      storedProtocols = data.domain_protocols;
      blockedList = normalizeDomainList(data.blocked_domains);
      whitelist = normalizeDomainList(data.user_whitelist);
    });

    await chrome.contentSettings.notifications.clear({});
    await reapplyExtensionRules(blockedList, whitelist, setting, storedProtocols);
  });
}

// Re-apply extension rules after clearing chrome.contentSettings.notifications
async function reapplyExtensionRules(blockedDomains, whitelistedDomains, previousGlobalDefault, protocolsMap = null) {
  if (previousGlobalDefault) {
    const currentGlobalDefault = await getGlobalNotificationDefault();
    if (currentGlobalDefault !== previousGlobalDefault) {
      await chrome.contentSettings.notifications.set({
        primaryPattern: '<all_urls>',
        setting: previousGlobalDefault
      });
    }
  }

  const allowPatterns = Array.from(new Set(
    normalizeDomainList(whitelistedDomains)
      .map(d => getPrimaryPatternForDomain(d, protocolsMap))
      .filter(Boolean)
  ));
  const allowPatternSet = new Set(allowPatterns);
  const blockPatterns = Array.from(new Set(
    normalizeDomainList(blockedDomains)
      .map(d => getPrimaryPatternForDomain(d, protocolsMap))
      .filter(p => p && !allowPatternSet.has(p))
  ));

  const blockPromises = blockPatterns.map(async (primaryPattern) => {
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'block'
      });
    } catch (e) {
      console.error(`Failed to re-block ${primaryPattern}:`, e);
    }
  });

  const allowPromises = allowPatterns.map(async (primaryPattern) => {
    try {
      await chrome.contentSettings.notifications.set({
        primaryPattern,
        setting: 'allow'
      });
    } catch (e) {
      console.error(`Failed to re-allow ${primaryPattern}:`, e);
    }
  });

  await Promise.all([...blockPromises, ...allowPromises]);
}

// Reset notification settings for a single domain to browser default while preserving all other extension rules
async function resetDomainRules(domain, explicitProtocol = null) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;

  return enqueueRuleOp(async () => {
    const previousGlobalDefault = await getGlobalNotificationDefault();
    const prevKnownProtocols = snapshotKnownDomainProtocols();
    if (explicitProtocol) {
      rememberDomainProtocol(cleanDomain, explicitProtocol);
    }

    let prevStorageSnapshot = null;
    let newBlocked = [];
    let newWhitelist = [];
    let nextProtocols = {};
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: null
      });
      prevStorageSnapshot = data;
      syncDomainProtocols(data.domain_protocols);
      const blockedNorm = normalizeDomainList(data.blocked_domains);
      const whitelistNorm = normalizeDomainList(data.user_whitelist);
      const hasDirectStoredRule = blockedNorm.includes(cleanDomain) || whitelistNorm.includes(cleanDomain);
      const targetProtoMap = explicitProtocol
        ? { [cleanDomain]: explicitProtocol }
        : (hasDirectStoredRule && data.domain_protocols ? data.domain_protocols : null);
      const targetPattern = getPrimaryPatternForDomain(cleanDomain, targetProtoMap);
      const matchesTarget = (d) => {
        const entryPattern = getPrimaryPatternForDomain(d, data.domain_protocols);
        return targetPattern ? entryPattern === targetPattern : d === cleanDomain;
      };
      newBlocked = blockedNorm.filter(d => !matchesTarget(d));
      newWhitelist = whitelistNorm.filter(d => !matchesTarget(d));
      nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, newBlocked, newWhitelist);
      await chrome.storage.local.set({
        blocked_domains: newBlocked,
        user_whitelist: newWhitelist,
        domain_protocols: nextProtocols
      });
    });

    try {
      await chrome.contentSettings.notifications.clear({});
    } catch (err) {
      await restoreRuleStorageSnapshot(prevStorageSnapshot, prevKnownProtocols, true);
      throw err;
    }
    await reapplyExtensionRules(newBlocked, newWhitelist, previousGlobalDefault, nextProtocols);
  });
}

// Clear all extension-created site blocks while preserving user_whitelist and global default
async function clearAllExtensionBlockRules() {
  return enqueueRuleOp(async () => {
    const previousGlobalDefault = await getGlobalNotificationDefault();
    const prevKnownProtocols = snapshotKnownDomainProtocols();

    let prevStorageSnapshot = null;
    let whitelist = [];
    let nextProtocols = {};
    await enqueueStorageOp(async () => {
      const data = await chrome.storage.local.get({
        blocked_domains: [],
        user_whitelist: [],
        domain_protocols: null
      });
      prevStorageSnapshot = data;
      syncDomainProtocols(data.domain_protocols);
      whitelist = normalizeDomainList(data.user_whitelist);
      nextProtocols = buildPrunedDomainProtocols(data.domain_protocols, [], whitelist);
      await chrome.storage.local.set({
        blocked_domains: [],
        domain_protocols: nextProtocols
      });
    });

    try {
      await chrome.contentSettings.notifications.clear({});
    } catch (err) {
      await restoreRuleStorageSnapshot(prevStorageSnapshot, prevKnownProtocols, false);
      throw err;
    }
    await reapplyExtensionRules([], whitelist, previousGlobalDefault, nextProtocols);
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

function extractHostAndPortFromUrl(urlString) {
  return parseUrlHostAndPort(urlString, false);
}

function extractProtocolFromUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return '';
  const lower = urlString.trim().toLowerCase();
  if (lower.startsWith('https://')) return 'https';
  if (lower.startsWith('http://')) return 'http';
  return '';
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
    rememberProtocolFromPattern,
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
    shallowEqualStringMap,
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
    extractHostAndPortFromUrl,
    extractProtocolFromUrl,
    stripPortFromPattern,
    getDomainFromPattern
  };
}
