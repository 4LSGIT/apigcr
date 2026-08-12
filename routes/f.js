// routes/f.js
//
/**
 * f.js — the SMS-friendly external form link (X2).
 * Contract: ref/EXTERNAL_FORMS_DESIGN.md §5.1.
 *
 *   GET /f/:form_key?case_id=...   →  302 /forms/render.html?form_key=...&ext=1&...
 *
 * A two-segment path, so the server.js `/:page` single-segment catch-all
 * (mounted BEFORE the route loop) can never capture it — verified by
 * construction, X2 boot. Auto-mounted; req.db attached upstream (unused —
 * this route touches nothing but the URL).
 *
 * Every incoming query param is FORWARDED (minus form_key/ext, which this
 * route owns): case_id rides through to the renderer/API, and the X2
 * urlParam prefill feature means arbitrary staff-declared params
 * (?src=facebook) must survive the hop. Forwarding is pure re-encoding —
 * nothing here is interpreted, stored, or queried, and the redirect target
 * is a same-origin relative path (no open-redirect surface).
 *
 * form_key is shape-gated before it is embedded anywhere. A bad shape gets
 * the same generic 404 the API surface uses — this route stays oracle-free
 * by never consulting the DB at all: existence/visibility/refusal are the
 * API's call one hop later.
 */

'use strict';

const express = require('express');
const router = express.Router();

const FORM_KEY_RE = /^[a-z0-9_]{1,50}$/;   // services/formTemplateService.js contract §2

// Renderer/route mode switches — never forwarded (X2.1, N1). form_key and ext
// are set by this route; preview and template_id belong to the authed preview
// boot. Mirrors URL_PARAM_RESERVED in formTemplateService.js, minus the
// credential params (case_id, contact_id, appt_id) which MUST ride through.
const RESERVED_PARAMS = new Set(['form_key', 'ext', 'preview', 'template_id']);

router.get('/f/:form_key', (req, res) => {
  const formKey = req.params.form_key;
  if (!FORM_KEY_RE.test(formKey)) {
    return res.status(404).json({ status: 'error', message: 'Not found' });
  }

  const params = new URLSearchParams();
  params.set('form_key', formKey);
  params.set('ext', '1');
  for (const [k, v] of Object.entries(req.query)) {
    // Strip the params the RENDERER consumes as mode switches (X2.1, §9
    // co-review N1). These are already reserved against urlParam declarations
    // for exactly this reason; forwarding them let an external link flip the
    // renderer into a mode it cannot serve — /f/x?preview=1 reached the
    // preview branch, found no parent apiSend, and died on "must run inside
    // the app". No data leak (preview is authed), but it is a confusing dead
    // end reachable from a public URL.
    if (RESERVED_PARAMS.has(k)) continue;
    // Express may deliver repeated params as arrays — forward every value
    // in order (the renderer's urlParam rule is last-wins).
    if (Array.isArray(v)) {
      for (const one of v) params.append(k, String(one));
    } else if (typeof v === 'string') {
      params.append(k, v);
    }
    // Nested-object query shapes (a[b]=c) are dropped: no consumer exists.
  }

  res.set('Cache-Control', 'no-store');
  return res.redirect(302, '/forms/render.html?' + params.toString());
});

module.exports = router;