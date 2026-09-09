// tests/nameKeyOrgKind.test.js
//
/**
 * documentSyncService._nameKey — kind-aware behavior (org-contacts carried
 * nit). Org lfm names are the org name VERBATIM (m3 trigger, org branch), so
 * the person-shape comma split is a lie for them: "Legacy Signature
 * Properties, Inc." parsed as surname [legacy, signature, properties] /
 * given [inc] treated "Inc" as a first name and let the weak lane match on
 * the surname subset alone.
 *
 * Org rows now key on the WHOLE normalized token set (required = surname =
 * all), keeping the return SHAPE ({required, all, surname}) identical so the
 * _matchCase caller needed no structural change — only the extra `kind`
 * argument (fed by contact_kind, added to the relink contacts SELECT).
 *
 * Person behavior is pinned UNCHANGED, including with the kind argument
 * absent (undefined) and explicitly 'person' — the existing
 * tests/documentRelink.test.js pins remain green on top of these.
 */

'use strict';

process.env.CREDENTIALS_ENCRYPTION_KEY =
  require('crypto').randomBytes(32).toString('base64');

const sync = require('../services/documentSyncService');

describe('_nameKey — org kind', () => {
  test("the live case: 'inc' is a stopword, so the whole set is the pre-comma tokens", () => {
    const key = sync._nameKey('Legacy Signature Properties, Inc.', 'org');
    expect(key.required).toEqual(['legacy', 'signature', 'properties']);
    expect(key.all).toEqual(['legacy', 'signature', 'properties']);
    // surname (the seed + weak-lane bar) is ALSO the whole set: an org has no
    // weaker identifying subset, so the weak lane is exactly as strict.
    expect(key.surname).toEqual(['legacy', 'signature', 'properties']);
  });

  test('the sharp case: real words after the comma stay REQUIRED and raise the weak bar', () => {
    const key = sync._nameKey('Acme Products, Michigan Division', 'org');
    // person-shape would have made required [acme, products, michigan]
    // (dropping 'division') and let the weak lane match "acme products" alone.
    expect(key.required).toEqual(['acme', 'products', 'michigan', 'division']);
    expect(key.surname).toEqual(['acme', 'products', 'michigan', 'division']);
  });

  test('org kind is normalized (case / padding)', () => {
    const key = sync._nameKey('Acme Holdings', ' ORG ');
    expect(key.surname).toEqual(['acme', 'holdings']);
  });

  test('single-token org still returns a usable key', () => {
    const key = sync._nameKey('Acme', 'org');
    expect(key).toEqual({ required: ['acme'], all: ['acme'], surname: ['acme'] });
  });
});

describe('_nameKey — person path is byte-identical with and without kind', () => {
  test('comma split unchanged for kind undefined / person', () => {
    const expected = { required: ['mitchell', 'natasha'] };
    expect(sync._nameKey('Mitchell, Natasha Q')).toMatchObject(expected);
    expect(sync._nameKey('Mitchell, Natasha Q', 'person')).toMatchObject(expected);
    expect(sync._nameKey('Mitchell, Natasha Q', null)).toMatchObject(expected);
  });

  test('kind, not content, selects the path — a comma-form person still splits', () => {
    const key = sync._nameKey('North, Union', 'person');
    expect(key.surname).toEqual(['north']);
    expect(key.required).toEqual(['north', 'union']);
  });
});
