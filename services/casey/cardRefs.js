// services/casey/cardRefs.js — Casey v2 S3c: `$N.field` references between a
// card's steps (ref/CASEY_V2_DESIGN.md §4.5 "later steps may reference earlier
// results"; as built §9 S3c).
//
// GRAMMAR. A reference is a WHOLE string value — in a body, at any depth, or
// as a whole path segment — of the form `$N.path`, where N is the number of an
// EARLIER step on the same card and `path` is a dotted walk into that step's
// stored result: identifiers and array indexes (`$1.task_id`, `$1.task.id`,
// `$1.rows.0.id`). Nothing else is a reference: a `$` inside a longer string is
// text ("price is $5"), and a reference in a query value is refused (the query
// is folded into the stored path at proposal; references are read from the
// PATH part only — the query is split off first, so a `?x=1` after the last
// segment cannot hide one; review B1).
//
// THE ROUTE IS PINNED BY THE TEMPLATE (review B3). A path with a reference is
// matched against the live catalog STRUCTURALLY at proposal — the same number
// of segments, every reference on a `:param` position of the route's pattern,
// every literal segment equal to the pattern's literal or standing on a
// parameter (`/api/cases/42/contacts/$1.cid` pins `/api/cases/:id/contacts/
// :contactId`) — and that row's tier, proposability and the user's right to
// call it are checked then, exactly as for a plain step. A path WITHOUT a
// reference (a body-only reference, `PATCH /api/tasks/1830` with `$1.title`)
// pins by dispatch, as it was checked at proposal. At claim the pin is made
// again and the RESOLVED path must dispatch to that very row (`row.matches`
// and `findRoute` agree), so a substitution can only vary the parameters of
// the route the user approved, never pick a different route (`/api/$1.a/$1.b`
// is refused at proposal: no row has parameters there; two routes of one shape
// differing only by a parameter constraint fail closed at claim).
//
// RESOLUTION happens on the server at CLAIM time (never in the page), only
// once every earlier step is applied: the referenced step's stored result —
// the REDACTED result (lib/caseyRedact) — must hold the path with a scalar
// value that is not null, is not and does not contain the `[redacted]` marker
// (a bearer never flows into a later request; the user has it in their own
// browser if they want it), and comes from a result that was neither withheld
// nor cut at the 16 KB ledger limit. A body reference keeps the value's JSON
// type; a path reference takes a string or number with no `/`, `\`, dot
// segment (`.` / `..`, review B2), whitespace or control character, and
// URL-encodes it; the resolved path is then cleaned as a template is
// (api_get's rules) before the route check. Anything that fails is UNRESOLVED:
// the step is marked failed with {error:'UNRESOLVED', ref, reason} before
// anything is sent, and the run stops.
'use strict';

const REF_RE = /^\$(\d+)\.([A-Za-z_][A-Za-z0-9_]*|\d+)(\.([A-Za-z_][A-Za-z0-9_]*|\d+))*$/;
const REDACTED = '[redacted]';
const TRUNCATED_MARK = '…[truncated:';   // services/casey/cards.js resultText's cut marker
// eslint-disable-next-line no-control-regex
const BAD_SEGMENT = /[\/\\\s\x00-\x1f\x7f]/;

/** `$1.task.id` → { step: 1, path: ['task', 'id'] } or null when the string is not a reference. */
function parseRef(s) {
  if (typeof s !== 'string') return null;
  if (!REF_RE.test(s)) return null;
  const parts = s.slice(1).split('.');
  return { step: Number(parts[0]), path: parts.slice(1), text: s };
}
/** A stored path → [the path part, the query part including '?' or '']. */
function splitQuery(p) {
  const s = String(p || '');
  const i = s.indexOf('?');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i)];
}

/** Every reference in a value: [{ at, ref }] — `at` is the JSON path of the string holding it. */
function findRefs(v, at = 'body', out = []) {
  if (typeof v === 'string') { const r = parseRef(v); if (r) out.push({ at, ref: r }); return out; }
  if (Array.isArray(v)) { v.forEach((x, i) => findRefs(x, `${at}[${i}]`, out)); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) findRefs(x, `${at}.${k}`, out);
  return out;
}
/** The references in a path's segments (the query split off): [{ at:'path[i]', ref }]. */
function findPathRefs(p) {
  const out = [];
  splitQuery(p)[0].split('/').forEach((seg, i) => { const r = parseRef(seg); if (r) out.push({ at: `path[${i}]`, ref: r }); });
  return out;
}

/**
 * The catalog row a TEMPLATE path (reference segments included) pins: same
 * segment count, every literal segment equal (case-insensitively, as Express
 * matches), every reference segment on a `:param` position. The first
 * registered of the structurally matching rows, as Express would dispatch.
 * → { row } | { row: null, reason }
 */
function matchTemplate(cat, method, templatePath) {
  const m = String(method || '').toUpperCase();
  const segs = splitQuery(templatePath)[0].split('/');
  let best = null;
  for (const row of cat.rows) {
    if (row.method !== m) continue;
    const pat = row.path.split('/');
    if (pat.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      const isRef = parseRef(segs[i]) != null;
      const isParam = pat[i].startsWith(':');
      if (isRef) ok = isParam;
      else ok = isParam || pat[i].toLowerCase() === segs[i].toLowerCase();   // a literal may stand on a parameter (a known id beside a reference); the claim's dispatch check keeps it honest
    }
    if (ok && (!best || row.seq < best.seq)) best = row;
  }
  if (!best) return { row: null, reason: `no ${m} route has parameters where ${splitQuery(templatePath)[0]} carries references (a reference may stand only for a route parameter such as :id)` };
  return { row: best };
}

/** A dotted walk into a parsed result; → { found, value }. */
function walk(value, path) {
  let v = value;
  for (const key of path) {
    if (Array.isArray(v)) { const i = Number(key); if (!/^\d+$/.test(key) || i >= v.length) return { found: false }; v = v[i]; continue; }
    if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, key)) { v = v[key]; continue; }
    return { found: false };
  }
  return { found: true, value: v };
}

/**
 * Resolve one reference against the earlier steps' stored results.
 * @param {{step:number, path:string[], text:string}} ref
 * @param {Map<number, {status:string, result:*}>} earlier   step_no → the step as the store reads it
 * @param {'body'|'path'} kind
 * @returns {{ ok: true, value: * } | { ok: false, reason: string }}
 */
function resolveRef(ref, earlier, kind) {
  const src = earlier.get(ref.step);
  if (!src) return { ok: false, reason: `step ${ref.step} is not an earlier step of this card` };
  if (src.status !== 'applied') return { ok: false, reason: `step ${ref.step} is ${src.status}, not applied` };
  if (src.result && typeof src.result === 'object' && src.result.withheld) return { ok: false, reason: `step ${ref.step}'s result was withheld (too many secret-shaped values)` };
  if (typeof src.result === 'string' && src.result.includes(TRUNCATED_MARK)) return { ok: false, reason: `step ${ref.step}'s answer was cut at the ledger's 16 KB limit; a reference into a large answer cannot be resolved` };
  const w = walk(src.result, ref.path);
  if (!w.found) return { ok: false, reason: `step ${ref.step}'s result has no ${ref.path.join('.')}` };
  const v = w.value;
  if (typeof v === 'string' && v.includes(REDACTED)) return { ok: false, reason: `${ref.text} is a redacted value (a token or secret never flows into a later step)` };
  if (v === null || v === undefined) return { ok: false, reason: `${ref.text} is ${v === null ? 'null' : 'absent'}; a reference must name a value` };
  if (typeof v === 'object') return { ok: false, reason: `${ref.text} is an object or array, not a value` };
  if (kind === 'path') {
    if (typeof v === 'boolean' || (typeof v === 'string' && !v.trim())) return { ok: false, reason: `${ref.text} is ${JSON.stringify(v)}, which cannot be a path segment` };
    const s = String(v);
    if (s === '.' || s === '..' || BAD_SEGMENT.test(s)) return { ok: false, reason: `${ref.text} is ${JSON.stringify(s)}, which cannot be a path segment (a slash, a dot segment, whitespace or a control character)` };
    let decoded = s; try { decoded = decodeURIComponent(s); } catch (_) { /* left as is: the encoder below handles it */ }
    if (decoded === '.' || decoded === '..' || BAD_SEGMENT.test(decoded)) return { ok: false, reason: `${ref.text} is ${JSON.stringify(s)}, which decodes to a dot segment or a slash` };
  }
  return { ok: true, value: v };
}

/** The body with every reference replaced (a deep copy), or the first failure. */
function resolveBody(body, earlier) {
  const fail = { error: null };
  const sub = (v) => {
    if (fail.error) return v;
    if (typeof v === 'string') { const r = parseRef(v); if (!r) return v; const res = resolveRef(r, earlier, 'body'); if (!res.ok) { fail.error = { ref: r.text, reason: res.reason }; return v; } return res.value; }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) Object.defineProperty(o, k, { value: sub(x), enumerable: true, writable: true, configurable: true }); return o; }
    return v;
  };
  const out = sub(body);
  return fail.error ? { ok: false, ...fail.error } : { ok: true, body: out };
}
/** The path with every reference segment replaced and encoded (the query kept as it was), or the first failure. */
function resolvePath(p, earlier) {
  const [bare, query] = splitQuery(p);
  const segs = bare.split('/');
  for (let i = 0; i < segs.length; i++) {
    const r = parseRef(segs[i]);
    if (!r) continue;
    const res = resolveRef(r, earlier, 'path');
    if (!res.ok) return { ok: false, ref: r.text, reason: res.reason };
    segs[i] = encodeURIComponent(String(res.value));
  }
  return { ok: true, path: segs.join('/') + query };
}

/**
 * Resolve a whole step for the claim: its path and body, then the resolved path
 * checked to dispatch to the very route the template pinned at proposal.
 * @param {{method, path, body, tier}} step   as the store reads it (body = JSON text or null)
 * @param {Map<number, {status, result}>} earlier
 * @param {{ cat: object, auth: object, cardTier: number }} ctx   lib/routeCatalog's catalog, the caller's req.auth
 * @returns {{ ok:true, path:string|null, body:string|null, route:string|null } | { ok:false, ref:string|null, reason:string }}
 *          path / body are null when the template carried no reference (what is stored is what is sent)
 */
function resolveStep(step, earlier, { cat, auth, cardTier }) {
  const catalog = require('../../lib/routeCatalog');          // lazy require (convention)
  const { judge } = require('./tools/lookup_routes');          // lazy require (convention)
  const { cleanPath } = require('./tools/api_get');            // lazy require (convention)
  let pathSent = null, bodySent = null;
  const pathRefs = findPathRefs(step.path);
  if (pathRefs.length) {
    const r = resolvePath(step.path, earlier);
    if (!r.ok) return { ok: false, ref: r.ref, reason: r.reason };
    pathSent = r.path;
  }
  if (step.body != null) {
    let parsed;
    try { parsed = JSON.parse(step.body); } catch (_) { return { ok: false, ref: null, reason: 'the stored body is not JSON' }; }
    if (findRefs(parsed).length) {
      const r = resolveBody(parsed, earlier);
      if (!r.ok) return { ok: false, ref: r.ref, reason: r.reason };
      bodySent = JSON.stringify(r.body);
    }
  }
  if (pathSent == null && bodySent == null) return { ok: true, path: null, body: null, route: null };
  // The resolved path must dispatch to the route the proposal pinned — by structure for a template, by dispatch for a
  // concrete path (a body-only reference) — and be clean as a template is.
  const [bare] = splitQuery(pathSent || step.path);
  try { cleanPath(bare); } catch (e) { return { ok: false, ref: null, reason: `the resolved path ${bare} is not a plain path (${e.message})` }; }
  const pinnedRow = pathRefs.length ? matchTemplate(cat, step.method, step.path).row : catalog.findRoute(cat, step.method, splitQuery(step.path)[0]);
  if (!pinnedRow) return { ok: false, ref: null, reason: pathRefs.length ? matchTemplate(cat, step.method, step.path).reason : `no ${step.method} route serves ${splitQuery(step.path)[0]}` };
  const row = catalog.findRoute(cat, step.method, bare);
  if (!row || row !== pinnedRow || !pinnedRow.matches(bare)) return { ok: false, ref: null, reason: `the resolved path ${bare} does not reach the route approved on the card (${pinnedRow.path})` };
  if (!row.proposable) return { ok: false, ref: null, reason: `the resolved path ${bare} is not a route Casey may propose` };
  const you = judge(row, auth);
  if (you.allowed === false) return { ok: false, ref: null, reason: `you may not call the resolved path ${bare} (${you.reason})` };
  if (row.tier > cardTier) return { ok: false, ref: null, reason: `the resolved path ${bare} is a T${row.tier} route; the card was approved as T${cardTier}` };
  return { ok: true, path: pathSent, body: bodySent, route: row.path };
}

module.exports = { REF_RE, REDACTED, TRUNCATED_MARK, parseRef, splitQuery, findRefs, findPathRefs, matchTemplate, walk, resolveRef, resolveBody, resolvePath, resolveStep };
