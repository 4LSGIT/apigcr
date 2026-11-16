'use strict';
/**
 * tests/helpers/formTemplateDbkqShape.js
 *
 * A SYNTHETIC form template draft the size and shape of the firm's bankruptcy
 * questionnaire (dbkq — 149 sections, ~256 answer fields, labels ~50
 * characters, a handful of display-only content items; its live draft was
 * 84,611 characters on 2026-11-16, over the 60,000-character card gate every
 * A12X template card used to carry it inside). Nothing here is copied from the
 * real form: the words are generated, the layout counts cloned. Deterministic,
 * so two test files (the unit suite and the real-engine twin) build the same
 * bytes and the same hashes.
 *
 * Used by tests/caseyFormTemplates.test.js (the card stays small) and
 * tests/caseyFormTemplates.mysql.test.js (the click PUTs the full result).
 */

const SECTIONS = 149;
const TYPES = ['text', 'radio', 'number', 'checkgroup', 'text', 'select', 'text', 'textarea', 'radio', 'number', 'text', 'radio'];
const WORDS = ['debtor', 'spouse', 'creditor', 'monthly', 'amount', 'property', 'vehicle', 'income', 'expense', 'household',
  'account', 'balance', 'payment', 'lender', 'address', 'employer', 'retirement', 'insurance', 'support', 'transfer'];

function words(seed, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(WORDS[(seed * 7 + i * 3) % WORDS.length]);
  const s = out.join(' ');
  return s[0].toUpperCase() + s.slice(1);
}

// ~85 KB (JSON.stringify): 149 sections, 256 fields (one per row, as the real
// form lays them out), 4 content items, one showWhen, option lists on the
// choice fields.
function dbkqSizedDraft() {
  const sections = [];
  let fieldNo = 0;
  for (let s = 0; s < SECTIONS; s++) {
    const rows = [];
    const perSection = s % 3 === 0 ? 3 : s % 3 === 1 ? 1 : 2; // 149 sections → 50*3 + 50*1 + 49*2 = 298 rows; trimmed below
    for (let r = 0; r < perSection && fieldNo < 256; r++) {
      const type = TYPES[fieldNo % TYPES.length];
      const name = `q${s + 1}_${r + 1}_${WORDS[fieldNo % WORDS.length]}`;
      const f = { name, type, label: `${words(fieldNo, 9)} (${words(fieldNo + 1, 3).toLowerCase()})?` };
      if (type === 'radio' || type === 'select') f.options = ['Yes', 'No', `${words(fieldNo + 2, 3)}`, `${words(fieldNo + 3, 4)}`];
      if (type === 'checkgroup') { f.options = [1, 2, 3, 4, 5, 6].map((i) => `${words(fieldNo + i, 3)}`); f.columns = 2; }
      if (type === 'text' && fieldNo % 2 === 0) f.placeholder = `${words(fieldNo + 4, 5)}`;
      if (type === 'textarea') f.rows = 4;
      if (fieldNo % 4 === 0) f.sublabel = `${words(fieldNo + 5, 12)}.`;
      if (fieldNo % 9 === 0) f.note = `${words(fieldNo + 6, 10)}.`;
      if (type === 'number' && fieldNo % 3 === 0) f.sublabel = `${words(fieldNo + 7, 14)}.`;
      rows.push({ fields: [f] });
      fieldNo += 1;
    }
    if (s % 37 === 0) rows.push({ fields: [{ name: `note_${s + 1}`, type: 'content', text: `${words(s, 12)}.` }] });
    sections.push({ title: `${s + 1}. ${words(s, 2)}`, chapter: `Part ${Math.floor(s / 10) + 1}`, rows });
  }
  sections[5].rows[0].fields[0].showWhen = { field: sections[4].rows[0].fields[0].name, op: 'eq', value: 'Yes' };
  return {
    toggle: true,
    external: { badLink: 'degrade' },
    onSubmit: { workflows: [{ id: 41 }] },
    sections,
    autosaveMs: 15000,
    warningText: `${words(3, 20)}. ${words(9, 20)}.`,
  };
}

module.exports = { dbkqSizedDraft, SECTIONS };
