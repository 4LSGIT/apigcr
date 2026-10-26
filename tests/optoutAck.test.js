/**
 * tests/optoutAck.test.js — the staff-side half of the opt-out ruling
 * (2026-10-27): public/js/optoutAck.js turns a send route's 409 opted_out into
 * a confirm and ONE acknowledged resend, and every staff compose surface sends
 * through it — Ask Casey's send card included (ruling 17, 2026-10-27: "casey
 * is like the user"); its builder never pre-sets the acknowledgement.
 *
 * The helper runs for real in a JSDOM window; the page wiring is pinned at the
 * source (every gated send call site) and, for the comms hub, by dispatch on
 * the rendered controls in tests/phoneSPH.pane.test.js / mailboxS3.pane.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('public/js/optoutAck.js');

function helper() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'dangerously' });
  dom.window.eval(SRC);
  return dom.window;
}
const optedOut = (code = 'opted_out', status = 409) => Object.assign(new Error('Pat has opted out of texts.'), {
  status, body: { status: 'error', code, message: 'Pat has opted out of texts. Send anyway only if they asked for this message.' },
});

describe('ycOptoutAck.send', () => {
  test('a send that goes through is returned untouched, with exactly the caller\'s arguments (no trailing undefined)', async () => {
    const w = helper();
    const calls = [];
    const api = async (...a) => { calls.push(a); return { status: 'success' }; };
    await expect(w.ycOptoutAck.send(api, '/api/x', 'POST', { a: 1 })).resolves.toEqual({ status: 'success' });
    await w.ycOptoutAck.send(api, '/api/x', 'POST', { a: 1 }, { 'Idempotency-Key': 'k' });
    expect(calls).toEqual([['/api/x', 'POST', { a: 1 }], ['/api/x', 'POST', { a: 1 }, { 'Idempotency-Key': 'k' }]]);
  });

  test('409 opted_out + OK → ONE resend: same path, method and headers, the body plus acknowledge_optout:true', async () => {
    const w = helper();
    const calls = []; const asked = [];
    const api = async (...a) => { calls.push(a); if (!a[2].acknowledge_optout) throw optedOut(); return { ok: 1 }; };
    const out = await w.ycOptoutAck.send(api, '/api/mail/send', 'POST', { to: ['p@x.test'] }, { H: '1' }, { confirm: (t) => { asked.push(t); return true; } });
    expect(out).toEqual({ ok: 1 });
    expect(calls).toEqual([
      ['/api/mail/send', 'POST', { to: ['p@x.test'] }, { H: '1' }],
      ['/api/mail/send', 'POST', { to: ['p@x.test'], acknowledge_optout: true }, { H: '1' }],
    ]);
    expect(asked).toEqual(['Pat has opted out of texts. Send anyway only if they asked for this message.\n\nSend anyway?']);
  });

  test('Cancel → an optoutDeclined error and nothing more is sent; the default prompt is window.confirm', async () => {
    const w = helper();
    let n = 0;
    const api = async () => { n++; throw optedOut(); };
    w.confirm = () => false;
    const err = await w.ycOptoutAck.send(api, '/p', 'POST', { m: 1 }).then(() => null, (e) => e);
    expect(err).toMatchObject({ optoutDeclined: true, message: 'Cancelled — nothing was sent (the recipient has opted out).' });
    expect(n).toBe(1);
  });

  test('anything but a 409 opted_out is re-thrown as is, with no prompt (including a second 409 after acknowledging)', async () => {
    const w = helper();
    let asked = 0;
    const confirm = () => { asked++; return true; };
    for (const e of [optedOut('in_flight'), optedOut('opted_out', 422), new Error('network down')]) {
      await expect(w.ycOptoutAck.send(async () => { throw e; }, '/p', 'POST', { m: 1 }, undefined, { confirm })).rejects.toBe(e);
    }
    expect(asked).toBe(0);
    let n = 0;
    await expect(w.ycOptoutAck.send(async () => { n++; throw optedOut(); }, '/p', 'POST', { m: 1 }, undefined, { confirm })).rejects.toMatchObject({ status: 409 });
    expect([n, asked]).toEqual([2, 1]);   // one resend, never a loop
  });
});

describe('every staff send surface goes through the helper — Ask Casey\'s card too', () => {
  const count = (s, re) => (s.match(re) || []).length;

  test('comms hub + entity comms: the two sends ride sendApi, nothing posts to a gated route directly', () => {
    for (const [file, n] of [['public/comms.html', 2], ['public/entityCommunications.html', 2]]) {
      const s = read(file);
      expect([file, s.includes('<script src="/js/optoutAck.js"></script>')]).toEqual([file, true]);
      expect([file, count(s, /sendApi\((?:'\/api\/mail\/send'|`\/api\/phone-lines\/\$\{[^}]+\}\/sms`)/g)]).toEqual([file, n]);
      expect([file, count(s, /\bapi\((?:'\/api\/mail\/send'|`\/api\/phone-lines\/\$\{[^}]+\}\/sms`)/g)]).toEqual([file, 0]);
    }
  });

  test('the contact Communicate tab and both sending forms: every /internal/*/send goes through optoutSend', () => {
    for (const [file, n] of [['public/communicate.html', 3], ['public/sendingform.html', 6], ['public/sendingform-bk.html', 21]]) {
      const s = read(file);
      expect([file, s.includes('<script src="/js/optoutAck.js"></script>')]).toEqual([file, true]);
      expect([file, count(s, /optoutSend\('\/internal\/(sms|mms|email)\/send'/g)]).toEqual([file, n]);
      expect([file, count(s, /apiSend\('\/internal\//g)]).toEqual([file, 0]);
    }
  });

  test('Ask Casey\'s page loads the helper and sends ONLY through it; nothing on the page sets acknowledge_optout itself', () => {
    const s = read('public/assistant.html');
    expect(s.includes('<script src="/js/optoutAck.js"></script>')).toBe(true);
    expect(count(s, /ycOptoutAck\.send\(/g)).toBe(1);
    expect(s).toMatch(/dispatch: sendActionDispatch,/);
    // The acknowledgement is the helper's alone (after the confirm), never a literal here.
    expect(s).not.toMatch(/acknowledge_optout\s*:/);
    expect(count(s, /\/api\/phone-lines\/\$\{line\}\/sms/g)).toBe(1);
    expect(count(s, /'\/api\/mail\/send'/g)).toBe(1);
  });
});
