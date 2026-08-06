// tests/portalHome.test.js
//
// S5 — the home aggregate (routes/portal.home.js, exported _getHome):
//   • composition: getMe + listCases + renderCards, one payload
//   • PROJECTION: exactly { name, cases, cards } — nothing else leaks
//   • the engine is pinned CASE-LESS: renderCards receives caseId null,
//     placement 'home', and the authed contactId — the S5 contract
//   • a service throw propagates (the route turns it into its 500)
//
// The route is thin composition, so the three collaborators are jest-mocked
// and the test asserts the wiring — the engine's own case-less behavior is
// pinned in tests/portalCardEngine.home.test.js, and listCases/getMe in
// their own suites.
//
// Run:
//   npx jest tests/portalHome.test.js

'use strict';

jest.mock('../services/portalAuthService', () => ({
  getMe: jest.fn(),
}));
jest.mock('../services/portalCaseService', () => ({
  listCases: jest.fn(),
}));
jest.mock('../lib/portalCardEngine', () => ({
  renderCards: jest.fn(),
}));

const portalAuth = require('../services/portalAuthService');
const portalCases = require('../services/portalCaseService');
const engine = require('../lib/portalCardEngine');
const home = require('../routes/portal.home');

const DB = { query: jest.fn() };   // never touched directly by the route

beforeEach(() => {
  jest.clearAllMocks();
  portalAuth.getMe.mockResolvedValue({ name: 'Rivka' });
  portalCases.listCases.mockResolvedValue([
    { case_id: 'AbCdEf12', title: 'Chapter 7 Bankruptcy', docket: '24-40226-mlo',
      current_stage_label: 'Filed' },
  ]);
  engine.renderCards.mockResolvedValue([
    { key: 'welcome', title: 'Welcome', body: 'Hi Rivka.', link: null,
      coded_key: null, placement: 'home' },
  ]);
});

describe('_getHome', () => {
  test('composes the three services; projection is EXACTLY { name, cases, cards }', async () => {
    const out = await home._getHome(DB, 42);
    expect(Object.keys(out).sort()).toEqual(['cards', 'cases', 'name']);
    expect(out.name).toBe('Rivka');
    expect(out.cases).toHaveLength(1);
    expect(out.cases[0]).toMatchObject({ case_id: 'AbCdEf12' });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({ key: 'welcome', placement: 'home' });

    expect(portalAuth.getMe).toHaveBeenCalledWith(DB, 42);
    expect(portalCases.listCases).toHaveBeenCalledWith(DB, 42);
  });

  test('the engine pin is CASE-LESS: caseId null, placement home, the authed contact', async () => {
    await home._getHome(DB, 42);
    expect(engine.renderCards).toHaveBeenCalledTimes(1);
    expect(engine.renderCards).toHaveBeenCalledWith(DB, {
      caseId: null,
      contactId: 42,
      placement: 'home',
    });
  });

  test('zero cases / zero cards pass through as empty arrays (friendly state is the client)', async () => {
    portalCases.listCases.mockResolvedValue([]);
    engine.renderCards.mockResolvedValue([]);
    const out = await home._getHome(DB, 42);
    expect(out.cases).toEqual([]);
    expect(out.cards).toEqual([]);
  });

  test('a service throw propagates to the route (its catch owns the 500)', async () => {
    portalCases.listCases.mockRejectedValue(new Error('db down'));
    await expect(home._getHome(DB, 42)).rejects.toThrow('db down');
  });
});
