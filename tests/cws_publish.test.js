const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cws = require('../scripts/cws-publish.js');

const silentLogger = {
  log: () => {},
  error: () => {}
};

function createJsonResponse(status, bodyObj) {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text
  };
}

describe('scripts/cws-publish.js — Chrome Web Store API v2 Automation', () => {
  describe('parseArgs & resolveConfig', () => {
    it('parses CLI flags in both space-separated and = formats', () => {
      const parsed = cws.parseArgs([
        '--zip', 'notispam-cleaner-v1.0.3.zip',
        '--upload-only',
        '--publish-type=STAGED_PUBLISH',
        '--publisher-id', 'pub-123',
        '--extension-id=ext-456',
        '--client-id', 'cid',
        '--client-secret=csec',
        '--refresh-token', 'rtok',
        '--port=9999'
      ]);

      assert.equal(parsed.zipPath, 'notispam-cleaner-v1.0.3.zip');
      assert.equal(parsed.uploadOnly, true);
      assert.equal(parsed.publishType, 'STAGED_PUBLISH');
      assert.equal(parsed.publisherId, 'pub-123');
      assert.equal(parsed.extensionId, 'ext-456');
      assert.equal(parsed.clientId, 'cid');
      assert.equal(parsed.clientSecret, 'csec');
      assert.equal(parsed.refreshToken, 'rtok');
      assert.equal(parsed.port, 9999);
    });

    it('throws on unknown or incomplete CLI arguments and invalid ports', () => {
      assert.throws(() => cws.parseArgs(['--unknown-flag']), /Unknown or incomplete argument/);
      assert.throws(() => cws.parseArgs(['--zip']), /Unknown or incomplete argument/);
      assert.throws(() => cws.parseArgs(['--zip', '--upload-only']), /Unknown or incomplete argument: --zip/);
      assert.throws(() => cws.parseArgs(['--port', 'abc']), /Invalid port "abc"/);
      assert.throws(() => cws.parseArgs(['--port=0']), /Invalid port "0"/);
      assert.throws(() => cws.parseArgs(['--port=70000']), /Invalid port "70000"/);
      assert.throws(() => cws.parseArgs(['--port=']), /Invalid port ""/);
    });

    it('resolves environment variables and defaults CWS_EXTENSION_ID when omitted', () => {
      const cfg = cws.resolveConfig(
        { zipPath: 'pkg.zip' },
        {
          CWS_PUBLISHER_ID: '  pub-uuid-1  ',
          CWS_CLIENT_ID: ' client-1 ',
          CWS_CLIENT_SECRET: ' secret-1 ',
          CWS_REFRESH_TOKEN: ' refresh-1 '
        }
      );

      assert.equal(cfg.publisherId, 'pub-uuid-1');
      assert.equal(cfg.extensionId, cws.DEFAULT_EXTENSION_ID);
      assert.equal(cfg.clientId, 'client-1');
      assert.equal(cfg.clientSecret, 'secret-1');
      assert.equal(cfg.refreshToken, 'refresh-1');
      assert.equal(cfg.zipPath, 'pkg.zip');
      assert.equal(cfg.publishType, 'DEFAULT_PUBLISH');
    });

    it('throws descriptive error listing all missing variables on empty or whitespace inputs', () => {
      assert.throws(
        () => cws.resolveConfig({ extensionId: '   ' }, {}),
        /Missing required Chrome Web Store configuration: CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, --zip <path>/
      );

      assert.throws(
        () => cws.resolveConfig({ checkStatus: true }, {}),
        (err) => {
          assert.match(err.message, /Missing required Chrome Web Store configuration: CWS_PUBLISHER_ID/);
          assert.ok(!err.message.includes('--zip'), 'Should not mention --zip when checkStatus is true');
          return true;
        }
      );
    });

    it('rejects invalid publishType values', () => {
      assert.throws(
        () => cws.resolveConfig(
          { zipPath: 'pkg.zip', publishType: 'INVALID_TYPE' },
          {
            CWS_PUBLISHER_ID: 'pub',
            CWS_CLIENT_ID: 'cid',
            CWS_CLIENT_SECRET: 'csec',
            CWS_REFRESH_TOKEN: 'rtok'
          }
        ),
        /Invalid publishType "INVALID_TYPE"/
      );
    });
  });

  describe('fetchAccessToken', () => {
    it('exchanges refresh_token for access_token via Google OAuth2 endpoint', async () => {
      let capturedUrl = null;
      let capturedInit = null;

      const token = await cws.fetchAccessToken({
        clientId: 'my-client-id',
        clientSecret: 'my-client-secret',
        refreshToken: 'my-refresh-token',
        fetchImpl: async (url, init) => {
          capturedUrl = url;
          capturedInit = init;
          return createJsonResponse(200, { access_token: 'ya29.test-token', expires_in: 3599 });
        }
      });

      assert.equal(token, 'ya29.test-token');
      assert.equal(capturedUrl, cws.OAUTH_TOKEN_URL);
      assert.equal(capturedInit.method, 'POST');
      const params = new URLSearchParams(capturedInit.body);
      assert.equal(params.get('client_id'), 'my-client-id');
      assert.equal(params.get('client_secret'), 'my-client-secret');
      assert.equal(params.get('refresh_token'), 'my-refresh-token');
      assert.equal(params.get('grant_type'), 'refresh_token');
    });

    it('throws detailed error when OAuth2 token exchange fails or returns non-JSON', async () => {
      await assert.rejects(
        () => cws.fetchAccessToken({
          clientId: 'cid',
          clientSecret: 'csec',
          refreshToken: 'bad-token',
          fetchImpl: async () => createJsonResponse(400, {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.'
          })
        }),
        /Failed to obtain OAuth2 access token \(invalid_grant: Token has been expired or revoked\.\)/
      );

      await assert.rejects(
        () => cws.fetchAccessToken({
          clientId: 'cid',
          clientSecret: 'csec',
          refreshToken: 'bad-token',
          fetchImpl: async () => createJsonResponse(502, 'Bad Gateway HTML')
        }),
        /Failed to obtain OAuth2 access token \(HTTP 502\)/
      );
    });
  });

  describe('uploadPackage, waitForUploadCompletion, publishItem, and deployToChromeWebStore', () => {
    it('rejects non-existent or 0-byte ZIP files before making network requests', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-test-'));
      const emptyZip = path.join(tmpDir, 'empty.zip');
      fs.writeFileSync(emptyZip, '');

      try {
        await assert.rejects(
          () => cws.uploadPackage({
            publisherId: 'pub',
            extensionId: 'ext',
            accessToken: 'tok',
            zipPath: path.join(tmpDir, 'missing.zip'),
            fetchImpl: async () => { throw new Error('Should not be called'); }
          }),
          /ZIP file not found/
        );

        await assert.rejects(
          () => cws.uploadPackage({
            publisherId: 'pub',
            extensionId: 'ext',
            accessToken: 'tok',
            zipPath: emptyZip,
            fetchImpl: async () => { throw new Error('Should not be called'); }
          }),
          /ZIP file is empty/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('completes full synchronous upload and publish flow against Chrome Web Store API v2', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-test-'));
      const zipPath = path.join(tmpDir, 'ext.zip');
      fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04dummy-zip-content'));

      const requests = [];
      const mockFetch = async (url, init) => {
        requests.push({ url, init });
        if (url === cws.OAUTH_TOKEN_URL) {
          return createJsonResponse(200, { access_token: 'ya29.valid' });
        }
        if (url.endsWith(':upload')) {
          return createJsonResponse(200, {
            name: 'publishers/pub-1/items/ext-1',
            itemId: 'ext-1',
            crxVersion: '1.0.3',
            uploadState: 'SUCCEEDED'
          });
        }
        if (url.endsWith(':publish')) {
          return createJsonResponse(200, {
            name: 'publishers/pub-1/items/ext-1',
            itemId: 'ext-1',
            state: 'PENDING_REVIEW'
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      try {
        const result = await cws.deployToChromeWebStore(
          { zipPath },
          {
            CWS_PUBLISHER_ID: 'pub-1',
            CWS_EXTENSION_ID: 'ext-1',
            CWS_CLIENT_ID: 'cid',
            CWS_CLIENT_SECRET: 'csec',
            CWS_REFRESH_TOKEN: 'rtok'
          },
          { fetchImpl: mockFetch, logger: silentLogger }
        );

        assert.equal(result.uploadResult.uploadState, 'SUCCEEDED');
        assert.equal(result.publishResult.state, 'PENDING_REVIEW');
        assert.equal(requests.length, 3);
        assert.equal(
          requests[1].url,
          'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/ext-1:upload'
        );
        assert.equal(requests[1].init.headers.Authorization, 'Bearer ya29.valid');
        assert.equal(
          requests[2].url,
          'https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/ext-1:publish'
        );
        assert.deepEqual(JSON.parse(requests[2].init.body), { publishType: 'DEFAULT_PUBLISH' });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('polls :fetchStatus when uploadState is IN_PROGRESS and skips :publish when --upload-only is set', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-test-'));
      const zipPath = path.join(tmpDir, 'ext.zip');
      fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04dummy-zip-content'));

      let statusPolls = 0;
      const mockFetch = async (url) => {
        if (url === cws.OAUTH_TOKEN_URL) {
          return createJsonResponse(200, { access_token: 'ya29.valid' });
        }
        if (url.endsWith(':upload')) {
          return createJsonResponse(200, {
            itemId: 'ext-1',
            uploadState: 'IN_PROGRESS'
          });
        }
        if (url.endsWith(':fetchStatus')) {
          statusPolls++;
          return createJsonResponse(200, {
            itemId: 'ext-1',
            lastAsyncUploadState: statusPolls < 2 ? 'IN_PROGRESS' : 'SUCCEEDED'
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      try {
        const result = await cws.deployToChromeWebStore(
          { zipPath, uploadOnly: true },
          {
            CWS_PUBLISHER_ID: 'pub-1',
            CWS_EXTENSION_ID: 'ext-1',
            CWS_CLIENT_ID: 'cid',
            CWS_CLIENT_SECRET: 'csec',
            CWS_REFRESH_TOKEN: 'rtok'
          },
          {
            fetchImpl: mockFetch,
            sleepImpl: async () => {},
            logger: silentLogger
          }
        );

        assert.equal(statusPolls, 2);
        assert.equal(result.publishResult, null);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws when async upload fails or times out during fetchStatus polling', async () => {
      await assert.rejects(
        () => cws.waitForUploadCompletion({
          publisherId: 'pub-1',
          extensionId: 'ext-1',
          accessToken: 'tok',
          sleepImpl: async () => {},
          fetchImpl: async () => createJsonResponse(200, { lastAsyncUploadState: 'FAILED' })
        }),
        /Asynchronous upload finished with non-success state: FAILED/
      );

      await assert.rejects(
        () => cws.waitForUploadCompletion({
          publisherId: 'pub-1',
          extensionId: 'ext-1',
          accessToken: 'tok',
          maxAttempts: 2,
          sleepImpl: async () => {},
          fetchImpl: async () => createJsonResponse(200, { lastAsyncUploadState: 'IN_PROGRESS' })
        }),
        /Timed out waiting for Chrome Web Store package processing after 2 attempts/
      );
    });

    it('verifies OAuth2 credentials and queries item status via --check-status without requiring --zip', async () => {
      const parsed = cws.parseArgs(['--check-status']);
      assert.equal(parsed.checkStatus, true);

      const logs = [];
      const mockFetch = async (url) => {
        if (url === cws.OAUTH_TOKEN_URL) {
          return createJsonResponse(200, { access_token: 'ya29.status-token' });
        }
        if (url.endsWith(':fetchStatus')) {
          return createJsonResponse(200, {
            itemId: 'dahnhdiabhegihofjijbchegffnkiaap',
            lastAsyncUploadState: 'SUCCEEDED',
            publishedItemRevisionStatus: {
              state: 'PUBLISHED',
              distributionChannels: [{ crxVersion: '1.0.3', deployPercentage: 100 }]
            },
            submittedItemRevisionStatus: {
              state: 'PUBLISHED'
            }
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      const status = await cws.verifyChromeWebStoreStatus(
        {},
        {
          CWS_PUBLISHER_ID: 'pub-1',
          CWS_CLIENT_ID: 'cid',
          CWS_CLIENT_SECRET: 'csec',
          CWS_REFRESH_TOKEN: 'rtok',
          GITHUB_ACTIONS: 'true'
        },
        {
          fetchImpl: mockFetch,
          logger: { log: (m) => logs.push(m), error: () => {} }
        }
      );

      assert.equal(status.itemId, 'dahnhdiabhegihofjijbchegffnkiaap');
      assert.ok(logs.some((l) => l.includes('::notice title=Chrome Web Store API v2 Verified::')));
      assert.ok(logs.some((l) => l.includes('publishedVersion=1.0.3')));
    });

    it('rejects null/non-JSON responses on HTTP 200 and rejected/cancelled publish states', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-test-'));
      const zipPath = path.join(tmpDir, 'ext.zip');
      fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04dummy-zip-content'));

      const baseEnv = {
        CWS_PUBLISHER_ID: 'pub-1',
        CWS_EXTENSION_ID: 'ext-1',
        CWS_CLIENT_ID: 'cid',
        CWS_CLIENT_SECRET: 'csec',
        CWS_REFRESH_TOKEN: 'rtok'
      };

      try {
        // 1. fetchItemStatus returning JSON "null" or HTML on HTTP 200
        await assert.rejects(
          () => cws.fetchItemStatus({
            publisherId: 'pub-1',
            extensionId: 'ext-1',
            accessToken: 'tok',
            fetchImpl: async () => createJsonResponse(200, 'null')
          }),
          /Invalid JSON response from Chrome Web Store fetchStatus endpoint/
        );

        // 2. verifyChromeWebStoreStatus receiving empty {} JSON object
        await assert.rejects(
          () => cws.verifyChromeWebStoreStatus(
            {},
            baseEnv,
            {
              logger: silentLogger,
              fetchImpl: async (url) => {
                if (url === cws.OAUTH_TOKEN_URL) return createJsonResponse(200, { access_token: 'tok' });
                return createJsonResponse(200, {});
              }
            }
          ),
          /Unexpected empty status response from Chrome Web Store API v2/
        );

        // 3. uploadPackage returning HTML on HTTP 200
        await assert.rejects(
          () => cws.uploadPackage({
            publisherId: 'pub-1',
            extensionId: 'ext-1',
            accessToken: 'tok',
            zipPath,
            fetchImpl: async () => createJsonResponse(200, '<html>Proxy</html>')
          }),
          /Invalid JSON response from Chrome Web Store upload endpoint/
        );

        // 4. deployToChromeWebStore when publishItem returns REJECTED state
        await assert.rejects(
          () => cws.deployToChromeWebStore(
            { zipPath },
            baseEnv,
            {
              logger: silentLogger,
              fetchImpl: async (url) => {
                if (url === cws.OAUTH_TOKEN_URL) return createJsonResponse(200, { access_token: 'tok' });
                if (url.endsWith(':upload')) return createJsonResponse(200, { uploadState: 'SUCCEEDED', crxVersion: '1.0.4' });
                if (url.endsWith(':publish')) return createJsonResponse(200, { state: 'REJECTED' });
                throw new Error(`Unexpected URL: ${url}`);
              }
            }
          ),
          /Chrome Web Store publish did not succeed \(state: REJECTED\)/
        );

        // 5. exchangeAuthCodeForRefreshToken returning JSON "null"
        await assert.rejects(
          () => cws.exchangeAuthCodeForRefreshToken({
            clientId: 'cid',
            clientSecret: 'csec',
            code: 'code',
            redirectUri: 'http://127.0.0.1:8818',
            fetchImpl: async () => createJsonResponse(200, 'null')
          }),
          /Failed to obtain refresh_token/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('gracefully skips duplicate upload when target version is already PUBLISHED or PENDING_REVIEW on Chrome Web Store', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-test-'));
      const zipPath = path.join(tmpDir, 'notispam-cleaner-v1.0.4.zip');
      fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04dummy-zip-content'));

      const baseEnv = {
        CWS_PUBLISHER_ID: 'pub-1',
        CWS_EXTENSION_ID: 'ext-1',
        CWS_CLIENT_ID: 'cid',
        CWS_CLIENT_SECRET: 'csec',
        CWS_REFRESH_TOKEN: 'rtok',
        GITHUB_ACTIONS: 'true'
      };

      try {
        const logs = [];
        const res = await cws.deployToChromeWebStore(
          { zipPath },
          baseEnv,
          {
            logger: { log: (m) => logs.push(m), error: () => {} },
            fetchImpl: async (url) => {
              if (url === cws.OAUTH_TOKEN_URL) return createJsonResponse(200, { access_token: 'tok' });
              if (url.endsWith(':upload')) return createJsonResponse(200, { uploadState: 'FAILURE' });
              if (url.endsWith(':fetchStatus')) {
                return createJsonResponse(200, {
                  itemId: 'ext-1',
                  publishedItemRevisionStatus: {
                    state: 'PUBLISHED',
                    distributionChannels: [{ crxVersion: '1.0.4', deployPercentage: 100 }]
                  },
                  submittedItemRevisionStatus: {
                    state: 'PUBLISHED'
                  }
                });
              }
              throw new Error(`Unexpected URL: ${url}`);
            }
          }
        );

        assert.equal(res.skippedAlreadyPublished, true);
        assert.equal(res.publishResult, null);
        assert.ok(logs.some((l) => l.includes('::notice title=Chrome Web Store Already Published::')));

        // Rethrows when published version differs and item is not PENDING_REVIEW
        await assert.rejects(
          () => cws.deployToChromeWebStore(
            { zipPath },
            baseEnv,
            {
              logger: silentLogger,
              fetchImpl: async (url) => {
                if (url === cws.OAUTH_TOKEN_URL) return createJsonResponse(200, { access_token: 'tok' });
                if (url.endsWith(':upload')) return createJsonResponse(200, { uploadState: 'FAILURE' });
                if (url.endsWith(':fetchStatus')) {
                  return createJsonResponse(200, {
                    itemId: 'ext-1',
                    publishedItemRevisionStatus: {
                      state: 'PUBLISHED',
                      distributionChannels: [{ crxVersion: '1.0.3', deployPercentage: 100 }]
                    },
                    submittedItemRevisionStatus: {
                      state: 'PUBLISHED'
                    }
                  });
                }
                throw new Error(`Unexpected URL: ${url}`);
              }
            }
          ),
          /Chrome Web Store upload did not succeed \(uploadState: FAILURE\)/
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('OAuth2 Refresh Token Helper & Workflow File Integrity', () => {
    it('builds valid Google OAuth2 authorization URL and exchanges auth code for refresh token', async () => {
      const urlStr = cws.buildAuthorizationUrl({
        clientId: '12345.apps.googleusercontent.com',
        redirectUri: 'http://127.0.0.1:8818'
      });
      const parsed = new URL(urlStr);
      assert.equal(parsed.origin + parsed.pathname, cws.OAUTH_AUTH_URL);
      assert.equal(parsed.searchParams.get('client_id'), '12345.apps.googleusercontent.com');
      assert.equal(parsed.searchParams.get('scope'), cws.CWS_SCOPE);
      assert.equal(parsed.searchParams.get('access_type'), 'offline');
      assert.equal(parsed.searchParams.get('prompt'), 'consent');

      const tokenData = await cws.runInteractiveTokenHelper({
        clientId: 'cid',
        clientSecret: 'csec',
        authCode: '4/0AeanS0-test-code',
        fetchImpl: async () => createJsonResponse(200, { refresh_token: '1//0g-new-refresh-token' }),
        logger: silentLogger
      });
      assert.equal(tokenData.refresh_token, '1//0g-new-refresh-token');
    });

    it('loopback HTTP server ignores /favicon.ico preflight, handles ?code= callback, and closes cleanly', async () => {
      let requestHandler = null;
      let serverClosed = false;
      let connectionsClosed = false;

      const mockHttp = {
        createServer: (handler) => {
          requestHandler = handler;
          return {
            on: () => {},
            listen: (_port, _host, cb) => cb(),
            close: () => { serverClosed = true; },
            closeAllConnections: () => { connectionsClosed = true; }
          };
        }
      };

      const makeMockRes = () => {
        const res = {
          statusCode: null,
          headers: null,
          body: '',
          writeHead(status, headers) {
            this.statusCode = status;
            this.headers = headers;
          },
          end(str = '') {
            this.body = str;
          }
        };
        return res;
      };

      const helperPromise = cws.runInteractiveTokenHelper({
        clientId: 'cid',
        clientSecret: 'csec',
        port: 8818,
        httpImpl: mockHttp,
        fetchImpl: async () => createJsonResponse(200, { refresh_token: '1//0g-loopback-token' }),
        logger: silentLogger
      });

      // 1. Browser requests /favicon.ico without ?code= -> returns 200 without closing server
      const faviconRes = makeMockRes();
      await requestHandler({ url: '/favicon.ico' }, faviconRes);
      assert.equal(faviconRes.statusCode, 200);
      assert.equal(serverClosed, false);

      // 2. Browser requests /?code=4/oauth-code -> exchanges code, closes server & connections, resolves
      const codeRes = makeMockRes();
      await requestHandler({ url: '/?code=4/oauth-code' }, codeRes);
      const result = await helperPromise;

      assert.equal(codeRes.statusCode, 200);
      assert.equal(codeRes.headers.Connection, 'close');
      assert.equal(serverClosed, true);
      assert.equal(connectionsClosed, true);
      assert.equal(result.refresh_token, '1//0g-loopback-token');
    });

    it('loopback HTTP server rejects cleanly on OAuth ?error= callback and port-binding errors', async () => {
      let requestHandler = null;
      let errorHandler = null;
      let serverClosed = false;

      const mockHttp = {
        createServer: (handler) => {
          requestHandler = handler;
          return {
            on: (evt, cb) => { if (evt === 'error') errorHandler = cb; },
            listen: (_port, _host, cb) => cb(),
            close: () => { serverClosed = true; },
            closeAllConnections: () => {}
          };
        }
      };

      const errorPromise = cws.runInteractiveTokenHelper({
        clientId: 'cid',
        clientSecret: 'csec',
        port: 8818,
        httpImpl: mockHttp,
        logger: silentLogger
      });

      const errRes = {
        writeHead() {},
        end() {}
      };
      await requestHandler({ url: '/?error=access_denied' }, errRes);
      await assert.rejects(errorPromise, /OAuth authorization error: access_denied/);
      assert.equal(serverClosed, true);

      // Port binding error (e.g. EADDRINUSE)
      const bindErrorHttp = {
        createServer: () => ({
          on: (evt, cb) => { if (evt === 'error') errorHandler = cb; },
          listen: () => { errorHandler(new Error('listen EADDRINUSE: address already in use 127.0.0.1:8818')); }
        })
      };
      await assert.rejects(
        () => cws.runInteractiveTokenHelper({
          clientId: 'cid',
          clientSecret: 'csec',
          port: 8818,
          httpImpl: bindErrorHttp,
          logger: silentLogger
        }),
        /EADDRINUSE/
      );

      // Invalid port rejected before starting server
      await assert.rejects(
        () => cws.runInteractiveTokenHelper({ clientId: 'cid', clientSecret: 'csec', port: 0 }),
        /Invalid port/
      );
    });

    it('workflow file .github/workflows/release.yml exists and configures CI/CD and CWS API v2 secrets', () => {
      const workflowPath = path.resolve(__dirname, '../.github/workflows/release.yml');
      assert.ok(fs.existsSync(workflowPath), 'Missing .github/workflows/release.yml');
      const content = fs.readFileSync(workflowPath, 'utf8');

      assert.match(content, /npm test/);
      assert.match(content, /node scripts\/cws-publish\.js/);
      assert.match(content, /zipinfo -1 "\$ZIP_NAME" \| grep -qx "manifest\.json"/);
      assert.match(content, /zipinfo -1 "\$ZIP_NAME" \| grep -E "\(\^\|\/\)scripts\(\/\|\$\)\|\(\^\|\/\)\\\.DS_Store\$"/);
      assert.match(content, /inputs\.publish_target == 'draft' \|\| inputs\.publish_target == 'publish'/);
      assert.match(content, /CWS_PUBLISHER_ID:\s*\$\{\{\s*secrets\.CWS_PUBLISHER_ID\s*\}\}/);
      assert.match(content, /CWS_EXTENSION_ID:\s*\$\{\{\s*secrets\.CWS_EXTENSION_ID/);
      assert.match(content, /CWS_CLIENT_ID:\s*\$\{\{\s*secrets\.CWS_CLIENT_ID\s*\}\}/);
      assert.match(content, /CWS_CLIENT_SECRET:\s*\$\{\{\s*secrets\.CWS_CLIENT_SECRET\s*\}\}/);
      assert.match(content, /CWS_REFRESH_TOKEN:\s*\$\{\{\s*secrets\.CWS_REFRESH_TOKEN\s*\}\}/);
    });
  });
});
