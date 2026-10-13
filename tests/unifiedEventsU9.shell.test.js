// tests/unifiedEventsU9.shell.test.js
//
/**
 * Unified Events U9 — the shell's Calendar tab (public/index.html).
 *
 * WHY A FENCE AND NOT A FULL BOOT
 *
 * index.html is 5,000 lines and boots against auth, firmData, a sync bus and a
 * dozen iframes. tasksUi.boot.test.js and pipelineBoardUi.sync.test.js boot
 * SUB-PAGES for real because a sub-page is a self-contained document; the shell
 * is not, and a harness that stubbed enough of it to run would be testing the
 * harness. So this file does two cheaper things that catch the failures that
 * actually happen to this file:
 *
 *   1. SYNTAX. The tab is ~300 lines of inline script inside a 5,000-line HTML
 *      document. A stray brace does not fail a build here — there is no build.
 *      It fails at runtime, in the browser, as a WHITE SHELL: the block throws
 *      at parse, every function declared in it is gone, and so is every one in
 *      the blocks after it. `node --check` on each extracted block is the
 *      cheapest possible guard against shipping that.
 *
 *   2. WIRING. The tab is reachable only if the sidebar item, the tab-main div
 *      and the opener agree on one id. Those three live ~600 lines apart, and a
 *      rename that updates two of them leaves a sidebar button that does
 *      nothing — silently, because openMainTab() on a missing id throws inside
 *      an onclick and never reaches a user.
 *
 * The RENDERING is not asserted here; it is asserted where it is decided, in
 * tests/unifiedEventsU9.range.test.js, against the service that produces every
 * field the tab prints.
 *
 * Run:  npx jest tests/unifiedEventsU9.shell.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os   = require('os');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/**
 * Inline <script> bodies, in document order.
 *
 * The `(?![^>]*\bsrc=)` guard skips the loader tags. One "block" this returns
 * is not JS at all: an HTML COMMENT in the head contains the literal text
 * "<script>" while explaining how to disable a block, and no regex that does
 * not parse HTML can tell that from a real tag. It is filtered by shape below
 * rather than by index, so inserting or removing a block cannot silently point
 * the filter at the wrong one.
 */
function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** A comment-fragment "block" opens with prose and a `-->`, not with code. */
const isRealScript = (body) => !/^[\s\S]{0,400}?-->/.test(body);

describe('index.html — every inline script block parses', () => {
  const blocks = inlineScripts(HTML).filter(isRealScript);

  test('there are blocks to check, and the filter did not eat them all', () => {
    expect(blocks.length).toBeGreaterThan(5);
  });

  test.each(blocks.map((b, i) => [i, b]))('block %i is syntactically valid JS', (i, body) => {
    const f = path.join(os.tmpdir(), `ycshell_${process.pid}_${i}.js`);
    fs.writeFileSync(f, body);
    try {
      // `node --check` and not `new Function`: the latter accepts a `return`
      // at top level and rejects nothing else these blocks could contain, so
      // it would pass code the browser refuses to parse.
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } finally {
      fs.unlinkSync(f);
    }
  });
});

describe('Calendar tab wiring (U9)', () => {
  test('the sidebar item, the tab-main div and the opener agree on tabCalendar', () => {
    expect(HTML).toMatch(/<div class="sb-item" data-tab="tabCalendar" onclick="openCalendarTab\(\)"/);
    expect(HTML).toMatch(/<div id="tabCalendar" class="tab-main">/);
    expect(HTML).toMatch(/function openCalendarTab\(\)/);
    expect(HTML).toMatch(/openMainTab\('tabCalendar'\)/);
  });

  test('it sits BETWEEN Appointments and Events in the sidebar', () => {
    // Position is the slice's own statement about what the tab is: a third
    // list beside the two it unifies, for one release, so the new answer can
    // be checked against the old two.
    const at = (t) => HTML.indexOf(`data-tab="${t}"`);
    expect(at('tabAppts')).toBeLessThan(at('tabCalendar'));
    expect(at('tabCalendar')).toBeLessThan(at('tabEvents'));
  });

  test('its icon is distinct from both neighbours', () => {
    const icon = (tab) => {
      const i = HTML.indexOf(`data-tab="${tab}"`);
      return (HTML.slice(i, i + 400).match(/fa-solid (fa-[a-z-]+)/) || [])[1];
    };
    const cal = icon('tabCalendar');
    expect(cal).toBeTruthy();
    expect(cal).not.toBe(icon('tabAppts'));
    expect(cal).not.toBe(icon('tabEvents'));
  });

  test('THE OLD TABS ARE UNTOUCHED — U9 adds a third list, it does not retire two', () => {
    // Explicitly out of scope for this slice (U9b owns the retirement). If a
    // later edit deletes one of these, this test is where that decision has to
    // be made on purpose rather than as a side effect.
    expect(HTML).toMatch(/<div id="tabAppts" class="tab-main">/);
    expect(HTML).toMatch(/<div id="tabEvents" class="tab-main">/);
    expect(HTML).toMatch(/function openApptsTab\(\)/);
    expect(HTML).toMatch(/function openEventsTab\(\)/);
  });
});

describe('Calendar tab contract with the rest of the shell', () => {
  /** The tab's own script block, found by its banner rather than by index. */
  const block = inlineScripts(HTML).find((b) => b.includes('CALENDAR TAB — Unified Events U9'));

  test('the block exists and is the only one claiming that banner', () => {
    expect(block).toBeDefined();
    expect(inlineScripts(HTML).filter((b) => b.includes('CALENDAR TAB — Unified Events U9'))).toHaveLength(1);
  });

  test('it reads the unified range endpoint and nothing else', () => {
    // If this tab ever starts calling /api/events or /api/appts directly it
    // has stopped being the unified list and become a third bespoke one.
    expect(block).toContain(`apiSend('/api/calendar-range', 'GET', params)`);
    expect(block).not.toMatch(/apiSend\(['"]\/api\/(events|appts)/);
  });

  test('it opens rows through the shell openers, not through its own iframes', () => {
    // One way to open an appointment, one way to open an event, application
    // wide. A private Swal here would be a second one that drifts.
    expect(block).toContain('showAppt(r.source_id)');
    expect(block).toContain('showEvent(r.source_id)');
    expect(block).not.toContain('apptform2.html');
    expect(block).not.toContain('eventform.html');
  });

  test('it asks for the labels and attendees it renders', () => {
    // The anchor and With columns are rendered from `display` and
    // `attendees[]`, both of which are OPT-IN on the read layer. Forgetting a
    // flag renders a column of em-dashes rather than an error.
    expect(block).toMatch(/include_labels:\s*1/);
    expect(block).toMatch(/include_attendees:\s*1/);
  });

  test('it is a READER: it subscribes to the bus and emits nothing', () => {
    // §3.6 — a reader that emits is an infinite loop.
    expect(block).toMatch(/\['event:\*',\s*'appt:\*'\]/);
    expect(block).toContain('YC.on(topic');
    expect(block).not.toMatch(/YC\.emit/);
  });

  test('it defaults to today → +30d', () => {
    expect(block).toMatch(/calxSetRange\(30\);/);
  });

  test('every identifier it declares AT TOP LEVEL is calx/openCalendarTab-prefixed', () => {
    // The block shares one global scope with 5,000 lines of shell. `limit`,
    // `offsets`, `events` and `appts` are all live shell globals up there; a
    // bare `let limit` here would silently repoint the OTHER tabs' pagination.
    //
    // TOP LEVEL ONLY. A `const row` inside a render loop is scoped to that
    // function and collides with nothing, so demanding a prefix there would be
    // a naming rule dressed up as a safety rule. The base indentation is
    // derived from the block rather than hard-coded, so re-indenting the file
    // cannot turn this test into a no-op that silently passes everything.
    const decls = [...block.matchAll(/^([ \t]*)(?:let|const|var|(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/gm)]
      .map((m) => ({ indent: m[1].length, name: m[2] }));
    expect(decls.length).toBeGreaterThan(8);

    const base = Math.min(...decls.map((d) => d.indent));
    const topLevel = decls.filter((d) => d.indent === base).map((d) => d.name);
    expect(topLevel).toContain('openCalendarTab');
    expect(topLevel.length).toBeGreaterThan(8);

    const stray = topLevel.filter((n) => !/^(calx|CALX_|openCalendarTab$)/.test(n));
    expect(stray).toEqual([]);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   U9b-P1 + P2 — the toggle, the writers, the quick actions, F5 restore.

   Two kinds of check. STRUCTURE (where an element sits, which callback a
   button names) is read off the parsed document — jsdom, scripts NOT run.
   BEHAVIOUR that is decided by a pure function (which actions a row gets,
   which helper an action calls, what a 400 does, which opener a restored tab
   goes through) runs that function's REAL source, cut out of the page by
   name and evaluated in a vm with the shell globals it calls stubbed — so a
   rule change in the page is a test failure here, not a regex that still
   happens to match.
   ═════════════════════════════════════════════════════════════════════════ */

const vm = require('vm');
const { JSDOM } = require('jsdom');
const SCRIPTS_JS = fs.readFileSync(path.join(ROOT, 'public/scripts.js'), 'utf8');
const DOC = new JSDOM(HTML).window.document;
const CALX = inlineScripts(HTML).find((b) => b.includes('CALENDAR TAB — Unified Events U9'));

/** The full source of `function name(…) {…}` (async or not), by brace count. */
function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  // skip the parameter list's own braces (destructuring defaults)
  let paren = 0;
  for (let j = m.index + m[0].length - 1; j < src.length; j++) {
    if (src[j] === '(') paren++;
    else if (src[j] === ')' && --paren === 0) { i = src.indexOf('{', j); break; }
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

describe('U9b-P1 — List | Grid and the New buttons (static)', () => {
  test('the List | Grid toggle exists with exactly those two views', () => {
    const views = [...DOC.querySelectorAll('#calxViewToggle > button[data-view]')].map((b) => b.dataset.view);
    expect(views).toEqual(['list', 'grid']);
  });

  test('both New buttons route their callback through calxAfterCreate', () => {
    // The callback cancels the create's own queued bus echo; a button that
    // passes its own refetch instead costs two list fetches per create.
    expect(DOC.getElementById('calxNewAppt').getAttribute('onclick')).toMatch(/\bonCreated:\s*calxAfterCreate\b/);
    expect(DOC.getElementById('calxNewEvent').getAttribute('onclick')).toMatch(/\bonSaved:\s*calxAfterCreate\b/);
    expect(fnSrc(CALX, 'calxAfterCreate')).toMatch(/clearTimeout\(calxBusDeb\)/);
  });

  test('the mode persists under yc-calendar-view', () => {
    expect(CALX).toMatch(/const CALX_VIEW_KEY = 'yc-calendar-view';/);
    expect(CALX).toContain('localStorage.getItem(CALX_VIEW_KEY)');
    expect(CALX).toContain('localStorage.setItem(CALX_VIEW_KEY');
  });

  test('#calxGridFrame is a DIRECT child of #tabCalendar', () => {
    // openMainTab()'s lazy data-src swap is `:scope > iframe[data-src]` —
    // nest the frame one level deeper and Grid restores to a blank frame.
    expect(DOC.querySelector('#tabCalendar > iframe#calxGridFrame')).not.toBeNull();
  });

  test('calxGet takes a last-request-wins ticket and checks it after every await', () => {
    const get = fnSrc(CALX, 'calxGet');
    expect(get).toMatch(/const seq = \+\+calxSeq;/);
    // once after the fetch resolves, once in the catch
    expect(get.match(/if \(seq !== calxSeq\) return;/g)).toHaveLength(2);
  });
});

describe('U9b-P2 — Calendar list quick actions', () => {
  // One row per shape the read layer can produce (state × resolution × source).
  const R = {
    apptLive:      { source: 'appt',  source_id: 1, state: 'live',       resolution: null,        starts_at: '2026-10-14 10:00:00' },
    apptAttended:  { source: 'appt',  source_id: 2, state: 'resolved',   resolution: 'attended',  starts_at: '2026-10-15 09:30:00' },
    apptNoShow:    { source: 'appt',  source_id: 3, state: 'resolved',   resolution: 'no_show',   starts_at: '2026-10-16 14:15:00' },
    apptCancelled: { source: 'appt',  source_id: 4, state: 'cancelled',  resolution: 'cancelled', starts_at: '2026-10-17 11:00:00' },
    apptSuperseded:{ source: 'appt',  source_id: 5, state: 'superseded', resolution: null,        starts_at: '2026-10-18 11:00:00' },
    deadlineLive:  { source: 'event', source_id: 6, state: 'live',       resolution: null, kind_key: 'deadline' },
    hearingLive:   { source: 'event', source_id: 7, state: 'live',       resolution: null, kind_key: 'hearing' },
    unmappedLive:  { source: 'event', source_id: 8, state: 'live',       resolution: null, kind_key: null },
    deadlineMet:   { source: 'event', source_id: 9, state: 'resolved',   resolution: 'met', kind_key: 'deadline' },
    deadlineMissed:{ source: 'event', source_id: 10, state: 'resolved',  resolution: 'missed', kind_key: 'deadline' },
    eventMoot:     { source: 'event', source_id: 11, state: 'cancelled', resolution: 'moot', kind_key: 'deadline' },
    eventSuperseded:{ source: 'event', source_id: 12, state: 'superseded', resolution: null, kind_key: 'hearing' },
  };

  /** calxActions/calxAct/calxApptStatus, real source, shell globals stubbed. */
  function load() {
    const calls = [];
    const rec = (name) => (...args) => { calls.push([name, ...args]); };
    const ctx = vm.createContext({
      apptUpdate: rec('apptUpdate'), eventComplete: rec('eventComplete'), eventCancel: rec('eventCancel'),
      eventCompleteDeadline: rec('eventCompleteDeadline'), eventCancelDeadline: rec('eventCancelDeadline'),
    });
    const statusMap = /const CALX_APPT_STATUS = [^\n]+/.exec(CALX)[0];
    vm.runInContext([statusMap, fnSrc(CALX, 'calxApptStatus'), fnSrc(CALX, 'calxActions'), fnSrc(CALX, 'calxAct'),
      'this.api = { calxActions, calxAct, calxApptStatus };'].join('\n'), ctx);
    const acts = (row) => [...ctx.api.calxActions(row).matchAll(/data-calx-act="([^"]+)"/g)].map((m) => m[1]);
    return { ...ctx.api, acts, calls };
  }

  test('appts: the Appts tab rule — every action but the one matching the status', () => {
    const { acts } = load();
    expect(acts(R.apptLive)).toEqual(['Attended', 'No Show', 'Cancel', 'Reschedule']);
    expect(acts(R.apptAttended)).toEqual(['No Show', 'Cancel', 'Reschedule']);
    expect(acts(R.apptNoShow)).toEqual(['Attended', 'Cancel', 'Reschedule']);
  });

  test('events: Complete + Cancel while live, whatever the kind (eventform parity)', () => {
    const { acts } = load();
    for (const r of [R.deadlineLive, R.hearingLive, R.unmappedLive]) expect(acts(r)).toEqual(['complete', 'cancel']);
  });

  test('cancelled, superseded and resolved-event rows get no actions', () => {
    const { calxActions } = load();
    for (const r of [R.apptCancelled, R.apptSuperseded, R.deadlineMet, R.deadlineMissed, R.eventMoot, R.eventSuperseded]) {
      expect(calxActions(r)).toBe('');
    }
  });

  test('appt status maps back exactly as APPT_STATE (caseEventService) maps it forward', () => {
    const { calxApptStatus } = load();
    expect(calxApptStatus(R.apptLive)).toBe('Scheduled');
    expect(calxApptStatus(R.apptAttended)).toBe('Attended');
    expect(calxApptStatus(R.apptNoShow)).toBe('No Show');
    expect(calxApptStatus(R.apptCancelled)).toBe('Canceled');
  });

  test('an appt action is apptUpdate with the Appts tab\'s args shape; no refetch callback', () => {
    const { calxAct, calls } = load();
    calxAct(R.apptLive, 'Reschedule');
    calxAct(R.apptNoShow, 'Attended');
    calxAct(R.apptAttended, 'Cancel');
    expect(calls).toEqual([
      // datetime-local's shape — what the Appts tab passes as appt_datetime_local
      ['apptUpdate', 1, 'Reschedule', '2026-10-14T10:00', null, 'Scheduled'],
      // currentStatus drives apptUpdate's confirmCorrection guard
      ['apptUpdate', 3, 'Attended', null, null, 'No Show'],
      ['apptUpdate', 2, 'Cancel', null, null, 'Attended'],
    ]);
  });

  test('an event action takes the deadline dialogs only on a deadline, and passes no callback', () => {
    const { calxAct, calls } = load();
    calxAct(R.deadlineLive, 'complete');
    calxAct(R.deadlineLive, 'cancel');
    calxAct(R.hearingLive, 'complete');
    calxAct(R.unmappedLive, 'cancel');
    expect(calls).toEqual([
      ['eventCompleteDeadline', 6], ['eventCancelDeadline', 6],
      ['eventComplete', 7], ['eventCancel', 8],
    ]);
  });

  test('the cell is wired: header, row cell, click routed before the row opener', () => {
    const ths = [...DOC.querySelectorAll('#calxTable th')].map((t) => t.textContent.trim());
    expect(ths[ths.length - 1]).toBe('Actions');
    const get = fnSrc(CALX, 'calxGet');
    // the empty state spans every column
    expect(get).toContain(`colspan="${ths.length}"`);
    expect(get).toContain(`'<td class="calx-acts">' + calxActions(r) + '</td>'`);
    // an action click must not ALSO open the row's form
    const onclick = get.slice(get.indexOf('row.onclick'));
    const act = onclick.indexOf('calxAct(r, act.dataset.calxAct); return;');
    expect(act).toBeGreaterThan(-1);
    expect(act).toBeLessThan(onclick.indexOf('showAppt(r.source_id)'));
  });

  test('the actions write through the shared helpers — no direct /api call from the tab', () => {
    // The U9 fence above already forbids apiSend('/api/events|appts') in the
    // block; this pins that the actions did not route around it some other way.
    expect(CALX).not.toMatch(/fetch\(|XMLHttpRequest/);
  });
});

describe('U9b-P2 — scripts.js deadline helpers (eventform parity)', () => {
  function load(apiSend) {
    const calls = [];
    const ctx = vm.createContext({
      P: { apiSend: async (...a) => { calls.push(a); return apiSend(...a); } },
      console: { warn() {} },
    });
    vm.runInContext(fnSrc(SCRIPTS_JS, 'eventPatchStatus') + '\nthis.eventPatchStatus = eventPatchStatus;', ctx);
    return { eventPatchStatus: ctx.eventPatchStatus, calls };
  }
  const fail = (status) => Object.assign(new Error('nope ' + status), { status });

  test('a 400 retries the same action WITHOUT the resolution', async () => {
    let n = 0;
    const { eventPatchStatus, calls } = load(async () => { if (n++ === 0) throw fail(400); return { status: 'success' }; });
    await expect(eventPatchStatus(6, '/cancel', { delete_gcal: true }, 'moot')).resolves.toEqual({ status: 'success' });
    expect(calls).toEqual([
      ['/api/events/6/cancel', 'PATCH', { delete_gcal: true, resolution: 'moot' }],
      ['/api/events/6/cancel', 'PATCH', { delete_gcal: true }],
    ]);
  });

  test.each([404, 500, undefined])('a %s propagates, with no retry', async (status) => {
    const { eventPatchStatus, calls } = load(async () => { throw fail(status); });
    await expect(eventPatchStatus(6, '/complete', {}, 'met')).rejects.toThrow('nope');
    expect(calls).toHaveLength(1);
  });

  test('Complete offers met | moot — never missed (the nightly sweep owns it)', () => {
    const src = fnSrc(SCRIPTS_JS, 'eventCompleteDeadline');
    const opts = /inputOptions:\s*\{([^}]*)\}/.exec(src)[1];
    expect([...opts.matchAll(/(\w+):/g)].map((m) => m[1])).toEqual(['met', 'moot']);
    expect(src).toMatch(/eventPatchStatus\(id, '\/complete', \{\}, choice === 'moot' \? 'moot' : 'met'\)/);
  });

  test('Cancel answers cancelled | moot and still deletes the calendar entry', () => {
    expect(fnSrc(SCRIPTS_JS, 'eventCancelDeadline'))
      .toMatch(/eventPatchStatus\(id, '\/cancel', \{ delete_gcal: true \}, moot \? 'moot' : 'cancelled'\)/);
  });
});

describe('U9b-P2 — F5 restore goes through each tab\'s opener', () => {
  const SHELL = HTML;   // the boot + restore code spans blocks; read the page

  function load() {
    const calls = [];
    const rec = (name) => () => calls.push(name);
    const ctx = vm.createContext({
      openCasesTab: rec('openCasesTab'), openContactsTab: rec('openContactsTab'),
      openApptsTab: rec('openApptsTab'), openCalendarTab: rec('openCalendarTab'),
      openEventsTab: rec('openEventsTab'), openLogsTab: rec('openLogsTab'),
      openMainTab: (t) => calls.push('openMainTab:' + t),
    });
    vm.runInContext(fnSrc(SHELL, 'openMainTabOnBoot') + '\nthis.f = openMainTabOnBoot;', ctx);
    return { f: ctx.f, calls };
  }

  test('each list tab restores through its opener; anything else is a bare openMainTab', () => {
    const { f, calls } = load();
    for (const t of ['tabCases', 'tabContacts', 'tabAppts', 'tabCalendar', 'tabEvents', 'tabLogs',
                     'tabHome', 'tabTasks', 'file-div3']) f(t);
    expect(calls).toEqual(['openCasesTab', 'openContactsTab', 'openApptsTab', 'openCalendarTab',
      'openEventsTab', 'openLogsTab', 'openMainTab:tabHome', 'openMainTab:tabTasks', 'openMainTab:file-div3']);
  });

  test('exactly one opener call per boot: the boot site defers to restore when ?files= is present', () => {
    // An opener's first-open guard stays falsy until its GET resolves, so the
    // boot site and the restore tail must never BOTH run the opener.
    expect(SHELL).toMatch(/if \(params\.files\) openMainTab\(openTab\);\s*else openMainTabOnBoot\(openTab\);/);
    expect(SHELL).not.toMatch(/^\s*openMainTab\(openTab\);/m);
    expect(SHELL).toMatch(/if \(params\.files\) await restoreOpenFiles\(params\.files, params\.open\);/);
    expect(SHELL.match(/openMainTabOnBoot\(/g)).toHaveLength(3);   // declaration + the two sites
  });

  test('restoreOpenFiles routes a main tab through the helper; a file stays bare', () => {
    const restore = fnSrc(SHELL, 'restoreOpenFiles');
    expect(restore).toContain('openMainTabOnBoot(!stale && open && E(open) ? open : "tabHome")');
    expect(restore).toContain('openMainTab(target && E(target) ? target : "tabHome")');
  });

  test('the Log tab has a real opener, used by both its buttons', () => {
    expect(fnSrc(SHELL, 'openLogsTab')).toMatch(/if \(!logs\) tabLogGet\(0\);\s*(?:\/\/[^\n]*)?\s*openMainTab\('tabLogs'\);/);
    expect(DOC.querySelector('.sb-item[data-tab="tabLogs"]').getAttribute('onclick')).toBe('openLogsTab()');
    expect(SHELL).not.toContain("logs?'':tabLogGet(0)");
  });
});

describe('U9b item 8 — the Appointments tab\'s Calendar button opens the Grid tab', () => {
  test('the button routes to calxOpenGrid, and the 600px Swal is gone', () => {
    expect(DOC.getElementById('tabApptsCal').getAttribute('onclick')).toBe('calxOpenGrid()');
    // the legacy path, by name and by shape — a calendar frame inside a Swal
    expect(HTML).not.toMatch(/function tabApptsCal\b/);
    expect(HTML).not.toMatch(/<iframe src="\/calendar\.html"/);
    const survey = fs.readFileSync(path.join(ROOT, 'scripts/mobile-survey/survey.js'), 'utf8');
    expect(survey).not.toContain('tabApptsCal');
  });

  test('calxOpenGrid sets the mode directly, then opens the tab — never calxSetView', () => {
    // calxSetView is the ON-SCREEN toggle: called from another tab it loads
    // the frame 0-wide. The opener must run LAST, after the DOM reflects Grid,
    // so openMainTab()'s data-src swap loads the frame on screen.
    const calls = [];
    const ctx = vm.createContext({
      CALX_VIEW_KEY: 'yc-calendar-view',
      localStorage: { setItem: (k, v) => calls.push(['setItem', k, v]) },
      calxApplyView: () => calls.push(['calxApplyView', ctx.calxView]),
      openCalendarTab: () => calls.push(['openCalendarTab', ctx.calxView]),
      calxSetView: () => calls.push(['calxSetView']),
    });
    vm.runInContext('var calxView = "list";\n' + fnSrc(CALX, 'calxOpenGrid') + '\ncalxOpenGrid();', ctx);
    expect(calls).toEqual([
      ['setItem', 'yc-calendar-view', 'grid'],
      ['calxApplyView', 'grid'],
      ['openCalendarTab', 'grid'],
    ]);
  });
});
