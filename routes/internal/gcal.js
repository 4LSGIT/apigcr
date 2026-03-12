/**
 * Internal Google Calendar Routes
 *
 * POST /internal/gcal/create  - create a calendar event for an appointment
 * POST /internal/gcal/delete  - delete a calendar event by gcal event ID
 *
 * Currently delegates to Pabbly (non-blocking fire-and-forget).
 * Webhook URL stored in app_settings:
 *   key: 'pabbly_internal_url'
 * Pabbly routes on payload field: service = 'gcal_create' | 'gcal_delete'
 *
 * TODO: replace Pabbly calls with direct Google Calendar API integration.
 *
 * Protected by jwtOrApiKey — internal use only.
 */

const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const pabbly = require("../../services/pabblyService");

// -------------------- CREATE --------------------
// Body:
//   appt_id       int     - appointment ID
//   appt_date     string  - datetime string
//   appt_length   int     - duration in minutes
//   appt_type     string
//   appt_platform string
//   contact_name  string
//   contact_email string  - optional, for invite
//   case_id       string  - optional
router.post("/internal/gcal/create", jwtOrApiKey, async (req, res) => {
  const {
    appt_id, appt_date, appt_length, appt_type,
    appt_platform, contact_name, contact_email, case_id
  } = req.body;

  if (!appt_id || !appt_date || !appt_length || !appt_type || !appt_platform) {
    return res.status(400).json({
      status: "error",
      message: "Missing required fields: appt_id, appt_date, appt_length, appt_type, appt_platform"
    });
  }

  try {
    pabbly.send(req.db, "gcal_create", {
      appt_id, appt_date, appt_length, appt_type,
      appt_platform, contact_name, contact_email, case_id
    });
    res.json({ status: "success", note: "gcal create queued" });
  } catch (err) {
    console.error("Internal gcal/create error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// -------------------- DELETE --------------------
// Body:
//   appt_gcal  string  - Google Calendar event ID (appts.appt_gcal)
//   appt_id    int     - for logging purposes
router.post("/internal/gcal/delete", jwtOrApiKey, async (req, res) => {
  const { appt_gcal, appt_id } = req.body;

  if (!appt_gcal) {
    return res.status(400).json({
      status: "error",
      message: "Missing required field: appt_gcal"
    });
  }

  try {
    pabbly.send(req.db, "gcal_delete", { appt_gcal, appt_id });
    res.json({ status: "success", note: "gcal delete queued" });
  } catch (err) {
    console.error("Internal gcal/delete error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;