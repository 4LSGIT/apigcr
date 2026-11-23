// api_get — GET a staff route AS THE USER over loopback HTTP (Casey v2 S1,
// design §4.2, §8.4). No parallel permission logic: the request goes through
// the route's real middleware with the caller's own Authorization header, so
// the route's gate, its handler-level checks and its audit logger all see the
// real user. What this tool adds is the CATALOG check before any request:
//
//   • the concrete path is resolved to its route with lib/routeCatalog
//     findRoute (the first registered row whose own regexp matches and whose
//     method applies, public pass-through rows aside — what Express dispatches
//     to), and the call is refused unless that row is autoGet: su rows (a T3
//     card in S3), secret-returning and never-auto reads, key / portal /
//     public rows, unknown rows. The refusal names the tier so the model can
//     say what would be needed instead.
//   • the path is a plain path: starts with '/', no query string (query is a
//     separate object), no '..' / '.' segments or encoded forms, no '//', no
//     control characters, no backslash, ≤ 2000 chars.
//   • JSON only — decided from the response HEADERS, before any body is read:
//     a non-JSON content type (PDF, audio, document bytes — several autoGet
//     routes stream megabytes) is refused and its body cancelled (§8.10); a
//     redirect is refused too (never followed: a same-origin 302 onto a closed
//     route would carry the Authorization header past the catalog gate). The
//     JSON body is read with a byte cap (MAX_BODY) — the envelope hands the
//     model at most 60 KB anyway. A 4xx/5xx JSON answer is returned as data
//     (status + body), not thrown: the route's own 403 wording is what Casey
//     learns from (§8.3).
//
// Forwarded: Authorization only, plus X-Forwarded-For (the real client IP for
// the audit log), User-Agent, Accept: application/json, Accept-Encoding:
// identity (no gzip to parse), and X-Casey-Via naming the surface. The
// X-SU-Elevation header is NOT forwarded: no autoGet row is an SU route, so
// an elevation can buy nothing here; S3's api_write forwards it for cards.
// Timeout 20 s (AbortController). Loopback target: http://127.0.0.1:${ctx.port}.
'use strict';

const catalog = require('../../../lib/routeCatalog');
const { ToolError } = require('./index_error');

const TIMEOUT_MS = 20_000;
const MAX_PATH = 2000;
const MAX_BODY = 1024 * 1024; // bytes of JSON read before the call is refused
const DOT_SEG = /(^|\/)\.{1,2}(\/|$)/;
const JSON_TYPE = /^application\/json\s*(;|$)/i;

/** The path, or a ToolError('BAD_PATH'). */
function cleanPath(raw) {
  const p = String(raw || '');
  if (!p.startsWith('/')) throw new ToolError('BAD_PATH', 'path must start with /');
  if (p.length > MAX_PATH) throw new ToolError('BAD_PATH', `path longer than ${MAX_PATH}`);
  if (/[?#]/.test(p)) throw new ToolError('BAD_PATH', 'put query parameters in `query`, not in the path');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\\s]/.test(p)) throw new ToolError('BAD_PATH', 'path carries whitespace, a control character or a backslash');
  if (p.includes('//')) throw new ToolError('BAD_PATH', 'path has an empty segment (//)');
  let decoded;
  try { decoded = decodeURIComponent(p); } catch (_) { throw new ToolError('BAD_PATH', 'path has a malformed %-escape'); }
  if (DOT_SEG.test(p) || DOT_SEG.test(decoded) || decoded.includes('\\')) throw new ToolError('BAD_PATH', 'path has a . or .. segment');
  return p;
}

function queryString(query) {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/** Read at most `cap` bytes of a body; throws TOO_LARGE past it (the body is cancelled). */
async function readCapped(res, cap, route) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new ToolError('TOO_LARGE', `refused: ${route} answered more than ${cap} bytes; ask for less (a filter, a page, fewer fields)`, { route, cap });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = {
  name: 'api_get',
  description: 'Call a GET route of this app as the current user (their own session, their own permissions; the route\'s own 403 tells you what was missing). Only staff GET routes marked auto-runnable are allowed: superuser routes, credential/key reads and non-JSON responses are refused with the reason. Give the concrete path (e.g. /api/contacts/123) and query parameters as an object. Returns { status, body }. Find routes with lookup_routes; read the handler with read_source.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: MAX_PATH, description: 'Concrete path, no query string.' },
      query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Query parameters as strings.' },
      purpose: { type: 'string', maxLength: 200, description: 'One line on why (activity trail).' },
    },
    required: ['path'],
  },
  untrusted: true,
  async run(ctx, input) {
    const p = cleanPath(input.path);
    const cat = catalog.catalogFor(ctx.app);
    const row = catalog.findRoute(cat, 'GET', p);
    if (!row) throw new ToolError('NO_ROUTE', `no GET route serves ${p}`, { path: p });
    if (!row.autoGet) {
      const why = row.authClass === 'su'
        ? `superuser route (T${row.tier}); it can only run as a card the user approves (not in S1)`
        : row.authClass === 'unknown' ? 'its auth could not be classified'
        : !['staff', 'staff:can'].includes(row.authClass) ? `${row.authClass} route — not a staff route`
        : `T${row.tier} read closed to automatic calls (${row.tierReason || 'policy'})`;
      throw new ToolError('NOT_AUTO_GET', `refused: ${row.method} ${row.path} — ${why}`, { route: row.path, auth: row.authClass, tier: `T${row.tier}` });
    }
    const h = ctx.headers || {};
    if (!h.authorization) throw new ToolError('NO_AUTH', 'the caller has no Authorization header to act with');
    const headers = {
      authorization: h.authorization,
      accept: 'application/json',
      'accept-encoding': 'identity',
      'user-agent': h['user-agent'] || 'casey',
      'x-casey-via': String(ctx.via || 'casey'),
    };
    const xff = h['x-forwarded-for'] || ctx.ip;
    if (xff) headers['x-forwarded-for'] = String(xff);
    const url = `http://127.0.0.1:${ctx.port}${p}${queryString(input.query)}`;
    const ac = new AbortController();
    const timeoutMs = ctx.timeoutMs || TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res, text;
    try {
      try {
        res = await (ctx.fetch || fetch)(url, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
      } catch (e) {
        throw new ToolError(ac.signal.aborted ? 'TIMEOUT' : 'FETCH_FAILED', ac.signal.aborted ? `no response within ${timeoutMs} ms` : String(e && e.message || e), { route: row.path });
      }
      const ctype = String(res.headers.get('content-type') || '');
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new ToolError('REDIRECT', `refused: ${row.method} ${row.path} answered ${res.status} with a redirect; redirects are never followed`, { route: row.path, status: res.status, location: res.headers.get('location') || null });
      }
      if (!JSON_TYPE.test(ctype)) {
        await res.body?.cancel().catch(() => {});
        throw new ToolError('NON_JSON', `refused: ${row.method} ${row.path} answered ${res.status} with ${ctype || 'no content type'}, not JSON`, { route: row.path, status: res.status, content_type: ctype });
      }
      try {
        text = await readCapped(res, ctx.maxBody || MAX_BODY, row.path);
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError(ac.signal.aborted ? 'TIMEOUT' : 'FETCH_FAILED', ac.signal.aborted ? `no complete response within ${timeoutMs} ms` : String(e && e.message || e), { route: row.path });
      }
    } finally {
      clearTimeout(timer);
    }
    let body;
    try { body = JSON.parse(text); } catch (_) { throw new ToolError('BAD_JSON', `the route answered ${res.status} with unparseable JSON`, { route: row.path, status: res.status }); }
    return { route: row.path, status: res.status, body };
  },
  // Shared with api_write (S3b): the same path rules and query building for a card's steps.
  cleanPath, queryString,
};
