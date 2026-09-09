// scripts/verifyTrusteeReadthrough.js
//
/**
 * Slice 7 cutover confidence gate — READ-ONLY.
 *
 * Loads the LIVE fe-trustees setting value AND builds the roster from
 * contacts + contact_roles (lib/trusteeRoster — the exact code every 7A
 * consumer reads through), then deep-diffs entry-by-entry, keyed on
 * (contact_id, case_type).
 *
 * Fred runs this BEFORE deploying 7A. Expected output: every diff classified
 * KNOWN-DELIBERATE, zero UNEXPECTED. The deliberate classes (verified live
 * 2026-09-09; see lib/trusteeRoster.js header):
 *
 *   phone-format   setting '(313) 962-6400' vs contacts '3139626400' —
 *                  same digits; esign formats digits back to the setting
 *                  form, so trustee.phone tokens are byte-identical.
 *   address-recombine  the seed joined address1 + ', ' + address2 into
 *                  contacts.contact_address; the builder serves that as
 *                  address1 with address2 ''. Deliberate iff the joined
 *                  setting value equals the built address1 — then esign's
 *                  trustee.address_street (which joins a1/a2 with ', ')
 *                  renders byte-identical.
 *   email-case     createContact lowercased the address. Cosmetic.
 *   name-drift     contact_name is the name source now. The two known
 *                  drifts: 'Caouette, Melissa A.' → 'Melissa A. Caouette';
 *                  'Thomas W. Jr. McDonald' → 'Thomas W. McDonald' (merged
 *                  pair). ZERO live cases carry either old spelling
 *                  (verified against every distinct cases.case_trustee), so
 *                  these list as KNOWN-DELIBERATE but are still printed
 *                  loudly — eyeball them.
 *
 * Anything else prints UNEXPECTED and the script exits 1. After m6 runs,
 * the deactivated 'Trustee Namee' shows as setting-only — that is the m6
 * delta, reported as such.
 *
 * Also proves the consumer-derived values: for every matched pair it
 * recomputes the four esign trustee.* projections (name, address_street,
 * address_csz, phone-formatted) from BOTH sides and diffs those — the
 * token-level equivalence that actually lands on documents.
 *
 * USAGE:  node scripts/verifyTrusteeReadthrough.js
 * Writes nothing. Exit 0 = clean (only known-deliberate diffs); 1 = look.
 */

'use strict';

const KNOWN_NAME_DRIFT = {
  // old setting name → expected contact_name (verified live 2026-09-09)
  'Caouette, Melissa A.': 'Melissa A. Caouette',
  'Thomas W. Jr. McDonald': 'Thomas W. McDonald',
};

const FIELDS = ['name', 'lname', 'case_type', 'link', 'email', 'phone',
                'address1', 'address2', 'city', 'state', 'zip'];

const s = (v) => String(v == null ? '' : v);
const digits = (v) => s(v).replace(/\D/g, '');
const joinAddr = (a1, a2) => {
  const x = s(a1).trim(); const y = s(a2).trim();
  return x ? (y ? `${x}, ${y}` : x) : y;
};
// esign projections, transcribed from esignPrefillService (kept tiny and
// local — this script must not import a service that mocks poorly in ops).
const fmtPhone = (raw) => {
  const d = digits(raw);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : s(raw).trim();
};
const csz = (e) => {
  const city = s(e.city).trim(), st = s(e.state).trim(), zip = s(e.zip).trim();
  let head = city && st ? `${city}, ${st}` : (city || st);
  if (!head) return zip;
  return zip ? `${head} ${zip}` : head;
};

function classify(field, sv, bv) {
  // address1/address2 are classified PAIRWISE by the caller (addrEquiv) —
  // by the time this runs, an address diff is not the known recombination.
  if (field === 'phone' && digits(sv) === digits(bv)) return 'phone-format';
  if (field === 'email' && s(sv).toLowerCase() === s(bv).toLowerCase()) return 'email-case';
  if (field === 'name' && KNOWN_NAME_DRIFT[s(sv).trim()] === s(bv).trim()) return 'name-drift';
  return 'UNEXPECTED';
}

async function main(db) {
  const { loadTrusteeRoster } = require('../lib/trusteeRoster');
  const { getSetting } = require('../services/settingsService');

  const raw = await getSetting(db, 'fe-trustees');
  let setting = [];
  let settingState = 'ok';
  if (raw == null) settingState = 'missing (m6 already ran?)';
  else {
    try { setting = JSON.parse(raw); } catch (e) { settingState = `unparseable: ${e.message}`; }
    if (!Array.isArray(setting)) { setting = []; settingState = 'not an array'; }
  }

  const built = await loadTrusteeRoster(db);

  console.log(`\n=== verifyTrusteeReadthrough — READ-ONLY ===`);
  console.log(`setting entries: ${setting.length} (${settingState})`);
  console.log(`built entries:   ${built.length} (contact_roles role='trustee' active=1, chapters exploded)\n`);

  const key = (e) => `${e.contact_id}|${e.case_type}`;
  const builtBy = new Map(built.map((e) => [key(e), e]));
  const settingBy = new Map(setting.map((e) => [key(e), e]));

  let unexpected = 0;
  const counts = {};

  for (const se of setting) {
    const be = builtBy.get(key(se));
    if (!be) {
      console.log(`SETTING-ONLY  ${key(se)}  '${se.name}'` +
        `  (deliberate iff this is the m6 Namee deactivation)`);
      unexpected += s(se.name).trim() === 'Trustee Namee' ? 0 : 1;
      continue;
    }
    const diffs = [];
    // address recombination is a PAIR property — check it once per entry
    const addrEquiv = joinAddr(se.address1, se.address2) === s(be.address1).trim() && s(be.address2) === '';
    for (const f of FIELDS) {
      const sv = se[f]; const bv = be[f];
      if (String(sv ?? '') === String(bv ?? '')) continue;
      if ((f === 'address1' || f === 'address2') && addrEquiv) {
        counts['address-recombine'] = (counts['address-recombine'] || 0) + 1;
        continue;
      }
      const cls = classify(f, sv, bv);
      counts[cls] = (counts[cls] || 0) + 1;
      if (cls === 'UNEXPECTED') unexpected++;
      diffs.push(`  ${cls.padEnd(18)} ${f}: setting=${JSON.stringify(sv)}  built=${JSON.stringify(bv)}`);
    }
    // consumer-token equivalence — what actually lands on documents
    const tok = [
      ['trustee.name',           s(be.name).trim(),                    s(se.name).trim()],
      ['trustee.address_street', joinAddr(be.address1, be.address2),   joinAddr(se.address1, se.address2)],
      ['trustee.address_csz',    csz(be),                              csz(se)],
      ['trustee.phone',          fmtPhone(be.phone),                   fmtPhone(se.phone)],
    ];
    const tokDiffs = tok.filter(([, b, sv2]) => b !== sv2);
    if (diffs.length || tokDiffs.length) {
      console.log(`${key(se)}  '${se.name}':`);
      diffs.forEach((d) => console.log(d));
      for (const [name2, b, sv2] of tokDiffs) {
        const ok = name2 === 'trustee.name' && KNOWN_NAME_DRIFT[sv2] === b;
        if (!ok) unexpected++;
        console.log(`  ${ok ? 'name-drift        ' : 'TOKEN-UNEXPECTED  '}${name2}: setting→${JSON.stringify(sv2)}  built→${JSON.stringify(b)}`);
      }
    }
  }

  for (const be of built) {
    if (!settingBy.has(key(be))) {
      console.log(`BUILT-ONLY    ${key(be)}  '${be.name}'  — a trustee role exists with no setting entry`);
      unexpected++;
    }
  }

  console.log(`\n── summary ──`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${v} field diff(s)`);
  console.log(`  UNEXPECTED total   ${unexpected}`);
  console.log(unexpected === 0
    ? `\nCLEAN — every difference is a known-deliberate class. 7A is safe to deploy.\n`
    : `\nNOT CLEAN — resolve the UNEXPECTED lines before deploying 7A.\n`);
  return unexpected;
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then((n) => process.exit(n === 0 ? 0 : 1))
    .catch((err) => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = { main, _classify: classify, _joinAddr: joinAddr, _fmtPhone: fmtPhone };
