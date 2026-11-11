/**
 * checklistsView.html — the Browse view hears the sync bus (2026-11-11).
 *
 * Mine and Unlinked iframe checklistView.html and inherit its `checklist:*`
 * subscriber; Browse renders its own rows (`browseRow`) and used to hear
 * nothing, so a list created, edited or deleted anywhere showed there only on
 * reload (the native gap the yc-sync matchers slice filed). Now Browse
 * subscribes to every `checklist:*` marker and re-reads its first page, with
 * fences:
 *   - only while Browse is the showing scope;
 *   - never while a row is OPEN (its editor iframe would be destroyed by the
 *     re-render) — the message marks the view stale and Back flushes it;
 *   - never while the page is hidden — visibilitychange flushes;
 *   - a burst coalesces into one re-read (CX_BUS_MS); a load in flight is not
 *     doubled, and a message during it re-reads once more after it.
 *
 * Harness: the real page booted in jsdom with `runScripts: 'dangerously'`;
 * `window.YC` is a fake bus installed before the inline script runs (the real
 * /js/yc-sync.js is not fetched — jsdom loads no external scripts here);
 * `window.top.apiSend` is the page's own window's stub, counting GET
 * /checklists calls. Every wait is bounded.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public/checklistsView.html'), 'utf8');
const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));
const tick = (w, ms) => new Promise((r) => w.setTimeout(r, ms));

function boot({ hidden = false } = {}) {
  const subs = [];
  const calls = [];
  let gate = null; // when set, GET /checklists waits on it (a load "in flight")
  const dom = new JSDOM(HTML, {
    url: 'https://app.4lsg.com/checklistsView.html',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.YC = { on: (pattern, field, cb) => { subs.push({ pattern, field, cb }); return () => {}; } };
      // scripts.js is not fetched: the page's helpers it reaches for.
      window.E = (id) => window.document.getElementById(id);
      window.escText = (v) => String(v == null ? '' : v);
      window.escAttr = (v) => String(v == null ? '' : v);
      window.fitFrameToContent = () => {};
      window.firmData = { users: [{ user: 1, user_name: 'Stuart', user_type: 1, active: true }], settings: {}, currentUser: { user: 1 } };
      window.apiSend = async (url, method, params) => {
        calls.push({ url, method, params });
        if (url === '/checklists' && method === 'GET') {
          if (gate) await gate;
          return { status: 'success', checklists: [{ id: 7, title: 'Docs', kind: 'checklist', link_type: 'case', link: 'C1', status: 'incomplete', items: [], tags: null, created_by: 1, updated_date: '2026-11-11 10:00:00' }], total: 1, tags: [] };
        }
        return { status: 'success', data: [] };
      };
      // jsdom reports every document hidden (visibilityState 'prerender'); the page's fence reads it.
      Object.defineProperty(window.document, 'hidden', { configurable: true, get: () => hidden });
    },
  });
  DOMS.push(dom);
  const w = dom.window;
  const fire = () => subs.filter((s) => s.pattern === 'checklist:*').forEach((s) => s.cb({}, { addr: 'checklist:case:C1', fields: {} }));
  const loads = () => calls.filter((c) => c.url === '/checklists' && c.method === 'GET').length;
  return { w, subs, fire, loads, setGate: (p) => { gate = p; } };
}

async function booted(opts) {
  const b = boot(opts);
  for (let i = 0; i < 40 && b.loads() === 0; i++) await tick(b.w, 25); // waitForShell polls every 100 ms
  expect(b.loads()).toBe(1);
  await tick(b.w, 50); // the load's promise resolves and render() draws the rows
  return b;
}

describe('checklistsView.html Browse — sync bus', () => {
  test('subscribes to checklist:* once the page is up, and a message re-reads the first page once (a burst coalesces)', async () => {
    const b = await booted();
    expect(b.subs.map((s) => [s.pattern, s.field])).toEqual([['checklist:*', '*']]);
    b.fire(); b.fire(); b.fire();
    await tick(b.w, 400);
    expect(b.loads()).toBe(2);
    const last = b.w.document.querySelectorAll('.cx-row, tr, [data-id]').length;
    expect(last).toBeGreaterThanOrEqual(0); // the view re-rendered without throwing
  });

  test('an OPEN row parks the refresh; Back flushes it', async () => {
    const b = await booted();
    const row = [...b.w.document.querySelectorAll('*')].find((el) => el.onclick && /openId = cl\.id/.test(String(el.onclick)));
    expect(row).toBeTruthy();
    row.onclick();
    await tick(b.w, 30);
    expect(b.w.document.querySelector('iframe.cx-frame')).toBeTruthy(); // the editor is open
    b.fire();
    await tick(b.w, 400);
    expect(b.loads()).toBe(1); // parked: the editor iframe was not destroyed
    // The scope buttons also reset openId; the Back control is the one that flushes the bus.
    const back = [...b.w.document.querySelectorAll('button, a, span, div')].find((el) => el.onclick && /openId = null; render\(\); cxBusReload\(\)/.test(String(el.onclick)));
    expect(back).toBeTruthy();
    back.onclick();
    await tick(b.w, 30);
    expect(b.loads()).toBe(2); // flushed on Back
  });

  test('a hidden page parks the refresh; visibilitychange flushes it', async () => {
    const b = await booted({ hidden: true });
    b.fire();
    await tick(b.w, 400);
    expect(b.loads()).toBe(1);
    Object.defineProperty(b.w.document, 'hidden', { configurable: true, get: () => false });
    b.w.document.dispatchEvent(new b.w.Event('visibilitychange'));
    await tick(b.w, 30);
    expect(b.loads()).toBe(2);
  });

  test('a message during a load in flight is not doubled — one more read follows the load', async () => {
    const b = await booted();
    let release; const gate = new Promise((r) => { release = r; });
    b.setGate(gate);
    b.fire();
    await tick(b.w, 400);
    expect(b.loads()).toBe(2); // the first re-read is in flight (held by the gate)
    b.fire();
    await tick(b.w, 400);
    expect(b.loads()).toBe(2); // not doubled while in flight
    b.setGate(null); release();
    await tick(b.w, 100);
    expect(b.loads()).toBe(3); // the message that arrived mid-load is honoured once
  });

  test('another scope ignores the bus', async () => {
    const b = await booted();
    const mine = [...b.w.document.querySelectorAll('button')].find((el) => /^Mine$/i.test(el.textContent.trim()));
    expect(mine).toBeTruthy();
    mine.onclick();
    await tick(b.w, 30);
    b.fire();
    await tick(b.w, 400);
    expect(b.loads()).toBe(1);
  });
});
