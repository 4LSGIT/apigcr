// tests/issnCodebtor.test.js
//
/**
 * public/forms/issn.html — the co-debtor create in onSave, booted for real
 * in jsdom with the real yc-forms.js and a stub shell (window.parent IS the
 * window in a top-level jsdom, so P.apiSend resolves to the stub).
 *
 * THE BUG: the create POSTed /api/intake/contact without duplicate=duplicate.
 * A co-debtor sharing the debtor's phone/email is a single match, so intake
 * took its UPDATE branch on the DEBTOR: renamed them to the co-debtor and
 * overwrote DOB / SSN / address.
 *
 * Fred's rule (2026-10-27): a phone/email another contact ACTIVELY holds
 * stays off the new co-debtor (creating with it would move it off the
 * holder), and staff are told. Asserts:
 *   - the lookup asks for active holders only;
 *   - every create sends duplicate=duplicate;
 *   - a held phone/email is sent blank, the rest kept; a toast names it;
 *   - nothing held → both kept, no toast;
 *   - a failed lookup creates nothing (fail closed) and says so.
 *
 * yc-forms.js and the page's inline block are ONE eval (browser lexical
 * semantics — see tests/caseUi.detTab.test.js); a subclass of YCForm spliced
 * between them records the page's options so onSave can be called directly.
 *
 * Run:  npx jest tests/issnCodebtor.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/forms/issn.html'), 'utf8');
const YCFORMS = fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js'), 'utf8');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms = 30) => new Promise((r) => w.setTimeout(r, ms));

const DEBTOR = { contact_id: 41, contact_name: 'John Doe' };

async function boot({ matches = [], lookupFails = false } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.4lsg.com/forms/issn.html?case_id=CASE0001', runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;
  const calls = [];
  window.apiSend = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.startsWith('/api/contact-lookup')) {
      if (lookupFails) throw new Error('lookup down');
      return { status: 'success', matches, summary: {} };
    }
    if (url === '/api/intake/contact') return { id: 77, contact_id: 77, status: 'success', action: 'created' };
    return { status: 'success' };
  };
  const toasts = [];
  window.Swal = { fire: (o) => { toasts.push(o); return Promise.resolve({}); } };

  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, noComments])[1];
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const SPY = 'YCForm = (B => class extends B { constructor(o) { super(o); window.__issn = { opts: o, form: this }; } })(YCForm);';
  window.eval([YCFORMS, SPY, ...inline].join('\n;\n'));
  await tick(window);
  return { window, calls, toasts };
}

// The phone mask collects digits only, so '(313) 555-0100' leaves as '3135550100'.
function fillCodebtor(window, { phone = '(313) 555-0100', email = 'jane@example.com' } = {}) {
  const q = (n) => window.document.querySelector(`[name="${n}"]`);
  q('case_id').value = 'CASE0001';
  window.document.querySelector('[name="is_codebtor"][value="Yes"]').checked = true;
  q('cd_fname').value = 'Jane';
  q('cd_lname').value = 'Doe';
  q('cd_phone').value = phone;
  q('cd_email').value = email;
  q('cd_ssn').value = '123-45-6789';
}

const intakePosts = (calls) => calls.filter((c) => c.url === '/api/intake/contact');
const lookups     = (calls) => calls.filter((c) => c.url.startsWith('/api/contact-lookup'));

describe('ISSN co-debtor create', () => {
  test('a phone the debtor holds is left off; always duplicate=duplicate; staff told', async () => {
    const { window, calls, toasts } = await boot({
      matches: [{ ...DEBTOR, matched_by_phone: { source: 'child_active' }, matched_by_email: null }],
    });
    expect(window.__issn).toBeTruthy();
    fillCodebtor(window);
    await window.__issn.opts.onSave({});

    expect(lookups(calls).map((c) => c.body)).toEqual([{
      include_ended: 'false', include_legacy_secondary: 'false', phone: '3135550100', email: 'jane@example.com',
    }]);
    expect(intakePosts(calls).map((c) => c.body)).toEqual([expect.objectContaining({
      firstName: 'Jane', lastName: 'Doe', phone: '', email: 'jane@example.com', duplicate: 'duplicate',
      contact_ssn: '123456789',   // the SSN mask collects digits too
    })]);
    expect(calls.find((c) => c.url === '/api/cases/CASE0001/contacts').body).toEqual({ contact_id: 77, relate_type: 'Secondary' });
    expect(toasts.map((t) => t.text)).toEqual(['Left off the shared phone (John Doe has it).']);
  });

  test('nothing held → both kept, still duplicate=duplicate, no toast', async () => {
    const { window, calls, toasts } = await boot();
    fillCodebtor(window);
    await window.__issn.opts.onSave({});
    expect(intakePosts(calls)[0].body).toMatchObject({ phone: '3135550100', email: 'jane@example.com', duplicate: 'duplicate' });
    expect(toasts).toEqual([]);
  });

  test('an ended or legacy match is not a holder', async () => {
    const { window, calls } = await boot({
      matches: [{ ...DEBTOR, matched_by_phone: { source: 'legacy_primary' }, matched_by_email: { source: 'child_ended' } }],
    });
    fillCodebtor(window);
    await window.__issn.opts.onSave({});
    expect(intakePosts(calls)[0].body).toMatchObject({ phone: '3135550100', email: 'jane@example.com' });
  });

  test('a failed lookup creates nothing and says so', async () => {
    const { window, calls, toasts } = await boot({ lookupFails: true });
    jest.spyOn(window.console, 'warn').mockImplementation(() => {});
    fillCodebtor(window);
    await window.__issn.opts.onSave({});
    expect(intakePosts(calls)).toHaveLength(0);
    expect(calls.filter((c) => c.url.startsWith('/api/cases/') && c.method === 'POST')).toHaveLength(0);
    expect(toasts.map((t) => t.title)).toEqual(['Co-debtor not created']);
  });
});
