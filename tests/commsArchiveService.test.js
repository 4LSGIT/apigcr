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

// ═════════════════════════════════════════════════════════════════════════════
// S1b — MMS types, exists / delete, the RC attachment and Quo fetchers
// ═════════════════════════════════════════════════════════════════════════════

describe('S1b storage additions', () => {
  test('mmsPrefix mirrors recordingPrefix under phone/mms/', () => {
    expect(archive.mmsPrefix({ capturedAt: '2026-10-13T15:04:57Z', sourceId: 10630, part: '855604942019' }))
      .toBe('phone/mms/2026/10/10630-855604942019.');
  });

  test('classifyMedia: known types stored as themselves; generic defers to the claimed type', () => {
    expect(archive.classifyMedia('image/jpeg', null)).toEqual({ mime: 'image/jpeg', ext: 'jpg', note: null });
    expect(archive.classifyMedia('IMAGE/PNG; q=1', null)).toMatchObject({ mime: 'image/png', ext: 'png' });
    expect(archive.classifyMedia('application/octet-stream', 'application/pdf')).toMatchObject({ mime: 'application/pdf', ext: 'pdf' });
    expect(archive.classifyMedia('', 'video/3gpp')).toMatchObject({ mime: 'video/3gpp', ext: '3gp' });
    expect(archive.classifyMedia('text/x-vcard', null)).toMatchObject({ mime: 'text/vcard', ext: 'vcf' });
  });

  test('classifyMedia: error-shaped 200s are refused; unknown types are evidence (.bin + note)', () => {
    for (const t of ['text/html', 'application/json; charset=utf-8', 'text/xml', 'application/problem+json']) {
      expect(archive.classifyMedia(t, 'image/png').error).toMatch(/error-shaped/);
    }
    const u = archive.classifyMedia('model/gltf+json2', 'x-weird/thing');
    expect(u).toMatchObject({ mime: 'application/octet-stream', ext: 'bin' });
    expect(u.note).toMatch(/provider type: model\/gltf\+json2/);
    expect(u.note).toMatch(/claimed type: x-weird\/thing/);
    // never served inline
    expect(archive.INLINE_TYPES.has('application/octet-stream')).toBe(false);
  });

  test('exists / deleteObject: live object true, deleted false; delete is idempotent; failures ours', async () => {
    await archive.putStream(Readable.from([Buffer.from('x')]), { objectName: 'phone/mms/2026/10/1-1.jpg', mime: 'image/jpeg' });
    expect(await archive.exists('phone/mms/2026/10/1-1.jpg')).toBe(true);
    await archive.deleteObject('phone/mms/2026/10/1-1.jpg');
    expect(await archive.exists('phone/mms/2026/10/1-1.jpg')).toBe(false);
    await expect(archive.deleteObject('phone/mms/2026/10/1-1.jpg')).resolves.toBeUndefined();
    gcs.fail.exists = { code: 403 };
    await expect(archive.exists('a')).rejects.toMatchObject({ ourSide: true });
    gcs.fail.delete = { code: 500 };
    await expect(archive.deleteObject('a')).rejects.toMatchObject({ ourSide: true });
  });
});

describe('S1b adapters', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const resp = (status, body, headers = {}) => new Response(body, { status, headers });
  const quo = require('../services/adapters/phone/quo');

  test('RC attachment: media host, extension ~ (rc2 shares it), identity encoding', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    let seen;
    global.fetch = jest.fn(async (url, init) => { seen = { url, init }; return resp(200, Buffer.from('jpg'), { 'content-type': 'image/jpeg' }); });
    const r = await rc.fetchMessageAttachment({}, { credentialId: 9, messageId: '3091661067019', attachmentId: '855604942019' });
    expect(seen.url).toBe('https://media.ringcentral.com/restapi/v1.0/account/~/extension/~/message-store/3091661067019/content/855604942019');
    expect(seen.init.headers['Accept-Encoding']).toBe('identity');
    expect(r).toMatchObject({ status: 200, contentType: 'image/jpeg' });
  });

  test('Quo API calls: api.openphone.com paths, credential header, statuses returned', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'quo-key' });
    const urls = [];
    global.fetch = jest.fn(async (url, init) => {
      urls.push([url, init.headers.Authorization]);
      return url.includes('call-recordings')
        ? resp(200, JSON.stringify({ data: [] }))
        : resp(429, 'slow', { 'retry-after': '1' });
    });
    const a = await quo.listCallRecordings({}, { credentialId: 10, callId: 'AC123' });
    expect(a).toMatchObject({ status: 200, json: { data: [] } });
    const b = await quo.getMessage({}, { credentialId: 10, messageId: 'AC9' });
    expect(b).toMatchObject({ status: 429, retryAfterS: 1, json: null });
    expect(urls).toEqual([
      ['https://api.openphone.com/v1/call-recordings/AC123', 'quo-key'],
      ['https://api.openphone.com/v1/messages/AC9', 'quo-key'],
    ]);
  });

  test('Quo: an unparseable 200 is json === undefined (drift), not null', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'quo-key' });
    global.fetch = jest.fn(async () => resp(200, '<html>oops</html>'));
    expect((await quo.listCallRecordings({}, { credentialId: 10, callId: 'AC1' })).json).toBeUndefined();
  });

  test('Quo signed download: https only, NO credential header, host reported (never the signature)', async () => {
    let seen;
    global.fetch = jest.fn(async (url, init) => { seen = { url, init }; return resp(403, 'sig'); });
    const r = await quo.fetchSigned('https://share.quo.com/v1/resource/message-media/abc.jpg?sig=SECRET');
    expect(seen.init.headers).toEqual({ 'Accept-Encoding': 'identity' });
    expect(r).toMatchObject({ status: 403, host: 'share.quo.com', body: null });
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    await expect(quo.fetchSigned('http://share.quo.com/x')).rejects.toMatchObject({ code: 'BAD_URL' });
    await expect(quo.fetchSigned('javascript:alert(1)')).rejects.toMatchObject({ code: 'BAD_URL' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('Quo: no Authorization → NO_AUTH before any request', async () => {
    buildHeadersForCredential.mockResolvedValue({});
    global.fetch = jest.fn();
    await expect(quo.getMessage({}, { credentialId: 10, messageId: 'AC1' })).rejects.toMatchObject({ code: 'NO_AUTH' });
    expect(await quo.checkArchiveAuth({}, 10)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('S1b R9 list parsing', () => {
  const { parseAdmins } = require('../services/commsArchiveAdmin');
  test('digits only; everything else ignored', () => {
    expect([...parseAdmins('1').ids]).toEqual([1]);
    expect([...parseAdmins(' 1 , 6,,12 ').ids]).toEqual([1, 6, 12]);
    const g = parseAdmins('1x, -2, 3.0, ss, 4');
    expect([...g.ids]).toEqual([4]);
    expect(g.junk).toEqual(['1x', '-2', '3.0', 'ss']);
    expect(parseAdmins(null).ids.size).toBe(0);
    expect(parseAdmins('').ids.size).toBe(0);
  });
});

describe('S1b review S5 — signed-download redirects', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const quo = require('../services/adapters/phone/quo');
  const resp = (status, body, headers = {}) => new Response(body, { status, headers });

  test('a redirect into http is refused; https hops are followed by hand (≤ 3)', async () => {
    const seen = [];
    global.fetch = jest.fn(async (url, init) => {
      seen.push([url, init.redirect]);
      if (url.includes('/a')) return resp(302, null, { location: 'https://cdn.quo.example/b' });
      if (url.includes('/b')) return resp(200, Buffer.from('ok'), { 'content-type': 'image/jpeg', 'content-length': '2' });
      if (url.includes('/h')) return resp(301, null, { location: 'http://cdn.quo.example/plain' });
      return resp(302, null, { location: url + 'x' });                 // endless chain
    });
    const ok = await quo.fetchSigned('https://share.quo.com/a?sig=1');
    expect(ok).toMatchObject({ status: 200, host: 'cdn.quo.example' });
    expect(seen.every(([, r]) => r === 'manual')).toBe(true);
    await expect(quo.fetchSigned('https://share.quo.com/h?sig=1')).rejects.toMatchObject({ code: 'BAD_URL' });
    expect(seen.some(([u]) => u.startsWith('http:'))).toBe(false);
    await expect(quo.fetchSigned('https://share.quo.com/loop')).rejects.toThrow(/too many redirects/);
  });
});

describe('S1c adapters — voicemails', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const quo = require('../services/adapters/phone/quo');
  const resp = (status, body, headers = {}) => new Response(body, { status, headers });

  test('RC listVoicemails: platform message-store, messageType=VoiceMail, dateFrom/page, unparseable 200 = undefined', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'Bearer t' });
    let url;
    global.fetch = jest.fn(async (u) => { url = u; return resp(200, JSON.stringify({ records: [], paging: { page: 2, totalPages: 2 } }), { 'x-rate-limit-group': 'light' }); });
    const r = await rc.listVoicemails({}, { credentialId: 9, dateFrom: new Date('2016-01-01T00:00:00Z'), page: 2 });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/message-store');
    expect(Object.fromEntries(u.searchParams)).toEqual({ messageType: 'VoiceMail', dateFrom: '2016-01-01T00:00:00.000Z', perPage: '100', page: '2' });
    expect(r).toMatchObject({ status: 200, json: { records: [] }, rate: { group: 'light' } });
    global.fetch = jest.fn(async () => resp(200, 'not json'));
    expect((await rc.listVoicemails({}, { credentialId: 9, dateFrom: new Date() })).json).toBeUndefined();
  });

  test('Quo getCallVoicemail: /v1/call-voicemails/<callId> with the credential header', async () => {
    buildHeadersForCredential.mockResolvedValue({ Authorization: 'quo-key' });
    let seen;
    global.fetch = jest.fn(async (u, init) => { seen = [u, init.headers.Authorization]; return resp(404, '{"code":"1200404"}'); });
    const r = await quo.getCallVoicemail({}, { credentialId: 10, callId: 'AC77' });
    expect(seen).toEqual(['https://api.openphone.com/v1/call-voicemails/AC77', 'quo-key']);
    expect(r).toMatchObject({ status: 404, json: null });
  });

  test('vmPrefix / sttPrefix / prefixFor by kind', () => {
    expect(archive.vmPrefix({ capturedAt: '2024-09-15T19:33:18Z', sourceId: '2441801165019', part: '2441801165019' }))
      .toBe('phone/vm/2024/09/2441801165019-2441801165019.');
    expect(archive.sttPrefix({ capturedAt: '2026-10-14T00:00:00Z', parentId: 42 })).toBe('phone/stt/2026/10/42.');
    expect(archive.prefixFor({ kind: 'voicemail', captured_at: '2026-01-02T00:00:00Z', source_id: 5, part: 'VMx' })).toBe('phone/vm/2026/01/5-VMx.');
    expect(archive.prefixFor({ kind: 'stt_raw', captured_at: '2026-01-02T00:00:00Z', source_id: 5, part: 'quo' })).toBe('phone/stt/2026/01/5.');
  });
});
