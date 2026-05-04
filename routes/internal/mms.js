/**
 * Internal MMS Send Route
 * 
 * POST /internal/mms/send
 * Body: { from, to, text, attachment_url }
 * 
 * - JWT authenticated (works with apiSend)
 * - from must be an active phone line with mms_capable=1 in phone_lines
 *   (capability check, not provider check — see migration that backfills
 *   mms_capable=1 for ringcentral lines)
 * - URL attachment only (no file upload)
 * - Delegates to ringcentralService.sendMms()
 *
 * Add to your existing internal routes file, or mount separately:
 *   app.use('/', require('./routes/internal.mms'));
 */

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../../lib/auth.jwtOrApiKey');
const ringcentral = require('../../services/ringcentralService');

// Ensure RC token is loaded
router.use(async (req, res, next) => {
  try {
    if (ringcentral.loadToken) await ringcentral.loadToken(req.db);
  } catch (err) {
    console.error('[MMS] Token load failed:', err);
  }
  next();
});

router.post('/internal/mms/send', jwtOrApiKey, async (req, res) => {
  const { from, to, text, attachment_url } = req.body;

  if (!from || !to) {
    return res.status(400).json({ status: 'error', message: 'Missing from or to' });
  }
  if (!attachment_url) {
    return res.status(400).json({ status: 'error', message: 'Missing attachment_url' });
  }

  // Validate: from must be an active mms_capable line.
  // Capability is read from the phone_lines.mms_capable flag rather than
  // inferred from provider — keeps the door open for future MMS-capable
  // providers to opt in with a row update.
  const fromClean = from.toString().replace(/\D/g, '').slice(-10);
  try {
    const [[line]] = await req.db.query(
      `SELECT provider, active, mms_capable FROM phone_lines WHERE phone_number = ? LIMIT 1`,
      [fromClean]
    );

    if (!line) {
      return res.status(400).json({ status: 'error', message: `No phone line found for ${from}` });
    }
    if (!line.active) {
      return res.status(400).json({ status: 'error', message: `Phone line ${from} is inactive` });
    }
    if (!line.mms_capable) {
      return res.status(400).json({ status: 'error', message: `Phone line ${from} is not MMS-capable (provider=${line.provider})` });
    }

    const result = await ringcentral.sendMms(
      req.db,
      fromClean,
      to,
      text || '',
      'US',
      null,  // no buffer
      null,  // no filename
      null,  // no mimetype
      attachment_url,
      false  // don't store attachment
    );

    res.json({ status: 'success', result });

  } catch (err) {
    console.error('[MMS] Send failed:', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;