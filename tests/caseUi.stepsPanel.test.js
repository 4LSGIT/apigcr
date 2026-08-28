// tests/caseUi.stepsPanel.test.js
//
// R3 — the staff Steps panel inside public/case.html's #pipelinePanel.
//
// BOOTS THE REAL PAGE in jsdom against a stub shell, with the real
// public/js/yc-sync.js and public/scripts.js evaluated first. Harness lifted
// wholesale from tests/caseUi.sync.test.js (same lexical-scope and
// BroadcastChannel-ordering reasoning — read that file's header before editing
// this one); tests/pipelineBoardUi.sync.test.js is where the "drive the real
// handlers, stub only the library" posture comes from.
//
// WHY THIS FILE EXISTS
//
// Everything the panel does is a RENDERING DECISION over a payload, and the
// decisions that matter are exactly the ones that look like styling until they
// are wrong:
//
//   · THE OFF-RAMP RAIL IS NOT DECORATION. Off-ramps carry high stage_numbers
//     purely because they were appended last, so a flat ordered list puts
//     "Dismissed" between two live stages and tells staff it is what comes
//     next. R1 fixed that for the projection; the rail is the same fix here,
//     and "never interleaved" is the assertion that keeps it fixed.
//   · THE INTAKE-HISTORY SECTION IS FINDING F2'S CONSUMER. A phase-'case'
//     case's intake work items exist, resolve correctly, and appear in NO
//     OTHER SURFACE — the pipeline payload is stage-anchored and structurally
//     cannot carry them. If the second GET stops firing, the regression is
//     invisible except here.
//   · THE OVERRIDE BUTTONS ARE THE ONLY WRITE PATH. They must hit the exact
//     R2 endpoints with the exact method/body, and 'clear' must be absent when
//     there is no override to clear (a button that 404s is worse than none).
//   · STATUSES ARRIVE RESOLVED. The panel must render `skipped`/`na` as given
//     and never re-derive from position — the browser does not have the
//     detector hits to derive with, so a re-derivation would silently lie.
//   · FEATURE-DETECTED PROJECTION. R2.5 ships in a parallel slice; the panel
//     must render identically with `projected`, without it, and on a server
//     that has never emitted it.
//
// Run:
//   npx jest tests/caseUi.stepsPanel.test.js

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
// Fixtures — shapes copied from the live payloads (2026-08-27)
// ─────────────────────────────────────────────────────────────────────────────

function casePayload() {
  return {
    case: {
      case_id: CASE_ID, case_stage: 'Pending', case_status: 'Docs Requested',
      case_rec: 'N/A', case_source: '', case_notes: '', case_alerts: '',
      case_caption: '', case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
      case_number: '', case_number_full: '',
    },
    clients: [], appts: [], log: [],
  };
}

/** getPipeline's `stages` projection + the R2 `requirements` attach. */
function stage(over) {
  return Object.assign({
    stage_id: 5, stage_key: 'docs', stage_number: 2,
    internal_label: 'Docs Requested', client_label: 'Gathering your documents',
    case_stage: 'Pending', is_terminal: 0, lane: 'main',
    default_rec: '', client_visible: 1, requirements: [],
  }, over);
}

/** resolvedRequirement — requirementService's frozen shape. */
function req(over) {
  return Object.assign({
    requirement_key: 'upload_docs', stage_id: 5, stage_key: 'docs',
    internal_label: 'Upload requested documents',
    client_label: 'Upload your documents',
    client_visible: 1, required: 1, owner: 'client', kind: 'task',
    hint: 'Everything on your document request list', effort: null,
    group_label: 'Documents', sort_order: 1,
    status: 'active', satisfied_at: null, detail: null, progress: null,
    override: null,
  }, over);
}

const S_RETAINED = () => stage({
  stage_id: 23, stage_key: 'retained', stage_number: 1,
  internal_label: 'Retained — Send Doc Request',
});
const S_DOCS = () => stage({
  requirements: [req({ progress: '4 of 7 received' })],
});
const S_FILED = () => stage({
  stage_id: 6, stage_key: 'filed', stage_number: 3, internal_label: 'Filed',
  requirements: [req({
    requirement_key: 'meeting_341_set', stage_id: 6, stage_key: 'filed',
    internal_label: '341 meeting date set', owner: 'system', kind: 'event',
    group_label: '341 Meeting', hint: 'Set by the court after filing',
    status: 'upcoming',
  })],
});
const S_DISMISSED = () => stage({
  stage_id: 25, stage_key: 'dismissed', stage_number: 7,
  internal_label: 'Dismissed', lane: 'offramp', client_visible: 0,
});

function pipelinePayload(over = {}) {
  return Object.assign({
    template: { id: 2, name: 'Bankruptcy — Chapter 7', role: 'case',
                case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
    current: { stage_id: 5, stage_key: 'docs', case_stage: 'Pending',
               status_label: 'Docs Requested', entered_at: '2026-08-27T18:48:38.000Z',
               entered_by: 6, source: 'system', note: null },
    history: [
      { stage_id: 23, stage_key: 'retained', case_stage: 'Pending',
        status_label: 'Retained — Send Doc Request',
        entered_at: '2026-08-27T18:48:25.000Z', entered_by: 6, source: 'manual', note: null },
      { stage_id: 5, stage_key: 'docs', case_stage: 'Pending',
        status_label: 'Docs Requested', entered_at: '2026-08-27T18:48:38.000Z',
        entered_by: 6, source: 'system', note: null },
    ],
    upcoming: [S_FILED()],
    stages: [S_RETAINED(), S_DOCS(), S_FILED(), S_DISMISSED()],
  }, over);
}

/** The full-resolver route's body — BOTH templates. */
function fullRequirements() {
  return [
    // Intake template (stage ids NOT in the payload's stages) — F2's rows.
    req({ requirement_key: 'submit_questionnaire', stage_id: 2, stage_key: 'consult_booked',
          internal_label: 'Submit intake questionnaire', group_label: 'Intake',
          effort: '~25 min', status: 'done', satisfied_at: '2026-03-04T15:00:00.000Z',
          detail: 'Submitted' }),
    req({ requirement_key: 'iss_held', stage_id: 2, stage_key: 'consult_booked',
          internal_label: 'Initial Strategy Session held', group_label: 'Intake',
          kind: 'event', sort_order: 2, status: 'skipped' }),
    req({ requirement_key: 'sign_retainer', stage_id: 18, stage_key: 'contract_sent',
          internal_label: 'Sign retainer agreement', group_label: 'Retainer',
          status: 'done', satisfied_at: '2026-08-27T18:47:05.000Z', detail: 'Signed' }),
    // Resolved-template rows — already on the payload's stages, so NOT history.
    req({ progress: '4 of 7 received' }),
    req({ requirement_key: 'meeting_341_set', stage_id: 6, stage_key: 'filed',
          internal_label: '341 meeting date set', owner: 'system', kind: 'event',
          status: 'upcoming' }),
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
 * @param {object}   o.pipeline    the /pipeline body (defaults to the live shape)
 * @param {object[]} o.full        the /pipeline/requirements body
 * @param {boolean}  o.fullFails   make the second GET reject
 * @param {string}   o.swalInput   value the override prompt "types" (undefined = cancel)
 */
async function boot({ pipeline = null, full = null, fullFails = false,
                      swalInput = undefined } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: `https://app.4lsg.com/case.html?caseID=${CASE_ID}`,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  setHidden(window, false);

  const calls = [];
  // The shell's transport, INCLUDING its sync-bus hook. The setTimeout is the
  // BroadcastChannel macrotask — see tests/caseUi.sync.test.js's header.
  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    let data;
    if (url === `/api/cases/${CASE_ID}/pipeline`) {
      data = pipeline || pipelinePayload();
    } else if (url === `/api/cases/${CASE_ID}/pipeline/requirements`) {
      if (fullFails) throw Object.assign(new Error('nope'), { status: 500 });
      data = { status: 'success', requirements: full || fullRequirements() };
    } else if (/\/override$/.test(url)) {
      data = { status: 'success' };
    } else if (/^\/api\/cases\/[^/]+$/.test(url) && method === 'GET') {
      data = params && params.include === 'appts' ? { appts: [] } : casePayload();
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
    // The override prompt is an input dialog: `swalInput` undefined models the
    // user cancelling, a string models them confirming with that note.
    fire: async () => (swalInput === undefined
      ? { isConfirmed: false, value: undefined }
      : { isConfirmed: true, value: swalInput }),
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
  expect(inline.length).toBe(6);   // fence: a seventh block means this harness is stale

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  // ONE eval — see the lexical-scope note in tests/caseUi.sync.test.js.
  window.eval(
    [SCRIPTS, ...inline].join('\n;\n') +
    '\n;Object.assign(window, { __t: {' +
    '  steps:      () => E("pwSteps"),' +
    '  offReqs:    () => pwOffTemplateReqs,' +
    '  override:   (k, s) => pwOverride(k, s),' +
    '  clear:      (k) => pwClearOverride(k),' +
    '} });'
  );

  await tick(window, 80);
  return { window, calls, errors, toasts };
}

const $$ = (w, sel) => [...w.document.querySelectorAll(sel)];
const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const pipelineGets = calls => calls.filter(c => /\/pipeline$/.test(c.url));
const fullGets = calls => calls.filter(c => /\/pipeline\/requirements$/.test(c.url));

// ─────────────────────────────────────────────────────────────────────────────
// Boot + the fetch shape
// ─────────────────────────────────────────────────────────────────────────────

describe('the Steps panel boots', () => {
  test('asks for requirements as a GET PARAMS object — one round trip for the timeline AND the steps', async () => {
    const { calls, errors } = await boot();
    expect(errors).toEqual([]);
    const g = pipelineGets(calls);
    expect(g).toHaveLength(1);
    // The URL stays bare; apiSend builds the query string. (A literal
    // '?requirements=1' in the url would also break every sibling harness.)
    expect(g[0].url).toBe(`/api/cases/${CASE_ID}/pipeline`);
    expect(g[0].params).toEqual({ requirements: 1 });
  });

  test('stage sections render from the payload, in template order, main lane only', async () => {
    const { window } = await boot();
    const names = $$(window, '.pw-steps-main .pw-stage .pw-stage-name').map(txt);
    expect(names).toEqual(['Retained — Send Doc Request', 'Docs Requested', 'Filed']);
    // The off-ramp is NOT among them — see the rail test below.
    expect(names).not.toContain('Dismissed');
  });

  test('the CURRENT stage is marked, and entered stages carry their history date', async () => {
    const { window } = await boot();
    const cur = $$(window, '.pw-stage-cur');
    expect(cur).toHaveLength(1);
    expect(txt(cur[0].querySelector('.pw-stage-name'))).toBe('Docs Requested');
    // The two entered stages have dates; the unentered one does not.
    const whens = $$(window, '.pw-steps-main .pw-stage .pw-stage-when').map(txt);
    expect(whens[0]).toMatch(/Aug 27, 2026/);
    expect(whens[1]).toMatch(/Aug 27, 2026/);
    expect(whens[2]).toBe('');
  });

  test('a payload with NO requirements anywhere renders NO steps view (zero-behaviour-change)', async () => {
    const bare = pipelinePayload({
      stages: [S_RETAINED(), stage({ requirements: [] })],
      upcoming: [],
    });
    const { window } = await boot({ pipeline: bare, full: [] });
    expect(txt(window.__t.steps())).toBe('');
    // ...and the timeline above is untouched.
    expect($$(window, '#pwTimeline .pw-row').length).toBeGreaterThan(0);
  });

  test('no template → no steps view, and the panel still says why', async () => {
    const { window } = await boot({ pipeline: { template: null, current: null,
                                                history: [], upcoming: [], stages: [] } });
    expect(txt(window.__t.steps())).toBe('');
    expect(txt(window.document.getElementById('pwTimeline')))
      .toContain('No pipeline configured');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The off-ramp rail
// ─────────────────────────────────────────────────────────────────────────────

describe('off-ramp rail', () => {
  test('off-ramps live in the rail and are NEVER interleaved with main stages', async () => {
    const { window } = await boot();
    const rail = window.document.querySelector('.pw-rail');
    expect(rail).not.toBeNull();
    expect($$(window, '.pw-rail-item').map(txt)).toEqual(['Dismissed']);
    // The rail is a SIBLING of the stage column, not a stage in it.
    expect(rail.querySelector('.pw-stage')).toBeNull();
    expect(window.document.querySelector('.pw-steps-main').contains(rail)).toBe(false);
  });

  test('a template with no off-ramps renders no rail at all', async () => {
    const p = pipelinePayload({ stages: [S_RETAINED(), S_DOCS(), S_FILED()] });
    const { window } = await boot({ pipeline: p });
    expect(window.document.querySelector('.pw-rail')).toBeNull();
  });

  test('a case SITTING on an off-ramp is marked in the rail (position is lane-agnostic)', async () => {
    const p = pipelinePayload({
      current: { stage_id: 25, stage_key: 'dismissed', case_stage: 'Closed',
                 status_label: 'Dismissed', entered_at: '2026-08-27T19:00:00.000Z',
                 entered_by: 6, source: 'manual', note: null },
    });
    const { window } = await boot({ pipeline: p });
    const here = $$(window, '.pw-rail-item.pw-rail-here').map(txt);
    expect(here).toEqual(['Dismissed']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Requirement rows
// ─────────────────────────────────────────────────────────────────────────────

describe('requirement rows', () => {
  test('grouped by group_label, with the internal label, owner badge and subtitle', async () => {
    const { window } = await boot();
    const docs = $$(window, '.pw-stage')[1];
    expect(txt(docs.querySelector('.pw-grp'))).toBe('Documents');
    expect(txt(docs.querySelector('.pw-req-label'))).toBe('Upload requested documents');
    expect(txt(docs.querySelector('.pw-owner'))).toBe('client');
    // progress wins over hint in the subtitle ladder.
    expect(txt(docs.querySelector('.pw-req-sub'))).toBe('4 of 7 received');
  });

  test('status classes come STRAIGHT from the payload — never re-derived from position', async () => {
    // A `done` requirement on a stage the case has NOT reached yet. Position
    // would say "upcoming"; the resolver says done (a detector fired early).
    // The panel must say what it was told.
    const p = pipelinePayload({
      stages: [S_RETAINED(), S_DOCS(),
               stage({ stage_id: 6, stage_key: 'filed', stage_number: 3,
                       internal_label: 'Filed',
                       requirements: [req({ requirement_key: 'early', stage_id: 6,
                                            internal_label: 'Done early',
                                            status: 'done',
                                            satisfied_at: '2026-03-04T15:00:00.000Z',
                                            detail: 'Signed' })] }),
               S_DISMISSED()],
    });
    const { window } = await boot({ pipeline: p, full: [] });
    const row = [...window.document.querySelectorAll('.pw-req')]
      .find(r => txt(r).includes('Done early'));
    expect(row.className).toContain('pw-req-done');
    expect(txt(row.querySelector('.pw-req-sub'))).toContain('Signed');
    expect(txt(row.querySelector('.pw-req-sub'))).toContain('Mar 4, 2026');
  });

  test('na renders greyed with an N/A chip; skipped renders greyed', async () => {
    const p = pipelinePayload({
      stages: [stage({ requirements: [
        req({ requirement_key: 'naw', internal_label: 'Not applicable work', status: 'na',
              override: { status: 'na', note: 'no vehicles', set_by: 6, at: '2026-08-27' } }),
        req({ requirement_key: 'skw', internal_label: 'Skipped work', status: 'skipped',
              sort_order: 2 }),
      ] })],
      upcoming: [],
    });
    const { window } = await boot({ pipeline: p, full: [] });
    const rows = $$(window, '.pw-req');
    expect(rows[0].className).toContain('pw-req-muted');
    expect(txt(rows[0].querySelector('.pw-na'))).toBe('N/A');
    expect(txt(rows[0])).toContain('no vehicles');       // the override note surfaces
    expect(rows[1].className).toContain('pw-req-muted');
    expect(txt(rows[1])).toContain('Skipped work');
  });

  test('a stage with no requirements says so rather than rendering an empty block', async () => {
    const { window } = await boot();
    const retained = $$(window, '.pw-stage')[0];
    expect(txt(retained.querySelector('.pw-stage-empty'))).toBe('No requirements');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Intake history — finding F2's consumer
// ─────────────────────────────────────────────────────────────────────────────

describe('intake history', () => {
  test('a phase-`case` case fetches the full resolver and collapses the OFF-TEMPLATE rows', async () => {
    const { window, calls } = await boot();
    expect(fullGets(calls)).toHaveLength(1);

    const details = window.document.querySelector('.pw-intake');
    expect(details).not.toBeNull();
    expect(details.tagName).toBe('DETAILS');
    expect(details.hasAttribute('open')).toBe(false);          // collapsed
    expect(txt(details.querySelector('summary'))).toBe('Intake history (3)');

    // Exactly the rows whose stage is NOT in this payload's stages.
    const labels = [...details.querySelectorAll('.pw-req-label')].map(txt);
    expect(labels).toEqual([
      'Submit intake questionnaire',
      'Initial Strategy Session held',
      'Sign retainer agreement',
    ]);
    // The resolved template's own rows stayed under their stages, not in here.
    expect(labels).not.toContain('Upload requested documents');
    expect(window.__t.offReqs()).toHaveLength(3);
  });

  test('an INTAKE-phase case makes NO second GET — its payload already has everything', async () => {
    const p = pipelinePayload({
      template: { id: 1, name: 'Intake', role: 'intake', case_type: '', case_subtype: '' },
    });
    const { calls, window } = await boot({ pipeline: p });
    expect(fullGets(calls)).toHaveLength(0);
    expect(window.document.querySelector('.pw-intake')).toBeNull();
  });

  test('the second GET failing costs the history section and NOTHING else', async () => {
    const { window, errors } = await boot({ fullFails: true });
    expect(errors).toEqual([]);
    expect(window.document.querySelector('.pw-intake')).toBeNull();
    // The stage sections and the rail are still there.
    expect($$(window, '.pw-steps-main .pw-stage')).toHaveLength(3);
    expect(window.document.querySelector('.pw-rail')).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (R2.5) projection — FEATURE-DETECTED
// ─────────────────────────────────────────────────────────────────────────────

describe('projection (R2.5)', () => {
  // R2.5 emits `projected` ONLY when the resolved template is role='intake' —
  // a lead being shown what happens after retention — and OMITS the key
  // entirely otherwise. So the fixture is an intake payload; a role='case'
  // payload carrying `projected` is a shape production cannot produce.
  //
  // PROJECTED STAGES CARRY NO stage_id, by design: they belong to a template
  // the case has not entered. That is exactly why they must never reach the
  // advance picker — an option with no id is an advance that cannot be made —
  // and the last test here is that pin.
  const INTAKE = () => pipelinePayload({
    template: { id: 1, name: 'Intake', role: 'intake', case_type: '', case_subtype: '' },
  });
  const PROJ = {
    source: 'subtype',
    template: { id: 2, name: 'Bankruptcy — Chapter 7' },
    stages: [
      { stage_key: 'docs', stage_number: 2, internal_label: 'Docs Requested',
        client_label: 'Gathering your documents', client_visible: 1, lane: 'main' },
      { stage_key: 'filed', stage_number: 3, internal_label: 'Filed',
        client_label: 'Your case is filed', client_visible: 1, lane: 'main' },
    ],
  };

  test('present → a greyed "Typical next steps" section naming the target template', async () => {
    const p = INTAKE();
    p.projected = PROJ;
    const { window } = await boot({ pipeline: p });
    const proj = window.document.querySelector('.pw-proj');
    expect(proj).not.toBeNull();
    expect(txt(proj.querySelector('.pw-sec-head')))
      .toBe('Typical next steps — Bankruptcy — Chapter 7');
    expect($$(window, '.pw-proj-item').map(txt)).toEqual(['Docs Requested', 'Filed']);
  });

  test('a `generic` projection renders WITHOUT a template name', async () => {
    const p = INTAKE();
    p.projected = { source: 'generic', template: null, stages: [PROJ.stages[0]] };
    const { window } = await boot({ pipeline: p });
    expect(txt(window.document.querySelector('.pw-sec-head'))).toBe('Typical next steps');
  });

  test('ABSENT — the key is MISSING, not null (every role=case payload)', async () => {
    expect('projected' in pipelinePayload()).toBe(false);
    const { window, errors } = await boot();
    expect(errors).toEqual([]);
    expect(window.document.querySelector('.pw-proj')).toBeNull();
    expect($$(window, '.pw-steps-main .pw-stage')).toHaveLength(3);
  });

  test('PROJECTED STAGES ARE NEVER ADVANCE TARGETS — they have no stage_id', async () => {
    const p = INTAKE();
    p.projected = PROJ;
    const { window } = await boot({ pipeline: p });
    // Both the default (upcoming) and the show-all list come from `stages` /
    // `upcoming` only. A projected stage in the picker would offer a move the
    // server cannot resolve.
    const opts = () => [...window.document.querySelectorAll('#pwStageSelect option')].map(txt);
    expect(opts()).not.toContain('Docs Requested');
    window.pwToggleShowAll(true);
    expect(opts()).toEqual(expect.not.arrayContaining(['Gathering your documents']));
    // ...and show-all still offers the REAL off-ramp, which does have an id.
    expect(opts()).toContain('Dismissed');
  });

  test('projected stages never become stage sections or requirement rows', async () => {
    const p = INTAKE();
    p.projected = PROJ;                       // shares stage_keys with real stages
    const { window } = await boot({ pipeline: p });
    // 'Docs Requested' appears once as a real section and once as a projection
    // item — never twice as a section.
    expect($$(window, '.pw-steps-main .pw-stage .pw-stage-name').map(txt)
      .filter(n => n === 'Docs Requested')).toHaveLength(1);
    expect($$(window, '.pw-proj .pw-req')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Override controls — the only write path
// ─────────────────────────────────────────────────────────────────────────────

describe('override controls', () => {
  test('each row offers n/a + done; `clear` ONLY when an override exists', async () => {
    const p = pipelinePayload({
      stages: [stage({ requirements: [
        req({ requirement_key: 'plain', internal_label: 'Derived', sort_order: 1 }),
        req({ requirement_key: 'ovr', internal_label: 'Overridden', sort_order: 2,
              status: 'na',
              override: { status: 'na', note: null, set_by: 6, at: '2026-08-27' } }),
      ] })],
      upcoming: [],
    });
    const { window } = await boot({ pipeline: p, full: [] });
    const rows = $$(window, '.pw-req');
    expect([...rows[0].querySelectorAll('.pw-ov button')].map(txt)).toEqual(['n/a', 'done']);
    expect([...rows[1].querySelectorAll('.pw-ov button')].map(txt))
      .toEqual(['n/a', 'done', 'clear']);
  });

  test('mark N/A POSTs the R2 endpoint with the note, then RE-RESOLVES the panel', async () => {
    const { window, calls } = await boot({ swalInput: 'debtor has no vehicles' });
    const before = pipelineGets(calls).length;

    await window.__t.override('upload_docs', 'na');
    await tick(window, 40);

    const post = calls.find(c => c.method === 'POST' && /\/override$/.test(c.url));
    expect(post.url).toBe(`/api/cases/${CASE_ID}/pipeline/requirements/upload_docs/override`);
    expect(post.params).toEqual({ status: 'na', note: 'debtor has no vehicles' });
    // An override changes a DERIVED status, so the panel must re-read — the
    // browser has no detector hits to recompute with.
    expect(pipelineGets(calls).length).toBe(before + 1);
  });

  test('mark done POSTs status done; an empty note is omitted, not sent blank', async () => {
    const { window, calls } = await boot({ swalInput: '   ' });
    await window.__t.override('upload_docs', 'done');
    await tick(window, 40);
    const post = calls.find(c => c.method === 'POST' && /\/override$/.test(c.url));
    expect(post.params).toEqual({ status: 'done' });
  });

  test('cancelling the prompt writes NOTHING and re-reads nothing', async () => {
    const { window, calls } = await boot();        // swalInput undefined = cancel
    const before = pipelineGets(calls).length;
    await window.__t.override('upload_docs', 'na');
    await tick(window, 40);
    expect(calls.some(c => /\/override$/.test(c.url))).toBe(false);
    expect(pipelineGets(calls).length).toBe(before);
  });

  test('clear DELETEs the same endpoint and re-resolves', async () => {
    const { window, calls } = await boot();
    const before = pipelineGets(calls).length;
    await window.__t.clear('upload_docs');
    await tick(window, 40);
    const del = calls.find(c => c.method === 'DELETE');
    expect(del.url).toBe(`/api/cases/${CASE_ID}/pipeline/requirements/upload_docs/override`);
    expect(pipelineGets(calls).length).toBe(before + 1);
  });

  test('requirement keys are URL-encoded on the way out', async () => {
    const { window, calls } = await boot();
    await window.__t.clear('weird key/with slash');
    await tick(window, 40);
    const del = calls.find(c => c.method === 'DELETE');
    expect(del.url).toContain('weird%20key%2Fwith%20slash');
  });

  test('a failing override toasts and leaves the panel standing', async () => {
    const { window, toasts, errors } = await boot({ swalInput: '' });
    // Make the write fail on the next call only.
    const orig = window.apiSend;
    window.apiSend = async (url, method, params) => {
      if (/\/override$/.test(url)) throw new Error('409 busy');
      return orig(url, method, params);
    };
    await window.__t.override('upload_docs', 'done');
    await tick(window, 40);
    expect(errors).toEqual([]);
    expect(toasts.some(t => t.icon === 'error')).toBe(true);
    expect($$(window, '.pw-steps-main .pw-stage')).toHaveLength(3);
  });
});
