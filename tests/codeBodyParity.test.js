'use strict';
/**
 * tests/codeBodyParity.test.js
 *
 * PARITY HARNESS for the move of every code body (triggers, ingest rules,
 * suppressions, hooks) from the in-process engines to the QuickJS guest
 * engine in the sandbox child (lib/guestCode.js).
 *
 * The REFERENCE ORACLE below is the old engine, reproduced exactly as the
 * services ran it — node:vm with the envelope as `input` for triggers,
 * `new Function('input', code)` for the rest. It exists only here, as the
 * yardstick; production no longer has either path. Each fixture body runs
 * under both against every fixture input, and the results are compared
 * key-order-insensitively (keys sorted, Dates/undefined/non-finite tagged,
 * then stringified). Match bodies compare as truthiness, which is all a
 * match ever used.
 *
 * The fixture bodies are SYNTHETIC but built from the constructs the live
 * bodies use (inventoried 2026-10-26 across the 27 live bodies: string and
 * regex work, Date.parse of ISO and RFC 2822, toFixed/padStart, array and
 * object helpers, closures, console.warn, thrown errors, optional chaining).
 * Inputs are synthetic too: 555 numbers, example.com addresses — this repo is
 * public. The LIVE replay (every live body against its recorded inputs) is a
 * scratchpad script run before landing, never committed: those inputs are
 * client data.
 *
 * What is EXPECTED to differ, and is excluded by construction:
 *   - Intl / locale Date methods (QuickJS has no Intl, and its
 *     toLocaleString ignores timeZone) — the last test pins that this stays
 *     true, so a body relying on it is caught, not silently wrong;
 *   - the wording of engine-generated errors (V8 vs QuickJS TypeError text):
 *     an error stays an error, compared as such.
 */

const vm = require('vm');
const guestCode = require('../lib/guestCode');

jest.setTimeout(60000);

const canon = (v) => {
  if (v === undefined) return { $undef: 1 };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
  if (v === null || typeof v !== 'object') return v;
  if (Object.prototype.toString.call(v) === '[object Date]') return { $date: v.getTime() };
  if (Array.isArray(v)) return v.map(canon);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
  return out;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// The old engines, verbatim from the pre-move services.
function oracle(site, code, input) {
  try {
    if (site === 'trigger') {
      const ctx = vm.createContext(Object.create(null));
      ctx.input = input;
      return { ok: true, value: new vm.Script(`(function(input){ ${code} \n})(input)`).runInContext(ctx, { timeout: 5000 }) };
    }
    // eslint-disable-next-line no-new-func
    return { ok: true, value: new Function('input', code)(input) };
  } catch (err) {
    return { ok: false, message: err && err.message };
  }
}

const EMAILS = [
  { kind: 'email', source: 'gmail-firm', from: { email: 'ecf@example.uscourts.gov', name: 'Court' },
    to: [{ email: 'docs@example.com', name: '' }], cc: [], subject: 'Notice of Hearing 26-40001 (Jane Q. Example)',
    date: 'Mon, 26 Oct 2026 15:05:00 -0400', text: 'A hearing is set for 11/3/2026 at 10:00 AM.\nCase No. 26-40001-abc',
    headers: { message_id: '<m1@example.com>', list_id: null }, attachments: [{ filename: 'order.pdf', size: 20480, mime: 'application/pdf' }] },
  { kind: 'email', source: 'imap', mailbox: 'docs', from: { email: 'client@example.com', name: 'Émile Ünïcode' },
    to: [{ email: 'intake@example.com' }], subject: 'Re: my case — $1,234.50 payment', received_at: '2026-03-08T07:30:00Z',
    html: '<p>Paid <b>$1,234.50</b> today</p>', headers: { message_id: 'm2', in_reply_to: 'm1' }, attachments: [] },
  { kind: 'email', from: {}, to: [], subject: '', text: '', headers: {} },
];
const PHONES = [
  { type: 'sms', from: '+13135550100', to: '+12485550199', message: 'Call me back please', link_id: '3135550100', extra: { provider: 'quo', firmToFirm: false } },
  { type: 'call', from: '2485550199', to: '3135550101', data: { duration_seconds: 125, status: 'completed', direction: 'outbound' }, extra: { provider: 'ringcentral' } },
  { type: 'sms', from: '', to: null, message: null, extra: {} },
];
const ENVELOPES = [
  { event: 'appt.created', ts: '2026-10-26T12:00:00.000Z', depth: 0, chain: [], source: 'user', actor: 3, contact_id: 7,
    case_id: 'AbCd1234', data: { appt_date: '2026-11-03 10:00:00', appt_type: '341 Meeting', appt_length: 30 }, changes: null, extra: null },
  { event: 'case.stage_advanced', ts: '2026-01-02T00:00:00.000Z', depth: 1, chain: ['x'], contact_id: null, case_id: 'Zz9',
    data: { stage: 'filed', prior_stage: 'prep' }, changes: { stage: { from: 'prep', to: 'filed' } }, extra: { replayed_from: 4 } },
];
const HOOK_INPUTS = [
  { body: { type: 'message.received', data: { object: { from: '+13135550100', to: ['+12485550199', '+12485550198'], body: 'hi', createdAt: '2026-06-19T18:50:07.690Z' } } },
    headers: { 'content-type': 'application/json' }, query: {}, method: 'POST', meta: { slug: 'quo-message', source: 'http' } },
  { body: { uuid: 'abc', telephonySessionId: 's-1', parties: [{ direction: 'Inbound', from: { phoneNumber: '+13135550101' }, to: { phoneNumber: '+12485550199', extensionId: 12 }, status: { code: 'Answered' } }] },
    headers: {}, query: { validation: '1' }, method: 'POST', meta: { slug: 'rc', source: 'http' } },
  { body: {}, headers: {}, query: {}, method: 'POST', meta: {} },
];

// Bodies, by site. `inputs` names the fixture set.
const BODIES = [
  { site: 'email', slot: 'transform', inputs: EMAILS, code: `
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const from = input.from || {};
const who = (from.name ? from.name + ' <' + (from.email || '') + '>' : String(from.email || '')).trim();
const m = /(\\d{2})-(\\d{5})/.exec(String(input.subject || '') + ' ' + String(input.text || ''));
const docket = m ? m[1] + '-' + m[2] : null;
const files = (input.attachments || []).map((a) => ({ n: esc(a.filename), kb: (Number(a.size) / 1024).toFixed(1) }));
const d = new Date(input.date || input.received_at || '');
return { who, docket, files, subject: esc(input.subject), when: isNaN(d.getTime()) ? null : d.toISOString(), ms: isNaN(d.getTime()) ? null : d.getTime() };` },
  { site: 'email', slot: 'transform', inputs: EMAILS, code: `
const toList = [].concat(input.to || [], input.cc || []).map((t) => String((t && t.email) || '').toLowerCase()).filter(Boolean);
const money = String(input.subject || '').match(/\\$([\\d,]+(?:\\.\\d{2})?)/);
const amt = money ? parseFloat(money[1].replace(/,/g, '')) : null;
const words = String(input.text || input.html || '').replace(/<[^>]+>/g, ' ').split(/\\s+/).filter(Boolean);
return { toList, amt, fmt: amt == null ? '' : '$' + (amt % 1 === 0 ? String(Math.round(amt)) : amt.toFixed(2)),
  wc: words.length, first: words.at(0) || null, last: words.at(-1) || null, norm: String((input.from || {}).name || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''),
  pad: String(words.length).padStart(4, '0'), reply: !!(input.headers && input.headers.in_reply_to), kinds: Object.entries(input).filter(([k, v]) => typeof v === 'string').map(([k]) => k).sort() };` },
  { site: 'email', slot: 'match', inputs: EMAILS, code: `return /uscourts\\.gov$/i.test((input.from && input.from.email) || '') && /hearing/i.test(input.subject || '');` },
  { site: 'phone', slot: 'match', inputs: PHONES, code: `const n = String(input.from || '').replace(/\\D/g, '').slice(-10); return n.length === 10 && !(input.extra && input.extra.firmToFirm);` },
  { site: 'phone', slot: 'transform', inputs: PHONES, code: `
if (input.type !== 'call') throw new Error('not a call: ' + input.type);
const d = input.data || {};
const mins = Math.floor((d.duration_seconds || 0) / 60), secs = (d.duration_seconds || 0) % 60;
return { line: String(input.from).slice(-10), other: String(input.to).slice(-10), dur: mins + ':' + String(secs).padStart(2, '0'), status: d.status ?? 'unknown', dir: d.direction?.toUpperCase() };` },
  { site: 'trigger', slot: 'transform', inputs: ENVELOPES, code: `
const d = input.data || {};
const when = d.appt_date ? d.appt_date.replace(' ', 'T') : null;
return { contact_id: input.contact_id, case_id: input.case_id, title: [d.appt_type, when].filter(Boolean).join(' @ '),
  minutes: d.appt_length ?? null, changed: input.changes ? Object.keys(input.changes) : [], deep: (input.chain || []).length + input.depth };` },
  { site: 'trigger', slot: 'match', inputs: ENVELOPES, code: `return input.event === 'case.stage_advanced' && input.changes?.stage?.to === 'filed';` },
  { site: 'hook', slot: 'match', inputs: HOOK_INPUTS, code: `
const b = input.body || {};
const p = (b.parties || [])[0];
if (!p) return !!(b.type && b.data);
return p.direction === 'Inbound' && p.status && p.status.code === 'Answered';` },
  { site: 'hook', slot: 'transform', inputs: HOOK_INPUTS, code: `
const o = (input.body && input.body.data && input.body.data.object) || {};
const norm = (s) => { const d = String(s || '').replace(/\\D/g, ''); return d.length === 11 && d.charAt(0) === '1' ? d.slice(1) : d; };
const to = [].concat(o.to || []).flatMap((x) => String(x).split(/[,;\\s]+/)).map(norm).filter(Boolean);
const uniq = [...new Set(to)];
if (uniq.length > 1) console.warn('[fixture] group text with ' + uniq.length + ' recipients');
const t = Date.parse(o.createdAt || '');
return { from: norm(o.from), to: uniq[0] || '', recipients: uniq, ts: Number.isFinite(t) ? new Date(t).toISOString() : null,
  epoch: Number.isFinite(t) ? t : null, meta: input.meta?.slug ?? null, q: Object.fromEntries(Object.entries(input.query || {}).map(([k, v]) => [k, v + '!'])) };` },
  { site: 'hook', slot: 'transform', inputs: HOOK_INPUTS, code: `
const list = [5, 3, 9, 1].sort((a, b) => a - b);
const sum = list.reduce((a, b) => a + b, 0);
const s = JSON.stringify({ z: 1, a: [1, { b: 2 }] });
const json = JSON.parse(s);
return { list, sum, s, json, round: Math.round(2.5), fixed: (1.005).toFixed(2), exp: (1e21).toString(), big: Number.MAX_SAFE_INTEGER + 2,
  enc: encodeURIComponent('a b&c/é'), rep: 'a-b-c'.replaceAll('-', '+'), int: parseInt('08', 10), hex: (255).toString(16), nan: Number('x') };` },
];

describe.each(BODIES.map((b, i) => [`${b.site} ${b.slot} #${i}`, b]))('%s', (_label, b) => {
  test('old engine vs guest engine: identical for every fixture input', async () => {
    const truthy = b.slot === 'match';
    const news = await guestCode.runBodies(b.code, b.inputs.map((x) => JSON.parse(JSON.stringify(x))), { truthy, label: 'parity' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      b.inputs.forEach((input, i) => {
        const old = oracle(b.site, b.code, JSON.parse(JSON.stringify(input)));
        const neu = news[i];
        expect([i, neu.ok]).toEqual([i, old.ok]);
        if (old.ok) {
          const want = truthy ? !!old.value : old.value;
          if (!same(want, neu.value)) {
            throw new Error(`input #${i}: old ${JSON.stringify(canon(want))} != new ${JSON.stringify(canon(neu.value))}`);
          }
        } else if (/^not a call/.test(String(old.message))) {
          expect(neu.error.message).toBe(old.message);   // body-thrown messages cross verbatim
        }
      });
    } finally { warn.mockRestore(); }
  });
});

test('the harness can see a difference (a body whose engines disagree is flagged, not passed)', async () => {
  // Locale formatting with a timeZone: V8 honours it, the guest does not.
  const code = `return new Date(Date.UTC(2026, 0, 1, 12)).toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric' });`;
  const old = oracle('email', code, {});
  const [neu] = await guestCode.runBodies(code, [{}]);
  expect(old.ok && neu.ok).toBe(true);
  expect(same(old.value, neu.value)).toBe(false);
});

test('no Intl in the guest — a body must take firm-local dates another way', async () => {
  await expect(guestCode.runBody('return typeof Intl', {})).resolves.toBe('undefined');
});
