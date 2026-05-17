// routes/api.contactLookup.js
//
/**
 * Contact Lookup API
 * routes/api.contactLookup.js
 *
 * GET /api/contact-lookup?phone=&email=&include_ended=&include_legacy_secondary=
 *
 * Resolve contact(s) by phone/email value. Thin wrapper over
 * contactService.resolveContactsByValue — see that function for matching
 * rules, source precedence, and fail-soft semantics.
 *
 * Auto-mounted by the routes loader; no entry-point edits needed.
 *
 * Naming convention: matches /api/contact-phones and /api/contact-emails —
 * the established pattern for per-resource action endpoints. Lives outside
 * the /api/contacts/:id namespace by design to avoid collision with the
 * variable-segment route in routes/api.contacts.js.
 *
 * Response: { status, matches, summary } — always HTTP 200 on resolution
 * (zero matches is not 404). HTTP 400 only when neither phone nor email
 * is provided.
 */

const express        = require('express');
const router         = express.Router();
const jwtOrApiKey    = require('../lib/auth.jwtOrApiKey');
const contactService = require('../services/contactService');


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Parse a query-string boolean with a configurable default. Unlike the
 * parseBool helper in routes/api.contactPhones.js (which treats absent
 * as false), this variant treats absent / empty / unrecognized as
 * defaultVal so callers can pass `?include_ended=false` to opt out of
 * a true-default and have the absent case still mean true.
 *
 * Truthy:  'true' | '1' | 'yes' | 'on' (case-insensitive)
 * Falsy:   'false'| '0' | 'no'  | 'off'
 */
function parseBoolWithDefault(v, defaultVal) {
  if (v === undefined) return defaultVal;
  if (v === true  || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '')                                                  return defaultVal;
    if (s === 'true'  || s === '1' || s === 'yes' || s === 'on')   return true;
    if (s === 'false' || s === '0' || s === 'no'  || s === 'off')  return false;
  }
  return defaultVal;
}


// ─── GET /api/contact-lookup ───
router.get('/api/contact-lookup', jwtOrApiKey, async (req, res) => {
  try {
    const phone = typeof req.query.phone === 'string' ? req.query.phone : null;
    const email = typeof req.query.email === 'string' ? req.query.email : null;

    if ((phone == null || phone === '') && (email == null || email === '')) {
      return res.status(400).json({
        status:  'error',
        message: 'phone or email required',
      });
    }

    const include_ended            = parseBoolWithDefault(req.query.include_ended,            true);
    const include_legacy_secondary = parseBoolWithDefault(req.query.include_legacy_secondary, true);

    const result = await contactService.resolveContactsByValue(
      req.db,
      { phone, email },
      { include_ended, include_legacy_secondary }
    );

    res.json(result);
  } catch (err) {
    console.error('GET /api/contact-lookup error:', err);
    res.status(500).json({ status: 'error', message: 'Failed to resolve contacts' });
  }
});


module.exports = router;