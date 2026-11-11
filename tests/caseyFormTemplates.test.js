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
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: ME });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);
const NEVER = { definition: null, published_at: null, schema_version: 1 };

describe('the switch, the by-name refusals and the evidence', () => {
  test("'0' makes all four kinds unavailable; casey_forms_enabled does not reach them", async () => {
    process.env.CASEY_FORM_TEMPLATES_ENABLED = '0';
    for (const card of [publish(), visibility('public'), restore(), del()]) await refuse(card, /^Action kind is unavailable$/);
    expect(calls.sql).toEqual([]);
    delete process.env.CASEY_FORM_TEMPLATES_ENABLED;
    process.env.CASEY_FORMS_ENABLED = '0';
    await expect(run(publish())).resolves.toMatchObject({ kind: 'form.template.publish.v1', status: 'draft' });
  });

  test('editing a definition is refused by name, unknown keys too — before anything is read', async () => {
    for (const card of [publish({ draft_definition: {} }), visibility('public', { title: 'X' }), restore(300, { definition: {} }), del({ form_key: 'x' })]) {
      await refuse(card, /^TEMPLATE EDITING refused \(\w+\): Casey publishes, changes the visibility of, restores a version of or deletes a template — it never edits a definition, title or form_key, and never creates a template\. A definition is a large JSON the form builder edits visually, and a card cannot review it line by line/);
    }
    await refuse(publish({ visibility: 'public' }), /^A form template publish card carries unsupported fields: visibility — it takes template_id and evidence only \(each template card does ONE thing: publish the draft — form\.template\.publish\.v1, change the visibility — form\.template\.visibility\.v1/);
    await refuse(del({ again: true }), /^A form template delete card carries unsupported fields: again — it takes template_id and evidence only/);
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

describe('the ledger and the request detector', () => {
  test('all four receipt the template id', () => {
    for (const k of ['publish', 'visibility', 'restore', 'delete']) expect(ledger.KINDS.get(`form.template.${k}.v1`)).toBe('template_id');
  });
  test('template verbs force the draft path; a question does not', () => {
    for (const q of ['publish the case sheet form', 'make the intake form public', 'take the questionnaire down', 'restore version 2 of the 341 notes', 'delete that form template', 'roll back the intake form']) {
      expect({ q, draft: taskDraftRequested(q, []) }).toEqual({ q, draft: true });
    }
    for (const q of ['is the intake form public?', 'when was the case sheet form published?']) expect({ q, draft: taskDraftRequested(q, []) }).toEqual({ q, draft: false });
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
const CONSTS = ['FORM_TEMPLATE_ACTION_KINDS', 'FORM_TEMPLATE_VISIBILITIES'];
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
      ['form.template.publish.v1', 'form.template.visibility.v1', 'form.template.restore.v1', 'form.template.delete.v1'], 'template_id', 'result_form_template_id', false]);
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
