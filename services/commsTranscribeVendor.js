// services/commsTranscribeVendor.js
//
/**
 * Comms archive S2 — the STT vendor boundary: AssemblyAI (design P7, §6.3).
 *
 * Every call goes through async buildHeadersForCredential(db, credId, url)
 * (CLAUDE.md "Outbound auth"); the credential id is DATA (app_settings
 * comms_stt_credential_id — credential 14 "Assembly AI": api_key, header
 * Authorization = the raw key, allowed_urls https://api.assemblyai.com/*).
 * Calls never throw on an HTTP status; they return
 * { status, json, retryAfterS, errorText } (status 0 = network / timeout).
 * They throw err.code 'NO_AUTH' BEFORE sending when the credential yields no
 * Authorization (disconnected, missing, URL outside allowed_urls).
 *
 * The request (verified against the API reference 2026-10-14):
 *   POST /v2/transcript {audio_url, speech_models:['universal-3-5-pro'],
 *     speaker_labels (diarize) | multichannel, language_detection,
 *     keyterms_prompt (only when non-empty: +$0.05/h)}
 *   GET /v2/transcript/<id> → {id, status queued|processing|completed|error,
 *     error, audio_duration (s), language_code, utterances[{speaker, channel,
 *     start, end (ms), text}], text}
 *   DELETE /v2/transcript/<id> → removes the vendor's transcript data.
 *   GET /v2/transcript?created_on=&limit=&before_id= → {transcripts:[{id,
 *     audio_url, status, created, …}], page_details} — finds the job a
 *     timed-out POST may have created (matched by sha256 of our audio_url).
 *
 * Every errorText is passed through redactUrls: a vendor error that quotes
 * our signed URL never carries its query string (the signature) into
 * last_error, an alert or a log.
 * PURE exports (lane D's review route calls segmentsFromVendorJson on the
 * variant JSON — keep it pure and strict):
 *   segmentsFromVendorJson(json) -> [{s, a, b, t}]   (a/b seconds, 3 decimals)
 *                                   throws err.code 'DRIFT' on an unknown shape
 *   fullTextOf(segments, json)   -> string
 *   stripSignedUrl(json)         -> a copy whose audio_url is origin + path only
 *                                   (the query string is our V4 signature)
 *   costCents({audioS, variant, channels, keyterms}) -> number (4 dp)
 *   redactUrls(text)             -> text with every URL's ?query cut to ?…
 *   validJobId(id)               -> boolean (safe to put in a URL path)
 */

'use strict';

const API = 'https://api.assemblyai.com/v2';
const CALL_TIMEOUT_MS = 30_000;
const MODEL = 'universal-3-5-pro';

/**
 * Price card, cents per audio hour (assemblyai.com/pricing.md, 2026-10-14):
 * Universal-3.5 Pro async 21, diarization +2, keyterms prompting +5;
 * multichannel bills PER CHANNEL (a 2-channel hour = 2 billable hours).
 */
const RATE_CENTS_PER_H = Object.freeze({ base: 21, diarize: 2, keyterms: 5 });

const VARIANTS = Object.freeze({
  diarize: { part: 'assemblyai', model: `${MODEL}+diarize` },
  multichannel: { part: 'assemblyai-mc', model: `${MODEL}+multichannel` },
});

function _ms(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

async function _auth(db, credId, url) {
  const { buildHeadersForCredential } = require('../lib/credentialInjection'); // lazy require (convention)
  const headers = await buildHeadersForCredential(db, credId, url);
  const has = Object.keys(headers || {}).some(k => k.toLowerCase() === 'authorization' && headers[k]);
  if (!has) {
    const e = new Error(`STT credential ${credId} produced no Authorization for ${new URL(url).host}`);
    e.code = 'NO_AUTH';
    throw e;
  }
  return headers;
}

/** Pre-flight before any claim: does the credential yield an Authorization header? */
async function checkAuth(db, credId) {
  try {
    await _auth(db, credId, `${API}/transcript`);
    return true;
  } catch (err) {
    if (err.code === 'NO_AUTH') return false;
    throw err;
  }
}

async function _call(db, credId, method, url, body, timeoutMs) {
  const headers = await _auth(db, credId, url);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(_ms(timeoutMs, CALL_TIMEOUT_MS)),
    });
  } catch (err) {
    return { status: 0, json: null, retryAfterS: null, errorText: redactUrls(String(err && (err.name === 'TimeoutError' ? 'timeout' : err.message))).slice(0, 300) };
  }
  const ra = res.headers.get('retry-after');
  const retryAfterS = ra == null || ra === '' ? null : Number(ra);
  let text = '';
  try { text = await res.text(); } catch (_) { /* body gone */ }
  let json = null;
  if (res.status >= 200 && res.status < 300) {
    try { json = JSON.parse(text); } catch (_) { json = undefined; }   // undefined = unparseable 2xx
  }
  return { status: res.status, json, retryAfterS, errorText: json === null || json === undefined ? redactUrls(text).slice(0, 300) : null };
}

/**
 * Submit one transcription job. `variant` ∈ VARIANTS.
 * keyterms: string[] (sent only when non-empty — it is a paid add-on).
 */
async function submit(db, { credId, audioUrl, variant, keyterms = [], languageDetection = true, timeoutMs }) {
  if (!VARIANTS[variant]) throw new Error(`submit: unknown variant ${variant}`);
  const body = {
    audio_url: audioUrl,
    speech_models: [MODEL],
    language_detection: !!languageDetection,
  };
  if (variant === 'diarize') body.speaker_labels = true;
  else body.multichannel = true;
  if (Array.isArray(keyterms) && keyterms.length) body.keyterms_prompt = keyterms;
  return _call(db, credId, 'POST', `${API}/transcript`, body, timeoutMs);
}

const validJobId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);

function _jobUrl(id) {
  if (!validJobId(id)) throw new Error(`bad transcript id ${String(id).slice(0, 40)}`);
  return `${API}/transcript/${id}`;
}

/** One page of the account's transcripts created on a UTC date (YYYY-MM-DD), newest first. */
async function listTranscripts(db, { credId, createdOn, beforeId = null, limit = 200, timeoutMs }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(createdOn || ''))) throw new Error('listTranscripts: createdOn must be YYYY-MM-DD');
  const u = new URL(`${API}/transcript`);
  u.searchParams.set('created_on', createdOn);
  u.searchParams.set('limit', String(Math.max(1, Math.min(200, Number(limit) || 200))));
  if (beforeId) { if (!validJobId(beforeId)) throw new Error('listTranscripts: bad before_id'); u.searchParams.set('before_id', beforeId); }
  return _call(db, credId, 'GET', u.toString(), null, timeoutMs);
}

async function getTranscript(db, { credId, id, timeoutMs }) {
  return _call(db, credId, 'GET', _jobUrl(id), null, timeoutMs);
}

async function deleteTranscript(db, { credId, id, timeoutMs }) {
  return _call(db, credId, 'DELETE', _jobUrl(id), null, timeoutMs);
}

// ─────────────────────────────────────────────────────────────
// Pure
// ─────────────────────────────────────────────────────────────

function _drift(what) {
  const e = new Error(`vendor shape drift: ${what}`);
  e.code = 'DRIFT';
  return e;
}

const _num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const _sec = (ms) => Math.round(ms) / 1000;

/**
 * AssemblyAI transcript JSON → [{s, a, b, t}] (design §5: s speaker, a/b
 * start/end SECONDS, t text). A diarized transcript labels speakers 'A', 'B'…;
 * a multichannel one is keyed by channel → 'ch1', 'ch2'. A completed
 * transcript with no speech has utterances [] or null and text '' → [].
 * Anything else is drift (throws err.code 'DRIFT') — never an empty "done".
 */
function segmentsFromVendorJson(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw _drift('not an object');
  if (json.status !== 'completed') throw _drift(`status ${JSON.stringify(json.status)}`);
  const u = json.utterances;
  const text = json.text;
  const hasText = !(text === '' || text === null || text === undefined);
  if (u === null || u === undefined) {
    if (!hasText) return [];
    throw _drift('utterances missing on a transcript with text');
  }
  if (!Array.isArray(u)) throw _drift('utterances not an array');
  if (!u.length && hasText) throw _drift('no utterances on a transcript with text');
  const multi = json.multichannel === true;
  return u.map((x, i) => {
    if (!x || typeof x !== 'object') throw _drift(`utterance ${i} not an object`);
    if (!_num(x.start) || !_num(x.end) || x.end < x.start) throw _drift(`utterance ${i} times`);
    if (typeof x.text !== 'string') throw _drift(`utterance ${i} text`);
    let s;
    if (multi) {
      if (x.channel == null || !/^\d{1,2}$/.test(String(x.channel))) throw _drift(`utterance ${i} channel`);
      s = `ch${x.channel}`;
    } else {
      if (x.speaker == null || !/^[A-Za-z0-9]{1,8}$/.test(String(x.speaker))) throw _drift(`utterance ${i} speaker`);
      s = String(x.speaker);
    }
    return { s, a: _sec(x.start), b: _sec(x.end), t: x.text };
  });
}

/** The searchable text: one line per segment (FULLTEXT + S3's grounding check read it). */
function fullTextOf(segments, json) {
  if (segments.length) return segments.map(x => x.t).join('\n');
  return json && typeof json.text === 'string' ? json.text : '';
}

/** Cut the query string (?…) off every URL in a text — a signature never reaches storage or an alert. */
function redactUrls(text) {
  return String(text == null ? '' : text).replace(/(\bhttps?:\/\/[^\s?#"'<>]*)\?[^\s"'<>]*/gi, '$1?…');
}

/** A copy of the vendor JSON without our signature: audio_url → origin + path. */
function stripSignedUrl(json) {
  const out = { ...json };
  if (typeof out.audio_url === 'string') {
    try {
      const u = new URL(out.audio_url);
      out.audio_url = `${u.origin}${u.pathname}`;
    } catch (_) {
      out.audio_url = '(unparseable — removed)';
    }
  }
  return out;
}

/** What one job costs, in cents (4 dp). */
function costCents({ audioS, variant, channels = 2, keyterms = false }) {
  const h = Math.max(0, Number(audioS) || 0) / 3600;
  const kt = keyterms ? RATE_CENTS_PER_H.keyterms : 0;
  const perH = variant === 'multichannel'
    ? (RATE_CENTS_PER_H.base + kt) * Math.max(1, Number(channels) || 2)
    : RATE_CENTS_PER_H.base + RATE_CENTS_PER_H.diarize + kt;
  return Math.round(h * perH * 10_000) / 10_000;
}

/**
 * A job's `error` text → what the sweep does. 'download' = AssemblyAI could
 * not fetch our signed URL (resubmit with a fresh one; if a whole tick's
 * submits hit it, our signing is broken). Everything else is 'vendor'.
 */
function classifyJobError(text) {
  const s = String(text || '');
  if (/download|could not (access|retrieve|fetch)|unable to (access|download|fetch)|audio_url|not found at|403|404|expired/i.test(s)) return 'download';
  return 'vendor';
}

module.exports = {
  API, MODEL, VARIANTS, RATE_CENTS_PER_H,
  checkAuth, submit, getTranscript, deleteTranscript, listTranscripts,
  segmentsFromVendorJson, fullTextOf, stripSignedUrl, costCents, classifyJobError, redactUrls, validJobId,
};
