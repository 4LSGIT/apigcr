// Quick smoke test for isTransientError.
// Mirrors the failure-mode table in the bug investigation.

// Inline copy of the classifier (kept in sync with services/campaignService.js)
function isTransientError(err) {
  if (!err) return false;
  const TRANSIENT_CODES = new Set([
    'ESOCKET', 'ETIMEDOUT', 'ETIME', 'ECONNRESET', 'ECONNREFUSED',
    'EHOSTUNREACH', 'ENETUNREACH', 'ECONNECTION', 'EAI_AGAIN', 'EPIPE'
  ]);
  const TRANSIENT_MYSQL_CODES = new Set([
    'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT',
    'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 'ER_QUERY_INTERRUPTED'
  ]);
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  if (err.code && TRANSIENT_MYSQL_CODES.has(err.code)) return true;
  if (typeof err.responseCode === 'number') {
    if (err.responseCode >= 400 && err.responseCode < 500) return true;
    if (err.responseCode >= 500 && err.responseCode < 600) return false;
  }
  const msg = (err.message || '').toLowerCase();
  if (/\b(etimedout|econnreset|econnrefused|ehostunreach|enotfound|timeout)\b/.test(msg)) return true;
  if (/\b429\b/.test(err.message || '') || /rate ?limit|too many requests/.test(msg)) return true;
  if (/\b(50\d|51\d|52\d|53\d|54\d|55\d|56\d|57\d|58\d|59\d)\b/.test(err.message || '')) {
    if (!/smtp/i.test(err.message || '')) return true;
  }
  return false;
}

// Test cases: [description, error, expectedTransient]
const cases = [
  // Node / network — should be transient
  ['ESOCKET nodemailer',          Object.assign(new Error('socket hangup'),  { code: 'ESOCKET' }),    true],
  ['ETIMEDOUT nodemailer',        Object.assign(new Error('timeout'),        { code: 'ETIMEDOUT' }),  true],
  ['ECONNRESET',                  Object.assign(new Error('reset'),          { code: 'ECONNRESET' }), true],
  ['DNS EAI_AGAIN',               Object.assign(new Error('dns'),            { code: 'EAI_AGAIN' }),  true],

  // mysql2 — should be transient
  ['MySQL connection lost',       Object.assign(new Error('lost conn'),  { code: 'PROTOCOL_CONNECTION_LOST' }), true],
  ['Deadlock',                    Object.assign(new Error('deadlock'),   { code: 'ER_LOCK_DEADLOCK' }),         true],

  // SMTP response codes — 4xx transient, 5xx permanent
  ['SMTP 421 service unavailable', Object.assign(new Error('421'),  { responseCode: 421 }),                    true],
  ['SMTP 451 try later',           Object.assign(new Error('451'),  { responseCode: 451 }),                    true],
  ['SMTP 550 hard bounce',         Object.assign(new Error('550'),  { responseCode: 550 }),                    false],
  ['SMTP 553 invalid recipient',   Object.assign(new Error('553'),  { responseCode: 553 }),                    false],

  // EAUTH (nodemailer auth failure) — has a code but not transient
  ['EAUTH bad credentials',        Object.assign(new Error('bad auth'), { code: 'EAUTH' }),                    false],

  // EENVELOPE — invalid recipient/sender — permanent
  ['EENVELOPE bad recipient',      Object.assign(new Error('bad envelope'), { code: 'EENVELOPE' }),            false],

  // Provider HTTP errors via plain Error(text) — best-effort message match
  ['Quo 503',          new Error('Quo API error 503: {"message":"server unavailable"}'),                       true],
  ['Quo 502',          new Error('Quo API error 502: bad gateway'),                                            true],
  ['Quo 429',          new Error('Quo API error 429: too many requests'),                                      true],
  ['Quo 400 invalid',  new Error('Quo API error 400: {"message":"invalid phoneNumber"}'),                      false],
  ['Quo 401 auth',     new Error('Quo API error 401: unauthorized'),                                           false],

  // RingCentral throws bare response text — usually no status. These will default to permanent.
  // Worth surfacing in the summary that RC won't get retried automatically until rcService preserves status.
  ['RC raw error text (no status)', new Error('{"errorCode":"InvalidParameter","message":"bad number"}'),      false],
  ['RC text with timeout word',     new Error('Request timeout while contacting RingCentral'),                  true],
  ['RC text with 503',              new Error('Upstream returned 503 Service Unavailable'),                     true],

  // Misc
  ['Generic Error no code', new Error('something went wrong'), false],
  ['Empty error',           new Error(''),                     false],
  ['Null',                  null,                              false],

  // Edge: SMTP 5xx mentioned in message text — should still be permanent
  ['SMTP 550 in message text', new Error('SMTP 550 5.1.1 user unknown'), false],
];

let pass = 0, fail = 0;
for (const [desc, err, expected] of cases) {
  const got = isTransientError(err);
  const ok  = got === expected;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? '✓' : '✗'}  ${desc}  → got=${got} expected=${expected}`);
}
console.log(`\n  ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);