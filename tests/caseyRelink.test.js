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
 *      and the request detector;
 *   7. A11.1X (released 2026-11-15): a TYPED folder path proposable only with
 *      a cited document.folder read of the exact path (the read's rows, the
 *      refusals before and after the reads, the NOT A CANDIDATE card);
 *      case.folder.dismiss.v1 (one case, undo, no cache row, the state already
 *      equal, the queue line, the candidates warning); case.folder.relink.undo.v1
 *      (the audit entry cited from a sql.read of log, the latest-entry rule,
 *      the link precondition, the old folder proved in Dropbox, the card).
 *      Bulk stays refused on every kind. dropboxService is MOCKED here (its
 *      module object spied; never the API) — the twin stubs it at the boundary.
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
const dropbox = require(path.join(REPO, 'services', 'dropboxService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested, validateStep, stepFingerprint, relinkCandidatesRead, documentFolderRead } = svc;

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
// A11.1X fixtures: the Dropbox facts a typed / undo folder rests on, and the
// dismiss and undo rows. `owners` is [[path_lower, case_id], …] — the cache
// rows _loadFolderOwners indexes; `under` is derived the way it derives it.
const FOLDER_META = { '.tag': 'folder', id: 'id:typed', path_lower: FOLDER, path_display: '/Law/Active/ 7 - Smith, Dana - 25-12345' };
const LISTING = { entries: [{ '.tag': 'file', name: 'a.pdf', server_modified: '2026-09-20T10:00:00Z' }, { '.tag': 'file', name: 'b.pdf', server_modified: '2026-10-01T10:00:00Z' }, { '.tag': 'folder', name: 'sub' }], truncated: false };
const CACHE_ROW = { path_lower: '/law/potential/smith', path_display: '/Law/Potential/Smith', resolved_at: '2026-10-30T12:00:00.000Z', resolve_error: null, relink_dismissed_at: null, relink_dismissed_by: null };
const LOG_ID = 48211;
const AUDIT = (over = {}) => ({ log_id: LOG_ID, log_type: 'update', log_link_type: 'case', log_link_id: CASE_ID, log_by: 6, log_subject: 'Case Dropbox folder re-linked', at_text: '2026-11-10 09:30',
  log_extra: JSON.stringify({ relink: { old_path: FOLDER, old_link: 'https://www.dropbox.com/scl/fo/older', new_path: '/law/potential/smith', requested_path: '/law/potential/smith', new_link: 'https://www.dropbox.com/scl/fo/old', linked_docs: 3, detached_docs: 2, ...(over.relink || {}) } }), ...over, relink: undefined });
function notFound() { return Object.assign(new Error('dropbox: POST /2/files/get_metadata → 409: path/not_found/..'), { status: 409, errorSummary: 'path/not_found/..' }); }
function setup({ out = freshOut(), enabled = true, prior = {}, predict = {}, rules = [], evaluate, cache = [],
  cacheRow = CACHE_ROW, linked = false, logRow = AUDIT(), latestLog = { log_id: LOG_ID, at_text: '2026-11-10 09:30' }, users = { 6: 'Fred' },
  roots = ['/law'], owners = [], meta = FOLDER_META, listing = LISTING, registered = { n: 12, newest: '2026-10-01T10:00:00.000Z' } } = {}) {
  calls = { candidates: [], enabled: 0, rules: [], queries: [], dropbox: [] };
  const p = { total: 12, held: 0, heldBy: [], unattached: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, path_lower: `${FOLDER}/f${i}.pdf` })), detach: 0, kept: 0, labels: {}, ...predict };
  const ownersMap = new Map(); const underMap = new Map();
  for (const [pth, id] of owners) {
    if (!ownersMap.has(pth)) ownersMap.set(pth, new Set());
    ownersMap.get(pth).add(String(id));
    let q = pth;
    while (q && q.indexOf('/') !== -1) { q = q.slice(0, q.lastIndexOf('/')); if (!q) break; if (!underMap.has(q)) underMap.set(q, new Set()); underMap.get(q).add(String(id)); }
  }
  spies = [
    jest.spyOn(sync, 'relinkCandidates').mockImplementation(async (_db, id, opts) => { calls.candidates.push([id, opts]); return typeof out === 'function' ? out(id) : out; }),
    jest.spyOn(sync, 'isSyncEnabled').mockImplementation(async () => { calls.enabled += 1; return enabled; }),
    jest.spyOn(sync, 'listRoots').mockImplementation(async () => roots.map((r, i) => ({ id: i + 1, path: r, enabled: true }))),
    jest.spyOn(sync, '_loadFolderOwners').mockImplementation(async () => ({ owners: ownersMap, under: underMap, size: owners.length })),
    jest.spyOn(dropbox, 'getMetadata').mockImplementation(async (_db, opts) => { calls.dropbox.push(['getMetadata', opts]); if (meta === 'missing') throw notFound(); return meta; }),
    jest.spyOn(dropbox, 'listFolder').mockImplementation(async (_db, opts) => { calls.dropbox.push(['listFolder', opts]); return listing; }),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { calls.rules.push(ev); return rules.map((r) => ({ ...r })); }),
  ];
  if (evaluate) spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(evaluate));
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    calls.queries.push([flat, params]);
    if (flat.startsWith('SELECT path_lower, path_display, resolved_at, resolve_error, relink_dismissed_at, relink_dismissed_by FROM entity_folders')) return [cacheRow ? [{ ...cacheRow }] : []];   // D3b-2: the binding
    if (flat.startsWith("SELECT EXISTS(SELECT 1 FROM document_links WHERE link_type = 'case' AND link_id = ?) AS linked")) return [[{ linked: linked ? 1 : 0 }]];
    if (flat.startsWith('SELECT log_id, log_type, log_link_type, log_link_id, log_by, log_subject, log_extra,')) return [logRow && Number(params[0]) === Number(logRow.log_id) ? [{ ...logRow }] : []];
    if (flat.startsWith("SELECT log_id, DATE_FORMAT(log_date, '%Y-%m-%d %H:%i') AS at_text FROM log WHERE log_link_type = 'case'")) return [latestLog ? [{ ...latestLog }] : []];
    if (flat === 'SELECT user, user_name FROM users WHERE user = ? LIMIT 1') return [users[params[0]] ? [{ user: params[0], user_name: users[params[0]] }] : []];
    if (flat.startsWith('SELECT COUNT(*) AS n, MAX(server_modified) AS newest FROM documents')) return [[{ ...registered }]];
    if (flat === 'SELECT * FROM cases WHERE case_id = ? LIMIT 1') return [[{ case_id: CASE_ID, case_dropbox: 'https://www.dropbox.com/scl/fo/old', case_type: 'Bankruptcy', ...prior }]];
    if (flat.startsWith('SELECT COUNT(*) AS total,')) return [[{ total: p.total, held: p.held }]];
    if (flat.startsWith('SELECT dl.link_id AS case_id, COUNT(DISTINCT d.id) AS n')) return [p.heldBy];
    if (flat.startsWith('SELECT d.id, d.path_lower FROM documents d LEFT JOIN document_links dl')) return [p.unattached];
    if (flat.startsWith('SELECT entity_id AS case_id, external_id AS folder_external_id, path_lower FROM entity_folders')) return [cache];   // D3b-2: the binding
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
  test.each([['dismiss'], ['undismiss'], ['undo'], ['restore_previous']])('dismiss / undo (%s) — on a RE-LINK card they point at the two A11.1X cards', async (k) => {
    await refuse(relink({ [k]: true }), new RegExp(`^DISMISS / UNDO refused \\(${k}\\) on a re-link card: dismissing or un-dismissing a case in the relink queue is its own card \\(case\\.folder\\.dismiss\\.v1 — one case; undo:true to un-dismiss\\), and undoing the case's latest re-link is its own card \\(case\\.folder\\.relink\\.undo\\.v1, citing the case's "Case Dropbox folder re-linked" log entry\\)$`));
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
  test.each([['path'], ['dropbox_path'], ['folder'], ['shared_link'], ['case_dropbox']])('free-typed folder keys (%s) — the folder goes in folder_path, candidate or document.folder-read', async (k) => {
    await refuse(relink({ [k]: FOLDER }), new RegExp(`^FREE-TYPED FOLDERS refused \\(${k}\\): name the folder in "folder_path" — a candidate's path copied exactly from a document.relink.candidates row of this case, or a path a document.folder read of that exact path has proved \\(it exists, is a folder and sits under an enabled sync root\\), copied exactly as that read lists it$`));
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
  test('NOT A CANDIDATE: a path the read did not list and no document.folder read proved is refused — read it first; a re-cased one is told to copy exactly', async () => {
    await refuse(relink({ folder_path: '/law/active/somewhere else' }),
      new RegExp(`^NOT A CANDIDATE: "/law/active/somewhere else" is not one of the folders the candidates read listed for case ${CASE_ID}\\. Casey proposes a listed folder, or a folder a document\\.folder read of that EXACT path has proved — it exists in Dropbox, it is a folder and it sits under an enabled sync root — copied as the read lists it and cited\\. A path typed, searched for or taken from a document's path is never proposed unread: read it first \\(document\\.folder \\{"path": …\\}\\)\\. The Documents relink panel \\(More → Documents → Sync\\) lists only its candidates and has no typed-path field$`));
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
      'Audit: one log entry on the case ("Case Dropbox folder re-linked") records who did it, the old path and old link, the new path and link, and the counts — the entry an undo card cites.',
      'Trigger event: case.updated fires (source "documents_relink", field case_dropbox) when the link actually changes — every active rule on it that would act is listed below, checked against a stand-in for the new link (it is minted when you apply).',
    ]);
    expect(d.no_undo).toBe('There is no undo button on this card. While this stays the case\'s latest re-link, an undo card (case.folder.relink.undo.v1, citing its audit entry) re-links the old folder, which retracts these sync links; otherwise re-link the correct folder, or unlink documents one by one and clear the case\'s Dropbox link by hand. The audit entry keeps the old path and the old link.');
    // A candidate card asks Dropbox nothing — the candidates read is its proof.
    expect(calls.dropbox).toEqual([]);
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

  test('the ledger receipt is the STRING case_id — for all three case folder kinds', () => {
    expect(ledger.KINDS.get('case.folder.relink.v1')).toBe('case_id');
    expect(ledger.KINDS.get('case.folder.relink.undo.v1')).toBe('case_id');
    expect(ledger.KINDS.get('case.folder.dismiss.v1')).toBe('case_id');
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
    // A11.1X: the queue's dismissal and the undo of a re-link.
    ['dismiss the Smith case from the relink queue', true],
    ['put the Jones case back in the relink queue', true],
    ['undo the re-link on case 7KQ2M9XA', true],
    ['undo the Dropbox folder change on the Smith case', true],
    ['was the Smith case re-linked last week?', false],
    ['who dismissed the Jones case from the relink queue?', false],
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

// ═══════════════════════════════════════════════════════════════════════════
// A11.1X — the released extras (Fred, 2026-11-15: "release means allow")
// ═══════════════════════════════════════════════════════════════════════════

const TYPED = '/law/closed/ old files - smith';
const TYPED_META = { '.tag': 'folder', id: 'id:closed', path_lower: TYPED, path_display: '/Law/Closed/ Old Files - Smith' };
const folderRow = (over = {}) => ({ row_type: 'folder', path: TYPED, path_lower: TYPED, exists: '1', is_folder: '1', under_enabled_root: '1', root: '/law', listed_files: '3', proposable: '1', ...over });
const FOLDER_READ = (over = {}) => ({ id: 'q4', kind: 'document.folder', purpose: 'the typed folder', rows: [folderRow(over)] });
const TYPED_EVIDENCE = (over) => [CASE_ROWS, CANDS, FOLDER_READ(over)];
const TYPED_REFS = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q4', row_number: 1 }];
const typed = (over = {}) => relink({ folder_path: TYPED, evidence: TYPED_REFS, ...over });
const typedSetup = (over = {}) => ({ meta: TYPED_META, listing: { entries: [{ '.tag': 'file', name: 'a.pdf', server_modified: '2026-09-20T10:00:00Z' }, { '.tag': 'file', name: 'b.pdf', server_modified: '2026-10-01T10:00:00Z' }, { '.tag': 'file', name: 'c.pdf' }], truncated: false },
  registered: { n: 5, newest: '2026-10-01T10:00:00.000Z' }, predict: { total: 5, unattached: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, path_lower: `${TYPED}/f${i}.pdf` })) }, ...over });

describe('A11.1X typed folder path — proposable only with a cited document.folder read of the EXACT path', () => {
  test('the read must exist for that exact path (a re-cased one is told to copy exactly), and its row must be cited', async () => {
    await refuse(typed({ folder_path: TYPED.toUpperCase() }), `"${TYPED.toUpperCase()}" differs from the path the document.folder read lists in capitalisation or spacing — copy folder_path EXACTLY as that read lists it`, undefined, TYPED_EVIDENCE());
    await refuse(typed({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 2 }] }), `Cite the folder row: the evidence must include the document.folder row whose path is "${TYPED}"`, undefined, TYPED_EVIDENCE());
    // A folder read of ANOTHER path does not make this one proposable.
    await refuse(typed(), /^NOT A CANDIDATE: /, undefined, TYPED_EVIDENCE({ path: '/law/closed/ other' }));
    // The candidates read of the case is still required.
    await refuse(typed(), /^Read the folder candidates first/, undefined, [CASE_ROWS, FOLDER_READ()]);
    untouched();
  });
  test('the read must say it exists, is a folder and sits under an enabled root', async () => {
    await refuse(typed(), `The document.folder read found nothing at "${TYPED}" in Dropbox — nothing to propose`, undefined, TYPED_EVIDENCE({ exists: '0', is_folder: '0', under_enabled_root: '1' }));
    await refuse(typed(), `"${TYPED}" is a FILE in Dropbox, not a folder — a case folder must be a folder`, undefined, TYPED_EVIDENCE({ is_folder: '0' }));
    await refuse(typed(), `"${TYPED}" is under NO enabled sync root: the document sync would never walk it, so its documents would never register — the relink route refuses it too (400). Add a sync root for it first (More → Documents → Sync), or pick a folder inside one`, undefined, TYPED_EVIDENCE({ under_enabled_root: '0' }));
    untouched();
  });
  test('after the reads the folder is re-read from Dropbox and the owners index: gone, a file, no root, another case\'s, the current folder', async () => {
    await refuse(typed(), `"${TYPED}" no longer exists in Dropbox (it moved, was renamed or deleted since the read) — read the folder again`, typedSetup({ meta: 'missing' }), TYPED_EVIDENCE());
    await refuse(typed(), `"${TYPED}" is a FILE in Dropbox, not a folder — a case folder must be a folder`, typedSetup({ meta: { ...TYPED_META, '.tag': 'file' } }), TYPED_EVIDENCE());
    await refuse(typed(), `"${TYPED}" is under NO enabled sync root`, typedSetup({ roots: ['/other'] }), TYPED_EVIDENCE());
    await refuse(typed(), `ANOTHER CASE HOLDS THIS FOLDER: "${TYPED}" is already case OTHER123's folder — linking it here as well would put both clients' documents on both cases, and the route refuses it (409). Never proposable; if that case is the wrong one, fix it first`, typedSetup({ owners: [[TYPED, 'OTHER123']] }), TYPED_EVIDENCE());
    await refuse(typed(), `That changes nothing — case 25-12345 already points at "${TYPED}"`, typedSetup({ out: freshOut({ current_path: TYPED }) }), TYPED_EVIDENCE());
    // The sync switched off refuses before Dropbox is asked.
    await refuse(typed(), /^THE DOCUMENT SYNC IS SWITCHED OFF/, typedSetup({ enabled: false }), TYPED_EVIDENCE());
    expect(calls.dropbox).toEqual([]);
  });
  test('the card: the Dropbox proof in place of a lane, the NOT A CANDIDATE danger line, the typed folder and expected', async () => {
    const d = await run(typed(), typedSetup({ owners: [[`${TYPED}/nested - lee`, 'NEST1111']] }), TYPED_EVIDENCE());
    expect(calls.dropbox).toEqual([['getMetadata', { path: TYPED }], ['listFolder', { path: TYPED, recursive: false, maxEntries: 500 }]]);
    expect(d.effects[0]).toBe(`Matched on: NOTHING — a typed path, not one of the panel's candidates. A Dropbox read through the document sync's account proved it: it exists and is a folder (shown as "/Law/Closed/ Old Files - Smith"), it sits under the sync root "/law", and it holds 3 files directly (newest 2026-10-01) and 0 subfolders; 5 registered files are under it.`);
    expect(d.warnings).toEqual([`NOT A CANDIDATE: neither the case number nor a client's name (Smith, Dana; Smith, Lee) is in this folder's name (" old files - smith") — the panel would never suggest it, and nothing but your word ties it to this case. Every file under it attaches to this case: be sure it is this client's folder.`]);
    expect(d.effects).toContain('Nested case folders: NEST1111 has its own folder inside this one; its files stay on that case (a file belongs to the innermost case folder).');
    expect(d.effects).toContain('Attaches NOW: 5 registered files of the 5 under this folder get the sync\'s link to this case and show on its Documents tab at once — silently: no document.linked event fires for them.');
    expect(d.folder).toEqual({ path: TYPED, path_display: '/Law/Closed/ Old Files - Smith', files: 5, newest: '2026-10-01T10:00:00.000Z', confidence: 'typed', matched_on: null, inside_case_id: null, nested_case_ids: ['NEST1111'],
      root: '/law', listed_files: 3, listed_folders: 0, listing_truncated: false, newest_listed: '2026-10-01T10:00:00.000Z' });
    expect(d.expected).toEqual({ case_dropbox: 'https://www.dropbox.com/scl/fo/old', current_path: '/law/potential/smith', path: TYPED, files: 5, already_linked_to: null, typed: 1 });
    expect(d.evidence.map((e) => [e.query_id, e.row_number])).toEqual([['q1', 1], ['q4', 1]]);
    // The prediction's LIKE is the typed folder's subtree, lowercased.
    const attachQ = calls.queries.find(([sql]) => sql.startsWith('SELECT d.id, d.path_lower FROM documents d LEFT JOIN'));
    expect(attachQ[1]).toEqual(['path', `${TYPED}/%`]);
  });
  test('a typed path that the fresh re-read finds AS a candidate is a candidate card (the lane, no danger line)', async () => {
    const out = freshOut(); out.candidates.push({ path: TYPED, files: 5, newest: null, confidence: 'name', matched_on: 'Smith, Dana', inside_case_id: null, already_linked_to: null, nested_case_ids: null });
    const d = await run(typed(), typedSetup({ out }), TYPED_EVIDENCE());
    expect(d.effects[0]).toBe('Matched on: the name lane — every required word of the client name "Smith, Dana" (surname and first given name) appears in the folder\'s name.');
    expect(d.warnings).toEqual([]);
    expect(d.folder.confidence).toBe('name');
    expect(calls.dropbox).toEqual([]);
  });
});

describe('A11.1X the typed read document.folder', () => {
  test('validateStep takes ONE full folder path (never the root); the fingerprint folds case', () => {
    expect(validateStep({ id: 'q1', kind: 'document.folder', purpose: 'p', path: TYPED }, 0)).toEqual({ id: 'q1', kind: 'document.folder', purpose: 'p', path: TYPED });
    for (const v of [undefined, '', '/', 'law/x', `${TYPED}\n`, '/a\u0001b', `/${'x'.repeat(1024)}`, 42]) {
      expect(() => validateStep({ id: 'q1', kind: 'document.folder', purpose: 'p', path: v }, 0)).toThrow('Step q1 document.folder needs "path": one full Dropbox folder path starting with "/"');
    }
    expect(stepFingerprint({ kind: 'document.folder', path: '/Law/X' })).toBe('document.folder:/law/x');
  });
  test('a folder: the head row\'s facts and one row per nested case folder; files held by a case are named', async () => {
    const db = setup(typedSetup({ owners: [[`${TYPED}/nested - lee`, 'NEST1111'], ['/law/closed', 'OUTER111']], predict: { heldBy: [{ case_id: 'OTHER123', n: 2 }] } }));
    const r = await documentFolderRead(db, TYPED);
    expect(calls.dropbox).toEqual([['getMetadata', { path: TYPED }], ['listFolder', { path: TYPED, recursive: false, maxEntries: 500 }]]);
    expect(r.truncated).toBe(false);
    expect(r.rows[0]).toMatchObject({ row_type: 'folder', path: TYPED, path_lower: TYPED, path_display: '/Law/Closed/ Old Files - Smith', folder_name: ' old files - smith',
      exists: 1, is_folder: 1, under_enabled_root: 1, root: '/law', listed_files: 3, listed_folders: 0, listing_truncated: 0, newest_listed: '2026-10-01T10:00:00.000Z',
      registered_files: 5, registered_newest: '2026-10-01T10:00:00.000Z', already_linked_to: null, inside_case_id: 'OUTER111', nested_case_ids: 'NEST1111', held_by: 'OTHER123 (2)', proposable: 1 });
    expect(r.rows[0].note).toMatch(/^A folder a case may be linked to \(case\.folder\.relink\.v1 with this exact "path", citing this row\) when it is this client's folder\. Read through the documents sync's own Dropbox account: exists yes, folder yes, enabled sync root "\/law"; 3 files and 0 subfolders listed directly; 5 registered files under it in YisraCase — files already carrying a case's sync link stay with that case \(2 on case OTHER123\); INSIDE case OUTER111's folder; 1 other case folder nested inside it \(rows below\)\. Whether it is a CANDIDATE/);
    expect(r.rows.filter((x) => x.row_type === 'nested_case_folder')).toEqual([{ row_type: 'nested_case_folder', case_id: 'NEST1111', path: `${TYPED}/nested - lee`, parent_path: TYPED, note: `Case NEST1111's cached folder sits inside "${TYPED}"; its files stay on that case after a re-link of the parent` }]);
    // A11X: one entry row per direct entry follows (tests/caseyDocumentsGenerate.test.js pins their shape); the listing's files carry no id here.
    expect(r.rows.map((x) => x.row_type)).toEqual(['folder', 'nested_case_folder', 'entry', 'entry', 'entry']);
    expect(r.rows.slice(2).map((x) => [x.name, x.entry_id, x.is_folder, x.registered_document_id])).toEqual([['a.pdf', null, 0, null], ['b.pdf', null, 0, null], ['c.pdf', null, 0, null]]);
  });
  test('missing, a file, under no root, another case\'s folder, the account root — never proposable, each saying why', async () => {
    const missing = await documentFolderRead(setup(typedSetup({ meta: 'missing' })), TYPED);
    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0]).toMatchObject({ exists: 0, is_folder: 0, path_display: null, listed_files: 0, proposable: 1 - 1 });
    expect(missing.rows[0].note).toMatch(/^NOT IN DROPBOX — nothing to propose; check the spelling \(leading spaces in a segment count\), or search Dropbox\. .* exists no, folder no, enabled sync root "\/law"; 0 files/);
    expect(calls.dropbox.map((c) => c[0])).toEqual(['getMetadata']);
    const file = await documentFolderRead(setup(typedSetup({ meta: { ...TYPED_META, '.tag': 'file' } })), TYPED);
    expect(file.rows[0]).toMatchObject({ exists: 1, is_folder: 0, proposable: 0 });
    expect(file.rows[0].note).toMatch(/^A FILE, not a folder — a case folder must be a folder\./);
    expect(calls.dropbox.map((c) => c[0])).toEqual(['getMetadata']);
    const noRoot = await documentFolderRead(setup(typedSetup({ roots: ['/other'] })), TYPED);
    expect(noRoot.rows[0]).toMatchObject({ exists: 1, is_folder: 1, under_enabled_root: 0, root: null, proposable: 0 });
    expect(noRoot.rows[0].note).toMatch(/^UNDER NO ENABLED SYNC ROOT — the document sync will never see it, so its documents would never register; the relink route refuses it \(400\)\./);
    const owned = await documentFolderRead(setup(typedSetup({ owners: [[TYPED, 'OTHER123']] })), TYPED);
    expect(owned.rows[0]).toMatchObject({ already_linked_to: 'OTHER123', proposable: 0 });
    expect(owned.rows[0].note).toMatch(/^ANOTHER CASE'S FOLDER \(case OTHER123\) — never proposable \(the route answers 409\)\./);
    const root = await documentFolderRead(setup(typedSetup()), '/');
    expect(root).toEqual({ rows: [{ row_type: 'folder', path: '/', exists: 0, is_folder: 0, under_enabled_root: 0, proposable: 0, note: 'The Dropbox account root is not a folder a case can be linked to' }], truncated: false });
    expect(calls.dropbox).toEqual([]);
  });
  test('a Dropbox error other than not-found is the read\'s failure, never a "does not exist"', async () => {
    const db = setup(typedSetup());
    dropbox.getMetadata.mockImplementation(async () => { throw Object.assign(new Error('dropbox: POST /2/files/get_metadata → 429: rate limited'), { status: 429 }); });
    await expect(documentFolderRead(db, TYPED)).rejects.toThrow('429: rate limited');
  });
});

const dismiss = (over = {}) => ({ kind: 'case.folder.dismiss.v1', case_id: CASE_ID, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });

describe('A11.1X case.folder.dismiss.v1 — a note on the relink queue for ONE case', () => {
  test("the switch: '0' makes the kind unavailable", async () => {
    process.env.CASEY_DOCUMENT_RELINK_ENABLED = '0';
    await expect(run(dismiss())).rejects.toThrow(/^Action kind is unavailable$/);
    untouched();
  });
  test('refused by name before anything is read: bulk (one card per case — the panel dismisses many), unknown keys, a non-boolean undo, the id, the evidence', async () => {
    for (const k of ['case_ids', 'all', 'queue', 'bulk']) {
      await refuse(dismiss({ [k]: [CASE_ID] }), `BULK refused (${k}): one card per case; the Documents relink panel dismisses many at once (its "Dismiss all"). Casey's card is the only screen that reaches cases outside the panel's queue, and a bulk dismiss there is a bulk re-link's ask in disguise`);
    }
    await refuse(dismiss({ folder_path: '/x' }), 'A dismiss card carries unsupported fields: folder_path — it takes case_id, undo and evidence only');
    await refuse(dismiss({ undo: 'yes' }), 'A dismiss card\'s "undo" is true (return the case to the queue) or omitted (dismiss it)');
    await refuse(dismiss({ case_id: 'bad id!' }), 'A dismiss card needs the case\'s exact case_id');
    await refuse(dismiss({ evidence: [{ query_id: 'q1', row_number: 2 }] }), `The dismiss evidence does not identify case ${CASE_ID} — cite a sql.read row carrying its exact case_id (read the case first)`);
    // The candidates read's own head row does not identify the case.
    await refuse(dismiss({ evidence: [{ query_id: 'q2', row_number: 1 }] }), 'does not identify case');
    untouched();
  });
  test('after the reads: a gone case; no cache row (the route would stamp nothing); the state already equal', async () => {
    await refuse(dismiss(), `Case ${CASE_ID} no longer exists`, { out: null });
    await refuse(dismiss(), 'Case 25-12345 has no folder-cache row — it has never been in the relink queue (the queue is the cache\'s rows), and the dismiss route would stamp nothing. There is nothing to dismiss', { cacheRow: null });
    await refuse(dismiss({ undo: true }), 'There is nothing to un-dismiss', { cacheRow: null });
    await refuse(dismiss(), 'Case 25-12345 is already dismissed from the relink queue (2026-09-01, by Fred (user 6)) — nothing to do; a card with undo:true returns it to the queue',
      { cacheRow: { ...CACHE_ROW, relink_dismissed_at: '2026-09-01T10:00:00.000Z', relink_dismissed_by: 6 } });
    await refuse(dismiss({ undo: true }), 'Case 25-12345 is not dismissed from the relink queue — there is no dismissal to undo');
    expect(calls.enabled).toBe(0); // the dismiss route has no sync gate, so the card has none
  });
  test('the dismiss card: the cached folder, the state, the queue line, the CANDIDATES warning, the two-column write and nothing else, expected', async () => {
    const d = await run(dismiss());
    expect(d).toMatchObject({ kind: 'case.folder.dismiss.v1', status: 'draft', undo: false,
      case: { case_id: CASE_ID, label: '25-12345', clients: ['Smith, Dana', 'Smith, Lee'] },
      cache: { path: '/law/potential/smith', path_display: '/Law/Potential/Smith', resolved_at: '2026-10-30T12:00:00.000Z', resolve_error: null, dismissed_at: null, dismissed_by: null },
      queue: { in_queue: true, has_links: false, candidates: 2, proposable: 2 } });
    expect(d.effects).toEqual([
      'Cached folder: "/Law/Potential/Smith" (resolved 2026-10-30).',
      'Dismissal now: not dismissed.',
      'Relink queue now: IN the queue (a cached folder and no document attributed to the case) — shown.',
      'Writes: two columns on the case\'s folder-cache row — relink_dismissed_at is set to now and relink_dismissed_by to you. NOTHING ELSE: no document link is made or removed, no case field changes, nothing in Dropbox changes, no event fires, no log entry is written (the stamp itself records who and when).',
      'Panel: the Documents relink panel hides the case from its queue (visible again under "show dismissed").',
      'Reversal: a card with undo:true (or the panel\'s checkbox) returns it to the queue.',
      'One case: this card stamps ONE case; the panel\'s "Dismiss all" clears many at once.',
    ]);
    expect(d.warnings).toEqual([`THIS CASE HAS 2 CANDIDATE FOLDERS ("${FOLDER}", "${OTHER_FOLDER}"): dismissing says "nothing to do here" although a folder may fit. Link the right one instead (a re-link clears the dismissal), or be sure none of them is this client's.`]);
    expect(d.expected).toEqual({ dismissed_at: null, current_path: '/law/potential/smith', case_dropbox: 'https://www.dropbox.com/scl/fo/old' });
    expect(d.evidence.map((e) => [e.query_id, e.row_number])).toEqual([['q1', 1]]);
    expect(calls.rules).toEqual([]); // no event fires: no dry run
  });
  test('the un-dismiss card for a case outside the queue with no candidates', async () => {
    const d = await run(dismiss({ undo: true }), { cacheRow: { ...CACHE_ROW, relink_dismissed_at: '2026-09-01T10:00:00.000Z', relink_dismissed_by: 6 }, linked: true, out: freshOut({ candidates: [] }) });
    expect(d.undo).toBe(true);
    expect(d.effects).toEqual([
      'Cached folder: "/Law/Potential/Smith" (resolved 2026-10-30).',
      'Dismissal now: dismissed on 2026-09-01 by Fred (user 6).',
      'Relink queue now: NOT in the queue (the case already has documents attributed) — the dismissal stamp is only a note on the cache row.',
      'Candidates: the panel\'s lanes find no folder for this case — the usual reason to dismiss (the client never sent a document).',
      'Writes: two columns on the case\'s folder-cache row — relink_dismissed_at and relink_dismissed_by are CLEARED. NOTHING ELSE: no document link is made or removed, no case field changes, nothing in Dropbox changes, no event fires, no log entry is written.',
      'Panel: the Documents relink panel shows the case in its queue again once it qualifies (a cached folder and no attributed document).',
      'Reversal: a dismiss card (or the panel) dismisses it again.',
      'One case: this card stamps ONE case; the panel\'s "Dismiss all" clears many at once.',
    ]);
    expect(d.warnings).toEqual([]);
    expect(d.expected).toEqual({ dismissed_at: '2026-09-01T10:00:00.000Z', current_path: '/law/potential/smith', case_dropbox: 'https://www.dropbox.com/scl/fo/old' });
  });
  test('an unresolved cache row and a resolve error read as such; an unknown dismisser is named by number', async () => {
    const d = await run(dismiss({ undo: true }), { cacheRow: { ...CACHE_ROW, path_lower: null, path_display: null, resolve_error: 'link revoked', relink_dismissed_at: '2026-09-01T10:00:00.000Z', relink_dismissed_by: 9 }, users: {}, out: freshOut({ candidates: [freshOut().candidates[0]] }) });
    expect(d.effects.slice(0, 4)).toEqual([
      'Cached folder: none — the case\'s Dropbox link has never resolved to a folder (link revoked).',
      'Dismissal now: dismissed on 2026-09-01 by user 9.',
      'Relink queue now: NOT in the queue (its folder never resolved) — the dismissal stamp is only a note on the cache row.',
      'Candidates: the panel\'s lanes find 1 folder for this case, none proposable.',
    ]);
  });
});

const LOG_ROWS = { id: 'q3', kind: 'sql.read', purpose: 'the relink audit entries', rows: [{ log_id: String(LOG_ID), log_date: '2026-11-10 09:30:00', log_by: '6', log_subject: 'Case Dropbox folder re-linked' }, { log_id: '47000', log_date: '2026-10-01 08:00:00', log_by: '6' }] };
const UNDO_EVIDENCE = [CASE_ROWS, CANDS, LOG_ROWS];
const UNDO_REFS = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 1 }];
const undo = (over = {}) => ({ kind: 'case.folder.relink.undo.v1', case_id: CASE_ID, log_id: LOG_ID, evidence: UNDO_REFS, ...over });
const runUndo = (value, opts) => run(value, opts, UNDO_EVIDENCE);
const refuseUndo = (value, re, opts) => refuse(value, re, opts, UNDO_EVIDENCE);

describe('A11.1X case.folder.relink.undo.v1 — the latest re-link, undone through the same route', () => {
  test("the switch: '0' makes the kind unavailable", async () => {
    process.env.CASEY_DOCUMENT_RELINK_ENABLED = '0';
    await expect(runUndo(undo())).rejects.toThrow(/^Action kind is unavailable$/);
    untouched();
  });
  test('refused by name before anything is read: bulk (no bulk undo), a folder key (the folder is the entry\'s), unknown keys, the ids, the two cited rows', async () => {
    await refuseUndo(undo({ case_ids: [CASE_ID] }), 'BULK refused (case_ids): an undo card undoes ONE case\'s latest re-link. There is no bulk re-link in YisraCase, on purpose — "a bulk verb would exist to save eight clicks and would be the single most dangerous button in the app" (the relink route\'s own header) — and no bulk undo either');
    for (const k of ['folder_path', 'path', 'old_path', 'case_dropbox']) {
      await refuseUndo(undo({ [k]: FOLDER }), `FOLDER refused (${k}): an undo card names no folder — the folder comes from the cited audit entry's old_path. Name the entry in "log_id"`);
    }
    await refuseUndo(undo({ foo: 1 }), 'An undo card carries unsupported fields: foo — it takes case_id, log_id and evidence only');
    await refuseUndo(undo({ case_id: 'bad id!' }), 'An undo card needs the case\'s exact case_id');
    for (const v of [undefined, 0, -1, 'x', '1.5', 1.5]) {
      await refuseUndo(undo({ log_id: v }), 'An undo card needs "log_id": the log_id of the case\'s "Case Dropbox folder re-linked" log entry (sql.read the log table for it)');
    }
    await refuseUndo(undo({ evidence: [{ query_id: 'q3', row_number: 1 }] }), `The undo evidence does not identify case ${CASE_ID} — cite a sql.read row carrying its exact case_id (read the case first)`);
    await refuseUndo(undo({ evidence: [{ query_id: 'q1', row_number: 1 }, { query_id: 'q3', row_number: 2 }] }), new RegExp(`^Cite the audit entry: the evidence must include a sql.read row of the log table carrying log_id ${LOG_ID} \\(SELECT log_id, log_date, log_by FROM log WHERE log_link_type = 'case' AND log_link_id = '${CASE_ID}' AND log_subject = 'Case Dropbox folder re-linked' ORDER BY log_id DESC\\)$`));
    // A string log_id in the card is accepted when it cites the same entry.
    untouched();
  });
  test('after the reads, in order: a gone case; not that entry; NOT THE LATEST; no previous folder; the sync off; the link moved on; the current folder', async () => {
    await refuseUndo(undo(), `Case ${CASE_ID} no longer exists`, { out: null });
    const notEntry = `Log entry #${LOG_ID} is not a "Case Dropbox folder re-linked" entry of case 25-12345 — only that entry (type update, on this case, with its relink record) can be undone`;
    await refuseUndo(undo(), notEntry, { logRow: null });
    await refuseUndo(undo(), notEntry, { logRow: AUDIT({ log_subject: 'Case merged' }) });
    await refuseUndo(undo(), notEntry, { logRow: AUDIT({ log_link_id: 'OTHER123' }) });
    await refuseUndo(undo(), notEntry, { logRow: AUDIT({ log_type: 'note' }) });
    await refuseUndo(undo(), notEntry, { logRow: { ...AUDIT(), log_extra: JSON.stringify({ merge: {} }) } });
    await refuseUndo(undo(), `A NEWER RE-LINK EXISTS for case 25-12345: entry #48300 (2026-11-12 08:00 firm time) is the latest. Only the latest re-link can be undone — undo that one first (one step at a time; each undo is itself a re-link with its own entry)`, { latestLog: { log_id: 48300, at_text: '2026-11-12 08:00' } });
    await refuseUndo(undo(), `Entry #${LOG_ID} recorded no previous folder (the case had no cached folder before that re-link, only a link that never resolved) — there is nothing to re-link back to. To clear the case's folder, unlink its documents one by one and clear the Dropbox link by hand`, { logRow: AUDIT({ relink: { old_path: null } }) });
    await refuseUndo(undo(), /^THE DOCUMENT SYNC IS SWITCHED OFF/, { enabled: false });
    await refuseUndo(undo(), `Case 25-12345's Dropbox link is no longer the one entry #${LOG_ID} wrote — someone changed it since, so that entry is not what the case's current state came from. Nothing to undo from it`, { prior: { case_dropbox: 'https://www.dropbox.com/scl/fo/moved-on' } });
    await refuseUndo(undo(), `Case 25-12345's Dropbox link is no longer the one entry #${LOG_ID} wrote (it is blank now)`, { prior: { case_dropbox: null } });
    await refuseUndo(undo(), `That changes nothing — case 25-12345 already points at "${FOLDER}"`, { out: freshOut({ current_path: FOLDER }) });
    expect(calls.dropbox).toEqual([]);
  });
  test('the old folder is proved in Dropbox and the owners index: gone, a file, no root, another case\'s', async () => {
    await refuseUndo(undo(), `THE OLD FOLDER IS GONE: "${FOLDER}" no longer exists in Dropbox (moved, renamed or deleted since 2026-11-10 09:30) — there is nothing to re-link back to. Link the right folder instead (a document.folder read proves a folder; the candidates read lists the panel's)`, { meta: 'missing' });
    await refuseUndo(undo(), `"${FOLDER}" is a FILE in Dropbox now, not a folder — nothing to re-link back to`, { meta: { ...FOLDER_META, '.tag': 'file' } });
    await refuseUndo(undo(), `"${FOLDER}" is under NO enabled sync root any more: the document sync would never walk it, and the relink route refuses it (400). Add a sync root for it first, or link another folder`, { roots: [] });
    await refuseUndo(undo(), `ANOTHER CASE HOLDS THE OLD FOLDER: "${FOLDER}" is case OTHER123's folder now — re-linking it here would put both clients' documents on both cases, and the route refuses it (409). Never proposable; if that case is the wrong one, fix it first`, { owners: [[FOLDER, 'OTHER123']] });
  });
  test('the card: the entry, the three paths, the old folder\'s proof, the lane (a candidate today), the link, the counts, the audit and expected', async () => {
    const d = await runUndo(undo({ log_id: String(LOG_ID) }), { predict: { detach: 3, kept: 1 } });
    expect(d.kind).toBe('case.folder.relink.undo.v1');
    expect(d.case).toEqual({ case_id: CASE_ID, label: '25-12345', case_number: '25-12345', case_number_full: null, clients: ['Smith, Dana', 'Smith, Lee'] });
    expect(d.audit).toEqual({ log_id: LOG_ID, at_text: '2026-11-10 09:30', by: 'Fred (user 6)', old_path: FOLDER, old_link: 'https://www.dropbox.com/scl/fo/older', new_path: '/law/potential/smith', new_link: 'https://www.dropbox.com/scl/fo/old', linked_docs: 3, detached_docs: 2 });
    expect(d.effects.slice(0, 6)).toEqual([
      `Audit entry: #${LOG_ID} on 2026-11-10 09:30 firm time by Fred (user 6) re-linked the case from "${FOLDER}" to "/law/potential/smith" (detached 2, attached 3). It is the case's latest re-link.`,
      `Paths: before that re-link "${FOLDER}" → now "/Law/Potential/Smith" → back to "${FOLDER}".`,
      `Old folder: still in Dropbox (shown as "/Law/Active/ 7 - Smith, Dana - 25-12345"), under the sync root "/law", 2 files directly (newest 2026-10-01) and 1 subfolder; 12 registered files are under it.`,
      'Matched on: the docket lane — the case number "25-12345" appears in the folder\'s name (the old folder is one of the panel\'s candidates today).',
      'Case link: the case\'s Dropbox link (cases.case_dropbox) is REWRITTEN — from https://www.dropbox.com/scl/fo/old — to the old folder\'s permanent Dropbox shared link: Dropbox\'s existing link for it (usually the one the entry recorded, https://www.dropbox.com/scl/fo/older), else a NEW one created with public visibility (anyone holding it can open the folder).',
      'Attaches NOW: 12 registered files of the 12 under the old folder get the sync\'s link to this case again and show on its Documents tab at once — silently: no document.linked event fires for them.',
    ]);
    expect(d.warnings).toEqual(['DETACHES 3 DOCUMENTS: 3 of this case\'s links the sync made to files OUTSIDE the old folder — the files the re-link being undone attached, among them — are deleted, and those files leave the case\'s Documents tab. Only machine links go — 1 link a person made (or with another relation) stays.']);
    expect(d.effects).toContain(`Audit: this undo is itself a re-link — one NEW log entry on the case ("Case Dropbox folder re-linked") records who did it, the current path and link as the old ones, the old folder as the new one, and the counts. Entry #${LOG_ID} stays.`);
    expect(d.effects).toContain('Filing: from now on everything YisraCase files into "the case folder" goes back to the OLD folder — client uploads from the portal and the public documents link (its "Client Uploads" subfolder), filed form PDFs (Forms), signed e-sign documents (Signed Documents), and automation steps that use {{case_dropbox}}. Anything filed into the current folder since the re-link stays where it is.');
    expect(d.effects[d.effects.length - 1]).toBe('Trigger event: case.updated fires (source "documents_relink", field case_dropbox) when the link actually changes — every active rule on it that would act is listed below, checked against a stand-in for the re-minted link (it is minted when you apply).');
    expect(d.folder).toEqual({ path: FOLDER, path_display: '/Law/Active/ 7 - Smith, Dana - 25-12345', files: 12, newest: '2026-10-01T10:00:00.000Z', confidence: 'docket', matched_on: '25-12345', inside_case_id: null, nested_case_ids: [],
      root: '/law', listed_files: 2, listed_folders: 1, listing_truncated: false, newest_listed: '2026-10-01T10:00:00.000Z' });
    expect(d.no_undo).toBe('This undo is itself a re-link with its own audit entry; it is reversed the same way — an undo card on that new entry — or by re-linking the right folder. Files filed into the current folder since the re-link stay there.');
    expect(d.expected).toEqual({ case_dropbox: 'https://www.dropbox.com/scl/fo/old', current_path: '/law/potential/smith', path: FOLDER, files: 12, already_linked_to: null, log_id: LOG_ID, typed: 1 });
    expect(d.automation).toEqual({ events: ['case.updated'], lines: [], rules_checked: 0, quiet: 0 });
    expect(calls.rules).toEqual(['case.updated']);
    expect(calls.dropbox).toEqual([['getMetadata', { path: FOLDER }], ['listFolder', { path: FOLDER, recursive: false, maxEntries: 500 }]]);
    // The entry was read by its id and the latest by the case + subject; the prediction's LIKE is the OLD folder's subtree.
    expect(calls.queries.find(([sql]) => sql.startsWith('SELECT log_id, log_type'))[1]).toEqual([LOG_ID]);
    expect(calls.queries.find(([sql]) => sql.startsWith('SELECT log_id, DATE_FORMAT'))[1]).toEqual([CASE_ID, 'Case Dropbox folder re-linked']);
    expect(calls.queries.find(([sql]) => sql.startsWith('SELECT d.id, d.path_lower FROM documents d LEFT JOIN'))[1]).toEqual(['path', `${FOLDER}/%`]);
  });
  test('an old folder that is NOT a candidate today carries the danger line; nested and inside-of folders, the dismissal, an Automations actor', async () => {
    const OLD = '/law/closed/ old smith';
    const d = await runUndo(undo(), { logRow: AUDIT({ log_by: 0, relink: { old_path: OLD, old_link: null } }), meta: { ...FOLDER_META, path_lower: OLD, path_display: '/Law/Closed/ Old Smith' },
      owners: [[`${OLD}/joint`, 'NEST1111'], ['/law/closed', 'OUTER111']], out: freshOut({ dismissed_at: '2026-09-01T00:00:00.000Z' }),
      predict: { total: 4, unattached: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, path_lower: `${OLD}/f${i}.pdf` })) }, registered: { n: 4, newest: null } });
    expect(d.effects[0]).toBe(`Audit entry: #${LOG_ID} on 2026-11-10 09:30 firm time by Automations re-linked the case from "${OLD}" to "/law/potential/smith" (detached 2, attached 3). It is the case's latest re-link.`);
    // No lane line: the "Matched on" slot is the danger warning instead, so the link line is next.
    expect(d.effects[3]).toBe('Case link: the case\'s Dropbox link (cases.case_dropbox) is REWRITTEN — from https://www.dropbox.com/scl/fo/old — to the old folder\'s permanent Dropbox shared link: Dropbox\'s existing link for it (usually the one the entry recorded), else a NEW one created with public visibility (anyone holding it can open the folder).');
    expect(d.warnings).toEqual([
      `NOT A CANDIDATE: neither the case number nor a client's name (Smith, Dana; Smith, Lee) is in the old folder's name (" old smith") — the panel would not suggest it. The entry says the case pointed there once; nothing else ties it to this client. Be sure the undo is right.`,
      'INSIDE ANOTHER CASE\'S FOLDER: the old folder sits inside case OUTER111\'s folder. Its files that already carry that case\'s sync link stay there and do not attach here (counted above); files added later attach to THIS case. Joint debtors can make this right — make sure it is.',
    ]);
    expect(d.effects).toContain('Nested case folders: NEST1111 has its own folder inside the old one; its files stay on that case (a file belongs to the innermost case folder).');
    expect(d.effects).toContain('Relink queue: this case was dismissed from the relink queue (2026-09-01); applying clears the dismissal.');
    expect(d.folder).toMatchObject({ path: OLD, confidence: 'typed', matched_on: null, inside_case_id: 'OUTER111', nested_case_ids: ['NEST1111'], files: 4 });
    expect(d.audit.by).toBe('Automations');
  });
});
