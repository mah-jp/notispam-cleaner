#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const DEFAULT_EXTENSION_ID = 'dahnhdiabhegihofjijbchegffnkiaap';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CWS_SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const CWS_API_BASE = 'https://chromewebstore.googleapis.com/v2';
const CWS_UPLOAD_BASE = 'https://chromewebstore.googleapis.com/upload/v2';

/**
 * Parse CLI arguments into an options object.
 * @param {string[]} argv
 */
function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    zipPath: null,
    uploadOnly: false,
    publishType: 'DEFAULT_PUBLISH',
    getToken: false,
    authCode: null,
    port: 8818,
    publisherId: null,
    extensionId: null,
    clientId: null,
    clientSecret: null,
    refreshToken: null,
    help: false
  };

  let i = 0;

  function readValue(flagName) {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      throw new Error(`Unknown or incomplete argument: ${flagName}`);
    }
    return argv[++i];
  }

  function parsePort(rawPort) {
    const trimmed = String(rawPort).trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(`Invalid port "${rawPort}". Must be an integer between 1 and 65535.`);
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new Error(`Invalid port "${rawPort}". Must be an integer between 1 and 65535.`);
    }
    return num;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--upload-only') {
      opts.uploadOnly = true;
    } else if (arg === '--get-token') {
      opts.getToken = true;
    } else if (arg === '--zip') {
      opts.zipPath = readValue(arg);
    } else if (arg.startsWith('--zip=')) {
      opts.zipPath = arg.slice('--zip='.length);
    } else if (arg === '--publish-type') {
      opts.publishType = readValue(arg);
    } else if (arg.startsWith('--publish-type=')) {
      opts.publishType = arg.slice('--publish-type='.length);
    } else if (arg === '--auth-code') {
      opts.authCode = readValue(arg);
    } else if (arg.startsWith('--auth-code=')) {
      opts.authCode = arg.slice('--auth-code='.length);
    } else if (arg === '--port') {
      opts.port = parsePort(readValue(arg));
    } else if (arg.startsWith('--port=')) {
      opts.port = parsePort(arg.slice('--port='.length));
    } else if (arg === '--publisher-id') {
      opts.publisherId = readValue(arg);
    } else if (arg.startsWith('--publisher-id=')) {
      opts.publisherId = arg.slice('--publisher-id='.length);
    } else if (arg === '--extension-id') {
      opts.extensionId = readValue(arg);
    } else if (arg.startsWith('--extension-id=')) {
      opts.extensionId = arg.slice('--extension-id='.length);
    } else if (arg === '--client-id') {
      opts.clientId = readValue(arg);
    } else if (arg.startsWith('--client-id=')) {
      opts.clientId = arg.slice('--client-id='.length);
    } else if (arg === '--client-secret') {
      opts.clientSecret = readValue(arg);
    } else if (arg.startsWith('--client-secret=')) {
      opts.clientSecret = arg.slice('--client-secret='.length);
    } else if (arg === '--refresh-token') {
      opts.refreshToken = readValue(arg);
    } else if (arg.startsWith('--refresh-token=')) {
      opts.refreshToken = arg.slice('--refresh-token='.length);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return opts;
}

/**
 * Resolve and validate configuration from options and environment variables.
 * @param {object} options
 * @param {NodeJS.ProcessEnv} env
 */
function resolveConfig(options = {}, env = process.env) {
  const publisherId = (options.publisherId ?? env.CWS_PUBLISHER_ID ?? '').trim();
  const extensionId = (
    options.extensionId !== undefined && options.extensionId !== null
      ? String(options.extensionId)
      : (env.CWS_EXTENSION_ID || DEFAULT_EXTENSION_ID)
  ).trim();
  const clientId = (options.clientId ?? env.CWS_CLIENT_ID ?? '').trim();
  const clientSecret = (options.clientSecret ?? env.CWS_CLIENT_SECRET ?? '').trim();
  const refreshToken = (options.refreshToken ?? env.CWS_REFRESH_TOKEN ?? '').trim();
  const zipPath = (options.zipPath ?? env.CWS_ZIP_PATH ?? '').trim();
  const uploadOnly = Boolean(options.uploadOnly);
  const publishType = (options.publishType || 'DEFAULT_PUBLISH').trim();

  const missing = [];
  if (!publisherId) missing.push('CWS_PUBLISHER_ID');
  if (!extensionId) missing.push('CWS_EXTENSION_ID');
  if (!clientId) missing.push('CWS_CLIENT_ID');
  if (!clientSecret) missing.push('CWS_CLIENT_SECRET');
  if (!refreshToken) missing.push('CWS_REFRESH_TOKEN');
  if (!zipPath) missing.push('--zip <path>');

  if (missing.length > 0) {
    throw new Error(
      `Missing required Chrome Web Store configuration: ${missing.join(', ')}. ` +
      `Ensure GitHub Secrets (CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN) and --zip are set.`
    );
  }

  if (publishType !== 'DEFAULT_PUBLISH' && publishType !== 'STAGED_PUBLISH') {
    throw new Error(`Invalid publishType "${publishType}". Must be DEFAULT_PUBLISH or STAGED_PUBLISH.`);
  }

  return {
    publisherId,
    extensionId,
    clientId,
    clientSecret,
    refreshToken,
    zipPath,
    uploadOnly,
    publishType
  };
}

/**
 * Exchange an OAuth2 refresh token for a short-lived access token.
 */
async function fetchAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  let data;
  const rawText = await res.text();
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  if (!res.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
    const errDetail = data && (data.error_description || data.error)
      ? `${data.error}${data.error_description ? `: ${data.error_description}` : ''}`
      : `HTTP ${res.status}`;
    throw new Error(`Failed to obtain OAuth2 access token (${errDetail})`);
  }

  return data.access_token;
}

/**
 * Upload the extension ZIP package to Chrome Web Store API v2.
 */
async function uploadPackage({
  publisherId,
  extensionId,
  accessToken,
  zipPath,
  fetchImpl = fetch,
  fsImpl = fs
}) {
  const resolvedPath = path.resolve(zipPath);
  if (!fsImpl.existsSync(resolvedPath)) {
    throw new Error(`ZIP file not found at: ${resolvedPath}`);
  }
  const stat = fsImpl.statSync(resolvedPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`ZIP file is empty or not a regular file: ${resolvedPath}`);
  }

  const zipBuffer = fsImpl.readFileSync(resolvedPath);
  const url = `${CWS_UPLOAD_BASE}/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:upload`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/zip'
    },
    body: zipBuffer
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  if (!res.ok) {
    const errMsg = data?.error?.message || rawText || `HTTP ${res.status}`;
    throw new Error(`Chrome Web Store upload failed (HTTP ${res.status}): ${errMsg}`);
  }

  return data;
}

/**
 * Poll `:fetchStatus` when an upload returns `IN_PROGRESS` until it resolves to `SUCCEEDED`.
 */
async function waitForUploadCompletion({
  publisherId,
  extensionId,
  accessToken,
  fetchImpl = fetch,
  pollIntervalMs = 3000,
  maxAttempts = 20,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  const url = `${CWS_API_BASE}/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:fetchStatus`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleepImpl(pollIntervalMs);

    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { raw: rawText };
    }

    if (!res.ok) {
      const errMsg = data?.error?.message || rawText || `HTTP ${res.status}`;
      throw new Error(`Failed to fetch upload status (HTTP ${res.status}): ${errMsg}`);
    }

    const state = data.lastAsyncUploadState;
    if (state === 'SUCCEEDED') {
      return data;
    }
    if (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') {
      continue;
    }
    throw new Error(`Asynchronous upload finished with non-success state: ${state || 'UNKNOWN'}`);
  }

  throw new Error(`Timed out waiting for Chrome Web Store package processing after ${maxAttempts} attempts.`);
}

/**
 * Submit the uploaded package for review and publication on Chrome Web Store API v2.
 */
async function publishItem({
  publisherId,
  extensionId,
  accessToken,
  publishType = 'DEFAULT_PUBLISH',
  fetchImpl = fetch
}) {
  const url = `${CWS_API_BASE}/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:publish`;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ publishType })
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  if (!res.ok) {
    const errMsg = data?.error?.message || rawText || `HTTP ${res.status}`;
    throw new Error(`Chrome Web Store publish failed (HTTP ${res.status}): ${errMsg}`);
  }

  return data;
}

/**
 * Full deployment flow: authenticate -> upload -> wait if async -> publish (unless uploadOnly).
 */
async function deployToChromeWebStore(options = {}, env = process.env, deps = {}) {
  const config = resolveConfig(options, env);
  const fetchImpl = deps.fetchImpl || fetch;
  const fsImpl = deps.fsImpl || fs;
  const sleepImpl = deps.sleepImpl;
  const logger = deps.logger || console;

  logger.log(`[CWS] Authenticating with Google OAuth2...`);
  const accessToken = await fetchAccessToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: config.refreshToken,
    fetchImpl
  });

  logger.log(`[CWS] Uploading ${config.zipPath} to publisher/${config.publisherId}/items/${config.extensionId}...`);
  const uploadResult = await uploadPackage({
    publisherId: config.publisherId,
    extensionId: config.extensionId,
    accessToken,
    zipPath: config.zipPath,
    fetchImpl,
    fsImpl
  });

  const state = uploadResult.uploadState;
  if (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') {
    logger.log(`[CWS] Upload is processing asynchronously (${state}). Polling fetchStatus...`);
    await waitForUploadCompletion({
      publisherId: config.publisherId,
      extensionId: config.extensionId,
      accessToken,
      fetchImpl,
      pollIntervalMs: deps.pollIntervalMs,
      maxAttempts: deps.maxAttempts,
      sleepImpl
    });
    logger.log(`[CWS] Async upload processing succeeded.`);
  } else if (state !== 'SUCCEEDED') {
    throw new Error(`Chrome Web Store upload did not succeed (uploadState: ${state || 'UNKNOWN'}): ${JSON.stringify(uploadResult)}`);
  } else {
    logger.log(`[CWS] Upload succeeded (crxVersion: ${uploadResult.crxVersion || 'unknown'}).`);
  }

  if (config.uploadOnly) {
    logger.log(`[CWS] --upload-only specified. Skipping publish step (saved as draft).`);
    return { uploadResult, publishResult: null };
  }

  logger.log(`[CWS] Submitting item for publishing (publishType: ${config.publishType})...`);
  const publishResult = await publishItem({
    publisherId: config.publisherId,
    extensionId: config.extensionId,
    accessToken,
    publishType: config.publishType,
    fetchImpl
  });

  logger.log(`[CWS] Publish submission complete (state: ${publishResult.state || 'SUBMITTED'}).`);
  return { uploadResult, publishResult };
}

/**
 * Exchange a one-time OAuth2 authorization code for a refresh token.
 */
async function exchangeAuthCodeForRefreshToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
  fetchImpl = fetch
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });

  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  if (!res.ok || !data.refresh_token) {
    const detail = data?.error_description || data?.error || rawText || `HTTP ${res.status}`;
    throw new Error(
      `Failed to obtain refresh_token (${detail}). ` +
      `Make sure you used prompt=consent&access_type=offline and that the code has not expired.`
    );
  }

  return data;
}

/**
 * Build the Google OAuth2 authorization URL for obtaining a refresh token.
 */
function buildAuthorizationUrl({ clientId, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    scope: CWS_SCOPE,
    client_id: clientId,
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent'
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

/**
 * Interactive local helper that starts a temporary loopback server to capture the OAuth2 redirect
 * and exchange the authorization code for a refresh token.
 */
async function runInteractiveTokenHelper({
  clientId,
  clientSecret,
  authCode = null,
  port = 8818,
  fetchImpl = fetch,
  httpImpl = http,
  logger = console,
  onListening = null
}) {
  if (!clientId || !clientSecret) {
    throw new Error(
      'CWS_CLIENT_ID and CWS_CLIENT_SECRET are required to obtain a refresh token.\n' +
      'Usage: CWS_CLIENT_ID="..." CWS_CLIENT_SECRET="..." npm run cws:token'
    );
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${port}". Must be an integer between 1 and 65535.`);
  }

  const redirectUri = `http://127.0.0.1:${port}`;

  if (authCode) {
    const tokenData = await exchangeAuthCodeForRefreshToken({
      clientId,
      clientSecret,
      code: authCode,
      redirectUri,
      fetchImpl
    });
    logger.log('\n=== Successfully obtained Refresh Token ===');
    logger.log(`CWS_REFRESH_TOKEN=${tokenData.refresh_token}\n`);
    return tokenData;
  }

  const authUrl = buildAuthorizationUrl({ clientId, redirectUri });

  return new Promise((resolve, reject) => {
    let settled = false;

    function closeServer(srv) {
      srv.close();
      if (typeof srv.closeAllConnections === 'function') {
        srv.closeAllConnections();
      }
    }

    const server = httpImpl.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', redirectUri);
        const errorParam = reqUrl.searchParams.get('error');
        const codeParam = reqUrl.searchParams.get('code');

        if (settled) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
          res.end('Callback already processed.');
          return;
        }

        if (errorParam) {
          settled = true;
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
          res.end(`Authorization failed: ${errorParam}`);
          closeServer(server);
          reject(new Error(`OAuth authorization error: ${errorParam}`));
          return;
        }

        if (!codeParam) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
          res.end('Waiting for Google OAuth2 callback...');
          return;
        }

        settled = true;
        const tokenData = await exchangeAuthCodeForRefreshToken({
          clientId,
          clientSecret,
          code: codeParam,
          redirectUri,
          fetchImpl
        });

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(
          '<h2>Refresh Token obtained successfully!</h2>' +
          '<p>You can close this browser tab and return to your terminal.</p>'
        );
        closeServer(server);

        logger.log('\n============================================================');
        logger.log('Successfully obtained Chrome Web Store Refresh Token!');
        logger.log('Save this value as CWS_REFRESH_TOKEN in GitHub Actions Secrets:');
        logger.log('------------------------------------------------------------');
        logger.log(tokenData.refresh_token);
        logger.log('============================================================\n');
        resolve(tokenData);
      } catch (err) {
        settled = true;
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end(`Failed to exchange authorization code: ${err.message}`);
        closeServer(server);
        reject(err);
      }
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      logger.log('\n============================================================');
      logger.log('Chrome Web Store OAuth2 Refresh Token Helper');
      logger.log('============================================================');
      logger.log('1. Open the following URL in your browser and authorize access:\n');
      logger.log(authUrl);
      logger.log(`\n2. Waiting for redirect on ${redirectUri} ...`);
      logger.log('============================================================\n');
      if (typeof onListening === 'function') {
        onListening({ port, redirectUri, authUrl, server });
      }
    });
  });
}

function printHelp(logger = console) {
  logger.log(`Usage:
  node scripts/cws-publish.js --zip <path-to-zip> [--upload-only] [--publish-type DEFAULT_PUBLISH|STAGED_PUBLISH]
  node scripts/cws-publish.js --get-token [--port 8818] [--auth-code <code>]

Required Environment Variables for Publishing:
  CWS_PUBLISHER_ID    Chrome Web Store Publisher ID (from Developer Dashboard -> Account)
  CWS_EXTENSION_ID    Chrome Extension ID (defaults to ${DEFAULT_EXTENSION_ID})
  CWS_CLIENT_ID       Google Cloud OAuth 2.0 Client ID
  CWS_CLIENT_SECRET   Google Cloud OAuth 2.0 Client Secret
  CWS_REFRESH_TOKEN   Google Cloud OAuth 2.0 Refresh Token`);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return;
  }

  if (opts.getToken || opts.authCode) {
    const clientId = (opts.clientId ?? env.CWS_CLIENT_ID ?? '').trim();
    const clientSecret = (opts.clientSecret ?? env.CWS_CLIENT_SECRET ?? '').trim();
    await runInteractiveTokenHelper({
      clientId,
      clientSecret,
      authCode: opts.authCode,
      port: opts.port
    });
    return;
  }

  await deployToChromeWebStore(opts, env);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[CWS Error] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_EXTENSION_ID,
  OAUTH_TOKEN_URL,
  OAUTH_AUTH_URL,
  CWS_SCOPE,
  CWS_API_BASE,
  CWS_UPLOAD_BASE,
  parseArgs,
  resolveConfig,
  fetchAccessToken,
  uploadPackage,
  waitForUploadCompletion,
  publishItem,
  deployToChromeWebStore,
  exchangeAuthCodeForRefreshToken,
  buildAuthorizationUrl,
  runInteractiveTokenHelper,
  main
};
