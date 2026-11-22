// tests/routeCatalog.test.js
//
/**
 * Casey v2 S0 — lib/routeCatalog.js over EVERY route in routes/, plus the
 * authMeta stamps in lib/auth.*. Design: ref/CASEY_V2_DESIGN.md §4.3, §8.1–8.2.
 *
 * WHAT IS LOCKED
 *   - DETERMINACY: every route in the live app gets a class other than
 *     'unknown'. A new gate the catalog does not know fails HERE, by
 *     middleware name and route — the guard that keeps the catalog honest as
 *     routes are added (add it to LOCAL_GATES or stamp authMeta).
 *   - Negative control: a route with an unknown named gate, and a route with an
 *     anonymous gate beside an auth gate, both come back 'unknown' and
 *     assertDeterminate throws naming them. An anonymous limiter on a PUBLIC
 *     route is fine.
 *   - Tiers: every non-GET has a tier 1–3; every su route is T3; every DELETE
 *     is ≥ T2; a GET is T0 or (SU) T3.
 *   - ENFORCEMENT: the class a chain claims is what the live route does. A
 *     staff JWT and an SU JWT are driven through one route per gate kind
 *     (stamped factories AND each LOCAL_GATES effect) with a scripted db, and
 *     the auth decision (401/403 vs "got past auth") must match the class.
 *   - Snapshots: the never-proposable writes in the staff classes, the closed
 *     GETs, the su-without-elevation routes and the dynamic-capability routes
 *     — exact lists, so a change is deliberate.
 *   - WIRED_ROUTES (lib/requestIdempotency.js) names live routes, and every
 *     `idempotentRequest(req, '<scope>'` literal in routes/ is in it once.
 *
 * HARNESS: the REAL route modules mounted on a bare express app (as server.js
 * does), the REAL auth modules, a db stub whose every query answers no rows.
 * Nothing under test is mocked. Requiring every route file needs the same env
 * seeding tests/jest.setup.js already does.
 *
 * Run: npx jest tests/routeCatalog.test.js
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'route-catalog-s0-test-secret';
process.env.SU_RATE_LIMIT_DEFAULT = '100000';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const catalog = require('../lib/routeCatalog');
const { WIRED_ROUTES } = require('../lib/requestIdempotency');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const requireAuth = require('../lib/auth.requireAuth');
const { superuserOnlyFor } = require('../lib/auth.superuser');
const { readonlyApiKeyAuth, requireKeyScope } = require('../lib/auth.readonly');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(ROOT, 'routes');
const STAFF = new Set(['staff', 'staff:can', 'su']);
const at = r => `${r.method} ${r.path}`;

// One stub for every db read the routes make on the way to an auth decision:
// no rows, no errors. Audit inserts are fire-and-forget on it.
const dbStub = {
  query: async () => [[], []],
  execute: async () => [[], []],
  withTransaction: async fn => fn(dbStub),
  getConnection: async () => ({ query: async () => [[], []], execute: async () => [[], []], release() {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {} }),
};

function liveApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = dbStub; next(); });
  for (const f of fs.readdirSync(ROUTES).filter(n => n.endsWith('.js')).sort()) app.use(require(path.join(ROUTES, f)));
  return app;
}

const app = liveApp();
const cat = catalog.buildCatalog(app);
const rows = cat.rows;
const byKey = new Map(rows.map(r => [at(r), r]));

// ─────────────────────────────────────────────────────────────────────────────
describe('determinacy over the live app', () => {
  test('every route is classified — an unknown gate fails here by name', () => {
    const names = cat.unknown.map(u => `${u.method} ${u.path} — ${u.names.join(', ')}`);
    expect(names).toEqual([]);
    expect(() => catalog.assertDeterminate(cat)).not.toThrow();
    expect(rows.length).toBeGreaterThan(800);
    for (const r of rows) expect(catalog.CLASSES.includes(r.authClass) && r.authClass !== 'unknown').toBe(true);
  });

  test('every class is present and the stamped gates are seen (not just names)', () => {
    const classes = new Set(rows.map(r => r.authClass));
    expect([...classes].sort()).toEqual(['key', 'portal', 'public', 'staff', 'staff:can', 'su']);
    // authMeta carried through: an su route knows its tool; a can route its capability.
    expect(byKey.get('GET /api/admin/scratch')).toMatchObject({ authClass: 'su', suTool: 'scratch', elevation: true, tier: 3 });
    expect(byKey.get('POST /api/calendar-types-admin')).toMatchObject({ authClass: 'staff:can', can: 'firm.settings', tier: 1 });
    expect(byKey.get('POST /api/hooks')).toMatchObject({ authClass: 'staff:can', can: 'automations.manage', idempotent: 'hooks.create' });
    expect(byKey.get('POST /api/readonly/sql')).toMatchObject({ authClass: 'key', proposable: false });
    expect(byKey.get('GET /api/portal/me')).toMatchObject({ authClass: 'portal', proposable: false, autoGet: false });
    expect(byKey.get('POST /hooks/:slug')).toMatchObject({ authClass: 'public', proposable: false });
    expect(byKey.get('GET /api/casey/catalog')).toMatchObject({ authClass: 'su', suTool: 'casey', proposable: false, autoGet: false });
    expect(byKey.get('GET /api/mail/mailboxes')).toMatchObject({ authClass: 'staff', flags: ['jwtOnly'], autoGet: true });
    expect(byKey.get('POST /api/esign/send')).toMatchObject({ authClass: 'staff', multipart: true, proposable: false, tier: 2 });
    expect(byKey.get('_ALL /ringcentral/send-sms')).toMatchObject({ authClass: 'public', flags: ['publicAuth:checkApiKey'] });
  });

  test('the shared catalog is frozen (rows, lists, arrays)', () => {
    expect(Object.isFrozen(cat) && Object.isFrozen(cat.rows) && Object.isFrozen(cat.unknown)).toBe(true);
    const r = byKey.get('GET /api/mail/mailboxes');
    expect(Object.isFrozen(r) && Object.isFrozen(r.chain) && Object.isFrozen(r.flags)).toBe(true);
    expect(() => { 'use strict'; r.proposable = true; }).toThrow();
    expect(catalog.catalogFor(app)).toBe(catalog.catalogFor(app)); // one build per app object
  });

  test('family comes from lib/routeFamilies', () => {
    expect(byKey.get('GET /api/mail/mailboxes').family).toBe('/api/mail');
    expect(byKey.get('POST /workflows/:id/start').family).toBe('/workflows');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('tiers', () => {
  test('every non-GET has a tier 1–3; every GET is T0 or an SU T3', () => {
    for (const r of rows) {
      if (r.method === 'GET' || r.method === 'HEAD') expect([at(r), r.tier]).toEqual([at(r), r.authClass === 'su' ? 3 : 0]);
      else expect([at(r), [1, 2, 3].includes(r.tier)]).toEqual([at(r), true]);
    }
  });
  test('every superuserCheck route is T3', () => {
    for (const r of rows.filter(r => r.chain.includes('superuserCheck') || r.chain.includes('requireAdmin'))) {
      expect([at(r), r.authClass, r.tier]).toEqual([at(r), 'su', 3]);
    }
  });
  test('every DELETE is at least T2', () => {
    for (const r of rows.filter(r => r.method === 'DELETE')) expect([at(r), r.tier >= 2]).toEqual([at(r), true]);
  });
  test('unknown is closed: a synthetic unknown row is neither proposable nor auto', () => {
    const r = express.Router();
    r.post('/x', jwtOrApiKey, function mysteryGate(q, s, n) { n(); }, (q, s) => s.end());
    r.get('/y', jwtOrApiKey, function mysteryGate(q, s, n) { n(); }, (q, s) => s.end());
    const a = express(); a.use(r);
    const c = catalog.buildCatalog(a);
    expect(c.rows.map(x => [x.method, x.authClass, x.proposable, x.autoGet])).toEqual([
      ['POST', 'unknown', false, null], ['GET', 'unknown', false, false],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('negative control — the determinacy guard goes red', () => {
  test('an unknown named gate', () => {
    const r = express.Router();
    r.get('/mystery', jwtOrApiKey, function mysteryGate(q, s, n) { n(); }, (q, s) => s.end());
    const a = express(); a.use(r);
    const c = catalog.buildCatalog(a);
    expect(c.unknown).toEqual([{ method: 'GET', path: '/mystery', names: ['mysteryGate'] }]);
    expect(() => catalog.assertDeterminate(c)).toThrow(/mysteryGate/);
    expect(() => catalog.assertDeterminate(c)).toThrow(/GET \/mystery/);
  });
  test('an anonymous middleware beside an auth gate', () => {
    const r = express.Router();
    r.post('/anon', jwtOrApiKey, (q, s, n) => n(), (q, s) => s.end());
    const a = express(); a.use(r);
    const c = catalog.buildCatalog(a);
    expect(c.unknown).toEqual([{ method: 'POST', path: '/anon', names: ['<anonymous>'] }]);
  });
  test('a route-local su gate with no authentication in front of it', () => {
    const r = express.Router();
    r.get('/bare', function requireAdmin(q, s, n) { n(); }, (q, s) => s.end());
    const a = express(); a.use(r);
    expect(catalog.buildCatalog(a).unknown[0].names).toEqual(['su-gate-without-jwtOrApiKey']);
  });
  test('an anonymous limiter on a public route is fine', () => {
    const r = express.Router();
    r.get('/pub', (q, s, n) => n(), (q, s) => s.end());
    const a = express(); a.use(r);
    const c = catalog.buildCatalog(a);
    expect(c.unknown).toEqual([]);
    expect(c.rows[0]).toMatchObject({ authClass: 'public', proposable: false, autoGet: false });
  });
  test('stamped factories classify by authMeta, and the stamps describe the gate', () => {
    expect(requireAuth({ audience: 'staff', can: 'firm.settings', allowApiKey: true }).authMeta).toEqual({ kind: 'staff', can: 'firm.settings', roles: [], allowApiKey: true });
    expect(requireAuth({ audience: 'staff', roles: ['admin'] }).authMeta).toEqual({ kind: 'staff', can: null, roles: ['admin'], allowApiKey: false });
    expect(requireAuth({ audience: 'contact' }).authMeta).toEqual({ kind: 'portal' });
    const chain = superuserOnlyFor('x_tool');
    expect(chain.map(f => f.authMeta)).toEqual([
      { kind: 'staff', can: null, roles: [], allowApiKey: true }, { kind: 'su', tool: 'x_tool' },
      { kind: 'elevation', tool: 'x_tool' }, { kind: 'rateLimit', tool: 'x_tool' },
    ]);
    expect(readonlyApiKeyAuth.authMeta).toEqual({ kind: 'key', allowExpired: false });
    expect(requireKeyScope('scratch').authMeta).toEqual({ kind: 'keyScope', scope: 'scratch' });
    expect(catalog.classifyChain(chain)).toMatchObject({ authClass: 'su', suTool: 'x_tool', elevation: true, unknown: [] });
    expect(catalog.classifyChain([readonlyApiKeyAuth, requireKeyScope('scratch')])).toMatchObject({ authClass: 'key' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement: drive real requests through the live routes.
function token(roles, extra = {}) {
  return jwt.sign({ sub: 6, username: 'catalog-test', user_type: 'staff', user_auth: 'authorized', roles, aud: 'staff', ...extra },
    process.env.JWT_SECRET, { expiresIn: '5m' });
}
const STAFF_JWT = token(['staff']);
const ADMIN_JWT = token(['admin']);
const SU_JWT = token(['su']);

let server, port;
beforeAll(async () => { server = app.listen(0); await new Promise(r => server.once('listening', r)); port = server.address().port; });
afterAll(() => new Promise(r => server.close(r)));

function hit(method, urlPath, bearer, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.setTimeout(8000, () => { req.destroy(new Error(`timeout ${method} ${urlPath}`)); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
// "Got past auth": anything but 401/403 AND below 500. A handler that 400s or
// 404s on the empty db proves the gate let the caller through; a 500 does not
// — a gate that THROWS for the caller it should pass also 500s (review 2026-11-22).
const pastAuth = s => s !== 401 && s !== 403 && s < 500;

describe('enforcement — the chain\'s class is what the route does', () => {
  test('no token: every staff / su / staff:can route is 401', async () => {
    for (const k of ['GET /api/mail/mailboxes', 'GET /api/issue-reports', 'POST /api/calendar-types-admin', 'GET /api/admin/scratch', 'GET /api/casey/catalog']) {
      const r = byKey.get(k);
      expect(STAFF.has(r.authClass)).toBe(true);
      const { status } = await hit(r.method, r.path, null, r.method === 'GET' ? undefined : {});
      expect([k, status]).toEqual([k, 401]);
    }
  });

  test('staff (jwtOrApiKey + jwtOnly refinements): a staff JWT gets past auth', async () => {
    for (const k of ['GET /api/mail/mailboxes', 'GET /api/assistant/chats', 'GET /api/contacts/:id/communications']) {
      const r = byKey.get(k);
      expect(r.authClass).toBe('staff');
      const { status } = await hit('GET', r.path.replace(':id', '1'), STAFF_JWT);
      expect([k, pastAuth(status), status]).toEqual([k, true, status]);
    }
    const rep = byKey.get('POST /api/reports');
    expect(rep).toMatchObject({ authClass: 'staff', flags: ['jwtOnly'], idempotent: 'reports.create' });
    const { status } = await hit('POST', '/api/reports', STAFF_JWT, {});
    expect(pastAuth(status)).toBe(true);
  });

  test('su via route-local requireAdmin: staff 403, SU past auth, no elevation step', async () => {
    const r = byKey.get('GET /api/issue-reports/:id');
    expect(r).toMatchObject({ authClass: 'su', elevation: false, chain: ['jwtOrApiKey', 'requireAdmin'] });
    const p = r.path.replace(':id', '1');
    expect((await hit('GET', p, STAFF_JWT)).status).toBe(403);
    expect((await hit('GET', p, ADMIN_JWT)).status).toBe(403);
    const su = await hit('GET', p, SU_JWT);
    expect([su.status, pastAuth(su.status)]).toEqual([404, true]); // no row in the stub db — the handler ran
  });

  test('su via superuserCheck: staff 403, SU without elevation 401 elevation_required', async () => {
    const r = byKey.get('GET /api/admin/scratch');
    expect(r).toMatchObject({ authClass: 'su', elevation: true });
    expect((await hit('GET', r.path, STAFF_JWT)).status).toBe(403);
    const su = await hit('GET', r.path, SU_JWT);
    expect(su.status).toBe(401);
    expect(JSON.parse(su.body).code).toBe('elevation_required');
  });

  test('staff:can via staffAuth: staff 403, a holder past auth; SU passes too', async () => {
    const r = byKey.get('POST /api/calendar-types-admin');
    expect(r).toMatchObject({ authClass: 'staff:can', can: 'firm.settings' });
    expect((await hit('POST', r.path, STAFF_JWT, {})).status).toBe(403);
    expect(pastAuth((await hit('POST', r.path, ADMIN_JWT, {})).status)).toBe(true);
    expect(pastAuth((await hit('POST', r.path, SU_JWT, {})).status)).toBe(true);
  });

  test('staff:can dynamic (gateByScope): firm scope needs firm.settings, own scope does not', async () => {
    const r = byKey.get('PUT /api/ui-config');
    expect(r).toMatchObject({ authClass: 'staff:can', can: 'dynamic', chain: ['gateByScope'] });
    expect((await hit('PUT', r.path, STAFF_JWT, { scope: 'firm' })).status).toBe(403);
    expect(pastAuth((await hit('PUT', r.path, STAFF_JWT, { scope: 'user' })).status)).toBe(true);
  });

  test('viewAsOnly: a plain staff JWT is 403 on the view-as controls', async () => {
    const r = byKey.get('POST /api/impersonation/exit');
    expect(r).toMatchObject({ authClass: 'staff', flags: ['viewAsControl', 'viewAsOnly'], proposable: false });
    expect((await hit('POST', r.path, STAFF_JWT, {})).status).toBe(403);
  });

  test('public: no token is not 401 (own-header auth or none)', async () => {
    const r = byKey.get('GET /api/streak/boards');
    expect(r).toMatchObject({ authClass: 'public', flags: ['publicAuth:adminAuth'] });
    const { status } = await hit('GET', r.path, null);
    expect([503, 401]).toContain(status); // adminAuth's own answers — never jwtOrApiKey's 401 {error:'Unauthorized'}
    expect(pastAuth((await hit('GET', '/api/version', null)).status)).toBe(true);
  });

  test('key: a staff JWT is refused where only a readonly key is accepted', async () => {
    const r = byKey.get('GET /api/readonly/whoami');
    expect(r.authClass).toBe('key');
    expect((await hit('GET', r.path, STAFF_JWT)).status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('snapshots — a change here is a deliberate review', () => {
  test('never-proposable writes in the staff classes', () => {
    expect(rows.filter(r => STAFF.has(r.authClass) && !r.proposable && r.method !== 'GET').map(at)).toEqual([
      'POST /admin/api-tester/saved', 'DELETE /admin/api-tester/saved/:id', 'PUT /admin/api-tester/saved/:id', 'POST /admin/api-tester/saved/:id/run',
      'POST /admin/api-tester/send-request', 'POST /admin/db/batch', 'POST /admin/db/query', 'POST /admin/db/saved-queries',
      'DELETE /admin/db/saved-queries/:id', 'PUT /admin/db/saved-queries/:id', 'POST /admin/db/schema/save-to-ref', 'POST /admin/elevate',
      'POST /api/ai/file', 'POST /api/api-keys', 'POST /api/api-keys/rotate-internal', 'POST /api/assistant/actions/:draftId/claim', 'POST /api/assistant/actions/:draftId/result', 'POST /api/assistant/actions/reconcile',
      'POST /api/assistant/chats', 'DELETE /api/assistant/chats/:id(\\d+)', 'PATCH /api/assistant/chats/:id(\\d+)', 'POST /api/assistant/chats/:id(\\d+)/messages',
      'POST /api/assistant/execute', 'POST /api/assistant/plan', 'POST /api/auth/change-password', 'POST /api/auth/update-profile',
      'POST /api/esign/:id/resend', 'POST /api/esign/:id/satisfied-external', 'POST /api/esign/send', 'POST /api/esign/templates/:id/pdf',
      'POST /api/impersonation/exit', 'POST /api/impersonation/mode', 'POST /api/impersonation/users/:id/start', 'POST /api/pdf/parse',
      'POST /api/readonly-keys', 'POST /internal/dropbox/create-folder', 'POST /internal/email-test/send', 'POST /internal/email/send', 'POST /internal/hook-replay',
      'POST /internal/mms/send', 'POST /internal/sequence/enroll', 'POST /internal/sms/send',
      '_ALL /mailbox-ingest', 'POST /process-domain-event/:id', 'POST /process-hook-execution/:id', 'POST /process-job/:id', '_ALL /process-jobs',
      'POST /test-advance/:executionId', 'POST /workflows/test-step',
    ]);
  });

  test('closed staff GETs (not auto, not a card) — credential-returning reads and plumbing', () => {
    expect(rows.filter(r => STAFF.has(r.authClass) && r.authClass !== 'su' && r.method === 'GET' && !r.autoGet).map(at)).toEqual([
      'GET /api/assistant/chats', 'GET /api/assistant/chats/:id(\\d+)', 'GET /api/credentials', 'GET /api/email-credentials',
      'GET /api/hooks', 'GET /api/hooks/:id', 'GET /api/impersonation/users', 'GET /auth/validate', 'GET /clio-code',
      'GET /internal/email-test/credentials', 'GET /internal/email-test/credentials/oauth',
    ]);
    for (const r of rows.filter(r => STAFF.has(r.authClass) && r.authClass !== 'su' && r.method === 'GET' && !r.autoGet)) expect(r.proposable).toBe(false);
  });

  test('SU GETs are never auto; the consoles are not cards either', () => {
    const suGets = rows.filter(r => r.authClass === 'su' && r.method === 'GET');
    expect(suGets.every(r => r.autoGet === false && r.tier === 3)).toBe(true);
    expect(suGets.filter(r => !r.proposable).map(at)).toEqual([
      'GET /admin/api-tester/history', 'GET /admin/api-tester/saved', 'GET /admin/api-tester/saved/:id', 'GET /admin/db/saved-queries',
      'GET /admin/db/schema', 'GET /admin/db/schema.sql', 'GET /api/casey/catalog', 'GET /api/credentials/:id/reveal', 'GET /api/email-credentials/:id/reveal',
    ]);
  });

  test('su without an elevation step (design §7.6)', () => {
    expect(rows.filter(r => r.authClass === 'su' && !r.elevation).map(at)).toEqual([
      'POST /admin/elevate', 'PATCH /api/feature-requests/:id', 'GET /api/issue-reports', 'GET /api/issue-reports/:id',
      'POST /api/issue-reports/:id/respond', 'POST /api/issue-reports/resolve',
    ]);
  });

  test('dynamic-capability routes', () => {
    expect(rows.filter(r => r.can === 'dynamic').map(at)).toEqual([
      'PUT /api/app-settings/:key', 'GET /api/app-settings/:key/history', 'POST /api/app-settings/:key/restore', 'PUT /api/ui-config',
    ]);
  });

  test('LOCAL_GATES is the pinned name table, and every name in it is still mounted somewhere', () => {
    expect(Object.keys(catalog.LOCAL_GATES).sort()).toEqual([
      'adminAuth', 'chatRate', 'checkApiKey', 'gate', 'gateByScope', 'limitDraft', 'limitPreview', 'memberAuth', 'multerMiddleware',
      'perKeyGate', 'requireAdmin', 'requireJwt', 'requireUser', 'requireViewAsSession', 'staffOnly', 'textParser', 'tplUploadSingle', 'uploadSingle',
    ]);
    // routes/_aitest.js and routes/_errtest.js register their `gate` only when
    // their env switch is on (AITEST_ENABLED / ERRTEST), so it is absent here.
    const ENV_CONDITIONAL = ['gate'];
    const mounted = new Set(rows.flatMap(r => r.chain));
    const stale = Object.keys(catalog.LOCAL_GATES).filter(n => !mounted.has(n) && !ENV_CONDITIONAL.includes(n));
    expect(stale).toEqual([]); // a gate nobody mounts is a stale claim — drop it
  });

  test('each LOCAL_GATES name is defined only in the route files the table was reviewed against', () => {
    // A name is trusted wherever it appears, so a new `function gate` in some
    // other file would inherit the table's claim. Pin the defining files; a new
    // definition is a review (review 2026-11-22, finding 7).
    const DEFINED_IN = {
      adminAuth: ['api.streak.js'], memberAuth: ['api.streak.js'], checkApiKey: ['ringcentral.js'],
      chatRate: ['api.assistant.js'], staffOnly: ['api.assistant.js'],
      gate: ['_aitest.js', '_courtexec.js', '_errtest.js'],
      gateByScope: ['api.uiConfig.js'], perKeyGate: ['api.appSettings.js'],
      limitDraft: ['api.reports.js'], limitPreview: ['api.reports.js'], requireUser: ['api.reports.js'],
      requireAdmin: ['api.featureRequests.js', 'api.issueReports.js'],
      requireJwt: ['api.entityComms.js', 'api.forms.js', 'api.mail.js', 'api.mailboxes.js', 'api.phoneComms.js'],
      requireViewAsSession: ['api.impersonation.js'],
      textParser: [], // body-parser's own closure name (express.text() passed inline in api.esign.js)
      tplUploadSingle: ['api.esign.templates.js'],
      uploadSingle: ['api.ai.js', 'api.esign.actions.js'],
      multerMiddleware: [], // multer's own closure name — never defined in routes/
    };
    expect(Object.keys(DEFINED_IN).sort()).toEqual(Object.keys(catalog.LOCAL_GATES).sort());
    const found = Object.fromEntries(Object.keys(DEFINED_IN).map(n => [n, []]));
    for (const f of fs.readdirSync(ROUTES).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
      for (const n of Object.keys(DEFINED_IN)) {
        // A classification is by fn.name, so only a declaration or a function /
        // arrow literal assigned to a const carries the name; `const gate =
        // superuserOnlyFor(…)` holds the factory's closure, not a `gate`.
        if (new RegExp(`(^|\\n)\\s*(async\\s+)?function\\s+${n}\\s*\\(|(const|let|var)\\s+${n}\\s*=\\s*(async\\s*)?(function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)`).test(src)) found[n].push(f);
      }
    }
    for (const n of Object.keys(DEFINED_IN)) expect([n, found[n].sort()]).toEqual([n, DEFINED_IN[n]]);
  });

  test('backstop: no auto-GET handler decrypts a secret or forwards request text as SQL', () => {
    // What a path cannot show (review 2026-11-22: /db-jwt — retired the same day — ran req.query as SQL,
    // /api/hooks returned decrypted auth, /clio-code the live login code).
    const TOKENS = ['withReadableAuth', 'decrypt(', 'decryptSecret', 'revealSecret', 'clio_login_code',
      '.query(trimmed', 'db.query(req.query', 'sendSms(', 'sendEmail(', 'sendMail(', 'sendMessage('];
    const offenders = [];
    for (const r of rows.filter(r => r.autoGet)) {
      const src = r.handler.toString();
      for (const t of TOKENS) if (src.includes(t)) offenders.push(`${at(r)} — ${t}`);
    }
    expect(offenders).toEqual([]);
    // and the scan is live: the closed routes DO carry the tokens (the retired
    // /db-jwt's shape stands in as a synthetic row)
    const r = express.Router();
    r.get('/sql-forwarder', jwtOrApiKey, async (req, res) => { const trimmed = String(req.query.query); res.json(await req.db.query(trimmed)); });
    const a = express(); a.use(r);
    const synth = catalog.buildCatalog(a).rows[0];
    expect(synth.autoGet).toBe(true);
    expect(TOKENS.filter(t => synth.handler.toString().includes(t))).toEqual(['.query(trimmed']);
    expect(byKey.get('GET /api/hooks').handler.toString()).toContain('withReadableAuth');
    expect(byKey.get('GET /clio-code').handler.toString()).toContain('clio_login_code');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('WIRED_ROUTES ↔ the route sources', () => {
  test('every key names a live route whose HANDLER calls idempotentRequest with that scope', () => {
    expect(Object.keys(WIRED_ROUTES).filter(k => !byKey.has(k))).toEqual([]);
    for (const [k, scope] of Object.entries(WIRED_ROUTES)) {
      const r = byKey.get(k);
      expect(r.idempotent).toBe(scope);
      const src = r.handler.toString();
      const re = new RegExp(`idempotentRequest\\(\\s*req\\s*,\\s*['"]${scope.replace(/\./g, '\\.')}['"]`);
      expect([k, re.test(src)]).toEqual([k, true]);
    }
  });
  test('every idempotentRequest scope literal in routes/ appears exactly once', () => {
    const seen = [];
    for (const f of fs.readdirSync(ROUTES).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');
      for (const m of src.matchAll(/idempotentRequest\(\s*req\s*,\s*['"]([a-z_.]+)['"]/g)) seen.push(m[1]);
    }
    expect(seen.sort()).toEqual(Object.values(WIRED_ROUTES).slice().sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
  test('a non-wired write carries null', () => {
    expect(byKey.get('POST /api/campaigns/test-send').idempotent).toBeNull();
  });
});
