// tests/logCommDate.addLog.test.js
//
/**
 * log-comm-date follow-up — the case and contact Log tabs' "Add Log" note
 * dialog (scripts.js AddLogDialog) takes a When: defaults to firm-local now;
 * left as offered no `date` is sent, a changed one is; a future one or an
 * empty one never posts.
 *
 * Real code: the whole of public/scripts.js plus each page's own addLog and
 * its shipped "Add Log" button, dispatched on the rendered control. SweetAlert2
 * is a CDN global, so a stub renders the dialog's real `html` into the page and
 * runs its real preConfirm (what clicking "Log" does).
 *
 * Run:  npx jest tests/logCommDate.addLog.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SCRIPTS = read('public/scripts.js');

function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

const SWAL_STUB = `
  window.__dialog = null; window.__validation = []; window.__toasts = [];
  window.Swal = {
    mixin: () => ({ fire: (o) => { window.__toasts.push(o); return Promise.resolve({}); } }),
    fire(o) {
      const box = document.createElement('div');
      box.className = 'swal2-html-container ' + ((o.customClass && o.customClass.htmlContainer) || '');
      box.innerHTML = o.html || '';
      document.body.appendChild(box);
      window.__dialog = o;
      return Promise.resolve({ isConfirmed: false });
    },
    showValidationMessage(m) { window.__validation.push(m); },
    close() {}, showLoading() {}, update() {},
  };`;

// Not the machine's zone (Detroit): the default must come from the firm zone,
// never the browser's, and a Detroit firm zone could not tell the two apart.
const FIRM_TZ = 'America/Los_Angeles';

const firmNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: FIRM_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};

function boot(file, scope) {
  const src = read(file);
  const button = /<button onclick="addLog\(\)">Add Log<\/button>/.exec(src);
  if (!button) throw new Error(`${file}: Add Log button not found`);
  const jsd = new JSDOM(`<!DOCTYPE html><html><body>${button[0]}</body></html>`,
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  w.__posts = []; w.__loads = [];
  w.apiSend = async (url, method, body) => { w.__posts.push({ url, method, body }); return { status: 'success', log_id: 1 }; };
  w.firmData = { firmTimezone: FIRM_TZ };
  w.eval(SWAL_STUB + '\n' + SCRIPTS + '\n' + scope + '\n' + fnSrc(src, 'addLog') + '\n'
    + 'function tabLogGet(offset) { window.__loads.push(offset); }');
  return w;
}

async function open(w) {
  const before = firmNow();
  w.document.querySelector('button').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
  const after = firmNow();
  return { before, after };
}

const PAGES = [
  ['public/case.html', 'var caseID = "C9";', { link_type: 'case', link_id: 'C9' }],
  ['public/contact.html', 'var clientID = 2111;', { link_type: 'contact', link_id: 2111 }],
];

describe.each(PAGES)('%s Add Log', (file, scope, link) => {
  test('When defaults to firm-local now; left as offered, no date is sent and the log reloads', async () => {
    const w = boot(file, scope);
    const { before, after } = await open(w);
    const when = w.document.getElementById('addLogWhen');
    expect(when.type).toBe('datetime-local');
    expect([before, after]).toContain(when.value);
    expect(when.max).toBe(when.value);
    w.document.getElementById('addLogText').value = 'Left a voicemail';
    await w.__dialog.preConfirm();
    expect(w.__posts).toEqual([{ url: '/api/log', method: 'POST', body: { type: 'note', ...link, data: 'Left a voicemail' } }]);
    expect(w.__loads).toEqual([0]);
    w.close();
  });

  test('a changed When goes as date', async () => {
    const w = boot(file, scope);
    await open(w);
    w.document.getElementById('addLogText').value = 'He called Tuesday';
    w.document.getElementById('addLogWhen').value = '2026-10-18T14:30';
    await w.__dialog.preConfirm();
    expect(w.__posts[0].body).toEqual({ type: 'note', ...link, data: 'He called Tuesday', date: '2026-10-18T14:30' });
    w.close();
  });

  test.each([
    ['a future When', 'x', '2099-01-01T00:00', /future/],
    ['an empty When', 'x', '', /when/i],
    ['an empty note', '', null, /log message/],
  ])('%s never posts', async (_l, text, whenValue, msg) => {
    const w = boot(file, scope);
    await open(w);
    w.document.getElementById('addLogText').value = text;
    if (whenValue !== null) w.document.getElementById('addLogWhen').value = whenValue;
    expect(await w.__dialog.preConfirm()).toBe(false);
    expect(w.__posts).toHaveLength(0);
    expect(w.__validation.join(' ')).toMatch(msg);
    w.close();
  });
});
