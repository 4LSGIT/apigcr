// X1 — form_templates.visibility + external-refusal machinery
// (ref/EXTERNAL_FORMS_DESIGN.md §3/§4/§6; §9.9 test-lock: server-side flip
// refusal). Service-level, stub-pool style per formTemplates_slice4 precedent.
//
// Covers:
//   validateDefinition — the `external` key (§6): exact-key object, badLink
//     enum, tolerated absent/null.
//   scanExternalRefusals (§4) — code/css/hooks presence semantics (hooks:null
//     and empty strings scan CLEAN — the §3 example carries "hooks": null),
//     embed detection across every container shape (sections rows, repeaters,
//     tabs, sticky regions), null definition scans clean.
//   setVisibility (§3) — enum gate, 404, flip refusal naming the offending
//     keys, back-to-internal always allowed, never-published always allowed
//     (draft content irrelevant — external serves PUBLISHED only), UPDATE
//     parameter shape.
//   publishTemplate — non-blocking external_refusals advisory: present only
//     when the row is externally visible AND the published draft carries
//     refused keys; publish itself never blocks on them.
'use strict';

const path = require('path');
const svc = require(path.join(__dirname, '..', 'services', 'formTemplateService.js'));

// mysql2-shaped stub pool: query() shifts the next scripted rows array and
// returns [rows] (callers destructure [[row]] / [rows] themselves).
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

async function rejects(promise, status, msgPart) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.status).toBe(status);
  if (msgPart) expect(err.message).toContain(msgPart);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const cleanDef = {
  hooks: null,            // the §3 example shape — must scan clean
  sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }],
};

const withExternal = (badLink) => ({
  sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }],
  ...(badLink === undefined ? { external: {} } : { external: { badLink } }),
});

const codeDef  = { ...cleanDef, code: 'window.ycHooks = {};' };
const cssDef   = { ...cleanDef, css: '.x{color:red}' };
const hooksDef = { sections: cleanDef.sections, hooks: 'notes_341' };

const embedSectionsDef = {
  sections: [{ title: 'S', rows: [{ fields: [
    { name: 'a', type: 'text' },
    { name: 'vid', type: 'embed', src: 'https://example.com' },
  ] }] }],
};
const embedRepeaterDef = {
  sections: [{ repeater: 'items', title: 'R', fields: [
    { name: 'x', type: 'text' },
    { name: 'frame', type: 'embed', src: 'https://example.com' },
  ] }],
};
const embedTabsDef = {
  tabs: [{ label: 'T1', sections: [{ title: 'S', rows: [{ fields: [
    { name: 'e1', type: 'embed', src: 'https://example.com' },
  ] }] }] }],
  stickyTop: [{ title: 'Top', rows: [{ fields: [
    { name: 'e2', type: 'embed', src: 'https://example.com' },
  ] }] }],
  stickyBottom: [{ title: 'Bot', rows: [{ fields: [
    { name: 'e3', type: 'embed', src: 'https://example.com' },
  ] }] }],
};

// A full form_templates row as fetchRow returns it.
function row(over) {
  return {
    id: 5, form_key: 'tkey', title: 'T', link_type: 'case', schema_version: 1,
    visibility: 'internal', definition: null, draft_definition: cleanDef,
    published_at: null, updated_by: null, created_at: 'c', updated_at: 'u',
    ...over,
  };
}

// ── validateDefinition: the `external` key (§6) ─────────────────────────────

describe('validateDefinition — external key (X1 §6)', () => {
  test('accepts absent, null, empty object, and both badLink modes', () => {
    expect(() => svc.validateDefinition(cleanDef)).not.toThrow();
    expect(() => svc.validateDefinition({ ...cleanDef, external: null })).not.toThrow();
    expect(() => svc.validateDefinition(withExternal(undefined))).not.toThrow(); // {}
    expect(() => svc.validateDefinition(withExternal('reject'))).not.toThrow();
    expect(() => svc.validateDefinition(withExternal('degrade'))).not.toThrow();
  });

  test('rejects non-object external', () => {
    expect(() => svc.validateDefinition({ ...cleanDef, external: 'reject' }))
      .toThrow(/external must be an object/);
    expect(() => svc.validateDefinition({ ...cleanDef, external: ['reject'] }))
      .toThrow(/external must be an object/);
  });

  test('rejects unknown keys (exact-key — a typo\'d "badlink" must not silently default)', () => {
    expect(() => svc.validateDefinition({ ...cleanDef, external: { badlink: 'reject' } }))
      .toThrow(/unknown key "badlink"/);
    expect(() => svc.validateDefinition({ ...cleanDef, external: { badLink: 'reject', mode: 1 } }))
      .toThrow(/unknown key "mode"/);
  });

  test('rejects badLink values outside reject|degrade', () => {
    expect(() => svc.validateDefinition(withExternal('open')))
      .toThrow(/badLink must be "reject" or "degrade"/);
    expect(() => svc.validateDefinition(withExternal(true)))
      .toThrow(/badLink must be "reject" or "degrade"/);
  });
});

// ── validateDefinition: external.postSubmit (X3) ────────────────────────────

describe('validateDefinition — external.postSubmit (X3)', () => {
  const withPS = (postSubmit) => ({
    ...cleanDef, external: { badLink: 'degrade', postSubmit },
  });

  test('accepts absent, null, empty object, and every valid shape', () => {
    expect(() => svc.validateDefinition(withExternal('degrade'))).not.toThrow(); // no postSubmit
    expect(() => svc.validateDefinition(withPS(null))).not.toThrow();
    expect(() => svc.validateDefinition(withPS({}))).not.toThrow();
    expect(() => svc.validateDefinition(withPS({ message: 'Thanks!' }))).not.toThrow();
    expect(() => svc.validateDefinition(withPS({ edit: true, new: false }))).not.toThrow();
    expect(() => svc.validateDefinition(withPS({ message: 'x', edit: true, new: true }))).not.toThrow();
  });

  test('exact-key: unknown postSubmit keys rejected', () => {
    expect(() => svc.validateDefinition(withPS({ redirect: '/x' })))
      .toThrow(/postSubmit has unknown key "redirect"/);
    expect(() => svc.validateDefinition(withPS({ Message: 'typo' })))
      .toThrow(/postSubmit has unknown key "Message"/);
  });

  test('shape: non-object postSubmit, non-string/over-length message, non-boolean edit/new', () => {
    expect(() => svc.validateDefinition(withPS('Thanks')))
      .toThrow(/postSubmit must be an object/);
    expect(() => svc.validateDefinition(withPS(['x'])))
      .toThrow(/postSubmit must be an object/);
    expect(() => svc.validateDefinition(withPS({ message: 7 })))
      .toThrow(/message must be a string/);
    expect(() => svc.validateDefinition(withPS({ message: 'x'.repeat(2001) })))
      .toThrow(/at most 2000 characters/);
    expect(() => svc.validateDefinition(withPS({ edit: 'yes' })))
      .toThrow(/edit must be a boolean/);
    expect(() => svc.validateDefinition(withPS({ new: 1 })))
      .toThrow(/new must be a boolean/);
  });
});

// ── scanExternalRefusals (§4) ───────────────────────────────────────────────

describe('scanExternalRefusals (X1 §4)', () => {
  test('null / non-object / clean definitions scan clean', () => {
    expect(svc.scanExternalRefusals(null)).toEqual([]);
    expect(svc.scanExternalRefusals(undefined)).toEqual([]);
    expect(svc.scanExternalRefusals('nope')).toEqual([]);
    expect(svc.scanExternalRefusals(cleanDef)).toEqual([]);   // hooks: null in it
  });

  test('empty-string code/css/hooks scan clean (nothing to execute)', () => {
    expect(svc.scanExternalRefusals({ ...cleanDef, code: '', css: '', hooks: '' })).toEqual([]);
  });

  test('non-empty code / css / hooks each refuse, individually and together', () => {
    expect(svc.scanExternalRefusals(codeDef)).toEqual(['code']);
    expect(svc.scanExternalRefusals(cssDef)).toEqual(['css']);
    expect(svc.scanExternalRefusals(hooksDef)).toEqual(['hooks']);
    expect(svc.scanExternalRefusals({ ...hooksDef, css: 'a{}' }).sort()).toEqual(['css', 'hooks']);
  });

  test('embed fields refuse — standard rows, repeaters, tabs + sticky regions', () => {
    expect(svc.scanExternalRefusals(embedSectionsDef)).toEqual(['embed field "vid"']);
    expect(svc.scanExternalRefusals(embedRepeaterDef)).toEqual(['embed field "frame"']);
    expect(svc.scanExternalRefusals(embedTabsDef).sort()).toEqual([
      'embed field "e1"', 'embed field "e2"', 'embed field "e3"',
    ]);
  });

  test('code + embed both reported', () => {
    const both = { ...embedSectionsDef, code: 'x=1' };
    expect(svc.scanExternalRefusals(both)).toEqual(['code', 'embed field "vid"']);
  });
});

// ── setVisibility (§3) ──────────────────────────────────────────────────────

describe('setVisibility (X1 §3; §9.9 test-lock)', () => {
  test('rejects an unknown visibility value (400, before any query)', async () => {
    const db = stubDb([]);
    await rejects(svc.setVisibility(db, 5, 'everyone', 9), 400, 'visibility must be one of');
    expect(db.calls.length).toBe(0);
  });

  test('404 on unknown template', async () => {
    const db = stubDb([[]]);                                   // fetchRow: no row
    await rejects(svc.setVisibility(db, 99, 'public', 9), 404, 'Template 99 not found');
  });

  test('REFUSES public/portal while the published definition carries code (message names it)', async () => {
    for (const vis of ['public', 'portal']) {
      const db = stubDb([[row({ definition: codeDef, published_at: 'p' })]]);
      await rejects(svc.setVisibility(db, 5, vis, 9), 400, 'code');
      expect(db.calls.length).toBe(1);                         // fetchRow only — no UPDATE
    }
  });

  test('REFUSES exposure while the published definition carries an embed field', async () => {
    const db = stubDb([[row({ definition: embedSectionsDef, published_at: 'p' })]]);
    await rejects(svc.setVisibility(db, 5, 'public', 9), 400, 'embed field "vid"');
  });

  test('back to internal is ALWAYS allowed — even with refused keys published', async () => {
    const db = stubDb([
      [row({ definition: codeDef, published_at: 'p', visibility: 'public' })],
      [],                                                      // UPDATE
    ]);
    const out = await svc.setVisibility(db, 5, 'internal', 9);
    expect(out).toEqual({ visibility: 'internal' });
    expect(db.calls[1].sql).toContain('UPDATE form_templates SET visibility');
    expect(db.calls[1].params).toEqual(['internal', 9, 5]);
  });

  test('exposure of a CLEAN published definition succeeds (UPDATE param shape)', async () => {
    const db = stubDb([
      [row({ definition: cleanDef, published_at: 'p' })],
      [],                                                      // UPDATE
    ]);
    const out = await svc.setVisibility(db, 5, 'public', 22);
    expect(out).toEqual({ visibility: 'public' });
    expect(db.calls[1].params).toEqual(['public', 22, 5]);
  });

  test('never-published template may hold any visibility — draft content is irrelevant', async () => {
    // definition NULL, draft carries code: external routes serve PUBLISHED
    // only (nothing yet), and the X2 per-request scan re-checks at serve time.
    const db = stubDb([
      [row({ definition: null, draft_definition: codeDef })],
      [],                                                      // UPDATE
    ]);
    const out = await svc.setVisibility(db, 5, 'public', 9);
    expect(out).toEqual({ visibility: 'public' });
  });
});

// ── publishTemplate — external_refusals advisory (non-blocking) ─────────────

describe('publishTemplate — X1 external_refusals advisory', () => {
  // publishTemplate script: fetchRow → UPDATE → INSERT version row.
  const publishScript = (r) => [[r], [], []];

  test('externally visible + refused keys in the draft → advisory present, publish NOT blocked', async () => {
    const db = stubDb(publishScript(row({
      visibility: 'public', definition: cleanDef, published_at: 'p',
      draft_definition: codeDef,
    })));
    const out = await svc.publishTemplate(db, 5, 9);
    expect(out.external_refusals).toEqual(['code']);
    expect(out.schema_version).toBe(1);                        // same signature — no bump
    expect(db.calls.length).toBe(3);                           // publish ran in full
  });

  test('internal visibility → no advisory key, even with code in the draft', async () => {
    const db = stubDb(publishScript(row({
      visibility: 'internal', definition: cleanDef, published_at: 'p',
      draft_definition: codeDef,
    })));
    const out = await svc.publishTemplate(db, 5, 9);
    expect('external_refusals' in out).toBe(false);
  });

  test('externally visible + clean draft → no advisory key', async () => {
    const db = stubDb(publishScript(row({
      visibility: 'portal', definition: cleanDef, published_at: 'p',
      draft_definition: cleanDef,
    })));
    const out = await svc.publishTemplate(db, 5, 9);
    expect('external_refusals' in out).toBe(false);
  });
});