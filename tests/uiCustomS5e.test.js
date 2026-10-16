// tests/uiCustomS5e.test.js
//
/**
 * ui-custom S5e-1 — the legacy custom tabs into the launcher: the PURE parts of
 * scripts/uiCustomS5eCustomTabsToButtons.js (no database):
 *   - the record (ref/migrations/2026-10-16_ui_custom_s5e_custom_tabs_to_buttons.json)
 *     holds the manager's verified live table, user 5's loadFunc included (read
 *     live by the manager); a record value held as {$unknown} is refused by the
 *     BEFORE test;
 *   - the planner: the dispositions (three buttons, moreManuals, Fred's single
 *     swap, nothing for user 0), ids by the client's own makeUserId, placement
 *     by the S4b editor's own session (replace + retarget), every document
 *     accepted by lib/uiConfigShape.js and normalizing to itself; it follows
 *     the user's own launcher (su's admin row, firm hides, denies, locks);
 *   - refusal on any drifted input (the BEFORE test), and BEFORE / AFTER /
 *     DRIFT classification;
 *   - the resolver identity check (renderProblems) — Home, the sidebar and All
 *     identical but the custom slot; it fails on a wrong slot, a moved item,
 *     a wrong label or icon.
 * The real engine: tests/uiCustomS5e.mysql.test.js (gated).
 *
 * Mutation-checked (see the S5e-1 worker report).
 *
 * Run:  npx jest tests/uiCustomS5e.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const shape = require('../lib/uiConfigShape');
const S = require('../scripts/uiCustomS5eCustomTabsToButtons');

const J = (x) => JSON.parse(JSON.stringify(x));
const core = S.loadCore();
const { E, LAY } = core;
const RECORD = S.loadRecord();
// user 5's loadFunc, read live by the manager 2026-10-16 (U+1F947, a gold medal, twice)
const PRANK = "Toast.fire({text:'you clicked the link first so you get this prize',icon:'info',title:'\u{1F947} First Place! \u{1F947}'});";
const exp = (uid) => J(RECORD.get(uid));
const ENV = (roles = ['staff'], o = {}) => ({ firm: {}, denied: [], roles, isAdmin: roles.includes('su'), locked: [], ...o });

const FRED_ITEMS = { items: [
  { id: 'user:call-review', label: 'call review', icon: 'phone', action: { type: 'tool', key: 'call-review', present: 'modal' } },
  { id: 'user:box', label: 'Box', icon: 'box', action: { type: 'drawer', items: ['user:call-review', 'cases'] } },
] };
const FRED_LAYOUT = {
  placed: { home: [{ item: 'cases' }, { item: 'comms' }, { break: true }, { item: 'tasks' }, { item: 'log' }, { item: 'custom' }, { item: 'user:box' },
    { break: true }, { item: 'contacts' }, { item: 'appts' }, { item: 'bills' }, { item: 'pipeline' }, { item: 'events' }, { item: 'newClient' }, { item: 'moreFeatures' }] },
  removed: { home: [] },
};
// what readUser returns for a user as the record has them
function stateOf(uid, rows = null) {
  const e = exp(uid);
  return { user: uid, name: 'u' + uid, roles: uid === 6 ? ['it', 'admin', 'form_dev', 'su'] : ['staff'], ct: J(e.ct), ctType: e.ct ? 'OBJECT' : 'NULL',
    rows: rows ? J(rows) : uid === 6 ? { items: J(FRED_ITEMS), layout: J(FRED_LAYOUT), prefs: { theme: { mode: 'dark' } }, shortcuts: { bindings: [] } } : {},
    badRows: [] };
}
const envOf = (uid) => ENV(stateOf(uid).roles);
const swap = (list, from, to) => list.map((e) => (e.item === from ? { item: to } : e));
const items = (list) => list.filter((e) => e.item).map((e) => e.item);
// the sidebar a non-su user sees: the base one without Admin (admin-gated)
const SIDE = () => LAY.sidebar.filter((e) => e.item !== 'admin');

// ─────────────────────────────────────────────────────────────────────────
describe('the record', () => {
  test('it holds the manager\'s verified live table (2026-10-16), user 5\'s loadFunc exactly', () => {
    const raw = JSON.parse(fs.readFileSync(S.RECORD_FILE, 'utf8'));
    const t = (src, icon, title, loadFunc = '') => ({ src, icon, title, loadFunc });
    expect(raw.users.map((u) => [u.user, u.user_custom_tab, u.ui_config_before])).toEqual([
      [0, t('/manuals.html', 'book-open', 'manuals'), []],
      [1, t('/tool/call-review', 'headset', 'Call Review'), []],
      [2, null, []],
      [3, t('/etch.html', 'paintbrush', 'Paint'), []],
      [4, null, []],
      [5, t('/manuals.html', 'award', 'winner', PRANK), []],
      [6, t('/tool/call-review', 'phone', 'call review'), ['items', 'layout', 'prefs', 'shortcuts']],
      [22, t('/customView.html?key=lead_followups', 'list-check', 'Follow Ups'), []],
      [23, null, []],
    ]);
  });

  test('an {$unknown} value is refused, and names where to get it', () => {
    const st = stateOf(5);
    expect([...PRANK].filter((ch) => ch.codePointAt(0) === 0x1F947).length).toBe(2);
    const unknown = J(RECORD.get(5));
    unknown.ct.loadFunc = { $unknown: 'paste it' };
    const p = S.beforeProblems(5, st, unknown);
    expect(p).toEqual([expect.stringMatching(/^the record does not hold the exact prior user_custom_tab\.loadFunc: paste it from PRIOR VALUES \(user 5\)/)]);
    expect(S.beforeProblems(5, st, exp(5))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the planner', () => {
  test.each([
    [1, 'user:call-review', { type: 'tool', key: 'call-review', present: 'tab' }, 'Call Review', 'headset'],
    [22, 'user:follow-ups', { type: 'view', key: 'lead_followups', present: 'tab' }, 'Follow Ups', 'list-check'],
    [3, 'user:paint', { type: 'url', href: '/etch.html', present: 'window' }, 'Paint', 'paintbrush'],
  ])('user %i: a new button %s in the custom slot on Home and the sidebar', (uid, id, action, label, icon) => {
    const p = S.planUser(uid, stateOf(uid), envOf(uid));
    expect(p.problems).toEqual([]);
    expect(id).toBe(E.makeUserId(label, {}));                                  // the S5a id rule, the client's function
    expect(p.writes.map((w) => w.config_key)).toEqual(['items', 'layout']);
    expect(p.writes[0].config).toEqual({ items: [{ id, label, icon, action }] });
    // the S4b editor's explicit lists: the base layout with custom → the button, nothing removed
    expect(p.writes[1].config).toEqual({ placed: { home: swap(LAY.home, 'custom', id), sidebar: swap(SIDE(), 'custom', id) }, removed: {} });
    expect(p.slots).toEqual({ home: id, sidebar: id });
    for (const w of p.writes) {
      const r = shape.validate('user', w.config_key, w.config);
      expect([r.ok, shape.canonical(r.value)]).toEqual([true, shape.canonical(w.config)]);
    }
  });

  test('user 5: moreManuals takes the custom slot on Home AND in the sidebar (the validator allows a More item there); no button', () => {
    const p = S.planUser(5, stateOf(5), envOf(5));
    expect(p.problems).toEqual([]);
    expect(p.button).toBe(null);
    expect(p.writes).toEqual([{ config_key: 'layout', config: { placed: { home: swap(LAY.home, 'custom', 'moreManuals'), sidebar: swap(SIDE(), 'custom', 'moreManuals') }, removed: {} } }]);
    expect(shape.validate('user', 'layout', p.writes[0].config).ok).toBe(true);
    expect(p.slots).toEqual({ home: 'moreManuals', sidebar: 'moreManuals' });
  });

  test('user 6 (Fred): ONE swap in his stored placed.home, nothing else written', () => {
    const st = stateOf(6);
    const p = S.planUser(6, st, envOf(6));
    expect(p.problems).toEqual([]);
    expect(p.writes).toEqual([{ config_key: 'layout', config: { ...J(FRED_LAYOUT), placed: { home: swap(FRED_LAYOUT.placed.home, 'custom', 'user:call-review') } } }]);
    const diff = FRED_LAYOUT.placed.home.map((e, i) => (shape.canonical(e) === shape.canonical(p.writes[0].config.placed.home[i]) ? null : i)).filter((i) => i != null);
    expect(diff).toEqual([5]);
    expect(p.slots).toEqual({ home: 'user:call-review', sidebar: null });
    expect(st.rows.layout).toEqual(FRED_LAYOUT);                                // the input is not mutated
  });

  test('user 0: nothing in ui_config', () => {
    expect(S.planUser(0, stateOf(0), ENV(['automation']))).toMatchObject({ writes: [], slots: null, problems: [] });
  });

  test('it follows THIS user\'s launcher: su\'s Admin row, firm hides and locks, denies', () => {
    const firm = { registry_overrides: { hidden: ['calendar'], locked: ['cases'], renames: {}, items: [] } };
    const p = S.planUser(1, stateOf(1), ENV(['admin', 'su'], { firm, denied: ['bills'], locked: ['cases'] }));
    expect(p.problems).toEqual([]);
    const side = items(p.writes[1].config.placed.sidebar);
    expect(side).toContain('admin');                                            // su sees Admin: the editor writes it
    expect(side).not.toContain('calendar');                                     // firm-hidden: not in the visible list
    expect(side).not.toContain('bills');                                        // denied
    expect(items(S.planUser(1, stateOf(1), envOf(1)).writes[1].config.placed.sidebar)).not.toContain('admin');
  });

  test('refused: custom not in this user\'s launcher (firm-hidden / denied) — the editor can\'t place the button', () => {
    for (const env of [ENV(['staff'], { firm: { registry_overrides: { hidden: ['custom'], locked: [], renames: {}, items: [] } } }), ENV(['staff'], { denied: ['custom'] })]) {
      expect(S.planUser(1, stateOf(1), env).problems).toEqual([expect.stringMatching(/^the editor put user:call-review in the custom slot on \[\], expected Home and the sidebar/)]);
    }
    expect(S.planUser(5, stateOf(5), ENV(['staff'], { denied: ['moreManuals'] })).problems[0]).toMatch(/^the editor put moreManuals in the custom slot on \[\]/);
  });

  test('refused: a button for a user who has ui_config rows', () => {
    expect(S.planUser(1, stateOf(1, { prefs: {} }), envOf(1)).problems).toEqual(['a new button is only planned for a user with no ui_config rows']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('refusal on any drifted input (the BEFORE test)', () => {
  const drift = (uid, mut) => { const st = stateOf(uid); mut(st); return S.beforeProblems(uid, st, exp(uid)); };
  test('as recorded → no problem', () => {
    for (const uid of [0, 1, 2, 3, 4, 5, 6, 22, 23]) expect([uid, S.beforeProblems(uid, stateOf(uid), exp(uid))]).toEqual([uid, []]);
  });
  test('MySQL\'s key order does not matter', () => {
    const st = stateOf(1);
    st.ct = { loadFunc: '', title: 'Call Review', src: '/tool/call-review', icon: 'headset' };
    expect(S.beforeProblems(1, st, exp(1))).toEqual([]);
  });
  test.each([
    ['a changed title', 1, (st) => { st.ct.title = 'Call review'; }, 'user_custom_tab.title differs from the record'],
    ['a changed src', 22, (st) => { st.ct.src = '/customView.html?key=other_view'; }, 'user_custom_tab.src differs from the record'],
    ['a new key', 3, (st) => { st.ct.extra = 1; }, 'user_custom_tab.extra differs from the record'],
    ['a lost key', 0, (st) => { delete st.ct.loadFunc; }, 'user_custom_tab.loadFunc differs from the record'],
    ['a different prank', 5, (st) => { st.ct.loadFunc = 'alert(1)'; }, 'user_custom_tab.loadFunc differs from the record'],
    ['a cleared tab', 1, (st) => { st.ct = null; }, 'user_custom_tab differs from the record'],
    ['SQL NULL where the record has the JSON null scalar', 4, (st) => { st.ctType = 'SQL NULL'; }, 'user_custom_tab is SQL NULL, not the JSON null scalar'],
    ['a custom tab where there was none', 2, (st) => { st.ct = { src: '/x.html' }; }, 'user_custom_tab differs from the record'],
    ['a new ui_config row', 22, (st) => { st.rows.layout = { placed: {}, removed: {} }; }, 'ui_config rows are [layout], the record says []'],
    ['a row with a role', 3, (st) => { st.badRows.push('layout (role "x")'); }, 'ui_config rows with a role: layout (role "x")'],
    ['Fred: a row gone', 6, (st) => { delete st.rows.prefs; }, 'ui_config rows are [items, layout, shortcuts], the record says [items, layout, prefs, shortcuts]'],
    ['Fred: custom not right after log', 6, (st) => { st.rows.layout.placed.home.splice(4, 1); }, "placed.home's custom is not right after {item:'log'}"],
    ['Fred: two customs', 6, (st) => { st.rows.layout.placed.home.push({ item: 'custom' }); }, "placed.home holds 2 {item:'custom'} entries, expected 1"],
    ['Fred: no custom', 6, (st) => { st.rows.layout.placed.home.splice(5, 1); }, "placed.home holds 0 {item:'custom'} entries, expected 1"],
    ['Fred: user:call-review already on Home', 6, (st) => { st.rows.layout.placed.home.push({ item: 'user:call-review' }); }, 'placed.home already holds user:call-review'],
    ['Fred: a stored sidebar', 6, (st) => { st.rows.layout.placed.sidebar = []; }, 'he has a stored placed.sidebar'],
    ['Fred: a stored sidebar removal', 6, (st) => { st.rows.layout.removed.sidebar = ['custom']; }, 'he has a stored removed.sidebar'],
    ['Fred: his button gone', 6, (st) => { st.rows.items.items.splice(0, 1); }, 'his items hold no user:call-review'],
    ['Fred: his button opens as a tab', 6, (st) => { st.rows.items.items[0].action.present = 'tab'; }, /^his user:call-review is not a modal tool button for call-review/],
    ['Fred: his button opens another tool', 6, (st) => { st.rows.items.items[0].action.key = 'clio-code'; }, /^his user:call-review is not a modal tool button for call-review/],
  ])('%s', (_n, uid, mut, msg) => {
    expect(drift(uid, mut)).toEqual([typeof msg === 'string' ? msg : expect.stringMatching(msg)]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('BEFORE / AFTER / DRIFT', () => {
  test.each([0, 1, 3, 5, 6, 22])('user %i: as recorded is BEFORE; the planned end state is AFTER; an edit since is DRIFT', (uid) => {
    const st = stateOf(uid), env = envOf(uid);
    expect(S.classify(uid, st, exp(uid), env).state).toBe('BEFORE');
    const after = S.predicted(st, S.planUser(uid, st, env));
    expect(S.classify(uid, after, exp(uid), env)).toEqual({ state: 'AFTER', problems: [] });
    // drift after the end state: an edited document, or the custom tab back
    const edited = J(after);
    if (uid === 0) edited.rows.prefs = { theme: { mode: 'dark' } };
    else if (uid === 6) edited.rows.layout.placed.home.push(edited.rows.layout.placed.home.splice(5, 1)[0]);   // his button moved off the slot
    else edited.rows.layout.placed.home.reverse();
    expect(S.classify(uid, edited, exp(uid), env).state).toBe('DRIFT');
    // the custom tab back: DRIFT — except user 0, whose only change IS the clear (back = as recorded)
    expect(S.classify(uid, { ...after, ct: J(st.ct) }, exp(uid), env).state).toBe(uid === 0 ? 'BEFORE' : 'DRIFT');
  });
  test('AFTER needs the JSON null scalar, not SQL NULL', () => {
    const st = stateOf(1), env = envOf(1);
    const after = S.predicted(st, S.planUser(1, st, env));
    expect(S.classify(1, after, exp(1), env).state).toBe('AFTER');
    expect(S.classify(1, { ...after, ctType: 'SQL NULL' }, exp(1), env)).toMatchObject({ state: 'DRIFT', after: ['user_custom_tab is SQL NULL, not the JSON null scalar'] });
  });
  test('Fred AFTER needs his layout with the swap undone to be a BEFORE layout', () => {
    const st = stateOf(6), env = envOf(6);
    const after = S.predicted(st, S.planUser(6, st, env));
    after.rows.layout.placed.home.splice(4, 1);                               // log gone: undone, custom is not after log
    expect(S.classify(6, after, exp(6), env)).toMatchObject({ state: 'DRIFT', after: ["with the swap undone, placed.home's custom is not right after {item:'log'}"] });
  });
  test('users with no custom tab: only BEFORE (as recorded) or DRIFT', () => {
    expect(S.classify(2, stateOf(2), exp(2), null).state).toBe('BEFORE');
    expect(S.classify(2, { ...stateOf(2), ct: { src: '/x' } }, exp(2), null).state).toBe('DRIFT');
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the resolver identity check', () => {
  const run = (uid, mut = () => {}, env = envOf(uid)) => {
    const st = stateOf(uid), plan = S.planUser(uid, st, env);
    const after = S.predicted(st, plan);
    mut(after, plan);
    return S.renderProblems(st, after, env, plan);
  };
  test.each([0, 1, 3, 5, 6, 22])('user %i: the planned end state passes', (uid) => {
    expect(run(uid)).toEqual([]);
  });
  test('with a firm overlay, denies, su: still identical but the slot', () => {
    const firm = { registry_overrides: { hidden: ['calendar'], locked: ['cases'], renames: { log: { label: 'History' } },
      items: [{ id: 'firm:payroll', label: 'Payroll', icon: 'money-check', action: { type: 'url', href: 'https://pay.example.com/', present: 'window' } }] } };
    for (const uid of [1, 3, 5, 22]) expect(run(uid, () => {}, ENV(['admin', 'su'], { firm, denied: ['bills'], locked: ['cases'] }))).toEqual([]);
  });
  test('fails on: an item moved', () => {
    expect(run(1, (a) => { const h = a.rows.layout.placed.home; [h[0], h[1]] = [h[1], h[0]]; }))
      .toEqual([expect.stringMatching(/^home after is \[contacts cases /)]);
  });
  test('fails on: the wrong slot (the button somewhere else on the sidebar)', () => {
    expect(run(22, (a) => { const s = a.rows.layout.placed.sidebar; const i = s.findIndex((e) => e.item === 'user:follow-ups'); s.splice(i, 1); s.push({ item: 'user:follow-ups' }); }))
      .toEqual([expect.stringMatching(/^sidebar after is .* user:follow-ups\], expected .*newClient user:follow-ups #Settings/)]);
  });
  test('fails on: the slot not filled (the button not placed on Home)', () => {
    expect(run(3, (a) => { a.rows.layout.placed.home = a.rows.layout.placed.home.filter((e) => e.item !== 'user:paint'); a.rows.layout.removed = {}; }))
      .toEqual([expect.stringMatching(/^home after is /)]);
  });
  test('fails on: a label or icon that is not the custom tab\'s', () => {
    expect(run(1, (a) => { a.rows.items.items[0].label = 'Call review'; })).toEqual([expect.stringMatching(/^user:call-review shows \["Call review","headset"/)]);
    expect(run(22, (a) => { a.rows.items.items[0].icon = 'list'; })).toEqual([expect.stringMatching(/^user:follow-ups shows \["Follow Ups","list"/)]);
  });
  test('fails on: the custom tab still there (not cleared)', () => {
    const p = run(5, (a) => { a.ct = stateOf(5).ct; });
    expect(p).toEqual(expect.arrayContaining([expect.stringMatching(/^All after is /)]));
  });
  test('fails on: Fred\'s sidebar not as the ruling (custom slot gone) — e.g. his button placed there too', () => {
    expect(run(6, (a) => { a.rows.layout.placed.sidebar = J(LAY.sidebar).map((e) => (e.item === 'custom' ? { item: 'user:call-review' } : e)); }))
      .toEqual([expect.stringMatching(/^sidebar after is .*user:call-review/)]);
  });
  test('fails on: the custom tab not visible before on a surface the plan expects it on', () => {
    const st = stateOf(1), env = envOf(1), plan = S.planUser(1, st, env);
    const before = J(st);
    before.rows = { layout: { placed: {}, removed: { sidebar: ['custom'] } } };
    expect(S.renderProblems(before, S.predicted(st, plan), env, plan)).toEqual(expect.arrayContaining(['sidebar: the custom tab showed 0 times before, expected once']));
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('txDb (the service on the script\'s transaction)', () => {
  test('begin / commit / release are no-ops; the first failed statement poisons the rest', async () => {
    const seen = [];
    const conn = { query: async (q, p) => { seen.push([q.sql, p, q.timeout]); if (q.sql === 'BAD') { const e = new Error('x'); e.code = 'ER_LOCK_DEADLOCK'; throw e; } return [[]]; } };
    const db = S.txDb(conn);
    const c = await db.getConnection();
    await c.beginTransaction(); await c.commit(); c.release(); await c.rollback();
    await c.query('SELECT 1', [1]);
    expect(seen).toEqual([['SELECT 1', [1], 30000]]);
    await expect(db.query('BAD')).rejects.toThrow('x');
    await expect(c.query('SELECT 2')).rejects.toThrow('an earlier statement of this transaction failed (ER_LOCK_DEADLOCK) — nothing more runs in it');
    expect(seen.length).toBe(2);
  });
});
