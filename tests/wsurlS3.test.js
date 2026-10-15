/**
 * wsurl S3 — comms.html remembers its tab (email / phone / team) in the
 * shell's workspace URL: ?open=tabComms~phone.
 *
 * The REAL comms.html code, extracted from the shipped file (the fnSrc
 * pattern of tests/unifiedEventsU9.shell.test.js): showTab, announceTab and
 * the boot restore block at the end of init's wiring. It runs inside a REAL
 * jsdom iframe under a stub shell window, with the real public/js/ycSubTab.js,
 * so the leaf's parent.ycReportSubTab(frameElement, …) / ycTakeSubTab are
 * exercised for real. Only collaborators are stubbed: phoneBoot and `ph`.
 *
 * The shell side (wsMainRest, the hold at openMainTabOnBoot) is S1a's; the
 * round trips through the real shell are scripts/mobile-survey/wsurl.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'public/js/ycSubTab.js'), 'utf8');
const COMMS = fs.readFileSync(path.join(ROOT, 'public/comms.html'), 'utf8');

function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let paren = 0;
  for (let j = m.index + m[0].length - 1; j < src.length; j++) {
    if (src[j] === '(') paren++;
    else if (src[j] === ')' && --paren === 0) { i = src.indexOf('{', j); break; }
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

const RESTORE_START = '// The workspace URL (wsurl S3): reopen the tab the shell handed down';
const RESTORE_END = '} catch (_) { /* stay on Email */ }';
function restoreSrc() {
  const i = COMMS.indexOf(RESTORE_START);
  if (i < 0) throw new Error('restore block not found');
  return COMMS.slice(i, COMMS.indexOf(RESTORE_END, i) + RESTORE_END.length);
}

const DOM = `<button id="tab-email" class="tab on" aria-selected="true"></button>
  <button id="tab-phone" class="tab" aria-selected="false"></button>
  <button id="tab-team" class="tab" aria-selected="false"></button>
  <div id="email"></div><div id="phone" hidden></div><div id="team" hidden></div>`;

/** comms' code in a real frame of a stub shell holding `held` for it. */
function framed({ held = null, framedPage = true } = {}) {
  const shell = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }).window;
  let w, frame = null;
  if (framedPage) {
    frame = shell.document.createElement('iframe');
    shell.document.body.appendChild(frame);
    w = frame.contentWindow;
  } else {
    w = shell;
  }
  const reports = [];
  let pending = held;
  const host = framedPage ? shell : w;
  host.ycReportSubTab = (f, r) => reports.push([f === frame, r]);
  host.ycTakeSubTab = (f) => { const r = f === frame ? pending : null; pending = null; return r; };
  w.document.body.innerHTML = DOM;
  w.eval(MODULE);
  w.__events = [];
  w.__boots = 0;
  w.document.addEventListener('comms-tab', (e) => w.__events.push(e.detail.tab));
  w.eval(`
    var E = (id) => document.getElementById(id);
    var ph = { booted: false };
    function phoneBoot() { ph.booted = true; window.__boots++; }
    ${fnSrc(COMMS, 'showTab')}
    ${fnSrc(COMMS, 'announceTab')}
    function runRestore() { ${restoreSrc()} }
  `);
  const on = () => ['email', 'phone', 'team'].find((k) => w.document.getElementById('tab-' + k).classList.contains('on'));
  return { w, reports, on, shell };
}

describe('wsurl S3 — showTab reports its tab', () => {
  test('phone / team report their token; email (the default) reports ""', () => {
    const { w, reports } = framed();
    w.showTab('phone');
    w.showTab('team');
    w.showTab('email');
    expect(reports).toEqual([[true, 'phone'], [true, 'team'], [true, '']]);
    expect(w.__events).toEqual(['phone', 'team', 'email']);   // the existing comms-tab event, unchanged
  });

  test('unframed: nothing is reported, nothing throws', () => {
    const { w, reports } = framed({ framedPage: false });
    expect(() => w.showTab('phone')).not.toThrow();
    expect(reports).toEqual([]);
  });
});

describe('wsurl S3 — the boot restore', () => {
  test.each([['phone'], ['phone~x~y'], ['team']])('held %j → showTab(that tab): it shows, Phone boots, one report', (held) => {
    const { w, reports, on } = framed({ held });
    w.runRestore();
    const tab = held.split('~')[0];
    expect(on()).toBe(tab);
    expect(w.document.getElementById('tab-' + tab).getAttribute('aria-selected')).toBe('true');
    expect(w.__events).toEqual([tab]);
    expect(w.__boots).toBe(tab === 'phone' ? 1 : 0);
    expect(reports).toEqual([[true, tab]]);
  });

  test.each([['email'], ['bogus'], ['x"><img id=pwn>']])('held %j → NO showTab, Email stays, reports "" exactly once', (held) => {
    const { w, reports, on } = framed({ held });
    w.runRestore();
    expect(on()).toBe('email');
    expect(w.__events).toEqual([]);
    expect(w.__boots).toBe(0);
    expect(reports).toEqual([[true, '']]);
    expect(w.document.getElementById('pwn')).toBeNull();
  });

  test.each([[''], [null]])('held %j → nothing at all (no report, no event)', (held) => {
    const { w, reports, on } = framed({ held });
    w.runRestore();
    expect(on()).toBe('email');
    expect([w.__events, reports]).toEqual([[], []]);
  });

  test('take() is once: a second run finds nothing', () => {
    const { w, reports } = framed({ held: 'phone' });
    w.runRestore();
    w.runRestore();
    expect(reports).toEqual([[true, 'phone']]);
  });

  test('a throwing host leaves Email and never throws', () => {
    const { w, shell, on } = framed({ held: 'phone' });
    shell.ycTakeSubTab = () => { throw new Error('boom'); };
    expect(() => w.runRestore()).not.toThrow();
    expect(on()).toBe('email');
  });

  test('order: the restore runs at the END of init\'s wiring, before the first await', () => {
    const init = fnSrc(COMMS, 'init');
    const at = (n) => { const i = init.indexOf(n); expect([n, i >= 0]).toEqual([n, true]); return i; };
    const restore = at(RESTORE_START);
    expect(at('wirePhone();') < restore).toBe(true);              // the tab buttons' listeners
    expect(at("announceTab('email');") < restore).toBe(true);     // the markup's default, announced first
    expect(at("document.addEventListener('keydown'") < restore).toBe(true);   // the last of the wiring
    expect(restore < at('await Promise.allSettled([loadSummary(), loadViews()])')).toBe(true);
    // and it restores ONLY through showTab, never by toggling classes itself
    expect(restoreSrc()).not.toMatch(/classList|aria-selected|\.hidden/);
  });

  test('comms.html loads /js/ycSubTab.js', () => {
    expect(COMMS).toMatch(/<script src="\/js\/ycSubTab\.js"><\/script>/);
  });
});
