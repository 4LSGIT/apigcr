// services/commsArchiveMediaSweep.js
//
/**
 * comms_archive_media_sweep — one bounded tick of the comms archive for
 * everything EXCEPT RingCentral call recordings (those are
 * services/commsArchiveSweep.js — the 90-day cliff, the RC Heavy budget):
 *   - Quo call recordings     (kind call_recording, provider quo)
 *   - RingCentral MMS files   (kind mms_file, provider ringcentral)
 *   - Quo MMS files           (kind mms_file, provider quo)
 * ref/COMMS_ARCHIVE_DESIGN.md §6.1. Same kill switch (comms_archive_enabled),
 * its own lock CONCAT('comms_archive_media:', DATABASE()), its own budgets, so
 * it can never compete with the cliff sweep.
 *
 * ── DISCOVERY (no provider calls) ──────────────────────────────────────────
 *   Quo calls with raw_extra.provider_status = 'completed' (the only reliable
 *   "answered" signal — call duration is positive on no-answer rows too: it
 *   is ringing time) → one placeholder (part '') each.
 *   SMS rows whose log.log_data.attachments is a non-empty array → one row
 *   per attachment: part = RC attachment id, or 'q<ordinal>' for Quo (Quo's
 *   stored ref is a URL only). log.log_data is TEXT: a malformed row yields
 *   no attachments instead of failing the statement (JSON_VALID / JSON_TYPE
 *   guards inside the JSON_TABLE input), and the LIMIT applies to MESSAGES,
 *   so a message's attachments are always inserted together (the existence
 *   test is per message).
 *
 * ── SHAPE DRIFT IS NEVER "NOTHING THERE" ───────────────────────────────────
 * The Quo shapes come from Quo's API reference, unprobed. Whatever does not
 * match it — `data` missing or not an array, media[] missing, the ordinal
 * absent, an unknown recording status, a recording id no longer listed, a
 * non-https media URL — parks the row UNCHARGED and raises one error alert
 * per day (comms_archive_shape_drift). `none` is reached only from a
 * well-formed `data: []` (or a recording status that means no file).
 *
 * ── TERMINAL RULE ──────────────────────────────────────────────────────────
 * These kinds have no provider retention cliff: common.rowOps.terminalReason
 * makes a stuck row `failed` 30 days after its attempts ran out, and a
 * no_line row `failed` 30 days after it was created.
 *
 * ── BUDGETS (per tick) ─────────────────────────────────────────────────────
 *   RC Medium group (message-store content): rcMediumPerTick, spaced.
 *   Quo API (10 req/s per key, shared with live sends): quoPerTick, spaced.
 *   Quo signed-URL downloads are not API calls; they count against the
 *   deadline only. A spent budget stops that provider for the tick, not the
 *   tick. The time bounds are the cliff sweep's: deadlineMs stops starting
 *   work, hardDeadlineMs bounds every call in flight, and an upload's bound
 *   is its download's bound + uploadMarginMs (a provider stall is charged to
 *   the provider).
 *
 * Signed-URL errors carry the URL HOST only — never the query string, which
 * is the signature.
 */

'use strict';

const archive = require('./commsArchiveService');
const common = require('./commsArchiveCommon');

const SOURCE = 'phone_event_log';
const LOCK_EXPR = "CONCAT('comms_archive_media:', DATABASE())";
const ENABLED_KEY = 'comms_archive_enabled';

/** Knobs, read at call time (tests shrink them). */
const limits = {
  deadlineMs: 45_000,
  hardDeadlineMs: 180_000,
  minIoMs: 5_000,
  uploadMarginMs: 5_000,
  rcMediumPerTick: 6,
  rcMediumSpacingMs: 3_000,
  quoPerTick: 20,
  quoSpacingMs: 250,
  discoverLimit: 200,
  windowDays: 90,              // (cliff kinds only — none handled here)
  noCliffDays: 30,
  goneMinAgeHours: 24,
  leaseMin: 10,
  maxAttempts: 8,
  backoffCapMin: 60,
  stuckBackoffMin: 360,
  notYetBackoffMin: 30,        // Quo recording still processing
  notYetAlertHours: 24,        // a call this old still "not yet" → alert (S1)
  forbiddenRecheckMin: 1440,   // a Quo 403 (resource-level) parks its row this long
  driftBackoffMin: 120,
  noneAfterHours: 24,
  noLineBackoffMin: 360,
  repeatWindowHours: 24,
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};

const { clamp, utcDate, ageHours, alert } = common;
const ops = common.rowOps(limits);

// Event clock: a call's raw_extra.started_at, an SMS's raw_extra.ts (both ISO
// with Z), else processed_at. Never NULLIF the string first (see the cliff
// sweep: it makes every CAST NULL).
const CALL_CLOCK = `COALESCE(
    CAST(REPLACE(REPLACE(JSON_VALUE(e.raw_extra, '$.started_at'), 'T', ' '), 'Z', '') AS DATETIME),
    e.processed_at)`;
const SMS_CLOCK = `COALESCE(
    CAST(REPLACE(REPLACE(JSON_VALUE(e.raw_extra, '$.ts'), 'T', ' '), 'Z', '') AS DATETIME),
    e.processed_at)`;

/** The attachments array of a log row, or [] for anything malformed. */
const ATTACHMENTS_JSON = `CASE WHEN JSON_VALID(l.log_data)
    THEN CASE WHEN JSON_TYPE(JSON_EXTRACT(l.log_data, '$.attachments')) = 'ARRAY'
              THEN JSON_EXTRACT(l.log_data, '$.attachments') ELSE JSON_ARRAY() END
    ELSE JSON_ARRAY() END`;

/** Quo recording statuses (API reference) → what the sweep does. */
const QUO_REC_STATUS = Object.freeze({
  'completed': 'file', 'stopped': 'file',          // with a url; stopped without one: not yet for 24 h, then none
  'in-progress': 'not_yet', 'processing': 'not_yet', 'paused': 'not_yet', 'stopping': 'not_yet',
  'deleted': 'gone',
  'absent': 'none', 'failed': 'none',
});

// ─────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────

async function discoverQuoCalls(db) {
  const [r] = await db.query(
    `INSERT IGNORE INTO comms_media
       (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state)
     SELECT 'phone', 'call_recording', ?, e.id, '', 'quo', pl.id, LEFT(e.other_party, 20),
            ${CALL_CLOCK}, 'pending'
       FROM phone_event_log e
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
      WHERE e.provider = 'quo' AND e.event_type = 'call' AND e.suppressed = 0
        AND JSON_VALUE(e.raw_extra, '$.provider_status') = 'completed'
        AND NOT EXISTS (SELECT 1 FROM comms_media m
                         WHERE m.source_table = ? AND m.source_id = e.id AND m.kind = 'call_recording')
      ORDER BY ${CALL_CLOCK} ASC, e.id ASC
      LIMIT ?`,
    [SOURCE, SOURCE, limits.discoverLimit],
  );
  return r.affectedRows || 0;
}

/**
 * Quo call statuses OUTSIDE the two known values (completed / no-answer),
 * with counts — never skipped silently (S3): the tick raises them as drift.
 */
async function unknownQuoCallStatuses(db) {
  const [rows] = await db.query(
    `SELECT COALESCE(JSON_VALUE(e.raw_extra, '$.provider_status'), '(missing)') AS st, COUNT(*) AS n
       FROM phone_event_log e
      WHERE e.provider = 'quo' AND e.event_type = 'call' AND e.suppressed = 0
        AND COALESCE(JSON_VALUE(e.raw_extra, '$.provider_status'), '') NOT IN ('completed', 'no-answer')
      GROUP BY st ORDER BY n DESC LIMIT 20`,
  );
  return rows.map(r => ({ status: r.st, count: Number(r.n) }));
}

/** The message-media id in a Quo media URL path (…/message-media/<id>[.ext]), or null. */
function quoMediaId(url) {
  try {
    const m = /\/message-media\/([^/.?#]+)/.exec(new URL(String(url)).pathname);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * The stored attachment for a Quo MMS row: its URL
 * (log.log_data.attachments[ordinal − 1].url, or null) and how many
 * attachments the message stored.
 */
async function _storedQuo(db, row, ordinal) {
  const [[r]] = await db.query(
    `SELECT CASE WHEN JSON_VALID(l.log_data)
                 THEN JSON_UNQUOTE(JSON_EXTRACT(l.log_data, CONCAT('$.attachments[', ?, '].url'))) END AS url,
            CASE WHEN JSON_VALID(l.log_data)
                 THEN JSON_LENGTH(JSON_EXTRACT(l.log_data, '$.attachments')) END AS n
       FROM phone_event_log e JOIN log l ON l.log_id = e.log_id
      WHERE e.id = ?`,
    [ordinal - 1, row.source_id],
  );
  return { url: r && r.url && r.url !== 'null' ? r.url : null, count: r && r.n != null ? Number(r.n) : 0 };
}

async function discoverMms(db) {
  const [r] = await db.query(
    `INSERT IGNORE INTO comms_media
       (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state)
     SELECT 'phone', 'mms_file', ?, e.id,
            CASE WHEN e.provider = 'ringcentral' THEN COALESCE(NULLIF(jt.aid, ''), CONCAT('r', jt.ord))
                 ELSE CONCAT('q', jt.ord) END,
            e.provider, pl.id, LEFT(e.other_party, 20), ${SMS_CLOCK}, 'pending'
       FROM (SELECT e2.id
               FROM phone_event_log e2
               JOIN log l2 ON l2.log_id = e2.log_id
              WHERE e2.event_type = 'sms' AND e2.suppressed = 0
                AND e2.provider IN ('ringcentral', 'quo')
                AND JSON_LENGTH(${ATTACHMENTS_JSON.replace(/\bl\./g, 'l2.')}) > 0
                AND NOT EXISTS (SELECT 1 FROM comms_media m
                                 WHERE m.source_table = ? AND m.source_id = e2.id AND m.kind = 'mms_file')
              ORDER BY e2.id ASC
              LIMIT ?) pick
       JOIN phone_event_log e ON e.id = pick.id
       JOIN log l ON l.log_id = e.log_id
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
       JOIN JSON_TABLE(${ATTACHMENTS_JSON}, '$[*]'
              COLUMNS (ord FOR ORDINALITY, aid VARCHAR(64) PATH '$.id' NULL ON ERROR)) jt`,
    [SOURCE, SOURCE, limits.discoverLimit],
  );
  return r.affectedRows || 0;
}

// ─────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────

async function _nextDue(db, skipIds, skipProviders) {
  const conds = [];
  const params = [SOURCE];
  if (skipIds.length) { conds.push('AND m.id NOT IN (?)'); params.push(skipIds); }
  if (skipProviders.size) { conds.push('AND m.provider NOT IN (?)'); params.push([...skipProviders]); }
  const [[row]] = await db.query(
    `SELECT m.id, m.kind, m.provider, m.source_id, m.part, m.captured_at, m.created_at,
            m.attempts, m.channel_id,
            e.provider_ref, e.line_number,
            pl.id AS line_id, pl.credential_id, pl.display_name AS line_name
       FROM comms_media m
       JOIN phone_event_log e ON e.id = m.source_id
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
      WHERE m.state = 'pending' AND m.source_table = ?
        AND ((m.kind = 'call_recording' AND m.provider = 'quo')
             OR (m.kind = 'mms_file' AND m.provider IN ('ringcentral', 'quo')))
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= UTC_TIMESTAMP())
        ${conds.join(' ')}
      ORDER BY m.captured_at ASC, m.id ASC
      LIMIT 1`,
    params,
  );
  return row || null;
}

function _prefixFor(row) {
  const args = { capturedAt: row.captured_at, sourceId: row.source_id, part: row.part };
  return row.kind === 'mms_file' ? archive.mmsPrefix(args) : archive.recordingPrefix(args);
}

/** Key a drift / stop by provider + kind so one provider's trouble never stops another. */
const _lane = (row) => `${row.provider}:${row.kind}`;

// ─────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} [opts] { rc?, quo? (adapter overrides for tests) }
 */
async function runMediaSweep(db, opts = {}) {
  const startedAt = Date.now();
  const out = {
    enabled: false, discovered_calls: 0, discovered_mms: 0,
    archived: 0, adopted: 0, resolved: 0, split: 0, none: 0, gone: 0, failed: 0, stuck: 0,
    retried: 0, not_yet: 0, drift: 0, no_line: 0, rc_used: 0, quo_used: 0,
    stopped: {}, stop: null,
  };
  const acc = { goneIds: [], failedIds: [], stuckIds: [], drift: [], notYetOld: [], noLine: new Map(), quoForbidden: new Map() };
  try {
    await _tick(db, opts, out, acc, startedAt);
  } finally {
    await _rowAlerts(db, acc);
    await _quoForbiddenAlerts(db, acc, out);
    out.elapsed_ms = Date.now() - startedAt;
  }
  return out;
}

async function _tick(db, opts, out, acc, startedAt) {
  const deadline = startedAt + limits.deadlineMs;
  const hardDeadline = startedAt + limits.hardDeadlineMs;
  const io = () => Math.max(hardDeadline - Date.now(), limits.minIoMs);
  const rc = opts.rc || require('./adapters/phone/ringcentral');  // lazy require (convention)
  const quo = opts.quo || require('./adapters/phone/quo');        // lazy require (convention)
  const { getSetting } = require('./settingsService');            // lazy require (convention)

  out.enabled = (await getSetting(db, ENABLED_KEY)) === '1';
  if (!out.enabled) { out.skipped = `${ENABLED_KEY} is not "1"`; return; }

  const lock = await common.acquireLock(db, LOCK_EXPR);
  if (!lock) { out.skipped = 'locked'; return; }

  try {
    // ── Our-side pre-flight, before ANY claim ─────────────────────────────
    try {
      await archive.checkBucket({ timeoutMs: Math.min(io(), 30_000) });
    } catch (err) {
      if (!err.ourSide) throw err;
      out.stop = 'storage';
      out.error = err.message;
      await ops.escalatingAlert(db, 'comms_archive_storage', 'comms_archive_storage',
        'Comms archive: archive bucket unavailable — nothing is being archived',
        `${err.message}\n\nNo row was claimed and no attempt was spent (media sweep).`,
        { error: clamp(err.message, 300) });
      return;
    }

    out.discovered_calls = await discoverQuoCalls(db);
    out.discovered_mms = await discoverMms(db);
    const unknown = await unknownQuoCallStatuses(db);
    if (unknown.length) {
      // Its OWN group: a status that stays present forever must not eat the
      // daily shape-drift alert and hide real per-row drift (review F2).
      out.unknown_call_statuses = unknown;
      await alert(db, {
        kind: 'comms_archive_quo_status_drift', group_key: 'comms_archive_quo_status_drift', severity: 'error',
        title: 'Comms archive: Quo call status outside {completed, no-answer}',
        message: `Not discovered for recordings: ` +
          unknown.map(u => `${JSON.stringify(u.status)} ×${u.count}`).join(', ') +
          `. Decide whether the new status can carry a recording, then extend discovery.`,
        context: { statuses: unknown },
        dedup_key: `comms_archive_quo_status_drift:${utcDate()}`,
      });
    }

    // ── Budgets ───────────────────────────────────────────────────────────
    const lanes = {
      ringcentral: { used: 0, last: 0, max: limits.rcMediumPerTick, spacing: limits.rcMediumSpacingMs, key: 'rc_used' },
      quo:         { used: 0, last: 0, max: limits.quoPerTick,      spacing: limits.quoSpacingMs,      key: 'quo_used' },
    };
    const skipIds = [];
    const skipProviders = new Set();
    const stopProvider = (p, why) => { skipProviders.add(p); out.stopped[p] = out.stopped[p] || why; };
    /** Wait for the provider's next API slot; false = budget spent or past the deadline. */
    const slot = async (p) => {
      const b = lanes[p];
      if (b.used >= b.max) { stopProvider(p, 'budget'); return false; }
      const wait = b.last ? b.last + b.spacing - Date.now() : 0;
      if (Date.now() + Math.max(wait, 0) >= deadline) { stopProvider(p, 'deadline'); return false; }
      if (wait > 0) await limits.sleep(wait);
      b.last = Date.now();
      b.used++;
      out[b.key]++;
      return true;
    };
    const authOk = new Map();
    const count = (s, id) => {
      if (s === 'gone') { out.gone++; acc.goneIds.push(id); }
      else if (s === 'failed') { out.failed++; acc.failedIds.push(id); }
      else if (s === 'stuck') { out.stuck++; acc.stuckIds.push(id); }
      else out.retried++;
    };
    const drift = async (row, what) => {
      if (ops.terminalReason(row, { uncharged: true })) {
        await ops.fail(db, row.id, `shape drift: ${what}`);
        count('failed', row.id);
        return;
      }
      await ops.park(db, row.id, limits.driftBackoffMin, `shape drift: ${what}`);
      acc.drift.push({ id: row.id, lane: _lane(row), what: clamp(what, 200) });
      out.drift++;
    };

    for (;;) {
      if (Date.now() >= deadline) { out.stop = out.stop || 'deadline'; break; }
      if (out.stop) break;
      const row = await _nextDue(db, skipIds, skipProviders);
      if (!row) { out.stop = 'drained'; break; }
      skipIds.push(row.id);

      // Line → credential (data). No phone_lines row → no_line, uncharged.
      if (!row.line_id || !row.credential_id) {
        const t = ops.terminalReason(row, { noLine: true });
        if (t) {
          await ops.fail(db, row.id, `no_line: ${row.line_number} is not a phone line — ${t}`);
          count('failed', row.id);
          continue;
        }
        await db.query(
          `UPDATE comms_media SET last_error = 'no_line', next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE
            WHERE id = ? AND state = 'pending'`,
          [limits.noLineBackoffMin, row.id],
        );
        const k = String(row.line_number || '(none)');
        if (!acc.noLine.has(k)) acc.noLine.set(k, []);
        acc.noLine.get(k).push(row.id);
        out.no_line++;
        continue;
      }
      if (row.channel_id == null) {
        await db.query('UPDATE comms_media SET channel_id = ? WHERE id = ? AND channel_id IS NULL', [row.line_id, row.id]);
      }

      const adapter = row.provider === 'quo' ? quo : rc;
      const authKey = `${row.provider}:${row.credential_id}`;
      if (!authOk.has(authKey)) authOk.set(authKey, await adapter.checkArchiveAuth(db, row.credential_id));
      if (!authOk.get(authKey)) {
        await _noAuthAlert(db, row.provider, row.credential_id);
        stopProvider(row.provider, 'no_auth');
        continue;
      }

      if (!await ops.claim(db, row.id)) continue;
      const attemptsNow = Number(row.attempts) + 1;

      try {
        // ── stat-first / adopt-after-crash ───────────────────────────────
        if (row.part) {
          const prefix = _prefixFor(row);
          const found = await archive.findByPrefix(prefix, { timeoutMs: io() });
          if (found.length > 1) { await ops.anomaly(db, row, `${found.length} objects under ${prefix}`); continue; }
          if (found.length === 1) {
            if (!found[0].size) { await ops.anomaly(db, row, `0-byte object ${found[0].name}`); continue; }
            const h = await archive.rehash(found[0].name, { timeoutMs: io() });
            if (!h.bytes) { await ops.anomaly(db, row, `0-byte object ${found[0].name}`); continue; }
            await ops.markArchived(db, row.id, {
              objectName: found[0].name, mime: h.contentType || found[0].contentType || 'application/octet-stream',
              bytes: h.bytes, sha256: h.sha256,
            });
            out.adopted++;
            continue;
          }
        }

        let res = null;      // { status, contentType, contentLength, body, host? }
        let store = null;    // { mime, ext, note }
        let fetchDeadline = 0;

        if (row.provider === 'quo' && row.kind === 'call_recording') {
          // ── Quo recording: list, then (per row) the item's signed URL ──
          if (!await slot('quo')) { await ops.refund(db, row.id, null); continue; }
          const r = await quo.listCallRecordings(db, { credentialId: row.credential_id, callId: row.provider_ref, timeoutMs: Math.min(io(), 30_000) });
          const stopped = await _apiStatus(db, row, r, attemptsNow, 'quo', 'call-recordings', stopProvider, count, out, acc);
          if (stopped) continue;
          const data = r.json && r.json.data;
          if (!Array.isArray(data)) { await drift(row, `call-recordings: \`data\` is ${r.json === undefined ? 'unparseable' : (data === undefined ? 'missing' : typeof data)}`); continue; }
          if (!row.part) {
            if (!data.length) {
              if (ageHours(row.captured_at) >= limits.noneAfterHours) {
                await db.query(`UPDATE comms_media SET state = 'none', next_attempt_at = NULL, last_error = 'call-recordings: data: []' WHERE id = ? AND state = 'pending'`, [row.id]);
                out.none++;
              } else {
                await ops.park(db, row.id, limits.notYetBackoffMin, 'call-recordings: nothing listed yet');
                out.not_yet++;
              }
              continue;
            }
            const ids = data.map(d => d && d.id).filter(x => typeof x === 'string' && x);
            if (ids.length !== data.length) { await drift(row, 'call-recordings: an item without a string id'); continue; }
            await db.query(
              `UPDATE comms_media SET part = ?, attempts = 0, next_attempt_at = NULL, last_error = NULL
                WHERE id = ? AND state = 'pending' AND part = ''`,
              [clamp(ids[0], 64), row.id],
            );
            for (const id of ids.slice(1)) {
              const [ins] = await db.query(
                // `restricted` is inherited from the placeholder (review M2).
                `INSERT IGNORE INTO comms_media
                   (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, restricted, state)
                 SELECT channel, kind, source_table, source_id, ?, provider, channel_id, party, captured_at, restricted, 'pending'
                   FROM comms_media WHERE id = ?`,
                [clamp(id, 64), row.id],
              );
              out.split += ins.affectedRows || 0;
            }
            out.resolved++;
            skipIds.splice(skipIds.indexOf(row.id), 1);
            continue;
          }
          const item = data.find(d => d && d.id === row.part);
          if (!item) { await drift(row, `call-recordings: recording ${row.part} no longer listed`); continue; }
          const act = QUO_REC_STATUS[item.status];
          if (!act) { await drift(row, `call-recordings: unknown status ${JSON.stringify(item.status)}`); continue; }
          const stoppedNoUrl = item.status === 'stopped' && !item.url;
          if (act === 'not_yet' || (stoppedNoUrl && ageHours(row.captured_at) < limits.noneAfterHours)) {
            // Not yet — but never forever (S1): the no-cliff terminal rule
            // applies, and a call this old still "not yet" is alerted.
            const t = ops.terminalReason(row, { uncharged: true });
            if (t) { await ops.fail(db, row.id, `quo: recording still ${item.status} — ${t}`); count('failed', row.id); continue; }
            await ops.park(db, row.id, limits.notYetBackoffMin, `recording ${item.status}`);
            out.not_yet++;
            if (ageHours(row.captured_at) >= limits.notYetAlertHours) acc.notYetOld.push({ id: row.id, status: item.status });
            continue;
          }
          if (act === 'gone') {
            await db.query(`UPDATE comms_media SET state = 'gone', next_attempt_at = NULL, last_error = 'quo: recording deleted' WHERE id = ? AND state = 'pending'`, [row.id]);
            count('gone', row.id);
            continue;
          }
          if (act === 'none' || !item.url) {
            if (item.status === 'completed') { count(await ops.transient(db, row, attemptsNow, 'quo: completed recording without a url'), row.id); continue; }
            await db.query(`UPDATE comms_media SET state = 'none', next_attempt_at = NULL, last_error = ? WHERE id = ? AND state = 'pending'`, [`quo: recording ${item.status}`, row.id]);
            out.none++;
            continue;
          }
          const ms = io();
          fetchDeadline = Date.now() + ms;
          try { res = await quo.fetchSigned(item.url, { timeoutMs: ms }); }
          catch (err) { if (err.code === 'BAD_URL') { await drift(row, `recording url ${err.message}`); continue; } throw err; }
          if (res.status === 200) {
            const respAudio = archive.canonicalAudioMime(res.contentType);
            const generic = !res.contentType || /octet-stream/i.test(res.contentType);
            const mime = respAudio || (generic ? archive.canonicalAudioMime(item.type) : null);
            if (!mime) {
              res.body && res.body.destroy();
              count(await ops.transient(db, row, attemptsNow, `download ${res.host}: 200 with non-audio content-type ${clamp(res.contentType, 100)}`), row.id);
              continue;
            }
            store = { mime, ext: archive.extForMime(mime), note: null };
          }
        } else if (row.provider === 'quo') {
          // ── Quo MMS: fresh media URL from the message ───────────────────
          const ord = /^q(\d+)$/.exec(row.part || '');
          if (!ord) { await drift(row, `quo mms part ${JSON.stringify(row.part)}`); continue; }
          if (!await slot('quo')) { await ops.refund(db, row.id, null); continue; }
          const r = await quo.getMessage(db, { credentialId: row.credential_id, messageId: row.provider_ref, timeoutMs: Math.min(io(), 30_000) });
          const stopped = await _apiStatus(db, row, r, attemptsNow, 'quo', 'messages', stopProvider, count, out, acc);
          if (stopped) continue;
          const media = r.json && r.json.data && r.json.data.media;
          if (!Array.isArray(media)) { await drift(row, `messages: media is ${r.json === undefined ? 'unparseable' : (media === undefined ? 'missing' : typeof media)}`); continue; }
          // Match by the message-media id when both sides carry one; the
          // ordinal only when neither does; anything else is drift — never
          // archive one file under another's part (S4). ONE exception: ids on
          // one side only, but the message stored exactly one attachment AND
          // Quo lists exactly one — no mislabel is possible, so the ordinal is
          // accepted. Quo changed its MMS URL scheme in June 2026 (stored
          // links before ~06-26 are share.quo.com/v1/file/i/<id>.<ext> or
          // storage.googleapis.com/opstatics/<hex>); a re-signed link in the
          // new scheme must not drift those six forever.
          const ordinal = Number(ord[1]);
          const stored = await _storedQuo(db, row, ordinal);
          const storedId = quoMediaId(stored.url);
          const freshIds = media.map(x => (x && typeof x.url === 'string' ? quoMediaId(x.url) : null));
          let m;
          if (storedId && freshIds.some(Boolean)) {
            m = media[freshIds.indexOf(storedId)];
            if (!m) { await drift(row, `messages: media id ${storedId} not among the ${media.length} listed`); continue; }
          } else if (!storedId && !freshIds.some(Boolean)) {
            m = media[ordinal - 1];
            if (!m) { await drift(row, `messages: media[${ordinal - 1}] missing (${media.length} listed)`); continue; }
          } else if (stored.count === 1 && media.length === 1 && ordinal === 1) {
            m = media[0];
          } else {
            await drift(row, `messages: media id on only one side (stored ${storedId ? 'has' : 'lacks'} one; ${stored.count} stored, ${media.length} listed)`);
            continue;
          }
          if (typeof m.url !== 'string') { await drift(row, 'messages: media item without a url'); continue; }
          const ms = io();
          fetchDeadline = Date.now() + ms;
          try { res = await quo.fetchSigned(m.url, { timeoutMs: ms }); }
          catch (err) { if (err.code === 'BAD_URL') { await drift(row, `media url ${err.message}`); continue; } throw err; }
          if (res.status === 200) {
            const c = archive.classifyMedia(res.contentType, m.type);
            if (c.error) { res.body && res.body.destroy(); count(await ops.transient(db, row, attemptsNow, `download ${res.host}: ${c.error}`), row.id); continue; }
            store = c;
          }
        } else {
          // ── RC MMS: message-store content (Medium) ──────────────────────
          if (!/^\d+$/.test(row.part || '')) { await drift(row, `rc attachment without an id (part ${JSON.stringify(row.part)})`); continue; }
          if (!await slot('ringcentral')) { await ops.refund(db, row.id, null); continue; }
          const ms = io();
          fetchDeadline = Date.now() + ms;
          res = await rc.fetchMessageAttachment(db, { credentialId: row.credential_id, messageId: row.provider_ref, attachmentId: row.part, timeoutMs: ms });
          res.host = 'media.ringcentral.com';
          if (res.status === 429) { await ops.refund(db, row.id, 'rc 429'); stopProvider('ringcentral', 'rate_limited'); continue; }
          if (res.status === 401 || res.status === 403) {
            await ops.refund(db, row.id, `rc ${res.status}`);
            await _noAuthAlert(db, 'ringcentral', row.credential_id,
              _authDetail(out, 'ringcentral', '/restapi/v1.0/account/~/extension/~/message-store/{id}/content/{id}', res));
            stopProvider('ringcentral', 'no_auth');
            continue;
          }
          if (res.status === 200) {
            const c = archive.classifyMedia(res.contentType, null);
            if (c.error) { res.body && res.body.destroy(); count(await ops.transient(db, row, attemptsNow, `content: ${c.error}`), row.id); continue; }
            store = c;
          }
          if (res.rate && res.rate.remaining != null && res.rate.remaining <= 4) stopProvider('ringcentral', 'rate_low');
        }

        // ── non-200 download ─────────────────────────────────────────────
        if (res.status !== 200) {
          if (res.status === 404 && ageHours(row.captured_at) >= limits.goneMinAgeHours && row.provider === 'ringcentral') {
            await db.query(`UPDATE comms_media SET state = 'gone', next_attempt_at = NULL, last_error = ? WHERE id = ? AND state = 'pending'`,
              [`content 404 (${res.host})`, row.id]);
            count('gone', row.id);
          } else {
            // Quo signed URLs: a 403/404 is usually an expired link — the next
            // attempt lists a fresh one. Charged, never gone.
            count(await ops.transient(db, row, attemptsNow, `download ${res.host}: ${res.status}`), row.id);
          }
          continue;
        }

        // ── store ────────────────────────────────────────────────────────
        const objectName = _prefixFor(row) + store.ext;
        let put;
        try {
          put = await archive.putStream(res.body, {
            objectName, mime: store.mime, expectedBytes: res.contentLength ?? undefined,
            timeoutMs: Math.max(fetchDeadline - Date.now(), 0) + limits.uploadMarginMs,
          });
        } catch (err) {
          if (err.code === 'EXISTS') {
            const h = await archive.rehash(objectName, { timeoutMs: io() });
            if (!h.bytes) { await ops.anomaly(db, row, `0-byte object ${objectName}`); continue; }
            await ops.markArchived(db, row.id, { objectName, mime: store.mime, bytes: h.bytes, sha256: h.sha256, note: store.note });
            out.adopted++;
            continue;
          }
          if (err.code === 'LENGTH_MISMATCH' || err.code === 'SOURCE' || err.code === 'EMPTY') {
            count(await ops.transient(db, row, attemptsNow, `download ${res.host}: ${err.message}`), row.id);
            continue;
          }
          throw err;
        }
        await ops.markArchived(db, row.id, { objectName, mime: store.mime, bytes: put.bytes, sha256: put.sha256, note: store.note });
        out.archived++;
      } catch (err) {
        if (err && err.ourSide) {
          await ops.refund(db, row.id, err.message);
          out.stop = 'storage';
          out.error = err.message;
          await ops.escalatingAlert(db, 'comms_archive_storage', 'comms_archive_storage',
            'Comms archive: archive storage failing — media tick ended',
            `${err.message}\n\nThe row's attempt was refunded; no row is charged for our-side failures.`,
            { error: clamp(err.message, 300), media_id: row.id });
          break;
        }
        if (err && err.code === 'NO_AUTH') {
          await ops.refund(db, row.id, err.message);
          await _noAuthAlert(db, row.provider, row.credential_id);
          stopProvider(row.provider, 'no_auth');
          continue;
        }
        // Network / timeout talking to the provider → provider-side transient.
        count(await ops.transient(db, row, attemptsNow, `network: ${err && err.message}`), row.id);
      }
    }
  } finally {
    await lock.release();
  }
}

/**
 * A Quo API status other than 200:
 *   429 → refund + stop Quo for the tick;
 *   401 → the CREDENTIAL: refund + no_auth, stop Quo for the tick;
 *   403 → the RESOURCE (live 2026-10-14: Quo 0900403 "You are forbidden to
 *         access the requested Call Recordings" on one line while others are
 *         fine — Quo forbids per line): park THAT row uncharged
 *         (forbiddenRecheckMin), one alert per line, and the tick goes on
 *         with every other row and line. Terminal: the no-cliff rule (failed
 *         30 d after the row was created ≈ its first try). A credential-wide
 *         403 cannot hide this way: if every Quo request of a tick is a 403
 *         across ≥ 2 lines, the credential alert is raised too.
 *   anything else → provider transient.
 * Returns true when the row was handled (caller continues).
 */
async function _apiStatus(db, row, r, attemptsNow, provider, label, stopProvider, count, out, acc) {
  if (r.status === 200) return false;
  if (r.status === 429) {
    await ops.refund(db, row.id, `${provider} 429`);
    stopProvider(provider, 'rate_limited');
    return true;
  }
  if (provider === 'quo' && r.status === 403) {
    const endpoint = `/v1/${label}`;
    const qe = _quoError(r.errorText);
    const why = `quo 403${qe.code ? ` ${qe.code}` : ''} on ${endpoint}: ${qe.message || clamp(r.errorText, 200) || '(no body)'}`;
    const t = ops.terminalReason(row, { uncharged: true });
    if (t) { await ops.fail(db, row.id, `${why} — ${t}`); count('failed', row.id); }
    else await ops.park(db, row.id, limits.forbiddenRecheckMin, why);
    out.quo_forbidden = (out.quo_forbidden || 0) + 1;
    const k = String(row.line_number || '(none)');
    const e = acc.quoForbidden.get(k) || { line: k, name: row.line_name || null, credential_id: row.credential_id, kinds: new Set(), count: 0, message: null, code: null };
    e.kinds.add(label); e.count++; e.message = qe.message || e.message; e.code = qe.code || e.code;
    acc.quoForbidden.set(k, e);
    return true;
  }
  if (r.status === 401 || r.status === 403) {
    await ops.refund(db, row.id, `${provider} ${r.status}`);
    await _noAuthAlert(db, provider, row.credential_id, _authDetail(out, provider, `/v1/${label}`, r));
    stopProvider(provider, 'no_auth');
    return true;
  }
  count(await ops.transient(db, row, attemptsNow, `${label} ${r.status}: ${r.errorText || ''}`), row.id);
  return true;
}

/** Quo's error body ({message, code, status, title}) → {code, message}; tolerant of anything else. */
function _quoError(text) {
  try {
    const j = JSON.parse(String(text || ''));
    return { code: j && j.code != null ? clamp(String(j.code), 20) : null, message: j && j.message ? clamp(String(j.message), 200) : null };
  } catch (_) {
    return { code: null, message: null };
  }
}

/**
 * One escalating alert PER LINE for Quo 403s (group
 * comms_archive_quo_forbidden:<line>) — the line and its name, which
 * endpoints, how many rows of that line now wait, Quo's message. Plus the
 * guard: a tick whose Quo requests were ALL 403, across ≥ 2 lines, also
 * raises the credential-level no_auth alert. Never throws.
 */
async function _quoForbiddenAlerts(db, acc, out) {
  try {
    if (!acc.quoForbidden.size) return;
    for (const e of acc.quoForbidden.values()) {
      const [[c]] = await db.query(
        `SELECT COUNT(*) AS n FROM comms_media m JOIN phone_event_log e ON m.source_table = 'phone_event_log' AND e.id = m.source_id
          WHERE m.provider = 'quo' AND m.state = 'pending' AND m.last_error LIKE 'quo 403%' AND e.line_number = ?`, [e.line]);
      const kinds = [...e.kinds].map(k => (k === 'call-recordings' ? 'recordings' : k === 'messages' ? 'MMS' : k === 'call-voicemails' ? 'voicemails' : k)).join(' + ');
      await ops.escalatingAlert(db, `comms_archive_quo_forbidden:${e.line}`, 'comms_archive_quo_forbidden',
        `Comms archive: Quo forbids ${kinds} on line ${e.line}${e.name ? ` (${e.name})` : ''}`,
        `Quo answered 403${e.code ? ` ${e.code}` : ''}: "${e.message || '(no message)'}". ${Number(c.n)} row(s) of this line are ` +
        `parked (re-checked every ${limits.forbiddenRecheckMin / 60} h, uncharged; failed after ${limits.noCliffDays} days). ` +
        `Other lines are unaffected. Likely a per-line recording / access setting in Quo.`,
        { line: e.line, name: e.name, kinds: [...e.kinds], parked: Number(c.n), quo_code: e.code, quo_message: e.message });
    }
    const lines = acc.quoForbidden.size;
    if (out.quo_used > 0 && (out.quo_forbidden || 0) >= out.quo_used && lines >= 2) {
      const first = acc.quoForbidden.values().next().value;
      await _noAuthAlert(db, 'quo', first.credential_id, {
        endpoint: `every Quo request this tick (${out.quo_used}) across ${lines} lines`, status: 403,
        errorText: clamp(first.message || '', 300),
      });
    }
  } catch (err) {
    console.error('[COMMS ARCHIVE] quo forbidden alerts failed:', err.message);
  }
}

/**
 * What the provider said when it refused us (401/403): the endpoint as a PATH
 * TEMPLATE (no ids), the status and the provider's error text (≤ 300 chars,
 * as the adapter captured it). Never the key or any header. Recorded on the
 * tick output (out.quo_auth_error / out.rc_auth_error) for job_results, and
 * returned for the alert.
 */
function _authDetail(out, provider, endpoint, res) {
  const detail = {
    endpoint,
    status: res && res.status != null ? res.status : null,
    errorText: clamp(res && res.errorText != null ? String(res.errorText) : '', 300),
  };
  if (out) out[provider === 'quo' ? 'quo_auth_error' : 'rc_auth_error'] = detail;
  return detail;
}

async function _noAuthAlert(db, provider, credentialId, detail = null) {
  await ops.escalatingAlert(db, `comms_archive_no_auth:${credentialId}`, 'comms_archive_no_auth',
    `Comms archive: ${provider} credential ${credentialId} not usable — its archiving paused`,
    (detail
      ? `${provider} answered ${detail.status} on ${detail.endpoint}: ${detail.errorText || '(no body)'}\n\n`
      : 'The credential produced no Authorization (disconnected, refresh failed, or URL outside its allowed_urls).\n\n') +
    `No attempt was charged; every tick retries.`,
    { credential_id: credentialId, provider, ...(detail ? { endpoint: detail.endpoint, status: detail.status, error_text: detail.errorText } : {}) });
}

/** One grouped alert per kind per day — never one per row. Never throws. */
async function _rowAlerts(db, { goneIds, failedIds, stuckIds, drift, notYetOld, noLine }) {
  try {
    const day = utcDate();
    if (notYetOld.length) {
      await ops.escalatingAlert(db, 'comms_archive_quo_not_yet', 'comms_archive_quo_not_yet',
        `Comms archive: ${notYetOld.length} Quo recording(s) still not ready ${limits.notYetAlertHours} h+ after the call`,
        `Quo still reports these recordings as in progress / processing / paused / stopping (or stopped ` +
        `without a file). They keep retrying uncharged and fail after ${limits.noCliffDays} days. ` +
        notYetOld.slice(0, 30).map(x => `#${x.id} ${x.status}`).join(', '),
        { rows: notYetOld.slice(0, 100) });
    }
    if (drift.length) {
      await alert(db, {
        kind: 'comms_archive_shape_drift', group_key: 'comms_archive_shape_drift', severity: 'error',
        title: `Comms archive: a provider response did not match its documented shape (${drift.length} row(s))`,
        message: `Rows are parked uncharged (retry every ${limits.driftBackoffMin / 60} h) and never marked none on ` +
          `that evidence. Check services/adapters/phone/{quo,ringcentral}.js against the provider. ` +
          drift.slice(0, 20).map(d => `#${d.id} ${d.lane}: ${d.what}`).join('; '),
        context: { rows: drift.slice(0, 100) },
        dedup_key: `comms_archive_shape_drift:${day}`,
      });
    }
    if (goneIds.length) {
      await alert(db, {
        kind: 'comms_archive_gone', group_key: 'comms_archive_gone', severity: 'error',
        title: `Comms archive: ${goneIds.length} media file(s) gone at the provider before archiving`,
        message: `Deleted at the provider (Quo status deleted, or an RC content 404 on a message 24 h+ old). ` +
          `comms_media ids (this tick): ${goneIds.slice(0, 50).join(', ')}.`,
        context: { media_ids: goneIds.slice(0, 200) },
        dedup_key: `comms_archive_gone:${day}`,
      });
    }
    if (stuckIds.length) {
      await alert(db, {
        kind: 'comms_archive_stuck', group_key: 'comms_archive_stuck', severity: 'error',
        title: `Comms archive: ${stuckIds.length} media file(s) still failing after ${limits.maxAttempts}+ attempts`,
        message: `Repeated provider-side failures (see comms_media.last_error). Retrying every ` +
          `${limits.stuckBackoffMin / 60} h; failed after ${limits.noCliffDays} days. ids: ${stuckIds.slice(0, 50).join(', ')}.`,
        context: { media_ids: stuckIds.slice(0, 200) },
        dedup_key: `comms_archive_stuck:${day}`,
      });
    }
    if (failedIds.length) {
      await alert(db, {
        kind: 'comms_archive_failed', group_key: 'comms_archive_failed', severity: 'error',
        title: `Comms archive: ${failedIds.length} media file(s) failed — retries ended`,
        message: `Still not archivable ${limits.noCliffDays} days on (provider failures, a line that is not a ` +
          `phone_lines row, or shape drift) — see comms_media.last_error. ids: ${failedIds.slice(0, 50).join(', ')}.`,
        context: { media_ids: failedIds.slice(0, 200) },
        dedup_key: `comms_archive_failed:${day}`,
      });
    }
    for (const [line, ids] of noLine) {
      await ops.escalatingAlert(db, `comms_archive_no_line:${line}`, 'comms_archive_no_line',
        `Comms archive: line ${line} is not a phone line — its media waits`,
        `Call recordings / MMS on ${line} have no phone_lines row, so no credential to fetch with. They ` +
        `stay pending (6 h backoff, uncharged) and archive on their own once the line is added; failed ` +
        `after ${limits.noCliffDays} days. comms_media ids: ${ids.slice(0, 50).join(', ')}.`,
        { line, media_ids: ids.slice(0, 200) });
    }
  } catch (err) {
    console.error('[COMMS ARCHIVE] media row alerts failed:', err.message);
  }
}

module.exports = { runMediaSweep, discoverQuoCalls, discoverMms, unknownQuoCallStatuses, quoMediaId, limits, LOCK_EXPR, QUO_REC_STATUS };
