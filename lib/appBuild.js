// lib/appBuild.js
//
// Two things live here:
//
//   1. BUILD IDENTITY — which build of the code is this process running.
//      Changes on every deploy. The browser shell records the build it booted on
//      and shows an "update available" banner when the server moves past it.
//
//   2. THE FORCE FLOOR — app_settings.min_client_build. Any tab whose build is
//      OLDER than this floor is hard-reloaded instead of being asked nicely.
//      Normal deploys leave the floor alone and get the banner. Set the floor
//      only when an old client is actually dangerous.
//
// Consumed by:
//   routes/api.version.js      → GET /api/version
//   server.js                  → X-App-Build / X-App-Min-Build response headers
//   public/js/versionGuard.js  → does the actual banner / reload
//
// ── Build identity, in priority order ───────────────────────────────────────
//   1. APP_BUILD env var  — explicit override, if you ever want to stamp manually.
//   2. K_REVISION env var — Cloud Run sets this automatically on every revision.
//      It changes on EVERY deploy and is identical across all instances serving
//      that revision. This is the real signal in production.
//   3. max file mtime     — computed once at boot by walking the deployed source.
//      Baked into the container image, so it is also identical across instances
//      of the same image. Pure-JS fallback for local dev / non-Cloud-Run hosts.
//
// `mtime` is always reported alongside `build` because it is monotonic across
// deploys — it is the axis the force floor is compared against.
//
// Deliberately NOT used as a build id: process start time. Cloud Run runs several
// instances that start at arbitrary times, so the client would see the value flap
// between requests and reload forever.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// What counts as "the deployed app" — anything the server or the browser runs.
// node_modules is excluded on purpose: `npm install` can touch it without the
// application itself having changed.
const SCAN = [
  "server.js",
  "package.json",
  "public",
  "routes",
  "lib",
  "services",
  "startup",
  "views",
];

function walkMaxMtime(target, depth) {
  if (depth > 6) return 0;
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    return 0; // path not present in this deploy — skip it
  }
  if (st.isFile()) return st.mtimeMs;
  if (!st.isDirectory()) return 0;

  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch {
    return 0;
  }
  let max = 0;
  for (const name of entries) {
    if (name === "node_modules" || name === ".git") continue;
    const m = walkMaxMtime(path.join(target, name), depth + 1);
    if (m > max) max = m;
  }
  return max;
}

let mtime = 0;
for (const rel of SCAN) {
  const m = walkMaxMtime(path.join(ROOT, rel), 0);
  if (m > mtime) mtime = m;
}
mtime = Math.round(mtime);

const revision = process.env.K_REVISION || null;
const build = process.env.APP_BUILD || revision || "mt-" + mtime;
const startedAt = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// FORCE FLOOR — app_settings key `min_client_build`
// ─────────────────────────────────────────────────────────────────────────────
//
// The value is a TIMESTAMP, not an on/off flag, and that is the whole design.
// A flag would have to be remembered and cleared by hand, and every deploy after
// it would keep force-reloading until you did. A timestamp stops applying by
// itself the moment the next build ships past it — it is self-expiring.
//
// Accepted values (typed straight into the Settings tab):
//
//   (empty) / 0 / off      no floor. THE NORMAL STATE. Deploys get the banner.
//   2026-07-12             any tab on a build older than that date is reloaded
//   2026-07-12T14:30:00Z   ...to the minute (UTC — the server runs TZ=UTC)
//   1783819613800          raw epoch ms. This is what /api/version reports as
//                          `mtime`, so "kick everything older than what is live
//                          right now" = paste the current `mtime` in.
//
// Anything unparseable → 0 (no floor). A typo can never lock the firm out.
//
// The read is cached for 30s, so the public, unauthenticated /api/version can
// never turn into DB load no matter how many tabs are polling. It fails OPEN
// (floor stays at its last known value, default 0) because a DB blip must never
// hard-reload everyone out of the app.

const MIN_TTL_MS = 30 * 1000;
let minCache = { at: 0, val: 0 };
let minInflight = null;

function parseMinBuild(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/^["']|["']$/g, "").trim();
  if (!s) return 0;
  if (/^(0|off|false|no|none|null)$/i.test(s)) return 0;
  if (/^\d{13,}$/.test(s)) return Number(s); // epoch ms
  if (/^\d{10}$/.test(s)) return Number(s) * 1000; // epoch seconds
  const t = Date.parse(s); // ISO / '2026-07-12' / '2026-07-12 14:30'
  return Number.isFinite(t) ? t : 0; // unparseable → no floor
}

const envFloor = parseMinBuild(process.env.APP_MIN_BUILD);

/**
 * Last known floor, synchronously. May be up to MIN_TTL_MS stale.
 * Used by the per-response header middleware, which cannot await.
 */
function minBuildCached() {
  return Math.max(minCache.val, envFloor);
}

/**
 * Fire-and-forget cache refresh. Throttled to at most one DB read per MIN_TTL_MS
 * per instance, so it is safe to call on literally every request. Never throws.
 */
function refreshMinBuild(db) {
  const now = Date.now();
  if (minInflight || now - minCache.at < MIN_TTL_MS) return;
  minInflight = db
    .query(
      "SELECT `value` FROM app_settings WHERE `key` = 'min_client_build' LIMIT 1"
    )
    .then(([rows]) => {
      minCache = {
        at: Date.now(),
        val: parseMinBuild(rows && rows[0] ? rows[0].value : null),
      };
    })
    .catch((err) => {
      // Fail OPEN: keep the last known floor, and retry in 5s rather than 30s.
      console.error("[appBuild] min_client_build read failed:", err.message);
      minCache = { at: Date.now() - (MIN_TTL_MS - 5000), val: minCache.val };
    })
    .finally(() => {
      minInflight = null;
    });
}

/** Awaited read — used by GET /api/version so its answer is never stale. */
async function getMinBuild(db) {
  if (Date.now() - minCache.at >= MIN_TTL_MS) {
    refreshMinBuild(db);
    if (minInflight) await minInflight;
  }
  return minBuildCached();
}

module.exports = {
  build,
  revision,
  mtime,
  startedAt,
  getMinBuild,
  minBuildCached,
  refreshMinBuild,
  parseMinBuild, // exported for tests
};