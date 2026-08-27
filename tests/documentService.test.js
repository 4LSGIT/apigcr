// tests/documentService.test.js
//
/**
 * services/documentService.js — the documents registry (Documents S1).
 *
 * WHAT MATTERS HERE
 *   - The EMISSION MATRIX on upsertFromEntry. insert → document.created,
 *     meaningful change → document.updated, NOTHING changed → silence. That
 *     last one is not a nicety: S2's sync re-walks the whole tree, so the
 *     overwhelming majority of upserts are no-ops, and an event apiece would
 *     be a permanent trigger-engine load with zero signal in it.
 *   - { emit: false } really suppresses. S2's backfill upserts ~150k rows in
 *     one pass; if this leaks, the backfill is an outage plus a
 *     trigger_executions table the size of the backfill.
 *   - CLAMPING. This DB's sql_mode has no STRICT_TRANS_TABLES, so an
 *     over-length write does not error — it truncates silently. Every string
 *     that reaches SQL must be clamped in application code, and clamped by
 *     CODEPOINT (MySQL counts VARCHAR in characters; a naive JS slice counts
 *     UTF-16 code units and can store half an emoji).
 *   - LINK IDEMPOTENCY and the case_id / contact_id promotion. document.linked
 *     is the ONLY document event that can carry an owner; if the promotion
 *     breaks, every case-scoped rule silently stops matching.
 *   - markDeletedByPath's PREFIX arm. Dropbox reports a folder delete as ONE
 *     entry with no ids; without the prefix cascade every file underneath it
 *     stays 'active' forever.
 *
 * NO network, NO real DB: `db` is a stub whose query() dispatches on SQL text
 * (the taskService.test.js convention — no ordered script, so no scriptGuard
 * needed). domainEvents.emit is monkey-patched on the require cache;
 * documentService property-looks-up `domainEvents.emit` at call time, so
 * patching the cached module object intercepts cleanly.
 *
 * Run:
 *   npx jest tests/documentService.test.js
 */

'use strict';

// credentialCrypto (reached transitively) throws at REQUIRE time without this.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const crypto       = require('crypto');
const documentSvc  = require('../services/documentService');
const domainEvents = require('../lib/domainEvents');

const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

// ─────────────────────────────────────────────────────────────
// Stubs
// ─────────────────────────────────────────────────────────────

const realEmit = domainEvents.emit;
let emit;      // jest.fn — captures (db, eventType, payload)

beforeEach(() => {
  emit = jest.fn(() => Promise.resolve());
  domainEvents.emit = emit;
});

afterEach(() => { jest.clearAllMocks(); });
afterAll(() => { domainEvents.emit = realEmit; });

/** Every emitted event type, in order. */
const emittedTypes = () => emit.mock.calls.map((c) => c[1]);
/** The payload of the Nth emission. */
const payloadAt = (n = 0) => emit.mock.calls[n][2];

/**
 * SQL-text-dispatching db stub.
 *
 * `row` is the CURRENT documents row the SELECTs return (null = not
 * registered yet). The upsert INSERT does not mutate it — tests set
 * `after` explicitly when they want the post-write read to differ, which
 * keeps "what the DB had" and "what the DB now has" visible side by side
 * instead of buried in a fake write path.
 */
function makeDb({
  row = null, after = undefined, insertResult, updateResult, deleteResult, rows,
  linkDuplicate = false,
  // ── S3.1 related-scope fixtures (all default empty, so every pre-existing
  //    test constructs the same stub it always did) ──────────────────────────
  relate = [],      // case_relate rows: { rel_id, rel_type }
  viaLinks = [],    // document_links rows: { document_id, link_type, link_id }
  caseLabels = [],  // { case_id, label }
  contactLabels = [], // { contact_id, label }
} = {}) {
  const calls = [];
  let selectCount = 0;

  return {
    calls,
    /** SQL of the Nth query, whitespace-collapsed. */
    sqlAt: (n) => calls[n].sql,
    paramsAt: (n) => calls[n].params,
    find: (needle) => calls.find((c) => c.sql.includes(needle)),
    all:  (needle) => calls.filter((c) => c.sql.includes(needle)),
    query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params: params || [] });

      // ── S3.1 ────────────────────────────────────────────────────────────
      // Declared BEFORE the generic document arms below: these shapes are
      // more specific, and none of them starts with a prefix the older arms
      // claim, so ordering here is belt-and-braces rather than load-bearing.
      if (/FROM case_relate/.test(flat))          return [relate];
      if (/^SELECT dl\.document_id/.test(flat))   return [viaLinks];
      if (/FROM cases WHERE case_id IN/.test(flat))       return [caseLabels];
      if (/FROM contacts WHERE contact_id IN/.test(flat)) return [contactLabels];

      if (/^SELECT \* FROM documents WHERE/.test(flat)) {
        // 1st read = prior state, 2nd = post-write state.
        const which = selectCount++ === 0 ? row : (after === undefined ? row : after);
        return [which ? [which] : []];
      }
      if (/^SELECT \* FROM document_links/.test(flat)) return [rows || []];
      if (/^SELECT d\.\*|^SELECT COUNT|^SELECT d\.\*, dl\./.test(flat)) return [rows || []];
      if (/^INSERT INTO documents/.test(flat))      return [insertResult || { affectedRows: 1 }];
      if (/^INSERT INTO document_links/.test(flat)) {
        if (linkDuplicate) {
          // What the server actually throws on the unique key. mysql2 surfaces
          // both errno and code; the service checks both.
          const e = new Error("Duplicate entry '7-case-aB3xY9' for key 'uq_doc_target'");
          e.errno = 1062;
          e.code  = 'ER_DUP_ENTRY';
          throw e;
        }
        return [insertResult || { affectedRows: 1 }];
      }
      if (/^UPDATE documents/.test(flat))           return [updateResult || { affectedRows: 1 }];
      if (/^DELETE FROM document_links/.test(flat)) return [deleteResult || { affectedRows: 1 }];

      throw new Error('stubDb: unhandled SQL: ' + flat);
    },
  };
}

/** A Dropbox FileMetadata, shaped exactly as the live API returns one. */
function entry(overrides = {}) {
  return {
    '.tag':           'file',
    id:               'id:glkBw_soyGAAAAAAAADg3g',
    name:             'Appeal List - as of JUNE 1 24.xlsx',
    path_display:     '/  Law Office/   Cases/  Active Cases/  Active - Appeals/Appeal List - as of JUNE 1 24.xlsx',
    path_lower:       '/  law office/   cases/  active cases/  active - appeals/appeal list - as of june 1 24.xlsx',
    size:             10229,
    content_hash:     '42dd393c955a6cef7b8e6688053251ed6480a7708e9e7d18a18be363f727b9fb',
    rev:              '61faaf991c23e5df25139',
    server_modified:  '2024-08-14T20:57:32Z',
    ...overrides,
  };
}

/** The documents row that `entry()` upserts to. */
function docRow(overrides = {}) {
  const e = entry();
  return {
    id:              7,
    source:          'dropbox',
    external_id:     e.id,
    name:            e.name,
    path:            e.path_display,
    path_lower:      e.path_lower,
    path_hash:       sha1(e.path_lower),
    ext:             'xlsx',
    mime:            null,
    size:            e.size,
    content_hash:    e.content_hash,
    rev:             e.rev,
    server_modified: new Date('2024-08-14T20:57:32Z'),
    shared_link:     null,
    title:           null,
    doc_type:        null,
    tags:            null,
    ai_meta:         null,
    status:          'active',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// upsertFromEntry — the emission matrix
// ─────────────────────────────────────────────────────────────

describe('upsertFromEntry — emission matrix', () => {
  test('INSERT (no prior row) emits document.created exactly once', async () => {
    const db = makeDb({ row: null, after: docRow() });
    const { row, created } = await documentSvc.upsertFromEntry(db, 'dropbox', entry());

    expect(created).toBe(true);
    expect(row.id).toBe(7);
    expect(emittedTypes()).toEqual(['document.created']);

    const p = payloadAt(0);
    // contact_id / case_id are ALWAYS absent here — at registration time
    // nothing knows which case a file belongs to. Attribution is
    // document.linked's job, and the EVENT_TYPES description promises this.
    expect(p.case_id).toBeUndefined();
    expect(p.contact_id).toBeUndefined();
    expect(p.data).toEqual({
      id: 7,
      source: 'dropbox',
      external_id: 'id:glkBw_soyGAAAAAAAADg3g',
      name: 'Appeal List - as of JUNE 1 24.xlsx',
      path: entry().path_display,
      doc_type: null,
      tags: null,
      status: 'active',
    });
  });

  test('the envelope data projection WITHHOLDS shared_link and ai_meta', async () => {
    // Envelopes persist into trigger_executions for 30-90 days, readable by
    // any staff JWT/API key and the readonly SQL endpoint. shared_link is a
    // PERMANENT PUBLIC URL to a client document; replicating it into a second
    // long-lived table is a leak amplifier for no rule-authoring benefit.
    const db = makeDb({
      row: null,
      after: docRow({ shared_link: 'https://www.dropbox.com/s/secret/x?dl=0', ai_meta: { big: 'blob' } }),
    });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry());

    const data = payloadAt(0).data;
    expect(data).not.toHaveProperty('shared_link');
    expect(data).not.toHaveProperty('ai_meta');
    expect(JSON.stringify(payloadAt(0))).not.toContain('secret');
  });

  test('UPDATE with a meaningful change emits document.updated with a changes map', async () => {
    const prior = docRow({ rev: 'OLDREV0000000000000' });
    const db = makeDb({ row: prior, after: docRow() });

    const { created } = await documentSvc.upsertFromEntry(db, 'dropbox', entry());

    expect(created).toBe(false);
    expect(emittedTypes()).toEqual(['document.updated']);
    const p = payloadAt(0);
    expect(p.changes.rev).toEqual({ from: 'OLDREV0000000000000', to: '61faaf991c23e5df25139' });
    expect(p.extra).toEqual({ updated_fields: ['rev'], via: 'sync' });
  });

  test('a MOVE (path changed, same id) emits updated — the whole point of id-keying', async () => {
    const moved = entry({
      path_display: '/  Law Office/   Cases/ Closed Cases/  Active - Appeals/Appeal List - as of JUNE 1 24.xlsx',
      path_lower:   '/  law office/   cases/ closed cases/  active - appeals/appeal list - as of june 1 24.xlsx',
    });
    const db = makeDb({ row: docRow(), after: docRow({ path: moved.path_display, path_lower: moved.path_lower }) });

    await documentSvc.upsertFromEntry(db, 'dropbox', moved);

    expect(emittedTypes()).toEqual(['document.updated']);
    expect(payloadAt(0).changes.path_lower.to).toBe(moved.path_lower);
    // A path-keyed registry would have lost this row entirely.
    expect(payloadAt(0).data.external_id).toBe(docRow().external_id);
  });

  test('a RESURRECTION (deleted → active) emits updated with changes.status', async () => {
    const db = makeDb({ row: docRow({ status: 'deleted' }), after: docRow() });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry());

    expect(emittedTypes()).toEqual(['document.updated']);
    expect(payloadAt(0).changes.status).toEqual({ from: 'deleted', to: 'active' });
  });

  test('a NO-OP upsert emits NOTHING', async () => {
    // The common case during a sync re-walk. Silence is the feature.
    const db = makeDb({ row: docRow(), after: docRow() });
    const { created } = await documentSvc.upsertFromEntry(db, 'dropbox', entry());

    expect(created).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  test('a change OUTSIDE the meaningful set is silent', async () => {
    // server_modified ticks on a plain touch. Nobody wants a rule to fire for it.
    const db = makeDb({
      row:   docRow({ server_modified: new Date('2020-01-01T00:00:00Z') }),
      after: docRow(),
    });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry());
    expect(emit).not.toHaveBeenCalled();
  });

  // ── S3.1: the changes map is RETURNED, not just emitted ──────────────
  //
  // documentSyncService's move reconciler reads changes.path_lower to decide
  // whether a file MOVED. If this stops being returned — or starts being
  // returned only when emitting — reconciliation silently stops running and
  // stale path-links accumulate with nothing failing anywhere.

  test('the changes map is RETURNED alongside row/created', async () => {
    const db = makeDb({
      row: docRow(),
      after: docRow({ path_lower: '/moved/f.xlsx' }),
    });
    const out = await documentSvc.upsertFromEntry(db, 'dropbox', entry({
      path_lower: '/moved/f.xlsx', path_display: '/Moved/f.xlsx',
    }));

    expect(out.changes).toHaveProperty('path_lower');
    expect(out.changes.path_lower).toMatchObject({ to: '/moved/f.xlsx' });
  });

  test('changes is returned even with { emit: false }', async () => {
    // The reconciler must work regardless of emission policy; coupling the two
    // is how a future "quiet mode" would break it without a test failing.
    const db = makeDb({ row: docRow(), after: docRow({ path_lower: '/moved/f.xlsx' }) });
    const out = await documentSvc.upsertFromEntry(db, 'dropbox',
      entry({ path_lower: '/moved/f.xlsx' }), { emit: false });

    expect(emit).not.toHaveBeenCalled();
    expect(out.changes).toHaveProperty('path_lower');
  });

  test('an INSERT returns an EMPTY changes map, not undefined', async () => {
    // There is no prior state to have changed FROM. Callers test the map for a
    // specific key, so `{}` reads correctly and `undefined` would throw.
    const db = makeDb({ row: null, after: docRow() });
    const out = await documentSvc.upsertFromEntry(db, 'dropbox', entry());
    expect(out.created).toBe(true);
    expect(out.changes).toEqual({});
  });

  test('a NO-OP returns an empty changes map', async () => {
    const db = makeDb({ row: docRow() });
    const out = await documentSvc.upsertFromEntry(db, 'dropbox', entry());
    expect(out.changes).toEqual({});
    expect(emit).not.toHaveBeenCalled();
  });

  test('{ emit: false } suppresses BOTH the insert and the update event', async () => {
    // S2's backfill contract. If this leaks, the backfill storms the engine.
    const insertDb = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(insertDb, 'dropbox', entry(), { emit: false });

    const updateDb = makeDb({ row: docRow({ rev: 'OLDREV0000000000000' }), after: docRow() });
    await documentSvc.upsertFromEntry(updateDb, 'dropbox', entry(), { emit: false });

    expect(emit).not.toHaveBeenCalled();
  });

  test('attribution is THREADED when supplied and OMITTED (not nulled) when not', async () => {
    // "system did it" and "we don't know who did it" must stay distinguishable
    // to a rule author — the caseService convention.
    const withDb = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(withDb, 'dropbox', entry(), {
      eventSource: 'manual', actorUserId: 22,
    });
    expect(payloadAt(0).source).toBe('manual');
    expect(payloadAt(0).actor).toEqual({ user_id: 22 });

    emit.mockClear();
    const bareDb = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(bareDb, 'dropbox', entry());
    expect(payloadAt(0)).not.toHaveProperty('source');
    expect(payloadAt(0)).not.toHaveProperty('actor');
  });
});

// ─────────────────────────────────────────────────────────────
// upsertFromEntry — what actually gets written
// ─────────────────────────────────────────────────────────────

describe('upsertFromEntry — derived and preserved columns', () => {
  /** Params of the documents INSERT, positionally. */
  async function insertParams(e, source = 'dropbox') {
    const db = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(db, source, e, { emit: false });
    return db.find('INSERT INTO documents').params;
  }

  test('path_hash is sha1(path_lower), and ext is derived from the name', async () => {
    const p = await insertParams(entry());
    // [source, external_id, name, path, path_lower, path_hash, ext, mime, ...]
    expect(p[4]).toBe(entry().path_lower);
    expect(p[5]).toBe(sha1(entry().path_lower));
    expect(p[6]).toBe('xlsx');
  });

  test('path and path_lower are stored VERBATIM — spaces are load-bearing', async () => {
    const p = await insertParams(entry());
    expect(p[3]).toBe(entry().path_display);
    expect(p[4]).toBe(entry().path_lower);

    // The invariant is PER SEGMENT: the firm sorts folders by leading spaces,
    // so "  Law Office" and "   Cases" must keep their exact prefix. (A whole-
    // string trim() is a no-op here — the path starts with '/' — which is
    // precisely why it is the wrong thing to assert.)
    const segments = p[3].split('/').slice(1);
    expect(segments[0]).toBe('  Law Office');
    expect(segments[1]).toBe('   Cases');
    expect(segments[2]).toBe('  Active Cases');
    expect(segments.map((s) => s.trim())).not.toEqual(segments);
  });

  test('server_modified is normalized out of ISO Zulu into a MySQL DATETIME', async () => {
    // Handing '2024-08-14T20:57:32Z' straight to a DATETIME column relies on
    // lenient parsing of the trailing Z, which without strict mode truncates
    // silently rather than erroring.
    const p = await insertParams(entry());
    expect(p[11]).toBe('2024-08-14 20:57:32');
  });

  test('HUMAN/AI-owned columns are absent from the upsert entirely', async () => {
    // A re-sync must never wipe a staffer's classification. The strongest
    // form of that guarantee is that the statement cannot touch them.
    const db = makeDb({ row: docRow({ title: 'Retainer', doc_type: 'contract' }), after: docRow() });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry(), { emit: false });

    const sql = db.find('INSERT INTO documents').sql;
    for (const col of ['title', 'doc_type', 'tags', 'ai_meta', 'shared_link']) {
      expect(sql).not.toContain(col);
    }
  });

  test('mime is COALESCEd so a provider that omits it cannot null an existing value', async () => {
    const db = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry(), { emit: false });
    expect(db.find('INSERT INTO documents').sql)
      .toContain('mime = COALESCE(new.mime, documents.mime)');

    // Dropbox sends no mime; a future provider might.
    const p = await insertParams(entry({ mime: 'application/pdf' }));
    expect(p[7]).toBe('application/pdf');
  });

  test('a missing id or name throws rather than writing a junk row', async () => {
    const db = makeDb({ row: null, after: docRow() });
    await expect(documentSvc.upsertFromEntry(db, 'dropbox', entry({ id: undefined })))
      .rejects.toThrow('entry.id is required');
    await expect(documentSvc.upsertFromEntry(db, 'dropbox', entry({ name: '' })))
      .rejects.toThrow('entry.name is required');
    await expect(documentSvc.upsertFromEntry(db, 'dropbox', null))
      .rejects.toThrow('entry is required');
  });
});

// ─────────────────────────────────────────────────────────────
// Clamping
// ─────────────────────────────────────────────────────────────

describe('clamping — the no-STRICT_TRANS_TABLES defence', () => {
  test('name is clamped to 512 characters', async () => {
    const long = 'x'.repeat(900) + '.pdf';
    const db = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry({ name: long }), { emit: false });

    const p = db.find('INSERT INTO documents').params;
    expect(p[2]).toHaveLength(512);
    expect(p[2]).toBe('x'.repeat(512));
  });

  test('the clamp counts CODEPOINTS, so a surrogate pair is never split', async () => {
    // MySQL counts a utf8mb4 VARCHAR in characters; a naive JS slice counts
    // UTF-16 code units and would store a lone surrogate at the boundary.
    const emoji = '\u{1F4C4}'; // 📄 — one codepoint, two code units
    const name = emoji.repeat(600);
    const db = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(db, 'dropbox', entry({ name }), { emit: false });

    const stored = db.find('INSERT INTO documents').params[2];
    expect(Array.from(stored)).toHaveLength(512);      // 512 CHARACTERS, as MySQL counts
    expect(stored).toHaveLength(1024);                 // 1024 code units, as JS counts
    expect(stored.endsWith(emoji)).toBe(true);         // no half-emoji at the edge
    expect(/[\uD800-\uDBFF]$/.test(stored)).toBe(false);
  });

  test('_clamp is a no-op below the limit and null-safe', () => {
    expect(documentSvc._clamp('abc', 10)).toBe('abc');
    expect(documentSvc._clamp(null, 10)).toBeNull();
    expect(documentSvc._clamp(undefined, 10)).toBeNull();
    expect(documentSvc._clamp(12345, 3)).toBe('123');
  });

  test('path and path_lower are NOT clamped — truncating a path corrupts it', () => {
    // They are TEXT precisely so this is safe. Deep case folder + scanned
    // filename passes 512 chars routinely in the firm's tree.
    expect(documentSvc.COLUMN_LIMITS).not.toHaveProperty('path');
    expect(documentSvc.COLUMN_LIMITS).not.toHaveProperty('path_lower');
  });

  test('link_type / link_id / relation are clamped on the way into document_links', async () => {
    const db = makeDb({ row: docRow(), insertResult: { affectedRows: 1 } });
    await documentSvc.link(db, 7, 'z'.repeat(50), 'y'.repeat(90), { relation: 'r'.repeat(50) });

    const p = db.find('INSERT INTO document_links').params;
    expect(p[1]).toHaveLength(32);   // link_type
    expect(p[2]).toHaveLength(64);   // link_id
    expect(p[3]).toHaveLength(32);   // relation
  });

  test('_extOf refuses to invent an extension', () => {
    expect(documentSvc._extOf('a.PDF')).toBe('pdf');
    expect(documentSvc._extOf('.gitignore')).toBeNull();     // dotfile, not an ext
    expect(documentSvc._extOf('no-dot')).toBeNull();
    expect(documentSvc._extOf('trailing.')).toBeNull();
    expect(documentSvc._extOf('report.final version')).toBeNull();
    expect(documentSvc._extOf('x.' + 'y'.repeat(40))).toBeNull(); // over the column, so null not truncated
  });

  test('_toMysqlDT handles the shapes a provider can realistically send', () => {
    expect(documentSvc._toMysqlDT('2024-08-14T20:57:32Z')).toBe('2024-08-14 20:57:32');
    expect(documentSvc._toMysqlDT('2024-08-14 20:57:32')).toBe('2024-08-14 20:57:32');
    expect(documentSvc._toMysqlDT(new Date('2024-08-14T20:57:32Z'))).toBe('2024-08-14 20:57:32');
    expect(documentSvc._toMysqlDT(null)).toBeNull();
    expect(documentSvc._toMysqlDT('')).toBeNull();
    expect(documentSvc._toMysqlDT('not a date')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// update
// ─────────────────────────────────────────────────────────────

describe('update', () => {
  test('normalizes tags through the assetService convention', async () => {
    const db = makeDb({ row: docRow(), after: docRow({ tags: 'court-notice,urgent' }) });
    await documentSvc.update(db, 7, { tags: ['Court Notice', ' URGENT ', 'court notice'] });

    const p = db.find('UPDATE documents').params;
    expect(p[0]).toBe('court-notice,urgent'); // lowercased, whitespace→'-', de-duped
  });

  test('emits document.updated with via=edit and a changes map', async () => {
    const db = makeDb({ row: docRow(), after: docRow({ doc_type: 'petition' }) });
    await documentSvc.update(db, 7, { doc_type: 'petition' }, { eventSource: 'manual', actorUserId: 1 });

    expect(emittedTypes()).toEqual(['document.updated']);
    const p = payloadAt(0);
    expect(p.extra.via).toBe('edit');
    expect(p.changes.doc_type).toEqual({ from: null, to: 'petition' });
    expect(p.actor).toEqual({ user_id: 1 });
  });

  test('writing the SAME value is a no-op: no UPDATE, no event', async () => {
    const db = makeDb({ row: docRow({ doc_type: 'petition' }) });
    const row = await documentSvc.update(db, 7, { doc_type: 'petition' });

    expect(row.doc_type).toBe('petition');
    expect(db.find('UPDATE documents')).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  test('a missing row yields null and writes nothing', async () => {
    const db = makeDb({ row: null });
    expect(await documentSvc.update(db, 999, { title: 'x' })).toBeNull();
    expect(db.find('UPDATE documents')).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  test('an out-of-range status THROWS rather than writing an empty enum', async () => {
    // No strict mode: an invalid ENUM value lands as '' and the row silently
    // vanishes from every status-filtered list.
    const db = makeDb({ row: docRow() });
    await expect(documentSvc.update(db, 7, { status: 'archived' }))
      .rejects.toThrow('status must be one of');
    expect(db.find('UPDATE documents')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Links
// ─────────────────────────────────────────────────────────────

describe('link / unlink', () => {
  test('a NEW link emits document.linked and promotes case_id', async () => {
    const db = makeDb({ row: docRow(), insertResult: { affectedRows: 1 } });
    const out = await documentSvc.link(db, 7, 'case', 'aB3xY9', { relation: 'petition', createdBy: 1 });

    expect(out).toMatchObject({ linked: true, created: true });
    expect(emittedTypes()).toEqual(['document.linked']);

    const p = payloadAt(0);
    expect(p.case_id).toBe('aB3xY9');          // varchar case ids stay strings
    expect(p.contact_id).toBeUndefined();
    expect(p.actor).toEqual({ user_id: 1 });
    expect(p.extra).toEqual({ link_type: 'case', link_id: 'aB3xY9', relation: 'petition' });
  });

  test('a contact link promotes contact_id as a NUMBER', async () => {
    const db = makeDb({ row: docRow(), insertResult: { affectedRows: 1 } });
    await documentSvc.link(db, 7, 'contact', '22');

    const p = payloadAt(0);
    expect(p.contact_id).toBe(22);
    expect(typeof p.contact_id).toBe('number');
    expect(p.case_id).toBeUndefined();
  });

  test('any OTHER link type promotes neither', async () => {
    const db = makeDb({ row: docRow(), insertResult: { affectedRows: 1 } });
    await documentSvc.link(db, 7, 'appt', '900');

    const p = payloadAt(0);
    expect(p.case_id).toBeUndefined();
    expect(p.contact_id).toBeUndefined();
    expect(p.extra.link_type).toBe('appt');
  });

  test('a REPEAT link is idempotent and SILENT', async () => {
    // The server raises the unique-key violation; that error IS the signal.
    // A rule on document.linked must be safe against retries.
    const db = makeDb({ row: docRow(), linkDuplicate: true });
    const out = await documentSvc.link(db, 7, 'case', 'aB3xY9');

    expect(out).toMatchObject({ linked: true, created: false });
    expect(emit).not.toHaveBeenCalled();
  });

  test('idempotency does NOT lean on affectedRows — the CLIENT_FOUND_ROWS trap', async () => {
    // REGRESSION. The obvious form was `ON DUPLICATE KEY UPDATE id = id` plus
    // `affectedRows === 1` for "inserted". mysql2's defaultFlags include
    // CLIENT_FOUND_ROWS and the pool sets no override, so MySQL reports FOUND
    // rather than CHANGED rows and affectedRows is 1 on the duplicate branch
    // too — measured against a real server, not reasoned about. Every repeat
    // link then looked new and emitted a duplicate document.linked.
    //
    // Pinned two ways: the statement must not carry the ODKU clause, and a
    // duplicate must be detected even when the stub reports affectedRows 1.
    const db = makeDb({ row: docRow(), linkDuplicate: true });
    const out = await documentSvc.link(db, 7, 'case', 'aB3xY9');
    expect(out.created).toBe(false);

    const fresh = makeDb({ row: docRow(), insertResult: { affectedRows: 1 } });
    await documentSvc.link(fresh, 7, 'case', 'aB3xY9');
    const sql = fresh.find('INSERT INTO document_links').sql;
    expect(sql).not.toContain('ON DUPLICATE KEY');
    expect(sql).not.toContain('IGNORE');
  });

  test('a NON-duplicate error is re-thrown, not swallowed as "already linked"', async () => {
    // The reason this is a targeted catch and not INSERT IGNORE: on a schema
    // with no STRICT_TRANS_TABLES, swallowing truncation/type errors is how a
    // silent data bug ships.
    const boom = Object.assign(new Error('Data too long for column'), { errno: 1406, code: 'ER_DATA_TOO_LONG' });
    const db = {
      query: async (sql) => {
        if (/^INSERT INTO document_links/.test(String(sql).trim())) throw boom;
        return [[]];
      },
    };
    await expect(documentSvc.link(db, 7, 'case', 'aB3xY9')).rejects.toThrow('Data too long');
    expect(emit).not.toHaveBeenCalled();
  });

  test('missing arguments throw', async () => {
    const db = makeDb({ row: docRow() });
    await expect(documentSvc.link(db, null, 'case', 'x')).rejects.toThrow('documentId is required');
    await expect(documentSvc.link(db, 7, '', 'x')).rejects.toThrow('linkType is required');
    await expect(documentSvc.link(db, 7, 'case', '')).rejects.toThrow('linkId is required');
  });

  test('unlink reports whether a row was actually removed, and emits nothing', async () => {
    const hit = makeDb({ deleteResult: { affectedRows: 1 } });
    expect(await documentSvc.unlink(hit, 7, 'case', 'aB3xY9')).toBe(true);

    const miss = makeDb({ deleteResult: { affectedRows: 0 } });
    expect(await documentSvc.unlink(miss, 7, 'case', 'nope')).toBe(false);

    // There is no 'document.unlinked' in EVENT_TYPES, and an unregistered
    // emit fires into a void the registry can never wire up.
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// markDeletedByPath
// ─────────────────────────────────────────────────────────────

describe('markDeletedByPath', () => {
  const P = '/  law office/   cases/  active cases/  smith, john - 123';

  test('matches the exact path by hash OR anything beneath it by prefix', async () => {
    // Dropbox reports a FOLDER delete as ONE entry with no ids and no entries
    // for its descendants. Without the prefix arm every file underneath stays
    // 'active' forever.
    const db = makeDb({ updateResult: { affectedRows: 42 } });
    const n = await documentSvc.markDeletedByPath(db, 'dropbox', P);

    expect(n).toBe(42);
    const c = db.find('UPDATE documents');
    expect(c.sql).toContain('path_hash = ?');
    expect(c.sql).toContain('path_lower LIKE ?');
    expect(c.params[1]).toBe(sha1(P));
    expect(c.params[2]).toBe(P + '/%');
  });

  test('is scoped by source and skips rows already deleted', async () => {
    const db = makeDb({ updateResult: { affectedRows: 0 } });
    await documentSvc.markDeletedByPath(db, 'dropbox', P);

    const c = db.find('UPDATE documents');
    expect(c.sql).toContain('source = ?');
    expect(c.sql).toContain("status <> 'deleted'");
    expect(c.params[0]).toBe('dropbox');
  });

  test('LIKE metacharacters in a real path are escaped, not interpreted', async () => {
    // A file named "100%_final_v2" is not a wildcard. Unescaped, '%' and '_'
    // would widen the prefix arm and delete unrelated siblings.
    const tricky = '/  law office/100%_final_v2';
    const db = makeDb({ updateResult: { affectedRows: 1 } });
    await documentSvc.markDeletedByPath(db, 'dropbox', tricky);

    expect(db.find('UPDATE documents').params[2]).toBe('/  law office/100\\%\\_final\\_v2/%');
  });

  test('a backslash in the path is escaped FIRST (order matters)', async () => {
    const db = makeDb({ updateResult: { affectedRows: 1 } });
    await documentSvc.markDeletedByPath(db, 'dropbox', '/a\\b_c');
    expect(db.find('UPDATE documents').params[2]).toBe('/a\\\\b\\_c/%');
  });

  test('an empty path is a no-op — never a table-wide UPDATE', async () => {
    const db = makeDb({ updateResult: { affectedRows: 9999 } });
    expect(await documentSvc.markDeletedByPath(db, 'dropbox', '')).toBe(0);
    expect(await documentSvc.markDeletedByPath(db, 'dropbox', null)).toBe(0);
    expect(db.find('UPDATE documents')).toBeUndefined();
  });

  test('emits nothing — S2 owns delta-event semantics', async () => {
    const db = makeDb({ updateResult: { affectedRows: 4000 } });
    await documentSvc.markDeletedByPath(db, 'dropbox', P);
    expect(emit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────

describe('list', () => {
  async function ran(opts) {
    const db = makeDb({ rows: [] });
    await documentSvc.list(db, opts);
    return { sql: db.sqlAt(0), params: db.paramsAt(0), db };
  }

  test('defaults to active-only, newest-first, limit 50', async () => {
    const { sql, params } = await ran({});
    expect(sql).toContain('d.status = ?');
    expect(params).toEqual(['active']);
    expect(sql).toContain('ORDER BY d.updated_at DESC');
    expect(sql).toContain('LIMIT 50 OFFSET 0');
  });

  test("status 'all' disables the filter", async () => {
    const { sql } = await ran({ status: 'all' });
    expect(sql).not.toContain('d.status = ?');
  });

  test('a >=3 char q uses FULLTEXT boolean mode with rebuilt terms', async () => {
    const { sql, params } = await ran({ q: 'smith petition' });
    expect(sql).toContain('MATCH(d.name, d.title, d.tags) AGAINST (? IN BOOLEAN MODE)');
    expect(params).toContain('+smith* +petition*');
  });

  test('boolean-mode OPERATORS in user input are stripped, never passed through', async () => {
    // A '+' or '(' in a filename search is an operator to MySQL — unstripped
    // it is either a parse error or silently inverted results.
    const { params } = await ran({ q: 'smith -(petition)* @x' });
    const expr = params.find((p) => typeof p === 'string' && p.startsWith('+'));
    expect(expr).toBe('+smith* +petition*');
    expect(expr).not.toMatch(/[-><()~@]/);
  });

  test('a short q falls back to a literal prefix LIKE on name', async () => {
    const { sql, params } = await ran({ q: 'ab' });
    expect(sql).toContain('d.name LIKE ?');
    expect(params).toContain('ab%');
  });

  test('a long q whose every token is under the FULLTEXT floor falls back too', async () => {
    // 'a b c' is 5 chars so it clears the length gate, but no token can ever
    // match innodb_ft_min_token_size=3. Emitting '+a* +b* +c*' would return a
    // confident empty list.
    const { sql, params } = await ran({ q: 'a b c' });
    expect(sql).toContain('d.name LIKE ?');
    expect(params).toContain('a b c%');
    expect(sql).not.toContain('MATCH');
  });

  test('LIKE wildcards in a short q are escaped', async () => {
    const { params } = await ran({ q: '%_' });
    expect(params).toContain('\\%\\_%');
  });

  test('tag uses FIND_IN_SET on the normalized needle, not a substring LIKE', async () => {
    // LIKE '%tag%' would match 'tag' inside 'untagged'.
    const { sql, params } = await ran({ tag: 'Court Notice' });
    expect(sql).toContain('FIND_IN_SET(?, d.tags)');
    expect(params).toContain('court-notice');
  });

  test('link_type + link_id JOIN document_links, and the COUNT mirrors it', async () => {
    const db = makeDb({ rows: [] });
    await documentSvc.list(db, { link_type: 'case', link_id: 'aB3xY9' });

    expect(db.sqlAt(0)).toContain('JOIN document_links dl ON dl.document_id = d.id');
    expect(db.sqlAt(0).startsWith('SELECT d.*')).toBe(true);
    expect(db.sqlAt(1)).toContain('SELECT COUNT(*)');
    expect(db.sqlAt(1)).toContain('JOIN document_links dl');
    // Same filter set, same params — a COUNT that drifts from the page is a lie.
    expect(db.paramsAt(1)).toEqual(db.paramsAt(0));
  });

  // ── S3.1: the `ext` arm ────────────────────────────────────────────────
  //
  // The UI facet is a CATEGORY ("Office documents"), which is several
  // extensions — so the arm takes a CSV. The needle is normalized the same way
  // _extOf normalized the haystack, exactly as `tag` normalizes through
  // normalizeTags; anything that could not have been stored is dropped rather
  // than sent to MySQL to match nothing.

  test('a single ext is an exact match, lowercased', async () => {
    const { sql, params } = await ran({ ext: 'PDF' });
    expect(sql).toContain('d.ext = ?');
    expect(params).toContain('pdf');
  });

  test('a leading dot is tolerated — staff type ".pdf"', async () => {
    expect((await ran({ ext: '.pdf' })).params).toContain('pdf');
  });

  test('a CSV becomes an IN list, deduped and in order', async () => {
    const { sql, params } = await ran({ ext: 'doc,DOCX, rtf ,doc' });
    expect(sql).toContain('d.ext IN (?, ?, ?)');
    expect(params.filter(p => ['doc', 'docx', 'rtf'].includes(p)))
      .toEqual(['doc', 'docx', 'rtf']);
  });

  test('junk tokens are DROPPED, not passed through', async () => {
    // _extOf can only ever have stored /^[a-z0-9]{1,20}$/, so a token outside
    // that shape matches nothing by construction. Sending it anyway would be a
    // guaranteed-empty predicate dressed up as a filter.
    const { sql, params } = await ran({ ext: 'pdf, ../etc, a b, %' });
    expect(sql).toContain('d.ext = ?');
    expect(sql).not.toContain('IN (');
    expect(params).toContain('pdf');
    expect(params.some(p => typeof p === 'string' && /[^a-z0-9]/.test(p) && p !== 'active'))
      .toBe(false);
  });

  test('an ALL-junk ext disables the filter rather than returning nothing', async () => {
    // A filter that can only ever match zero rows is worse than no filter: the
    // user sees an empty list and cannot tell it apart from an empty registry.
    const { sql } = await ran({ ext: '../etc/passwd' });
    expect(sql).not.toContain('d.ext');
  });

  test('an empty ext is absent from the WHERE entirely', async () => {
    expect((await ran({ ext: '' })).sql).not.toContain('d.ext');
    expect((await ran({})).sql).not.toContain('d.ext');
  });

  test('the ext arm is clamped and cannot reach SQL as text', async () => {
    const { sql, params } = await ran({ ext: 'a'.repeat(40) });
    // 40 'a's is outside _extOf's 1-20 shape, so it is junk and dropped —
    // which is the safe direction. Nothing interpolates either way.
    expect(sql).not.toContain('aaaa');
    expect(params.every(p => typeof p !== 'string' || !/^a{21,}$/.test(p))).toBe(true);
  });

  test('an unknown sort key falls back to newest instead of reaching SQL', async () => {
    const { sql } = await ran({ sort: 'd.id; DROP TABLE documents' });
    expect(sql).toContain('ORDER BY d.updated_at DESC');
    expect(sql).not.toContain('DROP');
  });

  test('limit is clamped to [1,200] and offset to >= 0', async () => {
    expect((await ran({ limit: 9999 })).sql).toContain('LIMIT 200');
    expect((await ran({ limit: 0 })).sql).toContain('LIMIT 1');
    expect((await ran({ limit: 'junk' })).sql).toContain('LIMIT 50');
    expect((await ran({ offset: -5 })).sql).toContain('OFFSET 0');
  });

  // ── S3: the `modified` sort ────────────────────────────────────────────
  //
  // The S3 UI's DEFAULT sort, and the only one that means anything on real
  // post-backfill data: every row shares one `updated_at` after the bulk
  // pass, so `newest` orders ~150k rows by their tiebreak alone.

  test("sort 'modified' orders by server_modified, NULLS LAST, id-tiebroken", async () => {
    const { sql } = await ran({ sort: 'modified' });
    expect(sql).toContain(
      'ORDER BY (d.server_modified IS NULL) ASC, d.server_modified DESC, d.id DESC');
  });

  test("'modified' puts NULLs LAST — MySQL sorts NULL low, so a bare DESC inverts it", async () => {
    // REGRESSION GUARD. Without the `(x IS NULL) ASC` leader, every row whose
    // provider reported no server_modified lands at the TOP of a newest-first
    // list: the loudest position in the UI for the least informative rows.
    const { sql } = await ran({ sort: 'modified' });
    const order = sql.slice(sql.indexOf('ORDER BY'));
    expect(order.indexOf('(d.server_modified IS NULL) ASC'))
      .toBeLessThan(order.indexOf('d.server_modified DESC'));
  });

  test("'modified' does NOT repoint newest/oldest — they still mean updated_at", async () => {
    // The two are different facts: `updated_at` is when the REGISTRY last
    // wrote the row (a sync audit wants that), `server_modified` is when
    // Dropbox last wrote the file (staff want that). Collapsing them loses one.
    expect((await ran({ sort: 'newest' })).sql).toContain('ORDER BY d.updated_at DESC');
    expect((await ran({ sort: 'oldest' })).sql).toContain('ORDER BY d.updated_at ASC');
    expect((await ran({ sort: 'newest' })).sql).not.toContain('server_modified');
  });

  test('sort is an EXACT map lookup — near-misses fall back, they do not fuzzy-match', async () => {
    // `SORT_MAP[sort]` is exact. A caller sending 'Modified' or ' modified'
    // must land on the newest fallback rather than on something that happens
    // to look close, and no spelling of the input may reach SQL as text.
    for (const junk of ['Modified', ' modified', 'modified ', 'MODIFIED',
                        'modified;--', 'server_modified', '']) {
      const { sql } = await ran({ sort: junk });
      expect(sql).toContain('ORDER BY d.updated_at DESC, d.id DESC');
      expect(sql).not.toContain('server_modified');
      expect(sql).not.toContain(';');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// list — the `unlinked` triage arm (S3.2)
//
// "Documents nobody owns." The view it backs is a work queue, not a defect
// report: ~130,000 of the estate's ~153,000 documents have no case link and
// most of them are CORRECTLY unlinked (the firm's Dropbox spans practice areas
// and decades the `cases` table never covered). What matters here is that the
// predicate means what a human reading that queue thinks it means.
// ─────────────────────────────────────────────────────────────

describe('list — unlinked', () => {
  async function ran(opts) {
    const db = makeDb({ rows: [] });
    const out = await documentSvc.list(db, opts);
    return { sql: db.sqlAt(0), params: db.paramsAt(0), db, out };
  }

  test('anti-joins document_links and keeps the rows with no match', async () => {
    const { sql, params } = await ran({ unlinked: 'case' });
    expect(sql).toContain('LEFT JOIN document_links ul ON ul.document_id = d.id AND ul.link_type = ?');
    expect(sql).toContain('ul.id IS NULL');
    expect(params).toContain('case');
  });

  test('THE PREDICATE IGNORES `relation` — this is not the sweep\'s question', async () => {
    // attributeUnlinked means "has no PATH-link", because it asks whether a
    // file's LOCATION earns it a link — and a manually-filed document
    // legitimately answers no while still being attributed. A human reading a
    // triage queue asks "does anybody own this", so a manual link must take
    // the row OUT of the list. Leaving `relation` out of the ON clause is the
    // entire difference between those two readings.
    const { sql } = await ran({ unlinked: 'case' });
    expect(sql).not.toContain('relation');
  });

  test('the COUNT mirrors the page — a pager that disagrees with its list lies', async () => {
    const { db } = await ran({ unlinked: 'case' });
    expect(db.sqlAt(1)).toContain('SELECT COUNT(*)');
    expect(db.sqlAt(1)).toContain('LEFT JOIN document_links ul');
    expect(db.paramsAt(1)).toEqual(db.paramsAt(0));
  });

  test('A SCOPE WINS — the two are contradictory and the empty set is the worst answer', async () => {
    // "linked to case X" ∩ "linked to no case" is empty for every input, so
    // honouring both would always return nothing — which is indistinguishable
    // from a genuinely empty result. The scope is what the caller addressed,
    // so the scope survives.
    const { sql, out } = await ran({ link_type: 'case', link_id: 'aB3xY9', unlinked: 'case' });
    expect(sql).toContain('JOIN document_links dl');
    expect(sql).not.toContain('ul.id IS NULL');
    expect(out.unlinked).toBeUndefined();
  });

  test('it composes with every other filter', async () => {
    const { sql, params } = await ran({
      unlinked: 'case', ext: 'pdf', status: 'all', q: 'petition', sort: 'modified',
    });
    expect(sql).toContain('ul.id IS NULL');
    expect(sql).toContain('d.ext = ?');
    expect(sql).toContain('MATCH(');
    expect(sql).toContain('ORDER BY (d.server_modified IS NULL) ASC');
    expect(params).toContain('pdf');
  });

  test('an UNKNOWN kind is ignored rather than reaching the predicate', async () => {
    // Same rule as the all-junk `ext` arm: over-showing is recoverable, a
    // mysteriously empty list is not. And an allow-list keeps a caller-supplied
    // string off the link_type predicate.
    for (const junk of ['contact', 'CASE', 'case ', '', 'x; DROP TABLE documents', null]) {
      const { sql, out } = await ran({ unlinked: junk });
      expect(sql).not.toContain('ul.id IS NULL');
      expect(sql).not.toContain('DROP');
      expect(out.unlinked).toBeUndefined();
    }
  });

  test('the applied kind is ECHOED — absence is how a caller learns it was dropped', async () => {
    expect((await ran({ unlinked: 'case' })).out.unlinked).toBe('case');
    expect((await ran({})).out.unlinked).toBeUndefined();
  });

  test('no GROUP BY — the anti-join cannot fan out', async () => {
    // uq_doc_target makes at most one row per (document, type, id), and a LEFT
    // JOIN that keeps only the misses returns exactly one row per document. A
    // GROUP BY here would buy a temp table for nothing.
    const { sql } = await ran({ unlinked: 'case' });
    expect(sql).not.toContain('GROUP BY');
  });
});
//
// Read through list()'s generated SQL rather than by exporting the map: the
// map is private on purpose, and what actually ships is the ORDER BY.
// ─────────────────────────────────────────────────────────────

describe('SORT_MAP shape', () => {
  async function orderFor(sort) {
    const db = makeDb({ rows: [] });
    await documentSvc.list(db, { sort });
    const sql = db.sqlAt(0);
    return sql.slice(sql.indexOf('ORDER BY'), sql.indexOf('LIMIT')).trim();
  }

  test('all five keys resolve, and each ends in a deterministic id tiebreak', async () => {
    const map = {};
    for (const k of ['newest', 'oldest', 'name', 'size', 'modified']) {
      map[k] = await orderFor(k);
    }
    expect(map).toEqual({
      newest:   'ORDER BY d.updated_at DESC, d.id DESC',
      oldest:   'ORDER BY d.updated_at ASC, d.id ASC',
      name:     'ORDER BY d.name ASC, d.id ASC',
      size:     'ORDER BY (d.size IS NULL) ASC, d.size DESC, d.id DESC',
      modified: 'ORDER BY (d.server_modified IS NULL) ASC, d.server_modified DESC, d.id DESC',
    });
    // No tiebreak → rows sharing a timestamp have no stable order and page 2
    // can repeat a row from page 1. Every key must end on the primary key.
    Object.values(map).forEach((o) => expect(o).toMatch(/d\.id (ASC|DESC)$/));
  });
});

// ─────────────────────────────────────────────────────────────
// Bulk paths (Documents S2) — the backfill contract
//
// These exist because upsertFromEntry costs 3 queries/row and the estate is
// ~150k files. Two properties have to hold or the backfill is a liability:
//
//   1. IDENTICAL COLUMNS. If the bulk path writes even one column
//      differently, half the registry is subtly wrong and — with no
//      STRICT_TRANS_TABLES on this schema — nothing errors to say so. Both
//      paths derive parameters through _entryColumns/_entryParams; these
//      tests prove the wiring rather than trusting the comment.
//   2. NO EMISSIONS, EVER. A bulk path that leaked events would fire the
//      trigger engine 150,000 times on files that have been sitting in
//      Dropbox since 2019.
// ─────────────────────────────────────────────────────────────

/** A db stub for the bulk paths — records SQL, returns nothing interesting. */
function makeBulkDb({ rows = [] } = {}) {
  const calls = [];
  return {
    calls,
    find: (needle) => calls.find((c) => c.sql.includes(needle)),
    all:  (needle) => calls.filter((c) => c.sql.includes(needle)),
    query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params: params || [] });
      if (/^SELECT id, external_id/.test(flat)) return [rows];
      return [{ affectedRows: 1 }];
    },
  };
}

describe('bulkUpsertEntries — identical to upsertFromEntry, minus the reads', () => {
  /**
   * PROPERTY TEST: for a spread of entry shapes, the parameter tuple the
   * bulk path submits must equal the one the per-row path submits. Shapes
   * are chosen to exercise every derivation branch — clamping, null paths,
   * missing ext, mime COALESCE, timestamp normalization, codepoint slicing.
   */
  const SHAPES = [
    ['plain file',            entry()],
    ['no extension',          entry({ name: 'Docket Sheet' })],
    ['dotfile (ext -> null)', entry({ name: '.gitignore' })],
    ['junk ext (-> null)',    entry({ name: 'report.final version' })],
    ['null paths',            entry({ path_display: null, path_lower: null })],
    ['mime supplied',         entry({ mime: 'application/pdf' })],
    ['size null',             entry({ size: null })],
    ['over-long name',        entry({ name: 'ä'.repeat(600) + '.pdf' })],
    ['astral-plane name',     entry({ name: '📄'.repeat(400) + '.pdf' })],
    ['bare date stamp',       entry({ server_modified: '2024-08-14 20:57:32' })],
    ['Date object stamp',     entry({ server_modified: new Date('2024-08-14T20:57:32Z') })],
    ['junk stamp (-> null)',  entry({ server_modified: 'not a date' })],
    ['over-long rev',         entry({ rev: 'r'.repeat(200) })],
    ['leading-space path',    entry({ path_lower: '/  law office/   cases/  x/  a.pdf' })],
  ];

  test.each(SHAPES)('%s writes the same params through both paths', async (_label, e) => {
    const singleDb = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(singleDb, 'dropbox', e, { emit: false });
    const singleParams = singleDb.find('INSERT INTO documents').params;

    const bulkDb = makeBulkDb();
    await documentSvc.bulkUpsertEntries(bulkDb, 'dropbox', [e]);
    const bulkParams = bulkDb.find('INSERT INTO documents').params;

    expect(bulkParams).toEqual(singleParams);
  });

  test('the two statements share one ON DUPLICATE clause, mime COALESCE and all', async () => {
    const singleDb = makeDb({ row: null, after: docRow() });
    await documentSvc.upsertFromEntry(singleDb, 'dropbox', entry(), { emit: false });
    const singleSql = singleDb.find('INSERT INTO documents').sql;

    const bulkDb = makeBulkDb();
    await documentSvc.bulkUpsertEntries(bulkDb, 'dropbox', [entry()]);
    const bulkSql = bulkDb.find('INSERT INTO documents').sql;

    for (const clause of [
      'mime = COALESCE(new.mime, documents.mime)',
      'path_hash = new.path_hash',
      'status = new.status',
    ]) {
      expect(singleSql).toContain(clause);
      expect(bulkSql).toContain(clause);
    }
    // Human/AI-owned columns must be absent from BOTH — a re-sync must never
    // wipe a staffer's classification.
    for (const col of ['title =', 'doc_type =', 'tags =', 'ai_meta =', 'shared_link =']) {
      expect(singleSql).not.toContain(col);
      expect(bulkSql).not.toContain(col);
    }
  });

  test('EMITS NOTHING — the whole reason it exists', async () => {
    const db = makeBulkDb();
    await documentSvc.bulkUpsertEntries(db, 'dropbox', [
      entry(), entry({ id: 'id:B', name: 'b.pdf' }), entry({ id: 'id:C', name: 'c.pdf' }),
    ]);
    expect(emit).not.toHaveBeenCalled();
  });

  test('batches at 500 rows — one statement per batch, all rows submitted', async () => {
    const many = Array.from({ length: 1201 }, (_, i) =>
      entry({ id: `id:bulk${i}`, name: `f${i}.pdf` }));

    const db = makeBulkDb();
    const out = await documentSvc.bulkUpsertEntries(db, 'dropbox', many);

    const stmts = db.all('INSERT INTO documents');
    expect(stmts.length).toBe(3);                    // 500 + 500 + 201
    expect(stmts[0].params.length).toBe(500 * 13);
    expect(stmts[2].params.length).toBe(201 * 13);
    expect(out).toEqual({ rows: 1201 });
  });

  test('an empty list is a no-op, not an empty INSERT', async () => {
    const db = makeBulkDb();
    expect(await documentSvc.bulkUpsertEntries(db, 'dropbox', [])).toEqual({ rows: 0 });
    expect(db.calls.length).toBe(0);
  });

  test('a malformed entry THROWS rather than being silently skipped', async () => {
    // A registry that quietly drops a file it could not parse is worse than
    // one that stops loudly: the sync leaves its cursor un-advanced, records
    // last_error, and alerts. Silence would lose the file forever.
    const db = makeBulkDb();
    await expect(documentSvc.bulkUpsertEntries(db, 'dropbox', [entry(), { name: 'no id' }]))
      .rejects.toThrow(/entry\.id is required/);
  });
});

describe('bulkLink — idempotent, silent', () => {
  test('uses plain ON DUPLICATE KEY UPDATE (legal here precisely because it never emits)', async () => {
    // link() must catch ER_DUP_ENTRY instead: CLIENT_FOUND_ROWS makes
    // affectedRows 1 on BOTH branches, and link() needs the distinction
    // because it emits document.linked only for genuinely new rows. This
    // function emits nothing, so the distinction it cannot make is one it
    // does not need.
    const db = makeBulkDb();
    await documentSvc.bulkLink(db, [{ document_id: 7, link_type: 'case', link_id: 'aB3xY9' }]);

    const sql = db.find('INSERT INTO document_links').sql;
    expect(sql).toContain('ON DUPLICATE KEY UPDATE id = id');
    expect(emit).not.toHaveBeenCalled();
  });

  test('clamps link_type / link_id / relation and coerces created_by', async () => {
    const db = makeBulkDb();
    await documentSvc.bulkLink(db, [{
      document_id: 7,
      link_type: 'c'.repeat(80),      // limit 32
      link_id:   'i'.repeat(200),     // limit 64
      relation:  'r'.repeat(80),      // limit 32
      created_by: '22',
    }]);
    const p = db.find('INSERT INTO document_links').params;
    expect(p[1].length).toBe(32);
    expect(p[2].length).toBe(64);
    expect(p[3].length).toBe(32);
    expect(p[4]).toBe(22);
  });

  test('batches at 500 and reports the count', async () => {
    const links = Array.from({ length: 1100 }, (_, i) =>
      ({ document_id: i + 1, link_type: 'case', link_id: 'aB3xY9' }));
    const db = makeBulkDb();
    const out = await documentSvc.bulkLink(db, links);

    expect(db.all('INSERT INTO document_links').length).toBe(3);
    expect(out).toEqual({ rows: 1100 });
    expect(emit).not.toHaveBeenCalled();
  });

  test('an empty list writes nothing', async () => {
    const db = makeBulkDb();
    expect(await documentSvc.bulkLink(db, [])).toEqual({ rows: 0 });
    expect(db.calls.length).toBe(0);
  });
});

describe('mapExternalIds', () => {
  test('resolves external ids to row ids in one query per batch', async () => {
    const db = makeBulkDb({
      rows: [
        { id: 7,  external_id: 'id:A', path_lower: '/a.pdf' },
        { id: 11, external_id: 'id:B', path_lower: '/b.pdf' },
      ],
    });
    const map = await documentSvc.mapExternalIds(db, 'dropbox', ['id:A', 'id:B', 'id:A']);

    expect(db.all('SELECT id, external_id').length).toBe(1);
    // Deduped before it reaches SQL.
    expect(db.calls[0].params[1]).toEqual(['id:A', 'id:B']);
    expect(map.get('id:A')).toEqual({ id: 7, path_lower: '/a.pdf' });
    expect(map.size).toBe(2);
  });

  test('an empty id list makes no query', async () => {
    const db = makeBulkDb();
    expect((await documentSvc.mapExternalIds(db, 'dropbox', [])).size).toBe(0);
    expect(db.calls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// S3.1 — related-scope expansion
//
// WHAT MATTERS HERE
//   - THE ONE-HOP BOUNDARY. A case view shows its own documents and its
//     related contacts' documents. It must NEVER show a related contact's
//     OTHER cases' documents — those belong to a different client matter, and
//     surfacing them is a confidentiality problem, not a UX one. The boundary
//     is enforced STRUCTURALLY (case_relate is resolved in its own query and
//     never appears in the document query, so there is no edge left to
//     traverse) and these tests pin the structure, not just the output.
//   - THE COLLATION TRAP the structure avoids. Joining
//     document_links.link_id (VARCHAR utf8mb4_general_ci) to
//     case_relate.case_relate_client_id (INT) in SQL needs CAST(int AS CHAR),
//     whose collation follows the CONNECTION (utf8mb4_unicode_ci on this
//     server) with coercibility 2 — the same as a column, so neither side wins
//     and MySQL refuses:
//       Illegal mix of collations (utf8mb4_general_ci,IMPLICIT)
//                             and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
//     Verified against the live server. Resolving first deletes the cast, so
//     the ids re-enter as BOUND LITERALS, which adopt the column's collation.
//   - DEDUPE. The expansion CAN fan out (a document linked to both the case
//     and one of its contacts matches twice), so the page needs GROUP BY and
//     the count needs COUNT(DISTINCT) — and they must agree, or the pager lies.
//   - `related` WITHOUT A SCOPE IS IGNORED. The UI leaves the toggle checked
//     when it switches out of scoped mode; that must not expand anything.
// ─────────────────────────────────────────────────────────────

describe('resolveRelatedTargets — one hop, and only one', () => {
  test('a CASE resolves to itself plus its related CONTACTS', async () => {
    const db = makeDb({
      rows: [],
      relate: [
        { rel_id: 1001, rel_type: 'Primary' },
        { rel_id: 1139, rel_type: 'Secondary' },
      ],
    });
    const { targets } = await documentSvc.resolveRelatedTargets(db, 'case', 'aB3xY9');

    expect(targets).toEqual([
      { link_type: 'case',    link_id: 'aB3xY9', direct: true },
      { link_type: 'contact', link_id: '1001', relate_type: 'Primary' },
      { link_type: 'contact', link_id: '1139', relate_type: 'Secondary' },
    ]);
  });

  test('a CONTACT resolves to itself plus its related CASES', async () => {
    const db = makeDb({
      rows: [],
      relate: [{ rel_id: 'hjSFMabb', rel_type: 'Primary' }],
    });
    const { targets } = await documentSvc.resolveRelatedTargets(db, 'contact', '1001');

    expect(targets).toEqual([
      { link_type: 'contact', link_id: '1001', direct: true },
      { link_type: 'case', link_id: 'hjSFMabb', relate_type: 'Primary' },
    ]);
  });

  test('contact ids are STRINGIFIED to match document_links.link_id', async () => {
    // link_id is one polymorphic VARCHAR holding both a case's random string
    // id and a contact's integer. A number here would never equal the stored
    // text under a row-constructor IN.
    const db = makeDb({ rows: [], relate: [{ rel_id: 1001, rel_type: 'Primary' }] });
    const { targets } = await documentSvc.resolveRelatedTargets(db, 'case', 'X');
    expect(targets[1].link_id).toBe('1001');
    expect(typeof targets[1].link_id).toBe('string');
  });

  test('THE COLLATION TRAP: the contact hop binds an INT, and never casts', async () => {
    const db = makeDb({ rows: [], relate: [] });
    await documentSvc.resolveRelatedTargets(db, 'contact', '1001');

    const q = db.find('FROM case_relate');
    expect(q.sql).toContain('WHERE case_relate_client_id = ?');
    // A NUMBER, so it hits idx_case_relate_client rather than forcing a
    // string→int conversion on every row.
    expect(q.params).toEqual([1001]);
    // No CAST anywhere. If one ever appears it needs an explicit
    // COLLATE utf8mb4_general_ci or the query dies — see the describe header.
    expect(q.sql).not.toMatch(/CAST|CONVERT/i);
  });

  test('a non-numeric contact id has no related cases, and does not throw', async () => {
    const db = makeDb({ rows: [], relate: [] });
    const { targets } = await documentSvc.resolveRelatedTargets(db, 'contact', 'not-an-id');
    expect(targets).toEqual([
      { link_type: 'contact', link_id: 'not-an-id', direct: true },
    ]);
    expect(db.find('FROM case_relate')).toBeUndefined();
  });

  test('an unrecognised link_type expands to itself and queries nothing', async () => {
    const db = makeDb({ rows: [], relate: [] });
    const { targets } = await documentSvc.resolveRelatedTargets(db, 'matter', 'Z1');
    expect(targets).toEqual([{ link_type: 'matter', link_id: 'Z1', direct: true }]);
    expect(db.calls.length).toBe(0);
  });

  test('a hop that duplicates the direct target is dropped, not double-matched', async () => {
    // A duplicate pair would fan the JOIN out again and inflate nothing but
    // the work; the GROUP BY would hide it, which is exactly why it is caught
    // here instead.
    const db = makeDb({
      rows: [],
      relate: [{ rel_id: 1001, rel_type: 'Primary' }, { rel_id: 1001, rel_type: 'Other' }],
    });
    const { targets } = await documentSvc.resolveRelatedTargets(db, 'case', 'aB3xY9');
    expect(targets.filter(t => t.link_id === '1001').length).toBe(1);
  });

  test('the target set is CAPPED, and says so rather than silently shortening', async () => {
    const many = Array.from({ length: documentSvc.RELATED_TARGET_CAP + 50 },
      (_, i) => ({ rel_id: 5000 + i, rel_type: 'Other' }));
    const db = makeDb({ rows: [], relate: many });
    const { targets, truncated } = await documentSvc.resolveRelatedTargets(db, 'case', 'aB3xY9');

    expect(truncated).toBe(true);
    expect(targets.length).toBe(documentSvc.RELATED_TARGET_CAP);
    // The DIRECT target is element 0 and therefore can never be the one cut —
    // a truncated related view must still be a correct direct view.
    expect(targets[0]).toEqual({ link_type: 'case', link_id: 'aB3xY9', direct: true });
  });

  test('a normal-sized set is not flagged', async () => {
    const db = makeDb({ rows: [], relate: [{ rel_id: 1001, rel_type: 'Primary' }] });
    const { truncated } = await documentSvc.resolveRelatedTargets(db, 'case', 'aB3xY9');
    expect(truncated).toBe(false);
  });
});

describe('list — related expansion', () => {
  /** A scoped related list over one page of documents. */
  async function relList(opts, fixtures = {}) {
    const db = makeDb({ rows: [], ...fixtures });
    const out = await documentSvc.list(db, { related: 1, ...opts });
    // 0 = case_relate resolve, 1 = page, 2 = count, 3+ = via/labels
    return { db, out, page: db.find('SELECT d.*'), count: db.find('COUNT(') };
  }

  test('CASE scope matches the case OR any related contact, as a flat target set', async () => {
    const { page } = await relList(
      { link_type: 'case', link_id: 'aB3xY9' },
      { relate: [{ rel_id: 1001, rel_type: 'Primary' }] },
    );
    expect(page.sql).toContain('(dl.link_type, dl.link_id) IN ((?, ?), (?, ?))');
    expect(page.params.slice(0, 4)).toEqual(['case', 'aB3xY9', 'contact', '1001']);
  });

  test('CONTACT scope matches the contact OR any related case', async () => {
    const { page } = await relList(
      { link_type: 'contact', link_id: '1001' },
      { relate: [{ rel_id: 'hjSFMabb', rel_type: 'Primary' }] },
    );
    expect(page.params.slice(0, 4)).toEqual(['contact', '1001', 'case', 'hjSFMabb']);
  });

  test('ONE HOP IS STRUCTURAL: case_relate never appears in the document query', async () => {
    // THE test for the boundary. A contact's OTHER cases cannot appear on a
    // case view, and a case's other contacts' other cases cannot appear on a
    // contact view, because the document query holds a FLAT LIST OF TARGETS
    // and has no join to traverse. Asserting the absence of the table is
    // stronger than asserting the absence of a row: a shape that cannot reach
    // stays unreachable when someone edits the predicate later.
    const { db } = await relList(
      { link_type: 'case', link_id: 'aB3xY9' },
      { relate: [{ rel_id: 1001, rel_type: 'Primary' }] },
    );
    const docQueries = db.calls.filter(c => /FROM documents d/.test(c.sql));
    expect(docQueries.length).toBe(2);                    // page + count
    for (const q of docQueries) {
      expect(q.sql).not.toMatch(/case_relate/);
      expect(q.sql).not.toMatch(/SELECT[\s\S]*SELECT/);   // no subquery at all
    }
  });

  test('the ROW CONSTRUCTOR form is used, not two independent IN lists', async () => {
    // `link_type IN (…) AND link_id IN (…)` cross-multiplies: it would match a
    // CASE id carried under link_type 'contact'. It also cannot drive a range
    // scan on idx_dl_target(link_type, link_id).
    const { page } = await relList(
      { link_type: 'case', link_id: 'aB3xY9' },
      { relate: [{ rel_id: 1001, rel_type: 'Primary' }] },
    );
    expect(page.sql).toContain('(dl.link_type, dl.link_id) IN (');
    expect(page.sql).not.toMatch(/dl\.link_type IN \(/);
    expect(page.sql).not.toMatch(/dl\.link_id IN \(/);
  });

  test('the page DEDUPES and the count agrees with it', async () => {
    const { page, count } = await relList(
      { link_type: 'case', link_id: 'aB3xY9' },
      { relate: [{ rel_id: 1001, rel_type: 'Primary' }] },
    );
    expect(page.sql).toContain('GROUP BY d.id');
    expect(count.sql).toContain('COUNT(DISTINCT d.id)');
    // Same filters, same params — a count that drifts from the page is a lie.
    expect(count.params).toEqual(page.params);
  });

  test('the NON-related scoped path is untouched: no GROUP BY, plain COUNT(*)', async () => {
    // The hot path. The direct join rides a UNIQUE key and cannot fan out, so
    // a temp table there would be pure cost.
    const db = makeDb({ rows: [] });
    await documentSvc.list(db, { link_type: 'case', link_id: 'aB3xY9' });

    expect(db.sqlAt(0)).toContain('JOIN document_links dl ON dl.document_id = d.id AND dl.link_type = ?');
    expect(db.sqlAt(0)).not.toContain('GROUP BY');
    expect(db.sqlAt(1)).toContain('COUNT(*)');
    expect(db.sqlAt(1)).not.toContain('DISTINCT');
    expect(db.find('FROM case_relate')).toBeUndefined();
  });

  test('`related` WITHOUT a scope is IGNORED — it is not an error', async () => {
    // The UI leaves the toggle checked when it moves out of scoped mode.
    const db = makeDb({ rows: [] });
    const out = await documentSvc.list(db, { related: 1 });

    expect(db.find('FROM case_relate')).toBeUndefined();
    expect(db.sqlAt(0)).not.toContain('document_links');
    expect(out.related).toBeUndefined();
  });

  test("related='0' and 'false' are OFF — a query string has no booleans", async () => {
    for (const v of ['0', 'false']) {
      const db = makeDb({ rows: [] });
      const out = await documentSvc.list(db, { link_type: 'case', link_id: 'X', related: v });
      expect(out.related).toBeUndefined();
      expect(db.find('FROM case_relate')).toBeUndefined();
    }
  });

  test('the response flags related, and flags truncation only when it happened', async () => {
    const { out } = await relList(
      { link_type: 'case', link_id: 'aB3xY9' },
      { relate: [{ rel_id: 1001, rel_type: 'Primary' }] },
    );
    expect(out.related).toBe(true);
    expect(out.related_truncated).toBeUndefined();

    const many = Array.from({ length: documentSvc.RELATED_TARGET_CAP + 5 },
      (_, i) => ({ rel_id: 5000 + i, rel_type: 'Other' }));
    const big = await relList({ link_type: 'case', link_id: 'aB3xY9' }, { relate: many });
    expect(big.out.related_truncated).toBe(true);
  });

  test('other filters still apply on top of the expansion', async () => {
    const { page } = await relList(
      { link_type: 'case', link_id: 'aB3xY9', ext: 'pdf', status: 'all' },
      { relate: [{ rel_id: 1001, rel_type: 'Primary' }] },
    );
    expect(page.sql).toContain('d.ext = ?');
    expect(page.sql).not.toContain('d.status = ?');
  });
});

describe('list — `via`', () => {
  const doc = (id) => ({ id, name: `f${id}.pdf`, status: 'active' });

  /** A related list whose page returns `docs`, with via/label fixtures. */
  async function withVia(docs, fixtures) {
    const db = makeDb({ rows: docs, ...fixtures });
    const out = await documentSvc.list(db, {
      link_type: 'case', link_id: 'aB3xY9', related: 1,
    });
    return { db, out };
  }

  test('a DIRECT match is flagged direct and carries no relate type', async () => {
    const { out } = await withVia([doc(7)], {
      relate:   [{ rel_id: 1001, rel_type: 'Primary' }],
      viaLinks: [{ document_id: 7, link_type: 'case', link_id: 'aB3xY9' }],
      caseLabels: [{ case_id: 'aB3xY9', label: '25-04172-prh' }],
      contactLabels: [{ contact_id: 1001, label: 'Ross, Fred' }],
    });
    expect(out.documents[0].via).toEqual([
      { link_type: 'case', link_id: 'aB3xY9', label: '25-04172-prh', direct: true },
    ]);
  });

  test('a HOP match carries the label AND the case_relate_type that reached it', async () => {
    const { out } = await withVia([doc(9)], {
      relate:   [{ rel_id: 1001, rel_type: 'Secondary' }],
      viaLinks: [{ document_id: 9, link_type: 'contact', link_id: '1001' }],
      caseLabels: [{ case_id: 'aB3xY9', label: '25-04172-prh' }],
      contactLabels: [{ contact_id: 1001, label: 'Ross, Fred' }],
    });
    expect(out.documents[0].via).toEqual([
      { link_type: 'contact', link_id: '1001', label: 'Ross, Fred', relate_type: 'Secondary' },
    ]);
  });

  test('a document matched BOTH ways lists both, DIRECT FIRST', async () => {
    // A document the user owns outright should not be badged as if it arrived
    // sideways, so the direct entry leads and the UI can stop reading there.
    const { out } = await withVia([doc(7)], {
      relate:   [{ rel_id: 1001, rel_type: 'Primary' }],
      viaLinks: [
        { document_id: 7, link_type: 'contact', link_id: '1001' },
        { document_id: 7, link_type: 'case',    link_id: 'aB3xY9' },
      ],
      caseLabels: [{ case_id: 'aB3xY9', label: '25-04172-prh' }],
      contactLabels: [{ contact_id: 1001, label: 'Ross, Fred' }],
    });
    const via = out.documents[0].via;
    expect(via.length).toBe(2);
    expect(via[0].direct).toBe(true);
    expect(via[1]).toMatchObject({ link_type: 'contact', relate_type: 'Primary' });
  });

  test('the via query is bounded by BOTH the page ids and the target set', async () => {
    const { db } = await withVia([doc(7), doc(9)], {
      relate:   [{ rel_id: 1001, rel_type: 'Primary' }],
      viaLinks: [],
    });
    const q = db.find('SELECT dl.document_id');
    expect(q.sql).toContain('WHERE dl.document_id IN (?)');
    expect(q.sql).toContain('(dl.link_type, dl.link_id) IN ((?, ?), (?, ?))');
    expect(q.params[0]).toEqual([7, 9]);
  });

  test('GROUP_CONCAT is NOT used — group_concat_max_len truncates silently', async () => {
    // 1024 bytes on this server, and no STRICT_TRANS_TABLES to turn the
    // overflow into an error. A chopped pair parses as a plausible target that
    // does not exist. Same silent-truncation class _clamp exists to keep out.
    const { db } = await withVia([doc(7)], { relate: [], viaLinks: [] });
    expect(db.calls.every(c => !/GROUP_CONCAT/i.test(c.sql))).toBe(true);
  });

  test('labels are resolved over the TARGET SET, not per row', async () => {
    // The set is bounded by RELATED_TARGET_CAP and is single-digit in
    // practice, so label cost is flat in page size: at most one query per type.
    const { db } = await withVia([doc(1), doc(2), doc(3), doc(4)], {
      relate:   [{ rel_id: 1001, rel_type: 'Primary' }],
      viaLinks: [
        { document_id: 1, link_type: 'contact', link_id: '1001' },
        { document_id: 2, link_type: 'contact', link_id: '1001' },
        { document_id: 3, link_type: 'case',    link_id: 'aB3xY9' },
        { document_id: 4, link_type: 'case',    link_id: 'aB3xY9' },
      ],
      caseLabels: [{ case_id: 'aB3xY9', label: '25-04172-prh' }],
      contactLabels: [{ contact_id: 1001, label: 'Ross, Fred' }],
    });
    expect(db.all('FROM cases WHERE case_id IN').length).toBe(1);
    expect(db.all('FROM contacts WHERE contact_id IN').length).toBe(1);
  });

  test('an UNLABELLED target falls back to its raw id, never to nothing', async () => {
    // A missing badge is a document whose provenance the user cannot see; an
    // ugly badge is an ugly badge.
    const { out } = await withVia([doc(7)], {
      relate:   [{ rel_id: 1001, rel_type: 'Primary' }],
      viaLinks: [{ document_id: 7, link_type: 'contact', link_id: '1001' }],
      contactLabels: [],
    });
    expect(out.documents[0].via[0].label).toBe('1001');
  });

  test('every row gets a via array, even one that matched nothing resolvable', async () => {
    const { out } = await withVia([doc(7)], { relate: [], viaLinks: [] });
    expect(out.documents[0].via).toEqual([]);
  });

  test('a link OUTSIDE the target set cannot leak into via', async () => {
    // Defensive: the query already scopes it, but a via entry naming a target
    // the user never asked about would be a disclosure, not a display bug.
    const { out } = await withVia([doc(7)], {
      relate:   [{ rel_id: 1001, rel_type: 'Primary' }],
      viaLinks: [{ document_id: 7, link_type: 'case', link_id: 'SOMEONE-ELSE' }],
    });
    expect(out.documents[0].via).toEqual([]);
  });

  test('NO via queries run when related is off', async () => {
    const db = makeDb({ rows: [doc(7)] });
    const out = await documentSvc.list(db, { link_type: 'case', link_id: 'aB3xY9' });
    expect(db.find('SELECT dl.document_id')).toBeUndefined();
    expect(out.documents[0].via).toBeUndefined();
  });

  test('an EMPTY page skips the via LINK query but still resolves labels', async () => {
    // The link query is per-row work and there are no rows. The LABELS are
    // not: they belong to the target set, which the client needs as
    // `related_targets` regardless of whether anything is on screen — an empty
    // case is exactly the view that must still hear "a document was linked to
    // your client". Two tiny indexed lookups, once.
    const db = makeDb({ rows: [], relate: [{ rel_id: 1001, rel_type: 'Primary' }] });
    await documentSvc.list(db, { link_type: 'case', link_id: 'aB3xY9', related: 1 });

    expect(db.find('SELECT dl.document_id')).toBeUndefined();
    expect(db.all('FROM cases WHERE case_id IN').length).toBe(1);
    expect(db.all('FROM contacts WHERE contact_id IN').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// S3.1 — reconcilePathLinks
//
// MACHINE LINKS TRACK THE FILESYSTEM; HUMAN LINKS EXPRESS INTENT. The scope of
// the DELETE is the whole safety property, and it has to be STRUCTURAL: a rule
// enforced by a filter someone applies afterwards is a rule someone can forget.
// ─────────────────────────────────────────────────────────────

describe('reconcilePathLinks', () => {
  async function ran(id, keep) {
    const db = makeDb({ deleteResult: { affectedRows: 1 } });
    const n = await documentSvc.reconcilePathLinks(db, id, keep);
    return { n, sql: db.sqlAt(0), params: db.paramsAt(0), db };
  }

  test('drops path-links OTHER than the new match, and keeps that one', async () => {
    const { sql, params } = await ran(7, 'caseB');
    expect(sql).toContain('DELETE FROM document_links');
    expect(sql).toContain('AND link_id <> ?');
    expect(params).toEqual([7, 'path', 'caseB']);
  });

  test('with NO new match, EVERY path-link goes', async () => {
    // The file left the case-folder tree. A stale link is worse than none.
    const { sql, params } = await ran(7, null);
    expect(sql).not.toContain('link_id <>');
    expect(params).toEqual([7, 'path']);
  });

  test('MANUAL links are out of scope IN THE STATEMENT, not filtered after', async () => {
    const { sql } = await ran(7, 'caseB');
    expect(sql).toContain("AND link_type = 'case'");
    expect(sql).toContain('AND relation = ?');       // 'path' — the engine's mark
    expect(sql).toContain('AND created_by IS NULL'); // the engine has no user
  });

  test('CONTACT links are never touched — path attribution is case attribution', async () => {
    const { sql } = await ran(7, 'caseB');
    expect(sql).not.toContain("link_type = 'contact'");
    expect(sql).toContain("link_type = 'case'");
  });

  test('returns the number actually removed', async () => {
    const db = makeDb({ deleteResult: { affectedRows: 3 } });
    expect(await documentSvc.reconcilePathLinks(db, 7, null)).toBe(3);
  });

  test('emits NOTHING — there is no document.unlinked event type', async () => {
    const db = makeDb({ deleteResult: { affectedRows: 2 } });
    await documentSvc.reconcilePathLinks(db, 7, 'caseB');
    expect(emit).not.toHaveBeenCalled();
  });

  test('a missing document id is a no-op, never a table-wide DELETE', async () => {
    const db = makeDb({});
    expect(await documentSvc.reconcilePathLinks(db, 0, null)).toBe(0);
    expect(await documentSvc.reconcilePathLinks(db, null, null)).toBe(0);
    expect(db.calls.length).toBe(0);
  });

  test('an empty-string keep is treated as NO match, not as a keep of ""', async () => {
    const { sql } = await ran(7, '');
    expect(sql).not.toContain('link_id <>');
  });

  test('the keep id is clamped on the way into SQL', async () => {
    const { params } = await ran(7, 'x'.repeat(200));
    expect(params[2].length).toBe(documentSvc.COLUMN_LIMITS.link_id);
  });
});

describe('list — related_targets (the bus address set)', () => {
  test('the labelled target set comes back, direct entry included and flagged', async () => {
    const db = makeDb({
      rows: [],
      relate: [{ rel_id: 1001, rel_type: 'Primary' }],
      caseLabels:    [{ case_id: 'aB3xY9', label: '25-04172-prh' }],
      contactLabels: [{ contact_id: 1001, label: 'Ross, Fred' }],
    });
    const out = await documentSvc.list(db, {
      link_type: 'case', link_id: 'aB3xY9', related: 1,
    });

    expect(out.related_targets).toEqual([
      { link_type: 'case', link_id: 'aB3xY9', label: '25-04172-prh', direct: true },
      { link_type: 'contact', link_id: '1001', label: 'Ross, Fred', relate_type: 'Primary' },
    ]);
  });

  test('it is present even on an EMPTY page — that is when it matters most', async () => {
    // A case with no documents yet is exactly the view that must still hear
    // "a document was just linked to your client", or the row never appears.
    const db = makeDb({
      rows: [],
      relate: [{ rel_id: 1001, rel_type: 'Primary' }],
      contactLabels: [{ contact_id: 1001, label: 'Ross, Fred' }],
    });
    const out = await documentSvc.list(db, {
      link_type: 'case', link_id: 'aB3xY9', related: 1,
    });
    expect(out.documents).toEqual([]);
    expect(out.related_targets.length).toBe(2);
  });

  test('an unlabelled target still yields an address, falling back to its id', async () => {
    const db = makeDb({ rows: [], relate: [{ rel_id: 1001, rel_type: 'Primary' }] });
    const out = await documentSvc.list(db, {
      link_type: 'case', link_id: 'aB3xY9', related: 1,
    });
    expect(out.related_targets.map(t => t.label)).toEqual(['aB3xY9', '1001']);
  });

  test('absent when related is off', async () => {
    const db = makeDb({ rows: [] });
    const out = await documentSvc.list(db, { link_type: 'case', link_id: 'aB3xY9' });
    expect(out.related_targets).toBeUndefined();
  });
});
