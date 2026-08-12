// X2.1 — routes/f.js (the SMS-friendly external form link).
// Closes review test-gap 2: the route had no test at all. Live express app on
// an ephemeral port, redirects NOT followed, so the Location header is the
// assertion surface.
//
// Locks: form_key shape gate + generic 404, credential and staff-declared
// params forwarded verbatim, repeated params preserved IN ORDER (the urlParam
// contract is last-wins, so order is load-bearing), reserved renderer params
// stripped (N1), no-store, same-origin relative target (no open redirect).
'use strict';

const express = require('express');

describe('routes/f.js', () => {
  let server, base;

  beforeAll((done) => {
    const app = express();
    app.use(require('../routes/f.js'));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(done);
  });

  const hit = (p) => fetch(base + p, { redirect: 'manual' });
  const loc = async (p) => (await hit(p)).headers.get('location');

  test('redirects to the external renderer, forwarding the credential', async () => {
    const res = await hit('/f/intake_test?case_id=ABCD1234');
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location'))
      .toBe('/forms/render.html?form_key=intake_test&ext=1&case_id=ABCD1234');
  });

  test('target is a same-origin RELATIVE path — no open-redirect surface', async () => {
    for (const q of ['?case_id=x', '?case_id=//evil.test', '?next=https://evil.test']) {
      const l = await loc('/f/intake_test' + q);
      expect(l.startsWith('/forms/render.html?')).toBe(true);
      expect(l).not.toContain('//evil.test');
    }
  });

  test('staff-declared urlParams ride through; repeats keep their ORDER (last-wins depends on it)', async () => {
    const l = await loc('/f/intake_test?case_id=ABCD1234&src=facebook&src=web&promo=SUMMER');
    expect(l).toBe('/forms/render.html?form_key=intake_test&ext=1'
      + '&case_id=ABCD1234&src=facebook&src=web&promo=SUMMER');
  });

  test('N1: reserved renderer params are stripped, credential params are not', async () => {
    const l = await loc('/f/intake_test?case_id=ABCD1234&preview=1&template_id=3'
      + '&ext=0&form_key=other&contact_id=9&appt_id=4&src=x');
    expect(l).not.toContain('preview');
    expect(l).not.toContain('template_id');
    expect(l).not.toContain('other');            // the route owns form_key
    expect(l.match(/ext=/g)).toHaveLength(1);    // and ext — exactly one, ours
    expect(l).toContain('ext=1');
    expect(l).toContain('contact_id=9');         // credential params ride through
    expect(l).toContain('appt_id=4');
    expect(l).toContain('src=x');
  });

  test('values are re-encoded, not injected: a param cannot forge another', async () => {
    const l = await loc('/f/intake_test?case_id=' + encodeURIComponent('a&preview=1'));
    expect(l).toContain('case_id=a%26preview%3D1');
    expect(l).not.toContain('&preview=1');
  });

  test('malformed form_key → the same generic 404 the API uses, no redirect', async () => {
    for (const key of ['BAD-KEY', 'has%20space', 'UPPER', 'x'.repeat(51), 'dots.here']) {
      const res = await hit('/f/' + key);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ status: 'error', message: 'Not found' });
    }
  });

  test('does not confirm whether a well-formed form_key exists (no DB touch at all)', async () => {
    // Route holds no db reference: a real key and a fake one produce the same
    // redirect modulo the key itself. Existence/visibility/refusal are the
    // API's call one hop later, where they collapse to one generic 404.
    const real = await hit('/f/341_notes');
    const fake = await hit('/f/zz_not_a_real_form');
    expect(fake.status).toBe(real.status);
    expect(fake.headers.get('location').replace('zz_not_a_real_form', 'KEY'))
      .toBe(real.headers.get('location').replace('341_notes', 'KEY'));
  });

  test('nested-object query shapes are dropped rather than mangled', async () => {
    const l = await loc('/f/intake_test?case_id=A1&meta[x]=1');
    expect(l).toBe('/forms/render.html?form_key=intake_test&ext=1&case_id=A1');
  });
});