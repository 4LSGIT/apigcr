// routes/api.ext.forms.js
//
/**
 * api.ext.forms.js — the EXTERNAL form surface (X2).
 * Contract: ref/EXTERNAL_FORMS_DESIGN.md §5. Auto-mounted (server.js loop).
 *
 * GET  /api/ext/forms/:form_key?case_id=   — everything the external renderer
 *      needs in one payload: projected published definition + the server-
 *      computed 3-field prefill projection. §5.2.
 * POST /api/ext/forms/:form_key/submit     — body { case_id?, values }.
 *      Server re-validates values, resolves linkage from the credential,
 *      records the submission, dispatches onSubmit.workflow SERVER-SIDE from
 *      the published definition. §5.3.
 *
 * UNAUTHED BY DESIGN — the credential is the case_id bearer param (48-bit
 * crypto-random, the incumbent docReq/intake pattern). The portal-mode slice
 * adds the portal JWT as a second credential ON THESE ROUTES (wider
 * visibility scope), never a route fork.
 *
 * THE ONE GENERIC 404 (§5.4 no-oracle): missing template, unpublished, wrong
 * visibility, and refused keys (§4) are indistinguishable — same status,
 * same body. The badLink-reject branch adds `badLink: true` (renderer maps
 * it to the standing Unauthorized-Link copy, §6): that flag fires only after
 * every template gate passed, so it reveals only that a PUBLIC form exists
 * under a key — which its public link already reveals. It never confirms
 * whether the supplied case_id was real vs malformed vs absent.
 *
 * Rate limiting: lib/rateLimiter (makeLimiter + getClientIp — the
 * post-hardening pattern; NOT express-rate-limit keyed on req.ip, which
 * collapses external traffic into one global bucket on this chain — see the
 * lib's doc block, verified 2026-08-05). Per-instance in-memory, accepted
 * best-effort posture. Plus a per-case submit cap against link-holder spam.
 */

'use strict';

const express = require('express');
const router = express.Router();
const { makeLimiter, getClientIp } = require('../lib/rateLimiter');
const extSvc = require('../services/extFormService');
const formService = require('../services/formService');

// §5.4 suggested budgets.
const getLimited        = makeLimiter(15 * 60 * 1000, 30);  // GET  30 / 15min / IP
const postLimited       = makeLimiter(15 * 60 * 1000, 10);  // POST 10 / 15min / IP
const perCaseLimited    = makeLimiter(60 * 60 * 1000, 5);   // POST  5 / hour / case_id
const MAX_BODY_BYTES    = 64 * 1024;                        // intake is ~7 questions

const notFoundBody = { status: 'error', message: 'Not found' };
const badLinkBody  = { status: 'error', message: 'Not found', badLink: true };

const tooMany = (res) =>
  res.status(429).json({ status: 'error', message: 'Too many requests, please try again shortly.' });

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ext/forms/:form_key — §5.2
// ─────────────────────────────────────────────────────────────────────────────

router.get('/api/ext/forms/:form_key', async (req, res) => {
  try {
    if (getLimited(getClientIp(req))) return tooMany(res);

    // 1–2. Template gate: published + visibility + §4 refusal scan. One null,
    //      one generic 404.
    const tpl = await extSvc.getServableTemplate(req.db, req.params.form_key);
    if (!tpl) return res.status(404).json(notFoundBody);

    // 3. Credential resolution — the server resolves everything (§2); the
    //    only client input consumed here is the case_id bearer itself.
    const caseId = typeof req.query.case_id === 'string' ? req.query.case_id : '';
    const resolved = await extSvc.resolveCase(req.db, caseId);

    let load = null;
    let linked = false;
    if (resolved.valid) {
      load = resolved.load;              // exactly 3 fields, Primary only (§5.2.3)
      linked = true;
    } else if (extSvc.badLinkMode(tpl.definition) === 'reject') {
      // §6 reject (the default): invalid AND missing case_id land here —
      // identically, never confirming which.
      return res.status(404).json(badLinkBody);
    }
    // §6 degrade: anonymous mode — the form works, load stays null.

    // 5. Prefill is per-case PII — never cacheable.
    res.set('Cache-Control', 'no-store');
    return res.json({
      status: 'success',
      title: tpl.title,
      link_type: tpl.link_type,
      schema_version: tpl.schema_version,
      definition: extSvc.projectDefinition(tpl.definition),
      load,
      linked,
    });
  } catch (err) {
    console.error('[api.ext.forms] GET error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ext/forms/:form_key/submit — §5.3
// ─────────────────────────────────────────────────────────────────────────────

router.post('/api/ext/forms/:form_key/submit', async (req, res) => {
  try {
    if (postLimited(getClientIp(req))) return tooMany(res);

    // Body size cap (§5.4). The global express.json (10mb) has already
    // parsed by the time we run, so this bounds what we accept and store,
    // not the parse cost — acceptable for the volumes involved.
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BODY_BYTES) {
      return res.status(413).json({ status: 'error', message: 'Request too large' });
    }

    // 1. Same template gate as GET — per-request, belt and suspenders (§4).
    const tpl = await extSvc.getServableTemplate(req.db, req.params.form_key);
    if (!tpl) return res.status(404).json(notFoundBody);
    const def = tpl.definition;

    // Body: { case_id?, values } and NOTHING else (§2 inversion — the client
    // supplies field values and nothing else; link_type/link_id/workflow ids
    // in the body are exactly the inputs this surface must never consume).
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    for (const k of Object.keys(body)) {
      if (k !== 'case_id' && k !== 'values') {
        return res.status(400).json({ status: 'error', message: `unexpected body key "${k}"` });
      }
    }

    // 3. Linkage resolved SERVER-SIDE from the credential.
    const caseId = typeof body.case_id === 'string' ? body.case_id : '';
    const resolved = await extSvc.resolveCase(req.db, caseId);

    let linkType = '';
    let linkId = '';
    if (resolved.valid) {
      // Per-case cap — link-holder spam control (§5.4). Keyed on a case_id
      // that just proved real, so the bucket space is bounded by real cases.
      if (perCaseLimited(caseId)) return tooMany(res);
      linkType = 'case';
      linkId = caseId;
    } else if (extSvc.badLinkMode(def) === 'reject') {
      return res.status(404).json(badLinkBody);
    }
    // degrade: ('','') — the NOT NULL unlinked convention; the draft_key
    // generated column is NULL for submitted rows, so anonymous volume is
    // structurally fine.

    // 2. Server-side re-validation against the PUBLISHED definition (§5.3.2).
    try {
      extSvc.validateValues(def, body.values);
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ status: 'error', message: err.message });
      }
      throw err;
    }

    // 4. Record the submission. submitted_by NULL = external (§5.3.4).
    //    NOTE what is absent here (§5.3.5, test-locked): no apiColumn PATCH,
    //    no caseService write of any kind — submission JSON only, regardless
    //    of what the definition declares.
    const submitResult = await formService.submitForm(
      req.db, tpl.form_key, linkType, linkId, tpl.schema_version, body.values, null
    );

    // 6. onSubmit.workflow — SERVER-SIDE, the sanctioned side-effect channel.
    //    The workflow id comes from the PUBLISHED DEFINITION, never the
    //    request body. initData mirrors the internal client's assembly
    //    exactly (yc-forms.js save() step 5): field values as base, config
    //    initData overrides, system fields always win. Fire-and-forget via
    //    the existing wf→wf creation path (lib/internal_functions
    //    start_workflow: active check, contact resolution, capture,
    //    detached advance) — a workflow failure never fails the submission,
    //    which is already recorded.
    const wf = def.onSubmit && def.onSubmit.workflow;
    if (wf && Number.isInteger(Number(wf.id)) && Number(wf.id) > 0) {
      const initData = Object.assign(
        {},
        body.values,
        wf.initData || {},
        {
          form_key: tpl.form_key,
          link_type: linkType,
          link_id: linkId,
          submission_id: submitResult.id,
        }
      );
      const internalFunctions = require('../lib/internal_functions');
      Promise.resolve(
        internalFunctions.start_workflow(
          { workflow_id: Number(wf.id), init_data: initData }, req.db
        )
      ).catch((err) => {
        console.error(
          `[api.ext.forms] onSubmit.workflow ${wf.id} failed for ${tpl.form_key}:`,
          err && err.message
        );
      });
    }

    // Minimal success body — the external renderer needs nothing more, and
    // submission ids are sequential (a volume oracle worth not handing out).
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('[api.ext.forms] submit error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

module.exports = router;