// tests/emailDesignRules.timing.test.js
//
/**
 * YisraMail C3a — validateDesign stays LINEAR on hostile input (CLAUDE.md validator rule: any
 * staff JWT can send these bodies, and the check runs on the event loop).
 *
 * Measured before the guards (2026-11-04, this machine): parse5 alone took 13 s on 390 KB of
 * nested <div> + <li> (its scope walks are O(depth) per token) and 50 s on ONE tag with 200k
 * attributes (its tokenizer checks each new attribute against the earlier ones); the first cut of
 * the pre-parse scan took 1.7 s on 12k comments (a needle searched to the end once per comment),
 * and ended script content at the first </script — a double-escaped `<!--<script>` desynced it
 * into a fake raw-text block hiding a tag of ~100k attributes: 4.7 s at 506 KB (review round 1;
 * <script> is now refused before the parse, so the scan never has to follow script data).
 * Each case is at or near the 512 KB html ceiling (or the 512 KB design cap) and runs in a CHILD
 * process with a hard time limit — a run that never ends cannot fail a test, so a hang is killed
 * and fails by status. The expected OUTCOME is asserted too, so each case times the path it names.
 * Run: npx jest tests/emailDesignRules.timing.test.js
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const RULES = path.join(__dirname, '..', 'lib', 'emailDesignRules');
const FIX = path.join(__dirname, 'helpers', 'emailDesignFixture');
const CS = path.join(__dirname, '..', 'services', 'campaignService');
const BOUND_MS = 1000;

/** body(R, F, html, ins, room) → { design_json, html } source; prints "<ms> <outcome>". */
function runInChild(build) {
  const code = `
    const R = require(${JSON.stringify(RULES)}); const F = require(${JSON.stringify(FIX)}); require(${JSON.stringify(CS)});
    const html = F.html();
    const ins = (m) => html.replace('<div\\n         aria-label="4LSG Newsletter"', m + '<div\\n         aria-label="4LSG Newsletter"');
    const room = R.HTML_MAX_BYTES - Buffer.byteLength(html) - 64;
    const input = (${build})(R, F, html, ins, room);
    const t = process.hrtime.bigint();
    let out = 'ok';
    try { R.validateDesign(input); } catch (e) { out = e.rule ? 'rule ' + e.rule : 'error ' + e.message; }
    process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6) + ' ' + out);`;
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, env: process.env });
}

const html = (expr) => `(R, F, html, ins, room) => ({ design_json: F.design(), html: ${expr} })`;
const cases = [
  // name, builder, expected outcome
  ['nested <div> + <li> (scope walks at the depth cap)', html(`ins('<ul>' + '<div>'.repeat(100) + '<li>x'.repeat(Math.floor((room - 600) / 5)))`), 'ok'],
  ['nested <div> + <p>', html(`ins('<div>'.repeat(100) + '<p>x'.repeat(Math.floor((room - 600) / 4)))`), 'ok'],
  ['nesting past the depth cap', html(`ins('<div>'.repeat(Math.floor(room / 5)))`), 'rule 7'],
  ['distinct unclosed formatting elements', html(`ins(Array.from({ length: 20000 }, (_, i) => '<b x=' + i + '>').join(''))`), 'rule 7'],
  ['one tag, 40k attributes', html(`ins('<div ' + Array.from({ length: 40000 }, (_, i) => 'a' + i).join(' ') + '>')`), 'rule 7'],
  ['256 attributes on every tag', html(`ins(('<i ' + Array.from({ length: 250 }, (_, i) => 'a' + i).join(' ') + '></i>').repeat(Math.floor(room / 1400)))`), 'ok'],
  ['70k empty comments (the scan\'s comment-end search)', html(`ins('<!---->'.repeat(Math.floor(room / 7)))`), 'ok'],
  ['comments closed by --!> only', html(`ins('<!-- --!>'.repeat(Math.floor(room / 9)))`), 'ok'],
  ['conditional comments past the cap', html(`ins('<!--[if mso]><table><tr><td><![endif]-->'.repeat(Math.floor(room / 42)))`), 'rule 7'],
  ['conditional comments at the cap', html(`ins('<!--[if mso]><table><tr><td><![endif]-->'.repeat(R.MAX_CONDITIONALS - 30))`), 'ok'],
  ['double-escaped <script> hiding a 100k-attribute tag (review round 1: 4.7 s)', html(`ins('<script><!--<script></script><style></script><a ' + Array.from({ length: Math.floor((room - 80) / 6) }, (_, i) => 'q' + i.toString(36)).join(' ') + '></style>')`), 'rule 7'],
  ['an unclosed comment', html(`ins('<!--' + 'x'.repeat(room - 10))`), 'ok'],
  ['an unclosed quoted attribute full of <', html(`ins('<div a="' + '<'.repeat(room - 20))`), 'ok'],
  ['a tag name run of <x<x<x', html(`ins('<x' + '<x'.repeat(Math.floor(room / 2) - 10))`), 'ok'],
  ['raw text with near-miss end tags', html(`ins('<style>' + '</sty'.repeat(Math.floor(room / 5) - 10) + '</style>')`), 'ok'],
  ['CSS: url( nested inside one url( argument', html(`ins('<div style="background:url(https:' + 'url('.repeat(Math.floor(room / 4) - 20) + ')">x</div>')`), 'ok'],
  ['CSS: escapes', html(`ins('<div style="' + '\\\\41 '.repeat(Math.floor(room / 4) - 10) + '">x</div>')`), 'ok'],
  ['CSS: an unclosed /* run', html(`ins('<style>' + '/*'.repeat(Math.floor(room / 2) - 10) + '</style>')`), 'ok'],
  ['design: 12k textnodes (nine rule walks)', `(R, F, html) => { const d = F.design(); const t = d.pages[0].frames[0].component.components[0].components[1].components[1].components[0].components[0]; for (let i = 0; i < 12000; i++) t.components.push({ type: 'textnode', content: 'abc' + i }); return { design_json: d, html }; }`, 'ok'],
  ['design: 5k links with & (entity decode per URL)', `(R, F, html) => { const d = F.design(); const t = d.pages[0].frames[0].component.components[0].components[1].components[1].components[0].components[0]; for (let i = 0; i < 5000; i++) t.components.push({ type: 'link', attributes: { href: 'https://x.test/?a=1&b=' + i } }); return { design_json: d, html }; }`, 'ok'],
  ['design: a 400 KB style attribute of CSS escapes', `(R, F, html) => { const d = F.design(); d.pages[0].frames[0].component.components[0].components[1].components[1].components[0].components[0].attributes = { style: '\\\\41 '.repeat(100000) }; return { design_json: d, html }; }`, 'ok'],
  ['design: nested 10k-deep JSON (refused before any recursive walk)', `(R, F, html) => { const d = F.design(); let a = []; const top = a; for (let i = 0; i < 10000; i++) { const b = []; a.push(b); a = b; } d.assets.push(top); return { design_json: d, html }; }`, 'rule 1'],
];

describe('validateDesign on hostile input: each under 1 s, in a killable child', () => {
  test.each(cases)('%s', (name, build, expected) => {
    const r = runInChild(build);
    expect(r.error ? r.error.code : null).toBeNull();          // ETIMEDOUT = the child was killed
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const [ms, ...rest] = r.stdout.split(' ');
    expect(rest.join(' ')).toBe(expected);
    expect(Number(ms)).toBeLessThan(BOUND_MS);
  }, 30000);
});
