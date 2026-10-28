'use strict';
/**
 * tests/caseyCaseContacts.test.js
 *
 * A8 — Casey adds ONE contact to a case, changes ONE membership's role, or
 * removes ONE membership through reviewed cards: case.contact.add.v1 /
 * .update.v1 / .remove.v1 → the case page's own POST / PATCH / DELETE
 * /api/cases/:id/contacts[/:contactId].
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builder, the click-time membership + portal re-read, the outcome mapping —
 * is in tests/assistantUi.test.js):
 *   1. the casey_case_contacts_enabled switch ('0' = dark; unset = on);
 *   2. THE PORTAL RULE (CLAUDE.md; usage-based, manager ruling 2026-10-29): a
 *      PORTAL USER — any portal_access_log row, getCaseContacts' portal_used,
 *      anything but an explicit 0 — is never demoted from Primary/Secondary
 *      to Other/Bystander and never removed while Primary/Secondary, whatever
 *      portal_enabled says; anyone else may be, with a danger warning that
 *      they lose portal sight of the case once the portal is live (none when
 *      portal_enabled is 0);
 *   3. a case's only Primary never leaves (demote or remove); a second
 *      Primary is allowed and danger-warned (the swap path);
 *   4. a case's last contact is never removed; a two-row pair is refused;
 *      an add for a pair already on the case is refused;
 *   5. evidence: add cites the exact case_id and contact_id; update/remove
 *      cite the exact case_relate_id row;
 *   6. the card: both records by name, old and new role, the Primary and
 *      portal effects, the after-list; expected = the whole membership set +
 *      the portal flag;
 *   7. the ledger receipt is the integer case_relate_id;
 *   8. the request detector.
 *
 * The SQL predicates (the contact's portal flag, getCaseContacts over real
 * rows, the case_relate triggers the refusals mirror) run on a real engine in
 * tests/caseyCaseContacts.mysql.test.js.
 *
 *   npx jest tests/caseyCaseContacts.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const BASE_MEMBERS = [
  { relate_id: 11, contact_id: 77, contact_name: 'Dana Client', relate_type: 'Primary', portal_used: 1 },
  { relate_id: 12, contact_id: 78, contact_name: 'Sam Client', relate_type: 'Secondary', portal_used: 1 },
  { relate_id: 13, contact_id: 90, contact_name: 'Opposing Counsel', relate_type: 'Other', portal_used: 0 },
  { relate_id: 14, contact_id: 91, contact_name: 'Wendy Witness', relate_type: 'Bystander', portal_used: 0 },
];
// One member's fields overridden, the rest as above.
const withMember = (contactId, over) => BASE_MEMBERS.map((m) => (m.contact_id === contactId ? { ...m, ...over } : m));
const BASE_CONTACTS = {
  77: { contact_id: 77, contact_name: 'Dana Client', contact_kind: 'person', portal_enabled: 1 },
  78: { contact_id: 78, contact_name: 'Sam Client', contact_kind: 'person', portal_enabled: 1 },
  90: { contact_id: 90, contact_name: 'Opposing Counsel', contact_kind: 'person', portal_enabled: 1 },
  91: { contact_id: 91, contact_name: 'Wendy Witness', contact_kind: 'person', portal_enabled: 0 },
  92: { contact_id: 92, contact_name: 'Nora New', contact_kind: 'person', portal_enabled: 1 },
  93: { contact_id: 93, contact_name: 'Acme LLC', contact_kind: 'org', portal_enabled: 0 },
};

function makeDb(over = {}) {
  const members = over.members || BASE_MEMBERS;
  const contacts = { ...BASE_CONTACTS, ...(over.contacts || {}) };
  const caseRow = { case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Chapter 7', ...(over.case || {}) };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT * FROM cases WHERE case_id = ?') {
      return [over.caseMissing || caseRow.case_id.toLowerCase() !== String(params[0]).toLowerCase() ? [] : [{ ...caseRow }]];
    }
    if (flat === 'SELECT contact_id, contact_name, contact_kind, portal_enabled FROM contacts WHERE contact_id = ? LIMIT 1') {
      const row = contacts[Number(params[0])];
      return [row ? [{ ...row }] : []];
    }
    if (/^SELECT co\.contact_id, co\.contact_name, co\.contact_phone, co\.contact_email, cr\.case_relate_type AS relate_type, cr\.case_relate_id AS relate_id, EXISTS \(SELECT 1 FROM portal_access_log pal WHERE pal\.contact_id = co\.contact_id\) AS portal_used FROM case_relate cr JOIN contacts co ON co\.contact_id = cr\.case_relate_client_id WHERE cr\.case_relate_case_id = \? ORDER BY/.test(flat)) {
      expect(params).toEqual([caseRow.case_id]);
      return [members.map((m) => ({ contact_phone: '2485550100', contact_email: 'x@example.com', ...m }))];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

// q1 = the case's case_relate rows (as the prompts teach the read), q2 = a
// contacts read of the contact to add, q3 = a cases read.
const EVIDENCE = [
  { id: 'q1', purpose: 'case contacts', rows: BASE_MEMBERS.map((m) => ({ case_relate_id: m.relate_id, case_id: CASE_ID, contact_id: m.contact_id, case_relate_type: m.relate_type })) },
  { id: 'q2', purpose: 'contact', rows: [{ contact_id: 92, contact_name: 'Nora New' }, { contact_id: 93 }] },
  { id: 'q3', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: '25-12345' }] },
];
const rowOf = (relateId) => [{ query_id: 'q1', row_number: BASE_MEMBERS.findIndex((m) => m.relate_id === relateId) + 1 }];
const add = (over = {}) => ({ kind: 'case.contact.add.v1', case_id: CASE_ID, contact_id: 92, relate_type: 'Secondary',
  evidence: [{ query_id: 'q3', row_number: 1 }, { query_id: 'q2', row_number: 1 }], ...over });
const update = (contactId, relateType, over = {}) => ({ kind: 'case.contact.update.v1', case_id: CASE_ID, contact_id: contactId,
  relate_type: relateType, evidence: rowOf(BASE_MEMBERS.find((m) => m.contact_id === contactId).relate_id), ...over });
const remove = (contactId, over = {}) => ({ kind: 'case.contact.remove.v1', case_id: CASE_ID, contact_id: contactId,
  evidence: rowOf(BASE_MEMBERS.find((m) => m.contact_id === contactId).relate_id), ...over });

beforeEach(() => { delete process.env.CASEY_CASE_CONTACTS_ENABLED; });
afterEach(() => { delete process.env.CASEY_CASE_CONTACTS_ENABLED; });

const run = (value, dbOver, evidence = EVIDENCE) => normalizeActionDraft(makeDb(dbOver), value, evidence);
const refuse = (value, re, dbOver, evidence) => expect(run(value, dbOver, evidence)).rejects.toThrow(re);
const EXPECTED_MEMBERS = BASE_MEMBERS.map((m) => ({ relate_id: m.relate_id, contact_id: m.contact_id, relate_type: m.relate_type }));

describe('the per-family switch', () => {
  test("'0' makes all three kinds unavailable; unset is ON", async () => {
    process.env.CASEY_CASE_CONTACTS_ENABLED = '0';
    for (const v of [add(), update(90, 'Secondary'), remove(90)]) {
      await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    }
    delete process.env.CASEY_CASE_CONTACTS_ENABLED;
    for (const v of [add(), update(90, 'Secondary'), remove(90)]) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
});

describe('THE PORTAL RULE — a PORTAL USER (any portal_access_log row) is never demoted below Secondary or removed', () => {
  test.each([
    ['Secondary → Other', () => update(78, 'Other'), /^PORTAL: Sam Client has client-portal access and is Secondary on case 25-12345-abc; making them Other would hide this case from their client portal/],
    ['Secondary → Bystander', () => update(78, 'Bystander'), /^PORTAL: Sam Client .* making them Bystander/],
    ['Primary → Other (with a second Primary present)', () => update(77, 'Other'), /^PORTAL: Dana Client has client-portal access and is Primary/],
    ['remove a Secondary', () => remove(78), /^PORTAL: Sam Client has client-portal access and is Secondary on case 25-12345-abc; removing them would hide this case .* Casey never removes a contact with portal access — nothing is proposed/],
    ['remove a Primary', () => remove(77), /^PORTAL: Dana Client .* removing them/],
  ])('%s is refused by name', async (_name, value, re) => {
    // Two Primaries so the sole-Primary rule cannot be what refuses.
    const members = BASE_MEMBERS.map((m) => (m.contact_id === 90 ? { ...m, relate_type: 'Primary' } : m));
    const ev = [{ id: 'q1', rows: members.map((m) => ({ case_relate_id: m.relate_id })) }];
    const v = value();
    v.evidence = [{ query_id: 'q1', row_number: members.findIndex((m) => m.contact_id === v.contact_id) + 1 }];
    await refuse(v, re, { members }, ev);
  });

  test('portal use is anything but an explicit 0 (fail closed): null, "1", 2, a missing field all refuse', async () => {
    for (const used of [null, '1', 2, undefined]) {
      await refuse(update(78, 'Other'), /^PORTAL:/, { members: withMember(78, { portal_used: used }) });
    }
  });

  test('a portal user stays refused with portal access turned OFF (the refusal says so)', async () => {
    await refuse(update(78, 'Other'), /^PORTAL: Sam Client has used the client portal \(its access is off now\) and is Secondary/,
      { contacts: { 78: { ...BASE_CONTACTS[78], portal_enabled: 0 } } });
  });

  test('NEVER used, access on (the default): the demotion is proposed with the danger warning; expected carries portal_used', async () => {
    const out = await run(update(78, 'Other'), { members: withMember(78, { portal_used: 0 }) });
    expect(out.membership).toEqual({ case_relate_id: 12, from: 'Secondary', to: 'Other' });
    expect(out.contact).toMatchObject({ contact_id: 78, portal_enabled: 1, portal_used: false });
    expect(out.warnings).toEqual(['CLIENT PORTAL: once the portal is live, Sam Client loses portal visibility of this case (only Primary and Secondary see a case). Sam Client has never used the client portal, so Casey allows it.']);
    expect(out.expected).toEqual({ members: EXPECTED_MEMBERS, portal_enabled: 1, portal_used: false });
    const rm = await run(remove(78), { members: withMember(78, { portal_used: 0 }) });
    expect(rm.warnings[0]).toMatch(/^CLIENT PORTAL: once the portal is live, Sam Client loses portal visibility of this case/);
  });

  test('NEVER used, access OFF: proposed with no warning, only what turning it back on would mean', async () => {
    const out = await run(update(78, 'Other'), { members: withMember(78, { portal_used: 0 }), contacts: { 78: { ...BASE_CONTACTS[78], portal_enabled: 0 } } });
    expect(out.contact).toMatchObject({ contact_id: 78, portal_enabled: 0 });
    expect(out.warnings).toEqual([]);
    expect(out.effects).toContain("Client portal: Sam Client's portal access is OFF; if it is turned back on, this case will NOT show in their portal (only Primary and Secondary see a case).");
    expect(out.expected).toEqual({ members: EXPECTED_MEMBERS, portal_enabled: 0, portal_used: false });
  });

  test('moving between Primary and Secondary keeps portal visibility and is not a portal refusal', async () => {
    const out = await run(update(78, 'Primary'));
    expect(out.membership).toEqual({ case_relate_id: 12, from: 'Secondary', to: 'Primary' });
    expect(out.effects).toContain('Client portal: unchanged — Primary and Secondary both see the case.');
  });

  test('promotion to Secondary of a portal user is a danger WARNING: the case becomes visible in their portal', async () => {
    const out = await run(update(90, 'Secondary'));
    expect(out.warnings).toEqual(["CLIENT PORTAL: Opposing Counsel has client-portal access, so this case — its documents, messages and status — shows in Opposing Counsel's portal from the moment this is saved."]);
    const off = await run(update(91, 'Secondary'));
    expect(off.warnings).toEqual([]);
    expect(off.effects).toContain("Client portal: Wendy Witness's portal access is OFF, so nothing shows now; if it is turned on, this case will show in their portal.");
  });
});

describe('the Primary contact — never left without one; a second one warns', () => {
  test("the case's only Primary is never demoted or removed, even with portal access off", async () => {
    const members = withMember(77, { portal_used: 0 });
    await refuse(update(77, 'Secondary'), /^Dana Client is case 25-12345-abc's only Primary contact; making them Secondary would leave the case with NO Primary .* Make the new Primary first/, { members });
    await refuse(remove(77), /only Primary contact; removing them would leave the case with NO Primary/, { members });
  });

  test('a second Primary is proposed with a TWO PRIMARY danger warning naming the one who stays', async () => {
    const out = await run(update(78, 'Primary'));
    expect(out.warnings).toEqual(['TWO PRIMARY CONTACTS: Dana Client stays Primary too. Every reader that shows ONE client (the case header and its name in lists, the e-sign and form Primary slots) picks one of them. Change the other to Secondary afterwards unless two Primaries are intended.']);
    const addPrimary = await run(add({ relate_type: 'primary' }));
    expect(addPrimary.membership.to).toBe('Primary');
    expect(addPrimary.warnings[0]).toMatch(/^TWO PRIMARY CONTACTS: Dana Client stays Primary too/);
  });

  test('a case with no Primary: a new Primary is a plain effect; with two Primaries one may step down', async () => {
    const members = BASE_MEMBERS.filter((m) => m.relate_type !== 'Primary');
    const out = await run(update(78, 'Primary', { evidence: [{ query_id: 'q1', row_number: 2 }] }), { members });
    expect(out.warnings).toEqual([]);
    expect(out.effects[0]).toBe("Primary contact: Sam Client becomes the case's Primary — the case header and its name in lists, and the e-sign and form Primary slots, read Sam Client from now on.");
    const two = BASE_MEMBERS.map((m) => (m.contact_id === 78 ? { ...m, relate_type: 'Primary' } : m));
    const down = await run(update(78, 'Secondary'), { members: two });
    expect(down.effects[0]).toBe('Primary contact: Sam Client stops being Primary; Dana Client remains the Primary contact.');
  });
});

describe('the refusal table', () => {
  test('unknown keys by name; relate_type explicit and one of the four; no relate_type on a remove', async () => {
    await refuse(add({ case_relate_type: 'Other' }), /^A case contact add carries unsupported fields: case_relate_type — it takes case_id, contact_id, relate_type, evidence only$/);
    await refuse(remove(90, { relate_type: 'Other' }), /^A case contact remove carries unsupported fields: relate_type/);
    await refuse(add({ relate_type: undefined }), /needs relate_type — one of: Primary, Secondary, Other, Bystander \(Casey never assumes the route's default\)/);
    await refuse(add({ relate_type: 'Debtor' }), /^relate_type "Debtor" is not a case role — use one of: Primary, Secondary, Other, Bystander$/);
    await refuse(add({ case_id: 'bad id' }), /needs the case's exact case_id/);
    await refuse(add({ contact_id: 'x' }), /needs the contact's exact positive contact_id/);
  });

  test('a missing case or contact; a case id longer than case_relate stores', async () => {
    await refuse(add(), /^Case 7KQ2M9XA no longer exists$/, { caseMissing: true });
    await refuse(add({ contact_id: 99, evidence: [{ query_id: 'q3', row_number: 1 }, { query_id: 'q9', row_number: 1 }] }), /^Contact 99 no longer exists$/, undefined,
      [...EVIDENCE, { id: 'q9', rows: [{ contact_id: 99 }] }]);
    const long = 'ABCDEFGHJK';
    await refuse(add({ case_id: long }), /^Case 25-12345-abc's id \(ABCDEFGHJK\) is longer than the 8 characters a case membership stores/,
      { case: { case_id: long } }, [...EVIDENCE, { id: 'q8', rows: [{ case_id: long }] }]);
  });

  test('add: refused for a contact already on the case in ANY role; evidence must carry both exact ids', async () => {
    await refuse(add({ contact_id: 90, relate_type: 'Secondary', evidence: [{ query_id: 'q3', row_number: 1 }, { query_id: 'q1', row_number: 3 }] }),
      /^Opposing Counsel is already on case 25-12345-abc as Other \(membership #13\)\. Nothing is proposed — to change the role, propose case\.contact\.update\.v1$/);
    await refuse(add({ evidence: [{ query_id: 'q2', row_number: 1 }] }), /does not identify case 25-12345-abc — cite a row carrying its exact case_id/);
    await refuse(add({ evidence: [{ query_id: 'q3', row_number: 1 }] }), /does not identify contact 92 — cite a row carrying its exact contact_id/);
    // A differently-cased case id finds the case (general_ci) but is not the cited id.
    await refuse(add({ case_id: '7kq2m9xa' }), /does not identify case/);
  });

  test('update/remove: the exact case_relate_id row; not on the case; two rows; a no-op; the last contact', async () => {
    // A row carrying only the contact id is not the membership row.
    await refuse(update(90, 'Secondary', { evidence: [{ query_id: 'q2', row_number: 1 }] }), /does not identify the membership — cite the case_relate row carrying its exact case_relate_id/);
    await refuse(update(90, 'Secondary', { evidence: rowOf(14) }), /does not identify the membership/);
    await refuse({ kind: 'case.contact.remove.v1', case_id: CASE_ID, contact_id: 92, evidence: rowOf(13) }, /^Nora New is not on case 25-12345-abc \(already removed\) — nothing to remove$/);
    await refuse({ kind: 'case.contact.update.v1', case_id: CASE_ID, contact_id: 92, relate_type: 'Other', evidence: rowOf(13) }, /^Nora New is not on case 25-12345-abc — nothing to change$/);
    const twoRows = [...BASE_MEMBERS, { relate_id: 15, contact_id: 90, contact_name: 'Opposing Counsel', relate_type: 'Bystander' }];
    await refuse(update(90, 'Secondary'), /^Opposing Counsel has 2 memberships on case 25-12345-abc \(Other, Bystander\)\. The case page's change and remove act on every one at once/, { members: twoRows });
    await refuse(remove(90), /has 2 memberships/, { members: twoRows });
    await refuse(update(90, 'other'), /^Opposing Counsel is already Other on case 25-12345-abc — that changes nothing$/);
    const lone = [{ relate_id: 14, contact_id: 91, contact_name: 'Wendy Witness', relate_type: 'Bystander' }];
    await refuse(remove(91, { evidence: [{ query_id: 'q1', row_number: 4 }] }), /^Wendy Witness is case 25-12345-abc's only contact; removing them would leave the case with no contacts at all/, { members: lone });
  });
});

describe('the normalized card', () => {
  test('add: both records, the role, the after-list, effects, expected = the whole set + the portal flag', async () => {
    const out = await run(add());
    expect(out).toMatchObject({
      kind: 'case.contact.add.v1', status: 'draft',
      case: { case_id: CASE_ID, case_number: '25-12345-abc', case_type: 'Chapter 7' },
      contact: { contact_id: 92, contact_name: 'Nora New', contact_kind: 'person', portal_enabled: 1 },
      membership: { case_relate_id: null, from: null, to: 'Secondary' },
      members_after_total: 5,
      expected: { members: EXPECTED_MEMBERS, portal_enabled: 1, portal_used: null },
    });
    expect(out.contact.portal_used).toBe(null);
    expect(out.draft_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.members_after.map((m) => `${m.contact_name}:${m.relate_type}`)).toEqual(
      ['Dana Client:Primary', 'Nora New:Secondary', 'Sam Client:Secondary', 'Opposing Counsel:Other', 'Wendy Witness:Bystander']);
    expect(out.warnings[0]).toMatch(/^CLIENT PORTAL: Nora New has client-portal access/);
    expect(out.effects).toEqual([
      "Case readers: as Secondary, Nora New counts in the client portal and mail filing, plus the case's automation lists, communications, log and document relinking.",
      'Trigger event: case.contact_linked fires (relate_type Secondary) — any trigger rule listening for it runs.',
    ]);
    // Names and roles only: no phone, email or any other contact column rides the card.
    expect(JSON.stringify(out)).not.toMatch(/2485550100|x@example\.com/);
  });

  test('update: no trigger event; remove: the row leaves the after-list and case.contact_unlinked fires', async () => {
    const up = await run(update(91, 'Other'));
    expect(up.membership).toEqual({ case_relate_id: 14, from: 'Bystander', to: 'Other' });
    expect(up.effects).toContain('Trigger event: none — the role-change route emits no event, so a rule watching case.contact_linked does not see this change.');
    expect(up.effects).toContain("Case readers: as Other, Wendy Witness counts in the case's automation lists, communications, log and document relinking (not the portal).");
    const rm = await run(remove(90));
    expect(rm.membership).toEqual({ case_relate_id: 13, from: 'Other', to: null });
    expect(rm.members_after.map((m) => m.contact_id)).toEqual([77, 78, 91]);
    expect(rm.effects).toEqual([
      "Case readers: Opposing Counsel stops counting in the case's automation lists, communications, log and document relinking (not the portal) for this case.",
      'Trigger event: case.contact_unlinked fires — any trigger rule listening for it runs.',
    ]);
    expect(rm.warnings).toEqual([]);
    const rmBystander = await run(remove(91));
    expect(rmBystander.effects[0]).toMatch(/stops counting in none of the case's automation lists/);
  });

  test('a case too large for one card is refused', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ relate_id: 100 + i, contact_id: 500 + i, contact_name: `C${i}`, relate_type: 'Other' }));
    await refuse(add(), /^Case 25-12345-abc has 51 contacts — more than one card can review \(50\)/, { members: many });
  });
});

describe('ledger receipt and request detector', () => {
  test('the three kinds receipt the integer case_relate_id, never the case_id string path', () => {
    for (const k of ['case.contact.add.v1', 'case.contact.update.v1', 'case.contact.remove.v1']) expect(ledger.KINDS.get(k)).toBe('case_relate_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('case_relate_id')).toBe(false);
  });

  test('membership requests force the draft path; questions do not', () => {
    for (const q of ['Add Sam to the case as Secondary', 'make Dana the primary on this case', 'Remove the witness from the case',
      'change Sam to bystander on that file', 'link Nora to this case']) {
      expect({ q, forced: taskDraftRequested(q, []) }).toEqual({ q, forced: true });
    }
    for (const q of ['Who is the primary on this case?', 'Is Sam on the case?']) {
      expect({ q, forced: taskDraftRequested(q, []) }).toEqual({ q, forced: false });
    }
  });
});
