'use strict';
/**
 * tests/caseyFormSubmit.test.js
 *
 * A12.3 — Casey submits ONE stored form draft through a reviewed card on the
 * form page's own Submit, run server-side:
 *   form.submit.v1 → POST /api/forms/submissions/submit-draft {submission_id, expected_updated_at}
 * (services/formSubmitService.js — validate, PATCH the record's apiColumn diff,
 * record the submission, delete the draft, start the onSubmit workflows, log).
 *
 * The contract pinned here:
 *   1. the casey_forms_enabled switch covers the kind; the by-name and
 *      unknown-key refusals run before anything is read, and the "other form
 *      operations" sentence names the submit card (no deferral sentence left);
 *   2. the refusals the route would answer, by name, before the click: not a
 *      draft, no record / a gone record, no longer the draft, no published
 *      template, another link type, another schema_version (both named), a
 *      non-object payload, a patch / load URL the route refuses (422), a docket
 *      the route's guard refuses, a gone patch record;
 *   3. EVERY failing answer named by label (the route's validator stops at the
 *      first; the card loops it with the failing declaration relaxed in a deep
 *      clone): three at once, a repeater by its key, an unknown key;
 *   4. the card: the diff is formSubmitService's own (the columns equal its
 *      payload), before → after per column, A7's portal readers and the
 *      CLIENT-VISIBLE warning, the server re-resolved links, the workflows
 *      (WILL NOT START for an inactive / unpublished / missing one), the
 *      trigger dry-runs (case.updated / contact.updated, then form.submitted),
 *      the draft consumed, the log entry, the pipeline steps, NO UNDO, expected;
 *   5. the ledger receipt and the request detector;
 *   6. the browser half (lifted from public/assistant.html by name): the fixed
 *      request, the click-time re-reads, the result check and outcome, the 400
 *      fields outcome, the family (always danger, refusal409), the card text.
 *
 * The route itself, driven by the card's own request on a real engine, is in
 * tests/caseyFormSubmit.mysql.test.js.
 *
 *   npx jest tests/caseyFormSubmit.test.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const formService = require(path.join(REPO, 'services', 'formService'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const contactService = require(path.join(REPO, 'services', 'contactService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const formSubmitService = require(path.join(REPO, 'services', 'formSubmitService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const ME = 6;
const DEF = {
  dataMode: 'live',
  endpoints: { load: { method: 'GET', url: '/api/cases/{linkId}', path: 'case' } },
  onSubmit: { patch: { method: 'PATCH', url: '/api/cases/{linkId}' }, workflows: [{ id: 41, initData: { notify_to: 'ops' } }, { id: 42 }], pdf: true },
  sections: [
    { rows: [{ fields: [
      { name: 'trustee', label: 'Trustee', type: 'text', apiColumn: 'case_trustee', required: true },
      { name: 'chapter', label: 'Chapter', type: 'select', apiColumn: 'case_chapter', options: ['7', '13'] },
      { name: 'debts', label: 'Debts', type: 'number', min: 0 },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ] }] },
    { repeater: 'creditors', fields: [{ name: 'creditor', type: 'text', required: true }] },
  ],
};
const TPL = { id: 3, form_key: 'case_sheet', title: 'Case Sheet', link_type: 'case', schema_version: 4, visibility: 'internal', published_at: new Date('2026-10-01T00:00:00Z'), definition: JSON.stringify(DEF) };
const CONTACT_DEF = {
  endpoints: { load: { method: 'GET', url: '/api/contacts/{linkId}', path: 'contact' } },
  onSubmit: { patch: { method: 'PATCH', url: '/api/contacts/{linkId}' } },
  sections: [{ rows: [{ fields: [{ name: 'email', label: 'Email', type: 'text', apiColumn: 'contact_email' }] }] }],
};
const CONTACT_TPL = { ...TPL, id: 7, form_key: 'contact_sheet', title: 'Contact Sheet', link_type: 'contact', schema_version: 1, definition: JSON.stringify(CONTACT_DEF) };
const BARE_DEF = { sections: [{ rows: [{ fields: [{ name: 'trustee', label: 'Trustee', type: 'text', required: true }] }] }] };
const BARE_TPL = { ...TPL, id: 8, form_key: 'bare', title: 'Bare', definition: JSON.stringify(BARE_DEF) };

const EVIDENCE = [
  { id: 'q1', kind: 'sql.read', purpose: 'form rows', rows: [{ submission_id: 4530 }, { submission_id: 4521 }, { submission_id: 4600 }, { submission_id: 4700 }] },
  { id: 'q2', kind: 'sql.read', purpose: 'records', rows: [{ case_id: CASE_ID }, { contact_id: 1309 }] },
];
const DRAFT_DATA = { trustee: 'Nina Newtrustee', chapter: '13', debts: '5000', notes: 'called', creditors: [{ creditor: 'Bank' }] };
const UPDATED = new Date('2026-11-01T10:00:00Z');
const CASE_ROW = { case_id: CASE_ID, case_number: '25-12345', case_number_full: null, case_type: 'Bankruptcy', case_trustee: 'Tom Trustee', case_chapter: '7',
  case_file_date: new Date('2026-01-05T00:00:00Z'), custom: '{}' };
const draftRow = (over = {}) => ({ id: 4530, form_key: 'case_sheet', link_type: 'case', link_id: CASE_ID, status: 'draft', version: 0, schema_version: 4,
  data: JSON.stringify(DRAFT_DATA), submitted_by: ME, user_name: 'Fred', created_at: UPDATED, updated_at: UPDATED, ...over });
const subRow = (over = {}) => ({ id: 4521, form_key: 'case_sheet', link_type: 'case', link_id: CASE_ID, status: 'submitted', version: 3, schema_version: 4,
  data: {}, submitted_by: 2, user_name: 'Stuart', created_at: UPDATED, updated_at: UPDATED, ...over });

let spies = [];
let calls;
function setup({ tpls = { case_sheet: TPL, contact_sheet: CONTACT_TPL, bare: BARE_TPL }, rows = {}, latest, caseRow = CASE_ROW, contactRow, record = true,
  workflows = [{ id: 41, name: 'Notify ops', description: 'Emails ops', active: 1, current_version: 2 }, { id: 42, name: 'Old flow', description: null, active: 0, current_version: 1 }],
  rules = [], matched = [], docketRefusal = null, maxVersion = 3, reqs = [] } = {}) {
  calls = { getSubmission: [], latest: [], getCase: [], sql: [], rules: [], evaluated: [] };
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
      return { draft: d ? { ...d } : null, submitted: { id: 4521, version: 3, data: {}, updated_at: UPDATED, submitted_by: 2, user_name: 'Stuart' } };
    }),
    jest.spyOn(caseService, 'getCase').mockImplementation(async (_db, id) => {
      calls.getCase.push(String(id));
      return caseRow && String(id) === CASE_ID ? { case: { ...caseRow }, clients: [{ contact_name: 'Dana Debtor', relate_type: 'Primary' }] } : null;
    }),
    jest.spyOn(contactService, 'getContact').mockImplementation(async (_db, id) => (contactRow && Number(id) === 1309 ? { contact: { ...contactRow } } : null)),
    jest.spyOn(caseService, 'docketWriteRefusal').mockImplementation(async () => docketRefusal),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules.filter((r) => r.ev === ev); }),
    jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (rule, env) => { calls.evaluated.push([rule.id, env.event, env]); return { matched: matched.includes(rule.id) }; }),
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
    if (flat.startsWith('SELECT COALESCE(MAX(version), 0) AS max_version FROM form_submissions')) return [[{ max_version: maxVersion }]];
    if (flat === 'SELECT id, name, description, active, current_version FROM workflows WHERE id IN (?)') {
      calls.wfIds = params[0];
      return [workflows.filter((w) => params[0].includes(w.id))];
    }
    if (flat.startsWith('SELECT internal_label FROM pipeline_stage_requirements')) return [reqs.map((l) => ({ internal_label: l }))];
    if (flat.startsWith('SELECT COUNT(*) AS n FROM events') || flat.startsWith('SELECT COUNT(*) AS n FROM log')) return [[{ n: 0 }]];
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_FORMS_ENABLED; });

const submit = (over = {}) => ({ kind: 'form.submit.v1', submission_id: 4530,
  evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }], ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: ME });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);
const withDef = (def, over = {}) => ({ tpls: { case_sheet: { ...TPL, definition: JSON.stringify(def) } }, ...over });

describe('the switch and the by-name refusals', () => {
  test("'0' makes the submit kind unavailable; unset is ON", async () => {
    process.env.CASEY_FORMS_ENABLED = '0';
    await refuse(submit(), /^Action kind is unavailable$/);
    expect(calls.sql).toEqual([]);
    delete process.env.CASEY_FORMS_ENABLED;
    await expect(run(submit())).resolves.toMatchObject({ kind: 'form.submit.v1', status: 'draft' });
  });

  test('the route-owned columns, another operation and unknown keys, before any read; the sentence names the submit card', async () => {
    await refuse(submit({ status: 'submitted' }), /^RESERVED FIELDS refused \(status\): a submit card names the draft row by submission_id/);
    await refuse(submit({ publish: true }), /^OTHER FORM OPERATIONS refused \(publish\): each form card does ONE thing — .* or submit ONE stored draft \(form\.submit\.v1\)\. Publishing a template, changing its visibility, restoring a version into its draft and deleting a never-published template are the template cards/);
    await refuse(submit({ data: { trustee: 'X' } }), /^A form submit card carries unsupported fields: data — it takes submission_id \(the DRAFT row\) and evidence only$/);
    await refuse(submit({ form_key: 'case_sheet' }), /carries unsupported fields: form_key/);
    expect([calls.sql, calls.getSubmission, calls.latest]).toEqual([[], [], []]);
    // The other form cards no longer carry a deferral: they name the submit card too.
    await expect(run({ kind: 'form.draft.delete.v1', submission_id: 4530, submit: true, evidence: [] })).rejects.toThrow(/or submit ONE stored draft \(form\.submit\.v1\)/);
    await expect(run({ kind: 'form.draft.delete.v1', submission_id: 4530, submit: true, evidence: [] })).rejects.not.toThrow(/not available to Casey: there is no atomic route/);
  });
});

describe('the route\'s refusals, by name, before the click', () => {
  test('ids and evidence: the DRAFT row AND its record, before the route-shaped reads', async () => {
    await refuse(submit({ submission_id: 0 }), 'A form submit needs the DRAFT row\'s exact positive submission_id');
    await refuse(submit({ evidence: [{ query_id: 'q2', row_number: 1 }] }), 'The submit evidence does not identify draft #4530');
    expect(calls.getSubmission).toEqual([]);
    await refuse(submit({ evidence: [{ query_id: 'q1', row_number: 1 }] }), `The submit evidence does not identify case ${CASE_ID} — cite a row carrying its exact case_id`);
  });

  test('gone, already submitted, no record, a gone record, no longer the draft', async () => {
    await refuse(submit({ submission_id: 4600, evidence: [{ query_id: 'q1', row_number: 3 }] }), 'Draft #4600 no longer exists');
    await refuse(submit({ submission_id: 4521, evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 1 }] }),
      '#4521 is already SUBMITTED (version 3) — only a stored draft can be submitted (the route answers "Submission 4521 is not a draft")');
    await refuse(submit(), 'Draft #4530 belongs to no record', { rows: { 4530: draftRow({ link_type: '', link_id: '' }) } });
    await refuse(submit(), `Case ${CASE_ID} no longer exists — no form page opens this draft`, { record: false });
    await refuse(submit(), 'Draft #4530 is no longer the draft of this form and record', { latest: { draft: null, submitted: null } });
    await refuse(submit(), 'Draft #4530 is no longer the draft of this form and record', { latest: { draft: draftRow({ id: 4999 }), submitted: null } });
  });

  test('the template: unpublished / none, another link type, another schema_version (both named), a non-object payload', async () => {
    await refuse(submit(), /^No published template for form_key "case_sheet" — the route refuses the submit \(404\): it has no template/, { tpls: {} });
    await refuse(submit(), /^No published template for form_key "case_sheet" — .*"Case Sheet" has never been published/, { tpls: { case_sheet: { ...TPL, definition: null } } });
    await refuse(submit(), '"Case Sheet" is a contact-linked form — draft #4530 is linked to a case; the route refuses the submit (409)', { tpls: { case_sheet: { ...TPL, link_type: 'contact' } } });
    await refuse(submit(), /^OLD FORM VERSION refused: draft #4530 was saved on version 3 of "Case Sheet"; the published form is version 4\. The route refuses it \(409\)/,
      { rows: { 4530: draftRow({ schema_version: 3 }) } });
    await refuse(submit(), 'Draft #4530 does not hold a JSON object — the route refuses it (422)', { rows: { 4530: draftRow({ data: '[1,2]' }) } });
  });

  test('a patch or load URL the route cannot apply → the route\'s own 422 message, before anything is read from the record', async () => {
    await refuse(submit(), /^This form's onSubmit\.patch \(PATCH \/api\/appts\/\{linkId\}\) is not one the server can apply — .* — the route refuses the submit \(422\) before anything is written/,
      withDef({ ...DEF, onSubmit: { patch: { method: 'PATCH', url: '/api/appts/{linkId}' } } }));
    await refuse(submit(), /^This form's endpoints\.load \(GET \/api\/tasks\?case=\{linkId\}\) is not one the server can read — .* — the route refuses the submit \(422\)/,
      withDef({ ...DEF, endpoints: { load: { method: 'GET', url: '/api/tasks?case={linkId}' } } }));
    expect(calls.getCase).toEqual([]);
  });

  test('the docket guard the route runs refuses with its own message; a gone patch record refuses', async () => {
    const docketDef = { ...DEF, sections: [{ rows: [{ fields: [{ name: 'number', label: 'Number', type: 'text', apiColumn: 'case_number' }] }] }] };
    await refuse(submit(), /^DOCKET refused — Case number "25-99999" already belongs to case B\. The route refuses the submit \(409\) before anything is written$/,
      withDef(docketDef, { rows: { 4530: draftRow({ data: JSON.stringify({ number: '25-99999' }) }) }, docketRefusal: { status: 409, message: 'Case number "25-99999" already belongs to case B.' } }));
    await refuse(submit(), `The case this form writes to (case ${CASE_ID}) no longer exists`, { caseRow: null });
  });
});

describe('EVERY failing answer, by the route\'s validator looped', () => {
  test('three failures at once — all three labels; the route would name only the first', async () => {
    const bad = { trustee: '  ', chapter: '11', debts: '-5', notes: '', creditors: [{ creditor: 'Bank' }] };
    const opts = { rows: { 4530: draftRow({ data: JSON.stringify(bad) }) } };
    let err;
    try { await run(submit(), opts); } catch (e) { err = e; }
    expect(err.message).toMatch(/^ANSWERS REFUSED: the route validates the draft against the published "Case Sheet" and would refuse it \(400\) — /);
    expect(err.message).toContain('"Trustee" (trustee): is required');
    expect(err.message).toContain('"Chapter" (chapter): value is not one of the allowed options');
    expect(err.message).toContain('"Debts" (debts): is below minimum 0');
    expect(err.message).toMatch(/Nothing is proposed — fill them in first/);
    // The route's own validator, unlooped, names only the first of them.
    expect(() => require('../services/extFormService').validateValues(DEF, bad)).toThrow(/^values\.trustee is required$/);
  });

  test('a repeater failure by the repeater\'s key; an unknown key; a non-scalar value', async () => {
    const bad = { trustee: { x: 1 }, creditors: [{ creditor: '' }, { nope: 'x' }], stray: 'y' };
    let err;
    try { await run(submit(), { rows: { 4530: draftRow({ data: JSON.stringify(bad) }) } }); } catch (e) { err = e; }
    expect(err.message).toContain('"stray" (stray): is not a field of this form');
    expect(err.message).toContain('"Trustee" (trustee): must be a scalar value');
    expect(err.message).toContain('"creditors" (creditors): creditors[1].nope is not a field of this repeater');
  });

  test('neither the stored answers nor the definition is mutated by the loop (it runs on deep clones)', async () => {
    // mysql2 hands JSON columns back PARSED: the template's definition and the
    // draft's data arrive as objects the normalizer must not touch.
    const bad = { trustee: '', chapter: '11', debts: '1', notes: '', creditors: [], stray: { x: 1 } };
    const row = draftRow({ data: bad });
    const def = JSON.parse(JSON.stringify(DEF));
    await expect(run(submit(), { rows: { 4530: row }, tpls: { case_sheet: { ...TPL, definition: def } } })).rejects.toThrow(/ANSWERS REFUSED/);
    expect(row.data).toEqual({ trustee: '', chapter: '11', debts: '1', notes: '', creditors: [], stray: { x: 1 } });
    expect(def).toEqual(DEF);
  });
});

describe('the card', () => {
  test('the patch is formSubmitService\'s own diff; before → after; readers; workflows; dry-runs; consumed draft; log; expected', async () => {
    const rules = [{ id: 11, ev: 'case.updated', name: 'Trustee changed', actions: [] }, { id: 12, ev: 'form.submitted', name: 'Sheet in', actions: [] },
      { id: 13, ev: 'form.submitted', name: 'Quiet', actions: [] }];
    const c = await run(submit(), { rules, matched: [11, 12], reqs: ['Case sheet in'] });
    // The route's helper over the same baseline gives exactly these columns.
    const base = await formSubmitService.resolveBase({ query: async () => { throw new Error('no sql'); } }, DEF, { formKey: 'case_sheet', linkType: 'case', linkId: CASE_ID });
    const { payload } = formSubmitService.computeDiffAndPatch(DEF, base, DRAFT_DATA);
    expect(Object.keys(payload).sort()).toEqual(['case_chapter', 'case_trustee']);
    expect(c.patch.columns.map((x) => x.column).sort()).toEqual(Object.keys(payload).sort());
    expect(c.patch).toMatchObject({ type: 'case', id: CASE_ID, label: 'case 25-12345' });
    expect(c.patch.columns.find((x) => x.column === 'case_trustee')).toMatchObject({ before: '"Tom Trustee"', after: '"Nina Newtrustee"' });
    const chapter = c.patch.columns.find((x) => x.column === 'case_chapter');
    expect([chapter.before, chapter.after, chapter.client_visible]).toEqual(['"7"', '"13"', true]);
    expect(chapter.readers[0]).toMatch(/^CLIENT PORTAL — the client sees this/);
    expect(c.warnings).toContain('CLIENT-VISIBLE COLUMNS: the submit writes case_chapter on the case — the client portal shows it (each column\'s readers are listed).');
    expect(c.warnings[0]).toBe('NO UNDO: submitting records "Case Sheet" as version 4 on case 25-12345 — no screen un-submits or deletes a submission.');
    expect(c.warnings.some((w) => /^RECORD WRITTEN FIRST: before the submission is recorded, the route writes 2 columns on case 25-12345 \(/.test(w))).toBe(true);
    expect(c.effects).toContain('Re-resolved by the server: the trustee link (from the trustee text and the chapter) — a failed match writes an empty link.');
    // The log diff: every answer that differs from the form as loaded (by label).
    expect(c.changes.map((x) => x.key).sort()).toEqual(['chapter', 'creditors', 'debts', 'notes', 'trustee']);
    expect(c.changes.find((x) => x.key === 'trustee')).toEqual({ key: 'trustee', label: 'Trustee', before: '"Tom Trustee"', after: '"Nina Newtrustee"' });
    // Workflows: the active one starts; the inactive one is named.
    expect(c.workflows).toEqual([
      { id: 41, name: 'Notify ops', description: 'Emails ops', will_start: true, init_keys: ['notify_to'] },
      { id: 42, name: 'Old flow', description: null, will_start: false, why: 'workflow #42 is inactive', init_keys: [] }]);
    expect(c.warnings).toContain('WORKFLOW WILL NOT START: workflow #42 is inactive — the submit still goes through and reports it as not started.');
    expect(c.effects.find((e) => e.startsWith('Workflows:'))).toMatch(/make_pdf = true, _values\)\. A start that fails is reported on the result and undoes nothing/);
    // Dry-runs: case.updated (the patch, source manual) then form.submitted (the next version).
    expect(c.automation.events).toEqual(['case.updated', 'form.submitted']);
    expect(c.automation.lines).toEqual(['Trigger rule #11 "Trustee changed" runs: no active actions', 'Trigger rule #12 "Sheet in" runs: no active actions']);
    expect([c.automation.rules_checked, c.automation.quiet]).toEqual([3, 1]);
    const upd = calls.evaluated.find((e) => e[1] === 'case.updated')[2];
    expect([upd.source, Object.keys(upd.changes).sort()]).toEqual(['manual', ['case_chapter', 'case_trustee']]);
    const fsub = calls.evaluated.find((e) => e[1] === 'form.submitted')[2];
    expect([fsub.case_id, fsub.data.version, fsub.data.form_key, fsub.data.schema_version]).toEqual([CASE_ID, 4, 'case_sheet', 4]);
    expect(c.version_after).toBe(4);
    expect(c.effects).toContain('The draft is consumed: draft #4530 is DELETED after the submission is recorded. A copy of this form already open anywhere keeps its draft banner, and its next autosave after any typing saves a NEW draft from that screen.');
    expect(c.effects.find((e) => e.startsWith('Log:'))).toBe('Log: one "form" entry on case 25-12345, by you — action form_submit, version 4, and the 5 answers that differ from the form as loaded (Trustee, Chapter, Debts, Notes, creditors).');
    expect(c.effects).toContain('Pipeline steps: "Case sheet in" look for a submitted "case_sheet" form on the case — on this case they read as done from now on.');
    expect(c.answers.map((a) => a.label)).toEqual(['Trustee', 'Chapter', 'Debts', 'Notes', 'creditors']);
    expect(c.expected).toEqual({
      draft_id: 4530, updated_at: UPDATED.toISOString(), data_hash: c.expected.data_hash, schema_version: 4,
      definition_hash: c.expected.definition_hash, submitted_id: 4521,
      record: { type: 'case', id: CASE_ID, hash: c.expected.record.hash },
    });
    // Key order does not move the hashes (MySQL re-orders JSON keys).
    const again = await run(submit(), { rows: { 4530: draftRow({ data: JSON.stringify(Object.fromEntries(Object.entries(DRAFT_DATA).reverse())) }) } });
    expect(again.expected.data_hash).toBe(c.expected.data_hash);
    expect(c.draft).toEqual({ submission_id: 4530, form_key: 'case_sheet', link_type: 'case', link_id: CASE_ID, updated_at: UPDATED.toISOString(), saved_by: 'you', schema_version: 4 });
  });

  test('a docket column in the diff: the docket review runs (no refusal)', async () => {
    const docketDef = { ...DEF, onSubmit: { patch: { method: 'PATCH', url: '/api/cases/{linkId}' } }, sections: [{ rows: [{ fields: [{ name: 'number', label: 'Number', type: 'text', apiColumn: 'case_number' }] }] }] };
    const c = await run(submit(), withDef(docketDef, { rows: { 4530: draftRow({ data: JSON.stringify({ number: '25-99999' }) }) } }));
    expect(c.warnings.some((w) => w.startsWith('DOCKET REPLACED: the case number "25-12345" → "25-99999"'))).toBe(true);
  });

  test('no change against the record: nothing patched, the record still pinned; no onSubmit.patch: nothing written, no record', async () => {
    const same = { trustee: 'Tom Trustee', chapter: '7', debts: '', notes: '', creditors: [] };
    const c = await run(submit(), { rows: { 4530: draftRow({ data: JSON.stringify(same) }) } });
    expect(c.patch).toBe(null);
    expect(c.expected.record).toMatchObject({ type: 'case', id: CASE_ID });
    expect(c.automation.events).toEqual(['form.submitted']);
    expect(c.effects).toContain(`Record: the form writes to case ${CASE_ID} when saved, but the draft's answers already match it — no column changes, so nothing is written there.`);
    const b = await run(submit(), { tpls: { case_sheet: BARE_TPL }, rows: { 4530: draftRow({ form_key: 'case_sheet', data: JSON.stringify({ trustee: 'X' }) }) } });
    expect([b.patch, b.expected.record, b.workflows]).toEqual([null, null, []]);
    expect(b.effects).toContain('Record: this form writes no record column when submitted (it has no onSubmit.patch) — only the submission is recorded.');
    expect(b.effects).toContain('Workflows: none — this form starts no workflow when submitted.');
  });

  test('a contact form: contact.updated dry-run with the contact row; a missing / unpublished workflow named', async () => {
    const opts = {
      rows: { 4530: draftRow({ form_key: 'contact_sheet', link_type: 'contact', link_id: '1309', schema_version: 1, data: JSON.stringify({ email: 'new@example.com' }) }) },
      contactRow: { contact_id: 1309, contact_name: 'Dana Debtor', contact_email: 'old@example.com' },
      rules: [{ id: 21, ev: 'contact.updated', name: 'Email changed', actions: [] }], matched: [21],
    };
    const c = await run(submit({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }] }), opts);
    expect(c.patch).toEqual({ type: 'contact', id: '1309', label: 'Dana Debtor (contact #1309)',
      columns: [{ column: 'contact_email', before: '"old@example.com"', after: '"new@example.com"', readers: ['Templates: {{contacts.contact_email}} in letters, forms, emails and texts resolves to the new value.'] }] });
    expect(c.automation.events).toEqual(['contact.updated', 'form.submitted']);
    const env = calls.evaluated.find((e) => e[1] === 'contact.updated')[2];
    expect([env.contact_id, env.changes.contact_email]).toEqual([1309, { from: 'old@example.com', to: 'new@example.com' }]);
    expect(c.expected.record).toMatchObject({ type: 'contact', id: '1309' });

    const wfDef = { ...DEF, onSubmit: { workflows: [{ id: 50 }, { id: 51 }, { id: 'x' }] } };
    const w = await run(submit(), withDef(wfDef, { workflows: [{ id: 51, name: 'Draft only', active: 1, current_version: 0 }] }));
    expect(w.workflows.map((x) => x.why)).toEqual(['workflow #50 does not exist', 'workflow #51 has never been published', 'its id "x" is not a workflow id']);
    expect(calls.wfIds).toEqual([50, 51]);
  });
});

describe('the ledger and the request detector', () => {
  test('the submit receipts the new submission row', () => {
    expect(ledger.KINDS.get('form.submit.v1')).toBe('submission_id');
  });
  test.each(['submit the case sheet form draft for the Smith case', 'please submit her intake form'])('a submit request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['Was the intake form submitted?', 'Who submitted the 341 notes form?'])('a question does not: %s', (q) => {
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
  'formSubmitRequest', 'formSubmitPrecheck', 'formSubmitResult', 'formSubmitKnownOutcome', 'formSubmitOutcomeText', 'formSubmitAppliedMessage'];
const CONSTS = ['FORM_SUBMIT_ACTION_KINDS'];
function browser(api, deps = {}) {
  const src = [...CONSTS.map(constSrc), ...FNS.map(fnSrc),
    `const families = [${familySrc('form_submit')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  return new Function('api', 'openEntity', 'crypto', 'TextEncoder', src)(api, deps.openEntity || jest.fn(), crypto.webcrypto, TextEncoder); // eslint-disable-line no-new-func
}

describe('the browser: the request, the re-reads, the result, the outcomes, the family, the text', () => {
  let card; let bare;
  beforeAll(async () => {
    const mk = async (value, opts) => {
      const out = JSON.parse(JSON.stringify(await normalizeActionDraft(setup(opts), value, EVIDENCE, { currentUserId: ME })));
      spies.forEach((s) => s.mockRestore()); spies = [];
      return out;
    };
    card = await mk(submit(), { rules: [{ id: 12, ev: 'form.submitted', name: 'Sheet in', actions: [] }], matched: [12] });
    bare = await mk(submit(), { tpls: { case_sheet: BARE_TPL }, rows: { 4530: draftRow({ data: JSON.stringify({ trustee: 'X' }) }) } });
  });

  test('the request: the stored draft row and the updated_at the card read — nothing from the model', () => {
    const b = browser(jest.fn());
    expect(b.formSubmitRequest({ ...card, data: { trustee: 'evil' }, form_key: 'x' })).toEqual({ path: '/api/forms/submissions/submit-draft', method: 'POST',
      body: { submission_id: 4530, expected_updated_at: UPDATED.toISOString() } });
    expect(() => b.formSubmitRequest({ ...card, draft: { ...card.draft, submission_id: 'x' } })).toThrow('This card has no usable draft id.');
    expect(() => b.formSubmitRequest({ ...card, draft: { ...card.draft, form_key: 'a b' } })).toThrow('This card has no usable form.');
    expect(() => b.formSubmitRequest({ ...card, draft: { ...card.draft, link_type: 'bill' } })).toThrow('This card has no usable record.');
    expect(() => b.formSubmitRequest({ ...card, expected: { ...card.expected, draft_id: 1 } })).toThrow('This card has no usable stale check.');
    expect(() => b.formSubmitRequest({ ...card, expected: { ...card.expected, updated_at: 'never' } })).toThrow('This card has no usable stale check.');
  });

  // The GETs as the routes answer them; the record and the template as the card saw them.
  const DEF_JSON = JSON.parse(JSON.stringify(DEF));
  const CASE_JSON = JSON.parse(JSON.stringify(CASE_ROW));
  function reads({ record = true, draft, submitted, tpl, tplGone = false, rec, recGone = false, fail = false } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      if (p.startsWith('/api/forms/latest?')) {
        return { status: 'success', submitted: submitted === undefined ? { id: 4521, version: 3 } : submitted,
          draft: draft === undefined ? { id: 4530, data: DRAFT_DATA, updated_at: UPDATED.toISOString(), user_name: 'Fred' } : draft };
      }
      if (p.startsWith('/api/form-templates/render/')) {
        if (tplGone) throw Object.assign(new Error('No published template'), { status: 404 });
        return { status: 'success', title: 'Case Sheet', link_type: 'case', schema_version: 4, definition: DEF_JSON, ...(tpl || {}) };
      }
      if (/^\/api\/cases\//.test(p)) {
        if (!record || (recGone && gets.filter((g) => g === p).length > 1)) throw Object.assign(new Error('Case not found'), { status: 404 });
        return { case: rec || CASE_JSON };
      }
      throw new Error(`unexpected GET ${p}`);
    });
    return { api, gets };
  }

  test('the re-read: the record, the draft (id, updated_at, hash), the latest submission, the published form, the patched record', async () => {
    let r = reads();
    expect(await browser(r.api).formSubmitPrecheck(card)).toBe('');
    expect(r.gets).toEqual([`/api/cases/${CASE_ID}`, `/api/forms/latest?form_key=case_sheet&link_type=case&link_id=${CASE_ID}`,
      '/api/form-templates/render/case_sheet', `/api/cases/${CASE_ID}`]);
    r = reads({ draft: { id: 4530, data: JSON.stringify(Object.fromEntries(Object.entries(DRAFT_DATA).reverse())), updated_at: UPDATED.toISOString() },
      tpl: { definition: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(DEF_JSON).reverse()))) },
      rec: Object.fromEntries(Object.entries(CASE_JSON).reverse()) });
    expect(await browser(r.api).formSubmitPrecheck(card)).toBe('');
    r = reads({ draft: { id: 4530, data: { trustee: 'X' }, updated_at: UPDATED.toISOString() }, tpl: { title: 'Bare', definition: JSON.parse(JSON.stringify(BARE_DEF)) } });
    expect(await browser(r.api).formSubmitPrecheck(bare)).toBe('');
    expect(r.gets).toHaveLength(3);
    const cases = [
      [reads({ record: false }), 'case 25-12345 no longer exists. Nothing was submitted.'],
      [reads({ draft: null }), 'The draft of "Case Sheet" for case 25-12345 is gone — submitted or discarded since this card was prepared. Nothing was submitted.'],
      [reads({ draft: { id: 4530, data: { ...DRAFT_DATA, notes: 'typed' }, updated_at: UPDATED.toISOString(), user_name: 'Stuart' } }), /^The draft of "Case Sheet" for case 25-12345 changed since this card was prepared \(someone saved it — last by Stuart\)\. Nothing was submitted/],
      [reads({ draft: { id: 4530, data: DRAFT_DATA, updated_at: '2026-11-01T10:00:01.000Z' } }), /changed since this card was prepared/],
      [reads({ draft: { id: 4999, data: DRAFT_DATA, updated_at: UPDATED.toISOString() } }), /changed since this card was prepared/],
      [reads({ submitted: { id: 4610, version: 4 } }), '"Case Sheet" for case 25-12345 was submitted since this card was prepared (now version 4). Nothing was submitted — the version it becomes, and what the form compares the answers with, changed. Ask Casey to prepare it again.'],
      [reads({ tplGone: true }), '"Case Sheet" is no longer published. Nothing was submitted.'],
      [reads({ tpl: { schema_version: 5 } }), /^"Case Sheet" was published again since this card was prepared/],
      [reads({ tpl: { definition: { ...DEF_JSON, onSubmit: {} } } }), /^"Case Sheet" was published again since this card was prepared/],
      [reads({ rec: { ...CASE_JSON, case_trustee: 'Someone Else' } }), 'case 25-12345 changed since this card was prepared — the columns the submit writes, and what it compares the answers with, may differ. Nothing was submitted. Ask Casey to prepare it again.'],
      [reads({ recGone: true }), `The case this form writes to (case ${CASE_ID}) no longer exists. Nothing was submitted.`],
    ];
    for (const [rr, want] of cases) {
      const got = await browser(rr.api).formSubmitPrecheck(card);
      if (want instanceof RegExp) expect(got).toMatch(want); else expect(got).toBe(want);
    }
    expect(await browser(reads({ submitted: null }).api).formSubmitPrecheck(card)).toMatch(/was submitted since this card was prepared\. Nothing was submitted/);
    await expect(browser(reads({ fail: true }).api).formSubmitPrecheck(card)).rejects.toThrow('boom');
  });

  const ANSWER = { status: 'success', submission: { id: 4612, version: 4, updated_at: '2026-11-10T12:00:00.000Z' }, form_key: 'case_sheet', link_type: 'case', link_id: CASE_ID,
    patch_target: { type: 'case', id: CASE_ID }, patched: ['case_trustee', 'case_chapter'], changes: {}, draft_deleted: true,
    workflows: [{ id: 41, started: true, execution_id: 900 }, { id: 42, started: false, error: 'start_workflow: workflow #42 is inactive' }], log_id: 777 };

  test('the result: the NEW submission is the receipt; the outcome is kept; problems are named', () => {
    const b = browser(jest.fn());
    const d = JSON.parse(JSON.stringify(card));
    expect(b.formSubmitResult(d, ANSWER)).toEqual({ submission_id: 4612 });
    expect(d.submit_outcome).toEqual({ submission_id: 4612, version: 4, patched: ['case_trustee', 'case_chapter'], unreviewed: [], draft_deleted: true, draft_delete_error: null,
      workflows: [{ id: 41, started: true, execution_id: 900, error: null }, { id: 42, started: false, execution_id: null, error: 'start_workflow: workflow #42 is inactive' }],
      log_id: 777, log_error: null });
    const t = b.formSubmitOutcomeText(d);
    expect(t.summary).toBe('recorded as version 4 (submission #4612), wrote case_trustee, case_chapter on case 25-12345, started workflow #41 "Notify ops" (run #900), deleted the draft, wrote log entry #777');
    expect(t.problems).toEqual(['workflow #42 "Old flow" did NOT start (start_workflow: workflow #42 is inactive) — start it from its workflow page if it is needed']);
    expect(b.formSubmitAppliedMessage(d, { submission_id: 4612 }, false)).toBe(`Submit form applied — "Case Sheet" for case 25-12345: ${t.summary}. NOT DONE: ${t.problems[0]}.`);
    expect(b.formSubmitAppliedMessage(d, { submission_id: 4612 }, true)).toBe('Submit form had already been applied (submission #4612); nothing was submitted a second time.');
    const odd = JSON.parse(JSON.stringify(card));
    b.formSubmitResult(odd, { ...ANSWER, patched: ['case_trustee', 'case_caption'], workflows: [], draft_deleted: false, draft_delete_error: 'lock', log_id: null, log_error: 'down' });
    expect(b.formSubmitOutcomeText(odd).problems).toEqual(['the route also wrote case_caption, which this card did not show — check the record',
      'the draft was NOT deleted (lock) — discard it on the form', 'the log entry was NOT written (down)']);
    expect(() => b.formSubmitResult(d, { ...ANSWER, submission: { id: 0 } })).toThrow('The forms route did not confirm the submission');
    expect(() => b.formSubmitResult(d, { ...ANSWER, link_id: 'OTHER' })).toThrow('The forms route did not confirm the reviewed form and record');
    expect(() => b.formSubmitResult(d, { ...ANSWER, workflows: undefined })).toThrow('The forms route did not report what it wrote');
  });

  test('the outcomes: a 400 naming fields is a refusal naming them; anything else falls to the shared rules', () => {
    const b = browser(jest.fn());
    const e400 = Object.assign(new Error('values.trustee is required'), { status: 400, body: { message: 'values.trustee is required', fields: [{ key: 'trustee', label: 'Trustee', message: 'values.trustee is required' }] } });
    expect(b.formSubmitKnownOutcome(e400)).toEqual({ status: 'Refused — nothing written',
      text: 'Refused — nothing written: the route refused the draft\'s answers — "Trustee" (trustee): values.trustee is required. Fill it in on the form (or ask Casey for a draft card), then ask again.' });
    expect(b.formSubmitKnownOutcome(Object.assign(new Error('x'), { status: 400, body: { message: 'bad', fields: [] } }))).toBe(null);
    expect(b.formSubmitKnownOutcome(Object.assign(new Error('x'), { status: 409, body: { message: 'Draft 1 was saved again' } }))).toBe(null);
    expect(b.formSubmitKnownOutcome({ status: 400, body: { idempotency: {}, fields: [{ key: 'a' }] } })).toBe(null);
  });

  test('the family: always danger, refusal409, the receipt, the applied copy (with problems), the entity', () => {
    const open = jest.fn();
    const b = browser(jest.fn(), { openEntity: open });
    const [f] = b.families;
    expect([f.danger({ warnings: [] }), f.refusal409, f.idField, f.appliedKey, [...f.kinds]]).toEqual([true, true, 'submission_id', 'result_form_submit_id', ['form.submit.v1']]);
    const d = JSON.parse(JSON.stringify(card));
    b.formSubmitResult(d, ANSWER);
    d.result_form_submit_id = 4612;
    expect(f.appliedCopy(d).status).toBe('Applied with problems — "Case Sheet" submitted (submission #4612)');
    expect(f.appliedCopy(d).warning).toMatch(/^Recorded as version 4 \(submission #4612\), .* using your signed-in account\. Not done: workflow #42 "Old flow" did NOT start .* No screen un-submits a submission\.$/);
    b.formSubmitResult(d, { ...ANSWER, workflows: [{ id: 41, started: true }] });
    expect(f.appliedCopy(d).status).toBe('Applied — "Case Sheet" submitted (submission #4612)');
    expect(f.refusalText('Draft 4530 was saved again since it was read — re-read it before submitting')).toBe('Refused — nothing written (Draft 4530 was saved again since it was read — re-read it before submitting). Ask Casey to prepare it again.');
    expect(b.formEntity(card)).toEqual({ kind: 'case', id: CASE_ID, label: '25-12345' });
    b.formOpen(card);
    expect(open).toHaveBeenCalledWith('case', CASE_ID, '25-12345');
  });

  test('the card text: the draft, the version, every answer, the columns written, the workflows, the automation, what it writes', () => {
    const b = browser(jest.fn());
    const t = b.formText(card).split('\n');
    expect(t.slice(0, 8)).toEqual(['Form submit proposal — not applied', 'Action: Submit form', 'Form: "Case Sheet" (case_sheet, a case form, form version 4, live mode)',
      'Record: case 25-12345', 'Draft: #4530, saved by you at 2026-11-01 10:00 UTC — submitted, then deleted', 'Becomes: version 4 of "Case Sheet" on that record',
      'Latest submission until now: version 3 (#4521, 2026-11-01 10:00 UTC)', 'Answers in it: 5 (5 filled in)']);
    expect(t).toContain('Answer: Trustee (trustee): "Nina Newtrustee"');
    expect(t).toContain('Differs from the form as loaded: Trustee (trustee): "Tom Trustee" → "Nina Newtrustee"');
    expect(t).toContain('Writes on case 25-12345: case_chapter "7" → "13"');
    expect(t.some((l) => /^Reads case_chapter: CLIENT PORTAL/.test(l))).toBe(true);
    expect(t).toContain('Workflow: #41 "Notify ops" — starts');
    expect(t).toContain('Workflow: #42 "Old flow" — WILL NOT START (workflow #42 is inactive)');
    expect(t).toContain('Automation: Trigger rule #12 "Sheet in" runs: no active actions');
    expect(t).toContain(`Warning: ${card.warnings[0]}`);
    expect(t.some((l) => l.startsWith('Writes: the record\'s columns above first, then ONE submitted row'))).toBe(true);
    const bt = b.formText(bare).split('\n');
    expect(bt).toContain('Writes on the record: nothing');
    expect(bt).toContain('Workflows: none');
    expect(bt).toContain('Automation: no active rule on form.submitted would act (0 checked)');
  });
});
