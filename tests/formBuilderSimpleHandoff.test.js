/**
 * Simple Forms → Form Builder hand-off (public/formBuilderSimple.html,
 * openFullBuilder), ui-custom S6c-4.
 *
 * The pane runs inside the shell's panel stage; "Open in Form Builder" sets
 * the full builder's iframe src to this template FIRST (dropping data-src so
 * the shell's lazy load cannot overwrite it), then asks the shell to open the
 * item the one sanctioned way — ycLauncher.exec('moreFormBuilder') — which
 * picks the page, opens it and shows the panel there, and never toggles an
 * open panel shut. Before S6c-4 it clicked "the first
 * .big-button[data-target=formBuilderDiv]" and, failing that, swapped panel
 * displays by hand: with a firm layout able to place the tile on any page,
 * the first tile could drive a page the user is not on, and the hand-made
 * swap bypassed the stage. The function's own text is pinned free of both.
 *
 * The REAL function (extracted from the page) runs in jsdom with `P` (the
 * pane's window.top) replaced by a fake shell: a document holding the
 * builder's panel + iframe, a recording ycLauncher, and a toast recorder.
 *
 * Mutation-checked (see local/ui-custom/S6c4_worker_report.md).
 *
 * Run:  npx jest tests/formBuilderSimpleHandoff.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/formBuilderSimple.html'), 'utf8');

function fnSrc(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}
const OPEN = fnSrc(SRC, 'openFullBuilder');
const OPEN_LIST = fnSrc(SRC, 'openFullBuilderList');

function host({ exec = () => true, launcher = true, dataSrc = true, panel = true } = {}) {
  const shell = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="tabMore" class="tab-main"><button class="big-button" data-target="formSimpleDiv" data-exclusive-group="more">Simple</button>
      <button class="big-button" data-target="formBuilderDiv" data-exclusive-group="more">Builder</button></div>
    <div id="ycPanels">
      <div id="formSimpleDiv" class="more-panel"><iframe id="simpleFrame"></iframe></div>
      ${panel ? `<div id="formBuilderDiv" class="more-panel" style="display:none"><iframe id="builderFrame" ${dataSrc ? 'data-src="/formBuilder.html"' : 'src="/formBuilder.html"'}></iframe></div>` : ''}
    </div></body></html>`, { url: 'https://app.4lsg.com/' });
  const calls = [];
  const P = { document: shell.window.document, getComputedStyle: shell.window.getComputedStyle.bind(shell.window) };
  if (launcher) P.ycLauncher = { exec: (...a) => { calls.push(['exec', ...a]); return exec(...a); } };
  const pane = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://app.4lsg.com/formBuilderSimple.html' });
  const w = pane.window;
  w.__P = P;
  w.__calls = calls;
  w.eval(`const P = window.__P;\nfunction toast(msg, icon) { __calls.push(['toast', msg, icon]); }\n${OPEN}\n${OPEN_LIST}`);
  const builder = () => shell.window.document.getElementById('builderFrame');
  const panelEl = () => shell.window.document.getElementById('formBuilderDiv');
  return { w, calls, builder, panelEl, close: () => { pane.window.close(); shell.window.close(); } };
}

describe('Simple Forms → Form Builder: through ycLauncher.exec, src first', () => {
  test('the src is set to the template (data-src dropped), then exec(\'moreFormBuilder\') runs once; no toast; the panel is left to the shell', () => {
    const h = host();
    try {
      h.w.openFullBuilder('tpl 42');
      expect(h.builder().getAttribute('src')).toBe('/formBuilder.html?id=tpl%2042');
      expect(h.builder().hasAttribute('data-src')).toBe(false);
      expect(h.calls).toEqual([['exec', 'moreFormBuilder']]);
      expect(h.panelEl().style.display).toBe('none');   // exec's job (the stage), not the pane's
    } finally { h.close(); }
  });

  test('the list variant: no id → the bare builder, same exec', () => {
    const h = host();
    try {
      h.w.openFullBuilderList();
      expect(h.builder().getAttribute('src')).toBe('/formBuilder.html');
      expect(h.calls).toEqual([['exec', 'moreFormBuilder']]);
    } finally { h.close(); }
  });

  test('the src is set BEFORE exec (a lazy load must not overwrite it): exec sees the new src and no data-src', () => {
    let seen = null;
    const h = host({ exec: () => { seen = [h.builder().getAttribute('src'), h.builder().hasAttribute('data-src')]; return true; } });
    try {
      h.w.openFullBuilder('x');
      expect(seen).toEqual(['/formBuilder.html?id=x', false]);
    } finally { h.close(); }
  });

  test('exec refuses (false): one info toast saying the builder is not available to them (never a tile they cannot see), with the id; nothing is swapped by hand', () => {
    const h = host({ exec: () => false });
    try {
      h.w.openFullBuilder('7');
      const toasts = h.calls.filter((c) => c[0] === 'toast');
      expect(toasts).toHaveLength(1);
      expect(toasts[0][1]).toMatch(/not available to you \(form id 7\)/);
      expect(toasts[0][1]).not.toMatch(/More Features/);
      expect(toasts[0][2]).toBe('info');
      expect(h.panelEl().style.display).toBe('none');
      expect(h.builder().getAttribute('src')).toBe('/formBuilder.html?id=7');   // the src is still staged
      h.w.openFullBuilderList();
      expect(h.calls.filter((c) => c[0] === 'toast')[1][1]).toMatch(/not available to you — ask an admin\.$/);
    } finally { h.close(); }
  });

  test('no launcher at all (the page outside the shell): one info toast naming the way there, with the id', () => {
    const h = host({ launcher: false });
    try {
      h.w.openFullBuilder('7');
      const toasts = h.calls.filter((c) => c[0] === 'toast');
      expect(toasts).toHaveLength(1);
      expect(toasts[0][1]).toMatch(/More Features → Form Builder/);
      expect(toasts[0][1]).toMatch(/\(id 7\)/);
      expect(h.panelEl().style.display).toBe('none');
      h.w.openFullBuilderList();
      expect(h.calls.filter((c) => c[0] === 'toast')[1][1]).toMatch(/Form Builder”\.$/);
    } finally { h.close(); }
  });

  test('no panel in the shell at all: exec is still asked (the shell decides); a refusal toasts', () => {
    const h = host({ panel: false, exec: () => false });
    try {
      h.w.openFullBuilder('9');
      expect(h.calls.map((c) => c[0])).toEqual(['exec', 'toast']);
    } finally { h.close(); }
  });

  test('the function text: no tile click, no hand-made panel swap by exclusive group', () => {
    expect(OPEN).not.toMatch(/data-exclusive-group/);
    expect(OPEN).not.toMatch(/\.click\(\)/);
    expect(OPEN).not.toMatch(/\.style\.display\s*=/);
    expect(OPEN).toMatch(/exec\('moreFormBuilder'\)/);
    // the page's own comment no longer claims the DOM-parent rule the old hand-off relied on
    expect(SRC).not.toMatch(/DIRECT child of the shell/);
  });
});
