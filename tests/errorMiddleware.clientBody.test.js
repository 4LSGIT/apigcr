/**
 * tests/errorMiddleware.clientBody.test.js
 *
 * lib/errorMiddleware.js — body-parser 4xx are answered in-house, quietly.
 *
 * WHY: Express's default handler console.errors the full stack of every
 * error it gets, 4xx included, and GCP Error Reporting turns every stack on
 * stderr into a "New error" page. 2026-11-05 a scanner POSTed brotli bodies
 * to /webhook and /api/webhook; body-parser 1.x has no br, threw a 415, and
 * IT got "UnsupportedMediaTypeError: unsupported content encoding "br"".
 *
 * WHAT IS LOCKED
 *   1. A body-parser 4xx (by err.type) never reaches the default handler:
 *      no console.error, a JSON {error} body with the parser's status.
 *   2. It leaves exactly ONE structured WARNING line naming what the stack
 *      never did — type, path, content-type/-encoding, UA, IP.
 *   3. That line holds no query string (tokens ride there on some routes)
 *      and no body text (a JSON parse error quotes the body; err.body is
 *      the whole raw body).
 *   4. Every OTHER 4xx still goes to the default handler, and the 5xx path
 *      (500 JSON + route_500 alert when unobserved) is unchanged.
 *   5. Answering a 415 before the body was read leaves the connection usable.
 *
 * The test app runs with env 'production' so the default handler LOGS the
 * way it does on Cloud Run (under NODE_ENV=test it is silent, and a test
 * of "nothing on stderr" would pass for the wrong reason).
 *
 * Run: npx jest tests/errorMiddleware.clientBody.test.js
 */

'use strict';

jest.mock('../lib/alerting', () => ({
  ...jest.requireActual('../lib/alerting'),
  alert: jest.fn(),
}));

const http = require('http');
const zlib = require('zlib');
const express = require('express');
const { alert } = require('../lib/alerting');
const makeErrorMiddleware = require('../lib/errorMiddleware');

let server;
let port;

beforeAll((done) => {
  const app = express();
  app.set('env', 'production');
  app.set('trust proxy', 1);
  app.use('/small', express.json({ limit: '20b' }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.post('/echo', (req, res) => res.json({ got: req.body }));
  app.post('/small/echo', (req, res) => res.json({ got: req.body }));
  app.post('/forbidden', (req, res, next) => {
    const e = new Error('nope');
    e.status = 403;
    next(e);
  });
  app.get('/boom', (req, res, next) => next(new Error('boom')));
  app.use(makeErrorMiddleware({}));
  server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
});

afterAll((done) => { server.close(done); });

let warnSpy;
let errorSpy;
beforeEach(() => {
  alert.mockClear();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

function send({ path, method = 'POST', headers = {}, body, agent }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, reused: r.reusedSocket }));
    });
    r.setTimeout(5000, () => r.destroy(new Error('request timed out')));
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

// Express's default handler logs through finalhandler's onerror, which is
// DEFERRED (setImmediate) — it can land after the client already has the
// response. Every "was anything logged" assertion waits this out first, or
// "nothing on stderr" would pass merely because the log hadn't happened yet.
const settle = () => new Promise((r) => setTimeout(r, 25));

const brJson = (obj) => zlib.brotliCompressSync(Buffer.from(JSON.stringify(obj)));

async function onlyWarnLine() {
  await settle();
  expect(warnSpy).toHaveBeenCalledTimes(1);
  const raw = warnSpy.mock.calls[0][0];
  expect(typeof raw).toBe('string');
  return { raw, entry: JSON.parse(raw) };
}

describe('body-parser 4xx are answered here, with one stackless log line', () => {
  test('brotli JSON body → 415 JSON, structured WARNING, nothing on stderr', async () => {
    const body = brJson({ a: 1 });
    const res = await send({
      path: '/webhook',
      headers: {
        'Content-Type': 'application/json',
        'Content-Encoding': 'br',
        'Content-Length': body.length,
        'User-Agent': 'scanner/1.0',
        'X-Forwarded-For': '45.138.12.25',
      },
      body,
    });

    expect(res.status).toBe(415);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({ error: 'unsupported content encoding "br"' });

    const { raw, entry } = await onlyWarnLine();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(raw).not.toMatch(/\n\s+at /); // no stack frames
    expect(entry.severity).toBe('WARNING');
    expect(entry.message).toBe('[client-body] 415 encoding.unsupported POST /webhook');
    expect(entry.clientBodyError).toEqual({
      status: 415,
      type: 'encoding.unsupported',
      method: 'POST',
      path: '/webhook',
      contentType: 'application/json',
      contentEncoding: 'br',
      contentLength: String(body.length),
      userAgent: 'scanner/1.0',
      ip: '45.138.12.25',
    });
    expect(alert).not.toHaveBeenCalled();
  });

  test('the log line drops the query string', async () => {
    const body = brJson({ a: 1 });
    await send({
      path: '/webhook?token=SECRETTOKEN123&x=1',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br', 'Content-Length': body.length },
      body,
    });
    const { raw, entry } = await onlyWarnLine();
    expect(entry.clientBodyError.path).toBe('/webhook');
    expect(raw).not.toContain('SECRETTOKEN123');
  });

  test('malformed JSON → 400 JSON; the log line holds no body text', async () => {
    const body = '{"ssn":"PRIVATEDATA123",';
    const res = await send({
      path: '/echo',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(typeof JSON.parse(res.body).error).toBe('string');

    const { raw, entry } = await onlyWarnLine();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(entry.clientBodyError.type).toBe('entity.parse.failed');
    expect(entry.clientBodyError.status).toBe(400);
    expect(raw).not.toContain('PRIVATEDATA123');
  });

  test('over the parser limit → 413 JSON', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(100) });
    const res = await send({
      path: '/small/echo',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'request entity too large' });
    expect((await onlyWarnLine()).entry.clientBodyError.type).toBe('entity.too.large');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('a well-formed body still parses (no false positives)', async () => {
    const body = JSON.stringify({ a: 1 });
    const res = await send({
      path: '/echo',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ got: { a: 1 } });
    await settle();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test('the connection stays usable after a 415 sent before the body was read', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const big = brJson({ padding: 'y'.repeat(200000) }); // > one socket chunk
      const first = await send({
        path: '/webhook',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br', 'Content-Length': big.length },
        body: big,
        agent,
      });
      expect(first.status).toBe(415);

      const body = JSON.stringify({ b: 2 });
      const second = await send({
        path: '/echo',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
        agent,
      });
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toEqual({ got: { b: 2 } });
    } finally {
      agent.destroy();
    }
  });
});

describe('everything else is unchanged', () => {
  test('a non-body 4xx still goes to the default handler', async () => {
    const res = await send({ path: '/forbidden', headers: { 'Content-Length': 0 } });
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/^text\/html/); // finalhandler's page
    await settle();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled(); // the default handler's own stack log
    expect(alert).not.toHaveBeenCalled();
  });

  test('a 5xx is still a JSON 500 plus a route_500 alert when unobserved', async () => {
    const res = await send({ path: '/boom', method: 'GET' });
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'internal error' });
    await settle();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1]).toMatchObject({ kind: 'route_500', source: 'app' });
  });
});
