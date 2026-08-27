// tests/documentIngest.s4.test.js
//
/**
 * services/documentIngestService.js — WRITE-TIME REGISTRATION (Documents S4).
 *
 * This module exists to make one decision correctly, and everything else it
 * does is plumbing. The decision:
 *
 *     WHICH `relation` DOES A WRITE-TIME LINK CARRY?
 *
 * and it matters because documentService.reconcilePathLinks DELETEs, on every
 * incremental sync where a file moved:
 *
 *     link_type='case' AND relation='path' AND created_by IS NULL
 *
 * So a link stamped 'path' is one the engine has promised to retract the moment
 * the path stops supporting it. That is right for a link DERIVED from a path
 * and destructive for a link derived from KNOWLEDGE — a client uploading
 * against case X whose file lands in the Unsorted bin because case X has no
 * working folder. "This is case X's document" is true; no path says so; the
 * next reconcile would delete the only correct statement anyone made about it.
 *
 * The two failure modes are NOT symmetric, which is why the default matters:
 *   'upload' where 'path' was right → redundant. The sweep adds the path row,
 *                                     the unique key dedupes, nothing is lost.
 *   'path' where 'upload' was right → the link is DESTROYED, silently, later.
 * So every uncertain case must fall to 'upload', and the tests below pin that
 * for each way of being uncertain (uncached case, failed cache read, contact
 * link, file in a different case's tree).
 *
 * ALSO PINNED HERE:
 *   · EMISSIONS ARE ON. S2's backfill passes { emit:false } for 150k files
 *     that are not news; a file written seconds ago by a flow that knew what it
 *     was is the opposite, and S5's classification triggers consume exactly
 *     these events. A regression to emit:false would be invisible in
 *     production until someone noticed automations never firing.
 *   · registerWrittenSafe NEVER THROWS. Every hook in the app calls it from a
 *     path where the bytes are already in Dropbox, so a registry failure must
 *     cost a delay and never the caller's response.
 *   · registerLandedInFolder claims by TIMESTAMP WINDOW, not by name. The two
 *     client completion routes receive filenames only, and autorename makes
 *     those unreliable by construction.
 *
 * Run:
 *   npx jest tests/documentIngest.s4.test.js
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

jest.mock('../services/documentService', () => ({
  RELATION_PATH: 'path',
  upsertFromEntry: jest.fn(),
  link: jest.fn(),
}));

jest.mock('../services/dropboxService', () => ({
  _resolveCredential: jest.fn(async () => 8),
  resolveLocation:    jest.fn(),
  listFolder:         jest.fn(),
  joinPath: (base, ...segs) => [base, ...segs.filter(Boolean)].join('/'),
}));

jest.mock('../services/documentSourceService', () => ({ get: jest.fn() }));

const documents = require('../services/documentService');
const dropbox   = require('../services/dropboxService');
const sources   = require('../services/documentSourceService');
const ingest    = require('../services/documentIngestService');

/** A db whose case_folder_cache answer is scripted per case id. */
function mkDb(cache = {}, opts = {}) {
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (opts.throwOnCache) throw new Error('cache table is on fire');
      if (/case_folder_cache/.test(sql)) {
        const hit = cache[String(params[0])];
        return [hit ? [{ path_lower: hit }] : []];
      }
      return [[]];
    },
  };
}

function fileRow(over = {}) {
  return {
    id: 41, source: 'dropbox', external_id: 'id:AAA', name: 'statement.pdf',
    path: '/Cases/Smith/statement.pdf', path_lower: '/cases/smith/statement.pdf',
    ext: 'pdf', size: 10, status: 'active', ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  documents.upsertFromEntry.mockResolvedValue({ row: fileRow(), created: true, changes: {} });
  documents.link.mockResolvedValue({ linked: true, created: true, row: fileRow() });
});

// ─────────────────────────────────────────────────────────────────────────────
// The relation decision
// ─────────────────────────────────────────────────────────────────────────────

describe('relation choice — INTENT vs LOCATION', () => {
  test("a file under the case's cached folder gets 'path' — the engine may own it", async () => {
    // Truthful location: a later drag to another case SHOULD retract this.
    const db = mkDb({ SMITH1: '/cases/smith' });
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'statement.pdf' },
      links: [{ type: 'case', id: 'SMITH1' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'case', 'SMITH1', expect.objectContaining({ relation: 'path' }),
    );
  });

  test("a file in the UNSORTED bin gets 'upload' — the reconciler must not touch it", async () => {
    // THE CASE THIS MODULE EXISTS FOR. Client uploaded against SMITH1, the
    // case has no working folder, the ladder dropped it in the bin. Stamped
    // 'path' this link dies on the next reconcile.
    const db = mkDb({ SMITH1: '/cases/smith' });
    documents.upsertFromEntry.mockResolvedValue({
      row: fileRow({ path_lower: '/  law office/   cases/  unsorted client uploads/smith1/x.pdf' }),
      created: true, changes: {},
    });

    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'SMITH1' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'case', 'SMITH1', expect.objectContaining({ relation: 'upload' }),
    );
  });

  test("a file under ANOTHER case's folder gets 'upload', not that case's 'path'", async () => {
    // The path supports a DIFFERENT case. It must not be dressed up as
    // location evidence for the one we were told about.
    const db = mkDb({ SMITH1: '/cases/smith', JONES2: '/cases/jones' });
    documents.upsertFromEntry.mockResolvedValue({
      row: fileRow({ path_lower: '/cases/jones/x.pdf' }), created: true, changes: {},
    });

    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'SMITH1' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'case', 'SMITH1', expect.objectContaining({ relation: 'upload' }),
    );
  });

  test("an UNCACHED case falls to 'upload' — absence of proof is not proof", async () => {
    const db = mkDb({});                       // nothing cached for this case
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'NEWCASE' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'case', 'NEWCASE', expect.objectContaining({ relation: 'upload' }),
    );
  });

  test("a FAILING cache read falls to 'upload' rather than guessing 'path'", async () => {
    const db = mkDb({ SMITH1: '/cases/smith' }, { throwOnCache: true });
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'SMITH1' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'case', 'SMITH1', expect.objectContaining({ relation: 'upload' }),
    );
  });

  test("a CONTACT link is always 'upload' — contacts have no folder convention", async () => {
    // reconcilePathLinks scopes itself to link_type='case' for the same
    // reason. A contact link can never be derived from a path, so it can
    // never truthfully be 'path'.
    const db = mkDb({ 1001: '/cases/smith' });   // even with a same-id cache hit
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'contact', id: '1001' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'contact', '1001', expect.objectContaining({ relation: 'upload' }),
    );
  });

  test('prefix matching is SEGMENT-SAFE — /cases/smith does not match /cases/smithson', async () => {
    // The bug this prevents puts one client's documents on another client's
    // case, which is the worst outcome this feature can produce.
    expect(ingest._under('/cases/smithson/x.pdf', '/cases/smith')).toBe(false);
    expect(ingest._under('/cases/smith/x.pdf', '/cases/smith')).toBe(true);
    // The folder itself is not "under" itself — a case folder is not a file.
    expect(ingest._under('/cases/smith', '/cases/smith')).toBe(false);
  });

  test('case comparison is case-insensitive — the cache is lowercase, metadata is not', async () => {
    // case_folder_cache.path_lower is lowercase (path_display is NULL for
    // every row in production — Dropbox omits it on shared-link metadata), so
    // a mixed-case path_lower from any other source must still match.
    const db = mkDb({ SMITH1: '/cases/smith' });
    documents.upsertFromEntry.mockResolvedValue({
      row: fileRow({ path_lower: '/Cases/Smith/Statement.pdf' }), created: true, changes: {},
    });

    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'SMITH1' }],
    });

    expect(documents.link).toHaveBeenCalledWith(
      db, 41, 'case', 'SMITH1', expect.objectContaining({ relation: 'path' }),
    );
  });

  test('two links on one file are decided INDEPENDENTLY', async () => {
    // The portal upload links both the case and the authenticated uploader.
    // The case link may be truthful location; the contact link never is.
    const db = mkDb({ SMITH1: '/cases/smith' });
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'SMITH1' }, { type: 'contact', id: '1001' }],
    });

    const rels = documents.link.mock.calls.map(c => [c[2], c[4].relation]);
    expect(rels).toEqual([['case', 'path'], ['contact', 'upload']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Emissions
// ─────────────────────────────────────────────────────────────────────────────

describe('emissions', () => {
  test('write-time registration EMITS — S5 triggers consume these', async () => {
    // The backfill's { emit:false } must never leak into this path. A silent
    // regression here would look like "automations stopped working" with
    // nothing in any log to say why.
    const db = mkDb({});
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' }, links: [], eventSource: 'upload',
    });

    expect(documents.upsertFromEntry).toHaveBeenCalledWith(
      db, 'dropbox', expect.any(Object),
      expect.objectContaining({ emit: true, eventSource: 'upload' }),
    );
  });

  test('the acting user rides through to both the row event and the link', async () => {
    const db = mkDb({});
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [{ type: 'case', id: 'C1' }],
      createdBy: 9,
    });

    expect(documents.upsertFromEntry.mock.calls[0][3]).toMatchObject({ actorUserId: 9 });
    expect(documents.link.mock.calls[0][4]).toMatchObject({ createdBy: 9 });
  });

  test('a client/automation write carries created_by NULL', async () => {
    // Load-bearing beyond tidiness: created_by IS NULL is half the
    // discriminator reconcilePathLinks uses. A machine link that invented a
    // user would become permanently unreconcilable.
    const db = mkDb({ C1: '/cases/c1' });
    await ingest.registerWritten(db, {
      entry: { id: 'id:AAA', name: 'x.pdf' }, links: [{ type: 'case', id: 'C1' }],
    });
    expect(documents.link.mock.calls[0][4]).toMatchObject({ createdBy: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guards + failure isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('guards', () => {
  test('a FOLDER is refused — it would register with no size/rev and pollute lists', async () => {
    await expect(ingest.registerWritten(mkDb({}), {
      entry: { '.tag': 'folder', id: 'id:F', name: 'Client Uploads' },
    })).rejects.toThrow(/folder/i);
    expect(documents.upsertFromEntry).not.toHaveBeenCalled();
  });

  test('with no entry it STATS the path — the writers that have no metadata', async () => {
    const provider = { stat: jest.fn(async () => ({ id: 'id:ZZ', name: 'z.pdf' })) };
    sources.get.mockReturnValue(provider);

    await ingest.registerWritten(mkDb({}), { path: '/cases/smith/z.pdf', links: [] });

    expect(provider.stat).toHaveBeenCalledWith(expect.anything(), '/cases/smith/z.pdf', {});
    expect(documents.upsertFromEntry.mock.calls[0][2]).toMatchObject({ id: 'id:ZZ' });
  });

  test('registerWritten THROWS — the two routes where registration IS the request', async () => {
    documents.upsertFromEntry.mockRejectedValue(new Error('db down'));
    await expect(ingest.registerWritten(mkDb({}), {
      entry: { id: 'id:AAA', name: 'x.pdf' }, links: [],
    })).rejects.toThrow('db down');
  });

  test('registerWrittenSafe NEVER throws — the bytes are already in Dropbox', async () => {
    // Every in-app hook uses this. A registry failure costs a delay (the
    // delta finds the file); throwing would cost the caller's response, its
    // notification, or its whole workflow step.
    documents.upsertFromEntry.mockRejectedValue(new Error('db down'));
    const out = await ingest.registerWrittenSafe(mkDb({}), {
      entry: { id: 'id:AAA', name: 'x.pdf' }, links: [],
    });
    expect(out).toMatchObject({ ok: false });
    expect(out.error).toMatch('db down');
  });

  test('malformed link entries are dropped, not passed through as undefined', async () => {
    await ingest.registerWritten(mkDb({}), {
      entry: { id: 'id:AAA', name: 'x.pdf' },
      links: [null, { type: 'case' }, { id: 'X' }, { type: 'case', id: '' }, { type: 'case', id: 'OK1' }],
    });
    expect(documents.link).toHaveBeenCalledTimes(1);
    expect(documents.link.mock.calls[0][3]).toBe('OK1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// registerLandedInFolder — the client-upload shape
// ─────────────────────────────────────────────────────────────────────────────

describe('registerLandedInFolder — claim by window, never by reported name', () => {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  function listing(entries) {
    dropbox.listFolder.mockResolvedValue({ entries, count: entries.length });
  }

  test('registers recent files and IGNORES older residents of a shared bin', async () => {
    listing([
      { '.tag': 'file', id: 'id:NEW', name: 'new.pdf',  server_modified: iso(60 * 1000) },
      { '.tag': 'file', id: 'id:OLD', name: 'old.pdf',  server_modified: iso(30 * 24 * 3600 * 1000) },
    ]);
    const out = await ingest.registerLandedInFolder(mkDb({}), {
      folderPath: '/bin', links: [{ type: 'case', id: 'C1' }],
    });

    expect(out.registered).toBe(1);
    expect(documents.upsertFromEntry.mock.calls.map(c => c[2].id)).toEqual(['id:NEW']);
  });

  test('an AUTORENAMED file is claimed — its name matches nothing the client reported', async () => {
    // THE REASON THIS IS NOT A NAME MATCH. The client uploaded "statement.pdf";
    // Dropbox's autorename made it "statement (1).pdf". A name-matching
    // implementation registers nothing and the case never sees the document.
    listing([{ '.tag': 'file', id: 'id:R', name: 'statement (1).pdf', server_modified: iso(5000) }]);
    const out = await ingest.registerLandedInFolder(mkDb({}), {
      folderPath: '/bin', links: [{ type: 'case', id: 'C1' }],
    });
    expect(out.registered).toBe(1);
  });

  test('FOLDERS in the listing are skipped', async () => {
    listing([
      { '.tag': 'folder', id: 'id:F', name: 'sub', server_modified: iso(1000) },
      { '.tag': 'file',   id: 'id:G', name: 'g.pdf', server_modified: iso(1000) },
    ]);
    const out = await ingest.registerLandedInFolder(mkDb({}), { folderPath: '/bin', links: [] });
    expect(out.registered).toBe(1);
  });

  test('an entry with NO usable timestamp is NOT claimed', async () => {
    // In a shared bin an undatable file could be anything. The sweep will
    // file it from its path if it has a case folder to sit under.
    listing([{ '.tag': 'file', id: 'id:X', name: 'x.pdf' }]);
    const out = await ingest.registerLandedInFolder(mkDb({}), { folderPath: '/bin', links: [] });
    expect(out.registered).toBe(0);
  });

  test('a sharedLink destination is resolved and the subfolder appended', async () => {
    dropbox.resolveLocation.mockResolvedValue('/cases/smith');
    listing([]);
    await ingest.registerLandedInFolder(mkDb({}), {
      sharedLink: 'https://db/s/x', subfolder: 'Client Uploads', links: [],
    });
    expect(dropbox.listFolder.mock.calls[0][1].path).toBe('/cases/smith/Client Uploads');
  });

  test('NEVER throws — it runs in post-200 side-effect phases', async () => {
    dropbox.listFolder.mockRejectedValue(new Error('dropbox down'));
    const out = await ingest.registerLandedInFolder(mkDb({}), { folderPath: '/bin', links: [] });
    expect(out).toMatchObject({ registered: 0 });
  });

  test('one bad entry does not abort the batch', async () => {
    listing([
      { '.tag': 'file', id: 'id:A', name: 'a.pdf', server_modified: iso(1000) },
      { '.tag': 'file', id: 'id:B', name: 'b.pdf', server_modified: iso(1000) },
    ]);
    documents.upsertFromEntry
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ row: fileRow(), created: true, changes: {} });

    const out = await ingest.registerLandedInFolder(mkDb({}), { folderPath: '/bin', links: [] });
    expect(out.registered).toBe(1);
  });

  test('the listing is CAPPED — an unswept bin must not become thousands of upserts', async () => {
    listing([]);
    await ingest.registerLandedInFolder(mkDb({}), { folderPath: '/bin', links: [] });
    expect(dropbox.listFolder.mock.calls[0][1].maxEntries).toBe(ingest.LANDING_MAX_ENTRIES);
  });

  test('the window is pinned to the upload link validity', async () => {
    // Widening claims a previous batch's files; narrowing misses a client who
    // picked their files and went to lunch.
    expect(ingest.LANDING_WINDOW_MS).toBe(7200 * 1000);
  });
});
