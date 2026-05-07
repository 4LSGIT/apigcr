/**
 * Internal MMS Route — v2 (driver layer)
 * POST /internal/mms/v2/send
 *
 * Parallel to /internal/mms/send. Routes through phoneDriverDispatcher
 * instead of ringcentralService. Slice 1 reaches the fake driver only;
 * real drivers land in slices 2 and 3.
 *
 * Differs from v1 deliberately:
 *   - No router.use() middleware that calls ringcentral.loadToken on
 *     every request. Token acquisition is a driver concern in v2; the
 *     fake driver needs nothing, real drivers will fetch credentials via
 *     buildHeadersForCredential themselves.
 *   - Success body is the raw dispatcher result — `{ provider_message_id,
 *     raw }` — NOT v1's `{ status:'success', result }` wrapper. Matches
 *     slice 1 exit criteria.
 *
 * Body:
 *   from             string  - 10-digit number, mms_capable=1, non-NULL
 *                              driver_key
 *   to               string  - recipient number (any common format)
 *   text             string  - optional message body
 *   attachment_url   string  - publicly fetchable URL
 */

const express = require('express');
const router = express.Router();
const jwtOrApiKey = require('../../lib/auth.jwtOrApiKey');
const phoneDriverDispatcher = require('../../services/phoneDriverDispatcher');

router.post('/internal/mms/v2/send', jwtOrApiKey, async (req, res) => {
  const { from, to, text, attachment_url } = req.body;

  if (!from || !to) {
    return res.status(400).json({ status: 'error', message: 'Missing from or to' });
  }
  if (!attachment_url) {
    return res.status(400).json({ status: 'error', message: 'Missing attachment_url' });
  }

  try {
    const result = await phoneDriverDispatcher.sendMms(req.db, from, {
      to,
      text: text || '',
      attachment_url,
    });
    res.json(result);
  } catch (err) {
    console.error('Internal MMS v2 error:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;