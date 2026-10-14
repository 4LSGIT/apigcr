// tests/commsTranscribeAudio.test.js
//
// Comms archive S2 — the audio-length estimate behind the transcription gate
// (services/commsTranscribeAudio.js). Fixtures are REAL encoder output
// (ffmpeg / libmp3lame, 2026-10-14): only each file's first 8 KB is committed
// (what the sweep reads), with the full byte count, ffprobe's duration and
// channel count in meta.json.

'use strict';

const fs = require('fs');
const path = require('path');
const audio = require('../services/commsTranscribeAudio');

const D = path.join(__dirname, 'fixtures', 'comms_s2_audio');
const META = JSON.parse(fs.readFileSync(path.join(D, 'meta.json'), 'utf8'));
const head = (f) => fs.readFileSync(path.join(D, `${f}.head`));

describe('estimate on real encoder output', () => {
  test.each(Object.keys(META))('%s: within 0.15 s of ffprobe, right channel count', (f) => {
    const m = META[f];
    const e = audio.estimate({ head: head(f), bytes: m.bytes });
    expect(e).not.toBeNull();
    expect(Math.abs(e.estS - m.duration)).toBeLessThan(0.15);
    expect(e.channels).toBe(m.channels);
  });

  test('the method says where the number came from', () => {
    expect(audio.estimate({ head: head('rc_cbr_mono_32k.mp3'), bytes: 80352 }).method).toBe('mp3-header');
    expect(audio.estimate({ head: head('vbr_xing.mp3'), bytes: 75248 }).method).toBe('mp3-xing');
    expect(audio.estimate({ head: head('quo_cbr_info.mp3'), bytes: 296794 }).method).toBe('mp3-xing');
    expect(audio.estimate({ head: head('vm.wav'), bytes: 192078 }).method).toBe('wav-header');
  });

  test('a VBR file is measured by its frame count, not its first frame\'s bitrate', () => {
    // The first VBR frame's bitrate times the byte count would be wrong; the Xing count is exact.
    const h = audio.parseHead(head('vbr_xing.mp3'));
    const naive = (75248 - h.dataOffset) * 8 / h.bitrate;
    expect(Math.abs(naive - 25)).toBeGreaterThan(1);
    expect(Math.abs(audio.estimate({ head: head('vbr_xing.mp3'), bytes: 75248 }).estS - 25)).toBeLessThan(0.15);
  });

  test('an ID3 tag is skipped (and not counted as audio)', () => {
    const a = audio.estimate({ head: head('rc_cbr_id3.mp3'), bytes: 80418 });
    const b = audio.estimate({ head: head('rc_cbr_mono_32k.mp3'), bytes: 80352 });
    expect(Math.abs(a.estS - b.estS)).toBeLessThan(0.01);
    expect(audio.parseHead(head('rc_cbr_id3.mp3')).dataOffset).toBe(66);
  });

  test('the 1-second recording that a 24 s call clock would call long enough reads as ~1 s', () => {
    expect(audio.estimate({ head: head('tiny_1s.mp3'), bytes: 4364 }).estS).toBeLessThan(1.2);
  });
});

describe('unreadable → null, never a guess', () => {
  test('junk, empty, HTML, a tag bigger than the head', () => {
    expect(audio.parseHead(Buffer.alloc(0))).toBeNull();
    expect(audio.parseHead(Buffer.from('<html><body>error</body></html>'))).toBeNull();
    expect(audio.parseHead(Buffer.alloc(8192, 0x55))).toBeNull();
    const bigTag = Buffer.alloc(8192);
    bigTag.write('ID3', 0, 'latin1'); bigTag[3] = 3;
    bigTag[6] = 0; bigTag[7] = 1; bigTag[8] = 0x7F; bigTag[9] = 0x7F;   // ~32 KB tag
    expect(audio.parseHead(bigTag)).toBeNull();
    expect(audio.estimate({ head: bigTag, bytes: 100000 })).toBeNull();
  });

  test('a lone sync word is not a frame: the next frame must sync too', () => {
    const fake = Buffer.alloc(4096, 0);
    fake[100] = 0xFF; fake[101] = 0xFB; fake[102] = 0x50; fake[103] = 0xC4;   // MPEG-1 L3 64 kbps 44.1 kHz header, no successor
    expect(audio.parseHead(fake)).toBeNull();
  });

  test('bytes must be a positive number', () => {
    expect(audio.estimate({ head: head('vm.wav'), bytes: 0 })).toBeNull();
    expect(audio.estimate({ head: head('vm.wav'), bytes: null })).toBeNull();
  });

  test('a streamed WAV (data size 0xFFFFFFFF) is measured by the object size', () => {
    const h = Buffer.from(head('vm.wav'));
    const dataAt = h.indexOf('data', 12, 'latin1');
    h.writeUInt32LE(0xFFFFFFFF, dataAt + 4);
    expect(Math.abs(audio.estimate({ head: h, bytes: 192078 }).estS - 12)).toBeLessThan(0.01);
  });
});

describe('nominal fallback (design §2 byte rates)', () => {
  test('RC 32 kbps, Quo 64 kbps; anything else null', () => {
    expect(audio.nominal({ provider: 'ringcentral', mime: 'audio/mpeg', bytes: 40000 }).estS).toBe(10);
    expect(audio.nominal({ provider: 'quo', mime: 'audio/mpeg; x=y', bytes: 80000 }).estS).toBe(10);
    expect(audio.nominal({ provider: 'quo', mime: 'audio/wav', bytes: 80000 })).toBeNull();
    expect(audio.nominal({ provider: 'ringcentral', mime: 'audio/mpeg', bytes: 0 })).toBeNull();
    expect(audio.nominal({ provider: 'ringcentral', mime: 'audio/mpeg', bytes: 1 }).method).toBe('nominal');
  });
});
