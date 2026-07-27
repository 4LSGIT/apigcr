// Phase A assertions for formBuilder.html — jsdom, no framework.
// Focus: model round-trip (definition → canvas → edits → JSON), canvas
// structure vs the real fixture, inspector edit semantics, save-draft body.
'use strict';
const fs = require('fs');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/claude/formBuilder.html', 'utf8');
const fixtureDef = JSON.parse(fs.readFileSync(
  '/home/claude/apigcr-main/ref/2026-07-27_test_quick_notes_slice2_definition.json.json', 'utf8'));

const ROW = {
  id: 1, form_key: 'test_quick_notes', title: 'Quick Notes (Test)', link_type: 'case',
  schema_version: 2, published_at: '2026-07-27 10:00:00',
  definition: fixtureDef, draft_definition: fixtureDef,
};

let putBodies = [];
function makeDom() {
  putBodies = [];
  return new JSDOM(html, {
    url: 'https://app.4lsg.com/formBuilder.html?id=1',
    runScripts: 'dangerously',
    beforeParse(window) {
      window.apiSend = async (url, method, body) => {
        if (method === 'GET' && url === '/api/form-templates/1') {
          return { status: 'success', template: JSON.parse(JSON.stringify(ROW)) };
        }
        if (method === 'PUT' && url === '/api/form-templates/1') {
          putBodies.push(JSON.parse(JSON.stringify(body)));
          const t = JSON.parse(JSON.stringify(ROW));
          if (body.title) t.title = body.title;
          if (body.draft_definition) t.draft_definition = body.draft_definition;
          return { status: 'success', template: t };
        }
        throw new Error('unexpected apiSend ' + method + ' ' + url);
      };
    },
  });
}
const tick = () => new Promise(r => setTimeout(r, 30));
function fire(win, elm, type) { elm.dispatchEvent(new win.Event(type, { bubbles: true })); }

(async () => {
  const dom = makeDom();
  const win = dom.window, doc = win.document;
  await tick(); await tick();   // waitForParent + openTemplate

  // ── 1. Canvas structure mirrors the fixture ──
  const sections = doc.querySelectorAll('#canvas .cv-section');
  assert.strictEqual(sections.length, 4, '4 sections rendered');
  assert.ok(sections[3].classList.contains('repeater'), 'section 4 visually distinct as repeater');

  const chips = doc.querySelectorAll('#canvas .cv-field');
  const expectedFieldCount = (() => {
    let n = 0;
    for (const s of fixtureDef.sections) {
      if (s.repeater) n += s.fields.length;
      else for (const r of s.rows) n += r.fields.length;
    }
    return n;
  })();
  assert.strictEqual(chips.length, expectedFieldCount, `all ${expectedFieldCount} fields rendered as chips`);

  // apiColumn chips exactly where the fixture declares them
  const colBadges = [...doc.querySelectorAll('#canvas .badge.col')].map(b => b.textContent);
  assert.deepStrictEqual(colBadges.sort(),
    ['⛁ case_primary_reason', '⛁ case_source_ref'], 'apiColumn chips: exactly the two declared columns');

  // showWhen badges: 1 section + 1 row + 3 fields = 5
  assert.strictEqual(doc.querySelectorAll('#canvas .badge.sw').length, 5, '5 showWhen badges');

  // Model-sourced strings landed via textContent (no HTML interpretation):
  // sanity — a label containing markup-ish text would stay literal. Structural
  // check: no chip contains element children created from label text.
  const reasonChip = [...chips].find(c => c.textContent.includes('case_primary_reason'));
  assert.ok(reasonChip.textContent.includes('primary_reason'), 'field name shown');
  assert.ok(reasonChip.querySelector('.req-star'), 'required marker on required field');

  // ── 2. Untouched round-trip: MODEL deep-equals the stored draft ──
  assert.strictEqual(JSON.stringify(win.FB.model), JSON.stringify(fixtureDef),
    'definition → model round-trip is lossless');   // string compare: cross-realm deepStrictEqual fails on prototypes
  assert.strictEqual(win.isDirty(), false, 'freshly loaded = not dirty');

  // ── 3. Select a field; label edit reaches the model ──
  const chip = doc.querySelector('#canvas [data-sel="f:0:0:1"]');   // src_ref
  chip.click();
  const labelInput = [...doc.querySelectorAll('#inspector .prop')]
    .find(p => p.querySelector('label') && p.querySelector('label').textContent === 'Label')
    .querySelector('input');
  assert.strictEqual(labelInput.value, 'Source Ref', 'inspector shows current label');
  labelInput.value = 'Source Reference';
  fire(win, labelInput, 'input');
  assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1].label, 'Source Reference', 'label edit wrote to model');
  assert.strictEqual(win.isDirty(), true, 'edit marks dirty');

  // canvas resynced after edit, selection preserved
  assert.ok(doc.querySelector('#canvas [data-sel="f:0:0:1"]').classList.contains('selected'),
    'selection survives canvas resync');
  assert.ok(doc.querySelector('#canvas [data-sel="f:0:0:1"]').textContent.includes('Source Reference'),
    'canvas reflects the edit');

  // ── 4. Invalid name never reaches the model; duplicate rejected ──
  const nameInput = [...doc.querySelectorAll('#inspector .prop')]
    .find(p => p.querySelector('label') && p.querySelector('label').textContent === 'Name')
    .querySelector('input');
  nameInput.value = 'bad name!';
  fire(win, nameInput, 'input');
  assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1].name, 'src_ref', 'invalid name NOT written');
  assert.ok(nameInput.classList.contains('bad'), 'invalid name flagged');
  nameInput.value = 'primary_reason';                       // duplicate of another field
  fire(win, nameInput, 'input');
  assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1].name, 'src_ref', 'duplicate name NOT written');
  nameInput.value = 'source_reference';
  fire(win, nameInput, 'input');
  assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1].name, 'source_reference', 'valid rename written');

  // repeater key duplicate guard: "vehicles" is taken
  nameInput.value = 'vehicles';
  fire(win, nameInput, 'input');
  assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1].name, 'source_reference',
    'name colliding with a repeater key rejected');

  // ── 5. (superseded) options textarea stub replaced by the structured editor — covered in test_phaseB.js ──

  // ── 6. Settings: dataMode flips the apiColumn helper text (mode-aware) ──
  doc.querySelector('#inspector button.ghost').click();     // ← Form settings
  const dm = [...doc.querySelectorAll('#inspector .prop')]
    .find(p => p.querySelector('label') && p.querySelector('label').textContent === 'Data mode')
    .querySelector('select');
  dm.value = 'snapshot'; fire(win, dm, 'change');
  assert.strictEqual(win.FB.model.dataMode, 'snapshot', 'dataMode written');
  doc.querySelector('#canvas [data-sel="f:0:0:1"]').click();
  const helpTexts = [...doc.querySelectorAll('#inspector .help')].map(h => h.textContent).join(' ');
  assert.ok(helpTexts.includes('Saves to this column'), 'snapshot-mode helper');
  assert.ok(!helpTexts.includes('Loads from and saves'), 'live helper absent in snapshot mode');

  // back to live → helper flips
  doc.querySelector('#inspector button.ghost').click();
  const dm2 = [...doc.querySelectorAll('#inspector .prop')]
    .find(p => p.querySelector('label') && p.querySelector('label').textContent === 'Data mode')
    .querySelector('select');
  dm2.value = 'live'; fire(win, dm2, 'change');
  assert.strictEqual(win.FB.model.dataMode, undefined, 'live (default) → key removed');
  doc.querySelector('#canvas [data-sel="f:0:0:1"]').click();
  assert.ok([...doc.querySelectorAll('#inspector .help')].some(h =>
    h.textContent.includes('Loads from and saves to this column')), 'live-mode helper');

  // ── 7. Save draft: PUT body carries the edited model (+title only if changed) ──
  win.FB.title = 'Quick Notes (Test) EDITED';
  win.markDirty();
  await win.saveDraft();
  assert.strictEqual(putBodies.length, 1, 'one PUT');
  assert.strictEqual(putBodies[0].title, 'Quick Notes (Test) EDITED', 'changed title included');
  assert.strictEqual(putBodies[0].form_key, undefined, 'unchanged form_key omitted');
  assert.strictEqual(putBodies[0].draft_definition.sections[0].rows[0].fields[1].name,
    'source_reference', 'PUT body carries the edited draft');
  assert.strictEqual(win.isDirty(), false, 'save re-snapshots → clean');

  // ── 8. Server 400 surfaced verbatim ──
  win.FB.model.sections[0].rows[0].fields[1].label = 'X';
  win.markDirty();
  const origSend = win.apiSend;
  win.apiSend = async (url, method) => {
    if (method === 'PUT') { const e = new Error('sections[0].rows[0].fields[1].name "x!" is invalid (must match ^[a-zA-Z0-9_]{1,50}$)'); e.status = 400; throw e; }
    return origSend(url, method);
  };
  await win.saveDraft();
  assert.strictEqual(doc.getElementById('errBar').textContent,
    'sections[0].rows[0].fields[1].name "x!" is invalid (must match ^[a-zA-Z0-9_]{1,50}$)',
    'server message shown verbatim');
  win.apiSend = origSend;

  // ── 9. Published template → form_key locked in topbar ──
  assert.ok(doc.getElementById('keyWrap').textContent.includes('🔒'), 'published key shows lock');
  assert.ok(!doc.getElementById('keyWrap').querySelector('input'), 'no key input when published');

  win.close();
  console.log('ALL PHASE A ASSERTIONS PASSED (9 groups)');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });