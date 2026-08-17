// Action-URL scheme allowlist (2026-08-17 XSS fix).
//
// videos.actions[].config.url is staff-authored (jwtOrApiKey — any staff
// member) and rendered into an <a href> on the PUBLIC landing page.
// htmlEscape stops attribute breakout; it does nothing about a javascript:
// scheme, which executes on click and can read the app-origin localStorage
// JWT. Locks, in three layers:
//
//   1. isSafeActionUrl — the rule itself, full evasion matrix.
//   2. GET /v/:slug rendered HTML — a stored-bad URL never reaches an href,
//      good URLs do. Asserted on the RENDERED PAGE, not the helper, so a
//      refactor that bypasses the helper fails here.
//   3. createVideo / updateVideo — bad action URLs are rejected on write
//      with statusCode 400 (the API is reachable without the manager UI).
'use strict';

const express = require('express');
const videoService = require('../services/videoService');

// ─────────────────────────────────────────────────────────────
// 1. The rule
// ─────────────────────────────────────────────────────────────

describe('isSafeActionUrl', () => {
  const BAD = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '\u0000javascript:alert(1)',            // leading NUL
    'java\tscript:alert(1)',                // embedded tab
    'java\nscript:alert(1)',                // embedded newline
    ' \t javascript:alert(1)',              // leading whitespace
    '//evil.example/pwn',                   // protocol-relative
    '%6Aavascript:alert(1)',                // URL-encoded scheme → schemeless
    'jAvA\u0009sCrIpT\u000A:alert(1)',      // mixed case + controls
    'foo/bar',                              // bare relative — nothing mints these
    '?c=1',
    '#anchor',
    '',
    '   ',
  ];
  const GOOD = [
    'https://example.com/x?y=1',
    'http://example.com',
    'HTTPS://EXAMPLE.COM',                  // scheme match is case-insensitive
    'mailto:office@4lsg.com',
    'tel:+12484179800',
    '/book/consult?c=42',                   // root-relative — real use case
    '/v/other-video',
    '  https://example.com  ',              // outer whitespace trimmed
  ];

  test.each(BAD)('rejects %j', (u) => {
    expect(videoService.isSafeActionUrl(u)).toBe(false);
  });
  test.each(GOOD)('accepts %j', (u) => {
    expect(videoService.isSafeActionUrl(u)).toBe(true);
  });
  test('rejects non-strings', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(videoService.isSafeActionUrl(v)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Rendered HTML — GET /v/:slug through the real route
// ─────────────────────────────────────────────────────────────

// Fake pool: enough surface for videoLanding's GET path. Actions are set
// per-test via setActions(). recordView's transaction is satisfied with a
// conn whose INSERT returns a viewId.
let ACTIONS = [];
function setActions(a) { ACTIONS = a; }

const videoRow = () => ({
  id: 7, slug: 'demo', title: 'Demo & Title', description: 'line1\nline2',
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
    if (/FROM cases c/i.test(sql)) return [[]];
    return [[]];
  }),
};

const fakeDb = {
  query: jest.fn(async (sql, params) => {
    if (/FROM videos WHERE slug = \?/i.test(sql)) {
      return [params[0] === 'demo' ? [videoRow()] : []];
    }
    if (/FROM video_slug_aliases a/i.test(sql)) return [[]];
    if (/FROM contacts WHERE contact_id = \?/i.test(sql)) {
      return [[{ contact_id: params[0] }]];
    }
    // related-videos lookups (hand-picked + tag autofill) → none
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

describe('GET /v/:slug — rendered action buttons', () => {
  test('javascript: action is dropped; https action renders', async () => {
    setActions([
      { type: 'url', label: 'Evil', config: { url: 'javascript:alert(document.cookie)' } },
      { type: 'url', label: 'Book', config: { url: 'https://example.com/book' } },
    ]);
    const html = await (await fetch(`${base}/v/demo`)).text();
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('Evil');
    expect(html).toContain('href="https://example.com/book"');
    expect(html).toContain('Book');
  });

  test('control-char and case evasions never reach an href', async () => {
    setActions([
      { type: 'url', label: 'A', config: { url: 'JaVaScRiPt:alert(1)' } },
      { type: 'url', label: 'B', config: { url: 'java\tscript:alert(1)' } },
      { type: 'url', label: 'C', config: { url: '\u0000javascript:alert(1)' } },
      { type: 'url', label: 'D', config: { url: 'data:text/html,x' } },
      { type: 'url', label: 'E', config: { url: '//evil.example/x' } },
      { type: 'url', label: 'F', config: { url: '%6Aavascript:alert(1)' } },
    ]);
    const html = await (await fetch(`${base}/v/demo`)).text();
    // No action anchor at all — every candidate was dropped.
    expect(html).not.toContain('<a class="vid-btn');
    for (const frag of ['alert(1)', 'evil.example', 'data:text/html']) {
      expect(html).not.toContain(frag);
    }
  });

  test('root-relative, mailto and tel actions render; {{c}} substitutes', async () => {
    setActions([
      { type: 'url', label: 'Book', config: { url: '/book/consult?c={{c}}' } },
      { type: 'url', label: 'Call', config: { url: 'tel:+12484179800' } },
      { type: 'url', label: 'Email', config: { url: 'mailto:office@4lsg.com' } },
    ]);
    const html = await (await fetch(`${base}/v/demo?c=42`)).text();
    expect(html).toContain('href="/book/consult?c=42"');
    expect(html).toContain('href="tel:+12484179800"');
    expect(html).toContain('href="mailto:office@4lsg.com"');
  });

  test('{{c}} in a bad-scheme URL cannot rescue it', async () => {
    setActions([
      { type: 'url', label: 'X', config: { url: 'javascript:void({{c}})' } },
    ]);
    const html = await (await fetch(`${base}/v/demo?c=42`)).text();
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a class="vid-btn');
  });

  test('unknown action types are still skipped silently (existing contract)', async () => {
    setActions([
      { type: 'chatbot', label: 'Later', config: {} },
      { type: 'url', label: 'Ok', config: { url: 'https://example.com' } },
    ]);
    const html = await (await fetch(`${base}/v/demo`)).text();
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('Later');
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Write path — createVideo / updateVideo reject bad URLs
// ─────────────────────────────────────────────────────────────

describe('write-path validation', () => {
  const writeDb = { query: jest.fn(async () => [{ insertId: 1, affectedRows: 1 }]) };

  test('createVideo rejects a javascript: action with statusCode 400', async () => {
    await expect(videoService.createVideo(writeDb, {
      title: 'T', gcs_video_url: 'https://storage.example/v.mp4',
      actions: [{ type: 'url', label: 'x', config: { url: 'javascript:alert(1)' } }],
    })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('actions[0]') });
    expect(writeDb.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO videos/), expect.anything());
  });

  test('updateVideo rejects a data: action with statusCode 400', async () => {
    await expect(videoService.updateVideo(writeDb, 1, {
      actions: [{ type: 'url', label: 'x', config: { url: 'data:text/html,x' } }],
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('updateVideo accepts a {{c}} template on an allowed scheme', () => {
    expect(() => videoService.validateActions(
      [{ type: 'url', label: 'x', config: { url: 'https://4lsg.com/book/x?c={{c}}' } }]
    )).not.toThrow();
  });

  test('validateActions tolerates null/absent and non-url types', () => {
    expect(() => videoService.validateActions(null)).not.toThrow();
    expect(() => videoService.validateActions(undefined)).not.toThrow();
    expect(() => videoService.validateActions([{ type: 'chatbot', config: {} }])).not.toThrow();
  });

  test('validateActions rejects a non-array with 400', () => {
    expect(() => videoService.validateActions({ type: 'url' }))
      .toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
