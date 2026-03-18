/**
 * TEMPORARY — Intake Routes (Contact & Case Creation)
 * ----------------------------------------
 * POST /api/intake/contact    create or update a contact by phone match
 * POST /api/intake/case       find or create a case for a contact
 *
 * These are temporary routes replacing the Pabbly "newClient" and "newCase"
 * workflows. When the full /api/contacts and /api/cases routes are designed,
 * these should be incorporated or replaced.
 *
 * Contact creation:
 *   - Looks up by phone number
 *   - If found and duplicate != "duplicate" → update fname/mname/lname/phone/email
 *   - If not found or duplicate == "duplicate" → insert new contact
 *   - MySQL triggers auto-derive contact_name, contact_lfm_name, contact_rname
 *   - MySQL after-update trigger auto-logs field changes
 *
 * Case creation:
 *   - Looks for existing active case of same type for this contact
 *   - If found and duplicate != "duplicate" → return existing case_id
 *   - If not found or duplicate == "duplicate" → create new case + case_relate
 *   - Fire-and-forget Pabbly webhook for Dropbox folder creation
 *
 * Replaces:
 *   - Pabbly mode=newClient workflow
 *   - Pabbly mode=newCase workflow (partly — Dropbox still via Pabbly)
 *   - routes/create-case.js (old auth pattern, string interpolation)
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const { parseName } = require("../lib/parseName");
const pabbly = require("../services/pabblyService");

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Generate an 8-char alphanumeric case ID using crypto.
 * Replaces the old Math.random() version in create-case.js.
 */
function generateCaseId() {
  // 6 random bytes → base64url → take first 8 chars
  // Gives ~48 bits of entropy, plenty for this use case
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

/**
 * Normalize phone to 10-digit string.
 * Returns null if empty, false if invalid.
 */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;
  // Strip leading 1 for 11-digit US numbers
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length !== 10) return false;
  return digits;
}


// ─────────────────────────────────────────
// POST /api/intake/contact
// Create or update a contact by phone match
//
// Body:
//   name       string   required — full name (run through parseName)
//   phone      string   required — phone number
//   email      string   optional
//   duplicate  string   "duplicate" to force new, otherwise "update" (default)
// ─────────────────────────────────────────
router.post("/api/intake/contact", jwtOrApiKey, async (req, res) => {
  const { name, phone, email, duplicate = "update" } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ status: "error", message: "Name and phone are required" });
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return res.status(400).json({ status: "error", message: "Invalid phone number" });
  }

  const parsed = parseName(name);

  try {
    // Look up existing contact by phone
    const [existing] = await req.db.query(
      "SELECT contact_id, contact_name FROM contacts WHERE contact_phone = ? LIMIT 1",
      [normalizedPhone]
    );

    if (existing.length && duplicate !== "duplicate") {
      // ── UPDATE existing contact ──
      const contact = existing[0];

      await req.db.query(
        `UPDATE contacts
         SET contact_fname = ?,
             contact_mname = ?,
             contact_lname = ?,
             contact_phone = ?,
             contact_email = COALESCE(NULLIF(?, ''), contact_email)
         WHERE contact_id = ?`,
        [parsed.firstName, parsed.middleName, parsed.lastName, normalizedPhone, email || "", contact.contact_id]
      );

      // Re-fetch to get trigger-derived name fields
      const [[updated]] = await req.db.query(
        "SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?",
        [contact.contact_id]
      );

      return res.json({
        status: "success",
        message: `client ${contact.contact_id} found and updated`,
        action: "updated",
        id: contact.contact_id,
        name: updated.contact_name
      });
    }

    // ── INSERT new contact ──
    const [result] = await req.db.query(
      `INSERT INTO contacts (contact_fname, contact_mname, contact_lname, contact_phone, contact_email)
       VALUES (?, ?, ?, ?, ?)`,
      [parsed.firstName, parsed.middleName, parsed.lastName, normalizedPhone, email || null]
    );

    const newId = result.insertId;

    // Re-fetch for trigger-derived name
    const [[newContact]] = await req.db.query(
      "SELECT contact_id, contact_name FROM contacts WHERE contact_id = ?",
      [newId]
    );

    // Log new contact creation
    await req.db.query(
      `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
       VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
      [
        newId,
        JSON.stringify({
          contact_id: newId,
          action: "created",
          contact_name: newContact.contact_name,
          contact_phone: normalizedPhone,
          contact_email: email || null
        })
      ]
    );

    return res.json({
      status: "success",
      message: `client ${newId} added`,
      action: "created",
      id: newId,
      name: newContact.contact_name
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
//   contact_id  number   required
//   case_type   string   required — e.g. "Bankruptcy", "Other"
//   duplicate   string   "duplicate" to force new, otherwise "return" (default)
// ─────────────────────────────────────────
router.post("/api/intake/case", jwtOrApiKey, async (req, res) => {
  const { contact_id, case_type, duplicate = "return" } = req.body;

  if (!contact_id || !case_type) {
    return res.status(400).json({ status: "error", message: "contact_id and case_type are required" });
  }

  try {
    // ── Check for existing active case of same type ──
    if (duplicate !== "duplicate") {
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
        await req.db.query(
          `INSERT INTO cases (case_id, case_open_date, case_type)
           VALUES (?, CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?)`,
          [case_id, case_type]
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

    // ── Post-response: Pabbly creates Dropbox folder and updates case_dropbox ──
    // Fetch contact lfm_name for Dropbox folder naming
    const [[contact]] = await req.db.query(
      "SELECT contact_lfm_name FROM contacts WHERE contact_id = ?",
      [contact_id]
    );

    pabbly.send(req.db, "create_dropbox_folder", {
      case_id,
      contact_lfm_name: contact?.contact_lfm_name || "Unknown",
      case_type
    }).catch(err => console.error("Dropbox webhook failed:", err.message));

  } catch (err) {
    console.error("POST /api/intake/case error:", err);
    res.status(500).json({ status: "error", message: "Failed to create case" });
  }
});

module.exports = router;