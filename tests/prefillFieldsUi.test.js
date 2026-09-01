/**
 * tests/prefillFieldsUi.test.js
 *
 * public/esign/prefillFields.js — the fill-in-fields block G3 lifted out of
 * sendForm.html so /documents/generateForm.html could mount the same one.
 *
 * WHY THIS EXISTS
 *
 * The extraction's whole claim is "byte-identical DOM". That claim was true at
 * extraction time (verified against the pre-extraction file), but the
 * pre-extraction file is gone — so the claim has no way to stay true on its
 * own. This suite is the replacement: the expected HTML below was CAPTURED
 * from the shipped module and is pinned verbatim, so any future edit to the
 * renderer has to change this file too, deliberately, rather than silently
 * repainting a form whose only other regression net is a human smoke test.
 *
 * Three things are pinned:
 *
 *   · THE MARKUP, character for character — including the two details most
 *     likely to be "cleaned up" by someone who doesn't know they are
 *     load-bearing: `data-key` is NOT escaped (schema keys are validated to a
 *     safe charset server-side, and escaping them now would be a silent DOM
 *     diff), and the missing-required note is a leading-space-prefixed span
 *     rather than a block.
 *
 *   · GATHER IS SCOPED TO THE CONTAINER. The original queried `document` for
 *     `.sf-f`, which was fine on a page with one block and wrong the moment
 *     there were two. The scoping test below is the only thing that would
 *     catch a regression to the old global query, because on both real pages
 *     today there IS only one block — it would pass in production and fail the
 *     first time anyone added a second.
 *
 *   · markMissing IS IN-PLACE. It exists because re-rendering to show a 400's
 *     `missing` would throw away everything the user just typed, AND would
 *     corrupt an `options` field (gather flattens its array to newline text;
 *     render only accepts an array). That asymmetry is real and pre-dates G3 —
 *     it just never bit, because sendForm never re-renders after gathering.
 *
 *   npx jest tests/prefillFieldsUi.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'public/esign/prefillFields.js'), 'utf8');
const ESIGN_ACTIONS = fs.readFileSync(path.join(ROOT, 'public/esign/esignActions.js'), 'utf8');
const SEND_FORM = fs.readFileSync(path.join(ROOT, 'public/esign/sendForm.html'), 'utf8');
const GEN_FORM = fs.readFileSync(path.join(ROOT, 'public/documents/generateForm.html'), 'utf8');

/** The REAL escaper both consumer pages inject, pulled from the shipped file
 *  rather than re-implemented — an approximation here would let an escaping
 *  regression pass. */
function esignEscSource() {
  const m = /function esignEsc\(([\s\S]*?)\n}/.exec(ESIGN_ACTIONS);
  if (!m) throw new Error('esignEsc not found in esignActions.js — did it get renamed?');
  return 'function esignEsc(' + m[1] + '\n}';
}

/** A sandbox with two containers, so the scoping test has something to scope. */
function sandbox() {
  const dom = new JSDOM(
    '<!DOCTYPE html><body><div id="one"></div><div id="two"></div></body>');
  const ctx = vm.createContext({
    window: dom.window, document: dom.window.document,
    Set, Array, Math, String, console,
  });
  vm.runInContext(esignEscSource(), ctx);
  vm.runInContext(MODULE, ctx);
  const make = (id) => vm.runInContext(
    `window.buildPrefillFields({ containerId: ${JSON.stringify(id)}, esc: esignEsc })`, ctx);
  return { dom, ctx, make, html: (id) => dom.window.document.getElementById(id).innerHTML };
}

const SCHEMA = [
  { key: 'debtor_name', label: 'Debtor "full" name & co', type: 'text', required: true },
  { key: 'fee', label: 'Fee <total>', type: 'money', required: true },
  { key: 'filed_on', label: "Filed on 'date'", type: 'date', required: true },
  { key: 'chapter', label: 'Chapter', type: 'options', required: false },
];
const VALUES = {
  debtor_name: 'O\'Brien "Bob"',
  fee: '$1,234.50',
  filed_on: '07/19/2026',
  chapter: ['Ch 7', 'Ch 13 & up'],
};

// Captured from the shipped module. Pinned, not derived — see the header.
const EXPECTED =
  '<div class="sf-row"><label>Debtor "full" name &amp; co <span class="req">*</span>:</label>' +
  '<input type="text" class="sf-f" data-key="debtor_name" inputmode="text" placeholder="" ' +
  'value="O\'Brien &quot;Bob&quot;"></div>' +
  '<div class="sf-row"><label style="color:#b45309">Fee &lt;total&gt; <span class="req">*</span>:</label>' +
  '<input type="text" class="sf-f" data-key="fee" inputmode="decimal" placeholder="$0.00" ' +
  'value="$1,234.50"> <span class="sf-missing"><i class="fa-solid fa-triangle-exclamation"></i> ' +
  'required — not resolved from the case</span></div>' +
  '<div class="sf-row"><label style="color:#b45309">Filed on \'date\' <span class="req">*</span>:</label>' +
  '<input type="date" class="sf-f" data-key="filed_on" value="2026-07-19"> ' +
  '<span class="sf-missing"><i class="fa-solid fa-triangle-exclamation"></i> ' +
  'required — not resolved from the case</span></div>' +
  '<div class="sf-row"><label>Chapter:</label>' +
  '<textarea class="sf-f" data-key="chapter" rows="3" spellcheck="false" ' +
  'style="font-family:inherit;">Ch 7\nCh 13 &amp; up</textarea>' +
  '<div class="sf-hint">One choice per line — the dropdown the signer picks from.</div></div>';

describe('prefillFields — the markup is pinned', () => {
  test('renders the extraction-time DOM character for character', () => {
    const s = sandbox();
    const pf = s.make('one');
    pf.render(SCHEMA, VALUES, ['fee', 'filed_on']);
    expect(s.html('one')).toBe(EXPECTED);
  });

  test('data-key is deliberately NOT escaped', () => {
    // Not a style nit: escaping it would change the emitted bytes on every
    // page that renders a field, and the keys cannot contain anything that
    // needs escaping (esignTemplateService validates the charset).
    expect(MODULE).toContain('data-key="${e.key}"');
  });

  test('an empty schema renders the no-fields line, not an empty div', () => {
    const s = sandbox();
    s.make('one').render([], {}, []);
    expect(s.html('one'))
      .toBe('<div class="sf-hint">This template has no fill-in fields.</div>');
  });

  test('missing is only marked on REQUIRED keys', () => {
    const s = sandbox();
    s.make('one').render(
      [{ key: 'a', label: 'A', type: 'text', required: false }], {}, ['a']);
    expect(s.html('one')).not.toContain('sf-missing');
    expect(s.html('one')).not.toContain('#b45309');
  });
});

describe('prefillFields — gather', () => {
  test('round-trips render → gather without loss (dates come back as MM/DD/YYYY)', () => {
    const s = sandbox();
    const pf = s.make('one');
    pf.render(SCHEMA, VALUES, []);
    expect(pf.gather()).toEqual({
      debtor_name: 'O\'Brien "Bob"',
      fee: '$1,234.50',
      filed_on: '07/19/2026',
      chapter: 'Ch 7\nCh 13 & up',
    });
  });

  test('empty fields are OMITTED, never sent as empty strings', () => {
    // A supplied '' OVERRIDES the resolver server-side, so writing one would
    // blank a field the author meant to auto-fill.
    const s = sandbox();
    const pf = s.make('one');
    pf.render([{ key: 'a', label: 'A', type: 'text', required: false }], {}, []);
    expect(pf.gather()).toEqual({});
  });

  test('gather is SCOPED to its own container', () => {
    // The pre-extraction version queried `document` for .sf-f. Both real pages
    // have exactly one block, so a regression to the global query would pass
    // in production and only break when someone added a second — which is
    // precisely what this asserts cannot happen silently.
    const s = sandbox();
    const a = s.make('one');
    const b = s.make('two');
    a.render([{ key: 'mine', label: 'Mine', type: 'text' }], { mine: 'A' }, []);
    b.render([{ key: 'theirs', label: 'Theirs', type: 'text' }], { theirs: 'B' }, []);
    expect(a.gather()).toEqual({ mine: 'A' });
    expect(b.gather()).toEqual({ theirs: 'B' });
  });
});

describe('prefillFields — markMissing works IN PLACE', () => {
  test('marks without re-rendering, so typed values survive', () => {
    const s = sandbox();
    const pf = s.make('one');
    pf.render(SCHEMA, {}, []);
    s.dom.window.document.querySelector('[data-key="fee"]').value = '$500.00';

    pf.markMissing(['filed_on']);

    expect(s.html('one')).toContain('sf-missing');
    // The whole point: the untouched field kept what the user typed.
    expect(pf.gather().fee).toBe('$500.00');
    // …and an options field did not get flattened into oblivion, which is what
    // a re-render would have done to it.
    expect(s.dom.window.document.querySelector('[data-key="chapter"]').tagName)
      .toBe('TEXTAREA');
  });

  test('an empty list CLEARS a previous marking', () => {
    const s = sandbox();
    const pf = s.make('one');
    pf.render(SCHEMA, {}, []);
    pf.markMissing(['fee']);
    expect(s.html('one')).toContain('sf-missing');
    pf.markMissing([]);
    expect(s.html('one')).not.toContain('sf-missing');
  });

  test('a non-required key is never marked, even if the server names it', () => {
    const s = sandbox();
    const pf = s.make('one');
    pf.render(SCHEMA, {}, []);
    pf.markMissing(['chapter']);   // declared, but required:false
    expect(s.html('one')).not.toContain('sf-missing');
  });
});

describe('the two consumer pages actually use the module', () => {
  test('sendForm.html loads it and no longer defines its own copy', () => {
    expect(SEND_FORM).toContain('src="/esign/prefillFields.js"');
    expect(SEND_FORM).toContain('buildPrefillFields({ containerId: \'sf-fields\'');
    // The originals are GONE — a leftover copy would be the one that drifts.
    expect(SEND_FORM).not.toMatch(/function renderFields\s*\(/);
    expect(SEND_FORM).not.toMatch(/function mdyToIso\s*\(/);
    expect(SEND_FORM).not.toMatch(/function isoToMdy\s*\(/);
  });

  test('generateForm.html loads it and mounts its own container', () => {
    expect(GEN_FORM).toContain('src="/esign/prefillFields.js"');
    expect(GEN_FORM).toContain('buildPrefillFields({ containerId: \'gf-fields\'');
    expect(GEN_FORM).toContain('id="gf-fields"');
  });

  test('both pages style the classes the module emits', () => {
    // The module owns .sf-row / .req / .sf-hint / .sf-missing now. A consumer
    // that forgets them renders an unstyled block that still "works".
    for (const [name, html] of [['sendForm', SEND_FORM], ['generateForm', GEN_FORM]]) {
      for (const cls of ['.sf-row', '.sf-hint', '.sf-missing', '.req']) {
        expect(`${name}:${html.includes(cls)}`).toBe(`${name}:true`);
      }
    }
  });
});
