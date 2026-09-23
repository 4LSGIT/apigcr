// scripts/verifyTrusteeReadthrough.js
//
/**
 * Trustee roster sanity check — READ-ONLY.
 *
 * HISTORY: through slice 7A this script deep-diffed lib/trusteeRoster's
 * output against the fe-trustees app_setting (the cutover confidence gate).
 * Slice 7B / m6 (2026-09-23) deleted that setting and dropped the trustees /
 * judges tables, so the setting side of the diff no longer exists. Rewritten
 * (same slice) as a loader-vs-contact_roles check: it re-derives the expected
 * roster from an INDEPENDENT query over contact_roles × contacts and diffs
 * lib/trusteeRoster.loadTrusteeRoster's output against it, entry by entry.
 *
 * WHAT IT CATCHES
 *   - a loader regression (SQL, field mapping, chapter explosion, ordering)
 *     against the raw tables every consumer ultimately depends on;
 *   - structural data problems: a trustee role with no chapters (matches
 *     EVERY chapter per trusteeMatch rule 0 — usually a data-entry miss),
 *     a missing 341 zoom_link, a role row whose contact join is broken.
 *
 * Chapterless roles and missing links print as WARN (they are legal states
 * the loader handles by design); any mapping/count/order mismatch prints
 * MISMATCH and the script exits 1.
 *
 * USAGE:  node scripts/verifyTrusteeReadthrough.js
 * Writes nothing. Exit 0 = loader agrees with the tables; 1 = look.
 */

'use strict';

const s = (v) => String(v == null ? '' : v);

/** attrs JSON column → object (mysql2 usually pre-parses; normalize). */
function attrsOf(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch (_) { return {}; }
}

/** attrs.chapter → array of scalar chapters ([null] when absent). Kept as an
 *  INDEPENDENT transcription — do not import lib/trusteeRoster's _chapters,
 *  or the check proves the loader against itself. */
function chaptersOf(attrsVal) {
  const ch = attrsOf(attrsVal).chapter;
  if (ch == null || ch === '') return [null];
  return Array.isArray(ch) ? (ch.length ? ch : [null]) : [ch];
}

/** Expected legacy-shaped entry from a raw row + one chapter — the SOURCE
 *  MAPPING from lib/trusteeRoster's header, transcribed independently. */
function expectedEntry(row, chapter) {
  const attrs = attrsOf(row.attrs);
  return {
    name:       s(row.contact_name),
    lname:      s(row.contact_lname),
    case_type:  chapter == null ? null : chapter,
    link:       s(attrs.zoom_link),
    email:      s(row.contact_email),
    phone:      s(row.contact_phone),
    address1:   s(row.contact_address),
    address2:   '',
    city:       s(row.contact_city),
    state:      s(row.contact_state),
    zip:        s(row.contact_zip),
    contact_id: row.contact_id,
  };
}

async function main(db) {
  const { loadTrusteeRoster } = require('../lib/trusteeRoster');

  // Independent read: same tables, deliberately its own SQL text.
  const [rawRows] = await db.query(
    `SELECT cr.contact_id, cr.attrs, cr.active,
            c.contact_name, c.contact_lname, c.contact_email, c.contact_phone,
            c.contact_address, c.contact_city, c.contact_state, c.contact_zip
       FROM contact_roles cr
       LEFT JOIN contacts c ON c.contact_id = cr.contact_id
      WHERE cr.role = 'trustee'`
  );
  const activeRows = rawRows.filter((r) => Number(r.active) === 1);

  const built = await loadTrusteeRoster(db);

  console.log(`\n=== verifyTrusteeReadthrough — READ-ONLY ===`);
  console.log(`contact_roles role='trustee': ${rawRows.length} row(s), ${activeRows.length} active`);
  console.log(`built entries:                ${built.length} (chapters exploded)\n`);

  let mismatch = 0;
  let warns = 0;

  // Expected entries from the independent read, in the loader's documented
  // order: name (ci), then numeric case_type, then contact_id.
  const expected = [];
  for (const row of activeRows) {
    if (row.contact_name == null) {
      console.log(`MISMATCH  contact_roles.contact_id=${row.contact_id} has NO contacts row (broken join)`);
      mismatch++;
      continue;
    }
    const chs = chaptersOf(row.attrs);
    if (chs.length === 1 && chs[0] == null) {
      console.log(`WARN      ${row.contact_id} '${s(row.contact_name)}' — no chapters on the role card (matches EVERY chapter per rule 0)`);
      warns++;
    }
    if (!s(attrsOf(row.attrs).zoom_link).trim()) {
      console.log(`WARN      ${row.contact_id} '${s(row.contact_name)}' — no 341 zoom_link on the role card`);
      warns++;
    }
    for (const ch of chs) expected.push(expectedEntry(row, ch));
  }
  expected.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    (Number(a.case_type) || 0) - (Number(b.case_type) || 0) ||
    (a.contact_id || 0) - (b.contact_id || 0));

  if (expected.length !== built.length) {
    console.log(`MISMATCH  entry count: expected ${expected.length} from the tables, loader built ${built.length}`);
    mismatch++;
  }

  const key = (e) => `${e.contact_id}|${e.case_type}`;
  const builtBy = new Map(built.map((e) => [key(e), e]));
  if (builtBy.size !== built.length) {
    console.log(`MISMATCH  loader emitted duplicate (contact_id, case_type) keys`);
    mismatch++;
  }

  for (const ee of expected) {
    const be = builtBy.get(key(ee));
    if (!be) {
      console.log(`MISMATCH  ${key(ee)} '${ee.name}' — expected from the tables, absent from the loader`);
      mismatch++;
      continue;
    }
    for (const f of Object.keys(ee)) {
      if (String(ee[f] ?? '') !== String(be[f] ?? '')) {
        console.log(`MISMATCH  ${key(ee)} '${ee.name}' field ${f}: tables=${JSON.stringify(ee[f])}  loader=${JSON.stringify(be[f])}`);
        mismatch++;
      }
    }
  }
  const expectedBy = new Set(expected.map(key));
  for (const be of built) {
    if (!expectedBy.has(key(be))) {
      console.log(`MISMATCH  ${key(be)} '${be.name}' — loader entry with no matching active role row`);
      mismatch++;
    }
  }

  // Order check — position-by-position on the keys.
  const orderOff = built.findIndex((be, i) => expected[i] && key(expected[i]) !== key(be));
  if (mismatch === 0 && orderOff !== -1) {
    console.log(`MISMATCH  ordering diverges at position ${orderOff} (expected ${key(expected[orderOff])}, got ${key(built[orderOff])})`);
    mismatch++;
  }

  console.log(`\n── summary ──`);
  console.log(`  WARN       ${warns}`);
  console.log(`  MISMATCH   ${mismatch}`);
  console.log(mismatch === 0
    ? `\nCLEAN — the loader agrees with contact_roles × contacts.\n`
    : `\nNOT CLEAN — resolve the MISMATCH lines (loader regression or broken role data).\n`);
  return mismatch;
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then((n) => process.exit(n === 0 ? 0 : 1))
    .catch((err) => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = { main, _chaptersOf: chaptersOf, _expectedEntry: expectedEntry };
