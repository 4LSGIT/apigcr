// tests/commsArchiveService.test.js
//
// Comms archive S1a — the bucket layer (services/commsArchiveService.js) and
// the RingCentral archive fetchers (services/adapters/phone/ringcentral.js).
// Real modules; the only stand-ins sit at the boundaries: GCS
// (tests/helpers/fakeGcs.js), global fetch, and the credential header source.
// The sweep's DB behaviour is proven on real MySQL in
// tests/commsArchive.sweep.mysql.test.js.

'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');
const { fakeStorage } = require('./helpers/fakeGcs');

jest.mock('../lib/credentialInjection', () => ({
  buildHeadersForCredential: jest.fn(),
}));
const { buildHeadersForCredential } = require('../lib/credentialInjection');

const archive = require('../services/commsArchiveService');
const rc = require('../services/adapters/phone/ringcentral');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let gcs;
beforeEach(() => {
  process.env.COMMS_ARCHIVE_BUCKET = 'lsg-yc-comms-archive-test';
  gcs = fakeStorage();
  archive._test.setStorage(gcs.storage);
});
afterAll(() => archive._test.setStorage(null));

describe('names and types', () => {
  test('recordingPrefix: ids only, yyyy/mm of the call in UTC, ends at the dot', () => {
    expect(archive.recordingPrefix({ capturedAt: new Date('2026-07-31T23:59:59Z'), sourceId: 10676, part: '3092403980019' }))
      .toBe('phone/rec/2026/07/10676-3092403980019.');
    // the month is UTC's, not the firm zone's (01:00Z Aug 1 is still Jul 31 in Detroit)
    expect(archive.recordingPrefix({ capturedAt: '2026-08-01T01:00:00Z', sourceId: 1, part: 'x' }))
      .toBe('phone/rec/2026/08/1-x.');
    expect(() => archive.recordingPrefix({ capturedAt: new Date(), sourceId: 1, part: '' })).toThrow(/part/);
  });

  test('audio allowlist: canonical mime + extension; anything else is null', () => {
    expect(archive.canonicalAudioMime('audio/mpeg')).toBe('audio/mpeg');
    expect(archive.canonicalAudioMime('Audio/MP3; charset=x')).toBe('audio/mpeg');
    expect(archive.extForMime('audio/x-wav')).toBe('wav');
    expect(archive.canonicalAudioMime('audio/x-wav')).toBe('audio/wav');
    for (const t of ['application/json', 'text/html', 'image/svg+xml', '', null, 'audio/ogg']) {
      expect(archive.canonicalAudioMime(t)).toBeNull();
      expect(archive.extForMime(t)).toBeNull();
    }
  });

  test('bucket unset → our-side ARCHIVE_CONFIG throw (fail-closed), never the public bucket', () => {
    delete process.env.COMMS_ARCHIVE_BUCKET;
    process.env.GCS_BUCKET = 'uploads.public.example';
    let e;
    try { archive.bucketName(); } catch (x) { e = x; }
    expect(e && e.ourSide).toBe(true);
    expect(e.code).toBe('ARCHIVE_CONFIG');
    delete process.env.GCS_BUCKET;
  });
});

describe('putStream', () => {
  test('stores, hashes in flight, never overwrites (412 → EXISTS)', async () => {
    const buf = Buffer.from('ID3 fake mp3 bytes');
    const r = await archive.putStream(Readable.from([buf]), { objectName: 'phone/rec/2026/10/1-a.mp3', mime: 'audio/mpeg', expectedBytes: buf.length });
    expect(r).toMatchObject({ bytes: buf.length, sha256: sha(buf) });
    expect(gcs.objects.get('phone/rec/2026/10/1-a.mp3').buf.equals(buf)).toBe(true);

    let e;
    try { await archive.putStream(Readable.from([Buffer.from('other')]), { objectName: 'phone/rec/2026/10/1-a.mp3', mime: 'audio/mpeg' }); }
    catch (x) { e = x; }
    expect(e && e.code).toBe('EXISTS');
    expect(gcs.objects.get('phone/rec/2026/10/1-a.mp3').buf.equals(buf)).toBe(true);
  });

  test('Content-Length mismatch → LENGTH_MISMATCH and NOTHING stored', async () => {
    let e;
    try { await archive.putStream(Readable.from([Buffer.from('short')]), { objectName: 'o.mp3', mime: 'audio/mpeg', expectedBytes: 99 }); }
    catch (x) { e = x; }
    expect(e && e.code).toBe('LENGTH_MISMATCH');
    expect(gcs.objects.has('o.mp3')).toBe(false);
  });

  test('a failing source stream → SOURCE (provider side), nothing stored', async () => {
    const src = new Readable({ read() {} });
    src.push(Buffer.from('part'));
    setTimeout(() => src.destroy(new Error('socket hang up')), 5);
    let e;
    try { await archive.putStream(src, { objectName: 's.mp3', mime: 'audio/mpeg' }); } catch (x) { e = x; }
    expect(e && e.code).toBe('SOURCE');
    expect(e.ourSide).toBeUndefined();
    expect(gcs.objects.has('s.mp3')).toBe(false);
  });

  test('M1: GCS failing WHILE the source still flows is OURS, not the provider\'s', async () => {
    // pipeline() destroys the source with GCS's own error object; blaming
    // "the source errored" would charge a provider for a bucket 403 / reset.
    for (const code of [403, 'ECONNRESET']) {
      gcs.fail.putMid = { code };
      let n = 0;
      const src = new Readable({ read() { setTimeout(() => this.push(n++ < 20 ? Buffer.from('chunk') : null), 2); } });
      let e;
      try { await archive.putStream(src, { objectName: `mid-${code}.mp3`, mime: 'audio/mpeg' }); } catch (x) { e = x; }
      expect(e && e.code).toBe('ARCHIVE_STORAGE');
      expect(e.ourSide).toBe(true);
      expect(gcs.objects.has(`mid-${code}.mp3`)).toBe(false);
    }
  });

  test('0-byte body → EMPTY (provider side), nothing stored', async () => {
    let e;
    try { await archive.putStream(Readable.from([]), { objectName: 'z.mp3', mime: 'audio/mpeg', expectedBytes: 0 }); } catch (x) { e = x; }
    expect(e && e.code).toBe('EMPTY');
    expect(e.ourSide).toBeUndefined();
    expect(gcs.objects.has('z.mp3')).toBe(false);
  });

  test('a stalled GCS upload is bounded: rejects ourSide in ~timeoutMs, source destroyed', async () => {
    gcs.fail.stall = true;
    const src = new Readable({ read() { this.push(Buffer.from('x')); } });
    const t0 = Date.now();
    let e;
    try { await archive.putStream(src, { objectName: 'stall.mp3', mime: 'audio/mpeg', timeoutMs: 150 }); } catch (x) { e = x; }
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(e && e.ourSide).toBe(true);
    expect(e.message).toMatch(/timed out/);
    expect(src.destroyed).toBe(true);
    expect(gcs.objects.has('stall.mp3')).toBe(false);
  });

  test('GCS refusing the write (403) → our-side error', async () => {
    gcs.fail.put = { code: 403 };
    let e;
    try { await archive.putStream(Readable.from([Buffer.from('x')]), { objectName: 'p.mp3', mime: 'audio/mpeg' }); } catch (x) { e = x; }
    expect(e && e.ourSide).toBe(true);
  });
});

describe('stat / re-hash / sign', () => {
  test('findByPrefix + rehash adopt an existing object', async () => {
    const buf = Buffer.from('already uploaded');
    await archive.putStream(Readable.from([buf]), { objectName: 'phone/rec/2026/09/5-r.mp3', mime: 'audio/mpeg' });
    const found = await archive.findByPrefix('phone/rec/2026/09/5-r.');
    expect(found.map(f => f.name)).toEqual(['phone/rec/2026/09/5-r.mp3']);
    // the prefix ends at the dot: id 5 must not match id 55
    await archive.putStream(Readable.from([buf]), { objectName: 'phone/rec/2026/09/55-r.mp3', mime: 'audio/mpeg' });
    expect((await archive.findByPrefix('phone/rec/2026/09/5-r.')).length).toBe(1);
    expect(await archive.rehash('phone/rec/2026/09/5-r.mp3')).toMatchObject({ bytes: buf.length, sha256: sha(buf), contentType: 'audio/mpeg' });
  });

  test('checkBucket proves create/get/list without writing; any missing → our-side', async () => {
    await expect(archive.checkBucket()).resolves.toBeUndefined();
    for (const perm of archive.REQUIRED_PERMISSIONS) {
      gcs.denied.clear();
      gcs.denied.add(perm);
      await expect(archive.checkBucket()).rejects.toMatchObject({ ourSide: true, message: expect.stringContaining(perm) });
    }
    gcs.denied.clear();
    gcs.fail.perms = { code: 404 };
    await expect(archive.checkBucket()).rejects.toMatchObject({ ourSide: true });
    expect(gcs.calls.put).toBe(0);
    expect(gcs.objects.size).toBe(0);
  });

  test('signedUrl: V4, 5 minutes, inline only for the allowlist; SVG/HTML download', async () => {
    const t0 = Date.now();
    await archive.signedUrl('phone/rec/2026/10/1-a.mp3', { mime: 'audio/mpeg' });
    await archive.signedUrl('phone/mms/2026/10/1-b.svg', { mime: 'image/svg+xml', filename: 'x".svg' });
    await archive.signedUrl('phone/mms/2026/10/1-c.html', { mime: 'text/html' });
    const [a, b, c] = gcs.calls.sign;
    expect(a).toMatchObject({ version: 'v4', action: 'read', responseType: 'audio/mpeg', responseDisposition: 'inline' });
    expect(a.expires - t0).toBeGreaterThan(4.9 * 60e3);
    expect(a.expires - t0).toBeLessThanOrEqual(5 * 60e3 + 1000);
    for (const s of [b, c]) {
      expect(s.responseType).toBe('application/octet-stream');
      expect(s.responseDisposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    }
  });
});

describe('RingCentral archive fetchers', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const resp = (status, body, headers = {}) => new Response(body, { status, headers });

  test('content: media host, tilde unescaped, rate headers surfaced, body streamable', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    const seen = [];
    global.fetch = jest.fn(async (url, init) => {
      seen.push({ url, init });
      return resp(200, Buffer.from('mp3!'), {
        'content-type': 'audio/mpeg', 'content-length': '4',
        'x-rate-limit-group': 'heavy', 'x-rate-limit-remaining': '7',
      });
    });
    const r = await rc.fetchRecordingContent({}, { credentialId: 9, recordingId: '3092403980019' });
    expect(seen[0].url).toBe('https://media.ringcentral.com/restapi/v1.0/account/~/recording/3092403980019/content');
    expect(seen[0].init.headers.Authorization).toBe('Bearer t');
    // undici would decompress gzip/br while Content-Length counts compressed bytes
    expect(seen[0].init.headers['Accept-Encoding']).toBe('identity');
    expect(buildHeadersForCredential).toHaveBeenCalledWith({}, 9, seen[0].url);
    expect(r).toMatchObject({ status: 200, contentType: 'audio/mpeg', contentLength: 4, rate: { group: 'heavy', remaining: 7 } });
    const chunks = [];
    for await (const c of r.body) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('mp3!');
  });

  test('no Authorization → NO_AUTH thrown BEFORE any request', async () => {
    buildHeadersForCredential.mockResolvedValue({});
    global.fetch = jest.fn();
    await expect(rc.fetchRecordingContent({}, { credentialId: 9, recordingId: '1' })).rejects.toMatchObject({ code: 'NO_AUTH' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await rc.checkArchiveAuth({}, 9)).toBe(false);
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    expect(await rc.checkArchiveAuth({}, 9)).toBe(true);
  });

  test('statuses are returned, not thrown (404 / 429 + Retry-After)', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(resp(404, '{"errorCode":"CMN-102"}'))
      .mockResolvedValueOnce(resp(429, 'slow down', { 'retry-after': '60' }));
    const a = await rc.fetchRecordingContent({}, { credentialId: 9, recordingId: '1' });
    expect(a).toMatchObject({ status: 404, body: null });
    expect(a.errorText).toMatch(/CMN-102/);
    const b = await rc.fetchRecordingContent({}, { credentialId: 9, recordingId: '1' });
    expect(b).toMatchObject({ status: 429, rate: { retryAfterS: 60 } });
  });

  test('call-log recovery: explicit date window, recordings de-duplicated across records and legs', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    let url;
    global.fetch = jest.fn(async (u) => {
      url = u;
      return resp(200, JSON.stringify({ records: [
        { telephonySessionId: 's-abc', recording: { id: 111, contentType: 'audio/mpeg' },
          legs: [{ recording: { id: 111 } }, { recording: { id: 222 } }] },
        { telephonySessionId: 's-abc', legs: [{}] },
      ] }), { 'content-type': 'application/json' });
    });
    const around = new Date('2026-10-13T14:31:15Z');
    const r = await rc.findSessionRecordings({}, { credentialId: 9, telephonySessionId: 's-abc', around });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://platform.ringcentral.com/restapi/v1.0/account/~/call-log');
    expect(u.searchParams.get('telephonySessionId')).toBe('s-abc');
    expect(u.searchParams.get('view')).toBe('Detailed');
    // RC defaults dateFrom to dateTo − 24 h; the window must straddle the call
    expect(new Date(u.searchParams.get('dateFrom')) < around).toBe(true);
    expect(new Date(u.searchParams.get('dateTo')) > around).toBe(true);
    expect(r).toMatchObject({ status: 200, records: 2 });
    expect(r.recordings.map(x => x.id)).toEqual(['111', '222']);
  });

  test('call-log recovery keeps ONLY records of the requested session (mixed response)', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    global.fetch = jest.fn(async () => resp(200, JSON.stringify({ records: [
      { telephonySessionId: 's-other', recording: { id: 900 } },
      { telephonySessionId: 's-abc', recording: { id: 111 } },
      { recording: { id: 901 } },                                   // no session id
      { telephonySessionId: 's-other2', legs: [{ recording: { id: 902 } }] },
    ] }), { 'content-type': 'application/json' }));
    const r = await rc.findSessionRecordings({}, { credentialId: 9, telephonySessionId: 's-abc', around: new Date() });
    expect(r.recordings.map(x => x.id)).toEqual(['111']);
    expect(r.records).toBe(1);
    expect(r.rawRecords).toBe(4);   // the sweep alerts when raw > 0 and matched = 0
  });
});
