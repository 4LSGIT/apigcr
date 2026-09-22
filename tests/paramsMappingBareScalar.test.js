// tests/paramsMappingBareScalar.test.js
//
// Trigger rule 19 postmortem (2026-09-22).
//
// Rule 19's create_task action was authored with JSON numbers:
//     "assigned_to": 22, "assigned_by": 0
// A later UI save (adding two send_email actions) re-collected every action
// through public/automation/paramsMapping.js. pmRender painted 22 as the text
// "22"; pmCollect handed back the STRING "22" — which resolveParamsMapping
// treats as a dot-path lookup of a key named "22" → undefined → every later
// fire failed "create_task requires assigned_to" while the rule's two emails
// still went out (execution status 'partial', easy to miss).
//
// Two halves, both covered here:
//   1. UI   — pmCollect is now the inverse of pmRender's _display: a bare JSON
//             scalar / object / array cell collects as that JSON value.
//   2. API  — __validateParamsMapping rejects bare-scalar STRINGS at save time
//             on every params_mapping surface, so an API-authored config can't
//             ship the same silent break.
//
// Run:
//   npx jest tests/paramsMappingBareScalar.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const internalFunctions = require('../lib/internal_functions');
const { resolveParamsMapping } = require('../lib/actionDispatchers');
const validate = internalFunctions.__validateParamsMapping;

const PM_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'automation', 'paramsMapping.js'), 'utf8'
);

function bootPm() {
  const dom = new JSDOM('<!doctype html><div id="pm"></div>', { runScripts: 'outside-only' });
  dom.window.eval(PM_SRC);
  return { win: dom.window, el: dom.window.document.getElementById('pm') };
}

// The exact action-50 mapping as ORIGINALLY authored (action 40, pre-resave).
const RULE19_AUTHORED = {
  title: 'title',
  source: "'case_filed'",
  link_id: 'case_id',
  link_type: "'case'",
  dedupe_key: 'dedupe_key',
  assigned_by: 0,
  assigned_to: 22,
  description: 'description',
};

// ─────────────────────────────────────────────────────────────
// 1. UI round trip
// ─────────────────────────────────────────────────────────────

describe('paramsMapping.js — render → collect is lossless', () => {
  test('rule 19 mapping survives a re-save byte-for-byte', () => {
    const { win, el } = bootPm();
    win.pmRender(el, RULE19_AUTHORED, {});
    expect(win.pmCollect(el)).toEqual(RULE19_AUTHORED);
  });

  test('...and still dispatches assigned_to = 22 after the re-save', () => {
    const { win, el } = bootPm();
    win.pmRender(el, RULE19_AUTHORED, {});
    const resaved = win.pmCollect(el);
    const params = resolveParamsMapping(resaved, { case_id: 'Iv6kDE7c', title: 't' });
    expect(params.assigned_to).toBe(22);
    expect(params.assigned_by).toBe(0);
    expect(params.link_id).toBe('Iv6kDE7c');
  });

  test('booleans, null, objects and arrays round-trip as JSON values', () => {
    const { win, el } = bootPm();
    const m = { notify: false, on: true, obj: { a: 1 }, arr: [1, 'x'], neg: -3.5 };
    win.pmRender(el, m, {});
    expect(win.pmCollect(el)).toEqual(m);
  });

  test('typing a bare number into a fresh row collects a number', () => {
    const { win, el } = bootPm();
    win.pmRender(el, {}, {});
    const row = el.querySelector(':scope > div');
    row.querySelector('.pm-key').value = 'assigned_to';
    row.querySelector('.pm-val').value = ' 22 ';
    expect(win.pmCollect(el)).toEqual({ assigned_to: 22 });
  });

  test('strings are untouched: dot-paths, quoted literals, $, leading zeros, bad JSON', () => {
    const { win, el } = bootPm();
    const m = {
      a: 'case_id',
      b: 'data.stage_key',
      c: "'22'",
      d: '$',
      e: '007',
      f: '{not json}',
      g: "' padded '",
      h: 'truex',
    };
    win.pmRender(el, m, {});
    expect(win.pmCollect(el)).toEqual(m);
  });

  test('blank-value rows are still dropped', () => {
    const { win, el } = bootPm();
    win.pmRender(el, { a: 'x', b: '' }, {});
    expect(win.pmCollect(el)).toEqual({ a: 'x' });
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Save-time guard
// ─────────────────────────────────────────────────────────────

describe('__validateParamsMapping — rejects bare-scalar strings', () => {
  test('the shipped rule-19 value is rejected, naming the param', () => {
    const r = validate('create_task', { title: 'title', assigned_to: '22', assigned_by: '0' });
    expect(r).not.toBeNull();
    expect(r.status).toBe(400);
    expect(r.param).toBe('assigned_to');
    expect(r.error).toContain("'22'");
  });

  test.each(['0', '22', '-1', '1.5', 'true', 'false', 'null', ' 22 ', '007'])(
    '%p is rejected', (v) => {
      expect(validate('create_task', { assigned_to: v })).not.toBeNull();
    }
  );

  test('applies to meta-less / unregistered functions too', () => {
    expect(validate('no_such_fn', { x: '5' })).not.toBeNull();
  });

  test.each([
    ['JSON number', 22],
    ['JSON zero', 0],
    ['JSON false', false],
    ['quoted literal', "'22'"],
    ['dot-path', 'case_id'],
    ['nested dot-path', 'data.stage_key'],
    ['whole object', '$'],
    ['mixed text', 'task22'],
  ])('%s is accepted', (_label, v) => {
    expect(validate('create_task', { assigned_to: v })).toBeNull();
  });

  test('every live-shaped mapping from the 2026-09-22 sweep except the broken one passes', () => {
    // actions 37/49 (rules 16/22) and email-ingest action 25 — numbers stored as numbers
    expect(validate('create_task', { assigned_to: 22, assigned_by: 0, title: 'title' })).toBeNull();
    expect(validate('create_task', { notify: false, assigned_to: 22, assigned_by: 0 })).toBeNull();
  });
});
