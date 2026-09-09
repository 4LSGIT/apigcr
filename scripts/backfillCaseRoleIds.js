// scripts/backfillCaseRoleIds.js
//
/**
 * Backfill cases.case_judge_contact_id / case_trustee_contact_id (slice 6).
 *
 * Resolves BOTH twins for every case using lib/caseRoleResolver — the SAME
 * helper the live write paths use (caseService.updateCase, courtExecutor), so
 * the backfill and live resolution cannot disagree. No matching logic lives
 * in this file.
 *
 * EXPECTED unresolved rows (correct behavior, not bugs to fix):
 *   - garbage docket suffixes (abc, aaa, '00546 (jlr)') with no matching
 *     judge name → judge twin stays NULL
 *   - trustee strings that predate the roster, or roster entries whose
 *     contact_id has not been added yet (run scripts/seedRoleContacts.js
 *     --apply and paste the emitted JSON into settings first)
 *
 * Writes only rows whose twin VALUE would change; safe to re-run.
 *
 * USAGE:
 *   node scripts/backfillCaseRoleIds.js               # dry-run (default)
 *   node scripts/backfillCaseRoleIds.js --dry-run     # same
 *   node scripts/backfillCaseRoleIds.js --apply       # execute
 *
 * Dry-run prints per-case resolution plus a summary table: resolved by
 * suffix / by name (exact / relaxed), trustee match methods, and the
 * unresolved strings listed verbatim.
 */

'use strict';

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

function pad(s, n) { return String(s == null ? '' : s).padEnd(n); }

async function main(db) {
  const resolver = require('../lib/caseRoleResolver');
  const { getSetting } = require('../services/settingsService');

  console.log(`\n=== backfillCaseRoleIds — ${DRY ? 'DRY-RUN (no writes)' : 'APPLY'} ===\n`);

  // Roster loaded ONCE and injected — the resolver would otherwise read
  // app_settings per case.
  let roster = null;
  try {
    const raw = await getSetting(db, 'fe-trustees');
    roster = raw == null ? null : JSON.parse(raw);
  } catch (e) {
    console.warn(`fe-trustees unreadable (${e.message}) — every trustee resolves NULL`);
  }
  const rosterHasIds = Array.isArray(roster)
    && roster.some(e => e && Number.isInteger(parseInt(e.contact_id, 10)));
  if (!rosterHasIds) {
    console.warn('WARNING: no roster entry carries a contact_id yet — trustee twins will all '
      + 'resolve NULL. Run seedRoleContacts.js --apply and paste its JSON into settings first.\n');
  }

  const [rows] = await db.query(
    `SELECT case_id, case_number_full, case_judge, case_trustee, case_chapter,
            case_judge_contact_id, case_trustee_contact_id
       FROM cases`
  );
  console.log(`${rows.length} case rows.\n`);
  console.log(pad('case_id', 10) + pad('docket', 16) + pad('judge text', 22)
    + pad('→judge', 14) + pad('trustee text', 26) + '→trustee');

  const sum = {
    judge: { suffix: 0, name_exact: 0, name_relaxed: 0, unresolved: 0, blank: 0, writes: 0 },
    trustee: { exact: 0, lname: 0, unresolved: 0, blank: 0, no_contact_id: 0, writes: 0 },
    unresolvedJudgeStrings: new Map(),   // string → count
    unresolvedTrusteeStrings: new Map(),
  };
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

  for (const c of rows) {
    const j = await resolver.resolveJudgeDetailed(db, {
      case_number_full: c.case_number_full, case_judge: c.case_judge,
    });
    const t = await resolver.resolveTrusteeDetailed(db, {
      case_trustee: c.case_trustee, case_chapter: c.case_chapter,
    }, { roster });

    // ── judge tally ──
    const judgeBlank = !String(c.case_judge || '').trim() && !String(c.case_number_full || '').trim();
    if (judgeBlank) sum.judge.blank++;
    else if (j.method) sum.judge[j.method]++;
    else {
      sum.judge.unresolved++;
      bump(sum.unresolvedJudgeStrings,
        `judge='${c.case_judge || ''}' docket='${c.case_number_full || ''}'`);
    }

    // ── trustee tally ──
    if (t.status === 'no_trustee') sum.trustee.blank++;
    else if (t.status === 'matched') sum.trustee[t.method === 'exact' ? 'exact' : 'lname']++;
    else {
      if (t.status === 'entry_no_contact_id') sum.trustee.no_contact_id++;
      sum.trustee.unresolved++;
      bump(sum.unresolvedTrusteeStrings, `'${c.case_trustee}' (${t.status}, ch ${c.case_chapter ?? '?'})`);
    }

    const judgeChanged = (c.case_judge_contact_id ?? null) !== j.contact_id;
    const trusteeChanged = (c.case_trustee_contact_id ?? null) !== t.contact_id;
    if (judgeChanged) sum.judge.writes++;
    if (trusteeChanged) sum.trustee.writes++;

    // Per-case line only when there is anything to say (skip fully-blank rows).
    if (!judgeBlank || t.status !== 'no_trustee') {
      console.log(pad(c.case_id, 10) + pad(c.case_number_full || '', 16)
        + pad(c.case_judge || '', 22)
        + pad(j.contact_id != null ? `${j.contact_id} (${j.method})` : '—', 14)
        + pad(c.case_trustee || '', 26)
        + (t.contact_id != null ? `${t.contact_id} (${t.method})` : `— (${t.status})`)
        + ((judgeChanged || trusteeChanged) ? '' : '  [no change]'));
    }

    if (APPLY && (judgeChanged || trusteeChanged)) {
      await db.query(
        'UPDATE cases SET case_judge_contact_id = ?, case_trustee_contact_id = ? WHERE case_id = ?',
        [j.contact_id, t.contact_id, c.case_id]
      );
    }
  }

  // ── summary table ──
  console.log('\n── Summary ──');
  console.log('JUDGE   : '
    + `suffix ${sum.judge.suffix}, name-exact ${sum.judge.name_exact}, `
    + `name-relaxed ${sum.judge.name_relaxed}, unresolved ${sum.judge.unresolved}, `
    + `blank ${sum.judge.blank} — ${sum.judge.writes} row(s) ${DRY ? 'would ' : ''}change`);
  console.log('TRUSTEE : '
    + `exact ${sum.trustee.exact}, lname ${sum.trustee.lname}, `
    + `unresolved ${sum.trustee.unresolved} (of which entry-without-contact_id ${sum.trustee.no_contact_id}), `
    + `blank ${sum.trustee.blank} — ${sum.trustee.writes} row(s) ${DRY ? 'would ' : ''}change`);

  if (sum.unresolvedJudgeStrings.size) {
    console.log('\nUnresolved JUDGE strings (expected for garbage suffixes with no name match):');
    for (const [s, n] of sum.unresolvedJudgeStrings) console.log(`  ${n}× ${s}`);
  }
  if (sum.unresolvedTrusteeStrings.size) {
    console.log('\nUnresolved TRUSTEE strings (expected for pre-roster values):');
    for (const [s, n] of sum.unresolvedTrusteeStrings) console.log(`  ${n}× ${s}`);
  }
  console.log('');
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then(() => process.exit(0))
    .catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = { main };
