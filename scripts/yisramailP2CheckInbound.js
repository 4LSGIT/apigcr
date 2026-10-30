#!/usr/bin/env node
// scripts/yisramailP2CheckInbound.js
//
/**
 * YisraMail P2 — is inbound SMS wired so a STOP reaches the consent handler?
 * READ ONLY. ref/YISRAMAIL_DESIGN.md §4.6.
 *
 * Inbound texts reach phoneIngestService (and so the keyword handler) ONLY
 * through hooks → workflows 17 (wf_rc_message_in) / 18 (wf_quo_message) →
 * step 1 `phone_log`. Those are editable DB rows, so no jest test can pin
 * them: this script does, against the live definitions. It checks, for each
 * workflow:
 *   - the workflow exists and is active, with a published version;
 *   - step 1 OF THAT VERSION (what new executions run) is an
 *     internal_function step calling phone_log, with type 'sms', `from`,
 *     `message`, `direction` (the literal 'incoming' or a placeholder) and
 *     extra.provider (the expected literal), extra.provider_message_id and
 *     extra.ts wired;
 *   - an active hook has an active workflow target pointing at it.
 * Then prints, for information, the newest ingested inbound text per
 * provider (the liveness the nightly SMS consent run alerts on).
 *
 * USAGE (repo root):
 *   node scripts/yisramailP2CheckInbound.js
 *       — over the .env connection (the `npm run db:ref` setup), or
 *   YC_RO_KEY=ycro_… node scripts/yisramailP2CheckInbound.js
 *       — over the readonly SQL endpoint (YC_RO_URL overrides the host).
 * Ends with ONE line: GO or NO-GO. Writes nothing either way.
 */

'use strict';

const EXPECTED = Object.freeze([
  { id: 17, name: 'wf_rc_message_in', provider: 'ringcentral' },
  { id: 18, name: 'wf_quo_message', provider: 'quo' },
]);

const SQL = Object.freeze({
  workflow: 'SELECT id, name, active, current_version FROM workflows WHERE id = ?',
  step1: 'SELECT type, config FROM workflow_steps WHERE workflow_id = ? AND version = ? AND step_number = 1',
  hooks: `SELECT h.id, h.slug, h.active AS hook_active, t.id AS target_id, t.active AS target_active
            FROM hooks h JOIN hook_targets t ON t.hook_id = h.id
           WHERE t.target_type = 'workflow' AND JSON_EXTRACT(t.config, '$.workflow_id') = ?`,
  lastInbound: `SELECT processed_at FROM phone_event_log
                 WHERE provider = ? AND event_type = 'sms' AND direction = 'incoming'
                 ORDER BY processed_at DESC LIMIT 1`,
});

const PLACEHOLDER_RE = /^\{\{[^{}]+\}\}$/;
const asObj = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
const filled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * q(sql, params) → rows. → { ok, lines } (the caller prints the lines).
 */
async function checkInbound(q) {
  const lines = [];
  const problems = [];
  const bad = (msg) => { problems.push(msg); lines.push(`  ✗ ${msg}`); };
  const ok = (msg) => lines.push(`  ✓ ${msg}`);

  for (const e of EXPECTED) {
    lines.push(`workflow ${e.id} (${e.name}):`);
    const [wf] = await q(SQL.workflow, [e.id]);
    if (!wf) { bad(`wf ${e.id} does not exist`); continue; }
    if (Number(wf.active) !== 1) bad(`wf ${e.id} is not active`); else ok('active');
    const version = Number(wf.current_version);
    if (!Number.isInteger(version) || version < 1) { bad(`wf ${e.id} has no published version`); continue; }

    const [step] = await q(SQL.step1, [e.id, version]);
    if (!step) { bad(`wf ${e.id} v${version} has no step 1`); continue; }
    const cfg = asObj(step.config);
    const p = cfg.params || {};
    const ex = p.extra || {};
    if (step.type !== 'internal_function' || cfg.function_name !== 'phone_log') {
      bad(`wf ${e.id} v${version} step 1 is ${step.type} ${cfg.function_name || '(no function)'}, not phone_log`);
      continue;
    }
    ok(`v${version} step 1 is phone_log`);
    const before = problems.length;
    if (p.type !== 'sms') bad(`step 1 params.type is ${JSON.stringify(p.type)}, not "sms"`);
    if (!filled(p.from)) bad('step 1 params.from is not wired (the sender — the number that opts out)');
    if (!filled(p.message)) bad('step 1 params.message is not wired (the body the keyword is read from)');
    if (!(p.direction === 'incoming' || (typeof p.direction === 'string' && PLACEHOLDER_RE.test(p.direction.trim())))) {
      bad(`step 1 params.direction is ${JSON.stringify(p.direction)} — must be "incoming" or a placeholder`);
    }
    if (ex.provider !== e.provider) bad(`step 1 extra.provider is ${JSON.stringify(ex.provider)}, not "${e.provider}"`);
    if (!filled(ex.provider_message_id)) bad('step 1 extra.provider_message_id is not wired (the dedup key and the ledger id)');
    if (!filled(ex.ts)) bad('step 1 extra.ts is not wired (the opt-out\'s time)');
    if (problems.length === before) ok('from, message, direction, extra.provider, extra.provider_message_id, extra.ts wired');

    const hooks = await q(SQL.hooks, [e.id]);
    const live = hooks.filter((h) => Number(h.hook_active) === 1 && Number(h.target_active) === 1);
    if (!live.length) bad(`no active hook has an active target to wf ${e.id}${hooks.length ? ` (found: ${hooks.map((h) => `hook ${h.id} ${h.slug}`).join(', ')})` : ''}`);
    else ok(`fed by ${live.map((h) => `hook ${h.id} ${h.slug}`).join(', ')}`);
  }

  lines.push('newest ingested inbound text (information — the nightly liveness alert reads this):');
  for (const e of EXPECTED) {
    const [last] = await q(SQL.lastInbound, [e.provider]);
    lines.push(`  ${e.provider}: ${last ? new Date(last.processed_at).toISOString() : 'never'}`);
  }

  lines.push(problems.length
    ? `NO-GO — ${problems.length} problem(s) above: inbound STOPs would not reach the consent handler. Fix the workflow/hook, then re-run.`
    : 'GO — workflows 17 and 18 hand every inbound text to phone_log with the fields the consent handler reads.');
  return { ok: problems.length === 0, problems, lines };
}

module.exports = { checkInbound, SQL, EXPECTED };

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

async function roQuery(sql, params) {
  const url = (process.env.YC_RO_URL || 'https://app.4lsg.com') + '/api/readonly/sql';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Readonly-Api-Key': process.env.YC_RO_KEY },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(`readonly SQL ${res.status}: ${body.error || 'no body'}`);
  return body.rows;
}

if (require.main === module) {
  const path = require('path');
  (async () => {
    let conn;
    try {
      let q;
      if (process.env.YC_RO_KEY) {
        q = roQuery;
      } else {
        require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
        const mysql = require('mysql2');
        const { ensureSqlProxy } = require('./ensure-sql-proxy');
        const proxy = await ensureSqlProxy();
        if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
        for (const k of ['host', 'user', 'password', 'database']) {
          if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present? or set YC_RO_KEY)`);
        }
        conn = mysql.createConnection({
          host: process.env.host, user: process.env.user, password: process.env.password,
          database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
        }).promise();
        q = async (sql, params) => (await conn.query(sql, params))[0];
      }
      const r = await checkInbound(q);
      console.log(r.lines.join('\n'));
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — the check could not run. Nothing was changed (read only).`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
    }
  })();
}
