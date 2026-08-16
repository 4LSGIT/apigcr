// Form-dev authoring gate (2026-08-16 — ref/EXTERNAL_CODE_CSS_DECISION.md §Q5).
//
// Covers, service-level (stub-pool style per formtemplates.x1visibility):
//   authoredKeyChanges — the diff semantics the whole gate rides on
//     (absent/null/'' all equal "not set"; byte-identical round-trip = no
//     change; introduce/change/REMOVE all count).
//   createTemplate — gated iff the new definition carries code/hooks/css;
//     clean creates need no authz; absent authz fails CLOSED.
//   updateTemplate — field-only edits on a code-carrying template pass for
//     everyone (the builder round-trips code untouched); any authored-key
//     diff (add / edit / clear) is 403 without formDev and passes with it;
//     title-only updates never touch the gate.
//   restoreVersion — gated iff the restored version's authored keys differ
//     from the CURRENT draft's; the write stays a SQL column-to-column copy.
//   setVisibility — off-internal flips are 403 without formDev (before the
//     §4 refusal scan); flip-to-internal never needs authz.
//   Error shape — status 403, err.code 'form_dev_required', message names
//     the offending keys and the form_dev role (legible by design).
// Plus lib/auth.formDev.js isFormDev: api_key trust, SU, roles it/form_dev,
// portal/absent rejected.
'use strict';

const path = require('path');
const svc = require(path.join(__dirname, '..', 'services', 'formTemplateService.js'));
const { isFormDev } = require(path.join(__dirname, '..', 'lib', 'auth.formDev.js'));

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

async function rejects(promise, status, msgPart, code) {
  let err;
  try { await promise; } catch (e) { err = e; }
  expect(err).toBeDefined();
  expect(err.status).toBe(status);
  if (msgPart) expect(err.message).toContain(msgPart);
  if (code) expect(err.code).toBe(code);
}

const DEV = { formDev: true };

// ── Fixtures ────────────────────────────────────────────────────────────────

const cleanDef = {
  sections: [{ title: 'S', rows: [{ fields: [{ name: 'a', type: 'text' }] }] }],
};
const codeDef   = { ...cleanDef, code: 'window.ycHooks = {};' };
const codeDef2  = { ...cleanDef, code: 'window.ycHooks = { async onLoad() {} };' };
const cssDef    = { ...cleanDef, css: '.x{color:red}' };
const hooksDef  = { ...cleanDef, hooks: 'notes_341' };

const row = (over) => ({
  id: 5, form_key: 'k', title: 'T', link_type: 'case', schema_version: 1,
  visibility: 'internal', definition: null, draft_definition: cleanDef,
  published_at: null, updated_by: 9, created_at: 'c', updated_at: 'u',
  ...over,
});

// ── authoredKeyChanges ──────────────────────────────────────────────────────

describe('authoredKeyChanges — the diff the gate rides on', () => {
  const diff = svc.authoredKeyChanges;

  test('byte-identical round-trip (the builder save) → no change', () => {
    expect(diff(codeDef, { ...codeDef })).toEqual([]);
    expect(diff(cleanDef, cleanDef)).toEqual([]);
  });

  test('absent / null / empty-string are all "not set" (scan parity)', () => {
    expect(diff({ ...cleanDef, hooks: null }, cleanDef)).toEqual([]);
    expect(diff({ ...cleanDef, code: '' }, cleanDef)).toEqual([]);
    expect(diff(cleanDef, { ...cleanDef, css: '' })).toEqual([]);
  });

  test('introduce, change, and REMOVE all count', () => {
    expect(diff(codeDef, cleanDef)).toEqual(['code']);          // introduce
    expect(diff(codeDef2, codeDef)).toEqual(['code']);          // change
    expect(diff(cleanDef, codeDef)).toEqual(['code']);          // remove
    expect(diff({ ...codeDef, css: '.a{}' }, cleanDef)).toEqual(['code', 'css']);
  });

  test('create shape: prev null → any authored key is a change', () => {
    expect(diff(hooksDef, null)).toEqual(['hooks']);
    expect(diff(cleanDef, null)).toEqual([]);
  });
});

// ── createTemplate ──────────────────────────────────────────────────────────

describe('createTemplate — form-dev gate', () => {
  const body = (def) => ({ form_key: 'newkey', title: 'T', link_type: 'case', draft_definition: def });
  const createScript = () => [[], { insertId: 9 }, [row({ id: 9, form_key: 'newkey' })]];

  test('clean definition needs no authz (absent authz fine)', async () => {
    const db = stubDb(createScript());
    const out = await svc.createTemplate(db, body(cleanDef), 9);
    expect(out.id).toBe(9);
  });

  test('code-carrying definition: absent authz fails CLOSED with the legible 403', async () => {
    const db = stubDb([]);
    await rejects(svc.createTemplate(db, body(codeDef), 9),
      403, 'form-developer authorization', 'form_dev_required');
    expect(db.calls.length).toBe(0);   // rejected before any query
  });

  test('code-carrying definition passes WITH formDev', async () => {
    const db = stubDb(createScript());
    const out = await svc.createTemplate(db, body(codeDef), 9, DEV);
    expect(out.id).toBe(9);
  });
});

// ── updateTemplate ──────────────────────────────────────────────────────────

describe('updateTemplate — form-dev gate (diff, not presence)', () => {
  test('field-only edit on a CODE-CARRYING template passes for everyone', async () => {
    // Builder round-trip: incoming draft keeps code byte-identical, adds a field.
    const incoming = {
      code: codeDef.code,
      sections: [{ title: 'S', rows: [{ fields: [
        { name: 'a', type: 'text' }, { name: 'b', type: 'text' },
      ] }] }],
    };
    const db = stubDb([[row({ draft_definition: codeDef })], [], [row({ draft_definition: incoming })]]);
    const out = await svc.updateTemplate(db, 5, { draft_definition: incoming }, 22);
    expect(out.draft_definition).toEqual(incoming);
  });

  test('introducing code without formDev → 403 naming code and the role; no UPDATE', async () => {
    const db = stubDb([[row({ draft_definition: cleanDef })]]);
    await rejects(svc.updateTemplate(db, 5, { draft_definition: codeDef }, 22),
      403, 'form_dev', 'form_dev_required');
    expect(db.calls.length).toBe(1);   // fetchRow only
  });

  test('CLEARING code without formDev is also gated (removal is a change)', async () => {
    const db = stubDb([[row({ draft_definition: codeDef })]]);
    await rejects(svc.updateTemplate(db, 5, { draft_definition: cleanDef }, 22),
      403, 'code', 'form_dev_required');
  });

  test('changing css / hooks gated the same way; passes with formDev', async () => {
    const db1 = stubDb([[row({ draft_definition: cleanDef })]]);
    await rejects(svc.updateTemplate(db1, 5, { draft_definition: cssDef }, 22),
      403, 'css', 'form_dev_required');

    const db2 = stubDb([[row({ draft_definition: cleanDef })], [], [row({ draft_definition: hooksDef })]]);
    const out = await svc.updateTemplate(db2, 5, { draft_definition: hooksDef }, 22, DEV);
    expect(out.draft_definition).toEqual(hooksDef);
  });

  test('title-only update never touches the gate', async () => {
    const db = stubDb([[row({ draft_definition: codeDef })], [], [row({ draft_definition: codeDef, title: 'New' })]]);
    const out = await svc.updateTemplate(db, 5, { title: 'New' }, 22);
    expect(out.title).toBe('New');
  });
});

// ── restoreVersion ──────────────────────────────────────────────────────────

describe('restoreVersion — form-dev gate on the version↔draft diff', () => {
  const tplRow = (draft) => row({ draft_definition: draft, definition: cleanDef, published_at: 'p' });

  test('restoring a version whose code differs from the current draft → 403 without formDev', async () => {
    const db = stubDb([
      [tplRow(cleanDef)],
      [{ id: 10, schema_version: 1, definition: JSON.stringify(codeDef) }],
    ]);
    await rejects(svc.restoreVersion(db, 5, 10, 22),
      403, 'restoring a version that changes code', 'form_dev_required');
    expect(db.calls.length).toBe(2);   // no UPDATE
  });

  test('same restore passes WITH formDev; write stays SQL column-to-column', async () => {
    const db = stubDb([
      [tplRow(cleanDef)],
      [{ id: 10, schema_version: 1, definition: JSON.stringify(codeDef) }],
      { affectedRows: 1 },
      [tplRow(codeDef)],
    ]);
    const out = await svc.restoreVersion(db, 5, 10, 22, DEV);
    expect(out.restored).toEqual({ version_id: 10, schema_version: 1 });
    const upd = db.calls[2];
    expect(upd.sql).toContain('ft.draft_definition = v.definition');
    expect(upd.sql).not.toContain('definition = ?');   // no JSON re-bound through a placeholder
  });

  test('restoring a version with the SAME authored keys needs no authz', async () => {
    const db = stubDb([
      [tplRow(codeDef)],
      [{ id: 10, schema_version: 1, definition: JSON.stringify({ ...codeDef }) }],
      { affectedRows: 1 },
      [tplRow(codeDef)],
    ]);
    const out = await svc.restoreVersion(db, 5, 10, 22);
    expect(out.restored.version_id).toBe(10);
  });
});

// ── setVisibility ───────────────────────────────────────────────────────────

describe('setVisibility — form-dev gate on off-internal flips', () => {
  test('off-internal without formDev → 403 (before the §4 scan), legible, no UPDATE', async () => {
    for (const vis of ['public', 'portal']) {
      // Published definition is CLEAN — proves the 403 is the authz gate,
      // not the refusal scan.
      const db = stubDb([[row({ definition: cleanDef, published_at: 'p' })]]);
      await rejects(svc.setVisibility(db, 5, vis, 22),
        403, 'form-developer authorization', 'form_dev_required');
      expect(db.calls.length).toBe(1);   // fetchRow only
    }
  });

  test('off-internal WITH formDev succeeds even with code published (§4 refusal retired 2026-08-16)', async () => {
    const db = stubDb([[row({ definition: codeDef, published_at: 'p' })], []]);
    const out = await svc.setVisibility(db, 5, 'public', 22, DEV);
    expect(out).toEqual({ visibility: 'public' });
  });

  test('flip back to internal never needs authz', async () => {
    const db = stubDb([
      [row({ definition: codeDef, published_at: 'p', visibility: 'public' })],
      [],
    ]);
    const out = await svc.setVisibility(db, 5, 'internal', 22);
    expect(out).toEqual({ visibility: 'internal' });
  });
});

// ── lib/auth.formDev — isFormDev ────────────────────────────────────────────

describe('isFormDev (lib/auth.formDev.js)', () => {
  test('api_key callers are trusted (requireAuth allowApiKey semantics)', () => {
    expect(isFormDev({ type: 'api_key', key_label: 'internal' })).toBe(true);
    expect(isFormDev({ type: 'api_key', key_id: 3, key_label: 'pabbly' })).toBe(true);
  });

  test('SU passes regardless of roles', () => {
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized - SU', roles: [] })).toBe(true);
  });

  test('roles it / form_dev pass; plain staff does not', () => {
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized', roles: ['it', 'admin'] })).toBe(true);
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized', roles: ['staff', 'form_dev'] })).toBe(true);
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized', roles: ['staff'] })).toBe(false);
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized', roles: ['staff', 'attorney'] })).toBe(false);
    expect(isFormDev({ type: 'jwt', user_auth: 'authorized' })).toBe(false);   // no roles claim
  });

  test('portal / absent auth rejected', () => {
    expect(isFormDev({ type: 'portal', contactId: 1 })).toBe(false);
    expect(isFormDev(null)).toBe(false);
    expect(isFormDev(undefined)).toBe(false);
  });
});
