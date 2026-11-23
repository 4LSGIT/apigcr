// services/casey/notes.js — Casey v2's pitfalls document (ref/CASEY_V2_DESIGN.md
// §4.7; as built §9 S4a): notes the firm edits in Admin → Casey Notes that
// steer Casey without a deploy.
//
// Two kinds of scope. `global` is appended to the system prompt on every turn
// (lib/caseyPrompt.systemText(notes)); its hash is part of the chat's
// prompt_version, so an edit is a prompt change — open chats drop their stored
// thinking blocks once on their next turn, exactly as a deploy of the prompt
// does, and the edit steers the very next turn. A route FAMILY scope
// ('/api/contacts', as lib/routeFamilies.familyOf names it) rides with every
// lookup_routes hit in that family (`note`), so it costs nothing until the
// family is relevant.
//
// Versions, never edits: casey_notes rows are inserted and read, never updated
// or deleted. The current note of a scope is its highest version; a restore
// writes a new version carrying an older body. Who saved what, and why, stays
// readable. Two savers of one scope at once: each reads the scope's latest row
// FOR UPDATE and inserts the next number; on InnoDB the loser dies with
// ER_LOCK_DEADLOCK (the winner's INSERT meets the loser's waiting gap lock —
// lib/withTransaction retryOnDeadlock's own worked case), so the span is
// re-run once and lands on the new latest. The UNIQUE (scope, version) key is
// the net for an engine without gap locks (a duplicate key, retried once too).
//
// Reads are cached per process for CACHE_MS (one SELECT per turn otherwise);
// save() and restore() clear this instance's cache, so the editor's own
// instance is current at once and the others within the window. Casey can
// never write here: every /api/casey route is never proposable
// (lib/caseySensitivity) and no tool reaches this module's writers.
'use strict';

const { familyOf } = require('../../lib/routeFamilies');
const catalog = require('../../lib/routeCatalog');
const { retryOnDeadlock } = require('../../lib/withTransaction');

const GLOBAL = 'global';
const GLOBAL_MAX = 20000;      // characters — the global body rides in the cached prefix of EVERY turn (~5k tokens at most)
const FAMILY_MAX = 2000;
const EDIT_NOTE_MAX = 300;
const SCOPE_MAX = 64;
const CACHE_MS = 30 * 1000;
const CASEY_CLASSES = new Set(['staff', 'staff:can', 'su']);   // the families lookup_routes can show (services/casey/tools/lookup_routes.js)

class NotesError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * A scope is `global` or a route family exactly as familyOf would name it, in
 * the lower-case letters, digits, `_` and `-` route paths use. The column is
 * utf8mb4_general_ci (case-insensitive, PAD SPACE): a variant spelling
 * ('/api/Tasks', '/api/tasks ') would pass the row lock and the UNIQUE key as
 * the family and then hide the note from lookup_routes (review S4), so none is
 * accepted.
 */
const FAMILY_RE = /^\/[a-z0-9_-]+(\/[a-z0-9_-]+)?$/;
function isScope(s) {
  if (typeof s !== 'string' || !s || s.length > SCOPE_MAX) return false;
  return s === GLOBAL || (FAMILY_RE.test(s) && familyOf(s) === s);
}
function capFor(scope) { return scope === GLOBAL ? GLOBAL_MAX : FAMILY_MAX; }

/**
 * LF line ends, trailing whitespace off every line, no trailing blank lines.
 * Linear: trimEnd(), never a `\s+$` regex — that one is quadratic on a run of
 * spaces that does not end the line, and the body is request input (review
 * B1; CLAUDE.md "keep validator regexes linear").
 */
function normalize(body) {
  const lines = String(body == null ? '' : body).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---- reads ----------------------------------------------------------------

let cache = null;   // { at, doc }

const CURRENT_SQL = `SELECT n.scope, n.version, n.body FROM casey_notes n
  JOIN (SELECT scope, MAX(version) AS version FROM casey_notes GROUP BY scope) m ON m.scope = n.scope AND m.version = n.version`;

/**
 * The notes in force: { global: string, families: { family → body }, versions: { scope → version } }.
 * Blank bodies are omitted from `families` and read as '' for global. Cached per process for CACHE_MS unless `fresh`.
 */
async function current(db, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.doc;
  const [rows] = await db.query(CURRENT_SQL);
  const doc = { global: '', families: {}, versions: {} };
  for (const r of rows) {
    const body = normalize(r.body);
    doc.versions[r.scope] = Number(r.version);
    if (r.scope === GLOBAL) doc.global = body;
    else if (body) doc.families[r.scope] = body;
  }
  Object.freeze(doc.families); Object.freeze(doc.versions); Object.freeze(doc);
  cache = { at: Date.now(), doc };
  return doc;
}
function clearCache() { cache = null; }

/** The current row of every scope that has one (the editor's list), newest save first. */
async function currentRows(db) {
  const [rows] = await db.query(`SELECT n.id, n.scope, n.version, n.body, n.edit_note, n.author_id, n.author_name, n.created_at FROM casey_notes n
    JOIN (SELECT scope, MAX(version) AS version FROM casey_notes GROUP BY scope) m ON m.scope = n.scope AND m.version = n.version
    ORDER BY (n.scope = ?) DESC, n.scope`, [GLOBAL]);
  return rows.map(rowOut);
}

/** Every version of a scope, newest first, without bodies (their length instead). */
async function versions(db, scope) {
  if (!isScope(scope)) throw new NotesError(400, 'unknown scope');
  const [rows] = await db.query(
    'SELECT id, scope, version, CHAR_LENGTH(body) AS chars, edit_note, author_id, author_name, created_at FROM casey_notes WHERE scope = ? ORDER BY version DESC', [scope]);
  return rows.map((r) => ({ ...rowOut(r), chars: Number(r.chars) }));
}

/** One version with its body, or null. */
async function version(db, scope, v) {
  if (!isScope(scope)) throw new NotesError(400, 'unknown scope');
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new NotesError(400, 'version must be a positive integer');
  const [[row]] = await db.query('SELECT id, scope, version, body, edit_note, author_id, author_name, created_at FROM casey_notes WHERE scope = ? AND version = ?', [scope, n]);
  return row ? rowOut(row) : null;
}

function rowOut(r) {
  return {
    id: Number(r.id), scope: r.scope, version: Number(r.version),
    ...(r.body !== undefined ? { body: r.body } : {}),
    edit_note: r.edit_note, author_id: r.author_id == null ? null : Number(r.author_id), author_name: r.author_name,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

/** The route families a note may attach to: the live catalog's staff-reachable families, sorted. */
function familyScopes(app) {
  const cat = catalog.catalogFor(app);
  const set = new Set();
  for (const r of cat.rows) if (CASEY_CLASSES.has(r.authClass) && r.family && isScope(r.family)) set.add(r.family);
  return [...set].sort();
}

// ---- writes ---------------------------------------------------------------

/**
 * Save a new version of `scope`. Refuses an unknown scope, a body over the
 * scope's cap, a blank or over-long edit note, and a body equal to the current
 * one (409: nothing to save). The version number is taken under the row lock
 * of the scope's latest row inside the transaction; the UNIQUE key makes a
 * lost race an error, not a silent overwrite (one retry).
 * → the new row (with body).
 */
async function save(db, { scope, body, editNote, author }) {
  if (!isScope(scope)) throw new NotesError(400, 'unknown scope');
  // The raw length first: nothing below runs over a body that cannot be saved whatever its whitespace (express.json admits 10 MB).
  const raw = String(body == null ? '' : body);
  if (raw.length > capFor(scope) * 2) throw new NotesError(400, `the note is ${raw.length.toLocaleString('en-US')} characters as sent; the limit for ${scope} is ${capFor(scope).toLocaleString('en-US')}`);
  const text = normalize(raw);
  const chars = [...text].length;   // code points — what the page counts and CHAR_LENGTH reports (the raw guard above counts UTF-16 units, never fewer)
  if (chars > capFor(scope)) throw new NotesError(400, `the note is ${chars.toLocaleString('en-US')} characters; the limit for ${scope} is ${capFor(scope).toLocaleString('en-US')}`);
  const note = String(editNote == null ? '' : editNote).trim();
  if (!note) throw new NotesError(400, 'an edit note is required (why this change)');
  if (note.length > EDIT_NOTE_MAX) throw new NotesError(400, `the edit note is longer than ${EDIT_NOTE_MAX} characters`);
  if (!author || author.userId == null) throw new NotesError(401, 'a signed-in user is required');
  const authorName = String(author.username || author.userId).slice(0, 64);

  const attempt = () => db.withTransaction(async (conn) => {
    const [[cur]] = await conn.query('SELECT version, body FROM casey_notes WHERE scope = ? ORDER BY version DESC LIMIT 1 FOR UPDATE', [scope]);
    if (cur && normalize(cur.body) === text) throw new NotesError(409, 'unchanged: the current version already says exactly this');
    const next = cur ? Number(cur.version) + 1 : 1;
    const [r] = await conn.query(
      'INSERT INTO casey_notes (scope, version, body, edit_note, author_id, author_name) VALUES (?,?,?,?,?,?)',
      [scope, next, text, note, author.userId, authorName]);
    return { id: r.insertId, version: next };
  });
  let ins;
  try { ins = await retryOnDeadlock(attempt); } catch (e) {   // the loser of a concurrent save: InnoDB reports a deadlock (above); re-run once on the new latest
    if (e && e.code === 'ER_DUP_ENTRY') ins = await attempt();   // an engine without gap locks surfaces the same race as a duplicate key
    else throw e;
  }
  clearCache();
  return version(db, scope, ins.version);
}

/** A new version carrying version `v`'s body. */
async function restore(db, { scope, version: v, editNote, author }) {
  const old = await version(db, scope, v);
  if (!old) throw new NotesError(404, `no version ${v} of ${scope}`);
  const note = `Restored version ${old.version}${editNote && String(editNote).trim() ? ': ' + String(editNote).trim() : ''}`;
  return save(db, { scope, body: old.body, editNote: note.slice(0, EDIT_NOTE_MAX), author });
}

module.exports = {
  GLOBAL, GLOBAL_MAX, FAMILY_MAX, EDIT_NOTE_MAX, SCOPE_MAX, CACHE_MS, NotesError,
  isScope, capFor, normalize, current, clearCache, currentRows, versions, version, familyScopes, save, restore,
};
