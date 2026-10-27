// services/intakeService.js
//
/**
 * intakeService.js — contact upsert + case find-or-create, extracted from
 * routes/api.intake.js (2026-09, website-lead routing arc).
 *
 * WHY THE EXTRACTION. The intake route predates the internal-function
 * registry; its logic was reachable only over HTTP. The website-lead flow
 * (workflow 27 v2) needs the same contact-upsert and case-creation semantics
 * as workflow steps, and a webhook-to-self step cannot branch on a 409
 * divergence (error_policy has no on-fail routing — a failed step is just a
 * failed step). So the algorithms move here, returning DISCRIMINATED RESULT
 * OBJECTS, and both surfaces wrap them:
 *
 *     routes/api.intake.js            → maps outcomes to the EXACT response
 *                                       bodies the route has always sent
 *                                       (ycSync.test.js sniffs those shapes)
 *     lib/internal_functions/intake.js → maps outcomes to workflow outputs
 *                                       (intake_contact / intake_case)
 *
 * BEHAVIOR CONTRACT: intakeContact and intakeCase are line-for-line
 * transcriptions of the route handlers as of the extraction commit. Message
 * strings are preserved verbatim — the route relays them, so changing one
 * here changes an HTTP response. Two deliberate deltas, both flagged in the
 * route header too:
 *
 *   1. Side-effect ordering (case path): domainEvents.emit('case.created')
 *      and caseService.ensureCaseDropboxFolder used to run after res.json();
 *      they now fire inside intakeCase, immediately after the log insert.
 *      Both are fire-and-forget (emit is post-commit on the pool — pool
 *      queries autocommit; the Dropbox call is a detached .then/.catch), so
 *      the response is delayed by the synchronous cost of scheduling only.
 *
 *   2. allowBlankType (case path, opt-in): the route keeps requiring
 *      case_type; the internal function passes { allowBlankType: true } so a
 *      website lead whose matter type is not yet known can open a case with
 *      case_type '' (63 such rows live today; staff or ai_match fill it
 *      later). Never enabled on the HTTP surface.
 *
 *   3. NAME REVIEW (2026-10-28, contact path, both surfaces): a single match
 *      no longer writes over what is on file — blanks are filled, the
 *      phone/email added — and a match under a different name writes nothing
 *      and opens a review task (outcome 'name_conflict'; both wrappers answer
 *      it as action 'updated' + name_conflict). See the NAME REVIEW block.
 *
 * NEW (lead flow, no route equivalent):
 *   findIntakeCase(db, contactId) — the contact's most recent case whose
 *     CURRENT pipeline position (latest case_stage_log row) is a
 *     non-terminal stage of a role='intake' template. This is the reuse
 *     target for repeat website submissions: it deliberately does NOT match
 *     the ~700 legacy case_stage='Open' rows (they have no stage log), and
 *     it does not match retained/chapter-piped cases (role='case').
 *   countOpenCases(db, contactId, { excludeCaseId }) — Primary-related
 *     cases with case_stage IN ('Open','Pending','Filed'), for surfacing
 *     "this lead already has case(s)" to staff without automating a guess.
 *
 * Conventions: every function takes the mysql2 pool (or a transaction
 * connection) as its first argument; business failures are RESULT OUTCOMES
 * here, not thrown errors — only infrastructure failures throw.
 */

'use strict';

const crypto             = require('crypto');
const { parseName }      = require('../lib/parseName');
const caseService        = require('./caseService');
const contactService     = require('./contactService');
const domainEvents       = require('../lib/domainEvents'); // Trigger T3
const { getSettings }    = require('./settingsService');
const { alert }          = require('../lib/alerting');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────
// HELPERS (moved verbatim from routes/api.intake.js)
// ─────────────────────────────────────────

/**
 * Normalize phone to 10-digit string.
 * Returns:
 *   - null  when input is empty/missing/all non-digits
 *   - false when input has digits but wrong count (caller surfaces 400)
 *   - string of 10 digits on success
 *
 * Note: "abc" (no digits) returns null, not false — silently treated as
 * "no phone supplied" rather than rejected. Pre-existing wart; preserved
 * here for backward-compat.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length !== 10) return false;
  return digits;
}

/**
 * Build the conflict candidates payload for divergence outcomes.
 * Hydrates contact_phone and contact_email from the contacts mirror columns
 * so callers see human-recognizable identifiers per candidate.
 *
 * Empty mirror values are returned as null (not '') for cleaner UX.
 */
async function buildConflicts(db, matches) {
  if (!matches.length) return [];
  const ids = matches.map(m => m.contact_id);
  const placeholders = ids.map(() => '?').join(',');
  const [extras] = await db.query(
    `SELECT contact_id, contact_phone, contact_email
       FROM contacts
      WHERE contact_id IN (${placeholders})`,
    ids
  );
  const extraMap = new Map(extras.map(r => [r.contact_id, r]));
  return matches.map(m => {
    const x = extraMap.get(m.contact_id);
    return {
      contact_id:       m.contact_id,
      contact_name:     m.contact_name,
      contact_phone:    x?.contact_phone || null,
      contact_email:    x?.contact_email || null,
      matched_by_phone: m.matched_by_phone,
      matched_by_email: m.matched_by_email,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// NAME REVIEW (2026-10-28, Fred's ruling) — a single value match under a
// DIFFERENT name changes nothing on the matched contact; a person decides.
//
// Before this, intake's single-match UPDATE wrote the payload's name (and
// DOB / SSN / address) over whichever contact held the phone or email — a
// spouse's web lead on a shared phone renamed the other spouse. Now:
//   - a name never overwrites one (a BLANK name / field is filled);
//   - a differing first or last name (case, accents, punctuation and spacing
//     ignored; middle ignored; a part either side leaves blank isn't
//     compared) writes NOTHING and opens a review task carrying the
//     SUBMITTED values — never DOB or SSN (the task's assignment email
//     carries its text);
//   - the caller still gets the matched contact, so a lead flow continues.
// Not on the force_contact_id path: there a person already said which
// contact this is (the name still isn't overwritten).
// ─────────────────────────────────────────────────────────────

const normName = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^\p{L}]/gu, '');

function namesDiffer(cur, submitted) {
  for (const col of ['contact_fname', 'contact_lname']) {
    const a = normName(cur[col]);
    const b = normName(submitted[col]);
    if (a && b && a !== b) return true;
  }
  return false;
}

// null / '' / an all-zero or unparseable date (mysql2 hands DATE back as a Date).
function isBlank(v) {
  if (v == null) return true;
  if (v instanceof Date) return isNaN(v.getTime());
  const s = String(v).trim();
  return s === '' || /^0000-00-00/.test(s);
}

const ACTIVE_TASK = ['Pending', 'Due Today', 'Overdue'];

/**
 * `intake_review_assignee`, else `default_task_assignee` — the first that is
 * an ACTIVE user (user_auth 'authorized%', as firmData computes `active`).
 * @returns {Promise<number|null>}
 */
async function resolveReviewAssignee(db) {
  const keys = ['intake_review_assignee', 'default_task_assignee'];
  const vals = await getSettings(db, keys);
  for (const k of keys) {
    const id = parseInt(String(vals[k] ?? '').trim(), 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    const [[u]] = await db.query(
      "SELECT user FROM users WHERE user = ? AND user_auth LIKE 'authorized%'", [id]);
    if (u) return id;
  }
  return null;
}

/**
 * Open (or find the already-open) review task. Never throws — the lead flow
 * goes on whatever happens here; a missing assignee is an error-severity
 * alert (config fault), any other failure a warning.
 * @returns {Promise<number|null>} task id, or null when none exists
 */
async function openNameReviewTask(db, { contactId, existingName, submittedName, matchedBy, body, phone, email }) {
  const taskService = require('./taskService'); // lazy: keeps this module's load graph as it was
  try {
    const assignee = await resolveReviewAssignee(db);
    if (!assignee) {
      alert(db, {
        source: 'app', kind: 'intake_review_no_assignee', severity: 'error',
        group_key: 'intake_review_no_assignee',
        title: 'Contact-match review task not created — no assignee',
        message: `contact=${contactId}: an intake for "${submittedName}" matched "${existingName}" ` +
                 `by ${matchedBy}; nothing was changed. app_settings intake_review_assignee and ` +
                 `default_task_assignee are unset or not an active user.`,
        ref_table: 'contacts', ref_id: contactId,
      });
      return null;
    }

    // One open task per (contact, submitted name): Cloud Tasks / webhook
    // retries and repeat submissions don't stack.
    const dedupeKey = `intake-name:${contactId}:` +
      crypto.createHash('sha1').update(normName(submittedName)).digest('hex').slice(0, 16);
    const [[open]] = await db.query(
      `SELECT task_id FROM tasks
        WHERE task_dedupe_key = ? AND task_status IN (?, ?, ?)
        LIMIT 1`, [dedupeKey, ...ACTIVE_TASK]);
    if (open) return open.task_id;

    const lines = [
      `An intake matched contact #${contactId} (${existingName}) by ${matchedBy}, ` +
        `but under a different name. Nothing on the contact was changed.`,
      '',
      'Submitted:',
      `  name: ${submittedName}`,
    ];
    if (phone) lines.push(`  phone: ${phone}`);
    if (email) lines.push(`  email: ${email}`);
    const addr = ['contact_address', 'contact_city', 'contact_state', 'contact_zip']
      .map(k => (body[k] == null ? '' : String(body[k]).trim())).filter(Boolean).join(', ');
    if (addr) lines.push(`  address: ${addr}`);
    const withheld = ['contact_dob', 'contact_ssn'].filter(k => !isBlank(body[k]))
      .map(k => (k === 'contact_dob' ? 'date of birth' : 'SSN'));
    if (withheld.length) lines.push(`  (${withheld.join(' and ')} also supplied — not shown here)`);
    lines.push('',
      `Same person → copy what's new onto #${contactId}. A different person (e.g. a spouse) → ` +
      `create them as a new contact. Until then the lead stays on #${contactId}.`);

    const r = await taskService.createTask(db, {
      from:      0,
      to:        assignee,
      title:     `Check contact match: "${submittedName}" → ${existingName}`.slice(0, 100),
      desc:      lines.join('\n').slice(0, 1000),
      link_type: 'contact',
      link_id:   contactId,
      source:    'intake_name_review',
    });
    await db.query('UPDATE tasks SET task_dedupe_key = ? WHERE task_id = ?', [dedupeKey, r.task_id]);
    return r.task_id;
  } catch (err) {
    console.error('[INTAKE] name review task failed:', err.message);
    alert(db, {
      source: 'app', kind: 'intake_review_task_failed', severity: 'warning',
      group_key: 'intake_review_task_failed',
      title: 'Contact-match review task failed',
      message: `contact=${contactId} submitted="${submittedName}": ${err.message}`,
      ref_table: 'contacts', ref_id: contactId,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// intakeContact
//
// Create or update a contact by phone/email match. Transcribed from
// POST /api/intake/contact — see that route's header for the full
// upsert / divergence / partial-update history.
//
// @param {object} db    mysql2 pool or connection
// @param {object} body  the route body shape (name / firstName / fname /
//                       phone / email / duplicate / contact_* optionals /
//                       contact_kind / contact_org_name /
//                       phone_start_date / email_start_date)
// @param {object} opts  { forceContactId: number|null } — already parsed
//                       to a positive integer by the caller (the route
//                       validates the query-string shape; the internal
//                       function validates its param). Service re-checks
//                       defensively.
//
// @returns one of:
//   { outcome:'invalid',        message }
//   { outcome:'diverged',       conflicts }                    // 2+ matches, no force
//   { outcome:'force_mismatch', forceContactId, conflicts }    // conflicts [] on the 0-match case
//   { outcome:'updated',        contact_id, name }
//   { outcome:'name_conflict',  contact_id, name, existing_name,
//                               submitted_name, review_task_id }  // NAME REVIEW above
//   { outcome:'created',        contact_id, name }
// ─────────────────────────────────────────────────────────────
async function intakeContact(db, body = {}, { forceContactId = null } = {}) {
  const {
    name,
    firstName, middleName, lastName,
    phone, email,
    duplicate = "update",
  } = body;

  if (forceContactId != null &&
      (!Number.isInteger(forceContactId) || forceContactId <= 0)) {
    return { outcome: 'invalid', message: 'force_contact_id must be a positive integer' };
  }

  // ── Incoherent flag combo: duplicate=duplicate forces CREATE, force_contact_id
  //    targets a specific existing contact. They contradict each other. ──
  if (duplicate === "duplicate" && forceContactId != null) {
    return { outcome: 'invalid', message: 'duplicate=duplicate and force_contact_id cannot be combined' };
  }

  // ── Name fields — accept either camelCase (firstName/...) or db-style
  //    (fname/...). camelCase wins if both supplied for a given slot. ──
  const fName = (firstName  !== undefined) ? firstName  : body.fname;
  const mName = (middleName !== undefined) ? middleName : body.mname;
  const lName = (lastName   !== undefined) ? lastName   : body.lname;

  const hasExplicitParts = fName !== undefined || mName !== undefined || lName !== undefined;
  const hasName = typeof name === 'string' && name.trim() !== '';

  // Resolve to a parsed shape (for CREATE) and an explicit-slot map (for UPDATE).
  let nameForCreate = null;
  let nameInUpdate  = null;

  if (hasExplicitParts) {
    nameInUpdate = {};
    if (fName !== undefined) nameInUpdate.contact_fname = fName == null ? '' : String(fName);
    if (mName !== undefined) nameInUpdate.contact_mname = mName == null ? '' : String(mName);
    if (lName !== undefined) nameInUpdate.contact_lname = lName == null ? '' : String(lName);

    nameForCreate = {
      firstName:  fName == null ? '' : String(fName),
      middleName: mName == null ? '' : String(mName),
      lastName:   lName == null ? '' : String(lName),
    };
  } else if (hasName) {
    const parsed = parseName(name);
    nameInUpdate = {
      contact_fname: parsed.firstName,
      contact_mname: parsed.middleName,
      contact_lname: parsed.lastName,
    };
    nameForCreate = parsed;
  }

  // ── Phone validation ──
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  if (phone && normalizedPhone === false) {
    return { outcome: 'invalid', message: 'Invalid phone number' };
  }

  // ── Email normalization (light — defer real normalization to the service) ──
  const trimmedEmail = (typeof email === 'string' && email.trim() !== '') ? email.trim() : null;

  // ── KIND — validated before the resolve step (org-contacts slice 1 fixup):
  //    an explicit org intake never enters the value-match. See the route
  //    header / contactService for the full rationale. ──
  const intakeKind = String(body.contact_kind || 'person').trim().toLowerCase();
  if (intakeKind !== 'person' && intakeKind !== 'org') {
    return { outcome: 'invalid', message: 'contact_kind must be "person" or "org"' };
  }
  const intakeOrgName = String(body.contact_org_name || '').trim();
  if (intakeKind === 'org' && !intakeOrgName) {
    return { outcome: 'invalid', message: 'contact_org_name is required when contact_kind is "org"' };
  }

  // ── Optional start_date overrides for the primary phone/email child rows. ──
  const phoneStartDate = body.phone_start_date;
  const emailStartDate = body.email_start_date;
  if (phoneStartDate !== undefined && phoneStartDate !== null && phoneStartDate !== ''
      && !DATE_RE.test(phoneStartDate)) {
    return { outcome: 'invalid', message: 'phone_start_date must be YYYY-MM-DD' };
  }
  if (emailStartDate !== undefined && emailStartDate !== null && emailStartDate !== ''
      && !DATE_RE.test(emailStartDate)) {
    return { outcome: 'invalid', message: 'email_start_date must be YYYY-MM-DD' };
  }

  // ── Resolve candidates (skip when forcing CREATE or no identifiers) ──
  let matches = [];
  if (duplicate !== "duplicate" && intakeKind !== 'org'
      && (normalizedPhone || trimmedEmail)) {
    const result = await contactService.resolveContactsByValue(
      db,
      { phone: normalizedPhone, email: trimmedEmail },
      { include_ended: true, include_legacy_secondary: true }
    );
    matches = result.matches || [];
  }

  // ── Disambiguation / branch selection ──
  let targetContactId = null;

  if (matches.length >= 2) {
    // Divergence path
    if (forceContactId == null) {
      const conflicts = await buildConflicts(db, matches);
      return { outcome: 'diverged', conflicts };
    }
    const picked = matches.find(m => m.contact_id === forceContactId);
    if (!picked) {
      const conflicts = await buildConflicts(db, matches);
      return { outcome: 'force_mismatch', forceContactId, conflicts };
    }
    targetContactId = forceContactId;

  } else if (matches.length === 1) {
    // Single match — auto-update.
    if (forceContactId != null && forceContactId !== matches[0].contact_id) {
      const conflicts = await buildConflicts(db, matches);
      return { outcome: 'force_mismatch', forceContactId, conflicts };
    }
    targetContactId = matches[0].contact_id;

  } else if (forceContactId != null) {
    // 0 matches but caller named a contact — surface rather than silently
    // creating something different from what the caller asked for.
    return { outcome: 'force_mismatch', forceContactId, conflicts: [] };
  }

  // ─────────────────────────────────────
  // UPDATE branch
  // ─────────────────────────────────────
  if (targetContactId != null) {
    const [[cur]] = await db.query(
      `SELECT contact_name, contact_fname, contact_mname, contact_lname,
              contact_address, contact_city, contact_state, contact_zip,
              contact_dob, contact_ssn, contact_phone2, contact_email2, contact_pname
         FROM contacts WHERE contact_id = ?`,
      [targetContactId]
    );
    if (!cur) throw new Error(`intakeContact: matched contact ${targetContactId} not found`);

    // ── NAME REVIEW (header above): a different name → write nothing. ──
    if (forceContactId == null && nameInUpdate && namesDiffer(cur, nameInUpdate)) {
      const m = matches[0];
      const matchedBy = [m.matched_by_phone && 'phone', m.matched_by_email && 'email']
        .filter(Boolean).join(' and ') || 'phone/email';
      const submittedName = hasName
        ? name.trim()
        : [nameInUpdate.contact_fname, nameInUpdate.contact_mname, nameInUpdate.contact_lname]
            .map(x => String(x || '').trim()).filter(Boolean).join(' ');
      const reviewTaskId = await openNameReviewTask(db, {
        contactId: targetContactId, existingName: cur.contact_name, submittedName, matchedBy,
        body, phone: normalizedPhone, email: trimmedEmail,
      });
      return {
        outcome: 'name_conflict', contact_id: targetContactId, name: cur.contact_name,
        existing_name: cur.contact_name, submitted_name: submittedName, review_task_id: reviewTaskId,
      };
    }

    const updateFields = {};

    // A name never overwrites one — a blank slot is filled.
    if (nameInUpdate) {
      for (const [col, v] of Object.entries(nameInUpdate)) {
        if (isBlank(cur[col]) && !isBlank(v)) updateFields[col] = v;
      }
    }

    // phone/email — only if non-empty truthy supplied. Empty/null does NOT
    // clear (consistent with the legacy route's behavior).
    if (normalizedPhone) updateFields.contact_phone = normalizedPhone;
    if (trimmedEmail)    updateFields.contact_email = trimmedEmail;

    const UPDATE_OPTIONALS = [
      'contact_address', 'contact_city', 'contact_state', 'contact_zip',
      'contact_dob', 'contact_ssn',
      'contact_phone2', 'contact_email2',
      'contact_pname',
    ];
    // Fill blanks only: a value on file (DOB, SSN, address…) is never
    // overwritten by an intake — it may be another person's (NAME REVIEW).
    for (const col of UPDATE_OPTIONALS) {
      const v = body[col];
      if (v !== undefined && v !== null && v !== '' && isBlank(cur[col])) {
        updateFields[col] = v;
      }
    }

    // INVARIANT: updateFields is non-empty whenever we reach here — the only
    // way in is a value match (phone or email in the payload) or a
    // force_contact_id at one of those matches; the identifying value lands
    // in updateFields either way. If that ever breaks, updateContact throws
    // "updateContact requires at least one field" and surfaces as an
    // infrastructure error.
    // force: true — preserve the intake path's historical behavior now that
    // contactService gates scalar cross-contact transfers on this flag.
    // Unattended intake cannot actually reach a collision: a value active on
    // ANOTHER contact makes that contact a second match, so resolveContacts-
    // ByValue returns 2 and we exit as 'diverged' long before here. The flag
    // matters only on the force_contact_id path, where a human has already
    // picked WHICH contact this person is — and that answer implies the value
    // moves with them. If that ever stops being the right default, the fix is
    // a 'conflict' outcome on intakeContact, not a silent force:false.
    await contactService.updateContact(db, targetContactId, updateFields, { force: true });

    const [[updated]] = await db.query(
      'SELECT contact_name FROM contacts WHERE contact_id = ?',
      [targetContactId]
    );

    return { outcome: 'updated', contact_id: targetContactId, name: updated.contact_name };
  }

  // ─────────────────────────────────────
  // CREATE branch
  // ─────────────────────────────────────
  if (intakeKind !== 'org') {
    if (!nameForCreate) {
      return { outcome: 'invalid', message: 'Name is required to create a contact (provide name, or firstName + lastName)' };
    }
    if (!nameForCreate.firstName || !nameForCreate.lastName) {
      return { outcome: 'invalid', message: 'Both firstName and lastName are required to create a contact' };
    }
  }

  const created = await contactService.createContact(db, {
    kind:     intakeKind,
    org_name: intakeOrgName,
    fname:   nameForCreate ? nameForCreate.firstName  : '',
    mname:   nameForCreate ? nameForCreate.middleName : '',
    lname:   nameForCreate ? nameForCreate.lastName   : '',
    phone:   normalizedPhone || '',
    email:   trimmedEmail   || '',
    address: body.contact_address || '',
    city:    body.contact_city    || '',
    state:   body.contact_state   || '',
    zip:     body.contact_zip     || '',
    dob:     body.contact_dob     || null,
    phone2:  body.contact_phone2  || '',
    email2:  body.contact_email2  || '',
    pname:   body.contact_pname   || '',
    tags:    body.contact_tags    || '',
    notes:   body.contact_notes   || '',
    type:    body.contact_type    || 'Client',
    phone_start_date: (phoneStartDate && DATE_RE.test(phoneStartDate)) ? phoneStartDate : null,
    email_start_date: (emailStartDate && DATE_RE.test(emailStartDate)) ? emailStartDate : null,
  });

  // SSN handled separately — createContact doesn't accept it.
  if (body.contact_ssn) {
    await contactService.updateContact(db, created.contact_id, {
      contact_ssn: body.contact_ssn,
    });
  }

  // Manual "created" log — the after_contact_update trigger only fires on
  // UPDATE, so creations need an explicit log row. Track A.1 may revisit.
  await db.query(
    `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
     VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
    [
      created.contact_id,
      JSON.stringify({
        contact_id:    created.contact_id,
        action:        "created",
        contact_name:  created.contact_name,
        contact_phone: normalizedPhone,
        contact_email: trimmedEmail || null,
      }),
    ]
  );

  return { outcome: 'created', contact_id: created.contact_id, name: created.contact_name };
}

// ─────────────────────────────────────────────────────────────
// intakeCase
//
// Find or create a case for a contact. Transcribed from
// POST /api/intake/case — see that route's header for the docket contract
// (opaque free-text, collision-by-equality, either-docket-forces-create)
// and the judge role twin.
//
// @param {object} db    mysql2 pool or connection
// @param {object} body  { contact_id, case_type, case_subtype?, duplicate?,
//                         case_number?, case_number_full? }
// @param {object} opts  { allowBlankType: boolean } — opt-in (internal
//                       function only): permit case_type ''/absent, for
//                       leads whose matter type is not yet known. The HTTP
//                       route never sets it.
//
// @returns one of:
//   { outcome:'invalid',   message }
//   { outcome:'collision', reported, conflict:{case_id, case_number,
//                          case_number_full, case_type} }
//   { outcome:'found',     case_id }
//   { outcome:'created',   case_id, case_relate_id }
// ─────────────────────────────────────────────────────────────
async function intakeCase(db, body = {}, { allowBlankType = false } = {}) {
  const { contact_id, duplicate = "return" } = body;
  let caseType = body.case_type;

  if (!contact_id || (!caseType && !allowBlankType)) {
    return { outcome: 'invalid', message: 'contact_id and case_type are required' };
  }
  if (!caseType) caseType = '';   // allowBlankType path only

  // ── Optional case_number (Phase 3) ──
  let caseNumber = body.case_number;
  caseNumber = (typeof caseNumber === "string") ? caseNumber.trim() : "";
  if (caseNumber === "") caseNumber = null;
  if (caseNumber !== null && caseNumber.length > 20) {
    return { outcome: 'invalid', message: 'case_number exceeds 20 chars' };
  }

  // ── Optional case_number_full (Phase 4.2) ──
  let caseNumberFull = body.case_number_full;
  caseNumberFull = (typeof caseNumberFull === "string") ? caseNumberFull.trim() : "";
  if (caseNumberFull === "") caseNumberFull = null;
  if (caseNumberFull !== null && caseNumberFull.length > 20) {
    return { outcome: 'invalid', message: 'case_number_full exceeds 20 chars' };
  }

  // ── Optional case_subtype (2026-06 type/subtype split) ──
  let caseSubtype = body.case_subtype;
  caseSubtype = (typeof caseSubtype === "string") ? caseSubtype.trim() : "";
  if (caseSubtype === "") caseSubtype = null;
  if (caseSubtype !== null && caseSubtype.length > 40) {
    return { outcome: 'invalid', message: 'case_subtype exceeds 40 chars' };
  }

  // ── Collision check (only when a docket value was supplied) ──
  const submittedDockets = [...new Set(
    [caseNumber, caseNumberFull].filter(v => v !== null)
  )];
  if (submittedDockets.length) {
    const placeholders = submittedDockets.map(() => "?").join(", ");
    const [clash] = await db.query(
      `SELECT case_id, case_number, case_number_full, case_type
         FROM cases
        WHERE (case_number      IS NOT NULL AND case_number      <> '' AND case_number      IN (${placeholders}))
           OR (case_number_full IS NOT NULL AND case_number_full <> '' AND case_number_full IN (${placeholders}))
        LIMIT 1`,
      [...submittedDockets, ...submittedDockets]
    );
    if (clash.length) {
      const c = clash[0];
      const reported = caseNumber || caseNumberFull;
      return {
        outcome: 'collision',
        reported,
        conflict: {
          case_id:          c.case_id,
          case_number:      c.case_number || null,
          case_number_full: c.case_number_full || null,
          case_type:        c.case_type,
        },
      };
    }
  }

  // ── Effective duplicate flag ──
  // Providing ANY docket value is an unambiguous "create a new case with this
  // number" signal. Force CREATE so find-existing can't swallow the intent.
  const effectiveDuplicate = (caseNumber !== null || caseNumberFull !== null)
    ? "duplicate"
    : duplicate;

  // ── Check for existing active case of same type ──
  // The stage list is the "still live" half of the case_stage enum
  // ('Open','Pending','Filed','Concluded','Closed'). New cases from this
  // path carry no explicit stage and take the column default, 'Open'.
  if (effectiveDuplicate !== "duplicate") {
    const [existing] = await db.query(
      `SELECT cases.case_id
       FROM cases
       LEFT JOIN case_relate cr ON cases.case_id = cr.case_relate_case_id
       WHERE cr.case_relate_client_id = ?
         AND cr.case_relate_type = 'Primary'
         AND cases.case_stage IN ('Open', 'Pending', 'Filed')
         AND cases.case_type = ?
       ORDER BY cases.case_open_date DESC
       LIMIT 1`,
      [contact_id, caseType]
    );

    if (existing.length) {
      return { outcome: 'found', case_id: existing[0].case_id };
    }
  }

  // ── Role twin (slice 7): resolve the judge from the docket suffix ──
  let judgeContactId = null;
  if (caseNumberFull !== null) {
    try {
      const roleResolver = require('../lib/caseRoleResolver'); // lazy (convention)
      judgeContactId = await roleResolver.resolveJudge(db, {
        case_number_full: caseNumberFull,
        case_judge: null,
      });
    } catch (err) {
      console.error('intakeService.intakeCase: judge twin resolve failed (non-fatal):', err.message);
      judgeContactId = null;
    }
  }

  // ── Create the case ──
  //
  // caseService.createCase is THE case INSERT (S6-B): it mints the id, retries
  // on collision, gates the columns, and stamps the S6 custom-field defaults.
  // Columns NOT passed rely on implicit defaults — the cases table is mostly
  // NOT-NULL with no DB defaults, which works only because the session
  // sql_mode is non-strict (STRICT_TRANS_TABLES absent). Do NOT add strict
  // mode without giving these columns real defaults first; that is why the
  // optional four are spread in rather than passed as nulls.
  const created = await caseService.createCase(db, {
    case_open_date: caseService.NOW_FIRM,
    case_type: caseType,
    ...(caseSubtype    !== null ? { case_subtype: caseSubtype }             : {}),
    ...(caseNumber     !== null ? { case_number: caseNumber }               : {}),
    ...(caseNumberFull !== null ? { case_number_full: caseNumberFull }      : {}),
    ...(judgeContactId !== null ? { case_judge_contact_id: judgeContactId } : {}),
  });
  const case_id = created.case_id;

  // ── Create case_relate link ──
  const [relateResult] = await db.query(
    `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type)
     VALUES (?, ?, 'Primary')`,
    [case_id, contact_id]
  );

  // ── Log case creation ──
  await db.query(
    `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
     VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
    [
      case_id,
      JSON.stringify({ action: "case_created", case_type: caseType, case_subtype: caseSubtype, contact_id })
    ]
  );

  // ── Fire-and-forget side effects (see the ordering delta in the header) ──

  // Trigger: case.created. Pool queries autocommit, so post-insert here is
  // post-commit — the placement the trigger review requires.
  domainEvents.emit(db, 'case.created', {
    case_id,
    contact_id: parseInt(contact_id, 10) || null,
    source: 'intake',
    data: {
      case_id,
      case_type:        caseType,
      case_subtype:     caseSubtype ?? null,
      case_number:      caseNumber ?? null,
      case_number_full: caseNumberFull ?? null,
      // Stamped custom-field defaults (S6-B), in the COLUMN's shape so this
      // envelope and contact.created agree for every type. ADDITIVE ONLY —
      // the core keys above keep their exact spelling and presence, because
      // live rule "New intake case → lead" matches on not_exists over two of
      // them. {} when nothing is defaulted.
      ...created.custom_fields,
    },
    extra: { case_relate_id: relateResult.insertId },
  });

  // Dropbox case folder (native, stage-aware). Fully detached: failures log
  // only — they must never reach a caller's catch.
  caseService.ensureCaseDropboxFolder(db, case_id)
    .then(r => console.log(`[INTAKE] Dropbox folder ${r.existed ? 'already linked' : `created (${r.stage})`} for case ${case_id}${r.path ? `: ${r.path}` : ''}`))
    .catch(err => console.error(`Dropbox folder creation failed for case ${case_id}:`, err.message));

  return { outcome: 'created', case_id, case_relate_id: relateResult.insertId };
}

// ─────────────────────────────────────────────────────────────
// findIntakeCase — the lead-flow reuse target.
//
// The contact's most recent Primary-related case whose CURRENT pipeline
// position (latest case_stage_log row) is a NON-TERMINAL stage of a
// role='intake' template. Cross-case-type by design: a second submission
// from a different site (MDBL typed Bankruptcy, LSG blank) must land on the
// SAME lead case, not spawn a sibling for the merge tool.
//
// Deliberately narrow:
//   - no stage log at all → no match (the ~700 legacy 'Open' rows never
//     qualify; only cases the pipeline has actually touched do)
//   - latest stage on a role='case' template → no match (retained clients
//     don't get their live matter hijacked by a website form)
//   - terminal intake stage (dead_lead) → no match (a dead lead re-submitting
//     is a NEW lead)
//   - Closed/Concluded case_stage → no match, regardless of log
//
// @returns { case_id, stage_key, internal_label } | null
// ─────────────────────────────────────────────────────────────
async function findIntakeCase(db, contactId) {
  const [rows] = await db.query(
    `SELECT c.case_id, l.stage_key, ps.internal_label
       FROM case_relate cr
       JOIN cases c
         ON c.case_id = cr.case_relate_case_id
       JOIN case_stage_log l
         ON l.case_id = c.case_id
        AND l.id = (SELECT l2.id
                      FROM case_stage_log l2
                     WHERE l2.case_id = c.case_id
                     ORDER BY l2.entered_at DESC, l2.id DESC
                     LIMIT 1)
       JOIN pipeline_stages ps ON ps.id = l.stage_id
       JOIN pipeline_templates pt ON pt.id = l.template_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_type = 'Primary'
        AND pt.role = 'intake'
        AND COALESCE(ps.is_terminal, 0) = 0
        AND c.case_stage NOT IN ('Closed', 'Concluded')
      ORDER BY c.case_open_date DESC
      LIMIT 1`,
    [contactId]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────
// countOpenCases — how many live cases this contact already has.
//
// "Live" = case_stage IN ('Open','Pending','Filed'), Primary relation —
// the same liveness predicate intakeCase's find-existing uses. Surfaced to
// staff ("note: contact has N existing open case(s)") rather than used to
// automate a reuse decision, because most of those rows are legacy imports
// whose 'Open' means nothing current.
//
// @param {object} opts { excludeCaseId } — omit one case (the lead case
//                       just created/reused) from the count.
// ─────────────────────────────────────────────────────────────
async function countOpenCases(db, contactId, { excludeCaseId = null } = {}) {
  const params = [contactId];
  let exclude = '';
  if (excludeCaseId != null) {
    exclude = 'AND c.case_id <> ?';
    params.push(excludeCaseId);
  }
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS n
       FROM case_relate cr
       JOIN cases c ON c.case_id = cr.case_relate_case_id
      WHERE cr.case_relate_client_id = ?
        AND cr.case_relate_type = 'Primary'
        AND c.case_stage IN ('Open', 'Pending', 'Filed')
        ${exclude}`,
    params
  );
  return Number(row.n) || 0;
}

module.exports = {
  intakeContact,
  intakeCase,
  findIntakeCase,
  countOpenCases,
  // exposed for the route (moved here from routes/api.intake.js)
  normalizePhone,
  buildConflicts,
};
