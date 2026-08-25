/**
 * tests/pipelineBoardUi.sync.test.js
 *
 * BOOTS public/pipelineBoard.html for real, in jsdom, against a stub shell —
 * with the REAL public/js/yc-sync.js and public/scripts.js evaluated first, so
 * the bus under test is the shipped bus. (tasksUi.boot.test.js is the harness
 * pattern; ycSync.test.js is the "evaluate the real file" philosophy.)
 *
 * WHY THIS FILE EXISTS
 *
 * The board is a READER of a QUERY VIEW. Which column a card belongs in is
 * computed server-side off case_stage_log, so the board can only ever respond
 * to a bus message by refetching — and a refetch is a request, which means
 * every guard around it is a real cost/correctness tradeoff that only exists
 * at run time:
 *
 *   · THE ECHO GUARD. A drag-advance already calls loadBoard() itself. The bus
 *     then announces that same advance back. Without the boardLastLoad fence
 *     every drag costs two full board fetches.
 *   · THE VISIBILITY FENCE. ~700 intake cards; refetching a board nobody is
 *     looking at, once per case write anywhere in the app, is pure waste.
 *   · §3.6. A reader that emits is an infinite loop. Cheap to assert, fatal to
 *     get wrong.
 *
 * ON MODELLING BroadcastChannel ORDERING (load-bearing, read before editing)
 *
 * In production the sniff runs in the SHELL's realm (index.html's apiSend) and
 * reaches this frame over BroadcastChannel — a MACROTASK. The board's own
 * continuation after `await api(...)`, including loadBoard()'s boardLastLoad
 * stamp, is a MICROTASK and therefore always runs FIRST. That ordering is the
 * entire reason the echo guard works.
 *
 * jsdom gives every window one realm, so a naive stub would dispatch the emit
 * synchronously inside apiSend — inverting the order and making the guard look
 * effective (or ineffective) for the wrong reason. So the stub defers its sniff
 * by one macrotask. That is not a fudge: it is exactly what BroadcastChannel
 * does. Do not "simplify" it away.
 *
 *   npx jest tests/pipelineBoardUi.sync.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const bcPolyfill = require('./helpers/bcPolyfill');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/pipelineBoard.html'), 'utf8');
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

function boardPayload() {
  return {
    template: { id: 1, name: 'Intake', role: 'intake' },
    stages: [
      { stage_key: 'consult', internal_label: 'Consult',  client_label: 'Meeting booked' },
      { stage_key: 'retained', internal_label: 'Retained', client_label: 'Signed up' },
    ],
    columns: {
      unstaged: [{ case_id: 'AAAA', case_display: '24-1', primary_contact_name: 'Ann',
                   case_open_date: new Date().toISOString(), case_status: 'New' }],
      consult:  [{ case_id: 'BBBB', case_display: '24-2', primary_contact_name: 'Bob',
                   case_open_date: new Date().toISOString(), days_in_stage: 3 }],
      retained: [],
    },
  };
}

/**
 * @param {object}  o
 * @param {boolean} o.noTemplates  server returns no active templates
 * @param {object}  o.advance      body the advance endpoint returns
 * @param {object}  o.payload      board payload override. Defaults to
 *   boardPayload(), whose stages carry NO `lane` field — that is deliberate
 *   and is the back-compat fixture: it proves a pre-migration server response
 *   still renders exactly as it did before R1. The lane-bearing payload lives
 *   in its own test below rather than being retrofitted here.
 */
async function boot({ noTemplates = false, advance = null, payload = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.4lsg.com/pipelineBoard.html',
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  // jsdom boots a document at visibilityState 'prerender', i.e.
  // document.hidden === true. A real foreground tab is 'visible', and the
  // board's visibility fence reads document.hidden (as does the shell's
  // casesTabVisible), so without this every test would silently exercise the
  // OFF-SCREEN path. Tests that want hidden say so explicitly.
  setHidden(window, false);

  const calls = [];
  // The shell's transport, INCLUDING its sync-bus hook. The setTimeout is the
  // BroadcastChannel macrotask — see the header comment.
  window.apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    let data;
    if (url === '/api/pipeline-admin/templates') {
      data = { templates: noTemplates ? [] : [{ id: 1, name: 'Intake', active: 1 }] };
    } else if (url === '/api/pipeline-board') {
      data = payload || boardPayload();
    } else if (/\/pipeline\/advance$/.test(url)) {
      data = advance || { status: 'success', noop: false,
                          changes: { case_stage: 'Retained', pipeline_phase: 'case' } };
    } else {
      data = { status: 'success' };
    }
    window.setTimeout(() => {
      try { window.YC && window.YC._sniff(method, url, data); } catch (_) { /* noop */ }
    }, 0);
    return data;
  };
  window.addFile = () => {};

  /* A FAKE SortableJS, so the shipped onStart/onEnd closures actually run.
     Without it `window.Sortable` is undefined, `hookSortables()` returns early,
     and the drag guards below would be untestable — the board would also render
     its CDN-fail "Move…" buttons, which is a different code path from the one
     under test. This records the options object each column is hooked with;
     `__t.drag()` then drives them exactly as the real library would: onStart,
     then onEnd one macrotask later. Nothing about the board is stubbed — only
     the library that calls into it. */
  const sortableOpts = [];
  window.Sortable = function (el, opts) {
    sortableOpts.push({ el, opts });
    return { destroy() {} };
  };
  window.__sortableOpts = sortableOpts;

  // SweetAlert: confirm-with-empty-note, which is what a drag-advance sees
  // when the user just presses "Yes, advance".
  window.Swal = {
    mixin: () => ({ fire: () => {} }),
    fire: async () => ({ isConfirmed: true, value: '' }),
    close: () => {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);
  // scripts.js declares its helpers with `const`, and per spec an (indirect)
  // eval gives lexical declarations their OWN environment — so `const E` does
  // not survive to the next eval the way a function declaration does. The
  // shipped <script> tag has no such problem. Re-export the handful the board
  // reads, from INSIDE the same eval where the bindings are still in scope, so
  // the board still runs against the real implementations.
  window.eval(SCRIPTS + '\n;Object.assign(window, { E, escAttr, escText });');

  window.document.body.innerHTML =
    HTML.slice(HTML.indexOf('<body>') + 6, HTML.lastIndexOf('<script>'));
  const script = HTML.slice(HTML.lastIndexOf('<script>') + 8, HTML.lastIndexOf('</script>'));

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  // Same lexical-scope rule as scripts.js above: the board's `let boardLastLoad`
  // lives in the eval's environment, so a test cannot age it from outside.
  // Appended INSIDE the eval, this is a test-only window onto that state — the
  // shipped file is byte-for-byte unchanged, and every assertion still runs
  // against the real handlers.
  window.eval(script +
    '\n;Object.assign(window, { __t: {' +
    '  ageLastLoad: () => { boardLastLoad = 0; },' +
    '  isStale:     () => boardStale,' +
    '  isDragging:  () => dragging,' +
    // Drive the REAL Sortable callbacks the board registered. startDrag/endDrag
    // are separate so a test can hold a drag open across a bus message.
    '  startDrag:   () => { window.__sortableOpts[0].opts.onStart(); },' +
    '  endDrag:     () => { window.__sortableOpts[0].opts.onEnd(' +
    '                        { from: window.__sortableOpts[0].el,' +
    '                          to:   window.__sortableOpts[0].el,' +
    '                          item: { dataset: { caseId: "AAAA" } } }); },' +
    '} });');

  await tick(window, 50);
  return { window, calls, errors };
}

const boardGets = calls => calls.filter(c => c.url === '/api/pipeline-board');

/** jsdom has no layout, so document.hidden is the only visibility lever here. */
function setHidden(window, hidden) {
  Object.defineProperty(window.document, 'hidden', {
    configurable: true, get: () => hidden,
  });
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

describe('pipelineBoard boots', () => {
  test('loads templates and the board, and renders cards', async () => {
    const { window, calls, errors } = await boot();
    expect(errors).toEqual([]);
    expect(boardGets(calls).length).toBe(1);
    expect(window.document.querySelectorAll('.pb-card').length).toBe(2);
    // Unstaged + the two stages.
    expect(window.document.querySelectorAll('.pb-col').length).toBe(3);
  });

  test('no active templates → message, and NO board fetch', async () => {
    const { calls, errors } = await boot({ noTemplates: true });
    expect(errors).toEqual([]);
    expect(boardGets(calls).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// The case:* subscriber
// ─────────────────────────────────────────────────────────────

describe('case:* subscriber', () => {
  test('a case change refetches the whole board — never a cell patch', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();                       // pretend the load was long ago
    window.YC.emit('case:ZZZZ', { case_status: 'Filed' }, 'test');
    await tick(window, 400);                        // 300ms debounce
    expect(boardGets(calls).length).toBe(2);
  });

  test('ANY field triggers it — the response is a whole board either way', async () => {
    const { window, calls } = await boot();
    for (const fields of [{ case_stage: 'x' }, { case_notes: 'y' }, { case_type: 'z' }]) {
      window.__t.ageLastLoad();
      window.YC.emit('case:ZZZZ', fields, 'test');
      await tick(window, 400);
    }
    expect(boardGets(calls).length).toBe(4);        // 1 boot + 3
  });

  test('a burst of writes costs ONE refetch — the debounce coalesces', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    for (let i = 0; i < 5; i++) window.YC.emit('case:ZZZZ', { case_stage: 'x' + i }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(2);
  });

  test('contact traffic does not move the board', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    window.YC.emit('contact:5', { contact_phone: '1' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);
  });

  test('§3.6 — the handler refetches but NEVER emits', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(2);
    // One message in, none produced by the refetch (loadBoard is a GET, and
    // the stub only sniffs what it is given — a GET never matches).
    expect(window.YC._log.length).toBe(1);
  });

  test('no template selected → no fetch at all', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    window.document.getElementById('pb-template').innerHTML = '';   // nothing selectable
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// THE ECHO GUARD — the reason boardLastLoad exists
// ─────────────────────────────────────────────────────────────

describe('drag-advance echo guard', () => {
  test('an advance from THIS board costs exactly ONE board load', async () => {
    // The full flow: confirm → POST advance → success → loadBoard(), and then
    // the bus announcing that same advance arrives one macrotask later.
    const { window, calls } = await boot();
    expect(boardGets(calls).length).toBe(1);        // boot

    await window.confirmAndAdvance('AAAA', 'retained');
    await tick(window, 500);                        // past the 300ms debounce

    const advances = calls.filter(c => /\/pipeline\/advance$/.test(c.url));
    expect(advances.length).toBe(1);
    expect(advances[0].params).toEqual({ stage: 'retained' });
    // ONE more board GET — the advance's own. The echo was swallowed.
    expect(boardGets(calls).length).toBe(2);
    // …and the echo really did arrive; it was suppressed, not absent.
    expect(window.YC._log.length).toBe(1);
    expect(window.YC._log[0].addr).toBe('case:AAAA');
  });

  test('the guard is what suppressed it — an OLD stamp lets the same message through', async () => {
    // The control for the test above: without this, a passing echo test could
    // just mean the message never arrived.
    const { window, calls } = await boot();
    await window.confirmAndAdvance('AAAA', 'retained');
    await tick(window, 20);
    window.__t.ageLastLoad();                       // age the stamp past BOARD_FRESH_MS
    window.YC.emit('case:AAAA', { case_stage: 'Retained' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(3);        // boot + advance + the un-guarded echo
  });

  test('a NOOP advance re-renders and fetches nothing', async () => {
    const { window, calls } = await boot({ advance: { status: 'success', noop: true } });
    await window.confirmAndAdvance('AAAA', 'retained');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);
    expect(window.YC._log.length).toBe(0);          // no changes key → nothing announced
  });
});

// ─────────────────────────────────────────────────────────────
// Visibility — stale flag + the two ways back on screen
// ─────────────────────────────────────────────────────────────

describe('visibility', () => {
  test('hidden → marks stale, fetches nothing', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    expect(window.__t.isStale()).toBe(false);
    setHidden(window, true);
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);
    expect(window.__t.isStale()).toBe(true);
  });

  test('ycBecameVisible() — the shell re-entering the tab spends the stale flag', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    setHidden(window, true);
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 20);
    expect(boardGets(calls).length).toBe(2);

    // Spent once, not again.
    window.ycBecameVisible();
    await tick(window, 20);
    expect(boardGets(calls).length).toBe(2);
  });

  test('ycBecameVisible() on a FRESH board is a no-op — no refetch per tab click', async () => {
    const { window, calls } = await boot();
    window.ycBecameVisible();
    await tick(window, 20);
    expect(boardGets(calls).length).toBe(1);
  });

  test('visibilitychange refetches a stale board when the browser tab returns', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    setHidden(window, true);
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);

    setHidden(window, false);
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 20);
    expect(boardGets(calls).length).toBe(2);
  });

  test('visibilitychange while STILL hidden keeps the flag for later', async () => {
    // The guard that matters: a board sitting behind ANOTHER shell tab must not
    // spend its stale flag just because the browser tab regained focus — the
    // later ycBecameVisible would then find nothing to do and never refresh.
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    setHidden(window, true);
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);

    window.document.dispatchEvent(new window.Event('visibilitychange'));  // still hidden
    await tick(window, 20);
    expect(boardGets(calls).length).toBe(1);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 20);
    expect(boardGets(calls).length).toBe(2);        // flag survived and paid off
  });
});

// ─────────────────────────────────────────────────────────────
// Mid-drag teardown (Slice 3c)
//
// loadBoard() ends in render(), which destroys every Sortable instance and
// replaces the whole board's innerHTML — with the card currently in the user's
// hand among the nodes it throws away. A write from ANOTHER window landing
// mid-drag would therefore yank the DOM out from under an in-progress drag: the
// card vanishes in mid-air, onEnd fires against detached nodes, and handleDrop
// reads evt.to.dataset.stageKey off an element no longer in the document.
//
// Nothing here can stop the message arriving. What it can do is not act on it
// until the hand is empty.
// ─────────────────────────────────────────────────────────────

describe('mid-drag teardown guard', () => {
  test('A MESSAGE MID-DRAG DEFERS — no refetch, and the stale flag is set', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();                       // echo guard out of the way
    window.__t.startDrag();
    expect(window.__t.isDragging()).toBe(true);

    window.YC.emit('case:ZZZZ', { case_status: 'Filed' }, 'test');
    await tick(window, 400);                        // well past the 300ms debounce

    expect(boardGets(calls).length).toBe(1);        // boot only — nothing refetched
    expect(window.__t.isStale()).toBe(true);
  });

  test('IT FLUSHES ON DRAG END — the deferred refresh actually happens', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    window.__t.startDrag();
    window.YC.emit('case:ZZZZ', { case_status: 'Filed' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);

    window.__t.endDrag();                           // same-column drop: no advance
    await tick(window, 120);                        // the 50ms dragging-clear timeout

    expect(boardGets(calls).length).toBe(2);
    expect(window.__t.isStale()).toBe(false);
  });

  test('a drag with NO message costs nothing on release', async () => {
    // The flush is guarded by the flag, not by "a drag just ended". A user who
    // drags a card back where it came from must not buy a board fetch for it.
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    window.__t.startDrag();
    window.__t.endDrag();
    await tick(window, 120);
    expect(boardGets(calls).length).toBe(1);
  });

  test('a burst mid-drag still costs ONE refresh on release', async () => {
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    window.__t.startDrag();
    for (let i = 0; i < 5; i++) window.YC.emit('case:Z' + i, { case_stage: 'x' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);

    window.__t.endDrag();
    await tick(window, 120);
    expect(boardGets(calls).length).toBe(2);        // one, not five
  });

  test('the drag guard sits BELOW the visibility check — an off-screen drag is impossible', async () => {
    // Ordering matters only in that a hidden board sets the same flag either
    // way. Asserted so a future reorder cannot make a hidden board skip the
    // flag because it happened to be "dragging".
    const { window, calls } = await boot();
    window.__t.ageLastLoad();
    setHidden(window, true);
    window.__t.startDrag();
    window.YC.emit('case:ZZZZ', { case_stage: 'Filed' }, 'test');
    await tick(window, 400);
    expect(boardGets(calls).length).toBe(1);
    expect(window.__t.isStale()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Scroll preservation across a rebuild (Slice 3c)
//
// render() blanks the host, so every column body's scrollTop went to zero.
// On a board that is refreshed by the bus, that meant a remote write snapped a
// reader back to the top of a long column mid-read.
// ─────────────────────────────────────────────────────────────

describe('column scroll preservation', () => {
  /** jsdom has no layout, so scrollTop is a plain settable property here. */
  const bodies = w => [...w.document.querySelectorAll('.pb-col-body')];
  const byStage = (w, key) =>
    bodies(w).find(b => b.dataset.stageKey === key);

  test('SCROLL SURVIVES a same-columns rebuild', async () => {
    const { window, calls } = await boot();
    byStage(window, 'consult').scrollTop = 240;
    byStage(window, 'unstaged').scrollTop = 60;

    window.__t.ageLastLoad();
    window.YC.emit('case:ZZZZ', { case_status: 'Filed' }, 'test');
    await tick(window, 400);

    expect(boardGets(calls).length).toBe(2);        // it really did rebuild
    expect(byStage(window, 'consult').scrollTop).toBe(240);
    expect(byStage(window, 'unstaged').scrollTop).toBe(60);
  });

  test('it is keyed on the STAGE KEY, not on column order', async () => {
    // A column can appear or disappear between renders (a stage added in Case
    // Config, include-closed toggled). An index-keyed restore would then pour
    // one column's position into a different column.
    const { window } = await boot();
    byStage(window, 'consult').scrollTop = 240;
    byStage(window, 'retained').scrollTop = 0;

    window.__t.ageLastLoad();
    window.YC.emit('case:ZZZZ', { case_status: 'Filed' }, 'test');
    await tick(window, 400);

    expect(byStage(window, 'consult').scrollTop).toBe(240);
    expect(byStage(window, 'retained').scrollTop).toBe(0);
  });

  test('a column absent from the new board is simply not restored', async () => {
    // Nothing to assert on the missing column itself — the point is that its
    // stored position is never poured into a survivor, and that the rebuild
    // does not throw looking for it.
    const { window, errors } = await boot();
    byStage(window, 'consult').scrollTop = 240;
    window.__t.ageLastLoad();
    window.YC.emit('case:ZZZZ', { case_status: 'Filed' }, 'test');
    await tick(window, 400);
    expect(errors).toEqual([]);
    expect(byStage(window, 'unstaged').scrollTop).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1 — lane grouping
//
// The board's column ORDER is the whole feature: off-ramps carry high
// stage_numbers only because they were appended last, so left-to-right they
// used to interleave with the happy path and break its reading. Grouping them
// behind a divider is what makes the pipeline scan as a pipeline.
//
// The default fixture above deliberately has NO `lane` field, and every other
// test in this file still uses it — that is the back-compat proof. This block
// supplies its own lane-bearing payload rather than retrofitting the old one,
// so the two properties stay independently falsifiable.
// ─────────────────────────────────────────────────────────────────────────────

function lanedPayload() {
  return {
    template: { id: 2, name: 'Bankruptcy — Chapter 7', role: 'case' },
    // Deliberately NOT in lane order — the server sorts by stage_number, and
    // the off-ramps carry the HIGHEST numbers, which is exactly the live shape.
    stages: [
      { stage_key: 'docs',      stage_number: 1, internal_label: 'Docs',      client_label: 'Preparing',  lane: 'main' },
      { stage_key: 'filed',     stage_number: 2, internal_label: 'Filed',     client_label: 'Filed',      lane: 'main' },
      { stage_key: 'closed',    stage_number: 3, internal_label: 'Closed',    client_label: 'Closed',     lane: 'main' },
      { stage_key: 'dismissed', stage_number: 4, internal_label: 'Dismissed', client_label: 'Dismissed',  lane: 'offramp' },
      { stage_key: 'appeal',    stage_number: 5, internal_label: 'On Appeal', client_label: 'On appeal',  lane: 'offramp' },
    ],
    columns: {
      unstaged:  [],
      docs:      [{ case_id: 'AAAA', case_display: '24-1', primary_contact_name: 'Ann',
                    case_open_date: new Date().toISOString(), days_in_stage: 1 }],
      filed:     [],
      closed:    [],
      dismissed: [{ case_id: 'CCCC', case_display: '24-3', primary_contact_name: 'Cyd',
                    case_open_date: new Date().toISOString(), days_in_stage: 9 }],
      appeal:    [],
    },
  };
}

/** Column keys in DOM order, with the divider marked so order is asserted
 *  against the RENDERED sequence rather than against two filtered lists. */
function domSequence(window) {
  return [...window.document.querySelectorAll('#pb-board > *')].map(el =>
    el.classList.contains('pb-lane-split') ? '|DIVIDER|' : el.dataset.stageKey);
}

describe('pipelineBoard lane grouping (R1)', () => {
  test('columns run unstaged → main (by stage_number) → divider → off-ramps', async () => {
    const { window, errors } = await boot({ payload: lanedPayload() });
    expect(errors).toEqual([]);
    expect(domSequence(window)).toEqual([
      'unstaged', 'docs', 'filed', 'closed', '|DIVIDER|', 'dismissed', 'appeal',
    ]);
  });

  test('exactly one divider, and it sits between the lanes', async () => {
    const { window } = await boot({ payload: lanedPayload() });
    const seq = domSequence(window);
    expect(seq.filter(k => k === '|DIVIDER|')).toHaveLength(1);
    expect(seq.indexOf('|DIVIDER|')).toBe(seq.indexOf('dismissed') - 1);
  });

  test('off-ramp columns are marked, main columns are not', async () => {
    const { window } = await boot({ payload: lanedPayload() });
    const laneOf = (key) => window.document
      .querySelector(`.pb-col[data-stage-key="${key}"]`).classList.contains('pb-offramp');
    expect(laneOf('docs')).toBe(false);
    expect(laneOf('closed')).toBe(false);
    expect(laneOf('dismissed')).toBe(true);
    expect(laneOf('appeal')).toBe(true);
  });

  test('off-ramps stay REAL columns: cards render and the drop target is live', async () => {
    // lane governs projection, not position. Moving a case onto an off-ramp is
    // a normal operation, so the column must keep its body and its Sortable.
    const { window } = await boot({ payload: lanedPayload() });
    const body = window.document.querySelector('.pb-col[data-stage-key="dismissed"] .pb-col-body');
    expect(body).toBeTruthy();
    expect(body.querySelectorAll('.pb-card')).toHaveLength(1);
    // Every column body — both lanes — got hooked for drag/drop.
    const hooked = window.__sortableOpts.map(o => o.el.dataset.stageKey);
    expect(hooked).toContain('dismissed');
    expect(hooked).toContain('appeal');
  });

  test('the divider carries no data-stage-key, so scroll restore cannot target it', async () => {
    // render() keys scroll preservation on data-stage-key. A divider with one
    // would let a column's position be poured into a non-scrolling element.
    const { window } = await boot({ payload: lanedPayload() });
    const split = window.document.querySelector('.pb-lane-split');
    expect(split).toBeTruthy();
    expect(split.dataset.stageKey).toBeUndefined();
  });

  test('no off-ramps in the payload → no divider at all', async () => {
    const mainOnly = lanedPayload();
    mainOnly.stages = mainOnly.stages.filter(s => s.lane === 'main');
    const { window, errors } = await boot({ payload: mainOnly });
    expect(errors).toEqual([]);
    expect(window.document.querySelectorAll('.pb-lane-split')).toHaveLength(0);
    expect(domSequence(window)).toEqual(['unstaged', 'docs', 'filed', 'closed']);
  });

  test('a lane-less payload renders as all-main — the pre-migration server response', async () => {
    // Same assertion as the default-fixture tests, stated explicitly here so
    // the back-compat rule is visible next to the feature it protects.
    const noLane = lanedPayload();
    noLane.stages = noLane.stages.map(({ lane, ...rest }) => rest);
    const { window, errors } = await boot({ payload: noLane });
    expect(errors).toEqual([]);
    expect(window.document.querySelectorAll('.pb-lane-split')).toHaveLength(0);
    expect(window.document.querySelectorAll('.pb-col.pb-offramp')).toHaveLength(0);
    expect(domSequence(window)).toEqual([
      'unstaged', 'docs', 'filed', 'closed', 'dismissed', 'appeal',
    ]);
  });
});
