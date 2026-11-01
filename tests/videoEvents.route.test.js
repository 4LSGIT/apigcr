// tests/videoEvents.route.test.js
//
/**
 * The video.* events through the real routes on a fake pool. What decides
 * whether a view may fire is proved on real MySQL in
 * tests/videoService.mysql.test.js; this is what reaches it.
 *
 *   - A view is verified only when a ?ct= token resolved its contact. A ?c=
 *     integer is what anyone can type, and a rule might text a client.
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
const video = () => ({
  id: 7, slug: 'demo', title: 'Demo', description: '', gcs_video_url: 'https://storage.example/v.mp4',
  gcs_poster_url: null, gcs_gif_url: null, duration_seconds: 100, tags: null, related_video_ids: null,
  actions: JSON.stringify([{ type: 'url', label: 'Book', config: { url: 'https://example.com/book' } }]),
  access_level: 'public', is_published: 1, view_count: 0,
});
const eventRow = {
  id: 555, video_id: 7, contact_id: 42, case_id: 'C1', watch_seconds: 3, completion_pct: 4,
  slug: 'demo', title: 'Demo', first_for_contact: 1,
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

describe('what a page open records as verified', () => {
  let record;
  beforeEach(() => {
    record = jest.spyOn(videoService, 'recordView').mockResolvedValue({ viewId: 555, trackToken: TRACK_TOKEN });
  });
  afterEach(() => record.mockRestore());

  test.each([
    ['a ?ct= token', `?ct=${TOKEN}`, 42, true],
    ['a typed ?c= integer', '?c=42', 42, false],
    ['a ?ct= that resolves to nobody', `?ct=${'b'.repeat(32)}`, null, false],
    ['no link at all', '', null, false],
    ['a ?ct= beside a ?c=', `?ct=${TOKEN}&c=99`, 42, true],
    ['a malformed ?ct= beside a ?c= stays attribution only', '?ct=bad&c=42', 42, false],
  ])('%s', async (_n, qs, contactId, verified) => {
    await fetch(`${base}/v/demo${qs}`);
    expect(record.mock.calls[0][1]).toMatchObject({ contactId, contactVerified: verified });
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
