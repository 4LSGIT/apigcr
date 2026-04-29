// test/oauthService.test.js
//
// Tests run with `node --test`. No external test framework dep.
//
// Strategy:
//   - Stand up a tiny local HTTP server per test, configured to behave as
//     the OAuth token / authorize / revoke endpoint.
//   - Mock the db with an in-memory credentials table that responds to the
//     specific SQL patterns oauthService and credentialInjection emit.
//   - GET_LOCK / RELEASE_LOCK are simulated with a Map of held lock keys
//     so we can assert correct lock acquire/release behavior.

process.env.CREDENTIALS_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
process.env.APP_URL = 'https://app.4lsg.com';
process.env.INTERNAL_API_KEY = 'test-internal-key';
process.env.ENVIRONMENT = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');

const { encrypt, decrypt } = require('../lib/credentialCrypto');
const oauthService = require('../services/oauthService');
const credentialInjection = require('../lib/credentialInjection');

// ─────────────────────────────────────────────────────────────
// Mock DB
// ─────────────────────────────────────────────────────────────

function makeDb() {
  const rows = new Map();   // id → row
  const locks = new Map();  // lockKey → boolean (held)
  const calls = [];         // [{sql, params}] for assertions

  let nextId = 1;

  async function query(sql, params = []) {
    calls.push({ sql: sql.trim().replace(/\s+/g, ' '), params: [...params] });
    const norm = sql.trim().toLowerCase().replace(/\s+/g, ' ');

    // GET_LOCK
    if (norm.startsWith('select get_lock')) {
      const [key /*, timeout */] = params;
      // Simulate "lock contention" if key already held — return 0.
      if (locks.get(key)) return [[{ lockAcquired: 0 }]];
      locks.set(key, true);
      return [[{ lockAcquired: 1 }]];
    }
    // RELEASE_LOCK
    if (norm.startsWith('select release_lock')) {
      const [key] = params;
      locks.delete(key);
      return [[{ released: 1 }]];
    }

    // SELECT … FROM credentials WHERE id = ?
    if (norm.includes('from credentials') && norm.includes('where id = ?')) {
      const [id] = params;
      const row = rows.get(Number(id));
      return [[row || undefined]];
    }
    // SELECT … FROM credentials WHERE oauth_state = ?
    if (norm.includes('from credentials') && norm.includes('where oauth_state = ?')) {
      const [state] = params;
      const row = [...rows.values()].find((r) => r.oauth_state === state && r.type === 'oauth2');
      return [[row || undefined]];
    }
    // UPDATE credentials SET ... WHERE id = ?
    if (norm.startsWith('update credentials set')) {
      const id = Number(params[params.length - 1]);
      const row = rows.get(id);
      if (!row) return [{ affectedRows: 0 }];
      // Parse SET clauses out of the SQL, mapping `col = ?` to params in order.
      // Skip non-? assignments (like NOW(), NULL, literal strings).
      const setClause = sql.match(/SET\s+(.+?)\s+WHERE/is)[1];
      const assignments = setClause.split(',').map((s) => s.trim());
      let pIdx = 0;
      for (const a of assignments) {
        const m = a.match(/^([a-z_]+)\s*=\s*(.+)$/i);
        if (!m) continue;
        const col = m[1];
        const val = m[2].trim();
        if (val === '?') {
          row[col] = params[pIdx++];
        } else if (/^now\(\)$/i.test(val)) {
          row[col] = new Date();
        } else if (/^null$/i.test(val)) {
          row[col] = null;
        } else if (/^'.*'$/.test(val)) {
          row[col] = val.slice(1, -1);
        } else if (/^[a-z_]+\s*\+\s*\d+$/i.test(val)) {
          // e.g. "refresh_failure_count + 1"
          const [colName, incStr] = val.split('+').map((s) => s.trim());
          row[colName] = (row[colName] || 0) + Number(incStr);
        } else if (/^-?\d+(\.\d+)?$/.test(val)) {
          // numeric literal e.g. "refresh_failure_count = 0"
          row[col] = Number(val);
        }
      }
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Mock DB got unrecognized SQL: ${sql}`);
  }

  function seed(row) {
    const id = row.id || nextId++;
    nextId = Math.max(nextId, id + 1);
    const full = {
      id, name: 'test', type: 'oauth2',
      config: null, allowed_urls: null,
      access_token: null, refresh_token: null,
      access_token_expires_at: null, refresh_token_expires_at: null,
      last_refreshed_at: null,
      oauth_status: 'pending_auth',
      oauth_state: null, oauth_pkce_verifier: null,
      oauth_last_error: null, oauth_last_error_at: null,
      refresh_failure_count: 0,
      verbose: 0,
      ...row,
    };
    rows.set(id, full);
    return id;
  }

  return { query, seed, rows, locks, calls };
}

// ─────────────────────────────────────────────────────────────
// Mock OAuth provider
// ─────────────────────────────────────────────────────────────

function startMockProvider({ tokenHandler, revokeHandler } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      const captured = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
        params: Object.fromEntries(new URLSearchParams(body)),
      };
      requests.push(captured);

      if (req.url === '/token' && tokenHandler) {
        const result = await tokenHandler(captured);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
        return;
      }
      if (req.url === '/revoke' && revokeHandler) {
        const result = await revokeHandler(captured);
        res.writeHead(result.status, { 'Content-Type': result.contentType || 'text/plain' });
        res.end(result.body || '');
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Helper: build a config object
// ─────────────────────────────────────────────────────────────

function makeConfig(provider, overrides = {}) {
  return {
    client_id: 'CLIENT_ID',
    client_secret: encrypt('CLIENT_SECRET'),
    auth_url: `${provider.url}/authorize`,
    token_url: `${provider.url}/token`,
    revoke_url: `${provider.url}/revoke`,
    scopes: ['read', 'write'],
    use_pkce: false,
    extra_authorize_params: {},
    extra_token_params: {},
    extra_refresh_params: {},
    client_auth_method: 'basic',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

test('PKCE: verifier is 128 chars base64url, S256 challenge matches sha256', () => {
  const { generatePkceVerifier, pkceChallenge, base64UrlEncode } = oauthService._internals;
  const verifier = generatePkceVerifier();
  assert.strictEqual(verifier.length, 128);
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/);
  const challenge = pkceChallenge(verifier);
  const expected = base64UrlEncode(crypto.createHash('sha256').update(verifier).digest());
  assert.strictEqual(challenge, expected);
});

test('buildAuthorizationUrl: includes all required params, scopes joined with space, state stored', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({ config: makeConfig(provider) });

  const url = await oauthService.buildAuthorizationUrl(db, id, 'https://app.4lsg.com/oauth/cb');
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('response_type'), 'code');
  assert.strictEqual(u.searchParams.get('client_id'), 'CLIENT_ID');
  assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://app.4lsg.com/oauth/cb');
  assert.strictEqual(u.searchParams.get('scope'), 'read write');
  assert.match(u.searchParams.get('state'), /^[0-9a-f]{64}$/);
  assert.strictEqual(u.searchParams.get('code_challenge'), null); // PKCE off

  const row = db.rows.get(id);
  assert.strictEqual(row.oauth_state, u.searchParams.get('state'));
  assert.strictEqual(row.oauth_status, 'pending_auth');
  assert.strictEqual(row.oauth_pkce_verifier, null);
  await provider.close();
});

test('buildAuthorizationUrl: with PKCE includes S256 challenge and stores verifier', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({ config: makeConfig(provider, { use_pkce: true }) });

  const url = await oauthService.buildAuthorizationUrl(db, id, 'https://app.4lsg.com/oauth/cb');
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
  const challenge = u.searchParams.get('code_challenge');
  assert.ok(challenge && challenge.length > 30);

  const row = db.rows.get(id);
  assert.ok(row.oauth_pkce_verifier);
  assert.strictEqual(row.oauth_pkce_verifier.length, 128);

  // Verify challenge is correct S256 of stored verifier
  const expected = oauthService._internals.base64UrlEncode(
    crypto.createHash('sha256').update(row.oauth_pkce_verifier).digest()
  );
  assert.strictEqual(challenge, expected);
  await provider.close();
});

test('buildAuthorizationUrl: extra_authorize_params merged into URL', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider, {
      extra_authorize_params: { access_type: 'offline', prompt: 'consent' },
    }),
  });
  const url = await oauthService.buildAuthorizationUrl(db, id, 'https://app.4lsg.com/cb');
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('access_type'), 'offline');
  assert.strictEqual(u.searchParams.get('prompt'), 'consent');
  await provider.close();
});

test('exchangeCodeForTokens: stores encrypted tokens, sets connected, clears state/verifier', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => ({
      status: 200,
      body: {
        access_token: 'AT_FIRST',
        refresh_token: 'RT_FIRST',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'read write',
      },
    }),
  });
  const db = makeDb();
  const id = db.seed({ config: makeConfig(provider) });
  await oauthService.buildAuthorizationUrl(db, id, 'https://app.4lsg.com/cb');
  const state = db.rows.get(id).oauth_state;

  const result = await oauthService.exchangeCodeForTokens(db, state, 'AUTH_CODE', 'https://app.4lsg.com/cb');
  assert.strictEqual(result.credentialId, id);

  const row = db.rows.get(id);
  assert.strictEqual(row.oauth_status, 'connected');
  assert.strictEqual(row.oauth_state, null);
  assert.strictEqual(row.oauth_pkce_verifier, null);
  assert.strictEqual(decrypt(row.access_token), 'AT_FIRST');
  assert.strictEqual(decrypt(row.refresh_token), 'RT_FIRST');
  assert.ok(row.access_token_expires_at instanceof Date);
  assert.ok(row.last_refreshed_at instanceof Date);
  assert.strictEqual(row.refresh_failure_count, 0);

  // Verify the request used Basic auth (default client_auth_method)
  const req = provider.requests[0];
  assert.match(req.headers.authorization, /^Basic /);
  assert.strictEqual(req.params.grant_type, 'authorization_code');
  assert.strictEqual(req.params.code, 'AUTH_CODE');
  assert.strictEqual(req.params.code_verifier, undefined); // PKCE off
  await provider.close();
});

test('exchangeCodeForTokens: client_auth_method=body sends client_id+secret in body', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => ({
      status: 200,
      body: { access_token: 'A', refresh_token: 'R', expires_in: 3600 },
    }),
  });
  const db = makeDb();
  const id = db.seed({ config: makeConfig(provider, { client_auth_method: 'body' }) });
  await oauthService.buildAuthorizationUrl(db, id, 'https://app.4lsg.com/cb');
  const state = db.rows.get(id).oauth_state;
  await oauthService.exchangeCodeForTokens(db, state, 'CODE', 'https://app.4lsg.com/cb');

  const req = provider.requests[0];
  assert.strictEqual(req.headers.authorization, undefined);
  assert.strictEqual(req.params.client_id, 'CLIENT_ID');
  assert.strictEqual(req.params.client_secret, 'CLIENT_SECRET');
  await provider.close();
});

test('exchangeCodeForTokens: PKCE sends code_verifier', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => ({
      status: 200,
      body: { access_token: 'A', expires_in: 3600 },
    }),
  });
  const db = makeDb();
  const id = db.seed({ config: makeConfig(provider, { use_pkce: true }) });
  await oauthService.buildAuthorizationUrl(db, id, 'https://app.4lsg.com/cb');
  const verifier = db.rows.get(id).oauth_pkce_verifier;
  const state = db.rows.get(id).oauth_state;
  await oauthService.exchangeCodeForTokens(db, state, 'CODE', 'https://app.4lsg.com/cb');

  const req = provider.requests[0];
  assert.strictEqual(req.params.code_verifier, verifier);
  await provider.close();
});

test('exchangeCodeForTokens: bad state throws', async () => {
  const db = makeDb();
  await assert.rejects(
    oauthService.exchangeCodeForTokens(db, 'bogus_state', 'CODE', 'cb'),
    /No credential matches this state token/
  );
});

test('refreshTokens: updates tokens, resets failure count, sets last_refreshed_at', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => ({
      status: 200,
      body: { access_token: 'AT_NEW', refresh_token: 'RT_NEW', expires_in: 3600 },
    }),
  });
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('AT_OLD'),
    refresh_token: encrypt('RT_OLD'),
    access_token_expires_at: new Date(Date.now() - 1000), // expired
    oauth_status: 'connected',
    refresh_failure_count: 3,
    oauth_last_error: 'previous err',
  });

  await oauthService.refreshTokens(db, id);

  const row = db.rows.get(id);
  assert.strictEqual(decrypt(row.access_token), 'AT_NEW');
  assert.strictEqual(decrypt(row.refresh_token), 'RT_NEW');
  assert.strictEqual(row.refresh_failure_count, 0);
  assert.strictEqual(row.oauth_last_error, null);
  assert.strictEqual(row.oauth_status, 'connected');

  // Lock should be released
  assert.strictEqual(db.locks.size, 0);

  // Token POST should have used grant_type=refresh_token with old refresh
  const req = provider.requests[0];
  assert.strictEqual(req.params.grant_type, 'refresh_token');
  assert.strictEqual(req.params.refresh_token, 'RT_OLD');
  await provider.close();
});

test('refreshTokens: refresh-token rotation — keeps existing when response omits refresh_token', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => ({
      status: 200,
      body: { access_token: 'AT_NEW', expires_in: 3600 }, // NO refresh_token
    }),
  });
  const db = makeDb();
  const oldRtEncrypted = encrypt('RT_KEEP');
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('AT_OLD'),
    refresh_token: oldRtEncrypted,
    access_token_expires_at: new Date(Date.now() - 1000),
    oauth_status: 'connected',
  });

  await oauthService.refreshTokens(db, id);

  const row = db.rows.get(id);
  assert.strictEqual(decrypt(row.access_token), 'AT_NEW');
  // refresh_token unchanged
  assert.strictEqual(decrypt(row.refresh_token), 'RT_KEEP');
  await provider.close();
});

test('refreshTokens: failure increments counter, alert + status flip at exactly threshold', async () => {
  // To assert that exactly one Pabbly alert fires at the threshold, swap
  // node-fetch BEFORE re-requiring oauthService (the module captures fetch
  // at load time, so post-hoc cache mutation alone is insufficient).
  const fetchPath = require.resolve('node-fetch');
  const origFetch = require.cache[fetchPath].exports;
  let pabblyAlertCount = 0;
  const captured = [];
  const wrappedFetch = async (url, opts) => {
    if (typeof url === 'string' && url.includes('pabbly.com')) {
      pabblyAlertCount++;
      captured.push(JSON.parse(opts.body));
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    }
    return origFetch(url, opts);
  };
  require.cache[fetchPath].exports = wrappedFetch;

  // Force re-load of oauthService with our wrapped fetch
  delete require.cache[require.resolve('../services/oauthService')];
  const isolatedOauthService = require('../services/oauthService');

  try {
    const provider = await startMockProvider({
      tokenHandler: async () => ({ status: 400, body: '{"error":"invalid_grant"}' }),
    });
    const db = makeDb();
    const id = db.seed({
      name: 'TestCred',
      config: makeConfig(provider),
      access_token: encrypt('AT'),
      refresh_token: encrypt('RT'),
      access_token_expires_at: new Date(Date.now() - 1000),
      oauth_status: 'connected',
      refresh_failure_count: 0,
    });

    // Failure 1: count → 1, status stays connected, NO alert
    await assert.rejects(isolatedOauthService.refreshTokens(db, id), /400/);
    let row = db.rows.get(id);
    assert.strictEqual(row.refresh_failure_count, 1);
    assert.strictEqual(row.oauth_status, 'connected');
    assert.match(row.oauth_last_error, /400.*invalid_grant/);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pabblyAlertCount, 0, 'no alert at count=1');

    // Failure 2: count → 2, status flips, exactly ONE alert fires
    await assert.rejects(isolatedOauthService.refreshTokens(db, id), /400/);
    row = db.rows.get(id);
    assert.strictEqual(row.refresh_failure_count, 2);
    assert.strictEqual(row.oauth_status, 'refresh_failed');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pabblyAlertCount, 1, 'exactly one alert at threshold');
    assert.strictEqual(captured[0].error_type, 'oauth_refresh_failed');
    assert.strictEqual(captured[0].credential_id, id);
    assert.strictEqual(captured[0].credential_name, 'TestCred');

    // Failure 3: count → 3, no second alert (the `=== threshold` guard)
    await assert.rejects(isolatedOauthService.refreshTokens(db, id), /400/);
    row = db.rows.get(id);
    assert.strictEqual(row.refresh_failure_count, 3);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pabblyAlertCount, 1, 'still exactly one alert at count=3');

    await provider.close();
  } finally {
    // Restore real fetch and reload the module
    require.cache[fetchPath].exports = origFetch;
    delete require.cache[require.resolve('../services/oauthService')];
  }
});

test('refreshTokens: in-process dedup — concurrent calls share one HTTP request', async () => {
  let httpCalls = 0;
  const provider = await startMockProvider({
    tokenHandler: async () => {
      httpCalls++;
      // Slow response so concurrent calls overlap
      await new Promise((r) => setTimeout(r, 50));
      return { status: 200, body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } };
    },
  });
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('OLD'),
    refresh_token: encrypt('OLD_RT'),
    access_token_expires_at: new Date(Date.now() - 1000),
    oauth_status: 'connected',
  });

  await Promise.all([
    oauthService.refreshTokens(db, id),
    oauthService.refreshTokens(db, id),
    oauthService.refreshTokens(db, id),
  ]);

  assert.strictEqual(httpCalls, 1, 'should dedup to single HTTP refresh');
  await provider.close();
});

test('getValidAccessToken: returns existing token when expiry is far future', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => { throw new Error('should not be called'); },
  });
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('FRESH_TOKEN'),
    refresh_token: encrypt('RT'),
    access_token_expires_at: new Date(Date.now() + 3600 * 1000), // 1h
    oauth_status: 'connected',
  });

  const token = await oauthService.getValidAccessToken(db, id);
  assert.strictEqual(token, 'FRESH_TOKEN');
  assert.strictEqual(provider.requests.length, 0);
  await provider.close();
});

test('getValidAccessToken: refreshes when within 120s window', async () => {
  const provider = await startMockProvider({
    tokenHandler: async () => ({
      status: 200,
      body: { access_token: 'REFRESHED', expires_in: 3600 },
    }),
  });
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('STALE'),
    refresh_token: encrypt('RT'),
    access_token_expires_at: new Date(Date.now() + 60 * 1000), // 60s — within window
    oauth_status: 'connected',
  });

  const token = await oauthService.getValidAccessToken(db, id);
  assert.strictEqual(token, 'REFRESHED');
  assert.strictEqual(provider.requests.length, 1);
  await provider.close();
});

test('getValidAccessToken: refuses when status != connected', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('X'),
    access_token_expires_at: new Date(Date.now() + 3600 * 1000),
    oauth_status: 'refresh_failed',
  });
  await assert.rejects(oauthService.getValidAccessToken(db, id), /not connected/);
  await provider.close();
});

test('revokeTokens: posts to revoke_url, clears local tokens, sets revoked', async () => {
  let revokeCalled = false;
  const provider = await startMockProvider({
    revokeHandler: async (req) => {
      revokeCalled = true;
      assert.match(req.headers.authorization, /^Basic /);
      assert.strictEqual(req.params.token, 'AT_TO_REVOKE');
      return { status: 200, body: '' };
    },
  });
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('AT_TO_REVOKE'),
    refresh_token: encrypt('RT'),
    oauth_status: 'connected',
  });

  const result = await oauthService.revokeTokens(db, id);
  assert.deepStrictEqual(result, { revokedAtProvider: true });
  assert.strictEqual(revokeCalled, true);

  const row = db.rows.get(id);
  assert.strictEqual(row.access_token, null);
  assert.strictEqual(row.refresh_token, null);
  assert.strictEqual(row.oauth_status, 'revoked');
  await provider.close();
});

test('revokeTokens: provider failure — still clears locally, returns error', async () => {
  const provider = await startMockProvider({
    revokeHandler: async () => ({ status: 500, body: 'oops' }),
  });
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('AT'),
    refresh_token: encrypt('RT'),
    oauth_status: 'connected',
  });

  const result = await oauthService.revokeTokens(db, id);
  assert.strictEqual(result.revokedAtProvider, false);
  assert.match(result.providerError, /500/);

  const row = db.rows.get(id);
  assert.strictEqual(row.access_token, null);
  assert.strictEqual(row.oauth_status, 'revoked');
  await provider.close();
});

test('revokeTokens: no revoke_url configured — clears locally, no provider call', async () => {
  const provider = await startMockProvider({
    revokeHandler: async () => { throw new Error('should not be called'); },
  });
  const db = makeDb();
  const cfg = makeConfig(provider);
  delete cfg.revoke_url;
  const id = db.seed({
    config: cfg,
    access_token: encrypt('AT'),
    oauth_status: 'connected',
  });

  const result = await oauthService.revokeTokens(db, id);
  assert.deepStrictEqual(result, { revokedAtProvider: false });
  assert.strictEqual(db.rows.get(id).oauth_status, 'revoked');
  await provider.close();
});

// ─────────────────────────────────────────────────────────────
// credentialInjection oauth2 path
// ─────────────────────────────────────────────────────────────

test('buildHeadersForCredential: oauth2 connected returns Authorization: Bearer', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('THE_ACCESS_TOKEN'),
    access_token_expires_at: new Date(Date.now() + 3600 * 1000),
    oauth_status: 'connected',
  });

  const headers = await credentialInjection.buildHeadersForCredential(db, id, 'https://api.example.com/v1/foo');
  assert.deepStrictEqual(headers, { 'Authorization': 'Bearer THE_ACCESS_TOKEN' });
  await provider.close();
});

test('buildHeadersForCredential: oauth2 not connected returns {}', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    access_token: encrypt('X'),
    access_token_expires_at: new Date(Date.now() + 3600 * 1000),
    oauth_status: 'pending_auth',
  });
  const headers = await credentialInjection.buildHeadersForCredential(db, id, 'https://x.com/');
  assert.deepStrictEqual(headers, {});
  await provider.close();
});

test('buildHeadersForCredential: oauth2 with allowed_urls — denied URL returns {}', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    allowed_urls: JSON.stringify(['https://api.allowed.com/*']),
    access_token: encrypt('X'),
    access_token_expires_at: new Date(Date.now() + 3600 * 1000),
    oauth_status: 'connected',
  });
  const headers = await credentialInjection.buildHeadersForCredential(db, id, 'https://api.evil.com/foo');
  assert.deepStrictEqual(headers, {});
  await provider.close();
});

test('buildHeadersForCredential: oauth2 with allowed_urls — matching URL returns header', async () => {
  const provider = await startMockProvider();
  const db = makeDb();
  const id = db.seed({
    config: makeConfig(provider),
    allowed_urls: JSON.stringify(['https://api.allowed.com/*']),
    access_token: encrypt('TOK'),
    access_token_expires_at: new Date(Date.now() + 3600 * 1000),
    oauth_status: 'connected',
  });
  const headers = await credentialInjection.buildHeadersForCredential(db, id, 'https://api.allowed.com/v1/foo');
  assert.deepStrictEqual(headers, { 'Authorization': 'Bearer TOK' });
  await provider.close();
});

test('buildAuthHeaders: oauth2 type returns {} (sync path safety)', () => {
  const headers = credentialInjection.buildAuthHeaders(
    { id: 9, type: 'oauth2', config: '{}', allowed_urls: null },
    'https://x.com/'
  );
  assert.deepStrictEqual(headers, {});
});

test('buildAuthHeaders: bearer + allowed_urls match still works (regression)', () => {
  const headers = credentialInjection.buildAuthHeaders(
    {
      id: 1, type: 'bearer',
      config: JSON.stringify({ token: 'abc' }),
      allowed_urls: JSON.stringify(['https://api.example.com/*']),
    },
    'https://api.example.com/v1/foo'
  );
  assert.deepStrictEqual(headers, { 'Authorization': 'Bearer abc' });
});

test('buildAuthHeaders: internal type still gates on APP_URL (regression)', () => {
  const headers = credentialInjection.buildAuthHeaders(
    { id: 1, type: 'internal', config: '{}', allowed_urls: null },
    'https://app.4lsg.com/internal/sms/send'
  );
  assert.deepStrictEqual(headers, { 'x-api-key': 'test-internal-key' });

  const denied = credentialInjection.buildAuthHeaders(
    { id: 1, type: 'internal', config: '{}', allowed_urls: null },
    'https://evil.com/'
  );
  assert.deepStrictEqual(denied, {});
});