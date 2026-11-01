// tests/videoLinkForms.test.js
//
/**
 * Every video link the app builds or stores in source uses ?ct=, and every
 * placeholder form keeps its |default:.
 *
 *   - ?c=<contact_id> was an integer anyone can type, retired 2026-11-01. Links
 *     already sent play anonymously. Nothing may mint a new one.
 *   - services/resolverService leaves a NULL value's placeholder IN THE TEXT
 *     when it has no default, so a contact with no token would be sent a
 *     literal {{contacts.contact_token}}.
 */

const fs = require('fs');
const path = require('path');
const { resolve } = require('../services/resolverService');

const PUBLIC = path.join(__dirname, '..', 'public');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.(html|js)$/.test(e.name) ? [p] : [];
  });
}
const FILES = walk(PUBLIC).map((p) => [path.relative(PUBLIC, p), fs.readFileSync(p, 'utf8')]);

describe('public/ source', () => {
  test('finds the files it is meant to guard', () => {
    const names = FILES.map(([n]) => n);
    expect(names).toEqual(expect.arrayContaining(['sendingform-bk.html', 'videoManager.html', path.join('js', 'videoInsert.js')]));
  });

  test('no video link carries ?c=', () => {
    const bad = FILES.flatMap(([n, src]) => src.split('\n')
      .map((line, i) => [line, i + 1])
      .filter(([line]) => /\/v\/[^'"`\s]*\?c=/.test(line) || /[vV]ideo[A-Za-z]*\s*\+.*[`'"]\?c=/.test(line))
      .map(([, ln]) => `${n}:${ln}`));
    expect(bad).toEqual([]);
  });

  test('every contact_token placeholder in a video file keeps its |default:', () => {
    const bad = FILES
      .filter(([n]) => /videoManager|videoInsert/.test(n))
      .flatMap(([n, src]) => src.split('\n')
        .map((line, i) => [line, i + 1])
        .filter(([line]) => /\{\{contacts\.contact_token\}\}/.test(line))
        .map(([, ln]) => `${n}:${ln}`));
    expect(bad).toEqual([]);
  });
});

describe('why the |default: matters', () => {
  const db = { query: async () => [[{ contact_token: null }]] };
  const render = (text) => resolve({ db, text, refs: { contacts: { contact_id: 1 } }, strict: false });

  test('a NULL token with the default renders an empty value', async () => {
    expect((await render('/v/x?ct={{contacts.contact_token|default:}}')).text).toBe('/v/x?ct=');
  });

  test('without it the placeholder stays in the text', async () => {
    expect((await render('/v/x?ct={{contacts.contact_token}}')).text).toContain('{{');
  });
});
