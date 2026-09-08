// routes/api.users.js
//
/**
 * Users, Judges, Trustees API
 * routes/api.users.js
 *
 * GET   /api/users/me                          current user (full row, sensitive fields stripped)
 * GET   /api/users                             list all users (stripped of sensitive fields)
 * GET   /api/users/:id                         single user (stripped)
 * PATCH /api/users/:id/freebusy-calendars      set provider freebusy_calendar_ids (scheduler phase 2)
 * GET   /api/judges                            list all judges
 * GET   /api/trustees                          list all trustees
 *
 * The GETs are read-only reference endpoints for populating dropdowns
 * (assigned_to, appt_with, case_judge, case_trustee, etc.). The freebusy
 * PATCH is the lone writer here — it backs the scheduler settings UI.
 *
 * NOTE: /api/users/me MUST be registered before /api/users/:id
 * so Express doesn't treat "me" as an :id param.
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

// Fields to strip from user responses
const USER_STRIP = ['password', 'password_hash', 'reset_token', 'reset_expires'];

function stripUser(row) {
  if (!row) return row;
  const clean = { ...row };
  for (const f of USER_STRIP) delete clean[f];
  return clean;
}

// ─── CURRENT USER (must be before /:id) ───

router.get('/api/users/me', jwtOrApiKey, async (req, res) => {
  try {
    const userId = req.auth.userId;
    const [[user]] = await req.db.query(
      'SELECT * FROM users WHERE user = ?',
      [userId]
    );
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', user: stripUser(user) });
  } catch (err) {
    console.error('GET /api/users/me error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch user' });
  }
});

// ─── USERS ───

router.get('/api/users', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT user, username, user_name, user_fname, user_lname,
              user_initials, user_auth, user_type, email, phone, allow_sms,
              does_appts, freebusy_calendar_ids
       FROM users
       ORDER BY user_name ASC`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('GET /api/users error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch users' });
  }
});

router.get('/api/users/:id', jwtOrApiKey, async (req, res) => {
  try {
    const [[user]] = await req.db.query(
      'SELECT * FROM users WHERE user = ?',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ data: stripUser(user) });
  } catch (err) {
    console.error('GET /api/users/:id error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch user' });
  }
});

// ─── FREEBUSY CALENDARS (scheduler phase 2) ───
//
// PATCH /api/users/:id/freebusy-calendars
// Body: { calendar_ids: string[] }  — Google calendar id strings whose TIMED
// events block this provider's booking availability (read live via freeBusy).
// Stored as a native json array. Empty array / [] clears it (feature off for
// that user). mysql2 json hazard: JSON.stringify on write.
router.patch('/api/users/:id/freebusy-calendars', jwtOrApiKey, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ status: 'error', message: 'invalid user id' });
  }
  let { calendar_ids } = req.body || {};
  if (!Array.isArray(calendar_ids)) {
    return res.status(400).json({ status: 'error', message: 'calendar_ids must be an array of strings' });
  }
  // Normalize: trim, drop blanks, dedupe, coerce to strings.
  const clean = [...new Set(
    calendar_ids.map(x => String(x == null ? '' : x).trim()).filter(Boolean)
  )];

  try {
    const [r] = await req.db.query(
      'UPDATE users SET freebusy_calendar_ids = ? WHERE user = ?',
      [JSON.stringify(clean), id]   // json column — stringify on write
    );
    if (!r.affectedRows) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    res.json({ status: 'success', user: id, freebusy_calendar_ids: clean });
  } catch (err) {
    console.error(`PATCH /api/users/${id}/freebusy-calendars error:`, err);
    res.status(500).json({ status: 'error', message: 'Failed to update freebusy calendars' });
  }
});

// ─── JUDGES ───

router.get('/api/judges', jwtOrApiKey, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      'SELECT judge_id, judge_3, judge_name FROM judges ORDER BY judge_name ASC'
    );
    res.json({ judges: rows });
  } catch (err) {
    console.error('GET /api/judges error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch judges' });
  }
});

// ─── TRUSTEES ───
//
// SOURCE OF TRUTH: app_settings 'fe-trustees' — the same JSON array the
// settings.html editor writes and /api/firm-data ships to every staff frame
// as window.firmData.settings.trustees. The `trustees` TABLE is retired and
// is NOT read here (lib/internal_functions/trustee.js:8-9 says the same); it
// lacks nothing structurally, but it is a second copy with no writer, and the
// roster's `link` is what gets stamped onto cases.case_341_link. One roster,
// one spelling — that is the whole point of canonicalizing against it.
//
// The response shape CHANGED with this rewrite (trustee_full_name → name,
// etc.). That was free: the old endpoint had zero callers in the repo and
// zero rows in jwt_api_audit_log across its whole retained history.
//
// MODES (mutually compatible; `match` wins over `q`):
//   GET /api/trustees                     → whole roster
//   GET /api/trustees?chapter=13          → chapter-eligible subset (rule 0)
//   GET /api/trustees?q=simon             → substring on name/lname (typeahead)
//   GET /api/trustees?match=T.%20Simon    → matchTrustee verdict, not a list
//
// `q` and `match` are DIFFERENT operations and deliberately not merged:
// `q` filters for a human picking from a dropdown and always returns a list;
// `match` canonicalizes a court-extracted string and returns the matcher's
// verdict shape, including the ambiguous / chapter_mismatch statuses that a
// list cannot express. Anything acting on `match` must branch on `status` —
// a caller that reads `.entry` without checking will silently do nothing on
// an ambiguous roster collision (live example: the two McDonald entries).
//
// `match` is READ-ONLY. It never touches a case row. Validating and WRITING
// cases.case_trustee is validate_case_trustee (the internal function), which
// is gated by app_settings trustee_validation_live and raises alert tasks.
// Do not reimplement that here.

const { getSettings } = require('../services/settingsService');
const {
  matchTrustee, validEntries, eligibleForChapter, _norm,
} = require('../lib/trusteeMatch');

/**
 * Load + parse the fe-trustees roster.
 *
 * Returns a STATUS rather than throwing, because the two failure modes want
 * different human responses and a bare 500 hides which one happened:
 *   'ok'          → setting present and parsed
 *   'missing'     → no fe-trustees row at all (never configured / deleted)
 *   'unparseable' → row exists but is not valid JSON (bad hand-edit)
 * Both failures yield an EMPTY list, so a dropdown degrades to empty rather
 * than to a stack trace — but the status is on the response so a caller can
 * tell "no trustees configured" from "the roster is broken", and both are
 * console.error'd for Cloud Run.
 *
 * Deliberately NOT pushed into lib/trusteeMatch.js: that module is pure and
 * DB-free by contract, and this needs the db handle.
 */
async function loadRoster(db) {
  const settings = await getSettings(db, ['fe-trustees']);
  const raw = settings['fe-trustees'];
  if (raw == null) {
    console.error("GET /api/trustees: app_settings 'fe-trustees' is missing");
    return { entries: [], roster_status: 'missing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("GET /api/trustees: 'fe-trustees' is not parseable JSON:", e.message);
    return { entries: [], roster_status: 'unparseable' };
  }
  // validEntries drops half-typed rows; same predicate matchTrustee uses, so
  // the list and the matcher can never disagree about what exists.
  return { entries: validEntries(parsed), roster_status: 'ok' };
}

router.get('/api/trustees', jwtOrApiKey, async (req, res) => {
  try {
    const chapter = String(req.query.chapter ?? '').trim();
    const q       = String(req.query.q       ?? '').trim();
    const match   = String(req.query.match   ?? '').trim();

    const { entries, roster_status } = await loadRoster(req.db);

    // ── match mode ── verdict shape, NOT a list. Runs against the FULL
    // roster: matchTrustee applies chapter eligibility itself and needs the
    // ineligible entries to report chapter_mismatch. Pre-filtering here would
    // turn that diagnosis into a plain no_match.
    //
    // The verdict is NESTED under `result` and NOT spread onto the envelope.
    // matchTrustee's `status` (matched|ambiguous|chapter_mismatch|no_match|
    // no_trustee|no_roster) and the house envelope's `status` (success|error)
    // are different vocabularies on the same key — spreading silently
    // overwrote the envelope and made every match look like a transport
    // failure to anything checking status === 'success'.
    //
    // `canonical` is lifted out because it is what callers actually want
    // (the roster spelling to store), and named to match
    // validate_case_trustee's output field. `candidates` is always an array
    // so callers never have to guard on undefined.
    if (match) {
      const r = matchTrustee({ extracted: match, chapter, roster: entries });
      return res.json({
        status: 'success',
        mode: 'match',
        roster_status,
        query: { match, chapter: chapter || null },
        result: {
          status:     r.status,
          method:     r.method || null,
          extracted:  match,
          canonical:  r.status === 'matched' ? String(r.entry.name).trim() : null,
          entry:      r.entry || null,
          candidates: r.candidates || [],
        },
      });
    }

    // ── list modes ── chapter first (rule 0), then substring.
    let list = eligibleForChapter(entries, chapter);

    if (q) {
      const needle = _norm(q);
      list = list.filter((e) =>
        _norm(e.name).includes(needle) || _norm(e.lname).includes(needle));
    }

    list = list.slice().sort((a, b) => _norm(a.name).localeCompare(_norm(b.name)));

    res.json({
      status: 'success',
      mode: q ? 'search' : 'list',
      roster_status,
      query: { chapter: chapter || null, q: q || null },
      count: list.length,
      trustees: list,
    });
  } catch (err) {
    console.error('GET /api/trustees error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch trustees' });
  }
});

module.exports = router;