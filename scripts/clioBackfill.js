// scripts/clioBackfill.js
//
/**
 * Clio → YisraCase backfill (lead-list merge arc, 2026-10-29).
 *
 * Creates the past Clio clients YisraCase never had, with CLOSED cases for
 * their old Clio matters, and links Clio matters/clients that YC already has
 * but never tied to Clio. Driven by a reviewed PLAN file (JSON) built outside
 * the repo — it holds client names, phones, emails and addresses, so it is
 * NEVER committed. This script holds no client data and no matching logic: the
 * plan says what to write; the script re-checks every row against the live DB
 * right before writing it and refuses anything that changed underneath.
 *
 * WHAT IT WRITES, and through what (verified against the code 2026-10-29):
 *   contacts  contactService.createContact with only values proven free (an
 *             active phone/email held by another contact would be silently
 *             force-transferred by createContact — the check runs immediately
 *             before the call, and a post-check fails the run if any
 *             'transferred' row appears). Extra values go through
 *             createContactPhone / createContactEmail with force=false, so a
 *             conflict is reported, never transferred. contact_type 'Client'.
 *             Then, raw: custom.$.cf_clio_id (the S5-A recipe —
 *             ref/migrations/2026-09-25_clio_pilot_backfill.sql), and
 *             contact_created + the address start_date back-dated to when the
 *             firm first knew the person (the plan's date), so YC does not
 *             claim they all arrived this week.
 *             createContact's own post-commit side effects still run: the
 *             Google Contacts push (Fred, 2026-10-29: push) and
 *             contact.created (no active trigger rule on contact.* events).
 *   cases     caseService.createCase with EVERY column at INSERT (stage
 *             Closed, Clio/court dates, docket) — it emits nothing. Then,
 *             in the same transaction on one connection: cf_clio_matter
 *             (raw JSON_SET), the case_relate rows, and one `log` row.
 *   links     raw JSON_SET of cf_clio_matter / cf_clio_id, only where the
 *             live value is still NULL.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - emit case.created — live rule 11 "New intake case → lead" would turn
 *     every old matter into a new lead;
 *   - call updateCase — rules 9/10 fire on close/discharge dates, and stage
 *     moves reach rule 23 (the "We filed your case" email);
 *   - create Dropbox folders, enroll sequences, or touch any case/contact the
 *     plan does not name.
 *
 * IDEMPOTENT / RESUMABLE: the DB is the ledger. A created contact carries its
 * Clio id in cf_clio_id and a "[clio:<id>]" marker in contact_notes; a created
 * case carries cf_clio_matter and a "[clio-matter:<id>]" marker in case_notes.
 * A re-run finds them and skips. A case and its links/log commit together, so
 * a crash never leaves a half-made case. A crash between createContact and its
 * cf_clio_id write is healed by the notes marker. Progress is also appended to
 * <plan>.ledger.jsonl for the record.
 *
 * USAGE (from a worktree with node_modules + .env symlinked; .env targets
 * production through the Cloud SQL Auth Proxy):
 *   node scripts/clioBackfill.js --plan ~/Downloads/clio_backfill_plan.json            # CHECK (read-only)
 *   node scripts/clioBackfill.js --plan ~/Downloads/clio_backfill_plan.json --apply --limit 3   # pilot
 *   node scripts/clioBackfill.js --plan ~/Downloads/clio_backfill_plan.json --apply    # the rest
 * Options: --limit N  (apply: at most N case creates this run, plus the contacts they need)
 *          --pace-ms M (pause after each contact create; default 1200 — Google People API writes)
 * Ends on ONE line: GO — … / NO-GO — … . Details go to <plan>.report.txt.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PLAN_PATH = argVal('--plan');
const LIMIT = argVal('--limit') !== undefined ? parseInt(argVal('--limit'), 10) : Infinity;
const PACE_MS = argVal('--pace-ms') !== undefined ? parseInt(argVal('--pace-ms'), 10) : 1200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAGES = new Set(['Open', 'Pending', 'Filed', 'Concluded', 'Closed']);
const RELATE_TYPES = new Set(['Primary', 'Secondary', 'Other', 'Bystander']);
const CASE_FIELDS = new Set(['case_type', 'case_subtype', 'case_chapter', 'pipeline_phase', 'case_stage', 'case_status',
  'case_open_date', 'case_file_date', 'case_close_date', 'case_number', 'case_number_full', 'case_notes',
  'case_source', 'case_source_ref']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

// ─────────────────────────────────────────────────────────────
// plan
// ─────────────────────────────────────────────────────────────
function loadPlan(p) {
  if (!p) throw new Error('--plan <path> is required');
  const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (plan.version !== 1) throw new Error(`plan version ${plan.version} — this script reads version 1`);
  const problems = [];
  const keys = new Set();
  for (const c of plan.contacts || []) {
    if (keys.has(c.key)) problems.push(`duplicate contact key ${c.key}`);
    keys.add(c.key);
    if (!['create', 'link', 'use'].includes(c.action)) problems.push(`${c.key}: action ${c.action}`);
    if (c.action === 'create') {
      if (!c.clio_id) problems.push(`${c.key}: no clio_id`);
      if (c.kind === 'org' ? !c.org_name : !(c.fname && c.lname)) problems.push(`${c.key}: missing name`);
      if (c.contact_created && !DATE_RE.test(c.contact_created)) problems.push(`${c.key}: contact_created ${c.contact_created}`);
      if (!String(c.notes || '').includes(`[clio:${c.clio_id}]`)) problems.push(`${c.key}: notes lack the [clio:${c.clio_id}] marker`);
    } else if (!Number.isInteger(c.yc_id)) problems.push(`${c.key}: yc_id`);
  }
  const ckeys = new Set();
  for (const k of plan.cases || []) {
    if (ckeys.has(k.key)) problems.push(`duplicate case key ${k.key}`);
    ckeys.add(k.key);
    if (k.action === 'create') {
      if (!keys.has(k.contact_key)) problems.push(`${k.key}: contact ${k.contact_key} not in plan`);
      for (const r of k.related || []) {
        if (!keys.has(r.contact_key)) problems.push(`${k.key}: related ${r.contact_key} not in plan`);
        if (!RELATE_TYPES.has(r.type) || r.type === 'Primary') problems.push(`${k.key}: related type ${r.type}`);
      }
      const f = k.fields || {};
      for (const name of Object.keys(f)) if (!CASE_FIELDS.has(name)) problems.push(`${k.key}: field ${name} not allowed`);
      if (f.case_stage !== 'Closed' || !STAGES.has(f.case_stage)) problems.push(`${k.key}: case_stage ${f.case_stage}`);
      for (const d of ['case_open_date', 'case_file_date', 'case_close_date']) {
        if (f[d] !== undefined && !DATE_RE.test(f[d])) problems.push(`${k.key}: ${d} ${f[d]}`);
      }
      if (!String(f.case_notes || '').includes(`[clio-matter:${k.matter_id}]`)) problems.push(`${k.key}: case_notes lack the marker`);
      for (const n of ['case_number', 'case_number_full']) if (f[n] && String(f[n]).length > 20) problems.push(`${k.key}: ${n} > 20 chars`);
    } else if (k.action === 'link') {
      if (!k.yc_case) problems.push(`${k.key}: no yc_case`);
      if (k.contact_key && !keys.has(k.contact_key)) problems.push(`${k.key}: contact ${k.contact_key} not in plan`);
    } else problems.push(`${k.key}: action ${k.action}`);
  }
  if (problems.length) throw new Error(`plan invalid:\n  ${problems.join('\n  ')}`);
  return plan;
}

// ─────────────────────────────────────────────────────────────
// live state
// ─────────────────────────────────────────────────────────────
async function assertSchema(db) {
  const [rows] = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'contacts' AND COLUMN_NAME IN ('cf_clio_id','custom','contact_created','contact_notes'))
          OR (TABLE_NAME = 'cases' AND COLUMN_NAME IN ('cf_clio_matter','custom','case_notes','case_source_ref','case_chapter'))
          OR (TABLE_NAME = 'contact_addresses' AND COLUMN_NAME = 'start_date'))`);
  const have = new Set(rows.map(r => `${r.t}.${r.c}`));
  const need = ['contacts.cf_clio_id', 'contacts.custom', 'contacts.contact_created', 'contacts.contact_notes',
    'cases.cf_clio_matter', 'cases.custom', 'cases.case_notes', 'cases.case_source_ref', 'cases.case_chapter',
    'contact_addresses.start_date'];
  const missing = need.filter(n => !have.has(n));
  if (missing.length) throw new Error(`schema check failed — missing ${missing.join(', ')}`);
}

async function loadLive(db) {
  const L = { holder: new Map(), byClio: new Map(), byContactMarker: new Map(), contacts: new Map(),
    caseByMatter: new Map(), caseByMarker: new Map(), dockets: new Map(), cases: new Map() };
  const hold = (k, cid) => { if (k && !L.holder.has(k)) L.holder.set(k, cid); };
  const [cs] = await db.query(
    `SELECT contact_id, contact_fname, contact_lname, contact_name, cf_clio_id, contact_phone, contact_phone2,
            contact_email, contact_email2,
            (contact_notes LIKE '%[clio:%') AS has_marker,
            CASE WHEN contact_notes LIKE '%[clio:%' THEN contact_notes END AS notes
       FROM contacts`);
  for (const c of cs) {
    L.contacts.set(c.contact_id, c);
    if (c.cf_clio_id) L.byClio.set(String(c.cf_clio_id), c.contact_id);
    if (c.notes) for (const m of String(c.notes).matchAll(/\[clio:(\d+)\]/g)) L.byContactMarker.set(m[1], c.contact_id);
    hold(c.contact_phone && `p:${c.contact_phone}`, c.contact_id);
    hold(c.contact_phone2 && `p:${c.contact_phone2}`, c.contact_id);
    hold(c.contact_email && `e:${lc(c.contact_email)}`, c.contact_id);
    hold(c.contact_email2 && `e:${lc(c.contact_email2)}`, c.contact_id);
  }
  const [ps] = await db.query('SELECT phone, contact_id FROM contact_phones WHERE end_date IS NULL');
  for (const p of ps) L.holder.set(`p:${p.phone}`, p.contact_id);          // active child row wins
  const [es] = await db.query('SELECT email, contact_id FROM contact_emails WHERE end_date IS NULL');
  for (const e of es) L.holder.set(`e:${lc(e.email)}`, e.contact_id);
  const [ks] = await db.query(
    `SELECT case_id, case_number, case_number_full, cf_clio_matter,
            CASE WHEN case_notes LIKE '%[clio-matter:%' THEN case_notes END AS notes
       FROM cases`);
  for (const k of ks) {
    L.cases.set(k.case_id, k);
    if (k.cf_clio_matter) L.caseByMatter.set(String(k.cf_clio_matter), k.case_id);
    if (k.notes) for (const m of String(k.notes).matchAll(/\[clio-matter:(\d+)\]/g)) L.caseByMarker.set(m[1], k.case_id);
    for (const d of [k.case_number, k.case_number_full]) if (d) L.dockets.set(lc(d), k.case_id);
  }
  return L;
}

// contact plan entry → existing YC contact id (or null when it still has to be created)
function existingContactId(L, c) {
  if (c.action !== 'create') return L.contacts.has(c.yc_id) ? c.yc_id : null;
  const k = String(c.clio_id);
  return L.byClio.get(k) || L.byContactMarker.get(k) || null;
}

function caseDone(L, k) {
  const m = String(k.matter_id);
  return L.caseByMatter.get(m) || L.caseByMarker.get(m) || null;
}

// ─────────────────────────────────────────────────────────────
// CHECK — classify every row against the live state (no writes)
// ─────────────────────────────────────────────────────────────
function check(plan, L) {
  const R = { contacts: { create: 0, link: 0, use: 0, done: 0 }, cases: { create: 0, link: 0, done: 0 },
    blocked: [], warnings: [], held: [] };
  const byKey = new Map(plan.contacts.map(c => [c.key, c]));
  for (const c of plan.contacts) {
    const have = existingContactId(L, c);
    if (c.action === 'create') {
      if (have) { R.contacts.done++; continue; }
      R.contacts.create++;
      for (const v of [...c.phones.map(p => `p:${p}`), ...c.emails.map(e => `e:${lc(e)}`)]) {
        const h = L.holder.get(v);
        if (h) R.held.push(`${c.key} ${v.slice(2)} is held by YC #${h} — not written`);
      }
      if (c.kind !== 'org' && (String(c.fname).length > 20 || String(c.lname).length > 30)) {
        R.warnings.push(`${c.key} name longer than the columns (fname 20 / lname 30) will truncate: ${c.fname} ${c.lname}`);
      }
      const same = [...L.contacts.values()].filter(y => lc(y.contact_fname) === lc(c.fname) && lc(y.contact_lname) === lc(c.lname) && c.kind !== 'org');
      if (same.length) R.warnings.push(`${c.key} ${c.fname} ${c.lname}: YC already has a contact with this exact name (#${same.map(y => y.contact_id).join(', #')})`);
    } else {
      if (!have) { R.blocked.push(`${c.key}: YC contact #${c.yc_id} not found`); continue; }
      if (c.action === 'link') {
        const cur = L.contacts.get(c.yc_id).cf_clio_id;
        if (cur && String(cur) === String(c.set_cf_clio_id)) R.contacts.done++;
        else if (cur) R.warnings.push(`${c.key}: YC #${c.yc_id} already carries cf_clio_id ${cur}; left as is (plan: ${c.set_cf_clio_id})`);
        else R.contacts.link++;
      } else R.contacts.use++;
    }
  }
  for (const k of plan.cases) {
    if (k.action === 'create') {
      if (caseDone(L, k)) { R.cases.done++; continue; }
      const f = k.fields;
      for (const d of new Set([f.case_number, f.case_number_full].filter(Boolean).map(lc))) {
        if (L.dockets.has(d)) R.blocked.push(`${k.key} (${k.matter_num}): docket ${d} already on YC case ${L.dockets.get(d)}`);
      }
      R.cases.create++;
    } else {
      const y = L.cases.get(k.yc_case);
      if (!y) { R.blocked.push(`${k.key} (${k.matter_num}): YC case ${k.yc_case} not found`); continue; }
      if (y.cf_clio_matter && String(y.cf_clio_matter) === String(k.matter_id)) { R.cases.done++; continue; }
      if (y.cf_clio_matter) { R.blocked.push(`${k.key} (${k.matter_num}): YC case ${k.yc_case} is linked to Clio matter ${y.cf_clio_matter}`); continue; }
      const other = L.caseByMatter.get(String(k.matter_id));
      if (other) { R.blocked.push(`${k.key} (${k.matter_num}): Clio matter already linked to YC case ${other}`); continue; }
      R.cases.link++;
    }
    if (k.contact_key && !byKey.has(k.contact_key)) R.blocked.push(`${k.key}: contact ${k.contact_key} missing from plan`);
  }
  return R;
}

// ─────────────────────────────────────────────────────────────
// APPLY
// ─────────────────────────────────────────────────────────────
function ledger(file, row) {
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

async function linkContact(db, c, out) {
  const [r] = await db.query(
    "UPDATE contacts SET `custom` = JSON_SET(`custom`, '$.cf_clio_id', ?) WHERE contact_id = ? AND cf_clio_id IS NULL",
    [String(c.set_cf_clio_id), c.yc_id]);
  const [[row]] = await db.query('SELECT cf_clio_id FROM contacts WHERE contact_id = ?', [c.yc_id]);
  if (String(row.cf_clio_id) !== String(c.set_cf_clio_id)) {
    out.warnings.push(`${c.key}: cf_clio_id is ${row.cf_clio_id}, not ${c.set_cf_clio_id} — left`);
    return false;
  }
  return r.affectedRows === 1;
}

async function createOneContact(db, svc, L, c, runStart, out) {
  const free = (k) => !L.holder.get(k);
  const phones = c.phones.filter(p => free(`p:${p}`));
  const emails = c.emails.filter(e => free(`e:${lc(e)}`));
  for (const v of c.phones.filter(p => !phones.includes(p))) out.held.push(`${c.key} phone ${v} held by YC #${L.holder.get(`p:${v}`)} — not written`);
  for (const v of c.emails.filter(e => !emails.includes(e))) out.held.push(`${c.key} email ${v} held by YC #${L.holder.get(`e:${lc(v)}`)} — not written`);

  // re-check the two values createContact will take, against the DB itself, right before the call
  for (const [table, col, v] of [['contact_phones', 'phone', phones[0]], ['contact_emails', 'email', emails[0]]]) {
    if (!v) continue;
    const [[hit]] = await db.query(`SELECT contact_id FROM ${table} WHERE ${col} = ? AND end_date IS NULL LIMIT 1`, [v]);
    if (hit) throw new Error(`${c.key}: ${col} ${v} became active on YC #${hit.contact_id} since the snapshot — stopping before createContact could transfer it`);
  }

  const a = c.address || {};
  const created = await svc.contact.createContact(db, {
    kind: c.kind, org_name: c.org_name || '', fname: c.fname || '', mname: c.mname || '', lname: c.lname || '',
    phone: phones[0] || '', email: emails[0] || '', type: 'Client',
    address: a.street || '', city: a.city || '', state: a.state || '', zip: a.zip || '',
    tags: c.tags, notes: c.notes,
  }, { userId: 0 });
  const id = created.contact_id;

  // createContact transfers on collision; nothing may have been transferred
  const vals = [phones[0], emails[0]].filter(Boolean);
  if (vals.length) {
    const [[t]] = await db.query(
      `SELECT (SELECT COUNT(*) FROM contact_phones WHERE end_reason = 'transferred' AND contact_id <> ? AND phone IN (?) AND updated_at >= ?)
            + (SELECT COUNT(*) FROM contact_emails WHERE end_reason = 'transferred' AND contact_id <> ? AND email IN (?) AND updated_at >= ?) AS n`,
      [id, vals, runStart, id, vals, runStart]);
    if (t.n > 0) throw new Error(`${c.key}: createContact transferred a value off another contact (contact #${id}) — STOP and inspect`);
  }

  await db.query(
    "UPDATE contacts SET `custom` = JSON_SET(`custom`, '$.cf_clio_id', ?) WHERE contact_id = ?",
    [String(c.clio_id), id]);
  if (c.contact_created) {
    await db.query('UPDATE contacts SET contact_created = ? WHERE contact_id = ?', [`${c.contact_created} 00:00:00`, id]);
    await db.query('UPDATE contact_addresses SET start_date = ? WHERE contact_id = ? AND start_date = CURDATE()', [c.contact_created, id]);
  }
  for (const v of [phones[0] && `p:${phones[0]}`, emails[0] && `e:${lc(emails[0])}`].filter(Boolean)) L.holder.set(v, id);

  for (const p of phones.slice(1)) {
    try {
      await svc.phone.createContactPhone(db, id, { phone: p, label: 'Other', is_primary: 0 }, { force: false, createdBy: 0 });
      L.holder.set(`p:${p}`, id);
    } catch (e) { out.held.push(`${c.key} extra phone ${p} not added: ${e.message}`); }
  }
  for (const e of emails.slice(1)) {
    try {
      await svc.email.createContactEmail(db, id, { email: e, label: 'Other', is_primary: 0 }, { force: false, createdBy: 0 });
      L.holder.set(`e:${lc(e)}`, id);
    } catch (err) { out.held.push(`${c.key} extra email ${e} not added: ${err.message}`); }
  }

  const [[row]] = await db.query('SELECT cf_clio_id, contact_type FROM contacts WHERE contact_id = ?', [id]);
  if (String(row.cf_clio_id) !== String(c.clio_id)) throw new Error(`${c.key}: cf_clio_id read-back ${row.cf_clio_id} ≠ ${c.clio_id}`);
  L.byClio.set(String(c.clio_id), id);
  L.contacts.set(id, { contact_id: id, cf_clio_id: String(c.clio_id), contact_fname: c.fname, contact_lname: c.lname });
  return id;
}

async function createOneCase(pool, svc, L, k, contactIds, out) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const m = String(k.matter_id);
    const [[dup]] = await conn.query(
      'SELECT case_id FROM cases WHERE cf_clio_matter = ? OR case_notes LIKE ? LIMIT 1', [m, `%[clio-matter:${m}]%`]);
    if (dup) { await conn.rollback(); return { case_id: dup.case_id, existed: true }; }
    for (const d of [k.fields.case_number, k.fields.case_number_full].filter(Boolean)) {
      const [[hit]] = await conn.query('SELECT case_id FROM cases WHERE case_number = ? OR case_number_full = ? LIMIT 1', [d, d]);
      if (hit) { await conn.rollback(); out.blocked.push(`${k.key} (${k.matter_num}): docket ${d} appeared on YC case ${hit.case_id}`); return null; }
    }
    const primary = contactIds.get(k.contact_key);
    if (!primary) throw new Error(`${k.key}: contact ${k.contact_key} has no YC id`);

    const { case_id } = await svc.case.createCase(conn, { ...k.fields });
    await conn.query("UPDATE cases SET `custom` = JSON_SET(`custom`, '$.cf_clio_matter', ?) WHERE case_id = ?", [m, case_id]);
    await conn.query(
      "INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, 'Primary')",
      [case_id, primary]);
    for (const r of k.related || []) {
      const rid = contactIds.get(r.contact_key);
      if (rid && rid !== primary) {
        await conn.query(
          'INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, ?)',
          [case_id, rid, r.type]);
      }
    }
    // same log row shape intake writes; action 'clio_backfill', so nothing counting 'case_created' counts these
    await conn.query(
      `INSERT INTO log (log_type, log_date, log_link, log_by, log_data)
       VALUES ('update', CONVERT_TZ(NOW(), 'UTC', 'America/New_York'), ?, 0, ?)`,
      [case_id, JSON.stringify({ action: 'clio_backfill', clio_matter: m, clio_matter_number: k.matter_num, contact_id: primary })]);

    const [[back]] = await conn.query(
      `SELECT c.cf_clio_matter, c.case_stage, DATE_FORMAT(c.case_open_date, '%Y-%m-%d') o,
              (SELECT COUNT(*) FROM case_relate r WHERE r.case_relate_case_id = c.case_id AND r.case_relate_type = 'Primary') prim
         FROM cases c WHERE c.case_id = ?`, [case_id]);
    if (String(back.cf_clio_matter) !== m || back.case_stage !== 'Closed' || back.prim !== 1
        || (k.fields.case_open_date && back.o !== k.fields.case_open_date)) {
      throw new Error(`${k.key}: read-back mismatch ${JSON.stringify(back)}`);
    }
    await conn.commit();
    L.caseByMatter.set(m, case_id);
    for (const d of [k.fields.case_number, k.fields.case_number_full].filter(Boolean)) L.dockets.set(lc(d), case_id);
    return { case_id, existed: false };
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* already gone */ }
    throw e;
  } finally {
    conn.release();
  }
}

async function linkCase(db, k, out) {
  const [r] = await db.query(
    "UPDATE cases SET `custom` = JSON_SET(`custom`, '$.cf_clio_matter', ?) WHERE case_id = ? AND cf_clio_matter IS NULL",
    [String(k.matter_id), k.yc_case]);
  const [[row]] = await db.query('SELECT cf_clio_matter FROM cases WHERE case_id = ?', [k.yc_case]);
  if (String(row.cf_clio_matter) !== String(k.matter_id)) {
    out.blocked.push(`${k.key} (${k.matter_num}): YC case ${k.yc_case} carries ${row.cf_clio_matter}`);
    return false;
  }
  return r.affectedRows === 1;
}

async function verify(db, plan, runStart) {
  const L = await loadLive(db);
  const bad = [];
  let contacts = 0, cases = 0;
  for (const c of plan.contacts.filter(x => x.action === 'create')) if (existingContactId(L, c)) contacts++;
  for (const k of plan.cases) {
    if (k.action === 'create' && caseDone(L, k)) cases++;
    if (k.action === 'link' && String((L.cases.get(k.yc_case) || {}).cf_clio_matter) === String(k.matter_id)) cases++;
  }
  const [[t]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM contact_phones WHERE end_reason = 'transferred' AND updated_at >= ?)
          + (SELECT COUNT(*) FROM contact_emails WHERE end_reason = 'transferred' AND updated_at >= ?) AS n`, [runStart, runStart]);
  if (t.n > 0) bad.push(`${t.n} phone/email row(s) ended as 'transferred' since this run started`);
  const [[o]] = await db.query(
    `SELECT COUNT(*) AS n FROM cases c
      WHERE c.case_notes LIKE '%[clio-matter:%'
        AND NOT EXISTS (SELECT 1 FROM case_relate r WHERE r.case_relate_case_id = c.case_id AND r.case_relate_type = 'Primary')`);
  if (o.n > 0) bad.push(`${o.n} back-filled case(s) without a Primary contact`);
  return { L, contacts, cases, bad };
}

// ─────────────────────────────────────────────────────────────
async function main(pool) {
  const plan = loadPlan(PLAN_PATH);
  const reportPath = `${PLAN_PATH}.report.txt`;
  const ledgerPath = `${PLAN_PATH}.ledger.jsonl`;
  const report = [];
  const say = (s) => { console.log(s); report.push(s); };

  const [[who]] = await pool.query("SELECT DATABASE() AS db, @@hostname AS host, CONVERT_TZ(NOW(), 'UTC', 'America/New_York') AS firm_now");
  if (!who.firm_now) throw new Error('CONVERT_TZ returned NULL — this MySQL has no time-zone tables');
  say(`=== clioBackfill — ${APPLY ? 'APPLY' : 'CHECK (read-only)'} — db ${who.db} on ${who.host} ===`);
  await assertSchema(pool);
  let L = await loadLive(pool);
  const R = check(plan, L);
  say(`contacts: create ${R.contacts.create}, set cf_clio_id ${R.contacts.link}, use as-is ${R.contacts.use}, already done ${R.contacts.done}`);
  say(`cases:    create ${R.cases.create}, link ${R.cases.link}, already done ${R.cases.done}`);
  say(`values held by other YC contacts (skipped, not transferred): ${R.held.length}`);
  for (const w of R.warnings) report.push(`WARN ${w}`);
  for (const h of R.held) report.push(`HELD ${h}`);
  for (const b of R.blocked) say(`BLOCKED ${b}`);
  if (R.warnings.length) say(`warnings: ${R.warnings.length} (see ${path.basename(reportPath)})`);

  if (!APPLY) {
    fs.writeFileSync(reportPath, report.join('\n') + '\n');
    if (R.blocked.length) { console.log(`NO-GO — ${R.blocked.length} blocked row(s) above; fix the plan or YC first. Report: ${reportPath}`); return 1; }
    if (!R.contacts.create && !R.contacts.link && !R.cases.create && !R.cases.link) {
      console.log('GO — nothing left to do: every planned row is already in YC.');
      return 0;
    }
    console.log(`GO — CHECK clean. Next: node scripts/clioBackfill.js --plan ${PLAN_PATH} --apply --limit 3   (pilot), then without --limit`);
    return 0;
  }
  if (R.blocked.length) {
    fs.writeFileSync(reportPath, report.join('\n') + '\n');
    console.log(`NO-GO — refusing to apply with ${R.blocked.length} blocked row(s). Run CHECK, fix, re-run.`);
    return 1;
  }

  const svc = {
    contact: require('../services/contactService'),
    phone: require('../services/contactPhoneService'),
    email: require('../services/contactEmailService'),
    case: require('../services/caseService'),
  };
  const [[{ now: runStart }]] = await pool.query('SELECT NOW() AS now');
  const out = { warnings: [], held: [], blocked: [] };

  // which cases run this time (--limit) and which contacts they need
  const caseCreates = plan.cases.filter(k => k.action === 'create' && !caseDone(L, k));
  const todoCases = caseCreates.slice(0, LIMIT);
  const limited = Number.isFinite(LIMIT);
  const needKeys = new Set(todoCases.flatMap(k => [k.contact_key, ...(k.related || []).map(r => r.contact_key)]));
  const byKey = new Map(plan.contacts.map(c => [c.key, c]));
  const contactIds = new Map();
  for (const c of plan.contacts) { const id = existingContactId(L, c); if (id) contactIds.set(c.key, id); }

  // 1. links on existing contacts
  let n = 0;
  for (const c of plan.contacts.filter(x => x.action === 'link' && (!limited || needKeys.has(x.key)))) {
    if (await linkContact(pool, c, out)) { n++; ledger(ledgerPath, { key: c.key, did: 'cf_clio_id', contact_id: c.yc_id }); }
  }
  say(`cf_clio_id set on ${n} existing contact(s)`);

  // 2a. heal contacts a crashed run created: found by their notes marker or cf_clio_id, the follow-up
  //     writes (cf_clio_id, back-dated contact_created) are re-applied where they did not land
  n = 0;
  for (const c of plan.contacts.filter(x => x.action === 'create' && contactIds.has(x.key))) {
    const id = contactIds.get(c.key);
    const [r1] = await pool.query(
      "UPDATE contacts SET `custom` = JSON_SET(`custom`, '$.cf_clio_id', ?) WHERE contact_id = ? AND cf_clio_id IS NULL",
      [String(c.clio_id), id]);
    let r2 = { affectedRows: 0 };
    if (c.contact_created) {
      [r2] = await pool.query(
        'UPDATE contacts SET contact_created = ? WHERE contact_id = ? AND (contact_created IS NULL OR DATE(contact_created) <> ?)',
        [`${c.contact_created} 00:00:00`, id, c.contact_created]);
    }
    if (r1.affectedRows || r2.affectedRows) { n++; ledger(ledgerPath, { key: c.key, did: 'healed', contact_id: id }); }
  }
  if (n) say(`healed ${n} contact(s) left half-done by an earlier run`);

  // 2b. contact creates
  n = 0;
  for (const c of plan.contacts.filter(x => x.action === 'create' && !contactIds.has(x.key) && (!limited || needKeys.has(x.key)))) {
    const id = await createOneContact(pool, svc, L, c, runStart, out);
    contactIds.set(c.key, id);
    ledger(ledgerPath, { key: c.key, did: 'contact_created', contact_id: id });
    n++;
    if (n % 25 === 0) console.log(`  … ${n} contacts`);
    await sleep(PACE_MS);
  }
  say(`contacts created: ${n}`);

  // 3. case creates
  n = 0;
  for (const k of todoCases) {
    for (const key of [k.contact_key, ...(k.related || []).map(r => r.contact_key)]) {
      if (!contactIds.has(key)) {
        const c = byKey.get(key);
        const id = existingContactId(L, c);
        if (id) contactIds.set(key, id);
      }
    }
    const res = await createOneCase(pool, svc, L, k, contactIds, out);
    if (res && !res.existed) { n++; ledger(ledgerPath, { key: k.key, did: 'case_created', case_id: res.case_id, matter: k.matter_num }); }
    if (n && n % 25 === 0) console.log(`  … ${n} cases`);
  }
  say(`cases created: ${n}${limited ? ` (limit ${LIMIT})` : ''}`);

  // 4. case links (skipped on a limited pilot)
  n = 0;
  if (!limited) {
    for (const k of plan.cases.filter(x => x.action === 'link')) {
      if (await linkCase(pool, k, out)) { n++; ledger(ledgerPath, { key: k.key, did: 'cf_clio_matter', case_id: k.yc_case }); }
    }
  }
  say(`existing cases linked: ${n}${limited ? ' (skipped on a --limit pilot)' : ''}`);

  for (const h of out.held) report.push(`HELD ${h}`);
  for (const w of out.warnings) report.push(`WARN ${w}`);
  for (const b of out.blocked) say(`BLOCKED ${b}`);

  // 5. end state
  const V = await verify(pool, plan, runStart);
  const wantContacts = plan.contacts.filter(x => x.action === 'create').length;
  const wantCases = plan.cases.length;
  say(`end state: ${V.contacts}/${wantContacts} planned contacts exist, ${V.cases}/${wantCases} planned cases created or linked`);
  for (const b of V.bad) say(`PROBLEM ${b}`);
  fs.writeFileSync(reportPath, report.join('\n') + '\n');
  if (V.bad.length || out.blocked.length) {
    console.log(`NO-GO — ${V.bad.length + out.blocked.length} problem(s) above; paste this output to Claude. Report: ${reportPath}`);
    return 1;
  }
  if (V.contacts < wantContacts || V.cases < wantCases) {
    console.log(`GO — partial run clean (${V.contacts}/${wantContacts} contacts, ${V.cases}/${wantCases} cases). Next: re-run with --apply ${limited ? 'without --limit ' : ''}to continue.`);
    return 0;
  }
  console.log('GO — backfill complete and verified. Next: re-run the lead-list analysis (its Clio clients are now YC contacts).');
  return 0;
}

if (require.main === module) {
  require('dotenv').config();
  const pool = require('../startup/db');
  main(pool)
    .then(code => { pool.end().catch(() => {}); setTimeout(() => process.exit(code), 3000); })
    .catch(err => { console.error(`\nNO-GO — FATAL: ${err.message}`); setTimeout(() => process.exit(1), 3000); });
}

module.exports = { main, loadPlan, check };
