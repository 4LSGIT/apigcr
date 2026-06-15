// routes/manage.js
//
/**
 * Client Manage Page Backend — Scheduler Slice 9
 * routes/manage.js
 *
 * PUBLIC (no auth — token IS the auth):
 *   GET  /m/:token                    — serve public/manage.html
 *   GET  /api/m/:token                — appt summary (first name only, no PII)
 *   GET  /api/m/:token/slots?date=    — reschedule picker slots
 *   POST /api/m/:token/cancel         — cancel (full apptService side effects)
 *   POST /api/m/:token/reschedule     — reschedule (Scheduled) or rebook
 *                                       (Canceled); same provider/type/length
 *
 * ── Authorization model ──────────────────────────────────────
 * Every request resolves :token → one appt row via appts.appt_manage_token
 * (char(32) UNIQUE, minted on every createAppt since slice 6a). Bad format
 * and unknown token return the SAME 404 — no oracle distinguishing "bad
 * token" from "no such appt". Legacy rows with NULL token are simply
 * unreachable. This is deliberately shaped as "resolve to an appt you may
 * touch" so the future portal can feed session→contact→appt into the same
 * handlers.
 *
 * ── View-independence for CONSTRAINTS; view linkage for BRANDING ──
 * Constraints come from the appt row (appt_with / appt_length / appt_type)
 * + app_settings — never from booking_views. Slice 9b adds
 * appts.appt_view_id (stored at booking time — no source_tag inference),
 * used here ONLY for branding: the originating view's logo / accent / link
 * win over the firm-wide fe-* defaults, so each part of the firm sees its
 * own look. A deleted view degrades to firm branding, never breaks.
 * Reschedule/rebook keep provider, type, length identical; changing those
 * = call the office.
 *
 * ── Rebook-from-Canceled (unbounded) ─────────────────────────
 * A Canceled appt's page is NOT terminal: it offers "pick a new time".
 * POST /reschedule on a Canceled appt does a direct createAppt copy
 * (provider/type/length/platform/case/view carried over; hook event
 * 'rebooked' with rescheduled_from) — it must NOT call rescheduleAppt,
 * which would flip the Canceled row to 'Rescheduled' and falsify history.
 * The old row stays Canceled and gets a log entry pointing at the new
 * appt. Rescheduled / Attended / No Show remain terminal.
 *
 * ── Settings (seeded by the slice-9 migration, is_editable=1) ─
 *   manage_cutoff_min          240  — no self-service inside this window
 *   manage_horizon_days        30   — reschedule picker bound
 *   manage_reschedule_template ''   — optional SMS (resolver), '' = no SMS
 *   manage_cancel_template     ''   — optional SMS (resolver), '' = no SMS
 *   fe-firm_phone (optional, not seeded) — shown in "call us" copy when set
 *
 * ── Anti-abuse ───────────────────────────────────────────────
 * Same in-memory fixed-window limiter pattern as routes/booking.js
 * (per-instance, Cloud Run best-effort). Reads 30/min/IP, mutations
 * 5/10min/IP. Mutation overflow returns a REAL 429 — booking's
 * "silent fake success" is wrong here: faking success on a cancel would
 * leave the client believing a still-live appt is gone. Token-gated
 * endpoints don't need the bot-ambiguity trick anyway.
 *
 * ── Concurrency ──────────────────────────────────────────────
 * Reschedule runs under the SAME per-provider named lock key as booking
 * (`book:<provider>`), on a dedicated connection (named locks are
 * session-scoped — see booking.js bookUnderLock). Inside the lock:
 * re-read appt status, re-derive the slot via getSlots (min_notice =
 * cutoff), only then rescheduleAppt. Slot gone → 409 slot_taken.
 * NOTE: the lock helper here mirrors booking.js's bookUnderLock rather
 * than sharing code — extracting both into lib/providerLock.js is a safe
 * follow-up but was not worth touching the live booking pipeline for.
 *
 * Auto-mounts via the routes/ scan in server.js. /m/:token and /api/m/…
 * are ≥2 path segments, so the single-segment GET /:page static catch-all
 * never intercepts them (same reasoning as /p/:slug, /book/:slug).
 */

const express = require('express');
const path    = require('path');
const { DateTime } = require('luxon');

const router = express.Router();

const { getSlots }    = require('../services/availabilityService');
const apptService     = require('../services/apptService');
const phoneService    = require('../services/phoneService');
const { resolve: resolveTemplate } = require('../services/resolverService');
const { getSettings } = require('../services/settingsService');
const { FIRM_TZ }     = require('../services/timezoneService');
const { alert }       = require('../lib/alerting');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const TOKEN_RE = /^[0-9a-f]{32}$/;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const START_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const LOCK_TIMEOUT_SECONDS = 10;   // matches booking.js / oauthService
const SLOT_GRANULARITY     = 15;   // locked: manage picker grid
const SLOT_BUFFER_MIN      = 0;    // locked: no buffer on manage reschedules

const DEFAULT_CUTOFF_MIN   = 240;
const DEFAULT_HORIZON_DAYS = 30;

// ─────────────────────────────────────────────────────────────
// Helpers — IP + rate limiting (pattern copied from routes/booking.js)
// ─────────────────────────────────────────────────────────────

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

function makeLimiter(windowMs, max) {
  const buckets = new Map(); // ip -> { windowStart, count }
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, b] of buckets) {
      if (b.windowStart < cutoff) buckets.delete(ip);
    }
  }, 5 * 60 * 1000).unref();

  return function limited(ip) {
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.windowStart >= windowMs) {
      b = { windowStart: now, count: 0 };
      buckets.set(ip, b);
    }
    b.count += 1;
    return b.count > max;
  };
}

const readLimited = makeLimiter(60 * 1000, 30);      // GET summary + slots
const postLimited = makeLimiter(10 * 60 * 1000, 5);  // cancel / reschedule

// ─────────────────────────────────────────────────────────────
// Helpers — settings, appt loading, modifiability
// ─────────────────────────────────────────────────────────────

/** Manage settings with hard defaults; bad values fall back. */
async function loadManageSettings(db) {
  const s = await getSettings(db, [
    'manage_cutoff_min',
    'manage_horizon_days',
    'manage_reschedule_template',
    'manage_cancel_template',
    'manage_fallback_url',
    'fe-firm_logo_url',
    'fe-firm_site_url',
    'fe-firm_phone',
  ]);
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    cutoff_min:          num(s.manage_cutoff_min, DEFAULT_CUTOFF_MIN),
    horizon_days:        num(s.manage_horizon_days, DEFAULT_HORIZON_DAYS),
    reschedule_template: (s.manage_reschedule_template || '').trim(),
    cancel_template:     (s.manage_cancel_template || '').trim(),
    fallback_url_raw:    (s.manage_fallback_url || '').trim() || null,  // slice 10: JSON {url, button_text}
    firm_logo_url:       s['fe-firm_logo_url'] || null,
    firm_site_url:       s['fe-firm_site_url'] || null,
    firm_phone:          s['fe-firm_phone'] || null,   // optional — omit when unset
  };
}

/**
 * Slice 10 — booking-CTA fallback for any state with NO in-page action
 * (invalid/unknown token, or a terminal/non-rebookable appt). Resolution
 * chain: manage_fallback_url → fe-firm_site_url → none ("call us").
 *
 * manage_fallback_url has ONE canonical shape — a JSON object
 *   { "url": "https://…", "button_text": "Book now!" }   (button_text optional)
 * There is NO bare-URL form. A missing/blank setting, invalid JSON, or a url
 * that isn't http(s) is treated as unset and falls through to the firm site,
 * then to the call-us copy. The page never customizes the *message* — it keeps
 * its own per-state copy (invalid-link line / status-specific terminal line);
 * the setting controls only the button label + destination.
 *
 * PRECEDENCE (load-bearing): consulted ONLY when a token resolves to nothing
 * actionable. A valid token resolving to a Canceled+rebookable appt ALWAYS
 * shows its own rebook picker — the scoped page wins; the fallback never
 * overrides it. See renderActionState() in manage.html.
 */
function resolveFallback(cfg) {
  if (cfg.fallback_url_raw) {
    try {
      const o = JSON.parse(cfg.fallback_url_raw);
      const url = o && typeof o.url === 'string' ? o.url.trim() : '';
      if (/^https?:\/\//i.test(url)) {
        const bt = (o && typeof o.button_text === 'string' && o.button_text.trim())
          ? o.button_text.trim()
          : 'Book a new time \u2192';
        return { kind: 'book', url, button_text: bt };
      }
      console.warn('[manage] manage_fallback_url has no valid http(s) "url" — ignoring');
    } catch (e) {
      console.warn('[manage] manage_fallback_url is not valid JSON — ignoring:', e.message);
    }
  }
  if (cfg.firm_site_url) {
    return { kind: 'site', url: cfg.firm_site_url, button_text: 'Visit our website \u2192' };
  }
  return { kind: 'none', url: null, button_text: null };
}

/**
 * Slice 10 — the token-contact's OTHER upcoming Scheduled appts.
 *
 * Portal-stable projection — expose ONLY type / start / provider_name /
 * manage_token. NEVER an id or any contact PII: it is the SAME contact, so
 * there is nothing new to echo. A row whose appt_manage_token is NULL
 * (legacy / Pabbly — 2141 of 2146 rows today) is returned with
 * manage_token:null and MUST render as plain text; the page must never
 * borrow the current page's token for it.
 *
 * "now" is computed firm-local (Luxon, FIRM_TZ) and compared against
 * appt_date, which is a firm-local naive datetime — so the `>` is correct
 * regardless of the MySQL session timezone (same reasoning the rest of the
 * scheduler uses for appt_date). Ascending, capped at 10.
 *
 * This is the read the future client portal will reuse for its appt list
 * (session→contact→appt feeds the same projection) — keep it minimal.
 */
async function loadOtherUpcoming(db, appt) {
  const clientId = appt.appt_client_id;
  if (!clientId) return [];
  const nowLocal = DateTime.now().setZone(FIRM_TZ).toFormat('yyyy-MM-dd HH:mm:ss');
  const [rows] = await db.query(
    `SELECT a.appt_type AS type,
            DATE_FORMAT(a.appt_date, '%Y-%m-%d %H:%i') AS start,
            a.appt_manage_token AS manage_token,
            u.user_real_name, u.user_name
       FROM appts a
       LEFT JOIN users u ON u.user = a.appt_with
      WHERE a.appt_client_id = ?
        AND a.appt_status    = 'Scheduled'
        AND a.appt_date      > ?
        AND a.appt_id       <> ?
      ORDER BY a.appt_date ASC
      LIMIT 10`,
    [clientId, nowLocal, appt.appt_id]
  );
  return rows.map(r => ({
    type:          r.type || null,
    start:         r.start,                              // 'YYYY-MM-DD HH:mm' firm-local
    provider_name: r.user_real_name || r.user_name || null,
    manage_token:  r.manage_token || null,               // null → page renders text, no link
  }));
}

/**
 * Resolve token → appt row (+ contact first name + provider name).
 * Uniform null on bad-format AND unknown token — callers 404 both.
 * appt_date is fetched as a DATE_FORMAT string so the mysql2
 * timezone:"Z" fake-UTC Date wrapping never enters the picture
 * (same convention as availabilityService).
 */
async function loadApptByToken(db, token) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const [[row]] = await db.query(
    `SELECT a.appt_id, a.appt_client_id, a.appt_case_id, a.appt_status,
            a.appt_type, a.appt_platform, a.appt_length, a.appt_with,
            a.appt_view_id,
            DATE_FORMAT(a.appt_date, '%Y-%m-%d %H:%i') AS appt_start,
            c.contact_fname,
            u.user_real_name, u.user_name,
            bv.logo_url      AS view_logo_url,
            bv.logo_link_url AS view_logo_link_url,
            bv.accent_color  AS view_accent_color
       FROM appts a
       LEFT JOIN contacts      c  ON c.contact_id = a.appt_client_id
       LEFT JOIN users         u  ON u.user = a.appt_with
       LEFT JOIN booking_views bv ON bv.id = a.appt_view_id
      WHERE a.appt_manage_token = ?
      LIMIT 1`,
    [token]
  );
  return row || null;
}

/** Firm-local "today" at start of day. */
function firmToday() {
  return DateTime.now().setZone(FIRM_TZ).startOf('day');
}

/** Is 'YYYY-MM-DD' within [today, today + horizonDays] firm-local? */
function dateWithinHorizon(dateStr, horizonDays) {
  const d = DateTime.fromISO(dateStr, { zone: FIRM_TZ }).startOf('day');
  if (!d.isValid) return false;
  const today = firmToday();
  return d >= today && d <= today.plus({ days: Math.max(0, horizonDays) });
}

/**
 * can_modify = Scheduled AND start > now + cutoff AND sane appt_length.
 * (A NULL/invalid appt_length can't be re-verified through getSlots, so
 * such rows — legacy-shaped — are view-only; staff handle changes.)
 */
function computeCanModify(appt, cutoffMin) {
  if (appt.appt_status !== 'Scheduled') return false;
  const len = Number(appt.appt_length);
  if (!Number.isInteger(len) || len < 1) return false;
  const startDt = DateTime.fromFormat(appt.appt_start, 'yyyy-MM-dd HH:mm', { zone: FIRM_TZ });
  if (!startDt.isValid) return false;
  const earliest = DateTime.now().setZone(FIRM_TZ).plus({ minutes: cutoffMin });
  return startDt > earliest;
}

/**
 * can_rebook = Canceled AND sane appt_length (same getSlots requirement).
 * Unbounded by design — an old canceled appt's link booking a fresh slot
 * is lead reactivation; the log records the client-initiated provenance.
 */
function computeCanRebook(appt) {
  if (appt.appt_status !== 'Canceled') return false;
  const len = Number(appt.appt_length);
  return Number.isInteger(len) && len >= 1;
}

const NOT_FOUND = { status: 'error', code: 'not_found' };

// ─────────────────────────────────────────────────────────────
// Optional template SMS (fire-and-forget, resolver placeholders)
// ─────────────────────────────────────────────────────────────

/**
 * Resolve `template` against {contacts, appts} refs and SMS the contact via
 * sms_default_from. Empty template / missing phone / missing sender → no-op.
 * Never affects the response; failures alert.
 */
function fireManageSms(db, template, { contactId, apptId, kind }) {
  if (!template) return;
  (async () => {
    const r = await resolveTemplate({
      db,
      text:   template,
      refs:   { contacts: { contact_id: contactId }, appts: { appt_id: apptId } },
      strict: false,
    });
    const message = (r.text || '').trim();
    if (!message) return;
    if (r.unresolved?.length) {
      console.warn(`[manage] ${kind} template left unresolved placeholders:`, r.unresolved);
    }
    const settings = await getSettings(db, ['sms_default_from']);
    const [[contact]] = await db.query(
      'SELECT contact_phone FROM contacts WHERE contact_id = ?',
      [contactId]
    );
    if (contact?.contact_phone && settings.sms_default_from) {
      await phoneService.sendSms(db, settings.sms_default_from, contact.contact_phone, message);
    }
  })().catch(err => alert(db, {
    source: 'app', kind: `manage_${kind}_sms_failed`, severity: 'error',
    group_key: `manage_sms:${kind}`,
    title: `Manage-page ${kind} SMS failed`,
    message: `appt=${apptId} contact=${contactId}: ${err.message}`,
  }));
}

// ─────────────────────────────────────────────────────────────
// GET /m/:token — page shell
// ─────────────────────────────────────────────────────────────

router.get('/m/:token', (req, res) => {
  // Serve the shell even for garbage tokens — the page itself renders the
  // friendly invalid-link state after its API fetch 404s. (Cheaper than a
  // DB hit per page load, and the API is the uniform oracle anyway.)
  const file = path.join(__dirname, '..', 'public', 'manage.html');
  res.sendFile(file, err => {
    if (err) res.status(404).type('text').send('Not found');
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/manage-config — public, token-less (slice 10)
//
// The invalid-token page has NO appt to read (its /api/m/:token GET 404s),
// so it fetches the resolved booking-CTA fallback here instead of dead-ending.
// Returns ONLY firm-public config (a booking/site URL + the office phone —
// both already public on the firm website); no per-appt or contact data, so
// no token and no rate limit. Distinct 2-segment path → never shadows
// /api/m/:token or the single-segment static catch-all.
// ─────────────────────────────────────────────────────────────

router.get('/api/manage-config', async (req, res) => {
  try {
    const cfg = await loadManageSettings(req.db);
    const fb  = resolveFallback(cfg);
    res.json({
      fallback: {                 // { kind:'book'|'site'|'none', url, button_text }
        kind:        fb.kind,
        url:         fb.url,
        button_text: fb.button_text,
      },
      logo_url:      cfg.firm_logo_url,   // firm logo (no view to brand from on a bad token)
      logo_link_url: cfg.firm_site_url,
      firm_phone:    cfg.firm_phone,
    });
  } catch (err) {
    console.error('GET /api/manage-config error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/m/:token — appt summary
// ─────────────────────────────────────────────────────────────

router.get('/api/m/:token', async (req, res) => {
  try {
    if (readLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const appt = await loadApptByToken(req.db, req.params.token);
    if (!appt) return res.status(404).json(NOT_FOUND);

    const cfg = await loadManageSettings(req.db);

    // Canceled appts: surface the cancel date so the banner reads as a
    // past-tense statement about THIS appt — a client who already rebooked
    // must not misread it as their rebooking having failed. Source: the
    // latest 'Canceled' appt-log entry (appts has no status timestamp).
    // Indexed via idx_log_link_type_id; runs only on Canceled page loads.
    let canceledOn = null;
    if (appt.appt_status === 'Canceled') {
      try {
        const [[row]] = await req.db.query(
          `SELECT DATE_FORMAT(log_date, '%Y-%m-%d') AS d
             FROM log
            WHERE log_type = 'appt'
              AND ((log_link_type = 'case'    AND log_link_id = ?)
                OR (log_link_type = 'contact' AND log_link_id = ?))
              AND log_data LIKE ?
              AND log_data LIKE '%"Status":"Canceled"%'
            ORDER BY log_id DESC
            LIMIT 1`,
          [String(appt.appt_case_id || ''), String(appt.appt_client_id || ''),
           `%"Appt ID":"${appt.appt_id}"%`]
        );
        canceledOn = row?.d || null;
      } catch (e) {
        console.warn('[manage] canceled_on lookup failed:', e.message); // copy degrades, page works
      }
    }

    // Slice 10: same-contact other upcoming appts (portal-stable projection)
    // + resolved booking-CTA fallback (used by terminal/non-rebookable
    // states; never overrides a rebookable Canceled appt — see precedence
    // note on resolveFallback()).
    const others = await loadOtherUpcoming(req.db, appt);
    const fb     = resolveFallback(cfg);

    // First name ONLY — no last name, phone, email, or ids anywhere here.
    res.json({
      status: appt.appt_status,
      appt: {
        type:          appt.appt_type,
        platform:      appt.appt_platform,
        start:         appt.appt_start,            // 'YYYY-MM-DD HH:mm' firm-local
        length:        Number(appt.appt_length) || null,
        provider_name: appt.user_real_name || appt.user_name || null,
        contact_first: appt.contact_fname || null,
      },
      can_modify:   computeCanModify(appt, cfg.cutoff_min),
      can_rebook:   computeCanRebook(appt),
      canceled_on:  canceledOn,                    // 'YYYY-MM-DD' | null (Canceled only)
      cutoff_min:   cfg.cutoff_min,
      horizon_days: cfg.horizon_days,
      others,                                      // [] or [{type,start,provider_name,manage_token}]
      // Booking-CTA fallback for no-action states (page decides when to use).
      fallback: {                                  // { kind, url, button_text }
        kind:        fb.kind,
        url:         fb.url,
        button_text: fb.button_text,
      },
      // Branding: originating view (appt_view_id) wins; firm-wide fe-*
      // settings are the fallback for internal/legacy/view-deleted appts.
      logo_url:      appt.view_logo_url      || cfg.firm_logo_url,
      logo_link_url: appt.view_logo_link_url || cfg.firm_site_url,
      accent_color:  appt.view_accent_color  || null,   // null → page default
      firm_phone:    cfg.firm_phone,               // null → page omits the number
    });
  } catch (err) {
    console.error('GET /api/m/:token error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/m/:token/slots?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────

router.get('/api/m/:token/slots', async (req, res) => {
  try {
    if (readLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const appt = await loadApptByToken(req.db, req.params.token);
    if (!appt) return res.status(404).json(NOT_FOUND);

    const cfg = await loadManageSettings(req.db);
    if (!computeCanModify(appt, cfg.cutoff_min) && !computeCanRebook(appt)) {
      return res.status(409).json({ status: 'error', code: 'not_modifiable' });
    }

    const dateStr = String(req.query.date || '');
    if (!DATE_RE.test(dateStr)) {
      return res.status(400).json({ status: 'error', code: 'invalid_date' });
    }
    if (!dateWithinHorizon(dateStr, cfg.horizon_days)) {
      return res.json({ success: true, slots: [] }); // valid date, out of window
    }

    // Constraints from the appt row — view-independent (locked).
    // min_notice = cutoff: nothing bookable inside the no-self-service window.
    // The appt's own current interval is busy (appts subtraction), so "its
    // own slot" generally won't appear — harmless either way.
    const perProvider = await getSlots(req.db, {
      providerIds:    [Number(appt.appt_with)],
      appt_length:    Number(appt.appt_length),
      buffer_min:     SLOT_BUFFER_MIN,
      from:           dateStr,
      to:             dateStr,
      granularity:    SLOT_GRANULARITY,
      min_notice_min: cfg.cutoff_min,
    });
    res.json({ success: true, slots: perProvider[Number(appt.appt_with)] || [] });
  } catch (err) {
    console.error('GET /api/m/:token/slots error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/m/:token/cancel
// ─────────────────────────────────────────────────────────────

router.post('/api/m/:token/cancel', async (req, res) => {
  try {
    if (postLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const appt = await loadApptByToken(req.db, req.params.token);
    if (!appt) return res.status(404).json(NOT_FOUND);

    const cfg = await loadManageSettings(req.db);
    if (!computeCanModify(appt, cfg.cutoff_min)) {
      return res.status(409).json({ status: 'error', code: 'not_modifiable' });
    }

    try {
      await apptService.cancelAppt(req.db, {
        appt_id:      appt.appt_id,
        note:         '[Canceled by client via manage link]',
        cancel_gcal:  true,
        actingUserId: 0,
      });
    } catch (err) {
      // Two-tab race: the guard above read 'Scheduled' but another request
      // canceled first. The client's goal is achieved — report success.
      if (/already Canceled/i.test(err.message || '')) {
        return res.json({ success: true });
      }
      throw err;
    }

    fireManageSms(req.db, cfg.cancel_template, {
      contactId: appt.appt_client_id,
      apptId:    appt.appt_id,
      kind:      'cancel',
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/m/:token/cancel error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/m/:token/reschedule  { start: 'YYYY-MM-DD HH:mm' }
// ─────────────────────────────────────────────────────────────

router.post('/api/m/:token/reschedule', async (req, res) => {
  try {
    if (postLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const appt = await loadApptByToken(req.db, req.params.token);
    if (!appt) return res.status(404).json(NOT_FOUND);

    const cfg = await loadManageSettings(req.db);
    const mayReschedule = computeCanModify(appt, cfg.cutoff_min); // Scheduled path
    const mayRebook     = computeCanRebook(appt);                 // Canceled path
    if (!mayReschedule && !mayRebook) {
      return res.status(409).json({ status: 'error', code: 'not_modifiable' });
    }

    // ── New start: parses, within horizon, ≥ now + cutoff ──
    const start = String((req.body || {}).start || '');
    if (!START_RE.test(start)) {
      return res.status(400).json({ status: 'error', code: 'invalid_start' });
    }
    const startDt = DateTime.fromFormat(start, 'yyyy-MM-dd HH:mm', { zone: FIRM_TZ });
    if (!startDt.isValid) {
      return res.status(400).json({ status: 'error', code: 'invalid_start' });
    }
    const dateStr = start.slice(0, 10);
    if (!dateWithinHorizon(dateStr, cfg.horizon_days)) {
      return res.status(400).json({ status: 'error', code: 'outside_horizon' });
    }
    const earliest = DateTime.now().setZone(FIRM_TZ).plus({ minutes: cfg.cutoff_min });
    if (startDt < earliest) {
      return res.status(409).json({ status: 'error', code: 'slot_taken' });
    }

    // ── Same per-provider named lock as booking (`book:<provider>`),
    //    held on a DEDICATED connection (named locks are session-scoped;
    //    pool-level query() could acquire and "release" on different
    //    sessions and leak the lock — see booking.js bookUnderLock). ──
    const providerId = Number(appt.appt_with);
    const lockKey = `book:${providerId}`;
    const conn = await req.db.getConnection();
    let locked = false;
    let result = null;
    try {
      const [[lockRes]] = await conn.query(
        'SELECT GET_LOCK(?, ?) AS lockAcquired',
        [lockKey, LOCK_TIMEOUT_SECONDS]
      );
      if (lockRes?.lockAcquired !== 1) {
        throw new Error(`Could not acquire booking lock for provider ${providerId}`);
      }
      locked = true;

      // Status re-read on the locked session decides the branch —
      // rescheduleAppt itself does NOT guard status, and calling it on a
      // Canceled row would flip it to 'Rescheduled' (falsified history).
      // Scheduled → reschedule; Canceled → rebook (direct createAppt copy);
      // anything else (raced into Rescheduled/Attended/No Show) → 409.
      const [[freshAppt]] = await conn.query(
        'SELECT appt_status FROM appts WHERE appt_id = ? LIMIT 1',
        [appt.appt_id]
      );
      const freshStatus = freshAppt && freshAppt.appt_status;
      if (!((freshStatus === 'Scheduled' && mayReschedule) ||
            (freshStatus === 'Canceled'  && mayRebook))) {
        return res.status(409).json({ status: 'error', code: 'not_modifiable' });
      }

      // Authoritative slot re-check on the locked session's view.
      const fresh = await getSlots(conn, {
        providerIds:    [providerId],
        appt_length:    Number(appt.appt_length),
        buffer_min:     SLOT_BUFFER_MIN,
        from:           dateStr,
        to:             dateStr,
        granularity:    SLOT_GRANULARITY,
        min_notice_min: cfg.cutoff_min,
      });
      if (!(fresh[providerId] || []).includes(start)) {
        return res.status(409).json({ status: 'error', code: 'slot_taken' });
      }

      // Same provider, type, length, platform on both branches. The named
      // lock (held on `conn`) serializes check+insert; createAppt's own
      // transaction runs on its own pool connection, same as booking.
      if (freshStatus === 'Scheduled') {
        // rescheduleAppt forwards appt_view_id + fires the view hook with
        // event 'rescheduled' (slice 9b — centralized in apptService).
        const r = await apptService.rescheduleAppt(req.db, {
          appt_id:      appt.appt_id,
          newDate:      `${start}:00`,
          note:         '[Rescheduled by client via manage link]',
          actingUserId: 0,
        });
        result = { new_appt_id: r.new_appt_id, mode: 'rescheduled' };
      } else {
        // Rebook: old row stays Canceled (its 'canceled' hook event already
        // fired). Direct createAppt copy; hook event 'rebooked' references
        // the canceled appt.
        const r = await apptService.createAppt(req.db, {
          contact_id:    appt.appt_client_id,
          case_id:       appt.appt_case_id || '',
          appt_length:   Number(appt.appt_length),
          appt_type:     appt.appt_type,
          appt_platform: appt.appt_platform,
          appt_date:     `${start}:00`,
          appt_with:     Number(appt.appt_with),
          note:          '[Rebooked by client via manage link]',
          appt_view_id:  appt.appt_view_id,
          hook_event:    'rebooked',
          hook_rescheduled_from: appt.appt_id,
          actingUserId:  0,
        });
        result = { new_appt_id: r.appt_id, mode: 'rebooked' };
        // Log on the old (still-Canceled) appt so staff see the link.
        apptService.insertApptLog(req.db, appt.appt_id, 0, {
          'New Appt': r.appt_id,
          Note: 'Rebooked by client via manage link',
        }).catch(e => console.error('[manage] rebook log failed:', e.message));
      }
    } finally {
      if (locked) {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockKey])
          .catch(e => console.error('[manage] RELEASE_LOCK failed:', e.message));
      }
      conn.release();
    }

    // New appt's manage token (createAppt mints one on every insert).
    const [[newRow]] = await req.db.query(
      'SELECT appt_manage_token FROM appts WHERE appt_id = ? LIMIT 1',
      [result.new_appt_id]
    );

    // Optional reschedule SMS — resolved against the NEW appt (covers
    // rebooks too; one client-facing template for "you have a new time").
    fireManageSms(req.db, cfg.reschedule_template, {
      contactId: appt.appt_client_id,
      apptId:    result.new_appt_id,
      kind:      'reschedule',
    });

    res.json({
      success:   true,
      mode:      result.mode,            // 'rescheduled' | 'rebooked'
      new_token: newRow?.appt_manage_token || null,
      start,
    });
  } catch (err) {
    console.error('POST /api/m/:token/reschedule error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

module.exports = router;