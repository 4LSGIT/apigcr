// scripts/seedRoleContacts.js
//
/**
 * Seed judge + trustee contacts with contact_roles rows (slices 4+5).
 *
 * ONE script, both roles:
 *
 *   JUDGES   — from the `judges` TABLE (7 rows; still authoritative for this
 *              one-time seed). judge_name is parsed via lib/parseName into
 *              fname/mname/lname; role 'judge' with attrs
 *              { judge_3: <docket suffix, lowercased> }.
 *   TRUSTEES — from the fe-trustees SETTING (app_settings), NOT the retired
 *              `trustees` MySQL table (varchar widths truncated its data —
 *              trustee_full_name is varchar(22); the setting is the live
 *              roster). Names parsed with the roster `lname` as the
 *              AUTHORITATIVE last name; phone/email/address go through
 *              contactService.createContact so child phone/email rows and
 *              legacy address columns populate like any other contact. Role
 *              'trustee' with attrs { chapter: <case_type>, zoom_link: <link> }.
 *
 * DEDUPE:
 *   judges   — exact case-insensitive contacts.contact_name match → attach
 *              the role to the existing row instead of creating.
 *   trustees — contactService.resolveContactsByValue on email, then phone →
 *              attach to the match. EVERY dedupe hit is reported, never a
 *              silent merge. The live roster contains Thomas W. McDonald
 *              twice (case_type 12 and 13, same email) — the second entry
 *              dedupes onto the first's contact, and because contact_roles
 *              has UNIQUE (contact_id, role), its chapter is MERGED into the
 *              existing role row's attrs (chapter becomes a sorted array
 *              when >1). zoom_link keeps the existing value; a differing
 *              incoming link is reported, not written.
 *
 * ROLE VALIDATION: role codes go through contactRoleService.assertValidRole
 * (contact_role_types, active=1) — the varchar accepts anything; this script
 * must not.
 *
 * IDEMPOTENT: a re-run dedupes everything onto the existing contacts and
 * skips roles already attached (reporting them), so --apply can be run again
 * safely after a partial failure.
 *
 * USAGE:
 *   node scripts/seedRoleContacts.js               # dry-run (default)
 *   node scripts/seedRoleContacts.js --dry-run     # same
 *   node scripts/seedRoleContacts.js --apply       # execute
 *
 * DRY-RUN prints every would-be create/attach with the parsed name parts so
 * the parsing can be eyeballed before --apply (the roster includes at least
 * one suffix-bearing entry — 'Thomas W. Jr. McDonald' — and one comma-form
 * entry — 'Caouette, Melissa A.').
 *
 * --apply's FINAL OUTPUT is the updated fe-trustees JSON: the current
 * setting value plus a `contact_id` field per entry, printed for Fred to
 * paste into settings.html. The script does NOT write app_settings.
 */

'use strict';

const { parseName } = require('../lib/parseName');

const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

/** collapse whitespace + trim */
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/**
 * Parse a roster trustee name with the roster `lname` as the authoritative
 * last name; everything before/around it distributes first-token → fname,
 * remaining middle tokens → mname. Handles the two live shapes that bite:
 *   'Caouette, Melissa A.'   (lname-comma prefix) → Melissa / A. / Caouette
 *   'Thomas W. Jr. McDonald' (suffix mid-tokens)  → Thomas / W. Jr. / McDonald
 *
 * Exported for tests. `anomaly` is non-null when the mechanical rule had to
 * fall back — those rows demand an eyeball in the dry-run table.
 */
function parseTrusteeName(name, lname) {
  const nm = clean(name);
  const ln = clean(lname);
  if (!nm) return { fname: '', mname: '', lname: ln, anomaly: 'blank_name' };
  if (!ln) {
    const p = parseName(nm);
    return { fname: p.firstName, mname: p.middleName, lname: p.lastName, anomaly: 'no_roster_lname' };
  }

  // "Last, First M." — the lname leads with a comma.
  if (nm.toLowerCase().startsWith(ln.toLowerCase() + ',')) {
    const rest = clean(nm.slice(ln.length + 1));
    const toks = rest ? rest.split(' ') : [];
    return { fname: toks[0] || '', mname: toks.slice(1).join(' '), lname: ln, anomaly: null };
  }

  // Remove the LAST token equal to the lname (ci); remainder distributes.
  const toks = nm.split(' ');
  let idx = -1;
  for (let i = toks.length - 1; i >= 0; i--) {
    if (toks[i].toLowerCase() === ln.toLowerCase()) { idx = i; break; }
  }
  if (idx === -1) {
    // Roster lname stays authoritative even when the display name never
    // contains it — but that mismatch is exactly what a human should see.
    return { fname: toks[0] || '', mname: toks.slice(1).join(' '), lname: ln, anomaly: 'lname_not_in_name' };
  }
  const rest = toks.slice(0, idx).concat(toks.slice(idx + 1));
  return { fname: rest[0] || '', mname: rest.slice(1).join(' '), lname: ln, anomaly: null };
}

/** normalize chapter merge: scalar when one, sorted unique array when many. */
function mergeChapters(existing, incoming) {
  const set = new Set(
    [].concat(existing == null ? [] : existing).concat(incoming == null ? [] : incoming)
      .map(v => String(v))
  );
  const arr = [...set].sort((a, b) => Number(a) - Number(b)).map(v => (isNaN(v) ? v : Number(v)));
  return arr.length === 1 ? arr[0] : arr;
}

function pad(s, n) { return String(s == null ? '' : s).padEnd(n); }

async function main(db) {
  const contactService = require('../services/contactService');
  const roleService = require('../services/contactRoleService');
  const { getSetting } = require('../services/settingsService');

  console.log(`\n=== seedRoleContacts — ${DRY ? 'DRY-RUN (no writes)' : 'APPLY'} ===\n`);

  // ── role-code gate — abort before touching anything ──
  await roleService.assertValidRole(db, 'judge');
  await roleService.assertValidRole(db, 'trustee');

  const report = { created: 0, dedupeAttached: 0, roleAttached: 0, roleMerged: 0, skipped: 0 };

  // In-run value index so a DRY run still surfaces intra-roster dedupes (the
  // McDonald pair): in APPLY mode the second entry's resolveContactsByValue
  // sees the first's freshly-inserted child rows; in DRY mode nothing was
  // inserted, so this map is what catches it.
  const plannedByEmail = new Map(); // normalized email → label
  const plannedByPhone = new Map(); // digits → label

  // ════════════════ JUDGES ════════════════
  console.log('── Judges (from `judges` table) ──');
  console.log(pad('judge_3', 8) + pad('fname', 10) + pad('mname', 8) + pad('lname', 14) + 'action');

  const [judges] = await db.query('SELECT judge_id, judge_3, judge_name FROM judges ORDER BY judge_id');
  for (const j of judges) {
    const suffix = clean(j.judge_3).toLowerCase();
    const p = parseName(clean(j.judge_name));
    const line = pad(suffix, 8) + pad(p.firstName, 10) + pad(p.middleName, 8) + pad(p.lastName, 14);

    if (!p.firstName || !p.lastName) {
      console.log(line + `SKIP — unparseable name '${j.judge_name}'`);
      report.skipped++;
      continue;
    }

    // Dedupe: exact ci contact_name.
    const [nameHits] = await db.query(
      'SELECT contact_id, contact_name FROM contacts WHERE LOWER(contact_name) = LOWER(?)',
      [clean(j.judge_name)]
    );
    let contactId = null;
    let action;
    if (nameHits.length > 1) {
      console.log(line + `SKIP — ${nameHits.length} contacts named '${j.judge_name}' (ambiguous, resolve by hand)`);
      report.skipped++;
      continue;
    } else if (nameHits.length === 1) {
      contactId = nameHits[0].contact_id;
      action = `DEDUPE → existing contact ${contactId}`;
      report.dedupeAttached++;
    } else {
      action = 'CREATE contact (person, type Judge)';
      if (APPLY) {
        const created = await contactService.createContact(db, {
          kind: 'person', fname: p.firstName, mname: p.middleName, lname: p.lastName,
          type: 'Judge',
        }, { userId: 0 });
        contactId = created.contact_id;
        action += ` → contact ${contactId}`;
      }
      report.created++;
    }

    // Attach role (idempotent: existing role row → report, don't touch).
    if (contactId != null) {
      const [[existingRole]] = await db.query(
        'SELECT id, attrs FROM contact_roles WHERE contact_id = ? AND role = ? LIMIT 1',
        [contactId, 'judge']
      );
      if (existingRole) {
        const attrs = roleService._parseAttrs(existingRole.attrs) || {};
        const note = attrs.judge_3 === suffix
          ? 'role already attached'
          : `role already attached — attrs.judge_3 '${attrs.judge_3}' != '${suffix}' (NOT changed; resolve by hand)`;
        console.log(line + `${action}; ${note}`);
        continue;
      }
      if (APPLY) {
        await roleService.attachRole(db, {
          contact_id: contactId, role: 'judge', attrs: { judge_3: suffix },
        });
      }
    }
    console.log(line + `${action}; ATTACH role judge attrs {judge_3:'${suffix}'}`);
    report.roleAttached++;
  }

  // ════════════════ TRUSTEES ════════════════
  console.log('\n── Trustees (from fe-trustees SETTING — NOT the retired table) ──');

  const rosterRaw = await getSetting(db, 'fe-trustees');
  if (rosterRaw == null) throw new Error("app_settings 'fe-trustees' is missing — nothing to seed");
  let roster;
  try { roster = JSON.parse(rosterRaw); } catch (e) {
    throw new Error(`fe-trustees is not parseable JSON: ${e.message}`);
  }
  if (!Array.isArray(roster)) throw new Error('fe-trustees is not a JSON array');

  console.log(pad('#', 4) + pad('roster name', 26) + pad('fname', 10) + pad('mname', 9)
    + pad('lname', 14) + pad('ch', 4) + 'action');

  // idx → contact_id, for the emitted JSON.
  const entryContactIds = new Array(roster.length).fill(null);

  for (let i = 0; i < roster.length; i++) {
    const t = roster[i] || {};
    const p = parseTrusteeName(t.name, t.lname);
    const emailNorm = clean(t.email).toLowerCase();
    const phoneDigits = clean(t.phone).replace(/\D/g, '');
    const line = pad(i, 4) + pad(clean(t.name), 26) + pad(p.fname, 10) + pad(p.mname, 9)
      + pad(p.lname, 14) + pad(t.case_type, 4);
    const anomalyNote = p.anomaly ? ` [PARSE ANOMALY: ${p.anomaly}]` : '';

    if (!p.fname || !p.lname) {
      console.log(line + `SKIP — unparseable ('${t.name}' / lname '${t.lname}')${anomalyNote}`);
      report.skipped++;
      continue;
    }

    // ── dedupe: email, then phone ──
    let contactId = null;
    let dedupeVia = null;
    if (emailNorm) {
      const r = await contactService.resolveContactsByValue(db, { email: emailNorm });
      if (r.matches.length === 1) { contactId = r.matches[0].contact_id; dedupeVia = `email ${emailNorm}`; }
      else if (r.matches.length > 1) {
        console.log(line + `SKIP — email ${emailNorm} matches ${r.matches.length} contacts (ambiguous)${anomalyNote}`);
        report.skipped++;
        continue;
      }
    }
    if (contactId == null && phoneDigits) {
      const r = await contactService.resolveContactsByValue(db, { phone: phoneDigits });
      if (r.matches.length === 1) { contactId = r.matches[0].contact_id; dedupeVia = `phone ${phoneDigits}`; }
      else if (r.matches.length > 1) {
        console.log(line + `SKIP — phone ${phoneDigits} matches ${r.matches.length} contacts (ambiguous)${anomalyNote}`);
        report.skipped++;
        continue;
      }
    }
    // DRY-run only: catch intra-roster dupes that APPLY would catch via the DB.
    let dryDupeOf = null;
    if (DRY && contactId == null) {
      dryDupeOf = (emailNorm && plannedByEmail.get(emailNorm))
               || (phoneDigits && plannedByPhone.get(phoneDigits)) || null;
    }

    let action;
    if (contactId != null) {
      action = `DEDUPE via ${dedupeVia} → existing contact ${contactId}`;
      report.dedupeAttached++;
    } else if (dryDupeOf) {
      action = `DEDUPE (in-run) → would attach to contact created for entry '${dryDupeOf}'`;
      report.dedupeAttached++;
    } else {
      const addr = [clean(t.address1), clean(t.address2)].filter(Boolean).join(', ');
      action = 'CREATE contact (person, type Trustee)';
      if (APPLY) {
        const created = await contactService.createContact(db, {
          kind: 'person', fname: p.fname, mname: p.mname, lname: p.lname,
          phone: t.phone || '', email: t.email || '', type: 'Trustee',
          address: addr, city: t.city || '', state: t.state || '', zip: t.zip || '',
        }, { userId: 0 });
        contactId = created.contact_id;
        action += ` → contact ${contactId}`;
      }
      report.created++;
      if (emailNorm) plannedByEmail.set(emailNorm, clean(t.name));
      if (phoneDigits) plannedByPhone.set(phoneDigits, clean(t.name));
    }
    entryContactIds[i] = contactId; // null on dry-run creates — expected

    // ── attach or merge the trustee role ──
    const attrs = { chapter: t.case_type, zoom_link: t.link || '' };
    let roleNote = `ATTACH role trustee attrs {chapter:${JSON.stringify(t.case_type)}}`;
    if (contactId != null) {
      const [[existingRole]] = await db.query(
        'SELECT id, attrs FROM contact_roles WHERE contact_id = ? AND role = ? LIMIT 1',
        [contactId, 'trustee']
      );
      if (existingRole) {
        // uk_contact_role: ONE trustee role row per contact. Merge chapters
        // (the McDonald ch12+ch13 pair); keep the existing zoom_link.
        const cur = roleService._parseAttrs(existingRole.attrs) || {};
        const merged = { ...cur, chapter: mergeChapters(cur.chapter, t.case_type) };
        const linkDiffers = cur.zoom_link && t.link && cur.zoom_link !== t.link;
        if (APPLY) await roleService.updateRole(db, existingRole.id, { attrs: merged });
        roleNote = `MERGE role trustee → attrs.chapter ${JSON.stringify(merged.chapter)}`
          + (linkDiffers ? ` [zoom_link DIFFERS — kept existing '${cur.zoom_link}', incoming '${t.link}' NOT written]` : '');
        report.roleMerged++;
      } else {
        if (APPLY) await roleService.attachRole(db, { contact_id: contactId, role: 'trustee', attrs });
        report.roleAttached++;
      }
    } else if (dryDupeOf) {
      // dry-run in-run dupe: APPLY would find one trustee role already on the
      // shared contact and MERGE chapters (see the existingRole branch).
      roleNote = `MERGE role trustee (in-run dupe of '${dryDupeOf}') → chapters combine`;
      report.roleMerged++;
    } else {
      // dry-run create path (no id yet) — the attach is part of the plan.
      report.roleAttached++;
    }
    console.log(line + `${action}; ${roleNote}${anomalyNote}`);
  }

  // ── summary ──
  console.log(`\nSummary: ${report.created} contact(s) ${DRY ? 'would be ' : ''}created, `
    + `${report.dedupeAttached} dedupe hit(s), ${report.roleAttached} role(s) attached, `
    + `${report.roleMerged} role merge(s), ${report.skipped} skipped.`);

  // ── APPLY final output: the updated fe-trustees JSON ──
  if (APPLY) {
    const updated = roster.map((t, i) => ({ ...t, contact_id: entryContactIds[i] }));
    console.log('\n=== UPDATED fe-trustees JSON — paste into settings.html ===');
    console.log('=== (this script does NOT write app_settings)            ===\n');
    console.log(JSON.stringify(updated, null, 1));
  } else {
    console.log('\n(dry-run: the updated fe-trustees JSON is emitted by --apply, '
      + 'once contact_ids exist)');
  }
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then(() => process.exit(0))
    .catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = { parseTrusteeName, mergeChapters, main };
