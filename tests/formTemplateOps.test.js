'use strict';
/**
 * tests/formTemplateOps.test.js
 *
 * public/js/formTemplateOps.js — the form template DRAFT operations behind the
 * Ask Casey field-level template cards, ONE pure module the server requires
 * (services/assistantService.js) and the page loads (public/assistant.html).
 * A12Y (Fred, 2026-11-16, "cards carry the change, not the result"): a card
 * carries the operation and the SHA-256 of the canonical result; the click
 * re-applies the operation with these functions and sends the result only
 * when its hash equals the reviewed one. That only holds if (1) the module is
 * the same code on both sides — pure, loadable in a bare vm with no require /
 * process / window — and (2) both sides hash the same canonical text.
 *
 * Pinned here:
 *   1. the file compiles (the node --check of the gate) and loads in a bare vm
 *      context with no require, process, module or window — and the source
 *      never names them beyond the UMD export lines;
 *   2. canonical: key-order-insensitive, nested, arrays, unicode, undefined →
 *      null; the server's sha256 of it and the page's formDataHash (lifted
 *      from assistant.html, run on this module) give the same hex;
 *   3. apply: each kind yields the documented result, never mutates its
 *      inputs, and an unknown kind refuses; refusals carry code
 *      FORM_TEMPLATE_OP (the normalizer wraps them as its 422 — their texts are
 *      pinned by tests/caseyFormTemplates.test.js).
 *
 *   npx jest tests/formTemplateOps.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'public', 'js', 'formTemplateOps.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const ops = require(FILE);
const html = fs.readFileSync(path.join(ROOT, 'public', 'assistant.html'), 'utf8');

const DRAFT = {
  code: 'x()',
  sections: [
    { title: 'Case', rows: [{ fields: [{ name: 'trustee', type: 'text', label: 'Trustee' }, { name: 'chapter', type: 'select', label: 'Chapter', options: ['7', '13'] }] }] },
    { repeater: 'creditors', fields: [{ name: 'creditor', type: 'text', label: 'Creditor' }] },
  ],
};
const NAME = '"Case Sheet" (case_sheet, template #12)';
const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

describe('formTemplateOps is pure and loads anywhere', () => {
  test('compiles, loads in a bare vm context (no require / process / module / window) and exports the operations', () => {
    expect(() => new vm.Script(SRC, { filename: FILE })).not.toThrow();
    const ctx = vm.createContext({});
    vm.runInContext(SRC, ctx, { filename: FILE });
    expect(Object.keys(ctx)).toEqual(['YCFormTemplateOps']);
    const api = ctx.YCFormTemplateOps;
    expect(Object.keys(api).sort()).toEqual(['apply', 'canonical', 'createDefinition', 'fieldAdd', 'fieldRemove', 'fieldUpdate', 'locate', 'references', 'sectionLabel', 'sectionRef', 'sections']);
    // The vm copy does the same work as the Node copy: same canonical text, same result.
    expect(api.canonical({ b: [1, { d: 2, c: null }], a: 'é' })).toBe(ops.canonical({ a: 'é', b: [1, { c: null, d: 2 }] }));
    expect(api.apply('form.template.field.remove.v1', DRAFT, { field_name: 'chapter' }, NAME)).toEqual(ops.apply('form.template.field.remove.v1', DRAFT, { field_name: 'chapter' }, NAME));
    // The browser-side global and the CommonJS export are the same object.
    expect(require(FILE)).toBe(globalThis.YCFormTemplateOps);
  });

  test('the source names no host API: no require, process, document, fetch, XMLHttpRequest, setTimeout or Date', () => {
    const body = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const word of ['require', 'process', 'document', 'fetch', 'XMLHttpRequest', 'setTimeout', 'Date', 'Math.random', 'crypto']) {
      expect({ word, found: new RegExp(`\\b${word.replace('.', '\\.')}\\b`).test(body) }).toEqual({ word, found: false });
    }
    // `window` and `module` appear only in the two UMD lines.
    expect(body.match(/\bwindow\b/g).length).toBe(4);
    expect(body.match(/\bmodule\b/g).length).toBe(3);
  });
});

describe('canonical and the hash the two sides share', () => {
  const A = { z: [3, { y: 'Débiteur — ✓ 日本', x: [true, null, 'a"b\\c'] }], a: { n: 1.5, m: -0, k: undefined, nul: null, j: 'line\nbreak' }, '': 'empty key', '日': 1 };
  const B = { '日': 1, '': 'empty key', a: { j: 'line\nbreak', nul: null, k: undefined, m: -0, n: 1.5 }, z: [3, { x: [true, null, 'a"b\\c'], y: 'Débiteur — ✓ 日本' }] };

  test('a key holding null is part of the shape: {a:null} and {} never hash alike (a dropped key would make the drift check blind to it)', () => {
    expect(ops.canonical({ a: null })).toBe('{"a":null}');
    expect(ops.canonical({ a: null })).not.toBe(ops.canonical({}));
    expect(ops.canonical({ s: [{ a: null, b: 1 }] })).not.toBe(ops.canonical({ s: [{ b: 1 }] }));
  });

  test('key order never matters; arrays keep theirs; undefined reads as null; unicode is kept as is', () => {
    expect(ops.canonical(A)).toBe(ops.canonical(B));
    expect(ops.canonical([1, 2])).not.toBe(ops.canonical([2, 1]));
    expect(ops.canonical({ k: undefined })).toBe('{"k":null}');
    expect(ops.canonical(undefined)).toBe('null');
    expect(ops.canonical('日本')).toBe('"日本"');
    expect(ops.canonical(A)).toBe('{"":"empty key","a":{"j":"line\\nbreak","k":null,"m":0,"n":1.5,"nul":null},"z":[3,{"x":[true,null,"a\\"b\\\\c"],"y":"Débiteur — ✓ 日本"}],"日":1}');
  });

  test('the page\'s formDataHash (assistant.html, run on this module) equals the server\'s sha256 of canonical — one fixture, one hex', async () => {
    const lift = (name) => {
      const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
      let depth = 0;
      for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
      }
      throw new Error(`${name} unbalanced`);
    };
    const page = new Function('YCFormTemplateOps', 'crypto', 'TextEncoder', `${lift('formCanonical')}\n${lift('formDataHash')}\nreturn { formCanonical, formDataHash };`)(ops, crypto.webcrypto, TextEncoder); // eslint-disable-line no-new-func
    expect(page.formCanonical(A)).toBe(ops.canonical(B));
    const hex = await page.formDataHash(A);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(hex).toBe(sha(ops.canonical(B)));
    // The page delegates to the module (one implementation) — not a copy.
    expect(lift('formCanonical')).toContain('return YCFormTemplateOps.canonical(value);');
  });
});

describe('apply', () => {
  const frozen = JSON.stringify(DRAFT);
  afterEach(() => { expect(JSON.stringify(DRAFT)).toBe(frozen); }); // inputs are never mutated

  test('field add: a new row at the end, right after a field, a repeater\'s row list; the section by path or title; authored keys untouched', () => {
    const op = { section: 'sections[0]', field: { name: 'judge', type: 'text', label: 'Judge' }, after: null };
    const next = ops.apply('form.template.field.add.v1', DRAFT, op, NAME);
    expect(next.sections[0].rows.map((r) => r.fields.map((f) => f.name))).toEqual([['trustee', 'chapter'], ['judge']]);
    expect(next.code).toBe('x()');
    expect(ops.apply('form.template.field.add.v1', DRAFT, { ...op, section: 'case', after: 'trustee' }, NAME).sections[0].rows[0].fields.map((f) => f.name)).toEqual(['trustee', 'judge', 'chapter']);
    expect(ops.apply('form.template.field.add.v1', DRAFT, { section: 'creditors', field: { name: 'amount', type: 'number', label: 'Amount' } }, NAME).sections[1].fields.map((f) => f.name)).toEqual(['creditor', 'amount']);
    const r = ops.fieldAdd(DRAFT, op, NAME);
    expect([r.key, r.placed, r.after, r.repeater, r.target.path]).toEqual(['judge', 'a new row (row 2) at the end of section "Case"', null, null, 'sections[0]']);
    expect(r.field).not.toBe(op.field);
  });

  test('field update: sets keys, null drops, nothing to change; field remove: the field goes, its row stays; the references scan', () => {
    const upd = ops.fieldUpdate(DRAFT, { field_name: 'chapter', changes: { required: true, options: null, label: 'Chapter filed' } }, NAME);
    expect([upd.set, upd.dropped, upd.next.sections[0].rows[0].fields[1]]).toEqual([['required', 'label'], ['options'], { name: 'chapter', type: 'select', label: 'Chapter filed', required: true }]);
    expect(() => ops.fieldUpdate(DRAFT, { field_name: 'chapter', changes: { nope: null } }, NAME)).toThrow('NOTHING TO CHANGE: changes drops keys "chapter" does not have');
    const rem = ops.fieldRemove(DRAFT, { field_name: 'trustee' }, NAME);
    expect(rem.next.sections[0].rows.map((r) => r.fields.map((f) => f.name))).toEqual([['chapter']]);
    expect(rem.loc.path).toBe('sections[0].rows[0].fields[0]');
    const REF = JSON.parse(frozen); REF.sections[0].rows[0].fields[1].showWhen = { field: 'trustee', op: 'notEmpty' }; REF.derive = [{ target: 'x', from: 'trustee' }];
    expect(ops.references(REF, 'trustee')).toEqual(['sections[0].rows[0].fields[1].showWhen', 'derive[0]']);
    expect(() => ops.fieldRemove(REF, { field_name: 'trustee' }, NAME)).toThrow(/^STILL REFERENCED refused: sections\[0\]\.rows\[0\]\.fields\[1\]\.showWhen, derive\[0\] name "trustee"/);
    expect(() => ops.fieldRemove(DRAFT, { field_name: 'creditors.creditor' }, NAME)).toThrow(/^LAST ROW FIELD refused/);
    expect(() => ops.fieldRemove(DRAFT, { field_name: 'creditors' }, NAME)).toThrow(/^REPEATER refused: "creditors" is a repeater section of "Case Sheet" \(case_sheet, template #12\)/);
  });

  test('create builds ONE section, one row per field; an unknown kind and every refusal carry code FORM_TEMPLATE_OP', () => {
    const fields = [{ name: 'a', type: 'text', label: 'A' }, { name: 'b', type: 'number', label: 'B' }];
    const def = ops.apply('form.template.create.v1', null, { fields }, NAME);
    expect(def).toEqual({ sections: [{ title: 'Section 1', rows: [{ fields: [fields[0]] }, { fields: [fields[1]] }] }] });
    expect(def.sections[0].rows[0].fields[0]).not.toBe(fields[0]);
    const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no throw'; };
    expect(code(() => ops.apply('form.template.publish.v1', DRAFT, {}, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.sectionRef(ops.sections(DRAFT), 'Nope', NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.sectionRef(ops.sections(DRAFT), undefined, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.fieldAdd(DRAFT, { section: 'Case', field: { name: 'trustee', type: 'text', label: 'T' } }, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.fieldAdd(DRAFT, { section: 'Case', field: { name: 'n', type: 'text', label: 'N' }, after: 'zzz' }, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.fieldAdd({ sections: [] }, { field: { name: 'n', type: 'text', label: 'N' } }, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.fieldUpdate(DRAFT, { field_name: 'zzz', changes: { label: 'x' } }, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.fieldRemove(DRAFT, { field_name: 'zzz' }, NAME))).toBe('FORM_TEMPLATE_OP');
    expect(code(() => ops.createDefinition('nope'))).toBe('FORM_TEMPLATE_OP');
  });
});
