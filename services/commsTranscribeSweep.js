// services/commsTranscribeSweep.js
//
/**
 * comms_transcribe_sweep — one bounded tick of comms archive TRANSCRIPTION
 * (ref/COMMS_ARCHIVE_DESIGN.md §6.3, §6.5, §8, §10; S2). Archived call
 * recordings and voicemails (comms_media, state archived) → AssemblyAI →
 * comms_transcripts (segments + full_text) and the vendor JSON in the
 * archive as an stt_raw child; then the vendor's copy is deleted.
 *
 * ── MODE (app_settings comms_transcribe_mode, read uncached, fail-closed) ──
 *   off     no NEW submissions. Jobs already in flight are still polled,
 *           stored and deleted (they are paid for; leaving them would strand
 *           a vendor copy), and owed deletes still run.
 *   sample  only the archive items listed in comms_eval_items (lane D's
 *           evaluation set — one list, owned by S0). The P6 short gate is
 *           BYPASSED (the rows were chosen on purpose); comms_no_transcribe,
 *           Restrict and both caps still apply. A 2-channel recording runs
 *           BOTH variants: the configured one into comms_transcripts, the
 *           other as an stt_raw child only (parts are named by VARIANT —
 *           'assemblyai' = diarized, 'assemblyai-mc' = multichannel — so a
 *           later default flip never renames history).
 *   on      every archived call_recording and voicemail; the configured
 *           variant only. Newest first (the same-hour target); the backlog
 *           drains behind.
 *   anything else = off, alerted.
 *
 * ── THE JOB LEDGER (comms_stt_jobs) ────────────────────────────────────────
 * Every POST gets a ledger row WRITTEN AHEAD of it ('unknown', with the sha256
 * of the URL it sends — one freshly signed URL per POST, so per job), then
 * resolved from the answer: accepted → submitted; unreadable 2xx → drift (the
 * id if one came back, else still unknown); no answer or 502/503/504 → still
 * unknown (the vendor may hold a job we never got an id for); a definite
 * refusal (4xx, 500) → refused, est 0. A process that dies mid-POST leaves the
 * 'unknown' row — the spend and the search survive it. The ledger is
 *   - the MONEY: month-to-date spend = every job submitted this UTC month, its
 *     billed cost once completed, its estimate until then — whatever later
 *     happens to the transcript row (resubmit, failure, purge). Purge never
 *     touches it: cost is not content. comms_transcripts.stt_cost_cents is
 *     kept equal to the sum of its row's jobs.
 *   - the DELETES: a job with a ref, not deleted, and not the live job of a
 *     'transcribing' row is owed a vendor DELETE; it is retried with backoff
 *     until the vendor confirms (2xx or 404) — never stamped otherwise.
 *   - the ORPHAN SEARCH: an 'unknown' job (POST timed out) carries the sha256
 *     of the signed URL we sent (never the URL — it is a bearer link); the
 *     sweep lists the vendor's transcripts of that UTC day and matches
 *     sha256(audio_url). Found → 'orphan', deleted like any other. Not found
 *     in 24 h → a warning alert; the vendor's 30-day TTL is the backstop.
 *   - the FAILURE COUNT: a row's MAIN jobs that ended error / lost / drift /
 *     unknown. maxAttempts of them → `failed`. Separate from `attempts`
 *     (transport failures — 5xx / network — which back off and go `failed`
 *     only 30 days after they ran out).
 *
 * ── ONE TICK (lock CONCAT('comms_archive_transcribe:', DATABASE()); loser
 *    returns skipped:'locked'; deadlineMs stops starting new work; every call
 *    is time-bounded; nothing is awaited between the lock and the try) ─────
 *   0. Pre-flight: config parsed (a bad credential id / gate knob stops the
 *      tick, alerted), the credential yields an Authorization header.
 *   1. POLL due 'transcribing' rows (every mode).
 *   1b. ORPHAN SEARCH, then OWED DELETES (every mode) — before any new submit,
 *      so a tick that a bad POST stops has already paid what it owed.
 *   2. DISCOVER (mode sample / on): new 'pending' rows; a 'restricted' skip
 *      whose item was unrestricted becomes pending again.
 *   3. SUBMIT due 'pending' rows (mode sample / on), newest first:
 *        a. Restrict → skipped / restricted (a call someone marked private
 *           never leaves our storage — R5's escape hatch; re-eligible when
 *           unrestricted). A row restricted while in flight is stored (hidden
 *           by the JOIN) and its vendor copy deleted as usual.
 *        b. comms_no_transcribe (last 10 digits of comms_media.party) →
 *           skipped / no_transcribe;
 *        c. the audio length is ESTIMATED from the archived file's header
 *           (commsTranscribeAudio — the call clock includes ringing) and
 *           audio_channels filled;
 *        d. mode on, a call recording < comms_min_transcribe_s → skipped /
 *           short (never a voicemail: a short voicemail is still a message);
 *        e. > comms_stt_max_min_per_call → skipped / over_cap, unless an SU
 *           released it (cap_released_by — releaseCap / the §6.5 console line);
 *        f. the MONTHLY CAP: ledger month-to-date + this row's estimate >
 *           comms_ai_monthly_cap_cents → stop submitting. Unset / garbage = 0.
 *        g. the SIGNING PROOF, once per tick before the first submit: sign
 *           the S0 probe (_s0/probe.txt, not client data), GET it — 200 with
 *           its exact bytes — and GET a copy with one signature character
 *           flipped — refused. Until that passes, no client audio leaves.
 *        h. the BREAKER: the last breakerPosts POSTs all uncertain (drift / no
 *           answer / 502-504) and the newest within breakerPauseHours →
 *           no submissions (error alert). Each such POST may be a real,
 *           billed job; the monthly cap would be the only other bound.
 *        i. a 1-hour V4 signed URL (one per POST) → ledger row written ahead
 *           → POST /v2/transcript → 'transcribing' straight after the MAIN
 *           answer → the sample variant's POST. A POST that comes back
 *           unreadable or without an answer (incl. 502/503/504) STOPS every
 *           vendor call for the tick; a 4xx other than 401/403/429 is a
 *           configuration problem — alerted, tick stopped, nothing charged.
 *
 * ── STORE (a completed job) ────────────────────────────────────────────────
 *   The ledger records the billed cost first (whatever happens next). The
 *   vendor JSON (audio_url cut to origin + path) → phone/stt/<yyyy>/<mm>/
 *   <media id>.<part>.json, never overwriting (a leftover from a crashed tick
 *   is adopted only if its bytes are identical; otherwise anomaly) → an
 *   archived stt_raw comms_media row, restricted copied from the parent IN THE
 *   SAME STATEMENT → the transcript row → comms_media.duration_s = the
 *   vendor's audio_duration (an estimate off by > 20% and > 3 s raises the
 *   duration-drift warning). The vendor copies are then owed deletes (step
 *   1b, the same tick). A storage failure here refunds, alerts and ends the tick.
 *
 * ── PURGE IS A FENCE, NOT A LOCK (design §8) ──────────────────────────────
 * Purge holds the ARCHIVE sweep's lane lock, not this one. Its FIRST step
 * (purgeTranscript, PURGE_PARTS 'transcripts') sets the transcript row
 * 'purged' and clears its text, then deletes EVERY object under the item's
 * stt prefix (by listing — a crash-orphan has no row to find it by) and tries
 * the owed vendor deletes. Every write here is conditional on the row still
 * being 'transcribing' with the job we polled — the stt_raw INSERT is an
 * INSERT…SELECT joined to it, so InnoDB serialises it against the purge's
 * UPDATE. A write that loses deletes the object it just stored (a failed
 * delete there is an anomaly alert); a child inserted before the fence is
 * removed by the purge's next step (derived_children).
 *
 * ── RESTRICTED TEXT IS HIDDEN BY JOIN ──────────────────────────────────────
 * comms_transcripts carries no visibility of its own: every reader JOINs
 * comms_media (restricted, channel_id). The stt_raw child copies `restricted`
 * at insert and setRestricted's cascade keeps it in step. The read-only SQL
 * endpoint may not read comms_transcripts at all (lib/sqlGuard).
 *
 * Every vendor error text is passed through redactUrls before it is stored or
 * alerted: a signature never leaves in a message.
 */

'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const archive = require('./commsArchiveService');
const common = require('./commsArchiveCommon');
const audio = require('./commsTranscribeAudio');

const LOCK_EXPR = "CONCAT('comms_archive_transcribe:', DATABASE())";
const KEYS = Object.freeze({
  mode: 'comms_transcribe_mode',
  cred: 'comms_stt_credential_id',
  minS: 'comms_min_transcribe_s',
  maxMin: 'comms_stt_max_min_per_call',
  cap: 'comms_ai_monthly_cap_cents',
  stereo: 'comms_stt_quo_stereo',
  keyterms: 'comms_stt_keyterms',
  lang: 'comms_stt_language_detection',
});
const MODES = new Set(['off', 'sample', 'on']);
const KINDS = ['call_recording', 'voicemail'];
const JOB_FAILED = ['error', 'lost', 'drift', 'unknown'];

/** S0's permanent probe (scripts/commsArchive/s0_infra.sh PROBE / PROBE_TEXT) — not client data. */
const PROBE_OBJECT = '_s0/probe.txt';
const PROBE_TEXT = 'YisraCase comms archive S0 probe object. Not client data. Kept on purpose: the post-S1a signing check reads it, and delete detection skips the _s0/ prefix. See ref/INFRA_GCP.md.';

/** Knobs, read at call time (tests shrink them). */
const limits = {
  deadlineMs: 45_000,
  vendorTimeoutMs: 30_000,
  gcsTimeoutMs: 60_000,
  probeTimeoutMs: 10_000,
  submitPerTick: 10,
  pollPerTick: 40,
  deletePerTick: 20,
  orphanPerTick: 3,
  orphanPages: 3,
  orphanSearchHours: 24,
  orphanRecheckMin: 30,
  discoverLimit: 200,
  signTtlMs: 60 * 60 * 1000,
  pollCapMin: 15,
  leaseMin: 10,
  maxAttempts: 3,
  backoffCapMin: 60,
  stuckBackoffMin: 360,
  repeatWindowHours: 24,
  noCliffDays: 30,
  driftBackoffMin: 120,
  deleteAlertAfter: 5,
  breakerPosts: 3,             // this many uncertain POSTs in a row (drift / no answer) …
  breakerPauseHours: 6,        // … pause new submissions this long
  durationDriftPct: 0.2,
  durationDriftMinS: 3,
  backlogAlertHours: 48,
  capErrorAfterHours: 24,
};

const { clamp, utcDate, alert } = common;
const ops = common.rowOps(limits, { table: 'comms_transcripts', claimStates: ['pending', 'transcribing'] });

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const round4 = (n) => Math.round(Number(n) * 10_000) / 10_000;

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

/** Settings → cfg. `problems` stop the tick (alerted); `notes` alert but the tick goes on. */
async function readConfig(db) {
  const { getSettings } = require('./settingsService'); // lazy require (convention)
  const raw = await getSettings(db, Object.values(KEYS));
  const problems = [], notes = [];
  const int = (key, { min = 0 } = {}) => {
    const v = raw[key];
    if (v == null || !/^\s*\d+\s*$/.test(String(v)) || Number(v) < min) return null;
    return Number(v);
  };

  const m = String(raw[KEYS.mode] == null ? '' : raw[KEYS.mode]).trim().toLowerCase();
  const mode = MODES.has(m) ? m : 'off';
  if (!MODES.has(m) && m !== '') notes.push(`${KEYS.mode} = ${JSON.stringify(clamp(raw[KEYS.mode], 40))} is not off | sample | on — treated as off`);

  const credId = int(KEYS.cred, { min: 1 });
  if (credId == null) problems.push(`${KEYS.cred} is missing or not a credential id`);
  const minS = int(KEYS.minS);
  if (minS == null) problems.push(`${KEYS.minS} is missing or not a number`);
  const maxMin = int(KEYS.maxMin, { min: 1 });
  if (maxMin == null) problems.push(`${KEYS.maxMin} is missing or not a positive number`);
  let capCents = int(KEYS.cap);
  if (capCents == null) { capCents = 0; if (mode !== 'off') notes.push(`${KEYS.cap} is missing or not a number — treated as 0: nothing is submitted`); }

  const stereo = raw[KEYS.stereo] === 'multichannel' ? 'multichannel' : 'diarize';
  let keyterms = [];
  if (raw[KEYS.keyterms] != null && String(raw[KEYS.keyterms]).trim() !== '') {
    let k;
    try { k = JSON.parse(raw[KEYS.keyterms]); } catch (_) { k = null; }
    if (Array.isArray(k) && k.length <= 1000 && k.every(x => typeof x === 'string' && x.trim() && x.trim().split(/\s+/).length <= 6)) {
      keyterms = k.map(x => x.trim());
    } else {
      notes.push(`${KEYS.keyterms} is not a JSON array of ≤ 1000 phrases of ≤ 6 words — sent without keyterms`);
    }
  }
  const languageDetection = raw[KEYS.lang] === '1';
  return { mode, credId, minS, maxMin, capCents, stereo, keyterms, languageDetection, problems, notes };
}

// ─────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────

async function _dailyAlert(db, groupKey, severity, title, message, context) {
  return alert(db, {
    kind: groupKey, group_key: groupKey, severity, title, message, context,
    dedup_key: `${groupKey}:${severity}:${utcDate()}`,
  });
}

async function _noAuthAlert(db, credId, detail) {
  return ops.escalatingAlert(db, `comms_transcribe_no_auth:${credId}`, 'comms_transcribe_no_auth',
    'Comms transcription: the STT credential was refused',
    `AssemblyAI credential ${credId}: ${detail.endpoint} — ${detail.status == null ? 'no Authorization header (credential missing, disconnected, or the URL outside its allowed_urls)' : `HTTP ${detail.status}: ${clamp(detail.errorText || '', 300)}`}. ` +
    'Nothing was charged; transcription waits until it is fixed.',
    { credential_id: credId, ...detail });
}

async function _storageAlert(db, what) {
  return ops.escalatingAlert(db, 'comms_transcribe_storage', 'comms_transcribe_storage',
    'Comms transcription: archive storage / signing unavailable',
    `${clamp(what, 600)}\n\nNothing was charged; the tick stopped.`,
    { error: clamp(what, 300) });
}

/** The monthly cap: warning the first day it is hit, ERROR once it has held for capErrorAfterHours. */
async function capAlert(db, out) {
  let severity = 'warning';
  try {
    const [[r]] = await db.query(
      `SELECT 1 AS hit FROM system_alerts WHERE group_key = 'comms_transcribe_cap'
          AND created_at <= UTC_TIMESTAMP() - INTERVAL ? HOUR
          AND created_at > UTC_TIMESTAMP() - INTERVAL ? HOUR LIMIT 1`,
      [limits.capErrorAfterHours, limits.capErrorAfterHours * 2]);
    if (r) severity = 'error';
  } catch (_) { severity = 'error'; }
  return _dailyAlert(db, 'comms_transcribe_cap', severity,
    'Comms archive: the monthly AI cap is reached',
    `Month-to-date ${out.cap.mtd_cents.toFixed(2)}¢ of ${out.cap.cap_cents}¢ (${KEYS.cap}) — transcription and summaries together, every job and call this month counted. ` +
    'New transcriptions and summaries wait; jobs in flight finish; archiving never stops. Raise the cap from the SU db console, or wait for the month to turn.',
    out.cap);
}

async function _flushAlerts(db, acc) {
  try {
    if (acc.drift.length) {
      await _dailyAlert(db, 'comms_transcribe_drift', 'error',
        'Comms transcription: a response or file did not match its expected shape',
        `${acc.drift.length} item(s) parked, never treated as done:\n` +
        acc.drift.slice(0, 10).map(d => `  comms_transcripts ${d.id}: ${d.what}`).join('\n'),
        { items: acc.drift.slice(0, 20) });
    }
    if (acc.failed.length) {
      await ops.escalatingAlert(db, 'comms_transcribe_failed', 'comms_transcribe_failed',
        'Comms transcription: transcripts failed',
        `${acc.failed.length} item(s) are now failed:\n` +
        acc.failed.slice(0, 10).map(d => `  comms_transcripts ${d.id}: ${clamp(d.why, 200)}`).join('\n'),
        { items: acc.failed.slice(0, 20) });
    }
    if (acc.durationDrift.length) {
      await _dailyAlert(db, 'comms_transcribe_duration_drift', 'warning',
        'Comms transcription: the audio-length estimate disagrees with the vendor',
        `${acc.durationDrift.length} file(s) where the header estimate and AssemblyAI's audio_duration differ by > ${limits.durationDriftPct * 100}% and > ${limits.durationDriftMinS} s — ` +
        'the short / cap gates may be misjudging. Check the provider\'s recording format (design §2):\n' +
        acc.durationDrift.slice(0, 10).map(d => `  comms_media ${d.media_id}: estimated ${d.est} s, measured ${d.actual} s`).join('\n'),
        { items: acc.durationDrift.slice(0, 20) });
    }
    if (acc.unknownJobs.length) {
      await _dailyAlert(db, 'comms_transcribe_orphan', 'warning',
        'Comms transcription: a vendor job may exist that we never got an id for',
        `${acc.unknownJobs.length} submission(s) got no usable answer (timeout / network / unreadable). If the vendor accepted them, ` +
        `the sweep looks for them in the vendor's list (by a hash of the URL) for ${limits.orphanSearchHours} h and deletes what it finds:\n` +
        acc.unknownJobs.slice(0, 10).map(d => `  comms_stt_jobs ${d.job}: ${clamp(d.why, 160)}`).join('\n'),
        { items: acc.unknownJobs.slice(0, 20) });
    }
    if (acc.orphansLost.length) {
      await _dailyAlert(db, 'comms_transcribe_orphan', 'warning',
        'Comms transcription: a possible vendor job was never found',
        `${acc.orphansLost.length} timed-out submission(s) were not found in the vendor's list within ${limits.orphanSearchHours} h. ` +
        'If the vendor did create them, its 30-day data TTL deletes them (no delete is possible without an id):\n' +
        acc.orphansLost.slice(0, 10).map(d => `  comms_stt_jobs ${d.job} (comms_media ${d.media_id})`).join('\n'),
        { items: acc.orphansLost.slice(0, 20) });
    }
    if (acc.deleteStuck.length) {
      await ops.escalatingAlert(db, 'comms_transcribe_delete_owed', 'comms_transcribe_delete_owed',
        'Comms transcription: vendor copies could not be deleted',
        `${acc.deleteStuck.length} vendor job(s) still not deleted after ${limits.deleteAlertAfter}+ tries (retried with backoff; the vendor's 30-day TTL backstops):\n` +
        acc.deleteStuck.slice(0, 10).map(d => `  comms_stt_jobs ${d.job}: ${clamp(d.why, 160)}`).join('\n'),
        { items: acc.deleteStuck.slice(0, 20) });
    }
    for (const a of acc.anomalies.slice(0, 5)) {
      await alert(db, {
        kind: 'comms_transcribe_anomaly', group_key: 'comms_transcribe_anomaly', severity: 'error',
        title: 'Comms transcription: a stored transcript needs a human',
        message: `comms_transcripts ${a.id}: ${a.what}`,
        ref_table: 'comms_transcripts', ref_id: a.id, dedup_key: `comms_transcribe_anomaly:${a.id}:${clamp(a.key || 'x', 40)}`,
      });
    }
  } catch (err) {
    console.error('[COMMS TRANSCRIBE] alert flush failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Signing proof
// ─────────────────────────────────────────────────────────────

/** Default HTTP GET for the probe: no redirects, bounded, never logs the URL's query. */
async function _httpGet(url, timeoutMs) {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  let text = '';
  try { text = await res.text(); } catch (_) { /* body gone */ }
  return { status: res.status, text };
}

function _tamper(url) {
  const u = new URL(url);
  const sig = u.searchParams.get('X-Goog-Signature');
  if (!sig) return null;
  const last = sig.slice(-1);
  u.searchParams.set('X-Goog-Signature', sig.slice(0, -1) + (last === '0' ? '1' : '0'));
  return u.toString();
}

/**
 * Prove V4 signing works BEFORE any client audio leaves: our signed URL for
 * the S0 probe must serve its exact bytes, and the same URL with one
 * signature character flipped must be refused. Throws ourSide on any miss.
 */
async function proveSigning(http = _httpGet) {
  const fail = (what) => Object.assign(new Error(`signing proof: ${what}`), { ourSide: true, code: 'SIGNING' });
  const url = await archive.signedUrl(PROBE_OBJECT, { mime: 'text/plain', ttlMs: 60_000 });
  let good;
  try { good = await http(url, limits.probeTimeoutMs); } catch (err) { throw fail(`probe GET failed: ${clamp(err.message, 120)}`); }
  if (good.status !== 200 || good.text !== PROBE_TEXT) throw fail(`probe answered HTTP ${good.status}${good.status === 200 ? ' with the wrong bytes' : ''}`);
  const bad = _tamper(url);
  if (!bad) throw fail('the signed URL carries no X-Goog-Signature to test');
  let r;
  try { r = await http(bad, limits.probeTimeoutMs); } catch (err) { throw fail(`tampered GET failed: ${clamp(err.message, 120)}`); }
  if (r.status === 200) throw fail('a TAMPERED signed URL was served — signatures are not being checked');
  if (![400, 401, 403].includes(r.status)) throw fail(`tampered URL answered HTTP ${r.status} (expected 400/403)`);
}

// ─────────────────────────────────────────────────────────────
// The job ledger
// ─────────────────────────────────────────────────────────────

async function _ledgerAdd(db, { transcriptId, mediaId, role, variant, jobRef = null, state, urlSha = null, estCents, lastError = null }) {
  let id;
  try {
    const [r] = await db.query(
      `INSERT INTO comms_stt_jobs (transcript_id, media_id, role, variant, job_ref, state, url_sha256, est_cents, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [transcriptId, mediaId, role, variant, jobRef, state, urlSha, round4(estCents), clamp(lastError, 500)]);
    id = r.insertId;
  } catch (err) {
    // The vendor named a job the ledger already holds: it is counted and owed once, not twice.
    if (err.code !== 'ER_DUP_ENTRY' || jobRef == null) throw err;
    const [[e]] = await db.query("SELECT id FROM comms_stt_jobs WHERE vendor = 'assemblyai' AND job_ref = ?", [jobRef]);
    id = e && e.id;
  }
  await _syncCost(db, transcriptId);
  return id;
}

/**
 * Resolve a written-ahead ledger row from its POST's answer. A job id the
 * ledger already holds (the unique key) is never a second job: the row is
 * resolved without it and the clash returned for the caller to alert.
 */
async function _ledgerResolve(db, ledgerId, transcriptId, { jobRef = null, state, postStatus, keepSha = false, estZero = false, lastError = null }) {
  const set = `state = ?, post_status = ?, last_error = ?${keepSha ? '' : ', url_sha256 = NULL'}${estZero ? ', est_cents = 0, finished_at = UTC_TIMESTAMP()' : ''}`;
  let clash = null;
  try {
    await db.query(`UPDATE comms_stt_jobs SET job_ref = ?, ${set} WHERE id = ?`,
      [jobRef, state, postStatus, clamp(lastError, 500), ledgerId]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY' || jobRef == null) throw err;
    const [[e]] = await db.query("SELECT id FROM comms_stt_jobs WHERE vendor = 'assemblyai' AND job_ref = ?", [jobRef]);
    clash = e ? e.id : null;
    await db.query(`UPDATE comms_stt_jobs SET ${set} WHERE id = ?`,
      [state === 'submitted' ? 'drift' : state, postStatus, clamp(`the vendor answered job id ${jobRef}, already ledger job ${clash}`, 500), ledgerId]);
  }
  await _syncCost(db, transcriptId);
  return { clash };
}

/**
 * The circuit breaker: are the last `breakerPosts` POST answers all
 * uncertain (no answer, 502/503/504, or a 2xx we could not use) with the
 * newest inside the pause window? → the newest one's time, else null.
 */
async function _breakerOpen(db) {
  const [rows] = await db.query(
    `SELECT post_status, state, submitted_at FROM comms_stt_jobs
      WHERE post_status IS NOT NULL ORDER BY id DESC LIMIT ?`, [limits.breakerPosts]);
  if (rows.length < limits.breakerPosts) return null;
  const uncertain = (r) => [0, 502, 503, 504].includes(Number(r.post_status)) ||
    (Number(r.post_status) >= 200 && Number(r.post_status) < 300 && ['drift', 'unknown'].includes(r.state));
  if (!rows.every(uncertain)) return null;
  const newest = new Date(rows[0].submitted_at);
  return Date.now() - newest.getTime() < limits.breakerPauseHours * 3_600_000 ? newest : null;
}

/** A submitted job's end. Cost only when known (completed). Idempotent: only a 'submitted' job moves. */
async function _ledgerFinish(db, transcriptId, jobRef, state, { costCents = null, lastError = null } = {}) {
  await db.query(
    `UPDATE comms_stt_jobs SET state = ?, cost_cents = COALESCE(?, cost_cents), finished_at = UTC_TIMESTAMP(),
            last_error = COALESCE(?, last_error)
      WHERE vendor = 'assemblyai' AND job_ref = ? AND state = 'submitted'`,
    [state, costCents == null ? null : round4(costCents), clamp(lastError, 500), jobRef]);
  await _syncCost(db, transcriptId);
}

/** comms_transcripts.stt_cost_cents = the sum of every ledger job of the row (S4's health read sums it). */
async function _syncCost(db, transcriptId) {
  await db.query(
    `UPDATE comms_transcripts t
        SET t.stt_cost_cents = (SELECT ROUND(SUM(COALESCE(j.cost_cents, j.est_cents)), 4)
                                  FROM comms_stt_jobs j WHERE j.transcript_id = t.id)
      WHERE t.id = ?`, [transcriptId]);
}

/** MAIN-role jobs of a row that ended without a transcript — the job-failure count (separate from transport `attempts`). */
async function _mainFailures(db, transcriptId) {
  const [[r]] = await db.query(
    `SELECT COUNT(*) AS n FROM comms_stt_jobs WHERE transcript_id = ? AND role = 'main' AND state IN (?)`,
    [transcriptId, JOB_FAILED]);
  return Number(r.n) || 0;
}

/**
 * Month-to-date AI spend in cents for the comms archive — THE one place the
 * shared monthly cap (comms_ai_monthly_cap_cents) is summed:
 *   STT        every vendor job submitted this UTC month (comms_stt_jobs) —
 *              billed cost when completed, the estimate otherwise — whatever
 *              its transcript row did since;
 *   summaries  (S3) every ai_calls attempt of a transcript this UTC month
 *              (consumer_ref 'comms_transcript:<id>' — stricter retries
 *              included), plus the estimate of every call in flight
 *              (comms_summaries state 'calling', written ahead of the call).
 * A table a database has not reached yet (S3's queue) counts as 0.
 */
async function monthToDateCents(db) {
  const p = await monthToDateParts(db);
  return p.stt + (p.llm || 0);
}

/**
 * The same sum, by stage — S4's health read shows both. llm = the summaries'
 * ai_calls + the estimates of calls in flight; null on a database without
 * ai_calls (a missing table holds no calls).
 */
async function monthToDateParts(db) {
  const [[r]] = await db.query(
    `SELECT COALESCE(SUM(COALESCE(cost_cents, est_cents)), 0) AS c FROM comms_stt_jobs
      WHERE submitted_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`);
  const stt = Number(r.c) || 0;
  let llm = null;
  try {
    const [[a]] = await db.query(
      `SELECT COALESCE(SUM(cost_cents), 0) AS c FROM ai_calls
        WHERE consumer_ref LIKE 'comms\\_transcript:%' AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`);
    llm = Number(a.c) || 0;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  try {
    const [[f]] = await db.query("SELECT COALESCE(SUM(est_cents), 0) AS c FROM comms_summaries WHERE state = 'calling'");
    const inFlight = Number(f.c) || 0;
    if (inFlight) llm = (llm || 0) + inFlight;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return { stt, llm: llm == null ? null : Math.round(llm * 10_000) / 10_000 };
}

// ─────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────

const ROW_COLS = `t.id, t.media_id, t.state, t.attempts, t.stt_job_ref, t.alt_job_ref, t.stt_model, t.est_audio_s,
       t.submitted_at, t.created_at, t.cap_released_by, t.last_error,
       m.state AS m_state, m.kind, m.provider, m.object_name, m.mime, m.bytes, m.captured_at, m.party,
       m.audio_channels, m.restricted`;

async function _nextDue(db, state, { sample = false, seen = [] } = {}) {
  const params = [state];
  let extra = '';
  if (sample) extra += ' AND EXISTS (SELECT 1 FROM comms_eval_items e WHERE e.media_id = t.media_id)';
  if (seen.length) { extra += ' AND t.id NOT IN (?)'; params.push(seen); }
  const order = state === 'pending' ? 'm.captured_at DESC, t.id DESC' : 't.next_attempt_at ASC, t.id ASC';
  const [[row]] = await db.query(
    `SELECT ${ROW_COLS}
       FROM comms_transcripts t JOIN comms_media m ON m.id = t.media_id
      WHERE t.state = ? AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= UTC_TIMESTAMP())${extra}
      ORDER BY ${order} LIMIT 1`, params);
  return row || null;
}

/** A transcript row as rowOps.terminalReason must see it: NO provider/kind (those mean the archive's cliff). */
const _opsRow = (row) => ({ id: row.id, created_at: row.created_at });

async function _schedulePoll(db, row) {
  const since = row.submitted_at ? (Date.now() - new Date(row.submitted_at).getTime()) / 60_000 : 0;
  const mins = Math.max(1, Math.min(limits.pollCapMin, Math.floor(since / 2)));
  await db.query(
    `UPDATE comms_transcripts SET attempts = GREATEST(attempts, 1) - 1,
            next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE
      WHERE id = ? AND state = 'transcribing'`, [mins, row.id]);
}

async function _skip(db, row, reason, estS) {
  await db.query(
    `UPDATE comms_transcripts SET state = 'skipped', skip_reason = ?, est_audio_s = COALESCE(?, est_audio_s),
            attempts = GREATEST(attempts, 1) - 1, next_attempt_at = NULL
      WHERE id = ? AND state = 'pending'`, [reason, estS, row.id]);
}

/** The archive item was purged (or is not archived) under a row we hold: fence it. */
async function _parentGone(db, row, out) {
  if (row.m_state === 'purged') {
    await db.query(
      `UPDATE comms_transcripts SET state = 'purged', segments = NULL, full_text = NULL, summary = NULL,
              summary_text = NULL, next_attempt_at = NULL
        WHERE id = ? AND state IN ('pending', 'transcribing')`, [row.id]);
    out.fenced++;
    return;
  }
  await ops.park(db, row.id, limits.stuckBackoffMin, `archive item ${row.media_id} is ${row.m_state}, not archived`);
}

async function _onNoTranscribe(db, party) {
  if (party == null || String(party).trim() === '') return false;
  const [[r]] = await db.query(
    `SELECT 1 AS hit FROM comms_no_transcribe
      WHERE phone = RIGHT(REGEXP_REPLACE(?, '[^0-9]', ''), 10) LIMIT 1`, [String(party)]);
  return !!r;
}

/**
 * A MAIN job ended without a transcript (error / lost / drift / unknown —
 * already in the ledger). maxAttempts such jobs → `failed` (alerted);
 * otherwise back to pending (a fresh signed URL next time), backed off.
 */
async function _mainFailed(ctx, row, why) {
  const { db, out, acc } = ctx;
  const n = await _mainFailures(db, row.id);
  const text = clamp(why, 900);
  if (n >= limits.maxAttempts) {
    const [u] = await db.query(
      `UPDATE comms_transcripts SET state = 'failed', next_attempt_at = NULL, last_error = ?
        WHERE id = ? AND state IN ('pending', 'transcribing')`, [`${text} (${n} jobs failed)`, row.id]);
    if (u.affectedRows) { out.failed++; acc.failed.push({ id: row.id, why: text }); }
    return;
  }
  await db.query(
    `UPDATE comms_transcripts SET state = 'pending', stt_job_ref = NULL, alt_job_ref = NULL, submitted_at = NULL,
            next_attempt_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE, last_error = ?
      WHERE id = ? AND state IN ('pending', 'transcribing')`,
    [Math.min(2 ** n, limits.backoffCapMin), text, row.id]);
  out.retried++;
}

const _other = (v) => (v === 'diarize' ? 'multichannel' : 'diarize');
const _variantOf = (model) => (/\+multichannel$/.test(String(model || '')) ? 'multichannel' : 'diarize');

// ─────────────────────────────────────────────────────────────
// Vendor responses
// ─────────────────────────────────────────────────────────────

/**
 * A non-2xx (or unparseable 2xx) answer to a GET for a row we hold (polling —
 * no money moves on a GET). Returns true when it handled the row.
 */
async function _getStatus(ctx, row, r, attemptsNow, endpoint) {
  const { db, out } = ctx;
  if (r.status >= 200 && r.status < 300 && r.json && typeof r.json === 'object') return false;
  if (r.status === 401 || r.status === 403) {
    await ops.refund(db, row.id, `assemblyai ${r.status}`);
    await _noAuthAlert(db, ctx.cfg.credId, { endpoint, status: r.status, errorText: r.errorText });
    out.auth_error = { endpoint, status: r.status, errorText: clamp(r.errorText || '', 300) };
    ctx.stopVendor('no_auth');
    return true;
  }
  if (r.status === 429) {
    await ops.refund(db, row.id, 'assemblyai 429');
    out.retry_after_s = r.retryAfterS;
    ctx.stopVendor('rate_limited');
    return true;
  }
  if (r.status >= 200 && r.status < 300) {
    await ops.park(db, row.id, limits.driftBackoffMin, `shape drift: ${endpoint} answered an unparseable ${r.status}`);
    ctx.acc.drift.push({ id: row.id, what: `${endpoint}: unparseable ${r.status}` });
    out.drift++;
    return true;
  }
  const res = await ops.transient(db, _opsRow(row), attemptsNow, `${endpoint} ${r.status || 'network'}: ${clamp(r.errorText || '', 300)}`);
  if (res === 'failed') { out.failed++; ctx.acc.failed.push({ id: row.id, why: `${endpoint} ${r.status}` }); }
  else out.retried++;
  return true;
}

const _okJob = (j) => j && typeof j.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(j.id) && (j.status === 'queued' || j.status === 'processing');
const NO_ANSWER = new Set([0, 502, 503, 504]);   // the vendor may have accepted it

/**
 * One POST /v2/transcript, its ledger row WRITTEN AHEAD. A fresh signed URL
 * per POST (so each job's url_sha256 is its own). → the outcome of
 * _postOutcome, or { storage: err } when signing failed (nothing was sent).
 */
async function _postJob(ctx, row, { role, variant, estCents }) {
  const { db, cfg, vendor } = ctx;
  let url;
  // V4 signatures carry a second-resolution date, so two signings in one second can be byte-identical:
  // the variant's TTL is 1 s shorter, which makes its URL (and url_sha256) its own.
  try { url = await archive.signedUrl(row.object_name, { mime: row.mime, ttlMs: limits.signTtlMs - (role === 'alt' ? 1000 : 0) }); }
  catch (err) { if (!err.ourSide) throw err; return { storage: err }; }
  const urlSha = sha256(url);
  const ledgerId = await _ledgerAdd(db, {
    transcriptId: row.id, mediaId: row.media_id, role, variant, state: 'unknown', urlSha, estCents,
    lastError: 'written ahead of the POST — no answer recorded',
  });
  const r = await vendor.submit(db, {
    credId: cfg.credId, audioUrl: url, keyterms: cfg.keyterms, languageDetection: cfg.languageDetection,
    timeoutMs: limits.vendorTimeoutMs, variant,
  });
  return _postOutcome(ctx, row, r, { role, variant, ledgerId });
}

/**
 * Resolve a POST's written-ahead ledger row from its answer and act on it.
 * → { jobRef } accepted | { stop: true } the tick's vendor work ends |
 *   { handled: true } this row is dealt with, go on.
 * `role` 'main' moves the transcript row; 'alt' (the sample variant) never does.
 */
async function _postOutcome(ctx, row, r, { role, variant, ledgerId }) {
  const { db, out, acc } = ctx;
  const isMain = role === 'main';
  const v = ctx.vendor;
  const status = Number(r.status) || 0;

  if (status >= 200 && status < 300 && _okJob(r.json)) {
    const { clash } = await _ledgerResolve(db, ledgerId, row.id, { jobRef: r.json.id, state: 'submitted', postStatus: status });
    if (!clash) return { jobRef: r.json.id };
    acc.anomalies.push({ id: row.id, key: `clash${ledgerId}`, what: `the vendor answered job id ${r.json.id}, which ledger job ${clash} already holds` });
    ctx.stopVendor('post_drift');
    if (isMain) await _mainFailed(ctx, row, `POST answered an id already in the ledger (${clamp(r.json.id, 64)})`);
    return { stop: true };
  }
  const is2xx = status >= 200 && status < 300;
  if (is2xx || NO_ANSWER.has(status)) {
    // The vendor may hold a job we cannot use. Keep the money, owe the delete (or search), stop feeding it.
    const idStr = is2xx && r.json && typeof r.json.id === 'string' ? r.json.id : null;
    const why = is2xx
      ? `shape drift: POST /v2/transcript answered ${r.json === undefined ? 'an unparseable' : 'an unexpected'} ${status}` +
        (r.json && r.json.status ? ` (status ${clamp(String(r.json.status), 20)})` : '')
      : `POST /v2/transcript got ${status ? `HTTP ${status}` : 'no answer'} (${clamp(r.errorText || 'network', 120)}) — the vendor may have accepted it`;
    if (idStr) {
      await _ledgerResolve(db, ledgerId, row.id, { jobRef: clamp(idStr, 191), state: 'drift', postStatus: status, lastError: why });
      if (!v.validJobId(idStr)) acc.anomalies.push({ id: row.id, key: 'badid', what: `the vendor returned a job id that cannot be deleted safely: ${JSON.stringify(clamp(idStr, 80))}` });
      acc.drift.push({ id: row.id, what: why });
      out.drift++;
    } else {
      await _ledgerResolve(db, ledgerId, row.id, { state: 'unknown', postStatus: status, keepSha: true, lastError: why });
      acc.unknownJobs.push({ job: ledgerId, why });
    }
    ctx.stopVendor(is2xx ? 'post_drift' : 'post_timeout');
    if (isMain) await _mainFailed(ctx, row, why);
    return { stop: true };
  }

  // A definite refusal: the vendor took nothing — the written-ahead row costs 0.
  await _ledgerResolve(db, ledgerId, row.id, { state: 'refused', postStatus: status, estZero: true, lastError: `HTTP ${status}: ${clamp(r.errorText || '', 300)}` });
  if (status === 401 || status === 403) {
    if (isMain) await ops.refund(db, row.id, `assemblyai ${status}`);
    await _noAuthAlert(db, ctx.cfg.credId, { endpoint: 'POST /v2/transcript', status, errorText: r.errorText });
    out.auth_error = { endpoint: 'POST /v2/transcript', status, errorText: clamp(r.errorText || '', 300) };
    ctx.stopVendor('no_auth');
    return { stop: true };
  }
  if (status === 429) {
    if (isMain) await ops.refund(db, row.id, 'assemblyai 429');
    out.retry_after_s = r.retryAfterS;
    ctx.stopVendor('rate_limited');
    return { stop: true };
  }
  if (status >= 400 && status < 500) {
    // A request the vendor refuses is OUR configuration (a model name, a parameter): every row would fail the same.
    if (isMain) await ops.refund(db, row.id, `assemblyai ${status} (configuration)`);
    await _dailyAlert(db, 'comms_transcribe_config', 'error',
      'Comms transcription: AssemblyAI refused the request',
      `POST /v2/transcript (${variant}) answered HTTP ${status}: ${clamp(r.errorText || '', 400)}\n\n` +
      'Every submission would be refused the same way, so the tick stopped; nothing was charged. Check the settings / the request shape.',
      { status, variant, errorText: clamp(r.errorText || '', 300) });
    ctx.stopVendor('vendor_refused');
    return { stop: true };
  }
  // 500 / other 5xx: the vendor did not take it (a transport failure — backed off on `attempts`).
  if (isMain) {
    const res = await ops.transient(db, _opsRow(row), row.attempts + 1, `POST /v2/transcript ${status}: ${clamp(r.errorText || '', 300)}`);
    if (res === 'failed') { out.failed++; acc.failed.push({ id: row.id, why: `POST ${status}` }); }
    else out.retried++;
  }
  return { handled: true };
}

// ─────────────────────────────────────────────────────────────
// Store a completed job
// ─────────────────────────────────────────────────────────────

/**
 * Store one variant's vendor JSON + its stt_raw child, fenced on the row's
 * job. → 'ok' | 'fenced' | 'anomaly'. Throws ourSide on storage failure.
 */
async function _storeRaw(ctx, row, json, part) {
  const { db } = ctx;
  const body = Buffer.from(JSON.stringify(ctx.vendor.stripSignedUrl(json)));
  const objectName = archive.sttPrefix({ capturedAt: row.captured_at, parentId: row.media_id }) + `${part}.json`;
  let put;
  try {
    put = await archive.putStream(Readable.from([body]), {
      objectName, mime: 'application/json', expectedBytes: body.length, timeoutMs: limits.gcsTimeoutMs,
    });
  } catch (err) {
    if (err.code !== 'EXISTS') throw err;
    const ex = await archive.rehash(objectName, { timeoutMs: limits.gcsTimeoutMs });
    if (ex.sha256 !== sha256(body)) {
      // A different transcript already sits under this name — never overwritten. Unless purge has fenced the row, a human looks.
      const [[t]] = await db.query('SELECT state FROM comms_transcripts WHERE id = ?', [row.id]);
      if (t && t.state === 'purged') return 'fenced';
      await ops.park(db, row.id, limits.stuckBackoffMin, `anomaly: ${objectName} exists with different bytes`);
      ctx.acc.anomalies.push({ id: row.id, key: part, what: `${objectName} already exists with different bytes — left parked (6 h, uncharged)` });
      return 'anomaly';
    }
    put = ex;
  }
  const [ins] = await db.query(
    `INSERT IGNORE INTO comms_media
       (channel, kind, source_table, source_id, part, provider, channel_id, party, captured_at, restricted,
        state, object_name, mime, bytes, sha256, archived_at)
     SELECT m.channel, 'stt_raw', 'comms_media', m.id, ?, m.provider, m.channel_id, m.party, m.captured_at, m.restricted,
            'archived', ?, 'application/json', ?, ?, UTC_TIMESTAMP()
       FROM comms_media m JOIN comms_transcripts t ON t.media_id = m.id
      WHERE m.id = ? AND m.state <> 'purged' AND t.id = ? AND t.state = 'transcribing' AND t.stt_job_ref = ?`,
    [part, objectName, put.bytes, put.sha256, row.media_id, row.id, row.stt_job_ref]);
  if (ins.affectedRows === 1) return 'ok';

  const [[t]] = await db.query('SELECT state, stt_job_ref FROM comms_transcripts WHERE id = ?', [row.id]);
  const [[m]] = await db.query('SELECT state FROM comms_media WHERE id = ?', [row.media_id]);
  if (t && t.state === 'transcribing' && t.stt_job_ref === row.stt_job_ref && m && m.state !== 'purged') {
    // The child exists already (a crashed tick inserted it): it must be these bytes.
    const [[c]] = await db.query(
      `SELECT id, sha256, state FROM comms_media
        WHERE source_table = 'comms_media' AND source_id = ? AND kind = 'stt_raw' AND part = ?`, [row.media_id, part]);
    if (c && c.state === 'archived' && c.sha256 === put.sha256) return 'ok';
    await ops.park(db, row.id, limits.stuckBackoffMin, `anomaly: stt_raw ${part} row disagrees with the stored object`);
    ctx.acc.anomalies.push({ id: row.id, key: part, what: `stt_raw child ${part} exists with other bytes or state — left parked (6 h, uncharged)` });
    return 'anomaly';
  }
  // Fenced by a purge: never leave the object behind. A failed delete is for a human (the purge may have listed already).
  try { await archive.deleteObject(objectName, { timeoutMs: limits.gcsTimeoutMs }); } catch (err) {
    ctx.acc.anomalies.push({ id: row.id, key: `orphan-${part}`, what: `purged while storing: ${objectName} could not be deleted (${clamp(err.message, 120)}) — delete it by hand` });
  }
  return 'fenced';
}

async function _complete(ctx, row, json, altJson) {
  const { db, out, acc, vendor, cfg } = ctx;
  const variant = _variantOf(row.stt_model);
  const audioS = Number(json.audio_duration);
  const channels = Number(json.audio_channels) || Number(row.audio_channels) || 2;
  const kt = cfg.keyterms.length > 0;

  // The money first: the jobs completed, so they are billed whatever happens next.
  await _ledgerFinish(db, row.id, row.stt_job_ref, 'completed', { costCents: vendor.costCents({ audioS, variant, channels, keyterms: kt }) });
  if (altJson) {
    await _ledgerFinish(db, row.id, row.alt_job_ref, 'completed', {
      costCents: vendor.costCents({ audioS: Number(altJson.audio_duration) || audioS, variant: _other(variant), channels, keyterms: kt }),
    });
  }

  let segs;
  try { segs = vendor.segmentsFromVendorJson(json); } catch (err) {
    if (err.code !== 'DRIFT') throw err;
    await ops.park(db, row.id, limits.driftBackoffMin, clamp(err.message, 300));
    acc.drift.push({ id: row.id, what: clamp(err.message, 200) });
    out.drift++;
    return;
  }
  let note = null;
  if (altJson) {
    try { vendor.segmentsFromVendorJson(altJson); } catch (err) {
      if (err.code !== 'DRIFT') throw err;
      note = `sample variant not stored: ${clamp(err.message, 200)}`;
      acc.drift.push({ id: row.id, what: `sample variant: ${clamp(err.message, 150)}` });
      out.drift++;
      altJson = null;
    }
  }

  const s1 = await _storeRaw(ctx, row, json, vendor.VARIANTS[variant].part);
  if (s1 !== 'ok') { if (s1 === 'fenced') out.fenced++; return; }
  if (altJson) {
    const s2 = await _storeRaw(ctx, row, altJson, vendor.VARIANTS[_other(variant)].part);
    if (s2 !== 'ok') { if (s2 === 'fenced') out.fenced++; return; }
  }

  const speakers = new Set(segs.map(x => x.s)).size;
  const [u] = await db.query(
    `UPDATE comms_transcripts
        SET state = 'transcribed', stt_vendor = 'assemblyai', language = ?, speakers = ?, segments = ?,
            full_text = ?, transcribed_at = UTC_TIMESTAMP(), skip_reason = NULL,
            attempts = GREATEST(attempts, 1) - 1, next_attempt_at = NULL, last_error = ?
      WHERE id = ? AND state = 'transcribing' AND stt_job_ref = ?`,
    [clamp(json.language_code, 16), speakers || null, JSON.stringify(segs), vendor.fullTextOf(segs, json),
      note, row.id, row.stt_job_ref]);
  if (u.affectedRows !== 1) { out.fenced++; return; }   // purged between the child and here: the purge removes the child

  if (Number.isFinite(audioS) && audioS >= 0) {
    await db.query("UPDATE comms_media SET duration_s = ? WHERE id = ? AND state = 'archived'", [Math.round(audioS), row.media_id]);
    const est = row.est_audio_s;
    if (est != null && Math.abs(est - audioS) > Math.max(limits.durationDriftPct * audioS, limits.durationDriftMinS)) {
      acc.durationDrift.push({ media_id: row.media_id, est, actual: Math.round(audioS) });
    }
  }
  out.completed++;
}

const POLL_STATUS = new Set(['queued', 'processing', 'completed', 'error']);

/** GET one job; → {json} | {handled:true} | {lost:true}. */
async function _getJob(ctx, row, attemptsNow, id) {
  const r = await ctx.vendor.getTranscript(ctx.db, { credId: ctx.cfg.credId, id, timeoutMs: limits.vendorTimeoutMs });
  if (r.status === 404) return { lost: true };
  if (await _getStatus(ctx, row, r, attemptsNow, 'GET /v2/transcript/{id}')) return { handled: true };
  const j = r.json;
  if (j.id !== id || !POLL_STATUS.has(j.status)) {
    await ops.park(ctx.db, row.id, limits.driftBackoffMin, `shape drift: GET transcript answered id ${clamp(j.id, 40)} status ${clamp(j.status, 20)}`);
    ctx.acc.drift.push({ id: row.id, what: `GET transcript: id/status ${clamp(j.id, 40)} ${clamp(j.status, 20)}` });
    ctx.out.drift++;
    return { handled: true };
  }
  return { json: j };
}

async function _pollOne(ctx, row) {
  const { db, out, vendor } = ctx;
  if (!(await ops.claim(db, row.id))) return;
  const attemptsNow = row.attempts + 1;
  out.polled++;
  if (row.m_state !== 'archived') return _parentGone(db, row, out);

  const main = await _getJob(ctx, row, attemptsNow, row.stt_job_ref);
  if (main.handled) return;
  if (main.lost) {
    await _ledgerFinish(db, row.id, row.stt_job_ref, 'lost', { lastError: 'the vendor answered 404 for its own job' });
    if (row.alt_job_ref) await _ledgerFinish(db, row.id, row.alt_job_ref, 'lost', { lastError: 'its main job was lost' });
    return _mainFailed(ctx, row, 'the vendor no longer has the job (404) — resubmitting');
  }
  const j = main.json;
  if (j.status === 'queued' || j.status === 'processing') { await _schedulePoll(db, row); return; }
  if (j.status === 'error') {
    const text = vendor.redactUrls(j.error);
    const kind = vendor.classifyJobError(text);
    if (kind === 'download') out.download_errors = (out.download_errors || 0) + 1;
    await _ledgerFinish(db, row.id, row.stt_job_ref, 'error', { lastError: text });
    if (row.alt_job_ref) await _ledgerFinish(db, row.id, row.alt_job_ref, 'error', { lastError: 'its main job errored' });
    return _mainFailed(ctx, row, `vendor error (${kind}): ${clamp(text, 400)}`);
  }

  let altJson = null;
  if (row.alt_job_ref) {
    const alt = await _getJob(ctx, row, attemptsNow, row.alt_job_ref);
    if (alt.handled) return;
    if (alt.json && (alt.json.status === 'queued' || alt.json.status === 'processing')) { await _schedulePoll(db, row); return; }
    if (alt.json && alt.json.status === 'completed') altJson = alt.json;
    else {
      // lost or errored: the canonical transcript still lands; the variant job is recorded (and owed a delete).
      const why = alt.lost ? 'the vendor answered 404' : vendor.redactUrls(alt.json && alt.json.error);
      await _ledgerFinish(db, row.id, row.alt_job_ref, alt.lost ? 'lost' : 'error', { lastError: why });
      out.alt_errors = (out.alt_errors || 0) + 1;
      ctx.acc.drift.push({ id: row.id, what: `sample variant ${alt.lost ? 'lost (404)' : `error: ${clamp(why, 120)}`}` });
    }
  }
  try {
    await _complete(ctx, row, j, altJson);
  } catch (err) {
    if (!err.ourSide) throw err;
    await ops.refund(db, row.id, clamp(err.message, 300));
    await _storageAlert(db, err.message);
    out.stop = 'storage';
    ctx.storageStopped = true;
  }
}

// ─────────────────────────────────────────────────────────────
// Discover + submit
// ─────────────────────────────────────────────────────────────

async function _discover(ctx) {
  const { db, cfg, out } = ctx;
  // A 'restricted' skip whose item was unrestricted is eligible again.
  const [back] = await db.query(
    `UPDATE comms_transcripts t JOIN comms_media m ON m.id = t.media_id
        SET t.state = 'pending', t.skip_reason = NULL, t.next_attempt_at = NULL
      WHERE t.state = 'skipped' AND t.skip_reason = 'restricted' AND m.restricted = 0 AND m.state = 'archived'`);
  out.unrestricted = back.affectedRows || 0;
  const sample = cfg.mode === 'sample'
    ? ' AND EXISTS (SELECT 1 FROM comms_eval_items e WHERE e.media_id = m.id)' : '';
  const [r] = await db.query(
    `INSERT IGNORE INTO comms_transcripts (media_id, phone_event_id, state)
     SELECT m.id, IF(m.source_table = 'phone_event_log', m.source_id, NULL), 'pending'
       FROM comms_media m
      WHERE m.state = 'archived' AND m.kind IN (?)
        AND NOT EXISTS (SELECT 1 FROM comms_transcripts t WHERE t.media_id = m.id)${sample}
      ORDER BY m.captured_at DESC, m.id DESC
      LIMIT ?`, [KINDS, limits.discoverLimit]);
  out.discovered = r.affectedRows || 0;
}

/** → true when the tick must stop submitting. */
async function _submitOne(ctx, row) {
  const { db, out, cfg, vendor } = ctx;
  if (!(await ops.claim(db, row.id))) return false;
  if (row.m_state !== 'archived') { await _parentGone(db, row, out); return false; }

  // a. Restrict: a call marked private never leaves our storage (R5).
  if (Number(row.restricted) === 1) {
    await _skip(db, row, 'restricted', null);
    out.skipped_restricted++;
    return false;
  }
  if (!row.object_name) {
    await ops.park(db, row.id, limits.driftBackoffMin, 'shape drift: archived item has no object_name');
    ctx.acc.drift.push({ id: row.id, what: 'archived item without object_name' });
    out.drift++;
    return false;
  }
  // b. never-transcribe list
  if (await _onNoTranscribe(db, row.party)) {
    await _skip(db, row, 'no_transcribe', null);
    out.skipped_no_transcribe++;
    return false;
  }

  // c. audio length from the file
  let head;
  try { head = await archive.readHead(row.object_name, audio.HEAD_BYTES, { timeoutMs: limits.gcsTimeoutMs }); }
  catch (err) {
    if (!err.ourSide) throw err;
    await ops.refund(db, row.id, clamp(err.message, 300));
    await _storageAlert(db, err.message);
    out.stop = 'storage';
    return true;
  }
  const est = audio.estimate({ head, bytes: row.bytes }) || audio.nominal({ provider: row.provider, mime: row.mime, bytes: row.bytes });
  if (!est) {
    await ops.park(db, row.id, limits.driftBackoffMin, `shape drift: unreadable audio header (${clamp(row.mime, 40)}) and no nominal rate`);
    ctx.acc.drift.push({ id: row.id, what: `audio header unreadable: ${clamp(row.mime, 40)}, ${row.bytes} bytes` });
    out.drift++;
    return false;
  }
  const estS = Math.round(est.estS);
  const channels = est.channels || row.audio_channels || null;
  if (est.channels) {
    await db.query('UPDATE comms_media SET audio_channels = ? WHERE id = ? AND audio_channels IS NULL', [est.channels, row.media_id]);
  }
  await db.query('UPDATE comms_transcripts SET est_audio_s = ? WHERE id = ?', [estS, row.id]);
  row.est_audio_s = estS;
  if (est.method === 'nominal') out.nominal_estimates = (out.nominal_estimates || 0) + 1;

  // d. short (calls only, mode on)
  if (cfg.mode === 'on' && row.kind === 'call_recording' && est.estS < cfg.minS) {
    await _skip(db, row, 'short', estS);
    out.skipped_short++;
    return false;
  }
  // e. per-call cap
  if (est.estS > cfg.maxMin * 60 && row.cap_released_by == null) {
    await _skip(db, row, 'over_cap', estS);
    out.skipped_over_cap++;
    return false;
  }

  // f. variants + the monthly cap
  const stereo = channels != null && channels >= 2;
  const main = stereo ? cfg.stereo : 'diarize';
  const alt = cfg.mode === 'sample' && stereo ? _other(main) : null;
  const kt = cfg.keyterms.length > 0;
  const mainEst = vendor.costCents({ audioS: est.estS, variant: main, channels: channels || 1, keyterms: kt });
  const altEst = alt ? vendor.costCents({ audioS: est.estS, variant: alt, channels: channels || 2, keyterms: kt }) : 0;
  const mtd = await monthToDateCents(db);
  out.cap = { mtd_cents: Math.round(mtd * 100) / 100, cap_cents: cfg.capCents };
  if (mtd + mainEst + altEst > cfg.capCents) {
    await ops.refund(db, row.id, null);
    out.stop = 'cap';
    ctx.capHit = true;
    return true;
  }

  // g. the signing proof, once per tick
  if (!ctx.signingProven) {
    try { await proveSigning(ctx.http); ctx.signingProven = true; }
    catch (err) {
      if (!err.ourSide) throw err;
      await ops.refund(db, row.id, null);
      await _storageAlert(db, `${err.message} — no client audio was sent`);
      out.stop = 'signing';
      return true;
    }
  }

  // h/i. submit: the MAIN job, the row to 'transcribing' at once, then the sample variant
  const o = await _postJob(ctx, row, { role: 'main', variant: main, estCents: mainEst });
  if (o.storage) {
    await ops.refund(db, row.id, clamp(o.storage.message, 300));
    await _storageAlert(db, o.storage.message);
    out.stop = 'signing';
    return true;
  }
  if (!o.jobRef) return !!o.stop;
  const [u] = await db.query(
    `UPDATE comms_transcripts
        SET state = 'transcribing', stt_vendor = 'assemblyai', stt_model = ?, stt_job_ref = ?, alt_job_ref = NULL,
            submitted_at = UTC_TIMESTAMP(), attempts = GREATEST(attempts, 1) - 1,
            next_attempt_at = UTC_TIMESTAMP() + INTERVAL 1 MINUTE, last_error = NULL
      WHERE id = ? AND state = 'pending'`,
    [vendor.VARIANTS[main].model, o.jobRef, row.id]);
  if (u.affectedRows !== 1) { out.fenced++; return ctx.vendorStopped; }   // purged while submitting: the ledger owes the delete
  out.submitted++;

  if (alt && !ctx.vendorStopped) {
    const oa = await _postJob(ctx, row, { role: 'alt', variant: alt, estCents: altEst });
    const note = oa.jobRef ? null : `sample variant ${alt} not submitted${oa.storage ? ` (signing: ${clamp(oa.storage.message, 80)})` : ''}`;
    await db.query(
      `UPDATE comms_transcripts SET alt_job_ref = ?, last_error = ?
        WHERE id = ? AND state = 'transcribing' AND stt_job_ref = ?`, [oa.jobRef || null, note, row.id, o.jobRef]);
    if (oa.storage) { await _storageAlert(db, oa.storage.message); out.stop = 'signing'; return true; }
  }
  return ctx.vendorStopped;
}

// ─────────────────────────────────────────────────────────────
// Orphan search + owed vendor deletes (every mode)
// ─────────────────────────────────────────────────────────────

/** Timed-out POSTs: look for the job in the vendor's list by sha256(audio_url). */
async function _searchOrphans(ctx) {
  const { db, out, acc } = ctx;
  const [jobs] = await db.query(
    `SELECT id, transcript_id, media_id, url_sha256, submitted_at FROM comms_stt_jobs
      WHERE state = 'unknown' AND job_ref IS NULL AND url_sha256 IS NOT NULL
        AND (delete_after IS NULL OR delete_after <= UTC_TIMESTAMP())
      ORDER BY id LIMIT ?`, [limits.orphanPerTick]);
  for (const j of jobs) {
    if (ctx.vendorStopped || ctx.timeLeft() <= 0) return;
    try {
      await _searchOne(ctx, j);
    } catch (err) {
      // One bad item never stops the tick (the deletes, discover and submit still run).
      out.orphan_errors = (out.orphan_errors || 0) + 1;
      acc.drift.push({ id: j.transcript_id, what: `orphan search for ledger job ${j.id}: ${clamp(err.message, 150)}` });
      try { await db.query('UPDATE comms_stt_jobs SET delete_after = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?', [limits.orphanRecheckMin, j.id]); } catch (_) { /* next tick */ }
    }
  }
}

async function _searchOne(ctx, j) {
  const { db, vendor, cfg, out, acc } = ctx;
  const sub = new Date(j.submitted_at);
  const days = [...new Set([sub, new Date(sub.getTime() + 3_600_000)].map(d => d.toISOString().slice(0, 10)))];
  let found = null, matchedKnown = null;
  for (const day of days) {
    let before = null;
    for (let page = 0; page < limits.orphanPages && !found; page++) {
      const r = await vendor.listTranscripts(db, { credId: cfg.credId, createdOn: day, beforeId: before, limit: 200, timeoutMs: limits.vendorTimeoutMs });
      if (r.status === 401 || r.status === 403) { ctx.stopVendor('no_auth'); return; }
      if (r.status === 429) { ctx.stopVendor('rate_limited'); return; }
      const list = r.json && Array.isArray(r.json.transcripts) ? r.json.transcripts : null;
      if (!list) break;                                    // unreadable / transient: try again later
      // Every job behind this URL; the first one the ledger does not already hold is ours.
      for (const x of list) {
        if (!x || typeof x.audio_url !== 'string' || typeof x.id !== 'string' || sha256(x.audio_url) !== j.url_sha256) continue;
        const [[k]] = await db.query("SELECT id FROM comms_stt_jobs WHERE vendor = 'assemblyai' AND job_ref = ? LIMIT 1", [x.id]);
        if (k) { matchedKnown = matchedKnown || k.id; continue; }
        found = x;
        break;
      }
      if (found || list.length < 200) break;
      before = list[list.length - 1] && list[list.length - 1].id;
      if (!vendor.validJobId(before)) break;
    }
    if (found) break;
  }
  out.orphan_searched = (out.orphan_searched || 0) + 1;
  if (found) {
    await db.query(
      `UPDATE comms_stt_jobs SET job_ref = ?, state = 'orphan', url_sha256 = NULL, delete_after = NULL,
              last_error = 'found in the vendor list after a POST without a usable answer'
        WHERE id = ? AND job_ref IS NULL`, [clamp(found.id, 191), j.id]);
    out.orphans_found = (out.orphans_found || 0) + 1;
    return;
  }
  if (matchedKnown && Date.now() - sub.getTime() > limits.orphanRecheckMin * 60_000) {
    // Its URL only ever matched jobs the ledger already holds (counted, owed): this request created no separate job.
    await db.query(
      `UPDATE comms_stt_jobs SET url_sha256 = NULL, finished_at = UTC_TIMESTAMP(), last_error = ?
        WHERE id = ? AND job_ref IS NULL`, [`its URL matched only ledger job ${matchedKnown} — no separate job`, j.id]);
    return;
  }
  if (Date.now() - sub.getTime() > limits.orphanSearchHours * 3_600_000) {
    await db.query(
      `UPDATE comms_stt_jobs SET url_sha256 = NULL, finished_at = UTC_TIMESTAMP(),
              last_error = 'never found in the vendor list — the vendor TTL removes it if it exists'
        WHERE id = ?`, [j.id]);
    acc.orphansLost.push({ job: j.id, media_id: j.media_id });
  } else {
    await db.query('UPDATE comms_stt_jobs SET delete_after = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?', [limits.orphanRecheckMin, j.id]);
  }
}

/** Delete one ledger job at the vendor. → 'deleted' | 'owed' | 'stop'. Never stamps without a confirmed delete. */
async function _deleteJob(ctx, j) {
  const { db, vendor, cfg, acc } = ctx;
  if (!vendor.validJobId(j.job_ref)) {
    await db.query("UPDATE comms_stt_jobs SET delete_after = UTC_TIMESTAMP() + INTERVAL 1 DAY, last_error = 'undeletable id' WHERE id = ?", [j.id]);
    acc.anomalies.push({ id: j.transcript_id, key: `job${j.id}`, what: `vendor job ${JSON.stringify(clamp(j.job_ref, 80))} (comms_stt_jobs ${j.id}) has an id we cannot put in a URL — delete it in the AssemblyAI dashboard` });
    return 'owed';
  }
  let r;
  try { r = await vendor.deleteTranscript(db, { credId: cfg.credId, id: j.job_ref, timeoutMs: limits.vendorTimeoutMs }); }
  catch (err) { if (err.code === 'NO_AUTH') { ctx.stopVendor('no_auth'); return 'stop'; } throw err; }
  if ((r.status >= 200 && r.status < 300) || r.status === 404) {
    await db.query('UPDATE comms_stt_jobs SET deleted_at = UTC_TIMESTAMP(), delete_after = NULL WHERE id = ? AND deleted_at IS NULL', [j.id]);
    ctx.out.vendor_deleted++;
    return 'deleted';
  }
  if (r.status === 401 || r.status === 403) { ctx.stopVendor('no_auth'); return 'stop'; }
  if (r.status === 429) { ctx.stopVendor('rate_limited'); return 'stop'; }
  const n = Number(j.delete_attempts) + 1;
  const why = `DELETE ${r.status || 'network'}: ${clamp(r.errorText || '', 200)}`;
  await db.query(
    `UPDATE comms_stt_jobs SET delete_attempts = ?, delete_after = UTC_TIMESTAMP() + INTERVAL ? MINUTE, last_error = ?
      WHERE id = ?`, [n, Math.min(2 ** n, limits.backoffCapMin), clamp(why, 500), j.id]);
  ctx.out.vendor_delete_owed++;
  if (n >= limits.deleteAlertAfter) acc.deleteStuck.push({ job: j.id, why });
  return 'owed';
}

/**
 * Jobs owed a delete: a ref, not confirmed deleted, due, and NOT the live job
 * of a 'transcribing' row (that one is still being polled).
 */
const OWED_SQL = `SELECT j.id, j.transcript_id, j.job_ref, j.delete_attempts
       FROM comms_stt_jobs j LEFT JOIN comms_transcripts t ON t.id = j.transcript_id
      WHERE j.deleted_at IS NULL AND j.job_ref IS NOT NULL
        AND (j.delete_after IS NULL OR j.delete_after <= UTC_TIMESTAMP())
        AND NOT (COALESCE(t.state, '') = 'transcribing' AND (j.job_ref <=> t.stt_job_ref OR j.job_ref <=> t.alt_job_ref))`;

async function _deleteLoop(ctx) {
  const [rows] = await ctx.db.query(`${OWED_SQL} ORDER BY j.id LIMIT ?`, [limits.deletePerTick]);
  for (const j of rows) {
    if (ctx.vendorStopped || ctx.timeLeft() <= 0) break;
    if ((await _deleteJob(ctx, j)) === 'stop') break;
  }
}

async function _backlogAlarm(db, out) {
  try {
    const [[r]] = await db.query(
      `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM comms_transcripts
        WHERE state IN ('pending', 'transcribing') AND created_at < UTC_TIMESTAMP() - INTERVAL ? HOUR`,
      [limits.backlogAlertHours]);
    if (Number(r.n) > 0) {
      out.backlog_old = Number(r.n);
      await _dailyAlert(db, 'comms_transcribe_backlog', 'warning',
        `Comms transcription: ${r.n} item(s) waiting more than ${limits.backlogAlertHours} h`,
        `Oldest waiting since ${new Date(r.oldest).toISOString()} (UTC). Check the cap, the credential and the drift alerts.`,
        { waiting: Number(r.n) });
    }
  } catch (err) {
    console.error('[COMMS TRANSCRIBE] backlog check failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Tick
// ─────────────────────────────────────────────────────────────

/**
 * One tick. opts: { vendor, http } — stand-ins at the boundaries (tests);
 * defaults are services/commsTranscribeVendor and fetch.
 */
async function runTranscribeSweep(db, opts = {}) {
  const vendor = opts.vendor || require('./commsTranscribeVendor');
  const t0 = Date.now();
  const out = {
    mode: null, discovered: 0, submitted: 0, polled: 0, completed: 0, retried: 0, failed: 0, drift: 0, fenced: 0,
    skipped_short: 0, skipped_no_transcribe: 0, skipped_over_cap: 0, skipped_restricted: 0,
    vendor_deleted: 0, vendor_delete_owed: 0, stop: null,
  };
  const acc = { drift: [], failed: [], durationDrift: [], anomalies: [], unknownJobs: [], orphansLost: [], deleteStuck: [] };
  const lock = await common.acquireLock(db, LOCK_EXPR, 0);
  if (!lock) return { ...out, skipped: 'locked' };
  const ctx = {
    db, vendor, http: opts.http || _httpGet, out, acc, cfg: null,
    timeLeft: () => limits.deadlineMs - (Date.now() - t0),
    vendorStopped: false, storageStopped: false, signingProven: false, capHit: false,
    stopVendor(why) { this.vendorStopped = true; out.stop = why; },
  };
  try {
    const cfg = await readConfig(db);
    ctx.cfg = cfg;
    out.mode = cfg.mode;
    if (cfg.problems.length || cfg.notes.length) {
      await _dailyAlert(db, 'comms_transcribe_config', cfg.problems.length ? 'error' : 'warning',
        'Comms transcription: a setting is wrong',
        [...cfg.problems, ...cfg.notes].join('\n') + (cfg.problems.length ? '\n\nTranscription is stopped until it is fixed.' : ''),
        { problems: cfg.problems, notes: cfg.notes });
    }
    if (cfg.problems.length) { out.stop = 'config'; return out; }
    if (!(await vendor.checkAuth(db, cfg.credId))) {
      await _noAuthAlert(db, cfg.credId, { endpoint: 'pre-flight', status: null });
      out.stop = 'no_auth';
      return out;
    }

    // 1. poll — every mode (in-flight jobs are paid for and hold a vendor copy)
    const seen = [];
    while (out.polled < limits.pollPerTick && ctx.timeLeft() > 0 && !ctx.vendorStopped && !ctx.storageStopped) {
      const row = await _nextDue(db, 'transcribing', { seen });
      if (!row) break;
      seen.push(row.id);
      await _pollOne(ctx, row);
    }

    // 1b. orphan search, then owed vendor deletes — every mode, before any new submit
    if (!ctx.vendorStopped) await _searchOrphans(ctx);
    if (!ctx.vendorStopped) await _deleteLoop(ctx);

    // 2. discover + 3. submit — sample / on only
    if (cfg.mode !== 'off' && !ctx.vendorStopped && !ctx.storageStopped) {
      try {
        await _discover(ctx);
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE' && cfg.mode === 'sample') {
          await _dailyAlert(db, 'comms_transcribe_config', 'error', 'Comms transcription: sample mode has no sample list',
            'comms_transcribe_mode = sample but comms_eval_items does not exist. Nothing is submitted.', {});
          out.stop = 'config';
        } else throw err;
      }
      const breaker = out.stop == null ? await _breakerOpen(db) : null;
      if (breaker) {
        out.stop = 'drift_breaker';
        await _dailyAlert(db, 'comms_transcribe_breaker', 'error',
          'Comms transcription: submissions paused — the vendor\'s answers cannot be trusted',
          `The last ${limits.breakerPosts} POSTs to AssemblyAI all came back unreadable or without an answer (the newest at ${breaker.toISOString()} UTC). ` +
          `Each may be a real, billed job, so new submissions pause for ${limits.breakerPauseHours} h from then; polling, the orphan search and deletes go on. ` +
          'Check the drift / orphan alerts and AssemblyAI\'s status.',
          { newest: breaker.toISOString() });
      }
      const sseen = [];
      while (out.stop == null && !ctx.vendorStopped && out.submitted < limits.submitPerTick && ctx.timeLeft() > 0) {
        const row = await _nextDue(db, 'pending', { sample: cfg.mode === 'sample', seen: sseen });
        if (!row) break;
        sseen.push(row.id);
        if (await _submitOne(ctx, row)) break;
      }
      if (ctx.capHit) await capAlert(db, out);
      await _backlogAlarm(db, out);
    }
    if (out.download_errors && !out.completed) {
      await _storageAlert(db, `AssemblyAI could not download ${out.download_errors} signed URL(s) this tick and none completed — check V4 signing / the bucket`);
    }
    return out;
  } finally {
    await _flushAlerts(db, acc);
    await lock.release();
  }
}

// ─────────────────────────────────────────────────────────────
// Purge + release (called from services/commsArchiveAdmin.js and the SU console)
// ─────────────────────────────────────────────────────────────

/**
 * PURGE_PARTS 'transcripts' (FIRST — the fence; design §8), for one
 * comms_media row:
 *   1. its transcript row goes 'purged' with its text cleared (cost stays —
 *      it is not content);
 *   2. EVERY object under the item's stt prefix is deleted, found by LISTING
 *      (a crash between a put and its child row leaves an object no row
 *      names). A storage failure throws: the purge 502s and is retried;
 *   3. the vendor copies of its ledger jobs are deleted, best-effort — the
 *      sweep keeps retrying an owed one; the vendor's 30-day TTL backstops;
 *   4. (S3) every ai_calls row of the transcript (consumer_ref
 *      'comms_transcript:<id>' — every attempt, retries included) loses its
 *      request_excerpt and response; cost and tokens stay (not content).
 * Idempotent. On a database the S2 migration has not reached it is a no-op.
 * → { rows, deleted, vendor: 'none' | 'deleted' | 'owed', ai_calls }
 */
async function purgeTranscript(db, row, { vendor = require('./commsTranscribeVendor') } = {}) {
  let r;
  try {
    [r] = await db.query(
      `UPDATE comms_transcripts
          SET state = 'purged', segments = NULL, full_text = NULL, summary = NULL, summary_text = NULL,
              next_attempt_at = NULL
        WHERE media_id = ?`, [row.id]);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { rows: 0, deleted: 0, vendor: 'none', ai_calls: 0 };
    throw err;
  }

  let deleted = 0;
  if (row.captured_at) {
    const prefix = archive.sttPrefix({ capturedAt: row.captured_at, parentId: row.id });
    for (const f of await archive.findByPrefix(prefix)) {
      await archive.deleteObject(f.name);
      deleted++;
    }
  }

  const [[t]] = await db.query('SELECT id FROM comms_transcripts WHERE media_id = ?', [row.id]);
  if (!t) return { rows: r.affectedRows, deleted, vendor: 'none', ai_calls: 0 };
  // S3: the summary attempts' text (the model's output; the system text with the contact's name).
  let aiCalls = 0;
  try {
    const [ac] = await db.query(
      'UPDATE ai_calls SET request_excerpt = NULL, response = NULL WHERE consumer_ref = ?', [`comms_transcript:${t.id}`]);
    aiCalls = ac.affectedRows || 0;
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;            // no ai_calls table = no summary attempts to clear
  }
  let jobs;
  try {
    [jobs] = await db.query(
      'SELECT id, transcript_id, job_ref, delete_attempts FROM comms_stt_jobs WHERE transcript_id = ? AND deleted_at IS NULL AND job_ref IS NOT NULL',
      [t.id]);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { rows: r.affectedRows, deleted, vendor: 'none', ai_calls: aiCalls };
    throw err;
  }
  if (!jobs.length) return { rows: r.affectedRows, deleted, vendor: 'none', ai_calls: aiCalls };
  let all = true;
  try {
    const cfg = await readConfig(db);
    if (cfg.credId == null) all = false;
    for (const j of jobs) {
      if (!all) break;
      if (!vendor.validJobId(j.job_ref)) { all = false; break; }
      const d = await vendor.deleteTranscript(db, { credId: cfg.credId, id: j.job_ref, timeoutMs: 10_000 });
      if ((d.status >= 200 && d.status < 300) || d.status === 404) {
        await db.query('UPDATE comms_stt_jobs SET deleted_at = UTC_TIMESTAMP(), delete_after = NULL WHERE id = ? AND deleted_at IS NULL', [j.id]);
      } else {
        all = false;
      }
    }
  } catch (_) {
    all = false;
  }
  return { rows: r.affectedRows, deleted, vendor: all ? 'deleted' : 'owed', ai_calls: aiCalls };
}

/**
 * Release an over_cap skip so the next tick submits it despite the per-call
 * cap (design §6.5). The route for it is S4's; until then the SU console runs
 * the same UPDATE (the §6.5 line). → affected rows (0 = not an over_cap skip).
 */
async function releaseCap(db, transcriptId, { userId }) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('releaseCap: userId required');
  const [r] = await db.query(
    `UPDATE comms_transcripts SET state = 'pending', skip_reason = NULL, cap_released_by = ?,
            next_attempt_at = NULL, last_error = NULL
      WHERE id = ? AND state = 'skipped' AND skip_reason = 'over_cap'`, [uid, transcriptId]);
  return r.affectedRows;
}

module.exports = {
  runTranscribeSweep, purgeTranscript, releaseCap, monthToDateCents, monthToDateParts, capAlert, readConfig, proveSigning,
  limits, KEYS, LOCK_EXPR, PROBE_OBJECT, PROBE_TEXT,
};
