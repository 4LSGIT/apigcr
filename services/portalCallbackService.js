// services/portalCallbackService.js
//
// Client Portal Slice 3.5 — callback requests. Natively replaces the
// function of public/appt.html (a legacy Jotform embed → external workflow)
// with house infrastructure:
//
//   client picks a day (7-day horizon) + a 2-hour window + phone + message
//     → taskService.createTask (canonical — owns assignment email/SMS to the
//       assignee, task log, action token)
//     → one_time scheduled_jobs row at WINDOW START firing the
//       portal_callback_reminder internal function (SMS to the then-current
//       assignee with a contact deep-link) — replaces the old workflow's
//       timed reminder
//     → fire-and-forget transparent Google Calendar event (visible, but
//       transparency:'transparent' ⇒ shows as Free — does NOT block busy
//       time on GCal nor in the scheduler's freeBusy fetch; replaces the
//       old workflow's window-blocking event)
//
// Locked mini-spec (Phase A, 2026-08-06): contact-level scope, one open
// request per contact, cancel = taskService.deleteTask (soft), Shabbos/yom
// tov exclusion via firm_blocks overlap (per-window, zmanim-precise), no
// schema changes — one app_settings row (portal_callback_task_to).
//
// Timezone model: windows are firm-local wall times (FIRM_TZ). firm_blocks
// stores naive firm-local DATETIMEs (availabilityService-verified), fetched
// as DATE_FORMAT strings so mysql2's fake-UTC Date wrapping never enters —
// all overlap math is lexicographic on 'YYYY-MM-DD HH:mm:ss' wall strings.
// The reminder job's scheduled_time is a UTC JS Date (taskService
// scheduleDueReminder precedent; DB session NOW() verified = UTC).
//
// task_start is a DATE column — it carries the callback DAY for queue
// context. The window's clock time lives in the task title/desc and in the
// reminder job (scheduled_time + params.window_label). The pending-request
// display reads the job row back by its deterministic name
// ("Portal callback reminder — task #<id>") rather than parsing the title —
// judgment call, flagged: zero schema, one indexed-enough SELECT, and the
// job is our own artifact created in the same code path.

'use strict';

const taskService     = require('./taskService');
const phoneService    = require('./phoneService');
const emailService    = require('./emailService');
const gcalService     = require('./gcalService');
const { getSetting }  = require('./settingsService');
const { nowLocal, FIRM_TZ } = require('./timezoneService');
const { DateTime }    = require('luxon');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

// Phase A decision 4: 7 days, hardcoded (no setting).
const HORIZON_DAYS = 7;

// Phase A decision 1: the incumbent Jotform's five 2-hour blocks, verbatim.
// Keys are stable API vocabulary (client sends the key, never the label);
// labels are display + SMS text. Hours are firm-local.
const WINDOWS = [
  { key: '12-14', label: '12:00–2:00 PM',  startHour: 12, endHour: 14 },
  { key: '14-16', label: '2:00–4:00 PM',   startHour: 14, endHour: 16 },
  { key: '16-18', label: '4:00–6:00 PM',   startHour: 16, endHour: 18 },
  { key: '18-20', label: '6:00–8:00 PM',   startHour: 18, endHour: 20 },
  { key: '20-22', label: '8:00–10:00 PM',  startHour: 20, endHour: 22 },
];
const WINDOW_BY_KEY = new Map(WINDOWS.map(w => [w.key, w]));

const SOURCE        = 'portal_callback';
const OPEN_STATUSES = ['Pending', 'Due Today', 'Overdue'];

// Message cap: task_desc hard-throws at 1000 in createTask; the fixed desc
// lines (~120 chars worst case) leave comfortable headroom at 800.
const MESSAGE_MAX = 800;
// Title hard cap is 100 (createTask throws); fixed parts ("Callback: " +
// " — " + day/window label ≤ ~28) leave ~60 for the name.
const TITLE_NAME_MAX = 58;

const JOB_NAME_PREFIX = 'Portal callback reminder — task #';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** HTML-escape for notification/GCal bodies. File-local by repo convention. */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Error carrying an HTTP status (+ optional extra payload for the route). */
function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * Normalize a client-entered phone to 10 digits. Accepts 10 digits or 11
 * with a leading 1 (stripped). Returns null when invalid — the caller 400s.
 */
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  return null;
}

/** Display format for a 10-digit phone: (XXX) XXX-XXXX. */
function formatPhone(d10) {
  if (!d10 || d10.length !== 10) return String(d10 || '');
  return `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`;
}

/** Firm-local day label, e.g. "Thu Aug 13". */
function dayLabel(dt) {
  return dt.toFormat('ccc LLL d');
}

/** Window start/end as firm-local Luxon DateTimes for a civil date. */
function windowBounds(dateStr, win) {
  const day = DateTime.fromISO(dateStr, { zone: FIRM_TZ }).startOf('day');
  return {
    start: day.set({ hour: win.startHour }),
    end:   day.set({ hour: win.endHour }),
  };
}

const WALL_FMT = 'yyyy-MM-dd HH:mm:ss';

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABILITY (firm_blocks overlap, per-window)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active firm_blocks intervals overlapping [fromWall, toWall) as firm-local
 * wall strings. DATE_FORMAT keeps mysql2's fake-UTC Dates out of the math.
 */
async function _fetchBlocks(db, fromWall, toWall) {
  const [rows] = await db.query(
    `SELECT DATE_FORMAT(block_start, '%Y-%m-%d %H:%i:%s') AS s,
            DATE_FORMAT(block_end,   '%Y-%m-%d %H:%i:%s') AS e
       FROM firm_blocks
      WHERE active = 1
        AND block_start < ?
        AND block_end   > ?`,
    [toWall, fromWall]
  );
  return rows;
}

/** Half-open overlap test on wall strings (lexicographic-safe format). */
function _overlapsAny(blocks, startWall, endWall) {
  return blocks.some(b => b.s < endWall && b.e > startWall);
}

/**
 * The offer grid: HORIZON_DAYS days × WINDOWS, each window marked available
 * iff its start is in the future AND it overlaps no active firm block.
 * One firm_blocks fetch covers the whole horizon.
 */
async function _buildGrid(db, now = nowLocal()) {
  const horizonStart = now.startOf('day');
  const horizonEnd   = horizonStart.plus({ days: HORIZON_DAYS });
  const blocks = await _fetchBlocks(
    db, horizonStart.toFormat(WALL_FMT), horizonEnd.toFormat(WALL_FMT)
  );

  const nowWall = now.toFormat(WALL_FMT);
  const days = [];
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const day = horizonStart.plus({ days: i });
    const dateStr = day.toFormat('yyyy-MM-dd');
    const windows = WINDOWS.map(w => {
      const { start, end } = windowBounds(dateStr, w);
      const sWall = start.toFormat(WALL_FMT);
      const eWall = end.toFormat(WALL_FMT);
      const available = sWall > nowWall && !_overlapsAny(blocks, sWall, eWall);
      return { key: w.key, label: w.label, available };
    });
    days.push({ date: dateStr, label: dayLabel(day), windows });
  }
  return days;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPEN-REQUEST LOOKUP (dedupe + pending display + cancel target)
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct portal-visible case ids (Primary/Secondary) for the contact. */
async function _visibleCaseIds(db, contactId) {
  const [rows] = await db.query(
    `SELECT DISTINCT cr.case_relate_case_id AS case_id
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_type IN ('Primary','Secondary')`,
    [contactId]
  );
  return rows.map(r => String(r.case_id));
}

/**
 * The contact's open callback task, if any. Open = source match + active
 * status + linked to the contact directly OR to any of their portal-visible
 * cases (single-case auto-link means the task may carry either link shape).
 */
async function _openRequest(db, contactId, caseIds) {
  const ids = caseIds || await _visibleCaseIds(db, contactId);
  const caseClause = ids.length
    ? `OR (t.task_link_type = 'case' AND t.task_link_id IN (${ids.map(() => '?').join(',')}))`
    : '';
  const [rows] = await db.query(
    `SELECT t.task_id, t.task_to,
            DATE_FORMAT(t.task_start, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(t.task_date,  '%Y-%m-%d %H:%i:%s') AS created_at
       FROM tasks t
      WHERE t.task_source = ?
        AND t.task_status IN (${OPEN_STATUSES.map(() => '?').join(',')})
        AND (
          (t.task_link_type = 'contact' AND t.task_link_id = ?)
          ${caseClause}
        )
      ORDER BY t.task_id DESC
      LIMIT 1`,
    [SOURCE, ...OPEN_STATUSES, String(contactId), ...ids]
  );
  return rows[0] || null;
}

/**
 * Recover the window facts for a pending task from its reminder job
 * (deterministic name — see header). Falls back to the task's start DATE
 * with no window label if the job is missing (should not happen).
 */
async function _pendingShape(db, openRow) {
  let windowLabel = null;
  let dateStr = openRow.start_date || null;
  const [jobs] = await db.query(
    `SELECT data FROM scheduled_jobs WHERE name = ? ORDER BY id DESC LIMIT 1`,
    [`${JOB_NAME_PREFIX}${openRow.task_id}`]
  );
  if (jobs[0]) {
    try {
      const data = typeof jobs[0].data === 'string'
        ? JSON.parse(jobs[0].data) : jobs[0].data;
      windowLabel = data?.params?.window_label || null;
      if (data?.params?.date) dateStr = data.params.date;
    } catch (_) { /* fall back below */ }
  }
  const day = dateStr ? DateTime.fromISO(dateStr, { zone: FIRM_TZ }) : null;
  return {
    task_id:      openRow.task_id,
    date:         dateStr,
    day_label:    day && day.isValid ? dayLabel(day) : null,
    window_label: windowLabel,
    requested_at: openRow.created_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getState
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The client's callback view: their pending request (if any), the offer
 * grid, and their phone on file (their own record — projection-safe).
 *
 * @returns {Promise<{pending: object|null, days: Array, phone: string}>}
 */
async function getState(db, contactId) {
  const caseIds = await _visibleCaseIds(db, contactId);
  const open = await _openRequest(db, contactId, caseIds);
  const pending = open ? await _pendingShape(db, open) : null;

  const days = pending ? [] : await _buildGrid(db);

  const [[contact]] = await db.query(
    'SELECT contact_phone FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  const phone = normalizePhone(contact?.contact_phone) || '';

  return { pending, days, phone };
}

// ─────────────────────────────────────────────────────────────────────────────
// createRequest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate + create a callback request. Returns the context for
 * fireCreateSideEffects (GCal), which the route calls AFTER the 200
 * (respond-first, S3 precedent). The reminder job insert is AWAITED here —
 * it is core to the feature, not garnish (judgment call, flagged).
 *
 * Throws httpError:
 *   400 — bad date/window/phone/message
 *   409 — an open request already exists (err.pending carries its shape)
 *
 * @param {object} db
 * @param {number} contactId
 * @param {object} body  { date:'YYYY-MM-DD', window:'14-16', phone, message }
 */
async function createRequest(db, contactId, { date, window: windowKey, phone, message } = {}) {
  // ── Validation ──────────────────────────────────────────────────────────
  const win = WINDOW_BY_KEY.get(String(windowKey || ''));
  if (!win) throw httpError(400, 'Please choose a callback window.');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw httpError(400, 'Please choose a day.');
  }
  const now = nowLocal();
  const day = DateTime.fromISO(date, { zone: FIRM_TZ }).startOf('day');
  if (!day.isValid) throw httpError(400, 'Please choose a valid day.');
  const offset = Math.round(day.diff(now.startOf('day'), 'days').days);
  if (offset < 0 || offset >= HORIZON_DAYS) {
    throw httpError(400, `Please choose a day within the next ${HORIZON_DAYS} days.`);
  }

  const { start, end } = windowBounds(date, win);
  const sWall = start.toFormat(WALL_FMT);
  const eWall = end.toFormat(WALL_FMT);
  if (sWall <= now.toFormat(WALL_FMT)) {
    throw httpError(400, 'That window has already started. Please choose a later one.');
  }

  const phone10 = normalizePhone(phone);
  if (!phone10) throw httpError(400, 'Please enter a valid 10-digit phone number.');

  const msg = String(message == null ? '' : message).trim();
  if (!msg) throw httpError(400, 'Please tell us briefly what the call is about.');
  if (msg.length > MESSAGE_MAX) {
    throw httpError(400, `Message is too long (max ${MESSAGE_MAX} characters).`);
  }

  // Only now touch the DB — every no-query rejection is already behind us.
  const blocks = await _fetchBlocks(db, sWall, eWall);
  if (_overlapsAny(blocks, sWall, eWall)) {
    throw httpError(400, 'That window is unavailable. Please choose another.');
  }

  // ── Dedupe: one open request per contact ────────────────────────────────
  const caseIds = await _visibleCaseIds(db, contactId);
  const open = await _openRequest(db, contactId, caseIds);
  if (open) {
    throw httpError(409, 'You already have a pending callback request.', {
      pending: await _pendingShape(db, open),
    });
  }

  // ── Facts ───────────────────────────────────────────────────────────────
  const [[contact]] = await db.query(
    'SELECT contact_name FROM contacts WHERE contact_id = ?',
    [contactId]
  );
  const name = String(contact?.contact_name || '').trim() || `Contact ${contactId}`;
  const shortName = name.length > TITLE_NAME_MAX
    ? name.slice(0, TITLE_NAME_MAX - 1) + '…' : name;

  const dLabel = dayLabel(day);
  const assigneeRaw = await getSetting(db, 'portal_callback_task_to');
  const assignee = parseInt(assigneeRaw, 10);
  if (!Number.isInteger(assignee) || assignee <= 0) {
    // Misconfig — surface as 500 (route catch), never assign to user 0/NaN.
    throw new Error(`portal_callback_task_to is not a valid user id: ${JSON.stringify(assigneeRaw)}`);
  }

  // Single-case auto-link (Phase A decision 4): exactly one visible case →
  // link the task to it; otherwise link to the contact.
  const link = caseIds.length === 1
    ? { link_type: 'case',    link_id: caseIds[0] }
    : { link_type: 'contact', link_id: String(contactId) };

  const title = `Callback: ${shortName} — ${dLabel}, ${win.label}`;
  const desc =
    `Client callback request via the portal.\n` +
    `Phone: ${formatPhone(phone10)}\n` +
    `Window: ${dLabel}, ${win.label}\n` +
    `Message:\n${msg}`;

  // ── Task (canonical path — owns assignment email/SMS + log) ─────────────
  const { task_id } = await taskService.createTask(db, {
    from:   0,                       // automations user (preserved, not coerced)
    to:     assignee,
    title,
    desc,
    start:  date,                    // DATE column — the callback day
    due:    null,                    // deliberately no due → no 8 AM built-in reminder
    notify: false,
    source: SOURCE,
    ...link,
  });

  // ── Reminder job at window start (awaited — core function) ──────────────
  await db.query(
    `INSERT INTO scheduled_jobs
       (type, scheduled_time, status, name, data, max_attempts, backoff_seconds)
     VALUES ('one_time', ?, 'pending', ?, ?, 2, 120)`,
    [
      start.toUTC().toJSDate(),
      `${JOB_NAME_PREFIX}${task_id}`,
      JSON.stringify({
        type: 'internal_function',
        function_name: 'portal_callback_reminder',
        params: {
          task_id,
          contact_id:   contactId,
          phone:        phone10,
          window_label: win.label,
          date,
        },
      }),
    ]
  );

  return {
    task_id,
    contact_id: contactId,
    name,
    phone10,
    message: msg,
    date,
    day_label: dLabel,
    window: win,
    start_wall: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    end_wall:   end.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    pending: {
      task_id,
      date,
      day_label: dLabel,
      window_label: win.label,
      requested_at: null,
    },
  };
}

/**
 * Post-response side effect: the transparent Google Calendar event.
 * Fire-and-forget — a calendar failure never affects the request
 * (apptService posture). transparency:'transparent' ⇒ shows as Free:
 * ignored by GCal busy time AND by the scheduler's freeBusy fetch.
 * Event id is deliberately not stored — no delete on cancel (Phase A 3a);
 * the cancel SMS tells the assignee, so a stale Free event is cosmetic.
 * Returns the settled promise for tests.
 */
function fireCreateSideEffects(db, ctx) {
  return gcalService.createEvent(db, {
    summary: `Callback window — ${ctx.name}`,
    description:
      `Portal callback request.\n` +
      `Phone: ${escapeHtml(formatPhone(ctx.phone10))}\n` +
      `Message: ${escapeHtml(ctx.message)}`,
    start: ctx.start_wall,
    end:   ctx.end_wall,
    event: { transparency: 'transparent' },
  }).catch(err =>
    console.error('[portal] callback GCal event failed:', err.message)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelRequest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cancel the contact's open callback request. Ownership is implicit: the
 * open-request lookup is scoped to the authed contact — a foreign task id
 * can never be reached. Soft-delete via taskService.deleteTask (canonical;
 * 'Cancelled' is not the vocabulary — Deleted is, per taskService header).
 * The reminder job is deliberately left pending: it checks task status at
 * fire time and skips Deleted (job-executor precedent) — zero cancellation
 * plumbing.
 *
 * Returns null when no open request exists (route → uniform 404).
 */
async function cancelRequest(db, contactId) {
  const open = await _openRequest(db, contactId);
  if (!open) return null;

  const pending = await _pendingShape(db, open);
  await taskService.deleteTask(db, open.task_id, 0, {
    source: SOURCE, canceled_by: 'client', contact_id: contactId,
  });

  const [[contact]] = await db.query(
    'SELECT contact_name FROM contacts WHERE contact_id = ?',
    [contactId]
  );

  return {
    task_id:   open.task_id,
    assignee:  open.task_to,
    name:      String(contact?.contact_name || '').trim() || `Contact ${contactId}`,
    day_label: pending.day_label,
    window_label: pending.window_label,
  };
}

/**
 * Post-response side effect: tell the assignee the client canceled.
 * SMS when allow_sms + phone; email fallback. Sender/recipient are
 * settings/DB-resolved (never hardcoded — S3.5 invariant). Returns the
 * settled promise for tests.
 */
async function fireCancelSideEffects(db, ctx) {
  try {
    const [[u]] = await db.query(
      'SELECT email, phone, allow_sms FROM users WHERE user = ?',
      [ctx.assignee]
    );
    if (!u) return;

    const when = [ctx.day_label, ctx.window_label].filter(Boolean).join(', ');
    const line = `Callback request canceled: ${ctx.name}` + (when ? ` (was ${when})` : '');

    if (u.allow_sms && u.phone) {
      const smsFrom = await taskService.getSmsFrom(db);
      if (smsFrom) {
        await phoneService.sendSms(db, smsFrom, u.phone, line);
        return;
      }
    }
    if (u.email) {
      const from = await taskService.getFromEmail(db);
      await emailService.sendEmail(db, {
        from,
        to: u.email,
        subject: `Callback request canceled — ${ctx.name}`,
        html: `<p>${escapeHtml(line)}</p>`,
      });
    }
  } catch (err) {
    console.error('[portal] callback cancel notification failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getState,
  createRequest,
  fireCreateSideEffects,
  cancelRequest,
  fireCancelSideEffects,
  // Exposed for tests (repo pattern — logService/portalCaseService precedent).
  _buildGrid,
  _openRequest,
  _visibleCaseIds,
  _normalizePhone: normalizePhone,
  _formatPhone: formatPhone,
  _escapeHtml: escapeHtml,
  WINDOWS,
  HORIZON_DAYS,
};
