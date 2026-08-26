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
function makeDb({ row = null, after = undefined, insertResult, updateResult, deleteResult, rows, linkDuplicate = false } = {}) {
  const calls = [];
  let selectCount = 0;

  return {
    calls,
    /** SQL of the Nth query, whitespace-collapsed. */
    sqlAt: (n) => calls[n].sql,
    paramsAt: (n) => calls[n].params,
    find: (needle) => calls.find((c) => c.sql.includes(needle)),
    query: async (sql, params) => {
      const flat = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: flat, params: params || [] });

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
});
