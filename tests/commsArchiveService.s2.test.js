// tests/commsArchiveService.s2.test.js
//
// Comms archive S2 — the two additive primitives the transcription sweep needs
// from services/commsArchiveService.js (design §6.3): readHead (the audio
// header for the duration gate) and signedUrl's ttlMs (the STT vendor's 1-hour
// fetch window). Real module; GCS is the in-memory stand-in
// (tests/helpers/fakeGcs.js). The S1 suite (commsArchiveService.test.js) is
// untouched and still pins the 5-minute default.

'use strict';

const { fakeStorage } = require('./helpers/fakeGcs');
const archive = require('../services/commsArchiveService');

let gcs;
beforeEach(() => {
  process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
  gcs = fakeStorage();
  archive._test.setStorage(gcs.storage);
});
afterAll(() => archive._test.setStorage(null));

describe('readHead', () => {
  const put = (name, buf) => gcs.objects.set(name, { buf, contentType: 'audio/mpeg', generation: '1' });

  test('returns exactly the first n bytes, by a RANGED read (not the whole object)', async () => {
    const buf = Buffer.alloc(100_000, 7);
    buf[0] = 0x49; buf[8191] = 0x42; buf[8192] = 0x43;
    put('phone/rec/2026/10/1-a.mp3', buf);
    const head = await archive.readHead('phone/rec/2026/10/1-a.mp3', 8192);
    expect(head.length).toBe(8192);
    expect(head[0]).toBe(0x49);
    expect(head[8191]).toBe(0x42);
    expect(gcs.calls.ranged).toBe(1);
  });

  test('a shorter object returns what there is', async () => {
    put('phone/vm/2026/10/1-b.wav', Buffer.from('RIFF0000'));
    expect((await archive.readHead('phone/vm/2026/10/1-b.wav', 8192)).toString()).toBe('RIFF0000');
  });

  test('GCS failure / missing object → our-side throw (never charged to a row)', async () => {
    await expect(archive.readHead('phone/rec/2026/10/nope.mp3', 16)).rejects.toMatchObject({ ourSide: true });
    put('phone/rec/2026/10/1-c.mp3', Buffer.from('x'));
    gcs.fail.read = { code: 503 };
    await expect(archive.readHead('phone/rec/2026/10/1-c.mp3', 16)).rejects.toMatchObject({ ourSide: true });
  });

  test('n must be a positive integer', async () => {
    for (const n of [0, -1, NaN, 'x']) await expect(archive.readHead('a', n)).rejects.toThrow(/positive/);
  });
});

describe('signedUrl ttlMs', () => {
  test('default stays 5 minutes; ttlMs extends it; capped at 1 hour', async () => {
    const t0 = Date.now();
    await archive.signedUrl('phone/rec/2026/10/1-a.mp3', { mime: 'audio/mpeg' });
    await archive.signedUrl('phone/rec/2026/10/1-a.mp3', { mime: 'audio/mpeg', ttlMs: 60 * 60e3 });
    await archive.signedUrl('phone/rec/2026/10/1-a.mp3', { mime: 'audio/mpeg', ttlMs: 7 * 24 * 60 * 60e3 });
    await archive.signedUrl('phone/rec/2026/10/1-a.mp3', { mime: 'audio/mpeg', ttlMs: 10 * 60e3 });
    const [d, h, big, ten] = gcs.calls.sign.map(s => s.expires - t0);
    expect(d).toBeLessThanOrEqual(5 * 60e3 + 1000);
    expect(d).toBeGreaterThan(4.9 * 60e3);
    expect(h).toBeGreaterThan(59.9 * 60e3);
    expect(h).toBeLessThanOrEqual(60 * 60e3 + 1000);
    expect(big).toBeLessThanOrEqual(archive.SIGNED_URL_MAX_TTL_MS + 1000);
    expect(ten).toBeGreaterThan(9.9 * 60e3);
    expect(ten).toBeLessThanOrEqual(10 * 60e3 + 1000);
  });

  test('a non-positive / non-numeric ttlMs is refused, never silently defaulted', async () => {
    for (const ttlMs of [0, -5, NaN, 'soon', null]) {
      await expect(archive.signedUrl('a', { mime: 'audio/mpeg', ttlMs })).rejects.toThrow(/ttlMs/);
    }
    expect(gcs.calls.sign.length).toBe(0);
  });
});
