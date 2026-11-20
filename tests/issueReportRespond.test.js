// tests/issueReportRespond.test.js
//
/**
 * Support Inbox replies — the parts that need no MySQL (the SQL is pinned by
 * tests/issueReportRespond.mysql.test.js on a real engine).
 *
 *   1. services/issueReportService.js: the outcome table and the reply email.
 *   2. routes/api.issueReports.js: the IT notification's deep-link buttons,
 *      whose rests the shell must keep (real ycSubTab), and the respond gate.
 *   3. public/issueReports.html: the deep link opens the dialog preselected;
 *      Send posts what the dialog shows; the client-side refusals.
 *
 * Only emailService is mocked (it is not the module under test; loading it
 * needs CREDENTIALS_ENCRYPTION_KEY).
 */
'use strict';

process.env.IT_EMAIL = 'it@4lsg.com';
process.env.APP_URL = 'https://app.4lsg.com';

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn() }));

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');
const emailService = require('../services/emailService');
const S = require('../services/issueReportService');

const ROOT = path.join(__dirname, '..');
const flush = () => new Promise((r) => setTimeout(r, 0));

function loadYcSubTab() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/ycSubTab.js'), 'utf8'), ctx);
  return ctx.window.ycSubTab;
}

// ── 1. the service's pure parts ──────────────────────────────────────────────

describe('issueReportService — outcomes and the reply email', () => {
  test('every report kind has outcomes; keys fit the column and are unique per kind', () => {
    expect(Object.keys(S.OUTCOMES).sort()).toEqual(['idea', 'problem', 'question']);   // = api.issueReports VALID_KINDS
    for (const [kind, outs] of Object.entries(S.OUTCOMES)) {
      const keys = outs.map((o) => o.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const o of outs) {
        expect(o.key).toMatch(/^[a-z_]{1,24}$/);                     // issue_reports.resolution varchar(24)
        // a message-only outcome has no generic text; every other one says something
        if (o.needsMessage) expect(o.text).toBe('');
        else expect(o.text.length).toBeGreaterThan(20);
      }
      expect(S.outcomesFor(kind).map((o) => o.key)).toEqual(keys);
    }
    expect(S.OUTCOMES.question.map((o) => o.key)).toEqual(['answered']);
    expect(S.OUTCOMES.question[0].needsMessage).toBe(true);
    for (const k of ['problem', 'idea']) {
      expect(S.OUTCOMES[k].map((o) => o.key)).toEqual(expect.arrayContaining(['already_done', 'other']));
    }
    expect(S.outcomesFor('nope')).toEqual([]);
  });

  test('the reply: greeting, generic text, message, the note quoted back — HTML escaped', () => {
    const outcome = S.findOutcome('problem', 'fixed');
    const { subject, html, text } = S.buildReplyEmail({
      id: 14, kind: 'problem', note: 'button <img src=x onerror=alert(1)>\nbroke', createdAt: '2026-11-20T03:00:00Z',
      outcome, message: 'It was <b>the</b> filter\nnow fixed', firstName: 'Shoshana',
    });
    expect(subject).toBe('Re: your problem report #14 — Fixed');
    expect(html).not.toMatch(/<img|<b>/);
    expect(html).toContain('button &lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('It was &lt;b&gt;the&lt;/b&gt; filter<br>now fixed');
    expect(html).toContain('Your problem report #14 from Nov 19, 2026:');   // firm-local: 03:00Z is the 19th in Detroit
    expect(text).toBe([
      'Hi Shoshana,', '', outcome.text, '', 'It was <b>the</b> filter\nnow fixed', '',
      'Your problem report #14 from Nov 19, 2026:', '> button <img src=x onerror=alert(1)>', '> broke', '',
      'Sent from the YisraCase Support Inbox. Reply to this email to answer.',
    ].join('\n'));
  });

  test('a message-only outcome sends just the message; no first name reads "Hi,"', () => {
    const { text, subject } = S.buildReplyEmail({
      id: 3, kind: 'question', note: 'how?', createdAt: null,
      outcome: S.findOutcome('question', 'answered'), message: 'Like this.', firstName: null,
    });
    expect(subject).toBe('Re: your question #3 — Answered');
    expect(text).toBe('Hi,\n\nLike this.\n\nYour question #3:\n> how?\n\nSent from the YisraCase Support Inbox. Reply to this email to answer.');
  });
});

describe('issueReportService.respond — a reply that went out is never reported as failed', () => {
  beforeEach(() => { emailService.sendEmail.mockReset(); emailService.sendEmail.mockResolvedValue({}); });
  // Scripted db: the row read, the claim, the settle, then the read-back throws.
  // The SQL itself is pinned on a real engine (issueReportRespond.mysql.test.js).
  const db = { query: jest.fn(async (sql) => {
    const s = String(sql);
    if (/FROM issue_reports r/.test(s)) return [[{ id: 9, kind: 'problem', note: 'n', user_id: 5, created_at: null, user_email: 'a@example.test', user_fname: 'A' }], []];
    if (/^\s*UPDATE/.test(s)) return [{ affectedRows: 1 }, []];
    if (/SELECT resolved_at/.test(s)) throw new Error('connection lost');
    throw new Error('unexpected ' + s);
  }) };
  test.each([[true], [false]])('the status read-back throws (resolve %s) → still ok:true, resolved = what was asked', async (resolve) => {
    const out = await S.respond(db, { id: 9, outcome: 'fixed', resolve, by: 'IT' });
    expect(out).toEqual({ ok: true, resolved: resolve, to: 'a@example.test' });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });
});

// ── 2. the route ─────────────────────────────────────────────────────────────

describe('api.issueReports — the notification buttons and the respond gate', () => {
  const OLD = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = 'support-reply-unit-secret'; });
  afterAll(() => { process.env.JWT_SECRET = OLD; });
  beforeEach(() => { emailService.sendEmail.mockReset(); emailService.sendEmail.mockResolvedValue({}); });

  function appWith(userRow) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.db = { query: async (sql) => {
        const s = String(sql);
        if (/SELECT user_name, email FROM users/.test(s)) return [[userRow].filter(Boolean), []];
        if (/INSERT INTO issue_reports/.test(s)) return [{ insertId: 41 }, []];
        return [{ affectedRows: 1 }, []];
      } };
      next();
    });
    app.use(require('../routes/api.issueReports'));
    return app;
  }
  const token = (roles) => jwt.sign({ sub: 6, username: 'IT', user_type: 1, aud: 'staff', user_auth: 'authorized', roles },
    process.env.JWT_SECRET, { expiresIn: '5m' });
  function call(app, method, url, body, roles = ['staff']) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(app).listen(0, async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token(roles) },
            body: body ? JSON.stringify(body) : undefined });
          resolve({ status: res.status, body: await res.json() });
        } catch (e) { reject(e); } finally { srv.close(); }
      });
    });
  }
  const sentMail = () => emailService.sendEmail.mock.calls[0][1];
  const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1].replace(/&amp;/g, '&')]);

  test.each([
    ['problem', ['fixed', 'cant_reproduce', 'by_design', 'already_done', 'other']],
    ['idea', ['done', 'planned', 'already_done', 'wont_do', 'other']],
    ['question', ['answered']],
  ])('a %s report: one reply button per outcome, each into the Support Inbox, then "Open"', async (kind, keys) => {
    const r = await call(appWith({ user_name: 'Shoshana', email: 's@example.test' }), 'POST', '/api/issue-reports', { note: 'hi', kind });
    expect(r).toMatchObject({ status: 201, body: { id: 41, emailed: true } });
    const links = hrefs(sentMail().html);
    const base = 'https://app.4lsg.com/?open=tabPanel~adminSupportInbox~r41';
    expect(links).toEqual([
      ...keys.map((k) => [`Reply: ${S.findOutcome(kind, k).label.replace(/'/g, "'")}`, `${base}~${k}`]),
      ['Open in Support Inbox', base],
    ]);
    expect(sentMail().text).toContain(`Respond: ${base}\n`);
  });

  test('a filer with no email gets no reply buttons — the email says why', async () => {
    await call(appWith({ user_name: 'Nomail', email: null }), 'POST', '/api/issue-reports', { note: 'hi', kind: 'problem' });
    const { html } = sentMail();
    expect(hrefs(html).map((l) => l[0])).toEqual(['Open in Support Inbox']);
    expect(html).toContain('The filer has no email address on file');
  });

  test("every button's rest is one the shell keeps as-is (ycSubTab), for any id", () => {
    const ycSubTab = loadYcSubTab();
    for (const kind of Object.keys(S.OUTCOMES)) {
      for (const o of S.outcomesFor(kind)) {
        const rest = `adminSupportInbox~r999999999999~${o.key}`;
        expect(ycSubTab.normalize(rest)).toBe(rest);
      }
    }
  });

  test('respond is SU-only and maps the service refusals to their status', async () => {
    const app = appWith(null);
    expect((await call(app, 'POST', '/api/issue-reports/5/respond', { outcome: 'fixed' }, ['staff'])).status).toBe(403);
    expect(await call(app, 'POST', '/api/issue-reports/abc/respond', { outcome: 'fixed' }, ['su']))
      .toEqual({ status: 400, body: { error: 'bad id' } });
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});

// ── 3. the pane ──────────────────────────────────────────────────────────────

function bootPane({ held = null, full = {}, respond = { ok: true, resolved: true, to: 's@example.test' }, replyTo = 's@example.test' } = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'public/issueReports.html'), 'utf8');
  // jsdom loads no external script: inline the two the page needs at load.
  for (const f of ['ycPager.js', 'ycSubTab.js']) {
    const tag = `<script src="/js/${f}"></script>`;
    expect(html.split(tag)).toHaveLength(2);
    html = html.replace(tag, () => `<script>${fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')}</script>`);
  }
  const sent = [], reported = [];
  const row = { id: 14, user_id: 5, user_name: 'Shoshana', kind: 'problem', note: 'export <b>broke</b>',
    page_url: null, emailed_at: '2026-11-20T10:00:00Z', email_error: null, resolved_at: null, resolved_by: null,
    resolution: null, replied_at: null, reply_error: null, created_at: '2026-11-20T09:00:00Z', ...full };
  const host = {
    firmData: { currentUser: { roles: 'staff,su' } },
    ycTakeSubTab: () => held,
    ycReportSubTab: (_f, r) => reported.push(r),
    apiSend: async (url, method, body) => {
      sent.push({ url, method, body });
      if (method === 'GET' && url.startsWith('/api/issue-reports?')) {
        return { rows: [row], total: 1, limit: 50, offset: 0,
          counts: { open_total: 1, open_problem: 1, open_idea: 0, open_question: 0, resolved_7d: 0, never_emailed: 0 } };
      }
      if (method === 'GET' && /^\/api\/issue-reports\/\d+$/.test(url)) {
        return { row: { ...row, context: null }, reply_to: replyTo, outcomes: S.outcomesFor(row.kind) };
      }
      if (method === 'POST' && /\/respond$/.test(url)) return typeof respond === 'function' ? respond() : respond;
      return {};
    },
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(w) {
      Object.defineProperty(w, 'parent', { value: host, configurable: true });
      Object.defineProperty(w, 'frameElement', { value: {}, configurable: true });
      w.HTMLElement.prototype.focus = function () {};
    },
  });
  return { w: dom.window, d: dom.window.document, sent, reported };
}
async function settle() { for (let i = 0; i < 6; i++) await flush(); }
const checked = (d) => (d.querySelector('#rdOuts input:checked') || {}).value;

describe('issueReports.html — Respond to sender', () => {
  test('the email link (r<id>~<outcome>) opens the dialog preselected, shows every status, and clears the rest', async () => {
    const { d, sent, reported } = bootPane({ held: 'r14~cant_reproduce' });
    await settle();
    expect(d.getElementById('rdBack')).not.toBeNull();
    expect(checked(d)).toBe('cant_reproduce');
    expect(d.getElementById('rdGeneric').textContent).toBe(S.findOutcome('problem', 'cant_reproduce').text);
    expect(d.querySelector('.rd-sub').textContent).toContain('to s@example.test');
    expect(d.querySelector('.rd-note').innerHTML).toBe('export &lt;b&gt;broke&lt;/b&gt;');
    expect(d.getElementById('fStatus').value).toBe('all');
    expect(sent.find((s) => s.url.startsWith('/api/issue-reports?')).url).toContain('status=all');
    expect(reported).toEqual(['']);
    expect(d.querySelector('tr.detail')).not.toBeNull();   // expanded behind the dialog
  });

  test('Send posts the outcome, the trimmed message and resolve; the dialog closes and the list reloads', async () => {
    const { d, sent } = bootPane({ held: 'r14~fixed' });
    await settle();
    d.getElementById('rdMsg').value = '  It was the date filter.  ';
    const lists = sent.filter((s) => s.url.startsWith('/api/issue-reports?')).length;
    d.getElementById('rdSend').click();
    await settle();
    expect(sent.filter((s) => s.method === 'POST')).toEqual([{ url: '/api/issue-reports/14/respond', method: 'POST',
      body: { outcome: 'fixed', message: 'It was the date filter.', resolve: true } }]);
    expect(d.getElementById('rdBack')).toBeNull();
    expect(d.getElementById('statusBar').textContent).toContain('reply sent to s@example.test · resolved');
    expect(sent.filter((s) => s.url.startsWith('/api/issue-reports?')).length).toBe(lists + 1);
  });

  test('changing the outcome changes the preview; "Other" without a message is refused before any POST', async () => {
    const { d, sent } = bootPane({ held: 'r14' });
    await settle();
    expect(checked(d)).toBe('fixed');                      // no outcome in the link → the first
    const other = d.querySelector('#rdOuts input[value="other"]');
    other.checked = true;
    other.dispatchEvent(new d.defaultView.Event('change'));
    expect(d.getElementById('rdMsgLbl').textContent).toBe('Message (required)');
    expect(d.getElementById('rdGeneric').textContent).toMatch(/your message is the reply/);
    d.getElementById('rdSend').click();
    await settle();
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
    expect(d.getElementById('rdStatus').textContent).toBe('"Other" needs a message.');
  });

  test('a reply that did not go out keeps the dialog open, says so, and lets you retry', async () => {
    const { d } = bootPane({ held: 'r14~fixed', respond: { ok: false, resolved: false, reply_error: 'Gmail said no' } });
    await settle();
    d.getElementById('rdSend').click();
    await settle();
    expect(d.getElementById('rdBack')).not.toBeNull();
    expect(d.getElementById('rdStatus').textContent).toBe('The reply did NOT go out: Gmail said no. Nothing else changed — the report is open.');
    expect(d.getElementById('rdSend').disabled).toBe(false);
  });

  test('while a send is in flight the dialog cannot be closed (Cancel, backdrop, Escape); it can again after', async () => {
    let finish;
    const { d, w } = bootPane({ held: 'r14~fixed', respond: () => new Promise((r) => { finish = r; }) });
    await settle();
    d.getElementById('rdSend').click();
    await settle();
    expect(d.getElementById('rdCancel').disabled).toBe(true);
    d.getElementById('rdCancel').click();
    d.getElementById('rdBack').click();
    d.querySelector('.rd').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(d.getElementById('rdBack')).not.toBeNull();
    finish({ ok: false, resolved: false, reply_error: 'x' });
    await settle();
    expect(d.getElementById('rdCancel').disabled).toBe(false);
    d.getElementById('rdCancel').click();
    expect(d.getElementById('rdBack')).toBeNull();
  });

  test('a failed last attempt shows ↩✗ even after an earlier reply went out', async () => {
    const { d } = bootPane({ full: { replied_at: '2026-11-19T10:00:00Z', resolution: 'fixed', reply_error: 'timeout' } });
    await settle();
    expect(d.querySelector('.reply-bad')).not.toBeNull();
    expect(d.querySelector('.reply-ok')).toBeNull();
  });

  test('no address on file → Send is disabled and the dialog says why', async () => {
    const { d } = bootPane({ held: 'r14', replyTo: null });
    await settle();
    expect(d.getElementById('rdSend').disabled).toBe(true);
    expect(d.querySelector('.rd-sub').textContent).toContain('no email address on file');
  });

  test('an already-resolved report: the resolve box is checked and locked, and Send asks for no resolve', async () => {
    const { d, sent } = bootPane({ held: 'r14~fixed', full: { resolved_at: '2026-11-19T10:00:00Z', resolved_by: 'Stuart' } });
    await settle();
    const box = d.getElementById('rdResolve');
    expect([box.checked, box.disabled]).toEqual([true, true]);
    d.getElementById('rdSend').click();
    await settle();
    expect(sent.find((s) => s.method === 'POST').body.resolve).toBe(false);
  });

  test('without a link: the open list, no dialog; "Respond to sender" in the expanded row opens it', async () => {
    const { d, sent, reported } = bootPane();
    await settle();
    expect(d.getElementById('rdBack')).toBeNull();
    expect(d.getElementById('fStatus').value).toBe('open');
    expect(reported).toEqual([]);
    d.querySelector('tr.row').click();
    await settle();
    const btn = [...d.querySelectorAll('.row-actions button')].find((b) => /Respond to sender/.test(b.textContent));
    expect(btn).toBeTruthy();
    btn.click();
    await settle();
    expect(checked(d)).toBe('fixed');
    expect(sent.filter((s) => /^\/api\/issue-reports\/14$/.test(s.url))).toHaveLength(1);   // the expand's fetch is reused
  });

  test('a malformed rest is ignored: no dialog, the default list', async () => {
    const { d } = bootPane({ held: 'r14x~fixed' });
    await settle();
    expect(d.getElementById('rdBack')).toBeNull();
    expect(d.getElementById('fStatus').value).toBe('open');
  });

  test('Cancel and Escape close the dialog without sending', async () => {
    const { d, w, sent } = bootPane({ held: 'r14' });
    await settle();
    d.getElementById('rdCancel').click();
    expect(d.getElementById('rdBack')).toBeNull();
    await (await Promise.resolve(w.openRespond(14, 'by_design')));
    expect(checked(d)).toBe('by_design');
    d.querySelector('.rd').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(d.getElementById('rdBack')).toBeNull();
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });
});
