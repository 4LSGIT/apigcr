// lib/caseId.js
//
/**
 * generateCaseId — mint an 8-char case ID from Crockford Base32.
 *
 * Alphabet: 0-9 plus A-Z with I, L, O, U removed (32 symbols, uppercase).
 * Staff and clients read case IDs aloud, write them on forms, and hand-type
 * them (public/caseerror.html); removing 0/O and 1/I/l lookalikes eliminates
 * that ambiguity. Uppercase-canonical also matches the DB — cases.case_id is
 * utf8mb4_general_ci (case-INsensitive), so the old mixed-case base64url
 * alphabet never bought the entropy it appeared to: the DB collapses case.
 * Canonical uppercase stops the latent bug class where a JS === comparison
 * against a DB-returned id mismatches while the SQL comparison matches.
 * Cost of the shrink is ~1.4 bits (36^8 → 32^8 as the DB sees it); 40 bits
 * against ~1k rows/year is ample.
 *
 * Uniformity: 256 = 8 × 32, so `byte & 31` maps exactly 8 equally-likely
 * byte values onto each symbol — exactly unbiased, no rejection sampling.
 * This holds ONLY because the alphabet length is a power of two; a 31- or
 * 33-symbol alphabet would need `%` and would be biased.
 *
 * All-digit rejection is load-bearing, not cosmetic. Several consumers tell
 * a case from a contact by "does it contain a letter": the Tier-1 exact
 * lookup gate in services/searchService.js and the isNaN(log_link) branches
 * in public/{index,case,contact}.html and public/scripts.js. At (10/32)^8 an
 * all-digit id would occur ~1 in 11,000 — unfindable in search, mis-iconed
 * in the log. The do/while costs ~0.0001 bits.
 *
 * Legacy IDs (~1k minted before Aug 2026) are mixed-case base64url — at
 * least one contains '-'. They are NEVER migrated or renamed; nothing on
 * the read side may narrow its accepted charset to this new alphabet.
 *
 * Collision note for callers: both intake routes retry on ER_DUP_ENTRY.
 * Because the collation is case-insensitive, that retry also transparently
 * covers a new uppercase id case-folding into a legacy mixed-case id.
 * Genuine collisions at 40 bits vs ~1k rows are astronomically unlikely —
 * a burst of retry failures means the generator is broken (returning a
 * constant), not that the id space is too small. Do not widen to 9 chars:
 * case_relate.case_relate_case_id, appts.appt_case_id, and
 * portal_access_log.case_id are varchar(8) under non-strict sql_mode — a
 * 9-char id would silently truncate in the join tables.
 *
 * @returns {string} 8 uppercase Crockford Base32 chars, never all-digit
 */

const crypto = require("crypto");

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32 — no I L O U

function generateCaseId() {
  let id;
  do {
    // Array.from, NOT buf.map — Buffer.prototype.map coerces the returned
    // string back to a number, yielding near-zero bytes that still render as
    // a plausible 8-char id. Silent, and it type-checks.
    id = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b & 31]).join("");
  } while (/^\d+$/.test(id));
  return id;
}

module.exports = { generateCaseId };
