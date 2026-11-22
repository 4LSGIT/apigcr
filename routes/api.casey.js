// routes/api.casey.js — Casey v2 (ref/CASEY_V2_DESIGN.md).
//
// S0: one SU-only inspection read over the route catalog.
// S1: the tool layer (services/casey/tools) behind an SU-only TEST route —
//     no model call, nothing user-visible, dark while casey_v2_enabled = '0'.
//
//   GET /api/casey/catalog?family=&class=&tier=&method=&q=&unknown=1
//     → { status:'success', summary, filters, rows:[...], unknown:[...] }
//   GET  /api/casey/tools            → { status, enabled, tools:[{name, description, input_schema}] }
//   POST /api/casey/tools/:name {input}
//     → the tool's envelope (services/casey/tools/index.js), run AS THE CALLER:
//       ctx comes from this request (its auth, headers, app, ip), so a tool
//       sees exactly what the superuser testing it may see. 403 when
//       casey_v2_enabled is '0' (lib/firmConfig; on unless '0', like every
//       casey_* switch — Fred seeds '0' before the deploy so v2 starts dark),
//       404 for an unknown tool name, 400 for a non-object input.
//
// `rows` are lib/routeCatalog.js rows for THIS instance's live app (req.app),
// built once per process. Filters are exact matches (family '/api/mail',
// class 'staff:can', tier 0–3, method 'POST') except `q`, a case-insensitive
// substring of the path. `unknown` is the list of routes the catalog could
// not classify — empty in a healthy deploy (tests/routeCatalog.test.js).
//
// Auth: superuserOnlyFor('casey') — JWT-only + SU + X-SU-Elevation + 30/min.
// The catalog is a map of every route and its gate: useful to an attacker
// as a target list, so it is not a staff read. Casey's own `lookup_routes`
// tool (S1) reads the same catalog in-process, filtered to what the asking
// user may reach. Auto-mounts via the routes/ scan in server.js.
//
// NEVER PROPOSABLE: `/api/casey/*` is on lib/caseySensitivity's list — Casey
// does not drive Casey.

'use strict';

const express = require('express');
const router = express.Router();
const { superuserOnlyFor } = require('../lib/auth.superuser');
const catalog = require('../lib/routeCatalog');

const guard = superuserOnlyFor('casey');

function v2Enabled() {
  return require('../lib/firmConfig').cfg('casey_v2_enabled') !== '0'; // lazy require (convention)
}

router.get('/api/casey/catalog', ...guard, (req, res) => {
  try {
    const cat = catalog.catalogFor(req.app);
    const q = req.query || {};
    const family = typeof q.family === 'string' && q.family ? q.family : null;
    const cls = typeof q.class === 'string' && q.class ? q.class : null;
    const tier = q.tier !== undefined && q.tier !== '' ? Number(q.tier) : null;
    const method = typeof q.method === 'string' && q.method ? q.method.toUpperCase() : null;
    const needle = typeof q.q === 'string' && q.q ? q.q.toLowerCase() : null;
    if (cls && !catalog.CLASSES.includes(cls)) {
      return res.status(400).json({ status: 'error', message: `class must be one of ${catalog.CLASSES.join(', ')}` });
    }
    if (tier !== null && ![0, 1, 2, 3].includes(tier)) {
      return res.status(400).json({ status: 'error', message: 'tier must be 0, 1, 2 or 3' });
    }
    const rows = cat.rows.filter(r =>
      (!family || r.family === family) &&
      (!cls || r.authClass === cls) &&
      (tier === null || r.tier === tier) &&
      (!method || r.method === method) &&
      (!needle || r.path.toLowerCase().includes(needle)));
    res.json({
      status: 'success',
      builtAt: cat.builtAt,
      summary: catalog.summary(cat.rows),
      filters: { family, class: cls, tier, method, q: needle },
      count: rows.length,
      rows,
      unknown: cat.unknown,
    });
  } catch (err) {
    console.error('[api.casey] catalog error:', err);
    res.status(500).json({ status: 'error', message: 'Catalog request failed' });
  }
});

// ── S1: tool layer test route ─────────────────────────────────────────────
router.get('/api/casey/tools', ...guard, (req, res) => {
  const tools = require('../services/casey/tools'); // lazy require (convention)
  res.json({ status: 'success', enabled: v2Enabled(), tools: tools.definitions() });
});

router.post('/api/casey/tools/:name', ...guard, async (req, res) => {
  try {
    if (!v2Enabled()) {
      return res.status(403).json({ status: 'error', message: 'Casey v2 is off (casey_v2_enabled = 0)' });
    }
    const tools = require('../services/casey/tools'); // lazy require (convention)
    const input = req.body && req.body.input;
    if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
      return res.status(400).json({ status: 'error', message: 'input must be an object' });
    }
    const out = await tools.runTool(req.params.name, tools.ctxFromRequest(req, 'tool-test'), input || {});
    if (!out.ok && out.error && out.error.code === 'UNKNOWN_TOOL') {
      return res.status(404).json({ status: 'error', message: out.error.message });
    }
    res.json({ status: 'success', ...out });
  } catch (err) {
    console.error('[api.casey] tool run error:', err);
    res.status(500).json({ status: 'error', message: 'Tool run failed' });
  }
});

module.exports = router;
