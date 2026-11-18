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
 * case_folder_cache — also writes here through these functions. The write
 * semantics mirror the pair exactly:
 *   - a resolved write sets handle + paths and clears the error;
 *   - an error write keeps the prior handle/paths and records the error;
 *   - a human-link write (folder created / adopted) sets the link and whatever
 *     handle/path the creator learned; it never erases a handle it did not learn;
 *   - a hand-written link (setHumanLink: updateCase / createCase carrying
 *     case_dropbox) keeps ONLY the link when it changed — handle, paths, error
 *     and resolved_at go NULL, so a row never pairs a new link with the old
 *     folder's handle; the sweep re-resolves NULL-first. A blank link removes
 *     the row.
 * D3b-1 = the FILING READERS read it: caseFolderLink is the one place that
 * knows the precedence (the binding's human_link first, the legacy column
 * cases.case_dropbox second — a read-through alias until D3d deletes the
 * fallback here and nowhere else); casePathLower is the bound folder's path for
 * the write-time relation decision. The sync engine and the relink flow still
 * read case_folder_cache (D3b-2).
 * Pool-first: `db` is the first argument; no Express here.
 *
 * Every write is BEST-EFFORT behind the primary one: a failure here is logged
 * and never breaks the case or the sync (the primary pair is still the truth
 * until D3d). `strict: true` makes it throw instead — the twins use that.
 * READS are not best-effort: a failing read is the caller's error, handled the
 * way it handled a failing read of the case row.
 */

'use strict';

const KINDS = Object.freeze(['case', 'contact']);
/** The binding's source when the caller names none: the configured provider (D3e). */
const DEFAULT_SOURCE = () => require('./documentSourceService').configured();   // deferred require (convention)
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
  return { kind, id: String(id), source: source || DEFAULT_SOURCE() };
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
      [dismissed ? (by ?? null) : null, kind, source || DEFAULT_SOURCE(), list],
    );
    return r;
  });
}

/**
 * A hand-written folder link — updateCase / createCase carrying case_dropbox
 * (PATCH /api/cases/:id, the relink flow's updateCase). The same link is a
 * no-op; a changed link keeps ONLY the link (handle, paths, error, resolved_at
 * → NULL — the old folder's handle must not survive under a new link; the sweep
 * re-resolves NULL-first); a blank link removes the row. Assignment order
 * matters: MySQL evaluates ON DUPLICATE KEY UPDATE left to right, so human_link
 * is compared in every IF and assigned LAST.
 */
async function setHumanLink(db, { kind, id, source, humanLink }, { strict = false } = {}) {
  const k = _key({ kind, id, source });
  const link = humanLink == null ? '' : String(humanLink).trim();
  if (!link) return remove(db, k, { strict });
  return _run(db, strict, `setHumanLink ${k.kind} ${k.id}`, async () => {
    const [r] = await db.query(
      `INSERT INTO entity_folders (entity_kind, entity_id, source, human_link)
       VALUES (?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         external_id   = IF(entity_folders.human_link <=> new.human_link, entity_folders.external_id, NULL),
         path_lower    = IF(entity_folders.human_link <=> new.human_link, entity_folders.path_lower, NULL),
         path_display  = IF(entity_folders.human_link <=> new.human_link, entity_folders.path_display, NULL),
         resolve_error = IF(entity_folders.human_link <=> new.human_link, entity_folders.resolve_error, NULL),
         resolved_at   = IF(entity_folders.human_link <=> new.human_link, entity_folders.resolved_at, NULL),
         human_link    = new.human_link`,
      [k.kind, k.id, k.source, _clamp(link, HUMAN_LINK_MAX)],
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

/**
 * The link a case's documents file under — the read every filing path makes
 * (D3b-1). The binding's human_link first; the legacy column second
 * (cases.case_dropbox, a read-through alias until D3d), read HERE and nowhere
 * else. `found` false = no case row; `found` true with `link` null = the case
 * exists and has no folder (the ladders' auto-create rung). A caller already
 * holding the case row passes it as `caseRow` (null = it knows the row is
 * absent) and the fallback costs no query. Links are trimmed (live 2026-11-17:
 * no row carries whitespace; the binding's are trimmed by construction).
 * @returns {Promise<{found:boolean, link:string|null, via:'binding'|'case'|null, externalId:string|null, pathLower:string|null}>}
 */
async function caseFolderLink(db, caseId, { source, caseRow } = {}) {
  const k = _key({ kind: 'case', id: caseId, source });
  const [[b]] = await db.query(
    'SELECT external_id, path_lower, human_link FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1',
    [k.kind, k.id, k.source],
  );
  const externalId = b && b.external_id ? String(b.external_id) : null;
  const pathLower = b && b.path_lower ? String(b.path_lower) : null;
  const bound = b && b.human_link != null ? String(b.human_link).trim() : '';
  if (bound) return { found: true, link: bound, via: 'binding', externalId, pathLower };
  let row = caseRow;
  if (row === undefined) {
    [[row]] = await db.query('SELECT case_id, case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [k.id]);
  }
  if (!row) return { found: false, link: null, via: null, externalId, pathLower };
  const legacy = row.case_dropbox != null ? String(row.case_dropbox).trim() : '';
  return { found: true, link: legacy || null, via: legacy ? 'case' : null, externalId, pathLower };
}

/**
 * The bound folder's path_lower (the sync's own lowercase form — the relation
 * decision compares landing paths against it), or null when unbound or never
 * resolved; `resolvedOnly` also returns null for a row carrying a resolve_error.
 */
async function casePathLower(db, caseId, { source, resolvedOnly = false } = {}) {
  const k = _key({ kind: 'case', id: caseId, source });
  const [[b]] = await db.query(
    'SELECT path_lower, resolve_error FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1',
    [k.kind, k.id, k.source],
  );
  if (!b || !b.path_lower) return null;
  if (resolvedOnly && b.resolve_error) return null;
  return String(b.path_lower);
}

/**
 * A contact's folder binding (D3c-2). Contacts have no legacy column: the
 * binding IS the record. `bound` false = no row or no link.
 * @returns {Promise<{bound:boolean, link:string|null, externalId:string|null, pathLower:string|null, pathDisplay:string|null}>}
 */
async function contactFolder(db, contactId, { source } = {}) {
  const b = await get(db, { kind: 'contact', id: contactId, source });
  const link = b && b.human_link != null ? String(b.human_link).trim() : '';
  return {
    bound: !!link,
    link: link || null,
    externalId: b && b.external_id ? String(b.external_id) : null,
    pathLower: b && b.path_lower ? String(b.path_lower) : null,
    pathDisplay: b && b.path_display ? String(b.path_display) : null,
  };
}

/** The binding row, or null. */
async function get(db, { kind, id, source }) {
  const k = _key({ kind, id, source });
  const [[row]] = await db.query(
    'SELECT * FROM entity_folders WHERE entity_kind = ? AND entity_id = ? AND source = ? LIMIT 1',
    [k.kind, k.id, k.source],
  );
  return row || null;
}

module.exports = { setResolved, setError, setPaths, setHumanLink, setRelinkDismissed, remove, get, caseFolderLink, casePathLower, contactFolder, KINDS, DEFAULT_SOURCE, RESOLVE_ERROR_MAX, EXTERNAL_ID_MAX, HUMAN_LINK_MAX };
