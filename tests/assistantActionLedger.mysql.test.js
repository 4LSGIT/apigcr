// Own local *_test DB only. Runs the real ledger, DDL, SQL and mysql2 types.
'use strict';
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const ledger = require('../services/assistantActionLedger');
const migration = require('../scripts/caseyP5Ledger');
const URL_ = process.env.YC_TEST_MYSQL_URL;
const suite = URL_ ? describe : describe.skip;
suite('P5 ledger on real MySQL', () => {
  let db;
  const q = async (sql, params = []) => (await db.query(sql, params))[0];
  const draft = (kind = 'task.create.v1') => ({ draft_id: crypto.randomUUID(), kind });
  const issue = async kind => { const d = draft(kind); await ledger.issue(db, 6, d); return d; };
  beforeAll(async () => {
    const url = new URL(URL_);
    if (!/_test$/.test(url.pathname) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Own local *_test DB required');
    db = mysql.createPool({ uri: URL_, connectionLimit: 5, timezone: 'Z' });
    await q('DROP TABLE IF EXISTS assistant_action_ledger');
    await q('DROP TABLE IF EXISTS users');
    await q('CREATE TABLE users (`user` TINYINT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await q('INSERT INTO users VALUES (0),(6),(7)');
  });
  afterAll(async () => { if (db) await db.end(); });
  test('migration CHECK is read-only, apply resumes, shape and relaxed mode are enforced', async () => {
    const conn = await db.getConnection();
    try {
      const check = await migration.run(conn, { log: () => {} });
      expect([check.line, await migration.state(conn)]).toEqual(['CHECK OK — GO. Next: node scripts/caseyP5Ledger.js --apply', false]);
      const first = await migration.run(conn, { apply: true, log: () => {} });
      const again = await migration.run(conn, { apply: true, log: () => {} });
      expect([first.ok, again.ok, await migration.state(conn)]).toEqual([true, true, true]);
      await q('ALTER TABLE assistant_action_ledger MODIFY kind VARCHAR(63) NOT NULL');
      expect((await migration.run(conn, { apply: true, log: () => {} })).line).toMatch(/^NO-GO/);
      await q('ALTER TABLE assistant_action_ledger MODIFY kind VARCHAR(64) NOT NULL');
      await conn.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
      expect((await migration.run(conn, { log: () => {} })).line).toMatch(/^NO-GO/);
    } finally { await conn.query("SET SESSION sql_mode='IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'"); conn.release(); }
  });
  test('all 33 kinds register without evidence; duplicate issuance, foreign actors and malformed inputs are refused', async () => {
    const outcomes = [];
    for (const [kind] of ledger.KINDS) {
      const d = await issue(kind);
      outcomes.push((await ledger.read(db, 6, [d.draft_id]))[0].outcome);
    }
    const d = await issue();
    const errors = [];
    for (const op of [() => ledger.issue(db, 6, d), () => ledger.issue(db, 99, draft()),
      () => ledger.issue(db, 6, draft('task.create.v2')), () => ledger.issue(db, 128, draft()),
      () => ledger.claim(db, 6, 'a'.repeat(37)), () => ledger.read(db, 6, Array(221).fill(d.draft_id)),
      () => ledger.claim(db, 7, d.draft_id)]) {
      try { await op(); errors.push('accepted'); } catch (e) { errors.push(e.status || e.code); }
    }
    expect({ count: ledger.KINDS.size, outcomes: [...new Set(outcomes)], errors,
      foreignRead: await ledger.read(db, 7, [d.draft_id]) }).toEqual({ count: 35, outcomes: ['not-applied'],
      errors: ['ER_DUP_ENTRY', 'ER_NO_REFERENCED_ROW_2', 400, 403, 400, 400, 404], foreignRead: [] });
  });
  test('committed claim fences two tabs, a business rollback cannot release it, and fresh or old claims remain unknown', async () => {
    const d = await issue();
    const claims = await Promise.all([ledger.claim(db, 6, d.draft_id), ledger.claim(db, 6, d.draft_id)]);
    const winner = claims.find(c => c.claimed);
    const conn = await db.getConnection();
    let transactionError;
    try {
      await conn.beginTransaction();
      try { await ledger.claim(conn, 6, d.draft_id); } catch (e) { transactionError = e.message; }
      await conn.rollback();
    } finally { conn.release(); }
    const fresh = await ledger.claim(db, 6, d.draft_id);
    await q('UPDATE assistant_action_ledger SET updated_at=NOW()-INTERVAL 1 YEAR WHERE draft_id=?', [d.draft_id]);
    const old = await ledger.claim(db, 6, d.draft_id);
    const [[row]] = await db.query('SELECT created_at, status FROM assistant_action_ledger WHERE draft_id=?', [d.draft_id]);
    expect({ winners: claims.filter(c => c.claimed).length, winner: !!winner.claim_token, loser: claims.find(c => !c.claimed).outcome,
      fresh: fresh.outcome, old: old.outcome, date: row.created_at instanceof Date, status: row.status, transactionError })
      .toEqual({ winners: 1, winner: true, loser: 'unknown', fresh: 'unknown', old: 'unknown', date: true, status: 'in_flight',
        transactionError: 'Action ledger requires the database pool, not a transaction connection' });
  });
  test('expired and unissued drafts cannot be claimed', async () => {
    const d = await issue();
    await q('UPDATE assistant_action_ledger SET created_at=NOW()-INTERVAL 16 MINUTE WHERE draft_id=?', [d.draft_id]);
    await expect(ledger.claim(db, 6, d.draft_id)).rejects.toMatchObject({ status: 409 });
    await expect(ledger.claim(db, 6, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });
  test('only the claim holder can record one immutable minimal receipt; concurrent and lost acknowledgements replay', async () => {
    const outcomes = [];
    for (const [kind, field] of ledger.KINDS) {
      const d = await issue(kind); const claim = await ledger.claim(db, 6, d.draft_id);
      const result = { [field]: 71 };
      const errors = [];
      for (const op of [() => ledger.record(db, 7, d.draft_id, claim.claim_token, result),
        () => ledger.record(db, 6, d.draft_id, crypto.randomUUID(), result),
        () => ledger.record(db, 6, d.draft_id, claim.claim_token, { ...result, evidence: 'private' }),
        () => ledger.record(db, 6, d.draft_id, claim.claim_token, { [field]: 0 })]) {
        try { await op(); errors.push('accepted'); } catch (e) { errors.push(e.status); }
      }
      const saved = await Promise.all([ledger.record(db, 6, d.draft_id, claim.claim_token, result), ledger.record(db, 6, d.draft_id, claim.claim_token, result)]);
      let replacement;
      try { await ledger.record(db, 6, d.draft_id, claim.claim_token, { [field]: 72 }); } catch (e) { replacement = e.status; }
      const replay = await ledger.claim(db, 6, d.draft_id);
      const [row] = await ledger.read(db, 6, [d.draft_id]);
      outcomes.push({ errors, saved: saved.map(r => r.replayed).sort(), replacement, replayed: replay.replayed, result: row.result });
    }
    expect(outcomes).toEqual([...ledger.KINDS].map(([, field]) => ({ errors: [404, 404, 400, 400], saved: [false, true],
      replacement: 409, replayed: true, result: { [field]: 71 } })));
  });
  test('real JWT routes register server output, enforce ownership, and only record/reconcile receipts', async () => {
    process.env.JWT_SECRET = 'p5-local-test-secret';
    const express = require('express'); const jwt = require('jsonwebtoken');
    const svc = require('../services/assistantService');
    const d = draft();
    const execute = jest.spyOn(svc, 'execute').mockResolvedValue({ answer: 'Prepared', action_draft: d });
    await q(`CREATE TABLE IF NOT EXISTS jwt_api_audit_log (
      route TEXT, method TEXT, headers TEXT, query_params TEXT, body TEXT,
      ip_address TEXT, user_agent TEXT, auth_type TEXT, username TEXT, auth_status TEXT)`);
    const app = express(); app.use(express.json()); app.use((req, res, next) => { req.db = db; next(); });
    app.use(require('../routes/api.assistant'));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const token = (userId, aud = 'staff') => jwt.sign({ sub: userId, username: 'fixture', user_auth: 'authorized', aud,
      ...(process.env.JWT_VERSION ? { ver: Number(process.env.JWT_VERSION) } : {}) }, process.env.JWT_SECRET);
    const post = async (path, body, auth) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/assistant/${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
      return { code: r.status, body: await r.json() };
    };
    try {
      const missing = await post(`actions/${d.draft_id}/claim`, {});
      const portal = await post(`actions/${d.draft_id}/claim`, {}, token(6, 'contact'));
      await post('execute', { ticket: 'fixture' }, token(6));
      const legacyRows = await ledger.read(db, 6, [d.draft_id]);
      const proposed = await post('execute', { ticket: 'fixture', action_ledger_version: 1 }, token('6'));
      const foreign = await post(`actions/${d.draft_id}/claim`, {}, token(7));
      const claimed = await post(`actions/${d.draft_id}/claim`, {}, token('6'));
      const unknown = await post(`actions/${d.draft_id}/claim`, {}, token(6));
      const recorded = await post(`actions/${d.draft_id}/result`, { claim_token: claimed.body.claim_token, result: { task_id: 92 } }, token(6));
      const reconciled = await post('actions/reconcile', { draft_ids: [d.draft_id] }, token(6));
      const hidden = await post('actions/reconcile', { draft_ids: [d.draft_id] }, token(7));
      expect({ codes: [missing.code, portal.code, proposed.code, foreign.code, claimed.code, unknown.code, recorded.code],
        legacyRows, claimed: claimed.body.claimed, unknown: unknown.body.outcome, issued: proposed.body.action_draft,
        visible: reconciled.body.actions, hidden: hidden.body.actions })
        .toEqual({ legacyRows: [], codes: [401, 401, 200, 404, 200, 200, 200], claimed: true, unknown: 'unknown', issued: d,
          visible: [{ ...d, outcome: 'applied', result: { task_id: 92 } }], hidden: [] });
    } finally { execute.mockRestore(); await new Promise(resolve => server.close(resolve)); }
  });
  test('old kind versions remain readable and user deletion cascades the receipts', async () => {
    const d = await issue();
    await q("UPDATE assistant_action_ledger SET kind='task.create.v0',status='applied',result=JSON_OBJECT('task_id',81) WHERE draft_id=?", [d.draft_id]);
    expect(await ledger.read(db, 6, [d.draft_id])).toEqual([{ ...d, kind: 'task.create.v0', outcome: 'applied', result: { task_id: 81 } }]);
    await q('DELETE FROM users WHERE `user`=6');
    expect(await ledger.read(db, 6, [d.draft_id])).toEqual([]);
  });
});
