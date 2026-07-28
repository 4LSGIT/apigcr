// Slice 4 service assertions — plain node script (node tests/formTemplates_slice4_service_test.js
// from the repo root), no framework, matching the formBuilder_phase* precedent.
//
// The new service functions are exercised against a STUB mysql2 pool that
// records every (sql, params) call and returns scripted rows — no database
// needed. Covers:
//   formTemplateService: listVersions schema_changed computation + ordering,
//     getVersion ownership 404, restoreVersion SQL-side column copy (no JSON
//     re-binding through a placeholder) + template refetch.
//   formService: browseSubmissions dynamic WHERE building, status validation,
//     limit clamping, before_id cursor validation; getSubmission 404.
'use strict';
const path = require('path');
const assert = require('assert');

const tplSvc  = require(path.join(__dirname, '..', 'services', 'formTemplateService.js'));
const formSvc = require(path.join(__dirname, '..', 'services', 'formService.js'));

// Stub pool: db.query(sql, params) → shift the next scripted result. Results
// are given as row arrays (mysql2 [rows, fields] shape is built here).
function stubDb(script) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params || [] });
      if (!script.length) throw new Error('stubDb: unscripted query: ' + sql);
      return [script.shift()];
    },
  };
}

// Minimal definitions with distinct / equal field-set signatures.
const defA  = { sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }] };
const defA2 = { sections: [{ title: 'S renamed', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }] }; // same signature
const defB  = { sections: [{ title: 'S', rows: [{ fields: [{ name: 'b', type: 'text' }] }] }] };          // different signature

async function rejects(promise, status, msgPart) {
  try { await promise; }
  catch (err) {
    assert.strictEqual(err.status, status, `expected .status ${status}, got ${err.status}: ${err.message}`);
    if (msgPart) assert.ok(err.message.includes(msgPart), `message "${err.message}" should include "${msgPart}"`);
    return;
  }
  assert.fail('expected rejection with status ' + status);
}

(async () => {
  // ══════════ listVersions: schema_changed vs chronological predecessor ══════════
  {
    const db = stubDb([
      [{ id: 1 }],                                              // template exists
      [                                                          // versions ORDER BY id ASC
        { id: 10, schema_version: 1, definition: JSON.stringify(defA),  published_by: 6, published_at: 't1', user_name: 'fred' },
        { id: 11, schema_version: 1, definition: JSON.stringify(defA2), published_by: 6, published_at: 't2', user_name: 'fred' },
        { id: 12, schema_version: 2, definition: defB,          published_by: 7, published_at: 't3', user_name: null },
      ],
    ]);
    const out = await tplSvc.listVersions(db, 1);
    assert.strictEqual(out.length, 3);
    // newest first
    assert.deepStrictEqual(out.map(v => v.id), [12, 11, 10], 'newest first');
    const byId = Object.fromEntries(out.map(v => [v.id, v]));
    assert.strictEqual(byId[10].schema_changed, true,  'first publish establishes the schema');
    assert.strictEqual(byId[11].schema_changed, false, 'same-signature republish → no schema change');
    assert.strictEqual(byId[12].schema_changed, true,  'field-set diff → changed');
    // no definitions in the payload
    out.forEach(v => assert.ok(!('definition' in v), 'list carries no definition bodies'));
    // both string-JSON (MariaDB-style) and parsed (MySQL8 native) definitions handled above
    assert.ok(db.calls[1].sql.includes('ORDER BY v.id ASC'), 'computed in chronological order');
  }

  // ══════════ listVersions: unknown template → 404 ══════════
  {
    const db = stubDb([[]]);   // no template row
    await rejects(tplSvc.listVersions(db, 999), 404, 'Template 999 not found');
  }

  // ══════════ getVersion: ownership enforced ══════════
  {
    const db = stubDb([[{ id: 1 }], []]);   // template exists, version query empty (wrong template_id)
    await rejects(tplSvc.getVersion(db, 1, 55), 404, 'Version 55 not found for template 1');
    assert.ok(db.calls[1].sql.includes('v.id = ? AND v.template_id = ?'), 'version scoped to template');
    assert.deepStrictEqual(db.calls[1].params.slice(0, 2), [55, 1]);
  }
  {
    const db = stubDb([[{ id: 1 }],
      [{ id: 55, template_id: 1, schema_version: 2, definition: JSON.stringify(defB), published_by: 6, published_at: 't', user_name: 'fred' }]]);
    const v = await tplSvc.getVersion(db, 1, 55);
    assert.deepStrictEqual(v.definition, defB, 'definition parsed');
  }

  // ══════════ restoreVersion: SQL column copy, no JSON placeholder ══════════
  {
    const tplRow = { id: 1, form_key: 'k', title: 'T', link_type: 'case', schema_version: 2,
      definition: JSON.stringify(defB), draft_definition: JSON.stringify(defA),
      published_at: 't', updated_by: 6, created_at: 'c', updated_at: 'u' };
    const db = stubDb([
      [{ id: 1 }],                                     // template exists
      [{ id: 10, schema_version: 1 }],                 // version belongs to template
      { affectedRows: 1 },                             // UPDATE ... JOIN result (non-array OkPacket shape)
      [tplRow],                                        // fetchRow after
    ]);
    const out = await tplSvc.restoreVersion(db, 1, 10, 6);
    const upd = db.calls[2];
    assert.ok(/UPDATE form_templates ft JOIN form_template_versions v/.test(upd.sql), 'column-to-column copy');
    assert.ok(upd.sql.includes('ft.draft_definition = v.definition'), 'draft gets the version definition in SQL');
    assert.ok(!upd.sql.includes('definition = ?'), 'no JSON re-bound through a placeholder');
    assert.deepStrictEqual(upd.params, [10, 6, 1], 'versionId, userId, templateId');
    assert.deepStrictEqual(out.restored, { version_id: 10, schema_version: 1 });
    assert.deepStrictEqual(out.template.draft_definition, defA, 'full row returned, JSON normalized');
  }

  // ══════════ browseSubmissions: WHERE building + params ══════════
  {
    const db = stubDb([[]]);
    const out = await formSvc.browseSubmissions(db, {
      form_key: 'test_quick_notes', link_type: 'case', link_id: 'rIxpyvYG',
      status: 'submitted', before_id: '251', limit: '10',
    });
    const c = db.calls[0];
    assert.ok(c.sql.includes('fs.form_key = ?') && c.sql.includes('fs.link_type = ?') &&
              c.sql.includes('fs.link_id = ?') && c.sql.includes('fs.status = ?') &&
              c.sql.includes('fs.id < ?'), 'all filters in WHERE');
    assert.ok(c.sql.includes('ORDER BY fs.id DESC'), 'newest first');
    assert.ok(!c.sql.includes('fs.data'), 'no data bodies in browse');
    assert.deepStrictEqual(c.params, ['test_quick_notes', 'case', 'rIxpyvYG', 'submitted', 251, 10]);
    assert.strictEqual(out.limit, 10);
  }
  {
    const db = stubDb([[]]);
    await formSvc.browseSubmissions(db, {});      // no filters → no WHERE, default limit
    const c = db.calls[0];
    assert.ok(!c.sql.includes('WHERE'), 'no WHERE without filters');
    assert.deepStrictEqual(c.params, [50], 'default limit 50');
  }
  {
    const db = stubDb([[]]);
    await formSvc.browseSubmissions(db, { limit: '9999' });
    assert.deepStrictEqual(stripLast(db), 200, 'limit clamped to 200');
    function stripLast(d) { return d.calls[0].params[d.calls[0].params.length - 1]; }
  }
  await rejects(formSvc.browseSubmissions(stubDb([]), { status: 'weird' }), 400, "status must be 'draft' or 'submitted'");
  await rejects(formSvc.browseSubmissions(stubDb([]), { before_id: 'abc' }), 400, 'before_id');
  await rejects(formSvc.browseSubmissions(stubDb([]), { before_id: '-4' }), 400, 'before_id');

  // ══════════ getSubmission ══════════
  {
    const db = stubDb([[{ id: 251, form_key: 'test_quick_notes', data: { note: 'x' } }]]);
    const s = await formSvc.getSubmission(db, 251);
    assert.strictEqual(s.id, 251);
    assert.ok(db.calls[0].sql.includes('fs.data'), 'data included on the single-row fetch');
  }
  await rejects(formSvc.getSubmission(stubDb([[]]), 9), 404, 'Submission 9 not found');

  console.log('formTemplates_slice4_service_test: ALL PASS');
})().catch(err => { console.error(err); process.exit(1); });