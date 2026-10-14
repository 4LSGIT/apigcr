// services/commsArchiveSearch.js
//
/**
 * Comms archive S6 — transcript search. ref/COMMS_ARCHIVE_DESIGN.md §9 S6, §7.
 * Route: POST /api/comms-archive/search {q, line_id, cursor, limit} (routes/api.commsArchive.js).
 *
 * FULLTEXT MATCH(full_text, summary_text) AGAINST(? IN BOOLEAN MODE) over
 * comms_transcripts (S2's ft_comms_transcripts, the default InnoDB parser:
 * live and twin both innodb_ft_min_token_size 3, max 84, the default
 * stopword list ON — verified 2026-10-14).
 *
 * ── THE QUERY NEVER CARRIES USER OPERATORS ─────────────────────────────────
 * The text is cut into the parser's own words — runs of letters, digits and
 * underscore — so + - < > ( ) ~ * " @ & | : can never reach the boolean
 * parser. Words under 3 characters and InnoDB's default stopwords are
 * dropped (and echoed back as `ignored`): in boolean mode a REQUIRED term the
 * index cannot hold (`+the*`, `+26*`) makes the whole search return nothing —
 * measured on MySQL 8.4. What is left is AND-ed as prefixes: '+t1* +t2*'
 * ("bank" finds "bankruptcy"). No phrase search (ref/plans.md). No LIKE.
 *
 * ── WHO SEES WHAT (design §7 — the same rules as canReadMedia / the thread) ─
 * One statement: the item archived; the transcript in a readable state
 * (transcribed / summarized); restricted rows only for archive admins; a row
 * sourced from a phone_event_log event held to the event's own line and
 * never suppressed (review A2); the item's line among the viewer's readable
 * lines (mailboxService.listReadable), or — with no line filter — a line-less
 * item for the SU / attorney bypass. An empty readable list runs no SQL.
 * Rows the viewer may not read are not counted, hinted at or snippeted.
 *
 * ── SNIPPETS: never more text than needed ──────────────────────────────────
 * Read only for the page's rows: the first segment holding a term (as a word
 * prefix) — clipped to SNIPPET_CHARS around the hit — with its start second;
 * else the same window of summary_text / full_text. One per result, plain
 * text (the pane renders it with textContent).
 */

'use strict';

const admin = require('./commsArchiveAdmin');
const { READABLE_STATES } = require('./commsArchiveView');

const MAX_Q = 200;
const MIN_TERM = 3;          // innodb_ft_min_token_size
const MAX_TERM = 84;         // innodb_ft_max_token_size
const MAX_TERMS = 8;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const SNIPPET_CHARS = 160;
const LEAD_CHARS = 50;
const WORD_RE = /[\p{L}\p{N}_]+/gu;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const CURSOR_RE = /^(\d{1,15})\.(\d{1,19})$/;
const MAX_CURSOR_MS = 253402300799999;   // 9999-12-31T23:59:59.999Z — past it toISOString() turns '+010000-…' and MySQL refuses the DATETIME
/** InnoDB's default stopword list (INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD, MySQL 8.4). */
const STOPWORDS = new Set(['a', 'about', 'an', 'are', 'as', 'at', 'be', 'by', 'com', 'de', 'en', 'for', 'from', 'how', 'i', 'in', 'is',
  'it', 'la', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'und', 'was', 'what', 'when', 'where', 'who', 'will', 'with', 'www']);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.expose = true;
  return e;
}

/**
 * q → {terms, ignored, against}. `against` is '' when nothing usable is left.
 * Terms are lower-cased, unique, in the order typed.
 */
function tokenize(q) {
  const terms = [];
  const ignored = [];
  for (const raw of String(q == null ? '' : q).match(WORD_RE) || []) {
    const w = raw.toLowerCase();
    if (w.length < MIN_TERM || STOPWORDS.has(w)) { if (!ignored.includes(w)) ignored.push(w); continue; }
    const t = safeSlice(w, 0, MAX_TERM);
    if (!terms.includes(t) && terms.length < MAX_TERMS) terms.push(t);
  }
  return { terms, ignored, against: terms.map(t => `+${t}*`).join(' ') };
}

/** A slice that never splits a surrogate pair (an emoji typed or transcribed). */
function safeSlice(s, a, b) {
  let x = a;
  let y = b;
  if (x > 0 && x < s.length && /[\uDC00-\uDFFF]/.test(s[x])) x -= 1;            // start on a low half → take its high half too
  if (y > 0 && y < s.length && /[\uD800-\uDBFF]/.test(s[y - 1])) y -= 1;        // end after a high half → drop it
  return s.slice(x, y);
}

/** Index of the first place a term starts a word in `text` (case-insensitive), or -1. */
function firstHit(text, terms) {
  const low = String(text || '').toLowerCase();
  let best = -1;
  for (const t of terms) {
    let i = low.indexOf(t);
    while (i >= 0) {
      if (i === 0 || !WORD_CHAR.test(low[i - 1])) { if (best < 0 || i < best) best = i; break; }
      i = low.indexOf(t, i + 1);
    }
  }
  return best;
}

/** A SNIPPET_CHARS window of `text` around index `at` (whole text when short). */
function clip(text, at) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= SNIPPET_CHARS) return s;
  const hit = at < 0 ? 0 : Math.min(at, s.length - 1);
  let a = Math.max(0, hit - LEAD_CHARS);
  let b = Math.min(s.length, a + SNIPPET_CHARS);
  if (b - a < SNIPPET_CHARS) a = Math.max(0, b - SNIPPET_CHARS);
  return `${a > 0 ? '…' : ''}${safeSlice(s, a, b).trim()}${b < s.length ? '…' : ''}`;
}

/** → {snippet, snippet_at, snippet_from} for one transcript row. */
function snippetOf(row, terms) {
  let segs = row.segments;
  if (typeof segs === 'string') { try { segs = JSON.parse(segs); } catch (_) { segs = null; } }
  if (Array.isArray(segs)) {
    for (const g of segs) {
      if (!g || typeof g.t !== 'string') continue;
      const i = firstHit(g.t, terms);
      if (i >= 0) {
        const norm = g.t.replace(/\s+/g, ' ').trim();
        return { snippet: clip(norm, firstHit(norm, terms)), snippet_at: Number.isFinite(Number(g.a)) ? Number(g.a) : null, snippet_from: 'transcript' };
      }
    }
  }
  for (const [text, from] of [[row.summary_text, 'summary'], [row.full_text, 'transcript']]) {
    if (text == null) continue;
    const norm = String(text).replace(/\s+/g, ' ').trim();
    const i = firstHit(norm, terms);
    if (i >= 0) return { snippet: clip(norm, i), snippet_at: null, snippet_from: from };
  }
  // The index matched but no word prefix did here (a parser / normalisation edge): the opening only.
  const first = Array.isArray(segs) && segs.find(g => g && typeof g.t === 'string' && g.t.trim());
  if (first) return { snippet: clip(first.t, 0), snippet_at: Number.isFinite(Number(first.a)) ? Number(first.a) : null, snippet_from: 'transcript' };
  return { snippet: clip(row.full_text || row.summary_text || '', 0), snippet_at: null, snippet_from: row.full_text ? 'transcript' : 'summary' };
}

function parseCursor(v) {
  if (v === undefined || v === null || v === '') return null;
  const m = CURSOR_RE.exec(String(v));
  if (!m || Number(m[1]) > MAX_CURSOR_MS) throw httpError(400, 'cursor is malformed — pass back next_cursor unchanged');
  return { at: new Date(Number(m[1])), id: Number(m[2]) };
}
const sqlUtc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * Search the transcripts the caller may read.
 * @param {object} p  {q, lineId (number|null), cursor, limit}
 * @returns {{results, next_cursor, terms, ignored}}  — throws httpError 400 / 404
 */
async function search(db, auth, { q, lineId = null, cursor = null, limit } = {}) {
  if (typeof q !== 'string' || !q.trim()) throw httpError(400, 'q is required');
  if (q.length > MAX_Q) throw httpError(400, `q is at most ${MAX_Q} characters`);
  const tok = tokenize(q);
  if (!tok.terms.length) {
    const e = httpError(400, 'A search needs a word of 3 or more letters');
    e.tok = tok;
    throw e;
  }
  const n = Math.min(PAGE_MAX, Math.max(1, Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : PAGE_DEFAULT));
  const cur = parseCursor(cursor);
  const out = { results: [], next_cursor: null, terms: tok.terms, ignored: tok.ignored };

  const mbx = require('./mailboxService'); // lazy require (convention)
  const readable = (await mbx.listReadable(db, auth.userId, 'phone_line')).map(l => Number(l.id));
  if (lineId != null && !readable.includes(Number(lineId))) throw httpError(404, 'Phone line not found');
  const scope = lineId != null ? [Number(lineId)] : readable;
  const bypass = lineId == null && (await admin.hasLineBypass(db, auth));
  if (!scope.length && !bypass) return out;
  const isAdmin = await admin.isArchiveAdmin(db, auth);

  const lines = [];
  const params = [tok.against, READABLE_STATES];
  if (scope.length) { lines.push('m.channel_id IN (?)'); params.push(scope); }
  if (bypass) lines.push('m.channel_id IS NULL');
  let keyset = '';
  if (cur) { keyset = ' AND (m.captured_at < ? OR (m.captured_at = ? AND m.id < ?))'; params.push(sqlUtc(cur.at), sqlUtc(cur.at), cur.id); }
  params.push(n + 1);
  const [rows] = await db.query(
    `SELECT m.id, m.kind, m.source_table, m.source_id, m.channel_id, m.party, m.captured_at, m.restricted
       FROM comms_transcripts t
       JOIN comms_media m ON m.id = t.media_id AND m.state = 'archived'
                         AND m.channel = 'phone' AND m.kind IN ('call_recording', 'voicemail')
       LEFT JOIN phone_event_log e ON m.source_table = 'phone_event_log' AND e.id = m.source_id
       LEFT JOIN phone_lines pl ON pl.phone_number = e.line_number
      WHERE MATCH(t.full_text, t.summary_text) AGAINST(? IN BOOLEAN MODE)
        AND t.state IN (?)
        AND m.captured_at IS NOT NULL
        ${isAdmin ? '' : 'AND m.restricted = 0'}
        AND (m.source_table <> 'phone_event_log' OR (e.suppressed = 0 AND pl.id <=> m.channel_id))
        AND (${lines.join(' OR ')})${keyset}
      ORDER BY m.captured_at DESC, m.id DESC
      LIMIT ?`,
    params);
  const page = rows.slice(0, n);
  if (!page.length) return out;

  // The text, for the page's rows only — re-checked (review A1): a row
  // restricted, purged or re-queued since the match gives no snippet and
  // leaves the page rather than leak a line of it.
  const [texts] = await db.query(
    `SELECT t.media_id, t.segments, t.summary_text, t.full_text
       FROM comms_transcripts t JOIN comms_media m ON m.id = t.media_id AND m.state = 'archived'
      WHERE t.media_id IN (?) AND t.state IN (?)${isAdmin ? '' : ' AND m.restricted = 0'}`,
    [page.map(r => r.id), READABLE_STATES]);
  const byId = new Map(texts.map(t => [Number(t.media_id), t]));
  out.results = page.filter(r => byId.has(Number(r.id))).map((r) => ({
    media_id: Number(r.id),
    event_id: r.source_table === 'phone_event_log' ? Number(r.source_id) : null,
    source_table: r.source_table,
    line_id: r.channel_id == null ? null : Number(r.channel_id),
    party: r.party == null ? null : String(r.party),
    kind: r.kind,
    captured_at: new Date(r.captured_at).toISOString(),
    restricted: Number(r.restricted) === 1,
    ...snippetOf(byId.get(Number(r.id)) || {}, tok.terms),
  }));
  if (rows.length > n) {
    const last = page[page.length - 1];
    out.next_cursor = `${new Date(last.captured_at).getTime()}.${last.id}`;
  }
  return out;
}

module.exports = { search, tokenize, snippetOf, firstHit, clip, safeSlice, STOPWORDS, MAX_Q, SNIPPET_CHARS, PAGE_MAX };
