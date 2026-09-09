// lib/caseRoleResolver.js
//
/**
 * caseRoleResolver — free-text case fields → contact_id twins (slice 6).
 *
 * ONE shared helper behind cases.case_judge_contact_id and
 * cases.case_trustee_contact_id. Called from every write path that touches
 * case_judge / case_trustee / case_number_full (caseService.updateCase,
 * courtExecutor's field-apply + revert) and from
 * scripts/backfillCaseRoleIds.js, so live resolution and the backfill cannot
 * disagree.
 *
 * CONTRACT: the public resolvers NEVER THROW. A filing must never bounce
 * because a judge string didn't match — every failure path (bad SQL, missing
 * roster, garbage input) logs at debug and returns null. The *Detailed
 * variants additionally report HOW a hit was made, for the backfill's
 * summary table; they share the same never-throw contract.
 *
 * ── JUDGE (resolveJudge) ──────────────────────────────────────────────────
 * Primary key is the DOCKET SUFFIX, not the name: case_number_full is
 * 'NN-NNNNN-xxx' and the xxx maps to contact_roles attrs.judge_3
 * (role='judge'). The name is fallback only, because cases.case_judge free
 * text HAS DRIFT — 'Lisa S. Gretchko' (17 rows) vs 'Lisa Gretchko' (9 rows)
 * are the same judge. Order:
 *
 *   1. suffix   — last-hyphen token of case_number_full, lowercased; must
 *                 look like a suffix (2–4 letters) → attrs.judge_3 lookup.
 *                 Garbage suffixes (abc, aaa, '00546 (jlr)') simply miss.
 *   2. name     — exact ci contacts.contact_name equality.
 *   3. relaxed  — parseName(case_judge) → fname+lname ci equality, which is
 *                 what absorbs the middle-initial drift when there is no
 *                 usable suffix.
 *
 * Every step requires EXACTLY ONE hit; 0 or 2+ falls through (never guess).
 *
 * ── TRUSTEE (resolveTrustee) ──────────────────────────────────────────────
 * Delegates matching to lib/trusteeMatch (the FIL-1 canonical matcher — do
 * NOT reimplement its rules here) against the trustee roster — built from
 * contacts + contact_roles by lib/trusteeRoster (slice 7; formerly the
 * fe-trustees setting) — then maps roster entry → the entry's `contact_id`.
 * An entry with no contact_id returns null — never guess. `case_chapter` is passed through to
 * the matcher's rule-0 eligibility filter when the caller has it (the
 * McDonald ch12/ch13 pair is why it exists); callers without a chapter get
 * the matcher's unchaptered behavior.
 *
 * opts.roster lets the backfill (and tests) inject a pre-loaded roster
 * instead of paying one app_settings read per case.
 */

'use strict';

const { matchTrustee } = require('./trusteeMatch');
const { parseName } = require('./parseName');

/** 2–4 letters — the shape of a real judge suffix (mar, mlo, tjt, …). */
const SUFFIX_RE = /^[a-z]{2,4}$/;

/**
 * Extract the docket suffix from a full-form case number.
 * '26-42040-mar' → 'mar'; garbage ('', '26-00546 (jlr)', null) → null.
 * Exported for tests.
 */
function _docketSuffix(caseNumberFull) {
  const s = String(caseNumberFull == null ? '' : caseNumberFull).trim().toLowerCase();
  if (!s || s.indexOf('-') === -1) return null;
  const tail = s.slice(s.lastIndexOf('-') + 1).trim();
  return SUFFIX_RE.test(tail) ? tail : null;
}

function _dbg(msg) {
  if (typeof console.debug === 'function') console.debug(`[caseRoleResolver] ${msg}`);
}

/**
 * @param {object} db
 * @param {object} args
 * @param {?string} args.case_number_full
 * @param {?string} args.case_judge
 * @returns {Promise<{contact_id:(number|null), method:(string|null)}>}
 *   method ∈ 'suffix' | 'name_exact' | 'name_relaxed' | null
 */
async function resolveJudgeDetailed(db, { case_number_full, case_judge } = {}) {
  try {
    // 1. docket suffix → contact_roles attrs.judge_3
    const suffix = _docketSuffix(case_number_full);
    if (suffix) {
      const [rows] = await db.query(
        `SELECT cr.contact_id
           FROM contact_roles cr
          WHERE cr.role = 'judge' AND cr.active = 1
            AND LOWER(JSON_UNQUOTE(JSON_EXTRACT(cr.attrs, '$.judge_3'))) = ?`,
        [suffix]
      );
      if (rows.length === 1) return { contact_id: rows[0].contact_id, method: 'suffix' };
      if (rows.length > 1) _dbg(`judge suffix '${suffix}' ambiguous (${rows.length} role rows) — falling to name`);
    }

    const judgeText = String(case_judge == null ? '' : case_judge).trim();
    if (!judgeText) return { contact_id: null, method: null };

    // 2. exact ci name
    const [exact] = await db.query(
      `SELECT c.contact_id
         FROM contact_roles cr
         JOIN contacts c ON c.contact_id = cr.contact_id
        WHERE cr.role = 'judge' AND cr.active = 1
          AND LOWER(c.contact_name) = LOWER(?)`,
      [judgeText]
    );
    if (exact.length === 1) return { contact_id: exact[0].contact_id, method: 'name_exact' };
    if (exact.length > 1) {
      _dbg(`judge name '${judgeText}' exact-ambiguous (${exact.length}) — not guessing`);
      return { contact_id: null, method: null };
    }

    // 3. relaxed: fname + lname with the middle token(s) stripped — absorbs
    //    the 'Lisa Gretchko' / 'Lisa S. Gretchko' drift.
    const parsed = parseName(judgeText);
    if (!parsed.firstName || !parsed.lastName) return { contact_id: null, method: null };
    const [relaxed] = await db.query(
      `SELECT c.contact_id
         FROM contact_roles cr
         JOIN contacts c ON c.contact_id = cr.contact_id
        WHERE cr.role = 'judge' AND cr.active = 1
          AND LOWER(c.contact_fname) = LOWER(?)
          AND LOWER(c.contact_lname) = LOWER(?)`,
      [parsed.firstName, parsed.lastName]
    );
    if (relaxed.length === 1) return { contact_id: relaxed[0].contact_id, method: 'name_relaxed' };
    if (relaxed.length > 1) _dbg(`judge '${judgeText}' relaxed-ambiguous (${relaxed.length}) — not guessing`);
    return { contact_id: null, method: null };
  } catch (err) {
    _dbg(`resolveJudge failed: ${err.message}`);
    return { contact_id: null, method: null };
  }
}

/** contact_id | null. See resolveJudgeDetailed. */
async function resolveJudge(db, args) {
  return (await resolveJudgeDetailed(db, args)).contact_id;
}

/** Load the trustee roster (lib/trusteeRoster). null on failure — this
 *  module's public resolvers never throw, so a roster load failure degrades
 *  to a null twin, not an error (matchTrustee maps null to 'no_roster'). */
async function _loadRoster(db) {
  // Lazy require — keeps the lib's top level dependency-light (convention).
  const { loadTrusteeRoster } = require('./trusteeRoster');
  try {
    return await loadTrusteeRoster(db);
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} db
 * @param {object} args
 * @param {?string} args.case_trustee
 * @param {?string} args.case_chapter  optional — enables trusteeMatch rule 0
 * @param {object} [opts]
 * @param {?Array} [opts.roster]  pre-loaded roster (backfill / tests)
 * @returns {Promise<{contact_id:(number|null), method:(string|null), status:string}>}
 *   method is trusteeMatch's ('exact' | 'lname') on a hit; status is the
 *   matcher's verdict verbatim, plus 'entry_no_contact_id' and 'error'.
 */
async function resolveTrusteeDetailed(db, { case_trustee, case_chapter } = {}, opts = {}) {
  try {
    const extracted = String(case_trustee == null ? '' : case_trustee).trim();
    if (!extracted) return { contact_id: null, method: null, status: 'no_trustee' };

    const roster = Array.isArray(opts.roster) ? opts.roster : await _loadRoster(db);
    const verdict = matchTrustee({ extracted, chapter: case_chapter, roster });
    if (verdict.status !== 'matched') {
      return { contact_id: null, method: null, status: verdict.status };
    }

    const cid = parseInt(verdict.entry && verdict.entry.contact_id, 10);
    if (!Number.isInteger(cid) || cid <= 0) {
      // Roster entry predates the seed (or the emitted JSON was never pasted
      // back). NEVER guess — the twin stays null until the roster carries ids.
      return { contact_id: null, method: verdict.method, status: 'entry_no_contact_id' };
    }
    return { contact_id: cid, method: verdict.method, status: 'matched' };
  } catch (err) {
    _dbg(`resolveTrustee failed: ${err.message}`);
    return { contact_id: null, method: null, status: 'error' };
  }
}

/** contact_id | null. See resolveTrusteeDetailed. */
async function resolveTrustee(db, args, opts) {
  return (await resolveTrusteeDetailed(db, args, opts)).contact_id;
}

module.exports = {
  resolveJudge,
  resolveTrustee,
  resolveJudgeDetailed,
  resolveTrusteeDetailed,
  _docketSuffix,
};
