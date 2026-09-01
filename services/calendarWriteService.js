// services/calendarWriteService.js
//
/**
 * UNIFIED EVENTS U6b — the calendar write facade (v0.5 §3.4.2 / §7 U6b).
 *
 * One vocabulary — schedule / reschedule / cancel / resolve / findLive — over
 * BOTH storage tables. The registry routes: getType(type_key).kind==='meeting'
 * goes to apptService (the row is an appt, with everything that implies:
 * confirmations, reminder sequences, the provider calendar), everything else
 * goes to eventService. The caller — U7's court writer is the intended first
 * one; find_live_calendar_item exposes the read half to workflows today —
 * neither knows nor cares which table it landed in.
 *
 * WHAT THIS FILE IS NOT:
 *   - Not a transaction boundary. Each verb delegates to exactly one service
 *     call that owns its own transaction; the facade never opens one and
 *     never wraps two writes in one (the event-reschedule pair below is two
 *     service calls by DESIGN — see that function's comment).
 *   - Not a third implementation of anything. Anchor normalization, singleton
 *     policy, resolution vocabulary, envelopes — all live in the two services
 *     and are reached through their exports. The one vocabulary this file
 *     owns is the appt RESOLVE set ({'attended','no_show'}), because §3.7
 *     assigns those to the appt_status enum and eventService's frozen tables
 *     deliberately do not carry them.
 *   - Not imported BY either service (v0.5 §0.1: apptService and eventService
 *     must not import each other; this facade sits above both).
 *
 * Error contract: input errors carry err.status = 400; 'not found' carries
 * 404; service-level conflicts (supersede races) ride through with their own
 * .status (409). Everything else is the services' problem, verbatim.
 */

'use strict';

const apptService         = require('./apptService');
const eventService        = require('./eventService');
const calendarTypeService = require('./calendarTypeService');

// §3.7 — the meeting resolutions the appt_status enum encodes. eventService's
// _EVENT_RESOLUTIONS_COMPLETED.meeting is ['held'] (events-side meetings);
// the appt-side pair lives HERE because appts store it as status, not as a
// resolution column. Frozen, like its eventService counterparts.
const APPT_RESOLUTIONS = Object.freeze(['attended', 'no_show']);

function _err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Split a firm-local 'YYYY-MM-DD[ HH:mm[:ss]]' into { date, time }. */
function _splitStartsAt(startsAt, allDay) {
  const s = String(startsAt || '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?$/.exec(s);
  if (!m) throw _err(400, `calendarWriteService: invalid starts_at ${JSON.stringify(startsAt)} — expected 'YYYY-MM-DD HH:mm' (or a bare date for all-day)`);
  if (allDay) return { date: m[1], time: null };
  if (!m[2]) throw _err(400, `calendarWriteService: starts_at ${JSON.stringify(startsAt)} has no time and all_day is not set`);
  return { date: m[1], time: m[2].length === 5 ? `${m[2]}:00` : m[2] };
}

/** Registry row for a required type_key. Unknown/blank → 400. */
async function _requireType(db, typeKey) {
  const key = typeKey == null ? '' : String(typeKey).trim();
  if (!key) throw _err(400, 'calendarWriteService: type_key is required');
  let type = null;
  try { type = await calendarTypeService.getType(db, key); } catch (_) { type = null; }
  if (!type) throw _err(400, `calendarWriteService: unknown type_key ${JSON.stringify(key)}`);
  return type;
}

/** Normalize an anchor object. At least one of the three must be present. */
function _normAnchor(anchor = {}) {
  const caseId    = anchor.case_id    != null && String(anchor.case_id).trim()    !== '' ? String(anchor.case_id).trim()    : null;
  const contactId = anchor.contact_id != null && String(anchor.contact_id).trim() !== '' ? Number(anchor.contact_id)         : null;
  const docket    = anchor.docket     != null && String(anchor.docket).trim()     !== '' ? String(anchor.docket).trim()      : null;
  return { caseId, contactId, docket };
}

/** eventService link pair from an anchor (case wins, then docket, then contact). */
function _eventLink({ caseId, contactId, docket }) {
  if (caseId)    return { event_link_type: 'case',        event_link_id: caseId };
  if (docket)    return { event_link_type: 'case_number', event_link_id: docket };
  if (contactId) return { event_link_type: 'contact',     event_link_id: String(contactId) };
  return { event_link_type: null, event_link_id: null };
}

// ─────────────────────────────────────────────────────────────
// schedule
// ─────────────────────────────────────────────────────────────
/**
 * Create a calendar item of `type_key`, routed by the registry's kind.
 *
 * kind 'meeting' → apptService.createAppt:
 *   - length_min REQUIRED (appts have no all-day form; the column is NOT NULL
 *     in spirit — availability math depends on it) → 400 when absent
 *   - all_day rejected with 400 (a silently-timed "all day meeting" is a lie)
 *   - platform: opts.platform, default 'telephone' (the enum's plainest value)
 *   - the label written to appt_type is the REGISTRY label (canonical);
 *     type_key is passed explicitly so resolveForCreate honours it
 *   - anchor: case_id / docket / contact_id map straight onto createAppt's
 *     A3a params; contact_id doubles as the attendee (§3.6)
 *
 * anything else → eventService.createEvent with the equivalent field map.
 *
 * @returns {Promise<{source:'appt'|'event', id:number, superseded:number[], deduped?:boolean}>}
 *   `superseded` — priors the create tombstoned. Appt-side this is
 *   createAppt's own report. EVENT-SIDE IT IS ALWAYS [] FOR NOW: createEvent
 *   applies the singleton policy internally but discards _applySingleton's
 *   ids, and eventService is not editable in this slice — U7 surfaces them
 *   (one-line return change there).
 */
async function schedule(db, {
  type_key,
  anchor = {},
  starts_at,
  all_day      = false,
  length_min   = null,
  with_user_id = null,
  location     = null,
  url          = null,
  note         = null,
  title        = null,
  platform     = null,
  source_tag   = 'internal',
  actingUserId = 0,
} = {}) {
  const type = await _requireType(db, type_key);
  const a = _normAnchor(anchor);
  if (!a.caseId && !a.contactId && !a.docket) {
    throw _err(400, 'calendarWriteService.schedule: anchor requires case_id, docket, or contact_id');
  }
  if (!starts_at) throw _err(400, 'calendarWriteService.schedule: starts_at is required');

  if (String(type.kind) === 'meeting') {
    if (all_day) throw _err(400, `calendarWriteService.schedule: ${type.type_key} is a meeting — meetings are timed slots, all_day is not valid`);
    const len = Number(length_min);
    if (!len || Number.isNaN(len) || len <= 0) {
      throw _err(400, `calendarWriteService.schedule: ${type.type_key} is a meeting — length_min is required`);
    }
    const { date, time } = _splitStartsAt(starts_at, false);
    const r = await apptService.createAppt(db, {
      contact_id:    a.contactId,
      case_id:       a.caseId || '',
      docket:        a.caseId ? null : a.docket,
      appt_type:     String(type.label || type.type_key),
      type_key:      String(type.type_key),
      appt_length:   len,
      appt_platform: platform || 'telephone',
      appt_date:     `${date} ${time}`,
      appt_with:     with_user_id == null ? 1 : Number(with_user_id),
      note:          note || '',
      actingUserId,
      source:        source_tag,
    });
    return { source: 'appt', id: r.appt_id, superseded: r.superseded || [] };
  }

  const { date, time } = _splitStartsAt(starts_at, !!all_day);
  const link = _eventLink(a);
  const r = await eventService.createEvent(db, {
    event_type:      String(type.label || type.type_key),
    type_key:        String(type.type_key),
    ...link,
    event_title:     title != null && String(title).trim() !== '' ? String(title) : String(type.label || type.type_key),
    event_date:      date,
    event_time:      time,
    event_all_day:   all_day ? 1 : 0,
    event_length:    length_min == null ? null : Number(length_min),
    event_location:  location,
    event_link:      url,
    event_note:      note,
    event_with:      with_user_id,
    acting_user_id:  actingUserId,
    source:          source_tag,
  });
  // superseded: [] — see the JSDoc. NOT a claim that nothing was superseded;
  // a claim that createEvent does not report it yet.
  const out = { source: 'event', id: r.event_id, superseded: [] };
  if (r.deduped) out.deduped = true;
  return out;
}

// ─────────────────────────────────────────────────────────────
// reschedule
// ─────────────────────────────────────────────────────────────
/**
 * Move a live item to a new start. Successor-based on BOTH sides (v0.5 §3.4):
 *
 *   appt  → apptService.rescheduleAppt (tombstone + successor, one service
 *           call, its own transaction).
 *   event → getEvent(pred) → createEvent(successor: same type/anchor/fields,
 *           new start) → supersedeEvent(pred ← succ, reason 'rescheduled').
 *           TWO service calls, deliberately un-wrapped: supersedeEvent is
 *           guarded and idempotent-adjacent (a lost race 409s), and wrapping
 *           createEvent's transaction inside another would deadlock its
 *           GET_LOCK usage. A crash between the two leaves a duplicate LIVE
 *           pair — visible, and repairable with one supersedeEvent call —
 *           never a lost row.
 *
 * @returns {Promise<{source, id, superseded:number[]}>} id = successor
 */
async function reschedule(db, {
  source,
  id,
  starts_at,
  all_day      = null,      // event-side only; null = keep the predecessor's
  length_min   = null,      // event-side only; null = keep
  source_tag   = 'internal',
  actingUserId = 0,
} = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) throw _err(400, `calendarWriteService.reschedule: invalid id ${JSON.stringify(id)}`);
  if (!starts_at) throw _err(400, 'calendarWriteService.reschedule: starts_at is required');

  if (source === 'appt') {
    const { date, time } = _splitStartsAt(starts_at, false);
    const r = await apptService.rescheduleAppt(db, {
      appt_id:      rowId,
      newDate:      `${date} ${time}`,
      actingUserId,
      source:       source_tag,
    });
    return { source: 'appt', id: r.new_appt_id, superseded: [r.old_appt_id] };
  }
  if (source !== 'event') throw _err(400, `calendarWriteService.reschedule: source must be 'appt' or 'event', got ${JSON.stringify(source)}`);

  const pred = await eventService.getEvent(db, rowId);
  if (!pred) throw _err(404, `calendarWriteService.reschedule: event ${rowId} not found`);
  const succAllDay = all_day == null ? !!pred.event_all_day : !!all_day;
  const { date, time } = _splitStartsAt(starts_at, succAllDay);
  const succ = await eventService.createEvent(db, {
    event_type:      pred.event_type,
    type_key:        pred.type_key,
    event_link_type: pred.event_link_type,
    event_link_id:   pred.event_link_id,
    event_title:     pred.event_title,
    event_date:      date,
    event_time:      time,
    event_all_day:   succAllDay ? 1 : 0,
    event_length:    length_min == null ? pred.event_length : Number(length_min),
    event_location:  pred.event_location,
    event_link:      pred.event_link,
    event_note:      pred.event_note,
    event_calendar_id: pred.event_calendar_id,
    event_with:      pred.event_with,
    acting_user_id:  actingUserId,
    source:          source_tag,
  });
  await eventService.supersedeEvent(db, {
    predecessorId: rowId,
    successorId:   succ.event_id,
    reason:        'rescheduled',
    actingUserId,
    source:        source_tag,
  });
  return { source: 'event', id: succ.event_id, superseded: [rowId] };
}

// ─────────────────────────────────────────────────────────────
// cancel
// ─────────────────────────────────────────────────────────────
/**
 * Cancel a live item. `resolution` (optional) rides the §3.7 vocabulary:
 * events validate it through eventService (cancelEvent → _validateResolution
 * — 'cancelled' default, 'moot' on deadlines); appts validate it HERE via
 * the same frozen tables (meetings cancel as 'cancelled', full stop — the
 * appt_status enum is the storage, so nothing extra is written).
 */
async function cancel(db, {
  source,
  id,
  resolution   = undefined,
  delete_gcal  = true,
  note         = '',
  source_tag   = 'internal',
  actingUserId = 0,
} = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) throw _err(400, `calendarWriteService.cancel: invalid id ${JSON.stringify(id)}`);

  if (source === 'appt') {
    // Same validator, same tables, same error shape as an event meeting —
    // just nowhere to store the (only possible) value.
    eventService._validateResolution(resolution, 'Canceled', 'meeting', { prefix: 'calendarWriteService.cancel' });
    await apptService.cancelAppt(db, {
      appt_id:      rowId,
      note,
      cancel_gcal:  delete_gcal !== false,
      actingUserId,
      source:       source_tag,
    });
    return { source: 'appt', id: rowId };
  }
  if (source !== 'event') throw _err(400, `calendarWriteService.cancel: source must be 'appt' or 'event', got ${JSON.stringify(source)}`);

  await eventService.cancelEvent(db, rowId, actingUserId, {
    delete_gcal: delete_gcal !== false,
    source:      source_tag,
    resolution,
  });
  return { source: 'event', id: rowId };
}

// ─────────────────────────────────────────────────────────────
// resolve
// ─────────────────────────────────────────────────────────────
/**
 * The item happened. `resolution` REQUIRED on the appt side (there is no
 * default between attended and no_show, and guessing would write history):
 *
 *   appt:  'attended' → markAttended · 'no_show' → markNoShow · else 400
 *   event: eventService.completeEvent (its own §3.7 validation + defaults)
 */
async function resolve(db, {
  source,
  id,
  resolution   = undefined,
  note         = '',
  source_tag   = 'internal',
  actingUserId = 0,
} = {}) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || rowId <= 0) throw _err(400, `calendarWriteService.resolve: invalid id ${JSON.stringify(id)}`);

  if (source === 'appt') {
    const r = resolution == null ? '' : String(resolution).trim();
    if (!APPT_RESOLUTIONS.includes(r)) {
      throw _err(400, `calendarWriteService.resolve: appt resolution must be one of ${APPT_RESOLUTIONS.join(' | ')}, got ${JSON.stringify(resolution)}`);
    }
    if (r === 'attended') {
      await apptService.markAttended(db, { appt_id: rowId, note, actingUserId, source: source_tag });
    } else {
      await apptService.markNoShow(db, { appt_id: rowId, note, actingUserId, source: source_tag });
    }
    return { source: 'appt', id: rowId, resolution: r };
  }
  if (source !== 'event') throw _err(400, `calendarWriteService.resolve: source must be 'appt' or 'event', got ${JSON.stringify(source)}`);

  await eventService.completeEvent(db, rowId, actingUserId, { resolution, source: source_tag });
  return { source: 'event', id: rowId, resolution: resolution == null ? null : String(resolution) };
}

// ─────────────────────────────────────────────────────────────
// findLive
// ─────────────────────────────────────────────────────────────
/**
 * Live (Scheduled, un-superseded) rows for a singleton identity, across BOTH
 * tables — "does a live 341 already exist for this docket?" is U7's opening
 * question and this is its one answer.
 *
 * Identity semantics — the SERVICES' own, reached through their exports:
 *   events → eventService._singletonPriors over a synthetic row (event_id 0
 *            excludes nothing real): case anchors expand to the case + its
 *            dockets; unresolved dockets and contacts match by raw identity.
 *   appts  → apptService._singletonPriorAppts, which requires a RESOLVED
 *            case — a contact anchor or an unresolved docket matches no appts
 *            (the U6b appt-side rule; NOTE the deliberate asymmetry with the
 *            events side, which does raw-identity-match unresolved anchors).
 *
 * @returns {Promise<Array<{source:'appt'|'event', id:number, starts_at:string|null}>>}
 *          ordered events-then-appts, each ascending by id.
 */
async function findLive(db, { type_key, anchor = {} } = {}) {
  const type = await _requireType(db, type_key);
  const a = _normAnchor(anchor);
  if (!a.caseId && !a.contactId && !a.docket) {
    throw _err(400, 'calendarWriteService.findLive: anchor requires case_id, docket, or contact_id');
  }

  const link = _eventLink(a);
  const evRows = await eventService._singletonPriors(db, {
    event_link_type: link.event_link_type,
    event_link_id:   link.event_link_id,
    type_key:        String(type.type_key),
    event_id:        0,
  });

  // Appt side needs the resolved case + its dockets.
  let caseRow = null;
  if (a.caseId) {
    [[caseRow]] = await db.query(
      'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1',
      [a.caseId]
    );
  } else if (a.docket) {
    [[caseRow]] = await db.query(
      `SELECT case_id, case_number, case_number_full FROM cases
        WHERE case_number = ? OR case_number_full = ? LIMIT 1`,
      [a.docket, a.docket]
    );
  }
  let apRows = [];
  if (caseRow) {
    const dockets = [];
    for (const v of [caseRow.case_number, caseRow.case_number_full]) {
      const s = v != null ? String(v).trim() : '';
      if (s && !dockets.includes(s)) dockets.push(s);
    }
    apRows = await apptService._singletonPriorAppts(db, {
      caseId:  String(caseRow.case_id),
      dockets,
      typeKey: String(type.type_key),
    });
  }

  const out = [];
  for (const e of evRows) {
    const date = _dateOnly(e.event_date);
    const time = e.event_all_day ? null : _timeOnly(e.event_time);
    out.push({
      source: 'event',
      id: Number(e.event_id),
      starts_at: date ? (time ? `${date} ${time.slice(0, 5)}` : date) : null,
    });
  }
  for (const p of apRows) {
    const d = _naive(p.appt_date);
    out.push({ source: 'appt', id: Number(p.appt_id), starts_at: d ? d.slice(0, 16) : null });
  }
  return out;
}

// Naive date/time coercion — mysql2 hands back Date objects (server runs UTC,
// so toISOString reproduces the stored naive value); stubs and dateString
// configs hand back strings. Same convention as caseEventService's helpers.
function _naive(v) {
  if (v == null || v === '') return null;
  return (v instanceof Date ? v.toISOString().slice(0, 19) : String(v)).replace('T', ' ').slice(0, 19);
}
function _dateOnly(v) {
  const s = _naive(v);
  return s ? s.slice(0, 10) : null;
}
function _timeOnly(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(11, 19);
  const s = String(v);
  const m = /(\d{2}:\d{2}(?::\d{2})?)/.exec(s);
  return m ? (m[1].length === 5 ? `${m[1]}:00` : m[1]) : null;
}

module.exports = {
  schedule,
  reschedule,
  cancel,
  resolve,
  findLive,
  // frozen vocabulary (§3.7, appt encoding)
  _APPT_RESOLUTIONS: APPT_RESOLUTIONS,
};
