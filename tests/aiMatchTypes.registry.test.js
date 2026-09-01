// tests/aiMatchTypes.registry.test.js
//
/**
 * Unified Events U2 §5 — `ai_match_types.item_type` becomes an FK-by-value to
 * `calendar_item_types.type_key` (v0.5 §3.3). Live 2026-09-01: item_type is
 * NULL on all 42 rows (only ignore rows are seeded), so this passes
 * vacuously today. It exists to guard U7's seeds: every ACTIVE (uncommented)
 * INSERT INTO ai_match_types in ref/*.sql that names an item_type must name a
 * registry key.
 *
 * NOTE for U7: ref/2026-08-10_ai_match_registry.sql carries a COMMENTED-OUT
 * example row with item_type '341_meeting'. That is NOT the registry key —
 * the key is 'meeting_341' (Appendix A). Uncommenting it as-is fails here.
 *
 * Run:  npx jest tests/aiMatchTypes.registry.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { SEED } = require('../scripts/calendarTypeSeed');

const REF = path.join(__dirname, '..', 'ref');
const REGISTRY_KEYS = new Set(SEED.map((r) => r[0]));

/** Active (non-comment) INSERT INTO ai_match_types statements across ref/*.sql. */
function activeInserts() {
  const out = [];
  for (const f of fs.readdirSync(REF).filter((n) => n.endsWith('.sql') && n !== 'database.sql')) {
    const code = fs.readFileSync(path.join(REF, f), 'utf8')
      .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    for (const m of code.matchAll(/INSERT INTO ai_match_types\s*\(([^)]*)\)([\s\S]*?);/gi)) {
      out.push({ file: f, cols: m[1].split(',').map((s) => s.trim()), body: m[2] });
    }
  }
  return out;
}

test('every seeded ai_match_types.item_type is a calendar_item_types key (vacuous until U7)', () => {
  const inserts = activeInserts();
  expect(inserts.length).toBeGreaterThan(0);   // the walker found the ignore seeds
  const offenders = [];
  for (const ins of inserts) {
    const idx = ins.cols.indexOf('item_type');
    if (idx === -1) continue;   // ignore rows carry no item_type
    // Values may arrive via VALUES (...) or INSERT … SELECT; pull every quoted
    // literal in the value position and check it. Conservative: a literal we
    // cannot place is reported, not skipped.
    const literals = [...ins.body.matchAll(/'([^']*)'/g)].map((x) => x[1]);
    const candidates = literals.filter((v) => /^[a-z][a-z0-9_]{0,39}$/.test(v));
    const named = candidates.filter((v) => !REGISTRY_KEYS.has(v) && /_/.test(v));
    for (const v of named) offenders.push(`${ins.file}: ${v}`);
  }
  expect(offenders).toEqual([]);
});

test('the registry keys the court pipeline will bind to exist', () => {
  for (const k of ['meeting_341', 'confirmation_hearing', 'show_cause', 'docs_deadline', 'schedules_deadline',
                   'dischargeability_due', 'object_confirmation_due', 'poc_due', 'poc_gov_due',
                   'confirmation_certificate_deadline', 'filing_fee_deadline', 'filing_fee_installment_deadline']) {
    expect(REGISTRY_KEYS.has(k)).toBe(true);
  }
});
