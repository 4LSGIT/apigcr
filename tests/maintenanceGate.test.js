/**
 * tests/maintenanceGate.test.js
 *
 * lib/maintenance.js — the MAINTENANCE_MODE gate.
 *
 * WHAT IS LOCKED SHUT
 *   1. INERT WHEN OFF. The gate ships to production long before it is used;
 *      with MAINTENANCE_MODE unset (or anything other than exactly '1') every
 *      request passes through untouched.
 *   2. WHEN ON, EXACTLY ONE DOOR IS OPEN: POST /hooks/:slug. Not GET, not a
 *      deeper path, not /api/hooks (management), and — critically — not
 *      /internal/hook-replay: a spool queue resumed too early must bounce off
 *      a 503 and retry, never execute against a frozen database.
 *   3. THE 503 IS HONEST AND USABLE: Retry-After, no-store, an HTML page for a
 *      browser navigation and JSON for everything else, and the operator's
 *      message can never inject markup.
 *   4. WIRING: server.js mounts the gate after cors + the build stamp and
 *      before the body parsers, static files and the 5xx observer. The order
 *      is asserted against the source because a wrong order still "works" in
 *      every other test — it would only show up as alerts written into a
 *      frozen database, or as a 503 the browser cannot read.
 *
 * Run: npx jest tests/maintenanceGate.test.js
 */

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const maintenance = require('../lib/maintenance');

const ENV_KEYS = ['MAINTENANCE_MODE', 'MAINTENANCE_RETRY_AFTER', 'MAINTENANCE_MESSAGE'];
const saved = {};
let server, base;
const reached = [];   // every request that got PAST the gate

beforeAll((done) => {
  const app = express();
  app.use(maintenance.gate());
  app.use((req, res) => {
    reached.push(`${req.method} ${req.path}`);
    res.json({ passed: true, path: req.path });
  });
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  reached.length = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const call = (method, p, headers = {}) =>
  fetch(base + p, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' });

describe('isOn / env parsing', () => {
  test.each([
    ['1', true], [' 1 ', true],
    ['0', false], ['', false], ['true', false], ['on', false], ['yes', false], ['11', false],
  ])('MAINTENANCE_MODE=%j → %s', (val, expected) => {
    expect(maintenance.isOn({ MAINTENANCE_MODE: val })).toBe(expected);
  });

  test('unset → off', () => {
    expect(maintenance.isOn({})).toBe(false);
    expect(maintenance.isOn({ MAINTENANCE_MODE: undefined })).toBe(false);
  });

  test('Retry-After: default, explicit, capped at a day, garbage falls back', () => {
    expect(maintenance.retryAfterSeconds({})).toBe(900);
    expect(maintenance.retryAfterSeconds({ MAINTENANCE_RETRY_AFTER: '120' })).toBe(120);
    expect(maintenance.retryAfterSeconds({ MAINTENANCE_RETRY_AFTER: '999999' })).toBe(86400);
    expect(maintenance.retryAfterSeconds({ MAINTENANCE_RETRY_AFTER: '-5' })).toBe(900);
    expect(maintenance.retryAfterSeconds({ MAINTENANCE_RETRY_AFTER: 'soon' })).toBe(900);
  });
});

describe('gate OFF — inert', () => {
  test.each([
    ['GET', '/'], ['GET', '/api/cases'], ['POST', '/api/cases'], ['POST', '/hooks/abc'],
    ['POST', '/internal/hook-replay'], ['POST', '/process-jobs'], ['DELETE', '/api/x/1'],
  ])('%s %s passes through', async (method, p) => {
    const res = await call(method, p);
    expect(res.status).toBe(200);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(reached).toEqual([`${method} ${p}`]);
  });

  test("MAINTENANCE_MODE='0' is off", async () => {
    process.env.MAINTENANCE_MODE = '0';
    expect((await call('GET', '/api/cases')).status).toBe(200);
  });
});

describe('gate ON', () => {
  beforeEach(() => { process.env.MAINTENANCE_MODE = '1'; });

  test.each([
    ['POST', '/hooks/rc-call'],
    ['POST', '/hooks/rc-call/'],
    ['POST', '/hooks/site-lead-form'],
    ['POST', '/hooks/_catchall'],
    // Express routes case-insensitively: a sender configured with another
    // casing reaches the receiver today, so the gate must let it through too.
    ['POST', '/Hooks/rc-call'],
    ['POST', '/HOOKS/rc-call/'],
  ])('%s %s — the capture path — is let through', async (method, p) => {
    const res = await call(method, p);
    expect(res.status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  test.each([
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/api/cases'],
    ['POST', '/api/cases'],
    ['PUT', '/api/cases/1'],
    ['DELETE', '/api/cases/1'],
    ['GET', '/hooks/rc-call'],            // only POST is the receiver
    ['PUT', '/hooks/rc-call'],
    ['POST', '/hooks'],                   // no slug
    ['POST', '/hooks/'],
    ['POST', '/hooks/rc-call/extra'],     // deeper path is not the receiver
    ['POST', '/api/hooks'],               // management API
    ['POST', '/api/hooks/7/live-test'],
    ['POST', '/internal/hook-replay'],    // replay must NOT run during the freeze
    ['POST', '/process-jobs'],
    ['POST', '/process-job/12'],
    ['POST', '/process-domain-event/12'],
    ['POST', '/mailbox-ingest'],
    ['POST', '/api/email/ingest'],
    ['POST', '/webhooks/esign/zoho'],
    ['POST', '/api/readonly/sql'],
    ['POST', '/login'],
    ['POST', '/api/book/consult'],
    ['GET', '/t/abcdefghijkl'],
    ['POST', '/hooksx/abc'],
    ['POST', '/HOOKS/rc-call/extra'],
    ['GET', '/Hooks/rc-call'],
    ['POST', '/p/some-landing-page'],
  ])('%s %s → 503 and never reaches a route', async (method, p) => {
    const res = await call(method, p);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(reached).toEqual([]);
  });

  test('non-browser callers get JSON with a machine-readable status', async () => {
    const res = await call('POST', '/api/cases', { Accept: '*/*' });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual({
      status: 'maintenance', error: 'maintenance',
      message: maintenance.DEFAULT_MESSAGE, retry_after: 900,
    });
  });

  test('a GET with Accept */* (curl, fetch, Cloud Scheduler) is JSON, not the page', async () => {
    const res = await call('GET', '/api/system-status', { Accept: '*/*' });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  test('a browser navigation gets the self-contained HTML page', async () => {
    const res = await call('GET', '/', {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toMatch(/Down for maintenance/);
    expect(html).toContain('http-equiv="refresh"');
    // Every other route is closed, so the page must not depend on any of them.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/src=/i);
  });

  test('a browser FORM POST (stale landing-page tab) gets the page, not raw JSON', async () => {
    const res = await call('POST', '/p/some-landing-page', {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('900');
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/Down for maintenance/);
    expect(reached).toEqual([]);
  });

  test.each([
    ['*/*'], ['application/json'], ['application/json, text/plain, */*'],
  ])('a programmatic POST (Accept: %s) gets JSON', async (accept) => {
    const res = await call('POST', '/api/cases', { Accept: accept });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  test('MAINTENANCE_RETRY_AFTER and MAINTENANCE_MESSAGE are honoured', async () => {
    process.env.MAINTENANCE_RETRY_AFTER = '300';
    process.env.MAINTENANCE_MESSAGE = 'Back by 6:00 AM.';
    const res = await call('GET', '/api/x', { Accept: 'application/json' });
    expect(res.headers.get('retry-after')).toBe('300');
    expect(await res.json()).toMatchObject({ message: 'Back by 6:00 AM.', retry_after: 300 });
  });

  test('the operator message is HTML-escaped in the page', async () => {
    process.env.MAINTENANCE_MESSAGE = 'Back <b>soon</b> & "safe" <script>alert(1)</script>';
    const html = await (await call('GET', '/', { Accept: 'text/html' })).text();
    expect(html).toContain('Back &lt;b&gt;soon&lt;/b&gt; &amp; &quot;safe&quot; &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<b>soon</b>');
  });

  test('flipping the env back off re-opens everything without a remount', async () => {
    expect((await call('GET', '/api/cases')).status).toBe(503);
    delete process.env.MAINTENANCE_MODE;
    expect((await call('GET', '/api/cases')).status).toBe(200);
  });
});

describe('server.js wiring (source order)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = (needle) => {
    const i = src.indexOf(needle);
    if (i < 0) throw new Error(`server.js no longer contains: ${needle}`);
    return i;
  };
  const gateAt = at('require("./lib/maintenance").gate()');

  test('mounted exactly once', () => {
    expect(src.split('require("./lib/maintenance").gate()').length - 1).toBe(1);
  });

  test('AFTER cors and the build-header stamp', () => {
    expect(gateAt).toBeGreaterThan(at('app.use(cors(corsOptions))'));
    expect(gateAt).toBeGreaterThan(at('res.set("X-App-Build", appBuild.build)'));
  });

  test('BEFORE the body parsers, static files, the 5xx observer and the route loop', () => {
    expect(gateAt).toBeLessThan(at("app.use('/hooks', express.json("));
    expect(gateAt).toBeLessThan(at("app.use(express.json({ limit: '10mb' }))"));
    expect(gateAt).toBeLessThan(at('express.static('));
    expect(gateAt).toBeLessThan(at('require("./lib/responseObserver")'));
    expect(gateAt).toBeLessThan(at('fs.readdirSync(routesPath)'));
  });
});
