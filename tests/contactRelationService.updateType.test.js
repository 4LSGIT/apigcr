// tests/contactRelationService.updateType.test.js
//
// updateRelation type_code-change behavior:
//   1. ER_DUP_ENTRY thrown by the UPDATE (unique key uc_relation on
//      (contact_a_id, contact_b_id, type_code)) maps to a clean,
//      400-mappable message instead of leaking the raw DB error.
//   2. Post-merge status is re-validated against the NEW type's vocab.
//   3. Happy path: type change issues the UPDATE and returns the
//      re-fetched relation.
//
// db is faked per repo convention (mock the collaborator, never the
// module under test); query() dispatches on SQL shape.

const svc = require('../services/contactRelationService');

const CURRENT = {
  id: 13,
  contact_a_id: 1899,
  contact_b_id: 2056,
  type_code: 'officer_of',
  active: 1,
  status: '',
  start_date: null,
  end_date: null,
  end_reason: '',
  notes: 'n',
  created_at: '2026-09-08 21:40:24',
  created_by: 1,
  updated_at: '2026-09-08 21:40:24',
};

const FULL_ROW = {
  ...CURRENT,
  is_symmetric: 0,
  forward_label: 'Member of',
  reverse_label: 'Member:',
  sort_order: 64,
  created_by_name: 'SS',
  a_id: 1899, a_name: 'A', a_pname: '', a_type: 'person',
  b_id: 2056, b_name: 'B', b_pname: '', b_type: 'Client',
};

/**
 * @param {object} o
 * @param {object} o.type        catalog row returned for the (new) type
 * @param {object} [o.current]   contact_relations row loaded by id
 * @param {Error}  [o.updateErr] thrown by the UPDATE statement
 * @param {object} [o.reverse]   row returned by the symmetric reverse check
 */
function makeDb({ type, current = CURRENT, updateErr = null, reverse = undefined }) {
  const calls = [];
  const query = jest.fn(async (sql) => {
    calls.push(sql);
    if (/^SELECT \* FROM contact_relations WHERE id = \?/.test(sql.trim())) {
      return [[current]];
    }
    if (/FROM contact_relation_types/.test(sql)) {
      return [[type]];
    }
    if (/SELECT id FROM contact_relations/.test(sql)) {
      return [[reverse]];
    }
    if (/UPDATE contact_relations SET/.test(sql)) {
      if (updateErr) throw updateErr;
      return [{ affectedRows: 1 }];
    }
    if (/FROM contact_relations cr/.test(sql)) {
      return [[FULL_ROW]];
    }
    throw new Error('unexpected sql: ' + sql);
  });
  return { db: { query }, calls };
}

describe('updateRelation with type_code change', () => {
  test('maps ER_DUP_ENTRY from the UPDATE to a clean 400-mappable message', async () => {
    const dup = new Error('Duplicate entry raw db text');
    dup.code = 'ER_DUP_ENTRY';
    const { db } = makeDb({
      type: {
        type_code: 'member_of', is_symmetric: 0,
        allowed_statuses: '', allowed_end_reasons: '', active: 1,
      },
      updateErr: dup,
    });

    await expect(svc.updateRelation(db, 13, { type_code: 'member_of' }))
      .rejects.toThrow('This relation already exists (same A, B, and type)');
  });

  test('non-dup UPDATE errors are rethrown untouched', async () => {
    const boom = new Error('ER_LOCK_WAIT_TIMEOUT something');
    boom.code = 'ER_LOCK_WAIT_TIMEOUT';
    const { db } = makeDb({
      type: {
        type_code: 'member_of', is_symmetric: 0,
        allowed_statuses: '', allowed_end_reasons: '', active: 1,
      },
      updateErr: boom,
    });

    await expect(svc.updateRelation(db, 13, { type_code: 'member_of' }))
      .rejects.toThrow('ER_LOCK_WAIT_TIMEOUT something');
  });

  test('stale status is re-validated against the NEW type vocab', async () => {
    const { db } = makeDb({
      current: { ...CURRENT, type_code: 'parent_child', status: 'step' },
      type: {
        type_code: 'employer_employee', is_symmetric: 0,
        allowed_statuses: 'part_time,contractor',
        allowed_end_reasons: '', active: 1,
      },
    });

    // Type changes but status is not cleared/replaced → merged 'step' is
    // invalid under the new vocab.
    await expect(svc.updateRelation(db, 13, { type_code: 'employer_employee' }))
      .rejects.toThrow(/status "step" is not allowed for this type/);
  });

  test('happy path: type change runs the UPDATE and returns the relation', async () => {
    const { db, calls } = makeDb({
      type: {
        type_code: 'member_of', is_symmetric: 0,
        allowed_statuses: '', allowed_end_reasons: '', active: 1,
      },
    });

    const { relation } = await svc.updateRelation(
      db, 13, { type_code: 'member_of', status: '', end_reason: '' });

    expect(relation).toBeTruthy();
    expect(relation.id).toBe(13);
    expect(calls.some(s => /UPDATE contact_relations SET/.test(s))).toBe(true);
  });

  test('changing to an inactive type is rejected', async () => {
    const { db } = makeDb({
      type: {
        type_code: 'member_of', is_symmetric: 0,
        allowed_statuses: '', allowed_end_reasons: '', active: 0,
      },
    });

    await expect(svc.updateRelation(db, 13, { type_code: 'member_of' }))
      .rejects.toThrow(/is not active/);
  });
});
