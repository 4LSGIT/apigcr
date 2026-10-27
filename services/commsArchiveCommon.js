// services/commsArchiveCommon.js
//
/**
 * Shared row mechanics for the comms archive sweeps
 * (services/commsArchiveSweep.js — RC call recordings; and the media sweep —
 * Quo recordings + MMS). ref/COMMS_ARCHIVE_DESIGN.md §6.1.
 *
 * Pure mechanics, no policy: the lease, the uncharged refund / park, the
 * terminal UPDATE, the archived flip, the anomaly park, the escalating
 * alert, the tick lock, and the adapter lookup through phoneService's
 * registry (archiveAdapter / adapterAlert). Each sweep binds the row
 * operations to ITS OWN `limits` object (rowOps(limits)), so a test that
 * tunes one sweep's knobs tunes exactly the helpers that sweep uses.
 *
 * Alerting semantics (lib/alerting): a repeated dedup_key is a silent no-op,
 * and the hourly digest emails rows grouped by group_key — see the sweep
 * header. escalatingAlert puts the severity in the dedup_key so a warning
 * can still escalate to error the same day.
 */

'use strict';

function clamp(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

function utcDate() { return new Date().toISOString().slice(0, 10); }

function ageHours(capturedAt) {
  return (Date.now() - new Date(capturedAt).getTime()) / 3_600_000;
}

/** Fire-and-forget alert; never throws. */
function alert(db, o) {
  try {
    const { alert: send } = require('../lib/alerting'); // lazy require (convention)
    return Promise.resolve(send(db, { source: 'app', ...o })).catch(() => {});
  } catch (_) {
    return Promise.resolve();
  }
}

/**
 * GET_LOCK(<lockExpr>, 0) on a dedicated pooled connection. Returns null when
 * held elsewhere, else { release() } which releases the lock AND the
 * connection (destroying the socket if RELEASE_LOCK itself fails — closing it
 * releases the lock anyway). `lockExpr` is SQL, e.g.
 * "CONCAT('comms_archive_sweep:', DATABASE())" — the DATABASE() suffix is
 * load-bearing (lock names are server-global).
 */
async function acquireLock(db, lockExpr, waitS = 0) {
  const conn = await db.getConnection();
  let got = false;
  try {
    const [[r]] = await conn.query(`SELECT GET_LOCK(${lockExpr}, ?) AS got`, [waitS]);
    got = !!r && Number(r.got) === 1;
  } catch (err) {
    try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) { /* gone */ } }
    throw err;
  }
  if (!got) {
    try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) { /* gone */ } }
    return null;
  }
  return {
    async release() {
      let clean = true;
      try { await conn.query(`SELECT RELEASE_LOCK(${lockExpr})`); } catch (_) { clean = false; }
      if (clean) {
        try { conn.release(); } catch (_) { try { conn.destroy(); } catch (_) { /* gone */ } }
      } else {
        try { conn.destroy(); } catch (_) { /* closing the socket releases the lock */ }
      }
    },
  };
}

/**
 * A provider's archive adapter, reached through phoneService's registry ONLY
 * (never require('./adapters/phone/<p>') — ref/COMMS_ARCHIVE_DESIGN.md §3):
 * the adapter must declare capabilities.archiveFetch AND export every
 * function in `fns` (the ones the calling sweep uses). Returns { adapter } or
 * { error } — never a quiet null: a sweep that cannot reach a provider says
 * so (adapterAlert), because RingCentral deletes recordings 90 days after the
 * call and a provider skipped in silence loses them.
 */
function archiveAdapter(provider, fns) {
  const phoneService = require('./phoneService'); // lazy require (convention)
  const adapter = phoneService.getAdapter(provider);
  if (!adapter) return { error: `no ${provider} adapter in phoneService's registry` };
  if (!adapter.capabilities || adapter.capabilities.archiveFetch !== true) {
    return { error: `the ${provider} adapter does not declare capabilities.archiveFetch` };
  }
  const missing = fns.filter(f => typeof adapter[f] !== 'function');
  if (missing.length) {
    return { error: `the ${provider} adapter declares archiveFetch but lacks ${missing.join(', ')}` };
  }
  return { adapter };
}

/**
 * archiveAdapter failed: a code / deploy defect, not a blip — `error` from the
 * first occurrence (CLAUDE.md severity convention), one row per provider per
 * sweep per UTC day. Never throws.
 */
function adapterAlert(db, { provider, sweep, error }) {
  return alert(db, {
    kind: 'comms_archive_adapter', group_key: `comms_archive_adapter:${provider}`, severity: 'error',
    title: `Comms archive: the ${provider} adapter cannot archive — its archiving stopped`,
    message: `${error} (${sweep}). No ${provider} row was claimed and no attempt was spent; every tick ` +
      `re-checks. Fix services/adapters/phone/${provider}.js (capabilities.archiveFetch and the functions ` +
      `it promises) or phoneService's ADAPTERS. RingCentral deletes recordings 90 days after the call.`,
    context: { provider, sweep, error: clamp(error, 300) },
    dedup_key: `comms_archive_adapter:${provider}:${sweep}:${utcDate()}`,
  });
}

/**
 * Does this row's file have a provider RETENTION CLIFF? Only RC call
 * recordings (90-day hard delete). RC MMS showed none (134 days still served)
 * and Quo has none; those kinds are "no-cliff".
 */
function hasCliff(row) {
  return row.provider === 'ringcentral' && row.kind === 'call_recording';
}

/**
 * Row operations bound to a sweep's `limits` (read at call time):
 *   leaseMin, stuckBackoffMin, repeatWindowHours, maxAttempts, backoffCapMin,
 *   windowDays (cliff kinds), noCliffDays (no-cliff kinds, default 30).
 *
 * `opts` (S2): the lease / refund / park / fail / transient helpers work on
 *   table        the row table (default 'comms_media');
 *   claimStates  the states a row may be leased, refunded, parked or failed
 *                FROM (default ['pending']) — the transcription sweep leases
 *                'pending' (to submit) and 'transcribing' (to poll).
 * markArchived and anomaly are comms_media-only (they write its columns) and
 * refuse any other table. Identifiers are validated, never interpolated raw.
 */
function rowOps(limits, { table = 'comms_media', claimStates = ['pending'] } = {}) {
  const IDENT = /^[a-z_]{1,64}$/;
  if (!IDENT.test(table)) throw new Error(`rowOps: bad table ${table}`);
  if (!Array.isArray(claimStates) || !claimStates.length || !claimStates.every(x => IDENT.test(x))) {
    throw new Error('rowOps: claimStates must be a non-empty list of state names');
  }
  const T = table;
  const LIVE = `state IN (${claimStates.map(x => `'${x}'`).join(', ')})`;
  const mediaOnly = (fn) => {
    if (T !== 'comms_media') throw new Error(`rowOps.${fn}: comms_media only (bound to ${T})`);
  };
  const noCliffDays = () => (Number(limits.noCliffDays) > 0 ? Number(limits.noCliffDays) : 30);
  /** Plateau retries in noCliffDays: the attempt count past maxAttempts that marks "stuck that long". */
  const plateauSteps = () => Math.ceil((noCliffDays() * 24 * 60) / limits.stuckBackoffMin);

  /**
   * THE terminal rule — one helper, keyed by kind/provider (design §6.1 step 5).
   * Returns why the row is now terminal (`failed`), or null to keep trying.
   *   cliff kind:    the call is past windowDays on the call clock — it can no
   *                  longer exist at the provider (whatever the reason for
   *                  not having it: provider failures, no_line, drift);
   *   no-cliff kind: an UNCHARGED wait (no_line, shape drift) for
   *                  noCliffDays since the row was created, or still failing
   *                  noCliffDays after the attempts ran out (attempts past
   *                  maxAttempts are 6 h apart, so the count measures that
   *                  time).
   */
  function terminalReason(row, { attemptsNow = null, noLine = false, uncharged = false } = {}) {
    if (hasCliff(row)) {
      return ageHours(row.captured_at) >= limits.windowDays * 24
        ? `call past ${limits.windowDays} days` : null;
    }
    if (noLine || uncharged) {
      return row.created_at && ageHours(row.created_at) >= noCliffDays() * 24
        ? `${noLine ? 'no_line' : 'waiting'} for ${noCliffDays()} days` : null;
    }
    if (attemptsNow != null && attemptsNow >= limits.maxAttempts + plateauSteps()) {
      return `still failing ${noCliffDays()} days after ${limits.maxAttempts} attempts`;
    }
    return null;
  }

  /**
   * Provider-side failure: keep the attempt. Terminal (terminalReason) →
   * `failed`; attempts ≥ maxAttempts → stays pending on stuckBackoffMin
   * ('stuck' — error alert); otherwise 2^attempts min, capped.
   */
  async function transient(db, row, attemptsNow, err) {
    if (terminalReason(row, { attemptsNow })) {
      await fail(db, row.id, err);
      return 'failed';
    }
    const stuck = attemptsNow >= limits.maxAttempts;
    const mins = stuck ? limits.stuckBackoffMin : Math.min(2 ** attemptsNow, limits.backoffCapMin);
    await db.query(
      `UPDATE ${T} SET next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE, last_error = ?
        WHERE id = ? AND ${LIVE}`,
      [mins, clamp(err, 1000), row.id],
    );
    return stuck ? 'stuck' : 'retry';
  }

  /** First occurrence for this group in the window → warning; repeat → error. */
  async function repeatSeverity(db, groupKey) {
    try {
      const [[r]] = await db.query(
        `SELECT 1 AS hit FROM system_alerts
          WHERE group_key = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ? HOUR
          LIMIT 1`,
        [groupKey, limits.repeatWindowHours],
      );
      return r ? 'error' : 'warning';
    } catch (_) {
      return 'error'; // can't tell → don't under-page
    }
  }

  async function escalatingAlert(db, groupKey, kind, title, message, context) {
    const severity = await repeatSeverity(db, groupKey);
    return alert(db, {
      kind, group_key: groupKey, severity, title, message, context,
      dedup_key: `${groupKey}:${severity}:${utcDate()}`,
    });
  }

  /** Per-row lease. affectedRows 1 (rows MATCHED, CLIENT_FOUND_ROWS) = ours. */
  async function claim(db, id) {
    const [r] = await db.query(
      `UPDATE ${T}
          SET attempts = attempts + 1,
              next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE
        WHERE id = ? AND ${LIVE}
          AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())`,
      [limits.leaseMin, id],
    );
    return r.affectedRows === 1;
  }

  /** Give the attempt back: the failure was not the provider's. Due again now. */
  async function refund(db, id, lastError) {
    await db.query(
      `UPDATE ${T}
          SET attempts = GREATEST(attempts, 1) - 1, next_attempt_at = NULL,
              last_error = COALESCE(?, last_error)
        WHERE id = ? AND ${LIVE}`,
      [clamp(lastError, 1000), id],
    );
  }

  /** Uncharged park: refund the attempt and come back after `mins`. */
  async function park(db, id, mins, lastError) {
    await db.query(
      `UPDATE ${T} SET attempts = GREATEST(attempts, 1) - 1,
              next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE, last_error = ?
        WHERE id = ? AND ${LIVE}`,
      [mins, clamp(lastError, 1000), id],
    );
  }

  /** Terminal `failed`. */
  async function fail(db, id, lastError) {
    await db.query(
      `UPDATE ${T} SET state = 'failed', next_attempt_at = NULL, last_error = ?
        WHERE id = ? AND ${LIVE}`,
      [clamp(lastError, 1000), id],
    );
  }

  async function markArchived(db, id, { objectName, mime, bytes, sha256, note = null }) {
    mediaOnly('markArchived');
    await db.query(
      `UPDATE comms_media
          SET state = 'archived', object_name = ?, mime = ?, bytes = ?, sha256 = ?,
              archived_at = UTC_TIMESTAMP(), next_attempt_at = NULL, last_error = ?
        WHERE id = ? AND state = 'pending'`,
      [objectName, mime, bytes, sha256, clamp(note, 1000), id],
    );
  }

  /** Something under the row's prefix a human must look at: park, uncharged, alert. */
  async function anomaly(db, row, what) {
    mediaOnly('anomaly');
    await park(db, row.id, limits.stuckBackoffMin, `anomaly: ${what}`);
    await alert(db, {
      kind: 'comms_archive_anomaly', group_key: 'comms_archive_anomaly', severity: 'error',
      title: 'Comms archive: an archive object needs a human',
      message: `comms_media ${row.id}: ${what} — left pending (6 h backoff, uncharged).`,
      ref_table: 'comms_media', ref_id: row.id,
      dedup_key: `comms_archive_anomaly:${row.id}`,
    });
  }

  return {
    repeatSeverity, escalatingAlert, claim, refund, park, fail, markArchived, anomaly,
    terminalReason, transient,
  };
}

module.exports = { clamp, utcDate, ageHours, alert, acquireLock, rowOps, hasCliff, archiveAdapter, adapterAlert };
