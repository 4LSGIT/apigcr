// services/formSubmitService.js
//
/**
 * formSubmitService.js — submit a stored form DRAFT in one server-side request.
 * Backs POST /api/forms/submissions/submit-draft (routes/api.forms.js).
 *
 * WHY: the form page's Submit button is a seven-call browser chain
 * (public/js/yc-forms.js save(): validate → getDiff → PATCH the record →
 * POST /api/forms/submit → DELETE /api/forms/draft → POST /workflows/:id/start
 * per onSubmit workflow → POST /api/log). POST /api/forms/submit alone only
 * records the row. A caller with no browser (Ask Casey, any API client) had no
 * way to run the rest. This is that chain, in the page's order, through the
 * writers the page's calls reach — never a second implementation of them:
 *
 *   1. The draft row (formService.getSubmission). Missing / not a draft → 404.
 *      No per-draft read rule: the draft routes have none (any signed-in staff
 *      member reads and writes any draft). `expected_updated_at`, when given,
 *      must equal the row's updated_at (409 otherwise) — the freshness a
 *      reviewed card carries (A12 reads updated_at from GET /api/forms/latest),
 *      compared by epoch ms. updated_at is DATETIME(3) and the draft writes
 *      stamp NOW(3) (since 2026-11-11), so two saves inside one second are told
 *      apart; only two in the same millisecond would not be.
 *   2. The PUBLISHED template (formTemplateService.getPublishedByKey — the read
 *      render.html boots from). None → 404; another link type than the draft's
 *      → 409; a draft saved under another schema_version → 409 naming both. The
 *      page TOLERATES an old-version draft (a banner warns, Restore re-renders
 *      it on the published fields in front of a person, who sees what fell
 *      away before saving). No person sees that here, so the server refuses
 *      instead of submitting a re-shaped payload unseen: re-save the draft on
 *      the current version (the A12 draft card stamps it) and submit that.
 *   3. extFormService.validateValues — the external submit route's validator,
 *      against the published definition. It stops at the FIRST failure (as it
 *      does for the external route); the 400 names that field by key and label.
 *   4. The onSubmit.patch step: the apiColumn diff the page would PATCH,
 *      computed as the page computes it (below), applied through the writer the
 *      PATCH route calls — PATCH /api/cases/:id = caseService.docketWriteRefusal
 *      then caseService.updateCase (source 'manual'); PATCH /api/contacts/:id =
 *      contactService.updateContact (no force, the caller's consent actor). An
 *      empty diff skips the patch. A refusal there stops the chain before
 *      anything is submitted (the page stops there too).
 *   5. formService.submitForm — the submitted row and `form.submitted`, with
 *      the draft's data AS STORED (the external route's rule: the server records
 *      the values it validated), under the published schema_version.
 *   6. formService.deleteDraft — the DELETE route's own call (unconditional on
 *      the key, as there: a draft autosaved between step 1 and here is deleted
 *      with it, the same window the page's own DELETE has).
 *   7. Each onSubmit workflow (≤3) through lib/internal_functions start_workflow
 *      — the server-side start the external route uses; no contact override,
 *      as the page's flat-body POST /workflows/:id/start has none
 *      (default_contact_id_from still applies). initData is the page's rule:
 *      the values, then that entry's initData, then the system fields
 *      (form_key, form_title, link_type, link_id, submission_id, make_pdf,
 *      _values) — system fields win. Each start is independent: a failure is
 *      reported, never undoes the submission or a sibling (as the page).
 *   8. The page's POST /api/log entry — logService.createLogEntry, type 'form',
 *      by the caller, data {form_key, action:'form_submit', version, changes}
 *      where changes is the page's getDiff over every field, JSON-encoded.
 *
 * NO CHANGES STILL SUBMITS. The page refuses to save an unchanged form ("No
 * changes to save" — its getDiff is empty). Here the stored draft IS the
 * change being submitted, so an empty diff skips only the patch; the row is
 * still recorded, the draft deleted, the workflows started and the log written.
 *
 * NOT ATOMIC, like the page. No writer here runs in a transaction (updateCase,
 * submitForm, deleteDraft and createLogEntry take the pool; domain events must
 * never ride a transaction connection — lib/domainEvents). A failure after the
 * patch is a 500 that names the columns already written. Steps 6–8 never fail
 * the request: each outcome is reported in the answer.
 *
 * IDEMPOTENCY: none added. A second call for the same draft is a 404 — the
 * draft is gone.
 *
 * ── THE PAGE'S DIFF, SERVER-SIDE ─────────────────────────────────────────────
 * The page's patch is render.html's _buildPatchPayload override: every field
 * in getDiff (collect() vs the baseline) that has a save-direction apiColumn
 * and is not readonly, sent under that column, a blank date as null. After
 * Restore the form holds the draft and the baseline is the form as loaded:
 *   - live mode (the default): endpoints.load's record — the GET it names, read
 *     here through the service that GET calls (caseService.getCase /
 *     contactService.getContact) and JSON round-tripped exactly as the browser
 *     receives it — mapped onto field names the _mergeApiData way;
 *   - snapshot mode: the latest SUBMITTED row's data when one exists, else the
 *     record as above;
 *   - no endpoints.load: an empty baseline (every non-empty answer is a change).
 * Both sides pass through `pageValue` — what populate() then collect() turn a
 * value into for that control (date / datetime-local shapes, masks formatted
 * then stripped, a value outside a static select's or radio's options reads
 * '', numbers the input type rejects read '', line breaks the control drops).
 * Known differences, all on the side of the record: prefill / derive values
 * the page writes at load (resolver calls, onLoad hooks) are not reproduced —
 * a value the draft holds that the record lacks is patched; an optionsFrom
 * select keeps its value (its list is built in the browser); a checkbox is its
 * value's plain truthiness ("0", "false" read unchecked — the page's populate
 * reads any non-empty string as checked, a page bug reported 2026-11-11).
 * Load or patch targets other than /api/cases/{linkId} and
 * /api/contacts/{linkId} are refused (422) before any write: the server cannot
 * reproduce what the page would send there.
 */

'use strict';

const formService = require('./formService');
const extFormService = require('./extFormService');
const formTemplateService = require('./formTemplateService');

function httpError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) err.extra = extra;
  return err;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const BODY_KEYS = new Set(['submission_id', 'expected_updated_at']);

// ─────────────────────────────────────────────────────────────────────────────
// pageValue — populate() then collect(), for one top-level field
// ─────────────────────────────────────────────────────────────────────────────

// The HTML "valid floating-point number" an <input type="number"> keeps;
// anything else its value sanitization turns into ''.
const HTML_NUMBER_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function optionValueList(f) {
  return (f.options || []).map((o) =>
    o && typeof o === 'object' ? String(o.value != null ? o.value : '') : String(o));
}

// yc-forms _formatMask (display), then _stripMaskByType (collect).
function maskRoundTrip(v, mask) {
  if (!v) return '';
  const digits = v.replace(/\D/g, '');
  let shown = v;
  switch (mask) {
    case 'phone': if (digits.length === 10) shown = digits.replace(/^(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3'); break;
    case 'ssn':   if (digits.length === 9)  shown = digits.replace(/^(\d{3})(\d{2})(\d{4})$/, '$1-$2-$3'); break;
    case 'zip':
      if (digits.length === 5) shown = digits;
      else if (digits.length === 9) shown = digits.replace(/^(\d{5})(\d{4})$/, '$1-$2');
      break;
    case 'ein':   if (digits.length === 9)  shown = digits.replace(/^(\d{2})(\d{7})$/, '$1-$2'); break;
    case 'currency': {
      const num = parseFloat(v.replace(/[^\d.-]/g, ''));
      if (!isNaN(num)) shown = '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      break;
    }
    default: break;
  }
  if (!shown) return shown;
  switch (mask) {
    case 'phone': case 'ssn': case 'zip': case 'ein': return shown.replace(/\D/g, '');
    case 'currency': return shown.replace(/[^\d.-]/g, '');
    default: return shown;
  }
}

function truthy(v) {
  if (v === true) return true;
  if (v == null || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'off' && s !== 'no';
}

/**
 * What the form holds for field `f` after populate() wrote `raw` into it and
 * collect() read it back (render.html's controls; yc-forms' _formatForDisplay,
 * _setTags/_getTags, _setCheckgroup/_getCheckgroup, mask round trip).
 */
function pageValue(f, raw) {
  const type = f.type;
  if (type === 'checkbox') return truthy(raw);
  if (raw === undefined || raw === null) return '';
  const v = String(raw);
  switch (type) {
    case 'date': {
      const d = v.split('T')[0];
      return (DATE_RE.test(d) && !isNaN(new Date(d))) ? d : '';
    }
    case 'datetime': {
      const local = v.replace('Z', '').split('.')[0].slice(0, 16);
      return DATETIME_LOCAL_RE.test(local) ? local : '';
    }
    case 'number':
      return HTML_NUMBER_RE.test(v) ? v : '';
    case 'select':
      if (f.optionsFrom) return v;
      return ['', ...optionValueList(f)].includes(v) ? v : '';
    case 'radio':
      return optionValueList(f).includes(v) ? v : '';
    case 'tags':
      return v.split(',').map((t) => t.trim()).filter(Boolean).join(',');
    case 'checkgroup': {
      const parts = v.split(',').map((p) => p.trim()).filter(Boolean);
      const opts = optionValueList(f);
      const out = opts.filter((o) => parts.includes(o));
      const others = parts.filter((p) => !opts.includes(p));
      if (f.allowOther && others.length) out.push(others.join(', '));
      return out.join(',');
    }
    case 'textarea':
      return v.replace(/\r\n?/g, '\n');
    default: {
      // text / hidden (both a type="text" input): value sanitization drops
      // line breaks; a mask is formatted on populate and stripped on collect.
      const s = v.replace(/[\r\n]/g, '');
      return f.mask ? maskRoundTrip(s, f.mask) : s;
    }
  }
}

// A repeater row as collect() reads it back: its declared fields only.
function repeaterValue(reg, raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const out = {};
    for (const name of Object.keys(reg)) {
      out[name] = pageValue(reg[name], isPlainObject(item) ? item[name] : undefined);
    }
    return out;
  });
}

// render.html registerField: apiColumn string = both directions; {load, save}
// maps each independently.
function apiColumns(f) {
  const ac = f.apiColumn;
  if (typeof ac === 'string' && ac) return { load: ac, save: ac };
  if (isPlainObject(ac)) {
    return {
      load: typeof ac.load === 'string' && ac.load ? ac.load : null,
      save: typeof ac.save === 'string' && ac.save ? ac.save : null,
    };
  }
  return { load: null, save: null };
}

/**
 * The page's getDiff (collect() vs the baseline) and render.html's
 * _buildPatchPayload over it.
 *
 * @param {object} def    published definition
 * @param {object} base   the baseline values by FIELD name (see resolveBase)
 * @param {object} data   the draft's stored values
 * @returns {{ diff: object, payload: object }}
 */
function computeDiffAndPatch(def, base, data) {
  const { fields, repeaters } = extFormService.buildValueRegistry(def);
  const diff = {};
  const payload = {};
  for (const name of Object.keys(fields)) {
    const f = fields[name];
    const oldVal = pageValue(f, base[name]);
    const newVal = pageValue(f, has(data, name) ? data[name] : undefined);
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;
    diff[name] = [oldVal, newVal];
    const col = apiColumns(f).save;
    if (!col || f.readonly) continue;
    const blankDate = (f.type === 'date' || f.type === 'datetime') && newVal === '';
    payload[col] = blankDate ? null : newVal;
  }
  for (const key of Object.keys(repeaters)) {
    const oldVal = repeaterValue(repeaters[key], base[key]);
    const newVal = repeaterValue(repeaters[key], has(data, key) ? data[key] : undefined);
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) diff[key] = [oldVal, newVal];
  }
  return { diff, payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// Targets — the two record URLs the server can stand in for
// ─────────────────────────────────────────────────────────────────────────────

const RECORD_URL_RE = /^\/api\/(cases|contacts)\/([^/?#]+)(\?[^#]*)?$/;
const ENTITY_OF = { cases: 'case', contacts: 'contact' };

// yc-forms _api's placeholder substitution.
function fillUrl(url, ctx) {
  return String(url)
    .replace(/\{linkId\}/g, ctx.linkId)
    .replace(/\{linkType\}/g, ctx.linkType)
    .replace(/\{formKey\}/g, ctx.formKey);
}

function parseRecordUrl(url, ctx) {
  if (typeof url !== 'string' || !url) return null;
  const m = RECORD_URL_RE.exec(fillUrl(url, ctx));
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[2]); } catch (_) { return null; }
  return { entity: ENTITY_OF[m[1]], id, query: new URLSearchParams((m[3] || '').slice(1)) };
}

function resolvePatchTarget(patch, ctx) {
  const method = String(patch.method || 'PATCH').toUpperCase();
  const t = method === 'PATCH' ? parseRecordUrl(patch.url, ctx) : null;
  if (!t || [...t.query.keys()].length) {
    throw httpError(422,
      `This form's onSubmit.patch (${method} ${patch.url}) is not one the server can apply — ` +
      'only PATCH /api/cases/{linkId} and PATCH /api/contacts/{linkId} are supported');
  }
  return { entity: t.entity, id: t.id };
}

// GET <endpoints.load.url> through the service its route calls, JSON
// round-tripped (Dates become the ISO strings the browser receives). A record
// the GET would 404 on is null — the page's load fails soft the same way.
async function loadRecord(db, load, ctx) {
  const method = String(load.method || 'GET').toUpperCase();
  const t = method === 'GET' ? parseRecordUrl(load.url, ctx) : null;
  if (!t) {
    throw httpError(422,
      `This form's endpoints.load (${method} ${load.url}) is not one the server can read — ` +
      'only GET /api/cases/{linkId} and GET /api/contacts/{linkId} are supported');
  }
  const include = t.query.get('include') || '';
  const logLimit = t.query.get('log_limit') ? parseInt(t.query.get('log_limit'), 10) : undefined;
  const result = t.entity === 'case'
    ? await require('./caseService').getCase(db, t.id, include, { logLimit })
    : await require('./contactService').getContact(db, t.id, include, { logLimit });
  return result ? JSON.parse(JSON.stringify(result)) : null;
}

function parseData(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return raw;
}

/**
 * The page's baseline by field name (yc-forms init steps 7–10:
 * _liveData → _mergeApiData → _resolveDataSource).
 */
async function resolveBase(db, def, ctx) {
  let live = null;
  if (def.endpoints && def.endpoints.load) {
    const loadResult = await loadRecord(db, def.endpoints.load, ctx);
    if (loadResult) {
      const p = def.endpoints.load.path;
      live = (p && loadResult[p]) ? loadResult[p] : (loadResult.data || loadResult);
    }
  }
  let mapped = null;
  if (isPlainObject(live)) {
    const { fields } = extFormService.buildValueRegistry(def);
    const apiMap = {};
    for (const name of Object.keys(fields)) {
      const load = apiColumns(fields[name]).load;
      if (load) apiMap[load] = name;
    }
    mapped = {};
    for (const [key, value] of Object.entries(live)) mapped[apiMap[key] || key] = value;
  }
  if (def.dataMode === 'snapshot') {
    const latest = await formService.getLatest(db, ctx.formKey, ctx.linkType, ctx.linkId);
    const submitted = latest && latest.submitted ? parseData(latest.submitted.data) : null;
    return (isPlainObject(submitted) && submitted) || mapped || {};
  }
  return mapped || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer error mapping — the PATCH routes' own ladders
// ─────────────────────────────────────────────────────────────────────────────

function caseWriteError(err) {
  const m = err.message || '';
  const status = err.status ? err.status
    : m.includes('cannot update') ? 400 : m.includes('not found') ? 404 : 500;
  return httpError(status, m);
}

function contactWriteError(err) {
  if (err.errors) return httpError(400, err.message, { errors: err.errors });
  if (err.conflicts) return httpError(409, err.message, { conflicts: err.conflicts });
  const m = err.message || '';
  const status =
    err.status                                               ? err.status
    : m.includes('blocked')                                  ? 400
    : m.includes('must be an array')                         ? 400
    : m.includes('not found')                                ? 404
    : (m.includes('concurrent') || m.includes('Concurrent')) ? 400
    : 500;
  return httpError(status, m,
    err.name === 'ConsentWriteRefusal' ? { code: err.code, consent: err.consent } : null);
}

async function applyPatch(db, target, payload, { userId, auth }) {
  if (target.entity === 'case') {
    const caseService = require('./caseService');
    const refusal = await caseService.docketWriteRefusal(db, target.id, payload);
    if (refusal) {
      throw httpError(refusal.status, refusal.message, refusal.conflict ? { conflict: refusal.conflict } : null);
    }
    try {
      return await caseService.updateCase(db, target.id, payload, { userId, source: 'manual' });
    } catch (err) { throw caseWriteError(err); }
  }
  const contactService = require('./contactService');
  const optoutService = require('./optoutService');
  try {
    return await contactService.updateContact(db, target.id, payload, {
      userId: userId || 0, force: false, consentActor: optoutService.consentActor(auth),
    });
  } catch (err) { throw contactWriteError(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// submitDraft
// ─────────────────────────────────────────────────────────────────────────────

function wfListOf(onSubmit) {
  if (Array.isArray(onSubmit.workflows)) return onSubmit.workflows;
  return onSubmit.workflow ? [onSubmit.workflow] : [];
}

/**
 * @param {object} db     pool
 * @param {object} body   { submission_id, expected_updated_at? }
 * @param {object} opts   { auth } — the request's req.auth (a staff JWT)
 * @returns the route's answer body (without `status`)
 */
async function submitDraft(db, body, { auth } = {}) {
  const b = isPlainObject(body) ? body : {};
  for (const k of Object.keys(b)) {
    if (!BODY_KEYS.has(k)) throw httpError(400, `unexpected body key "${k}"`);
  }
  const id = Number(b.submission_id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'submission_id must be a positive integer');
  let expectedMs = null;
  if (b.expected_updated_at != null && b.expected_updated_at !== '') {
    expectedMs = new Date(b.expected_updated_at).getTime();
    if (Number.isNaN(expectedMs)) throw httpError(400, 'expected_updated_at is not a date');
  }
  const uid = parseInt(auth && auth.userId, 10);
  const userId = Number.isFinite(uid) && uid > 0 ? uid : null;

  // 1. The draft.
  let draft;
  try {
    draft = await formService.getSubmission(db, id);
  } catch (err) {
    if (err.status === 404) throw httpError(404, `Draft ${id} not found`);
    throw err;
  }
  if (draft.status !== 'draft') {
    throw httpError(404, `Submission ${id} is not a draft (it is ${draft.status})`);
  }
  const savedMs = new Date(draft.updated_at).getTime();
  if (expectedMs != null && savedMs !== expectedMs) {
    throw httpError(409, `Draft ${id} was saved again since it was read — re-read it before submitting`,
      { updated_at: draft.updated_at });
  }
  const ctx = { formKey: draft.form_key, linkType: draft.link_type, linkId: draft.link_id };

  // 2. The published template.
  const tpl = await formTemplateService.getPublishedByKey(db, draft.form_key);
  if (!tpl || !isPlainObject(tpl.definition)) {
    throw httpError(404, `No published template for form_key "${draft.form_key}"`);
  }
  if (tpl.link_type !== draft.link_type) {
    throw httpError(409, `Form "${draft.form_key}" is a ${tpl.link_type}-linked form — draft ${id} is linked to a ${draft.link_type || 'nothing'}`);
  }
  if (Number(tpl.schema_version) !== Number(draft.schema_version)) {
    throw httpError(409,
      `Draft ${id} was saved on version ${draft.schema_version} of this form; the published form is version ${tpl.schema_version} — re-save the draft on the current version first`,
      { draft_schema_version: draft.schema_version, schema_version: tpl.schema_version });
  }
  const def = tpl.definition;
  const onSubmit = isPlainObject(def.onSubmit) ? def.onSubmit : {};

  const data = parseData(draft.data);
  if (!isPlainObject(data)) throw httpError(422, `Draft ${id} does not hold a JSON object`);

  // 3. Validation — the external route's validator.
  try {
    extFormService.validateValues(def, data);
  } catch (err) {
    if (err.status !== 400) throw err;
    const m = /^values\.([A-Za-z0-9_]+)/.exec(err.message || '');
    const key = m ? m[1] : null;
    const f = key ? extFormService.buildValueRegistry(def).fields[key] : null;
    throw httpError(400, err.message, {
      fields: key ? [{ key, label: f && f.label ? String(f.label) : key, message: err.message }] : [],
    });
  }

  // 4. The patch, as the page computes it.
  const target = isPlainObject(onSubmit.patch) ? resolvePatchTarget(onSubmit.patch, ctx) : null;
  const base = await resolveBase(db, def, ctx);
  const { diff, payload } = computeDiffAndPatch(def, base, data);
  let patched = [];
  let changes = {};
  if (target && Object.keys(payload).length) {
    const result = await applyPatch(db, target, payload, { userId, auth });
    patched = Object.keys(payload);
    changes = (result && result.changes) || {};
  }

  // 5. The submitted row.
  let submission;
  try {
    submission = await formService.submitForm(
      db, draft.form_key, draft.link_type, draft.link_id, tpl.schema_version, data, userId);
  } catch (err) {
    console.error('[formSubmitService] submitForm failed:', err);
    throw httpError(500,
      patched.length
        ? `The record was updated (${patched.join(', ')}) but the submission was not recorded: ${err.message}`
        : `The submission was not recorded: ${err.message}`,
      { patched, changes, patch_target: target && patched.length ? { type: target.entity, id: target.id } : null });
  }

  // 6. The draft.
  let draftDeleted = false;
  let draftDeleteError;
  try {
    draftDeleted = (await formService.deleteDraft(db, draft.form_key, draft.link_type, draft.link_id)).deleted;
  } catch (err) {
    draftDeleteError = err.message;
    console.warn('[formSubmitService] draft cleanup failed:', err.message);
  }

  // 7. The onSubmit workflows.
  const workflows = [];
  const list = wfListOf(onSubmit);
  if (list.length) {
    const internalFunctions = require('../lib/internal_functions'); // lazy require (convention)
    for (const wf of list) {
      const wfId = wf && wf.id;
      const initData = Object.assign(
        {},
        data,
        (wf && wf.initData) || {},
        {
          form_key:      draft.form_key,
          form_title:    tpl.title || '',
          link_type:     draft.link_type,
          link_id:       draft.link_id,
          submission_id: submission.id,
          make_pdf:      !!onSubmit.pdf,
          _values:       data,
        }
      );
      try {
        const r = await internalFunctions.start_workflow({ workflow_id: wfId, init_data: initData }, db);
        workflows.push({ id: wfId, started: true,
          execution_id: (r && r.output && r.output.workflow_execution_id) || null });
      } catch (err) {
        console.warn(`[formSubmitService] onSubmit workflow ${wfId} failed:`, err.message);
        workflows.push({ id: wfId, started: false, error: err.message });
      }
    }
  }

  // 8. The page's audit entry.
  let logId = null;
  let logError;
  try {
    const logService = require('./logService');
    const r = await logService.createLogEntry(db, {
      type: 'form',
      link_type: draft.link_type,
      link_id: draft.link_id,
      by: userId || 0,
      data: JSON.stringify({
        form_key: draft.form_key,
        action: 'form_submit',
        version: submission.version,
        changes: JSON.stringify(diff),
      }),
    });
    logId = r.log_id;
  } catch (err) {
    logError = err.message;
    console.warn('[formSubmitService] audit log failed:', err.message);
  }

  return {
    submission: { id: submission.id, version: submission.version, updated_at: submission.updated_at },
    form_key: draft.form_key,
    link_type: draft.link_type,
    link_id: draft.link_id,
    patch_target: target && patched.length ? { type: target.entity, id: target.id } : null,
    patched,
    changes,
    draft_deleted: draftDeleted,
    ...(draftDeleteError ? { draft_delete_error: draftDeleteError } : {}),
    workflows,
    log_id: logId,
    ...(logError ? { log_error: logError } : {}),
  };
}

module.exports = {
  submitDraft,
  // A12.3 — Ask Casey's form.submit.v1 card discloses the SAME diff, patch
  // target and workflow list this route applies (computeDiffAndPatch,
  // resolveBase, resolvePatchTarget, wfListOf) — never a second copy:
  computeDiffAndPatch,
  resolveBase,
  resolvePatchTarget,
  wfListOf,
  // exported for tests:
  pageValue,
};
