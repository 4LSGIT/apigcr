'use strict';
/**
 * tests/caseyContactRelationsRemove.test.js
 *
 * A6.2 — Casey ends, reactivates and removes contact relations and
 * deactivates, reactivates and removes contact role rows, through reviewed
 * cards on the routes the contact page's Relationships tab and the contact
 * form's Roles section use (Fred, 2026-11-09: "Casey can do at least anything
 * the user can do in the UI"):
 *   contact.relation.end.v1        PATCH  /api/contact-relations/:id {active:0, end_date, end_reason}
 *   contact.relation.reactivate.v1 PATCH  /api/contact-relations/:id {active:1, end_date:null, end_reason:''}
 *   contact.relation.remove.v1     DELETE /api/contact-relations/:id
 *   contact.role.deactivate.v1     PATCH  /api/contacts/:id/roles/:rowId {active:0}
 *   contact.role.reactivate.v1     PATCH  /api/contacts/:id/roles/:rowId {active:1}
 *   contact.role.remove.v1         DELETE /api/contacts/:id/roles/:rowId (inactive rows only, as the form)
 * plus the A6.1 update widened to what the tab's Edit dialog allows: a type
 * change, and the end fields of an ENDED relation.
 *
 * The contract pinned here (mocked db; the same SQL on a real engine, through
 * the real routes, is tests/caseyContactRelationsRemove.mysql.test.js):
 *   1. the casey_contact_relations_enabled switch darkens the new kinds too;
 *   2. state refusals BY NAME: an ended relation on an end card, an active one
 *      on a reactivate card, an inactive role on a deactivate card, an active
 *      one on a reactivate or remove card; a retired / unknown code never comes
 *      back (reactivate); an end_reason outside the type's vocabulary; a stored
 *      status the type no longer allows (the native PATCH re-checks it);
 *      another ACTIVE relation of the type between the pair (reactivate);
 *   3. DISCLOSURE: the Relationships tab, the stored-definition scan, NO UNDO
 *      on a delete (with END as the reversible alternative), the judge /
 *      trustee link shift MEASURED by running the real resolvers over a
 *      projected roles table — and refusal when it cannot be measured;
 *   4. the update widening (type change, ended relation's end fields);
 *   5. the request detector's lifecycle verbs;
 *   6. the browser half, lifted from public/assistant.html by name: fixed
 *      bodies from the KIND, the click-time re-read of every reviewed value,
 *      the route's own return shapes, the 404 "already removed" outcome, and
 *      the two families' danger rules.
 *
 *   npx jest tests/caseyContactRelationsRemove.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const relSvc = require(path.join(REPO, 'services', 'contactRelationService'));
const roleSvc = require(path.join(REPO, 'services', 'contactRoleService'));
const { nowLocal } = require(path.join(REPO, 'services', 'timezoneService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const TYPES = {
  spouse: { type_code: 'spouse', forward_label: 'Spouse of', reverse_label: 'Spouse of', is_symmetric: 1, allowed_statuses: 'separated', allowed_end_reasons: 'divorced,deceased,annulled', active: 1, sort_order: 10 },
  parent_child: { type_code: 'parent_child', forward_label: 'Parent of', reverse_label: 'Child of', is_symmetric: 0, allowed_statuses: 'step,adopted', allowed_end_reasons: 'deceased', active: 1, sort_order: 30 },
  business_partner: { type_code: 'business_partner', forward_label: 'Business partner of', reverse_label: 'Business partner of', is_symmetric: 1, allowed_statuses: '', allowed_end_reasons: '', active: 1, sort_order: 60 },
  old_type: { type_code: 'old_type', forward_label: 'Old of', reverse_label: 'Old by', is_symmetric: 0, allowed_statuses: '', allowed_end_reasons: 'gone', active: 0, sort_order: 999 },
};
const TRUSTEE_SCHEMA = [{ key: 'chapter', type: 'multi_select', label: 'Chapters', options: [7, 11, 12, 13], required: true }];
const JUDGE_SCHEMA = [{ key: 'judge_3', type: 'text', label: 'Docket suffix (3-letter)', required: true }];
const ROLE_TYPES = {
  trustee: { role_code: 'trustee', label: 'Trustee', attrs_schema: JSON.stringify(TRUSTEE_SCHEMA), active: 1, sort_order: 20 },
  judge: { role_code: 'judge', label: 'Judge', attrs_schema: JSON.stringify(JUDGE_SCHEMA), active: 1, sort_order: 10 },
  retired: { role_code: 'retired', label: 'Retired', attrs_schema: null, active: 0, sort_order: 99 },
  witness: { role_code: 'witness', label: 'Witness', attrs_schema: null, active: 1, sort_order: 30 },
};
const CONTACTS = {
  77: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person', contact_fname: 'Dana', contact_lname: 'Client' },
  78: { contact_id: 78, contact_name: 'Sam Client', contact_kind: 'person', contact_fname: 'Sam', contact_lname: 'Client' },
  501: { contact_id: 501, contact_name: 'Krispen Carroll', contact_kind: 'person', contact_fname: 'Krispen', contact_lname: 'Carroll' },
  502: { contact_id: 502, contact_name: 'Mark Carroll', contact_kind: 'person', contact_fname: 'Mark', contact_lname: 'Carroll' },
  601: { contact_id: 601, contact_name: 'Hon. Lee Judge', contact_kind: 'person', contact_fname: 'Lee', contact_lname: 'Judge' },
  602: { contact_id: 602, contact_name: 'Hon. Ann Other', contact_kind: 'person', contact_fname: 'Ann', contact_lname: 'Other' },
};

// The roles table the resolver queries read — a row is "active" by the
// predicate the query carries, so the projection's rewrite is exercised.
function rolePredicate(flat) {
  const not = /\(cr\.active = 1 AND cr\.id <> (\d+)\)/.exec(flat);
  if (not) return (r) => Number(r.active) === 1 && r.id !== Number(not[1]);
  const or = /\(cr\.active = 1 OR cr\.id = (\d+)\)/.exec(flat);
  if (or) return (r) => Number(r.active) === 1 || r.id === Number(or[1]);
  if (/cr\.active = 1/.test(flat)) return (r) => Number(r.active) === 1;
  throw new Error(`no active predicate in: ${flat}`);
}

function makeDb(over = {}) {
  const state = { relations: over.relations || [], roles: over.roles || [], cases: over.cases || [], readers: over.readers || {}, reads: [] };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    state.reads.push([flat, params]);
    if (flat === 'SELECT contact_id, contact_name, contact_kind FROM contacts WHERE contact_id = ? LIMIT 1') {
      const c = CONTACTS[params[0]];
      return [c && !(over.missing || []).includes(params[0]) ? [{ contact_id: c.contact_id, contact_name: c.contact_name, contact_kind: c.contact_kind }] : []];
    }
    if (flat === 'SELECT type_code, forward_label, reverse_label, is_symmetric, allowed_statuses, allowed_end_reasons, active FROM contact_relation_types WHERE type_code = ? LIMIT 1') {
      const t = Object.values(TYPES).find((x) => x.type_code.toLowerCase() === String(params[0]).toLowerCase());
      return [t ? [{ ...t }] : []];
    }
    if (flat === 'SELECT type_code, forward_label FROM contact_relation_types WHERE active = 1 ORDER BY sort_order ASC, type_code ASC') {
      return [Object.values(TYPES).filter((t) => t.active).map((t) => ({ type_code: t.type_code, forward_label: t.forward_label }))];
    }
    if (/^SELECT id, contact_a_id, contact_b_id, active FROM contact_relations WHERE type_code = \? AND id <> \? AND \(\(contact_a_id = \? AND contact_b_id = \?\) OR \(contact_a_id = \? AND contact_b_id = \?\)\)( AND active = 1)? ORDER BY id ASC LIMIT 1$/.test(flat)) {
      const [code, not, a, b] = params;
      const activeOnly = / AND active = 1 ORDER/.test(flat);
      return [state.relations.filter((r) => r.type_code === code && r.id !== not && (!activeOnly || Number(r.active) === 1)
        && ((r.contact_a_id === a && r.contact_b_id === b) || (r.contact_a_id === b && r.contact_b_id === a))).slice(0, 1)];
    }
    if (/ REGEXP \? ORDER BY/.test(flat)) {
      // The A7 stored-definitions scan: one query per table.
      const table = (/FROM (report_definitions|form_templates|portal_cards|pipeline_stage_requirements|sequence_steps|workflow_steps|email_ingest_rule_actions|phone_ingest_rule_actions)\b/.exec(flat) || [])[1];
      if (!table) throw new Error(`unexpected scan: ${flat}`);
      return [(state.readers[table] || []).filter((r) => new RegExp(params[0], 'i').test(r.body))];
    }
    if (flat === 'SELECT role_code, label, attrs_schema, active FROM contact_role_types WHERE role_code = ? LIMIT 1') {
      const t = ROLE_TYPES[String(params[0]).toLowerCase()];
      return [t ? [{ ...t }] : []];
    }
    if (flat === 'SELECT role_code, label FROM contact_role_types WHERE active = 1 ORDER BY sort_order ASC, role_code ASC') {
      return [Object.values(ROLE_TYPES).filter((t) => t.active).sort((x, y) => x.sort_order - y.sort_order).map((t) => ({ role_code: t.role_code, label: t.label }))];
    }
    if (flat === 'SELECT role_code FROM contact_role_types WHERE role_code = ? LIMIT 1') {
      const t = ROLE_TYPES[String(params[0]).toLowerCase()];
      return [t ? [{ role_code: t.role_code }] : []];
    }
    if (flat === 'SELECT contact_name, contact_lname FROM contacts WHERE contact_id = ? LIMIT 1') {
      const c = CONTACTS[params[0]];
      return [[c ? { contact_name: c.contact_name, contact_lname: c.contact_lname } : undefined].filter(Boolean)];
    }
    if (/^SELECT case_id, case_number_full, case_judge, case_judge_contact_id FROM cases/.test(flat)) {
      const [cid, suffix, , term] = params;
      return [state.cases.filter((k) => Number(k.case_judge_contact_id) === cid
        || (suffix && String(k.case_number_full || '').toLowerCase().includes(suffix))
        || (term && String(k.case_judge || '').toLowerCase().includes(term.toLowerCase())))];
    }
    if (/^SELECT case_id, case_trustee, case_chapter, case_trustee_contact_id FROM cases/.test(flat)) {
      return [state.cases.filter((k) => String(k.case_trustee || '').trim() !== '' || Number(k.case_trustee_contact_id) === params[0])];
    }
    if (flat === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id IN (?)') {
      return [params[0].map((id) => CONTACTS[id]).filter(Boolean).map((c) => ({ contact_id: c.contact_id, contact_name: c.contact_name }))];
    }
    // The ambiguity line (roleEffects) — stored state, another ACTIVE judge.
    if (/^SELECT cr\.contact_id, c\.contact_name FROM contact_roles cr JOIN contacts c/.test(flat)) {
      return [state.roles.filter((r) => r.role === 'judge' && Number(r.active) === 1 && r.contact_id !== params[0]
        && String(r.attrs && r.attrs.judge_3 || '').toLowerCase() === params[1]).map((r) => ({ contact_id: r.contact_id, contact_name: CONTACTS[r.contact_id].contact_name }))];
    }
    // ── the resolver's own queries (lib/caseRoleResolver, lib/trusteeRoster) ──
    if (/FROM contact_roles cr/.test(flat)) {
      if (over.failResolver) throw new Error('resolver query failed');
      const live = state.roles.filter(rolePredicate(flat));
      if (/^SELECT cr\.contact_id FROM contact_roles cr WHERE cr\.role = 'judge'/.test(flat)) {
        return [live.filter((r) => r.role === 'judge' && String(r.attrs && r.attrs.judge_3 || '').toLowerCase() === params[0]).map((r) => ({ contact_id: r.contact_id }))];
      }
      if (/LOWER\(c\.contact_name\) = LOWER\(\?\)/.test(flat)) {
        return [live.filter((r) => r.role === 'judge' && CONTACTS[r.contact_id].contact_name.toLowerCase() === String(params[0]).toLowerCase()).map((r) => ({ contact_id: r.contact_id }))];
      }
      if (/LOWER\(c\.contact_fname\) = LOWER\(\?\)/.test(flat)) {
        return [live.filter((r) => r.role === 'judge' && CONTACTS[r.contact_id].contact_fname.toLowerCase() === String(params[0]).toLowerCase()
          && CONTACTS[r.contact_id].contact_lname.toLowerCase() === String(params[1]).toLowerCase()).map((r) => ({ contact_id: r.contact_id }))];
      }
      if (/^SELECT cr\.contact_id, cr\.attrs, c\.contact_name, c\.contact_lname/.test(flat)) {
        return [live.filter((r) => r.role === 'trustee').map((r) => ({ contact_id: r.contact_id, attrs: r.attrs, contact_name: CONTACTS[r.contact_id].contact_name,
          contact_lname: CONTACTS[r.contact_id].contact_lname }))];
      }
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query, state };
}

// Evidence: q1 = a contact.relations read of contact 77 (+ role rows of 501 / 601).
const EVIDENCE = [
  { id: 'q1', purpose: 'relations', rows: [
    { row_type: 'relation', contact_id: '77', relation_id: '44', type_code: 'spouse' },
    { row_type: 'role', contact_id: '502', role_id: '32', role: 'trustee' },
    { row_type: 'role', contact_id: '601', role_id: '41', role: 'judge' },
    { row_type: 'role', contact_id: '77', role_id: '51', role: 'witness' },
  ] },
];
const cite = (n) => [{ query_id: 'q1', row_number: n }];
const end = (over = {}) => ({ kind: 'contact.relation.end.v1', relation_id: 44, end_date: '2026-11-01', end_reason: 'divorced', evidence: cite(1), ...over });
const reactivate = (over = {}) => ({ kind: 'contact.relation.reactivate.v1', relation_id: 44, evidence: cite(1), ...over });
const remove = (over = {}) => ({ kind: 'contact.relation.remove.v1', relation_id: 44, evidence: cite(1), ...over });
const update = (changes, over = {}) => ({ kind: 'contact.relation.update.v1', relation_id: 44, changes, evidence: cite(1), ...over });
const roleCard = (kind, contactId, roleId, n, over = {}) => ({ kind: `contact.role.${kind}.v1`, contact_id: contactId, role_id: roleId, evidence: cite(n), ...over });

const RELATION_44 = { id: 44, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, active: 1, status: '', start_date: new Date('2010-06-12T00:00:00Z'),
  end_date: null, end_reason: '', notes: 'met in Detroit', updated_at: new Date('2026-10-01T12:00:00Z'),
  perspective: { label: 'Spouse of', other_contact_id: 78, other_contact_name: 'Sam Client' }, is_symmetric: 1, forward_label: 'Spouse of', reverse_label: 'Spouse of' };
const ENDED_44 = { ...RELATION_44, active: 0, end_date: new Date('2024-03-01T00:00:00Z'), end_reason: 'divorced' };

// Trustees 501 / 502 share a surname; judges 601 ('mar') and 602 ('abc').
const ROLES = () => [
  { id: 31, contact_id: 501, role: 'trustee', attrs: { chapter: [13] }, active: 1 },
  { id: 32, contact_id: 502, role: 'trustee', attrs: { chapter: [13] }, active: 1 },
  { id: 41, contact_id: 601, role: 'judge', attrs: { judge_3: 'mar' }, active: 1 },
  { id: 42, contact_id: 602, role: 'judge', attrs: { judge_3: 'abc' }, active: 1 },
  { id: 51, contact_id: 77, role: 'witness', attrs: null, active: 1 },
];
const CASES = [
  { case_id: 'T1', case_trustee: 'Carroll', case_chapter: '13', case_trustee_contact_id: null }, // ambiguous today → 501 once 502 goes
  { case_id: 'T2', case_trustee: 'Mark Carroll', case_chapter: '13', case_trustee_contact_id: 502 }, // 502 today → none
  { case_id: 'T3', case_trustee: 'Someone Else', case_chapter: '7', case_trustee_contact_id: null },
  { case_id: 'J1', case_number_full: '25-40001-mar', case_judge: '', case_judge_contact_id: 601 }, // suffix → 601; after → none
  { case_id: 'J2', case_number_full: '25-40002', case_judge: 'Lee Judge', case_judge_contact_id: 601 }, // relaxed name → 601
  { case_id: 'J3', case_number_full: '25-40003-abc', case_judge: '', case_judge_contact_id: 602 },
];

let getRelation; let getRoleRow;
beforeEach(() => {
  delete process.env.CASEY_CONTACT_RELATIONS_ENABLED;
  getRelation = jest.spyOn(relSvc, 'getRelation').mockImplementation(async (_db, id) => (Number(id) === 44 ? { ...RELATION_44 } : null));
  getRoleRow = jest.spyOn(roleSvc, 'getRoleRow').mockImplementation(async (_db, id) => {
    const r = ROLES().find((x) => x.id === Number(id));
    return r ? { ...r, sort_order: 0 } : null;
  });
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.CASEY_CONTACT_RELATIONS_ENABLED; });

const run = (value, dbOver = {}) => normalizeActionDraft(makeDb({ roles: ROLES(), cases: CASES, ...dbOver }), value, EVIDENCE);
const refuse = (value, re, dbOver) => expect(run(value, dbOver)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes the six A6.2 kinds unavailable; unset is ON", async () => {
    process.env.CASEY_CONTACT_RELATIONS_ENABLED = '0';
    for (const v of [end(), reactivate(), remove(), roleCard('deactivate', 502, 32, 2), roleCard('reactivate', 502, 32, 2), roleCard('remove', 502, 32, 2)]) {
      await expect(run(v)).rejects.toThrow('Action kind is unavailable');
    }
    delete process.env.CASEY_CONTACT_RELATIONS_ENABLED;
    await expect(run(end())).resolves.toMatchObject({ kind: 'contact.relation.end.v1' });
  });
});

describe('contact.relation.end.v1', () => {
  test('the card: both ends, the row as stored in expected, the fixed changes, the readers and the reversible alternative', async () => {
    const out = await run(end());
    expect(out).toMatchObject({
      kind: 'contact.relation.end.v1',
      relation: { relation_id: 44, type_code: 'spouse', forward_label: 'Spouse of', type_retired: false,
        contact_a: { contact_id: 77, contact_name: 'Dana Client' }, contact_b: { contact_id: 78, contact_name: 'Sam Client' } },
      current: { active: 1, status: '', start_date: '2010-06-12', end_date: null, end_reason: '', notes: 'met in Detroit' },
      changes: { active: 0, end_date: '2026-11-01', end_reason: 'divorced' },
      expected: { updated_at: '2026-10-01T12:00:00.000Z', type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, active: 1, status: '',
        start_date: '2010-06-12', end_date: null, end_reason: '', notes: 'met in Detroit' },
      warnings: [],
    });
    expect(out.effects[0]).toMatch(/^Reversible: contact\.relation\.reactivate\.v1/);
    expect(out.effects).toContain('Relationships tab: Dana Client\'s and Sam Client\'s Active view stops listing it; the All view keeps it, marked Inactive, with the end reason and date.');
    expect(out.effects.some((e) => /^Stored definitions: no report/.test(e))).toBe(true);
  });

  test('end_date defaults to today (firm-local); not future, not before the start; end_reason from the vocabulary', async () => {
    const today = nowLocal().toFormat('yyyy-MM-dd');
    expect((await run(end({ end_date: undefined, end_reason: '' }))).changes).toEqual({ active: 0, end_date: today, end_reason: '' });
    await refuse(end({ end_date: '2999-01-01' }), /end date cannot be in the future/);
    await refuse(end({ end_date: '2009-01-01' }), /end date \(2009-01-01\) cannot precede its start date \(2010-06-12\)/);
    await refuse(end({ end_reason: 'moved away' }), /End reason "moved away" is not allowed for spouse \(allowed: divorced, deceased, annulled\)/);
    getRelation.mockResolvedValueOnce({ ...RELATION_44, type_code: 'business_partner' });
    await refuse(end(), /Relation type business_partner takes no end reason/);
    await refuse(end({ end_reason: 'x'.repeat(41) }), /End reason exceeds 40 characters/);
  });

  test('an ENDED relation (inactive, or active with an end date) refuses; unknown keys, wrong evidence and a vanished row refuse', async () => {
    getRelation.mockResolvedValueOnce({ ...ENDED_44 });
    await refuse(end(), /Relation 44 is already ended \(inactive, ended 2024-03-01\) — nothing to end/);
    getRelation.mockResolvedValueOnce({ ...RELATION_44, end_date: new Date('2024-03-01T00:00:00Z') });
    await refuse(end(), /already ended \(active, but carrying an end date/);
    await refuse(end({ active: 0 }), /Relation end carries unsupported fields: active/);
    await refuse(end({ evidence: cite(2) }), /Relation end evidence does not identify relation 44/);
    getRelation.mockResolvedValueOnce(null);
    await refuse(end(), /Relation 44 no longer exists/);
  });

  test('a stored status the type no longer allows refuses (the native PATCH re-validates the merged status)', async () => {
    getRelation.mockResolvedValueOnce({ ...RELATION_44, status: 'engaged' });
    await refuse(end(), /stored status "engaged" is not allowed for spouse \(allowed: separated\) — the native save re-checks it and would refuse; propose a relation update that sets status first/);
  });

  test('a stored reader of contact_relations is a STORED READERS warning (danger)', async () => {
    const out = await run(end(), { readers: { workflow_steps: [{ id: 9, name: 'workflow #3 v2 step 4', body: 'SELECT * FROM contact_relations WHERE x' }] } });
    expect(out.warnings).toEqual(['STORED READERS: Workflow step #9 "workflow #3 v2 step 4" names contact_relations — what it reads changes; check before applying.']);
  });
});

describe('contact.relation.reactivate.v1', () => {
  test('an ended relation comes back active; the end fields it clears are disclosed', async () => {
    getRelation.mockResolvedValue({ ...ENDED_44 });
    const out = await run(reactivate());
    expect(out).toMatchObject({ kind: 'contact.relation.reactivate.v1', changes: { active: 1, end_date: null, end_reason: '' },
      current: { active: 0, end_date: '2024-03-01', end_reason: 'divorced' }, expected: { active: 0, end_date: '2024-03-01', end_reason: 'divorced' } });
    expect(out.effects[0]).toBe('Cleared: the end date (2024-03-01) and end reason (divorced) — an active relation carries neither.');
    expect(out.effects).toContain('Relationships tab: Dana Client\'s and Sam Client\'s Active view lists it again, with no end date or end reason.');
  });

  test('an ACTIVE relation, a retired type, and another ACTIVE relation of the type between the pair refuse', async () => {
    await refuse(reactivate(), /Relation 44 is already ACTIVE with no end date — nothing to reactivate/);
    getRelation.mockResolvedValueOnce({ ...ENDED_44, type_code: 'old_type' });
    await refuse(reactivate(), /type old_type is retired \(inactive\) — reactivating it would put a retired relation type back into use/);
    getRelation.mockResolvedValue({ ...ENDED_44 });
    // The reverse direction counts (either way round), and only ACTIVE rows.
    await refuse(reactivate(), /Dana Client and Sam Client already have an ACTIVE spouse relation \(#45\) — reactivating relation #44 would record it twice/,
      { relations: [{ id: 45, type_code: 'spouse', contact_a_id: 78, contact_b_id: 77, active: 1 }] });
    await expect(run(reactivate(), { relations: [{ id: 45, type_code: 'spouse', contact_a_id: 78, contact_b_id: 77, active: 0 }] })).resolves.toBeTruthy();
    await expect(run(reactivate(), { relations: [{ id: 46, type_code: 'parent_child', contact_a_id: 77, contact_b_id: 78, active: 1 }] })).resolves.toBeTruthy();
  });

  test('a stored status the type no longer allows refuses', async () => {
    getRelation.mockResolvedValueOnce({ ...ENDED_44, status: 'engaged' });
    await refuse(reactivate(), /stored status "engaged" is not allowed for spouse/);
  });
});

describe('contact.relation.remove.v1', () => {
  test('NO UNDO on any delete; an ACTIVE row names END as the reversible alternative, an ended one does not', async () => {
    const active = await run(remove());
    expect(active.warnings[0]).toBe('NO UNDO: relation #44 is DELETED — its type, dates, status, end fields and notes are gone for good, and nothing records that it existed. It is ACTIVE: ENDING it (contact.relation.end.v1) keeps it as history and can be undone.');
    expect(active.effects).toContain('Relationships tab: it disappears from Dana Client\'s and Sam Client\'s tab, the Active and All views alike.');
    getRelation.mockResolvedValueOnce({ ...ENDED_44 });
    const ended = await run(remove());
    expect(ended.warnings[0]).not.toMatch(/ENDING it/);
    expect(ended).toMatchObject({ ended: true, expected: { active: 0, end_reason: 'divorced' } });
  });

  test('a row whose contact is gone can still be removed (the other cards need both ends); unknown keys refuse', async () => {
    const out = await run(remove(), { missing: [78] });
    expect(out.relation.contact_b).toEqual({ contact_id: 78, contact_name: 'Contact 78 (no longer exists)', contact_kind: 'person' });
    await refuse(end(), /Contact 78 \(contact_b\) is unavailable/, { missing: [78] });
    await refuse(remove({ end_date: '2026-01-01' }), /Relation remove carries unsupported fields: end_date/);
  });
});

describe('contact.relation.update.v1 — the A6.2 widening (the Edit dialog)', () => {
  test('a type change: the registry type, the new readings, and status / end_reason sent explicitly', async () => {
    const out = await run(update({ type_code: 'BUSINESS_PARTNER' }));
    expect(out).toMatchObject({ new_type: { type_code: 'business_partner', forward_label: 'Business partner of' },
      changes: { type_code: 'business_partner', status: '', end_reason: '' }, relation: { type_code: 'spouse', ended: false } });
    await refuse(update({ type_code: 'spouse' }), /already has type spouse — nothing to change/);
    await refuse(update({ type_code: 'old_type' }), /"old_type" is retired/);
    await refuse(update({ type_code: 'parent_child' }), /already have a parent_child relation \(#46, inactive\) — one pair holds one relation of a type/,
      { relations: [{ id: 46, type_code: 'parent_child', contact_a_id: 78, contact_b_id: 77, active: 0 }] });
    getRelation.mockResolvedValueOnce({ ...RELATION_44, status: 'separated' });
    await refuse(update({ type_code: 'parent_child' }), /status "separated" is not allowed for parent_child \(allowed: step, adopted\) — a type change must set status too/);
    getRelation.mockResolvedValueOnce({ ...RELATION_44, status: 'separated' });
    await expect(run(update({ type_code: 'parent_child', status: 'step' }))).resolves.toMatchObject({ changes: { type_code: 'parent_child', status: 'step' } });
  });

  test('an ENDED relation: its end date and end reason are editable; on an ACTIVE one they refuse', async () => {
    getRelation.mockResolvedValue({ ...ENDED_44 });
    const out = await run(update({ end_date: '2024-04-01', end_reason: 'annulled', notes: 'n' }));
    expect(out).toMatchObject({ relation: { ended: true }, changes: { end_date: '2024-04-01', end_reason: 'annulled', notes: 'n' },
      current: { active: 0, end_date: '2024-03-01', end_reason: 'divorced' } });
    await refuse(update({ end_reason: 'moved' }), /End reason "moved" is not allowed for spouse/);
    await refuse(update({ end_date: '2009-01-01' }), /start date \(2010-06-12\) would fall after its end date \(2009-01-01\)/);
    // An inactive relation may lose its end date (the tab allows it) …
    await expect(run(update({ end_date: '' }))).resolves.toMatchObject({ changes: { end_date: null } });
    // … but clearing it on one still marked ACTIVE is a reactivation.
    getRelation.mockResolvedValueOnce({ ...ENDED_44, active: 1 });
    await refuse(update({ end_date: null }), /would leave it ACTIVE with no end — that is a reactivation: propose contact\.relation\.reactivate\.v1/);
    getRelation.mockResolvedValue({ ...RELATION_44 });
    await refuse(update({ end_reason: 'divorced' }), /Relation 44 is ACTIVE — an update cannot set its end_reason; ending it is contact\.relation\.end\.v1/);
  });
});

describe('contact.role.deactivate.v1 — the judge / trustee link shift, measured', () => {
  test('a trustee: the cases whose link re-resolves differently, by the real matcher over the projected roster', async () => {
    const out = await run(roleCard('deactivate', 502, 32, 2));
    expect(out).toMatchObject({ kind: 'contact.role.deactivate.v1', contact: { contact_id: 502, contact_name: 'Mark Carroll' },
      role: { role_id: 32, role_code: 'trustee', stored_code: 'trustee', type_retired: false }, current: { active: 1, attrs: { chapter: [13] } },
      expected: { active: 1, attrs: { chapter: [13] }, role: 'trustee' } });
    expect(out.warnings).toEqual([
      'TRUSTEE LINKS: 2 case(s) resolve their trustee to a different contact once this role is deactivated — case T1: none → Krispen Carroll (contact #501); case T2: Mark Carroll (contact #502) → none. Nothing on those cases changes now: a case\'s stored trustee link (case_trustee_contact_id) is re-resolved only when its trustee is next written (Case Details, a court filing, intake, Casey\'s case-fields card), and then takes the new value.',
      '1 case(s) store a trustee link to Mark Carroll (contact #502) today — they keep it until that next write, then re-resolve without this contact.',
    ]);
    expect(out.effects[0]).toMatch(/^Reversible: contact\.role\.reactivate\.v1/);
    expect(out.effects.some((e) => /^Reader that stops reading Mark Carroll in this role: Trustee roster/.test(e))).toBe(true);
  });

  test('a judge: the suffix and the name steps, by the real resolver over the projected roles', async () => {
    const out = await run(roleCard('deactivate', 601, 41, 3));
    expect(out.warnings[0]).toMatch(/^JUDGE LINKS: 2 case\(s\) resolve their judge to a different contact once this role is deactivated — case J1: Hon\. Lee Judge \(contact #601\) → none; case J2: Hon\. Lee Judge \(contact #601\) → none\./);
    expect(out.warnings[1]).toBe('2 case(s) store a judge link to Hon. Lee Judge (contact #601) today — they keep it until that next write, then re-resolve without this contact.');
    // A role nothing resolves through measures nothing.
    const plain = await run(roleCard('deactivate', 77, 51, 4));
    expect(plain.warnings).toEqual([]);
    expect(plain.effects.some((e) => /LINKS|links:/.test(e))).toBe(false);
  });

  test('no shift: an effect line, not a warning', async () => {
    const out = await run(roleCard('deactivate', 502, 32, 2), { cases: [CASES[2]] });
    expect(out.warnings).toEqual([]);
    expect(out.effects).toContain('Trustee links: re-resolving the 1 case(s) whose trustee text the roster matches gives the same contact as now — no case\'s trustee link would change.');
  });

  test('a resolver query that fails makes the shift unmeasurable: the card refuses (fail closed)', async () => {
    await refuse(roleCard('deactivate', 601, 41, 3), /The judge link shift could not be measured \(resolver query failed\)/, { failResolver: true });
    await refuse(roleCard('deactivate', 502, 32, 2), /The trustee link shift could not be measured/, { failResolver: true });
  });

  test('refusals: an inactive row, a row on another contact, wrong evidence, unknown keys', async () => {
    getRoleRow.mockResolvedValueOnce({ ...ROLES()[1], active: 0 });
    await refuse(roleCard('deactivate', 502, 32, 2), /Role row 32 \(trustee\) is already INACTIVE — nothing to deactivate/);
    getRoleRow.mockResolvedValueOnce({ ...ROLES()[1], contact_id: 77 });
    await refuse(roleCard('deactivate', 502, 32, 2), /Role row 32 is not on contact 502/);
    await refuse(roleCard('deactivate', 502, 32, 3), /Role deactivate evidence does not identify role row 32 on contact 502/);
    await refuse(roleCard('deactivate', 502, 32, 2, { attrs: {} }), /Role deactivate carries unsupported fields: attrs/);
  });

  test('a retired or unknown role code may still be taken OUT of use', async () => {
    getRoleRow.mockResolvedValueOnce({ id: 51, contact_id: 77, role: 'retired', attrs: null, active: 1 });
    const retired = await run(roleCard('deactivate', 77, 51, 4));
    expect(retired.effects).toContain('Retired role: retired is retired in the role-type registry; this card takes the row out of use and never puts it back.');
    getRoleRow.mockResolvedValueOnce({ id: 51, contact_id: 77, role: 'ghost', attrs: null, active: 1 });
    const unknown = await run(roleCard('deactivate', 77, 51, 4));
    expect(unknown.warnings[0]).toBe('UNKNOWN ROLE CODE: "ghost" is not in the role-type registry — no reader recognises it.');
  });
});

describe('contact.role.reactivate.v1 / contact.role.remove.v1', () => {
  test('reactivate: an inactive row comes back; the shift is measured the other way; stale attrs and a shared judge suffix warn', async () => {
    getRoleRow.mockResolvedValue({ id: 41, contact_id: 601, role: 'judge', attrs: { judge_3: 'abc' }, active: 0 });
    const roles = ROLES().map((r) => (r.id === 41 ? { ...r, attrs: { judge_3: 'abc' }, active: 0 } : r));
    const out = await run(roleCard('reactivate', 601, 41, 3), { roles });
    // J2's relaxed name step finds 601 again; J3 resolves to 602 today, and with
    // 601 back on 'abc' the suffix is ambiguous and the name step finds nothing.
    expect(out.warnings[0]).toMatch(/^JUDGE LINKS: 2 case\(s\) resolve their judge to a different contact once this role is reactivated — case J2: none → Hon\. Lee Judge \(contact #601\); case J3: Hon\. Ann Other \(contact #602\) → none\./);
    expect(out.warnings).toContain('AMBIGUOUS SUFFIX: Hon. Ann Other (#602) already carries judge suffix "abc" — docket resolution for it falls back to the judge\'s name.');
    expect(out.effects).toContain('2 case(s) store a judge link to Hon. Lee Judge (contact #601) today.');
    getRoleRow.mockResolvedValueOnce({ id: 32, contact_id: 502, role: 'trustee', attrs: { chapter: ['13'] }, active: 0 });
    const stale = await run(roleCard('reactivate', 502, 32, 2), { roles: ROLES().map((r) => (r.id === 32 ? { ...r, active: 0 } : r)) });
    expect(stale.warnings.some((w) => /^STORED ATTRIBUTES no longer pass the trustee schema/.test(w))).toBe(true);
  });

  test('reactivate refuses an active row and a retired / unknown code', async () => {
    await refuse(roleCard('reactivate', 502, 32, 2), /Role row 32 \(trustee\) is already ACTIVE — nothing to reactivate/);
    getRoleRow.mockResolvedValueOnce({ id: 51, contact_id: 77, role: 'retired', attrs: null, active: 0 });
    await refuse(roleCard('reactivate', 77, 51, 4), /Role "retired" is retired \(inactive\) — use one of: .* — reactivating the row would put it back into use/);
    getRoleRow.mockResolvedValueOnce({ id: 51, contact_id: 77, role: 'ghost', attrs: null, active: 0 });
    await refuse(roleCard('reactivate', 77, 51, 4), /Role "ghost" is not in the role-type registry .* reactivating the row would put it back into use/);
  });

  test('remove: only an INACTIVE row (the form deletes nothing else); NO UNDO; no shift is measured', async () => {
    await refuse(roleCard('remove', 502, 32, 2), /Role row 32 \(trustee\) is ACTIVE — the Roles section deletes only an INACTIVE row .* deactivate it with contact\.role\.deactivate\.v1/);
    getRoleRow.mockResolvedValueOnce({ id: 32, contact_id: 502, role: 'trustee', attrs: { chapter: [13] }, active: 0 });
    const db = makeDb({ roles: ROLES(), cases: CASES });
    const out = await normalizeActionDraft(db, roleCard('remove', 502, 32, 2), EVIDENCE);
    expect(out.warnings).toEqual(['NO UNDO: role row #32 is DELETED — its attributes ({"chapter":[13]}) are gone for good, and nothing records that Mark Carroll held the trustee role.']);
    expect(out.effects).toContain('It is already inactive, so no roster, picker, filter or case link reads it now — nothing downstream changes. Once it is gone, Mark Carroll can be given the trustee role afresh as a new row.');
    expect(db.state.reads.some(([sql]) => /FROM cases/.test(sql))).toBe(false);
  });
});

describe('the request detector learns the lifecycle verbs', () => {
  test.each([
    ['End Dana\'s spouse relationship — they divorced', true],
    ['Delete relationship 44, it was added in error', true],
    ['Reactivate the parent relationship between Dana and Sam', true],
    ['Remove the trustee role from Mark Carroll', true],
    ['Deactivate Judge Lee\'s role', true],
    ['Who is Dana\'s spouse?', false],
    ['What roles does Mark have?', false],
  ])('%s → %s', (q, want) => { expect(taskDraftRequested(q)).toBe(want); });
});

// ── The browser half, lifted from public/assistant.html by name ───────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function constSrc(name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
// One family object out of ACTION_FAMILIES, by id.
function familySrc(id) {
  const at = html.indexOf(`id: '${id}'`);
  if (at < 0) throw new Error(`family ${id} not found`);
  const open = html.lastIndexOf('\n  {', at) + 3;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`family ${id} unbalanced`);
}
const FNS = ['contactRelationValue', 'contactRelationLines', 'contactRoleAttrLines', 'contactRelationStableJson', 'contactRelationDay', 'contactRelationOpenTarget',
  'contactRelationText', 'contactRelationRequest', 'contactRelationPrecheck', 'contactRelationLabel',
  'contactLifecycleLabel', 'contactLifecycleTail', 'contactRelationLifecycleText', 'contactRoleLifecycleText', 'contactRelationLifecycleRequest',
  'contactRoleLifecycleRequest', 'contactRelationLifecyclePrecheck', 'contactRoleLifecyclePrecheck', 'contactRelationLifecycleResult',
  'contactRoleLifecycleResult', 'contactLifecycleKnownOutcome', 'contactLifecycleAppliedVerb'];
function browser(api) {
  const src = [constSrc('CONTACT_RELATION_LIFECYCLE_KINDS'), constSrc('CONTACT_ROLE_LIFECYCLE_KINDS'), ...FNS.map(fnSrc),
    `const relFamily = ${familySrc('contact_relation_lifecycle')};`, `const roleFamily = ${familySrc('contact_role_lifecycle')};`,
    `return { ${FNS.join(', ')}, relFamily, roleFamily };`].join('\n');
  return new Function('api', 'openEntity', src)(api, jest.fn()); // eslint-disable-line no-new-func
}

describe('the browser: fixed requests, the click-time re-read, return shapes, outcomes, danger', () => {
  let endCard; let reactCard; let removeCard; let deactCard; let roleRemoveCard;
  // beforeAll runs before the file's beforeEach: it spies for itself.
  beforeAll(async () => {
    const rel = jest.spyOn(relSvc, 'getRelation').mockResolvedValue({ ...RELATION_44 });
    endCard = await run(end());
    removeCard = await run(remove());
    rel.mockResolvedValue({ ...ENDED_44 });
    reactCard = await run(reactivate());
    const role = jest.spyOn(roleSvc, 'getRoleRow').mockResolvedValue({ ...ROLES()[1], sort_order: 0 });
    deactCard = await run(roleCard('deactivate', 502, 32, 2));
    role.mockResolvedValue({ ...ROLES()[1], active: 0, sort_order: 0 });
    roleRemoveCard = await run(roleCard('remove', 502, 32, 2));
    jest.restoreAllMocks();
  });
  const ROW = { id: 44, type_code: 'spouse', contact_a_id: 77, contact_b_id: 78, active: 1, status: '', start_date: '2010-06-12T00:00:00.000Z',
    end_date: null, end_reason: '', notes: 'met in Detroit', updated_at: '2026-10-01T12:00:00.000Z' };
  const ENDED_ROW = { ...ROW, active: 0, end_date: '2024-03-01T00:00:00.000Z', end_reason: 'divorced' };
  const relList = (rows, over = {}) => jest.fn(async (p) => {
    if (over.gone && p.startsWith('/api/contacts/77/')) throw Object.assign(new Error('Contact not found'), { status: 404 });
    if (over.goneB && p.startsWith('/api/contacts/78/')) throw Object.assign(new Error('Contact not found'), { status: 404 });
    return { status: 'success', relations: rows, total: over.total == null ? rows.length : over.total };
  });

  test('requests: the body comes from the KIND — model-shaped junk on the draft never reaches it', () => {
    const b = browser(jest.fn());
    expect(b.contactRelationLifecycleRequest({ ...endCard, active: 1, changes: { ...endCard.changes, notes: 'x', active: 1 } }))
      .toEqual({ path: '/api/contact-relations/44', method: 'PATCH', body: { active: 0, end_date: '2026-11-01', end_reason: 'divorced' } });
    expect(b.contactRelationLifecycleRequest({ ...reactCard, changes: { active: 0, end_date: '2020-01-01' } }))
      .toEqual({ path: '/api/contact-relations/44', method: 'PATCH', body: { active: 1, end_date: null, end_reason: '' } });
    expect(b.contactRelationLifecycleRequest(removeCard)).toEqual({ path: '/api/contact-relations/44', method: 'DELETE', body: null });
    expect(b.contactRoleLifecycleRequest({ ...deactCard, attrs: { chapter: [7] } })).toEqual({ path: '/api/contacts/502/roles/32', method: 'PATCH', body: { active: 0 } });
    expect(b.contactRoleLifecycleRequest({ ...deactCard, kind: 'contact.role.reactivate.v1' })).toEqual({ path: '/api/contacts/502/roles/32', method: 'PATCH', body: { active: 1 } });
    expect(b.contactRoleLifecycleRequest(roleRemoveCard)).toEqual({ path: '/api/contacts/502/roles/32', method: 'DELETE', body: null });
    expect(() => b.contactRelationLifecycleRequest({ ...endCard, changes: { end_date: 'soon' } })).toThrow('This end has no usable end date.');
    expect(() => b.contactRelationLifecycleRequest({ ...endCard, kind: 'contact.relation.delete.v1' })).toThrow(/unknown kind/);
    expect(() => b.contactRoleLifecycleRequest({ ...deactCard, role: { role_id: 0 } })).toThrow(/no usable contact or role row/);
  });

  test('relation precheck: every reviewed value is re-read; a fresh row passes', async () => {
    expect(await browser(relList([ROW])).contactRelationLifecyclePrecheck(endCard)).toBe('');
    const stale = [
      [{ ...ROW, updated_at: '2026-10-02T09:00:00.000Z' }], [{ ...ROW, notes: 'same second' }], [{ ...ROW, active: 0 }],
      [{ ...ROW, end_date: '2026-10-05T00:00:00.000Z' }], [{ ...ROW, end_reason: 'x' }], [{ ...ROW, status: 'separated' }],
      [{ ...ROW, start_date: '2011-01-01T00:00:00.000Z' }], [{ ...ROW, contact_b_id: 90 }],
    ];
    for (const rows of stale) {
      expect(await browser(relList(rows)).contactRelationLifecyclePrecheck(endCard)).toBe('Relation #44 was edited, ended or reactivated since this card was prepared. Nothing was written. Ask Casey to prepare it again.');
    }
    expect(await browser(relList([])).contactRelationLifecyclePrecheck(endCard)).toMatch(/^Relation #44 no longer exists/);
    await expect(browser(relList([ROW], { total: 101 })).contactRelationLifecyclePrecheck(endCard)).rejects.toThrow('could not be read in full');
    // Contact A gone: re-read from B's side; both gone: refused.
    expect(await browser(relList([ROW], { gone: true })).contactRelationLifecyclePrecheck(removeCard)).toBe('');
    expect(await browser(relList([ROW], { gone: true, goneB: true })).contactRelationLifecyclePrecheck(removeCard)).toMatch(/Neither contact of relation #44 exists/);
  });

  test('reactivate precheck: another ACTIVE relation of the type between the pair (either direction) refuses', async () => {
    expect(await browser(relList([ENDED_ROW])).contactRelationLifecyclePrecheck(reactCard)).toBe('');
    const twin = { ...ROW, id: 45, contact_a_id: 78, contact_b_id: 77 };
    expect(await browser(relList([ENDED_ROW, twin])).contactRelationLifecyclePrecheck(reactCard)).toMatch(/another ACTIVE spouse relation \(#45\)/);
    expect(await browser(relList([ENDED_ROW, { ...twin, active: 0 }])).contactRelationLifecyclePrecheck(reactCard)).toBe('');
  });

  test('role precheck: active, role code and attrs (key-order-insensitive)', async () => {
    const roles = (rows) => jest.fn(async () => ({ status: 'success', roles: rows }));
    const R = { id: 32, contact_id: 502, role: 'trustee', attrs: { chapter: [13] }, active: 1 };
    expect(await browser(roles([R])).contactRoleLifecyclePrecheck(deactCard)).toBe('');
    expect(await browser(roles([{ ...R, active: 0 }])).contactRoleLifecyclePrecheck(deactCard)).toBe('Role row #32 was deactivated since this card was prepared. Nothing was written.');
    expect(await browser(roles([{ ...R, attrs: { chapter: [7] } }])).contactRoleLifecyclePrecheck(deactCard)).toMatch(/was edited since/);
    expect(await browser(roles([{ ...R, role: 'judge' }])).contactRoleLifecyclePrecheck(deactCard)).toMatch(/was edited since/);
    expect(await browser(roles([])).contactRoleLifecyclePrecheck(deactCard)).toBe('Role row #32 is no longer on Mark Carroll. Nothing was written.');
    expect(await browser(roles([{ ...R, active: 1 }])).contactRoleLifecyclePrecheck(roleRemoveCard)).toBe('Role row #32 was reactivated since this card was prepared. Nothing was written.');
  });

  test('results read what each route returns; a 404 is "already removed"', () => {
    const b = browser(jest.fn());
    expect(b.contactRelationLifecycleResult(endCard, { status: 'success', relation: { id: 44, active: 0 } })).toEqual({ relation_id: 44 });
    expect(() => b.contactRelationLifecycleResult(endCard, { status: 'success', relation: { id: 44, active: 1 } })).toThrow('did not confirm the change');
    expect(b.contactRelationLifecycleResult(reactCard, { status: 'success', relation: { id: 44, active: 1 } })).toEqual({ relation_id: 44 });
    expect(b.contactRelationLifecycleResult(removeCard, { status: 'success', deleted_id: 44 })).toEqual({ relation_id: 44 });
    expect(() => b.contactRelationLifecycleResult(removeCard, { status: 'success', deleted_id: 45 })).toThrow('did not confirm the delete');
    expect(b.contactRoleLifecycleResult(deactCard, { status: 'success', id: 32 })).toEqual({ role_id: 32 });
    expect(b.contactRoleLifecycleResult(roleRemoveCard, { status: 'success', removed: 1 })).toEqual({ role_id: 32 });
    expect(() => b.contactRoleLifecycleResult(roleRemoveCard, { status: 'success', removed: 0 })).toThrow('deleted no row');
    expect(b.contactLifecycleKnownOutcome({ status: 404, message: 'Relation 44 not found' })).toMatchObject({ status: 'Refused — nothing written' });
    expect(b.contactLifecycleKnownOutcome({ status: 404, message: 'Role row not found on this contact' })).toMatchObject({ status: 'Refused — nothing written' });
    expect(b.contactLifecycleKnownOutcome({ status: 404, message: 'Contact not found' })).toBe(null);
    expect(b.contactLifecycleKnownOutcome({ status: 409, message: 'Relation 44 not found', body: { idempotency: {} } })).toBe(null);
  });

  test('text and danger: a delete and a deactivate are always danger; an end / reactivate only with a warning', () => {
    const b = browser(jest.fn());
    expect(b.contactRelationLifecycleText(removeCard)).toContain('Becomes: DELETED — the row is gone, with no undo.');
    expect(b.contactRelationLifecycleText(removeCard)).toContain('Warning: NO UNDO: relation #44 is DELETED');
    expect(b.contactRelationLifecycleText(endCard)).toContain('End date: 2026-11-01');
    expect(b.contactRoleLifecycleText(deactCard)).toContain('Warning: TRUSTEE LINKS: 2 case(s)');
    expect([b.relFamily.danger(endCard), b.relFamily.danger(reactCard), b.relFamily.danger(removeCard)]).toEqual([false, false, true]);
    // A delete is danger by its KIND, not only because it carries the NO UNDO warning.
    expect(b.relFamily.danger({ ...removeCard, warnings: [] })).toBe(true);
    expect(b.relFamily.danger({ ...endCard, warnings: ['STORED READERS: x'] })).toBe(true);
    expect([b.roleFamily.danger({ ...deactCard, warnings: [] }), b.roleFamily.danger({ ...roleRemoveCard, warnings: [] }),
      b.roleFamily.danger({ ...deactCard, kind: 'contact.role.reactivate.v1', warnings: [] }),
      b.roleFamily.danger({ ...deactCard, kind: 'contact.role.reactivate.v1', warnings: ['x'] })]).toEqual([true, true, false, true]);
    expect(b.relFamily.appliedCopy({ ...removeCard, result_relation_lifecycle_id: 44 }).status).toBe('Applied — relationship #44 deleted');
    expect(b.roleFamily.appliedCopy({ ...deactCard, result_role_lifecycle_id: 32 }).status).toBe('Applied — role row #32 deactivated');
  });

  test('the widened update: a type change only with the reviewed new_type, end fields only on an ENDED relation; the re-read follows the state', async () => {
    const b = browser(jest.fn());
    const typeCard = { kind: 'contact.relation.update.v1', relation: { relation_id: 44, ended: false, contact_a: { contact_name: 'A' }, contact_b: { contact_name: 'B' } },
      new_type: { type_code: 'business_partner', forward_label: 'Business partner of', reverse_label: 'Business partner of', is_symmetric: true },
      changes: { type_code: 'business_partner', status: '', end_reason: '', end_date: '2020-01-01' }, current: {} };
    expect(b.contactRelationRequest(typeCard).body).toEqual({ type_code: 'business_partner', status: '' });
    expect(b.contactRelationRequest({ ...typeCard, new_type: undefined }).body).toEqual({ status: '' });
    const endedCard = { ...typeCard, new_type: undefined, relation: { ...typeCard.relation, ended: true }, changes: { end_date: '', end_reason: 'annulled' } };
    expect(b.contactRelationRequest(endedCard).body).toEqual({ end_date: null, end_reason: 'annulled' });
    expect(b.contactRelationText(typeCard)).toContain('On A\'s record after: "Business partner of B"');
    // The click-time re-read of an ENDED card.
    const card = { kind: 'contact.relation.update.v1', relation: { relation_id: 44, type_code: 'spouse', ended: true, contact_a: { contact_id: 77, contact_name: 'Dana Client' }, contact_b: { contact_id: 78 } },
      current: { active: 0, status: '', start_date: '2010-06-12', end_date: '2024-03-01', end_reason: 'divorced', notes: 'met in Detroit' }, expected: { updated_at: '2026-10-01T12:00:00.000Z' } };
    expect(await browser(relList([ENDED_ROW])).contactRelationPrecheck(card)).toBe('');
    expect(await browser(relList([ROW])).contactRelationPrecheck(card)).toBe('Relation #44 was reactivated since this card was prepared. Nothing was written.');
    expect(await browser(relList([{ ...ENDED_ROW, end_reason: 'deceased' }])).contactRelationPrecheck(card)).toMatch(/was edited since/);
    expect(await browser(relList([{ ...ENDED_ROW, end_date: '2024-03-02T00:00:00.000Z' }])).contactRelationPrecheck(card)).toMatch(/was edited since/);
  });
});

// The projection the link-shift measurement rests on (roleProjectedDb) rewrites
// the ONE `cr.active = 1` each resolver query over contact_roles carries. A
// resolver query without that shape cannot be projected, so the card refuses
// rather than report a shift it did not measure — the resolvers swallow their
// own errors, so a silent miss would read as "no link changes" (manager
// addition at landing, 2026-11-10: a mutation dropping the shape check survived
// the worker's suite).
describe('A6.2 — the resolver projection fails closed on an unprojectable query', () => {
  test('a resolver query over contact_roles with no `cr.active = 1` refuses the card by name', async () => {
    const resolver = require('../lib/caseRoleResolver');
    const spy = jest.spyOn(resolver, 'resolveJudgeDetailed').mockImplementation(async (db) => {
      // Two `cr.active = 1` predicates: the stored-state pass reads it fine, the projected pass cannot rewrite exactly one.
      // …and the resolver swallows its own query errors, as the real one does.
      try { await db.query("SELECT cr.contact_id FROM contact_roles cr WHERE cr.role = 'judge' AND cr.active = 1 AND cr.active = 1", []); } catch (_) { /* swallowed */ }
      return { contact_id: null };
    });
    try {
      await refuse(roleCard('deactivate', 601, 41, 3), /The judge link shift could not be measured \(a resolver query over contact_roles no longer has the shape the projection rewrites\)/);
    } finally { spy.mockRestore(); }
  });

  test('every shipped resolver query over contact_roles carries exactly one `cr.active = 1` (the shape the projection rewrites)', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['lib/caseRoleResolver.js', 'lib/trusteeRoster.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      const queries = src.split(/`/).filter((chunk, i) => i % 2 === 1 && /\bcontact_roles\s+cr\b/.test(chunk));
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) expect([f, q.split('cr.active = 1').length - 1]).toEqual([f, 1]);
    }
  });
});
