/**
 * Internal SMS Route — v2 (driver layer)
 * POST /internal/sms/v2/send
 *
 * Parallel to /internal/sms/send. Routes through phoneDriverDispatcher
 * instead of smsService. Slice 1 reaches the fake driver only; real
 * drivers (Quo, RingCentral) land in slices 2 and 3.
 *
 * Auth + error envelope mirror v1 (see routes/internal/sms.js). Success
 * body is the raw dispatcher result — `{ provider_message_id, raw }` —
 * NOT v1's `{ status:'success', data }` wrapper. This is intentional and
 * matches slice 1 exit criteria.
 *
 * Body:
 *   from     string  - 10-digit number matching phone_lines.phone_number
 *                       with non-NULL driver_key
 *   to       string  - recipient number (any common format)
 *   message  string  - text content
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../../lib/auth.jwtOrApiKey');
const phoneDriverDispatcher = require('../../services/phoneDriverDispatcher');

router.post('/internal/sms/v2/send', jwtOrApiKey, async (req, res) => {
  const { from, to, message } = req.body;

  if (!from || !to || !message) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required fields: from, to, message',
    });
  }

  try {
    const result = await phoneDriverDispatcher.sendSms(req.db, from, { to, message });
    res.json(result);
  } catch (err) {
    console.error('Internal SMS v2 error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;