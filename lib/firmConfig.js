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
  // Firm identity for rendered legal documents (e-sign templates). No env
  // fallback: these have never lived in env, so an empty descriptor is
  // correct — cfg() returns null and the caller applies its own default.
  'firm_name':          {},
  'firm_address':       {},   // json_array of address lines — read via cfgJson
  'firm_attorney_name': {},
  // G4. The panel trustee roster: a `json_array` of
  //   {name, lname, case_type, email, phone, address1, address2, city,
  //    state, zip, link}
  // read via cfgJson by esignPrefillService's trustee.* resolvers. No env
  // fallback — this list has never lived in env, and a stale env copy of a
  // roster that changes when the court appoints somebody is worse than an
  // empty one (an unset value yields '' and lands in `missing`, which is a
  // visible hole; a wrong trustee address on a mailed notice is not).
  'fe-trustees':        {},
  'app_url':           { env: 'APP_URL' },
  'gcs_bucket':        { env: 'GCS_BUCKET' },
  // Origin separation (2026-08-16, ref/ORIGIN_SEPARATION_ROLLOUT.md):
  //   landing_hosts    — CSV of hostnames served as the PUBLIC LANDING ORIGIN
  //                      (first entry = canonical redirect target). Empty =
  //                      feature off, behavior identical to pre-slice.
  //   landing_redirect — '1' redirects GET /p/*, /f/*, and ext-mode render
  //                      from every non-landing host to the canonical landing
  //                      host. Kept separate from landing_hosts so the landing
  //                      origin can be mapped/tested BEFORE live links move.
  // Both rows are is_editable = 0 (DB-console-only): they define a security
  // boundary, so changing them is an SU act, not a settings-tab edit.
  'landing_hosts':     { env: 'LANDING_HOSTS' },
  'landing_redirect':  { env: 'LANDING_REDIRECT' },
  // Internal app-to-self credential slots (is_secret rows — never served by
  // the settings API; managed by the API Keys admin rotate endpoint). Dual
  // slot: verifier accepts either, so rotation never races the cache TTL.
  'internal_api_key':      { env: 'INTERNAL_API_KEY' },
  'internal_api_key_prev': {},
  // Cloud Tasks accelerator kill switch (P1, 2026-08 — lib/taskQueue.js).
  // '1' = near-immediate scheduled_jobs also get a push dispatch via Google
  // Cloud Tasks; anything else = off (jobs ride the 60s cron, pre-slice
  // behavior). NOTE the empty-string-falls-through-to-env rule above: to
  // disable from the settings tab, write '0', not blank.
  'cloud_tasks_enabled':   { env: 'CLOUD_TASKS_ENABLED' },
  // Unified Events U6a (v0.5 §3.4.2, amendment A4) — singleton supersession
  // in eventService.createEvent. '1' = a new live event for an (anchor,
  // type_key) whose registry row has singleton=1 supersedes the prior live
  // row (supersede_reason='rescheduled'); anything else = off (createEvent
  // behaves exactly as before the slice). Read at CALL time via
  // cfg('unified_singleton_enabled') === '1', never at module load, so the
  // settings tab can flip it without a deploy. Same empty-string rule as
  // cloud_tasks_enabled: to disable from settings, write '0', not blank.
  // No app_settings row exists until an admin creates one; absent → off.
  'unified_singleton_enabled': { env: 'UNIFIED_SINGLETON_ENABLED' },
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
 * JSON read for `json` / `json_array` typed settings.
 * cfgJson('firm_address') → ['18481 W. 10 Mile Rd., #100', 'Southfield, MI 48075']
 *
 * NEVER THROWS. Both PUT /api/app-settings (routes/api.appSettings.js
 * TYPE_VALIDATORS) and settings.html validate JSON before a value can be
 * saved, so malformed content should be unreachable through the UI — but a
 * direct DB edit or a type change could still produce it, and a firm-identity
 * read must not be able to 500 a document render. Bad JSON logs and returns
 * the fallback; the CALLER decides what an empty value means.
 *
 * @param {string} key
 * @param {*} [fallback=null]  returned for unset / unparseable
 * @returns {*} the parsed value, or `fallback`
 */
function cfgJson(key, fallback = null) {
  const raw = cfg(key);
  if (raw == null || String(raw).trim() === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[firmConfig] ${key} is not valid JSON — ${err.message}`);
    return fallback;
  }
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

/**
 * Canonical PUBLIC origin for client-facing links — the landing host.
 *
 * Added 2026-08-17 (task/decision action-link slice) so the three places that
 * mint client-facing absolute URLs stop hand-rolling the same lookup:
 * services/taskService.js, lib/internal_functions/decisions.js and
 * routes/videoLanding.js (og:url) all call this now.
 *
 * Falls back to app_url when landing_hosts is empty — i.e. the pre-origin-
 * separation state and the landing_hosts='' teardown state both keep minting
 * working links, they just point at the app host again.
 *
 * NOT for staff-facing links ("Log in to YisraCase"): those must stay on
 * app_url, because the login shell only exists on the app origin. Use cfg
 * ('app_url') directly for those — the distinction is the whole point of the
 * origin split, so it stays explicit at each call site.
 *
 * @returns {string} origin with scheme, no trailing slash
 */
function publicUrl() {
  const host = (cfgList('landing_hosts')[0] || '').trim();
  if (host) return 'https://' + host;
  return (cfg('app_url') || 'https://app.4lsg.com').replace(/\/+$/, '');
}

module.exports = { cfg, cfgList, cfgJson, publicUrl, invalidate, prime, REGISTRY, _test };