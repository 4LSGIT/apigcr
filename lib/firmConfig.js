// lib/firmConfig.js
//
/**
 * Firm Config — cached sync reader over app_settings, with env fallback.
 * lib/firmConfig.js
 *
 * WHY THIS EXISTS
 *   Firm-level values (IT email, firm phone, app URL, ...) are moving out of
 *   Cloud Run env vars into app_settings so staff can edit them. But ~25 files
 *   read these values synchronously via process.env — some at module load.
 *   This module gives them a drop-in sync replacement:
 *
 *     const { cfg } = require('../lib/firmConfig');
 *     const itEmail = cfg('email_it');
 *
 *   instead of process.env.IT_EMAIL.
 *
 * RESOLUTION ORDER (per key)
 *   1. app_settings row value (cached, TTL 60s)   — the desired end state
 *   2. process.env[REGISTRY[key].env]             — migration safety net
 *   3. process.env[REGISTRY[key].legacyEnv]       — e.g. EMAIL_DOMAIN singular
 *   4. null
 *
 *   An EMPTY-STRING DB value falls through to env. Rationale: during the
 *   migration window a blank row must never silently disable a feature that
 *   env still configures. To truly blank a value, delete the env var too.
 *
 * CACHE MODEL (same shape as lib/appBuild.js minBuild cache)
 *   - One query loads ALL registry keys at once.
 *   - cfg() is fully synchronous: it serves the current cache (or env) and,
 *     if the cache is stale, kicks off a throttled fire-and-forget refresh.
 *     First call after boot therefore serves env values for ~1 query round
 *     trip, then DB values — indistinguishable in practice because env and
 *     DB agree during the migration window.
 *   - FAIL OPEN: a failed refresh keeps the last known values (or env) and
 *     retries in 5s instead of 60s. A DB blip must never change behavior.
 *   - invalidate() zeroes the TTL — called by PUT /api/app-settings so edits
 *     apply immediately on the instance that served the request. Other Cloud
 *     Run instances converge within TTL_MS.
 *
 * ADDING A KEY
 *   Add it to REGISTRY below (and to app_settings if it should be editable).
 *   cfg() THROWS on unknown keys — a typo'd key is a bug, not a null.
 *
 * DELIBERATELY NOT HERE
 *   FIRM_TIMEZONE. It is captured in module-scope constants (timezoneService,
 *   calendarService) and a hot-reload would split one process across two
 *   zones mid-flight. It stays env-only; changing it is a migration event.
 */

const TTL_MS = 60 * 1000;

// setting key → env fallback(s). Keep in sync with the migration SQL.
const REGISTRY = {
  'email_it':          { env: 'IT_EMAIL' },
  'email_automations': { env: 'AUTO_EMAIL' },
  'firm_email':        { env: 'FIRM_EMAIL' },
  'email_domains':     { env: 'EMAIL_DOMAINS', legacyEnv: 'EMAIL_DOMAIN' },
  'fe-firm_logo_url':  { env: 'FIRM_LOGO' },
  'fe-firm_phone':     { env: 'FIRM_PHONE' },
  'fe-firm_site_url':  { env: 'FIRM_URL' },
  'app_url':           { env: 'APP_URL' },
  'gcs_bucket':        { env: 'GCS_BUCKET' },
  // Internal app-to-self credential slots (is_secret rows — never served by
  // the settings API; managed by the API Keys admin rotate endpoint). Dual
  // slot: verifier accepts either, so rotation never races the cache TTL.
  'internal_api_key':      { env: 'INTERNAL_API_KEY' },
  'internal_api_key_prev': {},
};

let dbRef = null;      // lazy — tests inject a fake before first refresh
let cache = {};        // key → value as loaded from DB
let cacheAt = 0;       // epoch ms of last successful (or fail-open) load
let inflight = null;   // in-progress refresh promise, or null

function getDb() {
  if (!dbRef) dbRef = require('../startup/db');
  return dbRef;
}

/**
 * Throttled fire-and-forget refresh. Safe to call on every cfg() read.
 * Never throws.
 */
function refresh() {
  if (inflight || Date.now() - cacheAt < TTL_MS) return;
  // Under jest, never lazy-require the real DB pool — unit tests that
  // transitively hit cfg() must not open connections (they'd reject after
  // the suite ends: "Cannot log after tests are done"). Tests that want
  // DB-backed behavior inject a fake via _test({ db }).
  if (!dbRef && process.env.JEST_WORKER_ID !== undefined) return;
  // getDb() itself can throw (module load failure). That must fail open like
  // a query failure — never propagate synchronously out of cfg().
  let db;
  try {
    db = getDb();
  } catch (err) {
    console.error('[firmConfig] db module unavailable:', err.message);
    cacheAt = Date.now() - (TTL_MS - 5000);
    return;
  }
  const keys = Object.keys(REGISTRY);
  inflight = db
    .query('SELECT `key`, `value` FROM app_settings WHERE `key` IN (?)', [keys])
    .then(([rows]) => {
      const next = {};
      for (const r of rows) next[r.key] = r.value;
      cache = next;
      cacheAt = Date.now();
    })
    .catch((err) => {
      // FAIL OPEN: keep last known values, retry in 5s rather than 60s.
      console.error('[firmConfig] refresh failed:', err.message);
      cacheAt = Date.now() - (TTL_MS - 5000);
    })
    .finally(() => {
      inflight = null;
    });
}

/**
 * Synchronous config read. See resolution order in the header comment.
 * @param {string} key - a REGISTRY key (throws on unknown key)
 * @returns {string|null}
 */
function cfg(key) {
  const reg = REGISTRY[key];
  if (!reg) throw new Error(`[firmConfig] unknown key "${key}" — add it to REGISTRY`);
  refresh();
  const dbVal = cache[key];
  if (dbVal != null && dbVal !== '') return dbVal;
  const envVal = reg.env ? process.env[reg.env] : undefined;
  if (envVal != null && envVal !== '') return envVal;
  if (reg.legacyEnv) {
    const legacy = process.env[reg.legacyEnv];
    if (legacy != null && legacy !== '') return legacy;
  }
  return null;
}

/**
 * CSV read: cfg() split on commas, trimmed, empties dropped.
 * cfgList('email_domains') → ['@4lsg.com', '@metrodetroitbankruptcylaw.com']
 * @param {string} key
 * @returns {string[]}
 */
function cfgList(key) {
  const raw = cfg(key);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Zero the TTL so the next cfg() triggers an immediate refresh.
 * Wired into PUT /api/app-settings (Slice B) — same-instance edits apply
 * immediately; other instances converge within TTL_MS.
 */
function invalidate() {
  cacheAt = 0;
}

/**
 * Awaited load — optional. Call from a boot path or a test when you need the
 * DB values to be live before the first cfg() read. Never throws.
 */
async function prime() {
  cacheAt = 0;
  refresh();
  if (inflight) await inflight;
}

/** Test seam. Not for production use. */
function _test({ db, resetCache } = {}) {
  if (db !== undefined) dbRef = db;
  if (resetCache) {
    cache = {};
    cacheAt = 0;
    inflight = null;
  }
}

module.exports = { cfg, cfgList, invalidate, prime, REGISTRY, _test };