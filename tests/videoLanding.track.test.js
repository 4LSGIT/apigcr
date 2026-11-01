// tests/videoLanding.track.test.js
//
/**
 * POST /api/v/:slug/track and cta-click through the real route: nothing is
 * written without the view's track_token. These endpoints are public and view
 * ids are sequential, so the id alone let anyone report on any client's view.
 * Token compare and the SQL are proved on real MySQL in
 * tests/videoService.mysql.test.js.
 */

const crypto = require('crypto');
const express = require('express');
const videoService = require('../services/videoService');

const TRACK_TOKEN = 'A1b2C3d4E5f6G7h8I9j0Kl';
const video = () => ({
  id: 7, slug: 'demo', title: 'Demo', description: '', gcs_video_url: 'https://storage.example/v.mp4',
  gcs_poster_url: null, gcs_gif_url: null, duration_seconds: 100, tags: null, related_video_ids: null,
  actions: null, access_level: 'public', is_published: 1, view_count: 0,
});

let writes = [];
const fakeDb = {
  query: jest.fn(async (sql, params) => {
    if (/FROM videos WHERE slug = \?/i.test(sql)) return [params[0] === 'demo' ? [video()] : []];
    if (/FROM video_views WHERE id = \?/i.test(sql)) return [params[0] === 555 ? [{ track_token: TRACK_TOKEN }] : []];
    if (/^\s*UPDATE video_views/i.test(sql)) { writes.push({ sql, params }); return [{ affectedRows: 1 }]; }
    return [[]];
  }),
  withTransaction: jest.fn(async (fn) => fn({
    query: async (sql) => (/INSERT INTO video_views/i.test(sql) ? [{ insertId: 555 }] : [[]]),
  })),
};

let server, base;
beforeAll((done) => {
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
beforeEach(() => { writes = []; });

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const REPORTS = [
  ['track play', '/api/v/demo/track', { event: 'play' }],
  ['track progress', '/api/v/demo/track', { event: 'progress', watchSeconds: 95, completionPct: 95 }],
  ['track complete', '/api/v/demo/track', { event: 'complete', watchSeconds: 95, completionPct: 95 }],
  ['cta-click', '/api/v/demo/cta-click', { label: 'Book' }],
];

describe.each(REPORTS)('%s', (_name, path, body) => {
  test('the right token writes', async () => {
    const res = await post(path, { viewId: 555, token: TRACK_TOKEN, ...body });
    expect(res.status).toBe(204);
    expect(writes.length).toBeGreaterThan(0);
  });

  test.each([
    ['no token', undefined],
    ['a wrong token', 'B1b2C3d4E5f6G7h8I9j0Kl'],
  ])('%s is a 404 and writes nothing', async (_n, token) => {
    const res = await post(path, { viewId: 555, token, ...body });
    expect(res.status).toBe(404);
    expect(writes).toHaveLength(0);
  });

  test('a view that does not exist reads the same as a wrong token', async () => {
    const missing = await post(path, { viewId: 556, token: TRACK_TOKEN, ...body });
    const wrong = await post(path, { viewId: 555, token: 'B1b2C3d4E5f6G7h8I9j0Kl', ...body });
    const absent = await post(path, { viewId: 555, ...body });
    expect([missing.status, wrong.status, absent.status]).toEqual([404, 404, 404]);
    for (const res of [missing, wrong, absent]) expect(await res.json()).toEqual({ error: 'Not found' });
    expect(writes).toHaveLength(0);
  });
});

describe('complete is the last report, not a claim of 100%', () => {
  test('it stores the percent the page really watched', async () => {
    const res = await post('/api/v/demo/track', {
      viewId: 555, token: TRACK_TOKEN, event: 'complete', watchSeconds: 3, completionPct: 3,
    });
    expect(res.status).toBe(204);
    expect(writes[0].params.slice(0, 2)).toEqual([3, 3]);
  });

  test.each([['progress'], ['complete']])('%s without its numbers is a 400', async (event) => {
    const res = await post('/api/v/demo/track', { viewId: 555, token: TRACK_TOKEN, event });
    expect(res.status).toBe(400);
    expect(writes).toHaveLength(0);
  });
});

describe('the page gets the view\'s token', () => {
  const tokenIn = (html) => (html.match(/var TOKEN\s*=\s*"([^"]*)"/) || [])[1];

  test('GET renders a real token', async () => {
    const html = await (await fetch(`${base}/v/demo`)).text();
    expect(tokenIn(html)).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(html).not.toContain('{{TRACK_TOKEN}}');
  });

  test('two opens get two tokens', async () => {
    const a = tokenIn(await (await fetch(`${base}/v/demo`)).text());
    const b = tokenIn(await (await fetch(`${base}/v/demo`)).text());
    expect(a).not.toBe(b);
  });
});

describe('hashIp is keyed', () => {
  const saved = process.env.JWT_SECRET;
  afterAll(() => { process.env.JWT_SECRET = saved; });

  test('a plain SHA-256 of the address does not match it', () => {
    process.env.JWT_SECRET = 'key-one';
    const plain = crypto.createHash('sha256').update('203.0.113.9').digest('hex');
    expect(videoService.hashIp('203.0.113.9')).toMatch(/^[0-9a-f]{64}$/);
    expect(videoService.hashIp('203.0.113.9')).not.toBe(plain);
  });

  test('same address, same hash: it still groups a device', () => {
    process.env.JWT_SECRET = 'key-one';
    expect(videoService.hashIp('203.0.113.9')).toBe(videoService.hashIp('203.0.113.9'));
    expect(videoService.hashIp('203.0.113.9')).not.toBe(videoService.hashIp('203.0.113.10'));
  });

  test('another key, another hash', () => {
    process.env.JWT_SECRET = 'key-one';
    const a = videoService.hashIp('203.0.113.9');
    process.env.JWT_SECRET = 'key-two';
    expect(videoService.hashIp('203.0.113.9')).not.toBe(a);
  });
});
