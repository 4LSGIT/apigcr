// api_write — PROPOSE one or more non-GET calls as a CARD the user approves
// (Casey v2 S3b; design §4.2, §4.4–4.5, §8.6). This tool never executes
// anything. It checks every step against the route catalog and the caller's
// own permissions, computes the card's tier, stores the card and its steps in
// the ledger (services/casey/cards.js) and returns "card N proposed". The LOOP
// ends the turn on that result; the browser shows the card; on Approve it
// claims each step in the ledger and sends the request itself through the
// shell's apiSend — as the user, with the user's own elevation prompt for a
// superuser route — and settles the result; the outcome then comes back to the
// model as the first text block of the next user message, built from the
// ledger rows (never from the browser's words).
//
// What is checked, per step, BEFORE anything is stored:
//   • method is POST / PUT / PATCH / DELETE (a card never carries a GET);
//   • the path is a plain path (api_get's rules: starts with '/', no query
//     string — `query` is a separate object — no dot segments, no control
//     characters, ≤ 2000 chars); the query is appended as the stored path;
//   • the concrete path resolves to a route (lib/routeCatalog.findRoute) that
//     is PROPOSABLE (lib/caseySensitivity: staff-class, JSON, not on the
//     never-proposable or secret-returning lists) — the refusal names why;
//   • THIS user may call it (lookup_routes' judge: a staff:can route needs the
//     capability; an SU route needs the superuser role — a non-superuser never
//     gets a T3 card; `dynamic` is left to the route);
//   • the body, when present, is a JSON object with no `$N` / `$N.field`
//     reference — multi-step substitution arrives in S3c; until then two cards;
//   • the step's tier is the route's; the card's tier is the highest.
// 1–5 steps; one api_write per round (the loop refuses a second in the same
// round — the turn ends on the first card).
//
// Without a chat (the SU test route POST /api/casey/tools/api_write) the tool
// validates and returns the card it WOULD propose, `dry_run: true`, storing
// nothing. ctx.card = { chatId, toolUseId } is what the loop supplies.
'use strict';

const catalog = require('../../../lib/routeCatalog');
const { ToolError } = require('./index_error');
const { cleanPath, queryString } = require('./api_get');
const { judge } = require('./lookup_routes');

const METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_STEPS = 5;
const SUMMARY_MAX = 300;
const PURPOSE_MAX = 300;
const BODY_MAX = 64 * 1024;   // bytes of one step's JSON body
const REF_RE = /^\$\d+(\.|$)/;

/** The first `$N` / `$N.field` string anywhere in a value, or null. */
function findRef(v, at = 'body') {
  if (typeof v === 'string') return REF_RE.test(v) ? { at, ref: v } : null;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = findRef(v[i], `${at}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const r = findRef(x, `${at}.${k}`); if (r) return r; } }
  return null;
}

/** One validated step → { method, path, body (JSON text | null), tier, purpose, route } or a ToolError. */
function checkStep(ctx, cat, s, n) {
  const at = `steps[${n - 1}]`;
  const method = String(s.method || '').toUpperCase();
  if (!METHODS.includes(method)) throw new ToolError('BAD_METHOD', `${at}: method must be one of ${METHODS.join(', ')}`);
  let p;
  try { p = cleanPath(s.path); } catch (e) { throw new ToolError(e.code || 'BAD_PATH', `${at}: ${e.message}`); }
  const row = catalog.findRoute(cat, method, p);
  if (!row) throw new ToolError('NO_ROUTE', `${at}: no ${method} route serves ${p}`, { step: n, method, path: p });
  if (!row.proposable) {
    const why = row.authClass === 'unknown' ? 'its auth could not be classified'
      : !['staff', 'staff:can', 'su'].includes(row.authClass) ? `${row.authClass} route — not callable with a staff identity`
      : row.multipart ? 'a multipart (file upload) route — its body is not JSON'
      : row.tierReason === 'returns a secret' ? 'its response is a secret'
      : 'on the never-proposable list (consoles, auth, plumbing, Casey itself)';
    throw new ToolError('NOT_PROPOSABLE', `refused: ${row.method} ${row.path} — ${why}`, { step: n, route: row.path, auth: row.authClass, tier: `T${row.tier}` });
  }
  const you = judge(row, ctx.auth);
  if (you.allowed === false) throw new ToolError('FORBIDDEN', `refused: ${row.method} ${row.path} — this user may not call it (${you.reason}); say who could`, { step: n, route: row.path, reason: you.reason, tier: `T${row.tier}` });
  let body = null;
  if (s.body !== undefined && s.body !== null) {
    if (typeof s.body !== 'object' || Array.isArray(s.body)) throw new ToolError('BAD_BODY', `${at}: body must be a JSON object`);
    const ref = findRef(s.body);
    if (ref) throw new ToolError('UNSUPPORTED_REF', `${at}: ${ref.at} is "${ref.ref}" — a reference to an earlier step's result is not supported yet; propose this step on its own card after the first card's result is known`, { step: n });
    body = JSON.stringify(s.body);
    if (Buffer.byteLength(body, 'utf8') > BODY_MAX) throw new ToolError('BAD_BODY', `${at}: body is larger than ${BODY_MAX} bytes`);
  }
  const purpose = String(s.purpose || '').trim().slice(0, PURPOSE_MAX);
  const full = p + queryString(s.query);
  if (full.length > 2000) throw new ToolError('BAD_PATH', `${at}: path and query together are longer than 2000 characters`);   // the stored column's width — never truncated silently
  return { method, path: full, body, tier: row.tier, purpose, route: row.path, elevation: !!row.elevation, auth: row.authClass };
}

module.exports = {
  name: 'api_write',
  description: `Propose a write (POST, PUT, PATCH or DELETE on a staff route) as a CARD the user must approve. Nothing runs when you call this: the turn ENDS, the user sees the card (your summary, each step's method, path and exact JSON body), and clicks Approve or Decline. The user's NEXT message then opens with the card's outcome — "[Card N — approved …]" with each step's HTTP status and the route's answer, or "[Card N — DECLINED …]" — read it before answering. Rules: read first (lookup_routes, read_source for the route's body shape, api_get / sql_read for the current record), then propose; one card per intent, 1–${MAX_STEPS} steps run in order (a failure stops the rest); a step may not reference an earlier step's result ("$1.id") — when a later write needs something a write produces, propose the first card alone and the second after its outcome. Superuser routes make a "Superuser action" card and are refused for non-superusers; routes on the never-proposable list (consoles, auth, uploads, Casey itself) and routes this user may not call are refused with the reason. Put query parameters in \`query\`, never in the path.`,
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX, description: 'One line the user reads first: what this card does, in their terms.' },
      steps: {
        type: 'array', minItems: 1, maxItems: MAX_STEPS, description: `The calls, in order (1–${MAX_STEPS}).`,
        items: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: METHODS, description: 'POST, PUT, PATCH or DELETE.' },
            path: { type: 'string', minLength: 1, maxLength: 2000, description: 'Concrete path, e.g. /api/tasks/123 — no query string.' },
            body: { type: 'object', description: 'The JSON request body, exactly as the route expects it (read the route first). Omit for a route that takes none.' },
            query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query parameters as strings, if the route reads any.' },
            purpose: { type: 'string', minLength: 1, maxLength: PURPOSE_MAX, description: 'One line on why this step (shown on the card).' },
          },
          required: ['method', 'path', 'purpose'],
        },
      },
    },
    required: ['summary', 'steps'],
  },
  untrusted: false,
  async run(ctx, input) {
    const cat = catalog.catalogFor(ctx.app);
    const steps = input.steps.map((s, i) => checkStep(ctx, cat, s, i + 1));
    const tier = Math.max(...steps.map((s) => s.tier));
    const summary = String(input.summary || '').trim().slice(0, SUMMARY_MAX);
    const shown = steps.map((s, i) => ({ step: i + 1, method: s.method, path: s.path, tier: `T${s.tier}`, route: s.route }));
    if (!ctx.card || ctx.card.chatId == null) {
      return { dry_run: true, tier: `T${tier}`, summary, steps: shown, note: 'no chat: validated only, nothing stored (the SU test route)' };
    }
    const cards = require('../cards'); // lazy require (convention)
    const cardId = await cards.createCard(ctx.db, {
      chatId: ctx.card.chatId, userId: ctx.auth.userId, toolUseId: ctx.card.toolUseId, tier, summary,
      steps: steps.map((s) => ({ method: s.method, path: s.path, body: s.body, tier: s.tier, purpose: s.purpose })),
    });
    return {
      card_id: cardId, status: 'proposed', tier: `T${tier}`, summary, steps: shown,
      note: `Card ${cardId} is shown to the user; this turn ends here. Their next message opens with the card's outcome — nothing has run yet.`,
    };
  },
  METHODS, MAX_STEPS, BODY_MAX, findRef, checkStep,
};
