// routes/api.commsEval.js
//
/**
 * Comms archive S0 evaluation (lane D) — the review page's API.
 * Service: services/commsEvalService.js. Page: scripts/commsArchive/eval/review-tool.html
 * (an Admin → Tools page; it holds no data and calls these routes through the shell's apiSend).
 *
 *   GET  /api/comms-eval/items                       the sample: ids + metadata only
 *   GET  /api/comms-eval/items/:id/audio             5-minute signed URL          (audit: listen)
 *   GET  /api/comms-eval/items/:id/transcript        segments, after the noise tag (audit: view_transcript)
 *   GET  /api/comms-eval/items/:id/review            my own saved scores (numbers / tags only; not audited)
 *   PUT  /api/comms-eval/items/:id/review/:stage     save my scores               (audit: eval_score)
 *   POST /api/comms-eval/sample                      SU + step-up: insert the sample   (audit: eval_sample)
 *   POST /api/comms-eval/signing-check               SU + step-up: the signing proof    (audit: signing_check)
 *
 * WHO: a staff JWT that is SU, or listed in app_settings comms_eval_reviewers
 * (services/commsArchiveAdmin.isEvalReviewer — every auth comparison of this
 * arc lives there). API keys never. Reviewers reach ONLY the sampled items, and
 * the list hides unavailable ones from non-SU. The two SU routes also pass
 * lib/auth.superuser's superuserOnlyFor chain (the token's SU claim, the
 * X-SU-Elevation step-up, its rate limit) BEFORE the DB-checked gate: adding
 * to the sample widens who can hear which call.
 *
 * AUDIT (design P9, §7): every content access (listen, view_transcript), every
 * score save, sample insert and signing check, and every refusal by the gate
 * writes an admin_audit_log row, tool 'comms_archive', details.action +
 * media_id — never content, never a URL, never a submitted field's name (a 400
 * is audited as "invalid request"). NOT audited: the list and GET …/review (my
 * own scores — metadata, not content), including their 404s.
 *
 * Auto-mounted (server.js readdirSync); req.db injected.
 */

'use strict';

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction, superuserOnlyFor } = require('../lib/auth.superuser');
const admin = require('../services/commsArchiveAdmin');
const evals = require('../services/commsEvalService');

const TOOL = 'comms_archive';

function reqMeta(req) {
  return {
    tool: TOOL,
    userId: req.auth?.userId ?? null,
    username: req.auth?.username ?? null,
    route: req.originalUrl,
    method: req.method,
    ip: req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

async function audit(req, status, details, errorMessage = null) {
  try {
    await auditAdminAction(req.db, { ...reqMeta(req), status, details, errorMessage });
  } catch (err) {
    console.error('[commsEval] audit log failed:', err.message);
  }
}

const idOf = (req) => (/^\d{1,19}$/.test(String(req.params.id || '')) ? Number(req.params.id) : null);

/**
 * Wraps a handler with the gate. `who`: 'reviewer' | 'su'. `action`: the audit
 * action, or null for an unaudited read (the list).
 */
function gated(who, action, fn) {
  return async (req, res) => {
    const id = req.params.id !== undefined ? idOf(req) : undefined;
    const details = { action, ...(id !== undefined ? { media_id: id ?? String(req.params.id).slice(0, 32) } : {}),
      ...(req.params.stage !== undefined ? { stage: String(req.params.stage).slice(0, 16) } : {}) };
    if (!req.auth || req.auth.type !== 'jwt' || req.auth.userId == null) {
      await audit(req, 'rejected_not_jwt', { ...details, action: action || 'eval_list' });
      return res.status(403).json({ status: 'error', message: 'A signed-in user is required' });
    }
    let ok = false;
    try {
      ok = who === 'su' ? await admin.isArchiveSu(req.db, req.auth) : await admin.isEvalReviewer(req.db, req.auth);
    } catch (err) {
      console.error('[commsEval] gate error:', err.code || '', err.message);
      return res.status(500).json({ status: 'error', message: 'Evaluation request failed' });
    }
    if (!ok) {
      await audit(req, who === 'su' ? 'rejected_not_su' : 'rejected_not_reviewer', { ...details, action: action || 'eval_list' });
      return res.status(403).json({ status: 'error', message: who === 'su' ? 'SU only' : 'Evaluation reviewers only' });
    }
    if (id === null) {
      await audit(req, 'rejected_bad_request', details, 'bad id');
      return res.status(400).json({ status: 'error', message: 'Bad item id' });
    }
    try {
      const out = await fn(req, id, Number(req.auth.userId));
      if (action) await audit(req, 'success', details);
      return res.json({ status: 'success', ...out });
    } catch (err) {
      const status = Number.isInteger(err && err.status) ? err.status : 500;
      if (status >= 500) console.error(`[commsEval] ${action || 'list'} error:`, err.message);
      if (action) {
        await audit(req, status === 404 ? 'not_found' : status === 410 ? 'gone' : status === 409 ? 'conflict'
          : status === 400 ? 'rejected_bad_request' : 'failed', details,
          status === 400 ? 'invalid request' : (err.message || '').slice(0, 1000));
      }
      return res.status(status).json({
        status: 'error',
        message: err.expose ? err.message : 'Evaluation request failed',
        ...(err.refused ? { refused: err.refused } : {}),
      });
    }
  };
}

router.get('/api/comms-eval/items', jwtOrApiKey, gated('reviewer', null, async (req, _id, uid) => ({
  ...await (async () => {
    const su = await admin.isArchiveSu(req.db, req.auth);
    return { items: await evals.listItems(req.db, uid, { su }), me: { su } };
  })(),
})));

router.get('/api/comms-eval/items/:id/audio', jwtOrApiKey, gated('reviewer', 'listen',
  async (req, id) => evals.audioUrl(req.db, id)));

router.get('/api/comms-eval/items/:id/transcript', jwtOrApiKey, gated('reviewer', 'view_transcript',
  async (req, id, uid) => evals.transcript(req.db, id, uid)));

router.get('/api/comms-eval/items/:id/review', jwtOrApiKey, gated('reviewer', null,
  async (req, id, uid) => ({ reviews: await evals.myReviews(req.db, id, uid) })));

router.put('/api/comms-eval/items/:id/review/:stage', jwtOrApiKey, gated('reviewer', 'eval_score',
  async (req, id, uid) => ({ scores: await evals.saveReview(req.db, id, uid, String(req.params.stage), req.body?.scores) })));

router.post('/api/comms-eval/sample', superuserOnlyFor(TOOL), gated('su', 'eval_sample',
  async (req, _id, uid) => evals.addSample(req.db, req.body, uid)));

router.post('/api/comms-eval/signing-check', superuserOnlyFor(TOOL), gated('su', 'signing_check', async () => {
  const r = await evals.signingCheck();
  if (!r.pass) { const e = new Error(`Signing check failed: ${JSON.stringify(r)}`); e.status = 502; e.expose = true; e.result = r; throw e; }
  return { check: r };
}));

module.exports = router;
