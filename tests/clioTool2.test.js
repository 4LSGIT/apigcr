// tests/clioTool2.test.js
//
/**
 * The Get Clio Code 2 TOOL (ref/tools/clio-code-2.html, the reference copy of
 * the DB-stored tool `clio-code-2`) — the SweetAlert2 variant of `clio-code`.
 * Same job, same backend, same freshness policy; the difference is that it
 * draws in the SHELL's document via window.top.Swal instead of in its own
 * frame, restoring the popup the shell's showClioCode() used before
 * ui-custom S3.3.
 *
 * Run for real against tests/helpers/toolShell.js (the shell's own dialog,
 * tool shell API, auth state and apiSend with a scripted backend, on a fake
 * clock), plus a Swal double on the top window that records every fire() and
 * resolves with whatever the test scripts.
 *
 * What it guards:
 *   - the three popups are the original's (title, icon, buttons, the html's
 *     code / freshness / stale sentence), so a presentation edit here is a
 *     deliberate one;
 *   - THE FIX: the waiting popup carries showCloseButton, and dismissing it
 *     that way closes the tool dialog and shows NOTHING — where the original
 *     offered only "Show the old code anyway";
 *   - the empty dialog card behind the popup is hidden for the whole flow
 *     (a <style> in the SHELL's head) and closed on every exit, exactly once
 *     — and the style is removed on every exit AND on a teardown that skips
 *     them, because a leaked one would leave every later tool dialog in the
 *     tab invisible;
 *   - the countdown is reached through didOpen's popup handle, not through
 *     this frame's getElementById (which would silently find nothing);
 *   - the licence is spent on DRAWING only: data still goes through ycTool,
 *     and the page never touches the token, AUTH_STATE or isJwtExpired.
 *
 * Run:  npx jest tests/clioTool2.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { boot, jwt } = require('./helpers/toolShell');

const TOOL = fs.readFileSync(path.join(__dirname, '..', 'ref/tools/clio-code-2.html'), 'utf8');
const ITEM = { id: 'firm:clio2', label: 'Get Clio Code 2', icon: 'c', action: { type: 'tool', key: 'clio-code-2', present: 'modal', size: 'compact' } };

const OLD = { value: '111111', updated_at: '2026-10-12T14:00:00.000Z', age_seconds: 3 * 86400 };
const NEW = { value: '222222', updated_at: '2026-10-15T15:00:20.000Z', age_seconds: 2 };

/** A SweetAlert2 double on the shell's window: records each fire() and hands
 *  back a promise the test resolves by hand (`sw.settle(n, result)`). The real
 *  popup's DOM is built from the `html` option so didOpen's querySelector —
 *  the page's only route to the countdown — works exactly as it does live. */
function installSwal(w) {
  const fires = [];
  const Swal = {
    DismissReason: { cancel: 'cancel', close: 'close', esc: 'esc', backdrop: 'backdrop' },
    fire(opts) {
      // A fire() while one is open resolves the open one, as SweetAlert does.
      const prev = fires[fires.length - 1];
      if (prev && !prev.resolved) prev.resolve({ isConfirmed: false, isDismissed: true, dismiss: 'close' });
      const popup = w.document.createElement('div');
      popup.className = 'swal2-popup';
      popup.innerHTML = opts.html || '';
      w.document.body.appendChild(popup);
      const rec = { opts, popup, resolved: false };
      rec.promise = new Promise((res) => {
        rec.resolve = (r) => { if (rec.resolved) return; rec.resolved = true; popup.remove(); res(r); };
      });
      fires.push(rec);
      if (opts.didOpen) opts.didOpen(popup);
      return rec.promise;
    },
  };
  Object.defineProperty(w, 'Swal', { value: Swal, writable: true, configurable: true });
  return {
    fires,
    last: () => fires[fires.length - 1],
    confirm: (i = fires.length - 1) => fires[i].resolve({ isConfirmed: true, isDismissed: false }),
    cancel: (i = fires.length - 1) => fires[i].resolve({ isConfirmed: false, isDismissed: true, dismiss: 'cancel' }),
    closeBtn: (i = fires.length - 1) => fires[i].resolve({ isConfirmed: false, isDismissed: true, dismiss: 'close' }),
  };
}

/** The shell with the Clio 2 firm item, its dialog open, the tool mounted. */
async function start({ codes = [NEW], kick = { processed: 0 }, token, swal = true } = {}) {
  let n = 0;
  const routes = {
    'GET /clio-code': () => (typeof codes === 'function' ? codes(n++) : codes[Math.min(n++, codes.length - 1)]),
    'POST /process-jobs': () => (typeof kick === 'function' ? kick() : kick),
  };
  const t = boot(token ? { routes, token } : { routes });
  const sw = swal ? installSwal(t.w) : { fires: [] };
  t.L.applyAccess({ ui: { firm: { registry_overrides: { items: [ITEM] } }, user: {} } });
  t.L.exec('firm:clio2');
  const m = t.mountTool(TOOL);
  await t.settle();
  const gets = () => t.rec.fetch.filter((f) => f.path === '/clio-code').length;
  const kicks = () => t.rec.fetch.filter((f) => f.path === '/process-jobs').length;
  return { ...t, ...m, sw, gets, kicks };
}

// ─────────────────────────────────────────────────────────────────────────
describe('a fresh code', () => {
  test('the original popup: info icon, Copy Code / Close, the code and its freshness', async () => {
    const c = await start({ codes: [{ ...NEW, age_seconds: 30 }] });
    expect(c.sw.fires).toHaveLength(1);
    const o = c.sw.last().opts;
    expect(o.title).toBe('Clio Login Code');
    expect(o.icon).toBe('info');
    expect(o.confirmButtonText).toBe('Copy Code');
    expect(o.cancelButtonText).toBe('Close');
    expect(o.showCancelButton).toBe(true);
    expect(c.sw.last().popup.textContent.replace(/\s+/g, ' ').trim())
      .toBe('222222 Updated Oct 15, 2026, 11:00 AM EDT Just updated');
    expect(c.fd.body.textContent.trim()).toBe('');                 // the frame itself draws nothing
    expect([c.gets(), c.kicks()]).toEqual([1, 1]);
    c.close();
  });

  test('Copy Code: the copy finishes before the dialog card is dropped', async () => {
    const c = await start();
    // A clipboard that does not resolve until this test says so. T.close()
    // unloads this frame live, so a write that is merely STARTED goes with
    // it — the card must wait for the write, not race it.
    let land = null;
    const written = [];
    Object.defineProperty(c.fw.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (v) => new Promise((res) => { written.push(v); land = res; }) },
    });
    c.sw.confirm();
    await c.settle();
    expect(written).toEqual(['222222']);
    expect(c.dlgOpen()).toBe(true);                                 // still up: the write is in flight
    land();
    await c.settle();
    expect(c.dlgOpen()).toBe(false);                                // the empty card goes too
    c.close();
  });

  test('Close drops the dialog card without copying', async () => {
    const c = await start();
    c.sw.cancel();
    await c.settle();
    expect(c.copied).toEqual([]);
    expect(c.dlgOpen()).toBe(false);
    c.close();
  });

  test.each([[59, 'Just updated'], [60, 'Recently updated'], [180, 'Recently updated']])('age %is → "%s"', async (age, label) => {
    const c = await start({ codes: [{ ...NEW, age_seconds: age }] });
    expect(c.sw.last().popup.textContent).toContain(label);
    c.close();
  });

  test.each([[181], [240], [null]])('age %p is past the 180 s window → the waiting popup, never the code as usable', async (age) => {
    const c = await start({ codes: [{ ...NEW, age_seconds: age }] });
    expect(c.sw.last().opts.title).toBe('Waiting for a new code');
    c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a stale code', () => {
  test('the original waiting popup — warning icon, no confirm, the dead code in a sentence', async () => {
    const c = await start({ codes: [OLD] });
    const o = c.sw.last().opts;
    expect(o.title).toBe('Waiting for a new code');
    expect(o.icon).toBe('warning');
    expect(o.showConfirmButton).toBe(false);
    expect(o.cancelButtonText).toBe('Show the old code anyway');
    expect(o.allowOutsideClick).toBe(false);
    expect(c.sw.last().popup.textContent.replace(/\s+/g, ' ')).toContain(
      'The last code (111111) arrived Oct 12, 2026, 10:00 AM EDT — it is 3 days old and will not work.');
    c.close();
  });

  test('THE FIX: it carries a close button, and closing it shows nothing', async () => {
    const c = await start({ codes: [OLD] });
    expect(c.sw.last().opts.showCloseButton).toBe(true);
    c.sw.closeBtn();
    await c.settle();
    expect(c.sw.fires).toHaveLength(1);                             // no "here is the dead code anyway"
    expect(c.dlgOpen()).toBe(false);
    expect(c.clock.pending()).toBe(0);                              // and the ticker stopped
    c.close();
  });

  test('"Show the old code anyway" still hands over the old code', async () => {
    const c = await start({ codes: [OLD] });
    c.sw.cancel();
    await c.settle();
    expect(c.sw.fires).toHaveLength(2);
    expect(c.sw.last().opts.title).toBe('Clio Login Code');
    expect(c.sw.last().popup.textContent).toContain('111111');
    expect(c.dlgOpen()).toBe(true);                                 // still open: the code is on screen
    c.close();
  });

  test('the countdown repaints inside the shell popup, and "Check now" is wired there', async () => {
    const c = await start({ codes: [OLD] });
    const popup = c.sw.last().popup;
    expect(popup.querySelector('#clioNextCheck').textContent).toBe('Next check in 5s');
    await c.clock.tick(1000);
    expect(popup.querySelector('#clioNextCheck').textContent).toBe('Next check in 4s');
    popup.querySelector('#clioCheckNow').click();
    await c.settle();
    expect(c.gets()).toBe(2);
    c.close();
  });

  test('re-checked every 5 s; the new code replaces the wait the moment it lands', async () => {
    const c = await start({ codes: [OLD, OLD, NEW] });
    await c.clock.tick(4900);
    expect(c.gets()).toBe(1);
    await c.clock.tick(100);
    expect(c.gets()).toBe(2);
    expect(c.sw.last().opts.title).toBe('Waiting for a new code');
    await c.clock.tick(5000);
    expect(c.gets()).toBe(3);
    expect(c.sw.last().opts.title).toBe('Clio Login Code');
    expect(c.sw.last().popup.textContent).toContain('222222');
    expect(c.clock.pending()).toBe(0);                              // the ticker stopped
    expect(c.dlgOpen()).toBe(true);
    c.close();
  });

  test('the swap does not close the frame out from under the new popup', async () => {
    const c = await start({ codes: [OLD, NEW] });
    await c.clock.tick(5000);
    expect(c.sw.last().opts.title).toBe('Clio Login Code');
    expect(c.dlgOpen()).toBe(true);                                 // settled guard held
    c.sw.cancel();
    await c.settle();
    expect(c.dlgOpen()).toBe(false);                                // and the real exit still closes
    c.close();
  });

  test('gives up after 120 s and shows the best it has', async () => {
    const c = await start({ codes: [OLD] });
    await c.clock.tick(120000);
    expect(c.sw.last().opts.title).toBe('Clio Login Code');
    expect(c.sw.last().popup.textContent).toContain('111111');
    expect(c.clock.pending()).toBe(0);
    c.close();
  });

  test('no stored code: the sentence says so and no age is claimed', async () => {
    const c = await start({ codes: [{ value: null, updated_at: null, age_seconds: null }] });
    expect(c.sw.last().popup.textContent.replace(/\s+/g, ' '))
      .toContain('The last code (none stored) is of unknown age and cannot be trusted.');
    c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the dialog card it hides behind the popup', () => {
  /** The rule the tool appends to the SHELL's head, or null. */
  const rule = (c) => {
    const el = c.d.querySelector('style[data-clio-code-2]');
    return el ? el.textContent.replace(/\s+/g, '') : null;
  };

  test('hidden from the first moment — the whole dialog, so the second backdrop goes too', async () => {
    const c = await start();
    // #ycToolDialog, not .yc-td: the dialog carries its own --backdrop, which
    // would stack under swal's and dim the app twice.
    expect(rule(c)).toBe('#ycToolDialog{opacity:0;pointer-events:none}');
    c.close();
  });

  test('never display:none — a frame that stops rendering is a countdown at the mercy of throttling', async () => {
    const c = await start({ codes: [OLD] });
    expect(rule(c)).not.toContain('display:none');
    c.close();
  });

  test.each([
    ['Copy Code', (c) => c.sw.confirm()],
    ['Close', (c) => c.sw.cancel()],
  ])('%s puts the shell back before the dialog closes', async (_label, act) => {
    const c = await start();
    expect(rule(c)).not.toBeNull();
    act(c);
    await c.settle();
    expect(rule(c)).toBeNull();
    expect(c.dlgOpen()).toBe(false);
    c.close();
  });

  test('the waiting popup\'s close button puts it back too', async () => {
    const c = await start({ codes: [OLD] });
    c.sw.closeBtn();
    await c.settle();
    expect(rule(c)).toBeNull();
    c.close();
  });

  test('it stays hidden across the swap from waiting to the code', async () => {
    const c = await start({ codes: [OLD, NEW] });
    await c.clock.tick(5000);
    expect(c.sw.last().opts.title).toBe('Clio Login Code');
    expect(rule(c)).not.toBeNull();                                 // still the popup's turn
    c.sw.cancel();
    await c.settle();
    expect(rule(c)).toBeNull();
    c.close();
  });

  test('backstop: a teardown that skips every exit path still puts it back', async () => {
    const c = await start({ codes: [OLD] });
    expect(rule(c)).not.toBeNull();
    c.fw.dispatchEvent(new c.fw.Event('pagehide'));
    expect(rule(c)).toBeNull();
    c.close();
  });

  test('no Swal to draw with: the card is left alone, because the fallback needs it', async () => {
    const c = await start({ swal: false });
    await c.clock.tick(6000);
    expect(rule(c)).toBeNull();
    expect(c.fd.getElementById('fallback').hidden).toBe(false);
    c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('errors, the licence, and the contract', () => {
  test('a failed fetch shows the error popup and drops the card', async () => {
    const c = await start({ codes: () => { throw new Error('boom'); } });
    const o = c.sw.last().opts;
    expect([o.title, o.text, o.icon]).toEqual(['Error', 'Unable to fetch login code', 'error']);
    c.sw.cancel();
    await c.settle();
    expect(c.dlgOpen()).toBe(false);
    c.close();
  });

  test('no Swal on the shell: it says so and draws its own fallback instead', async () => {
    const c = await start({ swal: false });
    await c.clock.tick(6000);
    expect(c.fd.getElementById('fallback').hidden).toBe(false);
    expect(c.fd.body.textContent).toContain('Use Get Clio Code instead');
    c.close();
  });

  test.each([
    ['the code popup', { ...NEW, value: '<img src=x onerror=alert(1)>' }],
    ['the waiting popup', { ...OLD, value: '<img src=x onerror=alert(1)>' }],
  ])('server text is escaped into %s, never injected as markup', async (_label, code) => {
    const c = await start({ codes: [code] });
    const popup = c.sw.last().popup;
    expect(popup.querySelector('img')).toBeNull();
    expect(popup.textContent).toContain('<img src=x onerror=alert(1)>');
    c.close();
  });

  test('the licence is spent on DRAWING only: data rides ycTool, the token is never read', async () => {
    const c = await start();
    expect(c.rec.fetch.length).toBeGreaterThan(0);                  // it really did call the API
    expect(c.parentReads).toEqual(expect.arrayContaining(['ycTool']));
    expect(c.parentReads).not.toEqual(expect.arrayContaining(['AUTH_STATE', 'isJwtExpired', 'apiSend']));
    c.close();
  });

  test('the source reads no token-bearing global, and touches the shell in exactly two places', async () => {
    const code = TOOL.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/AUTH_STATE|isJwtExpired|localStorage|sessionStorage|document\.cookie|\bjwt\b/);
    expect(code).not.toMatch(/parent\.(?!ycTool)/);
    // The TWO deliberate reaches, both argued in the header: the popup
    // library it draws with, and the head it hides the dialog through.
    // A third one appearing here is a decision, not a refactor — this list
    // is the place it has to be made.
    expect([...new Set(code.match(/\btop\.\w+/g) || [])].sort()).toEqual(['top.Swal', 'top.document']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a session that lapses mid-wait never pops the login', () => {
  test('expired → no check, no nudge, no prompt, the popup keeps counting; back → checks resume', async () => {
    const c = await start({ codes: [OLD, NEW] });
    const g = c.gets(), k = c.kicks();
    c.w.AUTH_STATE.jwt = jwt(-30);
    await c.clock.tick(30000);
    c.sw.last().popup.querySelector('#clioCheckNow').click();
    await c.settle();
    expect([c.gets(), c.kicks(), c.rec.login]).toEqual([g, k, 0]);
    expect(c.sw.last().popup.querySelector('#clioNextCheck').textContent).toMatch(/^Next check in \ds$/);
    expect(c.sw.last().opts.title).toBe('Waiting for a new code');
    c.w.AUTH_STATE.jwt = jwt(600);
    await c.clock.tick(5000);
    expect(c.sw.last().opts.title).toBe('Clio Login Code');
    expect(c.sw.last().popup.textContent).toContain('222222');
    expect(c.rec.login).toBe(0);
    c.close();
  });
});
