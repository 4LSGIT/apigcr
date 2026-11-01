// tests/videoEvents.route.test.js
//
/**
 * The video.* events through the real routes on a fake pool. What decides
 * whether a view may fire is proved on real MySQL in
 * tests/videoService.mysql.test.js; this is what reaches it.
 *
 *   - A view is verified only when a ?ct= token resolved its contact.
 *   - ?ca= alone means the case's Primary, unverified, and opens nothing gated.
 *     A token that misses never falls through to it. A retired ?c= is ignored.
 *   - A {{ca}} button shows only for a certain case, and never prints one for
 *     someone who hasn't shown a credential.
 *   - The beacon's answer waits for the event: Cloud Run throttles a request's
 *     CPU after the response, so a detached emit starves.
 *   - The catalog the rule builder reads matches what an emit really carries.
 */

process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY || 'x'.repeat(64);

const express = require('express');
const domainEvents = require('../lib/domainEvents');
const alerting = require('../lib/alerting');
const videoService = require('../services/videoService');
const { EVENT_TYPES } = require('../services/triggerService');

const TOKEN = 'a'.repeat(32);
const TRACK_TOKEN = 'A1b2C3d4E5f6G7h8I9j0Kl';
let ACTIONS = [{ type: 'url', label: 'Book', config: { url: 'https://example.com/book' } }];
let ACCESS = 'public';
const video = () => ({
  id: 7, slug: 'demo', title: 'Demo', description: '', gcs_video_url: 'https://storage.example/v.mp4',
  gcs_poster_url: null, gcs_gif_url: null, duration_seconds: 100, tags: null, related_video_ids: null,
  actions: JSON.stringify(ACTIONS),
  access_level: ACCESS, is_published: 1, view_count: 0,
});
const eventRow = {
  id: 555, video_id: 7, contact_id: 42, case_id: 'C1', watch_seconds: 3, completion_pct: 4,
  slug: 'demo', title: 'Demo', first_for_contact: 1, first_for_case: 1,
};

const fakeDb = {
  query: jest.fn(async (sql, params) => {
    if (/FROM videos WHERE slug = \?/i.test(sql)) return [params[0] === 'demo' ? [video()] : []];
    if (/FROM contacts WHERE contact_token = \?/i.test(sql)) {
      return [params[0] === TOKEN ? [{ contact_id: 42, contact_token: TOKEN }] : []];
    }
    if (/FROM contacts WHERE contact_id = \?/i.test(sql)) return [[{ contact_id: params[0] }]];
    if (/track_token FROM video_views|FROM video_views WHERE id = \?/i.test(sql)) return [[{ track_token: TRACK_TOKEN }]];
    if (/vv\.contact_verified = 1/.test(sql)) return [[eventRow]];
    if (/^\s*UPDATE video_views/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  }),
};

let server, base;
beforeAll((done) => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = fakeDb; next(); });
  app.use(require('../routes/videoLanding'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

const CASE_ID = 'CASE1234';
const stubCases = () => ({
  resolve: jest.spyOn(videoService, 'resolveViewCase').mockImplementation(async (db, id, ca) => (
    ca === CASE_ID ? { caseId: CASE_ID, certain: true, fromLink: true }
      : { caseId: 'GUESS123', certain: true, fromLink: false })),
  primary: jest.spyOn(videoService, 'primaryOfCase').mockImplementation(async (db, ca) => (
    ca === CASE_ID ? { contactId: 42, caseId: CASE_ID } : null)),
  record: jest.spyOn(videoService, 'recordView').mockResolvedValue({ viewId: 555, trackToken: TRACK_TOKEN }),
});
// Each from its own address: the page allows 30 opens a minute from one.
let pages = 0;
const page = async (qs) => {
  pages += 1;
  const res = await fetch(`${base}/v/demo${qs}`, {
    headers: { 'X-Forwarded-For': `10.9.${pages >> 8}.${pages & 255}` },
  });
  return { res, html: await res.text() };
};

describe('what a page open records', () => {
  let stubs;
  beforeEach(() => { stubs = stubCases(); });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['a ?ct= token', `?ct=${TOKEN}`, 42, true, 'GUESS123'],
    ['a ?ct= with its case', `?ct=${TOKEN}&ca=${CASE_ID}`, 42, true, CASE_ID],
    ['a ?ca= alone is the case\'s Primary, unverified', `?ca=${CASE_ID}`, 42, false, CASE_ID],
    ['an empty ?ct= is no ?ct=: a failed send leaves one', `?ct=&ca=${CASE_ID}`, 42, false, CASE_ID],
    ['a ?ca= for no case', '?ca=NOPE1234', null, false, null],
    ['a retired ?c=', '?c=42', null, false, null],
    ['a ?ct= that misses never falls through to ?ca=', `?ct=${'b'.repeat(32)}&ca=${CASE_ID}`, null, false, null],
    ['a malformed ?ct= never falls through either', `?ct=bad&ca=${CASE_ID}`, null, false, null],
    ['a retired ?c= beside ?ct= changes nothing', `?ct=${TOKEN}&c=99`, 42, true, 'GUESS123'],
    ['a retired ?c= beside ?ca= changes nothing', `?c=99&ca=${CASE_ID}`, 42, false, CASE_ID],
    ['no link at all', '', null, false, null],
  ])('%s', async (_n, qs, contactId, verified, caseId) => {
    await page(qs);
    expect(stubs.record.mock.calls[0][1]).toMatchObject({ contactId, contactVerified: verified, caseId });
  });

  test.each([
    ['punctuation', `?ca=${encodeURIComponent("';--")}`],
    ['too long', `?ca=${'A'.repeat(21)}`],
    ['a repeated parameter', '?ca=A&ca=B'],
    ['an object', '?ca[x]=A'],
    ['a one-item list', `?ca[]=${CASE_ID}`],
  ])('a ?ca= shaped like nothing is never looked up: %s', async (_n, qs) => {
    await page(qs);
    expect(stubs.primary).not.toHaveBeenCalled();
    expect(stubs.record.mock.calls[0][1]).toMatchObject({ contactId: null, caseId: null });
  });

  test.each([
    ['a token page', `?ct=${TOKEN}`, 'resolve', 42],
    ['a ?ca= page', `?ca=${CASE_ID}`, 'primary', null],
  ])('a failed case lookup costs %s its case, not the page', async (_n, qs, which, contactId) => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    stubs[which].mockRejectedValue(new Error('db down'));
    const { res } = await page(qs);
    expect(res.status).toBe(200);
    expect(stubs.record.mock.calls[0][1]).toMatchObject({ contactId, caseId: null });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('case lookup failed'), expect.any(Error));
  });

  test('the page tells the browser to send no referrer', async () => {
    expect((await page(`?ct=${TOKEN}`)).res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('a real id passes the shape check, legacy dash included', async () => {
    await page('?ca=aB-_1234');
    expect(stubs.primary).toHaveBeenCalledWith(fakeDb, 'aB-_1234');
  });

  test('a token asks for the case it was given', async () => {
    await page(`?ct=${TOKEN}&ca=${CASE_ID}`);
    expect(stubs.resolve).toHaveBeenCalledWith(fakeDb, 42, CASE_ID);
    expect(stubs.primary).not.toHaveBeenCalled();
  });

  test.each([['?ca=', `?ca=${CASE_ID}`], ['?c=', '?c=42'], ['?ct=', `?ct=${TOKEN}`]])(
    'a %s page is never indexed', async (_n, qs) => {
      expect((await page(qs)).res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    });

  test('the bare page stays indexable', async () => {
    expect((await page('')).res.headers.get('x-robots-tag')).toBeNull();
  });

  describe('a contact_only video', () => {
    beforeEach(() => { ACCESS = 'contact_only'; });
    afterEach(() => { ACCESS = 'public'; });

    test('?ca= alone does not open it, and records nothing', async () => {
      expect((await page(`?ca=${CASE_ID}`)).res.status).toBe(404);
      expect(stubs.record).not.toHaveBeenCalled();
    });
    test('?c= does not open it', async () => {
      expect((await page('?c=42')).res.status).toBe(404);
    });
    test('?ct= does', async () => {
      expect((await page(`?ct=${TOKEN}&ca=${CASE_ID}`)).res.status).toBe(200);
    });
  });

  test.each([
    ['?ca= alone is not offered contact_only cards', `?ca=${CASE_ID}`, true],
    ['a token is', `?ct=${TOKEN}`, false],
  ])('%s', async (_n, qs, publicOnly) => {
    const related = jest.spyOn(videoService, 'getRelatedVideos').mockResolvedValue([]);
    await page(qs);
    expect(related.mock.calls[0][2]).toMatchObject({ publicOnly });
  });

  describe('a {{ca}} button', () => {
    const DOC = { type: 'url', label: 'Upload', config: { url: 'https://app.4lsg.com/docReq?case={{ca}}' } };
    const BOOK = { type: 'url', label: 'Book', config: { url: 'https://example.com/book' } };
    const href = (id) => `href="https://app.4lsg.com/docReq?case=${id}"`;
    const uncertain = () => stubs.resolve.mockResolvedValue({ caseId: 'GUESS123', certain: false, fromLink: false });
    beforeEach(() => { ACTIONS = [DOC, BOOK]; });
    afterEach(() => { ACTIONS = [BOOK]; });

    test('a token and a named case', async () => {
      expect((await page(`?ct=${TOKEN}&ca=${CASE_ID}`)).html).toContain(href(CASE_ID));
    });
    test('a token and one certain case needs no ?ca=', async () => {
      expect((await page(`?ct=${TOKEN}`)).html).toContain(href('GUESS123'));
    });
    test('?ca= alone: the holder already has the id', async () => {
      expect((await page(`?ca=${CASE_ID}`)).html).toContain(href(CASE_ID));
    });
    test('an uncertain case hides the button and leaves the others', async () => {
      uncertain();
      const { html } = await page(`?ct=${TOKEN}`);
      expect(html).not.toContain('docReq');
      expect(html).not.toContain('GUESS123');
      expect(html).toContain('Book');
    });
    test.each([['nobody', ''], ['a retired ?c=', '?c=42']])('%s sees no button and no case id', async (_n, qs) => {
      const { html } = await page(qs);
      expect(html).not.toContain('docReq');
      expect(stubs.resolve).not.toHaveBeenCalled();
    });
    test('a case id is escaped into the url', async () => {
      stubs.resolve.mockResolvedValue({ caseId: 'a b&c', certain: true, fromLink: false });
      expect((await page(`?ct=${TOKEN}`)).html).toContain(href('a%20b%26c'));
    });
    test('every {{ca}} in a url is filled', async () => {
      ACTIONS = [{ type: 'url', label: 'B', config: { url: '/x?a={{ca}}&b={{ca}}' } }];
      expect((await page(`?ct=${TOKEN}`)).html).toContain('href="/x?a=GUESS123&amp;b=GUESS123"');
    });
    test('{{c}} beside {{ca}} is still the token', async () => {
      ACTIONS = [{ type: 'url', label: 'B', config: { url: '/x?t={{c}}&k={{ct}}&ca={{ca}}' } }];
      expect((await page(`?ct=${TOKEN}`)).html).toContain(`href="/x?t=${TOKEN}&amp;k=${TOKEN}&amp;ca=GUESS123"`);
    });
    test('the save check accepts it and still refuses a bad scheme', () => {
      expect(() => videoService.validateActions([DOC])).not.toThrow();
      expect(() => videoService.validateActions([{ ...DOC, config: { url: 'javascript:alert({{ca}})' } }])).toThrow(/disallowed/);
    });
    test('a click on it can fire: the label is a real button', async () => {
      const emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
      await videoService.recordCtaClick(fakeDb, { viewId: 555, videoId: 7, label: 'Upload', actions: [DOC] });
      expect(emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('related cards', () => {
    const card = (html) => (html.match(/class="related-card" href="([^"]*)"/) || [])[1];
    beforeEach(() => {
      jest.spyOn(videoService, 'getRelatedVideos').mockResolvedValue([{ id: 8, slug: 'next', title: 'Next' }]);
    });

    test.each([
      ['a named case rides along', `?ct=${TOKEN}&ca=${CASE_ID}`, `/v/next?ct=${TOKEN}&amp;ca=${CASE_ID}`],
      ['a guess stays behind', `?ct=${TOKEN}`, `/v/next?ct=${TOKEN}`],
      ['?ca= alone', `?ca=${CASE_ID}`, `/v/next?ca=${CASE_ID}`],
      ['a retired ?c= is dropped', '?c=42', '/v/next'],
      ['nobody', '', '/v/next'],
    ])('%s', async (_n, qs, want) => {
      expect(card((await page(qs)).html)).toBe(want);
    });
  });
});

describe('the beacon waits for its event', () => {
  const post = (body) => fetch(`${base}/api/v/demo/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewId: 555, token: TRACK_TOKEN, ...body }),
  });

  test.each([
    ['play', () => post({ event: 'play' })],
    ['progress', () => post({ event: 'progress', watchSeconds: 95, completionPct: 95 })],
    ['a button click', () => fetch(`${base}/api/v/demo/cta-click`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewId: 555, token: TRACK_TOKEN, label: 'Book' }),
    })],
  ])('%s: no answer until the emit has finished', async (_n, send) => {
    let finish;
    const emit = jest.spyOn(domainEvents, 'emit').mockImplementation(() => new Promise((r) => { finish = r; }));
    let answered = false;
    const reply = send().then((res) => { answered = true; return res; });
    for (let i = 0; i < 200 && !emit.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(emit).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(answered).toBe(false);
    finish();
    expect((await reply).status).toBe(204);
    emit.mockRestore();
  });

  test('a failed lookup costs the event, not the beacon', async () => {
    const emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const real = fakeDb.query.getMockImplementation();
    fakeDb.query.mockImplementation(async (sql, params) => {
      if (/vv\.contact_verified = 1/.test(sql)) throw new Error('lock wait');
      return real(sql, params);
    });
    const res = await post({ event: 'play' });
    fakeDb.query.mockImplementation(real);
    expect(res.status).toBe(204);
    expect(emit).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('event lookup failed'), 'lock wait');
    emit.mockRestore();
    err.mockRestore();
  });

  describe('a lost event raises an alert', () => {
    let alert, err, real;
    const failWith = (error) => fakeDb.query.mockImplementation(async (sql, params) => {
      if (/vv\.contact_verified = 1/.test(sql)) throw error;
      return real(sql, params);
    });
    const transient = () => Object.assign(new Error('gone'), { code: 'ECONNRESET' });
    beforeEach(() => {
      real = fakeDb.query.getMockImplementation();
      alert = jest.spyOn(alerting, 'alert').mockResolvedValue();
      err = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(async () => {
      fakeDb.query.mockImplementation(real);
      await videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 });   // clears the repeat flag
      alert.mockRestore();
      err.mockRestore();
    });

    test('a first transient failure is a warning, a repeat is an error', async () => {
      const emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
      await videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 });
      failWith(transient());
      await videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 });
      await videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 });
      emit.mockRestore();
      expect(alert.mock.calls.map((c) => c[1].severity)).toEqual(['warning', 'error']);
      expect(alert.mock.calls[0][1]).toMatchObject({ source: 'app', kind: 'video_event_lost', group_key: 'video_events' });
    });

    test('anything else is an error the first time', async () => {
      const emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
      await videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 });
      failWith(new Error("Unknown column 'vv.contact_verified'"));
      await videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 });
      emit.mockRestore();
      expect(alert.mock.calls.map((c) => c[1].severity)).toEqual(['error']);
    });

    test('an alert that fails does not fail the beacon', async () => {
      const emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
      alert.mockRejectedValue(new Error('smtp down'));
      failWith(transient());
      await expect(videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 })).resolves.toEqual({ playedNow: true });
      emit.mockRestore();
    });
  });
});

test('video_watch_status stays out of sequences: they can\'t read the result', () => {
  expect(require('../lib/internal_functions/video').video_watch_status.__meta.workflowOnly).toBe(true);
});

describe('the catalog', () => {
  const paths = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) =>
    (v && typeof v === 'object' && !Array.isArray(v) ? paths(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

  test.each([
    ['video.played', () => videoService.recordPlayed(fakeDb, { viewId: 555, videoId: 7 })],
    ['video.completed', () => videoService.recordProgress(fakeDb, { viewId: 555, videoId: 7, watchSeconds: 95, completionPct: 95 })],
    ['video.cta_clicked', () => videoService.recordCtaClick(fakeDb, { viewId: 555, videoId: 7, label: 'Book', actions: [{ type: 'url', label: 'Book', config: { url: 'https://example.com/book' } }] })],
  ])('%s lists every path a real envelope carries', async (type, act) => {
    const emit = jest.spyOn(domainEvents, 'emit').mockResolvedValue();
    await act();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][1]).toBe(type);
    const envelope = domainEvents.buildEnvelope(type, emit.mock.calls[0][2]);
    emit.mockRestore();
    const carried = paths({ contact_id: 1, case_id: 1, ...envelope, chain: undefined, changes: undefined })
      .filter((p) => /^(data|extra)\./.test(p));
    const listed = EVENT_TYPES[type].fields.map((f) => f.path).filter((p) => /^(data|extra)\./.test(p));
    expect(carried.sort()).toEqual(listed.sort());
    expect(envelope.contact_id).toBe(42);
    expect(envelope.case_id).toBe('C1');
  });
});
