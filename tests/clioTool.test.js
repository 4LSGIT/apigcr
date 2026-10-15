// tests/clioTool.test.js
//
/**
 * ui-custom S3.3 — the Get Clio Code TOOL (ref/tools/clio-code.html, the
 * reference copy of the DB-stored tool `clio-code`), run for real: the shell's
 * own dialog, tool shell API, auth state and apiSend (tests/helpers/
 * toolShell.js) with a scripted backend; the tool page mounted in the dialog's
 * own frame, on a fake clock.
 *
 * It ports the shell's showClioCode() (public/index.html), so the paths are
 * that function's: a fresh code shown (copy → clipboard, toast, close); a
 * stale code named as dead while it waits — re-checks every 5 s, gives up
 * after 120 s showing the best it has, "Check now", "Show the old code
 * anyway"; the job-queue nudge (POST /process-jobs) every 10 s, never two in
 * flight, and a nudge that ran something re-checks at once; a session that
 * lapses mid-wait never pops the login (quiet); the fetch error.
 *
 * And the contract: the page reads NOTHING off its parent but `ycTool` — never
 * AUTH_STATE, isJwtExpired, apiSend or Swal — and renders server text as text.
 *
 * Mutation-checked (see local/ui-custom/S3.3_worker_report.md).
 *
 * Run:  npx jest tests/clioTool.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { boot, jwt } = require('./helpers/toolShell');

const TOOL = fs.readFileSync(path.join(__dirname, '..', 'ref/tools/clio-code.html'), 'utf8');
const ITEM = { id: 'firm:clio', label: 'Get Clio Code', icon: 'c', action: { type: 'tool', key: 'clio-code', present: 'modal', size: 'compact' } };

const OLD = { value: '111111', updated_at: '2026-10-12T14:00:00.000Z', age_seconds: 3 * 86400 };
const NEW = { value: '222222', updated_at: '2026-10-15T15:00:20.000Z', age_seconds: 2 };

/** The shell with the Clio firm item, its dialog open, the tool mounted.
 *  codes: what successive GET /clio-code calls answer (the last repeats); a
 *  function gets the call number. kick: the POST /process-jobs answer. */
async function start({ codes = [NEW], kick = { processed: 0 }, token, noShell = false } = {}) {
  let n = 0;
  const routes = {
    'GET /clio-code': () => (typeof codes === 'function' ? codes(n++) : codes[Math.min(n++, codes.length - 1)]),
    'POST /process-jobs': () => (typeof kick === 'function' ? kick() : kick),
  };
  const t = boot(token ? { routes, token } : { routes });
  t.L.applyAccess({ ui: { firm: { registry_overrides: { items: [ITEM] } }, user: {} } });
  t.L.exec('firm:clio');
  const m = t.mountTool(TOOL, { noShell });
  await t.settle();
  // the page's text, block by block (inline <b> stays inside its sentence)
  const text = () => [...m.fd.querySelectorAll('#app h1, #app p, #app .cc-code, #app button, #app #clioNextCheck')]
    .map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' ');
  const btn = (label) => [...m.fd.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const gets = () => t.rec.fetch.filter((f) => f.path === '/clio-code').length;
  const kicks = () => t.rec.fetch.filter((f) => f.path === '/process-jobs').length;
  return { ...t, ...m, text, btn, gets, kicks };
}

// ─────────────────────────────────────────────────────────────────────────
describe('a fresh code', () => {
  test('shown at once, with when and how fresh; the queue nudged once in parallel', async () => {
    const c = await start({ codes: [{ ...NEW, age_seconds: 30 }] });
    expect(c.w.openToolDialog.size()).toBe('compact');
    expect(c.fd.querySelector('.cc-code').textContent).toBe('222222');
    expect(c.text()).toMatch(/^Clio Login Code 222222 Updated Oct 15, 2026, 11:00 AM EDT Just updated Copy Code Close$/);
    expect([c.gets(), c.kicks()]).toEqual([1, 1]);
    expect(c.clock.pending()).toBe(0);                            // no ticker on the fresh path
    c.close();
  });

  test.each([[59, 'Just updated'], [60, 'Recently updated'], [180, 'Recently updated']])('age %is → "%s"', async (age, label) => {
    const c = await start({ codes: [{ ...NEW, age_seconds: age }] });
    expect(c.text()).toContain(label);
    c.close();
  });

  test.each([[181], [240], [299], [null]])('age %p is past the 180 s window → the stale view, never the code as usable', async (age) => {
    const c = await start({ codes: [{ ...NEW, age_seconds: age }] });
    expect(c.fd.querySelector('.cc-code')).toBeNull();
    expect(c.text()).toContain('Waiting for a new code');
    c.close();
  });

  test('Copy Code: to the clipboard, a toast, and the dialog closes', async () => {
    const c = await start();
    c.btn('Copy Code').click();
    await c.settle();
    expect(c.copied).toEqual(['222222']);
    expect(c.rec.toast).toEqual([{ icon: 'success', titleText: 'Code copied' }]);
    expect(c.dlgOpen()).toBe(false);
    c.close();
  });

  test('Close closes the dialog', async () => {
    const c = await start();
    c.btn('Close').click();
    expect(c.dlgOpen()).toBe(false);
    c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('a stale code', () => {
  test('named as dead, not shown as usable; the countdown runs', async () => {
    const c = await start({ codes: [OLD] });
    expect(c.fd.querySelector('.cc-code')).toBeNull();
    expect(c.text()).toContain('Waiting for a new code');
    expect(c.text()).toContain('The last code (111111) arrived Oct 12, 2026, 10:00 AM EDT — it is 3 days old and will not work.');
    expect(c.fd.getElementById('clioNextCheck').textContent).toBe('Next check in 5s');
    await c.clock.tick(1000);
    expect(c.fd.getElementById('clioNextCheck').textContent).toBe('Next check in 4s');
    c.close();
  });

  test('re-checked every 5 s; the new code replaces the wait the moment it lands', async () => {
    const c = await start({ codes: [OLD, OLD, NEW] });
    await c.clock.tick(4900);
    expect(c.gets()).toBe(1);
    await c.clock.tick(100);
    expect(c.gets()).toBe(2);
    expect(c.text()).toContain('Waiting for a new code');
    await c.clock.tick(5000);
    expect(c.gets()).toBe(3);
    expect(c.fd.querySelector('.cc-code').textContent).toBe('222222');
    expect(c.clock.pending()).toBe(0);                            // the ticker stopped
    await c.clock.tick(30000);
    expect(c.gets()).toBe(3);
    c.close();
  });

  test('a new value with the same updated_at counts (ON UPDATE does not fire on an identical write) — and so does a new updated_at alone', async () => {
    const a = await start({ codes: [OLD, { ...OLD, value: '333333' }] });
    await a.clock.tick(5000);
    expect(a.fd.querySelector('.cc-code').textContent).toBe('333333');
    a.close();
    const b = await start({ codes: [OLD, { ...OLD, updated_at: NEW.updated_at }] });
    await b.clock.tick(5000);
    expect(b.fd.querySelector('.cc-code').textContent).toBe('111111');
    b.close();
  });

  test('gives up after 120 s and shows the best it has', async () => {
    const c = await start({ codes: [OLD] });
    await c.clock.tick(119000);
    expect(c.text()).toContain('Waiting for a new code');
    await c.clock.tick(1000);
    expect(c.fd.querySelector('.cc-code').textContent).toBe('111111');
    expect(c.gets()).toBeGreaterThanOrEqual(20);
    expect(c.gets()).toBeLessThanOrEqual(25);
    expect(c.clock.pending()).toBe(0);
    c.close();
  });

  test('"Show the old code anyway" shows it and stops waiting', async () => {
    const c = await start({ codes: [OLD] });
    c.btn('Show the old code anyway').click();
    await c.settle();
    expect(c.fd.querySelector('.cc-code').textContent).toBe('111111');
    expect(c.clock.pending()).toBe(0);
    const g = c.gets();
    await c.clock.tick(20000);
    expect(c.gets()).toBe(g);
    c.close();
  });

  test('"Check now" nudges and checks at once, and never closes anything', async () => {
    const c = await start({ codes: [OLD, NEW] });
    c.btn('Check now').click();
    await c.settle();
    expect([c.gets(), c.kicks()]).toEqual([2, 2]);
    expect(c.fd.querySelector('.cc-code').textContent).toBe('222222');
    expect(c.dlgOpen()).toBe(true);
    c.close();
  });

  test('unknown age (updated_at NULL) is stale, and says it cannot be trusted', async () => {
    const c = await start({ codes: [{ value: '444444', updated_at: null, age_seconds: null }] });
    expect(c.text()).toContain('The last code (444444) is of unknown age and cannot be trusted.');
    c.close();
    const e = await start({ codes: [{ value: '', updated_at: OLD.updated_at, age_seconds: 900 }] });
    expect(e.text()).toContain('The last code (none stored) arrived');
    e.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('the job-queue nudge', () => {
  test('every 10 s while waiting, never two in flight', async () => {
    let release = null;
    const c = await start({ codes: [OLD], kick: () => new Promise((r) => { release = r; }) });
    expect(c.kicks()).toBe(1);
    await c.clock.tick(60000);
    expect(c.kicks()).toBe(1);                                      // the first one is still out
    release({ processed: 0 });
    await c.settle();
    await c.clock.tick(250);
    expect(c.kicks()).toBe(2);
    c.close();
  });

  test('a nudge that ran something re-checks at once instead of waiting out the countdown', async () => {
    let release = null;
    const c = await start({ codes: [OLD], kick: () => new Promise((r) => { release = r; }) });
    await c.clock.tick(5000);                                       // the regular check at 5 s; next due at 10 s
    expect(c.gets()).toBe(2);
    await c.clock.tick(2000);
    release({ processed: 1 });                                      // the first nudge comes back at 7 s: it ran a job
    await c.settle();
    await c.clock.tick(250);
    expect(c.gets()).toBe(3);                                       // checked at 7.25 s, not 10 s
    c.close();
  });
});

describe('a session that lapses mid-wait never pops the login', () => {
  test('expired → no check, no nudge, no prompt, the countdown keeps going; back → checks resume', async () => {
    const c = await start({ codes: [OLD, NEW] });
    const g = c.gets(), k = c.kicks();
    c.w.AUTH_STATE.jwt = jwt(-30);
    await c.clock.tick(30000);
    c.btn('Check now').click();
    await c.settle();
    expect([c.gets(), c.kicks(), c.rec.login]).toEqual([g, k, 0]);
    expect(c.fd.getElementById('clioNextCheck').textContent).toMatch(/^Next check in \ds$/);
    expect(c.text()).toContain('Waiting for a new code');
    c.w.AUTH_STATE.jwt = jwt(600);
    await c.clock.tick(5000);
    expect(c.fd.querySelector('.cc-code').textContent).toBe('222222');
    expect(c.rec.login).toBe(0);
    c.close();
  });

  test('a lapse between the tool\'s own check and its request is refused quietly too (quiet apiSend)', async () => {
    const c = await start({ codes: [OLD, NEW] });
    await c.clock.tick(4900);
    // From here the session reads valid twice (the page's authReady: jwt, then
    // its expiry) and expired after — it lapses between the page's guard and
    // the request.
    const valid = jwt(600), expired = jwt(-30);
    let reads = 0;
    Object.defineProperty(c.w.AUTH_STATE, 'jwt', { configurable: true, get: () => (++reads <= 2 ? valid : expired), set() {} });
    await c.clock.tick(100);
    expect(reads).toBeGreaterThan(2);
    expect([c.rec.login, c.gets()]).toEqual([0, 1]);
    expect(c.log.join('\n')).toMatch(/clio-code check failed, will retry ToolAuthError/);
    expect(c.text()).toContain('Waiting for a new code');
    c.close();
  });

  test('a lapse between the nudge\'s own check and its request is refused quietly too', async () => {
    const c = await start({ codes: [OLD] });
    await c.clock.tick(9900);                                       // the 10 s nudge is next
    const k = c.kicks();
    const valid = jwt(600), expired = jwt(-30);
    let reads = 0;
    Object.defineProperty(c.w.AUTH_STATE, 'jwt', { configurable: true, get: () => (++reads <= 2 ? valid : expired), set() {} });
    await c.clock.tick(100);
    expect(reads).toBeGreaterThan(2);
    expect([c.rec.login, c.kicks()]).toEqual([0, k]);
    expect(c.log.join('\n')).toMatch(/process-jobs kick failed ToolAuthError/);
    c.close();
  });

  test('expired before it opened: the first read prompts as the shell always did; the nudge does not', async () => {
    const c = await start({ token: jwt(-30), codes: [{ ...NEW, age_seconds: 5 }] });
    expect([c.rec.login, c.kicks(), c.gets()]).toEqual([1, 0, 1]);
    expect(c.fd.querySelector('.cc-code').textContent).toBe('222222');
    c.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('errors, text, and the contract', () => {
  test('a failed read says so, with a Close', async () => {
    const c = await start({ codes: [{ status: 500, body: { error: 'Server error' } }] });
    expect(c.text()).toBe('Error Unable to fetch login code Close');
    c.btn('Close').click();
    expect(c.dlgOpen()).toBe(false);
    c.close();
  });

  test('server text is text: markup in the code never becomes an element', async () => {
    const x = '<img src=x onerror="parent.__pwned=1">';
    const a = await start({ codes: [{ ...NEW, value: x, age_seconds: 1 }] });
    const b = await start({ codes: [{ ...OLD, value: x }] });
    for (const c of [a, b]) {
      expect(c.fd.querySelector('img')).toBeNull();
      expect(c.text()).toContain(x);
      c.close();
    }
  });

  test('it reads nothing off its parent but ycTool — on every path', async () => {
    const runs = [];
    let c = await start({ codes: [{ ...NEW, age_seconds: 1 }] });
    c.btn('Copy Code').click(); await c.settle(); runs.push(c.parentReads); c.close();
    c = await start({ codes: [OLD, OLD, NEW] });
    await c.clock.tick(10000); c.btn('Close').click(); runs.push(c.parentReads); c.close();
    c = await start({ codes: [OLD] });
    c.w.AUTH_STATE.jwt = jwt(-30);
    await c.clock.tick(20000); c.btn('Check now').click(); c.btn('Show the old code anyway').click(); await c.settle();
    runs.push(c.parentReads); c.close();
    c = await start({ codes: [{ status: 500, body: {} }] });
    runs.push(c.parentReads); c.close();
    for (const reads of runs) {
      expect(reads.length).toBeGreaterThan(0);
      expect([...new Set(reads)]).toEqual(['ycTool']);
    }
  });

  test('the source names no token-bearing shell global', () => {
    const code = TOOL.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/AUTH_STATE|isJwtExpired|localStorage|sessionStorage|document\.cookie|\bjwt\b|Swal/);
    expect(code).not.toMatch(/parent\.(?!ycTool)/);
    expect(code).not.toMatch(/\btop\./);
  });

  test('opened on its own (no shell) it says where to open it, and fetches nothing', async () => {
    const c = await start({ noShell: true });
    const g = c.gets();
    await c.clock.tick(5100);
    expect(c.text()).toContain('Open this from YisraCase');
    expect(c.gets()).toBe(g);
    c.close();
  });
});
