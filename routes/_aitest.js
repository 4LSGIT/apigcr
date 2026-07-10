// routes/_aitest.js  —  TEMPORARY. Delete after verifying the aiService slice.
//
// Auto-mounts via the server.js readdirSync loop. INERT unless
// AITEST_ENABLED=1 (when disabled, no routes are registered → default 404).
// Every endpoint also requires header
//   X-Aitest-Key: <AITEST_KEY env value>
// so it can't be poked by randoms even if the flag is left on.
//
//   /_aitest      → runs aiService.call(db,{promptKey:'echo',userInput:'ping'})
//                   and returns the JSON result (callId confirms an ai_calls row).
//   /_aitest/file → ?url=<https-url-to-a-public-pdf> — smoke test for the
//                   attachments slice: attaches the PDF by URL and asks haiku
//                   for a one-sentence summary.

const express = require('express');
const router = express.Router();
const aiService = require('../services/aiService');

const ENABLED = process.env.AITEST_ENABLED === '1';
const KEY = process.env.AITEST_KEY || '';

function gate(req, res, next) {
  if (!KEY || req.get('X-Aitest-Key') !== KEY) {
    return res.status(401).json({ error: 'bad aitest key' });
  }
  next();
}

if (ENABLED) {
  router.get('/_aitest', gate, async (req, res) => {
    try {
      const result = await aiService.call(req.db, {
        promptKey: 'echo',
        userInput: 'ping',
        outputType: 'text',
        consumerRef: 'aitest',
      });
      return res.json(result);
    } catch (err) {
      console.error('[aitest] call failed:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  });

  router.get('/_aitest/file', gate, async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return res.status(400).json({ error: 'url query param required (https)' });
    }
    try {
      const result = await aiService.call(req.db, {
        inlineSystem: 'Summarize the attached document in one sentence.',
        model: 'claude-haiku-4-5-20251001',
        attachments: [{ type: 'document', url }],
        outputType: 'text',
        timeout_ms: 90000,
        consumerRef: 'aitest_file',
      });
      return res.json(result);
    } catch (err) {
      console.error('[aitest] file call failed:', err.message);
      return res.status(500).json({ status: 'error', message: err.message });
    }
  });

  console.warn('[aitest] \u26a0 ai-test route ENABLED. Remove routes/_aitest.js before normal operation.');
}

module.exports = router;