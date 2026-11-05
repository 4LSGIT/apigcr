/**
 * tests/passwordAutofill.test.js — every password field on a page is CONTAINED.
 *
 * Chrome's password manager ignores autocomplete="off". On a page with no
 * <form>, it reads the whole document as one login form: it pairs a password
 * input with the nearest VISIBLE text input before it and fills the saved
 * username there — even when that input is a search box and the password is
 * hidden inside a modal nobody opened. Reported 2026-11-05: comms.html's
 * Phone search box (#ph-q) carried the saved username 'IT' and the
 * saved-logins dropdown, because the purge dialog's #ca-act-pw sat in the
 * document with no form around it.
 *
 * The invariant, for every <input type="password"> in public/*.html:
 *   it is inside a <form>  (so the manager's search for a username stays in
 *                           that form — public/comms.html, settings.html)
 *   OR it carries autocomplete="new-password"  (so the manager offers a new
 *                           password instead of filling a saved credential —
 *                           public/mailboxAdmin.html's precedent, used for
 *                           the credential secrets rendered by JS).
 *
 * A new password field joins one of the two. The ONE exception is named below.
 *
 * Run:  npx jest tests/passwordAutofill.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public');

/*
 * index.html's login prompt IS the page's login form: its #username input
 * sits beside the password in the same SweetAlert, so the manager's pair is
 * already the intended one and there is nothing else on the shell to misfill
 * (the dialog is modal and the shell behind it is not yet painted).
 */
const EXEMPT = new Set(['index.html#password']);

/**
 * Every <input type="password"> in a page, with its enclosing-form depth.
 * Comments go first: the <form> in a comment ABOUT this trap counted as an
 * unclosed form and made the sweep pass with the real one deleted.
 */
function passwordFields(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of src.matchAll(/<input\b[^>]*>/g)) {
    if (!/type\s*=\s*["']?password/i.test(m[0])) continue;
    const head = src.slice(0, m.index);
    const open = (head.match(/<form\b/gi) || []).length;
    const close = (head.match(/<\/form>/gi) || []).length;
    out.push({
      id: (/id\s*=\s*["']([^"']+)/.exec(m[0]) || [])[1] || '(no id)',
      inForm: open - close > 0,
      autocomplete: (/autocomplete\s*=\s*["']([^"']+)/.exec(m[0]) || [])[1] || '',
      tag: m[0],
    });
  }
  return out;
}

describe('password fields are contained (autofill cannot reach the rest of the page)', () => {
  const pages = fs.readdirSync(DIR).filter((n) => n.endsWith('.html')).sort();

  test('the sweep sees the known fields (so a silent zero cannot pass)', () => {
    const n = pages.reduce((a, p) => a + passwordFields(fs.readFileSync(path.join(DIR, p), 'utf8')).length, 0);
    expect(n).toBeGreaterThanOrEqual(15);
  });

  test.each(pages)('%s', (page) => {
    const fields = passwordFields(fs.readFileSync(path.join(DIR, page), 'utf8'));
    const loose = fields.filter((f) => !EXEMPT.has(`${page}#${f.id}`)
      && !f.inForm && f.autocomplete.toLowerCase() !== 'new-password');
    expect(loose.map((f) => `${f.id}: ${f.tag}`)).toEqual([]);
  });

  test('the exemption list is live (a stale entry is a lie about the page)', () => {
    for (const key of EXEMPT) {
      const [page, id] = key.split('#');
      const f = passwordFields(fs.readFileSync(path.join(DIR, page), 'utf8')).find((x) => x.id === id);
      expect(f).toBeTruthy();
      expect(f.inForm || f.autocomplete.toLowerCase() === 'new-password').toBe(false);
    }
  });
});
