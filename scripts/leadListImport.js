// scripts/leadListImport.js
//
/**
 * SS's old lead lists → YisraCase (lead-list merge arc, 2026-10-29).
 *
 * Two passes, driven by a reviewed PLAN file (JSON) built outside the repo —
 * it holds names, phones, emails and addresses, so it is NEVER committed. The
 * script holds no list data and no matching logic: the plan says what to write;
 * the script re-checks every row against the live DB right before writing it
 * and refuses anything that changed underneath.
 *
 *   tags     existing contacts whose phone/email is on a list get that list's
 *            source tag ('clio grow' / 'active campaign' / 'phil tirone').
 *            Tags only — no list value is added to an existing contact (Fred's
 *            ruling #6). Through contactService.updateContact, so the
 *            after_contact_update trigger logs the change; the merged string is
 *            built from the tags read immediately before the write, and the
 *            read-back must hold every tag that was there plus every tag added.
 *   creates  people on the lists that YC does not have, through
 *            contactService.createContact (contact_type 'person', like the 950
 *            earlier list contacts) with only values proven free — an active
 *            phone/email held by another contact would be silently
 *            force-transferred by createContact, so the check runs right before
 *            the call and a post-check fails the run if any 'transferred' row
 *            appears. Extra values go through createContactPhone /
 *            createContactEmail with force=false (a conflict is reported, never
 *            transferred). Then, raw, on rows this run just made:
 *            contact_created = the earliest Phil Tirone lead date, else NULL
 *            (unknown — not "today", so YC does not claim 1,900 people arrived
 *            this week); address2 and the address start_date; the notes the plan
 *            puts on a phone/email row (an Active Campaign bounce, a corrected
 *            typo domain).
 *   bounces  every address the lists mark as bounced in Active Campaign that is
 *            on a YC contact after this run — the created contacts' and the
 *            existing ones' — gets a provider_bounce opt-out, scope 'marketing'
 *            (Fred 2026-10-30, replacing ruling #5's "flag stays 0"), through
 *            optoutService.recordConsent, the one consent writer: ledger event +
 *            state + the row's email_optout cache. D18: a marketing opt-out never
 *            stops operational mail. provider_event_id
 *            'lead-import:ac-bounce:<address>' makes a re-run a no-op.
 *
 * SIDE EFFECTS that still run, from the services: the Google Contacts push
 * (every contact syncs; a push that fails is retried by the nightly sync) and
 * contact.created / contact.updated domain events. CHECK refuses while any
 * ACTIVE trigger rule listens to contact.created or contact.updated, because
 * this run would fire it ~2,300 times (--allow-contact-rules to override after
 * reading what the rule does).
 *
 * IDEMPOTENT / RESUMABLE: the DB is the ledger. A created contact carries a
 * "[lead:<key>]" marker in contact_notes; a re-run finds it and skips; a bounce
 * is found by its provider_event_id. The
 * follow-up writes after createContact are idempotent and re-applied to every
 * marked contact (a crash between createContact and them is healed). A tag
 * already present is not added twice. Progress is also appended to
 * <plan>.ledger.jsonl for the record.
 *
 * USAGE (from a worktree with node_modules + .env symlinked; .env targets
 * production through the Cloud SQL Auth Proxy):
 *   node scripts/leadListImport.js --plan ~/Downloads/lead_import_plan.json                    # CHECK (read-only)
 *   node scripts/leadListImport.js --plan ~/Downloads/lead_import_plan.json --apply --limit 5  # pilot
 *   node scripts/leadListImport.js --plan ~/Downloads/lead_import_plan.json --apply            # the rest
 * Options: --limit N   (apply: at most N tag updates, N creates and N bounces on existing contacts this run)
 *          --pace-ms M (pause after each write that pushes to Google; default 1200)
 *          --allow-contact-rules (see SIDE EFFECTS)
 * Ends on ONE line: GO — … / NO-GO — … . Details go to <plan>.report.txt.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_RULES = args.includes('--allow-contact-rules');
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PLAN_PATH = argVal('--plan');
const LIMIT = argVal('--limit') !== undefined ? parseInt(argVal('--limit'), 10) : Infinity;
const PACE_MS = argVal('--pace-ms') !== undefined ? parseInt(argVal('--pace-ms'), 10) : 1200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_RE = /^[2-9]\d{2}[2-9]\d{6}$/;
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[a-z]{2,}$/i;
const MARKER_RE = /\[lead:([A-Z]{2}-\d+(?:\.\d+)?)\]/g;
const KEY_RE = /^[A-Z]{2}-\d+(?:\.\d+)?$/;
const HELD_TAG = 'criminal law';            // Fred's ruling #1: that list is held for SS
const BOUNCE_PID_PREFIX = 'lead-import:ac-bounce:';
const bouncePid = (email) => BOUNCE_PID_PREFIX + lc(email);
const BOUNCE_EVIDENCE = { via: 'lead_import', signal: 'Active Campaign bouncedemail tag on the Phil Tirone list export' };
const LEN = { fname: 20, mname: 20, lname: 30, pname: 50, email: 100, address1: 100, address2: 100, city: 50, state: 20, zip: 10, tags: 255, rowNotes: 255 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const nameKey = (f, l) => `${lc(f).replace(/[^\p{L}]/gu, '')}|${lc(l).replace(/[^\p{L}]/gu, '')}`;   // letters only, as the analysis matched
const splitTags = (s) => String(s || '').split(',').map(t => t.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────
// plan
// ─────────────────────────────────────────────────────────────
function loadPlan(p) {
  if (!p) throw new Error('--plan <path> is required');
  const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (plan.version !== 1 || plan.kind !== 'lead_import') throw new Error(`plan is ${plan.kind} v${plan.version} — this script reads lead_import v1`);
  const problems = [];
  const tagIds = new Set();
  for (const t of plan.tags || []) {
    if (!Number.isInteger(t.contact_id)) problems.push(`${t.key}: contact_id`);
    if (tagIds.has(t.contact_id)) problems.push(`${t.key}: contact ${t.contact_id} listed twice`);
    tagIds.add(t.contact_id);
    if (!Array.isArray(t.add) || !t.add.length) problems.push(`${t.key}: nothing to add`);
    for (const x of t.add || []) {
      if (typeof x !== 'string' || !x.trim() || x.includes(',') || x !== x.trim()) problems.push(`${t.key}: bad tag ${JSON.stringify(x)}`);
      if (lc(x) === HELD_TAG) problems.push(`${t.key}: '${HELD_TAG}' is held`);
    }
    if (typeof t.fname !== 'string' || typeof t.lname !== 'string') problems.push(`${t.key}: expected name missing`);
  }
  const keys = new Set();
  const values = new Map();
  for (const c of plan.creates || []) {
    if (!KEY_RE.test(c.key || '')) problems.push(`${c.key}: key shape`);
    if (keys.has(c.key)) problems.push(`duplicate create key ${c.key}`);
    keys.add(c.key);
    if (!c.fname || !c.lname) problems.push(`${c.key}: missing first/last name`);
    for (const f of ['fname', 'mname', 'lname', 'pname']) if (String(c[f] || '').length > LEN[f]) problems.push(`${c.key}: ${f} longer than ${LEN[f]}`);
    if (!String(c.notes || '').includes(`[lead:${c.key}]`)) problems.push(`${c.key}: notes lack the [lead:${c.key}] marker`);
    if ((String(c.notes || '').match(MARKER_RE) || []).length !== 1) problems.push(`${c.key}: notes must carry exactly one [lead:] marker`);
    if (c.contact_created != null && !DATE_RE.test(c.contact_created)) problems.push(`${c.key}: contact_created ${c.contact_created}`);
    if (c.dob != null && !DATE_RE.test(c.dob)) problems.push(`${c.key}: dob ${c.dob}`);
    const tags = splitTags(c.tags);
    if (!tags.length) problems.push(`${c.key}: no source tag`);
    if (tags.map(lc).includes(HELD_TAG)) problems.push(`${c.key}: '${HELD_TAG}' is held`);
    if (String(c.tags).length > LEN.tags) problems.push(`${c.key}: tags longer than ${LEN.tags}`);
    if (!Array.isArray(c.phones) || !Array.isArray(c.emails) || !(c.phones.length + c.emails.length)) problems.push(`${c.key}: no phone or email`);
    for (const p of c.phones || []) {
      if (!PHONE_RE.test(p.phone || '')) problems.push(`${c.key}: phone ${p.phone}`);
      if (String(p.notes || '').length > LEN.rowNotes) problems.push(`${c.key}: phone notes too long`);
    }
    for (const e of c.emails || []) {
      if (!EMAIL_RE.test(e.email || '') || e.email !== lc(e.email) || e.email.length > LEN.email) problems.push(`${c.key}: email ${e.email}`);
      if (String(e.notes || '').length > LEN.rowNotes) problems.push(`${c.key}: email notes too long`);
      if (e.bounced !== undefined && typeof e.bounced !== 'boolean') problems.push(`${c.key}: email ${e.email} bounced must be true/false`);
    }
    for (const v of [...(c.phones || []).map(p => `p:${p.phone}`), ...(c.emails || []).map(e => `e:${e.email}`)]) {
      if (values.has(v)) problems.push(`${c.key}: ${v.slice(2)} also planned for ${values.get(v)}`);
      values.set(v, c.key);
    }
    const a = c.address;
    if (a) {
      for (const [f, n] of [['street', 'address1'], ['street2', 'address2'], ['city', 'city'], ['state', 'state'], ['zip', 'zip']]) {
        if (String(a[f] || '').length > LEN[n]) problems.push(`${c.key}: address ${f} too long`);
      }
    }
  }
  const bkeys = new Set();
  for (const b of plan.bounces || []) {
    if (b.key !== `bounce:${b.email}` || bkeys.has(b.key)) problems.push(`${b.key}: bounce key must be unique bounce:<email>`);
    bkeys.add(b.key);
    if (!EMAIL_RE.test(b.email || '') || b.email !== lc(b.email) || bouncePid(b.email).length > 128) problems.push(`${b.key}: email ${b.email}`);
    if (!Number.isInteger(b.contact_id)) problems.push(`${b.key}: contact_id`);
    if (values.has(`e:${b.email}`)) problems.push(`${b.key}: ${b.email} is also a planned create value`);
  }
  if (problems.length) throw new Error(`plan invalid:\n  ${problems.slice(0, 50).join('\n  ')}${problems.length > 50 ? `\n  … ${problems.length - 50} more` : ''}`);
  return plan;
}

// ─────────────────────────────────────────────────────────────
// live state
// ─────────────────────────────────────────────────────────────
async function assertSchema(db) {
  const [rows] = await db.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'contacts' AND COLUMN_NAME IN ('contact_tags','contact_notes','contact_created','contact_type'))
          OR (TABLE_NAME IN ('contact_phones','contact_emails') AND COLUMN_NAME IN ('notes','end_reason','updated_at'))
          OR (TABLE_NAME = 'contact_addresses' AND COLUMN_NAME IN ('address2','start_date'))
          OR (TABLE_NAME = 'trigger_rules' AND COLUMN_NAME IN ('event_type','active'))
          OR (TABLE_NAME = 'comm_consent_events' AND COLUMN_NAME IN ('provider_event_id','source'))
          OR (TABLE_NAME = 'comm_consent_state' AND COLUMN_NAME IN ('state','last_event_id')))`);
  const have = new Set(rows.map(r => `${r.t}.${r.c}`));
  const need = ['contacts.contact_tags', 'contacts.contact_notes', 'contacts.contact_created', 'contacts.contact_type',
    'contact_phones.notes', 'contact_phones.end_reason', 'contact_phones.updated_at',
    'contact_emails.notes', 'contact_emails.end_reason', 'contact_emails.updated_at',
    'contact_addresses.address2', 'contact_addresses.start_date', 'trigger_rules.event_type', 'trigger_rules.active',
    'comm_consent_events.provider_event_id', 'comm_consent_events.source', 'comm_consent_state.state', 'comm_consent_state.last_event_id'];
  const missing = need.filter(n => !have.has(n));
  if (missing.length) throw new Error(`schema check failed — missing ${missing.join(', ')}`);
}

async function contactRules(db) {
  const [r] = await db.query(
    "SELECT id, event_type, name FROM trigger_rules WHERE active = 1 AND event_type IN ('contact.created', 'contact.updated') ORDER BY id");
  return r;
}

async function loadLive(db) {
  const L = { holder: new Map(), contacts: new Map(), byMarker: new Map(), names: new Map(), bounced: new Set() };   // names: 'first|last' → ids; bounced: pids recorded
  const [cs] = await db.query(
    `SELECT contact_id, contact_fname, contact_lname, contact_tags, contact_phone, contact_phone2, contact_email, contact_email2,
            CASE WHEN contact_notes LIKE '%[lead:%' THEN contact_notes END AS notes
       FROM contacts`);
  const legacy = new Map();
  for (const c of cs) {
    L.contacts.set(c.contact_id, c);
    if (c.notes) for (const m of String(c.notes).matchAll(MARKER_RE)) L.byMarker.set(m[1], c.contact_id);
    const nk = nameKey(c.contact_fname, c.contact_lname);
    if (!L.names.has(nk)) L.names.set(nk, []);
    L.names.get(nk).push(c.contact_id);
    for (const [k, v] of [['p', c.contact_phone], ['p', c.contact_phone2], ['e', c.contact_email], ['e', c.contact_email2]]) {
      if (v && String(v).trim() && !legacy.has(`${k}:${lc(v)}`)) legacy.set(`${k}:${lc(v)}`, c.contact_id);
    }
  }
  for (const [k, id] of legacy) L.holder.set(k, id);
  const [ps] = await db.query('SELECT phone, contact_id FROM contact_phones WHERE end_date IS NULL');
  for (const p of ps) L.holder.set(`p:${p.phone}`, p.contact_id);          // the active child row wins over a legacy column
  const [es] = await db.query('SELECT email, contact_id FROM contact_emails WHERE end_date IS NULL');
  for (const e of es) L.holder.set(`e:${lc(e.email)}`, e.contact_id);
  const [bs] = await db.query(
    "SELECT provider_event_id AS pid FROM comm_consent_events WHERE source = 'provider_bounce' AND provider_event_id LIKE ?", [`${BOUNCE_PID_PREFIX}%`]);
  for (const b of bs) L.bounced.add(b.pid);
  return L;
}

/** Every bounce the plan asks for: the created contacts' bounced emails, then the existing contacts' addresses. */
function bounceTargets(plan, L) {
  const out = [];
  for (const c of plan.creates) {
    for (const e of c.emails) {
      if (!e.bounced) continue;
      const contactId = L.byMarker.get(c.key) || null;
      out.push({ key: `${c.key}:${lc(e.email)}`, email: lc(e.email), createKey: c.key, contactId,
        notCreated: !contactId && checkCreate(L, c).state === 'now_in_yc' });
    }
  }
  for (const b of plan.bounces || []) out.push({ key: b.key, email: lc(b.email), createKey: null, contactId: b.contact_id });
  return out;
}

function checkBounce(L, b) {
  if (L.bounced.has(bouncePid(b.email))) return { state: 'done' };
  if (b.notCreated) return { state: 'skip', why: `${b.key}: its contact is not being created (now in YC) — no bounce recorded` };
  if (b.createKey && !b.contactId) return { state: 'pending' };            // recorded with its create
  const h = L.holder.get(`e:${b.email}`);
  if (h !== b.contactId) return { state: 'skip', why: `${b.key}: ${b.email} is ${h ? `on YC #${h}` : 'not active on any contact'} now, not #${b.contactId} — no bounce recorded` };
  return { state: 'todo' };
}

const planValues = (c) => [...c.phones.map(p => `p:${p.phone}`), ...c.emails.map(e => `e:${lc(e.email)}`)];

// ─────────────────────────────────────────────────────────────
// CHECK — classify every row against the live state (no writes)
// ─────────────────────────────────────────────────────────────
function checkTag(L, t) {
  const y = L.contacts.get(t.contact_id);
  if (!y) return { state: 'blocked', why: `${t.key}: YC contact #${t.contact_id} not found` };
  if (nameKey(y.contact_fname, y.contact_lname) !== nameKey(t.fname, t.lname)) {     // a case or punctuation fix is not a different person
    return { state: 'blocked', why: `${t.key}: #${t.contact_id} is now "${y.contact_fname} ${y.contact_lname}", the plan expected "${t.fname} ${t.lname}"` };
  }
  const cur = splitTags(y.contact_tags);
  const missing = t.add.filter(x => !cur.map(lc).includes(lc(x)));
  if (!missing.length) return { state: 'done' };
  const merged = [...cur, ...missing].join(',');
  if (merged.length > LEN.tags) return { state: 'blocked', why: `${t.key}: tags would be ${merged.length} characters (max ${LEN.tags})` };
  return { state: 'todo', merged, missing };
}

function checkCreate(L, c) {
  const id = L.byMarker.get(c.key);
  if (id) return { state: 'done', id };
  // the plan's premise for every create: no YC contact holds any of its values or has its exact name.
  // Either one appearing since the snapshot means the person may be in YC now — skip, never create a duplicate.
  const held = planValues(c).filter(v => L.holder.has(v)).map(v => `${v.slice(2)} → YC #${L.holder.get(v)}`);
  if (held.length) return { state: 'now_in_yc', why: `${c.key} ${c.fname} ${c.lname}: ${held.join(', ')} — not created (re-run the analysis; this person is now a tag, not a create)` };
  const same = L.names.get(nameKey(c.fname, c.lname));
  if (same) return { state: 'now_in_yc', why: `${c.key} ${c.fname} ${c.lname}: YC now has a contact with this exact name (#${same.join(', #')}) — not created (one person or two is for a human)` };
  return { state: 'todo' };
}

function check(plan, L) {
  const R = { tags: { todo: 0, done: 0 }, creates: { todo: 0, done: 0, now_in_yc: 0 }, bounces: { todo: 0, pending: 0, done: 0, skip: 0 }, blocked: [], skipped: [] };
  for (const t of plan.tags) {
    const s = checkTag(L, t);
    if (s.state === 'blocked') R.blocked.push(s.why); else R.tags[s.state]++;
  }
  for (const c of plan.creates) {
    const s = checkCreate(L, c);
    R.creates[s.state]++;
    if (s.state === 'now_in_yc') R.skipped.push(s.why);
  }
  for (const b of bounceTargets(plan, L)) {
    const s = checkBounce(L, b);
    R.bounces[s.state]++;
    if (s.state === 'skip') R.skipped.push(s.why);
  }
  return R;
}

// ─────────────────────────────────────────────────────────────
// APPLY
// ─────────────────────────────────────────────────────────────
function ledger(file, row) {
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

async function applyTag(db, svc, t) {
  const [[y]] = await db.query('SELECT contact_fname, contact_lname, contact_tags FROM contacts WHERE contact_id = ?', [t.contact_id]);
  const s = checkTag({ contacts: new Map(y ? [[t.contact_id, y]] : []) }, t);
  if (s.state === 'blocked') throw new Error(s.why);
  if (s.state === 'done') return false;
  const before = splitTags(y.contact_tags);
  await svc.contact.updateContact(db, t.contact_id, { contact_tags: s.merged }, { userId: 0 });
  const [[back]] = await db.query('SELECT contact_tags FROM contacts WHERE contact_id = ?', [t.contact_id]);
  const after = splitTags(back.contact_tags).map(lc);
  const lost = before.filter(x => !after.includes(lc(x)));
  const absent = t.add.filter(x => !after.includes(lc(x)));
  if (lost.length || absent.length) {
    throw new Error(`${t.key}: tag read-back on #${t.contact_id} is "${back.contact_tags}" (lost: ${lost.join('|') || '-'}; missing: ${absent.join('|') || '-'}) — STOP`);
  }
  return true;
}

// One bounce: ledger event + state + the active row's cache, in one pure-DB transaction.
async function recordBounce(db, svc, b, contactId, out) {
  const r = await db.withTransaction((conn) => svc.optout.recordConsent(conn, {
    channel: 'email', destination: b.email, scope: 'marketing', action: 'opt_out', source: 'provider_bounce',
    providerEventId: bouncePid(b.email), contactId, evidence: { ...BOUNCE_EVIDENCE, lead_key: b.key },
  }), { retries: 1 });
  if (!r.duplicate && r.state !== 'opted_out') out.held.push(`${b.key}: bounce recorded but a newer consent decision for ${b.email} stands (${r.state})`);
  return !r.duplicate;
}

// The writes after createContact. Idempotent: run on every create, and again on any marked
// contact a crashed run left, so a half-done contact is completed rather than skipped.
async function finishCreate(db, svc, L, c, id, out) {
  await db.query('UPDATE contacts SET contact_created = ? WHERE contact_id = ? AND NOT (contact_created <=> ?)',
    [c.contact_created ? `${c.contact_created} 00:00:00` : null, id, c.contact_created ? `${c.contact_created} 00:00:00` : null]);
  if (c.address) {
    await db.query(
      `UPDATE contact_addresses SET address2 = ?, start_date = ?
        WHERE contact_id = ? AND end_date IS NULL AND (address2 <> ? OR NOT (start_date <=> ?))`,
      [c.address.street2 || '', c.contact_created || null, id, c.address.street2 || '', c.contact_created || null]);
  }
  const [ps] = await db.query('SELECT phone, notes FROM contact_phones WHERE contact_id = ? AND end_date IS NULL', [id]);
  const [es] = await db.query('SELECT email, notes FROM contact_emails WHERE contact_id = ? AND end_date IS NULL', [id]);
  const havePhone = new Map(ps.map(p => [p.phone, p.notes]));
  const haveEmail = new Map(es.map(e => [lc(e.email), e.notes]));
  for (const p of c.phones) {
    if (havePhone.has(p.phone)) {
      if (p.notes && !havePhone.get(p.phone)) {
        await db.query("UPDATE contact_phones SET notes = ? WHERE contact_id = ? AND phone = ? AND end_date IS NULL AND notes = ''", [p.notes, id, p.phone]);
      }
      continue;
    }
    const h = L.holder.get(`p:${p.phone}`);
    if (h && h !== id) { out.held.push(`${c.key} phone ${p.phone} held by YC #${h} — not added`); continue; }
    try {
      await svc.phone.createContactPhone(db, id, { phone: p.phone, label: 'Other', is_primary: 0, notes: p.notes || '' }, { force: false, createdBy: 0 });
      L.holder.set(`p:${p.phone}`, id);
    } catch (e) { out.held.push(`${c.key} phone ${p.phone} not added: ${e.message}`); }
  }
  for (const e of c.emails) {
    const v = lc(e.email);
    if (haveEmail.has(v)) {
      if (e.notes && !haveEmail.get(v)) {
        await db.query("UPDATE contact_emails SET notes = ? WHERE contact_id = ? AND email = ? AND end_date IS NULL AND notes = ''", [e.notes, id, v]);
      }
      continue;
    }
    const h = L.holder.get(`e:${v}`);
    if (h && h !== id) { out.held.push(`${c.key} email ${v} held by YC #${h} — not added`); continue; }
    try {
      await svc.email.createContactEmail(db, id, { email: v, label: 'Other', is_primary: 0, notes: e.notes || '' }, { force: false, createdBy: 0 });
      L.holder.set(`e:${v}`, id);
    } catch (err) { out.held.push(`${c.key} email ${v} not added: ${err.message}`); }
  }
  for (const e of c.emails.filter(x => x.bounced)) {
    const v = lc(e.email);
    if (L.holder.get(`e:${v}`) !== id || L.bounced.has(bouncePid(v))) continue;
    await recordBounce(db, svc, { key: `${c.key}:${v}`, email: v }, id, out);
    L.bounced.add(bouncePid(v));
  }
}

async function createOne(db, svc, L, c, runStart, out) {
  const phone = c.phones[0] ? c.phones[0].phone : '';
  const email = c.emails[0] ? lc(c.emails[0].email) : '';
  // the two values createContact takes: re-check against the DB itself, right before the call
  for (const [sql, v] of [
    ['SELECT contact_id FROM contact_phones WHERE phone = ? AND end_date IS NULL LIMIT 1', phone],
    ['SELECT contact_id FROM contact_emails WHERE email = ? AND end_date IS NULL LIMIT 1', email],
    ['SELECT contact_id FROM contacts WHERE contact_phone = ? OR contact_phone2 = ? LIMIT 1', phone],
    ['SELECT contact_id FROM contacts WHERE contact_email = ? OR contact_email2 = ? LIMIT 1', email],
  ]) {
    if (!v) continue;
    const [[hit]] = await db.query(sql, sql.includes(' OR ') ? [v, v] : [v]);
    if (hit) throw new Error(`${c.key}: ${v} became active on YC #${hit.contact_id} since CHECK — stopping before createContact could transfer it`);
  }
  const a = c.address || {};
  const created = await svc.contact.createContact(db, {
    kind: 'person', fname: c.fname, mname: c.mname || '', lname: c.lname, pname: c.pname || '',
    phone, email, type: 'person',
    address: a.street || '', city: a.city || '', state: a.state || '', zip: a.zip || '',
    dob: c.dob || null, tags: c.tags, notes: c.notes,
  }, { userId: 0 });
  const id = created.contact_id;

  // createContact transfers on collision; nothing may have been transferred
  const vals = [phone, email].filter(Boolean);
  const [[t]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM contact_phones WHERE end_reason = 'transferred' AND contact_id <> ? AND phone IN (?) AND updated_at >= ?)
          + (SELECT COUNT(*) FROM contact_emails WHERE end_reason = 'transferred' AND contact_id <> ? AND email IN (?) AND updated_at >= ?) AS n`,
    [id, vals, runStart, id, vals, runStart]);
  if (t.n > 0) throw new Error(`${c.key}: createContact transferred a value off another contact (new contact #${id}) — STOP and inspect`);
  for (const v of [phone && `p:${phone}`, email && `e:${email}`].filter(Boolean)) L.holder.set(v, id);
  L.byMarker.set(c.key, id);

  await finishCreate(db, svc, L, c, id, out);
  await assertCreated(db, c, id);
  return id;
}

async function assertCreated(db, c, id) {
  const [[row]] = await db.query(
    `SELECT contact_type, contact_tags, contact_phone, contact_email, DATE_FORMAT(contact_created, '%Y-%m-%d') created,
            (contact_notes LIKE ?) AS marked
       FROM contacts WHERE contact_id = ?`, [`%[lead:${c.key}]%`, id]);
  const bad = [];
  if (!row) bad.push('row missing');
  else {
    if (!row.marked) bad.push('marker missing');
    if (row.contact_type !== 'person') bad.push(`contact_type ${row.contact_type}`);
    if (row.contact_tags !== c.tags) bad.push(`tags "${row.contact_tags}"`);
    if ((row.created || null) !== (c.contact_created || null)) bad.push(`contact_created ${row.created}`);
    if (c.phones[0] && row.contact_phone !== c.phones[0].phone) bad.push(`contact_phone mirror ${row.contact_phone}`);
    if (c.emails[0] && lc(row.contact_email) !== lc(c.emails[0].email)) bad.push(`contact_email mirror ${row.contact_email}`);
  }
  if (bad.length) throw new Error(`${c.key}: read-back on #${id}: ${bad.join('; ')}`);
}

async function verify(db, plan, runStart) {
  const L = await loadLive(db);
  const bad = [];
  let created = 0, tagged = 0;
  for (const c of plan.creates) if (L.byMarker.has(c.key)) created++;
  for (const t of plan.tags) if (checkTag(L, t).state === 'done') tagged++;
  // a value transferred off another contact by this run (updated_by 0 is createContact's userId here) …
  const [[x]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM contact_phones WHERE end_reason = 'transferred' AND updated_by = 0 AND updated_at >= ?)
          + (SELECT COUNT(*) FROM contact_emails WHERE end_reason = 'transferred' AND updated_by = 0 AND updated_at >= ?) AS n`, [runStart, runStart]);
  if (x.n > 0) bad.push(`${x.n} phone/email row(s) ended as 'transferred' by an automated write since this run started`);
  // … or by ANY earlier run: a donor row ended 'transferred' when an imported contact's active row was made
  const [[y]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM contact_phones a
               JOIN contacts c ON c.contact_id = a.contact_id AND c.contact_notes LIKE '%[lead:%'
               JOIN contact_phones d ON d.phone = a.phone AND d.contact_id <> a.contact_id AND d.end_reason = 'transferred'
                                    AND d.updated_at >= a.created_at - INTERVAL 5 MINUTE
              WHERE a.end_date IS NULL)
          + (SELECT COUNT(*) FROM contact_emails a
               JOIN contacts c ON c.contact_id = a.contact_id AND c.contact_notes LIKE '%[lead:%'
               JOIN contact_emails d ON d.email = a.email AND d.contact_id <> a.contact_id AND d.end_reason = 'transferred'
                                    AND d.updated_at >= a.created_at - INTERVAL 5 MINUTE
              WHERE a.end_date IS NULL) AS n`);
  if (y.n > 0) bad.push(`${y.n} value(s) on imported contacts were transferred off another contact when they were added`);
  // mirror columns agree with the primary active child rows on every imported contact
  const [[m]] = await db.query(
    `SELECT COUNT(*) AS n FROM contacts c
      WHERE c.contact_notes LIKE '%[lead:%'
        AND (c.contact_phone <> COALESCE((SELECT p.phone FROM contact_phones p WHERE p.contact_id = c.contact_id AND p.is_primary = 1 AND p.end_date IS NULL), '')
          OR c.contact_email <> COALESCE((SELECT e.email FROM contact_emails e WHERE e.contact_id = c.contact_id AND e.is_primary = 1 AND e.end_date IS NULL), ''))`);
  if (m.n > 0) bad.push(`${m.n} imported contact(s) whose contact_phone/contact_email mirror disagrees with the primary row`);
  const [[d]] = await db.query(
    `SELECT COUNT(*) AS n FROM (
       SELECT phone FROM contact_phones WHERE end_date IS NULL GROUP BY phone HAVING COUNT(*) > 1
       UNION ALL
       SELECT email FROM contact_emails WHERE end_date IS NULL GROUP BY email HAVING COUNT(*) > 1) z`);
  if (d.n > 0) bad.push(`${d.n} phone/email value(s) active on more than one contact`);
  // every bounce this script recorded stands as an opt-out, cached on the address's active row —
  // unless a NEWER consent event has since replaced it (a staff opt-in is a decision, not a fault)
  const [bv] = await db.query(
    `SELECT e.id, e.destination, s.state, s.last_event_id, ce.email_optout AS cache
       FROM comm_consent_events e
       LEFT JOIN comm_consent_state s ON s.channel = 'email' AND s.destination = e.destination AND s.scope = 'marketing'
       LEFT JOIN contact_emails ce ON ce.email_active_uniq = e.destination
      WHERE e.source = 'provider_bounce' AND e.provider_event_id LIKE ?`, [`${BOUNCE_PID_PREFIX}%`]);
  const broken = bv.filter(r => !r.state || (Number(r.last_event_id) === Number(r.id) && (r.state !== 'opted_out' || (r.cache != null && Number(r.cache) !== 1))));
  if (broken.length) bad.push(`${broken.length} recorded bounce(s) whose consent state or row cache is not the opt-out (${broken.slice(0, 3).map(r => r.destination).join(', ')}…)`);
  const B = { done: 0, left: 0, skip: 0 };
  for (const b of bounceTargets(plan, L)) {
    const st = checkBounce(L, b).state;
    if (st === 'done') B.done++; else if (st === 'skip') B.skip++; else B.left++;
  }
  return { created, tagged, bad, bounces: B };
}

// ─────────────────────────────────────────────────────────────
async function main(pool) {
  const plan = loadPlan(PLAN_PATH);
  const reportPath = `${PLAN_PATH}.report.txt`;
  const ledgerPath = `${PLAN_PATH}.ledger.jsonl`;
  const report = [];
  const say = (s) => { console.log(s); report.push(s); };
  const flush = () => fs.writeFileSync(reportPath, report.join('\n') + '\n');

  const [[who]] = await pool.query('SELECT DATABASE() AS db, @@hostname AS host');
  say(`=== leadListImport — ${APPLY ? 'APPLY' : 'CHECK (read-only)'} — db ${who.db} on ${who.host} — plan of ${plan.generated} ===`);
  await assertSchema(pool);
  const rules = await contactRules(pool);
  for (const r of rules) say(`${ALLOW_RULES ? 'NOTE' : 'BLOCKED'} active trigger rule ${r.id} "${r.name}" listens to ${r.event_type} — this run would fire it once per contact`);
  let L = await loadLive(pool);
  const R = check(plan, L);
  say(`tags:    ${R.tags.todo} contact(s) to tag, ${R.tags.done} already tagged (plan ${plan.tags.length})`);
  say(`creates: ${R.creates.todo} to create, ${R.creates.done} already created, ${R.creates.now_in_yc} now in YC by phone/email — skipped (plan ${plan.creates.length})`);
  say(`bounces: ${R.bounces.todo} to record now, ${R.bounces.pending} with their create, ${R.bounces.done} already recorded, ${R.bounces.skip} skipped — address not on its contact`);
  for (const s of R.skipped) report.push(`SKIP ${s}`);
  for (const b of R.blocked) say(`BLOCKED ${b}`);
  if (R.skipped.length) say(`${R.skipped.length} skipped item(s) listed in ${path.basename(reportPath)}`);
  const blockedN = R.blocked.length + (ALLOW_RULES ? 0 : rules.length);

  if (!APPLY) {
    flush();
    if (blockedN) { console.log(`NO-GO — ${blockedN} blocked item(s) above; fix the plan or YC first. Report: ${reportPath}`); return 1; }
    if (!R.tags.todo && !R.creates.todo && !R.bounces.todo && !R.bounces.pending) { console.log('GO — nothing left to do: every planned tag, contact and bounce is already in YC.'); return 0; }
    console.log(`GO — CHECK clean. Next: node scripts/leadListImport.js --plan ${PLAN_PATH} --apply --limit 5   (pilot), then without --limit`);
    return 0;
  }
  if (blockedN) {
    flush();
    console.log(`NO-GO — refusing to apply with ${blockedN} blocked item(s). Run CHECK, fix, re-run.`);
    return 1;
  }

  const svc = {
    contact: require('../services/contactService'),
    phone: require('../services/contactPhoneService'),
    email: require('../services/contactEmailService'),
    optout: require('../services/optoutService'),
  };
  const [[{ now: runStart }]] = await pool.query('SELECT NOW() AS now');
  const out = { held: [] };

  // 1. tags on existing contacts
  let n = 0;
  for (const t of plan.tags) {
    if (n >= LIMIT) break;
    if (checkTag(L, t).state !== 'todo') continue;
    if (await applyTag(pool, svc, t)) {
      n++; ledger(ledgerPath, { key: t.key, did: 'tagged', contact_id: t.contact_id, add: t.add });
      if (n % 25 === 0) console.log(`  … ${n} tagged`);
      await sleep(PACE_MS);
    }
  }
  say(`contacts tagged: ${n}`);

  // 2. heal contacts an earlier run created but did not finish. A 'contact_created' ledger line is
  //    written only after a create's follow-ups AND its read-back passed, so only marked contacts
  //    without one are re-done (all of them when the ledger is gone — slower, same result).
  const finished = new Set();
  if (fs.existsSync(ledgerPath)) {
    for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
      try { const r = JSON.parse(line); if (r.did === 'contact_created') finished.add(r.key); } catch (_) { /* partial last line */ }
    }
  }
  let healed = 0;
  for (const c of plan.creates) {
    const id = L.byMarker.get(c.key);
    if (!id || finished.has(c.key)) continue;
    await finishCreate(pool, svc, L, c, id, out);
    try {
      await assertCreated(pool, c, id);
      ledger(ledgerPath, { key: c.key, did: 'contact_created', contact_id: id, healed: true });
    } catch (e) { say(`PROBLEM ${e.message}`); out.problem = true; }
    healed++;
  }
  if (healed) say(`finished ${healed} contact(s) an earlier run created but did not finish`);

  // 3. creates
  n = 0;
  let skipped = 0;
  for (const c of plan.creates) {
    if (n >= LIMIT) break;
    const s = checkCreate(L, c);
    if (s.state === 'done') continue;
    if (s.state === 'now_in_yc') { skipped++; continue; }
    const id = await createOne(pool, svc, L, c, runStart, out);
    n++;
    ledger(ledgerPath, { key: c.key, did: 'contact_created', contact_id: id });
    if (n % 25 === 0) console.log(`  … ${n} contacts`);
    await sleep(PACE_MS);
  }
  say(`contacts created: ${n}${Number.isFinite(LIMIT) ? ` (limit ${LIMIT})` : ''}${skipped ? `; ${skipped} skipped — now in YC by phone/email` : ''}`);

  // 4. bounces not recorded yet: existing contacts' addresses, and any create whose bounce a crash skipped
  L = await loadLive(pool);
  n = 0;
  for (const b of bounceTargets(plan, L)) {
    if (checkBounce(L, b).state !== 'todo') continue;
    if (!b.createKey && n >= LIMIT) continue;
    if (await recordBounce(pool, svc, b, b.contactId, out)) {
      n++; ledger(ledgerPath, { key: b.key, did: 'bounce_recorded', contact_id: b.contactId });
    }
  }
  say(`bounce opt-outs recorded this pass: ${n}${Number.isFinite(LIMIT) ? ` (limit ${LIMIT} on existing contacts)` : ''}`);

  for (const h of out.held) report.push(`HELD ${h}`);
  if (out.held.length) say(`values not added (held elsewhere / refused): ${out.held.length} (see ${path.basename(reportPath)})`);

  // 5. end state
  const V = await verify(pool, plan, runStart);
  say(`end state: ${V.tagged}/${plan.tags.length} planned tag updates present, ${V.created}/${plan.creates.length} planned contacts exist, ` +
      `${V.bounces.done} bounce opt-outs recorded (${V.bounces.left} left, ${V.bounces.skip} skipped)`);
  for (const b of V.bad) say(`PROBLEM ${b}`);
  flush();
  if (V.bad.length || out.problem) {
    console.log(`NO-GO — problem(s) above; paste this output to Claude. Report: ${reportPath}`);
    return 1;
  }
  const leftTags = plan.tags.length - V.tagged;
  const leftCreates = plan.creates.length - V.created - R.creates.now_in_yc;
  if (leftTags > 0 || leftCreates > 0 || V.bounces.left > 0) {
    console.log(`GO — partial run clean (${V.tagged}/${plan.tags.length} tags, ${V.created}/${plan.creates.length} contacts, ${V.bounces.done} bounces). Next: re-run with --apply${Number.isFinite(LIMIT) ? ' without --limit' : ''} to continue.`);
    return 0;
  }
  console.log(`GO — lead import complete and verified (${V.tagged} tagged, ${V.created} created, ${V.bounces.done} bounce opt-outs${R.creates.now_in_yc ? `, ${R.creates.now_in_yc} skipped as now in YC` : ''}). Next: the raw-table drop (scripts/leadListPtTableDrop.js).`);
  return 0;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  let pool = null;
  (async () => {
    const proxy = await require('./ensure-sql-proxy').ensureSqlProxy();
    if (proxy.status === 'failed') throw new Error(`the Cloud SQL proxy is not working: ${proxy.reason}`);
    pool = require('../startup/db');
    return main(pool);
  })()
    .then(code => { pool.end().catch(() => {}); setTimeout(() => process.exit(code), 3000); })
    .catch(err => { console.error(`\nNO-GO — FATAL: ${err.message}`); setTimeout(() => process.exit(1), 3000); });
}

module.exports = { main, loadPlan, check };
