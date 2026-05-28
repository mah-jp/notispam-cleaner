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
  'asana.com', 'trello.com', 'notion.so', 'monday.com',

  // Developer Tools & Platforms
  'github.com', 'gitlab.com', 'bitbucket.org', 'atlassian.net',

  // E-commerce & Entertainment
  'amazon.com', 'amazon.co.jp', 'apple.com', 'netflix.com', 'youtube.com'
];

// Helper to check if a domain is in the built-in or user whitelists
function isDomainTrusted(domain, userWhitelist = []) {
  if (!domain) return true;
  // Strip port suffix (e.g., "example.com:443" -> "example.com")
  const cleanDomain = domain.split(':')[0].toLowerCase();

  // Check user whitelist
  if (userWhitelist && userWhitelist.some(d => {
    if (!d) return false;
    const cleanD = d.split(':')[0].toLowerCase();
    return cleanDomain === cleanD || cleanDomain.endsWith('.' + cleanD);
  })) {
    return true;
  }

  // Check built-in whitelist
  return TRUSTED_DOMAINS.some(d => cleanDomain === d || cleanDomain.endsWith('.' + d));
}

// Add a domain to the persistent blocked domains list in local storage
async function addBlockedDomain(domain) {
  if (!domain) return;
  const cleanDomain = domain.toLowerCase();
  const data = await chrome.storage.local.get({ blocked_domains: [] });
  if (!data.blocked_domains.includes(cleanDomain)) {
    data.blocked_domains.push(cleanDomain);
    await chrome.storage.local.set({ blocked_domains: data.blocked_domains });
  }
}

// Remove a domain from the persistent blocked domains list in local storage
async function removeBlockedDomain(domain) {
  if (!domain) return;
  const cleanDomain = domain.toLowerCase();
  const data = await chrome.storage.local.get({ blocked_domains: [] });
  const newList = data.blocked_domains.filter(d => d !== cleanDomain);
  await chrome.storage.local.set({ blocked_domains: newList });
}

// Fast string-based host & port extractor
function getHostAndPortFromUrl(urlString) {
  if (!urlString) return null;
  let protocol = '';
  let rest = '';
  if (urlString.startsWith('https://')) {
    protocol = 'https';
    rest = urlString.substring(8);
  } else if (urlString.startsWith('http://')) {
    protocol = 'http';
    rest = urlString.substring(7);
  } else {
    return null;
  }

  let endIdx = rest.indexOf('/');
  if (endIdx === -1) endIdx = rest.indexOf('?');
  if (endIdx === -1) endIdx = rest.indexOf('#');

  const hostPart = endIdx === -1 ? rest : rest.substring(0, endIdx);
  if (!hostPart) return null;

  const colonIdx = hostPart.indexOf(':');
  let hostname = hostPart;
  let port = '';
  if (colonIdx !== -1) {
    hostname = hostPart.substring(0, colonIdx);
    port = hostPart.substring(colonIdx + 1);
  }

  if (!port) {
    port = protocol === 'https' ? '443' : '80';
  }

  return `${hostname}:${port}`;
}

// Fast string-based port stripper from primary patterns
function stripPortFromPattern(pattern) {
  if (!pattern) return '';
  let protocol = '';
  let rest = '';
  if (pattern.startsWith('https://')) {
    protocol = 'https://';
    rest = pattern.substring(8);
  } else if (pattern.startsWith('http://')) {
    protocol = 'http://';
    rest = pattern.substring(7);
  } else {
    return pattern;
  }

  const slashIdx = rest.indexOf('/');
  let hostPart = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
  const pathPart = slashIdx === -1 ? '' : rest.substring(slashIdx);

  const colonIdx = hostPart.indexOf(':');
  if (colonIdx !== -1) {
    const portCandidate = hostPart.substring(colonIdx + 1);
    if (/^\d+$/.test(portCandidate)) {
      hostPart = hostPart.substring(0, colonIdx);
    }
  }

  return protocol + hostPart + pathPart;
}
