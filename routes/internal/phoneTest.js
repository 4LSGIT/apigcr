// routes/internal/phoneTest.js
//
// TEMP test route for the phoneService refactor. JWT-guarded.
// REMOVE after Pass 2 migration is verified live.
//
// Endpoints:
//   GET  /internal/phone-test/lines  — diagnostic listing of phone_lines
//                                       joined with their credential row
//   POST /internal/phone-test/sms    — { from, to, message }
//   POST /internal/phone-test/mms    — { from, to, text, attachment_url }

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../../lib/auth.jwtOrApiKey');
const phoneService = require('../../services/phoneService');

router.get('/internal/phone-test/lines', jwtOrApiKey, async (req, res) => {
  try {
    const [lines] = await req.db.query(
      `SELECT pl.id, pl.phone_number, pl.display_name,
              pl.provider, pl.provider_id, pl.credential_id,
              pl.active, pl.mms_capable,
              c.name        AS credential_name,
              c.type        AS credential_type,
              c.oauth_status
         FROM phone_lines pl
         LEFT JOIN credentials c ON c.id = pl.credential_id
        ORDER BY pl.active DESC, pl.display_name`
    );
    res.json({ status: 'success', lines });
  } catch (err) {
    console.error('[phone-test] lines failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/internal/phone-test/sms', jwtOrApiKey, async (req, res) => {
  const { from, to, message } = req.body || {};
  if (!from || !to || !message) {
    return res.status(400).json({ status: 'error', message: 'Required body: from, to, message' });
  }
  try {
    const result = await phoneService.sendSms(req.db, from, to, message);
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[phone-test] sms failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/internal/phone-test/mms', jwtOrApiKey, async (req, res) => {
  const { from, to, text, attachment_url } = req.body || {};
  if (!from || !to || !attachment_url) {
    return res.status(400).json({ status: 'error', message: 'Required body: from, to, attachment_url' });
  }
  try {
    const result = await phoneService.sendMms(req.db, from, to, text || '', attachment_url);
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[phone-test] mms failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;