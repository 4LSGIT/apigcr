// routes/api.calendarFeed.js
//
/**
 * Calendar Feed API — Scheduler Slice 7
 *
 * GET /api/calendar-feed   unified FullCalendar-shaped feed for the internal
 *                          calendar (public/calendar.html)
 *
 * Query params:
 *   from, to    YYYY-MM-DD firm-local civil dates, inclusive (required;
 *               from ≤ to, span capped at 62 days)
 *   providers   csv of users.user ids. Default: all does_appts=1 users.
 *               Unknown ids are dropped silently.
 *   show        csv of item kinds: taken,events,blocked,free
 *               Default: taken,events,blocked. Unknown tokens → 400.
 *
 * Response: {
 *   status: 'success',
 *   providers: [{ id, name, color }],   // resolved provider set → UI legend
 *   free_skipped: bool,                 // true when 'free' was requested but
 *                                       // the span exceeds 14 days (compute cap)
 *   items: [ ...FullCalendar event objects... ]
 * }
 *
 * Item kinds (extendedProps.kind):
 *   'appt'  — appts, appt_status='Scheduled', appt_with ∈ providers.
 *             title '<type> — <contact name>', colored by provider.
 *   'event' — events, event_status='Scheduled'. Timed rows render like appts
 *             (NULL event_length → 60 min) in a neutral color; all-day rows
 *             render as allDay:true entries (court deadlines stay visible,
 *             never background-styled). Provider filter: event_with ∈
 *             providers OR event_with IS NULL (null = firm-wide).
 *   'block' — firm_blocks (active; not provider-scoped) + availability_blocks
 *             (active, user ∈ providers) as display:'background' items.
 *   'free'  — only when requested: per-provider open WINDOWS derived from
 *             availabilityService.getSlots (length 15 / granularity 15 /
 *             buffer 0 / min_notice 0 — "where could anything go", not
 *             type-specific). Contiguous 15-min slot starts are merged back
 *             into windows server-side so the UI gets a handful of green
 *             background bands, not hundreds of chips.
 *
 * ── Timezone model (binding — matches availabilityService) ──
 * appt_date / event_date+event_time / *_blocks are all stored firm-local
 * naive. Every datetime is fetched via DATE_FORMAT/TIME_FORMAT strings (so
 * mysql2's timezone wrapping never enters the picture) and emitted as
 * ZONE-LESS ISO strings ('YYYY-MM-DDTHH:mm:ss'). FullCalendar (timeZone
 * 'local', the firm's convention everywhere else in the app) renders them
 * as wall time. No UTC conversion anywhere in this file; the Luxon math
 * below uses zone:'utc' purely as a fixed-offset wall-clock calculator.
 */

const express     = require('express');
const router      = express.Router();
const { DateTime } = require('luxon');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { getSlots } = require('../services/availabilityService');

const DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 62;  // month grid (≤42 days) + slack
const MAX_FREE_DAYS  = 14;  // free-window computation cap (getSlots is heavier)
const FREE_GRID_MIN  = 15;  // grid AND probe length for free windows

const SHOW_TOKENS  = new Set(['taken', 'events', 'blocked', 'free']);
const DEFAULT_SHOW = ['taken', 'events', 'blocked'];

// Deterministic provider colors: index by user id mod palette length.
// 10 entries keeps the current provider ids (1, 6, 22) collision-free;
// a future id collision is cosmetic only.
const PROVIDER_PALETTE = [
  '#0ea5e9', // 0 sky
  '#2563eb', // 1 blue   (Stuart today)
  '#d97706', // 2 amber
  '#dc2626', // 3 red
  '#0d9488', // 4 teal
  '#db2777', // 5 pink
  '#16a34a', // 6 green  (Fred today)
  '#9333ea', // 7 purple
  '#ca8a04', // 8 gold
  '#4f46e5', // 9 indigo (Rena today: 22 % 10 = 2 → amber)
];
const EVENT_COLOR = '#64748b'; // neutral slate — distinct from the palette
const BLOCK_COLOR = '#9ca3af'; // muted gray  (FullCalendar bg-opacity applies)
const FREE_COLOR  = '#22c55e'; // green       (FullCalendar bg-opacity applies)

function providerColor(id) {
  const n = PROVIDER_PALETTE.length;
  return PROVIDER_PALETTE[((Number(id) % n) + n) % n];
}

/**
 * Pure wall-clock minute arithmetic on a naive 'YYYY-MM-DDTHH:mm[:ss]'
 * string. zone:'utc' = fixed offset, so this is plain calendar math with
 * no DST surprises regardless of server timezone.
 */
function addMinutesNaive(naiveIso, minutes) {
  const dt = DateTime.fromISO(naiveIso, { zone: 'utc' });
  return dt.plus({ minutes }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/**
 * Merge an ascending list of 'YYYY-MM-DD HH:mm' slot starts (grid =
 * FREE_GRID_MIN) into [start, end) windows. A start at T means
 * [T, T+FREE_GRID_MIN) is free; consecutive starts FREE_GRID_MIN apart
 * coalesce.
 *
 * @param {string[]} starts
 * @returns {{start:string, end:string}[]} zone-less ISO window bounds
 */
function mergeSlotStartsToWindows(starts) {
  const stepMs  = FREE_GRID_MIN * 60000;
  const windows = [];
  let winStartMs = null;
  let prevMs     = null;

  const fmt = (ms) => DateTime.fromMillis(ms, { zone: 'utc' })
    .toFormat("yyyy-MM-dd'T'HH:mm:ss");

  for (const s of starts) {
    const ms = Date.parse(s.replace(' ', 'T') + ':00Z'); // naive → fixed-offset ms
    if (Number.isNaN(ms)) continue;
    if (winStartMs === null) {
      winStartMs = ms;
    } else if (ms - prevMs !== stepMs) {
      windows.push({ start: fmt(winStartMs), end: fmt(prevMs + stepMs) });
      winStartMs = ms;
    }
    prevMs = ms;
  }
  if (winStartMs !== null) {
    windows.push({ start: fmt(winStartMs), end: fmt(prevMs + stepMs) });
  }
  return windows;
}

router.get('/api/calendar-feed', jwtOrApiKey, async (req, res) => {
  try {
    const db = req.db;
    const q  = req.query;

    // ── from / to: YYYY-MM-DD, from ≤ to, ≤ 62 days ──
    const from = String(q.from || '');
    const to   = String(q.to || '');
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return res.status(400).json({ status: 'error', message: 'from and to must be YYYY-MM-DD dates' });
    }
    if (to < from) {
      return res.status(400).json({ status: 'error', message: 'to must be on or after from' });
    }
    const rangeDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
    if (rangeDays > MAX_RANGE_DAYS) {
      return res.status(400).json({ status: 'error', message: `date range may not exceed ${MAX_RANGE_DAYS} days` });
    }

    // ── show ──
    let show = DEFAULT_SHOW;
    if (q.show !== undefined && String(q.show).trim() !== '') {
      show = String(q.show).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const bad = show.filter(t => !SHOW_TOKENS.has(t));
      if (bad.length) {
        return res.status(400).json({ status: 'error', message: `Unknown show tokens: ${bad.join(', ')}` });
      }
    }
    const showSet = new Set(show);

    // ── providers: csv of users.user ids; default all does_appts=1.
    //    Unknown ids dropped; result must be non-empty. ──
    const [allUsers] = await db.query(
      'SELECT user, user_name, does_appts FROM users ORDER BY user ASC'
    );
    const byId = new Map(allUsers.map(u => [Number(u.user), u]));

    let pids;
    if (q.providers !== undefined && String(q.providers).trim() !== '') {
      const raw = String(q.providers).split(',').map(s => s.trim()).filter(Boolean).map(Number);
      if (raw.some(p => !Number.isInteger(p))) {
        return res.status(400).json({ status: 'error', message: 'providers must be a comma-separated list of integer user ids' });
      }
      pids = [...new Set(raw)].filter(p => byId.has(p));
    } else {
      pids = allUsers.filter(u => u.does_appts).map(u => Number(u.user));
    }
    if (!pids.length) {
      return res.status(400).json({ status: 'error', message: 'No valid providers resolved' });
    }

    const providers = pids.map(id => ({
      id,
      name:  byId.get(id).user_name,
      color: providerColor(id),
    }));

    // Firm-local range bounds for naive-DATETIME overlap comparisons.
    const rangeStartStr = `${from} 00:00:00`;
    const rangeEndStr   = DateTime.fromISO(to, { zone: 'utc' })
      .plus({ days: 1 }).toFormat('yyyy-MM-dd HH:mm:ss');

    const items = [];

    // ── taken — Scheduled appts for selected providers ──────────────────────
    if (showSet.has('taken')) {
      const [apRows] = await db.query(
        `SELECT a.appt_id, a.appt_type, a.appt_length, a.appt_with,
                DATE_FORMAT(a.appt_date, '%Y-%m-%dT%H:%i:%s') AS start_str,
                c.contact_id, c.contact_name
           FROM appts a
           LEFT JOIN contacts c ON a.appt_client_id = c.contact_id
          WHERE a.appt_status = 'Scheduled'
            AND a.appt_with IN (?)
            AND a.appt_date >= ? AND a.appt_date < ?
          ORDER BY a.appt_date ASC`,
        [pids, rangeStartStr, rangeEndStr]
      );

      for (const r of apRows) {
        const lenMin = Number(r.appt_length) > 0 ? Number(r.appt_length) : 60;
        const name   = r.contact_name || `Contact #${r.contact_id ?? '?'}`;
        items.push({
          id:    `appt-${r.appt_id}`,
          title: `${r.appt_type || 'Appt'} — ${name}`,
          start: r.start_str,
          end:   addMinutesNaive(r.start_str, lenMin),
          color: providerColor(r.appt_with),
          extendedProps: {
            kind: 'appt',
            appt_id:      r.appt_id,
            contact_id:   r.contact_id,
            contact_name: name,
            provider:     Number(r.appt_with),
          },
        });
      }
    }

    // ── events — Scheduled events; provider filter on event_with
    //    (NULL = firm-wide, always included) ───────────────────────────────
    if (showSet.has('events')) {
      // Resolved-case subquery mirrors eventService.RESOLVED_CASE_SUBQUERY
      // (not exported there) — equality only, dockets are opaque.
      const [evRows] = await db.query(
        `SELECT e.event_id, e.event_type, e.event_title, e.event_all_day,
                e.event_length, e.event_link_type, e.event_link_id,
                e.event_with, e.event_location,
                DATE_FORMAT(e.event_date, '%Y-%m-%d') AS event_date,
                TIME_FORMAT(e.event_time, '%H:%i:%s') AS event_time,
                co.contact_name,
                COALESCE(ca.case_number_full, ca.case_number) AS case_number_display,
                (SELECT c2.case_id FROM cases c2
                  WHERE e.event_link_type = 'case_number'
                    AND (c2.case_number = e.event_link_id OR c2.case_number_full = e.event_link_id)
                  LIMIT 1) AS resolved_case_id
           FROM events e
           LEFT JOIN contacts co ON (e.event_link_type = 'contact' AND e.event_link_id = co.contact_id)
           LEFT JOIN cases    ca ON (e.event_link_type = 'case'    AND e.event_link_id = ca.case_id)
          WHERE e.event_status = 'Scheduled'
            AND (e.event_with IS NULL OR e.event_with IN (?))
            AND e.event_date BETWEEN ? AND ?
          ORDER BY e.event_date ASC, e.event_time ASC`,
        [pids, from, to]
      );

      for (const r of evRows) {
        // Link label resolution mirrors listEvents.
        let link_label = null;
        if (r.event_link_type === 'contact') {
          link_label = r.contact_name || (r.event_link_id != null ? `Contact #${r.event_link_id}` : null);
        } else if (r.event_link_type === 'case') {
          link_label = r.case_number_display || r.event_link_id || null;
        } else if (r.event_link_type === 'case_number') {
          link_label = r.event_link_id || null; // docket verbatim (opaque)
        }

        const xp = {
          kind: 'event',
          event_id:         r.event_id,
          event_type:       r.event_type,
          event_with:       r.event_with == null ? null : Number(r.event_with),
          event_location:   r.event_location,
          link_type:        r.event_link_type,
          link_id:          r.event_link_id,
          link_label,
          resolved_case_id: r.resolved_case_id || null,
        };

        const allDay = r.event_all_day === 1 || r.event_all_day === true || r.event_time == null;
        if (allDay) {
          items.push({
            id:     `event-${r.event_id}`,
            title:  r.event_title,
            start:  r.event_date,
            allDay: true,
            color:  EVENT_COLOR,
            extendedProps: xp,
          });
        } else {
          const startStr = `${r.event_date}T${r.event_time}`;
          const lenMin   = Number(r.event_length) > 0 ? Number(r.event_length) : 60;
          items.push({
            id:    `event-${r.event_id}`,
            title: r.event_title,
            start: startStr,
            end:   addMinutesNaive(startStr, lenMin),
            color: EVENT_COLOR,
            extendedProps: xp,
          });
        }
      }
    }

    // ── blocked — firm_blocks (firm-wide) + availability_blocks (per user) ──
    if (showSet.has('blocked')) {
      const [fbRows] = await db.query(
        `SELECT block_id, label, source,
                DATE_FORMAT(block_start, '%Y-%m-%dT%H:%i:%s') AS block_start,
                DATE_FORMAT(block_end,   '%Y-%m-%dT%H:%i:%s') AS block_end
           FROM firm_blocks
          WHERE active = 1 AND block_end > ? AND block_start < ?`,
        [rangeStartStr, rangeEndStr]
      );
      for (const r of fbRows) {
        items.push({
          id:      `fb-${r.block_id}`,
          start:   r.block_start,
          end:     r.block_end,
          display: 'background',
          color:   BLOCK_COLOR,
          extendedProps: { kind: 'block', label: r.label || r.source, source: r.source },
        });
      }

      const [abRows] = await db.query(
        `SELECT id, user, reason,
                DATE_FORMAT(block_start, '%Y-%m-%dT%H:%i:%s') AS block_start,
                DATE_FORMAT(block_end,   '%Y-%m-%dT%H:%i:%s') AS block_end
           FROM availability_blocks
          WHERE active = 1 AND user IN (?)
            AND block_end > ? AND block_start < ?`,
        [pids, rangeStartStr, rangeEndStr]
      );
      for (const r of abRows) {
        items.push({
          id:      `ab-${r.id}`,
          start:   r.block_start,
          end:     r.block_end,
          display: 'background',
          color:   BLOCK_COLOR,
          extendedProps: {
            kind: 'block',
            label: r.reason || 'Blocked',
            source: 'availability_block',
            provider: Number(r.user),
          },
        });
      }
    }

    // ── free — open windows per provider (capped at 14-day spans) ──────────
    let freeSkipped = false;
    if (showSet.has('free')) {
      if (rangeDays > MAX_FREE_DAYS) {
        freeSkipped = true; // soft skip — the rest of the feed still renders
      } else {
        const slots = await getSlots(db, {
          providerIds:    pids,
          appt_length:    FREE_GRID_MIN, // probe: "where could anything go"
          buffer_min:     0,
          from, to,
          granularity:    FREE_GRID_MIN,
          min_notice_min: 0,
        });
        for (const pid of pids) {
          const windows = mergeSlotStartsToWindows(slots[pid] || []);
          windows.forEach((w, i) => {
            items.push({
              id:      `free-${pid}-${i}`,
              start:   w.start,
              end:     w.end,
              display: 'background',
              color:   FREE_COLOR,
              extendedProps: { kind: 'free', provider: pid },
            });
          });
        }
      }
    }

    res.json({ status: 'success', providers, free_skipped: freeSkipped, items });
  } catch (err) {
    console.error('GET /api/calendar-feed error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to build calendar feed' });
  }
});

module.exports = router;