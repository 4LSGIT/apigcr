// tests/emailAttachments.mysql.test.js
//
/**
 * REAL-ENGINE run of email attachments S1 (ref/EMAIL_ATTACHMENTS_DESIGN.md):
 * the case matcher's SQL, resolveMessage's three reference forms, the
 * mail_attachment_filings claim (INSERT IGNORE / stale re-claim / release),
 * the whole filing pipeline through the REAL filePlacementService ladder, and
 * refile — over a real MySQL with the production schema. Stubbed: the IMAP
 * part fetch (imapTransport.fetchPart), Dropbox (an in-memory account), the
 * documents registry write (it inserts a real documents row, so the Dropbox-id
 * stamp's JOIN runs for real), tasks, settings.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * Its OWN throwaway *_test database (it DELETEs from cases, contacts,
 * case_relate, contact_emails, mailboxes, mail_messages, documents — never
 * share one with another twin family):
 *   mysql -uroot -e 'CREATE DATABASE yc_eatt_test'
 *   mysql -uroot yc_eatt_test < ref/database.sql
 *   mysql -uroot yc_eatt_test < ref/migrations/2026-11-06_mail_attachment_filings.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pw@127.0.0.1:3307/yc_eatt_test \
 *     npx jest tests/emailAttachments.mysql.test.js
 * Run 2026-11-06: MySQL 8.0.46, production sql_mode, session time zone UTC.
 */

'use strict';

const { Readable } = require('stream');

process.env.APP_URL = 'https://app.test';

// ── in-memory Dropbox ───────────────────────────────────────────────────────
const mockJoinPath = (base, ...segments) => {
  const norm = (p) => {
    if (p == null) return '';
    let s = String(p);
    if (/^(id:|rev:|ns:)/.test(s)) return s;
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/\/{2,}/g, '/');
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
    return s === '/' ? '' : s;
  };
  let out = norm(base);
  for (const seg of segments) {
    if (seg == null || seg === '') continue;
    out = norm(`${out}/${seg}`);
  }
  return out;
};
const mockDbx = { files: new Map(), uploads: [], moves: [], seq: 0, links: { 'https://dbx/case-PVXC1RMM': '/cases/bentley' } };
const mockMetaOf = (f) => ({ '.tag': 'file', id: f.id, name: f.path.split('/').pop(), path_display: f.path, path_lower: f.path.toLowerCase(), size: f.size });
jest.mock('../services/dropboxService', () => ({
  _resolveCredential: jest.fn(async () => 8),
  resolveLocation: jest.fn(async (db, cred, { sharedLink, path }) => {
    if (path) return path;
    if (!mockDbx.links[sharedLink]) throw new Error('shared link not found');
    return mockDbx.links[sharedLink];
  }),
  createFolder: jest.fn(async (db, { path }) => ({ path, existed: false })),
  uploadFile: jest.fn(async (db, { path, content }) => {
    let p = path;
    for (let n = 1; [...mockDbx.files.values()].some(f => f.path.toLowerCase() === p.toLowerCase()); n++) {
      p = path.replace(/(\.[^./]+)$/, ` (${n})$1`);
    }
    const f = { id: `id:F${++mockDbx.seq}xY`, path: p, size: content.length };
    mockDbx.files.set(f.id, f);
    mockDbx.uploads.push({ path: p, size: content.length, body: Buffer.from(content).toString() });
    return mockMetaOf(f);
  }),
  getTemporaryLink: jest.fn(async () => ({ link: 'https://dl/tmp' })),
  getOrCreateSharedLink: jest.fn(async (db, { path }) => `https://dbx/sh${path}`),
  getMetadata: jest.fn(async (db, { path }) => {
    const f = mockDbx.files.get(path) || [...mockDbx.files.values()].find(x => x.path.toLowerCase() === String(path).toLowerCase());
    if (!f) throw Object.assign(new Error('path/not_found/'), { status: 409 });
    return mockMetaOf(f);
  }),
  movePath: jest.fn(async (db, { fromPath, toPath }) => {
    const f = mockDbx.files.get(fromPath);
    if (!f) throw new Error('not found');
    mockDbx.moves.push({ from: f.path, to: toPath });
    f.path = toPath;
    return { metadata: mockMetaOf(f) };
  }),
  joinPath: (...a) => mockJoinPath(...a),
}));
jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(async () => null), getSettings: jest.fn(async () => ({})) }));
jest.mock('../services/caseService', () => ({ ensureCaseDropboxFolder: jest.fn(async () => { throw new Error('no auto-create in this test'); }) }));
jest.mock('../services/taskService', () => ({ createTask: jest.fn(async () => ({ task_id: 1 })) }));
jest.mock('../services/esignAlertService', () => ({ resolveAlertAssignee: jest.fn(async () => 22) }));
jest.mock('../services/mailbox/imapTransport', () => ({
  ...jest.requireActual('../services/mailbox/imapTransport'),
  fetchPart: jest.fn(),
}));
// The registry write inserts a REAL documents row (the dropbox-id stamp joins it).
jest.mock('../services/documentIngestService', () => ({
  registerWrittenSafe: jest.fn(async (db, { entry, links }) => {
    const [r] = await db.query(
      `INSERT INTO documents (source, external_id, name, path, path_lower) VALUES ('dropbox', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE path = VALUES(path), path_lower = VALUES(path_lower), id = LAST_INSERT_ID(id)`,
      [entry.id, entry.name, entry.path_display, entry.path_lower]
    );
    global.__REG.push({ id: entry.id, path: entry.path_display, links });
    return { ok: true, document: { id: r.insertId } };
  }),
}));

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const BIN = '/  Law Office/   Cases/  Unsorted Client Uploads';

maybe('email attachments S1/S2 on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const transport = require('../services/mailbox/imapTransport');
  const match = require('../services/emailCaseMatchService');
  const att = require('../services/mailbox/mailAttachmentService');
  const filing = require('../services/emailAttachmentFilingService');
  const fns = require('../lib/internal_functions');
  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const ALL = '[Gmail]/All Mail';

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    pool = mysql.createPool({
      host: u.hostname, port: Number(u.port) || 3306, user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database, timezone: 'Z', connectionLimit: 4,
    });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}', time_zone = '+00:00'`));
    const [[t]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_attachment_filings'");
    if (!Number(t.n)) throw new Error('apply ref/migrations/2026-11-06_mail_attachment_filings.sql to the test database first');
  });
  afterAll(async () => { if (pool) await pool.end(); });

  // ── fixtures ──────────────────────────────────────────────────────────────
  let contactSeq = 0;
  async function contact(fname, lname, email, { ended = false } = {}) {
    const r = await q(
      `INSERT INTO contacts (contact_type, contact_fname, contact_lname, contact_name, contact_lfm_name, contact_rname, contact_mname)
       VALUES ('Client', ?, ?, '', '', '', '')`, [fname, lname]);
    const id = r.insertId;
    if (email) {
      await q('INSERT INTO contact_emails (contact_id, email, is_primary, end_date) VALUES (?, ?, 0, ?)',
        [id, email, ended ? '2026-09-03' : null]);
    }
    contactSeq++;
    return id;
  }
  async function kase(id, stage, phase, { dropbox = null, opened = '2026-10-01', number = null, numberFull } = {}) {
    await q(`INSERT INTO cases (case_id, case_stage, pipeline_phase, case_type, case_number, case_number_full, case_dropbox, case_open_date)
             VALUES (?, ?, ?, 'Bankruptcy', ?, ?, ?, ?)`,
    [id, stage, phase, number, numberFull === undefined ? `26-${id.slice(0, 5)}` : numberFull, dropbox, opened]);
  }
  const relate = (caseId, contactId, type = 'Primary') =>
    q('INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, ?)', [caseId, contactId, type]);
  let uidSeq = 100;
  async function message({ from, subject = 'docs', text = '', html = '', attachments = [], date = '2026-11-05 20:00:00', mailboxId = 2, provider = null, rfc = null }) {
    const uid = ++uidSeq;
    const r = await q(
      `INSERT INTO mail_messages (mailbox_id, folder, uid, message_id, provider_id, from_addr, to_addrs, subject, date, body_text, body_html, attachments, flags)
       VALUES (?, ?, ?, ?, ?, ?, 'docs@4lsg.com', ?, ?, ?, ?, ?, '')`,
      [mailboxId, mailboxId === 2 ? ALL : 'INBOX', uid, rfc || `m${uid}@x`, provider, from, subject, date, text || null, html || null, JSON.stringify(attachments)]);
    return r.insertId;
  }
  const pdf = (part, filename = `doc${part}.pdf`, size = 4000) => ({ part: String(part), filename, mime: 'application/pdf', size });
  /** fetchPart answers with the part id as the file's bytes. */
  function serveParts({ fail = {} } = {}) {
    transport.fetchPart.mockImplementation(async (row, folder, uid, part) => {
      if (fail[part]) { fail[part]--; throw new Error(`socket hang up (part ${part})`); }
      return { stream: Readable.from([Buffer.from(`bytes-of-${uid}-${part}`)]), mime: 'application/pdf', close: () => {} };
    });
  }

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const t of ['mail_attachment_filings', 'mail_messages', 'mailboxes', 'case_relate', 'contact_emails', 'contacts', 'cases', 'documents']) {
      await q(`DELETE FROM ${t}`);
    }
    await q(`INSERT INTO mailboxes (id, address, domain, imap_host, imap_user, emit_source_name, emit_id_kind, ingest_state)
             VALUES (2, 'stuart@4lsg.com', '4lsg.com', 'imap.test', 'u', 'gmail-firm', 'provider', ?),
                    (3, 'it@mdbl.test', 'mdbl.test', 'imap.test', 'u', NULL, NULL, ?)`,
    [JSON.stringify({ [ALL]: { uidvalidity: 7, last_uid: 999 } }), JSON.stringify({ INBOX: { uidvalidity: 3, last_uid: 999 } })]);
    mockDbx.files.clear(); mockDbx.uploads.length = 0; mockDbx.moves.length = 0; mockDbx.seq = 0;
    global.__REG = [];
    transport.fetchPart.mockReset();
    serveParts();
  });
  afterEach(() => jest.restoreAllMocks());

  // ═══════════════════════════════════════════════════════════════════════════
  describe('matchCase — the rules on real rows', () => {
    test('one open case → that case; closed/concluded cases do not count', async () => {
      const c = await contact('Jason', 'Childs', 'jason@x.com');
      await kase('AAAA1111', 'Concluded', 'case'); await relate('AAAA1111', c);
      await kase('BBBB2222', 'Open', 'case'); await relate('BBBB2222', c);
      await kase('CCCC3333', 'Closed', 'case'); await relate('CCCC3333', c);
      const m = await match.matchCase(pool, { fromEmail: 'Jason@X.com', subject: 'tax return', text: '' });
      expect(m).toMatchObject({ case_id: 'BBBB2222', method: 'sender_open_case', flag: null, contact: { contact_id: c } });
    });

    test('several open cases → the one retained case; none or several retained → flagged', async () => {
      const c = await contact('Tiff', 'Dago', 'tiff@x.com');
      await kase('AAAA1111', 'Open', 'intake'); await relate('AAAA1111', c);
      await kase('BBBB2222', 'Filed', 'case'); await relate('BBBB2222', c);
      expect(await match.matchCase(pool, { fromEmail: 'tiff@x.com' })).toMatchObject({ case_id: 'BBBB2222', method: 'sender_retained_case' });
      await kase('CCCC3333', 'Pending', 'case'); await relate('CCCC3333', c, 'Secondary');
      const m = await match.matchCase(pool, { fromEmail: 'tiff@x.com' });
      expect(m).toMatchObject({ case_id: null, flag: 'multiple_open_cases' });
      expect(m.candidates.map(x => x.case_id).sort()).toEqual(['AAAA1111', 'BBBB2222', 'CCCC3333']);
    });

    test('a typed id that is the sender\'s case → by id; another case while the sender has open ones → conflict', async () => {
      const c = await contact('Tristan', 'Sims', 'sims@x.com');
      await kase('PVXC1RMM', 'Open', 'intake'); await relate('PVXC1RMM', c);
      await kase('CF8ZT7VE', 'Filed', 'case');
      expect(await match.matchCase(pool, { fromEmail: 'sims@x.com', subject: '- Case PVXC1RMM' }))
        .toMatchObject({ case_id: 'PVXC1RMM', method: 'case_id_in_subject', flag: null });
      const m = await match.matchCase(pool, { fromEmail: 'sims@x.com', subject: 'case CF8ZT7VE' });
      expect(m).toMatchObject({ case_id: null, flag: 'conflict' });
      expect(m.candidates.map(x => [x.case_id, x.from])).toEqual([['CF8ZT7VE', 'id'], ['PVXC1RMM', 'sender']]);
    });

    test('a stranger with a valid id → by id; an id in the body when the subject has none', async () => {
      await kase('CF8ZT7VE', 'Filed', 'case');
      expect(await match.matchCase(pool, { fromEmail: 'mom@x.com', subject: 'for my son case CF8ZT7VE' }))
        .toMatchObject({ case_id: 'CF8ZT7VE', method: 'case_id_in_subject', contact: null });
      expect(await match.matchCase(pool, { fromEmail: 'mom@x.com', subject: 'docs', text: 'this is for case cf8zt7ve' }))
        .toMatchObject({ case_id: 'CF8ZT7VE', method: 'case_id_in_body' });
    });

    test('legacy ids match too (Fred 2026-11-08): all-caps bare or after "case"; mixed-case after "case", canonical id back', async () => {
      await kase('MY0PZ04I', 'Pending', 'case');      // legacy, all caps — the I is not Crockford
      await kase('tLfSP42H', 'Filed', 'case');        // legacy, mixed case
      for (const subject of ['docs for case MY0PZ04I', 'MY0PZ04I and other such gibberish', 'case my0pz04i']) {
        expect([subject, await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject })])
          .toMatchObject([subject, { case_id: 'MY0PZ04I', method: 'case_id_in_subject', ids_found: ['MY0PZ04I'] }]);
      }
      expect(await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject: 'case TLFSP42H' }))
        .toMatchObject({ case_id: 'tLfSP42H', method: 'case_id_in_subject' });
      // bare, only an all-caps token is tried — never an ordinary mixed-case word
      expect(await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject: 'tLfSP42H' }))
        .toMatchObject({ case_id: null, flag: 'unknown_sender' });
    });

    test('a case number (case_number or case_number_full) names its case — equality, any letter case', async () => {
      await kase('CF8ZT7VE', 'Filed', 'case', { number: '12-34567', numberFull: '12-34567-abc' });
      await kase('PVXC1RMM', 'Open', 'intake', { number: '1:26-cv-00546-JLR', numberFull: '1:26-cv-00546 (JLR)' });
      for (const subject of ['case 12-34567', 'case number 12-34567-ABC documents', 're: 12-34567-abc, paystubs']) {
        expect([subject, await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject })])
          .toMatchObject([subject, { case_id: 'CF8ZT7VE', method: 'case_number_in_subject', flag: null }]);
      }
      expect(await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject: 'motion (1:26-cv-00546-JLR)' }))
        .toMatchObject({ case_id: 'PVXC1RMM', method: 'case_number_in_subject' });
      const m = await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject: 'docs', text: 'This is for case number 12-34567.\nCall 248-555-1234.' });
      expect(m).toMatchObject({ case_id: 'CF8ZT7VE', method: 'case_number_in_body' });
      expect(m.reason).toBe('The message names case number 12-34567 (case CF8ZT7VE).');
      // a prefix or a near miss is not equality
      for (const subject of ['case 12-3456', 'case 12-34567-ab', 'case 2-34567', '248-555-1234']) {
        expect([subject, await match.matchCase(pool, { fromEmail: 'nobody@x.com', subject })])
          .toMatchObject([subject, { case_id: null, flag: 'unknown_sender' }]);
      }
    });

    test('id and number naming the SAME case → that case, by id; DIFFERENT cases → flagged; the subject beats the body', async () => {
      await kase('CF8ZT7VE', 'Filed', 'case', { number: '12-34567' });
      await kase('PVXC1RMM', 'Open', 'intake', { number: '26-52011' });
      expect(await match.matchCase(pool, { fromEmail: 'a@x.com', subject: 'case 12-34567 / CF8ZT7VE' }))
        .toMatchObject({ case_id: 'CF8ZT7VE', method: 'case_id_in_subject' });
      const m = await match.matchCase(pool, { fromEmail: 'a@x.com', subject: 'CF8ZT7VE and 26-52011' });
      expect(m).toMatchObject({ case_id: null, flag: 'multiple_case_ids' });
      expect(m.candidates.map(c => [c.case_id, c.from])).toEqual([['CF8ZT7VE', 'id'], ['PVXC1RMM', 'id']]);
      expect(await match.matchCase(pool, { fromEmail: 'a@x.com', subject: 'case 26-52011', text: 'for case CF8ZT7VE' }))
        .toMatchObject({ case_id: 'PVXC1RMM', method: 'case_number_in_subject' });
    });

    test('a named case that is one of the sender\'s CLOSED cases → that case, not a conflict', async () => {
      const c = await contact('Ruth', 'Old', 'ruth@x.com');
      await kase('AAAA1111', 'Open', 'intake'); await relate('AAAA1111', c);
      await kase('BBBB2222', 'Closed', 'case', { number: '19-41000' }); await relate('BBBB2222', c);
      expect(await match.matchCase(pool, { fromEmail: 'ruth@x.com', subject: 'case 19-41000' }))
        .toMatchObject({ case_id: 'BBBB2222', method: 'case_number_in_subject', flag: null });
      await kase('CCCC3333', 'Filed', 'case', { number: '26-52012' });
      const m = await match.matchCase(pool, { fromEmail: 'ruth@x.com', subject: 'case 26-52012' });
      expect(m).toMatchObject({ case_id: null, flag: 'conflict' });
      expect(m.candidates.map(x => [x.case_id, x.from])).toEqual([['CCCC3333', 'id'], ['AAAA1111', 'sender']]);
    });

    test('two different typed ids → flagged', async () => {
      await kase('CF8ZT7VE', 'Filed', 'case'); await kase('PVXC1RMM', 'Open', 'intake');
      expect(await match.matchCase(pool, { fromEmail: 'a@x.com', subject: 'CF8ZT7VE and PVXC1RMM' }))
        .toMatchObject({ case_id: null, flag: 'multiple_case_ids' });
    });

    test('an ENDED email row is not the sender; an Other relation is not their case', async () => {
      const c = await contact('Alex', 'Riley', 'alex@x.com', { ended: true });
      await kase('AAAA1111', 'Filed', 'case'); await relate('AAAA1111', c);
      expect(await match.matchCase(pool, { fromEmail: 'alex@x.com' })).toMatchObject({ contact: null, flag: 'unknown_sender' });
      const t = await contact('Tom', 'Trustee', 'trustee@x.com');
      await relate('AAAA1111', t, 'Other');
      expect(await match.matchCase(pool, { fromEmail: 'trustee@x.com' })).toMatchObject({ flag: 'no_open_case', candidates: [] });
    });

    test('a known contact with only closed cases → no_open_case, the closed cases as candidates', async () => {
      const c = await contact('Liz', 'U', 'liz@x.com');
      await kase('AAAA1111', 'Closed', 'case'); await relate('AAAA1111', c);
      const m = await match.matchCase(pool, { fromEmail: 'liz@x.com' });
      expect(m).toMatchObject({ case_id: null, flag: 'no_open_case' });
      expect(m.candidates.map(x => x.case_id)).toEqual(['AAAA1111']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('resolveMessage', () => {
    test('by row id, by mailbox/folder/uid, by gmail-firm provider id, by mailbox-imap Message-ID', async () => {
      const a = await message({ from: 'a@x.com', provider: '1a1adf9addfe3141' });
      const b = await message({ from: 'b@x.com', mailboxId: 3, rfc: 'rfc-b@x' });
      const [rowA] = await q('SELECT uid FROM mail_messages WHERE id = ?', [a]);
      expect((await att.resolveMessage(pool, { mail_message_id: a })).id).toBe(a);
      expect((await att.resolveMessage(pool, { mailbox_id: 2, folder: ALL, uid: rowA.uid })).id).toBe(a);
      expect((await att.resolveMessage(pool, { source: 'gmail-firm', message_id: '1A1ADF9ADDFE3141' })).id).toBe(a);
      expect((await att.resolveMessage(pool, { source: 'mailbox-imap', message_id: '<rfc-b@x>' })).id).toBe(b);
      // a source's key never resolves under the other source
      expect(await att.resolveMessage(pool, { source: 'mailbox-imap', message_id: '1a1adf9addfe3141' })).toBeNull();
      expect(await att.resolveMessage(pool, { source: 'gmail-firm', message_id: 'rfc-b@x' })).toBeNull();
      expect((await att.resolveMessage(pool, { mail_message_id: a })).attachments).toEqual([]);
    });
    test('no usable reference → BAD_REF', async () => {
      await expect(att.resolveMessage(pool, {})).rejects.toMatchObject({ code: 'BAD_REF' });
      await expect(att.resolveMessage(pool, { mail_message_id: 'x' })).rejects.toMatchObject({ code: 'BAD_REF' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('fileMessageAttachments', () => {
    test('auto → the case\'s Client Uploads/Emailed YYMMDD (firm-local), registered, Dropbox id stamped; a re-run files nothing new', async () => {
      const c = await contact('Kiara', 'Bentley', 'kiara@x.com');
      await kase('PVXC1RMM', 'Filed', 'case', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      const mid = await message({
        from: 'Kiara Bentley <kiara@x.com>', subject: 'paystubs', date: '2026-11-06 03:30:00',
        html: '<img src="cid:logo">',
        attachments: [pdf(2, 'stub 1.pdf'), pdf(3, 'stub 2.pdf'), { part: '4', filename: 'logo.png', mime: 'image/png', size: 900, cid: 'logo' }, { part: '5', filename: 'x.exe', size: 10 }],
      });
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid }, noticeSubjectPrefix: 'New email to Docs@4LSG.com — ' });
      expect(r).toMatchObject({ placement: 'case', case_id: 'PVXC1RMM', counts: { filed: 2, skipped: 2, failed: 0 } });
      expect(mockDbx.uploads.map(u => [u.path, u.body])).toEqual([
        ['/cases/bentley/Client Uploads/Emailed 261105/stub 1.pdf', `bytes-of-${uidSeq}-2`],
        ['/cases/bentley/Client Uploads/Emailed 261105/stub 2.pdf', `bytes-of-${uidSeq}-3`],
      ]);
      expect(global.__REG.map(g => g.links)).toEqual([[{ type: 'case', id: 'PVXC1RMM' }], [{ type: 'case', id: 'PVXC1RMM' }]]);
      const rows = await q('SELECT part, status, link_type, link_id, placement, match_method, dropbox_id, document_id, size FROM mail_attachment_filings WHERE mail_message_id = ? ORDER BY part', [mid]);
      expect(rows).toEqual([
        expect.objectContaining({ part: '2', status: 'filed', link_type: 'case', link_id: 'PVXC1RMM', placement: 'case', match_method: 'sender_open_case', dropbox_id: 'id:F1xY' }),
        expect.objectContaining({ part: '3', status: 'filed', dropbox_id: 'id:F2xY' }),
      ]);
      expect(rows.every(x => x.document_id != null && Number(x.size) > 0)).toBe(true);
      expect(r.folder_link).toBe('https://dbx/sh/cases/bentley/Client Uploads/Emailed 261105');
      expect(r.notice_subject).toBe('New email to Docs@4LSG.com — Kiara Bentley (2 files) — filed to case PVXC1RMM');
      expect(r.needs_decision).toBe(false);
      expect(r.notice_html_decision).toBeNull();

      const again = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(mockDbx.uploads).toHaveLength(2);
      expect(again.files.map(f => f.status)).toEqual(['already_filed', 'already_filed']);
      expect(again.counts).toMatchObject({ filed: 0, already_filed: 2 });
    });

    test('unknown sender → the unsorted bin, "Emailed YYMMDD - <address>", not linked', async () => {
      const mid = await message({ from: 'stranger@x.com', attachments: [pdf(2)] });
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(r).toMatchObject({ placement: 'unsorted', case_id: null, needs_decision: false });
      expect(mockDbx.uploads.map(u => u.path)).toEqual([`${BIN}/Emailed 261105 - stranger@x.com/doc2.pdf`]);
      expect(global.__REG[0].links).toEqual([]);
      const [row] = await q('SELECT link_type, placement, match_method FROM mail_attachment_filings WHERE mail_message_id = ?', [mid]);
      expect(row).toEqual({ link_type: null, placement: 'unsorted', match_method: 'none' });
    });

    test('conflict → unsorted under the contact\'s name, registered to the contact, decision options ready', async () => {
      const c = await contact('Tristan', 'Sims', 'sims@x.com');
      await kase('PVXC1RMM', 'Open', 'intake'); await relate('PVXC1RMM', c);
      await kase('CF8ZT7VE', 'Filed', 'case');
      const mid = await message({ from: 'sims@x.com', subject: 'case CF8ZT7VE', attachments: [pdf(2)] });
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(r).toMatchObject({ placement: 'unsorted', case_id: null, needs_decision: true, match: { flag: 'conflict' } });
      expect(mockDbx.uploads[0].path).toBe(`${BIN}/Emailed 261105 - Sims, Tristan/doc2.pdf`);
      expect(global.__REG[0].links).toEqual([{ type: 'contact', id: c }]);
      expect(r.decision_options.map(o => o.value)).toEqual(['CF8ZT7VE', 'PVXC1RMM', 'unsorted']);
      expect(r.decision_options.every(o => /^[a-zA-Z0-9_-]{1,64}$/.test(o.value) && o.label.length <= 100)).toBe(true);
      expect(r.notice_subject).toBe('Emailed files — sims@x.com (1 file) — UNSORTED, needs a case');
      expect(r.notice_html_decision.match(/\[\[options_html\]\]/g)).toHaveLength(1);
    });

    test('a fetch that fails twice → failed, claim released; the next run files it', async () => {
      const mid = await message({ from: 'stranger@x.com', attachments: [pdf(2), pdf(3)] });
      serveParts({ fail: { 3: 2 } });
      const first = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(first.files.map(f => [f.part, f.status])).toEqual([['2', 'filed'], ['3', 'failed']]);
      expect(first.files[1].error).toMatch(/socket hang up/);
      expect(await q('SELECT part, status FROM mail_attachment_filings WHERE mail_message_id = ? ORDER BY part', [mid]))
        .toEqual([{ part: '2', status: 'filed' }]);
      const second = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(second.files.map(f => [f.part, f.status])).toEqual([['2', 'already_filed'], ['3', 'filed']]);
      expect(mockDbx.uploads).toHaveLength(2);
    }, 15000);

    test('a fresh claim held by another run is left alone; a STALE one is taken over', async () => {
      const mid = await message({ from: 'stranger@x.com', attachments: [pdf(2), pdf(3)] });
      await q(`INSERT INTO mail_attachment_filings (mail_message_id, part, status, claimed_at) VALUES
               (?, '2', 'filing', UTC_TIMESTAMP()), (?, '3', 'filing', UTC_TIMESTAMP() - INTERVAL 20 MINUTE)`, [mid, mid]);
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(r.files.map(f => [f.part, f.status])).toEqual([['2', 'in_progress'], ['3', 'filed']]);
      expect(mockDbx.uploads.map(u => u.path.split('/').pop())).toEqual(['doc3.pdf']);
    });

    test('a message the store does not hold → MESSAGE_NOT_STORED; an explicit unknown case → CASE_NOT_FOUND', async () => {
      await expect(filing.fileMessageAttachments(pool, { ref: { source: 'gmail-firm', message_id: 'ffff' } }))
        .rejects.toMatchObject({ code: 'MESSAGE_NOT_STORED' });
      const mid = await message({ from: 'a@x.com', attachments: [pdf(2)] });
      await expect(filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid }, target: 'case', caseId: 'ZZZZ9999' }))
        .rejects.toMatchObject({ code: 'CASE_NOT_FOUND' });
      expect(mockDbx.uploads).toHaveLength(0);
    });

    test('a case whose folder link is dead → the bin\'s per-case folder, no per-file move task', async () => {
      const taskService = require('../services/taskService');
      taskService.createTask.mockClear();
      const c = await contact('Kiara', 'Bentley', 'kiara@x.com');
      await kase('PVXC1RMM', 'Filed', 'case', { dropbox: 'https://dbx/dead' }); await relate('PVXC1RMM', c);
      const mid = await message({ from: 'kiara@x.com', attachments: [pdf(2), pdf(3)] });
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(r.placement).toBe('unsorted');
      expect(mockDbx.uploads.map(u => u.path)).toEqual([`${BIN}/PVXC1RMM - Bentley, Kiara/doc2.pdf`, `${BIN}/PVXC1RMM - Bentley, Kiara/doc3.pdf`]);
      expect(taskService.createTask).not.toHaveBeenCalled();
      expect(global.__REG[0].links).toEqual([{ type: 'case', id: 'PVXC1RMM' }]);
    });

    test('through the registry: email_attachments_file → output_var; email_case_match from a reference', async () => {
      const c = await contact('Kiara', 'Bentley', 'kiara@x.com');
      await kase('PVXC1RMM', 'Filed', 'case', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      const mid = await message({ from: 'kiara@x.com', attachments: [pdf(2)] });
      const out = await fns.email_attachments_file({ mail_message_id: String(mid), source: '', output_var: 'filing' }, pool);
      expect(out.success).toBe(true);
      expect(out.set_vars.filing).toBe(out.output);
      expect(out.output.case_id).toBe('PVXC1RMM');
      const m = await fns.email_case_match({ mail_message_id: mid }, pool);
      expect(m.output).toMatchObject({ case_id: 'PVXC1RMM', method: 'sender_open_case' });
      await expect(fns.email_attachments_file({}, pool)).rejects.toThrow(/^email_attachments_file: give mail_message_id/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('refileMessageAttachments', () => {
    test('moves by Dropbox id, keeps the current (staff-renamed) name, links the case, rewrites the rows', async () => {
      const c = await contact('Tristan', 'Sims', 'sims@x.com');
      await kase('PVXC1RMM', 'Open', 'intake', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      await kase('CF8ZT7VE', 'Filed', 'case');
      const mid = await message({ from: 'sims@x.com', subject: 'case CF8ZT7VE', attachments: [pdf(2), pdf(3)] });
      await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      // staff renamed one in the bin since
      mockDbx.files.get('id:F1xY').path = `${BIN}/Emailed 261105 - Sims, Tristan/CHASE - 261031.pdf`;
      global.__REG = [];

      const r = await filing.refileMessageAttachments(pool, { mailMessageId: mid, caseId: 'PVXC1RMM', filedBy: 5 });
      expect(r).toMatchObject({ case_id: 'PVXC1RMM', placement: 'case', failed: [] });
      expect(mockDbx.moves.map(m => m.to)).toEqual([
        '/cases/bentley/Client Uploads/Emailed 261105/CHASE - 261031.pdf',
        '/cases/bentley/Client Uploads/Emailed 261105/doc3.pdf',
      ]);
      expect(global.__REG.map(g => g.links)).toEqual([[{ type: 'case', id: 'PVXC1RMM' }], [{ type: 'case', id: 'PVXC1RMM' }]]);
      const rows = await q('SELECT part, link_type, link_id, placement, match_method, dropbox_path, filed_by, refiled_at FROM mail_attachment_filings WHERE mail_message_id = ? ORDER BY part', [mid]);
      expect(rows.map(x => [x.link_type, x.link_id, x.placement, x.match_method, x.filed_by])).toEqual([
        ['case', 'PVXC1RMM', 'case', 'refiled', 5], ['case', 'PVXC1RMM', 'case', 'refiled', 5],
      ]);
      expect(rows[0].dropbox_path).toBe('/cases/bentley/Client Uploads/Emailed 261105/CHASE - 261031.pdf');
      expect(rows.every(x => x.refiled_at instanceof Date)).toBe(true);

      // again: already there — re-linked, not moved
      mockDbx.moves.length = 0;
      const again = await filing.refileMessageAttachments(pool, { mailMessageId: mid, caseId: 'PVXC1RMM' });
      expect(mockDbx.moves).toHaveLength(0);
      expect(again.already_there).toHaveLength(2);
    });

    test('a file deleted from Dropbox since → failed for that file, the rest move', async () => {
      await kase('PVXC1RMM', 'Filed', 'case', { dropbox: 'https://dbx/case-PVXC1RMM' });
      const mid = await message({ from: 'stranger@x.com', attachments: [pdf(2), pdf(3)] });
      await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      mockDbx.files.delete('id:F1xY');
      const r = await filing.refileMessageAttachments(pool, { mailMessageId: mid, caseId: 'PVXC1RMM' });
      expect(r.moved.map(m => m.part)).toEqual(['3']);
      expect(r.failed.map(f => f.part)).toEqual(['2']);
    });
  });
});
