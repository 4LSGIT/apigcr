/**
 * tests/caseCaption.adopt.test.js
 *
 * POST /api/court-review/adopt-rerun stamps a caption by the same rules as the
 * court executor. The route runs for real; the db, the write and the re-run
 * are stubbed, because the thing under test is which fields it hands over.
 *
 *   npx jest tests/caseCaption.adopt.test.js
 */

'use strict';

const http = require('http');
const express = require('express');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());
jest.mock('../services/courtRerun', () => ({
  rerunCalRow: jest.fn(async () => ({ status: 'reran' })),
}));

const caseService = require('../services/caseService');
const router = require('../routes/courtReview');

let server;
let base;
let queued;
let target;
let updateCase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.db = {
      query: async (sql) => {
        if (/FROM court_ai_log/i.test(sql)) return [[queued]];
        if (/FROM cases WHERE case_id = \?/i.test(sql.replace(/\s+/g, ' '))) return [[target]];
        return [[]];
      },
    };
    req.auth = { type: 'jwt', userId: '6' };
    next();
  });
  app.use(router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  jest.spyOn(caseService, 'checkCaseNumberCollision').mockResolvedValue(null);
  updateCase = jest.spyOn(caseService, 'updateCase').mockResolvedValue({});
  queued = { id: 7, case_number: '26-49875-lsg', case_name: 'Jane Quincy Smith' };
  target = { case_id: 'CASEAAAA', case_number: '', case_number_full: '', case_type: 'Bankruptcy',
    case_subtype: 'Chapter 7', case_caption: null };
});

afterEach(() => jest.restoreAllMocks());

function adopt() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ court_ai_log_id: 7, case_id: 'CASEAAAA' });
    const req = http.request(`${base}/api/court-review/adopt-rerun`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const written = () => updateCase.mock.calls[0][2];

test('a docket over 20 characters is refused 400 before any write (the column would cut it silently; 2026-11-09)', async () => {
  queued.case_number = '26-49875-' + 'x'.repeat(16);
  expect(await adopt()).toBe(400);
  expect(updateCase).not.toHaveBeenCalled();
});

test('a bankruptcy case gets the court\'s name with "In re"', async () => {
  expect(await adopt()).toBe(200);
  expect(written().case_caption).toBe('In re Jane Quincy Smith');
});

test('an adversary keeps the court\'s text', async () => {
  target.case_subtype = 'Adversary Proceeding';
  queued.case_name = 'Cohen v. Boren';
  await adopt();
  expect(written().case_caption).toBe('Cohen v. Boren');
});

test('an existing caption is left alone', async () => {
  target.case_caption = 'In re Jane Smith';
  await adopt();
  expect(written()).not.toHaveProperty('case_caption');
});

test('a "v." name stays off a main bankruptcy case', async () => {
  queued.case_name = 'Cohen v. Boren';
  await adopt();
  expect(written()).not.toHaveProperty('case_caption');
});
