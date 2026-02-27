const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");



// ====================== FAKE /api/leads FOR TESTING ======================
router.get('/api/leads', jwtOrApiKey, (req, res) => {
  // Fake data – matches exactly what tabLeadsGet expects
  const fakeLeads = [
    {
      case_id: "0A6Ui6sp",
      case_type: "Bankruptcy - Ch. 7",
      case_stage: "Lead",
      case_status: "Waiting on docs",
      open: "February 12, 2026",
      case_1st_course: "Sent Info",
      case_pre_petition: "Sent",
      case_notes: "Client still needs to sign contract",
      contacts: JSON.stringify([
        { contact_name: "John Doe", contact_id: 1515, contact_relate: "Primary" }
      ])
    },
    {
      case_id: "1B7Vj7tq",
      case_type: "Bankruptcy - Ch. 13",
      case_stage: "Lead",
      case_status: "Initial call",
      open: "February 20, 2026",
      case_1st_course: "Received",
      case_pre_petition: "",
      case_notes: "",
      contacts: JSON.stringify([
        { contact_name: "Jane Smith", contact_id: 1523, contact_relate: "Primary" },
        { contact_name: "Bob Smith", contact_id: 1524, contact_relate: "Secondary" }
      ])
    },
    {
      case_id: "2C8Wk8ur",
      case_type: "Bankruptcy - Ch. 7",
      case_stage: "Lead",
      case_status: "Docs uploaded",
      open: "February 25, 2026",
      case_1st_course: "",
      case_pre_petition: "Signed",
      case_notes: "Ready to file next week",
      contacts: JSON.stringify([
        { contact_name: "Alice Johnson", contact_id: 1531, contact_relate: "Primary" }
      ])
    }
  ];

  const total = 23; // just for pagination testing

  res.json({
    leads: fakeLeads,
    counter: total
  });
});

module.exports = router;