// Casey v2 S3b-2 — lib/caseyRedact.js: bearer-shaped values never reach the
// model or the ledger. The rules under test: which KEYS count (the trailing
// word, any separator or camelCase; paging / sync cursors exempt), header maps
// and {name, value} pairs, arrays and numbers under a bearer key, the second
// pass that scrubs a redacted value — and the parts of "Bearer <x>" — from
// every other string (a token inside a URL), the count, what is left alone,
// and the worst case's cost (review B1: the scrub must be linear).
'use strict';

const { redact, isBearerKey, isHeaderMap, isSecretHeader, MIN, MAX_PATTERN, MAX_PATTERNS, MAX_PATTERN_CHARS, REDACTED, WITHHELD } = require('../lib/caseyRedact');

test('keys: the trailing word decides, whatever the separator or case; cursors and look-alikes survive', () => {
  for (const k of ['action_token', 'contact_token', 'refresh_token', 'token', 'clientSecret', 'client_secret', 'secret_key', 'secretKey', 'x-api-key', 'api_key', 'apiKey', 'apikey', 'access_key', 'accessKey', 'private_key', 'private-key',
    'authorization', 'Authorization', 'authorization_code', 'cookie', 'jwt', 'bearer', 'password', 'passwd', 'passcode', 'otp', 'refresh.token', 'TOKEN', 'X-Auth-Token',
    'sync_secret', 'previous_password', 'prev_api_key', 'next_secret', 'page_secret', 'resume_password', 'page_access_token']) {   // the cursor exemption is for `token` alone
    expect([k, isBearerKey(k)]).toEqual([k, true]);
  }
  for (const k of ['report_key', 'idempotency_key', 'key', 'case_key', 'hook_key', 'tokens', 'token_count', 'input_tokens', 'token_type', 'secrets', 'passwords', 'cookies', 'jwt_id', 'tokenizer', 'password_set', 'id', 'name', 'mytoken', 'fortunecookie',
    'nextPageToken', 'next_page_token', 'page_token', 'pageToken', 'sync_token', 'syncToken', 'continuation_token', 'cursor_token', 'next_token', 'prev_token', 'resume_token',   // a cursor is useless without the credential, and the model pages with it
    'session_id', 'upload_session_id', 'telephony_session_id']) {   // ordinary ids
    expect([k, isBearerKey(k)]).toEqual([k, false]);
  }
  for (const k of ['headers', 'Headers', 'set-cookie', 'Set-Cookie', 'set_cookie', 'request_headers', 'responseHeaders']) expect([k, isHeaderMap(k)]).toEqual([k, true]);
  for (const k of ['header', 'body', 'cookies']) expect([k, isHeaderMap(k)]).toEqual([k, false]);
});

test('values: strings and numbers under a bearer key are replaced whatever their length (an OTP too), arrays of them likewise; booleans / null / other keys untouched; only MIN+ strings join the scrub set; the input is not mutated', () => {
  const input = { ok: true, task_id: 1830, action_token: 'uUUZoVRSabcd', refresh_token: 'short', token_type: 'Bearer', input_tokens: 10, password: 'x'.repeat(MIN), secret: 'x'.repeat(MIN - 1), nested: { cookie: 'session=abcdef12', list: [{ jwt: 'eyJhbGciOiJIUzI1NiJ9.x' }, 5, 'plain'] }, nul: null, otp: 123456, flag_token: true, none_token: null, api_key: ['KEYONE12345', 'k2'] };
  const copy = JSON.parse(JSON.stringify(input));
  const r = redact(input);
  expect(r.value).toEqual({ ok: true, task_id: 1830, action_token: REDACTED, refresh_token: REDACTED, token_type: 'Bearer', input_tokens: 10, password: REDACTED, secret: REDACTED, nested: { cookie: REDACTED, list: [{ jwt: REDACTED }, 5, 'plain'] }, nul: null, otp: REDACTED, flag_token: true, none_token: null, api_key: [REDACTED, REDACTED] });
  expect(r.count).toBe(9);   // every blanked value counts: action_token, refresh_token, password, secret, cookie, jwt, otp, KEYONE12345, k2 — only the five MIN+ strings join the scrub set
  expect(input).toEqual(copy);
  expect(redact(null)).toEqual({ value: null, count: 0 });
  expect(redact('a string')).toEqual({ value: 'a string', count: 0 });
  expect(redact([1, { token: 'abcdefghij' }])).toEqual({ value: [1, { token: REDACTED }], count: 1 });
  // A short bearer never scrubs substrings elsewhere (it is not in the set) — but it counts as withheld.
  expect(redact({ pin_otp: 'abc', note: 'abcdef abc' })).toEqual({ value: { pin_otp: REDACTED, note: 'abcdef abc' }, count: 1 });
});

test('header maps: a credential-named header (key / auth / token / secret / cookie / signature) is a bearer and Content-Type / Accept stay; an array under one is blanked; every set-cookie is; a {name|key, value} pair INSIDE a header map follows the header rule and its name field is never read as a header; outside a header map a pair is data; a cursor keeps paging', () => {
  const r = redact({ items: [1], nextPageToken: 'CAESBgoBMgoBMQ', headers: { 'x-hook-key': ['hookkeyvalue1'], 'Ocp-Apim-Subscription-Key': 'subkeyvalue01', 'X-Signature': 'sigsigsigsig', 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'casey/1', Authorization: 'Bearer eyJhbGciOi.abc' }, note: 'the jwt eyJhbGciOi.abc appears here; application/json stays', 'set-cookie': ['sid=abcdefgh123', 'x=1'],
    request_headers: [{ name: 'Cookie', value: 'cookievalue12' }, { key: 'Authorization', value: 'Bearer zzzzzzzzzz' }, { name: 'Accept', value: 'text/plain' }],
    pairs: [{ name: 'Author', value: 'John Smith' }, { name: 'Debtor Signature Date', value: '2026-11-03' }, { name: 'X-Api-Key', value: 'not-a-header-here' }], contact: { name: 'John Smith', signed: '2026-11-03' } });
  expect(r.value).toEqual({ items: [1], nextPageToken: 'CAESBgoBMgoBMQ', headers: { 'x-hook-key': [REDACTED], 'Ocp-Apim-Subscription-Key': REDACTED, 'X-Signature': REDACTED, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'casey/1', Authorization: REDACTED }, note: `the jwt ${REDACTED} appears here; application/json stays`, 'set-cookie': [REDACTED, REDACTED],
    request_headers: [{ name: 'Cookie', value: REDACTED }, { key: 'Authorization', value: REDACTED }, { name: 'Accept', value: 'text/plain' }],
    pairs: [{ name: 'Author', value: 'John Smith' }, { name: 'Debtor Signature Date', value: '2026-11-03' }, { name: 'X-Api-Key', value: 'not-a-header-here' }], contact: { name: 'John Smith', signed: '2026-11-03' } });   // a form answer named "Signature" or "Author" is data, not a header (review S5)
  expect(r.count).toBe(8);   // the blanked values: hookkeyvalue1, subkeyvalue01, sigsigsigsig, Authorization, sid=…, x=1, cookievalue12, the zzz Authorization
  expect(isSecretHeader('Content-Type')).toBe(false); expect(isSecretHeader('X-Hook-Key')).toBe(true); expect(isSecretHeader('anything', 'set-cookie')).toBe(true);
});

test('the second pass: a redacted value is scrubbed wherever else it appears — a token inside a URL, HTML, a message, a sibling object; several occurrences; two tokens sharing a prefix, the longest wins; no bearer key → no scrub', () => {
  const tok = 'uUUZoVRSabcd';
  const r = redact({ task: { action_token: tok, action_url: `https://app.4lsg.com/t/${tok}`, html: `<a href="/t/${tok}">done</a> or /t/${tok}` }, message: `Created; link /t/${tok}`, other: 'untouched' });
  expect(r.count).toBe(1);
  expect(r.value).toEqual({ task: { action_token: REDACTED, action_url: `https://app.4lsg.com/t/${REDACTED}`, html: `<a href="/t/${REDACTED}">done</a> or /t/${REDACTED}` }, message: `Created; link /t/${REDACTED}`, other: 'untouched' });
  expect(redact({ action_url: `https://x/t/${tok}` })).toEqual({ value: { action_url: `https://x/t/${tok}` }, count: 0 });
  const p = redact({ a_token: 'ABCDEFGH1234', b_token: 'ABCDEFGH', text: 'ABCDEFGH1234 and ABCDEFGH and ABCDEFG' });
  expect(p.value.text).toBe(`${REDACTED} and ${REDACTED} and ABCDEFG`);
  // Overlaps are redacted as their UNION (review S2): T2 = the tail of T1 + T3; in T1T3 the longest match ending at
  // T2's end is T2 itself, which starts inside T1 — a leftmost-longest pick would skip it and let T3 through.
  const T1 = 'AAAAAAAAAA', T3 = 'CCCCCCCCCC', T2 = 'AAAAA' + T3;
  const o = redact({ t1_token: T1, t2_token: T2, t3_token: T3, text: `x${T1}${T3}x and ${T3} alone` });
  expect(o.value.text).toBe(`x${REDACTED}x and ${REDACTED} alone`);
  expect(o.value.text).not.toContain('CCCC');
});

test('cost (review B1 / B1\'): the scrub is Aho–Corasick — linear in the text whatever the values share; the shared-prefix body that took a prefix-bucket scan 7.6 s at the settle cap redacts in milliseconds; past MAX_PATTERNS the answer is withheld whole (fail closed); values over MAX_PATTERN are blanked but not searched for', () => {
  // The adversary's shape: thousands of bearers sharing their first MIN characters, and one long string of that prefix — ~230 KB, under the 256 KB settle cap.
  const adv = {}; for (let i = 0; i < 4000; i++) adv[`t${i}_token`] = `AAAAAAAA${String(i).padStart(4, '0')}`; adv.s = 'A'.repeat(120000); adv.hit = 'xx AAAAAAAA0042 yy';
  expect(JSON.stringify(adv).length).toBeLessThan(256 * 1024);
  let t0 = Date.now(); let r = redact(adv); let ms = Date.now() - t0;
  expect(ms).toBeLessThan(1000);   // measured 13 ms
  expect(r.count).toBe(4000);
  expect(r.value.s).toBe('A'.repeat(120000));   // no bearer is inside a run of A's alone (each needs its four digits)
  expect(r.value.hit).toBe(`xx ${REDACTED} yy`);
  // Many distinct bearers, all searched: linear too.
  const N = 3000; const big = {};
  for (let i = 0; i < N; i++) { big[`t${i}_token`] = `0000000${String(i).padStart(5, '0')}`; big[`s${i}`] = `text 000000000${i} and more words here`; }
  t0 = Date.now(); r = redact(big); ms = Date.now() - t0;
  expect(r.count).toBe(N);
  expect(ms).toBeLessThan(1000);
  expect(r.value.t7_token).toBe(REDACTED);
  expect(r.value.s7).toBe('text 0000000007 and more words here');               // s7's ten characters cannot hold t7's twelve-character bearer: untouched
  expect(r.value.s2345).toBe(`text ${REDACTED} and more words here`);            // s2345 holds 0000000002345: t234's bearer (000000000234) and t2345's (000000002345) overlap in it — the UNION is redacted, nothing of either stays
  // Past the ceiling: nothing of the answer is kept.
  const many = {}; for (let i = 0; i < MAX_PATTERNS + 1; i++) many[`t${i}_token`] = `0000000${String(i).padStart(5, '0')}`;
  r = redact(many);
  expect(r.value).toEqual(WITHHELD); expect(r.count).toBe(MAX_PATTERNS + 1);
  // A very long bearer: blanked in its field (and counted), not searched elsewhere (trie memory is what a pattern costs).
  const long = 'L'.repeat(MAX_PATTERN + 1);
  r = redact({ token: long, text: `has ${long} inside` });
  expect(r.value.token).toBe(REDACTED); expect(r.value.text).toBe(`has ${long} inside`); expect(r.count).toBe(1);
  // The total-character budget (review S1): 300 values of MAX_PATTERN characters are 600k characters of trie — withheld whole; 60 of them (123k) are searched for.
  const fat = {}; for (let i = 0; i < 300; i++) fat[`k${i}_token`] = String(i).padStart(4, '0') + 'F'.repeat(MAX_PATTERN - 4);
  expect(300 * MAX_PATTERN).toBeGreaterThan(MAX_PATTERN_CHARS);
  r = redact(fat); expect(r.value).toEqual(WITHHELD); expect(r.count).toBe(300);
  const fit = {}; for (let i = 0; i < 60; i++) fit[`k${i}_token`] = String(i).padStart(4, '0') + 'F'.repeat(MAX_PATTERN - 4); fit.text = 'see ' + fit.k7_token + ' here';
  expect(60 * MAX_PATTERN).toBeLessThan(MAX_PATTERN_CHARS);
  r = redact(fit); expect(r.value.text).toBe(`see ${REDACTED} here`); expect(r.count).toBe(60);
});
