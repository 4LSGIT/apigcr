// services/assetService.js
//
/**
 * Asset Service — registry layer over the `image_library` table.
 * services/assetService.js
 *
 * Pure DB module. Every exported fn takes the mysql2 pool/connection as its FIRST
 * argument. No GCS, no req/res, no Express — object storage lives in
 * services/storageService.js; this module only manages rows.
 *
 * Table `image_library` columns (post asset-store migration):
 *   id, url (UNIQUE prefix index uq_url(url(400))), filename, original_name,
 *   title, tags (comma-separated, lowercased), collection, mime, size,
 *   width, height, visibility ENUM('public','private') NOT NULL DEFAULT 'public',
 *   uploaded_by (tinyint unsigned → users.user), created_at, deleted_at (soft-delete).
 *
 * Soft-delete semantics:
 *   - list()  : excludes deleted_at IS NOT NULL unless { includeDeleted: true }.
 *   - update(): treats a soft-deleted row as absent (returns null); only edits live rows.
 *   - get()   : RAW fetch by id — returns the row regardless of soft-delete state.
 *               (Callers/routes that must hide deleted assets should filter, or use list().)
 *
 * Exports:
 *   normalizeTags(input)              -> string|null
 *   create(db, fields)               -> Promise<row|null>
 *   list(db, opts)                   -> Promise<{ assets, total, limit, offset }>
 *   get(db, id)                      -> Promise<row|null>
 *   update(db, id, fields)           -> Promise<row|null>
 *   softDelete(db, id)               -> Promise<boolean>
 *   hardDeleteRow(db, id)            -> Promise<boolean>   // row only; never touches GCS
 */

// All sortable columns are whitelisted; user-supplied `sort` only ever indexes
// this map, never reaches SQL directly.
const SORT_MAP = {
  newest: 'il.created_at DESC',
  oldest: 'il.created_at ASC',
  name:   'il.title ASC, il.original_name ASC',
  // size DESC already puts NULLs last in MySQL, but make it explicit/robust.
  size:   '(il.size IS NULL) ASC, il.size DESC',
};

// ─────────────────────────────────────────────────────────────
// Tag normalization
// ─────────────────────────────────────────────────────────────

/**
 * Normalize tags into a comma-separated, lowercased, trimmed, de-duplicated
 * string with no empty entries and no internal whitespace (runs of whitespace
 * inside a tag collapse to a single '-'). Commas always separate, whether the
 * input is a string ("a, b") or an array (["a", "b,c"]).
 *
 * @param {string|string[]|null|undefined} input
 * @returns {string|null} normalized CSV, or null if nothing survives.
 */
function normalizeTags(input) {
  if (input == null) return null;

  const parts = (Array.isArray(input) ? input : [input])
    .flatMap(x => (x == null ? [] : String(x).split(',')));

  const seen = new Set();
  const out  = [];
  for (const raw of parts) {
    let t = String(raw).trim().toLowerCase();
    if (!t) continue;
    t = t.replace(/\s+/g, '-'); // no spaces inside a tag
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length ? out.join(',') : null;
}

// ─────────────────────────────────────────────────────────────
// create
// ─────────────────────────────────────────────────────────────

/**
 * Insert (or upsert-on-url) an asset row and return the full row.
 *
 * Because `url` is UNIQUE, re-registering a known url updates the existing row's
 * mutable fields and returns it (idempotent registration). Note real uploads
 * generate a fresh random object name each time, so url collisions are effectively
 * only hit by deliberate re-registration of the same url. The ON DUPLICATE path
 * intentionally does NOT touch created_at or deleted_at.
 *
 * Every column is set explicitly (this DB's sql_mode lacks STRICT_TRANS_TABLES —
 * we don't lean on implicit defaults). created_at falls to its DB DEFAULT
 * CURRENT_TIMESTAMP; deleted_at falls to its NULL default on fresh inserts.
 *
 * @param {object} db
 * @param {object} fields
 * @returns {Promise<object|null>}
 */
async function create(db, fields = {}) {
  const {
    url,
    filename,
    original_name = null,
    title         = null,
    tags          = null,
    collection    = null,
    mime          = null,
    size          = null,
    width         = null,
    height        = null,
    visibility    = 'public',
    uploaded_by   = null,
  } = fields;

  if (!url)      throw new Error('assetService.create: url is required');
  if (!filename) throw new Error('assetService.create: filename is required');

  // Matches the migration backfill convention: title is COALESCE(title, original_name, filename).
  const finalTitle = title != null ? title : (original_name || filename);
  const finalTags  = normalizeTags(tags);
  const finalVis   = visibility === 'private' ? 'private' : 'public';

  // Row-alias upsert form (MySQL 8.0.19+; this DB is 8.4). Avoids the deprecated
  // VALUES() reference in ON DUPLICATE KEY UPDATE.
  await db.query(
    `INSERT INTO image_library
       (url, filename, original_name, title, tags, collection, mime, size, width, height, visibility, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       filename      = new.filename,
       original_name = new.original_name,
       title         = new.title,
       tags          = new.tags,
       collection    = new.collection,
       mime          = new.mime,
       size          = new.size,
       width         = new.width,
       height        = new.height,
       visibility    = new.visibility,
       uploaded_by   = new.uploaded_by`,
    [
      url, filename, original_name, finalTitle, finalTags, collection,
      mime, size, width, height, finalVis, uploaded_by,
    ],
  );

  // url is the dedup key and always present → reliable fetch whether we inserted or updated.
  const [rows] = await db.query('SELECT * FROM image_library WHERE url = ?', [url]);
  return rows.length ? rows[0] : null;
}

// ─────────────────────────────────────────────────────────────
// list
// ─────────────────────────────────────────────────────────────

/**
 * List assets with optional text search, collection/mime filters, sort, and paging.
 * Returns rows LEFT JOINed to users for `uploaded_by_name`, plus a total COUNT over
 * the same filter set (ignoring limit/offset).
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {string} [opts.q]                 free text over title/original_name/filename/tags
 * @param {string} [opts.collection]        exact match
 * @param {string} [opts.mime]              trailing '/' = prefix match (e.g. "image/"), else exact
 * @param {string} [opts.sort='newest']     newest|oldest|name|size
 * @param {number} [opts.limit=30]          clamped to [1,100]
 * @param {number} [opts.offset=0]          clamped to >= 0
 * @param {boolean}[opts.includeDeleted=false]
 * @returns {Promise<{assets: object[], total: number, limit: number, offset: number}>}
 */
async function list(db, opts = {}) {
  const {
    q,
    collection,
    mime,
    sort = 'newest',
    limit = 30,
    offset = 0,
    includeDeleted = false,
    collectionOrNull = false, // when true (with `collection` set): match that collection OR NULL
    maxLimit,                 // optional cap override for the limit clamp; default 100
  } = opts;
  const where  = [];
  const params = [];

  if (!includeDeleted) where.push('il.deleted_at IS NULL');

  if (collection != null && collection !== '') {
    if (collectionOrNull) {
      where.push('(il.collection = ? OR il.collection IS NULL)');
    } else {
      where.push('il.collection = ?');
    }
    params.push(collection);
  }

  if (mime != null && mime !== '') {
    if (String(mime).endsWith('/')) {
      where.push('il.mime LIKE ?');
      params.push(mime + '%');
    } else {
      where.push('il.mime = ?');
      params.push(mime);
    }
  }

  if (q != null && String(q).length) {
    // Search is LITERAL: escape LIKE wildcards in user input so '%', '_', and
    // '\' match themselves instead of acting as pattern metacharacters. Order
    // matters — escape the escape char (backslash) FIRST, then '%' and '_'.
    // We rely on MySQL's default LIKE escape character ('\'); this server's
    // sql_mode does NOT include NO_BACKSLASH_ESCAPES, so the default is active
    // and no explicit `ESCAPE` clause is needed.
    const escaped = String(q)
      .replace(/\\/g, '\\\\')   // \  -> \\
      .replace(/[%_]/g, '\\$&'); // %|_ -> \%|\_
    const like = '%' + escaped + '%';
    where.push('(il.title LIKE ? OR il.original_name LIKE ? OR il.filename LIKE ? OR il.tags LIKE ?)');
    params.push(like, like, like, like);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderSql = 'ORDER BY ' + (SORT_MAP[sort] || SORT_MAP.newest);

  // limit/offset are validated integers → safe to inline (avoids mysql2 LIMIT
  // placeholder quirks). Never interpolate the raw opt.
  let cap = Number.isFinite(Number(maxLimit)) ? Math.floor(Number(maxLimit)) : 100;
  cap = Math.min(Math.max(cap, 1), 1000);
  let lim = Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 30;
  lim = Math.min(Math.max(lim, 1), cap);
  let off = Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0;
  off = Math.max(off, 0);

  const [assets] = await db.query(
    `SELECT il.*, u.user_name AS uploaded_by_name
       FROM image_library il
       LEFT JOIN users u ON il.uploaded_by = u.user
       ${whereSql}
       ${orderSql}
       LIMIT ${lim} OFFSET ${off}`,
    params,
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM image_library il ${whereSql}`,
    params,
  );
  const total = countRows.length ? Number(countRows[0].total) : 0;

  return { assets, total, limit: lim, offset: off };
}

// ─────────────────────────────────────────────────────────────
// get / update / delete
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single asset row by id. RAW fetch — returns the row even if soft-deleted.
 * @param {object} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
async function get(db, id) {
  const [rows] = await db.query('SELECT * FROM image_library WHERE id = ?', [id]);
  return rows.length ? rows[0] : null;
}

/**
 * Partially update a live asset's editable fields (title, tags, collection).
 * Only fields present (not `undefined`) on `fields` are written; `tags` is
 * normalized. A missing or soft-deleted row yields null. With no editable fields
 * provided, returns the current live row unchanged.
 *
 * @param {object} db
 * @param {number} id
 * @param {object} [fields]
 * @returns {Promise<object|null>}
 */
async function update(db, id, fields = {}) {
  const sets   = [];
  const params = [];

  if (fields.title !== undefined) {
    sets.push('title = ?');
    params.push(fields.title);
  }
  if (fields.tags !== undefined) {
    sets.push('tags = ?');
    params.push(normalizeTags(fields.tags));
  }
  if (fields.collection !== undefined) {
    sets.push('collection = ?');
    params.push(fields.collection);
  }

  // Must report null for a missing/soft-deleted row. affectedRows can't tell us
  // that apart from "no value changed", so check for a live row explicitly first.
  const [live] = await db.query(
    'SELECT id FROM image_library WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  if (!live.length) return null;

  if (sets.length) {
    params.push(id);
    await db.query(
      `UPDATE image_library SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      params,
    );
  }

  return get(db, id);
}

/**
 * Soft-delete an asset (sets deleted_at). No-op if already deleted.
 * @param {object} db
 * @param {number} id
 * @returns {Promise<boolean>} true if a live row was marked deleted.
 */
async function softDelete(db, id) {
  const [r] = await db.query(
    'UPDATE image_library SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  return r.affectedRows > 0;
}

/**
 * Physically delete the row (NOT the GCS object). For v2 garbage-collection use;
 * unused for now. Callers are responsible for deleting the underlying object via
 * storageService.deleteObject when appropriate.
 * @param {object} db
 * @param {number} id
 * @returns {Promise<boolean>}
 */
async function hardDeleteRow(db, id) {
  const [r] = await db.query('DELETE FROM image_library WHERE id = ?', [id]);
  return r.affectedRows > 0;
}

module.exports = {
  normalizeTags,
  create,
  list,
  get,
  update,
  softDelete,
  hardDeleteRow,
};