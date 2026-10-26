// routes/api.phoneIngest.js
//
/**
 * Phone Ingest — Management API (Stage 1)
 * routes/api.phoneIngest.js
 *
 * Suppression CRUD + meta for the phone log-suppression layer. Auto-mounted by
 * the routes/ loader (dropping this file in wires it; no server.js edit).
 *
 * Mirrors the management half of routes/api.emailIngest.js. There is NO public
 * receiver route here — phone events arrive via YisraHooks → workflows →
 * phone_log (lib/internal_functions.js), not over HTTP. This file is
 * management-only.
 *
 * All endpoints gated by jwtOrApiKey (same as api.hooks.js / api.emailIngest.js).
 * Writes emit an admin_audit_log row via auditAdminAction. tool = 'phone_ingest'.
 * last_modified_by is set server-side from req.auth.userId in the service.
 *
 * Validation errors thrown by the service (ValidationError, carrying a
 * .validationErrors array) are translated to a structured 400 here. The
 * service reuses emailIngestValidator.validateSuppression (table-agnostic).
 */

const express = require('express');
const router  = express.Router();

const jwtOrApiKey          = require('../lib/auth.jwtOrApiKey');
const { auditAdminAction } = require('../lib/auth.superuser');
const suppressionService   = require('../services/phoneIngestSuppressionService');
const ruleService          = require('../services/phoneIngestRuleService');
const executionsService    = require('../services/phoneIngestExecutionsService');
const metaService          = require('../services/phoneIngestMetaService');
const sampleService        = require('../services/phoneIngestSampleService');
const rulePreview          = require('../services/ingestRulePreviewService');


// ─────────────────────────────────────────────────────────────
// AUDIT + VALIDATION HELPERS (parallel to api.emailIngest.js)
// ─────────────────────────────────────────────────────────────

const PI_TOOL = 'phone_ingest';

function _reqMeta(req) {
  return {
    ip:        req.headers['x-forwarded-for']?.split(',').shift() || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'] || 'unknown',
  };
}

function auditPI(req, { status = 'success', errorMessage, details }) {
  const meta = _reqMeta(req);
  return auditAdminAction(req.db, {
    tool:     PI_TOOL,
    userId:   req.auth?.userId,
    username: req.auth?.username,
    route:    req.originalUrl,
    method:   req.method,
    status,
    ...(errorMessage ? { errorMessage } : {}),
    ...meta,
    details: details || {},
  }).catch((err) => console.error('[phone-ingest] audit log failed:', err.message));
}

// Translate a thrown ValidationError into the structured 400 body. Returns
// true if it handled the error (response sent), false otherwise.
function _handleValidationError(err, res) {
  if (err && err.name === 'ValidationError' && Array.isArray(err.validationErrors)) {
    const errs = err.validationErrors;
    if (errs.length === 1) {
      res.status(400).json({
        error:   'validation_failed',
        field:   errs[0].field,
        message: errs[0].message,
      });
    } else {
      res.status(400).json({ error: 'validation_failed', errors: errs });
    }
    return true;
  }
  return false;
}


// ─────────────────────────────────────────────────────────────
// SUPPRESSIONS
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/suppressions', jwtOrApiKey, async (req, res) => {
  try {
    const suppressions = await suppressionService.listAll(req.db);
    res.json({ status: 'success', suppressions });
  } catch (err) {
    console.error('[phone-ingest] list suppressions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/phone-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const row = await suppressionService.getById(req.db, req.params.id);
    if (!row) return res.status(404).json({ status: 'error', message: 'Suppression not found' });
    res.json({ status: 'success', suppression: row });
  } catch (err) {
    console.error('[phone-ingest] get suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/phone-ingest/suppressions', jwtOrApiKey, async (req, res) => {
  try {
    const row = await suppressionService.create(req.db, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'suppression', entity_id: row.id, after: row } });
    res.status(201).json({ status: 'success', suppression: row });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] create suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/phone-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await suppressionService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Suppression not found' });

    const after = await suppressionService.update(req.db, req.params.id, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'suppression', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', suppression: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] update suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/phone-ingest/suppressions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await suppressionService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Suppression not found' });

    await suppressionService.remove(req.db, req.params.id);
    auditPI(req, { details: { entity: 'suppression', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[phone-ingest] delete suppression error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RULES
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rules = await ruleService.listAll(req.db);
    res.json({ status: 'success', rules });
  } catch (err) {
    console.error('[phone-ingest] list rules error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/phone-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.getById(req.db, req.params.id);
    if (!rule) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    res.json({ status: 'success', rule });
  } catch (err) {
    console.error('[phone-ingest] get rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/phone-ingest/rules', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.createRule(req.db, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'rule', entity_id: rule.id, after: rule } });
    res.status(201).json({ status: 'success', rule });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] create rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/phone-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Rule not found' });

    const after = await ruleService.updateRule(req.db, req.params.id, req.body, req.auth.userId);
    auditPI(req, { details: { entity: 'rule', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', rule: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] update rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/phone-ingest/rules/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Rule not found' });

    await ruleService.deleteRule(req.db, req.params.id);
    auditPI(req, { details: { entity: 'rule', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[phone-ingest] delete rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Deep-copy a rule + its actions. The copy is created INACTIVE with name
// "<source> (copy)" — see ruleService.duplicateRule. Body is ignored.
router.post('/api/phone-ingest/rules/:id/duplicate', jwtOrApiKey, async (req, res) => {
  try {
    const rule = await ruleService.duplicateRule(req.db, req.params.id, req.auth.userId);
    if (!rule) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    auditPI(req, { details: { entity: 'rule', entity_id: rule.id, duplicated_from: Number(req.params.id), after: rule } });
    res.status(201).json({ status: 'success', rule });
  } catch (err) {
    console.error('[phone-ingest] duplicate rule error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// RULE ACTIONS
// ─────────────────────────────────────────────────────────────

router.post('/api/phone-ingest/rules/:id/actions', jwtOrApiKey, async (req, res) => {
  try {
    const action = await ruleService.addAction(req.db, req.params.id, req.body);
    if (action === null) return res.status(404).json({ status: 'error', message: 'Rule not found' });
    auditPI(req, { details: { entity: 'rule_action', entity_id: action.id, rule_id: Number(req.params.id), after: action } });
    res.status(201).json({ status: 'success', action });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] add action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/api/phone-ingest/rule-actions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getActionById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Action not found' });

    const after = await ruleService.updateAction(req.db, req.params.id, req.body);
    auditPI(req, { details: { entity: 'rule_action', entity_id: Number(req.params.id), before, after } });
    res.json({ status: 'success', action: after });
  } catch (err) {
    if (_handleValidationError(err, res)) return;
    console.error('[phone-ingest] update action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/phone-ingest/rule-actions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const before = await ruleService.getActionById(req.db, req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Action not found' });

    await ruleService.deleteAction(req.db, req.params.id);
    auditPI(req, { details: { entity: 'rule_action', entity_id: Number(req.params.id), before } });
    res.status(204).end();
  } catch (err) {
    console.error('[phone-ingest] delete action error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// EXECUTIONS (read-only)
//
// Phone-specific: NO `source` filter (phone has no sources table — events
// arrive via YisraHooks→workflows, not multi-source HTTP receivers). Otherwise
// identical to the email executions endpoints, including the flat list shape
// and the flat {execution, linked} detail shape.
// ─────────────────────────────────────────────────────────────

// NOTE ON `status`: one enum value only — list() silently DROPS an
// unrecognized value rather than erroring, so a comma list returns EVERY row
// while looking like it worked. See the same note on the email endpoint.
//
// T2 adds slim=true (drop raw_input) and has_failure=true (rows whose
// Layer-3 actions failed while `status` stayed green — execution #4529 is
// the canonical case).
router.get('/api/phone-ingest/executions', jwtOrApiKey, async (req, res) => {
  try {
    // has_match is TRI-STATE again as of T8. T6/F-4 had collapsed it to
    // true-or-absent because the SERVICE had no false predicate, so a parsed
    // `false` was silently identical to omitting the param. The service now
    // has that predicate (metadata->>'$.matched_rules' IS NULL), which is
    // exactly the precondition T6/F-4 named, so the false branch is live:
    // has_match=false means "rows where NO rule matched".
    const hasMatch = req.query.has_match === 'true'  ? true
                   : req.query.has_match === 'false' ? false
                   : undefined;

    // T8 — rule-scoped filters.
    //   rule_id       matched THAT rule (metadata.matched_rules)
    //   action_status an action outcome with that status; scoped to rule_id
    //                 when both are present.
    // Both are REJECTED with 400 on a bad value rather than silently dropped:
    // the whole point of these filters is answering "did rule N fire", and a
    // silently-ignored filter answers "yes" for every row on the page.
    let ruleId;
    if (req.query.rule_id !== undefined && req.query.rule_id !== '') {
      ruleId = Number(req.query.rule_id);
      if (!Number.isInteger(ruleId) || ruleId < 1) {
        return res.status(400).json({
          status: 'error',
          message: 'rule_id must be a positive integer',
        });
      }
    }
    const actionStatus = req.query.action_status || undefined;
    if (actionStatus && !executionsService.VALID_ACTION_STATUSES.has(actionStatus)) {
      return res.status(400).json({
        status: 'error',
        message: `action_status must be one of: ${[...executionsService.VALID_ACTION_STATUSES].join(', ')}`,
      });
    }

    const { rows, total, page, page_size, names } = await executionsService.list(req.db, {
      page:        req.query.page,
      page_size:   req.query.page_size,
      status:      req.query.status,
      since:       req.query.since,
      until:       req.query.until,
      has_match:     hasMatch,
      has_failure:   req.query.has_failure === 'true',
      rule_id:       ruleId,
      action_status: actionStatus,
      slim:          req.query.slim === 'true',
    });
    // `names` is additive — activity.html and any other consumer read only
    // `executions` and are unaffected.
    res.json({ executions: rows, page, page_size, total, names });
  } catch (err) {
    console.error('[phone-ingest] list executions error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/phone-ingest/executions/:id', jwtOrApiKey, async (req, res) => {
  try {
    const result = await executionsService.getById(req.db, req.params.id);
    if (!result) return res.status(404).json({ status: 'error', message: 'Execution not found' });
    res.json(result); // { execution, linked }
  } catch (err) {
    console.error('[phone-ingest] get execution error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// META
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/meta', jwtOrApiKey, async (req, res) => {
  try {
    // Returned FLAT (not wrapped under {status, meta}) to match
    // /api/email-ingest/meta — the phone UI is copied from the email UI and
    // expects the meta object at the top level. getMeta(db) is async (it now
    // queries the live target lists for the L3 action builder, mirroring email).
    const meta = await metaService.getMeta(req.db);
    res.json(meta);
  } catch (err) {
    console.error('[phone-ingest] meta error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// SAMPLE EVENTS (read-only, UI field-discovery aid)
//
// Returns the newest-N captured phone events (across all types), each PROJECTED
// to the match-field catalog — newest first, so the rule / suppression editor
// can let operators page through real events and see shape variation (e.g.
// data.duration_seconds present on some calls, absent on others). No value
// redaction; the projection is limited to catalog paths for correctness, not
// privacy. See services/phoneIngestSampleService.js + lib/ingestSampleProjection.js.
// ─────────────────────────────────────────────────────────────

router.get('/api/phone-ingest/sample-events', jwtOrApiKey, async (req, res) => {
  try {
    const result = await sampleService.getSampleEvents(req.db);
    res.json(result); // { samples: [{ exec_id, type, ts, label, fields:[...] }] }
  } catch (err) {
    console.error('[phone-ingest] sample-events error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// TEST-MATCH (Slice 10A — read-only, zero side effects)
//
// POST /api/phone-ingest/rules/test-match
//
// Evaluates an editor's CURRENT (unsaved) match config against recent
// historical phone events, using the PRODUCTION matcher
// (phoneIngestRuleService._evaluateMatch) — so semantics, including per-row
// error swallowing, are byte-identical to what the rule would do live. The
// corpus is the same raw_input sourcing the sample panel uses
// (sampleService.fetchEnvelopes — one sourcing implementation). Phone
// raw_input parses cleanly, so every evaluated row is fidelity:'full';
// unparseable rows are skipped entirely and surfaced in unparseable_skipped.
//
// No suppression evaluation — this tests the RULE layer only. No DB writes,
// no audit row (nothing changed), no dispatching.
//
// Slice 10C — `since` anchors the window at its START (oldest-first from the
// date, with truncation reporting) and `exec_id` targets one specific
// execution. Phone's corpus was never status-filtered (suppressed phone
// events were always testable), so there is no email-style scope widening
// here — only the targeting/window/status additions.
//
// Body: { match_mode, match_config, limit?, since?, until?, exec_id?, include_misses? }
//   until — inclusive upper date bound (Slice 10D); composable with since
//           for a range (400 when until < since); exec_id excludes it too.
//   exec_id — positive int; mutually exclusive with since (400 if both);
//             limit is ignored with it; not found / not reconstructable → 404.
// Response:
//   { success:true, total, matched_count, unparseable_skipped,
//     rows: [ { exec_id, ts, from, label, matched, fidelity, status } ] }
//   + when since and/or until was used: window_total (rows in range) and
//     truncated (window_total > total — the range overflowed the cap).
//   rows = matches newest-first (oldest-first when since given); when
//   include_misses, misses appended after them (same ordering).
// ─────────────────────────────────────────────────────────────

router.post('/api/phone-ingest/rules/test-match', jwtOrApiKey, async (req, res) => {
  // Core extracted to services/ingestRulePreviewService.js (A20.1), shared
  // with Casey's automation.preview_ingest_rule; this response is unchanged —
  // pinned against a pre-extraction golden by tests/ingestRulePreview.routes.test.js.
  try {
    const r = await rulePreview.testMatch(req.db, 'phone', req.body || {});
    return res.status(r.status).json(r.body);
  } catch (err) {
    console.error('[phone-ingest] test-match error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ─────────────────────────────────────────────────────────────
// TEST-TRANSFORM (read-only, zero side effects)
//
// POST /api/phone-ingest/rules/test-transform
//
// Runs an editor's CURRENT (unsaved) transform config against ONE event —
// either a historical execution (exec_id, sourced through the SAME fetcher
// test-match uses, so fidelity/status semantics carry over) or an inline
// `input` object — using the PRODUCTION runner
// (ruleService._runTransform), so semantics are byte-identical to what the
// rule would do live. A failed transform is a RESULT here (transform.ok =
// false, HTTP 200), not a request error: "your transform fails on this
// event — actions would be skipped" is the diagnostic payoff. Only
// request-shape problems 400.
//
// Production-parity note: _runTransform's mapper branch console.warns
// per-rule mapper errors but still returns ok:true with the partial output
// (mirroring the hook system's non-fatal mapper errors). Those warnings are
// NOT surfaced in this response — surfacing them would require bypassing the
// production runner. The output shown IS what actions would receive.
//
// params_mappings (optional, ≤20 of {label?, mapping}): each mapping is
// resolved against the transform output with actionDispatchers.
// resolveParamsMapping — deliberately the dispatcher's copy, which carries
// the Slice 9A '$' whole-object rule that live ingest dispatch uses
// (hookService's local copy lacks it). Skipped when the transform failed.
//
// Body: { transform_mode, transform_config, exec_id? | input?, params_mappings? }
//   exec_id — positive int; mutually exclusive with input (exactly one).
//   input   — inline event object (the shape the transform sees in prod).
// Response:
//   { success:true, source: {exec_id, ts, fidelity, status} | 'inline',
//     input, transform: {ok, output?, error?}, resolved_params?:
//     [{label, params}] }
// ─────────────────────────────────────────────────────────────

router.post('/api/phone-ingest/rules/test-transform', jwtOrApiKey, async (req, res) => {
  // Core extracted to services/ingestRulePreviewService.js (A20.1), shared
  // with Casey's automation.preview_ingest_rule; this response is unchanged —
  // pinned against a pre-extraction golden by tests/ingestRulePreview.routes.test.js.
  try {
    const r = await rulePreview.testTransform(req.db, 'phone', req.body || {});
    return res.status(r.status).json(r.body);
  } catch (err) {
    console.error('[phone-ingest] test-transform error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;