/**
 * tests/caseUi.sync.test.js
 *
 * BOOTS public/case.html for real, in jsdom, against a stub shell — with the
 * REAL public/js/yc-sync.js and public/scripts.js evaluated first, so the bus
 * under test is the shipped bus. (tests/contactUi.sync.test.js is the harness
 * this is built on; tests/pipelineBoardUi.sync.test.js is where the visibility
 * assertions come from.)
 *
 * WHY THIS FILE EXISTS
 *
 * case.html is the busiest subscriber in the system — the entity handler, the
 * pipeline freshness guard, the form-push chain, and two query-view readers all
 * hang off one page — and until now it was the only bus reader with no boot
 * test at all. Everything below is run-time-only behaviour that no amount of
 * reading the file proves:
 *
 *   · THE DIRTY FENCE IS A COMPARISON, NOT A LATCH. An unsaved Overview notes
 *     draft must survive a `case_notes` message from another frame, and the
 *     fence must LIFT by itself when the text goes back to what the server
 *     holds. The first cut of this latched, and a page could go permanently
 *     deaf to its own notes column.
 *   · POLLUTION + SUPERSESSION on `yc_refetch`. It is not a column; if the
 *     handler falls through it lands in entityData.case and is then pushed into
 *     every YCForm as a field.
 *   · THE COALESCE. A form save produces BOTH a bus emit and a `form-saved`
 *     message. The refetch push dominates, so the bus push must be dropped —
 *     and when it is not dropped it must still run SERIALIZED, because
 *     YCForm.refresh() is not reentrant.
 *   · THE PIPELINE FRESHNESS WINDOW. An in-page advance already drew the fresh
 *     payload; its own echo must not buy a second identical /pipeline GET.
 *   · THE VISIBILITY FENCE. A file parked behind another file was spending two
 *     GETs on every appt/event write anywhere in the app, for tables nobody
 *     could see.
 *
 * ON LEXICAL SCOPE (load-bearing, read before editing)
 *
 * scripts.js and case.html's inline blocks are separate <script> tags in the
 * browser, where top-level `const`/`let` share ONE global lexical environment.
 * An (indirect) `window.eval` does NOT reproduce that — per spec each eval gets
 * its own declarative environment, so `const E` from a scripts.js eval would be
 * invisible to a later case.html eval. They are therefore concatenated into a
 * SINGLE eval, which is what actually matches browser semantics here.
 *
 * ON MODELLING BroadcastChannel ORDERING (also load-bearing)
 *
 * In production the sniff runs in the SHELL's realm and reaches this frame over
 * BroadcastChannel — a MACROTASK — so a writer's own continuation (and the
 * `pwLastSet` / `apptsLastRefresh` stamps in it) always runs FIRST. The stub
 * apiSend defers its sniff by one macrotask for exactly that reason. Do not
 * "simplify" it away.
 *
 *   npx jest tests/caseUi.sync.test.js
 */

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

const CASE_ID = 'AAAAAAAA';

function casePayload(over = {}) {
  return {
    case: {
      case_id: CASE_ID,
      case_stage: 'Open',
      case_status: 'New',
      case_rec: 'N/A',
      case_source: 'Referral',
      case_notes: 'stored notes',
      case_alerts: '',
      case_caption: '',
      case_type: 'Bankruptcy',
      case_subtype: 'Ch. 7',
      case_number: '',
      case_number_full: '',
      ...over,
    },
    clients: [{ contact_id: 1001, contact_name: 'Ann Applebaum',
                contact_phone: '2485550001', relate_type: 'Primary' }],
    appts: [],
    log: [],
  };
}

function pipelinePayload(name = 'Intake') {
  return {
    template: { id: 1, name, role: 'intake' },
    stages:  [{ stage_key: 'consult', internal_label: 'Consult', client_label: 'Booked' }],
    history: [],
    current: null,
  };
}

/** jsdom has no layout, so document.hidden is the only visibility lever here. */
function setHidden(window, hidden) {
  Object.defineProperty(window.document, 'hidden', {
    configurable: true, get: () => hidden,
  });
}

/**
 * Boot case.html in jsdom against a stub shell.
 *
 * @param {object}   o
 * @param {object[]} o.payloads   successive GET /api/cases/:id bodies. The boot
 *   consumes the first; a refetch consumes the next (the last one repeats),
 *   which is how a test observes that the refetch actually re-read the server.
 * @param {string[]} o.pipelines  successive /pipeline template names, same rule.
 */
async function boot({ payloads = [casePayload()], pipelines = ['Intake'] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/case.html?caseID=${CASE_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  // jsdom boots a document at visibilityState 'prerender', i.e.
  // document.hidden === true. A real foreground tab is 'visible', and this
  // page's appt/event fence reads document.hidden through pageVisible(), so
  // without this every test would silently exercise the OFF-SCREEN path.
  // Tests that want hidden say so explicitly.
  setHidden(window, false);

  const calls = [];
  let payloadIx = 0;
  let pipelineIx = 0;
  // The shell's transport, INCLUDING its sync-bus hook. The setTimeout is the
  // BroadcastChannel macrotask — see the header.
  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    let data;
    if (url === `/api/cases/${CASE_ID}/pipeline`) {
      data = pipelinePayload(pipelines[Math.min(pipelineIx++, pipelines.length - 1)]);
    } else if (/^\/api\/cases\/[^/]+$/.test(url) && method === 'GET') {
      // include=appts is refreshAppts; include=contacts,appts,log is a full load.
      data = params && params.include === 'appts'
        ? { appts: [] }
        : payloads[Math.min(payloadIx++, payloads.length - 1)];
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

  // ── The shell, as case.html sees it (window.parent). ─────────────────────
  // jsdom's window.parent is non-configurable, but for a top-level window it IS
  // the window — so putting the shell's surface directly on `window` makes every
  // `P.x` lookup resolve exactly as it does in the real iframe (scripts.js does
  // `const P = window.parent`).
  window.apiSend  = apiSend;
  window.firmData = { users: [], phoneLines: [], emailFrom: [],
                      settings: { case_types: { Bankruptcy: ['Ch. 7', 'Ch. 13'] },
                                  lead_sources: ['Referral', 'Google'] },
                      currentUser: { user: 6 }, firmTimezone: 'America/Detroit' };
  window.limit    = 100;
  window.addFile  = () => {};

  // SweetAlert: scripts.js builds window.Toast from Swal.mixin at evaluation
  // time, so the stub has to exist before the eval and has to answer mixin().
  const toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async () => ({ isConfirmed: false }),
    close: () => {},
    showLoading: () => {},
    update: () => {},
    showValidationMessage: () => {},
    resetValidationMessage: () => {},
    getConfirmButton: () => null,
    isLoading: () => false,
    stopTimer: () => {},
    resumeTimer: () => {},
  };

  TEARDOWNS.push(bcPolyfill.install(window));
  window.eval(YCSYNC);

  // Markup first (the inline blocks touch the DOM at top level), comments
  // stripped so a `<script>` MENTIONED in a comment can't split a block.
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML =
    noComments.replace(/<script[\s\S]*?<\/script>/g, '');

  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  expect(inline.length).toBe(6);   // fence: a seventh block means this harness is stale

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  // ONE eval — see the lexical-scope note in the header. The trailing
  // Object.assign is a test-only window onto bindings that stay `const`/`let`
  // in the shipped file; every assertion still runs against the real handlers.
  window.eval(
    [SCRIPTS, ...inline].join('\n;\n') +
    '\n;Object.assign(window, { __t: {' +
    '  entityData:   () => window.entityData,' +
    '  header:       () => ({ caseNum: E("case").innerHTML,' +
    '                         type:    E("type").innerHTML,' +
    '                         alerts:  E("alertsDiv").textContent }),' +
    '  notesEl:      () => E("overviewCaseNotes"),' +
    '  stageEl:      () => E("caseStageSelect"),' +
    '  agePipeline:  () => { pwLastSet = 0; },' +
    '  pipelineName: () => (pwData && pwData.template ? pwData.template.name : null),' +
    '  isStale:      () => apptEventStale,' +
    '  markSaved:    () => { lastFormSavedAt = Date.now(); },' +
    '} });'
  );

  await tick(window, 60);
  return { window, calls, errors, toasts };
}

const caseLoads = calls =>
  calls.filter(c => /^\/api\/cases\/[^/]+$/.test(c.url) && c.method === 'GET' &&
                    !(c.params && c.params.include === 'appts'));
const apptGets = calls =>
  calls.filter(c => c.params && c.params.include === 'appts');
const eventGets   = calls => calls.filter(c => c.url === '/api/events');
const pipelineGets = calls => calls.filter(c => /\/pipeline$/.test(c.url));

/**
 * Attach a fake YCForm iframe so form pushes are observable.
 *
 * pushFormsFromEntityData walks `document.querySelectorAll('iframe')` and reads
 * `contentWindow.ycForm`. A srcless iframe is same-origin about:blank, so the
 * real loop runs against this exactly as it would against a real form.
 *
 * @returns {object[]} one entry per refresh() call, in order
 */
function attachForm(window, { slow = 0 } = {}) {
  const seen = [];
  const iframe = window.document.createElement('iframe');
  window.document.body.appendChild(iframe);
  iframe.contentWindow.ycForm = {
    config: { formKey: 'casedetails', endpoints: { load: { path: 'case' } } },
    refresh: async (arg) => {
      seen.push({ started: Date.now(), notes: arg?.liveData?.case_notes });
      if (slow) await new Promise(r => window.setTimeout(r, slow));
      seen[seen.length - 1].finished = Date.now();
    },
  };
  return seen;
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

describe('case.html boots', () => {
  test('loads the case, paints the header, and subscribes to its own address', async () => {
    const { window, calls, errors } = await boot();
    expect(errors).toEqual([]);
    expect(caseLoads(calls).length).toBe(1);
    expect(window.entityData.case.case_id).toBe(CASE_ID);
    expect(window.__t.header().caseNum).toBe('Not Filed');
    expect(window.__t.notesEl().value).toBe('stored notes');
  });

  test('a normal scalar message merges and repaints — Slice 1 behaviour, unchanged', async () => {
    const { window, calls } = await boot();
    window.YC.emit(`case:${CASE_ID}`,
                   { case_status: { from: 'New', to: 'Working' } }, 'test');
    await tick(window, 100);
    expect(window.entityData.case.case_status).toBe('Working');
    expect(window.document.getElementById('caseStatusInput').value).toBe('Working');
    // Merge-and-paint, NOT a refetch.
    expect(caseLoads(calls).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 1. The dirty fence on Overview notes  (must-have)
// ─────────────────────────────────────────────────────────────

describe('Overview notes dirty fence', () => {
  /** Type into the textarea the way the user does — value + the oninput hook. */
  function type(window, text) {
    const el = window.__t.notesEl();
    el.value = text;
    window.markNotesDirty(el);
    return el;
  }

  test('AN UNSAVED DRAFT SURVIVES a case_notes message from another frame', async () => {
    const { window } = await boot();
    const el = type(window, 'half-typed thought');
    expect(el.dataset.ycDirty).toBe('1');

    window.YC.emit(`case:${CASE_ID}`,
                   { case_notes: { from: 'stored notes', to: 'from the card' } }, 'test');
    await tick(window, 100);

    // entityData tracks the server; the textarea keeps the human's draft.
    expect(window.entityData.case.case_notes).toBe('from the card');
    expect(el.value).toBe('half-typed thought');
  });

  test('A CLEAN textarea IS updated — the fence is not a blanket block', async () => {
    const { window } = await boot();
    window.YC.emit(`case:${CASE_ID}`, { case_notes: 'from the card' }, 'test');
    await tick(window, 100);
    expect(window.__t.notesEl().value).toBe('from the card');
  });

  test('DIRTY IS A COMPARISON, NOT A LATCH: reverting the text lifts the fence', async () => {
    // The bug the comparison exists to prevent: with a latch, typing here and
    // then saving the same note from the Notes & Lists card left this textarea
    // deaf to the bus and to updateHeader for the life of the page.
    const { window } = await boot();
    const el = type(window, 'half-typed thought');
    expect(el.dataset.ycDirty).toBe('1');

    // Undo back to what the server holds.
    type(window, 'stored notes');
    expect(el.dataset.ycDirty).toBe('');

    window.YC.emit(`case:${CASE_ID}`, { case_notes: 'from the card' }, 'test');
    await tick(window, 100);
    expect(el.value).toBe('from the card');
  });

  test('the fence re-derives against the NEW stored value after a bus message', async () => {
    // entityData.case.case_notes is the comparison target precisely so that a
    // write from another frame moves the baseline. Typing the value that ARRIVED
    // must read as clean, not dirty.
    const { window } = await boot();
    window.YC.emit(`case:${CASE_ID}`, { case_notes: 'from the card' }, 'test');
    await tick(window, 100);

    const el = type(window, 'from the card');
    expect(el.dataset.ycDirty).toBe('');
  });

  test('a FOCUSED textarea is left alone even when clean', async () => {
    const { window } = await boot();
    const el = window.__t.notesEl();
    el.focus();
    expect(window.document.activeElement).toBe(el);

    window.YC.emit(`case:${CASE_ID}`, { case_notes: 'from the card' }, 'test');
    await tick(window, 100);
    expect(el.value).toBe('stored notes');
  });
});

// ─────────────────────────────────────────────────────────────
// 2. The form-push coalesce + serialization
// ─────────────────────────────────────────────────────────────

describe('form push — coalesce and serialization', () => {
  test('A BUS PUSH IS DROPPED when form-saved landed inside the window', async () => {
    // Both fire on any form save: the sniff sees the PATCH, and the form posts
    // form-saved. The refetch push strictly dominates (it re-reads the server),
    // so the bus one must not also run.
    const { window } = await boot();
    const pushes = attachForm(window);

    window.__t.markSaved();          // as if a form-saved just arrived
    window.YC.emit(`case:${CASE_ID}`, { case_status: 'Working' }, 'test');
    await tick(window, 200);

    expect(pushes.length).toBe(0);
  });

  test('a bus push with NO form-saved in the window DOES run', async () => {
    const { window } = await boot();
    const pushes = attachForm(window);

    window.YC.emit(`case:${CASE_ID}`, { case_status: 'Working' }, 'test');
    await tick(window, 200);

    expect(pushes.length).toBe(1);
  });

  test('CONCURRENT PUSHES SERIALIZE — YCForm.refresh() is not reentrant', async () => {
    // Two pushes enqueued while the first is still awaiting its onLoad must not
    // interleave; the chain is what guarantees that.
    const { window } = await boot();
    const pushes = attachForm(window, { slow: 60 });

    window.YC.emit(`case:${CASE_ID}`, { case_status: 'A' }, 'test');
    await tick(window, 60);
    window.YC.emit(`case:${CASE_ID}`, { case_status: 'B' }, 'test');
    await tick(window, 400);

    expect(pushes.length).toBe(2);
    // The second refresh cannot have started before the first finished.
    expect(pushes[1].started).toBeGreaterThanOrEqual(pushes[0].finished);
  });

  test('the push reads entityData AT RUN TIME, not when it was enqueued', async () => {
    // The property that makes serialization sufficient: whichever push runs
    // LAST reads the newest state, so the terminal state is right regardless of
    // the order the callers arrived in.
    const { window } = await boot();
    const pushes = attachForm(window, { slow: 80 });

    window.YC.emit(`case:${CASE_ID}`, { case_notes: 'first' }, 'test');
    await tick(window, 60);
    window.YC.emit(`case:${CASE_ID}`, { case_notes: 'second' }, 'test');
    await tick(window, 400);

    expect(pushes.length).toBe(2);
    expect(pushes[1].notes).toBe('second');
  });
});

// ─────────────────────────────────────────────────────────────
// 3. The pipeline freshness window
// ─────────────────────────────────────────────────────────────

describe('pipeline freshness guard', () => {
  test('pipeline_phase INSIDE the freshness window buys no second GET', async () => {
    // An in-page advance already drew the fresh payload; its own echo arrives
    // moments later. Without the guard every advance costs an identical
    // /pipeline GET on top of the one it just made.
    const { window, calls } = await boot();
    expect(pipelineGets(calls).length).toBe(1);   // boot

    window.YC.emit(`case:${CASE_ID}`,
                   { case_stage: 'Filed', pipeline_phase: 'case' }, 'test');
    await tick(window, 150);
    expect(pipelineGets(calls).length).toBe(1);
  });

  test('pipeline_phase OUTSIDE the window DOES refetch the widget', async () => {
    const { window, calls } = await boot({ pipelines: ['Intake', 'Litigation'] });
    window.__t.agePipeline();

    window.YC.emit(`case:${CASE_ID}`,
                   { case_stage: 'Filed', pipeline_phase: 'case' }, 'test');
    await tick(window, 150);

    expect(pipelineGets(calls).length).toBe(2);
    expect(window.__t.pipelineName()).toBe('Litigation');
  });

  test('A BARE case_stage change does NOT touch the pipeline', async () => {
    // Editing the column from the Overview select moves no pipeline position.
    // pipeline_phase present is the advance signature (`written` is never
    // partial) — widen this only if a writer appears that appends a log row
    // without touching pipeline_phase.
    const { window, calls } = await boot();
    window.__t.agePipeline();

    window.YC.emit(`case:${CASE_ID}`, { case_stage: 'Filed' }, 'test');
    await tick(window, 150);

    expect(pipelineGets(calls).length).toBe(1);
    // ...but the select still repaints.
    expect(window.__t.stageEl().value).toBe('Filed');
  });
});

// ─────────────────────────────────────────────────────────────
// 4. yc_refetch — the reserved field  (must-have)
// ─────────────────────────────────────────────────────────────

describe('yc_refetch handler', () => {
  test('answers with a REFETCH, and the fresh row lands in entityData', async () => {
    // What a merge survivor looks like afterwards: docket adopted from the
    // absorbed case, notes concatenated.
    const { window, calls } = await boot({
      payloads: [
        casePayload(),
        casePayload({ case_number: '24-12345', case_number_full: '24-12345-abc',
                      case_notes: 'stored notes\n--- merged ---\nfrom the other case' }),
      ],
    });
    expect(caseLoads(calls).length).toBe(1);

    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 150);

    expect(caseLoads(calls).length).toBe(2);
    expect(window.entityData.case.case_number_full).toBe('24-12345-abc');
    // The REFETCH is what repaints — the handler itself paints nothing.
    expect(window.__t.header().caseNum).toBe('24-12345-abc');
  });

  test('does NOT write yc_refetch into entityData.case', async () => {
    // The pollution fence. `yc_refetch` is not a column; if it reaches
    // entityData it is then pushed into every YCForm as a field.
    const { window } = await boot();
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 150);
    expect('yc_refetch' in window.entityData.case).toBe(false);
    expect(Object.keys(window.entityData.case)).not.toContain('yc_refetch');
  });

  test('does NOT touch the Overview inputs on the way past', async () => {
    // applyFieldsToOverview is superseded by the refetch, and running it with a
    // marker in hand would paint from stale state. An unsaved draft must be as
    // safe here as it is on the scalar path.
    const { window } = await boot({
      payloads: [casePayload(), casePayload({ case_notes: 'server wins' })],
    });
    const el = window.__t.notesEl();
    el.value = 'half-typed thought';
    window.markNotesDirty(el);

    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 150);

    expect(el.value).toBe('half-typed thought');
    expect(window.entityData.case.case_notes).toBe('server wins');
  });

  test('a marker ALONGSIDE real columns still only refetches', async () => {
    // Not a shape the sniff produces today, but the handler must not half-merge
    // if one ever appears: the refetch strictly dominates.
    const { window, calls } = await boot({
      payloads: [casePayload(), casePayload({ case_status: 'FromServer' })],
    });
    window.YC.emit(`case:${CASE_ID}`,
                   { yc_refetch: 1, case_status: 'FromBus' }, 'test');
    await tick(window, 150);
    expect(caseLoads(calls).length).toBe(2);
    expect(window.entityData.case.case_status).toBe('FromServer');
    expect('yc_refetch' in window.entityData.case).toBe(false);
  });

  test('§3.6 — THE REFETCH CANNOT LOOP: it is a GET, which the sniff drops', async () => {
    // One message in. The refetch is a GET; _sniff's method gate rejects GET
    // before any matcher runs, so no emit comes back out, so no second refetch.
    // If this ever fails the bus has become an infinite loop.
    const { window, calls } = await boot();
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(caseLoads(calls).length).toBe(2);            // boot + exactly one refetch
    expect(window.YC._log.map(m => m.addr)).toEqual([`case:${CASE_ID}`]);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  test('the refetch goes through the push CHAIN, not around it', async () => {
    // window.ycRefreshEntity is the queued entry point; calling refreshEntityData
    // bare would race the form-saved path at YCForm.refresh's awaited onLoad.
    const { window } = await boot();
    const seen = [];
    window.ycRefreshEntity = (...a) => { seen.push(a); };
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 60);
    expect(seen.length).toBe(1);
  });

  test("a DIFFERENT case's refetch message is ignored", async () => {
    const { window, calls } = await boot();
    window.YC.emit('case:ZZZZZZZZ', { yc_refetch: 1 }, 'test');
    await tick(window, 150);
    expect(caseLoads(calls).length).toBe(1);
  });

  test('A MERGE IN ANOTHER WINDOW refreshes this file — the real gate, end to end', async () => {
    // Two shell windows, the survivor open here, the merge performed there.
    // Nothing in this test knows about `yc_refetch`: it drives the real merge
    // response shape through the real sniff in the other window.
    const { window, calls } = await boot({
      payloads: [casePayload(), casePayload({ case_number_full: '24-12345-abc' })],
    });

    const other = new JSDOM('<!DOCTYPE html><html><body></body></html>',
                            { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    DOMS.push(other);
    TEARDOWNS.push(bcPolyfill.install(other.window));
    other.window.console.warn = () => {};
    other.window.eval(YCSYNC);

    other.window.YC._sniff('POST', `/api/cases/${CASE_ID}/merge`, {
      status: 'success',
      data: { dry_run: false, survivor_id: CASE_ID, loser_id: 'BBBBBBBB',
              fields: { filled: [], survivor_wins: [], conflicts: [] },
              children: { appts: 2, log: 9 } },
    });

    await tick(window, 150);
    expect(caseLoads(calls).length).toBe(2);
    expect(window.__t.header().caseNum).toBe('24-12345-abc');
  });

  test('a DRY-RUN merge in another window changes nothing here', async () => {
    const { window, calls } = await boot();

    const other = new JSDOM('<!DOCTYPE html><html><body></body></html>',
                            { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    DOMS.push(other);
    TEARDOWNS.push(bcPolyfill.install(other.window));
    other.window.console.warn = () => {};
    other.window.eval(YCSYNC);

    other.window.YC._sniff('POST', `/api/cases/${CASE_ID}/merge`, {
      status: 'success',
      data: { dry_run: true, survivor_id: CASE_ID, loser_id: 'BBBBBBBB' },
    });

    await tick(window, 150);
    expect(caseLoads(calls).length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// 5. The appt/event visibility fence  (must-have)
// ─────────────────────────────────────────────────────────────

describe('appt / event readers — visibility fence', () => {
  test('VISIBLE: an appt message refetches the appointment list', async () => {
    const { window, calls } = await boot();
    expect(apptGets(calls).length).toBe(0);

    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(apptGets(calls).length).toBe(1);
    expect(window.__t.isStale()).toBe(false);
  });

  test('VISIBLE: an event message refetches the event list', async () => {
    const { window, calls } = await boot();
    window.YC.emit('event:12', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(eventGets(calls).length).toBe(1);
  });

  test('HIDDEN: no GETs at all, and the stale flag is set', async () => {
    // The cost this fence exists to remove: two GETs per appt/event write
    // anywhere in the app, from a file nobody is looking at.
    const { window, calls } = await boot();
    setHidden(window, true);

    window.YC.emit('appt:55',  { yc_refetch: 1 }, 'test');
    window.YC.emit('event:12', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    expect(apptGets(calls).length).toBe(0);
    expect(eventGets(calls).length).toBe(0);
    expect(window.__t.isStale()).toBe(true);
  });

  test('ycBecameVisible() — coming back runs EXACTLY ONE refresh pass', async () => {
    // The shell's openMainTab -> pingBecameVisible path. One flag covers both
    // subscribers, so returning refreshes both lists once.
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(apptGets(calls).length).toBe(0);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 50);
    expect(apptGets(calls).length).toBe(1);
    expect(eventGets(calls).length).toBe(1);

    // Spent once, not again — no refetch per tab click.
    window.ycBecameVisible();
    await tick(window, 50);
    expect(apptGets(calls).length).toBe(1);
    expect(eventGets(calls).length).toBe(1);
  });

  test('ycBecameVisible() on a FRESH file is a no-op', async () => {
    const { window, calls } = await boot();
    window.ycBecameVisible();
    await tick(window, 50);
    expect(apptGets(calls).length).toBe(0);
    expect(eventGets(calls).length).toBe(0);
  });

  test('visibilitychange refreshes a stale file when the browser window returns', async () => {
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit('event:12', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    setHidden(window, false);
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 50);
    expect(eventGets(calls).length).toBe(1);
  });

  test('visibilitychange while STILL hidden keeps the flag for later', async () => {
    // The guard that matters: a file parked behind ANOTHER file must not spend
    // its stale flag just because the browser window regained focus — the later
    // ycBecameVisible would then find nothing to do and never refresh.
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);

    window.document.dispatchEvent(new window.Event('visibilitychange'));  // still hidden
    await tick(window, 50);
    expect(apptGets(calls).length).toBe(0);
    expect(window.__t.isStale()).toBe(true);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 50);
    expect(apptGets(calls).length).toBe(1);      // flag survived and paid off
  });

  test('THE ECHO FENCE STILL WORKS under the visibility fence', async () => {
    // refreshAppts is already the success callback for this page's own row
    // buttons; the bus then announces that same write back. The visibility fence
    // wraps around the echo fence and must not defeat it.
    const { window, calls } = await boot();
    window.refreshAppts();                       // stamps apptsLastRefresh
    await tick(window, 20);
    expect(apptGets(calls).length).toBe(1);

    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 400);
    expect(apptGets(calls).length).toBe(1);      // dropped as our own echo
    // ...and the message was NOT converted into a stale flag either: we are
    // visible and current, so there is nothing to come back to.
    expect(window.__t.isStale()).toBe(false);
  });

  test('a checklistView NOTE VALUE is treated as "refetch", not parsed', async () => {
    // appt:*/event:* carry two kinds of traffic. Wildcard readers are query
    // views and must never branch on field names.
    const { window, calls } = await boot();
    window.YC.emit('appt:55', { appt_note: 'called client' }, 'checklistView:saveBody');
    await tick(window, 400);
    expect(apptGets(calls).length).toBe(1);
  });

  test('§3.6 — the appt refresh is a GET and produces no emit', async () => {
    const { window, calls } = await boot();
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 500);
    expect(apptGets(calls).length).toBe(1);
    expect(window.YC._log.map(m => m.addr)).toEqual(['appt:55']);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });
});
