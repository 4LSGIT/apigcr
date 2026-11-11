'use strict';
/**
 * tests/caseyForms.test.js
 *
 * A12 — Casey saves ONE form draft (form.draft.v1 → POST /api/forms/draft) or
 * links ONE unlinked submission to a case or contact
 * (form.submission.link.v1 → PATCH /api/forms/submissions/:id/link), and
 * reads a form template first through the typed form.template read.
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builders, the click-time re-reads, the outcome mapping — is in
 * tests/assistantUi.test.js):
 *   1. the casey_forms_enabled switch ('0' = dark; unset = on);
 *   2. refused BY NAME before anything is read: the route-owned columns
 *      (status, version, submitted_by, schema_version), any other form
 *      operation (submit, pdf, publish, delete, visibility …), anything else;
 *   3. the form.template read: not found, unpublished (no field list),
 *      published (the field list, never the raw definition; display-only
 *      items left out), search, truncation;
 *   4. the draft: the template read in the same investigation, a published
 *      template of the record's link type, every answer checked against its
 *      field (unknown keys, every type, options, masks, widths, repeaters),
 *      the 64 KB bound, the no-op;
 *   5. THE CARRY-FORWARD: every existing answer the card does not set is sent
 *      again verbatim (the route replaces the whole payload), counted; the
 *      `expected` hash is key-order-insensitive;
 *   6. the disclosures: someone else's draft in the last 24 h (danger), the
 *      fields a Restore blanks (danger), client visibility by the serving
 *      code's own rule, required answers left empty, the submitted row
 *      untouched, the form version restamp, no trigger event;
 *   7. the link: a submitted, unlinked row whose template's link type is the
 *      target's; the identity rule (name / phone / email vs the people on the
 *      target — a mismatch is a danger warning, never a refusal); the version
 *      renumbering, the log entry, the intake gate, the pipeline steps;
 *   8. the ledger receipt and the request detector.
 *
 * The route behaviour the carry-forward and the link refusals rest on (the
 * ON DUPLICATE KEY wholesale replace, the draft_key uniqueness, the link
 * route's 400 / 404 / 409s, the version renumbering, the log entry) — and this
 * family's own SQL — run on a real engine in tests/caseyForms.mysql.test.js.
 *
 *   npx jest tests/caseyForms.test.js
 */

const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const formService = require(path.join(REPO, 'services', 'formService'));
const { normalizeActionDraft, taskDraftRequested, validateStep, stepFingerprint, formTemplateRead } = svc;

const CASE_ID = '7KQ2M9XA';
const DEF = {
  dataMode: 'snapshot',
  onSubmit: { patch: { url: '/api/cases/{linkId}', method: 'PATCH' } },
  sections: [
    { rows: [{ fields: [
      { name: 'trustee_name', label: 'Trustee', type: 'text', required: true },
      { name: 'meeting_date', label: 'Meeting date', type: 'date' },
      { name: 'meeting_at', label: 'Meeting time', type: 'datetime' },
      { name: 'attended', label: 'Attended', type: 'checkbox' },
      { name: 'outcome', label: 'Outcome', type: 'select', options: ['Concluded', 'Continued', { value: 'adj', label: 'Adjourned' }] },
      { name: 'mode', label: 'Mode', type: 'radio', options: ['Zoom', 'Phone'] },
      { name: 'docs', label: 'Docs', type: 'checkgroup', options: ['W-2', 'Paystub'], allowOther: true },
      { name: 'docs_strict', label: 'Docs strict', type: 'checkgroup', options: ['W-2', 'Paystub'] },
      { name: 'flags', label: 'Flags', type: 'tags' },
      { name: 'income', label: 'Income', type: 'number', min: 0, max: 100000 },
      { name: 'phone', label: 'Phone', type: 'text', mask: 'phone' },
      { name: 'notes', label: 'Notes', type: 'textarea', maxLength: 50 },
      { name: 'banner', type: 'content', text: 'Welcome' },
      { name: 'trustee_pick', label: 'Trustee pick', type: 'select', options: ['A'], optionsFrom: { source: 'firmData.trustees', value: 'id' } },
    ] }] },
    { repeater: 'creditors', fields: [{ name: 'creditor', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'secured', type: 'checkbox' }] },
  ],
};
const TPL = { id: 3, form_key: '341_notes', title: '341 Notes', link_type: 'case', schema_version: 4, visibility: 'internal', published_at: new Date('2026-10-01T00:00:00Z'), definition: JSON.stringify(DEF) };
const TEMPLATE_READ = { id: 'q1', kind: 'form.template', purpose: 'form', rows: [{ row_type: 'template', form_key: '341_notes', published: 1 }] };
const EVIDENCE = [TEMPLATE_READ, { id: 'q2', kind: 'sql.read', purpose: 'case', rows: [{ case_id: CASE_ID }, { case_id: 'OTHER123' }, { contact_id: 1309 }] },
  { id: 'q3', kind: 'sql.read', purpose: 'submission', rows: [{ submission_id: '4521' }, { submission_id: 9 }] }];

const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

let spies = [];
let calls;
function setup({ tpl = TPL, tplMissing = false, record = true, draft = null, submitted = null, sub = null, subMissing = false,
  people, phones = [], emails = [], maxVersion = 0, intake = '', reqs = [] } = {}) {
  calls = { latest: [], getSubmission: 0, sql: [] };
  spies = [
    jest.spyOn(formService, 'getLatest').mockImplementation(async (_db, k, t, id) => { calls.latest.push([k, t, id]); return { draft, submitted }; }),
    jest.spyOn(formService, 'getSubmission').mockImplementation(async (_db, id) => {
      calls.getSubmission += 1;
      if (subMissing || !sub) throw Object.assign(new Error(`Submission ${id} not found`), { status: 404 });
      return { ...sub };
    }),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.sql.push(flat);
    if (flat.startsWith('SELECT id, form_key, title, link_type, schema_version, visibility, published_at, definition FROM form_templates WHERE form_key = ?')) {
      return [tplMissing ? [] : [{ ...tpl }]];
    }
    if (flat.startsWith('SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ?')) {
      return [record && params[0] === CASE_ID ? [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: null, case_type: 'Bankruptcy' }] : []];
    }
    if (flat.startsWith('SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?')) {
      return [record && params[0] === 1309 ? [{ contact_id: 1309, contact_name: 'Dana Debtor' }] : []];
    }
    if (flat.startsWith('SELECT case_relate_client_id AS contact_id')) {
      return [(people || [{ contact_id: 1309, relate_type: 'Primary' }]).map((p) => ({ contact_id: p.contact_id, relate_type: p.relate_type }))];
    }
    if (flat.startsWith('SELECT contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email FROM contacts WHERE contact_id IN (?)')) {
      const all = people || [{ contact_id: 1309, contact_name: 'Dana Q. Debtor', contact_fname: 'Dana', contact_lname: 'Debtor', contact_phone: '3135551212', contact_email: 'dana@example.com' }];
      return [all.filter((p) => params[0].includes(p.contact_id) && p.contact_name !== undefined)];
    }
    if (flat === 'SELECT contact_id, phone FROM contact_phones WHERE contact_id IN (?)') return [phones];
    if (flat === 'SELECT contact_id, email FROM contact_emails WHERE contact_id IN (?)') return [emails];
    if (flat.startsWith('SELECT COALESCE(MAX(version), 0) AS max_version FROM form_submissions')) return [[{ max_version: maxVersion }]];
    if (flat === 'SELECT case_intake_form FROM cases WHERE case_id = ? LIMIT 1') return [[{ case_intake_form: intake }]];
    if (flat.startsWith('SELECT internal_label FROM pipeline_stage_requirements')) return [reqs.map((l) => ({ internal_label: l }))];
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_FORMS_ENABLED; });

const draftCard = (over = {}) => ({ kind: 'form.draft.v1', form_key: '341_notes', link_type: 'case', link_id: CASE_ID,
  data: { trustee_name: 'Jane Trustee' }, evidence: [{ query_id: 'q2', row_number: 1 }], ...over });
const linkCard = (over = {}) => ({ kind: 'form.submission.link.v1', submission_id: 4521, link_type: 'case', link_id: CASE_ID,
  evidence: [{ query_id: 'q3', row_number: 1 }, { query_id: 'q2', row_number: 1 }], ...over });
const SUB = { id: 4521, form_key: '341_notes', link_type: '', link_id: '', status: 'submitted', version: 17, schema_version: 4,
  data: { name: 'Dana Debtor', phone: '(313) 555-1212', email: 'Dana@Example.com', income: '1200' }, submitted_by: null, user_name: null,
  created_at: new Date('2026-10-30T15:04:00Z'), updated_at: new Date('2026-10-30T15:04:00Z') };
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: 6 });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);
const answer = (key, v, opts) => run(draftCard({ data: { [key]: v } }), opts);

describe('the per-family switch', () => {
  test("'0' makes both kinds unavailable; unset is ON", async () => {
    process.env.CASEY_FORMS_ENABLED = '0';
    await expect(run(draftCard())).rejects.toThrow(/^Action kind is unavailable$/);
    await expect(run(linkCard(), { sub: SUB })).rejects.toThrow(/^Action kind is unavailable$/);
    expect(calls.sql).toEqual([]);
    delete process.env.CASEY_FORMS_ENABLED;
    await expect(run(draftCard())).resolves.toMatchObject({ kind: 'form.draft.v1', status: 'draft' });
  });
});

describe('refused by name before anything is read', () => {
  test.each([['status'], ['version'], ['submitted_by'], ['schema_version']])('the route-owned column %s (draft and link)', async (k) => {
    await refuse(draftCard({ [k]: 1 }), new RegExp(`^RESERVED FIELDS refused \\(${k}\\): a draft card sends form_key, link_type, link_id and data`));
    await refuse(linkCard({ [k]: 1 }), new RegExp(`^RESERVED FIELDS refused \\(${k}\\): a link card sends link_type and link_id`));
    expect([calls.sql, calls.latest, calls.getSubmission]).toEqual([[], [], 0]);
  });
  test.each([['submit'], ['make_pdf'], ['publish'], ['delete_draft'], ['visibility'], ['restore_version'], ['unlink'], ['template_id']])('another form operation (%s)', async (k) => {
    await refuse(draftCard({ [k]: true }), new RegExp(`^OTHER FORM OPERATIONS refused \\(${k}\\): each form card does ONE thing — save ONE draft \\(form\\.draft\\.v1\\), link ONE submission`));
    expect(calls.sql).toEqual([]);
  });
  test('any other unknown key', async () => {
    await refuse(draftCard({ foo: 1 }), 'A form draft card carries unsupported fields: foo — it takes form_key, link_type, link_id, data and evidence only');
    await refuse(linkCard({ foo: 1 }), 'A form link card carries unsupported fields: foo — it takes submission_id, link_type, link_id and evidence only');
    expect(calls.sql).toEqual([]);
  });
});

describe('the form.template read', () => {
  test('the step validates its key and search and fingerprints by both', () => {
    expect(validateStep({ id: 'q1', kind: 'form.template', purpose: 'p', form_key: '341_notes', search: ' Trustee ' }, 0))
      .toEqual({ id: 'q1', kind: 'form.template', purpose: 'p', form_key: '341_notes', search: 'Trustee' });
    expect(() => validateStep({ id: 'q1', kind: 'form.template', purpose: 'p', form_key: 'bad key' }, 0)).toThrow('Step q1 needs a form_key');
    expect(() => validateStep({ id: 'q1', kind: 'form.template', purpose: 'p', form_key: 'k', search: 'x'.repeat(81) }, 0)).toThrow('Step q1 form.template search is over 80 characters');
    expect(stepFingerprint({ kind: 'form.template', form_key: 'DBKQ', search: 'Job' })).toBe('form.template:dbkq:job');
    expect(stepFingerprint({ kind: 'form.template', form_key: 'dbkq' })).toBe('form.template:dbkq:');
  });
  test('not found, and an unpublished template (its head only — no field list)', async () => {
    let db = setup({ tplMissing: true });
    expect(await formTemplateRead(db, 'nope')).toEqual({ rows: [{ row_type: 'not_found', form_key: 'nope', note: 'No form template has form_key "nope" — Casey drafts only a form that has a template' }], truncated: false });
    db = setup({ tpl: { ...TPL, form_key: 'issn', definition: null, published_at: null } });
    const out = await formTemplateRead(db, 'issn');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ row_type: 'template', form_key: 'issn', published: 0, published_at: null });
    expect(out.rows[0].note).toMatch(/^UNPUBLISHED — it has no published definition, so it has no field list/);
  });
  test('published: the field list (key, label, type, required, options as JSON), repeaters, no display-only item, never the raw definition', async () => {
    const out = await formTemplateRead(setup(), '341_notes');
    const [head, ...rows] = out.rows;
    expect(head).toMatchObject({ row_type: 'template', title: '341 Notes', link_type: 'case', visibility: 'internal', schema_version: 4, published: 1,
      data_mode: 'snapshot', server_drafts: 0, field_count: 13, repeater_count: 1, published_at: '2026-10-01T00:00:00.000Z' });
    expect(JSON.stringify(out)).not.toContain('firmData.trustees');
    expect(rows.find((r) => r.key === 'banner')).toBeUndefined();
    expect(rows.find((r) => r.key === 'outcome')).toEqual({ row_type: 'field', form_key: '341_notes', key: 'outcome', label: 'Outcome', type: 'select', required: 0, required_when: '', options: '["Concluded","Continued","adj"]' });
    expect(rows.find((r) => r.key === 'trustee_name')).toMatchObject({ required: 1, options: '' });
    expect(rows.find((r) => r.key === 'income')).toMatchObject({ min: 0, max: 100000 });
    expect(rows.find((r) => r.key === 'trustee_pick').options_note).toMatch(/filled when the form opens/);
    expect(rows.filter((r) => r.repeater === 'creditors').map((r) => r.key)).toEqual(['creditor', 'amount', 'secured']);
    expect(rows.find((r) => r.row_type === 'repeater')).toMatchObject({ key: 'creditors', type: 'repeater' });
    expect(out.truncated).toBe(false);
  });
  test('search narrows by key or label; more than 49 field rows truncate with a note', async () => {
    const s = await formTemplateRead(setup(), '341_notes', 'TRUSTEE');
    expect(s.rows.slice(1).map((r) => r.key)).toEqual(['trustee_name', 'trustee_pick']);
    expect(s.rows[0]).toMatchObject({ search: 'trustee', matched: 2 });
    const big = { sections: [{ rows: [{ fields: Array.from({ length: 60 }, (_, i) => ({ name: `f${i}`, type: 'text' })) }] }] };
    const t = await formTemplateRead(setup({ tpl: { ...TPL, definition: big } }), '341_notes');
    expect([t.rows.length, t.truncated]).toEqual([50, true]);
    expect(t.rows[0].note).toBe('only the first 49 of 60 field rows are listed — read again with a "search" to find the others');
  });
});

describe('the draft: target, evidence, template', () => {
  test('form_key, link type and data shapes', async () => {
    await refuse(draftCard({ form_key: '' }), 'A form draft needs the form\'s exact form_key');
    // A12.2: an appointment is a form record (tests/caseyFormDiscardPdf.test.js) — with a positive integer appt_id.
    await refuse(draftCard({ link_type: 'appt', link_id: 'x' }), 'An appointment form needs link_id = the appointment\'s exact positive appt_id');
    await refuse(draftCard({ link_type: 'bill' }), 'A form belongs to a case (link_type "case", link_id = the exact case_id), a contact');
    await refuse(draftCard({ link_id: 'bad id!' }), 'A case form needs link_id = the case\'s exact case_id');
    await refuse(draftCard({ data: [] }), 'A form draft needs "data": an object of field key → answer');
    await refuse(draftCard({ data: {} }), 'A form draft needs at least one answer in "data"');
    expect(calls.sql).toEqual([]);
  });
  test('the evidence must cite the record AND carry the form.template read of this form', async () => {
    await refuse(draftCard({ evidence: [{ query_id: 'q2', row_number: 2 }] }), `The draft evidence does not identify case ${CASE_ID}`);
    await refuse(draftCard(), 'Read the form first: a form draft needs a form.template read of "341_notes" in this investigation', {}, EVIDENCE.slice(1));
    const otherForm = [{ ...TEMPLATE_READ, rows: [{ row_type: 'template', form_key: 'intake' }] }, ...EVIDENCE.slice(1)];
    await refuse(draftCard(), 'Read the form first', {}, otherForm);
    const notTyped = [{ ...TEMPLATE_READ, kind: 'sql.read' }, ...EVIDENCE.slice(1)];
    await refuse(draftCard(), 'Read the form first', {}, notTyped);
    expect(calls.sql).toEqual([]);
    // The read's form_key matches case-insensitively (form_key compares under general_ci).
    await expect(run(draftCard({ form_key: '341_NOTES' }))).resolves.toMatchObject({ kind: 'form.draft.v1' });
  });
  test('an unknown template, an unpublished one, another link type, a gone record', async () => {
    await refuse(draftCard(), 'No form template has form_key "341_notes" — Casey drafts only a form that has a template', { tplMissing: true });
    await refuse(draftCard(), /^UNPUBLISHED FORM refused: "341 Notes" \(341_notes\) has never been published/, { tpl: { ...TPL, definition: null } });
    await refuse(draftCard(), '"341 Notes" is a contact-linked form — its draft belongs to a contact, not a case', { tpl: { ...TPL, link_type: 'contact' } });
    await refuse(draftCard(), `Case ${CASE_ID} no longer exists`, { record: false });
    expect(calls.latest).toEqual([]);
  });
});

describe('every answer is checked against its field', () => {
  test('a key the form does not have — display-only items included', async () => {
    await refuse(draftCard({ data: { nope: 'x' } }), /^"nope" is not a field of "341 Notes" \(display-only items carry no answer\) — use the keys the form.template read returned: trustee_name, meeting_date/);
    await refuse(draftCard({ data: { banner: 'x' } }), /^"banner" is not a field of "341 Notes"/);
  });
  test.each([
    ['attended', 'yes', 'a checkbox takes true or false'],
    ['income', 'lots', '"lots" is not a number'],
    ['income', { n: 1 }, 'a number field takes a number'],
    ['income', -5, '-5 is below the field\'s minimum (0) — the form refuses it'],
    ['income', '100001', '100001 is above the field\'s maximum (100000)'],
    ['meeting_date', '11/20/2026', '"11/20/2026" is not an ISO date (YYYY-MM-DD)'],
    ['meeting_date', '2026-02-30', '"2026-02-30" is not an ISO date'],
    ['meeting_at', '2026-11-20 10:00', 'is not a date and time (YYYY-MM-DDTHH:MM, firm-local)'],
    ['meeting_at', '2026-11-20T25:00', 'is not a date and time'],
    ['meeting_at', '2026-11-20T10:60', 'is not a date and time'],
    ['outcome', 'Adjourned', '"Adjourned" is not one of its options ("Concluded", "Continued", "adj")'],
    ['mode', 1, 'a radio takes one of its options as text'],
    ['trustee_pick', 'B', 'its list is filled when the form opens, which the server cannot check'],
    ['docs_strict', ['W-2', 'Bank'], '"Bank" is not among its options'],
    ['docs', ['Bank', 'Lease'], 'only ONE value outside the options fits its "Other" box'],
    ['docs', ['W-2,Paystub'], 'contains a comma'],
    ['flags', [1], 'this field takes a list of text values'],
    ['trustee_name', 'Jane\nTrustee', 'a one-line field cannot hold a line break'],
    ['trustee_name', 42, 'a text field takes text'],
    ['notes', 'x'.repeat(51), '51 characters is over the field\'s limit of 50'],
    ['trustee_name', null, 'null is not an answer'],
    ['creditors', { creditor: 'x' }, 'a repeating section takes a list of rows'],
    ['creditors', [{ bank: 'x' }], '"bank" is not a field of this repeating section (its fields: creditor, amount, secured)'],
    ['creditors', [{ secured: 'no' }], 'row 1, secured: a checkbox takes true or false'],
    ['creditors', ['row'], 'each row is an object of the section\'s fields'],
    ['creditors', Array.from({ length: 51 }, () => ({})), '51 rows is more than one card can review (50)'],
  ])('%s = %j refuses', async (key, v, re) => {
    await expect(answer(key, v)).rejects.toThrow(re);
  });
  test('stored the way the form saves it: masks stripped (disclosed), lists comma-joined, numbers as text, Other in its box', async () => {
    const c = await run(draftCard({ data: { phone: '(313) 555-1212', docs: ['W-2', 'Bank statements'], flags: 'urgent, lien ,urgent', income: 1200.5,
      attended: false, outcome: 'adj', creditors: [{ creditor: 'Acme', amount: 50, secured: true }], meeting_date: '', notes: 'line one\nline two' } }));
    expect(c.data).toEqual({ phone: '3135551212', docs: 'W-2,Bank statements', flags: 'urgent,lien', income: '1200.5', attended: false, outcome: 'adj',
      creditors: [{ creditor: 'Acme', amount: '50', secured: true }], meeting_date: '', notes: 'line one\nline two' });
    expect(c.effects).toContain('Stored form: "Phone": stored as "3135551212" — the field\'s phone mask keeps digits only, exactly as the form saves it.');
    expect(c.effects).toContain('Stored form: "Docs": "Bank statements" goes in its "Other" box.');
  });
  test('a card the chat could not store (over 60,000 characters with the carried answers) refuses', async () => {
    const big = {}; for (let i = 0; i < 40; i++) big[`old_${i}`] = 'y'.repeat(1500);
    await refuse(draftCard(), /^This draft card would be 6\d,\d{3} characters \(the draft's answers ride on it\) — more than a chat can store with it \(60,000\)/,
      { draft: { id: 55, data: big, updated_at: new Date(), submitted_by: 6, user_name: 'Fred', schema_version: 4 } });
    const fits = {}; for (let i = 0; i < 30; i++) fits[`old_${i}`] = 'y'.repeat(1500);
    await expect(run(draftCard(), { draft: { id: 55, data: fits, updated_at: new Date(), submitted_by: 6, user_name: 'Fred', schema_version: 4 } })).resolves.toMatchObject({ kind: 'form.draft.v1' });
  });
  test('the 64 KB bound is measured on the whole payload that will be sent', async () => {
    const big = { trustee_name: 'x' }; for (let i = 0; i < 70; i++) big[`old_${i}`] = 'y'.repeat(1000);
    await refuse(draftCard({ data: { notes: 'z' } }), /^The draft would be 7\d,\d{3} bytes — the form store's limit is 65,536 \(64 KB\)/,
      { draft: { id: 55, data: big, updated_at: new Date(), submitted_by: 6, user_name: 'Fred', schema_version: 4 } });
  });
});

describe('THE CARRY-FORWARD: the route replaces a draft whole', () => {
  const OLD = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const stored = { outcome: 'Continued', trustee_name: 'Old Trustee', retired_field: 'kept', attended: true };
  const existing = (over = {}) => ({ id: 55, data: JSON.stringify(stored), updated_at: OLD, submitted_by: 2, user_name: 'Stuart', schema_version: 3, ...over });

  test('every existing answer not set is sent again verbatim, counted; before → after; the expected hash is the stored data\'s', async () => {
    const c = await run(draftCard({ data: { trustee_name: 'Jane Trustee', mode: 'Zoom' } }), { draft: existing() });
    expect(calls.latest).toEqual([['341_notes', 'case', CASE_ID]]);
    expect(c.data).toEqual({ outcome: 'Continued', trustee_name: 'Jane Trustee', retired_field: 'kept', attended: true, mode: 'Zoom' });
    expect(c.changes).toEqual([
      { key: 'trustee_name', label: 'Trustee', type: 'text', before: '"Old Trustee"', after: '"Jane Trustee"', unchanged: false },
      { key: 'mode', label: 'Mode', type: 'radio', before: null, after: '"Zoom"', unchanged: false }]);
    expect(c.carried).toEqual({ count: 3, off_form: 1 });
    expect(c.effects).toContain('Replaces draft #55 (saved by Stuart (user #2) at ' + OLD.toISOString().slice(0, 16).replace('T', ' ') + ' UTC): the form store replaces a draft WHOLE, so every answer it holds that this card does not set is sent again verbatim — 3 existing answers carried forward unchanged (Outcome, retired_field, Attended). 1 of them is not on the current form (kept as stored).');
    expect(c.effects).toContain('Form version: the draft was saved under form version 3; it is stamped with the current version 4.');
    // The hash is over the STORED data, key-order-insensitive (MySQL re-orders JSON keys on write).
    const canon = '{"attended":true,"outcome":"Continued","retired_field":"kept","trustee_name":"Old Trustee"}';
    expect(c.expected).toEqual({ draft_id: 55, updated_at: OLD.toISOString(), data_hash: sha(canon) });
    const reordered = await run(draftCard({ data: { trustee_name: 'Jane Trustee' } }),
      { draft: existing({ data: { trustee_name: 'Old Trustee', attended: true, retired_field: 'kept', outcome: 'Continued' } }) });
    expect(reordered.expected.data_hash).toBe(sha(canon));
    expect(c.existing).toEqual({ draft_id: 55, updated_at: OLD.toISOString(), saved_by: 'Stuart (user #2)', schema_version: 3 });
  });
  test('a no-op refuses; an answer already equal is shown unchanged beside a real change', async () => {
    await refuse(draftCard({ data: { outcome: 'Continued' } }), 'That changes nothing — the existing draft of "341 Notes" on case 25-12345 already holds exactly those answers', { draft: existing() });
    const c = await run(draftCard({ data: { outcome: 'Continued', mode: 'Phone' } }), { draft: existing() });
    expect(c.changes[0]).toMatchObject({ key: 'outcome', unchanged: true, before: '"Continued"', after: '"Continued"' });
  });
  test('no draft yet: this card creates it; expected says none', async () => {
    const c = await run(draftCard());
    expect([c.existing, c.carried, c.expected]).toEqual([null, { count: 0, off_form: 0 }, { draft_id: null, updated_at: null, data_hash: null }]);
    expect(c.effects).toContain('No draft exists yet: this card creates the draft for this record.');
  });
  test('an unreadable stored draft refuses (replacing it would lose it)', async () => {
    await refuse(draftCard(), 'The existing draft #55 holds data that is not a JSON object — replacing it would lose it', { draft: existing({ data: '[1,2]' }) });
  });
});

describe('the disclosures', () => {
  const recent = new Date(Date.now() - 2 * 3600 * 1000);
  test('someone else\'s draft in the last 24 hours is a danger warning; mine, or an older one, is not', async () => {
    const other = await run(draftCard(), { draft: { id: 55, data: { mode: 'Zoom' }, updated_at: recent, submitted_by: 2, user_name: 'Stuart', schema_version: 4 } });
    const at = recent.toISOString().slice(0, 16).replace('T', ' ');
    // A staff form's autosave carries the draft POST's precondition: refused, and the card's draft shows in its banner.
    expect(other.warnings[0]).toBe(`RECENT DRAFT BY SOMEONE ELSE: Stuart (user #2) saved this draft at ${at} UTC — within the last 24 hours, so they may still be working on it. Every answer they saved is carried forward unchanged. If they still have the form open, their next autosave is refused instead of replacing this card's answers: their form shows this card's draft in a banner, where Restore loads it and Discard deletes it.`);
    const client = await run(draftCard(), { draft: { id: 55, data: { mode: 'Zoom' }, updated_at: recent, submitted_by: null, user_name: null, schema_version: 4 } });
    // The public form's draft save has no stale check: its next autosave still replaces the draft whole.
    expect(client.warnings[0]).toBe(`RECENT DRAFT BY SOMEONE ELSE: the client, on the public form link (no staff account) saved this draft at ${at} UTC — within the last 24 hours, so they may still be working on it. Every answer they saved is carried forward unchanged. If they still have the public form open, its next autosave replaces the whole draft, this card's answers included (the public form's draft save has no stale check).`);
    const mine = await run(draftCard(), { draft: { id: 55, data: { mode: 'Zoom' }, updated_at: recent, submitted_by: 6, user_name: 'Fred', schema_version: 4 } });
    expect(mine.warnings.some((w) => /RECENT DRAFT/.test(w))).toBe(false);
    expect(mine.existing.saved_by).toBe('you');
    const old = await run(draftCard(), { draft: { id: 55, data: { mode: 'Zoom' }, updated_at: new Date(Date.now() - 25 * 3600 * 1000), submitted_by: 2, user_name: 'Stuart', schema_version: 4 } });
    expect(old.warnings.some((w) => /RECENT DRAFT/.test(w))).toBe(false);
  });
  test('RESTORE BLANKS: the fields a draft does not hold are named (danger), with the record write when the form patches the record', async () => {
    const c = await run(draftCard());
    expect(c.absent).toBe(13);
    expect(c.warnings[0]).toMatch(/^RESTORE BLANKS 13 FIELDS: after this card the draft holds 1 of the form's 14 answers\. Restoring it on the form shows every other field BLANK \(Meeting date, Meeting time, Attended,/);
    expect(c.warnings[0]).toContain('— and this form also writes fields to the record itself when saved. Check the restored form before saving it.');
    const full = Object.fromEntries(['meeting_date', 'meeting_at', 'outcome', 'mode', 'docs', 'docs_strict', 'flags', 'income', 'phone', 'notes', 'trustee_pick'].map((k) => [k, '']));
    const whole = await run(draftCard({ data: { trustee_name: 'Jane', attended: true, creditors: [], ...full } }));
    expect(whole.warnings).toEqual([]);
    const noPatch = await run(draftCard(), { tpl: { ...TPL, definition: { ...DEF, onSubmit: {} } } });
    expect(noPatch.warnings[0]).not.toContain('writes fields to the record');
  });
  test('client visibility by the serving code\'s rule: public + server drafts (case) warns; public without, portal and internal say who sees it', async () => {
    const pub = (def, vis = 'public', link = 'case') => run(draftCard(), { tpl: { ...TPL, visibility: vis, link_type: link, definition: def } });
    const sd = await pub({ ...DEF, external: { serverDrafts: true } });
    expect(sd.warnings.find((w) => /^CLIENT-VISIBLE/.test(w))).toBe('CLIENT-VISIBLE: "341 Notes" is a public form with server drafts — whoever opens this case\'s public form link (the client) is offered THIS draft to resume, every answer in it shown to them; their own autosave then replaces it, and their submit deletes it.');
    const loose = await pub({ ...DEF, external: { serverDrafts: 'yes' } });
    expect(loose.warnings.some((w) => /CLIENT-VISIBLE/.test(w))).toBe(false);
    expect(loose.effects).toContain('Public form without server drafts: its public link keeps a client\'s unsent answers in the client\'s own browser, so the public page never shows this staff draft — staff only.');
    expect((await pub(DEF, 'portal')).effects).toContain('Portal visibility: no portal page serves forms today (only public forms are served outside the app), so no client sees this draft — staff only.');
    expect((await pub(DEF, 'internal')).effects).toContain('Staff-only form (internal): no client page shows it.');
  });
  test('required answers left empty, the submitted row untouched, no trigger event', async () => {
    const c = await run(draftCard({ data: { trustee_name: '' } }), { submitted: { id: 40, version: 2, updated_at: new Date('2026-10-01T10:00:00Z'), submitted_by: 2, user_name: 'Stuart' } });
    expect(c.required_empty).toEqual(['Trustee']);
    expect(c.effects).toContain('Required answers still empty: Trustee — a draft may leave them empty; the form asks for them when it is saved.');
    expect(c.effects[0]).toBe('Saved as a DRAFT only — nothing is submitted. The latest SUBMITTED answers (version 2, submission #40, saved by Stuart at 2026-10-01 10:00 UTC) are untouched — a draft is a separate row.');
    expect(c.submitted).toEqual({ submission_id: 40, version: 2, updated_at: '2026-10-01T10:00:00.000Z' });
    expect(c.effects).toContain('Trigger event: none — saving a draft emits no event (form.submitted fires on a submission only), and a draft satisfies no pipeline step (those count submitted forms only).');
    expect(c.form).toEqual({ form_key: '341_notes', title: '341 Notes', link_type: 'case', visibility: 'internal', schema_version: 4, data_mode: 'snapshot' });
    expect(c.record).toEqual({ link_type: 'case', link_id: CASE_ID, label: 'case 25-12345' });
  });
});

describe('the submission link', () => {
  test('submission id, link type, evidence for both rows (a BIGINT string row accepted)', async () => {
    await refuse(linkCard({ submission_id: 'x' }), 'A submission link needs the submission\'s exact positive submission_id');
    await refuse(linkCard({ link_type: 'appt', link_id: 0 }), 'An appointment form needs link_id = the appointment\'s exact positive appt_id');
    await refuse(linkCard({ evidence: [{ query_id: 'q3', row_number: 2 }, { query_id: 'q2', row_number: 1 }] }), 'The link evidence does not identify submission #4521 — cite a form_submissions row carrying its exact submission_id');
    await refuse(linkCard({ evidence: [{ query_id: 'q3', row_number: 1 }] }), `The link evidence does not identify case ${CASE_ID}`);
    expect(calls.getSubmission).toBe(0);
    await expect(run(linkCard(), { sub: SUB })).resolves.toMatchObject({ kind: 'form.submission.link.v1' });
  });
  test('the route\'s refusals, run first: gone, a draft, already linked, no template, another link type, a gone target', async () => {
    await refuse(linkCard(), 'Submission #4521 no longer exists', { subMissing: true });
    await refuse(linkCard(), /^A DRAFT cannot be linked: submission #4521 is a draft — the route links submitted forms only \("Only submitted submissions can be linked"\)/, { sub: { ...SUB, status: 'draft' } });
    await refuse(linkCard(), /^ALREADY LINKED: submission #4521 is already linked \(case ZZ1\)/, { sub: { ...SUB, link_type: 'case', link_id: 'ZZ1' } });
    await refuse(linkCard(), /^Submission #4521's form "341_notes" has no template, so Casey cannot check where it belongs/, { sub: SUB, tplMissing: true });
    await refuse(linkCard(), 'Form "341_notes" is a contact-linked form — it cannot be linked to a case', { sub: SUB, tpl: { ...TPL, link_type: 'contact' } });
    await refuse(linkCard(), `case "${CASE_ID}" not found`, { sub: SUB, record: false });
  });
  test('identity: the name / phone / email rule; matches are named, a mismatch is a danger warning (never a refusal)', async () => {
    const ok = await run(linkCard(), { sub: SUB });
    expect(ok.identity).toEqual([
      { answer: 'name', value: 'Dana Debtor', matched: 'Dana Q. Debtor' },
      { answer: 'phone', value: '(313) 555-1212', matched: 'Dana Q. Debtor' },
      { answer: 'email', value: 'Dana@Example.com', matched: 'Dana Q. Debtor' }]);
    expect(ok.warnings).toEqual([]);
    // A phone held only on a contact_phones row (ended rows included), an 11-digit 1-prefix, an accent.
    const alt = await run(linkCard(), { sub: { ...SUB, data: { name: 'Dána  DEBTOR', phone: '1-248-555-0000' } }, phones: [{ contact_id: 1309, phone: '2485550000' }] });
    expect(alt.identity.map((x) => x.matched)).toEqual(['Dana Q. Debtor', 'Dana Q. Debtor']);
    const bad = await run(linkCard(), { sub: { ...SUB, data: { name: 'Robert Smith', phone: '555-1212', email: 'dana@example.com' } } });
    expect(bad.identity[1]).toEqual({ answer: 'phone', value: '555-1212', matched: null, note: 'not a 10-digit phone number' });
    expect(bad.warnings).toEqual([`IDENTITY MISMATCH: the submission's name "Robert Smith", phone "555-1212" match no contact on this case (Dana Q. Debtor, Primary). Check it is the right person before linking — the route never unlinks.`]);
    // One name word is compared alone; a first name alone does not match a different surname.
    expect((await run(linkCard(), { sub: { ...SUB, data: { name: 'Debtor' } } })).warnings).toEqual([]);
    expect((await run(linkCard(), { sub: { ...SUB, data: { name: 'Dana Smith' } } })).warnings[0]).toMatch(/^IDENTITY MISMATCH: the submission's name "Dana Smith" matches no contact/);
    const none = await run(linkCard(), { sub: { ...SUB, data: { income: '1' } } });
    expect(none.effects[0]).toMatch(/^Identity: the answers carry no name, phone or email/);
    const empty = await run(linkCard(), { sub: SUB, people: [] });
    expect(empty.warnings).toEqual([`IDENTITY NOT CHECKED: case 25-12345 has no contacts, so the submission's name / phone / email could not be compared with anyone. Check it is the right case.`]);
  });
  test('the version it becomes, the form tab, the log entry, staff only, no trigger event, expected', async () => {
    const c = await run(linkCard(), { sub: SUB, maxVersion: 2 });
    expect(c.version_after).toBe(3);
    expect(c.effects).toContain(`Links submission #4521 ("341 Notes", received 2026-10-30 15:04 UTC, unlinked) to case 25-12345: it becomes version 3 of this form there — the NEWEST submission (the latest until now is version 2; it carried version 17 in the unlinked series).`);
    expect(c.effects).toContain('The form opens in SNAPSHOT mode: once a submission exists it is what the form shows, so this form on the record shows these answers from now on.');
    expect(c.effects).toContain('Log: a "form" entry is written on case 25-12345 — subject "Form adopted: 341 Notes", message "341 Notes submission #4521 (received unlinked) was linked to this case from the Form Inbox." (the route\'s fixed wording, which names the Form Inbox although Casey prepared the card). It is best-effort: a failed log write keeps the link.');
    expect(c.effects).toContain('Trigger event: none — linking emits no event (form.submitted fired when the form arrived, with no case or contact) and starts no workflow.');
    expect(c.expected).toEqual({ status: 'submitted', link_type: '', link_id: '', version: 17 });
    expect(c.link).toEqual({ link_type: 'case', link_id: CASE_ID });
    expect(c.submission).toMatchObject({ submission_id: 4521, form_key: '341_notes', title: '341 Notes', version: 17, saved_by: 'the public form (no staff account)' });
    const first = await run(linkCard(), { sub: SUB, tpl: { ...TPL, definition: { ...DEF, dataMode: 'live' } } });
    expect(first.effects).toContain('The form opens in live mode (its fields read the record itself): the submission joins the record\'s form history; the form\'s fields do not change.');
    expect(first.effects.find((e) => /^Links/.test(e))).toContain('the first submission of this form on this record');
  });
  test('the intake gate (form_key "intake" on a case only) and the pipeline steps that read submitted forms', async () => {
    const intake = (cur) => run(linkCard(), { sub: { ...SUB, form_key: 'intake' }, tpl: { ...TPL, form_key: 'intake' }, intake: cur });
    expect((await intake('')).effects).toContain('Intake gate: the case\'s intake-form pointer is empty, so it is stamped "yf:4521" — the intake reminder sequences stop asking for an intake form.');
    expect((await intake(null)).effects).toContain('Intake gate: the case\'s intake-form pointer is NULL — the route stamps only an EMPTY pointer, so it stays unstamped and any intake reminder keeps running.');
    expect((await intake('yf:9')).effects).toContain('Intake gate: the case\'s intake-form pointer already reads "yf:9" — not changed.');
    expect((await run(linkCard(), { sub: SUB })).effects.some((e) => /Intake gate/.test(e))).toBe(false);
    const steps = await run(linkCard(), { sub: SUB, reqs: ['341 notes taken', '341 notes taken', 'Notes in'] });
    expect(steps.effects).toContain('Pipeline steps: "341 notes taken", "Notes in" look for a submitted "341_notes" form on the case — on this case they read as done from now on.');
    expect((await run(linkCard(), { sub: SUB })).effects).toContain('Pipeline steps: no active step looks for a submitted "341_notes" form.');
  });
  test('a contact target: its own name, phones and emails; no pipeline line', async () => {
    const tpl = { ...TPL, link_type: 'contact' };
    const c = await run(linkCard({ link_type: 'contact', link_id: 1309, evidence: [{ query_id: 'q3', row_number: 1 }, { query_id: 'q2', row_number: 3 }] }), { sub: SUB, tpl });
    expect(c.link).toEqual({ link_type: 'contact', link_id: '1309' });
    expect(c.warnings).toEqual([]);
    expect(c.effects.some((e) => /Pipeline steps/.test(e))).toBe(false);
  });
});

describe('the ledger receipt and the request detector', () => {
  test('both kinds receipt the integer submission_id', () => {
    expect([ledger.KINDS.get('form.draft.v1'), ledger.KINDS.get('form.submission.link.v1')]).toEqual(['submission_id', 'submission_id']);
  });
  test('a form request forces the draft path; a question about forms does not', () => {
    expect(taskDraftRequested('Prefill the 341 notes form for the Smith case: trustee is Jane Trustee')).toBe(true);
    expect(taskDraftRequested('Link that intake submission to her case')).toBe(true);
    expect(taskDraftRequested('Fill in the questionnaire draft for Dana')).toBe(true);
    expect(taskDraftRequested('What forms are on this case?')).toBe(false);
  });
});
