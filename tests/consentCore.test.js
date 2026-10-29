// tests/consentCore.test.js
//
/**
 * YisraMail P1 — consent core, the CI-run half (ref/YISRAMAIL_DESIGN.md §4.1–§4.4).
 * The SQL itself is held to a real engine in tests/consentCore.mysql.test.js
 * (gated on YC_TEST_MYSQL_URL); this file pins the same contract where that
 * suite skips:
 *
 *   reader   optoutService.findOptedOut / assertNotOptedOut / optoutGate /
 *            *OptedOutSql / consentVersions over the identity fake
 *            (tests/helpers/optoutFake.js): operational SMS = scope 'all',
 *            operational email = NOTHING and no query (D18), marketing email =
 *            'marketing' + topic, opt_in / unknown / inactive topics, the
 *            dual-read (state OR the active row's cache), the hit shape incl.
 *            a destination no row holds.
 *   writer   recordConsent over a stateful store (tests/helpers/
 *            contactConsentWorld.js): event + guarded state + cache sync,
 *            the out-of-order pair, the tie, (source, provider_event_id)
 *            idempotency, validation that writes nothing.
 *   writers  EVERY row writer through the REAL services on that world:
 *            change → exactly one event, no change → none, a new row is born
 *            from the state and never opts in (the re-consent guard), a
 *            transfer keeps the opt-out, end-and-replace records row_replace,
 *            Casey's writes carry { via: 'casey', draft_id } — only while the
 *            card's ledger claim is in flight.
 *   routes   the phone/email list routes annotate each active row with the
 *            server's consent read; the create/patch routes take
 *            casey_draft_id out of the body and attribute through the ledger.
 *
 * Mutation-checked: the slice report lists each mutation and the test that
 * killed it (a kill = jest's exit code).
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'consent-core-test-secret';

const optout = require('../services/optoutService');
const phoneSvc = require('../services/contactPhoneService');
const emailSvc = require('../services/contactEmailService');
const contactService = require('../services/contactService');
const ledger = require('../services/assistantActionLedger');
const { answerOptout } = require('./helpers/optoutFake');
const { makeWorld } = require('./helpers/contactConsentWorld');

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────────────

const PAT = '3135550001';      // row cache flag only (not migrated yet)
const SAM = '3135550002';      // row flag 0, number opted out by STATE
const ANN = '3135550003';      // row flag 0, state opted_in
const GHOST = '3135550009';    // no row anywhere, state opted_out
function readerDb({ topics = [{ topic_key: 'newsletter', channel: 'email', consent_model: 'opt_out', active: 1 }] } = {}) {
  const world = {
    contacts: [{ contact_id: 1, contact_name: 'Pat One' }, { contact_id: 2, contact_name: 'Sam Two' }, { contact_id: 3, contact_name: 'Ann Three' }],
    phones: [
      { id: 11, contact_id: 1, phone: PAT, sms_optout: 1, end_date: null },
      { id: 12, contact_id: 2, phone: SAM, sms_optout: 0, end_date: null },
      { id: 13, contact_id: 3, phone: ANN, sms_optout: 0, end_date: null },
      { id: 14, contact_id: 3, phone: GHOST, sms_optout: 1, end_date: '2026-01-01' },   // ENDED: history, never read
    ],
    emails: [
      { id: 21, contact_id: 1, email: 'Pat@Example.com', email_optout: 1, end_date: null },  // cache only
      { id: 22, contact_id: 2, email: 'sam@example.com', email_optout: 0, end_date: null },  // state marketing
      { id: 23, contact_id: 3, email: 'ann@example.com', email_optout: 0, end_date: null },  // state newsletter only
      { id: 24, contact_id: 3, email: 'zed@example.com', email_optout: 0, end_date: null },  // nothing
    ],
    states: [
      { channel: 'sms', destination: SAM, scope: 'all', state: 'opted_out', last_event_id: 5 },
      { channel: 'sms', destination: ANN, scope: 'all', state: 'opted_in', last_event_id: 6 },
      { channel: 'sms', destination: GHOST, scope: 'all', state: 'opted_out', last_event_id: 7 },
      { channel: 'email', destination: 'sam@example.com', scope: 'marketing', state: 'opted_out', last_event_id: 8 },
      { channel: 'email', destination: 'ann@example.com', scope: 'newsletter', state: 'opted_out', last_event_id: 9 },
      { channel: 'email', destination: 'ghost@example.com', scope: 'marketing', state: 'opted_out', last_event_id: 10 },
    ],
    topics,
  };
  const calls = [];
  const db = {
    async query(sql, p) {
      calls.push(sql);
      const r = answerOptout(sql, p, world);
      if (!r) throw new Error(`reader fake: unscripted ${sql}`);
      return r;
    },
  };
  return { db, calls, world };
}
const ids = (hits) => hits.map((h) => [h.destination, h.contact_id, h.row_id]);

describe('reader — operational', () => {
  test('SMS (scope all, D19): the cache flag OR the number\'s state blocks; an opted-in state with a clear flag does not; ended rows are history', async () => {
    const { db } = readerDb();
    expect(await optout.findOptedOut(db, 'sms', [PAT, SAM, ANN, GHOST, '3135550004'])).toEqual([
      { channel: 'sms', destination: PAT, contact_id: 1, contact_name: 'Pat One', row_id: 11 },
      { channel: 'sms', destination: SAM, contact_id: 2, contact_name: 'Sam Two', row_id: 12 },
      // No row holds it (the opt-out survived its row): null ids, never "contact #0".
      { channel: 'sms', destination: GHOST, contact_id: null, contact_name: null, row_id: null },
    ]);
    expect(await optout.findOptedOut(db, 'mms', '+1 (313) 555-0002')).toHaveLength(1);
    expect(await optout.findOptedOut(db, 'sms', '555-0002')).toEqual([]);   // not a 10-digit number
  });

  test('a row-less hit reads as the bare number in the refusal and the staff warning', async () => {
    const { db } = readerDb();
    const err = await optout.assertNotOptedOut(db, 'sms', GHOST).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(optout.OptOutRefusal);
    expect(err.message).toBe('Not sent — (313) 555-0009 has opted out of texts. Automation never messages an opted-out recipient; '
      + 'clear the opt-out on the contact\'s phone row if they opt back in.');
    const g = await optout.optoutGate(db, { channel: 'sms', dest: GHOST });
    expect(g.refusal.status).toBe(409);
    expect(g.refusal.body.message).toMatch(/^\(313\) 555-0009 has opted out of texts\. Send anyway/);
    const a = await optout.optoutGate(db, { channel: 'sms', dest: GHOST, automation: true });
    expect(a.refusal.status).toBe(422);
  });

  test('email (D18): an operational email is NEVER blocked — not by the cache flag, not by any state — and nothing is read', async () => {
    const { db, calls } = readerDb();
    for (const dest of ['pat@example.com', 'sam@example.com', 'ann@example.com', 'ghost@example.com']) {
      expect(await optout.findOptedOut(db, 'email', dest)).toEqual([]);
      await expect(optout.assertNotOptedOut(db, 'email', dest)).resolves.toBeUndefined();
      expect(await optout.optoutGate(db, { channel: 'email', dest, automation: true })).toEqual({ refusal: null, overridden: [] });
    }
    expect(calls).toEqual([]);
    expect(optout.emailOptedOutSql('c.contact_email')).toBe('(0 = 1)');
  });
});

describe('reader — marketing', () => {
  test('email marketing (no topic): scope marketing — the cache flag or the state; a topic-only opt-out does not count', async () => {
    const { db } = readerDb();
    const hits = await optout.findOptedOut(db, 'email', ['pat@example.com', 'sam@example.com', 'ann@example.com', 'zed@example.com', 'ghost@example.com'], { klass: 'marketing' });
    expect(ids(hits)).toEqual([['pat@example.com', 1, 21], ['sam@example.com', 2, 22], ['ghost@example.com', null, null]]);
    const err = await optout.assertNotOptedOut(db, 'email', 'pat@example.com', { klass: 'marketing' }).then(() => null, (e) => e);
    expect(err.message).toMatch(/^Not sent — Pat One pat@example\.com \(contact #1\) has opted out of marketing email\./);
  });

  test('a topic adds its own scope: the newsletter opt-out counts for a newsletter send', async () => {
    const { db } = readerDb();
    const hits = await optout.findOptedOut(db, 'email', ['pat@example.com', 'ann@example.com', 'zed@example.com'], { klass: 'marketing', topic: 'newsletter' });
    expect(ids(hits)).toEqual([['pat@example.com', 1, 21], ['ann@example.com', 3, 23]]);
  });

  test('an opt_in topic blocks every destination without an opted_in state — rows or not', async () => {
    const { db, world } = readerDb({ topics: [{ topic_key: 'vip', channel: 'email', consent_model: 'opt_in', active: 1 }] });
    expect(ids(await optout.findOptedOut(db, 'email', ['zed@example.com', 'new@example.com'], { klass: 'marketing', topic: 'vip' })))
      .toEqual([['zed@example.com', 3, 24], ['new@example.com', null, null]]);
    world.states.push({ channel: 'email', destination: 'zed@example.com', scope: 'vip', state: 'opted_in', last_event_id: 11 });
    expect(ids(await optout.findOptedOut(db, 'email', ['zed@example.com', 'new@example.com'], { klass: 'marketing', topic: 'vip' })))
      .toEqual([['new@example.com', null, null]]);
  });

  test('fail closed: an unknown, inactive or other-channel topic blocks every destination', async () => {
    for (const topics of [[], [{ topic_key: 'newsletter', channel: 'email', consent_model: 'opt_out', active: 0 }],
      [{ topic_key: 'newsletter', channel: 'sms', consent_model: 'opt_out', active: 1 }]]) {
      const { db } = readerDb({ topics });
      expect(ids(await optout.findOptedOut(db, 'email', ['zed@example.com'], { klass: 'marketing', topic: 'newsletter' })))
        .toEqual([['zed@example.com', 3, 24]]);
    }
  });

  test('marketing SMS checks scope all plus the topic (D1 keeps it off — the reader still answers)', async () => {
    const { db } = readerDb({ topics: [{ topic_key: 'sms_marketing', channel: 'sms', consent_model: 'opt_in', active: 1 }] });
    expect(ids(await optout.findOptedOut(db, 'sms', [PAT, ANN], { klass: 'marketing', topic: 'sms_marketing' })))
      .toEqual([[PAT, 1, 11], [ANN, 3, 13]]);   // ANN: opted in to 'all', never to the opt_in topic
  });

  test('options are validated: a typo\'d klass never reads as operational, a topic needs klass marketing and a safe key', async () => {
    const { db } = readerDb();
    await expect(optout.findOptedOut(db, 'email', 'pat@example.com', { klass: 'promo' })).rejects.toThrow(/unknown klass "promo"/);
    await expect(optout.findOptedOut(db, 'sms', PAT, { topic: 'newsletter' })).rejects.toThrow(/marketing sends only/);
    await expect(optout.findOptedOut(db, 'email', 'x@y.co', { klass: 'marketing', topic: "x' OR 1=1 --" })).rejects.toThrow(/invalid topic/);
    expect(() => optout.emailOptedOutSql('c.e', { klass: 'marketing', topic: "x' OR '1" })).toThrow(/invalid topic/);
  });
});

describe('reader — SQL predicates and versions', () => {
  test('*OptedOutSql carries the dual-read and the scopes (agreement with findOptedOut is held on the engine in the twin)', () => {
    const sms = optout.smsOptedOutSql('c.contact_phone');
    expect(sms).toContain('oo_r.phone = c.contact_phone AND oo_r.end_date IS NULL AND oo_r.sms_optout = 1');
    expect(sms).toContain("oo_s.channel = 'sms' AND oo_s.destination = c.contact_phone AND oo_s.scope IN ('all') AND oo_s.state = 'opted_out'");
    const mkt = optout.emailOptedOutSql('c.contact_email', { klass: 'marketing' });
    expect(mkt).toContain('oo_r.email_optout = 1');
    expect(mkt).toContain("oo_s.scope IN ('marketing')");
    const topic = optout.emailOptedOutSql('c.contact_email', { klass: 'marketing', topic: 'newsletter' });
    expect(topic).toContain("oo_s.scope IN ('marketing', 'newsletter')");
    expect(topic).toContain("NOT EXISTS (SELECT 1 FROM comm_topics oo_t WHERE oo_t.topic_key = 'newsletter' AND oo_t.channel = 'email' AND oo_t.active = 1)");
  });

  test('consentVersions: the operational read plus the newest event id per destination (any scope); unknown = "0"', async () => {
    const { db } = readerDb();
    const sms = await optout.consentVersions(db, 'sms', [PAT, SAM, ANN]);
    expect([...sms]).toEqual([[PAT, { opted_out: true, version: '0' }], [SAM, { opted_out: true, version: '5' }], [ANN, { opted_out: false, version: '6' }]]);
    const email = await optout.consentVersions(db, 'email', ['Sam@example.com', 'pat@example.com']);
    expect([...email]).toEqual([['sam@example.com', { opted_out: false, version: '8' }], ['pat@example.com', { opted_out: false, version: '0' }]]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one writer
// ─────────────────────────────────────────────────────────────────────────────

describe('recordConsent', () => {
  const T1 = new Date('2026-10-01T10:00:00.000Z');
  const T2 = new Date('2026-10-02T10:00:00.000Z');
  const world = () => makeWorld({ contacts: [{ contact_id: 1, contact_name: 'Pat One' }],
    phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0 }],
    emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 0 }] });

  test('an event, its state, and the active row\'s cache — for the flag\'s scope', async () => {
    const W = world();
    const r = await optout.recordConsent(W.db, { channel: 'sms', destination: '+1 313-555-0001', scope: 'all', action: 'opt_out', source: 'staff',
      occurredAt: T1, contactId: 1, actorUserId: 6, evidence: { row_id: 11 } });
    expect(r).toEqual({ event_id: 1, duplicate: false, applied: true, state: 'opted_out' });
    expect(W.events).toEqual([expect.objectContaining({ id: 1, channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff',
      contact_id: 1, actor_user_id: 6, evidence: { row_id: 11 }, provider_event_id: null })]);
    expect(W.state('sms', PAT, 'all')).toMatchObject({ state: 'opted_out', last_event_id: 1 });
    expect(W.phone(11).sms_optout).toBe(1);
    // email: the cache is scope 'marketing'; a topic scope never touches it
    await optout.recordConsent(W.db, { channel: 'email', destination: ' PAT@example.com ', scope: 'newsletter', action: 'opt_out', source: 'staff' });
    expect(W.email(21).email_optout).toBe(0);
    await optout.recordConsent(W.db, { channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out', source: 'staff' });
    expect(W.email(21).email_optout).toBe(1);
    expect(W.events.map((e) => e.destination)).toEqual([PAT, 'pat@example.com', 'pat@example.com']);
  });

  test('order-independent: an OLDER event recorded second loses — the state and the cache stay on the newer one', async () => {
    const W = world();
    await optout.recordConsent(W.db, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'sms_keyword', occurredAt: T2 });
    const late = await optout.recordConsent(W.db, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_in', source: 'staff', occurredAt: T1 });
    expect(late).toEqual({ event_id: 2, duplicate: false, applied: false, state: 'opted_out' });
    expect(W.events).toHaveLength(2);                                    // the proof keeps both
    expect(W.state('sms', PAT, 'all')).toMatchObject({ state: 'opted_out', last_event_id: 1 });
    expect(W.phone(11).sms_optout).toBe(1);
  });

  test('a tie on occurred_at goes to the later event id', async () => {
    const W = world();
    await optout.recordConsent(W.db, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff', occurredAt: T1 });
    const r = await optout.recordConsent(W.db, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_in', source: 'staff', occurredAt: T1 });
    expect(r).toMatchObject({ applied: true, state: 'opted_in' });
    expect(W.phone(11).sms_optout).toBe(0);
  });

  test('(source, provider_event_id) is a no-op the second time — one event, the state untouched', async () => {
    const W = world();
    const a = { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'migration', providerEventId: 'migration:phone:11', occurredAt: T1 };
    await optout.recordConsent(W.db, a);
    await optout.recordConsent(W.db, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_in', source: 'staff', occurredAt: T2 });
    expect(await optout.recordConsent(W.db, a)).toEqual({ event_id: null, duplicate: true, applied: false, state: null });
    expect(W.events).toHaveLength(2);
    expect(W.state('sms', PAT, 'all')).toMatchObject({ state: 'opted_in', last_event_id: 2 });
    // the same id from another source is a different event
    await optout.recordConsent(W.db, { ...a, source: 'provider_optout' });
    expect(W.events).toHaveLength(3);
  });

  test('refuses what the store could not mean — and writes NOTHING', async () => {
    const W = world();
    const base = { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff' };
    for (const [over, msg] of [
      [{ channel: 'email', destination: 'pat@example.com' }, /scope "all" exists for SMS only/],
      [{ scope: 'marketing' }, /"marketing" is an email scope/],
      [{ scope: 'sms_marketing' }, /"sms_marketing" is not a sms topic/],
      [{ channel: 'email', destination: 'pat@example.com', scope: 'nope' }, /"nope" is not a email topic/],
      [{ scope: "x'; DROP" }, /invalid scope/],
      [{ action: 'unsubscribe' }, /unknown action/],
      [{ source: 'magic' }, /unknown source/],
      [{ destination: '555-1212' }, /not a 10-digit number/],
      [{ channel: 'email', destination: 'not an address', scope: 'marketing' }, /not a valid address/],
      [{ evidence: ['x'] }, /evidence must be an object/],
      [{ occurredAt: 'yesterday-ish' }, /invalid occurredAt/],
      [{ lineNumber: '12' }, /lineNumber must be a 10-digit number/],
      [{ providerEventId: 'x'.repeat(129) }, /providerEventId exceeds 128/],
      [{ actorUserId: -3 }, /actorUserId must be a positive integer/],
    ]) {
      await expect(optout.recordConsent(W.db, { ...base, ...over })).rejects.toThrow(msg);
    }
    await expect(optout.recordConsent(null, base)).rejects.toThrow(/caller's connection/);
    expect([W.events, W.states, W.phone(11).sms_optout]).toEqual([[], [], 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every row writer
// ─────────────────────────────────────────────────────────────────────────────

const C1 = { contact_id: 1, contact_name: 'Pat One' };
const C2 = { contact_id: 2, contact_name: 'Sam Two' };
const optedState = (destination, channel = 'sms', scope = channel === 'sms' ? 'all' : 'marketing') =>
  ({ channel, destination, scope, state: 'opted_out', last_event_id: 99 });
// The actor a signed-in staff route passes (optoutService.consentActor of a JWT) —
// an opt-in needs it; an API key or automation may only opt out.
const STAFF6 = { kind: 'user', userId: 6 };
const STAFF22 = { kind: 'user', userId: 22 };

describe('writers — contactPhoneService / contactEmailService (POST/PATCH /api/contact-{phones,emails}, Casey\'s kinds)', () => {
  test('create with the box ticked = ONE opt_out event (staff, actor, evidence); the row is born with its cache set', async () => {
    const W = makeWorld({ contacts: [C1] });
    const { phone } = await phoneSvc.createContactPhone(W.db, 1, { phone: '313-555-0001', sms_optout: true }, { createdBy: 6 });
    expect(phone.sms_optout).toBe(1);
    expect(W.events).toEqual([expect.objectContaining({ channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff',
      contact_id: 1, actor_user_id: 6, evidence: { row_id: phone.id, via: 'row_create' } })]);
    expect(W.state('sms', PAT, 'all').state).toBe('opted_out');
    expect(W.unhandled).toEqual([]);
  });

  test('re-consent guard: re-creating a row for an opted-out number with the flag omitted or 0 records NOTHING and stays opted out', async () => {
    for (const fields of [{ phone: PAT }, { phone: PAT, sms_optout: 0 }, { phone: PAT, sms_optout: false }]) {
      const W = makeWorld({ contacts: [C1], states: [optedState(PAT)] });
      const { phone } = await phoneSvc.createContactPhone(W.db, 1, fields, { createdBy: 6 });
      expect([fields, phone.sms_optout, W.events]).toEqual([fields, 1, []]);
      expect(W.state('sms', PAT, 'all')).toMatchObject({ state: 'opted_out', last_event_id: 99 });
    }
    // and a tick over an already-opted-out number is no change: no event
    const W = makeWorld({ contacts: [C1], states: [optedState(PAT)] });
    await phoneSvc.createContactPhone(W.db, 1, { phone: PAT, sms_optout: 1 });
    expect(W.events).toEqual([]);
  });

  test('a transfer (force) KEEPS the opt-out: the donor ends, the new row is born opted out, no event', async () => {
    const W = makeWorld({ contacts: [C1, C2], phones: [{ id: 11, contact_id: 2, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    const { phone, transferred_from } = await phoneSvc.createContactPhone(W.db, 1, { phone: PAT }, { force: true, createdBy: 6 });
    expect(transferred_from).toMatchObject({ contact_id: 2, phone_id: 11 });
    expect(W.phone(11).end_reason).toBe('transferred');
    expect(phone).toMatchObject({ contact_id: 1, sms_optout: 1 });
    expect(W.events).toEqual([]);
  });

  test('update: a flag CHANGE is one event in its direction; the same flag sent back, or an unrelated edit, records nothing', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1 }], states: [optedState(PAT)] });
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 1, label: 'Work' }, { updatedBy: 6 });
    await phoneSvc.updateContactPhone(W.db, 11, { notes: 'call after 5' }, { updatedBy: 6 });
    expect(W.events).toEqual([]);
    const { phone } = await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(phone.sms_optout).toBe(0);
    expect(W.events).toEqual([expect.objectContaining({ action: 'opt_in', source: 'staff', actor_user_id: 6, contact_id: 1,
      evidence: { row_id: 11, via: 'row_patch' } })]);
    expect(W.state('sms', PAT, 'all')).toMatchObject({ state: 'opted_in', last_event_id: W.events[0].id });
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: true }, { updatedBy: 6, consentActor: STAFF6 });
    expect(W.events.map((e) => e.action)).toEqual(['opt_in', 'opt_out']);
    expect(W.unhandled).toEqual([]);
  });

  test('an ENDED row\'s flag is history: changing it records nothing', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, end_date: '2026-01-01' }] });
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 1 }, { updatedBy: 6 });
    expect(W.events).toEqual([]);
  });

  test('reactivation is a new active row: born max(its flag, the state); never opts in; its own history flag carries only over NO state', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, end_date: '2026-01-01' }], states: [optedState(PAT)] });
    const { phone } = await phoneSvc.updateContactPhone(W.db, 11, { end_date: null }, { updatedBy: 6 });
    expect([phone.sms_optout, W.events]).toEqual([1, []]);
    const W2 = makeWorld({ contacts: [C1], phones: [{ id: 12, contact_id: 1, phone: SAM, sms_optout: 1, end_date: '2026-01-01' }] });
    await phoneSvc.updateContactPhone(W2.db, 12, { end_date: null }, { updatedBy: 6 });
    expect(W2.events).toEqual([expect.objectContaining({ destination: SAM, action: 'opt_out', source: 'row_replace',
      evidence: { row_id: 12, via: 'row_patch', from_destination: SAM, from_row_id: 12, carried_by: 'reactivation' } })]);
    // A stale history flag never overrides a recorded decision: the number opted back IN since → born 0, nothing recorded.
    const W3 = makeWorld({ contacts: [C1], phones: [{ id: 13, contact_id: 1, phone: SAM, sms_optout: 1, end_date: '2026-01-01' }],
      states: [{ channel: 'sms', destination: SAM, scope: 'all', state: 'opted_in', last_event_id: 98 }] });
    const r3 = await phoneSvc.updateContactPhone(W3.db, 13, { end_date: null }, { updatedBy: 6 });
    expect([r3.phone.sms_optout, W3.events]).toEqual([0, []]);
  });

  test('email twins: the flag is scope marketing (D18) — create ticked and a change each record one event', async () => {
    const W = makeWorld({ contacts: [C1] });
    const { email } = await emailSvc.createContactEmail(W.db, 1, { email: 'Pat@Example.com', email_optout: 1 }, { createdBy: 6 });
    expect(email.email_optout).toBe(1);
    expect(W.events).toEqual([expect.objectContaining({ channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out',
      evidence: { row_id: email.id, via: 'row_create' } })]);
    await emailSvc.updateContactEmail(W.db, email.id, { email_optout: 1, notes: 'x' }, { updatedBy: 6, consentActor: STAFF6 });
    expect(W.events).toHaveLength(1);
    await emailSvc.updateContactEmail(W.db, email.id, { email_optout: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(W.events.map((e) => [e.scope, e.action])).toEqual([['marketing', 'opt_out'], ['marketing', 'opt_in']]);
    // the guard on email too
    const W2 = makeWorld({ contacts: [C1], states: [optedState('pat@example.com', 'email')] });
    const r = await emailSvc.createContactEmail(W2.db, 1, { email: 'pat@example.com' });
    expect([r.email.email_optout, W2.events]).toEqual([1, []]);
    expect([W.unhandled, W2.unhandled]).toEqual([[], []]);
  });

  test('consentEvidence (Casey) is merged into the event evidence', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0 }] });
    const D = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 1 }, { updatedBy: 22, consentEvidence: { via: 'casey', draft_id: D }, consentActor: STAFF22 });
    expect(W.events[0].evidence).toEqual({ row_id: 11, via: 'casey', draft_id: D });
    const { email } = await emailSvc.createContactEmail(W.db, 1, { email: 'a@b.co', email_optout: 1 }, { createdBy: 22, consentEvidence: { via: 'casey', draft_id: D } });
    expect(W.events[1].evidence).toEqual({ row_id: email.id, via: 'casey', draft_id: D });
  });
});

describe('writers — contactService (the contact form\'s aggregate save, scalar propagation, createContact)', () => {
  test('aggregate: a kept row\'s flag change is one event (via aggregate); an unrelated edit or an echo records nothing', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, label: 'Work', sms_optout: 0 }] }, { userId: 6 });
    expect(W.events).toEqual([]);
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1 }] }, { userId: 6 });
    expect(W.events).toEqual([expect.objectContaining({ destination: PAT, action: 'opt_out', source: 'staff', actor_user_id: 6,
      evidence: { row_id: 11, via: 'aggregate' } })]);
    expect(W.phone(11).sms_optout).toBe(1);
    expect(W.unhandled).toEqual([]);
  });

  test('aggregate insert: ticked → one event; a new row for an opted-out number is born opted out with none', async () => {
    const W = makeWorld({ contacts: [C1], states: [optedState(SAM)] });
    await contactService.updateContact(W.db, 1, { phones: [{ phone: PAT, sms_optout: 1 }, { phone: SAM, sms_optout: 0 }] }, { userId: 6 });
    expect(W.events.map((e) => [e.destination, e.action, e.evidence.via])).toEqual([[PAT, 'opt_out', 'aggregate']]);
    expect([W.active('contact_phones', PAT).sms_optout, W.active('contact_phones', SAM).sms_optout]).toEqual([1, 1]);
  });

  test('end-and-replace CARRIES the opt-out as row_replace for the NEW number; the old number keeps its own state', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: SAM }] }, { userId: 6 });
    const fresh = W.active('contact_phones', SAM);
    expect(fresh.sms_optout).toBe(1);
    expect(W.events).toEqual([expect.objectContaining({ destination: SAM, action: 'opt_out', source: 'row_replace', actor_user_id: 6,
      evidence: { from_destination: PAT, from_row_id: 11, row_id: fresh.id, via: 'aggregate', carried_by: 'replace' } })]);
    expect(W.state('sms', PAT, 'all')).toMatchObject({ state: 'opted_out', last_event_id: 99 });
    expect(W.phone(11).end_reason).toBe('replaced');
    // the form echoing the old flag back is still a carry …
    const W2 = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    await contactService.updateContact(W2.db, 1, { phones: [{ id: 11, phone: SAM, sms_optout: 1 }] }, { userId: 6 });
    expect(W2.events.map((e) => e.source)).toEqual(['row_replace']);
    // … unticking it in the same save carries nothing (and opts nothing in) …
    const W3 = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    await contactService.updateContact(W3.db, 1, { phones: [{ id: 11, phone: SAM, sms_optout: 0 }] }, { userId: 6 });
    expect([W3.events, W3.active('contact_phones', SAM).sms_optout]).toEqual([[], 0]);
    // … and ticking a consenting row while correcting it is staff's own opt-out.
    const W4 = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await contactService.updateContact(W4.db, 1, { phones: [{ id: 11, phone: SAM, sms_optout: 1 }] }, { userId: 6 });
    expect(W4.events.map((e) => [e.destination, e.source])).toEqual([[SAM, 'staff']]);
    expect([W.unhandled, W2.unhandled, W3.unhandled, W4.unhandled]).toEqual([[], [], [], []]);
  });

  test('email end-and-replace: the marketing opt-out is carried the same way', async () => {
    const W = makeWorld({ contacts: [C1], emails: [{ id: 21, contact_id: 1, email: 'old@example.com', email_optout: 1, is_primary: 1 }],
      states: [optedState('old@example.com', 'email')] });
    await contactService.updateContact(W.db, 1, { emails: [{ id: 21, email: 'new@example.com' }] }, { userId: 6 });
    expect(W.active('contact_emails', 'new@example.com').email_optout).toBe(1);
    expect(W.events).toEqual([expect.objectContaining({ channel: 'email', scope: 'marketing', destination: 'new@example.com', source: 'row_replace',
      evidence: expect.objectContaining({ from_destination: 'old@example.com', from_row_id: 21 }) })]);
  });

  test('aggregate transfer (force) keeps the opt-out on the new row; no event', async () => {
    const W = makeWorld({ contacts: [C1, C2], phones: [{ id: 11, contact_id: 2, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    await contactService.updateContact(W.db, 1, { phones: [{ phone: PAT }] }, { userId: 6, force: true });
    expect([W.phone(11).end_reason, W.active('contact_phones', PAT).contact_id, W.active('contact_phones', PAT).sms_optout]).toEqual(['transferred', 1, 1]);
    expect(W.events).toEqual([]);
  });

  test('scalar propagation (contact_phone / contact_email, the intake path): the new row is born from the state', async () => {
    const W = makeWorld({ contacts: [C1, C2], phones: [{ id: 11, contact_id: 2, phone: PAT, sms_optout: 1, is_primary: 1 }],
      states: [optedState(PAT), optedState('pat@example.com', 'email')] });
    await contactService.updateContact(W.db, 1, { contact_phone: PAT, contact_email: 'pat@example.com' }, { userId: 6, force: true });
    expect([W.active('contact_phones', PAT).contact_id, W.active('contact_phones', PAT).sms_optout]).toEqual([1, 1]);
    expect(W.active('contact_emails', 'pat@example.com').email_optout).toBe(1);
    expect(W.events).toEqual([]);
    // a never-opted-out value is born 0
    await contactService.updateContact(W.db, 1, { contact_phone: SAM }, { userId: 6 });
    expect(W.active('contact_phones', SAM).sms_optout).toBe(0);
    expect(W.unhandled).toEqual([]);
  });

  test('createContact (every create entrance) is born from the state too', async () => {
    const W = makeWorld({ states: [optedState(PAT), optedState('pat@example.com', 'email')] });
    const { contact_id } = await contactService.createContact(W.db, { fname: 'Pat', lname: 'One', phone: '(313) 555-0001', email: 'Pat@Example.com' }, { userId: 6 });
    expect(W.active('contact_phones', PAT)).toMatchObject({ contact_id, sms_optout: 1 });
    expect(W.active('contact_emails', 'pat@example.com')).toMatchObject({ contact_id, email_optout: 1 });
    expect(W.events).toEqual([]);
    expect(W.unhandled).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Campaigns — no behaviour change until C1 gives them a class
// ─────────────────────────────────────────────────────────────────────────────

describe('campaigns: email asks as MARKETING (still skips an email opt-out), SMS stays scope all', () => {
  const campaignService = require('../services/campaignService');
  const emailService = require('../services/emailService');
  const phoneService = require('../services/phoneService');
  function campaignDb(type, { emails = [], phones = [], states = [] } = {}) {
    const results = [];
    const db = {
      results,
      async query(sql, p) {
        const consent = answerOptout(sql, p, { emails, phones, states, contacts: [C1] });
        if (consent) return consent;
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s.startsWith('SELECT campaign_id, type, sender')) return [[{ campaign_id: 7, type, sender: type === 'sms' ? '2485550000' : 'firm@firm.test', subject: 'S', body: 'Hi', status: 'sending' }]];
        if (s.startsWith('SELECT contact_id, contact_name, contact_phone, contact_email FROM contacts')) return [[{ contact_id: 1, contact_name: 'Pat One', contact_phone: PAT, contact_email: 'pat@example.com' }]];
        if (s.startsWith('INSERT INTO campaign_results')) { results.push({ status: p[2], meta: p[4] && JSON.parse(p[4]) }); return [{ affectedRows: 1 }]; }
        if (/AS total/.test(s)) return [[{ total: 9, done: 1 }]];
        throw new Error(`campaign fake: unscripted ${s}`);
      },
    };
    return db;
  }
  test('executeSend: the email cache flag OR a marketing state skips (email_optout); a clean address would send', async () => {
    const send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ messageId: '<m>' });
    for (const world of [{ emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 1 }] },
      { emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 0 }], states: [optedState('pat@example.com', 'email')] }]) {
      const db = campaignDb('email', world);
      expect(await campaignService.executeSend(db, 7, 1)).toEqual({ skipped: true, reason: 'email_optout' });
      expect(db.results).toEqual([{ status: 'skipped', meta: { reason: 'email_optout' } }]);
    }
    expect(send).not.toHaveBeenCalled();
    // an SMS campaign reads scope all only: an email opt-out never skips it
    jest.spyOn(phoneService, 'sendSms').mockResolvedValue({ id: 'x' });
    const sms = campaignDb('sms', { emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 1 }] });
    await campaignService.executeSend(sms, 7, 1);
    expect(sms.results.map((r) => r.status)).toEqual(['sent']);
  });
  test('the preview filter carries the same scopes: marketing for email, all for SMS', async () => {
    const seen = [];
    const db = { query: async (sql) => { seen.push(sql); return [[]]; } };
    await campaignService.getFilteredContacts(db, { channel: 'email' });
    expect(seen[0]).toContain(`${optout.emailOptedOutSql('c.contact_email', { klass: 'marketing' })} AS email_opted_out`);
    expect(seen[0]).toContain(`${optout.smsOptedOutSql('c.contact_phone')} AS sms_opted_out`);
    expect(seen[0]).toContain("oo_s.scope IN ('marketing')");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Casey attribution + the routes
// ─────────────────────────────────────────────────────────────────────────────

describe('Casey attribution (assistantActionLedger.attribution)', () => {
  const D = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
  const pool = (rows) => {
    const calls = [];
    return { calls, getConnection: async () => { throw new Error('no'); },
      query: async (sql, p) => { calls.push([sql.replace(/\s+/g, ' ').trim(), p]); return [rows]; } };
  };
  test('only this user\'s IN-FLIGHT claim of a listed kind attributes; anything else is a plain staff write', async () => {
    const db = pool([{ kind: 'contact.phone.update.v1' }]);
    expect(await ledger.attribution(db, 22, D, ['contact.phone.update.v1'])).toEqual({ via: 'casey', draft_id: D });
    expect(db.calls).toEqual([["SELECT kind FROM assistant_action_ledger WHERE user_id = ? AND draft_id = ? AND status = 'in_flight'", [22, D]]]);
    expect(await ledger.attribution(db, 22, D, ['contact.email.update.v1'])).toBeNull();          // another kind
    expect(await ledger.attribution(pool([]), 22, D, ['contact.phone.update.v1'])).toBeNull();    // not in flight / not theirs
    const none = pool([{ kind: 'contact.phone.update.v1' }]);
    for (const [user, id] of [[22, 'not-a-uuid'], [22, null], [22, ''], ['x', D], [999, D]]) {
      expect(await ledger.attribution(none, user, id, ['contact.phone.update.v1'])).toBeNull();
    }
    expect(none.calls).toEqual([]);
    expect(await ledger.attribution({ query: async () => [[{ kind: 'contact.phone.update.v1' }]] }, 22, D, ['contact.phone.update.v1'])).toBeNull(); // not a pool
  });
});

describe('routes — consent on the list, casey_draft_id on the writes', () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const D = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
  let server; let base; let W; let claim;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.db = { getConnection: async () => { throw new Error('no'); }, withTransaction: (fn) => W.db.withTransaction(fn),
        query: async (sql, p) => {
          if (/FROM assistant_action_ledger/.test(sql)) return [claim && Number(p[0]) === claim.user && p[1] === claim.draft ? [{ kind: claim.kind }] : []];
          if (/^\s*INSERT INTO jwt_api_audit_log/.test(sql)) return [{ insertId: 1 }];
          return W.db.query(sql, p);
        } };
      next();
    });
    app.use(require('../routes/api.contactPhones'));
    app.use(require('../routes/api.contactEmails'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  const tok = () => jwt.sign({ sub: '22', username: 'rena', user_auth: 'authorized', roles: [], aud: 'staff' }, process.env.JWT_SECRET);
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok()}` }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };

  test('GET /api/contacts/:id/phones|emails: each ACTIVE row carries consent = the server\'s read; an ended row null', async () => {
    W = makeWorld({ contacts: [C1], phones: [
      { id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 },
      { id: 12, contact_id: 1, phone: SAM, sms_optout: 1, end_date: '2026-01-01' },
    ], emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 1 }],
    states: [{ ...optedState(PAT), last_event_id: 31 }, { ...optedState('pat@example.com', 'email'), last_event_id: 32 }] });
    const p = await call('GET', '/api/contacts/1/phones?include_inactive=true');
    expect(p.json.phones.map((r) => [r.id, r.consent])).toEqual([[11, { opted_out: true, version: '31' }], [12, null]]);
    const e = await call('GET', '/api/contacts/1/emails');
    expect(e.json.emails.map((r) => [r.id, r.consent])).toEqual([[21, { opted_out: false, version: '32' }]]);   // D18
  });

  test('PATCH: casey_draft_id never reaches the service; while the card\'s claim is in flight the event says so', async () => {
    W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0 }] });
    claim = { user: 22, draft: D, kind: 'contact.phone.update.v1' };
    const r = await call('PATCH', '/api/contact-phones/11', { sms_optout: true, casey_draft_id: D });
    expect(r.status).toBe(200);
    expect(W.events[0]).toMatchObject({ actor_user_id: 22, evidence: { row_id: 11, via: 'casey', draft_id: D } });
    claim = null;   // a marker without a live claim is a plain staff write
    await call('PATCH', '/api/contact-phones/11', { sms_optout: false, casey_draft_id: D });
    expect(W.events[1].evidence).toEqual({ row_id: 11, via: 'row_patch' });
  });

  test('POST: the same on create (contact.email.create.v1)', async () => {
    W = makeWorld({ contacts: [C1] });
    claim = { user: 22, draft: D, kind: 'contact.email.create.v1' };
    const r = await call('POST', '/api/contact-emails', { contact_id: 1, email: 'pat@example.com', email_optout: true, casey_draft_id: D });
    expect(r.status).toBe(201);
    expect(W.events[0].evidence).toEqual({ row_id: r.json.email.id, via: 'casey', draft_id: D });
    claim = null;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix round (review 2026-10-29): MAJOR 1–3, minors 5–7
// ─────────────────────────────────────────────────────────────────────────────

// A STOP / any newer decision landing on its own connection after the form loaded.
async function stopLands(W, destination, channel = 'sms') {
  await optout.recordConsent({ query: W.db.query }, { channel, destination, scope: optout.CACHE_SCOPE[channel],
    action: 'opt_out', source: channel === 'sms' ? 'sms_keyword' : 'unsub_page', providerEventId: `late-${destination}` });
}

describe('MAJOR 2 — the three-way compare: a stale contact-form save never records an opt-in', () => {
  test('the reviewer\'s scenario: form loaded 0, a STOP lands, staff save a label edit → nothing recorded, the number stays opted out', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await stopLands(W, PAT);
    expect(W.phone(11).sms_optout).toBe(1);                        // the STOP synced the cache
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, label: 'Work', sms_optout: 0, sms_optout_base: 0 }] },
      { userId: 6, consentActor: STAFF6 });
    expect(W.events.map((e) => [e.action, e.source])).toEqual([['opt_out', 'sms_keyword']]);
    expect(W.state('sms', PAT, 'all').state).toBe('opted_out');
    expect(W.phone(11)).toMatchObject({ label: 'Work', sms_optout: 1 });
    // the per-row PATCH is the same compare
    await phoneSvc.updateContactPhone(W.db, 11, { notes: 'x', sms_optout: 0, sms_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect([W.events.length, W.state('sms', PAT, 'all').state, W.phone(11).sms_optout]).toEqual([1, 'opted_out', 1]);
    expect(W.unhandled).toEqual([]);
  });

  test('email: the same stale form records nothing for the marketing scope', async () => {
    const W = makeWorld({ contacts: [C1], emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 0, is_primary: 1 }] });
    await stopLands(W, 'pat@example.com', 'email');
    await contactService.updateContact(W.db, 1, { emails: [{ id: 21, email: 'pat@example.com', label: 'Work', email_optout: 0, email_optout_base: 0 }] },
      { userId: 6, consentActor: STAFF6 });
    expect([W.events.length, W.state('email', 'pat@example.com', 'marketing').state, W.email(21).email_optout]).toEqual([1, 'opted_out', 1]);
  });

  test('a genuine toggle (sent ≠ base, base = current) still records opt_out / opt_in', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0 }] }, { userId: 6, consentActor: STAFF6 });
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 0, sms_optout_base: 1 }] }, { userId: 6, consentActor: STAFF6 });
    expect(W.events.map((e) => [e.action, e.source, e.actor_user_id, e.evidence.via])).toEqual([
      ['opt_out', 'staff', 6, 'aggregate'], ['opt_in', 'staff', 6, 'aggregate']]);
    expect([W.state('sms', PAT, 'all').state, W.phone(11).sms_optout]).toEqual(['opted_in', 0]);
    // per-row PATCH with a base
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 1, sms_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(W.events.map((e) => e.action)).toEqual(['opt_out', 'opt_in', 'opt_out']);
  });

  test('base ≠ current → 409 consent_changed, NOTHING written (row, ledger, state)', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1, label: 'Mobile' }] });
    await stopLands(W, PAT);                                        // form loaded 0; the number opted out since
    const before = JSON.stringify([W.phones, W.events, W.states]);
    // the user ticks it (a decision against a stale base) …
    await expect(contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, label: 'Work', sms_optout: 1, sms_optout_base: 0 }] },
      { userId: 6, consentActor: STAFF6 })).rejects.toMatchObject({ status: 409, code: 'consent_changed', consent: { destination: PAT } });
    await expect(phoneSvc.updateContactPhone(W.db, 11, { label: 'Work', sms_optout: 1, sms_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 }))
      .rejects.toMatchObject({ status: 409, code: 'consent_changed' });
    expect(JSON.stringify([W.phones, W.events, W.states])).toBe(before);
    // … and an untick against an opt-in that landed since.
    const W2 = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    await optout.recordConsent({ query: W2.db.query }, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_in', source: 'staff', actorUserId: 9 });
    await expect(contactService.updateContact(W2.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 0, sms_optout_base: 1 }] }, { userId: 6, consentActor: STAFF6 }))
      .rejects.toMatchObject({ status: 409, code: 'consent_changed' });
    expect(W2.events).toHaveLength(1);
    // an end-and-replace whose flag was changed against a moved base is refused too
    const W3 = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await stopLands(W3, PAT);
    await expect(contactService.updateContact(W3.db, 1, { phones: [{ id: 11, phone: SAM, sms_optout: 1, sms_optout_base: 0 }] }, { userId: 6, consentActor: STAFF6 }))
      .rejects.toMatchObject({ status: 409, code: 'consent_changed' });
  });

  test('email: a stale DECISION is 409 too, through the aggregate save and the per-row PATCH', async () => {
    const W = makeWorld({ contacts: [C1], emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 0, is_primary: 1 }] });
    await stopLands(W, 'pat@example.com', 'email');
    const before = JSON.stringify([W.emails, W.events, W.states]);
    await expect(contactService.updateContact(W.db, 1, { emails: [{ id: 21, email: 'pat@example.com', email_optout: 1, email_optout_base: 0 }] },
      { userId: 6, consentActor: STAFF6 })).rejects.toMatchObject({ status: 409, code: 'consent_changed', consent: { destination: 'pat@example.com' } });
    await expect(emailSvc.updateContactEmail(W.db, 21, { email_optout: 1, email_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 }))
      .rejects.toMatchObject({ status: 409, code: 'consent_changed' });
    expect(JSON.stringify([W.emails, W.events, W.states])).toBe(before);
    // an end-and-replace of the address whose flag was changed against the moved base is refused too
    // (the fake world has no rollback, so the ledger is the check here; the twin proves the full rollback)
    await expect(contactService.updateContact(W.db, 1, { emails: [{ id: 21, email: 'new@example.com', email_optout: 1, email_optout_base: 0 }] },
      { userId: 6, consentActor: STAFF6 })).rejects.toMatchObject({ status: 409, code: 'consent_changed', consent: { destination: 'pat@example.com' } });
    expect([W.events.length, W.active('contact_emails', 'new@example.com')]).toEqual([1, undefined]);
  });

  test('a stale form CORRECTING a number (end-and-replace) with the flag untouched carries the CURRENT opt-out — no 409', async () => {
    for (const [table, fam, col, flagKey, oldV, newV, ch] of [
      ['contact_phones', 'phones', 'phone', 'sms_optout', PAT, SAM, 'sms'],
      ['contact_emails', 'emails', 'email', 'email_optout', 'old@example.com', 'new@example.com', 'email']]) {
      const W = makeWorld({ contacts: [C1], [fam]: [{ id: 11, contact_id: 1, [col]: oldV, [flagKey]: 0, is_primary: 1 }] });
      await stopLands(W, oldV, ch);                                  // the old number/address opted out after the form loaded
      await contactService.updateContact(W.db, 1, { [fam]: [{ id: 11, [col]: newV, [flagKey]: 0, [`${flagKey}_base`]: 0 }] },
        { userId: 6, consentActor: STAFF6 });
      const fresh = W.active(table, newV);
      expect([table, fresh[flagKey]]).toEqual([table, 1]);
      expect(W.events.map((e) => [e.destination, e.source, e.evidence && e.evidence.carried_by])).toEqual([[oldV, ch === 'sms' ? 'sms_keyword' : 'unsub_page', null],
        [newV, 'row_replace', 'replace']]);
    }
  });

  test('no base (Casey, an API caller, an older tab) — the decision is sent vs current, as before', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await stopLands(W, PAT);
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, label: 'Work', sms_optout: 0 }] }, { userId: 6, consentActor: STAFF6 });
    expect(W.events.map((e) => [e.action, e.source])).toEqual([['opt_out', 'sms_keyword'], ['opt_in', 'staff']]);
    // a resent current value is no decision
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(W.events).toHaveLength(2);
  });

  test('a resent UNCHANGED flag drops out of the plan: a row with nothing else changed is a no-op (no UPDATE at all)', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1, label: 'Mobile' }] });
    await stopLands(W, PAT);
    W.seen.length = 0;
    await contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, label: 'Mobile', is_primary: 1, sms_optout: 0, sms_optout_base: 0 }] },
      { userId: 6, consentActor: STAFF6 });
    expect(W.seen.filter((x) => /^UPDATE contact_phones SET /.test(x))).toEqual([]);
  });
});

describe('minor 7 — who may decide: an opt-in needs a signed-in user', () => {
  test('consentActor maps req.auth: jwt → user, api_key → api_key (+ key id), anything else → system', () => {
    expect(optout.consentActor({ type: 'jwt', userId: '22' })).toEqual({ kind: 'user', userId: 22 });
    expect(optout.consentActor({ type: 'api_key', key_id: 7, key_label: 'zapier' })).toEqual({ kind: 'api_key', keyId: 7, keyLabel: 'zapier' });
    expect(optout.consentActor({ type: 'api_key', key_label: 'internal' })).toEqual({ kind: 'api_key', keyId: null, keyLabel: 'internal' });
    expect(optout.consentActor(undefined)).toEqual({ kind: 'system' });
  });

  test('an API key may opt OUT (evidence names it) but never IN (422, nothing written); automation never opts in', async () => {
    const KEY = { kind: 'api_key', keyId: 7, keyLabel: 'zapier' };
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 1 }, { updatedBy: 0, consentActor: KEY });
    expect(W.events).toEqual([expect.objectContaining({ action: 'opt_out', source: 'staff', actor_user_id: null,
      evidence: { row_id: 11, via: 'api_key', key_id: 7, key_label: 'zapier' } })]);
    const before = JSON.stringify([W.phones, W.events, W.states]);
    await expect(phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 0 }, { updatedBy: 0, consentActor: KEY }))
      .rejects.toMatchObject({ status: 422, code: 'opt_in_needs_staff' });
    await expect(contactService.updateContact(W.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 0 }] }, { userId: 0, consentActor: KEY }))
      .rejects.toMatchObject({ status: 422, code: 'opt_in_needs_staff' });
    await expect(phoneSvc.updateContactPhone(W.db, 11, { sms_optout: 0 }, { updatedBy: 0 }))      // no actor = automation
      .rejects.toMatchObject({ status: 422, code: 'opt_in_needs_staff' });
    expect(JSON.stringify([W.phones, W.events, W.states])).toBe(before);
    // email the same
    const W2 = makeWorld({ contacts: [C1], emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 1 }], states: [optedState('pat@example.com', 'email')] });
    await expect(emailSvc.updateContactEmail(W2.db, 21, { email_optout: 0 }, { consentActor: KEY })).rejects.toMatchObject({ status: 422 });
  });

  test('a create never opts in, so an API key (workflow 33\'s Calendly POST) creates as before', async () => {
    const W = makeWorld({ contacts: [C1], states: [optedState(SAM)] });
    const { phone } = await phoneSvc.createContactPhone(W.db, 1, { phone: SAM, label: 'Other', notes: 'From Calendly booking', is_primary: 0 },
      { createdBy: 0, consentActor: { kind: 'api_key', keyId: 1 } });
    expect([phone.sms_optout, W.events]).toEqual([1, []]);
  });
});

describe('minor 5 — a transfer carries the donor\'s flag where the destination has no state yet', () => {
  const donor = (flag = 1) => ({ id: 31, contact_id: 2, phone: PAT, sms_optout: flag, is_primary: 1 });
  const OPTED_IN = { channel: 'sms', destination: PAT, scope: 'all', state: 'opted_in', last_event_id: 97 };
  const carried = (W, newRowId) => W.events.map((e) => [e.destination, e.action, e.source, e.evidence.carried_by, e.evidence.from_row_id, e.evidence.row_id === newRowId]);

  test('per-row create (force): the donor\'s gap flag carries — one row_replace event; over a recorded opt-in it does not', async () => {
    const W = makeWorld({ contacts: [C1, C2], phones: [donor()] });
    const { phone } = await phoneSvc.createContactPhone(W.db, 1, { phone: PAT }, { force: true, createdBy: 6 });
    expect(phone.sms_optout).toBe(1);
    expect(carried(W, phone.id)).toEqual([[PAT, 'opt_out', 'row_replace', 'transfer', 31, true]]);
    const W2 = makeWorld({ contacts: [C1, C2], phones: [donor()], states: [OPTED_IN] });
    const r2 = await phoneSvc.createContactPhone(W2.db, 1, { phone: PAT }, { force: true, createdBy: 6 });
    expect([r2.phone.sms_optout, W2.events]).toEqual([0, []]);
  });

  test('aggregate insert (force), scalar propagation (force) and createContact carry it too', async () => {
    const A = makeWorld({ contacts: [C1, C2], phones: [donor()] });
    await contactService.updateContact(A.db, 1, { phones: [{ phone: PAT }] }, { userId: 6, force: true });
    expect([A.active('contact_phones', PAT).sms_optout, A.events.map((e) => [e.source, e.evidence.carried_by, e.evidence.from_row_id])])
      .toEqual([1, [['row_replace', 'transfer', 31]]]);
    const S = makeWorld({ contacts: [C1, C2], phones: [donor()] });
    await contactService.updateContact(S.db, 1, { contact_phone: PAT }, { userId: 6, force: true });
    expect([S.active('contact_phones', PAT).sms_optout, S.events.map((e) => [e.source, e.evidence.carried_by, e.evidence.via])])
      .toEqual([1, [['row_replace', 'transfer', 'scalar']]]);
    const K = makeWorld({ contacts: [C2], phones: [donor()] });
    const { contact_id } = await contactService.createContact(K.db, { fname: 'New', lname: 'Owner', phone: PAT }, { userId: 6 });
    expect([K.active('contact_phones', PAT).contact_id, K.active('contact_phones', PAT).sms_optout, K.events.map((e) => e.evidence.carried_by)])
      .toEqual([contact_id, 1, ['transfer']]);
    expect([A.unhandled, S.unhandled, K.unhandled]).toEqual([[], [], []]);
  });

  test('email: the donor\'s marketing flag carries the same way', async () => {
    const W = makeWorld({ contacts: [C1, C2], emails: [{ id: 41, contact_id: 2, email: 'pat@example.com', email_optout: 1, is_primary: 1 }] });
    const { email } = await emailSvc.createContactEmail(W.db, 1, { email: 'pat@example.com' }, { force: true, createdBy: 6 });
    expect([email.email_optout, W.events.map((e) => [e.scope, e.source, e.evidence.from_row_id])]).toEqual([1, [['marketing', 'row_replace', 41]]]);
  });
});

describe('MAJOR 1 — update_db / insert_db cannot write consent, and realign what they touch', () => {
  const dbFns = require('../lib/internal_functions/db');
  test('setting either flag is refused by policy, pointing at the supported path — nothing written', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1 }], emails: [{ id: 21, contact_id: 1, email: 'a@b.co' }],
      states: [optedState(PAT)] });
    const before = JSON.stringify([W.phones, W.emails, W.events]);
    await expect(dbFns.update_db({ table: 'contact_phones', set: { sms_optout: 0 }, where: [{ column: 'id', value: 11 }] }, W.db))
      .rejects.toThrow(/update_db: contact_phones\.sms_optout is blocked from writes by policy — consent is not a column automation writes .*contact form/);
    await expect(dbFns.update_db({ table: 'contact_emails', set_column: 'email_optout', set_value: 1, where_column: 'id', where_value: 21 }, W.db))
      .rejects.toThrow(/contact_emails\.email_optout is blocked from writes by policy/);
    await expect(dbFns.insert_db({ table: 'contact_phones', values: { contact_id: 1, phone: SAM, sms_optout: 1 } }, W.db))
      .rejects.toThrow(/insert_db: contact_phones\.sms_optout is blocked from writes by policy — consent/);
    await expect(dbFns.insert_db({ table: 'contact_emails', values: { contact_id: 1, email: 'c@d.co', email_optout: 0 } }, W.db))
      .rejects.toThrow(/insert_db: contact_emails\.email_optout is blocked/);
    expect(JSON.stringify([W.phones, W.emails, W.events])).toBe(before);
  });

  test('an inserted row and a revived row take their destination\'s consent (no event); an ended row is left alone', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 12, contact_id: 1, phone: SAM, sms_optout: 0, end_date: '2026-01-01' }],
      states: [optedState(PAT), optedState(SAM)] });
    const ins = await dbFns.insert_db({ table: 'contact_phones', values: { contact_id: 1, phone: PAT } }, W.db);
    expect(W.phone(ins.output.insert_id).sms_optout).toBe(1);
    await dbFns.update_db({ table: 'contact_phones', set: { notes: 'history' }, where: [{ column: 'id', value: 12 }] }, W.db);
    expect(W.phone(12).sms_optout).toBe(0);                            // still ended: history untouched
    await dbFns.update_db({ table: 'contact_phones', set: { end_date: null }, where: [{ column: 'id', value: 12 }] }, W.db);
    expect(W.phone(12).sms_optout).toBe(1);                            // revived → born from the state
    expect(W.events).toEqual([]);
    // the row is locked before its state is read (lock order)
    expect(W.locks.slice(-3)).toEqual(['row:generic', 'row:id', 'state:share']);
  });
});

describe('MAJOR 3 — lock order and locking reads (the statements; tests/consentCore.mysql proves the engine behaviour)', () => {
  test('recordConsent locks the destination\'s ACTIVE row first and re-reads the state FOR UPDATE — never a snapshot read', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT }] });
    await optout.recordConsent({ query: W.db.query }, { channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'migration', providerEventId: 'm:1' });
    expect(W.locks).toEqual(['row:active', 'state:update', 'cache:index']);
    expect(W.seen.indexOf(optout.WRITE_SQL.active.sms)).toBeLessThan(W.seen.indexOf(optout.WRITE_SQL.seed));
    expect(W.seen).not.toContain(optout.WRITE_SQL.read);
  });

  test('a new row is written BEFORE its state is read (FOR SHARE); a decided row is locked by id before its state, and never re-locked through the unique key', async () => {
    const W = makeWorld({ contacts: [C1] });
    await phoneSvc.createContactPhone(W.db, 1, { phone: PAT, sms_optout: 1 });
    const ins = W.seen.findIndex((x) => /^INSERT INTO contact_phones /.test(x));
    expect(ins).toBeGreaterThan(-1);
    expect(W.seen.indexOf(optout.WRITE_SQL.share)).toBeGreaterThan(ins);
    expect(W.locks).toEqual(['state:share', 'state:update', 'cache:row']);       // the born row's own event: by row id
    W.locks.length = 0;
    await phoneSvc.updateContactPhone(W.db, W.phones[0].id, { sms_optout: 0 }, { consentActor: STAFF6 });
    expect(W.locks).toEqual(['row:id', 'state:share', 'state:update', 'cache:row']);
  });
});

describe('minor 6 — override audits keep the destination', () => {
  test('overrideAudit lists contact ids AND destinations; overrideLine names a row-less destination', () => {
    const hits = [{ contact_id: 1, destination: PAT }, { contact_id: null, destination: SAM }];
    expect(optout.overrideAudit(hits)).toEqual({ acknowledged_optout: [1, null], acknowledged_optout_destinations: [PAT, SAM] });
    expect(optout.overrideLine(hits)).toBe(`contact 1 (${PAT}), ${SAM} (no active row)`);
  });
});

describe('routes — the fix round\'s refusals reach the caller with their status and code', () => {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const apiKeys = require('../lib/apiKeys');
  let server; let base; let W;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.db = { getConnection: async () => { throw new Error('no'); }, withTransaction: (fn) => W.db.withTransaction(fn),
        query: async (sql, p) => (/^\s*INSERT INTO jwt_api_audit_log/.test(sql) ? [{ insertId: 1 }] : W.db.query(sql, p)) };
      next();
    });
    app.use(require('../routes/api.contactPhones'));
    app.use(require('../routes/api.contacts'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  afterEach(() => jest.restoreAllMocks());
  const tok = () => jwt.sign({ sub: '22', username: 'rena', user_auth: 'authorized', roles: [], aud: 'staff' }, process.env.JWT_SECRET);
  const call = async (method, p, body, headers = { Authorization: `Bearer ${tok()}` }) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };

  test('PATCH /api/contacts/:id (the contact form): a stale decision is 409 code consent_changed; a staff opt-in is attributed to the user', async () => {
    W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await stopLands(W, PAT);
    const r = await call('PATCH', '/api/contacts/1', { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0 }] });
    expect([r.status, r.json.code, r.json.consent]).toEqual([409, 'consent_changed', { destination: PAT }]);
    expect(W.events).toHaveLength(1);
    const ok = await call('PATCH', '/api/contact-phones/11', { sms_optout: 0, sms_optout_base: 1 });
    expect(ok.status).toBe(200);
    expect(W.events[1]).toMatchObject({ action: 'opt_in', actor_user_id: 22, evidence: { row_id: 11, via: 'row_patch' } });
  });

  test('an API key: PATCH opt-in → 422 opt_in_needs_staff, nothing written; opt-out → 200, evidence names the key', async () => {
    jest.spyOn(apiKeys, 'lookup').mockResolvedValue({ id: 7, label: 'zapier', scopes: null });
    W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1 }], states: [optedState(PAT)] });
    const KEY = { 'X-API-Key': 'yck_fake_route_test_key_0000000000' };   // secret-scan: allow
    const no = await call('PATCH', '/api/contact-phones/11', { sms_optout: 0 }, KEY);
    expect([no.status, no.json.code]).toEqual([422, 'opt_in_needs_staff']);
    const agg = await call('PATCH', '/api/contacts/1', { phones: [{ id: 11, phone: PAT, sms_optout: 0 }] }, KEY);
    expect([agg.status, agg.json.code]).toEqual([422, 'opt_in_needs_staff']);
    expect([W.events, W.phone(11).sms_optout]).toEqual([[], 1]);
    W.states.length = 0; W.phone(11).sms_optout = 0;
    const yes = await call('PATCH', '/api/contact-phones/11', { sms_optout: 1 }, KEY);
    expect(yes.status).toBe(200);
    expect(W.events[0]).toMatchObject({ action: 'opt_out', actor_user_id: null, evidence: { row_id: 11, via: 'api_key', key_id: 7, key_label: 'zapier' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MAJOR 2 — the contact form (the REAL page + the REAL YCForm, in jsdom)
// ─────────────────────────────────────────────────────────────────────────────

describe('contact-form.html: every LOADED phone/email row carries the flag it loaded; a 409 consent_changed offers a reload', () => {
  const fs = require('fs');
  const path = require('path');
  const { JSDOM, ResourceLoader } = require('jsdom');
  const ROOT = path.join(__dirname, '..');
  const SERVED = {
    '/js/yc-forms.js':         fs.readFileSync(path.join(ROOT, 'public/js/yc-forms.js')),
    '/js/yc-custom-fields.js': fs.readFileSync(path.join(ROOT, 'public/js/yc-custom-fields.js')),
  };
  class Loader extends ResourceLoader {
    fetch(url) { return Promise.resolve(SERVED[new URL(url).pathname] || Buffer.from('')); }
  }
  const DOMS = [];
  afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) {} }); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const contactRow = (over = {}) => ({
    contact_id: 5, contact_kind: 'person', contact_fname: 'Pat', contact_lname: 'One', contact_mname: '', contact_pname: '',
    contact_org_name: '', contact_dob: null, contact_ssn: '', contact_tags: '', contact_notes: '', custom: {},
    phones: [{ id: 11, phone: PAT, label: 'Mobile', is_primary: 1, sms_optout: 0, mms_capable: 1, verified: 0, notes: '' }],
    emails: [{ id: 21, email: 'pat@example.com', label: 'Personal', is_primary: 1, email_optout: 1, verified: 0, notes: '' }],
    addresses: [], ...over,
  });

  async function boot({ patch, reload } = {}) {
    const calls = [];
    const swal = [];
    const apiSend = async (url, method, body) => {
      calls.push({ url, method, body: body && JSON.parse(JSON.stringify(body)) });
      if (method === 'PATCH' && url.startsWith('/api/contacts/5')) return patch(body);
      if (method === 'GET' && url === '/api/contacts/5') return reload();
      if (url.startsWith('/api/forms/latest')) return { submitted: null, draft: null };
      if (url === '/api/field-defs') return { status: 'success', defs: [] };
      if (url === '/api/contact-role-types') return { status: 'success', role_types: [] };
      if (url === '/api/contacts/5/roles') return { status: 'success', roles: [] };
      return { status: 'success' };
    };
    const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'public/forms/contact-form.html'), 'utf8'), {
      url: 'https://app.4lsg.com/forms/contact-form.html?contact_id=5',
      runScripts: 'dangerously', resources: new Loader(), pretendToBeVisual: true,
      beforeParse(w) {
        w.apiSend = apiSend;                     // window.parent === window here, so this IS `P`
        w.entityData = { contact: contactRow() };
        w.firmData = { settings: {}, users: [] };
        w.Swal = { mixin: () => ({ fire: () => {} }), stopTimer() {}, resumeTimer() {},
          fire: async (o) => { swal.push(o); return { isConfirmed: true }; } };
        if (!w.CSS) w.CSS = {};
        if (!w.CSS.escape) w.CSS.escape = (v) => String(v);
      },
    });
    DOMS.push(dom);
    const w = dom.window;
    for (let i = 0; i < 300 && !(w.ycForm && w.ycForm._original && w.ycForm._original.phones); i++) await sleep(10);
    if (!w.ycForm) throw new Error('contact-form: YCForm never booted');
    await sleep(30);
    return { w, calls, swal, patches: () => calls.filter((c) => c.method === 'PATCH').map((c) => c.body) };
  }
  const editPhoneLabel = (w, label) => {
    const sel = w.document.querySelector('#phonesRepeater .yc-repeater-item [name="label"]');
    sel.value = label;
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  };

  test('a label edit sends every loaded row with its *_optout_base (the loaded flag); a new row carries none', async () => {
    const { w, patches } = await boot({ patch: () => ({ status: 'success', data: {} }) });
    editPhoneLabel(w, 'Work');
    const emailLabel = w.document.querySelector('#emailsRepeater .yc-repeater-item [name="label"]');
    emailLabel.value = 'Work';
    emailLabel.dispatchEvent(new w.Event('change', { bubbles: true }));
    w.ycForm._addRepeaterItemWithData('phones', { phone: SAM, label: 'Other', sms_optout: false });   // the "+ Add Phone" path
    await w.ycForm.save();
    const [body] = patches();
    expect(body.phones[0]).toMatchObject({ id: '11', label: 'Work', sms_optout_base: 0 });
    expect(body.emails[0]).toMatchObject({ id: '21', label: 'Work', email_optout_base: 1 });
    const added = body.phones.filter((x) => !x.id);
    expect(added).toHaveLength(1);
    expect('sms_optout_base' in added[0]).toBe(false);
  });

  test('409 consent_changed: nothing more is sent, the modal says so, and Reload fetches the contact fresh', async () => {
    const fresh = contactRow({ phones: [{ id: 11, phone: PAT, label: 'Mobile', is_primary: 1, sms_optout: 1, mms_capable: 1, verified: 0, notes: '' }] });
    const err = Object.assign(new Error('Consent changed'), { status: 409,
      body: { status: 'error', code: 'consent_changed', message: 'Consent for (313) 555-0001 changed since you opened this contact — reload it.' } });
    const { w, calls, swal, patches } = await boot({ patch: () => { throw err; },
      reload: () => ({ contact: fresh, phones: fresh.phones, emails: fresh.emails, addresses: [] }) });
    editPhoneLabel(w, 'Work');
    await w.ycForm.save();
    await sleep(20);
    expect(patches()).toHaveLength(1);                                   // no force-retry loop
    expect(swal.map((o) => o.title)).toEqual(['Consent changed']);
    expect(swal[0].text).toMatch(/^Consent for \(313\) 555-0001 changed since you opened this contact/);
    expect(calls.some((c) => c.method === 'GET' && c.url === '/api/contacts/5' && /phones/.test(JSON.stringify(c.body)))).toBe(true);
    expect(w.ycForm._original.phones[0]).toMatchObject({ id: '11', sms_optout: true });   // re-baselined on the fresh flag
  });
});
