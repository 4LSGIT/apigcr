// routes/portal.branding.js
//
// Client Portal Slice 5 — PUBLIC branding endpoint. Auto-mounted
// (routes/ readdir).
//
//   GET /api/portal/branding → { status:'success', logo_url, favicon_url,
//                                site_url, phone }             (each string|null)
//
// WHY PUBLIC: the login page needs the firm logo/favicon BEFORE any auth
// exists, and GET /api/firm-data (the staff settings feed) is
// jwtOrApiKey-gated — portal pages cannot use it.
//
// FIXED-SET INVARIANT (binding — S5 spec §1): this endpoint serves a
// HARDCODED constant set of app_settings keys and NOTHING else. It must
// NEVER accept a key/name from the request in any form (query, params,
// body, headers) — a parameterizable read here is an arbitrary
// app_settings oracle (jwt secrets, API keys, PIN sender config…) sitting
// on an UNAUTHENTICATED route. The handler reads NOTHING from the request
// beyond the IP for rate limiting; getBranding takes only (db).
//
// S5.2 — the portal's own logo/favicon become settings, editable in
// Portal Manager → Settings → Branding:
//   logo_url    = portal_logo_url    || fe-firm_logo_url   (portal override
//                 falls back to the firm-wide logo)
//   favicon_url = portal_favicon_url || the effective logo (resolved
//                 SERVER-side so the client stays dumb; blank favicon =
//                 "use the logo")
// The constant set grows to five keys — the invariant is unchanged.
//
// Value handling mirrors api.firmData.js's settings map: values are
// JSON-parsed with a raw-string fallback (rows today are plain strings),
// then coerced to trimmed strings; missing rows / empty values / non-scalar
// JSON → null. Missing rows are a 200-with-nulls, and so is a DB error
// (fail-soft + console.error): branding is cosmetic — a hiccup here must
// never break the login page, and a distinguishable 500 on an
// unauthenticated route buys nothing.
//
// Cache-Control: public, max-age=300 — every portal page fetches this on
// load; the browser cache absorbs the repeats. Staff edits to the rows
// take ≤5 minutes to reach clients. Modest per-IP limiter (60/min) as belt —
// the query is one indexed IN() read, but this is an open endpoint.

'use strict';

const express = require('express');
const router = express.Router();

const { makeLimiter, getClientIp } = require('../lib/rateLimiter');

// THE fixed set — every app_settings key this endpoint may read. A CODE
// CONSTANT; additions ship with code after the same "safe in a client's
// browser" review as the portal field whitelist. NEVER derived from the
// request. (Fallback resolution below composes RESPONSE fields from these
// keys — the query itself binds exactly this list.)
const BRANDING_KEYS = Object.freeze({
  portal_logo:    'portal_logo_url',
  portal_favicon: 'portal_favicon_url',
  firm_logo:      'fe-firm_logo_url',
  site_url:       'fe-firm_site_url',
  phone:          'fe-firm_phone',
});

const brandingLimited = makeLimiter(60 * 1000, 60);   // 60 / min / IP

/** JSON-parse-with-fallback (api.firmData.js convention) → trimmed string|null. */
function toValue(raw) {
  if (raw === null || raw === undefined) return null;
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (_) { /* keep raw string */ }
  }
  if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
  if (typeof v !== 'string') return null;              // arrays/objects: not branding scalars
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * The branding payload. Takes ONLY the db — no request-derived input can
 * reach the query (fixed-set invariant). Missing rows → nulls; portal
 * overrides fall back per the header note.
 */
async function getBranding(db) {
  const keys = Object.values(BRANDING_KEYS);
  const [rows] = await db.query(
    'SELECT `key`, `value` FROM app_settings WHERE `key` IN (?, ?, ?, ?, ?)',
    keys
  );
  const byKey = {};
  for (const row of rows || []) byKey[row.key] = row.value;
  const val = (field) => toValue(byKey[BRANDING_KEYS[field]]);

  const logo = val('portal_logo') || val('firm_logo');
  return {
    logo_url:    logo,
    favicon_url: val('portal_favicon') || logo,
    site_url:    val('site_url'),
    phone:       val('phone'),
  };
}

// ── GET /api/portal/branding ────────────────────────────────────────────────

async function brandingHandler(req, res) {
  if (brandingLimited(getClientIp(req))) {
    return res.status(429).json({ status: 'error', message: 'Too many requests. Please try again later.' });
  }
  res.set('Cache-Control', 'public, max-age=300');

  let branding = { logo_url: null, favicon_url: null, site_url: null, phone: null };
  try {
    branding = await getBranding(req.db);
  } catch (err) {
    // Fail-soft: branding is cosmetic — nulls, never a broken login page.
    console.error('[portal] branding read error:', err.message);
  }
  res.json({ status: 'success', ...branding });
}

router.get('/api/portal/branding', brandingHandler);

module.exports = router;
// exported for tests (repo pattern: api.portalCardsAdmin)
module.exports._getBranding = getBranding;
module.exports._brandingHandler = brandingHandler;
module.exports._BRANDING_KEYS = BRANDING_KEYS;
