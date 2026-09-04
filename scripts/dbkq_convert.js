#!/usr/bin/env node
/**
 * scripts/dbkq_convert.js — Detailed Bankruptcy Questionnaire (JotForm
 * 231694062254152) → a YisraForm definition. Arc: DBKQ → YisraForm, slice D2-A.
 *
 * DEV-TIME TOOL. Requires `jsdom`, which is a devDependency — this script does
 * NOT run in the production container (`npm install --omit=dev`). It is run by
 * hand, and by scripts/dbkq_verify.js.
 *
 *   node scripts/dbkq_convert.js            # writes ref/2026-09-04_dbkq_definition.v1.json
 *   node scripts/dbkq_verify.js             # converts + checks + writes the coverage report
 *
 * INPUT is the DATED FIXTURE ref/dbkq_source_2026-09-04.html, never the live
 * URL: the conversion must be reproducible, and a form that changes under us
 * mid-review is not a ground truth. Re-fetch deliberately, under a new date,
 * when the source is meant to move.
 *
 * DETERMINISM is a hard requirement: same fixture in ⇒ byte-identical JSON out.
 * Session B's manual edits are reviewed as a diff against this base, and a
 * base that reshuffles keys makes that diff unreadable. Two mechanisms:
 *   1. every emitted object is built through the ordered constructors below
 *      (`orderedField`, `orderedSection`), never by ad-hoc literal;
 *   2. `stableStringify` re-emits keys in the declared canonical order, so
 *      determinism is enforced rather than merely likely.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * VISIBILITY MODEL (Fred-ratified 2026-09-04; replaces D2-A §5's letter)
 *
 *   A JotForm field targeted by ≥1 Show rule is HIDDEN until a Show term
 *   matches. A field targeted only by Hide rules is VISIBLE until a Hide term
 *   matches. Net:  visible = OR(show terms) AND NOT OR(hide terms).
 *
 * The 66 condition actions in this form fan out onto 70 target qids, 27 of
 * which carry between 2 and 5 rules. That is not 27 ORs — it is mostly
 * JotForm's redundant Hide scaffolding around a single Show. `deriveTarget`
 * below reduces each target under the model, and every reduction is PROVEN
 * rather than assumed:
 *
 *   dedupe            identical (direction, source, op, value) rules collapse
 *   same-source hides subsumed by a Show on that source — ASSERTED disjoint
 *                     (a single-valued control cannot hold two values), and a
 *                     Show/Hide value overlap is a hard error, not a warning
 *   show fan-out      several equals on ONE source ⇒ `in`
 *   hide-only         multi-value hides on a single-valued source ⇒ the
 *                     COMPLEMENT of its own option set (eq / in)
 *   cross-source hide single value ⇒ `neq`
 *   multi-source show genuine OR ⇒ `showWhenAny` (contract §4.4.1)
 *
 * Anything the model cannot prove throws. Silence is the failure mode this
 * whole file exists to prevent: a wrong condition here is a question a debtor
 * is never asked, which is a wrong petition later.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const SOURCE_HTML = path.join(ROOT, 'ref', 'dbkq_source_2026-09-04.html');
const OUT_JSON    = path.join(ROOT, 'ref', '2026-09-04_dbkq_definition.v1.json');

// ─────────────────────────────────────────────────────────────────────────────
// LOCKED CONVERSION CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const NAME_MAX = 50;                       // contract §4.3 FIELD_NAME_RE

// qid 289 is a client-writable "Case ID" textbox. The external surface resolves
// the case from the bearer credential; a client-writable case field is exactly
// the inversion the external design forbids.
const DROP_CREDENTIAL = { '289': 'credential-replaces-it' };

// The source's own retired predecessors, carried as <li class="… always-hidden">.
// Dropped with lineage (Fred-ratified 2026-09-04): emitting them would add dead
// cards AND duplicate schema fields feeding the same petition facts. The map is
// old → the live question that superseded it, recovered by label/role match;
// null where the question was retired outright with no successor.
const HIDDEN_LINEAGE = {
  '191': null,  '192': null,  '217': null,  '100': null,  '101': null,
  '175': '277', '110': null,  '124': '218', '178': '229', '197': '229',
  '31':  null,  '49':  '295', '135': '282', '51':  '260', '65':  '262',
  '240': '242', '159': '243', '160': '244', '91':  '238', '105': null,
  '107': null,  '137': '47',  '181': '184',
};

// The one genuine cross-source OR in the source (qid 36). Named here so that a
// future re-run against a CHANGED form fails loudly if the OR set moves,
// instead of quietly emitting a different form.
const EXPECTED_OR_TARGETS = ['36'];

const DEFINITION_HEAD = {
  layout: 'card',
  // 10s debounce. Worst case one draft POST / 10s = 360/hr, which is exactly
  // the per-case cap (routes/api.ext.forms.js) as corrected in this slice.
  autosaveMs: 10000,
  external: {
    badLink: 'degrade',                    // mirrors the incumbent: wf48 accepts caseless
    serverDrafts: true,                    // D1 — the whole point of the arc
    postSubmit: { message: '<PLACEHOLDER — Fred finalizes in session B>' },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC SERIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

// Canonical key order per object shape. Keys absent from an object are simply
// skipped; keys present but unlisted throw (a new key must be placed on
// purpose, not appended wherever it happened to be assigned).
const KEY_ORDER = {
  definition: ['layout', 'autosaveMs', 'external', 'sections'],
  external:   ['badLink', 'serverDrafts', 'postSubmit'],
  postSubmit: ['message', 'edit', 'new', 'redirect', 'redirectBack'],
  section:    ['title', 'subtitle', 'note', 'showWhen', 'showWhenAny', 'rows'],
  row:        ['fields'],
  field:      ['name', 'type', 'label', 'sublabel', 'placeholder', 'mask',
               'email', 'options', 'allowOther', 'columns', 'note',
               'showWhen', 'showWhenAny'],
  condition:  ['field', 'op', 'value'],
  option:     ['value', 'label'],
};

function ordered(kind, obj) {
  const order = KEY_ORDER[kind];
  const out = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined && !order.includes(k)) {
      throw new Error(`ordered(${kind}): key "${k}" has no declared position — add it to KEY_ORDER deliberately`);
    }
  }
  return out;
}

/** JSON.stringify with the canonical key order re-applied top to bottom. */
function stableStringify(def) {
  const cond = (c) => ordered('condition', c);
  const conds = (c) => (Array.isArray(c) ? c.map(cond) : cond(c));
  const opt = (o) => (o && typeof o === 'object' ? ordered('option', o) : o);
  const field = (f) => {
    const o = ordered('field', f);
    if (o.options) o.options = o.options.map(opt);
    if (o.showWhen) o.showWhen = conds(o.showWhen);
    if (o.showWhenAny) o.showWhenAny = o.showWhenAny.map(cond);
    return o;
  };
  const section = (s) => {
    const o = ordered('section', s);
    if (o.showWhen) o.showWhen = conds(o.showWhen);
    if (o.showWhenAny) o.showWhenAny = o.showWhenAny.map(cond);
    o.rows = o.rows.map((r) => ({ fields: ordered('row', r).fields.map(field) }));
    return o;
  };
  const top = ordered('definition', def);
  top.external = ordered('external', top.external);
  if (top.external.postSubmit) top.external.postSubmit = ordered('postSubmit', top.external.postSubmit);
  top.sections = top.sections.map(section);
  return JSON.stringify(top, null, 2) + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// NAMING
// ─────────────────────────────────────────────────────────────────────────────

/** JotForm input name → the base field name. `q75_Electronics[]` → `q75_Electronics`. */
function baseName(rawName) {
  return String(rawName || '').replace(/\[.*$/, '').replace(/[^A-Za-z0-9_]/g, '_');
}

/** A sublabel / widget line / sub-input role → a snake_case name fragment. */
function subKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

/**
 * `<base>_<subkey>` inside NAME_MAX, without collisions.
 *
 * The BASE is never truncated — it is the JotForm identity and the only thing
 * that makes an emitted name traceable back to the source question. The subkey
 * absorbs the truncation, preferring a `_` boundary so the result still reads
 * as words, and a numeric suffix breaks any collision the truncation creates.
 */
function subName(base, key, taken) {
  const fallback = key || 'field';
  let budget = NAME_MAX - base.length - 1;
  if (budget < 2) throw new Error(`base name "${base}" leaves no room for a sub-field`);

  const fit = (k, reserve) => {
    const room = budget - reserve;
    if (k.length <= room) return k;
    let cut = k.slice(0, room);
    const boundary = cut.lastIndexOf('_');
    if (boundary >= Math.floor(room * 0.5)) cut = cut.slice(0, boundary);
    return cut.replace(/_+$/, '') || k.slice(0, room);
  };

  let candidate = `${base}_${fit(fallback, 0)}`;
  if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`;
    candidate = `${base}_${fit(fallback, suffix.length)}${suffix}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  throw new Error(`could not build a unique sub-name for ${base}/${key}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSE — the fixture is the ground truth; every fact below is READ, not assumed
// ─────────────────────────────────────────────────────────────────────────────

function loadDom(html) {
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    throw new Error('jsdom is required (devDependency). Run `npm install` — this script is a dev tool and never runs in the production container.');
  }
  return new JSDOM(html).window.document;
}

const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** The `JotForm.setConditions([...])` array, by balanced-bracket scan. */
function parseConditions(html) {
  const marker = 'JotForm.setConditions(';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('setConditions( not found in the fixture');
  let i = start + marker.length, depth = 0, inStr = false, esc = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return JSON.parse(html.slice(start + marker.length, i));
}

/** One `<li class="form-line">` → a normalized question record. */
function parseQuestion(li) {
  const qid  = li.id.replace(/^id_/, '');
  const type = li.getAttribute('data-type');
  const hidden = /\balways-hidden\b/.test(li.className);
  const label = textOf(li.querySelector('.jsQuestionLabelContainer, .jfQuestion-label'));
  const description = textOf(li.querySelector('.jfQuestion-description'));

  const firstNamed = li.querySelector('input[name],select[name],textarea[name]');
  const base = baseName(firstNamed && firstNamed.getAttribute('name'));

  const colGroup = li.querySelector('[data-columncount]');
  const rawCols  = colGroup ? parseInt(colGroup.getAttribute('data-columncount'), 10) : NaN;
  const columns  = (rawCols >= 1 && rawCols <= 3) ? rawCols : null;

  const q = { qid, type, hidden, label, description, base, columns };

  // Choice controls: option values verbatim from the input `value=` attributes,
  // in DOM order. The JotForm "other" control is excluded from the option list
  // and recorded as a flag — it is a free-text affordance, not a choice.
  const choiceSel = type === 'control_checkbox' ? 'input[type=checkbox]' : 'input[type=radio]';
  if (type === 'control_checkbox' || type === 'control_radio' || type === 'control_yesno') {
    const inputs = [...li.querySelectorAll(choiceSel)];
    q.hasOther = inputs.some((i) => i.id.startsWith('other_'));
    q.options = inputs
      .filter((i) => !i.id.startsWith('other_'))
      .map((i) => {
        const lab = i.closest('label');
        const span = lab && lab.querySelector('.jfRadio-labelText, .jfCheckbox-labelText, .jfYesno-label');
        return { value: i.getAttribute('value'), label: span ? textOf(span) : i.getAttribute('value') };
      });
  }

  if (type === 'control_dropdown') {
    q.options = [...li.querySelectorAll('select option')]
      .map((o) => ({ value: o.getAttribute('value'), label: textOf(o) }))
      .filter((o) => o.value !== '' && o.value !== null);
  }

  // Compound controls (mixed / address / fullname): one sub-input per
  // `.jfQuestion-fields > .jfField`, in DOM order, carrying its own data-type
  // and its own sublabel.
  if (type === 'control_mixed' || type === 'control_address' || type === 'control_fullname') {
    q.subs = [...li.querySelectorAll('.jfQuestion-fields > .jfField')].map((cell) => {
      const ctl = cell.querySelector('input,select,textarea');
      const sub = {
        role: cell.getAttribute('data-type'),
        name: ctl ? ctl.getAttribute('name') : null,
        sublabel: textOf(cell.querySelector('.jfField-sublabel')),
        tag: ctl ? ctl.tagName : null,
        placeholder: ctl ? ctl.getAttribute('placeholder') : null,
      };
      if (ctl && ctl.tagName === 'SELECT') {
        sub.options = [...ctl.querySelectorAll('option')]
          .map((o) => ({ value: o.getAttribute('value'), label: textOf(o) }))
          .filter((o) => o.value !== '' && o.value !== null);
      }
      return sub;
    }).filter((s) => s.name);
  }

  // Multiple Text Fields widget: the line list lives URL-encoded in the
  // widget_settings hidden input, newline-separated.
  if (type === 'control_widget') {
    const settings = li.querySelector('input.form-widget-settings');
    if (!settings) throw new Error(`qid ${qid}: control_widget with no widget_settings input`);
    const parsed = JSON.parse(decodeURIComponent(settings.getAttribute('value')));
    const entry = parsed.find((p) => p.name === 'fields');
    if (!entry) throw new Error(`qid ${qid}: widget_settings carries no "fields" entry`);
    q.lines = String(entry.value).split('\n').map((s) => s.trim()).filter(Boolean);
  }

  if (type === 'control_matrix') {
    q.rowsLabels = [...li.querySelectorAll('.form-matrix-row-headers label')]
      .map((l) => textOf(l));
    // The mobile/desktop duplicate pair carries the same names; de-dup by id.
    const seen = new Set();
    q.matrixInputs = [...li.querySelectorAll('input')]
      .filter((i) => !i.id.endsWith('_cancelled'))
      .filter((i) => { const n = i.getAttribute('name'); if (!n || seen.has(n)) return false; seen.add(n); return true; });
    q.rowsLabels = q.rowsLabels.slice(0, q.matrixInputs.length);
  }

  if (type === 'control_number' || type === 'control_textbox' || type === 'control_phone') {
    const ctl = li.querySelector('input[name]');
    q.placeholder = ctl ? ctl.getAttribute('placeholder') : null;
  }

  if (type === 'control_datetime') {
    // date vs datetime is READ from the sub-input set, never assumed: hour /
    // minute inputs are what make it a datetime.
    const names = [...li.querySelectorAll('input[name]')].map((i) => i.getAttribute('name') || '');
    q.hasTime = names.some((n) => /\[(hour|min|minute|second|ampm)\]/.test(n));
  }

  return q;
}

function parseSource(html) {
  const doc = loadDom(html);
  const questions = [...doc.querySelectorAll('li.form-line')].map(parseQuestion);
  if (!questions.length) throw new Error('no li.form-line elements — fixture is not a JotForm page');
  return { questions, conditions: parseConditions(html) };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION DERIVATION
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_VALUED = new Set(['control_yesno', 'control_radio', 'control_dropdown']);

/** target qid → the enabled rules aimed at it, in source order. */
function collectRules(conditions) {
  const rules = Object.create(null);
  const stats = { total: conditions.length, disabled: 0, actions: 0 };
  for (const c of conditions) {
    if (c.disabled) { stats.disabled++; continue; }
    const term = c.terms[0];
    if (c.terms.length !== 1) throw new Error(`condition ${c.id}: ${c.terms.length} terms — the single-term assumption is broken`);
    if (c.link !== 'Any') throw new Error(`condition ${c.id}: link "${c.link}" is not Any`);
    for (const a of c.action) {
      stats.actions++;
      const targets = a.fields ? a.fields.map(String) : [String(a.field)];
      const show = a.visibility === 'Show' || a.visibility === 'ShowMultiple';
      if (!show && a.visibility !== 'Hide' && a.visibility !== 'HideMultiple') {
        throw new Error(`condition ${c.id}: visibility "${a.visibility}" is not a field-visibility action`);
      }
      for (const t of targets) {
        (rules[t] = rules[t] || []).push({
          show,
          src: String(term.field),
          op: term.operator,
          val: String(term.value == null ? '' : term.value),
          cid: c.id,
        });
      }
    }
  }
  return { rules, stats };
}

/**
 * Reduce one target's rules to { and: [cond…], any: [cond…] } under the
 * visibility model. `proofs` accumulates the human-readable justification for
 * every reduction step — the coverage report prints them, which is the only
 * way a reviewer can check the derivation without redoing it.
 */
function deriveTarget(target, rules, qByQid) {
  const proofs = [];

  const seen = new Set();
  const rs = [];
  for (const r of rules) {
    const k = [r.show, r.src, r.op, r.val].join('\u0000');
    if (seen.has(k)) { proofs.push(`dedupe: duplicate ${r.show ? 'Show' : 'Hide'} ${r.src} ${r.op} "${r.val}" (cond ${r.cid})`); continue; }
    seen.add(k);
    rs.push(r);
  }

  const shows = rs.filter((r) => r.show);
  const hides = rs.filter((r) => !r.show);
  const and = [];
  let any = null;

  const opFor = (src, op) => {
    // A condition keyed on a checkbox group compares against the comma-joined
    // selection: `equals` is membership, i.e. the `includes` op (contract §4.4).
    if (op === 'isFilled') return 'notEmpty';
    return qByQid[src] && qByQid[src].type === 'control_checkbox' ? 'includes' : 'eq';
  };

  const showSrcs = [...new Set(shows.map((r) => r.src))];

  if (showSrcs.length > 1) {
    // Genuine cross-source OR — showWhenAny (contract §4.4.1).
    any = shows.map((r) => {
      const op = opFor(r.src, r.op);
      return op === 'notEmpty' ? { src: r.src, op } : { src: r.src, op, value: r.val };
    });
    proofs.push(`OR: Show terms span ${showSrcs.length} sources (${showSrcs.join(', ')}) — emitted as showWhenAny`);
  } else if (showSrcs.length === 1) {
    const src = showSrcs[0];
    const group = shows.filter((r) => r.src === src);
    const filled = group.filter((r) => r.op === 'isFilled');
    if (filled.length && group.length > 1) {
      throw new Error(`target ${target}: isFilled mixed with equals on source ${src} — not reducible`);
    }
    if (filled.length) {
      and.push({ src, op: 'notEmpty' });
      proofs.push(`show: ${src} isFilled → notEmpty`);
    } else {
      const vals = [...new Set(group.map((r) => r.val))];
      const op = opFor(src, 'equals');
      if (vals.length === 1) {
        and.push({ src, op, value: vals[0] });
        proofs.push(`show: ${src} equals "${vals[0]}" → ${op}`);
      } else if (op === 'includes') {
        and.push({ src, op, value: vals });
        proofs.push(`show fan-out on checkgroup ${src}: ${JSON.stringify(vals)} → includes (any-of)`);
      } else {
        and.push({ src, op: 'in', value: vals });
        proofs.push(`show fan-out on ${src}: ${JSON.stringify(vals)} → in`);
      }
    }
  }

  const showSrc = showSrcs.length === 1 ? showSrcs[0] : null;
  const byHideSrc = Object.create(null);
  for (const r of hides) (byHideSrc[r.src] = byHideSrc[r.src] || []).push(r);

  for (const src of Object.keys(byHideSrc)) {
    const group = byHideSrc[src];
    if (group.some((r) => r.op !== 'equals')) {
      throw new Error(`target ${target}: hide op "${group.find((r) => r.op !== 'equals').op}" on ${src} — not reducible`);
    }
    const hv = [...new Set(group.map((r) => r.val))];

    if (src === showSrc) {
      // PROOF: the source is single-valued, so it holds exactly one value at a
      // time. If the Show set and Hide set are disjoint, "show on V, hide on H"
      // is just "show on V" — the Hides can only fire when the Show does not.
      const sv = and[0] && and[0].value;
      const svArr = Array.isArray(sv) ? sv : [sv];
      const overlap = hv.filter((v) => svArr.includes(v));
      if (overlap.length) {
        throw new Error(`target ${target}: Hide and Show overlap on ${src} for ${JSON.stringify(overlap)} — the reduction would change meaning`);
      }
      if (!SINGLE_VALUED.has(qByQid[src] && qByQid[src].type)) {
        throw new Error(`target ${target}: same-source hides on ${src}, which is not single-valued — subsumption unproven`);
      }
      proofs.push(`hides on the show source ${src} ${JSON.stringify(hv)} subsumed: single-valued control, disjoint from show set ${JSON.stringify(svArr)}`);
      continue;
    }

    if (hv.length === 1) {
      and.push({ src, op: 'neq', value: hv[0] });
      proofs.push(`hide: ${src} equals "${hv[0]}" → neq`);
      continue;
    }

    // Multi-value hide with no Show on that source: complement its option set.
    const q = qByQid[src];
    if (!q || !SINGLE_VALUED.has(q.type)) {
      throw new Error(`target ${target}: multi-value hide on ${src} (${q ? q.type : 'unknown'}) — no complement available`);
    }
    const all = (q.options || []).map((o) => o.value);
    const comp = all.filter((v) => !hv.includes(v));
    if (!comp.length) {
      throw new Error(`target ${target}: every option of ${src} is hidden — the field can never be visible`);
    }
    proofs.push(`hide complement on ${src}: hidden ${JSON.stringify(hv)} of ${JSON.stringify(all)} → visible ${JSON.stringify(comp)}`);
    and.push(comp.length === 1 ? { src, op: 'eq', value: comp[0] } : { src, op: 'in', value: comp });
  }

  return { and, any, proofs, rules: rs };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD BUILDERS — one JotForm question → one section's fields
// ─────────────────────────────────────────────────────────────────────────────

/** Option values may not contain a comma. See `safeOptions`. */
const hasComma = (v) => String(v).includes(',');

/**
 * checkgroup selections are stored comma-JOINED (_getCheckgroup) and re-split
 * on load (_setCheckgroup), and the external submit validator splits them the
 * same way. An option VALUE containing a comma therefore shatters on the first
 * draft resume and cannot round-trip. Fred-ratified 2026-09-04: emit a
 * comma-free value with the source string verbatim as the LABEL, so the client
 * sees exactly what JotForm shows and the stored value is safe.
 */
function safeOptions(options, sink, qid, fieldName) {
  return options.map((o) => {
    const label = o.label != null ? o.label : o.value;
    let value = o.value;
    if (hasComma(value)) {
      value = String(value).replace(/\s*,\s*/g, ' / ');
      sink.push({ qid, field: fieldName, from: o.value, to: value });
    }
    return value === label ? { value, label } : { value, label };
  });
}

function buildFields(q, ctx) {
  const taken = new Set();
  const fields = [];
  const push = (f) => { fields.push(ordered('field', f)); return f; };
  const b = q.base;

  const numberish = (role) => role === 'number';

  switch (q.type) {
    case 'control_yesno': {
      // Values stay JotForm's uppercase YES/NO — 62 conditions compare against
      // them and the stored value is the long-term schema. Labels read as asked.
      push({ name: b, type: 'radio',
             options: q.options.map((o) => ({ value: o.value, label: o.value === 'YES' ? 'Yes' : (o.value === 'NO' ? 'No' : o.label) })) });
      break;
    }

    case 'control_textbox':
      push({ name: b, type: 'text', placeholder: q.placeholder || undefined });
      break;

    case 'control_number':
      push({ name: b, type: 'number', placeholder: q.placeholder || undefined });
      break;

    case 'control_phone':
      push({ name: b, type: 'text', mask: 'phone' });
      break;

    case 'control_dropdown':
      push({ name: b, type: 'select', options: safeOptions(q.options, ctx.commaFixes, q.qid, b) });
      break;

    case 'control_checkbox':
      push({ name: b, type: 'checkgroup',
             options: safeOptions(q.options, ctx.commaFixes, q.qid, b),
             allowOther: q.hasOther || undefined,
             columns: q.columns || undefined });
      break;

    case 'control_radio': {
      const opts = safeOptions(q.options, ctx.commaFixes, q.qid, b);
      // allowOther is CHECKGROUP-ONLY in the renderer (render.html buildField):
      // setting it on a radio validates, publishes, and silently draws nothing.
      // The supported idiom is a follow-up text field on the same card, which
      // is exactly what card mode's "Other → please specify" case anticipates.
      const otherOpt = q.hasOther ? opts.find((o) => /^other$/i.test(String(o.value))) : null;
      if (q.hasOther && !otherOpt) {
        throw new Error(`qid ${q.qid}: radio has a JotForm other-input but no "Other" option to hang the follow-up on`);
      }
      push({ name: b, type: 'radio', options: opts, columns: q.columns || undefined });
      if (otherOpt) {
        push({ name: subName(b, 'other', taken), type: 'text',
               label: 'Other — please specify',
               showWhen: { field: b, op: 'eq', value: otherOpt.value },
               note: `JotForm radio "other" free-text input (${q.base}[other])` });
        ctx.radioOther.push({ qid: q.qid, radio: b });
      }
      break;
    }

    case 'control_fullname':
    case 'control_address':
    case 'control_mixed': {
      for (const s of q.subs) {
        const key = subKey(s.sublabel) || subKey(s.role) || subKey(baseName(s.name).replace(b, ''));
        const name = subName(b, key, taken);
        if (q.type === 'control_mixed' && numberish(s.role)) {
          push({ name, type: 'number', label: s.sublabel || s.role, placeholder: s.placeholder || undefined });
        } else if (s.role === 'mixed-dropdown' && (s.options || []).length) {
          push({ name, type: 'select', label: s.sublabel || s.role,
                 options: safeOptions(s.options, ctx.commaFixes, q.qid, name) });
        } else if (s.role === 'mixed-dropdown') {
          // SOURCE DEFECT, not a conversion choice: this dropdown carries no
          // options at all in the fixture — only empty-valued placeholders —
          // so it is an unusable control in JotForm today. A `select` with no
          // options is not a legal definition, and INVENTING the options its
          // three siblings carry would be the converter making a semantic
          // decision. Degrade to text, keep the data slot and the question,
          // and put the one-line fix on the punch list.
          push({ name, type: 'text', label: s.sublabel || s.role,
                 note: 'source dropdown has NO options — degraded to text; session B: restore the intended choice list' });
          ctx.emptyDropdowns.push({ qid: q.qid, name, label: s.sublabel || s.role });
        } else if (s.role === 'phone') {
          push({ name, type: 'text', label: s.sublabel || s.role, mask: 'phone' });
        } else if (s.role === 'email') {
          push({ name, type: 'text', label: s.sublabel || s.role, email: true });
        } else {
          // Locked table: every other address / fullname / mixed sub-input is
          // `text`, including the sub-inputs the source renders as <select>
          // (qid 218's state, every country). Those are punch-list items, not
          // converter decisions.
          push({ name, type: 'text', label: s.sublabel || s.role });
          if (s.tag === 'SELECT') {
            ctx.selectAsText.push({ qid: q.qid, name, role: s.role,
                                    options: (s.options || []).map((o) => o.value) });
          }
        }
      }
      break;
    }

    case 'control_widget': {
      // Multiple Text Fields: one text field per configured line.
      for (const line of q.lines) {
        const name = subName(b, subKey(line), taken);
        push({ name, type: 'text', label: line });
      }
      break;
    }

    case 'control_datetime':
      push({ name: b, type: q.hasTime ? 'datetime' : 'date' });
      break;

    case 'control_matrix': {
      q.rowsLabels.forEach((rowLabel) => {
        const name = subName(b, subKey(rowLabel), taken);
        push({ name, type: 'number', label: rowLabel });
      });
      break;
    }

    default:
      throw new Error(`qid ${q.qid}: unhandled control type "${q.type}"`);
  }

  return fields;
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD
// ─────────────────────────────────────────────────────────────────────────────

function buildDefinition(parsed) {
  const { questions, conditions } = parsed;
  const qByQid = Object.create(null);
  for (const q of questions) qByQid[q.qid] = q;

  const ctx = { commaFixes: [], selectAsText: [], radioOther: [], emptyDropdowns: [] };
  const coverage = {
    questions: questions.length,
    emitted: [], dropped: [], commaFixes: ctx.commaFixes,
    selectAsText: ctx.selectAsText, radioOther: ctx.radioOther,
    emptyDropdowns: ctx.emptyDropdowns,
    conditionProofs: [], orTargets: [], conditionStats: null,
    droppedConditionTargets: [], lineageRemaps: [],
  };

  // ── conditions first: sections need their derived visibility ──
  const { rules, stats } = collectRules(conditions);
  coverage.conditionStats = stats;

  const derivedByQid = Object.create(null);
  for (const target of Object.keys(rules).sort((a, b) => Number(a) - Number(b))) {
    const targetQ = qByQid[target];
    const targetDropped = !targetQ || targetQ.hidden || DROP_CREDENTIAL[target];

    if (targetDropped) {
      // The derivation is still ATTEMPTED and recorded — it is the only place
      // a reviewer can see what logic died with the drop — but a target that
      // is not emitted is allowed to be underivable. qid 124 is the live case:
      // it is hidden on every option of qid 98, i.e. it could never appear
      // even in JotForm, which is consistent with its always-hidden markup.
      let proofs, note = null;
      try { proofs = deriveTarget(target, rules[target], qByQid).proofs; }
      catch (e) { proofs = []; note = e.message; }
      coverage.droppedConditionTargets.push({
        qid: target,
        why: !targetQ ? 'unknown qid' : (DROP_CREDENTIAL[target] ? 'credential-replaces-it' : 'always-hidden-in-source'),
        proofs, note,
      });
      continue;
    }

    const d = deriveTarget(target, rules[target], qByQid);
    // A condition may only key on a question that SURVIVES the drop pass.
    //
    // The source form has one live question (184) whose Show term keys on a
    // question the FORM ITSELF retired (137 — "gifts over $600", superseded by
    // 47). Left alone that is a live question gated on a field no client can
    // ever fill, i.e. a question that never appears. Rather than drop the
    // logic or the question, the source is REMAPPED along the same lineage
    // that justified the drop, and every step of that is asserted: the
    // successor must exist, be live, and actually carry the compared value.
    for (const c of [...d.and, ...(d.any || [])]) {
      const srcQ = qByQid[c.src];
      if (!srcQ) throw new Error(`target ${target}: condition source ${c.src} is not a question in this form`);
      if (!srcQ.hidden && !DROP_CREDENTIAL[c.src]) continue;

      const succ = HIDDEN_LINEAGE[c.src];
      if (!succ || !qByQid[succ]) {
        throw new Error(`target ${target}: condition keys on ${c.src}, which is dropped and has no lineage successor`);
      }
      const succQ = qByQid[succ];
      if (succQ.hidden || DROP_CREDENTIAL[succ]) {
        throw new Error(`target ${target}: lineage successor ${succ} of ${c.src} is itself dropped`);
      }
      const succVals = (succQ.options || []).map((o) => o.value);
      const wanted = Array.isArray(c.value) ? c.value : (c.value === undefined ? [] : [c.value]);
      const missing = wanted.filter((v) => !succVals.includes(v));
      if (succVals.length && missing.length) {
        throw new Error(`target ${target}: lineage remap ${c.src}→${succ} loses value(s) ${JSON.stringify(missing)} (successor options ${JSON.stringify(succVals)})`);
      }
      coverage.lineageRemaps.push({
        target, from: c.src, to: succ, op: c.op, value: c.value,
        fromLabel: srcQ.label, toLabel: succQ.label,
      });
      c.src = succ;
    }
    derivedByQid[target] = d;
    coverage.conditionProofs.push({ qid: target, proofs: d.proofs, rules: d.rules });
    if (d.any) coverage.orTargets.push(target);
  }

  // ── sections, in source DOM order ──
  const sections = [];
  for (const q of questions) {
    if (DROP_CREDENTIAL[q.qid]) {
      coverage.dropped.push({ qid: q.qid, label: q.label, reason: 'credential-replaces-it',
                              detail: 'the external surface resolves the case from the bearer credential; a client-writable case field is the inversion the design forbids' });
      continue;
    }
    if (q.hidden) {
      const succ = HIDDEN_LINEAGE[q.qid];
      coverage.dropped.push({ qid: q.qid, label: q.label, reason: 'always-hidden-in-source',
                              supersededBy: succ === undefined ? null : succ,
                              detail: succ ? `retired predecessor of qid ${succ}` : 'retired outright, no successor' });
      continue;
    }

    const fields = buildFields(q, ctx);
    if (!fields.length) throw new Error(`qid ${q.qid}: produced no fields`);

    // The renderer's single-question card test: ONE base (non-conditional)
    // question and NO section title ⇒ the field's label styles as the card
    // heading, which is the incumbent's look. Titling such a card would print
    // the question twice.
    const baseCount = fields.filter((f) => !f.showWhen && !f.showWhenAny).length;
    const titled = baseCount > 1;

    if (!titled) {
      fields[0].label = q.label;
      if (q.description) fields[0].sublabel = q.description;
    }

    const d = derivedByQid[q.qid];
    const toCond = (c) => ordered('condition', {
      field: qByQid[c.src].base,
      op: c.op,
      value: c.op === 'notEmpty' ? undefined : c.value,
    });

    const section = ordered('section', {
      title: titled ? q.label : undefined,
      subtitle: titled && q.description ? q.description : undefined,
      showWhen: d && d.and.length
        ? (d.and.length === 1 ? toCond(d.and[0]) : d.and.map(toCond))
        : undefined,
      showWhenAny: d && d.any ? d.any.map(toCond) : undefined,
      rows: fields.map((f) => ({ fields: [f] })),
    });

    sections.push(section);
    coverage.emitted.push({
      qid: q.qid, type: q.type, label: q.label, titled,
      names: fields.map((f) => f.name),
      types: fields.map((f) => f.type),
    });
  }

  const definition = Object.assign({}, DEFINITION_HEAD, { sections });
  return { definition, coverage, qByQid };
}

function convert(html) {
  const parsed = parseSource(html);
  return buildDefinition(parsed);
}

function convertFixture() {
  return convert(fs.readFileSync(SOURCE_HTML, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const { definition, coverage } = convertFixture();
  fs.writeFileSync(OUT_JSON, stableStringify(definition));
  console.log(`wrote ${path.relative(ROOT, OUT_JSON)}`);
  console.log(`  ${coverage.questions} source questions → ${definition.sections.length} sections, ${coverage.dropped.length} dropped`);
}

module.exports = {
  SOURCE_HTML, OUT_JSON,
  DROP_CREDENTIAL, HIDDEN_LINEAGE, EXPECTED_OR_TARGETS, DEFINITION_HEAD,
  baseName, subKey, subName, stableStringify,
  parseSource, parseConditions, collectRules, deriveTarget,
  buildDefinition, convert, convertFixture,
};
