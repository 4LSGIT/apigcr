// scripts/customFieldsS5Seed.js
//
/**
 * Custom Fields S5-A — create the two PILOT field definitions.
 *
 * The first two rows the `field_defs` registry ever holds in production. They
 * are the destination of the Clio-ref migration (ref/CUSTOM_FIELDS_DESIGN.md
 * §7 S5): `cases.clio_matter` → `cf_clio_matter`, `contacts.contact_clio_id`
 * → `cf_clio_id`. The `cf_` prefix is not a style choice — `^cf_` and the
 * information_schema collision check both reject the original names, which is
 * why S5 repoints consumers instead of keeping them (ruled 2026-09-24).
 *
 * WHY A SCRIPT AND NOT AN INSERT: `fieldDefService.createDef` gives the rows
 * validation (key shape, label, type, column-collision), an `admin_audit_log`
 * entry, and — the load-bearing part — `scheduleReconcile`, which ADDs the
 * VIRTUAL generated column each def needs before anything can read or query
 * it. A raw INSERT gets none of that and leaves the registry and the table
 * out of step.
 *
 * ORDER IS ABSOLUTE — this script runs FIRST, before the backfill migration
 * and before the backend deploy:
 *
 *   1. node scripts/customFieldsS5Seed.js --apply     ← this file
 *   2. verify both virtual columns exist (printed below, or --verify)
 *   3. ref/migrations/2026-09-25_clio_pilot_backfill.sql
 *   4. backend deploy (write freeze + repointed reads)
 *   5. repoint wf37 (scripts/customFieldsS5Wf37Repoint.js)
 *
 * Step 3 writes `custom` keys the virtual columns read, so it cannot run
 * before step 2; step 4's `lookup_contact` SELECTs `cf_clio_id` by name (it
 * degrades with a warning if the column is missing, but that is a safety net,
 * not the plan).
 *
 * BOTH FIELDS ARE `text`. The values are short Clio numeric ids (longest live
 * value: 10 characters, cap 255), and `text` is the type the Clio ids have
 * always had — `cases.clio_matter` and `contacts.contact_clio_id` are both
 * varchar(20). Do NOT "improve" this to `number`: §3 locks `field_type` the
 * moment a record holds a value, and a Clio id is an opaque identifier, not a
 * quantity (leading zeros, arithmetic, and `'100' < '9'` all argue the same
 * way the docket-number rule does).
 *
 * IDEMPOTENT: an existing def on (entity, field_key) is reported and skipped,
 * so a re-run after a partial failure is safe. createDef's own 409 is the
 * backstop if two runs race.
 *
 * USAGE:
 *   node scripts/customFieldsS5Seed.js             # dry-run (default)
 *   node scripts/customFieldsS5Seed.js --apply     # create the defs
 *   node scripts/customFieldsS5Seed.js --verify    # report state, create nothing
 */

'use strict';

const APPLY  = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const DRY    = !APPLY && !VERIFY;

/**
 * The two pilot defs. `sort_order` puts them first in a section that holds
 * nothing else yet; `options`/`validation`/`show_when` are deliberately empty
 * — a required flag on a field 78% of records leave blank would block saves
 * (§3: required is a renderer rule, and it would fire on every such record).
 */
const PILOT_DEFS = [
  {
    entity:     'case',
    field_key:  'cf_clio_matter',
    label:      'Clio Matter ID',
    field_type: 'text',
    sort_order: 10,
    _from:      'cases.clio_matter',
  },
  {
    entity:     'contact',
    field_key:  'cf_clio_id',
    label:      'Clio Contact ID',
    field_type: 'text',
    sort_order: 10,
    _from:      'contacts.contact_clio_id',
  },
];

/** Entity → table, mirroring fieldDefService.ENTITY_TABLES. */
const TABLES = { case: 'cases', contact: 'contacts' };

/** information_schema truth for one def's virtual column. */
async function columnState(db, def) {
  const [[row]] = await db.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLES[def.entity], def.field_key]
  );
  return row || null;
}

async function main(db) {
  const fieldDefs   = require('../services/fieldDefService');
  const reconciler  = require('../services/fieldDefReconciler');

  console.log(`Custom Fields S5-A def seed — ${VERIFY ? 'VERIFY' : DRY ? 'DRY RUN' : 'APPLY'}\n`);

  // ── 1. base assertion: what the registry holds right now ──
  const [existing] = await db.query(
    'SELECT id, entity, field_key, label, field_type, active FROM field_defs ORDER BY id'
  );
  console.log(`field_defs currently holds ${existing.length} row(s)` +
    (existing.length ? ':' : ' (empty — as expected before S5).'));
  for (const r of existing) {
    console.log(`  #${r.id} ${r.entity}.${r.field_key} "${r.label}" ${r.field_type} active=${r.active}`);
  }
  console.log('');

  // ── 2. create (or report) each def ──
  const created = [];
  for (const def of PILOT_DEFS) {
    const prior = existing.find(r => r.entity === def.entity && r.field_key === def.field_key);
    if (prior) {
      console.log(`SKIP  ${def.entity}.${def.field_key} — already exists (#${prior.id}, ` +
        `"${prior.label}", ${prior.field_type}, active=${prior.active})`);
      if (prior.field_type !== def.field_type) {
        console.log(`  ⚠ field_type is "${prior.field_type}", expected "${def.field_type}" — ` +
          `§3 locks the type once data exists. STOP and reconcile by hand.`);
      }
      continue;
    }
    if (VERIFY || DRY) {
      console.log(`WOULD CREATE  ${def.entity}.${def.field_key} "${def.label}" ` +
        `(${def.field_type}, sort_order ${def.sort_order}) ← ${def._from}`);
      continue;
    }
    const { _from, ...body } = def;
    const out = await fieldDefs.createDef(db, body, { actor: 0 });
    console.log(`CREATED  #${out.id} ${out.entity}.${out.field_key} ← ${_from}`);
    created.push(out);
  }

  // ── 3. reconcile, then PROVE the virtual columns exist ──
  //
  // createDef fires scheduleReconcile itself, but that is fire-and-forget and
  // coalesced: a short-lived script can exit before it lands. Await one
  // explicitly, then read information_schema — the reconciler never throws
  // (failures become system_alerts), so its return value is not the check.
  if (APPLY && created.length) {
    console.log('\nReconciling (awaited — createDef\'s own schedule is fire-and-forget)…');
    const res = await reconciler.reconcile(db, { trigger: 'manual', actor: 0 });
    console.log(`  reconcile: ${JSON.stringify(res)}`);
  }

  console.log('\nVirtual-column state (information_schema — the authority):');
  let allPresent = true;
  for (const def of PILOT_DEFS) {
    const col = await columnState(db, def);
    if (!col) {
      allPresent = false;
      console.log(`  ✗ ${TABLES[def.entity]}.${def.field_key} — ABSENT`);
      continue;
    }
    const ok = col.EXTRA === 'VIRTUAL GENERATED';
    if (!ok) allPresent = false;
    console.log(`  ${ok ? '✓' : '✗'} ${TABLES[def.entity]}.${def.field_key} ` +
      `${col.COLUMN_TYPE} EXTRA="${col.EXTRA}"`);
    console.log(`      ${col.GENERATION_EXPRESSION}`);
  }

  // ── 4. the gate ──
  if (DRY) {
    console.log('\n(dry-run: nothing written. Re-run with --apply.)');
    return;
  }
  if (!allPresent) {
    if (VERIFY) {
      console.log('\nNOT READY — a virtual column is missing. Run --apply, or check ' +
        'system_alerts for field_defs_reconcile_failed / _lock_busy / _conflict.');
      return;
    }
    throw new Error(
      'a pilot virtual column is missing after reconcile — check system_alerts ' +
      '(field_defs_reconcile_failed / _lock_busy / _conflict). DO NOT run the backfill migration.'
    );
  }
  console.log('\nBoth virtual columns present. Next: ref/migrations/2026-09-25_clio_pilot_backfill.sql');
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then(() => process.exit(0))
    .catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = { PILOT_DEFS, TABLES, main };
