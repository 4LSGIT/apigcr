// routes/api.ext.forms.js
//
/**
 * api.ext.forms.js — the EXTERNAL form surface (X2).
 * Contract: ref/EXTERNAL_FORMS_DESIGN.md §5. Auto-mounted (server.js loop).
 *
 * GET  /api/ext/forms/:form_key?case_id=   — everything the external renderer
 *      needs in one payload: projected published definition + the server-
 *      computed 3-field prefill projection. §5.2. Carries `draft` only when
 *      the template opted into server drafts AND the case resolved (D1).
 * POST /api/ext/forms/:form_key/submit     — body { case_id?, values }.
 *      Server re-validates values, resolves linkage from the credential,
 *      records the submission, dispatches onSubmit.workflow SERVER-SIDE from
 *      the published definition. §5.3.
 * POST   /api/ext/forms/:form_key/draft            — body { case_id, values }.
 * DELETE /api/ext/forms/:form_key/draft?case_id=   — D1 server-side drafts,
 *      opt-in per template (external.serverDrafts) and LINKED-ONLY. See the
 *      block comment above those handlers for the trust-model note.
 *
 * UNAUTHED BY DESIGN — the credential is the case_id bearer param (40-bit;
 * see the entropy note in extFormService.js — the incumbent docReq/intake
 * pattern). The portal-mode slice
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

// D1 draft budgets — necessarily looser than submit's, because an autosave is
// not an event, it is a heartbeat. The client debounces at autosaveMs (3000
// default, yc-forms.js), so a client typing steadily through a long
// questionnaire legitimately produces roughly one POST per typing pause. 10
// per 15 minutes — the submit budget — would cut a real client off inside the
// first section of a 300-field form.
const draftLimited        = makeLimiter(15 * 60 * 1000, 60);   // draft POST/DELETE 60 / 15min / IP
// 360/hr, not the original 120 (corrected 2026-09-04, Fred-ratified). The
// autosave is a DEBOUNCE reset on every change (yc-forms _onFieldChange), so
// the worst case a legitimate filler can produce is one POST per autosaveMs —
// 360/hr at the 10s the DBKQ uses. A cap BELOW the worst case degrades a
// continuous filler to device-local drafts partway through the form, which is
// precisely the resume this feature exists to provide. Cap == worst case: an
// honest client never trips it, and anything above it is not a form-filler.
// Throttled requests still fall back to the local write with an honest status.
const perCaseDraftLimited = makeLimiter(60 * 60 * 1000, 360);  // draft POST 360 / hour / case_id

// form_key shape (services/formTemplateService.js §2). Gated before the DB is
// touched, mirroring routes/f.js — symmetry, and one less free query per
// junk request inside the limiter budget (X2.1, §9 co-review N8).
const FORM_KEY_RE = /^[a-z0-9_]{1,50}$/;

/**
 * X2.1 (§9 co-review F1) — REVOKE the ambient CORS grant on this router.
 *
 * server.js applies `cors({ origin: '*' })` globally, which let ANY web page
 * read these responses from a visitor's browser. That converted a 40-bit
 * bearer credential (see the entropy note in extFormService.js) from
 * unguessable-per-IP into enumerable-by-botnet: ~1e9 expected guesses spread
 * across hijacked browsers is a day's work, with every per-IP bucket intact,
 * and each hit returns a bankruptcy client's name, phone, and email.
 *
 * Removing the header — rather than naming an allowed origin — is both
 * tighter and less brittle: nothing legitimate is cross-origin. The SMS flow
 * is same-origin (/f/ redirects to /forms/render.html on this host), and a
 * website embed is an IFRAME of that same page, whose fetches are likewise
 * same-origin. Simple GETs will still be SENT cross-origin, but the response
 * is unreadable; the JSON content-type on submit makes that one preflighted,
 * which now fails outright.
 *
 * If a cross-origin (non-iframe) embed is ever wanted, do not simply restore
 * '*' — name the origin, and redo the F1 arithmetic first.
 */
function noCors(req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.set('Cache-Control', 'no-store');     // N3: every branch, not just 200
  next();
}
router.use('/api/ext', noCors);

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
    if (!FORM_KEY_RE.test(req.params.form_key)) return res.status(404).json(notFoundBody);

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

    // 3b. D1 — the resumable server draft, when the template opted in AND the
    //     case resolved. See the DRAFT ROUTES block comment below for why
    //     readback is acceptable under the same bearer credential.
    //
    //     PRESENCE IS THE CLIENT'S SIGNAL, so it is exact: the key rides when
    //     (and only when) serverDrafts is on and the request is linked —
    //     present-and-null when no draft exists yet, absent entirely
    //     otherwise. The renderer reads `'draft' in payload` to decide whether
    //     to use the server path at all; a null value must therefore mean
    //     "enabled, nothing saved", never "not enabled". Anonymous requests
    //     get no key: an anonymous server draft has no identity, so the
    //     client's localStorage/sessionStorage path is the whole story there.
    //
    //     NOTE what is NOT here: the latest submitted row. getServerDraft
    //     reads three columns of the draft row and nothing else — resume
    //     needs the draft, and last time's answers are not the external
    //     surface's to hand back on a guessed credential.
    let draft;
    if (linked && extSvc.serverDraftsEnabled(tpl.definition)) {
      draft = await extSvc.getServerDraft(req.db, tpl.form_key, caseId);
    }

    // 5. (Cache-Control: no-store is set for every branch by noCors above —
    //     prefill is per-case PII, and N3 flagged that the 404 branches were
    //     previously uncovered.)
    // postSubmit (X3): the one `external.*` key the renderer consumes — the
    // terminal thank-you panel config. Hoisted to the response top level
    // rather than widening the definition projection: `external` stays off
    // the public definition wire (§D allowlist), and the three keys here are
    // exactly what validateDefinition admitted (message string ≤2000,
    // edit/new booleans). badLink remains server-only.
    const ps = tpl.definition.external && tpl.definition.external.postSubmit;
    const postSubmit = ps && typeof ps === 'object'
      ? {
          ...(typeof ps.message === 'string' ? { message: ps.message } : {}),
          ...(ps.edit === true ? { edit: true } : {}),
          ...(ps.new === true ? { new: true } : {}),
          // X3.3: navigate instead of panel. redirectBack only ever rides a
          // same-origin-path redirect (validateDefinition enforces the pair;
          // the renderer re-guards before appending the credential-bearing
          // ?b= back-link).
          ...(typeof ps.redirect === 'string' && ps.redirect ? { redirect: ps.redirect } : {}),
          ...(ps.redirectBack === true ? { redirectBack: true } : {}),
        }
      : null;

    // appearance (2026-08-16 §Q1): the external-safe styling channel —
    // strict hex-color CSS custom property values, hoisted like postSubmit
    // (`external` stays off the public definition wire, §D allowlist).
    // Re-filtered here per key against the SAME hex regex validateDefinition
    // enforces (belt and suspenders, the content-src precedent): an
    // out-of-shape value is dropped, never forwarded.
    const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
    const apSrc = tpl.definition.external && tpl.definition.external.appearance;
    let appearance = null;
    if (apSrc && typeof apSrc === 'object') {
      const ap = {};
      for (const k of ['bgFrom', 'bgTo']) {
        if (typeof apSrc[k] === 'string' && HEX_RE.test(apSrc[k])) ap[k] = apSrc[k];
      }
      if (Object.keys(ap).length) appearance = ap;
    }

    return res.json({
      status: 'success',
      title: tpl.title,
      link_type: tpl.link_type,
      schema_version: tpl.schema_version,
      definition: extSvc.projectDefinition(tpl.definition),
      load,
      linked,
      // D1: present-and-null when enabled+linked with nothing saved; absent
      // otherwise. The renderer's serverDrafts signal is `'draft' in payload`.
      ...(draft !== undefined ? { draft } : {}),
      ...(postSubmit ? { postSubmit } : {}),
      ...(appearance ? { appearance } : {}),
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
    if (!FORM_KEY_RE.test(req.params.form_key)) return res.status(404).json(notFoundBody);

    // (Body size is enforced inside validateValues on the PARSED payload —
    // X2.1/F5. The Content-Length check that used to sit here was absent
    // under chunked encoding, and ran after express.json had already parsed,
    // so it never bounded parse cost either.)

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
      linkType = 'case';
      linkId = caseId;
    } else if (extSvc.badLinkMode(def) === 'reject') {
      return res.status(404).json(badLinkBody);
    }
    // degrade: ('','') — the NOT NULL unlinked convention; the draft_key
    // generated column is NULL for submitted rows, so anonymous volume is
    // structurally fine.

    // 2. Server-side re-validation against the PUBLISHED definition (§5.3.2).
    //    Runs BEFORE the per-case cap is consumed — see below.
    try {
      extSvc.validateValues(def, body.values);
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ status: 'error', message: err.message });
      }
      throw err;
    }

    // 3b. Per-case cap — link-holder spam control (§5.4), keyed on a case_id
    //     that just proved real, so the bucket space is bounded by real cases.
    //     ORDER MATTERS (X2.1, §9 co-review F5): consuming this before
    //     validation made it a lockout weapon — five malformed POSTs from
    //     anyone holding the link (or five honest mistakes by the client
    //     themselves) locked the real client out for an hour. Only
    //     well-formed submissions spend a token now. This does not make the
    //     cap un-abusable by a link holder — five VALID submissions still
    //     exhaust it — but that is inherent to per-case capping, and the
    //     remaining case is indistinguishable from a real client submitting.
    if (linkId && perCaseLimited(linkId)) return tooMany(res);

    // 4. Record the submission. submitted_by NULL = external (§5.3.4).
    //    NOTE what is absent here (§5.3.5, test-locked): no apiColumn PATCH,
    //    no caseService write of any kind — submission JSON only, regardless
    //    of what the definition declares.
    const submitResult = await formService.submitForm(
      req.db, tpl.form_key, linkType, linkId, tpl.schema_version, body.values, null,
      { surface: 'external' }
    );

    // 4b. D1 — retire the now-superseded server draft. FIRE-AND-FORGET, the
    //     house pattern (see the workflow dispatch below): the submission is
    //     already recorded and irreversible at this point, so a failed DELETE
    //     must never turn a successful submit into an error the client would
    //     retry. Worst case on failure is a stale draft row whose banner
    //     offers older answers than the submission — annoying, not lossy, and
    //     the next autosave overwrites it. Nothing to do when the template is
    //     not opted in (no draft row can exist) or the submit was anonymous.
    if (linkId && extSvc.serverDraftsEnabled(def)) {
      Promise.resolve(
        formService.deleteDraft(req.db, tpl.form_key, linkType, linkId)
      ).catch((err) => {
        console.error(
          `[api.ext.forms] draft cleanup failed for ${tpl.form_key}/${linkId}:`,
          err && err.message
        );
      });
    }

    // 6. onSubmit workflow(s) — SERVER-SIDE, the sanctioned side-effect
    //    channel. Ids come from the PUBLISHED DEFINITION, never the request
    //    body. X3.4: `onSubmit.workflows` (1–3 entries) beside the legacy
    //    singular — the shared notify workflow rides as one entry (its
    //    notify_to/labels/title_field in that entry's initData) and a
    //    form-specific workflow beside it. Every entry gets the same
    //    assembly, mirroring the internal client (yc-forms.js save()
    //    step 5): field values as base, that ENTRY's initData overrides,
    //    system fields always win. Each dispatch is independently
    //    fire-and-forget via the existing wf→wf creation path
    //    (lib/internal_functions start_workflow: active check, contact
    //    resolution, capture, detached advance) — one workflow failing
    //    never fails the submission (already recorded) nor its siblings.
    const wfList = Array.isArray(def.onSubmit && def.onSubmit.workflows)
      ? def.onSubmit.workflows
      : (def.onSubmit && def.onSubmit.workflow ? [def.onSubmit.workflow] : []);
    for (const wf of wfList) {
      if (!(wf && Number.isInteger(Number(wf.id)) && Number(wf.id) > 0)) continue;
      const initData = Object.assign(
        {},
        body.values,
        wf.initData || {},
        {
          form_key: tpl.form_key,
          // The template's human title, so a SHARED workflow can name the
          // form it is reporting on (wf40's subject line) without per-form
          // initData. Always present; a workflow started any other way sees
          // no form_title and falls back to the key.
          form_title: tpl.title,
          link_type: linkType,
          link_id: linkId,
          submission_id: submitResult.id,
          // X5.1: the per-form "archive as PDF" flag, from the PUBLISHED
          // definition (never the request body). Always present, true or
          // false, so wf40's gate reads a defined variable. The render runs
          // INSIDE the workflow, not here: dispatch is fire-and-forget, so a
          // multi-second chromium render never sits in the submitter's
          // request, and a PDF failure can't cost the office its notification
          // (error_policy 'ignore' on that step).
          make_pdf: !!(def.onSubmit && def.onSubmit.pdf),
          // X3.2: the validated values as ONE object, so a SHARED notify
          // workflow can format any form without a per-form input map —
          // custom_code sees only its explicit `input`, and the engine's
          // _variables injection is internal_function-only. The single-
          // placeholder fast path ({{_values}}) delivers this object intact.
          // Assigned last in the system block: it wins over any submitted
          // field or initData key that happened to share the name.
          _values: body.values,
        }
      );
      const internalFunctions = require('../lib/internal_functions');
      Promise.resolve(
        internalFunctions.start_workflow(
          {
            workflow_id: Number(wf.id),
            init_data: initData,
            // X2.1 (§9 co-review F7): bind the execution to the REAL Primary
            // contact the server resolved, or to nothing when anonymous.
            // start_workflow's precedence is override > init_data[workflow's
            // default_contact_id_from] > NULL, so passing it here also closes
            // the latent hole where a public submitter controlled the value
            // of a declared field whose NAME happened to equal that
            // workflow's default_contact_id_from — they would have chosen the
            // execution's contact_id, and every SMS/email/log step would have
            // acted against a contact of their choosing. Latent only (all 29
            // workflows currently have default_contact_id_from NULL), but
            // field names and that column are edited by different people at
            // different times with nothing cross-checking them, and X3 wires
            // the first externally reachable workflow. This is the correct
            // binding, not a patch: the server knows whose case this is.
            ...(resolved.contactId ? { contact_id_override: resolved.contactId } : {}),
          },
          req.db
        )
      ).catch((err) => {
        console.error(
          `[api.ext.forms] onSubmit workflow ${wf.id} failed for ${tpl.form_key}:`,
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

// ─────────────────────────────────────────────────────────────────────────────
// DRAFT ROUTES (D1) — server-side drafts for case-linked external forms
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THESE EXIST: external drafts have been localStorage-only
// (EXTERNAL_FORMS_DESIGN §5.3 item 8), which means a client who starts a form
// on their phone cannot finish it on a laptop. That is survivable for a
// one-screen intake and disqualifying for the ~300-field Detailed Bankruptcy
// Questionnaire, which nobody completes in one sitting on one device.
//
// WHAT IT COSTS, STATED PLAINLY: draft READBACK widens what a guessed case_id
// exposes — from the hard 3-field prefill projection (§5.2.3) to whatever the
// client has typed into this form. The governing analysis is unchanged: the
// credential is still 40 bits (lib/caseId.js; the entropy note in
// extFormService.js), CORS is still revoked on /api/ext (the F1 comment at the
// top of this file), and both a per-IP and a per-case limiter still stand. The
// PRIZE grows; the guessability does not. That is the same trade the firm
// already accepts on the incumbent JotForm save-and-continue bearer links and
// on today's prefilled link, and it is the same trust model: whoever holds the
// link is treated as the client. Fred signed off 2026-09-04 (arc scratch
// `fred/yf_dbkq_arc`). If the credential is ever widened or the CORS grant
// restored, redo that arithmetic BEFORE touching these routes.
//
// LINKED-ONLY, deliberately: an anonymous server draft has no identity to key
// on, so degrade mode does not extend here. badLink degrade governs whether an
// anonymous visitor can RENDER and SUBMIT the form; it says nothing about
// persisting their answers server-side, and there is no correct row to write.
// Anonymous clients keep the sessionStorage path (yc-forms _draftStore).
//
// NO-ORACLE PARITY (§5.4): every refusal on both handlers — unknown key,
// unpublished, wrong visibility, serverDrafts off, unresolvable case_id —
// returns the byte-identical generic 404. There is deliberately NO badLink
// flag here: unlike the render path, a draft request has no UI branch that
// needs to tell "bad link" from "no such form", so the tighter answer is free.

/**
 * Shared template gate for both draft handlers: form_key shape, the same
 * published/visibility gate GET and submit use, and the serverDrafts opt-in.
 * Returns the template, or null meaning THE generic 404 — one null for all
 * three, so the caller cannot accidentally distinguish them in the response.
 * Linkage is resolved by each handler (POST reads the body, DELETE the query).
 */
async function draftGate(req) {
  if (!FORM_KEY_RE.test(req.params.form_key)) return null;

  const tpl = await extSvc.getServableTemplate(req.db, req.params.form_key);
  if (!tpl) return null;

  // Opt-in. Templates that never set the flag (intake included) behave
  // exactly as they did before D1: these routes do not exist for them.
  if (!extSvc.serverDraftsEnabled(tpl.definition)) return null;

  return tpl;
}

// ── POST /api/ext/forms/:form_key/draft ─────────────────────────────────────

router.post('/api/ext/forms/:form_key/draft', async (req, res) => {
  try {
    if (draftLimited(getClientIp(req))) return tooMany(res);

    const tpl = await draftGate(req);
    if (!tpl) return res.status(404).json(notFoundBody);
    const def = tpl.definition;

    // Body: { case_id, values } and NOTHING else — the §2 inversion rule, the
    // same rejection submit applies. Checked AFTER the serverDrafts gate on
    // purpose: a 400 here would otherwise confirm that a public form exists
    // under this key even when it never opted into drafts, and no-oracle
    // parity is cheaper to keep than to argue about.
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body : {};
    for (const k of Object.keys(body)) {
      if (k !== 'case_id' && k !== 'values') {
        return res.status(400).json({ status: 'error', message: `unexpected body key "${k}"` });
      }
    }

    // Linkage: the credential IS the draft identity. Invalid or absent
    // case_id → the generic 404, regardless of badLink mode.
    const caseId = typeof body.case_id === 'string' ? body.case_id : '';
    const resolved = await extSvc.resolveCase(req.db, caseId);
    if (!resolved.valid) return res.status(404).json(notFoundBody);

    // Shape check only — NOT validateValues. A draft is partial by nature;
    // see checkDraftShape in extFormService.js.
    try {
      extSvc.checkDraftShape(def, body.values);
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ status: 'error', message: err.message });
      }
      throw err;
    }

    // Per-case cap, consumed only by a well-formed draft — the F5 ordering
    // lesson from the submit path above, which applies with more force here:
    // an autosave loop that spent a token per malformed attempt would lock a
    // client out of their own draft over a transient client bug.
    if (perCaseDraftLimited(caseId)) return tooMany(res);

    // submitted_by NULL = external, the same convention submit writes.
    const out = await formService.upsertDraft(
      req.db, tpl.form_key, 'case', caseId, tpl.schema_version, body.values, null
    );

    // updated_at and nothing more — the client needs it to compare against a
    // local draft. Row ids stay off this surface (the submit-body precedent).
    return res.json({ status: 'success', updated_at: out.updated_at });
  } catch (err) {
    console.error('[api.ext.forms] draft save error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ── DELETE /api/ext/forms/:form_key/draft?case_id= ──────────────────────────

router.delete('/api/ext/forms/:form_key/draft', async (req, res) => {
  try {
    // Shares the draft POST's per-IP budget. No per-case cap: a DELETE writes
    // no row, so capping it would add a lockout surface and buy nothing.
    if (draftLimited(getClientIp(req))) return tooMany(res);

    const tpl = await draftGate(req);
    if (!tpl) return res.status(404).json(notFoundBody);

    const caseId = typeof req.query.case_id === 'string' ? req.query.case_id : '';
    const resolved = await extSvc.resolveCase(req.db, caseId);
    if (!resolved.valid) return res.status(404).json(notFoundBody);

    await formService.deleteDraft(req.db, tpl.form_key, 'case', caseId);

    // Success whether or not a row existed: "there was something to delete"
    // is exactly the kind of per-case existence signal this surface withholds,
    // and the client has nothing useful to do with the distinction anyway.
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('[api.ext.forms] draft delete error:', err);
    return res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

module.exports = router;