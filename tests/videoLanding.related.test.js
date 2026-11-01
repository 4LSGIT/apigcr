// tests/videoLanding.related.test.js
//
/**
 * GET /v/:slug — what a viewer's identity does to the related-video cards, and
 * what a HEAD records. Through the real route on a fake pool; the SQL
 * predicates behind publicOnly and the case ranking are proved on real MySQL
 * in tests/videoService.mysql.test.js.
 *
 *   - A token viewer's cards carry ?ct=. They used to downgrade to ?c=, which
 *     stripped the next page's action buttons and contact_only access, and
 *     minted the deprecated form on every click.
 *   - A retired ?c= arrival is anonymous and is never handed the token.
 *   - Only a token viewer is offered contact_only cards.
 *   - HEAD records no view.
 */

const express = require('express');

const TOKEN = 'a'.repeat(32);
const RELATED_ROW = {
  id: 8, slug: 'next', title: 'Next', gcs_poster_url: null, gcs_gif_url: null, tags: null,
};

const videoRow = () => ({
  id: 7, slug: 'demo', title: 'Demo', description: '', gcs_video_url: 'https://storage.example/v.mp4',
  gcs_poster_url: null, gcs_gif_url: null, duration_seconds: 10,
  tags: null, related_video_ids: JSON.stringify([8]), actions: null,
  access_level: 'public', is_published: 1, view_count: 0,
});

let relatedSql = [];
let inserts = 0;

const fakeConn = {
  query: jest.fn(async (sql) => {
    if (/INSERT INTO video_views/i.test(sql)) { inserts++; return [{ insertId: 555 }]; }
    return [[]];
  }),
};

const fakeDb = {
  query: jest.fn(async (sql, params) => {
    if (/FROM videos WHERE slug = \?/i.test(sql)) return [params[0] === 'demo' ? [videoRow()] : []];
    if (/SELECT id, related_video_ids, tags FROM videos/i.test(sql)) {
      return [[{ id: 7, related_video_ids: JSON.stringify([8]), tags: null }]];
    }
    if (/FROM videos\s+WHERE id IN/i.test(sql)) { relatedSql.push(sql); return [[RELATED_ROW]]; }
    if (/FROM contacts WHERE contact_token = \?/i.test(sql)) {
      return [params[0] === TOKEN ? [{ contact_id: 42, contact_token: TOKEN }] : []];
    }
    // Holds a token on purpose: a legacy ?c= arrival must not pick it up.
    if (/FROM contacts WHERE contact_id = \?/i.test(sql)) return [[{ contact_id: params[0], contact_token: TOKEN }]];
    return [[]];
  }),
  withTransaction: jest.fn(async (fn) => fn(fakeConn)),
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
beforeEach(() => { relatedSql = []; inserts = 0; });

const cardHref = (html) => (html.match(/class="related-card" href="([^"]*)"/) || [])[1];

describe('related-video cards keep the identity the viewer arrived with', () => {
  test('token viewer: ?ct=, and no link on the page carries ?c=', async () => {
    const html = await (await fetch(`${base}/v/demo?ct=${TOKEN}`)).text();
    expect(cardHref(html)).toBe(`/v/next?ct=${TOKEN}`);
    expect(html).not.toMatch(/href="[^"]*\?c=/);
  });

  test('retired ?c= viewer: a bare link, and the token is never fetched or printed', async () => {
    const html = await (await fetch(`${base}/v/demo?c=42`)).text();
    expect(cardHref(html)).toBe('/v/next');
    expect(html).not.toContain(TOKEN);
  });

  test('anonymous viewer: a bare link', async () => {
    const html = await (await fetch(`${base}/v/demo`)).text();
    expect(cardHref(html)).toBe('/v/next');
  });
});

describe('contact_only cards are offered only to a token viewer', () => {
  test.each([
    ['anonymous', '/v/demo', true],
    ['retired ?c=', '/v/demo?c=42', true],
    ['token', `/v/demo?ct=${TOKEN}`, false],
  ])('%s', async (_who, url, filtered) => {
    await (await fetch(base + url)).text();
    expect(relatedSql).toHaveLength(1);
    expect(/access_level = 'public'/.test(relatedSql[0])).toBe(filtered);
  });
});

describe('what records a view', () => {
  test('GET records one', async () => {
    const res = await fetch(`${base}/v/demo`);
    await res.text();
    expect(res.status).toBe(200);
    expect(inserts).toBe(1);
  });

  test('HEAD records none and still answers 200', async () => {
    const res = await fetch(`${base}/v/demo`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(inserts).toBe(0);
  });
});
