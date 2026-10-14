// services/commsTranscribeAudio.js
//
/**
 * Comms archive S2 — the AUDIO duration estimate behind the transcription
 * gate (design §6.3, P6 "transcribe talk time ≥ 15 s"). Pure: bytes in,
 * numbers out; no DB, no I/O.
 *
 * WHY THE AUDIO AND NOT THE CALL CLOCK. phone_event_log's started_at →
 * ended_at includes ringing (and any hold before the recording starts): on the
 * live archive (2026-10-14) 268 of 879 RingCentral recordings carry under
 * 15 s of audio, against 4 by call clock — a 24 s call held a 4 KB file,
 * ~1 s of sound. The recording itself is the only honest measure of talk.
 *
 * HOW. The sweep reads the first HEAD_BYTES of the archived object
 * (commsArchiveService.readHead — a ranged read of our own bucket) and:
 *   MP3: skips an ID3v2 tag, finds the first MPEG audio frame (confirmed by
 *        the next frame's sync where it falls inside the head), and reads its
 *        bitrate / sample rate / channel mode. A Xing / Info header with a
 *        frame count gives the exact length; otherwise the stream is treated
 *        as CBR (both providers' are — 32 kbps RC, 64 kbps Quo, design §2):
 *        (bytes − tag) × 8 / bitrate.
 *   WAV: the fmt chunk's byte rate and the data chunk's size.
 * The estimate gates submission only; AssemblyAI's audio_duration is
 * authoritative afterwards (it backfills comms_media.duration_s, and a large
 * disagreement raises the duration-drift warning).
 *
 * Exports:
 *   HEAD_BYTES
 *   parseHead(head)                         -> {format, bitrate?, sampleRate, channels, dataOffset, exactS?, byteRate?, dataBytes?} | null
 *   estimate({head, bytes})                 -> {estS, channels, method} | null
 *   nominal({provider, mime, bytes})        -> {estS, channels:null, method:'nominal'} | null
 */

'use strict';

const HEAD_BYTES = 8192;

// MPEG audio, Layer III only (call audio is never Layer I/II).
const L3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   // MPEG-1
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       // MPEG-2 / 2.5
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** Bytes per second the providers are known to record at (design §2) — the fallback when a header can't be read. */
const NOMINAL_BPS = Object.freeze({
  'ringcentral|audio/mpeg': 4000,   // 32 kbps mono
  'quo|audio/mpeg': 8000,           // 64 kbps joint stereo
});

function _frameAt(b, i) {
  if (i + 4 > b.length) return null;
  if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null;
  const vBits = (b[i + 1] >> 3) & 3;              // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 reserved
  const layer = (b[i + 1] >> 1) & 3;              // 1 = Layer III
  if (vBits === 1 || layer !== 1) return null;
  const version = vBits === 3 ? 1 : vBits === 2 ? 2 : 25;
  const brIdx = b[i + 2] >> 4;
  const srIdx = (b[i + 2] >> 2) & 3;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;   // free-format / bad / reserved
  const kbps = L3_BITRATES[version === 1 ? 1 : 2][brIdx];
  const sampleRate = SAMPLE_RATES[version][srIdx];
  const padding = (b[i + 2] >> 1) & 1;
  const mode = b[i + 3] >> 6;                      // 3 = mono
  const coef = version === 1 ? 144 : 72;
  const frameLen = Math.floor((coef * kbps * 1000) / sampleRate) + padding;
  return { version, bitrate: kbps * 1000, sampleRate, channels: mode === 3 ? 1 : 2, frameLen, mono: mode === 3 };
}

function _id3Size(b) {
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {     // "ID3"
    const size = ((b[6] & 0x7F) << 21) | ((b[7] & 0x7F) << 14) | ((b[8] & 0x7F) << 7) | (b[9] & 0x7F);
    const footer = (b[5] & 0x10) ? 10 : 0;
    return 10 + size + footer;
  }
  return 0;
}

/** Xing / Info frame count, if the first frame carries one. */
function _xingFrames(b, i, f) {
  const side = f.version === 1 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17);
  const at = i + 4 + side;
  if (at + 12 > b.length) return null;
  const tag = b.toString('latin1', at, at + 4);
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const flags = b.readUInt32BE(at + 4);
  if (!(flags & 1)) return null;
  const frames = b.readUInt32BE(at + 8);
  return frames > 0 ? frames : null;
}

function _parseMp3(b) {
  const start = _id3Size(b);
  if (start >= b.length) return null;                 // tag larger than the head: no frame to read
  // Scan for the first frame whose successor (when inside the head) also syncs.
  const limit = Math.min(b.length - 4, start + 4096);
  for (let i = start; i <= limit; i++) {
    const f = _frameAt(b, i);
    if (!f) continue;
    const next = i + f.frameLen;
    if (next + 4 <= b.length) {
      const g = _frameAt(b, next);
      if (!g || g.version !== f.version || g.sampleRate !== f.sampleRate) continue;
    }
    const frames = _xingFrames(b, i, f);
    const spf = f.version === 1 ? 1152 : 576;
    return {
      format: 'mp3', bitrate: f.bitrate, sampleRate: f.sampleRate, channels: f.channels,
      dataOffset: start,
      exactS: frames ? (frames * spf) / f.sampleRate : null,
    };
  }
  return null;
}

function _parseWav(b) {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null;
  let i = 12, fmt = null, data = null;
  while (i + 8 <= b.length) {
    const id = b.toString('latin1', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 8 + 16 <= b.length) {
      fmt = { channels: b.readUInt16LE(i + 10), sampleRate: b.readUInt32LE(i + 12), byteRate: b.readUInt32LE(i + 16) };
    } else if (id === 'data') {
      data = { offset: i + 8, size };
      break;
    }
    i += 8 + size + (size & 1);
  }
  if (!fmt || !(fmt.byteRate > 0) || !(fmt.channels > 0)) return null;
  return {
    format: 'wav', sampleRate: fmt.sampleRate, channels: fmt.channels, byteRate: fmt.byteRate,
    dataOffset: data ? data.offset : null, dataBytes: data ? data.size : null,
  };
}

/** Parse the head of an audio object. null = not a header this module can read. */
function parseHead(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return null;
  return _parseWav(head) || _parseMp3(head);
}

/**
 * Duration estimate from the head + the stored byte count.
 * → {estS, channels, method} or null (unreadable — the caller falls back).
 */
function estimate({ head, bytes }) {
  const h = parseHead(head);
  const n = Number(bytes);
  if (!h || !Number.isFinite(n) || n <= 0) return null;
  if (h.format === 'wav') {
    // A streamed WAV may carry a 0 / 0xFFFFFFFF data size: the object size bounds it.
    const body = h.dataBytes && h.dataOffset != null
      ? Math.min(h.dataBytes, n - h.dataOffset)
      : n - (h.dataOffset != null ? h.dataOffset : 44);
    return { estS: Math.max(0, body) / h.byteRate, channels: h.channels, method: 'wav-header' };
  }
  if (h.exactS != null) return { estS: h.exactS, channels: h.channels, method: 'mp3-xing' };
  return { estS: Math.max(0, n - h.dataOffset) * 8 / h.bitrate, channels: h.channels, method: 'mp3-header' };
}

/** The design-§2 byte rate for this provider + type, when the header can't be read. */
function nominal({ provider, mime, bytes }) {
  const bps = NOMINAL_BPS[`${provider}|${String(mime || '').split(';')[0].trim().toLowerCase()}`];
  const n = Number(bytes);
  if (!bps || !Number.isFinite(n) || n <= 0) return null;
  return { estS: n / bps, channels: null, method: 'nominal' };
}

module.exports = { HEAD_BYTES, parseHead, estimate, nominal, NOMINAL_BPS };
