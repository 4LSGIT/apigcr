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
 * EXTRACTED (2026-09, website-lead routing arc): the handlers' logic now
 * lives in services/intakeService.js (intakeContact / intakeCase), shared
 * with the intake_contact / intake_case internal functions. This file is a
 * thin HTTP mapper: it parses the query-string shapes, calls the service,
 * and maps the service's discriminated outcomes onto the EXACT response
 * bodies this route has always sent (tests/ycSync.test.js sniffs those
 * shapes — do not change a status, message, or key without checking it).
 *
 * Behavior contract and history — divergence 409s, partial-update fix,
 * docket opacity, judge role twin, the three bugs the Slice 3 B.2 rewrite
 * closed — are documented in the service header and inline there. One
 * ordering delta from the extraction: on case creation, the case.created
 * emit and the Dropbox folder ensure now fire inside the service (post-
 * insert, still fire-and-forget) instead of after res.json(). Both are
 * detached, so the response is delayed by scheduling cost only.
 *
 * Response statuses (unchanged):
 *   /contact — 200 created/updated · 400 bad input (invalid phone digits,
 *              force_contact_id not among matches, incoherent flag combo,
 *              name missing on CREATE path) · 409 divergence · 500
 *   /case    — 200 created/found · 400 bad input · 409 docket collision · 500
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");
const intakeService = require("../services/intakeService");

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
//   contact_pname, contact_tags, contact_notes, contact_type,
//   contact_kind, contact_org_name, phone_start_date, email_start_date
//
// Query:
//   force_contact_id       int      disambiguates 2+ matches; must be among
//                                    candidate ids or returns 400
// ─────────────────────────────────────────────────────────────
router.post("/api/intake/contact", jwtOrApiKey, async (req, res) => {
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

  try {
    const result = await intakeService.intakeContact(req.db, req.body, { forceContactId });

    switch (result.outcome) {
      case 'invalid':
        return res.status(400).json({ status: "error", message: result.message });

      case 'diverged':
        return res.status(409).json({
          status:  "error",
          message: "Multiple contacts match — provide ?force_contact_id to disambiguate",
          conflicts: result.conflicts,
        });

      case 'force_mismatch':
        return res.status(400).json({
          status:  "error",
          message: `force_contact_id ${result.forceContactId} is not among matches`,
          conflicts: result.conflicts,
        });

      case 'updated':
        return res.json({
          status:     "success",
          message:    `client ${result.contact_id} found and updated`,
          action:     "updated",
          id:         result.contact_id,
          contact_id: result.contact_id,
          name:       result.name,
        });

      case 'created':
        return res.json({
          status:     "success",
          message:    `client ${result.contact_id} added`,
          action:     "created",
          id:         result.contact_id,
          contact_id: result.contact_id,
          name:       result.name,
        });

      default:
        throw new Error(`intakeContact returned unknown outcome "${result.outcome}"`);
    }
  } catch (err) {
    console.error("POST /api/intake/contact error:", err);
    res.status(500).json({ status: "error", message: "Failed to create/update contact" });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/intake/case
//
// Body:
//   contact_id        number  required
//   case_type         string  required — e.g. "Bankruptcy", "Other"
//   case_subtype      string  optional — category refinement (e.g. "Chapter 7")
//   duplicate         string  "duplicate" to force new, otherwise "return" (default)
//   case_number       string  optional — short-form docket, opaque free-text
//   case_number_full  string  optional — full-form docket, opaque free-text
//
// Docket contract, collision semantics, and the judge role twin are
// documented in services/intakeService.js (intakeCase). This route never
// enables allowBlankType — case_type stays required on the HTTP surface.
// ─────────────────────────────────────────────────────────────
router.post("/api/intake/case", jwtOrApiKey, async (req, res) => {
  try {
    const result = await intakeService.intakeCase(req.db, req.body);

    switch (result.outcome) {
      case 'invalid':
        return res.status(400).json({ status: "error", message: result.message });

      case 'collision':
        return res.status(409).json({
          status: "error",
          message: `case number "${result.reported}" already in use by case ${result.conflict.case_id}`,
          conflict: result.conflict,
        });

      case 'found':
        return res.json({
          status: "success",
          message: "case found",
          action: "found",
          id: result.case_id,
        });

      case 'created':
        return res.json({
          status: "success",
          message: "case created",
          action: "created",
          id: result.case_id,
          case_relate: result.case_relate_id,
        });

      default:
        throw new Error(`intakeCase returned unknown outcome "${result.outcome}"`);
    }
  } catch (err) {
    console.error("POST /api/intake/case error:", err);
    res.status(500).json({ status: "error", message: "Failed to create case" });
  }
});

module.exports = router;
