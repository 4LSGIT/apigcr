'use strict';
/**
 * tests/caseyChecklistRelease.test.js
 *
 * A10X (Fred, 2026-11-15: "release means allow") — the A10 deferrals the
 * checklist cards now cover, as the native routes allow:
 *   1. ANOTHER USER'S personal list: create, item add / update / delete, list
 *      update and reorder for any ACTIVE staff member (taskService.
 *      findAssignableStaff's predicate). The card names the owner in its
 *      title and a warning, the owner is NOT told, a retired / inactive /
 *      missing owner is refused here and at the click (GET /api/users/:id).
 *      The list DELETE keeps A10.2's superuser rule (the route's detach gate).
 *   2. Lists on an APPOINTMENT, EVENT or TASK — named from the row, cited by
 *      the exact appt_id / event_id / task_id, re-read at the click through
 *      GET /api/appts|events|tasks/:id — and UNLINKED lists (link_type
 *      "none": no link sent, no record to re-read, no bus address). A BILL
 *      stays refused: no bills table or read route.
 *
 * Mocked db (the normalizer's own reads); the browser half is lifted from
 * public/assistant.html by name. The SQL (the record labels, the active-staff
 * predicate on a real users row, the unlinked create through the real route)
 * runs on a real engine in tests/caseyChecklistRelease.mysql.test.js.
 *
 *   npx jest tests/caseyChecklistRelease.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft } = svc;

const ME = 6;
const SU = 9;

function baseLists() {
  return {
    501: { row: { id: 501, title: 'Stuart to-dos', kind: 'checklist', status: 'incomplete', link_type: 'user', link: '1', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 6010, name: 'Call trustee', status: 'incomplete', position: 1 }, { id: 6011, name: 'File reply', status: 'incomplete', position: 2 }] },
    502: { row: { id: 502, title: 'Retired list', kind: 'checklist', status: 'incomplete', link_type: 'user', link: '2', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 6020, name: 'Old thing', status: 'incomplete', position: 1 }] },
    503: { row: { id: 503, title: 'Appt prep', kind: 'checklist', status: 'incomplete', link_type: 'appt', link: '55', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 6030, name: 'Print agenda', status: 'incomplete', position: 1 }] },
    504: { row: { id: 504, title: 'Hearing prep', kind: 'checklist', status: 'incomplete', link_type: 'event', link: '77', tag: null, docs_list: 0 }, body: null, items: [] },
    505: { row: { id: 505, title: 'Task steps', kind: 'checklist', status: 'incomplete', link_type: 'task', link: '88', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 6050, name: 'Step one', status: 'complete', position: 1 }, { id: 6051, name: 'Step two', status: 'incomplete', position: 2 }] },
    506: { row: { id: 506, title: 'Loose ends', kind: 'checklist', status: 'incomplete', link_type: null, link: null, tag: null, docs_list: 0 }, body: null,
      items: [{ id: 6060, name: 'Sort mail', status: 'incomplete', position: 1 }, { id: 6061, name: 'Shred', status: 'incomplete', position: 2 }] },
    507: { row: { id: 507, title: 'Bill notes', kind: 'checklist', status: 'incomplete', link_type: 'bill', link: '9', tag: null, docs_list: 0 }, body: null,
      items: [{ id: 6070, name: 'x', status: 'incomplete', position: 1 }] },
    508: { row: { id: 508, title: 'Orphan', kind: 'checklist', status: 'incomplete', link_type: 'case', link: null, tag: null, docs_list: 0 }, body: null, items: [] },
    509: { row: { id: 509, title: 'Gone appt list', kind: 'checklist', status: 'incomplete', link_type: 'appt', link: '56', tag: null, docs_list: 0 }, body: null, items: [] },
  };
}

function makeDb(over = {}) {
  const lists = over.lists || baseLists();
  const active = over.active || [1];
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT cl\.id, cl\.title, cl\.kind, cl\.status, cl\.link_type, cl\.link, cl\.tag, COALESCE\(.*\) AS docs_list FROM checklists cl WHERE cl\.id = \? LIMIT 1$/.test(flat)) {
      const l = lists[Number(params[0])];
      return [l ? [{ ...l.row }] : []];
    }
    if (flat === 'SELECT id, name, status, position FROM checkitems WHERE checklist_id = ? ORDER BY position ASC, id ASC') {
      const l = lists[Number(params[0])];
      return [l ? l.items.map((i) => ({ ...i })) : []];
    }
    if (/^SELECT COLUMN_NAME AS name, CHARACTER_MAXIMUM_LENGTH AS width, COLUMN_TYPE AS column_type FROM information_schema\.COLUMNS/.test(flat)) {
      return [[{ name: 'title', width: 255, column_type: 'varchar(255)' }, { name: 'status', width: 10, column_type: "enum('incomplete','complete')" }]];
    }
    if (flat === 'SELECT body FROM checklists WHERE id = ? LIMIT 1') {
      const l = lists[Number(params[0])];
      return [l ? [{ body: l.body }] : []];
    }
    if (flat === 'SELECT checklist_id FROM checkitems WHERE id = ? LIMIT 1') {
      for (const [id, l] of Object.entries(lists)) if (l.items.some((i) => i.id === Number(params[0]))) return [[{ checklist_id: Number(id) }]];
      return [[]];
    }
    if (flat === 'SELECT user, user_name FROM users WHERE user = ? LIMIT 1') {
      return [{ 1: [{ user: 1, user_name: 'Stuart' }], 2: [{ user: 2, user_name: 'Retired' }] }[Number(params[0])] || []];
    }
    if (flat === "SELECT user, user_name FROM users WHERE user = ? AND user_auth LIKE 'authorized%' AND user_type <> 0 LIMIT 1") {
      const uid = Number(params[0]);
      return [active.includes(uid) ? [{ user: uid, user_name: uid === 1 ? 'Stuart' : `U${uid}` }] : []];
    }
    if (flat === 'SELECT user_auth, roles FROM users WHERE user = ? LIMIT 1') {
      return [[{ user_auth: 'authorized', roles: Number(params[0]) === SU ? 'staff,su' : 'staff' }]];
    }
    if (flat.startsWith('SELECT a.appt_id, a.appt_type, a.appt_status,')) {
      return [Number(params[0]) === 55 ? [{ appt_id: 55, appt_type: 'Strategy session', appt_status: 'Scheduled', at: '2026-11-20 10:00', contact_name: 'Dana Client' }] : []];
    }
    if (flat.startsWith('SELECT event_id, event_title, event_status,')) {
      return [Number(params[0]) === 77 ? [{ event_id: 77, event_title: '341 meeting', event_status: 'Scheduled', on_date: '2026-12-01' }] : []];
    }
    if (flat === 'SELECT task_id, task_title, task_status FROM tasks WHERE task_id = ? LIMIT 1') {
      return [Number(params[0]) === 88 ? [{ task_id: 88, task_title: 'Prepare schedules', task_status: 'Pending' }] : []];
    }
    if (flat === 'SELECT id, title, kind FROM checklists WHERE link_type = ? AND link = ? ORDER BY created_date ASC, id ASC') {
      return [Object.values(lists).filter((l) => l.row.link_type === params[0] && String(l.row.link) === String(params[1])).map((l) => ({ id: l.row.id, title: l.row.title, kind: l.row.kind }))];
    }
    if (flat === 'SELECT id, title, kind FROM checklists WHERE link IS NULL AND title = ? ORDER BY created_date ASC, id ASC LIMIT 20') {
      return [Object.values(lists).filter((l) => l.row.link == null && l.row.title.toLowerCase() === String(params[0]).toLowerCase()).map((l) => ({ id: l.row.id, title: l.row.title, kind: l.row.kind }))];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}

const IDS = [501, 502, 503, 504, 505, 506, 507, 508, 509];
const ITEMS = [6010, 6020, 6030, 6050, 6051, 6060, 6070];
const EVIDENCE = [
  { id: 'q1', rows: IDS.map((id) => ({ checklist_id: id })) },
  { id: 'q2', rows: ITEMS.map((id) => ({ checkitem_id: id })) },
  { id: 'q3', rows: [{ appt_id: 55 }, { event_id: 77 }, { task_id: 88 }, { appt_id: 56 }] },
];
const listRow = (id) => [{ query_id: 'q1', row_number: IDS.indexOf(id) + 1 }];
const itemRow = (id) => [{ query_id: 'q2', row_number: ITEMS.indexOf(id) + 1 }];
const recRow = (n) => [{ query_id: 'q3', row_number: n }];
const run = (value, dbOver, userId = ME) => normalizeActionDraft(makeDb(dbOver), value, EVIDENCE, { currentUserId: userId });
const create = (over) => ({ kind: 'checklist.create.v1', title: 'New list', list_kind: 'checklist', items: ['One', 'Two'], ...over });

let spies = [];
beforeEach(() => { delete process.env.CASEY_CHECKLISTS_ENABLED; spies.push(jest.spyOn(triggerService, 'listActiveRulesForEvent').mockResolvedValue([])); });
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

const OWNER_WARNING = 'ANOTHER USER\'S LIST: this is Stuart (user #1)\'s personal list — the route lets any staff member work on a colleague\'s list (delegation), and Stuart is not told: neither the route nor Casey sends anything.';

describe('1. another user\'s personal list — any ACTIVE staff member, named, not told', () => {
  test('create for an active colleague: the card names them, warns, needs no evidence; their own list ids are the stale check', async () => {
    const c = await run(create({ link_type: 'user', link: '1', evidence: [] }));
    expect([c.list.link_type, c.list.link, c.owner, c.parent.label, c.expected]).toEqual(['user', '1', { user_id: 1, name: 'Stuart', label: 'Stuart (user #1)' },
      'Stuart (user #1)\'s personal list', { link_type: 'user', link: '1', list_ids: [501] }]);
    expect(c.warnings).toEqual(['ANOTHER USER\'S LIST: this makes a personal list FOR Stuart (user #1) — it shows under their own lists on the Notes & Lists page, not yours, and Stuart is not told: neither the route nor Casey sends anything.']);
    expect(c.effects).toContain('Personal: the list shows under Stuart\'s own lists on the Notes & Lists page.');
  });
  test('create for a retired, a missing or a malformed user is refused', async () => {
    await expect(run(create({ link_type: 'user', link: '2', evidence: [] }))).rejects.toThrow('A personal list for Retired (user #2) is not available — they are not an active staff member (retired or inactive). Casey makes personal lists for active staff only');
    await expect(run(create({ link_type: 'user', link: '3', evidence: [] }))).rejects.toThrow('A personal list for user #3 is not available — that user does not exist');
    await expect(run(create({ link_type: 'user', link: 'Stuart', evidence: [] }))).rejects.toThrow('A personal list for a colleague needs link = their exact positive user id');
  });
  test('every item / list card on an active colleague\'s list: a card naming the owner, warned', async () => {
    const cards = [
      await run({ kind: 'checklist.item.add.v1', checklist_id: 501, name: 'Draft memo', evidence: listRow(501) }),
      await run({ kind: 'checklist.item.update.v1', checkitem_id: 6010, status: 'complete', evidence: itemRow(6010) }),
      await run({ kind: 'checklist.item.delete.v1', checkitem_id: 6010, evidence: itemRow(6010) }),
      await run({ kind: 'checklist.update.v1', checklist_id: 501, title: 'Stuart this week', evidence: listRow(501) }),
      await run({ kind: 'checklist.items.reorder.v1', checklist_id: 501, item_ids: [6011, 6010], evidence: listRow(501) }),
    ];
    for (const c of cards) {
      expect({ kind: c.kind, owner: c.owner, label: c.parent.label, warned: c.warnings[0] })
        .toEqual({ kind: c.kind, owner: { user_id: 1, name: 'Stuart', label: 'Stuart (user #1)' }, label: 'Stuart (user #1)\'s personal list', warned: OWNER_WARNING });
    }
  });
  test('a retired owner\'s list is refused on every card but a superuser\'s delete; a non-superuser delete is refused as before', async () => {
    const refusals = [
      { kind: 'checklist.item.add.v1', checklist_id: 502, name: 'x', evidence: listRow(502) },
      { kind: 'checklist.item.update.v1', checkitem_id: 6020, status: 'complete', evidence: itemRow(6020) },
      { kind: 'checklist.item.delete.v1', checkitem_id: 6020, evidence: itemRow(6020) },
      { kind: 'checklist.update.v1', checklist_id: 502, title: 'y', evidence: listRow(502) },
    ];
    for (const v of refusals) {
      await expect(run(v)).rejects.toThrow('"Retired list" (#502) is the personal list of Retired (user #2), who is not an active staff member (retired or inactive) — Casey works on the personal lists of active staff only');
    }
    // An owner who stopped being active staff after the list was made: same refusal.
    await expect(run({ kind: 'checklist.item.add.v1', checklist_id: 501, name: 'x', evidence: listRow(501) }, { active: [] }))
      .rejects.toThrow('"Stuart to-dos" (#501) is the personal list of Stuart (user #1), who is not an active staff member');
    // The delete: A10.2's rule — a superuser may delete any owner's list, warned; others are refused.
    await expect(run({ kind: 'checklist.delete.v1', checklist_id: 502, evidence: listRow(502) })).rejects.toThrow('is another user\'s personal list — it belongs to Retired (user #2). Only its owner or a superuser may delete it');
    const su = await run({ kind: 'checklist.delete.v1', checklist_id: 502, evidence: listRow(502) }, undefined, SU);
    expect(su.warnings.some((w) => w.startsWith('ANOTHER USER\'S LIST: this is Retired (user #2)\'s personal list — you may delete it only as a superuser'))).toBe(true);
    expect(su.owner).toBe(undefined); // the delete draft carries no owner: its click never re-checks an active owner
  });
});

describe('2. lists on an appointment, an event or a task, and unlinked lists; a bill stays refused', () => {
  test.each([
    ['appt', 1, 'appointment #55 (Strategy session, 2026-11-20 10:00, Scheduled — Dana Client)', 'Staff only: the list shows on the appointment\'s Notes & Lists (in the appointment dialog).'],
    ['event', 2, 'event #77 ("341 meeting", 2026-12-01, Scheduled)', 'Staff only: the list shows on the event\'s Notes & Lists (in the event form).'],
    ['task', 3, 'task #88 ("Prepare schedules", Pending)', 'Staff only: no task screen shows lists — it shows on the Notes & Lists page\'s Browse view (More → Notes & Lists).'],
  ])('create on a%s: cited by the exact id, named from its row, its lists the stale check', async (t, n, label, where) => {
    const id = { appt: 55, event: 77, task: 88 }[t];
    const c = await run(create({ link_type: t, link: id, evidence: recRow(n) }));
    expect([c.list.link_type, c.list.link, c.parent.label, c.owner, c.expected]).toEqual([t, String(id), label, null,
      { link_type: t, link: String(id), list_ids: t === 'appt' ? [503] : t === 'event' ? [504] : [505] }]);
    expect(c.effects).toContain(where);
  });
  test('the record must be cited by its own id column, positive, and still exist', async () => {
    await expect(run(create({ link_type: 'appt', link: 77, evidence: recRow(2) }))).rejects.toThrow('The list evidence does not identify appointment 77 — cite a row carrying its exact appt_id');
    await expect(run(create({ link_type: 'event', link: 'x', evidence: recRow(2) }))).rejects.toThrow('A list on an event needs link = its exact positive event_id');
    await expect(run(create({ link_type: 'task', link: 0, evidence: recRow(3) }))).rejects.toThrow('A list on a task needs link = its exact positive task_id');
    await expect(run(create({ link_type: 'appt', link: 56, evidence: recRow(4) }))).rejects.toThrow('Appointment 56 no longer exists');
  });
  test('an unlinked list: link_type "none", no link, no evidence needed; only a same-title unlinked list is read (warned)', async () => {
    const c = await run(create({ link_type: 'none', title: 'Errands', evidence: [] }));
    expect([c.list.link_type, c.list.link, c.parent.label, c.existing_total, c.expected, c.warnings]).toEqual([null, null, 'no record (an unlinked list)', null,
      { link_type: null, link: null, list_ids: null }, []]);
    expect(c.effects).toEqual(expect.arrayContaining(['Unlinked: the list hangs off no record — it shows under Unlinked on the Notes & Lists page (More → Notes & Lists).',
      'Other open pages: an unlinked list has no record address on the sync bus — another open board shows it after it reloads.']));
    const dup = await run(create({ link_type: 'none', title: 'loose ENDS', evidence: [] }));
    expect(dup.warnings).toEqual(['DUPLICATE TITLE: there is already an unlinked checklist titled "Loose ends" (#506). This makes a SECOND one — duplicates are allowed; to add to the existing list instead, ask Casey to add items to it.']);
    await expect(run(create({ link_type: 'none', link: '5', evidence: [] }))).rejects.toThrow('An unlinked list (link_type "none") takes no link');
  });
  test('a bill is refused on create and on every card on a bill list; a list naming a record kind with no id is refused', async () => {
    await expect(run(create({ link_type: 'bill', link: 9, evidence: [] }))).rejects.toThrow('A list on a bill is not available to Casey — bills have no verifiable record source in YisraCase (no bills table or read route)');
    for (const v of [{ kind: 'checklist.item.add.v1', checklist_id: 507, name: 'y', evidence: listRow(507) },
      { kind: 'checklist.update.v1', checklist_id: 507, title: 'y', evidence: listRow(507) },
      { kind: 'checklist.delete.v1', checklist_id: 507, evidence: listRow(507) }]) {
      await expect(run(v)).rejects.toThrow('"Bill notes" (#507) hangs off a bill — bills have no verifiable record source in YisraCase');
    }
    await expect(run({ kind: 'checklist.update.v1', checklist_id: 508, title: 'y', evidence: listRow(508) })).rejects.toThrow('"Orphan" (#508) hangs off a case with no record id');
  });
  test('cards on appt / event / task / unlinked lists: named, the right pipeline line, the bus line (an unlinked list is never announced)', async () => {
    const add = await run({ kind: 'checklist.item.add.v1', checklist_id: 503, name: 'Bring ID', evidence: listRow(503) });
    expect([add.parent.label, add.owner, add.warnings]).toEqual(['appointment #55 (Strategy session, 2026-11-20 10:00, Scheduled — Dana Client)', null, []]);
    const done = await run({ kind: 'checklist.item.update.v1', checkitem_id: 6051, status: 'complete', evidence: itemRow(6051) });
    expect([done.list_status, done.automation.events]).toEqual([{ from: 'incomplete', to: 'complete' }, ['checkitem.completed', 'checklist.completed']]);
    const del = await run({ kind: 'checklist.delete.v1', checklist_id: 504, evidence: listRow(504) });
    expect(del.effects).toContain('Pipeline: no step reads this list — a pipeline step\'s checklist detector reads only a CASE\'s tagged checklists (this one is an event\'s).');
    expect(del.effects).toContain('Other open pages: DELETE /checklists/:id is announced on the sync bus — another open Notes & Lists board for this record refreshes on its own (one with unsaved note text or the caret in a field refreshes once that is done); the global Notes & Lists page\'s Browse view reloads its first page too (it waits while a row\'s editor is open or the page is hidden).');
    const loose = await run({ kind: 'checklist.items.reorder.v1', checklist_id: 506, item_ids: [6061, 6060], evidence: listRow(506) });
    expect(loose.parent.label).toBe('no record (an unlinked list)');
    expect(loose.effects).toContain('Other open pages: PUT /checklists/:id/items/order is not announced — an unlinked list has no record address on the sync bus, so another open board shows the change after it reloads.');
    const looseDel = await run({ kind: 'checklist.item.delete.v1', checkitem_id: 6060, evidence: itemRow(6060) });
    expect(looseDel.effects).toContain('Pipeline: no step reads this list — a pipeline step\'s checklist detector reads only a CASE\'s tagged checklists (this one is unlinked).');
    await expect(run({ kind: 'checklist.item.add.v1', checklist_id: 509, name: 'x', evidence: listRow(509) })).rejects.toThrow('The appt "Gone appt list" hangs off (56) no longer exists');
  });
});

// ── The browser half, lifted from public/assistant.html by name ────────────
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
const FNS = ['checklistFoldTitle', 'checklistLabel', 'checklistParentLabel', 'checklistListLine', 'checklistText', 'checklistCreateBody', 'checklistRequest',
  'checkitemRequest', 'checklistCreatePrecheck', 'checklistListPrecheck', 'checklistPrecheck', 'checkitemPrecheck', 'checklistParentPrecheck', 'checklistResult',
  'checklistEntity', 'checklistEditLabel', 'checklistEditListId', 'checklistUpdateRequest', 'checklistDeleteRequest', 'checkitemDeleteRequest', 'checklistEditPrecheck',
  'checklistReorderLabel'];
function browser(api) {
  const src = [constSrc('CHECKLIST_LINK_TYPES'), ...FNS.map(fnSrc), `return { ${FNS.join(', ')} };`].join('\n');
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

// The page's api: GET /checklists/:id, GET /checklists?…, /api/users/:id, /api/appts|events|tasks/:id.
function reads({ lists = baseLists(), users = { 1: { user: 1, user_auth: 'authorized', user_type: 1 } }, gone = [] } = {}) {
  const gets = [];
  const api = jest.fn(async (p, body, method) => {
    expect(method).toBe('GET');
    gets.push(p);
    const nf = () => Object.assign(new Error('not found'), { status: 404 });
    if (gone.includes(p)) throw nf();
    let m;
    if ((m = /^\/api\/users\/(\d+)$/.exec(p))) { const u = users[Number(m[1])]; if (!u) throw nf(); return { data: { ...u, user_name: 'x' } }; }
    if (/^\/api\/(appts|events|tasks)\/\d+$/.test(p)) return { data: {} };
    if ((m = /^\/checklists\/(\d+)$/.exec(p))) {
      const l = lists[Number(m[1])]; if (!l) throw nf();
      const { docs_list: _d, ...row } = l.row;
      return { ...row, body: l.body, items: l.items.map((i) => ({ ...i, checklist_id: l.row.id })) };
    }
    if (p === '/checklists') {
      const rows = Object.values(lists).filter((l) => l.row.link_type === body.link_type && String(l.row.link) === String(body.link)).map((l) => ({ id: l.row.id }));
      return { checklists: rows, total: rows.length };
    }
    throw new Error(`unexpected GET ${p}`);
  });
  return { api, gets };
}

describe('the browser: owner and record re-reads, the unlinked create, labels and text', () => {
  const mk = async (value, dbOver, userId) => JSON.parse(JSON.stringify(await run(value, dbOver, userId)));

  test('a colleague\'s list: every card re-reads the owner; an inactive or missing owner refuses', async () => {
    const cards = [
      await mk(create({ link_type: 'user', link: '1', evidence: [] })),
      await mk({ kind: 'checklist.item.add.v1', checklist_id: 501, name: 'Draft memo', evidence: listRow(501) }),
      await mk({ kind: 'checklist.update.v1', checklist_id: 501, title: 'Stuart this week', evidence: listRow(501) }),
    ];
    const pre = (b, c) => (c.kind === 'checklist.update.v1' ? b.checklistEditPrecheck(c) : b.checklistPrecheck(c));
    for (const c of cards) {
      const ok = reads();
      await expect(pre(browser(ok.api), c)).resolves.toBe('');
      expect(ok.gets).toContain('/api/users/1');
      await expect(pre(browser(reads({ users: { 1: { user: 1, user_auth: 'inactive', user_type: 1 } } }).api), c))
        .resolves.toBe('Stuart (user #1) is no longer an active staff member (retired or inactive), so Casey no longer works on their list. Nothing was written.');
      await expect(pre(browser(reads({ users: { 1: { user: 1, user_auth: 'authorized', user_type: 0 } } }).api), c)).resolves.toMatch(/is no longer an active staff member/);
      await expect(pre(browser(reads({ users: {} }).api), c)).resolves.toBe('Stuart (user #1) no longer exists as a user. Nothing was written.');
    }
    // A forged owner id is never read.
    const { api } = reads();
    await expect(browser(api).checklistPrecheck({ ...cards[1], owner: { user_id: 'x', label: 'x' } })).rejects.toThrow('This card has no usable list owner.');
  });

  test('a delete never re-checks the owner or the record: a superuser\'s delete of a colleague\'s list, a delete of a gone appointment\'s list', async () => {
    const del = await mk({ kind: 'checklist.delete.v1', checklist_id: 502, evidence: listRow(502) }, undefined, SU);
    const r = reads({ users: {} });
    await expect(browser(r.api).checklistEditPrecheck(del)).resolves.toBe('');
    expect(r.gets).toEqual(['/checklists/502']);
    const apptDel = await mk({ kind: 'checklist.delete.v1', checklist_id: 503, evidence: listRow(503) });
    const g = reads({ gone: ['/api/appts/55'] });
    await expect(browser(g.api).checklistEditPrecheck(apptDel)).resolves.toBe('');
    expect(g.gets).toEqual(['/checklists/503']);
  });

  test('an appointment / event / task list re-reads its record; a 404 refuses; the create also checks the record\'s lists', async () => {
    const create55 = await mk(create({ link_type: 'appt', link: 55, evidence: recRow(1) }));
    const ok = reads();
    await expect(browser(ok.api).checklistPrecheck(create55)).resolves.toBe('');
    expect(ok.gets).toEqual(['/api/appts/55', '/checklists']);
    await expect(browser(reads({ gone: ['/api/appts/55'] }).api).checklistPrecheck(create55))
      .resolves.toBe('appointment #55 (Strategy session, 2026-11-20 10:00, Scheduled — Dana Client) no longer exists. Nothing was written.');
    const lists = baseLists(); lists[510] = { row: { id: 510, title: 'x', kind: 'checklist', status: 'incomplete', link_type: 'appt', link: '55', tag: null }, body: null, items: [] };
    await expect(browser(reads({ lists }).api).checklistPrecheck(create55)).resolves.toMatch(/^The notes and lists on appointment #55 .* changed since this card was prepared/);
    const upd = await mk({ kind: 'checklist.item.update.v1', checkitem_id: 6051, status: 'complete', evidence: itemRow(6051) });
    const t = reads();
    await expect(browser(t.api).checkitemPrecheck(upd)).resolves.toBe('');
    expect(t.gets).toEqual(['/checklists/505', '/api/tasks/88']);
    await expect(browser(reads({ gone: ['/api/tasks/88'] }).api).checkitemPrecheck(upd)).resolves.toBe('task #88 ("Prepare schedules", Pending) no longer exists. Nothing was written.');
    const ren = await mk({ kind: 'checklist.update.v1', checklist_id: 504, title: 'Hearing prep (Dec)', evidence: listRow(504) });
    await expect(browser(reads({ gone: ['/api/events/77'] }).api).checklistEditPrecheck(ren)).resolves.toMatch(/^event #77 .* no longer exists/);
  });

  test('the unlinked create: no link fields sent, nothing re-read, the route\'s NULL answer accepted', async () => {
    const c = await mk(create({ link_type: 'none', title: 'Errands', evidence: [] }));
    const b = browser(jest.fn());
    expect(b.checklistRequest(c)).toEqual({ path: '/checklists', method: 'POST', body: { title: 'Errands', kind: 'checklist', items: [{ name: 'One' }, { name: 'Two' }] } });
    const r = reads();
    await expect(browser(r.api).checklistPrecheck(c)).resolves.toBe('');
    expect(r.gets).toEqual([]);
    expect(b.checklistResult(c, { id: 900, link_type: null, link: null, items: [] })).toEqual({ checklist_id: 900 });
    expect(() => b.checklistResult(c, { id: 900, link_type: 'case', link: 'X', items: [] })).toThrow('The checklist route saved the list on another record');
    expect(b.checklistEntity(c)).toEqual({ kind: 'checklist', id: '', label: 'Errands' });
    const text = b.checklistText(c);
    expect(text).toContain('Other open pages: an unlinked list has no record address on the sync bus — another open board shows the change after it reloads.');
    expect(text).not.toContain('Notes and lists already on this record');
  });

  test('labels name the owner; record entities open the record', async () => {
    const b = browser(jest.fn());
    const mine = await mk(create({ link_type: 'user', evidence: [] }));
    const theirs = await mk(create({ link_type: 'user', link: '1', evidence: [] }));
    const add = await mk({ kind: 'checklist.item.add.v1', checklist_id: 501, name: 'Draft memo', evidence: listRow(501) });
    const ren = await mk({ kind: 'checklist.update.v1', checklist_id: 501, title: 'Stuart this week', evidence: listRow(501) });
    const ord = await mk({ kind: 'checklist.items.reorder.v1', checklist_id: 501, item_ids: [6011, 6010], evidence: listRow(501) });
    expect([b.checklistLabel(mine), b.checklistLabel(theirs), b.checklistLabel(add), b.checklistEditLabel(ren), b.checklistReorderLabel(ord)])
      .toEqual(['Create checklist', 'Create checklist for Stuart', 'Add checklist item (Stuart\'s list)', 'Rename list (Stuart\'s list)', 'Reorder checklist items (Stuart\'s list)']);
    expect(b.checklistText(theirs)).toContain('If Stuart is no longer an active staff member, nothing is written.');
    const appt = await mk({ kind: 'checklist.item.add.v1', checklist_id: 503, name: 'Bring ID', evidence: listRow(503) });
    const ev = await mk({ kind: 'checklist.update.v1', checklist_id: 504, title: 'Hearing prep (Dec)', evidence: listRow(504) });
    const tk = await mk({ kind: 'checklist.item.update.v1', checkitem_id: 6051, status: 'complete', evidence: itemRow(6051) });
    expect([b.checklistEntity(appt), b.checklistEntity(ev), b.checklistEntity(tk)]).toEqual([
      { kind: 'appointment', id: '55', label: 'appointment #55' }, { kind: 'event', id: '77', label: 'event #77' }, { kind: 'task', id: '88', label: 'task #88' }]);
  });
});
