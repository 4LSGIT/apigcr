/**
 * tests/tasksUi.boot.test.js
 *
 * BOOTS public/tasks.html for real, in jsdom, against a stub shell.
 *
 * Why this file exists: the task UI shipped two bugs that no amount of code
 * reading caught, because both only manifest when the page actually runs —
 *
 *   1. `applyPreset` was called from four inline onclick attributes and never
 *      defined. Nothing in the module graph references it, so a static read
 *      cannot see the hole.
 *   2. `const PRESETS` sat BELOW the waitForShell IIFE. When the shell is
 *      already warm the IIFE calls init() DURING script evaluation, so the
 *      init → fetchTasks → syncPresetHighlight chain reached PRESETS while it
 *      was still in its temporal dead zone. Fatal: the page rendered nothing.
 *
 * Both are the same shape — a reference that is only resolved at run time —
 * and both are caught here by simply executing the thing.
 *
 * The harness stubs only what the SHELL provides (apiSend, firmData, user,
 * body for the theme observer) plus the handful of globals tasks.html gets
 * from /scripts.js (E, Toast, Swal, getTabPref/setTabPref, renderEventsFooter).
 * Everything else is the real file, inline script and all.
 *
 *   npx jest tests/tasksUi.boot.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/tasks.html'), 'utf8');

// Close every window so jsdom timers (waitForShell's 100ms poll, the query
// debounce) don't hold jest open.
const DOMS = [];
afterAll(() => DOMS.forEach(d => { try { d.window.close(); } catch (_) { /* noop */ } }));

const USERS = [
  { user: 6,  user_name: 'Fred Ross',        user_type: 'staff' },
  { user: 22, user_name: 'Rena Grunberger',  user_type: 'staff' },
];

function mkTask(over = {}) {
  return {
    id: 1, status: 'Pending', title: 'Call the trustee', desc: '',
    due: '2099-01-01', start: null, created: '2026-08-01T12:00:00.000Z', notify: false,
    from: { id: 6, name: 'Fred Ross' }, to: { id: 22, name: 'Rena Grunberger' },
    link: null, action_token: 'tok', source: null, ...over,
  };
}

/**
 * Boot tasks.html in jsdom.
 *
 * @param {object}   o
 * @param {string}   o.search   querystring, e.g. '?link_type=case&link_id=5'
 * @param {object[]} o.tasks    rows the stub API returns
 * @param {boolean}  o.warmShell  true → window.top.apiSend exists BEFORE the
 *                   inline script runs, which is what makes waitForShell take
 *                   its synchronous path. This is the real-world case (the
 *                   shell is long-lived) and the one that exposed the TDZ.
 */
async function boot({ search = '', tasks = [mkTask()], warmShell = true } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://app.4lsg.com/tasks.html' + search,
    runScripts: 'dangerously',
  });
  DOMS.push(dom);
  const { window } = dom;

  const calls = [];
  const apiSend = async (url, method, params) => {
    calls.push({ url, method, params });
    if (/\/history$/.test(url)) return { data: [] };
    if (url === '/api/tasks' && method === 'GET') {
      return { data: tasks, total: tasks.length };
    }
    return { status: 'success', title: 'ok', message: 'ok' };
  };

  // ── The shell, as tasks.html sees it (window.top). ───────────────────────
  // jsdom's window.top is non-configurable, but for a top-level window it IS
  // the window — so putting the shell's surface directly on `window` makes
  // every `window.top.X` lookup in tasks.html resolve exactly as it does in
  // the real iframe. Fidelity that matters is preserved: apiSend, firmData,
  // user, addFile and top.document.body (the theme observer) are all reached
  // through the same expression the shipped file uses.
  if (warmShell) {
    window.apiSend  = apiSend;
    window.firmData = { users: USERS, firmTimezone: 'America/Detroit' };
    window.user     = { user: 6, user_name: 'Fred Ross' };
    window.addFile  = () => {};
  }

  // ── Globals tasks.html gets from /scripts.js (not loaded here). ──────────
  window.E = (id) => window.document.getElementById(id);
  window.getTabPref = (t, k, d) => d;
  window.setTabPref = () => {};
  window.renderEventsFooter = () => {};
  window.Toast = { fire: () => {} };
  window.Swal = { fire: async () => ({ isConfirmed: false }), close: () => {}, showLoading: () => {}, update: () => {} };

  // Body markup + the inline script, exactly as shipped.
  window.document.body.innerHTML = HTML
    .slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script>'));
  const script = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'));

  // The boot chain is async (init → fetchTasks), so a throw inside it surfaces
  // as an UNHANDLED REJECTION, not an 'error' event — which is precisely how
  // the PRESETS TDZ bug reached production looking like a silent blank page.
  const errors = [];
  window.addEventListener('error', e => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
  // A TDZ / ReferenceError during evaluation throws straight out of eval.
  window.eval(script);

  // Let the boot chain (and any promise microtasks) settle.
  await new Promise(r => window.setTimeout(r, 50));
  return { dom, window, calls, errors, script };
}

// ─────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────

describe('tasks.html boots', () => {
  test('WARM shell (init runs during script evaluation) — no TDZ, page renders', async () => {
    const { window, errors } = await boot({ warmShell: true });
    expect(errors).toEqual([]);
    expect(window.document.getElementById('tkMain').style.display).toBe('block');
    expect(window.document.getElementById('tkError').style.display).not.toBe('block');
    // One data row rendered (header row + 1).
    expect(window.document.querySelectorAll('#tasksTable tr').length).toBe(2);
  });

  test('COLD shell (waitForShell polls) also boots once apiSend appears', async () => {
    const { window, errors } = await boot({ warmShell: false });
    expect(errors).toEqual([]);
    // Nothing rendered yet — the poll is still waiting.
    expect(window.document.getElementById('tkMain').style.display).not.toBe('block');
  });

  test('shell-mode list sends a status param on every request (All must not mean Incomplete)', async () => {
    const { window, calls } = await boot();
    const list = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].params.status).toBe('Incomplete');

    window.document.getElementById('fStatus').value = 'All';
    await window.tasksSetFilter({ status: 'All' });
    await new Promise(r => window.setTimeout(r, 20));
    const last = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params).pop();
    expect(last.params.status).toBe('All');
  });
});

// ─────────────────────────────────────────────────────────────
// Preset chips — the regression that started this file
// ─────────────────────────────────────────────────────────────

describe('preset chips', () => {
  test('every chip onclick resolves to a real function', async () => {
    const { window } = await boot();
    const chips = [...window.document.querySelectorAll('.tk-preset')];
    expect(chips.length).toBe(5);
    for (const chip of chips) {
      const fnName = /(\w+)\s*\(/.exec(chip.getAttribute('onclick'))[1];
      expect(typeof window[fnName]).toBe('function');
    }
  });

  test('clicking "My open" scopes to the current user and refetches', async () => {
    const { window, calls } = await boot();
    const before = calls.length;
    window.document.querySelector('[data-preset="mine"]').click();
    await new Promise(r => window.setTimeout(r, 20));
    expect(calls.length).toBeGreaterThan(before);
    const last = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params).pop();
    expect(String(last.params.assigned_to)).toBe('6');
    expect(last.params.status).toBe('Incomplete');
  });

  test('clicking "Notices" filters to machine sources', async () => {
    const { window, calls } = await boot();
    window.document.querySelector('[data-preset="notices"]').click();
    await new Promise(r => window.setTimeout(r, 20));
    const last = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params).pop();
    expect(last.params.source).toBe('machine');
    expect(last.params.assigned_to).toBeUndefined();
  });

  test('the chip matching current state is highlighted; hand-editing clears it', async () => {
    const { window } = await boot();
    // Default view (Incomplete / all / unassigned) === "All open".
    expect(window.document.querySelector('[data-preset="allopen"]').classList.contains('on')).toBe(true);

    window.document.querySelector('[data-preset="mine"]').click();
    await new Promise(r => window.setTimeout(r, 20));
    expect(window.document.querySelector('[data-preset="mine"]').classList.contains('on')).toBe(true);
    expect(window.document.querySelector('[data-preset="allopen"]').classList.contains('on')).toBe(false);

    // Hand-edit away from the preset → no chip claims the view.
    window.document.getElementById('fStatus').value = 'Deleted';
    window.document.getElementById('fStatus').dispatchEvent(new window.Event('change'));
    await new Promise(r => window.setTimeout(r, 20));
    expect([...window.document.querySelectorAll('.tk-preset')].some(c => c.classList.contains('on'))).toBe(false);
  });

  test('cold-boot from the shell\'s "My Tasks" button lights "My open"', async () => {
    // Must stay in step with index.html's openTasksTab({...}) call.
    const { window } = await boot({ search: '?assigned_to=6&status=Incomplete&defer=active' });
    expect(window.document.querySelector('[data-preset="mine"]').classList.contains('on')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// Entity mode
// ─────────────────────────────────────────────────────────────

describe('entity mode', () => {
  test('valid link scopes the query and hides shell-only controls', async () => {
    const { window, calls } = await boot({ search: '?link_type=case&link_id=42' });
    expect(window.document.body.classList.contains('entity')).toBe(true);
    const last = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params).pop();
    expect(last.params.link_type).toBe('case');
    expect(last.params.link_id).toBe('42');
  });

  test('CRITICAL: a bogus link_type refuses to list — never falls back to every task in the firm', async () => {
    const { window, calls } = await boot({ search: '?link_type=bogus&link_id=5' });
    expect(window.document.getElementById('tkError').style.display).toBe('block');
    expect(window.document.getElementById('tkMain').style.display).not.toBe('block');
    expect(calls.filter(c => c.url === '/api/tasks').length).toBe(0);
  });

  test('link_type with no link_id also refuses', async () => {
    const { window, calls } = await boot({ search: '?link_type=case' });
    expect(window.document.getElementById('tkError').style.display).toBe('block');
    expect(calls.filter(c => c.url === '/api/tasks').length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// Derived status display (B-2 / B-3)
// ─────────────────────────────────────────────────────────────

describe('status is derived from the due date, not read from task_status', () => {
  const todayDetroit = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(new Date());

  test('due today + stored Pending renders "Due Today" (no waiting for the sweep)', async () => {
    const { window } = await boot({ tasks: [mkTask({ status: 'Pending', due: todayDetroit() })] });
    expect(window.document.querySelector('#tasksTable .tk-pill').textContent).toBe('Due Today');
  });

  test('no due date renders "No due date", never "Pending"', async () => {
    const { window } = await boot({ tasks: [mkTask({ status: 'Pending', due: null })] });
    expect(window.document.querySelector('#tasksTable .tk-pill').textContent).toBe('No due date');
  });

  test('terminal status is read as stored, never recomputed', async () => {
    const { window } = await boot({ tasks: [mkTask({ status: 'Completed', due: '2020-01-01' })] });
    expect(window.document.querySelector('#tasksTable .tk-pill').textContent).toBe('Completed');
  });

  test('an overdue row carries an aging badge', async () => {
    const { window } = await boot({ tasks: [mkTask({ status: 'Overdue', due: '2024-07-22' })] });
    expect(window.document.querySelector('#tasksTable .tk-age')).not.toBeNull();
  });

  test('a machine-sourced row carries a humanized source chip', async () => {
    const { window } = await boot({ tasks: [mkTask({ source: 'esign_followup' })] });
    expect(window.document.querySelector('#tasksTable .tk-src').textContent).toContain('E-sign follow-up');
  });
});

// ─────────────────────────────────────────────────────────────
// Start dates ("defer until")
// ─────────────────────────────────────────────────────────────

describe('start dates', () => {
  const plusDays = (n) => {
    const d = new Date(Date.now() + n * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Detroit' }).format(d);
  };

  test('a future start date renders "Scheduled", outranking the due-date pill', async () => {
    const { window } = await boot({
      tasks: [mkTask({ status: 'Pending', start: plusDays(200), due: plusDays(207) })],
    });
    expect(window.document.querySelector('#tasksTable .tk-pill').textContent).toBe('Scheduled');
    expect(window.document.querySelector('#tasksTable .tk-starts')).not.toBeNull();
    expect(window.document.querySelector('#tasksTable tr.deferred')).not.toBeNull();
  });

  test('a PAST start date is not deferred — normal pill, no chip', async () => {
    const { window } = await boot({
      tasks: [mkTask({ status: 'Pending', start: plusDays(-30), due: plusDays(10) })],
    });
    expect(window.document.querySelector('#tasksTable .tk-pill').textContent).toBe('Pending');
    expect(window.document.querySelector('#tasksTable .tk-starts')).toBeNull();
  });

  test('a deferred task shows no aging badge even with a past due date', async () => {
    const { window } = await boot({
      tasks: [mkTask({ status: 'Pending', start: plusDays(200), due: plusDays(-5) })],
    });
    expect(window.document.querySelector('#tasksTable .tk-age')).toBeNull();
  });

  test('terminal tasks are never "Scheduled" regardless of start date', async () => {
    const { window } = await boot({
      tasks: [mkTask({ status: 'Completed', start: plusDays(200) })],
    });
    expect(window.document.querySelector('#tasksTable .tk-pill').textContent).toBe('Completed');
  });

  test('the Scheduled preset sends defer=scheduled', async () => {
    const { window, calls } = await boot();
    window.document.querySelector('[data-preset="scheduled"]').click();
    await new Promise(r => window.setTimeout(r, 20));
    const last = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params).pop();
    expect(last.params.defer).toBe('scheduled');
  });

  test('the My-open preset asks for in-play work only', async () => {
    const { window, calls } = await boot();
    window.document.querySelector('[data-preset="mine"]').click();
    await new Promise(r => window.setTimeout(r, 20));
    const last = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params).pop();
    expect(last.params.defer).toBe('active');
  });

  test('defer=all is omitted from the query (no filter)', async () => {
    const { calls } = await boot();
    const first = calls.filter(c => c.url === '/api/tasks' && c.params && 'limit' in c.params)[0];
    expect(first.params.defer).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Static guard: no inline handler may name a function that doesn't exist
// ─────────────────────────────────────────────────────────────

test('no inline on* handler references an undefined function', async () => {
  const { window } = await boot();
  const known = new Set(['replace']);   // string method inside a template
  const missing = [];
  for (const el of window.document.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (!/^on/.test(attr.name)) continue;
      for (const [, fn] of attr.value.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (known.has(fn)) continue;
        if (typeof window[fn] !== 'function') missing.push(`${attr.name}="${attr.value}" → ${fn}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
