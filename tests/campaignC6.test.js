// tests/campaignC6.test.js
//
/**
 * YisraMail C6 — addNoTrack (services/campaignService.js): ses:no-track on
 * every anchor pointing at the send's unsubscribe/preferences URL, so an
 * author-placed {{send.unsubscribe_url}} in the BODY is as untracked as the
 * footer's own links (review S2). The end-to-end proof (a promotional send
 * whose body carries the anchor) is in tests/campaignC7.mysql.test.js.
 *
 *   npx jest tests/campaignC6.test.js
 */

'use strict';

const { addNoTrack } = require('../services/campaignService');

const UNSUB = 'https://app.4lsg.com/u/tok123';
const PREFS = 'https://app.4lsg.com/u/tok123#prefs';

describe('addNoTrack', () => {
  test('tags a double-quoted body anchor on the unsub URL; other links untouched', () => {
    const html = `<p><a href="${UNSUB}">leave</a> <a href="https://www.4lsg.com/news">news</a></p>`;
    const out = addNoTrack(html, [UNSUB, PREFS]);
    expect(out).toContain(`<a ses:no-track href="${UNSUB}">`);
    expect(out).toContain('<a href="https://www.4lsg.com/news">');
    expect(out.match(/ses:no-track/g)).toHaveLength(1);
  });

  test('single quotes and extra attributes work; the prefs URL too', () => {
    const out = addNoTrack(`<a style="color:red" href='${PREFS}' target="_blank">prefs</a>`, [UNSUB, PREFS]);
    expect(out).toBe(`<a ses:no-track style="color:red" href='${PREFS}' target="_blank">prefs</a>`);
  });

  test('matches the html-escaped form the resolver emits', () => {
    const url = 'https://app.4lsg.com/u/a?b=1&c=2';
    const out = addNoTrack(`<a href="https://app.4lsg.com/u/a?b=1&amp;c=2">x</a>`, [url]);
    expect(out).toMatch(/^<a ses:no-track /);
  });

  test('an anchor already carrying the attribute is left alone (no doubling)', () => {
    const html = `<a ses:no-track href="${UNSUB}">leave</a>`;
    expect(addNoTrack(html, [UNSUB])).toBe(html);
  });

  test('null/empty urls and anchors without href never throw or tag', () => {
    const html = '<a name="top">x</a><a href="">y</a>';
    expect(addNoTrack(html, [null, undefined, ''])).toBe(html);
  });

  test('prefix forms are tagged too — rule 6 allows a URL that merely STARTS with the placeholder (review N8)', () => {
    const out = addNoTrack(`<a href="${UNSUB}?src=body#x">leave</a><a href="https://app.4lsg.com/uother">n</a>`, [UNSUB, PREFS]);
    expect(out).toContain(`<a ses:no-track href="${UNSUB}?src=body#x">`);
    expect(out).toContain('<a href="https://app.4lsg.com/uother">');
  });
});
