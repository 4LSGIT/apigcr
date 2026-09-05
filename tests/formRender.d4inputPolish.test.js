/**
 * D4 — input polish from the full-form walkthrough. Repro-first, against the
 * REAL files (render.html with runScripts:'dangerously', the real
 * /js/yc-forms.js via ResourceLoader — the D1/D2-H harness shape).
 *
 * Findings under test (both FAIL on pristine pre-D4 files):
 *   (2) a junk phone / email value got NO reaction on blur — only the card
 *       gate (Next) flagged it. Now: focus loss paints the same inline
 *       .yc-error the gate paints, on that one field only; a passing blur
 *       clears it; a blank field is never nagged.
 *   (3) type=number accepted "-4" and "e+212". Now: keystroke filter kills
 *       e/E/+ always and '-' unless the element's min attribute declares
 *       negatives; pasted junk is caught by the `number` validation rule at
 *       blur AND at the gate.
 *
 * Plus the A1 prefix adornment (renders, never enters values) and the A2
 * interaction guarantees: text blur cannot auto-advance a card, and the
 * conditional-driven nav refresh (D2-H) is unaffected.
 *
 *   npx jest tests/formRender.d4inputPolish.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const RENDER_HTML = fs.readFileSync(path.join(ROOT, 'public/forms/render.html'), 'utf8');
const YC_FORMS_JS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

// ── Flat definition: the walkthrough's field shapes, minimized ──
const FLAT_DEF = {
  toggle: false,
  sections: [
    { title: 'Emergency contact', rows: [{ fields: [
      { name: 'em_phone', type: 'text', label: 'Phone', mask: 'phone' },
      { name: 'em_email', type: 'text', label: 'Email', email: true },
    ] }] },
    { title: 'Household', rows: [{ fields: [
      { name: 'family_size', type: 'number', label: 'How many people', min: 0 },
      { name: 'net_adjust', type: 'number', label: 'Net adjustment', min: -100 },
      { name: 'loose_num', type: 'number', label: 'Unbounded' },
    ] }] },
    { title: 'Rent', rows: [{ fields: [
      { name: 'rent', type: 'number', label: 'Monthly rent', prefix: '$', min: 0 },
      { name: 'rate', type: 'number', label: 'Rate', suffix: '%', min: 0 },
    ] }] },
  ],
};

// ── Card definition: the D2-H shape + a masked text question, for the
//    interaction guarantees ──
const CARD_DEF = {
  layout: 'card',
  toggle: false,
  sections: [
    { title: 'S1', rows: [{ fields: [{ name: 's1', type: 'radio', label: 'Q1',
      options: [{ value: 'YES', label: 'Yes' }, { value: 'NO', label: 'No' }] }] }] },
    { title: 'S2', showWhen: { field: 's1', op: 'eq', value: 'YES' },
      rows: [{ fields: [{ name: 's2', type: 'text', label: 'Q2', mask: 'phone' }] }] },
    { title: 'S3', showWhenAny: [{ field: 's1', op: 'eq', value: 'NO' },
                                 { field: 's2', op: 'notEmpty' }],
      rows: [{ fields: [{ name: 's3', type: 'text', label: 'Q3' }] }] },
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

function makePage(definition) {
  const url = 'https://app.test/forms/render.html?form_key=d4_test&case_id=abc12345&ext=1';
  const fetchStub = async (u) => {
    if (String(u).startsWith('/api/ext/forms/')) {
      return { ok: true, status: 200, json: async () => ({
        status: 'success', title: 'D4', link_type: 'case', schema_version: 1,
        definition, load: {}, linked: true }) };
    }
    if (String(u).endsWith('/submit')) {
      return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
    }
    throw new Error('unstubbed fetch: ' + u);
  };
  const dom = new JSDOM(RENDER_HTML, {
    url, runScripts: 'dangerously', resources: new TestLoader(), pretendToBeVisual: true,
    beforeParse(window) {
      if (!window.CSS) {
        window.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00A0-\uFFFF-]/g, (ch) => '\\' + ch) };
      }
      window.fetch = fetchStub;
    },
  });
  DOMS.push(dom);
  return dom;
}

async function ready(dom) {
  const w = dom.window;
  for (let i = 0; i < 300; i++) {
    const fatal = w.document.querySelector('.ycr-fatal');
    if (fatal) throw new Error('render fatal: ' + fatal.textContent);
    const ov = w.document.querySelector('.yc-loading-overlay');
    if (w.ycForm && ov && ov.style.display === 'none') break;
    await sleep(10);
  }
  if (!w.ycForm) throw new Error('form never finished init');
  await sleep(60);
  return w;
}

const q = (w, sel) => w.document.querySelector(sel);
const field = (w, name) => q(w, `[name="${name}"]`);
const errorOf = (w, name) => field(w, name).closest('.yc-field').querySelector('.yc-error');

/** Type (input event, no change — mid-typing) then leave the field (focusout). */
function typeAndLeave(w, name, val) {
  const el = field(w, name);
  if (val !== undefined) {
    el.value = val;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
  el.dispatchEvent(new w.Event('focusout', { bubbles: true }));
}

function press(w, name, key) {
  const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  field(w, name).dispatchEvent(ev);
  return ev.defaultPrevented;
}

// ════════════════════════════════════════════════════════════════════════════
// Finding 2 — on-blur single-field format validation (A2)
// ════════════════════════════════════════════════════════════════════════════

describe('D4 A2 — blur validation', () => {
  test('REPRO: junk phone value errors on focus loss, inline, that field only', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'em_phone', 'fwfgwer');
    const err = errorOf(w, 'em_phone');
    expect(err.classList.contains('visible')).toBe(true);
    expect(err.textContent).toBe('Invalid phone format');
    // …and ONLY that field: the sibling email stayed silent.
    expect(errorOf(w, 'em_email').classList.contains('visible')).toBe(false);
  });

  test('a passing blur clears the error; a valid value never errors', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'em_phone', 'fwfgwer');
    expect(errorOf(w, 'em_phone').classList.contains('visible')).toBe(true);
    typeAndLeave(w, 'em_phone', '2486213656');
    expect(errorOf(w, 'em_phone').classList.contains('visible')).toBe(false);
    expect(errorOf(w, 'em_phone').textContent).toBe('');
  });

  test('blank + not required ⇒ no nag on tab-through', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'em_phone');                     // never typed
    expect(errorOf(w, 'em_phone').classList.contains('visible')).toBe(false);
    typeAndLeave(w, 'em_phone', '');                 // typed then deleted
    expect(errorOf(w, 'em_phone').classList.contains('visible')).toBe(false);
  });

  test('email sub-field: junk errors on blur with the gate wording', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'em_email', 'notanemail');
    expect(errorOf(w, 'em_email').textContent).toBe('Enter a valid email address');
    typeAndLeave(w, 'em_email', 'a@b.co');
    expect(errorOf(w, 'em_email').classList.contains('visible')).toBe(false);
  });

  test('blurring one bad field never wipes another field\u2019s painted error', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'em_phone', 'junk1');
    typeAndLeave(w, 'em_email', 'junk2');
    expect(errorOf(w, 'em_phone').classList.contains('visible')).toBe(true);
    expect(errorOf(w, 'em_email').classList.contains('visible')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Finding 3 — number hardening (A3)
// ════════════════════════════════════════════════════════════════════════════

describe('D4 A3 — number keystroke filter', () => {
  test('REPRO: e, E, + always dead; - dead on a min:0 field', async () => {
    const w = await ready(makePage(FLAT_DEF));
    expect(press(w, 'family_size', 'e')).toBe(true);
    expect(press(w, 'family_size', 'E')).toBe(true);
    expect(press(w, 'family_size', '+')).toBe(true);
    expect(press(w, 'family_size', '-')).toBe(true);
  });

  test('digits and the decimal point pass', async () => {
    const w = await ready(makePage(FLAT_DEF));
    expect(press(w, 'rent', '4')).toBe(false);
    expect(press(w, 'rent', '.')).toBe(false);
  });

  test('- passes when min declares negatives; dead when no min declared', async () => {
    const w = await ready(makePage(FLAT_DEF));
    expect(press(w, 'net_adjust', '-')).toBe(false);   // min: -100
    expect(press(w, 'loose_num', '-')).toBe(true);     // no min declared
  });

  test('modifier chords pass (shortcuts are not typing)', async () => {
    const w = await ready(makePage(FLAT_DEF));
    const ev = new w.KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true, cancelable: true });
    field(w, 'family_size').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('D4 A3 — pasted junk caught by validation', () => {
  test('REPRO: -4 on a min:0 number errors on blur', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'family_size', '-4');
    expect(errorOf(w, 'family_size').textContent).toBe('Must be at least 0');
  });

  test('scientific notation errors as not-a-number', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'family_size', '1e9');
    expect(errorOf(w, 'family_size').textContent).toBe('Enter a valid number');
  });

  test('plain decimals pass; declared max enforced only when declared', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'rent', '1200.50');
    expect(errorOf(w, 'rent').classList.contains('visible')).toBe(false);
    // No declared max ⇒ a huge plain number is legal (bounds are a contract,
    // not an invention).
    typeAndLeave(w, 'rent', '999999999');
    expect(errorOf(w, 'rent').classList.contains('visible')).toBe(false);
  });

  test('no invented bound: a negative on an undeclared-min field passes validation', async () => {
    // The keystroke filter blocks TYPING '-' there, but a loaded/pasted
    // negative must not block Save when the author never declared min.
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'loose_num', '-5');
    expect(errorOf(w, 'loose_num').classList.contains('visible')).toBe(false);
  });

  test('the gate remains the backstop: full validate() rejects pasted -4', async () => {
    const w = await ready(makePage(FLAT_DEF));
    field(w, 'family_size').value = '-4';            // paste, no events at all
    expect(w.ycForm.validate()).toBe(false);
    expect(errorOf(w, 'family_size').textContent).toBe('Must be at least 0');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A1 — prefix/suffix adornment
// ════════════════════════════════════════════════════════════════════════════

describe('D4 A1 — prefix adornment', () => {
  test('renders inside the field wrapper, left of the input', async () => {
    const w = await ready(makePage(FLAT_DEF));
    const wrap = field(w, 'rent').closest('.yc-field');
    const adorn = wrap.querySelector('.yc-input-adorn');
    expect(adorn).not.toBeNull();
    expect(adorn.firstElementChild.className).toBe('yc-adorn');
    expect(adorn.firstElementChild.textContent).toBe('$');
    expect(adorn.querySelector('input[name="rent"]')).not.toBeNull();
    // suffix sits after its input
    const sWrap = field(w, 'rate').closest('.yc-field').querySelector('.yc-input-adorn');
    expect(sWrap.lastElementChild.textContent).toBe('%');
  });

  test('never part of the value: collect() and the submit body see digits only', async () => {
    const w = await ready(makePage(FLAT_DEF));
    field(w, 'rent').value = '1200';
    expect(w.ycForm.collect().rent).toBe('1200');
  });

  test('fields without prefix render the bare input — zero new DOM', async () => {
    const w = await ready(makePage(FLAT_DEF));
    expect(field(w, 'family_size').closest('.yc-field').querySelector('.yc-input-adorn')).toBeNull();
    expect(field(w, 'em_phone').closest('.yc-field').querySelector('.yc-input-adorn')).toBeNull();
  });

  test('the error element still resolves through the wrapper (validate paints it)', async () => {
    const w = await ready(makePage(FLAT_DEF));
    typeAndLeave(w, 'rent', '-9');
    expect(errorOf(w, 'rent').textContent).toBe('Must be at least 0');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A2 interaction — cards: no advance on text blur, D2-H refresh untouched
// ════════════════════════════════════════════════════════════════════════════

describe('D4 A2 — card-mode interaction guarantees', () => {
  const cardsOf = (w) => [...w.document.querySelectorAll('.yc-card')];
  const activeIx = (w) => cardsOf(w).findIndex((c) => c.classList.contains('active'));
  const countTx = (w) => q(w, '.yc-card-count').textContent;
  function pickRadio(w, name, val) {
    const r = q(w, `input[name="${name}"][value="${val}"]`);
    r.checked = true;
    r.dispatchEvent(new w.Event('change', { bubbles: true }));
  }

  test('radio auto-advance still works (regression guard), then text blur never advances', async () => {
    const w = await ready(makePage(CARD_DEF));
    pickRadio(w, 's1', 'YES');
    await sleep(450);
    expect(activeIx(w)).toBe(1);                          // advanced to S2

    // Mid-typing keystroke: D2-H nav refresh reveals S3 immediately.
    const s2 = field(w, 's2');
    s2.value = 'abc';
    s2.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(countTx(w)).toBe('2 of 3');

    // The full leave-the-field sequence a real blur fires: change, then
    // focusout. Neither may navigate — text is outside ADVANCE_TYPES, and
    // the blur validator shares no event with the advance path at all.
    s2.dispatchEvent(new w.Event('change', { bubbles: true }));
    s2.dispatchEvent(new w.Event('focusout', { bubbles: true }));
    await sleep(450);
    expect(activeIx(w)).toBe(1);                          // did not move
    expect(countTx(w)).toBe('2 of 3');                    // nav state intact

    // …and the blur validator DID run: 'abc' is a junk phone.
    expect(errorOf(w, 's2').textContent).toBe('Invalid phone format');

    // Fixing it clears on the next leave, still without navigation.
    s2.value = '2486213656';
    s2.dispatchEvent(new w.Event('input', { bubbles: true }));
    s2.dispatchEvent(new w.Event('focusout', { bubbles: true }));
    await sleep(450);
    expect(activeIx(w)).toBe(1);
    expect(errorOf(w, 's2').classList.contains('visible')).toBe(false);
  });

  test('clearing the gating value on blur still re-hides the later card (conditional refresh unaffected)', async () => {
    const w = await ready(makePage(CARD_DEF));
    pickRadio(w, 's1', 'YES');
    await sleep(450);
    const s2 = field(w, 's2');
    s2.value = 'x';
    s2.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(countTx(w)).toBe('2 of 3');
    s2.value = '';
    s2.dispatchEvent(new w.Event('input', { bubbles: true }));
    s2.dispatchEvent(new w.Event('focusout', { bubbles: true }));
    expect(countTx(w)).toBe('2 of 2');                    // D2-H behavior intact
    expect(errorOf(w, 's2').classList.contains('visible')).toBe(false);   // blank = no nag
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D4b — the external projection must carry the D4 keys.
// The defect that shipped: DBKQ v1.2 published with 63 `$` prefixes and the
// external wire stripped every one — extFormService's FIELD_KEYS allowlist
// omission, fourth instance of the class (layout, content, showWhenAny). The
// D4 suite stayed green because makePage's fetch stub serves the definition
// RAW, bypassing the projection; the full-chain test below closes that hole
// by serving projectDefinition() output instead.
// ════════════════════════════════════════════════════════════════════════════

const extSvc = require('../services/extFormService');

describe('D4b — external projection carries prefix/suffix', () => {
  test('REPRO: prefix/suffix survive projectDefinition on fields and repeater fields', () => {
    const out = extSvc.projectDefinition({
      sections: [
        { title: 'S', rows: [{ fields: [
          { name: 'rent', type: 'number', prefix: '$', min: 0, apiColumn: 'secret_col' },
          { name: 'rate', type: 'number', suffix: '%', max: 100 },
        ] }] },
        { repeater: 'debts', title: 'Debts',
          fields: [{ name: 'amt', type: 'number', prefix: '$', min: 0 }] },
      ],
    });
    const [rent, rate] = out.sections[0].rows[0].fields;
    expect(rent.prefix).toBe('$');
    expect(rent.min).toBe(0);
    expect(rate.suffix).toBe('%');
    expect(rate.max).toBe(100);
    expect(out.sections[1].fields[0].prefix).toBe('$');
    // Allowlist discipline intact — this is an addition, not a loosening.
    expect(rent.apiColumn).toBeUndefined();
  });

  test('REPRO full chain: a PROJECTED definition still renders the $ adornment', async () => {
    // Exactly what production serves: render.html + yc-forms.js fed the
    // projection's output. On the unfixed allowlist the adornment vanishes
    // here while every raw-definition test above stays green.
    const w = await ready(makePage(extSvc.projectDefinition(FLAT_DEF)));
    const adorn = field(w, 'rent').closest('.yc-field').querySelector('.yc-input-adorn');
    expect(adorn).not.toBeNull();
    expect(adorn.firstElementChild.textContent).toBe('$');
    // And the keys that already rode the projection keep working end-to-end:
    // min survived, so the '-' policy and blur bounds hold on projected input.
    expect(press(w, 'family_size', '-')).toBe(true);
    expect(press(w, 'net_adjust', '-')).toBe(false);
    typeAndLeave(w, 'family_size', '-4');
    expect(errorOf(w, 'family_size').textContent).toBe('Must be at least 0');
  });
});
