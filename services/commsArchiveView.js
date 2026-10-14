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
 *   call item  + archive:   {media_id, has_audio, has_transcript, summary_text, restricted, extra}
 *              + voicemail: {media_id, provider, has_audio, has_transcript, restricted}
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
 * visibility, so it never depends on the viewer. A voicemail with NO line
 * (channel_id NULL) matches on party + window alone and is shown only to the
 * SU / attorney bypass.
 *
 * TRANSCRIPTS. Restriction lives ONLY on comms_media (S2 keeps no restricted
 * column on comms_transcripts): transcripts are looked up only for media rows
 * this viewer was already shown. comms_transcripts is S2's table: until its migration runs the
 * read answers ER_NO_SUCH_TABLE and has_transcript is false (self-heals, any
 * deploy order). A voicemail also has a transcript when the phone provider's
 * own (an archived stt_raw child) exists — the secondary record (R10).
 * summary_text is S3's; null until then.
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
      `SELECT media_id, (segments IS NOT NULL OR full_text IS NOT NULL) AS has_text, summary_text
         FROM comms_transcripts WHERE media_id IN (?) AND state IN (?)`, [ids, READABLE_STATES]);
    for (const r of rows) {
      out.set(Number(r.media_id), { has: !!Number(r.has_text), summary: r.summary_text == null ? null : String(r.summary_text) });
    }
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

/**
 * RC voicemails for this page's incoming calls → Map(call item id → vm row).
 * The ASSIGNMENT never depends on the viewer (review A1): every archived or
 * purged voicemail takes part, whatever its restriction or line; who may SEE
 * the one a call got is decided afterwards. One voicemail → one call, one call
 * → one voicemail, voicemails in time order. A call is a candidate when it is
 * incoming, on the voicemail's line (any line for a line-less one), has no
 * voicemail of its own, and the voicemail falls in [start − 5 min, end + 30
 * min]. Of the candidates, the LATEST that started at or before the voicemail
 * wins (back-to-back calls each keep their own); the 5-minute lead is only a
 * fallback for a voicemail stamped a little before its call (the earliest such
 * call).
 */
async function matchRcVoicemails(db, party, calls, lineOf, taken) {
  const out = new Map();
  const cands = calls.filter(c => c.direction === 'incoming' && callStart(c) != null && !taken.has(c.id));
  if (!cands.length || !party) return out;
  const lo = Math.min(...cands.map(callStart)) - VM_BEFORE_MS;
  const hi = Math.max(...cands.map(callEnd)) + VM_AFTER_MS;
  const [vms] = await db.query(
    `SELECT ${MEDIA_COLS}
       FROM comms_media m LEFT JOIN users u ON u.user = m.purged_by
      WHERE m.party = ? AND m.captured_at BETWEEN ? AND ?
        AND m.kind = 'voicemail' AND m.source_table = 'rc_message' AND m.state IN ('archived', 'purged')
      ORDER BY m.captured_at, m.id`,
    [String(party), sqlUtc(lo), sqlUtc(hi)]);
  for (const vm of vms) {
    const at = new Date(vm.captured_at).getTime();
    const fits = cands.filter(c => !out.has(c.id)
      && (vm.channel_id == null || Number(vm.channel_id) === lineOf(c))
      && at >= callStart(c) - VM_BEFORE_MS && at <= callEnd(c) + VM_AFTER_MS);
    let best = null;
    for (const c of fits) if (callStart(c) <= at && (!best || callStart(c) > callStart(best))) best = c;
    if (!best) for (const c of fits) if (!best || callStart(c) < callStart(best)) best = c;
    if (best) out.set(best.id, vm);
  }
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
  const rcVm = await matchRcVoicemails(db, out.other_party, calls, lineOf, new Set(ownVm.keys()));
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
  const vendor = await vendorTranscripts(db, vmIds, isAdmin);

  for (const p of plan) {
    const { m } = p;
    if (m.kind === 'call') {
      const live = p.recs.filter(r => r.state === 'archived');
      if (live.length) {
        const t = tx.get(Number(live[0].id));
        m.archive = {
          media_id: Number(live[0].id),
          has_audio: true,
          has_transcript: !!(t && t.has),
          summary_text: t ? t.summary : null,
          restricted: Number(live[0].restricted) === 1,
          extra: live.slice(1).map(r => Number(r.id)),
        };
      } else if (isAdmin) {
        const gone = p.recs.find(r => r.state === 'purged');
        if (gone) m.archive = tombstone(gone);
      }
      const vm = p.vm;
      if (vm && vm.state === 'archived') {
        const t = tx.get(Number(vm.id));
        m.voicemail = {
          media_id: Number(vm.id),
          provider: vm.provider,
          has_audio: true,
          has_transcript: !!(t && t.has) || vendor.has(Number(vm.id)),
          restricted: Number(vm.restricted) === 1,
        };
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

module.exports = { decorate, viewOf, transcriptInfo, VENDOR_SQL, READABLE_STATES, VM_BEFORE_MS, VM_AFTER_MS };
