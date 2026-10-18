// tests/mySettings.test.js
//
/**
 * Settings arc, lane W4 — My Settings (public/settings.html) is PERSONAL
 * ONLY, and gains "My access" (read-only) and "Manage access" (grant editor
 * for a non-superuser's can_manage channels).
 *
 * HARNESS. The REAL page runs in jsdom as the top window (window.top ===
 * window, so the page's window.top.apiSend / firmData are this window's).
 * Its apiSend mirrors the shell's (index.html): GET / DELETE without a body,
 * JSON otherwise, a non-2xx throws Error(body.message || body.error). Behind
 * it:
 *   /api/mailboxes*, /api/phone-lines*  the REAL routers (routes/api.mailboxes.js,
 *       routes/api.phoneComms.js), the REAL services/mailboxService.js and
 *       lib/auth.jwtOrApiKey over HTTP on an ephemeral port; the database is
 *       tests/helpers/phoneSPHWorld.js (unknown statements THROW) plus the
 *       three listMailboxesFor statements below, matched by their exact text.
 *       So the URLs, methods and bodies the page sends are judged by the
 *       routes themselves (channel pin, validateGrantBody, manage scope), and
 *       the page reads the shapes the routes really return.
 *   the personal endpoints  a scripted fake shaped like routes/auth.profile.js,
 *       auth.password.js, api.mySignatures.js and api.users.js (untouched by
 *       this lane); anything unscripted is recorded and fails the test.
 *
 * Pinned: no call to the app-settings or contact-role-types APIs, ever, for
 * any persona; the removed firm sections are gone and the pointer is there;
 * profile / password / signature / booking calendars still work; My access
 * (grant rows, a role row, inactive channels, empty, the SU line, a load error
 * verbatim); Manage access visibility (SU no, can_manage grant yes, role-only
 * no, read-only grantee no) and its list / add / toggle / remove on a mailbox
 * and a phone line — exact URLs, methods and bodies — plus the guards (last
 * tick, remove confirm, own-Manage confirm) and server errors verbatim.
 *
 * Mutation-checked (see the W4 worker report).
 *
 * Run:  npx jest tests/mySettings.test.js
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'my-settings-test-secret';
delete process.env.SU_STEPUP; // step-up ON (the default)

const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM, VirtualConsole } = require('jsdom');
const mailboxesRouter = require('../routes/api.mailboxes');
const phoneRouter = require('../routes/api.phoneComms');
const { makeWorld } = require('./helpers/phoneSPHWorld');

const ROOT = path.join(__dirname, '..');
const SETTINGS_HTML = fs.readFileSync(path.join(ROOT, 'public/settings.html'), 'utf8');

const SS = 1; const SB = 5; const SU = 6; const NOBODY = 9; const RENA = 22;

// ── the world: phoneSPHWorld + mailboxes + GET /api/mailboxes ────────────────
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const PUB = "m.id, m.address, m.domain, m.display_name, m.color, m.active, (SELECT COUNT(*) FROM channel_grants cg WHERE cg.channel_type = 'mailbox' AND cg.channel_id = m.id) AS grant_count";
const MB_SU = "SELECT m.id, m.address, m.domain, m.display_name, m.color, m.imap_host, m.imap_port, m.imap_user, (m.imap_secret IS NOT NULL AND m.imap_secret <> '') AS has_secret, m.send_credential_id, ec.email AS send_credential_email, m.alias_of, m.alias_label, al.address AS alias_of_address, m.ingest_enabled, m.ingest_folders, m.ingest_state, m.active, m.emit_source_name, m.emit_id_kind, m.created_at, m.updated_at, (SELECT COUNT(*) FROM channel_grants cg WHERE cg.channel_type = 'mailbox' AND cg.channel_id = m.id) AS grant_count FROM mailboxes m LEFT JOIN email_credentials ec ON ec.id = m.send_credential_id LEFT JOIN mailboxes al ON al.id = m.alias_of ORDER BY m.address ASC";
const MB_ROLE = `SELECT ${PUB}, g.can_send, g.can_manage FROM mailboxes m LEFT JOIN channel_grants g ON g.channel_type = 'mailbox' AND g.channel_id = m.id AND g.user = ? ORDER BY m.address ASC`;
const MB_GRANTEE = `SELECT ${PUB}, g.can_read, g.can_send, g.can_manage FROM channel_grants g JOIN mailboxes m ON m.id = g.channel_id WHERE g.user = ? AND g.channel_type = 'mailbox' AND (g.can_read = 1 OR g.can_send = 1 OR g.can_manage = 1) ORDER BY m.address ASC`;

const MAILBOXES = [
  { id: 1, address: 'billing@4lsg.com', domain: '4lsg.com', display_name: 'Billing', color: '#1c7ed6', active: 1 },
  { id: 2, address: 'stuart@4lsg.com', domain: '4lsg.com', display_name: null, color: null, active: 1 },
  { id: 3, address: 'old@mdbl.com', domain: 'mdbl.com', display_name: 'Old box', color: null, active: 0 },
  { id: 4, address: 'shoshana@mdbl.com', domain: 'mdbl.com', display_name: 'Shoshana', color: '#e64980', active: 1 },
];

function world() {
  const W = makeWorld();
  W.T.mailboxes = MAILBOXES.map((b) => ({ ...b }));
  W.failMailboxList = null;
  /** A mailbox grant (W.grant writes phone_line rows; same id sequence). */
  W.mbGrant = (user, mailboxId, flags) => {
    const id = W.grant(user, mailboxId, flags);
    W.T.channel_grants.find((g) => g.id === id).channel_type = 'mailbox';
    return id;
  };
  W.grantRow = (id) => W.T.channel_grants.find((g) => g.id === id) || null;
  const inner = W.db.query;
  const count = (b) => W.T.channel_grants.filter((g) => g.channel_type === 'mailbox' && g.channel_id === b.id).length;
  const pub = (b) => ({ id: b.id, address: b.address, domain: b.domain, display_name: b.display_name, color: b.color, active: b.active, grant_count: count(b) });
  const byAddr = (a, b) => a.address.localeCompare(b.address);
  const grantOf = (user, b) => W.T.channel_grants.find((g) => g.channel_type === 'mailbox' && g.channel_id === b.id && g.user === Number(user));
  W.db = {
    async query(sqlIn, params = []) {
      const sql = norm(sqlIn);
      const p = params || [];
      if (sql === MB_SU || sql === MB_ROLE || sql === MB_GRANTEE) {
        W.statements.push({ sql, params: p });
        if (W.failMailboxList) throw new Error(W.failMailboxList);
        const boxes = [...W.T.mailboxes].sort(byAddr);
        if (sql === MB_SU) {
          return [boxes.map((b) => ({ ...pub(b), imap_host: 'imap.example', imap_port: 993, imap_user: b.address, has_secret: 1,
            send_credential_id: null, send_credential_email: null, alias_of: null, alias_label: null, alias_of_address: null,
            ingest_enabled: 0, ingest_folders: null, ingest_state: null, emit_source_name: null, emit_id_kind: null,
            created_at: null, updated_at: null }))];
        }
        if (sql === MB_ROLE) {
          return [boxes.map((b) => { const g = grantOf(p[0], b); return { ...pub(b), can_send: g ? g.can_send : null, can_manage: g ? g.can_manage : null }; })];
        }
        return [boxes.flatMap((b) => {
          const g = grantOf(p[0], b);
          if (!g || !(Number(g.can_read) || Number(g.can_send) || Number(g.can_manage))) return [];
          return [{ ...pub(b), can_read: g.can_read, can_send: g.can_send, can_manage: g.can_manage }];
        })];
      }
      return inner(sqlIn, params);
    },
  };
  return W;
}

// ── the real routers ───────────────────────────────────────────────────────
let W;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = W.db; next(); });
app.use(mailboxesRouter);
app.use(phoneRouter);
let server;
let base;
beforeAll(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

const tok = (user, roles = []) =>
  jwt.sign({ sub: String(user), username: 'u' + user, user_auth: 'authorized', roles, aud: 'staff' }, process.env.JWT_SECRET);

// firm-data's users list (ORDER BY user_name): every user, `active` boolean,
// user_type. Gone is disabled; Kiosk is not staff (user_type 0); Phantom is
// active staff the DB does not know (the server refuses a grant for them).
const FIRM_USERS = [
  { user: 0, user_name: 'Automations', user_type: 1, active: true },
  { user: 6, user_name: 'Fred', user_type: 1, active: true },
  { user: 30, user_name: 'Gone', user_type: 1, active: false },
  { user: 40, user_name: 'Kiosk', user_type: 0, active: true },
  { user: 9, user_name: 'Nobody', user_type: 1, active: true },
  { user: 31, user_name: 'Phantom', user_type: 1, active: true },
  { user: 22, user_name: 'Rena', user_type: 1, active: true },
  { user: 5, user_name: 'Shoshana', user_type: 1, active: true },
  { user: 1, user_name: 'Stuart', user_type: 1, active: true },
];
const ME = {
  [SS]: { user: SS, user_name: 'Stuart', user_fname: 'Stuart', user_lname: 'Sandweiss', username: 'Ssandweiss', email: 'stuart@4lsg.com', roles: 'staff,attorney' },
  [SB]: { user: SB, user_name: 'Shoshana', user_fname: 'Shoshana', user_lname: 'B', username: 'sb', email: 'sb@4lsg.com',
    phone: '2485550100', allow_sms: 1, task_remind_freq: 'Monday,Wednesday', default_email: 'billing@4lsg.com', default_phone: '2489654574', roles: 'staff' },
  [SU]: { user: SU, user_name: 'Fred', user_fname: 'Fred', user_lname: 'IT', username: 'IT', email: 'it@4lsg.com', roles: 'it,admin,su' },
  [NOBODY]: { user: NOBODY, user_name: 'Nobody', user_fname: 'No', user_lname: 'Body', username: 'nobody', email: 'n@4lsg.com', roles: 'staff' },
  [RENA]: { user: RENA, user_name: 'Rena', user_fname: 'Rena', user_lname: 'R', username: 'RENA', email: 'rena@4lsg.com', roles: 'staff' },
};

// ── the page ───────────────────────────────────────────────────────────────
const FORBIDDEN = /\/api\/(app-settings|contact-role-types)/;
const OPEN = [];
afterEach(() => {
  while (OPEN.length) {
    const t = OPEN.pop();
    // personal-only, whatever happened in the test
    expect(t.calls.filter((c) => FORBIDDEN.test(c.endpoint))).toEqual([]);
    expect(t.unscripted).toEqual([]);
    expect(t.errors).toEqual([]);
    t.w.close();
  }
  jest.restoreAllMocks();
});
beforeEach(() => {
  W = world();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

/**
 * Boot the real page as `me`. personal: overrides for the scripted personal
 * endpoints ({ signatures, defaultEmail, meRow, fail: { 'POST /api/auth/…': [status, message] } }).
 */
async function boot(me, { personal = {}, confirmAnswer = true } = {}) {
  const calls = [];
  const unscripted = [];
  const confirms = [];
  const errors = [];
  let inflight = 0;
  const P = {
    signatures: [], defaultEmail: null,
    meRow: { user: me, user_gcal_id: `cal-${me}@group.calendar.google.com`, freebusy_calendar_ids: JSON.stringify(['a@4lsg.com']) },
    fail: {},
    ...personal,
  };
  const err = (status, body) => {
    const e = new Error((body && (body.message || body.error)) || `HTTP ${status}`);
    e.name = 'ApiError'; e.status = status; e.body = body;
    return e;
  };
  async function http(endpoint, method, payload) {
    const r = await fetch(base + endpoint, {
      method,
      headers: { Authorization: `Bearer ${tok(me, me === SU ? ['su'] : [])}`, 'Content-Type': 'application/json' },
      body: payload == null ? undefined : JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!r.ok) throw err(r.status, data);
    return data;
  }
  function personalFake(endpoint, method, payload) {
    const key = `${method} ${endpoint}`;
    if (P.fail[key]) throw err(P.fail[key][0], { error: P.fail[key][1] });
    if (key === 'GET /api/me/signatures') return { status: 'success', signatures: P.signatures, default_email: P.defaultEmail };
    let m;
    if ((m = /^PUT \/api\/me\/signatures\/(\d+)$/.exec(key))) {
      const row = P.signatures.find((s) => s.id === Number(m[1]));
      if (!row) throw err(404, { status: 'error', message: 'Sender not found or not yours' });
      return { status: 'success', signature: { id: row.id, email: row.email, signature_html: payload.signature_html, signature_text: payload.signature_text } };
    }
    if (key === 'GET /api/users/me') return { status: 'success', user: P.meRow };
    if ((m = /^PATCH \/api\/users\/(\d+)\/freebusy-calendars$/.exec(key))) {
      const clean = [...new Set(payload.calendar_ids.map((x) => x.trim()).filter(Boolean))];
      return { status: 'success', user: Number(m[1]), freebusy_calendar_ids: clean };
    }
    if (key === 'POST /api/auth/update-profile') {
      return { status: 'success', message: 'Profile updated successfully',
        user: { ...ME[me], ...payload, user_name: payload.user_fname } };
    }
    if (key === 'POST /api/auth/change-password') return { status: 'success', message: 'Password changed successfully.' };
    unscripted.push(key);
    throw err(404, { status: 'error', message: 'unscripted: ' + key });
  }

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e && (e.stack || e.message || e))));
  const dom = new JSDOM(SETTINGS_HTML, {
    runScripts: 'dangerously',
    url: 'https://app.example/settings.html',
    virtualConsole: vc,
    beforeParse(w) {
      w.firmData = {
        currentUser: { ...ME[me] }, users: FIRM_USERS.map((u) => ({ ...u })),
        emailFrom: [{ id: 3, email: 'billing@4lsg.com', from_name: 'Billing' }],
        phoneLines: [{ id: 2, phone_number: '2489654574', display_name: 'Shoshana' }],
      };
      w.user = w.firmData.currentUser;
      w.confirm = (q) => { confirms.push(String(q)); return typeof confirmAnswer === 'function' ? confirmAnswer(q) : confirmAnswer; };
      w.apiSend = async (endpoint, method = 'GET', payload = null) => {
        method = String(method).toUpperCase();
        calls.push({ endpoint, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
        inflight++;
        try {
          return /^\/api\/(mailboxes|phone-lines)(\/|$)/.test(endpoint)
            ? await http(endpoint, method, payload)
            : personalFake(endpoint, method, payload);
        } finally { inflight--; }
      };
    },
  });
  const w = dom.window;
  const d = w.document;
  const t = { dom, w, d, calls, unscripted, confirms, errors, P };
  OPEN.push(t);
  /** Wait for every request to answer and the page to settle. */
  t.idle = async () => {
    for (let quiet = 0; quiet < 3;) {
      await new Promise((r) => setTimeout(r, 5));
      quiet = inflight === 0 ? quiet + 1 : 0;
    }
  };
  t.$ = (sel) => d.querySelector(sel);
  t.$$ = (sel) => [...d.querySelectorAll(sel)];
  t.text = (sel) => (d.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
  t.words = (el) => {
    const out = [];
    const walk = (n) => { if (n.nodeType === 3) { const v = n.nodeValue.replace(/\s+/g, ' ').trim(); if (v) out.push(v); } else n.childNodes.forEach(walk); };
    if (el) walk(el);
    return out.join(' ');
  };
  t.since = (n) => calls.slice(n).map((c) => `${c.method} ${c.endpoint}`);
  t.card = (key) => d.querySelector(`.mg-card[data-mg="${key}"]`);
  t.grantTr = (key, grantId) => t.card(key).querySelector(`tr[data-grant="${grantId}"]`);
  t.flagBox = (key, grantId, flag) => t.grantTr(key, grantId).querySelector(`input[data-mg-flag="${flag}"]`);
  t.tick = (input) => { input.checked = !input.checked; input.dispatchEvent(new w.Event('change', { bubbles: true })); };
  t.type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  t.maRows = (heading) => {
    const label = t.$$('#maBody .yc-flabel').find((x) => x.textContent === heading);
    const box = label && label.nextElementSibling;
    return box && box.querySelector('table')
      ? [...box.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => t.words(td)))
      : null;
  };
  await t.idle();
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('personal only', () => {
  test('the source names neither settings API and none of the firm editors; the pointer is there', () => {
    expect(SETTINGS_HTML).not.toMatch(FORBIDDEN);
    for (const gone of ['eventTypesSection', 'contactRolesSection', 'dropboxTplSection', 'dynSections', 'addSettingSection',
      'CATEGORY_ORDER', 'VALIDATORS', 'categoryBody', 'settingRow', 'crInit', 'etInit', 'dtInit', 'createSetting',
      'asCreate', 'etSave', 'dtSave', 'crAdd', 'Case Types moved', 'Custom Fields moved']) {
      expect(SETTINGS_HTML).not.toContain(gone);
    }
  });

  test.each([
    ['a superuser', SU], ['an attorney manager', SS], ['a mailbox manager', SB], ['a grantee', RENA], ['someone with nothing', NOBODY],
  ])('%s: the page boots on the personal reads and the two access reads only (+ grants it manages)', async (_label, me) => {
    W.mbGrant(SS, 2, { can_read: true, can_send: true, can_manage: true });
    W.mbGrant(SB, 4, { can_read: true, can_send: true, can_manage: true });
    W.mbGrant(RENA, 1, { can_read: true });
    const t = await boot(me);
    const grants = { [SS]: ['GET /api/mailboxes/2/grants'], [SB]: ['GET /api/mailboxes/4/grants'] }[me] || [];
    expect(t.since(0).sort()).toEqual(['GET /api/me/signatures', 'GET /api/users/me', 'GET /api/mailboxes', 'GET /api/phone-lines/readable', ...grants].sort());
    expect(t.$$('.sec-head h2').map((h) => h.textContent.replace('▸', '').trim()))
      .toEqual(['My Account', 'Change Password', 'Email Signature', 'My access', 'Manage access']);
    expect(t.$('#content').style.display).toBe('');
    expect(t.$('#loading').style.display).toBe('none');
  });

  test('one pointer to YisraCase Config, Theme and the launcher', async () => {
    const t = await boot(NOBODY);
    const p = t.text('#firmPointer');
    expect(p).toBe('Firm-wide settings live in YisraCase Config (More → YisraCase Config): the Firm tab for admins, the System tab for IT, the vocabulary tabs for everyone. Your colours: More → Theme. Your buttons: All → Customize my launcher.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('personal sections still work', () => {
  test('My Account: rendered from firmData; Save Profile posts the profile and updates the shell user', async () => {
    const t = await boot(SB);
    expect(t.$('#pFname').value).toBe('Shoshana');
    expect(t.$('#pDefaultEmail').value).toBe('billing@4lsg.com');
    expect(t.$('#pDefaultPhone').value).toBe('2489654574');
    expect(t.$$('#pDays input:checked').map((c) => c.value)).toEqual(['Monday', 'Wednesday']);
    t.$('#pFname').value = 'Shosh';
    t.$('#pPhone').value = '(248) 555-0199';
    const n = t.calls.length;
    t.$('#profileSave').click();
    await t.idle();
    expect(t.calls.slice(n)).toEqual([{ method: 'POST', endpoint: '/api/auth/update-profile', payload: {
      user_fname: 'Shosh', user_lname: 'B', username: 'sb', email: 'sb@4lsg.com', phone: '2485550199', allow_sms: 1,
      task_remind_freq: 'Monday,Wednesday', default_email: 'billing@4lsg.com', default_phone: '2489654574',
    } }]);
    expect(t.text('#profileStatus')).toBe('Profile updated');
    expect(t.w.firmData.currentUser.user_fname).toBe('Shosh');
  });

  test('My Account: a missing field never reaches the server; a server refusal shows its text', async () => {
    const t = await boot(SB, { personal: { fail: { 'POST /api/auth/update-profile': [409, 'That username is already taken'] } } });
    t.$('#pEmail').value = '';
    const n = t.calls.length;
    t.$('#profileSave').click();
    await t.idle();
    expect(t.calls.length).toBe(n);
    expect(t.text('#profileStatus')).toBe('Please fill all required fields');
    t.$('#pEmail').value = 'sb@4lsg.com';
    t.$('#profileSave').click();
    await t.idle();
    expect(t.text('#profileStatus')).toBe('That username is already taken');
  });

  test('Change Password: posts current + new; a mismatch stays local; the server error shows', async () => {
    const t = await boot(SB, { personal: {} });
    t.$('#pwCurrent').value = 'old1'; t.$('#pwNew').value = 'new12'; t.$('#pwConfirm').value = 'new13';
    let n = t.calls.length;
    t.$('#pwSave').click();
    await t.idle();
    expect(t.calls.length).toBe(n);
    expect(t.text('#pwStatus')).toBe('New passwords do not match');
    t.$('#pwConfirm').value = 'new12';
    n = t.calls.length;
    t.$('#pwSave').click();
    await t.idle();
    expect(t.calls.slice(n)).toEqual([{ method: 'POST', endpoint: '/api/auth/change-password', payload: { current_password: 'old1', new_password: 'new12' } }]);
    expect(t.text('#pwStatus')).toBe('Password changed');
    expect(t.$('#pwCurrent').value).toBe('');
    t.P.fail['POST /api/auth/change-password'] = [401, 'Current password is incorrect'];
    t.$('#pwCurrent').value = 'x'; t.$('#pwNew').value = 'abcd'; t.$('#pwConfirm').value = 'abcd';
    t.$('#pwSave').click();
    await t.idle();
    expect(t.text('#pwStatus')).toBe('Current password is incorrect');
  });

  test('Email Signature: the owned sender loads, edits PUT to its id, the preview follows the HTML', async () => {
    const t = await boot(SB, { personal: { signatures: [{ id: 12, email: 'sb@mdbl.com', from_name: 'Shoshana', signature_html: '<b>SB</b>', signature_text: 'SB' }] } });
    expect(t.$('#sigEditor').style.display).toBe('');
    expect(t.text('#sigHint')).toBe('sb@mdbl.com');
    expect(t.$('#sigHtml').value).toBe('<b>SB</b>');
    t.type(t.$('#sigHtml'), '<i>Shoshana</i>');
    expect(t.$('#sigPreview').srcdoc).toContain('<i>Shoshana</i>');
    t.$('#sigText').value = 'Shoshana';
    const n = t.calls.length;
    t.$('#sigSave').click();
    await t.idle();
    expect(t.calls.slice(n)).toEqual([{ method: 'PUT', endpoint: '/api/me/signatures/12', payload: { signature_html: '<i>Shoshana</i>', signature_text: 'Shoshana' } }]);
    expect(t.text('#sigStatus')).toBe('Signature saved');
  });

  test('Email Signature: no owned sender says so (and names the default sender)', async () => {
    const t = await boot(SB, { personal: { signatures: [], defaultEmail: 'billing@4lsg.com' } });
    expect(t.$('#sigEditor').style.display).toBe('none');
    expect(t.text('#sigEmpty')).toContain('Your default sender is billing@4lsg.com');
  });

  test('Booking Calendars: loads the list and the self calendar, saves through PATCH, shows the normalized list', async () => {
    const t = await boot(SB);
    expect(t.$('#fbCals').value).toBe('a@4lsg.com');
    expect(t.text('#fbSelfCal')).toBe('cal-5@group.calendar.google.com');
    t.$('#fbCals').value = ' b@4lsg.com \n\nb@4lsg.com\nc@4lsg.com';
    const n = t.calls.length;
    t.$('#fbSave').click();
    await t.idle();
    expect(t.calls.slice(n)).toEqual([{ method: 'PATCH', endpoint: '/api/users/5/freebusy-calendars', payload: { calendar_ids: ['b@4lsg.com', 'b@4lsg.com', 'c@4lsg.com'] } }]);
    expect(t.$('#fbCals').value).toBe('b@4lsg.com\nc@4lsg.com');
    expect(t.text('#fbStatus')).toBe('Saved');
  });

  test('the accordion: everything starts collapsed; opening one closes the others', async () => {
    const t = await boot(SB);
    const secs = t.$$('.section');
    expect(secs.every((s) => s.classList.contains('collapsed'))).toBe(true);
    secs[0].querySelector('.sec-head').click();
    expect(secs.map((s) => s.classList.contains('collapsed'))).toEqual([false, true, true, true, true]);
    t.$('#myAccessSection .sec-head').click();
    expect(secs.map((s) => s.classList.contains('collapsed'))).toEqual([true, true, true, false, true]);
    t.$('#myAccessSection .sec-head').click();
    expect(secs.every((s) => s.classList.contains('collapsed'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('My access', () => {
  test('a grantee: their mailboxes and lines with Read / Send / Manage; inactive ones marked; no role text', async () => {
    W.mbGrant(RENA, 1, { can_read: true, can_send: true });
    W.mbGrant(RENA, 3, { can_read: true });
    W.mbGrant(RENA, 2, { can_send: true });
    W.grant(RENA, 3, { can_read: true, can_send: true });
    W.grant(RENA, 7, { can_read: true });
    W.grant(RENA, 6, { can_send: true }); // send-only: /readable does not list it (route rule)
    const t = await boot(RENA);
    expect(t.maRows('Mailboxes')).toEqual([
      ['Billing billing@4lsg.com', '✓', '✓', '—'],
      ['Old box inactive old@mdbl.com', '✓', '—', '—'],
      ['stuart@4lsg.com', '—', '✓', '—'],
    ]);
    expect(t.maRows('Phone lines')).toEqual([
      ['Rena (248) 965-5355', '✓', '✓', '—'],
      ['retired inactive (248) 000-0007', '✓', '—', '—'],
    ]);
    expect(t.$$('#maBody .badge.off').map((b) => b.textContent)).toEqual(['inactive', 'inactive']);
    expect(t.text('#maBody')).not.toMatch(/via role/);
    expect(t.text('#maHint')).toBe('3 mailboxes · 2 phone lines');
    expect(t.$('#manageAccessSection').hidden).toBe(true);
  });

  test('an attorney: every channel reads "via role (attorney)" — not a grant; Send / Manage from their grant rows', async () => {
    W.mbGrant(SS, 2, { can_read: true, can_send: true });
    W.grant(SS, 1, { can_read: true, can_send: true });
    const t = await boot(SS);
    expect(t.maRows('Mailboxes')).toEqual([
      ['Billing billing@4lsg.com', 'via role (attorney)', '—', '—'],
      ['Old box inactive old@mdbl.com', 'via role (attorney)', '—', '—'],
      ['Shoshana shoshana@mdbl.com', 'via role (attorney)', '—', '—'],
      ['stuart@4lsg.com', 'via role (attorney)', '✓', '—'],
    ]);
    expect(t.maRows('Phone lines').map((r) => r[1])).toEqual(Array(6).fill('via role (attorney)'));
    expect(t.maRows('Phone lines').filter((r) => r[2] === '✓').map((r) => r[0])).toEqual(['Stuart (248) 559-2400']);
    expect(t.$$('#maBody .yc-hint').map((h) => h.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      '“via role”: your attorney role reads every one of these without a grant — it is not a grant; sending and managing still need one.',
      '“via role”: your attorney role reads every one of these without a grant — it is not a grant; sending and managing still need one.',
    ]);
    // role-only: no Manage access
    expect(t.$('#manageAccessSection').hidden).toBe(true);
  });

  test('a superuser: one line instead of tables, and no Manage access (Admin owns their grant edits)', async () => {
    const t = await boot(SU);
    expect(t.$('#maBody table')).toBe(null);
    expect(t.text('#maBody')).toBe('You are a superuser: you can read, send from and manage every mailbox and phone line without a grant. Grants are managed in Admin → Mailboxes and Admin → Connections → Phone Lines.');
    expect(t.text('#maHint')).toBe('superuser');
    expect(t.$('#manageAccessSection').hidden).toBe(true);
    expect(t.calls.filter((c) => /\/grants/.test(c.endpoint))).toEqual([]);
  });

  test('nothing shared: says so for both', async () => {
    const t = await boot(NOBODY);
    expect(t.maRows('Mailboxes')).toBe(null);
    expect(t.words(t.$('#maBody'))).toBe('Mailboxes No mailboxes are shared with you. Phone lines No phone lines are shared with you.');
    expect(t.text('#maHint')).toBe('0 mailboxes · 0 phone lines');
  });

  test('a failed read shows the server\'s message verbatim; the other table still renders', async () => {
    W.failMailboxList = 'mailbox store is down for maintenance';
    W.grant(RENA, 3, { can_read: true });
    const t = await boot(RENA);
    expect(t.text('#maBody .status.err')).toBe("Couldn't load your mailboxes: mailbox store is down for maintenance");
    expect(t.maRows('Phone lines')).toEqual([['Rena (248) 965-5355', '✓', '—', '—']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Manage access', () => {
  const box4 = () => {
    const mine = W.mbGrant(SB, 4, { can_read: true, can_send: true, can_manage: true });
    const rena = W.mbGrant(RENA, 4, { can_read: true });
    W.mbGrant(RENA, 1, { can_read: true }); // another box — never on this card
    return { mine, rena };
  };

  test('visibility: shown only to a non-superuser holding a can_manage GRANT', async () => {
    box4();
    W.mbGrant(SS, 2, { can_read: true });     // attorney without manage: role-only
    W.mbGrant(RENA, 3, { can_read: true });   // read-only grantee
    for (const [me, shown] of [[SU, false], [SS, false], [RENA, false], [NOBODY, false], [SB, true]]) {
      const t = await boot(me);
      expect([me, t.$('#manageAccessSection').hidden]).toEqual([me, !shown]);
      expect(t.$$('.mg-card').length).toBe(shown ? 1 : 0);
    }
  });

  test('a card per managed channel lists its grants (GET …/grants), with you, granted-by and the flags', async () => {
    const g = box4();
    const t = await boot(SB);
    expect(t.calls.filter((c) => /grants/.test(c.endpoint))).toEqual([{ method: 'GET', endpoint: '/api/mailboxes/4/grants', payload: null }]);
    expect(t.text('#mgHint')).toBe('1 channel');
    const card = t.card('mailbox:4');
    expect(t.words(card.querySelector('h3'))).toBe('Shoshana Mailbox · shoshana@mdbl.com');
    expect([...card.querySelectorAll('tbody tr')].map((tr) => tr.dataset.grant)).toEqual([String(g.rena), String(g.mine)]);
    expect(t.words(t.grantTr('mailbox:4', g.mine).querySelector('.name'))).toBe('Shoshana you granted by IT');
    const flags = (id) => ['can_read', 'can_send', 'can_manage'].map((f) => t.flagBox('mailbox:4', id, f).checked);
    expect(flags(g.mine)).toEqual([true, true, true]);
    expect(flags(g.rena)).toEqual([true, false, false]);
    // each tick's cell names its flag: the phone layout hides the header and shows these labels
    expect(['can_read', 'can_send', 'can_manage'].map((f) => t.flagBox('mailbox:4', g.mine, f).closest('td').dataset.label))
      .toEqual(['Read', 'Send', 'Manage']);
  });

  test('names are text, never markup: a hostile grantee name and granted-by username render inert', async () => {
    const g = box4();
    W.T.users.find((u) => u.user === RENA).user_name = '<img src=x onerror="window.__xss=1">Rena';
    W.T.users.find((u) => u.user === SU).username = '<b class="gb">IT</b>';
    const t = await boot(SB);
    const name = t.grantTr('mailbox:4', g.rena).querySelector('.name');
    expect(name.querySelector('img, b')).toBeNull();
    expect(t.words(name)).toBe('<img src=x onerror="window.__xss=1">Rena granted by <b class="gb">IT</b>');
  });

  test('the Add picker: active staff only, never automations, never someone already granted', async () => {
    box4();
    const t = await boot(SB);
    const opts = [...t.card('mailbox:4').querySelectorAll('select[data-mg-user] option')].map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([['6', 'Fred'], ['9', 'Nobody'], ['31', 'Phantom'], ['1', 'Stuart']]);
  });

  test('add: POST {user, can_read, can_send, can_manage} to the mailbox; the route stores it; the card re-reads', async () => {
    box4();
    const t = await boot(SB);
    const card = t.card('mailbox:4');
    card.querySelector('select[data-mg-user]').value = '9';
    card.querySelector('input[data-mg-new="can_send"]').checked = true;
    const n = t.calls.length;
    card.querySelector('button[data-mg-act="add"]').click();
    await t.idle();
    expect(t.calls.slice(n)).toEqual([
      { method: 'POST', endpoint: '/api/mailboxes/4/grants', payload: { user: 9, can_read: true, can_send: true, can_manage: false } },
      { method: 'GET', endpoint: '/api/mailboxes/4/grants', payload: null },
    ]);
    const row = W.T.channel_grants.find((x) => x.user === NOBODY);
    expect(row).toMatchObject({ channel_type: 'mailbox', channel_id: 4, can_read: 1, can_send: 1, can_manage: 0, granted_by: SB });
    expect(t.grantTr('mailbox:4', row.id)).not.toBe(null);
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('Access granted');
    expect([...t.card('mailbox:4').querySelectorAll('select[data-mg-user] option')].map((o) => o.value)).toEqual(['6', '31', '1']);
  });

  test('add: no box ticked stays local; a refusal shows the server\'s words', async () => {
    box4();
    const t = await boot(SB);
    let card = t.card('mailbox:4');
    card.querySelector('input[data-mg-new="can_read"]').checked = false;
    let n = t.calls.length;
    card.querySelector('button[data-mg-act="add"]').click();
    await t.idle();
    expect(t.calls.length).toBe(n);
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('Tick at least one of Read, Send, Manage.');
    card = t.card('mailbox:4');
    card.querySelector('input[data-mg-new="can_read"]').checked = true;
    card.querySelector('select[data-mg-user]').value = '31'; // active in firm-data, unknown to the DB
    n = t.calls.length;
    card.querySelector('button[data-mg-act="add"]').click();
    await t.idle();
    expect(t.since(n)).toEqual(['POST /api/mailboxes/4/grants']);
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('user 31 does not exist');
    expect(t.card('mailbox:4').querySelector('button[data-mg-act="add"]').disabled).toBe(false);
  });

  test('toggle: PATCH just the one flag; the route stores it', async () => {
    const g = box4();
    const t = await boot(SB);
    const n = t.calls.length;
    t.tick(t.flagBox('mailbox:4', g.rena, 'can_send'));
    await t.idle();
    expect(t.calls.slice(n)).toEqual([{ method: 'PATCH', endpoint: `/api/mailboxes/4/grants/${g.rena}`, payload: { can_send: true } }]);
    expect(W.grantRow(g.rena)).toMatchObject({ can_read: 1, can_send: 1, can_manage: 0 });
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('Access updated');
    expect(t.confirms).toEqual([]);
  });

  test('toggle: the last tick cannot go (no call); Remove is the way', async () => {
    const g = box4();
    const t = await boot(SB);
    const n = t.calls.length;
    const box = t.flagBox('mailbox:4', g.rena, 'can_read');
    t.tick(box);
    await t.idle();
    expect(t.calls.length).toBe(n);
    expect(box.checked).toBe(true);
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('A grant keeps at least one box ticked — use Remove to take access away.');
  });

  test('toggle: a refusal is shown verbatim and the box goes back (manage revoked behind the page)', async () => {
    const g = box4();
    const t = await boot(SB);
    W.grantRow(g.mine).can_manage = 0; // another manager / an SU took it away meanwhile
    const box = t.flagBox('mailbox:4', g.rena, 'can_manage');
    t.tick(box);
    await t.idle();
    expect(t.since(t.calls.length - 1)).toEqual([`PATCH /api/mailboxes/4/grants/${g.rena}`]);
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('Manage permission required on this mailbox');
    expect(W.grantRow(g.rena).can_manage).toBe(0);
  });

  test('remove: confirm names the person; yes → DELETE; no → nothing', async () => {
    const g = box4();
    const t = await boot(SB, { confirmAnswer: false });
    let n = t.calls.length;
    t.grantTr('mailbox:4', g.rena).querySelector('button[data-mg-act="remove"]').click();
    await t.idle();
    expect(t.confirms).toEqual(["Remove Rena's access to Shoshana?"]);
    expect(t.calls.length).toBe(n);
    expect(W.grantRow(g.rena)).not.toBe(null);
    t.w.confirm = () => true;
    n = t.calls.length;
    t.grantTr('mailbox:4', g.rena).querySelector('button[data-mg-act="remove"]').click();
    await t.idle();
    expect(t.calls.slice(n)).toEqual([
      { method: 'DELETE', endpoint: `/api/mailboxes/4/grants/${g.rena}`, payload: null },
      { method: 'GET', endpoint: '/api/mailboxes/4/grants', payload: null },
    ]);
    expect(W.grantRow(g.rena)).toBe(null);
    expect(t.grantTr('mailbox:4', g.rena)).toBe(null);
    expect(t.text('.mg-card[data-mg="mailbox:4"] [data-mg-msg]')).toBe('Access removed');
  });

  test('your own Manage: unticking asks first; yes → PATCH, then both sections redraw without the card', async () => {
    const g = box4();
    const t = await boot(SB, { confirmAnswer: false });
    let n = t.calls.length;
    const box = t.flagBox('mailbox:4', g.mine, 'can_manage');
    t.tick(box);
    await t.idle();
    expect(t.confirms).toEqual(["Stop managing Shoshana? You can't give Manage back to yourself — a superuser or another manager would have to."]);
    expect(t.calls.length).toBe(n);
    expect(box.checked).toBe(true);
    t.w.confirm = () => true;
    n = t.calls.length;
    t.tick(t.flagBox('mailbox:4', g.mine, 'can_manage'));
    await t.idle();
    expect(t.since(n)).toEqual(['PATCH /api/mailboxes/4/grants/' + g.mine, 'GET /api/mailboxes', 'GET /api/phone-lines/readable']);
    expect(t.calls[n].payload).toEqual({ can_manage: false });
    expect(t.$('#manageAccessSection').hidden).toBe(true);
    expect(t.$$('.mg-card')).toEqual([]);
    expect(t.maRows('Mailboxes')).toEqual([['Shoshana shoshana@mdbl.com', '✓', '✓', '—']]);
  });

  test('a phone line: the same card over /api/phone-lines/:id/grants — list, add, toggle, remove; the route pins phone_line', async () => {
    W.grant(RENA, 3, { can_read: true, can_send: true, can_manage: true });
    const other = W.grant(SB, 3, { can_read: true });
    const t = await boot(RENA);
    expect(t.$('#manageAccessSection').hidden).toBe(false);
    const key = 'phone_line:3';
    expect(t.words(t.card(key).querySelector('h3'))).toBe('Rena Phone line · (248) 965-5355');
    expect(t.calls.filter((c) => /grants/.test(c.endpoint))).toEqual([{ method: 'GET', endpoint: '/api/phone-lines/3/grants', payload: null }]);
    // add
    t.card(key).querySelector('select[data-mg-user]').value = '1';
    let n = t.calls.length;
    t.card(key).querySelector('button[data-mg-act="add"]').click();
    await t.idle();
    expect(t.calls[n]).toEqual({ method: 'POST', endpoint: '/api/phone-lines/3/grants', payload: { user: 1, can_read: true, can_send: false, can_manage: false } });
    const added = W.T.channel_grants.find((x) => x.user === SS);
    expect(added).toMatchObject({ channel_type: 'phone_line', channel_id: 3, can_read: 1, can_send: 0, can_manage: 0, granted_by: RENA });
    // toggle
    n = t.calls.length;
    t.tick(t.flagBox(key, other, 'can_send'));
    await t.idle();
    expect(t.calls.slice(n)).toEqual([{ method: 'PATCH', endpoint: `/api/phone-lines/3/grants/${other}`, payload: { can_send: true } }]);
    expect(W.grantRow(other)).toMatchObject({ can_read: 1, can_send: 1 });
    // remove
    n = t.calls.length;
    t.grantTr(key, added.id).querySelector('button[data-mg-act="remove"]').click();
    await t.idle();
    expect(t.confirms).toEqual(["Remove Stuart's access to Rena?"]);
    expect(t.calls.slice(n)[0]).toEqual({ method: 'DELETE', endpoint: `/api/phone-lines/3/grants/${added.id}`, payload: null });
    expect(W.grantRow(added.id)).toBe(null);
  });

  test('two managed channels: two cards, mailboxes first; an attorney\'s manage GRANT counts', async () => {
    W.mbGrant(SS, 2, { can_read: true, can_send: true, can_manage: true });
    W.mbGrant(SS, 1, { can_manage: true });
    const t = await boot(SS);
    expect(t.$('#manageAccessSection').hidden).toBe(false);
    expect(t.$$('.mg-card').map((c) => c.dataset.mg)).toEqual(['mailbox:1', 'mailbox:2']);
    expect(t.text('#mgHint')).toBe('2 channels');
    expect(t.calls.filter((c) => /grants/.test(c.endpoint)).map((c) => c.endpoint).sort())
      .toEqual(['/api/mailboxes/1/grants', '/api/mailboxes/2/grants']);
  });
});
