// services/videoService.js
//
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
 *   - cases.case_id is varchar(20) — 8 opaque chars, new ids uppercase
 *     Base32 / legacy ids mixed-case base64url (minted only by lib/caseId.js).
 *   - video_views.case_id was migrated from int → varchar(20) for Slice 2.
 *   - Resolution rule: the contact's best PRIMARY case
 *     (case_relate.case_relate_type = 'Primary'), any stage. Active stages
 *     (Open, Filed, Pending) rank first, then Concluded, then Closed; newest
 *     case_open_date within a rank. Open alone missed every Filed client —
 *     the 341 videos' whole audience.
 *   - Anonymous views (no contactId) → case_id NULL.
 *   - Contact with no Primary case → case_id NULL.
 */

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { generateToken } = require('../lib/token');
const { escapeLike } = require('../lib/escapeLike');
const { FIRM_TZ } = require('./timezoneService');

// The share of a video that must really have played for a view to count as
// completed. Near the end, not the end: people close the tab during an outro.
const COMPLETE_PCT = 90;

// Whitelisted fields that PATCH /api/videos/:id is allowed to write.
// `slug` is handled separately (see updateVideo) because it requires
// alias-archival logic and a transaction.
// ─────────────────────────────────────────────────────────────
// Action-URL scheme allowlist (2026-08-17 XSS fix)
//
// videos.actions[].config.url is staff-authored (jwtOrApiKey — ANY staff
// member) and rendered into an <a href> on the public landing page by
// routes/videoLanding.js. htmlEscape prevents attribute breakout but does
// NOT constrain the URL scheme — javascript: in an href executes on click
// regardless of escaping, and the page serves on the app origin today, where
// the staff JWT lives in localStorage. Hence a hard scheme allowlist,
// enforced in BOTH places:
//   - on write (createVideo / updateVideo → validateActions) so authors get
//     a clear 400 instead of silent breakage — mandatory because the API is
//     reachable without the manager UI;
//   - at render (videoLanding renderActions → isSafeActionUrl) as the
//     authoritative gate over whatever is already stored.
//
// Allowed: https:, http:, mailto:, tel:, and ROOT-RELATIVE paths ("/book/…"
// is a real use case — booking lives on the same public host). Rejected:
// every other scheme, protocol-relative "//host", and bare relative forms
// ("foo", "?x", "#x" — nothing legitimate mints those here, and rejecting
// them keeps the rule binary).
//
// Scheme detection strips C0 controls and spaces first because browsers do
// the same before parsing a scheme ("java\tscript:" and "\x00javascript:"
// are both live javascript: URLs). Percent-encoded schemes need no special
// case: browsers do NOT percent-decode before scheme parsing, so
// "%6Aavascript:…" is a (rejected) schemeless relative URL, not a scheme.
//
// Future action types that carry a URL must run their URL through
// isSafeActionUrl too — that keeps the "additive on both sides" contract in
// videoLanding.renderActions intact: one shared rule, no second list.
// ─────────────────────────────────────────────────────────────

const SAFE_ACTION_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:']);

/**
 * @param {string} raw  candidate href (AFTER any {{c}}/{{ct}} substitution when
 *                      called at render time; template form is fine on write
 *                      because callers substitute a digit first)
 * @returns {boolean}
 */
function isSafeActionUrl(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // Browsers ignore C0 control chars and spaces when parsing a scheme.
  const probe = trimmed.replace(/[\u0000-\u0020]/g, '');
  if (!probe) return false;
  if (probe.startsWith('//')) return false; // protocol-relative → other hosts
  const m = probe.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (m) return SAFE_ACTION_SCHEMES.has(m[1].toLowerCase() + ':');
  return probe.startsWith('/'); // schemeless → root-relative only
}

/**
 * Validate an actions array on the write path. Throws statusCode=400 with
 * the offending index so the manager UI's "Save failed" toast is actionable.
 * Shape mistakes other than the URL are NOT this function's job — unknown
 * types remain render-time-skipped by contract.
 */
function validateActions(actions) {
  if (actions == null) return;
  if (!Array.isArray(actions)) {
    const e = new Error('actions must be an array');
    e.statusCode = 400;
    throw e;
  }
  actions.forEach((a, i) => {
    if (a?.type !== 'url') return; // future types validate their own URLs
    const raw = String(a.config?.url || '');
    // Validate the representative substituted form. {{c}}/{{ct}} only ever
    // become a contacts.contact_token (base62/hex, PUBLIC_TOKEN_RE class) or
    // empty — neither can introduce a URL scheme — so a fixed stand-in is a
    // faithful probe.
    if (!isSafeActionUrl(raw.replace(/\{\{ct\}\}/g, '1').replace(/\{\{c\}\}/g, '1'))) {
      const e = new Error(
        `actions[${i}].config.url has a disallowed URL scheme — ` +
        'use https:, http:, mailto:, tel:, or a root-relative path ("/…")'
      );
      e.statusCode = 400;
      throw e;
    }
  });
}

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
 * Keyed hash of an IP, stored in video_views.ip_hash so plain IPs never hit
 * disk. Keyed because the IPv4 space is small enough to walk: a plain SHA-256
 * reads back as the address. Rows before 2026-11-01 hold that plain hash, and
 * rotating JWT_SECRET only breaks same-device grouping across the rotation.
 */
function hashIp(ip) {
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || ''))
    .update('video-ip:' + String(ip || 'unknown'))
    .digest('hex');
}

/**
 * The case a contact's view belongs to: their best PRIMARY case, any stage
 * (ranking in the file header). Returns the case_id (varchar) or null. NULL on
 * anonymous (contactId == null) and on contacts with no primary case.
 *
 * Verified column names against actual schema:
 *   - cases.case_id          (varchar(20))
 *   - cases.case_stage       (enum Open/Pending/Filed/Concluded/Closed)
 *                                                   — NOT case_status (free-form varchar)
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
      ORDER BY CASE WHEN c.case_stage IN ('Open','Filed','Pending') THEN 0
                    WHEN c.case_stage = 'Concluded' THEN 1
                    ELSE 2 END,
               c.case_open_date DESC, c.case_id DESC
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

  validateActions(data.actions);

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

  await pool.withTransaction(async (conn) => {

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
  }).catch((err) => {
    if (err.code === 'ER_DUP_ENTRY') {
      const e = new Error(`Slug "${newSlug}" is already in use`);
      e.statusCode = 409;
      throw e;
    }
    throw err;
  });
}

/**
 * Partial update. Whitelisted fields only. `slug` is handled out-of-band
 * via setSlugCanonical (transaction + alias archival).
 */
async function updateVideo(db, id, partial) {
  if (partial == null || typeof partial !== 'object') {
    throw new Error('Update body must be an object');
  }

  if ('actions' in partial) validateActions(partial.actions);

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
 * DB delete only. GCS objects intentionally orphaned. Aliases AND every
 * video_views row cascade (FK ON DELETE CASCADE) — the view history goes too,
 * which the manager's confirmation says.
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
 *   1. Resolve case_id from contactId (if any) — resolveCaseIdForContact.
 *   2. UPDATE videos.view_count += 1.
 *   3. INSERT video_views row.
 *
 * The UPDATE comes first on purpose. The INSERT's foreign key takes a shared
 * lock on the videos row, so two opens inserting first each hold it, each need
 * the exclusive lock, and MySQL kills one: a carrier fetching a link twice at
 * once would lose a view. withTransaction doesn't retry a deadlock.
 *
 * Returns the new view's id (BIGINT). Caller should String() it before
 * embedding in HTML to be safe with values > Number.MAX_SAFE_INTEGER,
 * though we won't reach that range in practice. Also returns the view's
 * track_token, the page's proof that it may report on this view: ids are
 * sequential, so the id alone let anyone write to any view.
 *
 * @param {object} pool   mysql2 pool (must support getConnection)
 * @param {object} args
 * @param {number} args.videoId
 * @param {number|null} args.contactId
 * @param {string} args.ipHash      64-char hex (use hashIp())
 * @param {string} args.userAgent   capped at 255 chars
 * @returns {Promise<{viewId: number, trackToken: string}>}
 */
async function recordView(pool, { videoId, contactId, ipHash, userAgent }) {
  const trackToken = generateToken();
  const viewId = await pool.withTransaction(async (conn) => {

    const caseId = await resolveCaseIdForContact(conn, contactId);

    await conn.query(
      'UPDATE videos SET view_count = view_count + 1 WHERE id = ?',
      [videoId]
    );

    const [result] = await conn.query(
      `INSERT INTO video_views (video_id, contact_id, case_id, ip_hash, user_agent, track_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [videoId, contactId, caseId, ipHash || null, (userAgent || '').slice(0, 255) || null, trackToken]
    );

    return result.insertId;
  });
  return { viewId, trackToken };
}

/**
 * Does this request hold the view's track_token? Compared here in constant
 * time, since these are anonymous endpoints. A view recorded before tokens
 * existed holds NULL and always refuses.
 */
async function checkTrackToken(db, { viewId, videoId, token }) {
  if (typeof token !== 'string' || !token) return false;
  const [rows] = await db.query(
    'SELECT track_token FROM video_views WHERE id = ? AND video_id = ? LIMIT 1',
    [viewId, videoId]
  );
  const stored = rows.length ? rows[0].track_token : null;
  if (!stored) return false;
  const a = Buffer.from(token), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
 *
 * Both values are what really played, from the browser's own played ranges,
 * so dragging to the end adds nothing and watching a section twice counts once.
 *
 * Stamps completed_at the first time the view crosses COMPLETE_PCT. It is a
 * conditional UPDATE so exactly one call sees completedNow:true, however many
 * beacons race, because the crossing can arrive on any progress beacon.
 *
 * @returns {Promise<{completedNow: boolean}>}
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
  const [claim] = await db.query(
    `UPDATE video_views
        SET completed_at = NOW()
      WHERE id = ? AND video_id = ?
        AND completed_at IS NULL
        AND completion_pct >= ?`,
    [viewId, videoId, COMPLETE_PCT]
  );
  return { completedNow: claim.affectedRows === 1 };
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
 *     cta_clicks_by_label: [{ label, count }, ...],   // descending
 *     analytics_reset_at: ISO string | null            // 3.6 addition
 *   }
 *
 * For a video with zero views (or zero post-reset views): all numeric
 * fields = 0, cta array empty, analytics_reset_at echoed if set.
 *
 * Soft reset (3.6):
 *   videos.analytics_reset_at, when non-null, becomes the inclusive lower
 *   bound for video_views.opened_at across all three view-querying paths
 *   below. Past rows in video_views are preserved (not deleted) so direct
 *   SQL forensics still work; they're just hidden from the dashboard.
 *
 *   recordView still bumps videos.view_count after a reset — the counter
 *   re-climbs from zero, and the cutoff filter keeps the analytics panel
 *   matching going forward.
 *
 * Excluded views (excluded_at) count nowhere here; setViewExcluded moves
 * videos.view_count to match.
 *
 * Two queries: one for the scalars (single SELECT), one for CTA aggregation
 * via JSON_TABLE. CTA query is wrapped in try/catch — falls back to JS
 * aggregation if JSON_TABLE is unavailable on the running MySQL version.
 *
 * mysql2 returns Decimal/string for SUM and AVG; coerce with Number().
 * avg_completion_pct averages PLAYED views only: an open nobody pressed play
 * on (a link scanner, usually) is not a watch of 0%. NULL with no plays → 0.
 */
async function getVideoAnalytics(db, videoId) {
  // Resolve the soft-reset cutoff for this video. A missing video returns
  // a zero-shaped result rather than throwing — matches the prior behavior
  // (the old function would just see no view rows for an unknown id).
  const [vRows] = await db.query(
    'SELECT analytics_reset_at FROM videos WHERE id = ? LIMIT 1',
    [videoId]
  );
  if (!vRows.length) {
    return {
      total_views: 0, identified_views: 0, anonymous_views: 0,
      played_count: 0, completed_count: 0, avg_completion_pct: 0,
      cta_clicks_by_label: [], analytics_reset_at: null,
    };
  }
  const resetAt    = vRows[0].analytics_reset_at;            // Date | null
  const cutoff     = resetAt || new Date(0);                  // mysql2 binds Date directly
  const resetAtIso = resetAt ? new Date(resetAt).toISOString() : null;

  const [scalarRows] = await db.query(
    `SELECT
        COUNT(*)                                                  AS total_views,
        SUM(CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END)   AS identified_views,
        SUM(CASE WHEN contact_id IS NULL     THEN 1 ELSE 0 END)   AS anonymous_views,
        SUM(CASE WHEN played_at  IS NOT NULL THEN 1 ELSE 0 END)   AS played_count,
        SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed_count,
        ROUND(AVG(CASE WHEN played_at IS NOT NULL THEN completion_pct END)) AS avg_completion_pct
       FROM video_views
      WHERE video_id = ?
        AND opened_at >= ?
        AND excluded_at IS NULL`,
    [videoId, cutoff]
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
    analytics_reset_at:  resetAtIso,
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
          AND vv.opened_at >= ?
          AND vv.excluded_at IS NULL
          AND vv.cta_clicks IS NOT NULL
        GROUP BY jt.label
        ORDER BY cnt DESC, jt.label ASC`,
      [videoId, cutoff]
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
        WHERE video_id = ?
          AND opened_at >= ?
          AND excluded_at IS NULL
          AND cta_clicks IS NOT NULL`,
      [videoId, cutoff]
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
 * Reset visible analytics for a video.
 *
 * Single transaction:
 *   - Stamps videos.analytics_reset_at = NOW().
 *   - Zeros videos.view_count.
 *
 * Past video_views rows are intentionally PRESERVED. getVideoAnalytics
 * filters them out via WHERE opened_at >= analytics_reset_at, so they're
 * hidden from the dashboard but available for direct-SQL forensics.
 *
 * @param {object} pool   mysql2 pool (must support getConnection)
 * @param {number} videoId
 * @returns {Promise<{ ok: true, reset_at: string }>}  ISO-8601 timestamp
 * @throws {Error}  err.statusCode = 404 if video does not exist
 */
async function resetVideoAnalytics(pool, videoId) {
  const row = await pool.withTransaction(async (conn) => {

    const [result] = await conn.query(
      `UPDATE videos
          SET analytics_reset_at = NOW(),
              view_count = 0
        WHERE id = ?`,
      [videoId]
    );
    if (result.affectedRows === 0) {
      const e = new Error('Video not found');
      e.statusCode = 404;
      throw e;
    }

    const [[row]] = await conn.query(
      'SELECT analytics_reset_at FROM videos WHERE id = ?',
      [videoId]
    );

    return row;
  });

  const iso = row && row.analytics_reset_at
    ? new Date(row.analytics_reset_at).toISOString()
    : null;
  return { ok: true, reset_at: iso };
}

// ─────────────────────────────────────────────────────────────
// Who watched what — the Views tab
// ─────────────────────────────────────────────────────────────

/**
 * A view a machine opened, judged at read time so nothing is stored wrongly
 * when a pattern changes. Unplayed, and a client no viewer uses: curl, and the
 * Linux desktop Chrome that fetches a texted link seconds after it is sent.
 * 25 views of 84 had this shape on 2026-11-01, none of them played. Any sign of
 * a person rules it out: a play, a button click, or a completion (the 2026-11-01
 * backfill set completed_at on views with no played_at).
 */
const AUTOMATED_SQL = `(vv.played_at IS NULL AND vv.completed_at IS NULL
  AND COALESCE(JSON_LENGTH(vv.cta_clicks), 0) = 0
  AND vv.user_agent IS NOT NULL
  AND (vv.user_agent LIKE 'curl/%' OR vv.user_agent LIKE '%X11; Linux x86_64%'))`;

const VIEW_STATUS_SQL = {
  played:     'vv.played_at IS NOT NULL',
  not_played: 'vv.played_at IS NULL',
  completed:  'vv.completed_at IS NOT NULL',
  clicked:    'JSON_LENGTH(vv.cta_clicks) > 0',
};

const VIEW_WHO_SQL = {
  known:     'vv.contact_id IS NOT NULL',
  anonymous: 'vv.contact_id IS NULL',
};

const VIEWS_PAGE_MAX = 200;

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

/** A YYYY-MM-DD firm-local day as a UTC Date, shifted by `addDays`. */
function firmDayStart(value, addDays, name) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? DateTime.fromISO(String(value), { zone: FIRM_TZ })
    : null;
  // The year bound keeps a typed 9999 from reaching MySQL as a value it refuses.
  if (!day || !day.isValid || day.year > 2100) {
    throw badRequest(`${name} must be a date (YYYY-MM-DD)`);
  }
  return day.startOf('day').plus({ days: addDays }).toUTC().toJSDate();
}

function deviceLabel(ua) {
  if (!ua) return 'Unknown';
  if (/^curl\//i.test(ua)) return 'Script';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}

/**
 * One row per page open, newest first, for the Views tab.
 *
 * Hidden unless asked for: automated opens, excluded views, and views before
 * the video's analytics reset. Those last two are exactly what the analytics
 * panel doesn't count, so with includeAutomated on, this list and the panel
 * agree. `from` / `to` are firm-local days, `to` inclusive.
 *
 * The select list is explicit: track_token is a bearer and ip_hash has no use
 * on a screen, so neither leaves this function.
 *
 * @returns {Promise<{views: object[], total: number, played: number,
 *   completed: number, limit: number, offset: number}>}
 * @throws {Error} err.statusCode = 400 on a bad filter
 */
async function listViews(db, {
  videoId, contact, status, who, from, to,
  includeAutomated = false, includeExcluded = false, includeBeforeReset = false,
  limit = 100, offset = 0,
} = {}) {
  const where = [];
  const params = [];

  if (videoId != null && videoId !== '') {
    const id = Number(videoId);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('video_id must be a positive integer');
    where.push('vv.video_id = ?');
    params.push(id);
  }
  if (contact) {
    where.push('c.contact_name LIKE ?');
    params.push(`%${escapeLike(String(contact))}%`);
  }
  if (status) {
    if (!Object.hasOwn(VIEW_STATUS_SQL, status)) throw badRequest('Unknown status');
    where.push(VIEW_STATUS_SQL[status]);
  }
  if (who) {
    if (!Object.hasOwn(VIEW_WHO_SQL, who)) throw badRequest('Unknown who');
    where.push(VIEW_WHO_SQL[who]);
  }
  if (from) {
    where.push('vv.opened_at >= ?');
    params.push(firmDayStart(from, 0, 'from'));
  }
  if (to) {
    where.push('vv.opened_at < ?');
    params.push(firmDayStart(to, 1, 'to'));
  }
  if (!includeAutomated)   where.push(`NOT ${AUTOMATED_SQL}`);
  if (!includeExcluded)    where.push('vv.excluded_at IS NULL');
  if (!includeBeforeReset) where.push('(v.analytics_reset_at IS NULL OR vv.opened_at >= v.analytics_reset_at)');

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), VIEWS_PAGE_MAX);
  const skip     = Math.min(Math.max(parseInt(offset, 10) || 0, 0), Number.MAX_SAFE_INTEGER);

  const source = `
      FROM video_views vv
      JOIN videos v         ON v.id = vv.video_id
      LEFT JOIN contacts c  ON c.contact_id = vv.contact_id
      LEFT JOIN cases cs    ON cs.case_id = vv.case_id
      LEFT JOIN users u     ON u.user = vv.excluded_by
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;

  const [[totals]] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN vv.played_at IS NOT NULL THEN 1 ELSE 0 END)    AS played,
            SUM(CASE WHEN vv.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
     ${source}`,
    params
  );

  const [rows] = await db.query(
    `SELECT vv.id, vv.video_id, v.title AS video_title,
            vv.contact_id, c.contact_name, vv.case_id, cs.case_number,
            vv.opened_at, vv.played_at, vv.completed_at,
            vv.watch_seconds, vv.completion_pct, vv.cta_clicks, vv.user_agent,
            vv.excluded_at, u.user_name AS excluded_by_name,
            ${AUTOMATED_SQL} AS automated,
            (v.analytics_reset_at IS NOT NULL AND vv.opened_at < v.analytics_reset_at) AS before_reset
     ${source}
      ORDER BY vv.opened_at DESC, vv.id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, skip]
  );

  const views = rows.map(({ cta_clicks, user_agent, automated, before_reset, ...row }) => {
    const clicks = parseJsonField(cta_clicks);
    return {
      ...row,
      user_agent,
      device: deviceLabel(user_agent),
      cta_labels: Array.isArray(clicks)
        ? clicks.filter(click => click && typeof click.label === 'string').map(click => click.label)
        : [],
      automated: !!automated,
      before_reset: !!before_reset,
    };
  });

  return {
    views,
    total:     Number(totals.total)     || 0,
    played:    Number(totals.played)    || 0,
    completed: Number(totals.completed) || 0,
    limit: pageSize,
    offset: skip,
  };
}

/**
 * Take a view out of the stats, or put it back. The row stays either way;
 * hard deletion is a SQL job. videos.view_count moves with it, unless the view
 * is from before a reset: the reset already took it off the counter.
 *
 * Repeating a call changes nothing. Pure DB, so one retry is safe.
 *
 * @param {object} pool  mysql2 pool (must support withTransaction)
 * @param {number} viewId
 * @param {boolean} excluded
 * @param {number|null} userId  users.user, recorded when excluding
 * @returns {Promise<{id: number, video_id: number, excluded: boolean, changed: boolean}>}
 * @throws {Error} err.statusCode = 404 if the view does not exist
 */
async function setViewExcluded(pool, viewId, excluded, userId = null) {
  return pool.withTransaction(async (conn) => {
    const [rows] = await conn.query(
      'SELECT video_id, opened_at FROM video_views WHERE id = ? FOR UPDATE',
      [viewId]
    );
    if (!rows.length) {
      const e = new Error('View not found');
      e.statusCode = 404;
      throw e;
    }
    const { video_id: videoId, opened_at: openedAt } = rows[0];

    const [result] = await conn.query(
      excluded
        ? `UPDATE video_views SET excluded_at = NOW(), excluded_by = ?
            WHERE id = ? AND excluded_at IS NULL`
        : `UPDATE video_views SET excluded_at = NULL, excluded_by = NULL
            WHERE id = ? AND excluded_at IS NOT NULL`,
      excluded ? [userId, viewId] : [viewId]
    );
    const changed = result.affectedRows === 1;

    if (changed) {
      await conn.query(
        `UPDATE videos
            SET view_count = ${excluded ? 'IF(view_count > 0, view_count - 1, 0)' : 'view_count + 1'}
          WHERE id = ?
            AND (analytics_reset_at IS NULL OR analytics_reset_at <= ?)`,
        [videoId, openedAt]
      );
    }
    return { id: Number(viewId), video_id: videoId, excluded, changed };
  }, { retries: 1 });
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
 * @param {boolean} [opts.publicOnly=false] skip contact_only videos — for a
 *                                        viewer whose link can't open them
 * @returns {Promise<object[]>}  rows with id, slug, title, gcs_poster_url,
 *                               gcs_gif_url, tags (JSON-hydrated). Up to limit.
 */
async function getRelatedVideos(db, videoId, { autoFill = true, limit = 3, publicOnly = false } = {}) {
  const [vRows] = await db.query(
    'SELECT id, related_video_ids, tags FROM videos WHERE id = ? LIMIT 1',
    [videoId]
  );
  if (!vRows.length) return [];

  const accessClause = publicOnly ? "AND access_level = 'public'" : '';
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
            ${accessClause}
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
              ${accessClause}
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
              ${accessClause}
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
  resetVideoAnalytics,
  listViews,
  setViewExcluded,
  hashIp,
  resolveCaseIdForContact,
  getJsonOverlapsCachedStatus,
  checkTrackToken,
  COMPLETE_PCT,
  // 2026-08-17 action-URL XSS fix
  isSafeActionUrl,
  validateActions,
};