// tests/sesEvents.parse.test.js
//
/**
 * YisraMail T2 — the SES driver's event parser
 * (services/adapters/email/drivers/ses.js events.parseDetailed).
 * Run: npx jest tests/sesEvents.parse.test.js
 *
 * FIXTURES: tests/fixtures/ses-events/<type>.json are REAL events captured on
 * hook ses-events in step 0 (2026-11-01, hook_executions 36158–36169: the
 * `body` of each — five SES mailbox-simulator sends tagged campaign_id=t2,
 * result_id=t2-1..t2-5; simulator addresses kept, nothing secret in them).
 * *.assumed.json are still built from AWS's DOCUMENTED shape: Reject, delivery
 * delay and rendering failure cannot be produced from the simulator
 * (ref/plans.md), and bounce-multi is a constructed two-recipient bounce.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ses = require('../services/adapters/email/drivers/ses');

const FIX = path.join(__dirname, 'fixtures', 'ses-events');
const load = (n) => {
  const real = path.join(FIX, `${n}.json`);
  return JSON.parse(fs.readFileSync(fs.existsSync(real) ? real : path.join(FIX, `${n}.assumed.json`), 'utf8'));
};
const parse = (b) => ses.events.parseDetailed(b);

describe('captured events (step 0) → normalized events', () => {
  test.each([
    ['delivery', 'delivered', 'success@simulator.amazonses.com', '250 Ok', '2026-11-01T23:20:40.776Z', 't2-1'],
    ['bounce-permanent', 'bounce_hard', 'bounce@simulator.amazonses.com', 'smtp; 550 5.1.1 As requested: user unknown <bounce@simulator.amazonses.com>', '2026-11-01T23:20:48.898Z', 't2-2'],
    ['bounce-transient', 'bounce_soft', 'ooto@simulator.amazonses.com', 'Transient/General', '2026-11-01T23:21:05.011Z', 't2-4'],
    ['bounce-suppressed', 'bounce_hard', 'suppressionlist@simulator.amazonses.com', null, '2026-11-01T23:21:12.470Z', 't2-5'],
    ['complaint', 'complaint', 'complaint@simulator.amazonses.com', 'abuse', '2026-11-01T23:20:57.221Z', 't2-3'],
  ])('%s', (name, type, recipient, diagnostic, at, resultId) => {
    const body = load(name);
    const r = parse(body);
    expect(r).toMatchObject({ ignored: 0, unknown_shape: 0, errors: [] });
    expect(r.events).toHaveLength(1);
    const e = r.events[0];
    expect(e).toMatchObject({ type, recipient, provider_event_id: `${body.id}:${recipient}`, provider_message_id: body.detail.mail.messageId });
    if (diagnostic) expect(e.diagnostic).toBe(diagnostic);
    // the event's message id has the shape the T1 driver reads from the 250 reply — the second correlation key
    expect(e.provider_message_id).toMatch(/^[0-9a-f]{16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-000000$/);
    expect(ses.messageIdFromResponse(`250 Ok ${e.provider_message_id}`)).toBe(e.provider_message_id);
    expect(e.at.toISOString()).toBe(at);
    // our two tags only — SES's own ses:* system tags are ignored
    expect(e.tags).toEqual({ campaign_id: 't2', result_id: resultId });
    expect(Object.keys(body.detail.mail.tags).filter((k) => k.startsWith('ses:')).length).toBeGreaterThan(3);
  });

  test('the suppression bounce carries its subtype (the bounce-rate exclusion reads it)', () => {
    const e = parse(load('bounce-suppressed')).events[0];
    expect(e.raw).toMatchObject({ bounceType: 'Permanent', bounceSubType: 'EmailValidationSuppressed' });
    expect(e.diagnostic).toMatch(/^Amazon SES has suppressed sending to this address/);
  });

  test('the captured Send is ignored; every captured body is an aws.ses event with an id (dedup_path body.id)', () => {
    expect(parse(load('send'))).toEqual({ events: [], ignored: 1, unknown_shape: 0, errors: [] });
    for (const n of ['send', 'delivery', 'bounce-permanent', 'bounce-transient', 'bounce-suppressed', 'complaint']) {
      const b = load(n);
      expect(b.source).toBe('aws.ses');
      expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(b.resources).toEqual(['arn:aws:ses:us-east-2:216822717350:configuration-set/yisramail-marketing']);
    }
  });
});

describe('assumed shapes (documented, not producible from the simulator) → normalized events', () => {
  test.each([
    ['reject', 'reject', 'virus@example.com', 'Bad content', '2026-11-02T15:00:00.000Z'],
    ['delivery-delay', 'bounce_soft', 'slow@example.com', 'smtp; 421 4.4.1 timeout', '2026-11-02T15:30:00.000Z'],
    ['rendering-failure', 'rendering_failure', 'tpl@example.com', "Attribute 'name' is not present in the rendering data.", '2026-11-02T15:00:00.000Z'],
  ])('%s', (name, type, recipient, diagnostic, at) => {
    const body = load(name);
    const r = parse(body);
    expect(r).toMatchObject({ ignored: 0, unknown_shape: 0, errors: [] });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      type, recipient, diagnostic,
      provider_message_id: '0100019a3c2b1a00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000',
      provider_event_id: `${body.id}:${recipient}`,
      tags: { campaign_id: '7', result_id: '41' },
    });
    expect(r.events[0].at.toISOString()).toBe(at);
    expect(ses.EVENT_TYPES).toContain(type);
    expect(ses.events.parse(body)).toEqual(r.events);
  });

  // C6 engagement — CAPTURED events (campaign 120, 2026-11-05, hook_executions
  // 37185/37186), sanitized only in click.json's ipAddress (the firm's
  // network) and the link's c= token (it was live); open.json is verbatim —
  // its 66.249.* IP + ancient-Firefox UA is Gmail's image proxy fetching the
  // pixel, the "opens are approximate" phenomenon on the record.
  test.each([
    ['open', 'open'],
    ['click', 'click'],
  ])('%s (captured): engagement event, no diagnostic, recipient from mail.destination', (name, type) => {
    const body = load(name);
    const r = parse(body);
    expect(r).toMatchObject({ ignored: 0, unknown_shape: 0, errors: [] });
    expect(r.events).toHaveLength(1);
    const e = r.events[0];
    expect(e).toMatchObject({
      type, recipient: 'it@4lsg.com', diagnostic: null,
      provider_message_id: '010f01a1ac63f088-24bc77e4-7a10-4821-a9ad-78a629730295-000000',
      provider_event_id: `${body.id}:it@4lsg.com`,
      tags: { campaign_id: '120', result_id: '297' },
    });
    expect(ses.EVENT_TYPES).toContain(type);
    expect(body.resources).toEqual(['arn:aws:ses:us-east-2:216822717350:configuration-set/yisramail-marketing']);
  });

  test('open (captured): at is the open timestamp; raw carries userAgent/ipAddress/isBotEvent', () => {
    const e = parse(load('open')).events[0];
    expect(e.at.toISOString()).toBe('2026-11-05T18:30:25.538Z');
    expect(e.raw).toMatchObject({ eventType: 'Open', ipAddress: '66.249.93.34', isBotEvent: 'Unlikely' });
    expect(e.raw.userAgent).toMatch(/^Mozilla/);
  });

  test('click (captured): at is the click timestamp; raw.link is the clicked URL (the campaign_clicks row)', () => {
    const e = parse(load('click')).events[0];
    expect(e.at.toISOString()).toBe('2026-11-05T18:30:29.347Z');
    expect(e.raw).toMatchObject({ eventType: 'Click', link: 'https://4lsg.com/b/your-booking-slug?c=00000000000000000000000000000000', isBotEvent: 'Unlikely' });
  });

  test("a Likely-bot open/click is IGNORED (isBotEvent 'Likely' or true) — a scanner must not stamp engagement; anything else counts", () => {
    for (const [name, sub] of [['open', 'open'], ['click', 'click']]) {
      for (const bot of ['Likely', true, 'true']) {
        const b = load(name);
        b.detail[sub].isBotEvent = bot;
        expect(parse(b)).toMatchObject({ events: [], ignored: 1, unknown_shape: 0, errors: [] });
      }
      for (const notBot of ['Unlikely', false, undefined, null]) {
        const b = load(name);
        if (notBot === undefined) delete b.detail[sub].isBotEvent; else b.detail[sub].isBotEvent = notBot;
        expect(parse(b).events).toHaveLength(1);
      }
    }
  });

  test('a click whose link exceeds 512 characters is clipped to the campaign_clicks column width', () => {
    const body = load('click');
    body.detail.click.link = 'https://www.4lsg.com/' + 'x'.repeat(600);
    const e = parse(body).events[0];
    expect(e.raw.link).toHaveLength(512);
  });

  test('Send and Subscription stay ignored; Open/Click no longer are', () => {
    const send = load('send');
    expect(parse(send)).toEqual({ events: [], ignored: 1, unknown_shape: 0, errors: [] });
    const sub = load('send');
    sub.detail = { ...sub.detail, eventType: 'Subscription' };
    expect(parse(sub).ignored).toBe(1);
    expect(parse(load('open')).ignored).toBe(0);
    expect(parse(load('click')).ignored).toBe(0);
  });

  test('an Open/Click whose sub-object is missing is unknown_shape, never a throw', () => {
    const body = load('open');
    delete body.detail.open;
    expect(parse(body)).toMatchObject({ events: [], unknown_shape: 1, errors: [] });
  });
});

describe('fan-out, tags, ids', () => {
  test('one bounce naming two recipients → two events, each its own provider_event_id, addresses lowercased', () => {
    const body = load('bounce-multi');
    const r = parse(body);
    expect(r.events.map((e) => [e.recipient, e.provider_event_id, e.diagnostic])).toEqual([
      ['a@example.com', `${body.id}:a@example.com`, 'smtp; 550 a'],
      ['b@example.com', `${body.id}:b@example.com`, 'smtp; 550 b'],
    ]);
  });
  test('missing tags → nulls, never a throw', () => {
    const body = load('complaint');
    delete body.detail.mail.tags;
    expect(parse(body).events[0].tags).toEqual({ campaign_id: null, result_id: null });
    body.detail.mail.tags = { campaign_id: 'x' };   // a bare string instead of an array
    expect(parse(body).events[0].tags).toEqual({ campaign_id: 'x', result_id: null });
  });
  test('a recipient that would push the id past 128 characters gets a sha256 suffix, stable and distinct', () => {
    const long = `${'x'.repeat(120)}@example.com`;
    const id = ses.eventIdFor('22222222-2222-2222-2222-222222222222', long);
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^22222222-2222-2222-2222-222222222222:sha256:[0-9a-f]{40}$/);
    expect(ses.eventIdFor('22222222-2222-2222-2222-222222222222', long)).toBe(id);
    expect(ses.eventIdFor('22222222-2222-2222-2222-222222222222', `y${long}`)).not.toBe(id);
  });
  test('a not-spam feedback report retracts a complaint: ignored, nothing produced', () => {
    const body = load('complaint');
    body.detail.complaint.complaintFeedbackType = 'not-spam';
    expect(parse(body)).toEqual({ events: [], ignored: 1, unknown_shape: 0, errors: [] });
  });
  test('an Undetermined bounce is soft (it never opts anyone out)', () => {
    const body = load('bounce-permanent');
    body.detail.bounce.bounceType = 'Undetermined';
    expect(parse(body).events[0].type).toBe('bounce_soft');
  });
});

describe('a malformed body → [] and a counted error, never a throw', () => {
  test.each([
    ['null', null], ['an array', []], ['a string', 'x'], ['another source', { source: 'aws.sns', id: 'e', detail: {} }],
    ['no id', { source: 'aws.ses', detail: { eventType: 'Delivery' } }], ['no detail', { source: 'aws.ses', id: 'e' }],
  ])('%s', (_n, body) => {
    const r = parse(body);
    expect(r.events).toEqual([]);
    expect(r.errors).toHaveLength(1);
  });
  test('a known type whose sub-object is missing, or an unknown eventType → unknown_shape, counted', () => {
    for (const [name, mut] of [['reject', (b) => { delete b.detail.reject; }], ['delivery-delay', (b) => { b.detail.deliveryDelay = 'x'; }],
      ['rendering-failure', (b) => { b.detail.eventType = 'RenderingFailure'; }], ['bounce-permanent', (b) => { b.detail.bounce.bouncedRecipients = []; }],
      ['delivery', (b) => { b.detail.eventType = 'Mystery'; }]]) {
      const b = load(name); mut(b);
      expect(parse(b)).toEqual({ events: [], ignored: 0, unknown_shape: 1, errors: [] });
    }
  });
  test('a getter that throws inside the body is caught', () => {
    const b = load('delivery');
    Object.defineProperty(b.detail, 'delivery', { get() { throw new Error('boom'); } });
    const r = parse(b);
    expect(r.events).toEqual([]);
    expect(r.errors[0]).toMatch(/parse failed: boom/);
  });
  test('verify is true (the hook\'s api_key auth is the check)', () => {
    expect(ses.events.verify({}, {})).toBe(true);
  });
});
