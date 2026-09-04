// D1 — SERVER-SIDE DRAFTS for case-linked external forms.
//
// External drafts were localStorage-only (EXTERNAL_FORMS_DESIGN §5.3 item 8),
// so a client who started a form on their phone could not resume on a laptop.
// D1 adds an OPT-IN server draft (external.serverDrafts) on the existing
// external surface: no new table, no portal JWT, the case_id bearer param IS
// the draft identity.
//
// Four layers:
//   1. extFormService units — serverDraftsEnabled strictness, checkDraftShape
//      (shape-only, deliberately NOT validateValues), getServerDraft's narrow
//      projection.
//   2. LIVE ROUTER — routes/api.ext.forms.js on an ephemeral port against a
//      STATEFUL stub pool that actually models the draft row, so the
//      round-trip claims (save → read back on another "device" → overwrite →
//      delete → submit-clears) are asserted against stored state rather than
//      against query text. Plus the §5.4 no-oracle parity locks and the
//      intake-unchanged locks.
//   3. validateDefinition — external.serverDrafts admitted, strictly boolean,
//      exact-key enforcement intact.
//   4. jsdom — the real render.html + yc-forms.js: the server-draft autosave
//      path, cross-device resume, pick-newer, the local fallback when the
//      server save fails, discard, and (load-bearing) that an opted-OUT form
//      never touches the draft route at all.
'use strict';

jest.mock('../lib/internal_functions', () => ({
  start_workflow: jest.fn(async () => ({ success: true, output: { workflow_execution_id: 1 } })),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const { JSDOM, ResourceLoader } = require('jsdom');

const svc = require(path.join(__dirname, '..', 'services', 'extFormService.js'));
const tplSvc = require(path.join(__dirname, '..', 'services', 'formTemplateService.js'));

const ROOT = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseSections = [{
  title: 'S',
  rows: [{ fields: [
    { name: 'client_name', type: 'text', prefill: '$load.contact_name' },
    { name: 'reason', type: 'text', required: true, maxLength: 200 },
    { name: 'contact_pref', type: 'select', options: ['Phone', 'Email'] },
    { name: 'blurb', type: 'content', text: 'display only' },
  ] }],
}, {
  repeater: 'cars', title: 'Cars', fields: [{ name: 'make', type: 'text' }],
}];

// serverDrafts ON. degrade so an anonymous GET still renders — which is
// exactly the case that must NOT get a server draft.
const draftsDef = {
  toggle: false,
  sections: baseSections,
  external: { badLink: 'degrade', serverDrafts: true },
};
// serverDrafts absent — today's behavior, the `intake` shape.
const plainDef = {
  toggle: false,
  sections: baseSections,
  external: { badLink: 'degrade' },
};

const tplRow = (over) => ({
  form_key: 'dbkq_test', title: 'Questionnaire', link_type: 'case',
  schema_version: 3, visibility: 'public', definition: draftsDef, ...over,
});

// ── Stateful stub pool ──────────────────────────────────────────────────────
//
// Content-routed like the X2 harness, but the draft row is REAL state: the
// upsert/read/delete claims below are assertions about what is stored, not
// about which SQL happened to be emitted.

function memDb(fixture) {
  const calls = [];
  const drafts = fixture.drafts;                    // Map: "key|type|id" → row
  // The clock lives on the FIXTURE, not this closure: a fresh memDb is built
  // per request, so a local counter would reset and every draft would carry
  // the same updated_at — which is exactly the thing the overwrite assertion
  // needs to distinguish.
  if (fixture._clock == null) fixture._clock = Date.parse('2026-09-04T12:00:00.000Z');
  const tick = () => new Date((fixture._clock += 1000)).toISOString();

  return {
    calls,
    query: async (sql, params) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      const p = params || [];
      calls.push({ sql: q, params: p });

      if (q.includes('FROM form_templates')) return [fixture.template ? [fixture.template] : []];
      if (q.includes('FROM cases'))          return [fixture.caseRow ? [fixture.caseRow] : []];
      if (q.includes('JOIN case_relate'))    return [fixture.primary ? [fixture.primary] : []];
      if (q.includes('MAX(version)'))        return [[{ max_version: 0 }]];

      // upsertDraft
      if (q.startsWith('INSERT INTO form_submissions') && q.includes("'draft'")) {
        const [formKey, linkType, linkId, schemaVersion, dataJson] = p;
        const k = `${formKey}|${linkType}|${linkId}`;
        const existing = drafts.get(k);
        const row = {
          id: existing ? existing.id : (fixture._nextId = (fixture._nextId || 500) + 1),
          data: dataJson, schema_version: schemaVersion, updated_at: tick(),
        };
        drafts.set(k, row);
        return [{ insertId: existing ? 0 : row.id }];
      }
      // submitForm
      if (q.startsWith('INSERT INTO form_submissions') && q.includes("'submitted'")) {
        return [{ insertId: 101 }];
      }
      // upsertDraft's id lookup on the UPDATE branch
      if (q.startsWith('SELECT id, updated_at FROM form_submissions')) {
        const [formKey, linkType, linkId] = p;
        const row = drafts.get(`${formKey}|${linkType}|${linkId}`);
        return [row ? [{ id: row.id, updated_at: row.updated_at }] : []];
      }
      // upsertDraft / submitForm updated_at echo
      if (q.startsWith('SELECT updated_at FROM form_submissions WHERE id')) {
        const [id] = p;
        for (const row of drafts.values()) {
          if (row.id === id) return [[{ updated_at: row.updated_at }]];
        }
        return [[{ updated_at: '2026-09-04T00:00:00.000Z' }]];
      }
      // getServerDraft — the narrow three-column read
      if (q.startsWith('SELECT data, updated_at, schema_version FROM form_submissions')) {
        const [formKey, linkId] = p;
        const row = drafts.get(`${formKey}|case|${linkId}`);
        return [row ? [{ data: row.data, updated_at: row.updated_at,
                         schema_version: row.schema_version }] : []];
      }
      if (q.startsWith('DELETE FROM form_submissions')) {
        // Fault injection for the fire-and-forget cleanup path.
        if (fixture.breakDelete) throw new Error('delete exploded');
        const [formKey, linkType, linkId] = p;
        const k = `${formKey}|${linkType}|${linkId}`;
        const had = drafts.has(k);
        drafts.delete(k);
        return [{ affectedRows: had ? 1 : 0 }];
      }
      // submitForm's post-commit domainEvents.emit (fire-and-forget, never
      // throws) — routed so the drift guard below stays meaningful.
      if (q.includes('domain_event_queue')) return [{ insertId: 1, affectedRows: 1 }];

      throw new Error('memDb: unrouted query: ' + q);
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. extFormService units
// ════════════════════════════════════════════════════════════════════════════

describe('extFormService.serverDraftsEnabled', () => {
  test('strictly true — every other shape is OFF', () => {
    expect(svc.serverDraftsEnabled({ external: { serverDrafts: true } })).toBe(true);
    for (const def of [
      undefined, null, {}, { external: null }, { external: {} },
      { external: { serverDrafts: false } },
      { external: { serverDrafts: 'true' } },   // a row can predate the validator
      { external: { serverDrafts: 1 } },
      { serverDrafts: true },                   // top-level is not the flag
    ]) {
      expect(svc.serverDraftsEnabled(def)).toBe(false);
    }
  });
});

describe('extFormService.checkDraftShape', () => {
  const bad = (values, part) => {
    let err;
    try { svc.checkDraftShape(draftsDef, values); } catch (e) { err = e; }
    expect(err && err.status).toBe(400);
    expect(err.message).toContain(part);
  };

  test('a PARTIAL draft passes where validateValues would reject it', () => {
    // `reason` is required and `contact_pref` must be a listed option — submit
    // rejects both. A draft is mid-typing and must not.
    expect(() => svc.checkDraftShape(draftsDef, {})).not.toThrow();
    expect(() => svc.checkDraftShape(draftsDef, { client_name: 'Ada' })).not.toThrow();
    expect(() => svc.checkDraftShape(draftsDef, { contact_pref: 'Fa' })).not.toThrow();
    // ...and validateValues really does reject those, so the difference is real
    expect(() => svc.validateValues(draftsDef, {})).toThrow(/is required/);
    expect(() => svc.validateValues(draftsDef, { reason: 'r', contact_pref: 'Fa' }))
      .toThrow(/not one of the allowed options/);
  });

  test('rejects non-object values', () => {
    bad([], 'values must be an object');
    bad(null, 'values must be an object');
    bad('x', 'values must be an object');
  });

  test('rejects an undeclared key, naming it', () => {
    bad({ reason: 'r', sneaky: 'x' }, 'values.sneaky is not a field of this form');
    // display-only types carry no value, so naming one is still undeclared
    bad({ blurb: 'x' }, 'values.blurb is not a field of this form');
    // Prototype-shaped keys arrive from JSON.parse as OWN properties (an
    // object literal would set the prototype instead, which is a different
    // thing) and miss the null-prototype registry like anything else.
    bad(JSON.parse('{"__proto__":"x"}'), 'is not a field of this form');
    bad(JSON.parse('{"constructor":"x"}'), 'is not a field of this form');
  });

  test('repeater keys are declared; their contents are NOT shape-checked (draft, not submit)', () => {
    expect(() => svc.checkDraftShape(draftsDef, { cars: [{ make: 'Ford' }] })).not.toThrow();
    expect(() => svc.checkDraftShape(draftsDef, { cars: [] })).not.toThrow();
    bad({ vans: [] }, 'values.vans is not a field of this form');
  });

  test('the 64KB payload cap still applies — a draft row lands in the same column', () => {
    const cars = Array.from({ length: 100 }, () => ({ make: 'x'.repeat(1000) }));
    bad({ cars }, 'too large');
    expect(() => svc.checkDraftShape(draftsDef, { cars: [{ make: 'Ford' }] })).not.toThrow();
  });

  test('the shared registry walks tabs + sticky regions, not just sections', () => {
    const tabbed = {
      stickyTop: [{ title: 'T', rows: [{ fields: [{ name: 'top', type: 'text' }] }] }],
      tabs: [{ label: 'One', sections: [
        { title: 'A', rows: [{ fields: [{ name: 'mid', type: 'text' }] }] },
        { repeater: 'kids', title: 'K', fields: [{ name: 'age', type: 'number' }] },
      ] }],
      stickyBottom: [{ title: 'B', rows: [{ fields: [{ name: 'bot', type: 'text' }] }] }],
    };
    expect(() => svc.checkDraftShape(tabbed,
      { top: '1', mid: '2', bot: '3', kids: [{ age: 4 }] })).not.toThrow();
    let err;
    try { svc.checkDraftShape(tabbed, { nope: 'x' }); } catch (e) { err = e; }
    expect(err.message).toContain('values.nope');
  });
});

describe('extFormService.getServerDraft', () => {
  const dbWith = (rows) => ({
    lastSql: '',
    query: async function (sql, params) {
      this.lastSql = sql.replace(/\s+/g, ' ').trim();
      this.lastParams = params;
      return [rows];
    },
  });

  test('returns exactly { data, updated_at, schema_version } — never id or submitted_by', async () => {
    const db = dbWith([{ data: { reason: 'r' }, updated_at: 'T', schema_version: 3 }]);
    const out = await svc.getServerDraft(db, 'dbkq_test', 'abc12345');
    expect(Object.keys(out).sort()).toEqual(['data', 'schema_version', 'updated_at']);
    // the projection is enforced by the SELECT itself: those columns are not
    // named, so no future shape change can leak them by accident
    expect(db.lastSql).not.toMatch(/\bid\b/);
    expect(db.lastSql).not.toContain('submitted_by');
    expect(db.lastSql).not.toContain('*');
    expect(db.lastParams).toEqual(['dbkq_test', 'abc12345']);
  });

  test('no row → null; a string json column is parsed; a corrupt one degrades to null', async () => {
    expect(await svc.getServerDraft(dbWith([]), 'k', 'c')).toBeNull();
    const parsed = await svc.getServerDraft(
      dbWith([{ data: '{"reason":"r"}', updated_at: 'T', schema_version: 3 }]), 'k', 'c');
    expect(parsed.data).toEqual({ reason: 'r' });
    expect(await svc.getServerDraft(
      dbWith([{ data: 'not json', updated_at: 'T', schema_version: 3 }]), 'k', 'c')).toBeNull();
  });

  test('reads the case-linked draft row only', async () => {
    const db = dbWith([]);
    await svc.getServerDraft(db, 'k', 'c');
    expect(db.lastSql).toContain("link_type = 'case'");
    expect(db.lastSql).toContain("status = 'draft'");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Live router
// ════════════════════════════════════════════════════════════════════════════

describe('routes/api.ext.forms.js — draft routes (live router)', () => {
  let server, base, fixture;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = memDb(fixture); fixture._db = req.db; next(); });
    app.use(require('../routes/api.ext.forms.js'));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(done);
  });

  // Drafts persist across requests within a test; each test starts clean.
  let drafts;
  beforeEach(() => {
    drafts = new Map();
    fixture = { drafts, template: tplRow(), caseRow: { case_id: 'abc12345' }, primary: null };
  });

  let ipSeq = 0;
  const nextIp = () => `203.0.113.${(ipSeq++ % 250) + 1}`;
  const hdrs = (ip) => ({ 'Content-Type': 'application/json',
                          'X-Forwarded-For': `1.2.3.4, ${ip || nextIp()}` });

  const GET = (p, ip) => fetch(base + p, { headers: hdrs(ip) });
  const POST = (p, body, ip) => fetch(base + p, {
    method: 'POST', headers: hdrs(ip), body: JSON.stringify(body) });
  const DEL = (p, ip) => fetch(base + p, { method: 'DELETE', headers: hdrs(ip) });

  const draftKey = 'dbkq_test|case|abc12345';

  // ── AC1: the round trip ───────────────────────────────────────────────────

  test('AC1: save → read back on a different device → overwrite → delete', async () => {
    // Save.
    let r = await POST('/api/ext/forms/dbkq_test/draft',
      { case_id: 'abc12345', values: { reason: 'started on my phone' } });
    expect(r.status).toBe(200);
    let body = await r.json();
    expect(body.status).toBe('success');
    expect(typeof body.updated_at).toBe('string');
    expect('id' in body).toBe(false);                 // no volume oracle
    expect(drafts.has(draftKey)).toBe(true);

    // Read back — a plain GET, which is all a second device has.
    body = await (await GET('/api/ext/forms/dbkq_test?case_id=abc12345')).json();
    expect(body.draft).toEqual({
      data: { reason: 'started on my phone' },
      updated_at: expect.any(String),
      schema_version: 3,
    });

    // Overwrite: the SAME row moves forward, no second row.
    const first = body.draft.updated_at;
    await POST('/api/ext/forms/dbkq_test/draft',
      { case_id: 'abc12345', values: { reason: 'finished on my laptop' } });
    expect(drafts.size).toBe(1);
    body = await (await GET('/api/ext/forms/dbkq_test?case_id=abc12345')).json();
    expect(body.draft.data).toEqual({ reason: 'finished on my laptop' });
    expect(Date.parse(body.draft.updated_at)).toBeGreaterThan(Date.parse(first));

    // Delete.
    r = await DEL('/api/ext/forms/dbkq_test/draft?case_id=abc12345');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'success' });
    expect(drafts.has(draftKey)).toBe(false);
  });

  test('AC1: after DELETE the `draft` key stays PRESENT and null — the client signal must survive an empty draft', async () => {
    await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'abc12345', values: { reason: 'x' } });
    await DEL('/api/ext/forms/dbkq_test/draft?case_id=abc12345');
    const body = await (await GET('/api/ext/forms/dbkq_test?case_id=abc12345')).json();
    expect('draft' in body).toBe(true);
    expect(body.draft).toBeNull();
  });

  test('DELETE succeeds identically whether or not a row existed (existence is an oracle)', async () => {
    const a = await DEL('/api/ext/forms/dbkq_test/draft?case_id=abc12345');
    await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'abc12345', values: { reason: 'x' } });
    const b = await DEL('/api/ext/forms/dbkq_test/draft?case_id=abc12345');
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual(await b.json());
  });

  test('the GET never carries the submitted row alongside the draft', async () => {
    await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'abc12345', values: { reason: 'draft' } });
    const body = await (await GET('/api/ext/forms/dbkq_test?case_id=abc12345')).json();
    expect(Object.keys(body).sort()).toEqual(
      ['definition', 'draft', 'link_type', 'linked', 'load', 'schema_version', 'status', 'title']);
    expect(JSON.stringify(body)).not.toContain('submitted');
  });

  test('anonymous GET on a serverDrafts template carries NO draft key (no anonymous identity)', async () => {
    fixture.caseRow = null;                     // degrade mode, unresolvable id
    const body = await (await GET('/api/ext/forms/dbkq_test?case_id=deadbeef')).json();
    expect(body.linked).toBe(false);
    expect('draft' in body).toBe(false);
  });

  // ── AC2: submit clears ────────────────────────────────────────────────────

  test('AC2: a successful submit clears the server draft row and records the submission', async () => {
    await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'abc12345', values: { reason: 'wip' } });
    expect(drafts.has(draftKey)).toBe(true);

    const r = await POST('/api/ext/forms/dbkq_test/submit',
      { case_id: 'abc12345', values: { reason: 'final answer' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'success' });

    // cleanup is fire-and-forget — it lands on a later tick
    for (let i = 0; i < 50 && drafts.has(draftKey); i++) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(drafts.has(draftKey)).toBe(false);

    const insert = fixture._db.calls.find(
      (c) => c.sql.startsWith('INSERT INTO form_submissions') && c.sql.includes("'submitted'"));
    expect(insert.params.slice(0, 3)).toEqual(['dbkq_test', 'case', 'abc12345']);
    expect(insert.params[insert.params.length - 1]).toBeNull();       // submitted_by NULL
  });

  test('AC2: a draft-cleanup failure never fails an already-recorded submission', async () => {
    await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'abc12345', values: { reason: 'wip' } });
    expect(drafts.has(draftKey)).toBe(true);

    // The submission is irreversible by the time cleanup runs, so a DELETE
    // that explodes must be logged and swallowed — never surfaced as a 500 the
    // client would retry into a duplicate submission.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fixture.breakDelete = true;

    const r = await POST('/api/ext/forms/dbkq_test/submit',
      { case_id: 'abc12345', values: { reason: 'final' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'success' });

    await sleep(50);
    expect(drafts.has(draftKey)).toBe(true);            // stale row survives, harmlessly
    expect(spy.mock.calls.some((c) => String(c[0]).includes('draft cleanup failed'))).toBe(true);
    spy.mockRestore();
  });

  test('a template WITHOUT serverDrafts never has its draft cleared on submit (no DELETE at all)', async () => {
    fixture.template = tplRow({ definition: plainDef });
    await POST('/api/ext/forms/dbkq_test/submit',
      { case_id: 'abc12345', values: { reason: 'x' } });
    await new Promise((res) => setTimeout(res, 40));
    expect(fixture._db.calls.some((c) => c.sql.startsWith('DELETE'))).toBe(false);
  });

  // ── AC3: shape ────────────────────────────────────────────────────────────

  test('AC3: array values → 400; undeclared key → 400 naming it; >64KB → 400; nothing stored', async () => {
    const cases = [
      [{ case_id: 'abc12345', values: ['a'] }, 'values must be an object'],
      [{ case_id: 'abc12345', values: { nope: 'x' } }, 'values.nope is not a field of this form'],
      [{ case_id: 'abc12345',
         values: { cars: Array.from({ length: 100 }, () => ({ make: 'x'.repeat(1000) })) } },
       'too large'],
    ];
    for (const [body, part] of cases) {
      const r = await POST('/api/ext/forms/dbkq_test/draft', body);
      expect(r.status).toBe(400);
      expect((await r.json()).message).toContain(part);
    }
    expect(drafts.size).toBe(0);
  });

  test('AC3: a PARTIAL draft the submit route would reject is saved happily', async () => {
    const r = await POST('/api/ext/forms/dbkq_test/draft',
      { case_id: 'abc12345', values: { client_name: 'Ada' } });   // `reason` required, absent
    expect(r.status).toBe(200);
    const bad = await POST('/api/ext/forms/dbkq_test/submit',
      { case_id: 'abc12345', values: { client_name: 'Ada' } });
    expect(bad.status).toBe(400);
  });

  test('body keys other than case_id/values are refused (§2 inversion)', async () => {
    const r = await POST('/api/ext/forms/dbkq_test/draft',
      { case_id: 'abc12345', values: {}, link_type: 'case' });
    expect(r.status).toBe(400);
    expect((await r.json()).message).toContain('unexpected body key');
  });

  // ── AC4: no-oracle parity ─────────────────────────────────────────────────

  test('AC4: every refusal branch on POST and DELETE returns the byte-identical generic 404', async () => {
    const scenarios = [
      ['serverDrafts off',   () => { fixture.template = tplRow({ definition: plainDef }); }],
      ['unknown form_key',   () => { fixture.template = null; }],
      ['internal visibility',() => { fixture.template = tplRow({ visibility: 'internal' }); }],
      ['invalid case_id',    () => { fixture.caseRow = null; }],
      ['bad form_key shape', () => {}],
    ];
    const seen = [];
    for (const [name, setup] of scenarios) {
      setup();
      const key = name === 'bad form_key shape' ? 'BAD-KEY' : 'dbkq_test';
      const p = await POST(`/api/ext/forms/${key}/draft`,
        { case_id: 'abc12345', values: { reason: 'x' } });
      const d = await DEL(`/api/ext/forms/${key}/draft?case_id=abc12345`);
      seen.push([name, p.status, await p.json()], [name, d.status, await d.json()]);
      // reset for the next scenario
      fixture.template = tplRow();
      fixture.caseRow = { case_id: 'abc12345' };
    }
    for (const [name, status, body] of seen) {
      expect([name, status]).toEqual([name, 404]);
      expect([name, body]).toEqual([name, { status: 'error', message: 'Not found' }]);
    }
    expect(drafts.size).toBe(0);
  });

  test('AC4: no badLink flag on the draft routes even in reject mode', async () => {
    fixture.template = tplRow({
      definition: { ...draftsDef, external: { serverDrafts: true } } });   // reject default
    fixture.caseRow = null;
    for (const r of [
      await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'nope1234', values: {} }),
      await DEL('/api/ext/forms/dbkq_test/draft?case_id=nope1234'),
      await POST('/api/ext/forms/dbkq_test/draft', { values: {} }),          // no case_id at all
    ]) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ status: 'error', message: 'Not found' });
    }
  });

  test('the CORS revocation and no-store apply to the draft routes too', async () => {
    const r = await POST('/api/ext/forms/dbkq_test/draft',
      { case_id: 'abc12345', values: { reason: 'x' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  // ── AC5: intake untouched ─────────────────────────────────────────────────

  test('AC5: a template with no serverDrafts flag — GET carries no draft key, POST/DELETE 404', async () => {
    fixture.template = tplRow({ form_key: 'intake', definition: plainDef });
    const body = await (await GET('/api/ext/forms/intake?case_id=abc12345')).json();
    expect(body.linked).toBe(true);
    expect('draft' in body).toBe(false);
    // and no draft read was even attempted
    expect(fixture._db.calls.some((c) => c.sql.includes('status = \'draft\''))).toBe(false);

    fixture.template = tplRow({ form_key: 'intake', definition: plainDef });
    const p = await POST('/api/ext/forms/intake/draft', { case_id: 'abc12345', values: {} });
    fixture.template = tplRow({ form_key: 'intake', definition: plainDef });
    const d = await DEL('/api/ext/forms/intake/draft?case_id=abc12345');
    expect([p.status, d.status]).toEqual([404, 404]);
    expect(await p.json()).toEqual({ status: 'error', message: 'Not found' });
    expect(await d.json()).toEqual({ status: 'error', message: 'Not found' });
  });

  test('external.serverDrafts:false is OFF, not merely absent', async () => {
    fixture.template = tplRow({
      definition: { ...draftsDef, external: { badLink: 'degrade', serverDrafts: false } } });
    const body = await (await GET('/api/ext/forms/dbkq_test?case_id=abc12345')).json();
    expect('draft' in body).toBe(false);
    fixture.template = tplRow({
      definition: { ...draftsDef, external: { badLink: 'degrade', serverDrafts: false } } });
    const p = await POST('/api/ext/forms/dbkq_test/draft', { case_id: 'abc12345', values: {} });
    expect(p.status).toBe(404);
  });

  // ── limits ────────────────────────────────────────────────────────────────

  test('the draft per-IP budget is the autosave-sized one, not the submit budget', async () => {
    // Submit allows 10 per 15 min per IP. An autosave heartbeat needs more:
    // 11 draft saves from ONE pinned IP must all succeed.
    const ip = '198.51.100.41';
    for (let i = 0; i < 11; i++) {
      const r = await POST('/api/ext/forms/dbkq_test/draft',
        { case_id: 'abc12345', values: { reason: 'tick ' + i } }, ip);
      expect(r.status).toBe(200);
    }
  });

  test('per-case draft cap: malformed drafts spend no token (the F5 ordering lesson), valid ones do', async () => {
    fixture.caseRow = { case_id: 'capcase1' };
    // The cap is 360/hr, RAISED from 120 on 2026-09-04. The original number was
    // set against arithmetic that ran the wrong way: the autosave is a debounce
    // reset on every change (yc-forms _onFieldChange), so a legitimate filler's
    // worst case is one POST per autosaveMs — 360/hr at the 10s the DBKQ uses,
    // i.e. THREE TIMES the old cap. A cap below the worst case degrades a
    // real client to device-local drafts partway through a 148-card form,
    // which is the exact resume this feature exists to provide.
    //
    // 361 malformed — more than the whole per-case budget. Rotating IPs so the
    // per-IP limiter is not what the assertion is really measuring.
    for (let i = 0; i < 361; i++) {
      const r = await POST('/api/ext/forms/dbkq_test/draft',
        { case_id: 'capcase1', values: { not_a_field: 'x' } });
      expect(r.status).toBe(400);
    }
    // The real client is untouched: 360 valid saves still fit...
    let last;
    for (let i = 0; i < 360; i++) {
      last = await POST('/api/ext/forms/dbkq_test/draft',
        { case_id: 'capcase1', values: { reason: 'tick ' + i } });
    }
    expect(last.status).toBe(200);
    // ...and the 361st is capped.
    const over = await POST('/api/ext/forms/dbkq_test/draft',
      { case_id: 'capcase1', values: { reason: 'one too many' } });
    expect(over.status).toBe(429);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. validateDefinition — external.serverDrafts
// ════════════════════════════════════════════════════════════════════════════

describe('validateDefinition — external.serverDrafts (D1)', () => {
  const cleanDef = { sections: [{ title: 'S', rows: [{ fields: [
    { name: 'a', type: 'text' }] }] }] };
  const withSD = (serverDrafts) => ({
    ...cleanDef, external: { badLink: 'degrade', serverDrafts } });

  test('accepts true and false', () => {
    expect(() => tplSvc.validateDefinition(withSD(true))).not.toThrow();
    expect(() => tplSvc.validateDefinition(withSD(false))).not.toThrow();
    expect(() => tplSvc.validateDefinition({ ...cleanDef, external: { serverDrafts: true } }))
      .not.toThrow();
  });

  test('rejects non-boolean — a truthy string must never silently opt a form in', () => {
    for (const v of ['true', 'yes', 1, 0, null, {}, []]) {
      expect(() => tplSvc.validateDefinition(withSD(v)))
        .toThrow(/external\.serverDrafts must be a boolean/);
    }
  });

  test('the external exact-key list is still exact', () => {
    expect(() => tplSvc.validateDefinition({ ...cleanDef, external: { serverdrafts: true } }))
      .toThrow(/unknown key "serverdrafts"/);
    expect(() => tplSvc.validateDefinition({ ...cleanDef,
      external: { serverDrafts: true, mode: 1 } })).toThrow(/unknown key "mode"/);
  });

  test('coexists with the other external keys', () => {
    expect(() => tplSvc.validateDefinition({ ...cleanDef, external: {
      badLink: 'degrade', serverDrafts: true,
      postSubmit: { message: 'Thanks' },
      appearance: { bgFrom: '#fff' },
    } })).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. jsdom — the client half
// ════════════════════════════════════════════════════════════════════════════

const EXT_DEF = {
  toggle: false,
  autosave: true,
  autosaveMs: 40,
  sections: [{ title: 'Contact', rows: [{ fields: [
    { name: 'client_name', type: 'text', prefill: '$load.contact_name' },
    { name: 'reason', type: 'text', required: true },
  ] }] }],
};
const LOAD = { contact_name: 'Ada L', contact_phone: '555', contact_email: 'ada@x.test' };

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    return Promise.resolve(Buffer.from(''));
  }
}

const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * External-mode page. `getBody` controls the /api/ext GET payload — including
 * whether it carries a `draft` key at all, which is the whole D1 signal.
 */
function makePage(opts = {}) {
  const fetches = [];
  const url = 'https://app.test/forms/render.html?' +
    (opts.query || 'form_key=dbkq_test&case_id=abc12345&ext=1');

  const fetchStub = async (u, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    fetches.push({ url: u, method, body });
    if (u.indexOf('/draft') !== -1) {
      if (opts.draftFails) return { ok: false, status: 500, json: async () => ({ message: 'boom' }) };
      return { ok: true, status: 200,
               json: async () => ({ status: 'success', updated_at: '2026-09-04T12:00:00.000Z' }) };
    }
    if (u.endsWith('/submit')) {
      return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
    }
    if (u.startsWith('/api/ext/forms/')) {
      const resBody = opts.getBody !== undefined ? opts.getBody : {
        status: 'success', title: 'Q', link_type: 'case', schema_version: 3,
        definition: EXT_DEF, load: LOAD, linked: true, draft: null,
      };
      return { ok: true, status: 200, json: async () => resBody };
    }
    throw new Error('unstubbed fetch: ' + method + ' ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) {
        window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      }
      window.fetch = fetchStub;
      if (opts.seedLocal) {
        window.localStorage.setItem(opts.seedLocal.key, JSON.stringify(opts.seedLocal.value));
      }
    },
  });
  DOMS.push(dom);
  return { dom, fetches, window: dom.window };
}

async function ready(page) {
  const w = page.window;
  for (let i = 0; i < 200; i++) {
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') return w;
    await sleep(20);
  }
  const fatal = w.document.querySelector('.ycr-fatal');
  throw new Error(fatal ? 'render fatal: ' + fatal.textContent : 'form never finished init');
}

function type(w, name, value) {
  const el = w.document.querySelector(`[name="${name}"]`);
  el.value = value;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
}

const LOCAL_KEY = 'ycExtDraft:dbkq_test:abc12345';

describe('external server drafts — client (jsdom)', () => {
  test('autosave POSTs the draft to the ext draft route and drops the device copy', async () => {
    const page = makePage();
    const w = await ready(page);

    type(w, 'reason', 'typing away');
    await sleep(150);

    const post = page.fetches.find((f) => f.method === 'POST' && f.url.indexOf('/draft') !== -1);
    expect(post.url).toBe('/api/ext/forms/dbkq_test/draft');
    expect(Object.keys(post.body).sort()).toEqual(['case_id', 'values']);
    expect(post.body.case_id).toBe('abc12345');
    expect(post.body.values.reason).toBe('typing away');
    // server is the source of truth — no stale local copy left to out-rank it
    expect(w.localStorage.getItem(LOCAL_KEY)).toBeNull();
    expect(w.document.getElementById('saveStatus').textContent).toContain('just now');
  });

  test('a server draft in the GET payload raises the recovery banner with NO localStorage at all', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Q', link_type: 'case', schema_version: 3,
                 definition: EXT_DEF, load: LOAD, linked: true,
                 draft: { data: { reason: 'started on my phone' },
                          updated_at: '2026-09-04T12:00:00.000Z', schema_version: 3 } },
    });
    const w = await ready(page);
    expect(w.localStorage.getItem(LOCAL_KEY)).toBeNull();      // different "device"

    const banner = w.document.getElementById('draftBanner');
    expect(banner.style.display).not.toBe('none');
    w.document.getElementById('draftRestore').click();
    await sleep(50);
    expect(w.document.querySelector('[name="reason"]').value).toBe('started on my phone');
  });

  test('pick-newer: a strictly newer local draft wins; server wins ties and unparseable stamps', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Q', link_type: 'case', schema_version: 3,
                 definition: EXT_DEF, load: LOAD, linked: true,
                 draft: { data: { reason: 'server copy' },
                          updated_at: '2026-09-04T12:00:00.000Z', schema_version: 3 } },
      seedLocal: {
        key: LOCAL_KEY,
        value: { data: { reason: 'newer local copy' },
                 updated_at: '2026-09-04T18:00:00.000Z', schema_version: 3 },
      },
    });
    const w = await ready(page);
    w.document.getElementById('draftRestore').click();
    await sleep(50);
    expect(w.document.querySelector('[name="reason"]').value).toBe('newer local copy');

    // The rule itself, exercised directly on the booted form.
    const f = w.ycForm;
    const S = { data: { a: 1 }, updated_at: '2026-09-04T12:00:00.000Z' };
    const older = { data: { a: 2 }, updated_at: '2026-09-04T11:00:00.000Z' };
    const same  = { data: { a: 3 }, updated_at: '2026-09-04T12:00:00.000Z' };
    const junk  = { data: { a: 4 }, updated_at: 'not-a-date' };
    expect(f._pickExternalDraft(S, older)).toBe(S);
    expect(f._pickExternalDraft(S, same)).toBe(S);            // tie → server
    expect(f._pickExternalDraft(S, junk)).toBe(S);            // unparseable → server
    expect(f._pickExternalDraft(null, older)).toBe(older);
    expect(f._pickExternalDraft(S, null)).toBe(S);
    expect(f._pickExternalDraft(null, null)).toBeNull();
  });

  test('a failed server save falls back to this device and says so — never a hard failure', async () => {
    const page = makePage({ draftFails: true });
    const w = await ready(page);

    type(w, 'reason', 'network is flaky');
    await sleep(150);

    expect(page.fetches.some((f) => f.url.indexOf('/draft') !== -1)).toBe(true);
    const local = JSON.parse(w.localStorage.getItem(LOCAL_KEY));
    expect(local.data.reason).toBe('network is flaky');
    expect(w.document.getElementById('saveStatus').textContent).toContain('on this device');
  });

  test('discard DELETEs the server draft (with the case_id) and clears the device copy', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Q', link_type: 'case', schema_version: 3,
                 definition: EXT_DEF, load: LOAD, linked: true,
                 draft: { data: { reason: 'old' },
                          updated_at: '2026-09-04T12:00:00.000Z', schema_version: 3 } },
      seedLocal: {
        key: LOCAL_KEY,
        value: { data: { reason: 'old local' },
                 updated_at: '2026-09-03T12:00:00.000Z', schema_version: 3 },
      },
    });
    const w = await ready(page);
    w.document.getElementById('draftDiscard').click();
    await sleep(80);

    const del = page.fetches.find((f) => f.method === 'DELETE');
    expect(del.url).toBe('/api/ext/forms/dbkq_test/draft?case_id=abc12345');
    expect(w.localStorage.getItem(LOCAL_KEY)).toBeNull();
    expect(w.document.getElementById('draftBanner').style.display).toBe('none');
  });

  test('AC5 client half: no `draft` key in the payload → the draft route is never touched, localStorage unchanged', async () => {
    const page = makePage({
      getBody: { status: 'success', title: 'Q', link_type: 'case', schema_version: 3,
                 definition: EXT_DEF, load: LOAD, linked: true },      // no draft key
    });
    const w = await ready(page);

    type(w, 'reason', 'pre-D1 behavior');
    await sleep(150);
    expect(page.fetches.some((f) => f.url.indexOf('/draft') !== -1)).toBe(false);
    expect(JSON.parse(w.localStorage.getItem(LOCAL_KEY)).data.reason).toBe('pre-D1 behavior');

    w.document.getElementById('saveBtn').click();
    await sleep(150);
    expect(w.localStorage.getItem(LOCAL_KEY)).toBeNull();               // submit still clears
    expect(page.fetches.some((f) => f.method === 'DELETE')).toBe(false);
  });

  test('anonymous boot never uses the server path even if the flag somehow arrived', async () => {
    const page = makePage({
      query: 'form_key=dbkq_test&ext=1',
      getBody: { status: 'success', title: 'Q', link_type: 'case', schema_version: 3,
                 definition: EXT_DEF, load: null, linked: false, draft: null },
    });
    const w = await ready(page);
    type(w, 'reason', 'anonymous answers');
    await sleep(150);

    expect(page.fetches.some((f) => f.url.indexOf('/draft') !== -1)).toBe(false);
    // and the anonymous record still lives in sessionStorage (F4), not local
    const anonKey = 'ycExtDraft:dbkq_test:anon';
    expect(w.localStorage.getItem(anonKey)).toBeNull();
    expect(JSON.parse(w.sessionStorage.getItem(anonKey)).data.reason).toBe('anonymous answers');
  });

  test('submit clears the banner and the device copy; the server row is the ROUTE\'s job, not a second client call', async () => {
    const page = makePage();
    const w = await ready(page);
    type(w, 'reason', 'done');
    await sleep(150);                                  // one server autosave
    w.document.getElementById('saveBtn').click();
    await sleep(150);

    expect(page.fetches.some((f) => f.method === 'DELETE')).toBe(false);
    expect(w.localStorage.getItem(LOCAL_KEY)).toBeNull();
    expect(w.document.getElementById('draftBanner').style.display).toBe('none');
  });
});
