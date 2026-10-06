/**
 * tests/likeEscapeSites.test.js
 *
 * User search text reaches LIKE literally: '%' and '_' are escaped (via
 * lib/escapeLike) at every service-level search site, so "50%_off" matches
 * that text rather than "50 anything off". Route-level sites use the same
 * helper and are not stubbed here.
 *
 * db stub records every bound param; COUNT queries get a total of 0.
 */
process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const caseService    = require('../services/caseService');
const contactService = require('../services/contactService');
const eventService   = require('../services/eventService');
const logService     = require('../services/logService');
const searchService  = require('../services/searchService');

function makeDb() {
  const params = [];
  return {
    params,
    query: async (sql, p = []) => {
      params.push(...p);
      if (/COUNT\(/i.test(sql)) return [[{ total: 0, cnt: 0, c: 0 }]];
      return [[]];
    },
  };
}

const RAW     = '50%_off';
const ESCAPED = '%50\\%\\_off%';

async function boundParams(fn) {
  const db = makeDb();
  await fn(db);
  return db.params;
}

describe.each([
  ['caseService.listCases',      db => caseService.listCases(db, { query: RAW })],
  ['caseService.searchCases',    db => caseService.searchCases(db, { q: RAW })],
  ['contactService.listContacts (name)', db => contactService.listContacts(db, { query: RAW })],
  ['contactService.listContacts (tags)', db => contactService.listContacts(db, { tags: RAW })],
  ['eventService.listEvents',    db => eventService.listEvents(db, { q: RAW })],
  ['logService.listLog',         db => logService.listLog(db, { q: RAW })],
])('%s', (_name, run) => {
  test('binds the escaped pattern, never the raw wildcard one', async () => {
    const params = await boundParams(run);
    expect(params).toContain(ESCAPED);
    expect(params).not.toContain(`%${RAW}%`);
  });
});

test('contactService.listContacts (email) escapes too', async () => {
  const params = await boundParams(db => contactService.listContacts(db, { query: 'a_b@x.com' }));
  expect(params).toContain('%a\\_b@x.com%');
});

test('searchService name tier escapes each word but keeps the % between them', async () => {
  const params = await boundParams(db => searchService.search(db, { q: 'jo_n sm%th', type: 'contact', limit: 5 }));
  expect(params).toContain('%jo\\_n%sm\\%th%');
});
