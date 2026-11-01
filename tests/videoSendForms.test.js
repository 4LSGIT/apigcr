// tests/videoSendForms.test.js
//
/**
 * Video links on the sending forms, where no server-side resolver runs: what
 * these pages do not fill reaches the client as text. Each form's real IRS and
 * 'other' action blocks are extracted and run against the real videoInsert.js
 * (the tests/sendingformBk.dbkqLink.test.js idiom: these pages are too heavy to
 * boot whole). Only the parent's apiSend and the send call are stubbed.
 *
 *   - Each recipient gets their OWN token, never the primary's: it is a bearer.
 *   - A failed lookup still sends, with an anonymous link.
 *   - Both placeholder forms are filled, and {{contacts.contact_id}} still is.
 *   - A message with no placeholder looks nothing up, so a plain send mints
 *     nothing.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

const TOKENS = { 11: 'tokenPrimary', 22: 'tokenSecondary' };
const RECIPIENTS = [
  { contact_id: 11, name: 'Pat', fname: 'Pat', phone: '5551110000', email: 'p@example.com' },
  { contact_id: 22, name: 'Sam', fname: 'Sam', phone: '5552220000', email: 's@example.com' },
];

function loadInsert(apiSend) {
  const win = { parent: { apiSend } };
  win.window = win;
  const { document } = new JSDOM('').window;
  const ctx = vm.createContext({ window: win, document, console: { warn() {}, error() {} }, encodeURIComponent });
  new vm.Script(read('js/videoInsert.js')).runInContext(ctx);
  return win.YisraVideoInsert;
}

/** The source between two anchors, run as the body of the action loop. */
async function runBlock(file, marker, from, to, { action, apiSend, mmsCapable = false }) {
  const src = read(file);
  const start = src.indexOf(from, src.indexOf(marker));
  expect(src.indexOf(marker)).toBeGreaterThan(-1);
  const end = src.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  const sends = [];
  const ctx = vm.createContext({
    action,
    recipients: RECIPIENTS,
    smsOn: true, emailOn: true, smsFrom: '2480000000', emailFrom: 'a@example.com',
    successes: [],
    withSig: (x) => x,
    optoutSend: async (url, _m, body) => { sends.push({ url, body }); },
    document: { getElementById: () => ({ selectedOptions: [{ dataset: { mmsCapable: mmsCapable ? '1' : '0' } }] }) },
    YisraVideoInsert: loadInsert(apiSend),
    encodeURIComponent,
    console: { warn() {} },
  });
  await new vm.Script(`(async () => {\n${src.slice(start, end)}\n})()`).runInContext(ctx);
  return sends;
}

const tokenApi = () => jest.fn(async (url) => {
  const id = url.match(/contacts\/(\d+)\/booking-link/)[1];
  return { token: TOKENS[id] };
});

describe.each([['sendingform-bk.html'], ['sendingform.html']])('%s, the other action', (file) => {
  const run = (action, apiSend) => runBlock(file, '// ── OTHER ──', "if (action.type === 'other') {", '} catch (err) { errors.push(`${action.type}', { action, apiSend });
  const smsAction = (text) => ({ type: 'other', mode: 'sms', sms_text: text });

  test.each([
    ['the picker form', '{{contacts.contact_token|default:}}'],
    ['the bare form', '{{contacts.contact_token}}'],
  ])('%s becomes each recipient\'s own token', async (_n, placeholder) => {
    const sends = await run(smsAction(`Watch: https://4lsg.com/v/x?ct=${placeholder}`), tokenApi());
    expect(sends.map((s) => s.body.message)).toEqual([
      'Watch: https://4lsg.com/v/x?ct=tokenPrimary',
      'Watch: https://4lsg.com/v/x?ct=tokenSecondary',
    ]);
  });

  test('email html and text are both filled', async () => {
    const link = 'https://4lsg.com/v/x?ct={{contacts.contact_token|default:}}';
    const sends = await run({ type: 'other', mode: 'email', email_html: `<a href="${link}">x</a>`, email_text: link }, tokenApi());
    expect(sends[1].body.html).toBe('<a href="https://4lsg.com/v/x?ct=tokenSecondary">x</a>');
    expect(sends[1].body.text).toBe('https://4lsg.com/v/x?ct=tokenSecondary');
  });

  test('a failed lookup still sends, with no placeholder left', async () => {
    const api = jest.fn(async () => { throw new Error('down'); });
    const sends = await run(smsAction('https://4lsg.com/v/x?ct={{contacts.contact_token|default:}}'), api);
    expect(sends.map((s) => s.body.message)).toEqual(['https://4lsg.com/v/x?ct=', 'https://4lsg.com/v/x?ct=']);
  });

  test('every placeholder in a message is filled', async () => {
    const link = 'v/x?ct={{contacts.contact_token|default:}}';
    const sends = await run(smsAction(`${link} and ${link}`), tokenApi());
    expect(sends[0].body.message).toBe('v/x?ct=tokenPrimary and v/x?ct=tokenPrimary');
  });

  test('{{contacts.contact_id}} is still filled', async () => {
    const sends = await run(smsAction('id {{contacts.contact_id}}'), tokenApi());
    expect(sends.map((s) => s.body.message)).toEqual(['id 11', 'id 22']);
  });

  test('a message with no placeholder looks nothing up', async () => {
    const api = tokenApi();
    await run(smsAction('just text'), api);
    expect(api).not.toHaveBeenCalled();
  });
});

describe('sendingform-bk.html, the IRS action', () => {
  const run = (apiSend, mmsCapable) => runBlock('sendingform-bk.html', "// NOTE: irsGif/landing slug are hardcoded", "if (action.type === 'irs_idme') {", '// ── DOCS NEEDED ──', {
    action: { type: 'irs_idme' }, apiSend, mmsCapable,
  });
  const bodies = (sends) => sends.map((s) => JSON.stringify(s.body));

  test('every channel carries that recipient\'s own token, never the id', async () => {
    const sends = await run(tokenApi(), false);
    const pat = bodies(sends).filter((b) => b.includes('5551110000') || b.includes('p@example.com'));
    const sam = bodies(sends).filter((b) => b.includes('5552220000') || b.includes('s@example.com'));
    expect(pat.length).toBe(2);
    expect(sam.length).toBe(2);
    for (const b of pat) { expect(b).toContain('get-irs-transcripts?ct=tokenPrimary'); expect(b).not.toContain('tokenSecondary'); }
    for (const b of sam) { expect(b).toContain('get-irs-transcripts?ct=tokenSecondary'); expect(b).not.toContain('tokenPrimary'); }
    expect(bodies(sends).join()).not.toMatch(/\?c=|ct=(11|22)\b/);
  });

  test('MMS carries it too', async () => {
    const sends = await run(tokenApi(), true);
    expect(sends.find((s) => s.url === '/internal/mms/send').body.text).toContain('?ct=tokenPrimary');
  });

  test('a failed lookup still sends, with a bare link', async () => {
    const sends = await run(jest.fn(async () => { throw new Error('down'); }), false);
    expect(sends).toHaveLength(4);
    expect(bodies(sends).join()).toContain('get-irs-transcripts\\n');
    expect(bodies(sends).join()).not.toMatch(/\?ct=|\?c=/);
  });
});

describe.each([['sendingform-bk.html'], ['sendingform.html']])('%s loads the helper it needs', (file) => {
  test('videoInsert.js is on the page', () => {
    expect(read(file)).toContain('<script src="/js/videoInsert.js"></script>');
  });
});

describe('finishing a pick for one contact (communicate.html, no resolver)', () => {
  const video = { slug: 'x', gcs_poster_url: 'https://p/p.jpg' };

  test('a token goes into the link', async () => {
    const insert = loadInsert(tokenApi());
    expect(await insert.finishPick('sms-plain', video, 11)).toMatchObject({ text: 'https://4lsg.com/v/x?ct=tokenPrimary' });
  });

  test('a failed lookup gives the bare link, never a placeholder', async () => {
    const insert = loadInsert(jest.fn(async () => { throw new Error('down'); }));
    expect(await insert.finishPick('sms-plain', video, 11)).toMatchObject({ text: 'https://4lsg.com/v/x' });
  });

  test('the email form is bare too', async () => {
    const insert = loadInsert(jest.fn(async () => { throw new Error('down'); }));
    const out = await insert.finishPick('email-text', { ...video, title: 'T' }, 11);
    expect(out.html).toContain('https://4lsg.com/v/x"');
    expect(out.html).not.toContain('{{');
  });

  test('campaign mode keeps the placeholder for the resolver', async () => {
    const api = jest.fn();
    const out = await loadInsert(api).finishPick('sms-plain', video, null);
    expect(out.text).toBe('https://4lsg.com/v/x?ct={{contacts.contact_token|default:}}');
    expect(api).not.toHaveBeenCalled();
  });
});

describe('videoInsert buildUrl', () => {
  const { buildUrl } = loadInsert(jest.fn());

  test('a token goes in', () => {
    expect(buildUrl('x', 'tok')).toBe('https://4lsg.com/v/x?ct=tok');
  });

  test('campaign mode keeps the placeholder for the resolver', () => {
    expect(buildUrl('x', null)).toBe('https://4lsg.com/v/x?ct={{contacts.contact_token|default:}}');
  });

  test('a failed lookup is anonymous, because that send runs no resolver', () => {
    expect(buildUrl('x', '')).toBe('https://4lsg.com/v/x');
  });
});

describe('resolveContactToken', () => {
  test('no contact looks nothing up', async () => {
    const api = jest.fn();
    expect(await loadInsert(api).resolveContactToken(null)).toBeNull();
    expect(api).not.toHaveBeenCalled();
  });

  test('a failure is the empty string', async () => {
    const api = jest.fn(async () => { throw new Error('down'); });
    expect(await loadInsert(api).resolveContactToken(11)).toBe('');
  });

  test('a failure is not remembered: the next send tries again', async () => {
    const api = jest.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ token: 'tokenLater' });
    const insert = loadInsert(api);
    expect(await insert.resolveContactToken(11)).toBe('');
    expect(await insert.resolveContactToken(11)).toBe('tokenLater');
  });

  test('a token is remembered', async () => {
    const api = tokenApi();
    const insert = loadInsert(api);
    await insert.resolveContactToken(11);
    await insert.resolveContactToken(11);
    expect(api).toHaveBeenCalledTimes(1);
  });
});
