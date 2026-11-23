// Casey v2 S3b — services/casey/tools/api_write.js over the LIVE route catalog
// (every routes/*.js on the S0 no-rows db stub) with the cards store mocked in
// memory (tests/helpers/caseyMemoryCards.js; the real store is the MySQL twin).
// What this file proves:
//   • nothing runs: the tool only validates and stores a card (no request, no
//     fetch); without a chat it validates and stores nothing (dry_run);
//   • every refusal, BEFORE anything is stored: method, path rules, no route,
//     not proposable (console / secret-returning / multipart / public), this
//     user may not call it (staff:can without the capability; a non-superuser
//     on an SU route — a non-SU never gets a T3 card), a non-object body, a
//     `$N` reference, an oversized body, 0 or 6 steps;
//   • the card: tier = the highest step tier, the body stored as the exact
//     JSON text, the query folded into the path, purposes cut, the result the
//     model reads.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'casey-apiwrite-test-secret';

jest.mock('../services/casey/cards', () => require('./helpers/caseyMemoryCards').make(jest.requireActual('../services/casey/cards')));
const cards = require('../services/casey/cards');
const tools = require('../services/casey/tools');
const apiWrite = require('../services/casey/tools/api_write');

const ROUTES = path.join(__dirname, '..', 'routes');
const dbStub = {
  query: async () => { throw new Error('api_write must not touch the db directly'); }, execute: async () => [[], []],
  withTransaction: async () => { throw new Error('the cards store is mocked'); },
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

const STAFF = { type: 'jwt', userId: 7, username: 'rena', roles: ['staff'] };
const ADMIN = { type: 'jwt', userId: 8, username: 'ss', roles: ['admin'] };   // holds automations.manage (lib/capabilities)
const SU = { type: 'jwt', userId: 6, username: 'IT', roles: ['su'] };
const ctx = (auth, extra = {}) => ({ db: dbStub, auth, app, headers: {}, ip: '10.0.0.1', port: 0, via: 'casey:c1', card: { chatId: 1, toolUseId: 'tu_1' }, ...extra });
const run = (auth, input, extra) => tools.runTool('api_write', ctx(auth, extra), input);
const step = (o) => ({ method: 'POST', path: '/api/tasks', purpose: 'create the follow-up task', ...o });

const realFetch = global.fetch;
beforeAll(() => { global.fetch = jest.fn(async () => { throw new Error('api_write must never fetch'); }); });
afterAll(() => { global.fetch = realFetch; });
beforeEach(() => cards._store.reset());

describe('a proposal', () => {
  test('stores the card and its steps, runs nothing, answers "card N proposed"; tier is the highest step; the body is the exact JSON text; the query folds into the path', async () => {
    const body = { title: 'Call the trustee', due: '2026-12-01', nested: { z: 1, a: [2, 3] } };
    const r = await run(STAFF, { summary: 'Create a task and send the client a note', steps: [
      step({ body, query: { source: 'casey', n: '2' } }),
      { method: 'POST', path: '/api/mail/send', body: { to: ['x@x.test'], subject: 's', body_text: 'b' }, purpose: 'the note' },
    ] });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({
      card_id: 1, status: 'proposed', tier: 'T2', summary: 'Create a task and send the client a note',
      steps: [{ step: 1, method: 'POST', path: '/api/tasks?source=casey&n=2', tier: 'T1', route: '/api/tasks' }, { step: 2, method: 'POST', path: '/api/mail/send', tier: 'T2', route: '/api/mail/send' }],
      note: expect.stringMatching(/^Card 1 is shown to the user; this turn ends here\./),
    });
    expect(r.untrusted).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
    const card = await cards.getCard(dbStub, 1, 7);
    expect(card).toMatchObject({ id: 1, chat_id: 1, user_id: 7, tool_use_id: 'tu_1', tier: 2, status: 'proposed', summary: 'Create a task and send the client a note' });
    expect(card.steps.map((s) => [s.step_no, s.method, s.path, s.tier, s.status, s.idempotency_key])).toEqual([
      [1, 'POST', '/api/tasks?source=casey&n=2', 1, 'pending', 'casey:1:1'], [2, 'POST', '/api/mail/send', 2, 'pending', 'casey:1:2']]);
    expect(card.steps[0].body).toBe(JSON.stringify(body));   // the model's own key order, as text — what the browser will send byte for byte
    expect(card.steps[0].purpose).toBe('create the follow-up task');
    // Another user's card is invisible to this one.
    expect(await cards.getCard(dbStub, 1, 8)).toBeNull();
  });

  test('a DELETE without a body; a step-less body is NULL; a superuser gets a T3 card on an SU route (elevation is apiSend\'s business at click time)', async () => {
    const r = await run(SU, { summary: 'Acknowledge the alert', steps: [{ method: 'POST', path: '/admin/system-alerts/ack', body: { ids: [1] }, purpose: 'ack' }, { method: 'DELETE', path: '/api/admin/scratch/fred/x', purpose: 'drop the key' }] });
    expect(r.ok).toBe(true);
    expect(r.data.tier).toBe('T3');
    const card = await cards.getCard(dbStub, 1, 6);
    expect(card.steps[1]).toMatchObject({ method: 'DELETE', path: '/api/admin/scratch/fred/x', body: null, tier: 3 });
  });

  test('without a chat (the SU test route) it validates and stores nothing: dry_run', async () => {
    const r = await run(STAFF, { summary: 's', steps: [step({ body: { title: 't' } })] }, { card: undefined });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ dry_run: true, tier: 'T1', summary: 's', steps: [{ step: 1, method: 'POST', path: '/api/tasks', tier: 'T1', route: '/api/tasks' }], note: expect.stringMatching(/validated only, nothing stored/) });
    expect(cards._store.cards.size).toBe(0);
  });
});

describe('refusals — nothing stored, nothing run', () => {
  afterEach(() => { expect(cards._store.cards.size).toBe(0); expect(global.fetch).not.toHaveBeenCalled(); });
  const refused = async (auth, input, code, re) => {
    const r = await run(auth, input);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe(code);
    if (re) expect(r.error.message).toMatch(re);
    return r;
  };
  test('the schema: method enum, 0 / 6 steps, a missing purpose, an unknown key', async () => {
    await refused(STAFF, { summary: 's', steps: [step({ method: 'GET' })] }, 'BAD_INPUT', /steps\[0\]: method must be one of POST, PUT, PATCH, DELETE/);
    await refused(STAFF, { summary: 's', steps: [] }, 'BAD_INPUT', /at least 1 item/);
    await refused(STAFF, { summary: 's', steps: Array.from({ length: 6 }, () => step()) }, 'BAD_INPUT', /more than 5 items/);
    await refused(STAFF, { summary: 's', steps: [{ method: 'POST', path: '/api/tasks' }] }, 'BAD_INPUT', /missing required input: purpose/);
    await refused(STAFF, { summary: 's', steps: [step({ headers: {} })] }, 'BAD_INPUT', /unknown input key: headers/);
    await refused(STAFF, { steps: [step()] }, 'BAD_INPUT', /missing required input: summary/);
  });
  test('the path rules (api_get\'s): a query string in the path, dot segments, control characters', async () => {
    await refused(STAFF, { summary: 's', steps: [step({ path: '/api/tasks?x=1' })] }, 'BAD_PATH', /put query parameters in `query`/);
    await refused(STAFF, { summary: 's', steps: [step({ path: '/api/../admin/db/query' })] }, 'BAD_PATH', /\. or \.\. segment/);
    await refused(STAFF, { summary: 's', steps: [step({ path: '/api/%2e%2e/x' })] }, 'BAD_PATH', /\. or \.\. segment/);   // the encoded form of a dot segment
    await refused(STAFF, { summary: 's', steps: [step({ path: 'api/tasks' })] }, 'BAD_PATH', /must start with/);
    await refused(STAFF, { summary: 's', steps: [step({ query: { pad: 'x'.repeat(1995) } })] }, 'BAD_PATH', /path and query together are longer than 2000/);   // the stored column's width: never truncated silently
    await refused(STAFF, { summary: 's', steps: [step({ query: { a: { nested: 1 } } })] }, 'BAD_INPUT', /steps\[0\]: query\.a must be string, got object/);   // query values are strings
  });
  test('no route; the method matters (a GET-only path has no POST)', async () => {
    await refused(STAFF, { summary: 's', steps: [step({ path: '/api/no/such/route' })] }, 'NO_ROUTE', /no POST route serves/);
    await refused(STAFF, { summary: 's', steps: [step({ method: 'PUT', path: '/api/tasks' })] }, 'NO_ROUTE', /no PUT route/);
  });
  test('not proposable: the SU console, a secret-returning mint, a multipart send, a public route, Casey itself', async () => {
    await refused(SU, { summary: 's', steps: [step({ path: '/admin/db/query', body: { query: 'SELECT 1' } })] }, 'NOT_PROPOSABLE', /never-proposable list/);
    await refused(SU, { summary: 's', steps: [step({ path: '/api/api-keys', body: { label: 'x' } })] }, 'NOT_PROPOSABLE', /its response is a secret/);
    await refused(STAFF, { summary: 's', steps: [step({ path: '/api/esign/send' })] }, 'NOT_PROPOSABLE', /multipart/);
    await refused(STAFF, { summary: 's', steps: [step({ path: '/login', body: { u: 'x' } })] }, 'NOT_PROPOSABLE', /public route/);
    await refused(STAFF, { summary: 's', steps: [step({ path: '/api/casey/turn', body: { text: 'hi' } })] }, 'NOT_PROPOSABLE', /never-proposable list/);
  });
  test('this user may not call it: staff:can without the capability; a non-superuser on an SU route (no T3 card for them); a machine key on a jwt-only route', async () => {
    const r = await refused(STAFF, { summary: 's', steps: [step({ path: '/api/hooks', body: { slug: 'x' } })] }, 'FORBIDDEN', /needs automations\.manage/);
    expect(r.error).toMatchObject({ step: 1, route: '/api/hooks', tier: 'T1' });
    const ok = await run(ADMIN, { summary: 's', steps: [step({ path: '/api/hooks', body: { slug: 'x' } })] });   // the admin holds it
    expect(ok.ok).toBe(true); cards._store.reset();
    await refused(STAFF, { summary: 's', steps: [step({ path: '/admin/system-alerts/ack', body: { ids: [1] } })] }, 'FORBIDDEN', /superuser only/);
    await refused({ type: 'api_key', key_label: 'k', scopes: null }, { summary: 's', steps: [step({ path: '/api/phone-lines/3/sms', body: { to: 'x', message: 'm' } })] }, 'FORBIDDEN', /not a machine key/);
  });
  test('the body: not an object; a malformed or forward `$N` reference (S3c); a reference in a query value; too large; a later step\'s refusal leaves the earlier valid step unstored', async () => {
    await refused(STAFF, { summary: 's', steps: [step({ body: 'title=x' })] }, 'BAD_INPUT', /steps\[0\]: body must be object, got string/);
    await refused(STAFF, { summary: 's', steps: [step({ body: [1] })] }, 'BAD_INPUT', /must be object, got array/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { tags: ['a', { deep: '$2' }] } })] }, 'BAD_REF', /body\.tags\[1\]\.deep is "\$2" — a reference is "\$N\.field"/);   // malformed
    await refused(STAFF, { summary: 's', steps: [step({ body: { id: '$1.task_id' } })] }, 'BAD_REF', /must name an EARLIER step of this card \(1–0\)/);       // the step itself
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 't' } }), step({ body: { id: '$3.task_id' } })] }, 'BAD_REF', /EARLIER step .* \(1–1\)/);   // a later step
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 't' } }), step({ path: '/api/tasks/$2.task_id' })] }, 'BAD_REF', /path is "\$2\.task_id"/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 't' } }), step({ query: { id: '$1.task_id' } })] }, 'BAD_REF', /query\.id is "\$1\.task_id" — a reference cannot be a query value/);
    expect(apiWrite.refShapes({ a: 'price is $5', b: '$1.x' })).toEqual([{ at: 'body.b', text: '$1.x', ref: { step: 1, path: ['x'], text: '$1.x' } }]);   // a dollar amount is not a reference
    await refused(STAFF, { summary: 's', steps: [step({ body: { pad: 'x'.repeat(apiWrite.BODY_MAX) } })] }, 'BAD_BODY', /larger than/);
  });
});

describe('S3c references', () => {
  const refused = async (auth, input, code, re) => { const r = await run(auth, input); expect(r.ok).toBe(false); expect(r.error.code).toBe(code); if (re) expect(r.error.message).toMatch(re); return r; };
  test('a later step may reference an earlier step\'s result in its body (any depth) and as a whole path segment standing for a route parameter; the template is PINNED to that route at proposal (its real tier, proposability and the user\'s right checked then); the stored body keeps the reference text', async () => {
    const r = await run(STAFF, { summary: 'Create then update', steps: [
      step({ body: { title: 'T' } }),
      { method: 'PATCH', path: '/api/tasks/$1.task_id', body: { note: 'created as $1.task_id', title: '$1.title', ids: ['$1.rows.0.id'] }, purpose: 'then patch it' },
      { method: 'DELETE', path: '/api/cases/$1.case_id/contacts/$1.contact_id', purpose: 'drop the link' },
    ] });
    expect(r.ok).toBe(true);
    expect(r.data.steps).toEqual([
      { step: 1, method: 'POST', path: '/api/tasks', tier: 'T1', route: '/api/tasks' },
      { step: 2, method: 'PATCH', path: '/api/tasks/$1.task_id', tier: 'T1', route: '/api/tasks/:id(\\d+)' },   // pinned by structure: the reference stands on :id
      { step: 3, method: 'DELETE', path: '/api/cases/$1.case_id/contacts/$1.contact_id', tier: 'T2', route: '/api/cases/:id/contacts/:contactId' },
    ]);
    const card = await cards.getCard(dbStub, 1, 7);
    expect(card.tier).toBe(2);
    expect(card.steps[1].body).toBe('{"note":"created as $1.task_id","title":"$1.title","ids":["$1.rows.0.id"]}');   // the template, references intact ("created as $1.task_id" is text, not a reference — only a WHOLE value is)
    expect(card.steps[1].path_sent).toBeNull();
    cards._store.reset();
    // A template no route has parameters for, or a reference on a literal position, is refused at proposal — the answer could otherwise pick the route (review B3).
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'PATCH', path: '/api/$1.a/$1.b', purpose: 'p' }] }, 'NO_ROUTE', /no PATCH route has parameters where \/api\/\$1\.a\/\$1\.b carries references/);
    await refused(SU, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/admin/system-alerts/$1.seg', body: { ids: [1] }, purpose: 'p' }] }, 'NO_ROUTE', /no POST route has parameters/);
    // A pinned route is checked like any other: a staff user cannot pin an SU route; a never-proposable one is refused.
    const suRow = require('../lib/routeCatalog').catalogFor(app).rows.find((x) => x.authClass === 'su' && x.proposable && x.method === 'PATCH' && /:id/.test(x.path));
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'PATCH', path: suRow.path.replace(/:id[^/]*/, '$1.id'), body: {}, purpose: 'p' }] }, 'FORBIDDEN', /superuser only/);
    await refused(SU, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'DELETE', path: '/admin/api-tester/saved/$1.id', query: { x: '1' }, purpose: 'p' }] }, 'NOT_PROPOSABLE', /never-proposable/);   // review B1's probe: the query no longer hides the reference
    // A send takes no reference in its body (the user must see what they approve); a prototype key is refused anywhere.
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/mail/send', body: { to: ['x@x.test'], subject: '$1.title', body_text: 'see' }, purpose: 'tell' }] }, 'BAD_REF', /a send takes no reference in its body/);   // a WHOLE-value reference; "Task $1.task_id" would be plain text
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/phone-lines/3/sms', body: { to: '$1.phone', message: 'hi' }, purpose: 'text' }] }, 'BAD_REF', /a send takes no reference/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/API/Mail/Send', body: { to: ['$1.email'], subject: 's', body_text: 'b' }, purpose: 'tell' }] }, 'BAD_REF', /a send takes no reference in its body/);   // S-a: the matched route decides, not the model's spelling
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/mail/send/', body: { to: ['$1.email'], subject: 's', body_text: 'b' }, purpose: 'tell' }] }, 'BAD_REF', /a send takes no reference in its body/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/Phone-Lines/3/SMS', body: { to: '$1.phone', message: 'hi' }, purpose: 'text' }] }, 'BAD_REF', /a send takes no reference in its body/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/phone-lines/$1.line/sms', body: { to: '+12485550100', message: 'hi' }, purpose: 'text' }] }, 'BAD_REF', /a send takes no reference in its path/);   // the sending line chosen by an answer: refused
    // Every outbound send on lib/caseySensitivity SEND_PATHS, not only mail and SMS (review r3 nit): e-sign, a campaign test, a CTA message.
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/esign/send-from-template', body: { template_id: 1, signer_email: '$1.email' }, purpose: 'sign' }] }, 'BAD_REF', /a send takes no reference in its body/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/campaigns/test-send', body: { to: '$1.email' }, purpose: 'test' }] }, 'BAD_REF', /a send takes no reference in its body/);
    await refused(SU, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'POST', path: '/api/cta/$1.id/send', body: {}, purpose: 'cta' }] }, 'BAD_REF', /a send takes no reference in its path/);
    // A known id beside a reference pins the route (S-b); a body-only reference on a parameterised concrete path is an ordinary step.
    const mixed = await run(STAFF, { summary: 's', steps: [step({ body: { t: 1 } }), { method: 'DELETE', path: '/api/cases/42/contacts/$1.contact_id', purpose: 'drop' }, { method: 'PATCH', path: '/api/tasks/1830', body: { title: '$1.title' }, purpose: 'rename' }] });
    expect(mixed.data.steps.slice(1)).toEqual([{ step: 2, method: 'DELETE', path: '/api/cases/42/contacts/$1.contact_id', tier: 'T2', route: '/api/cases/:id/contacts/:contactId' }, { step: 3, method: 'PATCH', path: '/api/tasks/1830', tier: 'T1', route: '/api/tasks/:id(\\d+)' }]);
    cards._store.reset();
    await refused(STAFF, { summary: 's', steps: [step({ body: JSON.parse('{"title":"t","__proto__":{"x":1}}') })] }, 'BAD_BODY', /body\.__proto__ is not an allowed key/);
    await refused(STAFF, { summary: 's', steps: [step({ body: { a: [{ constructor: 1 }] } })] }, 'BAD_BODY', /body\.a\[0\]\.constructor is not an allowed key/);
    expect(cards._store.cards.size).toBe(0);
  });
});
