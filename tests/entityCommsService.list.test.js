/**
 * entityCommsService.list() — the gating core, over a fake world.
 *
 * The rules pinned here are the ones a regression turns into a data leak or a
 * silent hole, none of which the helper-level suite reaches:
 *   1. the channel grant gate: a mailbox row is shown only through a readable
 *      mailbox, or through a readable alias whose slice admits it; a phone row
 *      only on a readable line (`if (!box) continue` and the SQL's IN lists);
 *   2. fallback suppression: a log row that has a source row ANYWHERE — a
 *      mail_messages / phone_event_log row stamped with its log_id, or a
 *      stored copy matching its log_extra.message_id — never renders as a
 *      Logged-only item, even when the source sits in a channel the caller
 *      cannot read (otherwise the log becomes a side door around the grant);
 *   3. case scope: strict (default) shows only the case's own log rows and the
 *      sources bridged to them; "Include contact communications" widens to the
 *      related contacts' identities — Primary/Secondary/Other only, never a
 *      Bystander;
 *   4. contact ownership windows on the contact feed (NULL start = since
 *      forever), with the identity rows shaped the way mysql2 hands them over.
 *
 * mailboxService.listReadable (the grant resolver — its own suites) and the
 * archive decorator are stubbed; the service under test runs for real against
 * a fake db that EVALUATES the statements it recognises (IN lists, the relate
 * filter) instead of replaying canned answers, and throws on any it doesn't.
 *
 * Mutation-checked (2026-10-21, each broken in services/entityCommsService.js,
 * the suite failed, restored): `if (!box) continue` dropped; the alias
 * sliceMatch check dropped; the strict-scope phone log-id filter dropped;
 * the mail_messages log_id suppression dropped; the
 * phone_event_log log_id suppression dropped; the message-id keyed bridge
 * dropped; includeContacts forced on for every case; the relate-type filter
 * dropped from relatedCaseContacts; dateInWindow's start bound dropped;
 * dateInWindow reverted to its String(date).slice(0, 10) original.
 * Not covered here: a reader that drops DATE_FORMAT — dayOf absorbs it by
 * design (the "raw DATE column" test pins that the feed stays right).
 */
'use strict';

jest.mock('../services/mailboxService', () => ({ listReadable: jest.fn() }));
jest.mock('../services/commsArchiveView', () => ({ decorate: jest.fn(async () => {}) }));

const mbx = require('../services/mailboxService');
const svc = require('../services/entityCommsService');

const USER = { userId: 7 };
const READABLE = {
  mailbox: [
    { id: 1, address: 'staff@firm.test', alias_of: null, alias_label: null },
    // An alias slice of parent mailbox 2: the caller reads ONLY the mail that
    // names alias@firm.test, not the whole parent.
    { id: 5, address: 'alias@firm.test', alias_of: 2, alias_label: null },
  ],
  phone_line: [{ id: 11, phone_number: '2485550100' }],
};
const utc = (s) => new Date(`${s}Z`);

function world() {
  const contacts = [
    { contact_id: 9, contact_name: 'Jane Client' },
    { contact_id: 10, contact_name: 'Bob Bystander' },
  ];
  const relate = [
    { case_id: 'C1', contact_id: 9, type: 'Primary' },
    { case_id: 'C1', contact_id: 10, type: 'Bystander' },
  ];
  const emails = [{ contact_id: 9, email: 'jane@client.test', start_date: null, end_date: null }];
  const phones = [
    // Jane's number is hers from Oct 1: earlier traffic belongs to the
    // previous owner and must not land on her (or her case).
    { contact_id: 9, phone: '3135550001', start_date: '2026-10-01', end_date: null },
    { contact_id: 10, phone: '3135550002', start_date: null, end_date: null },
  ];
  const log = (log_id, log_type, scopes, extra = {}) => ({
    log_id, log_type, scopes, log_date: utc('2026-10-10 12:00:00'), log_direction: 'incoming',
    log_link_type: null, log_link_id: null, log_about_type: 'case', log_about_id: 'C1',
    log_from: null, log_to: null, log_subject: null, log_message: `log ${log_id}`,
    log_data: null, log_extra: null, ...extra,
  });
  const logs = [
    log(100, 'email', ['case:C1']),                                   // bridged to readable mail 201
    log(101, 'email', ['case:C1']),                                   // source in UNREADABLE mailbox 3
    log(102, 'court email', ['case:C1'], { log_message: 'Notice of hearing' }), // no source: Logged only
    log(103, 'sms', ['case:C1']),                                     // bridged to readable phone 301
    log(104, 'email', ['case:C1'], { log_extra: JSON.stringify({ message_id: '<Keyed@X>' }) }), // keyed copy in mailbox 3
    log(106, 'call', ['case:C1']),                                    // source on an UNREADABLE line
    log(110, 'sms', ['contact:9'], { log_about_type: null, log_about_id: null }), // Jane's own, bridged to 302
  ];
  const mail = [
    { id: 201, mailbox_id: 1, log_id: 100, message_id: 'm201@x', from_addr: 'Jane <jane@client.test>', to_addrs: 'staff@firm.test', date: utc('2026-10-10 10:00:00') },
    { id: 202, mailbox_id: 3, log_id: 101, message_id: 'm202@x', from_addr: 'jane@client.test', to_addrs: 'boss@firm.test', date: utc('2026-10-10 10:01:00') },
    { id: 203, mailbox_id: 3, log_id: null, message_id: 'keyed@x', from_addr: 'jane@client.test', to_addrs: 'boss@firm.test', date: utc('2026-10-10 10:02:00') },
    { id: 204, mailbox_id: 2, log_id: null, message_id: 'm204@x', from_addr: 'jane@client.test', to_addrs: 'other@firm.test', date: utc('2026-10-10 10:03:00') },
    { id: 205, mailbox_id: 2, log_id: null, message_id: 'm205@x', from_addr: 'jane@client.test', to_addrs: 'alias@firm.test', date: utc('2026-10-10 10:04:00') },
    { id: 206, mailbox_id: 3, log_id: null, message_id: 'm206@x', from_addr: 'jane@client.test', to_addrs: 'boss@firm.test', date: utc('2026-10-10 10:05:00') },
  ].map(r => ({ provider_id: null, folder: 'INBOX', gmail_labels: '[]', thread_key: null, cc_addrs: null,
    subject: `Filing question ${r.id}`, ingested_at: r.date, snippet: `Please call me ${r.id}`, attachments: '[]', ...r }));
  const phone = [
    { id: 301, line_number: '2485550100', other_party: '3135550001', log_id: 103, processed_at: utc('2026-10-10 11:00:00') },
    { id: 302, line_number: '2485550100', other_party: '3135550001', log_id: 110, processed_at: utc('2026-10-10 11:01:00') },
    { id: 304, line_number: '2485550100', other_party: '3135550001', log_id: null, processed_at: utc('2026-10-10 11:02:00') },
    { id: 305, line_number: '2485550199', other_party: '3135550001', log_id: 106, processed_at: utc('2026-10-10 11:03:00'), event_type: 'call' },
    { id: 306, line_number: '2485550100', other_party: '3135550002', log_id: null, processed_at: utc('2026-10-10 11:04:00') },
    { id: 307, line_number: '2485550100', other_party: '3135550001', log_id: null, processed_at: utc('2026-09-15 15:00:00') },
  ].map(r => ({ event_type: 'sms', direction: 'incoming', body: `text ${r.id}`, raw_extra: null, suppressed: 0,
    delivery_state: null, delivery_reason: null, delivery_code: null, ...r }));
  return { contacts, relate, emails, phones, logs, mail, phone };
}

/** mysql2 hands a DATE column over as a Date at UTC midnight (pool timezone 'Z'). */
function asDriver(sql, column, value) {
  if (value == null) return null;
  return new RegExp(`DATE_FORMAT\\(${column}`).test(sql) ? value : new Date(`${value}T00:00:00Z`);
}

function fakeDb(w) {
  const statements = [];
  const inList = (v) => (Array.isArray(v) ? v : [v]).map(String);
  const query = async (sql, params = []) => {
    statements.push(sql);
    const s = sql.replace(/\s+/g, ' ');
    let m;
    if (/FROM contacts WHERE contact_id = \?/.test(s)) {
      return [w.contacts.filter(c => c.contact_id === Number(params[0]))];
    }
    if (/FROM cases WHERE case_id = \?/.test(s)) {
      return [params[0] === 'C1' ? [{ case_id: 'C1', case_number: '26-10001', case_number_full: null }] : []];
    }
    if (/FROM case_relate cr/.test(s)) {
      // Evaluate the statement's own relate-type filter: no filter = every type.
      const allowed = (m = /case_relate_type IN \(([^)]*)\)/.exec(s))
        ? m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')) : null;
      return [w.relate.filter(r => r.case_id === params[0] && (!allowed || allowed.includes(r.type)))
        .map(r => ({ ...w.contacts.find(c => c.contact_id === r.contact_id), contact_phone: null, contact_email: null, relate_type: r.type }))];
    }
    if (/FROM contact_emails WHERE contact_id = \?/.test(s)) {
      return [w.emails.filter(e => e.contact_id === Number(params[0])).map(e => ({
        email: e.email, start_date: asDriver(s, 'start_date', e.start_date), end_date: asDriver(s, 'end_date', e.end_date) }))];
    }
    if (/FROM contact_phones WHERE contact_id = \?/.test(s)) {
      return [w.phones.filter(p => p.contact_id === Number(params[0])).map(p => ({
        phone: p.phone, start_date: asDriver(s, 'start_date', p.start_date), end_date: asDriver(s, 'end_date', p.end_date) }))];
    }
    if (/FROM log l WHERE \(l\.log_link_type = 'case'/.test(s)) {
      const ids = new Set(params.map(String));
      return [w.logs.filter(l => l.scopes.some(x => x.startsWith('case:') && ids.has(x.slice(5))))];
    }
    if (/FROM log l WHERE \( \(l\.log_link_type = 'contact'/.test(s)) {
      return [w.logs.filter(l => l.scopes.includes(`contact:${params[0]}`))];
    }
    if (/^SELECT message_id, provider_id FROM mail_messages WHERE log_id IN \(\?\)/.test(s.trim())) {
      const ids = inList(params[0]);
      return [w.mail.filter(r => r.log_id != null && ids.includes(String(r.log_id)))];
    }
    if (/FROM email_ingest_executions WHERE log_id IN/.test(s)) return [[]];
    if (/FROM mail_sends WHERE case_id = \?/.test(s)) return [[]];
    if (/FROM mail_messages m LEFT JOIN mail_read_state rs/.test(s)) {
      const boxes = inList(params[1]);
      return [w.mail.filter(r => boxes.includes(String(r.mailbox_id))).map(r => ({ ...r, unread: 0 }))];
    }
    if (/FROM phone_event_log WHERE line_number IN \(\?\) AND suppressed = 0/.test(s)) {
      const lines = inList(params[0]);
      return [w.phone.filter(r => lines.includes(String(r.line_number)) && !r.suppressed)];
    }
    if (/SELECT DISTINCT log_id FROM (mail_messages|phone_event_log) WHERE log_id IN \(\?\)/.test(s)) {
      const table = /FROM mail_messages/.test(s) ? w.mail : w.phone;
      const ids = inList(params[0]);
      return [[...new Set(table.filter(r => r.log_id != null && ids.includes(String(r.log_id))).map(r => r.log_id))]
        .map(log_id => ({ log_id }))];
    }
    if (/SELECT DISTINCT message_id, provider_id FROM mail_messages WHERE message_id IN \(\?\) OR provider_id IN \(\?\)/.test(s)) {
      const keys = inList(params[0]);
      return [w.mail.filter(r => keys.includes(String(r.message_id)) || keys.includes(String(r.provider_id)))
        .map(r => ({ message_id: r.message_id, provider_id: r.provider_id }))];
    }
    throw new Error(`fakeDb: unrecognised statement: ${s.slice(0, 120)}`);
  };
  return { query, statements };
}

beforeEach(() => {
  mbx.listReadable.mockReset();
  mbx.listReadable.mockImplementation(async (_db, _user, type) => READABLE[type]);
});

const keys = (out) => out.items.map(x => x.key).sort();

describe('case feed — strict scope (default)', () => {
  let out;
  beforeAll(async () => {
    mbx.listReadable.mockImplementation(async (_db, _user, type) => READABLE[type]);
    out = await svc.list(fakeDb(world()), USER, 'case', 'C1', {});
  });

  test('shows exactly the case-bridged sources plus the source-less court log', () => {
    expect(keys(out)).toEqual(['email:mid:m201@x', 'log:102', 'phone:301']);
    expect(out.include_contacts).toBe(false);
  });

  test('a source in an unreadable mailbox hides the mail AND suppresses its log fallback', () => {
    expect(keys(out)).not.toContain('log:101');
    expect(keys(out).some(k => k.includes('m202'))).toBe(false);
  });

  test('a stored copy matched by log_extra.message_id suppresses the fallback (keyed bridge)', () => {
    expect(keys(out)).not.toContain('log:104');
  });

  test('a phone source on an unreadable line hides the event AND suppresses its log fallback', () => {
    expect(keys(out)).not.toContain('phone:305');
    expect(keys(out)).not.toContain('log:106');
  });

  test("strict scope leaves out a related contact's own traffic", () => {
    for (const k of ['phone:302', 'phone:304', 'log:110', 'email:mid:m205@x']) expect(keys(out)).not.toContain(k);
  });

  test('source-less court mail renders as Logged only', () => {
    const court = out.items.find(x => x.key === 'log:102');
    expect(court).toMatchObject({ kind: 'court', legacy: true, preview: 'Notice of hearing' });
  });
});

describe('case feed — Include contact communications', () => {
  let out;
  beforeAll(async () => {
    mbx.listReadable.mockImplementation(async (_db, _user, type) => READABLE[type]);
    out = await svc.list(fakeDb(world()), USER, 'case', 'C1', { include_contacts: '1' });
  });

  test("adds the Primary contact's in-window traffic, through the same grants", () => {
    expect(keys(out)).toEqual(['email:mid:m201@x', 'email:mid:m205@x', 'log:102', 'phone:301', 'phone:302', 'phone:304']);
    expect(out.items.find(x => x.key === 'phone:304').contact).toEqual({ contact_id: 9, contact_name: 'Jane Client' });
  });

  test('a Bystander is neither listed nor searched', () => {
    expect(out.contacts.map(c => c.contact_id)).toEqual([9]);
    expect(keys(out)).not.toContain('phone:306');
  });

  test('the alias slice admits only mail naming the alias; the rest of its parent stays hidden', () => {
    expect(keys(out)).not.toContain('email:mid:m204@x');
    expect(out.items.find(x => x.key === 'email:mid:m205@x').email.mailbox_id).toBe(5);
  });

  test("traffic from before the contact owned the number stays off (ownership window)", () => {
    expect(keys(out)).not.toContain('phone:307');
  });

  test('unreadable sources stay hidden and their fallbacks suppressed when expanded too', () => {
    for (const k of ['log:101', 'log:104', 'log:106', 'log:110', 'phone:305', 'email:mid:m206@x']) {
      expect(keys(out)).not.toContain(k);
    }
  });
});

describe('contact feed', () => {
  test('a stamped outbound text carries the delivery verdict; unstamped rows carry null (phone-delivery S3b)', async () => {
    const w = world();
    w.phone.push({
      id: 308, event_type: 'sms', direction: 'outgoing', body: 'text 308', raw_extra: null, suppressed: 0,
      line_number: '2485550100', other_party: '3135550001', log_id: null, processed_at: utc('2026-10-10 11:05:00'),
      delivery_state: 'failed', delivery_reason: 'unreachable', delivery_code: 'SMS-CAR-411',
    });
    const out = await svc.list(fakeDb(w), USER, 'contact', 9, { kind: 'phone' });
    const by = (id) => out.items.find(i => i.key === `phone:${id}`);
    expect(by(308).phone.delivery).toEqual({ state: 'failed', reason: 'unreachable', code: 'SMS-CAR-411' });
    expect(by(301).phone.delivery).toBeNull();   // never stamped → null, never a fabricated verdict
  });

  test('ownership windows apply to mysql2-shaped identity rows (NULL start = since forever)', async () => {
    const out = await svc.list(fakeDb(world()), USER, 'contact', 9, { kind: 'phone' });
    expect(keys(out)).toEqual(['phone:301', 'phone:302', 'phone:304']);
  });

  test('a raw DATE column (a Date object, no DATE_FORMAT) still windows correctly', async () => {
    const w = world();
    const db = fakeDb(w);
    const inner = db.query;
    // Simulate a reader that forgot DATE_FORMAT: the driver's Date comes through.
    db.query = (sql, params) => inner(sql.replace(/DATE_FORMAT\((start_date|end_date), '%Y-%m-%d'\) AS \1/g, '$1'), params);
    const out = await svc.list(db, USER, 'contact', 9, { kind: 'phone' });
    expect(keys(out)).toEqual(['phone:301', 'phone:302', 'phone:304']);
  });

  test('search matches what a person reads, not JSON key names', async () => {
    const db = () => fakeDb(world());
    expect(keys(await svc.list(db(), USER, 'contact', 9, { q: 'filing question 201' }))).toEqual(['email:mid:m201@x']);
    // JSON key names, ids and timestamps of every item — they must match nothing here.
    for (const q of ['subject', 'status', 'preview', 'mailbox_id', 'legacy', '2026-10-10', '"id"']) {
      expect((await svc.list(db(), USER, 'contact', 9, { q })).items).toEqual([]);
    }
    expect(keys(await svc.list(db(), USER, 'contact', 9, { q: '(313) 555-0001', kind: 'sms' })))
      .toEqual(['phone:301', 'phone:302', 'phone:304']);
  });
});

// log-comm-date: the Communications tab's date range, order, and the
// backdated-entry marker's field. Two rows straddle a FIRM-day boundary that
// is not the UTC one: mail 207 at 02:30Z Oct 9 is 10:30 PM Oct 8 in Detroit,
// so a range computed on the UTC day would misfile it.
describe('date range, order and entered_at (log-comm-date)', () => {
  const LOGGED_AT = '2026-10-12T14:05:00.000Z';
  function datedWorld() {
    const w = world();
    // log_date is firm wall clock (mysql2 reads it as if UTC): 11:30 PM Oct 8.
    w.logs.push({
      log_id: 121, log_type: 'call', scopes: ['contact:9'], log_date: utc('2026-10-08 23:30:00'), log_direction: 'incoming',
      log_link_type: 'contact', log_link_id: '9', log_about_type: null, log_about_id: null,
      log_from: '3135550001', log_to: '2485550100', log_subject: null, log_message: 'called about the suit',
      log_data: null, log_extra: JSON.stringify({ logged_at: LOGGED_AT }),
    });
    w.mail.push({ provider_id: null, folder: 'INBOX', gmail_labels: '[]', thread_key: null, cc_addrs: null,
      subject: 'Late one', snippet: 'late', attachments: '[]',
      id: 207, mailbox_id: 1, log_id: null, message_id: 'm207@x', from_addr: 'jane@client.test', to_addrs: 'staff@firm.test',
      date: utc('2026-10-09 02:30:00'), ingested_at: utc('2026-10-09 02:30:00') });
    return w;
  }
  const list = (q) => svc.list(fakeDb(datedWorld()), USER, 'contact', 9, q);

  test('a one-day range takes the firm day, not the UTC day', async () => {
    expect(keys(await list({ from_date: '2026-10-08', to_date: '2026-10-08' }))).toEqual(['email:mid:m207@x', 'log:121']);
    expect((await list({ from_date: '2026-10-09', to_date: '2026-10-09' })).items).toEqual([]);
  });

  test('open-ended ranges are inclusive on their one bound', async () => {
    const since10 = keys(await list({ from_date: '2026-10-10' }));
    expect(since10).not.toContain('log:121');
    expect(since10).not.toContain('email:mid:m207@x');
    expect(since10).toContain('email:mid:m201@x');
    // (phone 307, Sep 15, predates Jane's ownership of the number: windowed out regardless)
    expect(keys(await list({ to_date: '2026-10-08' }))).toEqual(['email:mid:m207@x', 'log:121']);
  });

  test('sort=asc is the exact reverse of the default order', async () => {
    const desc = (await list({ limit: 100 })).items.map((x) => x.key);
    const asc = (await list({ sort: 'asc', limit: 100 })).items.map((x) => x.key);
    expect(desc.length).toBeGreaterThan(3);
    expect(asc).toEqual([...desc].reverse());
    // the backdated call sorts by its given time (03:30Z Oct 9), just after mail 207 (02:30Z)
    expect(desc.slice(-2)).toEqual(['log:121', 'email:mid:m207@x']);
  });

  test('a backdated log row carries entered_at; nothing else does', async () => {
    const items = (await list({ limit: 100 })).items;
    expect(items.find((x) => x.key === 'log:121').entered_at).toBe(LOGGED_AT);
    for (const x of items.filter((i) => i.key !== 'log:121')) expect(x.entered_at == null).toBe(true);
  });

  test.each([
    [{ from_date: '2026-13-01' }, /from_date/],
    [{ to_date: '10/08/2026' }, /to_date/],
    [{ from_date: '2026-10-08T00:00' }, /from_date/],
    [{ sort: 'up' }, /sort/],
  ])('parseQuery refuses %j', (q, msg) => {
    expect(() => svc.parseQuery(q)).toThrow(msg);
    try { svc.parseQuery(q); } catch (e) { expect(e.status).toBe(400); }
  });
});
