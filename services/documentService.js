// services/documentService.js
//
/**
 * Document Service — registry layer over `documents` / `document_links`
 * services/documentService.js
 *
 * Pure DB module. Every exported fn takes the mysql2 pool/connection as its
 * FIRST argument. No Dropbox, no GCS, no req/res, no Express — storage lives
 * behind services/documentSourceService.js; this module only manages rows.
 * (Same shape as services/assetService.js, which is the model for this file.)
 *
 * ── WHY external_id AND NOT path ──────────────────────────────────────────
 * `documents.external_id` holds the provider's move/rename-stable handle —
 * for Dropbox, the "id:…" handle. Firm staff move and rename constantly
 * (Active Cases → Closed Cases at case close is routine), so a path-keyed
 * registry would orphan itself on the first drag. `path` / `path_lower` are
 * therefore a CACHE of where the file was last seen, not an identity.
 *
 * ── SILENT TRUNCATION ─────────────────────────────────────────────────────
 * This DB's sql_mode has NO STRICT_TRANS_TABLES (verified 2026-08-26:
 * IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,
 * NO_ENGINE_SUBSTITUTION). An over-length write does not error — it silently
 * truncates. Every string that reaches SQL from here goes through _clamp()
 * against COLUMN_LIMITS first, so the truncation (when it must happen) is
 * ours, is codepoint-accurate, and is visible in this file.
 *
 * Dropbox path_display values run long — a deep case folder plus a scanned
 * filename passes 512 chars routinely — which is exactly why `path` and
 * `path_lower` are TEXT and not VARCHAR: they are NOT clamped, because
 * clamping them would corrupt the path silently. `name` IS clamped (512),
 * because Dropbox itself caps a single component well under that.
 *
 * ── TIMEZONE ──────────────────────────────────────────────────────────────
 * The pool runs timezone:'Z'. Dropbox `server_modified` is UTC. _toMysqlDT
 * writes the UTC wall clock as a naive DATETIME, so the column reads back as
 * the same instant under the pool's fake-UTC convention.
 *
 * Exports:
 *   upsertFromEntry(db, source, entry, opts) -> { row, created }
 *   bulkUpsertEntries(db, source, entries)   -> { rows }   BACKFILL ONLY, no events
 *   bulkLink(db, links)                      -> { rows }   BACKFILL ONLY, no events
 *   mapExternalIds(db, source, externalIds)  -> Map
 *   getById(db, id)                          -> row|null
 *   getByExternal(db, source, externalId)    -> row|null
 *   list(db, opts)                           -> { documents, total, limit, offset }
 *   update(db, id, fields, opts)             -> row|null
 *   setSharedLink(db, id, url)               -> string|null
 *   link(db, documentId, type, id, opts)     -> { linked, created, row }
 *   unlink(db, documentId, type, id)         -> boolean
 *   reconcilePathLinks(db, documentId, keep) -> number   S3.1, engine-owned links
 *   listLinks(db, documentId)                -> row[]
 *   listForTarget(db, linkType, linkId, opts)-> row[]
 *   resolveRelatedTargets(db, type, id)      -> { targets, truncated }
 *   markDeletedByPath(db, source, pathLower) -> number
 */

'use strict';

const crypto        = require('crypto');
const domainEvents  = require('../lib/domainEvents');
const { normalizeTags } = require('./assetService');

// ─────────────────────────────────────────────────────────────
// Column limits (CHARACTERS, matching MySQL's VARCHAR semantics).
// `path` / `path_lower` are TEXT and deliberately absent — see the header.
// ─────────────────────────────────────────────────────────────
const COLUMN_LIMITS = {
  source:      20,
  external_id: 191,
  name:        512,
  ext:         20,
  mime:        128,
  rev:         64,
  shared_link: 512,
  title:       255,
  doc_type:    64,
  tags:        512,
  // document_links
  link_type:   32,
  link_id:     64,
  relation:    32,
};

const STATUSES = new Set(['active', 'deleted', 'missing']);

/**
 * Link types `list({ unlinked })` will anti-join on (S3.2).
 *
 * A SET rather than a boolean because "unlinked" is not one question. Today the
 * triage view asks about CASE ownership; "no contact link" is a different and
 * equally reasonable question, and a boolean would have to be replaced rather
 * than extended to ask it. An allow-list also keeps a caller-supplied string
 * off the `link_type` predicate, which is the other half of why this is a Set
 * and not a passthrough.
 */
const UNLINKED_KINDS = new Set(['case']);

// All sortable columns are whitelisted; user-supplied `sort` only ever indexes
// this map, never reaches SQL directly. (Model: assetService.SORT_MAP.)
//
// DEVIATION from assetService, deliberate: newest/oldest sort on `updated_at`,
// not `created_at`. It is the only sortable timestamp with an index
// (idx_docs_updated), and a filesort over ~150k rows is the difference between
// a list endpoint and an outage. NOTE for whoever builds the S3 UI: right
// after S2's backfill every row shares one updated_at, so "newest" is
// meaningless until natural churn — if the UI wants true file recency, add a
// 'modified' key on server_modified (and an index for it) rather than
// repointing these.
//
// S3 TOOK THAT ADVICE, AND DID NOT REPOINT ANYTHING. `modified` is the new key
// and it is what the S3 UI defaults to; `newest`/`oldest` still mean "when the
// REGISTRY last touched this row" and are still the right sort for anyone
// asking that question (a sync audit, say). The two are genuinely different
// facts and collapsing them would lose one:
//
//   updated_at       when WE last wrote the row     — post-backfill, one value
//                                                     shared by ~150k rows
//   server_modified  when DROPBOX last wrote the    — the file's own recency,
//                    file                             which is what staff mean
//
// NULLS LAST, explicitly. MySQL sorts NULL low, so a bare `DESC` would put
// every server_modified-less row (a provider that did not report one) at the
// TOP of a newest-first list — the loudest possible position for the least
// informative rows. `(x IS NULL) ASC` is the same idiom `size` already uses.
// `d.id DESC` is the tiebreak: without it, rows sharing a timestamp have no
// stable order and page 2 can repeat a row from page 1.
//
// Needs idx_docs_modified (server_modified) or this is a filesort over the
// whole table — see the S3 DDL.
const SORT_MAP = {
  newest:   'd.updated_at DESC, d.id DESC',
  oldest:   'd.updated_at ASC, d.id ASC',
  name:     'd.name ASC, d.id ASC',
  size:     '(d.size IS NULL) ASC, d.size DESC, d.id DESC',
  modified: '(d.server_modified IS NULL) ASC, d.server_modified DESC, d.id DESC',
};

// MySQL's innodb_ft_min_token_size on this server is 3 (verified 2026-08-26),
// so a FULLTEXT term shorter than this can never match anything.
const FT_MIN_TOKEN = 3;

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

/**
 * Clamp a value to `n` CHARACTERS (codepoints), null-safe.
 *
 * String.prototype.slice counts UTF-16 code units, so a naive slice can split
 * a surrogate pair and store half an emoji. Array.from iterates codepoints,
 * which is exactly how MySQL counts a utf8mb4 VARCHAR — so this clamp and the
 * column agree. The fast path (already short enough) avoids the array build.
 */
function _clamp(v, n) {
  if (v == null) return null;
  const s = String(v);
  if (s.length <= n) return s;           // length in code units >= codepoints
  return Array.from(s).slice(0, n).join('');
}

/** Clamp against COLUMN_LIMITS by column name. Unknown column = programming error. */
function _col(name, v) {
  const n = COLUMN_LIMITS[name];
  if (n == null) throw new Error(`documentService: no column limit for '${name}'`);
  return _clamp(v, n);
}

function _sha1(s) {
  return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');
}

/**
 * Escape LIKE metacharacters so user/path input matches LITERALLY. Order
 * matters — escape the escape char first. This server's sql_mode does NOT
 * include NO_BACKSLASH_ESCAPES, so MySQL's default '\' escape is active and
 * no explicit ESCAPE clause is needed. (Same idiom as assetService.list.)
 */
function _escapeLike(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/[%_]/g, '\\$&');
}

/**
 * Provider timestamp → naive 'YYYY-MM-DD HH:MM:SS' for a DATETIME column.
 * Dropbox sends ISO-8601 Zulu ("2024-08-14T20:57:32Z"); handing that to MySQL
 * raw relies on lenient parsing of the trailing 'Z', which without strict mode
 * truncates silently instead of erroring. Normalize here instead.
 */
function _toMysqlDT(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 19).replace('T', ' ');
  }
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(s);
  if (m) return `${m[1]} ${m[2]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * File extension from a name: lowercased, no dot, alphanumeric only.
 * Dotfiles (".gitignore"), trailing dots, and "report.final version" all
 * yield null rather than a junk ext.
 */
function _extOf(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return null;
  const ext = s.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,20}$/.test(ext) ? ext : null;
}

function _toIntOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * The projection that goes into a trigger envelope's `data`.
 *
 * NOT the whole row, on purpose. Envelopes persist into trigger_executions
 * for 30–90 days, readable by any staff JWT/API key and the readonly SQL
 * endpoint — and `shared_link` is a PERMANENT PUBLIC URL to a client document.
 * Replicating it into a second long-lived table is a leak amplifier for zero
 * rule-authoring benefit. `ai_meta` is excluded for size. This projection is
 * the contract published in triggerService.EVENT_TYPES; keep the two in sync.
 */
function _eventData(row) {
  if (!row) return null;
  return {
    id:          row.id,
    source:      row.source,
    external_id: row.external_id,
    name:        row.name,
    path:        row.path,
    doc_type:    row.doc_type,
    tags:        row.tags,
    status:      row.status,
  };
}

/** Thread actor/source into an envelope only when a caller actually supplied them. */
function _attribution({ eventSource = null, actorUserId = null } = {}) {
  return {
    ...(eventSource != null ? { source: eventSource } : {}),
    ...(actorUserId != null ? { actor: { user_id: actorUserId } } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────

/** @returns {Promise<object|null>} */
async function getById(db, id) {
  const [rows] = await db.query('SELECT * FROM documents WHERE id = ?', [id]);
  return rows.length ? rows[0] : null;
}

/** @returns {Promise<object|null>} */
async function getByExternal(db, source, externalId) {
  const [rows] = await db.query(
    'SELECT * FROM documents WHERE source = ? AND external_id = ?',
    [_col('source', source), _col('external_id', externalId)],
  );
  return rows.length ? rows[0] : null;
}

// ─────────────────────────────────────────────────────────────
// upsertFromEntry
// ─────────────────────────────────────────────────────────────

// Columns whose change is worth an event. Everything else about a file can
// churn (server_modified ticks on a touch, size on a re-save that keeps the
// same rev is impossible, content_hash moves in lockstep with rev) without a
// rule author caring.
const MEANINGFUL_KEYS = ['rev', 'path_lower', 'name', 'status'];

/**
 * Provider entry → the exact column values that reach SQL.
 *
 * ── WHY THIS IS A SEPARATE FUNCTION ───────────────────────────────────────
 * TWO write paths reach the `documents` table with the same semantics:
 * upsertFromEntry (one row, reads-then-writes, emits) and bulkUpsertEntries
 * (many rows, no reads, never emits). If each derived its own columns they
 * would drift — someone fixes a clamp in one and the backfill keeps writing
 * the old shape, silently, on a schema with no STRICT_TRANS_TABLES. Both
 * call THIS, so "identical column semantics" is structural rather than a
 * promise in a comment (tests/documentService.test.js asserts it anyway).
 *
 * Validation lives here too, and it THROWS rather than skipping: a registry
 * that silently drops a file it could not parse is worse than one that stops
 * loudly. The sync engine's per-page error handling turns a throw into a
 * recorded last_error + alert with the cursor un-advanced.
 *
 * @param {string} source
 * @param {object} entry  Dropbox FileMetadata-shaped
 * @returns {{src: string, extId: string, next: object}}
 */
function _entryColumns(source, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('documentService: entry is required');
  }
  if (!entry.id)   throw new Error('documentService: entry.id is required');
  if (!entry.name) throw new Error('documentService: entry.name is required');

  const src       = _col('source', source || 'dropbox');
  const extId     = _col('external_id', entry.id);
  const pathDisp  = entry.path_display != null ? String(entry.path_display) : null;
  const pathLower = entry.path_lower   != null ? String(entry.path_lower)   : null;

  return {
    src,
    extId,
    next: {
      name:            _col('name', entry.name),
      path:            pathDisp,
      path_lower:      pathLower,
      path_hash:       pathLower ? _sha1(pathLower) : null,
      ext:             _col('ext', _extOf(entry.name)),
      mime:            _col('mime', entry.mime ?? null),
      size:            entry.size == null ? null : _toIntOrNull(entry.size),
      content_hash:    _clamp(entry.content_hash ?? null, 64),
      rev:             _col('rev', entry.rev ?? null),
      server_modified: _toMysqlDT(entry.server_modified),
      status:          'active',
    },
  };
}

/** Positional parameter tuple for the documents upsert — ONE definition, both paths. */
function _entryParams(src, extId, next) {
  return [
    src, extId, next.name, next.path, next.path_lower, next.path_hash,
    next.ext, next.mime, next.size, next.content_hash, next.rev,
    next.server_modified, next.status,
  ];
}

const DOC_UPSERT_COLUMNS =
  '(source, external_id, name, path, path_lower, path_hash, ext, mime, ' +
  'size, content_hash, rev, server_modified, status)';

// The ON DUPLICATE KEY UPDATE clause, shared verbatim. Row-alias form
// (MySQL 8.0.19+; this DB is 8.4) so the table stays referenceable by name —
// which is how `mime` preserves an existing value when the entry has none.
// HUMAN/AI-owned columns (title, doc_type, tags, ai_meta, shared_link) are
// ABSENT on purpose: a re-sync must never wipe a staffer's classification.
const DOC_UPSERT_ON_DUP = `
       name            = new.name,
       path            = new.path,
       path_lower      = new.path_lower,
       path_hash       = new.path_hash,
       ext             = new.ext,
       mime            = COALESCE(new.mime, documents.mime),
       size            = new.size,
       content_hash    = new.content_hash,
       rev             = new.rev,
       server_modified = new.server_modified,
       status          = new.status`;

/**
 * Insert-or-update one document row from a provider listing/stat entry.
 *
 * `entry` is Dropbox FileMetadata-SHAPED — { id, name, path_display,
 * path_lower, size, content_hash, rev, server_modified } — because that is
 * the shape S2's list_folder/continue delta feed hands over unmodified. A
 * future provider adapts its own metadata into this shape rather than this
 * function growing per-source branches.
 *
 * Upserts on the (source, external_id) unique key. Provider-owned columns are
 * overwritten; HUMAN/AI-owned columns (title, doc_type, tags, ai_meta,
 * shared_link) are never touched here — a re-sync must not wipe a staffer's
 * classification. `mime` is COALESCEd: written when the entry supplies one
 * (Dropbox does not; a future provider might), preserved otherwise.
 *
 * A row that had been marked deleted/missing and re-appears goes back to
 * 'active' — that is a meaningful change and does emit.
 *
 * EMISSIONS (post-write, fire-and-forget):
 *   insert                       -> 'document.created'
 *   update with a real change    -> 'document.updated' (+ changes map)
 *   update with nothing changed  -> NOTHING
 *
 * ── WHY opts.emit EXISTS ──────────────────────────────────────────────────
 * S2's backfill upserts ~150k rows in one pass. Every one of those would
 * otherwise be a root domain event: triggerService.processEvent, a rule scan,
 * and a trigger_executions row apiece. That is not a slow backfill, it is a
 * trigger-engine outage and a table the size of the backfill. So the backfill
 * passes { emit: false } and the events stay for real, incremental change.
 *
 * @param {object} db
 * @param {string} source              documents.source ('dropbox')
 * @param {object} entry               provider metadata (Dropbox-shaped)
 * @param {object} [opts]
 * @param {boolean}[opts.emit=true]    false = suppress domain events (backfill)
 * @param {string} [opts.eventSource]  envelope `source` (e.g. 'manual', 'system')
 * @param {number} [opts.actorUserId]  envelope actor.user_id
 * @returns {Promise<{row: object|null, created: boolean, changes: object}>}
 *          `changes` is the MEANINGFUL_KEYS diff — `{}` on an insert, and
 *          populated regardless of `emit` (S3.1: the sync's move reconciler
 *          reads changes.path_lower). See the note at its assignment.
 */
async function upsertFromEntry(db, source, entry, opts = {}) {
  const { emit = true } = opts;

  const { src, extId, next } = _entryColumns(source, entry);

  // Prior row drives BOTH the created/updated decision and the changes map.
  // affectedRows on an upsert (0/1/2) cannot tell "inserted" from "updated
  // with a change" reliably enough to hang an event on, and carries no diff.
  const prior = await getByExternal(db, src, extId);

  await db.query(
    `INSERT INTO documents
       ${DOC_UPSERT_COLUMNS}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE${DOC_UPSERT_ON_DUP}`,
    _entryParams(src, extId, next),
  );

  const row     = await getByExternal(db, src, extId);
  const created = !prior;

  // COMPUTED OUTSIDE THE `emit` BRANCH, and RETURNED (S3.1).
  //
  // The map used to live inside `if (emit)` because emission was its only
  // consumer. It has a second one now: documentSyncService's incremental path
  // reconciles a document's path-links when the file MOVES, and the only way
  // to know a move happened is `changes.path_lower`. Deriving that at the call
  // site would mean a second read of the prior row — the read this function
  // already paid for — so it hands the map back instead.
  //
  // buildChanges is pure and prior/next are already in hand, so computing it
  // unconditionally costs nothing measurable, and it keeps the returned shape
  // the same whether or not the caller suppressed events. `{}` on an insert:
  // there is no prior state to have changed FROM, and callers test the map for
  // a specific key rather than for emptiness.
  const changes = created
    ? {}
    : domainEvents.buildChanges(prior, next, MEANINGFUL_KEYS);

  if (emit) {
    if (created) {
      // POST-COMMIT (the INSERT above is the commit — no wrapping transaction).
      // domainEvents.emit never throws and never rejects; call it bare.
      domainEvents.emit(db, 'document.created', {
        ..._attribution(opts),
        data: _eventData(row),
      });
    } else if (Object.keys(changes).length) {
      domainEvents.emit(db, 'document.updated', {
        ..._attribution(opts),
        data: _eventData(row),
        changes,
        extra: { updated_fields: Object.keys(changes), via: 'sync' },
      });
    }
  }

  return { row, created, changes };
}

// ─────────────────────────────────────────────────────────────
// Bulk paths — BACKFILL ONLY (Documents S2)
//
// These exist for exactly one reason: upsertFromEntry costs THREE queries
// per row (prior read, upsert, post read) and the estate is ~150k files.
// 450,000 round trips inside a job runner's poll ticks is not a slow
// backfill, it is a permanently busy database. The bulk paths trade away
// the two reads — and with them, everything the reads were buying.
//
// WHAT YOU LOSE BY USING THESE, deliberately and irrecoverably:
//   - created-vs-updated detection (there is no prior row to compare)
//   - the changes map
//   - ALL EMISSIONS
// They therefore CANNOT serve the incremental path, whose whole job is to
// emit. See each function's docblock; the split is not an optimization
// waiting to be unified, it is a semantic fork.
// ─────────────────────────────────────────────────────────────

/** Rows per multi-VALUES statement. 500 × 13 params = 6,500 placeholders. */
const BULK_BATCH = 500;

/**
 * Upsert MANY document rows in multi-VALUES batches. No reads, NO EVENTS.
 *
 * Column semantics are IDENTICAL to upsertFromEntry — not "equivalent",
 * identical: both build their parameters with _entryColumns/_entryParams and
 * share DOC_UPSERT_COLUMNS / DOC_UPSERT_ON_DUP verbatim. Same clamps, same
 * _toMysqlDT, same _extOf, same path_hash, same mime COALESCE, same
 * untouched human/AI columns, same forced status 'active'.
 *
 * ── DO NOT USE THIS FOR INCREMENTAL SYNC ──────────────────────────────────
 * It cannot emit. A delta feed that ran through here would register real
 * new files and fire NOTHING — no document.created, no rule, no downstream
 * automation, and no error to say so. The incremental path calls
 * upsertFromEntry per entry and pays the three queries, because at delta
 * volumes (a handful of files per tick) three queries is nothing and the
 * event is the entire point.
 *
 * DUPLICATE ids WITHIN one call: last wins, exactly as N sequential
 * upsertFromEntry calls would resolve them. Batches execute in array order,
 * so a duplicate split across two batches resolves the same way. No dedupe
 * pass — it would be a behavioral difference from the per-row path.
 *
 * A malformed entry THROWS (via _entryColumns) and aborts the call; rows
 * from already-executed batches stay written. The caller must not advance
 * its cursor on a throw — re-running is safe (upserts are idempotent).
 *
 * @param {object} db
 * @param {string} source
 * @param {object[]} entries   provider metadata, Dropbox FileMetadata-shaped
 * @returns {Promise<{rows: number}>} entries submitted (NOT rows changed —
 *          affectedRows is uninterpretable here; see link()'s FOUND_ROWS note)
 */
async function bulkUpsertEntries(db, source, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { rows: 0 };

  let written = 0;
  for (let i = 0; i < list.length; i += BULK_BATCH) {
    const slice = list.slice(i, i + BULK_BATCH);
    const params = [];
    for (const e of slice) {
      const { src, extId, next } = _entryColumns(source, e);
      params.push(..._entryParams(src, extId, next));
    }
    const tuples = slice.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');

    await db.query(
      `INSERT INTO documents
         ${DOC_UPSERT_COLUMNS}
       VALUES ${tuples} AS new
       ON DUPLICATE KEY UPDATE${DOC_UPSERT_ON_DUP}`,
      params,
    );
    written += slice.length;
  }

  return { rows: written };
}

/**
 * Write MANY link rows in batches. Idempotent, NO EVENTS.
 *
 * ── WHY PLAIN `ON DUPLICATE KEY UPDATE id = id` IS FINE HERE, AND IS NOT
 *    FINE IN link() ─────────────────────────────────────────────────────
 * link() had to catch ER_DUP_ENTRY instead, and the long comment on that
 * function explains why: mysql2's defaultFlags include CLIENT_FOUND_ROWS and
 * this pool sets no override, so an upsert reports affectedRows 1 on BOTH
 * the insert and the duplicate branch — indistinguishable. link() needs the
 * distinction because it EMITS document.linked only for genuinely new rows,
 * and a duplicate emission is a re-fired rule.
 *
 * This function emits nothing at all. Nothing downstream asks "was it new?",
 * so the distinction it cannot make is a distinction it does not need, and
 * the cheaper statement is correct. That is the ONLY difference between the
 * two, and it is exactly why they must not be "simplified" into each other:
 * merging them either re-fires events or costs an exception per existing
 * link across ~100k backfill rows.
 *
 * @param {object} db
 * @param {Array<{document_id:number, link_type:string, link_id:string|number,
 *                relation?:string, created_by?:number}>} links
 * @returns {Promise<{rows: number}>} links submitted (see above re affectedRows)
 */
async function bulkLink(db, links) {
  const list = Array.isArray(links) ? links : [];
  if (!list.length) return { rows: 0 };

  let written = 0;
  for (let i = 0; i < list.length; i += BULK_BATCH) {
    const slice = list.slice(i, i + BULK_BATCH);
    const params = [];
    for (const l of slice) {
      if (!l || !l.document_id) throw new Error('documentService.bulkLink: document_id is required');
      if (!l.link_type)         throw new Error('documentService.bulkLink: link_type is required');
      if (l.link_id == null || l.link_id === '') {
        throw new Error('documentService.bulkLink: link_id is required');
      }
      params.push(
        l.document_id,
        _col('link_type', l.link_type),
        _col('link_id', String(l.link_id)),
        _col('relation', l.relation ?? null),
        _toIntOrNull(l.created_by ?? null),
      );
    }
    const tuples = slice.map(() => '(?, ?, ?, ?, ?)').join(', ');

    await db.query(
      `INSERT INTO document_links (document_id, link_type, link_id, relation, created_by)
       VALUES ${tuples}
       ON DUPLICATE KEY UPDATE id = id`,
      params,
    );
    written += slice.length;
  }

  return { rows: written };
}

/**
 * Resolve (source, external_id) pairs to row ids — the one read the bulk
 * backfill genuinely cannot avoid.
 *
 * A multi-row INSERT gives back no per-row ids (LAST_INSERT_ID is the first
 * of a run and says nothing about the duplicate branch), so attribution
 * after a bulk upsert needs one lookup to learn what to link. ONE query per
 * page against uq_source_ext, not one per row.
 *
 * @param {object} db
 * @param {string} source
 * @param {string[]} externalIds
 * @returns {Promise<Map<string, {id:number, path_lower:string|null}>>}
 */
async function mapExternalIds(db, source, externalIds) {
  const out = new Map();
  const ids = [...new Set((externalIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;

  const src = _col('source', source);
  for (let i = 0; i < ids.length; i += BULK_BATCH) {
    const slice = ids.slice(i, i + BULK_BATCH);
    const [rows] = await db.query(
      `SELECT id, external_id, path_lower
         FROM documents
        WHERE source = ? AND external_id IN (?)`,
      [src, slice],
    );
    for (const r of rows) out.set(r.external_id, { id: r.id, path_lower: r.path_lower });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────

/**
 * Build the `q` predicate.
 *
 * >= 3 chars  -> FULLTEXT boolean mode over ft_docs (name, title, tags).
 * shorter     -> literal prefix LIKE on name.
 *
 * The boolean-mode string is REBUILT, never passed through: a stray '+', '-',
 * '(' or '@' in a filename search is a boolean operator to MySQL and turns a
 * search into either a parse error or silently inverted results. Tokens are
 * stripped of operators and re-emitted as `+token*` (all terms required,
 * prefix-matched). Tokens under innodb_ft_min_token_size are dropped — a
 * `+ab*` term can never match, so leaving it in would zero out the whole
 * query — and if nothing survives, we fall back to the LIKE branch rather
 * than returning a confident empty list.
 *
 * @returns {{sql: string, params: any[]}|null}
 */
function _qPredicate(q) {
  const raw = String(q);

  if (raw.length >= FT_MIN_TOKEN) {
    const tokens = raw
      .replace(/[+\-><()~*"@]/g, ' ')
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= FT_MIN_TOKEN);

    if (tokens.length) {
      const expr = tokens.map(t => `+${t}*`).join(' ');
      return {
        sql: 'MATCH(d.name, d.title, d.tags) AGAINST (? IN BOOLEAN MODE)',
        params: [expr],
      };
    }
    // fall through to LIKE
  }

  return { sql: 'd.name LIKE ?', params: [_escapeLike(raw) + '%'] };
}

// ─────────────────────────────────────────────────────────────
// Related-scope expansion (S3.1)
// ─────────────────────────────────────────────────────────────

/**
 * Ceiling on how many targets one related expansion may carry.
 *
 * A BACKSTOP, not a feature. Measured on live data 2026-08-27: a case has at
 * most 3 related contacts and a contact at most 7 related cases (1,090
 * case_relate rows over 1,077 cases and 1,032 contacts). 200 is ~28x the worst
 * real case, so this can only fire on a data shape nobody has seen — which is
 * exactly when someone should be told rather than quietly served a short list.
 *
 * When it fires the response carries `related_truncated: true`. It does NOT
 * throw: a partly-expanded list is still useful, and the scoped target itself
 * is always first in the set, so the DIRECT documents can never be the ones
 * dropped.
 */
const RELATED_TARGET_CAP = 200;

/**
 * Resolve a scoped target into the FLAT set of (link_type, link_id) pairs a
 * related view should match, one hop out.
 *
 * ── WHY THIS IS A SEPARATE QUERY AND NOT A SUBQUERY IN THE JOIN ───────────
 * The obvious form puts case_relate inside the document query:
 *
 *     JOIN document_links dl ON dl.document_id = d.id AND (
 *          (dl.link_type = 'case'    AND dl.link_id = ?)
 *       OR (dl.link_type = 'contact' AND dl.link_id IN (SELECT … case_relate …)))
 *
 * MySQL cannot use idx_dl_target for an OR across two different link_type
 * values, so it degrades to a full index scan of document_links. Measured on
 * the live DB (EXPLAIN, 2026-08-27), contact scope:
 *
 *     OR-in-JOIN     dl  type=index  key=uq_doc_target  rows=22637
 *     flat IN list   dl  type=range  key=idx_dl_target  rows=8
 *
 * Both return the same answer. The first scales with the SIZE OF THE LINK
 * TABLE — which the reconcile sweep is still filling toward six figures — and
 * this query runs on every case/contact tab open. The second scales with the
 * target set, which is bounded above by RELATED_TARGET_CAP and in practice is
 * under ten.
 *
 * Two more things fall out of resolving first, and they are not incidental:
 *
 *   ONE HOP IS STRUCTURAL. case_relate does not appear in the document query
 *   at all. There is no edge left to traverse, so "a related contact's OTHER
 *   cases can never appear" is a property of the query's SHAPE rather than of
 *   a predicate someone has to keep correct. A second hop would require
 *   someone to add a second query, deliberately.
 *
 *   THE COLLATION TRAP DISAPPEARS. Joining document_links.link_id (VARCHAR,
 *   utf8mb4_general_ci) to case_relate.case_relate_client_id (INT) in SQL
 *   means CAST(int AS CHAR), whose collation follows the CONNECTION
 *   (utf8mb4_unicode_ci here) and whose coercibility is 2 — the same as a
 *   column, so neither side wins and MySQL refuses outright. Verified against
 *   the live server, not reasoned about:
 *
 *     Illegal mix of collations (utf8mb4_general_ci,IMPLICIT)
 *                           and (utf8mb4_unicode_ci,IMPLICIT) for operation '='
 *
 *   `… COLLATE utf8mb4_general_ci` on the cast side fixes it, and this design
 *   deletes the cast instead: the ids come back as JS values and re-enter as
 *   BOUND LITERALS, which are coercible and adopt the column's own collation.
 *   tests/documentService.test.js pins that case_relate never reaches the
 *   document query, so the trap cannot be reintroduced by accident.
 *
 * The scoped target is ALWAYS element 0, flagged `direct`. Everything after it
 * is one hop out and carries the case_relate_type that got it there.
 *
 * @param {object} db
 * @param {string} linkType  'case' | 'contact' — anything else expands to itself
 * @param {string} linkId
 * @returns {Promise<{targets: Array<{link_type,link_id,direct?,relate_type?}>,
 *                    truncated: boolean}>}
 */
async function resolveRelatedTargets(db, linkType, linkId) {
  const type = _col('link_type', linkType);
  const id   = _col('link_id', String(linkId));

  const targets = [{ link_type: type, link_id: id, direct: true }];
  let rows = [];

  if (type === 'case') {
    // link_id is the case id, a VARCHAR on both sides — a bound literal
    // against case_relate_case_id VARCHAR(8) utf8mb4_general_ci. No cast.
    const [r] = await db.query(
      `SELECT case_relate_client_id AS rel_id, case_relate_type AS rel_type
         FROM case_relate
        WHERE case_relate_case_id = ?`,
      [id],
    );
    // STRINGIFIED to match document_links.link_id, which stores contact ids as
    // text (link_id is one polymorphic VARCHAR holding both a case's random
    // string id and a contact's integer). Done here, in JS, rather than in SQL
    // — see the collation note above.
    rows = r.map(x => ({
      link_type: 'contact',
      link_id:   String(x.rel_id),
      relate_type: x.rel_type || null,
    }));
  } else if (type === 'contact') {
    // The reverse hop needs an INT to hit idx_case_relate_client. A contact
    // link_id that is not an integer cannot be a real contact id, so it has no
    // related cases and the expansion is just the direct target — which is the
    // honest answer, not an error.
    const n = _toIntOrNull(id);
    if (n != null) {
      const [r] = await db.query(
        `SELECT case_relate_case_id AS rel_id, case_relate_type AS rel_type
           FROM case_relate
          WHERE case_relate_client_id = ?`,
        [n],
      );
      rows = r.map(x => ({
        link_type: 'case',
        link_id:   String(x.rel_id),
        relate_type: x.rel_type || null,
      }));
    }
  }

  // Dedupe against the direct target and against itself: case_relate carries a
  // uniqueness trigger, but a contact could in principle appear twice with two
  // relate types, and a duplicate pair would fan the JOIN out again.
  const seen = new Set([`${type}\u0000${id}`]);
  for (const t of rows) {
    const k = `${t.link_type}\u0000${t.link_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    targets.push(t);
  }

  const truncated = targets.length > RELATED_TARGET_CAP;
  return {
    targets: truncated ? targets.slice(0, RELATED_TARGET_CAP) : targets,
    truncated,
  };
}

/**
 * `(link_type, link_id) IN ((?,?),(?,?),…)` for a resolved target set.
 *
 * The ROW CONSTRUCTOR form is what buys the range scan on idx_dl_target
 * (link_type, link_id): MySQL 8 turns a row-constructor IN list over a
 * composite index into one range per tuple. Two separate `link_type IN (…)
 * AND link_id IN (…)` predicates would NOT — they would cross-multiply and
 * match a case id under link_type 'contact'.
 */
function _targetSetPredicate(targets) {
  const tuples = targets.map(() => '(?, ?)').join(', ');
  const params = [];
  for (const t of targets) params.push(t.link_type, t.link_id);
  return { sql: `(dl.link_type, dl.link_id) IN (${tuples})`, params };
}

/** Extensions are `[a-z0-9]{1,20}` by _extOf's own rule; anything else is junk. */
function _normalizeExts(v) {
  if (v == null || v === '') return [];
  const out = [];
  const seen = new Set();
  for (const raw of String(v).split(',')) {
    const e = raw.trim().toLowerCase().replace(/^\./, '');
    if (!/^[a-z0-9]{1,20}$/.test(e)) continue;   // same shape _extOf can store
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(_col('ext', e));
    if (out.length >= 24) break;                 // a UI facet, not a bulk query
  }
  return out;
}

/**
 * Resolve a target set to display labels, in at most two page-independent
 * queries (the set is bounded by RELATED_TARGET_CAP, and is under ten in
 * practice — so this costs the same whether the page holds 1 row or 200).
 *
 * Column choices are read off the live schema, not guessed:
 *   case    → case_number_full, else case_number, else the opaque case_id.
 *             Same COALESCE portalDocsService._scopedCaseRow uses, plus NULLIF
 *             because both columns are free text and legitimately hold ''.
 *   contact → contact_lfm_name ("Ross, Fred") — the firm's own identity
 *             convention, the one uploadTargetService names folders with.
 *
 * A target with no resolvable label falls back to its raw id rather than
 * disappearing: an unlabelled badge is a small ugliness, a missing one is a
 * document whose provenance the user cannot see.
 */
async function _labelTargets(db, targets) {
  const labels = new Map();       // 'type\0id' -> string

  const caseIds    = targets.filter(t => t.link_type === 'case').map(t => t.link_id);
  const contactIds = targets.filter(t => t.link_type === 'contact')
    .map(t => _toIntOrNull(t.link_id)).filter(n => n != null);

  if (caseIds.length) {
    const [rows] = await db.query(
      `SELECT case_id,
              COALESCE(NULLIF(case_number_full, ''), NULLIF(case_number, ''), case_id) AS label
         FROM cases
        WHERE case_id IN (?)`,
      [caseIds],
    );
    for (const r of rows) labels.set(`case\u0000${r.case_id}`, String(r.label));
  }

  if (contactIds.length) {
    const [rows] = await db.query(
      `SELECT contact_id,
              COALESCE(NULLIF(contact_lfm_name, ''), NULLIF(contact_name, ''),
                       CONCAT('#', contact_id)) AS label
         FROM contacts
        WHERE contact_id IN (?)`,
      [contactIds],
    );
    for (const r of rows) labels.set(`contact\u0000${String(r.contact_id)}`, String(r.label));
  }

  return labels;
}

/**
 * Attach `via` to every row of a page: which of the scope's targets actually
 * matched it, resolved to labels.
 *
 * ── WHY A SECOND QUERY AND NOT GROUP_CONCAT IN THE PAGE QUERY ─────────────
 * group_concat_max_len on this server is 1024 (verified 2026-08-27) and this
 * schema has no STRICT_TRANS_TABLES, so an over-long GROUP_CONCAT does not
 * error — it TRUNCATES, mid-value. A document with many links would hand back
 * a final pair chopped in half, which parses into a plausible-looking target
 * that does not exist. That is the same silent-truncation class the whole
 * _clamp discipline in this file exists to keep out of SQL, and it is not
 * worth reintroducing to save one page-sized round trip.
 *
 * The second query is bounded twice over: `document_id IN (page ids)` (≤ 200)
 * AND the same target-set predicate as the page query, so it reads only the
 * link rows that produced the page.
 */
async function _attachVia(db, documents, targets, labels) {
  if (!documents.length) return;

  const ids = documents.map(d => d.id);
  const pred = _targetSetPredicate(targets);

  const [links] = await db.query(
    `SELECT dl.document_id, dl.link_type, dl.link_id
       FROM document_links dl
      WHERE dl.document_id IN (?)
        AND ${pred.sql}`,
    [ids, ...pred.params],
  );

  const meta = new Map(
    targets.map(t => [`${t.link_type}\u0000${t.link_id}`, t]),
  );

  const byDoc = new Map();
  for (const l of links) {
    const key = `${l.link_type}\u0000${String(l.link_id)}`;
    const t   = meta.get(key);
    if (!t) continue;                       // defensive: not one of ours
    const entry = {
      link_type: l.link_type,
      link_id:   String(l.link_id),
      label:     labels.get(key) || String(l.link_id),
      ...(t.direct ? { direct: true } : {}),
      ...(t.relate_type ? { relate_type: t.relate_type } : {}),
    };
    const arr = byDoc.get(l.document_id);
    if (arr) arr.push(entry);
    else byDoc.set(l.document_id, [entry]);
  }

  // DIRECT FIRST. A document matched both directly and through a hop is a
  // document the user owns; leading with the hop badge would misrepresent it.
  for (const d of documents) {
    const arr = byDoc.get(d.id) || [];
    arr.sort((a, b) => (b.direct ? 1 : 0) - (a.direct ? 1 : 0));
    d.via = arr;
  }
}

/**
 * List documents with optional search, facet filters, target filter, sort and paging.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.q]           see _qPredicate
 * @param {string} [opts.doc_type]    exact match
 * @param {string} [opts.ext]         exact match, lowercased. Accepts a CSV
 *                                    ('doc,docx,rtf') → IN (…); junk tokens are
 *                                    dropped, and an all-junk value disables
 *                                    the filter rather than returning nothing.
 * @param {string} [opts.tag]         membership in the normalized CSV (FIND_IN_SET)
 * @param {string} [opts.status='active']  'all' disables the filter
 * @param {string} [opts.source]      exact match
 * @param {string} [opts.link_type]   with link_id: restrict to documents linked to that target
 * @param {string} [opts.link_id]
 * @param {string} [opts.unlinked]    'case' → ONLY documents with no case link
 *                                    at all. See UNLINKED_KINDS. IGNORED when
 *                                    link_type + link_id are present — a scoped
 *                                    list is "documents linked to X" and an
 *                                    unlinked list is "documents linked to
 *                                    nothing", so the two are contradictory by
 *                                    construction and the scope wins.
 * @param {boolean}[opts.related]     expand the scope ONE HOP through case_relate
 *                                    and attach `via` to every row.
 *                                    ONLY HONORED WITH link_type + link_id —
 *                                    a global list has no scope to expand, so
 *                                    the flag is IGNORED there (not an error:
 *                                    the UI leaves the toggle checked when it
 *                                    switches modes). See resolveRelatedTargets.
 * @param {string} [opts.sort='newest']  SORT_MAP key — newest | oldest | name |
 *                                      size | modified. Unknown → newest.
 * @param {number} [opts.limit=50]    clamped to [1,200]
 * @param {number} [opts.offset=0]
 * @returns {Promise<{documents: object[], total: number, limit: number,
 *                    offset: number, related?: boolean,
 *                    related_targets?: object[], related_truncated?: boolean}>}
 *          `related_targets` is the labelled target set the expansion used —
 *          the client needs it to know which `doclink:` bus addresses this
 *          view is actually watching. See its assignment.
 */
async function list(db, opts = {}) {
  const {
    q, doc_type, ext, tag, source, link_type, link_id, related, unlinked,
    status = 'active',
    sort   = 'newest',
    limit  = 50,
    offset = 0,
  } = opts;

  const where  = [];
  const params = [];

  const hasTarget = link_type != null && link_type !== '' && link_id != null && link_id !== '';
  // `related` without a scope is meaningless, not wrong — see the docblock.
  const wantRelated = hasTarget && !!related &&
    !(related === '0' || related === 'false');

  // A SCOPE AND AN ANTI-SCOPE CANNOT BOTH HOLD. "Documents linked to case X"
  // and "documents linked to no case" intersect at the empty set for every
  // input, so honouring both would always return nothing — a silent empty list
  // being the single worst way to report a contradiction. The scope wins and
  // this is dropped, matching how `related` is dropped when it has no scope to
  // expand. An unrecognised kind is likewise ignored rather than erroring, for
  // the same reason `ext` drops junk tokens: a triage view that over-shows is
  // recoverable, one that mysteriously shows nothing is not.
  const unlinkedKind = !hasTarget && UNLINKED_KINDS.has(String(unlinked || ''))
    ? String(unlinked) : null;

  let joinSql = '';
  let joinParams = [];
  let groupSql = '';
  let targets = null;
  let relatedTruncated = false;

  if (wantRelated) {
    // ONE extra round trip, against an indexed lookup that returns single
    // digits of rows, in exchange for a range scan instead of a full index
    // scan on the page query. See resolveRelatedTargets for the EXPLAIN.
    const resolved = await resolveRelatedTargets(db, link_type, link_id);
    targets = resolved.targets;
    relatedTruncated = resolved.truncated;

    const pred = _targetSetPredicate(targets);
    joinSql = `JOIN document_links dl ON dl.document_id = d.id AND ${pred.sql}`;
    joinParams = pred.params;
    // The expansion CAN fan out — a document linked to both the case and one
    // of its contacts matches twice — so unlike the direct join below, this
    // one needs deduping. sql_mode here does NOT include ONLY_FULL_GROUP_BY
    // (listCases depends on that and it must stay off), and every selected
    // non-aggregate is a column of `d`, functionally dependent on d.id.
    groupSql = 'GROUP BY d.id';
  } else if (hasTarget) {
    // JOIN, not EXISTS: (document_id, link_type, link_id) is UNIQUE, so the
    // join cannot fan out, and idx_dl_target drives it. NO GROUP BY on this
    // path — it is the hot one, and a temp table here would be pure cost.
    joinSql = 'JOIN document_links dl ON dl.document_id = d.id AND dl.link_type = ? AND dl.link_id = ?';
    joinParams = [_col('link_type', link_type), _col('link_id', link_id)];
  } else if (unlinkedKind) {
    // ── THE TRIAGE ANTI-JOIN (S3.2) ────────────────────────────────────────
    // "No link of this type AT ALL" — any relation, any creator. NOT "no
    // path-link", which is what attributeUnlinked's sweep means by unlinked
    // and which is a different question: the sweep asks "does this file's
    // LOCATION earn it a link", and a manually-filed document legitimately
    // answers no while still being attributed. A human looking at this view
    // asks "does anybody own this document", so a manual link takes a row OUT
    // of it. Leaving `relation` out of the predicate is what makes those two
    // readings different, and it is deliberate.
    //
    // Same LEFT JOIN + IS NULL shape as the sweep, and it keeps the plan the
    // sweep documents — EXPLAIN against the live DB, 2026-08-27: dl is
    // type=ref on uq_doc_target with `Not exists; Using index`, driven by
    // (document_id, link_type). It KEEPS `Using index` where the sweep lost
    // it, because there is no `relation` to fetch the row and test.
    //
    // Measured, 153k rows / 130k unlinked: page 436ms vs a 350ms baseline,
    // COUNT(*) 316ms vs 98ms. The filesort is pre-existing (the unfiltered
    // list does it too), not introduced here.
    //
    // Alias `ul`, not `dl`: this branch is mutually exclusive with both joins
    // above so a collision is impossible today, and a distinct name keeps it
    // impossible if that ever stops being true.
    joinSql = 'LEFT JOIN document_links ul ON ul.document_id = d.id AND ul.link_type = ?';
    joinParams = [_col('link_type', unlinkedKind)];
    where.push('ul.id IS NULL');
  }

  if (status !== 'all') {
    where.push('d.status = ?');
    params.push(STATUSES.has(status) ? status : 'active');
  }
  if (source != null && source !== '') {
    where.push('d.source = ?');
    params.push(_col('source', source));
  }
  if (doc_type != null && doc_type !== '') {
    where.push('d.doc_type = ?');
    params.push(_col('doc_type', doc_type));
  }
  // EXACT match on the stored extension, which _extOf already wrote lowercased
  // and without a dot — so the needle is normalized the same way the haystack
  // was, exactly as the `tag` arm normalizes through normalizeTags.
  //
  // CSV is accepted because the UI's facet is a category ("Office documents"),
  // not an extension, and one category is several extensions. A single value
  // still emits `= ?` rather than `IN (?)` so the common case reads plainly in
  // a slow-query log.
  //
  // NOTE for whoever profiles this: `documents.ext` is UNINDEXED. The filter
  // rides whatever index the sort picked (idx_docs_modified for the UI
  // default) and tests ext per row; the page LIMIT bounds that, but the
  // COUNT(*) has to visit every match. Fine at 153k rows against a facet the
  // user picked deliberately — revisit with an index if ext ever moves onto a
  // default-loaded surface.
  const exts = _normalizeExts(ext);
  if (exts.length === 1) {
    where.push('d.ext = ?');
    params.push(exts[0]);
  } else if (exts.length > 1) {
    where.push(`d.ext IN (${exts.map(() => '?').join(', ')})`);
    params.push(...exts);
  }
  if (tag != null && tag !== '') {
    // Tags are stored as a normalized CSV; FIND_IN_SET is exact membership,
    // where LIKE '%tag%' would match 'tag' inside 'untagged'. Normalize the
    // needle the same way the haystack was written, then take the first token.
    const needle = (normalizeTags(tag) || '').split(',')[0];
    if (needle) {
      where.push('FIND_IN_SET(?, d.tags)');
      params.push(needle);
    }
  }
  if (q != null && String(q).length) {
    const pred = _qPredicate(q);
    where.push(pred.sql);
    params.push(...pred.params);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderSql = 'ORDER BY ' + (SORT_MAP[sort] || SORT_MAP.newest);

  // limit/offset are validated integers → safe to inline (avoids mysql2 LIMIT
  // placeholder quirks). Never interpolate the raw opt.
  let lim = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 50;
  lim = Math.min(Math.max(lim, 1), 200);
  let off = Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0;
  off = Math.max(off, 0);

  const allParams = [...joinParams, ...params];

  const [documents] = await db.query(
    `SELECT d.*
       FROM documents d
       ${joinSql}
       ${whereSql}
       ${groupSql}
       ${orderSql}
       LIMIT ${lim} OFFSET ${off}`,
    allParams,
  );

  // COUNT(DISTINCT d.id) on the related path, plain COUNT(*) otherwise. The
  // two must agree with their own page query or the pager lies: the related
  // join fans out on documents matching more than one target, so COUNT(*)
  // there would over-count by exactly the rows GROUP BY collapsed.
  const [countRows] = await db.query(
    `SELECT ${wantRelated ? 'COUNT(DISTINCT d.id)' : 'COUNT(*)'} AS total
       FROM documents d
       ${joinSql}
       ${whereSql}`,
    allParams,
  );
  const total = countRows.length ? Number(countRows[0].total) : 0;

  let relatedTargets = null;
  if (wantRelated) {
    // Labels are resolved ONCE for the whole target set — bounded by
    // RELATED_TARGET_CAP and single-digit in practice — and then shared by
    // `via` and by `related_targets`.
    const labels = await _labelTargets(db, targets);
    await _attachVia(db, documents, targets, labels);

    // ── WHY THE TARGET SET COMES BACK TO THE CLIENT ────────────────────────
    // The sync bus announces a link change as `doclink:<type>:<id>` — the
    // address of the TARGET whose link set moved. A scoped view watching only
    // its own target therefore misses every change to a RELATED one: link a
    // document to the client contact and the case's Documents widget, which
    // is precisely the surface that should now show it, hears nothing.
    //
    // Deriving the addresses from the `via` on the current page half-fixes it
    // — that catches a row DISAPPEARING (its target is on the page) but not a
    // row APPEARING (the target may have no row yet, which is the whole point
    // of the message). Handing over the resolved set fixes both, and it is
    // free: it is the same array the query already built, with the labels
    // already fetched.
    relatedTargets = targets.map((t) => {
      const key = `${t.link_type}\u0000${t.link_id}`;
      return {
        link_type: t.link_type,
        link_id:   t.link_id,
        label:     labels.get(key) || t.link_id,
        ...(t.direct ? { direct: true } : {}),
        ...(t.relate_type ? { relate_type: t.relate_type } : {}),
      };
    });
  }

  return {
    documents, total, limit: lim, offset: off,
    ...(wantRelated ? { related: true, related_targets: relatedTargets } : {}),
    ...(relatedTruncated ? { related_truncated: true } : {}),
    // ECHOED when it APPLIED, not when it was asked for. That distinction is
    // the point: a caller that sent both a scope and `unlinked` had the latter
    // dropped, and the absence of this key is how it finds out rather than
    // wondering why the list looks scoped.
    ...(unlinkedKind ? { unlinked: unlinkedKind } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// update
// ─────────────────────────────────────────────────────────────

/**
 * Partially update a document's human/AI-owned fields (title, doc_type, tags,
 * status). Only fields present (not `undefined`) are written; `tags` is
 * normalized through assetService.normalizeTags (the house convention).
 *
 * A missing row yields null. With nothing to change, returns the current row
 * unchanged and emits nothing.
 *
 * An out-of-range `status` throws rather than writing: the column is an ENUM
 * and this DB has no STRICT_TRANS_TABLES, so an invalid value would land as
 * '' and quietly disappear from every status-filtered list.
 *
 * @param {object} db
 * @param {number} id
 * @param {object} [fields] — { title?, doc_type?, tags?, status? }
 * @param {object} [opts]   — { eventSource?, actorUserId? }
 * @returns {Promise<object|null>}
 */
async function update(db, id, fields = {}, opts = {}) {
  const prior = await getById(db, id);
  if (!prior) return null;

  const next   = {};
  const sets   = [];
  const params = [];

  if (fields.title !== undefined) {
    next.title = _col('title', fields.title);
    sets.push('title = ?');
    params.push(next.title);
  }
  if (fields.doc_type !== undefined) {
    next.doc_type = _col('doc_type', fields.doc_type);
    sets.push('doc_type = ?');
    params.push(next.doc_type);
  }
  if (fields.tags !== undefined) {
    next.tags = _col('tags', normalizeTags(fields.tags));
    sets.push('tags = ?');
    params.push(next.tags);
  }
  if (fields.status !== undefined) {
    const s = String(fields.status);
    if (!STATUSES.has(s)) {
      throw new Error(`documentService.update: status must be one of ${[...STATUSES].join('|')}`);
    }
    next.status = s;
    sets.push('status = ?');
    params.push(s);
  }

  if (!sets.length) return prior;

  const changes = domainEvents.buildChanges(prior, next, Object.keys(next));
  if (!Object.keys(changes).length) return prior;

  params.push(id);
  await db.query(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params);

  const row = await getById(db, id);

  domainEvents.emit(db, 'document.updated', {
    ..._attribution(opts),
    data: _eventData(row),
    changes,
    extra: { updated_fields: Object.keys(changes), via: 'edit' },
  });

  return row;
}

/**
 * Cache a provider-minted PERMANENT shared link on the row.
 *
 * Separate from update() on purpose: shared_link is not a human-editable
 * field, it is a provider fact, and it must not be settable through the
 * PATCH surface. No emission — it is absent from _eventData (a permanent
 * public URL has no business being replicated into trigger_executions) and
 * it is not a meaningful-change key.
 *
 * Clamped here rather than at the call site so the VARCHAR(512) limit lives
 * exactly once, next to the column map. Silent truncation would otherwise
 * produce a permanently broken public link with no error anywhere.
 *
 * @returns {Promise<string|null>} the value actually stored
 */
async function setSharedLink(db, id, url) {
  const stored = _col('shared_link', url);
  await db.query('UPDATE documents SET shared_link = ? WHERE id = ?', [stored, id]);
  return stored;
}

// ─────────────────────────────────────────────────────────────
// Links
// ─────────────────────────────────────────────────────────────

/**
 * Link a document to a target entity. IDEMPOTENT — the unique key
 * (document_id, link_type, link_id) absorbs a repeat and only a genuinely new
 * row emits.
 *
 * `link_id` is VARCHAR because the two targets that matter disagree on type:
 * cases.case_id is varchar(20) (random string ids) and contacts.contact_id is
 * int unsigned. One polymorphic string column holds both.
 *
 * ── WHY THE INSERT IS NOT `ON DUPLICATE KEY UPDATE` ──────────────────────
 * The obvious form — `… ON DUPLICATE KEY UPDATE id = id` and then testing
 * `affectedRows === 1` for "inserted" — IS BROKEN HERE, and silently.
 * mysql2's defaultFlags include CLIENT_FOUND_ROWS (lib/connection_config.js),
 * and the pool sets no `flags` override, so MySQL reports FOUND rather than
 * CHANGED rows: affectedRows is 1 on the duplicate branch too, not the
 * documented 0. Measured against a real server, not reasoned about:
 *     first insert -> affectedRows 1
 *     re-insert    -> affectedRows 1     ← indistinguishable
 * That would make every repeat link look new and emit a duplicate
 * document.linked, which is exactly the retry-safety this function promises.
 *
 * So the DUPLICATE KEY ERROR is the signal. It is race-free (the server
 * decides, not a read-then-write), and unlike INSERT IGNORE it re-throws
 * everything that is not a duplicate — truncation and type errors stay loud,
 * which matters on a schema with no STRICT_TRANS_TABLES. errno 1062 is
 * checked alongside the code string because the numeric code is the stable one.
 *
 * @param {object} db
 * @param {number} documentId
 * @param {string} linkType     'case' | 'contact' | …
 * @param {string|number} linkId
 * @param {object} [opts] — { relation?, createdBy?, eventSource? }
 * @returns {Promise<{linked: boolean, created: boolean, row: object|null}>}
 *          linked = the link exists after this call; created = it is new.
 */
async function link(db, documentId, linkType, linkId, opts = {}) {
  const { relation = null, createdBy = null, eventSource = null } = opts;

  if (!documentId)            throw new Error('documentService.link: documentId is required');
  if (!linkType)              throw new Error('documentService.link: linkType is required');
  if (linkId == null || linkId === '') throw new Error('documentService.link: linkId is required');

  const type = _col('link_type', linkType);
  const lid  = _col('link_id', String(linkId));
  const rel  = _col('relation', relation);
  const by   = _toIntOrNull(createdBy);

  let created = true;
  try {
    await db.query(
      `INSERT INTO document_links (document_id, link_type, link_id, relation, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [documentId, type, lid, rel, by],
    );
  } catch (err) {
    // A pre-existing link is success, not failure. Anything else re-throws.
    if (err && (err.errno === 1062 || err.code === 'ER_DUP_ENTRY')) {
      created = false;
    } else {
      throw err;
    }
  }

  const row = await getById(db, documentId);

  if (created) {
    // Promote the target onto the envelope's first-class columns so rules can
    // filter on case_id / contact_id the same way every other event does —
    // and so trigger_executions carries the attribution. document.created and
    // document.updated cannot do this: at registration time nothing knows
    // which case a file belongs to. THIS is where a document acquires an owner.
    domainEvents.emit(db, 'document.linked', {
      ...(type === 'case'    ? { case_id: lid } : {}),
      ...(type === 'contact' ? { contact_id: _toIntOrNull(lid) } : {}),
      ...(eventSource != null ? { source: eventSource } : {}),
      ...(by != null ? { actor: { user_id: by } } : {}),
      data:  _eventData(row),
      extra: { link_type: type, link_id: lid, relation: rel },
    });
  }

  return { linked: true, created, row };
}

/**
 * Remove a link. No emission — there is no 'document.unlinked' event type,
 * and an unregistered emit fires into a void the registry can never wire up
 * (tests/eventRegistryCoverage.test.js exists to make that impossible).
 *
 * @returns {Promise<boolean>} true when a row was actually removed.
 */
async function unlink(db, documentId, linkType, linkId) {
  const [r] = await db.query(
    'DELETE FROM document_links WHERE document_id = ? AND link_type = ? AND link_id = ?',
    [documentId, _col('link_type', linkType), _col('link_id', String(linkId))],
  );
  return r.affectedRows > 0;
}

/**
 * The relation the sync engine stamps on every link it writes (S3.1).
 *
 * MACHINE LINKS TRACK THE FILESYSTEM; HUMAN LINKS EXPRESS INTENT. A link with
 * this relation means exactly "this file currently sits under this case's
 * Dropbox folder", and the engine owns it: when the file moves, the engine
 * retracts it. Anything else in `relation` — or anything with created_by set —
 * is a person's statement about the document and survives until a person
 * removes it.
 */
const RELATION_PATH = 'path';

/**
 * Retract the path-links a document's NEW path no longer supports, and report
 * how many went.
 *
 * Called from the incremental sync when a file MOVES between case folders. A
 * file dragged from case A to case B keeps A's link forever without this, and
 * S3.1's related view then surfaces it — badged and confident — on every
 * contact related to case A. That is the failure this function exists for.
 *
 * ── WHY THE SCOPE IS IN THE STATEMENT, NOT IN A FILTER AFTERWARDS ─────────
 * The rule "never touch human links" has to be structural or it is not a rule.
 * Every clause below is load-bearing:
 *
 *   link_type = 'case'      path attribution is case attribution; contact
 *                           links are never derived from a path
 *   relation  = 'path'      the engine's own mark. A link relation'd anything
 *                           else is a person's classification
 *   created_by IS NULL      the engine has no user. A row with a user is a
 *                           person's, even if they typed 'path' into the
 *                           relation box — belt to the previous clause's braces
 *   link_id  <> ?           keep the one the new path DOES support, so an
 *                           unchanged case (a move WITHIN the same case folder)
 *                           drops nothing and re-links nothing
 *
 * With no new match the last clause is omitted and every path-link goes: the
 * file left the case-folder tree entirely, and a stale link is worse than none.
 *
 * ── WHY A DELETE AND NOT A SELECT-THEN-DELETE ─────────────────────────────
 * One statement, atomic, and affectedRows is honest here in a way it is not
 * for an upsert: CLIENT_FOUND_ROWS distorts INSERT … ON DUPLICATE (see link()),
 * but a DELETE's affectedRows is rows actually removed either way.
 *
 * NO EMISSION, and none is possible: there is no 'document.unlinked' event
 * type, and tests/eventRegistryCoverage.test.js exists to stop one being
 * emitted into a void. The MOVE'S ARRIVAL is the signal that does fire — the
 * caller's link() to the new case emits document.linked, which is the correct
 * and rule-actionable half of "this document is now case B's".
 *
 * @param {object} db
 * @param {number} documentId
 * @param {string|null} keepCaseId  the case the new path matches, or null
 * @returns {Promise<number>} path-links removed
 */
async function reconcilePathLinks(db, documentId, keepCaseId = null) {
  if (!documentId) return 0;

  const keep = keepCaseId == null || keepCaseId === ''
    ? null
    : _col('link_id', String(keepCaseId));

  const [r] = await db.query(
    `DELETE FROM document_links
      WHERE document_id = ?
        AND link_type = 'case'
        AND relation = ?
        AND created_by IS NULL
        ${keep == null ? '' : 'AND link_id <> ?'}`,
    keep == null ? [documentId, RELATION_PATH] : [documentId, RELATION_PATH, keep],
  );
  return r.affectedRows;
}

/** Every link row for one document, newest first. */
async function listLinks(db, documentId) {
  const [rows] = await db.query(
    `SELECT * FROM document_links
      WHERE document_id = ?
      ORDER BY created_at DESC, id DESC`,
    [documentId],
  );
  return rows;
}

/**
 * Every document linked to one target, joined to the document row.
 *
 * @param {object} db
 * @param {string} linkType
 * @param {string|number} linkId
 * @param {object} [opts] — { status='active' ('all' disables), limit=200 }
 * @returns {Promise<object[]>} document rows + relation / linked_at
 */
async function listForTarget(db, linkType, linkId, opts = {}) {
  const { status = 'active', limit = 200 } = opts;

  const where  = ['dl.link_type = ?', 'dl.link_id = ?'];
  const params = [_col('link_type', linkType), _col('link_id', String(linkId))];

  if (status !== 'all') {
    where.push('d.status = ?');
    params.push(STATUSES.has(status) ? status : 'active');
  }

  let lim = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 200;
  lim = Math.min(Math.max(lim, 1), 500);

  const [rows] = await db.query(
    `SELECT d.*, dl.relation, dl.created_at AS linked_at, dl.id AS link_row_id
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id
      WHERE ${where.join(' AND ')}
      ORDER BY dl.created_at DESC, dl.id DESC
      LIMIT ${lim}`,
    params,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// markDeletedByPath
// ─────────────────────────────────────────────────────────────

/**
 * Mark rows deleted by PATH — the one place this registry has to work
 * path-first instead of id-first.
 *
 * Dropbox's delete delta is a DeletedMetadata entry carrying a path and NO id,
 * so there is nothing to look the row up by. Worse, deleting a FOLDER arrives
 * as ONE entry for the folder, with no entries for its descendants — every
 * file underneath it is silently gone. Hence the prefix arm: exact path_hash
 * match OR anything whose path_lower sits under '<path>/'.
 *
 * The prefix arm is a full scan (path_lower is TEXT and unindexed). That is
 * accepted: deletes are rare and the alternative — indexing a TEXT column with
 * a prefix key — buys a scan of the index instead of the table. Revisit if
 * S2's delta feed ever shows sustained delete volume.
 *
 * NO EMISSIONS. S2 owns delta-event semantics (one event per file in a 4,000-
 * file folder delete is not a signal, it is a denial of service), and it needs
 * to make that call with the delta feed in front of it.
 *
 * @param {object} db
 * @param {string} source
 * @param {string} pathLower   Dropbox path_lower of the deleted entry
 * @returns {Promise<number>} rows changed
 */
async function markDeletedByPath(db, source, pathLower) {
  if (pathLower == null || pathLower === '') return 0;

  const src    = _col('source', source);
  const p      = String(pathLower);
  const prefix = _escapeLike(p) + '/%';

  const [r] = await db.query(
    `UPDATE documents
        SET status = 'deleted'
      WHERE source = ?
        AND status <> 'deleted'
        AND (path_hash = ? OR path_lower LIKE ?)`,
    [src, _sha1(p), prefix],
  );
  return r.affectedRows;
}

module.exports = {
  upsertFromEntry,
  bulkUpsertEntries,
  bulkLink,
  mapExternalIds,
  getById,
  getByExternal,
  list,
  update,
  setSharedLink,
  link,
  unlink,
  reconcilePathLinks,
  listLinks,
  listForTarget,
  markDeletedByPath,
  resolveRelatedTargets,
  // exported for tests / reuse
  SORT_MAP,
  COLUMN_LIMITS,
  RELATION_PATH,
  RELATED_TARGET_CAP,
  _clamp,
  _extOf,
  _toMysqlDT,
  _escapeLike,
  _normalizeExts,
};
