/**
 * D2-H — card navigation coupled to the conditional engine.
 *
 * Two defects reproduced live on `dbkq_test` before this slice:
 *
 *   (a) A DRAFT RESTORE re-evaluated conditionals (yc-forms `_evaluateConditionals`
 *       from the restore handler) but the card layer never recomputed: sections
 *       flipped visible while the visible-set, counter, Next label and dots stayed
 *       at their pre-restore values. A restore that revealed a later card showed
 *       "1 of 1" with no Next button.
 *
 *   (b) TYPING did the same until blur. The engine listens on `change` AND
 *       `input`; the card layer's refresh rode the single `change` listener that
 *       also drives auto-advance. So a `notEmpty`-gated later card became
 *       display-eligible on the first keystroke while the nav still read
 *       "Review and Submit" — clicking it skipped the freshly revealed question
 *       with no signal. On the real DBKQ this hit every text-driven gate.
 *
 * The fix is ONE coupling point: `_evaluateConditionals()` ends by dispatching a
 * bubbling `yc:conditionals` CustomEvent on the form root, and the card layer's
 * nav refresh listens for THAT instead of `change`. Auto-advance stays on
 * `change` only — `change` means "done"; per-keystroke advance is wrong.
 *
 * jsdom INTEGRATION against the REAL files (render.html with
 * runScripts:'dangerously', the real /js/yc-forms.js via ResourceLoader),
 * external mode with a stubbed fetch — the D1 harness shape, because the draft
 * banner + Restore button is the surface defect (a) lives on.
 *
 *   npx jest tests/formRender.d2hCardNav.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

// ── Fixture: the dbkq_test walkthrough shape, minimized to the three cards that
//    reproduce both defects.
//      card 0  s1  radio YES/NO                 (always visible, single-question)
//      card 1  s2  text, showWhen s1 eq YES
//      card 2  s3  text, showWhenAny [s1 eq NO, s2 notEmpty]
//    Empty state → only card 0 is visible ("1 of 1", Review and Submit).
const CARD_DEF = {
  layout: 'card',
  toggle: false,
  autosave: false,
  sections: [
    {
      title: 'S1',
      rows: [{ fields: [{ name: 's1', type: 'radio', label: 'Q1',
        options: [{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }] }] }],
    },
    {
      title: 'S2',
      showWhen: { field: 's1', op: 'eq', value: 'YES' },
      rows: [{ fields: [{ name: 's2', type: 'text', label: 'Q2' }] }],
    },
    {
      title: 'S3',
      showWhenAny: [{ field: 's1', op: 'eq', value: 'NO' },
                    { field: 's2', op: 'notEmpty' }],
      rows: [{ fields: [{ name: 's3', type: 'text', label: 'Q3' }] }],
    },
  ],
};

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    return Promise.resolve(Buffer.from(''));
  }
}

const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) {} }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** External-mode page. `draft` in the GET payload raises the recovery banner. */
function makePage(opts = {}) {
  const fetches = [];
  const url = 'https://app.test/forms/render.html?form_key=dbkq_test&case_id=abc12345&ext=1';

  const fetchStub = async (u, init) => {
    const method = (init && init.method) || 'GET';
    fetches.push({ url: u, method });
    if (u.indexOf('/draft') !== -1) {
      return { ok: true, status: 200,
               json: async () => ({ status: 'success', updated_at: '2026-09-04T12:00:00.000Z' }) };
    }
    if (u.endsWith('/submit')) {
      return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
    }
    if (u.startsWith('/api/ext/forms/')) {
      const body = {
        status: 'success', title: 'DBKQ', link_type: 'case', schema_version: 3,
        definition: opts.definition || CARD_DEF, load: {}, linked: true,
      };
      if (opts.draft !== undefined) body.draft = opts.draft;
      return { ok: true, status: 200, json: async () => body };
    }
    throw new Error('unstubbed fetch: ' + method + ' ' + u);
  };

  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) {
        window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      }
      window.fetch = fetchStub;
    },
  });
  DOMS.push(dom);
  return { dom, fetches, window: dom.window };
}

async function ready(page) {
  const w = page.window;
  for (let i = 0; i < 300; i++) {
    const fatal = w.document.querySelector('.ycr-fatal');
    if (fatal) throw new Error('render fatal: ' + fatal.textContent);
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') break;
    await sleep(10);
  }
  if (!w.ycForm) throw new Error('form never finished init');
  await sleep(60);            // let afterInit()'s setupCards() first paint land
  return w;
}

const qa       = (w, sel) => [...w.document.querySelectorAll(sel)];
const q        = (w, sel) => w.document.querySelector(sel);
const cardsOf  = (w) => qa(w, '.yc-card');
const activeIx = (w) => cardsOf(w).findIndex((c) => c.classList.contains('active'));
const countTx  = (w) => q(w, '.yc-card-count').textContent;
const nextTx   = (w) => q(w, '.yc-card-next').textContent;
const dotCount = (w) => qa(w, '.yc-card-dot').length;
const heads    = (w) => qa(w, '.yc-card-review-head').map((h) => h.textContent);

function pickRadio(w, name, val) {
  const r = q(w, `input[name="${name}"][value="${val}"]`);
  r.checked = true;
  r.dispatchEvent(new w.Event('change', { bubbles: true }));
}
/** Keystroke ONLY — no blur, so no `change`. This is defect (b)'s gesture. */
function typeInput(w, name, val) {
  const el = q(w, `[name="${name}"]`);
  el.value = val;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
}

// ════════════════════════════════════════════════════════════════════════════
// 1a. REPRO — draft restore must refresh the nav with NO user event at all
// ════════════════════════════════════════════════════════════════════════════

describe('D2-H (a) draft restore refreshes card navigation', () => {
  test('restoring a draft that reveals a later card updates count, Next and dots', async () => {
    const page = makePage({
      draft: { data: { s1: 'YES' }, updated_at: '2026-09-04T12:00:00.000Z', schema_version: 3 },
    });
    const w = await ready(page);

    // Pre-restore: s1 empty → only card 0 is condition-visible.
    expect(countTx(w)).toBe('1 of 1');
    expect(nextTx(w)).toBe('Review and Submit');
    expect(dotCount(w)).toBe(1);

    const banner = w.document.getElementById('draftBanner');
    expect(banner.style.display).not.toBe('none');
    w.document.getElementById('draftRestore').click();
    await sleep(40);

    // populate() writes values machine-side and dispatches NOTHING — the only
    // signal the card layer can possibly get is the engine's own announcement.
    expect(q(w, 'input[name="s1"][value="YES"]').checked).toBe(true);
    expect(cardsOf(w)[1].firstElementChild.style.display).not.toBe('none');   // engine ran

    expect(countTx(w)).toBe('1 of 2');
    expect(nextTx(w)).toContain('Next');
    expect(dotCount(w)).toBe(2);
    expect(activeIx(w)).toBe(0);                 // a refresh must not navigate
    expect(banner.style.display).toBe('none');   // restore handler completed
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 1b. REPRO — `input` (no blur, no `change`) must refresh the nav
// ════════════════════════════════════════════════════════════════════════════

describe('D2-H (b) typing refreshes card navigation before blur', () => {
  test('a keystroke into a notEmpty-watched field flips Review→Next immediately', async () => {
    const w = await ready(makePage());

    pickRadio(w, 's1', 'YES');
    await sleep(450);                            // single-radio card auto-advances
    expect(activeIx(w)).toBe(1);
    expect(countTx(w)).toBe('2 of 2');
    expect(nextTx(w)).toBe('Review and Submit');

    typeInput(w, 's2', 'a');                     // NO change event fired
    expect(countTx(w)).toBe('2 of 3');
    expect(nextTx(w)).toContain('Next');
    expect(dotCount(w)).toBe(3);
    expect(activeIx(w)).toBe(1);                 // still on the same card

    // …and clearing it back out re-hides the card in the same breath.
    typeInput(w, 's2', '');
    expect(countTx(w)).toBe('2 of 2');
    expect(nextTx(w)).toBe('Review and Submit');
    expect(dotCount(w)).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Auto-advance is UNMOVED: `change` only, never `input`
// ════════════════════════════════════════════════════════════════════════════

describe('D2-H auto-advance unchanged', () => {
  test('radio change advances; text input never does', async () => {
    const w = await ready(makePage());

    pickRadio(w, 's1', 'YES');
    expect(activeIx(w)).toBe(0);                 // not synchronous
    await sleep(450);
    expect(activeIx(w)).toBe(1);                 // change → advanced

    // Card 1 is a single-question TEXT card. Keystrokes refresh the nav (above)
    // but must never move the form out from under the typist.
    typeInput(w, 's2', 'still typing');
    await sleep(450);
    expect(activeIx(w)).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Current card hidden by a restore → relocate, nearest FOLLOWING first
// ════════════════════════════════════════════════════════════════════════════

describe('D2-H current-card relocation', () => {
  test('a restore that hides the active card moves to the next visible one', async () => {
    const page = makePage({
      draft: { data: { s1: 'NO' }, updated_at: '2026-09-04T12:00:00.000Z', schema_version: 3 },
    });
    const w = await ready(page);

    pickRadio(w, 's1', 'YES');
    await sleep(450);
    expect(activeIx(w)).toBe(1);                 // sitting on the s2 card

    w.document.getElementById('draftRestore').click();
    await sleep(40);

    // s1='NO' hides card 1 (eq YES) and reveals card 2 (showWhenAny s1 eq NO).
    expect(activeIx(w)).toBe(2);
    expect(countTx(w)).toBe('2 of 2');
    expect(nextTx(w)).toBe('Review and Submit');
    expect(dotCount(w)).toBe(2);
  });

  test('falls back to the nearest PRECEDING visible card when nothing follows', async () => {
    const w = await ready(makePage());

    pickRadio(w, 's1', 'YES');
    await sleep(450);
    expect(activeIx(w)).toBe(1);

    // Clear s1 straight from the DOM (a populate-shaped write) and re-evaluate:
    // card 1 and card 2 both vanish, leaving only card 0 behind the cursor.
    qa(w, 'input[name="s1"]').forEach((r) => { r.checked = false; });
    w.ycForm._evaluateConditionals();

    expect(activeIx(w)).toBe(0);
    expect(countTx(w)).toBe('1 of 1');
    expect(nextTx(w)).toBe('Review and Submit');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Review page open during a conditional flip → rebuilt, not stale
// ════════════════════════════════════════════════════════════════════════════

describe('D2-H review page rebuild', () => {
  test('a conditional flip while review is showing rebuilds the summary', async () => {
    const w = await ready(makePage());

    pickRadio(w, 's1', 'NO');
    await sleep(450);
    expect(activeIx(w)).toBe(2);                 // s3 card, the last visible one
    expect(nextTx(w)).toBe('Review and Submit');

    q(w, '.yc-card-next').click();
    await sleep(20);
    expect(q(w, '.yc-card-review').style.display).not.toBe('none');
    expect(heads(w)).toEqual(['S1', 'S3']);

    // Flip the gate underneath the open review page.
    const yes = q(w, 'input[name="s1"][value="YES"]');
    yes.checked = true;
    yes.dispatchEvent(new w.Event('input', { bubbles: true }));
    await sleep(20);

    expect(q(w, '.yc-card-review').style.display).not.toBe('none');   // still on review
    expect(heads(w)).toEqual(['S1', 'S2']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. The coupling point itself
// ════════════════════════════════════════════════════════════════════════════

describe('D2-H yc:conditionals event', () => {
  test('every _evaluateConditionals() run announces on the form root and bubbles', async () => {
    const w = await ready(makePage());
    const f = w.ycForm;

    let onRoot = 0, onDoc = 0;
    f.el.addEventListener('yc:conditionals', () => { onRoot += 1; });
    w.document.addEventListener('yc:conditionals', () => { onDoc += 1; });

    f._evaluateConditionals();
    expect(onRoot).toBe(1);
    expect(onDoc).toBe(1);                       // bubbles

    typeInput(w, 's2', 'x');                     // engine's `input` listener
    expect(onRoot).toBe(2);

    pickRadio(w, 's1', 'YES');                   // engine's `change` listener
    expect(onRoot).toBe(3);
    await sleep(450);                            // drain the auto-advance timer
  });

  test('a form with NO conditional nodes still announces from init step 13b', async () => {
    const plain = {
      layout: 'card', toggle: false, autosave: false,
      sections: [
        { title: 'A', rows: [{ fields: [{ name: 'a', type: 'text', label: 'A' }] }] },
        { title: 'B', rows: [{ fields: [{ name: 'b', type: 'text', label: 'B' }] }] },
      ],
    };
    const w = await ready(makePage({ definition: plain }));
    // First paint is computed from live state by setupCards itself, so an
    // announcement that landed BEFORE registration is harmless (§3).
    expect(countTx(w)).toBe('1 of 2');
    expect(dotCount(w)).toBe(2);

    let n = 0;
    w.ycForm.el.addEventListener('yc:conditionals', () => { n += 1; });
    w.ycForm._evaluateConditionals();
    expect(n).toBe(1);
    expect(countTx(w)).toBe('1 of 2');            // refresh is a no-op here
  });
});
