// Phase B assertions for formBuilder.html — jsdom, no framework.
// Covers: structural model ops (add/move/delete for fields/rows/sections),
// repeater subset enforcement, name generation + auto-follow + rename cascade,
// reference-aware delete cascades, showWhen editor, structured options editor,
// JSON tab, and end-to-end server validation of a builder-built definition.
'use strict';
const fs = require('fs');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/claude/formBuilder.html', 'utf8');
const fixtureDef = JSON.parse(fs.readFileSync(
  '/home/claude/apigcr-main/ref/2026-07-27_test_quick_notes_slice2_definition.json.json', 'utf8'));
const svc = require('/home/claude/apigcr-main/services/formTemplateService.js');

function makeDom(row) {
  return new JSDOM(html, {
    url: 'https://app.4lsg.com/formBuilder.html?id=' + row.id,
    runScripts: 'dangerously',
    beforeParse(window) {
      window.apiSend = async (url, method, body) => {
        if (method === 'GET' && url === '/api/form-templates/' + row.id) {
          return { status: 'success', template: JSON.parse(JSON.stringify(row)) };
        }
        if (method === 'PUT') {
          const t = JSON.parse(JSON.stringify(row));
          if (body.draft_definition) t.draft_definition = body.draft_definition;
          if (body.title) t.title = body.title;
          return { status: 'success', template: t };
        }
        throw new Error('unexpected apiSend ' + method + ' ' + url);
      };
    },
  });
}
const tick = () => new Promise(r => setTimeout(r, 40));
function fire(win, elm, type) { elm.dispatchEvent(new win.Event(type, { bubbles: true })); }
function propByLabel(doc, labelText) {
  return [...doc.querySelectorAll('#inspector .prop')]
    .find(p => p.querySelector('label') && p.querySelector('label').textContent === labelText);
}

(async () => {
  // ══════════ Suite 1: fixture-based ops ══════════
  {
    const row = { id: 1, form_key: 'test_quick_notes', title: 'T', link_type: 'case',
      schema_version: 2, published_at: 'x', definition: fixtureDef, draft_definition: fixtureDef };
    const dom = makeDom(row);
    const win = dom.window, doc = win.document, ops = () => win.FB.ops;
    await tick();

    // — addFieldAt into a standard row —
    const f1 = ops().addFieldAt('fields:0:2', 'text', 1);
    assert.ok(f1, 'field added');
    assert.strictEqual(win.FB.model.sections[0].rows[2].fields[1], f1);
    assert.strictEqual(f1.label, 'New text');
    assert.match(f1.name, /^new_text(_\d+)?$/, 'auto name from label');
    assert.deepStrictEqual({ ...win.FB.sel }, { t: 'field', si: 0, ri: 2, fi: 1 }, 'new field selected');

    // — name auto-follows label edits until manually touched —
    const labelInput = propByLabel(doc, 'Label').querySelector('input');
    const nameInput  = propByLabel(doc, 'Name').querySelector('input');
    labelInput.value = 'First Name'; fire(win, labelInput, 'input');
    assert.strictEqual(f1.name, 'first_name', 'name followed label (prompt example)');
    assert.strictEqual(nameInput.value, 'first_name', 'name input display updated without inspector rebuild');
    // manual name edit stops the following
    nameInput.value = 'fname'; fire(win, nameInput, 'input');
    labelInput.value = 'First Name Full'; fire(win, labelInput, 'input');
    assert.strictEqual(f1.name, 'fname', 'manual edit detaches auto-follow');

    // — dedupe: second field with same label —
    const f2 = ops().addFieldAt('fields:0:2', 'text', 2);
    const l2 = propByLabel(doc, 'Label').querySelector('input');
    l2.value = 'fname'; fire(win, l2, 'input');
    assert.strictEqual(f2.name, 'fname_2', 'collision deduped with suffix');

    // — rename cascade: rename a showWhen target updates all references —
    // sample_select is referenced by: row-in, field-neq (2 refs)
    const sel = win.FB.model.sections[1].rows[1].fields[0];
    assert.strictEqual(sel.name, 'sample_select');
    assert.strictEqual(ops().refsTo('sample_select').length, 2);
    ops().renameField(sel, 'sample_select2');
    assert.strictEqual(ops().refsTo('sample_select2').length, 2, 'refs followed the rename');
    assert.strictEqual(ops().refsTo('sample_select').length, 0);
    ops().renameField(sel, 'sample_select');   // restore

    // — repeater subset: blocked type via addFieldAt, allowed type works —
    const before = win.FB.model.sections[3].fields.length;
    const blocked = ops().addFieldAt('rfields:3', 'textarea', 0);
    assert.strictEqual(blocked, null, 'textarea blocked from repeater');
    assert.strictEqual(win.FB.model.sections[3].fields.length, before, 'model untouched');
    assert.strictEqual(doc.getElementById('flash').style.display, 'block', 'visible reason shown');
    assert.ok(doc.getElementById('flash').textContent.includes('not supported there'));
    const okAdd = ops().addFieldAt('rfields:3', 'date', 0);
    assert.ok(okAdd && win.FB.model.sections[3].fields[0] === okAdd, 'date allowed into repeater');
    win.deleteSelected && (win.confirm = () => true, win.FB.ops.deleteSelected());   // clean it up

    // — moveField within a row —
    const r0 = win.FB.model.sections[0].rows[0].fields;
    const [a, b] = [r0[0].name, r0[1].name];
    ops().moveField('fields:0:0', 0, 'fields:0:0', 1);
    assert.strictEqual(win.FB.model.sections[0].rows[0].fields[0].name, b);
    assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1].name, a, 'same-strip reorder');
    ops().moveField('fields:0:0', 1, 'fields:0:0', 0);   // restore

    // — moveField across rows —
    ops().moveField('fields:0:0', 0, 'fields:0:1', 0);
    assert.strictEqual(win.FB.model.sections[0].rows[1].fields[0].name, 'case_id', 'cross-row move');
    ops().moveField('fields:0:1', 0, 'fields:0:0', 0);   // restore

    // — moveField into repeater: referenced field → confirm cascade —
    // primary_reason is referenced by cond_field_notempty's showWhen
    let confirmMsg = null;
    win.confirm = (m) => { confirmMsg = m; return false; };   // cancel first
    ops().moveField('fields:0:0', 2, 'rfields:3', 0);
    assert.ok(confirmMsg.includes('primary_reason') && confirmMsg.includes('cond_field_notempty'),
      'confirm names the referencing node');
    assert.strictEqual(win.FB.model.sections[0].rows[0].fields[2].name, 'primary_reason',
      'cancel → model untouched');
    win.confirm = () => true;                                  // accept
    ops().moveField('fields:0:0', 2, 'rfields:3', 0);
    assert.strictEqual(win.FB.model.sections[3].fields[0].name, 'primary_reason', 'moved into repeater');
    assert.strictEqual(
      win.FB.model.sections[2].rows[2].fields.find(f => f.name === 'cond_field_notempty').showWhen,
      undefined, 'referencing showWhen cascade-removed');
    ops().moveField('rfields:3', 0, 'fields:0:0', 2);          // restore position (showWhen stays gone)

    // — moveRow across sections + moveSection —
    ops().moveRow('rows:0', 2, 'rows:1', 0);
    assert.strictEqual(win.FB.model.sections[1].rows[0].fields[0].name, 'wf_note', 'row moved across sections');
    ops().moveRow('rows:1', 0, 'rows:0', 2);                   // restore
    ops().moveSection(3, 0);
    assert.ok(win.FB.model.sections[0].repeater, 'repeater section moved to front');
    ops().moveSection(0, 3);                                   // restore

    // — delete a field that is a showWhen target: cascade confirm —
    win.select({ t: 'field', si: 1, ri: 1, fi: 1 });           // sample_radio (referenced by cond_field_yes)
    confirmMsg = null;
    win.confirm = (m) => { confirmMsg = m; return true; };
    ops().deleteSelected();
    assert.ok(confirmMsg.includes('sample_radio') && confirmMsg.includes('cond_field_yes'),
      'delete confirm names referencing field');
    assert.ok(!win.FB.model.sections[1].rows[1].fields.some(f => f.name === 'sample_radio'), 'field deleted');
    assert.strictEqual(
      win.FB.model.sections[2].rows[2].fields.find(f => f.name === 'cond_field_yes').showWhen,
      undefined, 'referencing condition cascade-removed');
    assert.strictEqual(win.FB.sel, null, 'selection cleared after delete');

    // — delete a section whose fields are referenced from outside —
    // section 1 ("All Field Types") holds sample_checkbox + sample_select, referenced by section 2 + rows/fields
    win.select({ t: 'section', si: 1 });
    confirmMsg = null;
    win.confirm = (m) => { confirmMsg = m; return true; };
    ops().deleteSelected();
    assert.ok(confirmMsg.includes('will also remove those conditions'), 'outside refs surfaced');
    assert.strictEqual(win.FB.model.sections.length, 3, 'section deleted');
    assert.strictEqual(win.FB.model.sections[1].showWhen, undefined,
      'conditional-demo section showWhen (targeted sample_checkbox) cascade-removed');

    win.close();
    console.log('SUITE 1 PASSED — fixture-based structural ops');
  }

  // ══════════ Suite 2: fresh template — build a form purely via ops, then server-validate ══════════
  {
    const seed = { sections: [{ title: 'Section 1', rows: [] }] };
    const row = { id: 9, form_key: 'newform', title: 'New', link_type: 'contact',
      schema_version: 1, published_at: null, definition: null, draft_definition: seed };
    const dom = makeDom(row);
    const win = dom.window, doc = win.document, ops = () => win.FB.ops;
    await tick();

    // click-to-add with nothing selected → creates row in last standard section
    win.select(null);
    const f1 = ops().clickAddField('text');
    assert.strictEqual(win.FB.model.sections[0].rows.length, 1, 'row auto-created');
    // label it via inspector (auto-name follows)
    let li = propByLabel(doc, 'Label').querySelector('input');
    li.value = 'Client Mood'; fire(win, li, 'input');
    assert.strictEqual(f1.name, 'client_mood');

    // click-to-add with a field selected → inserts after it, same row
    const f2 = ops().clickAddField('select');
    assert.strictEqual(win.FB.model.sections[0].rows[0].fields[1], f2, 'inserted after selection');
    assert.match(f2.name, /^new_select/);
    assert.ok(Array.isArray(f2.options) && f2.options.length, 'options seeded for select');

    // options editor: edit rows, add, collapse label==value, block last delete
    const optList = [...doc.querySelectorAll('#inspector .opt-row')];
    assert.strictEqual(optList.length, 1, 'one seeded option row');
    optList[0]._v.value = 'happy'; fire(win, optList[0]._v, 'input');
    optList[0]._l.value = 'Happy'; fire(win, optList[0]._l, 'input');
    assert.strictEqual(JSON.stringify(f2.options), JSON.stringify([{ value: 'happy', label: 'Happy' }]));
    // add option, label empty → plain string in model
    [...doc.querySelectorAll('#inspector button')].find(b => b.textContent === '+ Add option').click();
    const rows2 = [...doc.querySelectorAll('#inspector .opt-row')];
    rows2[1]._v.value = 'sad'; fire(win, rows2[1]._v, 'input');
    assert.strictEqual(JSON.stringify(f2.options), JSON.stringify([{ value: 'happy', label: 'Happy' }, 'sad']));
    // label == value collapses to string
    rows2[0]._l.value = 'happy'; fire(win, rows2[0]._l, 'input');
    assert.strictEqual(JSON.stringify(f2.options), JSON.stringify(['happy', 'sad']));
    // last-option delete blocked
    rows2[1].querySelector('button').click();
    const rows3 = [...doc.querySelectorAll('#inspector .opt-row')];
    assert.strictEqual(rows3.length, 1, 'delete down to one works');
    rows3[0].querySelector('button').click();
    assert.strictEqual([...doc.querySelectorAll('#inspector .opt-row')].length, 1, 'last option delete blocked');
    assert.ok(doc.getElementById('flash').textContent.includes('At least one option'), 'reason flashed');
    assert.strictEqual(JSON.stringify(f2.options), JSON.stringify(['happy']), 'model kept ≥1 option');

    // showWhen editor on a new field: add → op coercions → values
    const f3 = ops().clickAddField('text');
    let addCond = [...doc.querySelectorAll('#inspector button')].find(b => b.textContent === '+ Add condition');
    addCond.click();
    assert.ok(f3.showWhen && f3.showWhen.op === 'eq', 'condition added');
    assert.ok(win.FB.ops.topLevelNames(f3).includes(f3.showWhen.field), 'target defaults to a valid top-level field');
    // target select excludes the node itself
    const targetSel = propByLabel(doc, 'When field').querySelector('select');
    assert.ok(![...targetSel.options].some(o => o.value === f3.name), 'self excluded from targets');
    targetSel.value = 'new_select'; fire(win, targetSel, 'change');
    assert.strictEqual(f3.showWhen.field, 'new_select');
    // eq value
    const valInput = propByLabel(doc, 'Value').querySelector('input');
    valInput.value = 'happy'; fire(win, valInput, 'input');
    assert.strictEqual(f3.showWhen.value, 'happy');
    // switch to in → value coerced to array; comma parse
    const opSel = propByLabel(doc, 'Operator').querySelector('select');
    opSel.value = 'in'; fire(win, opSel, 'change');
    assert.ok(Array.isArray(f3.showWhen.value) && f3.showWhen.value[0] === 'happy', 'eq→in coerces to array');
    const inInput = propByLabel(doc, 'Values (comma-separated)').querySelector('input');
    inInput.value = 'happy, sad , '; fire(win, inInput, 'input');
    assert.strictEqual(JSON.stringify(f3.showWhen.value), JSON.stringify(['happy', 'sad']));
    // switch to notEmpty → value dropped
    const opSel2 = propByLabel(doc, 'Operator').querySelector('select');
    opSel2.value = 'notEmpty'; fire(win, opSel2, 'change');
    assert.strictEqual(f3.showWhen.value, undefined, 'notEmpty drops value');

    // canvas badge appeared for the condition (field-level)
    assert.ok(doc.querySelector('#canvas .badge.sw'), 'showWhen badge on canvas');

    // structure palette: repeater section seeded valid, then add a row-level condition target set
    const rep = ops().addSectionAt(1, 'repeater');
    assert.ok(rep.repeater && rep.fields.length === 1, 'repeater seeded with one field (non-empty for validation)');
    ops().addRowAt(0);
    assert.strictEqual(win.FB.model.sections[0].rows.length, 2, '+ row works');

    // JSON tab: apply swaps the model; parse errors rejected
    win.showTab('json');
    const ta = doc.getElementById('jsonTa');
    assert.ok(ta.value.includes('"client_mood"'), 'JSON view reflects model');
    ta.value = '{ nope';
    fire(win, ta, 'input');
    win.applyJson();
    assert.ok(doc.getElementById('jsonErr').textContent.startsWith('Invalid JSON'), 'parse error surfaced');
    assert.ok(win.FB.model.sections[0].rows[0].fields.length >= 2, 'model untouched on bad apply');
    const replacement = { sections: [{ title: 'Swapped', rows: [{ fields: [{ name: 'only', type: 'text' }] }] }] };
    ta.value = JSON.stringify(replacement); fire(win, ta, 'input');
    win.applyJson();
    assert.strictEqual(win.FB.model.sections[0].title, 'Swapped', 'apply swapped the working model');
    assert.strictEqual(win.isDirty(), true, 'apply marks dirty');
    assert.strictEqual(doc.querySelectorAll('#canvas .cv-field').length, 1, 'canvas re-rendered from applied model');
    // live refresh while textarea clean
    win.FB.ops.addRowAt(0);
    assert.ok(ta.value.includes('"rows"') && JSON.parse(ta.value).sections[0].rows.length === 2,
      'clean JSON view refreshes on model change');
    win.showTab('canvas');

    // rebuild a real definition through ops only, then run the REAL server validation
    win.applyJsonModel = null;
    win.showTab('json');
    ta.value = JSON.stringify({ sections: [{ title: 'S1', rows: [] }] }); fire(win, ta, 'input');
    win.applyJson();
    win.showTab('canvas');
    const g1 = ops().clickAddField('text');       // → section 0 row 0
    let lab = propByLabel(doc, 'Label').querySelector('input');
    lab.value = 'Pet Name'; fire(win, lab, 'input');
    const g2 = ops().clickAddField('select');
    lab = propByLabel(doc, 'Label').querySelector('input');
    lab.value = 'Pet Kind'; fire(win, lab, 'input');
    // give it a condition: pet_name notEmpty
    [...doc.querySelectorAll('#inspector button')].find(b => b.textContent === '+ Add condition').click();
    const ts = propByLabel(doc, 'When field').querySelector('select');
    ts.value = 'pet_name'; fire(win, ts, 'change');
    const os = propByLabel(doc, 'Operator').querySelector('select');
    os.value = 'notEmpty'; fire(win, os, 'change');
    ops().addSectionAt(1, 'repeater');
    const built = JSON.parse(JSON.stringify(win.FB.model));
    try { svc.validateDefinition(built); }
    catch (e) { assert.fail('builder-built definition rejected by real validateDefinition: ' + e.message); }
    assert.strictEqual(svc.fieldSignature(built).split('|').length, 3, 'signature covers repeater seed field too');

    win.close();
    console.log('SUITE 2 PASSED — fresh build, options/showWhen editors, JSON tab, server validation');
  }

  console.log('ALL PHASE B ASSERTIONS PASSED');
})().catch(e => { console.error('FAIL:', e.message); console.error(e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });