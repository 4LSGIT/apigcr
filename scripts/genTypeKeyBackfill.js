#!/usr/bin/env node
// scripts/genTypeKeyBackfill.js
//
/**
 * U2 GENERATOR — the migration's two GENERATED blocks come from code, not hands.
 *
 *   block 'seed'      calendar_item_types rows            ← scripts/calendarTypeSeed.js
 *   block 'backfill'  events/appts.type_key UPDATEs        ← scripts/typeKeyVocabulary.js
 *                     + the five E0b kind statements       ← embedded verbatim (asserted
 *                                                            against ref/2026-09-01_unified_events_e0b.sql)
 *
 * WHY GENERATED. E1 derives type_key at read time from
 * scripts/typeKeyVocabulary.js (E1's vocabulary, frozen and moved there at U3).
 * U2 fills the column those reads will be swapped to (U3). If the two ever
 * disagreed, every row would silently change key the day U3 landed. So the
 * backfill is EMITTED from E1's exports, and tests/genTypeKeyBackfill.test.js
 * regenerates and asserts byte-equality with the committed blocks — the
 * migration cannot drift from the vocabulary.
 *
 * RAWS ARE E1's NORMALIZED LOOKUP KEYS (Fred, U2 R3). The Maps are keyed
 * trim+lowercase, so the emitted IN-lists are lowercase ('confirmation
 * hearing'). events.event_type / appts.appt_type are utf8mb4_general_ci, so
 * the match hits every live spelling variant ('Confirmation Hearing',
 * 'Pre-filing Meeting', 'Pre-Filing Meeting', 'Meeting', 'meeting', …).
 * Readability loses; the source of truth wins.
 *
 * USAGE
 *   node scripts/genTypeKeyBackfill.js            print both blocks to stdout
 *   node scripts/genTypeKeyBackfill.js --write    rewrite the blocks in the
 *                                                 migration IN PLACE (between
 *                                                 the markers) and write the
 *                                                 seed fixture JSON
 *
 * The migration file must already contain the marker pairs:
 *   -- BEGIN GENERATED seed (scripts/genTypeKeyBackfill.js)
 *   -- END GENERATED seed
 *   -- BEGIN GENERATED backfill (scripts/genTypeKeyBackfill.js)
 *   -- END GENERATED backfill
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT           = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'ref', '2026-09-01_unified_events_u2.sql');
const E0B_PATH       = path.join(ROOT, 'ref', '2026-09-01_unified_events_e0b.sql');
const FIXTURE_PATH   = path.join(ROOT, 'tests', 'fixtures', 'calendar_item_types.seed.json');

const { SEED, COLUMNS, seedRows } = require('./calendarTypeSeed');
// U3: the vocabulary moved OUT of services/caseEventService.js into a frozen,
// generator-only module. The service now reads the `type_key` COLUMN and imports
// nothing from here. Same Maps, same iteration order, so this file's output is
// byte-identical to what it emitted at U2 — asserted by
// tests/genTypeKeyBackfill.test.js against the committed migration.
const vocabulary                  = require('./typeKeyVocabulary');

// ─────────────────────────────────────────────────────────────────────────────
// SQL literal helpers
// ─────────────────────────────────────────────────────────────────────────────

function sqlStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}
function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return sqlStr(JSON.stringify(v));
  return sqlStr(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Block 1 — seed
// ─────────────────────────────────────────────────────────────────────────────

function generateSeedSql() {
  const lines = [];
  lines.push('-- calendar_item_types seed — ONE statement, re-runnable. The row-alias form of');
  lines.push('-- ON DUPLICATE KEY UPDATE (MySQL ≥ 8.0.19; VALUES() in ODKU is deprecated) touches');
  lines.push('-- ONLY label on re-run, so live edits to the policy columns are never overwritten.');
  lines.push(`-- ${SEED.length} rows. Source: scripts/calendarTypeSeed.js.`);
  lines.push(`INSERT INTO calendar_item_types`);
  lines.push(`  (${COLUMNS.join(', ')})`);
  lines.push(`VALUES`);
  SEED.forEach((row, i) => {
    const vals = row.map(sqlVal).join(', ');
    lines.push(`  (${vals})${i === SEED.length - 1 ? '' : ','}`);
  });
  lines.push(`AS new`);
  lines.push(`ON DUPLICATE KEY UPDATE label = new.label;`);
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// Block 2 — backfill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw event_type per overridden row id. typeKeyVocabulary.EVENT_ROW_OVERRIDES
 * carries [key, kind] only; the guard clause `AND event_type = '…'` needs the
 * live string (verified 2026-09-01). Every id in that map MUST appear here —
 * generate() throws otherwise, so a new override cannot ship without its guard.
 */
const OVERRIDE_RAW_TYPE = {
  4:   'Milestone',
  6:   'Deadline',
  107: 'Order',
  134: 'Trial / Pre-Trial Hearing',
};

/**
 * The five bulk `kind` statements from U1/E0b, VERBATIM. Re-run here for rows
 * created between the E0b apply and the U2 backend deploy (write paths do not
 * set kind until U2). tests/genTypeKeyBackfill.test.js asserts each statement
 * appears byte-for-byte in ref/2026-09-01_unified_events_e0b.sql.
 */
const E0B_KIND_STATEMENTS = [
`UPDATE events SET kind = 'hearing'
 WHERE kind IS NULL
   AND event_type IN ('Confirmation Hearing','confirmation_hearing','Hearing',
                      'Show Cause','Show Cause Hearing','Trial','Trial / Pre-Trial Hearing');`,
`UPDATE events SET kind = 'conference'
 WHERE kind IS NULL
   AND event_type IN ('Telephonic Status Conference','Status Conference',
                      'Initial Scheduling Conference','Pre-trial Conference','Deposition');`,
`UPDATE events SET kind = 'meeting'
 WHERE kind IS NULL
   AND event_type = '341';`,
`UPDATE events SET kind = 'deadline'
 WHERE kind IS NULL
   AND event_type IN ('dischargeability_due','object_confirmation_due','poc_due','poc_gov_due',
                      'Docs Deadline','Schedules Deadline','Confirmation Certificate Deadline',
                      'Filing Fee Deadline','Filing Fee Installment Deadline','Deadline');`,
`UPDATE events SET kind = 'other'
 WHERE kind IS NULL
   AND event_type IN ('Order','Milestone');`,
];

/** Map<normalizedRaw,[key,kind]> → Map<key, rawList[]> preserving first-seen key order. */
function groupByKey(vocab, { skip = new Set() } = {}) {
  const groups = new Map();
  for (const [raw, [key]] of vocab.entries()) {
    if (skip.has(raw)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(raw);
  }
  return groups;
}

function updateStmt(table, col, key, raws) {
  const list = raws.map(sqlStr).join(', ');
  const pred = raws.length === 1 ? `${col} = ${list}` : `${col} IN (${list})`;
  return `UPDATE ${table} SET type_key = ${sqlStr(key)} WHERE type_key IS NULL AND ${pred};`;
}

function generateBackfillSql() {
  const seedKeys = new Set(SEED.map((r) => r[0]));
  const out = [];

  out.push('-- Raws below are caseEventService (E1) NORMALIZED lookup keys — trim+lowercase.');
  out.push('-- events.event_type / appts.appt_type are utf8mb4_general_ci, so each IN-list matches');
  out.push('-- every live spelling variant of that type. Every statement is guarded by');
  out.push('-- `type_key IS NULL` and is therefore idempotent; re-run the whole block after the');
  out.push('-- backend deploy to catch rows created in between.');
  out.push('');

  // ── events: bulk by key ──
  out.push('-- events.type_key by event_type  (caseEventService._EVENT_TYPE_KEYS)');
  const evGroups = groupByKey(vocabulary.EVENT_TYPE_KEYS);
  for (const [key, raws] of evGroups) {
    if (!seedKeys.has(key)) throw new Error(`E1 event key '${key}' is not in the seed — add it to scripts/calendarTypeSeed.js`);
    out.push(updateStmt('events', 'event_type', key, raws));
  }
  out.push('');

  // ── events: row overrides by id (E1's _EVENT_ROW_OVERRIDES, NOT guarded by IS NULL —
  //    they must win over the bulk statement above; re-run writes the same value) ──
  out.push('-- events row overrides by id  (caseEventService._EVENT_ROW_OVERRIDES; unguarded so');
  out.push('-- they win over the bulk statements — a re-run writes the same value)');
  const ids = [...vocabulary.EVENT_ROW_OVERRIDES.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const [key] = vocabulary.EVENT_ROW_OVERRIDES.get(id);
    const rawType = OVERRIDE_RAW_TYPE[id];
    if (!rawType) throw new Error(`E1 row override for event ${id} has no raw type in OVERRIDE_RAW_TYPE (scripts/genTypeKeyBackfill.js)`);
    if (!seedKeys.has(key)) throw new Error(`E1 override key '${key}' is not in the seed`);
    out.push(`UPDATE events SET type_key = ${sqlStr(key)} WHERE event_id = ${id} AND event_type = ${sqlStr(rawType)};`);
  }
  out.push('');

  // ── appts: bulk by key; 'none' (the literal string, 0 live rows) is skipped —
  //    SQL NULL rows are left type_key NULL by design (v0.5 §8.1) ──
  out.push("-- appts.type_key by appt_type  (caseEventService._APPT_TYPE_KEYS; the literal 'None'");
  out.push('-- entry is skipped — 0 live rows — and appt_type IS NULL rows stay type_key NULL by');
  out.push('-- ruling, v0.5 §8.1)');
  const apGroups = groupByKey(vocabulary.APPT_TYPE_KEYS, { skip: new Set(['none']) });
  for (const [key, raws] of apGroups) {
    if (!seedKeys.has(key)) throw new Error(`E1 appt key '${key}' is not in the seed — add it to scripts/calendarTypeSeed.js`);
    out.push(updateStmt('appts', 'appt_type', key, raws));
  }
  out.push('');

  // ── E0b kind statements, verbatim ──
  out.push('-- events.kind for rows created between the E0b apply and the U2 backend deploy —');
  out.push('-- the five U1/E0b bulk statements VERBATIM (ref/2026-09-01_unified_events_e0b.sql)');
  for (const s of E0B_KIND_STATEMENTS) {
    out.push(s);
    out.push('');
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Marker splice
// ─────────────────────────────────────────────────────────────────────────────

function markers(name) {
  return {
    begin: `-- BEGIN GENERATED ${name} (scripts/genTypeKeyBackfill.js)`,
    end:   `-- END GENERATED ${name}`,
  };
}

/** The text currently between a block's markers in `sql` (exclusive), or null. */
function extractBlock(sql, name) {
  const { begin, end } = markers(name);
  const b = sql.indexOf(begin);
  const e = sql.indexOf(end);
  if (b === -1 || e === -1 || e < b) return null;
  return sql.slice(b + begin.length + 1, e);   // +1 skips the newline after BEGIN
}

function spliceBlock(sql, name, body) {
  const { begin, end } = markers(name);
  const b = sql.indexOf(begin);
  const e = sql.indexOf(end);
  if (b === -1 || e === -1 || e < b) throw new Error(`markers for block '${name}' not found in ${MIGRATION_PATH}`);
  return sql.slice(0, b + begin.length + 1) + body + sql.slice(e);
}

function generate() {
  return { seed: generateSeedSql(), backfill: generateBackfillSql() };
}

function writeAll() {
  const gen = generate();
  let sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  sql = spliceBlock(sql, 'seed', gen.seed);
  sql = spliceBlock(sql, 'backfill', gen.backfill);
  fs.writeFileSync(MIGRATION_PATH, sql);
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, JSON.stringify(seedRows(), null, 2) + '\n');
  return { migration: MIGRATION_PATH, fixture: FIXTURE_PATH };
}

module.exports = {
  generate,
  generateSeedSql,
  generateBackfillSql,
  extractBlock,
  spliceBlock,
  writeAll,
  E0B_KIND_STATEMENTS,
  OVERRIDE_RAW_TYPE,
  MIGRATION_PATH,
  E0B_PATH,
  FIXTURE_PATH,
};

if (require.main === module) {
  if (process.argv.includes('--write')) {
    const r = writeAll();
    console.log(`wrote ${path.relative(ROOT, r.migration)} and ${path.relative(ROOT, r.fixture)}`);
  } else {
    const gen = generate();
    process.stdout.write(`${markers('seed').begin}\n${gen.seed}${markers('seed').end}\n\n`);
    process.stdout.write(`${markers('backfill').begin}\n${gen.backfill}${markers('backfill').end}\n`);
  }
}
