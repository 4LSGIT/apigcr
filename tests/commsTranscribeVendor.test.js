// tests/commsTranscribeVendor.test.js
//
// Comms archive S2 — the AssemblyAI boundary (services/commsTranscribeVendor.js).
// Real module AND the real lib/credentialInjection (the credential row comes
// from a one-query db stand-in); the only other stand-in is global fetch.
// The sweep's DB behaviour is proven on real MySQL in
// tests/commsTranscribe.mysql.test.js.

'use strict';

const v = require('../services/commsTranscribeVendor');

const CRED = { id: 14, name: 'Assembly AI', type: 'api_key', config: JSON.stringify({ header: 'Authorization', key: 'aai_raw_key' }),
  allowed_urls: JSON.stringify(['https://api.assemblyai.com/*']), access_token: null, oauth_status: null, verbose: 0 };
const dbWith = (cred) => ({ async query() { return [[cred].filter(Boolean)]; } });

describe('HTTP through the real credential injection', () => {
  const realFetch = global.fetch;
  let seen;
  beforeEach(() => {
    seen = [];
    global.fetch = jest.fn(async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ id: 'tx-1', status: 'queued' }), { status: 200 });
    });
  });
  afterEach(() => { global.fetch = realFetch; });

  test('submit: raw key in Authorization, the documented body, no keyterms unless given, no redirects', async () => {
    const r = await v.submit(dbWith(CRED), { credId: 14, audioUrl: 'https://storage.googleapis.com/b/o?X-Goog-Signature=s', variant: 'diarize' });
    expect(r).toMatchObject({ status: 200, json: { id: 'tx-1', status: 'queued' } });
    expect(seen[0].url).toBe('https://api.assemblyai.com/v2/transcript');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers.Authorization).toBe('aai_raw_key');
    expect(seen[0].init.redirect).toBe('error');
    expect(JSON.parse(seen[0].init.body)).toEqual({
      audio_url: 'https://storage.googleapis.com/b/o?X-Goog-Signature=s',
      speech_models: ['universal-3-5-pro'], language_detection: true, speaker_labels: true,
    });
  });

  test('submit: the speaker cap rides a diarize job only, as speaker_options; 0 sends none; modelLabel tags it', async () => {
    await v.submit(dbWith(CRED), { credId: 14, audioUrl: 'https://x/y', variant: 'diarize', maxSpeakers: 2 });
    await v.submit(dbWith(CRED), { credId: 14, audioUrl: 'https://x/y', variant: 'diarize', maxSpeakers: 0 });
    await v.submit(dbWith(CRED), { credId: 14, audioUrl: 'https://x/y', variant: 'multichannel', maxSpeakers: 2 });
    const [a, b, c] = seen.map(x => JSON.parse(x.init.body));
    expect(a).toMatchObject({ speaker_labels: true, speaker_options: { max_speakers_expected: 2 } });
    expect(a.speakers_expected).toBeUndefined();
    expect(b.speaker_options).toBeUndefined();
    expect(c.speaker_options).toBeUndefined();
    expect(v.modelLabel('diarize', 2)).toBe('universal-3-5-pro+diarize+max2');
    expect(v.modelLabel('diarize', 0)).toBe('universal-3-5-pro+diarize');
    expect(v.modelLabel('multichannel', 2)).toBe('universal-3-5-pro+multichannel');
    expect(() => v.modelLabel('stereo', 2)).toThrow(/variant/);
  });

  test('submit multichannel + keyterms + English only', async () => {
    await v.submit(dbWith(CRED), { credId: 14, audioUrl: 'https://x/y', variant: 'multichannel', keyterms: ['Chapter 13', 'trustee'], languageDetection: false });
    const b = JSON.parse(seen[0].init.body);
    expect(b).toMatchObject({ multichannel: true, keyterms_prompt: ['Chapter 13', 'trustee'], language_detection: false });
    expect(b.speaker_labels).toBeUndefined();
    await expect(v.submit(dbWith(CRED), { credId: 14, audioUrl: 'x', variant: 'stereo' })).rejects.toThrow(/variant/);
  });

  test('a URL outside allowed_urls, or no credential → NO_AUTH before anything is sent', async () => {
    const narrow = { ...CRED, allowed_urls: JSON.stringify(['https://api.eu.assemblyai.com/*']) };
    await expect(v.submit(dbWith(narrow), { credId: 14, audioUrl: 'x', variant: 'diarize' })).rejects.toMatchObject({ code: 'NO_AUTH' });
    await expect(v.getTranscript(dbWith(null), { credId: 14, id: 'tx-1' })).rejects.toMatchObject({ code: 'NO_AUTH' });
    expect(seen.length).toBe(0);
    expect(await v.checkAuth(dbWith(narrow), 14)).toBe(false);
    expect(await v.checkAuth(dbWith(CRED), 14)).toBe(true);
  });

  test('statuses are returned, never thrown; a network failure is status 0; a 429 carries Retry-After', async () => {
    global.fetch = jest.fn(async () => new Response('{"error":"Too Many Requests."}', { status: 429, headers: { 'retry-after': '7' } }));
    expect(await v.getTranscript(dbWith(CRED), { credId: 14, id: 'tx-1' })).toMatchObject({ status: 429, retryAfterS: 7, json: null });
    global.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await v.deleteTranscript(dbWith(CRED), { credId: 14, id: 'tx-1' })).toMatchObject({ status: 0, errorText: 'fetch failed' });
    global.fetch = jest.fn(async () => new Response('<html>', { status: 200 }));
    expect((await v.getTranscript(dbWith(CRED), { credId: 14, id: 'tx-1' })).json).toBeUndefined();   // unparseable 2xx
  });

  test('listTranscripts: one UTC day, a page of ≤ 200, before_id validated', async () => {
    global.fetch = jest.fn(async (url) => { seen.push({ url }); return new Response(JSON.stringify({ transcripts: [], page_details: {} }), { status: 200 }); });
    await v.listTranscripts(dbWith(CRED), { credId: 14, createdOn: '2026-10-14', beforeId: 'tx-9', limit: 500 });
    const u = new URL(seen[0].url);
    expect(u.pathname).toBe('/v2/transcript');
    expect(Object.fromEntries(u.searchParams)).toEqual({ created_on: '2026-10-14', limit: '200', before_id: 'tx-9' });
    await expect(v.listTranscripts(dbWith(CRED), { credId: 14, createdOn: 'today' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(v.listTranscripts(dbWith(CRED), { credId: 14, createdOn: '2026-10-14', beforeId: '../x' })).rejects.toThrow(/before_id/);
  });

  test('an error body quoting our signed URL comes back with the query cut', async () => {
    global.fetch = jest.fn(async () => new Response('could not fetch https://storage.googleapis.com/b/o.mp3?X-Goog-Signature=SECRET&X-Goog-Credential=SA', { status: 400 }));
    const r = await v.submit(dbWith(CRED), { credId: 14, audioUrl: 'x', variant: 'diarize' });
    expect(r.errorText).toBe('could not fetch https://storage.googleapis.com/b/o.mp3?…');
    global.fetch = jest.fn(async () => { throw new TypeError('connect ECONNRESET https://api.assemblyai.com/v2/transcript?token=SECRET'); });
    expect((await v.getTranscript(dbWith(CRED), { credId: 14, id: 'tx-1' })).errorText).not.toMatch(/SECRET/);
  });

  test('a job id is validated before it is put in a URL', async () => {
    await expect(v.getTranscript(dbWith(CRED), { credId: 14, id: '../v2/upload' })).rejects.toThrow(/bad transcript id/);
    await expect(v.deleteTranscript(dbWith(CRED), { credId: 14, id: '' })).rejects.toThrow(/bad transcript id/);
  });
});

describe('segmentsFromVendorJson (pure; lane D calls it)', () => {
  const done = (o) => ({ id: 't', status: 'completed', text: 'hi there', audio_duration: 3, ...o });

  test('diarized utterances → {s, a, b, t}, ms → seconds (3 dp)', () => {
    expect(v.segmentsFromVendorJson(done({ utterances: [
      { speaker: 'A', start: 250, end: 1234, text: 'hi', confidence: 0.9, words: [] },
      { speaker: 'B', start: 1300, end: 2999, text: 'there' },
    ] }))).toEqual([{ s: 'A', a: 0.25, b: 1.234, t: 'hi' }, { s: 'B', a: 1.3, b: 2.999, t: 'there' }]);
  });

  test('multichannel utterances are keyed by channel', () => {
    expect(v.segmentsFromVendorJson(done({ multichannel: true, audio_channels: 2, utterances: [
      { speaker: 'A', channel: '1', start: 0, end: 500, text: 'firm' },
      { speaker: 'A', channel: '2', start: 600, end: 900, text: 'client' },
    ] }))).toEqual([{ s: 'ch1', a: 0, b: 0.5, t: 'firm' }, { s: 'ch2', a: 0.6, b: 0.9, t: 'client' }]);
  });

  test('silence (no utterances, empty text) is an empty transcript, not drift', () => {
    expect(v.segmentsFromVendorJson(done({ text: '', utterances: [] }))).toEqual([]);
    expect(v.segmentsFromVendorJson(done({ text: null, utterances: [] }))).toEqual([]);
    expect(v.segmentsFromVendorJson(done({ text: '', utterances: null }))).toEqual([]);
    expect(v.segmentsFromVendorJson(done({ text: null }))).toEqual([]);
  });

  test.each([
    ['not an object', null],
    ['an array', []],
    ['not completed', done({ status: 'processing', utterances: [] })],
    ['text but no utterances', done({ utterances: undefined })],
    ['text but EMPTY utterances', done({ utterances: [] })],
    ['utterances not an array', done({ utterances: {} })],
    ['negative time', done({ utterances: [{ speaker: 'A', start: -1, end: 5, text: 'x' }] })],
    ['end before start', done({ utterances: [{ speaker: 'A', start: 9, end: 5, text: 'x' }] })],
    ['string time', done({ utterances: [{ speaker: 'A', start: '0', end: 5, text: 'x' }] })],
    ['no speaker', done({ utterances: [{ start: 0, end: 5, text: 'x' }] })],
    ['odd speaker', done({ utterances: [{ speaker: 'A B<script>', start: 0, end: 5, text: 'x' }] })],
    ['multichannel without channel', done({ multichannel: true, utterances: [{ speaker: 'A', start: 0, end: 5, text: 'x' }] })],
    ['non-string text', done({ utterances: [{ speaker: 'A', start: 0, end: 5, text: 7 }] })],
  ])('drift: %s', (_name, json) => {
    expect(() => v.segmentsFromVendorJson(json)).toThrow(expect.objectContaining({ code: 'DRIFT' }));
  });
});

describe('the rest of the pure helpers', () => {
  test('fullTextOf: one line per segment; vendor text when there are none', () => {
    expect(v.fullTextOf([{ t: 'a' }, { t: 'b' }], { text: 'ignored' })).toBe('a\nb');
    expect(v.fullTextOf([], { text: 'x' })).toBe('x');
    expect(v.fullTextOf([], {})).toBe('');
  });

  test('stripSignedUrl: the signature never reaches the archive; nothing else changes', () => {
    const j = { id: 't', audio_url: 'https://storage.googleapis.com/lsg/phone/rec/1-a.mp3?X-Goog-Signature=SECRET&X-Goog-Credential=SA', text: 'x' };
    const s = v.stripSignedUrl(j);
    expect(s.audio_url).toBe('https://storage.googleapis.com/lsg/phone/rec/1-a.mp3');
    expect(JSON.stringify(s)).not.toMatch(/SECRET|Credential/);
    expect(j.audio_url).toMatch(/SECRET/);       // the input is not mutated
    expect(v.stripSignedUrl({ audio_url: 'not a url ?sig=SECRET' }).audio_url).not.toMatch(/SECRET/);
  });

  test('costCents: the price card; multichannel bills per channel', () => {
    expect(v.costCents({ audioS: 3600, variant: 'diarize' })).toBe(23);
    expect(v.costCents({ audioS: 3600, variant: 'diarize', keyterms: true })).toBe(28);
    expect(v.costCents({ audioS: 3600, variant: 'multichannel', channels: 2 })).toBe(42);
    expect(v.costCents({ audioS: 3600, variant: 'multichannel', channels: 2, keyterms: true })).toBe(52);
    expect(v.costCents({ audioS: 60, variant: 'diarize' })).toBeCloseTo(0.3833, 4);
    expect(v.costCents({ audioS: -5, variant: 'diarize' })).toBe(0);
  });

  test('redactUrls / validJobId', () => {
    expect(v.redactUrls('a https://h/p?x=1&y=2 b http://h2/q?s=3, c')).toBe('a https://h/p?… b http://h2/q?… c');
    expect(v.redactUrls('no url ?not=a-url')).toBe('no url ?not=a-url');
    expect(v.redactUrls(null)).toBe('');
    expect(v.validJobId('0b2c-ab')).toBe(true);
    for (const bad of ['', '..', '../x', 'a/b', 'a?b', 7, null, 'x'.repeat(65)]) expect(v.validJobId(bad)).toBe(false);
  });

  test('classifyJobError: fetch failures vs everything else', () => {
    expect(v.classifyJobError('Download error, unable to download https://… (403)')).toBe('download');
    expect(v.classifyJobError('Transcoding failed. File does not appear to contain audio.')).toBe('vendor');
    expect(v.classifyJobError(null)).toBe('vendor');
  });
});
