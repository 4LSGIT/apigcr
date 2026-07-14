// services/eventService.js
//
/**
 * Event Service
 * services/eventService.js
 *
 * All event business logic. Routes are thin wrappers that call these
 * functions. Internal functions, sequences, and workflows can also call
 * them directly.
 *
 * An "event" is a first-class dated case/contact obligation — a confirmation
 * hearing, a docs deadline, an internal milestone. It is DISTINCT from:
 *   - appts  = a meeting WITH a person (attendee, platform, attendance lifecycle)
 *   - tasks  = a single user's to-do (assignee, due date, digest)
 * An event is a fact on a timeline. It goes on Google Calendar, links to a
 * case OR a contact OR a DOCKET (case_number) OR nothing (internal), and may
 * optionally spawn ONE reminder task.
 *
 * event_link_type='case_number': event_link_id holds the docket string
 * VERBATIM (opaque free text — equality match only, never parsed/validated,
 * never trimmed beyond whitespace). Used when a court email carries a docket
 * before any internal case exists. Resolution to a case is QUERY-SIDE and
 * self-healing: the row is never rewritten to 'case'; instead reads resolve
 * the docket against cases.case_number / cases.case_number_full via a
 * correlated subquery (LIMIT 1 — case_number is NOT unique-constrained, so a
 * JOIN would fan out rows if two cases ever shared a docket).
 *
 * This service mirrors apptService's conventions:
 *   - Core writes happen synchronously; calendar work and reminder spawning
 *     are POST-COMMIT, NON-BLOCKING (fire-and-forget, never throw out).
 *   - GCal failures alert IT (throttled) and are swallowed — a calendar
 *     failure must never block or roll back an event write.
 *   - On a "reschedule" (date/time change) the calendar event is
 *     delete-then-recreated, matching the proven appt reschedule pattern and
 *     avoiding all-day<->timed PATCH edge cases.
 *
 * Invariants (enforced on every write):
 *   - event_all_day = 1  <=>  event_time IS NULL
 *   - event_length applies to timed events only (ignored for all-day)
 *
 * Usage:
 *   const eventService = require('../services/eventService');
 *   const { event_id, event } = await eventService.createEvent(db, { ... });
 */

const gcal         = require('./gcalService');
const taskService  = require('./taskService');
const logService   = require('./logService');
const emailService = require('./emailService');
const { FIRM_TZ }  = require('./timezoneService');
const { DateTime } = require('luxon');

// ─────────────────────────────────────────────────────────────
// GOOGLE CALENDAR INTEGRATION
//
// Mirrors apptService: gcalService returns the event resource synchronously
// and THIS service owns the event_gcal write. All calendar work is
// fire-and-forget (post-commit) — a calendar failure emails IT (throttled)
// but never blocks or rolls back an event write.
// ─────────────────────────────────────────────────────────────

// In-memory throttle so a burst of calendar failures can't bury IT in email.
// 1 hour per failure-kind. Process-local — acceptable for a low-volume alert.
const GCAL_ALERT_THROTTLE_MS = 60 * 60 * 1000;
const _lastGcalAlertAt = new Map();

/**
 * Email IT about a calendar failure, throttled per `kind`. Never throws.
 * Mirrors apptService.alertGcalFailure.
 */
function alertGcalFailure(db, kind, detail) {
  const now = Date.now();
  if ((now - (_lastGcalAlertAt.get(kind) || 0)) < GCAL_ALERT_THROTTLE_MS) return;
  _lastGcalAlertAt.set(kind, now);

  const to   = process.env.IT_EMAIL;
  const from = process.env.AUTO_EMAIL;
  if (!to || !from) {
    console.warn('[EVENT SERVICE] IT_EMAIL or AUTO_EMAIL not set; gcal alert skipped');
    return;
  }

  emailService.sendEmail(db, {
    from,
    to,
    subject: `[YisraCase] Google Calendar sync failed (event): ${kind}`,
    text:
      `A Google Calendar operation failed in eventService.\n\n` +
      `Operation:    ${kind}\n` +
      `Environment:  ${process.env.ENVIRONMENT || 'unknown'}\n` +
      `Time:         ${new Date().toISOString()}\n` +
      `Detail:       ${detail}\n\n` +
      `The event record itself is unaffected — only the calendar event did ` +
      `not sync. Check the connection (Connections → Google) and the ` +
      `credential's allowed_urls if this repeats.\n\n` +
      `Throttled to once per hour per operation type.`,
  }).catch(e => console.error('[EVENT SERVICE] gcal alert email failed:', e.message));
}

/**
 * Delete a calendar event by ID. Fire-and-forget — never throws. Treats
 * Google's 410 (already gone) as success. Mirrors apptService.
 */
async function deleteEventCalendarEvent(db, eventId, calendarId, contextLabel) {
  if (!eventId) return;
  try {
    await gcal.deleteEvent(db, {
      eventId,
      ...(calendarId && calendarId !== 'none' && { calendarId }),
    });
  } catch (err) {
    if (/→\s410:/.test(err.message)) {
      console.warn(`[EVENT SERVICE] GCal delete (${contextLabel}) — event ${eventId} already gone`);
      return;
    }
    console.error(`[EVENT SERVICE] GCal delete (${contextLabel}) failed:`, err.message);
    alertGcalFailure(db, 'delete', `${contextLabel} event=${eventId}: ${err.message}`);
  }
}


// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Format a DATE value (Date or string) as 'YYYY-MM-DD'.
 * mysql2 reads a DATE column as a Date labeled UTC; slicing the ISO form
 * preserves the calendar date exactly as stored.
 */
function _dateOnly(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/**
 * Format a TIME value (string 'HH:MM:SS' or Date) as 'HH:MM:SS'.
 */
function _timeOnly(t) {
  if (t == null || t === '') return null;
  const s = String(t);
  // mysql2 returns TIME as a string 'HH:MM:SS'. Accept 'HH:MM' too.
  const m = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  return m[1].length === 5 ? `${m[1]}:00` : m[1];
}

// ─────────────────────────────────────────────────────────────
// LINK TYPES
// ─────────────────────────────────────────────────────────────

/**
 * Valid event_link_type values (mirrors the events.event_link_type ENUM).
 * Enforced on write because the session sql_mode lacks STRICT_TRANS_TABLES —
 * an invalid enum value would otherwise be stored as '' silently.
 */
const EVENT_LINK_TYPES = new Set(['case', 'contact', 'case_number']);

/**
 * Normalize an (event_link_type, event_link_id) pair for a write, or throw.
 *   - no/empty link_type        → { type:null, id:null }
 *   - unknown link_type         → throw (enum-safe)
 *   - link_type w/o non-empty id → throw
 * event_link_id is OPAQUE for every type: String(...).trim() only — never
 * shape-checked (dockets included).
 */
function _normalizeLink(event_link_type, event_link_id) {
  if (event_link_type == null || event_link_type === '') {
    return { type: null, id: null };
  }
  if (!EVENT_LINK_TYPES.has(event_link_type)) {
    throw new Error(`Invalid event_link_type "${event_link_type}" — use case, contact, or case_number`);
  }
  const id = event_link_id != null ? String(event_link_id).trim() : '';
  if (!id) throw new Error(`event_link_id is required when event_link_type is "${event_link_type}"`);
  return { type: event_link_type, id };
}

/**
 * SQL fragment: resolve a 'case_number' row's docket to a case_id.
 * Correlated subquery with LIMIT 1 — deliberately NOT a JOIN, because
 * case_number is not unique-constrained and a JOIN would fan out rows if two
 * cases ever shared a docket. Matches BOTH docket columns (both indexed:
 * idx_cases_case_number, idx_cases_case_number_full). Requires the events
 * table to be aliased `e`. NULL for non-case_number rows and unresolved dockets.
 */
const RESOLVED_CASE_SUBQUERY =
  `(SELECT c.case_id FROM cases c
     WHERE e.event_link_type = 'case_number'
       AND (c.case_number = e.event_link_id OR c.case_number_full = e.event_link_id)
     LIMIT 1) AS resolved_case_id`;


// ─────────────────────────────────────────────────────────────
// TITLE MATCHING  (Slice 4 Phase B — moved here from courtExecutor)
//
// SINGLE SOURCE OF TRUTH. courtExecutor imports these; there is no second
// copy. The rules below are unchanged from courtExecutor's originals EXCEPT
// for one addition: an optional `identityTokens` set that is stripped from the
// title cores before comparison (see IDENTITY TOKENS below). Called WITHOUT
// identityTokens, every function here behaves byte-identically to the version
// that shipped in courtExecutor — courtExecutor's update_event title
// disambiguator relies on that.
//
// Two FUTURE hearings on one case can share the generic event_type "Hearing"
// (live: case 21-50019 has a Plan-Modification hearing AND a Trustee Motion-to-
// Dismiss hearing, both type "Hearing"). titlesMatch decides whether two event
// titles name the SAME hearing, AFTER stripping the generic scaffolding
// ("hearing on the ... chapter 13 ...") down to a distinguishing core.
//
// CHOSEN RULE — biased toward FALSE. A false "no match" creates a new event and
// FLAGS for a human (safe; the operator reconciles); a false "match" silently
// merges/reschedules the WRONG hearing (the bug we are killing). So:
//   - normalize: lowercase, non-alphanumerics → spaces, collapse, tokenize.
//   - drop generic filler tokens (incl. the tokens of "post-confirmation", and
//     "&" which normalization erases), any length-1 token (possessive "s"), and
//     any identity token supplied by the caller.
//   - both cores EMPTY     → TRUE  (both fully generic, e.g. "Hearing" vs
//                                   "Confirmation Hearing").
//   - exactly ONE empty    → FALSE (one side carries a distinguishing core the
//                                   other lacks — cannot confirm same hearing).
//   - both non-empty       → TRUE iff the smaller core ⊆ the larger, OR
//                                   Jaccard(cores) ≥ 0.5.
// "confirmation" is filler because the spec's filler list carries
// "post-confirmation"; "Confirmation Hearing" therefore reduces to an empty core
// and is matched via the both-empty rule, not by a shared significant token.
// ─────────────────────────────────────────────────────────────

const TITLE_FILLER = new Set([
  'hearing', 'on', 'the', 'of', 'a', 'to', 'in', 'at', 'for', 'and',
  'case', 'with', 're', 'notice', 'court', 'courtroom', 'ch', 'chapter',
  'post', 'confirmation', '7', '13',
]);

/**
 * Split any string into lowercase alphanumeric tokens of length > 1.
 * The one tokenizer used by _titleCore AND buildIdentityTokens, so a docket
 * ("26-46639-mar") and a title ("… (26-46639)") tokenize identically and
 * therefore cancel.
 */
function _tokenize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * IDENTITY TOKENS — the LOCKED fix that makes title similarity usable once
 * event_type is dropped from the duplicate key.
 *
 * wf24/wf25 embed the debtor name AND the docket in every title
 * ("Proofs of Claims Due — Marquita Renea Smith (26-47542)"). Those tokens are
 * IDENTICAL across every event on the case, so they inflate the shared-token
 * count and drive Jaccard over the 0.5 threshold for events that are NOT the
 * same obligation. Worked counter-example (Phase A):
 *
 *   poc_due     core = {proofs, claims, due, marquita, renea, smith, 26, 47542}
 *   poc_gov_due core = {government, poc, due, marquita, renea, smith, 26, 47542}
 *   inter = 6, union = 10  →  Jaccard 0.6  →  FALSE MATCH.
 *
 * Strip the case's identity tokens first and the same pair becomes
 * {proofs, claims, due} vs {government, poc, due} → Jaccard 0.2 → correctly
 * rejected, while "Confirmation Hearing — X (26-47542)" vs
 * "Confirmation Hearing - X" both collapse to the empty core → correctly
 * matched by the both-empty rule.
 *
 * @param {Array<string|null|undefined>} parts  case_number, case_number_full,
 *        primary contact name (any nullish/blank entries are ignored)
 * @returns {Set<string>}
 */
function buildIdentityTokens(parts = []) {
  const out = new Set();
  for (const p of (Array.isArray(parts) ? parts : [parts])) {
    if (p == null || p === '') continue;
    for (const t of _tokenize(p)) out.add(t);
  }
  return out;
}

/**
 * title → Set of significant (non-filler, non-identity, len>1) lowercase tokens.
 * @param {string} title
 * @param {Set<string>} [identityTokens]  case identity tokens to strip (see above)
 */
function _titleCore(title, identityTokens) {
  const strip = identityTokens instanceof Set ? identityTokens : null;
  return new Set(
    _tokenize(title).filter(
      (t) => !TITLE_FILLER.has(t) && !(strip && strip.has(t))
    )
  );
}

/**
 * True iff existingTitle and newTitle name the same hearing (see rule above).
 * @param {string} existingTitle
 * @param {string} newTitle
 * @param {Set<string>} [identityTokens]
 */
function titlesMatch(existingTitle, newTitle, identityTokens) {
  const a = _titleCore(existingTitle, identityTokens);
  const b = _titleCore(newTitle, identityTokens);
  if (a.size === 0 && b.size === 0) return true;   // both generic
  if (a.size === 0 || b.size === 0) return false;  // one distinguishing, one not
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  if (inter === small.size) return true;           // smaller ⊆ larger
  const union = a.size + b.size - inter;
  return union > 0 && inter / union >= 0.5;        // Jaccard ≥ 0.5
}

/** normalize a title for loose comparison: lowercase, non-alnum→space, collapse. */
function _titleNorm(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * LOOSE title similarity, used ONLY behind a same-DATE+TIME slot gate (every
 * caller confirms date+time are already equal before consulting this).
 * Deliberately more lenient than titlesMatch — which stays the strict
 * disambiguator for the no-slot case: true iff one normalized title contains
 * the other, OR titlesMatch holds.
 *
 * Empty-after-normalize never matches (an empty string is a substring of
 * anything, which would collapse unrelated events). Because a slot match
 * requires date+time to be identical, this can only ever fold a re-notice the
 * model (or a second pipeline) re-titled — two genuinely different same-slot
 * deadlines carry different words and are NOT similar, so they both survive.
 *
 * @param {string} a
 * @param {string} b
 * @param {Set<string>} [identityTokens]  passed through to titlesMatch
 */
function titlesSimilarLoose(a, b, identityTokens) {
  const na = _titleNorm(a), nb = _titleNorm(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  return titlesMatch(a, b, identityTokens);
}


// ─────────────────────────────────────────────────────────────
// INPUT NORMALIZATION (dates & times)
//
// The session sql_mode lacks STRICT_TRANS_TABLES, so malformed input reaching
// MySQL is stored as silent garbage instead of erroring:
//   '9/9/2024'  → DATE 0000-00-00   (Y/M/D parse → invalid)
//   '4:00 PM'   → TIME 04:00:00     (suffix truncated: 12h early!)
//   '2024-09-09 10:00:00' in event_date → time dropped → all-day event
// These helpers normalize accepted formats and THROW on anything else, so bad
// input fails the request (or the batch item) loudly.
// Accepted:  date 'YYYY-MM-DD' | 'M/D/YYYY' (MIEB court format)
//            time 'H:MM[:SS]' 24h | 'h:MM[:SS] AM/PM'
//            combined (in event_date): '<date> <time>' or '<date>T<time>'
// Timezone suffixes (Z, +HH:MM) are rejected — times are firm-local.
//
// FOLLOW-UP: apptService writes dates/times the same way and has the identical
// silent-garbage exposure (sql_mode lacks STRICT_TRANS_TABLES). Consider
// hoisting these helpers into a shared util and reusing them there.
// ─────────────────────────────────────────────────────────────

/** Validate calendar reality (rejects 2/30, 13/5, etc.). */
function _isRealDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Normalize a date-only input to 'YYYY-MM-DD', or throw. */
function _normalizeEventDate(input, label = 'event_date') {
  if (input instanceof Date && !isNaN(input)) return input.toISOString().slice(0, 10);
  const s = String(input ?? '').trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    if (_isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) return s;
    throw new Error(`Invalid ${label} "${input}" — not a real calendar date`);
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);          // M/D/YYYY (MIEB)
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]), y = Number(m[3]);
    if (_isRealDate(y, mo, d))
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    throw new Error(`Invalid ${label} "${input}" — not a real calendar date`);
  }
  throw new Error(`Invalid ${label} "${input}" — use YYYY-MM-DD or M/D/YYYY`);
}

/** Normalize a time input to 'HH:MM:SS', or throw. null/'' → null. */
function _normalizeEventTime(input, label = 'event_time') {
  if (input == null || input === '') return null;
  const s = String(input).trim();

  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(s))
    throw new Error(`Invalid ${label} "${input}" — timezone suffixes not supported; provide firm-local time`);

  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?$/);   // 12h
  if (m) {
    let h = Number(m[1]);
    const mm = Number(m[2]), ss = Number(m[3] || 0), pm = /p/i.test(m[4]);
    if (h < 1 || h > 12 || mm > 59 || ss > 59) throw new Error(`Invalid ${label} "${input}"`);
    if (h === 12) h = pm ? 12 : 0;            // 12 PM = noon, 12 AM = midnight
    else if (pm) h += 12;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);                               // 24h
  if (m) {
    const h = Number(m[1]), mm = Number(m[2]), ss = Number(m[3] || 0);
    if (h > 23 || mm > 59 || ss > 59) throw new Error(`Invalid ${label} "${input}"`);
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  throw new Error(`Invalid ${label} "${input}" — use HH:MM[:SS] (24h) or h:mm AM/PM`);
}

/**
 * Normalize the (event_date, event_time) input pair, or throw.
 * event_date may carry a combined datetime ('<date> <time>' or '<date>T<time>');
 * its time part populates event_time. Supplying a time BOTH ways is an error.
 */
function _normalizeEventDateTime({ event_date, event_time }) {
  const timeProvided = event_time != null && event_time !== '';
  let date = event_date;
  let time = timeProvided ? _normalizeEventTime(event_time)
                          : (event_time === '' ? null : event_time);

  if (date != null && !(date instanceof Date)) {
    const parts = String(date).trim().split(/[T\s]+/);
    if (parts.length > 1) {                              // combined datetime
      if (timeProvided)
        throw new Error(`event_date "${event_date}" contains a time and event_time was also provided — supply the time once`);
      return {
        event_date: _normalizeEventDate(parts[0]),
        event_time: _normalizeEventTime(parts.slice(1).join(' ')),  // rejoins '10:00 AM'
      };
    }
  }
  if (date != null) date = _normalizeEventDate(date);
  return { event_date: date, event_time: time };
}

/**
 * Apply the all_day/time consistency invariant to a normalized field set.
 * Rules:
 *   - all_day explicitly 1  → time forced null, all_day = 1
 *   - all_day explicitly 0  → all_day = 0 (time kept as given; may be null)
 *   - all_day not given:
 *       time present        → all_day = 0
 *       time absent          → all_day = 1
 * Returns { event_all_day, event_time }.
 */
function _normalizeAllDay({ event_all_day, event_time }) {
  let allDay;
  let time = (event_time === '' ? null : event_time);

  const allDayGiven = event_all_day !== undefined && event_all_day !== null;

  if (allDayGiven) {
    allDay = (event_all_day === 1 || event_all_day === '1' || event_all_day === true) ? 1 : 0;
  } else {
    allDay = (time == null) ? 1 : 0;
  }

  if (allDay === 1) time = null;
  return { event_all_day: allDay, event_time: time };
}

/**
 * Normalize/validate event_with for a write, or throw.
 *
 * event_with scopes which provider's booking availability a timed event
 * blocks: NULL = blocks ALL providers (firm-wide, the historic default);
 * a provider id = blocks ONLY that provider; 0 = blocks NOBODY (a timed
 * event that should not carve any calendar — 0 is the automation user,
 * which can never be a bookable provider, and the availability engine's
 * filters `event_with IS NULL OR event_with IN (providerIds)` /
 * `event_with !== pid` naturally exclude it with no engine change).
 * Consumed by availabilityService's normalizeBusyForProvider — semantics
 * defined there, not here.
 *
 *   - null / '' / undefined → null (firm-wide)
 *   - 0                     → 0 (blocks nobody)
 *   - positive integer      → must be a users.user with does_appts = 1
 *                             (a non-provider id would be a silent no-op
 *                             for every provider — reject loudly instead)
 *   - anything else         → throw
 *
 * @param {object} db
 * @param {*} v
 * @returns {Promise<number|null>}
 */
async function _normalizeEventWith(db, v) {
  if (v === undefined || v === null || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('event_with must be a provider user id, 0 (blocks nobody), or null (blocks everyone)');
  }
  if (id === 0) return 0; // sentinel: blocks NOBODY
  const [[row]] = await db.query(
    'SELECT user FROM users WHERE user = ? AND does_appts = 1 LIMIT 1', [id]
  );
  if (!row) {
    throw new Error(`event_with ${id} is not an appointment provider (users.does_appts = 1)`);
  }
  return id;
}

/**
 * Compose the calendar start/end objects for an event row.
 * Exported for testing.
 *
 *   all-day:  start = { date: 'YYYY-MM-DD' }
 *             end   = { date: 'YYYY-MM-DD' + 1 day }   // GCal end.date is EXCLUSIVE
 *   timed:    start = 'YYYY-MM-DDTHH:MM:SS'            // gcalService applies FIRM_TZ
 *             end   = start + (event_length || 60) minutes, same naive-local form
 *
 * @param {object} event - an events row (post-normalization, or DB row)
 * @returns {{ start: any, end: any }}
 */
function _gcalTimes(event) {
  const dateStr = _dateOnly(event.event_date);
  const isAllDay =
    event.event_all_day === 1 || event.event_all_day === '1' || event.event_all_day === true ||
    (event.event_all_day == null && (event.event_time == null || event.event_time === ''));

  if (isAllDay) {
    const startDt = DateTime.fromISO(dateStr, { zone: FIRM_TZ });
    const endDt   = startDt.plus({ days: 1 });
    return {
      start: { date: startDt.toFormat('yyyy-MM-dd') },
      end:   { date: endDt.toFormat('yyyy-MM-dd') },
    };
  }

  const timeStr = _timeOnly(event.event_time) || '00:00:00';
  const local   = `${dateStr}T${timeStr}`;
  const lenMin  = Number(event.event_length) > 0 ? Number(event.event_length) : 60;
  const startDt = DateTime.fromISO(local, { zone: FIRM_TZ });
  const endStr  = startDt.isValid
    ? startDt.plus({ minutes: lenMin }).toFormat("yyyy-MM-dd'T'HH:mm:ss")
    : local;

  return { start: local, end: endStr };
}

/**
 * Build the calendar event resource (summary/description/location) for an event.
 * Kept in one place so the event text is easy to tune.
 */
function _buildEventResource(event) {
  const summary = event.event_title || 'Event';

  const descLines = [];
  if (event.event_type)  descLines.push(`Type: ${event.event_type}`);
  if (event.event_note)  descLines.push(event.event_note);
  if (event.event_link)  descLines.push(event.event_link);

  return {
    summary,
    ...(descLines.length && { description: descLines.join('\n') }),
    ...(event.event_location && { location: event.event_location }),
  };
}

/**
 * Decide whether an event should sync to the calendar at all.
 * v1: every event goes on the calendar UNLESS event_calendar_id is the
 * literal 'none', or skip_gcal is explicitly set.
 */
function _shouldSyncGcal(event, { skip_gcal = false } = {}) {
  if (skip_gcal) return false;
  if (event.event_calendar_id === 'none') return false;
  return true;
}

/**
 * Create the calendar event for an event row and write event_gcal back.
 * Fire-and-forget — never throws.
 */
async function syncEventToCalendar(db, event, { skip_gcal = false } = {}) {
  if (!_shouldSyncGcal(event, { skip_gcal })) return;
  try {
    const { start, end } = _gcalTimes(event);
    const resource = _buildEventResource(event);

    const created = await gcal.createEvent(db, {
      ...resource,
      start,
      end,
      // event_calendar_id 'none' is handled by _shouldSyncGcal above; any other
      // truthy value is a real override. NULL/empty → undefined → service default.
      ...(event.event_calendar_id && { calendarId: event.event_calendar_id }),
    });

    await db.query(
      'UPDATE events SET event_gcal = ? WHERE event_id = ?',
      [created.id, event.event_id]
    );
  } catch (err) {
    console.error(`[EVENT SERVICE] GCal create (event ${event.event_id}) failed:`, err.message);
    alertGcalFailure(db, 'create', `event_id=${event.event_id}: ${err.message}`);
  }
}

/**
 * Insert a log entry tied to an event row.
 *
 * Mirrors apptService.insertApptLog: delegates to logService.createLogEntry
 * for proper JSON.stringify of log_data and correct population of
 * log_link_type / log_link_id.
 *
 * Link mapping:
 *   event_link_type 'case'        → log link_type 'case',    link_id = event_link_id
 *   event_link_type 'contact'     → log link_type 'contact', link_id = event_link_id
 *   event_link_type 'case_number' → log link_type 'case',    link_id = the DOCKET
 *       (the log enum has NO 'case_number' value, on purpose — this is the
 *        log system's existing court-email convention: log_link_type='case'
 *        with the docket string in log_link_id. The log reader's case-scope
 *        expansion already matches docket strings, so these rows surface on
 *        the case exactly like court emails do.)
 *   unlinked (both NULL)          → log_link_type/id NULL (allowed)
 *
 * @param {object} db
 * @param {object} event       - an events row (must include id/type/date/link cols)
 * @param {number} actingUserId
 * @param {string} action      - 'created' | 'updated' | 'completed' | 'canceled'
 * @param {object} [extra]     - additional key/value pairs merged into log_data
 */
async function insertEventLog(db, event, actingUserId, action, extra = {}) {
  const data = {
    action,
    event_id:    event.event_id,
    event_title: event.event_title || '',
    ...(event.event_type ? { event_type: event.event_type } : {}),
    ...(event.event_date ? { event_date: _dateOnly(event.event_date) } : {}),
    ...extra,
  };

  let linkType = null;
  let linkId   = null;
  if (event.event_link_type && event.event_link_id != null && event.event_link_id !== '') {
    if (event.event_link_type === 'case_number') {
      linkType = 'case';                  // court-email convention (see JSDoc)
      linkId   = event.event_link_id;     // the docket, verbatim
    } else {
      linkType = event.event_link_type;   // 'case' | 'contact'
      linkId   = event.event_link_id;
    }
  }

  await logService.createLogEntry(db, {
    type:      'event',
    link_type: linkType,
    link_id:   linkId,
    by:        actingUserId || 0,
    data,   // createLogEntry handles JSON.stringify internally
  });
}


// ─────────────────────────────────────────────────────────────
// REMINDER TASKS
//
// A reminder is a normal task with task_link_type='event' and
// task_link_id=String(event_id). Created via taskService.createTask (which
// also schedules the 8 AM due-date reminder job when `due` is set). On
// complete/cancel we find active reminder tasks for the event and delete
// each via taskService.deleteTask — chosen over a bare status flip because
// deleteTask ALSO calls cancelDueReminder, which kills the scheduled job.
// ─────────────────────────────────────────────────────────────

/**
 * Spawn a single reminder task for an event. Non-blocking semantics are the
 * caller's responsibility (this awaits, but callers wrap it). Returns the new
 * task_id or null.
 *
 * @param {object} db
 * @param {object} event   - the event row (for default title)
 * @param {object} reminder - { to, date, title? }
 * @param {number} actingUserId
 */
async function spawnReminderTask(db, event, reminder, actingUserId = 0) {
  if (!reminder || !reminder.to) {
    console.warn(`[EVENT SERVICE] spawnReminderTask: missing reminder.to for event ${event.event_id}`);
    return null;
  }
  // tasks.task_title is varchar(100) and createTask now THROWS on overlong
  // titles (it used to truncate silently — sql_mode is not strict).
  //
  // This title is MACHINE-derived from event_title (varchar(200)) — up to 210
  // chars before clamping — and there is no author to see the error: BOTH call
  // sites swallow throws (createEvent:900 `.catch()`, updateEvent:1094
  // try/catch). An overlong title would therefore produce NO reminder task at
  // all, only a console.error. For a bankruptcy deadline that is unacceptable.
  //
  // Clamp where nobody is watching; throw where there IS an author to see it
  // (create_task fails a visible workflow step; POST /api/tasks 500s to a human).
  // Covers BOTH branches: reminder.title is free-text from automation/UI config
  // and is equally unbounded.
  const rawTitle = (reminder.title && String(reminder.title).trim())
    || `Reminder: ${event.event_title}`;
  const title = rawTitle.length > 100 ? rawTitle.slice(0, 99) + '…' : rawTitle;

  // ── PAST-DUE GUARD (Slice 4 Phase B) ────────────────────────────────────
  // A reminder whose due date has already passed is not a reminder — it is an
  // Overdue task the moment it is born. Live proof: task 1047 ("Reminder: Docs
  // due to trustee - 24-46274-mlo …") was created with due 2024-07-22 and has
  // sat Overdue in someone's queue ever since — 722 days at the time of
  // writing. It came from an automation replaying an old event.
  //
  // Throwing is NOT an option: BOTH call sites swallow (createEvent's
  // `.catch()`, updateEvent's try/catch), so a throw would be invisible. The
  // failure mode we are killing is a *silently created* dead task, so the fix
  // is to refuse quietly-but-loudly: warn with the event id + date, return
  // null, create nothing. The event itself is unaffected.
  //
  // Date-only comparison in FIRM_TZ (same convention as sendEventDigest).
  // 'YYYY-MM-DD' strings compare lexicographically == chronologically.
  if (reminder.date != null && reminder.date !== '') {
    let dueStr;
    try {
      dueStr = _normalizeEventDate(reminder.date, 'reminder.date');
    } catch (_) {
      dueStr = _dateOnly(reminder.date) || null;   // best effort; guard, don't throw
    }
    const todayStr = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd');
    if (dueStr && dueStr < todayStr) {
      console.warn(
        `[EVENT SERVICE] spawnReminderTask: REFUSING past-due reminder for event ` +
        `${event.event_id} — due ${dueStr} is before today (${todayStr}, ${FIRM_TZ}). ` +
        `No task created.`
      );
      return null;
    }
  }

  const result = await taskService.createTask(db, {
    from:      actingUserId || 0,   // automation (no acting user) → automations user (0)
    to:        reminder.to,
    title,
    desc:      '',
    due:       reminder.date || null,
    link_type: 'event',
    link_id:   String(event.event_id),
  });
  return result.task_id;
}

/**
 * Find active (not Completed/Deleted) reminder tasks for an event.
 */
async function _activeReminderTaskIds(db, eventId) {
  const [rows] = await db.query(
    `SELECT task_id FROM tasks
      WHERE task_link_type = 'event' AND task_link_id = ?
        AND task_status NOT IN ('Completed', 'Deleted')`,
    [String(eventId)]
  );
  return rows.map(r => r.task_id);
}

/**
 * Cancel (soft-delete) all active reminder tasks for an event. Each
 * deleteTask call also cancels that task's scheduled due-reminder job.
 * Non-blocking — failures are logged, never thrown.
 */
async function cancelReminderTasks(db, eventId, actingUserId = 0) {
  try {
    const ids = await _activeReminderTaskIds(db, eventId);
    for (const id of ids) {
      await taskService.deleteTask(db, id, actingUserId)
        .catch(err => console.error(`[EVENT SERVICE] Cancel reminder task ${id} failed:`, err.message));
    }
  } catch (err) {
    console.error(`[EVENT SERVICE] cancelReminderTasks (event ${eventId}) failed:`, err.message);
  }
}


// ─────────────────────────────────────────────────────────────
// getEvent
// ─────────────────────────────────────────────────────────────

/**
 * Fetch a single event with its resolved link label.
 *
 * 'case_number' rows additionally carry `resolved_case_id` — the case the
 * docket resolves to right now (query-side, self-healing), or NULL when no
 * case matches yet. Their link_label is the docket string verbatim.
 *
 * @param {object} db
 * @param {number} eventId
 * @returns {Promise<object|null>} the event row plus link_label / link_id /
 *          link_type / resolved_case_id fields, or null if not found.
 */
async function getEvent(db, eventId) {
  const [[row]] = await db.query(
    `SELECT
       e.*,
       co.contact_name,
       ca.case_id AS joined_case_id,
       COALESCE(ca.case_number_full, ca.case_number) AS case_number_display,
       ${RESOLVED_CASE_SUBQUERY}
     FROM events e
     LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
     WHERE e.event_id = ?`,
    [eventId]
  );
  if (!row) return null;

  let link_label = null;
  if (row.event_link_type === 'contact') {
    link_label = row.contact_name || (row.event_link_id != null ? `Contact #${row.event_link_id}` : null);
  } else if (row.event_link_type === 'case') {
    link_label = row.case_number_display || row.event_link_id || null;
  } else if (row.event_link_type === 'case_number') {
    link_label = row.event_link_id || null;   // the docket, verbatim (opaque)
  }

  return {
    ...row,
    link_type:  row.event_link_type,
    link_id:    row.event_link_id,
    link_label,
  };
}


// ─────────────────────────────────────────────────────────────
// listEvents
// ─────────────────────────────────────────────────────────────

/**
 * List events with filters.
 *
 * Case-scope expansion (self-healing docket linking): when called with
 * link_type='case' AND link_id, the result ALSO includes 'case_number'
 * events whose docket equals that case's case_number or case_number_full —
 * so case's Events tab shows docket-linked events with zero frontend
 * change. Direct filtering with link_type='case_number' & link_id=<docket>
 * is plain equality. No expansion for link_type='contact'.
 *
 * 'case_number' rows carry `resolved_case_id` (see getEvent) and
 * link_label = the docket string verbatim.
 *
 * @param {object} db
 * @param {object} opts
 *   link_type {string?}  'case' | 'contact' | 'case_number'
 *   link_id   {string?}
 *   status    {string?}  default 'Scheduled'; 'all' => no status filter
 *   type      {string?}  event_type
 *   from      {string?}  event_date >= (YYYY-MM-DD)
 *   to        {string?}  event_date <= (YYYY-MM-DD)
 *   q         {string?}  LIKE on event_title
 *   sort      {string?}  'asc' (soonest first, default) | 'desc' (latest first)
 *   limit     {number?}  default 100
 *   offset    {number?}  default 0
 * @returns {Promise<{ data: object[], total: number }>}
 */
async function listEvents(db, {
  link_type = null,
  link_id   = null,
  status    = 'Scheduled',
  type      = null,
  from      = null,
  to        = null,
  q         = '',
  sort      = 'asc',
  limit     = 100,
  offset    = 0,
} = {}) {
  const where  = [];
  const params = [];

  if (link_type === 'case' && link_id != null && link_id !== '') {
    // Case-scope expansion: include docket-linked ('case_number') events whose
    // docket equals this case's case_number / case_number_full. Equality only —
    // dockets are opaque. Skip the OR entirely when the case has no docket.
    const [[caseRow]] = await db.query(
      'SELECT case_number, case_number_full FROM cases WHERE case_id = ?',
      [String(link_id)]
    );
    const dockets = [];
    if (caseRow) {
      for (const v of [caseRow.case_number, caseRow.case_number_full]) {
        const s = v != null ? String(v).trim() : '';
        if (s && !dockets.includes(s)) dockets.push(s);
      }
    }
    if (dockets.length) {
      where.push(
        `( (e.event_link_type = 'case' AND e.event_link_id = ?)
           OR (e.event_link_type = 'case_number' AND e.event_link_id IN (${dockets.map(() => '?').join(',')})) )`
      );
      params.push(String(link_id), ...dockets);
    } else {
      where.push("e.event_link_type = 'case' AND e.event_link_id = ?");
      params.push(String(link_id));
    }
  } else if (link_type && link_id != null && link_id !== '') {
    // 'contact' and 'case_number' (direct docket filter): plain equality.
    where.push('e.event_link_type = ? AND e.event_link_id = ?');
    params.push(link_type, String(link_id));
  } else if (link_type) {
    where.push('e.event_link_type = ?');
    params.push(link_type);
  }

  if (status && status !== 'all' && status !== 'All') {
    where.push('e.event_status = ?');
    params.push(status);
  }

  if (type) { where.push('e.event_type = ?'); params.push(type); }
  if (from) { where.push('e.event_date >= ?'); params.push(String(from).slice(0, 10)); }
  if (to)   { where.push('e.event_date <= ?'); params.push(String(to).slice(0, 10)); }
  if (q)    { where.push('e.event_title LIKE ?'); params.push(`%${q}%`); }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Whitelisted sort (no interpolation of user input). 'asc' = soonest first
  // (default, preserves prior behavior); 'desc' = latest first.
  const orderSQL = String(sort).toLowerCase() === 'desc'
    ? 'ORDER BY e.event_date DESC, e.event_time IS NULL ASC, e.event_time DESC'
    : 'ORDER BY e.event_date ASC, e.event_time IS NULL DESC, e.event_time ASC';

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM events e ${whereSQL}`,
    params
  );

  const [rows] = await db.query(
    `SELECT
       e.*,
       co.contact_name,
       COALESCE(ca.case_number_full, ca.case_number) AS case_number_display,
       ${RESOLVED_CASE_SUBQUERY}
     FROM events e
     LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
     ${whereSQL}
     ${orderSQL}
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );

  const data = rows.map(r => {
    let link_label = null;
    if (r.event_link_type === 'contact') {
      link_label = r.contact_name || (r.event_link_id != null ? `Contact #${r.event_link_id}` : null);
    } else if (r.event_link_type === 'case') {
      link_label = r.case_number_display || r.event_link_id || null;
    } else if (r.event_link_type === 'case_number') {
      link_label = r.event_link_id || null;   // the docket, verbatim (opaque)
    }
    return { ...r, link_type: r.event_link_type, link_id: r.event_link_id, link_label };
  });

  return { data, total };
}


// ─────────────────────────────────────────────────────────────
// findDuplicateEvent  (Slice 4 Phase B — THE shared natural-key guard)
//
// Until this shipped, the ONLY event dedupe in the system lived inside
// courtExecutor.doCreateEvent. eventService.createEvent (and therefore the
// create_event internal function, and therefore every workflow) inserted
// blind. Phase A diagnosis: 25 duplicate Scheduled events across three
// creators, plus THREE 3-way cross-pipeline clusters that no per-pipeline
// guard could ever have seen.
//
// WHY THE OLD KEY MISSED THE CROSS-PIPELINE CASE
// The three creators disagree on BOTH halves of the old key:
//
//   creator            link_type/link_id             confirmation-hearing type
//   external autom.    'case' / SUTCdsPn (case_id)   'Confirmation Hearing'
//   wf24               'case_number' / 26-46639      'confirmation_hearing'   ← underscore
//   courtExecutor      'case_number' / 26-46639      'Confirmation Hearing'
//
//   SELECT ('Confirmation Hearing' <=> 'confirmation_hearing')  →  0
//
// So the key must normalize case identity ACROSS link forms and must not
// require raw event_type equality.
//
// THE KEY — fires if ANY of three rules hits:
//   1. NATURAL KEY  (link_type, link_id, event_type<=>, event_date, event_title)
//      Exact. The original courtExecutor guard, ported verbatim and generalized
//      off the hard-coded 'case_number'. Reported as rule 'natural_key'.
//   2. SLOT + NORMALIZED TYPE
//      Same case identity, same event_date, NULL-safe-same event_time, and
//      event_type equal after lowercase + [^a-z0-9]+→' ' + trim.
//      ('confirmation_hearing' ≡ 'Confirmation Hearing'.) Rule 'slot_type'.
//   3. SLOT + LOOSE TITLE
//      Same case identity + same slot + titlesSimilarLoose with the case's
//      IDENTITY TOKENS stripped. Catches a re-notice the model re-typed as well
//      as re-titled. Rule 'slot_title'.
//
// Rules 2 and 3 are BOTH slot-gated (event_date = ? AND event_time <=> ?). That
// gate is what keeps them safe. Verified against the live false positives that
// must NOT collapse:
//   - 26-44274 @ 2026-09-02 14:00 : 'Confirmation Hearing' + 'Show Cause'
//     → normalized types differ; cores {} vs {order,show,cause,…} → one-empty
//       → rejected by BOTH rules. Correct: an OSC set at the hearing's slot.
//   - 26-46899 @ 2026-09-01 (all-day) : 'Confirmation Certificate Deadline'
//     + 'Filing Fee Installment Deadline' → types differ; cores
//     {certificate,deadline} vs {final,installment,payment,due}, inter 0
//     → rejected. Correct: two different deadlines on one day.
//
// CASE IDENTITY. 'case' rows carry a case_id; 'case_number' rows carry a
// docket. Both resolve to one case_id (cases.case_id | case_number |
// case_number_full — the same expansion listEvents already does for the case
// Events tab). A candidate whose link does NOT resolve to a case (a 'contact'
// link, or a docket with no case yet) falls back to RAW link equality for
// rules 2-3 — still correct, just narrower. An UNLINKED candidate gets rule 1
// only: with no entity, "same slot" is not a meaningful claim.
//
// NO UNIQUE INDEX. Cancellation is soft (event_status='Canceled'), so a DB
// UNIQUE key would block legitimately re-creating a previously-cancelled
// event; and the key needs cross-link-form normalization a plain index cannot
// express. The guard lives in code. The table is ~110 rows; the two SELECTs
// below are free.
// ─────────────────────────────────────────────────────────────

/** event_type → comparable form: lowercase, non-alnum → single space, trimmed. */
function _normType(t) {
  if (t == null) return null;
  const s = String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return s === '' ? null : s;
}

/**
 * Resolve an (event_link_type, event_link_id) pair to a case row.
 * Mirrors RESOLVED_CASE_SUBQUERY / courtResolve's shape (match either docket
 * column; LIMIT 1 because case_number is not unique-constrained).
 * @returns {Promise<{case_id, case_number, case_number_full}|null>}
 */
async function _resolveLinkedCase(db, linkType, linkId) {
  if (!linkId) return null;
  if (linkType === 'case') {
    const [[row]] = await db.query(
      'SELECT case_id, case_number, case_number_full FROM cases WHERE case_id = ? LIMIT 1',
      [String(linkId)]
    );
    return row || null;
  }
  if (linkType === 'case_number') {
    const [[row]] = await db.query(
      `SELECT case_id, case_number, case_number_full FROM cases
        WHERE case_number = ? OR case_number_full = ? LIMIT 1`,
      [String(linkId), String(linkId)]
    );
    return row || null;
  }
  return null;   // 'contact' (or unlinked) — no case identity
}

/**
 * Identity tokens for a resolved case: docket (both forms) + PRIMARY client
 * name. Primary is selected exactly as courtResolve/caseService do
 * (Primary-first ordering, first row wins).
 */
async function _caseIdentityTokens(db, caseRow) {
  if (!caseRow) return new Set();
  const [contacts] = await db.query(
    `SELECT co.contact_name
       FROM case_relate cr
       JOIN contacts co ON co.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ?
      ORDER BY FIELD(cr.case_relate_type, 'Primary','Secondary','Other','Bystander'),
               co.contact_name
      LIMIT 1`,
    [caseRow.case_id]
  );
  return buildIdentityTokens([
    caseRow.case_number,
    caseRow.case_number_full,
    contacts.length ? contacts[0].contact_name : null,
  ]);
}

/**
 * Find an existing Scheduled event that is the same real-world obligation as
 * `candidate`. Read-only. Returns the events row (plus a `_dedupe_rule` tag)
 * or null.
 *
 * The caller is expected to pass ALREADY-NORMALIZED values (createEvent does):
 * event_date 'YYYY-MM-DD', event_time 'HH:MM:SS'|null, event_title trimmed.
 * Passing raw input still works for the SQL comparisons MySQL can coerce, but
 * '7/24/2026' will not equal '2026-07-24' — normalize first.
 *
 * @param {object} db
 * @param {object} candidate
 * @param {string|null} candidate.event_link_type   'case' | 'contact' | 'case_number' | null
 * @param {string|null} candidate.event_link_id
 * @param {string|null} candidate.event_type
 * @param {string}      candidate.event_title
 * @param {string}      candidate.event_date        'YYYY-MM-DD' (required)
 * @param {string|null} candidate.event_time        'HH:MM:SS' | null (NULL = all-day)
 * @param {number|null} [candidate.exclude_event_id]  ignore this row (update-side callers)
 * @param {Set<string>} [candidate.identity_tokens]   precomputed (skips the case/contact lookups)
 * @returns {Promise<object|null>} events row with `_dedupe_rule`:
 *          'natural_key' | 'slot_type' | 'slot_title'
 */
async function findDuplicateEvent(db, {
  event_link_type  = null,
  event_link_id    = null,
  event_type       = null,
  event_title      = null,
  event_date       = null,
  event_time       = null,
  exclude_event_id = null,
  identity_tokens  = null,
} = {}) {
  const date = _dateOnly(event_date);
  if (!date) return null;                       // no date → nothing to key on
  const time  = _timeOnly(event_time);          // null for all-day
  const title = event_title == null ? '' : String(event_title).trim();
  const excl  = exclude_event_id != null ? Number(exclude_event_id) : null;

  const exclSQL    = excl != null ? ' AND e.event_id <> ?' : '';
  const exclParams = excl != null ? [excl] : [];

  // ── RULE 1 — exact natural key. Applies to EVERY candidate, linked or not.
  const [natural] = await db.query(
    `SELECT e.* FROM events e
      WHERE e.event_link_type <=> ? AND e.event_link_id <=> ?
        AND e.event_type <=> ? AND e.event_date = ? AND e.event_title = ?
        AND e.event_status = 'Scheduled'${exclSQL}
      ORDER BY e.event_id ASC
      LIMIT 1`,
    [event_link_type, event_link_id, event_type, date, title, ...exclParams]
  );
  if (natural.length) return { ...natural[0], _dedupe_rule: 'natural_key' };

  // Rules 2-3 need an entity. An unlinked event has no slot to share.
  if (!event_link_type || event_link_id == null || event_link_id === '') return null;

  // ── Case identity: fold 'case'/case_id and 'case_number'/docket into one.
  const caseRow = await _resolveLinkedCase(db, event_link_type, event_link_id);

  let linkSQL, linkParams;
  if (caseRow) {
    // Same expansion listEvents uses for the case Events tab: the case row PLUS
    // any docket-linked row whose docket is either of this case's docket forms.
    const dockets = [];
    for (const v of [caseRow.case_number, caseRow.case_number_full]) {
      const s = v != null ? String(v).trim() : '';
      if (s && !dockets.includes(s)) dockets.push(s);
    }
    if (dockets.length) {
      linkSQL = `( (e.event_link_type = 'case' AND e.event_link_id = ?)
                   OR (e.event_link_type = 'case_number'
                       AND e.event_link_id IN (${dockets.map(() => '?').join(',')})) )`;
      linkParams = [caseRow.case_id, ...dockets];
    } else {
      linkSQL    = `(e.event_link_type = 'case' AND e.event_link_id = ?)`;
      linkParams = [caseRow.case_id];
    }
  } else {
    // Unresolved link ('contact', or a docket with no case yet) → raw equality.
    linkSQL    = '(e.event_link_type = ? AND e.event_link_id = ?)';
    linkParams = [event_link_type, String(event_link_id)];
  }

  // ── The SLOT SET: every Scheduled event on this entity at this exact
  // date+time (event_time <=> ? is NULL-safe, so all-day matches all-day only).
  // Small by construction — at most a handful of rows.
  const [slot] = await db.query(
    `SELECT e.* FROM events e
      WHERE ${linkSQL}
        AND e.event_date = ? AND e.event_time <=> ?
        AND e.event_status = 'Scheduled'${exclSQL}
      ORDER BY e.event_id ASC`,
    [...linkParams, date, time, ...exclParams]
  );
  if (!slot.length) return null;

  // ── RULE 2 — normalized type.
  const wantType = _normType(event_type);
  if (wantType != null) {
    const hit = slot.find((r) => _normType(r.event_type) === wantType);
    if (hit) return { ...hit, _dedupe_rule: 'slot_type' };
  }

  // ── RULE 3 — loose title, with the case's identity tokens stripped.
  const tokens = identity_tokens instanceof Set
    ? identity_tokens
    : await _caseIdentityTokens(db, caseRow);
  const titleHit = slot.find((r) => titlesSimilarLoose(r.event_title, title, tokens));
  if (titleHit) return { ...titleHit, _dedupe_rule: 'slot_title' };

  return null;
}


// ─────────────────────────────────────────────────────────────
// createEvent
// ─────────────────────────────────────────────────────────────

/**
 * Create a new event.
 *
 * Core write (synchronous):
 *   - INSERT into events
 *   - Log entry (log_type='event', action 'created')
 *
 * Post-commit (non-blocking):
 *   - GCal create → write event_gcal back
 *   - If opts.reminder present → spawn ONE reminder task
 *
 * DEDUPE (Slice 4 Phase B). `dedupe` defaults FALSE so manual/UI creates are
 * unchanged — a human who asks for a second same-slot event gets one. Every
 * AUTOMATION path opts IN (the create_event internal function defaults it to
 * true), because automation is where the duplicates came from: one court NEF
 * re-docketed by the clerk, or a GAS test replay, would otherwise fan out a
 * second full set of deadline events with nothing to stop it.
 *
 * On a dedupe hit NOTHING happens: no INSERT, no log row, no GCal sync, no
 * reminder task. The existing event is returned with deduped:true.
 *
 * @param {object} db
 * @param {object} opts
 * @param {boolean} [opts.dedupe=false]  consult findDuplicateEvent first
 * @returns {{ event_id, event, deduped }}
 */
async function createEvent(db, {
  event_type        = null,
  event_link_type   = null,
  event_link_id     = null,
  event_title,
  event_date,
  event_time        = null,
  event_all_day,
  event_length      = null,
  event_location    = null,
  event_link        = null,
  event_note        = null,
  event_calendar_id = null,
  event_with        = null,
  acting_user_id,
  reminder          = null,
  skip_gcal         = false,
  dedupe            = false,
} = {}) {
  if (!event_title || !String(event_title).trim()) throw new Error('createEvent requires event_title');
  if (!event_date) throw new Error('createEvent requires event_date');

  // Normalize/validate the link pair (enum-safe: 'case'|'contact'|'case_number';
  // id trimmed, required when a type is given; opaque otherwise). Throws on
  // garbage so a bad link_type fails the request loudly instead of being
  // stored as '' under the non-strict sql_mode.
  const normLink = _normalizeLink(event_link_type, event_link_id);
  event_link_type = normLink.type;
  event_link_id   = normLink.id;

  // Normalize/validate date & time (ISO, M/D/YYYY, h:mm AM/PM, or a combined
  // "date time" in event_date). Throws on garbage so bad input fails loudly
  // instead of storing 0000-00-00 / a silently 12h-shifted time.
  ({ event_date, event_time } = _normalizeEventDateTime({ event_date, event_time }));
  if (reminder && reminder.date) {
    reminder = { ...reminder, date: _normalizeEventDate(reminder.date, 'reminder.date') };
  }

  // Normalize all-day/time consistency
  const { event_all_day: allDay, event_time: time } =
    _normalizeAllDay({ event_all_day, event_time });

  // event_length applies to timed events only
  const lengthVal = allDay === 1 ? null : (event_length != null ? Number(event_length) : null);

  // event_with: null = blocks all providers' availability (firm-wide);
  // an id = blocks only that provider. Validated against does_appts users.
  const withVal = await _normalizeEventWith(db, event_with);

  const createdBy = (acting_user_id != null && acting_user_id !== '' && Number(acting_user_id) !== 0)
    ? Number(acting_user_id)
    : null;

  // ── DEDUPE GUARD (opt-in; automation opts in) ────────────────────────────
  // Placed AFTER all validation/normalization so the comparison sees the same
  // canonical values the INSERT would write ('7/24/2026' must dedupe against a
  // stored '2026-07-24'), and BEFORE the INSERT so a hit produces NO write and
  // NO side effect at all.
  if (dedupe) {
    const existing = await findDuplicateEvent(db, {
      event_link_type,
      event_link_id,
      event_type,
      event_title: String(event_title).trim(),
      event_date:  _dateOnly(event_date),
      event_time:  time,
    });
    if (existing) {
      console.log(
        `[EVENT SERVICE] createEvent DEDUPED → existing event ${existing.event_id} ` +
        `(rule=${existing._dedupe_rule}) for "${String(event_title).trim()}" ` +
        `${event_link_type || 'internal'}:${event_link_id || '-'} ${_dateOnly(event_date)}${time ? ' ' + time : ''}`
      );
      // Re-read through getEvent so the returned shape matches the normal
      // create path (link_label / resolved_case_id present). Pure read.
      const event = (await getEvent(db, existing.event_id)) || existing;
      return { event_id: existing.event_id, event, deduped: true };
    }
  }

  const [result] = await db.query(
    `INSERT INTO events
       (event_type, event_link_type, event_link_id, event_title, event_date,
        event_time, event_all_day, event_length, event_location, event_link,
        event_note, event_status, event_calendar_id, event_with, event_create_date, event_created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Scheduled', ?, ?, NOW(), ?)`,
    [
      event_type,
      event_link_type,
      event_link_id,   // normalized above: trimmed string or null
      String(event_title).trim(),
      _dateOnly(event_date),
      time,
      allDay,
      lengthVal,
      event_location,
      event_link,
      event_note,
      event_calendar_id,
      withVal,
      createdBy,
    ]
  );
  const eventId = result.insertId;

  // Build a lightweight row for logging / gcal (avoids an extra round-trip
  // before the post-commit work).
  const eventRow = {
    event_id:          eventId,
    event_type,
    event_link_type,
    event_link_id,     // normalized above: trimmed string or null
    event_title:       String(event_title).trim(),
    event_date:        _dateOnly(event_date),
    event_time:        time,
    event_all_day:     allDay,
    event_length:      lengthVal,
    event_location,
    event_link,
    event_note,
    event_calendar_id,
    event_with:        withVal,
  };

  // Log entry
  const logExtras = {};
  if (event_note) logExtras.note = event_note;
  await insertEventLog(db, eventRow, createdBy, 'created', logExtras);

  // ---- Post-commit non-blocking side effects ----

  // a) GCal create
  syncEventToCalendar(db, eventRow, { skip_gcal })
    .catch(err => console.error('[EVENT SERVICE] syncEventToCalendar wrapper failed:', err.message));

  // b) Reminder task
  if (reminder) {
    spawnReminderTask(db, eventRow, reminder, createdBy || 0)
      .then(taskId => {
        if (taskId) console.log(`[EVENT SERVICE] Event ${eventId} reminder task #${taskId} created`);
      })
      .catch(err => console.error('[EVENT SERVICE] spawnReminderTask failed:', err.message));
  }

  const event = await getEvent(db, eventId);
  return { event_id: eventId, event, deduped: false };
}


// ─────────────────────────────────────────────────────────────
// updateEvent
// ─────────────────────────────────────────────────────────────

// IDENTITY IS CREATION-TIME (Slice 4 Phase B).
//
// event_link_type and event_link_id were in this allowlist, and
// PATCH /api/events/:id forwards the raw request body — so
// `PATCH /api/events/93 {"event_link_type":"case","event_link_id":"T19Z4P7z"}`
// silently relinked an event to a different entity. Nothing had ever used it
// (Phase A: 12 event 'updated' log rows, zero touching either column), but a
// relink invalidates the natural key findDuplicateEvent is built on — the
// duplicate it prevented on Monday becomes reachable again on Tuesday.
//
// An event's entity is decided when it is created. To move one: cancel it and
// create it on the right entity. Both columns are now REJECTED here with the
// standard "blocked fields: …" 400.
const UPDATE_ALLOWED = new Set([
  'event_type', 'event_title',
  'event_date', 'event_time', 'event_all_day', 'event_length',
  'event_location', 'event_link', 'event_note', 'event_status',
  'event_calendar_id', 'event_with',
]);

// Fields whose change requires a calendar re-sync (delete + recreate).
const GCAL_AFFECTING = new Set([
  'event_title', 'event_date', 'event_time', 'event_all_day',
  'event_length', 'event_location', 'event_link', 'event_calendar_id',
]);

/**
 * Update one or more fields on an event, and/or swap its reminder task.
 *
 * Whitelisted columns only (others rejected with "blocked fields: ..."). The
 * all_day/time consistency rule is re-applied. If any gcal-affecting field
 * changed (and the event should have a calendar entry) the calendar event is
 * delete-then-recreated, mirroring the appt reschedule pattern.
 *
 * Reminder handling (option 2 — explicit, no delta-inference):
 *   - opts.reminder OMITTED (undefined)       → reminders untouched.
 *   - opts.reminder = { to, date, title? }    → cancel existing active reminder
 *                                               task(s) for this event, spawn
 *                                               the new one.
 *   - opts.reminder = null                    → cancel existing active reminder
 *                                               task(s), spawn none (remove).
 * A reminder-only update (no `fields`) is allowed.
 *
 * @param {object} db
 * @param {number} eventId
 * @param {object} fields
 * @param {number} actingUserId
 * @param {object} [opts]
 * @param {object|null} [opts.reminder] - see above. `undefined` = leave reminders alone.
 * @returns {{ event }}
 */
async function updateEvent(db, eventId, fields, actingUserId = 0, { reminder } = {}) {
  const hasFields        = !!(fields && Object.keys(fields).length);
  const reminderProvided = reminder !== undefined;

  if (!hasFields && !reminderProvided) {
    throw new Error('updateEvent requires at least one field or a reminder');
  }

  if (hasFields) {
    const blocked = Object.keys(fields).filter(k => !UPDATE_ALLOWED.has(k));
    if (blocked.length) throw new Error(`updateEvent: blocked fields: ${blocked.join(', ')}`);
  }

  // Normalize/validate date & time inputs (same rules as createEvent). A
  // combined "date time" in event_date populates event_time as if supplied,
  // which then drives the all_day/time invariant below.
  if (hasFields && ('event_date' in fields || 'event_time' in fields)) {
    if ('event_date' in fields && (fields.event_date == null || fields.event_date === '')) {
      throw new Error('event_date cannot be empty');
    }
    const norm = _normalizeEventDateTime({
      event_date: 'event_date' in fields ? fields.event_date : undefined,
      event_time: 'event_time' in fields ? fields.event_time : undefined,
    });
    if ('event_date' in fields) fields.event_date = norm.event_date;
    if (norm.event_time !== undefined && (norm.event_time != null || 'event_time' in fields)) {
      fields.event_time = norm.event_time;   // combined-datetime path adds it
    }
  }
  if (reminder && reminder.date) {
    reminder = { ...reminder, date: _normalizeEventDate(reminder.date, 'reminder.date') };
  }

  const existing = await getEvent(db, eventId);
  if (!existing) throw new Error(`Event ${eventId} not found`);

  let changedKeys = [];

  if (hasFields) {
    // Work on a merged copy so we can re-apply the all_day/time invariant even
    // when only one of the pair was supplied.
    const merged = { ...fields };

    // Re-apply the all_day/time invariant when EITHER half of the pair was
    // supplied. Precedence (matches _normalizeAllDay):
    //   - user sent event_all_day  → it wins (all_day=1 forces time null).
    //   - user sent only event_time → all_day is INFERRED from the time
    //     (non-null time → timed; null time → all-day). The existing all_day
    //     flag must NOT be fed in here, or it would override the user's intent
    //     (e.g. PATCH {event_time:"14:30"} on an all-day event would snap back
    //     to all-day and drop the time).
    if ('event_all_day' in fields || 'event_time' in fields) {
      const allDayArg = 'event_all_day' in fields ? fields.event_all_day : undefined;
      const timeArg   = 'event_time'    in fields ? fields.event_time     : existing.event_time;

      const { event_all_day: allDay, event_time: time } = _normalizeAllDay({
        event_all_day: allDayArg,   // undefined when not user-supplied → infer from time
        event_time:    timeArg,
      });
      merged.event_all_day = allDay;
      merged.event_time     = time;
      // If we became all-day, null the length too.
      if (allDay === 1) merged.event_length = null;
    }

    // Normalize event_date if present
    if ('event_date' in merged && merged.event_date) {
      merged.event_date = _dateOnly(merged.event_date);
    }
    // (The event_link_type / event_link_id normalization that used to live here
    // is gone: both columns were removed from UPDATE_ALLOWED above, so the
    // blocked-fields check rejects them before we ever get here. _normalizeLink
    // still owns them on the CREATE path, which is the only path that sets an
    // event's entity.)

    // event_with: presence in the patch means "set it" (null = back to
    // firm-wide); absence leaves it untouched. Same validation as create.
    if ('event_with' in merged) {
      merged.event_with = await _normalizeEventWith(db, merged.event_with);
    }

    const keys = Object.keys(merged);
    const setClauses = keys.map(k => `\`${k}\` = ?`).join(', ');
    const values = [...keys.map(k => merged[k]), eventId];

    const [res] = await db.query(
      `UPDATE events SET ${setClauses} WHERE event_id = ?`,
      values
    );
    if (res.affectedRows === 0) throw new Error(`Event ${eventId} not found`);
    changedKeys = keys;
  }

  // Re-log (covers field change and/or reminder change)
  const logExtra = {};
  if (changedKeys.length) logExtra.changed = changedKeys;
  if (reminderProvided) {
    logExtra.reminder = (reminder && typeof reminder === 'object') ? 'rescheduled' : 'cleared';
  }
  await insertEventLog(db, existing, actingUserId, 'updated', logExtra);

  // ---- GCal sync (non-blocking) — only when a gcal-affecting field changed ----
  const gcalChanged = changedKeys.some(k => GCAL_AFFECTING.has(k));
  if (gcalChanged) {
    (async () => {
      const fresh = await getEvent(db, eventId);
      if (!fresh) return;
      // Determine whether this event should have a calendar entry now.
      if (!_shouldSyncGcal(fresh)) {
        // Calendar opt-out (event_calendar_id 'none'): tear down any prior event.
        if (existing.event_gcal) {
          await deleteEventCalendarEvent(db, existing.event_gcal, existing.event_calendar_id, 'update_optout');
          await db.query('UPDATE events SET event_gcal = NULL WHERE event_id = ?', [eventId]);
        }
        return;
      }
      // Delete-then-recreate (mirrors appt reschedule).
      if (existing.event_gcal) {
        await deleteEventCalendarEvent(db, existing.event_gcal, existing.event_calendar_id, 'update');
        await db.query('UPDATE events SET event_gcal = NULL WHERE event_id = ?', [eventId]);
      }
      await syncEventToCalendar(db, { ...fresh });
    })().catch(err => console.error('[EVENT SERVICE] update gcal sync failed:', err.message));
  }

  // ---- Reminder swap (option 2) ----
  // Awaited (so callers/tests see the new task immediately) but wrapped so a
  // task-system failure never propagates out of an otherwise-successful event
  // update. cancelReminderTasks never throws; spawnReminderTask might.
  if (reminderProvided) {
    try {
      await cancelReminderTasks(db, eventId, actingUserId);
      if (reminder && typeof reminder === 'object') {
        // Re-fetch so the default reminder title reflects any title change in
        // this same update.
        const fresh = await getEvent(db, eventId) || existing;
        const taskId = await spawnReminderTask(db, fresh, reminder, actingUserId);
        if (taskId) console.log(`[EVENT SERVICE] Event ${eventId} reminder task #${taskId} created (update)`);
      }
    } catch (err) {
      console.error('[EVENT SERVICE] updateEvent reminder swap failed:', err.message);
    }
  }

  const event = await getEvent(db, eventId);
  return { event };
}


// ─────────────────────────────────────────────────────────────
// completeEvent
// ─────────────────────────────────────────────────────────────

/**
 * Mark an event Completed.
 *   - status → 'Completed'
 *   - cancel reminder task(s) (non-blocking)
 *   - do NOT delete the gcal event (it's a real past calendar entry)
 *   - log action 'completed'
 */
async function completeEvent(db, eventId, actingUserId = 0) {
  const existing = await getEvent(db, eventId);
  if (!existing) throw new Error(`Event ${eventId} not found`);
  if (existing.event_status === 'Completed') throw new Error('Event is already Completed');

  await db.query(
    `UPDATE events SET event_status = 'Completed' WHERE event_id = ?`,
    [eventId]
  );

  await insertEventLog(db, existing, actingUserId, 'completed',
    existing.event_status !== 'Scheduled' ? { from: existing.event_status } : {});

  cancelReminderTasks(db, eventId, actingUserId)
    .catch(err => console.error('[EVENT SERVICE] completeEvent cancelReminderTasks failed:', err.message));

  const event = await getEvent(db, eventId);
  return { event };
}


// ─────────────────────────────────────────────────────────────
// cancelEvent
// ─────────────────────────────────────────────────────────────

/**
 * Mark an event Canceled.
 *   - status → 'Canceled'
 *   - if delete_gcal and event_gcal: delete the calendar event (non-blocking)
 *   - cancel reminder task(s) (non-blocking)
 *   - log action 'canceled'
 */
async function cancelEvent(db, eventId, actingUserId = 0, { delete_gcal = true } = {}) {
  const existing = await getEvent(db, eventId);
  if (!existing) throw new Error(`Event ${eventId} not found`);
  if (existing.event_status === 'Canceled') throw new Error('Event is already Canceled');

  await db.query(
    `UPDATE events SET event_status = 'Canceled' WHERE event_id = ?`,
    [eventId]
  );

  await insertEventLog(db, existing, actingUserId, 'canceled',
    existing.event_status !== 'Scheduled' ? { from: existing.event_status } : {});

  if (delete_gcal && existing.event_gcal) {
    deleteEventCalendarEvent(db, existing.event_gcal, existing.event_calendar_id, 'cancel');
    db.query('UPDATE events SET event_gcal = NULL WHERE event_id = ?', [eventId])
      .catch(err => console.error('[EVENT SERVICE] cancelEvent clear gcal id failed:', err.message));
  }

  cancelReminderTasks(db, eventId, actingUserId)
    .catch(err => console.error('[EVENT SERVICE] cancelEvent cancelReminderTasks failed:', err.message));

  const event = await getEvent(db, eventId);
  return { event };
}


// ─────────────────────────────────────────────────────────────
// DIGEST SUPPORT (for the 'event_daily_digest' scheduled job)
//
// Pure read/format helpers — no writes, no GCal, no side effects.
// getEventsForDigest mirrors the getEvent/listEvents join shape;
// buildEventDigestEmail mirrors taskService.buildDigestEmail's
// inline-styled email aesthetic (teal accent to distinguish it from
// the indigo task digest). The job block in lib/job_executor.js owns
// the date-window math, grouping, recipients, and dispatch.
// ─────────────────────────────────────────────────────────────

/**
 * Fetch Scheduled events whose event_date falls within [from..to]
 * (inclusive, firm-local 'YYYY-MM-DD'), with resolved entity labels.
 *
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.from  'YYYY-MM-DD'
 * @param {string} opts.to    'YYYY-MM-DD'
 * @returns {Promise<object[]>} raw rows (job block groups/formats)
 */
async function getEventsForDigest(db, { from, to } = {}) {
  if (!from || !to) {
    throw new Error('getEventsForDigest requires { from, to } as YYYY-MM-DD');
  }
  const fromStr = String(from).slice(0, 10);
  const toStr   = String(to).slice(0, 10);

  // Joins mirror getEvent() verbatim:
  //   - case join: varchar event_link_id = varchar cases.case_id (both
  //     utf8mb4_general_ci) → collation-safe.
  //   - contact join: varchar event_link_id = int contacts.contact_id →
  //     implicit numeric cast (same as getEvent, proven in production).
  //   - case_number rows: resolved_case_id via correlated subquery (LIMIT 1,
  //     not a JOIN — see RESOLVED_CASE_SUBQUERY). Label = the docket itself.
  const [rows] = await db.query(
    `SELECT
       e.event_id, e.event_type, e.event_title, e.event_date, e.event_time,
       e.event_all_day, e.event_location, e.event_link,
       e.event_link_type, e.event_link_id,
       co.contact_name,
       ca.case_number_full, ca.case_number, ca.case_id,
       ${RESOLVED_CASE_SUBQUERY}
     FROM events e
     LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
     LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
     WHERE e.event_status = 'Scheduled'
       AND e.event_date BETWEEN ? AND ?
     ORDER BY e.event_date ASC, e.event_all_day DESC, e.event_time ASC`,
    [fromStr, toStr]
  );
  return rows;
}

/**
 * Build the upcoming-events digest email HTML.
 *
 * @param {string} recipientFName  first name for the greeting ('' = generic)
 * @param {object[]} eventsByDate  [{ dateName, events: [row, ...] }, ...]
 *                                 (pre-grouped & date-ascending by the job)
 * @param {object} [opts]
 * @param {string} [opts.windowLabel]  e.g. "Fri" / "Fri–Sun"
 * @returns {string} full HTML document
 */
function buildEventDigestEmail(recipientFName, eventsByDate, opts = {}) {
  const { windowLabel = '' } = opts;
  const APP_URL = process.env.APP_URL || 'https://app.4lsg.com';
  const HEADER  = '#0f766e'; // teal-700 — visually distinct from indigo task digest
  const groups  = Array.isArray(eventsByDate) ? eventsByDate : [];
  const total   = groups.reduce((n, g) => n + (g.events ? g.events.length : 0), 0);

  // NOTE: event fields are rendered unescaped, matching taskService's
  // buildDigestEmail behavior (staff-entered content). If we ever decide to
  // escape, do it in both builders together.

  function timeLabel(row) {
    const allDay = row.event_all_day === 1 || row.event_all_day === '1' || row.event_all_day === true;
    if (allDay) return 'All day';
    const t = _timeOnly(row.event_time);
    if (!t) return 'All day';
    const dt = DateTime.fromFormat(t, 'HH:mm:ss');
    return dt.isValid ? dt.toFormat('h:mm a') : t.slice(0, 5);
  }

  function entityLink(row) {
    if (row.event_link_type === 'contact') {
      const name = row.contact_name
        || (row.event_link_id != null ? `Contact #${row.event_link_id}` : '');
      if (!name) return '';
      return `<a href="${APP_URL}?contact=${row.event_link_id || ''}" `
           + `style="color:${HEADER};text-decoration:none">${name}</a>`;
    }
    if (row.event_link_type === 'case') {
      const name = row.case_number_full || row.case_number
        || (row.event_link_id != null ? `Case ${row.event_link_id}` : '');
      if (!name) return '';
      return `<a href="${APP_URL}?case=${row.case_id || row.event_link_id || ''}" `
           + `style="color:${HEADER};text-decoration:none">${name}</a>`;
    }
    if (row.event_link_type === 'case_number') {
      // Label = the docket verbatim. Linked only when the docket currently
      // resolves to a case (query-side, self-healing); otherwise plain text.
      const name = row.event_link_id || '';
      if (!name) return '';
      if (row.resolved_case_id) {
        return `<a href="${APP_URL}?case=${row.resolved_case_id}" `
             + `style="color:${HEADER};text-decoration:none">${name}</a>`;
      }
      return name;
    }
    return '';
  }

  function eventRow(row) {
    const time = timeLabel(row);
    const meta = [];
    if (row.event_type) meta.push(row.event_type);
    const ent = entityLink(row);
    if (ent) meta.push(ent);
    if (row.event_location) meta.push(row.event_location);

    const sep = '<span style="color:#d1d5db;padding:0 6px">·</span>';
    const metaLine = meta.length
      ? `<div style="margin-top:2px;font-size:12px;color:#6b7280">${meta.join(sep)}</div>`
      : '';
    const linkLine = row.event_link
      ? `<div style="margin-top:3px;font-size:12px">`
        + `<a href="${row.event_link}" style="color:${HEADER};text-decoration:none">Open link ↗</a></div>`
      : '';

    return `<tr style="border-bottom:1px solid #f3f4f6">
      <td style="padding:10px 10px 10px 0;font-size:12px;color:#111827;font-weight:600;
                 white-space:nowrap;vertical-align:top;width:80px">${time}</td>
      <td style="padding:10px 0;vertical-align:top">
        <div style="font-size:14px;color:#111827;font-weight:600">${row.event_title || 'Event'}</div>
        ${metaLine}
        ${linkLine}
      </td>
    </tr>`;
  }

  function dayBlock(group) {
    return `<div style="margin-bottom:22px">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;color:${HEADER};
                letter-spacing:1px;text-transform:uppercase;
                border-bottom:2px solid ${HEADER};padding-bottom:6px">${group.dateName}</p>
      <table width="100%" cellpadding="0" cellspacing="0"><tbody>
        ${(group.events || []).map(eventRow).join('')}
      </tbody></table>
    </div>`;
  }

  const greeting = recipientFName ? `Hi ${recipientFName},` : 'Hello,';
  const subject  = `Upcoming Events${windowLabel ? ` — ${windowLabel}` : ''}`;

  const body = `
    <h2 style="margin:0 0 2px;font-size:22px;color:#111827">Upcoming Events</h2>
    <p style="margin:0 0 18px;font-size:14px;color:#6b7280">
      ${greeting} here ${total === 1 ? 'is' : 'are'} ${total}
      scheduled event${total === 1 ? '' : 's'}${windowLabel ? ` for ${windowLabel}` : ''}.
    </p>
    ${groups.map(dayBlock).join('')}
    <p style="margin:18px 0 0;font-size:13px;color:#9ca3af">
      Log in to YisraCase to view or manage these events.
    </p>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f0fdfa;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfa;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="max-width:600px;width:100%;border-radius:10px;overflow:hidden;
                  box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <tr>
        <td style="background:${HEADER};padding:22px 32px 18px">
          <span style="color:#ccfbf1;font-size:11px;font-weight:600;
                       letter-spacing:2px;text-transform:uppercase">${subject}</span>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff;padding:28px 32px 24px">${body}</td>
      </tr>
      <tr>
        <td style="background:#f0fdfa;padding:14px 32px;border-top:1px solid #e0e0e0">
          <p style="margin:0;font-size:11px;color:#9ca3af">
            This message was sent automatically by YisraCase.
            If you have questions, reach out to your supervisor.
          </p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Send the upcoming-events digest. Owns ALL orchestration (window math,
 * grouping, recipient resolution, dispatch) so the recurring scheduled job
 * (via internalFunctions.run_event_digest) and any on-demand caller share
 * one implementation — no copy-paste twin like task digest has today.
 *
 * Window: tomorrow → the next workday (inclusive), extended across any
 * Shabbos/Yom Tov closure so the last open day before a closure still warns.
 * Override with explicit { from, to } ('YYYY-MM-DD'); when overridden the
 * window is used verbatim (no workday extension).
 *
 * Send-gate: skipped entirely on Shabbos / Yom Tov unless force=true. (The
 * gate keys off TODAY, not the window.)
 *
 * Recipients: app_settings 'event_digest_recipients' (CSV of users.user
 * ids); falls back to the firm catch-all inbox (app_settings
 * 'email_default_to', then process.env.FIRM_EMAIL). Aborts (sends nothing)
 * if none resolve. One bad recipient never aborts the rest.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]  skip the Shabbos/Yom Tov send-gate
 * @param {string}  [opts.from]         'YYYY-MM-DD' window start override
 * @param {string}  [opts.to]           'YYYY-MM-DD' window end override
 * @returns {Promise<object>} summary ({ sent, window, event_count } or
 *          { skipped_reason } or { sent:0, reason })
 */
async function sendEventDigest(db, { force = false, from = null, to = null } = {}) {
  // Lazy requires — cycle-safety + matches the run_task_digest convention.
  const calendarSvc = require('./calendarService');
  const phoneSvc    = require('./phoneService');

  const nowFirm = DateTime.now().setZone(FIRM_TZ);

  // ── 1. Shabbos / Yom Tov send-gate (unless forced) ───────────────────
  if (!force) {
    const { workday, isShabbos, holidayName } = await calendarSvc.isWorkday(nowFirm.toISO());
    if (!workday) {
      const reason = isShabbos ? 'Shabbos' : `Yom Tov (${holidayName})`;
      console.log(`[EVENT DIGEST] Skipping notifications — ${reason}`);
      return { skipped_reason: reason };
    }
  }

  // ── 2. Coverage window ───────────────────────────────────────────────
  let fromStr, toStr, windowLabel;
  if (from && to) {
    fromStr = String(from).slice(0, 10);
    toStr   = String(to).slice(0, 10);
    const a = DateTime.fromISO(fromStr, { zone: FIRM_TZ });
    const b = DateTime.fromISO(toStr,   { zone: FIRM_TZ });
    windowLabel = (fromStr === toStr) ? a.toFormat('cccc') : `${a.toFormat('ccc')}–${b.toFormat('ccc')}`;
  } else {
    // tomorrow → next workday (inclusive). Extend across closed days so the
    // last open day before a closure still warns. (startOf('day') firm-local
    // ISO keeps the same calendar weekday after UTC conversion, so
    // isWorkday's restricted-day detection stays correct.)
    const start = nowFirm.plus({ days: 1 }).startOf('day');
    let end = start, guard = 0;
    while (!(await calendarSvc.isWorkday(end.toISO())).workday && guard < 10) {
      end = end.plus({ days: 1 });
      guard++;
    }
    fromStr = start.toFormat('yyyy-MM-dd');
    toStr   = end.toFormat('yyyy-MM-dd');
    windowLabel = (fromStr === toStr) ? start.toFormat('cccc') : `${start.toFormat('ccc')}–${end.toFormat('ccc')}`;
  }

  // ── 3. Fetch Scheduled events in the window ──────────────────────────
  const rows = await getEventsForDigest(db, { from: fromStr, to: toStr });
  if (rows.length === 0) {
    console.log(`[EVENT DIGEST] No events in window ${fromStr}..${toStr} — nothing to send`);
    return { sent: 0, reason: 'no events in window', window: [fromStr, toStr] };
  }

  // ── 4. Group by event_date (rows already date-ascending) ─────────────
  const eventsByDate = [];
  const groupIndex   = new Map();
  for (const r of rows) {
    const key = _dateOnly(r.event_date);
    let grp = groupIndex.get(key);
    if (!grp) {
      grp = { dateName: DateTime.fromISO(key, { zone: FIRM_TZ }).toFormat('cccc, MMMM d'), events: [] };
      groupIndex.set(key, grp);
      eventsByDate.push(grp);
    }
    grp.events.push(r);
  }

  // ── 5. Resolve recipients ────────────────────────────────────────────
  let recipients = [];
  const [[recipRow]] = await db.query(
    "SELECT value FROM app_settings WHERE `key` = 'event_digest_recipients'"
  );
  const csv = ((recipRow && recipRow.value) || '').trim();
  if (csv) {
    const ids = csv.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const [urows] = await db.query(
        `SELECT user_fname, email, phone, allow_sms FROM users WHERE user IN (${placeholders})`,
        ids
      );
      recipients = urows.map(u => ({
        fname: u.user_fname, email: u.email, phone: u.phone, allow_sms: u.allow_sms,
      }));
    }
  }
  if (!recipients.length) {
    // No targeted recipients — fall back to the firm catch-all inbox:
    // app_settings 'email_default_to', then process.env.FIRM_EMAIL.
    const [[toRow]] = await db.query(
      "SELECT value FROM app_settings WHERE `key` = 'email_default_to'"
    );
    const fallbackTo = ((toRow && toRow.value) || '').trim() || process.env.FIRM_EMAIL || null;
    if (fallbackTo) recipients = [{ fname: '', email: fallbackTo, phone: null, allow_sms: 0 }];
  }
  if (!recipients.length) {
    console.warn('[EVENT DIGEST] No recipients (event_digest_recipients / email_default_to / FIRM_EMAIL all unset) — aborting send');
    return { sent: 0, reason: 'no recipients', window: [fromStr, toStr], event_count: rows.length };
  }

  // ── 6. From-addresses ────────────────────────────────────────────────
  const fromEmail = await taskService.getFromEmail(db);
  const smsFrom   = await taskService.getSmsFrom(db);

  // ── 7. Dispatch (one bad recipient must not abort the rest) ──────────
  let sent = 0;
  for (const rcpt of recipients) {
    if (!rcpt.email) continue;
    try {
      const html = buildEventDigestEmail(rcpt.fname || '', eventsByDate, { windowLabel });
      await emailService.sendEmail(db, {
        from:    fromEmail,
        to:      rcpt.email,
        subject: `Upcoming Events — ${windowLabel}`,
        html,
      });
      sent++;
    } catch (emailErr) {
      console.error(`[EVENT DIGEST] Email failed for ${rcpt.email}:`, emailErr.message);
    }

    if (rcpt.allow_sms && rcpt.phone && smsFrom) {
      try {
        await phoneSvc.sendSms(db, smsFrom, rcpt.phone,
          `${rows.length} upcoming event(s) ${windowLabel}. Log in to YisraCase.`
        );
      } catch (smsErr) {
        console.error(`[EVENT DIGEST] SMS failed for ${rcpt.phone}:`, smsErr.message);
      }
    }
  }

  console.log(`[EVENT DIGEST] Done. Sent: ${sent}, window ${fromStr}..${toStr}, events: ${rows.length}`);
  return { sent, window: [fromStr, toStr], event_count: rows.length };
}


module.exports = {
  createEvent,
  updateEvent,
  completeEvent,
  cancelEvent,
  getEvent,
  listEvents,
  spawnReminderTask,
  cancelReminderTasks,
  // dedupe (Slice 4 Phase B) — THE shared guard. courtExecutor imports these;
  // there is no second copy of the title logic anywhere in the tree.
  findDuplicateEvent,
  buildIdentityTokens,
  titlesMatch,
  titlesSimilarLoose,
  // digest support
  getEventsForDigest,
  buildEventDigestEmail,
  sendEventDigest,
  // exported for testing / reuse
  _gcalTimes,
  _normalizeAllDay,
  _normalizeEventWith,
  _titleCore,
  _titleNorm,
  _normType,
  _tokenize,
};