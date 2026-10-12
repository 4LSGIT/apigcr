/**
 * tests/calendarUi.sync.test.js
 *
 * BOOTS public/calendar.html for real, in jsdom, against a stub shell and a
 * stub FullCalendar — with the REAL public/js/yc-sync.js and public/scripts.js
 * evaluated first. (tests/pipelineBoardUi.sync.test.js is the harness pattern.)
 *
 * WHY THIS FILE EXISTS
 *
 * Slice 3 gives the calendar its FIRST remote refresh. Before it, the grid
 * redrew only on a view change, a filter toggle, or an appt created from its
 * own dateClick — cancel an appointment anywhere else and a ghost sat on the
 * grid until someone navigated. Three things can go wrong, all run-time-only:
 *
 *   · THE VISIBILITY FENCE. This page lives in a Swal modal, so it is either
 *     on screen or does not exist — which means the ONLY way to be stale is a
 *     backgrounded browser window. That is exactly the cross-window case this
 *     slice exists for, so the stale flag is not a nicety here, it is the
 *     feature.
 *   · THE ECHO GUARD. Creating an appointment from the grid already refetches
 *     (onCreated), and the bus then announces that same create back.
 *   · §3.6. refetchEvents() ends in a GET of /api/calendar-feed. If that could
 *     be sniffed into an emit the bus would eat the browser.
 *
 * ON MODELLING BroadcastChannel ORDERING: see pipelineBoardUi.sync.test.js's
 * header. The stub apiSend defers its sniff by one macrotask because in
 * production the sniff runs in the SHELL's realm and reaches this frame over
 * BroadcastChannel. Do not "simplify" it away.
 *
 *   npx jest tests/calendarUi.sync.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/calendar.html'), 'utf8');
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

/** jsdom has no layout, so document.hidden is the only visibility lever here. */
function setHidden(window, hidden) {
  Object.defineProperty(window.document, 'hidden', {
    configurable: true, get: () => hidden,
  });
}

async function boot(opts = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.4lsg.com/calendar.html',
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  // jsdom has no matchMedia at all; init() guards with `window.matchMedia &&`,
  // so the default boot is the DESKTOP path. narrow:true models a phone.
  if (opts.narrow) window.matchMedia = () => ({ matches: true });

  // Pre-seed localStorage (7c view persistence) before any page code runs.
  if (opts.localStorage) {
    for (const [k, v] of Object.entries(opts.localStorage)) window.localStorage.setItem(k, v);
  }

  // jsdom boots at visibilityState 'prerender' (document.hidden === true). A
  // real foreground window is 'visible', and calVisible() reads document.hidden
  // — without this every test would silently exercise the OFF-SCREEN path.
  setHidden(window, false);

  const calls = [];
  window.apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    const data = url === '/api/calendar-feed'
      ? { items: [], providers: [{ id: 1, name: 'Stuart', color: '#2563eb' }], free_skipped: false }
      : { status: 'success' };
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) { /* noop */ }
    }, 0);
    return data;
  };
  window.firmData = { users: [{ user: 1, user_name: 'Stuart' }], phoneLines: [], emailFrom: [],
                      settings: {}, currentUser: { user: 1 }, firmTimezone: 'America/Detroit' };
  window.addFile = () => {};
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    fire: async () => ({ isConfirmed: false }),
    close: () => {},
  };

  // Stub FullCalendar: render() is a no-op, refetchEvents() drives the real
  // feed function so a refetch shows up as an /api/calendar-feed call. The
  // constructor options and what the feed hands successCallback are captured
  // for the U9b-P3 assertions (view defaults, height, kind filtering).
  let eventsFn = null;
  let fcOpts   = null;
  let fcItems  = null;
  window.FullCalendar = {
    Calendar: function (el, calOpts) {
      fcOpts = calOpts;
      eventsFn = calOpts.events;
      this.refetchEvents = () => eventsFn(
        { start: new Date('2026-08-24'), end: new Date('2026-08-31') },
        (items) => { fcItems = items; }, () => {});
      // Real FullCalendar fetches the feed during render (its initial
      // datesSet). Modelling that matters: it is what makes the boot fetch
      // count 1 rather than 0, and it goes through the events function
      // DIRECTLY — not through calRefetch() — so it does NOT stamp the echo
      // fence, which is correct. At boot there is nothing to echo.
      this.render = () => this.refetchEvents();
    },
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML =
    noComments.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(inline.length).toBe(1);   // fence: a second block means this harness is stale

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  // ONE eval — scripts.js and the inline block are separate <script> tags in
  // the browser and share one global lexical environment; separate evals would
  // not. The trailing Object.assign is a test-only window onto `let` bindings
  // that stay lexical in the shipped file.
  window.eval(
    [SCRIPTS, ...inline].join('\n;\n') +
    '\n;Object.assign(window, { __t: {' +
    '  isStale:     () => calStale,' +
    '  ageRefetch:  () => { calLastRefetch = 0; },' +
    '  becameVisible: () => window.ycBecameVisible(),' +
    '} });'
  );

  await tick(window, 50);
  return { window, calls, errors,
           fc: { opts: () => fcOpts, items: () => fcItems } };
}

const feedGets = calls => calls.filter(c => c.url === '/api/calendar-feed');

describe('calendar boots', () => {
  test('renders and fetches the feed once', async () => {
    const { calls, errors } = await boot();
    expect(errors).toEqual([]);
    expect(feedGets(calls).length).toBe(1);
  });
});

describe('appt:* / event:* subscriber', () => {
  test('an appt change refetches the feed — the capability this slice adds', async () => {
    const { window, calls } = await boot();
    window.__t.ageRefetch();                       // past the echo fence
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(2);
  });

  test('an event change refetches too', async () => {
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    window.YC.emit('event:12', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(2);
  });

  test('a checklistView VALUE emit refetches like a marker — never parsed', async () => {
    // appt:* carries both marker and value traffic (design v2.3 E3). A reader
    // that branched on field names would ignore this one.
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    window.YC.emit('appt:55', { appt_note: 'called client' }, 'checklistView:saveBody');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(2);
  });

  test('a burst is debounced into ONE refetch', async () => {
    // A reschedule announces two appointments; a note save announces twice.
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    window.YC.emit('appt:58', { yc_refetch: 1 }, 'test');
    window.YC.emit('appt:59', { yc_refetch: 1 }, 'test');
    window.YC.emit('event:12', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(2);
  });

  test('case:* is ignored — wrong address space', async () => {
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    window.YC.emit('case:AAAA', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(1);
  });

  test('THE ECHO GUARD: a message right after our OWN refetch is dropped', async () => {
    // The shape this guards: onDateClick's `onCreated: calRefetch` already
    // redraws the grid, and the bus then announces that same create back.
    // Without the fence, creating an appointment from the grid costs two feed
    // fetches. Note the boot fetch does NOT stamp — FullCalendar's initial
    // render goes straight to the events function — which is right: at boot
    // there is no write of ours to echo.
    const { window, calls } = await boot();
    expect(feedGets(calls).length).toBe(1);

    window.calRefetch();                   // as onCreated does
    expect(feedGets(calls).length).toBe(2);

    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(2);   // echo dropped
  });
});

describe('the visibility fence', () => {
  test('hidden window → mark stale, do NOT refetch', async () => {
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(feedGets(calls).length).toBe(1);
    expect(window.__t.isStale()).toBe(true);
  });

  test('coming back to a stale calendar refetches once', async () => {
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    setHidden(window, false);
    window.__t.ageRefetch();
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 50);
    expect(feedGets(calls).length).toBe(2);
    expect(window.__t.isStale()).toBe(false);
  });

  test('visibilitychange while STILL hidden KEEPS the flag', async () => {
    // The board's rule: never spend the stale flag on a grid nobody can see,
    // or the later ycBecameVisible finds nothing to do.
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 50);
    expect(feedGets(calls).length).toBe(1);
    expect(window.__t.isStale()).toBe(true);
  });

  test('window.ycBecameVisible is defined and answers a stale flag', async () => {
    // It cannot fire today — the calendar is Swal-hosted, not tab-hosted, so
    // the shell's pingBecameVisible never reaches it (design v2.3 E12). Defined
    // so the day it moves into a real tab, it is already correct.
    const { window, calls } = await boot();
    expect(typeof window.ycBecameVisible).toBe('function');
    window.__t.ageRefetch();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    setHidden(window, false);
    window.__t.ageRefetch();
    window.__t.becameVisible();
    await tick(window, 50);
    expect(feedGets(calls).length).toBe(2);
  });
});

describe('U9b-P3 — grid upgrades', () => {
  const clickChip = (window, kind) =>
    window.document.querySelector(`#calKinds .cal-chip[data-kind="${kind}"]`)
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const chipsOn = (window) =>
    [...window.document.querySelectorAll('#calKinds .cal-chip.on')].map(c => c.dataset.kind);

  test('fills the host: height 100%; desktop default stays timeGridWeek with the unchanged toolbar', async () => {
    const { fc } = await boot();
    expect(fc.opts().height).toBe('100%');
    expect(fc.opts().initialView).toBe('timeGridWeek');
    expect(fc.opts().headerToolbar.right).toBe('dayGridMonth,timeGridWeek,timeGridDay');
  });

  test('narrow boot: listWeek is the default and Month/Week/Day stay reachable', async () => {
    const { fc } = await boot({ narrow: true });
    expect(fc.opts().initialView).toBe('listWeek');
    expect(fc.opts().headerToolbar.right).toBe('dayGridMonth,timeGridWeek,timeGridDay,listWeek');
  });

  test('kind chips follow the calx contract (All resets, kinds toggle, empty re-lights All) and every change refetches', async () => {
    const { window, calls } = await boot();
    expect(chipsOn(window)).toEqual(['']);

    clickChip(window, 'deadline');
    expect(chipsOn(window)).toEqual(['deadline']);
    clickChip(window, 'hearing');                      // DOM order: hearing before deadline
    expect(chipsOn(window)).toEqual(['hearing', 'deadline']);
    clickChip(window, 'hearing');
    clickChip(window, 'deadline');
    expect(chipsOn(window)).toEqual(['']);             // emptied → All re-lights
    clickChip(window, '');
    expect(chipsOn(window)).toEqual(['']);

    await tick(window, 20);
    expect(feedGets(calls).length).toBe(6);            // boot + one per click
  });

  test("the show param drops tables no selected kind needs: Deadlines-only sends no 'taken', Meetings-only no 'events'", async () => {
    const { window, calls } = await boot();
    clickChip(window, 'deadline');
    await tick(window, 20);
    expect(feedGets(calls).pop().params.show).toBe('events,blocked');

    clickChip(window, 'deadline');                     // back to All
    clickChip(window, 'meeting');
    await tick(window, 20);
    expect(feedGets(calls).pop().params.show).toBe('taken,blocked');
  });

  test('kind slicing is client-side on event_kind; a kindless event files under Other; blocks always pass', async () => {
    const { window, fc } = await boot();
    window.apiSend = async () => ({
      providers: [], free_skipped: false,
      items: [
        { id: 'appt-1',  extendedProps: { kind: 'appt' } },
        { id: 'event-1', extendedProps: { kind: 'event', event_kind: 'deadline' } },
        { id: 'event-2', extendedProps: { kind: 'event', event_kind: 'hearing' } },
        { id: 'event-3', extendedProps: { kind: 'event', event_kind: null } },
        { id: 'fb-1',    extendedProps: { kind: 'block' } },
      ],
    });

    clickChip(window, 'deadline');
    await tick(window, 20);
    expect(fc.items().map(i => i.id)).toEqual(['event-1', 'fb-1']);

    clickChip(window, 'other');
    await tick(window, 20);
    expect(fc.items().map(i => i.id)).toEqual(['event-1', 'event-3', 'fb-1']);

    clickChip(window, '');
    await tick(window, 20);
    expect(fc.items().map(i => i.id))
      .toEqual(['appt-1', 'event-1', 'event-2', 'event-3', 'fb-1']);
  });

  test("the event popover's confirm opens the shell's event editor — the same showEvent the calx List rows use", async () => {
    const { window } = await boot();
    let cfg = null;
    window.Swal.fire = async (c) => { cfg = c; return { isConfirmed: true, isDenied: false }; };
    const opened = [];
    window.showEvent = (id) => opened.push(id);

    window.eventPopover({
      title: 'Docs Deadline', allDay: true, start: new Date(2026, 9, 14),
      extendedProps: { kind: 'event', event_id: 42, event_kind: 'deadline', link_type: null, link_id: null },
    });
    await tick(window, 10);
    expect(cfg.confirmButtonText).toBe('Open Event');
    expect(cfg.showDenyButton).toBe(false);            // no link → no deep-link button
    expect(opened).toEqual([42]);
  });

  test('the deep links moved to the deny button and still work', async () => {
    const { window } = await boot();
    window.Swal.fire = async (c) => ({ isConfirmed: false, isDenied: !!c.showDenyButton });
    const files = [];
    window.addFile = (...a) => files.push(a);

    window.eventPopover({
      title: 'Hearing', allDay: true, start: new Date(2026, 9, 14),
      extendedProps: { kind: 'event', event_id: 7, event_kind: 'hearing',
                       link_type: 'case', link_id: 'ayx7GJ7j', link_label: '26-47542' },
    });
    await tick(window, 10);
    expect(files).toEqual([['26-47542', 'case', 'ayx7GJ7j']]);
  });

  test('7c: a valid remembered view wins the boot; junk or nothing falls back to the first-boot defaults', async () => {
    const a = await boot({ localStorage: { 'yc-calendar-grid-view': 'dayGridMonth' } });
    expect(a.fc.opts().initialView).toBe('dayGridMonth');

    const b = await boot({ localStorage: { 'yc-calendar-grid-view': 'bogusView' } });
    expect(b.fc.opts().initialView).toBe('timeGridWeek');      // desktop first-boot stays week

    const c = await boot({ narrow: true, localStorage: { 'yc-calendar-grid-view': 'timeGridDay' } });
    expect(c.fc.opts().initialView).toBe('timeGridDay');       // saved beats the narrow default too
  });

  test('7c: datesSet persists the view type per browser', async () => {
    const { window, fc } = await boot();
    fc.opts().datesSet({ view: { type: 'timeGridDay' } });
    expect(window.localStorage.getItem('yc-calendar-grid-view')).toBe('timeGridDay');
  });

  test('slot click offers New Event too: date-part prefill, onSaved wired to calRefetch; the appt path keeps its datetime prefill', async () => {
    const { window } = await boot();
    const slot = { allDay: false, dateStr: '2026-10-14T10:30:00-04:00',
                   date: new Date(2026, 9, 14, 10, 30) };

    window.Swal.fire = async () => ({ isConfirmed: false, isDenied: true });
    const evCalls = [];
    window.newEventDialog = (o) => evCalls.push(o);
    window.onDateClick(slot);
    await tick(window, 10);
    expect(evCalls).toHaveLength(1);
    expect(evCalls[0].defaultDate).toBe('2026-10-14');
    expect(evCalls[0].onSaved).toBe(window.calRefetch);

    window.Swal.fire = async () => ({ isConfirmed: true, isDenied: false });
    const apCalls = [];
    window.newApptDialog = (o) => apCalls.push(o);
    window.onDateClick(slot);
    await tick(window, 10);
    expect(apCalls).toHaveLength(1);
    expect(apCalls[0].defaultDate).toBe('2026-10-14T10:30');
    expect(apCalls[0].onCreated).toBe(window.calRefetch);
  });
});

describe('§3.6 — the handler must not emit', () => {
  test('a refetch produces no bus traffic of its own', async () => {
    const { window, calls } = await boot();
    window.__t.ageRefetch();
    const seen = [];
    window.YC.on('appt:*', '*', () => seen.push(1));
    window.YC.on('event:*', '*', () => seen.push(1));

    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(feedGets(calls).length).toBe(2);
    // One message in, one message seen. The GET the handler made was not
    // sniffed into a second — _sniff's method gate drops GET.
    expect(seen.length).toBe(1);
    expect(feedGets(calls).every(c => c.method === 'GET')).toBe(true);
  });
});
