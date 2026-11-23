// flag_for_review — file THIS chat for the firm's review (Casey v2 S4b, design
// §4.8). The model calls it when it is stuck, when the user is plainly
// frustrated, or on its own after three consecutive failures of one tool;
// the prompt (lib/caseyPrompt.js v2.5) says when. It files an issue report of
// kind `casey` through the REAL route, over loopback, AS THE USER — exactly as
// the page's flag button does — so the rate limit, the attribution, the IT
// email and the Support Inbox are the same code (routes/api.issueReports.js).
// One flag per turn (ctx.turn.flagged); a second call in the same turn is
// answered with the first report's id and files nothing. Without a chat (the
// SU test route) it validates and files nothing (`dry_run`).
'use strict';

const { ToolError } = require('./index_error');

const NOTE_MAX = 1000;
const TIMEOUT_MS = 10000;

module.exports = {
  name: 'flag_for_review',
  description: 'Flag THIS conversation for the firm\'s review, with a one-line note on what went wrong (a route that refused, an answer you could not verify, a question you could not handle, a user who is plainly unhappy with the result). A reviewer reads the whole chat and fixes the cause — usually by writing you a note. Use it once per turn at most; say in your answer that you flagged the chat. It never changes any record.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', minLength: 1, maxLength: NOTE_MAX, description: 'What went wrong, in one or two lines — for the reviewer, not the user.' },
    },
    required: ['note'],
  },
  untrusted: false,
  async run(ctx, input) {
    const note = String(input.note || '').trim();
    if (!note) throw new ToolError('BAD_INPUT', 'note is required');
    const chatId = ctx.card && ctx.card.chatId;
    if (!chatId) return { dry_run: true, note, message: 'validated; without a chat nothing is filed' };
    // One per turn: the turn holder is reserved SYNCHRONOUSLY (a round's tool calls run in parallel), and a second
    // call waits on the first's promise and answers its report id — it files nothing.
    if (ctx.turn && ctx.turn.flagging) {
      let first = null;
      try { first = await ctx.turn.flagging; } catch (_) { /* the first failed: say so below */ }
      if (first) return { report_id: first, already: true, message: 'this turn already flagged the chat — nothing more was filed' };
      throw new ToolError('FLAG_FAILED', 'this turn\'s flag already failed; do not retry it this turn');
    }
    const h = ctx.headers || {};
    if (!h.authorization) throw new ToolError('NO_AUTH', 'the caller has no Authorization header to act with');
    let settle; const pending = new Promise((res, rej) => { settle = { res, rej }; });
    if (ctx.turn) { ctx.turn.flagging = pending; pending.catch(() => {}); }
    try {
      const { id, emailed } = await file(ctx, note, chatId);
      if (ctx.turn) ctx.turn.flagged = id;
      settle.res(id);
      return { report_id: id, emailed, message: 'filed for review' };
    } catch (e) { settle.rej(e); throw e; }
  },
};

/** The POST to the real route; → { id, emailed } from its 201. */
async function file(ctx, note, chatId) {
    const h = ctx.headers || {};
    const body = JSON.stringify({
      kind: 'casey', note: `[flagged by Casey] ${note}`.slice(0, 4000), page_url: null,
      context: { casey: { chat_id: Number(chatId), seq: null, model: (ctx.turn && ctx.turn.model) || null, prompt_version: (ctx.turn && ctx.turn.promptVersion) || null, by: 'casey', tool_use_id: ctx.card.toolUseId || null } },
    });
    const headers = {
      authorization: h.authorization, accept: 'application/json', 'content-type': 'application/json', 'accept-encoding': 'identity',
      'user-agent': h['user-agent'] || 'casey', 'x-casey-via': String(ctx.via || 'casey'),
    };
    const xff = h['x-forwarded-for'] || ctx.ip;
    if (xff) headers['x-forwarded-for'] = String(xff);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ctx.timeoutMs || TIMEOUT_MS);
    let res, json;
    try {
      try {
        res = await (ctx.fetch || fetch)(`http://127.0.0.1:${ctx.port}/api/issue-reports`, { method: 'POST', headers, body, redirect: 'manual', signal: ac.signal });
      } catch (e) {
        throw new ToolError(ac.signal.aborted ? 'TIMEOUT' : 'FETCH_FAILED', ac.signal.aborted ? 'the report route did not answer in time — the report MAY have been filed (it emails IT before answering); do not flag again this chat' : String(e && e.message || e));
      }
      const text = await res.text();
      try { json = JSON.parse(text); } catch (_) { json = null; }
    } finally { clearTimeout(timer); }
    if (res.status !== 201 || !json || !json.id) throw new ToolError('FLAG_FAILED', `the report route answered ${res.status}: ${(json && (json.error || json.message)) || 'no detail'}`, { status: res.status });
    return { id: Number(json.id), emailed: !!json.emailed };
}
