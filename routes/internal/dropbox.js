// routes/internal/dropbox.js
//
// POST /internal/dropbox/create-folder
// Body: { case_id }  — any other fields (legacy contact_name / case_number
// sent by caseV1.html and case.html) are accepted and IGNORED: the server
// derives everything from the case row and its Primary contact, which also
// neutralizes the historical payload disagreement between the two shells
// (one sent FML, the other LFM). No shell edits required.
//
// Native, stage-aware replacement for the Pabbly 'dropbox_create_folder'
// bridge. Delegates to caseService.ensureCaseDropboxFolder:
//   - case has a docket number → Active-tree convention + staff subfolders
//   - otherwise → Potential-tree convention (+ Client Uploads)
//   - case_dropbox already set → returns the existing link, touches nothing
// The shared link is awaited and returned (errors now surface to the
// case-page Swal instead of vanishing inside Pabbly).
//
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../../lib/auth.jwtOrApiKey");
const caseService = require("../../services/caseService");

router.post('/internal/dropbox/create-folder', jwtOrApiKey, async (req, res) => {
  const { case_id } = req.body || {};
  if (!case_id) return res.status(400).json({ status: 'error', message: 'case_id required' });

  try {
    const result = await caseService.ensureCaseDropboxFolder(req.db, case_id);
    res.json({
      status: 'success',
      message: result.existed
        ? 'Case already has a Dropbox folder link'
        : `Dropbox ${result.stage} folder created`,
      ...result,
    });
  } catch (err) {
    const status = (err.message || '').includes('not found') ? 404 : 500;
    console.error(`POST /internal/dropbox/create-folder error (case ${case_id}):`, err.message);
    res.status(status).json({ status: 'error', message: err.message });
  }
});

router.get('/internal/hello', async (req, res) => {
    res.json({ status: 'success', message: 'hello' });
});

module.exports = router;