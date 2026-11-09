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
 *   mysql -uroot yc_eatt_test < ref/migrations/2026-11-09_mail_attachment_notices.sql
 *   YC_TEST_MYSQL_URL=mysql://user:pw@127.0.0.1:3307/yc_eatt_test \
 *     npx jest tests/emailAttachments.mysql.test.js
 * Run 2026-11-06: MySQL 8.0.46, production sql_mode, session time zone UTC.
 * The burst digest (S2d, design §8) runs here too: its clock is ingested_at
 * against UTC_TIMESTAMP(), so the tests age rows in SQL — no fake timers.
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
    const [[t2]] = await pool.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mail_attachment_notices'");
    if (!Number(t2.n)) throw new Error('apply ref/migrations/2026-11-09_mail_attachment_notices.sql to the test database first');
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
    for (const t of ['mail_attachment_notices', 'mail_attachment_filings', 'mail_messages', 'mailboxes', 'case_relate', 'contact_emails', 'contacts', 'cases', 'documents', 'checkitems', 'checklists']) {
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

    test('each filed file links to itself (the folder link opened on it); the case\'s Docs Needed list is linked, its open items named', async () => {
      const c = await contact('Kiara', 'Bentley', 'kiara@x.com');
      await kase('PVXC1RMM', 'Open', 'case', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      await kase('CF8ZT7VE', 'Open', 'case');
      const list = async (link, title, tag, items) => {
        const r = await q(`INSERT INTO checklists (title, kind, created_by, link, link_type, tag) VALUES (?, 'checklist', 1, ?, 'case', ?)`, [title, link, tag]);
        let pos = 0;
        for (const [name, status] of items) {
          await q('INSERT INTO checkitems (checklist_id, name, status, position) VALUES (?, ?, ?, ?)', [r.insertId, name, status, ++pos]);
        }
      };
      await list('PVXC1RMM', 'Docs Needed', 'docs_needed', [['Paystubs <6 mo>', 'incomplete'], ['Tax return 2025', 'complete'], ['Bank statements', 'incomplete']]);
      await list('PVXC1RMM', 'Staff notes', null, [['call trustee', 'incomplete']]);          // not the client's docs list
      await list('CF8ZT7VE', 'Docs Needed', 'docs_needed', [['Other client item', 'incomplete']]);   // another case's
      const dbx = require('../services/dropboxService');
      dbx.getOrCreateSharedLink.mockImplementationOnce(async () => 'https://www.dropbox.com/scl/fo/a/b?rlkey=k&dl=0');
      const mid = await message({ from: 'Kiara Bentley <kiara@x.com>', attachments: [pdf(2, 'stub 1.pdf'), pdf(3, 'w2 & 1099.pdf')] });
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(r.files.map(f => f.link)).toEqual([
        'https://www.dropbox.com/scl/fo/a/b?rlkey=k&dl=0&preview=stub%201.pdf',
        'https://www.dropbox.com/scl/fo/a/b?rlkey=k&dl=0&preview=w2%20%26%201099.pdf',
      ]);
      expect(r.docs_checklist).toEqual({
        link: `${r.app_url}/?files=cPVXC1RMM~checklists&open=file:0`,
        lists: 1, items: 3, open_count: 2, open: ['Paystubs <6 mo>', 'Bank statements'],
      });
      expect(r.notice_html).toContain('move them where they belong in the case folder, and check them off the Docs Needed list.');
      expect(r.notice_html).toContain(`href="${r.app_url}/?files=cPVXC1RMM~checklists&amp;open=file:0"`);
      expect(r.notice_html).toContain('Docs Needed list — 2 of 3 still needed:');
      expect(r.notice_html).toContain('>Paystubs &lt;6 mo&gt;</li>');
      expect(r.notice_html).not.toContain('Tax return 2025');
      expect(r.notice_html).not.toContain('call trustee');
      expect(r.notice_html).not.toContain('Other client item');
      expect(r.notice_html).toContain('href="https://www.dropbox.com/scl/fo/a/b?rlkey=k&amp;dl=0&amp;preview=w2%20%26%201099.pdf"');
      expect(r.notice_text).toContain(`Docs Needed list — 2 of 3 still needed: ${r.app_url}/?files=cPVXC1RMM~checklists&open=file:0\n  - Paystubs <6 mo>\n  - Bank statements`);

      // a run that finds the files already there keeps their links
      dbx.getOrCreateSharedLink.mockImplementationOnce(async () => 'https://www.dropbox.com/scl/fo/a/b?rlkey=k&dl=0');
      const again = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid } });
      expect(again.files.map(f => [f.status, f.link])).toEqual(r.files.map(f => ['already_filed', f.link]));

      // more open items than the notice names → the count covers them
      await q(`INSERT INTO checkitems (checklist_id, name, status, position)
               SELECT id, CONCAT('item ', n), 'incomplete', 10 + n FROM checklists,
                      (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6
                       UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12) k
                WHERE link = 'PVXC1RMM' AND tag = 'docs_needed'`);
      const mid2 = await message({ from: 'Kiara Bentley <kiara@x.com>', attachments: [pdf(2, 'more.pdf')] });
      const r2 = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: mid2 } });
      expect(r2.docs_checklist).toMatchObject({ items: 15, open_count: 14 });
      expect(r2.docs_checklist.open).toHaveLength(12);
      expect(r2.notice_html).toContain('+ 2 more');
      expect(r2.notice_text).toContain('  - item 10\n  + 2 more');

      // nothing filed (only a refused type) → no list: there is nothing to check off
      const r3 = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: await message({ from: 'kiara@x.com', attachments: [{ part: '2', filename: 'x.exe', size: 10 }] }) } });
      expect(r3).toMatchObject({ case_id: 'PVXC1RMM', docs_checklist: null });
      expect(r3.notice_html).not.toContain('Docs Needed');
    });

    test('no Docs Needed list, or no case → no list link and no "check them off"', async () => {
      const c = await contact('Kiara', 'Bentley', 'kiara@x.com');
      await kase('PVXC1RMM', 'Open', 'case', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      const r = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: await message({ from: 'kiara@x.com', attachments: [pdf(2)] }) } });
      expect(r).toMatchObject({ placement: 'case', docs_checklist: null });
      expect(r.notice_html).toContain('Review the files, rename them, and move them where they belong in the case folder.');
      expect(r.notice_html).not.toContain('Docs Needed');
      const u = await filing.fileMessageAttachments(pool, { ref: { mail_message_id: await message({ from: 'stranger@x.com', attachments: [pdf(2)] }) } });
      expect(u).toMatchObject({ placement: 'unsorted', docs_checklist: null });
      expect(u.files[0].link).toBe(`https://dbx/sh${BIN}/Emailed 261105 - stranger@x.com?preview=doc2.pdf`);
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

  // ═══════════════════════════════════════════════════════════════════════════
  describe('burst digest (S2d, design §8)', () => {
    const digest = require('../services/emailAttachmentDigestService');
    const KEY = 'docs@';
    const PREFIX = 'New email to Docs@4LSG.com — ';
    /** File one email into the digest queue, the way the workflow's step 2 does. */
    const fileQ = (mid, over = {}) => filing.fileMessageAttachments(pool, {
      ref: { mail_message_id: mid }, digestKey: KEY, noticeSubjectPrefix: PREFIX, noticeTitle: 'docs@4lsg.com', ...over });
    /** Set a queued email's ingest time to `s` seconds ago. */
    const ago = (mid, s) => q('UPDATE mail_attachment_notices SET ingested_at = UTC_TIMESTAMP() - INTERVAL ? SECOND WHERE mail_message_id = ?', [s, mid]);
    const check = (mid, o = {}) => digest.check(pool, { digestKey: KEY, mailMessageId: mid, ...o });
    const rowsOf = () => q('SELECT digest_key, mail_message_id, sender, digest_of, notified_at IS NOT NULL AS notified, result IS NOT NULL AS has_result FROM mail_attachment_notices ORDER BY mail_message_id');

    test('the filing step queues the email (placeholder first, result after); the burst clock is the message\'s ingest time', async () => {
      const mid = await message({ from: 'Dawn Sims <Dawn.Sims@X.com>', attachments: [pdf(2)] });
      await q("UPDATE mail_messages SET ingested_at = UTC_TIMESTAMP() - INTERVAL 90 SECOND WHERE id = ?", [mid]);
      let duringFetch;
      const serve = transport.fetchPart.getMockImplementation();
      transport.fetchPart.mockImplementationOnce(async (...a) => {
        duringFetch = await rowsOf();                               // the placeholder is there WHILE the files are fetched
        return serve(...a);
      });
      const r = await fileQ(mid);
      expect(duringFetch).toEqual([expect.objectContaining({ mail_message_id: mid, sender: 'dawn.sims@x.com', has_result: 0, notified: 0 })]);
      expect(r.digest_key).toBe(KEY);
      const [row] = await q('SELECT sender, TIMESTAMPDIFF(SECOND, ingested_at, UTC_TIMESTAMP()) AS age, result FROM mail_attachment_notices WHERE mail_message_id = ?', [mid]);
      expect(row.sender).toBe('dawn.sims@x.com');
      expect(row.age).toBeGreaterThanOrEqual(89);
      const stored = JSON.parse(row.result);
      expect(stored).toMatchObject({ mail_message_id: mid, notice_subject: r.notice_subject, notice_html: r.notice_html,
        notice_prefix: PREFIX, notice_title: 'docs@4lsg.com', excerpt: { body: '', trimmed: false, cut: 0 } });
      expect(stored.text).toBeUndefined();                          // the raw body stays in the mail store
      // without digest_key nothing is queued
      await filing.fileMessageAttachments(pool, { ref: { mail_message_id: await message({ from: 'x@x.com', attachments: [pdf(2)] }) } });
      expect((await rowsOf()).map(x => x.mail_message_id)).toEqual([mid]);
    });

    test('one email: wait out the quiet time, then ITS OWN notice, byte for byte; asked again (a retried step) → the same notice', async () => {
      const mid = await message({ from: 'stranger@x.com', subject: 'w2', attachments: [pdf(2)] });
      const r = await fileQ(mid);
      await ago(mid, 100);
      const w = await check(mid);
      expect(w).toMatchObject({ action: 'wait', pending: 1, digest_of: null });
      expect(w.wait_ms).toBeGreaterThanOrEqual((300 - 101) * 1000);   // until 5 min after ingest …
      expect(w.wait_ms).toBeLessThanOrEqual((300 - 100) * 1000 + digest.WAIT_SLACK_MS + 1000);   // … plus the slack
      expect(w.wait).toBe(`${w.wait_ms / 1000}s`);
      await ago(mid, 299);
      expect((await check(mid)).wait_ms).toBe(digest.MIN_WAIT_MS);  // never under the engine's pause floor
      await ago(mid, 300);
      const s = await check(mid);
      expect(s).toMatchObject({ action: 'send', ended_by: 'quiet', digest_of: mid, count: 1, mail_message_ids: [mid],
        notice_subject: r.notice_subject, notice_html: r.notice_html, notice_text: r.notice_text,
        needs_decision: false, decision_options: [], notice_html_decision: null, unsorted_ids: [mid] });
      expect(await rowsOf()).toEqual([expect.objectContaining({ digest_of: mid, notified: 1 })]);
      const again = await check(mid);
      expect(again).toMatchObject({ action: 'send', digest_of: mid, notice_html: r.notice_html });
    });

    test('a burst: everyone waits for the newest email\'s quiet time; the first to ask after it claims all; the rest are done', async () => {
      const c = await contact('Dawn', 'Sims', 'dawn@x.com');
      await kase('DZ8G0HYT', 'Open', 'intake', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('DZ8G0HYT', c);
      const ids = [];
      for (const n of [1, 2, 3]) ids.push(await message({ from: 'Dawn Sims <dawn@x.com>', subject: `photo ${n}`, text: `pic ${n}`, attachments: [pdf(2, `IMG_${n}.jpg`)] }));
      for (const id of ids) await fileQ(id);
      await ago(ids[0], 400); await ago(ids[1], 200); await ago(ids[2], 30);
      for (const id of ids) {
        const w = await check(id);
        expect(w.action).toBe('wait');
        expect(w.pending).toBe(3);
        expect(Math.abs(w.wait_ms - ((300 - 30) * 1000 + digest.WAIT_SLACK_MS))).toBeLessThanOrEqual(2000);   // the NEWEST one's quiet time
      }
      await ago(ids[0], 700); await ago(ids[1], 500); await ago(ids[2], 330);
      const s = await check(ids[1]);                                // not the newest: whoever asks first after the burst ends
      expect(s).toMatchObject({ action: 'send', digest_of: ids[1], count: 3, mail_message_ids: ids, case_ids: ['DZ8G0HYT'],
        files_filed: 3, unsorted_ids: [], needs_decision: false });
      expect(s.notice_subject).toBe(`${PREFIX}Dawn Sims (3 files from 3 emails) — filed to case DZ8G0HYT`);
      expect(s.notice_html).toContain('Filed to case DZ8G0HYT — 3 files from 3 emails');
      for (const n of [1, 2, 3]) expect(s.notice_html).toContain(`>IMG_${n}.jpg</a>`);
      expect(s.notice_text).toContain('   > pic 2');
      expect(await check(ids[0])).toEqual({ action: 'done', digest_of: ids[1], digest_key: KEY, mail_message_id: ids[0] });
      expect((await check(ids[2])).action).toBe('done');
      expect((await rowsOf()).map(x => [x.digest_of, x.notified])).toEqual([[ids[1], 1], [ids[1], 1], [ids[1], 1]]);

      // the next email starts a NEW burst
      const later = await message({ from: 'dawn@x.com', attachments: [pdf(2, 'IMG_4.jpg')] });
      await fileQ(later);
      expect(await check(later)).toMatchObject({ action: 'wait', pending: 1 });
    });

    test('the cap: 30 minutes after the burst\'s first email the notice goes, though the sender is still sending', async () => {
      const ids = [];
      for (const n of [1, 2, 3]) ids.push(await message({ from: 'stream@x.com', attachments: [pdf(2, `p${n}.pdf`)] }));
      for (const id of ids) await fileQ(id);
      await ago(ids[0], 1790); await ago(ids[1], 900); await ago(ids[2], 20);
      const w = await check(ids[2]);
      expect(w.action).toBe('wait');
      expect(Math.abs(w.wait_ms - digest.MIN_WAIT_MS)).toBeLessThanOrEqual(1000);   // the cap is 10 s away: the floor wins
      await ago(ids[0], 1800);
      const s = await check(ids[2]);
      expect(s).toMatchObject({ action: 'send', ended_by: 'cap', count: 3, digest_of: ids[2] });
    });

    test('an email still being filed (placeholder) holds the burst open — and is left out of the claim; a STALE placeholder is ignored', async () => {
      const a = await message({ from: 'p@x.com', attachments: [pdf(2)] });
      const b = await message({ from: 'p@x.com', attachments: [pdf(2)] });
      const dead = await message({ from: 'p@x.com', attachments: [pdf(2)] });
      await fileQ(a);
      await digest.enqueue(pool, { digestKey: KEY, mailMessageId: b, senderEmail: 'P@x.com' });        // b: filing in flight
      await digest.enqueue(pool, { digestKey: KEY, mailMessageId: dead, senderEmail: 'p@x.com' });     // dead: a filing that died
      await q('UPDATE mail_attachment_notices SET created_at = UTC_TIMESTAMP() - INTERVAL 16 MINUTE, ingested_at = UTC_TIMESTAMP() - INTERVAL 5 SECOND WHERE mail_message_id = ?', [dead]);
      await ago(a, 600); await ago(b, 60);
      expect(await check(a)).toMatchObject({ action: 'wait', pending: 2 });   // b holds it; dead does not count
      await ago(b, 400);
      const s = await check(a);
      expect(s).toMatchObject({ action: 'send', count: 1, mail_message_ids: [a] });
      expect((await rowsOf()).map(x => [x.mail_message_id, x.notified])).toEqual([[a, 1], [b, 0], [dead, 0]]);
      await expect(check(b)).rejects.toMatchObject({ code: 'NOT_FILED' });
      await fileQ(b);                                               // b's filing completes: its own burst
      await ago(b, 400);
      expect(await check(b)).toMatchObject({ action: 'send', count: 1, mail_message_ids: [b] });
    });

    test('bursts never mix senders or digests; an email with no sender is never grouped', async () => {
      const a = await message({ from: 'one@x.com', attachments: [pdf(2)] });
      const b = await message({ from: 'two@x.com', attachments: [pdf(2)] });
      const c = await message({ from: 'one@x.com', attachments: [pdf(2)] });
      const n1 = await message({ from: '', attachments: [pdf(2)] });
      const n2 = await message({ from: '', attachments: [pdf(2)] });
      const both = await message({ from: 'one@x.com', attachments: [pdf(2)] });
      for (const id of [a, b, n1, n2]) await fileQ(id);
      await fileQ(c, { digestKey: 'other' });
      await fileQ(both); await fileQ(both, { digestKey: 'other' });   // one email in two digests
      for (const id of [a, b, n1, n2]) await ago(id, 400);
      await q('UPDATE mail_attachment_notices SET ingested_at = UTC_TIMESTAMP() - INTERVAL 30 SECOND WHERE mail_message_id IN (?)', [[c, both]]);
      await q("UPDATE mail_attachment_notices SET ingested_at = UTC_TIMESTAMP() - INTERVAL 400 SECOND WHERE mail_message_id = ? AND digest_key = 'docs@'", [both]);
      // c (same sender, fresh, OTHER digest) holds nothing here
      expect(await check(both)).toMatchObject({ action: 'send', digest_of: both, mail_message_ids: [a, both] });
      expect(await check(a)).toMatchObject({ action: 'done', digest_of: both });
      expect(await check(b)).toMatchObject({ action: 'send', mail_message_ids: [b] });
      expect(await digest.check(pool, { digestKey: 'other', mailMessageId: c })).toMatchObject({ action: 'wait', pending: 2 });
      await q("UPDATE mail_attachment_notices SET ingested_at = UTC_TIMESTAMP() - INTERVAL 400 SECOND WHERE digest_key = 'other'");
      // the same email claims in BOTH digests (digest_of = both twice): each notice is its own digest's
      expect(await digest.check(pool, { digestKey: 'other', mailMessageId: both })).toMatchObject({ action: 'send', digest_of: both, count: 2, mail_message_ids: [c, both] });
      expect(await check(n1)).toMatchObject({ action: 'send', mail_message_ids: [n1] });
      expect(await check(n2)).toMatchObject({ action: 'send', mail_message_ids: [n2] });
      const senders = (await q("SELECT sender FROM mail_attachment_notices WHERE digest_key = 'docs@' ORDER BY mail_message_id")).map(x => x.sender);
      expect(senders).toEqual(['one@x.com', 'two@x.com', `#${n1}`, `#${n2}`, 'one@x.com']);
    });

    test('two checks racing on a ripe burst: exactly one sends, the other is done (one locking read, no deadlock)', async () => {
      const ids = [];
      for (let n = 0; n < 6; n++) ids.push(await message({ from: 'race@x.com', attachments: [pdf(2)] }));
      for (const id of ids) await fileQ(id);
      for (const id of ids) await ago(id, 400);
      const out = await Promise.all(ids.map(id => check(id)));
      const sends = out.filter(o => o.action === 'send');
      expect(sends).toHaveLength(1);
      expect(sends[0].count).toBe(6);
      expect(out.filter(o => o.action === 'done').every(o => o.digest_of === sends[0].digest_of)).toBe(true);
    });

    test('the burst\'s one decision: options merged across its unsorted emails; the answer moves only the unsorted ones', async () => {
      const c = await contact('Tristan', 'Sims', 'sims@x.com');
      await kase('PVXC1RMM', 'Open', 'intake', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      await kase('CF8ZT7VE', 'Filed', 'case');
      const u1 = await message({ from: 'sims@x.com', subject: 'case CF8ZT7VE', attachments: [pdf(2, 'a.pdf')] });    // conflict → unsorted
      const ok = await message({ from: 'sims@x.com', subject: 'paystub', attachments: [pdf(2, 'b.pdf')] });           // his case → filed there
      const u2 = await message({ from: 'sims@x.com', subject: 'case CF8ZT7VE again', attachments: [pdf(2, 'c.pdf'), pdf(3, 'd.pdf')] });
      for (const id of [u1, ok, u2]) { await fileQ(id); await ago(id, 400); }
      const s = await check(u2);
      expect(s).toMatchObject({ action: 'send', count: 3, needs_decision: true, unsorted_ids: [u1, u2], case_ids: ['PVXC1RMM'] });
      expect(s.decision_options.map(o => o.value)).toEqual(['CF8ZT7VE', 'PVXC1RMM', 'unsorted']);
      expect(s.decision_options[2].label).toBe('Leave them in Unsorted');
      expect(s.notice_subject).toBe(`${PREFIX}sims@x.com (4 files from 3 emails) — UNSORTED, needs a case`);
      expect(s.notice_html_decision.match(/\[\[options_html\]\]/g)).toHaveLength(1);
      expect(s.notice_html_decision).toContain('Every unsorted file in this notice moves there when you choose.');
      expect(s.unsorted_folder_path).toBe(`${BIN}/Emailed 261105 - Sims, Tristan`);

      mockDbx.moves.length = 0;
      const r = await fns.email_attachments_refile({ digest_key: KEY, digest_of: s.digest_of, case_id: 'CF8ZT7VE', output_var: 'refiled' }, pool);
      const out = r.output;
      expect(out).toMatchObject({ case_id: 'CF8ZT7VE', mail_message_ids: [u1, u2], failed: [] });
      expect(out.moved.map(m => [m.mail_message_id, m.filename])).toEqual([[u1, 'a.pdf'], [u2, 'c.pdf'], [u2, 'd.pdf']]);
      expect(mockDbx.moves).toHaveLength(3);                        // b.pdf (filed to his case) stays put
      expect(r.set_vars.refiled).toBe(out);
      const moved = await q("SELECT DISTINCT mail_message_id FROM mail_attachment_filings WHERE match_method = 'refiled' ORDER BY mail_message_id");
      expect(moved.map(x => Number(x.mail_message_id))).toEqual([u1, u2]);
      await expect(fns.email_attachments_refile({ digest_of: s.digest_of, case_id: 'CF8ZT7VE' }, pool)).rejects.toThrow('digest_of needs digest_key');
      await expect(fns.email_attachments_refile({ digest_key: KEY, digest_of: 999999, case_id: 'CF8ZT7VE' }, pool)).rejects.toThrow(/DIGEST_NOT_FOUND|no notice 999999/);
    });

    test('several emails to a case with a Docs Needed list: the list is read when the notice goes, not when each was filed', async () => {
      const c = await contact('Kiara', 'Bentley', 'kiara@x.com');
      await kase('PVXC1RMM', 'Open', 'case', { dropbox: 'https://dbx/case-PVXC1RMM' }); await relate('PVXC1RMM', c);
      const r = await q(`INSERT INTO checklists (title, kind, created_by, link, link_type, tag) VALUES ('Docs Needed', 'checklist', 1, 'PVXC1RMM', 'case', 'docs_needed')`);
      await q("INSERT INTO checkitems (checklist_id, name, status, position) VALUES (?, 'Paystubs', 'incomplete', 1), (?, 'W2', 'incomplete', 2)", [r.insertId, r.insertId]);
      const a = await message({ from: 'kiara@x.com', attachments: [pdf(2, 'stub.pdf')] });
      const b = await message({ from: 'kiara@x.com', attachments: [pdf(2, 'w2.pdf')] });
      for (const id of [a, b]) { await fileQ(id); await ago(id, 400); }
      await q("UPDATE checkitems SET status = 'complete' WHERE name = 'Paystubs'");     // checked off in between
      const s = await check(a);
      expect(s.notice_html).toContain('Docs Needed list — 1 of 2 still needed:');
      expect(s.notice_html).toContain('check them off the Docs Needed list.');
      expect(s.notice_text).toContain('  - W2');
      expect(s.notice_text).not.toContain('  - Paystubs');
    });

    test('refusals: not queued, no result yet, a bad key; record never rewrites a row already in a notice', async () => {
      const mid = await message({ from: 'z@x.com', attachments: [pdf(2)] });
      await expect(check(mid)).rejects.toMatchObject({ code: 'NOT_QUEUED' });
      await expect(digest.check(pool, { digestKey: 'bad key!', mailMessageId: mid })).rejects.toMatchObject({ code: 'BAD_DIGEST_KEY' });
      await expect(digest.check(pool, { digestKey: KEY, mailMessageId: mid, quietMs: 600_000, capMs: 300_000 })).rejects.toMatchObject({ code: 'BAD_WINDOW' });
      await expect(fns.email_attachments_digest({ mail_message_id: mid, digest_key: KEY }, pool)).rejects.toThrow(/^email_attachments_digest: message \d+ is not queued under digest "docs@"/);
      await expect(fns.email_attachments_digest({ mail_message_id: mid, digest_key: KEY, quiet: 'soon' }, pool)).rejects.toThrow(/^email_attachments_digest: quiet must be a duration like "5m" \(got "soon"\)$/);
      const r = await fileQ(mid);
      await ago(mid, 400);
      const s = await check(mid);
      expect(s.action).toBe('send');
      await digest.record(pool, { digestKey: KEY, mailMessageId: mid, result: { overwritten: true } });
      const [row] = await q('SELECT result FROM mail_attachment_notices WHERE mail_message_id = ?', [mid]);
      expect(JSON.parse(row.result).notice_html).toBe(r.notice_html);
    });

    test('through the registry: quiet / cap as durations, output_var', async () => {
      const mid = await message({ from: 'y@x.com', attachments: [pdf(2)] });
      await fns.email_attachments_file({ mail_message_id: mid, digest_key: KEY }, pool);
      await ago(mid, 61);
      const w = await fns.email_attachments_digest({ mail_message_id: String(mid), digest_key: KEY, quiet: '1m', cap: '10m', output_var: 'digest' }, pool);
      expect(w.output.action).toBe('send');                         // 61 s ≥ a 1-minute quiet
      expect(w.set_vars.digest).toBe(w.output);
    });
  });
});
