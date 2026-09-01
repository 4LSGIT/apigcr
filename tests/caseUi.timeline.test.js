// tests/caseUi.timeline.test.js
//
// E1 — the unified Timeline tab inside public/case.html (#tabTimeline).
//
// BOOTS THE REAL PAGE in jsdom against a stub shell, with the real
// public/js/yc-sync.js and public/scripts.js evaluated first. Harness lifted
// from tests/caseUi.stepsPanel.test.js (read that file's header, and
// tests/caseUi.sync.test.js's, before editing this one — the lexical-scope and
// BroadcastChannel-ordering reasoning is theirs).
//
// WHY THIS FILE EXISTS  (the R3 lesson, applied)
//
// Everything this tab does is a RENDERING DECISION over the frozen §3.1 row
// shape, and every decision that matters looks like styling right up until it
// is wrong:
//
//   · UPCOMING/PAST IS A SPLIT ON A STRING, DELIBERATELY. starts_at is naive
//     firm-local text. The moment anyone "improves" it into `new Date(...)`,
//     rows near midnight jump groups depending on the reader's timezone — and
//     an evening user sees tomorrow's hearing filed under Past. The assertions
//     here pin the grouping AND the two orders (upcoming ascending, past
//     descending, which are opposite and easy to get backwards).
//   · THE GLYPH IS THE KIND. A thing you attend and a date you must not miss
//     are different obligations; that distinction is the entire reason kind_key
//     exists (v0.4 §0). kind_key is NULL on every event until E0b, so the
//     neutral-dot path is the COMMON case today and must not regress into
//     "render nothing" or "guess a calendar".
//   · CANCELED AND MISSED MUST NOT LOOK LIKE LIVE WORK. A struck, greyed row is
//     the only thing standing between staff and preparing for a hearing that
//     was cancelled. Asserted as classes, because a class is what the CSS hangs
//     the treatment on.
//   · THE TOGGLE MUST ACTUALLY REFETCH. Superseded rows are excluded SERVER
//     side; a toggle that only re-rendered the rows it already has would show
//     nothing new, forever, and look like "there are no superseded versions".
//   · TITLES AND LOCATIONS ARE COURT-SOURCED FREE TEXT. They arrive from parsed
//     court email and staff typing. Escaping is not hypothetical.
//
// Run:
//   npx jest tests/caseUi.timeline.test.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/case.html'), 'utf8');
const YCSYNC  = fs.readFileSync(path.join(ROOT, 'public/js/yc-sync.js'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
const TEARDOWNS = [];
afterEach(() => {
  TEARDOWNS.splice(0).forEach(fn => fn());
  bcPolyfill.reset();
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));
const CASE_ID = 'TYL6KJN8';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// Dates are computed RELATIVE TO TODAY rather than hard-coded, so the
// Upcoming/Past split is exercised for real on every run instead of silently
// becoming an all-Past test the day the fixture year goes by.
// ─────────────────────────────────────────────────────────────────────────────

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** A §3.1 row. */
function row(over) {
  return Object.assign({
    source: 'event', source_id: 100, case_id: CASE_ID,
    kind_key: 'hearing', type_key: 'confirmation_hearing',
    title: 'Confirmation Hearing',
    starts_at: `${dayOffset(7)} 10:00:00`,
    ends_at: null, all_day: false,
    status_norm: 'scheduled',
    location: 'Courtroom 1875, 211 W. Fort St.',
  }, over);
}

/** The default mixed timeline: two future, three past, both sources. */
function timeline() {
  return [
    { ...row({ source: 'appt', source_id: 20, kind_key: 'meeting', type_key: 'iss',
               title: 'Initial Strategy Session', starts_at: `${dayOffset(-30)} 14:00:00`,
               status_norm: 'held', location: 'telephone' }) },
    { ...row({ source_id: 30, kind_key: 'deadline', type_key: 'docs_deadline',
               title: 'Docs Due to Trustee', starts_at: `${dayOffset(-10)} 00:00:00`,
               all_day: true, status_norm: 'canceled', location: null }) },
    { ...row({ source: 'appt', source_id: 21, kind_key: 'meeting', type_key: 'meeting_341',
               title: '341 Meeting', starts_at: `${dayOffset(-2)} 09:00:00`,
               status_norm: 'missed', location: 'Zoom' }) },
    { ...row({ source_id: 40, starts_at: `${dayOffset(3)} 10:00:00` }) },
    { ...row({ source: 'appt', source_id: 22, kind_key: null, type_key: 'Weird New Thing',
               title: 'Weird New Thing', starts_at: `${dayOffset(20)} 11:00:00`,
               status_norm: 'scheduled', location: 'in-person' }) },
  ];
}

/** jsdom has no layout, so document.hidden is the only visibility lever. */
function setHidden(window, hidden) {
  Object.defineProperty(window.document, 'hidden', {
    configurable: true, get: () => hidden,
  });
}

/**
 * @param {object}   o
 * @param {object[]} o.rows       body of GET /api/cases/:id/events
 * @param {object[]} o.supRows    body when include_superseded=1 is sent
 * @param {boolean}  o.fails      make the timeline GET reject
 */
async function boot({ rows = null, supRows = null, fails = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/case.html?caseID=${CASE_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  setHidden(window, false);

  const calls = [];
  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    let data;
    if (url === `/api/cases/${CASE_ID}/events`) {
      if (fails) throw Object.assign(new Error('timeline exploded'), { status: 500 });
      const wantSup = !!(params && params.include_superseded);
      data = { status: 'success', events: (wantSup ? supRows : rows) || rows || timeline() };
    } else if (url === `/api/cases/${CASE_ID}/pipeline`) {
      data = { template: null, current: null, history: [], upcoming: [], stages: [] };
    } else if (/^\/api\/cases\/[^/]+$/.test(url) && method === 'GET') {
      data = params && params.include === 'appts'
        ? { appts: [] }
        : { case: { case_id: CASE_ID, case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
            clients: [], appts: [], log: [] };
    } else if (url === '/api/log') {
      data = { entries: [], total: 0 };
    } else if (url === '/api/events') {
      data = { data: [] };
    } else {
      data = { status: 'success' };
    }
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) { /* noop */ }
    }, 0);
    return data;
  };

  window.apiSend  = apiSend;
  window.firmData = { users: [], phoneLines: [], emailFrom: [],
                      settings: { case_types: { Bankruptcy: ['Chapter 7'] }, lead_sources: [] },
                      currentUser: { user: 6 }, firmTimezone: 'America/Detroit' };
  window.limit    = 100;
  window.addFile  = () => {};

  const toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async () => ({ isConfirmed: false, value: undefined }),
    close: () => {}, showLoading: () => {}, update: () => {},
    showValidationMessage: () => {}, resetValidationMessage: () => {},
    getConfirmButton: () => null, isLoading: () => false,
    stopTimer: () => {}, resumeTimer: () => {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML = noComments.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // fence: an eighth block means this harness is stale. 7 as of E1 — see the
  // identical fence in caseUi.stepsPanel.test.js / caseUi.sync.test.js.
  expect(inline.length).toBe(7);

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  // ONE eval — see the lexical-scope note in tests/caseUi.sync.test.js.
  window.eval(
    [SCRIPTS, ...inline].join('\n;\n') +
    '\n;Object.assign(window, { __t: {' +
    '  enter:  () => ctEnter(),' +
    '  load:   () => ctLoad(),' +
    '  list:   () => E("ctList"),' +
    '  toggle: () => E("ctSupToggle"),' +
    '  tab:    () => E("tabTimeline"),' +
    '  btn:    () => E("timelineButton"),' +
    '} });'
  );

  await tick(window, 80);
  return { window, calls, errors, toasts };
}

const $$ = (w, sel) => [...w.document.querySelectorAll(sel)];
const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const tlGets = calls => calls.filter(c => c.url === `/api/cases/${CASE_ID}/events`);

/** Open the tab the way the tab button does, then let the fetch settle. */
async function open(window) {
  window.__t.enter();
  await tick(window, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Laziness and the fetch shape
// ─────────────────────────────────────────────────────────────────────────────

describe('the Timeline tab is lazy', () => {
  test('page load costs NOTHING — no timeline GET until the tab is opened', async () => {
    const { calls, errors } = await boot();
    expect(errors).toEqual([]);
    expect(tlGets(calls)).toHaveLength(0);
  });

  test('opening it fetches once, with no params by default', async () => {
    const { window, calls } = await boot();
    await open(window);
    const g = tlGets(calls);
    expect(g).toHaveLength(1);
    expect(g[0].url).toBe(`/api/cases/${CASE_ID}/events`);
    expect(g[0].method).toBe('GET');
    // The URL stays bare; apiSend builds the query string (the sibling-harness
    // convention — a literal '?...' here would break every other suite).
    expect(g[0].params).toEqual({});
  });

  test('the tab button and its content div both exist and start hidden', async () => {
    const { window } = await boot();
    expect(window.__t.btn()).not.toBeNull();
    expect(window.__t.tab()).not.toBeNull();
    expect(window.__t.tab().style.display).not.toBe('block');
  });

  test('the Appointments and Events tabs are still there — this is ADDITIVE', async () => {
    const { window } = await boot();
    expect(window.document.getElementById('tabAppts')).not.toBeNull();
    expect(window.document.getElementById('tabEvents')).not.toBeNull();
    expect(window.document.getElementById('apptsTable')).not.toBeNull();
    expect(window.document.getElementById('eventsTable')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grouping and order
// ─────────────────────────────────────────────────────────────────────────────

describe('Upcoming then Past', () => {
  test('both sections render, Upcoming first', async () => {
    const { window } = await boot();
    await open(window);
    expect($$(window, '#ctList .ct-sec-head').map(txt)).toEqual(['Upcoming', 'Past']);
  });

  test('upcoming ascends, past DESCENDS — opposite orders, easy to get backwards', async () => {
    const { window } = await boot();
    await open(window);
    const secs = $$(window, '#ctList .ct-sec');
    // firstChild = the title's own text node; the source chip is a sibling span.
    const titles = (sec) => [...sec.querySelectorAll('.ct-title')]
      .map(el => el.firstChild.textContent.trim());

    // +3 then +20: soonest first.
    expect(titles(secs[0])).toEqual(['Confirmation Hearing', 'Weird New Thing']);
    // -2, -10, -30: most recent first.
    expect(titles(secs[1]))
      .toEqual(['341 Meeting', 'Docs Due to Trustee', 'Initial Strategy Session']);
  });

  test('appts and court events INTERLEAVE — the whole point of the tab', async () => {
    const { window } = await boot();
    await open(window);
    const srcs = $$(window, '#ctList .ct-row .ct-src').map(txt);
    // Not all appts then all events: the sources alternate by date.
    expect(srcs).toEqual(['court', 'appt', 'appt', 'court', 'appt']);
  });

  test("today counts as Upcoming, not Past", async () => {
    // The boundary is `>= today`. A hearing at 9am is still today's hearing at
    // 4pm, and burying it under Past is how it gets missed.
    const { window } = await boot({
      rows: [row({ source_id: 1, starts_at: `${dayOffset(0)} 09:00:00` })],
    });
    await open(window);
    expect($$(window, '#ctList .ct-sec-head').map(txt)).toEqual(['Upcoming']);
  });

  test('a section with nothing in it is not rendered at all', async () => {
    const { window } = await boot({
      rows: [row({ source_id: 1, starts_at: `${dayOffset(-5)} 09:00:00` })],
    });
    await open(window);
    expect($$(window, '#ctList .ct-sec-head').map(txt)).toEqual(['Past']);
  });

  test('an empty calendar says so instead of rendering empty scaffolding', async () => {
    const { window } = await boot({ rows: [] });
    await open(window);
    expect($$(window, '#ctList .ct-sec')).toHaveLength(0);
    expect(txt(window.__t.list())).toMatch(/Nothing on this case/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Glyphs
// ─────────────────────────────────────────────────────────────────────────────

describe('one glyph per KIND', () => {
  test('meeting, hearing and conference get a calendar; deadline gets a flag', async () => {
    const { window } = await boot({
      rows: [
        row({ source_id: 1, kind_key: 'meeting',    starts_at: `${dayOffset(1)} 09:00:00` }),
        row({ source_id: 2, kind_key: 'hearing',    starts_at: `${dayOffset(2)} 09:00:00` }),
        row({ source_id: 3, kind_key: 'conference', starts_at: `${dayOffset(3)} 09:00:00` }),
        row({ source_id: 4, kind_key: 'deadline',   starts_at: `${dayOffset(4)} 09:00:00` }),
      ],
    });
    await open(window);
    const g = $$(window, '#ctList .ct-glyph');
    expect(g.map(el => el.className)).toEqual([
      'ct-glyph ct-glyph-meeting fa-solid fa-calendar-check',
      'ct-glyph ct-glyph-hearing fa-solid fa-calendar-day',
      'ct-glyph ct-glyph-conference fa-solid fa-calendar-day',
      'ct-glyph ct-glyph-deadline fa-solid fa-flag',
    ]);
    // The deadline is visually distinct from the three you attend — that IS the
    // kind axis (v0.4 §0), not decoration.
    expect(g[3].className).toMatch(/fa-flag/);
    expect(g.slice(0, 3).every(el => /fa-calendar/.test(el.className))).toBe(true);
  });

  test('a NULL kind_key gets the neutral dot — the COMMON case until E0b', async () => {
    const { window } = await boot({
      rows: [row({ source_id: 1, kind_key: null, starts_at: `${dayOffset(1)} 09:00:00` })],
    });
    await open(window);
    const g = $$(window, '#ctList .ct-glyph');
    expect(g).toHaveLength(1);
    expect(g[0].className).toBe('ct-glyph ct-glyph-unknown fa-solid fa-circle');
    expect(g[0].getAttribute('title')).toBe('Unclassified');
  });

  test('an unrecognized kind falls back to the dot rather than throwing', async () => {
    const { window, errors } = await boot({
      rows: [row({ source_id: 1, kind_key: 'sometime_future_kind',
                   starts_at: `${dayOffset(1)} 09:00:00` })],
    });
    await open(window);
    expect(errors).toEqual([]);
    expect($$(window, '#ctList .ct-glyph-unknown')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status treatment
// ─────────────────────────────────────────────────────────────────────────────

describe('status treatment', () => {
  test('each status_norm hangs its own class on the row', async () => {
    const { window } = await boot();
    await open(window);
    const cls = $$(window, '#ctList .ct-row').map(r => r.className);
    expect(cls).toEqual([
      'ct-row ct-st-scheduled',   // +3  hearing
      'ct-row ct-st-scheduled',   // +20 unknown-kind appt
      'ct-row ct-st-missed',      // -2  341 no-show
      'ct-row ct-st-canceled',    // -10 canceled deadline
      'ct-row ct-st-held',        // -30 attended ISS
    ]);
  });

  test('a NULL status_norm renders plain — unknown must not look like a claim', async () => {
    // The 6 legacy blank-enum appts. No tick, no strike, no warning colour.
    const { window } = await boot({
      rows: [row({ source: 'appt', source_id: 1, status_norm: null,
                   starts_at: `${dayOffset(-5)} 09:00:00` })],
    });
    await open(window);
    const r = $$(window, '#ctList .ct-row')[0];
    expect(r.className).toBe('ct-row');
    expect(r.className).not.toMatch(/ct-st-/);
  });

  test('the stylesheet actually strikes canceled and missed rows', async () => {
    // The class is only worth asserting if a rule hangs off it. This catches a
    // renamed class that leaves the CSS orphaned and the row looking live.
    const { window } = await boot();
    const css = [...window.document.querySelectorAll('style')].map(s => s.textContent).join('\n');
    expect(css).toMatch(/\.ct-st-canceled \.ct-title \{[^}]*line-through/);
    expect(css).toMatch(/\.ct-st-missed \.ct-title \{[^}]*line-through/);
    expect(css).toMatch(/\.ct-st-held \.ct-title::after/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Row content
// ─────────────────────────────────────────────────────────────────────────────

describe('row content', () => {
  test('an all-day row shows the date only — no invented midnight', async () => {
    const { window } = await boot({
      rows: [row({ source_id: 1, all_day: true, starts_at: `${dayOffset(5)} 00:00:00` })],
    });
    await open(window);
    const when = txt($$(window, '#ctList .ct-when')[0]);
    expect(when).toMatch(/all day/);
    expect(when).not.toMatch(/12:00|00:00/);
  });

  test('a timed row shows a 12-hour local time', async () => {
    const { window } = await boot({
      rows: [row({ source_id: 1, all_day: false, starts_at: `${dayOffset(5)} 14:05:00` })],
    });
    await open(window);
    expect(txt($$(window, '#ctList .ct-when')[0])).toMatch(/2:05 PM$/);
  });

  test("the source chip says appt / court, not 'event'", async () => {
    const { window } = await boot();
    await open(window);
    const chips = $$(window, '#ctList .ct-src');
    expect([...new Set(chips.map(txt))].sort()).toEqual(['appt', 'court']);
    expect(chips.some(c => c.className.includes('ct-src-event'))).toBe(true);
  });

  test('location renders when present and is simply absent when null', async () => {
    const { window } = await boot();
    await open(window);
    const subs = $$(window, '#ctList .ct-sub').map(txt);
    expect(subs.some(s => /Courtroom 1875/.test(s))).toBe(true);
    // The canceled all-day deadline has location null — no stray separator.
    const deadlineSub = subs.find(s => /all day/.test(s));
    expect(deadlineSub).not.toMatch(/·\s*$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The superseded toggle
// ─────────────────────────────────────────────────────────────────────────────

describe('include superseded', () => {
  test('ticking it REFETCHES with the flag — it is a server-side filter', async () => {
    const { window, calls } = await boot();
    await open(window);
    expect(tlGets(calls)).toHaveLength(1);

    const t = window.__t.toggle();
    t.checked = true;
    t.dispatchEvent(new window.Event('change'));
    await tick(window, 40);

    const g = tlGets(calls);
    expect(g).toHaveLength(2);
    expect(g[1].params).toEqual({ include_superseded: 1 });
  });

  test('unticking refetches WITHOUT the flag', async () => {
    const { window, calls } = await boot();
    await open(window);
    const t = window.__t.toggle();
    t.checked = true;  t.dispatchEvent(new window.Event('change')); await tick(window, 40);
    t.checked = false; t.dispatchEvent(new window.Event('change')); await tick(window, 40);
    expect(tlGets(calls)[2].params).toEqual({});
  });

  test('a superseded EVENT collapses under the live row that replaced it', async () => {
    const live = row({ source_id: 51, title: 'Confirmation Hearing',
                       starts_at: `${dayOffset(9)} 10:00:00` });
    const dead = row({ source_id: 41, title: 'Confirmation Hearing',
                       starts_at: `${dayOffset(2)} 10:00:00`, status_norm: 'canceled',
                       superseded: true, superseded_by_event_id: 51,
                       supersede_reason: 'duplicate' });
    const { window } = await boot({ rows: [live], supRows: [live, dead] });
    await open(window);
    const t = window.__t.toggle();
    t.checked = true; t.dispatchEvent(new window.Event('change'));
    await tick(window, 40);

    // ONE top-level row, with the predecessor tucked inside it.
    expect($$(window, '#ctList .ct-row')).toHaveLength(1);
    const det = $$(window, '#ctList .ct-sup');
    expect(det).toHaveLength(1);
    expect(txt(det[0].querySelector('summary'))).toBe('1 superseded version');
    expect(txt(det[0].querySelector('.ct-sup-item'))).toMatch(/duplicate/);
    // Collapsed by design — "modest, no chain-graph UI".
    expect(det[0].hasAttribute('open')).toBe(false);
  });

  test('an APPT tombstone greys INLINE — it has no successor to collapse under', async () => {
    // v0.4 §3.4's asymmetry made visible: events chain, appts tombstone.
    const { window } = await boot({
      rows: [],
      supRows: [row({ source: 'appt', source_id: 20, title: 'Initial Strategy Session',
                      starts_at: `${dayOffset(-4)} 14:00:00`, status_norm: null,
                      superseded: true, location: 'telephone' })],
    });
    await open(window);
    const t = window.__t.toggle();
    t.checked = true; t.dispatchEvent(new window.Event('change'));
    await tick(window, 40);

    const rows = $$(window, '#ctList .ct-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].className).toMatch(/ct-row-tomb/);
    expect($$(window, '#ctList .ct-sup')).toHaveLength(0);
  });

  test('a predecessor whose successor is absent renders inline, never silently dropped', async () => {
    const { window } = await boot({
      rows: [],
      supRows: [row({ source_id: 41, starts_at: `${dayOffset(-3)} 10:00:00`,
                      status_norm: 'canceled', superseded: true,
                      superseded_by_event_id: 999, supersede_reason: 'rescheduled' })],
    });
    await open(window);
    const t = window.__t.toggle();
    t.checked = true; t.dispatchEvent(new window.Event('change'));
    await tick(window, 40);
    expect($$(window, '#ctList .ct-row')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Escaping and failure
// ─────────────────────────────────────────────────────────────────────────────

describe('safety', () => {
  test('title and location are ESCAPED — both are court-sourced free text', async () => {
    const { window, errors } = await boot({
      rows: [row({
        source_id: 1,
        title: '<img src=x onerror="window.__pwned=1">Hearing & Motion',
        location: '<script>window.__pwned2=1</script>Courtroom "A"',
        starts_at: `${dayOffset(4)} 10:00:00`,
      })],
    });
    await open(window);
    expect(errors).toEqual([]);
    expect(window.__pwned).toBeUndefined();
    expect(window.__pwned2).toBeUndefined();
    expect(window.__t.list().querySelector('img')).toBeNull();
    expect(window.__t.list().querySelector('script')).toBeNull();
    // The text still reads correctly, entities and all.
    expect(txt($$(window, '#ctList .ct-title')[0])).toMatch(/Hearing & Motion/);
    expect(txt($$(window, '#ctList .ct-sub')[0])).toMatch(/Courtroom "A"/);
  });

  test('a hostile supersede_reason is escaped too', async () => {
    const live = row({ source_id: 51, starts_at: `${dayOffset(9)} 10:00:00` });
    const { window, errors } = await boot({
      rows: [live],
      supRows: [live, row({ source_id: 41, starts_at: `${dayOffset(2)} 10:00:00`,
                            superseded: true, superseded_by_event_id: 51,
                            supersede_reason: '<img src=x onerror="window.__pwned3=1">' })],
    });
    await open(window);
    const t = window.__t.toggle();
    t.checked = true; t.dispatchEvent(new window.Event('change'));
    await tick(window, 40);
    expect(errors).toEqual([]);
    expect(window.__pwned3).toBeUndefined();
    expect(window.__t.list().querySelector('img')).toBeNull();
  });

  test('a failed load shows a message and NEVER breaks the page (the R3 lesson)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { window, errors } = await boot({ fails: true });
      await open(window);
      expect(errors).toEqual([]);                       // nothing escaped
      expect(txt(window.__t.list())).toMatch(/Timeline unavailable/);
      // The rest of the page is intact and still interactive.
      expect(window.document.getElementById('tabOverview')).not.toBeNull();
      expect(window.document.getElementById('apptsTable')).not.toBeNull();
    } finally { spy.mockRestore(); }
  });

  test('re-entering the tab refreshes rather than going stale', async () => {
    const { window, calls } = await boot();
    await open(window);
    await open(window);
    expect(tlGets(calls)).toHaveLength(2);
  });
});
