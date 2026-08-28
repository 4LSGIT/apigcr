// tests/casePanelCss.test.js
//
// A cascade guard for public/case.html's pipeline-panel stylesheet.
//
// WHY THIS EXISTS — a real bug, shipped, and invisible to every other suite.
//
// R3 rebuilt the panel's CSS. The new block was spliced into the slot the OLD
// timeline styles occupied, but the FIRST cut's block sat further down the
// stylesheet and was never removed. Both survived. The stale one was later in
// the cascade, so at equal specificity it won:
//
//   .pw-stage      { padding:0 0 14px 24px }   ← new: the gutter the dot sits in
//   .pw-stage      { padding:6px 9px }         ← stale, LATER, wins
//   .pw-stage-cur  { box-shadow:inset 3px 0 0 } ← stale: re-drew the current-stage
//                                                 marker on top of .pw-dot (left:0)
//
// Result: the absolutely-positioned timeline dot landed on the label text and
// the accent bar clipped it. Nothing failed. The panel's own jsdom suite
// asserts DOM structure and text content — jsdom performs no layout and does
// not resolve the cascade, so a stylesheet can contradict itself completely
// and every structural test stays green.
//
// These are cheap static checks over the stylesheet text. They cannot see
// rendering, but they catch the two things that actually went wrong: a
// selector declared twice, and a rule left behind for markup that no longer
// exists.
//
// Run:
//   npx jest tests/casePanelCss.test.js

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '../public/case.html'), 'utf8');

/** The panel's stylesheet region, from the first pw- rule to the tag close. */
function panelCss() {
  const start = HTML.indexOf('.pw-msg {');
  expect(start).toBeGreaterThan(-1);
  const end = HTML.indexOf('</style>', start);
  expect(end).toBeGreaterThan(start);
  return HTML.slice(start, end);
}

/** Selectors of every rule in the region, in source order. */
function selectors() {
  return panelCss()
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('{') && !l.startsWith('/*') && !l.startsWith('*'))
    .map(l => l.split('{')[0].trim())
    .filter(Boolean);
}

describe('pipeline-panel stylesheet', () => {
  test('NO SELECTOR IS DECLARED TWICE — the bug that shipped', async () => {
    const seen = new Map();
    const dupes = [];
    for (const s of selectors()) {
      if (seen.has(s)) dupes.push(s);
      seen.set(s, true);
    }
    // A duplicate is not automatically wrong in CSS, but in THIS block it has
    // meant a stale copy of a rewritten rule every time. If a genuine override
    // is ever wanted, merge it into the single declaration instead.
    expect(dupes).toEqual([]);
  });

  test('every pw- class in the stylesheet is actually used by the panel markup', async () => {
    // Catches the other half of the shipped bug: `.pw-intake` and `.pw-steps`
    // outliving the markup that used them.
    //
    // Class names reach the DOM three ways here — a literal attribute, an
    // interpolated one (`class="pw-stage ${kind}"`), and a string built in JS
    // (`'pw-req pw-req-' + status`). So the check is simply: does the token
    // appear anywhere OUTSIDE the stylesheet? The negative lookahead stops
    // `.pw-stage` from being kept alive by `pw-stage-cur`.
    const css = panelCss();
    const rest = HTML.replace(css, '');

    const styled = new Set();
    for (const sel of selectors()) {
      for (const m of sel.matchAll(/\.(pw-[a-z0-9-]+)/g)) styled.add(m[1]);
    }

    // `pw-req-<status>` is built by interpolation from the status itself, so
    // no literal token exists. Derive the legitimate set from the panel's own
    // icon table rather than hard-coding it — a new status adds its class here
    // automatically, and a REMOVED one correctly starts failing.
    const iconTable = HTML.slice(HTML.indexOf('const PW_REQ_ICON'));
    const statuses = [...iconTable.slice(0, iconTable.indexOf('};'))
      .matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map(m => m[1]);
    expect(statuses).toEqual(
      expect.arrayContaining(['done', 'active', 'upcoming', 'skipped', 'na']));
    const dynamic = new Set(statuses.map(st => 'pw-req-' + st));

    const orphans = [...styled]
      .filter(c => !dynamic.has(c))
      .filter(c => !new RegExp(c + '(?![-\\w])').test(rest))
      .sort();
    expect(orphans).toEqual([]);
  });

  test('the current-stage marker does not overlap the timeline dot', async () => {
    const css = panelCss();
    // The dot is absolutely positioned at the stage's left edge, so any marker
    // pinned to that same edge sits on top of it. This is exactly what
    // `box-shadow: inset ... 0 0` did.
    expect(css).not.toMatch(/\.pw-stage-cur\s*\{[^}]*box-shadow\s*:\s*inset/);
    // The replacement lives out in the container's padding gutter.
    expect(css).toMatch(/\.pw-stage-cur::after\s*\{[^}]*left\s*:\s*-\d/);
  });

  test('the stage gutter that holds the dot survives to the last declaration', async () => {
    const css = panelCss();
    const decls = [...css.matchAll(/(^|\n)\s*\.pw-stage\s*\{([^}]*)\}/g)].map(m => m[2]);
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatch(/padding\s*:[^;]*24px/);      // room for .pw-dot
    expect(decls[0]).toMatch(/position\s*:\s*relative/);   // the dot's containing block
  });
});
