/**
 * tests/quoMessageTransform.test.js
 *
 * Hook 16 "quo-message" transform v3 — group texts (2026-10-15).
 *
 * The transform is DB-stored (hooks.transform_config), so its source of truth
 * in the repo is the console script that installs it:
 * ref/migrations/2026-10-15_hook16_quo_message_group_to.console.js. This file
 * reads V3_CODE out of that script BYTE FOR BYTE (a String.raw literal with no
 * substitutions, so the raw text IS the runtime value) and runs it through the
 * real engine, hookService.runTransform('code', …) — since 2026-10-26 the
 * QuickJS guest engine in the sandbox child (lib/guestCode.js), the engine
 * production runs it in. The bytes tested are the bytes the script PUTs.
 *
 * THE BUG: Quo sends a group text's `to` as ONE comma-joined string
 * ("+12485592400,+12489654574"). v2 norm10'd it whole, the comma vanished, and
 * the line became '1248559240012489654574' (phone_event_log 2293).
 *
 * Fixtures are synthetic: firm numbers are the firm's own published lines;
 * every client number is a 555 placeholder (public repo — never a real one).
 *
 * Run:
 *   npx jest tests/quoMessageTransform.test.js
 */
process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64');

const fs = require('fs');
const path = require('path');
const { runTransform } = require('../services/hookService');

const SCRIPT = path.join(__dirname, '..', 'ref', 'migrations',
  '2026-10-15_hook16_quo_message_group_to.console.js');

function loadV3() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const open = 'const V3_CODE = String.raw`';
  const a = src.indexOf(open);
  if (a === -1 || src.indexOf(open, a + 1) !== -1) throw new Error('expected exactly one V3_CODE literal');
  const start = a + open.length;
  const end = src.indexOf('`;', start);
  const code = src.slice(start, end);
  // The raw text equals the runtime value only while the literal has no
  // substitution and no escaped backtick.
  if (code.includes('${') || code.includes('`')) throw new Error('V3_CODE must stay a plain String.raw literal');
  return code;
}
const V3 = loadV3();

const RC_MAIN   = '2485592400';   // RingCentral (phone_lines 1)
const SHOSHANA  = '2489654574';   // Quo PNAkKuagWX (phone_lines 2)
const RENA      = '2489655355';   // Quo PNj4riXHPb (phone_lines 3)
const CLIENT_A  = '3135550123';
const CLIENT_B  = '3135550124';

function delivery(type, object) {
  return {
    body: {
      id: 'EVtest', type, object: 'event', apiVersion: 'v3',
      data: { object: { id: 'ACtest', object: 'message', body: 'hi', createdAt: '2026-06-19T18:50:07.690Z',
                        conversationId: 'CNtest', ...object } },
    },
    meta: { slug: 'quo-message', source: 'http' }, headers: {}, query: {}, method: 'POST',
  };
}
const incoming = (o) => delivery('message.received', o);
const outgoing = (o) => delivery('message.delivered', o);

async function run(input) {
  const r = await runTransform('code', { code: V3 }, input);
  expect(r.errors).toEqual([]);
  return r.output;
}

let warnSpy;
beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warnSpy.mockRestore(); });

describe('incoming group text — the line is the inbox the webhook fired for', () => {
  test('the live shape: comma-joined string, Quo inbox second → Shoshana, not the run-together digits', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: `+1${RC_MAIN},+1${SHOSHANA}`, phoneNumberId: 'PNAkKuagWX',
                             media: [{ url: 'https://storage.googleapis.com/opstatics/x', type: 'image/jpeg' }] }));
    expect(o.our_number).toBe(SHOSHANA);
    expect(o.to).toBe(SHOSHANA);
    expect(o.their_number).toBe(CLIENT_A);
    expect(o.from).toBe(CLIENT_A);
    expect(o.recipients).toEqual([RC_MAIN, SHOSHANA]);
    expect(o.attachments).toEqual([{ url: 'https://storage.googleapis.com/opstatics/x' }]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('separators: comma+space, semicolon, whitespace all split', async () => {
    for (const to of [`+1${RC_MAIN}, +1${SHOSHANA}`, `+1${RC_MAIN};+1${SHOSHANA}`, `+1${RC_MAIN} +1${SHOSHANA}`]) {
      const o = await run(incoming({ from: `+1${CLIENT_A}`, to, phoneNumberId: 'PNAkKuagWX' }));
      expect(o.recipients).toEqual([RC_MAIN, SHOSHANA]);
      expect(o.our_number).toBe(SHOSHANA);
    }
  });

  test('array of several recipients, the Quo inbox FIRST → still the inbox, by phoneNumberId', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: [`+1${RENA}`, `+1${RC_MAIN}`], phoneNumberId: 'PNj4riXHPb' }));
    expect(o.our_number).toBe(RENA);
    expect(o.recipients).toEqual([RENA, RC_MAIN]);
  });

  test('the inbox wins over list order: Rena\'s webhook for a list that starts with Shoshana', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: `+1${SHOSHANA},+1${RENA}`, phoneNumberId: 'PNj4riXHPb' }));
    expect(o.our_number).toBe(RENA);
    expect(o.to).toBe(RENA);
  });

  test('duplicates collapse, in first-seen order', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: [`+1${SHOSHANA}`, `${SHOSHANA},+1${RC_MAIN}`], phoneNumberId: 'PNAkKuagWX' }));
    expect(o.recipients).toEqual([SHOSHANA, RC_MAIN]);
  });

  test('unknown inbox + several recipients → first recipient, with a warning', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: `+1${RC_MAIN},+1${SHOSHANA}`, phoneNumberId: 'PNnewline' }));
    expect(o.our_number).toBe(RC_MAIN);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/PNnewline not in QUO_LINES/);
  });

  test('an inherited property name is not an inbox (own keys only)', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: `+1${SHOSHANA}`, phoneNumberId: 'constructor' }));
    expect(o.our_number).toBe(SHOSHANA);
  });
});

describe('one-recipient messages keep v2\'s output', () => {
  test('incoming single string, inbox known', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: `+1${SHOSHANA}`, phoneNumberId: 'PNAkKuagWX' }));
    expect(o).toEqual({
      provider: 'quo', direction: 'incoming', their_number: CLIENT_A, our_number: SHOSHANA, body: 'hi',
      attachments: [], from: CLIENT_A, to: SHOSHANA, recipients: [SHOSHANA],
      provider_message_id: 'ACtest', provider_event_id: 'EVtest', ts: '2026-06-19T18:50:07.690Z', conversation_id: 'CNtest',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('incoming one-element array, no phoneNumberId (Quo\'s documented sample shape) → to[0], no warning', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, to: [`+1${RC_MAIN}`] }));
    expect(o.our_number).toBe(RC_MAIN);
    expect(o.to).toBe(RC_MAIN);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('outgoing single → line is from, other party is the recipient', async () => {
    const o = await run(outgoing({ from: `+1${SHOSHANA}`, to: `+1${CLIENT_A}`, phoneNumberId: 'PNAkKuagWX' }));
    expect(o).toMatchObject({ direction: 'outgoing', our_number: SHOSHANA, from: SHOSHANA, their_number: CLIENT_A, to: CLIENT_A });
  });

  test('a recipient-less incoming message still takes its line from the inbox', async () => {
    const o = await run(incoming({ from: `+1${CLIENT_A}`, phoneNumberId: 'PNAkKuagWX' }));
    expect(o.our_number).toBe(SHOSHANA);
    expect(o.recipients).toEqual([]);
  });

  test('any other event type → {} (unchanged)', async () => {
    expect(await run(delivery('message.updated', { from: `+1${CLIENT_A}`, to: `+1${SHOSHANA}` }))).toEqual({});
  });
});

describe('outgoing group send', () => {
  test('two clients → threads under the FIRST client; the full list rides in recipients', async () => {
    const o = await run(outgoing({ from: `+1${SHOSHANA}`, to: `+1${CLIENT_A},+1${CLIENT_B}`, phoneNumberId: 'PNAkKuagWX' }));
    expect(o.our_number).toBe(SHOSHANA);
    expect(o.their_number).toBe(CLIENT_A);
    expect(o.to).toBe(CLIENT_A);
    expect(o.recipients).toEqual([CLIENT_A, CLIENT_B]);
  });

  test('the sending line listed among the recipients is skipped as the other party', async () => {
    const o = await run(outgoing({ from: `+1${SHOSHANA}`, to: [`+1${SHOSHANA}`, `+1${CLIENT_B}`], phoneNumberId: 'PNAkKuagWX' }));
    expect(o.their_number).toBe(CLIENT_B);
  });
});
