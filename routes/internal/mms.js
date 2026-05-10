/**
 * Internal MMS Send Route
 *
 * POST /internal/mms/send
 * Body: { from, to, text, attachment_url }
 *
 * - JWT authenticated (works with apiSend)
 * - URL attachment only (no file upload)
 * - phoneService validates the line is active + mms_capable + has a
 *   credential, and dispatches to the correct adapter.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../../lib/auth.jwtOrApiKey');
const phoneService = require('../../services/phoneService');

router.post('/internal/mms/send', jwtOrApiKey, async (req, res) => {
  const { from, to, text, attachment_url } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({ status: 'error', message: 'Missing from or to' });
  }
  if (!attachment_url) {
    return res.status(400).json({ status: 'error', message: 'Missing attachment_url' });
  }

  try {
    const result = await phoneService.sendMms(req.db, from, to, text || '', attachment_url);
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[MMS] Send failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;