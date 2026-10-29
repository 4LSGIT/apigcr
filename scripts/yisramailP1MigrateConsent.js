#!/usr/bin/env node
// scripts/yisramailP1MigrateConsent.js
//
/**
 * YisraMail P1 — today's row opt-out flags → the consent ledger + state.
 * ref/YISRAMAIL_DESIGN.md §4.4; tables from
 * ref/migrations/2026-10-29_yisramail_p1_consent_core.sql.
 *
 * For every ACTIVE row carrying a flag, ONE event through the one writer
 * (services/optoutService.recordConsent), on this connection, in its own
 * transaction:
 *   contact_phones.sms_optout = 1   → sms   scope 'all'        opt_out
 *   contact_emails.email_optout = 1 → email scope 'marketing'  opt_out  (D18)
 *   source 'migration', provider_event_id 'migration:phone:<row id>' /
 *   'migration:email:<row id>', occurred_at = the row's updated_at (UTC),
 *   contact_id = the row's, evidence { row_id, column }.
 * The UNIQUE (source, provider_event_id) makes a re-run a no-op per row, and
 * the state guard makes an event recorded after a NEWER consent change lose.
 * Ended rows are history and are not migrated (live 2026-10-29: none flagged).
 *
 * RUN IT TWICE — before the backend deploy AND after it — so a flag written
 * by the old code in the gap is picked up:
 *   1. the migration SQL (creates the tables)
 *   2. node scripts/yisramailP1MigrateConsent.js --apply
 *   3. backend deploy
 *   4. node scripts/yisramailP1MigrateConsent.js --apply
 *
 * USAGE (repo root, .env reaching production — the `npm run db:ref` setup):
 *   node scripts/yisramailP1MigrateConsent.js           # CHECK — read-only
 *   node scripts/yisramailP1MigrateConsent.js --apply   # migrate, then verify
 * Each ends with ONE line: GO or NO-GO, naming the next step.
 *
 * VERIFIED END STATE (check and --apply alike): every ACTIVE phone / email row's
 * flag equals its destination's state for the flag's scope (opted_out ⇔ 1; no
 * state row ⇔ 0). A row that disagrees AFTER --apply is NO-GO and is listed:
 *   flag 0, state opted_out  — someone cleared the flag through code that
 *                              bypassed the ledger (the old code, in the gap):
 *                              recording an opt_in is a consent decision, not
 *                              a migration (the re-consent guard) — a human
 *                              re-ticks or clears it on the contact form.
 *   flag 1, state opted_in   — a writer bypassed recordConsent: a bug to find.
 * Pure DB, one connection, no session settings beyond time_zone (+00:00, so
 * updated_at reads as UTC).
 */

'use strict';

const TABLES = ['comm_topics', 'comm_consent_events', 'comm_consent_state'];
const FAMILIES = Object.freeze([
  { channel: 'sms',   table: 'contact_phones', col: 'phone', flag: 'sms_optout',   key: 'phone', scope: 'all' },
  { channel: 'email', table: 'contact_emails', col: 'email', flag: 'email_optout', key: 'email', scope: 'marketing' },
]);

const SQL = Object.freeze({
  tables: `SELECT TABLE_NAME AS t FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
  destCollation: `SELECT TABLE_NAME AS t, COLLATION_NAME AS c FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('comm_consent_events', 'comm_consent_state')
                     AND COLUMN_NAME = 'destination'`,
  candidates: (f) => `SELECT r.id, r.contact_id, r.${f.col} AS destination,
                             DATE_FORMAT(r.updated_at, '%Y-%m-%d %H:%i:%s') AS at,
                             e.id AS event_id
                        FROM ${f.table} r
                        LEFT JOIN comm_consent_events e
                          ON e.source = 'migration' AND e.provider_event_id = CONCAT('migration:${f.key}:', r.id)
                       WHERE r.end_date IS NULL AND r.${f.flag} = 1
                       ORDER BY r.id`,
  mismatches: (f) => `SELECT r.id, r.contact_id, r.${f.col} AS destination, r.${f.flag} AS flag, s.state, s.last_event_id
                        FROM ${f.table} r
                        LEFT JOIN comm_consent_state s
                          ON s.channel = '${f.channel}' AND s.destination = r.${f.col} AND s.scope = '${f.scope}'
                       WHERE r.end_date IS NULL
                         AND r.${f.flag} <> (CASE WHEN s.state = 'opted_out' THEN 1 ELSE 0 END)
                       ORDER BY r.id`,
});

async function readState(conn) {
  const [present] = await conn.query(SQL.tables, [TABLES]);
  const have = new Set(present.map((r) => r.t));
  const missing = TABLES.filter((t) => !have.has(t));
  const out = { missing, collations: [], families: {} };
  if (missing.length) return out;
  const [coll] = await conn.query(SQL.destCollation);
  out.collations = coll.map((r) => `${r.t}.destination=${r.c}`);
  for (const f of FAMILIES) {
    const [cand] = await conn.query(SQL.candidates(f));
    const [mis] = await conn.query(SQL.mismatches(f));
    out.families[f.channel] = { candidates: cand, pending: cand.filter((r) => r.event_id == null), mismatches: mis };
  }
  return out;
}

function describeMismatch(f, r) {
  const why = Number(r.flag) === 1
    ? (r.state === 'opted_in' ? 'flag 1 but the state says opted_in — a writer bypassed the ledger' : 'flag 1, no state yet — migrate it')
    : 'flag 0 but the state says opted_out — the flag was cleared outside the ledger; re-tick or clear it on the contact form';
  return `${f.table} #${r.id} (contact ${r.contact_id}) ${r.destination}: ${why}`;
}

/**
 * CHECK (apply:false) or migrate (apply:true). → { ok, line, migrated }
 * `optout` is injectable for tests; production uses services/optoutService.
 */
async function run(conn, { apply = false, say = console.log, optout = require('../services/optoutService') } = {}) {
  await conn.query("SET SESSION time_zone = '+00:00'");
  let s = await readState(conn);
  if (s.missing.length) {
    const line = `NO-GO — missing table(s) ${s.missing.join(', ')}: run ref/migrations/2026-10-29_yisramail_p1_consent_core.sql first. Nothing was changed.`;
    say(line);
    return { ok: false, line, migrated: 0 };
  }
  const badColl = s.collations.filter((c) => !/=utf8mb4_general_ci$/.test(c));
  if (badColl.length) {
    const line = `NO-GO — destination collation is not utf8mb4_general_ci (${badColl.join('; ')}). Nothing was changed.`;
    say(line);
    return { ok: false, line, migrated: 0 };
  }
  for (const f of FAMILIES) {
    const st = s.families[f.channel];
    say(`${f.table}.${f.flag}: ${st.candidates.length} active flagged row(s), ${st.candidates.length - st.pending.length} already in the ledger, ${st.pending.length} to migrate`);
    for (const r of st.pending) say(`  · #${r.id} (contact ${r.contact_id}) ${r.destination}  updated_at ${r.at} UTC`);
  }

  if (!apply) {
    const others = FAMILIES.flatMap((f) => s.families[f.channel].mismatches
      .filter((r) => !(Number(r.flag) === 1 && r.state == null))
      .map((r) => describeMismatch(f, r)));
    if (others.length) {
      others.forEach((m) => say(`  ✗ ${m}`));
      const line = `NO-GO — ${others.length} row(s) disagree with the consent state in a way a migration cannot fix (listed above). Nothing was changed.`;
      say(line);
      return { ok: false, line, migrated: 0 };
    }
    const pending = FAMILIES.reduce((n, f) => n + s.families[f.channel].pending.length, 0);
    const line = pending
      ? `CHECK OK — GO. Next: node scripts/yisramailP1MigrateConsent.js --apply (${pending} row(s) to migrate)`
      : 'CHECK OK — nothing to migrate and every active flag agrees with the consent state. GO.';
    say(line);
    return { ok: true, line, migrated: 0 };
  }

  let migrated = 0;
  for (const f of FAMILIES) {
    for (const r of s.families[f.channel].pending) {
      await conn.beginTransaction();
      try {
        const res = await optout.recordConsent(conn, {
          channel: f.channel, destination: r.destination, scope: f.scope, action: 'opt_out',
          source: 'migration', providerEventId: `migration:${f.key}:${r.id}`,
          occurredAt: new Date(`${String(r.at).replace(' ', 'T')}Z`),
          contactId: r.contact_id, evidence: { row_id: Number(r.id), column: `${f.table}.${f.flag}` },
        });
        await conn.commit();
        if (!res.duplicate) migrated++;
        say(`  ✓ ${f.table} #${r.id} → event ${res.event_id == null ? '(already recorded)' : res.event_id}${res.duplicate || res.applied ? '' : ' (a newer consent change stands)'}`);
      } catch (err) {
        await conn.rollback().catch(() => {});
        const line = `NO-GO — ${f.table} #${r.id}: ${err.message}. ${migrated} row(s) migrated before it; re-running --apply resumes.`;
        say(line);
        return { ok: false, line, migrated };
      }
    }
  }

  s = await readState(conn);
  const left = FAMILIES.flatMap((f) => s.families[f.channel].pending.map((r) => `${f.table} #${r.id}`));
  const mis = FAMILIES.flatMap((f) => s.families[f.channel].mismatches.map((r) => describeMismatch(f, r)));
  if (left.length || mis.length) {
    left.forEach((m) => say(`  ✗ not in the ledger: ${m}`));
    mis.forEach((m) => say(`  ✗ ${m}`));
    const line = `NO-GO — the end state does not verify (${left.length} unmigrated, ${mis.length} disagreeing row(s) above). ${migrated} migrated this run.`;
    say(line);
    return { ok: false, line, migrated };
  }
  const line = `MIGRATED ${migrated} row(s); every active flag agrees with the consent state — GO. `
    + 'Before the backend deploy: deploy next, then run this --apply once more. After it: P1\'s migration is complete.';
  say(line);
  return { ok: true, line, migrated };
}

module.exports = { run, readState, SQL, FAMILIES, TABLES };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const path = require('path');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  (async () => {
    let conn;
    try {
      const proxy = await ensureSqlProxy();
      if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
      for (const k of ['host', 'user', 'password', 'database']) {
        if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
      }
      conn = mysql.createConnection({
        host: process.env.host, user: process.env.user, password: process.env.password,
        database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
      }).promise();
      const r = await run(conn, { apply });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not ${conn ? 'finish' : 'connect'}. Nothing was changed unless a line above says ✓.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
      // optoutService loads the row services, which load nothing that holds the loop open.
    }
  })();
}
