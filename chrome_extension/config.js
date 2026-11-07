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
    return inner.length > 0 && inner.includes(':') && /^[0-9a-f:]+$/i.test(inner);
  }
  if (host.startsWith('.') || host.endsWith('.')) return false;
  if (/[\s/\\?#@<>'"`[\]:]/.test(host)) return false;
  return true;
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

// Record the protocol ('http' or 'https') observed for a normalized domain:port
function rememberDomainProtocol(domain, protocol) {
  const normalized = normalizeDomain(domain);
  if (!normalized || !protocol) return;
  const cleanProto = String(protocol).toLowerCase().replace(/:$/, '');
  if (cleanProto === 'http' || cleanProto === 'https') {
    knownDomainProtocols.set(normalized, cleanProto);
  }
}

// Sync protocol map from storage object
function syncDomainProtocols(protocolsMap) {
  if (!protocolsMap || typeof protocolsMap !== 'object') return;
  for (const [domain, proto] of Object.entries(protocolsMap)) {
    rememberDomainProtocol(domain, proto);
  }
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

// Determine protocol ('http' or 'https') from a domain:port string
function getProtocolForDomain(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return 'https';
  if (knownDomainProtocols.has(normalized)) {
    return knownDomainProtocols.get(normalized);
  }
  return normalized.endsWith(':80') ? 'http' : 'https';
}

// Build primaryPattern for chrome.contentSettings.notifications.set
function getPrimaryPatternForDomain(domain) {
  const cleanHost = getCleanHostname(domain);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(domain);
  return `${protocol}://${cleanHost}/*`;
}

// Build primaryUrl for chrome.contentSettings.notifications.get
function getPrimaryUrlForDomain(domain) {
  const cleanHost = getCleanHostname(domain);
  if (!cleanHost) return '';
  const protocol = getProtocolForDomain(domain);
  return `${protocol}://${cleanHost}/`;
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

// Serialization queue for storage read-modify-write operations to prevent lost updates
let storageQueue = Promise.resolve();

function enqueueStorageOp(op) {
  const next = storageQueue.then(() => op());
  storageQueue = next.catch(() => { });
  return next;
}

// Add a domain to the persistent blocked domains list in local storage
async function addBlockedDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ blocked_domains: [], domain_protocols: {} });
    syncDomainProtocols(data.domain_protocols);
    const list = Array.isArray(data.blocked_domains) ? data.blocked_domains.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const updates = {};
    if (!list.includes(cleanDomain)) {
      list.push(cleanDomain);
      updates.blocked_domains = list;
    }
    const proto = getProtocolForDomain(cleanDomain);
    if (proto === 'http' && !cleanDomain.endsWith(':80')) {
      const protocols = (data.domain_protocols && typeof data.domain_protocols === 'object') ? { ...data.domain_protocols } : {};
      if (protocols[cleanDomain] !== 'http') {
        protocols[cleanDomain] = 'http';
        updates.domain_protocols = protocols;
      }
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
    const data = await chrome.storage.local.get({ blocked_domains: [] });
    const list = Array.isArray(data.blocked_domains) ? data.blocked_domains : [];
    const newList = list.map(d => normalizeDomain(d)).filter(d => d && d !== cleanDomain);
    await chrome.storage.local.set({ blocked_domains: newList });
  });
}

// Add a domain to the persistent user whitelist in local storage
async function addWhitelistedDomain(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;
  return enqueueStorageOp(async () => {
    const data = await chrome.storage.local.get({ user_whitelist: [], domain_protocols: {} });
    syncDomainProtocols(data.domain_protocols);
    const list = Array.isArray(data.user_whitelist) ? data.user_whitelist.map(d => normalizeDomain(d)).filter(Boolean) : [];
    const updates = {};
    if (!list.includes(cleanDomain)) {
      list.push(cleanDomain);
      updates.user_whitelist = list;
    }
    const proto = getProtocolForDomain(cleanDomain);
    if (proto === 'http' && !cleanDomain.endsWith(':80')) {
      const protocols = (data.domain_protocols && typeof data.domain_protocols === 'object') ? { ...data.domain_protocols } : {};
      if (protocols[cleanDomain] !== 'http') {
        protocols[cleanDomain] = 'http';
        updates.domain_protocols = protocols;
      }
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
    const data = await chrome.storage.local.get({ user_whitelist: [] });
    const list = Array.isArray(data.user_whitelist) ? data.user_whitelist : [];
    const newList = list.map(d => normalizeDomain(d)).filter(d => d && d !== cleanDomain);
    await chrome.storage.local.set({ user_whitelist: newList });
  });
}

// Trust and allow a domain: updates storage first (avoiding content-script race condition), then sets Chrome permission
async function allowAndTrustDomain(domain, customPattern = null) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;

  if (customPattern && typeof customPattern === 'string') {
    const lowerPattern = customPattern.trim().toLowerCase();
    if (lowerPattern.startsWith('http://')) {
      rememberDomainProtocol(cleanDomain, 'http');
    } else if (lowerPattern.startsWith('https://')) {
      rememberDomainProtocol(cleanDomain, 'https');
    }
  }

  await removeBlockedDomain(cleanDomain);
  await addWhitelistedDomain(cleanDomain);

  const primaryPattern = customPattern
    ? stripPortFromPattern(customPattern)
    : getPrimaryPatternForDomain(cleanDomain);

  if (primaryPattern) {
    await chrome.contentSettings.notifications.set({
      primaryPattern,
      setting: 'allow'
    });
  }
}

// Fast string-based host & port extractor
function getHostAndPortFromUrl(urlString) {
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
  rememberDomainProtocol(domainWithPort, protocol);
  return domainWithPort;
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

  // Clean up pattern parts like [*.] and wildcard port :*
  let clean = trimmed.replace('[*.]', '');
  if (!clean.includes('://')) {
    clean = 'https://' + clean;
  }
  clean = clean.replace(/:\*(?=[/?#\\]|$)/, '');

  const parsed = getHostAndPortFromUrl(clean);
  if (parsed) {
    const hostOnly = getCleanHostname(parsed);
    if (!hostOnly || hostOnly === '*' || hostOnly.includes('*')) {
      knownDomainProtocols.delete(parsed);
      return '';
    }
    return parsed;
  }

  return '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TRUSTED_DOMAINS,
    isValidPort,
    isValidHostname,
    normalizeDomain,
    rememberDomainProtocol,
    syncDomainProtocols,
    getCleanHostname,
    getProtocolForDomain,
    getPrimaryPatternForDomain,
    getPrimaryUrlForDomain,
    getSiteDetailsUrl,
    isDomainTrusted,
     enqueueStorageOp,
    addBlockedDomain,
    removeBlockedDomain,
    addWhitelistedDomain,
    removeWhitelistedDomain,
    allowAndTrustDomain,
    getHostAndPortFromUrl,
    stripPortFromPattern,
    getDomainFromPattern
  };
}
