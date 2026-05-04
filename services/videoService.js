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
 *     the alias of another) is enforced at the app layer in setSlugCanonical().
 *
 * Slice 2 additions: view tracking + related-videos resolution.
 *   - recordView: transactional INSERT into video_views + view_count++
 *   - recordPlayed / recordProgress / recordCtaClick: per-event updates
 *   - getRelatedVideos: hand-picked first, then tag-overlap auto-fill
 *
 * Notes on case_id resolution:
 *   - cases.case_id is varchar(20) (8-char alphanumeric).
 *   - video_views.case_id was migrated from int → varchar(20) for Slice 2.
 *   - Resolution rule: most recent OPEN case where contact is the PRIMARY
 *     party (case_relate.case_relate_type = 'Primary').
 *   - Anonymous views (no contactId) → case_id NULL.
 *   - Contact with no Primary open case → case_id NULL.
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
// Slice 2 helpers — IP hash, case resolution, JSON_OVERLAPS probe
// ─────────────────────────────────────────────────────────────

/**
 * SHA-256 of an IP. Stored in video_views.ip_hash so plain IPs never hit disk.
 */
function hashIp(ip) {
  return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex');
}

/**
 * Most-recent OPEN case where the given contact is the PRIMARY party.
 * Returns the case_id (varchar) or null. NULL on anonymous (contactId == null)
 * and on contacts with no open primary case.
 *
 * Verified column names against actual schema:
 *   - cases.case_id          (varchar(20))
 *   - cases.case_stage       (enum incl. 'Open')   — NOT case_status (free-form varchar)
 *   - cases.case_open_date   (date)
 *   - case_relate.case_relate_case_id    (FK to cases)
 *   - case_relate.case_relate_client_id  (FK to contacts)
 *   - case_relate.case_relate_type       (enum incl. 'Primary')
 */
async function resolveCaseIdForContact(db, contactId) {
  if (contactId == null) return null;
  const [rows] = await db.query(
    `SELECT c.case_id
       FROM cases c
       JOIN case_relate cr ON cr.case_relate_case_id = c.case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_type = 'Primary'
        AND c.case_stage = 'Open'
      ORDER BY c.case_open_date DESC, c.case_id DESC
      LIMIT 1`,
    [contactId]
  );
  return rows.length ? rows[0].case_id : null;
}

// JSON_OVERLAPS requires MySQL 8.0.17+. Probe once at first use, cache.
let _jsonOverlapsSupported = null;
async function _supportsJsonOverlaps(db) {
  if (_jsonOverlapsSupported !== null) return _jsonOverlapsSupported;
  try {
    await db.query("SELECT JSON_OVERLAPS(JSON_ARRAY(1), JSON_ARRAY(1)) AS t");
    _jsonOverlapsSupported = true;
  } catch {
    _jsonOverlapsSupported = false;
  }
  return _jsonOverlapsSupported;
}

/** For test harness / report-out. */
function getJsonOverlapsCachedStatus() {
  return _jsonOverlapsSupported;
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
 * @returns {object|null} video row plus a `_resolvedVia` field:
 *                        'canonical' | 'alias'.
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
 * List historical aliases for a given video (newest first).
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

    await conn.query(
      'DELETE FROM video_slug_aliases WHERE slug = ? AND video_id = ?',
      [newSlug, videoId],
    );

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

  if ('slug' in partial && typeof partial.slug === 'string' && partial.slug.trim()) {
    await setSlugCanonical(db, id, partial.slug.trim());
  } else if ('slug' in partial && (partial.slug === '' || partial.slug == null)) {
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
      return null;
    }
  }

  return await getVideoById(db, id);
}

/**
 * DB delete only. GCS objects intentionally orphaned. Aliases cascade.
 */
async function deleteVideo(db, id) {
  const [result] = await db.query('DELETE FROM videos WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// Slice 2 — view tracking
// ─────────────────────────────────────────────────────────────

/**
 * Record a page-open. Single transaction:
 *   1. Resolve case_id from contactId (if any) — most recent open case
 *      where contact is Primary.
 *   2. INSERT video_views row.
 *   3. UPDATE videos.view_count += 1.
 *
 * Returns the new view's id (BIGINT). Caller should String() it before
 * embedding in HTML to be safe with values > Number.MAX_SAFE_INTEGER,
 * though we won't reach that range in practice.
 *
 * @param {object} pool   mysql2 pool (must support getConnection)
 * @param {object} args
 * @param {number} args.videoId
 * @param {number|null} args.contactId
 * @param {string} args.ipHash      64-char hex (use hashIp())
 * @param {string} args.userAgent   capped at 255 chars
 * @returns {Promise<{viewId: number}>}
 */
async function recordView(pool, { videoId, contactId, ipHash, userAgent }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let caseId = null;
    if (contactId != null) {
      const [rows] = await conn.query(
        `SELECT c.case_id
           FROM cases c
           JOIN case_relate cr ON cr.case_relate_case_id = c.case_id
          WHERE cr.case_relate_client_id = ?
            AND cr.case_relate_type = 'Primary'
            AND c.case_stage = 'Open'
          ORDER BY c.case_open_date DESC, c.case_id DESC
          LIMIT 1`,
        [contactId]
      );
      caseId = rows.length ? rows[0].case_id : null;
    }

    const [result] = await conn.query(
      `INSERT INTO video_views (video_id, contact_id, case_id, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [videoId, contactId, caseId, ipHash || null, (userAgent || '').slice(0, 255) || null]
    );

    await conn.query(
      'UPDATE videos SET view_count = view_count + 1 WHERE id = ?',
      [videoId]
    );

    await conn.commit();
    return { viewId: result.insertId };
  } catch (err) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Mark first-play. Idempotent: re-firing 'play' (e.g. after pause+play, or
 * on a seek-replay) does not overwrite the original played_at timestamp.
 */
async function recordPlayed(db, { viewId, videoId }) {
  await db.query(
    `UPDATE video_views
        SET played_at = COALESCE(played_at, NOW())
      WHERE id = ? AND video_id = ?`,
    [viewId, videoId]
  );
}

/**
 * Update progress monotonically. Coerces inputs and clamps:
 *   watchSeconds  → [0, 86400]   (24h cap to keep ints sane)
 *   completionPct → [0, 100]
 * Uses GREATEST in SQL so a backward seek can't regress the stored value.
 */
async function recordProgress(db, { viewId, videoId, watchSeconds, completionPct }) {
  const ws  = Math.max(0, Math.min(86400, parseInt(watchSeconds,  10) || 0));
  const pct = Math.max(0, Math.min(100,   parseInt(completionPct, 10) || 0));
  await db.query(
    `UPDATE video_views
        SET watch_seconds  = GREATEST(watch_seconds,  ?),
            completion_pct = GREATEST(completion_pct, ?)
      WHERE id = ? AND video_id = ?`,
    [ws, pct, viewId, videoId]
  );
}

/**
 * Append a CTA click event to the cta_clicks JSON array.
 * Label is capped at 200 chars.
 */
async function recordCtaClick(db, { viewId, videoId, label }) {
  const trimmedLabel = String(label || '').slice(0, 200);
  const ts = new Date().toISOString();
  await db.query(
    `UPDATE video_views
        SET cta_clicks = JSON_ARRAY_APPEND(
              COALESCE(cta_clicks, JSON_ARRAY()),
              '$',
              JSON_OBJECT('label', ?, 'clicked_at', ?)
            )
      WHERE id = ? AND video_id = ?`,
    [trimmedLabel, ts, viewId, videoId]
  );
}

// ─────────────────────────────────────────────────────────────
// Slice 3.5 — analytics
// ─────────────────────────────────────────────────────────────

/**
 * Aggregate analytics for a single video.
 *
 * Returns:
 *   {
 *     total_views, identified_views, anonymous_views,
 *     played_count, completed_count, avg_completion_pct,
 *     cta_clicks_by_label: [{ label, count }, ...]   // descending
 *   }
 *
 * For a video with zero views: all numeric fields = 0, cta array empty.
 *
 * Two queries: one for the scalars (single SELECT), one for CTA aggregation
 * via JSON_TABLE. CTA query is wrapped in try/catch — falls back to JS
 * aggregation if JSON_TABLE is unavailable on the running MySQL version.
 *
 * mysql2 returns Decimal/string for SUM and AVG; coerce with Number().
 */
async function getVideoAnalytics(db, videoId) {
  const [scalarRows] = await db.query(
    `SELECT
        COUNT(*)                                                  AS total_views,
        SUM(CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END)   AS identified_views,
        SUM(CASE WHEN contact_id IS NULL     THEN 1 ELSE 0 END)   AS anonymous_views,
        SUM(CASE WHEN played_at  IS NOT NULL THEN 1 ELSE 0 END)   AS played_count,
        SUM(CASE WHEN completion_pct = 100   THEN 1 ELSE 0 END)   AS completed_count,
        ROUND(AVG(completion_pct))                                AS avg_completion_pct
       FROM video_views
      WHERE video_id = ?`,
    [videoId]
  );

  const r = scalarRows[0] || {};
  const result = {
    total_views:         Number(r.total_views)        || 0,
    identified_views:    Number(r.identified_views)   || 0,
    anonymous_views:     Number(r.anonymous_views)    || 0,
    played_count:        Number(r.played_count)       || 0,
    completed_count:     Number(r.completed_count)    || 0,
    avg_completion_pct:  Number(r.avg_completion_pct) || 0,
    cta_clicks_by_label: [],
  };

  // No views → no cta query needed.
  if (result.total_views === 0) return result;

  // Preferred path: JSON_TABLE expansion + GROUP BY.
  try {
    const [ctaRows] = await db.query(
      `SELECT jt.label, COUNT(*) AS cnt
         FROM video_views vv,
              JSON_TABLE(vv.cta_clicks, '$[*]'
                COLUMNS (label VARCHAR(200) PATH '$.label')) jt
        WHERE vv.video_id = ?
          AND vv.cta_clicks IS NOT NULL
        GROUP BY jt.label
        ORDER BY cnt DESC, jt.label ASC`,
      [videoId]
    );
    result.cta_clicks_by_label = ctaRows.map(row => ({
      label: row.label,
      count: Number(row.cnt) || 0,
    }));
  } catch (err) {
    // JSON_TABLE unavailable (very old MySQL) or some other SQL error.
    // Fall back to JS aggregation.
    console.warn('[getVideoAnalytics] JSON_TABLE path failed, falling back to JS aggregation:', err.message);
    const [rows] = await db.query(
      `SELECT cta_clicks
         FROM video_views
        WHERE video_id = ? AND cta_clicks IS NOT NULL`,
      [videoId]
    );
    const counts = new Map();
    for (const row of rows) {
      const arr = parseJsonField(row.cta_clicks);
      if (!Array.isArray(arr)) continue;
      for (const click of arr) {
        if (click && typeof click.label === 'string') {
          counts.set(click.label, (counts.get(click.label) || 0) + 1);
        }
      }
    }
    result.cta_clicks_by_label = Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  return result;
}

/**
 * Resolve up to `limit` related videos for the given video.
 *
 * Order:
 *   1. Hand-picked from videos.related_video_ids, in the array's order.
 *      Only published videos make the list. Missing/unpublished IDs are
 *      silently skipped.
 *   2. If autoFill && fewer than `limit` so far, top up with random
 *      published videos that share at least one tag with this video.
 *      Excludes the current video and anything already in the list.
 *
 * Tag matching uses JSON_OVERLAPS (MySQL 8.0.17+) when supported; falls back
 * to JSON_TABLE + IN(...) otherwise. Probe runs once per process.
 *
 * @param {object} db
 * @param {number} videoId
 * @param {object} [opts]
 * @param {boolean} [opts.autoFill=true]  if false, returns only hand-picked
 * @param {number}  [opts.limit=3]        max items returned
 * @returns {Promise<object[]>}  rows with id, slug, title, gcs_poster_url,
 *                               gcs_gif_url, tags (JSON-hydrated). Up to limit.
 */
async function getRelatedVideos(db, videoId, { autoFill = true, limit = 3 } = {}) {
  const [vRows] = await db.query(
    'SELECT id, related_video_ids, tags FROM videos WHERE id = ? LIMIT 1',
    [videoId]
  );
  if (!vRows.length) return [];

  const handPicked = parseJsonField(vRows[0].related_video_ids) || [];
  const tags       = parseJsonField(vRows[0].tags) || [];

  const picked = [];

  // 1. Resolve hand-picked, preserving their declared order.
  if (Array.isArray(handPicked) && handPicked.length) {
    const validIds = handPicked
      .map(n => parseInt(n, 10))
      .filter(n => Number.isInteger(n) && n > 0);

    if (validIds.length) {
      const placeholders = validIds.map(() => '?').join(',');
      const [rows] = await db.query(
        `SELECT id, slug, title, gcs_poster_url, gcs_gif_url, tags
           FROM videos
          WHERE id IN (${placeholders})
            AND is_published = 1
            AND id != ?`,
        [...validIds, videoId]
      );
      // Re-order to match validIds order, capped at limit.
      for (const id of validIds) {
        if (picked.length >= limit) break;
        const row = rows.find(r => r.id === id);
        if (row) picked.push(hydrateRow(row));
      }
    }
  }

  // 2. Auto-fill if requested and we have room and the source video has tags.
  if (autoFill && picked.length < limit && Array.isArray(tags) && tags.length) {
    const fillCount = limit - picked.length;
    const excludedIds = [videoId, ...picked.map(p => p.id)];
    const excludePh   = excludedIds.map(() => '?').join(',');

    const overlapsOk = await _supportsJsonOverlaps(db);

    let fillRows = [];
    try {
      if (overlapsOk) {
        const [rows] = await db.query(
          `SELECT id, slug, title, gcs_poster_url, gcs_gif_url, tags
             FROM videos
            WHERE id NOT IN (${excludePh})
              AND is_published = 1
              AND JSON_OVERLAPS(tags, CAST(? AS JSON))
            ORDER BY RAND()
            LIMIT ?`,
          [...excludedIds, JSON.stringify(tags), fillCount]
        );
        fillRows = rows;
      } else {
        const tagPh = tags.map(() => '?').join(',');
        const [rows] = await db.query(
          `SELECT id, slug, title, gcs_poster_url, gcs_gif_url, tags
             FROM videos
            WHERE id NOT IN (${excludePh})
              AND is_published = 1
              AND EXISTS (
                SELECT 1
                  FROM JSON_TABLE(tags, '$[*]' COLUMNS (tag VARCHAR(255) PATH '$')) jt
                 WHERE jt.tag IN (${tagPh})
              )
            ORDER BY RAND()
            LIMIT ?`,
          [...excludedIds, ...tags, fillCount]
        );
        fillRows = rows;
      }
    } catch (err) {
      // If JSON_OVERLAPS path failed mid-flight (e.g. server upgraded
      // mid-process and the probe was stale), don't blow up the landing —
      // skip auto-fill silently and log.
      console.warn('[getRelatedVideos] auto-fill query failed:', err.message);
    }

    for (const r of fillRows) picked.push(hydrateRow(r));
  }

  return picked.slice(0, limit);
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
  // Slice 2
  recordView,
  recordPlayed,
  recordProgress,
  recordCtaClick,
  getRelatedVideos,
  getVideoAnalytics,
  hashIp,
  resolveCaseIdForContact,
  getJsonOverlapsCachedStatus,
};