#!/usr/bin/env node
// scripts/caseCaptionBackfill.js
//
/**
 * Fill cases.case_caption on docketed cases, by the rules in lib/caseCaption.js.
 *
 * USAGE (from the repo root, on a machine whose .env reaches production):
 *
 *   node scripts/caseCaptionBackfill.js           # CHECK — read-only, prints the plan
 *   node scripts/caseCaptionBackfill.js --apply   # run it
 *
 * Both end with ONE line: GO or NO-GO, naming the next command. --apply is
 * resumable: it reads the live state every time and only ever fills an empty
 * caption or adds a missing "In re".
 *
 * ── WHERE A CAPTION COMES FROM, BEST FIRST ────────────────────────────────
 *   1. court   the most frequent name on the case's court email: ECF's literal
 *              "Case Name:" in email_log (since 2025-05), then court_ai_log.
 *   2. contact a main bankruptcy case with no court email: the Primary
 *              contact's name. Right person, approximate wording: it matched
 *              the court's text exactly on 37 of 97 cases. Fred's ruling
 *              2026-11-01: fill them anyway.
 *   3. hand    printed, never written. A main bankruptcy case holding a
 *              Secondary (2 of 6 were not joint debtors, and the joint order
 *              is unknowable here) and an adversary with no court email.
 * Everything else stays blank: no docket means no caption, and a non-bankruptcy
 * case with no court email is typed by staff.
 *
 * ── normalize ─────────────────────────────────────────────────────────────
 * Court adopts before lib/caseCaption.js stamped the bare name. A main
 * bankruptcy caption with no "In re" gains one, the only change ever made to
 * a caption that already has text.
 *
 * ── AFTER --apply ─────────────────────────────────────────────────────────
 * Every planned case reads what was planned, and CHECK plans nothing more. The
 * old value of each row is written to local/case-caption-backfill-<stamp>.json
 * BEFORE the first UPDATE; restoring those values is the rollback.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { captionFromCourtName } = require('../lib/caseCaption');

const EXPECTED_CAPTION_TYPE = 'varchar(150)';
const EMAIL_PAGE = 500;

const isBlank = (v) => !String(v == null ? '' : v).trim();
const bareDocket = (d) => String(d).trim().toLowerCase().replace(/-[a-z]+$/, '');

/** ECF's "Case Name:" line out of an email body. '' when it has none. */
function courtNameFromBody(body) {
  const m = /Case Name:[\s*]*([\s\S]*?)[\s*]*Case Number/.exec(String(body || ''));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** "Case Number:" out of an email body, as the court printed it. */
function docketFromBody(body) {
  const m = /Case Number:[\s*]*([^\s*<]+)/.exec(String(body || ''));
  return m ? m[1].trim() : '';
}

/** docket → case_id for every docket form. A form two cases share is null. */
function docketIndex(cases) {
  const index = new Map();
  const put = (key, id) => {
    if (!key) return;
    if (index.has(key) && index.get(key) !== id) index.set(key, null);
    else index.set(key, id);
  };
  for (const c of cases) {
    for (const d of [c.case_number, c.case_number_full]) {
      if (isBlank(d)) continue;
      put(String(d).trim().toLowerCase(), c.case_id);
      put(bareDocket(d), c.case_id);
    }
  }
  return index;
}

/** The case's most frequent court name. A tie goes to the first one seen. */
function bestName(counts) {
  let best = '';
  let top = 0;
  for (const [name, n] of counts) if (n > top) { best = name; top = n; }
  return best;
}

/**
 * The whole plan, pure.
 * @param {object} input
 * @param {Array} input.cases     case_id, case_number, case_number_full,
 *                                case_type, case_subtype, case_caption
 * @param {Array} input.relates   case_id, relate_type, contact_name
 * @param {Array} input.emails    { docket, name } literal, from email_log
 * @param {Array} input.aiNames   { case_id, name, n } from court_ai_log
 * @returns {{writes: Array, hand: Array, sharedDockets: Array}}
 *   writes: { case_id, from, to, source: 'court'|'contact'|'normalize' }
 */
function buildPlan({ cases, relates, emails, aiNames }) {
  const index = docketIndex(cases);
  const names = new Map();     // case_id → Map(name → count)
  const count = (id, name, n) => {
    if (!names.has(id)) names.set(id, new Map());
    const m = names.get(id);
    m.set(name, (m.get(name) || 0) + n);
  };

  const sharedDockets = new Set();
  for (const e of emails) {
    if (isBlank(e.name) || isBlank(e.docket)) continue;
    const key = String(e.docket).trim().toLowerCase();
    let id = index.get(key);
    if (id === undefined) id = index.get(bareDocket(key));
    if (id === null) sharedDockets.add(e.docket);
    else if (id !== undefined) count(id, e.name, 1);
  }
  // The literal email wins for a case it covers; the AI log fills the rest.
  const literal = new Set(names.keys());
  for (const a of aiNames) {
    if (!isBlank(a.name) && !literal.has(a.case_id)) count(a.case_id, a.name, Number(a.n) || 1);
  }

  const people = new Map();
  for (const r of relates) {
    if (!people.has(r.case_id)) people.set(r.case_id, []);
    people.get(r.case_id).push(r);
  }

  const writes = [];
  const hand = [];
  for (const c of cases) {
    const main = c.case_type === 'Bankruptcy' && c.case_subtype !== 'Adversary Proceeding';
    if (!isBlank(c.case_caption)) {
      const fixed = main ? captionFromCourtName(c, c.case_caption) : null;
      if (fixed && fixed !== c.case_caption) {
        writes.push({ case_id: c.case_id, from: c.case_caption, to: fixed, source: 'normalize' });
      }
      continue;
    }
    if (isBlank(c.case_number) && isBlank(c.case_number_full)) continue;

    const court = names.has(c.case_id) ? bestName(names.get(c.case_id)) : '';
    const stamped = court ? captionFromCourtName(c, court) : null;
    if (stamped) {
      writes.push({ case_id: c.case_id, from: c.case_caption, to: stamped, source: 'court' });
      continue;
    }

    const rel = people.get(c.case_id) || [];
    if (c.case_type === 'Bankruptcy' && !main) {
      hand.push({ case_id: c.case_id, why: 'adversary with no court email' });
    } else if (main) {
      const primary = rel.find((r) => r.relate_type === 'Primary');
      if (rel.some((r) => r.relate_type === 'Secondary')) {
        hand.push({ case_id: c.case_id, why: `Secondary on the case: ${rel.map((r) => r.contact_name).join(' / ')}` });
      } else if (primary && !isBlank(primary.contact_name)) {
        writes.push({ case_id: c.case_id, from: c.case_caption,
          to: captionFromCourtName(c, primary.contact_name), source: 'contact' });
      } else {
        hand.push({ case_id: c.case_id, why: 'no Primary contact name' });
      }
    }
  }
  return { writes, hand, sharedDockets: [...sharedDockets] };
}

function query(conn, sql, params) {
  return new Promise((resolve, reject) => {
    conn.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function readInput(conn) {
  const cases = await query(conn, `SELECT case_id, case_number, case_number_full, case_type,
      case_subtype, case_caption FROM cases`);
  const relates = await query(conn, `SELECT cr.case_relate_case_id AS case_id,
      cr.case_relate_type AS relate_type, ct.contact_name
    FROM case_relate cr JOIN contacts ct ON ct.contact_id = cr.case_relate_client_id
    WHERE cr.case_relate_type IN ('Primary', 'Secondary')`);
  const aiNames = await query(conn, `SELECT resolved_case_id AS case_id, case_name AS name, COUNT(*) AS n
    FROM court_ai_log WHERE case_name <> '' AND resolved_case_id IS NOT NULL
    GROUP BY resolved_case_id, case_name`);
  const emails = [];
  for (let offset = 0; ; offset += EMAIL_PAGE) {
    const rows = await query(conn, `SELECT body FROM email_log
      WHERE from_email LIKE '%uscourts.gov%' AND body LIKE '%Case Name:%'
      ORDER BY id LIMIT ? OFFSET ?`, [EMAIL_PAGE, offset]);
    for (const r of rows) {
      emails.push({ docket: docketFromBody(r.body), name: courtNameFromBody(r.body) });
    }
    if (rows.length < EMAIL_PAGE) break;
  }
  return { cases, relates, emails, aiNames };
}

async function run(conn, { apply = false, log = console.log, ledgerDir } = {}) {
  const [col] = await query(conn, `SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cases' AND COLUMN_NAME = 'case_caption'`);
  if (!col || col.t !== EXPECTED_CAPTION_TYPE) {
    const line = `NO-GO — cases.case_caption is ${col ? col.t : 'missing'}, expected ${EXPECTED_CAPTION_TYPE}. Nothing was changed.`;
    log(line);
    return { ok: false, line };
  }

  const plan = buildPlan(await readInput(conn));
  const by = (s) => plan.writes.filter((w) => w.source === s).length;
  log(`Planned: ${by('court')} from the court, ${by('contact')} from the Primary contact, ${by('normalize')} gaining "In re".`);
  for (const h of plan.hand) log(`  by hand: ${h.case_id}: ${h.why}`);
  for (const d of plan.sharedDockets) log(`  docket on two cases, skipped: ${d}`);
  for (const w of plan.writes.filter((x) => x.source === 'normalize')) log(`  normalize ${w.case_id}: ${w.from} → ${w.to}`);

  const tooLong = plan.writes.filter((w) => !w.to || w.to.length > 150);
  if (tooLong.length) {
    const line = `NO-GO — ${tooLong.length} planned caption(s) empty or over 150 characters. Nothing was changed.`;
    log(line);
    return { ok: false, line, plan };
  }

  if (!apply) {
    const line = plan.writes.length
      ? `GO — ${plan.writes.length} caption(s) to write. Next: node scripts/caseCaptionBackfill.js --apply`
      : 'GO — nothing to write.';
    log(line);
    return { ok: true, line, plan };
  }

  const dir = ledgerDir || path.join(__dirname, '..', 'local');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, `case-caption-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(ledger, JSON.stringify(plan.writes, null, 1));
  log(`Old values saved: ${ledger}`);

  for (const w of plan.writes) {
    const guard = w.source === 'normalize'
      ? 'case_caption = ?'
      : "(case_caption IS NULL OR case_caption = '')";
    await query(conn, `UPDATE cases SET case_caption = ? WHERE case_id = ? AND ${guard}`,
      w.source === 'normalize' ? [w.to, w.case_id, w.from] : [w.to, w.case_id]);
  }

  const after = await query(conn, 'SELECT case_id, case_caption FROM cases');
  const now = new Map(after.map((r) => [r.case_id, r.case_caption]));
  const wrong = plan.writes.filter((w) => now.get(w.case_id) !== w.to);
  const again = buildPlan(await readInput(conn));
  const line = wrong.length || again.writes.length
    ? `NO-GO — ${wrong.length} row(s) do not read as planned, ${again.writes.length} still planned. Re-run node scripts/caseCaptionBackfill.js`
    : `GO — ${plan.writes.length} caption(s) written and read back. ${plan.hand.length} left by hand.`;
  log(line);
  return { ok: !wrong.length && !again.writes.length, line, plan, ledger };
}

module.exports = { buildPlan, courtNameFromBody, docketFromBody, run };

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
