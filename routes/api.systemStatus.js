// routes/api.systemStatus.js
//
/**
 * System Status API — Slice 2 of the error-alerting system.
 *
 * GET /api/system-status
 *
 * Read-only health snapshot consumed by the shell banner (a.html / b.html):
 *   - process-jobs poller heartbeat freshness  (app_settings 'process_jobs_last_heartbeat_at')
 *   - error sweep freshness                    (app_settings 'alert_last_sweep_at' —
 *     written by lib/alerting.js ONLY on fully-successful non-dry sweeps; that
 *     asymmetry is the design: a sweep that keeps failing goes stale here)
 *   - open critical / undigested alert counts  (system_alerts)
 *
 * JWT-gated like other staff-facing routes (any logged-in user, NOT admin-only:
 * the banner shows to all staff). Auto-mounts via readdirSync convention.
 *
 * Failure posture: on any internal error respond 200 { ok:false }. The banner
 * client treats that as "no banner" — a broken status endpoint must not redden
 * every page; the error sweep covers actual failures.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// Thresholds (hardcoded by design — settings rows would be overkill for these):
const HEARTBEAT_STALE_MIN = 30;  // poller runs every ~1-5 min; wide margin
const SWEEP_STALE_MIN     = 150; // sweep is hourly; 2.5h = one missed run + margin

async function getSetting(db, key) {
  const [rows] = await db.query(
    'SELECT `value` FROM app_settings WHERE `key` = ? LIMIT 1', [key]
  );
  return rows.length ? rows[0].value : null;
}

/**
 * NULL HANDLING (deliberate): a missing setting → { value:null, age_minutes:null,
 * stale:false }. Rationale: during rollout (before the first poll/sweep stamps
 * its key) the banner must not scream at every user. Fred verifies once
 * post-deploy that both keys exist; from then on a vanished/stale key surfaces
 * via the age check. An unparseable timestamp is treated the same as missing.
 */
function freshness(isoValue, staleMin, now) {
  if (!isoValue) return { value: null, age_minutes: null, stale: false };
  const ts = new Date(isoValue).getTime();
  if (Number.isNaN(ts)) return { value: null, age_minutes: null, stale: false };
  const ageMin = Math.floor((now - ts) / 60000);
  return { value: isoValue, age_minutes: ageMin, stale: ageMin > staleMin };
}

router.get('/api/system-status', jwtOrApiKey, async (req, res) => {
  const db = req.db;
  try {
    const now = Date.now();

    const [heartbeatRaw, sweepRaw] = await Promise.all([
      getSetting(db, 'process_jobs_last_heartbeat_at'),
      getSetting(db, 'alert_last_sweep_at'),
    ]);

    const hb    = freshness(heartbeatRaw, HEARTBEAT_STALE_MIN, now);
    const sweep = freshness(sweepRaw,     SWEEP_STALE_MIN,     now);

    // Single scan for both counts. SUM of boolean expressions; mysql2 returns
    // DECIMAL as string → coerce. NULL (empty table) → 0.
    const [[counts]] = await db.query(
      `SELECT
         SUM(severity = 'critical' AND resolved_at IS NULL AND acked_at IS NULL) AS open_criticals,
         SUM(digested_at IS NULL AND acked_at IS NULL AND resolved_at IS NULL)   AS undigested
       FROM system_alerts`
    );
    const openCriticals = Number(counts.open_criticals) || 0;
    const undigested    = Number(counts.undigested)     || 0;

    res.json({
      ok:  true,
      now: new Date(now).toISOString(),
      process_jobs: {
        last_heartbeat_at: hb.value,
        age_minutes:       hb.age_minutes,
        stale:             hb.stale,
      },
      error_sweep: {
        last_sweep_at: sweep.value,
        age_minutes:   sweep.age_minutes,
        stale:         sweep.stale,
      },
      alerts: {
        open_criticals: openCriticals,
        undigested:     undigested,
      },
      banner: hb.stale || sweep.stale || openCriticals > 0,
    });
  } catch (err) {
    console.error('GET /api/system-status error:', err.message);
    // 200 + ok:false on purpose — see failure posture in header comment.
    res.json({ ok: false });
  }
});

module.exports = router;