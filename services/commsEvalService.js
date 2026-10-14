// services/commsEvalService.js
//
/**
 * Comms archive S0 evaluation (lane D): the sampled calls, their audio and
 * transcripts for the reviewers, the reviewers' scores, and the production
 * signing check. Routes: routes/api.commsEval.js. Rubric: local/s0_eval_rubric.md
 * (private, pre-registered). Who may: services/commsArchiveAdmin.isEvalReviewer.
 *
 * Invariants:
 *  - ONLY sampled items (comms_eval_items) are reachable, and each access
 *    re-checks the comms_media row: purged → 410, restricted / not archived /
 *    not a call recording → 404 (a restriction made after sampling wins).
 *  - BLIND RULE: a reviewer is served an item's transcript only after saving
 *    a noise tag for it (stage 'transcript'); from the first time it is
 *    served (transcript_seen_at) the noise tag cannot change. The freeze is
 *    atomic: saveReview reads and writes the row under SELECT … FOR UPDATE in
 *    one transaction, and the serve stamps transcript_seen_at with an UPDATE
 *    of that same row — so a stamp either lands before the save (→ 409) or
 *    waits for it (the tag was set before anything was served).
 *  - Scores hold numbers, booleans and fixed tags ONLY (validateScores):
 *    unknown keys, strings outside the enums, out-of-range numbers → 400.
 *    No call content is ever stored.
 *  - The signing check never returns or logs a signed URL.
 */

'use strict';

const crypto = require('crypto');
const archive = require('./commsArchiveService');
const { httpError } = require('./commsArchiveAdmin');

const STAGES = Object.freeze(['transcript', 'transcript_alt', 'summary']);
const STRATA = /^S[1-7]$/;
const NOISE = Object.freeze(['N1', 'N2', 'N3']);
const ITEM_CLASSES = Object.freeze(['names', 'case_numbers', 'amounts', 'dates']);
const MAX_COUNT = 5000;
const MAX_START_S = 86400;
const WINDOW_S = 60;
const WHOLE_CALL_MAX_S = 90;       // calls this short are scored whole (rubric S1)
const MAX_SAMPLE = 60;

/** The S0 probe object (scripts/commsArchive/s0_infra.sh writes exactly this). */
const PROBE_OBJECT = '_s0/probe.txt';
const PROBE_TEXT = 'YisraCase comms archive S0 probe object. Not client data. Kept on purpose: the post-S1a signing check reads it, and delete detection skips the _s0/ prefix. See ref/INFRA_GCP.md.';

/**
 * Knobs and boundaries (tests replace them).
 *  fetch          — the HTTP client the signing check uses (global fetch).
 *  fetchTimeoutMs — per request.
 *  variantReader  — (db, mediaId) → [{s,a,b,t}] | null: the alternative (Quo
 *                   per-channel) transcript. S2 owns where it lives; by
 *                   default this asks S2's module if it exports one.
 */
const limits = {
  fetch: (...a) => globalThis.fetch(...a),
  onReviewLocked: null,   // test hook: runs while saveReview holds the review row's lock
  fetchTimeoutMs: 15000,
  variantReader: defaultVariantReader,
};

async function defaultVariantReader(db, mediaId) {
  let mod;
  try { mod = require('./commsTranscribeService'); } catch (_) { return null; } // S2 not deployed yet
  return typeof mod.variantSegments === 'function' ? mod.variantSegments(db, mediaId) : null;
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function bad(msg) { return httpError(400, msg); }
function onlyKeys(o, allowed, where) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${where}: unknown field "${k}"`);
}

/**
 * The fixed score schema. Returns a normalized copy; throws 400 otherwise.
 *   transcript      { noise, windows?, items?, turns?, one_party_per_channel?, complete? }
 *   transcript_alt  the same without noise (the noise tag lives on 'transcript')
 *   summary         not open until S3 exists
 */
function validateScores(stage, scores) {
  if (!STAGES.includes(stage)) throw bad('Unknown stage');
  if (stage === 'summary') throw bad('The summary stage opens when S3 (summaries) exists');
  if (!isObj(scores)) throw bad('scores must be an object');
  const allowed = ['windows', 'items', 'turns', 'one_party_per_channel', 'complete'];
  if (stage === 'transcript') allowed.unshift('noise');
  onlyKeys(scores, allowed, 'scores');
  const out = {};
  if (stage === 'transcript') {
    if (!NOISE.includes(scores.noise)) throw bad('noise must be N1, N2 or N3');
    out.noise = scores.noise;
  }
  if (scores.windows !== undefined) {
    if (!Array.isArray(scores.windows) || scores.windows.length > 2) throw bad('windows: at most 2');
    out.windows = scores.windows.map((w, i) => {
      if (!isObj(w)) throw bad(`windows[${i}] must be an object`);
      onlyKeys(w, ['start_s', 'words', 'sub', 'ins', 'del'], `windows[${i}]`);
      if (!isInt(w.start_s, 0, MAX_START_S)) throw bad(`windows[${i}].start_s out of range`);
      for (const k of ['words', 'sub', 'ins', 'del']) if (!isInt(w[k], 0, MAX_COUNT)) throw bad(`windows[${i}].${k} out of range`);
      if (w.sub + w.del > w.words) throw bad(`windows[${i}]: substitutions + deletions exceed the reference words`);
      return { start_s: w.start_s, words: w.words, sub: w.sub, ins: w.ins, del: w.del };
    });
  }
  if (scores.items !== undefined) {
    if (!isObj(scores.items)) throw bad('items must be an object');
    onlyKeys(scores.items, ITEM_CLASSES, 'items');
    out.items = {};
    for (const [k, v] of Object.entries(scores.items)) {
      if (!isObj(v)) throw bad(`items.${k} must be an object`);
      onlyKeys(v, ['heard', 'correct'], `items.${k}`);
      if (!isInt(v.heard, 0, MAX_COUNT) || !isInt(v.correct, 0, MAX_COUNT)) throw bad(`items.${k} out of range`);
      if (v.correct > v.heard) throw bad(`items.${k}: correct exceeds heard`);
      out.items[k] = { heard: v.heard, correct: v.correct };
    }
  }
  if (scores.turns !== undefined) {
    if (!isObj(scores.turns)) throw bad('turns must be an object');
    onlyKeys(scores.turns, ['total', 'correct'], 'turns');
    if (!isInt(scores.turns.total, 0, MAX_COUNT) || !isInt(scores.turns.correct, 0, MAX_COUNT)) throw bad('turns out of range');
    if (scores.turns.correct > scores.turns.total) throw bad('turns: correct exceeds total');
    out.turns = { total: scores.turns.total, correct: scores.turns.correct };
  }
  for (const k of ['one_party_per_channel', 'complete']) {
    if (scores[k] !== undefined) {
      if (typeof scores[k] !== 'boolean') throw bad(`${k} must be true or false`);
      out[k] = scores[k];
    }
  }
  return out;
}

/** Deterministic review windows (rubric §2): two 60 s windows from seed + id, or the whole call. */
function windowsFor({ seed, mediaId, audioS }) {
  const L = Number(audioS) || 0;
  if (L <= WHOLE_CALL_MAX_S) return [{ start_s: 0, whole: true }];
  const span = L - WINDOW_S;
  const h = (tag) => parseInt(crypto.createHash('sha256').update(`${seed}:${mediaId}:${tag}`).digest('hex').slice(0, 12), 16);
  const a = h('w1') % span;
  let b = h('w2') % span;
  if (Math.abs(a - b) < WINDOW_S) b = (a + Math.floor(span / 2)) % span;
  return [a, b].sort((x, y) => x - y).map(s => ({ start_s: s, whole: false }));
}

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** The list for a reviewer: ids and metadata only — never a name, number or content. */
async function listItems(db, reviewerId, { su = false } = {}) {
  const [rows] = await db.query(
    `SELECT ei.media_id, ei.stratum, ei.seed, ei.audio_s, cm.provider, cm.state, cm.restricted,
            DATE_FORMAT(cm.captured_at, '%Y-%m-%d') AS captured_day, pl.display_name AS line
       FROM comms_eval_items ei
       JOIN comms_media cm ON cm.id = ei.media_id
       LEFT JOIN phone_lines pl ON pl.id = cm.channel_id
      ORDER BY ei.stratum, ei.media_id`);
  const [mine] = await db.query(
    'SELECT media_id, stage, scores, transcript_seen_at FROM comms_eval_reviews WHERE reviewer_id = ?', [reviewerId]);
  const ready = await transcriptStates(db, rows.map(r => r.media_id));
  const byItem = new Map();
  for (const m of mine) {
    const s = parseJson(m.scores) || {};
    const e = byItem.get(String(m.media_id)) || {};
    e[m.stage] = { saved: true, complete: s.complete === true, noise: s.noise || null };
    byItem.set(String(m.media_id), e);
  }
  return rows.filter(r => su || (r.state === 'archived' && !r.restricted)).map(r => ({
    id: Number(r.media_id),
    stratum: r.stratum,
    provider: r.provider,
    line: r.line || null,
    day: r.captured_day,
    audio_s: r.audio_s == null ? null : Number(r.audio_s),
    available: r.state === 'archived' && !r.restricted,
    transcript_ready: ready.has(String(r.media_id)),
    windows: windowsFor({ seed: r.seed, mediaId: r.media_id, audioS: r.audio_s }),
    mine: byItem.get(String(r.media_id)) || {},
  }));
}

/** Media ids with a usable default transcript (S2's table may not exist yet). */
async function transcriptStates(db, ids) {
  const out = new Set();
  if (!ids.length) return out;
  try {
    const [rows] = await db.query(
      "SELECT media_id FROM comms_transcripts WHERE media_id IN (?) AND segments IS NOT NULL AND state IN ('transcribed', 'summarized')",
      [ids]);
    for (const r of rows) out.add(String(r.media_id));
  } catch (err) {
    if (err && err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return out;
}

/** One sampled item, re-checked. Throws 404 / 410. */
async function loadItem(db, id) {
  const [[row]] = await db.query(
    `SELECT ei.media_id, ei.seed, ei.audio_s, cm.kind, cm.provider, cm.state, cm.restricted, cm.object_name, cm.mime
       FROM comms_eval_items ei JOIN comms_media cm ON cm.id = ei.media_id
      WHERE ei.media_id = ?`, [id]);
  if (!row) throw httpError(404, 'Not in the evaluation sample');
  if (row.state === 'purged') throw httpError(410, 'This recording was purged');
  if (row.kind !== 'call_recording' || row.state !== 'archived' || row.restricted || !row.object_name) {
    throw httpError(404, 'This recording is not available');
  }
  return row;
}

/** A 5-minute signed URL for the item's audio. */
async function audioUrl(db, id) {
  const row = await loadItem(db, id);
  let url;
  try {
    url = await archive.signedUrl(row.object_name, { mime: row.mime || 'audio/mpeg' });
  } catch (err) {
    // our side (signing / IAM), whatever code GCS gave — never a 403/404 about the item
    const e = httpError(500, 'Could not create the audio link — try again, or tell IT');
    e.cause = err;
    throw e;
  }
  return { url, expires_in_s: Math.floor(archive.SIGNED_URL_TTL_MS / 1000) };
}

async function _review(db, reviewerId, id, stage) {
  const [[r]] = await db.query(
    'SELECT id, scores, transcript_seen_at FROM comms_eval_reviews WHERE reviewer_id = ? AND media_id = ? AND stage = ?',
    [reviewerId, id, stage]);
  return r ? { ...r, scores: parseJson(r.scores) } : null;
}

/** The transcript(s), only after this reviewer tagged the noise (blind rule). */
async function transcript(db, id, reviewerId) {
  await loadItem(db, id);
  const own = await _review(db, reviewerId, id, 'transcript');
  if (!own || !NOISE.includes(own.scores && own.scores.noise)) {
    throw httpError(409, 'Tag the noise level first — the transcript opens after that');
  }
  let def = null;
  try {
    const [[t]] = await db.query(
      "SELECT segments FROM comms_transcripts WHERE media_id = ? AND segments IS NOT NULL AND state IN ('transcribed', 'summarized')",
      [id]);
    if (t) def = parseJson(t.segments);
  } catch (err) {
    if (err && err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  if (!def) return { ready: false };
  if (!own.transcript_seen_at) {
    await db.query(
      'UPDATE comms_eval_reviews SET transcript_seen_at = UTC_TIMESTAMP() WHERE id = ? AND transcript_seen_at IS NULL', [own.id]);
  }
  const variant = await limits.variantReader(db, id);
  return {
    ready: true,
    default: { segments: def },
    ...(Array.isArray(variant) ? { variant: { label: 'per-channel', segments: variant } } : {}),
  };
}

/** This reviewer's own saved scores for one item, by stage (numbers and tags only). */
async function myReviews(db, id, reviewerId) {
  await loadItem(db, id);
  const [rows] = await db.query(
    'SELECT stage, scores, transcript_seen_at FROM comms_eval_reviews WHERE reviewer_id = ? AND media_id = ?', [reviewerId, id]);
  const out = {};
  for (const r of rows) out[r.stage] = { scores: parseJson(r.scores), transcript_opened: !!r.transcript_seen_at };
  return out;
}

/** Save (replace) this reviewer's scores for one item and stage. */
async function saveReview(db, id, reviewerId, stage, scores) {
  const clean = validateScores(stage, scores);
  await loadItem(db, id);
  const { withTransaction } = require('../lib/withTransaction'); // lazy require (convention)
  await withTransaction(db, async (conn) => {
    const [[prev]] = await conn.query(
      `SELECT scores, transcript_seen_at FROM comms_eval_reviews
        WHERE reviewer_id = ? AND media_id = ? AND stage = ? FOR UPDATE`, [reviewerId, id, stage]);
    if (limits.onReviewLocked) await limits.onReviewLocked();
    const before = prev ? parseJson(prev.scores) : null;
    if (stage === 'transcript' && prev && prev.transcript_seen_at && before && before.noise !== clean.noise) {
      throw httpError(409, 'The noise tag is fixed once the transcript has been opened');
    }
    await conn.query(
      `INSERT INTO comms_eval_reviews (reviewer_id, media_id, stage, scores) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE scores = VALUES(scores)`,
      [reviewerId, id, stage, JSON.stringify(clean)]);
  }, { retries: 1 });
  return clean;
}

/**
 * Insert the sample (SU). Every item must be an archived, unrestricted call
 * recording and not already sampled; all or nothing.
 * @param {{seed:string, items:{media_id:number, stratum:string, audio_s?:number}[]}} body
 */
async function addSample(db, body, userId) {
  if (!isObj(body)) throw bad('body must be an object');
  onlyKeys(body, ['seed', 'items'], 'body');
  const seed = body.seed;
  if (typeof seed !== 'string' || !/^[0-9a-f]{8,32}$/.test(seed)) throw bad('seed must be 8–32 lowercase hex characters');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_SAMPLE) throw bad(`items: 1–${MAX_SAMPLE}`);
  const seen = new Set();
  const items = body.items.map((it, i) => {
    if (!isObj(it)) throw bad(`items[${i}] must be an object`);
    onlyKeys(it, ['media_id', 'stratum', 'audio_s'], `items[${i}]`);
    if (!isInt(it.media_id, 1, Number.MAX_SAFE_INTEGER)) throw bad(`items[${i}].media_id must be a positive integer`);
    if (typeof it.stratum !== 'string' || !STRATA.test(it.stratum)) throw bad(`items[${i}].stratum must be S1–S7`);
    if (it.audio_s !== undefined && !isInt(it.audio_s, 0, MAX_START_S)) throw bad(`items[${i}].audio_s out of range`);
    if (seen.has(it.media_id)) throw bad(`items[${i}]: media ${it.media_id} listed twice`);
    seen.add(it.media_id);
    return { media_id: it.media_id, stratum: it.stratum, audio_s: it.audio_s ?? null };
  });
  const ids = items.map(i => i.media_id);
  const [media] = await db.query(
    'SELECT id, kind, state, restricted FROM comms_media WHERE id IN (?)', [ids]);
  const byId = new Map(media.map(m => [Number(m.id), m]));
  const refused = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) refused.push({ media_id: id, why: 'no such archive item' });
    else if (m.kind !== 'call_recording') refused.push({ media_id: id, why: 'not a call recording' });
    else if (m.state !== 'archived') refused.push({ media_id: id, why: `state ${m.state}` });
    else if (m.restricted) refused.push({ media_id: id, why: 'restricted' });
  }
  const [dupes] = await db.query('SELECT media_id FROM comms_eval_items WHERE media_id IN (?)', [ids]);
  for (const d of dupes) refused.push({ media_id: Number(d.media_id), why: 'already in the sample' });
  if (refused.length) {
    const e = httpError(400, 'Some items cannot be sampled — nothing was added');
    e.refused = refused;
    throw e;
  }
  const { withTransaction } = require('../lib/withTransaction'); // lazy require (convention)
  await withTransaction(db, async (conn) => {
    for (const it of items) {
      await conn.query(
        'INSERT INTO comms_eval_items (media_id, stratum, seed, audio_s, added_by) VALUES (?, ?, ?, ?, ?)',
        [it.media_id, it.stratum, seed, it.audio_s, userId]);
    }
  }, { retries: 1 });
  return { added: items.length, seed };
}

async function _fetchStatus(url, { readBody }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limits.fetchTimeoutMs);
  try {
    const res = await limits.fetch(url, { method: 'GET', redirect: 'error', signal: ctrl.signal });
    const body = readBody ? Buffer.from(await res.arrayBuffer()) : null;
    if (!readBody && res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, error: err && err.name === 'AbortError' ? 'timed out' : 'request failed' };
  } finally {
    clearTimeout(timer);
  }
}

/** One signature digit changed — the URL must then be refused. */
function tamper(url) {
  const m = /([?&]x-goog-signature=)([0-9a-f]+)/i.exec(url);
  if (!m) return null;
  const sig = m[2];
  const last = sig[sig.length - 1].toLowerCase();
  const flipped = sig.slice(0, -1) + (last === '0' ? '1' : '0');
  return url.slice(0, m.index) + m[1] + flipped + url.slice(m.index + m[0].length);
}

/**
 * The first production signing (lane A's post-S1a check): the runtime SA
 * signs the S0 probe; the signed URL must give 200 and the probe's exact
 * bytes; the same URL with one signature digit changed must give 403.
 * Returns statuses only — never the URL.
 */
async function signingCheck() {
  let url;
  try {
    url = await archive.signedUrl(PROBE_OBJECT, { mime: 'text/plain' });
  } catch (err) {
    return { pass: false, sign: 'failed', detail: (err && err.message ? err.message : 'signing failed').slice(0, 300) };
  }
  const want = crypto.createHash('sha256').update(PROBE_TEXT).digest('hex');
  const good = await _fetchStatus(url, { readBody: true });
  const bytesMatch = !!good.body && crypto.createHash('sha256').update(good.body).digest('hex') === want;
  const turned = tamper(url);
  const badRes = turned ? await _fetchStatus(turned, { readBody: false }) : { status: 0, error: 'no signature parameter in the URL' };
  const pass = good.status === 200 && bytesMatch && badRes.status === 403;
  return {
    pass,
    sign: 'ok',
    signed: { status: good.status, bytes_match: bytesMatch, ...(good.error ? { error: good.error } : {}) },
    tampered: { status: badRes.status, ...(badRes.error ? { error: badRes.error } : {}) },
  };
}

module.exports = {
  STAGES, NOISE, ITEM_CLASSES, PROBE_OBJECT, PROBE_TEXT,
  validateScores, windowsFor, listItems, loadItem, audioUrl, transcript, myReviews, saveReview, addSample,
  signingCheck, tamper, limits,
};
