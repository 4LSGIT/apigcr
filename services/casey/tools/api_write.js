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
//   • the body, when present, is a JSON object; a WHOLE string value — or a
//     whole path segment — of the form `$N.field` (services/casey/cardRefs.js:
//     `$1.task_id`, `$1.rows.0.id`) references an EARLIER step's result and is
//     resolved on the server at claim time from the stored (redacted) result;
//     a reference to a later or the same step, or in a query value, is refused;
//   • a path carrying a reference is matched to its route STRUCTURALLY
//     (cardRefs.matchTemplate: the references must stand on the route's
//     parameters, every literal segment equal) and checked like a plain step;
//     at claim the resolved path must dispatch to that same route;
//   • a send (lib/caseySensitivity SEND_PATHS: mail, SMS / MMS, e-sign, a
//     campaign test, a CTA message — judged on the MATCHED route, whatever the
//     case or trailing slash of the path) takes no reference at all, in its
//     body or its path — the user would be approving content, or a sending
//     line, they cannot see (S3c review); nor does any body carry a
//     `__proto__` / `constructor` / `prototype` key;
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
const cardRefs = require('../cardRefs');
const { isSendPath } = require('../../../lib/caseySensitivity');
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_STEPS = 5;
const SUMMARY_MAX = 300;
const PURPOSE_MAX = 300;
const BODY_MAX = 64 * 1024;   // bytes of one step's JSON body
const LOOSE_REF = /^\$\d+(\.|$)/;   // a `$N…` string that is NOT a well-formed reference is refused as a typo, never sent as text

/** Every `$N…`-shaped string in a value: [{ at, text, ref }] — ref is null when the shape is not a valid reference. */
function refShapes(v, at = 'body', out = []) {
  if (typeof v === 'string') { if (LOOSE_REF.test(v)) out.push({ at, text: v, ref: cardRefs.parseRef(v) }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => refShapes(x, `${at}[${i}]`, out)); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) refShapes(x, `${at}.${k}`, out);
  return out;
}
/** The first `__proto__` / `constructor` / `prototype` key in a body (a substitution rebuilds objects: such a key would vanish or poison), or null. */
function protoKey(v, at = 'body') {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = protoKey(v[i], `${at}[${i}]`); if (r) return r; } return null; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) { if (PROTO_KEYS.has(k)) return `${at}.${k}`; const r = protoKey(v[k], `${at}.${k}`); if (r) return r; } }
  return null;
}
/** Refuse a reference that is malformed or does not point at an earlier step. */
function checkRefs(shapes, n, at) {
  for (const s of shapes) {
    if (!s.ref) throw new ToolError('BAD_REF', `${at}: ${s.at} is "${s.text}" — a reference is "$N.field" (dotted path, e.g. $1.task_id or $1.rows.0.id)`, { step: n });
    if (s.ref.step < 1 || s.ref.step >= n) throw new ToolError('BAD_REF', `${at}: ${s.at} is "${s.text}" — a reference must name an EARLIER step of this card (1–${n - 1})`, { step: n });
  }
}

/** One validated step → { method, path, body (JSON text | null), tier, purpose, route } or a ToolError. */
function checkStep(ctx, cat, s, n) {
  const at = `steps[${n - 1}]`;
  const method = String(s.method || '').toUpperCase();
  if (!METHODS.includes(method)) throw new ToolError('BAD_METHOD', `${at}: method must be one of ${METHODS.join(', ')}`);
  let p;
  try { p = cleanPath(s.path); } catch (e) { throw new ToolError(e.code || 'BAD_PATH', `${at}: ${e.message}`); }
  const pathShapes = p.split('/').filter((seg) => LOOSE_REF.test(seg)).map((seg) => ({ at: 'path', text: seg, ref: cardRefs.parseRef(seg) }));
  checkRefs(pathShapes, n, at);
  if (s.query) for (const [k, v] of Object.entries(s.query)) if (LOOSE_REF.test(String(v))) throw new ToolError('BAD_REF', `${at}: query.${k} is "${v}" — a reference cannot be a query value; put it in the path as a segment`, { step: n });
  // The route: a concrete path by dispatch; a template (reference segments) by structure — the references must stand on
  // the route's parameters, so the card names the route the user approves and the claim can only vary its parameters.
  let row;
  if (pathShapes.length) {
    const pinned = cardRefs.matchTemplate(cat, method, p);
    if (!pinned.row) throw new ToolError('NO_ROUTE', `${at}: ${pinned.reason}`, { step: n, method, path: p });
    row = pinned.row;
  } else {
    row = catalog.findRoute(cat, method, p);
    if (!row) throw new ToolError('NO_ROUTE', `${at}: no ${method} route serves ${p}`, { step: n, method, path: p });
  }
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
  const isSend = isSendPath(row.path);   // the matched ROUTE decides (the model's path may differ in case or a trailing slash); lib/caseySensitivity SEND_PATHS names every outbound send
  if (isSend && pathShapes.length) throw new ToolError('BAD_REF', `${at}: a send takes no reference in its path (the user must see which line or box sends) — write it out, or propose the send after the earlier card's outcome`, { step: n });
  let body = null;
  if (s.body !== undefined && s.body !== null) {
    if (typeof s.body !== 'object' || Array.isArray(s.body)) throw new ToolError('BAD_BODY', `${at}: body must be a JSON object`);
    const proto = protoKey(s.body);
    if (proto) throw new ToolError('BAD_BODY', `${at}: ${proto} is not an allowed key`);
    const bodyRefs = refShapes(s.body);
    checkRefs(bodyRefs, n, at);   // S3c: `$N.field` is resolved at claim from the earlier step's stored result
    if (bodyRefs.length && isSend) throw new ToolError('BAD_REF', `${at}: a send takes no reference in its body (the user must see the content they approve) — write the recipients and text out, or propose the send after the earlier card's outcome`, { step: n });
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
  description: `Propose a write (POST, PUT, PATCH or DELETE on a staff route) as a CARD the user must approve. Nothing runs when you call this: the turn ENDS, the user sees the card (your summary, each step's method, path and exact JSON body), and clicks Approve or Decline. The user's NEXT message then opens with the card's outcome — "[Card N — approved …]" with each step's HTTP status and the route's answer, or "[Card N — DECLINED …]" — read it before answering. Rules: read first (lookup_routes, read_source for the route's body shape, api_get / sql_read for the current record), then propose; one card per intent, 1–${MAX_STEPS} steps run in order (a failure stops the rest). A later step may use an EARLIER step's result: a whole string value in its body, or a whole path segment standing for a route parameter (such as :id), of the form "$N.field" (a dotted path into step N's answer: "$1.task_id", "$1.task.id", "$1.rows.0.id") is replaced when that step runs, from the answer as recorded — a redacted value (a token), a null, an object, or a field of an answer cut at 16 KB can never be substituted and fails the step before anything is sent; a reference may not be a query value, and a mail or SMS send takes none in its body (the user must see what they approve). Superuser routes make a "Superuser action" card and are refused for non-superusers; routes on the never-proposable list (consoles, auth, uploads, Casey itself) and routes this user may not call are refused with the reason. Put query parameters in \`query\`, never in the path.`,
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
  METHODS, MAX_STEPS, BODY_MAX, refShapes, checkRefs, protoKey, checkStep,
};
