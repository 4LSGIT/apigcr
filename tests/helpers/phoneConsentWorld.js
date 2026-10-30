// tests/helpers/phoneConsentWorld.js
//
/**
 * An in-memory world for services/phoneConsentService.js (YisraMail P2) — the
 * CI-run twin of tests/phoneConsent.mysql.test.js, which holds the same paths
 * to real MySQL.
 *
 * Built on tests/helpers/contactConsentWorld.js (contacts, contact_phones and
 * the consent store answered by IDENTITY of optoutService's FIND_SQL /
 * WRITE_SQL, with the store's real semantics: UNIQUE (source,
 * provider_event_id) → ER_DUP_ENTRY, the guarded upsert, the cache sync), plus
 * every statement phoneConsentService issues itself — by identity of its
 * exported SQL where it exports one — and the tables around it: cases /
 * case_relate (the open-client predicate), tasks (the review dedupe),
 * scheduled_jobs (the Quo confirmation), comm_consent_events (the ledger
 * lookup), users (P3's unsubService.resolveAssignee: an ACTIVE assignee —
 * default user 22, authorized).
 *
 * TRANSACTIONS are real enough to order-assert: db.getConnection() hands out
 * a connection whose begin / commit / rollback land in W.order next to every
 * consent write ('event:<source>:<action>') and whatever a test pushes there
 * (its createTask mock pushes 'task'). A rollback does NOT undo the
 * in-memory writes — the tests that need a rollback use the mysql twin.
 *
 * `extra(sql, params)` answers a test's own statements first (phone_lines,
 * phone_event_log, GET_LOCK …); return undefined to fall through. Statements
 * nobody models land in W.unhandled2 (tasks / scheduled_jobs / cases) or the
 * base world's W.unhandled (contacts, phones, consent) — assert both empty.
 */
'use strict';

const { makeWorld } = require('./contactConsentWorld');
const svc = require('../../services/phoneConsentService');
const { WRITE_SQL } = require('../../services/optoutService');
const { UNSUB_SQL } = require('../../services/unsubService');

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function makePhoneConsentWorld({ contacts = [], phones = [], states = [], cases = [], tasks = [], jobs = [], users = [{ user: 22, user_auth: 'authorized' }], extra = null } = {}) {
  const W = makeWorld({ contacts, phones, states });
  W.users = users.map((u) => ({ ...u }));
  W.cases = cases.map((c) => ({ ...c }));          // [{ contact_id, case_id, relate_type, stage }]
  W.tasks = tasks.map((t) => ({ ...t }));          // [{ task_id, task_dedupe_key, task_status }]
  W.jobs = jobs.map((j) => ({ ...j }));            // [{ id, idempotency_key, status, data }]
  W.order = [];
  W.unhandled2 = [];
  let nextJob = 900;

  const S = {
    activeRow: norm(svc.ACTIVE_ROW_LOCK_SQL),
    openCase: norm(svc.OPEN_CLIENT_CASE_SQL),
    ledgerHas: 'SELECT id FROM comm_consent_events WHERE source = ? AND provider_event_id = ? LIMIT 1',
    name: 'SELECT contact_name FROM contacts WHERE contact_id = ?',
    activeContact: 'SELECT contact_id FROM contact_phones WHERE phone_active_uniq = ? LIMIT 1',
    openTask: 'SELECT task_id FROM tasks WHERE task_dedupe_key = ? AND task_status IN (?) ORDER BY task_id DESC LIMIT 1',
    touchTask: 'UPDATE tasks SET task_last_update = NOW() WHERE task_id = ?',
    stampTask: 'UPDATE tasks SET task_dedupe_key = ? WHERE task_id = ?',
    jobByKey: 'SELECT id FROM scheduled_jobs WHERE idempotency_key = ? LIMIT 1',
    assignee: norm(UNSUB_SQL.assignee),
  };
  const activePhone = (dest) => W.phones.find((r) => r.end_date == null && String(r.phone) === String(dest));

  async function query(sql, p = []) {
    const s = norm(sql);
    if (extra) {
      const r = await extra(s, p, W);
      if (r !== undefined) return r;
    }
    if (s === WRITE_SQL.event) {
      const r = await W.db.query(sql, p);
      W.order.push(`event:${p[4]}:${p[3]}`);
      return r;
    }
    if (s === S.activeRow) {
      W.locks.push('row:active');
      const r = activePhone(p[0]);
      return [r ? [{ id: r.id, contact_id: r.contact_id, sms_optout: r.sms_optout }] : []];
    }
    if (s === S.ledgerHas) {
      const e = W.events.find((x) => x.source === p[0] && x.provider_event_id === p[1]);
      return [e ? [{ id: e.id }] : []];
    }
    if (s === S.openCase) {
      const c = W.cases.filter((x) => x.contact_id === Number(p[0]) && ['Primary', 'Secondary'].includes(x.relate_type)
        && ['Open', 'Pending', 'Filed'].includes(x.stage)).sort((a, b) => String(a.case_id).localeCompare(String(b.case_id)))[0];
      return [c ? [{ case_id: c.case_id }] : []];
    }
    if (s === S.name) {
      const c = W.contacts.find((x) => x.contact_id === Number(p[0]));
      return [c ? [{ contact_name: c.contact_name }] : []];
    }
    if (s === S.activeContact) {
      const r = activePhone(p[0]);
      return [r ? [{ contact_id: r.contact_id }] : []];
    }
    if (s === S.openTask) {
      const t = W.tasks.filter((x) => x.task_dedupe_key === p[0] && (p[1] || []).includes(x.task_status)).sort((a, b) => b.task_id - a.task_id)[0];
      return [t ? [{ task_id: t.task_id }] : []];
    }
    if (s === S.touchTask) { W.order.push(`touch:${p[0]}`); return [{ affectedRows: 1 }]; }
    if (s === S.stampTask) {
      const t = W.tasks.find((x) => x.task_id === Number(p[1]));
      if (t) t.task_dedupe_key = p[0];
      return [{ affectedRows: t ? 1 : 0 }];
    }
    if (s === S.assignee) {
      const u = W.users.find((x) => Number(x.user) === Number(p[0]) && /^authorized/.test(String(x.user_auth)));
      return [u ? [{ user: u.user }] : []];
    }
    if (s === S.jobByKey) {
      const j = W.jobs.find((x) => x.idempotency_key === p[0]);
      return [j ? [{ id: j.id }] : []];
    }
    if (/^INSERT INTO scheduled_jobs /.test(s)) {
      const id = nextJob++;
      W.jobs.push({ id, sql: s, name: p[0], data: JSON.parse(p[1]), idempotency_key: p[2], status: 'pending' });
      W.order.push(`job:${id}`);
      return [{ insertId: id, affectedRows: 1 }];
    }
    if (/\b(tasks|scheduled_jobs|case_relate|cases|users)\b/.test(s)) {
      W.unhandled2.push(s);
      return /^SELECT/.test(s) ? [[]] : [{ affectedRows: 0, insertId: 0 }];
    }
    return W.db.query(sql, p);
  }

  const conn = () => ({
    query,
    async beginTransaction() { W.order.push('begin'); },
    async commit() { W.order.push('commit'); },
    async rollback() { W.order.push('rollback'); },
    release() {},
    destroy() {},
  });

  W.pdb = { query, getConnection: async () => conn() };
  W.event = (pred) => W.events.filter(pred);
  return W;
}

module.exports = { makePhoneConsentWorld };
