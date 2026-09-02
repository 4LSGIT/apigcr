// tests/unifiedEventsU9.eventform.test.js
//
/**
 * Unified Events U9 — resolution on public/eventform.html.
 *
 * BOOTS THE REAL PAGE in jsdom against a stub shell + stub Swal, the harness
 * shape from tests/unifiedEventsU2b.pickers.test.js.
 *
 * WHAT IS WORTH ASSERTING HERE
 *
 *   · THE KIND SWITCH. A deadline asks met/moot; every other kind completes
 *     silently as it always has. Both halves matter: asking a hearing "was it
 *     met or moot?" is meaningless, and NOT asking a deadline throws away the
 *     one distinction §3.7 exists to record. The switch reads `events.kind`,
 *     and an unmapped row (kind 'other') must take the silent path.
 *
 *   · THE 400 FALLBACK. This page is cached in browsers and the `{resolution}`
 *     parameter is young (U6a). A copy of this file running against a
 *     rolled-back server would otherwise turn "mark this deadline met" into a
 *     red toast and a deadline that stays open — bricked by an optional
 *     parameter. The retry is what makes the parameter genuinely optional.
 *     Equally: a 500 must NOT be retried, or a real server fault turns into
 *     two writes and a success toast.
 *
 *   · THE DISPLAY FALLBACK. `event_resolution` is NULL on every row written
 *     before U6a, so this page must show the same word the Calendar tab's
 *     badge shows for the same row — which means mirroring
 *     caseEventService._deriveState exactly. Asserted against that service's
 *     real output rather than against a copy of the rules, so the two cannot
 *     drift without a failing test.
 *
 * Run:  npx jest tests/unifiedEventsU9.eventform.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/eventform.html'), 'utf8');
const SCRIPTS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms = 30) => new Promise((r) => w.setTimeout(r, ms));

function evRow(over) {
  return Object.assign({
    event_id: 500,
    event_type: 'Proof of Claim Deadline',
    event_title: 'Proof of Claim Deadline — Herig',
    event_date: '2026-09-10T00:00:00.000Z',
    event_time: null,
    event_all_day: 1,
    event_length: null,
    event_location: null,
    event_link: null,
    event_status: 'Scheduled',
    event_resolution: null,
    kind: 'deadline',
    type_key: 'poc_due',
    event_with: null,
    event_link_type: 'case',
    event_link_id: 'TYL6KJN8',
    link_type: 'case', link_id: 'TYL6KJN8', link_label: '26-46639-mar',
    event_gcal: null, event_calendar_id: null,
    event_create_date: '2026-08-01T10:00:00.000Z',
    event_created_by: 6,
    event_updated_at: null,
  }, over);
}

/**
 * Boot eventform.html for real.
 *
 * The DOM is the REAL document, not an empty one: the page's wiring block
 * addEventListener's a dozen fields by id at parse time, so a stub body would
 * throw before a single assertion ran. `runScripts: 'outside-only'` gives a
 * window that can eval but does not fetch or run the page's own <script src>
 * tags (bootstrap, sweetalert, diag, scripts.js) — those are supplied below,
 * stubbed or evaluated, in the order the browser would.
 *
 * `patchFail` scripts the status endpoints: null resolves, or an
 * {status, message} the stub throws in the shape index.html's apiSend throws
 * (name 'ApiError', numeric `.status`) — the exact object the page branches on.
 */
function boot({ row = evRow(), patchFail = null } = {}) {
  const dom = new JSDOM(HTML, {
    url: 'https://app.4lsg.com/eventform.html?eventID=500',
    runScripts: 'outside-only',
  });
  DOMS.push(dom);
  const { window } = dom;

  const calls = [];
  window.apiSend = async (url, method, body) => {
    calls.push({ url, method, body });
    if (/\/(complete|cancel)$/.test(url)) {
      if (patchFail && Object.prototype.hasOwnProperty.call(body || {}, 'resolution')) {
        const err = new Error(patchFail.message || 'nope');
        err.name = 'ApiError';
        err.status = patchFail.status;
        throw err;
      }
      return { status: 'success', title: 'Done!', message: 'ok', data: row };
    }
    if (url.startsWith('/api/events/')) return { status: 'success', data: row };
    if (url.startsWith('/api/calendar-types')) return { status: 'success', data: [] };
    return { status: 'success' };
  };
  window.firmData = { users: [{ user: 1, user_name: 'Stuart', does_appts: 1 }], settings: {}, currentUser: { user: 1 } };

  // The page reaches the shell through window.top; jsdom makes top === window.
  const swal = { last: null, toasts: [] };
  window.Swal = {
    mixin: () => ({ fire: (cfg) => swal.toasts.push(cfg) }),
    isLoading: () => false,
    showValidationMessage: (m) => { swal.validation = m; },
    getHtmlContainer: () => window.document.querySelector('.swal2-popup'),
    close: () => {},
    /** Captures the config and hands back a resolver the test drives. */
    fire: (cfg) => {
      swal.last = cfg;
      const host = window.document.createElement('div');
      host.className = 'swal2-popup';
      host.innerHTML = cfg.html || '';
      window.document.body.appendChild(host);
      if (cfg.didOpen) cfg.didOpen();
      return {
        then: (fn) => {
          swal.resolve = async (inputValue) => {
            const value = cfg.preConfirm ? await cfg.preConfirm(inputValue) : true;
            return fn({ isConfirmed: value !== false, value, isDenied: false });
          };
          return { catch: () => {} };
        },
      };
    },
  };

  // scripts.js is a classic <script> in production, so its top-level `const E`
  // is global to the page's code; indirect eval keeps it lexical. Mirror it,
  // then evaluate the page's own block — the same order the browser uses, and
  // the reason the page can call E() and eventComplete() at all.
  window.eval(SCRIPTS + '\n;window.E = E;');
  const blocks = [...HTML.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(blocks).toHaveLength(1);          // one inline block; if that changes, so must this
  window.eval(blocks[0]);
  return { window, calls, swal };
}

const patches = (calls) => calls.filter((c) => /\/(complete|cancel)$/.test(c.url));


describe('resolution display', () => {
  const svc = require('../services/caseEventService');

  /**
   * The page's word must equal the read layer's word for the same row. Built
   * from the SERVICE, not from a transcription of its rules — a copy would
   * pass forever after the service changed.
   */
  const serviceResolution = (row) =>
    svc._deriveState('event', row, row.kind, false).resolution;

  test.each([
    ['Completed deadline, nothing stored', { event_status: 'Completed', kind: 'deadline', event_resolution: null }, 'Met'],
    ['Completed hearing, nothing stored',  { event_status: 'Completed', kind: 'hearing',  event_resolution: null }, 'Held'],
    ['Completed deadline, stored missed',  { event_status: 'Completed', kind: 'deadline', event_resolution: 'missed' }, 'Missed'],
    ['Canceled deadline, stored moot',     { event_status: 'Canceled',  kind: 'deadline', event_resolution: 'moot' }, 'Moot'],
    ['Canceled deadline, nothing stored',  { event_status: 'Canceled',  kind: 'deadline', event_resolution: null }, 'Cancelled'],
  ])('%s → the bar names the outcome', async (_name, over, wordStart) => {
    const row = evRow(over);
    const { window } = boot({ row });
    await tick(window);
    const bar = window.document.getElementById('efActionBar');
    expect(bar.textContent).toContain('Outcome: ');
    expect(bar.textContent).toContain(wordStart);
    // …and it is the SERVICE's answer, not a second opinion.
    expect(window.efResolution(row)).toBe(serviceResolution(row));
  });

  test('a missed deadline is the only outcome coloured red', async () => {
    const missed = boot({ row: evRow({ event_status: 'Completed', event_resolution: 'missed' }) });
    await tick(missed.window);
    const red = [...missed.window.document.getElementById('efActionBar').querySelectorAll('span')]
      .find((s) => /Missed/.test(s.textContent));
    expect(red.style.color).toBe('var(--danger)');

    const met = boot({ row: evRow({ event_status: 'Completed', event_resolution: 'met' }) });
    await tick(met.window);
    const plain = [...met.window.document.getElementById('efActionBar').querySelectorAll('span')]
      .find((s) => /Met/.test(s.textContent));
    expect(plain.style.color).not.toBe('var(--danger)');
  });

  test('a DERIVED outcome says so on hover; a stored one does not', async () => {
    // The distinction matters to whoever is auditing, not to whoever is
    // reading, so it lives in the title rather than in the line.
    const derived = boot({ row: evRow({ event_status: 'Completed', event_resolution: null }) });
    await tick(derived.window);
    const d = [...derived.window.document.getElementById('efActionBar').querySelectorAll('span')]
      .find((s) => /Outcome/.test(s.textContent));
    expect(d.title).toMatch(/Derived/);

    const stored = boot({ row: evRow({ event_status: 'Completed', event_resolution: 'met' }) });
    await tick(stored.window);
    const s = [...stored.window.document.getElementById('efActionBar').querySelectorAll('span')]
      .find((x) => /Outcome/.test(x.textContent));
    expect(s.title).toBe('');
  });

  test('a Scheduled row shows buttons and NO outcome — a live event has not ended', async () => {
    const { window } = boot({ row: evRow({ event_status: 'Scheduled' }) });
    await tick(window);
    const bar = window.document.getElementById('efActionBar');
    expect(bar.textContent).not.toContain('Outcome');
    expect(bar.querySelectorAll('button')).toHaveLength(2);
    expect(window.efResolution(evRow({ event_status: 'Scheduled' }))).toBeNull();
  });
});


describe('completing', () => {
  test('a DEADLINE is asked met/moot and sends the choice', async () => {
    const { window, calls, swal } = boot({ row: evRow({ kind: 'deadline' }) });
    await tick(window);
    window.document.getElementById('efActionBar').querySelector('button').onclick();
    expect(Object.keys(swal.last.inputOptions)).toEqual(['met', 'moot']);
    expect(swal.last.inputValue).toBe('met');          // default

    await swal.resolve('moot');
    expect(patches(calls)).toEqual([
      { url: '/api/events/500/complete', method: 'PATCH', body: { resolution: 'moot' } },
    ]);
  });

  test('the default answer is met', async () => {
    const { window, calls, swal } = boot({ row: evRow({ kind: 'deadline' }) });
    await tick(window);
    window.document.getElementById('efActionBar').querySelector('button').onclick();
    await swal.resolve('met');
    expect(patches(calls)[0].body).toEqual({ resolution: 'met' });
  });

  test("'missed' is NOT offered — it is what the nightly sweep writes, not a human", async () => {
    const { window, swal } = boot({ row: evRow({ kind: 'deadline' }) });
    await tick(window);
    window.document.getElementById('efActionBar').querySelector('button').onclick();
    expect(Object.keys(swal.last.inputOptions)).not.toContain('missed');
  });

  test.each(['hearing', 'conference', 'other', null])(
    'a %s completes SILENTLY and sends no resolution', async (kind) => {
      const { window, calls, swal } = boot({ row: evRow({ kind }) });
      await tick(window);
      window.document.getElementById('efActionBar').querySelector('button').onclick();
      expect(swal.last.input).toBeUndefined();         // no radio — a plain confirm
      await swal.resolve();
      const p = patches(calls);
      expect(p).toHaveLength(1);
      expect(p[0].url).toBe('/api/events/500/complete');
      // The server writes the §3.7 default. Sending one from here would be
      // this page guessing at an answer nobody was asked for.
      expect(p[0].body == null || !('resolution' in p[0].body)).toBe(true);
    });
});


describe('cancelling', () => {
  test('a DEADLINE offers the moot checkbox and sends moot when ticked', async () => {
    const { window, calls, swal } = boot({ row: evRow({ kind: 'deadline' }) });
    await tick(window);
    window.document.getElementById('efActionBar').querySelectorAll('button')[1].onclick();
    const box = window.document.getElementById('efMoot');
    expect(box).toBeTruthy();
    box.checked = true;
    await swal.resolve();
    expect(patches(calls)[0].body).toEqual({ delete_gcal: true, resolution: 'moot' });
  });

  test('unticked sends cancelled — the two are different claims about the same row', async () => {
    const { window, calls, swal } = boot({ row: evRow({ kind: 'deadline' }) });
    await tick(window);
    window.document.getElementById('efActionBar').querySelectorAll('button')[1].onclick();
    await swal.resolve();
    expect(patches(calls)[0].body).toEqual({ delete_gcal: true, resolution: 'cancelled' });
  });

  test('a non-deadline cancel is unchanged: delete_gcal only', async () => {
    const { window, calls, swal } = boot({ row: evRow({ kind: 'hearing' }) });
    await tick(window);
    window.document.getElementById('efActionBar').querySelectorAll('button')[1].onclick();
    expect(window.document.getElementById('efMoot')).toBeNull();
    await swal.resolve();
    expect(patches(calls)[0].body).toEqual({ delete_gcal: true });
  });
});


describe('the 400 fallback', () => {
  test('a rejected resolution is retried WITHOUT it — an old backend cannot brick the form', async () => {
    const { window, calls, swal } = boot({
      row: evRow({ kind: 'deadline' }),
      patchFail: { status: 400, message: 'completeEvent: "moot" is not a valid …' },
    });
    jest.spyOn(window.console, 'warn').mockImplementation(() => {});
    await tick(window);
    window.document.getElementById('efActionBar').querySelector('button').onclick();
    await swal.resolve('moot');

    const p = patches(calls);
    expect(p).toHaveLength(2);
    expect(p[0].body).toEqual({ resolution: 'moot' });
    expect(p[1].body).toEqual({});                   // bare retry — server defaults
    expect(window.console.warn).toHaveBeenCalled();  // logged, per the slice spec
  });

  test('the cancel path falls back too, keeping delete_gcal', async () => {
    const { window, calls, swal } = boot({
      row: evRow({ kind: 'deadline' }),
      patchFail: { status: 400, message: 'cancelEvent: bad resolution' },
    });
    jest.spyOn(window.console, 'warn').mockImplementation(() => {});
    await tick(window);
    window.document.getElementById('efActionBar').querySelectorAll('button')[1].onclick();
    await swal.resolve();
    const p = patches(calls);
    expect(p).toHaveLength(2);
    expect(p[1].body).toEqual({ delete_gcal: true });
  });

  test('a 500 is NOT retried — a real fault must not become two writes and a green toast', async () => {
    const { window, calls, swal } = boot({
      row: evRow({ kind: 'deadline' }),
      patchFail: { status: 500, message: 'boom' },
    });
    await tick(window);
    window.document.getElementById('efActionBar').querySelector('button').onclick();
    await swal.resolve('met');
    expect(patches(calls)).toHaveLength(1);
    expect(swal.validation).toMatch(/boom/);
  });

  test('a 404 is not retried either', async () => {
    const { window, calls, swal } = boot({
      row: evRow({ kind: 'deadline' }),
      patchFail: { status: 404, message: 'Event not found' },
    });
    await tick(window);
    window.document.getElementById('efActionBar').querySelector('button').onclick();
    await swal.resolve('met');
    expect(patches(calls)).toHaveLength(1);
  });
});
