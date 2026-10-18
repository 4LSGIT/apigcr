// tests/configListsTab.test.js
//
/**
 * Settings arc (W7) — Config → Lists (public/caseconfig/lists.html), a
 * VOCABULARY tab, run for REAL in jsdom: the page's own markup and whole
 * inline script, the REAL public/js/ycSettingRows.js inlined where the page
 * loads it, and a parent window playing the Config shell's part (apiSend,
 * setTopbarButtons, firmData, the configCanEdit getter, and — as the top
 * window — loadFirmData) whose apiSend is tests/helpers/settingsApiFake.js:
 * the settings API contract with metadata / validation from the REAL
 * lib/settingsRegistry.js. The handshake tests run the REAL Config shell
 * (public/caseConfigManager.html) in the middle frame.
 *
 * Locks: ONE GET /api/app-settings?home=config per load; the 'lists' section's
 * rows only (fe-case_types never drawn — a pointer line); the §3b read-only
 * handshake exactly like the four vocabulary sub-pages (read-only at init for
 * every answer but true, onAccess both ways, no write control drawn, the
 * api() gate refusing every non-GET, THE SWEEP: every rendered control
 * driven → no write reaches apiSend; the same drive editable does write);
 * the event-types editor (settings.html's, ported: add, rename — the Save
 * asks —, reorder, remove — asks first —, duplicates / empty names refused
 * before any PUT, the warning and the Calendar Types note, verbatim values);
 * the lead-source list (suggestions-only note); loadFirmData once after an
 * fe-* save; the 403 session message; the dirty guards.
 *
 * configReadOnly.test.js sweeps the four older vocabulary pages; lists.html
 * is swept here (that file's harness has no settings rows / ycSettingRows).
 *
 * Mutation-checked (see the W7 worker report).
 *
 * Run:  npx jest tests/configListsTab.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const reg = require('../lib/settingsRegistry');
const { makeSettingsApi, apiError } = require('./helpers/settingsApiFake');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LISTS_HTML = read('public/caseconfig/lists.html');
const CCM_HTML = read('public/caseConfigManager.html');
const ROWS_SRC = read('public/js/ycSettingRows.js');
const ROWS_TAG = '<script src="/js/ycSettingRows.js"></script>';
const strip = (html) => html.replace(ROWS_TAG, () => `<script>${ROWS_SRC}</script>`)
  .replace(/<script src=[^>]*><\/script>/g, '').replace(/<link [^>]*>/g, '');
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const SESSION_MSG = 'Your session predates a permissions change — sign out and back in.';
const RO_MSG = 'Read-only — changing YisraCase Config needs the admin permission.';
// Stored as a person typed them in the DB console — not JSON.stringify's
// spacing — so "untouched hands back the stored string byte for byte" shows.
const ET = '["Confirmation Hearing", "Docs Deadline",  "Hearing"]';
const LS = '["Google",  "Referral"]';
const VALUES = { 'fe-event_types': ET, 'fe-lead_sources': LS, 'fe-case_types': '{"Bankruptcy":["Chapter 7"]}' };
const isWrite = (c) => !/^(GET|HEAD)$/i.test(c.method || 'GET');

/** The page in a frame under a parent playing the Config shell. canEdit is
 *  what P.configCanEdit answers (change t.access.canEdit to model it). */
async function boot(opts = {}) {
  const { values = VALUES, caps = { firm: true, system: false }, wrap } = opts;
  const canEdit = Object.prototype.hasOwnProperty.call(opts, 'canEdit') ? opts.canEdit : true;   // undefined is an answer too
  const fake = makeSettingsApi({ values, caps });
  const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() }).window;
  const access = { canEdit };
  let topbar = {};
  let firmLoads = 0;
  top.apiSend = wrap ? wrap(fake.api) : fake.api;
  top.setTopbarButtons = (b) => { topbar = { ...topbar, ...b }; };
  top.firmData = { users: [] };
  top.loadFirmData = () => { firmLoads++; return Promise.resolve(); };
  Object.defineProperty(top, 'configCanEdit', { get: () => access.canEdit, configurable: true });
  const f = top.document.createElement('iframe');
  top.document.body.appendChild(f);
  await flush(5);
  const w = f.contentWindow;
  w.document.open(); w.document.write(strip(LISTS_HTML)); w.document.close();
  await flush();
  return harness(w, { top, fake, access, topbar: () => topbar, firmLoads: () => firmLoads });
}

function harness(w, extra) {
  const $ = (sel) => w.document.querySelector(sel);
  const $$ = (sel) => [...w.document.querySelectorAll(sel)];
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  const fake = extra.fake;
  const asked = [];
  const t = {
    ...extra, w, $, $$, fire, click, asked,
    L: w.ListsPage,
    row: (k) => $(`.ycsr-row[data-key="${k}"]`),
    status: (k) => $(`.ycsr-row[data-key="${k}"] .ycsr-status`).textContent,
    et: () => $$('.ycsr-row[data-key="fe-event_types"] [data-et]'),
    etVals: () => $$('.ycsr-row[data-key="fe-event_types"] [data-et]').map((i) => i.value),
    ls: () => $$('.ycsr-row[data-key="fe-lead_sources"] [data-ycsr-entry]'),
    setVal: (el, v) => { el.value = v; fire(el, el.tagName === 'SELECT' ? 'change' : 'input'); },
    /** window.confirm answers `yes` and records the question. */
    answer: (yes) => { w.confirm = (m) => { asked.push(m); return yes; }; },
    gets: () => fake.st.calls.filter((c) => c.method === 'GET' && c.endpoint.startsWith('/api/app-settings')).map((c) => c.endpoint),
    writes: () => fake.st.calls.filter(isWrite).map((c) => [`${c.method} ${c.endpoint}`, c.payload && c.payload.value]),
    save: async () => { await w.onSave(); await flush(); },
    banner: () => ($('#ls-banner').hidden ? null : $('#ls-banner').textContent),
    controls: () => $$('#ls-rows input, #ls-rows select, #ls-rows textarea, #ls-rows button'),
  };
  return t;
}

// ─────────────────────────────────────────────────────────────────────────
describe('the page: one GET, the lists section only', () => {
  test('one GET (home=config); the lists section\'s rows in registry order; fe-case_types served but never drawn — a pointer line instead', async () => {
    const t = await boot();
    expect(t.gets()).toEqual(['/api/app-settings?home=config']);
    const listKeys = Object.keys(reg.SETTINGS).filter((k) => reg.SETTINGS[k].home === 'config' && reg.SETTINGS[k].section === 'lists')
      .sort((a, b) => reg.SETTINGS[a].sort - reg.SETTINGS[b].sort);
    expect(listKeys).toEqual(['fe-lead_sources', 'fe-event_types']);
    expect(t.$$('.ycsr-row').map((r) => r.dataset.key)).toEqual(listKeys);
    expect(t.fake.served().map((r) => r.key)).toContain('fe-case_types');           // it was there to draw, and was not
    expect([t.row('fe-case_types'), t.$('#ls-rows').textContent.includes('Chapter 7')]).toEqual([null, false]);
    expect(t.$('#ls-pointer').textContent.replace(/\s+/g, ' ')).toBe('Case types are not edited here: they are in the Types & Subtypes tab, which checks usage and repoints pipeline templates.');
    expect(t.row('fe-lead_sources').querySelector('.ycsr-desc').textContent).toMatch(/Suggestions only — the field accepts free text\./);
    expect(t.$('.ls-intro').textContent.replace(/\s+/g, ' ')).toMatch(/suggestions only: the field still accepts free text/);
    expect([t.L.Page.dirty(), t.topbar(), t.$('#ls-status').textContent]).toEqual([false, { refresh: true, save: false }, 'All changes saved']);
  });

  test('the source idiom (the four vocabulary pages\'): body starts read-only; .cc-w hidden by it; api() is the one write gate; init reads P.configCanEdit; onAccess exposed; the rows module loaded by its tag', () => {
    const src = LISTS_HTML;
    expect(src).toMatch(/<body class="cc-ro">/);
    expect(src).toMatch(/body\.cc-ro \.cc-w \{ display: none; \}/);
    expect(src.match(/const api = /g)).toHaveLength(1);
    expect(src.match(/P\.apiSend\(/g)).toHaveLength(1);
    expect(src).toMatch(/ccApplyAccess\(P\.configCanEdit\);/);
    expect(src).toMatch(/window\.onAccess = onAccess;/);
    expect(src.split(ROWS_TAG)).toHaveLength(2);
    expect(src).not.toMatch(/href="[^"]*style\.css"/);
    expect(src).not.toMatch(/\son[a-z]+="/);                                         // no inline handlers at all
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the read-only handshake (settings arc §3b)', () => {
  const readOnly = (t) => {
    expect(t.$('body').classList.contains('cc-ro')).toBe(true);
    expect(t.controls().map((c) => c.outerHTML)).toEqual([]);                      // nothing that writes is drawn
    expect(t.$$('.ycsr-row .ycsr-ro').map((e) => e.textContent)).toEqual([LS, ET]);  // the values as text
    expect(t.$$('.ycsr-posture').map((e) => e.textContent)).toEqual(Array(2).fill('Read-only — you can see it here but not change it.'));
    expect(t.$('#ls-status').textContent).toBe('Read-only');
    expect(t.topbar().save).toBe(false);
  };
  const editable = (t) => {
    expect(t.$('body').classList.contains('cc-ro')).toBe(false);
    expect(t.etVals()).toEqual(['Confirmation Hearing', 'Docs Deadline', 'Hearing']);
    expect(t.ls().map((i) => i.value)).toEqual(['Google', 'Referral']);
    expect(t.$$('[data-ycsr="history"]')).toHaveLength(2);
    expect(t.controls().filter((c) => c.disabled && !/^[↑↓]$/.test(c.textContent))).toEqual([]);
    expect(t.$$('.cc-w').length).toBeGreaterThan(0);
    expect(t.$$('.cc-w').filter((el) => t.w.getComputedStyle(el).display === 'none')).toEqual([]);
  };

  test('read-only at init for every answer but true (false / null / undefined / "true" / 1) — no onAccess needed', async () => {
    for (const canEdit of [false, null, undefined, 'true', 1]) {
      const t = await boot({ canEdit });
      readOnly(t);
      t.top.close();
    }
  });

  test('editable at init when P.configCanEdit === true: the lead-source list and the event-types editor, History on both', async () => {
    const t = await boot({ canEdit: true });
    editable(t);
    expect(t.row('fe-event_types').querySelector('.ls-et')).not.toBeNull();
  });

  test('onAccess re-applies it both ways (true → editable; then false / missing / "true" / {} → read-only)', async () => {
    const t = await boot({ canEdit: null });
    readOnly(t);
    t.w.onAccess({ canEdit: true });
    await flush();
    editable(t);
    for (const access of [{ canEdit: false }, undefined, { canEdit: 'true' }, {}]) {
      t.w.onAccess({ canEdit: true });
      await flush(5);
      t.w.onAccess(access);
      await flush();
      readOnly(t);
    }
    expect(t.gets()).toEqual(['/api/app-settings?home=config']);                    // re-drawn, never re-read
  });

  test('the server says can_edit false (no firm.settings) while the answer is true: still no control', async () => {
    const t = await boot({ canEdit: true, caps: { firm: false, system: false } });
    expect(t.controls()).toEqual([]);
    expect(t.$$('.ycsr-ro').map((e) => e.textContent)).toEqual([LS, ET]);
  });

  test('api() refuses every non-GET while read-only (and only then) — nothing reaches apiSend', async () => {
    const t = await boot({ canEdit: false });
    await expect(t.L.api('/api/app-settings/fe-lead_sources', 'PUT', { value: '[]' })).rejects.toThrow(RO_MSG);
    await expect(t.L.api('/api/app-settings/fe-event_types/restore', 'POST', { version_id: 1 })).rejects.toThrow(RO_MSG);
    await expect(t.L.api('/api/app-settings?home=config')).resolves.toMatchObject({ status: 'success' });
    expect(t.writes()).toEqual([]);
    t.w.onAccess({ canEdit: true });
    await flush();
    await t.L.api('/api/app-settings/fe-lead_sources', 'PUT', { value: '["X"]' });
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-lead_sources', '["X"]']]);
  });

  // THE SWEEP: every control in the document — hidden and disabled ones too —
  // driven the way a person would, then every Save path; no write may reach
  // apiSend. Run read-only from the start, and after an editable session was
  // dirtied and then told read-only.
  // A second pass fills what the first one added blank (an added entry), so
  // the editable drive is not refused for an empty name.
  const SWEEP_SEL = 'button, a, [onclick], input, select, textarea';
  async function sweep(t) {
    let n = 0;
    const fill = (el) => { el.value = 'Swept ' + (++n); t.fire(el, 'input'); t.fire(el, 'change'); };
    t.answer(true);
    for (const el of t.$$(SWEEP_SEL)) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') fill(el);
      else if (el.tagName === 'SELECT') { t.fire(el, 'change'); }
      else t.click(el);
      await flush(5);
    }
    for (const el of t.$$('input, textarea')) if (el.value.trim() === '') fill(el);
    await t.w.onSave();
    await t.L.Page.save();
    if (t.L.Page.view) await t.L.Page.view.save();
    await flush();
    return n;
  }

  test('THE SWEEP, read-only: every rendered control driven, every Save path taken — no write reaches apiSend', async () => {
    const t = await boot({ canEdit: false });
    await sweep(t);
    expect(t.writes()).toEqual([]);
    expect(t.gets().length).toBeGreaterThan(0);
    readOnly(t);
  });

  test('THE SWEEP after a flip: an editable session with unsaved edits, then told read-only — its edits are gone with its controls, nothing writes', async () => {
    const t = await boot({ canEdit: true });
    const stale = t.et()[0];
    t.setVal(stale, 'Edited');
    t.setVal(t.ls()[0], 'Edited too');
    expect(t.L.Page.dirty()).toBe(true);
    t.w.onAccess({ canEdit: false });
    await flush();
    readOnly(t);
    expect(t.L.Page.dirty()).toBe(false);
    t.setVal(stale, 'Again');                                // a control from before the flip, detached
    await sweep(t);
    expect(t.writes()).toEqual([]);
  });

  test('THE SWEEP, editable: the same drive reaches the writes (so the read-only sweep exercises them)', async () => {
    const t = await boot({ canEdit: true });
    const n = await sweep(t);
    expect(n).toBeGreaterThan(4);
    const got = new Set(t.writes().map(([k]) => k));
    expect([...got].sort()).toEqual(['PUT /api/app-settings/fe-event_types', 'PUT /api/app-settings/fe-lead_sources']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the event-types editor (settings.html\'s, ported)', () => {
  const etRow = (t) => t.row('fe-event_types');
  const btn = (t, attr, i) => etRow(t).querySelector(`[${attr}="${i}"]`);

  test('drawn from the stored list verbatim, with the warning and the Calendar Types note; untouched is clean and hands back the stored string byte for byte', async () => {
    const t = await boot();
    const hints = [...etRow(t).querySelectorAll('.ls-et > .yc-hint')].map((h) => h.textContent.replace(/\s+/g, ' '));
    expect(hints).toEqual([
      'Renaming or removing an event type does not change existing events — they keep their old value.',
      'The event form\'s real vocabulary is Calendar Types (its own tab here). This list is what the new-event dialog and the Events filter offer, and what the event form falls back to when Calendar Types cannot be read.',
    ]);
    expect(etRow(t).querySelector('.ls-et-warn')).toBe(etRow(t).querySelector('.ls-et > .yc-hint'));
    expect(t.etVals()).toEqual(['Confirmation Hearing', 'Docs Deadline', 'Hearing']);
    expect(etRow(t).querySelector('label.yc-flabel').htmlFor).toBe(t.et()[0].id);
    expect([t.L.Page.view.value('fe-event_types'), t.L.Page.view.isDirty()]).toEqual([ET, false]);
    // an edit and its revert: clean again
    t.setVal(t.et()[1], 'Docs');
    expect(t.L.Page.dirty()).toBe(true);
    t.setVal(t.et()[1], 'Docs Deadline');
    expect([t.L.Page.dirty(), t.L.Page.view.value('fe-event_types')]).toEqual([false, ET]);
  });

  test('add: a new entry, focused; typed verbatim (spaces kept, the badge says so); saved as a JSON list; no question (nothing gone); loadFirmData once', async () => {
    const t = await boot();
    t.answer(true);
    t.click(etRow(t).querySelector('[data-et-add]'));
    await flush();
    expect(t.w.document.activeElement).toBe(t.et()[3]);
    t.setVal(t.et()[3], 'Mediation ');
    expect(etRow(t).querySelectorAll('.ls-et-ws')[3].textContent).toBe('⚠ 1 trailing space — preserved on save');
    expect([t.$('#ls-status').textContent, t.topbar().save]).toEqual(['Unsaved changes', true]);
    await t.save();
    const want = JSON.stringify(['Confirmation Hearing', 'Docs Deadline', 'Hearing', 'Mediation ']);
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-event_types', want]]);
    expect([t.asked, t.firmLoads(), t.fake.value('fe-event_types'), t.status('fe-event_types')]).toEqual([[], 1, want, 'Saved']);
    expect([t.L.Page.dirty(), t.topbar().save, t.etVals()]).toEqual([false, false, ['Confirmation Hearing', 'Docs Deadline', 'Hearing', 'Mediation ']]);
  });

  test('reorder: ↑ / ↓ move an entry (the ends disabled); the order is what saves', async () => {
    const t = await boot();
    expect([btn(t, 'data-et-up', 0).disabled, btn(t, 'data-et-down', 2).disabled]).toEqual([true, true]);
    t.click(btn(t, 'data-et-down', 0));
    await flush();
    t.click(btn(t, 'data-et-up', 2));
    await flush();
    expect(t.etVals()).toEqual(['Docs Deadline', 'Hearing', 'Confirmation Hearing']);
    await t.save();
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-event_types', '["Docs Deadline","Hearing","Confirmation Hearing"]']]);
    expect(t.asked).toEqual([]);
  });

  test('rename: the page Save asks first, naming what is gone — No: nothing saved, the edit kept; Yes: saved', async () => {
    const t = await boot();
    t.setVal(t.et()[2], 'Hearing (court)');
    t.answer(false);
    await t.save();
    expect(t.asked).toEqual(['Save the event types?\n\nThis event type is renamed or removed: Hearing. Existing events keep their old value. Save anyway?']);
    expect([t.writes(), t.L.Page.dirty(), t.et()[2].value]).toEqual([[], true, 'Hearing (court)']);
    t.answer(true);
    await t.save();
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-event_types', '["Confirmation Hearing","Docs Deadline","Hearing (court)"]']]);
    expect(t.asked).toHaveLength(2);
    // a spacing-only change is not a rename (the consumers trim)
    t.setVal(t.et()[0], ' Confirmation Hearing');
    await t.save();
    expect([t.asked.length, t.writes().length]).toEqual([2, 2]);
  });

  test('remove: asks first — No keeps it (clean); Yes removes it (dirty) and the Save asks nothing more; a blank entry goes without a question', async () => {
    const t = await boot();
    t.answer(false);
    t.click(btn(t, 'data-et-del', 1));
    await flush();
    expect(t.asked).toEqual(['Remove this event type?\n\n“Docs Deadline” is no longer offered in the new-event dialog or the Events filter once you save. Existing events of this type keep it.']);
    expect([t.etVals(), t.L.Page.dirty()]).toEqual([['Confirmation Hearing', 'Docs Deadline', 'Hearing'], false]);
    t.answer(true);
    t.click(btn(t, 'data-et-del', 1));
    await flush();
    expect([t.etVals(), t.L.Page.dirty(), t.asked.length]).toEqual([['Confirmation Hearing', 'Hearing'], true, 2]);
    t.click(etRow(t).querySelector('[data-et-add]'));
    await flush();
    t.click(btn(t, 'data-et-del', 2));                       // the new blank entry
    await flush();
    expect([t.etVals(), t.asked.length]).toEqual([['Confirmation Hearing', 'Hearing'], 2]);
    await t.save();
    expect(t.asked).toHaveLength(2);                         // removed through the question: not asked again
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-event_types', '["Confirmation Hearing","Hearing"]']]);
    // emptied: an empty list, saved as one
    t.click(btn(t, 'data-et-del', 0)); await flush();
    t.click(btn(t, 'data-et-del', 0)); await flush();
    expect(etRow(t).querySelector('.ls-et-none').textContent).toBe('No event types — the app\'s built-in list applies.');
    await t.save();
    expect(t.writes()[1]).toEqual(['PUT /api/app-settings/fe-event_types', '[]']);
  });

  test('duplicates (trimmed, any case) and empty names are refused before any PUT: the reason in the editor and on the row; the banner says so', async () => {
    const t = await boot();
    t.answer(true);
    t.setVal(t.et()[0], ' docs deadline ');
    expect(etRow(t).querySelector('.ls-et-msg').textContent).toBe('“Docs Deadline” is listed twice.');
    await t.save();
    expect([t.writes(), t.asked]).toEqual([[], []]);          // refused before the rename question too
    expect(t.status('fe-event_types')).toBe('“Docs Deadline” is listed twice — event type names must be unique.');
    expect(t.banner()).toBe('Lists: a list was not saved — the reason is on it.');
    t.setVal(t.et()[0], 'Confirmation Hearing');
    expect(etRow(t).querySelector('.ls-et-msg').textContent).toBe('');
    t.click(etRow(t).querySelector('[data-et-add]'));
    await flush();
    t.setVal(t.et()[3], '   ');
    await t.save();
    expect(t.writes()).toEqual([]);
    expect(t.status('fe-event_types')).toBe('Event type names cannot be empty — fill it in or remove it.');
    t.setVal(t.et()[3], 'Mediation');
    await t.save();
    expect([t.writes().length, t.banner(), t.L.Page.dirty()]).toEqual([1, null, false]);
  });

  test('a stored value the editor cannot read: the row falls back to the type\'s own control (a textarea, verbatim); blank stored: an empty editor', async () => {
    const t = await boot({ values: { ...VALUES, 'fe-event_types': ' {"Hearing": 1} ' } });
    const ta = t.row('fe-event_types').querySelector('textarea');
    expect([ta && ta.value, t.row('fe-event_types').querySelector('.ls-et'), t.L.ET.current]).toEqual([' {"Hearing": 1} ', null, null]);
    expect(t.L.etParse('["a", 1]')).toBeNull();
    expect(t.L.etParse('["a\\nb"]')).toBeNull();
    const t2 = await boot({ values: { 'fe-lead_sources': LS } });                    // no fe-event_types row yet
    expect([t2.et().length, t2.row('fe-event_types').querySelector('.ls-et-none').textContent, t2.L.Page.dirty()])
      .toEqual([0, 'No event types — the app\'s built-in list applies.', false]);
    expect(t2.row('fe-event_types').querySelector('label.yc-flabel').htmlFor).toBe(t2.row('fe-event_types').querySelector('[data-et-add]').id);
    t2.click(t2.row('fe-event_types').querySelector('[data-et-add]'));
    await flush();
    t2.setVal(t2.et()[0], 'Hearing');
    await t2.save();
    expect(t2.writes()).toEqual([['PUT /api/app-settings/fe-event_types', '["Hearing"]']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('lead sources, firmData, refusals, guards', () => {
  test('lead sources: the rows module\'s list (add / remove / reorder) — saved as a JSON list; with event types in the same Save: two PUTs, loadFirmData ONCE', async () => {
    const t = await boot();
    expect(t.ls().map((i) => i.value)).toEqual(['Google', 'Referral']);
    t.click(t.row('fe-lead_sources').querySelector('[data-ycsr-li="add"]'));
    await flush();
    t.setVal(t.ls()[2], 'Billboard');
    await t.save();
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-lead_sources', '["Google","Referral","Billboard"]']]);
    expect(t.firmLoads()).toBe(1);
    t.click(t.row('fe-lead_sources').querySelector('[data-ycsr-li="del"][data-i="0"]'));
    await flush();
    t.setVal(t.et()[0], 'Confirmation hearing');             // a case change is a rename: the Save asks
    t.answer(true);
    await t.save();
    expect(t.writes().slice(1)).toEqual([
      ['PUT /api/app-settings/fe-lead_sources', '["Referral","Billboard"]'],
      ['PUT /api/app-settings/fe-event_types', '["Confirmation hearing","Docs Deadline","Hearing"]']]);
    expect([t.firmLoads(), t.asked.length]).toEqual([2, 1]);
  });

  test('a 403 on save (the permission gone since load): the server\'s sentence on the row, the session message on the banner, the edit kept', async () => {
    const t = await boot();
    t.fake.st.caps.firm = false;
    t.setVal(t.ls()[1], 'Word of mouth');
    await t.save();
    expect(t.status('fe-lead_sources')).toBe('Changing Lead sources needs the firm.settings permission');
    expect(t.banner()).toBe(`Lists: a list was not saved — the reason is on it. ${SESSION_MSG}`);
    expect([t.L.Page.dirty(), t.firmLoads(), t.fake.value('fe-lead_sources')]).toEqual([true, 0, LS]);
  });

  test('the GET failing: said on the page (403 → the session message)', async () => {
    for (const [status, want] of [[403, SESSION_MSG], [500, 'Could not load the lists: boom']]) {
      const t = await boot({ wrap: (api) => async (url, method, body) => {
        if (String(url).startsWith('/api/app-settings')) throw apiError(status, 'boom');
        return api(url, method, body);
      } });
      expect([t.banner(), t.$('#ls-rows .empty-state').textContent, t.$$('.ycsr-row').length]).toEqual([want, want, 0]);
    }
  });

  test('the dirty guards: Refresh asks first (No keeps the edit, Yes re-reads clean); a tab return never reloads over an edit; an unload is held', async () => {
    const t = await boot();
    t.setVal(t.et()[0], 'Changed');
    t.answer(false);
    await t.w.onRefresh();
    await flush();
    expect([t.asked, t.gets().length, t.et()[0].value]).toEqual([['Discard unsaved list changes?'], 1, 'Changed']);
    t.w.onShow();
    await flush();
    expect([t.gets().length, t.et()[0].value]).toEqual([1, 'Changed']);
    const ev = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    t.answer(true);
    await t.w.onRefresh();
    await flush();
    expect([t.gets().length, t.et()[0].value, t.L.Page.dirty()]).toEqual([2, 'Confirmation Hearing', false]);
    const ev2 = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('under the real Config shell', () => {
  async function shell() {
    const fake = makeSettingsApi({ values: VALUES, caps: { firm: true, system: false } });
    const top = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously', url: 'https://app.test/', pretendToBeVisual: true, virtualConsole: new VirtualConsole() }).window;
    let release;
    const probe = new Promise((r) => { release = r; });
    let firmLoads = 0;
    top.apiSend = async (url, method = 'GET', body) => {
      if (url === '/api/ui-config') return probe;
      return fake.api(url, method, body);
    };
    top.firmData = { users: [] };
    top.loadFirmData = () => { firmLoads++; return Promise.resolve(); };
    const f = top.document.createElement('iframe');
    top.document.body.appendChild(f);
    await flush(5);
    const mid = f.contentWindow;
    mid.document.open(); mid.document.write(strip(CCM_HTML)); mid.document.close();
    await flush();
    mid.switchSubPage('lists');
    const fr = mid.document.getElementById('subpage-lists');
    fr.contentWindow.document.open(); fr.contentWindow.document.write(strip(LISTS_HTML)); fr.contentWindow.document.close();
    await flush();
    const t = harness(fr.contentWindow, { top, fake, firmLoads: () => firmLoads, topbar: () => null });
    t.mid = mid;
    t.release = async (a) => { release(a); await flush(); };
    t.shown = () => ['save', 'refresh', 'new', 'delete'].filter((k) => mid.document.getElementById(`btn-${k}`).style.display !== 'none');
    t.roBanner = () => (mid.document.getElementById('ro-banner').hidden ? null : mid.document.getElementById('ro-banner-text').textContent);
    return t;
  }

  test('read-only while the probe runs; the answer true makes it editable — the topbar Save appears once dirty, saves, and the shell re-reads firmData', async () => {
    const t = await shell();
    expect([t.$('body').classList.contains('cc-ro'), t.controls().length, t.shown()]).toEqual([true, 0, ['refresh']]);
    await t.release({ can_edit_firm: true });
    expect([t.$('body').classList.contains('cc-ro'), t.etVals().length, t.shown(), t.roBanner()]).toEqual([false, 3, ['refresh'], null]);
    t.setVal(t.ls()[0], 'Search');
    expect(t.shown()).toEqual(['save', 'refresh']);
    t.mid.onTopbarSave();
    await flush();
    expect(t.writes()).toEqual([['PUT /api/app-settings/fe-lead_sources', '["Search","Referral"]']]);
    expect([t.firmLoads(), t.shown()]).toEqual([1, ['refresh']]);
  });

  test('the answer false: the banner, Save masked, no control — and the shell\'s Save hook refuses too', async () => {
    const t = await shell();
    await t.release({ can_edit_firm: false });
    expect([t.$('body').classList.contains('cc-ro'), t.controls().length, t.shown(), t.roBanner()]).toEqual([true, 0, ['refresh'], RO_MSG]);
    t.mid.onTopbarSave();
    await t.w.onSave();
    await flush();
    expect(t.writes()).toEqual([]);
  });
});
