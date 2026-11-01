// tests/consentGapRetry.test.js
//
// YisraMail P1-fix — the deadlock retry on the consent-bearing contact saves
// (lib/withTransaction retryOnDeadlock; ref/YISRAMAIL_DESIGN.md §4.4), in the
// in-memory consent world. tests/consentGapDeadlock.mysql.test.js holds the
// race itself to a real engine; this suite pins the parts a race can't aim at:
//   - retryOnDeadlock re-runs exactly once, only for ER_LOCK_DEADLOCK;
//   - a re-run starts from what the CALLER sent: updateContactPhone /
//     updateContactEmail rewrite `incoming` inside the span (the decided flag),
//     so a re-run on the mutated copy would read a resent flag as a change and
//     answer a false 409 consent_changed;
//   - every wrapped save re-runs its span after a deadlock, and the rolled-back
//     first attempt leaves exactly one consent event.
'use strict';

// The two post-commit side effects of createContact / updateContact, observed.
// Partial mocks keep the real exports (buildChanges runs INSIDE the span).
const sideEffects = [];
jest.mock('../services/gContactsService', () => ({
  ...jest.requireActual('../services/gContactsService'),
  pushContact: jest.fn(async (db, id) => { sideEffects.push(`push:${id}`); }),
}));
jest.mock('../lib/domainEvents', () => ({
  ...jest.requireActual('../lib/domainEvents'),
  emit: jest.fn((db, type) => { sideEffects.push(`emit:${type}`); return Promise.resolve(); }),
}));

const { retryOnDeadlock } = require('../lib/withTransaction');
const phoneSvc = require('../services/contactPhoneService');
const emailSvc = require('../services/contactEmailService');
const contactService = require('../services/contactService');
const { makeWorld } = require('./helpers/contactConsentWorld');

const PAT = '3135550001';
const STAFF6 = { kind: 'user', userId: 6 };
const C1 = { contact_id: 1, contact_name: 'Pat One' };
const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { code: 'ER_LOCK_DEADLOCK' });

beforeEach(() => { sideEffects.length = 0; jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

/**
 * The world's db, whose FIRST withTransaction runs the span to the end and
 * then fails as InnoDB's deadlock victim would: everything the span wrote is
 * rolled back (the world's tables restored) and ER_LOCK_DEADLOCK is thrown.
 */
function deadlockOnce(W, times = 1) {
  let left = times;
  const spans = { runs: 0 };
  const tables = ['phones', 'emails', 'events', 'states', 'contacts'];
  const db = {
    query: W.db.query,
    withTransaction: async (fn, opts) => {
      spans.runs += 1;
      sideEffects.push('span');
      const snap = tables.map((t) => W[t].map((r) => ({ ...r })));
      const out = await W.db.withTransaction(fn, opts);
      if (left > 0) {
        left -= 1;
        tables.forEach((t, i) => W[t].splice(0, W[t].length, ...snap[i]));
        sideEffects.push('rolled_back');
        throw deadlock();
      }
      sideEffects.push('committed');
      return out;
    },
  };
  return { db, spans };
}

describe('retryOnDeadlock', () => {
  test('re-runs once on ER_LOCK_DEADLOCK; a second deadlock is the caller\'s', async () => {
    let n = 0;
    expect(await retryOnDeadlock(async () => { n += 1; if (n === 1) throw deadlock(); return 'ok'; })).toBe('ok');
    expect(n).toBe(2);
    n = 0;
    // Bounded on purpose: a looping retry would succeed on the 6th run (and fail here), not hang.
    await expect(retryOnDeadlock(async () => { n += 1; if (n <= 5) throw deadlock(); return 'ok'; })).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(n).toBe(2);
  });

  test('detection is by CODE: ER_LOCK_DEADLOCK with any message retries; a "Deadlock found" message without the code does not', async () => {
    let n = 0;
    expect(await retryOnDeadlock(async () => { n += 1; if (n === 1) throw Object.assign(new Error('lock wait'), { code: 'ER_LOCK_DEADLOCK' }); return 'ok'; })).toBe('ok');
    expect(n).toBe(2);
    n = 0;
    await expect(retryOnDeadlock(async () => { n += 1; throw new Error('Deadlock found when trying to get lock; try restarting transaction'); }))
      .rejects.toThrow(/Deadlock found/);
    expect(n).toBe(1);
  });

  test('anything else is not retried', async () => {
    let n = 0;
    await expect(retryOnDeadlock(async () => { n += 1; throw Object.assign(new Error('x'), { code: 'ER_DUP_ENTRY' }); })).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    await expect(retryOnDeadlock(async () => { n += 1; throw Object.assign(new Error('Consent changed'), { status: 409, code: 'consent_changed' }); }))
      .rejects.toMatchObject({ code: 'consent_changed' });
    expect(n).toBe(2);
  });
});

describe('the wrapped saves re-run their span after a deadlock', () => {
  test('per-row phone PATCH: a resent unchanged flag over a moved state stays "no decision" on the re-run (no false 409)', async () => {
    // The form loaded 0; a STOP has since opted the number out (state + cache).
    // The user edits the label only: sent 0 = base 0 → no decision, and the
    // span writes the decided flag (1) back into `incoming`. The re-run must
    // see the caller's 0 again, not that 1 (which would be a "change" against
    // a moved base → 409).
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1, label: 'Mobile' }],
      states: [{ channel: 'sms', destination: PAT, scope: 'all', state: 'opted_out', last_event_id: 1 }] });
    const { db, spans } = deadlockOnce(W);
    const r = await phoneSvc.updateContactPhone(db, 11, { label: 'Work', sms_optout: 0, sms_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(spans.runs).toBe(2);
    expect(r.phone).toBeTruthy();
    expect(W.phone(11)).toMatchObject({ label: 'Work', sms_optout: 1 });
    expect(W.events).toEqual([]);
  });

  test('per-row email PATCH: the same', async () => {
    const W = makeWorld({ contacts: [C1], emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 1, is_primary: 1, label: 'Personal' }],
      states: [{ channel: 'email', destination: 'pat@example.com', scope: 'marketing', state: 'opted_out', last_event_id: 1 }] });
    const { db, spans } = deadlockOnce(W);
    await emailSvc.updateContactEmail(db, 21, { label: 'Work', email_optout: 0, email_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(spans.runs).toBe(2);
    expect(W.email(21)).toMatchObject({ label: 'Work', email_optout: 1 });
    expect(W.events).toEqual([]);
  });

  test('per-row PATCH, a real toggle: re-run once, ONE event (the rolled-back attempt left none)', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    const { db, spans } = deadlockOnce(W);
    await phoneSvc.updateContactPhone(db, 11, { sms_optout: 1, sms_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 });
    expect(spans.runs).toBe(2);
    expect(W.events.map((e) => [e.destination, e.action, e.source])).toEqual([[PAT, 'opt_out', 'staff']]);
  });

  test('aggregate contact PATCH (the contact form): re-run once, ONE event, the response is the second run\'s', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    const { db, spans } = deadlockOnce(W);
    const out = await contactService.updateContact(db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, sms_optout_note: 'asked by phone' }] },
      { userId: 6, consentActor: STAFF6 });
    expect(spans.runs).toBe(2);
    expect(out.phones_changed).toBe(1);
    expect(W.events.map((e) => [e.action, e.source, e.evidence.note])).toEqual([['opt_out', 'staff', 'asked by phone']]);
  });

  test('per-row create and createContact: re-run once after a deadlock, one row born, one event', async () => {
    const W = makeWorld({ contacts: [C1] });
    const a = deadlockOnce(W);
    await phoneSvc.createContactPhone(a.db, 1, { phone: PAT, label: 'Work', sms_optout: 1 }, { createdBy: 6, consentActor: STAFF6 });
    expect(a.spans.runs).toBe(2);
    expect(W.phones.filter((r) => r.phone === PAT)).toHaveLength(1);
    expect(W.events.map((e) => [e.destination, e.source])).toEqual([[PAT, 'staff']]);

    const e = deadlockOnce(W);
    await emailSvc.createContactEmail(e.db, 1, { email: 'pat@example.com', email_optout: 1 }, { createdBy: 6, consentActor: STAFF6 });
    expect(e.spans.runs).toBe(2);
    expect(W.emails.filter((r) => r.email === 'pat@example.com')).toHaveLength(1);

    const W2 = makeWorld({ contacts: [] });
    const c = deadlockOnce(W2);
    await contactService.createContact(c.db, { fname: 'Sam', lname: 'Two', phone: '3135550002', email: 'sam@example.com' }, { userId: 6, consentActor: STAFF6 });
    expect(c.spans.runs).toBe(2);
    expect(W2.contacts).toHaveLength(1);
  });

  const flush = () => new Promise((r) => setTimeout(r, 10));   // the post-commit emit is an un-awaited async IIFE

  test('updateContact after a deadlock: ONE Google push and ONE contact.updated emit, both after the commit', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    const { db } = deadlockOnce(W);
    await contactService.updateContact(db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0 }] }, { userId: 6, consentActor: STAFF6 });
    await flush();
    expect(sideEffects).toEqual(['span', 'rolled_back', 'span', 'committed', 'push:1', 'emit:contact.updated']);
  });

  test('createContact after a deadlock: ONE Google push and ONE contact.created emit, both after the commit', async () => {
    const W = makeWorld({ contacts: [] });
    const { db } = deadlockOnce(W);
    const out = await contactService.createContact(db, { fname: 'Sam', lname: 'Two', phone: '3135550002' }, { userId: 6, consentActor: STAFF6 });
    await flush();
    const id = out.contact_id;
    expect(sideEffects).toEqual(['span', 'rolled_back', 'span', 'committed', `push:${id}`, 'emit:contact.created']);
  });

  test('a second deadlock surfaces (once is the contract, not a loop)', async () => {
    const W = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    const { db, spans } = deadlockOnce(W, 2);
    await expect(phoneSvc.updateContactPhone(db, 11, { sms_optout: 1, sms_optout_base: 0 }, { updatedBy: 6, consentActor: STAFF6 }))
      .rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(spans.runs).toBe(2);
    expect(W.events).toEqual([]);
  });
});
