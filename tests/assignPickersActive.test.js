// tests/assignPickersActive.test.js
//
/**
 * Assign pickers offer ACTIVE users only — access-control D3b (follow-on to
 * D3's tasks.html pickers; firmData.users rows carry boolean `active` since
 * 59ca755, routes/api.firmData.js).
 *
 * The rule, per site: NEW choices are filtered on `u.active !== false` (a
 * cached payload without the field passes), each site's existing filters kept;
 * where a picker shows an EXISTING record's value, that value stays listed and
 * selected whatever filter excludes it — a save must never silently change it.
 *
 * WHAT IS LOCKED (each page's real script, in jsdom)
 *   - scripts.js newContact / newApptDialog appt_with: active providers only
 *     (create-only — nothing to keep).
 *   - scripts.js newEventDialog reminder "to": active staff only (user_type too
 *     — Automation 0 is never offered; no current value to keep).
 *   - scripts.js newEventDialog "Blocks calendar of": active providers for new
 *     choices; an edit keeps the stored provider when it is inactive, when it
 *     lost does_appts, and when it is missing from the list altogether; '0'
 *     (Nobody) never turns into the Automation user.
 *   - eventform.html "Blocks calendar of": the same, through its existing
 *     not-in-the-list re-add.
 *   - ctaManager.html attribution: active users for new choices; an inactive
 *     current value stays, named "(inactive)".
 *   - checklistsView.html "Lists for": inactive users under an "Inactive — view
 *     only" group at the end; the selection survives.
 *   - automationManager.html user suggestions: active users only.
 *
 * Run: npx jest tests/assignPickersActive.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const SCRIPTS = read('scripts.js');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms = 30) => new Promise((r) => w.setTimeout(r, ms));

// The roster every site sees. 3 = inactive provider; 4 = active but no longer
// does_appts; 5 = a cached payload row with no `active`; 0 = Automation.
const USERS = [
  { user: 0, user_name: 'Automation', user_type: 0, does_appts: 0, active: true },
  { user: 1, user_name: 'Stuart', user_type: 1, does_appts: 1, active: true },
  { user: 2, user_name: 'Rena', user_type: 1, does_appts: 1, active: true },
  { user: 3, user_name: 'Former Provider', user_type: 1, does_appts: 1, active: false },
  { user: 4, user_name: 'Paralegal', user_type: 1, does_appts: 0, active: true },
  { user: 5, user_name: 'Cached Row', user_type: 1, does_appts: 1 },
  { user: 6, user_name: 'Ex Staff', user_type: 1, does_appts: 0, active: false },
];
const vals = (sel) => [...sel.options].map((o) => o.value);

// ─────────────────────────────────────────────────────────────────────────────
// scripts.js dialogs
// ─────────────────────────────────────────────────────────────────────────────

function bootScripts() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/index.html', runScripts: 'dangerously' });
  DOMS.push(dom);
  const { window } = dom;
  window.apiSend = async (url) => {
    if (url.startsWith('/api/calendar-types')) return { status: 'success', data: [] };
    if (url === '/api/availability') return { slots: {} };
    return { status: 'success', data: [] };
  };
  window.firmData = { users: USERS, settings: {}, currentUser: { user: 1 } };
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    isLoading: () => false,
    showValidationMessage: () => {},
    close: () => {},
    fire: (cfg) => {
      window.document.body.innerHTML = `<div class="swal2-popup">${cfg.html || ''}</div>`;
      if (cfg.didOpen) cfg.didOpen();
      return new Promise(() => {});
    },
  };
  window.eval(SCRIPTS + '\n;window.E = E;');
  return window;
}
const $ = (w, id) => w.document.getElementById(id);

describe('scripts.js — appointment provider (create-only)', () => {
  test('newContact: active providers only; cached row kept', async () => {
    const w = bootScripts();
    w.newContact();
    await tick(w);
    expect(vals($(w, 'NCApptWith'))).toEqual(['1', '2', '5']);
  });
  test('newApptDialog: active providers only; the default is the lowest-id ACTIVE one', async () => {
    const w = bootScripts();
    w.newApptDialog({});
    await tick(w);
    expect(vals($(w, 'naWith'))).toEqual(['1', '2', '5']);
    expect($(w, 'naWith').value).toBe('1');
  });
});

describe('scripts.js — event dialog', () => {
  const ev = (over) => ({ event_id: 9, event_title: 't', event_type: 'Meeting', event_date: '2026-11-02', event_time: '10:00:00', event_all_day: 0, ...over });

  test('reminder "to": active staff only — never Automation, never inactive', async () => {
    const w = bootScripts();
    w.newEventDialog({});
    await tick(w);
    expect(vals($(w, 'neRemindTo'))).toEqual(['', '1', '2', '4', '5']);
  });

  test('"Blocks calendar of", new event: Everyone, Nobody, then active providers', async () => {
    const w = bootScripts();
    w.newEventDialog({});
    await tick(w);
    expect(vals($(w, 'neBlocksWith'))).toEqual(['', '0', '1', '2', '5']);
    expect($(w, 'neBlocksWith').value).toBe('');
  });

  test.each([
    ['an INACTIVE provider', 3, ['', '0', '1', '2', '3', '5']],
    ['a provider who LOST does_appts', 4, ['', '0', '1', '2', '4', '5']],
    ['a user MISSING from the list', 77, ['', '0', '1', '2', '5', '77']],
  ])('edit keeps %s, listed and selected', async (_n, withId, expected) => {
    const w = bootScripts();
    w.newEventDialog({ event: ev({ event_with: withId }) });
    await tick(w);
    expect(vals($(w, 'neBlocksWith'))).toEqual(expected);
    expect($(w, 'neBlocksWith').value).toBe(String(withId));
  });

  test('edit with event_with 0 (Nobody) stays Nobody — never the Automation user', async () => {
    const w = bootScripts();
    w.newEventDialog({ event: ev({ event_with: 0 }) });
    await tick(w);
    expect(vals($(w, 'neBlocksWith'))).toEqual(['', '0', '1', '2', '5']);
    expect($(w, 'neBlocksWith').value).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// eventform.html
// ─────────────────────────────────────────────────────────────────────────────

describe('eventform.html — "Blocks calendar of"', () => {
  const HTML = read('eventform.html');
  async function boot(eventWith) {
    const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/eventform.html?eventID=500', runScripts: 'outside-only' });
    DOMS.push(dom);
    const { window } = dom;
    const row = { event_id: 500, event_type: 'Meeting', event_title: 'Meeting', event_date: '2026-11-02T00:00:00.000Z', event_time: '10:00:00',
      event_all_day: 0, event_length: 30, event_location: null, event_link: null, event_status: 'Scheduled', event_resolution: null,
      kind: 'meeting', type_key: null, event_with: eventWith, link_type: null, link_id: null, event_create_date: '2026-10-01T10:00:00.000Z' };
    window.apiSend = async (url) => {
      if (url.startsWith('/api/events/')) return { status: 'success', data: row };
      if (url.startsWith('/api/calendar-types')) return { status: 'success', data: [] };
      return { status: 'success' };
    };
    window.firmData = { users: USERS, settings: {}, currentUser: { user: 1 } };
    window.Swal = { mixin: () => ({ fire: () => {} }), isLoading: () => false, showValidationMessage: () => {}, close: () => {},
      fire: () => ({ then: () => ({ catch: () => {} }) }) };
    window.eval(SCRIPTS + '\n;window.E = E;');
    const blocks = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    window.eval(blocks[0]);
    await tick(window, 60);
    return window;
  }

  test('no stored provider: Everyone, Nobody, active providers only', async () => {
    const w = await boot(null);
    expect(vals($(w, 'efBlocksWith'))).toEqual(['', '0', '1', '2', '5']);
  });
  test.each([['an inactive provider', 3], ['a provider who lost does_appts', 4]])('keeps %s, selected', async (_n, id) => {
    const w = await boot(id);
    const sel = $(w, 'efBlocksWith');
    expect(vals(sel)).toContain(String(id));
    expect(sel.value).toBe(String(id));
    expect(vals(sel).filter((v) => v === '3' || v === '4')).toEqual([String(id)]);   // the other one is not offered
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ctaManager.html, checklistsView.html, automationManager.html
// ─────────────────────────────────────────────────────────────────────────────

/** Body + the one inline block as a real classic script (globals reachable). */
async function bootPane(file, { url = `https://app.4lsg.com/${file}`, setup = () => {} } = {}) {
  const HTML = read(file);
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url, runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.firmData = { users: USERS, settings: {}, currentUser: { user: 1 }, phoneLines: [], emailFrom: [], firmTimezone: 'America/Detroit' };
  window.apiSend = async (u) => (u === '/api/cta' ? { ctas: [] } : { status: 'success', data: [], rows: [], total: 0 });
  setup(window);
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const sc = window.document.createElement('script');
  sc.textContent = inline.join('\n;\n');
  window.document.body.appendChild(sc);
  await tick(window, 60);
  return window;
}

describe('ctaManager.html — "Attribute clicks to"', () => {
  async function mint(attributed) {
    const w = await bootPane('ctaManager.html');
    w.eval(`state.draft = newDraft(); state.draft.attributed_user_id = ${JSON.stringify(attributed)}; renderMint();`);
    return w;
  }
  test('new choices: active users only (the existing user > 0 filter kept)', async () => {
    const w = await mint('');
    expect(vals($(w, 'm-attr'))).toEqual(['', '1', '2', '4', '5']);
  });
  test('an inactive current value stays, named and selected', async () => {
    const w = await mint('3');
    const sel = $(w, 'm-attr');
    expect(vals(sel)).toEqual(['', '1', '2', '4', '5', '3']);
    expect(sel.value).toBe('3');
    expect(sel.options[sel.selectedIndex].textContent).toBe('Former Provider (inactive)');
  });
  test('a current value missing from the list keeps its old label', async () => {
    const w = await mint('88');
    const sel = $(w, 'm-attr');
    expect(sel.value).toBe('88');
    expect(sel.options[sel.selectedIndex].textContent).toBe('user #88 (not in the staff list)');
  });
});

describe('checklistsView.html — "Lists for"', () => {
  async function head(forUser) {
    // E() comes from /scripts.js in production (an external <script src>).
    const w = await bootPane('checklistsView.html', { setup: (win) => { win.E = (id) => win.document.getElementById(id); } });
    w.eval(`scope = 'mine'; forUser = ${JSON.stringify(forUser)}; renderHead();`);
    return w;
  }
  test('active users in the main list; inactive under "Inactive — view only" at the end', async () => {
    const w = await head(null);
    const sel = $(w, 'cxNewFor');
    const top = [...sel.children].filter((c) => c.tagName === 'OPTION').map((o) => o.value);
    expect(top).toEqual(['0', '1', '2', '4', '5']);
    const g = sel.querySelector('optgroup');
    expect(g.label).toBe('Inactive — view only');
    expect([...g.children].map((o) => o.value)).toEqual(['3', '6']);
    expect(sel.lastElementChild).toBe(g);
  });
  test('an inactive user stays selected (viewing their lists is a lookup)', async () => {
    const w = await head('6');
    expect($(w, 'cxNewFor').value).toBe('6');
  });
  test('a cached payload without `active` keeps everyone in the main list, no group', async () => {
    const w = await head(null);
    w.firmData.users = USERS.map(({ active, ...u }) => u);          // eslint-disable-line no-unused-vars
    w.eval('renderHead();');
    const sel = $(w, 'cxNewFor');
    expect(sel.querySelector('optgroup')).toBeNull();
    expect(vals(sel)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
  });
});

describe('automationManager.html — user-id suggestions', () => {
  // The manager boots sub-page iframes, which jsdom can't host cleanly; this
  // runs the page's OWN functions (sliced out by brace matching, not copied).
  function pageFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`no function ${name}`);
    let i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start, i + 1);
  }
  test('active users only (cached row kept)', async () => {
    const src = read('automationManager.html');
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    DOMS.push(dom);
    const w = dom.window;
    w.firmData = { users: USERS, phoneLines: [], emailFrom: [] };
    w.eval(['esc', 'fdPhoneLines', 'fdEmailFroms', 'fdUsers', 'fdParamSourceDatalistHtml'].map((n) => pageFunction(src, n)).join('\n'));
    const html = w.eval("fdParamSourceDatalistHtml('dl')");
    const ids = [...html.matchAll(/value="'(\d+)'" label="\[user\]/g)].map((m) => m[1]);
    expect(ids).toEqual(['0', '1', '2', '4', '5']);
  });
});
