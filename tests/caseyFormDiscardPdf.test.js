'use strict';
/**
 * tests/caseyFormDiscardPdf.test.js
 *
 * A12.2 — Casey discards ONE saved form draft or files ONE submitted form's
 * PDF to Dropbox, through reviewed cards on the pages' own routes, and the A12
 * form cards take appointment records:
 *   form.draft.delete.v1 → DELETE /api/forms/draft?form_key&link_type&link_id (the draft banner's Discard)
 *   form.pdf.file.v1     → POST   /api/forms/submissions/:id/pdf/file {filename?} (the Form Inbox's File)
 * Submitting a stored draft is A12.3's own card (form.submit.v1 —
 * tests/caseyFormSubmit.test.js); a submit-shaped key on these cards is
 * refused by name, pointing at it.
 *
 * The contract pinned here:
 *   1. the casey_forms_enabled switch covers the new kinds; the by-name and
 *      unknown-key refusals (the other-operations sentence names every form
 *      card, the submit card included) run before anything is read;
 *   2. the discard: the DRAFT row and its record cited; a submitted row, a row
 *      with no record and a gone record refused; every answer listed (template
 *      labels, off-form keys, no template, a non-object payload); NO UNDO
 *      always; the client's draft and a recent draft by someone else; the open
 *      copies sentence; expected (key-order-insensitive hash);
 *   3. the PDF: the submission (and, when linked, its record) cited; a draft
 *      refused; the route's render 404s refused first; the file name exactly
 *      as formPdfService builds it (default core in firm time; an override
 *      sanitized); the placement ladder read-only (case folder, a case with no
 *      folder → CASE FOLDER CREATED, a gone case → UNSORTED, contact /
 *      appointment / unlinked → the bin with an identity prefix); the copies
 *      heuristic → ALREADY FILED (a warning, never a refusal); registration,
 *      trigger rules, fidelity; expected;
 *   4. appointment records on the A12 draft and link cards;
 *   5. the ledger receipts and the request detector;
 *   6. the browser half (lifted from public/assistant.html by name): the fixed
 *      requests, the click-time re-reads, the result checks (the PDF verdict
 *      kept without its temporary link), the outcomes, danger, text, entity.
 *
 * The routes' own behaviour (the DELETE matches and answers {deleted}; a second
 * filing registers a second document; the 400 / 404s) runs on a real engine in
 * tests/caseyFormDiscardPdf.mysql.test.js.
 *
 *   npx jest tests/caseyFormDiscardPdf.test.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const formService = require(path.join(REPO, 'services', 'formService'));
const settingsService = require(path.join(REPO, 'services', 'settingsService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;
const DEF = {
  sections: [
    { rows: [{ fields: [
      { name: 'trustee_name', label: 'Trustee', type: 'text', required: true },
      { name: 'attended', label: 'Attended', type: 'checkbox' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ] }] },
    { repeater: 'creditors', fields: [{ name: 'creditor', type: 'text' }] },
  ],
};
const TPL = { id: 3, form_key: '341_notes', title: '341 Notes', link_type: 'case', schema_version: 4, visibility: 'internal', published_at: new Date('2026-10-01T00:00:00Z'), definition: JSON.stringify(DEF) };
const APPT_TPL = { ...TPL, id: 5, form_key: 'appt_prep', title: 'Appointment prep', link_type: 'appt' };
const CLIENT_TPL = { ...TPL, id: 6, form_key: 'intake', title: 'Intake', visibility: 'public', definition: JSON.stringify({ ...DEF, external: { serverDrafts: true } }) };

const EVIDENCE = [
  { id: 'q1', kind: 'sql.read', purpose: 'form rows', rows: [{ submission_id: '4530' }, { submission_id: 4521 }, { submission_id: 4600 }, { submission_id: 4700 }, { submission_id: 4800 }] },
  { id: 'q2', kind: 'sql.read', purpose: 'records', rows: [{ case_id: CASE_ID }, { contact_id: 1309 }, { appt_id: 812 }, { case_id: 'GONE0001' }] },
  { id: 'q3', kind: 'form.template', purpose: 'form', rows: [{ row_type: 'template', form_key: 'appt_prep', published: 1 }] },
];
const DRAFT_DATA = { trustee_name: 'Jane Trustee', attended: true, notes: '', creditors: [{ creditor: 'Bank' }], stale_key: 'old' };
const UPDATED = new Date('2026-11-01T10:00:00Z');
const draftRow = (over = {}) => ({ id: 4530, form_key: '341_notes', link_type: 'case', link_id: CASE_ID, status: 'draft', version: 0, schema_version: 4,
  data: JSON.stringify(DRAFT_DATA), submitted_by: ME, user_name: 'Fred', created_at: UPDATED, updated_at: UPDATED, ...over });
const subRow = (over = {}) => ({ id: 4521, form_key: '341_notes', link_type: 'case', link_id: CASE_ID, status: 'submitted', version: 3, schema_version: 4,
  data: { trustee_name: 'Jane Trustee', name: 'Dana Debtor' }, submitted_by: null, user_name: null,
  created_at: new Date('2026-10-30T03:30:00Z'), updated_at: new Date('2026-10-30T03:30:00Z'), ...over });

let spies = [];
let calls;
function setup({ tpls = { '341_notes': TPL, appt_prep: APPT_TPL, intake: CLIENT_TPL }, rows = {}, latest, render, renderFail,
  caseDropbox = 'https://www.dropbox.com/sh/case', cachePath = '/active cases/debtor, dana', copies = [], bin = null, rules = [], record = true } = {}) {
  calls = { latest: [], getSubmission: [], render: 0, sql: [], rules: [] };
  const byId = { 4530: draftRow(), 4521: subRow(), ...rows };
  spies = [
    jest.spyOn(formService, 'getSubmission').mockImplementation(async (_db, id) => {
      calls.getSubmission.push(Number(id));
      const r = byId[Number(id)];
      if (!r) throw Object.assign(new Error(`Submission ${id} not found`), { status: 404 });
      return { ...r };
    }),
    jest.spyOn(formService, 'getLatest').mockImplementation(async (_db, k, t, id) => {
      calls.latest.push([k, t, id]);
      if (latest) return latest;
      const d = Object.values(byId).find((r) => r.status === 'draft' && r.form_key === k && r.link_type === t && String(r.link_id) === String(id));
      return { draft: d ? { ...d } : null, submitted: { id: 4400, version: 2, updated_at: new Date('2026-10-20T00:00:00Z'), submitted_by: 2, user_name: 'Stuart' } };
    }),
    jest.spyOn(formService, 'getSubmissionForRender').mockImplementation(async (_db, id) => {
      calls.render += 1;
      if (renderFail) throw renderFail;
      const r = byId[Number(id)];
      return render || { submission: r, title: (tpls[r.form_key] || {}).title || r.form_key, link_type: 'case', definition: DEF, definition_schema_version: 4, schema_matched: true };
    }),
    jest.spyOn(settingsService, 'getSetting').mockImplementation(async () => bin),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules.filter((r) => r.ev === ev); }),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.sql.push(flat);
    if (flat.startsWith('SELECT id, form_key, title, link_type, schema_version, visibility, published_at, definition FROM form_templates WHERE form_key = ?')) {
      return [tpls[params[0]] ? [{ ...tpls[params[0]] }] : []];
    }
    if (flat.startsWith('SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ?')) {
      return [record && params[0] === CASE_ID ? [{ case_id: CASE_ID, case_number: '25-12345', case_number_full: null, case_type: 'Bankruptcy' }] : []];
    }
    if (flat.startsWith('SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?')) {
      return [record && params[0] === 1309 ? [{ contact_id: 1309, contact_name: 'Dana Debtor' }] : []];
    }
    if (flat.startsWith('SELECT a.appt_id, a.appt_type')) {
      return [record && params[0] === 812 ? [{ appt_id: 812, appt_type: 'Consultation', appt_date_local: '2026-11-20 14:30', appt_status: 'Scheduled', appt_client_id: 1309, contact_name: 'Dana Debtor' }] : []];
    }
    if (flat === 'SELECT case_dropbox FROM cases WHERE case_id = ? LIMIT 1') return [params[0] === CASE_ID ? [{ case_dropbox: caseDropbox }] : []];
    if (flat.startsWith('SELECT path_lower FROM case_folder_cache')) return [cachePath ? [{ path_lower: cachePath }] : []];
    if (flat === 'SELECT contact_lfm_name FROM contacts WHERE contact_id = ? LIMIT 1') return [[{ contact_lfm_name: 'Debtor, Dana' }]];
    if (flat.startsWith("SELECT COUNT(*) AS n FROM documents WHERE status = 'active' AND name LIKE ?")) {
      calls.like = params[0];
      return [[{ n: copies.length }]];
    }
    if (flat.startsWith("SELECT id, name FROM documents WHERE status = 'active' AND name LIKE ?")) return [copies.slice(0, 3).map((name, i) => ({ id: 900 + i, name }))];
    if (flat.startsWith('SELECT contact_id, contact_name, contact_fname, contact_lname, contact_phone, contact_email FROM contacts WHERE contact_id IN (?)')) {
      return [[{ contact_id: 1309, contact_name: 'Dana Q. Debtor', contact_fname: 'Dana', contact_lname: 'Debtor', contact_phone: '3135551212', contact_email: 'dana@example.com' }]];
    }
    if (flat === 'SELECT contact_id, phone FROM contact_phones WHERE contact_id IN (?)') return [[]];
    if (flat === 'SELECT contact_id, email FROM contact_emails WHERE contact_id IN (?)') return [[]];
    if (flat.startsWith('SELECT COALESCE(MAX(version), 0) AS max_version FROM form_submissions')) return [[{ max_version: 0 }]];
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_FORMS_ENABLED; });

const discard = (over = {}) => ({ kind: 'form.draft.delete.v1', submission_id: 4530,
  evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }], ...over });
const pdf = (over = {}) => ({ kind: 'form.pdf.file.v1', submission_id: 4521,
  evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 1 }], ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: ME });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);

describe('the per-family switch and the by-name refusals', () => {
  test("'0' makes the discard and the PDF kinds unavailable; unset is ON", async () => {
    process.env.CASEY_FORMS_ENABLED = '0';
    await refuse(discard(), /^Action kind is unavailable$/);
    await refuse(pdf(), /^Action kind is unavailable$/);
    expect(calls.sql).toEqual([]);
    delete process.env.CASEY_FORMS_ENABLED;
    await expect(run(discard())).resolves.toMatchObject({ kind: 'form.draft.delete.v1', status: 'draft' });
    await expect(run(pdf())).resolves.toMatchObject({ kind: 'form.pdf.file.v1', status: 'draft' });
  });

  test('the route-owned columns, other operations (the sentence names the submit card) and unknown keys, before any read', async () => {
    await refuse(discard({ status: 'draft' }), /^RESERVED FIELDS refused \(status\): a discard card names the draft row by submission_id/);
    await refuse(pdf({ version: 3 }), /^RESERVED FIELDS refused \(version\): a PDF card names the submission by submission_id/);
    for (const card of [discard({ submit: true }), pdf({ submit_form: true }), pdf({ delete: true })]) {
      await refuse(card, /^OTHER FORM OPERATIONS refused \(\w+\): each form card does ONE thing .* file ONE submission's PDF \(form\.pdf\.file\.v1\) or submit ONE stored draft \(form\.submit\.v1\)\. Editing \/ publishing \/ restoring a template/);
    }
    await refuse(pdf({ again: true }), /^A form pdf card carries unsupported fields: again — it takes submission_id and an optional filename and evidence only$/);
    await refuse(discard({ form_key: '341_notes', link_type: 'case', link_id: CASE_ID }), /^A form discard card carries unsupported fields: form_key, link_type, link_id — it takes submission_id \(the DRAFT row\) and evidence only$/);
    expect([calls.sql, calls.getSubmission, calls.latest]).toEqual([[], [], []]);
  });

  test('the submit kind exists now (A12.3): it reaches its own normalizer', async () => {
    await refuse({ kind: 'form.submit.v1', submission_id: 4530, evidence: [{ query_id: 'q2', row_number: 1 }] }, /^The submit evidence does not identify draft #4530/);
  });
});

describe('the discard', () => {
  test('ids and evidence: the DRAFT row AND its record, before the route-shaped reads', async () => {
    await refuse(discard({ submission_id: 'x' }), 'A draft discard needs the DRAFT row\'s exact positive submission_id');
    await refuse(discard({ evidence: [{ query_id: 'q2', row_number: 1 }] }), 'The discard evidence does not identify draft #4530 — cite the form_submissions row');
    expect(calls.getSubmission).toEqual([]);
    await refuse(discard({ evidence: [{ query_id: 'q1', row_number: 1 }] }), `The discard evidence does not identify case ${CASE_ID} — cite a row carrying its exact case_id`);
  });

  test('refused: gone, a submitted form, a row with no record, a gone record, a row that is no longer the draft', async () => {
    await refuse(discard({ submission_id: 4600, evidence: [{ query_id: 'q1', row_number: 3 }] }), 'Draft #4600 no longer exists');
    await refuse(discard({ submission_id: 4521, evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 1 }] }),
      '#4521 is a SUBMITTED form (version 3), not a draft — no screen deletes a submission; Casey discards drafts only');
    await refuse(discard(), 'Draft #4530 belongs to no record — no form page opens it', { rows: { 4530: draftRow({ link_type: '', link_id: '' }) } });
    await refuse(discard(), `Case ${CASE_ID} no longer exists — no form page opens this draft`, { record: false });
    await refuse(discard(), 'Draft #4530 is no longer the draft of this form and record', { latest: { draft: null, submitted: null } });
  });

  test('the card: every answer with its label, off-form keys, the record, who saved it, NO UNDO, the open copies, expected', async () => {
    const c = await run(discard());
    expect(c.form).toEqual({ form_key: '341_notes', title: '341 Notes', link_type: 'case', visibility: 'internal', has_template: true });
    expect(c.record).toEqual({ link_type: 'case', link_id: CASE_ID, label: 'case 25-12345' });
    expect(c.draft).toEqual({ submission_id: 4530, form_key: '341_notes', link_type: 'case', link_id: CASE_ID, updated_at: UPDATED.toISOString(), saved_by: 'you', schema_version: 4 });
    expect(c.answers).toEqual([
      { key: 'trustee_name', label: 'Trustee', value: '"Jane Trustee"' },
      { key: 'attended', label: 'Attended', value: 'checked' },
      { key: 'notes', label: 'Notes', value: '(empty)' },
      { key: 'creditors', label: 'creditors', value: '[{"creditor":"Bank"}]' },
      { key: 'stale_key', label: 'stale_key', value: '"old"', off_form: true },
    ]);
    expect([c.answers_total, c.answers_filled]).toEqual([5, 4]);
    expect(c.warnings).toEqual(['NO UNDO: draft #4530 is DELETED — its 5 saved answers (4 filled in) are gone for good; no screen restores a discarded draft.']);
    expect(c.effects[0]).toBe('Deletes draft #4530 of "341 Notes" for case 25-12345, saved by you at 2026-11-01 10:00 UTC (form version 4).');
    expect(c.effects[1]).toBe('The latest SUBMITTED answers (version 2, submission #4400, 2026-10-20 00:00 UTC) are untouched — the form shows them when it opens.');
    expect(c.effects).toContain('Other open pages: nothing announces the discard — the route answers only {deleted}, with no record for the sync bus to name. A copy of this form already open anywhere keeps showing its draft banner (Restore there still fills the form from the copy it loaded), and its next autosave after any typing saves a NEW draft from that screen.');
    expect(c.effects).toContain('Trigger event: none — discarding a draft emits no event, and a draft satisfies no pipeline step.');
    expect(c.submitted).toEqual({ submission_id: 4400, version: 2, updated_at: '2026-10-20T00:00:00.000Z' });
    // The read the click re-runs, on the stored row's own key and record.
    expect(calls.latest).toEqual([['341_notes', 'case', CASE_ID]]);
    // The hash is over the canonical (key-sorted) stored payload.
    const reordered = Object.fromEntries(Object.entries(DRAFT_DATA).reverse());
    const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
    expect(c.expected).toEqual({ draft_id: 4530, updated_at: UPDATED.toISOString(), data_hash: crypto.createHash('sha256').update(canon(reordered)).digest('hex') });
    const c2 = await run(discard(), { rows: { 4530: draftRow({ data: JSON.stringify(reordered) }) } });
    expect(c2.expected.data_hash).toBe(c.expected.data_hash);
  });

  test('the client\'s draft (public with server drafts), someone else\'s recent draft, and an old one', async () => {
    const client = await run(discard(), { rows: { 4530: draftRow({ form_key: 'intake', submitted_by: null, user_name: null }) } });
    expect(client.warnings[1]).toBe('THE CLIENT\'S DRAFT: the client saved it on the public form link at 2026-11-01 10:00 UTC. The public link offers them this draft to resume; after the discard it has nothing to offer, and whatever they typed is gone.');
    const recent = new Date(Date.now() - 3600 * 1000);
    const other = await run(discard(), { rows: { 4530: draftRow({ submitted_by: 2, user_name: 'Stuart', updated_at: recent }) } });
    expect(other.warnings[1]).toMatch(/^RECENT DRAFT BY SOMEONE ELSE: Stuart \(user #2\) saved this draft at .* — within the last 24 hours, so they may still be working on it\. If their form is still open, its next autosave saves a NEW draft from their screen\.$/);
    const old = await run(discard(), { rows: { 4530: draftRow({ submitted_by: 2, user_name: 'Stuart' }) } });
    expect(old.warnings).toHaveLength(1);
    expect(old.draft.saved_by).toBe('Stuart (user #2)');
  });

  test('a hand-built form with no template, a non-object payload, more answers than a card lists', async () => {
    const hand = await run(discard(), { rows: { 4530: draftRow({ form_key: 'casedetails' }) } });
    expect([hand.form, hand.answers[0]]).toEqual([{ form_key: 'casedetails', title: 'casedetails', link_type: 'case', visibility: null, has_template: false },
      { key: 'trustee_name', label: 'trustee_name', value: '"Jane Trustee"' }]);
    expect(hand.effects).toContain('Form: "casedetails" has no template (one of the hand-built form pages) — the answers are listed by their keys.');
    const raw = await run(discard(), { rows: { 4530: draftRow({ data: '[1,2]' }) } });
    expect([raw.answers, raw.raw, raw.warnings[0]]).toEqual([[], '[1,2]', 'NO UNDO: draft #4530 is DELETED — everything it holds are gone for good; no screen restores a discarded draft.']);
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${i}`, 'v']));
    const big = await run(discard(), { rows: { 4530: draftRow({ data: JSON.stringify(many) }) } });
    expect([big.answers.length, big.answers_total]).toEqual([40, 45]);
    expect(big.effects).toContain('Answers: the first 40 of 45 are listed.');
  });

  test('an appointment draft: cited by appt_id, named by type, date and client', async () => {
    const c = await run(discard({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 3 }] }),
      { rows: { 4530: draftRow({ form_key: 'appt_prep', link_type: 'appt', link_id: '812' }) } });
    expect(c.record).toEqual({ link_type: 'appt', link_id: '812', label: 'appointment #812 (Consultation, 2026-11-20 14:30 firm time, Dana Debtor)' });
    expect(calls.latest).toEqual([['appt_prep', 'appt', '812']]);
    await refuse(discard(), 'The discard evidence does not identify appt 812 — cite a row carrying its exact appt_id',
      { rows: { 4530: draftRow({ form_key: 'appt_prep', link_type: 'appt', link_id: '812' }) } });
  });
});

describe('the PDF filing', () => {
  test('ids, the filename, evidence', async () => {
    await refuse(pdf({ submission_id: 0 }), 'A PDF filing needs the submission\'s exact positive submission_id');
    await refuse(pdf({ filename: 5 }), '"filename" is the PDF\'s new name, as text');
    await refuse(pdf({ filename: '  ' }), '"filename", when given, is the PDF\'s new name — leave it out for the default');
    await refuse(pdf({ filename: 'a\nb' }), '"filename" cannot hold a line break or a control character');
    await refuse(pdf({ filename: 'x'.repeat(201) }), '"filename" is over 200 characters');
    await refuse(pdf({ evidence: [{ query_id: 'q2', row_number: 1 }] }), 'The PDF evidence does not identify submission #4521');
    expect(calls.getSubmission).toEqual([]);
    // A linked submission's record is cited too.
    await refuse(pdf({ evidence: [{ query_id: 'q1', row_number: 2 }] }), `The PDF evidence does not identify case ${CASE_ID} — cite a row carrying its exact case_id too`);
    expect(calls.render).toBe(0);
  });

  test('refused: gone, a draft, an unknown link type, the route\'s render 404s (before anything is predicted)', async () => {
    await refuse(pdf({ submission_id: 4600, evidence: [{ query_id: 'q1', row_number: 3 }] }), 'Submission #4600 no longer exists');
    await refuse(pdf({ submission_id: 4530, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }),
      'A DRAFT has no PDF: #4530 is a draft — the route renders submitted forms only');
    await refuse(pdf(), 'Submission #4521 is linked to a "bill"', { rows: { 4521: subRow({ link_type: 'bill', link_id: '9' }) } });
    await refuse(pdf(), 'The route cannot render submission #4521: No template exists for form_key "341_notes"',
      { renderFail: Object.assign(new Error('No template exists for form_key "341_notes"'), { status: 404 }) });
    expect(calls.sql.some((q) => q.startsWith('SELECT case_dropbox'))).toBe(false);
  });

  test('a case with a linked folder: the folder from the cache, the default name in FIRM time, no copies, registration, rules, expected', async () => {
    const c = await run(pdf(), { rules: [{ ev: 'document.created', id: 31, name: 'Tag new PDFs' }] });
    // created_at 2026-10-30T03:30Z is 2026-10-29 in Detroit.
    expect([c.file_name, c.filename, c.placement]).toEqual(['2026-10-29 341 Notes (#4521).pdf', null, { rung: 'case', folder: '/active cases/debtor, dana/Forms' }]);
    expect(c.submission).toEqual({ submission_id: 4521, form_key: '341_notes', title: '341 Notes', created_at: '2026-10-30T03:30:00.000Z', version: 3,
      link_type: 'case', link_id: CASE_ID, saved_by: 'the public form (no staff account)' });
    expect(c.record).toEqual({ link_type: 'case', link_id: CASE_ID, label: 'case 25-12345' });
    expect([c.copies, c.warnings, calls.like]).toEqual([{ count: 0, names: [] }, [], '%(#4521)%.pdf']);
    expect(c.effects).toEqual([
      'Copies on file: no active document is named with "(#4521)" (the default name). A copy filed under a custom name, or one the document registry has not picked up, is invisible to this check — filing again would make a second copy.',
      'Lands in: /active cases/debtor, dana/Forms — as "2026-10-29 341 Notes (#4521).pdf" (Dropbox adds " (1)" if that name is taken). If Dropbox cannot open the case\'s folder link, it goes to the unsorted form-submissions bin instead and a task asks staff to move it.',
      'Registered: a document row for the new file, linked to case 25-12345 — it joins that case\'s Documents tab (and, under "Include related", the related contacts\').',
      'What it shows: "341 Notes" as the submitter saw it — the form version the submission was made under; hidden fields are left out.',
      'Trigger rules: the new document emits document.created / document.linked; these active rules listen and MAY run (their conditions are checked on the real file once it exists): #31 "Tag new PDFs" (document.created).',
      'Untouched: the submission and its answers. Casey sends nothing; the route\'s ~4-hour download link is not kept or shown — open the file from Documents or Dropbox.',
    ]);
    expect(calls.rules).toEqual(['document.created', 'document.linked']);
    expect(c.expected).toEqual({ status: 'submitted', link_type: 'case', link_id: CASE_ID, version: 3 });
    // No cache row: the folder is named by what the card knows.
    const nocache = await run(pdf(), { cachePath: null });
    expect(nocache.placement.folder).toBe('the case\'s linked Dropbox folder, subfolder Forms');
  });

  test('ALREADY FILED: copies named with "(#id)" are a danger warning, never a refusal', async () => {
    const c = await run(pdf(), { copies: ['2026-10-29 341 Notes (#4521).pdf', '2026-10-29 341 Notes (#4521) (1).pdf'] });
    expect(c.warnings).toEqual(['ALREADY FILED: a copy named "2026-10-29 341 Notes (#4521).pdf" already sits in Documents (2 active documents named with "(#4521)"); filing again makes a SECOND copy (the route autorenames) — Casey cannot see a copy filed under a custom name.']);
    expect(c.copies).toEqual({ count: 2, names: ['2026-10-29 341 Notes (#4521).pdf', '2026-10-29 341 Notes (#4521) (1).pdf'] });
    expect(c.effects.some((e) => /^Copies on file:/.test(e))).toBe(false);
  });

  test('an override name: sanitized the service\'s way; a name without "(#id)" says a later card cannot see it', async () => {
    const c = await run(pdf({ filename: 'Trustee: notes/2026.PDF' }));
    expect(c.filename).toBe('Trustee: notes/2026.PDF');
    expect(c.file_name).toBe(`${require('../services/formPdfService').sanitizeNameFragment('Trustee: notes/2026', 130)}.pdf`);
    expect(c.file_name).not.toMatch(/[:/]/);
    expect(c.effects).toContain(`Name: your filename replaces the default "<date> 341 Notes (#4521)" — this copy's name carries no "(#4521)", so a later card cannot see it.`);
    // The override's core keeps 130 characters (MAX_NAME_FRAGMENT + 30), not the title's 100.
    const long = await run(pdf({ filename: 'N'.repeat(140) }));
    expect(long.file_name).toBe(`${'N'.repeat(130)}.pdf`);
    const keep = await run(pdf({ filename: 'Notes (#4521)' }));
    expect(keep.effects).toContain('Name: your filename replaces the default "<date> 341 Notes (#4521)".');
  });

  test('the ladder: a case with no folder (created), a gone case (unsorted + task), a contact, an appointment and an unlinked submission (the bin, an identity prefix)', async () => {
    const make = await run(pdf(), { caseDropbox: '' });
    expect(make.placement.rung).toBe('case_create');
    expect(make.warnings).toEqual(['CASE FOLDER CREATED: case 25-12345 has no Dropbox folder linked, so filing CREATES one, links it to the case and raises a task about it — before the PDF lands in its Forms subfolder as "2026-10-29 341 Notes (#4521).pdf". If the case already has a folder nobody linked, the two must be merged by hand.']);
    const gone = await run(pdf({ evidence: [{ query_id: 'q1', row_number: 2 }] }), { rows: { 4521: subRow({ link_id: 'GONE0001' }) } });
    expect([gone.record, gone.placement]).toEqual([null, { rung: 'unsorted_case', folder: '/  Law Office/   Cases/  Unsorted Form Submissions/<case GONE0001 subfolder>' }]);
    expect(gone.warnings[0]).toBe('UNSORTED: case GONE0001 no longer exists, so the PDF goes to the unsorted form-submissions bin (/  Law Office/   Cases/  Unsorted Form Submissions/<case GONE0001 subfolder>) as "2026-10-29 341 Notes (#4521).pdf", and a task asks staff to move it.');
    const contact = await run(pdf({ evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 2 }] }),
      { rows: { 4521: subRow({ link_type: 'contact', link_id: '1309' }) }, bin: '/Bin/Forms\r\n' });
    expect([contact.file_name, contact.placement]).toEqual(['contact 1309 - Debtor, Dana - 2026-10-29 341 Notes (#4521).pdf', { rung: 'unsorted', folder: '/Bin/Forms' }]);
    expect(contact.effects).toContain('Lands in: the unsorted form-submissions bin (/Bin/Forms) as "contact 1309 - Debtor, Dana - 2026-10-29 341 Notes (#4521).pdf" — a contact form has no case folder; no task is raised (the Form Inbox lists these).');
    const appt = await run(pdf({ evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 3 }] }),
      { rows: { 4521: subRow({ form_key: 'appt_prep', link_type: 'appt', link_id: '812' }) } });
    expect([appt.file_name, appt.record.label]).toEqual(['appt 812 - 2026-10-29 Appointment prep (#4521).pdf', 'appointment #812 (Consultation, 2026-11-20 14:30 firm time, Dana Debtor)']);
    expect(appt.effects).toContain('Registered: a document row for the new file, linked to nothing — it shows only on the Documents page (no document links to an appointment).');
    expect(calls.rules).toEqual(['document.created']);
    // The identity prefix is formPdfService._identityPrefix's own guess: the first answer whose key ends in "name" (trustee_name here).
    const loose = await run(pdf({ evidence: [{ query_id: 'q1', row_number: 2 }] }), { rows: { 4521: subRow({ link_type: '', link_id: '' }) } });
    expect([loose.record, loose.file_name, loose.expected]).toEqual([null, 'submission 4521 - Jane Trustee - 2026-10-29 341 Notes (#4521).pdf', { status: 'submitted', link_type: '', link_id: '', version: 3 }]);
  });

  test('a submission whose form version is gone: the current form, answers to removed fields not printed', async () => {
    const c = await run(pdf(), { render: { submission: subRow(), title: '341 Notes', definition: DEF, schema_matched: false } });
    expect(c.effects).toContain('What it shows: "341 Notes" as the submitter saw it — the form version the submission was made under; that version is gone, so the CURRENT form is used and answers to removed fields are not printed; hidden fields are left out.');
  });
});

describe('appointment records on the A12 cards', () => {
  test('a draft of an appointment form: cited by appt_id, the record named, where it shows', async () => {
    const c = await run({ kind: 'form.draft.v1', form_key: 'appt_prep', link_type: 'appt', link_id: 812, data: { trustee_name: 'X' },
      evidence: [{ query_id: 'q2', row_number: 3 }] }, { latest: { draft: null, submitted: null } });
    expect(c.record).toEqual({ link_type: 'appt', link_id: '812', label: 'appointment #812 (Consultation, 2026-11-20 14:30 firm time, Dana Debtor)' });
    expect(c.effects).toContain('Where it shows: wherever this form opens for this appointment (a custom view\'s form button, or the form builder\'s Live tab), a banner says there is an unsaved draft, with Restore and Discard. Nothing on the form changes until someone clicks Restore; Discard deletes the draft, and saving the form deletes it too.');
    await refuse({ kind: 'form.draft.v1', form_key: 'appt_prep', link_type: 'appt', link_id: 812, data: { trustee_name: 'X' }, evidence: [{ query_id: 'q2', row_number: 1 }] },
      'The draft evidence does not identify appt 812 — cite a row carrying its exact appt_id (read the appointment first)');
    await refuse({ kind: 'form.draft.v1', form_key: 'appt_prep', link_type: 'appt', link_id: 813, data: { trustee_name: 'X' }, evidence: [{ query_id: 'q2', row_number: 3 }] },
      'The draft evidence does not identify appt 813');
    await refuse({ kind: 'form.draft.v1', form_key: '341_notes', link_type: 'appt', link_id: 812, data: { trustee_name: 'X' }, evidence: [{ query_id: 'q2', row_number: 3 }] },
      '"341 Notes" is a case-linked form — its draft belongs to a case, not a appt', {}, [...EVIDENCE, { id: 'q4', kind: 'form.template', rows: [{ row_type: 'template', form_key: '341_notes' }] }]);
  });

  test('a submission linked to an appointment: the identity check is against the appointment\'s client', async () => {
    const c = await run({ kind: 'form.submission.link.v1', submission_id: 4521, link_type: 'appt', link_id: 812,
      evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 3 }] }, { rows: { 4521: subRow({ form_key: 'appt_prep', link_type: '', link_id: '' }) } });
    expect(c.target.label).toBe('appointment #812 (Consultation, 2026-11-20 14:30 firm time, Dana Debtor)');
    expect([c.identity, c.warnings]).toEqual([[{ answer: 'name', value: 'Dana Debtor', matched: 'Dana Q. Debtor' }], []]);
    expect(c.effects.find((e) => /^Log:/.test(e))).toContain('was linked to this appt from the Form Inbox.');
    expect(c.effects.some((e) => /^Pipeline steps:|^Intake gate:/.test(e))).toBe(false);
  });

  test('a gone appointment', async () => {
    await refuse({ kind: 'form.draft.v1', form_key: 'appt_prep', link_type: 'appt', link_id: 812, data: { trustee_name: 'X' }, evidence: [{ query_id: 'q2', row_number: 3 }] },
      /^Appointment 812 no longer exists$/, { record: false, latest: { draft: null, submitted: null } });
  });
});

describe('the ledger and the request detector', () => {
  test('both receipt the reviewed form_submissions row', () => {
    expect([ledger.KINDS.get('form.draft.delete.v1'), ledger.KINDS.get('form.pdf.file.v1')]).toEqual(['submission_id', 'submission_id']);
  });
  test.each([
    'discard the draft of the 341 notes form for the Smith case',
    'delete that intake form draft',
    'file the PDF of submission 4521',
    'make a pdf of her intake form and put it in dropbox',
  ])('a discard / PDF request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['Is there a PDF of the intake form?', 'Which forms have drafts?'])('a question does not: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(false);
  });
});

// ── The browser half, lifted from public/assistant.html by name ────────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function constSrc(name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
function familySrc(id) {
  const at = html.indexOf(`id: '${id}'`);
  if (at < 0) throw new Error(`family ${id} not found`);
  const open = html.lastIndexOf('\n  {', at) + 3;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`family ${id} unbalanced`);
}
const FNS = ['formCanonical', 'formDataHash', 'formIso', 'formRecordLabel', 'formLabel', 'formTitle', 'formText', 'formRecordPath', 'formEntity', 'formOpen',
  'formDiscardRequest', 'formDiscardPrecheck', 'formDiscardResult', 'formDiscardKnownOutcome',
  'formPdfRequest', 'formPdfPrecheck', 'formPdfResult', 'formPdfKnownOutcome', 'formPdfAppliedMessage'];
const CONSTS = ['FORM_DISCARD_ACTION_KINDS', 'FORM_PDF_ACTION_KINDS', 'FORM_PDF_PLACEMENTS', 'FORM_PDF_WARNINGS_KEPT'];
function browser(api, deps = {}) {
  const src = [...CONSTS.map(constSrc), ...FNS.map(fnSrc),
    `const families = [${familySrc('form_discard')}, ${familySrc('form_pdf')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  return new Function('api', 'openEntity', 'crypto', 'TextEncoder', src)(api, deps.openEntity || jest.fn(), crypto.webcrypto, TextEncoder); // eslint-disable-line no-new-func
}

describe('the browser: fixed requests, the re-reads, result checks, outcomes, danger, text, entity', () => {
  let dCase; let dAppt; let pCase; let pLoose; let pNamed;
  beforeAll(async () => {
    const mk = async (value, opts) => {
      const card = JSON.parse(JSON.stringify(await normalizeActionDraft(setup(opts), value, EVIDENCE, { currentUserId: ME })));
      spies.forEach((s) => s.mockRestore()); spies = [];
      return card;
    };
    dCase = await mk(discard());
    dAppt = await mk(discard({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 3 }] }), { rows: { 4530: draftRow({ form_key: 'appt_prep', link_type: 'appt', link_id: '812' }) } });
    pCase = await mk(pdf());
    pLoose = await mk(pdf({ evidence: [{ query_id: 'q1', row_number: 2 }] }), { rows: { 4521: subRow({ link_type: '', link_id: '' }) } });
    pNamed = await mk(pdf({ filename: 'Trustee notes' }));
  });

  test('the requests: the DELETE built from the stored draft row; the POST with the reviewed name or no body', () => {
    const b = browser(jest.fn());
    expect(b.formDiscardRequest({ ...dCase, form_key: 'evil', link_id: 'X' })).toEqual({ path: `/api/forms/draft?form_key=341_notes&link_type=case&link_id=${CASE_ID}`, method: 'DELETE', body: null });
    expect(b.formDiscardRequest(dAppt).path).toBe('/api/forms/draft?form_key=appt_prep&link_type=appt&link_id=812');
    expect(() => b.formDiscardRequest({ ...dCase, draft: { ...dCase.draft, submission_id: 0 } })).toThrow('This card has no usable draft id.');
    expect(() => b.formDiscardRequest({ ...dCase, draft: { ...dCase.draft, form_key: 'a b' } })).toThrow('This card has no usable form.');
    expect(() => b.formDiscardRequest({ ...dCase, draft: { ...dCase.draft, link_type: 'bill' } })).toThrow('This card has no usable record.');
    expect(() => b.formDiscardRequest({ ...dAppt, draft: { ...dAppt.draft, link_id: '81x' } })).toThrow('This card has no usable record.');
    expect(b.formPdfRequest({ ...pCase, again: true })).toEqual({ path: '/api/forms/submissions/4521/pdf/file', method: 'POST', body: null });
    expect(b.formPdfRequest(pNamed)).toEqual({ path: '/api/forms/submissions/4521/pdf/file', method: 'POST', body: { filename: 'Trustee notes' } });
    expect(() => b.formPdfRequest({ ...pCase, submission: { submission_id: 'x' } })).toThrow('This card has no usable submission id.');
    expect(() => b.formPdfRequest({ ...pCase, filename: ' ' })).toThrow('This card has no usable file name.');
  });

  // The two GETs as the routes answer them.
  function reads({ record = true, draft, sub, fail = false } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      if (/^\/api\/(cases|contacts|appts)\//.test(p)) {
        if (!record) throw Object.assign(new Error('not found'), { status: 404 });
        return { status: 'success' };
      }
      if (p.startsWith('/api/forms/latest?')) return { status: 'success', submitted: null, draft: draft === undefined ? { id: 4530, data: DRAFT_DATA, updated_at: UPDATED.toISOString(), user_name: 'Fred' } : draft };
      if (p.startsWith('/api/forms/submissions/')) {
        if (sub === null) throw Object.assign(new Error('Submission 4521 not found'), { status: 404 });
        return { status: 'success', submission: { id: 4521, status: 'submitted', link_type: 'case', link_id: CASE_ID, version: 3, ...(sub || {}) } };
      }
      throw new Error(`unexpected GET ${p}`);
    });
    return { api, gets };
  }

  test('the discard re-read: the record, then the draft — the same row, updated_at and data hash (key order ignored)', async () => {
    let r = reads();
    expect(await browser(r.api).formDiscardPrecheck(dCase)).toBe('');
    expect(r.gets).toEqual([`/api/cases/${CASE_ID}`, `/api/forms/latest?form_key=341_notes&link_type=case&link_id=${CASE_ID}`]);
    r = reads({ draft: { id: 4530, data: JSON.stringify(Object.fromEntries(Object.entries(DRAFT_DATA).reverse())), updated_at: UPDATED.toISOString() } });
    expect(await browser(r.api).formDiscardPrecheck(dCase)).toBe('');
    r = reads();
    expect(await browser(r.api).formDiscardPrecheck(dAppt)).toBe('');
    expect(r.gets[0]).toBe('/api/appts/812');
    const cases = [
      [reads({ record: false }), 'case 25-12345 no longer exists. Nothing was deleted.'],
      [reads({ draft: null }), 'The draft of "341 Notes" for case 25-12345 is already gone — discarded or submitted since this card was prepared. Nothing was deleted.'],
      [reads({ draft: { id: 4530, data: { ...DRAFT_DATA, notes: 'typed' }, updated_at: UPDATED.toISOString(), user_name: 'Stuart' } }), /^The draft of "341 Notes" for case 25-12345 changed since this card was prepared \(someone saved it — last by Stuart\)\. Nothing was deleted/],
      [reads({ draft: { id: 4530, data: DRAFT_DATA, updated_at: '2026-11-01T10:00:01.000Z' } }), /changed since this card was prepared/],
      [reads({ draft: { id: 4999, data: DRAFT_DATA, updated_at: UPDATED.toISOString() } }), /changed since this card was prepared/],
    ];
    for (const [rr, want] of cases) {
      const got = await browser(rr.api).formDiscardPrecheck(dCase);
      if (want instanceof RegExp) expect(got).toMatch(want); else expect(got).toBe(want);
    }
    await expect(browser(reads({ fail: true }).api).formDiscardPrecheck(dCase)).rejects.toThrow('boom');
  });

  test('the discard result: deleted:true is the receipt; deleted:false is a refusal (nothing was there); anything else throws', () => {
    const b = browser(jest.fn());
    expect(b.formDiscardResult(dCase, { status: 'success', deleted: true })).toEqual({ submission_id: 4530 });
    let err;
    try { b.formDiscardResult(dCase, { status: 'success', deleted: false }); } catch (e) { err = e; }
    expect(err.formDiscardNone).toBe(true);
    expect(b.formDiscardKnownOutcome(err)).toEqual({ status: 'Refused — nothing deleted', text: 'Refused — nothing deleted: the draft was already gone when the discard reached the server (discarded or submitted a moment before). Ask Casey to read the form again.' });
    expect(() => b.formDiscardResult(dCase, { status: 'success' })).toThrow('The forms route did not confirm the discard');
    expect(b.formDiscardKnownOutcome(Object.assign(new Error('x'), { status: 400 }))).toBe(null);
  });

  test('the PDF re-read: the record (when linked) and the submission\'s status / link / version', async () => {
    let r = reads();
    expect(await browser(r.api).formPdfPrecheck(pCase)).toBe('');
    expect(r.gets).toEqual([`/api/cases/${CASE_ID}`, '/api/forms/submissions/4521']);
    r = reads({ sub: { link_type: '', link_id: '' } });
    expect(await browser(r.api).formPdfPrecheck(pLoose)).toBe('');
    expect(r.gets).toEqual(['/api/forms/submissions/4521']);
    expect(await browser(reads({ record: false }).api).formPdfPrecheck(pCase)).toBe('case 25-12345 no longer exists. Nothing was filed.');
    expect(await browser(reads({ sub: null }).api).formPdfPrecheck(pCase)).toBe('Submission #4521 no longer exists. Nothing was filed.');
    expect(await browser(reads({ sub: { link_type: 'case', link_id: CASE_ID } }).api).formPdfPrecheck(pLoose))
      .toBe('Submission #4521 changed since this card was prepared (it was linked — the PDF would land somewhere else). Nothing was filed. Ask Casey to prepare it again.');
    expect(await browser(reads({ sub: { version: 4 } }).api).formPdfPrecheck(pCase))
      .toBe('Submission #4521 changed since this card was prepared (its status or version). Nothing was filed. Ask Casey to prepare it again.');
  });

  test('the PDF result: the verdict kept for the applied copy WITHOUT its temporary link; a verdict that names nowhere throws', () => {
    const b = browser(jest.fn());
    const draft = JSON.parse(JSON.stringify(pCase));
    const verdict = { status: 'success', submission_id: 4521, form_key: '341_notes', path: '/Active Cases/Debtor, Dana/Forms/2026-10-29 341 Notes (#4521) (1).pdf',
      file_name: '2026-10-29 341 Notes (#4521) (1).pdf', placement: 'case', temp_link: 'https://dl.dropboxusercontent.com/secret', document_id: 77, warnings: ['w1'] };
    expect(b.formPdfResult(draft, verdict)).toEqual({ submission_id: 4521 });
    expect(draft.pdf_outcome).toEqual({ path: verdict.path, file_name: verdict.file_name, placement: 'case', document_id: 77, warnings: ['w1'] });
    expect(JSON.stringify(draft)).not.toContain('secret');
    expect(b.formPdfAppliedMessage(draft, { submission_id: 4521 }, false)).toBe('File form PDF to Dropbox applied to submission #4521: filed as "2026-10-29 341 Notes (#4521) (1).pdf" at /Active Cases/Debtor, Dana/Forms/2026-10-29 341 Notes (#4521) (1).pdf (the case folder), document #77. Notes: w1.');
    const noDoc = JSON.parse(JSON.stringify(pCase));
    b.formPdfResult(noDoc, { ...verdict, document_id: null, placement: 'unsorted', warnings: undefined });
    expect(b.formPdfAppliedMessage(noDoc, { submission_id: 4521 }, false)).toContain('(the unsorted form-submissions folder), not yet in the document registry (the sync picks it up).');
    expect(() => b.formPdfResult(draft, { ...verdict, submission_id: 1 })).toThrow('The forms route did not confirm the submission');
    expect(() => b.formPdfResult(draft, { ...verdict, path: '' })).toThrow('The forms route did not confirm where the PDF was filed');
    expect(() => b.formPdfResult(draft, { ...verdict, placement: 'elsewhere' })).toThrow('The forms route did not confirm where the PDF was filed');
  });

  test('the PDF outcomes: the 404s and the draft render refusal are refusals; an upload failure stays ambiguous', () => {
    const b = browser(jest.fn());
    const err = (status, message) => Object.assign(new Error(message), { status, body: { message } });
    expect(b.formPdfKnownOutcome(err(404, 'Submission 4521 not found'))).toEqual({ status: 'Refused — nothing filed', text: 'Refused — nothing filed: Submission 4521 not found. Ask Casey to read it again.' });
    expect(b.formPdfKnownOutcome(err(404, 'No template exists for form_key "x"')).status).toBe('Refused — nothing filed');
    expect(b.formPdfKnownOutcome(err(404, 'No published definition available for form_key "x"')).status).toBe('Refused — nothing filed');
    expect(b.formPdfKnownOutcome(err(500, 'submission 4521 is a draft — only submitted forms can be rendered')).status).toBe('Refused — nothing filed');
    expect(b.formPdfKnownOutcome(err(500, 'could not upload the form PDF to Dropbox (/x): boom'))).toBe(null);
    expect(b.formPdfKnownOutcome(err(404, 'Something else not found'))).toBe(null);
    expect(b.formPdfKnownOutcome({ status: 404, body: { idempotency: {}, message: 'Submission 1 not found' } })).toBe(null);
  });

  test('the families: always danger, receipts, applied copy, entity (an appointment; an unlinked PDF points at Documents)', () => {
    const open = jest.fn();
    const b = browser(jest.fn(), { openEntity: open });
    const [fx, fp] = b.families;
    expect([fx.danger({ warnings: [] }), fp.danger({ warnings: [] })]).toEqual([true, true]);
    expect([fx.idField, fx.appliedKey, fp.idField, fp.appliedKey]).toEqual(['submission_id', 'result_form_discard_id', 'submission_id', 'result_form_pdf_id']);
    expect(fx.appliedCopy({ ...dCase, result_form_discard_id: 4530 }).status).toBe('Applied — draft #4530 discarded');
    expect(fp.appliedCopy({ ...pCase, result_form_pdf_id: 4521 }).warning).toContain('Applying another card files another copy.');
    expect(b.formEntity(dAppt)).toEqual({ kind: 'appointment', id: '812', label: 'appointment #812 (Consultation, 2026-11-20 14:30 firm time, Dana Debtor)' });
    expect(b.formEntity(pLoose)).toEqual({ kind: 'document', id: '4521', label: 'submission 4521 - Jane Trustee - 2026-10-29 341 Notes (#4521).pdf' });
    expect(b.formEntity(pCase)).toEqual({ kind: 'case', id: CASE_ID, label: '25-12345' });
    b.formOpen(dAppt);
    expect(open).toHaveBeenCalledWith('appointment', '812', 'appointment #812 (Consultation, 2026-11-20 14:30 firm time, Dana Debtor)');
    expect(b.formRecordPath('appt', '812')).toBe('/api/appts/812');
  });

  test('the card text: every answer, the warnings and effects, what it writes; the PDF\'s folder, name and copies', () => {
    const b = browser(jest.fn());
    const t = b.formText(dCase).split('\n');
    expect(t.slice(0, 7)).toEqual(['Form draft discard proposal — not applied', 'Action: Discard form draft', 'Form: "341 Notes" (341_notes, a case form)',
      'Record: case 25-12345', 'Draft: #4530, saved by you at 2026-11-01 10:00 UTC — deleted', 'Answers in it: 5 (4 filled in)',
      'Latest submission: version 2 (#4400, 2026-10-20 00:00 UTC) — untouched']);
    expect(t).toContain('Answer: Trustee (trustee_name): "Jane Trustee"');
    expect(t).toContain('Answer: stale_key (stale_key): "old" — not on the current form');
    expect(t).toContain(`Warning: ${dCase.warnings[0]}`);
    expect(t).toContain('Writes: the one draft row is deleted — no submission, no record field and no other form is touched.');
    const p = b.formText(pCase).split('\n');
    expect(p.slice(0, 7)).toEqual(['Form PDF filing proposal — not applied', 'Action: File form PDF to Dropbox',
      'Submission: #4521 "341 Notes" (341_notes), version 3, received 2026-10-30 03:30 UTC by the public form (no staff account)', 'Record: case 25-12345',
      'File name: 2026-10-29 341 Notes (#4521).pdf (the default)', 'Folder: /active cases/debtor, dana/Forms', 'Copies already on file: 0']);
    expect(p).toContain('Writes: a NEW PDF file in Dropbox and its document row — every filing makes another copy; nothing on the submission changes.');
    expect(b.formText(pNamed)).toContain('File name: Trustee notes.pdf (your name)');
    expect(b.formText(pLoose)).toContain('Record: no record (unlinked)');
  });
});
