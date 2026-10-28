'use strict';
/**
 * tests/caseyContactRelations.test.js
 *
 * A6 — Casey proposes contact relation and role changes through reviewed
 * cards: contact.relation.create.v1 / .update.v1 and contact.role.create.v1 /
 * .update.v1, plus the A6.0 read kind contact.relations that supplies their
 * evidence (the relation/role tables are outside the curated report schema,
 * so sql.read cannot reach them).
 *
 * The contract pinned here (server side; the browser half — builders,
 * click-time precheck, outcomes — is in tests/assistantUi.test.js):
 *   1. the casey_contact_relations_enabled switch ('0' = dark; unset = on);
 *   2. the type / role code resolves from the REGISTRY (an unknown or retired
 *      code refuses and names the live ones); status from the type's vocab;
 *   3. direction and uniqueness: one relation per pair and type in EITHER
 *      direction — the reverse of a one-way type refuses with its own words,
 *      an inactive duplicate refuses (reactivation is deferred);
 *   4. the deferred remove: ending / deactivating keys, a type change, either
 *      contact id and role reactivation refuse BY NAME;
 *   5. evidence: both contact ids for a relation create, the exact
 *      relation_id / role_id row for an update;
 *   6. role attrs through the route's own validator (number identity), the
 *      COMPLETE-replacement update with dropped keys disclosed, and the
 *      trustee / judge downstream disclosure (an ambiguous judge suffix);
 *   7. the read kind's validator, fingerprint and projection.
 * Every SQL predicate the normalizer adds runs on a real engine in
 * tests/caseyContactRelations.mysql.test.js.
 *
 *   npx jest tests/caseyContactRelations.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const relSvc = require(path.join(REPO, 'services', 'contactRelationService'));
const roleSvc = require(path.join(REPO, 'services', 'contactRoleService'));
const { normalizeActionDraft, validateStep, stepFingerprint, contactRelationsRead } = svc;

const TYPES = {
  spouse: { type_code: 'spouse', forward_label: 'Spouse of', reverse_label: 'Spouse of', is_symmetric: 1, allowed_statuses: 'separated', active: 1, sort_order: 10 },
  parent_child: { type_code: 'parent_child', forward_label: 'Parent of', reverse_label: 'Child of', is_symmetric: 0, allowed_statuses: 'step,adopted,foster,estranged', active: 1, sort_order: 30 },
  business_partner: { type_code: 'business_partner', forward_label: 'Business partner of', reverse_label: 'Business partner of', is_symmetric: 1, allowed_statuses: '', active: 1, sort_order: 60 },
  old_type: { type_code: 'old_type', forward_label: 'Old of', reverse_label: 'Old by', is_symmetric: 0, allowed_statuses: '', active: 0, sort_order: 999 },
};
const TRUSTEE_SCHEMA = [{ key: 'chapter', type: 'multi_select', label: 'Chapters', options: [7, 11, 12, 13], required: true },
  { key: 'zoom_link', type: 'url', label: '341 Zoom link', required: false }];
const JUDGE_SCHEMA = [{ key: 'judge_3', type: 'text', label: 'Docket suffix (3-letter)', required: true }];
const ROLE_TYPES = {
  trustee: { role_code: 'trustee', label: 'Trustee', attrs_schema: JSON.stringify(TRUSTEE_SCHEMA), active: 1, sort_order: 20 },
  judge: { role_code: 'judge', label: 'Judge', attrs_schema: JSON.stringify(JUDGE_SCHEMA), active: 1, sort_order: 10 },
  retired: { role_code: 'retired', label: 'Retired', attrs_schema: null, active: 0, sort_order: 99 },
};
const CONTACTS = {
  77: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person' },
  78: { contact_id: 78, contact_name: 'Sam Client', contact_kind: 'person' },
  90: { contact_id: 90, contact_name: 'Acme Corp', contact_kind: 'org' },
};

function makeDb(over = {}) {
  const state = { relations: over.relations || [], roles: over.roles || [], judges: over.judges || [], reads: [] };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    state.reads.push([flat, params]);
    if (flat === 'SELECT contact_id, contact_name, contact_kind FROM contacts WHERE contact_id = ? LIMIT 1') {
      const c = CONTACTS[params[0]];
      return [c && !(over.missing || []).includes(params[0]) ? [{ ...c }] : []];
    }
    if (flat === 'SELECT type_code, forward_label, reverse_label, is_symmetric, allowed_statuses, active FROM contact_relation_types WHERE type_code = ? LIMIT 1') {
      // general_ci: the registry finds a differently-cased code.
      const t = Object.values(TYPES).find((x) => x.type_code.toLowerCase() === String(params[0]).toLowerCase());
      return [t ? [{ ...t }] : []];
    }
    if (flat === 'SELECT type_code, forward_label FROM contact_relation_types WHERE active = 1 ORDER BY sort_order ASC, type_code ASC') {
      return [Object.values(TYPES).filter((t) => t.active).map((t) => ({ type_code: t.type_code, forward_label: t.forward_label }))];
    }
    if (/^SELECT id, contact_a_id, contact_b_id, active FROM contact_relations WHERE type_code = \? AND \(\(contact_a_id = \? AND contact_b_id = \?\) OR \(contact_a_id = \? AND contact_b_id = \?\)\) ORDER BY id ASC LIMIT 1$/.test(flat)) {
      const [code, a, b] = params;
      return [state.relations.filter((r) => r.type_code === code
        && ((r.contact_a_id === a && r.contact_b_id === b) || (r.contact_a_id === b && r.contact_b_id === a))).slice(0, 1)];
    }
    if (flat === 'SELECT role_code, label, attrs_schema, active FROM contact_role_types WHERE role_code = ? LIMIT 1') {
      const t = ROLE_TYPES[String(params[0]).toLowerCase()];
      return [t ? [{ ...t }] : []];
    }
    if (flat === 'SELECT role_code, label FROM contact_role_types WHERE active = 1 ORDER BY sort_order ASC, role_code ASC') {
      return [Object.values(ROLE_TYPES).filter((t) => t.active).sort((x, y) => x.sort_order - y.sort_order).map((t) => ({ role_code: t.role_code, label: t.label }))];
    }
    if (flat === 'SELECT id, active FROM contact_roles WHERE contact_id = ? AND role = ? LIMIT 1') {
      return [state.roles.filter((r) => r.contact_id === params[0] && r.role === params[1]).map((r) => ({ id: r.id, active: r.active }))];
    }
    if (/^SELECT cr\.contact_id, c\.contact_name FROM contact_roles cr JOIN contacts c/.test(flat)) {
      return [state.judges.filter((j) => j.contact_id !== params[0] && j.judge_3 === params[1])];
    }
    if (flat === 'SELECT contact_name FROM contacts WHERE contact_id = ? LIMIT 1') {
      const c = CONTACTS[params[0]];
      return [c ? [{ contact_name: c.contact_name }] : []];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query, state };
}

// Evidence: q1 = a contacts read; q2 = a contact.relations read of contact 77.
const EVIDENCE = [
  { id: 'q1', purpose: 'contacts', rows: [{ contact_id: '77', contact_name: 'Dana Client' }, { contact_id: '78', contact_name: 'Sam Client' }, { contact_id: '90', contact_name: 'Acme Corp' }] },
  { id: 'q2', purpose: 'relations', rows: [
    { row_type: 'relation', contact_id: '77', relation_id: '44', contact_a_id: '77', contact_b_id: '78', type_code: 'spouse' },
    { row_type: 'role', contact_id: '77', role_id: '31', role: 'trustee' },
    { row_type: 'relation_type', type_code: 'spouse' },
  ] },
];
const both = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q1', row_number: 2 }];
const relCreate = (over = {}) => ({ kind: 'contact.relation.create.v1', contact_a_id: 77, contact_b_id: 78, type_code: 'parent_child', evidence: both, ...over });
const relUpdate = (over = {}) => ({ kind: 'contact.relation.update.v1', relation_id: 44, changes: { status: 'separated' }, evidence: [{ query_id: 'q2', row_number: 1 }], ...over });
const roleCreate = (over = {}) => ({ kind: 'contact.role.create.v1', contact_id: 77, role: 'trustee', attrs: { chapter: [7, 13] }, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const roleUpdate = (over = {}) => ({ kind: 'contact.role.update.v1', contact_id: 77, role_id: 31, attrs: { chapter: [13] }, evidence: [{ query_id: 'q2', row_number: 2 }], ...over });

const RELATION_44 = { id: 44, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, active: 1, status: '', start_date: new Date('2010-06-12T00:00:00Z'),
  end_date: null, end_reason: '', notes: 'met in Detroit', updated_at: new Date('2026-10-01T12:00:00Z'),
  // getRelation's real projection (contactRelationService._projectRelationRow, contact_a's view): no name for A.
  perspective: { label: 'Spouse of', other_contact_id: 78, other_contact_name: 'Sam Client' },
  is_symmetric: 1, forward_label: 'Spouse of', reverse_label: 'Spouse of' };
const ROLE_31 = { id: 31, contact_id: 77, role: 'trustee', attrs: { zoom_link: 'https://zoom.us/j/1', chapter: [7, 13], legacy: 'x' }, active: 1, sort_order: 0 };

let getRelation; let getRoleRow;
beforeEach(() => {
  delete process.env.CASEY_CONTACT_RELATIONS_ENABLED;
  getRelation = jest.spyOn(relSvc, 'getRelation').mockImplementation(async (_db, id) => (Number(id) === 44 ? { ...RELATION_44 } : null));
  getRoleRow = jest.spyOn(roleSvc, 'getRoleRow').mockImplementation(async (_db, id) => (Number(id) === 31 ? { ...ROLE_31, attrs: { ...ROLE_31.attrs } } : null));
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.CASEY_CONTACT_RELATIONS_ENABLED; });

const refuse = (value, re, dbOver) => expect(normalizeActionDraft(makeDb(dbOver), value, EVIDENCE)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes all four kinds unavailable; unset is ON", async () => {
    process.env.CASEY_CONTACT_RELATIONS_ENABLED = '0';
    for (const v of [relCreate(), relUpdate(), roleCreate(), roleUpdate()]) {
      await expect(normalizeActionDraft(makeDb(), v, EVIDENCE)).rejects.toThrow(/^Action kind is unavailable$/);
    }
    delete process.env.CASEY_CONTACT_RELATIONS_ENABLED;
    await expect(normalizeActionDraft(makeDb(), relCreate(), EVIDENCE)).resolves.toMatchObject({ kind: 'contact.relation.create.v1' });
  });
});

describe('contact.relation.create.v1', () => {
  test('the card names both contacts, the registry type with both labels, and the reviewed fields', async () => {
    const out = await normalizeActionDraft(makeDb(), relCreate({ type_code: 'Parent_Child', status: 'adopted', start_date: '2015-01-02', notes: '  adopted 2015 ' }), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'contact.relation.create.v1', status: 'draft',
      relation: { type_code: 'parent_child', forward_label: 'Parent of', reverse_label: 'Child of', is_symmetric: false,
        contact_a: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person' },
        contact_b: { contact_id: 78, contact_name: 'Sam Client', contact_kind: 'person' } },
      fields: { status: 'adopted', start_date: '2015-01-02', notes: 'adopted 2015' },
    });
    expect(out.draft_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.evidence).toHaveLength(2);
  });

  test('ending a relation at create, unknown keys and a self-relation refuse by name', async () => {
    await refuse(relCreate({ end_date: '2020-01-01' }), /created ACTIVE — it takes no end_date\. Ending a relation is not available to Casey/);
    await refuse(relCreate({ active: 0, end_reason: 'divorced' }), /it takes no active, end_reason/);
    await refuse(relCreate({ created_by: 6 }), /Relation create carries unsupported fields: created_by/);
    await refuse(relCreate({ contact_b_id: 77 }), /cannot be related to itself/);
  });

  test('evidence must carry BOTH contact ids', async () => {
    await refuse(relCreate({ evidence: [{ query_id: 'q1', row_number: 1 }] }), /does not identify contact_b \(78\)/);
    await refuse(relCreate({ evidence: [{ query_id: 'q1', row_number: 2 }] }), /does not identify contact_a \(77\)/);
    // A relation row of a contact.relations read carries contact_id too.
    await expect(normalizeActionDraft(makeDb(), relCreate({ contact_b_id: 90, type_code: 'business_partner',
      evidence: [{ query_id: 'q2', row_number: 1 }, { query_id: 'q1', row_number: 3 }] }), EVIDENCE)).resolves.toMatchObject({ kind: 'contact.relation.create.v1' });
  });

  test('a contact that no longer exists refuses', async () => {
    await refuse(relCreate(), /Contact 78 \(contact_b\) is unavailable — it no longer exists/, { missing: [78] });
  });

  test('the type comes from the registry: unknown and retired codes refuse and list the live ones', async () => {
    await refuse(relCreate({ type_code: 'cousin' }), /Relation type "cousin" is not in the relation-type registry — use one of: spouse \("Spouse of"\), parent_child \("Parent of"\), business_partner/);
    await refuse(relCreate({ type_code: 'old_type' }), /Relation type "old_type" is retired \(inactive\) and cannot be used for a new relation/);
    await refuse(relCreate({ type_code: '' }), /needs a type_code from the relation-type registry/);
  });

  test("status from the type's vocabulary; dates real and not future; notes at most 500", async () => {
    await refuse(relCreate({ status: 'married' }), /Status "married" is not allowed for parent_child \(allowed: step, adopted, foster, estranged\)/);
    await refuse(relCreate({ type_code: 'business_partner', status: 'silent' }), /Relation type business_partner takes no status/);
    await refuse(relCreate({ start_date: '2015-02-30' }), /must be a real YYYY-MM-DD date/);
    await refuse(relCreate({ start_date: '2999-01-01' }), /cannot be in the future/);
    await refuse(relCreate({ notes: 'x'.repeat(501) }), /notes exceed 500 characters/);
    await expect(normalizeActionDraft(makeDb(), relCreate({ notes: 'x'.repeat(500) }), EVIDENCE)).resolves.toBeTruthy();
  });

  test('one relation per pair and type in EITHER direction — the reverse of a one-way type has its own words', async () => {
    const same = { relations: [{ id: 5, type_code: 'parent_child', contact_a_id: 77, contact_b_id: 78, active: 1 }] };
    await refuse(relCreate(), /Dana Client and Sam Client already have a parent_child relation \(#5\)\. Nothing is proposed\.$/, same);
    const reverse = { relations: [{ id: 6, type_code: 'parent_child', contact_a_id: 78, contact_b_id: 77, active: 1 }] };
    await refuse(relCreate(), /Sam Client is already recorded as "Parent of Dana Client" \(relation #6\) — the reverse of what was asked; a parent_child relation cannot run both ways/, reverse);
    const sym = { relations: [{ id: 7, type_code: 'spouse', contact_a_id: 78, contact_b_id: 77, active: 1 }] };
    await refuse(relCreate({ type_code: 'spouse' }), /already have a spouse relation \(#7\)/, sym);
    const inactive = { relations: [{ id: 8, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, active: 0 }] };
    await refuse(relCreate({ type_code: 'spouse' }), /It is INACTIVE; reactivating or editing an ended relation is not available to Casey/, inactive);
    // Another type between the same pair is a different relation.
    await expect(normalizeActionDraft(makeDb(same), relCreate({ type_code: 'spouse' }), EVIDENCE)).resolves.toBeTruthy();
  });
});

describe('contact.relation.update.v1', () => {
  test('the card carries both ends, current values, only the changed keys and the concurrency version', async () => {
    const out = await normalizeActionDraft(makeDb(), relUpdate({ changes: { status: 'separated', notes: 'met in Detroit' } }), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'contact.relation.update.v1',
      relation: { relation_id: 44, type_code: 'spouse', is_symmetric: true, type_retired: false,
        contact_a: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person' }, contact_b: { contact_id: 78, contact_name: 'Sam Client', contact_kind: 'person' } },
      current: { status: '', start_date: '2010-06-12', notes: 'met in Detroit' },
      changes: { status: 'separated' },
      expected: { updated_at: '2026-10-01T12:00:00.000Z' },
    });
    expect(out.changes).not.toHaveProperty('notes');
  });

  test('ending, a type change, either contact and unknown fields refuse by name', async () => {
    await refuse(relUpdate({ changes: { end_date: '2026-10-01', end_reason: 'divorced' } }), /cannot change end_date, end_reason — ending or deactivating a relation is not available to Casey/);
    await refuse(relUpdate({ changes: { active: 0 } }), /cannot change active/);
    await refuse(relUpdate({ changes: { type_code: 'domestic_partner' } }), /cannot change type_code — a type change is not available to Casey/);
    await refuse(relUpdate({ changes: { contact_b_id: 90 } }), /cannot change contact_b_id — either end of a relation is fixed/);
    await refuse(relUpdate({ changes: { created_by: 1 } }), /changes unsupported fields: created_by/);
    await refuse(relUpdate({ changes: {} }), /needs a changes object/);
    await refuse(relUpdate({ contact_id: 77 }), /Relation update carries unsupported fields: contact_id/);
  });

  test('evidence must be the exact relation_id row; the relation must exist and be ACTIVE', async () => {
    await refuse(relUpdate({ evidence: [{ query_id: 'q1', row_number: 1 }] }), /does not identify relation 44 — cite a contact.relations row/);
    await refuse(relUpdate({ relation_id: 45, evidence: [{ query_id: 'q2', row_number: 1 }] }), /does not identify relation 45/);
    getRelation.mockResolvedValueOnce(null);
    await refuse(relUpdate(), /Relation 44 no longer exists/);
    getRelation.mockResolvedValueOnce({ ...RELATION_44, active: 0 });
    await refuse(relUpdate(), /Relation 44 is ended or inactive — editing or reactivating an ended relation is not available/);
    getRelation.mockResolvedValueOnce({ ...RELATION_44, end_date: new Date('2026-01-01T00:00:00Z') });
    await refuse(relUpdate(), /Relation 44 is ended or inactive/);
    await refuse(relUpdate(), /Contact 78 \(contact_b\) is unavailable/, { missing: [78] });
  });

  test('no change refuses; a grandfathered retired type keeps its non-type edits', async () => {
    await refuse(relUpdate({ changes: { notes: 'met in Detroit' } }), /does not change any value of relation 44/);
    await refuse(relUpdate({ changes: { start_date: '2010-06-12' } }), /does not change any value/);
    getRelation.mockResolvedValueOnce({ ...RELATION_44, type_code: 'old_type' });
    await expect(normalizeActionDraft(makeDb(), relUpdate({ changes: { notes: 'new' } }), EVIDENCE))
      .resolves.toMatchObject({ relation: { type_code: 'old_type', type_retired: true }, changes: { notes: 'new' } });
    await refuse(relUpdate({ changes: { status: 'divorced' } }), /Status "divorced" is not allowed for spouse \(allowed: separated\)/);
  });
});

describe('contact.role.create.v1', () => {
  test('the role resolves from the registry; attrs pass the route validator; the trustee effect is disclosed', async () => {
    const out = await normalizeActionDraft(makeDb(), roleCreate({ role: 'Trustee', attrs: { chapter: [7, 13], zoom_link: 'https://zoom.us/j/9' } }), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'contact.role.create.v1', contact: { contact_id: 77, contact_name: 'Dana Client' },
      role: { role_code: 'trustee', label: 'Trustee', fields: [{ key: 'chapter', label: 'Chapters', type: 'multi_select', required: true },
        { key: 'zoom_link', label: '341 Zoom link', type: 'url', required: false }] },
      attrs: { chapter: [7, 13], zoom_link: 'https://zoom.us/j/9' },
    });
    expect(out.effects[0]).toMatch(/^Trustee roster: the contact is on the panel-trustee roster for chapter\(s\) 7, 13/);
    expect(out.effects[out.effects.length - 1]).toBe('Every trustee picker, filter and roster lists the contact in this role immediately.');
  });

  test('unknown / retired roles, an active key, and invalid attrs refuse', async () => {
    await refuse(roleCreate({ role: 'mediator' }), /Role "mediator" is not in the role-type registry — use one of: judge \("Judge"\), trustee \("Trustee"\)/);
    await refuse(roleCreate({ role: 'retired', attrs: null }), /Role "retired" is retired \(inactive\)/);
    await refuse(roleCreate({ active: 1 }), /created ACTIVE — it takes no active flag/);
    await refuse(roleCreate({ sort_order: 2 }), /Role create carries unsupported fields: sort_order/);
    // Number identity: a string chapter is the bug class the validator exists for.
    await refuse(roleCreate({ attrs: { chapter: ['7'] } }), /attrs are invalid: attrs\.chapter: "7" has the wrong type — the option is 7 \(number\)/);
    await refuse(roleCreate({ attrs: undefined }), /attrs are invalid: attrs\.chapter is required/);
    await refuse(roleCreate({ attrs: [7] }), /must be a JSON object or null/);
    await refuse(roleCreate({ role: 'judge', attrs: { judge_3: 'x'.repeat(2100) } }), /attrs exceed 2000 characters/);
  });

  test('a contact already holding the role — active or inactive — refuses, naming the row', async () => {
    await refuse(roleCreate(), /Dana Client already holds the trustee role \(role row #31\)\. Nothing is proposed/, { roles: [{ id: 31, contact_id: 77, role: 'trustee', active: 1 }] });
    await refuse(roleCreate(), /Dana Client has an INACTIVE trustee role row \(#32\)\. Reactivating a role is not available to Casey/, { roles: [{ id: 32, contact_id: 77, role: 'trustee', active: 0 }] });
    await refuse(roleCreate({ evidence: [{ query_id: 'q1', row_number: 2 }] }), /Role create evidence does not identify contact 77/);
  });

  test('judge: the suffix effect, and a suffix another active judge carries is flagged AMBIGUOUS', async () => {
    const out = await normalizeActionDraft(makeDb({ judges: [{ contact_id: 501, contact_name: 'Hon. Other', judge_3: 'abc' }] }),
      roleCreate({ role: 'judge', attrs: { judge_3: 'ABC' } }), EVIDENCE);
    expect(out.effects[0]).toBe('Judge resolution: cases whose docket number ends in -abc resolve to this contact as their judge from the moment it is saved.');
    expect(out.effects[1]).toBe('AMBIGUOUS SUFFIX: Hon. Other (#501) already carries judge suffix "abc" — docket resolution for it falls back to the judge\'s name.');
    const clean = await normalizeActionDraft(makeDb(), roleCreate({ role: 'judge', attrs: { judge_3: 'xyz' } }), EVIDENCE);
    expect(clean.effects.some((e) => /^AMBIGUOUS/.test(e))).toBe(false);
  });
});

describe('contact.role.update.v1', () => {
  test('a COMPLETE replacement: dropped keys disclosed, expected = the stored attrs', async () => {
    const out = await normalizeActionDraft(makeDb(), roleUpdate({ attrs: { chapter: [13], zoom_link: 'https://zoom.us/j/1' } }), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'contact.role.update.v1', contact: { contact_id: 77 }, role: { role_id: 31, role_code: 'trustee', type_retired: false },
      current_attrs: ROLE_31.attrs, attrs: { chapter: [13], zoom_link: 'https://zoom.us/j/1' }, dropped_keys: ['legacy'],
      expected: { attrs: ROLE_31.attrs },
    });
  });

  test('deactivate / reactivate, the role code and a missing attrs object refuse by name', async () => {
    await refuse(roleUpdate({ active: 0 }), /cannot change active — deactivating \(removing\) or reactivating a role is not available/);
    await refuse(roleUpdate({ role: 'judge' }), /cannot change the role code/);
    await refuse(roleUpdate({ attrs: undefined }), /needs the COMPLETE new attrs object/);
  });

  test('evidence must carry contact_id AND role_id; the row must be on that contact and active', async () => {
    await refuse(roleUpdate({ evidence: [{ query_id: 'q1', row_number: 1 }] }), /does not identify role row 31 on contact 77/);
    await refuse(roleUpdate({ contact_id: 78, evidence: [{ query_id: 'q2', row_number: 2 }] }), /does not identify role row 31 on contact 78/);
    getRoleRow.mockResolvedValueOnce({ ...ROLE_31, contact_id: 78 });
    await refuse(roleUpdate(), /Role row 31 is not on contact 77/);
    getRoleRow.mockResolvedValueOnce({ ...ROLE_31, active: 0 });
    await refuse(roleUpdate(), /Role row 31 \(trustee\) is INACTIVE — reactivating a role is not available/);
  });

  test('no change is key-order-insensitive; invalid attrs refuse', async () => {
    await refuse(roleUpdate({ attrs: { legacy: 'x', chapter: [7, 13], zoom_link: 'https://zoom.us/j/1' } }), /does not change role row 31's attrs/);
    await refuse(roleUpdate({ attrs: { chapter: [] } }), /attrs\.chapter is required/);
  });
});

describe('A6.0 — the contact.relations read kind', () => {
  test('validator and fingerprint', () => {
    expect(validateStep({ id: 'q1', kind: 'contact.relations', purpose: 'p', contact_id: '77' }, 0)).toEqual({ id: 'q1', kind: 'contact.relations', purpose: 'p', contact_id: 77 });
    for (const bad of [0, -1, 'x', 1.5, undefined]) {
      expect(() => validateStep({ id: 'q1', kind: 'contact.relations', purpose: 'p', contact_id: bad }, 0)).toThrow(/needs a positive contact_id/);
    }
    expect(stepFingerprint({ kind: 'contact.relations', contact_id: 77 })).toBe('contact.relations:77');
    expect(stepFingerprint({ kind: 'contact.relations', contact_id: 77 })).not.toBe(stepFingerprint({ kind: 'contact.relations', contact_id: 78 }));
  });

  test('the projection: relation rows from the contact\'s view with both names and plain reads, role rows, both registries', async () => {
    jest.spyOn(relSvc, 'listContactRelations').mockResolvedValue({ total: 2, relations: [
      { id: 44, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, perspective: { other_contact_id: 78, other_contact_name: 'Sam Client' },
        active: 1, status: '', start_date: new Date('2010-06-12T00:00:00Z'), end_date: null, end_reason: '', notes: 'n', is_symmetric: 1,
        forward_label: 'Spouse of', reverse_label: 'Spouse of', updated_at: new Date('2026-10-01T12:00:00Z') },
      { id: 45, type_code: 'parent_child', contact_a_id: 90, contact_b_id: 77, perspective: { other_contact_id: 90, other_contact_name: 'Acme Corp' },
        active: 0, status: 'step', start_date: null, end_date: new Date('2020-01-01T00:00:00Z'), end_reason: 'deceased', notes: '', is_symmetric: 0,
        forward_label: 'Parent of', reverse_label: 'Child of', updated_at: new Date('2026-10-02T12:00:00Z') },
    ] });
    jest.spyOn(roleSvc, 'listContactRoles').mockResolvedValue({ roles: [{ id: 31, contact_id: 77, role: 'trustee', label: 'Trustee', attrs: { chapter: [7] }, active: 1 }] });
    jest.spyOn(relSvc, 'listRelationTypes').mockResolvedValue({ types: [{ type_code: 'spouse', forward_label: 'Spouse of', reverse_label: 'Spouse of', is_symmetric: 1, allowed_statuses: ['separated'] }] });
    jest.spyOn(roleSvc, 'listRoleTypes').mockResolvedValue({ types: [{ role_code: 'trustee', label: 'Trustee', attrs_schema: TRUSTEE_SCHEMA }] });
    const out = await contactRelationsRead(makeDb(), 77);
    expect(out.truncated).toBe(false);
    expect(out.rows.map((r) => r.row_type)).toEqual(['relation', 'relation', 'role', 'relation_type', 'role_type']);
    expect(out.rows[0]).toMatchObject({ contact_id: 77, relation_id: 44, contact_a_id: 77, contact_a_name: 'Dana Client', contact_b_id: 78, contact_b_name: 'Sam Client',
      reads: 'Dana Client: Spouse of Sam Client', reads_reverse: 'Sam Client: Spouse of Dana Client', start_date: '2010-06-12', active: 1,
      updated_at: '2026-10-01T12:00:00.000Z' });
    expect(out.rows[1]).toMatchObject({ relation_id: 45, contact_a_name: 'Acme Corp', contact_b_name: 'Dana Client', reads: 'Acme Corp: Parent of Dana Client',
      reads_reverse: 'Dana Client: Child of Acme Corp', active: 0, end_date: '2020-01-01', end_reason: 'deceased' });
    expect(out.rows[2]).toEqual({ row_type: 'role', contact_id: 77, role_id: 31, role: 'trustee', role_label: 'Trustee', attrs: '{"chapter":[7]}', active: 1 });
    expect(out.rows[3]).toEqual({ row_type: 'relation_type', type_code: 'spouse', forward_label: 'Spouse of', reverse_label: 'Spouse of', is_symmetric: 1, allowed_statuses: 'separated' });
    expect(out.rows[4]).toEqual({ row_type: 'role_type', role_code: 'trustee', role_label: 'Trustee', attrs_schema: JSON.stringify(TRUSTEE_SCHEMA) });
    expect(relSvc.listContactRelations).toHaveBeenCalledWith(expect.anything(), 77, { limit: 20 });
  });

  test('plan → execute runs the read on the app pool and its rows reach the answer stage as evidence', async () => {
    const aiService = require(path.join(REPO, 'services', 'aiService'));
    const OLD_SECRET = process.env.JWT_SECRET;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'a6-read-test-secret';
    jest.spyOn(relSvc, 'listContactRelations').mockResolvedValue({ total: 1, relations: [
      { id: 44, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, perspective: { other_contact_id: 78, other_contact_name: 'Sam Client' },
        active: 1, status: '', start_date: null, end_date: null, end_reason: '', notes: '', is_symmetric: 1,
        forward_label: 'Spouse of', reverse_label: 'Spouse of', updated_at: new Date('2026-10-01T12:00:00Z') }] });
    jest.spyOn(roleSvc, 'listContactRoles').mockResolvedValue({ roles: [] });
    jest.spyOn(relSvc, 'listRelationTypes').mockResolvedValue({ types: [] });
    jest.spyOn(roleSvc, 'listRoleTypes').mockResolvedValue({ types: [] });
    const db = { query: jest.fn(async (sql) => {
      if (/FROM users WHERE user/.test(sql)) return [[{ user: 7, user_name: 'S S', user_initials: 'SS', roles: 'staff' }]];
      if (/^SELECT contact_name FROM contacts WHERE contact_id = \? LIMIT 1$/.test(sql)) return [[{ contact_name: 'Dana Client' }]];
      return [[]];
    }) };
    const spy = jest.spyOn(aiService, 'call')
      .mockResolvedValueOnce({ ok: true, callId: 1, json: { action: 'query', summary: 'Read Dana\'s relationships',
        steps: [{ id: 'q1', kind: 'contact.relations', purpose: 'Dana\'s relationships', contact_id: 77 }] } })
      .mockResolvedValueOnce({ ok: true, callId: 2, json: { action: 'finish', reason: 'enough' } })
      .mockResolvedValueOnce({ ok: true, callId: 3, json: { answer: 'Dana is Sam\'s spouse.', suggestions: [], action_draft: null } });
    try {
      const made = await svc.plan(db, { question: 'Show me Dana Client\'s relationships (contact 77)', history: [], userId: 7 });
      expect(made.outcome).toBe('plan');
      await svc.execute(db, { signedTicket: made.ticket, userId: 7, auth: { type: 'jwt', userId: 7, roles: ['staff'] } });
      expect(relSvc.listContactRelations).toHaveBeenCalledWith(db, 77, { limit: 20 });
      const answerCall = spy.mock.calls.find(([, opts]) => opts.promptKey === 'assistant_answer');
      expect(answerCall[1].userInput).toContain('"relation_id":"44"');
      expect(answerCall[1].userInput).toContain('"reads":"Dana Client: Spouse of Sam Client"');
    } finally {
      process.env.JWT_SECRET = OLD_SECRET;
    }
  });

  test('a missing contact is one not_found row; more relations than the cap is truncated', async () => {
    jest.spyOn(relSvc, 'listContactRelations').mockResolvedValueOnce(null);
    await expect(contactRelationsRead(makeDb(), 999)).resolves.toEqual({ rows: [{ row_type: 'not_found', contact_id: 999, note: 'Contact 999 does not exist' }], truncated: false });
    jest.spyOn(relSvc, 'listContactRelations').mockResolvedValueOnce({ total: 21, relations: [] });
    jest.spyOn(roleSvc, 'listContactRoles').mockResolvedValue({ roles: [] });
    jest.spyOn(relSvc, 'listRelationTypes').mockResolvedValue({ types: [] });
    jest.spyOn(roleSvc, 'listRoleTypes').mockResolvedValue({ types: [] });
    await expect(contactRelationsRead(makeDb(), 77)).resolves.toMatchObject({ truncated: true });
  });
});
