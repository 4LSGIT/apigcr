// tests/campaignCaseTypeFilter.test.js
//
/**
 * campaign.html's Case Type filter, end to end.
 *
 * Two bugs are pinned here.
 *
 *   1. The filter used to be a free-text <input> placeholdered "e.g. Chapter
 *      7" whose value was compared against cases.case_type. Since the 2026-06
 *      split "Chapter 7" lives in cases.case_subtype, so anyone who followed
 *      the placeholder got a SILENT zero-result search — the query was
 *      well-formed, it just could never match. No case_type 'Chapter 7'
 *      exists in production.
 *
 *   2. fe-case_types is the WRITER vocabulary. Every create dialog also
 *      offers an 'Other' free-text escape, so cases carry types the registry
 *      never listed ('potato hunting', 'support', 'Unknown' are live). A
 *      registry-only filter cannot see those rows, so the options are the
 *      registry MERGED WITH GET /api/campaigns/case-types.
 *
 * Covered: the shared populateCaseTypeFilter merge, the facet SQL and its
 * map shape, the service's type/subtype WHERE building, and campaign.html's
 * inline script booted in jsdom against a REAL scripts.js parent frame.
 *
 * Run:  npx jest tests/campaignCaseTypeFilter.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/campaign.html'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const svc = require('../services/campaignService');

/** The registry (fe-case_types) — what staff MAY create. */
const REGISTRY = { Bankruptcy: ['Chapter 7', 'Chapter 13'], Appeal: [], Other: [] };
/** What the cases table actually HOLDS — note the two types absent above. */
const FACETS   = { Bankruptcy: ['Chapter 7', 'Adversary Proceeding'], 'potato hunting': [], support: [] };

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));

/** A jsdom window with the real scripts.js loaded, standing in for the shell. */
function shellWindow(caseTypes = REGISTRY) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><select id="s"><option value="%">All</option></select></body></html>',
    { url: 'https://app.4lsg.com/index.html', runScripts: 'dangerously' });
  DOMS.push(dom);
  const w = dom.window;
  w.firmData = { settings: { case_types: caseTypes } };
  w.Swal = { mixin: () => ({ fire() {} }) };
  w.eval(SCRIPTS);
  return w;
}

/**
 * Boots campaign.html's inline script with a real scripts.js parent frame.
 * Quill is stubbed (the blot subclass runs at top level) and the boot IIFE is
 * stripped so init() never auto-fires.
 */
function boot({ caseTypes = REGISTRY, facets = FACETS, facetsFail = false } = {}) {
  const shell = shellWindow(caseTypes);

  const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  Object.defineProperty(w, 'parent', { value: shell, configurable: true });

  w.Quill = function () { return { on() {}, root: { innerHTML: '' } }; };
  w.Quill.import = () => class { static create() { return {}; } static value() { return {}; } };
  w.Quill.register = () => {};

  const calls = [];
  shell.apiSend = async (url, method) => {
    calls.push({ url, method });
    if (url === '/api/campaigns/case-types') {
      if (facetsFail) throw new Error('facets down');
      return { case_types: facets };
    }
    return { contacts: [], total: 0, excluded: 0 };
  };

  const m = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  const body = m[1].replace(/\(function waitForParent\(\)[\s\S]*$/, '');
  w.eval(body + '\n;window.__t = { fillCaseTypeFilter, loadCaseTypeFacets, searchContacts, clearFilters };');
  return { w, shell, calls };
}

const sel    = (w) => w.document.getElementById('f-case-type');
const labels = (s) => [...s.options].map((o) => o.textContent);
const searchQuery = (calls) => Object.fromEntries(new URL(
  calls.filter((c) => c.url.startsWith('/api/campaigns/contacts')).pop().url, 'https://x').searchParams);

// ───────────────────────────────────────────────────────────────────────────
describe('populateCaseTypeFilter — extraTypes merge', () => {
  test('no extraTypes behaves exactly as before', () => {
    const w = shellWindow();
    const s = w.document.getElementById('s');
    w.populateCaseTypeFilter(s);
    expect(labels(s)).toEqual(['All', 'Bankruptcy (all)', 'Bankruptcy: Chapter 7', 'Bankruptcy: Chapter 13', 'Appeal', 'Other']);
  });

  test('adds types the registry never listed, registry order first', () => {
    const w = shellWindow();
    const s = w.document.getElementById('s');
    w.populateCaseTypeFilter(s, FACETS);
    expect(labels(s)).toEqual([
      'All',
      'Bankruptcy (all)', 'Bankruptcy: Chapter 7', 'Bankruptcy: Chapter 13', 'Bankruptcy: Adversary Proceeding',
      'Appeal', 'Other', 'potato hunting', 'support',
    ]);
  });

  test('shared subtypes are not duplicated', () => {
    const w = shellWindow();
    const s = w.document.getElementById('s');
    w.populateCaseTypeFilter(s, FACETS);
    expect(labels(s).filter((l) => l === 'Bankruptcy: Chapter 7')).toHaveLength(1);
  });

  test('an empty-string key is ignored — "" is no-type-set, not a type', () => {
    const w = shellWindow();
    const s = w.document.getElementById('s');
    w.populateCaseTypeFilter(s, { '': [], '   ': [] });
    expect(labels(s)).toEqual(['All', 'Bankruptcy (all)', 'Bankruptcy: Chapter 7', 'Bankruptcy: Chapter 13', 'Appeal', 'Other']);
  });

  test('junk extraTypes is ignored rather than thrown on', () => {
    const w = shellWindow();
    const s = w.document.getElementById('s');
    for (const junk of [null, undefined, [], 'nope', 42]) {
      expect(() => w.populateCaseTypeFilter(s, junk)).not.toThrow();
    }
    expect(labels(s)).toHaveLength(6);
  });

  test('the registry stays the single source — merging does not mutate it', () => {
    const w = shellWindow();
    const s = w.document.getElementById('s');
    w.populateCaseTypeFilter(s, FACETS);
    expect(w.firmData.settings.case_types).toEqual(REGISTRY);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('campaign.html — Case Type filter', () => {
  test('is a select, not the old free-text input', () => {
    const { w } = boot();
    expect(sel(w).tagName).toBe('SELECT');
    expect(HTML).not.toMatch(/id="f-case-type"[^>]*placeholder/);
  });

  test('after init the options span registry AND live types', async () => {
    const { w } = boot();
    await w.__t.loadCaseTypeFacets();
    w.__t.fillCaseTypeFilter();
    expect(labels(sel(w))).toContain('potato hunting');   // registry never listed it
    expect(labels(sel(w))).toContain('Appeal');           // no cases, but configured
    expect(labels(sel(w))[0]).toBe('Any');
  });

  test('each option carries the right data-type / data-subtype', async () => {
    const { w } = boot();
    await w.__t.loadCaseTypeFacets();
    w.__t.fillCaseTypeFilter();
    const byLabel = Object.fromEntries([...sel(w).options].map((o) => [o.textContent, [o.dataset.type, o.dataset.subtype]]));
    expect(byLabel['Any']).toEqual([undefined, undefined]);              // no filter at all
    expect(byLabel['Bankruptcy (all)']).toEqual(['Bankruptcy', undefined]); // every subtype
    expect(byLabel['Bankruptcy: Chapter 7']).toEqual(['Bankruptcy', 'Chapter 7']);
    expect(byLabel['potato hunting']).toEqual(['potato hunting', undefined]);
  });

  test('a facet-fetch failure degrades to the registry, not to a broken filter', async () => {
    const { w } = boot({ facetsFail: true });
    jest.spyOn(w.console, 'warn').mockImplementation(() => {});
    await w.__t.loadCaseTypeFacets();
    w.__t.fillCaseTypeFilter();
    expect(labels(sel(w))).toContain('Bankruptcy (all)');
    expect(labels(sel(w))).not.toContain('potato hunting');
  });

  test('a missing shell helper degrades to "Any", it does not throw', () => {
    const { w, shell } = boot();
    delete shell.populateCaseTypeFilter;
    expect(() => w.__t.fillCaseTypeFilter()).not.toThrow();
    expect(labels(sel(w))).toEqual(['Any']);
  });

  test('re-populating is idempotent and keeps the current selection', async () => {
    const { w } = boot();
    await w.__t.loadCaseTypeFacets();
    w.__t.fillCaseTypeFilter();
    const n = labels(sel(w)).length;
    sel(w).value = 'Bankruptcy: Chapter 13';
    w.__t.fillCaseTypeFilter();
    expect(labels(sel(w))).toHaveLength(n);
    expect(sel(w).value).toBe('Bankruptcy: Chapter 13');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('campaign.html — searchContacts query string', () => {
  async function ready(opts) {
    const b = boot(opts);
    await b.w.__t.loadCaseTypeFacets();
    b.w.__t.fillCaseTypeFilter();
    return b;
  }

  test('Any sends neither case_type nor case_subtype', async () => {
    const { w, calls } = await ready();
    await w.__t.searchContacts();
    const q = searchQuery(calls);
    expect(q.case_type).toBeUndefined();
    expect(q.case_subtype).toBeUndefined();
    expect(q.channel).toBe('email');
  });

  test('"Type (all)" sends case_type only — every subtype matches', async () => {
    const { w, calls } = await ready();
    sel(w).value = 'Bankruptcy (all)';
    await w.__t.searchContacts();
    const q = searchQuery(calls);
    expect(q.case_type).toBe('Bankruptcy');
    expect(q.case_subtype).toBeUndefined();
  });

  test('"Type: Subtype" sends both — what the old input could never express', async () => {
    const { w, calls } = await ready();
    sel(w).value = 'Bankruptcy: Chapter 7';
    await w.__t.searchContacts();
    expect(searchQuery(calls)).toMatchObject({ case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
  });

  test('an unregistered live type is selectable and filters correctly', async () => {
    const { w, calls } = await ready();
    sel(w).value = 'potato hunting';
    await w.__t.searchContacts();
    const q = searchQuery(calls);
    expect(q.case_type).toBe('potato hunting');
    expect(q.case_subtype).toBeUndefined();
  });

  test('searchContacts re-populates, so a registry edit lands without a reload', async () => {
    const { w, shell, calls } = await ready();
    expect(labels(sel(w))).not.toContain('Traffic');
    shell.firmData.settings.case_types = { ...REGISTRY, Traffic: [] };
    await w.__t.searchContacts();
    expect(labels(sel(w))).toContain('Traffic');
    expect(labels(sel(w))).toContain('potato hunting');   // facets survive the re-populate
  });

  test('clearFilters resets the select to Any', async () => {
    const { w, calls } = await ready();
    sel(w).value = 'Bankruptcy: Chapter 7';
    w.__t.clearFilters();
    expect(sel(w).selectedIndex).toBe(0);
    await w.__t.searchContacts();
    expect(searchQuery(calls).case_type).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('campaignService.getFilteredContacts — type/subtype', () => {
  function stubDb(rows = []) {
    const seen = [];
    return { seen, query: async (sql, params) => { seen.push({ sql, params }); return [rows]; } };
  }
  const sqlOf = (db) => db.seen[0].sql.replace(/\s+/g, ' ').trim();

  test('no case filters → no case join, no bound params', async () => {
    const db = stubDb();
    await svc.getFilteredContacts(db, { channel: 'email' });
    expect(sqlOf(db)).not.toMatch(/JOIN case_relate/);
    expect(db.seen[0].params).toEqual([]);
  });

  test('case_type alone matches every subtype of that type', async () => {
    const db = stubDb();
    await svc.getFilteredContacts(db, { case_type: 'Bankruptcy' });
    expect(sqlOf(db)).toMatch(/JOIN case_relate/);
    expect(sqlOf(db)).toMatch(/cs\.case_type = \?/);
    expect(sqlOf(db)).not.toMatch(/cs\.case_subtype/);
    expect(db.seen[0].params).toEqual(['Bankruptcy']);
  });

  test('type + subtype are both applied, exact', async () => {
    const db = stubDb();
    await svc.getFilteredContacts(db, { case_type: 'Bankruptcy', case_subtype: 'Chapter 7' });
    expect(sqlOf(db)).toMatch(/cs\.case_type = \? AND cs\.case_subtype = \?/);
    expect(db.seen[0].params).toEqual(['Bankruptcy', 'Chapter 7']);
  });

  test('subtype alone still forces the case join', async () => {
    const db = stubDb();
    await svc.getFilteredContacts(db, { case_subtype: 'Chapter 13' });
    expect(sqlOf(db)).toMatch(/JOIN case_relate/);
    expect(sqlOf(db)).toMatch(/JOIN cases cs/);
    expect(db.seen[0].params).toEqual(['Chapter 13']);
  });

  test('subtype is EXACT, never LIKE — opaque values may contain %', async () => {
    const db = stubDb();
    await svc.getFilteredContacts(db, { case_subtype: '100%' });
    expect(sqlOf(db)).toMatch(/cs\.case_subtype = \?/);
    expect(sqlOf(db)).not.toMatch(/case_subtype LIKE/);
    expect(db.seen[0].params).toEqual(['100%']);
  });

  test('composes with tags and stage, params in clause order', async () => {
    const db = stubDb();
    await svc.getFilteredContacts(db, {
      tags: ['vip'], case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_stage: 'Filed',
    });
    expect(db.seen[0].params).toEqual(['vip', 'Bankruptcy', 'Chapter 7', 'Filed']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('campaignService.getCaseTypeFacets', () => {
  const stub = (rows) => ({ seen: [], query(sql) { this.seen.push(sql); return Promise.resolve([rows]); } });

  test('folds distinct pairs into fe-case_types shape', async () => {
    const map = await svc.getCaseTypeFacets(stub([
      { case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
      { case_type: 'Bankruptcy', case_subtype: 'Chapter 13' },
      { case_type: 'Bankruptcy', case_subtype: '' },
      { case_type: 'potato hunting', case_subtype: '' },
    ]));
    expect(map).toEqual({ Bankruptcy: ['Chapter 7', 'Chapter 13'], 'potato hunting': [] });
  });

  test('a NULL subtype is dropped, not rendered as a blank option', async () => {
    const map = await svc.getCaseTypeFacets(stub([{ case_type: 'Appeal', case_subtype: null }]));
    expect(map).toEqual({ Appeal: [] });
  });

  test('excludes empty case_type in SQL — "" is no-type-set, not a type', async () => {
    const db = stub([]);
    await svc.getCaseTypeFacets(db);
    const sql = db.seen[0].replace(/\s+/g, ' ');
    expect(sql).toMatch(/SELECT DISTINCT case_type, case_subtype/);
    expect(sql).toMatch(/case_type IS NOT NULL AND case_type <> ''/);
  });

  test('no rows → an empty map, never null', async () => {
    expect(await svc.getCaseTypeFacets(stub([]))).toEqual({});
  });
});
