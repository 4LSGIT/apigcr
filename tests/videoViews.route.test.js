// tests/videoViews.route.test.js
//
/**
 * The Views routes through the real router: /api/videos/views has to win over
 * /api/videos/:id, the query string reaches the service as filters, and a bad
 * filter is a 400. The SQL is proved on real MySQL in
 * tests/videoService.mysql.test.js.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

let mockAuth;
let mockRefuse = false;
jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => {
  if (mockRefuse) return res.status(401).json({ error: 'no' });
  req.auth = mockAuth;
  next();
});

const videoService = require('../services/videoService');

const fakeDb = { query: jest.fn(async () => [[]]) };

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = fakeDb; next(); });
  app.use(require('../routes/api.videos'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});
beforeEach(() => { mockAuth = { userId: 6 }; mockRefuse = false; fakeDb.query.mockClear(); });
afterEach(() => jest.restoreAllMocks());

const post = (url) => fetch(base + url, { method: 'POST' });

describe('every Views route needs a login', () => {
  test.each([
    ['GET', '/api/videos/views'],
    ['POST', '/api/videos/views/5/exclude'],
    ['POST', '/api/videos/views/5/restore'],
  ])('%s %s', async (method, url) => {
    mockRefuse = true;
    const list = jest.spyOn(videoService, 'listViews');
    const set = jest.spyOn(videoService, 'setViewExcluded');
    expect((await fetch(base + url, { method })).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('GET /api/videos/views', () => {
  test('is the list, not video "views"', async () => {
    const list = jest.spyOn(videoService, 'listViews').mockResolvedValue({ views: [], total: 0 });
    const byId = jest.spyOn(videoService, 'getVideoById');
    const res = await fetch(`${base}/api/videos/views`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ views: [], total: 0 });
    expect(list).toHaveBeenCalledTimes(1);
    expect(byId).not.toHaveBeenCalled();
  });

  test('hands the query string over as filters', async () => {
    const list = jest.spyOn(videoService, 'listViews').mockResolvedValue({ views: [] });
    await fetch(`${base}/api/videos/views?video_id=3&q=ann&status=played&who=known&from=2026-07-01&to=2026-07-02`
      + '&automated=1&excluded=1&before_reset=1&limit=50&offset=100');
    expect(list.mock.calls[0][1]).toEqual({
      videoId: '3', contact: 'ann', status: 'played', who: 'known', from: '2026-07-01', to: '2026-07-02',
      includeAutomated: true, includeExcluded: true, includeBeforeReset: true, limit: '50', offset: '100',
    });
  });

  test('a typed name rides in the one parameter the audit log redacts', () => {
    const { redactSearchParams } = jest.requireActual('../lib/auth.jwtOrApiKey');
    const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'videoManager.html'), 'utf8');
    expect(page).toContain("put('q',        viewEl('vfContact').value.trim());");
    expect(redactSearchParams('/api/videos/views?q=Ann%20Lee&limit=100')).not.toContain('Ann');
  });

  test('nothing hidden is shown unless it is asked for', async () => {
    const list = jest.spyOn(videoService, 'listViews').mockResolvedValue({ views: [] });
    await fetch(`${base}/api/videos/views?automated=0&excluded=true`);
    expect(list.mock.calls[0][1]).toMatchObject({
      includeAutomated: false, includeExcluded: false, includeBeforeReset: false,
    });
  });

  test.each(['status=nope', 'who=nope', 'video_id=abc', 'from=yesterday', 'to=2026-02-31'])(
    '%s is a 400 that reaches no query', async (qs) => {
      const res = await fetch(`${base}/api/videos/views?${qs}`);
      expect(res.status).toBe(400);
      expect(fakeDb.query).not.toHaveBeenCalled();
    });

  test('a database failure is a 500', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    fakeDb.query.mockRejectedValueOnce(new Error('down'));
    expect((await fetch(`${base}/api/videos/views`)).status).toBe(500);
    expect(err).toHaveBeenCalled();
  });
});

describe('POST /api/videos/views/:viewId/exclude and restore', () => {
  test('exclude records who', async () => {
    const set = jest.spyOn(videoService, 'setViewExcluded')
      .mockResolvedValue({ id: 5, video_id: 1, excluded: true, changed: true });
    const res = await post('/api/videos/views/5/exclude');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 5, video_id: 1, excluded: true, changed: true });
    expect(set).toHaveBeenCalledWith(fakeDb, 5, true, 6);
  });

  test('under View-as it records the person at the keyboard', async () => {
    mockAuth = { userId: 1, impersonator: { userId: 6 } };
    const set = jest.spyOn(videoService, 'setViewExcluded').mockResolvedValue({ id: 5 });
    await post('/api/videos/views/5/exclude');
    expect(set).toHaveBeenCalledWith(fakeDb, 5, true, 6);
  });

  test('restore sets it back', async () => {
    const set = jest.spyOn(videoService, 'setViewExcluded').mockResolvedValue({ id: 5 });
    await post('/api/videos/views/5/restore');
    expect(set).toHaveBeenCalledWith(fakeDb, 5, false, 6);
  });

  test.each([[{ userId: 'api-key' }], [{}], [undefined]])('a caller with no user id records NULL: %j', async (who) => {
    mockAuth = who;
    const set = jest.spyOn(videoService, 'setViewExcluded').mockResolvedValue({ id: 5 });
    await post('/api/videos/views/5/exclude');
    expect(set).toHaveBeenCalledWith(fakeDb, 5, true, null);
  });

  test.each(['abc', '0', '-1', '1.5', '9007199254740993'])('view id %s is a 400', async (id) => {
    const set = jest.spyOn(videoService, 'setViewExcluded');
    expect((await post(`/api/videos/views/${id}/exclude`)).status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  test('a missing view is a 404', async () => {
    jest.spyOn(videoService, 'setViewExcluded').mockRejectedValue(Object.assign(new Error('View not found'), { statusCode: 404 }));
    expect((await post('/api/videos/views/5/restore')).status).toBe(404);
  });
});
