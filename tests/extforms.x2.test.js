// X2 — external form surface, server side (EXTERNAL_FORMS_DESIGN §2/§4/§5/§6).
// Two layers:
//   1. extFormService unit tests (stub pool) — gate, projection allowlist,
//      case resolution, value re-validation incl. §9.7 shape tricks.
//   2. LIVE-ROUTER integration — routes/api.ext.forms.js mounted in a real
//      express app on an ephemeral port, hit with fetch. Locks the §9 items
//      only the route can prove: one generic 404 body across every refusal
//      branch (§9.4), badLink flag semantics, server-side linkage (('','')
//      degrade convention), NO apiColumn/case write path (§9.6 — the stub db
//      records every query), and workflow id read from the PUBLISHED
//      DEFINITION never the request body (jest-mocked internal_functions).
//   3. urlParam validator rules (formTemplateService §7 additions).
'use strict';

jest.mock('../lib/internal_functions', () => ({
  start_workflow: jest.fn(async () => ({ success: true, output: { workflow_execution_id: 1 } })),
}));

const path = require('path');
const express = require('express');
const svc = require(path.join(__dirname, '..', 'services', 'extFormService.js'));
const tplSvc = require(path.join(__dirname, '..', 'services', 'formTemplateService.js'));
const internalFunctions = require('../lib/internal_functions');

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseSections = [{
  title: 'S',
  rows: [{ fields: [
    { name: 'client_name', type: 'text', prefill: '$load.contact_name' },
    { name: 'reason', type: 'text', required: true, maxLength: 200 },
    { name: 'src', type: 'hidden', urlParam: 'src' },
    { name: 'contact_pref', type: 'select', options: ['Phone', 'Email'] },
    { name: 'best_time', type: 'text',
      requiredWhen: { field: 'contact_pref', op: 'eq', value: 'Phone' } },
  ] }],
}];

const publicDef = { toggle: false, sections: baseSections,
                    external: { badLink: 'degrade' },
                    onSubmit: { workflow: { id: 42, initData: { source: 'ext_test' } } } };
const rejectDef = { toggle: false, sections: baseSections };   // no external key → reject default

// Full server row for form_templates lookups.
const tplRow = (over) => ({
  form_key: 'intake_test', title: 'Intake', link_type: 'case',
  schema_version: 3, visibility: 'public', definition: publicDef, ...over,
});

// Content-routed stub pool: dispatch by SQL text, record every call.
function routedDb(fixture) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: q, params: params || [] });
      if (q.includes('FROM form_templates'))      return [fixture.template ? [fixture.template] : []];
      if (q.includes('FROM cases'))               return [fixture.caseRow ? [fixture.caseRow] : []];
      if (q.includes('JOIN case_relate'))         return [fixture.primary ? [fixture.primary] : []];
      if (q.includes('MAX(version)'))             return [[{ max_version: 0 }]];
      if (q.startsWith('INSERT INTO form_submissions')) return [{ insertId: 101 }];
      if (q.includes('SELECT updated_at FROM form_submissions')) return [[{ updated_at: '2026-08-11T00:00:00Z' }]];
      throw new Error('routedDb: unrouted query: ' + q);
    },
  };
}

// ── 1a. getServableTemplate — the one null (§5.4) ───────────────────────────

describe('extFormService.getServableTemplate', () => {
  test('unknown / unpublished form_key → null', async () => {
    const db = routedDb({ template: null });
    expect(await svc.getServableTemplate(db, 'nope')).toBeNull();
  });

  test('visibility internal and portal → null under the v1 public scope', async () => {
    for (const visibility of ['internal', 'portal']) {
      const db = routedDb({ template: tplRow({ visibility }) });
      expect(await svc.getServableTemplate(db, 'intake_test')).toBeNull();
    }
  });

  test('portal scope option widens (the portal-mode slice hook)', async () => {
    const db = routedDb({ template: tplRow({ visibility: 'portal' }) });
    const out = await svc.getServableTemplate(db, 'intake_test', { scopes: ['public', 'portal'] });
    expect(out).not.toBeNull();
  });

  test('§4 per-request refusal: code / css / hooks / embed each → null', async () => {
    const embedDef = { sections: [{ title: 'S', rows: [{ fields: [
      { name: 'e', type: 'embed', src: 'https://x.test' }] }] }] };
    for (const definition of [
      { ...publicDef, code: 'x=1' },
      { ...publicDef, css: '.a{}' },
      { ...publicDef, hooks: 'notes_341' },
      embedDef,
    ]) {
      const db = routedDb({ template: tplRow({ definition }) });
      expect(await svc.getServableTemplate(db, 'intake_test')).toBeNull();
    }
  });

  test('clean public template serves, definition parsed', async () => {
    const db = routedDb({ template: tplRow({ definition: JSON.stringify(publicDef) }) });
    const out = await svc.getServableTemplate(db, 'intake_test');
    expect(out.schema_version).toBe(3);
    expect(out.definition.sections).toBeDefined();
  });
});

// ── 1b. projection allowlist ────────────────────────────────────────────────

describe('extFormService.projectDefinition', () => {
  test('server-only keys never reach the public wire; renderer keys survive', () => {
    const def = {
      toggle: false, dataMode: 'snapshot', note: 'internal commentary',
      endpoints: { load: { url: '/api/cases/{linkId}' } },
      onSubmit: { workflow: { id: 42 }, patch: { url: '/api/cases/{linkId}' } },
      external: { badLink: 'degrade' },
      derive: [{ target: 'a', from: 'b', op: 'addDays', n: 1 }],
      sections: [{ title: 'S', note: 'secret', rows: [{ fields: [
        { name: 'a', type: 'date' },
        { name: 'b', type: 'date', apiColumn: 'case_file_date',
          prefill: '{{cases.case_file_date}}', note: 'why' },
        { name: 'c', type: 'text', prefill: '$load.contact_name', urlParam: 'src',
          required: true, showWhen: { field: 'a', op: 'notEmpty' } },
        { name: 'd', type: 'select', options: ['1'],
          optionsFrom: { source: 'firmData.settings.x', value: 'v' } },
      ] }] }],
    };
    const p = svc.projectDefinition(def);
    const flat = JSON.stringify(p);
    for (const leaked of ['endpoints', 'onSubmit', 'apiColumn', 'optionsFrom',
                          'note', 'external', 'firmData', '{{cases']) {
      expect(flat).not.toContain(leaked);
    }
    const fields = p.sections[0].rows[0].fields;
    expect(fields[1].prefill).toBeUndefined();               // resolver expr stripped
    expect(fields[2].prefill).toBe('$load.contact_name');    // $load survives
    expect(fields[2].urlParam).toBe('src');
    expect(fields[2].showWhen).toEqual({ field: 'a', op: 'notEmpty' });
    expect(p.derive).toBeDefined();
    expect(p.dataMode).toBe('snapshot');
  });

  test('tabs + sticky regions and repeaters project structurally', () => {
    const def = {
      tabs: [{ label: 'T', sections: [{ repeater: 'items', title: 'R', addLabel: '+',
        fields: [{ name: 'x', type: 'text', apiColumn: 'nope' }] }] }],
      stickyTop: [{ title: 'Top', rows: [{ fields: [{ name: 'y', type: 'text' }] }] }],
    };
    const p = svc.projectDefinition(def);
    expect(p.tabs[0].sections[0].repeater).toBe('items');
    expect(p.tabs[0].sections[0].fields[0].apiColumn).toBeUndefined();
    expect(p.stickyTop[0].rows[0].fields[0].name).toBe('y');
  });
});

// ── 1c. resolveCase — §5.2.3 hard projection ────────────────────────────────

describe('extFormService.resolveCase', () => {
  test('malformed case_ids never reach the DB', async () => {
    const db = routedDb({});
    for (const bad of ['', null, undefined, 'x'.repeat(21), 'has space', 'a;DROP', 'a/../b']) {
      expect((await svc.resolveCase(db, bad)).valid).toBe(false);
    }
    expect(db.calls.length).toBe(0);
  });

  test('unknown case → invalid; known case + Primary → exactly the 3 fields', async () => {
    expect((await svc.resolveCase(routedDb({ caseRow: null }), 'abc12345')).valid).toBe(false);

    const db = routedDb({
      caseRow: { case_id: 'abc12345' },
      primary: { contact_name: 'N', contact_phone: 'P', contact_email: 'E',
                 contact_ssn: 'NEVER' },   // even a sloppy stub row must not leak
    });
    const out = await svc.resolveCase(db, 'abc12345');
    expect(out).toEqual({ valid: true, load: {
      contact_name: 'N', contact_phone: 'P', contact_email: 'E' } });
    // §9.2: the projection query itself names exactly the three columns.
    const projSql = db.calls[1].sql;
    expect(projSql).toContain('co.contact_name, co.contact_phone, co.contact_email');
    expect(projSql).not.toContain('*');
  });

  test('case without a Primary: valid link, null load', async () => {
    const out = await svc.resolveCase(
      routedDb({ caseRow: { case_id: 'abc12345' }, primary: null }), 'abc12345');
    expect(out).toEqual({ valid: true, load: null });
  });
});

// ── 1d. validateValues — §5.3.2 + §9.7 ──────────────────────────────────────

describe('extFormService.validateValues', () => {
  const ok = (values) => expect(() => svc.validateValues(publicDef, values)).not.toThrow();
  const bad = (values, part) => {
    let err; try { svc.validateValues(publicDef, values); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
    if (part) expect(err.message).toContain(part);
  };

  test('happy paths', () => {
    ok({ reason: 'help with ch7' });
    ok({ reason: 'r', client_name: 'Bob', src: 'facebook', contact_pref: 'Email' });
    ok({ reason: 'r', contact_pref: 'Phone', best_time: 'morning' });   // requiredWhen satisfied
  });

  test('required + requiredWhen enforced server-side', () => {
    bad({}, 'values.reason is required');
    bad({ reason: '  ' }, 'values.reason is required');
    bad({ reason: 'r', contact_pref: 'Phone' }, 'values.best_time');    // condition true, empty
  });

  test('§9.7 shape tricks: non-object roots, arrays where strings expected, prototype keys, unknown keys', () => {
    for (const root of [null, [], 'str', 7]) {
      let err; try { svc.validateValues(publicDef, root); } catch (e) { err = e; }
      expect(err && err.status).toBe(400);
    }
    bad({ reason: ['a'] }, 'scalar');
    bad({ reason: { a: 1 } }, 'scalar');
    bad(JSON.parse('{"reason":"r","__proto__":{"polluted":1}}'), '__proto__');
    bad({ reason: 'r', constructor: 'x' }, 'constructor');
    bad({ reason: 'r', not_a_field: 1 }, 'not_a_field');
  });

  test('option membership, length caps, repeater discipline', () => {
    bad({ reason: 'r', contact_pref: 'Fax' }, 'allowed options');
    bad({ reason: 'x'.repeat(201) }, 'maximum length 200');

    const repDef = { sections: [
      { title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] },
      { repeater: 'cars', title: 'Cars', fields: [{ name: 'make', type: 'text' }] },
    ] };
    expect(() => svc.validateValues(repDef, { a: 'x', cars: [{ make: 'Ford' }] })).not.toThrow();
    const failRep = (values, part) => {
      let err; try { svc.validateValues(repDef, values); } catch (e) { err = e; }
      expect(err && err.status).toBe(400);
      expect(err.message).toContain(part);
    };
    failRep({ cars: 'notarray' }, 'must be an array');
    failRep({ cars: [{ vin: 'x' }] }, 'not a field of this repeater');
    failRep({ cars: ['str'] }, 'must be an object');
    failRep({ cars: Array.from({ length: 101 }, () => ({ make: 'x' })) }, 'exceeds 100');
  });
});

// ── 2. LIVE-ROUTER integration — the §9 route locks ─────────────────────────

describe('routes/api.ext.forms.js (live router)', () => {
  let server, base, fixture;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.db = routedDb(fixture); req.db.calls && (fixture._lastCalls = req.db.calls); next(); });
    app.use(require('../routes/api.ext.forms.js'));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => {
    // undici's fetch keeps sockets alive — close() alone hangs the suite.
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(done);
  });
  beforeEach(() => { fixture = {}; internalFunctions.start_workflow.mockClear(); });

  const GET  = (p) => fetch(base + p);
  const POST = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });

  test('§9.4 no-oracle: every template refusal branch returns THE SAME 404 body', async () => {
    const bodies = [];
    // unknown key
    fixture = { template: null };
    bodies.push(await (await GET('/api/ext/forms/nope')).json());
    // wrong visibility
    fixture = { template: tplRow({ visibility: 'internal' }) };
    bodies.push(await (await GET('/api/ext/forms/intake_test')).json());
    // refused keys
    fixture = { template: tplRow({ definition: { ...publicDef, code: 'x=1' } }) };
    bodies.push(await (await GET('/api/ext/forms/intake_test')).json());
    for (const b of bodies) expect(b).toEqual({ status: 'error', message: 'Not found' });
  });

  test('GET degrade: bad case_id → 200 anonymous (load null, linked false) — never confirms the id', async () => {
    fixture = { template: tplRow(), caseRow: null };
    const res = await GET('/api/ext/forms/intake_test?case_id=deadbeef');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.linked).toBe(false);
    expect(body.load).toBeNull();
    expect(body.definition.onSubmit).toBeUndefined();        // projection on the wire
  });

  test('GET reject: bad OR missing case_id → 404 + badLink flag, identically', async () => {
    fixture = { template: tplRow({ definition: rejectDef }), caseRow: null };
    const r1 = await GET('/api/ext/forms/intake_test?case_id=deadbeef');
    const r2 = await GET('/api/ext/forms/intake_test');
    expect(r1.status).toBe(404);
    expect(await r1.json()).toEqual({ status: 'error', message: 'Not found', badLink: true });
    expect(await r2.json()).toEqual({ status: 'error', message: 'Not found', badLink: true });
  });

  test('GET linked: valid case_id → the 3-field load', async () => {
    fixture = { template: tplRow(), caseRow: { case_id: 'abc12345' },
      primary: { contact_name: 'N', contact_phone: 'P', contact_email: 'E' } };
    const body = await (await GET('/api/ext/forms/intake_test?case_id=abc12345')).json();
    expect(body.linked).toBe(true);
    expect(body.load).toEqual({ contact_name: 'N', contact_phone: 'P', contact_email: 'E' });
  });

  test('submit linked: server-resolved linkage, submitted_by NULL, workflow from THE DEFINITION (body ids ignored)', async () => {
    fixture = { template: tplRow(), caseRow: { case_id: 'abc12345' }, primary: null };
    const res = await POST('/api/ext/forms/intake_test/submit',
      { case_id: 'abc12345', values: { reason: 'help' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'success' });   // minimal body — no id/version

    const insert = fixture._lastCalls.find((c) => c.sql.startsWith('INSERT INTO form_submissions'));
    expect(insert.params).toEqual(['intake_test', 'case', 'abc12345', 1, 3,
      JSON.stringify({ reason: 'help' }), null]);

    expect(internalFunctions.start_workflow).toHaveBeenCalledTimes(1);
    const [wfParams] = internalFunctions.start_workflow.mock.calls[0];
    expect(wfParams.workflow_id).toBe(42);                     // definition's id
    expect(wfParams.init_data).toMatchObject({
      reason: 'help', source: 'ext_test',
      form_key: 'intake_test', link_type: 'case', link_id: 'abc12345', submission_id: 101,
    });
  });

  test('submit degrade-anonymous: (\'\',\'\') linkage; body workflow/link keys REJECTED (inversion)', async () => {
    fixture = { template: tplRow(), caseRow: null };
    const res = await POST('/api/ext/forms/intake_test/submit', { values: { reason: 'anon' } });
    expect(res.status).toBe(200);
    const insert = fixture._lastCalls.find((c) => c.sql.startsWith('INSERT INTO form_submissions'));
    expect(insert.params.slice(0, 3)).toEqual(['intake_test', '', '']);

    const strict = await POST('/api/ext/forms/intake_test/submit',
      { values: { reason: 'x' }, link_type: 'case', link_id: '1' });
    expect(strict.status).toBe(400);
    expect((await strict.json()).message).toContain('unexpected body key');
  });

  test('submit reject-mode bad link: 404 + badLink, NOTHING recorded', async () => {
    fixture = { template: tplRow({ definition: rejectDef }), caseRow: null };
    const res = await POST('/api/ext/forms/intake_test/submit', { values: { reason: 'x' } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ status: 'error', message: 'Not found', badLink: true });
    expect(fixture._lastCalls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
    expect(internalFunctions.start_workflow).not.toHaveBeenCalled();
  });

  test('§9.6 apiColumn dead externally: a full linked submit touches form_submissions ONLY — no cases/contacts write of any kind', async () => {
    fixture = { template: tplRow(), caseRow: { case_id: 'abc12345' }, primary: null };
    await POST('/api/ext/forms/intake_test/submit',
      { case_id: 'abc12345', values: { reason: 'help' } });
    for (const c of fixture._lastCalls) {
      if (/^(INSERT|UPDATE|DELETE)/.test(c.sql)) {
        expect(c.sql).toContain('form_submissions');
      }
    }
  });

  test('server re-validation gate: bad values → 400, nothing recorded', async () => {
    fixture = { template: tplRow(), caseRow: null };
    const res = await POST('/api/ext/forms/intake_test/submit',
      { values: { reason: 'r', contact_pref: 'Fax' } });
    expect(res.status).toBe(400);
    expect(fixture._lastCalls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
  });
});

// ── 3. urlParam validator rules (formTemplateService §7, X2) ────────────────

describe('validateDefinition — urlParam (X2)', () => {
  const wrap = (fields, extra) => ({
    sections: [{ title: 'S', rows: [{ fields }] }, ...(extra || [])] });

  test('valid declarations accepted; empty means not-allowed', () => {
    expect(() => tplSvc.validateDefinition(wrap([
      { name: 'a', type: 'text', urlParam: 'src' },
      { name: 'b', type: 'hidden', urlParam: 'utm-tag_2' },
      { name: 'c', type: 'text', urlParam: '' },
    ]))).not.toThrow();
  });

  test('shape, reserved names, duplicates, repeaters, embeds all rejected', () => {
    const t = (def, part) => expect(() => tplSvc.validateDefinition(def)).toThrow(part);
    t(wrap([{ name: 'a', type: 'text', urlParam: 'has space' }]), /urlParam must match/);
    t(wrap([{ name: 'a', type: 'text', urlParam: 'x'.repeat(51) }]), /urlParam must match/);
    for (const reserved of ['case_id', 'ext', 'form_key', 'preview', 'template_id', 'link_id', 'contact_id', 'appt_id']) {
      t(wrap([{ name: 'a', type: 'text', urlParam: reserved }]), /is reserved/);
    }
    t(wrap([
      { name: 'a', type: 'text', urlParam: 'src' },
      { name: 'b', type: 'text', urlParam: 'src' },
    ]), /declared on more than one field/);
    t({ sections: [
      { title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] },
      { repeater: 'r', title: 'R', fields: [{ name: 'x', type: 'text', urlParam: 'p' }] },
    ] }, /not supported inside repeaters/);
    t(wrap([{ name: 'e', type: 'embed', src: 'https://x.test', urlParam: 'p' }]),
      /not allowed on type "embed"/);
  });
});