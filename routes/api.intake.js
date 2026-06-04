// routes/api.intake.js
//
/**
 * TEMPORARY — Intake Routes (Contact & Case Creation)
 * ----------------------------------------
 * POST /api/intake/contact    create or update a contact by phone/email match
 * POST /api/intake/case       find or create a case for a contact
 *
 * These are temporary routes replacing the Pabbly "newClient" and "newCase"
 * workflows. When the full /api/contacts and /api/cases routes are designed,
 * these should be incorporated or replaced.
 *
 * Contact upsert (Slice 3 B.2 — multi-value-aware):
 *   - Lookup via contactService.resolveContactsByValue (child tables + legacy
 *     primary/secondary, include_ended=true so orphan-log auto-re-adopt works)
 *   - 0 matches → CREATE (name fields required)
 *   - 1 match  → UPDATE that contact (partial — only fields actually supplied)
 *   - 2+ matches → divergence. 409 with full candidate summary unless
 *     ?force_contact_id=N is supplied and matches one of the candidates.
 *   - duplicate="duplicate" body field still forces CREATE path (legacy).
 *   - MySQL triggers auto-derive contact_name, contact_lfm_name, contact_rname
 *   - MySQL after_contact_update trigger auto-logs field changes
 *   - On CREATE, this route also writes a manual "created" log row (the
 *     after_update trigger only fires on UPDATE). Track A.1 may revisit.
 *
 * Three bugs closed by the rewrite:
 *   1. Ended-row miss — legacy lookup was `WHERE contact_phone = ?` on the
 *      mirror only, missing ended child_phones rows. resolveContactsByValue
 *      with include_ended:true catches them.
 *   2. Cross-contact email hijack — old code matched phone→contact A then
 *      blindly propagated email which silently transferred from contact B
 *      to A with no user consent. New code: if email belongs to a different
 *      contact than phone, divergence → 409. User must explicitly pick a
 *      contact via force_contact_id, which is the consent signal.
 *   3. Partial-update overwrite — old code unconditionally wrote
 *      fname/mname/lname on every update path, nulling fields when caller
 *      sent only {phone, email}. New code only writes columns actually
 *      supplied in the payload.
 *
 * Case creation:
 *   - Looks for existing active case of same type for this contact
 *   - If found and duplicate != "duplicate" → return existing case_id
 *   - If not found or duplicate == "duplicate" → create new case + case_relate
 *   - Fire-and-forget native Dropbox folder creation (dropboxService) +
 *     shared link saved to cases.case_dropbox; folder path from app_settings
 *     'dropbox_case_folder_templates' (per-case_type map) with hardcoded fallback
 *
 * Replaces:
 *   - Pabbly mode=newClient workflow
 *   - Pabbly mode=newCase workflow
 *   - Pabbly create_dropbox_folder workflow (now native via dropboxService)
 *   - routes/create-case.js (old auth pattern, string interpolation)
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { parseName } = require("../lib/parseName");
const dropboxService = require("../services/dropboxService");
const { nowLocal } = require("../services/timezoneService");
const contactService = require('../services/contactService');

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Generate an 8-char alphanumeric case ID using crypto, excluding '-' and '_'
 * (base64url's two non-alphanumeric characters) for URL/copy-paste cleanliness.
 */
function generateCaseId() {
  let id;
  do {
    // 6 random bytes → base64url → take first 8 chars
    id = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  } while (id.includes('-') || id.includes('_'));
  return id;
}

// ─────────────────────────────────────────
// Dropbox case-folder convention
// ─────────────────────────────────────────

// Templates live in app_settings 'dropbox_case_folder_templates' — a JSON map
// of case_type → template string, with an optional "default" entry:
//   { "default": "...", "Bankruptcy - Ch. 7": "..." }
// Resolution: templates[case_type] ?? templates.default ?? the constant below.
// No settings row exists today, so everyone gets the constant (one template
// for all types, {{case_type}} substituted). Per-type conventions later are a
// settings insert, not a deploy.
// LEADING SPACES ARE SIGNIFICANT (the firm's manual-sort convention) — do not
// "clean" them. Placeholders: {{case_type}} {{lfm_name}} {{contact_name}}
// {{case_id}} {{date}}
const DEFAULT_CASE_FOLDER_TEMPLATE =
  "/  Law Office/   Cases/  Potential Cases/  Potential - {{case_type}}/ {{lfm_name}} - {{case_id}} - {{date}}";

async function buildCaseFolderPath(db, { case_type, contact_name, lfm_name, case_id }) {
  let template = null;
  try {
    const [[row]] = await db.query(
      "SELECT `value` FROM app_settings WHERE `key` = 'dropbox_case_folder_templates' LIMIT 1"
    );
    if (row?.value) {
      const map = JSON.parse(row.value);
      if (map && typeof map === 'object') {
        template = map[case_type] ?? map.default ?? null;
      }
    }
  } catch (err) {
    console.warn(`[INTAKE] dropbox_case_folder_templates lookup failed, using default: ${err.message}`);
  }
  if (!template) template = DEFAULT_CASE_FOLDER_TEMPLATE;

  const values = {
    case_type:    case_type || "Other",
    contact_name: contact_name || "Unknown",
    lfm_name:     lfm_name || "Unknown",
    case_id:      String(case_id),
    date:         nowLocal().toFormat("yyyy-LL-dd"),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

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
 * Build the conflict candidates payload for 409/400 responses.
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
// POST /api/intake/contact
//
// Body (all optional unless noted; CREATE path requires fname AND lname):
//   name                   string   full name (run through parseName)
//   firstName / fname      string   alternative to name (camelCase preferred)
//   middleName / mname     string
//   lastName / lname       string
//   phone                  string   normalized to 10 digits
//   email                  string   trimmed + lowercased downstream
//   duplicate              string   "duplicate" to force new contact
//   contact_address, contact_city, contact_state, contact_zip,
//   contact_dob, contact_ssn, contact_phone2, contact_email2,
//   contact_pname, contact_tags, contact_notes, contact_type — all optional
//
// Query:
//   force_contact_id       int      disambiguates 2+ matches; must be among
//                                    candidate ids or returns 400
//
// Response statuses:
//   200 — created / updated
//   400 — bad input (invalid phone digits, force_contact_id not among matches,
//                    incoherent flag combo, name missing on CREATE path)
//   409 — divergence: multiple candidate contacts, no force_contact_id given
//   500 — unexpected
// ─────────────────────────────────────────────────────────────
router.post("/api/intake/contact", jwtOrApiKey, async (req, res) => {
  const {
    name,
    firstName, middleName, lastName,
    phone, email,
    duplicate = "update",
  } = req.body;

  // ── force_contact_id (query param, not body — matches Slice 3 ?force convention) ──
  let forceContactId = null;
  if (req.query.force_contact_id !== undefined && req.query.force_contact_id !== '') {
    const n = parseInt(req.query.force_contact_id, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== String(req.query.force_contact_id).trim()) {
      return res.status(400).json({
        status: "error",
        message: "force_contact_id must be a positive integer",
      });
    }
    forceContactId = n;
  }

  // ── Incoherent flag combo: duplicate=duplicate forces CREATE, force_contact_id
  //    targets a specific existing contact. They contradict each other. ──
  if (duplicate === "duplicate" && forceContactId != null) {
    return res.status(400).json({
      status: "error",
      message: "duplicate=duplicate and force_contact_id cannot be combined",
    });
  }

  // ── Name fields — accept either camelCase (firstName/...) or db-style
  //    (fname/...). camelCase wins if both supplied for a given slot. ──
  const fName = (firstName  !== undefined) ? firstName  : req.body.fname;
  const mName = (middleName !== undefined) ? middleName : req.body.mname;
  const lName = (lastName   !== undefined) ? lastName   : req.body.lname;

  const hasExplicitParts = fName !== undefined || mName !== undefined || lName !== undefined;
  const hasName = typeof name === 'string' && name.trim() !== '';

  // Resolve to a parsed shape (for CREATE) and an explicit-slot map (for UPDATE).
  // nameForCreate is always {firstName, middleName, lastName} strings.
  // nameInUpdate maps DB column → value, ONLY for slots the caller actually
  // supplied (preserves partial-update fix).
  let nameForCreate = null;
  let nameInUpdate  = null;

  if (hasExplicitParts) {
    nameInUpdate = {};
    // null and '' both coerced to '' for these NOT NULL VARCHAR columns
    // (sending raw NULL would violate the schema's NOT NULL constraint
    // under strict SQL mode). Absent slots are skipped entirely.
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
    return res.status(400).json({ status: "error", message: "Invalid phone number" });
  }

  // ── Email normalization (light — defer real normalization to the service) ──
  const trimmedEmail = (typeof email === 'string' && email.trim() !== '') ? email.trim() : null;

  // ── Phase 1: optional start_date overrides for the primary phone/email
  //    child rows (orphan-adopt create-new branch). Only consumed on the
  //    CREATE path below; validated here so a malformed value fails fast.
  //    Format: 'YYYY-MM-DD'. Absent → undefined → createContact defaults to
  //    CURDATE() via COALESCE. ──
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const phoneStartDate = req.body.phone_start_date;
  const emailStartDate = req.body.email_start_date;
  if (phoneStartDate !== undefined && phoneStartDate !== null && phoneStartDate !== ''
      && !DATE_RE.test(phoneStartDate)) {
    return res.status(400).json({ status: 'error', message: 'phone_start_date must be YYYY-MM-DD' });
  }
  if (emailStartDate !== undefined && emailStartDate !== null && emailStartDate !== ''
      && !DATE_RE.test(emailStartDate)) {
    return res.status(400).json({ status: 'error', message: 'email_start_date must be YYYY-MM-DD' });
  }

  try {
    // ── Resolve candidates (skip when forcing CREATE or no identifiers) ──
    let matches = [];
    if (duplicate !== "duplicate" && (normalizedPhone || trimmedEmail)) {
      const result = await contactService.resolveContactsByValue(
        req.db,
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
        const conflicts = await buildConflicts(req.db, matches);
        return res.status(409).json({
          status:  "error",
          message: "Multiple contacts match — provide ?force_contact_id to disambiguate",
          conflicts,
        });
      }
      const picked = matches.find(m => m.contact_id === forceContactId);
      if (!picked) {
        const conflicts = await buildConflicts(req.db, matches);
        return res.status(400).json({
          status:  "error",
          message: `force_contact_id ${forceContactId} is not among matches`,
          conflicts,
        });
      }
      targetContactId = forceContactId;

    } else if (matches.length === 1) {
      // Single match — auto-update. Covers active-row, ended-row re-adopt,
      // single contact matching by phone OR email OR both.
      if (forceContactId != null && forceContactId !== matches[0].contact_id) {
        // Strict: if caller explicitly named a contact and it's NOT the sole
        // match, surface it rather than silently overriding intent.
        const conflicts = await buildConflicts(req.db, matches);
        return res.status(400).json({
          status:  "error",
          message: `force_contact_id ${forceContactId} is not among matches`,
          conflicts,
        });
      }
      targetContactId = matches[0].contact_id;

    } else if (forceContactId != null) {
      // 0 matches but caller named a contact — treat as a 400 rather than
      // silently creating something different from what the caller asked for.
      return res.status(400).json({
        status:  "error",
        message: `force_contact_id ${forceContactId} is not among matches`,
        conflicts: [],
      });
    }

    // ─────────────────────────────────────
    // UPDATE branch
    // ─────────────────────────────────────
    if (targetContactId != null) {
      const updateFields = {};

      // Name fields — only slots the caller actually provided
      if (nameInUpdate) {
        Object.assign(updateFields, nameInUpdate);
      }

      // phone/email — only if non-empty truthy supplied. Empty/null does NOT
      // clear (consistent with the legacy route's behavior). To clear a
      // primary phone/email, use PATCH /api/contacts/:id or the multi-value
      // child-table endpoints directly.
      if (normalizedPhone) updateFields.contact_phone = normalizedPhone;
      if (trimmedEmail)    updateFields.contact_email = trimmedEmail;

      // Other optional fields — preserve the legacy route's exact set so the
      // API surface doesn't expand under this slice. Skip undefined/null/''
      // (no clear semantic via this route).
      const UPDATE_OPTIONALS = [
        'contact_address', 'contact_city', 'contact_state', 'contact_zip',
        'contact_dob', 'contact_ssn',
        'contact_phone2', 'contact_email2',
        'contact_pname',
      ];
      for (const col of UPDATE_OPTIONALS) {
        const v = req.body[col];
        if (v !== undefined && v !== null && v !== '') {
          updateFields[col] = v;
        }
      }

      // INVARIANT: updateFields is non-empty whenever we reach here.
      // The only way to reach the UPDATE branch is via a successful match
      // in resolveContactsByValue (which requires phone or email in the
      // payload) or via ?force_contact_id pointing at one of those matches.
      // In all cases the identifying value lands in updateFields. If a
      // future change breaks that invariant, updateContact will throw
      // "updateContact requires at least one field" and surface as 500.

      await contactService.updateContact(req.db, targetContactId, updateFields);

      const [[updated]] = await req.db.query(
        'SELECT contact_name FROM contacts WHERE contact_id = ?',
        [targetContactId]
      );

      return res.json({
        status:     "success",
        message:    `client ${targetContactId} found and updated`,
        action:     "updated",
        id:         targetContactId,
        contact_id: targetContactId,
        name:       updated.contact_name,
      });
    }

    // ─────────────────────────────────────
    // CREATE branch
    // ─────────────────────────────────────
    if (!nameForCreate) {
      return res.status(400).json({
        status:  "error",
        message: "Name is required to create a contact (provide name, or firstName + lastName)",
      });
    }
    if (!nameForCreate.firstName || !nameForCreate.lastName) {
      return res.status(400).json({
        status:  "error",
        message: "Both firstName and lastName are required to create a contact",
      });
    }

    const created = await contactService.createContact(req.db, {
      fname:   nameForCreate.firstName,
      mname:   nameForCreate.middleName,
      lname:   nameForCreate.lastName,
      phone:   normalizedPhone || '',
      email:   trimmedEmail   || '',
      address: req.body.contact_address || '',
      city:    req.body.contact_city    || '',
      state:   req.body.contact_state   || '',
      zip:     req.body.contact_zip     || '',
      dob:     req.body.contact_dob     || null,
      phone2:  req.body.contact_phone2  || '',
      email2:  req.body.contact_email2  || '',
      pname:   req.body.contact_pname   || '',
      tags:    req.body.contact_tags    || '',
      notes:   req.body.contact_notes   || '',
      type:    req.body.contact_type    || 'Client',
      // Phase 1: pass through only when a valid value was supplied; null/''
      // falls through to createContact's COALESCE(?, CURDATE()) default.
      phone_start_date: (phoneStartDate && DATE_RE.test(phoneStartDate)) ? phoneStartDate : null,
      email_start_date: (emailStartDate && DATE_RE.test(emailStartDate)) ? emailStartDate : null,
    });

    // SSN handled separately — createContact doesn't accept it.
    if (req.body.contact_ssn) {
      await contactService.updateContact(req.db, created.contact_id, {
        contact_ssn: req.body.contact_ssn,
      });
    }

    // Manual "created" log — the after_contact_update trigger only fires on
    // UPDATE, so creations need an explicit log row. Track A.1 may revisit.
    await req.db.query(
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

    return res.json({
      status:     "success",
      message:    `client ${created.contact_id} added`,
      action:     "created",
      id:         created.contact_id,
      contact_id: created.contact_id,
      name:       created.contact_name,
    });

  } catch (err) {
    console.error("POST /api/intake/contact error:", err);
    res.status(500).json({ status: "error", message: "Failed to create/update contact" });
  }
});


// ─────────────────────────────────────────
// POST /api/intake/case
// Find or create a case for a contact
//
// Body:
//   contact_id   number   required
//   case_type    string   required — e.g. "Bankruptcy", "Other"
//   duplicate    string   "duplicate" to force new, otherwise "return" (default)
//   case_number       string optional (Phase 3) — short-form docket number,
//                            varchar(20). Empty string treated as absent.
//   case_number_full  string optional (Phase 4.2) — full-form docket number,
//                            varchar(20). Empty string treated as absent.
//
// Docket contract (Phase 3 case_number + Phase 4.2 case_number_full):
//   - EITHER field provided ⇒ ALWAYS create a new case carrying the supplied
//                             value(s), collision-checked against existing
//                             case_number AND case_number_full. The
//                             find-existing-by (contact_id, case_type) path is
//                             bypassed because it wouldn't apply the supplied
//                             number to the matched case, silently dropping
//                             caller intent. Equivalent to forcing
//                             duplicate='duplicate'.
//   - NEITHER field         ⇒ find-or-create per the `duplicate` flag
//                             (existing behavior, unchanged).
//
//   Both fields are independently optional — all four combinations are legal
//   (neither / short only / full only / both). Partial dockets are valid;
//   the firm sometimes knows the full number before the short, or vice versa.
//
//   case_number / case_number_full are OPAQUE free-text. This route NEVER
//   parses or validates docket SHAPE — only string length (≤20) and equality
//   (collision). The ##-#####-@@@ split is bankruptcy-specific client-side
//   convenience (splitDocket in scripts.js), never a server gate.
//
//   New inserts store NULL — never empty string — for any field not supplied,
//   for consistent downstream querying.
// ─────────────────────────────────────────
router.post("/api/intake/case", jwtOrApiKey, async (req, res) => {
  const { contact_id, case_type, duplicate = "return" } = req.body;

  if (!contact_id || !case_type) {
    return res.status(400).json({ status: "error", message: "contact_id and case_type are required" });
  }

  // ── Optional case_number (Phase 3) ──
  // Trim; empty-after-trim → NULL (absent). Enforce varchar(20) ceiling.
  let caseNumber = req.body.case_number;
  caseNumber = (typeof caseNumber === "string") ? caseNumber.trim() : "";
  if (caseNumber === "") caseNumber = null;
  if (caseNumber !== null && caseNumber.length > 20) {
    return res.status(400).json({ status: "error", message: "case_number exceeds 20 chars" });
  }

  // ── Optional case_number_full (Phase 4.2) ──
  // Same treatment as case_number: trim; empty → NULL; varchar(20) ceiling.
  // Opaque free-text — no shape parsing.
  let caseNumberFull = req.body.case_number_full;
  caseNumberFull = (typeof caseNumberFull === "string") ? caseNumberFull.trim() : "";
  if (caseNumberFull === "") caseNumberFull = null;
  if (caseNumberFull !== null && caseNumberFull.length > 20) {
    return res.status(400).json({ status: "error", message: "case_number_full exceeds 20 chars" });
  }

  try {
    // ── Collision check (only when a docket value was supplied) ──
    //    Guards the organic dedup invariant production has held without a DB
    //    constraint. Each SUPPLIED value (short and/or full) is checked against
    //    BOTH the case_number and case_number_full columns — a short number
    //    must not clash with another case's full, and vice versa. Fires
    //    regardless of the duplicate flag, and BEFORE the find-existing path,
    //    so a colliding number always wins (supersedes everything).
    //
    //    De-dupe the submitted values: if a caller sends the same string in
    //    both fields (or only one field), we still build a single IN-list, so
    //    the SQL has exactly as many placeholders as distinct values.
    //    Mirrors caseService.checkCaseNumberCollision, but without the
    //    `case_id <> ?` exclusion — there is no existing case on CREATE.
    const submittedDockets = [...new Set(
      [caseNumber, caseNumberFull].filter(v => v !== null)
    )];
    if (submittedDockets.length) {
      const placeholders = submittedDockets.map(() => "?").join(", ");
      const [clash] = await req.db.query(
        `SELECT case_id, case_number, case_number_full, case_type
           FROM cases
          WHERE (case_number      IS NOT NULL AND case_number      <> '' AND case_number      IN (${placeholders}))
             OR (case_number_full IS NOT NULL AND case_number_full <> '' AND case_number_full IN (${placeholders}))
          LIMIT 1`,
        [...submittedDockets, ...submittedDockets]
      );
      if (clash.length) {
        const c = clash[0];
        // Report the first supplied value in the message for a recognizable
        // identifier; the conflict payload carries the colliding case's columns.
        const reported = caseNumber || caseNumberFull;
        return res.status(409).json({
          status: "error",
          message: `case number "${reported}" already in use by case ${c.case_id}`,
          conflict: {
            case_id:          c.case_id,
            case_number:      c.case_number || null,
            case_number_full: c.case_number_full || null,
            case_type:        c.case_type,
          },
        });
      }
    }

    // ── Effective duplicate flag ──
    // Providing ANY docket value is an unambiguous "create a new case with this
    // number" signal. Force CREATE so find-existing can't swallow the intent.
    const effectiveDuplicate = (caseNumber !== null || caseNumberFull !== null)
      ? "duplicate"
      : duplicate;

    // ── Check for existing active case of same type ──
    if (effectiveDuplicate !== "duplicate") {
      const [existing] = await req.db.query(
        `SELECT cases.case_id
         FROM cases
         LEFT JOIN case_relate cr ON cases.case_id = cr.case_relate_case_id
         WHERE cr.case_relate_client_id = ?
           AND cr.case_relate_type = 'Primary'
           AND cases.case_stage IN ('Lead', 'Open', 'Pending', 'Filed')
           AND (cases.case_type = ? OR cases.case_type LIKE CONCAT(?, ' - Ch%'))
         ORDER BY cases.case_open_date DESC
         LIMIT 1`,
        [contact_id, case_type, case_type]
      );

      if (existing.length) {
        return res.json({
          status: "success",
          message: "case found",
          action: "found",
          id: existing[0].case_id
        });
      }
    }

    // ── Create new case with unique case_id ──
    let case_id;
    let inserted = false;
    let attempts = 0;

    while (!inserted && attempts < 10) {
      case_id = generateCaseId();
      attempts++;

      try {
        // Build the column/value lists conditionally. case_id, case_open_date,
        // and case_type are always present; case_number / case_number_full are
        // appended only when supplied. All four combinations are handled by
        // the same construction (neither / short / full / both). Columns NOT
        // listed rely on implicit defaults — the cases table is mostly
        // NOT-NULL with no DB defaults, which works only because the session
        // sql_mode is non-strict (STRICT_TRANS_TABLES absent). Do NOT add
        // strict mode without giving these columns real defaults first.
        const cols = ["case_id", "case_open_date", "case_type"];
        const vals = ["?", "CONVERT_TZ(NOW(), 'UTC', 'America/New_York')", "?"];
        const params = [case_id, case_type];

        if (caseNumber !== null) {
          cols.push("case_number");
          vals.push("?");
          params.push(caseNumber);
        }
        if (caseNumberFull !== null) {
          cols.push("case_number_full");
          vals.push("?");
          params.push(caseNumberFull);
        }

        await req.db.query(
          `INSERT INTO cases (${cols.join(", ")}) VALUES (${vals.join(", ")})`,
          params
        );
        inserted = true;
      } catch (err) {
        if (err.code !== "ER_DUP_ENTRY") throw err;
        // Collision — retry with new ID
      }
    }

    if (!inserted) {
      throw new Error("Failed to generate unique case ID after 10 attempts");
    }

    // ── Create case_relate link ──
    const [relateResult] = await req.db.query(
      `INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type)
       VALUES (?, ?, 'Primary')`,
      [case_id, contact_id]
    );

    // ── Log case creation ──
    await req.db.query(
      `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
       VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
      [
        case_id,
        JSON.stringify({ action: "case_created", case_type, contact_id })
      ]
    );

    // ── Respond first, then fire Dropbox webhook ──
    res.json({
      status: "success",
      message: "case created",
      action: "created",
      id: case_id,
      case_relate: relateResult.insertId
    });

    // ── Post-response: create Dropbox case folder natively + save shared link ──
    // (replaces the Pabbly 'create_dropbox_folder' bridge). Fully detached
    // fire-and-forget: response is already sent, so failures must log only —
    // never reach the route's catch (which would attempt a second response).
    (async () => {
      const [[contact]] = await req.db.query(
        "SELECT contact_name, contact_lfm_name FROM contacts WHERE contact_id = ?",
        [contact_id]
      );

      const folderPath = await buildCaseFolderPath(req.db, {
        case_type,
        contact_name: contact?.contact_name,
        lfm_name:     contact?.contact_lfm_name,
        case_id,
      });

      const result = await dropboxService.createFolderWithOptions(req.db, {
        path: folderPath,
        subfolders: ["Client Uploads"],
        shareLink: true,
      });

      if (result.shared_link) {
        await req.db.query(
          "UPDATE cases SET case_dropbox = ? WHERE case_id = ?",
          [result.shared_link, case_id]
        );
      }
      console.log(`[INTAKE] Dropbox folder ready for case ${case_id}: ${result.path}`);
    })().catch(err => console.error(`Dropbox folder creation failed for case ${case_id}:`, err.message));

  } catch (err) {
    console.error("POST /api/intake/case error:", err);
    res.status(500).json({ status: "error", message: "Failed to create case" });
  }
});

module.exports = router;