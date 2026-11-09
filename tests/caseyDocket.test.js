'use strict';
/**
 * tests/caseyDocket.test.js
 *
 * A7c — Casey adopts a docket: case.docket.adopt.v1 fills ONE case's BLANK
 * case_number and/or case_number_full with the number exactly as the user gave
 * it, through PATCH /api/cases/:id/docket {case_number?, case_number_full?}
 * (the court-review adopt flow's own collision-checked route; never the
 * generic cases PATCH).
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builder, the click-time re-read, the outcome mapping — is in
 * tests/assistantUi.test.js):
 *   1. the casey_case_docket_enabled switch ('0' = dark; unset = on);
 *   2. refused BY NAME before anything is read: a replace / clear key, any
 *      other case field (status, stage, dates, trustee, judge, tags, type),
 *      any other unknown key;
 *   3. the values: text only, one line, no control character anywhere (edges
 *      included), at most 20 characters counted as code points; blank = not
 *      supplied; at least one; the evidence citing the exact case_id;
 *   4. the route's adopt-only rule word for word (trimmed, exact): a column
 *      holding a DIFFERENT value refuses naming it; a column holding exactly
 *      the value is not sent; nothing to fill is a no-op refusal;
 *   5. the route's collision rule run first through the route's OWN function
 *      (caseService.checkCaseNumberCollision), over exactly the columns sent;
 *      the other case and both its values are named;
 *   6. the disclosures: the header, the Cases list (blank when the full
 *      number is stored as ''), the portal (who sees it), the Documents
 *      badge, court email, the caption, templates; the judge link a full
 *      number re-resolves (a change of an existing link is a danger warning);
 *   7. the case.updated envelope updateCase emits, dry-run against the active
 *      rules (runs / may run); `expected` keeps NULL and '' apart;
 *   8. the ledger receipt is the STRING case_id; the request detector.
 *
 * The route behaviour the refusals rest on (the adopt-only 409, the collision
 * 409 across both columns, the write of only the submitted column, the
 * `changes` echo, the judge re-resolution) runs on a real engine in
 * tests/caseyDocket.mysql.test.js.
 *
 *   npx jest tests/caseyDocket.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const roleResolver = require(path.join(REPO, 'lib', 'caseRoleResolver'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const EVIDENCE = [{ id: 'q1', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: null }, { case_id: 'OTHER123' }] }];

let spies = [];
let calls;
function setup({ caseRow = {}, clients, missing = false, conflict = null, judge = null, judgeNames = { 41: 'Hon. Mark Example', 42: 'Hon. Other Judge' },
  rules = [], evaluate, filed = { events: 0, log: 0 } } = {}) {
  calls = { getCase: 0, collision: [], resolve: [], rules: [], filed: [] };
  const row = { case_id: CASE_ID, case_number: null, case_number_full: null, case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
    case_caption: '', case_judge: '', case_judge_contact_id: null, case_notes: 'n', custom: '{}', ...caseRow };
  spies = [
    jest.spyOn(caseService, 'getCase').mockImplementation(async (_db, id, include) => {
      calls.getCase += 1;
      expect(include).toBe('contacts');
      if (missing || id !== CASE_ID) return null;
      return { case: { ...row }, clients: clients || [{ contact_name: 'Dana Debtor', relate_type: 'Primary', contact_ssn: '123-45-6789' }, { contact_name: 'Opp Counsel', relate_type: 'Other' }] };
    }),
    jest.spyOn(caseService, 'checkCaseNumberCollision').mockImplementation(async (_db, id, vals) => { calls.collision.push([id, vals]); return conflict; }),
    jest.spyOn(roleResolver, 'resolveJudge').mockImplementation(async (_db, args) => { calls.resolve.push(args); return judge; }),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules.map((r) => ({ ...r })); }),
  ];
  if (evaluate) spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(evaluate));
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id IN (?)') {
      return [params[0].filter((n) => judgeNames[n]).map((n) => ({ contact_id: n, contact_name: judgeNames[n] }))];
    }
    if (flat === "SELECT COUNT(*) AS n FROM events WHERE event_link_type = 'case_number' AND event_link_id IN (?)") {
      calls.filed.push(['events', params]);
      return [[{ n: filed.events }]];
    }
    if (flat === "SELECT COUNT(*) AS n FROM log WHERE (log_link_type = 'case' AND log_link_id IN (?)) OR (log_link_type IS NULL AND log_link IN (?)) OR (log_about_type = 'case' AND log_about_id IN (?))") {
      calls.filed.push(['log', params]);
      return [[{ n: filed.log }]];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CASE_DOCKET_ENABLED; });

const adopt = (over = {}) => ({ kind: 'case.docket.adopt.v1', case_id: CASE_ID, case_number: '25-12345', evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: 6 });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes the kind unavailable; unset is ON", async () => {
    process.env.CASEY_CASE_DOCKET_ENABLED = '0';
    await expect(run(adopt())).rejects.toThrow(/^Action kind is unavailable$/);
    expect(calls.getCase).toBe(0);
    delete process.env.CASEY_CASE_DOCKET_ENABLED;
    await expect(run(adopt())).resolves.toMatchObject({ kind: 'case.docket.adopt.v1', status: 'draft' });
  });
});

describe('refused by name before anything is read', () => {
  test.each([['replace'], ['clear_case_number'], ['overwrite'], ['force'], ['remove_full']])('a replace / clear key (%s)', async (k) => {
    await refuse(adopt({ [k]: true }), new RegExp(`^REPLACING OR CLEARING A DOCKET refused \\(${k}\\): a docket card only fills a BLANK`));
    expect(calls.getCase).toBe(0);
  });
  test.each([['case_status'], ['case_stage'], ['case_file_date'], ['case_trustee'], ['case_judge'], ['tags'], ['case_type'], ['case_chapter']])('another case field (%s)', async (k) => {
    await refuse(adopt({ [k]: 'x' }), new RegExp(`^OTHER CASE FIELDS refused \\(${k}\\): a docket card sets only case_number and case_number_full`));
    expect(calls.getCase).toBe(0);
  });
  test('any other unknown key', async () => {
    await refuse(adopt({ foo: 1 }), 'A docket card carries unsupported fields: foo — it takes case_id, case_number, case_number_full and evidence only');
    expect(calls.getCase).toBe(0);
  });
});

describe('the values, the case id and the evidence', () => {
  test('text only', async () => {
    await refuse(adopt({ case_number: 2512345 }), 'The case number must be text, exactly as the user gave it');
    expect(calls.getCase).toBe(0);
  });
  test.each([
    ['an inner control character', '25-12\u000145'],
    ['a trailing line break', '25-12345\n'],
    ['a leading tab', '\t25-12345'],
    ['a DEL', '25-12345\u007f'],
    ['a C1 control', '25-\u008512345'],
    ['a line separator', '25-12345\u2028more'],
  ])('%s refuses (edges included — the route would trim some of them away)', async (_n, v) => {
    await refuse(adopt({ case_number_full: v, case_number: undefined }), 'The full case number contains a line break or another control character — a docket is one line of plain text');
    expect(calls.getCase).toBe(0);
  });
  test('the width is 20 characters counted as code points (the varchar counts); spaces at the edges are trimmed first', async () => {
    await refuse(adopt({ case_number: 'x'.repeat(21) }), `The case number "${'x'.repeat(21)}" is 21 characters — the column keeps 20, and the database would save it cut short`);
    const c = await run(adopt({ case_number: `  ${'\u{1F4C1}'.repeat(20)}  ` }));
    expect(c.writes).toEqual({ case_number: { from: null, to: '\u{1F4C1}'.repeat(20) } });
  });
  test('blank is not supplied; at least one number is required', async () => {
    await refuse(adopt({ case_number: '   ', case_number_full: '' }), /^A docket card needs "case_number" and\/or "case_number_full"/);
    await refuse(adopt({ case_number: null }), /^A docket card needs "case_number" and\/or "case_number_full"/);
    expect(calls.getCase).toBe(0);
  });
  test('the exact case_id, cited by the evidence', async () => {
    await refuse(adopt({ case_id: 'bad id!' }), "A docket card needs the case's exact case_id");
    await refuse(adopt({ evidence: [{ query_id: 'q1', row_number: 2 }] }), `The docket evidence does not identify case ${CASE_ID} — cite a row carrying its exact case_id`);
    expect(calls.getCase).toBe(0);
  });
  test('a case that no longer exists', async () => {
    await refuse(adopt(), `Case ${CASE_ID} no longer exists`, { missing: true });
  });
});

describe('the route\'s adopt-only rule, word for word', () => {
  test('a column holding a DIFFERENT value refuses, naming the stored value; the collision check never runs', async () => {
    await refuse(adopt(), 'REPLACING refused: case 25-11111 already has a case number ("25-11111"), and "25-12345" is different. Casey only fills a blank number',
      { caseRow: { case_number: '25-11111' } });
    expect(calls.collision).toEqual([]);
    // Exact, like the route: a capitalisation difference is a replacement too.
    await refuse(adopt({ case_number: undefined, case_number_full: '25-12345-ABC' }), 'already has a full case number ("25-12345-abc")',
      { caseRow: { case_number_full: '25-12345-abc' } });
  });
  test('a column already holding exactly the value (stored with spaces) is not sent; nothing to fill is a no-op', async () => {
    const c = await run(adopt({ case_number_full: '25-12345-abc' }), { caseRow: { case_number: ' 25-12345 ' } });
    expect([c.writes, c.kept]).toEqual([{ case_number_full: { from: null, to: '25-12345-abc' } }, [{ column: 'case_number', value: '25-12345' }]]);
    expect(c.effects[0]).toBe('Case number: already "25-12345" — not sent.');
    expect(calls.collision).toEqual([[CASE_ID, { case_number: null, case_number_full: '25-12345-abc' }]]);
    await refuse(adopt({ case_number_full: '25-12345-abc' }), `Case 25-12345-abc already has case number "25-12345" and full case number "25-12345-abc" — that changes nothing`,
      { caseRow: { case_number: '25-12345', case_number_full: '25-12345-abc' } });
  });
});

describe('the route\'s collision rule, through the route\'s own function', () => {
  test('another case holding the number refuses, naming that case and both its values', async () => {
    await refuse(adopt({ case_number_full: '25-12345-abc' }),
      'ANOTHER CASE HOLDS IT: "25-12345" is already on case ZZZ99999 (Bankruptcy) — its case number is blank, its full case number "25-12345". Two cases cannot share a docket',
      { conflict: { case_id: 'ZZZ99999', case_number: '', case_number_full: '25-12345', case_type: 'Bankruptcy' } });
    expect(calls.collision).toEqual([[CASE_ID, { case_number: '25-12345', case_number_full: '25-12345-abc' }]]);
  });
});

describe('the card: values, readers, the judge link, automation, expected', () => {
  test('a case number on a blank case: every reader, NULL kept apart from empty text', async () => {
    const c = await run(adopt(), { caseRow: { case_number: '', case_number_full: null } });
    expect(c.writes).toEqual({ case_number: { from: '', to: '25-12345' } });
    expect(c.expected).toEqual({ case_number: '', case_number_full: null, case_type: 'Bankruptcy' });
    expect(c.current).toEqual({ case_number: '', case_number_full: null });
    expect(c.judge).toBe(null);
    expect(calls.resolve).toEqual([]);
    expect(c.effects).toEqual([
      'Case page header: "Not Filed" → "25-12345" (it shows the full case number, else the case number).',
      `Cases list: the Case Number column reads "25-12345" (was "${CASE_ID}"), and searching by the number finds the case.`,
      'Client portal: the case\'s docket line reads "25-12345" for Dana Debtor (its Primary / Secondary contacts) once they sign in; portal cards that show the case number read it too.',
      `Documents: each Documents tab badges this case's documents "case 25-12345" (was "case ${CASE_ID}"), and the Dropbox relink panel's docket match looks for folders whose name contains the number.`,
      'Court email: the court-email pipeline matches incoming court mail to cases by these two columns, so court mail carrying this number is filed on THIS case from now on — the hearings, deadlines and docket entries it extracts land here.',
      'Events and log: nothing is filed under this number yet.',
      'Caption: the case has no caption; the first court email that names the case can set one (lib/caseCaption.js: "In re <debtor>" on a main bankruptcy case, the court\'s name otherwise).',
      'Templates: {{cases.case_number}} / {{cases.case_number_full}} in letters, forms, emails and texts resolve to the new value from now on.',
      'Trigger event: case.updated fires (source "docket_adopt") — every active rule on it that would act is listed below.',
    ]);
    expect([c.warnings, c.case]).toEqual([[], { case_id: CASE_ID, label: CASE_ID, case_type: 'Bankruptcy', case_subtype: 'Chapter 7', clients: ['Dana Debtor'] }]);
  });
  test('a full number stored as empty text no longer hides the Case Number (listCases NULLIFs both columns since 2026-11-09) — the card reads it the same way', async () => {
    const c = await run(adopt(), { caseRow: { case_number_full: '' }, clients: [] });
    expect(c.effects[1]).toBe(`Cases list: the Case Number column reads "25-12345" (was "${CASE_ID}"), and searching by the number finds the case.`);
    expect(c.effects[2]).toBe('Client portal: no Primary or Secondary contact is on this case, so no client sees it in the portal.');
    expect(c.displays.after).toEqual({ header: '25-12345', cases_list: '25-12345', portal: '25-12345', documents: '25-12345' });
    expect(c.displays.before.cases_list).toBe(CASE_ID);
  });
  test('rows already filed under the number (events by docket, log entries) are counted over exactly the numbers sent', async () => {
    const c = await run(adopt({ case_number_full: '25-12345-abc' }), { filed: { events: 2, log: 1 } });
    expect(c.effects).toContain('Joins this case now: 2 events calendared against this number and 1 log entry filed under it (court mail that arrived before the case had the number, for example) — they show on this case\'s Events tab and log from now on.');
    const sent = ['25-12345', '25-12345-abc'];
    expect(calls.filed).toEqual([['events', [sent]], ['log', [sent, sent, sent]]]);
    const one = await run(adopt({ case_number_full: '25-12345-abc' }), { caseRow: { case_number: '25-12345' }, filed: { events: 1, log: 3 } });
    expect(one.effects).toContain('Joins this case now: 1 event calendared against this number and 3 log entries filed under it (court mail that arrived before the case had the number, for example) — they show on this case\'s Events tab and log from now on.');
    expect(calls.filed[0]).toEqual(['events', [['25-12345-abc']]]);
  });
  test('a captioned case drops the caption line', async () => {
    const c = await run(adopt(), { caseRow: { case_caption: 'In re Dana Debtor' } });
    expect(c.effects.some((e) => e.startsWith('Caption:'))).toBe(false);
  });
  test('a full number re-resolves the judge link: none → a judge is disclosed, the inputs are in expected', async () => {
    const c = await run(adopt({ case_number: undefined, case_number_full: '25-12345-abc' }), { judge: 41, caseRow: { case_judge: 'Mark Example' } });
    expect(calls.resolve).toEqual([{ case_number_full: '25-12345-abc', case_judge: 'Mark Example' }]);
    expect(c.judge).toEqual({ from: null, to: 41, from_label: 'none', to_label: 'Hon. Mark Example (contact #41)' });
    expect(c.effects).toContain('Judge link: re-resolved from the full case number — none → Hon. Mark Example (contact #41) (the judge text is untouched).');
    expect(c.expected).toEqual({ case_number: null, case_number_full: null, case_type: 'Bankruptcy', case_judge: 'Mark Example', case_judge_contact_id: null });
    expect(c.warnings).toEqual([]);
  });
  test('an unchanged judge link is an effect; a CHANGED existing link is a danger warning', async () => {
    const same = await run(adopt({ case_number_full: '25-12345-abc' }), { judge: 41, caseRow: { case_judge_contact_id: 41 } });
    expect(same.effects).toContain('Judge link: re-resolved from the full case number — unchanged (Hon. Mark Example (contact #41)).');
    expect(same.warnings).toEqual([]);
    const moved = await run(adopt({ case_number_full: '25-12345-xyz' }), { judge: 42, caseRow: { case_judge_contact_id: 41, case_judge: 'Mark Example' } });
    expect(moved.warnings).toEqual(['JUDGE LINK CHANGES: setting the full case number re-resolves the case\'s judge contact from its suffix (else from the judge text "Mark Example") — Hon. Mark Example (contact #41) → Hon. Other Judge (contact #42). The judge text itself is untouched.']);
    const cleared = await run(adopt({ case_number_full: '25-12345-xyz' }), { judge: null, caseRow: { case_judge_contact_id: 41 } });
    expect(cleared.warnings[0]).toMatch(/— Hon\. Mark Example \(contact #41\) → none\./);
  });
  test('the case.updated envelope updateCase emits is dry-run: source, actor, changes (judge link included), updated_fields', async () => {
    const seen = [];
    const rules = [
      { id: 7, name: 'Docket arrived', cooling_down: 0, min_interval_s: 0, actions: [{ action_type: 'workflow', config: '{"workflow_id":12}', name: 'Filed flow' }] },
      { id: 8, name: 'Quiet', actions: [] },
      { id: 9, name: 'Code rule', actions: [{ action_type: 'internal_function', config: { function_name: 'create_log' } }] },
    ];
    const c = await run(adopt({ case_number_full: '25-12345-abc' }), {
      judge: 41, caseRow: { case_judge_contact_id: null }, rules,
      evaluate: async (rule, env) => { seen.push(env); return rule.id === 7 ? { matched: true } : rule.id === 9 ? { match_error: 'GUEST_CODE_BUSY' } : { matched: false }; },
    });
    expect(calls.rules).toEqual(['case.updated']);
    const env = seen[0];
    expect([env.event, env.source, env.actor, env.case_id, env.changes, env.extra]).toEqual(['case.updated', 'docket_adopt', { user_id: 6 }, CASE_ID,
      { case_number: { from: null, to: '25-12345' }, case_number_full: { from: null, to: '25-12345-abc' }, case_judge_contact_id: { from: null, to: 41 } },
      { updated_fields: ['case_number', 'case_number_full', 'case_judge_contact_id'] }]);
    expect([env.data.case_number, env.data.case_number_full, env.data.case_judge_contact_id, 'custom' in env.data]).toEqual(['25-12345', '25-12345-abc', 41, false]);
    expect(c.automation).toEqual({ events: ['case.updated'], rules_checked: 3, quiet: 1, lines: [
      'Trigger rule #7 "Docket arrived" runs: starts workflow #12 ("Filed flow")',
      'Trigger rule #9 "Code rule" could not be evaluated for this docket adopt (GUEST_CODE_BUSY) — it MAY run: calls create_log',
    ] });
    expect(c.warnings).toEqual(['AUTOMATION: at least one trigger rule could not be evaluated for this docket adopt — read its line; it may run.']);
  });
});

describe('the ledger, the request detector', () => {
  test('the receipt is the STRING case_id', () => {
    expect(ledger.KINDS.get('case.docket.adopt.v1')).toBe('case_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('case_id')).toBe(true);
  });
  test.each([
    'can you add a case number to the Smith case? It is 25-12345',
    'Put docket 25-12345-abc on this case',
    'record the bankruptcy number 25-12345 for Dana',
    'set the full case number to 25-12345-abc',
  ])('a docket request forces the draft path: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(true);
  });
  test.each(['What is the case number for Dana?', 'Which cases have no docket?', 'Show me the case'])('a question does not: %s', (q) => {
    expect(taskDraftRequested(q, [])).toBe(false);
  });
});
