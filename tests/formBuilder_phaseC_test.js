// Phase C assertions for formBuilder.html — jsdom, no framework.
// Covers: client fieldSignature mirror vs the REAL service implementation,
// preview save-before-refresh + URL construction + link_id persistence,
// publish flow confirm messages (first / no-change / bump) and result surfacing,
// and the failed-save guard on both preview and publish.
'use strict';
const fs = require('fs');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('/home/claude/formBuilder.html', 'utf8');
const fixtureDef = JSON.parse(fs.readFileSync(
  '/home/claude/apigcr-main/ref/2026-07-27_test_quick_notes_slice2_definition.json.json', 'utf8'));
const svc = require('/home/claude/apigcr-main/services/formTemplateService.js');

const tick = () => new Promise(r => setTimeout(r, 40));
function fire(win, elm, type) { elm.dispatchEvent(new win.Event(type, { bubbles: true })); }

function makeDom(row, hooks) {
  hooks = hooks || {};
  return new JSDOM(html, {
    url: 'https://app.4lsg.com/formBuilder.html?id=' + row.id + (hooks.urlExtra || ''),
    runScripts: 'dangerously',
    beforeParse(window) {
      window.apiSend = async (url, method, body) => {
        if (hooks.intercept) { const r = hooks.intercept(url, method, body); if (r !== undefined) return r; }
        if (method === 'GET' && url === '/api/form-templates/' + row.id) {
          return { status: 'success', template: JSON.parse(JSON.stringify(row)) };
        }
        if (method === 'PUT') {
          const t = JSON.parse(JSON.stringify(row));
          if (body.draft_definition) { t.draft_definition = body.draft_definition; row.draft_definition = body.draft_definition; }
          if (body.title) t.title = body.title;
          return { status: 'success', template: t };
        }
        throw new Error('unexpected apiSend ' + method + ' ' + url);
      };
    },
  });
}

(async () => {
  // ── 1. Signature mirror ≡ real service (fixture, mutations, repeater coverage, empty) ──
  {
    const dom = makeDom({ id: 1, form_key: 'k', title: 't', link_type: 'case',
      schema_version: 2, published_at: 'x', definition: fixtureDef, draft_definition: fixtureDef });
    const win = dom.window;
    await tick();
    const cfs = win.FB.ops.clientFieldSignature;

    const cases = [];
    cases.push(fixtureDef);
    const renamed = JSON.parse(JSON.stringify(fixtureDef));
    renamed.sections[0].rows[0].fields[1].name = 'renamed';           // rename = remove+add
    cases.push(renamed);
    const retyped = JSON.parse(JSON.stringify(fixtureDef));
    retyped.sections[3].fields[0].type = 'date';                      // repeater field type change
    cases.push(retyped);
    const labelOnly = JSON.parse(JSON.stringify(fixtureDef));
    labelOnly.sections[0].rows[0].fields[1].label = 'X';              // cosmetic — same signature
    cases.push(labelOnly);
    cases.push({ sections: [] });
    cases.push({ sections: [{ title: 's', rows: [] }] });

    cases.forEach((def, i) => {
      assert.strictEqual(cfs(def), svc.fieldSignature(def), 'mirror matches service on case ' + i);
    });
    assert.notStrictEqual(cfs(renamed), cfs(fixtureDef), 'rename changes signature');
    assert.notStrictEqual(cfs(retyped), cfs(fixtureDef), 'repeater type change covered');
    assert.strictEqual(cfs(labelOnly), cfs(fixtureDef), 'label tweak does not change signature');
    win.close();
  }

  // ── 2. Preview: dirty → saved first; URL built; nonce; link_id persisted in page URL ──
  {
    const row = { id: 5, form_key: 'pv', title: 'PV', link_type: 'case',
      schema_version: 1, published_at: null, definition: null,
      draft_definition: { sections: [{ title: 'S', rows: [] }] } };
    let puts = 0;
    const dom = makeDom(row, { intercept: (u, m) => { if (m === 'PUT') puts++; return undefined; } });
    const win = dom.window, doc = win.document;
    await tick();

    // make it dirty, set a link id, preview
    win.FB.ops.addRowAt(0);
    assert.strictEqual(win.isDirty(), true);
    doc.getElementById('prevLinkId').value = 'rIxpyvYG';
    win.showTab('preview');
    await tick();
    assert.strictEqual(puts, 1, 'dirty draft saved before preview');
    assert.strictEqual(win.isDirty(), false, 'clean after auto-save');
    const src = doc.getElementById('previewFrame').getAttribute('src');
    assert.ok(src.startsWith('/forms/render.html?template_id=5&preview=1&_='), 'preview URL shape: ' + src);
    assert.ok(src.includes('&link_id=rIxpyvYG'), 'link_id appended');
    assert.ok(win.location.search.includes('link_id=rIxpyvYG'), 'link id persisted in page URL (not storage)');

    // clean model → refresh does not save again, nonce changes
    await new Promise(r => setTimeout(r, 5));
    await win.showPreview();
    assert.strictEqual(puts, 1, 'no redundant save when clean');
    const src2 = doc.getElementById('previewFrame').getAttribute('src');
    assert.notStrictEqual(src, src2, 'nonce forces reload');

    // empty link id → param dropped from frame URL and page URL
    doc.getElementById('prevLinkId').value = '';
    await win.showPreview();
    assert.ok(!doc.getElementById('previewFrame').getAttribute('src').includes('link_id'), 'no link_id when empty');
    assert.ok(!win.location.search.includes('link_id'), 'page URL param removed');
    win.close();
  }

  // ── 3. Preview/publish blocked when the save fails (verbatim error stays visible) ──
  {
    const row = { id: 6, form_key: 'bad', title: 'B', link_type: 'case',
      schema_version: 1, published_at: null, definition: null,
      draft_definition: { sections: [{ title: 'S', rows: [] }] } };
    let publishes = 0;
    const dom = makeDom(row, { intercept: (u, m) => {
      if (m === 'PUT') { const e = new Error('sections[0].rows must be an array'); e.status = 400; throw e; }
      if (m === 'POST' && u.endsWith('/publish')) { publishes++; return { status: 'success', schema_version: 1, bumped: false }; }
      return undefined;
    }});
    const win = dom.window, doc = win.document;
    await tick();
    win.FB.ops.addRowAt(0);   // dirty
    win.confirm = () => { assert.fail('confirm must not be reached when save fails'); };
    await win.showPreview();
    assert.strictEqual(doc.getElementById('previewFrame').getAttribute('src'), null, 'frame untouched on failed save');
    assert.strictEqual(doc.getElementById('errBar').textContent, 'sections[0].rows must be an array', 'verbatim error');
    await win.publishFlow();
    assert.strictEqual(publishes, 0, 'publish never fired after failed save');
    win.close();
  }

  // ── 4. Publish confirm messages + result surfacing + row refetch ──
  {
    // 4a: first publish (definition == null) → "first time as v1"
    const row = { id: 7, form_key: 'proof', title: 'P', link_type: 'case',
      schema_version: 1, published_at: null, definition: null,
      draft_definition: { sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }] } };
    let published = false;
    const dom = makeDom(row, { intercept: (u, m) => {
      if (m === 'POST' && u === '/api/form-templates/7/publish') {
        published = true;
        row.definition = JSON.parse(JSON.stringify(row.draft_definition));
        row.published_at = '2026-07-27 12:00:00';
        return { status: 'success', schema_version: 1, bumped: false };
      }
      return undefined;
    }});
    const win = dom.window, doc = win.document;
    await tick();

    let confirmMsg = null;
    win.confirm = (m) => { confirmMsg = m; return true; };
    await win.publishFlow();
    assert.ok(confirmMsg.includes('first time as v1'), 'first-publish message: ' + confirmMsg);
    assert.ok(published, 'publish POSTed');
    assert.strictEqual(doc.getElementById('okBar').textContent, 'Published v1 (no schema change)', 'result surfaced');
    assert.ok(doc.getElementById('keyWrap').textContent.includes('🔒'),
      'row refetched — form_key locks after first publish');

    // 4b: republish with no field change → "No schema change — republish as v1"
    win.FB.model.sections[0].title = 'Cosmetic';   // layout-only change
    win.markDirty();
    confirmMsg = null;
    await win.publishFlow();
    assert.ok(confirmMsg.includes('No schema change') && confirmMsg.includes('as v1'), 'no-change message: ' + confirmMsg);

    // 4c: field-set change → bump warning naming v2 and the v1 draft warning
    win.FB.ops.addFieldAt('fields:0:0', 'number', 1);
    confirmMsg = null;
    let bumpPosted = false;
    const origSend = win.apiSend;
    win.apiSend = async (u, m, b) => {
      if (m === 'POST' && u.endsWith('/publish')) {
        bumpPosted = true;
        row.schema_version = 2;
        row.definition = JSON.parse(JSON.stringify(row.draft_definition));
        return { status: 'success', schema_version: 2, bumped: true };
      }
      return origSend(u, m, b);
    };
    await win.publishFlow();
    assert.ok(confirmMsg.includes('will publish as v2') &&
              confirmMsg.includes('older drafts against v1 will show a version warning'),
      'bump message: ' + confirmMsg);
    assert.ok(bumpPosted);
    assert.strictEqual(doc.getElementById('okBar').textContent, 'Published v2 (schema version bumped)');

    // 4d: cancel → nothing posted
    win.FB.ops.addFieldAt('fields:0:0', 'date', 2);
    let posted = false;
    win.apiSend = async (u, m, b) => {
      if (m === 'POST' && u.endsWith('/publish')) { posted = true; return { status: 'success', schema_version: 3, bumped: true }; }
      return origSend(u, m, b);
    };
    win.confirm = () => false;
    await win.publishFlow();
    assert.strictEqual(posted, false, 'cancelled confirm → no publish');

    win.close();
  }


  // ── 5. backToOpener: dirty guard + state reset ──
  {
    const row = { id: 8, form_key: 'sw', title: 'S', link_type: 'case',
      schema_version: 1, published_at: null, definition: null,
      draft_definition: { sections: [{ title: 'S', rows: [] }] } };
    const dom = makeDom(row, { intercept: (u, m) => {
      if (m === 'GET' && u === '/api/form-templates') return { status: 'success', templates: [] };
      return undefined;
    }});
    const win = dom.window, doc = win.document;
    await tick();
    win.FB.ops.addRowAt(0);   // dirty
    win.confirm = () => false;
    win.backToOpener();
    assert.ok(win.FB.model, 'cancel keeps the template open');
    win.confirm = () => true;
    win.backToOpener();
    await tick();
    assert.strictEqual(win.FB.model, null, 'model cleared');
    assert.strictEqual(win.location.search, '', 'id removed from URL');
    assert.strictEqual(doc.getElementById('builderWrap').style.display, 'none');
    assert.strictEqual(doc.getElementById('opener').style.display, '', 'opener shown');
    win.close();
  }

  console.log('ALL PHASE C ASSERTIONS PASSED (5 groups)');
})().catch(e => { console.error('FAIL:', e.message); console.error(e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });