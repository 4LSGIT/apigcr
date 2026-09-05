/**
 * D4 Part B — scripts/dbkq_v12_polish.js unit contract, exercised through the
 * exported polish() on fixtures shaped like the live definition's cases, plus
 * one run over the committed live snapshot (ref/dbkq_live_definition_…json)
 * asserting the counts Fred eyeballed: 65 number fields, 63 dollars, exactly
 * two counts (household, mileage), zero unsure, signature unchanged.
 *
 *   npx jest tests/dbkqV12Polish.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { polish } = require('../scripts/dbkq_v12_polish');
const { fieldSignature, validateDefinition } = require('../services/formTemplateService');

const fix = (fields, title) => ({
  sections: [{ title: title || '', rows: [{ fields }] }],
});

describe('polish() classification', () => {
  test('"How much" labels get $ and min:0; "How many" gets min:0 only', () => {
    const { def, report } = polish(fix([
      { name: 'rent', type: 'number', label: 'How much is your monthly rent?' },
      { name: 'fam', type: 'number', label: 'How many people live in your household?' },
    ]));
    const [rent, fam] = def.sections[0].rows[0].fields;
    expect(rent.prefix).toBe('$');
    expect(rent.min).toBe(0);
    expect(fam.prefix).toBeUndefined();
    expect(fam.min).toBe(0);
    expect(report.dollar.map((r) => r.name)).toEqual(['rent']);
    expect(report.counts.map((r) => r.name)).toEqual(['fam']);
  });

  test('mileage is a count even when its section talks money', () => {
    const { def } = polish(fix(
      [{ name: 'mi', type: 'number', label: 'What is the approximate mileage on the vehicle?' }],
      'How much is the vehicle worth?'));
    expect(def.sections[0].rows[0].fields[0].prefix).toBeUndefined();
  });

  test('grid fields inherit the $ verdict from the section title', () => {
    const { def } = polish(fix(
      [{ name: 'electric', type: 'number', label: 'Electric' }],
      'Approximately how much are your MONTHLY utility bills:'));
    expect(def.sections[0].rows[0].fields[0].prefix).toBe('$');
  });

  test('unmatched labels land in unsure, untouched beyond min:0', () => {
    const { def, report } = polish(fix(
      [{ name: 'mystery', type: 'number', label: 'Widget delta' }]));
    expect(report.unsure.map((r) => r.name)).toEqual(['mystery']);
    expect(def.sections[0].rows[0].fields[0].prefix).toBeUndefined();
    expect(def.sections[0].rows[0].fields[0].min).toBe(0);
  });

  test('authored min is never clobbered; authored prefix is never clobbered', () => {
    const { def, report } = polish(fix([
      { name: 'yr', type: 'number', label: 'How much?', min: 1950 },
      { name: 'eu', type: 'number', label: 'How much?', prefix: '\u20ac' },
    ]));
    expect(def.sections[0].rows[0].fields[0].min).toBe(1950);
    expect(def.sections[0].rows[0].fields[1].prefix).toBe('\u20ac');
    expect(report.minKept.map((r) => r.name)).toEqual(['yr']);
    expect(report.prefixKept.map((r) => r.name)).toEqual(['eu']);
  });

  test('non-number fields and everything else in the definition are untouched', () => {
    const input = fix([
      { name: 'txt', type: 'text', label: 'How much do you like text?' },
      { name: 'amt', type: 'number', label: 'How much?' },
    ]);
    input.layout = 'card';
    const { def } = polish(input);
    expect(def.sections[0].rows[0].fields[0]).toEqual(input.sections[0].rows[0].fields[0]);
    expect(def.layout).toBe('card');
    // pure: the input object was not mutated
    expect(input.sections[0].rows[0].fields[1].min).toBeUndefined();
  });

  test('deterministic: same input, byte-identical output', () => {
    const input = fix([{ name: 'amt', type: 'number', label: 'How much?' }]);
    expect(JSON.stringify(polish(input).def)).toBe(JSON.stringify(polish(input).def));
  });
});

describe('polish() over the committed live snapshot', () => {
  const snap = path.join(__dirname, '..', 'ref', 'dbkq_live_definition_2026-09-06.json');

  test('65 number fields → 63 $, 2 counts, 0 unsure; signature stable; publishes clean', () => {
    const live = JSON.parse(fs.readFileSync(snap, 'utf8'));
    const { def, report } = polish(live);
    expect(report.dollar.length).toBe(63);
    expect(report.counts.map((r) => r.name).sort()).toEqual(
      ['q108_houshold', 'q229_typeA229_what_is_the_approximate_mileage_on']);
    expect(report.unsure).toEqual([]);
    expect(report.minSet.length).toBe(65);
    expect(fieldSignature(def)).toBe(fieldSignature(live));
    expect(() => validateDefinition(def)).not.toThrow();
  });

  test('the committed v1.2 artifact IS polish(snapshot) — no hand edits drifted in', () => {
    const live = JSON.parse(fs.readFileSync(snap, 'utf8'));
    const emitted = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'ref', '2026-09-06_dbkq_definition.v1.2.json'), 'utf8'));
    expect(emitted).toEqual(polish(live).def);
  });
});
