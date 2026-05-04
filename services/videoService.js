/**
 * Video Service
 * services/videoService.js
 *
 * CRUD for the `videos` table. JSON columns (tags, related_video_ids, actions)
 * are stringified on write and parsed on read (handles both string and
 * already-parsed shapes returned by mysql2 across configs).
 *
 * Slice 1 scope: no view tracking, no related-video resolution, no audit logs.
 * GCS objects are intentionally orphaned on delete — see deleteVideo().
 */

const crypto = require('crypto');

// Whitelisted fields that PATCH /api/videos/:id is allowed to write.
// `slug` is intentionally excluded — slugs are immutable in v1.
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
 * Full slug = base + '-' + 4 hex chars. Exported for testing.
 */
function generateSlug(title) {
  return generateSlugBase(title) + '-' + crypto.randomBytes(2).toString('hex');
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
 * @param {object} opts  { mustBePublished?: boolean }  default true
 */
async function getVideoBySlug(db, slug, { mustBePublished = true } = {}) {
  const sql = mustBePublished
    ? 'SELECT * FROM videos WHERE slug = ? AND is_published = 1 LIMIT 1'
    : 'SELECT * FROM videos WHERE slug = ? LIMIT 1';
  const [rows] = await db.query(sql, [slug]);
  return rows.length ? hydrateRow(rows[0]) : null;
}

// ─────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────

/**
 * Create a video. Server generates slug — never trust client.
 * Retries up to 5 times on slug collision (regenerates the 4-hex suffix).
 */
async function createVideo(db, data) {
  if (!data.title || !data.title.trim()) {
    throw new Error('title is required');
  }
  if (!data.gcs_video_url) {
    throw new Error('gcs_video_url is required');
  }

  const base = generateSlugBase(data.title);

  // Build the column/value lists once — slug varies per attempt.
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

  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = base + '-' + crypto.randomBytes(2).toString('hex');
    baseValues[0] = slug;
    try {
      const [result] = await db.query(sql, baseValues);
      return await getVideoById(db, result.insertId);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') continue; // collision on slug — retry
      throw err;
    }
  }
  throw new Error('Could not generate unique slug after 5 attempts');
}

/**
 * Partial update. Whitelisted fields only; rejects `slug`.
 */
async function updateVideo(db, id, partial) {
  if (partial == null || typeof partial !== 'object') {
    throw new Error('Update body must be an object');
  }
  if ('slug' in partial) {
    const e = new Error('slug is not editable');
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

  if (!sets.length) {
    // Nothing to update — return current row so caller still gets fresh data.
    return await getVideoById(db, id);
  }

  values.push(id);
  const [result] = await db.query(
    `UPDATE videos SET ${sets.join(', ')} WHERE id = ?`,
    values,
  );
  if (!result.affectedRows) return null;
  return await getVideoById(db, id);
}

/**
 * DB delete only.
 *
 * GCS cleanup is intentionally deferred to a future ops task — orphaned
 * objects don't impact correctness and deletes are infrequent.
 */
async function deleteVideo(db, id) {
  const [result] = await db.query('DELETE FROM videos WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = {
  listVideos,
  getVideoById,
  getVideoBySlug,
  createVideo,
  updateVideo,
  deleteVideo,
  generateSlug,
  generateSlugBase,
};