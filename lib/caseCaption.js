// lib/caseCaption.js
//
/**
 * Case caption naming rules. PURE: no DB, no req/res.
 * The rules as staff read them: manual/01-YisraCase-overview/03-matters.md.
 *
 *   No docket              no caption. A lead has no case in any court.
 *   Bankruptcy, main case  "In re " + the court's name for the case.
 *   Adversary              the court's name, unchanged ("Schneyer v. Childs").
 *   Any other court case   the court's name, unchanged.
 *   No ECF mail            typed by staff in Case Details.
 *
 * The court's name is ECF's "Case Name:" line. It carries no "In re", which
 * is why the prefix is added here. Keyed on case_type, never on a blank
 * case_subtype: most older bankruptcy rows have none.
 *
 *   captionFromCourtName(caseRow, courtName) → the caption, or null to write
 *     nothing. A "v." name on a main bankruptcy case is null: that name
 *     belongs to an adversary, and the case's own name is still to come.
 *   courtNameFromCaption(caption) → the caption without its "In re".
 *   captionAddsInfo(caption, primaryName) → false when the caption only
 *     repeats the client, so a list can leave it out.
 */

'use strict';

const MAX_CAPTION = 150;   // cases.case_caption is varchar(150)

// Lowercase on purpose: "Ivan V. Smith" is a middle initial, not an adversary.
const VERSUS_RE = / v\.? /;
const IN_RE_RE = /^in re(?:[:\s]+|$)/i;
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const tokens = (s) => clean(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function isBankruptcyMainCase(c) {
  return !!c && c.case_type === 'Bankruptcy' && c.case_subtype !== 'Adversary Proceeding';
}

function captionFromCourtName(caseRow, courtName) {
  const name = clean(courtName);
  if (!name) return null;
  if (!isBankruptcyMainCase(caseRow)) return name.slice(0, MAX_CAPTION);
  if (VERSUS_RE.test(name)) return null;
  const debtor = name.replace(IN_RE_RE, '');
  return debtor ? `In re ${debtor}`.slice(0, MAX_CAPTION) : null;
}

function courtNameFromCaption(caption) {
  return clean(caption).replace(IN_RE_RE, '');
}

function surnameOf(name) {
  const parts = tokens(name);
  while (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] || '';
}

function captionAddsInfo(caption, primaryName) {
  const text = clean(caption);
  if (!text) return false;
  if (VERSUS_RE.test(text)) return true;
  const surname = surnameOf(primaryName);
  return !surname || !tokens(text).includes(surname);
}

module.exports = { captionFromCourtName, courtNameFromCaption, captionAddsInfo };
