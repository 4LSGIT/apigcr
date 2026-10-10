/**
 * tests/orphanAdoptDialog.opts.test.js — OrphanAdoptDialog's `opts`
 * (public/scripts.js), added for the comms hub's "add to client"
 * (public/comms.html, mailbox-system arc S2 follow-up).
 *
 * Executes public/scripts.js FOR REAL in jsdom (tests/applyFeSetting.test.js's
 * pattern). The stubs are the shell's: `Swal` (a fake that renders the
 * dialog's html, runs didOpen, and resolves when the test says so) and
 * apiSend. ContactPicker and the dialog itself are the shipped code.
 *
 * WHAT IS LOCKED (each mutation-checked)
 *   - opts.earliest and the log's first sighting: the start date defaults to
 *     the EARLIER of the two; a value that is not a YYYY-MM-DD date is ignored.
 *   - opts.name starts the contact search (the picker's initialQuery runs it)
 *     and prefills Create new's name.
 *   - the log tab's call (no opts) behaves exactly as before: no search on
 *     open, no name.
 *   - backing out of a force-transfer re-opens the dialog WITH the opts.
 *
 *   npx jest tests/orphanAdoptDialog.opts.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/scripts.js'), 'utf8');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms = 20) => new Promise((r) => w.setTimeout(r, ms));

function boot({ logEarliest = null, onPost = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const w = dom.window;
  const calls = [];
  const fires = [];
  // The fake Swal: each fire() renders its html, runs didOpen, and parks a
  // resolver the test settles (confirm / dismiss).
  w.Swal = {
    mixin: () => ({ fire() {} }),
    fire(opts) {
      const host = w.document.createElement('div');
      host.className = 'fake-swal';
      host.innerHTML = opts.html || '';
      const confirm = w.document.createElement('button');
      w.document.body.replaceChildren(host, confirm);
      let settle;
      const p = new Promise((r) => { settle = r; });
      const f = { opts, host, settle, confirmBtn: confirm };
      fires.push(f);
      w.Swal._cur = f;
      if (opts.didOpen) opts.didOpen();
      return p;
    },
    getConfirmButton() { return w.Swal._cur && w.Swal._cur.confirmBtn; },
    clickConfirm() { const f = w.Swal._cur; if (f && (!f.opts.preConfirm || f.opts.preConfirm() !== false)) f.settle({ isConfirmed: true }); },
    close() { const f = w.Swal._cur; if (f) f.settle({ isConfirmed: false }); },
    showValidationMessage() {},
  };
  w.apiSend = async (url, method = 'GET', payload = null) => {
    calls.push({ url, method, payload });
    if (url === '/api/contact-lookup') return { matches: [] };
    if (url === '/api/log/orphan-earliest') return { earliest_log_date: logEarliest };
    if (url === '/api/contacts' && method === 'GET') return { contacts: [{ contact_id: 42, contact_name: 'Smith, Ann' }] };
    if (method === 'POST' && onPost) return onPost(url, payload);
    if (method === 'POST') return { status: 'success' };
    throw new Error(`unexpected ${method} ${url}`);
  };
  const sc = w.document.createElement('script');
  sc.textContent = SRC;
  w.document.head.appendChild(sc);
  const created = [];
  w.newContact = (prefill, onSuccess) => { created.push({ prefill, onSuccess }); };
  return { w, calls, fires, created };
}

const dateDefault = (f) => f.host.querySelector('#oadStartDate').value;

describe('OrphanAdoptDialog opts (comms hub add-to-client)', () => {
  test('start date = the EARLIER of the mail sighting and the log sighting; junk ignored', async () => {
    for (const [log, seen, want] of [
      ['2026-05-01', '2026-02-28', '2026-02-28'],   // the mailbox saw it first (store-only: no log row)
      ['2025-11-30', '2026-02-28', '2025-11-30'],   // the log saw it first
      [null, '2026-02-28', '2026-02-28'],
      ['2026-05-01', '1/2/2026', '2026-05-01'],     // not a YYYY-MM-DD date: ignored (it would sort first)
      ['2026-05-01', null, '2026-05-01'],
    ]) {
      const { w, fires } = boot({ logEarliest: log });
      w.OrphanAdoptDialog('ann@new.test', 'email', null, { earliest: seen });
      await tick(w);
      expect([log, seen, dateDefault(fires[0])]).toEqual([log, seen, want]);
      expect(fires[0].host.querySelector('.yc-hint').textContent).toBe(`Earliest seen ${want}`);
    }
  });

  test('opts.name starts the contact search and prefills Create new (email + chosen start date ride along)', async () => {
    const { w, calls, fires, created } = boot({ logEarliest: null });
    w.OrphanAdoptDialog('ann@new.test', 'email', () => {}, { earliest: '2026-02-28', name: '  Smith, Ann ' });
    await tick(w);
    expect(fires[0].host.querySelector('.cp-input').value).toBe('Smith, Ann');
    expect(calls.find((c) => c.url === '/api/contacts')).toMatchObject({ method: 'GET', payload: { q: 'Smith, Ann', limit: 20 } });
    fires[0].host.querySelector('#oadStartDate').value = '2026-01-15';
    fires[0].host.querySelector('#oadCreateNew').click();
    expect(created.map((c) => c.prefill)).toEqual([{ force_create: true, name: 'Smith, Ann', email: 'ann@new.test', email_start_date: '2026-01-15' }]);
  });

  test('the log tab\'s call (no opts) is unchanged: no search on open, no name, today when the log never saw it', async () => {
    const { w, calls, fires, created } = boot({ logEarliest: null });
    w.OrphanAdoptDialog('ann@new.test', 'email', () => {});
    await tick(w);
    expect(calls.some((c) => c.url === '/api/contacts')).toBe(false);
    expect(dateDefault(fires[0])).toBe(new Date().toISOString().slice(0, 10));
    fires[0].host.querySelector('#oadCreateNew').click();
    expect(created[0].prefill).toEqual({ force_create: true, email: 'ann@new.test', email_start_date: new Date().toISOString().slice(0, 10) });
  });

  test('attach sends the chosen start date; backing out of a force-transfer re-opens WITH the opts', async () => {
    let post = 0;
    const { w, calls, fires } = boot({
      logEarliest: '2026-05-01',
      onPost: (url) => {
        if (url === '/api/contact-emails' && post++ === 0) { const e = new Error('in use'); e.status = 409; e.body = { conflict: { contact_name: 'Other' } }; throw e; }
        return { status: 'success' };
      },
    });
    w.OrphanAdoptDialog('ann@new.test', 'email', () => {}, { earliest: '2026-02-28', name: 'Smith, Ann' });
    await tick(w);
    w.document.querySelector('.cp-row').click();          // pick Smith, Ann from the search the name started
    w.Swal.clickConfirm();
    await tick(w);
    expect(calls.find((c) => c.url === '/api/contact-emails')).toMatchObject({ method: 'POST', payload: { contact_id: 42, start_date: '2026-02-28', email: 'ann@new.test' } });
    expect(fires[1].opts.title).toBe('Already in use');
    fires[1].settle({ isConfirmed: false });              // "Back"
    await tick(w);
    expect(fires).toHaveLength(3);
    expect(dateDefault(fires[2])).toBe('2026-02-28');
    expect(fires[2].host.querySelector('.cp-input').value).toBe('Smith, Ann');
  });
});
