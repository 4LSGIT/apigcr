// Video landing rate limits (2026-08-17).
//
// GET /v/:slug is an unauthenticated WRITE (INSERT into video_views per hit)
// and until this slice had no limiter at all. Locks:
//   - the 31st GET in a minute from one IP is 429 and does NOT reach the DB
//     write path;
//   - the POST beacons share a 30/min limit;
//   - keying uses lib/rateLimiter's LAST-XFF-element rule, so an attacker
//     rotating the FIRST XFF element stays in ONE bucket (the exact bypass
//     the removed private first-element getClientIp would have allowed).
//
// makeLimiter state is module-level, so this file drives its own app
// instance (jest's per-file module registry keeps it isolated from the
// actionUrl suite's requests).
'use strict';

const express = require('express');

let ACTIONS = [];
const videoRow = () => ({
  id: 7, slug: 'demo', title: 'T', description: '',
  gcs_video_url: 'https://storage.example/v.mp4', gcs_poster_url: null,
  gcs_gif_url: null, duration_seconds: 10,
  tags: null, related_video_ids: null,
  actions: JSON.stringify(ACTIONS),
  access_level: 'public', is_published: 1, view_count: 0,
});

const fakeConn = {
  query: jest.fn(async (sql) => {
    if (/INSERT INTO video_views/i.test(sql)) return [{ insertId: 555 }];
    if (/UPDATE videos SET view_count/i.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  }),
};

const fakeDb = {
  query: jest.fn(async (sql, params) => {
    if (/FROM videos WHERE slug = \?/i.test(sql)) {
      return [params[0] === 'demo' ? [videoRow()] : []];
    }
    if (/FROM video_slug_aliases a/i.test(sql)) return [[]];
    if (/FROM video_views WHERE id = \?/i.test(sql)) return [[{ id: params[0] }]];
    return [[]];
  }),
  withTransaction: jest.fn(async (fn) => fn(fakeConn)),
};

let server, base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = fakeDb; next(); });
  app.use(require('../routes/videoLanding'));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

// Distinct last-XFF element per test → each test gets its own bucket, so
// the tests don't consume each other's budget.
const get = (ip, firstXff) =>
  fetch(`${base}/v/demo`, {
    headers: { 'x-forwarded-for': `${firstXff || '203.0.113.9'}, ${ip}` },
  });
const post = (p, ip) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `1.2.3.4, ${ip}` },
    body: JSON.stringify({ viewId: 555, event: 'play' }),
  });

describe('GET /v/:slug limiter', () => {
  test('30 GETs pass; the 31st is 429 and skips the DB write', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await get('198.51.100.1')).status).toBe(200);
    }
    const writesBefore = fakeDb.withTransaction.mock.calls.length;
    const res = await get('198.51.100.1');
    expect(res.status).toBe(429);
    expect(fakeDb.withTransaction.mock.calls.length).toBe(writesBefore);
  });

  test('LOCK: rotating the FIRST XFF element does not mint fresh buckets', async () => {
    // Attacker varies the client-supplied prefix; the GFE-appended LAST
    // element is what keys the bucket. All 31 land in one bucket.
    let last;
    for (let i = 0; i < 31; i++) {
      last = await get('198.51.100.2', `10.0.${i}.${i}`);
    }
    expect(last.status).toBe(429);
  });

  test('a different peer IP is a different bucket', async () => {
    expect((await get('198.51.100.3')).status).toBe(200);
  });
});

describe('POST beacon limiter (shared)', () => {
  test('track + cta-click share one 30/min bucket per IP', async () => {
    for (let i = 0; i < 15; i++) {
      expect((await post('/api/v/demo/track', '198.51.100.4')).status).toBe(204);
    }
    for (let i = 0; i < 15; i++) {
      const r = await fetch(base + '/api/v/demo/cta-click', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4, 198.51.100.4' },
        body: JSON.stringify({ viewId: 555, label: 'x' }),
      });
      expect(r.status).toBe(204);
    }
    const over = await post('/api/v/demo/track', '198.51.100.4');
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/Too many/);
  });
});
