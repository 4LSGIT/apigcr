// badge-ask-route.js
// Temp "badge" endpoint: audio (or text) -> STT -> Claude (+ web search) -> OLED-paginated JSON.
//
// Routes are defined with full /badge/... paths, so mount at root:
//   const badgeRoute = require('./badge-ask-route');
//   app.use(badgeRoute);          // -> POST /badge/ask , GET /badge/last.wav
//
// Requires Node 18+ (global fetch / FormData / Blob). Env vars:
//   STT_PROVIDER          'groq' (default) | 'elevenlabs'
//   GROQ_API_KEY          required if STT_PROVIDER=groq
//   GROQ_STT_MODEL        default 'whisper-large-v3-turbo'  (or 'distil-whisper-large-v3-en' for EN-only/cheapest)
//   ELEVENLABS_API_KEY    required if STT_PROVIDER=elevenlabs
//   ELEVEN_STT_MODEL      default 'scribe_v1'
//   ANTHROPIC_API_KEY     required
//   ANTHROPIC_MODEL       default 'claude-haiku-4-5-20251001'
//   BADGE_DEVICE_TOKEN    optional shared secret; if set, device must send header  x-badge-token
//   OLED_COLS / OLED_ROWS / OLED_MAX_PAGES   display geometry (defaults 21 / 5 / 6)
//   BADGE_CITY/REGION/COUNTRY/TZ             optional: localize web-search results (e.g. weather)
//
// Web search: the Anthropic web_search tool is attached to every request; Claude decides on its
// own whether to search (weather, news, prices, scores, live data) or answer from training.
// Cost ~ $10 / 1000 searches + the extra input tokens; max_uses caps searches per request.
//
// Audio body may be a WAV (Content-Type: audio/wav) OR headerless 16-bit PCM
// (Content-Type: application/octet-stream). For raw PCM the device passes rate/channels as query
// params, e.g. POST /badge/ask?rate=16000&ch=1 -- the route prepends the 44-byte WAV header.
//
// Debug: GET /badge/last.wav?token=SECRET downloads the most recent capture. Each audio request
// logs a 'pcm stats' line (peak/rms/nonzeroPct) so you can tell dead silence from real signal.

const express = require('express');
const router = express.Router();

// ---- config ----
const STT_PROVIDER    = process.env.STT_PROVIDER    || 'groq';
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const GROQ_STT_MODEL  = process.env.GROQ_STT_MODEL  || 'whisper-large-v3-turbo';
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVEN_MODEL    = process.env.ELEVEN_STT_MODEL || 'scribe_v1';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const DEVICE_TOKEN    = process.env.BADGE_DEVICE_TOKEN || '';

const COLS      = parseInt(process.env.OLED_COLS || '21', 10);
const ROWS      = parseInt(process.env.OLED_ROWS || '5', 10);
const MAX_PAGES = parseInt(process.env.OLED_MAX_PAGES || '6', 10);

// optional: localize web-search results (e.g. weather). Leave BADGE_CITY empty to omit.
const BADGE_CITY    = process.env.BADGE_CITY    || '';     // e.g. 'Southfield'
const BADGE_REGION  = process.env.BADGE_REGION  || '';     // e.g. 'Michigan'
const BADGE_COUNTRY = process.env.BADGE_COUNTRY || 'US';
const BADGE_TZ      = process.env.BADGE_TZ      || '';     // e.g. 'America/Detroit'
const SEARCH_MAX_USES = parseInt(process.env.SEARCH_MAX_USES || '3', 10);

let lastWav = null;   // most recent capture, served by GET /badge/last.wav

// ---- logging helpers ----
const log = (...a) => console.log('[badge/ask]', ...a);
const errlog = (...a) => console.error('[badge/ask]', ...a);
const mask = (v) => (v ? `set(${String(v).length} chars, …${String(v).slice(-4)})` : 'MISSING');
const preview = (s, n = 200) => {
  const str = String(s == null ? '' : s);
  return str.length > n ? `${str.slice(0, n)}… (${str.length} chars)` : str;
};

// log effective config once at module load so we can see what the server actually booted with
log('config', {
  STT_PROVIDER,
  GROQ_API_KEY: mask(GROQ_API_KEY),
  GROQ_STT_MODEL,
  ELEVENLABS_API_KEY: mask(ELEVEN_API_KEY),
  ELEVEN_STT_MODEL: ELEVEN_MODEL,
  ANTHROPIC_API_KEY: mask(ANTHROPIC_KEY),
  ANTHROPIC_MODEL,
  BADGE_DEVICE_TOKEN: DEVICE_TOKEN ? 'set' : 'none',
  COLS, ROWS, MAX_PAGES,
  WEB_SEARCH: `on (max_uses=${SEARCH_MAX_USES})`,
  LOCATION: BADGE_CITY ? `${BADGE_CITY}${BADGE_REGION ? ', ' + BADGE_REGION : ''}, ${BADGE_COUNTRY}` : 'none',
});

// body parsers: raw audio OR json text (each only fires on its own content-type)
router.use(express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '12mb' }));
router.use(express.json({ limit: '64kb' }));

// ---- text -> OLED lines ----
function wrap(text, cols) {
  const out = [];
  for (const para of String(text).replace(/\r/g, '').split('\n')) {
    if (para.trim() === '') { out.push(''); continue; }
    let line = '';
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > cols) {            // hard-break tokens longer than a line
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, cols));
        word = word.slice(cols);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= cols) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

function paginate(lines, rows, maxPages) {
  const pages = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows));
  if (pages.length > maxPages) {
    const trimmed = pages.slice(0, maxPages);
    const last = trimmed[maxPages - 1];
    const i = last.length - 1;
    last[i] = (last[i] || '').slice(0, COLS - 1) + '\u2026'; // ellipsis marks truncation
    return trimmed;
  }
  return pages;
}

// ---- raw PCM -> WAV (device streams headerless PCM; we add the 44-byte header here) ----
function pcmToWav(pcm, rate, channels, bits) {
  const blockAlign = channels * bits / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);             // fmt chunk size
  h.writeUInt16LE(1, 20);              // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * blockAlign, 28); // byte rate
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function ensureWav(buf, rate, channels) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') return buf; // already WAV
  return pcmToWav(buf, rate, channels, 16);                                   // wrap raw 16-bit PCM
}

// ---- PCM analyzer (diagnose silent vs real signal) ----
function pcmStats(buf) {
  const n = buf.length >> 1;
  let peak = 0, sumSq = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i << 1);
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    if (s !== 0) nz++;
    sumSq += s * s;
  }
  const head = [];
  for (let i = 0; i < Math.min(8, n); i++) head.push(buf.readInt16LE(i << 1));
  return {
    samples: n,
    peak,                                   // 0 = dead silence (slot/wiring); thousands = real signal
    rms: Math.round(Math.sqrt(sumSq / Math.max(1, n))),
    nonzeroPct: Math.round(100 * nz / Math.max(1, n)),
    dbfs: peak > 0 ? Math.round(20 * Math.log10(peak / 32768)) : null,
    head,                                   // first 8 raw samples
  };
}

// ---- STT providers (swap via STT_PROVIDER) ----
async function sttGroq(buf) {
  log('sttGroq -> request', { model: GROQ_STT_MODEL, wavBytes: buf.length, keyPresent: !!GROQ_API_KEY });
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', GROQ_STT_MODEL);
  form.append('language', 'en');
  form.append('response_format', 'json');
  const t0 = Date.now();
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  log('sttGroq <- response', { status: r.status, ok: r.ok, ms: Date.now() - t0 });
  if (!r.ok) {
    const body = await r.text();
    errlog('sttGroq ERROR body:', body);          // full Groq error so we can read it server-side
    throw new Error(`Groq STT ${r.status}: ${body}`);
  }
  const json = await r.json();
  const text = (json.text || '').trim();
  log('sttGroq transcript:', preview(text));
  return text;
}

async function sttElevenLabs(buf) {
  log('sttElevenLabs -> request', { model: ELEVEN_MODEL, wavBytes: buf.length, keyPresent: !!ELEVEN_API_KEY });
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model_id', ELEVEN_MODEL);
  const t0 = Date.now();
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_API_KEY },
    body: form,
  });
  log('sttElevenLabs <- response', { status: r.status, ok: r.ok, ms: Date.now() - t0 });
  if (!r.ok) {
    const body = await r.text();
    errlog('sttElevenLabs ERROR body:', body);
    throw new Error(`ElevenLabs STT ${r.status}: ${body}`);
  }
  const json = await r.json();
  const text = (json.text || '').trim();
  log('sttElevenLabs transcript:', preview(text));
  return text;
}

function transcribe(buf) {
  log('transcribe via', STT_PROVIDER);
  return STT_PROVIDER === 'elevenlabs' ? sttElevenLabs(buf) : sttGroq(buf);
}

// ---- Claude (+ web search) ----
async function askClaude(question) {
  const system =
    `You are a pocket reference badge. Answer in plain ASCII text only - no markdown, asterisks, ` +
    `headers, bullet lists, emoji, or non-ASCII symbols (write "deg C" not the degree sign, "ohms" ` +
    `not the omega sign). Be extremely concise: prefer one answer that fits a tiny OLED of about ` +
    `${COLS} chars by ${ROWS} lines. Hard cap about ${COLS * ROWS * MAX_PAGES} characters. ` +
    `Lead with the answer, no preamble. Use web search when the question needs current or real-time ` +
    `info (weather, news, prices, schedules, scores, live data); otherwise answer from your own knowledge.`;

  // Claude decides whether to search; max_uses caps cost/latency.
  const webTool = { type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES };
  if (BADGE_CITY) {
    webTool.user_location = {
      type: 'approximate',
      city: BADGE_CITY,
      ...(BADGE_REGION ? { region: BADGE_REGION } : {}),
      country: BADGE_COUNTRY,
      ...(BADGE_TZ ? { timezone: BADGE_TZ } : {}),
    };
  }

  log('askClaude -> request', {
    model: ANTHROPIC_MODEL, keyPresent: !!ANTHROPIC_KEY, question: preview(question),
    webSearch: true, loc: BADGE_CITY || 'none',
  });
  const t0 = Date.now();
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,                 // room for the internal search loop + final answer
      system,
      tools: [webTool],
      messages: [{ role: 'user', content: question }],
    }),
  });
  log('askClaude <- response', { status: r.status, ok: r.ok, ms: Date.now() - t0 });
  if (!r.ok) {
    const body = await r.text();
    errlog('askClaude ERROR body:', body);
    throw new Error(`Anthropic ${r.status}: ${body}`);
  }
  const j = await r.json();

  // Take the text AFTER the last search activity so a "let me check..." preamble before the
  // search never lands on the OLED. If no search happened, this is just all the text blocks.
  const blocks = j.content || [];
  let lastTool = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'server_tool_use' || blocks[i].type === 'web_search_tool_result') lastTool = i;
  }
  const answer = blocks.slice(lastTool + 1).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const searches = blocks.filter(b => b.type === 'server_tool_use').length;
  log('askClaude answer:', preview(answer), { searches, stop: j.stop_reason });
  return answer;
}

// ---- debug: download the most recent capture ----
router.get('/badge/last.wav', (req, res) => {
  if (DEVICE_TOKEN && req.get('x-badge-token') !== DEVICE_TOKEN && req.query.token !== DEVICE_TOKEN) {
    return res.status(401).json({ error: 'bad token' });
  }
  if (!lastWav) return res.status(404).json({ error: 'no capture yet' });
  res.set('Content-Type', 'audio/wav');
  res.send(lastWav);
});

// ---- handler ----
router.post('/badge/ask', async (req, res) => {
  const reqStart = Date.now();
  log('--- POST /badge/ask ---', {
    contentType: req.get('content-type') || '(none)',
    contentLength: req.get('content-length') || '(none)',
    query: req.query,
    bodyIsBuffer: Buffer.isBuffer(req.body),
    bodyLen: Buffer.isBuffer(req.body) ? req.body.length : undefined,
    bodyType: Buffer.isBuffer(req.body) ? 'buffer' : typeof req.body,
    hasToken: !!req.get('x-badge-token'),
  });
  try {
    if (DEVICE_TOKEN && req.get('x-badge-token') !== DEVICE_TOKEN) {
      log('rejected: bad/missing x-badge-token');
      return res.status(401).json({ error: 'bad token' });
    }

    let transcript = '';
    if (Buffer.isBuffer(req.body) && req.body.length) {
      const rate = parseInt(req.query.rate || '16000', 10);     // raw-PCM sample rate (ignored if already WAV)
      const ch   = parseInt(req.query.ch   || '1', 10);
      const isWav = req.body.length >= 12 && req.body.toString('ascii', 0, 4) === 'RIFF';
      log('audio path', { rawBytes: req.body.length, rate, ch, alreadyWav: isWav });
      if (!isWav) log('pcm stats', pcmStats(req.body));         // dead silence vs real signal
      const wav  = ensureWav(req.body, rate, ch);               // wraps headerless PCM; passes WAV through
      lastWav = wav;                                            // stash for GET /badge/last.wav
      log('wav ready', { wavBytes: wav.length });
      transcript = await transcribe(wav);                       // audio path (mic)
    } else if (req.body && typeof req.body.text === 'string') {
      transcript = req.body.text.trim();                        // text path (curl / future T9)
      log('text path', { text: preview(transcript) });
    } else {
      log('rejected: no audio buffer and no JSON text field');
      return res.status(400).json({ error: 'send audio (Content-Type: audio/wav) or JSON {"text":"..."}' });
    }

    if (!transcript) {
      log('rejected: empty transcript after STT/parse');
      return res.status(422).json({ error: 'empty transcript', transcript: '', pages: [], totalPages: 0 });
    }

    const answer = await askClaude(transcript);
    const pages = paginate(wrap(answer, COLS), ROWS, MAX_PAGES);
    log('OK response', { transcriptLen: transcript.length, answerLen: answer.length, totalPages: pages.length, ms: Date.now() - reqStart });

    res.json({ transcript, answer, pages, totalPages: pages.length, cols: COLS, rows: ROWS });
  } catch (e) {
    errlog('handler caught error after', Date.now() - reqStart, 'ms:', e && e.stack ? e.stack : e);
    res.status(502).json({ error: String(e.message || e) });
  }
});

module.exports = router;