'use strict';
/**
 * tests/caseyRelink.test.js
 *
 * A11.1 — Casey claims a Dropbox folder for a case: case.folder.relink.v1 →
 * POST /api/documents/relink {case_id, folder_path}, the Documents relink
 * panel's own confirm (documentSyncService.applyRelink), plus the typed read
 * document.relink.candidates (documentSyncService.relinkCandidates, never with
 * includeWeak).
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builder, the click-time re-read, the outcome mapping — is in
 * tests/assistantUi.test.js):
 *   1. the casey_document_relink_enabled switch ('0' = dark; unset = on);
 *   2. refused BY NAME before anything is read, in order: bulk, dismiss /
 *      undo, unlink / clear, weak / force, free-typed folder keys, anything
 *      else;
 *   3. the case id, the folder path's form, and the TWO sources: a sql.read
 *      row carrying the exact case_id and a cited candidate row of a
 *      document.relink.candidates read of the SAME case naming the folder
 *      byte for byte (a path not listed is refused — pick it in the panel);
 *   4. after the reads: a gone case, the sync switched off (the route would
 *      skip), a folder no longer a candidate, a folder another case holds
 *      (the route's 409), the case's current folder (a no-op);
 *   5. the disclosures: the lane, what the case points at, the link rewrite,
 *      the attach / detach / nested / held counts, the large-folder caveat,
 *      nested and inside-of folders, the dismissal, truncated candidates,
 *      filing, no undo; the case.updated envelope updateCase emits, dry-run;
 *      `expected`;
 *   6. the read's rows, the step validator / fingerprint, the ledger receipt
 *      and the request detector.
 *
 * The SQL predicates the counts rest on — applyRelink's own attach and detach
 * clauses, the conjunctive name lane, the 409 guard — run on a real engine in
 * tests/caseyRelink.mysql.test.js, against applyRelink itself.
 *
 *   npx jest tests/caseyRelink.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const sync = require(path.join(REPO, 'services', 'documentSyncService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested, validateStep, stepFingerprint, relinkCandidatesRead } = svc;

const CASE_ID = '7KQ2M9XA';
const FOLDER = '/law/active/ 7 - smith, dana - 25-12345';
const OTHER_FOLDER = '/law/active/ 7 - smith, dana';
const CASE_ROWS = { id: 'q1', kind: 'sql.read', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: '25-12345' }, { case_id: 'OTHER123' }] };
const candRow = (over = {}) => ({ row_type: 'candidate', case_id: CASE_ID, rank: '1', path: FOLDER, files: '12', confidence: 'docket', matched_on: '25-12345', ...over });
const CANDS = { id: 'q2', kind: 'document.relink.candidates', purpose: 'folders', rows: [
  { row_type: 'case', case_id: CASE_ID, current_path: '/law/potential/smith', candidates: '2' },
  candRow(), candRow({ rank: '2', path: OTHER_FOLDER, confidence: 'name', matched_on: 'Smith, Dana' })] };
const EVIDENCE = [CASE_ROWS, CANDS];
const REFS = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }];

let spies = [];
let calls;
function freshOut(over = {}) {
  return {
    case_id: CASE_ID, case_number: '25-12345', case_number_full: null, case_stage: 'Filed', pipeline_phase: 'case',
    current_path: '/law/potential/smith', current_path_display: '/Law/Potential/Smith', current_link: 'https://www.dropbox.com/scl/fo/old',
    resolve_error: null, dismissed_at: null, dismissed_by: null, client_names: ['Smith, Dana', 'Smith, Lee'], actionable: true,
    candidates: [
      { path: FOLDER, files: 12, newest: '2026-10-01T10:00:00.000Z', confidence: 'docket', matched_on: '25-12345', inside_case_id: null, already_linked_to: null, nested_case_ids: null },
      { path: OTHER_FOLDER, files: 3, newest: null, confidence: 'name', matched_on: 'Smith, Dana', inside_case_id: null, already_linked_to: null, nested_case_ids: null },
    ],
    candidates_truncated: false,
    ...over,
  };
}
function setup({ out = freshOut(), enabled = true, prior = {}, predict = {}, rules = [], evaluate, cache = [] } = {}) {
  calls = { candidates: [], enabled: 0, rules: [], queries: [] };
  const p = { total: 12, held: 0, heldBy: [], unattached: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, path_lower: `${FOLDER}/f${i}.pdf` })), detach: 0, kept: 0, labels: {}, ...predict };
  spies = [
    jest.spyOn(sync, 'relinkCandidates').mockImplementation(async (_db, id, opts) => { calls.candidates.push([id, opts]); return typeof out === 'function' ? out(id) : out; }),
    jest.spyOn(sync, 'isSyncEnabled').mockImplementation(async () => { calls.enabled += 1; return enabled; }),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules.map((r) => ({ ...r })); }),
  ];
  if (evaluate) spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(evaluate));
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.queries.push([flat, params]);
    if (flat === 'SELECT * FROM cases WHERE case_id = ? LIMIT 1') return [[{ case_id: CASE_ID, case_dropbox: 'https://www.dropbox.com/scl/fo/old', case_type: 'Bankruptcy', ...prior }]];
    if (flat.startsWith('SELECT COUNT(*) AS total,')) return [[{ total: p.total, held: p.held }]];
    if (flat.startsWith('SELECT dl.link_id AS case_id, COUNT(DISTINCT d.id) AS n')) return [p.heldBy];
    if (flat.startsWith('SELECT d.id, d.path_lower FROM documents d LEFT JOIN document_links dl')) return [p.unattached];
    if (flat.startsWith('SELECT case_id, folder_external_id, path_lower FROM case_folder_cache')) return [cache];
    if (flat.startsWith('SELECT COUNT(*) AS n FROM document_links dl JOIN documents d')) return [[{ n: p.detach }]];
    if (flat.startsWith("SELECT COUNT(*) AS n FROM document_links WHERE link_type = 'case' AND link_id = ? AND NOT")) return [[{ n: p.kept }]];
    if (flat.startsWith('SELECT case_id, COALESCE(NULLIF(case_number_full')) {
      return [params[0].filter((id) => p.labels[id]).map((id) => ({ case_id: id, label: p.labels[id] }))];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_DOCUMENT_RELINK_ENABLED; });

const relink = (over = {}) => ({ kind: 'case.folder.relink.v1', case_id: CASE_ID, folder_path: FOLDER, evidence: REFS, ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: 6 });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);
const untouched = () => expect([calls.candidates.length, calls.enabled, calls.queries.length]).toEqual([0, 0, 0]);

describe('the per-family switch', () => {
  test("'0' makes the kind unavailable; unset is ON", async () => {
    process.env.CASEY_DOCUMENT_RELINK_ENABLED = '0';
    await expect(run(relink())).rejects.toThrow(/^Action kind is unavailable$/);
    untouched();
    delete process.env.CASEY_DOCUMENT_RELINK_ENABLED;
    await expect(run(relink())).resolves.toMatchObject({ kind: 'case.folder.relink.v1', status: 'draft' });
  });
});

describe('refused by name before anything is read', () => {
  test.each([['case_ids'], ['all'], ['folders'], ['paths'], ['bulk']])('bulk (%s) — quoting the route header', async (k) => {
    await refuse(relink({ [k]: [CASE_ID] }), new RegExp(`^BULK refused \\(${k}\\): a folder card claims ONE folder for ONE case. There is no bulk re-link in YisraCase, on purpose — "a bulk verb would exist to save eight clicks and would be the single most dangerous button in the app"`));
    untouched();
  });
  test.each([['dismiss'], ['undismiss'], ['undo'], ['restore_previous']])('dismiss / undo (%s)', async (k) => {
    await refuse(relink({ [k]: true }), new RegExp(`^DISMISS / UNDO refused \\(${k}\\): dismissing a case from the relink queue, un-dismissing it and undoing a re-link are not available to Casey`));
    untouched();
  });
  test.each([['unlink'], ['detach_old'], ['clear_link'], ['remove']])('unlink / clear (%s)', async (k) => {
    await refuse(relink({ [k]: true }), new RegExp(`^UNLINK / CLEAR refused \\(${k}\\): Casey never detaches a case's documents or clears its Dropbox link on their own`));
    untouched();
  });
  test.each([['include_weak'], ['weak'], ['force'], ['override_guard'], ['skip_check']])('weak / override (%s)', async (k) => {
    await refuse(relink({ [k]: true }), new RegExp(`^WEAK MATCHES / OVERRIDES refused \\(${k}\\): Casey proposes only the folders the strict candidate lanes find`));
    untouched();
  });
  test.each([['path'], ['dropbox_path'], ['folder'], ['shared_link'], ['case_dropbox']])('free-typed folder keys (%s)', async (k) => {
    await refuse(relink({ [k]: FOLDER }), new RegExp(`^FREE-TYPED FOLDERS refused \\(${k}\\): name the folder in "folder_path"`));
    untouched();
  });
  test('the order: bulk before every other named refusal; anything else unknown last', async () => {
    await refuse(relink({ undo: true, unlink: true, force: true, path: 'x', case_ids: [] }), /^BULK refused \(case_ids\)/);
    await refuse(relink({ unlink: true, force: true, undo: true }), /^DISMISS \/ UNDO refused \(undo\)/);
    await refuse(relink({ force: true, unlink: true }), /^UNLINK \/ CLEAR refused \(unlink\)/);
    await refuse(relink({ path: 'x', force: true }), /^WEAK MATCHES \/ OVERRIDES refused \(force\)/);
    await refuse(relink({ foo: 1 }), 'A folder card carries unsupported fields: foo — it takes case_id, folder_path and evidence only');
    untouched();
  });
});

describe('the case id, the folder path and the two sources', () => {
  test('the case id must be the exact form', async () => {
    for (const v of [undefined, '', 'bad id!', 'x'.repeat(21), 12345678]) {
      await refuse(relink({ case_id: v }), 'A folder card needs the case\'s exact case_id');
    }
    untouched();
  });
  test('folder_path: a string, one full path, no control character, bounded', async () => {
    await refuse(relink({ folder_path: undefined }), 'A folder card needs "folder_path": a candidate folder\'s path');
    await refuse(relink({ folder_path: ['/a'] }), 'A folder card needs "folder_path"');
    for (const v of ['law/active/x', `${FOLDER}\n`, `/a\u0001b`, `/a b`, `/${'x'.repeat(1024)}`]) {
      await refuse(relink({ folder_path: v }), 'folder_path must be one full Dropbox path starting with "/"');
    }
    untouched();
  });
  test('the case must be cited by a sql.read row with the exact case_id — the candidates read\'s own head row does not count', async () => {
    await refuse(relink({ evidence: [{ query_id: 'q2', row_number: 1 }, { query_id: 'q2', row_number: 2 }] }),
      `The folder evidence does not identify case ${CASE_ID} — cite a sql.read row carrying its exact case_id (read the case first)`);
    await refuse(relink({ evidence: [{ query_id: 'q1', row_number: 2 }, { query_id: 'q2', row_number: 2 }] }), 'does not identify case');
    untouched();
  });
  test('a candidates read must exist, and be of THIS case', async () => {
    await refuse(relink({ evidence: [{ query_id: 'q1', row_number: 1 }] }),
      `Read the folder candidates first: a folder card needs a document.relink.candidates read of case ${CASE_ID} in this investigation`, undefined, [CASE_ROWS]);
    const otherCase = { ...CANDS, rows: [{ row_type: 'case', case_id: 'OTHER123' }, candRow({ case_id: 'OTHER123' })] };
    await refuse(relink(), `The candidates read in this investigation is for case OTHER123, not case ${CASE_ID} — read case ${CASE_ID}'s candidates`, undefined, [CASE_ROWS, otherCase]);
    untouched();
  });
  test('NOT A CANDIDATE: a path the read did not list is refused — pick it in the panel; a re-cased one is told to copy exactly', async () => {
    await refuse(relink({ folder_path: '/law/active/somewhere else' }),
      new RegExp(`^NOT A CANDIDATE: "/law/active/somewhere else" is not one of the folders the candidates read listed for case ${CASE_ID}\\. Casey proposes only a listed folder, never one found any other way .* Pick it in the Documents relink panel .* the panel has no typed-path field; ask IT$`));
    await refuse(relink({ folder_path: FOLDER.replace('smith', 'Smith') }), 'differs from the candidate\'s path in capitalisation or spacing — copy folder_path EXACTLY');
    // A candidate row of ANOTHER case listing the same path does not make it this case's candidate.
    const mixed = { ...CANDS, rows: [CANDS.rows[0], candRow({ case_id: 'OTHER123' })] };
    await refuse(relink({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }] }), /^NOT A CANDIDATE/, undefined, [CASE_ROWS, mixed]);
    untouched();
  });
  test('the candidate row itself must be cited', async () => {
    await refuse(relink({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 3 }] }),
      `Cite the candidate row: the evidence must include the document.relink.candidates row whose path is "${FOLDER}"`);
    await refuse(relink({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }] }), 'Cite the candidate row');
    untouched();
  });
});

describe('after the reads', () => {
  test('the server re-reads the case\'s candidates WITHOUT weak matches', async () => {
    await run(relink());
    expect(calls.candidates).toEqual([[CASE_ID, undefined]]);
  });
  test('a gone case', async () => {
    await refuse(relink(), `Case ${CASE_ID} no longer exists`, { out: null });
    expect(calls.enabled).toBe(0);
  });
  test('the sync switched off — the route would only skip', async () => {
    await refuse(relink(), /^THE DOCUMENT SYNC IS SWITCHED OFF \(documents_sync_enabled is not "1"\): the relink route does nothing while the sync engine is off/, { enabled: false });
  });
  test('a folder that is no longer a candidate', async () => {
    await refuse(relink(), `"${FOLDER}" is no longer a candidate for case 25-12345 — the folder moved, was renamed or emptied`, { out: freshOut({ candidates: [freshOut().candidates[1]] }) });
  });
  test('ANOTHER CASE HOLDS THIS FOLDER — the route\'s 409, refused first, naming the case', async () => {
    const out = freshOut(); out.candidates[0] = { ...out.candidates[0], already_linked_to: ['AAAA1111', 'BBBB2222'] };
    await refuse(relink(), `ANOTHER CASE HOLDS THIS FOLDER: "${FOLDER}" is already case AAAA1111, BBBB2222's folder — linking it here as well would put both clients' documents on both cases, and the route refuses it (409)`, { out });
  });
  test('the case\'s current folder is a no-op', async () => {
    await refuse(relink(), `That changes nothing — case 25-12345 already points at "${FOLDER}"`, { out: freshOut({ current_path: FOLDER }) });
  });
});

describe('the card', () => {
  test('a plain docket match: case, folder, current folder, link rewrite, attach, no detach, filing, audit, no undo, expected', async () => {
    const d = await run(relink(), { predict: { kept: 2 } });
    expect(d.case).toEqual({ case_id: CASE_ID, label: '25-12345', case_number: '25-12345', case_number_full: null, clients: ['Smith, Dana', 'Smith, Lee'] });
    expect(d.folder).toEqual({ path: FOLDER, files: 12, newest: '2026-10-01T10:00:00.000Z', confidence: 'docket', matched_on: '25-12345', inside_case_id: null, nested_case_ids: [] });
    expect(d.current).toEqual({ path: '/law/potential/smith', path_display: '/Law/Potential/Smith', link: 'https://www.dropbox.com/scl/fo/old', resolve_error: null, dismissed_at: null });
    expect(d.warnings).toEqual([]);
    expect(d.effects).toEqual([
      'Matched on: the docket lane — the case number "25-12345" appears in the folder\'s name.',
      'Now points at: "/Law/Potential/Smith".',
      'Case link: the case\'s Dropbox link (cases.case_dropbox) is REWRITTEN — from https://www.dropbox.com/scl/fo/old — to the folder\'s permanent Dropbox shared link: Dropbox\'s existing link for it, else a NEW one created with public visibility (anyone holding it can open the folder). The old link is kept only in the audit entry.',
      'Attaches NOW: 12 registered files of the 12 under this folder get the sync\'s link to this case and show on its Documents tab at once — silently: no document.linked event fires for them.',
      'Detaches: nothing — the case holds no sync-made link to a file outside this folder. Links people made are never touched (2 on this case).',
      'Documents tab: the case\'s Documents tab lists the folder\'s files from now on (staff only — the client portal lists no documents).',
      'Filing: from now on everything YisraCase files into "the case folder" goes to THIS folder — client uploads from the portal and the public documents link (its "Client Uploads" subfolder), filed form PDFs (Forms), signed e-sign documents (Signed Documents), and automation steps that use {{case_dropbox}}. The case page\'s Dropbox panel shows it once the case page is reopened.',
      'If Dropbox cannot resolve the new link at once, the link still changes but nothing attaches or detaches until the next folder-cache run — the result says so.',
      'Audit: one log entry on the case ("Case Dropbox folder re-linked") records who did it, the old path and old link, the new path and link, and the counts.',
      'Trigger event: case.updated fires (source "documents_relink", field case_dropbox) when the link actually changes — every active rule on it that would act is listed below, checked against a stand-in for the new link (it is minted when you apply).',
    ]);
    expect(d.no_undo).toBe('There is no undo button. To recover, re-link the correct folder (which retracts these sync links) or unlink documents one by one and clear the case\'s Dropbox link by hand; the audit entry keeps the old path and the old link.');
    expect(d.expected).toEqual({ case_dropbox: 'https://www.dropbox.com/scl/fo/old', current_path: '/law/potential/smith', path: FOLDER, files: 12, already_linked_to: null });
    expect(d.evidence.map((e) => [e.query_id, e.row_number])).toEqual([['q1', 1], ['q2', 2]]);
    // The attach rows are matched against the cache with THIS case on the folder: the LIKE is the folder's subtree.
    const attachQ = calls.queries.find(([sql]) => sql.startsWith('SELECT d.id, d.path_lower FROM documents d LEFT JOIN'));
    expect(attachQ[1]).toEqual(['path', `${FOLDER}/%`]);
    expect(attachQ[0]).toContain(`LIMIT ${sync.RELINK_ATTRIBUTION_CAP}`);
  });

  test('the name lane, no current folder and no link, held and nested files, a detach (danger), a large folder, nested and inside-of folders, a dismissal, truncated candidates', async () => {
    const out = freshOut({ current_path: null, current_path_display: null, current_link: null, dismissed_at: '2026-09-01T00:00:00.000Z', candidates_truncated: true });
    out.candidates[1] = { ...out.candidates[1], inside_case_id: 'OUTER111', nested_case_ids: ['NEST1111', 'NEST2222'] };
    const cap = sync.RELINK_ATTRIBUTION_CAP;
    const unattached = Array.from({ length: cap }, (_, i) => ({ id: i + 1, path_lower: i < 3 ? `${OTHER_FOLDER}/nest/x${i}.pdf` : `${OTHER_FOLDER}/f${i}.pdf` }));
    const cache = [{ case_id: 'NEST1111', path_lower: `${OTHER_FOLDER}/nest` }, { case_id: CASE_ID, path_lower: OTHER_FOLDER }];
    const d = await run(relink({ folder_path: OTHER_FOLDER, evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 3 }] }),
      { out, cache, predict: { total: cap + 9, held: 9, heldBy: [{ case_id: 'OUTER111', n: 7 }, { case_id: CASE_ID, n: 2 }], unattached, detach: 4, kept: 1, labels: { OUTER111: '24-99999' } } });
    expect(d.effects[0]).toBe('Matched on: the name lane — every required word of the client name "Smith, Dana" (surname and first given name) appears in the folder\'s name.');
    expect(d.effects[1]).toBe('Now points at: no folder.');
    expect(d.effects[2]).toMatch(/^Case link: the case's Dropbox link \(cases\.case_dropbox\) is REWRITTEN — from blank — to/);
    expect(d.effects[3]).toBe(`Attaches NOW: at least ${(cap - 3).toLocaleString('en-US')} registered files of the ${(cap + 9).toLocaleString('en-US')} under this folder get the sync's link to this case and show on its Documents tab at once — silently: no document.linked event fires for them. 9 files already carry the sync's link to a case and stay as they are (7 files on case 24-99999; 2 files on this case already). 3 files sit inside another case's folder nested here and stay with that case.`);
    expect(d.warnings).toEqual([
      'DETACHES 4 DOCUMENTS: 4 of this case\'s links the sync made to files OUTSIDE the new folder are deleted, and those files leave the case\'s Documents tab. Only machine links go — 1 link a person made (or with another relation) stays.',
      `LARGE FOLDER: only the first ${cap.toLocaleString('en-US')} unattached files under the folder are considered now; the recurring sweep attaches the rest later.`,
      'INSIDE ANOTHER CASE\'S FOLDER: this folder sits inside case OUTER111\'s folder. Its files that already carry that case\'s sync link stay there and do not attach here (counted above); files added later attach to THIS case. Joint debtors can make this right — make sure it is.',
    ]);
    expect(d.effects).toContain('Nested case folders: NEST1111, NEST2222 have their own folder inside this one; their files stay on those cases (a file belongs to the innermost case folder).');
    expect(d.effects).toContain('Relink queue: this case was dismissed from the relink queue (2026-09-01); applying clears the dismissal.');
    expect(d.effects).toContain('Candidates: more folders matched than the panel lists — be sure this is the right one.');
    expect(d.effects.some((e) => e.startsWith('Detaches:'))).toBe(false);
    expect(d.prediction).toMatchObject({ attach: cap - 3, nested: 3, scanned: cap, truncated: true, detach: 4, human_kept: 1, under_total: cap + 9, held_total: 9 });
    expect(d.expected).toEqual({ case_dropbox: null, current_path: null, path: OTHER_FOLDER, files: 3, already_linked_to: null });
  });

  test('one-file wording', async () => {
    const d = await run(relink(), { predict: { total: 1, unattached: [{ id: 1, path_lower: `${FOLDER}/a.pdf` }], detach: 1, kept: 1, held: 0 } });
    expect(d.effects[3]).toBe('Attaches NOW: 1 registered file of the 1 under this folder get the sync\'s link to this case and show on its Documents tab at once — silently: no document.linked event fires for them.');
    expect(d.warnings[0]).toBe('DETACHES 1 DOCUMENT: one of this case\'s links the sync made to files OUTSIDE the new folder is deleted, and those files leave the case\'s Documents tab. Only machine links go — 1 link a person made (or with another relation) stays.');
  });

  test('the case.updated envelope updateCase emits — source documents_relink, case_dropbox changed — dry-run; a rule that cannot be evaluated is a danger warning', async () => {
    const seen = [];
    const rules = [{ id: 7, name: 'Folder fixed', actions: [{ action_type: 'workflow', config: { workflow_id: 12 } }] },
      { id: 8, name: 'Broken', actions: [{ action_type: 'workflow', config: { workflow_id: 13 } }] }];
    const d = await run(relink(), { rules, prior: { case_dropbox: 'https://www.dropbox.com/scl/fo/old', case_notes: 'n' },
      evaluate: async (rule, env) => { seen.push(env); return rule.id === 7 ? { matched: true, transform_ok: true } : { matched: false, match_error: 'boom' }; } });
    expect(calls.rules).toEqual(['case.updated']);
    expect([seen[0].event, seen[0].source, seen[0].case_id, seen[0].actor, seen[0].changes, seen[0].extra]).toEqual([
      'case.updated', 'documents_relink', CASE_ID, { user_id: 6 },
      { case_dropbox: { from: 'https://www.dropbox.com/scl/fo/old', to: 'https://www.dropbox.com/(the folder shared link minted when the card is applied)' } },
      { updated_fields: ['case_dropbox'] }]);
    expect(d.automation).toEqual({ events: ['case.updated'], rules_checked: 2, quiet: 0, lines: [
      'Trigger rule #7 "Folder fixed" runs: starts workflow #12',
      'Trigger rule #8 "Broken" could not be evaluated for this folder re-link (boom) — it MAY run: starts workflow #13'] });
    expect(d.warnings).toEqual(['AUTOMATION: at least one trigger rule could not be evaluated for this re-link — read its line; it may run.']);
  });

  test('the ledger receipt is the STRING case_id', () => {
    expect(ledger.KINDS.get('case.folder.relink.v1')).toBe('case_id');
  });
});

describe('the typed read document.relink.candidates', () => {
  test('validateStep takes ONE exact case_id; the fingerprint is per case', () => {
    expect(validateStep({ id: 'q1', kind: 'document.relink.candidates', purpose: 'p', case_id: ` ${CASE_ID} ` }, 0)).toEqual({ id: 'q1', kind: 'document.relink.candidates', purpose: 'p', case_id: CASE_ID });
    for (const v of [undefined, '', 'bad id!', 42, 'x'.repeat(21)]) {
      expect(() => validateStep({ id: 'q1', kind: 'document.relink.candidates', purpose: 'p', case_id: v }, 0)).toThrow('Step q1 needs the case\'s exact case_id');
    }
    expect(stepFingerprint({ kind: 'document.relink.candidates', case_id: CASE_ID })).toBe(`document.relink.candidates:${CASE_ID}`);
  });

  test('the head row and one row per candidate — never weak matches; already-held and current folders are not proposable', async () => {
    const out = freshOut({ candidates_truncated: true, dismissed_at: '2026-09-01T00:00:00.000Z' });
    out.candidates.push({ path: '/law/potential/smith', files: 1, newest: null, confidence: 'name', matched_on: 'Smith, Dana', inside_case_id: null, already_linked_to: null, nested_case_ids: null });
    out.candidates[1] = { ...out.candidates[1], already_linked_to: ['AAAA1111', 'BBBB2222'], nested_case_ids: ['NEST1111'], inside_case_id: 'OUTER111' };
    const db = setup({ out });
    const r = await relinkCandidatesRead(db, CASE_ID);
    expect(calls.candidates).toEqual([[CASE_ID, undefined]]);
    expect(r.truncated).toBe(true);
    expect(r.rows[0]).toMatchObject({ row_type: 'case', case_id: CASE_ID, case_number: '25-12345', client_names: 'Smith, Dana; Smith, Lee',
      current_path: '/law/potential/smith', current_link: 'https://www.dropbox.com/scl/fo/old', dismissed_at: '2026-09-01T00:00:00.000Z', candidates: 3, candidates_truncated: 1 });
    expect(r.rows[0].note).toMatch(/^3 candidate folders — the Documents relink panel's own list\. .*surname-only matches are never listed .* MORE CANDIDATES MATCHED than the ones listed\.$/);
    expect(r.rows.slice(1).map((x) => [x.row_type, x.rank, x.path, x.files, x.already_linked_to, x.nested_case_ids, x.inside_case_id, x.is_current, x.proposable])).toEqual([
      ['candidate', 1, FOLDER, 12, null, null, null, 0, 1],
      ['candidate', 2, OTHER_FOLDER, 3, 'AAAA1111, BBBB2222', 'NEST1111', 'OUTER111', 0, 0],
      ['candidate', 3, '/law/potential/smith', 1, null, null, null, 1, 0],
    ]);
  });

  test('no candidate, and an unknown case', async () => {
    const r = await relinkCandidatesRead(setup({ out: freshOut({ candidates: [] }) }), CASE_ID);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].note).toMatch(/^NO CANDIDATE FOLDER — nothing to propose/);
    const gone = await relinkCandidatesRead(setup({ out: null }), 'NOPE1234');
    expect(gone).toEqual({ rows: [{ row_type: 'not_found', case_id: 'NOPE1234', note: 'No case has case_id "NOPE1234"' }], truncated: false });
  });
});

describe('the request detector', () => {
  test.each([
    ['link the Smith Dropbox folder to her case', true],
    ['relink case 7KQ2M9XA to its real folder', true],
    ['please point the case at the 25-12345 folder', true],
    ['which Dropbox folder is the Smith case in?', false],
    ['show me the documents in that folder', false],
  ])('%s → %s', (q, want) => {
    expect(taskDraftRequested(q, [])).toBe(want);
  });
});

describe('the read runs through the executor', () => {
  const aiService = require(path.join(REPO, 'services', 'aiService'));
  const assistantTicket = require(path.join(REPO, 'lib', 'assistantTicket'));
  test('a document.relink.candidates step reads the panel\'s list (never weak) and its rows reach the answer as citable evidence', async () => {
    const old = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'casey-relink-test-secret';
    setup();
    const db = { query: jest.fn(async (q) => {
      if (/FROM app_settings/.test(q)) return [[]];
      if (/FROM ai_calls/.test(q)) return [[{ c: 0 }]];
      throw new Error(`Unexpected SQL: ${q}`);
    }) };
    const plan = svc.validatePlan({ action: 'query', summary: 'Folder candidates', steps: [
      { id: 'q1', kind: 'document.relink.candidates', purpose: 'The case\'s folder candidates', case_id: CASE_ID }] });
    const signed = assistantTicket.sign({ v: 1, uid: 7, question: 'Which folder is the Smith case\'s?', history: [], plan: { action: 'query', ...plan } });
    const answer = jest.spyOn(aiService, 'call').mockResolvedValue({ ok: true, callId: 3,
      json: { answer: 'The docket folder.', citations: [{ query_id: 'q1', row_number: 2, label: 'Candidate folder' }], suggestions: [] } });
    try {
      const out = await svc.execute(db, { signedTicket: signed, userId: 7, auth: { type: 'jwt', userId: 7 } });
      expect(calls.candidates).toEqual([[CASE_ID, undefined]]);
      expect(out.sources[0]).toMatchObject({ query_id: 'q1', row_number: 2, row: { row_type: 'candidate', case_id: CASE_ID, path: FOLDER, files: '12', proposable: '1' } });
    } finally {
      answer.mockRestore();
      if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old;
    }
  });
});
