// tests/documentSyncService.test.js
//
/**
 * services/documentSyncService.js — the Dropbox → registry sync engine
 * (Documents S2).
 *
 * WHAT MATTERS HERE
 *   - MODE IS DERIVED FROM CURSOR PRESENCE. Not a stored flag. This is the
 *     recovery mechanism, not a shortcut: a 409 `reset` clears the cursor,
 *     which drops the root back into backfill mode, which is emissions-OFF —
 *     so a forced re-list of 121,000 files cannot storm the trigger engine.
 *     If mode selection ever stops keying on the cursor, that safety property
 *     silently disappears.
 *   - THE CURSOR IS PERSISTED PER PAGE. There is no long-running backfill
 *     process anywhere in this architecture — a "job execution" is a slice of
 *     one poll tick. Resumability IS the design, so a crash between pages
 *     must lose nothing and re-do nothing.
 *   - path/not_found ON A ROOT IS AN EMPTY ROOT, NOT AN ERROR. Three of the
 *     seven seeded roots do not exist in Dropbox yet (lazily created by the
 *     upload / e-sign / forms ladders). Treating that as failure would park
 *     three roots in a permanent error state forever.
 *   - LONGEST-PREFIX ATTRIBUTION AT SEGMENT BOUNDARIES. The firm's folders are
 *     named "  Smith, John - 12345 -  Chapter 7"; a second case for the same
 *     client gets a longer name with the SAME PREFIX. A naive startsWith
 *     files documents against the wrong client's case, silently.
 *   - THE CLAIM. Poll ticks overlap and the function is hand-callable, so two
 *     runners must never walk one root.
 *   - THE KILL SWITCH IS FAIL-CLOSED. Absent means off.
 *
 * NO network, NO real DB. dropboxService, alerting and domainEvents are
 * jest.mock'd; documentService is REAL, so the bulk/emission contracts are
 * exercised end to end rather than stubbed past. The db stub keeps a live
 * Map of documents so id assignment and getByExternal behave like a database
 * instead of a fixture.
 *
 * Run:
 *   npx jest tests/documentSyncService.test.js
 */

'use strict';

jest.mock('../services/dropboxService', () => ({
  listFolderPage:     jest.fn(),
  listFolderContinue: jest.fn(),
  getSharedLinkMetadata: jest.fn(),
  // The real predicates are pure and worth exercising, not stubbing.
  isCursorResetError: (err) => !!err && err.status === 409 &&
    ((err.dropboxError && err.dropboxError['.tag'] === 'reset') ||
     String(err.errorSummary || '').startsWith('reset')),
  isPathNotFoundError: (err) => !!err && err.status === 409 &&
    String(err.errorSummary || '').startsWith('path/not_found'),
}));
jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../lib/domainEvents', () => ({
  emit: jest.fn(async () => {}),
  buildChanges: jest.requireActual('../lib/domainEvents').buildChanges,
}));

const dropbox      = require('../services/dropboxService');
const { alert }    = require('../lib/alerting');
const domainEvents = require('../lib/domainEvents');
const sync         = require('../services/documentSyncService');

// ─────────────────────────────────────────────────────────────
// Stub pool
// ─────────────────────────────────────────────────────────────

/**
 * SQL-text-dispatching stub with a LIVE documents map.
 *
 * Keeping real state (rather than scripting each SELECT) is what lets the
 * incremental path run for real: getByExternal returns null before the
 * INSERT and the row after it, so upsertFromEntry's created/updated decision
 * — and therefore its emission — is genuine rather than asserted into place.
 */
function makeDb({
  roots = [],
  cache = [],
  docs = new Map(),
  unlinked = [],
  settings = {},
  deletedRows = 0,
} = {}) {
  const calls = [];
  let nextId = 1;
  for (const d of docs.values()) nextId = Math.max(nextId, d.id + 1);

  const db = {
    calls,
    docs,
    roots,
    cacheRows: cache,
    sqls: () => calls.map(c => c.sql),
    find: (needle) => calls.find(c => c.sql.includes(needle)),
    all:  (needle) => calls.filter(c => c.sql.includes(needle)),
    /** How many claim UPDATEs matched — scripted by the test via claimWins. */
    claimWins: true,
    /** affectedRows the reconciler's DELETE reports (S3.1). */
    pathLinksDropped: 0,

    query: async (sql, params = []) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params });

      // ── document_sync_roots ────────────────────────────────────────────
      if (/^UPDATE document_sync_roots SET syncing_since = NOW\(\)/.test(flat)) {
        return [{ affectedRows: db.claimWins ? 1 : 0 }];
      }
      if (/^UPDATE document_sync_roots/.test(flat)) return [{ affectedRows: 1 }];
      if (/^SELECT \* FROM document_sync_roots WHERE id/.test(flat)) {
        return [roots.filter(r => String(r.id) === String(params[0]))];
      }
      if (/^SELECT \* FROM document_sync_roots/.test(flat)) {
        return [roots.filter(r => r.enabled)];
      }
      if (/^SELECT id, path FROM document_sync_roots/.test(flat)) {
        return [roots.filter(r => r.enabled).map(r => ({ id: r.id, path: r.path }))];
      }

      // ── case_folder_cache ──────────────────────────────────────────────
      if (/FROM case_folder_cache/.test(flat)) return [cache];
      if (/^INSERT INTO case_folder_cache/.test(flat)) return [{ affectedRows: 1 }];
      if (/^UPDATE case_folder_cache/.test(flat)) return [{ affectedRows: 1 }];

      // ── cases (refreshCaseFolderCache candidate scan) ──────────────────
      if (/FROM cases c/.test(flat)) return [db.caseRows || []];

      // ── documents ──────────────────────────────────────────────────────
      if (/^SELECT \* FROM documents WHERE source = \? AND external_id = \?/.test(flat)) {
        const hit = docs.get(String(params[1]));
        return [hit ? [hit] : []];
      }
      if (/^SELECT \* FROM documents WHERE id = \?/.test(flat)) {
        const hit = [...docs.values()].find(d => d.id === params[0]);
        return [hit ? [hit] : []];
      }
      if (/^SELECT id, external_id/.test(flat)) {
        const wanted = new Set((params[1] || []).map(String));
        return [[...docs.values()]
          .filter(d => wanted.has(d.external_id))
          .map(d => ({ id: d.id, external_id: d.external_id, path_lower: d.path_lower }))];
      }
      if (/^SELECT d\.id, d\.path_lower FROM documents d/.test(flat)) {
        return [unlinked];
      }
      if (/^INSERT INTO documents/.test(flat)) {
        // 13 params per row for both the single and bulk statements.
        for (let i = 0; i + 12 < params.length; i += 13) {
          const extId = String(params[i + 1]);
          const prior = docs.get(extId);
          docs.set(extId, {
            id: prior ? prior.id : nextId++,
            source: params[i], external_id: extId, name: params[i + 2],
            path: params[i + 3], path_lower: params[i + 4], path_hash: params[i + 5],
            ext: params[i + 6], mime: params[i + 7] ?? (prior ? prior.mime : null),
            size: params[i + 8], content_hash: params[i + 9], rev: params[i + 10],
            server_modified: params[i + 11], status: params[i + 12],
            title: null, doc_type: null, tags: null, ai_meta: null, shared_link: null,
          });
        }
        return [{ affectedRows: 1 }];
      }
      if (/^UPDATE documents SET status = 'deleted'/.test(flat)) {
        return [{ affectedRows: deletedRows }];
      }

      // ── document_links ─────────────────────────────────────────────────
      if (/^INSERT INTO document_links/.test(flat)) return [{ affectedRows: 1 }];
      if (/^SELECT \* FROM document_links/.test(flat)) return [[]];
      // S3.1 move reconciliation. `pathLinksDropped` is what the DELETE
      // reports; tests set it to say "there WAS a stale path-link here".
      if (/^DELETE FROM document_links/.test(flat)) {
        return [{ affectedRows: db.pathLinksDropped || 0 }];
      }

      // ── app_settings (kill switch + sweep watermark) ───────────────────
      if (/FROM app_settings WHERE `key` = \?/.test(flat)) {
        const v = settings[params[0]];
        return [v === undefined ? [] : [{ value: v }]];
      }
      if (/^INSERT INTO app_settings/.test(flat)) {
        settings[params[0]] = params[1];
        return [{ affectedRows: 1 }];
      }

      throw new Error('stubDb: unhandled SQL: ' + flat.slice(0, 120));
    },
  };
  return db;
}

const root = (over = {}) => ({
  id: 1,
  path: '/  Law Office/   Cases/  Active Cases',
  note: null,
  enabled: 1,
  sync_cursor: null,
  backfill_done: 0,
  last_sync_at: null,
  last_error: null,
  syncing_since: null,
  stats: null,
  ...over,
});

/** A Dropbox FileMetadata as list_folder returns one. */
const file = (pathLower, over = {}) => ({
  '.tag': 'file',
  id: `id:${pathLower}`,
  name: pathLower.slice(pathLower.lastIndexOf('/') + 1),
  path_display: pathLower,
  path_lower: pathLower,
  size: 100,
  content_hash: 'c'.repeat(64),
  rev: 'rev1',
  server_modified: '2026-08-01T10:00:00Z',
  ...over,
});

const folder  = (pathLower, id) => ({
  '.tag': 'folder', id, name: pathLower.slice(pathLower.lastIndexOf('/') + 1),
  path_display: pathLower, path_lower: pathLower,
});
const deleted = (pathLower) => ({ '.tag': 'deleted', name: 'x', path_lower: pathLower, path_display: pathLower });

const page = (entries, cursor, hasMore = false) => ({ entries, cursor, has_more: hasMore });

const dbxError = (status, summary, dropboxError = null) => {
  const e = new Error(`dropbox: POST /2/files/list_folder → ${status}: ${summary}`);
  e.status = status; e.errorSummary = summary; e.dropboxError = dropboxError;
  return e;
};

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks: clear only wipes recorded calls and
  // LEAVES IMPLEMENTATIONS IN PLACE, so a mockResolvedValue set by one test
  // silently serves the next one — which is how a test that never mocked
  // listFolderContinue can still "pass" against a stale page fixture. The
  // two pure predicates in the mock factory are plain functions and survive.
  jest.resetAllMocks();
  domainEvents.emit.mockImplementation(async () => {});
  alert.mockImplementation(async () => {});
});

const emittedTypes = () => domainEvents.emit.mock.calls.map(c => c[1]);

// ─────────────────────────────────────────────────────────────
// _matchCase — the attribution primitive
// ─────────────────────────────────────────────────────────────

describe('_matchCase — longest prefix at SEGMENT boundaries', () => {
  const cacheOf = (...paths) => new Map(paths.map(p => [p, { case_id: p, path_lower: p }]));

  test('THE NESTED-LOOKALIKE TRAP: "  case a" must not swallow "  case ab"', () => {
    // The firm names folders "  Smith, John - 12345 -  Chapter 7". A second
    // case for the same client is a LONGER name with the same prefix. A bare
    // startsWith files the second client's documents against the first.
    const cache = cacheOf('/x/  case a');
    expect(sync._matchCase(cache, '/x/  case ab/f.pdf')).toBeNull();
    expect(sync._matchCase(cache, '/x/  case a/f.pdf').case_id).toBe('/x/  case a');
  });

  test('with BOTH cached, each file lands on its own case', () => {
    const cache = cacheOf('/x/  case a', '/x/  case ab');
    expect(sync._matchCase(cache, '/x/  case a/f.pdf').case_id).toBe('/x/  case a');
    expect(sync._matchCase(cache, '/x/  case ab/f.pdf').case_id).toBe('/x/  case ab');
  });

  test('nested folders resolve to the INNERMOST cached case', () => {
    const cache = cacheOf('/x/  case a', '/x/  case a/  adversary b');
    expect(sync._matchCase(cache, '/x/  case a/  adversary b/  docket/f.pdf').case_id)
      .toBe('/x/  case a/  adversary b');
  });

  test('files in a subfolder of a case folder still attribute to the case', () => {
    const cache = cacheOf('/x/  case a');
    expect(sync._matchCase(cache, '/x/  case a/  docket/  2026/f.pdf').case_id).toBe('/x/  case a');
  });

  test('no match, empty cache, and a null path are all null (never a guess)', () => {
    expect(sync._matchCase(cacheOf('/x/  case a'), '/y/  other/f.pdf')).toBeNull();
    expect(sync._matchCase(new Map(), '/x/  case a/f.pdf')).toBeNull();
    expect(sync._matchCase(cacheOf('/x/  case a'), null)).toBeNull();
  });

  test('leading and embedded spaces are load-bearing, never trimmed', () => {
    const cache = cacheOf('/  law office/   cases/  active cases/  smith, john - 12345');
    expect(sync._matchCase(cache, '/  law office/   cases/  active cases/  smith, john - 12345/a.pdf'))
      .not.toBeNull();
    // The same path with the spaces collapsed is a DIFFERENT folder.
    expect(sync._matchCase(cache, '/law office/cases/active cases/smith, john - 12345/a.pdf'))
      .toBeNull();
  });
});

describe('_underRoot', () => {
  test('is segment-boundary safe in both directions', () => {
    expect(sync._underRoot('/a/b/c.pdf', '/a/b')).toBe(true);
    expect(sync._underRoot('/a/b', '/a/b')).toBe(true);
    expect(sync._underRoot('/a/bc/d.pdf', '/a/b')).toBe(false);
    expect(sync._underRoot(null, '/a/b')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// The claim
// ─────────────────────────────────────────────────────────────

describe('syncRoot — claim', () => {
  test('claims with a conditional UPDATE bounded by the stale window', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'cur1', false));

    await sync.syncRoot(db, root());

    const claim = db.calls[0];
    expect(claim.sql).toContain('UPDATE document_sync_roots SET syncing_since = NOW()');
    expect(claim.sql).toContain('syncing_since IS NULL OR syncing_since < NOW() - INTERVAL ? MINUTE');
    expect(claim.params).toEqual([1, sync.CLAIM_STALE_MIN]);
  });

  test('losing the claim returns skipped and touches NOTHING else', async () => {
    const db = makeDb({ roots: [root()] });
    db.claimWins = false;

    const out = await sync.syncRoot(db, root());

    expect(out).toEqual({ root_id: 1, path: root().path, skipped: true, reason: 'claimed_elsewhere' });
    expect(db.calls.length).toBe(1);                 // the claim attempt, nothing more
    expect(dropbox.listFolderPage).not.toHaveBeenCalled();
  });

  test('the claim is REFRESHED after every page so a long root cannot expire mid-walk', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([file('/a/1.pdf')], 'c1', true));
    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/2.pdf')], 'c2', false));

    await sync.syncRoot(db, root());

    const cursorWrites = db.all('SET sync_cursor = ?, syncing_since = NOW()');
    expect(cursorWrites.length).toBe(2);
    expect(cursorWrites.map(c => c.params[0])).toEqual(['c1', 'c2']);
  });

  test('the claim is RELEASED on success and on failure alike', async () => {
    const okDb = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', false));
    await sync.syncRoot(okDb, root());
    expect(okDb.find('last_sync_at = NOW()').sql).toContain('syncing_since = NULL');

    const badDb = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockRejectedValue(new Error('boom'));
    await sync.syncRoot(badDb, root());
    expect(badDb.find('SET last_error = ?').sql).toContain('syncing_since = NULL');
  });
});

// ─────────────────────────────────────────────────────────────
// Mode selection
// ─────────────────────────────────────────────────────────────

describe('syncRoot — mode is derived from cursor presence', () => {
  test('NULL cursor → backfill: list_folder, bulk write, ZERO emissions', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(
      page([file('/a/1.pdf'), file('/a/2.pdf')], 'c1', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: null }));

    expect(out.mode).toBe('backfill');
    expect(dropbox.listFolderPage).toHaveBeenCalledTimes(1);
    expect(dropbox.listFolderContinue).not.toHaveBeenCalled();
    expect(out.files).toBe(2);
    // The entire point: 150,000 pre-existing files are not news.
    expect(domainEvents.emit).not.toHaveBeenCalled();
    // One multi-VALUES statement, not one per file.
    expect(db.all('INSERT INTO documents').length).toBe(1);
  });

  // ── THE MODE-FLIP BUG ────────────────────────────────────────────────
  // Deriving the WRITE POLICY from cursor presence looked right and was
  // wrong: a backfill stopped by the page budget persists a cursor, so the
  // next tick treated a root with ~100k unlisted files as "already
  // backfilled" and started emitting document.created for each one, at ~47x
  // the cost per page. Write policy now keys on backfill_done; only the API
  // call keys on the cursor.

  test('a BUDGET-STOPPED backfill stays backfill on the next tick', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([file('/a/1.pdf')], 'c1', true));

    const first = await sync.syncRoot(db, root(), { maxPages: 1 });
    expect(first.stop).toBe('page_cap');
    expect(first.backfill_completed).toBeUndefined();
    // The cursor now exists. Under the old rule that alone flipped the mode.
    expect(db.all('SET sync_cursor = ?').length).toBe(1);
    expect(db.find('last_sync_at = NOW()').sql).not.toContain('backfill_done = 1');

    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/2.pdf')], 'c2', true));
    const second = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 0 }), { maxPages: 1 });

    expect(second.mode).toBe('backfill');
    expect(dropbox.listFolderContinue).toHaveBeenCalledWith(db, { cursor: 'c1' });  // API: cursor
    expect(domainEvents.emit).not.toHaveBeenCalled();                                // policy: backfill_done
  });

  test('backfill_done flips ONLY when a page reports has_more = false', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([file('/a/1.pdf')], 'c1', false));

    const out = await sync.syncRoot(db, root());

    expect(out.backfill_completed).toBe(true);
    expect(db.find('last_sync_at = NOW()').sql).toContain('backfill_done = 1');
  });

  test('an EMPTY root does NOT graduate — its first real walk must be a backfill', async () => {
    const db = makeDb({ roots: [root({ id: 5 })] });
    dropbox.listFolderPage.mockRejectedValue(dbxError(409, 'path/not_found/...'));

    await sync.syncRoot(db, root({ id: 5 }));
    expect(db.find('last_sync_at = NOW()').sql).not.toContain('backfill_done = 1');
  });

  test('present cursor → incremental: continue, per-row write, EMISSIONS ON', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/1.pdf')], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    expect(out.mode).toBe('incremental');
    expect(dropbox.listFolderContinue).toHaveBeenCalledWith(db, { cursor: 'c1' });
    expect(dropbox.listFolderPage).not.toHaveBeenCalled();
    expect(emittedTypes()).toEqual(['document.created']);
    expect(domainEvents.emit.mock.calls[0][2].source).toBe('system');
  });

  test('incremental re-processing of a known, unchanged file emits nothing', async () => {
    // Resumption after a crash re-reads a page. Silence is what makes that safe.
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/1.pdf')], 'c2', false));
    await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));
    domainEvents.emit.mockClear();

    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/1.pdf')], 'c3', false));
    await sync.syncRoot(db, root({ sync_cursor: 'c2', backfill_done: 1 }));

    expect(domainEvents.emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Empty root
// ─────────────────────────────────────────────────────────────

describe('syncRoot — path/not_found on a root is an EMPTY ROOT', () => {
  test('stamps last_sync_at, clears the claim, records no error', async () => {
    // Three of the seven seeded roots ("Unsorted …") are created lazily by
    // the upload / e-sign / forms ladders and do not exist yet.
    const db = makeDb({ roots: [root({ id: 5 })] });
    dropbox.listFolderPage.mockRejectedValue(dbxError(409, 'path/not_found/...'));

    const out = await sync.syncRoot(db, root({ id: 5 }));

    expect(out.mode).toBe('empty_root');
    expect(out.error).toBeUndefined();
    const write = db.find('last_sync_at = NOW()');
    expect(write.sql).toContain('last_error = NULL');
    expect(write.sql).toContain('syncing_since = NULL');
    expect(alert).not.toHaveBeenCalled();
  });

  test('the cursor stays NULL, so the root really backfills once it exists', async () => {
    const db = makeDb({ roots: [root({ id: 5 })] });
    dropbox.listFolderPage.mockRejectedValue(dbxError(409, 'path/not_found/...'));
    await sync.syncRoot(db, root({ id: 5 }));
    expect(db.all('SET sync_cursor = ?').length).toBe(0);
  });

  test('path/not_found on a CONTINUE is NOT swallowed as an empty root', async () => {
    // Mid-walk it means something else entirely and must surface.
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockRejectedValue(dbxError(409, 'path/not_found/...'));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));
    expect(out.error).toBeTruthy();
    expect(out.mode).toBe('incremental');
  });
});

// ─────────────────────────────────────────────────────────────
// Cursor persistence / resumption
// ─────────────────────────────────────────────────────────────

describe('syncRoot — the cursor is persisted per page', () => {
  test('a crash BETWEEN pages leaves the last completed page persisted', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([file('/a/1.pdf')], 'cur-p1', true));
    dropbox.listFolderContinue.mockRejectedValue(new Error('ECONNRESET'));

    const out = await sync.syncRoot(db, root());

    expect(out.error).toMatch(/ECONNRESET/);
    // Page 1's cursor was written BEFORE page 2 was attempted.
    const writes = db.all('SET sync_cursor = ?');
    expect(writes.length).toBe(1);
    expect(writes[0].params[0]).toBe('cur-p1');
    // Page 1's file is registered — the failure cost nothing already done.
    expect(db.docs.size).toBe(1);
  });

  test('resumption continues from the persisted cursor, re-listing nothing', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/2.pdf')], 'cur-p2', false));

    await sync.syncRoot(db, root({ sync_cursor: 'cur-p1', backfill_done: 1 }));

    expect(dropbox.listFolderPage).not.toHaveBeenCalled();
    expect(dropbox.listFolderContinue).toHaveBeenCalledWith(db, { cursor: 'cur-p1' });
  });

  test('the page budget stops the walk with the cursor intact (same as a crash)', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([file('/a/1.pdf')], 'c1', true));
    dropbox.listFolderContinue.mockResolvedValue(page([file('/a/2.pdf')], 'c2', true));

    const out = await sync.syncRoot(db, root(), { maxPages: 2 });

    expect(out.stop).toBe('page_cap');
    expect(out.pages).toBe(2);
    expect(db.all('SET sync_cursor = ?').pop().params[0]).toBe('c2');
  });

  test('an exhausted shared budget stops before fetching a page', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', true));

    const out = await sync.syncRoot(db, root(), { budget: { pages: 0 } });

    expect(out.stop).toBe('budget');
    expect(dropbox.listFolderPage).not.toHaveBeenCalled();
  });

  test('an expired deadline stops before fetching a page', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', true));

    const out = await sync.syncRoot(db, root(), { deadline: Date.now() - 1 });

    expect(out.stop).toBe('time_cap');
    expect(dropbox.listFolderPage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// Cursor reset
// ─────────────────────────────────────────────────────────────

describe('syncRoot — 409 reset', () => {
  test('clears the cursor, records the error, alerts, and emits NOTHING', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockRejectedValue(
      dbxError(409, 'reset/...', { '.tag': 'reset' }));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'dead-cursor', backfill_done: 1 }));

    expect(out.cursor_reset).toBe(true);
    const write = db.find('SET sync_cursor = NULL');
    // BOTH halves. Clearing only the cursor would re-list the whole subtree
    // with emissions ON — the mode-flip bug, one root at a time.
    expect(write.sql).toContain('backfill_done = 0');
    expect(write.sql).toContain('last_error = ?');
    expect(write.sql).toContain('syncing_since = NULL');
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].kind).toBe('documents_sync_cursor_reset');
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('THE SAFETY PROPERTY: the next run is backfill mode, emissions OFF', async () => {
    // A reset forces a full re-list of up to 121,000 files. Because mode is
    // derived from cursor presence and the reset NULLed the cursor, that
    // re-list runs through the bulk path and cannot storm the trigger engine.
    // If mode were a stored flag this would silently regress.
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockRejectedValue(
      dbxError(409, 'reset/...', { '.tag': 'reset' }));
    await sync.syncRoot(db, root({ sync_cursor: 'dead-cursor', backfill_done: 1 }));

    // The DB now holds sync_cursor = NULL AND backfill_done = 0; that pair is
    // what the next tick reads.
    dropbox.listFolderPage.mockResolvedValue(
      page([file('/a/1.pdf'), file('/a/2.pdf')], 'fresh', false));
    const out2 = await sync.syncRoot(db, root({ sync_cursor: null, backfill_done: 0 }));

    expect(out2.mode).toBe('backfill');
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  test('a 409 that is NOT a reset is a plain error, and does not clear the cursor', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderContinue.mockRejectedValue(dbxError(409, 'other/problem'));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    expect(out.cursor_reset).toBeUndefined();
    expect(out.error).toBeTruthy();
    expect(db.all('SET sync_cursor = NULL').length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Attribution during sync
// ─────────────────────────────────────────────────────────────

describe('syncRoot — inline attribution', () => {
  const cacheRows = [
    { case_id: 'CASEA', folder_external_id: 'id:folderA', path_lower: '/r/  case a' },
    { case_id: 'CASEAB', folder_external_id: 'id:folderAB', path_lower: '/r/  case ab' },
  ];

  test('backfill links silently through bulkLink — no document.linked storm', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderPage.mockResolvedValue(page([
      file('/r/  case a/1.pdf'),
      file('/r/  case ab/2.pdf'),
      file('/r/  loose/3.pdf'),          // under no case
    ], 'c1', false));

    const out = await sync.syncRoot(db, root());

    expect(out.linked).toBe(2);
    expect(domainEvents.emit).not.toHaveBeenCalled();
    // Correct case per file — the lookalike trap, end to end.
    const linkParams = db.find('INSERT INTO document_links').params;
    const ids = [linkParams[2], linkParams[7]];
    expect(ids.sort()).toEqual(['CASEA', 'CASEAB']);
  });

  test('backfill resolves row ids in ONE lookup per page, not one per file', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderPage.mockResolvedValue(page(
      Array.from({ length: 40 }, (_, i) => file(`/r/  case a/${i}.pdf`)), 'c1', false));

    await sync.syncRoot(db, root());

    expect(db.all('SELECT id, external_id').length).toBe(1);
    expect(db.all('INSERT INTO document_links').length).toBe(1);
  });

  test('incremental attribution emits document.linked with the case promoted', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderContinue.mockResolvedValue(
      page([file('/r/  case a/new.pdf')], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    expect(out.linked).toBe(1);
    expect(emittedTypes()).toEqual(['document.created', 'document.linked']);
    const linked = domainEvents.emit.mock.calls[1][2];
    expect(linked.case_id).toBe('CASEA');
    expect(linked.source).toBe('system');
  });

  test('a file under no cached case registers but is left unlinked (never guessed)', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderContinue.mockResolvedValue(
      page([file('/r/  loose/x.pdf')], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    expect(out.files).toBe(1);
    expect(out.linked).toBe(0);
    expect(emittedTypes()).toEqual(['document.created']);
  });

  // ── S3.1: MACHINE LINKS TRACK THE FILESYSTEM ──────────────────────────
  //
  // Every link the ENGINE writes carries relation='path' and a NULL
  // created_by. That pair is the ONLY thing that lets the reconciler tell an
  // engine link from a person's, so if any write site stops stamping it, the
  // reconciler silently stops retracting stale links for those documents —
  // and the related view starts amplifying them. Hence one test per site.

  test('BACKFILL bulkLink stamps relation=path with no created_by', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderPage.mockResolvedValue(
      page([file('/r/  case a/1.pdf')], 'c1', false));

    await sync.syncRoot(db, root());

    // (document_id, link_type, link_id, relation, created_by)
    const p = db.find('INSERT INTO document_links').params;
    expect(p[3]).toBe('path');
    expect(p[4]).toBeNull();
  });

  test('INCREMENTAL link() stamps relation=path', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderContinue.mockResolvedValue(
      page([file('/r/  case a/new.pdf')], 'c2', false));

    await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    const p = db.find('INSERT INTO document_links').params;
    expect(p[3]).toBe('path');
    expect(p[4]).toBeNull();
    // And it rides into the envelope, so a rule author can see it.
    const linked = domainEvents.emit.mock.calls.find(c => c[1] === 'document.linked')[2];
    expect(linked.extra.relation).toBe('path');
  });
});

// ─────────────────────────────────────────────────────────────
// S3.1 — move reconciliation
//
// A file dragged from case A's folder into case B's arrives as a plain update
// with a new path_lower. Without reconciliation A keeps asserting ownership
// forever, and the related view then shows the document on case A AND on every
// contact related to A — badged, and indistinguishable from a correct row. A
// confident wrong answer, which is why this ships alongside the view.
// ─────────────────────────────────────────────────────────────

describe('syncRoot — move reconciliation (incremental only)', () => {
  const cacheRows = [
    { case_id: 'CASEA', folder_external_id: 'id:fA', path_lower: '/r/  case a' },
    { case_id: 'CASEB', folder_external_id: 'id:fB', path_lower: '/r/  case b' },
  ];

  /** A doc already registered under case A, as the delta will find it. */
  const priorDocs = () => new Map([['id:/r/  case a/f.pdf', {
    id: 7, source: 'dropbox', external_id: 'id:/r/  case a/f.pdf',
    name: 'f.pdf', path: '/r/  case a/f.pdf', path_lower: '/r/  case a/f.pdf',
    path_hash: 'h', ext: 'pdf', mime: null, size: 100, content_hash: 'c'.repeat(64),
    rev: 'rev1', server_modified: '2026-08-01 10:00:00', status: 'active',
    title: null, doc_type: null, tags: null, ai_meta: null, shared_link: null,
  }]]);

  /** The same file, re-reported by Dropbox at its NEW path under case B. */
  const moved = () => file('/r/  case b/f.pdf', {
    id: 'id:/r/  case a/f.pdf',           // move-STABLE id — the whole design
    name: 'f.pdf',
  });

  test('a MOVE between case folders retracts the old path-link and adds the new', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    db.pathLinksDropped = 1;
    dropbox.listFolderContinue.mockResolvedValue(page([moved()], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    const del = db.find('DELETE FROM document_links');
    expect(del).toBeDefined();
    // Keep CASEB (the new match), drop everything else the engine wrote.
    expect(del.params).toEqual([7, 'path', 'CASEB']);
    expect(out.unlinked).toBe(1);

    const ins = db.find('INSERT INTO document_links');
    expect(ins.params[2]).toBe('CASEB');
    expect(ins.params[3]).toBe('path');
  });

  test('the move INTO case B fires document.linked for B — the correct signal', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    db.pathLinksDropped = 1;
    dropbox.listFolderContinue.mockResolvedValue(page([moved()], 'c2', false));

    await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    const linked = domainEvents.emit.mock.calls.filter(c => c[1] === 'document.linked');
    expect(linked.length).toBe(1);
    expect(linked[0][2].case_id).toBe('CASEB');
    // And NOTHING announces the retraction: there is no document.unlinked
    // event type, and eventRegistryCoverage exists to keep it that way.
    expect(emittedTypes()).not.toContain('document.unlinked');
  });

  test('MANUAL links survive: the DELETE cannot reach them, by construction', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    dropbox.listFolderContinue.mockResolvedValue(page([moved()], 'c2', false));

    await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    // Not "the test fixture happened to keep them" — the STATEMENT excludes
    // them. A relation the engine did not write, or any created_by at all.
    const del = db.find('DELETE FROM document_links').sql;
    expect(del).toContain('AND relation = ?');
    expect(del).toContain('AND created_by IS NULL');
    expect(del).toContain("AND link_type = 'case'");
  });

  test('a file moved OUT of every case folder loses all its path-links', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    db.pathLinksDropped = 1;
    dropbox.listFolderContinue.mockResolvedValue(page([
      file('/r/  loose/f.pdf', { id: 'id:/r/  case a/f.pdf', name: 'f.pdf' }),
    ], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    const del = db.find('DELETE FROM document_links');
    expect(del.params).toEqual([7, 'path']);      // no keep clause at all
    expect(del.sql).not.toContain('link_id <>');
    expect(out.unlinked).toBe(1);
    expect(db.find('INSERT INTO document_links')).toBeUndefined();
  });

  test('a move WITHIN the same case reconciles but drops nothing and re-links nothing new', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    dropbox.listFolderContinue.mockResolvedValue(page([
      file('/r/  case a/sub/f.pdf', { id: 'id:/r/  case a/f.pdf', name: 'f.pdf' }),
    ], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    // The keep clause names CASEA, so the existing correct link is untouched:
    // the DELETE runs and matches nothing. `unlinked` is absent rather than 0
    // — the stats blob omits it when nothing was retracted, so a non-zero
    // value stands out in job_results instead of blending into a wall of 0s.
    expect(db.find('DELETE FROM document_links').params).toEqual([7, 'path', 'CASEA']);
    expect(out.unlinked).toBeUndefined();
  });

  test('an UNMOVED file costs no DELETE at all', async () => {
    // The gate is changes.path_lower, not "run it every time". A re-walk of a
    // quiet tree must not be a DELETE per row.
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    dropbox.listFolderContinue.mockResolvedValue(page([
      file('/r/  case a/f.pdf', { id: 'id:/r/  case a/f.pdf', name: 'f.pdf' }),
    ], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    expect(db.find('DELETE FROM document_links')).toBeUndefined();
    expect(out.unlinked).toBeUndefined();
  });

  test('a NEW file never reconciles — there is no history to be stale', async () => {
    const db = makeDb({ roots: [root()], cache: cacheRows });
    dropbox.listFolderContinue.mockResolvedValue(
      page([file('/r/  case a/brand-new.pdf')], 'c2', false));

    await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));
    expect(db.find('DELETE FROM document_links')).toBeUndefined();
  });

  test('BACKFILL never reconciles — it is a first walk', async () => {
    // And it must not: the bulk path has no prior row to diff against, and a
    // DELETE per row across ~150k files is the storm emit:false exists to stop.
    const db = makeDb({ roots: [root()], cache: cacheRows, docs: priorDocs() });
    dropbox.listFolderPage.mockResolvedValue(page([moved()], 'c1', false));

    await sync.syncRoot(db, root());        // backfill_done 0

    expect(db.find('DELETE FROM document_links')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Folders and deletes
// ─────────────────────────────────────────────────────────────

describe('syncRoot — folder entries', () => {
  test('folders are NOT registered as documents', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([
      folder('/r/  case a', 'id:folderA'),
      file('/r/  case a/1.pdf'),
    ], 'c1', false));

    const out = await sync.syncRoot(db, root());

    expect(out.files).toBe(1);
    expect(db.docs.size).toBe(1);
    expect([...db.docs.keys()]).toEqual(['id:/r/  case a/1.pdf']);
  });

  test('a MOVED case folder heals the cache with no extra API call', async () => {
    // Dropbox ids survive move and rename, so the delta feed itself tells us
    // where the folder went. Without this, every file under the new path
    // would go unattributed until the next cache refresh.
    const db = makeDb({
      roots: [root()],
      cache: [{ case_id: 'CASEA', folder_external_id: 'id:folderA', path_lower: '/r/  active/  case a' }],
    });
    dropbox.listFolderPage.mockResolvedValue(page([
      folder('/r/  closed/  case a', 'id:folderA'),
      file('/r/  closed/  case a/1.pdf'),
    ], 'c1', false));

    const out = await sync.syncRoot(db, root());

    const heal = db.find('UPDATE case_folder_cache');
    expect(heal.params[0]).toBe('/r/  closed/  case a');
    expect(heal.params[2]).toBe('CASEA');
    expect(out.folder_heals).toBe(1);
    // And the heal applies WITHIN the same page: the file attributes.
    expect(out.linked).toBe(1);
    expect(dropbox.getSharedLinkMetadata).not.toHaveBeenCalled();
  });

  test('an unchanged or unknown folder writes nothing', async () => {
    const db = makeDb({
      roots: [root()],
      cache: [{ case_id: 'CASEA', folder_external_id: 'id:folderA', path_lower: '/r/  case a' }],
    });
    dropbox.listFolderPage.mockResolvedValue(page([
      folder('/r/  case a', 'id:folderA'),      // same path
      folder('/r/  whatever', 'id:unknown'),    // not a case folder
    ], 'c1', false));

    const out = await sync.syncRoot(db, root());
    expect(out.folder_heals).toBe(0);
    expect(db.all('UPDATE case_folder_cache').length).toBe(0);
  });
});

describe('syncRoot — deleted entries', () => {
  test('routes each delete through markDeletedByPath (prefix cascade included)', async () => {
    const db = makeDb({ roots: [root()], deletedRows: 4 });
    dropbox.listFolderContinue.mockResolvedValue(
      page([deleted('/r/  case a/gone.pdf'), deleted('/r/  case a/  subfolder')], 'c2', false));

    const out = await sync.syncRoot(db, root({ sync_cursor: 'c1', backfill_done: 1 }));

    const updates = db.all("UPDATE documents SET status = 'deleted'");
    expect(updates.length).toBe(2);
    // The prefix arm is what makes a folder delete cascade — Dropbox sends
    // ONE entry for the folder and none for its contents.
    expect(updates[0].sql).toContain('path_hash = ? OR path_lower LIKE ?');
    expect(out.deleted).toBe(8);
    // Deletes deliberately emit nothing (S1 decision, unchanged in S2).
    expect(emittedTypes()).not.toContain('document.updated');
  });
});

// ─────────────────────────────────────────────────────────────
// syncAll
// ─────────────────────────────────────────────────────────────

describe('syncAll', () => {
  test('orders never-synced roots first, then oldest-synced', async () => {
    const db = makeDb({ roots: [root()] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', false));
    await sync.syncAll(db);
    expect(db.find('FROM document_sync_roots').sql)
      .toContain('ORDER BY (last_sync_at IS NULL) DESC, last_sync_at ASC');
  });

  test('the page budget is SHARED, so one huge root cannot starve the rest', async () => {
    // Closed Cases alone is ~121k files. A per-root budget would let it
    // consume its full allowance every tick forever.
    const roots = [root({ id: 1 }), root({ id: 2, path: '/r2' })];
    const db = makeDb({ roots });
    // Page 1 of a root goes through list_folder; every page after it goes
    // through continue. Both must be scripted or the walk dies on page 2.
    dropbox.listFolderPage.mockResolvedValue(page([], 'c', true));       // never finishes
    dropbox.listFolderContinue.mockResolvedValue(page([], 'c', true));   // ditto

    const out = await sync.syncAll(db, { maxPages: 3 });

    expect(out.pages_used).toBe(3);
    // Root 1 ate the budget; root 2 was reached but had nothing left to spend.
    expect(out.roots[0].pages).toBe(3);
    expect(out.roots.length).toBeLessThanOrEqual(2);
    if (out.roots[1]) expect(out.roots[1].pages).toBe(0);
  });

  test('loads the case cache ONCE and hands it to every root', async () => {
    const db = makeDb({ roots: [root({ id: 1 }), root({ id: 2, path: '/r2' })] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c', false));

    await sync.syncAll(db);

    expect(db.all('FROM case_folder_cache').length).toBe(1);
  });

  test('one failing root does not abort the others, and the failure alerts', async () => {
    const db = makeDb({ roots: [root({ id: 1 }), root({ id: 2, path: '/r2' })] });
    dropbox.listFolderPage
      .mockRejectedValueOnce(new Error('subtree exploded'))
      .mockResolvedValue(page([], 'c', false));

    const out = await sync.syncAll(db);

    expect(out.roots[0].error).toMatch(/subtree exploded/);
    expect(out.roots[1].error).toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].kind).toBe('documents_sync_root_error');
  });
});

// ─────────────────────────────────────────────────────────────
// attributeUnlinked — the reconcile sweep
// ─────────────────────────────────────────────────────────────

describe('attributeUnlinked', () => {
  const cacheRows = [{ case_id: 'CASEA', folder_external_id: 'id:fA', path_lower: '/r/  case a' }];

  test('anti-joins active documents with no case link and links the matches SILENTLY', async () => {
    // The first run after a backfill links six figures of rows. Emitting per
    // row here would be exactly the storm emit:false exists to prevent.
    const db = makeDb({
      cache: cacheRows,
      unlinked: [
        { id: 7,  path_lower: '/r/  case a/1.pdf' },
        { id: 8,  path_lower: '/r/  loose/2.pdf' },
      ],
    });

    const out = await sync.attributeUnlinked(db);

    expect(out).toMatchObject({ scanned: 2, linked: 1 });
    const q = db.find('SELECT d.id, d.path_lower').sql;
    expect(q).toContain("LEFT JOIN document_links dl ON dl.document_id = d.id AND dl.link_type = 'case'");
    expect(q).toContain('dl.id IS NULL');
    expect(q).toContain("d.status = 'active'");
    expect(domainEvents.emit).not.toHaveBeenCalled();
  });

  // ── S3.1: the anti-join targets PATH-links, not case links ────────────
  //
  // It used to mean "has no case link at all", which under the hygiene rule is
  // wrong in exactly one direction: a document a staffer manually filed under
  // case A, sitting in case B's Dropbox folder, looked attributed and was
  // skipped forever — so it never gained B's path-link and never showed up in
  // B's documents. The manual link says where a PERSON filed it; the path-link
  // says where the FILE is. Both are true at once, and the sweep owns only the
  // second.

  test('the anti-join is keyed on relation=path, not on any case link', async () => {
    const db = makeDb({ cache: cacheRows, unlinked: [] });
    await sync.attributeUnlinked(db);

    const q = db.find('SELECT d.id, d.path_lower');
    expect(q.sql).toContain("dl.link_type = 'case'");
    expect(q.sql).toContain('AND dl.relation = ?');
    expect(q.params[0]).toBe('path');
    expect(q.sql).toContain('dl.id IS NULL');
  });

  test('a document holding ONLY a manual link still gains its path-link', async () => {
    // The behaviour change the retarget exists for. The stub's anti-join
    // returns it because it has no PATH-link — the manual one is invisible to
    // this query, which is the point.
    const db = makeDb({
      cache: cacheRows,
      unlinked: [{ id: 7, path_lower: '/r/  case a/filed-by-hand.pdf' }],
    });

    const out = await sync.attributeUnlinked(db);

    expect(out).toMatchObject({ scanned: 1, linked: 1 });
    const p = db.find('INSERT INTO document_links').params;
    expect(p[2]).toBe('CASEA');
    expect(p[3]).toBe('path');
    expect(p[4]).toBeNull();
  });

  test('the sweep ONLY ADDS — it never deletes, and never reconciles a move', async () => {
    // Re-deciding a move here would mean judging it from a slower, staler
    // cache than the delta feed that already handled it. The incremental path
    // owns retraction; this one owns filling gaps.
    const db = makeDb({
      cache: cacheRows,
      unlinked: [{ id: 7, path_lower: '/r/  case a/1.pdf' }],
    });
    await sync.attributeUnlinked(db);
    expect(db.all('DELETE FROM document_links').length).toBe(0);
  });

  test('the watermark mechanics are UNCHANGED by the retarget', async () => {
    const db = makeDb({
      cache: cacheRows, unlinked: [],
      settings: { [sync.SWEEP_WATERMARK_KEY]: '4848' },
    });
    await sync.attributeUnlinked(db);
    const q = db.find('SELECT d.id, d.path_lower');
    expect(q.sql).toContain('AND d.id > ?');
    expect(q.sql).toContain('ORDER BY d.id');
    expect(q.params[q.params.length - 1]).toBe(4848);
  });

  test('an empty cache short-circuits before scanning documents', async () => {
    const db = makeDb({ cache: [], unlinked: [{ id: 7, path_lower: '/r/  case a/1.pdf' }] });
    const out = await sync.attributeUnlinked(db);
    expect(out).toMatchObject({ scanned: 0, linked: 0 });
    expect(db.all('SELECT d.id, d.path_lower').length).toBe(0);
  });

  test('nothing to link writes no link rows', async () => {
    const db = makeDb({ cache: cacheRows, unlinked: [{ id: 8, path_lower: '/r/  loose/2.pdf' }] });
    await sync.attributeUnlinked(db);
    expect(db.all('INSERT INTO document_links').length).toBe(0);
  });

  test('limit is clamped and inlined as a validated integer', async () => {
    const db = makeDb({ cache: cacheRows, unlinked: [] });
    await sync.attributeUnlinked(db, { limit: 999999 });
    expect(db.find('SELECT d.id, d.path_lower').sql).toContain('LIMIT 50000');

    const db2 = makeDb({ cache: cacheRows, unlinked: [] });
    await sync.attributeUnlinked(db2, { limit: 'DROP TABLE documents' });
    expect(db2.find('SELECT d.id, d.path_lower').sql).toContain('LIMIT 5000');
  });

  // ── THE STARVATION BUG ───────────────────────────────────────────────
  // First production run: scanned 5000, linked 152. The other 4,848 match no
  // case and never will (Unsorted roots, loose firm files). With no advancing
  // key the next run returns the same head, so the sweep re-tests those 4,848
  // forever and never reaches row 60,000. These tests are the regression.

  test('the scan ADVANCES: ordered by id, windowed above a watermark', async () => {
    const db = makeDb({ cache: cacheRows, unlinked: [], settings: {} });
    await sync.attributeUnlinked(db);

    const q = db.find('SELECT d.id, d.path_lower');
    expect(q.sql).toContain('AND d.id > ?');
    expect(q.sql).toContain('ORDER BY d.id');
  });

  test('a FULL page advances the watermark to the last id scanned', async () => {
    // Nothing matched — and that must STILL move the window forward, which is
    // the entire fix. A run that links nothing but re-tests the same rows is
    // the starvation.
    const unlinked = Array.from({ length: 3 }, (_, i) =>
      ({ id: 100 + i, path_lower: `/r/  loose/${i}.pdf` }));
    const db = makeDb({ cache: cacheRows, unlinked, settings: {} });

    const out = await sync.attributeUnlinked(db, { limit: 3 });

    expect(out.linked).toBe(0);
    expect(out.wrapped).toBe(false);
    expect(out.next_id).toBe(102);
    expect(db.find('INSERT INTO app_settings').params).toEqual([sync.SWEEP_WATERMARK_KEY, '102']);
  });

  test('the NEXT run resumes above the watermark instead of re-reading the head', async () => {
    const db = makeDb({
      cache: cacheRows, unlinked: [],
      settings: { [sync.SWEEP_WATERMARK_KEY]: '4848' },
    });
    await sync.attributeUnlinked(db);
    // S3.1: the anti-join binds the path relation ahead of the watermark, so
    // the constant has ONE definition (documentService.RELATION_PATH) rather
    // than a second copy inlined in this query's text.
    expect(db.find('SELECT d.id, d.path_lower').params).toEqual(['path', 4848]);
  });

  test('a SHORT page means end-of-table: wrap to 0 and start a fresh lap', async () => {
    // The cache keeps growing, so re-testing a row that matched nothing on
    // lap 1 is the point — it may match on lap 3.
    const db = makeDb({
      cache: cacheRows,
      unlinked: [{ id: 900, path_lower: '/r/  case a/x.pdf' }],
      settings: { [sync.SWEEP_WATERMARK_KEY]: '800' },
    });

    const out = await sync.attributeUnlinked(db, { limit: 5000 });

    expect(out).toMatchObject({ from_id: 800, wrapped: true, next_id: 0, linked: 1 });
    expect(db.find('INSERT INTO app_settings').params[1]).toBe('0');
  });

  test('a missing or garbage watermark starts at 0 rather than throwing', async () => {
    // It is a position HINT, never a correctness dependency: losing it
    // re-walks the table, which is merely slower.
    for (const v of [undefined, '', 'nonsense', '-5']) {
      const settings = v === undefined ? {} : { [sync.SWEEP_WATERMARK_KEY]: v };
      const db = makeDb({ cache: cacheRows, unlinked: [], settings });
      await sync.attributeUnlinked(db);
      expect(db.find('SELECT d.id, d.path_lower').params).toEqual(['path', 0]);
    }
  });

  test('watermark:false disables both the read and the write', async () => {
    const db = makeDb({ cache: cacheRows, unlinked: [], settings: {} });
    await sync.attributeUnlinked(db, { watermark: false });
    expect(db.all('INSERT INTO app_settings').length).toBe(0);
    expect(db.find('SELECT d.id, d.path_lower').params).toEqual(['path', 0]);
  });
});

// ─────────────────────────────────────────────────────────────
// refreshCaseFolderCache
// ─────────────────────────────────────────────────────────────

describe('refreshCaseFolderCache', () => {
  function cacheDb(caseRows, roots = [root({ path: '/  law office/   cases/  active cases' })]) {
    const db = makeDb({ roots });
    db.caseRows = caseRows;
    return db;
  }

  test('resolves shared links and upserts path + dropbox id, clearing resolve_error', async () => {
    const db = cacheDb([{ case_id: 'CASEA', case_dropbox: 'https://db.com/scl/fo/a' }]);
    dropbox.getSharedLinkMetadata.mockResolvedValue({
      '.tag': 'folder', id: 'id:fA',
      path_lower: '/  law office/   cases/  active cases/  case a',
      path_display: '/  Law Office/   Cases/  Active Cases/  Case A',
    });

    const out = await sync.refreshCaseFolderCache(db);

    expect(out).toMatchObject({ resolved: 1, failed: 0, out_of_root: [] });
    const up = db.find('INSERT INTO case_folder_cache');
    expect(up.sql).toContain('resolve_error = NULL');
    expect(up.params).toEqual([
      'CASEA', 'id:fA',
      '/  law office/   cases/  active cases/  case a',
      '/  Law Office/   Cases/  Active Cases/  Case A',
    ]);
  });

  test('oldest-first, never-resolved first', async () => {
    const db = cacheDb([]);
    await sync.refreshCaseFolderCache(db);
    expect(db.find('FROM cases c').sql)
      .toContain('ORDER BY (f.resolved_at IS NULL) DESC, f.resolved_at ASC');
  });

  test('a FAILED resolution records the error and LEAVES THE PRIOR PATH INTACT', async () => {
    // A revoked or rate-limited link must not blank a path that worked
    // yesterday and silently unfile every future document for that case.
    const db = cacheDb([{ case_id: 'CASEA', case_dropbox: 'https://db.com/scl/fo/a' }]);
    dropbox.getSharedLinkMetadata.mockRejectedValue(new Error('shared_link_not_found'));

    const out = await sync.refreshCaseFolderCache(db);

    expect(out).toMatchObject({ resolved: 0, failed: 1 });
    const write = db.find('INSERT INTO case_folder_cache');
    expect(write.sql).not.toContain('path_lower');
    expect(write.params[1]).toMatch(/shared_link_not_found/);
    expect(out.failures[0].case_id).toBe('CASEA');
  });

  test('resolve_error is clamped to the VARCHAR(255) column (no strict mode here)', async () => {
    const db = cacheDb([{ case_id: 'CASEA', case_dropbox: 'https://db.com/scl/fo/a' }]);
    dropbox.getSharedLinkMetadata.mockRejectedValue(new Error('E'.repeat(900)));

    await sync.refreshCaseFolderCache(db);
    expect(db.find('INSERT INTO case_folder_cache').params[1].length).toBe(255);
  });

  test('a link resolving without a path_lower counts as failed, not resolved', async () => {
    const db = cacheDb([{ case_id: 'CASEA', case_dropbox: 'https://db.com/scl/fo/a' }]);
    dropbox.getSharedLinkMetadata.mockResolvedValue({ '.tag': 'folder', id: 'id:fA' });

    const out = await sync.refreshCaseFolderCache(db);
    expect(out).toMatchObject({ resolved: 0, failed: 1 });
  });

  test('OUT_OF_ROOT: a case folder under no enabled root is reported', async () => {
    // Those cases have a Dropbox folder the engine will never walk, so their
    // documents would never register — invisible without this report.
    const db = cacheDb([
      { case_id: 'INROOT',  case_dropbox: 'https://db.com/scl/fo/a' },
      { case_id: 'OUTSIDE', case_dropbox: 'https://db.com/scl/fo/b' },
    ]);
    dropbox.getSharedLinkMetadata
      .mockResolvedValueOnce({ id: 'id:a', path_lower: '/  law office/   cases/  active cases/  a', path_display: 'A' })
      .mockResolvedValueOnce({ id: 'id:b', path_lower: '/  personal/  strays/  b', path_display: 'B' });

    const out = await sync.refreshCaseFolderCache(db);

    expect(out.resolved).toBe(2);
    expect(out.out_of_root).toEqual(['OUTSIDE']);
  });

  test('out_of_root is boundary-safe — a lookalike sibling root does not count as inside', async () => {
    const db = cacheDb([{ case_id: 'X', case_dropbox: 'https://db.com/scl/fo/x' }],
      [root({ path: '/r/  active' })]);
    dropbox.getSharedLinkMetadata.mockResolvedValue({
      id: 'id:x', path_lower: '/r/  activex/  case', path_display: 'X',
    });

    const out = await sync.refreshCaseFolderCache(db);
    expect(out.out_of_root).toEqual(['X']);
  });

  test('the WALL-CLOCK bound stops mid-batch, before the next API call', async () => {
    // Measured at ~1s per case in production, so limit:300 is a five-minute
    // call held open inside a poll tick. A count bound cannot fix that — what
    // varies is latency, not cardinality.
    const db = cacheDb(Array.from({ length: 50 }, (_, i) =>
      ({ case_id: `C${i}`, case_dropbox: `https://db.com/scl/fo/${i}` })));

    let now = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    dropbox.getSharedLinkMetadata.mockImplementation(async () => {
      now += 1000;                                    // each call "costs" 1s
      return { id: 'id:x', path_lower: '/r/  x', path_display: 'X' };
    });

    const out = await sync.refreshCaseFolderCache(db, { maxRuntimeMs: 5000 });
    spy.mockRestore();

    expect(out.timed_out).toBe(true);
    expect(out.resolved).toBe(5);                     // not all 50
    expect(out.candidates).toBe(50);
    // The check runs BEFORE the call, so the bound is never overshot by a
    // full Dropbox round trip.
    expect(dropbox.getSharedLinkMetadata).toHaveBeenCalledTimes(5);
  });

  test('finishing inside the bound reports timed_out false', async () => {
    const db = cacheDb([{ case_id: 'C1', case_dropbox: 'https://db.com/scl/fo/1' }]);
    dropbox.getSharedLinkMetadata.mockResolvedValue({
      id: 'id:x', path_lower: '/  law office/   cases/  active cases/  x', path_display: 'X',
    });
    const out = await sync.refreshCaseFolderCache(db);
    expect(out.timed_out).toBe(false);
    expect(out.scanned).toBe(1);
  });

  test('limit is clamped and inlined as a validated integer', async () => {
    const db = cacheDb([]);
    await sync.refreshCaseFolderCache(db, { limit: 99999 });
    expect(db.find('FROM cases c').sql).toContain('LIMIT 2000');

    const db2 = cacheDb([]);
    await sync.refreshCaseFolderCache(db2, { limit: '1); DROP TABLE cases; --' });
    expect(db2.find('FROM cases c').sql).toContain('LIMIT 300');
  });
});

// ─────────────────────────────────────────────────────────────
// The internal functions
// ─────────────────────────────────────────────────────────────

describe('lib/internal_functions/documents.js', () => {
  const fns = require('../lib/internal_functions/documents');

  test('KILL SWITCH IS FAIL-CLOSED: an absent setting disables both functions', async () => {
    // A feature that walks 150,000 files does not get to default itself on
    // because a settings row was never created.
    const db = makeDb({ roots: [root()], settings: {} });

    const a = await fns.documents_sync({}, db);
    const b = await fns.documents_refresh_case_cache({}, db);

    expect(a.output.skipped).toBe(true);
    expect(b.output.skipped).toBe(true);
    expect(dropbox.listFolderPage).not.toHaveBeenCalled();
    expect(dropbox.getSharedLinkMetadata).not.toHaveBeenCalled();
  });

  test.each([['0'], [''], ['true'], ['yes'], ['1 '], [null]])(
    'a setting of %p is NOT enabled — only the exact string "1" is',
    async (value) => {
      const db = makeDb({ roots: [root()], settings: { documents_sync_enabled: value } });
      const out = await fns.documents_sync({}, db);
      expect(out.output.skipped).toBe(true);
    });

  test('"1" enables the sync and runs the reconcile sweep by default', async () => {
    const db = makeDb({ roots: [root()], settings: { documents_sync_enabled: '1' }, unlinked: [] });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', false));

    const out = await fns.documents_sync({}, db);

    expect(out.success).toBe(true);
    expect(out.output.roots.length).toBe(1);
    expect(out.output.sweep).toBeDefined();
  });

  test('sweep:false skips the reconcile pass', async () => {
    const db = makeDb({ roots: [root()], settings: { documents_sync_enabled: '1' } });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', false));

    const out = await fns.documents_sync({ sweep: false }, db);
    expect(out.output.sweep).toBeUndefined();
  });

  test('root_id targets one root and runs it EVEN IF DISABLED (explicit override)', async () => {
    // `enabled` keeps a root out of the automatic rotation; it does not make
    // the root unreachable for debugging.
    const disabled = root({ id: 3, enabled: 0, path: '/r3' });
    const db = makeDb({ roots: [disabled], settings: { documents_sync_enabled: '1' } });
    dropbox.listFolderPage.mockResolvedValue(page([], 'c1', false));

    const out = await fns.documents_sync({ root_id: 3 }, db);

    expect(out.output.targeted).toBe(true);
    expect(out.output.roots[0].root_id).toBe(3);
    expect(out.output.sweep).toBeUndefined();   // off by default on a targeted run
  });

  test('root_id is NOT an override for the kill switch', async () => {
    const db = makeDb({ roots: [root({ id: 3 })], settings: { documents_sync_enabled: '0' } });
    const out = await fns.documents_sync({ root_id: 3 }, db);
    expect(out.output.skipped).toBe(true);
  });

  test('an unknown root_id throws rather than silently syncing everything', async () => {
    const db = makeDb({ roots: [root()], settings: { documents_sync_enabled: '1' } });
    await expect(fns.documents_sync({ root_id: 999 }, db)).rejects.toThrow(/no sync root with id 999/);
  });

  test('refresh_case_cache returns out_of_root as its report surface', async () => {
    const db = makeDb({ roots: [root({ path: '/r' })], settings: { documents_sync_enabled: '1' } });
    db.caseRows = [{ case_id: 'OUT', case_dropbox: 'https://db.com/scl/fo/b' }];
    dropbox.getSharedLinkMetadata.mockResolvedValue({
      id: 'id:b', path_lower: '/elsewhere/  b', path_display: 'B',
    });

    const out = await fns.documents_refresh_case_cache({ limit: 10 }, db);

    expect(out.success).toBe(true);
    expect(out.output.out_of_root).toEqual(['OUT']);
  });

  test('both carry __meta in the documents category (index.js auto-scan + save-time validation)', () => {
    for (const fn of [fns.documents_sync, fns.documents_refresh_case_cache]) {
      expect(fn.__meta.category).toBe('documents');
      expect(typeof fn.__meta.description).toBe('string');
      expect(Array.isArray(fn.__meta.params)).toBe(true);
      for (const p of fn.__meta.params) expect(typeof p.required).toBe('boolean');
    }
  });
});
