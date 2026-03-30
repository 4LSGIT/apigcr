/**
 * Internal Sequence Routes
 *
 * POST /internal/sequence/enroll  - enroll a contact in a sequence
 *
 * Currently delegates to Pabbly (non-blocking fire-and-forget).
 * Webhook URL stored in app_settings:
 *   key: 'pabbly_internal_url'
 * Pabbly routes on payload field: service = 'sequence_enroll'
 *
 * TODO: replace Pabbly call with direct workflow engine trigger
 *       once sequences are fully migrated to internal engine.
 *
 * Protected by jwtOrApiKey — internal use only.
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const pabbly = require("../../services/pabblyService");


// -------------------- ENROLL --------------------
// Body:
//   contact_id    int     - required
//   sequence_type string  - e.g. 'no_show', 'post_consult' etc.
//   appt_id       int     - optional, context for the enrollment
//   case_id       string  - optional
//   note          string  - optional
router.post("/internal/sequence/enroll", jwtOrApiKey, async (req, res) => {
  const { contact_id, sequence_type, appt_id, case_id, note } = req.body;

  if (!contact_id || !sequence_type) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: contact_id, sequence_type"
    });
  }

  try {
    pabbly.send(req.db, "sequence_enroll", {
      contact_id, sequence_type, appt_id, case_id, note
    });

    res.json({ status: "success", note: "sequence enrollment queued" });
  } catch (err) {
    console.error("Internal sequence/enroll error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;