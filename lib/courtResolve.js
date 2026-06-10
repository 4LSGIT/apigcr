// lib/courtResolve.js
//
// READ-ONLY case resolver for the court-email pipeline. Given a docket string
// (full form "26-42040-mar" or bare "26-42040"), find the matching case and
// its Primary client contact. Pure SELECTs — never writes.
//
// Resolver chain (per GROUND TRUTH):
//   docket → case_id → Primary client contact_id
//   - cases.case_number_full carries the judge suffix ("26-42040-mar")
//   - cases.case_number is the bare docket ("26-42040")
//   - emails carry the full form; match either column first, then fall back to
//     stripping a trailing judge suffix (/-[a-z]+$/i) and matching case_number.
//   - Primary client comes from case_relate ordered Primary-first, mirroring
//     caseService.getCaseContacts (first row = Primary). Appts need a
//     contact_id; events do not.

/**
 * @param {object} db    mysql2 promise pool (returns [rows] from .query)
 * @param {string} docket  docket as written in the email (full or bare)
 * @returns {Promise<{
 *   found:boolean, case_id:(string|null), case_number_full:(string|null),
 *   case_number:(string|null), case_chapter:(string|null),
 *   primary_contact_id:(number|null), primary_contact_name:(string|null)
 * }>}
 */
async function resolveCase(db, docket) {
  const miss = {
    found: false,
    case_id: null,
    case_number_full: null,
    case_number: null,
    case_chapter: null,
    primary_contact_id: null,
    primary_contact_name: null,
  };

  const raw = (docket == null ? '' : String(docket)).trim();
  if (!raw) return miss;

  // q1: exact match on either docket column.
  let [rows] = await db.query(
    `SELECT case_id, case_number, case_number_full, case_chapter
       FROM cases
      WHERE case_number_full = ? OR case_number = ?
      LIMIT 1`,
    [raw, raw]
  );

  // Fallback: strip a trailing judge suffix and retry on the bare docket.
  if (!rows.length) {
    const stripped = raw.replace(/-[a-z]+$/i, '');
    if (stripped !== raw) {
      [rows] = await db.query(
        `SELECT case_id, case_number, case_number_full, case_chapter
           FROM cases
          WHERE case_number = ?
          LIMIT 1`,
        [stripped]
      );
    }
  }

  if (!rows.length) return miss;

  const c = rows[0];

  // Primary client — mirrors caseService.getCaseContacts ordering (first row =
  // Primary). null when the case has no related clients.
  const [contacts] = await db.query(
    `SELECT co.contact_id, co.contact_name
       FROM case_relate cr
       JOIN contacts co ON co.contact_id = cr.case_relate_client_id
      WHERE cr.case_relate_case_id = ?
      ORDER BY FIELD(cr.case_relate_type, 'Primary','Secondary','Other','Bystander'),
               co.contact_name
      LIMIT 1`,
    [c.case_id]
  );

  const primary = contacts.length ? contacts[0] : null;

  return {
    found: true,
    case_id: c.case_id,
    case_number_full: c.case_number_full,
    case_number: c.case_number,
    case_chapter: c.case_chapter,
    primary_contact_id: primary ? primary.contact_id : null,
    primary_contact_name: primary ? primary.contact_name : null,
  };
}

module.exports = { resolveCase };