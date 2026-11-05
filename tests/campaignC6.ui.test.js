// tests/campaignC6.ui.test.js
//
/**
 * YisraMail C6 — the email_design picker (public/automationManager.html
 * fdEmailDesignSelectHtml) and the campaign Stats dialog's engagement lines
 * (public/campaign.html viewStats).
 *
 * The helper is lifted VERBATIM from the shipped file by brace-matching (the
 * workflows.editor.roundtrip pattern) and evaluated against stubs for
 * everything it calls — esc (real, same file) and fdEmailDesigns (stubbed per
 * test; the real one reads a module-scope cache filled by one boot fetch).
 *
 *   npx jest tests/campaignC6.ui.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MGR = fs.readFileSync(path.join(__dirname, '..', 'public', 'automationManager.html'), 'utf8');
const SCRIPT = MGR.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/)[1];

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`automationManager.html: function ${name} not found — did it get renamed?`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`automationManager.html: unbalanced braces in ${name}`);
}

/** The shipped helper + the shipped esc, over a stubbed designs cache. */
function helper(designs) {
  const ctx = vm.createContext({ fdEmailDesigns: () => designs });
  vm.runInContext(extractFn(SCRIPT, 'esc'), ctx);
  vm.runInContext(extractFn(SCRIPT, 'fdEmailDesignSelectHtml'), ctx);
  return (id, cur) => vm.runInContext(
    `fdEmailDesignSelectHtml(${JSON.stringify(id)}, ${JSON.stringify(cur ?? null)})`, ctx);
}

const DESIGNS = [
  { id: 3, name: 'Birthday card', builder: 'designer', archived: 0 },
  { id: 9, name: 'Newsletter "Fall" <2026>', builder: 'designer', archived: 0 },
  { id: 5, name: 'Old promo', builder: 'designer', archived: 1 },
];

describe('fdEmailDesignSelectHtml (lifted from automationManager.html)', () => {
  test('no designs loaded (boot fetch pending / failed / none saved) → a plain id input carrying the stored value', () => {
    const html = helper([])('e-pf-design_id', 7);
    expect(html).toMatch(/^<input /);
    expect(html).toContain('id="e-pf-design_id"');
    expect(html).toContain('value="7"');
  });

  test('designs → a select of the live ones by name, blank "no design" first; archived designs are not offered', () => {
    const html = helper(DESIGNS)('e-pf-design_id', null);
    expect(html).toMatch(/^<select /);
    expect(html).toContain('<option value="" selected>— no design —</option>');
    expect(html).toContain('Birthday card (#3)');
    expect(html).not.toContain('Old promo (#5)');
    // names are escaped — a quote or angle bracket cannot break the markup
    expect(html).toContain('Newsletter &quot;Fall&quot; &lt;2026&gt; (#9)');
    expect(html).not.toContain('<2026>');
  });

  test('the stored value is selected; a stored ARCHIVED id labels itself instead of vanishing', () => {
    expect(helper(DESIGNS)('x', 3)).toContain('<option value="3" selected>');
    const arch = helper(DESIGNS)('x', 5);
    expect(arch).toContain('<option value="5" selected>Old promo (#5, archived)</option>');
  });

  test('a stored id the list does not know keeps the value as a labeled custom option', () => {
    const html = helper(DESIGNS)('x', 42);
    expect(html).toContain('<option value="42" selected>#42 (unknown design)</option>');
    expect(html).not.toContain('value="" selected');
  });
});

describe('the dispatch wiring (source pins — full round-trip lives in workflows.editor.roundtrip)', () => {
  const DISPATCH = "if (spec.widget === 'email_design' && typeof P.fdEmailDesignSelectHtml === 'function') {";
  test.each([
    ['public/automation/workflows.html'],
    ['public/automation/sequences.html'],
  ])('%s renders widget email_design through the parent helper', (f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    expect(src.split(DISPATCH).length - 1).toBe(1);
  });

  test('the manager exports the helper and boots the one designs fetch', () => {
    expect(SCRIPT).toContain('window.fdEmailDesignSelectHtml = fdEmailDesignSelectHtml');
    expect(SCRIPT).toContain("apiSend('/api/email-designs?include_archived=1', 'GET')");
  });

  test('send_email.design_id carries the widget hint', () => {
    const meta = require('../lib/internal_functions').__getMeta('send_email');
    expect(meta.params.find((p) => p.name === 'design_id')).toMatchObject({ widget: 'email_design' });
  });
});

describe('campaign.html Stats dialog — engagement lines', () => {
  const CAMPAIGN = fs.readFileSync(path.join(__dirname, '..', 'public', 'campaign.html'), 'utf8');
  test('viewStats renders Clicked/Opened from campaign.delivery and the per-link list from campaign.links, clicks first', () => {
    // The dialog builds one template literal; pin the load-bearing pieces so a
    // rename of delivery.clicked / links[].clickers fails here, not in prod.
    expect(CAMPAIGN).toContain('<strong>Clicked:</strong> ${d.clicked}');
    expect(CAMPAIGN).toContain('<strong>Opened:</strong> ${d.opened}');
    expect(CAMPAIGN).toMatch(/opens are approximate/);
    expect(CAMPAIGN).toContain('campaign.links.map(l =>');
    expect(CAMPAIGN).toContain('word-break:break-all');   // a 500-char URL must not push the dialog sideways
  });
});
