#!/usr/bin/env node
/**
 * scripts/dbkq_verify.js — the D2-A verification harness.
 *
 * DEV-TIME TOOL. Requires `jsdom` (devDependency) via dbkq_convert; it does NOT
 * run in the production container (`npm install --omit=dev`).
 *
 *   node scripts/dbkq_verify.js            # checks + writes the coverage report
 *   node scripts/dbkq_verify.js --quiet    # exit code only
 *
 * WHY THIS FILE IS A DELIVERABLE IN ITS OWN RIGHT: a silent conversion error
 * produces a bankruptcy petition built on an answer nobody was asked for. The
 * definition is only trustworthy to the extent something independent re-derives
 * the source facts and compares. So every check below re-reads the FIXTURE and
 * compares against the EMITTED definition — it never trusts the converter's own
 * coverage bookkeeping for a claim it can check directly.
 *
 * Exit code is 0 only when every check passes. KNOWN_SOURCE_ISSUES is the one
 * escape hatch, and it is an ALLOWLIST: each entry names a specific defect in
 * the source form with a rationale. Anything outside it fails the run, so a
 * future re-fetch that moves the problem set cannot pass quietly.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const conv    = require('./dbkq_convert.js');
const tplSvc  = require(path.join(__dirname, '..', 'services', 'formTemplateService.js'));

const ROOT       = path.join(__dirname, '..');
const OUT_REPORT = path.join(ROOT, 'ref', '2026-09-04_dbkq_coverage.md');

// Payload projection: over this and D3 must raise MAX_VALUES_BYTES. The REAL
// cap is 64KB (extFormService MAX_VALUES_BYTES); 40KB is the early-warning line
// so a form does not creep up on the cap between slices.
const WARN_BYTES = 40 * 1024;
const REAL_CAP   = 64 * 1024;

/**
 * Defects in the SOURCE FORM, acknowledged and enumerated. Not converter bugs —
 * each is something a human must decide about the questionnaire itself.
 */
const KNOWN_SOURCE_ISSUES = {
  or_targets: {
    qids: conv.EXPECTED_OR_TARGETS,
    why: 'genuine cross-source OR; emitted as showWhenAny (contract §4.4.1, built in this slice)',
  },
  comma_option_values: {
    // Checkgroups 79 and 81 are the corrupting cases (_getCheckgroup joins on
    // ',' and _setCheckgroup splits on it, so a comma-bearing value shatters on
    // the first draft resume). Radios 36, 56 and 270 are not corrupted TODAY,
    // but the rule is applied to every option type on purpose: the `in` op
    // serializes to the comma-joined data-yc-show-values attribute, so the day
    // one of these radios becomes a condition source with more than one value,
    // a comma in the value silently splits the condition. Cheap to prevent,
    // invisible to debug.
    qids: ['36', '56', '79', '81', '270'],
    why: 'option values containing commas cannot round-trip a comma-joined checkgroup, and would split an `in` condition; emitted with a comma-free value and the verbatim source string as label (Fred-ratified 2026-09-04)',
  },
  empty_dropdown: {
    qids: ['229'],
    why: 'sub-input field_10 is a dropdown with no options in the source; degraded to text rather than inventing the sibling YES/NO list',
  },
  lineage_remap: {
    qids: ['184'],
    why: 'Show term keyed on retired qid 137; remapped to its live successor 47 along the same lineage that justified the drop',
  },
};

// ─────────────────────────────────────────────────────────────────────────────

const results = [];
let failed = 0;
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (e) {
    failed++;
    results.push({ name, ok: false, detail: e.message });
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ─────────────────────────────────────────────────────────────────────────────
// CONVERT (twice — determinism is check 8)
// ─────────────────────────────────────────────────────────────────────────────

const html = fs.readFileSync(conv.SOURCE_HTML, 'utf8');
const runA = conv.convert(html);
const runB = conv.convert(html);
const def  = runA.definition;
const cov  = runA.coverage;
const jsonA = conv.stableStringify(runA.definition);
const jsonB = conv.stableStringify(runB.definition);

const parsed = conv.parseSource(html);
const srcByQid = Object.create(null);
for (const q of parsed.questions) srcByQid[q.qid] = q;

// Every emitted field, flattened once.
const allFields = [];
def.sections.forEach((s, si) => s.rows.forEach((r) => r.fields.forEach((f) => {
  allFields.push({ f, si, section: s });
})));
const fieldByName = Object.create(null);
for (const e of allFields) fieldByName[e.f.name] = e.f;

// qid → emitted names, re-derived from the definition by name prefix rather
// than read out of the converter's own bookkeeping.
const emittedByQid = Object.create(null);
for (const e of allFields) {
  const m = /^q(\d+)_/.exec(e.f.name);
  assert(m, `field "${e.f.name}" does not carry a q<qid>_ prefix`);
  (emittedByQid[m[1]] = emittedByQid[m[1]] || []).push(e.f.name);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. COVERAGE — every source qid is emitted or justifiably dropped
// ─────────────────────────────────────────────────────────────────────────────

check('1. coverage: every source qid is emitted or justifiably dropped', () => {
  const droppedByQid = Object.create(null);
  for (const d of cov.dropped) droppedByQid[d.qid] = d;

  for (const q of parsed.questions) {
    const emitted = emittedByQid[q.qid];
    const dropped = droppedByQid[q.qid];
    assert(!!emitted !== !!dropped,
      `qid ${q.qid}: must be exactly one of emitted / dropped (emitted=${!!emitted}, dropped=${!!dropped})`);
    if (dropped) {
      assert(['always-hidden-in-source', 'credential-replaces-it'].includes(dropped.reason),
        `qid ${q.qid}: unrecognized drop reason "${dropped.reason}"`);
      if (dropped.reason === 'always-hidden-in-source') {
        assert(q.hidden, `qid ${q.qid}: dropped as always-hidden but the fixture does not mark it so`);
      }
    }
  }
  const total = def.sections.length + cov.dropped.length;
  assert(total === parsed.questions.length,
    `reconciliation: ${def.sections.length} sections + ${cov.dropped.length} dropped = ${total} ≠ ${parsed.questions.length} source questions`);

  const hid = cov.dropped.filter((d) => d.reason === 'always-hidden-in-source').length;
  const cred = cov.dropped.filter((d) => d.reason === 'credential-replaces-it').length;
  assert(hid === 23 && cred === 1, `expected 23 always-hidden + 1 credential drops, got ${hid} + ${cred}`);
  assert(def.sections.length === 148, `expected 148 emitted sections, got ${def.sections.length}`);
  return `172 = 148 emitted + ${hid} dropped(hidden) + ${cred} dropped(credential)`;
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CONDITIONS — reconciliation, source existence, value membership,
//    and the model proof per target
// ─────────────────────────────────────────────────────────────────────────────

check('2a. conditions: 63 = 62 enabled + 1 disabled-and-dropped', () => {
  const s = cov.conditionStats;
  assert(s.total === 63, `expected 63 conditions in setConditions, got ${s.total}`);
  assert(s.disabled === 1, `expected exactly 1 disabled condition, got ${s.disabled}`);
  const enabled = s.total - s.disabled;
  assert(enabled === 62, `expected 62 enabled, got ${enabled}`);
  return `${s.total} conditions → ${enabled} enabled (${s.actions} actions) + ${s.disabled} disabled`;
});

check('2b. conditions: every emitted condition references a live field and a real option value', () => {
  const walk = (carrier, where) => {
    const list = [];
    if (carrier.showWhen) list.push(...(Array.isArray(carrier.showWhen) ? carrier.showWhen : [carrier.showWhen]));
    if (carrier.showWhenAny) list.push(...carrier.showWhenAny);
    for (const c of list) {
      const target = fieldByName[c.field];
      assert(target, `${where}: condition field "${c.field}" is not an emitted field`);
      if (c.op === 'includes') {
        assert(target.type === 'checkgroup',
          `${where}: op includes targets "${c.field}" of type ${target.type} (contract requires checkgroup)`);
      }
      if (target.options && ['eq', 'neq', 'in', 'includes'].includes(c.op)) {
        const opts = target.options.map((o) => (o && typeof o === 'object' ? o.value : o));
        const want = Array.isArray(c.value) ? c.value : [c.value];
        for (const v of want) {
          assert(opts.includes(v),
            `${where}: value ${JSON.stringify(v)} is not an option of "${c.field}" (${JSON.stringify(opts)})`);
        }
      }
    }
    return list.length;
  };
  let n = 0;
  def.sections.forEach((s, i) => {
    n += walk(s, `sections[${i}]`);
    s.rows.forEach((r, j) => r.fields.forEach((f, k) => { n += walk(f, `sections[${i}].rows[${j}].fields[${k}]`); }));
  });
  return `${n} emitted conditions, all resolvable, all values in range`;
});

check('2c. conditions: every target reduction is provable under the visibility model', () => {
  // Re-derive independently of the converter's stored proofs and compare the
  // emitted section logic to a from-scratch reduction of the source rules.
  const { rules } = conv.collectRules(parsed.conditions);
  const nameOf = (qid) => (emittedByQid[qid] ? emittedByQid[qid][0] : null);
  let proved = 0;

  for (const target of Object.keys(rules)) {
    const sectionIndex = cov.emitted.findIndex((e) => e.qid === target);
    if (sectionIndex === -1) continue;                 // dropped target
    const section = def.sections[sectionIndex];
    const d = conv.deriveTarget(target, rules[target], srcByQid);

    // Lineage remaps are applied in buildDefinition, so re-apply here.
    for (const c of [...d.and, ...(d.any || [])]) {
      if (srcByQid[c.src] && (srcByQid[c.src].hidden || conv.DROP_CREDENTIAL[c.src])) {
        c.src = conv.HIDDEN_LINEAGE[c.src];
      }
    }
    const norm = (c) => JSON.stringify({
      field: nameOf(c.src), op: c.op,
      value: c.op === 'notEmpty' ? undefined : c.value,
    });

    const expectAnd = d.and.map(norm);
    const gotAnd = !section.showWhen ? []
      : (Array.isArray(section.showWhen) ? section.showWhen : [section.showWhen])
          .map((c) => JSON.stringify({ field: c.field, op: c.op, value: c.value }));
    assert(JSON.stringify(expectAnd) === JSON.stringify(gotAnd),
      `qid ${target}: AND half ${JSON.stringify(gotAnd)} ≠ derived ${JSON.stringify(expectAnd)}`);

    const expectAny = (d.any || []).map(norm);
    const gotAny = (section.showWhenAny || [])
      .map((c) => JSON.stringify({ field: c.field, op: c.op, value: c.value }));
    assert(JSON.stringify(expectAny) === JSON.stringify(gotAny),
      `qid ${target}: OR half ${JSON.stringify(gotAny)} ≠ derived ${JSON.stringify(expectAny)}`);
    proved++;
  }
  return `${proved} live targets re-derived from the source rules and matched`;
});

check('2d. conditions: the OR set is exactly the acknowledged one', () => {
  const got = cov.orTargets.slice().sort();
  const want = KNOWN_SOURCE_ISSUES.or_targets.qids.slice().sort();
  assert(JSON.stringify(got) === JSON.stringify(want),
    `showWhenAny targets ${JSON.stringify(got)} ≠ acknowledged ${JSON.stringify(want)} — the source's OR set moved; re-review before shipping`);
  return `showWhenAny on qid(s) ${want.join(', ')}`;
});

check('2e. conditions: lineage remaps are exactly the acknowledged ones', () => {
  const got = [...new Set(cov.lineageRemaps.map((r) => r.target))].sort();
  const want = KNOWN_SOURCE_ISSUES.lineage_remap.qids.slice().sort();
  assert(JSON.stringify(got) === JSON.stringify(want),
    `lineage remaps ${JSON.stringify(got)} ≠ acknowledged ${JSON.stringify(want)}`);
  return cov.lineageRemaps.map((r) => `${r.target}: ${r.from}→${r.to}`).join(', ') || 'none';
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OPTIONS FIDELITY — labels verbatim, order preserved, values comma-free
// ─────────────────────────────────────────────────────────────────────────────

check('3a. options: labels are set-equal AND order-equal to the source', () => {
  let checked = 0;
  for (const q of parsed.questions) {
    if (!emittedByQid[q.qid]) continue;
    if (!['control_radio', 'control_yesno', 'control_checkbox', 'control_dropdown'].includes(q.type)) continue;
    const f = fieldByName[q.base];
    assert(f, `qid ${q.qid}: no emitted field named "${q.base}"`);
    assert(Array.isArray(f.options), `qid ${q.qid}: emitted field carries no options`);
    const srcLabels = q.options.map((o) => o.label);
    const gotLabels = f.options.map((o) => (o && typeof o === 'object' ? o.label : o));
    // yesno is the one declared label edit (YES→Yes), Fred-ratified.
    const expect = q.type === 'control_yesno'
      ? srcLabels.map((l) => (l === 'YES' ? 'Yes' : l === 'NO' ? 'No' : l))
      : srcLabels;
    assert(JSON.stringify(gotLabels) === JSON.stringify(expect),
      `qid ${q.qid}: option labels ${JSON.stringify(gotLabels)} ≠ source ${JSON.stringify(expect)}`);
    checked++;
  }
  return `${checked} choice fields, labels verbatim and in source order`;
});

check('3b. options: no emitted option value contains a comma', () => {
  const bad = [];
  for (const { f } of allFields) {
    for (const o of f.options || []) {
      const v = (o && typeof o === 'object') ? o.value : o;
      if (String(v).includes(',')) bad.push(`${f.name}: ${JSON.stringify(v)}`);
    }
  }
  assert(!bad.length, `comma-bearing option values would shatter a comma-joined checkgroup: ${bad.join(' | ')}`);
  const fixQids = [...new Set(cov.commaFixes.map((c) => c.qid))].sort();
  const want = KNOWN_SOURCE_ISSUES.comma_option_values.qids.slice().sort();
  assert(JSON.stringify(fixQids) === JSON.stringify(want),
    `comma fixes applied to ${JSON.stringify(fixQids)} ≠ acknowledged ${JSON.stringify(want)}`);
  return `${cov.commaFixes.length} value(s) made comma-safe on qid(s) ${fixQids.join(', ')}; labels untouched`;
});

check('3c. options: every allowOther matches a source other-input, and only on checkgroups', () => {
  for (const q of parsed.questions) {
    if (!emittedByQid[q.qid] || q.hasOther === undefined) continue;
    const f = fieldByName[q.base];
    if (f.type === 'checkgroup') {
      assert(!!f.allowOther === !!q.hasOther,
        `qid ${q.qid}: allowOther=${!!f.allowOther} but the source ${q.hasOther ? 'has' : 'has no'} other-input`);
    } else {
      // allowOther is checkgroup-only in the renderer; a radio's Other becomes
      // a follow-up text field instead (see the converter).
      assert(!f.allowOther, `qid ${q.qid}: allowOther on type ${f.type} is a dead key in render.html`);
      if (q.hasOther) {
        const follow = emittedByQid[q.qid].map((n) => fieldByName[n]).find((x) => x.showWhen && x.type === 'text');
        assert(follow, `qid ${q.qid}: radio has a source other-input but no follow-up text field was emitted`);
      }
    }
  }
  return 'allowOther only on checkgroups; radio Other carried by a conditional follow-up field';
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. validateDefinition — the real one, not a reimplementation
// ─────────────────────────────────────────────────────────────────────────────

check('4. validateDefinition (services/formTemplateService.js) accepts the definition', () => {
  tplSvc.validateDefinition(def);
  assert(def.layout === 'card', 'layout must be card');
  assert(!def.tabs, 'card layout excludes tabs');
  for (const k of ['code', 'css', 'hooks', 'derive']) {
    assert(def[k] === undefined, `top-level "${k}" must not be emitted (externally refused / out of scope)`);
  }
  assert(!allFields.some((e) => e.f.type === 'embed'), 'embed fields are refused externally');
  assert(def.external.serverDrafts === true && def.external.badLink === 'degrade',
    'external head does not match the locked decision');
  return 'passes; no code/css/hooks/derive/embed emitted';
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NAME HYGIENE
// ─────────────────────────────────────────────────────────────────────────────

check('5. names: unique, regex-conformant, ≤50 chars', () => {
  const re = /^[a-zA-Z0-9_]{1,50}$/;
  const seen = new Set();
  let longest = '';
  for (const { f } of allFields) {
    assert(re.test(f.name), `name "${f.name}" fails ^[a-zA-Z0-9_]{1,50}$`);
    assert(!seen.has(f.name), `duplicate field name "${f.name}"`);
    seen.add(f.name);
    if (f.name.length > longest.length) longest = f.name;
  }
  return `${seen.size} unique names, longest ${longest.length} chars ("${longest}")`;
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CARD INVARIANTS
// ─────────────────────────────────────────────────────────────────────────────

check('6. cards: one section per surviving question, no section mixes two source qids', () => {
  assert(def.sections.length === cov.emitted.length, 'section count ≠ emitted count');
  def.sections.forEach((s, i) => {
    const qids = new Set();
    s.rows.forEach((r) => {
      assert(r.fields.length === 1, `sections[${i}]: rows carry exactly one field each`);
      r.fields.forEach((f) => qids.add(/^q(\d+)_/.exec(f.name)[1]));
    });
    assert(qids.size === 1, `sections[${i}] mixes source qids ${[...qids].join(', ')}`);
    assert(qids.has(cov.emitted[i].qid), `sections[${i}] is not the question the coverage map claims`);

    // The renderer's single-question rule: exactly one BASE question and no
    // title ⇒ the field label is the card heading. A titled card must have >1.
    const base = s.rows.map((r) => r.fields[0]).filter((f) => !f.showWhen && !f.showWhenAny);
    if (s.title) assert(base.length > 1, `sections[${i}] is titled but has ${base.length} base question(s) — it would print the question twice`);
    else assert(base.length === 1, `sections[${i}] is untitled but has ${base.length} base questions`);
    if (!s.title) assert(!!s.rows[0].fields[0].label, `sections[${i}]: untitled card's first field carries no label`);
  });
  const titled = def.sections.filter((s) => s.title).length;
  return `${def.sections.length} cards — ${def.sections.length - titled} single-question, ${titled} titled multi-field`;
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PAYLOAD PROJECTION
// ─────────────────────────────────────────────────────────────────────────────

let payloadBytes = 0;
check('7. payload: a realistic-generous full submission fits the storage cap', () => {
  const values = {};
  const long = (n) => 'x'.repeat(n);
  for (const { f } of allFields) {
    switch (f.type) {
      case 'number':     values[f.name] = '123456'; break;
      case 'date':       values[f.name] = '2026-09-04'; break;
      case 'datetime':   values[f.name] = '2026-09-04T09:30'; break;
      case 'select':
      case 'radio':      values[f.name] = f.options.map((o) => (typeof o === 'object' ? o.value : o)).pop(); break;
      case 'checkgroup': values[f.name] = f.options.map((o) => (typeof o === 'object' ? o.value : o)).join(','); break;
      default:
        // Damage / description fields realistically run long; everything else
        // gets a generous 120 chars.
        values[f.name] = /describe|damage|problem|explain|list|why|what other/i.test(String(f.label || ''))
          ? long(500) : long(120);
    }
  }
  payloadBytes = Buffer.byteLength(JSON.stringify(values));
  assert(payloadBytes <= REAL_CAP,
    `projected payload ${payloadBytes} B EXCEEDS the real cap ${REAL_CAP} B (MAX_VALUES_BYTES, extFormService.js) — D3 must raise it before this form ships`);
  return `${payloadBytes} B over ${allFields.length} fields`
    + ` — real cap ${REAL_CAP} B, early-warning line ${WARN_BYTES} B`
    + (payloadBytes > WARN_BYTES ? '  ⚠ OVER THE WARNING LINE' : '  (under both)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. DETERMINISM
// ─────────────────────────────────────────────────────────────────────────────

check('8. determinism: two conversions of the same fixture are byte-identical', () => {
  assert(jsonA === jsonB, 'two runs produced different bytes');
  const onDisk = fs.existsSync(conv.OUT_JSON) ? fs.readFileSync(conv.OUT_JSON, 'utf8') : null;
  assert(onDisk === null || onDisk === jsonA,
    'ref/2026-09-04_dbkq_definition.v1.json is stale — re-run scripts/dbkq_convert.js');
  return `${Buffer.byteLength(jsonA)} B, identical across runs and matching the committed file`;
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) { return String(s).replace(/\|/g, '\\|'); }

function report() {
  const L = [];
  const P = (s) => L.push(s === undefined ? '' : s);

  P('# DBKQ → YisraForm — conversion coverage report');
  P('');
  P('Generated by `scripts/dbkq_verify.js` from `ref/dbkq_source_2026-09-04.html`');
  P('(JotForm 231694062254152, `buildDate=1788466370695`). Slice D2-A.');
  P('');
  P('**Do not hand-edit.** Re-run the harness instead — the report is a projection of the check results.');
  P('');

  P('## Result');
  P('');
  P(`| check | result | detail |`);
  P(`|---|---|---|`);
  for (const r of results) P(`| ${esc(r.name)} | ${r.ok ? 'PASS' : '**FAIL**'} | ${esc(r.detail)} |`);
  P('');
  P(failed ? `**${failed} check(s) FAILED.**` : '**All checks passed.**');
  P('');

  P('## Session-B blockers (acknowledged source defects)');
  P('');
  P('These are properties of the JotForm source, not conversion bugs. Each is');
  P('allowlisted in `KNOWN_SOURCE_ISSUES` so the harness passes while they stay');
  P('visible; a defect appearing outside the allowlist fails the run.');
  P('');
  for (const [key, v] of Object.entries(KNOWN_SOURCE_ISSUES)) {
    P(`- **${key}** — qid(s) ${v.qids.join(', ')}: ${v.why}`);
  }
  P('');

  P('## Reconciliation');
  P('');
  P(`- source questions: **${parsed.questions.length}**`);
  P(`- emitted sections: **${def.sections.length}** (one card per surviving question)`);
  P(`- emitted fields: **${allFields.length}**`);
  P(`- dropped: **${cov.dropped.length}** = ${cov.dropped.filter((d) => d.reason === 'always-hidden-in-source').length} always-hidden + ${cov.dropped.filter((d) => d.reason === 'credential-replaces-it').length} credential`);
  P(`- conditions: **${cov.conditionStats.total}** = ${cov.conditionStats.total - cov.conditionStats.disabled} enabled + ${cov.conditionStats.disabled} disabled-and-dropped`);
  P(`- condition actions: ${cov.conditionStats.actions} across ${cov.conditionProofs.length + cov.droppedConditionTargets.length} target qids`);
  P(`- projected full payload: **${payloadBytes} B** (real cap ${REAL_CAP} B, warning line ${WARN_BYTES} B)`);
  P('');

  P('## Dropped questions');
  P('');
  P('### Credential (the inversion rule)');
  P('');
  P('| qid | label | why |');
  P('|---|---|---|');
  for (const d of cov.dropped.filter((x) => x.reason === 'credential-replaces-it')) {
    P(`| ${d.qid} | ${esc(d.label)} | ${esc(d.detail)} |`);
  }
  P('');
  P('### Always-hidden in source — with lineage');
  P('');
  P('The source\'s own retired predecessors. The lineage column is petition-feed');
  P('documentation: it records which live question now carries the fact the');
  P('retired one used to hold, which is the part that would otherwise be lost.');
  P('');
  P('| qid | label | superseded by | successor question |');
  P('|---|---|---|---|');
  for (const d of cov.dropped.filter((x) => x.reason === 'always-hidden-in-source')) {
    const succ = d.supersededBy;
    const succLabel = succ && srcByQid[succ] ? srcByQid[succ].label : '—';
    P(`| ${d.qid} | ${esc(d.label || '(no label)')} | ${succ || '— (retired outright)'} | ${esc(succLabel)} |`);
  }
  P('');
  if (cov.droppedConditionTargets.length) {
    P('Conditions that died with a dropped target:');
    P('');
    for (const t of cov.droppedConditionTargets) {
      P(`- **qid ${t.qid}** (${t.why})${t.note ? ` — ${t.note}` : ''}`);
      for (const p of t.proofs) P(`  - ${p}`);
    }
    P('');
  }

  P('## qid → emitted field map');
  P('');
  P('| qid | source type | emitted | card | fields |');
  P('|---|---|---|---|---|');
  for (const e of cov.emitted) {
    const pairs = e.names.map((n, i) => `\`${n}\` *(${e.types[i]})*`).join('<br>');
    P(`| ${e.qid} | ${e.type.replace('control_', '')} | ${e.names.length} | ${e.titled ? 'titled' : 'single'} | ${pairs} |`);
  }
  P('');

  P('## Condition derivations');
  P('');
  P('Visibility model (Fred-ratified 2026-09-04): a field targeted by ≥1 Show rule');
  P('is hidden until a Show term matches; a field targeted only by Hide rules is');
  P('visible until a Hide term matches. `visible = OR(shows) AND NOT OR(hides)`.');
  P('Every reduction below is proven, not assumed — same-source subsumption');
  P('asserts disjointness, complements are taken against the source option set,');
  P('and anything unprovable throws.');
  P('');
  for (const p of cov.conditionProofs) {
    const e = cov.emitted.find((x) => x.qid === p.qid);
    P(`### qid ${p.qid} — ${esc(e ? e.label : '')}`);
    P('');
    P('source rules:');
    for (const r of p.rules) P(`- \`${r.show ? 'Show' : 'Hide'}\` when **${r.src}** ${r.op} ${JSON.stringify(r.val)}  *(cond ${r.cid})*`);
    P('');
    P('reduction:');
    for (const x of p.proofs) P(`- ${x}`);
    const sec = def.sections[cov.emitted.findIndex((x) => x.qid === p.qid)];
    P('');
    P('emitted:');
    P('```json');
    P(JSON.stringify({ showWhen: sec.showWhen, showWhenAny: sec.showWhenAny }, null, 2));
    P('```');
    P('');
  }

  if (cov.lineageRemaps.length) {
    P('### Lineage remaps');
    P('');
    for (const r of cov.lineageRemaps) {
      P(`- target **${r.target}**: source **${r.from}** ("${esc(r.fromLabel)}") is dropped → remapped to **${r.to}** ("${esc(r.toLabel)}"), op \`${r.op}\` value ${JSON.stringify(r.value)}`);
    }
    P('');
  }

  P('## Session-B punch list');
  P('');
  P('Everything below needs human judgement. Nothing here blocks loading the');
  P('definition into the builder; all of it should be settled before publish.');
  P('');

  P('### 1. Must decide before publish');
  P('');
  P('- **`external.postSubmit.message` is a placeholder** — `<PLACEHOLDER — Fred finalizes in session B>`. It will render verbatim to a client.');
  P(`- **qid 229 \`field_10\`** ("Are there any modifications to the vehicle?") is a dropdown with **no options** in the source. Emitted as \`text\`. Its three siblings are YES/NO selects; restoring that list is almost certainly the intent, but the converter will not invent options.`);
  P('- **qid 36 uses the new `showWhenAny` OR.** Verify the intended reading: show the keep-or-replace question when the client leases **or** was repossessed **or** entered an amount owed.');
  P('- **qid 184\'s Show term was remapped** from retired qid 137 to its live successor qid 47. Confirm 47 is the question that should gate it.');
  P('');

  P('### 2. Types worth a second look');
  P('');
  if (cov.emptyDropdowns.length) {
    for (const d of cov.emptyDropdowns) P(`- \`${d.name}\` — option-less source dropdown, emitted as text ("${esc(d.label)}")`);
  }
  const q242 = cov.emitted.find((e) => e.qid === '242');
  if (q242) {
    P(`- **qid 242** (transportation expenses, the live twin of retired qid 240) has \`text\` sub-inputs in the source where 240 had \`number\`. Emitted faithfully as text — every other expense grid is numeric. Fields: ${q242.names.map((n) => `\`${n}\``).join(', ')}`);
  }
  P('- Widget lines "How much do you owe on the vehicle?" and every amount inside the Multiple Text Fields widgets are free text in the source and stay `text`.');
  P('- No source field is `required` and there are no textareas; long-answer fields ("Please describe any damage…") are single-line `text`. Consider `textarea` + `rows` for the description fields.');
  P('');

  P('### 3. Selects flattened to text (locked type table)');
  P('');
  P('The locked address mapping is "one `text` per sub-input". These sub-inputs are');
  P('`<select>` in the source, so free text will produce dirty values ("MI", "Michigan", "mich").');
  P('Paste-ready replacement JSON per field:');
  P('');
  for (const s of cov.selectAsText) {
    P(`- \`${s.name}\` (qid ${s.qid}, ${s.role}) — ${s.options.length} source options`);
    P('  ```json');
    P(`  { "name": "${s.name}", "type": "select", "options": ${JSON.stringify(s.options)} }`);
    P('  ```');
  }
  P('');

  P('### 4. Wording lifted verbatim (no editorial pass was applied)');
  P('');
  P('- Every label, sublabel and option label is the source string exactly. The one');
  P('  declared exception is yes/no display text (`YES`→`Yes`, `NO`→`No`); the stored');
  P('  values remain `YES`/`NO`.');
  const authorNotes = parsed.questions.filter((q) => /hidden field|was used before|test/i.test(q.description || ''));
  for (const q of authorNotes) {
    P(`- qid ${q.qid} description reads as an internal author note, not client copy: "${esc(q.description)}"${q.hidden ? ' *(dropped — always-hidden)*' : ''}`);
  }
  P('- Sublabels like "Please enter a valid phone number." are JotForm validation hints sitting in the sublabel slot.');
  P('');

  P('### 5. Layout choices the converter made mechanically');
  P('');
  P('- **One field per row.** No width guessing: an 8-item expense grid is 8 stacked');
  P('  rows. Grouping (e.g. first/last name side by side via `width`) is a session-B call.');
  P(`- **Card titles** appear only on multi-field cards (${def.sections.filter((s) => s.title).length} of ${def.sections.length}); single-question cards are untitled so the`);
  P('  field label styles as the heading, which is the incumbent JotForm look.');
  P('- **Descriptions** became `sublabel` on single-question cards and `subtitle` on titled ones.');
  P(`- **\`columns\`** carried from the source \`data-columncount\` where it was 1–3.`);
  P('');

  P('### 6. Comma-safe option values (applied, review the wording)');
  P('');
  P('| qid | field | source value (kept as the label) | emitted value |');
  P('|---|---|---|---|');
  for (const c of cov.commaFixes) P(`| ${c.qid} | \`${c.field}\` | ${esc(c.from)} | ${esc(c.to)} |`);
  P('');

  P('### 7. Masks and validation that can block a card');
  P('');
  P('Card mode gates Next on the card\'s own validation. These will reject input:');
  P('');
  for (const { f } of allFields) {
    if (f.mask) P(`- \`${f.name}\` — \`mask: "${f.mask}"\` requires exactly 10 digits (\`_validateMask\`); "+1 248 555 1234" fails.`);
  }
  for (const { f } of allFields) {
    if (f.email) P(`- \`${f.name}\` — \`email: true\``);
  }
  P('');

  P('## Radio "Other" follow-ups');
  P('');
  if (cov.radioOther.length) {
    for (const r of cov.radioOther) {
      P(`- qid ${r.qid}: \`${r.radio}\` is a radio whose source carries a free-text Other. \`allowOther\` is checkgroup-only in the renderer, so the free text is a companion \`text\` field shown when the radio equals "Other".`);
    }
  } else P('- none');
  P('');

  return L.join('\n') + '\n';
}

const quiet = process.argv.includes('--quiet');
fs.writeFileSync(OUT_REPORT, report());

if (!quiet) {
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
  console.log('');
  console.log(`report → ${path.relative(ROOT, OUT_REPORT)}`);
}
console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(failed ? 1 : 0);
