/**
 * Tests for services/esignInlineImageService.js — the authoring-time
 * external-image inliner (2026-07-22 slice).
 *
 * NO network: fetch and dns.lookup are injected via the service's _test seam
 * (firmConfig precedent). What is under test is the GUARD STACK — this is an
 * authed fetch-me-this-URL endpoint, i.e. an SSRF surface, and every screen
 * (scheme, address ranges, redirects, content-type, per-image and per-batch
 * byte caps, timeout) is asserted to hold, plus the per-URL result contract
 * (one bad image never sinks the batch).
 *
 *   npx jest tests/esignInlineImages.test.js
 */

const svc = require('../services/esignInlineImageService');

// ─────────────────────────────────────────────────────────────
// injected network
// ─────────────────────────────────────────────────────────────

let fetchImpl;
let lookupImpl;

/** Minimal Response-like double. Body served via arrayBuffer (the service's
    documented fallback path — real fetch streams through getReader). */
function makeRes({ status = 200, contentType = 'image/png', body = Buffer.from('png-bytes'), contentLength } = {}) {
  const headers = {
    'content-type': contentType,
    ...(contentLength !== undefined ? { 'content-length': String(contentLength) } : {}),
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() in headers ? headers[k.toLowerCase()] : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

beforeEach(() => {
  fetchImpl  = jest.fn(async () => makeRes());
  lookupImpl = jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]); // public
  svc._test({ fetchImpl, lookupImpl });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────
// pure guards
// ─────────────────────────────────────────────────────────────

describe('validateImageUrl', () => {
  test('https urls pass', () => {
    expect(svc.validateImageUrl('https://example.com/logo.png')).toEqual({ ok: true });
  });
  test.each([
    ['http url',            'http://example.com/logo.png', 'https_only'],
    ['ftp url',             'ftp://example.com/logo.png',  'https_only'],
    ['data uri',            'data:image/png;base64,AAAA',  'https_only'],
    ['garbage',             'not a url',                   'not_a_url'],
    ['empty',               '',                            'not_a_url'],
    ['non-string',          42,                            'not_a_url'],
    ['credentials in url',  'https://user:pw@example.com/x.png', 'credentials_in_url'],
  ])('%s rejected (%s)', (_label, input, reason) => {
    expect(svc.validateImageUrl(input)).toEqual({ ok: false, reason });
  });
});

describe('isForbiddenIp — the address screen', () => {
  test.each([
    '0.0.0.1', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.9.9.9',
    '169.254.169.254',          // cloud metadata
    '172.16.0.1', '172.31.255.255', '192.168.1.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1',
    '::ffff:10.0.0.1', '::ffff:127.0.0.1', '[::1]',
  ])('%s is forbidden', (ip) => {
    expect(svc.isForbiddenIp(ip)).toBe(true);
  });

  test.each([
    '93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1',
    '2001:4860:4860::8888', '2606:2800:220:1::1', '::ffff:8.8.8.8',
  ])('%s is allowed', (ip) => {
    expect(svc.isForbiddenIp(ip)).toBe(false);
  });

  test('unparseable input is forbidden — deny by default', () => {
    expect(svc.isForbiddenIp('example.com')).toBe(true);
    expect(svc.isForbiddenIp('')).toBe(true);
    expect(svc.isForbiddenIp(null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// inlineImages — input contract
// ─────────────────────────────────────────────────────────────

describe('inlineImages input validation', () => {
  test.each([
    ['not an array', 'https://example.com/x.png'],
    ['empty array',  []],
    ['null',         null],
  ])('%s throws ESIGN_INLINE_BAD_INPUT', async (_label, input) => {
    await expect(svc.inlineImages(input)).rejects.toMatchObject({ code: 'ESIGN_INLINE_BAD_INPUT' });
  });

  test('more than MAX_URLS throws', async () => {
    const urls = Array.from({ length: svc.MAX_URLS + 1 }, (_, i) => `https://example.com/${i}.png`);
    await expect(svc.inlineImages(urls)).rejects.toMatchObject({ code: 'ESIGN_INLINE_BAD_INPUT' });
  });

  test('non-string entries throw', async () => {
    await expect(svc.inlineImages(['https://example.com/a.png', 42]))
      .rejects.toMatchObject({ code: 'ESIGN_INLINE_BAD_INPUT' });
  });
});

// ─────────────────────────────────────────────────────────────
// inlineImages — the guard stack, per-URL
// ─────────────────────────────────────────────────────────────

describe('inlineImages fetching', () => {
  const URL_A = 'https://example.com/logo.png';

  test('happy path: data URI built from the fetched bytes + content-type', async () => {
    const body = Buffer.from('real-image-bytes');
    fetchImpl.mockResolvedValue(makeRes({ contentType: 'image/jpeg', body }));

    const out = await svc.inlineImages([URL_A]);
    expect(out.images).toEqual([{
      url: URL_A, ok: true, content_type: 'image/jpeg',
      bytes: body.length,
      data_uri: `data:image/jpeg;base64,${body.toString('base64')}`,
    }]);
    expect(out.totalBytes).toBe(body.length);
    // hostname was screened before the fetch
    expect(lookupImpl).toHaveBeenCalledWith('example.com', { all: true });
  });

  test('a hostname resolving to ANY private address is refused BEFORE fetching', async () => {
    lookupImpl.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5',      family: 4 },   // one bad address poisons the set
    ]);
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'forbidden_address' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a literal private-IP hostname is refused without a DNS lookup', async () => {
    const out = await svc.inlineImages(['https://169.254.169.254/latest/meta-data']);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'forbidden_address' });
    expect(lookupImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('DNS failure → dns_failed, no fetch', async () => {
    lookupImpl.mockRejectedValue(new Error('ENOTFOUND'));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'dns_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('redirects are rejected, never followed', async () => {
    fetchImpl.mockResolvedValue(makeRes({ status: 302 }));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'redirect_not_followed' });
    // and the fetch was made with redirect:'manual'
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  test('http error status → http_<n>', async () => {
    fetchImpl.mockResolvedValue(makeRes({ status: 404 }));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'http_404' });
  });

  test('non-image content-type → not_an_image', async () => {
    fetchImpl.mockResolvedValue(makeRes({ contentType: 'text/html; charset=utf-8' }));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'not_an_image' });
  });

  test('a timeout abort reads as timeout', async () => {
    const e = new Error('aborted'); e.name = 'TimeoutError';
    fetchImpl.mockRejectedValue(e);
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'timeout' });
  });

  test('network failure reads as fetch_failed', async () => {
    fetchImpl.mockRejectedValue(new Error('ECONNRESET'));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'fetch_failed' });
  });

  test('a lying/absent content-length cannot beat the per-image cap', async () => {
    fetchImpl.mockResolvedValue(makeRes({ body: Buffer.alloc(svc.MAX_IMAGE_BYTES + 1) }));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'image_too_large' });
  });

  test('an honest oversize content-length fails fast without reading the body', async () => {
    const res = makeRes({ contentLength: svc.MAX_IMAGE_BYTES + 1 });
    const spy = jest.spyOn(res, 'arrayBuffer');
    fetchImpl.mockResolvedValue(res);
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'image_too_large' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('the batch budget: images past MAX_TOTAL_BYTES fail as total_budget_exceeded, earlier ones stand', async () => {
    // 5 × 1.9MB: the 5th would land at 9.5MB > 8MB.
    const chunk = Buffer.alloc(Math.floor(1.9 * 1024 * 1024));
    fetchImpl.mockImplementation(async () => makeRes({ body: chunk }));
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.png`);

    const out = await svc.inlineImages(urls);
    const oks = out.images.filter((im) => im.ok);
    expect(oks).toHaveLength(4);
    expect(out.images[4]).toMatchObject({ ok: false, error: 'total_budget_exceeded' });
    expect(out.totalBytes).toBe(chunk.length * 4);
  });

  test('one bad url never sinks the batch — per-URL results in input order', async () => {
    fetchImpl
      .mockResolvedValueOnce(makeRes())
      .mockResolvedValueOnce(makeRes({ contentType: 'text/plain' }));
    const out = await svc.inlineImages([
      'https://example.com/good.png',
      'http://example.com/wrong-scheme.png',   // fails shape, no fetch
      'https://example.com/not-image.txt',
    ]);
    expect(out.images.map((im) => [im.ok, im.error || null])).toEqual([
      [true, null],
      [false, 'https_only'],
      [false, 'not_an_image'],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('empty body → empty_body (a zero-byte data URI is never embedded)', async () => {
    fetchImpl.mockResolvedValue(makeRes({ body: Buffer.alloc(0) }));
    const out = await svc.inlineImages([URL_A]);
    expect(out.images[0]).toMatchObject({ ok: false, error: 'empty_body' });
  });
});
