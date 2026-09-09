// tests/trusteesRoute.test.js
//
// GET /api/trustees — the trustee roster endpoint (list / chapter / search /
// match). Slice 7: the roster is built from contacts + contact_roles by
// lib/trusteeRoster (mocked at that boundary here — the builder's own SQL is
// covered in tests/trusteeRoster.test.js); the route still reuses
// lib/trusteeMatch so its chapter eligibility cannot drift from rule 0.
//
// ROSTER below is a trimmed snapshot of the LIVE roster, kept inline in the
// style of tests/validateCaseTrustee.test.js. It preserves the two shapes
// that actually bite:
//   · the McDonald collision — same lname, case_type 12 vs 13 (post-cutover
//     both entries carry the SAME merged contact name; the 12/13 name split
//     is kept here because the matcher must handle either roster era)
//   · case_type shipped as a NUMBER (the live roster does this; the
//     eligibility compare stringifies both sides because of it)

// supertest is not a dependency — express in-process over a real ephemeral
// socket, the idiom from tests/caseEventService.test.js.
const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { userId: 6 }; next(); }));
jest.mock('../lib/trusteeRoster', () => ({
  loadTrusteeRoster: jest.fn(),
}));
const { loadTrusteeRoster } = require('../lib/trusteeRoster');

const ROSTER = [
  { name: 'Basil T. Simon',         lname: 'Simon',     case_type: 7,  link: 'https://z/simon', contact_id: 2066 },
  { name: 'Michael A. Stevenson',   lname: 'Stevenson', case_type: 7,  link: 'https://z/stev',  contact_id: 2075 },
  { name: 'Stuart A. Gold',         lname: 'Gold',      case_type: 7,  link: 'https://z/gold',  contact_id: 2078 },
  { name: 'Thomas W. McDonald',     lname: 'McDonald',  case_type: 12, link: 'https://z/mcd',   contact_id: 2082 },
  { name: 'Thomas W. Jr. McDonald', lname: 'McDonald',  case_type: 13, link: 'https://z/mcd',   contact_id: 2082 },
  { name: 'Krispen S. Carroll',     lname: 'Carroll',   case_type: 13, link: 'https://z/carr',  contact_id: 2085 },
];

/** Mounts the router; the trusteeRoster boundary serves `roster` (an array),
 *  or REJECTS when given an Error (the builder's query-failure contract). */
function app(roster) {
  if (roster instanceof Error) loadTrusteeRoster.mockRejectedValue(roster);
  else loadTrusteeRoster.mockResolvedValue(roster);
  const a = express();
  a.use((req, _res, next) => { req.db = { query: async () => [[]] }; next(); });
  a.use(require('../routes/api.users.js'));
  return a;
}
const live = () => app(ROSTER);

/** GET over a real ephemeral socket → { status, body }. */
function get(a, urlPath) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const port = server.address().port;
      http.get({ port, path: urlPath }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}') });
        });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

describe('GET /api/trustees — list modes', () => {
  test('bare call returns the whole roster, name-sorted, with the link field', async () => {
    const r = await get(live(), '/api/trustees');
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('list');
    expect(r.body.roster_status).toBe('ok');
    expect(r.body.count).toBe(6);

    const names = r.body.trustees.map((t) => t.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    );
    // `link` is the reason this reads the roster and not the table — the
    // table route's SELECT never exposed it.
    expect(r.body.trustees[0]).toHaveProperty('link');
  });

  test('chapter filter applies match rule 0, including the McDonald split', async () => {
    const c13 = (await get(live(), '/api/trustees?chapter=13')).body;
    expect(c13.count).toBe(2);
    const names = c13.trustees.map((t) => t.name);
    expect(names).toContain('Thomas W. Jr. McDonald');
    expect(names).not.toContain('Thomas W. McDonald');   // case_type 12
  });

  test('an entry with no case_type stays eligible for every chapter', async () => {
    const r = (await get(app([
      { name: 'Any Chapter Trustee', lname: 'Trustee', link: 'x' },
    ]), '/api/trustees?chapter=13')).body;
    expect(r.count).toBe(1);
  });

  test('q is a substring typeahead over name and lname, and composes with chapter', async () => {
    const all = (await get(live(), '/api/trustees?q=mcdonald')).body;
    expect(all.mode).toBe('search');
    expect(all.count).toBe(2);

    const scoped = (await get(live(), '/api/trustees?q=mcdonald&chapter=13')).body;
    expect(scoped.count).toBe(1);
    expect(scoped.trustees[0].case_type).toBe(13);
  });
});

describe('GET /api/trustees — match mode', () => {
  test('canonicalizes a surname-only value via the lname pass', async () => {
    const r = (await get(live(), '/api/trustees?match=stevenson')).body;
    expect(r.status).toBe('success');                    // envelope
    expect(r.mode).toBe('match');
    expect(r.result.status).toBe('matched');             // verdict
    expect(r.result.method).toBe('lname');
    expect(r.result.canonical).toBe('Michael A. Stevenson');
  });

  test('the verdict never overwrites the envelope status', async () => {
    // Regression: spreading matchTrustee's result onto the envelope made
    // every match read as a transport failure to `status === 'success'`.
    for (const qs of ['match=mcdonald', 'match=Nobody+At+All', 'match=stevenson']) {
      const r = await get(live(), `/api/trustees?${qs}`);
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('success');
    }
  });

  test('surfaces ambiguity instead of guessing, and chapter resolves it', async () => {
    const amb = (await get(live(), '/api/trustees?match=mcdonald')).body;
    expect(amb.result.status).toBe('ambiguous');
    expect(amb.result.candidates).toHaveLength(2);
    expect(amb.result.entry).toBeNull();
    expect(amb.result.canonical).toBeNull();

    const ch13 = (await get(live(), '/api/trustees?match=mcdonald&chapter=13')).body;
    expect(ch13.result.status).toBe('matched');
    expect(ch13.result.entry.case_type).toBe(13);
  });

  test('reports chapter_mismatch rather than a bare miss', async () => {
    const r = (await get(live(),
      `/api/trustees?match=${encodeURIComponent('Thomas W. McDonald')}&chapter=7`)).body;
    expect(r.result.status).toBe('chapter_mismatch');
    expect(r.result.candidates.length).toBeGreaterThan(0);
  });

  test('unknown name is no_match, not an error', async () => {
    const r = (await get(live(), '/api/trustees?match=Nobody+At+All')).body;
    expect(r.result.status).toBe('no_match');
    expect(r.result.candidates).toEqual([]);
  });

  test('candidates is always an array so callers need no guard', async () => {
    const r = (await get(live(), '/api/trustees?match=stevenson')).body;
    expect(Array.isArray(r.result.candidates)).toBe(true);
  });
});

describe('GET /api/trustees — roster failure modes (slice 7 builder contract)', () => {
  let err;
  beforeAll(() => { err = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterAll(() => err.mockRestore());

  test('empty roster (no active trustee roles) → empty list, still 200, roster_status ok; match says no_roster', async () => {
    const l = await get(app([]), '/api/trustees');
    expect(l.status).toBe(200);
    expect(l.body.roster_status).toBe('ok');
    expect(l.body.count).toBe(0);

    const m = (await get(app([]), '/api/trustees?match=Simon')).body;
    expect(m.result.status).toBe('no_roster');
  });

  test('builder query failure → 500 (same surface as a failed app_settings read pre-slice)', async () => {
    const r = await get(app(new Error('pool exhausted')), '/api/trustees');
    expect(r.status).toBe(500);
    expect(r.body.status).toBe('error');
  });

  test('half-typed roster rows are dropped, matching what the matcher sees', async () => {
    const r = (await get(app([
      { name: 'Real Person', lname: 'Person', case_type: 7 },
      { name: '   ' }, null, 'garbage', { lname: 'NoName' },
    ]), '/api/trustees')).body;
    expect(r.count).toBe(1);
    expect(r.trustees[0].name).toBe('Real Person');
  });
});
