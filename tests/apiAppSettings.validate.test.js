/**
 * Tests for routes/api.appSettings.js — validateByType.
 *
 * The contract: validation is PERMISSIVE, runs on a trimmed working copy,
 * NEVER mutates, and blank always passes (blank = unset must never be
 * un-blankable). string / template / NULL / unknown types are verbatim.
 * public/settings.html mirrors these rules client-side — if a rule changes
 * here, change it there too.
 *
 * Run:
 *   npx jest tests/apiAppSettings.validate.test.js
 */

const { validateByType } = require('../routes/api.appSettings');

const ok = (t, v) => expect(validateByType(t, v)).toBe(true);
const no = (t, v) => expect(typeof validateByType(t, v)).toBe('string');

test('blank always passes, every type', () => {
  for (const t of ['number', 'bool', 'email', 'csv', 'phone', 'url', 'json', 'json_array', 'date', 'string', 'template', null]) {
    ok(t, '');
    ok(t, '   ');
  }
});

test('string / template / NULL / unknown types are verbatim (no checks)', () => {
  ok('string', 'anything at all }{ \n whatsoever ');
  ok('template', 'Hi {{name}},\nyour appt moved');
  ok(null, '{not json');
  ok('made_up_type', 'whatever');
});

test('number', () => {
  ok('number', '120'); ok('number', '-3'); ok('number', '2.5'); ok('number', ' 42 ');
  no('number', '12x'); no('number', '1,000'); no('number', 'abc');
});

test('bool', () => {
  ok('bool', '1'); ok('bool', '0'); ok('bool', ' 1 ');
  no('bool', 'true'); no('bool', 'yes'); no('bool', '2');
});

test('email', () => {
  ok('email', 'it@4lsg.com'); ok('email', ' office@4lsg.com ');
  no('email', 'it@4lsg'); no('email', 'not an email'); no('email', 'a@b@c.com d@e.com');
});

test('csv — loose entries, no empties', () => {
  ok('csv', '@4lsg.com,@metrodetroitbankruptcylaw.com');
  ok('csv', 'a@x.com, b@y.com');
  ok('csv', 'single');
  no('csv', 'a,,b');
  no('csv', 'a,');
});

test('phone — loose chars, needs 7+ digits', () => {
  ok('phone', '2484179800');
  ok('phone', '(248) 417-9800');
  ok('phone', '+1 248.417.9800');
  no('phone', '248'); // too few digits
  no('phone', 'call me');
});

test('url — http(s) with scheme required', () => {
  ok('url', 'https://app.4lsg.com');
  ok('url', 'http://localhost:8080/x');
  no('url', 'app.4lsg.com');
  no('url', 'ftp://x.com');
});

test('json / json_array', () => {
  ok('json', '{"a":1}');
  ok('json', '[1,2]'); // json accepts any valid JSON
  no('json', '{bad');
  ok('json_array', '[{"name":"x"}]');
  no('json_array', '{"a":1}'); // valid JSON but not an array
  no('json_array', '[broken');
});

test('date — min_client_build semantics', () => {
  ok('date', '2026-07-12');
  ok('date', '2026-07-12T14:30:00Z');
  ok('date', '1783819613800');  // epoch ms
  ok('date', '1783819613');     // epoch s
  ok('date', 'off'); ok('date', '0'); ok('date', 'none');
  no('date', 'someday');
  // '12345' parses as year 12345 via Date.parse — accepted here because
  // appBuild.parseMinBuild accepts it identically. Validator mirrors prod.
  ok('date', '12345');
});

test('validation never mutates — it only judges', () => {
  // there is no output value to assert on; the contract is structural:
  // validateByType returns true|string and the route stores req value as-is.
  expect(validateByType('email', '  it@4lsg.com  ')).toBe(true);
});