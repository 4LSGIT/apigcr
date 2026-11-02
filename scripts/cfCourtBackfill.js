#!/usr/bin/env node
// scripts/cfCourtBackfill.js
//
/**
 * Fill cf_court (cases.custom '$.cf_court', the Court select — field_defs id 3)
 * on cases whose court the record already proves. Forward writes are the
 * trigger rule "Stamp cf_court from the court email sender" (rule 24,
 * local/court_rule_draft.md); this is the one-off backfill behind it.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production):
 *
 *   node scripts/cfCourtBackfill.js           # CHECK — read-only, prints the plan
 *   node scripts/cfCourtBackfill.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: every UPDATE is guarded on the virtual column being empty, so a
 * re-run writes only what is still missing.
 *
 * ── EVIDENCE, AND THE AGREEMENT RULE ───────────────────────────────────────
 *   email    court_ai_log rows resolved to the case, joined to email_log by
 *            message_id: the sender's uscourts.gov subdomain names the court
 *            (DOMAIN_MAP; psc.uscourts.gov is the PACER service center, not a
 *            court, and deliberately unmapped). Any case type.
 *   suffix   the judge suffix on case_number_full (26-42040-mar → mar), via
 *            SUFFIX_MAP. Bankruptcy cases only — other dockets don't carry it.
 *   judge    case_judge's surname via JUDGE_MAP. Bankruptcy only, same reason.
 * Every piece of evidence a case has must name the SAME court — a
 * disagreement is reported and nothing is written. A judge/suffix pair naming
 * two different MIEB judges still agrees (the rule compares courts, not
 * judges; reassignments are common). No evidence, no write: a docketed
 * bankruptcy case with none is listed for a human. No docket, no court —
 * mirrors the caption rule (lib/caseCaption.js).
 *
 * The maps are frozen literals ON PURPOSE (the HISTORIC convention): this
 * script is the record of its run. Values are asserted against the live
 * cf_court def's ACTIVE options before anything else, so a renamed option
 * value turns the whole run into a NO-GO rather than writing stale tokens.
 * Judges verified against the live book 2026-11-02 (suffix × case_judge
 * crosscheck); jtg = John T. Gregg is the one W.D. Mich. entry seen.
 *
 * ── WRITES ─────────────────────────────────────────────────────────────────
 * One guarded UPDATE per case: JSON_SET on the custom bag, only while the
 * cf_court virtual column is still empty. A deliberate one-off UPDATE is the
 * sanctioned backfill path (ref/CUSTOM_FIELDS_DESIGN.md §3 default_value
 * note); it skips updateCase so 400 writes emit no case.updated fan-out.
 * The plan is written to local/cf-court-backfill-<stamp>.json before the
 * first UPDATE; every planned row is read back after, and a fresh plan must
 * come back empty.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Sender subdomain → court short name. psc = PACER service center: unmapped.
const DOMAIN_MAP = { mieb: 'MIEB', miwb: 'MIWB', mied: 'MIED', nysd: 'NYSD', ca6: 'USCOA' };
// Judge suffix on a bankruptcy docket → court. All E.D. Mich. but jtg.
const SUFFIX_MAP = {
  mar: 'MIEB', tjt: 'MIEB', mlo: 'MIEB', lsg: 'MIEB', prh: 'MIEB',
  jda: 'MIEB', dob: 'MIEB', mbm: 'MIEB', pjs: 'MIEB',
  jtg: 'MIWB',
};
// case_judge surname → court. Bankruptcy judges only, by design.
const JUDGE_MAP = {
  randon: 'MIEB', tucker: 'MIEB', oxholm: 'MIEB', gretchko: 'MIEB',
  hage: 'MIEB', mcivor: 'MIEB', applebaum: 'MIEB', opperman: 'MIEB',
  shefferly: 'MIEB',
  gregg: 'MIWB',
};

const isBlank = (v) => !String(v == null ? '' : v).trim();

/** Sender → court short name, or null. Matches the trigger rule's transform. */
function courtFromSender(fromEmail) {
  const m = String(fromEmail || '').toLowerCase().match(/@([a-z0-9-]+)\.uscourts\.gov$/);
  return (m && DOMAIN_MAP[m[1]]) || null;
}

/** Bankruptcy full docket → court via the judge suffix, or null. */
function courtFromSuffix(caseNumberFull) {
  const m = String(caseNumberFull || '').trim().toLowerCase().match(/-([a-z]+)$/);
  return (m && SUFFIX_MAP[m[1]]) || null;
}

/** case_judge free text → court via the surname, or null. */
function courtFromJudge(caseJudge) {
  const words = String(caseJudge || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const w of words) if (JUDGE_MAP[w]) return JUDGE_MAP[w];
  return null;
}

/**
 * The whole plan, pure.
 * @param {object} input
 * @param {Array} input.cases    case_id, case_number, case_number_full,
 *                               case_type, case_judge, cf_court
 * @param {Array} input.senders  { case_id, from_email, n } — court_ai_log
 *                               rows resolved to the case × email_log sender
 * @returns {{writes: Array, conflicts: Array, noEvidence: Array}}
 *   writes: { case_id, to, evidence: ['email:MIEB', ...] }
 */
function buildPlan({ cases, senders }) {
  const emailCourts = new Map(); // case_id → Set(court)
  for (const s of senders) {
    const court = courtFromSender(s.from_email);
    if (!court) continue;
    if (!emailCourts.has(s.case_id)) emailCourts.set(s.case_id, new Set());
    emailCourts.get(s.case_id).add(court);
  }

  const writes = [];
  const conflicts = [];
  const noEvidence = [];
  for (const c of cases) {
    if (!isBlank(c.cf_court)) continue;                                   // already set
    if (isBlank(c.case_number) && isBlank(c.case_number_full)) continue;  // no docket, no court

    const bk = c.case_type === 'Bankruptcy';
    const evidence = [];
    const fromEmails = emailCourts.get(c.case_id);
    if (fromEmails) for (const court of fromEmails) evidence.push(['email', court]);
    const sfx = bk ? courtFromSuffix(c.case_number_full) : null;
    if (sfx) evidence.push(['suffix', sfx]);
    const jdg = bk ? courtFromJudge(c.case_judge) : null;
    if (jdg) evidence.push(['judge', jdg]);

    if (!evidence.length) {
      if (bk) noEvidence.push(c.case_id);
      continue;
    }
    const courts = [...new Set(evidence.map(([, court]) => court))];
    if (courts.length > 1) {
      conflicts.push({ case_id: c.case_id, evidence: evidence.map((e) => e.join(':')) });
      continue;
    }
    writes.push({ case_id: c.case_id, to: courts[0], evidence: evidence.map((e) => e.join(':')) });
  }
  return { writes, conflicts, noEvidence };
}

function query(conn, sql, params) {
  return new Promise((resolve, reject) => {
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function readInput(conn) {
  const cases = await query(conn, `SELECT case_id, case_number, case_number_full,
      case_type, case_judge, cf_court FROM cases`);
  const senders = await query(conn, `SELECT cal.resolved_case_id AS case_id,
      el.from_email, COUNT(*) AS n
    FROM court_ai_log cal
    JOIN email_log el ON el.message_id = cal.message_id
    WHERE cal.resolved_case_id IS NOT NULL
    GROUP BY cal.resolved_case_id, el.from_email`);
  return { cases, senders };
}

/** NO-GO unless the live cf_court def is active and holds every map value as
 *  an ACTIVE option — the script writes raw tokens, so the registry is the
 *  truth it must match. */
async function assertRegistry(conn) {
  const col = await query(conn, `SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases' AND COLUMN_NAME = 'cf_court'
      AND GENERATION_EXPRESSION <> ''`);
  if (!col.length) return 'cases.cf_court virtual column is missing (reconciler not run?)';
  const defs = await query(conn, `SELECT options FROM field_defs
    WHERE entity = 'case' AND field_key = 'cf_court' AND active = 1`);
  if (!defs.length) return 'no active cf_court def on cases';
  let options = defs[0].options;
  if (typeof options === 'string') options = JSON.parse(options);
  const active = new Set((options || [])
    .filter((o) => o && o.active !== false)
    .map((o) => o.value));
  const needed = new Set([
    ...Object.values(DOMAIN_MAP), ...Object.values(SUFFIX_MAP), ...Object.values(JUDGE_MAP),
  ]);
  const missing = [...needed].filter((v) => !active.has(v));
  if (missing.length) return `map value(s) not an active cf_court option: ${missing.join(', ')}`;
  return null;
}

async function run(conn, { apply = false, log = console.log, ledgerDir } = {}) {
  const bad = await assertRegistry(conn);
  if (bad) {
    const line = `NO-GO — ${bad}. Nothing was changed.`;
    log(line);
    return { ok: false, line };
  }

  const plan = buildPlan(await readInput(conn));
  log(`Planned: ${plan.writes.length} case(s) to stamp.`);
  const byCourt = {};
  for (const w of plan.writes) byCourt[w.to] = (byCourt[w.to] || 0) + 1;
  for (const [court, n] of Object.entries(byCourt)) log(`  ${court}: ${n}`);
  for (const c of plan.conflicts) log(`  CONFLICT, skipped: ${c.case_id} (${c.evidence.join(', ')})`);
  log(`  docketed bankruptcy cases with no evidence, left alone: ${plan.noEvidence.length}`);

  if (!apply) {
    const line = plan.writes.length
      ? `GO — ${plan.writes.length} case(s) to stamp. Next: node scripts/cfCourtBackfill.js --apply`
      : 'GO — nothing to write.';
    log(line);
    return { ok: true, line, plan };
  }

  const dir = ledgerDir || path.join(__dirname, '..', 'local');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, `cf-court-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(ledger, JSON.stringify(plan, null, 1));
  log(`Plan saved: ${ledger}`);

  for (const w of plan.writes) {
    await query(conn, `UPDATE cases SET custom = JSON_SET(custom, '$.cf_court', ?)
      WHERE case_id = ? AND (cf_court IS NULL OR cf_court = '')`, [w.to, w.case_id]);
  }

  const after = await query(conn, 'SELECT case_id, cf_court FROM cases');
  const now = new Map(after.map((r) => [r.case_id, r.cf_court]));
  const wrong = plan.writes.filter((w) => now.get(w.case_id) !== w.to);
  const again = buildPlan(await readInput(conn));
  const line = wrong.length || again.writes.length
    ? `NO-GO — ${wrong.length} row(s) do not read as planned, ${again.writes.length} still planned. Re-run node scripts/cfCourtBackfill.js`
    : `GO — ${plan.writes.length} court(s) written and read back. ${plan.conflicts.length} conflict(s), ${plan.noEvidence.length} no-evidence case(s) left for staff.`;
  log(line);
  return { ok: !wrong.length && !again.writes.length, line, plan, ledger };
}

module.exports = { buildPlan, courtFromSender, courtFromSuffix, courtFromJudge, run,
                   DOMAIN_MAP, SUFFIX_MAP, JUDGE_MAP };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
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
      });
      const r = await run(conn, { apply: process.argv.includes('--apply') });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — could not finish. Paste this output.`);
      process.exitCode = 1;
    } finally {
      if (conn) conn.end();
    }
  })();
}
