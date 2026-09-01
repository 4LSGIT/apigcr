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
  // `fire` answers "cancelled" by default, but when a test has armed
  // __swalValue it runs the dialog's REAL preConfirm with that value — which is
  // how a relate change is driven end-to-end without stubbing around
  // modifyCaseClient's body.
  window.__swalValue = undefined;
  window.Swal = {
    mixin: () => ({ fire: (o) => { toasts.push(o); } }),
    fire: async (o) => {
      if (window.__swalValue !== undefined && o && typeof o.preConfirm === 'function') {
        const v = window.__swalValue;
        window.__swalValue = undefined;
        const value = await o.preConfirm(v);
        return { isConfirmed: value !== false, value };
      }
      return { isConfirmed: false };
    },
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
  // fence: an eighth block means this harness is stale. Bumped 6 -> 7 by E1
  // (unified events), which added case.html's #tabTimeline renderer as its own
  // block beside the tab markup it drives — the tabEvents shape. Folding it into
  // an unrelated block to keep the counter at 6 would invert this guard's purpose.
  expect(inline.length).toBe(7);

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
    '  isEntityStale:   () => entityStale,' +
    '  isPipelineStale: () => pipelineStale,' +
    '  sourceEl:     () => E("caseSourceInput"),' +
    '  datalist:     () => [...E("leadSourceList").querySelectorAll("option")]' +
    '                        .map(o => o.value),' +
    '  clientLine:   () => ({ name: E("clientName").innerHTML,' +
    '                         phone: E("phone").innerHTML }),' +
    '  primary:      () => (PC ? PC.contact_id : null),' +
    '  modifyClient: (id, cur) => modifyCaseClient(id, cur),' +
    '  ageRefetch:   () => { entityLastRefetch = 0; },' +
    '  refetchFresh: () => entityRecentlyRefetched(),' +
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
    //
    // ── ORDER IS THE TEST, AND THIS USED TO BE FLAKY (fixed Slice 3c) ───────
    // The guard is `if (lastFormSavedAt >= t) return;` where `t` is stamped
    // when the BUS message arrives — "did a form-saved land in the 50ms window
    // AFTER this message". That is the production order: the sniff fires on the
    // PATCH response, and the form posts form-saved immediately after.
    //
    // This test used to call markSaved() BEFORE the emit, which made the two
    // stamps race inside one synchronous block: it passed only when both landed
    // in the same millisecond and failed roughly one run in three, on baseline,
    // with nothing wrong with the code. Stamping after the emit models the real
    // sequence and is deterministic.
    const { window } = await boot();
    const pushes = attachForm(window);

    window.YC.emit(`case:${CASE_ID}`, { case_status: 'Working' }, 'test');
    window.__t.markSaved();          // the form-saved that follows the save
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

// ─────────────────────────────────────────────────────────────
// Lead-source vocabulary changes (Slice 3c)
//
// `fe-lead_sources` is an app_settings row edited in settings.html, and every
// open case file subscribes to it so its datalist stays current. The subscriber
// used to answer by calling syncLeadSourceList(c), which ALSO writes the input's
// value from the stored row — so editing the vocabulary in one window reached
// into every open case file and reverted whatever was in the Lead Source box.
//
// Every other bus paint on this page is fenced on focus and ycDirty precisely
// to stop that. This path had no fence because it was never meant to be a value
// write at all. The dirty-fence tests above are the template.
// ─────────────────────────────────────────────────────────────

describe('lead source — vocabulary vs value', () => {
  const setting = (window, list) =>
    window.YC.emit('setting:fe-lead_sources', { value: JSON.stringify(list) }, 'test');

  test('AN UNSAVED TYPED VALUE SURVIVES a vocabulary change', async () => {
    const { window } = await boot();
    const el = window.__t.sourceEl();
    expect(el.value).toBe('Referral');            // painted from the case row at boot

    el.value = 'Word of mouth, sort of';          // typed, not yet blurred/saved
    setting(window, ['Referral', 'Google', 'Billboard']);
    await tick(window, 50);

    expect(el.value).toBe('Word of mouth, sort of');
  });

  test('…and the datalist DOES update — the fix is not "ignore the message"', async () => {
    const { window } = await boot();
    expect(window.__t.datalist()).toEqual(['Referral', 'Google']);

    setting(window, ['Referral', 'Google', 'Billboard']);
    await tick(window, 50);

    expect(window.__t.datalist()).toEqual(['Referral', 'Google', 'Billboard']);
  });

  test('A FOCUSED input is left alone too, even when its value is clean', async () => {
    const { window } = await boot();
    const el = window.__t.sourceEl();
    el.focus();
    expect(el).toBe(window.document.activeElement);

    setting(window, ['Referral', 'Google', 'Billboard']);
    await tick(window, 50);

    expect(el.value).toBe('Referral');            // unchanged, and never rewritten
    expect(window.__t.datalist()).toEqual(['Referral', 'Google', 'Billboard']);
  });

  test('the datalist repaints even when the case row never loaded', async () => {
    // The subscriber used to guard on `entityData.case`, which meant a page
    // whose load failed also stopped tracking the vocabulary. The datalist is
    // built from firmData, not from the row, so there is nothing to guard.
    const { window } = await boot();
    window.entityData.case = null;

    setting(window, ['Only', 'These']);
    await tick(window, 50);

    expect(window.__t.datalist()).toEqual(['Only', 'These']);
  });

  test('a FULL render still writes the value — syncLeadSourceList is unchanged', async () => {
    // The split must not cost the legitimate caller. updateHeader() is a full
    // render and the value SHOULD come from the row there.
    const { window } = await boot();
    const el = window.__t.sourceEl();
    el.value = 'scratch';
    window.updateHeader();
    expect(el.value).toBe('Referral');
  });

  test('§3.6 — a setting message produces no API traffic at all', async () => {
    const { window, calls } = await boot();
    const before = calls.length;
    setting(window, ['Referral', 'Google', 'Billboard']);
    await tick(window, 100);
    expect(calls.length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────
// case_relate — the Primary contact reaches the header (Slice 3c)
//
// The Primary is not a column on `cases`; it is the case_relate row whose type
// is 'Primary'. The header's client name and phone are painted from PC, which
// is derived from entityData.clients — and that derivation used to live inside
// loadEntityData, so every OTHER writer of that list left PC pointing at the
// previous Primary.
// ─────────────────────────────────────────────────────────────

describe('Primary contact → header', () => {
  test('a case_relate refetch repaints the CLIENT LINE, not just the table', async () => {
    // The end-to-end shape of the gate: a relate change anywhere announces
    // `{yc_refetch:1}` to this case, the page re-reads, and the header follows.
    const { window } = await boot({
      payloads: [
        casePayload(),
        // The refetch: a different contact is now Primary.
        (() => {
          const p = casePayload();
          p.clients = [
            { contact_id: 1001, contact_name: 'Ann Applebaum',
              contact_phone: '2485550001', relate_type: 'Other' },
            { contact_id: 2002, contact_name: 'Zed Zimmer',
              contact_phone: '2485559999', relate_type: 'Primary' },
          ];
          return p;
        })(),
      ],
    });

    expect(window.__t.clientLine()).toEqual({ name: 'Ann Applebaum', phone: '248-555-0001' });
    expect(window.__t.primary()).toBe(1001);

    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);

    expect(window.__t.primary()).toBe(2002);
    expect(window.__t.clientLine()).toEqual({ name: 'Zed Zimmer', phone: '248-555-9999' });
  });

  test('deriveContactRefs runs on the refetch, not only on the first load', async () => {
    // The narrow assertion under the one above: PC tracks entityData.clients
    // wherever that list is replaced.
    const { window } = await boot({
      payloads: [
        casePayload(),
        (() => {
          const p = casePayload();
          p.clients = [{ contact_id: 3003, contact_name: 'New Primary',
                         contact_phone: '', relate_type: 'Primary' }];
          return p;
        })(),
      ],
    });
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    expect(window.__t.primary()).toBe(3003);
  });

  test('a case with NO Primary clears the line rather than keeping a ghost', async () => {
    const { window } = await boot({
      payloads: [
        casePayload(),
        (() => {
          const p = casePayload();
          p.clients = [{ contact_id: 1001, contact_name: 'Ann Applebaum',
                         contact_phone: '2485550001', relate_type: 'Other' }];
          return p;
        })(),
      ],
    });
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    expect(window.__t.primary()).toBe(null);
    expect(window.__t.clientLine()).toEqual({ name: '', phone: '' });
  });
});

// ─────────────────────────────────────────────────────────────
// Entity-subscriber network fences (Slice 3c)
//
// The appt/event readers took the visibility fence in Slice 3b; the ENTITY
// subscriber did not. So a parked case file still answered every merge, every
// intake create and every case_relate change with a full case GET, and every
// pipeline advance anywhere with a /pipeline GET — one round-trip per write,
// per open file, per background browser window, to redraw a page nobody could
// see.
//
// THE FENCE IS AROUND THE NETWORK CALL ONLY. Merge and paint stay unfenced,
// deliberately: a hidden page does not re-render when it is shown again, so its
// DOM has to track messages as they arrive or it comes back wrong.
// ─────────────────────────────────────────────────────────────

describe('entity subscriber — network fences', () => {
  test('HIDDEN: a yc_refetch costs ZERO GETs and sets the flag', async () => {
    const { window, calls } = await boot();
    setHidden(window, true);
    const before = caseLoads(calls).length;

    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);

    expect(caseLoads(calls).length).toBe(before);
    expect(window.__t.isEntityStale()).toBe(true);
  });

  test('ycBecameVisible() → EXACTLY ONE refetch, and the flag is spent', async () => {
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    expect(caseLoads(calls).length).toBe(1);          // boot only

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 100);
    expect(caseLoads(calls).length).toBe(2);
    expect(window.__t.isEntityStale()).toBe(false);

    // Spent once, not per tab click.
    window.ycBecameVisible();
    await tick(window, 100);
    expect(caseLoads(calls).length).toBe(2);
  });

  test('A BURST WHILE HIDDEN still costs ONE refetch on return', async () => {
    // Three merges and an intake create land while the file is parked. The flag
    // is a boolean, so returning re-reads the server once — which is the whole
    // point of an invalidation rather than a queue of them.
    const { window, calls } = await boot();
    setHidden(window, true);
    for (let i = 0; i < 4; i++) {
      window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    }
    await tick(window, 200);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 100);
    expect(caseLoads(calls).length).toBe(2);
  });

  test('VISIBLE: a yc_refetch still refetches immediately — no regression', async () => {
    const { window, calls } = await boot();
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    expect(caseLoads(calls).length).toBe(2);
    expect(window.__t.isEntityStale()).toBe(false);
  });

  test('HIDDEN: pipeline_phase defers its /pipeline GET behind its OWN flag', async () => {
    const { window, calls } = await boot();
    window.__t.agePipeline();                        // past the freshness window
    setHidden(window, true);
    const before = pipelineGets(calls).length;

    window.YC.emit(`case:${CASE_ID}`, { pipeline_phase: 'case' }, 'test');
    await tick(window, 200);

    expect(pipelineGets(calls).length).toBe(before);
    expect(window.__t.isPipelineStale()).toBe(true);
    expect(window.__t.isEntityStale()).toBe(false);   // a different flag entirely
  });

  test('THE MERGE AND PAINT ARE NOT FENCED — a hidden page still tracks state', async () => {
    // Load-bearing, and the reason the fence is around the network call rather
    // than around the message: nothing re-renders this page when it is shown
    // again. If a hidden page dropped its scalar messages, coming back would
    // show values the database stopped holding minutes ago.
    const { window } = await boot();
    setHidden(window, true);

    window.YC.emit(`case:${CASE_ID}`, { case_status: 'Working' }, 'test');
    await tick(window, 200);

    expect(window.entityData.case.case_status).toBe('Working');
    expect(window.document.getElementById('caseStatusInput').value).toBe('Working');
  });

  test('THE THREE FLAGS DO NOT STRAND EACH OTHER', async () => {
    /* THE BUG THIS SLICE ALMOST SHIPPED. The old flush opened with
       `if (!apptEventStale || !pageVisible()) return;` — a single early return
       on ONE flag. Adding two more beside it under that shape would have meant a
       file that went stale on a merge but not on an appointment came back on
       screen, hit the early return, and never refetched at all.
       Each flag is now checked on its own. */
    const { window, calls } = await boot();
    window.__t.agePipeline();
    setHidden(window, true);

    // Entity + pipeline go stale; the appt/event pair deliberately does NOT.
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    window.YC.emit(`case:${CASE_ID}`, { pipeline_phase: 'case' }, 'test');
    await tick(window, 200);
    expect(window.__t.isStale()).toBe(false);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 150);

    expect(caseLoads(calls).length).toBe(2);          // entity flushed
    expect(pipelineGets(calls).length).toBe(2);       // pipeline flushed
  });

  test('the appt/event flag still flushes when it is the ONLY one set', async () => {
    // The mirror of the test above — the flag that used to own the early return
    // must not have lost anything in the restructure.
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit('appt:55', { yc_refetch: 1 }, 'test');
    await tick(window, 200);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 100);

    expect(apptGets(calls).length).toBe(1);
    expect(eventGets(calls).length).toBe(1);
    expect(caseLoads(calls).length).toBe(1);          // no entity refetch it never needed
  });

  test('visibilitychange flushes the entity flag when the window returns', async () => {
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);

    setHidden(window, false);
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 100);

    expect(caseLoads(calls).length).toBe(2);
  });

  test('visibilitychange while STILL hidden keeps every flag for later', async () => {
    // Returning to the browser window while this file sits behind ANOTHER file
    // must not spend the flags on surfaces nobody can see.
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);

    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await tick(window, 100);

    expect(caseLoads(calls).length).toBe(1);
    expect(window.__t.isEntityStale()).toBe(true);
  });

  test('§3.6 — the deferred refetch is still a GET and cannot loop', async () => {
    const { window, calls } = await boot();
    setHidden(window, true);
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 200);

    // The stub sniffs everything it is given; a GET matches nothing, so the
    // refetch produces no second message and no second refetch.
    expect(caseLoads(calls).length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────
// The relate-write echo fence (Slice 3d)
//
// Slice 3c put case_relate on the bus, which means the page that CHANGES a
// Primary now hears its own write come back:
//
//   modifyCaseClient → PATCH .../contacts/:id
//     → local list patch + repaint
//     → sniff emits {yc_refetch:1} straight back at this frame
//       → ycRefreshEntity() → a full-include GET the page did not need
//
// Two GETs for one click, the second strictly redundant. Exactly the class
// pwLastSet closes for the pipeline widget and boardLastLoad for the board,
// arriving on a new path — and Slice 2c predicted it in as many words when it
// deferred the recipient emit: "the fence is the prerequisite".
// ─────────────────────────────────────────────────────────────

describe('entity refetch — echo fence', () => {
  // loadEntityData sends include=contacts,appts,log; _refreshCaseClients sends
  // include=contacts. Both are GETs on /api/cases/:id, so they have to be told
  // apart by their include or the assertions below mean nothing.
  const entityGets   = calls => calls.filter(c =>
    /^\/api\/cases\/[^/]+$/.test(c.url) && c.method === 'GET' &&
    c.params && c.params.include === 'contacts,appts,log');
  const contactsGets = calls => calls.filter(c =>
    /^\/api\/cases\/[^/]+$/.test(c.url) && c.method === 'GET' &&
    c.params && c.params.include === 'contacts');

  test('A RELATE WRITE COSTS ONE CONTACTS GET AND ZERO ENTITY GETS', async () => {
    // The headline assertion of this slice. The whole round trip runs: the real
    // dialog's preConfirm, the real PATCH, the real local patch and repaint,
    // and the real echo arriving one macrotask later.
    const { window, calls } = await boot();
    const before = { entity: entityGets(calls).length, contacts: contactsGets(calls).length };

    window.__swalValue = 'Secondary';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);          // well past the echo macrotask

    expect(calls.filter(c => c.method === 'PATCH').length).toBe(1);
    expect(entityGets(calls).length - before.entity).toBe(0);
    expect(contactsGets(calls).length - before.contacts).toBe(0);
  });

  test('a REMOVE costs no entity GET either — the DELETE echoes the same way', async () => {
    const { window, calls } = await boot();
    const before = entityGets(calls).length;

    window.__swalValue = 'Remove';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);

    expect(calls.filter(c => c.method === 'DELETE').length).toBe(1);
    expect(entityGets(calls).length).toBe(before);
  });

  test('the local repaint still happens — the fence suppresses the GET, not the update', async () => {
    // Load-bearing. Dropping the echo is only safe because the writing page
    // already applied the change itself.
    const { window } = await boot();
    expect(window.__t.primary()).toBe(1001);

    window.__swalValue = 'Other';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);

    expect(window.__t.primary()).toBe(null);          // no Primary any more
    expect(window.__t.clientLine()).toEqual({ name: '', phone: '' });
  });

  test('A REMOTE yc_refetch OUTSIDE THE WINDOW STILL REFETCHES', async () => {
    // The fence must not become a mute button. This is the case the window
    // exists to keep working.
    const { window, calls } = await boot();
    window.__swalValue = 'Secondary';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);
    const after = entityGets(calls).length;

    window.__t.ageRefetch();                          // as if 1500ms had passed
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);

    expect(entityGets(calls).length).toBe(after + 1);
  });

  test('a fresh page is NOT fenced — boot does not stamp', async () => {
    // boot calls loadEntityData() directly rather than refreshEntityData(), so
    // a remote write landing right after a page opens is still honoured. That
    // is deliberate: nobody's write caused the boot, so there is no echo to
    // suppress.
    const { window, calls } = await boot();
    expect(window.__t.refetchFresh()).toBe(false);

    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    expect(entityGets(calls).length).toBe(2);
  });

  test('THE FENCE SITS ABOVE THE VISIBILITY CHECK — a hidden page does not go stale on its own echo', async () => {
    // Fencing below it would leave a parked page marking itself dirty on its
    // own write and buying the redundant GET later instead of now: the cost
    // deferred, not removed.
    const { window, calls } = await boot();
    setHidden(window, true);

    window.__swalValue = 'Secondary';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);

    expect(window.__t.isEntityStale()).toBe(false);

    setHidden(window, false);
    window.ycBecameVisible();
    await tick(window, 200);
    expect(entityGets(calls).length).toBe(1);         // boot only
  });

  test('the fence coalesces a burst, then reopens — the accepted tradeoff, stated', async () => {
    // A legitimate remote refetch inside the window IS dropped, and the page
    // waits for the next event. Already accepted for pwLastSet (same 1500ms)
    // and the board. Pinned so the behaviour is a decision, not a surprise.
    const { window, calls } = await boot();
    window.__swalValue = 'Secondary';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);
    const after = entityGets(calls).length;

    for (let i = 0; i < 3; i++) {
      window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    }
    await tick(window, 200);
    expect(entityGets(calls).length).toBe(after);     // all three inside the window

    window.__t.ageRefetch();
    window.YC.emit(`case:${CASE_ID}`, { yc_refetch: 1 }, 'test');
    await tick(window, 200);
    expect(entityGets(calls).length).toBe(after + 1); // and the window reopens
  });

  test('the fence does NOT touch scalar messages', async () => {
    // It guards one branch. A remote status change inside the window must still
    // merge and paint — it carries its own values and costs no network call.
    const { window } = await boot();
    window.__swalValue = 'Secondary';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);

    window.YC.emit(`case:${CASE_ID}`, { case_status: 'Working' }, 'test');
    await tick(window, 100);
    expect(window.entityData.case.case_status).toBe('Working');
  });

  test('and it does NOT touch the pipeline branch', async () => {
    const { window, calls } = await boot();
    window.__t.agePipeline();
    window.__swalValue = 'Secondary';
    await window.__t.modifyClient('1001', 'Primary');
    await tick(window, 300);
    const before = pipelineGets(calls).length;

    window.YC.emit(`case:${CASE_ID}`, { pipeline_phase: 'case' }, 'test');
    await tick(window, 200);
    expect(pipelineGets(calls).length).toBe(before + 1);
  });
});
