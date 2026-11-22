// services/casey/loop.js — Casey v2 S2: the tool-use loop (ref/CASEY_V2_DESIGN.md
// §4.6; as built §9 S2).
//
// runTurn(db, opts) runs ONE user turn of one chat: it appends the user
// message, calls the model with the six S1 tools (aiService.converse), runs
// every tool_use block AS THE USER (services/casey/tools.runTool with the
// request's own ctx), appends the results as tool_result blocks, and repeats
// until the model answers in text. Each event is written to `send` as the
// route streams it (NDJSON). State is the raw block array in casey_messages,
// stored EXACTLY as sent or received, so the next turn — on any instance —
// replays it byte-for-byte (thinking blocks are bound to the model and to the
// exact prefix).
//
// The prefix is kept constant by construction: the system prompt and the tool
// definitions are byte-identical per deploy (lib/caseyPrompt.signature), the
// model and effort are frozen on the chat, and everything volatile — the time,
// who is asking — rides in the FIRST text block of each user message
// (contextBlock), never in `system`. A chat built under another signature (a
// deploy changed the prompt or a tool) has its stored thinking blocks dropped
// before the call — the API accepts a history without them; it refuses one
// with blocks bound to a different prefix — and that drop is made PERMANENT by
// raising casey_chats.thinking_floor_seq to the first row kept (chats.js
// loadMessages strips below the floor on every later load); the chat is
// re-stamped on release, together with the floor, never without it. A 400
// whose provider message names thinking (the binding tripped anyway) gets the
// same treatment once within the turn — floor = the request's last message.
// A history whose last stored row is an assistant tool_use with no result (an
// instance killed mid-round) is REPAIRED on load: the new user message opens
// with one is_error tool_result per orphan, so the chat stays valid; an
// assistant answer that is empty or still carries tool_use under a non-tool
// stop is stored text-only for the same reason.
//
// Where the loop STOPS, and what it stores:
//   end_turn (or anything but tool_use)  the blocks verbatim; final.text = the text blocks
//   tool_use                             the blocks verbatim, then one user message of
//                                        tool_result blocks (envelope JSON, is_error when
//                                        ok:false), and round again
//   max_tokens                           nothing stored; ONE retry at MAX_TOKENS_RETRY;
//                                        a second cut stores a TEXT-ONLY assistant message
//                                        (the cut blocks cannot be replayed) → limited
//   refusal                              a text-only assistant message; no tool runs
//   budget (MAX_TOOL_CALLS or MAX_TURN_MS reached after a round of tools)
//                                        the tool_result message gets a closing text block
//                                        telling the model to answer now; one more call; a
//                                        tool_use answer to THAT is stored text-only → limited
//   a model error                        the turn fails (error line). The rows already
//                                        stored this turn stay — they are what was sent —
//                                        except when only the opening user row exists:
//                                        that one is removed (and a chat created by this
//                                        turn with it) so the retry is a clean retry.
//   a 400 naming thinking                once: drop the stored thinking blocks and retry
//                                        (the binding tripped despite the signature)
// `limited: true` on the final lets S3 offer "Keep going". A client that
// disconnects does not stop the turn: it runs to a consistent end and the
// transcript shows it. The spend cap (services/casey/spend.js) is checked
// before EVERY model call. Tools of one round run in parallel; results keep
// the model's order.
'use strict';

const { DateTime } = require('luxon');
const aiService = require('../aiService');
const tools = require('./tools');
const chats = require('./chats');
const spend = require('./spend');
const caseyPrompt = require('../../lib/caseyPrompt');
const { isSuperuser, verifyElevationToken, stepupEnabled } = require('../../lib/auth.superuser');

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

// The model menu (lib/settingsRegistry.js casey_v2_model's options — the same
// list, pinned by tests/caseyLoop.test.js) and the effort menu.
const MODELS = Object.freeze(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']);
const DEFAULT_MODEL = 'claude-opus-5-5';
const EFFORTS = Object.freeze(['low', 'medium', 'high']);
const DEFAULT_EFFORT = 'medium';

const MAX_TOOL_CALLS = 40;             // per turn
const MAX_TURN_MS = 5 * 60 * 1000;     // per turn
const MAX_TOKENS = 16000;              // per model call (thinking + answer)
const MAX_TOKENS_RETRY = 64000;        // the one retry after a max_tokens cut
const HEARTBEAT_MS = 15000;
const CALL_TIMEOUT_FLOOR_MS = 120000;   // every model call gets at least this, whatever is left of the turn budget
const TEXT_MAX = 4000;                 // the user's message
const PROMPT_KEY = 'casey_v2_turn';

const BUDGET_NOTE = (calls, secs) =>
  `[This turn's tool budget is spent: ${calls} tool calls, ${secs} s. Answer the user now from what you have — do not call another tool. Say what is still unverified.]`;
const CUT_NOTE = '[Casey\'s answer was cut off at the output limit. Ask a narrower question, or ask Casey to continue.]';
const DECLINED_NOTE = '[Casey declined to continue this request.]';
const EMPTY_NOTE = '[Casey returned no answer.]';
const INTERRUPTED_RESULT = JSON.stringify({ ok: false, error: { code: 'INTERRUPTED', message: 'this tool call was interrupted before a result was recorded (the previous turn did not finish); call it again if you still need it' } });
const BUDGET_STOP_NOTE = '[Casey ran out of tool budget for this turn before answering. Ask it to continue.]';

function settingModel() {
  const v = require('../../lib/firmConfig').cfg('casey_v2_model'); // lazy require (convention)
  return MODELS.includes(v) ? v : DEFAULT_MODEL;
}
function settingEffort() {
  const v = require('../../lib/firmConfig').cfg('casey_v2_effort'); // lazy require (convention)
  return EFFORTS.includes(v) ? v : DEFAULT_EFFORT;
}

/** The volatile first block of a user message, and the facts it was built from. */
function contextBlock({ auth, headers, now }) {
  const utc = DateTime.fromJSDate(now, { zone: 'utc' });
  const local = utc.setZone(FIRM_TZ);
  const roles = Array.isArray(auth.roles) ? auth.roles : [];
  const su = auth.type !== 'api_key' && isSuperuser(auth);
  const elevated = su && (!stepupEnabled() || !!verifyElevationToken((headers || {})['x-su-elevation'], auth.userId));
  const who = auth.type === 'api_key' ? `machine key ${auth.key_label || ''}`.trim() : `${auth.username || 'unknown'} (user_id ${auth.userId})`;
  const text = [
    '[context — refreshed each turn]',
    `Now: ${local.toFormat('cccc yyyy-LL-dd HH:mm ZZZZ')} (${FIRM_TZ}); UTC ${utc.toISO({ suppressMilliseconds: true })}`,
    `Acting as: ${who}; roles: ${roles.join(', ') || 'none'}; superuser: ${su ? 'yes' : 'no'}; elevation live: ${elevated ? 'yes' : 'no'}`,
    'Page: (none — no page context in this version)',
  ].join('\n');
  return { text, meta: { now: utc.toISO(), zone: FIRM_TZ, user_id: auth.userId ?? null, username: auth.username ?? null, roles, superuser: su, elevated } };
}

/** The history without thinking / redacted_thinking blocks (an assistant row left empty becomes one text block). */
function stripThinking(messages) {
  return messages.map((m) => (m.role !== 'assistant' || !Array.isArray(m.content) ? m : { role: 'assistant', content: chats.stripThinkingBlocks(m.content) }));
}

/** tool_use ids of the last stored message when it is an assistant row that never got its results (an interrupted round). */
function orphanToolUses(rows) {
  const last = rows[rows.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) return [];
  return last.content.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => b.id);
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b && b.type === 'text').map((b) => b.text).join('') : '');
const toolResultBlock = (id, env) => ({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(env), ...(env.ok ? {} : { is_error: true }) });
const addUsage = (sum, u) => { for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) sum[k] = (sum[k] || 0) + (Number(u && u[k]) || 0); return sum; };

/**
 * @param {object} db
 * @param {object} o
 * @param {object} o.ctx        tools.ctxFromRequest(req, 'casey') — the caller's identity
 * @param {number|null} o.chatId  an existing chat of this user, or null for a new one
 * @param {string} o.text       the user's message
 * @param {Function} o.send     (event) → void, one NDJSON line
 * @param {Function} [o.begin]  called once, before the first event, when the turn is claimed
 * @param {Function} [o.converse]  aiService.converse (injected by tests)
 * @param {number} [o.heartbeatMs] [o.maxCalls] [o.maxMs] [o.maxTokens] [o.now]  test knobs
 * @returns {Promise<{ok:true, final:object} | {ok:false, error:object}>}
 * @throws httpError (status 400 / 404 / 409 / 429) BEFORE begin() — the route answers JSON
 */
async function runTurn(db, {
  ctx, chatId = null, text, send, begin = () => {},
  converse = aiService.converse, heartbeatMs = HEARTBEAT_MS,
  maxCalls = MAX_TOOL_CALLS, maxMs = MAX_TURN_MS, maxTokens = MAX_TOKENS, maxTokensRetry = MAX_TOKENS_RETRY,
  now = () => new Date(),
} = {}) {
  const userText = typeof text === 'string' ? text.trim() : '';
  if (!userText) throw spend.httpError(400, 'text is required');
  if (userText.length > TEXT_MAX) throw spend.httpError(400, `text is longer than ${TEXT_MAX} characters`);
  const auth = ctx && ctx.auth;
  if (!auth || auth.userId == null) throw spend.httpError(401, 'a signed-in user is required');
  const userId = auth.userId;

  const defs = tools.definitions();
  const sig = caseyPrompt.signature(defs);
  const system = caseyPrompt.systemText();

  // ---- The chat: existing (mine, free) or new; claimed before anything streams ----
  let chat;
  let created = false;
  if (chatId != null) {
    chat = await chats.getChat(db, chatId, userId);
    if (!chat) throw spend.httpError(404, 'No such chat');
    await spend.assertSpendAllowed(db);
    if (!(await chats.claimTurn(db, chat.id, userId))) throw spend.httpError(409, 'A turn is already running in this chat');
  } else {
    await spend.assertSpendAllowed(db);
    const id = await chats.createChat(db, { userId, text: userText, model: settingModel(), effort: settingEffort(), promptVersion: sig });
    chat = await chats.getChat(db, id, userId);
    created = true;
    if (!(await chats.claimTurn(db, chat.id, userId))) throw spend.httpError(409, 'A turn is already running in this chat');
  }

  const started = Date.now();
  const stored = [];                       // message row ids stored this turn, in order
  const toolCalls = [];                    // every tool call of the turn, for the final
  const usage = {};
  let cost = 0;
  let calls = 0;
  let limited = false;
  let stripped = chat.prompt_version !== sig;   // an older prefix: thinking blocks cannot replay
  let floorSeq = Number(chat.thinking_floor_seq) || 0;   // raised below; written on release with the re-stamp
  let floorRaised = false;                                // a re-stamp after a strip is only right once the floor covers it
  let lastSeq = 0;
  let heartbeat = null;
  const via = `casey:c${chat.id}`;
  const toolCtx = { ...ctx, via };
  const elapsedS = () => Math.round((Date.now() - started) / 1000);

  const fail = (status, message, detail) => { send({ type: 'error', status, message, ...(detail ? { detail } : {}) }); return { ok: false, error: { status, message, detail } }; };
  const store = async (role, content, meta) => { const r = await chats.appendMessage(db, chat.id, role, content, meta); stored.push(r.id); lastSeq = r.seq; return r; };

  try {
    begin();
    heartbeat = heartbeatMs > 0 ? setInterval(() => send({ type: 'heartbeat' }), heartbeatMs) : null;
    if (heartbeat && heartbeat.unref) heartbeat.unref();
    send({ type: 'chat', id: chat.id, title: chat.title, model: chat.model, effort: chat.effort, created, prompt_version: sig });

    // ---- The history + this turn's user message ----
    const rows = await chats.loadMessages(db, chat.id, { thinkingFloorSeq: floorSeq });
    const history = rows.map((m) => ({ role: m.role, content: m.content }));
    const orphans = orphanToolUses(rows);
    const cb = contextBlock({ auth, headers: ctx.headers, now: now() });
    const userMessage = { role: 'user', content: [
      ...orphans.map((id) => ({ type: 'tool_result', tool_use_id: id, content: INTERRUPTED_RESULT, is_error: true })),   // repair: results first, then the turn
      { type: 'text', text: cb.text }, { type: 'text', text: userText }] };
    const opening = await store('user', userMessage.content, { context: cb.meta, ...(orphans.length ? { repaired_tool_uses: orphans } : {}) });
    if (stripped) { floorSeq = Math.max(floorSeq, opening.seq); floorRaised = true; }   // everything before this turn is unreplayable from now on
    let messages = [...(stripped ? stripThinking(history) : history), userMessage];

    let maxTok = maxTokens;
    let retriedCut = false;
    let retriedBinding = false;
    let budgetSpent = false;

    for (;;) {
      // Spend, then the model.
      try { await spend.assertSpendAllowed(db); } catch (e) { return await rollbackIfOpening(fail(e.status || 429, e.message)); }
      const r = await converse(db, {
        messages, system, tools: defs, model: chat.model, effort: chat.effort, max_tokens: maxTok,
        consumerRef: spend.consumerRef(userId, chat.id), promptKey: PROMPT_KEY, promptVersion: sig,
        timeout_ms: Math.max(CALL_TIMEOUT_FLOOR_MS, maxMs - (Date.now() - started) + 30000), logContent: false,   // the floor: the closing call after a budget note still gets a real deadline
        onEvent: (ev) => {
          if (ev.type === 'text') send({ type: 'delta', text: ev.text });
          else if (ev.type === 'thinking') send({ type: 'thinking', text: ev.text });
        },
      });
      if (!r.ok) {
        // The thinking binding tripped (a prefix the signature did not see): drop the
        // blocks before the request's last message, once, and make it permanent (the
        // floor); r.api is the provider's own message, present whatever logContent is.
        if (!retriedBinding && !stripped && r.status === 400 && /thinking/i.test(String((r.api && r.api.message) || ''))) {
          retriedBinding = true; stripped = true;
          floorSeq = Math.max(floorSeq, lastSeq); floorRaised = true;
          messages = [...stripThinking(messages.slice(0, -1)), messages[messages.length - 1]];
          continue;
        }
        return await rollbackIfOpening(fail(r.error === 'timeout' ? 504 : 502, `The model call failed (${r.error})`, r.detail));
      }
      addUsage(usage, r.usage);
      cost += Number(r.cost_cents) || 0;
      const meta = { ai_call_id: r.callId, stop_reason: r.stop_reason, usage: r.usage, cost_cents: r.cost_cents, ms: r.latency_ms };
      const toolUses = r.content.filter((b) => b && b.type === 'tool_use');
      const answerText = textOf(r.content);

      if (r.stop_reason === 'max_tokens') {
        if (!retriedCut) { retriedCut = true; maxTok = maxTokensRetry; send({ type: 'reset' }); continue; }   // nothing stored; the same request, larger; the streamed text starts over
        limited = true;
        const row = await store('assistant', [{ type: 'text', text: answerText || CUT_NOTE }], { ...meta, altered: 'max_tokens' });
        return finish(row, answerText || CUT_NOTE);
      }
      if (r.stop_reason === 'refusal') {
        const row = await store('assistant', [{ type: 'text', text: answerText || DECLINED_NOTE }], { ...meta, altered: 'refusal' });
        return finish(row, answerText || DECLINED_NOTE);
      }
      if (r.stop_reason === 'tool_use' && toolUses.length) {
        if (budgetSpent) {                                    // the model ignored the budget note
          limited = true;
          const row = await store('assistant', [{ type: 'text', text: answerText || BUDGET_STOP_NOTE }], { ...meta, altered: 'budget' });
          return finish(row, answerText || BUDGET_STOP_NOTE);
        }
        await store('assistant', r.content, meta);
        messages.push({ role: 'assistant', content: r.content });
        const results = await Promise.all(toolUses.map(async (b) => {
          send({ type: 'tool_call', id: b.id, name: b.name, input: b.input });
          const env = r.partial.length && r.partial.includes(r.content.indexOf(b))
            ? { ok: false, tool: b.name, error: { code: 'BAD_INPUT', message: 'the tool call\'s input did not arrive whole' }, ms: 0 }
            : await tools.runTool(b.name, toolCtx, b.input);
          const summary = { id: b.id, name: b.name, ok: env.ok, code: env.ok ? null : (env.error && env.error.code) || null, bytes: env.bytes ?? null, ms: env.ms, truncated: !!env.truncated };
          send({ type: 'tool_result', ...summary });          // as each finishes
          return { block: toolResultBlock(b.id, env), summary };
        }));
        calls += toolUses.length;
        const content = results.map((x) => x.block);          // the model's order, whatever finished first
        toolCalls.push(...results.map((x) => x.summary));
        const umeta = { tool_calls: results.map((x) => x.summary) };
        if (calls >= maxCalls || Date.now() - started >= maxMs) {
          budgetSpent = true; limited = true;   // whatever the model answers next, it answered under the budget note
          content.push({ type: 'text', text: BUDGET_NOTE(calls, elapsedS()) });
          umeta.budget_note = true;
        }
        await store('user', content, umeta);
        messages.push({ role: 'user', content });
        continue;
      }
      // end_turn, or any other stop with no tool call: the answer. An empty block
      // list, or tool_use blocks under a non-tool stop, cannot be stored as is (an
      // empty assistant message is a 400 on every later turn; a tool_use without
      // its result likewise): text-only then.
      const storable = toolUses.length === 0 && r.content.some((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '');   // a thinking-only or blank answer is not replayable either
      const shown = storable ? answerText : (answerText.trim() ? answerText : EMPTY_NOTE);
      const row = await store('assistant', storable ? r.content : [{ type: 'text', text: shown }], storable ? meta : { ...meta, altered: 'unstorable' });
      return finish(row, shown);
    }
  } catch (err) {
    console.error('[casey loop] turn failed:', err);
    return await rollbackIfOpening(fail(500, 'The turn failed', String(err && err.message || err)));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Re-stamp only when the floor covers the strip: a turn that needed a strip but failed before raising the floor
    // (nothing stored) keeps its old prompt_version, so the next turn strips again instead of replaying old blocks.
    try { await chats.releaseTurn(db, chat.id, { promptVersion: (stripped && !floorRaised) ? null : sig, thinkingFloorSeq: floorSeq }); } catch (e) { console.error('[casey loop] release failed:', e.message); }
  }

  function finish(row, answerText) {
    const body = {
      chat_id: chat.id, message_id: row.id, seq: row.seq, text: answerText, usage, cost_cents: Math.round(cost * 10000) / 10000,
      calls, tool_calls: toolCalls, limited, ms: Date.now() - started, model: chat.model, effort: chat.effort, prompt_version: sig,
    };
    send({ type: 'final', body });
    return { ok: true, final: body };
  }

  // A failure with only the opening user row stored (or none, and a chat this
  // turn created): remove it, and the chat with it, so a retry is clean.
  async function rollbackIfOpening(result) {
    if (stored.length === 1 || (stored.length === 0 && created)) {
      try {
        if (created) await chats.deleteChat(db, chat.id, userId);
        else await chats.deleteMessages(db, chat.id, stored);
        result.rolled_back = true;
      } catch (e) { console.error('[casey loop] rollback failed:', e.message); }
    }
    return result;
  }
}

module.exports = {
  runTurn, contextBlock, stripThinking, orphanToolUses, settingModel, settingEffort,
  MODELS, DEFAULT_MODEL, EFFORTS, DEFAULT_EFFORT, MAX_TOOL_CALLS, MAX_TURN_MS, MAX_TOKENS, MAX_TOKENS_RETRY, HEARTBEAT_MS, CALL_TIMEOUT_FLOOR_MS, TEXT_MAX, PROMPT_KEY,
  BUDGET_NOTE, CUT_NOTE, DECLINED_NOTE, BUDGET_STOP_NOTE, EMPTY_NOTE, INTERRUPTED_RESULT, FIRM_TZ,
};
