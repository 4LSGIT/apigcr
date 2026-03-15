// routes/resolver.js
//
// Route wrapper for the universal placeholder resolver.
// Does NOT touch or replace the existing /unplacehold route.
//
// POST /resolve
//
// Body:
//   text    {string}   — text with {{table.column|modifier}} placeholders
//   refs    {object}   — anchor for each table, e.g. { contacts: { contact_id: 1001 } }
//   strict  {boolean}  — default false
//
// HTTP response codes:
//   200  — always (check result.status and result.errorType for outcome)
//   400  — malformed request body only (missing text, bad refs shape)
//   500  — unexpected server error
//
// Result shape:
//   status:    "success" | "partial_success" | "failed"
//   errorType: "security" | "missing_refs" | "query_error"  (only on errors)
//   text:      resolved string
//   unresolved: placeholders that could not be resolved
//   errors:    human-readable error messages
//
// Unknown tables in placeholders (e.g. {{bills.amount}}) → partial_success, not an error.
//
// GET /resolve/tables — returns the allowed table list

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { resolve, ALLOWED_TABLES } = require('../services/resolverService');

router.post('/resolve', jwtOrApiKey, async (req, res) => {
  const { text, refs, strict = false } = req.body;

  // ── Hard validation — missing required fields ──
  if (typeof text !== 'string') {
    return res.status(400).json({ error: '"text" must be a string' });
  }

  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) {
    return res.status(400).json({ error: '"refs" must be an object mapping table names to anchor conditions' });
  }

  // Validate shape of each ref entry
  for (const [table, anchor] of Object.entries(refs)) {
    if (typeof anchor !== 'object' || Array.isArray(anchor) || !Object.keys(anchor).length) {
      return res.status(400).json({
        error: `refs.${table} must be an object with one anchor key, e.g. { contact_id: 1001 }`
      });
    }
    if (Object.keys(anchor).length > 1) {
      return res.status(400).json({ error: `refs.${table} must have exactly one anchor key` });
    }
    // Note: unknown table names in refs are allowed — they'll just be unused
  }

  try {
    const result = await resolve({ db: req.db, text, refs, strict });

    // Always return 200 — callers check result.status and result.errorType.
    // errorType values:
    //   "security"     — blocked column accessed
    //   "missing_refs" — ref missing for a table referenced in placeholders
    //   "query_error"  — DB query failed
    //   (absent)       — content-level outcome (success / partial_success / failed)
    if (result.errors?.some(e => e.startsWith('Query failed'))) {
      result.errorType = result.errorType || 'query_error';
    }
    return res.json(result);

  } catch (err) {
    console.error('[POST /resolve] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// GET /resolve/tables — list allowed tables (useful for frontend template editors)
router.get('/resolve/tables', jwtOrApiKey, (req, res) => {
  res.json({ tables: ALLOWED_TABLES });
});

module.exports = router;