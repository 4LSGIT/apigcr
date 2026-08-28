// tests/portalCaseUi.timeline.test.js
//
// R3.1 — the Case Progress timeline's forward tail in public/portal/case.html.
//
// BOOTS THE REAL PAGE in jsdom against the REAL public/portal/portal.js, with
// only the transport (global fetch) stubbed. Harness posture lifted from
// tests/caseUi.stepsPanel.test.js — "drive the real handlers, stub only the
// library boundary" — adapted to the portal's boundary, which is Portal.fetch
// over window.fetch rather than the staff shell's apiSend.
//
// ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
//
// Until R3.1 nothing in the suite booted public/portal/case.html at all. Every
// portal assertion lived one layer down, against the SERVICE payload — and a
// payload test cannot see a renderer that drops a key, misplaces a block, or
// styles it into something it is not. The R3 cycle shipped exactly that class
// of defect: a rendering decision that every structural test agreed with and
// that was still wrong on the page.
//
// The four decisions this file exists to hold, all of which look like styling
// until they are wrong:
//
//   · THE TAIL IS NOT A TIMELINE STEP. done/current/upcoming are positions the
//     case actually holds, drawn as dotted <li>s on a connected rail.
//     Projected stages belong to a template the case HAS NOT ENTERED. Give
//     them a dot and the page states, in the only vocabulary the rail has,
//     that the case is on its way through them. They render as plain greyed
//     text OUTSIDE the <ul>, and "outside" is a structural claim, not a
//     cosmetic one.
//   · NO DATES. There are none to show, and an empty `when` slot on a rail
//     that carries dates everywhere else reads as data we lost.
//   · THE KEY'S ABSENCE IS THE FEATURE TEST. A phase='case' payload carries no
//     `timeline.projected`, and the card must end exactly where it always has.
//     This is the regression that would ship silently: the tail is additive,
//     so nothing breaks — a case-phase client would just start being told
//     about stages that do not apply to them.
//   · ONE RULE SET, TWO SURFACES. The card's greyed tail (.ns-proj*, R2.5) and
//     the timeline's (.tl-proj*) render the SAME server labels, one directly
//     above the other, and share one CSS declaration block. A later edit to
//     one selector list that misses the other is invisible to every structural
//     assertion in this file and to every payload test — so the computed
//     styles are compared directly.
//
// Run:
//   npx jest tests/portalCaseUi.timeline.test.js

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT     = path.join(__dirname, '..');
const HTML     = fs.readFileSync(path.join(ROOT, 'public/portal/case.html'), 'utf8');
const PORTALJS = fs.readFileSync(path.join(ROOT, 'public/portal/portal.js'), 'utf8');

const DOMS = [];
afterEach(() => {
  DOMS.splice(0).forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } });
});

const CASE_ID = 'AbCdEf12';
const tick = (w, ms) => new Promise(r => w.setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — shapes copied from portalCaseService.getCaseView's @returns
// ─────────────────────────────────────────────────────────────────────────────

/** A LEAD: intake-phase, so the server ships timeline.projected. */
function leadCase(over = {}) {
  return Object.assign({
    case_id: CASE_ID,
    title: 'Chapter 7 Bankruptcy',
    docket: null,
    meeting341: null,
    cards: [],
    next_steps: {
      remaining: 1,
      steps: [{ done: false, active_now: true, kind: 'task', number: 1,
                label: 'Complete your questionnaire', subtitle: null, date: null }],
      projected: [{ label: 'Your case is filed' }, { label: 'Discharge entered' }],
    },
    timeline: {
      done: [],
      current: { label: 'Consultation scheduled', since: '2026-08-01' },
      upcoming: [{ label: 'Agreement sent for signature' }],
      projected: [{ label: 'Your case is filed' }, { label: 'Discharge entered' }],
    },
  }, over);
}

/** A RETAINED case: phase='case', so `projected` is ABSENT from the payload —
 *  not null, not []. Built without the key on purpose; the whole regression
 *  guard below turns on that. */
function casePhaseCase(over = {}) {
  return Object.assign({
    case_id: CASE_ID,
    title: 'Chapter 7 Bankruptcy',
    docket: '24-40226-mlo',
    meeting341: null,
    cards: [],
    next_steps: null,
    timeline: {
      done: [{ label: 'Preparing your case', date: '2026-05-04' }],
      current: { label: 'Your case is filed', since: '2026-06-10' },
      upcoming: [{ label: 'Meeting of creditors' }],
    },
  }, over);
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Boot the real page. `runScripts:'outside-only'` keeps the document's own
 * scripts from firing on construction (so the stubs land first) while leaving
 * the <style> block in the head — which the CSS section below needs, and which
 * a body.innerHTML harness would have thrown away.
 *
 * portal.js is evaluated FOR REAL: it is the page's library, and stubbing
 * Portal.fetch instead of window.fetch would mock out the one thing standing
 * between the page and its payload. The token is seeded because Portal.fetch
 * bounces to login without one.
 *
 * @param {object|null} caseObj  the `case` body (null → a 404 from the API)
 */
async function boot(caseObj) {
  const dom = new JSDOM(HTML, {
    url: `https://app.4lsg.com/portal/case.html?id=${CASE_ID}`,
    runScripts: 'outside-only',
  });
  DOMS.push(dom);
  const { window } = dom;

  window.localStorage.setItem('portal_token', 'test-token');

  const calls = [];
  window.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === '/api/portal/branding') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (!caseObj) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({ status: 'success', case: caseObj }),
    };
  };

  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const inline = [...noComments.matchAll(
    /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Fence: a second inline block means the page was restructured and this
  // harness is stale.
  expect(inline).toHaveLength(1);

  window.eval(PORTALJS);
  window.eval(inline[0]);

  await tick(window, 40);
  return { window, calls, errors };
}

const $$  = (w, sel) => [...w.document.querySelectorAll(sel)];
const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();

/** The Case Progress card — found by its heading, not by DOM position, so a
 *  reordered page fails on the assertion that moved and not on this helper. */
function progressCard(w) {
  const card = $$(w, '.card').find(c => {
    const h = c.querySelector('h2');
    return h && txt(h) === 'Case Progress';
  });
  expect(card).toBeDefined();
  return card;
}

/** The "Your next steps" card (R3) — the OTHER surface carrying a projection. */
function nextStepsCard(w) {
  return $$(w, '.card').find(c => {
    const h = c.querySelector('h2');
    return h && txt(h) === 'Your next steps';
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The tail renders
// ─────────────────────────────────────────────────────────────────────────────

describe('a LEAD gets the forward tail', () => {
  test('the divider and one greyed line per projected label, in payload order', async () => {
    const { window, errors } = await boot(leadCase());
    expect(errors).toEqual([]);

    const card = progressCard(window);
    expect(txt(card.querySelector('.tl-proj-head'))).toBe('Typical next steps');
    expect([...card.querySelectorAll('.tl-proj-item')].map(txt))
      .toEqual(['Your case is filed', 'Discharge entered']);
  });

  test('the tail closes the card — AFTER the rail, never interleaved with it', async () => {
    // Order is the claim: these come after everything the case actually holds.
    // A tail rendered above `upcoming` would read as the next thing due.
    const { window } = await boot(leadCase());
    const card = progressCard(window);

    const kids = [...card.children];
    const ulIdx   = kids.findIndex(el => el.matches('ul.tl'));
    const projIdx = kids.findIndex(el => el.matches('.tl-proj'));
    expect(ulIdx).toBeGreaterThan(-1);
    expect(projIdx).toBe(kids.length - 1);
    expect(projIdx).toBeGreaterThan(ulIdx);
  });

  test('the case\'s OWN position still renders normally alongside it', async () => {
    // The tail is additive. current/upcoming keep their dots, their labels and
    // their dates.
    const { window } = await boot(leadCase());
    const card = progressCard(window);

    expect(txt(card.querySelector('li.current .lbl'))).toBe('Consultation scheduled');
    expect(txt(card.querySelector('li.current .when'))).toBe('Since Aug 1, 2026');
    expect([...card.querySelectorAll('li.upcoming .lbl')].map(txt))
      .toEqual(['Agreement sent for signature']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// It is not a step
// ─────────────────────────────────────────────────────────────────────────────

describe('the tail is a POSSIBILITY, not a position', () => {
  test('no <li>, no dot, and not inside the rail', async () => {
    // The rail's vocabulary is "the case is here / has been here / will be
    // here". Borrowing it for a template the case has not entered would be a
    // statement the payload never made.
    //
    // ASSERTED ON THE CONTAINER, not on the item. An earlier draft of this
    // test checked `item.querySelector('.dot')` and `item.tagName` — and a
    // mutation that wrapped each item in `<li class="upcoming"><span
    // class="dot">…` passed it clean, because the dot was the item's SIBLING
    // and the item was still a DIV. The claim is about the whole tail block,
    // so that is what gets inspected.
    const { window } = await boot(leadCase());
    const card = progressCard(window);
    const tail = card.querySelector('.tl-proj');

    expect(tail.querySelectorAll('li')).toHaveLength(0);
    expect(tail.querySelectorAll('.dot')).toHaveLength(0);
    expect(tail.closest('ul.tl')).toBeNull();

    // The tail is exactly a head plus one plain DIV per label — nothing else.
    expect([...tail.children].map(el => el.tagName + '.' + el.className))
      .toEqual(['P.tl-proj-head', 'DIV.tl-proj-item', 'DIV.tl-proj-item']);

    // And the card as a whole carries ONLY the case's real positions as <li>:
    // current + upcoming. Counted across the entire card, not just inside the
    // <ul>, so a stray <li> anywhere fails here.
    expect(card.querySelectorAll('li')).toHaveLength(2);
    expect(card.querySelectorAll('ul.tl > li')).toHaveLength(2);
    expect(card.querySelectorAll('.dot')).toHaveLength(2);
  });

  test('no dates — the tail carries labels and nothing else', async () => {
    const { window } = await boot(leadCase());
    const tail = progressCard(window).querySelector('.tl-proj');
    expect(tail.querySelectorAll('.when')).toHaveLength(0);
    for (const it of tail.querySelectorAll('.tl-proj-item')) {
      expect(it.children).toHaveLength(0);        // bare text, no sub-structure
    }
  });

  test('labels are escaped at insertion, like every other payload string', async () => {
    const { window, errors } = await boot(leadCase({
      timeline: { done: [], current: null, upcoming: [],
                  projected: [{ label: '<img src=x onerror=alert(1)>' }] },
      next_steps: null,
    }));
    expect(errors).toEqual([]);

    const card = progressCard(window);
    expect(card.querySelector('img')).toBeNull();
    expect(txt(card.querySelector('.tl-proj-item'))).toBe('<img src=x onerror=alert(1)>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Absence — the regression guard
// ─────────────────────────────────────────────────────────────────────────────

describe('no projection → the card ends where it always has', () => {
  test('phase=case payload (key ABSENT) renders zero tail markup', async () => {
    // THE regression. The tail is additive, so a leak breaks nothing — it just
    // starts telling a retained client about stages that do not apply to them.
    const { window, errors } = await boot(casePhaseCase());
    expect(errors).toEqual([]);

    const card = progressCard(window);
    expect(card.querySelectorAll('.tl-proj')).toHaveLength(0);
    expect(card.querySelectorAll('.tl-proj-head')).toHaveLength(0);
    // Scoped to the RENDERED output on purpose: the page's own <script> is
    // still in the document under this harness, and its source carries the
    // literal string. #content is what a client sees.
    expect(window.document.getElementById('content').innerHTML)
      .not.toContain('Typical next steps');

    // The rail is untouched: done → current → upcoming, with their dates.
    expect([...card.querySelectorAll('ul.tl > li')].map(li => li.className))
      .toEqual(['done', 'current', 'upcoming']);
    expect(txt(card.querySelector('li.done .when'))).toBe('May 4, 2026');
  });

  test('an EMPTY projected array renders nothing either — no bare divider', async () => {
    // The server emits `[]` for a lead whose projection is entirely hidden.
    // A divider with no lines under it is worse than no divider.
    const { window } = await boot(leadCase({
      timeline: { done: [], current: { label: 'Consultation scheduled', since: '2026-08-01' },
                  upcoming: [], projected: [] },
      next_steps: null,
    }));
    const card = progressCard(window);
    expect(card.querySelectorAll('.tl-proj')).toHaveLength(0);
  });

  test('a pre-R3.1 payload (no timeline.projected at all) renders identically', async () => {
    // Old server, new page. Byte-for-byte against the same payload with the
    // key deliberately deleted — the page must not care.
    const withKey = casePhaseCase();
    withKey.timeline.projected = undefined;
    delete withKey.timeline.projected;

    const a = await boot(casePhaseCase());
    const b = await boot(withKey);
    expect(progressCard(b.window).innerHTML).toBe(progressCard(a.window).innerHTML);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Both surfaces
// ─────────────────────────────────────────────────────────────────────────────

describe('the card and the timeline both carry it', () => {
  test('same labels in both blocks — one server reader, two renders', async () => {
    // BY DESIGN, not a duplication bug: the card answers "what do I have to
    // do", the timeline answers "where is my case", and a lead's honest answer
    // to the second runs past the end of the intake template too.
    const { window } = await boot(leadCase());

    const inTimeline = [...progressCard(window).querySelectorAll('.tl-proj-item')].map(txt);
    const inCard     = [...nextStepsCard(window).querySelectorAll('.ns-proj-item')].map(txt);
    expect(inTimeline).toEqual(inCard);
    expect(inTimeline).toEqual(['Your case is filed', 'Discharge entered']);
  });

  test('neither block eats the other\'s content', async () => {
    const { window } = await boot(leadCase());

    // The card keeps its step; the timeline keeps its position.
    expect(txt(nextStepsCard(window).querySelector('.ns-label')))
      .toContain('Complete your questionnaire');
    expect(txt(progressCard(window).querySelector('li.current .lbl')))
      .toBe('Consultation scheduled');
    // And exactly one of each projection block exists — not two of either.
    expect($$(window, '.ns-proj')).toHaveLength(1);
    expect($$(window, '.tl-proj')).toHaveLength(1);
  });

  test('the next-steps card can carry a projection while the timeline has none', async () => {
    // Defensive, not a shape production emits today: the two keys are set
    // independently, and the page must render whichever it is handed rather
    // than assuming they travel together.
    const { window, errors } = await boot(leadCase({
      timeline: { done: [], current: { label: 'Consultation scheduled', since: '2026-08-01' },
                  upcoming: [] },
    }));
    expect(errors).toEqual([]);
    expect($$(window, '.ns-proj')).toHaveLength(1);
    expect($$(window, '.tl-proj')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shared CSS — the assertion no structural test can make
// ─────────────────────────────────────────────────────────────────────────────

describe('one declaration block, two surfaces', () => {
  // .ns-proj* and .tl-proj* share their rules by selector list. That sharing is
  // the whole reason the two greyed blocks on this page cannot drift apart —
  // and it is exactly the kind of thing a later edit undoes by touching one
  // selector and not the other. Nothing about the DOM would change; the page
  // would just quietly render the same labels two different ways.
  //
  // jsdom resolves the cascade but NOT var() — `color` comes back as the
  // literal `var(--muted)`. That is a feature here: identical literals prove
  // both selectors resolve to the SAME declaration, which is the claim.
  const PROPS = ['color', 'fontSize', 'padding', 'margin', 'borderTop',
                 'textTransform', 'letterSpacing'];

  function same(w, selA, selB) {
    const a = w.document.querySelector(selA);
    const b = w.document.querySelector(selB);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const ca = w.getComputedStyle(a);
    const cb = w.getComputedStyle(b);
    for (const p of PROPS) expect([selA, p, ca[p]]).toEqual([selA, p, cb[p]]);
  }

  test('the item styling is identical in both blocks', async () => {
    const { window } = await boot(leadCase());
    same(window, '.tl-proj-item', '.ns-proj-item');
  });

  test('the divider styling is identical in both blocks', async () => {
    const { window } = await boot(leadCase());
    same(window, '.tl-proj', '.ns-proj');
    same(window, '.tl-proj-head', '.ns-proj-head');
  });

  test('projected items are MUTED, and visibly not rail labels', async () => {
    // The rail's .lbl is full-size body text in --text; a projected line is
    // smaller and muted. If these ever computed the same, the page would be
    // presenting possibilities in the same voice as the case's real position.
    const { window } = await boot(leadCase());
    const proj = window.getComputedStyle(window.document.querySelector('.tl-proj-item'));
    const lbl  = window.getComputedStyle(window.document.querySelector('.tl .lbl'));

    expect(proj.color).toBe('var(--muted)');
    expect(proj.fontSize).not.toBe(lbl.fontSize);
  });
});
