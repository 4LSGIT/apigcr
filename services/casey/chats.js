// services/casey/chats.js — Casey v2 S2: casey_chats / casey_messages access
// (ref/CASEY_V2_DESIGN.md §4.6 "state is the raw message array"; schema in
// ref/migrations/2026-11-22_casey_v2_chats.sql, column COMMENTs carry the
// contract).
//
// Every read and write is scoped by user_id: a transcript is private to the
// person who had it — superusers included, until S4's review view reads with
// its own gate. `content` is the Messages API block array as JSON TEXT in a
// utf8mb4_bin LONGTEXT — the exact bytes sent or received, parsed on read —
// NOT a json column: MySQL re-orders object keys and normalises numbers in
// one, which would break the prompt-cache prefix at the first replayed
// tool_use input (S2 review). `meta` is a json column (never replayed), so
// it is compared parsed. `thinking_floor_seq`: rows below it lose their
// thinking / redacted_thinking blocks on load (they were produced under
// another prefix and can never be replayed); the loop raises it, never lowers.
//
// One turn in flight per chat: claimTurn() is ONE conditional UPDATE on
// running_since (NULL, or older than CLAIM_STALE_MIN — a turn that died with
// its instance), so two instances racing for the same chat see one winner;
// releaseTurn() clears it and re-stamps prompt_version when the loop asks.
'use strict';

const TITLE_MAX = 120;
const CLAIM_STALE_MIN = 15;   // > the longest turn (5 min budget + a 120 s floor per call + the 64k retry), < Cloud Run's 900 s request limit
const LIST_MAX = 100;

const CHAT_COLS = 'id, user_id, title, model, effort, prompt_version, thinking_floor_seq, running_since, stop_requested_at, created_at, updated_at';

function parseJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/** The chat title from its first message: whitespace-normalised, cut to TITLE_MAX. */
function titleFrom(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || '(untitled)';
}

async function createChat(db, { userId, text, model, effort, promptVersion }) {
  const [r] = await db.query(
    'INSERT INTO casey_chats (user_id, title, model, effort, prompt_version) VALUES (?,?,?,?,?)',
    [userId, titleFrom(text), model, effort, promptVersion]);
  return r.insertId;
}

async function getChat(db, id, userId) {
  const [[row]] = await db.query(`SELECT ${CHAT_COLS} FROM casey_chats WHERE id = ? AND user_id = ?`, [id, userId]);
  return row || null;
}

async function listChats(db, userId, limit = 50) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), LIST_MAX);
  const [rows] = await db.query(
    `SELECT c.id, c.title, c.model, c.effort, c.prompt_version, c.running_since, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM casey_messages m WHERE m.chat_id = c.id) AS message_count
       FROM casey_chats c WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id DESC LIMIT ${n}`, [userId]);
  return rows;
}

/** → true when a row of this user's was deleted (messages cascade). */
async function deleteChat(db, id, userId) {
  const [r] = await db.query('DELETE FROM casey_chats WHERE id = ? AND user_id = ?', [id, userId]);
  return r.affectedRows === 1;
}

/** → true when this call took the claim (and cleared any stale stop request). */
async function claimTurn(db, id, userId) {
  const [r] = await db.query(
    `UPDATE casey_chats SET running_since = UTC_TIMESTAMP(), stop_requested_at = NULL
      WHERE id = ? AND user_id = ? AND (running_since IS NULL OR running_since < UTC_TIMESTAMP() - INTERVAL ${CLAIM_STALE_MIN} MINUTE)`,
    [id, userId]);
  return r.affectedRows === 1;
}

/** The page's Stop: marks a RUNNING turn of this user's chat. → true when a running turn was marked. */
async function requestStop(db, id, userId) {
  const [r] = await db.query(
    'UPDATE casey_chats SET stop_requested_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ? AND running_since IS NOT NULL AND stop_requested_at IS NULL',
    [id, userId]);
  return r.affectedRows === 1;
}

/** The loop's check before each model call. */
async function stopRequested(db, id) {
  const [[row]] = await db.query('SELECT stop_requested_at IS NOT NULL AS s FROM casey_chats WHERE id = ?', [id]);
  return !!(row && Number(row.s));
}

/**
 * Release the claim. promptVersion re-stamps the chat; thinkingFloorSeq RAISES
 * the floor (GREATEST — never lowered: a floor records blocks that can never
 * be replayed again). Both or neither: a re-stamp without the floor would
 * bring the unreplayable blocks back on the next turn.
 */
async function releaseTurn(db, id, { promptVersion, thinkingFloorSeq } = {}) {
  if (promptVersion) {
    await db.query('UPDATE casey_chats SET running_since = NULL, prompt_version = ?, thinking_floor_seq = GREATEST(thinking_floor_seq, ?) WHERE id = ?',
      [promptVersion, Number(thinkingFloorSeq) || 0, id]);
  } else {
    await db.query('UPDATE casey_chats SET running_since = NULL WHERE id = ?', [id]);
  }
}

/** Strip thinking / redacted_thinking from an assistant block array; an emptied array keeps one text block. */
function stripThinkingBlocks(content) {
  if (!Array.isArray(content)) return content;
  const kept = content.filter((b) => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
  return kept.length ? kept : [{ type: 'text', text: '[reasoning omitted]' }];
}

/**
 * The chat's rows in seq order, content parsed from its exact text, meta
 * parsed; assistant rows with seq < thinkingFloorSeq have their thinking
 * blocks dropped (the rows are untouched).
 */
async function loadMessages(db, chatId, { thinkingFloorSeq = 0 } = {}) {
  const [rows] = await db.query(
    'SELECT id, seq, role, content, meta, created_at FROM casey_messages WHERE chat_id = ? ORDER BY seq', [chatId]);
  const floor = Number(thinkingFloorSeq) || 0;
  return rows.map((r) => {
    const content = parseJson(r.content);
    const below = Number(r.seq) < floor && r.role === 'assistant';
    return { ...r, seq: Number(r.seq), content: below ? stripThinkingBlocks(content) : content, meta: parseJson(r.meta) };
  });
}

/**
 * Append one message: seq = the chat's MAX(seq)+1 in the INSERT itself (one
 * statement, so no read-then-write gap; the claim keeps appends serial anyway).
 * `content` is written as JSON.stringify(content) — those exact bytes come back.
 * → { id, seq }
 */
async function appendMessage(db, chatId, role, content, meta = null) {
  if (!Array.isArray(content)) throw new Error('casey message content must be a block array');
  const [r] = await db.query(
    `INSERT INTO casey_messages (chat_id, seq, role, content, meta)
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ? FROM casey_messages WHERE chat_id = ?`,
    [chatId, role, JSON.stringify(content), meta == null ? null : JSON.stringify(meta), chatId]);
  const [[row]] = await db.query('SELECT seq FROM casey_messages WHERE id = ?', [r.insertId]);
  return { id: r.insertId, seq: row ? Number(row.seq) : null };
}

/** Delete the given message rows of a chat (a turn rolled back before anything else was stored). */
async function deleteMessages(db, chatId, ids) {
  if (!ids || !ids.length) return 0;
  const [r] = await db.query(`DELETE FROM casey_messages WHERE chat_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [chatId, ...ids]);
  return r.affectedRows;
}

// ── S4b: the superuser's review (ref/CASEY_V2_DESIGN.md §4.8; Fred, 2026-11-23:
// a superuser may read ANY chat — patterns, usage, abuse, attempts to spy or
// jailbreak — not only a flagged one). These readers are UNSCOPED by user: the
// route gates them (routes/api.casey.js: the SU casey guard — a superuser with a
// live elevation, 30 a minute). Nothing
// else in this module may use them.
const REVIEW_MAX = 200;

/**
 * Chats across every user, newest activity first: { id, user_id, user_name, title, model, effort,
 * prompt_version, created_at, updated_at, message_count, cost_cents, flags }. Filters: user (users.user),
 * q (a substring of the title, LIKE-escaped), flagged (only chats a casey report names), before (an
 * updated_at bound for paging), limit (≤ REVIEW_MAX).
 */
async function listForReview(db, { user = null, q = '', flagged = false, before = null, limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), REVIEW_MAX);
  const where = [];
  const params = [];
  if (user != null) { where.push('c.user_id = ?'); params.push(Number(user)); }
  const needle = String(q || '').trim();
  if (needle) { where.push("c.title LIKE ? ESCAPE '\\\\'"); params.push('%' + needle.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%'); }
  if (before) { where.push('c.updated_at < ?'); params.push(before); }
  const flagsSub = `(SELECT COUNT(*) FROM issue_reports r WHERE r.kind = 'casey' AND JSON_UNQUOTE(JSON_EXTRACT(r.context, '$.casey.chat_id')) = CAST(c.id AS CHAR))`;
  if (flagged) where.push(`${flagsSub} > 0`);
  const [rows] = await db.query(
    `SELECT c.id, c.user_id, u.user_name, c.title, c.model, c.effort, c.prompt_version, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM casey_messages m WHERE m.chat_id = c.id) AS message_count,
            (SELECT COALESCE(SUM(a.cost_cents), 0) FROM ai_calls a WHERE a.consumer_ref = CONCAT('assistant_v2:u', c.user_id, ':c', c.id)) AS cost_cents,
            ${flagsSub} AS flags
       FROM casey_chats c LEFT JOIN users u ON u.user = c.user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ${n}`, params);
  return rows.map((r) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id), message_count: Number(r.message_count), cost_cents: Number(r.cost_cents) || 0, flags: Number(r.flags) }));
}

/** One chat for the review, whoever owns it, with the owner's name; null when absent. */
async function getForReview(db, id) {
  const [[c]] = await db.query(`SELECT c.id, c.user_id, u.user_name, c.title, c.model, c.effort, c.prompt_version, c.thinking_floor_seq, c.created_at, c.updated_at
       FROM casey_chats c LEFT JOIN users u ON u.user = c.user_id WHERE c.id = ?`, [id]);
  return c ? { ...c, id: Number(c.id), user_id: Number(c.user_id) } : null;
}

/** The casey reports that name this chat: [{ id, seq, note, user_name, created_at, resolved_at, by }]. */
async function flagsForReview(db, chatId) {
  const [rows] = await db.query(
    `SELECT id, user_name, note, created_at, resolved_at,
            JSON_EXTRACT(context, '$.casey.seq') AS seq, JSON_UNQUOTE(JSON_EXTRACT(context, '$.casey.by')) AS flagged_by
       FROM issue_reports WHERE kind = 'casey' AND JSON_UNQUOTE(JSON_EXTRACT(context, '$.casey.chat_id')) = CAST(? AS CHAR) ORDER BY id`, [chatId]);
  return rows.map((r) => ({ id: Number(r.id), user_name: r.user_name, note: r.note, created_at: r.created_at, resolved_at: r.resolved_at, seq: r.seq == null ? null : Number(r.seq), by: r.flagged_by || 'user' }));   // `by` is a reserved word: aliased flagged_by in SQL
}

module.exports = {
  TITLE_MAX, CLAIM_STALE_MIN, LIST_MAX, REVIEW_MAX, titleFrom, parseJson, stripThinkingBlocks,
  createChat, getChat, listChats, deleteChat, claimTurn, releaseTurn, requestStop, stopRequested, loadMessages, appendMessage, deleteMessages,
  listForReview, getForReview, flagsForReview,
};
