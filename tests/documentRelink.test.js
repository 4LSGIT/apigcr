// tests/documentRelink.test.js
//
/**
 * services/documentSyncService.js — the GUIDED RE-LINK (Documents S3.3).
 *
 * WHAT MATTERS HERE, and it is all one thing:
 *
 *   A WRONG LINK PUTS CLIENT A'S BANKRUPTCY DOCUMENTS ON CLIENT B'S CASE PAGE.
 *
 * S3.1's related-documents view then fans them out to every contact related to
 * that case, badged, indistinguishable from a correct attribution. So every
 * test below is ultimately about the same failure, approached from a different
 * side:
 *
 *   · THE NAME LANE MATCHES WHOLE TOKENS. The first implementation tested
 *     `segment.indexOf(token)` and production data caught it: "Jones, TIA"
 *     matched " williams-jones, TIAnna", "Richardson, ANGEL" matched
 *     " richardson, ANGELa". Both are different clients. Both would have
 *     rendered with a confirm button. The substring tests below are the fence
 *     around that regression and they are the most important thing in the file.
 *
 *   · THE DOCKET LANE IS OPAQUE, ALWAYS. case_number / case_number_full are
 *     free text this codebase never decomposes. There is a test that feeds the
 *     lane a docket and asserts nothing matches on a digit group alone — if
 *     someone ever "improves" ranking by splitting a docket into year / judge /
 *     sequence, this fails.
 *
 *   · A FOLDER THAT IS ALREADY SOMEBODY'S IS SURFACED, NEVER CONFIRMABLE, and
 *     the server re-checks that on POST. The UI grey-out is a courtesy; the
 *     409 is the control, and a test drives it with a request the UI would
 *     never have sent.
 *
 *   · ATTRIBUTION AFTER A CONFIRM IS SILENT AND ENGINE-PARITY. One confirm can
 *     attach several hundred documents (377 in the largest production
 *     candidate); emitting document.linked for each would run the trigger
 *     engine hundreds of times over files that have sat in Dropbox for years.
 *     And it matches with _matchCase rather than a prefix, so a nested case's
 *     documents stay on the nested case.
 *
 *   · TARGETED CACHE REFRESH DID NOT DISTURB THE RECURRING ONE. The no-arg
 *     path is what the scheduled job runs against 1,009 cases; a targeted mode
 *     that changed its ordering or its limit would be a silent regression in a
 *     job nobody watches.
 *
 * NO network, NO real DB. dropboxService, caseService, logService, alerting and
 * domainEvents are mocked; documentService is REAL, so the bulk-link and
 * emission contracts are exercised rather than asserted into place.
 *
 * Run:
 *   npx jest tests/documentRelink.test.js
 */

'use strict';

jest.mock('../services/dropboxService', () => ({
  // THE REAL normalizePath. Root and folder validation depend on its exact
  // behaviour — specifically that it NEVER touches whitespace, because this
  // firm's folders are named "  Active Cases" and a stub that trimmed would
  // let a test pass against a path the engine could never open.
  normalizePath: jest.requireActual('../services/dropboxService').normalizePath,
  getOrCreateSharedLink: jest.fn(),
  getSharedLinkMetadata: jest.fn(),
  getMetadata: jest.fn(),
  isPathNotFoundError: (err) => !!err && err.status === 409 &&
    String(err.errorSummary || '').startsWith('path/not_found'),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(async () => {}),
  buildChanges: jest.requireActual('../lib/domainEvents').buildChanges,
}));
jest.mock('../services/caseService', () => ({ updateCase: jest.fn(async () => ({})) }));
jest.mock('../services/logService', () => ({ createLogEntry: jest.fn(async () => ({ log_id: 1 })) }));

const dropbox      = require('../services/dropboxService');
const caseService  = require('../services/caseService');
const logService   = require('../services/logService');
const domainEvents = require('../lib/domainEvents');
const sync         = require('../services/documentSyncService');

// The folder inventory is memoised per process for 60s (see
// RELINK_INVENTORY_TTL_MS). A suite that did not drop it would have every test
// after the first assert against the first test's fixture.
beforeEach(() => {
  jest.clearAllMocks();
  sync._clearInventoryCache();
});

// ─────────────────────────────────────────────────────────────
// The firm's real tree shape — leading spaces and all
// ─────────────────────────────────────────────────────────────

const ACTIVE    = '/  law office/   cases/  active cases';
const POTENTIAL = '/  law office/   cases/  potential cases';
const CLOSED    = '/  law office/   cases/ closed cases';
const ROOTS = [
  { id: 1, path: '/  Law Office/   Cases/  Active Cases' },
  { id: 2, path: '/  Law Office/   Cases/  Potential Cases' },
  { id: 3, path: '/  Law Office/   Cases/ Closed Cases' },
];

/**
 * SQL-text-dispatching stub, purpose-built for this slice.
 *
 * `dirs` are LEAF directories with their own immediate file counts — exactly
 * what the GROUP BY returns — so the transitive roll-up is exercised rather
 * than fed its own answer.
 */
function makeDb({
  dirs = [], cases = [], contacts = [], cache = [], zero = null,
  docsUnder = [], roots = ROOTS, settings = {},
} = {}) {
  const calls = [];
  const db = {
    calls,
    sqls: () => calls.map(c => c.sql),
    find: (needle) => calls.find(c => c.sql.includes(needle)),
    all:  (needle) => calls.filter(c => c.sql.includes(needle)),
    linkInserts: [],
    query: async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });

      if (/^SELECT LEFT\(path_lower/.test(flat)) return [dirs];
      if (/^SELECT id, path FROM document_sync_roots/.test(flat)) return [roots];

      if (/^SELECT case_id, path_lower FROM case_folder_cache/.test(flat)) return [cache];
      if (/^SELECT case_id, folder_external_id, path_lower/.test(flat)) {
        return [cache.filter(c => c.path_lower)];
      }
      if (/^SELECT case_id, path_lower, path_display, resolved_at, resolve_error/.test(flat)) {
        const want = new Set((params[0] || []).map(String));
        return [cache.filter(c => want.has(String(c.case_id)))];
      }
      if (/^SELECT path_lower FROM case_folder_cache WHERE case_id/.test(flat)) {
        const hit = cache.find(c => String(c.case_id) === String(params[0]));
        return [hit ? [hit] : []];
      }
      if (/FROM case_folder_cache f LEFT JOIN document_links/.test(flat)) {
        return [zero || []];
      }
      if (/^UPDATE case_folder_cache/.test(flat)) {
        const ids = new Set((Array.isArray(params[1]) ? params[1] : [params[1]]).map(String));
        let n = 0;
        for (const c of cache) if (ids.has(String(c.case_id))) { n++; c.touched = true; }
        return [{ affectedRows: n }];
      }
      // APPLIED, NOT MERELY ACKNOWLEDGED. refreshCaseFolderCache upserts the
      // resolved path here and applyRelink then READS IT BACK to decide what to
      // attribute. A stub that returned affectedRows without moving the row
      // would let the confirm assert green while attributing against the stale
      // intake path — which is the bug this whole slice exists to fix.
      if (/^INSERT INTO case_folder_cache/.test(flat)) {
        const id = String(params[0]);
        let row = cache.find(c => String(c.case_id) === id);
        if (!row) { row = { case_id: id }; cache.push(row); }
        if (params.length >= 4) {                    // the success upsert
          row.folder_external_id = params[1];
          row.path_lower   = params[2];
          row.path_display = params[3];
          row.resolve_error = null;
        } else {                                     // the failure upsert
          row.resolve_error = params[1];             // prior paths survive
        }
        return [{ affectedRows: 1 }];
      }

      if (/^SELECT case_id, case_number, case_number_full/.test(flat)) {
        const want = new Set((params[0] || []).map(String));
        return [cases.filter(c => want.has(String(c.case_id)))];
      }
      if (/^SELECT case_id, case_dropbox FROM cases WHERE case_id/.test(flat)) {
        const hit = cases.find(c => String(c.case_id) === String(params[0]));
        return [hit ? [hit] : []];
      }
      if (/FROM case_relate cr JOIN contacts ct/.test(flat)) {
        const want = new Set((params[0] || []).map(String));
        return [contacts.filter(c => want.has(String(c.case_id)))];
      }
      // refreshCaseFolderCache candidate scans (both modes)
      if (/FROM cases c/.test(flat)) {
        if (/c\.case_id IN \(\?\)/.test(flat)) {
          const want = new Set((params[0] || []).map(String));
          return [cases.filter(c => want.has(String(c.case_id)) && c.case_dropbox)];
        }
        return [cases.filter(c => c.case_dropbox)];
      }

      if (/^SELECT d\.id, d\.path_lower FROM documents d/.test(flat)) return [docsUnder];
      if (/^INSERT INTO document_links/.test(flat)) {
        db.linkInserts.push(params);
        return [{ affectedRows: 1 }];
      }
      if (/FROM app_settings WHERE `key` = \?/.test(flat)) {
        const v = settings[params[0]];
        return [v === undefined ? [] : [{ value: v }]];
      }
      if (/^INSERT INTO app_settings/.test(flat)) return [{ affectedRows: 1 }];

      throw new Error('stubDb: unhandled SQL: ' + flat.slice(0, 140));
    },
  };
  return db;
}

const dir = (path, files = 1, newest = '2026-01-01T00:00:00Z') =>
  ({ dir: path, files: String(files), newest });
const kase = (case_id, over = {}) => ({
  case_id, case_number: null, case_number_full: null, case_dropbox: 'https://dbx/old',
  case_stage: 'Open', pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: '',
  ...over,
});
const contact = (case_id, lfm, rel = 'Primary') =>
  ({ case_id, contact_name: lfm, contact_lfm_name: lfm, rel });

const paths = out => (out.candidates || []).map(c => c.path);
const lanes = out => (out.candidates || []).map(c => c.confidence);

// ═════════════════════════════════════════════════════════════════════════════
// The name lane — whole tokens, and the production false positives it stops
// ═════════════════════════════════════════════════════════════════════════════

describe('name lane — WHOLE-TOKEN equality, not substring', () => {
  test('THE TIA/TIANNA TRAP: a given name must not match inside a longer one', async () => {
    const db = makeDb({
      dirs: [dir(`${CLOSED}/ closed files/ williams-jones, tianna - chapter 7 - 21-47011`, 134)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Jones, Tia')],
      cache: [],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(out.candidates).toEqual([]);
  });

  test('THE ANGEL/ANGELA TRAP, the same shape from the other side', async () => {
    const db = makeDb({
      dirs: [dir(`${POTENTIAL}/  potential - bankruptcy/ richardson, angela`, 4)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Richardson, Angel')],
    });
    expect((await sync.relinkCandidates(db, 'c1')).candidates).toEqual([]);
  });

  test('a surname alone is NOT the name lane — that is the weak lane, and it is off', async () => {
    const db = makeDb({
      dirs: [dir(`${POTENTIAL}/  potential - bankruptcy/ mitchell, vinyanda`, 9)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Mitchell, Natasha')],
    });
    expect((await sync.relinkCandidates(db, 'c1')).candidates).toEqual([]);

    const weak = await sync.relinkCandidates(db, 'c1', { includeWeak: true });
    expect(lanes(weak)).toEqual(['weak']);
  });

  test('surname AND given name present is the name lane', async () => {
    const db = makeDb({
      dirs: [dir(`${POTENTIAL}/  potential - bankruptcy/ mitchell, natasha - c1 - 2024-03-25`, 3)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Mitchell, Natasha')],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(lanes(out)).toEqual(['name']);
    expect(out.candidates[0].matched_on).toBe('Mitchell, Natasha');
  });

  test('a MIDDLE name is optional — the identifying pair is surname + first given', async () => {
    const db = makeDb({
      dirs: [dir(`${POTENTIAL}/  potential - bankruptcy/ baker, reginald`, 1)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Baker, Reginald Lindsay')],
    });
    expect(lanes(await sync.relinkCandidates(db, 'c1'))).toEqual(['name']);
  });

  test('a hyphenated surname matches on both halves', async () => {
    const db = makeDb({
      dirs: [dir(`${POTENTIAL}/  potential - bankruptcy/ booker-coker, telicia`, 2)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Booker-Coker, Telicia')],
    });
    expect(lanes(await sync.relinkCandidates(db, 'c1'))).toEqual(['name']);
  });

  test('leading and embedded spaces in folder names are never trimmed away', async () => {
    const p = `${POTENTIAL}/  potential - bankruptcy/   trash?/ tester, test`;
    const db = makeDb({
      dirs: [dir(p, 2)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'TESTER, TEST')],
    });
    expect(paths(await sync.relinkCandidates(db, 'c1'))).toEqual([p]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The docket lane — opaque, and higher confidence than a name
// ═════════════════════════════════════════════════════════════════════════════

describe('docket lane', () => {
  test('matches the docket as an opaque case-insensitive substring', async () => {
    const p = `${ACTIVE}/  active - bankruptcy/ 13 - myers, sharon - 23-46646-lsg - chapter 13`;
    const db = makeDb({
      dirs: [dir(p, 164)],
      cases: [kase('c1', { case_number_full: '23-46646-LSG' })],
      contacts: [],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(paths(out)).toEqual([p]);
    expect(out.candidates[0].confidence).toBe('docket');
  });

  test('DOCKET BEATS NAME when both lanes hit different folders', async () => {
    const dk = `${ACTIVE}/  active - bankruptcy/ 13 - myers, s - 23-46646-lsg - chapter 13`;
    const nm = `${POTENTIAL}/  potential - bankruptcy/ myers, sharon`;
    const db = makeDb({
      dirs: [dir(nm, 900), dir(dk, 2)],           // name lane has FAR more files
      cases: [kase('c1', { case_number_full: '23-46646-lsg' })],
      contacts: [contact('c1', 'Myers, Sharon')],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    // Confidence outranks volume. A big pile of documents behind a weaker
    // match is not a reason to put it first.
    expect(paths(out)[0]).toBe(dk);
    expect(lanes(out)).toEqual(['docket', 'name']);
  });

  test('DOCKET BEATS NAME on the SAME folder — one entry, the stronger lane', async () => {
    const p = `${ACTIVE}/  active - bankruptcy/ 13 - myers, sharon - 23-46646-lsg - chapter 13`;
    const db = makeDb({
      dirs: [dir(p, 164)],
      cases: [kase('c1', { case_number_full: '23-46646-lsg' })],
      contacts: [contact('c1', 'Myers, Sharon')],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].confidence).toBe('docket');
  });

  test('THE OPACITY FENCE: no part of a docket is ever matched on its own', async () => {
    // Every folder here shares a COMPONENT of the docket — the year, the
    // sequence, the judge's initials, and a re-ordering. A lane that split
    // "23-46646-lsg" into fields would light up on all four. It must not: a
    // docket is free text this codebase stores and compares, never parses.
    const db = makeDb({
      dirs: [
        dir(`${ACTIVE}/  active - bankruptcy/ 13 - other, a - 23-99999-lsg - chapter 13`, 5),
        dir(`${ACTIVE}/  active - bankruptcy/ 13 - other, b - 21-46646-mar - chapter 13`, 5),
        dir(`${ACTIVE}/  active - bankruptcy/ 13 - other, c - lsg - chapter 13`, 5),
        dir(`${ACTIVE}/  active - bankruptcy/ 13 - other, d - 46646-23-lsg - chapter 13`, 5),
      ],
      cases: [kase('c1', { case_number_full: '23-46646-lsg' })],
      contacts: [],
    });
    expect((await sync.relinkCandidates(db, 'c1')).candidates).toEqual([]);
  });

  test('case_number is used too, and only when it differs from case_number_full', async () => {
    const p = `${ACTIVE}/  active - bankruptcy/ 13 - x - 23-46646 - chapter 13`;
    const db = makeDb({
      dirs: [dir(p, 3)],
      cases: [kase('c1', { case_number: '23-46646', case_number_full: '23-46646-lsg' })],
      contacts: [],
    });
    expect(paths(await sync.relinkCandidates(db, 'c1'))).toEqual([p]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Folder-level derivation
// ═════════════════════════════════════════════════════════════════════════════

describe('candidate derivation from the directory inventory', () => {
  test('the SHALLOWEST matching folder wins, so subfolders come along', async () => {
    const caseFolder = `${ACTIVE}/  active - bankruptcy/ 13 - armstrong, jordan - chapter 13`;
    const db = makeDb({
      dirs: [
        dir(`${caseFolder}/ docket - jordan armstrong`, 20),
        dir(`${caseFolder}/ drafts - jordan armstrong`, 5),
      ],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Armstrong, Jordan')],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(paths(out)).toEqual([caseFolder]);
    // TRANSITIVE, because attribution walks up: linking the parent surfaces
    // everything beneath it, and the count has to say so.
    expect(out.candidates[0].files).toBe(25);
  });

  test('case folders at DIFFERENT DEPTHS are both found — depth is never assumed', async () => {
    const a = `${ACTIVE}/  active - bankruptcy/ 13 - smith, john - chapter 13`;   // root + 2
    const c = `${CLOSED}/ smith, john 2`;                                          // root + 1
    const db = makeDb({
      dirs: [dir(a, 4), dir(c, 7)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Smith, John')],
    });
    expect(paths(await sync.relinkCandidates(db, 'c1')).sort()).toEqual([a, c].sort());
  });

  test('a TYPE level is excluded — it holds several cases, so it is not one', async () => {
    const typeLevel = `${ACTIVE}/  active - jones`;
    const db = makeDb({
      dirs: [dir(`${typeLevel}/ case one`, 3), dir(`${typeLevel}/ case two`, 3)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Jones, Kimberly')],
      cache: [
        { case_id: 'other1', path_lower: `${typeLevel}/ case one` },
        { case_id: 'other2', path_lower: `${typeLevel}/ case two` },
      ],
    });
    // Even though "  active - jones" carries the surname, two other cases live
    // under it, so it is a container and not a candidate.
    expect(paths(await sync.relinkCandidates(db, 'c1'))).not.toContain(typeLevel);
  });

  test('ONE nested case does NOT make a folder a type level (the Stewart shape)', async () => {
    // Production has a closed case folder with a potential case's folder
    // nested inside it. At a threshold of one, that real case folder would be
    // excluded from its own client's list.
    const outer = `${CLOSED}/ 7 - stewart, david - chapter 7`;
    const db = makeDb({
      dirs: [dir(`${outer}/ client docs`, 12)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Stewart, David')],
      cache: [{ case_id: 'other1', path_lower: `${outer}/ client docs/ stewart, david - 2024-03-11` }],
    });
    expect(paths(await sync.relinkCandidates(db, 'c1'))).toContain(outer);
  });

  test('a sync ROOT is never a candidate, however it matches', async () => {
    const db = makeDb({
      dirs: [dir(`${ACTIVE}/ cases, active`, 3)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Cases, Active')],
      roots: [{ id: 1, path: '/  Law Office/   Cases/  Active Cases' }],
    });
    expect(paths(await sync.relinkCandidates(db, 'c1'))).not.toContain(ACTIVE);
  });

  test('folders outside every enabled root are invisible', async () => {
    const db = makeDb({
      dirs: [dir('/  law office/   billing/ smith, john', 40)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Smith, John')],
    });
    expect((await sync.relinkCandidates(db, 'c1')).candidates).toEqual([]);
  });

  test('the candidate list is capped and says so', async () => {
    const dirs = [];
    for (let i = 0; i < 15; i++) {
      dirs.push(dir(`${POTENTIAL}/  potential - bankruptcy/ smith, john ${i}`, i + 1));
    }
    const db = makeDb({ dirs, cases: [kase('c1')], contacts: [contact('c1', 'Smith, John')] });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(out.candidates).toHaveLength(sync.RELINK_CANDIDATE_CAP);
    expect(out.candidates_truncated).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The exclusion — surfaced, never confirmable
// ═════════════════════════════════════════════════════════════════════════════

describe('a folder that is already another case\u2019s', () => {
  test('is SURFACED with the owner named, not silently dropped', async () => {
    const p = `${POTENTIAL}/  potential - bankruptcy/ smith, john`;
    const db = makeDb({
      dirs: [dir(p, 6)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Smith, John')],
      cache: [{ case_id: 'owner9', path_lower: p }],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    // Seeing the collision tells a staffer where the documents actually went.
    expect(out.candidates[0].already_linked_to).toEqual(['owner9']);
    // And it is NOT actionable, which is what keeps it out of the default view.
    expect(out.actionable).toBe(false);
  });

  test('a folder cached to THIS case is not "already linked" to somebody else', async () => {
    const p = `${POTENTIAL}/  potential - bankruptcy/ smith, john`;
    const db = makeDb({
      dirs: [dir(p, 6)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Smith, John')],
      cache: [{ case_id: 'c1', path_lower: p }],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    expect(out.candidates[0].already_linked_to).toBeNull();
  });

  test('sitting INSIDE another case\u2019s folder is disclosed (the joint-debtor shape)', async () => {
    const outer = `${CLOSED}/ 7 - gardin, alicia - chapter 7`;
    const inner = `${outer}/ client docs - dennis gardin and alicia gardin`;
    const db = makeDb({
      dirs: [dir(inner, 107)],
      cases: [kase('c1')],
      contacts: [contact('c1', 'Gardin, Dennis')],
      cache: [{ case_id: 'alicia1', path_lower: outer }],
    });
    const out = await sync.relinkCandidates(db, 'c1');
    // Plausibly right (joint debtors), which is exactly why the human confirming
    // has to be told rather than have it ranked silently.
    expect(out.candidates[0].inside_case_id).toBe('alicia1');
    expect(out.candidates[0].already_linked_to).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The queue
// ═════════════════════════════════════════════════════════════════════════════

describe('relinkQueue', () => {
  const zeroRows = [
    { case_id: 'c1', path_lower: `${POTENTIAL}/ a`, path_display: null, relink_dismissed_at: null },
    { case_id: 'c2', path_lower: `${POTENTIAL}/ b`, path_display: null, relink_dismissed_at: null },
  ];

  test('separates actionable from no-candidate, and counts both', async () => {
    const p = `${POTENTIAL}/  potential - bankruptcy/ smith, john`;
    const db = makeDb({
      dirs: [dir(p, 6)],
      cases: [kase('c1'), kase('c2')],
      contacts: [contact('c1', 'Smith, John'), contact('c2', 'Nobody, Here')],
      cache: zeroRows.map(r => ({ case_id: r.case_id, path_lower: r.path_lower })),
      zero: zeroRows,
    });
    const q = await sync.relinkQueue(db);
    expect(q.total).toBe(2);
    expect(q.actionable).toBe(1);
    expect(q.no_candidate).toBe(1);
  });

  test('dismissed rows are hidden by default and returned when asked for', async () => {
    const rows = [
      { ...zeroRows[0], relink_dismissed_at: '2026-08-27T00:00:00Z' },
      zeroRows[1],
    ];
    const db = makeDb({
      dirs: [], cases: [kase('c1'), kase('c2')],
      contacts: [], cache: rows.map(r => ({ case_id: r.case_id, path_lower: r.path_lower })),
      zero: rows,
    });
    expect((await sync.relinkQueue(db)).shown).toBe(1);
    expect((await sync.relinkQueue(db, { includeDismissed: true })).shown).toBe(2);
    expect((await sync.relinkQueue(db)).dismissed).toBe(1);
  });

  test('READ-ONLY: no writes, no provider calls', async () => {
    const db = makeDb({ dirs: [], cases: [], contacts: [], cache: [], zero: [] });
    await sync.relinkQueue(db);
    expect(db.sqls().some(s => /^(INSERT|UPDATE|DELETE)/i.test(s))).toBe(false);
    expect(dropbox.getOrCreateSharedLink).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Dismissal
// ═════════════════════════════════════════════════════════════════════════════

describe('setRelinkDismissed', () => {
  const cache = [{ case_id: 'c1', path_lower: '/x' }, { case_id: 'c2', path_lower: '/y' }];

  test('stamps the two columns and NOTHING else — no link, no case, no Dropbox', async () => {
    const db = makeDb({ cache });
    const out = await sync.setRelinkDismissed(db, ['c1'], { actorUserId: 9 });
    expect(out.updated).toBe(1);

    const w = db.find('UPDATE case_folder_cache');
    expect(w.sql).toMatch(/relink_dismissed_at = NOW\(\)/);
    expect(w.params[0]).toBe(9);
    expect(db.sqls().some(s => /document_links|UPDATE cases/.test(s))).toBe(false);
    expect(dropbox.getOrCreateSharedLink).not.toHaveBeenCalled();
  });

  test('undo clears both columns', async () => {
    const db = makeDb({ cache });
    await sync.setRelinkDismissed(db, ['c1'], { dismissed: false, actorUserId: 9 });
    const w = db.find('UPDATE case_folder_cache');
    expect(w.sql).toMatch(/relink_dismissed_at = NULL/);
    expect(w.params[0]).toBeNull();
  });

  test('bulk is one statement, deduped and capped', async () => {
    const many = [];
    for (let i = 0; i < sync.RELINK_DISMISS_CAP + 50; i++) many.push('id' + i);
    const db = makeDb({ cache: many.map(id => ({ case_id: id, path_lower: '/x/' + id })) });
    const out = await sync.setRelinkDismissed(db, [...many, 'id0']);
    expect(out.case_ids).toHaveLength(sync.RELINK_DISMISS_CAP);
    expect(db.all('UPDATE case_folder_cache')).toHaveLength(1);
  });

  test('an empty list is a no-op, not an UPDATE with an empty IN()', async () => {
    const db = makeDb({ cache });
    expect((await sync.setRelinkDismissed(db, [])).updated).toBe(0);
    expect(db.all('UPDATE case_folder_cache')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The confirm
// ═════════════════════════════════════════════════════════════════════════════

describe('applyRelink', () => {
  const TARGET = `${ACTIVE}/  active - bankruptcy/ 13 - myers, sharon - 23-46646-lsg - chapter 13`;

  function confirmDb(over = {}) {
    return makeDb({
      dirs: [dir(TARGET, 164)],
      cases: [kase('c1', { case_dropbox: 'https://dbx/intake-link' })],
      contacts: [contact('c1', 'Myers, Sharon')],
      cache: [{ case_id: 'c1', path_lower: `${POTENTIAL}/ myers, sharon - c1 - 2024-01-01` }],
      docsUnder: [
        { id: 101, path_lower: `${TARGET}/a.pdf` },
        { id: 102, path_lower: `${TARGET}/ docket/b.pdf` },
      ],
      ...over,
    });
  }

  beforeEach(() => {
    dropbox.getOrCreateSharedLink.mockResolvedValue('https://dbx/new-folder-link');
    dropbox.getSharedLinkMetadata.mockResolvedValue({
      path_lower: TARGET, path_display: TARGET, id: 'id:folder',
    });
  });

  test('the happy path: link rewritten, cache refreshed, documents attributed', async () => {
    const db = confirmDb();
    const out = await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });

    expect(dropbox.getOrCreateSharedLink).toHaveBeenCalledWith(db, { path: TARGET });
    // THE HOUSE WRITE PATH, not a raw UPDATE from the service.
    expect(caseService.updateCase).toHaveBeenCalledWith(
      db, 'c1', { case_dropbox: 'https://dbx/new-folder-link' },
      { userId: 9, source: 'documents_relink' },
    );
    expect(out.linked_docs).toBe(2);
    expect(out.old_path).toBe(`${POTENTIAL}/ myers, sharon - c1 - 2024-01-01`);
    expect(out.new_path).toBe(TARGET);
  });

  test('the targeted cache refresh runs for THIS case only', async () => {
    const db = confirmDb();
    await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });
    const scan = db.find('c.case_id IN (?)');
    expect(scan).toBeTruthy();
    expect(scan.params[0]).toEqual(['c1']);
    // and NOT the oldest-first sweep the recurring job runs
    expect(db.sqls().some(s => /ORDER BY \(f\.resolved_at IS NULL\) DESC/.test(s))).toBe(false);
  });

  test('attribution is SILENT and carries relation = path', async () => {
    const db = confirmDb();
    await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });

    // One confirm can attach hundreds of documents; emitting for each would
    // run the trigger engine over files years old.
    const emitted = domainEvents.emit.mock.calls.map(c => c[1]);
    expect(emitted).not.toContain('document.linked');
    expect(emitted).not.toContain('document.created');

    const ins = db.linkInserts[0];
    expect(ins).toContain('path');
    expect(ins).toContain('case');
    // NULL created_by is the machine-link discriminator (S3.1 hygiene rule).
    expect(ins[4]).toBeNull();
  });

  test('ENGINE PARITY: a nested case\u2019s documents are left on the nested case', async () => {
    const nested = `${TARGET}/ sub-case`;
    const db = confirmDb({
      cache: [
        { case_id: 'c1', path_lower: `${POTENTIAL}/ old` },
        { case_id: 'other9', path_lower: nested },
      ],
      docsUnder: [
        { id: 101, path_lower: `${TARGET}/mine.pdf` },
        { id: 202, path_lower: `${nested}/theirs.pdf` },
      ],
    });
    // The cache row for c1 is rewritten to TARGET by the refresh; _matchCase
    // then resolves theirs.pdf to `other9` because it is the INNERMOST match.
    const out = await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });
    // Only the document whose innermost match is c1 was linked. A naive
    // prefix sweep would have taken both — that is the leak.
    expect(out.linked_docs).toBe(1);
    expect(db.linkInserts[0]).toContain(101);
    expect(db.linkInserts[0]).not.toContain(202);
  });

  test('THE CROSS-LINK GUARD IS RE-RUN SERVER-SIDE — 409, with the owner named', async () => {
    const db = confirmDb({
      cache: [
        { case_id: 'c1', path_lower: `${POTENTIAL}/ old` },
        { case_id: 'owner9', path_lower: TARGET },
      ],
    });
    // A request the UI would never have sent: the panel renders this candidate
    // greyed with no confirm control at all. The guard cannot rely on that.
    await expect(sync.applyRelink(db, 'c1', TARGET, {}))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('owner9') });

    expect(caseService.updateCase).not.toHaveBeenCalled();
    expect(dropbox.getOrCreateSharedLink).not.toHaveBeenCalled();
    expect(db.linkInserts).toHaveLength(0);
  });

  test('a folder under NO enabled root is refused', async () => {
    const db = confirmDb();
    await expect(sync.applyRelink(db, 'c1', '/  law office/   billing/ somewhere', {}))
      .rejects.toMatchObject({ status: 400 });
    expect(caseService.updateCase).not.toHaveBeenCalled();
  });

  test('an unknown case is a 404 before anything is touched', async () => {
    const db = confirmDb();
    await expect(sync.applyRelink(db, 'nope', TARGET, {}))
      .rejects.toMatchObject({ status: 404 });
    expect(dropbox.getOrCreateSharedLink).not.toHaveBeenCalled();
  });

  test('an over-long shared link is REJECTED, never clamped', async () => {
    // A truncated URL is not a shortened label, it is a link that resolves to
    // nothing — and this schema has no STRICT_TRANS_TABLES to catch it.
    dropbox.getOrCreateSharedLink.mockResolvedValue('https://dbx/' + 'x'.repeat(400));
    const db = confirmDb();
    await expect(sync.applyRelink(db, 'c1', TARGET, {}))
      .rejects.toMatchObject({ status: 500, message: expect.stringContaining('truncated') });
    expect(caseService.updateCase).not.toHaveBeenCalled();
  });

  test('a folder with no registered files falls back to a provider stat', async () => {
    const empty = `${ACTIVE}/  active - bankruptcy/ brand new folder`;
    dropbox.getMetadata.mockResolvedValue({ '.tag': 'folder', path_lower: empty });
    dropbox.getSharedLinkMetadata.mockResolvedValue({ path_lower: empty });
    const db = confirmDb({ docsUnder: [] });
    const out = await sync.applyRelink(db, 'c1', empty, {});
    expect(dropbox.getMetadata).toHaveBeenCalled();
    expect(out.warnings.join(' ')).toMatch(/no registered documents/);
  });

  test('a path that is a FILE is refused', async () => {
    dropbox.getMetadata.mockResolvedValue({ '.tag': 'file' });
    const db = confirmDb({ docsUnder: [] });
    await expect(sync.applyRelink(db, 'c1', `${ACTIVE}/  active - bankruptcy/ x.pdf`, {}))
      .rejects.toMatchObject({ status: 400 });
  });

  test('the AUDIT ENTRY is written, on the case, with both paths and the count', async () => {
    const db = confirmDb();
    await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });

    expect(logService.createLogEntry).toHaveBeenCalledTimes(1);
    const entry = logService.createLogEntry.mock.calls[0][1];
    expect(entry).toMatchObject({ type: 'update', link_type: 'case', link_id: 'c1', by: 9 });
    expect(entry.message).toContain(TARGET);
    expect(entry.message).toContain(`${POTENTIAL}/ myers, sharon - c1 - 2024-01-01`);
    expect(entry.extra.relink).toMatchObject({
      new_path: TARGET, linked_docs: 2, new_link: 'https://dbx/new-folder-link',
    });
  });

  test('a failed audit write does not unwind a correct repair', async () => {
    logService.createLogEntry.mockRejectedValueOnce(new Error('log is down'));
    const db = confirmDb();
    const out = await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });
    expect(out.linked_docs).toBe(2);
    expect(out.warnings.join(' ')).toMatch(/audit log/);
  });

  test('any dismissal is cleared by a confirm', async () => {
    const db = confirmDb();
    await sync.applyRelink(db, 'c1', TARGET, { actorUserId: 9 });
    expect(db.all('relink_dismissed_at = NULL').length).toBeGreaterThan(0);
  });

  test('a cache refresh that fails is REPORTED, not swallowed', async () => {
    dropbox.getSharedLinkMetadata.mockRejectedValue(new Error('dropbox is down'));
    const db = confirmDb({
      cache: [{ case_id: 'c1', path_lower: `${POTENTIAL}/ old` }],
    });
    const out = await sync.applyRelink(db, 'c1', TARGET, {});
    // The link IS updated; the documents will attach on the next cache run.
    expect(caseService.updateCase).toHaveBeenCalled();
    expect(out.warnings.join(' ')).toMatch(/resolved the new link|did not refresh/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The targeted refresh must not have disturbed the recurring one
// ═════════════════════════════════════════════════════════════════════════════

describe('refreshCaseFolderCache — targeted mode is additive', () => {
  beforeEach(() => {
    dropbox.getSharedLinkMetadata.mockResolvedValue({ path_lower: `${ACTIVE}/ x`, id: 'id:1' });
  });

  test('NO-ARG behaviour is untouched: oldest-first, limited', async () => {
    const db = makeDb({ cases: [kase('c1'), kase('c2')] });
    const out = await sync.refreshCaseFolderCache(db, { limit: 7 });
    const scan = db.find('FROM cases c');
    expect(scan.sql).toMatch(/ORDER BY \(f\.resolved_at IS NULL\) DESC, f\.resolved_at ASC/);
    expect(scan.sql).toMatch(/LIMIT 7/);
    expect(out.targeted).toBeUndefined();
  });

  test('caseIds resolves EXACTLY those, ignoring staleness and the limit', async () => {
    const db = makeDb({ cases: [kase('c1'), kase('c2'), kase('c3')] });
    const out = await sync.refreshCaseFolderCache(db, { caseIds: ['c2', 'c2', 'c3'], limit: 1 });
    const scan = db.find('FROM cases c');
    expect(scan.sql).not.toMatch(/ORDER BY/);
    expect(scan.params[0]).toEqual(['c2', 'c3']);      // deduped
    expect(out.resolved).toBe(2);                      // the limit of 1 did not apply
    expect(out.targeted).toBe(true);
  });

  test('an empty caseIds list resolves NOTHING rather than falling through to the sweep', async () => {
    const db = makeDb({ cases: [kase('c1')] });
    const out = await sync.refreshCaseFolderCache(db, { caseIds: [] });
    expect(out.scanned).toBe(0);
    expect(db.all('FROM cases c')).toHaveLength(0);
    expect(dropbox.getSharedLinkMetadata).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Inventory internals
// ═════════════════════════════════════════════════════════════════════════════

describe('_buildFolderInventory', () => {
  test('rolls counts UP the tree, because attribution walks up', async () => {
    const db = makeDb({
      dirs: [dir(`${ACTIVE}/ a/ b`, 3), dir(`${ACTIVE}/ a/ c`, 4), dir(`${ACTIVE}/ a`, 1)],
    });
    const inv = await sync._buildFolderInventory(db, { noCache: true });
    expect(inv.files.get(`${ACTIVE}/ a`)).toBe(8);
    expect(inv.files.get(`${ACTIVE}/ a/ b`)).toBe(3);
  });

  test('keeps the NEWEST server_modified of everything beneath', async () => {
    const db = makeDb({
      dirs: [
        dir(`${ACTIVE}/ a/ b`, 1, '2024-01-01T00:00:00Z'),
        dir(`${ACTIVE}/ a/ c`, 1, '2026-05-05T00:00:00Z'),
      ],
    });
    const inv = await sync._buildFolderInventory(db, { noCache: true });
    expect(inv.newest.get(`${ACTIVE}/ a`)).toBe('2026-05-05T00:00:00Z');
  });

  test('is memoised, and the seam clears it', async () => {
    const db = makeDb({ dirs: [dir(`${ACTIVE}/ a`, 1)] });
    await sync._buildFolderInventory(db);
    await sync._buildFolderInventory(db);
    expect(db.all('SELECT LEFT(path_lower')).toHaveLength(1);
    sync._clearInventoryCache();
    await sync._buildFolderInventory(db);
    expect(db.all('SELECT LEFT(path_lower')).toHaveLength(2);
  });
});

describe('_nameKey', () => {
  test('splits "Last, First Middle" into a required pair and the rest', () => {
    expect(sync._nameKey('Mitchell, Natasha Q')).toMatchObject({
      required: ['mitchell', 'natasha'], surname: ['mitchell'],
    });
  });

  test('a hyphenated surname keeps both halves required', () => {
    expect(sync._nameKey('Booker-Coker, Telicia').required)
      .toEqual(['booker', 'coker', 'telicia']);
  });

  test('with NO comma every token is required — guessing the surname is worse', () => {
    expect(sync._nameKey('John Smith').required).toEqual(['john', 'smith']);
  });

  test('drops initials and honorifics rather than requiring them', () => {
    expect(sync._nameKey('Smith, John Jr').required).toEqual(['smith', 'john']);
  });
});

describe('_likeEscape', () => {
  test('escapes the LIKE metacharacters so a folder named "100%_x" is literal', () => {
    expect(sync._likeEscape('/a/100%_x')).toBe('/a/100|%|_x');
  });
});
