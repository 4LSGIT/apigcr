// routes/api.pipelineBoard.js
//
/**
 * routes/api.pipelineBoard.js — Kanban board read route for the Case
 * Pipeline Engine (Slice C3).
 *
 * GET /api/pipeline-board?template_id=N[&include_closed=1]
 *   → { status: 'success', template, stages, columns }
 *     template — pipeline_templates row
 *     stages   — active stages, stage_number order (incl. client_visible)
 *     columns  — { unstaged: [cards], <stage_key>: [cards] }; membership
 *                mirrors pipelineService.resolveTemplate (see
 *                pipelineAdminService.getBoard), placement is the case's
 *                latest case_stage_log row matched by stage_key.
 *   include_closed=1 (or =true) lifts the default case_stage='Closed'
 *   exclusion.
 *
 * Auto-mounted from routes/ (server.js readdir loop). Distinct
 * /api/pipeline-board prefix — no collision with api.pipeline.js (frozen
 * Slice B), api.pipelineAdmin.js (Slice C2), or anything else in routes/.
 *
 * Auth + envelope match routes/api.pipelineAdmin.js: jwtOrApiKey;
 * { status: 'success', ... } / { status: 'error', message }; service throws
 * carry `.status` (400 bad template_id, 404 unknown template), anything else
 * is a 500.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const svc = require('../services/pipelineAdminService');

// Map a thrown service error to an HTTP response.
function fail(res, tag, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(`[api.pipelineBoard] ${tag} error:`, err);
  res.status(status).json({ status: 'error', message: err.message });
}

router.get('/api/pipeline-board', jwtOrApiKey, async (req, res) => {
  try {
    const includeClosed =
      req.query.include_closed === '1' || req.query.include_closed === 'true';
    const payload = await svc.getBoard(req.db, req.query.template_id, { includeClosed });
    res.json({ status: 'success', ...payload });
  } catch (err) {
    fail(res, 'getBoard', err);
  }
});

module.exports = router;