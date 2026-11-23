// routes/api.casey.js — Casey v2 (ref/CASEY_V2_DESIGN.md).
//
// S0: one SU-only inspection read over the route catalog.
// S1: the tool layer (services/casey/tools) behind an SU-only TEST route —
//     no model call, nothing user-visible, dark while casey_v2_enabled = '0'.
// S2: the loop (services/casey/loop.js) — POST /api/casey/turn streams one
//     user turn as NDJSON; the chat routes read and delete a user's own
//     transcripts. SU only in S2 (design §6), dark while casey_v2_enabled = '0'.
// S3a: the page (public/casey.html). The turn and chat routes open to every
//     signed-in STAFF user (a JWT; a machine key is refused — the loop acts as
//     a person) while casey_v2_enabled is on: Fred's ruling 2026-11-22, no
//     pilot list — "just turn over". The flag is the switch: '0' darkens
//     them all and the shell loads the v1 pane instead. GET /api/casey/boot
//     tells the shell and the page which Casey is on; POST /api/casey/turn/stop
//     marks a running turn to end. The tools / catalog routes stay SU-only.
// S3b: cards. api_write (services/casey/tools/api_write.js) PROPOSES writes;
//     the turn ends with a `card` line; the page runs the steps as the user
//     through the shell's apiSend, claiming and settling each in the ledger
//     (services/casey/cards.js), then POST /api/casey/turn/resume feeds the
//     outcome — built from the ledger — to the model as the next user message.
//
//   GET  /api/casey/cards/:id                 → { status, card } (mine; steps with their content blocks)
//   POST /api/casey/cards/:id/claim {step}    → { status, outcome:'claimed', claim_token, step } | outcome 'applied' | 'unknown' | 'closed' | 'out_of_order'
//   POST /api/casey/cards/:id/settle {step, claim_token, status:'applied'|'failed', http_status, result}
//                                             → { status, settled:true } (404 when the token / state does not match)
//   POST /api/casey/cards/:id/decline {note?} → { status, declined:true } (409 unless the card is still proposed)
//   POST /api/casey/turn/resume {chat_id, card_id, context?}
//                                             → the NDJSON stream of /turn (the turn's user message is the card's outcome)
//
//   GET /api/casey/catalog?family=&class=&tier=&method=&q=&unknown=1
//     → { status:'success', summary, filters, rows:[...], unknown:[...] }
//   GET  /api/casey/tools            → { status, enabled, tools:[{name, description, input_schema}] }
//   POST /api/casey/tools/:name {input}
//     → the tool's envelope (services/casey/tools/index.js), run AS THE CALLER:
//       ctx comes from this request (its auth, headers, app, ip), so a tool
//       sees exactly what the superuser testing it may see. 403 when
//       casey_v2_enabled is '0' (lib/firmConfig; on unless '0', like every
//       casey_* switch — Fred seeds '0' before the deploy so v2 starts dark),
//       404 for an unknown tool name, 400 for a non-object input.
//   POST /api/casey/turn {chat_id?, text, context?, model?}
//     model (S3a-2): the user's pick for a NEW chat, one of boot.models; 400 off
//     the menu, 400 with a chat_id (an open chat keeps its model).
//     → 200 application/x-ndjson, one JSON object per line (the shape v1's
//       answer stream uses, read through apiSend(…, {responseType:'response'})):
//       {type:'chat', id, title, model, effort, created, prompt_version}
//       {type:'thinking', text}  {type:'delta', text}  {type:'reset'}
//       {type:'tool_call', id, name, input}
//       {type:'tool_result', id, name, ok, code, bytes, ms, truncated}
//       {type:'heartbeat'} (every 15 s while a tool or the model runs)
//       {type:'card', card:{id, tier, summary, status, steps:[{step_no, method, path, body, purpose, status, content, …}]}}
//                   (S3b: the turn ends on it; the final that follows has text '' and card_id)
//       {type:'final', body:{chat_id, message_id, seq, text, usage, cost_cents,
//                            calls, tool_calls, limited, card_id, ms, model, effort, prompt_version}}
//       {type:'error', status, message, detail?}  — a failure after the stream began
//     Before the stream begins the answer is plain JSON: 400 (text missing /
//     > 4,000 chars / bad chat_id), 403 (dark), 404 (not this user's chat),
//     409 (a turn is running in that chat), 429 (the firm's monthly AI cap).
//     Cache-Control: no-transform keeps compression() from buffering it.
//   GET    /api/casey/chats                → { status, chats:[{id, title, model, effort, …, message_count}] }
//   GET    /api/casey/chats/:id            → { status, chat, messages:[{id, seq, role, content, meta, created_at}] }
//   DELETE /api/casey/chats/:id            → { status, deleted:true } (messages cascade)
//     All three are the CALLER's chats only (chats.js scopes by user_id; a
//     superuser does not see another user's transcript in S2 — S4's review
//     view gets its own gate).
//
// `rows` are lib/routeCatalog.js rows for THIS instance's live app (req.app),
// built once per process. Filters are exact matches (family '/api/mail',
// class 'staff:can', tier 0–3, method 'POST') except `q`, a case-insensitive
// substring of the path. `unknown` is the list of routes the catalog could
// not classify — empty in a healthy deploy (tests/routeCatalog.test.js).
//
// Auth: superuserOnlyFor('casey') — JWT-only + SU + X-SU-Elevation + 30/min.
// The catalog is a map of every route and its gate: useful to an attacker
// as a target list, so it is not a staff read. Casey's own `lookup_routes`
// tool (S1) reads the same catalog in-process, filtered to what the asking
// user may reach. Auto-mounts via the routes/ scan in server.js.
//
// NEVER PROPOSABLE: `/api/casey/*` is on lib/caseySensitivity's list — Casey
// does not drive Casey.

'use strict';

const express = require('express');
const router = express.Router();
const { superuserOnlyFor } = require('../lib/auth.superuser');
const catalog = require('../lib/routeCatalog');

const guard = superuserOnlyFor('casey');
const jwtOrApiKey = require('../lib/auth.jwtOrApiKey');

function v2Enabled() {
  return require('../lib/firmConfig').cfg('casey_v2_enabled') !== '0'; // lazy require (convention)
}

// S3a: a signed-in staff PERSON (v1's staffOnly, same words) — the loop runs
// every tool as the caller, and a machine key is not someone to act as.
function staffOnly(req, res, next) {
  if (req.auth && req.auth.type === 'jwt' && req.auth.userId != null) return next();
  return res.status(403).json({ status: 'error', message: 'Casey requires a signed-in staff user.' });
}
// A View-as session (lib/auth.impersonation: the JWT carries viewAs /
// impersonator) is refused on every v2 route, reads included: a transcript is
// private to its user, superusers included (design §9 S2), and a View-as
// read would be another person reading it. v1's pane allows the read; v2
// does not (S3a review; Fred may relax it — it is one line).
function notViewAs(res, auth) {
  if (!(auth && (auth.viewAs || auth.impersonator))) return false;
  res.status(403).json({ status: 'error', message: 'Casey is not available in a View-as session.' });
  return true;
}
// One user's turns per hour (v1's execute limit; keyed u<userId>, in-process
// like every makeLimiter): the firm's monthly cap is shared with v1, so one
// runaway client must not be able to spend it. Checked in the handler, not as
// a gate name.
const turnLimited = require('../lib/rateLimiter').makeLimiter(60 * 60 * 1000, 60);
// The flag is checked INSIDE each handler (dark()), not as a middleware: a
// route-local gate is a NAME lib/routeCatalog.js must know, and a flag check
// is not an auth claim.
function dark(res) {
  if (v2Enabled()) return false;
  res.status(403).json({ status: 'error', message: 'Casey v2 is off (casey_v2_enabled = 0)' });
  return true;
}
const staff = [jwtOrApiKey, staffOnly];
const SETTLE_RESULT_MAX = 256 * 1024;   // bytes of a settle's `result` (the page trims a route's answer to this before posting)

router.get('/api/casey/catalog', ...guard, (req, res) => {
  try {
    const cat = catalog.catalogFor(req.app);
    const q = req.query || {};
    const family = typeof q.family === 'string' && q.family ? q.family : null;
    const cls = typeof q.class === 'string' && q.class ? q.class : null;
    const tier = q.tier !== undefined && q.tier !== '' ? Number(q.tier) : null;
    const method = typeof q.method === 'string' && q.method ? q.method.toUpperCase() : null;
    const needle = typeof q.q === 'string' && q.q ? q.q.toLowerCase() : null;
    if (cls && !catalog.CLASSES.includes(cls)) {
      return res.status(400).json({ status: 'error', message: `class must be one of ${catalog.CLASSES.join(', ')}` });
    }
    if (tier !== null && ![0, 1, 2, 3].includes(tier)) {
      return res.status(400).json({ status: 'error', message: 'tier must be 0, 1, 2 or 3' });
    }
    const rows = cat.rows.filter(r =>
      (!family || r.family === family) &&
      (!cls || r.authClass === cls) &&
      (tier === null || r.tier === tier) &&
      (!method || r.method === method) &&
      (!needle || r.path.toLowerCase().includes(needle)));
    res.json({
      status: 'success',
      builtAt: cat.builtAt,
      summary: catalog.summary(cat.rows),
      filters: { family, class: cls, tier, method, q: needle },
      count: rows.length,
      rows,
      unknown: cat.unknown,
    });
  } catch (err) {
    console.error('[api.casey] catalog error:', err);
    res.status(500).json({ status: 'error', message: 'Catalog request failed' });
  }
});

// ── S1: tool layer test route ─────────────────────────────────────────────
router.get('/api/casey/tools', ...guard, (req, res) => {
  const tools = require('../services/casey/tools'); // lazy require (convention)
  res.json({ status: 'success', enabled: v2Enabled(), tools: tools.definitions() });
});

router.post('/api/casey/tools/:name', ...guard, async (req, res) => {
  try {
    if (!v2Enabled()) {
      return res.status(403).json({ status: 'error', message: 'Casey v2 is off (casey_v2_enabled = 0)' });
    }
    const tools = require('../services/casey/tools'); // lazy require (convention)
    const input = req.body && req.body.input;
    if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
      return res.status(400).json({ status: 'error', message: 'input must be an object' });
    }
    const out = await tools.runTool(req.params.name, tools.ctxFromRequest(req, 'tool-test'), input || {});
    if (!out.ok && out.error && out.error.code === 'UNKNOWN_TOOL') {
      return res.status(404).json({ status: 'error', message: out.error.message });
    }
    res.json({ status: 'success', ...out });
  } catch (err) {
    console.error('[api.casey] tool run error:', err);
    res.status(500).json({ status: 'error', message: 'Tool run failed' });
  }
});

// ── S2: the loop ─────────────────────────────────────────────────────────
const NDJSON_HEADERS = Object.freeze({
  'Content-Type': 'application/x-ndjson; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Content-Type-Options': 'nosniff',
});

function chatIdParam(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// What the shell and the page need to know: which Casey is on, and the loop's limits.
router.get('/api/casey/boot', ...staff, (req, res) => {
  if (notViewAs(res, req.auth)) return;
  const loop = require('../services/casey/loop');   // lazy require (convention)
  res.json({
    status: 'success', enabled: v2Enabled(), model: loop.settingModel(), effort: loop.settingEffort(),
    models: loop.modelMenu(),   // the menu for a new chat (S3a-2): [{id, label, hint, default}]
    limits: { text_max: loop.TEXT_MAX, max_tool_calls: loop.MAX_TOOL_CALLS, max_turn_ms: loop.MAX_TURN_MS, max_chat_chars: loop.MAX_CHAT_CHARS },
    continue_text: loop.CONTINUE_TEXT,
  });
});

/** Validate the shared turn body and stream one turn (POST /turn and /turn/resume). `extra` adds to the loop's options after validation. */
async function streamTurn(req, res, { resume = false } = {}) {
  if (dark(res) || notViewAs(res, req.auth)) return;
  if (turnLimited(`u${req.auth.userId}`)) {
    return res.status(429).json({ status: 'error', message: 'You have asked Casey a lot of questions this hour. Try again later.' });
  }
  const loop = require('../services/casey/loop');   // lazy require (convention)
  const tools = require('../services/casey/tools');  // lazy require (convention)
  const body = req.body || {};
  let chatId = null;
  if (body.chat_id !== undefined && body.chat_id !== null) {
    chatId = chatIdParam(body.chat_id);
    if (chatId === null) return res.status(400).json({ status: 'error', message: 'chat_id must be a positive integer' });
  }
  let cardId = null;
  if (resume) {
    if (chatId === null) return res.status(400).json({ status: 'error', message: 'chat_id is required' });
    cardId = chatIdParam(body.card_id);
    if (cardId === null) return res.status(400).json({ status: 'error', message: 'card_id must be a positive integer' });
    if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') return res.status(400).json({ status: 'error', message: 'text must be a string' });
  } else if (typeof body.text !== 'string') return res.status(400).json({ status: 'error', message: 'text is required' });
  if (body.context !== undefined && body.context !== null && (typeof body.context !== 'object' || Array.isArray(body.context))) {
    return res.status(400).json({ status: 'error', message: 'context must be an object' });
  }
  if (body.model !== undefined && body.model !== null && typeof body.model !== 'string') {
    return res.status(400).json({ status: 'error', message: 'model must be a string' });
  }
  let streaming = false;
  let chatSeen = null;   // the turn's chat, from its `chat` line (S3c: what a disconnect stops)
  let closedEarly = false;   // the browser left before the `chat` line: stop the turn as soon as its chat is known
  const stopNow = (id) => { const chats = require('../services/casey/chats'); chats.requestStop(req.db, id, req.auth.userId).catch((e) => console.error('[api.casey] stop on disconnect failed:', e.message)); };   // lazy require (convention)
  const send = (event) => {
    if (event && event.type === 'chat') { chatSeen = event.id; if (closedEarly) stopNow(event.id); }
    if (res.writableEnded || res.destroyed) return;
    try { res.write(`${JSON.stringify(event)}\n`); } catch (_) { /* the browser went away */ }
  };
  // S3c: the browser went away mid-turn (a closed tab, a lost connection) — ask the turn to stop, exactly as the
  // Stop button does: the loop ends before its next model call, after the round in flight is stored. Nothing
  // before the `chat` line can be stopped (the claim is not taken yet); a turn that already ended is left alone.
  res.on('close', () => {
    if (res.writableEnded) return;
    if (chatSeen == null) { closedEarly = true; return; }
    stopNow(chatSeen);
  });
  try {
    await loop.runTurn(req.db, {
      ctx: tools.ctxFromRequest(req, 'casey'),
      chatId,
      text: typeof body.text === 'string' ? body.text : '',
      cardId,
      context: body.context || null,
      model: body.model || null,
      send,
      begin() {
        streaming = true;
        res.status(200).set(NDJSON_HEADERS);
        res.flushHeaders();
      },
    });
  } catch (err) {
    if (!streaming) {
      const status = Number(err && err.status) || 500;
      if (status >= 500) console.error('[api.casey] turn error:', err);
      return res.status(status).json({ status: 'error', message: status >= 500 ? 'Turn failed' : err.message });
    }
    console.error('[api.casey] turn error after the stream began:', err);
    send({ type: 'error', status: 500, message: 'Turn failed' });
  }
  if (!res.writableEnded) res.end();
}

router.post('/api/casey/turn', ...staff, (req, res) => streamTurn(req, res));
// S3b: continue the chat with a card's outcome (approved and run, or declined) as the user message.
router.post('/api/casey/turn/resume', ...staff, (req, res) => streamTurn(req, res, { resume: true }));

// ── S3b: cards ───────────────────────────────────────────────────────────
// The browser's side of the ledger (services/casey/cards.js): read the card,
// claim a step before sending its request, settle it after, or decline. All
// scoped to the caller's own cards; dark with the flag.
router.get('/api/casey/cards/:id', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const cards = require('../services/casey/cards'); // lazy require (convention)
    const id = chatIdParam(req.params.id);
    const card = id === null ? null : await cards.getCard(req.db, id, req.auth.userId);
    if (!card) return res.status(404).json({ status: 'error', message: 'No such card' });
    res.json({ status: 'success', card: cards.present(card) });
  } catch (err) {
    console.error('[api.casey] card read error:', err);
    res.status(500).json({ status: 'error', message: 'Card read failed' });
  }
});

router.post('/api/casey/cards/:id/claim', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const cards = require('../services/casey/cards'); // lazy require (convention)
    const id = chatIdParam(req.params.id);
    const step = chatIdParam(req.body && req.body.step);
    if (id === null || step === null) return res.status(400).json({ status: 'error', message: 'card id and step must be positive integers' });
    // S3c: a step whose path or body carries `$N.field` is resolved here, from the earlier steps' stored (redacted)
    // results, and the resolved path re-checked against the live catalog for THIS user and the card's tier.
    const cardRefs = require('../services/casey/cardRefs'); // lazy require (convention)
    const cat = catalog.catalogFor(req.app);
    const out = await cards.claimStep(req.db, id, req.auth.userId, step, { resolve: (s, earlier, card) => cardRefs.resolveStep(s, earlier, { cat, auth: req.auth, cardTier: card.tier }) });
    if (!out) return res.status(404).json({ status: 'error', message: 'No such card or step' });
    res.json({ status: 'success', ...out });
  } catch (err) {
    console.error('[api.casey] card claim error:', err);
    res.status(500).json({ status: 'error', message: 'Claim failed' });
  }
});

router.post('/api/casey/cards/:id/settle', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const cards = require('../services/casey/cards'); // lazy require (convention)
    const id = chatIdParam(req.params.id);
    const b = req.body || {};
    const step = chatIdParam(b.step);
    if (id === null || step === null) return res.status(400).json({ status: 'error', message: 'card id and step must be positive integers' });
    if (typeof b.claim_token !== 'string' || !b.claim_token) return res.status(400).json({ status: 'error', message: 'claim_token is required' });
    if (!['applied', 'failed'].includes(b.status)) return res.status(400).json({ status: 'error', message: 'status must be applied or failed' });
    // The ledger keeps 16 KB of a result; a settle carrying megabytes is not a route's answer the page should relay (review B1).
    if (b.result !== undefined && Buffer.byteLength(JSON.stringify(b.result) || '', 'utf8') > SETTLE_RESULT_MAX) {
      return res.status(413).json({ status: 'error', message: `result is larger than ${SETTLE_RESULT_MAX} bytes; send its first part` });
    }
    const httpStatus = Number.isInteger(b.http_status) && b.http_status >= 100 && b.http_status <= 599 ? b.http_status : null;
    const settled = await cards.settleStep(req.db, id, req.auth.userId, step, b.claim_token, { status: b.status, httpStatus, result: b.result });
    if (!settled) return res.status(404).json({ status: 'error', message: 'No claimed step matches that token' });
    res.json({ status: 'success', settled: true });
  } catch (err) {
    console.error('[api.casey] card settle error:', err);
    res.status(500).json({ status: 'error', message: 'Settle failed' });
  }
});

router.post('/api/casey/cards/:id/decline', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const cards = require('../services/casey/cards'); // lazy require (convention)
    const id = chatIdParam(req.params.id);
    if (id === null) return res.status(400).json({ status: 'error', message: 'card id must be a positive integer' });
    const note = req.body && req.body.note;
    if (note !== undefined && note !== null && typeof note !== 'string') return res.status(400).json({ status: 'error', message: 'note must be a string' });
    const card = await cards.getCard(req.db, id, req.auth.userId);
    if (!card) return res.status(404).json({ status: 'error', message: 'No such card' });
    const declined = await cards.declineCard(req.db, id, req.auth.userId, note ? note.trim().slice(0, cards.NOTE_MAX) : null);
    if (!declined) return res.status(409).json({ status: 'error', message: `This card is ${card.status}; only a proposed card can be declined` });
    res.json({ status: 'success', declined: true });
  } catch (err) {
    console.error('[api.casey] card decline error:', err);
    res.status(500).json({ status: 'error', message: 'Decline failed' });
  }
});

// The page's Stop: marks the running turn; the loop ends it before its next model call.
router.post('/api/casey/turn/stop', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const chats = require('../services/casey/chats'); // lazy require (convention)
    const id = chatIdParam(req.body && req.body.chat_id);
    if (id === null) return res.status(400).json({ status: 'error', message: 'chat_id must be a positive integer' });
    const chat = await chats.getChat(req.db, id, req.auth.userId);
    if (!chat) return res.status(404).json({ status: 'error', message: 'No such chat' });
    const marked = await chats.requestStop(req.db, id, req.auth.userId);
    res.json({ status: 'success', stopping: marked, running: !!chat.running_since });
  } catch (err) {
    console.error('[api.casey] stop error:', err);
    res.status(500).json({ status: 'error', message: 'Stop failed' });
  }
});

router.get('/api/casey/chats', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const chats = require('../services/casey/chats'); // lazy require (convention)
    const rows = await chats.listChats(req.db, req.auth.userId, req.query && req.query.limit);
    res.json({ status: 'success', chats: rows });
  } catch (err) {
    console.error('[api.casey] chats list error:', err);
    res.status(500).json({ status: 'error', message: 'Chat list failed' });
  }
});

router.get('/api/casey/chats/:id', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const chats = require('../services/casey/chats'); // lazy require (convention)
    const id = chatIdParam(req.params.id);
    const chat = id === null ? null : await chats.getChat(req.db, id, req.auth.userId);
    if (!chat) return res.status(404).json({ status: 'error', message: 'No such chat' });
    const messages = await chats.loadMessages(req.db, id);
    res.json({ status: 'success', chat, messages });
  } catch (err) {
    console.error('[api.casey] chat read error:', err);
    res.status(500).json({ status: 'error', message: 'Chat read failed' });
  }
});

router.delete('/api/casey/chats/:id', ...staff, async (req, res) => {
  if (dark(res) || notViewAs(res, req.auth)) return;
  try {
    const chats = require('../services/casey/chats'); // lazy require (convention)
    const id = chatIdParam(req.params.id);
    const deleted = id === null ? false : await chats.deleteChat(req.db, id, req.auth.userId);
    if (!deleted) return res.status(404).json({ status: 'error', message: 'No such chat' });
    res.json({ status: 'success', deleted: true });
  } catch (err) {
    console.error('[api.casey] chat delete error:', err);
    res.status(500).json({ status: 'error', message: 'Chat delete failed' });
  }
});

module.exports = router;
