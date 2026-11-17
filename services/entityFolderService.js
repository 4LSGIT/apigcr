// services/entityFolderService.js
//
/**
 * ENTITY FOLDERS — the binding row: which folder, in which storage provider, an
 * entity's documents file into (storage-seam D3a; ref/DOCUMENTS_V3_DESIGN.md §3,
 * §9 D3). One row per (entity_kind, entity_id, source) in `entity_folders`
 * (ref/migrations/2026-11-17_storage_seam_d3a_entity_folders.sql): the
 * provider's move-stable handle (`external_id`), the path it resolved to, the
 * human link a person opens, the resolve error / relink state the sync engine
 * keeps.
 *
 * D3a = DUAL-WRITE. Every writer of today's pair — cases.case_dropbox and
 * case_folder_cache — also writes here through these functions; nothing READS
 * this table until D3b. The write semantics mirror the pair exactly:
 *   - a resolved write sets handle + paths and clears the error;
 *   - an error write keeps the prior handle/paths and records the error;
 *   - a human-link write (folder created / adopted) sets the link and whatever
 *     handle/path the creator learned; it never erases a handle it did not learn.
 * Pool-first: `db` is the first argument; no Express here.
 *
 * Every write is BEST-EFFORT behind the primary one: a failure here is logged
 * and never breaks the case or the sync (the primary pair is still the truth
 * until D3b). `strict: true` makes it throw instead — the twins use that.
 */

'use strict';

const KINDS = Object.freeze(['case', 'contact']);
const DEFAULT_SOURCE = 'dropbox';
const RESOLVE_ERROR_MAX = 255;
const EXTERNAL_ID_MAX = 191;
const HUMAN_LINK_MAX = 512;

function _clamp(v, n) {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function _key({ kind, id, source }) {
  if (!KINDS.includes(kind)) throw new Error(`entityFolderService: kind must be ${KINDS.join(' | ')}, got ${JSON.stringify(kind)}`);
  if (id == null || String(id) === '') throw new Error('entityFolderService: id is required');
  return { kind, id: String(id), source: source || DEFAULT_SOURCE };
}

async function _run(db, strict, label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (strict) throw err;
    console.warn(`[ENTITY FOLDERS] ${label} failed (the primary write stands): ${err && err.message}`);
    return null;
  }
}

/**
 * A resolved folder: handle + paths known, error cleared. The sync engine's
 * refreshCaseFolderCache success path; ensureCaseDropboxFolder when the
 * creator learned the handle.
 */
async function setResolved(db, { kind, id, source, externalId, pathLower, pathDisplay, humanLink }, { strict = false } = {}) {
  const k = _key({ kind, id, source });
  return _run(db, strict, `setResolved ${k.kind} ${k.id}`, async () => {
    const [r] = await db.query(
      `INSERT INTO entity_folders
         (entity_kind, entity_id, source, external_id, path_lower, path_display, human_link, resolve_error, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NOW()) AS new
       ON DUPLICATE KEY UPDATE
         external_id   = COALESCE(new.external_id, entity_folders.external_id),
         path_lower    = COALESCE(new.path_lower, entity_folders.path_lower),
         path_display  = COALESCE(new.path_display, entity_folders.path_display),
         human_link    = COALESCE(new.human_link, entity_folders.human_link),
         resolve_error = NULL,
         resolved_at   = NOW()`,
      [k.kind, k.id, k.source, _clamp(externalId, EXTERNAL_ID_MAX), pathLower ?? null, pathDisplay ?? null, _clamp(humanLink, HUMAN_LINK_MAX)],
    );
    return r;
  });
}

/** A failed resolution: the error recorded, prior handle/paths untouched (as case_folder_cache does). */
async function setError(db, { kind, id, source, humanLink, error }, { strict = false } = {}) {
  const k = _key({ kind, id, source });
  return _run(db, strict, `setError ${k.kind} ${k.id}`, async () => {
    const [r] = await db.query(
      `INSERT INTO entity_folders (entity_kind, entity_id, source, human_link, resolve_error, resolved_at)
       VALUES (?, ?, ?, ?, ?, NOW()) AS new
       ON DUPLICATE KEY UPDATE
         human_link    = COALESCE(new.human_link, entity_folders.human_link),
         resolve_error = new.resolve_error,
         resolved_at   = NOW()`,
      [k.kind, k.id, k.source, _clamp(humanLink, HUMAN_LINK_MAX), _clamp(error, RESOLVE_ERROR_MAX)],
    );
    return r;
  });
}

/** The folder moved (the sync engine's folder heal): paths follow the handle. */
async function setPaths(db, { kind, id, source, pathLower, pathDisplay }, { strict = false } = {}) {
  const k = _key({ kind, id, source });
  return _run(db, strict, `setPaths ${k.kind} ${k.id}`, async () => {
    const [r] = await db.query(
      `UPDATE entity_folders
          SET path_lower = ?, path_display = ?, resolve_error = NULL, resolved_at = NOW()
        WHERE entity_kind = ? AND entity_id = ? AND source = ?`,
      [pathLower ?? null, pathDisplay ?? null, k.kind, k.id, k.source],
    );
    return r;
  });
}

/** Relink suggestion dismissed / undismissed for several entities of one kind. */
async function setRelinkDismissed(db, { kind, ids, source, dismissed, by }, { strict = false } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`entityFolderService: kind must be ${KINDS.join(' | ')}`);
  const list = [...new Set((ids || []).map((v) => String(v)).filter(Boolean))];
  if (!list.length) return { affectedRows: 0 };
  return _run(db, strict, `setRelinkDismissed ${kind}`, async () => {
    const [r] = await db.query(
      `UPDATE entity_folders
          SET relink_dismissed_at = ${dismissed ? 'NOW()' : 'NULL'},
              relink_dismissed_by = ?
        WHERE entity_kind = ? AND source = ? AND entity_id IN (?)`,
      [dismissed ? (by ?? null) : null, kind, source || DEFAULT_SOURCE, list],
    );
    return r;
  });
}

/** The entity is gone (a merged case's loser): its binding goes with it. */
async function remove(db, { kind, id, source }, { strict = false } = {}) {
  const k = _key({ kind, id, source });
  return _run(db, strict, `remove ${k.kind} ${k.id}`, async () => {
    const [r] = await db.query(
      'DELETE FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ?',
      [k.kind, k.id, k.source],
    );
    return r;
  });
}

/** The binding row, or null. (Read side; D3b's readers start here.) */
async function get(db, { kind, id, source }) {
  const k = _key({ kind, id, source });
  const [[row]] = await db.query(
    'SELECT * FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1',
    [k.kind, k.id, k.source],
  );
  return row || null;
}

module.exports = { setResolved, setError, setPaths, setRelinkDismissed, remove, get, KINDS, DEFAULT_SOURCE, RESOLVE_ERROR_MAX, EXTERNAL_ID_MAX, HUMAN_LINK_MAX };
