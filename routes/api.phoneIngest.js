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

router.get('/api/phone-ingest/executions', jwtOrApiKey, async (req, res) => {
  try {
    const hasMatch = req.query.has_match === 'true' ? true
                   : req.query.has_match === 'false' ? false
                   : undefined;
    const { rows, total, page, page_size } = await executionsService.list(req.db, {
      page:      req.query.page,
      page_size: req.query.page_size,
      status:    req.query.status,
      since:     req.query.since,
      until:     req.query.until,
      has_match: hasMatch,
    });
    res.json({ executions: rows, page, page_size, total });
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
// Body: { match_mode, match_config, limit?, since?, exec_id?, include_misses? }
//   exec_id — positive int; mutually exclusive with since (400 if both);
//             limit is ignored with it; not found / not reconstructable → 404.
// Response:
//   { success:true, total, matched_count, unparseable_skipped,
//     rows: [ { exec_id, ts, from, label, matched, fidelity, status } ] }
//   + when since was used: window_total (rows in range) and
//     truncated (window_total > total — the range overflowed the cap).
//   rows = matches newest-first (oldest-first when since given); when
//   include_misses, misses appended after them (same ordering).
// ─────────────────────────────────────────────────────────────

router.post('/api/phone-ingest/rules/test-match', jwtOrApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const { match_mode, match_config } = body;

    // ── validation ──
    if (match_mode !== 'conditions' && match_mode !== 'code') {
      return res.status(400).json({ error: "match_mode must be 'conditions' or 'code'" });
    }

    let limit = 100;
    if (body.limit !== undefined && body.limit !== null) {
      const n = Number(body.limit);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(300, n);
    }

    let since;
    if (body.since !== undefined && body.since !== null && body.since !== '') {
      const d = new Date(body.since);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid since datetime' });
      }
      since = body.since;
    }

    let execId;
    if (body.exec_id !== undefined && body.exec_id !== null && body.exec_id !== '') {
      const n = Number(body.exec_id);
      if (!Number.isInteger(n) || n < 1) {
        return res.status(400).json({ error: 'exec_id must be a positive integer' });
      }
      if (since !== undefined) {
        return res.status(400).json({ error: 'exec_id and since are mutually exclusive — target one execution or a date window, not both' });
      }
      execId = n; // limit is ignored in exec_id mode
    }

    const includeMisses = body.include_misses === true;

    if (match_mode === 'conditions') {
      // The production matcher treats a NULL conditions config as NON-match
      // (never match-all), so testing one is pointless — reject with the
      // explicit always-match shape instead.
      if (match_config == null || typeof match_config !== 'object' || Array.isArray(match_config)) {
        return res.status(400).json({
          error: "conditions mode requires match_config to be an object — for an explicit always-match, use {operator:'and', conditions:[]}",
        });
      }
    } else {
      // code mode — extract the code string EXACTLY the way _evaluateMatch
      // does: a string config is JSON.parse'd FIRST (the matcher's defensive
      // parse), THEN code = string-or-.code. A raw (non-JSON) code string
      // therefore never matches in production — reject it up front instead of
      // returning a misleading 0-match run. Then compile ONCE so a syntax
      // error is a clean 400 instead of 0-matches-with-N-warnings. The
      // compiled fn is DISCARDED — per-row evaluation still goes through
      // _evaluateMatch so runtime semantics (error swallowing included) are
      // byte-identical to production.
      let cfg = match_config;
      if (typeof cfg === 'string') {
        try { cfg = JSON.parse(cfg); }
        catch {
          return res.status(400).json({
            error: "match_config string is not valid JSON — the production matcher would treat this as non-match on every event; send {code:'...'} instead",
          });
        }
      }
      const code = typeof cfg === 'string' ? cfg : cfg?.code;
      if (!code || typeof code !== 'string' || !code.trim()) {
        return res.status(400).json({ error: 'code mode requires a non-empty code string (match_config.code)' });
      }
      try {
        // eslint-disable-next-line no-new-func
        new Function('input', code);
      } catch (err) {
        return res.status(400).json({ error: `code does not compile: ${err.message}` });
      }
    }

    // ── corpus + evaluation ──
    // exec_id → that one execution. Otherwise the windowed corpus (which,
    // unlike email, never had a status filter to widen).
    const corpus = execId !== undefined
      ? await sampleService.fetchEnvelopes(req.db, { exec_id: execId })
      : await sampleService.fetchEnvelopes(req.db, { limit, since });

    if (corpus.not_found) {
      return res.status(404).json({
        error: corpus.not_found === 'unparseable'
          ? `execution #${execId} has no parseable raw_input — nothing to evaluate`
          : `execution #${execId} not found`,
      });
    }

    const { rows, unparseable_skipped } = corpus;
    const testRule = { id: 'test-match', name: '(editor)', match_mode, match_config };
    const matches = [];
    const misses  = [];
    for (const r of rows) {
      const matched = ruleService._evaluateMatch(testRule, r.envelope);
      const shaped = {
        exec_id:  r.exec_id,
        ts:       r.ts,
        from:     (r.envelope && r.envelope.from != null) ? r.envelope.from : null,
        label:    sampleService._testLabel(r.envelope, r.event_type, r.ts),
        matched,
        fidelity: r.fidelity,
        status:   r.status,
      };
      (matched ? matches : misses).push(shaped);
    }

    const out = {
      success:             true,
      total:               rows.length,
      matched_count:       matches.length,
      unparseable_skipped: unparseable_skipped,
      rows:                includeMisses ? matches.concat(misses) : matches,
    };
    if (since !== undefined && corpus.window_total !== undefined) {
      out.window_total = corpus.window_total;
      out.truncated    = corpus.window_total > rows.length;
    }
    return res.json(out);
  } catch (err) {
    console.error('[phone-ingest] test-match error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


module.exports = router;