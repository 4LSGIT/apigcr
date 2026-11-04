'use strict';
/**
 * tests/caseySequenceEnrollEsign.test.js
 *
 * A18.4d — e-sign-scoped Casey enrollments: the typed read esign.requests and
 * trigger_data.signing_request_id on sequence.enroll.v1, plus the reminder
 * pointer POST /sequences/enroll now writes back (or the enrollment is
 * cancelled).
 *
 * The contract pinned here:
 *   1. esign.requests — validateStep takes exactly one of contact_id /
 *      case_id; the read's SQL selects an allow-list of columns (never
 *      recipients, provider_id, raw_payload, placement_json, the PDF paths or
 *      completion_targets) and its rows carry exactly the allow-listed keys,
 *      whatever the driver returns; finished requests are returned marked;
 *      a row's contact_id is the request's REMINDER contact, resolved with
 *      esignPrefillService.buildContext (the send's own resolution); any staff
 *      JWT runs it through the executor and its rows are citable evidence
 *      (the A11.1 posture).
 *   2. the normalizer — signing_request_id is evidence-bound to an
 *      esign.requests row (a sql.read row aliasing the id is not enough);
 *      positive integer; never beside appt_id; the request's reminder contact
 *      IS the enrollment contact (both named on a mismatch); a TERMINAL, draft
 *      or unknown-status request is refused; a pointer to an ACTIVE enrollment
 *      is refused naming it, a finished / missing one is disclosed and
 *      replaced; document_name / tracking_id / case_id must be the request's;
 *      the duplicate predicate carries the signing scope; signing_request_id
 *      is accepted whether or not a step reads it and stays out of the listed
 *      allowed set.
 *   3. the shipped paths are unchanged: no-payload and appointment-scoped
 *      cards carry no esign key and never read signing_requests.
 *   4. the route — an e-sign-scoped enroll is refused (409, claim given back)
 *      before any row when the request is missing / not awaiting signature /
 *      claimed; after the engine enrolls, ONE conditional UPDATE writes the
 *      pointer; a miss or a throw CANCELS the enrollment (500
 *      SIGNING_REQUEST_WRITEBACK_FAILED, claim kept), and a failing cancel
 *      pages IT. A body without signing_request_id issues no new query.
 * The real engine — the write-back, applyStatus cancelling the chat-born
 * enrollment, the injected write-back failure — runs in
 * tests/caseySequenceEnrollEsign.mysql.test.js.
 *
 *   npx jest tests/caseySequenceEnrollEsign.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 6, roles: ['staff'] }; next(); }));
jest.mock('../lib/alerting', () => ({ ...jest.requireActual('../lib/alerting'), alert: jest.fn(async () => {}) }));

const REPO = path.join(__dirname, '..');
const engine = require(path.join(REPO, 'lib', 'sequenceEngine'));
const alerting = require(path.join(REPO, 'lib', 'alerting'));
const esignService = require(path.join(REPO, 'services', 'esignService'));
const svc = require(path.join(REPO, 'services', 'assistantService'));
const { normalizeActionDraft, validateStep, stepFingerprint, esignRequestsRead } = svc;
const { SQL } = require(path.join(REPO, 'lib', 'requestIdempotency'));

const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ── Shared fixtures ─────────────────────────────────────────────────────────
// Contact 77 Dana is Primary on case CASE1; 78 Other is Primary on CASE2.
const CONTACTS = { 77: { contact_id: 77, contact_name: 'Dana Client', contact_ssn: '123-45-6789' }, 78: { contact_id: 78, contact_name: 'Other Person' } };
const CASE_PRIMARY = { CASE1: 77, CASE2: 78, EMPTY1: null };
const REQ = (over = {}) => ({ id: 44, status: 'viewed', kind: 'retainer_prepetition', document_name: 'Retainer – Client', tracking_id: 'YC-CASE1-retainer_prepetition-ab12',
  linkable_type: 'case', linkable_id: 'CASE1', seq_instance_id: null, sent_at: new Date('2026-11-02T15:00:00Z'), pointer_status: null, ...over });

// The esignPrefillService.buildContext reads, scripted.
function buildContextQuery(f, params) {
  if (f === 'SELECT * FROM contacts WHERE contact_id = ? LIMIT 1') {
    const c = CONTACTS[Number(params[0])];
    return [c ? [{ ...c }] : []];
  }
  if (f === 'SELECT * FROM cases WHERE case_id = ? LIMIT 1') {
    return [Object.prototype.hasOwnProperty.call(CASE_PRIMARY, params[0]) ? [{ case_id: params[0], case_trustee: null }] : []];
  }
  if (/^SELECT co\.\* FROM case_relate cr JOIN contacts co .*cr\.case_relate_type = 'Primary'/.test(f)) {
    const id = CASE_PRIMARY[params[0]];
    return [id ? [{ ...CONTACTS[id] }] : []];
  }
  if (/^SELECT co\.\* FROM case_relate cr JOIN contacts co .*cr\.case_relate_type = 'Secondary'/.test(f)) return [[]];
  return null;
}

// ── 1. The typed read ───────────────────────────────────────────────────────
describe('the typed read esign.requests', () => {
  test('validateStep takes exactly ONE of contact_id / case_id; the fingerprint is per target', () => {
    const step = (over) => validateStep({ id: 'q1', kind: 'esign.requests', purpose: 'p', ...over }, 0);
    expect(step({ contact_id: '77' })).toEqual({ id: 'q1', kind: 'esign.requests', purpose: 'p', contact_id: 77 });
    expect(step({ case_id: ' CASE1 ' })).toEqual({ id: 'q1', kind: 'esign.requests', purpose: 'p', case_id: 'CASE1' });
    expect(() => step({})).toThrow('Step q1 needs exactly one of contact_id or case_id');
    expect(() => step({ contact_id: 77, case_id: 'CASE1' })).toThrow('Step q1 needs exactly one of contact_id or case_id');
    for (const v of [0, -1, 'x', 1.5]) expect(() => step({ contact_id: v })).toThrow('Step q1 needs a positive contact_id');
    for (const v of ['', 'bad id!', 42, 'x'.repeat(21)]) expect(() => step({ case_id: v })).toThrow('Step q1 needs the case\'s exact case_id');
    expect(stepFingerprint({ kind: 'esign.requests', contact_id: 77 })).toBe('esign.requests:contact:77');
    expect(stepFingerprint({ kind: 'esign.requests', case_id: 'CASE1' })).toBe('esign.requests:case:CASE1');
  });

  // The driver returns every column of the table (as if someone widened the
  // SELECT): the row mapping is an allow-list, so nothing else rides out.
  const ALLOWED_ROW_KEYS = ['row_type', 'signing_request_id', 'status', 'awaiting_signature', 'terminal', 'document_name', 'kind', 'template_id',
    'template_name', 'tracking_id', 'linkable_type', 'case_id', 'contact_id', 'contact_name', 'sent_at', 'created_at', 'expires_at', 'completed_at',
    'seq_instance_id', 'reminder_status', 'reminder_template_id', 'enrollable'];
  const SECRET = 'https://sign.zoho.com/zsguest?action_type=SIGN&request_id=SECRET123';
  const full = (over) => ({ signing_request_id: 44, status: 'viewed', kind: 'retainer_prepetition', document_name: 'Retainer – Client', tracking_id: 'YC-1',
    template_id: 3, template_name: 'Retainer', linkable_type: 'case', linkable_id: 'CASE1', seq_instance_id: null, reminder_status: null, reminder_template_id: null,
    sent_at: new Date('2026-11-02T15:00:00Z'), created_at: new Date('2026-11-02T14:59:00Z'), expires_at: new Date('2026-11-16T15:00:00Z'), completed_at: null,
    // columns the SELECT never names — if they ever arrive, they must not leave
    raw_payload: { url: SECRET }, recipients: [{ email: 'dana@example.com', ip: '10.0.0.1' }], provider_id: 'zoho-998877', placement_json: {},
    signed_pdf_path: '/Clients/Dana/signed.pdf', cert_pdf_path: '/Clients/Dana/cert.pdf', completion_targets: { signed: { hook_id: 1 } }, ...over });
  function readDb(rows) {
    const seen = [];
    const query = jest.fn(async (sql, params = []) => {
      const f = flat(sql);
      seen.push([f, params]);
      if (/FROM signing_requests sr/.test(f)) return [rows.map((r) => ({ ...r }))];
      const ctx = buildContextQuery(f, params);
      if (ctx) return ctx;
      throw new Error(`unscripted query: ${f}`);
    });
    return { db: { query }, seen };
  }

  test('the SQL names an allow-list of columns — never a link, the signers, the provider handle, payloads or document paths', async () => {
    const { db, seen } = readDb([]);
    await esignRequestsRead(db, { contact_id: 77 });
    const [sql, params] = seen[0];
    for (const banned of ['raw_payload', 'recipients', 'provider_id', 'placement_json', 'signed_pdf_path', 'cert_pdf_path', 'completion_targets', 'sr.*', 'SELECT *']) {
      expect({ banned, present: sql.includes(banned) }).toEqual({ banned, present: false });
    }
    expect(sql).toMatch(/^SELECT sr\.id AS signing_request_id, sr\.status, sr\.kind, sr\.document_name, sr\.tracking_id, sr\.template_id, ct\.name AS template_name, /);
    // The contact read: contact-linked requests and requests of the contact's cases; linkable_id bound as a STRING.
    expect(sql).toContain("WHERE (sr.linkable_type = 'contact' AND sr.linkable_id = ?) OR (sr.linkable_type = 'case' AND sr.linkable_id IN (SELECT cr.case_relate_case_id FROM case_relate cr WHERE cr.case_relate_client_id = ?)) ORDER BY sr.id DESC LIMIT 21");
    expect(params).toEqual(['77', 77]);
    const byCase = readDb([]);
    await esignRequestsRead(byCase.db, { case_id: 'CASE1' });
    expect(byCase.seen[0][0]).toContain("WHERE sr.linkable_type = 'case' AND sr.linkable_id = ? ORDER BY sr.id DESC");
    expect(byCase.seen[0][1]).toEqual(['CASE1']);
  });

  test('rows carry exactly the allow-listed keys — the reminder contact from buildContext, finished requests marked, a claimed request not enrollable', async () => {
    const { db } = readDb([
      full({ signing_request_id: 46, status: 'signed', completed_at: new Date('2026-11-03T10:00:00Z'), seq_instance_id: 700, reminder_status: 'cancelled', reminder_template_id: 26 }),
      full({ signing_request_id: 45, status: 'sent', seq_instance_id: 701, reminder_status: 'active', reminder_template_id: 26 }),
      full({ signing_request_id: 44 }),
      full({ signing_request_id: 43, status: 'draft', linkable_type: 'contact', linkable_id: '77', template_id: null, template_name: null }),
      full({ signing_request_id: 42, status: 'bounced', linkable_type: 'case', linkable_id: 'EMPTY1' }),
    ]);
    const out = await esignRequestsRead(db, { contact_id: 77 });
    expect(out.truncated).toBe(false);
    const [head, ...rows] = out.rows;
    expect(head).toMatchObject({ row_type: 'summary', contact_id: 77, requests: 5, truncated: 0 });
    expect(head.note).toMatch(/^5 signing requests for contact 77, newest first\. A row's contact_id is the request's REMINDER contact/);
    for (const r of rows) expect(Object.keys(r)).toEqual(ALLOWED_ROW_KEYS);
    expect(JSON.stringify(out)).not.toMatch(/SECRET123|dana@example\.com|10\.0\.0\.1|zoho-998877|signed\.pdf|cert\.pdf|hook_id|123-45-6789/);
    expect(rows.map((r) => [r.signing_request_id, r.status, r.awaiting_signature, r.terminal, r.contact_id, r.seq_instance_id, r.reminder_status, r.enrollable])).toEqual([
      [46, 'signed', 0, 1, 77, 700, 'cancelled', 0],
      [45, 'sent', 1, 0, 77, 701, 'active', 0],
      [44, 'viewed', 1, 0, 77, null, null, 1],
      [43, 'draft', 0, 0, 77, null, null, 0],
      [42, 'bounced', 1, 0, null, null, null, 0], // no Primary client on the case → no reminder contact
    ]);
    expect(rows[2]).toMatchObject({ case_id: 'CASE1', contact_name: 'Dana Client', template_name: 'Retainer', sent_at: '2026-11-02T15:00:00.000Z', completed_at: null });
    expect(rows[3]).toMatchObject({ linkable_type: 'contact', case_id: null, contact_id: 77 });
  });

  test('the cap: 20 rows, truncated said in the head row; an empty read says so', async () => {
    const many = Array.from({ length: 21 }, (_, i) => full({ signing_request_id: 100 - i }));
    const out = await esignRequestsRead(readDb(many).db, { case_id: 'CASE1' });
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(21);
    expect(out.rows[0]).toMatchObject({ row_type: 'summary', case_id: 'CASE1', requests: 20, truncated: 1 });
    expect(out.rows[0].note).toMatch(/ONLY the newest 20; more exist/);
    const none = await esignRequestsRead(readDb([]).db, { contact_id: 77 });
    expect(none.rows).toHaveLength(1);
    expect(none.rows[0].note).toMatch(/^No signing request for contact 77\./);
  });

  test('any staff JWT runs it through the executor (the A11.1 posture) and its rows reach the answer as citable evidence', async () => {
    const aiService = require(path.join(REPO, 'services', 'aiService'));
    const assistantTicket = require(path.join(REPO, 'lib', 'assistantTicket'));
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'casey-esign-test-secret';
    const { db: read } = readDb([full({ signing_request_id: 44 })]);
    const db = { query: jest.fn(async (q, p) => {
      if (/FROM app_settings/.test(q)) return [[]];
      if (/FROM ai_calls/.test(q)) return [[{ c: 0 }]];
      return read.query(q, p);
    }) };
    const plan = svc.validatePlan({ action: 'query', summary: 'Signing requests', steps: [
      { id: 'q1', kind: 'esign.requests', purpose: 'Dana\'s signing requests', contact_id: 77 }] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Did Dana sign her retainer?', history: [], plan: { action: 'query', ...plan } });
    const answer = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 3,
      json: { answer: 'Not yet — it is viewed.', citations: [{ query_id: 'q1', row_number: 2, label: 'Retainer' }], suggestions: [] } });
    try {
      const out = await svc.execute(db, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(out.sources[0]).toMatchObject({ query_id: 'q1', row_number: 2, row: { row_type: 'signing_request', signing_request_id: '44', status: 'viewed', contact_id: '77', enrollable: '1' } });
      expect(JSON.stringify(out)).not.toContain('SECRET123');
    } finally {
      answer.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });
});

// ── 2/3. The normalizer ─────────────────────────────────────────────────────
// Template 12: published v3 — an sms that names the document, then a task.
// Nothing reads signing_request_id: the scope key rides anyway.
const TPL = { id: 12, name: 'Signature Nudges', type: null, active: 1, current_version: 3, draft_version: null };
const STEPS = [
  { id: 101, template_id: 12, version: 3, step_number: 1, action_type: 'sms',
    action_config: JSON.stringify({ function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Please sign {{trigger_data.document_name}}' } }),
    timing: JSON.stringify({ type: 'immediate' }), condition: null, fire_guard: null, error_policy: null },
  { id: 102, template_id: 12, version: 3, step_number: 2, action_type: 'task',
    action_config: JSON.stringify({ function_name: 'create_task', params: { title: 'Call about {{trigger_data.tracking_id}}', assigned_to: 7 } }),
    timing: JSON.stringify({ type: 'delay', value: 2, unit: 'days' }), condition: null, fire_guard: null, error_policy: null },
];
const APPT = { appt_id: 900, appt_client_id: 77, appt_case_id: 'CASE1', appt_type: '341 Meeting', appt_status: 'Scheduled', appt_with: 3, appt_local: '2030-03-04 14:00:00', user_name: 'Stuart' };

function makeDb(over = {}) {
  const state = { reads: [], existing: over.existing || [], request: over.request === undefined ? REQ() : over.request };
  const query = jest.fn(async (sql, params = []) => {
    const f = flat(sql);
    state.reads.push([f, params]);
    if (/^SELECT id, name, type, active, current_version, draft_version FROM sequence_templates WHERE id = \?$/.test(f)) return [[{ ...TPL }]];
    if (/^SELECT id, name, type, current_version, draft_version FROM sequence_templates WHERE id = \?$/.test(f)) return [[{ ...TPL }]];
    if (/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? ORDER BY step_number ASC$/.test(f)) return [STEPS.map((s) => ({ ...s }))];
    if (/^SELECT template_condition FROM sequence_template_versions/.test(f)) return [[]];
    if (/^SELECT contact_id, contact_name FROM contacts WHERE contact_id = \? LIMIT 1$/.test(f)) {
      const c = CONTACTS[Number(params[0])];
      return [c ? [{ contact_id: c.contact_id, contact_name: c.contact_name }] : []];
    }
    if (/^SELECT capture_mode FROM sequence_templates WHERE id = \?$/.test(f)) return [[{ capture_mode: 'off' }]];
    if (/^SELECT test_input, captured_input FROM sequence_templates WHERE id = \?$/.test(f)) return [[{ test_input: over.test_input || null, captured_input: null }]];
    if (/FROM appts a LEFT JOIN users u ON u.user = a.appt_with WHERE a.appt_id = \? LIMIT 1$/.test(f)) return [[{ ...APPT }]];
    if (/FROM cases c WHERE c.case_id = \? LIMIT 1$/.test(f)) {
      const owner = CASE_PRIMARY[params[1]];
      return [owner === undefined ? [] : [{ case_id: params[1], label: `L-${params[1]}`, case_caption: null, relate_type: owner === params[0] ? 'Primary' : null }]];
    }
    if (/^SELECT sr\.id, sr\.status, sr\.kind, sr\.document_name, sr\.tracking_id, sr\.linkable_type, sr\.linkable_id, sr\.seq_instance_id, sr\.sent_at, e\.status AS pointer_status FROM signing_requests sr LEFT JOIN sequence_enrollments e ON e\.id = sr\.seq_instance_id WHERE sr\.id = \? LIMIT 1$/.test(f)) {
      return [state.request && params[0] === state.request.id ? [{ ...state.request }] : []];
    }
    const ctx = buildContextQuery(f, params);
    if (ctx) return ctx;
    if (/FROM `contacts` WHERE `contacts`.`contact_id` = \? LIMIT 1$/.test(f)) {
      return [[{ contacts__contact_id: 77, contacts__contact_fname: 'Dana', contacts__contact_phone: '3135551234' }]];
    }
    if (/^SELECT id FROM sequence_enrollments WHERE contact_id = \? AND template_id = \? AND \(appt_id <=> \?\) AND \(signing_request_id <=> \?\) AND status = 'active' LIMIT 1$/.test(f)) {
      return [state.existing.filter(([, appt, sr]) => (appt ?? null) === (params[2] ?? null) && (sr ?? null) === (params[3] ?? null)).map(([id]) => ({ id }))];
    }
    if (/^SELECT COUNT\(\*\) AS n FROM sequence_enrollments WHERE template_id = \? AND status = 'active'$/.test(f)) return [[{ n: 2 }]];
    if (/^SELECT id, type FROM sequence_templates WHERE id = \?$/.test(f)) return [[{ id: 12, type: null }]];
    if (/FROM hook_targets ht JOIN hooks h|FROM trigger_rule_actions a JOIN trigger_rules tr|FROM workflow_steps s JOIN workflows w|FROM cta_links|FROM (?:email|phone)_ingest_rule_actions a JOIN/.test(f)) return [[]];
    throw new Error(`unscripted query: ${f}`);
  });
  return { state, db: { query } };
}

const ESIGN_ROWS = { id: 'q3', kind: 'esign.requests', purpose: 'requests', rows: [
  { row_type: 'summary', contact_id: '77', requests: '2' },
  { row_type: 'signing_request', signing_request_id: '44', status: 'viewed', contact_id: '77', case_id: 'CASE1', enrollable: '1' },
  { row_type: 'signing_request', signing_request_id: '45', status: 'sent', contact_id: '78', case_id: 'CASE2', enrollable: '1' }] };
const EVIDENCE = [
  { id: 'q1', kind: 'automation.definition', purpose: 'tpl', rows: [{ sequence_template_id: 12 }] },
  // Row 2 is a sql.read that aliases the id AND spoofs the typed row's shape: it still cites no signing request.
  { id: 'q2', kind: 'sql.read', purpose: 'contact', rows: [{ contact_id: 77, contact_name: 'Dana Client' }, { row_type: 'signing_request', signing_request_id: 44, appt_id: 900, case_id: 'CASE1' }] },
  ESIGN_ROWS,
];
const REFS = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }, { query_id: 'q3', row_number: 2 }, { query_id: 'q3', row_number: 3 }];
const draft = (trigger_data, over = {}) => ({ kind: 'sequence.enroll.v1', sequence_template_id: 12, contact_id: 77, evidence: REFS,
  ...(trigger_data === undefined ? {} : { trigger_data }), ...over });
const refuse = async (d, re, dbOver = {}) => {
  const { db, state } = makeDb(dbOver);
  await expect(normalizeActionDraft(db, d, EVIDENCE)).rejects.toThrow(re);
  return state;
};

beforeEach(() => { process.env.CASEY_SEQUENCE_ENROLL_ENABLED = '1'; jest.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => { delete process.env.CASEY_SEQUENCE_ENROLL_ENABLED; jest.restoreAllMocks(); alerting.alert.mockClear(); });

describe('A18.4d — the normalizer: an e-sign-scoped enrollment', () => {
  test('a cited, live, unclaimed request of THIS reminder contact: the card names it, the scope and the replaced pointer; the duplicate predicate carries the signing scope', async () => {
    const { db, state } = makeDb();
    const td = { signing_request_id: 44, document_name: 'Retainer – Client', tracking_id: 'YC-CASE1-retainer_prepetition-ab12' };
    const out = await normalizeActionDraft(db, draft(td), EVIDENCE);
    expect(out.payload).toEqual({ trigger_data: td });
    expect(out.trigger).toEqual({
      reads: [
        { key: 'signing_request_id', read_by: [{ step_number: null, via: 'esign_scope' }] },
        { key: 'document_name', read_by: [{ step_number: 1, via: 'placeholder' }] },
        { key: 'tracking_id', read_by: [{ step_number: 2, via: 'placeholder' }] },
      ],
      scope: 'esign', appointment: null, case: null,
      esign: { signing_request_id: 44, document_name: 'Retainer – Client', kind: 'retainer_prepetition', status: 'viewed',
        sent_text: expect.stringMatching(/firm time$/), case_id: 'CASE1', pointer_base: null, prior_enrollment: null },
    });
    expect(out.steps[0]).toMatchObject({ placement: 'places', message: 'Please sign Retainer – Client' });
    const dup = state.reads.find(([sql]) => /FROM sequence_enrollments WHERE contact_id/.test(sql));
    expect(dup[1]).toEqual([77, 12, null, 44]);
    expect(Object.keys(out)).toContain('payload');
  });

  test('the identity is scoped: contact- and appointment-scoped rows never block it; this request\'s row does, named', async () => {
    await expect(normalizeActionDraft(makeDb({ existing: [[801, null, null], [802, 900, null], [803, null, 45]] }).db, draft({ signing_request_id: 44 }), EVIDENCE))
      .resolves.toMatchObject({ trigger: { scope: 'esign' } });
    await refuse(draft({ signing_request_id: 44 }), /^Dana Client \(contact 77\) is already enrolled in "Signature Nudges" for signing request #44 — active enrollment #804; nothing is proposed/,
      { existing: [[804, null, 44]] });
    // … and an e-sign-scoped row never blocks the contact-scoped card.
    await expect(normalizeActionDraft(makeDb({ existing: [[804, null, 44]] }).db, draft(undefined), EVIDENCE)).resolves.toMatchObject({ kind: 'sequence.enroll.v1' });
  });

  test('evidence: only an esign.requests row carrying the exact id — a sql.read row aliasing it is not enough', async () => {
    const onlySql = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }, { query_id: 'q2', row_number: 2 }];
    const st = await refuse(draft({ signing_request_id: 44 }, { evidence: onlySql }),
      /^Sequence enroll trigger_data\.signing_request_id 44 is not in the evidence — cite the esign\.requests row carrying that exact signing_request_id/);
    expect(st.reads).toEqual([]);
    await refuse(draft({ signing_request_id: 46 }), /signing_request_id 46 is not in the evidence/);
    // The summary row of the read is not a request row.
    const head = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }, { query_id: 'q3', row_number: 1 }];
    await refuse(draft({ signing_request_id: 77 }, { evidence: head }), /signing_request_id 77 is not in the evidence/);
  });

  test('shape: a positive integer, never beside an appointment — before anything is read', async () => {
    for (const v of ['44', 0, -4, 4.5, null, true]) {
      const st = await refuse(draft({ signing_request_id: v }), /^Sequence enroll trigger_data\.signing_request_id must be a positive signing request id \(a number\)/);
      expect(st.reads).toEqual([]);
    }
    const st = await refuse(draft({ signing_request_id: 44, appt_id: 900 }),
      /^Sequence enroll trigger_data carries both appt_id and signing_request_id — an enrollment is appointment-scoped OR e-sign-scoped, never both/);
    expect(st.reads).toEqual([]);
    // A null appt_id is no scope (the engine's truthiness rule) — not "both".
    await expect(normalizeActionDraft(makeDb().db, draft({ signing_request_id: 44, appt_id: null }, { }), EVIDENCE)).rejects.toThrow(/key "appt_id" is not read/);
  });

  test('the reminder contact must be the enrollment contact — both named; a request with no reminder contact is refused', async () => {
    await refuse(draft({ signing_request_id: 44 }),
      /^Signing request #44 \("Retainer – Client"\)'s reminder contact is Other Person \(contact 78\) — debtor 1 of case CASE2, the contact the send enrolls — not Dana Client \(contact 77\)/,
      { request: REQ({ linkable_id: 'CASE2' }) });
    await refuse(draft({ signing_request_id: 44 }), /'s reminder contact is Other Person \(contact 78\) — the contact it was sent for/,
      { request: REQ({ linkable_type: 'contact', linkable_id: '78' }) });
    await refuse(draft({ signing_request_id: 44 }), /has no reminder contact — its case EMPTY1 has no Primary client \(debtor 1\)/,
      { request: REQ({ linkable_id: 'EMPTY1' }) });
    // A contact-linked request of this contact binds.
    await expect(normalizeActionDraft(makeDb({ request: REQ({ linkable_type: 'contact', linkable_id: '77' }) }).db, draft({ signing_request_id: 44 }), EVIDENCE))
      .resolves.toMatchObject({ trigger: { esign: { case_id: null } } });
  });

  test('every TERMINAL status, a draft and an unknown status refuse; every outstanding status passes', async () => {
    for (const status of esignService.TERMINAL) {
      await refuse(draft({ signing_request_id: 44 }), new RegExp(`^Signing request #44 \\("Retainer – Client"\\) is ${status} — finished\\. Its reminders would remind on a finished document, and nothing would ever cancel them`),
        { request: REQ({ status }) });
    }
    await refuse(draft({ signing_request_id: 44 }), /is draft, not awaiting signature — it has not been sent; the send enrolls its own reminders when it goes out/, { request: REQ({ status: 'draft' }) });
    await refuse(draft({ signing_request_id: 44 }), /is weird, not awaiting signature — only a sent request is reminded/, { request: REQ({ status: 'weird' }) });
    await refuse(draft({ signing_request_id: 44 }), /^Signing request 44 is unavailable/, { request: null });
    for (const status of esignService.OUTSTANDING_STATUSES) {
      await expect(normalizeActionDraft(makeDb({ request: REQ({ status }) }).db, draft({ signing_request_id: 44 }), EVIDENCE))
        .resolves.toMatchObject({ trigger: { esign: { status } } });
    }
  });

  test('a pointer to an ACTIVE enrollment refuses, named; a finished or missing one is disclosed and becomes the reviewed base', async () => {
    await refuse(draft({ signing_request_id: 44 }), /^Signing request #44 \("Retainer – Client"\) already has an active reminder enrollment, #700 — one live reminder chain per request/,
      { request: REQ({ seq_instance_id: 700, pointer_status: 'active' }) });
    for (const [pointer_status, shown] of [['cancelled', 'cancelled'], ['completed', 'completed'], [null, 'missing']]) {
      const out = await normalizeActionDraft(makeDb({ request: REQ({ seq_instance_id: 700, pointer_status }) }).db, draft({ signing_request_id: 44 }), EVIDENCE);
      expect(out.trigger.esign).toMatchObject({ pointer_base: 700, prior_enrollment: { enrollment_id: 700, status: shown } });
    }
  });

  test('document_name, tracking_id and case_id must be the request\'s own', async () => {
    await refuse(draft({ signing_request_id: 44, document_name: 'Other doc' }), /trigger_data\.document_name "Other doc" is not signing request #44's document name — send "Retainer – Client"/);
    await refuse(draft({ signing_request_id: 44, tracking_id: 'YC-X' }), /trigger_data\.tracking_id "YC-X" is not signing request #44's tracking id — send "YC-CASE1-retainer_prepetition-ab12"/);
    await refuse(draft({ signing_request_id: 44, case_id: 'CASE2' }), /^Case CASE2 is not linked to Dana Client/, { test_input: { case_id: 'x' } });
    // CASE2 linked to Dana for this check only: the request's own case wins.
    const { db } = makeDb({ test_input: { case_id: 'x' } });
    const linked = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, p) => (/FROM cases c WHERE c.case_id = \? LIMIT 1$/.test(flat(sql))
      ? [[{ case_id: p[1], label: p[1], case_caption: null, relate_type: 'Primary' }]] : linked(sql, p)));
    await expect(normalizeActionDraft(db, draft({ signing_request_id: 44, case_id: 'CASE2' }), EVIDENCE))
      .rejects.toThrow(/trigger_data\.case_id "CASE2" is not signing request #44's case \("CASE1"\) — send the request's own case/);
    await expect(normalizeActionDraft(makeDb({ test_input: { case_id: 'x' } }).db, draft({ signing_request_id: 44, case_id: 'CASE1' }), EVIDENCE))
      .resolves.toMatchObject({ trigger: { case: { case_id: 'CASE1' }, esign: { case_id: 'CASE1' } } });
  });

  test('signing_request_id stays out of the listed allowed set (an unknown key\'s refusal reads as it did)', async () => {
    await refuse(draft({ signing_request_id: 44, zzz: 1 }), /key "zzz" is not read by template 12's published version — allowed: document_name, tracking_id \(/);
  });
});

describe('A18.4d — the shipped paths do not move', () => {
  const SHIPPED = ['draft_id', 'kind', 'status', 'template', 'contact', 'verdict', 'first_step', 'skipped_leading', 'stall_step',
    'placeholder_at_steps', 'send_steps', 'steps', 'steps_truncated', 'effects', 'starters', 'active_enrollments', 'expected', 'evidence'];
  test('the no-payload card: the shipped envelope, the dup predicate with both scopes NULL, no signing_requests read', async () => {
    for (const td of [undefined, {}]) {
      const { db, state } = makeDb();
      const card = await normalizeActionDraft(db, draft(td), EVIDENCE);
      expect(Object.keys(card)).toEqual(SHIPPED);
      expect(state.reads.find(([sql]) => /FROM sequence_enrollments WHERE contact_id/.test(sql))[1]).toEqual([77, 12, null, null]);
      expect(state.reads.some(([sql]) => /signing_requests|case_relate cr JOIN contacts/.test(sql))).toBe(false);
    }
  });
  test('the appointment card: its trigger block has no esign key and signing_requests is never read', async () => {
    const steps = STEPS.map((s) => ({ ...s }));
    const { db, state } = makeDb({ test_input: { appt_id: 1 } });
    void steps;
    const card = await normalizeActionDraft(db, draft({ appt_id: 900 }, { evidence: [...REFS, { query_id: 'q2', row_number: 2 }] }), EVIDENCE);
    expect(Object.keys(card.trigger)).toEqual(['reads', 'scope', 'appointment', 'case']);
    expect(card.trigger).toMatchObject({ scope: 'appointment', reads: [{ key: 'appt_id', read_by: [] }] });
    expect(state.reads.find(([sql]) => /FROM sequence_enrollments WHERE contact_id/.test(sql))[1]).toEqual([77, 12, 900, null]);
    expect(state.reads.some(([sql]) => /signing_requests/.test(sql))).toBe(false);
  });
});

// ── The browser builder over a real card ────────────────────────────────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  let parens = 0, body = match.index + match[0].length - 1;
  for (; body < src.length; body++) {
    if (src[body] === '(') parens++;
    else if (src[body] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
// eslint-disable-next-line no-new-func
const buildRequest = new Function(`${fnSrc(html, 'sequenceEnrollTriggerBody')}; ${fnSrc(html, 'sequenceEnrollRequest')}; return sequenceEnrollRequest;`)();

describe('A18.4d — the browser sends the reviewed e-sign payload exactly', () => {
  test('the server card → the POST body; the card\'s live set is the module\'s OUTSTANDING_STATUSES', async () => {
    const td = { signing_request_id: 44, document_name: 'Retainer – Client' };
    const card = await normalizeActionDraft(makeDb().db, draft(td), EVIDENCE);
    expect(buildRequest(card)).toEqual({ path: '/sequences/enroll', method: 'POST', body: { contact_id: 77, template_id: 12, trigger_data: td }, idempotent: true });
    expect(() => buildRequest({ ...card, trigger: { ...card.trigger, scope: 'contact' } })).toThrow(/unusable trigger data/);
    expect(() => buildRequest({ ...card, trigger: { ...card.trigger, esign: { ...card.trigger.esign, signing_request_id: 45 } } })).toThrow(/unusable trigger data/);
    // The precheck's hard-coded live set mirrors esignService.
    const pre = fnSrc(html, 'sequenceEnrollPrecheck');
    expect(pre).toContain(`[${esignService.OUTSTANDING_STATUSES.map((s) => `'${s}'`).join(', ')}].includes(req.status)`);
  });
});

// ── 4. The route: the reminder pointer ──────────────────────────────────────
describe('A18.4d — POST /sequences/enroll writes the reminder pointer, or cancels', () => {
  const OK = { enrollmentId: 901, templateName: 'Signature Nudges', totalSteps: 2, firstJobScheduledAt: '2026-11-04T15:00:00.000Z' };
  function routeDb({ request = { id: 44, status: 'viewed', seq_instance_id: null, pointer_status: null }, update = () => [{ affectedRows: 1 }], cancel = null } = {}) {
    const state = { claims: [], sql: [], nextClaim: 1 };
    const db = {
      getConnection: async () => { throw new Error('no connections'); },
      async query(sql, p = []) {
        const f = flat(sql);
        state.sql.push([f, p]);
        if (/^SELECT id FROM sequence_templates WHERE id = \?$/.test(f)) return [[{ id: p[0] }]];
        if (/^SELECT sr\.id, sr\.status, sr\.seq_instance_id, e\.status AS pointer_status FROM signing_requests sr LEFT JOIN sequence_enrollments e ON e\.id = sr\.seq_instance_id WHERE sr\.id = \? LIMIT 1$/.test(f)) {
          return [request ? [{ ...request }] : []];
        }
        if (/^UPDATE signing_requests SET seq_instance_id = \?/.test(f)) return update(p);
        if (/^UPDATE sequence_enrollments SET status = 'cancelled'/.test(f)) { if (cancel) return cancel(p); return [{ affectedRows: 1 }]; }
        if (/^UPDATE scheduled_jobs SET status = 'cancelled'/.test(f)) return [{ affectedRows: 1 }];
        if (sql === SQL.claim) {
          const row = { id: state.nextClaim++, user_id: p[0], scope: p[1], idem_key: p[2], status: 'in_flight' };
          state.claims.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (sql === SQL.settle) { const row = state.claims.find((r) => r.id === p[1]); row.status = 'applied'; return [{ affectedRows: 1 }]; }
        if (sql === SQL.release) { const i = state.claims.findIndex((r) => r.id === p[0]); if (i >= 0) state.claims.splice(i, 1); return [{ affectedRows: 1 }]; }
        throw new Error(`unscripted pool query: ${f}`);
      },
    };
    return { state, db };
  }
  function send(db, body, headers = {}) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(require('../routes/sequences.js'));
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const server = a.listen(0, () => {
        const req = http.request({ port: server.address().port, path: '/sequences/enroll', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(data); req.end();
      });
    });
  }
  const KEY = '3f1e2a9f-3b4d-4c5e-8f6a-0b1c2d3e4f5b';
  const BODY = { contact_id: 77, template_id: 12, trigger_data: { signing_request_id: 44 } };
  let byId; let byType;
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    byId = jest.spyOn(engine, 'enrollContactByTemplateId').mockResolvedValue({ ...OK });
    byType = jest.spyOn(engine, 'enrollContact').mockResolvedValue({ ...OK });
  });

  test('a live, unclaimed request: the engine enrolls, then ONE conditional UPDATE records the pointer over the base it read', async () => {
    const { db, state } = routeDb();
    const r = await send(db, BODY, { 'Idempotency-Key': KEY });
    expect(r).toEqual({ status: 201, body: { success: true, ...OK } });
    const upd = state.sql.filter(([f]) => /^UPDATE signing_requests/.test(f));
    expect(upd).toEqual([[`UPDATE signing_requests SET seq_instance_id = ? WHERE id = ? AND seq_instance_id <=> ? AND status IN (?, ?, ?, ?)`,
      [901, 44, null, ...esignService.OUTSTANDING_STATUSES]]]);
    // A finished earlier pointer is the base the UPDATE asserts.
    const stale = routeDb({ request: { id: 44, status: 'sent', seq_instance_id: 700, pointer_status: 'cancelled' } });
    await send(stale.db, BODY);
    expect(stale.state.sql.find(([f]) => /^UPDATE signing_requests/.test(f))[1].slice(0, 3)).toEqual([901, 44, 700]);
    // The cascade mode is tied the same way.
    const cascade = routeDb();
    await send(cascade.db, { contact_id: 77, template_type: 'esign_reminder', trigger_data: { signing_request_id: 44 } });
    expect(byType).toHaveBeenCalledTimes(1);
    expect(cascade.state.sql.filter(([f]) => /^UPDATE signing_requests/.test(f))).toHaveLength(1);
  });

  test('missing, not awaiting signature, or claimed: 409 before the engine runs, and the claim is given back', async () => {
    for (const [request, code, extra] of [
      [null, 'SIGNING_REQUEST_NOT_FOUND', {}],
      [{ id: 44, status: 'signed', seq_instance_id: null, pointer_status: null }, 'SIGNING_REQUEST_NOT_LIVE', { status: 'signed' }],
      [{ id: 44, status: 'draft', seq_instance_id: null, pointer_status: null }, 'SIGNING_REQUEST_NOT_LIVE', { status: 'draft' }],
      [{ id: 44, status: 'viewed', seq_instance_id: 700, pointer_status: 'active' }, 'SIGNING_REQUEST_CLAIMED', { enrollment_id: 700 }],
    ]) {
      const { db, state } = routeDb({ request });
      const r = await send(db, BODY, { 'Idempotency-Key': KEY });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'Failed to enroll contact', code, signing_request_id: 44, ...extra });
      expect(state.claims).toEqual([]);
    }
    expect(byId).not.toHaveBeenCalled();
    const bad = routeDb();
    const r = await send(bad.db, { ...BODY, trigger_data: { signing_request_id: 'x44' } });
    expect(r).toMatchObject({ status: 400, body: { code: 'SIGNING_REQUEST_INVALID' } });
  });

  test('a write-back that matches no row, or throws, CANCELS the enrollment: 500 SIGNING_REQUEST_WRITEBACK_FAILED naming it, the claim kept', async () => {
    for (const update of [() => [{ affectedRows: 0 }], () => { throw new Error('Lock wait timeout exceeded'); }]) {
      const { db, state } = routeDb({ update });
      const r = await send(db, BODY, { 'Idempotency-Key': KEY });
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ code: 'SIGNING_REQUEST_WRITEBACK_FAILED', enrollment_id: 901, signing_request_id: 44, cancelled: true });
      expect(r.body.message).toMatch(/^Enrollment #901 could not be tied to signing request 44 — .*; the enrollment was cancelled, so no further step runs$/);
      const cancels = state.sql.filter(([f]) => /^UPDATE sequence_enrollments SET status = 'cancelled'/.test(f));
      expect(cancels).toHaveLength(1);
      expect(cancels[0][1][1]).toBe(901);
      expect(cancels[0][1][0]).toMatch(/^esign pointer not written: /);
      expect(state.sql.some(([f]) => /^UPDATE scheduled_jobs SET status = 'cancelled'/.test(f))).toBe(true);
      expect(state.claims.map((c) => c.status)).toEqual(['in_flight']);
    }
    expect(alerting.alert).not.toHaveBeenCalled();
  });

  test('a cancel that also fails pages IT and says so (cancelled: false)', async () => {
    const { db } = routeDb({ update: () => [{ affectedRows: 0 }], cancel: () => { throw new Error('connection lost'); } });
    const r = await send(db, BODY);
    expect(r.body).toMatchObject({ code: 'SIGNING_REQUEST_WRITEBACK_FAILED', enrollment_id: 901, cancelled: false });
    expect(r.body.message).toMatch(/cancelling it ALSO failed and IT was alerted; cancel it by hand$/);
    expect(alerting.alert).toHaveBeenCalledTimes(1);
    expect(alerting.alert.mock.calls[0][1]).toMatchObject({ kind: 'esign_pointer_orphan', severity: 'error', ref_id: 901 });
  });

  test('a body with no signing request issues no new query (the shipped route)', async () => {
    for (const trigger_data of [{}, { case_id: 'ABC' }, { signing_request_id: 0 }, { signing_request_id: null }, 'x']) {
      const { db, state } = routeDb();
      const r = await send(db, { contact_id: 77, template_id: 12, trigger_data });
      expect(r.status).toBe(201);
      expect(state.sql.map(([f]) => f)).toEqual(['SELECT id FROM sequence_templates WHERE id = ?']);
    }
  });
});
