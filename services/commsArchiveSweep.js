// services/commsArchiveSweep.js
//
/**
 * comms_archive_sweep — one bounded tick of the comms archive.
 * ref/COMMS_ARCHIVE_DESIGN.md §6.1 (sweep), §6.2 (cliff guard), §10 (alarms).
 *
 * S1a SCOPE: RingCentral CALL RECORDINGS only. RingCentral hard-deletes a
 * recording 90 days after the call; this tick copies them into the private
 * archive bucket oldest-first so the backlog drains toward that cliff, not
 * away from it. (Quo recordings, MMS, delete detection: S1b.)
 *
 * ── THE TICK ───────────────────────────────────────────────────────────────
 *   0. Kill switch (app_settings comms_archive_enabled, uncached, exact '1').
 *   1. Tick lock: GET_LOCK('comms_archive_sweep:<DATABASE()>', 0) on a
 *      dedicated pooled connection, released (with the connection) in
 *      finally. Loser → {skipped:'locked'}. This makes the RC Heavy budget
 *      single-writer across instances and hand runs.
 *   2. Our-side pre-flight, BEFORE any row is claimed: the RingCentral
 *      adapter, reached through phoneService's registry (never a direct
 *      require), declares capabilities.archiveFetch and exports RC_FNS; then
 *      the bucket is configured and the runtime identity holds create/get/list
 *      on it. A failure ends the tick and alerts (an adapter failure at
 *      `error` from the first tick — a code defect, not a blip); no row is
 *      touched, no attempt is spent.
 *   3. Discover (no RC calls): rows for RC call rows inside RC's window,
 *      oldest first. Existence is tested on (source_table, source_id, kind)
 *      REGARDLESS of part — a tsi placeholder's part changes when it is
 *      recovered, so the unique key alone would re-insert it every tick.
 *      INSERT IGNORE stays only as the race backstop.
 *   4. Work, one due row at a time, oldest captured_at first, until the 45 s
 *      deadline or the Heavy budget (heavy_per_tick, ≥ 20 s apart):
 *        - line → credential via phone_lines (data, never a constant; active
 *          or not). No phone_lines row → 'no_line': stays pending, 6 h
 *          backoff, no attempt charged, one alert per line — heals itself
 *          once the line is added.
 *        - credential auth pre-flight (once per credential per tick) BEFORE
 *          the claim. No auth → end tick, alert.
 *        - claim = per-row lease (attempts+1, next_attempt_at +10 min) by a
 *          conditional UPDATE; affectedRows 1 = ours. A crashed tick's rows
 *          come back when the lease passes.
 *        - stat-first: an object already under the row's deterministic
 *          prefix is adopted after re-hashing (no RC call). >1 object, or a
 *          0-byte one = anomaly.
 *        - tsi placeholder (part='') → call-log lookup: first recording
 *          fills the placeholder, any others get rows of their own; nothing
 *          listed → backoff, `none` once the call is > 24 h old.
 *        - fetch → validate (200 + allowlisted audio type + non-empty +
 *          Content-Length match) → stream to the bucket (sha256 in flight,
 *          never overwrite) → ONE UPDATE to archived.
 *      Charging: only PROVIDER-side failures keep the attempt. Our-side
 *      failures (storage, auth) and rate limits (429) refund it and end the
 *      tick — one misconfiguration must not exhaust the backlog's retries.
 *      No recording is abandoned while it can still exist at RC: after
 *      maxAttempts provider-side failures a row stays PENDING on a 6 h
 *      backoff (error alert); it becomes `failed` only once its call is past
 *      90 days on the call clock.
 *   5. Cliff guard — on EVERY exit (disabled, locked, pre-flight failure,
 *      thrown error): any RC call 75–91 days old whose recording rows are
 *      not all archived / none / gone / purged → one `error` alert per UTC day.
 *
 * ── TIME BOUND ─────────────────────────────────────────────────────────────
 * `deadlineMs` (45 s) stops STARTING work; `hardDeadlineMs` (3 min) bounds
 * every RC and GCS call still in flight (each gets the time left to it, at
 * least `minIoMs`). A stalled upload therefore cannot hold the tick lock past
 * the hard deadline (+ uploadMarginMs) — the lock is released in finally once
 * it gives up. The upload's bound is the RC fetch's bound PLUS uploadMarginMs,
 * so when RC stalls the body, RC's abort fires first and the failure is
 * charged to RC — deliberately, not by timer order.
 *
 * ── ALERTS (lib/alerting) ──────────────────────────────────────────────────
 * Non-critical alerts record a system_alerts row; the hourly error sweep
 * emails ONE digest grouped by group_key (6 h per-group cooldown), triggered
 * by rows at ≥ alert_email_min_severity ('error'). A dedup_key makes a
 * repeat INSERT a silent no-op (no row, no alert_state bump), so every alert
 * here carries a per-UTC-day dedup_key (plus severity, so a warning can
 * still escalate to error the same day): at most one row per group per
 * severity per day, never one per archive row. Severity follows CLAUDE.md:
 * first occurrence → warning, repeat → error (cliff, gone, retries-exhausted
 * and failed are always error).
 */

'use strict';

const archive = require('./commsArchiveService');

const KIND = 'call_recording';
const SOURCE = 'phone_event_log';
// GET_LOCK names are limited to 64 characters: a database name over 32 characters is hashed
// (production's is 14 — its lock name is unchanged). Kept byte-identical to commsArchiveAdmin.SWEEP_LOCKS.
const LOCK_EXPR = "CONCAT('comms_archive_sweep:', IF(CHAR_LENGTH(DATABASE()) > 32, LEFT(SHA2(DATABASE(), 256), 32), DATABASE()))";
const ENABLED_KEY = 'comms_archive_enabled';
// What this sweep calls on the RC adapter — part of what its
// capabilities.archiveFetch promises (services/adapters/phone/ringcentral.js).
const RC_FNS = ['checkArchiveAuth', 'findSessionRecordings', 'fetchRecordingContent'];

/** Knobs, read at call time (tests shrink them). */
const limits = {
  deadlineMs: 45_000,          // stop STARTING work after this
  hardDeadlineMs: 180_000,     // every in-flight RC / GCS call ends by this
  minIoMs: 5_000,              // floor for one call's bound
  uploadMarginMs: 5_000,       // upload bound = RC fetch's bound + this (F1)
  heavyPerTick: 3,             // RC Heavy calls per tick (job param heavy_per_tick)
  heavySpacingMs: 20_000,      // ≥ this between Heavy calls
  heavyFloor: 4,               // stop when RC reports ≤ this many Heavy calls left
  discoverLimit: 200,
  windowDays: 90,              // RC hard-delete age (discovery window; `failed` past it)
  cliffDays: 75,               // guard lower bound
  cliffMarginDays: 1,          // guard upper bound = windowDays + this
  goneMinAgeHours: 24,         // a content 404 on a younger call is "not yet"
  leaseMin: 10,
  maxAttempts: 8,              // provider-side failures before the 6 h plateau
  backoffCapMin: 60,
  stuckBackoffMin: 360,
  notYetBackoffMin: 120,       // tsi: nothing listed yet
  noneAfterHours: 24,          // tsi: nothing listed for this long → none
  noLineBackoffMin: 360,
  repeatWindowHours: 24,       // "repeat" for warning → error escalation
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};

// Call clock: raw_extra.started_at (ISO, Z) as a UTC DATETIME whenever it is
// present — it precedes ingest, so an age from it is never younger than one
// from ingest time; processed_at (ingest time, also UTC) only when started_at
// is blank (tsi rows). COALESCE(started_at, processed_at), not a LEAST().
// A blank / malformed value CASTs to NULL (a warning under the relaxed
// sql_mode) and falls through. NEVER wrap the string in NULLIF(…, ''): MySQL
// then types it numerically and the CAST is NULL for EVERY value — silently
// the ingest clock everywhere (caught by the real-engine suite, 2026-10-14).
const CAPTURED_SQL = `COALESCE(
    CAST(REPLACE(REPLACE(JSON_VALUE(e.raw_extra, '$.started_at'), 'T', ' '), 'Z', '') AS DATETIME),
    e.processed_at)`;
const RECID_SQL = `COALESCE(JSON_VALUE(e.raw_extra, '$.recording_id'), '')`;
const RC_RECORDED_CALL = `
      e.provider = 'ringcentral' AND e.event_type = 'call' AND e.suppressed = 0
  AND (${RECID_SQL} <> '' OR e.provider_ref LIKE 'tsi:%')`;

// ─────────────────────────────────────────────────────────────
// Small helpers — the shared row mechanics live in commsArchiveCommon,
// bound to THIS sweep's limits.
// ─────────────────────────────────────────────────────────────

const common = require('./commsArchiveCommon');
const { clamp: _clamp, utcDate: _utcDate, ageHours: _ageHours, alert: _alert } = common;
const {
  repeatSeverity: _repeatSeverity, escalatingAlert: _escalatingAlert,
  claim: _claim, refund: _refund, park: _park, fail: _fail,
  markArchived: _markArchived, anomaly: _anomaly,
  terminalReason: _terminalReason, transient: _transient,
} = common.rowOps(limits);

/**
 * The most Heavy calls one tick can actually make: the first at t=0, then
 * one per spacing interval while still before the deadline (45 s / 20 s → 3).
 */
function maxHeavyPerTick() {
  if (!(limits.heavySpacingMs > 0)) return Infinity;
  return Math.floor((limits.deadlineMs - 1) / limits.heavySpacingMs) + 1;
}

const _acquireLock = (db) => common.acquireLock(db, LOCK_EXPR);

// ─────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────

async function discover(db) {
  const [r] = await db.query(
    `INSERT IGNORE INTO comms_media
       (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state)
     SELECT 'phone', ?, ?, e.id, ${RECID_SQL}, e.provider, pl.id, LEFT(e.other_party, 20),
            ${CAPTURED_SQL}, 'pending'
       FROM phone_event_log e
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
      WHERE ${RC_RECORDED_CALL}
        AND ${CAPTURED_SQL} > UTC_TIMESTAMP() - INTERVAL ? DAY
        AND NOT EXISTS (SELECT 1 FROM comms_media m
                         WHERE m.source_table = ? AND m.source_id = e.id AND m.kind = ?)
      ORDER BY ${CAPTURED_SQL} ASC, e.id ASC
      LIMIT ?`,
    [KIND, SOURCE, limits.windowDays, SOURCE, KIND, limits.discoverLimit],
  );
  return r.affectedRows || 0;
}

// ─────────────────────────────────────────────────────────────
// Row transitions
// ─────────────────────────────────────────────────────────────

async function _nextDue(db, skipIds) {
  const [[row]] = await db.query(
    `SELECT m.id, m.kind, m.provider, m.source_id, m.part, m.captured_at, m.created_at,
            m.attempts, m.channel_id,
            e.provider_ref, e.line_number,
            pl.id AS line_id, pl.credential_id
       FROM comms_media m
       JOIN phone_event_log e ON e.id = m.source_id
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
      WHERE m.state = 'pending' AND m.kind = ? AND m.source_table = ? AND m.provider = 'ringcentral'
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= UTC_TIMESTAMP())
        ${skipIds.length ? 'AND m.id NOT IN (?)' : ''}
      ORDER BY m.captured_at ASC, m.id ASC
      LIMIT 1`,
    skipIds.length ? [KIND, SOURCE, skipIds] : [KIND, SOURCE],
  );
  return row || null;
}

// Provider-side failures and the terminal rule: common.rowOps — transient()
// and terminalReason(). An RC call recording is a CLIFF kind: terminal only
// once the call is past windowDays on the call clock.

// ─────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db    mysql2 promise pool (needs getConnection)
 * @param {object} [opts] { heavyPerTick?, rc? (adapter override for tests: used
 *   as given — production takes the registry's, via common.archiveAdapter) }
 */
async function runSweep(db, opts = {}) {
  const startedAt = Date.now();
  const out = {
    enabled: false, discovered: 0, archived: 0, adopted: 0, resolved: 0, split: 0,
    none: 0, gone: 0, failed: 0, stuck: 0, retried: 0, no_line: 0, session_mismatch: 0,
    heavy_used: 0, stop: null,
  };
  const acc = { goneIds: [], failedIds: [], stuckIds: [], mismatchIds: [], noLine: new Map() };
  try {
    await _tick(db, opts, out, acc, startedAt);
  } finally {
    // EVERY exit — disabled, locked, pre-flight failure, a throw — alerts the
    // rows it touched and runs the cliff guard. Both are read-mostly and
    // deduped per day; neither throws.
    await _rowAlerts(db, acc);
    out.cliff = await _cliffGuardSafe(db);
    out.elapsed_ms = Date.now() - startedAt;
  }
  return out;
}

async function _tick(db, opts, out, acc, startedAt) {
  const deadline = startedAt + limits.deadlineMs;
  const hardDeadline = startedAt + limits.hardDeadlineMs;
  const io = () => Math.max(hardDeadline - Date.now(), limits.minIoMs);
  const hp = opts.heavyPerTick == null || opts.heavyPerTick === '' ? NaN : Number(opts.heavyPerTick);
  const heavyBudget = Math.min(
    Number.isFinite(hp) && hp >= 0 ? Math.floor(hp) : limits.heavyPerTick,
    maxHeavyPerTick());
  let rc = opts.rc || null;   // else the registry's, resolved in the pre-flight (step 2)
  const { getSetting } = require('./settingsService');            // lazy require (convention)
  const { goneIds, failedIds, stuckIds, mismatchIds, noLine } = acc;

  out.enabled = (await getSetting(db, ENABLED_KEY)) === '1';
  if (!out.enabled) { out.skipped = `${ENABLED_KEY} is not "1"`; return; }

  const lock = await _acquireLock(db);
  if (!lock) { out.skipped = 'locked'; return; }

  try {
    // ── 2. Our-side pre-flight: before ANY claim ──────────────────────────
    if (!rc) {
      const r = common.archiveAdapter('ringcentral', RC_FNS);
      if (r.error) {
        out.stop = 'adapter';
        out.error = r.error;
        await common.adapterAlert(db, { provider: 'ringcentral', sweep: 'comms_archive_sweep', error: r.error });
        return;
      }
      rc = r.adapter;
    }
    try {
      await archive.checkBucket({ timeoutMs: Math.min(io(), 30_000) });
    } catch (err) {
      if (!err.ourSide) throw err;
      out.stop = 'storage';
      out.error = err.message;
      await _escalatingAlert(db, 'comms_archive_storage', 'comms_archive_storage',
        'Comms archive: archive bucket unavailable — nothing is being archived',
        `${err.message}\n\nNo row was claimed and no attempt was spent. Every tick re-checks; ` +
        `RingCentral deletes recordings 90 days after the call, so this is time-bound.`,
        { error: _clamp(err.message, 300) });
      return;
    }

    // ── 3. Discover ───────────────────────────────────────────────────────
    out.discovered = await discover(db);

    // ── 4. Work ───────────────────────────────────────────────────────────
    const authOk = new Map();   // credential_id → bool (checked once per tick)
    const skip = [];
    let lastHeavyAt = 0;

    // Wait for the spacing slot; false = the deadline comes first.
    const heavySlot = async () => {
      if (out.heavy_used >= heavyBudget) { out.stop = out.stop || 'heavy_budget'; return false; }
      const wait = lastHeavyAt ? lastHeavyAt + limits.heavySpacingMs - Date.now() : 0;
      if (Date.now() + Math.max(wait, 0) >= deadline) { out.stop = out.stop || 'deadline'; return false; }
      if (wait > 0) await limits.sleep(wait);
      lastHeavyAt = Date.now();
      out.heavy_used++;
      return true;
    };
    // RC says the shared Heavy group is nearly spent → leave it to live ingest.
    const rateLow = (rate) => rate && rate.remaining != null &&
      (!rate.group || /heavy/i.test(rate.group)) && rate.remaining <= limits.heavyFloor;
    const count = (s, id) => {
      if (s === 'gone') { out.gone++; goneIds.push(id); }
      else if (s === 'failed') { out.failed++; failedIds.push(id); }
      else if (s === 'stuck') { out.stuck++; stuckIds.push(id); }
      else out.retried++;
    };

    for (;;) {
      if (Date.now() >= deadline) { out.stop = out.stop || 'deadline'; break; }
      if (out.stop) break;
      const row = await _nextDue(db, skip);
      if (!row) { out.stop = 'drained'; break; }
      skip.push(row.id);

      // Line → credential (data). Not a phone_lines row → no_line, no charge
      // — until the call is past RC's window, when it is terminal (failed).
      if (!row.line_id || !row.credential_id) {
        if (_terminalReason(row, { noLine: true })) {
          await _fail(db, row.id, `no_line: ${row.line_number} is not a phone line and the call is past ${limits.windowDays} days`);
          count('failed', row.id);
          continue;
        }
        await db.query(
          `UPDATE comms_media SET last_error = 'no_line', next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE
            WHERE id = ? AND state = 'pending'`,
          [limits.noLineBackoffMin, row.id],
        );
        const k = String(row.line_number || '(none)');
        if (!noLine.has(k)) noLine.set(k, []);
        noLine.get(k).push(row.id);
        out.no_line++;
        continue;
      }
      if (row.channel_id == null) {
        await db.query('UPDATE comms_media SET channel_id = ? WHERE id = ? AND channel_id IS NULL', [row.line_id, row.id]);
      }

      // Auth pre-flight, before the claim.
      if (!authOk.has(row.credential_id)) {
        authOk.set(row.credential_id, await rc.checkArchiveAuth(db, row.credential_id));
      }
      if (!authOk.get(row.credential_id)) {
        out.stop = 'no_auth';
        await _noAuthAlert(db, row.credential_id);
        break;
      }

      const prefix = row.part ? archive.recordingPrefix({ capturedAt: row.captured_at, sourceId: row.source_id, part: row.part }) : null;

      if (!await _claim(db, row.id)) continue;   // another runner got it
      const attemptsNow = Number(row.attempts) + 1;

      try {
        // ── stat-first / adopt-after-crash (no RC call) ──────────────────
        if (prefix) {
          const found = await archive.findByPrefix(prefix, { timeoutMs: io() });
          if (found.length > 1) {
            await _anomaly(db, row, `${found.length} objects under ${prefix}: ${found.map(f => f.name).join(', ')}`);
            continue;
          }
          if (found.length === 1) {
            if (!found[0].size) { await _anomaly(db, row, `0-byte object ${found[0].name}`); continue; }
            const h = await archive.rehash(found[0].name, { timeoutMs: io() });
            if (!h.bytes) { await _anomaly(db, row, `0-byte object ${found[0].name}`); continue; }
            await _markArchived(db, row.id, {
              objectName: found[0].name,
              mime: archive.canonicalAudioMime(h.contentType || found[0].contentType) || h.contentType,
              bytes: h.bytes, sha256: h.sha256,
            });
            out.adopted++;
            continue;
          }
        }

        // ── tsi placeholder → call-log recovery ──────────────────────────
        if (!row.part) {
          if (!await heavySlot()) { await _refund(db, row.id, null); break; }
          const tsi = String(row.provider_ref || '').replace(/^tsi:/, '');
          const r = await rc.findSessionRecordings(db, {
            credentialId: row.credential_id, telephonySessionId: tsi, around: row.captured_at,
            timeoutMs: Math.min(io(), 30_000),
          });
          if (await _handleRate(db, row, r, out)) break;
          if (r.status !== 200) {
            // a call-log 404 says nothing about a recording: never gone
            count(await _providerStatus(db, row, attemptsNow, r, `call-log ${r.status}`, false), row.id);
            if (rateLow(r.rate)) { out.stop = 'rate_low'; break; }
            continue;
          }
          if (!r.recordings.length && r.rawRecords > 0 && r.records === 0) {
            // RC answered with call-log records, none for this session: the
            // filter (or the field it keys on) changed shape. Never `none` on
            // that evidence — `none` satisfies the cliff guard, so a silent
            // drift would lose recordings with no alarm. Park uncharged, alert.
            if (_terminalReason(row)) {
              await _fail(db, row.id, `call-log: ${r.rawRecords} record(s), none for this session; call past ${limits.windowDays} days`);
              count('failed', row.id);
            } else {
              await _park(db, row.id, limits.notYetBackoffMin,
                `call-log: ${r.rawRecords} record(s), none for session ${tsi}`);
              mismatchIds.push(row.id);
              out.session_mismatch++;
            }
            if (rateLow(r.rate)) { out.stop = 'rate_low'; break; }
            continue;
          }
          if (!r.recordings.length) {
            if (_ageHours(row.captured_at) >= limits.noneAfterHours) {
              await db.query(
                `UPDATE comms_media SET state = 'none', next_attempt_at = NULL,
                        last_error = ? WHERE id = ? AND state = 'pending'`,
                [`call-log: ${r.records} record(s), no recording`, row.id],
              );
              out.none++;
            } else {
              await _park(db, row.id, limits.notYetBackoffMin, 'call-log: nothing listed yet');
              out.retried++;
            }
            if (rateLow(r.rate)) { out.stop = 'rate_low'; break; }
            continue;
          }
          // First recording fills the placeholder (fresh attempt count, due
          // now); the rest get rows of their own.
          const [first, ...rest] = r.recordings;
          await db.query(
            `UPDATE comms_media SET part = ?, attempts = 0, next_attempt_at = NULL, last_error = NULL
              WHERE id = ? AND state = 'pending' AND part = ''`,
            [_clamp(first.id, 64), row.id],
          );
          for (const rec of rest) {
            const [ins] = await db.query(
              // `restricted` is inherited: a Restrict on the placeholder
              // covers every recording of that call (S1b review M2).
              `INSERT IGNORE INTO comms_media
                 (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, restricted, state)
               SELECT channel, kind, source_table, source_id, ?, provider, channel_id, party, captured_at, restricted, 'pending'
                 FROM comms_media WHERE id = ?`,
              [_clamp(rec.id, 64), row.id],
            );
            out.split += ins.affectedRows || 0;
          }
          out.resolved++;
          // Let the loop pick it up again (now a real part) if budget allows.
          skip.splice(skip.indexOf(row.id), 1);
          if (rateLow(r.rate)) { out.stop = 'rate_low'; break; }
          continue;
        }

        // ── fetch → validate → store → archived ──────────────────────────
        if (!await heavySlot()) { await _refund(db, row.id, null); break; }
        const rcMs = io();
        const rcDeadline = Date.now() + rcMs;
        const res = await rc.fetchRecordingContent(db, {
          credentialId: row.credential_id, recordingId: row.part, timeoutMs: rcMs,
        });
        if (await _handleRate(db, row, res, out)) break;
        if (res.status !== 200) {
          // content 404 = gone only once the call is old enough to have had
          // its recording; before that it is "not yet"
          const goneOn404 = _ageHours(row.captured_at) >= limits.goneMinAgeHours;
          count(await _providerStatus(db, row, attemptsNow, res, `content ${res.status}`, goneOn404), row.id);
          if (rateLow(res.rate)) { out.stop = 'rate_low'; break; }
          continue;
        }
        const mime = archive.canonicalAudioMime(res.contentType);
        if (!mime || !res.body) {
          if (res.body) res.body.destroy();
          count(await _transient(db, row, attemptsNow,
            `200 with non-audio content-type ${_clamp(res.contentType, 100)}`), row.id);
          if (rateLow(res.rate)) { out.stop = 'rate_low'; break; }
          continue;
        }
        const objectName = prefix + archive.extForMime(mime);
        let put;
        try {
          put = await archive.putStream(res.body, {
            objectName, mime, expectedBytes: res.contentLength ?? undefined,
            // RC's body abort (rcDeadline) always lands before ours: an RC
            // stall is charged to RC (SOURCE), a GCS stall to us (F1).
            timeoutMs: Math.max(rcDeadline - Date.now(), 0) + limits.uploadMarginMs,
          });
        } catch (err) {
          if (err.code === 'EXISTS') {
            const h = await archive.rehash(objectName, { timeoutMs: io() });
            if (!h.bytes) { await _anomaly(db, row, `0-byte object ${objectName}`); continue; }
            await _markArchived(db, row.id, { objectName, mime, bytes: h.bytes, sha256: h.sha256 });
            out.adopted++;
            continue;
          }
          if (err.code === 'LENGTH_MISMATCH' || err.code === 'SOURCE' || err.code === 'EMPTY') {
            count(await _transient(db, row, attemptsNow, err.message), row.id);
            continue;
          }
          throw err;
        }
        await _markArchived(db, row.id, { objectName, mime, bytes: put.bytes, sha256: put.sha256 });
        out.archived++;
        if (rateLow(res.rate)) { out.stop = 'rate_low'; break; }
      } catch (err) {
        if (err && err.ourSide) {
          await _refund(db, row.id, err.message);
          out.stop = 'storage';
          out.error = err.message;
          await _escalatingAlert(db, 'comms_archive_storage', 'comms_archive_storage',
            'Comms archive: archive storage failing — tick ended',
            `${err.message}\n\nThe row's attempt was refunded; no row is charged for our-side failures.`,
            { error: _clamp(err.message, 300), media_id: row.id });
          break;
        }
        if (err && err.code === 'NO_AUTH') {
          await _refund(db, row.id, err.message);
          out.stop = 'no_auth';
          await _noAuthAlert(db, row.credential_id);
          break;
        }
        // Network / timeout talking to RC → provider-side transient.
        count(await _transient(db, row, attemptsNow, `network: ${err && err.message}`), row.id);
      }
    }
  } finally {
    await lock.release();
  }
}

/** 429 → refund, end tick, Retry-After reported (the next tick is ≥ 60 s away). */
async function _handleRate(db, row, res, out) {
  if (res.status !== 429) return false;
  await _refund(db, row.id, 'rc 429');
  out.stop = 'rate_limited';
  out.retry_after_s = res.rate && res.rate.retryAfterS != null ? res.rate.retryAfterS : null;
  return true;
}

/**
 * A non-200, non-429 from RC. A content 404 on a call old enough → gone.
 * 401/403 are the credential's (ours) — refund, no_auth path. Everything
 * else is a provider-side transient.
 */
async function _providerStatus(db, row, attemptsNow, res, label, goneOn404) {
  if (res.status === 404 && goneOn404) {
    await db.query(
      `UPDATE comms_media SET state = 'gone', next_attempt_at = NULL, last_error = ?
        WHERE id = ? AND state = 'pending'`,
      [_clamp(`${label}: ${res.errorText || ''}`, 1000), row.id],
    );
    return 'gone';
  }
  if (res.status === 401 || res.status === 403) {
    const e = new Error(`${label}: ${res.errorText || ''}`);
    e.code = 'NO_AUTH';
    throw e;
  }
  return _transient(db, row, attemptsNow, `${label}: ${res.errorText || ''}`);
}

async function _noAuthAlert(db, credentialId) {
  await _escalatingAlert(db, `comms_archive_no_auth:${credentialId}`, 'comms_archive_no_auth',
    `Comms archive: RingCentral credential ${credentialId} not usable — archiving paused`,
    `The credential produced no Authorization (disconnected, refresh failed, or media.ringcentral.com ` +
    `outside its allowed_urls), or RingCentral answered 401/403. No attempt was charged; every tick ` +
    `retries. Recordings are deleted by RingCentral 90 days after the call.`,
    { credential_id: credentialId });
}

/** One grouped alert per kind per day — never one per row. Never throws. */
async function _rowAlerts(db, { goneIds, failedIds, stuckIds, mismatchIds, noLine }) {
  try {
    const day = _utcDate();
    if (goneIds.length) {
      await _alert(db, {
        kind: 'comms_archive_gone', group_key: 'comms_archive_gone', severity: 'error',
        title: `Comms archive: ${goneIds.length} recording(s) gone at RingCentral before archiving`,
        message: `RingCentral returned 404 for recording(s) on calls 24 h+ old — the content is lost. ` +
          `comms_media ids (this tick): ${goneIds.slice(0, 50).join(', ')}. ` +
          `Today's total: SELECT COUNT(*) FROM comms_media WHERE state='gone' AND updated_at >= UTC_DATE().`,
        context: { media_ids: goneIds.slice(0, 200) },
        dedup_key: `comms_archive_gone:${day}`,
      });
    }
    if (stuckIds.length) {
      await _alert(db, {
        kind: 'comms_archive_stuck', group_key: 'comms_archive_stuck', severity: 'error',
        title: `Comms archive: ${stuckIds.length} recording(s) still failing after ${limits.maxAttempts}+ attempts`,
        message: `Repeated provider-side failures (see comms_media.last_error). The rows stay pending and ` +
          `retry every ${limits.stuckBackoffMin / 60} h until their call is 90 days old. ` +
          `ids (this tick): ${stuckIds.slice(0, 50).join(', ')}.`,
        context: { media_ids: stuckIds.slice(0, 200) },
        dedup_key: `comms_archive_stuck:${day}`,
      });
    }
    if (mismatchIds.length) {
      await _alert(db, {
        kind: 'comms_archive_session_mismatch', group_key: 'comms_archive_session_mismatch', severity: 'error',
        title: `Comms archive: RingCentral call-log returned records for other sessions (${mismatchIds.length} call(s))`,
        message: `A telephonySessionId lookup returned call-log records, none carrying the requested ` +
          `telephonySessionId — RC's filter or the record shape changed. Those tsi: calls are parked ` +
          `(retry every ${limits.notYetBackoffMin / 60} h, uncharged) and never marked none on this evidence. ` +
          `Check services/adapters/phone/ringcentral.js findSessionRecordings. ids (this tick): ` +
          `${mismatchIds.slice(0, 50).join(', ')}.`,
        context: { media_ids: mismatchIds.slice(0, 200) },
        dedup_key: `comms_archive_session_mismatch:${day}`,
      });
    }
    if (failedIds.length) {
      await _alert(db, {
        kind: 'comms_archive_failed', group_key: 'comms_archive_failed', severity: 'error',
        title: `Comms archive: ${failedIds.length} recording(s) failed — call now past 90 days`,
        message: `Still not archivable (provider failures, a line that is not a phone_lines row, or an ` +
          `unmatched call-log) when the call aged past RingCentral's 90-day retention; the recording is ` +
          `presumed lost — see comms_media.last_error. ids (this tick): ${failedIds.slice(0, 50).join(', ')}.`,
        context: { media_ids: failedIds.slice(0, 200) },
        dedup_key: `comms_archive_failed:${day}`,
      });
    }
    for (const [line, ids] of noLine) {
      await _escalatingAlert(db, `comms_archive_no_line:${line}`, 'comms_archive_no_line',
        `Comms archive: line ${line} is not a phone line — its recordings wait`,
        `RingCentral call(s) on ${line} have no phone_lines row, so no credential to fetch with. ` +
        `They stay pending (6 h backoff, no attempt charged) and archive on their own once the line ` +
        `is added under Connections → Phone Lines. comms_media ids: ${ids.slice(0, 50).join(', ')}.`,
        { line, media_ids: ids.slice(0, 200) });
    }
  } catch (err) {
    console.error('[COMMS ARCHIVE] row alerts failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Cliff guard (§6.2)
// ─────────────────────────────────────────────────────────────

/**
 * RC calls cliffDays–(windowDays + cliffMarginDays) old (call clock) whose
 * recording rows are not ALL archived / none / gone / purged — including calls
 * with no row at all yet, and failed rows (they may still be fetchable). A
 * gone row is resolved: its content is already lost, and comms_archive_gone
 * alerts on it; counting it would page daily for nothing anyone can save.
 * The upper bound keeps calls lost long ago from tripping it forever; the
 * 1-day margin past 90 keeps it paging through the last day RC might still
 * hold the file.
 */
async function cliffGuard(db) {
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS n, MIN(${CAPTURED_SQL}) AS oldest,
            SUM(NOT EXISTS (SELECT 1 FROM comms_media m
                             WHERE m.source_table = ? AND m.source_id = e.id AND m.kind = ?)) AS no_row
       FROM phone_event_log e
      WHERE ${RC_RECORDED_CALL}
        AND ${CAPTURED_SQL} <= UTC_TIMESTAMP() - INTERVAL ? DAY
        AND ${CAPTURED_SQL} >  UTC_TIMESTAMP() - INTERVAL ? DAY
        AND (NOT EXISTS (SELECT 1 FROM comms_media m
                          WHERE m.source_table = ? AND m.source_id = e.id AND m.kind = ?)
             OR EXISTS (SELECT 1 FROM comms_media m
                         WHERE m.source_table = ? AND m.source_id = e.id AND m.kind = ?
                           AND m.state NOT IN ('archived', 'none', 'gone', 'purged')))`,
    [SOURCE, KIND, limits.cliffDays, limits.windowDays + limits.cliffMarginDays, SOURCE, KIND, SOURCE, KIND],
  );
  const n = Number(r.n) || 0;
  const out = { at_risk: n };
  if (!n) return out;
  const oldestDays = r.oldest ? Math.floor((Date.now() - new Date(r.oldest).getTime()) / 86_400_000) : null;
  out.oldest_days = oldestDays;
  out.no_row = Number(r.no_row) || 0;
  await _alert(db, {
    kind: 'comms_archive_cliff', group_key: 'comms_archive_cliff', severity: 'error',
    title: `Comms archive: ${n} RingCentral recording(s) ${limits.cliffDays}+ days old not archived`,
    message: `RingCentral deletes call recordings 90 days after the call. ${n} call(s) aged ` +
      `${limits.cliffDays}–${limits.windowDays + limits.cliffMarginDays} days are not archived (oldest ` +
      `${oldestDays} days; ${out.no_row} with no comms_media row yet). Check comms_media.state / ` +
      `last_error and the comms_archive_enabled switch. Past 90 days the loss is permanent.`,
    context: out,
    dedup_key: `comms_archive_cliff:${_utcDate()}`,
  });
  return out;
}

async function _cliffGuardSafe(db) {
  try {
    return await cliffGuard(db);
  } catch (err) {
    console.error('[COMMS ARCHIVE] cliff guard failed:', err.message);
    await _alert(db, {
      kind: 'comms_archive_cliff_guard_error', group_key: 'comms_archive_cliff', severity: 'error',
      title: 'Comms archive: cliff guard query failed', message: _clamp(err.message, 500),
      dedup_key: `comms_archive_cliff_guard_error:${_utcDate()}`,
    });
    return { error: err.message };
  }
}

module.exports = { runSweep, discover, cliffGuard, maxHeavyPerTick, limits, LOCK_EXPR, ENABLED_KEY, RC_FNS };
