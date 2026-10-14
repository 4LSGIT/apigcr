/**
 * The S0 evaluation review page (scripts/commsArchive/eval/review-tool.html — an
 * Admin → Tools page): static gates. Transcripts are call content, so the page
 * renders with textContent only; its script must parse; every API path it calls
 * must be a route of routes/api.commsEval.js; and it carries no data of its own.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'commsArchive', 'eval', 'review-tool.html'), 'utf8');
const SCRIPT = (PAGE.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';

describe('comms eval review page', () => {
  test('no HTML-writing sinks anywhere (textContent only)', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect([sink, PAGE.includes(sink)]).toEqual([sink, false]);
    }
  });

  test('its script parses', () => {
    expect(SCRIPT.length).toBeGreaterThan(1000);
    expect(() => new vm.Script(SCRIPT)).not.toThrow();
  });

  test('every API path it calls is a route of api.commsEval.js, and it calls no other API', () => {
    const called = [...SCRIPT.matchAll(/'(\/api\/[^']*)'/g)].map(m => m[1]);
    expect(called.length).toBeGreaterThanOrEqual(5);
    for (const p of called) expect(p.startsWith('/api/comms-eval/')).toBe(true);
    const router = require('../routes/api.commsEval');
    const routes = router.stack.filter(l => l.route).map(l => l.route.path);
    const asRoute = (p) => p.replace(/\/$/, '');
    const prefixes = called.map(asRoute);
    for (const p of prefixes) expect(routes.some(r => r === p || r.startsWith(p + '/:id') || r.startsWith(p))).toBe(true);
  });

  test('no data baked in: no phone numbers, no media ids, no storage URLs', () => {
    expect(PAGE).not.toMatch(/\b\d{10}\b/);
    expect(PAGE).not.toMatch(/storage\.googleapis|phone\/rec\//);
  });

  test('R8: the transcript carries the ratified AI label; speakers are marked inferred', () => {
    expect(PAGE).toContain('AI-generated — check the recording before relying on it.');
    expect(PAGE).toMatch(/Speaker letters \(A, B…\) are inferred/);
    expect(SCRIPT).toMatch(/title: 'inferred speaker'/);
  });

  test('a late answer for another call is dropped: every item request checks still(id) after it returns', () => {
    for (const fn of ['loadAudio', 'saveNoise', 'loadTranscript', 'saveScores']) {
      const body = SCRIPT.split('async function ' + fn + '(')[1].split('\n  }\n')[0];
      expect([fn, /const id = cur\.id/.test(body), /if \(!still\(id\)\) return;/.test(body)]).toEqual([fn, true, true]);
    }
    const open = SCRIPT.split('async function openItem(')[1].split('\n  }\n')[0];
    expect(open).toMatch(/if \(!still\(it\.id\)\) return;/);
  });

  test('A3: the page offers exactly the choices the server accepts (no typing anywhere)', () => {
    const lit = SCRIPT.split('const QUESTIONS = ')[1].split('];')[0] + ']';
    const QUESTIONS = vm.runInNewContext(lit);
    const { ENUMS, REQUIRED_FOR_COMPLETE } = require('../services/commsEvalService');
    const byKey = Object.fromEntries(QUESTIONS.map(x => [x.k, x]));
    for (const [k, allowed] of Object.entries(ENUMS)) expect([k, byKey[k] && byKey[k].o.map(o => o[0])]).toEqual([k, allowed]);
    expect(byKey.accuracy.o.map(o => o[0])).toEqual([1, 2, 3, 4, 5]);
    expect(Object.keys(byKey).sort()).toEqual(['accuracy', ...Object.keys(ENUMS)].sort());
    expect(QUESTIONS.filter(x => x.req).map(x => x.k).sort()).toEqual([...REQUIRED_FOR_COMPLETE].sort());
    expect(PAGE).not.toMatch(/<input[^>]+type="(number|text)"|<textarea/);
  });

  test('Fred\'s fixes: saved answers shown on reopen; concrete speaker question; a complete save returns to the list', () => {
    expect(SCRIPT).toMatch(/if \(t\.transcript_opened\) renderForm\(\);/);           // the verdict card from the saved review at once
    expect(SCRIPT).toMatch(/function showSaved\(saved\)/);
    expect(SCRIPT).toContain("Speaker labels: are the right words attributed to the right person?");
    const save = SCRIPT.split('async function saveScores(')[1].split('\n  }\n')[0];
    expect(save).toMatch(/if \(!missing\.length\) \{ backToList\(\);/);
    expect(save).not.toMatch(/if \(missing\.length\) \{ backToList/);
  });

  test('it only runs inside the shell (waits for the parent apiSend)', () => {
    expect(SCRIPT).toMatch(/P !== window && typeof P\.apiSend === 'function'/);
  });
});
