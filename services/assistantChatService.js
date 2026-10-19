// services/assistantChatService.js
// User-private recent chat history for Ask Casey/YisrAI. This is convenience state,
// not the query audit trail: SQL remains in report_runs.

'use strict';

const MAX_CHATS = 30;
const MAX_TITLE = 120;
const MAX_MESSAGE = 20000;
const MAX_PAYLOAD = 100000;
const MODEL_MODES = new Set(['better_quality', 'faster_speed']);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function user(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw httpError(403, 'A signed-in user is required');
  return n;
}

function chatId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw httpError(400, 'Invalid chat id');
  return n;
}

function modelMode(value) {
  const mode = String(value || 'better_quality');
  if (!MODEL_MODES.has(mode)) throw httpError(400, 'Model mode must be better_quality or faster_speed');
  return mode;
}

function messageText(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw httpError(400, 'Message text is required');
  if (text.length > MAX_MESSAGE) throw httpError(400, `Message text must be ${MAX_MESSAGE.toLocaleString()} characters or fewer`);
  return text;
}

function titleFor(question) {
  const compact = messageText(question).replace(/\s+/g, ' ');
  return compact.slice(0, MAX_TITLE);
}

function payloadJson(value) {
  if (value == null) return null;
  const json = JSON.stringify(value);
  if (json.length > MAX_PAYLOAD) throw httpError(400, 'Message details are too large to save');
  return json;
}

function parsePayload(value) {
  if (value == null || typeof value === 'object') return value || null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

async function list(db, userId) {
  const [rows] = await db.query(
    `SELECT id, title, model_mode, created_at, updated_at
       FROM assistant_chats
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?`,
    [user(userId), MAX_CHATS]
  );
  return rows;
}

async function owned(db, id, userId) {
  const [[row]] = await db.query(
    `SELECT id, title, model_mode, created_at, updated_at
       FROM assistant_chats
      WHERE id = ? AND user_id = ?
      LIMIT 1`,
    [chatId(id), user(userId)]
  );
  if (!row) throw httpError(404, 'Chat not found');
  return row;
}

async function get(db, id, userId) {
  const chat = await owned(db, id, userId);
  const [rows] = await db.query(
    `SELECT id, role, message_text, payload, created_at
       FROM assistant_chat_messages
      WHERE chat_id = ?
      ORDER BY id ASC`,
    [chat.id]
  );
  return {
    ...chat,
    messages: rows.map((r) => ({
      id: r.id, role: r.role, text: r.message_text, payload: parsePayload(r.payload), created_at: r.created_at,
    })),
  };
}

async function prune(db, userId) {
  const uid = user(userId);
  const [old] = await db.query(
    `SELECT id FROM assistant_chats
      WHERE user_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1000 OFFSET ?`,
    [uid, MAX_CHATS]
  );
  const ids = old.map((r) => Number(r.id)).filter(Number.isSafeInteger);
  if (ids.length) await db.query(`DELETE FROM assistant_chats WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [uid, ...ids]);
}

async function create(db, { userId, question, modelMode: requestedMode, payload }) {
  const uid = user(userId);
  const text = messageText(question);
  const mode = modelMode(requestedMode);
  if (text.length > 2000) throw httpError(400, 'Question must be 2,000 characters or fewer');
  const [made] = await db.query(
    'INSERT INTO assistant_chats (user_id, title, model_mode) VALUES (?, ?, ?)',
    [uid, titleFor(text), mode]
  );
  const id = Number(made.insertId);
  await db.query(
    `INSERT INTO assistant_chat_messages (chat_id, role, message_text, payload)
     VALUES (?, 'user', ?, ?)`,
    [id, text, payloadJson(payload)]
  );
  await prune(db, uid);
  return { id, title: titleFor(text), model_mode: mode };
}

async function setModelMode(db, id, userId, requestedMode) {
  const mode = modelMode(requestedMode);
  const chat = await owned(db, id, userId);
  await db.query('UPDATE assistant_chats SET model_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [mode, chat.id, user(userId)]);
  return { ...chat, model_mode: mode };
}

async function addMessage(db, id, userId, { role, text, payload } = {}) {
  const safeRole = role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : null;
  if (!safeRole) throw httpError(400, 'Message role must be user or assistant');
  const safeText = messageText(text);
  const json = payloadJson(payload);
  const chat = await owned(db, id, userId);
  await db.query(
    'INSERT INTO assistant_chat_messages (chat_id, role, message_text, payload) VALUES (?, ?, ?, ?)',
    [chat.id, safeRole, safeText, json]
  );
  await db.query('UPDATE assistant_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [chat.id, user(userId)]);
  return { id: chat.id };
}

async function remove(db, id, userId) {
  const [result] = await db.query('DELETE FROM assistant_chats WHERE id = ? AND user_id = ?', [chatId(id), user(userId)]);
  if (!result.affectedRows) throw httpError(404, 'Chat not found');
}

module.exports = {
  list, get, create, addMessage, setModelMode, remove, titleFor, parsePayload, modelMode,
  MAX_CHATS, MAX_MESSAGE, MAX_PAYLOAD,
};
