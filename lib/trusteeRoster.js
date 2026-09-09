// lib/trusteeRoster.js
//
/**
 * Trustee roster builder (slice 7) — contacts + contact_roles → the legacy
 * fe-trustees entry shape.
 *
 * WHY THIS EXISTS: the panel-trustee roster used to live in the
 * app_settings 'fe-trustees' JSON blob. Slice 4–6 seeded every roster
 * trustee as a real contact with a contact_roles row (role='trustee',
 * attrs { chapter, zoom_link }); this module is the ONE loader every former
 * fe-trustees consumer now reads through, so the setting could be
 * decommissioned without any consumer changing shape.
 *
 * ── THE ENTRY SHAPE IS A FROZEN CONTRACT ────────────────────────────────────
 * Every entry carries EXACTLY the keys the setting entries carried:
 *
 *   { name, lname, case_type, link, email, phone,
 *     address1, address2, city, state, zip, contact_id }
 *
 * Consumers keying on it (do not change one without auditing all):
 *   - lib/trusteeMatch          name / lname / case_type (rules 0–2)
 *   - internal_functions/trustee canonicalizes cases.case_trustee to `name`,
 *                               writes `link` to cases.case_341_link,
 *                               `contact_id` to case_trustee_contact_id
 *   - esignPrefillService       trustee.* tokens: name, address1/2,
 *                               city/state/zip, phone, email
 *   - lib/caseRoleResolver      `contact_id` → cases.case_trustee_contact_id
 *   - routes/api.users          GET /api/trustees ships entries verbatim
 *   - routes/api.firmData       firmData.settings.trustees → the
 *                               casedetails-bk dropdown (name/case_type/link)
 *                               and forms optionsFrom sources
 *
 * ── SOURCE MAPPING (inverse of scripts/seedRoleContacts.js) ─────────────────
 *   name      ← contacts.contact_name   (trigger-derived fname+mname+lname —
 *                the CANONICAL spelling now; see NAME DRIFT below)
 *   lname     ← contacts.contact_lname
 *   email     ← contacts.contact_email  (createContact lowercased it)
 *   phone     ← contacts.contact_phone  (10 digits; consumers that display
 *                it format it themselves — esign runs formatPhone)
 *   address1  ← contacts.contact_address (the seed joined the setting's
 *                address1 + ', ' + address2 into this ONE column, so it is
 *                already the full street line)
 *   address2  ← '' always (see address1 — nothing left to put here; the only
 *                shape-sensitive consumer, esign's trustee.address_street,
 *                joins a1/a2 with ', ' and so renders identically)
 *   city/state/zip ← contacts columns
 *   link      ← contact_roles.attrs.zoom_link
 *   case_type ← contact_roles.attrs.chapter — EXPLODED: a chapter ARRAY
 *                (the McDonald contact carries [12, 13]) yields one entry per
 *                chapter, same contact_id and name in each, so `case_type`
 *                stays scalar and trusteeMatch rule 0 / every consumer sees
 *                the shape they always saw. Missing chapter → one entry with
 *                case_type null (matchTrustee: eligible for every chapter).
 *
 * ── NAME DRIFT (deliberate, verified live 2026-09-09) ───────────────────────
 * Two canonical spellings changed at cutover because contact_name is the
 * name source now:
 *   'Caouette, Melissa A.'   → 'Melissa A. Caouette'   (contact 2083)
 *   'Thomas W. Jr. McDonald' → 'Thomas W. McDonald'    (contact 2082, the
 *                               merged ch12/13 pair — one contact, one name)
 * ZERO live cases carry either old spelling (checked against every distinct
 * cases.case_trustee value), so nothing stored dangles; future extractions
 * canonicalize to the new spellings.
 *
 * ── ORDER ───────────────────────────────────────────────────────────────────
 * Stable: contact_name (ci), then numeric case_type. Display order for the
 * casedetails-bk dropdown (which groups by chapter itself) and diff-stable
 * for scripts/verifyTrusteeReadthrough.js.
 *
 * ── ERROR CONTRACT ──────────────────────────────────────────────────────────
 * loadTrusteeRoster THROWS on query failure — callers own their degrade
 * policy, and they differ on purpose:
 *   - internal_functions/trustee lets it propagate (a DB blip must fail the
 *     validation run for a retry, NOT alert-task staff with a phantom
 *     'no_roster');
 *   - esignPrefillService catches → null (a render must not 500 — the
 *     trustee block collapses, matching the old cfgJson never-throw);
 *   - api.firmData catches → [] (a degraded dropdown beats a dead shell);
 *   - caseRoleResolver catches → null (its public never-throw contract).
 * An EMPTY roster (no active trustee roles) returns [] — matchTrustee maps
 * that to 'no_roster' exactly as a blank setting did.
 */

'use strict';

/** attrs JSON column → object (mysql2 usually pre-parses; normalize). */
function _attrs(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch (_) { return {}; }
}

function _s(v) { return String(v == null ? '' : v); }

/**
 * One legacy-shaped entry from a contacts+role row and ONE chapter value.
 * Exported for tests (the golden-equivalence fixture builds through this).
 *
 * @param {object} row       joined contact_roles × contacts row (see SQL)
 * @param {*}      chapter   scalar chapter for THIS entry (null = unchaptered)
 * @returns {object}         legacy fe-trustees entry shape
 */
function _buildEntry(row, chapter) {
  const attrs = _attrs(row.attrs);
  return {
    name:       _s(row.contact_name),
    lname:      _s(row.contact_lname),
    case_type:  chapter == null ? null : chapter,
    link:       _s(attrs.zoom_link),
    email:      _s(row.contact_email),
    phone:      _s(row.contact_phone),
    address1:   _s(row.contact_address),
    address2:   '',
    city:       _s(row.contact_city),
    state:      _s(row.contact_state),
    zip:        _s(row.contact_zip),
    contact_id: row.contact_id,
  };
}

/** attrs.chapter → array of scalar chapters ([null] when absent). */
function _chapters(attrsVal) {
  const ch = _attrs(attrsVal).chapter;
  if (ch == null || ch === '') return [null];
  return Array.isArray(ch) ? (ch.length ? ch : [null]) : [ch];
}

/**
 * The live trustee roster in the legacy fe-trustees entry shape.
 *
 * active = 1 only — deactivating a contact_roles row (the m6 'Trustee Namee'
 * removal) removes the trustee from EVERY consumer at once.
 *
 * @param {object} db  mysql2 pool/conn
 * @returns {Promise<Array<object>>}  exploded, ordered entries (never null)
 */
async function loadTrusteeRoster(db) {
  const [rows] = await db.query(
    `SELECT cr.contact_id, cr.attrs,
            c.contact_name, c.contact_lname, c.contact_email, c.contact_phone,
            c.contact_address, c.contact_city, c.contact_state, c.contact_zip
       FROM contact_roles cr
       JOIN contacts c ON c.contact_id = cr.contact_id
      WHERE cr.role = 'trustee' AND cr.active = 1
      ORDER BY c.contact_name ASC, cr.contact_id ASC`
  );

  const entries = [];
  for (const row of rows) {
    for (const ch of _chapters(row.attrs)) entries.push(_buildEntry(row, ch));
  }
  // ORDER BY gives name order; make (name, case_type) fully deterministic
  // in one place rather than relying on chapter-array element order alone.
  entries.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
    (Number(a.case_type) || 0) - (Number(b.case_type) || 0) ||
    (a.contact_id || 0) - (b.contact_id || 0));
  return entries;
}

module.exports = { loadTrusteeRoster, _buildEntry, _chapters };
