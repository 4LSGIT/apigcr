'use strict';
/**
 * tests/caseyFormTemplates.test.js
 *
 * A12.4 — the form builder's template operations as reviewed Ask Casey cards
 * (Fred, 2026-11-09: "Casey can do at least anything the user can do in the
 * UI"), each through the builder's own route:
 *   form.template.publish.v1    → POST   /api/form-templates/:id/publish
 *   form.template.visibility.v1 → POST   /api/form-templates/:id/visibility {visibility}
 *   form.template.restore.v1    → POST   /api/form-templates/:id/versions/:versionId/restore
 *   form.template.delete.v1     → DELETE /api/form-templates/:id
 * and the form.template.state read every card cites.
 *
 * The contract pinned here (mocked services: formTemplateService's reads are
 * spied, its validateDefinition / fieldSignature / scanExternalRefusals /
 * authoredKeyChanges run for real; the db answers the card's own SQL):
 *   1. the casey_form_templates_enabled switch (its own — casey_forms_enabled
 *      does not reach it); the by-name refusals (editing a definition, unknown
 *      keys) before anything is read; the evidence must be a row of a
 *      form.template.state read;
 *   2. the read: every template with no form_key; one template's row (draft
 *      state, the version it publishes as, the field counts), its version rows
 *      and a usage row (submissions, drafts by version, stored readers — never
 *      itself);
 *   3. publish: the route's own validation refusal, NOTHING TO PUBLISH, the
 *      field diff (added / removed / label / required / options / column),
 *      the bump decision (the service's fieldSignature), the drafts left on
 *      the old version named, the workflow change, the public exposure and the
 *      executing keys, code changes, expected;
 *   4. visibility: the value check, the no-op, the form_dev gate read from the
 *      asking user's roles (never asked for a flip to internal), what becomes
 *      reachable and by which link (reject vs degrade), never-published, a
 *      public form taken down, portal served by nothing;
 *   5. restore: the version row cited, a version of another template, the
 *      no-op, the form_dev gate on a code change, DRAFT REPLACED (unpublished
 *      edits) vs a draft equal to the published version;
 *   6. delete: published / used templates refused, the stored readers, NO UNDO;
 *   7. the ledger receipt and the request detector;
 *   8. the browser half (lifted from public/assistant.html by name): the fixed
 *      requests, the click-time re-reads (template row + version list), the
 *      result checks, the known outcomes, danger, text, entity.
 *
 * A12X (2026-11-16, "release means allow") — the FIELD-LEVEL draft edits and
 * the create, in the same family and behind the same switch:
 *   form.template.field.add.v1    → PUT  /api/form-templates/:id {draft_definition}
 *   form.template.field.update.v1 → PUT  /api/form-templates/:id {draft_definition}
 *   form.template.field.remove.v1 → PUT  /api/form-templates/:id {draft_definition}
 *   form.template.meta.v1         → PUT  /api/form-templates/:id {title}
 *   form.template.create.v1       → POST /api/form-templates
 * Pinned here: the one operation applied to a copy of the re-read draft, the
 * service's validateDefinition as the refusal, the frozen next_definition +
 * next_hash on the card, the field-level diff (the A12.4 helpers), the bump
 * and the current-version drafts it strands, the by-name refusals (authored
 * keys, $load, a rename, a form_key rename, a raw definition), the
 * user-named-field rule, the create's one-section builder and key check;
 * and the browser half: a request that sends the FROZEN definition (never
 * rebuilt — a card whose op / diff were tampered still sends the same
 * object), a precheck that re-hashes it and refuses a draft changed between
 * proposal and click, and a result check that compares what the route stored
 * with it.
 *
 * The routes' own behaviour runs on a real engine in
 * tests/caseyFormTemplates.mysql.test.js.
 *
 *   npx jest tests/caseyFormTemplates.test.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const fts = require(path.join(REPO, 'services', 'formTemplateService'));
const { normalizeActionDraft, taskDraftRequested, formTemplateStateRead } = svc;

const ME = 6;
const PUB = {
  onSubmit: { workflows: [{ id: 41 }] },
  sections: [
    { title: 'Case', rows: [{ fields: [
      { name: 'trustee', type: 'text', label: 'Trustee', required: true, apiColumn: 'case_trustee' },
      { name: 'chapter', type: 'select', label: 'Chapter', options: ['7', '13'] },
      { name: 'notes', type: 'textarea', label: 'Notes' },
    ] }] },
    { repeater: 'creditors', fields: [{ name: 'creditor', type: 'text', label: 'Creditor' }] },
  ],
};
const DRAFT = {
  onSubmit: { workflows: [{ id: 41 }, { id: 42 }] },
  sections: [
    { title: 'Case', rows: [{ fields: [
      { name: 'trustee', type: 'text', label: 'Trustee name', apiColumn: 'case_trustee' },
      { name: 'chapter', type: 'select', label: 'Chapter', options: ['7', '11', '13'] },
      { name: 'hearing', type: 'date', label: 'Hearing' },
    ] }] },
    { repeater: 'creditors', fields: [{ name: 'creditor', type: 'text', label: 'Creditor' }] },
  ],
};
const UPDATED = new Date('2026-11-10T12:00:00Z');
const tplRow = (over = {}) => ({ id: 12, form_key: 'case_sheet', title: 'Case Sheet', link_type: 'case', schema_version: 3, visibility: 'internal',
  definition: PUB, draft_definition: DRAFT, published_at: new Date('2026-11-01T09:00:00Z'), updated_by: 6,
  created_at: new Date('2026-09-01T00:00:00Z'), updated_at: UPDATED, ...over });
const VERSIONS = [
  { id: 341, schema_version: 3, published_by: 6, user_name: 'Fred', published_at: new Date('2026-11-01T09:00:00Z'), schema_changed: true },
  { id: 300, schema_version: 2, published_by: 1, user_name: 'Stuart', published_at: new Date('2026-10-01T09:00:00Z'), schema_changed: true },
];
const V300 = { ...PUB, sections: [{ title: 'Case', rows: [{ fields: [{ name: 'trustee', type: 'text', label: 'Trustee' }] }] }] };

const EVIDENCE = [
  { id: 'q1', kind: 'form.template.state', purpose: 'the template', rows: [
    { row_type: 'template', template_id: 12, form_key: 'case_sheet' },
    { row_type: 'version', template_id: 12, version_id: 341 },
    { row_type: 'version', template_id: 12, version_id: 300 },
    { row_type: 'version', template_id: 99, version_id: 900 },
  ] },
  { id: 'q2', kind: 'sql.read', purpose: 'a look-alike', rows: [{ row_type: 'template', template_id: 12 }] },
];

let spies = [];
let calls;
function setup({ tpl = tplRow(), versions = VERSIONS, versionDefs = { 341: PUB, 300: V300 }, usage = [], stale = [], workflows = [{ id: 41, name: 'Notify ops', active: 1, current_version: 2 }, { id: 42, name: 'New intake', active: 1, current_version: 1 }],
  roles = 'staff', readers = {}, list = null } = {}) {
  calls = { sql: [], getTemplate: 0, users: 0 };
  spies = [
    jest.spyOn(fts, 'getTemplate').mockImplementation(async (_db, id) => {
      calls.getTemplate += 1;
      if (!tpl || Number(id) !== Number(tpl.id)) throw Object.assign(new Error(`Template ${id} not found`), { status: 404 });
      return JSON.parse(JSON.stringify(tpl), (k, v) => ((k === 'updated_at' || k === 'published_at' || k === 'created_at') && typeof v === 'string' ? new Date(v) : v));
    }),
    jest.spyOn(fts, 'listVersions').mockImplementation(async () => versions.map((v) => ({ ...v }))),
    jest.spyOn(fts, 'getVersion').mockImplementation(async (_db, id, vid) => {
      const v = versions.find((x) => Number(x.id) === Number(vid));
      if (!v || Number(id) !== Number(tpl.id)) throw Object.assign(new Error(`Version ${vid} not found for template ${id}`), { status: 404 });
      return { ...v, template_id: Number(id), definition: JSON.parse(JSON.stringify(versionDefs[v.id])) };
    }),
    jest.spyOn(fts, 'listTemplates').mockImplementation(async () => list || [tpl]),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.sql.push(flat);
    if (flat.startsWith('SELECT status, schema_version, COUNT(*) AS n FROM form_submissions WHERE form_key = ?')) return [usage];
    if (flat.startsWith('SELECT id, link_type, link_id, updated_at FROM form_submissions WHERE form_key = ? AND status = \'draft\' AND schema_version = ?')) {
      calls.staleParams = params;
      return [stale];
    }
    if (flat === 'SELECT id, name, active, current_version FROM workflows WHERE id IN (?)') return [workflows.filter((w) => params[0].includes(w.id))];
    if (flat === 'SELECT user_auth, roles FROM users WHERE user = ? LIMIT 1') { calls.users += 1; return [[{ user_auth: 'authorized', roles }]]; }
    if (flat.startsWith('SELECT case_id, case_number, case_number_full, case_type FROM cases WHERE case_id = ?')) {
      return [[{ case_id: params[0], case_number: `26-${params[0]}`, case_number_full: null, case_type: 'Bankruptcy' }]];
    }
    if (flat === 'SELECT id FROM form_templates WHERE form_key = ? LIMIT 1') return [tpl && params[0] === tpl.form_key ? [{ id: tpl.id }] : []];
    if (/ REGEXP \?/.test(flat)) {
      const what = Object.keys(readers).find((k) => flat.includes(k));
      return [what ? readers[what] : []];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_FORM_TEMPLATES_ENABLED; delete process.env.CASEY_FORMS_ENABLED; });

const ev = (...rows) => rows.map((r) => ({ query_id: 'q1', row_number: r }));
const publish = (over = {}) => ({ kind: 'form.template.publish.v1', template_id: 12, evidence: ev(1), ...over });
const visibility = (to, over = {}) => ({ kind: 'form.template.visibility.v1', template_id: 12, visibility: to, evidence: ev(1), ...over });
const restore = (vid = 300, over = {}) => ({ kind: 'form.template.restore.v1', template_id: 12, version_id: vid, evidence: ev(1, vid === 341 ? 2 : 3), ...over });
const del = (over = {}) => ({ kind: 'form.template.delete.v1', template_id: 12, evidence: ev(1), ...over });
// A12X cards. ASKED is the user's own words the add / create rule reads.
const fieldAdd = (over = {}) => ({ kind: 'form.template.field.add.v1', template_id: 12, section: 'Case', field: { name: 'hearing_judge', type: 'text', label: 'Hearing judge' }, evidence: ev(1), ...over });
const fieldUpdate = (changes = { required: true }, over = {}) => ({ kind: 'form.template.field.update.v1', template_id: 12, field_name: 'chapter', changes, evidence: ev(1), ...over });
const fieldRemove = (name = 'hearing', over = {}) => ({ kind: 'form.template.field.remove.v1', template_id: 12, field_name: name, evidence: ev(1), ...over });
const meta = (title = '341 Case Sheet', over = {}) => ({ kind: 'form.template.meta.v1', template_id: 12, title, evidence: ev(1), ...over });
const create = (over = {}) => ({ kind: 'form.template.create.v1', form_key: 'vehicle_intake', title: 'Vehicle Intake', link_type: 'case',
  fields: [{ name: 'vehicle_year', type: 'number', label: 'Vehicle year' }, { name: 'lender', type: 'select', label: 'Lender', options: ['Ally', { value: 'other', label: 'Other' }] }], ...over });
const ASKED = 'Add a hearing judge field to the case sheet, and an amount to the creditors. Then create a vehicle intake form with the vehicle year and the lender.';
const run = (value, opts, evidence = EVIDENCE, question = '') => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: ME, question });
const refuse = (value, re, opts, evidence, question) => expect(run(value, opts, evidence, question)).rejects.toThrow(re);
const NEVER = { definition: null, published_at: null, schema_version: 1 };
// Key-order-insensitive serialization and the SHA-256 the server stores (formCanonical / formDataHash).
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v === undefined ? null : v));
const sha = (v) => crypto.createHash('sha256').update(canon(v), 'utf8').digest('hex');
const names = (fields) => fields.map((f) => f.name);

describe('the switch, the by-name refusals and the evidence', () => {
  test("'0' makes all nine kinds unavailable; casey_forms_enabled does not reach them", async () => {
    process.env.CASEY_FORM_TEMPLATES_ENABLED = '0';
    for (const card of [publish(), visibility('public'), restore(), del(), fieldAdd(), fieldUpdate(), fieldRemove(), meta(), create()]) await refuse(card, /^Action kind is unavailable$/);
    expect(calls.sql).toEqual([]);
    delete process.env.CASEY_FORM_TEMPLATES_ENABLED;
    process.env.CASEY_FORMS_ENABLED = '0';
    await expect(run(publish())).resolves.toMatchObject({ kind: 'form.template.publish.v1', status: 'draft' });
  });

  test('a raw definition is refused by name on every template card, unknown keys too — before anything is read', async () => {
    for (const card of [publish({ draft_definition: {} }), visibility('public', { title: 'X' }), restore(300, { definition: {} }), del({ form_key: 'x' }), fieldAdd({ draft_definition: {} }), meta({ definition: {} }, { definition: {} })]) {
      await refuse(card, /^TEMPLATE EDITING refused \(\w+\): no template card takes a raw definition — a definition is a large JSON a card cannot review line by line\. The draft is edited ONE field per card: add a field \(form\.template\.field\.add\.v1\), change one \(form\.template\.field\.update\.v1\), remove one \(form\.template\.field\.remove\.v1\); the title is form\.template\.meta\.v1 and a new form is form\.template\.create\.v1 \(a reviewed field list\)\. Code, hooks, CSS, embeds, the layout and a form_key rename stay the form builder's$/);
    }
    await refuse(publish({ visibility: 'public' }), /^A form template publish card carries unsupported fields: visibility — it takes template_id and evidence only \(each template card does ONE thing: publish the draft — form\.template\.publish\.v1, change the visibility — form\.template\.visibility\.v1/);
    await refuse(del({ again: true }), /^A form template delete card carries unsupported fields: again — it takes template_id and evidence only/);
    await refuse(fieldRemove('hearing', { after: 'x' }), /^A form template field remove card carries unsupported fields: after — it takes template_id and field_name and evidence only \(each template card does ONE thing: .* add \/ change \/ remove ONE answer field of the draft — form\.template\.field\.add\.v1 \/ form\.template\.field\.update\.v1 \/ form\.template\.field\.remove\.v1, set the title — form\.template\.meta\.v1, or create a new form from a field list — form\.template\.create\.v1\)$/);
    await refuse(create({ draft_definition: {} }), /^RAW DEFINITION refused \(draft_definition\): a new form is built here from the reviewed field list — ONE standard section, one row per field; its layout, settings, on-submit workflows, code, CSS, hooks and visibility are set in the form builder afterwards \(a new template starts internal and unpublished\)$/);
    await refuse(create({ visibility: 'public', layout: 'card' }), /^RAW DEFINITION refused \(visibility, layout\)/);
    await refuse(create({ again: 1 }), /^A form template create card carries unsupported fields: again — it takes form_key, title, link_type \("case", "contact" or "appt"\) and fields \(1-40 of \{name, type, label, required\?, options\?\}\); evidence is optional/);
    expect([calls.sql, calls.getTemplate]).toEqual([[], 0]);
  });

  test('the template id, the evidence (a form.template.state row — never a look-alike sql.read row) and a gone template', async () => {
    await refuse(publish({ template_id: 0 }), /^A form template publish needs the template's exact positive template_id/);
    await refuse(publish({ template_id: 13 }), /^The publish evidence does not identify form template #13 — cite its template row from a form\.template\.state read/);
    await refuse(publish({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /^The publish evidence does not identify form template #12/);
    await refuse(publish({ evidence: ev(2) }), /^The publish evidence does not identify form template #12/);
    expect(calls.getTemplate).toBe(0);
    await refuse(publish(), /^Form template #12 no longer exists$/, { tpl: null });
  });
});

describe('the form.template.state read', () => {
  test('no form_key lists every template (the builder\'s opener list)', async () => {
    const out = await formTemplateStateRead(setup({ list: [tplRow(), tplRow({ id: 19, form_key: 'new_one', title: 'New', published_at: null, definition: null })] }), '');
    expect(out.rows).toEqual([
      { row_type: 'template', template_id: 12, form_key: 'case_sheet', title: 'Case Sheet', link_type: 'case', visibility: 'internal', schema_version: 3, published: 1, published_at: '2026-11-01T09:00:00.000Z', updated_at: UPDATED.toISOString() },
      { row_type: 'template', template_id: 19, form_key: 'new_one', title: 'New', link_type: 'case', visibility: 'internal', schema_version: 3, published: 0, published_at: null, updated_at: UPDATED.toISOString() },
    ]);
  });

  test('one template: its draft against what is published, its versions and its usage (readers never include itself)', async () => {
    const out = await formTemplateStateRead(setup({
      usage: [{ status: 'submitted', schema_version: 3, n: 5 }, { status: 'draft', schema_version: 3, n: 2 }, { status: 'draft', schema_version: 2, n: 1 }],
      readers: { workflow_steps: [{ id: 77, name: 'workflow #9 v2 step 3', body: '{"form_key":"case_sheet"}' }], form_templates: [{ id: 12, name: 'case_sheet — Case Sheet', body: '"case_sheet"' }] },
    }), 'case_sheet');
    const [head, v1, v2, usage] = out.rows;
    expect(head).toMatchObject({ row_type: 'template', template_id: 12, draft_state: 'differs from published', publishes_as: 4,
      fields_added: 1, fields_removed: 1, fields_changed: 2, layout_changed: 1, settings_changed: 'onSubmit', version_count: 2 });
    expect([v1, v2]).toEqual([
      { row_type: 'version', template_id: 12, version_id: 341, schema_version: 3, published_at: '2026-11-01T09:00:00.000Z', published_by: 'Fred', schema_changed: 1, newest: 1 },
      { row_type: 'version', template_id: 12, version_id: 300, schema_version: 2, published_at: '2026-10-01T09:00:00.000Z', published_by: 'Stuart', schema_changed: 1, newest: 0 },
    ]);
    expect(usage).toEqual({ row_type: 'usage', template_id: 12, form_key: 'case_sheet', submitted: 5, drafts: 3, drafts_by_version: '{"2":1,"3":2}',
      named_by: 'Workflow step #77 "workflow #9 v2 step 3"', named_by_count: 1 });
    const never = await formTemplateStateRead(setup({ tpl: tplRow(NEVER), versions: [] }), 'case_sheet');
    expect(never.rows[0]).toMatchObject({ draft_state: 'never published', publishes_as: 1, published: 0 });
    const same = await formTemplateStateRead(setup({ tpl: tplRow({ draft_definition: PUB }) }), 'case_sheet');
    expect(same.rows[0].draft_state).toBe('same as published');
    expect((await formTemplateStateRead(setup(), 'nope')).rows).toEqual([{ row_type: 'not_found', form_key: 'nope', note: 'No form template has form_key "nope" — read form.template.state with no form_key to list every template' }]);
  });
});

describe('publish', () => {
  test('the diff, the bump, the drafts left on the old version, the workflow change, expected', async () => {
    const c = await run(publish(), { stale: [{ id: 501, link_type: 'case', link_id: 'AAA', updated_at: UPDATED }, { id: 502, link_type: 'case', link_id: 'BBB', updated_at: UPDATED }],
      usage: [{ status: 'submitted', schema_version: 3, n: 4 }] });
    expect(calls.staleParams).toEqual(['case_sheet', 3]);
    expect(c.publish).toEqual({ first_publish: false, bumped: true, schema_version_after: 4 });
    expect(c.diff.added).toEqual([{ key: 'hearing', label: 'Hearing', detail: 'date' }]);
    expect(c.diff.removed).toEqual([{ key: 'notes', label: 'Notes', detail: 'textarea' }]);
    expect(c.diff.changed).toEqual([
      { key: 'trustee', label: 'Trustee name', what: 'label "Trustee" → "Trustee name"; no longer required' },
      { key: 'chapter', label: 'Chapter', what: 'options ["7","13"] → ["7","11","13"]' },
    ]);
    expect(c.diff.other_keys).toEqual(['onSubmit']);
    expect(c.stale_drafts).toEqual({ count: 2, records: [{ submission_id: 501, record: 'case 26-AAA', updated_at: UPDATED.toISOString() }, { submission_id: 502, record: 'case 26-BBB', updated_at: UPDATED.toISOString() }] });
    expect(c.warnings[0]).toBe('OPEN DRAFTS LEFT ON THE OLD VERSION: 2 saved drafts of this form were saved on version 3; once version 4 is published, submitting them is refused (409 — the submit route and the Casey submit card) until they are restored and re-saved on the form, and the form page shows a version warning: draft #501 for case 26-AAA; draft #502 for case 26-BBB.');
    expect(c.warnings).toContain('FIELDS REMOVED: Notes (notes) — the published form stops asking it; answers already stored in submissions and drafts keep it.');
    expect(c.warnings).toContain('ON-SUBMIT WORKFLOWS CHANGE: every submit starts workflow #41 "Notify ops", workflow #42 "New intake" (now: workflow #41 "Notify ops").');
    expect(c.warnings.some((w) => /^(PUBLIC FORM|RUNS IN|CODE CHANGES)/.test(w))).toBe(false);
    expect(c.effects).toContain('Publishes the draft of "Case Sheet" (case_sheet, template #12) as version 4 (the answer fields changed, so the version bumps from 3).');
    expect(c.effects).toContain('Usage: 4 submitted forms and 0 saved drafts of this form exist.');
    expect(c.expected).toMatchObject({ template_id: 12, updated_at: UPDATED.toISOString(), schema_version: 3, visibility: 'internal', published_at: '2026-11-01T09:00:00.000Z', version_ids: [341, 300] });
    expect(c.expected.definition_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.expected.draft_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.expected.draft_hash).not.toBe(c.expected.definition_hash);
  });

  test('a label-only change publishes under the same version and reads no drafts; the first publish is version 1', async () => {
    const LABEL = JSON.parse(JSON.stringify(PUB)); LABEL.sections[0].title = 'The case';
    const c = await run(publish(), { tpl: tplRow({ draft_definition: LABEL }) });
    expect(c.publish).toEqual({ first_publish: false, bumped: false, schema_version_after: 3 });
    expect(calls.sql.some((q) => q.includes("status = 'draft' AND schema_version = ?"))).toBe(false);
    expect(c.diff.lines).toEqual(['Layout only: the sections, rows or display-only items change (wording, order, headings) — no answer field changes.']);
    expect(c.warnings).toEqual([]);
    const first = await run(publish(), { tpl: tplRow(NEVER), versions: [] });
    expect(first.publish).toEqual({ first_publish: true, bumped: false, schema_version_after: 1 });
    expect(first.fields_total).toBe(5);
    expect(first.expected.definition_hash).toBe(null);
  });

  test('refused: a draft the route would not publish (its own validation message), and a draft identical to what is published', async () => {
    await refuse(publish(), /^DRAFT INVALID refused: the route validates the draft before it publishes and would refuse it \(400\) — definition\.sections must be a non-empty array \(or use "tabs"\)\./, { tpl: tplRow({ draft_definition: { foo: 1 } }) });
    await refuse(publish(), /^NOTHING TO PUBLISH: the draft of "Case Sheet" \(case_sheet, template #12\) is identical to its published version 3/,
      { tpl: tplRow({ draft_definition: JSON.parse(JSON.stringify(PUB), (k, v) => v) }) });
  });

  test('a public form: live at once on its link; executing keys and code changes warned', async () => {
    const CODE = { ...DRAFT, code: 'console.log(1)' };
    const c = await run(publish(), { tpl: tplRow({ visibility: 'public', draft_definition: CODE }) });
    expect(c.warnings).toContain('PUBLIC FORM: "Case Sheet" (case_sheet, template #12) is public, so the new version goes live on its public link the moment it publishes — anyone holding a link that carries a real case id (/f/case_sheet?case_id=<the case\'s id>) opens it WITHOUT a login — the case id is the only credential (badLink "reject": a link without one shows the Unauthorized Link page).');
    expect(c.warnings.find((w) => w.startsWith("RUNS IN CLIENTS' BROWSERS"))).toMatch(/^RUNS IN CLIENTS' BROWSERS: the draft carries code — on the public form/);
    expect(c.warnings.find((w) => w.startsWith('CODE CHANGES'))).toMatch(/^CODE CHANGES: publishing changes the form's code — .*, and on the public link in every visitor's browser\.$/);
    const portal = await run(publish(), { tpl: tplRow({ visibility: 'portal', draft_definition: CODE }) });
    expect(portal.effects[0]).toBe('Visibility "portal": no route serves portal forms today (the external routes serve public templates only), so no client sees the new version — the draft carries code, which would run in clients\' browsers once portal forms are served.');
  });
});

describe('visibility', () => {
  test('the value check and the no-op', async () => {
    await refuse(visibility('everyone'), /^"visibility" must be one of internal, portal, public \(the route refuses anything else, 400\) — got "everyone"$/);
    await refuse(visibility('internal'), /^NOTHING TO CHANGE: "Case Sheet" \(case_sheet, template #12\) is already "internal"$/);
  });

  test('off internal needs form_dev (the asking user\'s roles); a flip to internal never asks', async () => {
    for (const roles of ['staff', '', 'attorney,staff']) {
      await refuse(visibility('public'), /^FORM DEVELOPER REQUIRED: setting visibility "public" \(exposing this form externally\) requires form-developer authorization — the form_dev role, or IT \/ superuser — and your account holds none of them, so the route would refuse it \(403\)/, { roles });
      await refuse(visibility('portal'), /^FORM DEVELOPER REQUIRED: setting visibility "portal"/, { roles });
    }
    for (const roles of ['form_dev', 'staff,it', 'su']) await expect(run(visibility('public'), { roles })).resolves.toMatchObject({ visibility: { from: 'internal', to: 'public' } });
    const down = await run(visibility('internal'), { tpl: tplRow({ visibility: 'public' }), roles: 'staff' });
    expect(calls.users).toBe(0);
    expect(down.warnings).toEqual(['TAKEN DOWN: the public link /f/case_sheet stops serving "Case Sheet" (case_sheet, template #12) at once — anyone opening it gets the generic Unauthorized Link page, and a client part-way through the form can no longer save a draft or submit (their next request is refused; answers kept in their own browser stay there). Links already sent stop working until it is public again.']);
    const fromPortal = await run(visibility('internal'), { tpl: tplRow({ visibility: 'portal' }) });
    expect(fromPortal.warnings).toEqual([]);
  });

  test('public: what becomes reachable and by which link (reject vs degrade), executing keys, server drafts; never published', async () => {
    const c = await run(visibility('public'), { roles: 'form_dev' });
    expect(c.link).toBe('/f/case_sheet?case_id=<the case\'s id>');
    expect(c.warnings).toEqual(['EXPOSED PUBLICLY: the external form routes serve the PUBLISHED version 3 of "Case Sheet" (case_sheet, template #12) at once — anyone holding a link that carries a real case id (/f/case_sheet?case_id=<the case\'s id>) opens it WITHOUT a login — the case id is the only credential (badLink "reject": a link without one shows the Unauthorized Link page). Every later publish goes live on that link the moment it publishes.']);
    const loose = await run(visibility('public'), { roles: 'form_dev', tpl: tplRow({ definition: { ...PUB, css: 'a{}', external: { badLink: 'degrade', serverDrafts: true } } }) });
    expect(loose.warnings[0]).toContain('anyone holding the bare link /f/case_sheet opens it WITHOUT a login and submits it unlinked (badLink "degrade")');
    expect(loose.warnings[1]).toMatch(/^RUNS IN CLIENTS' BROWSERS: the published version carries css/);
    expect(loose.warnings[2]).toMatch(/^SERVER DRAFTS: /);
    const never = await run(visibility('public'), { roles: 'form_dev', tpl: tplRow(NEVER) });
    expect(never.warnings[0]).toMatch(/^EXPOSED ON PUBLISH: "Case Sheet" \(case_sheet, template #12\) has never been published, so its public link serves nothing yet — but the moment it is published, anyone holding/);
    const portal = await run(visibility('portal'), { roles: 'form_dev' });
    expect(portal.warnings[0]).toMatch(/^OFF INTERNAL: "portal" exposes .* none does today .* so no client reaches it yet\.$/);
  });
});

describe('restore', () => {
  test('the version row cited; a version of another template; the no-op', async () => {
    await refuse(restore(300, { evidence: ev(1) }), /^The restore evidence does not identify version #300 of template #12 — cite its version row/);
    await refuse(restore(900, { evidence: ev(1, 4) }), /^The restore evidence does not identify version #900 of template #12/);
    await refuse(restore(777, { evidence: [...ev(1), { query_id: 'q1', row_number: 3 }] }), /^The restore evidence does not identify version #777/);
    // A cited row naming this template but a version the route does not hold.
    const evid = [{ id: 'q1', kind: 'form.template.state', purpose: 'x', rows: [{ row_type: 'template', template_id: 12 }, { row_type: 'version', template_id: 12, version_id: 777 }] }];
    await refuse(restore(777, { evidence: ev(1, 2) }), /^Version #777 is not a version of form template #12 \(or no longer exists\) — the route refuses it \(404\)$/, {}, evid);
    await refuse(restore(341), /^NOTHING TO RESTORE: the draft of "Case Sheet" \(case_sheet, template #12\) already equals version 3 \(version #341\)$/, { tpl: tplRow({ draft_definition: PUB }) });
  });

  test('a version whose code differs needs form_dev; with it, CODE CHANGES', async () => {
    const opts = { versionDefs: { 341: PUB, 300: { ...V300, code: 'x()' } } };
    await refuse(restore(300), /^FORM DEVELOPER REQUIRED: version #300 has a different code than the current draft, so restoring it changes the form's authored code — .*the route would refuse it \(403\)/, { ...opts, roles: 'staff' });
    const c = await run(restore(300), { ...opts, roles: 'form_dev' });
    expect(c.warnings).toContain('CODE CHANGES: the restored draft has a different code — once published, the form page runs it in every staff browser that opens the form.');
  });

  test('DRAFT REPLACED when the draft holds unpublished edits (the fields that differ counted); an effect when it equals the published version', async () => {
    const c = await run(restore(300));
    expect(c.version).toEqual({ version_id: 300, schema_version: 2, published_at: '2026-10-01T09:00:00.000Z', published_by: 'Stuart', is_published: false });
    expect(c.draft_unpublished).toBe(true);
    expect(c.warnings[0]).toBe('DRAFT REPLACED: the current draft of "Case Sheet" (case_sheet, template #12) holds edits that were never published — the restore replaces it whole and those edits are LOST (no route keeps an unpublished draft): 5 answer fields differ, plus layout, plus onSubmit.');
    expect(c.effects).toContain('Publishes nothing: the published form, its version and its visibility are untouched; nobody filling the form sees a change until a publish card (or the builder\'s Publish) publishes the restored draft.');
    expect(c.effects).toContain('If it is published later, it publishes as version 4 (its answer fields differ from the published version).');
    expect(c.effects.find((e) => e.startsWith('Other open pages'))).toMatch(/its next Save writes that old draft back over the restored one/);
    const clean = await run(restore(300), { tpl: tplRow({ draft_definition: PUB }) });
    expect(clean.warnings).toEqual([]);
    expect(clean.effects[0]).toBe('The current draft equals the published version 3, which stays in the history — the restore replaces it (5 answer fields differ).');
    expect(calls.users).toBe(0);
  });
});

describe('delete', () => {
  test('refused: a published template (either column), a template with submissions or drafts', async () => {
    await refuse(del(), /^PUBLISHED TEMPLATE refused: "Case Sheet" \(case_sheet, template #12\) has been published — the route deletes only a template that was NEVER published/);
    await refuse(del(), /^PUBLISHED TEMPLATE refused/, { tpl: tplRow({ definition: null }) });
    await refuse(del(), /^SUBMISSIONS EXIST refused: 0 submitted forms and 1 saved draft carry form_key "case_sheet" — the route refuses the delete/, { tpl: tplRow(NEVER), usage: [{ status: 'draft', schema_version: 1, n: 1 }] });
  });

  test('NO UNDO always; the stored readers named (never itself), or the clean scan said', async () => {
    const c = await run(del(), { tpl: tplRow(NEVER), versions: [], readers: { pipeline_stage_requirements: [{ id: 8, name: 'Intake form (stage "Lead")', body: '{"form_key":"case_sheet"}' }], form_templates: [{ id: 12, name: 'case_sheet', body: 'case_sheet' }] } });
    expect(c.warnings).toEqual([
      'NO UNDO: "Case Sheet" (case_sheet, template #12) is DELETED — its draft definition is gone for good (it was never published, so no version keeps it); no screen restores a deleted template.',
      'STORED READERS: Pipeline step #8 "Intake form (stage "Lead")" name "case_sheet" — after the delete it names a form that does not exist. Check before applying.',
    ]);
    expect(c.effects).toContain('The form builder asks the same thing: "Delete never-published template "case_sheet" — Case Sheet? This cannot be undone."');
    const quiet = await run(del(), { tpl: tplRow(NEVER), versions: [] });
    expect(quiet.warnings.length).toBe(1);
    expect(quiet.effects[0]).toBe('Stored definitions: no report, other form template, portal card, pipeline step, workflow / sequence step or ingest action names "case_sheet" (scanned now).');
  });
});

// ── A12X: the field-level draft edits and the create ───────────────────────
describe('field add', () => {
  test('a new row at the end of the named section; the frozen next_definition and its hash; the diff, the bump and the drafts it strands; authored keys copied verbatim', async () => {
    const CODE = { ...DRAFT, code: 'x()', css: 'a{}' };
    const c = await run(fieldAdd(), { tpl: tplRow({ draft_definition: CODE, definition: { ...PUB, code: 'x()', css: 'a{}' } }), stale: [{ id: 501, link_type: 'case', link_id: 'AAA', updated_at: UPDATED }] }, EVIDENCE, ASKED);
    expect(c.kind).toBe('form.template.field.add.v1');
    expect(c.op).toEqual({ field: { key: 'hearing_judge', label: 'Hearing judge', detail: 'text' }, section: '"Case"', section_path: 'sections[0]', placement: 'a new row (row 2) at the end of section "Case"', after: null });
    expect(c.next_definition.sections[0].rows.map((r) => names(r.fields))).toEqual([['trustee', 'chapter', 'hearing'], ['hearing_judge']]);
    expect(c.next_definition.sections[0].rows[1].fields[0]).toEqual({ name: 'hearing_judge', type: 'text', label: 'Hearing judge' });
    // The authored keys ride through untouched (so the route's form_dev gate never trips); the repeater too.
    expect([c.next_definition.code, c.next_definition.css, c.next_definition.sections[1]]).toEqual(['x()', 'a{}', CODE.sections[1]]);
    expect(c.next_hash).toBe(sha(c.next_definition));
    expect(c.diff.added).toEqual([{ key: 'hearing_judge', label: 'Hearing judge', detail: 'text' }]);
    expect([c.diff.removed, c.diff.changed, c.diff.layout_changed, c.diff.other_keys]).toEqual([[], [], true, []]);
    expect(c.diff.lines).toEqual(['ADDED: Hearing judge (hearing_judge) — text', 'The sections, rows or display-only items change too (wording, order, headings).']);
    expect(c.publish).toEqual({ published: true, bumped: true, schema_version_after: 4 });
    expect(calls.staleParams).toEqual(['case_sheet', 3]);
    expect(c.stale_drafts).toEqual({ count: 1, records: [{ submission_id: 501, record: 'case 26-AAA', updated_at: UPDATED.toISOString() }] });
    expect(c.warnings).toEqual(['DRAFTS ON THE CURRENT VERSION: 1 saved draft of this form was saved on version 3; the draft already changes the answer fields and this change keeps that, so once it is published (as version 4) submitting it is refused (409 — the submit route and the Casey submit card) until it is restored and re-saved on the form: draft #501 for case 26-AAA.']);
    expect(c.effects[0]).toBe('Adds answer field "Hearing judge" (hearing_judge) — text — as a new row (row 2) at the end of section "Case".');
    expect(c.effects).toContain('Writes the DRAFT of "Case Sheet" (case_sheet, template #12) only — NOTHING PUBLISHES: the published version 3, the visibility and every submission are untouched; the form changes for anyone who opens it only when the draft is published (a publish card, or the builder\'s Publish).');
    expect(c.effects).toContain('If published afterwards: version 4 (the answer fields differ from version 3, so the version bumps — the draft already did).');
    expect(c.effects.find((e) => e.startsWith('Other open pages'))).toMatch(/its next Save writes that old draft back over this change/);
    expect(c.expected).toMatchObject({ template_id: 12, updated_at: UPDATED.toISOString(), schema_version: 3, visibility: 'internal', version_ids: [341, 300] });
    expect(c.expected.draft_hash).toBe(sha(CODE));
    expect(c.evidence).toEqual([{ query_id: 'q1', row_number: 1, label: expect.any(String) }]);
  });

  test('"after" places it in that field\'s row; a repeater section takes its row list and the builder\'s type subset; a never-published template publishes first', async () => {
    const c = await run(fieldAdd({ after: 'trustee' }), {}, EVIDENCE, ASKED);
    expect(c.op.placement).toBe('right after "trustee" in row 1 of section "Case"');
    expect(c.next_definition.sections[0].rows.map((r) => names(r.fields))).toEqual([['trustee', 'hearing_judge', 'chapter', 'hearing']]);
    expect(c.diff.layout_changed).toBe(true);
    const rep = await run(fieldAdd({ section: 'creditors', field: { name: 'amount', type: 'number', label: 'Amount' } }), {}, EVIDENCE, ASKED);
    expect(rep.op).toMatchObject({ field: { key: 'creditors.amount', label: 'Amount', detail: 'number', repeater: 'creditors' }, section: 'repeater "creditors"', placement: 'row field 2 of 2 in repeater "creditors"' });
    expect(names(rep.next_definition.sections[1].fields)).toEqual(['creditor', 'amount']);
    expect(rep.diff.added).toEqual([{ key: 'creditors.amount', label: 'Amount', detail: 'number', repeater: 'creditors' }]);
    await refuse(fieldAdd({ section: 'creditors', field: { name: 'amount', type: 'textarea', label: 'Amount' } }), /^field\.type "textarea" is not allowed inside repeater "creditors" — a repeater's row takes text, number, date, select, checkbox \(the form builder refuses the same drop\)$/, {}, EVIDENCE, ASKED);
    const SOLO = { sections: [{ title: 'Only', rows: [{ fields: [{ name: 'a', type: 'text', label: 'A' }] }] }] };
    const first = await run(fieldAdd({ section: undefined }), { tpl: tplRow({ ...NEVER, draft_definition: SOLO }), versions: [] }, EVIDENCE, ASKED);
    expect([first.publish, first.stale_drafts.count, first.warnings]).toEqual([{ published: false, bumped: false, schema_version_after: 1 }, 0, []]);
    expect(first.effects).toContain('If published afterwards: version 1 — the first publish of "Case Sheet" (case_sheet, template #12).');
    expect(calls.sql.some((q) => q.includes("status = 'draft' AND schema_version = ?"))).toBe(false);
    // A label-only draft: an add bumps (fieldSignature carries name + type) and reads the current-version drafts.
    const same = await run(fieldAdd(), { tpl: tplRow({ draft_definition: PUB }) }, EVIDENCE, ASKED);
    expect([same.publish, calls.staleParams]).toEqual([{ published: true, bumped: true, schema_version_after: 4 }, ['case_sheet', 3]]);
    expect(same.warnings).toEqual([]);
  });

  test('refused: the section (missing with two, unknown, ambiguous, by path), a field that exists, "after" unknown, a field the user never named, authored keys, display-only types, unknown keys, $load, the service\'s own validation', async () => {
    await refuse(fieldAdd({ section: undefined }), /^"Case Sheet" \(case_sheet, template #12\) has 2 sections — name the one the field goes into in "section" \(its title\): "Case", repeater "creditors"$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ section: 'Nope' }), /^"Case Sheet" \(case_sheet, template #12\) has no section "Nope" — its sections: "Case", repeater "creditors"$/, {}, EVIDENCE, ASKED);
    const TWICE = { sections: [DRAFT.sections[0], { title: 'case', rows: [] }] };
    await refuse(fieldAdd(), /^"Case" names 2 sections of "Case Sheet" \(case_sheet, template #12\) \(sections\[0\], sections\[1\]\) — name it by its path instead$/, { tpl: tplRow({ draft_definition: TWICE }) }, EVIDENCE, ASKED);
    const byPath = await run(fieldAdd({ section: 'sections[1]' }), { tpl: tplRow({ draft_definition: TWICE }) }, EVIDENCE, ASKED);
    expect(byPath.op.placement).toBe('a new row (row 1) at the end of section "case"');
    await refuse(fieldAdd({ field: { name: 'trustee', type: 'text', label: 'Trustee' } }), /^FIELD EXISTS: "Case Sheet" \(case_sheet, template #12\) already has a field or repeater named "trustee" — change it with form\.template\.field\.update\.v1, or pick another name$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'creditors', type: 'text', label: 'Creditors' } }), /^FIELD EXISTS: .* named "creditors"/, {}, EVIDENCE, 'add a creditors field');
    await refuse(fieldAdd({ after: 'zzz' }), /^"after" names "zzz", which is not a field of section "Case"$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'favorite_color', type: 'text', label: 'Favorite color' } }), /^"Favorite color" \(favorite_color\) is not a field the user asked for — a card adds only a field whose label or name appears in the user's own words \(or in a cited row\)\. Use the user's words for the field, or ask which fields they want$/, {}, EVIDENCE, ASKED);
    // Named by its name with underscores as spaces, or by a cited row's values.
    await expect(run(fieldAdd({ field: { name: 'hearing_judge', type: 'text', label: 'Judge presiding' } }), {}, EVIDENCE, 'put the hearing judge on the case sheet')).resolves.toMatchObject({ kind: 'form.template.field.add.v1' });
    const CITED = [...EVIDENCE, { id: 'q3', kind: 'sql.read', purpose: 'a form\'s fields', rows: [{ field_key: 'hearing_judge', label: 'Hearing judge' }] }];
    await expect(run(fieldAdd({ evidence: [...ev(1), { query_id: 'q3', row_number: 1 }] }), {}, CITED, '')).resolves.toMatchObject({ kind: 'form.template.field.add.v1' });
    await refuse(fieldAdd(), /is not a field the user asked for/, {}, EVIDENCE, '');
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'embed', label: 'Hearing judge', src: 'https://x' } }), /^AUTHORED CONTENT refused \(src — an embed or content item's URL — display-only items are the builder's\): code, hooks, CSS, embed and content items run, embed or load in every staff browser that opens the form — the form builder sets them \(its form-developer gate applies there\); Casey authors answer fields only$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'embed', label: 'Hearing judge' } }), /^field\.type must be one of text, textarea, number, date, datetime, select, radio, checkbox, checkgroup, tags, hidden — "embed" is a display-only item the form builder places \(an embed runs an iframe in every browser; a content item carries no answer\) — got "embed"$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'text', label: 'Hearing judge', code: 'x', foo: 1 } }), /^AUTHORED CONTENT refused \(code — authored JavaScript\)/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'text', label: 'Hearing judge', foo: 1 } }), /^field has keys that are not field keys: foo — a field takes name, type, label, width, /, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'text', label: 'Hearing judge', prefill: '$load.case.judge' } }), /^\$LOAD refused: a \$load prefill or options source reads the record's load payload/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing judge', type: 'text', label: 'Hearing judge' } }), /^field\.name must match \^\[a-zA-Z0-9_\]\{1,50\}\$ \(letters, digits, underscores\) — got "hearing judge"$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'text' } }), /^field\.label is required \(the question the form asks\) — only a hidden field has none$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'text', label: 'Hearing judge', required: 'yes' } }), /^field\.required must be true or false$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'select', label: 'Hearing judge', options: [] } }), /^field\.options must be a non-empty list of choices/, {}, EVIDENCE, ASKED);
    // The service's own validator is the last word (its message, prefixed).
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'select', label: 'Hearing judge' } }), /^DRAFT INVALID refused: the route validates the definition before it saves the draft and would refuse this one \(400\) — sections\[0\]\.rows\[1\]\.fields\[0\]\.options must be a non-empty array for type "select"$/, {}, EVIDENCE, ASKED);
    await refuse(fieldAdd({ field: { name: 'hearing_judge', type: 'text', label: 'Hearing judge', showWhen: { field: 'nope', op: 'eq', value: 1 } } }), /^DRAFT INVALID refused: .* does not reference an existing top-level field$/, {}, EVIDENCE, ASKED);
    expect(calls.sql.some((q) => /^(UPDATE|INSERT)/i.test(q))).toBe(false);
  });
});

describe('field update', () => {
  test('sets the field\'s own keys and drops with null; the diff names each change; a label-only change keeps the version', async () => {
    const c = await run(fieldUpdate({ required: true, label: 'Chapter filed', options: ['7', '11', '13', '12'] }), { tpl: tplRow({ draft_definition: PUB }) });
    expect(c.op).toEqual({ field: { key: 'chapter', label: 'Chapter filed', detail: 'select, required' }, path: 'sections[0].rows[0].fields[1]', set: ['required', 'label', 'options'], dropped: [] });
    expect(c.next_definition.sections[0].rows[0].fields[1]).toEqual({ name: 'chapter', type: 'select', label: 'Chapter filed', options: ['7', '11', '13', '12'], required: true });
    expect(c.diff.changed).toEqual([{ key: 'chapter', label: 'Chapter filed', what: 'label "Chapter" → "Chapter filed"; now REQUIRED; options ["7","13"] → ["7","11","13","12"]' }]);
    // layout_changed is the A12.4 helper's container compare — a changed field sits in a row, so it reads true (its line says so).
    expect([c.diff.added, c.diff.removed, c.diff.layout_changed]).toEqual([[], [], true]);
    expect(c.diff.lines).toEqual(['CHANGED: Chapter filed (chapter) — label "Chapter" → "Chapter filed"; now REQUIRED; options ["7","13"] → ["7","11","13","12"]', 'The sections, rows or display-only items change too (wording, order, headings).']);
    expect(c.publish).toEqual({ published: true, bumped: false, schema_version_after: 3 });
    expect(c.effects).toContain('If published afterwards: version 3 (no answer field differs from what is published, so the version stays).');
    expect(c.effects[0]).toBe('Changes answer field "Chapter filed" (chapter): sets required, label, options — afterwards select, required.');
    expect([c.warnings, c.stale_drafts.count]).toEqual([[], 0]);
    expect(calls.sql.some((q) => q.includes("status = 'draft' AND schema_version = ?"))).toBe(false);
    expect(c.next_hash).toBe(sha(c.next_definition));
    const drop = await run(fieldUpdate({ required: null, apiColumn: null }, { field_name: 'trustee' }), { tpl: tplRow({ draft_definition: PUB }) });
    expect(drop.op).toMatchObject({ set: [], dropped: ['required', 'apiColumn'] });
    expect(drop.next_definition.sections[0].rows[0].fields[0]).toEqual({ name: 'trustee', type: 'text', label: 'Trustee' });
    expect(drop.diff.changed[0].what).toBe('no longer required; record column case_trustee → nothing');
    const cond = await run(fieldUpdate({ showWhen: { field: 'chapter', op: 'eq', value: '13' } }, { field_name: 'hearing' }));
    expect(cond.next_definition.sections[0].rows[0].fields[2].showWhen).toEqual({ field: 'chapter', op: 'eq', value: '13' });
    expect(cond.diff.layout_changed).toBe(true);
  });

  test('a type change bumps and warns; a repeater row field is addressed as "<repeater>.<field>"', async () => {
    const c = await run(fieldUpdate({ type: 'textarea' }, { field_name: 'trustee' }), { tpl: tplRow({ draft_definition: PUB }), stale: [{ id: 7, link_type: 'case', link_id: 'AAA', updated_at: UPDATED }] });
    expect(c.diff.changed).toEqual([{ key: 'trustee', label: 'Trustee', what: 'type text → textarea' }]);
    expect(c.publish).toEqual({ published: true, bumped: true, schema_version_after: 4 });
    expect(c.warnings).toEqual([
      'TYPE CHANGE: an answer already stored under the old type may not fit the new one (a date in a number field, a free text in a choice list); once published, the form validates new answers by the new type.',
      'DRAFTS ON THE CURRENT VERSION: 1 saved draft of this form was saved on version 3; this change alters the answer fields, so once it is published (as version 4) submitting it is refused (409 — the submit route and the Casey submit card) until it is restored and re-saved on the form: draft #7 for case 26-AAA.',
    ]);
    const rep = await run(fieldUpdate({ label: 'Creditor name' }, { field_name: 'creditors.creditor' }));
    expect(rep.op).toMatchObject({ field: { key: 'creditors.creditor', label: 'Creditor name', detail: 'text', repeater: 'creditors' }, path: 'sections[1].fields[0]' });
    expect(rep.diff.changed).toEqual([{ key: 'creditors.creditor', label: 'Creditor name', what: 'label "Creditor" → "Creditor name"', repeater: 'creditors' }]);
    await refuse(fieldUpdate({ type: 'textarea' }, { field_name: 'creditors.creditor' }), /^changes\.type "textarea" is not allowed inside repeater "creditors"/);
  });

  test('refused: an unknown field, a rename, empty changes, a no-op, authored keys, the service\'s own validation', async () => {
    await refuse(fieldUpdate({ label: 'X' }, { field_name: 'zzz' }), /^"Case Sheet" \(case_sheet, template #12\) has no answer field "zzz" in its draft — its fields: trustee, chapter, hearing, creditors, creditors\.creditor$/);
    await refuse(fieldUpdate({ label: 'X' }, { field_name: '' }), /^A field update names the field in "field_name"/);
    await refuse(fieldUpdate({ name: 'chapter_filed' }), /^RENAME refused \(changes\.name\): a renamed field is a REMOVED field and an ADDED one to the published form — its version bumps, every answer stored under the old name stops showing, and every condition naming it breaks\. Remove the field and add the new one, each its own card$/);
    await refuse(fieldUpdate({}), /^changes is empty$/);
    await refuse(fieldUpdate({ label: 'Chapter' }), /^NOTHING TO CHANGE: the draft of "Case Sheet" \(case_sheet, template #12\) already reads that way$/);
    await refuse(fieldUpdate({ foo: null }), /^NOTHING TO CHANGE: changes drops keys "chapter" does not have$/, { tpl: tplRow({ draft_definition: PUB }) }).catch(() => {});
    await refuse(fieldUpdate({ code: 'x' }), /^AUTHORED CONTENT refused \(code — authored JavaScript\)/);
    await refuse(fieldUpdate({ type: 'content' }), /^changes\.type must be one of .* — "content" is a display-only item/);
    await refuse(fieldUpdate({ type: 'text' }), /^DRAFT INVALID refused: .* — sections\[0\]\.rows\[0\]\.fields\[1\]\.options is not allowed for type "text"$/);
    await refuse(fieldUpdate({ prefill: '$load.x' }), /^\$LOAD refused/);
    expect(calls.sql.some((q) => /^(UPDATE|INSERT)/i.test(q))).toBe(false);
  });
});

describe('field remove', () => {
  test('removes ONE field; FIELD REMOVED names the record column it stops saving to; the emptied row is left', async () => {
    const c = await run(fieldRemove('trustee'));
    expect(c.op).toEqual({ field: { key: 'trustee', label: 'Trustee name', detail: 'text, saves to case_trustee' }, path: 'sections[0].rows[0].fields[0]' });
    expect(c.next_definition.sections[0].rows.map((r) => names(r.fields))).toEqual([['chapter', 'hearing']]);
    expect(c.diff.removed).toEqual([{ key: 'trustee', label: 'Trustee name', detail: 'text, saves to case_trustee' }]);
    expect(c.warnings[0]).toBe('FIELD REMOVED: Trustee name (trustee) — once this draft is published, the form stops asking it; answers already stored in submissions and drafts keep it, and nothing saves to the case_trustee column from this form any more.');
    expect(c.publish).toEqual({ published: true, bumped: true, schema_version_after: 4 });
    expect(c.effects[0]).toBe('Removes answer field "Trustee name" (trustee) — text, saves to case_trustee — from the draft.');
    expect(c.next_hash).toBe(sha(c.next_definition));
    const SOLO = { ...PUB, sections: [{ title: 'Case', rows: [{ fields: [PUB.sections[0].rows[0].fields[0]] }, { fields: [PUB.sections[0].rows[0].fields[1]] }] }, PUB.sections[1]] };
    const row = await run(fieldRemove('chapter'), { tpl: tplRow({ draft_definition: SOLO }) });
    expect(row.effects[0]).toBe('Removes answer field "Chapter" (chapter) — select — from the draft (its row is left empty).');
    expect(row.next_definition.sections[0].rows.map((r) => names(r.fields))).toEqual([['trustee'], []]);
    expect(row.warnings[0]).toBe('FIELD REMOVED: Chapter (chapter) — once this draft is published, the form stops asking it; answers already stored in submissions and drafts keep it.');
  });

  test('refused: a field a condition or derive rule still names (the paths), a repeater key, a repeater\'s last row field, an unknown field', async () => {
    const REF = JSON.parse(JSON.stringify(DRAFT));
    REF.sections[0].rows[0].fields[2].showWhen = { field: 'chapter', op: 'eq', value: '13' };
    REF.sections[0].showWhenAny = [{ field: 'chapter', op: 'notEmpty' }];
    REF.derive = [{ target: 'hearing', from: 'hearing', op: 'addDays', n: 1 }];
    await refuse(fieldRemove('chapter'), /^STILL REFERENCED refused: sections\[0\]\.showWhenAny, sections\[0\]\.rows\[0\]\.fields\[2\]\.showWhen name "chapter" \(a visibility \/ required-when condition or a derive rule\) — the draft would not save with a dangling target\. Clear them first \(a field's condition with form\.template\.field\.update\.v1 \{showWhen: null\}; a section's, a row's or a derive rule in the form builder, whose delete cascade-removes them after a confirm\)$/, { tpl: tplRow({ draft_definition: REF }) });
    await refuse(fieldRemove('hearing'), /^STILL REFERENCED refused: derive\[0\] names "hearing"/, { tpl: tplRow({ draft_definition: REF }) });
    await refuse(fieldRemove('creditors'), /^REPEATER refused: "creditors" is a repeater section of "Case Sheet" \(case_sheet, template #12\), not a field — removing a whole section \(and every answer row it holds\) is the form builder's$/);
    await refuse(fieldRemove('creditors.creditor'), /^LAST ROW FIELD refused: "creditors\.creditor" is the only row field of repeater "creditors"/);
    await refuse(fieldRemove('zzz'), /^"Case Sheet" \(case_sheet, template #12\) has no answer field "zzz" in its draft — its fields: trustee, chapter, hearing, creditors, creditors\.creditor$/);
    await refuse(fieldRemove(''), /^A field remove names the field in "field_name"/);
    const TWO = JSON.parse(JSON.stringify(DRAFT)); TWO.sections[1].fields.push({ name: 'amount', type: 'number', label: 'Amount' });
    const rep = await run(fieldRemove('creditors.amount'), { tpl: tplRow({ draft_definition: TWO }) });
    expect([rep.op.field, names(rep.next_definition.sections[1].fields)]).toEqual([{ key: 'creditors.amount', label: 'Amount', detail: 'number', repeater: 'creditors' }, ['creditor']]);
    expect(calls.sql.some((q) => /^(UPDATE|INSERT)/i.test(q))).toBe(false);
  });
});

describe('meta (the title)', () => {
  test('the title from → to, no definition on the card; form_key and link_type refused by name with the reason', async () => {
    const c = await run(meta());
    expect(c.meta).toEqual({ title_from: 'Case Sheet', title_to: '341 Case Sheet' });
    expect([c.next_definition, c.diff, c.warnings]).toEqual([undefined, undefined, []]);
    expect(c.effects[0]).toBe('Retitles form template #12 (case_sheet): "Case Sheet" → "341 Case Sheet".');
    expect(c.effects[1]).toMatch(/^The title is the name the form is listed and headed by .* nothing publishes\.$/);
    expect(c.expected).toMatchObject({ template_id: 12, updated_at: UPDATED.toISOString(), version_ids: [341, 300] });
    await refuse(meta('  341 Case Sheet  ', { form_key: 'new_key' }), /^FORM KEY RENAME refused: "case_sheet" is the name every stored reader of this form carries — its public link \/f\/case_sheet, workflow \/ pipeline \/ portal definitions, and form_submissions\.form_key on every submission and draft — so a rename breaks each of them silently \(the route itself refuses it once the form is published or used\)\. Renaming is the form builder's, and only for a never-published, unused form$/);
    await refuse(meta('X', { link_type: 'contact' }), /^LINK TYPE refused: "case" is the kind of record every submission of this form links to — no route changes it/);
    await refuse(meta('Case Sheet'), /^NOTHING TO CHANGE: "Case Sheet" \(case_sheet, template #12\) is already titled "Case Sheet"$/);
    await refuse(meta('   '), /^title must be a non-empty string \(the route refuses an empty title, 400\)$/);
    await refuse(meta('x'.repeat(151)), /^title is 151 characters — the column holds 150$/);
    await refuse(meta('Two\nlines'), /^title must not contain line breaks or control characters$/);
    await refuse({ kind: 'form.template.meta.v1', template_id: 12, evidence: ev(1) }, /^A form template meta card sets the title — give "title"$/);
    expect(calls.sql.some((q) => /^(UPDATE|INSERT)/i.test(q))).toBe(false);
  });
});

describe('create', () => {
  test('one section, one row per reviewed field, frozen with its hash; the key checked; evidence optional', async () => {
    const c = await run(create(), {}, EVIDENCE, ASKED);
    expect(c.create).toEqual({ form_key: 'vehicle_intake', title: 'Vehicle Intake', link_type: 'case' });
    expect(c.definition).toEqual({ sections: [{ title: 'Section 1', rows: [
      { fields: [{ name: 'vehicle_year', type: 'number', label: 'Vehicle year' }] },
      { fields: [{ name: 'lender', type: 'select', label: 'Lender', options: ['Ally', { value: 'other', label: 'Other' }] }] },
    ] }] });
    expect(c.definition_hash).toBe(sha(c.definition));
    expect(c.fields).toEqual([{ key: 'vehicle_year', label: 'Vehicle year', detail: 'number' }, { key: 'lender', label: 'Lender', detail: 'select' }]);
    expect([c.fields_total, c.evidence, c.expected, c.warnings, c.template]).toEqual([2, [], { form_key: 'vehicle_intake' }, [], undefined]);
    expect(c.effects[0]).toBe('Creates form template "Vehicle Intake" (vehicle_intake), a case form, with ONE section ("Section 1") holding 2 answer fields, one per row: Vehicle year (vehicle_year) — number; Lender (lender) — select.');
    expect(c.effects[1]).toMatch(/^The new template is NEVER PUBLISHED and INTERNAL/);
    expect(calls.sql).toEqual(['SELECT id FROM form_templates WHERE form_key = ? LIMIT 1']);
    expect(calls.getTemplate).toBe(0);
    const cited = await run(create({ evidence: ev(1), fields: [{ name: 'case_sheet', type: 'text', label: 'Sheet' }] }), {}, EVIDENCE, '');
    expect(cited.evidence).toEqual([{ query_id: 'q1', row_number: 1, label: expect.any(String) }]);
    const hidden = await run(create({ fields: [{ name: 'lender', type: 'hidden' }] }), {}, EVIDENCE, ASKED);
    expect(hidden.fields).toEqual([{ key: 'lender', label: 'lender', detail: 'hidden' }]);
  });

  test('refused: the key, the title, the link type, the field list (empty, over 40, a repeat, unnamed, authored, invalid), a key in use', async () => {
    await refuse(create({ form_key: 'Vehicle Intake' }), /^form_key must match \^\[a-z0-9_\]\{1,50\}\$ \(lower-case letters, digits, underscores — the route refuses anything else, 400\) — got "Vehicle Intake"$/, {}, EVIDENCE, ASKED);
    await refuse(create({ title: ' ' }), /^title is required \(the route refuses an empty title, 400\)$/, {}, EVIDENCE, ASKED);
    await refuse(create({ link_type: 'matter' }), /^link_type must be one of case, contact, appt \(the kind of record every submission links to; the route refuses anything else, 400\) — got "matter"$/, {}, EVIDENCE, ASKED);
    await refuse(create({ fields: [] }), /^fields must list at least one answer field/, {}, EVIDENCE, ASKED);
    await refuse(create({ fields: Array.from({ length: 41 }, (_, i) => ({ name: `f${i}`, type: 'text', label: `F${i}` })) }), /^fields lists 41 answer fields — a card reviews up to 40; create the form with its first fields and add the rest \(one card each, or in the form builder\)$/, {}, EVIDENCE, ASKED);
    await refuse(create({ fields: [{ name: 'lender', type: 'text', label: 'Lender' }, { name: 'lender', type: 'text', label: 'Lender' }] }), /^fields\[2\]\.name "lender" repeats an earlier field — names are unique form-wide$/, {}, EVIDENCE, ASKED);
    await refuse(create({ fields: [{ name: 'color', type: 'text', label: 'Favorite color' }] }), /^"Favorite color" \(color\) is not a field the user asked for — a card creates a form with only a field whose label or name appears in the user's own words/, {}, EVIDENCE, ASKED);
    await refuse(create({ fields: [{ name: 'lender', type: 'text', label: 'Lender', css: 'x' }] }), /^AUTHORED CONTENT refused \(css — authored CSS\)/, {}, EVIDENCE, ASKED);
    await refuse(create({ fields: [{ name: 'lender', type: 'checkgroup', label: 'Lender' }] }), /^DEFINITION INVALID refused: the route validates the definition before it creates the template and would refuse this one \(400\) — sections\[0\]\.rows\[0\]\.fields\[0\]\.options must be a non-empty array for type "checkgroup"$/, {}, EVIDENCE, ASKED);
    await refuse(create({ form_key: 'case_sheet' }), /^FORM KEY TAKEN: form template #12 already has form_key "case_sheet" \(the route refuses a duplicate, 400\) — pick another key, or add fields to that template instead$/, {}, EVIDENCE, ASKED);
    expect(calls.sql.some((q) => /^(UPDATE|INSERT)/i.test(q))).toBe(false);
  });
});

describe('the ledger and the request detector', () => {
  test('all nine receipt the template id', () => {
    for (const k of ['publish', 'visibility', 'restore', 'delete', 'field.add', 'field.update', 'field.remove', 'meta', 'create']) expect(ledger.KINDS.get(`form.template.${k}.v1`)).toBe('template_id');
  });
  test('template verbs force the draft path; a question does not', () => {
    for (const q of ['publish the case sheet form', 'make the intake form public', 'take the questionnaire down', 'restore version 2 of the 341 notes', 'delete that form template', 'roll back the intake form',
      'add a hearing date field to the 341 notes', 'make the trustee field on the case sheet form required', 'drop the notes field from the intake form', 'retitle the questionnaire', 'create a vehicle intake form']) {
      expect({ q, draft: taskDraftRequested(q, []) }).toEqual({ q, draft: true });
    }
    for (const q of ['is the intake form public?', 'when was the case sheet form published?', 'which fields does the intake form have?']) expect({ q, draft: taskDraftRequested(q, []) }).toEqual({ q, draft: false });
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
const FNS = ['formCanonical', 'formDataHash', 'formIso', 'formTemplateLabel', 'formTemplateName', 'formTemplateText', 'formTemplateRequest', 'formTemplatePrecheck',
  'formTemplateResult', 'formTemplateKnownOutcome', 'formTemplateAppliedMessage', 'formTemplateOpenInfo', 'formTemplateEntity', 'formTemplateOpen'];
const CONSTS = ['FORM_TEMPLATE_ACTION_KINDS', 'FORM_TEMPLATE_VISIBILITIES', 'FORM_TEMPLATE_FIELD_KINDS', 'FORM_TEMPLATE_LINK_TYPES', 'FORM_TEMPLATE_FORM_KEY_RE'];
function browser(api, deps = {}) {
  const src = [...CONSTS.map(constSrc), ...FNS.map(fnSrc),
    `const families = [${familySrc('form_template')}];`,
    `return { ${FNS.join(', ')}, families };`].join('\n');
  const P = { Swal: { fire: deps.fire || jest.fn() } };
  return new Function('api', 'P', 'crypto', 'TextEncoder', src)(api, P, crypto.webcrypto, TextEncoder); // eslint-disable-line no-new-func
}

describe('the browser: requests, the re-reads, result checks, outcomes, danger, text, entity', () => {
  let cPub; let cVis; let cDown; let cRes; let cDel;
  const TPL_JSON = JSON.parse(JSON.stringify(tplRow()));
  beforeAll(async () => {
    const mk = async (value, opts) => {
      const card = JSON.parse(JSON.stringify(await normalizeActionDraft(setup(opts), value, EVIDENCE, { currentUserId: ME })));
      spies.forEach((s) => s.mockRestore()); spies = [];
      return card;
    };
    cPub = await mk(publish());
    cVis = await mk(visibility('public'), { roles: 'form_dev' });
    cDown = await mk(visibility('internal'), { tpl: tplRow({ visibility: 'portal' }) });
    cRes = await mk(restore(300));
    cDel = await mk(del(), { tpl: tplRow(NEVER), versions: [] });
  });

  test('the requests: fixed paths from the reviewed ids; nothing the model sent', () => {
    const b = browser(jest.fn());
    expect(b.formTemplateRequest({ ...cPub, definition: {} })).toEqual({ path: '/api/form-templates/12/publish', method: 'POST', body: null });
    expect(b.formTemplateRequest(cVis)).toEqual({ path: '/api/form-templates/12/visibility', method: 'POST', body: { visibility: 'public' } });
    expect(b.formTemplateRequest(cRes)).toEqual({ path: '/api/form-templates/12/versions/300/restore', method: 'POST', body: null });
    expect(b.formTemplateRequest(cDel)).toEqual({ path: '/api/form-templates/12', method: 'DELETE', body: null });
    expect(() => b.formTemplateRequest({ ...cPub, template: { template_id: 'x' } })).toThrow('This card has no usable template id.');
    expect(() => b.formTemplateRequest({ ...cPub, expected: { ...cPub.expected, template_id: 13 } })).toThrow('This card has no usable stale check.');
    expect(() => b.formTemplateRequest({ ...cVis, visibility: { to: 'everyone' } })).toThrow('This card has no usable visibility.');
    expect(() => b.formTemplateRequest({ ...cRes, version: { version_id: 999 } })).toThrow('This card has no usable version.');
    expect(() => b.formTemplateRequest({ ...cPub, publish: {} })).toThrow('This card has no usable version.');
    expect(() => b.formTemplateRequest({ ...cPub, kind: 'form.template.update.v1' })).toThrow('This card has no usable template operation.');
  });

  function reads({ tpl = TPL_JSON, versions = VERSIONS.map((v) => ({ id: v.id })), gone = false, fail = false } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (fail) throw Object.assign(new Error('boom'), { status: 500 });
      if (p === '/api/form-templates/12') {
        if (gone) throw Object.assign(new Error('Template 12 not found'), { status: 404 });
        return { status: 'success', template: tpl };
      }
      if (p === '/api/form-templates/12/versions') return { status: 'success', versions };
      throw new Error(`unexpected GET ${p}`);
    });
    return { api, gets };
  }

  test('the re-read passes on the same template (key order ignored) and refuses on ANY difference, before the claim', async () => {
    let r = reads();
    expect(await browser(r.api).formTemplatePrecheck(cPub)).toBe('');
    expect(r.gets).toEqual(['/api/form-templates/12', '/api/form-templates/12/versions']);
    const reversed = JSON.parse(JSON.stringify(TPL_JSON));
    reversed.draft_definition = Object.fromEntries(Object.entries(reversed.draft_definition).reverse());
    expect(await browser(reads({ tpl: reversed }).api).formTemplatePrecheck(cPub)).toBe('');
    const changed = 'changed since this card was prepared (its draft, published version or visibility). Nothing was written. Ask Casey to read it again.';
    const cases = [
      [{ ...TPL_JSON, updated_at: '2026-11-10T12:00:01.000Z' }, changed],
      [{ ...TPL_JSON, draft_definition: PUB }, changed],
      [{ ...TPL_JSON, definition: DRAFT }, changed],
      [{ ...TPL_JSON, visibility: 'public' }, changed],
      [{ ...TPL_JSON, schema_version: 4 }, changed],
      [{ ...TPL_JSON, published_at: null }, changed],
    ];
    for (const [tpl, want] of cases) expect(await browser(reads({ tpl }).api).formTemplatePrecheck(cPub)).toBe(`"Case Sheet" (case_sheet) ${want}`);
    expect(await browser(reads({ versions: [{ id: 350 }, { id: 341 }, { id: 300 }] }).api).formTemplatePrecheck(cPub))
      .toBe('"Case Sheet" (case_sheet) was published again since this card was prepared (its version list changed). Nothing was written. Ask Casey to read it again.');
    r = reads({ gone: true });
    expect(await browser(r.api).formTemplatePrecheck(cDel)).toBe('"Case Sheet" (case_sheet) no longer exists — someone deleted it since this card was prepared. Nothing was written.');
    expect(r.gets).toEqual(['/api/form-templates/12']);
    await expect(browser(reads({ fail: true }).api).formTemplatePrecheck(cPub)).rejects.toThrow('boom');
    // A card that cannot be written is never read.
    r = reads();
    await expect(browser(r.api).formTemplatePrecheck({ ...cVis, visibility: { to: 'x' } })).rejects.toThrow('This card has no usable visibility.');
    expect(r.gets).toEqual([]);
  });

  test('the result checks: each route\'s own answer, the template id the receipt', () => {
    const b = browser(jest.fn());
    expect(b.formTemplateResult(cPub, { status: 'success', schema_version: 4, bumped: true, external_executes: ['code'] })).toEqual({ template_id: 12 });
    expect(cPub.template_outcome).toEqual({ schema_version: 4, bumped: true, external_executes: ['code'] });
    expect(() => b.formTemplateResult(cPub, { status: 'success', schema_version: 3, bumped: false })).toThrow(/^The publish route answered version 3, not the reviewed version 4/);
    expect(b.formTemplateResult(cVis, { status: 'success', visibility: 'public' })).toEqual({ template_id: 12 });
    expect(() => b.formTemplateResult(cVis, { status: 'success', visibility: 'portal' })).toThrow('The visibility route did not confirm the reviewed visibility');
    expect(b.formTemplateResult(cRes, { status: 'success', template: { id: 12 }, restored: { version_id: 300, schema_version: 2 } })).toEqual({ template_id: 12 });
    expect(() => b.formTemplateResult(cRes, { status: 'success', template: { id: 12 }, restored: { version_id: 341 } })).toThrow('The restore route did not confirm the reviewed version');
    expect(b.formTemplateResult(cDel, { status: 'success', deleted: true })).toEqual({ template_id: 12 });
    expect(() => b.formTemplateResult(cDel, { status: 'success' })).toThrow('The form templates route did not confirm the delete');
    expect(() => b.formTemplateResult(cDel, null)).toThrow('The form templates route did not confirm the change');
  });

  test('the known outcomes: the form_dev 403 and the 404s; anything else falls through', () => {
    const b = browser(jest.fn());
    const err = (status, message, body = {}) => Object.assign(new Error(message), { status, body: { message, ...body } });
    expect(b.formTemplateKnownOutcome(err(403, 'setting visibility "public" (exposing this form externally) requires form-developer authorization (the form_dev role, or IT/superuser). Ask IT to grant it.')).text)
      .toMatch(/^Refused — nothing written: setting visibility "public" .* \(The route reads the roles your sign-in carries/);
    expect(b.formTemplateKnownOutcome(err(404, 'Template 12 not found')).text).toBe('Refused — nothing written: Template 12 not found — it no longer exists. Ask Casey to read it again.');
    expect(b.formTemplateKnownOutcome(err(404, 'Version 300 not found for template 12')).status).toBe('Refused — nothing written');
    expect(b.formTemplateKnownOutcome(err(400, 'cannot delete a template that has been published'))).toBe(null);
    expect(b.formTemplateKnownOutcome(err(403, 'requires form-developer authorization', { idempotency: {} }))).toBe(null);
    expect(b.formTemplateKnownOutcome(err(500, 'boom'))).toBe(null);
  });

  test('the family: one id, the template_id receipt, no refusal409, danger rules, text, applied copy, entity', () => {
    const fire = jest.fn();
    const b = browser(jest.fn(), { fire });
    const [fam] = b.families;
    expect([fam.id, [...fam.kinds], fam.idField, fam.appliedKey, !!fam.refusal409]).toEqual(['form_template',
      ['form.template.publish.v1', 'form.template.visibility.v1', 'form.template.restore.v1', 'form.template.delete.v1',
        'form.template.field.add.v1', 'form.template.field.update.v1', 'form.template.field.remove.v1', 'form.template.meta.v1', 'form.template.create.v1'], 'template_id', 'result_form_template_id', false]);
    expect([fam.danger(cPub), fam.danger(cVis), fam.danger(cDown), fam.danger(cRes), fam.danger(cDel)]).toEqual([true, true, false, true, true]);
    expect(fam.danger({ ...cPub, warnings: [] })).toBe(false);
    // Always danger, whatever the warnings: a delete (no undo) and any flip off internal (exposure).
    expect([fam.danger({ ...cDel, warnings: [] }), fam.danger({ ...cVis, warnings: [] }), fam.danger({ ...cDown, warnings: [] })]).toEqual([true, true, false]);
    expect([b.formTemplateLabel(cPub), b.formTemplateLabel(cVis), b.formTemplateLabel(cDown), b.formTemplateLabel(cRes), b.formTemplateLabel(cDel)])
      .toEqual(['Publish form template', 'Make form template public', 'Make form template internal', 'Restore form version into draft', 'Delete form template']);
    const text = b.formTemplateText(cPub);
    expect(text).toContain('Publishes as: version 4 (the answer fields changed — the version bumps)');
    expect(text).toContain('Change: REMOVED: Notes (notes) — textarea');
    expect(text).toContain('On submit: workflow #42 "New intake"');
    expect(b.formTemplateText(cVis)).toContain('Visibility: internal → public');
    expect(b.formTemplateText(cRes)).toContain('Current draft: holds UNPUBLISHED edits — replaced and lost');
    expect(b.formTemplateText(cDel)).toContain('Writes: deletes the template row and its version rows — there is no undo.');
    cPub.result_form_template_id = 12;
    expect(fam.appliedCopy(cPub).status).toBe('Applied — publish form template (template #12)');
    expect(b.formTemplateAppliedMessage(cVis, { template_id: 12 }, false)).toBe('"Case Sheet" (case_sheet) is now public.');
    expect(b.formTemplateAppliedMessage(cDel, { template_id: 12 }, true)).toBe('Delete form template had already been applied to template #12; nothing was written a second time.');
    expect(fam.entity(cDel)).toEqual({ kind: 'form_template', id: '12', label: '"Case Sheet" (case_sheet)' });
    fam.open(cDel);
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ title: '"Case Sheet" (case_sheet)', text: 'Find it under More → Form Builder (search its form key).' }));
  });

  test('openEntity routes a form_template entity to the same info dialog', () => {
    expect(fnSrc('openEntity')).toContain("else if (kind === 'form_template') formTemplateOpenInfo(label);");
  });
});

// ── A12X in the browser: the frozen definition is what is sent ─────────────
describe('the browser (A12X): the frozen definition, the re-hash and re-read, the result checks', () => {
  let cAdd; let cUpd; let cRem; let cMeta; let cCreate;
  const TPL_JSON = JSON.parse(JSON.stringify(tplRow()));
  beforeAll(async () => {
    const mk = async (value, opts) => {
      const card = JSON.parse(JSON.stringify(await normalizeActionDraft(setup(opts), value, EVIDENCE, { currentUserId: ME, question: ASKED })));
      spies.forEach((s) => s.mockRestore()); spies = [];
      return card;
    };
    cAdd = await mk(fieldAdd());
    cUpd = await mk(fieldUpdate({ required: true }));
    cRem = await mk(fieldRemove('trustee'));
    cMeta = await mk(meta());
    cCreate = await mk(create());
  });

  test('the requests: the PUT body IS the card\'s next_definition (the same object, never rebuilt from op / diff); the title; the POST', () => {
    const b = browser(jest.fn());
    for (const c of [cAdd, cUpd, cRem]) {
      const req = b.formTemplateRequest(c);
      expect([req.path, req.method, Object.keys(req.body)]).toEqual(['/api/form-templates/12', 'PUT', ['draft_definition']]);
      expect(req.body.draft_definition).toBe(c.next_definition);
      // A card whose op / diff / field lines were altered still sends the frozen definition, untouched.
      const tampered = { ...c, op: { field: { key: 'zzz', label: 'Z', detail: 'text' }, placement: 'elsewhere' }, diff: { added: [{ key: 'zzz' }], lines: ['ADDED: zzz'] } };
      expect(b.formTemplateRequest(tampered).body.draft_definition).toBe(c.next_definition);
      expect(() => b.formTemplateRequest({ ...c, next_definition: undefined })).toThrow('This card has no usable definition.');
      expect(() => b.formTemplateRequest({ ...c, next_hash: 7 })).toThrow('This card has no usable definition.');
      expect(() => b.formTemplateRequest({ ...c, next_definition: [] })).toThrow('This card has no usable definition.');
    }
    expect(b.formTemplateRequest(cMeta)).toEqual({ path: '/api/form-templates/12', method: 'PUT', body: { title: '341 Case Sheet' } });
    expect(() => b.formTemplateRequest({ ...cMeta, meta: { title_to: ' ' } })).toThrow('This card has no usable title.');
    const post = b.formTemplateRequest(cCreate);
    expect([post.path, post.method, post.body.form_key, post.body.title, post.body.link_type]).toEqual(['/api/form-templates', 'POST', 'vehicle_intake', 'Vehicle Intake', 'case']);
    expect(post.body.draft_definition).toBe(cCreate.definition);
    expect(() => b.formTemplateRequest({ ...cCreate, create: { ...cCreate.create, form_key: 'Bad Key' } })).toThrow('This card has no usable form key.');
    expect(() => b.formTemplateRequest({ ...cCreate, expected: { form_key: 'other' } })).toThrow('This card has no usable form key.');
    expect(() => b.formTemplateRequest({ ...cCreate, create: { ...cCreate.create, link_type: 'matter' } })).toThrow('This card has no usable template settings.');
    expect(() => b.formTemplateRequest({ ...cCreate, definition: { tabs: [] } })).toThrow('This card has no usable definition.');
    expect(() => b.formTemplateRequest({ ...cCreate, definition_hash: null })).toThrow('This card has no usable definition.');
  });

  function reads({ tpl = TPL_JSON, versions = VERSIONS.map((v) => ({ id: v.id })), list = [TPL_JSON] } = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (p === '/api/form-templates/12') return { status: 'success', template: tpl };
      if (p === '/api/form-templates/12/versions') return { status: 'success', versions };
      if (p === '/api/form-templates') return { status: 'success', templates: list };
      throw new Error(`unexpected GET ${p}`);
    });
    return { api, gets };
  }

  test('the re-read: the draft that was proposed from passes; a draft saved between proposal and click refuses; a frozen definition that no longer matches its hash refuses before any read', async () => {
    let r = reads();
    expect(await browser(r.api).formTemplatePrecheck(cAdd)).toBe('');
    expect(r.gets).toEqual(['/api/form-templates/12', '/api/form-templates/12/versions']);
    expect(await browser(reads().api).formTemplatePrecheck(cMeta)).toBe('');
    // Someone saved the draft (the very change this card proposes, say) between proposal and click.
    const saved = { ...TPL_JSON, draft_definition: cAdd.next_definition };
    expect(await browser(reads({ tpl: saved }).api).formTemplatePrecheck(cAdd)).toBe('"Case Sheet" (case_sheet) changed since this card was prepared (its draft, published version or visibility). Nothing was written. Ask Casey to read it again.');
    const relabeled = JSON.parse(JSON.stringify(TPL_JSON)); relabeled.draft_definition.sections[0].rows[0].fields[0].label = 'Trustee!';
    expect(await browser(reads({ tpl: relabeled }).api).formTemplatePrecheck(cRem)).toMatch(/changed since this card was prepared/);
    expect(await browser(reads({ tpl: { ...TPL_JSON, title: 'Renamed' } }).api).formTemplatePrecheck(cMeta)).toBe('');  // the title is not in expected; the PUT overwrites it knowingly
    expect(await browser(reads({ tpl: { ...TPL_JSON, updated_at: '2026-11-10T12:00:01.000Z' } }).api).formTemplatePrecheck(cMeta)).toMatch(/changed since this card was prepared/);
    // The frozen definition was altered after the card was prepared: refused on the hash, before any read.
    r = reads();
    const altered = JSON.parse(JSON.stringify(cAdd)); altered.next_definition.sections[0].rows[1].fields[0].label = 'Judge';
    expect(await browser(r.api).formTemplatePrecheck(altered)).toBe('"Case Sheet" (case_sheet) — this card\'s definition is not the one that was reviewed. Nothing was written. Ask Casey to prepare it again.');
    expect(r.gets).toEqual([]);
    const reordered = JSON.parse(JSON.stringify(cAdd)); reordered.next_definition = Object.fromEntries(Object.entries(reordered.next_definition).reverse());
    expect(await browser(reads().api).formTemplatePrecheck(reordered)).toBe('');
  });

  test('a create re-hashes its definition and re-reads the list for its form key', async () => {
    let r = reads();
    expect(await browser(r.api).formTemplatePrecheck(cCreate)).toBe('');
    expect(r.gets).toEqual(['/api/form-templates']);
    expect(await browser(reads({ list: [TPL_JSON, { id: 44, form_key: 'vehicle_intake', title: 'Vehicles' }] }).api).formTemplatePrecheck(cCreate))
      .toBe('A form template with form key "vehicle_intake" already exists (template #44, "Vehicles") — created since this card was prepared. Nothing was written.');
    r = reads();
    const altered = JSON.parse(JSON.stringify(cCreate)); altered.definition.sections[0].rows.push({ fields: [{ name: 'extra', type: 'text', label: 'Extra' }] });
    expect(await browser(r.api).formTemplatePrecheck(altered)).toBe('"Vehicle Intake" (vehicle_intake) — this card\'s definition is not the one that was reviewed. Nothing was written. Ask Casey to prepare it again.');
    expect(r.gets).toEqual([]);
  });

  test('the result checks: the route\'s row must hold the reviewed draft (key order ignored), the reviewed title, the new template\'s key and definition', () => {
    const b = browser(jest.fn());
    const reordered = Object.fromEntries(Object.entries(cAdd.next_definition).reverse());
    expect(b.formTemplateResult(cAdd, { status: 'success', template: { id: 12, draft_definition: reordered } })).toEqual({ template_id: 12 });
    expect(() => b.formTemplateResult(cAdd, { status: 'success', template: { id: 12, draft_definition: DRAFT } })).toThrow('The form templates route stored a different draft than the one reviewed — open it in the form builder');
    expect(() => b.formTemplateResult(cAdd, { status: 'success', template: { id: 13, draft_definition: cAdd.next_definition } })).toThrow('The form templates route did not confirm the reviewed template');
    expect(b.formTemplateResult(cMeta, { status: 'success', template: { id: 12, title: '341 Case Sheet' } })).toEqual({ template_id: 12 });
    expect(() => b.formTemplateResult(cMeta, { status: 'success', template: { id: 12, title: 'Case Sheet' } })).toThrow('The form templates route did not confirm the reviewed title');
    expect(b.formTemplateResult(cCreate, { status: 'success', template: { id: 44, form_key: 'vehicle_intake', draft_definition: cCreate.definition } })).toEqual({ template_id: 44 });
    expect(() => b.formTemplateResult(cCreate, { status: 'success', template: { id: 44, form_key: 'other', draft_definition: cCreate.definition } })).toThrow('The form templates route did not confirm the new template');
    expect(() => b.formTemplateResult(cCreate, { status: 'success', template: { id: 44, form_key: 'vehicle_intake', draft_definition: DRAFT } })).toThrow('The form templates route stored a different definition than the one reviewed — open it in the form builder');
    expect(() => b.formTemplateResult(cCreate, { status: 'error' })).toThrow('The form templates route did not confirm the change');
  });

  test('labels, text, danger, applied copy and entity for the five', () => {
    const b = browser(jest.fn());
    const [fam] = b.families;
    expect([cAdd, cUpd, cRem, cMeta, cCreate].map(b.formTemplateLabel)).toEqual(['Add a form field', 'Change a form field', 'Remove a form field', 'Retitle form template', 'Create form template']);
    expect([fam.danger(cAdd), fam.danger(cUpd), fam.danger(cRem), fam.danger(cMeta), fam.danger(cCreate)]).toEqual([false, false, true, false, false]);
    const text = b.formTemplateText(cAdd);
    expect(text).toContain('Form field add proposal — not applied (the DRAFT changes; nothing publishes)');
    expect(text).toContain('Field: Hearing judge (hearing_judge) — text');
    expect(text).toContain('Placement: a new row (row 2) at the end of section "Case"');
    expect(text).toContain('Draft change: ADDED: Hearing judge (hearing_judge) — text');
    expect(text).toContain('If published afterwards: version 4 (the answer fields change — the version bumps)');
    expect(text).toContain('Writes: the template\'s DRAFT definition only — the whole draft as built when this card was prepared, sent exactly as reviewed; nothing is published, and the published form, its versions and every submission are untouched.');
    expect(b.formTemplateText(cUpd)).toContain('Sets: required');
    expect(b.formTemplateText(cRem)).toContain('Warning: FIELD REMOVED: Trustee name (trustee)');
    expect(b.formTemplateText(cMeta)).toContain('Title: "Case Sheet" → "341 Case Sheet"');
    const ct = b.formTemplateText(cCreate);
    expect(ct).toContain('New template: "Vehicle Intake" (vehicle_intake), a case form — internal, never published');
    expect(ct).toContain('Field: Lender (lender) — select');
    expect(ct).toContain('Stale check: if a template with this form key appears before you apply, nothing is written.');
    expect(b.formTemplateAppliedMessage(cAdd, { template_id: 12 }, false)).toBe('Field "Hearing judge" (hearing_judge) was added to the draft of "Case Sheet" (case_sheet) — nothing is published until the draft is.');
    expect(b.formTemplateAppliedMessage(cRem, { template_id: 12 }, false)).toBe('Field "Trustee name" (trustee) was removed from the draft of "Case Sheet" (case_sheet) — nothing is published until the draft is.');
    expect(b.formTemplateAppliedMessage(cMeta, { template_id: 12 }, false)).toBe('Form template #12 (case_sheet) is now titled "341 Case Sheet" (was "Case Sheet").');
    expect(b.formTemplateAppliedMessage(cCreate, { template_id: 44 }, false)).toBe('"Vehicle Intake" (vehicle_intake) was created as template #44 — never published and internal; publish it (a publish card, or the form builder) once its fields are right.');
    const made = { ...cCreate, result_form_template_id: 44 };
    expect(fam.entity(made)).toEqual({ kind: 'form_template', id: '44', label: '"Vehicle Intake" (vehicle_intake)' });
    expect(fam.appliedCopy(made).status).toBe('Applied — create form template (template #44)');
  });
});
