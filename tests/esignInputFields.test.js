// tests/esignInputFields.test.js
//
// Phase 2F — signer-INPUT field types: input_text / checkbox / dropdown /
// radio. Two layers under test:
//
//   1. services/esign/placements.js       — per-type validation rules
//   2. services/esign/zohoSignProvider.js — neutral → Zoho transform,
//                                           incl. the radio aggregation
//
// Every Zoho-side key asserted here was VERIFIED LIVE 2026-07-21 by a submit
// + GET round-trip on the firm's account (state doc, Phase 2F chapter):
// the flat `fields` array carries all four types; checkbox default_value is
// boolean; input_text is Zoho's Textfield with text_property.max_field_length
// and a signer-editable string default_value; dropdown carries
// dropdown_values [{dropdown_value, dropdown_order}]; a Radiogroup has NO
// geometry of its own — only its sub_fields do. Zoho ALLOWLISTS submit keys
// (9043 "Extra key found"), so the transform must emit nothing speculative.
//
// NAMING TRAP (restated from placements.js): neutral `text` = OUR local fill
// class, invisible to the provider; neutral `input_text` = a box the SIGNER
// types into. Tests below assert they never blur.

const {
  validatePlacements,
  INPUT_TEXT_MAX_LENGTH,
  DROPDOWN_MAX_OPTIONS,
  OPTION_TEXT_MAX,
} = require('../services/esign/placements');
const {
  neutralToZohoFields,
  bindFieldsToActions,
} = require('../services/esign/zohoSignProvider');

// ─── field factories ─────────────────────────────────────────────────────────

const geom = { page: 1, x: 72, y: 300, w: 100, h: 20 };

function inputText(over = {}) {
  return { ...geom, type: 'input_text', signer: 1, ...over };
}
function checkbox(over = {}) {
  return { ...geom, w: 15, h: 15, type: 'checkbox', signer: 1, ...over };
}
function dropdown(over = {}) {
  return { ...geom, type: 'dropdown', signer: 1, options: ['A', 'B'], ...over };
}
function radio(over = {}) {
  return { ...geom, w: 15, h: 15, type: 'radio', signer: 1, group: 'Approve', value: 'Yes', ...over };
}

const INVALID = expect.objectContaining({ code: 'ESIGN_INVALID_INPUT' });

// ─────────────────────────────────────────────────────────────────────────────
// 1. VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

describe('placements — input_text', () => {
  test('bare field is valid and joins the signer set', () => {
    expect(validatePlacements({ fields: [inputText({ signer: 2 })] }))
      .toEqual({ count: 1, signers: [2] });
  });

  test('max_length bounds: 1..INPUT_TEXT_MAX_LENGTH, integers only', () => {
    expect(validatePlacements({ fields: [inputText({ max_length: 1 })] }).count).toBe(1);
    expect(validatePlacements({ fields: [inputText({ max_length: INPUT_TEXT_MAX_LENGTH })] }).count).toBe(1);
    for (const bad of [0, -5, 1.5, 'fifty', INPUT_TEXT_MAX_LENGTH + 1]) {
      expect(() => validatePlacements({ fields: [inputText({ max_length: bad })] })).toThrow(INVALID);
    }
  });

  test('default must be a string the field could actually hold', () => {
    expect(validatePlacements({ fields: [inputText({ default: 'ok' })] }).count).toBe(1);
    expect(() => validatePlacements({ fields: [inputText({ default: 42 })] })).toThrow(INVALID);
    // longer than its own cap — a prefill the signer could not have typed
    expect(() => validatePlacements({
      fields: [inputText({ max_length: 3, default: 'toolong' })],
    })).toThrow(INVALID);
    // no explicit cap → bounded by the ceiling
    expect(() => validatePlacements({
      fields: [inputText({ default: 'x'.repeat(INPUT_TEXT_MAX_LENGTH + 1) })],
    })).toThrow(INVALID);
  });

  test('label rules apply (it is a signer field)', () => {
    expect(validatePlacements({ fields: [inputText({ label: 'Middle name' })] }).count).toBe(1);
    expect(() => validatePlacements({ fields: [inputText({ label: 'x'.repeat(61) })] })).toThrow(INVALID);
  });
});

describe('placements — checkbox', () => {
  test('checked must be a boolean when present', () => {
    expect(validatePlacements({ fields: [checkbox()] }).count).toBe(1);
    expect(validatePlacements({ fields: [checkbox({ checked: true })] }).count).toBe(1);
    expect(validatePlacements({ fields: [checkbox({ checked: false })] }).count).toBe(1);
    for (const bad of [1, 'yes', 'true']) {
      expect(() => validatePlacements({ fields: [checkbox({ checked: bad })] })).toThrow(INVALID);
    }
  });
});

describe('placements — dropdown', () => {
  test('options are required, non-empty, bounded and distinct', () => {
    expect(validatePlacements({ fields: [dropdown()] }).count).toBe(1);
    expect(() => validatePlacements({ fields: [dropdown({ options: undefined })] })).toThrow(INVALID);
    expect(() => validatePlacements({ fields: [dropdown({ options: [] })] })).toThrow(INVALID);
    expect(() => validatePlacements({ fields: [dropdown({ options: ['A', '  '] })] })).toThrow(INVALID);
    expect(() => validatePlacements({ fields: [dropdown({ options: ['A', 'A'] })] })).toThrow(INVALID);
    // duplicates-after-trim are duplicates
    expect(() => validatePlacements({ fields: [dropdown({ options: ['A', ' A '] })] })).toThrow(INVALID);
    expect(() => validatePlacements({
      fields: [dropdown({ options: ['x'.repeat(OPTION_TEXT_MAX + 1), 'B'] })],
    })).toThrow(INVALID);
    const many = Array.from({ length: DROPDOWN_MAX_OPTIONS + 1 }, (_, i) => `opt ${i}`);
    expect(() => validatePlacements({ fields: [dropdown({ options: many })] })).toThrow(INVALID);
  });

  test('default must be one of the options', () => {
    expect(validatePlacements({ fields: [dropdown({ default: 'B' })] }).count).toBe(1);
    expect(() => validatePlacements({ fields: [dropdown({ default: 'C' })] })).toThrow(INVALID);
    expect(() => validatePlacements({ fields: [dropdown({ default: 7 })] })).toThrow(INVALID);
  });
});

describe('placements — radio (one box per option)', () => {
  test('a lone box and a two-box group both validate; boxes join the signer set', () => {
    expect(validatePlacements({ fields: [radio()] })).toEqual({ count: 1, signers: [1] });
    expect(validatePlacements({
      fields: [radio({ checked: true }), radio({ value: 'No', x: 120 })],
    })).toEqual({ count: 2, signers: [1] });
  });

  test('group and value are required display text', () => {
    for (const bad of [undefined, null, '', '  ', 9, 'x'.repeat(OPTION_TEXT_MAX + 1)]) {
      expect(() => validatePlacements({ fields: [radio({ group: bad })] })).toThrow(INVALID);
      expect(() => validatePlacements({ fields: [radio({ value: bad })] })).toThrow(INVALID);
    }
  });

  test('a radio box cannot carry a label — the group name is the display name', () => {
    expect(() => validatePlacements({ fields: [radio({ label: 'Pick one' })] }))
      .toThrow(/radio option and cannot carry a label/);
  });

  test('values must be unique within a group (other groups unaffected)', () => {
    expect(() => validatePlacements({
      fields: [radio(), radio({ x: 120 })], // same group, same value 'Yes'
    })).toThrow(/two boxes with value/);
    // same value in a DIFFERENT group is fine
    expect(validatePlacements({
      fields: [radio(), radio({ group: 'Other', x: 120 })],
    }).count).toBe(2);
  });

  test('a group belongs to exactly one signer', () => {
    expect(() => validatePlacements({
      fields: [radio(), radio({ value: 'No', signer: 2, x: 120 })],
    })).toThrow(/spans signers/);
  });

  test('required is a property of the group — mixed flags throw', () => {
    expect(() => validatePlacements({
      fields: [radio(), radio({ value: 'No', required: false, x: 120 })],
    })).toThrow(/mixes required and optional/);
    // consistently optional is fine
    expect(validatePlacements({
      fields: [radio({ required: false }), radio({ value: 'No', required: false, x: 120 })],
    }).count).toBe(2);
  });

  test('at most one checked box per group', () => {
    expect(() => validatePlacements({
      fields: [radio({ checked: true }), radio({ value: 'No', checked: true, x: 120 })],
    })).toThrow(/more than one checked/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PROVIDER TRANSFORM
// ─────────────────────────────────────────────────────────────────────────────

describe('neutralToZohoFields — Phase 2F single-box types', () => {
  test('input_text → Textfield with default_value + text_property.max_field_length', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [inputText({ max_length: 50, default: 'prefill', label: 'Middle name' })],
    });
    const f = bySigner[1][0];
    expect(f.field_type_name).toBe('Textfield');
    expect(f.field_category).toBe('textfield');
    expect(f.default_value).toBe('prefill');
    expect(f.text_property).toEqual({ max_field_length: 50 });
    expect(f.field_label).toBe('Middle name');
  });

  test('input_text without extras emits NEITHER key (Zoho allowlists — 9043)', () => {
    const { bySigner } = neutralToZohoFields({ fields: [inputText()] });
    const f = bySigner[1][0];
    expect(f).not.toHaveProperty('default_value');
    expect(f).not.toHaveProperty('text_property');
  });

  test('checkbox → Checkbox; default_value true ONLY when checked', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [checkbox({ checked: true }), checkbox({ y: 340 }), checkbox({ y: 380, checked: false })],
    });
    const [ticked, bare, unticked] = bySigner[1];
    expect(ticked.field_type_name).toBe('Checkbox');
    expect(ticked.field_category).toBe('checkbox');
    expect(ticked.default_value).toBe(true);
    expect(bare).not.toHaveProperty('default_value');
    expect(unticked).not.toHaveProperty('default_value');
  });

  test('dropdown → Dropdown with ordered dropdown_values and optional default', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [dropdown({ options: ['Chapter 7', 'Chapter 13'], default: 'Chapter 13' })],
    });
    const f = bySigner[1][0];
    expect(f.field_type_name).toBe('Dropdown');
    expect(f.field_category).toBe('dropdown');
    expect(f.dropdown_values).toEqual([
      { dropdown_value: 'Chapter 7', dropdown_order: 0 },
      { dropdown_value: 'Chapter 13', dropdown_order: 1 },
    ]);
    expect(f.default_value).toBe('Chapter 13');
  });

  test('dropdown without a default omits default_value', () => {
    const { bySigner } = neutralToZohoFields({ fields: [dropdown()] });
    expect(bySigner[1][0]).not.toHaveProperty('default_value');
  });

  test('integer-abs invariant (9011) holds for the new types', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [
        inputText({ x: 72.4, y: 300.6, w: 100.2, h: 20.7 }),
        checkbox({ x: 10.5, y: 11.5, w: 15.4, h: 15.6 }),
        dropdown({ x: 33.3, y: 44.4, w: 90.9, h: 18.1 }),
      ],
    });
    for (const f of bySigner[1]) {
      for (const k of ['x_coord', 'y_coord', 'abs_width', 'abs_height']) {
        expect(Number.isInteger(f[k])).toBe(true);
      }
    }
  });
});

describe('neutralToZohoFields — radio aggregation', () => {
  const twoGroups = () => ({
    fields: [
      radio({ checked: true }),                                  // Approve · Yes (default)
      inputText({ y: 500 }),                                     // interleaved on purpose
      radio({ value: 'No', x: 120.6 }),                          // Approve · No
      radio({ group: 'Plan', value: '36 months', signer: 2 }),   // second group, other signer
      radio({ group: 'Plan', value: '60 months', signer: 2, x: 200 }),
    ],
  });

  test('boxes sharing a group become ONE Radiogroup with sub_fields', () => {
    const { bySigner, count } = neutralToZohoFields(twoGroups());
    // 1 input_text + 1 group for signer 1; 1 group for signer 2
    expect(count).toBe(3);
    const g1 = bySigner[1].find((f) => f.field_category === 'radiogroup');
    expect(g1.field_type_name).toBe('Radiogroup');
    expect(g1.field_name).toBe('Approve');
    expect(g1.field_label).toBe('Approve');
    expect(g1.is_mandatory).toBe(true);
    expect(g1.sub_fields.map((s) => s.sub_field_name)).toEqual(['Yes', 'No']);
    const g2 = bySigner[2][0];
    expect(g2.sub_fields.map((s) => s.sub_field_name)).toEqual(['36 months', '60 months']);
  });

  test('the group itself carries NO geometry — only sub_fields do', () => {
    const { bySigner } = neutralToZohoFields(twoGroups());
    const g = bySigner[1].find((f) => f.field_category === 'radiogroup');
    for (const k of ['x_coord', 'y_coord', 'abs_width', 'abs_height', 'x_value', 'y_value', 'width', 'height']) {
      expect(g).not.toHaveProperty(k);
    }
    expect(g.page_no).toBe(0); // follows the first box (neutral page 1)
    for (const s of g.sub_fields) {
      expect(Number.isInteger(s.x_coord)).toBe(true);   // 9011 rule on subs too
      expect(Number.isInteger(s.abs_width)).toBe(true);
      expect(s).toHaveProperty('x_value');
      expect(s).toHaveProperty('page_no');
    }
  });

  test('sub_field geometry uses the same flip as every other field', () => {
    const lone = { fields: [radio({ page: 1, x: 72, y: 300, w: 15, h: 15 })] };
    const { bySigner } = neutralToZohoFields(lone, { width: 612, height: 792 });
    const s = bySigner[1][0].sub_fields[0];
    expect(s.y_coord).toBe(792 - 300 - 15); // 477
    expect(s.x_coord).toBe(72);
  });

  test('checked box becomes the group default_value; none checked → no default', () => {
    const withDefault = neutralToZohoFields(twoGroups());
    const g1 = withDefault.bySigner[1].find((f) => f.field_category === 'radiogroup');
    expect(g1.default_value).toBe('Yes');
    const g2 = withDefault.bySigner[2][0];
    expect(g2).not.toHaveProperty('default_value');
  });

  test('group required:false maps to is_mandatory:false', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [radio({ required: false }), radio({ value: 'No', required: false, x: 120 })],
    });
    expect(bySigner[1][0].is_mandatory).toBe(false);
  });

  test('group name shares the uniqueName pool with labels', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [
        inputText({ label: 'Approve' }),   // takes the name first
        radio(), radio({ value: 'No', x: 120 }),
      ],
    });
    const g = bySigner[1].find((f) => f.field_category === 'radiogroup');
    expect(g.field_name).toBe('Approve 2'); // de-duped, not colliding
    expect(g.field_label).toBe('Approve');  // label stays the author's text
  });

  test('sub_fields can span pages; per-page geometry applies to each', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [
        radio({ page: 1 }),
        radio({ value: 'No', page: 2, x: 120 }),
      ],
    }, { width: 612, height: 792, pages: { 2: { width: 595, height: 842 } } });
    const [a, b] = bySigner[1][0].sub_fields;
    expect(a.page_no).toBe(0);
    expect(b.page_no).toBe(1);
    expect(b.y_coord).toBe(842 - 300 - 15); // A4 height on page 2
  });
});

describe('bindFieldsToActions — sub_field stamping', () => {
  test('sub_fields receive document_id; the transform output is not mutated', () => {
    const { bySigner } = neutralToZohoFields({
      fields: [radio(), radio({ value: 'No', x: 120 })],
    });
    const bound = bindFieldsToActions(
      bySigner,
      [{ action_id: 'ACT1' }],
      [{ order: 1 }],
      'DOC1'
    );
    const g = bound[0].fields[0];
    expect(g.document_id).toBe('DOC1');
    expect(g.action_id).toBe('ACT1');
    for (const s of g.sub_fields) expect(s.document_id).toBe('DOC1');
    // purity: the pre-bind object gained nothing
    for (const s of bySigner[1][0].sub_fields) expect(s).not.toHaveProperty('document_id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLASS BOUNDARY — 'text' and 'input_text' never blur
// ─────────────────────────────────────────────────────────────────────────────

describe("class boundary — local 'text' vs signer 'input_text'", () => {
  test("neutral 'text' still never reaches the provider; input_text always does", () => {
    const { bySigner, count } = neutralToZohoFields({
      fields: [
        { page: 1, x: 72, y: 600, w: 120, h: 18, type: 'text', key: 'debtor_name' },
        inputText(),
      ],
    });
    expect(count).toBe(1);
    expect(bySigner[1]).toHaveLength(1);
    expect(bySigner[1][0].field_type_name).toBe('Textfield');
  });

  test("an input_text field requires a signer path — key on it is ignored, not honored", () => {
    // A confused author putting `key` on input_text: the validator does not
    // throw (unknown extras are the editor's concern) but the provider must
    // not treat it as fillable — it goes to Zoho as an empty signer box.
    const { bySigner } = neutralToZohoFields({ fields: [inputText({ key: 'debtor_name' })] });
    expect(bySigner[1][0]).not.toHaveProperty('key');
  });
});
