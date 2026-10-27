// services/commsArchiveMediaSweep.js
//
/**
 * comms_archive_media_sweep — one bounded tick of the comms archive for
 * everything EXCEPT RingCentral call recordings (those are
 * services/commsArchiveSweep.js — the 90-day cliff, the RC Heavy budget):
 *   - Quo call recordings     (kind call_recording, provider quo)
 *   - RingCentral MMS files   (kind mms_file, provider ringcentral)
 *   - Quo MMS files           (kind mms_file, provider quo)
 *   - voicemails (S1c, R10)   (kind voicemail): RingCentral's from the
 *     extension's message-store (source_table 'rc_message', source_id = the
 *     RC message id — most predate phone ingest, so there is no call row),
 *     Quo's per call from /v1/call-voicemails (source_table phone_event_log).
 *     A Quo 404 is HELD (not-yet, re-checked every 24 h) for 7 days on the
 *     call clock before `none` — "404 = no voicemail" is undocumented — and a
 *     sanity alarm warns daily until the first Quo voicemail is archived.
 *   - VENDOR voicemail transcripts (kind stt_raw, R10 / C1): Quo's
 *     `transcript` (written straight after its voicemail's audio) and RC's
 *     AudioTranscription attachment (when vmTranscriptionStatus is
 *     Completed — its own pending row, fetched like an MMS file), each as a
 *     JSON object phone/stt/<yyyy>/<mm>/<voicemail id>.<vendor>.json and a
 *     comms_media row (source_table 'comms_media', source_id = the
 *     voicemail's id, restricted inherited). SECONDARY: S2's AssemblyAI
 *     transcript stays canonical. A transcript problem NEVER parks or
 *     charges the voicemail — at most it is drift, alerted.
 * ref/COMMS_ARCHIVE_DESIGN.md §6.1. Same kill switch (comms_archive_enabled),
 * its own lock CONCAT('comms_archive_media:', DATABASE()), its own budgets, so
 * it can never compete with the cliff sweep.
 *
 * ── ADAPTERS ───────────────────────────────────────────────────────────────
 * Reached through phoneService.getAdapter (never a direct require); each must
 * declare capabilities.archiveFetch and export RC_FNS / QUO_FNS. One that
 * does not stops its provider for the tick with an `error` alert
 * (comms_archive_adapter) — no row of it is claimed; the other goes on.
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
 * well-formed `data: []` (or a recording status that means no file), or from
 * Quo's "Call not found" on the recording list — a 404 carrying BOTH code
 * 0900404 and that message, on a placeholder whose call is 24 h+ old on the
 * call clock (uncharged, never stuck; younger: not yet). Any other 404 there
 * stays a charged provider failure.
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
// GET_LOCK names are limited to 64 characters: a database name over 32 characters is hashed
// (production's is 14 — its lock name is unchanged). Kept byte-identical to commsArchiveAdmin.SWEEP_LOCKS.
const LOCK_EXPR = "CONCAT('comms_archive_media:', IF(CHAR_LENGTH(DATABASE()) > 32, LEFT(SHA2(DATABASE(), 256), 32), DATABASE()))";
const ENABLED_KEY = 'comms_archive_enabled';
// What this sweep calls on each adapter — part of what the adapter's
// capabilities.archiveFetch promises (services/adapters/phone/<provider>.js).
const RC_FNS = ['checkArchiveAuth', 'listVoicemails', 'fetchMessageAttachment'];
const QUO_FNS = ['checkArchiveAuth', 'getCallVoicemail', 'listCallRecordings', 'getMessage', 'fetchSigned'];

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
  rcLightPerTick: 3,           // RC voicemail listing pages per listing (Light group)
  rcVmPageTimeoutMs: 10_000,
  vmEpoch: '2016-01-01T00:00:00.000Z',
  /** The top-of-the-hour half of "is the RC voicemail listing due?" (UTC minute 0-1; tests override). */
  rcVmMinuteDue: () => new Date().getUTCMinutes() <= 1,
  rcVmStaleMin: 90,            // …or the last COMPLETED listing is older than this
  rcVmAlarmHours: 6,           // no completed listing this long → alarm (warning → error)
  rcVmHistoryRows: 240,        // job_results rows read back (~8 h of 2-min ticks)
  quoVmSanityErrorHours: 48,   // the sanity alarm escalates to error after this long
  quoVm404HoldDays: 7,         // a Quo voicemail 404 is held this long (call clock) before none
  quoVm404RecheckMin: 1440,
  captureVoicemails: true,     // S1c; the suites for the other kinds turn it off to keep their scope
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

/** Quo voicemail placeholders: every Quo call we know (answered calls may route to voicemail too). */
async function discoverQuoVoicemails(db) {
  const [r] = await db.query(
    `INSERT IGNORE INTO comms_media
       (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state)
     SELECT 'phone', 'voicemail', ?, e.id, '', 'quo', pl.id, LEFT(e.other_party, 20),
            ${CALL_CLOCK}, 'pending'
       FROM phone_event_log e
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
      WHERE e.provider = 'quo' AND e.event_type = 'call' AND e.suppressed = 0
        AND JSON_VALUE(e.raw_extra, '$.provider_status') IN ('completed', 'no-answer')
        AND NOT EXISTS (SELECT 1 FROM comms_media m
                         WHERE m.source_table = ? AND m.source_id = e.id AND m.kind = 'voicemail')
      ORDER BY ${CALL_CLOCK} ASC, e.id ASC
      LIMIT ?`,
    [SOURCE, SOURCE, limits.discoverLimit],
  );
  return r.affectedRows || 0;
}

/** RC credentials in use (data: phone_lines), for the voicemail listing. */
async function _rcCredentials(db) {
  const [rows] = await db.query(
    `SELECT DISTINCT credential_id FROM phone_lines WHERE provider = 'ringcentral' ORDER BY credential_id`);
  return rows.map(r => r.credential_id);
}

const _ten = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : (d.length === 10 ? d : null);
};

/**
 * RC voicemail discovery (S1c) — STATELESS: the extension message-store is
 * listed in FULL from a fixed epoch (2016-01-01) at most once an hour (on a
 * tick whose UTC minute is 0–1), after the row work, ≤ rcLightPerTick pages
 * (more = drift: > 300 voicemails ever is loud, not silent), each page call
 * capped at rcVmPageTimeoutMs. No watermark: a record skipped or drifted this
 * hour is simply listed — and alerted — again next hour.
 * Rows: one per AudioRecording attachment of an Alive or Deleted (still in
 * RC's trash, retrievable) voicemail; Purged is skipped. A voicemail OUR
 * registry has purged is never touched again (no transcript child either).
 * Anything off the probed shape is drift — alerted, never "no voicemail".
 * 401/403 is the credential's: the no_auth alert, not drift.
 * ASSUMPTION (verified 2026-10-14 via the temp route): the account has ONE
 * active User extension (55880693); the other extensions (Department 1,
 * Voicemail 2) are NotActivated, plus the company extension — so `~`, the
 * authenticated extension, covers every voicemail today.
 */
async function _discoverRcVoicemails(db, rc, { hardDeadline, acc, out }) {
  const creds = await _rcCredentials(db);
  const dateFrom = new Date(limits.vmEpoch);
  const [lines] = await db.query(`SELECT id, phone_number FROM phone_lines`);
  const lineByNumber = new Map(lines.map(l => [String(l.phone_number), l.id]));
  // Its OWN alert group (review L2): listing trouble must not eat the day's
  // shape-drift alert for per-row drift.
  const driftAll = (what) => { acc.listingDrift.push(what); out.drift++; };
  let complete = true;
  const stop = (what) => { driftAll(what); complete = false; };
  for (const credentialId of creds) {
    if (!await rc.checkArchiveAuth(db, credentialId)) { await _noAuthAlert(db, 'ringcentral', credentialId); continue; }
    for (let page = 1; ; page++) {
      if (Date.now() + limits.rcVmPageTimeoutMs >= hardDeadline) { stop('voicemail listing cut short by the tick deadline'); return false; }
      out.rc_light_used++;
      const r = await rc.listVoicemails(db, { credentialId, dateFrom, page, timeoutMs: limits.rcVmPageTimeoutMs });
      if (r.status === 401 || r.status === 403) {
        await _noAuthAlert(db, 'ringcentral', credentialId,
          _authDetail(out, 'ringcentral', '/restapi/v1.0/account/~/extension/~/message-store?messageType=VoiceMail', r));
        complete = false;
        break;
      }
      if (r.status !== 200) {
        // A 429 stays quiet for the tick; the staleness alarm is its backstop.
        if (r.status !== 429) driftAll(`voicemail listing ${r.status}`);
        return false;
      }
      const recs = r.json && r.json.records;
      const paging = r.json && r.json.paging;
      if (!Array.isArray(recs) || !paging || typeof paging !== 'object') {
        stop(`voicemail listing: records/paging ${r.json === undefined ? 'unparseable' : 'missing'}`);
        return false;
      }
      for (const rec of recs) {
        const msgId = rec && rec.id != null ? String(rec.id) : '';
        const created = rec && rec.creationTime ? new Date(rec.creationTime) : null;
        if (!/^\d+$/.test(msgId) || !created || Number.isNaN(created.getTime()) || !Array.isArray(rec.attachments)) {
          driftAll(`voicemail record without id / creationTime / attachments (${clamp(msgId, 20)})`);
          continue;
        }
        if (rec.availability === 'Purged') continue;
        if (rec.availability !== 'Alive' && rec.availability !== 'Deleted') {
          driftAll(`voicemail ${msgId}: unknown availability ${JSON.stringify(rec.availability)}`);
          continue;
        }
        const [[have]] = await db.query(
          `SELECT id, state FROM comms_media WHERE source_table = 'rc_message' AND source_id = ? AND kind = 'voicemail' ORDER BY id LIMIT 1`, [msgId]);
        if (have) {
          // Purged here = purged for good: never a late transcript under it (review M1).
          if (have.state !== 'purged') await _rcTranscriptRow(db, rec, have.id, acc, out);
          continue;
        }
        const audio = rec.attachments.filter(a => a && a.type === 'AudioRecording');
        if (!audio.length || audio.some(a => a.id == null || !/^\d+$/.test(String(a.id)))) {
          driftAll(`voicemail ${msgId}: no AudioRecording with an id`);
          continue;
        }
        // The line is the number the voicemail was LEFT ON (to[]), mapped to
        // phone_lines whatever that line's provider is TODAY: a 2021 RC
        // voicemail to 2484179800 (a Quo line since) anchors to that Quo line.
        // Correct under R6 — access follows the line, not the provider. Do
        // not "fix" this to a provider match. No to-number → channel_id NULL
        // (S4 decides visibility; §7).
        const toNum = (Array.isArray(rec.to) ? rec.to : []).map(t => _ten(t && t.phoneNumber)).find(Boolean) || null;
        const channelId = toNum && lineByNumber.has(toNum) ? lineByNumber.get(toNum) : null;
        const party = _ten(rec.from && rec.from.phoneNumber);
        for (const a of audio) {
          const [ins] = await db.query(
            `INSERT IGNORE INTO comms_media
               (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, state)
             VALUES ('phone', 'voicemail', 'rc_message', ?, ?, 'ringcentral', ?, ?, ?, 'pending')`,
            [msgId, String(a.id), channelId, party, created],
          );
          out.discovered_rc_vm += ins.affectedRows || 0;
        }
        const [[mine]] = await db.query(
          `SELECT id FROM comms_media WHERE source_table = 'rc_message' AND source_id = ? AND kind = 'voicemail' ORDER BY id LIMIT 1`, [msgId]);
        if (mine) await _rcTranscriptRow(db, rec, mine.id, acc, out);
      }
      const totalPages = Number(paging.totalPages) || 1;
      if (page >= totalPages) break;
      if (page >= limits.rcLightPerTick) {
        stop(`voicemail listing has ${totalPages} pages since ${limits.vmEpoch.slice(0, 10)}; only ${limits.rcLightPerTick} read per listing`);
        return false;
      }
    }
  }
  return complete;
}

/**
 * When did a tick last COMPLETE the RC voicemail listing (review L1)? Read
 * back from job_results — the tick's own output (out.rc_vm_listing =
 * 'complete') as process_jobs records it — over the newest rcVmHistoryRows
 * rows of the media-sweep job (idx_job, backward scan; no new state). Hand
 * runs record no job_results and simply don't count.
 * → { last: Date|null, oldest: Date|null } (oldest = the window's start).
 */
async function _rcVmListingHistory(db) {
  const [[job]] = await db.query(
    `SELECT id FROM scheduled_jobs WHERE idempotency_key = 'comms_archive_media_sweep' LIMIT 1`);
  if (!job) return { last: null, oldest: null };
  const [rows] = await db.query(
    `SELECT executed_at,
            JSON_VALUE(output_data, '$.output.rc_vm_listing') = 'complete' AS done
       FROM job_results WHERE job_id = ? ORDER BY id DESC LIMIT ?`,
    [job.id, limits.rcVmHistoryRows]);
  const hit = rows.find(r => Number(r.done) === 1);
  return {
    last: hit ? new Date(hit.executed_at) : null,
    oldest: rows.length ? new Date(rows[rows.length - 1].executed_at) : null,
  };
}

/**
 * RC vendor transcript (R10): a voicemail whose vmTranscriptionStatus is
 * 'Completed' carries an attachment of type AudioTranscription (RC Message
 * Store API: message attachments, type AudioTranscription, text/plain — the
 * six live voicemails all say NotAvailable, so this path is built from the
 * documented shape). One pending stt_raw row per such attachment, child of
 * the voicemail row; idempotent. An odd shape is drift — never a voicemail
 * park.
 */
async function _rcTranscriptRow(db, rec, voicemailId, acc, out) {
  if (rec.vmTranscriptionStatus !== 'Completed') return;
  const tr = rec.attachments.filter(a => a && a.type === 'AudioTranscription');
  if (!tr.length || tr.some(a => a.id == null || !/^\d+$/.test(String(a.id)))) {
    acc.drift.push({ id: voicemailId, lane: 'ringcentral:stt_raw', what: `voicemail ${rec.id}: transcription Completed but no AudioTranscription attachment with an id` });
    out.drift++;
    return;
  }
  for (const a of tr) {
    // The existence check counts ONLY an RC vendor transcript child (provider
    // 'ringcentral', part = RC's numeric attachment id). Other stt_raw children
    // of the same voicemail — Quo's (part 'quo'), S2's (part 'assemblyai…') —
    // must never block RC's own transcript from being discovered.
    const [ins] = await db.query(
      `INSERT IGNORE INTO comms_media
         (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, restricted, state)
       SELECT channel, 'stt_raw', 'comms_media', id, ?, 'ringcentral', channel_id, party, captured_at, restricted, 'pending'
         FROM comms_media
        WHERE id = ? AND state <> 'purged'
          AND NOT EXISTS (SELECT 1 FROM comms_media s
                           WHERE s.source_table = 'comms_media' AND s.source_id = ? AND s.kind = 'stt_raw'
                             AND s.provider = 'ringcentral' AND s.part REGEXP '^[0-9]+$')`,
      [String(a.id), voicemailId, voicemailId],
    );
    out.discovered_vm_transcripts = (out.discovered_vm_transcripts || 0) + (ins.affectedRows || 0);
  }
}

/**
 * Write a vendor transcript JSON next to its (already archived) voicemail
 * and register it as an archived stt_raw row. Never throws: a failure is
 * drift (alerted), the voicemail is untouched.
 */
async function _storeVendorTranscript(db, vm, { vendor, payload }, acc, out, timeoutMs) {
  try {
    // Never under a purged voicemail - not even the object (review M1).
    const [[p]] = await db.query('SELECT state FROM comms_media WHERE id = ?', [vm.id]);
    if (!p || p.state === 'purged') return;
    const buf = Buffer.from(JSON.stringify(payload));
    const objectName = archive.sttPrefix({ capturedAt: vm.captured_at, parentId: vm.id }) + `${vendor}.json`;
    let put;
    try {
      put = await archive.putStream(require('stream').Readable.from([buf]), {
        objectName, mime: 'application/json', expectedBytes: buf.length, timeoutMs,
      });
    } catch (err) {
      if (err.code !== 'EXISTS') throw err;
      put = await archive.rehash(objectName, { timeoutMs });
    }
    const [ins] = await db.query(
      `INSERT IGNORE INTO comms_media
         (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, restricted,
          state, object_name, mime, bytes, sha256, archived_at)
       SELECT channel, 'stt_raw', 'comms_media', id, ?, provider, channel_id, party, captured_at, restricted,
              'archived', ?, 'application/json', ?, ?, UTC_TIMESTAMP()
         FROM comms_media WHERE id = ? AND state <> 'purged'`,
      [vendor, objectName, put.bytes, put.sha256, vm.id],
    );
    out.vm_transcripts = (out.vm_transcripts || 0) + (ins.affectedRows || 0);
  } catch (err) {
    // The voicemail stays archived either way. Our storage failing is a
    // storage alert (escalating); anything else is drift.
    if (err && err.ourSide) {
      out.transcript_storage_errors = (out.transcript_storage_errors || 0) + 1;
      await ops.escalatingAlert(db, 'comms_archive_storage', 'comms_archive_storage',
        'Comms archive: a vendor transcript could not be stored',
        `${err.message}\n\nIts voicemail (comms_media ${vm.id}) is archived; only the secondary transcript is missing.`,
        { error: clamp(err.message, 300), media_id: vm.id });
      return;
    }
    acc.drift.push({ id: vm.id, lane: `${vendor}:stt_raw`, what: `vendor transcript not stored: ${clamp(err && err.message, 150)}` });
    out.drift++;
  }
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
  const params = [];
  if (skipIds.length) { conds.push('AND m.id NOT IN (?)'); params.push(skipIds); }
  if (skipProviders.size) { conds.push('AND m.provider NOT IN (?)'); params.push([...skipProviders]); }
  const [[row]] = await db.query(
    `SELECT m.id, m.kind, m.provider, m.source_table, m.source_id, m.part, m.captured_at, m.created_at,
            m.attempts, m.channel_id, m.restricted,
            e.provider_ref, e.line_number,
            pl.id AS line_id, pl.credential_id, pl.display_name AS line_name,
            p.source_id AS parent_source_id, p.state AS parent_state
       FROM comms_media m
       LEFT JOIN phone_event_log e ON m.source_table = 'phone_event_log' AND e.id = m.source_id
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
       LEFT JOIN comms_media p ON m.source_table = 'comms_media' AND p.id = m.source_id
      WHERE m.state = 'pending'
        AND ((m.source_table = 'phone_event_log'
              AND ((m.kind = 'call_recording' AND m.provider = 'quo')
                   OR (m.kind = 'mms_file' AND m.provider IN ('ringcentral', 'quo'))
                   OR (m.kind = 'voicemail' AND m.provider = 'quo' AND ${limits.captureVoicemails ? 1 : 0})))
             OR (m.source_table = 'rc_message' AND m.kind = 'voicemail' AND m.provider = 'ringcentral')
             OR (m.source_table = 'comms_media' AND m.kind = 'stt_raw' AND m.provider = 'ringcentral'))
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= UTC_TIMESTAMP())
        ${conds.join(' ')}
      ORDER BY m.captured_at ASC, m.id ASC
      LIMIT 1`,
    params,
  );
  return row || null;
}

const _prefixFor = (row) => archive.prefixFor(row);

/** Key a drift / stop by provider + kind so one provider's trouble never stops another. */
const _lane = (row) => `${row.provider}:${row.kind}`;

// ─────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {object} [opts] { rc?, quo? (adapter overrides for tests: used as
 *   given — production takes the registry's, via common.archiveAdapter) }
 */
async function runMediaSweep(db, opts = {}) {
  const startedAt = Date.now();
  const out = {
    enabled: false, discovered_calls: 0, discovered_mms: 0,
    archived: 0, adopted: 0, resolved: 0, split: 0, none: 0, gone: 0, failed: 0, stuck: 0,
    retried: 0, not_yet: 0, drift: 0, no_line: 0, rc_used: 0, quo_used: 0,
    discovered_vm: 0, discovered_rc_vm: 0, vm_held404: 0, rc_light_used: 0, quo_call_not_found: 0,
    stopped: {}, stop: null,
  };
  const acc = { goneIds: [], failedIds: [], stuckIds: [], drift: [], listingDrift: [], notYetOld: [], noLine: new Map(), quoForbidden: new Map() };
  try {
    await _tick(db, opts, out, acc, startedAt);
  } finally {
    await _rowAlerts(db, acc);
    await _quoForbiddenAlerts(db, acc, out);
    if (out.enabled && out.skipped !== 'locked' && limits.captureVoicemails) {
      await _quoVoicemailSanity(db);
      await _rcVmListingStaleness(db, out);
    }
    out.elapsed_ms = Date.now() - startedAt;
  }
  return out;
}

async function _tick(db, opts, out, acc, startedAt) {
  const deadline = startedAt + limits.deadlineMs;
  const hardDeadline = startedAt + limits.hardDeadlineMs;
  const io = () => Math.max(hardDeadline - Date.now(), limits.minIoMs);
  let rc = opts.rc || null;     // else the registry's, resolved before the row work
  let quo = opts.quo || null;
  const { getSetting } = require('./settingsService');            // lazy require (convention)

  out.enabled = (await getSetting(db, ENABLED_KEY)) === '1';
  if (!out.enabled) { out.skipped = `${ENABLED_KEY} is not "1"`; return; }

  const lock = await common.acquireLock(db, LOCK_EXPR);
  if (!lock) { out.skipped = 'locked'; return; }

  // EVERYTHING after the lock runs inside this try, so its finally releases
  // the lock however the tick ends (a throw outside it leaked the lock and
  // stalled every later tick — found 2026-10-14).
  try {
    // The RC voicemail listing: due decided at the START (review L1) — the
    // top of the hour, OR the last completed listing is stale (a skipped :00
    // — a late start behind the cliff sweep, a long row loop, a held lock, a
    // failed pre-flight — catches up on the next tick instead of silently
    // waiting). If the history can't be read, the top-of-the-hour rule alone
    // decides; the tick is not failed for it.
    if (limits.captureVoicemails) {
      let staleMs = Infinity;
      try {
        const vmHistory = await _rcVmListingHistory(db);
        staleMs = vmHistory.last ? Date.now() - vmHistory.last.getTime() : Infinity;
        out.rc_vm_due = limits.rcVmMinuteDue() || staleMs > limits.rcVmStaleMin * 60_000;
      } catch (err) {
        console.error('[COMMS ARCHIVE] rc voicemail listing history unreadable:', err.message);
        out.rc_vm_due = limits.rcVmMinuteDue();
      }
    }

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

    // ── Adapters, through phoneService's registry ─────────────────────────
    // A provider whose adapter fails the check (missing, no
    // capabilities.archiveFetch, a promised function absent) is stopped for
    // the tick and alerted at `error` — never skipped in silence. Its rows
    // stay pending and unclaimed; the other provider's work goes on.
    const registryAdapter = async (p, fns) => {
      const r = common.archiveAdapter(p, fns);
      if (r.adapter) return r.adapter;
      stopProvider(p, 'adapter');
      (out.adapter_errors = out.adapter_errors || {})[p] = r.error;
      await common.adapterAlert(db, { provider: p, sweep: 'comms_archive_media_sweep', error: r.error });
      return null;
    };
    if (!rc) rc = await registryAdapter('ringcentral', RC_FNS);
    if (!quo) quo = await registryAdapter('quo', QUO_FNS);

    if (limits.captureVoicemails) out.discovered_vm = await discoverQuoVoicemails(db);

    for (;;) {
      if (Date.now() >= deadline) { out.stop = out.stop || 'deadline'; break; }
      if (out.stop) break;
      const row = await _nextDue(db, skipIds, skipProviders);
      if (!row) { out.stop = 'drained'; break; }
      skipIds.push(row.id);

      // RC voicemails (rc_message) carry no call row: they are fetched with the
      // RC credential that listed them — the ONE RC credential in phone_lines
      // (data). More than one would make that ambiguous: park + alert, never
      // guess (a schema slot for it is the fix if the firm ever adds one).
      if (row.source_table === 'rc_message' || (row.kind === 'stt_raw' && row.provider === 'ringcentral')) {
        const creds = await _rcCredentials(db);
        if (creds.length !== 1) {
          await ops.park(db, row.id, limits.driftBackoffMin, `rc voicemail: ${creds.length} RC credentials — ambiguous`);
          acc.drift.push({ id: row.id, lane: _lane(row), what: `${creds.length} RC credentials in phone_lines — which one owns this voicemail is ambiguous` });
          out.drift++;
          continue;
        }
        row.credential_id = creds[0];
        row.line_id = row.channel_id;            // may be NULL (no to-number) — never no_line
      } else
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
      if (row.channel_id == null && row.line_id != null) {
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
        let vendorTranscript = null;   // Quo voicemail: { vendor, payload } to store after the audio

        if (row.kind === 'voicemail' && row.provider === 'quo') {
          // ── Quo voicemail (S1c): one per call ────────────────────────────
          if (!await slot('quo')) { await ops.refund(db, row.id, null); continue; }
          const r = await quo.getCallVoicemail(db, { credentialId: row.credential_id, callId: row.provider_ref, timeoutMs: Math.min(io(), 30_000) });
          if (r.status === 404) {
            // Undocumented: probably "no voicemail". HELD - its own uncharged
            // park, re-checked daily - then none. Not part of the quo_not_yet
            // alert (the sanity alarm covers the 404 reading).
            // The hold counts from the LATER of the call and the row's creation
            // (~ the first check): a wrong 404 reading is caught before anything
            // goes terminal, even for calls already old at go-live (review M2).
            const holdStart = new Date(Math.max(new Date(row.captured_at).getTime(), new Date(row.created_at).getTime()));
            const holdEnd = new Date(holdStart.getTime() + limits.quoVm404HoldDays * 86400_000);
            if (Date.now() >= holdEnd.getTime()) {
              await db.query(
                `UPDATE comms_media SET state = 'none', attempts = GREATEST(attempts, 1) - 1, next_attempt_at = NULL, last_error = ?
                  WHERE id = ? AND state = 'pending'`,
                [`quo voicemail: 404 held ${limits.quoVm404HoldDays} days (since ${holdStart.toISOString().slice(0, 10)}) - none`, row.id]);
              out.none++;
            } else {
              await ops.park(db, row.id, limits.quoVm404RecheckMin,
                `quo voicemail: 404 held since ${holdStart.toISOString().slice(0, 10)}, until ${holdEnd.toISOString().slice(0, 10)}`);
              out.vm_held404++;
            }
            continue;
          }
          // A 403 here parks THIS voicemail row (per-line alert), a 401 stops Quo — the same rule as recordings / MMS.
          if (await _apiStatus(db, row, r, attemptsNow, 'quo', 'call-voicemails', stopProvider, count, out, acc)) continue;
          const d = r.json && r.json.data;
          if (!d || typeof d !== 'object' || Array.isArray(d)) { await drift(row, `call-voicemails: \`data\` is ${r.json === undefined ? 'unparseable' : (d === undefined ? 'missing' : (Array.isArray(d) ? 'an array' : typeof d))}`); continue; }
          if (typeof d.id !== 'string' || !/^VM/.test(d.id)) { await drift(row, `call-voicemails: id ${JSON.stringify(d.id)} is not a VM id`); continue; }
          if (d.status === 'in-progress') {
            const t = ops.terminalReason(row, { uncharged: true });
            if (t) { await ops.fail(db, row.id, `quo voicemail still in-progress — ${t}`); count('failed', row.id); continue; }
            await ops.park(db, row.id, limits.notYetBackoffMin, 'voicemail in-progress');
            out.not_yet++;
            if (ageHours(row.captured_at) >= limits.notYetAlertHours) acc.notYetOld.push({ id: row.id, status: 'voicemail in-progress' });
            continue;
          }
          if (d.status !== 'completed') { await drift(row, `call-voicemails: unknown status ${JSON.stringify(d.status)}`); continue; }
          if (typeof d.recordingUrl !== 'string' || !d.recordingUrl) { count(await ops.transient(db, row, attemptsNow, 'quo: completed voicemail without a recordingUrl'), row.id); continue; }
          // R10: Quo's own transcript, kept as a secondary stt_raw record once
          // the audio is archived (below). Odd shape → drift log only.
          if (typeof d.transcript === 'string' && d.transcript.trim()) {
            vendorTranscript = { vendor: 'quo', payload: { vendor: 'quo', voicemail_id: d.id, transcript: d.transcript, fetched_at: new Date().toISOString() } };
          } else if (d.transcript != null && typeof d.transcript !== 'string') {
            acc.drift.push({ id: row.id, lane: 'quo:stt_raw', what: `call-voicemails: transcript is ${typeof d.transcript}` });
            out.drift++;
          }
          if (!row.part) {
            await db.query(`UPDATE comms_media SET part = ? WHERE id = ? AND state = 'pending' AND part = ''`, [clamp(d.id, 64), row.id]);
            row.part = clamp(d.id, 64);
          } else if (row.part !== d.id) {
            await drift(row, `call-voicemails: id ${d.id} differs from the stored ${row.part}`);
            continue;
          }
          const ms = io();
          fetchDeadline = Date.now() + ms;
          try { res = await quo.fetchSigned(d.recordingUrl, { timeoutMs: ms }); }
          catch (err) { if (err.code === 'BAD_URL') { await drift(row, `voicemail url ${err.message}`); continue; } throw err; }
          if (res.status === 200) {
            const c = archive.classifyMedia(res.contentType, null);
            if (c.error) { res.body && res.body.destroy(); count(await ops.transient(db, row, attemptsNow, `download ${res.host}: ${c.error}`), row.id); continue; }
            store = c;
          }
        } else if (row.kind === 'stt_raw') {
          // ── RC vendor transcript (R10): the AudioTranscription attachment ─
          if (row.parent_state === 'purged') {
            // Its voicemail was purged after this row was made: purged with it.
            await db.query(`UPDATE comms_media SET state = 'purged', purged_at = UTC_TIMESTAMP(), purge_reason = 'parent purged', next_attempt_at = NULL
                              WHERE id = ? AND state = 'pending'`, [row.id]);
            continue;
          }
          if (!/^\d+$/.test(row.part || '') || !row.parent_source_id) { await drift(row, `rc transcript attachment ${JSON.stringify(row.part)}`); continue; }
          if (!await slot('ringcentral')) { await ops.refund(db, row.id, null); continue; }
          const ms = io();
          fetchDeadline = Date.now() + ms;
          const t = await rc.fetchMessageAttachment(db, { credentialId: row.credential_id, messageId: String(row.parent_source_id), attachmentId: row.part, timeoutMs: ms });
          if (t.status === 429) { await ops.refund(db, row.id, 'rc 429'); stopProvider('ringcentral', 'rate_limited'); continue; }
          if (t.status === 401 || t.status === 403) {
            await ops.refund(db, row.id, `rc ${t.status}`);
            await _noAuthAlert(db, 'ringcentral', row.credential_id,
              _authDetail(out, 'ringcentral', '/restapi/v1.0/account/~/extension/~/message-store/{id}/content/{id} (voicemail transcript)', t));
            stopProvider('ringcentral', 'no_auth');
            continue;
          }
          if (t.status !== 200) { count(await ops.transient(db, row, attemptsNow, `transcript content ${t.status}`), row.id); continue; }
          if (!/^text\//i.test(String(t.contentType || ''))) { t.body && t.body.destroy(); await drift(row, `rc transcript content-type ${clamp(t.contentType, 60)}`); continue; }
          const chunks = [];
          let n = 0;
          for await (const c of t.body) { n += c.length; if (n > 1_000_000) break; chunks.push(c); }
          if (n > 1_000_000) { t.body.destroy(); await drift(row, 'rc transcript over 1 MB'); continue; }
          const buf = Buffer.from(JSON.stringify({
            vendor: 'ringcentral', message_id: String(row.parent_source_id), attachment_id: row.part,
            transcript: Buffer.concat(chunks).toString('utf8'), fetched_at: new Date().toISOString(),
          }));
          res = { status: 200, host: 'media.ringcentral.com', contentType: 'application/json', contentLength: buf.length, body: require('stream').Readable.from([buf]) };
          store = { mime: 'application/json', ext: 'ringcentral.json', note: null };
        } else if (row.kind === 'voicemail') {
          // ── RC voicemail (S1c): message-store content (Medium) ──────────
          if (!/^\d+$/.test(row.part || '')) { await drift(row, `rc voicemail attachment id ${JSON.stringify(row.part)}`); continue; }
          if (!await slot('ringcentral')) { await ops.refund(db, row.id, null); continue; }
          const ms = io();
          fetchDeadline = Date.now() + ms;
          res = await rc.fetchMessageAttachment(db, { credentialId: row.credential_id, messageId: String(row.source_id), attachmentId: row.part, timeoutMs: ms });
          res.host = 'media.ringcentral.com';
          if (res.status === 429) { await ops.refund(db, row.id, 'rc 429'); stopProvider('ringcentral', 'rate_limited'); continue; }
          if (res.status === 401 || res.status === 403) {
            await ops.refund(db, row.id, `rc ${res.status}`);
            await _noAuthAlert(db, 'ringcentral', row.credential_id,
              _authDetail(out, 'ringcentral', '/restapi/v1.0/account/~/extension/~/message-store/{id}/content/{id} (voicemail)', res));
            stopProvider('ringcentral', 'no_auth');
            continue;
          }
          if (res.status === 200) {
            const c = archive.classifyMedia(res.contentType, null);
            if (c.error) { res.body && res.body.destroy(); count(await ops.transient(db, row, attemptsNow, `content: ${c.error}`), row.id); continue; }
            store = c;
          }
        } else if (row.provider === 'quo' && row.kind === 'call_recording') {
          // ── Quo recording: list, then (per row) the item's signed URL ──
          if (!await slot('quo')) { await ops.refund(db, row.id, null); continue; }
          const r = await quo.listCallRecordings(db, { credentialId: row.credential_id, callId: row.provider_ref, timeoutMs: Math.min(io(), 30_000) });
          if (!row.part && _quoCallNotFound(r)) {
            // Quo does not know the call: no recording will ever be listed.
            // Uncharged either way, never stuck. A call under noneAfterHours
            // may still be settling at Quo → not yet (the "nothing listed
            // yet" park); older → none. Placeholders only: a resolved row
            // (Quo listed recordings for this call before) keeps the charged
            // path below, so that contradiction reaches a human.
            if (ageHours(row.captured_at) >= limits.noneAfterHours) {
              await db.query(
                `UPDATE comms_media SET state = 'none', attempts = GREATEST(attempts, 1) - 1, next_attempt_at = NULL, last_error = ?
                  WHERE id = ? AND state = 'pending'`,
                [`quo call-recordings 404 Call not found (${limits.noneAfterHours} h+) - none`, row.id]);
              out.none++;
              out.quo_call_not_found++;
            } else {
              await ops.park(db, row.id, limits.notYetBackoffMin,
                `quo call-recordings 404 Call not found (call under ${limits.noneAfterHours} h) - not yet`);
              out.not_yet++;
            }
            continue;
          }
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
            if (vendorTranscript) await _storeVendorTranscript(db, row, vendorTranscript, acc, out, io());
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
        if (vendorTranscript) await _storeVendorTranscript(db, row, vendorTranscript, acc, out, io());
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
    // -- RC voicemail listing: hourly, stateless, AFTER the row work --
    // Fenced: a listing failure (network, timeout) is drift for the hour; it
    // never stops the rest of the tick.
    if (limits.captureVoicemails && out.rc_vm_due && !rc) {
      out.rc_vm_listing = 'incomplete';   // the RC adapter failed its check (alerted above)
    } else if (limits.captureVoicemails && out.rc_vm_due) {
      out.rc_vm_listed = true;
      try {
        const ok = await _discoverRcVoicemails(db, rc, { hardDeadline, acc, out });
        out.rc_vm_listing = ok ? 'complete' : 'incomplete';
      } catch (err) {
        out.rc_vm_listing = 'incomplete';
        if (err && err.code === 'NO_AUTH') await _noAuthAlert(db, 'ringcentral', '(voicemail listing)');
        else {
          acc.listingDrift.push(`voicemail listing failed: ${clamp(err && err.message, 150)}`);
          out.drift++;
        }
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
 * Quo's "Call not found" on GET /v1/call-recordings/<callId> (live 2026-10:
 * 404 {"message":"Call not found","code":"0900404",…} — Quo does not know the
 * call id). BOTH the code and the message are required: the outcome is a
 * terminal, silent `none`, so a 404 that matches only one of them (a reworded
 * message, a code shared by another not-found) keeps the charged-retry path
 * and its stuck alert instead of closing a row Quo might still serve.
 */
function _quoCallNotFound(r) {
  if (!r || r.status !== 404) return false;
  const qe = _quoError(r.errorText);
  return qe.code === '0900404' && /^call not found\.?$/i.test(String(qe.message || '').trim());
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

/**
 * The Quo voicemail SANITY ALARM (S1c): until the first Quo voicemail is
 * archived, one warning a day with the counts — so a wrong "404 = no
 * voicemail" reading cannot pass silently. Quiet for good after the first.
 */
async function _quoVoicemailSanity(db) {
  try {
    const [[c]] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(state = 'archived') AS found,
              SUM(state = 'none') AS none_n,
              SUM(state = 'pending' AND last_error LIKE 'quo voicemail: 404 held since %') AS held,
              SUM(state <> 'pending' OR last_error IS NOT NULL) AS checked
         FROM comms_media WHERE provider = 'quo' AND kind = 'voicemail'`);
    if (!c || !Number(c.total) || Number(c.found) > 0 || !Number(c.checked)) return;
    // Warning first; ERROR once the condition has persisted quoVmSanityErrorHours
    // (warnings never email on their own — a warning-only alarm is invisible).
    const [[first]] = await db.query(
      `SELECT MIN(created_at) AS t FROM system_alerts WHERE group_key = 'comms_archive_quo_vm_sanity'`);
    const persistedH = first && first.t ? (Date.now() - new Date(first.t).getTime()) / 3_600_000 : 0;
    const severity = persistedH >= limits.quoVmSanityErrorHours ? 'error' : 'warning';
    await alert(db, {
      kind: 'comms_archive_quo_vm_sanity', group_key: 'comms_archive_quo_vm_sanity', severity,
      title: 'Comms archive: no Quo voicemail archived yet',
      message: `Quo voicemails: ${Number(c.checked)} call(s) checked, ${Number(c.held) || 0} held on a 404, ` +
        `${Number(c.none_n) || 0} none, 0 found. If staff lines take voicemails, the reading of Quo's ` +
        `undocumented 404 ("no voicemail") is wrong — look before the 7-day holds turn to none. ` +
        `This goes quiet once the first Quo voicemail is archived.`,
      context: { checked: Number(c.checked), held404: Number(c.held) || 0, none: Number(c.none_n) || 0, found: 0 },
      dedup_key: `comms_archive_quo_vm_sanity:${severity}:${utcDate()}`,
    });
  } catch (err) {
    console.error('[COMMS ARCHIVE] quo voicemail sanity failed:', err.message);
  }
}

/**
 * The listing STALENESS alarm (review L1): no completed RC voicemail listing
 * in rcVmAlarmHours — warning, error on repeat. Backstop for every quiet
 * miss (a 429 on the listing, skipped hours, a listing that keeps failing).
 * "Never completed" counts once the job's own history spans the window.
 */
async function _rcVmListingStaleness(db, out) {
  try {
    if (out.rc_vm_listing === 'complete') return;
    const h = await _rcVmListingHistory(db);
    const windowMs = limits.rcVmAlarmHours * 3_600_000;
    const stale = h.last
      ? Date.now() - h.last.getTime() > windowMs
      : !!(h.oldest && Date.now() - h.oldest.getTime() > windowMs);
    if (!stale) return;
    await ops.escalatingAlert(db, 'comms_archive_rc_vm_listing_stale', 'comms_archive_rc_vm_listing_stale',
      `Comms archive: no completed RingCentral voicemail listing in ${limits.rcVmAlarmHours} h`,
      `Last completed listing: ${h.last ? h.last.toISOString() : 'never (in the recent job history)'}. ` +
      `New RC voicemails are not being discovered. Check comms_archive_media_sweep's job_results ` +
      `(rc_vm_listing, drift) and the RC credential.`,
      { last_complete: h.last ? h.last.toISOString() : null });
  } catch (err) {
    console.error('[COMMS ARCHIVE] rc voicemail listing staleness check failed:', err.message);
  }
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
async function _rowAlerts(db, { goneIds, failedIds, stuckIds, drift, listingDrift, notYetOld, noLine }) {
  try {
    const day = utcDate();
    if (listingDrift && listingDrift.length) {
      await alert(db, {
        kind: 'comms_archive_rc_vm_listing_drift', group_key: 'comms_archive_rc_vm_listing_drift', severity: 'error',
        title: 'Comms archive: the RingCentral voicemail listing did not match its probed shape',
        message: `Nothing is marked "no voicemail" on this evidence; the next listing re-reads everything. ` +
          listingDrift.slice(0, 20).join('; '),
        context: { items: listingDrift.slice(0, 100) },
        dedup_key: `comms_archive_rc_vm_listing_drift:${day}`,
      });
    }
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

module.exports = { runMediaSweep, discoverQuoCalls, discoverMms, discoverQuoVoicemails, unknownQuoCallStatuses, quoMediaId, limits, LOCK_EXPR, QUO_REC_STATUS, RC_FNS, QUO_FNS };
