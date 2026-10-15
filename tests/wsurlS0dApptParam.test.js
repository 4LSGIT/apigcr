/**
 * wsurl S0d — /?appt=<markup> must not reach the shell's DOM.
 *
 * The boot did `if (params.appt) showAppt(params.appt)`, and showAppt (like
 * showEvent) built the Swal's `title` and an `<iframe src="…?apptID=${id}">`
 * html string from the raw id. sweetalert2 renders both `title` and `html` as
 * HTML, so a crafted link injected markup into the shell, which holds apiSend.
 *
 * Runs the REAL showAppt / showEvent and the REAL boot statement extracted
 * from public/index.html (fnSrc pattern). Swal is modelled the way
 * sweetalert2 renders: `title` and `html` through innerHTML, `titleText`
 * through textContent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SHELL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let paren = 0;
  for (let j = m.index + m[0].length - 1; j < src.length; j++) {
    if (src[j] === '(') paren++;
    else if (src[j] === ')' && --paren === 0) { i = src.indexOf('{', j); break; }
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

/** The boot's ?appt= statement, as shipped (from `if (params.appt` to its `}`). */
function bootApptSrc() {
  const i = SHELL.indexOf('if (params.appt');
  if (i < 0) throw new Error('boot ?appt= statement not found');
  return SHELL.slice(i, SHELL.indexOf('}', i) + 1);
}

const PAYLOAD = '1"></iframe><img id=pwn src=x>';

function boot() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'outside-only' });
  const w = dom.window;
  w.__fired = [];
  w.eval(`
    var Swal = {
      fire(o) {
        __fired.push(o);
        const c = document.createElement('div');
        const h = document.createElement('h2');
        h.className = 'swal2-title';
        if (o.titleText != null) h.textContent = o.titleText;
        else h.innerHTML = o.title == null ? '' : o.title;
        c.appendChild(h);
        const body = document.createElement('div');
        body.innerHTML = o.html || '';
        c.appendChild(body);
        document.body.appendChild(c);
      },
    };
    function swalWide(x) { return x; }
    ${fnSrc(SHELL, 'showAppt')}
    ${fnSrc(SHELL, 'showEvent')}
    function bootAppt(params) { ${bootApptSrc()} }
  `);
  return w;
}

const urlParams = (qs) => {
  const p = {};
  new URL('https://app.4lsg.com/' + qs).searchParams.forEach((v, k) => { p[k] = v; });
  return p;
};

describe('wsurl S0d — ?appt= and the appt/event dialogs', () => {
  test('?appt=<payload> at boot: dropped SILENTLY, nothing fired, nothing injected', () => {
    const w = boot();
    const warns = [];
    w.console.warn = (...a) => warns.push(a);
    w.bootAppt(urlParams('?appt=' + encodeURIComponent(PAYLOAD)));
    expect(w.__fired).toHaveLength(0);
    expect(w.document.getElementById('pwn')).toBeNull();
    // the boot's own guard drops it; showAppt (which would warn) is never reached
    expect(warns).toHaveLength(0);
  });

  test('?appt=<digits> at boot still opens the appointment', () => {
    const w = boot();
    w.bootAppt(urlParams('?appt=1405'));
    expect(w.__fired).toHaveLength(1);
    expect(w.document.querySelector('iframe').getAttribute('src')).toBe('/apptform2.html?apptID=1405');
  });

  test.each([['showAppt'], ['showEvent']])('%s refuses a non-integer id, injects nothing', (fn) => {
    const w = boot();
    for (const bad of [PAYLOAD, '', '12a', '-3', '1.5', null, undefined, '<b>1</b>']) w[fn](bad);
    expect(w.__fired).toHaveLength(0);
    expect(w.document.getElementById('pwn')).toBeNull();
  });

  test('a valid id: the same src and title text as before', () => {
    const w = boot();
    w.showAppt(1405);
    w.showAppt('77');
    w.showEvent(9);
    const titles = [...w.document.querySelectorAll('.swal2-title')].map((h) => h.textContent);
    const srcs = [...w.document.querySelectorAll('iframe')].map((f) => f.getAttribute('src'));
    expect(titles).toEqual(['Appointment 1405', 'Appointment 77', 'Event 9']);
    expect(srcs).toEqual(['/apptform2.html?apptID=1405', '/apptform2.html?apptID=77', '/eventform.html?eventID=9']);
    // plain text, never HTML
    w.__fired.forEach((o) => { expect(o.title).toBeUndefined(); expect(typeof o.titleText).toBe('string'); });
  });
});
