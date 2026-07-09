// routes/booking.js
//
/**
 * Public Booking Backend — Scheduler Slice 6a
 * routes/booking.js
 *
 * PUBLIC (no auth):
 *   GET  /book/:slug              — serve the booking widget shell
 *                                   (public/book.html lands in slice 6b)
 *   GET  /api/book/:slug/config   — public-safe view config + ts/sig pair
 *   GET  /api/book/:slug/slots    — open slot starts for one civil day
 *   POST /api/book/:slug          — book a slot (identity → provider →
 *                                   lock → re-verify → createAppt →
 *                                   fire-and-forget confirmations; the
 *                                   view hook fires inside createAppt)
 *
 * INTERNAL (jwtOrApiKey):
 *   POST /api/contacts/:id/booking-link — mint-or-return contacts.booking_token
 *
 * ── Server-authoritative config ──────────────────────────────
 * Everything that matters (length, buffer, granularity, min_notice, horizon,
 * provider set) is re-derived from the booking_views row on every request.
 * The client never sends scheduling parameters; provider is the single
 * client-influenced knob and only in client_choice mode. The config endpoint
 * never exposes buffer, min_notice, source_tag, hook_id, confirm_template,
 * or (outside client_choice) provider_ids.
 *
 * ── Anti-abuse (all per-instance / in-memory, Cloud Run best-effort) ──
 *   - Rate limits: POSTs 5 / 10 min / IP; config+slots reads 30 / min / IP.
 *     Read overflow → 429. POST overflow → silent fake success (see below).
 *   - Honeypot: non-empty `website` field → silent fake success.
 *   - Min-fill-time: config hands out { ts, sig } where
 *     sig = HMAC-SHA256(JWT_SECRET, String(ts)). POST requires a valid pair
 *     with 3s ≤ now − ts ≤ 2h.
 *       too-fast (<3s)   → silent fake success (bot signal)
 *       bad sig          → 400 invalid_request (tampered)
 *       stale (>2h)      → 400 stale_form (legit user with an old tab —
 *                          recoverable: "refresh the page")
 *   "Silent fake success" returns the normal { success, thankyou_html }
 *   response without creating anything — bots can't distinguish it.
 *   Client IP = cf-connecting-ip falling back to req.ip (same convention
 *   as routes/pageLanding.js; trust proxy is 1).
 *
 * ── Concurrency ──────────────────────────────────────────────
 * Per-provider MySQL named lock `book:<provider>` held on a DEDICATED pool
 * connection (GET_LOCK / critical section / RELEASE_LOCK all on the same
 * session — named locks are session-scoped, so pool-level db.query() can
 * acquire and "release" on different sessions and leak the lock). Inside
 * the lock the requested slot is re-derived via getSlots; only then does
 * createAppt run. Slot gone → 409 slot_taken.
 *
 * ── Identity (POST, priority order) ──────────────────────────
 *   1. c (booking_token, 32 hex)  → contact lookup; invalid → fall through
 *      to the public path when public-identity fields were also sent, else
 *      400 invalid_token. No contact PII is EVER echoed on the token path
 *      (masked display via GET /contact is the only, deliberate exception).
 *   2. public: first + last + phone required (phone must normalize to 10
 *      digits — contactService.normalizePhone), email/note optional.
 *      Find-or-create via resolveContactsByValue → createContact. Existing
 *      match (strongest source, phone over email) is reused — no dupes.
 *
 * (The raw-contact-id `client` fallback was removed: with booking_token
 * minted at contact creation + backfilled, it had no legitimate use left
 * and was an enumeration/impersonation surface — sequential ids, books on
 * behalf of arbitrary contacts, fires their confirmation SMS.)
 *
 * Auto-mounts via the routes/ scan in server.js. /book/:slug and
 * /api/book/:slug are ≥2 segments so the single-segment GET /:page static
 * catch-all never intercepts them (same reasoning as /p/:slug, /r/:slug).
 */

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const { DateTime } = require('luxon');

const router = express.Router();

const jwtOrApiKey      = require('../lib/auth.jwtOrApiKey');
const { getSlots }     = require('../services/availabilityService');
const apptService      = require('../services/apptService');
const contactService   = require('../services/contactService');
const emailService     = require('../services/emailService');
const phoneService     = require('../services/phoneService');
const { resolve: resolveTemplate } = require('../services/resolverService');
const { getSettings }  = require('../services/settingsService');
const { FIRM_TZ }      = require('../services/timezoneService');
const { alert }        = require('../lib/alerting');

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const SLUG_RE  = /^[a-zA-Z0-9_-]{1,100}$/;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const START_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;

const MIN_FILL_MS  = 3 * 1000;            // POST must arrive ≥ 3s after config ts
const MAX_FORM_AGE = 2 * 60 * 60 * 1000;  // …and ≤ 2h after

const LOCK_TIMEOUT_SECONDS = 10;          // GET_LOCK wait (matches oauthService)

const DEFAULT_THANKYOU_HTML =
  '<p>Thank you — your appointment has been booked.</p>';

// ─────────────────────────────────────────────────────────────
// Helpers — IP, HMAC, rate limiting
// ─────────────────────────────────────────────────────────────

/** Same convention as routes/pageLanding.js (trust proxy = 1). */
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.ip;
}

function signTs(ts) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(String(ts))
    .digest('hex');
}

function sigValid(ts, sig) {
  if (typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig)) return false;
  const expected = signTs(ts);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Fixed-window in-memory rate limiter factory (pattern copied from
 * routes/pageLanding.js). Per-instance on Cloud Run — accepted best-effort.
 */
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

const readLimited = makeLimiter(60 * 1000, 30);       // config + slots
const postLimited = makeLimiter(10 * 60 * 1000, 5);   // bookings

// ─────────────────────────────────────────────────────────────
// Helpers — view loading
// ─────────────────────────────────────────────────────────────

const PW_HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validate + normalize a booking_views.page_windows value (the optional
 * per-view weekly time restriction). Pure — the caller decides fail-open policy.
 *
 * mysql2 returns the json column already parsed; a string is tolerated
 * (defensive, mirroring provider_ids). Accepted shape:
 *   null | [] → unrestricted            → { ok:true,  value:null }
 *   [{ weekday:0–6, start?:'HH:mm', end?:'HH:mm',
 *      valid_from?:'YYYY-MM-DD', valid_to?:'YYYY-MM-DD' }, …]
 *     (both start/end or neither; start < end when present;
 *      valid_from/valid_to each optional + independent, inclusive;
 *      when both present valid_from <= valid_to — string compare)
 *                                        → { ok:true,  value:[normalized] }
 *   anything malformed                   → { ok:false, reason }
 *
 * Normalized entries carry only { weekday, start?, end?, valid_from?,
 * valid_to? } (extra keys stripped).
 *
 * @param {*} raw — booking_views.page_windows
 * @returns {{ok:true, value:?object[]} | {ok:false, reason:string}}
 */
function normalizePageWindows(raw) {
  let arr = raw;
  if (arr === undefined || arr === null) return { ok: true, value: null };
  if (typeof arr === 'string') {
    const t = arr.trim();
    if (!t) return { ok: true, value: null };
    try { arr = JSON.parse(t); } catch { return { ok: false, reason: 'not valid JSON' }; }
  }
  if (!Array.isArray(arr)) return { ok: false, reason: 'not an array' };
  if (arr.length === 0) return { ok: true, value: null };

  const out = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: 'entry is not an object' };
    }
    const wd = Number(entry.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
      return { ok: false, reason: `entry weekday ${JSON.stringify(entry.weekday)} is not an int 0–6` };
    }
    const hasStart = entry.start !== undefined && entry.start !== null && entry.start !== '';
    const hasEnd   = entry.end   !== undefined && entry.end   !== null && entry.end   !== '';
    if (hasStart !== hasEnd) {
      return { ok: false, reason: 'entry has exactly one of start/end (need both or neither)' };
    }

    // Optional validity range (Slice C): each of valid_from/valid_to is
    // independent; inclusive 'YYYY-MM-DD'; both present → vf <= vt.
    const hasVf = entry.valid_from !== undefined && entry.valid_from !== null && entry.valid_from !== '';
    const hasVt = entry.valid_to   !== undefined && entry.valid_to   !== null && entry.valid_to   !== '';
    let vf = null, vt = null;
    if (hasVf) {
      vf = String(entry.valid_from);
      if (!DATE_RE.test(vf)) {
        return { ok: false, reason: `entry valid_from not "YYYY-MM-DD" (${vf})` };
      }
    }
    if (hasVt) {
      vt = String(entry.valid_to);
      if (!DATE_RE.test(vt)) {
        return { ok: false, reason: `entry valid_to not "YYYY-MM-DD" (${vt})` };
      }
    }
    if (vf && vt && !(vf <= vt)) {
      return { ok: false, reason: `entry valid_from ${vf} is after valid_to ${vt}` };
    }

    const norm = { weekday: wd };
    if (hasStart) {
      const s = String(entry.start);
      const e = String(entry.end);
      if (!PW_HHMM_RE.test(s) || !PW_HHMM_RE.test(e)) {
        return { ok: false, reason: `entry start/end not "HH:mm" (${s} / ${e})` };
      }
      if (!(s < e)) {
        return { ok: false, reason: `entry start ${s} is not earlier than end ${e}` };
      }
      norm.start = s;
      norm.end = e;
    } // else all-day
    if (vf) norm.valid_from = vf;
    if (vt) norm.valid_to = vt;
    out.push(norm);
  }
  return { ok: true, value: out };
}

/**
 * Load an active booking view by slug, parse provider_ids, and sanity-check
 * config. Misconfigured views (bad provider list, appt_length outside the
 * appts.appt_length tinyint range 1–127, non-positive granularity) are
 * treated as not-found — fail safe for the visitor — and alerted so staff
 * see it. Returns null when missing/inactive/misconfigured.
 */
async function loadView(db, slug) {
  if (!SLUG_RE.test(String(slug || ''))) return null;

  const [[view]] = await db.query(
    'SELECT * FROM booking_views WHERE slug = ? AND active = 1 LIMIT 1',
    [slug]
  );
  if (!view) return null;

  // provider_ids: json column — mysql2 usually returns it parsed.
  let pids = view.provider_ids;
  if (typeof pids === 'string') {
    try { pids = JSON.parse(pids); } catch { pids = null; }
  }
  if (!Array.isArray(pids)) pids = null;
  else {
    pids = pids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!pids.length) pids = null;
  }

  const len  = Number(view.appt_length);
  const gran = Number(view.granularity_min);
  const bad =
    !pids ||
    !Number.isInteger(len) || len < 1 || len > 127 ||   // appts.appt_length is tinyint
    !Number.isInteger(gran) || gran < 1 ||
    (view.provider_mode === 'fixed_one' && pids.length !== 1);

  if (bad) {
    alert(db, {
      source: 'app', kind: 'booking_view_misconfigured', severity: 'error',
      group_key: `booking_view_config:${view.slug}`,
      title: `Booking view "${view.slug}" is misconfigured`,
      message:
        `booking_views.id=${view.id} failed config sanity checks ` +
        `(provider_ids=${JSON.stringify(view.provider_ids)}, ` +
        `appt_length=${view.appt_length}, granularity_min=${view.granularity_min}, ` +
        `provider_mode=${view.provider_mode}). The public widget is serving ` +
        `404s for this view until it is fixed.`,
    });
    return null;
  }

  view._provider_ids = pids; // parsed + validated

  // page_windows — optional per-view weekly time restriction (Slice A).
  // FAIL-OPEN: unlike the misconfigured-view 404 above, a broken restriction
  // must NOT block clients. Invalid → serve NORMAL availability + alert staff.
  const pw = normalizePageWindows(view.page_windows);
  if (pw.ok) {
    view._page_windows = pw.value;
  } else {
    view._page_windows = null; // serve regular availability
    alert(db, {
      source: 'app', kind: 'booking_view_windows_invalid', severity: 'error',
      group_key: `booking_view_windows:${view.slug}`,
      title: `Booking view "${view.slug}" has invalid page_windows`,
      message:
        `booking_views.id=${view.id} page_windows failed validation ` +
        `(${pw.reason}; value=${JSON.stringify(view.page_windows)}). ` +
        `The time restriction is being IGNORED — the view is serving regular ` +
        `availability until this is fixed.`,
    });
  }

  return view;
}

/** Today (firm-local) as a Luxon DateTime at start of day. */
function firmToday() {
  return DateTime.now().setZone(FIRM_TZ).startOf('day');
}

/** Is 'YYYY-MM-DD' within [today, today + horizon_days] firm-local? */
function dateWithinHorizon(dateStr, horizonDays) {
  const today = firmToday();
  const d = DateTime.fromISO(dateStr, { zone: FIRM_TZ }).startOf('day');
  if (!d.isValid) return false;
  const last = today.plus({ days: Math.max(0, Number(horizonDays) || 0) });
  return d >= today && d <= last;
}

// ─────────────────────────────────────────────────────────────
// GET /book/:slug — widget shell (file lands in slice 6b)
// ─────────────────────────────────────────────────────────────

router.get('/book/:slug', (req, res) => {
  if (!SLUG_RE.test(String(req.params.slug || ''))) {
    return res.status(404).type('text').send('Not found');
  }
  const file = path.join(__dirname, '..', 'public', 'book.html');
  res.sendFile(file, err => {
    if (err) res.status(404).type('text').send('Not found');
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/book/:slug/config
// ─────────────────────────────────────────────────────────────

router.get('/api/book/:slug/config', async (req, res) => {
  try {
    if (readLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const view = await loadView(req.db, req.params.slug);
    if (!view) return res.status(404).json({ status: 'error', code: 'not_found' });

    // Provider names only in client_choice mode — fixed_one/any_auto views
    // never reveal who or how many providers back them.
    let providers = null;
    if (view.provider_mode === 'client_choice') {
      const [rows] = await req.db.query(
        'SELECT user, user_real_name, user_name FROM users WHERE user IN (?)',
        [view._provider_ids]
      );
      const byId = new Map(rows.map(r => [Number(r.user), r]));
      providers = view._provider_ids
        .filter(id => byId.has(id))
        .map(id => {
          const u = byId.get(id);
          return { id, name: u.user_real_name || u.user_name || `Provider ${id}` };
        });
    }

    // Bookable dates (Slice C — replaces Slice B's allowed_weekdays; no
    // back-compat shim: book.html and this file deploy together, and each
    // side treats the other's absence as "show everything").
    //
    // DELIBERATELY date-level windows math only — base weekly availability
    // (weekday + valid_from/valid_to) intersected with page_windows validity
    // at DATE granularity. NO busy/gcal/slot computation happens here: a
    // fully-booked or firm-blocked date still appears and simply resolves to
    // "no times available" on click. Union across providers (client_choice
    // caveat, accepted: a date can show where only SOME providers have base
    // availability).
    const today = firmToday();
    const todayStr = today.toFormat('yyyy-MM-dd');

    // Date-level truth needs weekday + validity only — no times.
    // DATE_FORMAT keeps vf/vt as plain strings (mysql2 would otherwise hand
    // back Date objects, which String(...).slice(0,10) mangles).
    const [uaRows] = await req.db.query(
      `SELECT user, weekday,
              DATE_FORMAT(valid_from, '%Y-%m-%d') AS valid_from,
              DATE_FORMAT(valid_to,   '%Y-%m-%d') AS valid_to
         FROM user_availability
        WHERE active = 1 AND user IN (?)`,
      [view._provider_ids]
    );

    const validOn = (r, dayStr, weekday) => {
      if (Number(r.weekday) !== weekday) return false;
      const vf = r.valid_from ? String(r.valid_from).slice(0, 10) : null;
      const vt = r.valid_to   ? String(r.valid_to).slice(0, 10)   : null;
      if (vf && dayStr < vf) return false;
      if (vt && dayStr > vt) return false;
      return true;
    };

    const horizon = Math.max(0, Number(view.horizon_days) || 0);
    const bookable_dates = [];
    for (let d = today, i = 0; i <= horizon; d = d.plus({ days: 1 }), i++) {
      const dayStr = d.toFormat('yyyy-MM-dd');
      const weekday = d.weekday % 7; // luxon 1=Mon…7=Sun → 0=Sun…6=Sat (engine convention)
      if (!uaRows.some(r => validOn(r, dayStr, weekday))) continue;
      if (view._page_windows && !view._page_windows.some(w => validOn(w, dayStr, weekday))) continue;
      bookable_dates.push(dayStr);
    }

    // page_expired: every window carries a valid_to and all are in the past —
    // the page as a whole can never offer a date again. Drives the widget's
    // "this booking link has expired" copy (vs the generic no-dates message).
    const page_expired =
      Array.isArray(view._page_windows) && view._page_windows.length > 0 &&
      view._page_windows.every(w => w.valid_to && String(w.valid_to) < todayStr);

    const ts = Date.now();
    res.json({
      title:           view.title,
      subtitle:        view.subtitle,
      accent_color:    view.accent_color,
      logo_url:        view.logo_url,
      logo_link_url:   view.logo_link_url,
      footer_html:     view.footer_html || null, // raw passthrough (admin-trusted)
      platform:        view.platform,
      appt_type:       view.appt_type,
      appt_length:     view.appt_length,
      identity_mode:   view.identity_mode,
      collect_note:    !!view.collect_note,
      horizon_days:    view.horizon_days,
      bookable_dates,
      page_expired,
      providers,
      ts,
      sig: signTs(ts),
    });
  } catch (err) {
    console.error('GET /api/book/:slug/config error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/book/:slug/contact?c=<token> — masked saved details
// ─────────────────────────────────────────────────────────────
//
// Lets the tokened widget show "Booking as Fred R. · (•••) •••-2400 ·
// f•••@4lsg.com" so the visitor can confirm the prefill is theirs.
// Masking happens HERE — full PII never leaves the server on token paths
// (the 6a no-PII stance is narrowed to masked-display-only, no writes).
// Invalid/unknown token → the same 404 shape as a missing view.

function maskBookingName(fname, lname) {
  const first = String(fname || '').trim();
  if (!first) return null;
  const li = String(lname || '').trim().charAt(0);
  // '-' is the public-create lname placeholder — don't surface it.
  return (li && li !== '-') ? `${first} ${li.toUpperCase()}.` : first;
}
function maskBookingPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 4 ? `(•••) •••-${d.slice(-4)}` : null;
}
function maskBookingEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  return at >= 1 ? `${s[0]}•••@${s.slice(at + 1)}` : null;
}

router.get('/api/book/:slug/contact', async (req, res) => {
  try {
    if (readLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const view = await loadView(req.db, req.params.slug);
    if (!view) return res.status(404).json({ status: 'error', code: 'not_found' });

    const token = String(req.query.c || '');
    if (!TOKEN_RE.test(token)) {
      return res.status(404).json({ status: 'error', code: 'not_found' });
    }
    const [[row]] = await req.db.query(
      `SELECT contact_fname, contact_lname, contact_phone, contact_email
         FROM contacts WHERE booking_token = ? LIMIT 1`,
      [token]
    );
    if (!row) return res.status(404).json({ status: 'error', code: 'not_found' });

    res.json({
      success: true,
      display: {
        name:  maskBookingName(row.contact_fname, row.contact_lname),
        phone: maskBookingPhone(row.contact_phone),
        email: maskBookingEmail(row.contact_email),
      },
    });
  } catch (err) {
    console.error('GET /api/book/:slug/contact error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/book/:slug/slots?date=YYYY-MM-DD&provider=N
// ─────────────────────────────────────────────────────────────

/**
 * Resolve which provider ids to compute slots for, per provider_mode.
 * Returns { pids } or { error: { status, code } }.
 *  fixed_one     → the one id; `provider` param ignored
 *  client_choice → `provider` required and must be ∈ provider_ids
 *  any_auto      → all ids (union computed by caller)
 */
function slotProviders(view, providerParam) {
  if (view.provider_mode === 'fixed_one') {
    return { pids: [view._provider_ids[0]] };
  }
  if (view.provider_mode === 'client_choice') {
    const p = Number(providerParam);
    if (!Number.isInteger(p) || !view._provider_ids.includes(p)) {
      return { error: { status: 400, code: 'invalid_provider' } };
    }
    return { pids: [p] };
  }
  // any_auto — provider param is not honored
  return { pids: view._provider_ids };
}

router.get('/api/book/:slug/slots', async (req, res) => {
  try {
    if (readLimited(clientIp(req))) {
      return res.status(429).json({ status: 'error', code: 'rate_limited' });
    }
    const view = await loadView(req.db, req.params.slug);
    if (!view) return res.status(404).json({ status: 'error', code: 'not_found' });

    const dateStr = String(req.query.date || '');
    if (!DATE_RE.test(dateStr)) {
      return res.status(400).json({ status: 'error', code: 'invalid_date' });
    }
    if (!dateWithinHorizon(dateStr, view.horizon_days)) {
      return res.json({ success: true, slots: [] }); // valid date, out of window
    }

    const sel = slotProviders(view, req.query.provider);
    if (sel.error) {
      return res.status(sel.error.status).json({ status: 'error', code: sel.error.code });
    }

    const perProvider = await getSlots(req.db, {
      providerIds:     sel.pids,
      appt_length:     view.appt_length,
      buffer_min:      view.buffer_min,
      from:            dateStr,
      to:              dateStr,
      granularity:     view.granularity_min,
      min_notice_min:  view.min_notice_min,
      restrict_windows: view._page_windows,
    });

    // Flat array: union across providers (only any_auto has >1), deduped,
    // sorted. The widget never needs per-provider shape — provider choice
    // in any_auto happens at booking time, not here.
    const set = new Set();
    for (const pid of sel.pids) {
      for (const s of (perProvider[pid] || [])) set.add(s);
    }
    res.json({ success: true, slots: [...set].sort() });
  } catch (err) {
    console.error('GET /api/book/:slug/slots error:', err);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/book/:slug — the booking pipeline
// ─────────────────────────────────────────────────────────────

/**
 * The fake-success response. Indistinguishable from a real booking from the
 * client's perspective; used for honeypot / too-fast / POST-rate-limit drops.
 */
function fakeSuccess(res, view) {
  return res.json({
    success: true,
    thankyou_html: view.thankyou_html || DEFAULT_THANKYOU_HTML,
  });
}

/**
 * Resolve the contact for this booking. Returns
 *   { contactId }                    — resolved
 *   { error: { status, code } }      — hard failure
 * The token path NEVER echoes contact PII; errors carry codes only.
 */
async function resolveBookingContact(db, body) {
  const hasPublicFields =
    (typeof body.first === 'string' && body.first.trim() !== '') &&
    (body.phone != null && String(body.phone).trim() !== '');

  // ── 1. booking_token ──
  if (body.c != null && body.c !== '') {
    const token = String(body.c);
    if (TOKEN_RE.test(token)) {
      const [[row]] = await db.query(
        'SELECT contact_id FROM contacts WHERE booking_token = ? LIMIT 1',
        [token]
      );
      if (row) return { contactId: row.contact_id };
    }
    if (!hasPublicFields) return { error: { status: 400, code: 'invalid_token' } };
    // fall through to public path
  }

  // ── 2. public find-or-create ──
  const first = String(body.first || '').trim();
  const last  = String(body.last  || '').trim();
  if (!first || !last) return { error: { status: 400, code: 'missing_name' } };

  const phoneNorm = contactService.normalizePhone(String(body.phone || ''));
  if (phoneNorm.length !== 10) {
    return { error: { status: 400, code: 'invalid_phone' } };
  }

  let emailNorm = '';
  if (body.email != null && String(body.email).trim() !== '') {
    emailNorm = contactService.normalizeEmail(String(body.email));
    if (!emailNorm.includes('@') || emailNorm.length < 3 || emailNorm.length > 50) {
      return { error: { status: 400, code: 'invalid_email' } };
    }
  }

  // Find: phone match beats email match; within a kind, the resolver's
  // strongest source wins; final tie → lowest contact_id (matches' order).
  const resolved = await contactService.resolveContactsByValue(
    db,
    { phone: phoneNorm, email: emailNorm || null },
    { include_ended: false, include_legacy_secondary: true }
  );
  const SOURCE_RANK = { child_active: 0, child_ended: 1, legacy_primary: 2, legacy_secondary: 3 };
  const best = (kind) => {
    const k = kind === 'phone' ? 'matched_by_phone' : 'matched_by_email';
    return resolved.matches
      .filter(m => m[k])
      .sort((a, b) =>
        (SOURCE_RANK[a[k].source] - SOURCE_RANK[b[k].source]) ||
        (a.contact_id - b.contact_id))[0] || null;
  };
  const match = best('phone') || best('email');
  if (match) return { contactId: match.contact_id };

  // Create. contact_lname is NOT NULL + required by createContact;
  // last is validated above, so no placeholder needed.
  const created = await contactService.createContact(db, {
    fname: first.slice(0, 20),
    lname: last.slice(0, 30),
    phone: phoneNorm,
    email: emailNorm,
    type:  'person',                 // dominant contact_type in live data
    notes: '',
  }, { userId: 0 });
  return { contactId: created.contact_id, created: true };
}

/**
 * Pick the provider for an any_auto booking: restrict to providers whose
 * slot set (already computed) contains `start`, order by that civil day's
 * Scheduled-appt count ascending, tie → lowest user id. Returns ordered
 * candidate array (the booking loop tries them in order under per-provider
 * locks).
 */
async function anyAutoCandidates(db, view, dateStr, start, perProvider) {
  const holders = view._provider_ids.filter(
    pid => (perProvider[pid] || []).includes(start)
  );
  if (!holders.length) return [];

  const dayStart = `${dateStr} 00:00:00`;
  const dayEnd   = DateTime.fromISO(dateStr, { zone: FIRM_TZ })
    .plus({ days: 1 }).toFormat('yyyy-MM-dd 00:00:00');

  const [rows] = await db.query(
    `SELECT appt_with, COUNT(*) AS n
       FROM appts
      WHERE appt_status = 'Scheduled'
        AND appt_with IN (?)
        AND appt_date >= ? AND appt_date < ?
      GROUP BY appt_with`,
    [holders, dayStart, dayEnd]
  );
  const load = new Map(rows.map(r => [Number(r.appt_with), Number(r.n)]));
  return holders.sort((a, b) =>
    ((load.get(a) || 0) - (load.get(b) || 0)) || (a - b));
}

/**
 * Under the per-provider named lock: re-verify the slot, then createAppt.
 * GET_LOCK/RELEASE_LOCK and the in-between queries run on ONE dedicated
 * connection — named locks are session-scoped, so pool-level queries could
 * acquire and "release" on different sessions and leak the lock.
 * Returns { apptId } on success, null when the slot is no longer available,
 * and throws on infrastructure errors.
 */
async function bookUnderLock(db, view, providerId, dateStr, start, contactId, note) {
  const lockKey = `book:${providerId}`;
  const conn = await db.getConnection();
  let locked = false;
  try {
    const [[lockRes]] = await conn.query(
      'SELECT GET_LOCK(?, ?) AS lockAcquired',
      [lockKey, LOCK_TIMEOUT_SECONDS]
    );
    if (lockRes?.lockAcquired !== 1) {
      throw new Error(`Could not acquire booking lock for provider ${providerId}`);
    }
    locked = true;

    // Authoritative re-check on the locked session's view of the world.
    // (getSlots reads through `conn` — a PoolConnection supports .query the
    // same as the pool.)
    const fresh = await getSlots(conn, {
      providerIds:     [providerId],
      appt_length:     view.appt_length,
      buffer_min:      view.buffer_min,
      from:            dateStr,
      to:              dateStr,
      granularity:     view.granularity_min,
      min_notice_min:  view.min_notice_min,
      restrict_windows: view._page_windows, // enforcement: out-of-window start 409s
    });
    if (!(fresh[providerId] || []).includes(start)) return null;

    // createAppt internally takes its own pool connection for its
    // transaction — fine; the named lock (held on `conn`) is what
    // serializes check+insert across requests/instances.
    const result = await apptService.createAppt(db, {
      contact_id:    contactId,
      case_id:       '',
      appt_length:   view.appt_length,
      appt_type:     view.appt_type,
      appt_platform: view.platform,
      appt_date:     `${start}:00`,
      appt_with:     providerId,
      note:          note,
      appt_source:   view.source_tag || null,
      appt_view_id:  view.id,         // slice 9b: branding + lifecycle hooks
      confirm_sms:   false,           // confirmations are template-driven below
      confirm_email: false,
      actingUserId:  0,
      source:        'client',        // public booking widget — fires office alert
    });
    return { apptId: result.appt_id };
  } finally {
    if (locked) {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockKey])
        .catch(e => console.error('[booking] RELEASE_LOCK failed:', e.message));
    }
    conn.release();
  }
}

/**
 * Post-create side effects: template confirmation (SMS/email via the
 * app_settings default senders, same convention as
 * apptService.sendApptConfirmation) and the view's hook. All fire-and-forget;
 * failures alert but never affect the response.
 */
function fireSideEffects(db, view, { apptId, contactId, providerId, start }) {
  // ── Confirmation ──
  if (view.confirm_template && (view.confirm_sms || view.confirm_email)) {
    (async () => {
      const r = await resolveTemplate({
        db,
        text:   view.confirm_template,
        refs:   { contacts: { contact_id: contactId }, appts: { appt_id: apptId } },
        strict: false,
      });
      const message = r.text;
      if (!message || !message.trim()) return;
      if (r.unresolved?.length) {
        console.warn(`[booking] confirm template left unresolved placeholders (view=${view.slug}):`, r.unresolved);
      }

      const settings = await getSettings(db, ['sms_default_from', 'email_default_from']);
      const [[contact]] = await db.query(
        'SELECT contact_phone, contact_email FROM contacts WHERE contact_id = ?',
        [contactId]
      );

      if (view.confirm_sms && contact?.contact_phone && settings.sms_default_from) {
        phoneService.sendSms(db, settings.sms_default_from, contact.contact_phone, message)
          .catch(err => alert(db, {
            source: 'app', kind: 'booking_confirm_sms_failed', severity: 'error',
            group_key: `booking_confirm:${view.slug}`,
            title: 'Booking confirmation SMS failed',
            message: `view=${view.slug} appt=${apptId} contact=${contactId}: ${err.message}`,
          }));
      }
      if (view.confirm_email && contact?.contact_email && settings.email_default_from) {
        emailService.sendEmail(db, {
          from:    settings.email_default_from,
          to:      contact.contact_email,
          subject: view.title || 'Appointment Confirmation',
          text:    message,
        }).catch(err => alert(db, {
          source: 'app', kind: 'booking_confirm_email_failed', severity: 'error',
          group_key: `booking_confirm:${view.slug}`,
          title: 'Booking confirmation email failed',
          message: `view=${view.slug} appt=${apptId} contact=${contactId}: ${err.message}`,
        }));
      }
    })().catch(err => alert(db, {
      source: 'app', kind: 'booking_confirm_failed', severity: 'error',
      group_key: `booking_confirm:${view.slug}`,
      title: 'Booking confirmation pipeline failed',
      message: `view=${view.slug} appt=${apptId} contact=${contactId}: ${err.message}`,
    }));
  }

  // (View hook firing moved into apptService.createAppt — slice 9b. The
  // hook now fires centrally off appts.appt_view_id with an `event` field,
  // covering staff reschedules/cancels and manage-page rebooks too.)
}

router.post('/api/book/:slug', async (req, res) => {
  try {
    const view = await loadView(req.db, req.params.slug);
    if (!view) return res.status(404).json({ status: 'error', code: 'not_found' });

    const body = req.body || {};
    const ip = clientIp(req);

    // ── 1. Rate limit (silent fake success — bots can't tell) ──
    if (postLimited(ip)) return fakeSuccess(res, view);

    // ── 2. Abuse guards ──
    if (body.website != null && String(body.website).trim() !== '') {
      return fakeSuccess(res, view);             // honeypot → silent drop
    }
    const ts = Number(body.ts);
    if (!Number.isFinite(ts) || !sigValid(ts, body.sig)) {
      return res.status(400).json({ status: 'error', code: 'invalid_request' });
    }
    const age = Date.now() - ts;
    if (age < MIN_FILL_MS) return fakeSuccess(res, view);   // too fast → bot
    if (age > MAX_FORM_AGE) {
      return res.status(400).json({
        status: 'error', code: 'stale_form',
        message: 'This page has expired — please refresh and try again.',
      });
    }

    // ── 3. start parses, within horizon, ≥ now + min_notice ──
    const start = String(body.start || '');
    if (!START_RE.test(start)) {
      return res.status(400).json({ status: 'error', code: 'invalid_start' });
    }
    const startDt = DateTime.fromFormat(start, 'yyyy-MM-dd HH:mm', { zone: FIRM_TZ });
    if (!startDt.isValid) {
      return res.status(400).json({ status: 'error', code: 'invalid_start' });
    }
    const dateStr = start.slice(0, 10);
    if (!dateWithinHorizon(dateStr, view.horizon_days)) {
      return res.status(400).json({ status: 'error', code: 'outside_horizon' });
    }
    const earliest = DateTime.now().setZone(FIRM_TZ)
      .plus({ minutes: Math.max(0, Number(view.min_notice_min) || 0) });
    if (startDt < earliest) {
      return res.status(409).json({ status: 'error', code: 'slot_taken' });
    }

    // ── 4. Identity ──
    const ident = await resolveBookingContact(req.db, body);
    if (ident.error) {
      return res.status(ident.error.status).json({ status: 'error', code: ident.error.code });
    }
    const contactId = ident.contactId;

    // Note (only when the view collects it)
    const note = view.collect_note && typeof body.note === 'string'
      ? body.note.trim().slice(0, 500)
      : '';

    // ── 5 + 6. Provider resolution + lock + re-verify + create ──
    let candidates;
    if (view.provider_mode === 'fixed_one') {
      candidates = [view._provider_ids[0]];
    } else if (view.provider_mode === 'client_choice') {
      const p = Number(body.provider);
      if (!Number.isInteger(p) || !view._provider_ids.includes(p)) {
        return res.status(400).json({ status: 'error', code: 'invalid_provider' });
      }
      candidates = [p];
    } else {
      // any_auto: union for the day, restrict to providers holding `start`,
      // least-loaded first. The per-candidate re-check happens inside each
      // provider's lock; this ordering pass is just the pick heuristic.
      const perProvider = await getSlots(req.db, {
        providerIds:     view._provider_ids,
        appt_length:     view.appt_length,
        buffer_min:      view.buffer_min,
        from:            dateStr,
        to:              dateStr,
        granularity:     view.granularity_min,
        min_notice_min:  view.min_notice_min,
        restrict_windows: view._page_windows,
      });
      candidates = await anyAutoCandidates(req.db, view, dateStr, start, perProvider);
      if (!candidates.length) {
        return res.status(409).json({ status: 'error', code: 'slot_taken' });
      }
    }

    let booked = null;
    let providerId = null;
    for (const pid of candidates) {
      booked = await bookUnderLock(req.db, view, pid, dateStr, start, contactId, note);
      if (booked) { providerId = pid; break; }
    }
    if (!booked) {
      return res.status(409).json({ status: 'error', code: 'slot_taken' });
    }

    // ── 7. Post-create side effects (fire-and-forget) ──
    fireSideEffects(req.db, view, {
      apptId: booked.apptId, contactId, providerId, start,
    });

    // ── 8. Response: nothing but success + thank-you HTML ──
    return res.json({
      success: true,
      thankyou_html: view.thankyou_html || DEFAULT_THANKYOU_HTML,
    });
  } catch (err) {
    console.error('POST /api/book/:slug error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/contacts/:id/booking-link  (internal — jwtOrApiKey)
// ─────────────────────────────────────────────────────────────

router.post('/api/contacts/:id/booking-link', jwtOrApiKey, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid contact ID' });
    }

    const [[row]] = await req.db.query(
      'SELECT booking_token FROM contacts WHERE contact_id = ? LIMIT 1',
      [id]
    );
    if (!row) return res.status(404).json({ status: 'error', message: 'Contact not found' });
    if (row.booking_token) return res.json({ success: true, token: row.booking_token });

    // Mint. Guarded UPDATE so two concurrent mints can't overwrite each
    // other; loser re-reads the winner's token.
    const token = crypto.randomBytes(16).toString('hex');
    const [upd] = await req.db.query(
      'UPDATE contacts SET booking_token = ? WHERE contact_id = ? AND booking_token IS NULL',
      [token, id]
    );
    if (upd.affectedRows === 1) return res.json({ success: true, token });

    const [[again]] = await req.db.query(
      'SELECT booking_token FROM contacts WHERE contact_id = ? LIMIT 1',
      [id]
    );
    return res.json({ success: true, token: again.booking_token });
  } catch (err) {
    console.error('POST /api/contacts/:id/booking-link error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to mint booking link' });
  }
});

module.exports = router;