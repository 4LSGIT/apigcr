// services/commsArchiveVerify.js
//
/**
 * comms_archive_verify — nightly delete detection (ref/COMMS_ARCHIVE_DESIGN.md
 * §10, F3).
 *
 * Each night stats a rolling 1/7 of the `archived` rows — those whose id % 7
 * equals the UTC day number % 7 — paging through the WHOLE slice (by id, in
 * pages) until done or the deadline. So every archived object is checked
 * every 7 days; one missed night still checks it within 14 days and two
 * within 21 — all inside the bucket's 30-day soft-delete window, so an
 * unexplained delete is caught while it is still restorable. A night that
 * cannot finish its slice (deadline) alerts: warning, error on repeat. A
 * soft-deleted object does not exist as a live object, so it counts as
 * missing.
 *
 * Missing → the row keeps state 'archived' (the registry still says what we
 * held), last_error stamps 'verify: missing <date>', and ONE error alert per
 * day lists the ids. The stamp is a guarded UPDATE (state = 'archived'), and
 * only the rows it stamped count — a purge that lands between the stat and
 * the stamp is never reported missing. Objects under lane A's permanent
 * probe prefix `_s0/` are excluded (the `_` is LIKE-escaped).
 *
 * Runs REGARDLESS of comms_archive_enabled, like the cliff guard: it is
 * read-only, and a delete can happen while the archive is paused — exactly
 * when you would most want to know. (out.enabled reports the switch.)
 *
 * A GCS failure is OURS (permissions, outage) — it ends the run with a
 * storage alert and never reports an object missing on that evidence. No
 * lock (idempotent, deduped alerts).
 */

'use strict';

const archive = require('./commsArchiveService');
const common = require('./commsArchiveCommon');

const limits = {
  pageSize: 200,
  deadlineMs: 120_000,
  statTimeoutMs: 15_000,
  modulus: 7,
  repeatWindowHours: 24,
  leaseMin: 10, stuckBackoffMin: 360,   // (rowOps binding; unused here)
};

const ops = common.rowOps(limits);

/** Day number since the epoch, UTC — the rolling slice. */
function sliceFor(date = new Date()) {
  return Math.floor(date.getTime() / 86_400_000) % limits.modulus;
}

async function runVerify(db, opts = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + limits.deadlineMs;
  const slice = opts.slice != null ? Number(opts.slice) : sliceFor();
  const { getSetting } = require('./settingsService'); // lazy require (convention)
  const out = { enabled: false, slice, selected: 0, checked: 0, missing: 0, stop: null };

  // Reported, NOT a gate (see the header).
  out.enabled = (await getSetting(db, 'comms_archive_enabled')) === '1';

  const candidates = [];
  let after = 0;
  pages: for (;;) {
    const [rows] = await db.query(
      `SELECT id, object_name FROM comms_media
        WHERE state = 'archived' AND object_name IS NOT NULL
          AND object_name NOT LIKE '\\\\_s0/%'
          AND MOD(id, ?) = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?`,
      [limits.modulus, slice, after, limits.pageSize],
    );
    if (!rows.length) break;
    out.selected += rows.length;
    for (const r of rows) {
      if (Date.now() >= deadline) { out.stop = 'deadline'; break pages; }
      let live;
      try {
        live = await archive.exists(r.object_name, { timeoutMs: limits.statTimeoutMs });
      } catch (err) {
        if (!err.ourSide) throw err;
        out.stop = 'storage';
        out.error = err.message;
        await ops.escalatingAlert(db, 'comms_archive_storage', 'comms_archive_storage',
          'Comms archive: delete detection could not stat the archive',
          `${err.message}\n\nNo object was reported missing on this evidence.`,
          { error: common.clamp(err.message, 300) });
        break pages;
      }
      out.checked++;
      if (!live) candidates.push(r.id);
      after = r.id;
    }
    if (rows.length < limits.pageSize) break;
  }
  out.stop = out.stop || 'done';

  if (out.stop === 'deadline') {
    await ops.escalatingAlert(db, 'comms_archive_verify_incomplete', 'comms_archive_verify_incomplete',
      `Comms archive: delete detection did not finish slice ${slice}`,
      `Checked ${out.checked} object(s) before the ${limits.deadlineMs / 1000} s deadline; the rest of the ` +
      `slice was not checked tonight. The 7-night cycle tolerates a missed night (every object still ` +
      `checked within 14 days, inside the 30-day soft-delete window), but a slice that never finishes ` +
      `is never covered — raise the deadline or shorten the cycle.`,
      { slice, checked: out.checked, last_id: after });
  }

  if (candidates.length) {
    const day = common.utcDate();
    const stamp = `verify: missing ${day}`;
    // Guarded: only rows still archived NOW are stamped, and only stamped rows count.
    await db.query(
      `UPDATE comms_media SET last_error = ? WHERE id IN (?) AND state = 'archived'`,
      [stamp, candidates],
    );
    const [confirmed] = await db.query(
      `SELECT id FROM comms_media WHERE id IN (?) AND state = 'archived' AND last_error = ?`,
      [candidates, stamp],
    );
    out.missing = confirmed.length;
    if (confirmed.length) {
      const ids = confirmed.map(c => c.id);
      await common.alert(db, {
        kind: 'comms_archive_missing', group_key: 'comms_archive_missing', severity: 'error',
        title: `Comms archive: ${ids.length} archived object(s) missing from the bucket`,
        message: `Deleted outside a purge. Restore from soft delete (30-day window) — see ref/INFRA_GCP.md. ` +
          `comms_media ids: ${ids.slice(0, 50).join(', ')}.`,
        context: { media_ids: ids.slice(0, 200) },
        dedup_key: `comms_archive_missing:${day}`,
      });
    }
  }
  out.elapsed_ms = Date.now() - startedAt;
  return out;
}

module.exports = { runVerify, sliceFor, limits };
