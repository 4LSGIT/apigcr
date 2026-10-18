// Attachments and model-mode policy for Ask YisrAI.
// Temporary bytes live only in the browser request and Anthropic call. Existing
// documents are resolved through the registry/source seam on every call.

'use strict';

const crypto = require('crypto');
const documents = require('./documentService');
const sources = require('./documentSourceService');

const MAX_ATTACHMENTS = 4;
const MAX_TOTAL_BYTES = 6 * 1024 * 1024; // base64 stays below the app's 10 MB JSON limit
const MODEL_MODES = Object.freeze({
  better_quality: 'claude-opus-5',
  faster_speed: 'claude-sonnet-4-6',
});
const MIME_BY_EXT = Object.freeze({
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
});

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function modelMode(value) {
  const mode = String(value || 'better_quality');
  if (!MODEL_MODES[mode]) throw httpError(400, 'Model mode must be better_quality or faster_speed');
  return mode;
}

function modelForMode(value) { return MODEL_MODES[modelMode(value)]; }

function safeName(value) {
  return String(value == null ? '' : value).replace(/[\r\n]/g, ' ').trim().slice(0, 200) || 'attachment';
}

function mimeParts(mediaType) {
  const mime = String(mediaType || '').toLowerCase();
  if (mime === 'application/pdf') return { type: 'document', media_type: mime };
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return { type: 'image', media_type: mime };
  throw httpError(400, 'YisrAI attachments must be PDF, PNG, JPEG, GIF, or WebP files');
}

function decodedBase64(data) {
  const text = String(data || '');
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) {
    throw httpError(400, 'An attachment was not valid base64 data');
  }
  return Buffer.from(text, 'base64');
}

function digest(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function tempItem(raw) {
  const name = safeName(raw && raw.name);
  const parts = mimeParts(raw && raw.media_type);
  const buffer = decodedBase64(raw && raw.data_base64);
  if (!buffer.length) throw httpError(400, `${name} is empty`);
  return {
    label: name,
    size: buffer.length,
    claim: { kind: 'temporary', name, media_type: parts.media_type, size: buffer.length, sha256: digest(buffer) },
    block: { type: parts.type, media_type: parts.media_type, data_base64: buffer.toString('base64') },
  };
}

async function documentItem(db, rawId, expected) {
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id < 1) throw httpError(400, 'Invalid YisraCase document id');
  const row = await documents.getById(db, id);
  if (!row || row.status !== 'active') throw httpError(404, 'A selected YisraCase document is unavailable');
  const ext = String(row.ext || '').toLowerCase();
  const parts = mimeParts(MIME_BY_EXT[ext]);
  const declared = Number(row.size);
  if (!Number.isFinite(declared) || declared < 1) throw httpError(422, `${safeName(row.name || row.title)} has no usable file size`);
  if (declared > MAX_TOTAL_BYTES) throw httpError(413, `${safeName(row.name || row.title)} is too large for YisrAI`);
  if (expected && (String(expected.rev || '') !== String(row.rev || '') || String(expected.content_hash || '') !== String(row.content_hash || ''))) {
    throw httpError(409, `${safeName(row.name || row.title)} changed after the search was planned; ask again with the current file`);
  }
  const provider = sources.get(row.source);
  const downloaded = await provider.download(db, row.external_id);
  const buffer = downloaded && Buffer.isBuffer(downloaded.buffer) ? downloaded.buffer : null;
  if (!buffer || !buffer.length) throw httpError(502, `Could not read ${safeName(row.name || row.title)}`);
  const sha256 = digest(buffer);
  if (expected && expected.sha256 && expected.sha256 !== sha256) {
    throw httpError(409, `${safeName(row.name || row.title)} changed after the search was planned; ask again with the current file`);
  }
  const name = safeName(row.title || row.name);
  return {
    label: `${name} (YisraCase document #${id})`,
    size: buffer.length,
    claim: {
      kind: 'document', id, name, media_type: parts.media_type, size: buffer.length,
      rev: row.rev || null, content_hash: row.content_hash || null, sha256,
    },
    block: { type: parts.type, media_type: parts.media_type, data_base64: buffer.toString('base64') },
  };
}

function assertBudget(items) {
  if (items.length > MAX_ATTACHMENTS) throw httpError(400, `Attach no more than ${MAX_ATTACHMENTS} files`);
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (total > MAX_TOTAL_BYTES) throw httpError(413, 'YisrAI attachments must total 6 MB or less');
}

async function preparePlan(db, { temporary, documentIds } = {}) {
  const temp = Array.isArray(temporary) ? temporary : [];
  const ids = Array.isArray(documentIds) ? documentIds : [];
  if (temp.length + ids.length > MAX_ATTACHMENTS) throw httpError(400, `Attach no more than ${MAX_ATTACHMENTS} files`);
  const items = temp.map(tempItem);
  for (const id of ids) items.push(await documentItem(db, id));
  assertBudget(items);
  return pack(items);
}

async function prepareExecution(db, claims, temporary) {
  const expected = Array.isArray(claims) ? claims : [];
  const supplied = Array.isArray(temporary) ? temporary : [];
  const expectedTemp = expected.filter((c) => c && c.kind === 'temporary');
  if (supplied.length !== expectedTemp.length) throw httpError(400, 'The temporary attachments no longer match this search');
  const items = supplied.map(tempItem);
  for (let i = 0; i < expectedTemp.length; i++) {
    const got = items[i].claim, want = expectedTemp[i];
    if (got.sha256 !== want.sha256 || got.media_type !== want.media_type || got.name !== want.name) {
      throw httpError(400, 'The temporary attachments no longer match this search');
    }
  }
  for (const claim of expected.filter((c) => c && c.kind === 'document')) {
    items.push(await documentItem(db, claim.id, claim));
  }
  assertBudget(items);
  return pack(items);
}

function pack(items) {
  return {
    blocks: items.length ? items.map((item) => item.block) : undefined,
    claims: items.map((item) => item.claim),
    description: items.length ? items.map((item, i) => `${i + 1}. ${item.label}`).join('\n') : '(none)',
  };
}

module.exports = {
  preparePlan, prepareExecution, modelMode, modelForMode,
  MODEL_MODES, MIME_BY_EXT, MAX_ATTACHMENTS, MAX_TOTAL_BYTES,
};
