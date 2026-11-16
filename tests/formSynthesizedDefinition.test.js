/**
 * formService.synthesizeDefinition — step 4 of getSubmissionForRender
 * (2026-11-16). A submission under a form_key with no definition anywhere
 * (the hand-built pages: contact-form.html's contact_info; issn.html until
 * template 7 was published) is drawn from a definition built out of its own
 * data, so View / PDF / File work instead of 404ing.
 *
 * Locks:
 *   - every output is a definition the builder itself accepts
 *     (formTemplateService.validateDefinition) — the guarantee that
 *     render.html and formPdfService need no special case;
 *   - the value → field-type map, the id omission, the masks;
 *   - the layout: sorted, two narrow fields per row, wide fields alone,
 *     repeaters after the answers;
 *   - data: the same object back unless a field cannot carry a value as-is;
 *     the input is never mutated; renamed keys / colliding repeater children
 *     / JSON-shown values;
 *   - the PDF prints it under the synthesized note, not the schema note.
 *
 * Fixtures are shaped on the live rows (2026-11-16): 153 contact_info + issn
 * submissions all validated and printed every non-id answer.
 *
 *   npx jest tests/formSynthesizedDefinition.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { synthesizeDefinition } = require(path.join(ROOT, 'services', 'formService'));
const { validateDefinition } = require(path.join(ROOT, 'services', 'formTemplateService'));
const formPdfService = require(path.join(ROOT, 'services', 'formPdfService'));

const clone = (o) => JSON.parse(JSON.stringify(o));
const allFields = (def) => def.sections.flatMap((s) => s.fields || s.rows.flatMap((r) => r.fields));
const byName = (def, name) => allFields(def).find((f) => f.name === name);

// contact_info, a newer row: flat scalars + three repeaters of objects with
// booleans — plus the legacy flat `city` / `notes` that collide with
// repeater children.
const CONTACT = {
  contact_id: '1309',
  fname: 'Dana', mname: '', lname: 'Debtor', pname: '', dob: '1980-02-03',
  ssn: '123456789', tags: '', contact_notes: 'Prefers text.\nCall after 5.',
  city: 'Southfield', notes: 'legacy flat note',
  phones: [{ id: '77', phone: '2485551212', label: 'Cell', notes: '', verified: true, is_primary: true, sms_optout: false, mms_capable: true }],
  addresses: [{ id: '5', address1: '1 Main St', address2: '', city: 'Detroit', state: 'MI', zip: '48201', country: 'US', label: 'Home', notes: 'side door', verified: false, is_primary: true }],
  emails: [],
};

// issn: top-level scalars, a repeater, comma-string checkgroups.
const ISSN = {
  case_id: 'DZ8G0HYT', client_id: '2210', cd_contact_id: '',
  client_name: 'Dawn Sims', client_phone: '2489792561', client_zip: '48075',
  marital_status: 'Married', prior_bankruptcy: 'Yes', debt_type: 'Medical,Credit cards',
  basic_info_notes: 'x'.repeat(140),
  prior_bankruptcies: [{ note: '', case_no: '', date_filed: '2018-06-29' }],
  vehicles: [], lawsuits: [],
};

describe('every output is a definition the builder accepts', () => {
  const cases = {
    contact: CONTACT,
    issn: ISSN,
    mixed: { a: 1, b: null, c: true, d: ['x', 2, false], e: { k: 'v' }, f: [1, { g: 2 }], 'bad key': 'v', [`${'z'.repeat(51)}`]: 'long' },
    empty: {},
    onlyIds: { id: '1', case_id: 'C' },
    notAnObject: 'nope',
  };
  for (const [label, data] of Object.entries(cases)) {
    test(label, () => {
      const { definition } = synthesizeDefinition(data);
      expect(() => validateDefinition(clone(definition))).not.toThrow();
    });
  }
});

describe('value → field type', () => {
  const { definition, data } = synthesizeDefinition({
    short: 'abc', multi: 'a\nb', long: 'y'.repeat(101), edge: 'y'.repeat(100),
    num: 42, nil: null, flag: false,
    picks: ['A', 'B', 'A', ''], nums: [3, 1], blanks: ['', ''], none: [],
    obj: { k: 'v' }, mixed: ['a', { b: 1 }],
    kids: [{ id: '9', name: 'Kid', ok: true, age: 4 }, { name: 'Kid2', ok: null }],
  });
  test.each([
    ['short', 'text'], ['multi', 'textarea'], ['long', 'textarea'], ['edge', 'text'],
    ['num', 'text'], ['nil', 'text'], ['flag', 'checkbox'],
    ['picks', 'checkgroup'], ['nums', 'checkgroup'], ['blanks', 'text'], ['none', 'text'],
    ['obj', 'textarea'], ['mixed', 'textarea'],
  ])('%s → %s', (name, type) => {
    expect(byName(definition, name).type).toBe(type);
  });
  test('checkgroup options are its own distinct non-blank values, as strings', () => {
    expect(byName(definition, 'picks').options).toEqual(['A', 'B']);
    expect(byName(definition, 'nums').options).toEqual(['3', '1']);
    expect(data.nums).toEqual(['3', '1']);
    expect(data.picks).toEqual(['A', 'B', 'A', '']);
  });
  test('objects and mixed arrays are shown as their JSON', () => {
    expect(data.obj).toBe(JSON.stringify({ k: 'v' }, null, 2));
    expect(data.mixed).toBe(JSON.stringify(['a', { b: 1 }], null, 2));
  });
  test('an array of plain objects is a repeater: boolean children → checkbox, the rest text, ids left out', () => {
    const rep = definition.sections.find((s) => s.repeater === 'kids');
    expect(rep.title).toBe('Kids');
    expect(rep.fields).toEqual([
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'ok', label: 'Ok', type: 'checkbox' },
      { name: 'age', label: 'Age', type: 'text' },
    ]);
  });
});

describe('ids, masks, layout', () => {
  test('id and *_id keys are not answers — top level and in repeater items', () => {
    const { definition } = synthesizeDefinition(ISSN);
    const names = allFields(definition).map((f) => f.name);
    for (const n of ['case_id', 'client_id', 'cd_contact_id', 'id']) expect(names).not.toContain(n);
    expect(names).toContain('client_name');          // *_name is not *_id
    const { definition: c } = synthesizeDefinition(CONTACT);
    expect(c.sections.find((s) => s.repeater === 'phones').fields.map((f) => f.name)).not.toContain('id');
  });

  test('ssn / phone / zip names get their mask at the top level; repeater fields never do', () => {
    const { definition } = synthesizeDefinition({ ...ISSN, ssn: '123456789', phone2: '2485551212', zip: 48075 });
    expect(byName(definition, 'client_phone').mask).toBe('phone');
    expect(byName(definition, 'phone2').mask).toBe('phone');
    expect(byName(definition, 'client_zip').mask).toBe('zip');
    expect(byName(definition, 'ssn').mask).toBe('ssn');
    expect(byName(definition, 'zip').mask).toBeUndefined();   // a number — no mask
    expect(byName(definition, 'marital_status').mask).toBeUndefined();
    const { definition: c } = synthesizeDefinition(CONTACT);
    for (const s of c.sections.filter((x) => x.repeater)) for (const f of s.fields) expect(f.mask).toBeUndefined();
  });

  test('sorted case-insensitively; two narrow fields a row; wide fields alone; repeaters after the answers', () => {
    const { definition } = synthesizeDefinition({ b: '1', A: '2', notes: 'a\nb', c: '3', d: '4', e: '5', rep: [{ x: '1' }] });
    expect(definition.sections.map((s) => s.title)).toEqual(['Saved answers', 'Rep']);
    expect(definition.sections[0].rows.map((r) => r.fields.map((f) => f.name)))
      .toEqual([['A', 'b'], ['c', 'd'], ['e'], ['notes']]);
  });

  test('labels: underscores to spaces, first letter capitalized; a key failing the name rule is its own label', () => {
    const { definition, data } = synthesizeDefinition({ client_fname: 'a', 'bad key!': 'b' });
    expect(byName(definition, 'client_fname').label).toBe('Client fname');
    const renamed = allFields(definition).find((f) => f.label === 'bad key!');
    expect(renamed.name).toBe('_k1');
    expect(data).toEqual({ client_fname: 'a', _k1: 'b' });
  });

  test('a generated name never takes one already in the data', () => {
    const { definition, data } = synthesizeDefinition({ _k1: 'mine', 'x-y': 'v' });
    expect(allFields(definition).find((f) => f.label === 'x-y').name).toBe('_k2');
    expect(data).toEqual({ _k1: 'mine', _k2: 'v' });
  });

  test('nothing saved → one section saying so', () => {
    expect(synthesizeDefinition({}).definition.sections)
      .toEqual([{ title: 'Saved answers', subtitle: 'No answers were saved.', rows: [] }]);
  });
});

describe('data', () => {
  test('the same object back when every value fits; the input is never mutated', () => {
    const issn = clone(ISSN);
    const out = synthesizeDefinition(issn);
    expect(out.data).toBe(issn);
    expect(issn).toEqual(ISSN);
    const contact = clone(CONTACT);
    synthesizeDefinition(contact);
    expect(contact).toEqual(CONTACT);
  });

  test('a repeater child colliding with a top-level name is renamed in that repeater\'s items only', () => {
    const { definition, data } = synthesizeDefinition(CONTACT);
    const addr = definition.sections.find((s) => s.repeater === 'addresses');
    const city = addr.fields.find((f) => f.label === 'City');
    const notes = addr.fields.find((f) => f.label === 'Notes');
    expect(city.name).toMatch(/^_k\d+$/);
    expect(notes.name).toMatch(/^_k\d+$/);
    expect(data.addresses[0][city.name]).toBe('Detroit');
    expect(data.addresses[0][notes.name]).toBe('side door');
    expect(data.addresses[0].city).toBeUndefined();
    expect(data.city).toBe('Southfield');                        // the top-level one untouched
    expect(byName(definition, 'city').type).toBe('text');
    // phones has a `notes` child too → renamed there as well, independently.
    expect(definition.sections.find((s) => s.repeater === 'phones').fields.find((f) => f.label === 'Notes').name).toMatch(/^_k\d+$/);
  });
});

describe('PDF', () => {
  test('a synthesized bundle prints its answers and repeaters under the synthesized note, not the schema note', () => {
    const { definition, data } = synthesizeDefinition(CONTACT);
    const html = formPdfService.buildSubmissionHtml({
      submission: { id: 9, form_key: 'contact_info', data, created_at: new Date('2026-11-06T17:51:43Z') },
      title: 'Contact info', definition, definition_schema_version: null,
      schema_matched: false, definition_source: 'synthesized',
    });
    expect(html).toContain('this form has no published layout');
    expect(html).not.toContain('no longer available');
    expect(html).toContain('<div class="sec-title">Phones</div>');
    expect(html).toContain('<td>2485551212</td>');                 // repeater cell: raw (no masks in repeaters)
    expect(html).toContain('123-45-6789');                         // top-level ssn mask
    expect(html).toContain('Detroit');
    expect(html).toContain('Prefers text.');
  });
});
