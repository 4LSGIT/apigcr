/**
 * Video Service
 * services/videoService.js
 *
 * CRUD for the `videos` table. JSON columns (tags, related_video_ids, actions)
 * are stringified on write and parsed on read.
 *
 * Slug handling:
 *   - `videos.slug` is the canonical/current slug.
 *   - Old slugs are archived into `video_slug_aliases` on change.
 *   - The landing route looks up canonical first, then alias.
 *   - Cross-table uniqueness (a slug can't be the canonical of one video AND
 *     the alias of another) is enforced at the app layer in setSlugChanged().
 *
 * Slice 1 scope: no view tracking, no related-video resolution, no audit logs.
 * GCS objects are intentionally orphaned on delete — see deleteVideo().
 */

const crypto = require('crypto');

// Whitelisted fields that PATCH /api/videos/:id is allowed to write.
// `slug` is handled separately (see updateVideo) because it requires
// alias-archival logic and a transaction.
const UPDATABLE_FIELDS = [
  'title',
  'description',
  'gcs_video_url',
  'gcs_poster_url',
  'gcs_gif_url',
  'duration_seconds',
  'tags',
  'related_video_ids',
  'actions',
  'access_level',
  'is_published',
];

const JSON_FIELDS = ['tags', 'related_video_ids', 'actions'];

// Slug must be lowercase alphanumeric + single hyphens, no leading/trailing
// hyphens, no double hyphens, length 1-64.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * mysql2 may auto-parse JSON columns or return strings depending on driver
 * config and column type. Handle both.
 */
function parseJsonField(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
}

function hydrateRow(row) {
  if (!row) return row;
  for (const f of JSON_FIELDS) {
    if (f in row) row[f] = parseJsonField(row[f]);
  }
  return row;
}

/**
 * Slug base: lowercase, ASCII-only, hyphenated, capped at 55 chars.
 * Returns 'video' if input becomes empty after sanitization.
 */
function generateSlugBase(title) {
  const s = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')      // non-alphanumeric → hyphen
    .replace(/-+/g, '-')              // collapse runs
    .replace(/^-|-$/g, '')            // trim ends
    .slice(0, 55)
    .replace(/-+$/, '');              // re-trim if slice landed on a hyphen
  return s || 'video';
}

/**
 * Full auto-generated slug = base + '-' + 4 hex chars. Exported for testing.
 */
function generateSlug(title) {
  return generateSlugBase(title) + '-' + crypto.randomBytes(2).toString('hex');
}

function validateSlug(slug) {
  if (typeof slug !== 'string' || !slug) {
    const e = new Error('slug must be a non-empty string');
    e.statusCode = 400;
    throw e;
  }
  if (slug.length > 64) {
    const e = new Error('slug must be 64 characters or fewer');
    e.statusCode = 400;
    throw e;
  }
  if (!SLUG_RE.test(slug)) {
    const e = new Error(
      'slug must be lowercase alphanumeric with single hyphens (e.g. "my-video-title"); '
      + 'no leading/trailing hyphens, no double hyphens, no other punctuation',
    );
    e.statusCode = 400;
    throw e;
  }
}

/**
 * Throws 409 if `slug` is in use by a different video — either as canonical
 * (`videos.slug`) or as alias (`video_slug_aliases.slug`).
 *
 * @param db        connection or pool
 * @param slug      candidate slug
 * @param ownerId   id of the video that "owns" this slug attempt (so we
 *                  don't false-conflict against itself); pass null on create.
 */
async function assertSlugAvailable(db, slug, ownerId) {
  const [vRows] = await db.query(
    'SELECT id FROM videos WHERE slug = ? LIMIT 1',
    [slug],
  );
  if (vRows.length && vRows[0].id !== ownerId) {
    const e = new Error(`Slug "${slug}" is already in use`);
    e.statusCode = 409;
    throw e;
  }

  const [aRows] = await db.query(
    'SELECT video_id FROM video_slug_aliases WHERE slug = ? LIMIT 1',
    [slug],
  );
  if (aRows.length && aRows[0].video_id !== ownerId) {
    const e = new Error(`Slug "${slug}" is already in use`);
    e.statusCode = 409;
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db    mysql2 pool/connection
 * @param {object} opts  { published?: '0'|'1'|0|1, tag?: string }
 */
async function listVideos(db, { published, tag } = {}) {
  const wheres = [];
  const params = [];

  if (published === '1' || published === 1 || published === true) {
    wheres.push('is_published = 1');
  } else if (published === '0' || published === 0 || published === false) {
    wheres.push('is_published = 0');
  }

  if (tag) {
    wheres.push('JSON_CONTAINS(tags, JSON_QUOTE(?))');
    params.push(String(tag));
  }

  const sql = `
    SELECT *
    FROM videos
    ${wheres.length ? 'WHERE ' + wheres.join(' AND ') : ''}
    ORDER BY created_at DESC
  `;
  const [rows] = await db.query(sql, params);
  return rows.map(hydrateRow);
}

async function getVideoById(db, id) {
  const [rows] = await db.query('SELECT * FROM videos WHERE id = ? LIMIT 1', [id]);
  return rows.length ? hydrateRow(rows[0]) : null;
}

/**
 * Look up by canonical slug first, then fall back to alias.
 *
 * @param {object} opts  { mustBePublished?: boolean }  default true
 * @returns {object|null} video row plus a `_resolvedVia` field:
 *                        'canonical' | 'alias'. Useful if a caller wants
 *                        to redirect alias hits to the canonical URL
 *                        (out of scope for Slice 1).
 */
async function getVideoBySlug(db, slug, { mustBePublished = true } = {}) {
  const pubClause = mustBePublished ? ' AND is_published = 1' : '';

  const [direct] = await db.query(
    'SELECT * FROM videos WHERE slug = ?' + pubClause + ' LIMIT 1',
    [slug],
  );
  if (direct.length) {
    const v = hydrateRow(direct[0]);
    v._resolvedVia = 'canonical';
    return v;
  }

  const [aliased] = await db.query(
    `SELECT v.*
     FROM video_slug_aliases a
     JOIN videos v ON v.id = a.video_id
     WHERE a.slug = ?` + pubClause + ' LIMIT 1',
    [slug],
  );
  if (aliased.length) {
    const v = hydrateRow(aliased[0]);
    v._resolvedVia = 'alias';
    return v;
  }

  return null;
}

/**
 * List historical aliases for a given video (newest first). Used by the
 * admin UI to surface what URLs still resolve.
 */
async function listAliasesForVideo(db, videoId) {
  const [rows] = await db.query(
    'SELECT slug, archived_at FROM video_slug_aliases WHERE video_id = ? ORDER BY archived_at DESC',
    [videoId],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────

/**
 * Create a video.
 *
 * Slug behavior:
 *   - If `data.slug` is provided and non-empty: validated and used as-is;
 *     409 if already taken (canonical or alias of another video).
 *   - If `data.slug` is empty/missing: auto-generated from title with a
 *     4-hex random suffix; up to 5 collision retries.
 */
async function createVideo(db, data) {
  if (!data.title || !data.title.trim()) {
    const e = new Error('title is required');
    e.statusCode = 400;
    throw e;
  }
  if (!data.gcs_video_url) {
    const e = new Error('gcs_video_url is required');
    e.statusCode = 400;
    throw e;
  }

  const userSuppliedSlug =
    typeof data.slug === 'string' && data.slug.trim() ? data.slug.trim() : null;

  if (userSuppliedSlug) {
    validateSlug(userSuppliedSlug);
    await assertSlugAvailable(db, userSuppliedSlug, null);
  }

  // Build the column/value lists. `slug` value varies per attempt when
  // auto-generating; fixed when user-supplied.
  const cols = [
    'slug', 'title', 'description',
    'gcs_video_url', 'gcs_poster_url', 'gcs_gif_url',
    'duration_seconds', 'tags', 'related_video_ids', 'actions',
    'access_level', 'is_published',
  ];

  const baseValues = [
    /* slug — set per attempt */ null,
    data.title,
    data.description ?? null,
    data.gcs_video_url,
    data.gcs_poster_url ?? null,
    data.gcs_gif_url ?? null,
    Number.isFinite(data.duration_seconds) ? data.duration_seconds : null,
    data.tags != null ? JSON.stringify(data.tags) : null,
    data.related_video_ids != null ? JSON.stringify(data.related_video_ids) : null,
    data.actions != null ? JSON.stringify(data.actions) : null,
    data.access_level === 'contact_only' ? 'contact_only' : 'public',
    data.is_published ? 1 : 0,
  ];

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO videos (${cols.join(', ')}) VALUES (${placeholders})`;

  if (userSuppliedSlug) {
    baseValues[0] = userSuppliedSlug;
    try {
      const [result] = await db.query(sql, baseValues);
      return await getVideoById(db, result.insertId);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // Race: assertSlugAvailable passed but another insert grabbed it
        // between then and now. Surface as a 409.
        const e = new Error(`Slug "${userSuppliedSlug}" is already in use`);
        e.statusCode = 409;
        throw e;
      }
      throw err;
    }
  }

  const base = generateSlugBase(data.title);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = base + '-' + crypto.randomBytes(2).toString('hex');
    baseValues[0] = slug;
    try {
      const [result] = await db.query(sql, baseValues);
      return await getVideoById(db, result.insertId);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') continue;
      throw err;
    }
  }
  throw new Error('Could not generate unique slug after 5 attempts');
}

/**
 * Atomically swap the canonical slug. Old slug becomes an alias; new slug
 * becomes canonical.
 *
 *   - 409 if the new slug is in use by a different video.
 *   - If the new slug is already an alias of THIS video (e.g. the user is
 *     reverting), it's removed from aliases first so it can become canonical.
 *
 * Wrapped in a transaction so partial state can't leak on error.
 */
async function setSlugCanonical(pool, videoId, newSlug) {
  validateSlug(newSlug);

  const [curRows] = await pool.query(
    'SELECT slug FROM videos WHERE id = ? LIMIT 1',
    [videoId],
  );
  if (!curRows.length) {
    const e = new Error('Video not found');
    e.statusCode = 404;
    throw e;
  }
  const oldSlug = curRows[0].slug;
  if (oldSlug === newSlug) return; // no-op

  await assertSlugAvailable(pool, newSlug, videoId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // If newSlug is in this video's own aliases, remove it (it's becoming canonical).
    await conn.query(
      'DELETE FROM video_slug_aliases WHERE slug = ? AND video_id = ?',
      [newSlug, videoId],
    );

    // Free the canonical slug slot first to avoid the UNIQUE constraint
    // colliding with itself when the old slug isn't yet archived. We do this
    // by archiving the old slug to aliases, but the alias INSERT must come
    // BEFORE the canonical UPDATE if the new slug equals an existing alias
    // of another video — but assertSlugAvailable already ruled that out.
    //
    // Order: INSERT alias (using REPLACE in case of a stale alias row from
    // a prior cycle) → UPDATE canonical.
    await conn.query(
      'REPLACE INTO video_slug_aliases (slug, video_id) VALUES (?, ?)',
      [oldSlug, videoId],
    );

    await conn.query(
      'UPDATE videos SET slug = ? WHERE id = ?',
      [newSlug, videoId],
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      const e = new Error(`Slug "${newSlug}" is already in use`);
      e.statusCode = 409;
      throw e;
    }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Partial update. Whitelisted fields only. `slug` is handled out-of-band
 * via setSlugCanonical (transaction + alias archival).
 */
async function updateVideo(db, id, partial) {
  if (partial == null || typeof partial !== 'object') {
    throw new Error('Update body must be an object');
  }

  // Slug change runs first — its own transaction. If it throws, the rest
  // doesn't apply (consistent with "validate everything before any write").
  if ('slug' in partial && typeof partial.slug === 'string' && partial.slug.trim()) {
    await setSlugCanonical(db, id, partial.slug.trim());
  } else if ('slug' in partial && (partial.slug === '' || partial.slug == null)) {
    // Explicitly blank slug in PATCH is not permitted (would orphan URLs).
    const e = new Error('slug cannot be set to empty');
    e.statusCode = 400;
    throw e;
  }

  const sets = [];
  const values = [];

  for (const f of UPDATABLE_FIELDS) {
    if (!(f in partial)) continue;
    const v = partial[f];

    if (JSON_FIELDS.includes(f)) {
      sets.push(`${f} = ?`);
      values.push(v == null ? null : JSON.stringify(v));
    } else if (f === 'is_published') {
      sets.push(`${f} = ?`);
      values.push(v ? 1 : 0);
    } else if (f === 'access_level') {
      sets.push(`${f} = ?`);
      values.push(v === 'contact_only' ? 'contact_only' : 'public');
    } else if (f === 'duration_seconds') {
      sets.push(`${f} = ?`);
      values.push(Number.isFinite(v) ? v : null);
    } else {
      sets.push(`${f} = ?`);
      values.push(v ?? null);
    }
  }

  if (sets.length) {
    values.push(id);
    const [result] = await db.query(
      `UPDATE videos SET ${sets.join(', ')} WHERE id = ?`,
      values,
    );
    if (!result.affectedRows && !('slug' in partial)) {
      // Only treat "not found" as terminal if no slug change happened —
      // a slug change with no other fields is still a successful update.
      return null;
    }
  }

  return await getVideoById(db, id);
}

/**
 * DB delete only.
 *
 * GCS cleanup is intentionally deferred to a future ops task — orphaned
 * objects don't impact correctness and deletes are infrequent.
 *
 * Aliases are removed automatically via FK ON DELETE CASCADE.
 */
async function deleteVideo(db, id) {
  const [result] = await db.query('DELETE FROM videos WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = {
  listVideos,
  getVideoById,
  getVideoBySlug,
  listAliasesForVideo,
  createVideo,
  updateVideo,
  deleteVideo,
  setSlugCanonical,
  generateSlug,
  generateSlugBase,
  validateSlug,
};