// badge-ask-route.js
// Temp "badge" endpoint: audio (or text) -> STT -> Claude -> OLED-paginated JSON.
//
// Mount on YisraCase:
//   const badgeRoute = require('./badge-ask-route');
//   app.use('/badge', badgeRoute);            // -> POST /badge/ask
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
//   OLED_COLS             chars per line  (default 21  = u8g2 6x10 font on a 128px-wide panel)
//   OLED_ROWS             content lines per page (default 5)
//   OLED_MAX_PAGES        cap to avoid runaway answers (default 6)
//
// Audio body may be a WAV (Content-Type: audio/wav) OR headerless 16-bit PCM
// (Content-Type: application/octet-stream). For raw PCM the device streams chunks and
// passes rate/channels as query params, e.g. POST /badge/ask?rate=16000&ch=1 -- the
// route concatenates the body and prepends the 44-byte WAV header before STT.

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

// ---- STT providers (swap via STT_PROVIDER) ----
async function sttGroq(buf) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', GROQ_STT_MODEL);
  form.append('language', 'en');
  form.append('response_format', 'json');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq STT ${r.status}: ${await r.text()}`);
  return ((await r.json()).text || '').trim();
}

async function sttElevenLabs(buf) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model_id', ELEVEN_MODEL);
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_API_KEY },
    body: form,
  });
  if (!r.ok) throw new Error(`ElevenLabs STT ${r.status}: ${await r.text()}`);
  return ((await r.json()).text || '').trim();
}

function transcribe(buf) {
  return STT_PROVIDER === 'elevenlabs' ? sttElevenLabs(buf) : sttGroq(buf);
}

// ---- Claude ----
async function askClaude(question) {
  const system =
    `You are a pocket reference badge. Answer in plain ASCII text only - no markdown, asterisks, ` +
    `headers, bullet lists, emoji, or non-ASCII symbols (write "deg C" not the degree sign, "ohms" ` +
    `not the omega sign). Be extremely concise: prefer one answer that fits a tiny OLED of about ` +
    `${COLS} chars by ${ROWS} lines. Hard cap about ${COLS * ROWS * MAX_PAGES} characters. ` +
    `Lead with the answer, no preamble.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content: question }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// ---- handler ----
router.post('/badge/ask', async (req, res) => {
  try {
    if (DEVICE_TOKEN && req.get('x-badge-token') !== DEVICE_TOKEN) {
      return res.status(401).json({ error: 'bad token' });
    }

    let transcript = '';
    if (Buffer.isBuffer(req.body) && req.body.length) {
      const rate = parseInt(req.query.rate || '16000', 10);     // raw-PCM sample rate (ignored if already WAV)
      const ch   = parseInt(req.query.ch   || '1', 10);
      const wav  = ensureWav(req.body, rate, ch);               // wraps headerless PCM; passes WAV through
      transcript = await transcribe(wav);                       // audio path (mic)
    } else if (req.body && typeof req.body.text === 'string') {
      transcript = req.body.text.trim();                        // text path (curl / future T9)
    } else {
      return res.status(400).json({ error: 'send audio (Content-Type: audio/wav) or JSON {"text":"..."}' });
    }

    if (!transcript) {
      return res.status(422).json({ error: 'empty transcript', transcript: '', pages: [], totalPages: 0 });
    }

    const answer = await askClaude(transcript);
    const pages = paginate(wrap(answer, COLS), ROWS, MAX_PAGES);

    res.json({ transcript, answer, pages, totalPages: pages.length, cols: COLS, rows: ROWS });
  } catch (e) {
    console.error('[badge/ask]', e);
    res.status(502).json({ error: String(e.message || e) });
  }
});

module.exports = router;