#!/usr/bin/env node
/**
 * scripts/dbkq_v12_polish.js — D4 Part B: the DBKQ v1.2 definition pass.
 *
 * Deterministic, dev-time. Reads the PUBLISHED `dbkq` definition (from the
 * live DB via the readonly SQL API, or from a local file for tests/offline)
 * and emits v1.2 with exactly two changes:
 *
 *   1. Every `number` field gains `min: 0` (only where no min is declared —
 *      an authored bound is never clobbered; a differing one is reported).
 *   2. Dollar-denominated number fields gain `prefix: "$"` (D4 A1 adornment).
 *
 * Nothing else changes — the script deep-clones and touches only those keys.
 *
 * Dollar classification is RULE-DRIVEN and printed in full for Fred's
 * eyeball. Count-rule wins first (a family-size or mileage field must never
 * show `$`); then the dollar-rule over the field label OR its section title
 * (the expense grids carry the money language on the section); anything
 * matching neither lands in "excluded, unsure" and is left untouched.
 *
 * The report ends with the schema statement: fieldSignature() before vs
 * after (must be identical — min/prefix are invisible to the name+type
 * signature, so republishing v1.2 must NOT bump schema_version; live drafts
 * exist), and a validateDefinition() pass on the emitted JSON so the paste
 * into the builder cannot bounce.
 *
 * Usage:
 *   node scripts/dbkq_v12_polish.js --key ycro_… [--api https://app.4lsg.com]
 *       [--form-key dbkq] [--out ref/2026-09-06_dbkq_definition.v1.2.json]
 *   node scripts/dbkq_v12_polish.js --in ref/dbkq_live_definition.json --out …
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { fieldSignature, validateDefinition } = require('../services/formTemplateService');

// Count-rule first: these are quantities, never dollars.
const COUNT_RE = /how many|mileage/i;
// Dollar-rule over label OR section title (grids carry it on the section).
const DOLLAR_RE = /how much|amount|owe|payment|value|worth|refund|rent\b|mortgage|expense|spend|utility bills|insurance|garage sale|income|salary|wage|cost|balance|price/i;

/** Every (field, sectionTitle, container) triple across all container shapes. */
function* walkFields(def) {
  const lists = [];
  if (Array.isArray(def.tabs)) {
    if (Array.isArray(def.stickyTop)) lists.push(def.stickyTop);
    for (const t of def.tabs) if (t && Array.isArray(t.sections)) lists.push(t.sections);
    if (Array.isArray(def.stickyBottom)) lists.push(def.stickyBottom);
  } else if (Array.isArray(def.sections)) {
    lists.push(def.sections);
  }
  for (const sections of lists) {
    for (const section of sections) {
      if (!section) continue;
      const title = String(section.title || '');
      if (Object.prototype.hasOwnProperty.call(section, 'repeater')) {
        for (const f of section.fields || []) yield { f, title, repeater: section.repeater };
      } else {
        for (const row of section.rows || []) {
          for (const f of (row && row.fields) || []) yield { f, title, repeater: null };
        }
      }
    }
  }
}

/**
 * The v1.2 transform. Pure: returns { def, report } and never mutates input.
 */
function polish(liveDef) {
  const def = JSON.parse(JSON.stringify(liveDef));
  const report = {
    dollar: [],          // prefix:"$" applied
    counts: [],          // count-rule hit — min:0 only, NO $
    unsure: [],          // matched neither rule — untouched except min:0
    minSet: [],          // min:0 written
    minKept: [],         // a min already existed (any value) — left alone
    prefixKept: [],      // a prefix already existed — left alone
    changes: [],         // field-level human-readable diff lines
  };

  for (const { f, title, repeater } of walkFields(def)) {
    if (!f || f.type !== 'number') continue;
    const where = repeater ? `repeater "${repeater}"` : `section "${title || '(untitled)'}"`;
    const label = String(f.label || '');
    const entry = { name: f.name, label, where };

    // 1. min: 0 on every number field lacking a declared min.
    if (f.min == null) {
      f.min = 0;
      report.minSet.push(entry);
      report.changes.push(`${f.name}: +min:0`);
    } else {
      report.minKept.push({ ...entry, min: f.min });
    }

    // 2. prefix "$" by classification.
    if (COUNT_RE.test(label)) {
      report.counts.push(entry);
    } else if (DOLLAR_RE.test(label) || DOLLAR_RE.test(title)) {
      if (f.prefix == null || f.prefix === '') {
        f.prefix = '$';
        report.dollar.push(entry);
        report.changes.push(`${f.name}: +prefix:"$"`);
      } else {
        report.prefixKept.push({ ...entry, prefix: f.prefix });
      }
    } else {
      report.unsure.push(entry);
    }
  }
  return { def, report };
}

function printReport(liveDef, out, report) {
  const line = (s) => process.stdout.write(s + '\n');
  const list = (rows, fmt) => rows.forEach((r) => line('    ' + fmt(r)));

  line('══ DBKQ v1.2 polish report ══');
  line(`\nDOLLAR fields — prefix:"$" applied (${report.dollar.length}):`);
  list(report.dollar, (r) => `${r.name}  —  ${r.label}  [${r.where}]`);
  line(`\nCOUNT fields — min:0 only, NO $ (${report.counts.length}):`);
  list(report.counts, (r) => `${r.name}  —  ${r.label}`);
  line(`\nEXCLUDED, UNSURE — untouched beyond min:0 (${report.unsure.length}):`);
  if (!report.unsure.length) line('    (none)');
  list(report.unsure, (r) => `${r.name}  —  ${r.label}  [${r.where}]`);
  if (report.minKept.length) {
    line(`\nPre-existing min values LEFT ALONE (${report.minKept.length}):`);
    list(report.minKept, (r) => `${r.name}: min ${r.min}`);
  }
  if (report.prefixKept.length) {
    line(`\nPre-existing prefix values LEFT ALONE (${report.prefixKept.length}):`);
    list(report.prefixKept, (r) => `${r.name}: prefix ${JSON.stringify(r.prefix)}`);
  }
  line(`\nField-level diff vs live (${report.changes.length} changes):`);
  list(report.changes, (c) => c);

  // Schema statement — the load-bearing line.
  const sigBefore = fieldSignature(liveDef);
  const sigAfter = fieldSignature(out);
  line('\n══ schema statement ══');
  line(`fieldSignature before === after: ${sigBefore === sigAfter}`);
  if (sigBefore !== sigAfter) {
    line('!! SIGNATURE CHANGED — DO NOT PUBLISH. Report to Fred.');
    process.exitCode = 2;
  } else {
    line('Republishing v1.2 will NOT bump schema_version (live drafts stay clean).');
  }
  try {
    validateDefinition(out);
    line('validateDefinition(v1.2): PASS — the builder paste cannot bounce.');
  } catch (e) {
    line(`!! validateDefinition(v1.2) FAILED: ${e.message}`);
    process.exitCode = 2;
  }
}

// ── Live fetch: chunked SUBSTRING over the readonly SQL API (values can
//    exceed one response comfortably; 20k chunks match the manual pattern). ──
async function fetchLiveDefinition(api, key, formKey) {
  const sql = async (q, params) => {
    const res = await fetch(`${api}/api/readonly/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Readonly-Api-Key': key },
      body: JSON.stringify({ sql: q, params }),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(`readonly SQL failed: ${JSON.stringify(body).slice(0, 300)}`);
    return body.rows;
  };
  const [{ n }] = await sql(
    'SELECT CHAR_LENGTH(definition) AS n FROM form_templates WHERE form_key = ?', [formKey]);
  const total = Number(n);
  if (!total) throw new Error(`form_templates.${formKey} has no published definition`);
  const STEP = 20000;
  let out = '';
  for (let off = 1; off <= total; off += STEP) {
    const [{ s }] = await sql(
      'SELECT SUBSTRING(definition, ?, ?) AS s FROM form_templates WHERE form_key = ?',
      [off, STEP, formKey]);
    out += s;
  }
  if (out.length !== total) throw new Error(`chunked read short: ${out.length} != ${total}`);
  return JSON.parse(out);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : dflt;
  };
  const inFile = opt('--in', null);
  const outFile = opt('--out', 'ref/2026-09-06_dbkq_definition.v1.2.json');

  let liveDef;
  if (inFile) {
    liveDef = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  } else {
    const key = opt('--key', process.env.READONLY_API_KEY);
    if (!key) throw new Error('need --in <file>, or --key / READONLY_API_KEY for a live read');
    liveDef = await fetchLiveDefinition(
      opt('--api', 'https://app.4lsg.com'), key, opt('--form-key', 'dbkq'));
  }

  const { def, report } = polish(liveDef);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(def, null, 2) + '\n');
  printReport(liveDef, def, report);
  process.stdout.write(`\nEmitted: ${outFile}\n`);
  process.stdout.write('Next: paste into the builder as the dbkq draft, republish, then spot-check:\n');
  process.stdout.write('  1. a dollar field (e.g. monthly rent) renders a $ inside the input box;\n');
  process.stdout.write('  2. the family-size card shows NO $;\n');
  process.stdout.write("  3. '-' does nothing on the family-size keypad, and a pasted -4 errors on blur.\n");
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { polish, walkFields, COUNT_RE, DOLLAR_RE };
