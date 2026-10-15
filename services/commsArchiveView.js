// services/commsArchiveView.js
//
/**
 * Comms archive — what a conversation thread SHOWS of the archive (S4).
 * ref/COMMS_ARCHIVE_DESIGN.md §7 (access), §9 S4 (surfaces).
 *
 * decorate() hangs archive fields on the items of one conversation page
 * (phoneCommsService.listMessages / listAllMessages output) — the route has
 * already resolved the caller's READ on every line the page covers, so this
 * file only applies what the line check does not: `restricted` (archive
 * admins only, R9) and the item's own line (a row whose channel_id is not
 * the item's line is never shown — enforced, not assumed).
 *
 *   call item  + archive:   {media_id, has_audio, has_transcript, …summary, restricted, extra, [transcript_status]}
 *              + voicemail: {media_id, provider, has_audio, has_transcript, …summary, restricted, [transcript_status]}
 *     …summary = summary_text, summary_model (S3), summary_note, summary_note_by
 *                (S3c: the note that SHAPED the summary shown — stamped into it),
 *                summary_requested_at, summary_pending (S3c: the current request,
 *                comms_summary_guides; a pending request's note is not shown)
 *     transcript_status = {state, reason, est_s} — WHY there is no transcript,
 *                only when has_transcript is false and comms_transcripts holds
 *                a row in a state that is not readable and not purged (else
 *                the key is absent): state in_progress (pending / transcribing)
 *                | skipped | failed; reason 'short' | 'over_cap' | null (every
 *                other skip_reason — no_transcribe, policy, restricted — is
 *                null: comms_no_transcribe is a SENSITIVE table, its
 *                membership never reaches a line reader); est_s the estimated
 *                audio seconds, only with reason 'short'. No content.
 *   sms item   + attachments: [{media_id, mime, view, bytes, restricted}]
 *              + attachments_pending: n   (rows not archived yet)
 *   page       + archive_admin: bool      (draws Restrict / Purge)
 *
 * Only ARCHIVED rows surface. Items the viewer may not read are OMITTED, not
 * locked (§7). A PURGED row is a tombstone `{media_id, purged:{at, by, reason}}`
 * for archive admins only; everyone else sees nothing (Fred via the manager,
 * S4 Q3). Fields stay absent when there is nothing to show, so a page with no
 * archive rows is byte-identical to before.
 *
 * VOICEMAILS. Quo: kind voicemail on the call's own row (source_id = the
 * call) — any call status (a call routed to voicemail may report completed).
 * RingCentral: provider identity (source_table 'rc_message'), anchored by
 * §7's S4-input row: party = the call's other party, channel_id = the call's
 * line, captured_at within [call start − 5 min, call end + 30 min]. RC never
 * reports a missed call (status is Accepted / ''), so every INCOMING call is
 * a candidate; one voicemail attaches to ONE call — the latest that started
 * at or before it (else, within the 5-minute lead, the earliest after it) —
 * and the assignment is made over every archived / purged voicemail BEFORE
 * visibility, so it never depends on the viewer — and from the party's calls
 * in the DATABASE, not the page, so it never depends on paging either. A
 * voicemail with NO line (channel_id NULL) matches RingCentral calls on party
 * + window alone and is shown only to the SU / attorney bypass.
 *
 * TRANSCRIPTS. Restriction lives ONLY on comms_media (S2 keeps no restricted
 * column on comms_transcripts): transcripts are looked up only for media rows
 * this viewer was already shown. comms_transcripts is S2's table: until its migration runs the
 * read answers ER_NO_SUCH_TABLE and has_transcript is false (self-heals, any
 * deploy order). A voicemail also has a transcript when the phone provider's
 * own (an archived stt_raw child) exists — the secondary record (R10).
 * summary_text / summary_model are S3's (comms_transcripts); the note fields
 * come from the summary's own stamp, pending / requested_at from S2's
 * comms_summary_guides (absent table → null / false).
 */

'use strict';

const admin = require('./commsArchiveAdmin');

const VM_BEFORE_MS = 5 * 60 * 1000;
const VM_AFTER_MS = 30 * 60 * 1000;
const CONTENT_KINDS = ['call_recording', 'mms_file', 'voicemail'];
// comms_transcripts states whose text may be read (S2: 'transcribed', S3:
// 'summarized'). pending / transcribing / skipped / failed / purged never are —
// a re-submitted row's old text must not show while it is 'transcribing'.
const READABLE_STATES = ['transcribed', 'summarized'];
// The states that say why a recording has NO transcript (the thread's
// transcript_status). purged is not one of them: a purged row shows nothing.
const STATUS_OF = { pending: 'in_progress', transcribing: 'in_progress', skipped: 'skipped', failed: 'failed' };
// The only skip reasons a line reader is told. no_transcribe would leak
// comms_no_transcribe membership (a SENSITIVE table); policy / restricted /
// anything new read as a bare skip.
const SHOWN_SKIP_REASONS = ['short', 'over_cap'];
// stt_raw children that ARE a phone provider's voicemail transcript: S1c names
// them <voicemail id>.<vendor>.json (Quo's part is 'quo', RC's the attachment
// id — so the object name, not the part, says which). S2 adds other stt_raw
// children (e.g. 'assemblyai-mc', an eval variant) — never a vendor
// transcript here.
const VENDOR_SQL = "(object_name LIKE '%.quo.json' OR object_name LIKE '%.ringcentral.json')";

const MEDIA_COLS =
  `m.id, m.kind, m.source_table, m.source_id, m.part, m.provider, m.channel_id, m.party, m.mime, m.bytes,
   m.state, m.restricted, m.captured_at, m.purged_at, m.purge_reason, u.user_name AS purged_by_name`;

/** How the pane draws an MMS file: only types the serving allowlist puts inline are viewable. */
function viewOf(mime) {
  const t = require('./commsArchiveService').baseMime(mime); // lazy require (convention); signedUrl's own normalisation
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(t)) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (['audio/mpeg', 'audio/wav', 'audio/mp4'].includes(t)) return 'audio';
  return 'file';
}

function tombstone(r) {
  return {
    media_id: Number(r.id),
    purged: {
      at: r.purged_at ? new Date(r.purged_at).toISOString() : null,
      by: r.purged_by_name == null ? null : String(r.purged_by_name),
      reason: r.purge_reason == null ? null : String(r.purge_reason),
    },
  };
}

/**
 * media_id → {has_transcript, summary_text} from comms_transcripts (S2/S3).
 * Missing table (S2 not migrated yet) → empty. A column S2 renamed is logged
 * loudly and read as "no transcript" — a sibling slice's schema must never
 * take the conversation view down.
 */
async function transcriptInfo(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const [rows] = await db.query(
      `SELECT id, media_id, (segments IS NOT NULL OR full_text IS NOT NULL) AS has_text, summary_text, summary_model, summary
         FROM comms_transcripts WHERE media_id IN (?) AND state IN (?)`, [ids, READABLE_STATES]);
    for (const r of rows) {
      out.set(Number(r.media_id), {
        tid: Number(r.id),
        has: !!Number(r.has_text),
        summary: r.summary_text == null ? null : String(r.summary_text),
        model: r.summary_model == null ? null : String(r.summary_model),
        stamp: guideStamp(r.summary),
        guide: null,
      });
    }
    await attachGuides(db, out);
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return out;
    if (err && err.code === 'ER_BAD_FIELD_ERROR') {
      console.error('[commsArchiveView] comms_transcripts does not match the S4 contract (media_id, segments, full_text, summary_text, state):', err.message);
      return out;
    }
    throw err;
  }
  return out;
}

/**
 * media_id → {state, reason, est_s}: why a recording / voicemail the viewer was
 * already handed has no readable transcript (comms_transcripts rows that are
 * pending / transcribing / skipped / failed). State, a whitelisted reason and
 * a number — never content. Same tolerance as transcriptInfo: a missing table
 * is "no status"; a renamed column is logged loudly and read the same way.
 */
async function transcriptStatus(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const [rows] = await db.query(
      'SELECT media_id, state, skip_reason, est_audio_s FROM comms_transcripts WHERE media_id IN (?) AND state IN (?)',
      [ids, Object.keys(STATUS_OF)]);
    for (const r of rows) {
      const state = STATUS_OF[r.state];
      if (!state) continue;
      const reason = state === 'skipped' && SHOWN_SKIP_REASONS.includes(r.skip_reason) ? r.skip_reason : null;
      const est = reason === 'short' && r.est_audio_s != null && Number.isFinite(Number(r.est_audio_s)) ? Math.round(Number(r.est_audio_s)) : null;
      out.set(Number(r.media_id), { state, reason, est_s: est });
    }
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return out;
    if (err && err.code === 'ER_BAD_FIELD_ERROR') {
      console.error('[commsArchiveView] comms_transcripts does not match the S4 status contract (media_id, state, skip_reason, est_audio_s):', err.message);
      return out;
    }
    throw err;
  }
  return out;
}

/**
 * S3c (re-summarise). The NOTE shown is the one that shaped the summary shown:
 * S2 stamps it into the stored summary JSON (comms_transcripts.summary →
 * top-level `guide` {note, note_by, note_by_name, requested_at, model}, or
 * null; absent on pre-S3c summaries). The guide TABLE (comms_summary_guides)
 * holds the CURRENT request — a newer or pending one replaces its note — so it
 * gives only summary_pending (outcome NULL) and summary_requested_at; a
 * pending request's new note is never shown until its summary lands. Read
 * only for transcripts this viewer was already handed (gated exactly like
 * summary_text). Before S2's migration the table is missing: not pending.
 */
function guideStamp(summary) {
  let s = summary;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
  const g = s && typeof s === 'object' && !Array.isArray(s) ? s.guide : null;
  if (!g || typeof g !== 'object' || typeof g.note !== 'string' || !g.note.trim()) return null;
  return { note: g.note, by: typeof g.note_by_name === 'string' && g.note_by_name.trim() ? g.note_by_name.trim() : null };
}

async function attachGuides(db, byMedia) {
  const tids = [...byMedia.values()].map(t => t.tid);
  if (!tids.length) return;
  let rows;
  try {
    [rows] = await db.query(
      'SELECT transcript_id, requested_at, outcome FROM comms_summary_guides WHERE transcript_id IN (?)', [tids]);
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') return;
    throw err;
  }
  const byTid = new Map(rows.map(r => [Number(r.transcript_id), r]));
  for (const t of byMedia.values()) t.guide = byTid.get(t.tid) || null;
}

/** The summary fields of one archive / voicemail object (S3 + S3c), from its transcriptInfo entry. */
function summaryFields(t) {
  const g = t && t.guide;
  const stamp = t && t.summary != null ? t.stamp : null;       // a note only rides WITH the summary it shaped
  return {
    summary_text: t ? t.summary : null,
    summary_model: t ? t.model : null,
    summary_note: stamp ? stamp.note : null,
    summary_note_by: stamp ? stamp.by : null,
    summary_requested_at: g && g.requested_at ? new Date(g.requested_at).toISOString() : null,
    summary_pending: !!(g && g.outcome == null),
  };
}

/** Voicemail ids that have an archived vendor transcript (stt_raw child) the viewer may see. */
async function vendorTranscripts(db, vmIds, isAdmin) {
  const out = new Set();
  if (!vmIds.length) return out;
  const [rows] = await db.query(
    `SELECT source_id, restricted FROM comms_media
      WHERE source_table = 'comms_media' AND kind = 'stt_raw' AND state = 'archived'
        AND ${VENDOR_SQL} AND source_id IN (?)`, [vmIds]);
  for (const r of rows) if (isAdmin || Number(r.restricted) !== 1) out.add(Number(r.source_id));
  return out;
}

/** A DATETIME param in UTC, independent of the pool's timezone option (phoneCommsService idiom). */
const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const callStart = (m) => { const t = Date.parse(m.at); return Number.isNaN(t) ? null : t; };
const callEnd = (m) => { const s = callStart(m); return s == null ? null : s + (Number(m.duration_s) > 0 ? Number(m.duration_s) * 1000 : 0); };

/** A raw_extra / DATETIME instant → ms, the phoneCommsService way (a zone-less string is UTC). */
function dbMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const s = String(v);
  if (s === '' || s === 'null') return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * A call row's [start, end] exactly as the thread item shows it: `at` is
 * raw_extra.started_at (else processed_at), the length is started_at →
 * ended_at when both are there and in order (phoneCommsService.callFields).
 */
function callSpan(r) {
  const s0 = dbMs(r.started_at);
  const e0 = dbMs(r.ended_at);
  const start = s0 != null ? s0 : dbMs(r.processed_at);
  const end = s0 != null && e0 != null && e0 >= s0 ? start + Math.round((e0 - s0) / 1000) * 1000 : start;
  return { start, end };
}

const CHAIN_PASSES = 6;
const LAG_MS = 10 * 60 * 1000;            // ingest lands after a call ends — slack on the processed_at bound
const LONG_CALL_MS = 12 * 60 * 60 * 1000;  // longest live call ~4 h; generous
const MIN = 60 * 1000;

/**
 * RC voicemails → the call each belongs to, for the incoming calls of this
 * page: Map(call id → vm row). DECIDED FROM THE DATABASE, NOT THE PAGE
 * (review N-A1): a page is a slice, and a page-local choice let one
 * voicemail attach to a call on page 1 and another on page 2 (the pane merges
 * pages — it showed twice). Every call of the party a voicemail could belong
 * to is read from phone_event_log, the window widened until it stops growing
 * (a voicemail's choice depends on the earlier ones that took calls), so every
 * page — and the All-numbers view — computes the same assignment.
 *
 * The rule (review A1, unchanged): only archived / purged voicemails, BEFORE
 * any visibility; one voicemail → one call, one call → one voicemail,
 * voicemails in time order. A candidate is an INCOMING, non-suppressed call
 * of the party with no Quo voicemail of its own (archived / purged), the
 * voicemail inside [start − 5 min, end + 30 min], on the voicemail's line —
 * or, for a line-less one, a RingCentral call (review N-A2: an RC voicemail
 * never lands on a Quo call). The latest that started at or before it wins;
 * else (the 5-minute lead) the earliest after it.
 */
async function matchRcVoicemails(db, party, pageCalls) {
  const out = new Map();
  const spans = pageCalls.filter(c => c.direction === 'incoming' && callStart(c) != null);
  if (!spans.length || !party) return out;
  let lo = Math.min(...spans.map(callStart)) - VM_BEFORE_MS;
  let hi = Math.max(...spans.map(callEnd)) + VM_AFTER_MS;
  let vms = [];
  let calls = [];
  for (let pass = 0; pass < CHAIN_PASSES; pass++) {
    [vms] = await db.query(
      `SELECT ${MEDIA_COLS}
         FROM comms_media m LEFT JOIN users u ON u.user = m.purged_by
        WHERE m.party = ? AND m.captured_at BETWEEN ? AND ?
          AND m.kind = 'voicemail' AND m.source_table = 'rc_message' AND m.state IN ('archived', 'purged')
        ORDER BY m.captured_at, m.id`,
      [String(party), sqlUtc(lo), sqlUtc(hi)]);
    if (!vms.length) return out;
    const ats = vms.map(v => new Date(v.captured_at).getTime());
    const vLo = Math.min(...ats);
    const vHi = Math.max(...ats);
    // processed_at ≥ end ≥ at − 30 min; start ≤ at + 5 min, and processed_at
    // trails start by the call's length plus the ingest lag.
    const [rows] = await db.query(
      `SELECT e.id, e.provider, pl.id AS line_id, e.processed_at,
              JSON_UNQUOTE(JSON_EXTRACT(e.raw_extra, '$.started_at')) AS started_at,
              JSON_UNQUOTE(JSON_EXTRACT(e.raw_extra, '$.ended_at')) AS ended_at
         FROM phone_event_log e JOIN phone_lines pl ON pl.phone_number = e.line_number
        WHERE e.other_party = ? AND e.event_type = 'call' AND e.direction = 'incoming' AND e.suppressed = 0
          AND e.processed_at BETWEEN ? AND ?`,
      [String(party), sqlUtc(vLo - VM_AFTER_MS - LAG_MS), sqlUtc(vHi + VM_BEFORE_MS + LONG_CALL_MS + LAG_MS)]);
    calls = rows.map(r => ({ id: Number(r.id), provider: r.provider, line: Number(r.line_id), ...callSpan(r) }))
      .filter(c => c.start != null && ats.some(at => at >= c.start - VM_BEFORE_MS && at <= c.end + VM_AFTER_MS));
    if (!calls.length) return out;
    // Earlier / later voicemails that compete for these calls widen the window.
    const nlo = Math.min(lo, ...calls.map(c => c.start - VM_BEFORE_MS));
    const nhi = Math.max(hi, ...calls.map(c => c.end + VM_AFTER_MS));
    if (nlo === lo && nhi === hi) break;
    lo = nlo;
    hi = nhi;
  }
  // A call with a Quo voicemail of its own is not a candidate (whoever looks).
  const [own] = await db.query(
    `SELECT source_id FROM comms_media
      WHERE source_table = 'phone_event_log' AND source_id IN (?) AND kind = 'voicemail' AND state IN ('archived', 'purged')`,
    [calls.map(c => c.id)]);
  const taken = new Set(own.map(r => Number(r.source_id)));
  const byCall = new Map();
  for (const vm of vms) {
    const at = new Date(vm.captured_at).getTime();
    const fits = calls.filter(c => !taken.has(c.id) && !byCall.has(c.id)
      && (vm.channel_id == null ? c.provider === 'ringcentral' : Number(vm.channel_id) === c.line)
      && at >= c.start - VM_BEFORE_MS && at <= c.end + VM_AFTER_MS);
    let best = null;
    for (const c of fits) if (c.start <= at && (!best || c.start > best.start)) best = c;
    if (!best) for (const c of fits) if (!best || c.start < best.start) best = c;
    if (best) byCall.set(best.id, vm);
  }
  for (const c of spans) if (byCall.has(Number(c.id))) out.set(c.id, byCall.get(Number(c.id)));
  return out;
}

/**
 * Decorate one conversation page in place and return it.
 * @param {object} out    {other_party, messages:[…]} — items may carry line_id (All numbers)
 * @param {number} lineId the line of a per-line page (items without line_id)
 */
async function decorate(db, auth, out, { lineId = null } = {}) {
  const isAdmin = await admin.isArchiveAdmin(db, auth);
  out.archive_admin = isAdmin;
  const items = Array.isArray(out.messages) ? out.messages : [];
  if (!items.length) return out;
  const lineOf = (m) => Number(m.line_id != null ? m.line_id : lineId);

  const [rows] = await db.query(
    `SELECT ${MEDIA_COLS}
       FROM comms_media m LEFT JOIN users u ON u.user = m.purged_by
      WHERE m.source_table = 'phone_event_log' AND m.source_id IN (?) AND m.kind IN (?)
      ORDER BY m.id`,
    [items.map(m => m.id), CONTENT_KINDS]);
  const byItem = new Map();
  for (const r of rows) {
    const k = Number(r.source_id);
    if (!byItem.has(k)) byItem.set(k, []);
    byItem.get(k).push(r);
  }

  // A row is the item's only when it is on the item's line (enforced, not assumed).
  const mine = (r, m) => r.channel_id != null && Number(r.channel_id) === lineOf(m);
  const visible = (r) => isAdmin || Number(r.restricted) !== 1;
  // A Quo call's own voicemail row exists from the first tick (a pending
  // placeholder); only one with content (or a tombstone) is the call's
  // voicemail — chosen before visibility, so the choice never depends on the viewer.
  const ownVm = new Map();
  for (const m of items) {
    if (m.kind !== 'call') continue;
    const v = (byItem.get(Number(m.id)) || []).find(r => r.kind === 'voicemail' && mine(r, m) && (r.state === 'archived' || r.state === 'purged'));
    if (v) ownVm.set(m.id, v);
  }
  const calls = items.filter(m => m.kind === 'call');
  const rcVm = await matchRcVoicemails(db, out.other_party, calls);
  let bypass = null;
  const lineless = async () => { if (bypass == null) bypass = await admin.hasLineBypass(db, auth); return bypass; };

  const plan = [];
  for (const m of items) {
    const own = (byItem.get(Number(m.id)) || []).filter(r => mine(r, m) && visible(r));
    if (m.kind === 'call') {
      const recs = own.filter(r => r.kind === 'call_recording');
      let vm = ownVm.get(m.id) || rcVm.get(m.id) || null;
      if (vm && !visible(vm)) vm = null;
      if (vm && vm.channel_id == null && !(await lineless())) vm = null;
      plan.push({ m, recs, vm });
    } else {
      plan.push({ m, files: own.filter(r => r.kind === 'mms_file') });
    }
  }
  const archivedIds = [];
  const vmIds = [];
  for (const p of plan) {
    for (const r of p.recs || []) if (r.state === 'archived') archivedIds.push(Number(r.id));
    if (p.vm && p.vm.state === 'archived') { archivedIds.push(Number(p.vm.id)); vmIds.push(Number(p.vm.id)); }
  }
  const tx = await transcriptInfo(db, archivedIds);
  const txStatus = await transcriptStatus(db, archivedIds);
  const withStatus = (o) => {                       // only when there is no transcript; else the key stays absent
    const st = o.has_transcript ? null : txStatus.get(o.media_id);
    if (st) o.transcript_status = { ...st };
    return o;
  };
  const vendor = await vendorTranscripts(db, vmIds, isAdmin);

  for (const p of plan) {
    const { m } = p;
    if (m.kind === 'call') {
      const live = p.recs.filter(r => r.state === 'archived');
      if (live.length) {
        const t = tx.get(Number(live[0].id));
        m.archive = withStatus({
          media_id: Number(live[0].id),
          has_audio: true,
          has_transcript: !!(t && t.has),
          ...summaryFields(t),
          restricted: Number(live[0].restricted) === 1,
          extra: live.slice(1).map(r => Number(r.id)),
        });
      } else if (isAdmin) {
        const gone = p.recs.find(r => r.state === 'purged');
        if (gone) m.archive = tombstone(gone);
      }
      const vm = p.vm;
      if (vm && vm.state === 'archived') {
        const t = tx.get(Number(vm.id));
        m.voicemail = withStatus({
          media_id: Number(vm.id),
          provider: vm.provider,
          has_audio: true,
          has_transcript: !!(t && t.has) || vendor.has(Number(vm.id)),
          ...summaryFields(t),                                  // a voicemail's summary too (S3 summarises them)
          restricted: Number(vm.restricted) === 1,
        });
      } else if (vm && vm.state === 'purged' && isAdmin) {
        m.voicemail = tombstone(vm);
      }
    } else {
      const atts = [];
      let pending = 0;
      for (const r of p.files) {
        if (r.state === 'archived') {
          atts.push({
            media_id: Number(r.id),
            mime: r.mime || 'application/octet-stream',
            view: viewOf(r.mime),
            bytes: r.bytes == null ? null : Number(r.bytes),
            restricted: Number(r.restricted) === 1,
          });
        } else if (r.state === 'pending') {
          pending++;
        } else if (r.state === 'purged' && isAdmin) {
          atts.push(tombstone(r));
        }
      }
      if (atts.length) m.attachments = atts;
      if (pending) m.attachments_pending = pending;
    }
  }
  return out;
}

/**
 * S3 (design §7 P9): the comms_media ids whose AI summary a decorated thread
 * hands the viewer — the conversation routes write ONE batched view_summary
 * audit row per fetch that returned any (ids only, never content).
 */
function summaryMediaIds(out) {
  const ids = [];
  for (const m of (out && Array.isArray(out.messages) ? out.messages : [])) {
    for (const o of [m && m.archive, m && m.voicemail]) {
      // a summary, or a reader's note that guides one (S3c), handed to the viewer
      if (o && (o.summary_text != null || o.summary_note != null)) ids.push(Number(o.media_id));
    }
  }
  return [...new Set(ids)];
}

module.exports = { decorate, summaryMediaIds, viewOf, transcriptInfo, VENDOR_SQL, READABLE_STATES, VM_BEFORE_MS, VM_AFTER_MS };
