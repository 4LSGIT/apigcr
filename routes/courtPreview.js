// routes/courtPreview.js  —  TEMPORARY. Commit-and-delete-later tuning tool.
//
// Auto-mounts via the server.js readdirSync loop. Drives the court-email
// extraction + executor in a NO-WRITES preview so you can pick/paste an email,
// tweak the prompt/model, and see exactly what the AI WOULD do — without
// touching court_ai_log / ai_change_log / any entity. (aiService still writes
// its ai_calls row for cost tracking; that's wanted.)
//
// All routes ride normal JWT auth (jwtOrApiKey → req.auth.userId). No custom
// header gate: auth comes in on apiSend's bearer token. Page is meant to be
// mounted inside the shell (a.html/b.html) so window.top.apiSend exists.
//
// Routes (absolute paths; the readdirSync loop app.use()s this router at root):
//   GET  /api/court-preview/prompt           → prompt + model prefill
//   GET  /api/court-preview/emails?q=<term>  → recent mieb emails for the picker
//   POST /api/court-preview/run              → run extraction + preview plan
//
// Delete this file (and public/courtPreview.html) once tuning is done.

const express     = require('express');
const router      = express.Router();
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

const aiService          = require('../services/aiService');
const { executeCourtActions } = require('../services/courtExecutor');
const { getPrompt }      = require('../lib/aiPrompts');

const MODELS = ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];

// ─────────────────────────────────────────────────────────────
// GET /api/court-preview/prompt — prefill the textarea + model selector
// ─────────────────────────────────────────────────────────────
router.get('/api/court-preview/prompt', jwtOrApiKey, async (req, res) => {
  try {
    const def = getPrompt('court_extract');
    if (!def) return res.status(500).json({ error: 'court_extract prompt not registered' });
    res.json({
      system:     def.system,
      model:      def.model,
      max_tokens: def.max_tokens,
      models:     MODELS,
    });
  } catch (err) {
    console.error('[courtPreview] /prompt error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/court-preview/emails?q= — picker source (newest first, mieb only)
//   q all digits → email_log.id = q ; else subject LIKE %q% ; always AND mieb.
//   empty q → latest 50.
// ─────────────────────────────────────────────────────────────
router.get('/api/court-preview/emails', jwtOrApiKey, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let sql, params;
    if (!q) {
      sql = `SELECT id, processed_at, subject FROM email_log
              WHERE from_email LIKE '%mieb%'
              ORDER BY id DESC LIMIT 50`;
      params = [];
    } else if (/^\d+$/.test(q)) {
      sql = `SELECT id, processed_at, subject FROM email_log
              WHERE id = ? AND from_email LIKE '%mieb%'
              ORDER BY id DESC LIMIT 50`;
      params = [Number(q)];
    } else {
      sql = `SELECT id, processed_at, subject FROM email_log
              WHERE subject LIKE ? AND from_email LIKE '%mieb%'
              ORDER BY id DESC LIMIT 50`;
      params = [`%${q}%`];
    }
    const [rows] = await req.db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[courtPreview] /emails error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/court-preview/run
//   body { sourceType:'log'|'paste', emailLogId?, subject?, body?,
//          promptOverride?, model? }
// ─────────────────────────────────────────────────────────────
router.post('/api/court-preview/run', jwtOrApiKey, async (req, res) => {
  try {
    const { sourceType, emailLogId, promptOverride, model } = req.body || {};
    let { subject, body } = req.body || {};
    let messageId, fromEmail;

    // 1) resolve source text
    if (sourceType === 'log') {
      if (!emailLogId) return res.status(400).json({ ok: false, error: 'emailLogId required for sourceType=log' });
      const [rows] = await req.db.query(
        `SELECT message_id, subject, body, from_email FROM email_log WHERE id = ? LIMIT 1`,
        [Number(emailLogId)]
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: 'email_log row not found' });
      messageId = rows[0].message_id;
      subject   = rows[0].subject;
      body      = rows[0].body;
      fromEmail = rows[0].from_email || '';
    } else {
      // paste
      subject   = subject || '';
      body      = body || '';
      messageId = `preview-${Date.now()}`;
      fromEmail = '';
    }

    // 2) extract via aiService (inlineSystem override when a non-blank prompt given)
    const def = getPrompt('court_extract');
    if (!def) return res.status(500).json({ ok: false, error: 'court_extract prompt not registered' });

    const usingOverride = !!(promptOverride && promptOverride.trim());
    const startedAt = Date.now();
    const extract = await aiService.call(req.db, {
      ...(usingOverride ? { inlineSystem: promptOverride } : { promptKey: 'court_extract' }),
      vars:       { message_id: messageId, subject, from_email: fromEmail },
      // SECURITY (prompt v3): subject + sender ride INSIDE <untrusted_user_input>
      // (prepended to the body), not the trusted system block. Mirrors the
      // court_extract internal_function + backtest call sites.
      userInput:  `SUBJECT: ${subject}\nFROM: ${fromEmail}\n\n${body}`,
      model:      model || def.model,
      max_tokens: def.max_tokens,
      outputType: 'json',
      consumerRef: 'court_preview',
    });
    const latency_ms = Date.now() - startedAt;

    // 3) extraction failed → return early (no executor call)
    if (!extract.ok || !extract.json) {
      return res.json({
        ok:     false,
        error:  extract.error || 'no_json',
        usage:  extract.usage || null,
        callId: extract.callId || null,
      });
    }

    // 4) build payload + run executor in PREVIEW (no writes)
    const payload = extract.json;
    payload.message_id = messageId;
    payload.ai_call_id = extract.callId;

    const plan = await executeCourtActions(req.db, { payload, subject, body, preview: true });

    // 5) respond
    const inTok  = extract.usage && extract.usage.input_tokens  || 0;
    const outTok = extract.usage && extract.usage.output_tokens || 0;
    res.json({
      ok:            true,
      model:         model || def.model,
      used_override: usingOverride,
      extract: {
        json:       extract.json,
        usage:      extract.usage,
        cost_cents: aiService.computeCostCents(inTok, outTok, model || def.model),
        callId:     extract.callId,
        latency_ms,
      },
      plan,
    });
  } catch (err) {
    console.error('[courtPreview] /run error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;