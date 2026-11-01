/**
 * tests/caseCaption.readers.test.js
 *
 * The pickers leave out a caption that only repeats the client. CasePicker
 * runs from the real scripts.js in jsdom; the flag it reads comes from
 * caseService.searchCases (tests/caseCaption.mysql.test.js).
 *
 *   npx jest tests/caseCaption.readers.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickerLine3(row) {
  const jsd = new JSDOM('<!DOCTYPE html><html><body><div id="host"></div></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  w.apiSend = async () => ({ cases: [row] });
  w.eval(`window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${read('public/scripts.js')}
    window.__picker = CasePicker(document.getElementById('host'), { initialQuery: 'x' });`);
  await sleep(10);
  const subs = w.document.querySelectorAll('.cp-sub');
  const text = subs[subs.length - 1].textContent;
  w.close();
  return text;
}

describe('CasePicker line 3', () => {
  const row = { case_id: 'AAAAAAAA', case_number: '26-1', case_type: 'Bankruptcy', case_stage: 'Filed',
    primary_contact_name: 'Jason F Childs' };

  test('a caption that says more leads the line', async () => {
    expect(await pickerLine3({ ...row, case_caption: 'Schneyer v. Childs', caption_adds_info: true }))
      .toBe('Schneyer v. Childs — Jason F Childs');
  });

  test('a caption that repeats the client is left out', async () => {
    expect(await pickerLine3({ ...row, case_caption: 'In re Jason F. Childs', caption_adds_info: false }))
      .toBe('Jason F Childs');
  });

  test('no caption, just the client', async () => {
    expect(await pickerLine3({ ...row, case_caption: null, caption_adds_info: false })).toBe('Jason F Childs');
  });
});

test('the Comms case picker reads the same flag', () => {
  const src = read('public/comms.html');
  expect(src).toContain("[c.caption_adds_info ? c.case_caption : '', c.primary_contact_name]");
  expect(src).not.toContain('[c.case_caption, c.primary_contact_name]');
});
