// tests/portalHome.test.js
//
// S5 (+ S5.1) — the home aggregate (routes/portal.home.js, exported _getHome):
//   • composition: getMe + renderCards, one payload (S5.1 dropped the case
//     list — the myCases engine card owns that navigation now)
//   • PROJECTION: exactly { name, cards } — nothing else leaks
//   • the engine is pinned CASE-LESS: renderCards receives caseId null,
//     placement 'home', and the authed contactId — the S5 contract
//   • a service throw propagates (the route turns it into its 500)
//
// The route is thin composition, so the collaborators are jest-mocked
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
jest.mock('../lib/portalCardEngine', () => ({
  renderCards: jest.fn(),
}));

const portalAuth = require('../services/portalAuthService');
const engine = require('../lib/portalCardEngine');
const home = require('../routes/portal.home');

const DB = { query: jest.fn() };   // never touched directly by the route

beforeEach(() => {
  jest.clearAllMocks();
  portalAuth.getMe.mockResolvedValue({ name: 'Rivka' });
  engine.renderCards.mockResolvedValue([
    { key: 'welcome', title: 'Welcome', body: 'Hi Rivka.', link: null,
      coded_key: null, placement: 'home' },
    { key: 'myCases', title: 'My Cases', body: null,
      link: { url: '/portal/cases.html', label: 'View your cases' },
      coded_key: null, placement: 'home' },
  ]);
});

describe('_getHome', () => {
  test('composes getMe + renderCards; projection is EXACTLY { name, cards } (S5.1 — no case list)', async () => {
    const out = await home._getHome(DB, 42);
    expect(Object.keys(out).sort()).toEqual(['cards', 'name']);
    expect(out.name).toBe('Rivka');
    expect(out.cards).toHaveLength(2);
    expect(out.cards.map(c => c.key)).toEqual(['welcome', 'myCases']);

    expect(portalAuth.getMe).toHaveBeenCalledWith(DB, 42);
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

  test('zero cards pass through as an empty array (a quiet greeting is fine)', async () => {
    engine.renderCards.mockResolvedValue([]);
    const out = await home._getHome(DB, 42);
    expect(out.cards).toEqual([]);
  });

  test('a service throw propagates to the route (its catch owns the 500)', async () => {
    portalAuth.getMe.mockRejectedValue(new Error('db down'));
    await expect(home._getHome(DB, 42)).rejects.toThrow('db down');
  });
});
