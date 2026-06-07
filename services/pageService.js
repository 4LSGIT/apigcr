// services/pageService.js
//
/**
 * Page Service — Landing Pages (Slice 1)
 * services/pageService.js
 *
 * CRUD for the `pages` table plus the in-memory host cache used by the
 * vanity-host middleware in routes/pageLanding.js.
 *
 * Conventions (enforced here, single source of truth):
 *   slug : lowercase ^[a-z0-9-]{1,100}$
 *   host : stored lowercase, no scheme, no port, NULL if unset
 *   path : NULL for site root, else leading slash + no trailing slash ("/ch7")
 *          path without host is rejected (a path only means something on a
 *          mapped vanity domain — /p/:slug ignores it).
 *
 * Host cache:
 *   The vanity-host middleware runs on EVERY request, so the "is this host
 *   one of ours?" check must be zero-DB-cost on the common path. We keep an
 *   in-memory Set of live hosts, lazily refreshed at most every 60s, and
 *   invalidated immediately by create/update/delete. Multi-instance note:
 *   Cloud Run instances each hold their own cache; a CUD on one instance
 *   leaves others up to 60s stale. Acceptable for this slice (publishing a
 *   page is not latency-critical).
 */

const SLUG_RE = /^[a-z0-9-]{1,100}$/;
// Pragmatic hostname check: labels of letters/digits/hyphen joined by dots.
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const STATUSES = new Set(['draft', 'live']);

const LEAN_COLS = `id, slug, host, path, status, hook_slug, thankyou_url,
                   meta_title, created_at, updated_at`;
const FULL_COLS = `${LEAN_COLS}, html`;

// ─────────────────────────────────────────────────────────────
// Normalization / validation helpers
// ─────────────────────────────────────────────────────────────

function normalizeHost(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  let h = String(raw).trim().toLowerCase();
  h = h.replace(/^https?:\/\//, '');     // strip scheme if pasted
  h = h.replace(/\/.*$/, '');            // strip any path fragment
  h = h.replace(/:\d+$/, '');            // strip port
  return h || null;
}

function normalizePath(raw) {
  if (raw == null) return null;
  let p = String(raw).trim();
  if (p === '' || p === '/') return null;          // root → NULL
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');                       // strip trailing slash(es)
  return p === '' ? null : p;
}

/**
 * Validate + normalize an incoming create/update payload.
 * Pass `partial = true` for PATCH semantics (only validate present keys).
 * Throws Error with .status = 400 on validation failure.
 *
 * @returns {object} normalized column map ready for SQL
 */
function validatePayload(body, { partial = false } = {}) {
  const out = {};
  const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };

  const has = (k) => body[k] !== undefined;

  if (!partial || has('slug')) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) bad('slug is required and must match ^[a-z0-9-]{1,100}$');
    out.slug = slug;
  }

  if (!partial || has('html')) {
    if (typeof body.html !== 'string' || body.html.trim() === '') {
      bad('html is required and must be a non-empty string');
    }
    out.html = body.html;
  }

  if (has('host')) {
    const host = normalizeHost(body.host);
    if (host !== null && !HOST_RE.test(host)) bad('host must be a bare hostname (no scheme, no port)');
    out.host = host;
  }

  if (has('path')) {
    out.path = normalizePath(body.path);
  }

  if (has('status')) {
    const status = String(body.status || '').trim();
    if (!STATUSES.has(status)) bad("status must be 'draft' or 'live'");
    out.status = status;
  }

  if (has('hook_slug')) {
    const hs = body.hook_slug == null || String(body.hook_slug).trim() === ''
      ? null : String(body.hook_slug).trim();
    if (hs !== null && hs.length > 100) bad('hook_slug too long (max 100)');
    out.hook_slug = hs;
  }

  if (has('thankyou_url')) {
    const t = body.thankyou_url == null || String(body.thankyou_url).trim() === ''
      ? null : String(body.thankyou_url).trim();
    if (t !== null && t.length > 500) bad('thankyou_url too long (max 500)');
    out.thankyou_url = t;
  }

  if (has('meta_title')) {
    const m = body.meta_title == null || String(body.meta_title).trim() === ''
      ? null : String(body.meta_title).trim();
    if (m !== null && m.length > 255) bad('meta_title too long (max 255)');
    out.meta_title = m;
  }

  return out;
}

/**
 * Cross-field rule: a path without a host is meaningless. Checked against
 * the EFFECTIVE row (existing row merged with the update) so a PATCH that
 * clears host while a path remains is also rejected.
 */
function assertHostPathCoherent(effective) {
  if (effective.path != null && effective.host == null) {
    const e = new Error('path requires a host (paths only apply on mapped vanity domains)');
    e.status = 400;
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

async function listPages(db) {
  const [rows] = await db.query(
    `SELECT ${LEAN_COLS} FROM pages ORDER BY updated_at DESC, id DESC`
  );
  return rows;
}

async function getPage(db, id) {
  const [[row]] = await db.query(`SELECT ${FULL_COLS} FROM pages WHERE id = ?`, [id]);
  return row || null;
}

async function getPageBySlug(db, slug) {
  const [[row]] = await db.query(
    `SELECT ${FULL_COLS} FROM pages WHERE slug = ? LIMIT 1`,
    [String(slug || '').toLowerCase()]
  );
  return row || null;
}

async function createPage(db, body) {
  const data = validatePayload(body, { partial: false });
  // Defaults for optional columns when absent
  if (data.host === undefined) data.host = null;
  if (data.path === undefined) data.path = null;
  if (data.status === undefined) data.status = 'draft';
  assertHostPathCoherent(data);

  const [r] = await db.query(`INSERT INTO pages SET ?`, [data]);
  invalidateHostCache();
  return getPage(db, r.insertId);
}

async function updatePage(db, id, body) {
  const existing = await getPage(db, id);
  if (!existing) return null;

  const data = validatePayload(body, { partial: true });
  if (!Object.keys(data).length) {
    const e = new Error('No updatable fields provided');
    e.status = 400;
    throw e;
  }

  assertHostPathCoherent({
    host: data.host !== undefined ? data.host : existing.host,
    path: data.path !== undefined ? data.path : existing.path,
  });

  await db.query(`UPDATE pages SET ? WHERE id = ?`, [data, id]);
  invalidateHostCache();
  return getPage(db, id);
}

async function deletePage(db, id) {
  const [r] = await db.query(`DELETE FROM pages WHERE id = ?`, [id]);
  invalidateHostCache();
  return r.affectedRows > 0;
}

// ─────────────────────────────────────────────────────────────
// Host cache (for the vanity-host middleware)
// ─────────────────────────────────────────────────────────────

const HOST_CACHE_TTL_MS = 60 * 1000;
let hostCache = null;          // Set<string> | null
let hostCacheLoadedAt = 0;
let hostCacheLoading = null;   // in-flight promise — collapse concurrent refreshes

function invalidateHostCache() {
  hostCache = null;
  hostCacheLoadedAt = 0;
}

async function loadHostCache(db) {
  const [rows] = await db.query(
    `SELECT DISTINCT host FROM pages WHERE status = 'live' AND host IS NOT NULL`
  );
  hostCache = new Set(rows.map(r => String(r.host).toLowerCase()));
  hostCacheLoadedAt = Date.now();
  return hostCache;
}

/**
 * Zero-DB-cost on the warm path: returns from the Set when fresh.
 * On a cold/stale cache, exactly one refresh query runs (concurrent callers
 * share the in-flight promise). On DB error, fail OPEN as "not our host" —
 * normal app routing must never break because the pages table hiccuped.
 */
async function isKnownHost(db, host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;

  if (hostCache && Date.now() - hostCacheLoadedAt < HOST_CACHE_TTL_MS) {
    return hostCache.has(h);
  }
  try {
    if (!hostCacheLoading) {
      hostCacheLoading = loadHostCache(db).finally(() => { hostCacheLoading = null; });
    }
    const set = await hostCacheLoading;
    return set.has(h);
  } catch (err) {
    console.error('[pages] host cache refresh failed:', err.message);
    return false;
  }
}

async function getLivePageByHostPath(db, host, path) {
  const [[row]] = await db.query(
    `SELECT ${FULL_COLS} FROM pages
      WHERE host = ? AND path <=> ? AND status = 'live'
      LIMIT 1`,
    [String(host || '').toLowerCase(), path == null ? null : path]
  );
  return row || null;
}

module.exports = {
  // CRUD
  listPages,
  getPage,
  getPageBySlug,
  createPage,
  updatePage,
  deletePage,
  // Host cache / middleware support
  isKnownHost,
  getLivePageByHostPath,
  invalidateHostCache,
  // Normalizers (exported for the landing route + tests)
  normalizeHost,
  normalizePath,
  SLUG_RE,
};