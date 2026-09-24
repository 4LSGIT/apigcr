/**
 * tests/ssnModifiers.test.js
 *
 * ssn_mask / ssn_last4 placeholder modifiers.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * contact_ssn became an ordinary readable column on 2026-09-24. These two
 * modifiers exist so a template that wants the short form does not have to
 * print all nine digits to get it — {{contacts.contact_ssn|ssn_mask}}.
 *
 * The thing that will break is AGREEMENT. The modifier chain is implemented
 * TWICE — services/resolverService.js and lib/unplacehold.js — each with its
 * own private copy of the formatters (email_mask was already duplicated this
 * way before these two joined it). Nothing structural keeps the copies in step,
 * and a third copy already exists in esignPrefillService.ssnMasked, whose
 * 'xxx-xx-6789' output these deliberately match: the same number rendering as
 * 'xxx-xx-6789' on a document and '***-**-6789' in an email is a bug report
 * nobody will enjoy. So the copies are asserted against each other here, on the
 * same inputs, rather than each being spot-checked alone.
 *
 * The under-four-digits case returns '' on purpose, inherited from the esign
 * helper: 'xxx-xx-' with nothing after it on a legal document is worse than a
 * blank the template collapses.
 *
 * Neither module exports its formatters, so both are driven through their real
 * public entry point — resolve() over the in-memory trigger_data pseudo-table,
 * and unplacehold() over a stubbed contacts read.
 *
 *   npx jest tests/ssnModifiers.test.js
 */

'use strict';

const resolverService = require('../services/resolverService');
const unplacehold     = require('../lib/unplacehold');

/** Drive the resolverService modifier chain with no SQL at all. */
async function viaResolver(value, mod) {
  const out = await resolverService.resolve({
    db: null,
    text: `{{trigger_data.v|${mod}}}`,
    refs: { trigger_data: { v: value } },
  });
  return out.text;
}

/** Drive the unplacehold modifier chain over a stubbed contacts row. */
async function viaUnplacehold(value, mod) {
  const conn = {
    query: async (sql) => (/FROM contacts/i.test(String(sql))
      ? [[{ contact_id: 1, contact_ssn: value }]]
      : [[]]),
    release() {},
  };
  const out = await unplacehold({
    db: { getConnection: async () => conn },
    text: `{{contact.contact_ssn|${mod}}}`,
    contact_id: 1,
  });
  return out.text;
}

const CASES = [
  ['dashed',            '123-45-6789', 'xxx-xx-6789', '6789'],
  ['bare digits',       '123456789',   'xxx-xx-6789', '6789'],
  ['spaced and dashed', ' 123 45-6789', 'xxx-xx-6789', '6789'],
  ['exactly four',      '6789',        'xxx-xx-6789', '6789'],
  ['too short',         '789',         '',            ''],
  ['non-numeric',       'n/a',         '',            ''],
];

describe('ssn_mask / ssn_last4 — resolverService', () => {
  test.each(CASES)('%s', async (_label, input, masked, last4) => {
    expect(await viaResolver(input, 'ssn_mask')).toBe(masked);
    expect(await viaResolver(input, 'ssn_last4')).toBe(last4);
  });
});

describe('ssn_mask / ssn_last4 — unplacehold', () => {
  test.each(CASES)('%s', async (_label, input, masked, last4) => {
    expect(await viaUnplacehold(input, 'ssn_mask')).toBe(masked);
    expect(await viaUnplacehold(input, 'ssn_last4')).toBe(last4);
  });
});

describe('empty source values — the engines DISAGREE, generically', () => {
  // Not an SSN behaviour and not introduced here: resolverService treats an
  // empty resolved value as UNRESOLVED and leaves the raw placeholder in the
  // text, for every modifier — phone, email_mask and upper do the same. This
  // is verified below rather than asserted only for ssn_mask, so a future
  // reader does not mistake it for something the SSN work introduced.
  test('resolverService leaves the placeholder standing', async () => {
    for (const mod of ['ssn_mask', 'ssn_last4', 'phone', 'email_mask', 'upper']) {
      const out = await resolverService.resolve({
        db: null,
        text: `{{trigger_data.v|${mod}}}`,
        refs: { trigger_data: { v: '' } },
      });
      expect(out.text).toBe(`{{trigger_data.v|${mod}}}`);
      expect(out.unresolved).toHaveLength(1);
    }
  });

  test('unplacehold resolves it to an empty string instead', async () => {
    expect(await viaUnplacehold('', 'ssn_mask')).toBe('');
    expect(await viaUnplacehold('', 'ssn_last4')).toBe('');
  });
});

describe('the two implementations agree', () => {
  // The real risk of the duplication. If one copy is edited, this fails before
  // anyone notices that a document and an email disagree about the same SSN.
  test.each(CASES)('%s renders identically in both', async (_label, input) => {
    expect(await viaResolver(input, 'ssn_mask'))
      .toBe(await viaUnplacehold(input, 'ssn_mask'));
    expect(await viaResolver(input, 'ssn_last4'))
      .toBe(await viaUnplacehold(input, 'ssn_last4'));
  });

  test('and both agree with esignPrefillService.ssnMasked', async () => {
    // The third copy, and the one that reaches a filed document. Driven
    // through its own public surface.
    const prefill = require('../services/esignPrefillService');
    const built = prefill.RESOLVERS['debtor1.ssn_masked'](
      { debtor1: { contact_ssn: '123-45-6789' } });
    expect(built).toBe('xxx-xx-6789');
    expect(built).toBe(await viaResolver('123-45-6789', 'ssn_mask'));
  });
});
