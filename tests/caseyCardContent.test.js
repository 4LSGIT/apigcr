// Casey v2 S3b — lib/caseyCardContent.js: the server-rendered "exact content"
// block of a card step (design §4.4). The rule under test: NO FIELD IS HIDDEN —
// every top-level key of the request body appears in the fields, the known
// mail / SMS keys under their labels first, the rest under their own names.
'use strict';

const { contentFor, MAIL_FIELDS, SMS_FIELDS } = require('../lib/caseyCardContent');

const labels = (c) => c.fields.map((f) => f.label);
const byLabel = (c, l) => c.fields.find((f) => f.label === l).value;

test('a mail send: recipients, mailbox, subject, bodies, attachments under labels, in a fixed order; nothing in the body is left out', () => {
  const body = {
    mailbox_id: 3, to: [{ email: 'a@x.test', name: 'Ann' }, 'b@x.test'], cc: [], subject: 'Hearing moved',
    body_text: 'Line 1\nLine 2', attachments: [{ document_id: 10 }, { document_id: 11 }], acknowledge_optout: true, extra_flag: { nested: 1 },
  };
  const c = contentFor({ method: 'POST', path: '/api/mail/send', body: JSON.stringify(body) });
  expect(c.kind).toBe('mail');
  expect(labels(c)).toEqual(['From mailbox', 'To', 'Cc', 'Subject', 'Body (text)', 'Attachments', 'Opt-out acknowledged', 'extra_flag']);
  expect(byLabel(c, 'From mailbox')).toBe('mailbox #3');
  expect(byLabel(c, 'To')).toBe('Ann <a@x.test>, b@x.test');
  expect(byLabel(c, 'Cc')).toBe('(none)');
  expect(byLabel(c, 'Body (text)')).toBe('Line 1\nLine 2');
  expect(byLabel(c, 'Attachments')).toBe('2 files: {"document_id":10}, {"document_id":11}');
  expect(byLabel(c, 'Opt-out acknowledged')).toBe('true');
  expect(byLabel(c, 'extra_flag')).toBe('{"nested":1}');
  // The schedule twin is mail too; a query string on the path does not change the kind.
  expect(contentFor({ method: 'POST', path: '/api/mail/send/schedule?x=1', body: '{"to":["z@x.test"]}' })).toEqual({ kind: 'mail', fields: [{ label: 'To', value: 'z@x.test' }] });
});

test('an SMS send: To and Message; a generic write: every key as a row, scalars as text, objects as JSON; the rule holds for all three kinds', () => {
  const sms = contentFor({ method: 'POST', path: '/api/phone-lines/4/sms', body: '{"to":"+12485550100","message":"Your hearing is at 9."}' });
  expect(sms).toEqual({ kind: 'sms', fields: [{ label: 'To', value: '+12485550100' }, { label: 'Message', value: 'Your hearing is at 9.' }] });
  const task = { title: 'Call client', due_date: '2026-12-01', assigned_to: 6, tags: ['a', 'b'], meta: { k: 'v' }, done: false, note: null };
  const t = contentFor({ method: 'POST', path: '/api/tasks', body: JSON.stringify(task) });
  expect(t.kind).toBe('fields');
  expect(t.fields).toEqual([
    { label: 'title', value: 'Call client' }, { label: 'due_date', value: '2026-12-01' }, { label: 'assigned_to', value: '6' },
    { label: 'tags', value: 'a, b' }, { label: 'meta', value: '{"k":"v"}' }, { label: 'done', value: 'false' }, { label: 'note', value: '(none)' },
  ]);
  // No field hidden: for any body, every top-level key is represented exactly once (known keys under their label).
  for (const [path, body] of [['/api/mail/send', { to: ['x@x.test'], subject: 's', body_html: '<b>h</b>', mystery: 1, in_reply_to_message_fk: 9, quote_original: false, signature: true, case_id: 'ABC', send_at: '2026-12-01T10:00' }], ['/api/phone-lines/1/sms', { to: 'x', message: 'm', weird: [1] }], ['/api/whatever', { a: 1, b: [2], c: { d: 3 } }]]) {
    const c = contentFor({ method: 'POST', path, body: JSON.stringify(body) });
    const known = new Map([...MAIL_FIELDS, ...SMS_FIELDS]);
    const represented = c.fields.map((f) => f.label);
    for (const k of Object.keys(body)) expect(represented).toContain(c.kind === 'fields' ? k : (known.get(k) || k));
    expect(c.fields.length).toBe(Object.keys(body).length);
  }
});

test('edge bodies: none, not JSON, an array, an empty object, a bare object passed in', () => {
  expect(contentFor({ method: 'DELETE', path: '/api/tasks/5', body: null })).toEqual({ kind: 'fields', fields: [{ label: 'Body', value: '(no request body)' }] });
  expect(contentFor({ method: 'POST', path: '/api/tasks', body: '{cut…' })).toEqual({ kind: 'fields', fields: [{ label: 'Body', value: '(not JSON)' }] });
  expect(contentFor({ method: 'POST', path: '/api/tasks', body: '[1,2]' })).toEqual({ kind: 'fields', fields: [{ label: 'Body', value: '1, 2' }] });
  expect(contentFor({ method: 'POST', path: '/api/tasks', body: '{}' })).toEqual({ kind: 'fields', fields: [{ label: 'Body', value: '{} (empty object)' }] });
  expect(contentFor({ method: 'POST', path: '/api/tasks', body: { title: 'obj' } })).toEqual({ kind: 'fields', fields: [{ label: 'title', value: 'obj' }] });
});
