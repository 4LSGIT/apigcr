const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const pabbly = require("../../services/pabblyService");

// POST /internal/dropbox/create-folder
// Body: { case_id, contact_name, case_number }
router.post('/internal/dropbox/create-folder', jwtOrApiKey, async (req, res) => {
  const { case_id, contact_name, case_number } = req.body;
  if (!case_id) return res.status(400).json({ status: 'error', message: 'case_id required' });

  pabbly.send(req.db, 'dropbox_create_folder', { case_id, contact_name, case_number });
  res.json({ status: 'success', message: 'Dropbox folder creation queued' });
});

router.get('/internal/hello', async (req, res) => {
    res.json({ status: 'success', message: 'hello' });
});

module.exports = router;