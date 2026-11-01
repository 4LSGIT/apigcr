#!/usr/bin/env node
// scripts/yisravidS1Data.js
//
/**
 * YisraVideo S1 — two data fixes that go with the code in the same slice.
 *
 *   1. Sequences 19 (341 Meeting) and 20 (Initial Strategy Session) hard-code
 *      video links as ?c={{contacts.contact_id}}. ?c= is an integer anyone can
 *      type, and it put the raw contact_id in every client text. New versions
 *      publish ?ct={{contacts.contact_token|default:}}. The |default: is
 *      load-bearing: five contacts have no token, and a bare placeholder with
 *      a NULL value is LEFT IN THE TEXT, so the client would be sent a literal
 *      {{contacts.contact_token}}. With it they get an anonymous link.
 *
 *   2. video_views attached a case only when its stage was 'Open', which
 *      missed every Filed client. Contact-linked views with no case are
 *      backfilled with videoService.resolveCaseIdForContact.
 *
 * USAGE (from a checkout of the COMMITTED sha, whose .env reaches production):
 *
 *   node scripts/yisravidS1Data.js                             # CHECK — read-only
 *   node scripts/yisravidS1Data.js --apply --backup-dir <dir>  # run it
 *
 * Both end on ONE GO / NO-GO line. --apply is resumable: it reads the live
 * state every time and does only what is left.
 *
 * ── WHY PUBLISH A NEW VERSION, NOT UPDATE IN PLACE ────────────────────────
 * Published versions are immutable and enrollments pin one
 * (manual/03-YisraFlow/16-versioning.md). This runs the same lifecycle as the
 * editor on one connection, in one transaction per template: the route's own
 * ensureDraft, then the route's publish statements, gated by the route's own
 * validateSequenceDraft. A staff JWT is what stops a script calling the routes
 * themselves.
 *
 * In-flight enrollments are NOT migrated. These steps are internal_function
 * send_sms, and lib/versionDiff classifies any change to one as structural
 * (only sms/email/task payloads are content), so publish {migrate_in_flight}
 * would 409. A run already under way finishes on its pinned version, and its
 * ?c= link still opens the page; new enrollments get the new link.
 *
 * ── WHAT IS ASSERTED BEFORE ANY WRITE (check and --apply alike) ───────────
 *   - each template is at its expected version with no draft and the expected
 *     step count, OR already holds the new links on a later version;
 *   - each target step's message holds the old link exactly once, and no other
 *     step of that version mentions /v/;
 *   - the new placeholder resolves to a valid token for every contact actively
 *     enrolled (yes/no — a token is a credential and is never printed).
 *
 * Inside the transaction, before the commit: the draft passes validation and
 * differs from the published version ONLY by the link swap (compared
 * key-order-insensitively, MySQL reorders JSON keys). Any failure rolls that
 * template back whole.
 *
 * ── BACKFILL RULE ─────────────────────────────────────────────────────────
 * A view is backfilled only when its case had opened by the day of the view.
 * Today's best case for the contact may be one opened after they watched, and
 * a view must not be filed on a case that did not exist yet. Those stay NULL.
 *
 * ── BACKUP ────────────────────────────────────────────────────────────────
 * --apply writes every row it could touch to <dir> FIRST (JSON, mode 0600) and
 * re-reads it to prove the file before the first write. The directory must
 * survive this checkout, so pass an absolute path outside the worktree. Holds
 * no contact tokens.
 */
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { PUBLIC_TOKEN_RE }  = require('../lib/token');
const { canonical, parseMaybeJson } = require('../lib/versionDiff');

const TARGETS = [
  { template: 19, base: 2, stepCount: 7,  steps: [{ n: 2, slug: '341-reminder' }, { n: 5, slug: 'pre-341-info' }] },
  { template: 20, base: 1, stepCount: 13, steps: [{ n: 1, slug: 'welcome' }] },
];
const PUBLISHED_BY = 'yisravid-s1';

const oldLink = (slug) => `https://4lsg.com/v/${slug}?c={{contacts.contact_id}}`;
const newLink = (slug) => `https://4lsg.com/v/${slug}?ct={{contacts.contact_token|default:}}`;

function count(haystack, needle) { return haystack.split(needle).length - 1; }
const msgOf = (step) => {
  const cfg = parseMaybeJson(step.action_config);
  return cfg && cfg.params ? String(cfg.params.message ?? '') : '';
};

async function stepsAt(conn, template, version) {
  const [rows] = await conn.query(
    'SELECT * FROM sequence_steps WHERE template_id = ? AND version = ? ORDER BY step_number ASC',
    [template, version],
  );
  return rows;
}

/** 'pending' | 'done', or throws naming why the live state is not either. */
async function templateState(conn, t) {
  const [[row]] = await conn.query(
    'SELECT current_version, draft_version FROM sequence_templates WHERE id = ?', [t.template]);
  if (!row) throw new Error(`template ${t.template} does not exist`);
  const cur = Number(row.current_version);
  if (row.draft_version != null) {
    throw new Error(`template ${t.template} has an open draft v${row.draft_version} — someone is editing it`);
  }
  const steps = await stepsAt(conn, t.template, cur);
  const at = (n) => steps.find((s) => s.step_number === n);

  if (cur !== t.base) {
    if (cur > t.base && t.steps.every(({ n, slug }) => at(n) && count(msgOf(at(n)), newLink(slug)) === 1)) {
      return { state: 'done', version: cur };
    }
    throw new Error(`template ${t.template} is at v${cur}, expected v${t.base} or the new links`);
  }
  if (steps.length !== t.stepCount) {
    throw new Error(`template ${t.template} v${cur} has ${steps.length} steps, expected ${t.stepCount}`);
  }
  for (const { n, slug } of t.steps) {
    if (!at(n)) throw new Error(`template ${t.template} v${cur} has no step ${n}`);
    const hits = count(msgOf(at(n)), oldLink(slug));
    if (hits !== 1) throw new Error(`template ${t.template} step ${n} holds the old ${slug} link ${hits} times, expected 1`);
  }
  const targetNums = new Set(t.steps.map((s) => s.n));
  for (const s of steps) {
    if (!targetNums.has(s.step_number) && JSON.stringify(parseMaybeJson(s.action_config)).includes('/v/')) {
      throw new Error(`template ${t.template} step ${s.step_number} mentions /v/ but is not a target — the plan is stale`);
    }
  }
  return { state: 'pending', version: cur };
}

async function assertTokensResolve(conn, log) {
  const { resolve } = require('../services/resolverService');
  const ids = TARGETS.map((t) => t.template);
  const [enr] = await conn.query(
    `SELECT DISTINCT contact_id FROM sequence_enrollments WHERE template_id IN (?) AND status = 'active'`, [ids]);
  let good = 0;
  for (const { contact_id } of enr) {
    const r = await resolve({
      db: conn, text: '{{contacts.contact_token|default:}}',
      refs: { contacts: { contact_id } }, strict: false, escape: 'json',
    });
    if (r.status !== 'success' || !PUBLIC_TOKEN_RE.test(r.text)) {
      throw new Error(`contact ${contact_id} is actively enrolled and the token placeholder did not resolve to a valid token`);
    }
    good++;
  }
  log(`  ✓ the new placeholder resolves to a valid token for all ${good} actively enrolled contacts`);
}

/** The route's publish transaction body, for a draft that already exists. */
async function publishDraft(conn, t, draftV) {
  const [verRow] = await conn.query(
    `UPDATE sequence_template_versions v
       JOIN sequence_templates t2 ON t2.id = v.template_id
        SET v.published_at = NOW(), v.published_by = ?,
            v.name = t2.name, v.type = t2.type, v.description = t2.description, v.test_input = t2.test_input
      WHERE v.template_id = ? AND v.version = ?`,
    [PUBLISHED_BY, t.template, draftV],
  );
  if (verRow.affectedRows !== 1) throw new Error(`template ${t.template}: no version row for draft v${draftV}`);
  await conn.query(
    'UPDATE sequence_templates SET current_version = ?, draft_version = NULL, updated_at = NOW() WHERE id = ?',
    [draftV, t.template],
  );
}

async function applyTemplate(conn, t, log) {
  const { _test: { ensureDraft }, validateSequenceDraft } = require('../routes/sequences');
  const STEP_COLS = ['action_type', 'action_config', 'timing', 'condition', 'fire_guard', 'error_policy'];

  await conn.beginTransaction();
  try {
    const [[parent]] = await conn.query(
      'SELECT current_version, draft_version FROM sequence_templates WHERE id = ? FOR UPDATE', [t.template]);
    if (Number(parent.current_version) !== t.base || parent.draft_version != null) {
      throw new Error(`template ${t.template} moved after the check`);
    }
    const draftV = await ensureDraft(conn, t.template);

    for (const { n, slug } of t.steps) {
      const [[step]] = await conn.query(
        'SELECT action_config FROM sequence_steps WHERE template_id = ? AND version = ? AND step_number = ?',
        [t.template, draftV, n]);
      const msg = msgOf(step);
      if (count(msg, oldLink(slug)) !== 1) throw new Error(`draft step ${n} does not hold the old link once`);
      const [r] = await conn.query(
        `UPDATE sequence_steps SET action_config = JSON_SET(action_config, '$.params.message', ?), updated_at = NOW()
          WHERE template_id = ? AND version = ? AND step_number = ?`,
        [msg.replace(oldLink(slug), newLink(slug)), t.template, draftV, n]);
      if (r.affectedRows !== 1) throw new Error(`draft step ${n} update touched ${r.affectedRows} rows`);
    }

    const current = await stepsAt(conn, t.template, t.base);
    const draft   = await stepsAt(conn, t.template, draftV);
    if (draft.length !== current.length) throw new Error('the fork changed the step count');

    const validation = await validateSequenceDraft(conn, draft);
    if (validation.errors.length) throw new Error(`draft failed publish validation: ${validation.errors.join('; ')}`);

    const [conds] = await conn.query(
      'SELECT version, template_condition FROM sequence_template_versions WHERE template_id = ? AND version IN (?, ?)',
      [t.template, t.base, draftV]);
    const condOf = (v) => conds.find((r) => r.version === v)?.template_condition ?? null;
    if (canonical(condOf(t.base)) !== canonical(condOf(draftV))) throw new Error('the fork changed template_condition');

    // Nothing but the link swap: rebuild what each draft step must equal.
    for (let i = 0; i < current.length; i++) {
      const cur = current[i], drf = draft[i];
      if (cur.step_number !== drf.step_number) throw new Error(`step numbering moved at index ${i}`);
      const target = t.steps.find((s) => s.n === cur.step_number);
      const want = { ...cur };
      if (target) {
        const cfg = JSON.parse(JSON.stringify(parseMaybeJson(cur.action_config)));
        cfg.params.message = cfg.params.message.replace(oldLink(target.slug), newLink(target.slug));
        want.action_config = cfg;
      }
      for (const col of STEP_COLS) {
        const a = parseMaybeJson(want[col]), b = parseMaybeJson(drf[col]);
        if (canonical(a) !== canonical(b)) throw new Error(`step ${cur.step_number} differs on ${col} beyond the link swap`);
      }
    }

    await publishDraft(conn, t, draftV);
    await conn.commit();
    log(`  ✓ template ${t.template}: v${t.base} → v${draftV} published`);
    return { draftV };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  }
}

async function planBackfill(conn) {
  const videoService = require('../services/videoService');
  const [rows] = await conn.query(
    `SELECT id, contact_id, opened_at FROM video_views
      WHERE contact_id IS NOT NULL AND case_id IS NULL ORDER BY id`);
  const fill = [], skipped = [];
  for (const row of rows) {
    const caseId = await videoService.resolveCaseIdForContact(conn, row.contact_id);
    if (!caseId) { skipped.push({ id: row.id, why: 'no primary case' }); continue; }
    const [[c]] = await conn.query(
      'SELECT case_open_date <= DATE(?) AS opened_by_then FROM cases WHERE case_id = ?',
      [row.opened_at, caseId]);
    if (!c || c.opened_by_then !== 1) { skipped.push({ id: row.id, why: 'case not open by the view date' }); continue; }
    fill.push({ id: row.id, contact_id: row.contact_id, case_id: caseId });
  }
  return { fill, skipped, candidates: rows.length };
}

async function applyBackfill(conn, fill, log) {
  await conn.beginTransaction();
  try {
    for (const f of fill) {
      const [r] = await conn.query(
        'UPDATE video_views SET case_id = ? WHERE id = ? AND contact_id = ? AND case_id IS NULL',
        [f.case_id, f.id, f.contact_id]);
      if (r.affectedRows !== 1) throw new Error(`view ${f.id} changed under the backfill`);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  }
  log(`  ✓ backfilled ${fill.length} view(s)`);
}

async function writeBackup(conn, dir, log) {
  if (!dir || !path.isAbsolute(dir)) throw new Error('--apply needs --backup-dir <absolute path>');
  fs.mkdirSync(dir, { recursive: true });
  const ids = TARGETS.map((t) => t.template);
  const q = async (sql, p) => (await conn.query(sql, p))[0];
  const snapshot = {
    taken_at: new Date().toISOString(),
    sequence_templates: await q('SELECT * FROM sequence_templates WHERE id IN (?)', [ids]),
    sequence_template_versions: await q('SELECT * FROM sequence_template_versions WHERE template_id IN (?)', [ids]),
    sequence_steps: await q('SELECT * FROM sequence_steps WHERE template_id IN (?)', [ids]),
    sequence_enrollments: await q(`SELECT * FROM sequence_enrollments WHERE template_id IN (?) AND status = 'active'`, [ids]),
    video_views: await q('SELECT * FROM video_views'),
  };
  const body = JSON.stringify(snapshot, null, 1);
  const file = path.join(dir, `yisravid-s1-${snapshot.taken_at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, body, { mode: 0o600, flag: 'wx' });
  const back = fs.readFileSync(file, 'utf8');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  if (crypto.createHash('sha256').update(back).digest('hex') !== sha) throw new Error('the backup did not read back identically');
  const parsed = JSON.parse(back);
  if (parsed.video_views.length !== snapshot.video_views.length || parsed.sequence_steps.length !== snapshot.sequence_steps.length) {
    throw new Error('the backup row counts do not match');
  }
  log(`  ✓ backup ${file}`);
  log(`    sha256 ${sha} — ${parsed.sequence_steps.length} steps, ${parsed.video_views.length} views`);
  return file;
}

async function run(conn, { apply, backupDir, log = console.log }) {
  await conn.query('SET SESSION lock_wait_timeout = 5');

  log('Sequences:');
  const states = [];
  for (const t of TARGETS) {
    const s = await templateState(conn, t);
    states.push({ t, ...s });
    log(`  template ${t.template}: ${s.state === 'done' ? `already done at v${s.version}` : `v${s.version}, steps ${t.steps.map((x) => x.n).join(', ')} will change`}`);
  }
  await assertTokensResolve(conn, log);

  const plan = await planBackfill(conn);
  log(`Backfill: ${plan.candidates} contact-linked view(s) with no case → ${plan.fill.length} to fill, ${plan.skipped.length} left NULL`);
  for (const s of plan.skipped) log(`  view ${s.id} stays NULL: ${s.why}`);

  const pending = states.filter((s) => s.state === 'pending');
  if (!apply) {
    log(`\nGO — CHECK passed, nothing written. ${pending.length} template(s) and ${plan.fill.length} view(s) to change. Next: node scripts/yisravidS1Data.js --apply --backup-dir <abs dir>`);
    return { ok: true };
  }
  if (!pending.length && !plan.fill.length) {
    log('\nGO — nothing left to do.');
    return { ok: true };
  }

  await writeBackup(conn, backupDir, log);
  for (const s of pending) await applyTemplate(conn, s.t, log);
  await applyBackfill(conn, plan.fill, log);

  // End state, read fresh.
  for (const t of TARGETS) {
    const s = await templateState(conn, t);
    if (s.state !== 'done') throw new Error(`template ${t.template} did not reach the new links`);
  }
  const after = await planBackfill(conn);
  if (after.fill.length) throw new Error(`${after.fill.length} view(s) still fillable after the backfill`);
  log('\nGO — both templates publish the new links and the backfill is complete.');
  return { ok: true };
}

module.exports = { run, TARGETS, oldLink, newLink };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2');
  const { ensureSqlProxy } = require('./ensure-sql-proxy');
  const apply = process.argv.includes('--apply');
  const i = process.argv.indexOf('--backup-dir');
  const backupDir = i > -1 ? process.argv[i + 1] : null;
  (async () => {
    let conn;
    try {
      const testUrl = process.env.YV_S1_TEST_URL;
      if (testUrl) {
        if (!/_test$/.test(new URL(testUrl).pathname)) throw new Error('YV_S1_TEST_URL must name a *_test database');
        conn = mysql.createConnection({ uri: testUrl, timezone: 'Z' }).promise();
      } else {
        const proxy = await ensureSqlProxy();
        if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
        for (const k of ['host', 'user', 'password', 'database']) {
          if (!process.env[k]) throw new Error(`missing env var "${k}" (is .env present?)`);
        }
        conn = mysql.createConnection({
          host: process.env.host, user: process.env.user, password: process.env.password,
          database: process.env.database, timezone: 'Z', connectTimeout: 15_000,
        }).promise();
      }
      const r = await run(conn, { apply, backupDir });
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      console.log(`\n${err.message}\n\nNO-GO — stopped. Each template and the backfill commit whole or not at all; a ✓ above is what landed. Rerun to resume.`);
      process.exitCode = 1;
    } finally {
      if (conn) await conn.end().catch(() => {});
      process.exit();
    }
  })();
}
