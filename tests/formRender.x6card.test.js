/**
 * X6 — layout:"card" (amendments §R): one section per card, Back/Next, dot
 * progress, per-card validation, auto-advance on single-choice cards, review
 * page before submit. PRESENTATION ONLY.
 *
 * Same harness style as formRender.slice26.test.js / formRender.content.test.js:
 * jsdom INTEGRATION tests against the REAL files (render.html with
 * runScripts:'dangerously', the real /js/yc-forms.js via ResourceLoader,
 * apiSend stubbed per test). ZERO yc-forms.js changes in this slice — per-card
 * validation runs the real validate() under a temporarily narrowed
 * config.validation (synchronous, so the swap window cannot interleave).
 *
 * Covers:
 *   G  byte-identity gate (the charter's gate): a definition WITHOUT layout
 *      emits ZERO card artifacts — no .yc-card*, nav, dots or review nodes,
 *      and #saveBtn is untouched
 *   K  markup contract: cards wrap sections, nav bar, dots (count = visible
 *      cards), counter, review hidden, saveBtn hidden, single-question class
 *   N  navigation: Next blocks on the CURRENT card only (later-card required
 *      fields do not block and are not painted), Back free, visited dots
 *      clickable, unvisited dots inert, dot states (done/error/current)
 *   A  auto-advance: single radio card advances ~300ms after selection;
 *      multi-field cards never auto-advance
 *   C  conditional cards: a showWhen-false section is skipped by the
 *      sequence and absent from the dots; toggling the condition restores it
 *   R  review page: entered from the last card via full unscoped validation
 *      (an error on ANY card blocks entry with that card revealed), option
 *      LABELS not values, checkbox Yes/No, blank = em-dash, Edit navigates,
 *      Back to form returns, Submit = #saveBtn revealed
 *   S  submit + parity: Submit posts the same collect() a sections-mode
 *      render of the same definition produces (deep-equal)
 *   P  preview: free navigation (Next never blocks, no errors painted),
 *      Submit stays disabled
 *   W  view mode: ?view_submission renders FLAT — layout ignored
 *   V  validator/projection: layout 'card' accepted; bad value rejected;
 *      card+tabs rejected; card+sticky unrepresentable (existing rule);
 *      fieldSignature unchanged by layout; projectDefinition preserves it
 *
 *   npx jest tests/formRender.x6card.test.js
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT        = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');
const svc         = require(path.join(ROOT, 'services/formTemplateService.js'));
const ext         = require(path.join(ROOT, 'services/extFormService.js'));

class TestLoader extends ResourceLoader {
  fetch(url) {
    const p = new URL(url).pathname;
    if (p === '/js/yc-forms.js') return Promise.resolve(Buffer.from(YC_FORMS_JS));
    if (p.startsWith('/forms/hooks/')) return Promise.reject(new Error('404 ' + p));
    return Promise.resolve(Buffer.from(''));
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) {} }));

// 4 sections → cards: 0 "About you" (2 fields, name required), 1 single-radio
// (auto-advance card), 2 conditional on pick='b', 3 "Contact" (required email
// + checkbox).
function cardDef(extra) {
  return Object.assign({
    layout: 'card',
    dataMode: 'live', autosave: false, toggle: false,
    sections: [
      { title: 'About you', rows: [
        { fields: [{ name: 'full_name', type: 'text', label: 'Name', required: true }] },
        { fields: [{ name: 'nick', type: 'text', label: 'Nickname' }] },
      ] },
      { rows: [{ fields: [{ name: 'pick', type: 'radio', label: 'Pick one', required: true,
                  options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] }] }] },
      { title: 'Beta extras', showWhen: { field: 'pick', op: 'eq', value: 'b' },
        rows: [{ fields: [{ name: 'beta_note', type: 'text', label: 'Beta note' }] }] },
      { title: 'Contact', rows: [{ fields: [
          { name: 'email', type: 'text', label: 'Email', required: true, email: true },
          { name: 'ok', type: 'checkbox', label: 'I agree' },
      ] }] },
    ],
  }, extra || {});
}

const CASE_ROW = {
  case_id: 'CASEX6', case_number: '25-60001', case_number_full: '25-60001-mlo',
};

function bootPage(opts = {}) {
  const def   = opts.definition;
  const calls = [];
  let url = 'https://app.test/forms/render.html?form_key=x6_test&case_id=CASEX6';
  if (opts.preview) url = 'https://app.test/forms/render.html?template_id=9&preview=1';
  if (opts.view)    url = 'https://app.test/forms/render.html?view_submission=5';
  const apiSend = async (u, method, body) => {
    calls.push({ url: u, method, body });
    if (u.startsWith('/api/form-templates/render/')) {
      return { status: 'success', title: 'X6 Test', link_type: 'case', schema_version: 1, definition: def };
    }
    if (u === '/api/form-templates/9') {
      return { status: 'success', template: { id: 9, form_key: 'x6_test', title: 'X6 Preview',
               link_type: 'case', schema_version: 1, draft_definition: def } };
    }
    if (u.startsWith('/api/forms/submissions/5/render')) {
      return { status: 'success', definition: def, title: 'X6 View', link_type: 'case',
               definition_schema_version: 1, schema_matched: true,
               submission: { id: 5, form_key: 'x6_test', schema_version: 1,
                             data: { full_name: 'Zed', pick: 'a', email: 'z@x.test' },
                             created_at: '2026-08-14 10:00:00', link_type: '', link_id: '' } };
    }
    if (u.startsWith('/api/cases/') && method === 'GET') return { case: CASE_ROW, clients: [], appts: [] };
    if (u.startsWith('/api/cases/') && method === 'PATCH') return { status: 'success' };
    if (u.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
    if (u === '/api/forms/submit') return { id: 77, version: 1, updated_at: new Date().toISOString() };
    if (u.startsWith('/api/forms/draft')) return {};
    throw new Error('unstubbed apiSend: ' + method + ' ' + u);
  };
  const dom = new JSDOM(RENDER_HTML, {
    url,
    runScripts: 'dangerously',
    resources: new TestLoader(),
    pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      window.apiSend = apiSend;
      window.firmData = {};
    },
  });
  DOMS.push(dom);
  return { dom, win: dom.window, doc: dom.window.document, calls };
}

async function ready(p) {
  for (let i = 0; i < 400; i++) {
    const fatal = p.doc.querySelector('.ycr-fatal');
    if (fatal) throw new Error('fatal: ' + fatal.textContent);
    const ov = p.doc.querySelector('.yc-loading-overlay');
    if (p.win.ycForm && ov && ov.style.display === 'none') break;
    await sleep(10);
  }
  if (!p.win.ycForm) throw new Error('never initialized');
  await sleep(60);
  return p;
}
const q  = (p, sel) => p.doc.querySelector(sel);
const qa = (p, sel) => [...p.doc.querySelectorAll(sel)];
const fire = (p, el, type) => el.dispatchEvent(new p.win.Event(type, { bubbles: true }));

const activeCard = (p) => q(p, '.yc-card.active');
const nextBtn = (p) => q(p, '.yc-card-next');
const prevBtn = (p) => q(p, '.yc-card-prev');
const countTx = (p) => q(p, '.yc-card-count').textContent;
const dots    = (p) => qa(p, '.yc-card-dot');

function setText(p, name, val) {
  const i = q(p, `input[name="${name}"]`);
  i.value = val;
  fire(p, i, 'input'); fire(p, i, 'change');
}
function pickRadio(p, name, val) {
  const r = q(p, `input[name="${name}"][value="${val}"]`);
  r.checked = true;
  fire(p, r, 'change');
}

// ═══════════════════════════════════════════════════════════════════════════
// G — byte-identity gate
// ═══════════════════════════════════════════════════════════════════════════

describe('G byte-identity gate', () => {
  test('no layout → ZERO card artifacts, saveBtn untouched', async () => {
    const def = cardDef(); delete def.layout;
    const p = await ready(bootPage({ definition: def }));
    expect(q(p, '.yc-card')).toBeNull();
    expect(q(p, '.yc-card-nav')).toBeNull();
    expect(q(p, '.yc-card-dots')).toBeNull();
    expect(q(p, '.yc-card-review')).toBeNull();
    expect(q(p, '.yc-card-single')).toBeNull();
    const sb = q(p, '#saveBtn');
    expect(sb.style.display).not.toBe('none');
    // every section renders flat, directly reachable
    expect(qa(p, '.yc-section').length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// K — markup contract
// ═══════════════════════════════════════════════════════════════════════════

describe('K card markup', () => {
  test('cards, nav, dots, counter, hidden review + saveBtn, single-question class', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    const cards = qa(p, '.yc-card');
    expect(cards.length).toBe(4);
    cards.forEach(c => expect(c.querySelector('.yc-section')).toBeTruthy());
    // single-question card: no title + exactly one registered field
    expect(cards[1].classList.contains('yc-card-single')).toBe(true);
    expect(cards[0].classList.contains('yc-card-single')).toBe(false);

    expect(q(p, '.yc-card-nav')).toBeTruthy();
    expect(prevBtn(p)).toBeTruthy();
    expect(nextBtn(p).textContent).toContain('Next');
    expect(q(p, '.yc-card-review').style.display).toBe('none');
    expect(q(p, '#saveBtn').style.display).toBe('none');

    // card 2 is condition-hidden (pick != 'b') → 3 visible cards
    expect(activeCard(p)).toBe(cards[0]);
    expect(countTx(p)).toBe('1 of 3');
    expect(dots(p).length).toBe(3);
    expect(dots(p)[0].classList.contains('current')).toBe(true);
    // first card: Previous hidden
    expect(prevBtn(p).style.visibility).toBe('hidden');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// N — navigation + per-card validation
// ═══════════════════════════════════════════════════════════════════════════

describe('N navigation', () => {
  test('Next blocks on current card only; Back free; dot states + clickability', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    const cards = qa(p, '.yc-card');

    // Next with empty required name → blocked, error on THIS card, none later
    nextBtn(p).click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[0]);
    const nameErr = cards[0].querySelector('.yc-error.visible');
    expect(nameErr).toBeTruthy();
    expect(nameErr.textContent).toContain('required');
    expect(cards[3].querySelector('.yc-error.visible')).toBeNull();   // email NOT painted

    // fill → advance
    setText(p, 'full_name', 'Fred T');
    nextBtn(p).click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[1]);
    expect(countTx(p)).toBe('2 of 3');
    expect(dots(p)[0].classList.contains('done')).toBe(true);
    expect(dots(p)[1].classList.contains('current')).toBe(true);

    // Back is free (radio required but unanswered)
    prevBtn(p).click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[0]);
    // leaving card 1 recorded its failure silently → its dot is red
    expect(dots(p)[1].classList.contains('error')).toBe(true);

    // visited dot (card 1) clickable; unvisited dot (card 3) inert
    const ds = dots(p);
    expect(ds[1].classList.contains('clickable')).toBe(true);
    expect(ds[2].classList.contains('clickable')).toBe(false);
    ds[2].click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[0]);       // nothing happened
    ds[1].click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[1]);
    // re-entering the known-bad card repaints its message
    expect(cards[1].querySelector('.yc-error.visible')).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A — auto-advance
// ═══════════════════════════════════════════════════════════════════════════

describe('A auto-advance', () => {
  test('single-radio card advances after selection; multi-field card never does', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    const cards = qa(p, '.yc-card');

    // multi-field card: change does NOT advance
    setText(p, 'full_name', 'Fred T');
    await sleep(450);
    expect(activeCard(p)).toBe(cards[0]);

    nextBtn(p).click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[1]);

    // single-radio card: selection advances after ~300ms (card 2 hidden for
    // pick='a' → lands on card 3)
    pickRadio(p, 'pick', 'a');
    expect(activeCard(p)).toBe(cards[1]);       // not synchronous
    await sleep(450);
    expect(activeCard(p)).toBe(cards[3]);
    expect(countTx(p)).toBe('3 of 3');
    expect(nextBtn(p).textContent).toBe('Review and Submit');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — conditional cards
// ═══════════════════════════════════════════════════════════════════════════

describe('C conditional cards', () => {
  test('showWhen-false card skipped + absent from dots; condition flip restores it', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    const cards = qa(p, '.yc-card');
    setText(p, 'full_name', 'Fred T');
    nextBtn(p).click(); await sleep(20);
    expect(dots(p).length).toBe(3);

    pickRadio(p, 'pick', 'b');                  // reveals card 2
    await sleep(450);                           // auto-advance
    expect(activeCard(p)).toBe(cards[2]);
    expect(countTx(p)).toBe('3 of 4');
    expect(dots(p).length).toBe(4);

    nextBtn(p).click(); await sleep(20);        // beta_note optional
    expect(activeCard(p)).toBe(cards[3]);
    expect(countTx(p)).toBe('4 of 4');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R — review page
// ═══════════════════════════════════════════════════════════════════════════

async function fillToLast(p) {
  const cards = qa(p, '.yc-card');
  setText(p, 'full_name', 'Fred T');
  nextBtn(p).click(); await sleep(20);
  pickRadio(p, 'pick', 'b'); await sleep(450);  // auto-advance to card 2
  nextBtn(p).click(); await sleep(20);          // card 3
  setText(p, 'email', 'fred@x.test');
  return cards;
}

describe('R review page', () => {
  test('full-validation gate: error on an EARLIER card blocks review, card revealed', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    const cards = await fillToLast(p);
    // break card 0 from a distance: jump back (visited), clear name, jump forward
    dots(p)[0].click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[0]);
    setText(p, 'full_name', '');
    dots(p)[3].click(); await sleep(20);        // card 3 visited → allowed
    expect(activeCard(p)).toBe(cards[3]);

    nextBtn(p).click(); await sleep(20);        // "Review and Submit"
    expect(q(p, '.yc-card-review').style.display).toBe('none');   // blocked
    expect(activeCard(p)).toBe(cards[0]);       // offending card revealed
    expect(cards[0].querySelector('.yc-error.visible')).toBeTruthy();
    // while ON the revealed card its dot is the current ring; leaving it
    // records the failure and turns it red
    expect(dots(p)[0].classList.contains('current')).toBe(true);
    dots(p)[3].click(); await sleep(20);
    expect(dots(p)[0].classList.contains('error')).toBe(true);
  });

  test('labels not values, Yes/No, em-dash blanks, Edit, Back to form, Submit reveal', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    const cards = await fillToLast(p);
    nextBtn(p).click(); await sleep(20);

    const rev = q(p, '.yc-card-review');
    expect(rev.style.display).toBe('');
    expect(activeCard(p)).toBeNull();                        // cards hidden
    expect(q(p, '#saveBtn').style.display).toBe('');         // Submit revealed
    expect(nextBtn(p).style.display).toBe('none');
    expect(prevBtn(p).textContent).toContain('Back to form');
    expect(q(p, '.yc-card-dots').style.display).toBe('none');

    const txt = rev.textContent;
    expect(txt).toContain('Fred T');
    expect(txt).toContain('Beta');                           // option LABEL
    expect(txt).not.toContain('Pick one: b');                // never the raw value line
    expect(txt).toContain('\u2014');                         // blank nick → em-dash
    expect(txt).toContain('No');                             // unchecked checkbox

    // Edit on the first block navigates to that card
    rev.querySelector('.yc-card-review-edit').click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[0]);
    expect(q(p, '#saveBtn').style.display).toBe('none');

    // back to review via the last card
    dots(p)[3].click(); await sleep(20);
    nextBtn(p).click(); await sleep(20);
    expect(q(p, '.yc-card-review').style.display).toBe('');

    // Back to form returns to the last card, hides Submit again
    prevBtn(p).click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[3]);
    expect(q(p, '#saveBtn').style.display).toBe('none');
    expect(nextBtn(p).style.display).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// S — submit + collect parity
// ═══════════════════════════════════════════════════════════════════════════

describe('S submit + parity', () => {
  test('Submit posts; collect() identical to a sections-mode render of the same definition', async () => {
    const p = await ready(bootPage({ definition: cardDef() }));
    await fillToLast(p);
    setText(p, 'beta_note', 'extra');
    nextBtn(p).click(); await sleep(20);                     // review
    q(p, '#saveBtn').click();
    await sleep(150);
    const sub = p.calls.find(c => c.url === '/api/forms/submit');
    expect(sub).toBeTruthy();
    expect(sub.body.data.full_name).toBe('Fred T');
    expect(sub.body.data.pick).toBe('b');

    // parity: same definition, layout stripped, same answers → same collect()
    const flatDef = cardDef(); delete flatDef.layout;
    const f = await ready(bootPage({ definition: flatDef }));
    setText(f, 'full_name', 'Fred T');
    pickRadio(f, 'pick', 'b'); await sleep(30);
    setText(f, 'beta_note', 'extra');
    setText(f, 'email', 'fred@x.test');
    await sleep(30);
    expect(f.win.ycForm.collect()).toEqual(p.win.ycForm.collect());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// P — preview: free navigation
// ═══════════════════════════════════════════════════════════════════════════

describe('P preview', () => {
  test('Next never blocks, no errors painted, Submit stays disabled', async () => {
    const p = await ready(bootPage({ definition: cardDef(), preview: true }));
    const cards = qa(p, '.yc-card');
    expect(activeCard(p)).toBe(cards[0]);
    nextBtn(p).click(); await sleep(20);                     // required name empty
    expect(activeCard(p)).toBe(cards[1]);
    expect(q(p, '.yc-error.visible')).toBeNull();
    // unvisited dots are clickable in preview
    const ds = dots(p);
    expect(ds[2].classList.contains('clickable')).toBe(true);
    ds[2].click(); await sleep(20);
    expect(activeCard(p)).toBe(cards[3]);
    // review reachable with everything blank; Submit present but disabled
    nextBtn(p).click(); await sleep(20);
    expect(q(p, '.yc-card-review').style.display).toBe('');
    const sb = q(p, '#saveBtn');
    expect(sb.style.display).toBe('');
    expect(sb.hasAttribute('disabled')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// W — view mode renders flat
// ═══════════════════════════════════════════════════════════════════════════

describe('W view mode', () => {
  test('?view_submission ignores layout — flat, populated, locked', async () => {
    const p = await ready(bootPage({ definition: cardDef(), view: true }));
    expect(q(p, '.yc-card')).toBeNull();
    expect(q(p, '.yc-card-nav')).toBeNull();
    expect(qa(p, '.yc-section').length).toBe(4);
    expect(q(p, 'input[name="full_name"]').value).toBe('Zed');
    expect(q(p, '#saveBtn').style.display).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// V — validator / signature / projection
// ═══════════════════════════════════════════════════════════════════════════

describe('V validator + projection', () => {
  const base = () => { const d = cardDef(); return d; };

  test('layout "card" accepted; anything else rejected', () => {
    expect(() => svc.validateDefinition(base())).not.toThrow();
    const bad = base(); bad.layout = 'wizard';
    expect(() => svc.validateDefinition(bad)).toThrow(/layout "wizard" is not supported/);
    const arr = base(); arr.layout = ['card'];
    expect(() => svc.validateDefinition(arr)).toThrow(/layout/);
  });

  test('card + tabs rejected (charter binding addition); card + sticky unrepresentable', () => {
    const both = {
      layout: 'card',
      tabs: [{ label: 'T', sections: [
        { title: 'S', rows: [{ fields: [{ name: 'a', type: 'text', label: 'A' }] }] }] }],
    };
    expect(() => svc.validateDefinition(both)).toThrow(/mutually exclusive/);
    const sticky = base();
    sticky.stickyTop = [{ rows: [{ fields: [{ name: 'zz', type: 'text', label: 'Z' }] }] }];
    // the pre-existing "sticky only with tabs" rule fires — card implies sections mode
    expect(() => svc.validateDefinition(sticky)).toThrow(/only allowed together with "tabs"/);
  });

  test('fieldSignature is layout-blind (schema_version can never bump for it)', () => {
    const withL = base();
    const without = base(); delete without.layout;
    expect(svc.fieldSignature(withL)).toBe(svc.fieldSignature(without));
    expect(svc.fieldSignature(withL)).not.toBe('');
  });

  test('projectDefinition preserves layout (the §Q outbound-allowlist lock)', () => {
    const out = ext.projectDefinition(base());
    expect(out.layout).toBe('card');
    const flat = ext.projectDefinition((() => { const d = base(); delete d.layout; return d; })());
    expect('layout' in flat).toBe(false);
  });
});
