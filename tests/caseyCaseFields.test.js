'use strict';
/**
 * tests/caseyCaseFields.test.js
 *
 * A7 groups B/C — Casey edits any other case field: case.fields.update.v1 →
 * PATCH /api/cases/:id {<column>: <value>, …} (the user's own route →
 * caseService.updateCase, whose BLOCKED set is exactly case_id). Fred,
 * 2026-11-09: "Casey can edit any field except case_id, just like the user."
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builder, the click-time re-read, the answer check — is in
 * tests/assistantUi.test.js):
 *   1. the casey_record_edits_enabled switch (the A7 family's: '0' = dark);
 *   2. the shape: case_id, changes {column: value} with 1..10 keys, evidence
 *      citing the exact case_id; anything else refused by name;
 *   3. refused BY NAME before anything is read, any capitalisation: case_id,
 *      the columns another card owns (docket, pipeline, folder, notes,
 *      alerts), the derived judge / trustee links, type / subtype, the raw
 *      custom bag, the 341 appointment's projection;
 *   4. the column map is information_schema (here: the CREATE TABLE in
 *      ref/database.sql, parsed) — unknown, computed and unreviewed-type
 *      columns refuse; each value normalized to its column's type: DATE ISO
 *      ('' clears → NULL), DATETIME firm wall time sent as the form sends it,
 *      ENUM exact member, SET members in member order, CHAR / VARCHAR one line
 *      within the width (code points), TEXT within its cap;
 *   5. no-op: a column already holding the value (as MySQL stores it) is not
 *      sent; nothing left refuses;
 *   6. cf_ keys through the route's own splitter (fieldDefService), refused
 *      with its message;
 *   7. the disclosures: before → after, Clears / removes, the code-measured
 *      readers (the client portal), the live scan of stored definitions, the
 *      judge / trustee link updateCase re-resolves (a failed match writes no
 *      link), the 341 link the Case Details form would re-point;
 *   8. updateCase's case.updated envelope dry-run (only when its own
 *      buildChanges finds a change); `expected` / `expected_kinds`;
 *   9. the ledger's STRING receipt, the request detector, the card-size cap.
 *
 * The route behaviour the refusals rest on (the silent varchar clip, '' →
 * NULL on a DATE, the SET read-back order, the judge twin, the `changes`
 * echo) runs on a real engine in tests/caseyCaseFields.mysql.test.js.
 *
 *   npx jest tests/caseyCaseFields.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const fieldDefs = require(path.join(REPO, 'services', 'fieldDefService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const roleResolver = require(path.join(REPO, 'lib', 'caseRoleResolver'));
const pipelineService = require(path.join(REPO, 'services', 'pipelineService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const EVIDENCE = [{ id: 'q1', purpose: 'case', rows: [{ case_id: CASE_ID }, { case_id: 'OTHER123' }] }];

// information_schema.COLUMNS for cases, as the live read returns it — parsed
// from the CREATE TABLE in ref/database.sql (the live schema's dump).
function schemaColumns() {
  const sql = fs.readFileSync(path.join(REPO, 'ref', 'database.sql'), 'utf8');
  const block = /CREATE TABLE `cases` \(\n([\s\S]*?)\n\) ENGINE=/.exec(sql)[1];
  return block.split('\n').map((line) => {
    const m = /^ {2}`([^`]+)` ([a-z]+)(\((?:[^()']|'(?:[^']|'')*')*\))?( unsigned)?(.*)$/.exec(line);
    if (!m) return null;
    const type = m[2];
    const columnType = `${type}${m[3] || ''}${m[4] || ''}`;
    const width = type === 'varchar' || type === 'char' ? Number(/\((\d+)\)/.exec(m[3])[1]) : type === 'text' ? 65535 : null;
    return {
      name: m[1], data_type: type, column_type: columnType, width,
      nullable: / NOT NULL/.test(m[5]) ? 'NO' : 'YES',
      gen_expr: / GENERATED ALWAYS AS /.test(m[5]) ? 'json_value(...)' : '',
    };
  }).filter(Boolean);
}
const COLUMNS = schemaColumns();

const DEFS = [
  { id: 1, entity: 'case', field_key: 'cf_court', label: 'Court', field_type: 'select', options: JSON.stringify([{ value: 'EDMI' }, { value: 'WDMI' }]), validation: null, show_when: null, default_value: null, indexed: 1, list_column: 0, sort_order: 1, active: 1 },
  { id: 2, entity: 'case', field_key: 'cf_clio_matter', label: 'Clio matter', field_type: 'text', options: null, validation: null, show_when: null, default_value: null, indexed: 1, list_column: 0, sort_order: 2, active: 1 },
  { id: 3, entity: 'case', field_key: 'cf_old', label: 'Old', field_type: 'text', options: null, validation: null, show_when: null, default_value: null, indexed: 0, list_column: 0, sort_order: 3, active: 0 },
];

// A7d fixtures: the firm's pipelines (intake #1; Chapter 7 #2 and Chapter 13 #3 by exact type/subtype) and their stage keys.
const TEMPLATES = [
  { id: 1, name: 'Intake', role: 'intake', case_type: null, case_subtype: null, is_default: 0, active: 1 },
  { id: 2, name: 'Chapter 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', is_default: 0, active: 1 },
  { id: 3, name: 'Chapter 13', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 13', is_default: 0, active: 1 },
];
const STAGES = { 2: ['retained', 'filed', 'discharged'], 3: ['retained', 'filed', 'confirmed'] };
const CASE_TYPES = { Bankruptcy: ['Chapter 7', 'Chapter 13'], 'Civil Litigation': [], Adversary: ['Preference'] };

let spies = [];
let calls;
function setup({ caseRow = {}, clients, missing = false, judge = null, trustee = null, names = { 41: 'Hon. Mark Example', 42: 'Hon. Ann Other', 51: 'Tom Trustee', 52: 'Una Trustee' },
  rules = [], evaluate, scans = {}, extraColumns = [], caseTypes = CASE_TYPES } = {}) {
  calls = { getCase: 0, resolveJudge: [], resolveTrustee: [], rules: [], scans: [], queries: 0, stageLookups: [] };
  const row = {
    case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-mex', case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
    case_caption: 'In re Dana Debtor', case_chapter: '7', case_judge: 'Mark Example', case_judge_contact_id: 41,
    case_trustee: 'Tom Trustee', case_trustee_contact_id: 51, case_341_link: 'https://zoom.us/j/111',
    case_file_date: new Date('2026-01-02T00:00:00.000Z'), case_close_date: null, show_cause: null,
    case_garnish: 'Pre-Petition,Post-Petition', case_pre_petition: '', '341_status': 'Continued',
    case_our_role: null, case_source: 'Web', docs_missing: 'pay stubs', '341_notes': '', bk_fee_amounts: null,
    custom: { cf_court: 'EDMI' }, case_notes: 'n', ...caseRow,
  };
  spies = [
    jest.spyOn(caseService, 'getCase').mockImplementation(async (_db, id, include) => {
      calls.getCase += 1;
      expect(include).toBe('contacts');
      if (missing || id !== CASE_ID) return null;
      return { case: { ...row, custom: JSON.parse(JSON.stringify(row.custom)) }, clients: clients || [{ contact_name: 'Dana Debtor', relate_type: 'Primary', contact_ssn: '123-45-6789' }, { contact_name: 'Opp Counsel', relate_type: 'Other' }] };
    }),
    jest.spyOn(roleResolver, 'resolveJudge').mockImplementation(async (_db, args) => { calls.resolveJudge.push(args); return judge; }),
    jest.spyOn(roleResolver, 'resolveTrustee').mockImplementation(async (_db, args) => { calls.resolveTrustee.push(args); return trustee; }),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules.map((r) => ({ ...r })); }),
  ];
  if (evaluate) spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(evaluate));
  const query = jest.fn(async (sql, params) => {
    calls.queries += 1;
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/FROM information_schema\.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = 'cases'$/.test(flat)) return [[...COLUMNS, ...extraColumns]];
    if (/FROM field_defs WHERE entity = \? ORDER BY sort_order ASC, id ASC$/.test(flat)) return [params[0] === 'case' ? DEFS.map((d) => ({ ...d })) : []];
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id IN (?)') {
      return [params[0].filter((n) => names[n]).map((n) => ({ contact_id: n, contact_name: names[n] }))];
    }
    const scan = /FROM (report_definitions|form_templates|portal_cards|pipeline_stage_requirements|sequence_steps|workflow_steps|email_ingest_rule_actions|phone_ingest_rule_actions)\b/.exec(flat);
    if (scan) { calls.scans.push([scan[1], params[0]]); return [scans[scan[1]] || []]; }
    // A7d: pipelineService.resolveTemplate's own read, and the new pipeline's stage lookup.
    if (flat === 'SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC') return [TEMPLATES.map((t) => ({ ...t }))];
    if (flat === 'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1' && params[0] === 'fe-case_types') return [caseTypes === null ? [] : [{ value: JSON.stringify(caseTypes) }]];
    if (flat === 'SELECT stage_key FROM pipeline_stages WHERE template_id = ? AND active = 1 AND stage_key = ? LIMIT 1') {
      calls.stageLookups.push(params); return [(STAGES[params[0]] || []).includes(params[1]) ? [{ stage_key: params[1] }] : []];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
beforeEach(() => { fieldDefs.bump(); delete process.env.CASEY_RECORD_EDITS_ENABLED; });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_RECORD_EDITS_ENABLED; });

const edit = (changes, over = {}) => ({ kind: 'case.fields.update.v1', case_id: CASE_ID, changes, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
let db;
const run = (value, opts, evidence = EVIDENCE) => { db = setup(opts); return normalizeActionDraft(db, value, evidence, { currentUserId: 6 }); };
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);
const w = (draft, column) => draft.writes.find((x) => x.column === column);

describe('the A7 family switch', () => {
  test("'0' makes the kind unavailable before any read; unset is ON", async () => {
    process.env.CASEY_RECORD_EDITS_ENABLED = '0';
    await expect(run(edit({ case_caption: 'In re X' }))).rejects.toThrow(/^Action kind is unavailable$/);
    expect([calls.getCase, calls.queries]).toEqual([0, 0]);
    delete process.env.CASEY_RECORD_EDITS_ENABLED;
    await expect(run(edit({ case_caption: 'In re X' }))).resolves.toMatchObject({ kind: 'case.fields.update.v1', status: 'draft' });
  });
});

describe('the shape', () => {
  test('a column at the top level, or any other key, is refused by name', async () => {
    await refuse({ ...edit({ case_caption: 'x' }), case_file_date: '2026-01-01' }, /^A case fields edit carries unsupported fields: case_file_date — it takes case_id, changes .* every column goes inside "changes"$/);
    await refuse({ ...edit({ case_caption: 'x' }), force: true }, /unsupported fields: force/);
  });
  test('the case id, and changes as a non-empty object', async () => {
    await refuse(edit({ case_caption: 'x' }, { case_id: 'bad id!' }), /needs the case's exact case_id/);
    for (const changes of [null, [], {}, 'case_caption=x']) await refuse(edit(changes), /needs "changes": an object of \{"<column>": <new value>\}/);
    expect(calls.getCase).toBe(0);
  });
  test('at most 10 columns per card', async () => {
    const eleven = Object.fromEntries(['case_caption', 'case_our_role', 'case_source', 'case_source_ref', 'case_primary_reason', 'case_judge', 'case_trustee',
      'case_341_link', 'case_chapter', 'bk_outcome', 'bk_funding_app'].map((k) => [k, 'x']));
    await refuse(edit(eleven), /^A case fields card changes at most 10 columns \(one review per card\) — this one has 11\. Split it into smaller cards$/);
    const ten = { ...eleven }; delete ten.bk_funding_app; ten.case_chapter = '13';
    await expect(run(edit(ten), { trustee: 51 })).resolves.toMatchObject({ kind: 'case.fields.update.v1' });
  });
  test('evidence must cite a row carrying the exact case_id', async () => {
    await refuse(edit({ case_caption: 'x' }, { evidence: [{ query_id: 'q1', row_number: 2 }] }), /does not identify case 7KQ2M9XA — cite a row carrying its exact case_id/);
    expect(calls.getCase).toBe(0);
  });
  test('two keys naming one column (capitalisation aside) refuse', async () => {
    await refuse(edit({ case_caption: 'x', CASE_CAPTION: 'y' }), /^case_caption and CASE_CAPTION name the same column/);
  });
});

describe('refused BY NAME before anything is read', () => {
  test.each([
    ['case_id', /a case's id never changes/],
    ['case_number', /case\.docket\.adopt\.v1 fills a BLANK case number.*Replacing or clearing a docket the case already has is not available to Casey yet \(it is the next slice\)/],
    ['case_number_full', /case\.docket\.adopt\.v1/],
    ['case_stage', /case\.pipeline\.advance\.v1 \/ case\.pipeline\.move\.v1/],
    ['case_status', /the pipeline cards own it/],
    ['case_rec', /the pipeline cards own it/],
    ['pipeline_phase', /the pipeline cards own it/],
    ['case_dropbox', /case\.folder\.relink\.v1/],
    ['case_notes', /case\.notes\.update\.v1/],
    ['case_alerts', /case\.alerts\.update\.v1/],
    ['case_judge_contact_id', /the judge LINK is derived .* Change case_judge instead/],
    ['case_trustee_contact_id', /the trustee LINK is derived .* Change case_trustee instead/],
    ['custom', /by their cf_ keys, never as the whole custom bag/],
    ['case_341_current', /mirrors the live 341 APPOINTMENT \(apptService is its single writer.*appt\.reschedule\.v1/],
    ['341_appt_id', /the id of the live 341 appointment/],
  ])('%s', async (col, re) => {
    await refuse(edit({ case_caption: 'fine', [col]: 'x' }), re);
    await refuse(edit({ [col.toUpperCase()]: 'x' }), new RegExp(`^NOT ON THIS CARD — ${col.toUpperCase()}: `));
    expect([calls.getCase, calls.queries]).toEqual([0, 0]);
  });
});

describe('the column map and each type\'s rule', () => {
  test('an unknown column, a computed one and an unreviewed type refuse', async () => {
    await refuse(edit({ case_colour: 'red' }), /^Not a column of cases: case_colour — use the column names exactly as the cases table has them/);
    await refuse(edit({ case_virtual: 'x' }), /^case_virtual is computed by the database/, { extraColumns: [{ name: 'case_virtual', data_type: 'varchar', column_type: 'varchar(10)', width: 10, nullable: 'YES', gen_expr: 'concat(a)' }] });
    await refuse(edit({ case_score: 3 }), /^case_score is a int column — Casey has no reviewed rule for that type/, { extraColumns: [{ name: 'case_score', data_type: 'int', column_type: 'int', width: null, nullable: 'YES', gen_expr: '' }] });
    expect(calls.getCase).toBe(0);
  });
  test('the map is the live one: every column of the CREATE TABLE is known, the column name is sent as the table spells it', async () => {
    expect(COLUMNS.length).toBeGreaterThan(80);
    const d = await run(edit({ CASE_CAPTION: 'In re Sam' }));
    expect(d.writes.map((x) => [x.column, x.send])).toEqual([['case_caption', 'In re Sam']]);
  });
  test('DATE: one ISO date; "" and null clear (sent null, "Clears"); a non-date and an unreal date refuse', async () => {
    const d = await run(edit({ case_close_date: '2026-03-04', case_file_date: '' }));
    expect(w(d, 'case_close_date')).toMatchObject({ kind: 'date', send: '2026-03-04', from: 'blank', to: '2026-03-04', clears: false });
    expect(w(d, 'case_file_date')).toMatchObject({ kind: 'date', send: null, from: '2026-01-02', to: 'blank', clears: true, removes: true });
    await refuse(edit({ case_close_date: '03/04/2026' }), /^case_close_date is a date — give it as YYYY-MM-DD, or "" to clear it$/);
    await refuse(edit({ case_close_date: '2026-02-30' }), /"2026-02-30" is not a real calendar date/);
  });
  test('DATETIME: firm wall time, sent as the form\'s datetime-local value; a bad hour refuses', async () => {
    const d = await run(edit({ show_cause: '2026-12-01 09:30' }));
    expect(w(d, 'show_cause')).toMatchObject({ kind: 'datetime', send: '2026-12-01T09:30', after: '2026-12-01 09:30:00', to: '2026-12-01 09:30 (firm time)' });
    await refuse(edit({ show_cause: '2026-12-01 24:00' }), /^show_cause is a date and time in FIRM time — give it as YYYY-MM-DD HH:MM/);
    await refuse(edit({ show_cause: '2026-12-01T09:30:15' }), /FIRM time/);
  });
  test('ENUM: an exact member; NOT NULL cannot be cleared', async () => {
    const d = await run(edit({ '341_status': 'Completed' }));
    expect(w(d, '341_status')).toMatchObject({ kind: 'enum', send: 'Completed', from: 'Continued', to: 'Completed' });
    await refuse(edit({ '341_status': 'completed' }), /^341_status must be exactly one of: Continued, Completed/);
    await refuse(edit({ '341_status': '' }), /^341_status cannot be cleared — it always holds one of: Continued, Completed$/);
  });
  test('SET: an array of members, stored comma-joined in MEMBER order; [] clears; a stranger or a repeat refuses', async () => {
    const d = await run(edit({ case_pre_petition: ['Signed', 'Sent'], case_garnish: [] }));
    expect(w(d, 'case_pre_petition')).toMatchObject({ kind: 'set', send: 'Sent,Signed', to: 'Sent, Signed', from: 'none checked', options: ['Sent', 'Signed'] });
    expect(w(d, 'case_garnish')).toMatchObject({ send: '', clears: true, removes: true, to: 'none checked' });
    await refuse(edit({ case_pre_petition: 'Sent' }), /^case_pre_petition is a set of checkboxes — give an array of the checked options \(any of: Sent, Signed\)/);
    await refuse(edit({ case_pre_petition: ['Mailed'] }), /"Mailed" is not one of its options \(Sent, Signed\)/);
    await refuse(edit({ case_pre_petition: ['Sent', 'Sent'] }), /"Sent" is listed twice/);
  });
  test('VARCHAR / CHAR: one line, trimmed, within the width in CODE POINTS; NOT NULL clears to "", nullable to NULL', async () => {
    const d = await run(edit({ case_caption: '  In re Sam  ', case_judge: '', case_source: null, case_chapter: 13 }), { judge: null, trustee: 51 });
    expect([w(d, 'case_caption').send, w(d, 'case_judge').send, w(d, 'case_source').send, w(d, 'case_chapter').send]).toEqual(['In re Sam', '', null, '13']);
    // case_caption is varchar(150): 150 emoji fit (150 code points, 300 UTF-16 units); 151 do not.
    await expect(run(edit({ case_caption: '\u{1F600}'.repeat(150) }))).resolves.toBeTruthy();
    await refuse(edit({ case_caption: '\u{1F600}'.repeat(151) }), /^case_caption ".*…" is 151 characters — the column keeps 150, and the database would save it cut short while the route answers success/);
    await refuse(edit({ case_chapter: '133' }), /is 3 characters — the column keeps 2/);
    await refuse(edit({ case_caption: 'line\nbreak' }), /^case_caption contains a line break or another control character/);
    await refuse(edit({ case_caption: 'tail ' }), /control character/);
    await refuse(edit({ case_caption: { x: 1 } }), /^case_caption must be text$/);
  });
  test('TEXT: line breaks kept, CRLF folded, other control characters refuse; the cap is noteLimits\' / the form\'s maxlength / 10,000', async () => {
    const d = await run(edit({ bk_fee_amounts: 'a\r\nb\tc' }));
    expect(w(d, 'bk_fee_amounts')).toMatchObject({ kind: 'text', send: 'a\nb\tc', clears: false });
    await refuse(edit({ bk_fee_amounts: 'a\u0007b' }), /^bk_fee_amounts contains a control character/);
    await expect(run(edit({ '341_notes': 'x'.repeat(10000) }))).resolves.toBeTruthy();
    await refuse(edit({ '341_notes': 'x'.repeat(10001) }), /^341_notes would be 10,001 characters — the limit is 10,000/);
    await expect(run(edit({ docs_missing: 'x'.repeat(2000) }))).resolves.toBeTruthy();
    await refuse(edit({ docs_missing: 'x'.repeat(2001) }), /^docs_missing would be 2,001 characters — the limit is 2,000/);
    await refuse(edit({ bk_fee_amounts: 'x'.repeat(10001) }), /^bk_fee_amounts would be 10,001 characters — the limit is 10,000/);
  });
  test('a text change that drops stored characters is a removal; a pure insert is not', async () => {
    const add = await run(edit({ docs_missing: 'pay stubs, bank statements' }));
    expect(w(add, 'docs_missing')).toMatchObject({ removes: false, before: 'pay stubs', after: 'pay stubs, bank statements' });
    const cut = await run(edit({ docs_missing: 'pay' }));
    expect(w(cut, 'docs_missing').removes).toBe(true);
  });
});

describe('no-op: compared the way MySQL stores the value', () => {
  test('every value already there refuses, naming each', async () => {
    await refuse(edit({ case_garnish: ['Post-Petition', 'Pre-Petition'], case_file_date: '2026-01-02', case_source: 'Web', case_our_role: '', case_primary_reason: null }),
      /^That changes nothing on case 25-12345-mex — case_garnish is already Pre-Petition, Post-Petition; case_file_date is already 2026-01-02; case_source is already "Web"; case_our_role is already blank; case_primary_reason is already blank$/,
      { caseRow: { case_primary_reason: '' } });
  });
  test('a column already holding the value is not sent and is listed as kept', async () => {
    const d = await run(edit({ case_source: 'Web', case_caption: 'In re Sam' }));
    expect(d.writes.map((x) => x.column)).toEqual(['case_caption']);
    expect(d.kept).toEqual([{ column: 'case_source', label: 'case_source', shown: '"Web"' }]);
  });
});

describe('custom fields through the route\'s own splitter', () => {
  test('a valid value, a clear of a stored value, the label', async () => {
    const d = await run(edit({ cf_court: 'wdmi', cf_clio_matter: 'M-9' }));
    expect(w(d, 'cf_court')).toMatchObject({ kind: 'custom', label: 'Court (cf_court)', send: 'WDMI', from: '"EDMI"', to: '"WDMI"', before: '"EDMI"', after: '"WDMI"' });
    expect(w(d, 'cf_clio_matter')).toMatchObject({ send: 'M-9', from: 'blank' });
    const c = await run(edit({ cf_court: '' }));
    expect(w(c, 'cf_court')).toMatchObject({ send: null, clears: true, removes: true, to: 'blank' });
  });
  test('the route\'s 400s — unknown, inactive, an invalid value — are the refusal, with its words', async () => {
    await refuse(edit({ cf_nope: 'x' }), /^CUSTOM FIELD refused — unknown custom field\(s\) on case: cf_nope\. Nothing is proposed$/);
    await refuse(edit({ cf_old: 'x' }), /inactive custom field\(s\) on case: cf_old/);
    await refuse(edit({ cf_court: 'XXMI' }), /cf_court: "XXMI" is not one of its options \(EDMI, WDMI\)/);
  });
  test('an unchanged custom value is not sent', async () => {
    await refuse(edit({ cf_court: 'EDMI' }), /That changes nothing on case .* cf_court is already "EDMI"/);
  });
});

describe('the judge and trustee links updateCase re-resolves', () => {
  test('a case_judge write re-resolves from the post-state; a changed link is a danger warning', async () => {
    const d = await run(edit({ case_judge: 'Ann Other' }), { judge: 42 });
    expect(calls.resolveJudge).toEqual([{ case_number_full: '25-12345-mex', case_judge: 'Ann Other' }]);
    expect(d.judge).toEqual({ from: 41, to: 42, from_label: 'Hon. Mark Example (contact #41)', to_label: 'Hon. Ann Other (contact #42)' });
    expect(d.warnings).toContain('JUDGE LINK CHANGES: re-resolved from the full case number\'s judge suffix, else the new judge text — Hon. Mark Example (contact #41) → Hon. Ann Other (contact #42).');
  });
  test('no match writes NO link — said as a warning when a link existed', async () => {
    const d = await run(edit({ case_judge: 'Nobody' }), { judge: null });
    expect(d.judge.to).toBeNull();
    expect(d.warnings.join('\n')).toMatch(/^JUDGE LINK CLEARS: .* finds no match, so the link is written EMPTY — Hon\. Mark Example \(contact #41\) → none\. A failed match writes no link; it is never an error\.$/m);
  });
  test('unchanged, and none → X, are plain effects', async () => {
    const same = await run(edit({ case_judge: 'M. Example' }), { judge: 41 });
    expect(same.warnings).toEqual([]);
    expect(same.effects).toContain('Judge link: re-resolved from the full case number\'s judge suffix, else the new judge text — unchanged (Hon. Mark Example (contact #41)).');
    const fresh = await run(edit({ case_judge: 'Ann Other' }), { judge: 42, caseRow: { case_judge_contact_id: null } });
    expect(fresh.effects).toContain('Judge link: re-resolved from the full case number\'s judge suffix, else the new judge text — none → Hon. Ann Other (contact #42).');
  });
  test('an unrelated column re-resolves nothing', async () => {
    const d = await run(edit({ case_caption: 'In re Sam', case_chapter: '13' }));
    expect([calls.resolveJudge, calls.resolveTrustee, d.judge, d.trustee]).toEqual([[], [], null, null]);
  });
  test('a case_trustee write re-resolves with the POST-state chapter; the 341 link it leaves is a warning', async () => {
    const d = await run(edit({ case_trustee: 'Una Trustee', case_chapter: '13' }), { trustee: 52 });
    expect(calls.resolveTrustee).toEqual([{ case_trustee: 'Una Trustee', case_chapter: '13' }]);
    expect(d.warnings).toContain('TRUSTEE LINK CHANGES: re-resolved from the new trustee text and the case\'s chapter (13) — Tom Trustee (contact #51) → Una Trustee (contact #52).');
    expect(d.warnings.join('\n')).toMatch(/341 LINK STAYS: the Case Details form rewrites the 341 meeting link .* keeps linking to "https:\/\/zoom\.us\/j\/111"\. Add case_341_link to the card/);
    const both = await run(edit({ case_trustee: 'Una Trustee', case_341_link: 'https://zoom.us/j/222' }), { trustee: 52 });
    expect(both.warnings.join('\n')).not.toMatch(/341 LINK STAYS/);
    const none = await run(edit({ case_trustee: 'Una Trustee' }), { trustee: 52, caseRow: { case_341_link: '' } });
    expect(none.warnings.join('\n')).not.toMatch(/341 LINK/);
    expect(none.effects.join('\n')).toMatch(/341 link: the case has none, and this card does not set one/);
  });
});

describe('A7d — case type and subtype, as the case page edits them', () => {
  let pipeSpy;
  beforeEach(() => { pipeSpy = jest.spyOn(pipelineService, 'getPipeline').mockImplementation(async () => ({ current: { stage_key: 'filed' } })); });
  afterEach(() => { pipeSpy.mockRestore(); });
  const retained = { pipeline_phase: 'case' };

  test('they are no longer refused; a subtype change inside the same type re-resolves to another pipeline — a danger warning names both and says the current stage exists there', async () => {
    const d = await run(edit({ case_subtype: 'Chapter 13' }), { caseRow: retained });
    expect(w(d, 'case_subtype')).toMatchObject({ from: '"Chapter 7"', to: '"Chapter 13"', clears: false });
    expect(d.warnings).toEqual([expect.stringMatching(/^PIPELINE CHANGES: the case resolves to Chapter 7 \(case\) → Chapter 13 \(case\) \(type \/ subtype pick the pipeline\)\. Its current stage "filed" exists on Chapter 13 too, so it keeps its position there\. No stage-log row is written and no step is checked — the case page's "Move to another pipeline…" does both; this edit does neither\.$/)]);
    expect(calls.stageLookups).toEqual([[3, 'filed']]);
    expect(d.expected).toMatchObject({ case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(w(d, 'case_subtype').readers[0]).toMatch(/^Pipeline: with case_type it picks the chapter pipeline/);
  });

  test('a stage the new pipeline lacks is said to go unstaged; an intake case says the change moves its projection', async () => {
    pipeSpy.mockImplementation(async () => ({ current: { stage_key: 'discharged' } }));
    const d = await run(edit({ case_subtype: 'Chapter 13' }), { caseRow: retained });
    expect(d.warnings[0]).toMatch(/Its current stage "discharged" is NOT a stage of Chapter 13: the case page's Pipeline widget and the board show it off the pipeline \(unstaged\) until someone moves it onto a stage of Chapter 13\./);
    // Intake: resolveTemplate answers Intake either way, so the pipeline line is an effect, not a warning.
    const lead = await run(edit({ case_subtype: 'Chapter 13' }), { caseRow: { pipeline_phase: 'intake' } });
    expect(lead.warnings).toEqual([]);
    expect(lead.effects).toContain('Pipeline: still resolves to Intake (intake) after the change.');
  });

  test('a type change without a subtype on the card clears the subtype too — the case page\'s own coupling — and says so; naming a subtype keeps it', async () => {
    const d = await run(edit({ case_type: 'Civil Litigation' }), { caseRow: retained });
    expect(d.writes.map((x) => [x.column, x.send, !!x.implied])).toEqual([['case_type', 'Civil Litigation', false], ['case_subtype', '', true]]);
    expect(d.effects).toContain('Subtype cleared with the type: "Chapter 7" → blank — a refinement never carries across types (the case page does the same when the type changes). Name case_subtype on the card to set one instead.');
    expect(d.warnings).toEqual([expect.stringMatching(/^PIPELINE CHANGES: the case resolves to Chapter 7 \(case\) → Intake \(intake\)/)]);
    expect(w(d, 'case_type').readers[0]).toMatch(/^CLIENT PORTAL — the client sees this: the portal titles the case "Chapter <chapter> <type>"/);
    expect(w(d, 'case_type').client_visible).toBe(true);
    const both = await run(edit({ case_type: 'Adversary', case_subtype: 'Preference' }), { caseRow: retained });
    expect(both.writes.map((x) => [x.column, x.send])).toEqual([['case_type', 'Adversary'], ['case_subtype', 'Preference']]);
    expect(both.writes.some((x) => x.implied)).toBe(false);
    // A type change onto a case with no subtype implies nothing.
    const bare = await run(edit({ case_type: 'Adversary' }), { caseRow: { ...retained, case_subtype: null } });
    expect(bare.writes.map((x) => x.column)).toEqual(['case_type']);
  });

  test('an unlisted type or subtype is a WARNING, never a refusal (the create forms allow a free-typed one); an unreadable list says so', async () => {
    const d = await run(edit({ case_type: 'potato hunting' }), { caseRow: retained });
    expect(d.warnings).toEqual(expect.arrayContaining([
      'UNLISTED TYPE: "potato hunting" is not one of the firm\'s case types (Bankruptcy, Civil Litigation, Adversary) — the create forms allow a free-typed type, so the case page\'s Type select will show it as an extra option, Types & Subtypes does not know it, and no chapter pipeline can match it.',
    ]));
    const s = await run(edit({ case_subtype: 'Chapter 11' }), { caseRow: retained });
    expect(s.warnings).toEqual(expect.arrayContaining([
      'UNLISTED SUBTYPE: "Chapter 11" is not a subtype of Bankruptcy (Chapter 7, Chapter 13) — the Subtype select will show it as an extra option, and no chapter pipeline can match it.',
      expect.stringMatching(/^PIPELINE CHANGES: the case resolves to Chapter 7 \(case\) → Intake \(intake\)/),
    ]));
    const cleared = await run(edit({ case_type: '' }), { caseRow: retained });
    expect(cleared.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^TYPE CLEARS: the case will have no type/)]));
    const blind = await run(edit({ case_subtype: 'Chapter 13' }), { caseRow: retained, caseTypes: null });
    expect(blind.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^CASE TYPE LIST UNREADABLE/)]));
  });
});

describe('who reads each column', () => {
  test('the code-measured surfaces: the client portal reads case_chapter, case_341_link and case_open_date', async () => {
    const d = await run(edit({ case_chapter: '13', case_341_link: 'https://zoom.us/j/9', case_open_date: '2026-02-02', bk_outcome: 'x' }));
    expect(w(d, 'case_chapter').readers[0]).toBe('CLIENT PORTAL — the client sees this: the portal titles the case "Chapter <chapter> <type>" (blank chapter: the type alone).');
    expect(w(d, 'case_341_link').readers[0]).toMatch(/^CLIENT PORTAL — the client sees this: the portal's 341 meeting card links to it/);
    expect(w(d, 'case_open_date').readers[0]).toMatch(/^CLIENT PORTAL: it orders the client's list of cases/);
    expect(d.writes.map((x) => [x.column, x.client_visible])).toEqual([['case_chapter', true], ['case_341_link', true], ['case_open_date', true], ['bk_outcome', false]]);
    expect(w(d, 'bk_outcome').readers).toEqual(['Templates: {{cases.bk_outcome}} in letters, forms, emails and texts resolves to the new value.']);
  });
  test('the live scan: one word-bounded pattern over every definition table; each hit lands on the column it names', async () => {
    const d = await run(edit({ case_file_date: '2026-05-05', docs_due: '2026-06-01' }), { scans: {
      report_definitions: [{ id: 10, name: 'Filed cases', body: 'SELECT case_file_date FROM cases' }],
      pipeline_stage_requirements: [{ id: 7, name: 'Petition filed (stage "Filed")', body: '{"field": "case_file_date"}' }],
      portal_cards: [{ id: 3, name: 'docs — Docs', body: '{"field":"cases.docs_due"}' }],
      workflow_steps: [{ id: 9, name: 'workflow #4 step 2', body: '{"x":"{{cases.docs_due_x}}"}' }],
    } });
    expect(calls.scans.map((s) => s[0])).toEqual(['report_definitions', 'form_templates', 'portal_cards', 'pipeline_stage_requirements', 'sequence_steps', 'workflow_steps', 'email_ingest_rule_actions', 'phone_ingest_rule_actions']);
    expect(new Set(calls.scans.map((s) => s[1]))).toEqual(new Set(['(^|[^A-Za-z0-9_])(case_file_date|docs_due)([^A-Za-z0-9_]|$)']));
    expect(w(d, 'case_file_date').readers).toEqual([
      'Court email fills it only while it is blank.',
      'Report #10 "Filed cases" names it.',
      'Pipeline step #7 "Petition filed (stage "Filed")" names it.',
      'Templates: {{cases.case_file_date}} in letters, forms, emails and texts resolves to the new value.',
    ]);
    // docs_due_x is another word: not a hit for docs_due.
    expect(w(d, 'docs_due').readers).toEqual(['CLIENT PORTAL card #3 "docs — Docs" names it.', 'Templates: {{cases.docs_due}} in letters, forms, emails and texts resolves to the new value.']);
    expect(w(d, 'docs_due').client_visible).toBe(true);
  });
});

describe('the case.updated dry run and freshness', () => {
  test('updateCase\'s envelope: source manual, the actor, changes incl. the re-resolved link, updated_fields in body order', async () => {
    let seen;
    const d = await run(edit({ case_judge: 'Ann Other', cf_court: 'WDMI' }), { judge: 42, rules: [{ id: 5, name: 'Judge changed', actions: [{ action_type: 'workflow', config: { workflow_id: 12 } }] }],
      evaluate: async (_rule, env) => { seen = env; return { matched: true, transform_ok: true }; } });
    expect(calls.rules).toEqual(['case.updated']);
    expect(seen).toMatchObject({ event: 'case.updated', case_id: CASE_ID, source: 'manual', actor: { user_id: 6 } });
    expect(seen.changes).toEqual({ case_judge: { from: 'Mark Example', to: 'Ann Other' }, case_judge_contact_id: { from: 41, to: 42 }, cf_court: { from: 'EDMI', to: 'WDMI' } });
    expect(seen.extra).toEqual({ updated_fields: ['case_judge', 'case_judge_contact_id', 'cf_court'] });
    expect(seen.data).toMatchObject({ case_judge: 'Ann Other', case_judge_contact_id: 42, cf_court: 'WDMI' });
    expect(d.automation).toEqual({ events: ['case.updated'], lines: ['Trigger rule #5 "Judge changed" runs: starts workflow #12'], rules_checked: 1, quiet: 0 });
    expect(d.effects).toContain('Trigger event: case.updated fires (source "manual", as a hand edit does) — every active rule on it that would act is listed below.');
  });
  test('a rule that cannot be evaluated is a danger warning', async () => {
    const d = await run(edit({ case_caption: 'x' }), { rules: [{ id: 6, name: 'Broken', actions: [] }], evaluate: async () => ({ matched: false, match_error: 'bad path' }) });
    expect(d.warnings).toContain('AUTOMATION: at least one trigger rule could not be evaluated for this edit — read its line; it may run.');
  });
  test('no event when updateCase\'s own comparison sees no change (ends trimmed)', async () => {
    const d = await run(edit({ case_source: 'Web' }), { caseRow: { case_source: 'Web ' } });
    expect(d.writes.map((x) => [x.column, x.send])).toEqual([['case_source', 'Web']]);
    expect([calls.rules, d.automation.events]).toEqual([[], []]);
    expect(d.effects).toContain('Trigger event: none — updateCase emits case.updated only when a value changes by its own comparison (blank and empty alike, spaces at the ends ignored).');
  });
  test('expected: each touched column as stored, the type / subtype, and what a re-resolved link rests on', async () => {
    const d = await run(edit({ case_file_date: '2026-05-05', case_judge: 'Ann Other', case_trustee: 'Una Trustee', cf_court: 'WDMI' }), { judge: 42, trustee: 52 });
    expect(d.expected).toEqual({
      case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_file_date: '2026-01-02', case_judge: 'Mark Example', case_trustee: 'Tom Trustee', cf_court: '"EDMI"',
      case_number_full: '25-12345-mex', case_judge_contact_id: '41', case_chapter: '7', case_341_link: 'https://zoom.us/j/111', case_trustee_contact_id: '51',
    });
    expect(d.expected_kinds).toMatchObject({ case_file_date: 'date', case_judge: 'string', cf_court: 'custom', case_type: 'string', case_judge_contact_id: 'string' });
    expect(d.case).toEqual({ case_id: CASE_ID, label: '25-12345-mex', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', clients: ['Dana Debtor'] });
    expect(JSON.stringify(d)).not.toContain('123-45-6789');
  });
  test('a gone case refuses', async () => {
    await refuse(edit({ case_caption: 'x' }), /^Case 7KQ2M9XA no longer exists$/, { missing: true });
  });
  test('the card-size cap', async () => {
    await refuse(edit({ bk_fee_amounts: 'a'.repeat(10000), bk_fee_dates_due: 'b'.repeat(10000), '341_notes': 'c'.repeat(10000) }),
      /^This card would be [\d,]+ characters — more than one card can carry \(60,000\); its long text columns do not fit beside each other/);
    await expect(run(edit({ bk_fee_amounts: 'a'.repeat(10000), bk_fee_dates_due: 'b'.repeat(10000) }))).resolves.toBeTruthy();
  });
});

describe('ledger and detector', () => {
  test('the ledger receipts the STRING case_id', () => {
    expect(ledger.KINDS.get('case.fields.update.v1')).toBe('case_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('case_id')).toBe(true);
  });
  test('the request detector: a case field with a case noun and an edit verb', () => {
    expect(taskDraftRequested('set the file date on the Smith case to 2026-03-01')).toBe(true);
    expect(taskDraftRequested('change the trustee on her case to Una Trustee')).toBe(true);
    expect(taskDraftRequested('clear the show cause date on this file')).toBe(true);
    expect(taskDraftRequested('what is the file date on the Smith case?')).toBe(false);
  });
});
