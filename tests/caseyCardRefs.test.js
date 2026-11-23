// Casey v2 S3c — services/casey/cardRefs.js: `$N.field` references between a
// card's steps. The grammar (a WHOLE string value or path segment; dotted path
// with array indexes), finding them, the walk into a stored result, every way
// a reference fails (a later or unapplied step, a missing field, a redacted
// value, an object, a withheld result, a null path segment), the body and path
// substitution, and resolveStep's route re-check over the LIVE catalog (no
// route, not proposable, not callable by this user, a higher tier than the card).
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-cardrefs-test-secret';

const refs = require('../services/casey/cardRefs');
const catalog = require('../lib/routeCatalog');

const ROUTES = path.join(__dirname, '..', 'routes');
const dbStub = { query: async () => [[], []], execute: async () => [[], []], withTransaction: async (fn) => fn(dbStub), getConnection: async () => ({ query: async () => [[], []], execute: async () => [[], []], release() {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {} }) };
function liveApp() {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.db = dbStub; next(); });
  for (const f of fs.readdirSync(ROUTES).filter((n) => n.endsWith('.js')).sort()) app.use(require(path.join(ROUTES, f)));
  return app;
}
const cat = catalog.catalogFor(liveApp());
const STAFF = { type: 'jwt', userId: 7, username: 'rena', roles: ['staff'] };
const SU = { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] };

test('the grammar: a whole value "$N.path" with identifiers and indexes; text with a $ inside, "$N" alone, bad segments are not references', () => {
  expect(refs.parseRef('$1.task_id')).toEqual({ step: 1, path: ['task_id'], text: '$1.task_id' });
  expect(refs.parseRef('$12.rows.0.id')).toEqual({ step: 12, path: ['rows', '0', 'id'], text: '$12.rows.0.id' });
  for (const s of ['$1', '$1.', '$1..x', '$1.x-y', '$1.x y', ' $1.x', '$1.x ', 'price is $5', '$a.b', '$1.9x', 1, null, { a: 1 }]) expect([s, refs.parseRef(s)]).toEqual([s, null]);
  expect(refs.findRefs({ a: '$1.x', b: ['$2.y', 'no', { c: '$1.z.0' }], d: 5 })).toEqual([{ at: 'body.a', ref: refs.parseRef('$1.x') }, { at: 'body.b[0]', ref: refs.parseRef('$2.y') }, { at: 'body.b[2].c', ref: refs.parseRef('$1.z.0') }]);
  expect(refs.findPathRefs('/api/tasks/$1.task_id/notes/$2.id')).toEqual([{ at: 'path[3]', ref: refs.parseRef('$1.task_id') }, { at: 'path[5]', ref: refs.parseRef('$2.id') }]);
  expect(refs.findPathRefs('/api/tasks/12')).toEqual([]);
  expect(refs.findPathRefs('/api/tasks/$1.task_id?x=1')).toEqual([{ at: 'path[3]', ref: refs.parseRef('$1.task_id') }]);   // B1: the query is split off before the last segment is read
  expect(refs.splitQuery('/a/b?x=1&y=2')).toEqual(['/a/b', '?x=1&y=2']); expect(refs.splitQuery('/a/b')).toEqual(['/a/b', '']);
  expect(refs.walk({ task: { id: 5, tags: ['a', 'b'] } }, ['task', 'tags', '1'])).toEqual({ found: true, value: 'b' });
  expect(refs.walk({ task: { id: 5 } }, ['task', 'nope'])).toEqual({ found: false });
  expect(refs.walk({ rows: [1] }, ['rows', '3'])).toEqual({ found: false });
  expect(refs.walk({ rows: [1] }, ['rows', 'x'])).toEqual({ found: false });
});

test('resolving one reference: the earlier step must be applied with the field present, scalar and not redacted; a path reference needs a usable segment', () => {
  const earlier = new Map([
    [1, { status: 'applied', result: { status: 'success', task_id: 1830, token: '[redacted]', task: { title: 'T', flags: { a: true } }, rows: [{ id: 9 }], nil: null, empty: '' } }],
    [2, { status: 'failed', result: { message: 'no' } }],
    [3, { status: 'applied', result: { withheld: true, reason: 'too many' } }],
    [4, { status: 'applied', result: 'a plain string answer' }],
    [5, { status: 'applied', result: '{"task_id":1,"pad":"xxx' + '…[truncated: 99999 bytes, cap 16384]' }],
    [6, { status: 'applied', result: { url: 'https://app/t/[redacted]', dot: '.', dots: '..', slash: 'a/b', enc: '%2e%2e', sp: 'a b', ctl: 'a\u0001b', big: 'A'.repeat(20) } }],
  ]);
  const ok = (text, kind = 'body') => refs.resolveRef(refs.parseRef(text), earlier, kind);
  expect(ok('$1.task_id')).toEqual({ ok: true, value: 1830 });
  expect(ok('$1.task.title')).toEqual({ ok: true, value: 'T' });
  expect(ok('$1.rows.0.id')).toEqual({ ok: true, value: 9 });
  expect(ok('$1.task.flags.a')).toEqual({ ok: true, value: true });
  expect(ok('$1.token')).toEqual({ ok: false, reason: '$1.token is a redacted value (a token or secret never flows into a later step)' });
  expect(ok('$1.task')).toEqual({ ok: false, reason: '$1.task is an object or array, not a value' });
  expect(ok('$1.rows')).toEqual({ ok: false, reason: '$1.rows is an object or array, not a value' });
  expect(ok('$1.missing')).toEqual({ ok: false, reason: "step 1's result has no missing" });
  expect(ok('$1.task.nope')).toEqual({ ok: false, reason: "step 1's result has no task.nope" });
  expect(ok('$2.message')).toEqual({ ok: false, reason: 'step 2 is failed, not applied' });
  expect(ok('$3.reason')).toEqual({ ok: false, reason: "step 3's result was withheld (too many secret-shaped values)" });
  expect(ok('$4.x')).toEqual({ ok: false, reason: "step 4's result has no x" });
  expect(ok('$9.x')).toEqual({ ok: false, reason: 'step 9 is not an earlier step of this card' });
  expect(ok('$5.task_id')).toEqual({ ok: false, reason: "step 5's answer was cut at the ledger's 16 KB limit; a reference into a large answer cannot be resolved" });   // S6: the cut, not "no task_id"
  expect(ok('$6.url')).toEqual({ ok: false, reason: '$6.url is a redacted value (a token or secret never flows into a later step)' });   // S1: the marker INSIDE a string
  expect(ok('$1.nil')).toEqual({ ok: false, reason: '$1.nil is null; a reference must name a value' });   // a null would clear a field
  // Path segments: a string or number only, and never a dot segment, a slash, whitespace or a control character — raw or encoded (B2).
  expect(ok('$1.task_id', 'path')).toEqual({ ok: true, value: 1830 });
  expect(ok('$6.big', 'path')).toEqual({ ok: true, value: 'A'.repeat(20) });
  expect(ok('$1.empty', 'path')).toEqual({ ok: false, reason: '$1.empty is "", which cannot be a path segment' });
  expect(ok('$1.task.flags.a', 'path')).toEqual({ ok: false, reason: '$1.task.flags.a is true, which cannot be a path segment' });
  for (const [k, v] of [['dot', '.'], ['dots', '..'], ['slash', 'a/b'], ['sp', 'a b'], ['ctl', 'a\u0001b']]) expect([k, ok(`$6.${k}`, 'path')]).toEqual([k, { ok: false, reason: `$6.${k} is ${JSON.stringify(v)}, which cannot be a path segment (a slash, a dot segment, whitespace or a control character)` }]);
  expect(ok('$6.enc', 'path')).toEqual({ ok: false, reason: '$6.enc is "%2e%2e", which decodes to a dot segment or a slash' });
  // Body and path substitution: a deep copy with JSON types kept; a path value is encoded; the first failure wins.
  expect(refs.resolveBody({ id: '$1.task_id', title: '$1.task.title', n: ['$1.rows.0.id', 'keep'], note: 'x $1.task_id y', flag: '$1.task.flags.a' }, earlier)).toEqual({ ok: true, body: { id: 1830, title: 'T', n: [9, 'keep'], note: 'x $1.task_id y', flag: true } });
  expect(refs.resolveBody({ a: '$1.nil' }, earlier)).toEqual({ ok: false, ref: '$1.nil', reason: expect.stringMatching(/is null/) });
  // A `__proto__` key survives the rebuild (api_write refuses it at proposal; the resolver would not drop it either).
  const withProto = JSON.parse('{"__proto__":{"x":1},"a":"$1.task_id"}');
  const rb = refs.resolveBody(withProto, earlier).body;
  expect(Object.keys(rb)).toEqual(['__proto__', 'a']); expect(JSON.stringify(rb)).toBe('{"__proto__":{"x":1},"a":1830}');
  expect(refs.resolveBody({ a: '$1.task_id', b: '$1.token' }, earlier)).toEqual({ ok: false, ref: '$1.token', reason: expect.stringMatching(/redacted/) });
  expect(refs.resolvePath('/api/tasks/$1.task_id/x', earlier)).toEqual({ ok: true, path: '/api/tasks/1830/x' });
  expect(refs.resolvePath('/api/tasks/$1.task_id?x=1&y=$1.z', earlier)).toEqual({ ok: true, path: '/api/tasks/1830?x=1&y=$1.z' });   // B1: the query is kept as it was, never read for references
  expect(refs.resolvePath('/api/t/$1.task.title', new Map([[1, { status: 'applied', result: { task: { title: 'é&x' } } }]]))).toEqual({ ok: true, path: '/api/t/%C3%A9%26x' });   // encoded; a slash or a space would have been refused (B2)
  expect(refs.resolvePath('/api/tasks/$2.id', earlier)).toEqual({ ok: false, ref: '$2.id', reason: 'step 2 is failed, not applied' });
});

test('matchTemplate (B3): a template is pinned to the route whose parameters its references stand on — same segment count, literals equal, references on :param positions; a reference on a literal position, or a template no route has parameters for, pins nothing', () => {
  const pin = (m, p) => { const r = refs.matchTemplate(cat, m, p); return r.row ? r.row.path : r.reason; };
  expect(pin('PATCH', '/api/tasks/$1.task_id')).toBe('/api/tasks/:id(\\d+)');
  expect(pin('PATCH', '/api/tasks/$1.task_id/complete')).toBe('/api/tasks/:id(\\d+)/complete');
  expect(pin('DELETE', '/api/cases/$1.case_id/contacts/$1.contact_id')).toBe('/api/cases/:id/contacts/:contactId');
  expect(pin('PATCH', '/api/tasks/$1.task_id?x=1')).toBe('/api/tasks/:id(\\d+)');   // B1: the query is not a segment
  expect(pin('PATCH', '/api/$1.a/$1.b')).toMatch(/^no PATCH route has parameters where \/api\/\$1\.a\/\$1\.b carries references/);   // the route would be chosen by the answer: refused
  expect(pin('POST', '/admin/system-alerts/$1.seg')).toMatch(/^no POST route has parameters/);                                            // `ack` is a literal segment of that route, not a parameter
  expect(pin('PATCH', '/api/TASKS/$1.id')).toBe('/api/tasks/:id(\\d+)');   // literals match as Express does, case-insensitively
  expect(pin('PATCH', '/api/tasks/$1.id/nope')).toMatch(/^no PATCH route/);
  expect(pin('DELETE', '/api/cases/42/contacts/$1.cid')).toBe('/api/cases/:id/contacts/:contactId');   // a known id beside a reference (S-b): a literal may stand on a parameter
  expect(pin('DELETE', '/api/tasks/$1.id')).toMatch(/^no DELETE route/);   // tasks are soft-deleted by PATCH; no DELETE route exists
});

test('resolveStep: no reference → nothing to send differently; the resolved path must dispatch to the route the template pinned, be clean, proposable, callable by THIS user and no higher than the card\'s tier', () => {
  const earlier = new Map([[1, { status: 'applied', result: { task_id: 1830, slug: 'not-a-number', dots: '..', case_id: 'ABCD1234', contact_id: 77 } }]]);
  const ctx = { cat, auth: STAFF, cardTier: 1 };
  expect(refs.resolveStep({ method: 'POST', path: '/api/tasks', body: '{"t":1}', tier: 1 }, earlier, ctx)).toEqual({ ok: true, path: null, body: null, route: null });
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/tasks/$1.task_id', body: '{"title":"$1.slug"}', tier: 1 }, earlier, ctx)).toEqual({ ok: true, path: '/api/tasks/1830', body: '{"title":"not-a-number"}', route: '/api/tasks/:id(\\d+)' });
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/tasks/$1.task_id?x=1', body: null, tier: 1 }, earlier, ctx)).toEqual({ ok: true, path: '/api/tasks/1830?x=1', body: null, route: '/api/tasks/:id(\\d+)' });   // B1
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/tasks/$1.slug', body: null, tier: 1 }, earlier, ctx)).toEqual({ ok: false, ref: null, reason: 'the resolved path /api/tasks/not-a-number does not reach the route approved on the card (/api/tasks/:id(\\d+))' });   // :id(\\d+) does not match the value
  expect(refs.resolveStep({ method: 'DELETE', path: '/api/cases/$1.dots/contacts/$1.contact_id', body: null, tier: 2 }, earlier, { cat, auth: STAFF, cardTier: 2 })).toEqual({ ok: false, ref: '$1.dots', reason: '$1.dots is "..", which cannot be a path segment (a slash, a dot segment, whitespace or a control character)' });   // B2
  expect(refs.resolveStep({ method: 'DELETE', path: '/api/cases/$1.case_id/contacts/$1.contact_id', body: null, tier: 2 }, earlier, { cat, auth: STAFF, cardTier: 2 })).toEqual({ ok: true, path: '/api/cases/ABCD1234/contacts/77', body: null, route: '/api/cases/:id/contacts/:contactId' });
  // A template nothing pins cannot resolve (api_write refuses it at proposal; a stored one from before would fail here).
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/$1.a/$1.b', body: null, tier: 1 }, new Map([[1, { status: 'applied', result: { a: 'tasks', b: 12 } }]]), ctx)).toEqual({ ok: false, ref: null, reason: expect.stringMatching(/^no PATCH route has parameters/) });
  // The tier check still stands behind the pin (an SU template on a T3 card for a superuser; the same for a staff user is refused by judge).
  const suEarlier = new Map([[1, { status: 'applied', result: { id: 5 } }]]);
  const suRow = cat.rows.find((r) => r.authClass === 'su' && r.proposable && r.method === 'PATCH' && /:id/.test(r.path));   // PATCH /api/admin/users/:id
  const tpl = suRow.path.replace(/:id[^/]*/, '$1.id');
  expect(refs.resolveStep({ method: 'PATCH', path: tpl, body: null, tier: 3 }, suEarlier, { cat, auth: STAFF, cardTier: 3 })).toEqual({ ok: false, ref: null, reason: expect.stringMatching(/^you may not call the resolved path .* \(superuser only\)$/) });
  expect(refs.resolveStep({ method: 'PATCH', path: tpl, body: null, tier: 3 }, suEarlier, { cat, auth: SU, cardTier: 1 })).toEqual({ ok: false, ref: null, reason: expect.stringMatching(/is a T3 route; the card was approved as T1$/) });
  expect(refs.resolveStep({ method: 'PATCH', path: tpl, body: null, tier: 3 }, suEarlier, { cat, auth: SU, cardTier: 3 })).toMatchObject({ ok: true, route: suRow.path });
  // A body-only reference pins by DISPATCH of its concrete path — a parameterised one included (review r2 N1) — and a stored body that is not JSON is a failure.
  expect(refs.resolveStep({ method: 'POST', path: '/api/tasks', body: '{"id":"$1.task_id"}', tier: 1 }, earlier, ctx)).toEqual({ ok: true, path: null, body: '{"id":1830}', route: '/api/tasks' });
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/tasks/1830', body: '{"title":"$1.slug"}', tier: 1 }, earlier, ctx)).toEqual({ ok: true, path: null, body: '{"title":"not-a-number"}', route: '/api/tasks/:id(\\d+)' });
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/tasks/1830?x=1', body: '{"title":"$1.slug"}', tier: 1 }, earlier, ctx)).toEqual({ ok: true, path: null, body: '{"title":"not-a-number"}', route: '/api/tasks/:id(\\d+)' });
  expect(refs.resolveStep({ method: 'DELETE', path: '/api/cases/42/contacts/$1.contact_id', body: null, tier: 2 }, earlier, { cat, auth: STAFF, cardTier: 2 })).toEqual({ ok: true, path: '/api/cases/42/contacts/77', body: null, route: '/api/cases/:id/contacts/:contactId' });
  expect(refs.resolveStep({ method: 'POST', path: '/api/tasks', body: '{cut', tier: 1 }, earlier, ctx)).toEqual({ ok: false, ref: null, reason: 'the stored body is not JSON' });
});

test('B3 at claim: the resolved path must DISPATCH to the pinned row — two routes of the same shape differing only by a parameter constraint: a value the pinned pattern rejects lands on the other route and is refused', () => {
  const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
  const two = express(); two.use(express.json()); two.use((req, _res, next) => { req.db = dbStub; next(); });
  const r = express.Router();
  r.patch('/api/_pin/:id(\\d+)', jwtOrApiKey, (req, res) => res.json({ num: req.params.id }));   // registered first: the template pins this one
  r.patch('/api/_pin/:slug', jwtOrApiKey, (req, res) => res.json({ slug: req.params.slug }));    // the same shape; a non-numeric value dispatches here
  two.use(r);
  const twoCat = catalog.catalogFor(two);
  expect(refs.matchTemplate(twoCat, 'PATCH', '/api/_pin/$1.v').row.path).toBe('/api/_pin/:id(\\d+)');
  const ctx = { cat: twoCat, auth: STAFF, cardTier: 1 };
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/_pin/$1.v', body: null, tier: 1 }, new Map([[1, { status: 'applied', result: { v: 42 } }]]), ctx)).toEqual({ ok: true, path: '/api/_pin/42', body: null, route: '/api/_pin/:id(\\d+)' });
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/_pin/$1.v', body: null, tier: 1 }, new Map([[1, { status: 'applied', result: { v: 'abc' } }]]), ctx)).toEqual({ ok: false, ref: null, reason: 'the resolved path /api/_pin/abc does not reach the route approved on the card (/api/_pin/:id(\\d+))' });   // it reaches /api/_pin/:slug — a route the user never saw
  // A CONCRETE path with a body-only reference pins by DISPATCH, not by structure: /api/_pin/abc was checked at proposal as /api/_pin/:slug and stays there (a structural pin would pick the first same-shape row and refuse a valid step).
  expect(refs.resolveStep({ method: 'PATCH', path: '/api/_pin/abc', body: '{"x":"$1.v"}', tier: 1 }, new Map([[1, { status: 'applied', result: { v: 7 } }]]), ctx)).toEqual({ ok: true, path: null, body: '{"x":7}', route: '/api/_pin/:slug' });
});
