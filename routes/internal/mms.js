// routes/internal/mms.js
//
/**
 * Internal MMS Send Route
 *
 * POST /internal/mms/send
 * Body: { from, to, text, attachment_url }
 *
 * - JWT or API key (works with apiSend)
 * - URL attachment only (no file upload)
 * - phoneService validates the line is active + mms_capable + has a
 *   credential, and dispatches to the correct adapter.
 *
 * GRANT GATE (mailbox-system arc S-PH, ruling 2026-10-12): a STAFF-JWT caller
 * — the contact Communicate tab, the sending forms — must hold can_send on
 * the line `from` names (SU: always; the attorney READ bypass does not
 * send): phoneCommsService.staffSendGate, the same rule as the comms hub's
 * POST /api/phone-lines/:id/sms. API-key callers (automations, the internal
 * key) stay grant-blind (D6). Checked before anything is dispatched.
 */

const express      = require('express');
const router       = express.Router();
const jwtOrApiKey  = require('../../lib/auth.jwtOrApiKey');
const phoneService = require('../../services/phoneService');
const { staffSendGate } = require('../../services/phoneCommsService');

router.post('/internal/mms/send', jwtOrApiKey, async (req, res) => {
  const { from, to, text, attachment_url } = req.body || {};

  if (!from || !to) {
    return res.status(400).json({ status: 'error', message: 'Missing from or to' });
  }
  if (!attachment_url) {
    return res.status(400).json({ status: 'error', message: 'Missing attachment_url' });
  }

  try {
    if (req.auth && req.auth.type === 'jwt') {
      const gate = await staffSendGate(req.db, req.auth.userId, from);
      if (!gate.ok) return res.status(gate.status).json({ status: 'error', message: gate.message });
    }
    const result = await phoneService.sendMms(req.db, from, to, text || '', attachment_url);
    res.json({ status: 'success', result });
  } catch (err) {
    console.error('[MMS] Send failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
