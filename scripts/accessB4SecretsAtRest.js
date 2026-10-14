#!/usr/bin/env node
// scripts/accessB4SecretsAtRest.js
//
/**
 * Access-control B4 — secret VALUES inside two JSON config columns, encrypted
 * at rest with lib/credentialCrypto (ENCv1), so read-only sessions stop seeing
 * them while every other key in those columns stays queryable.
 *
 *   Stage A  credentials.config   api_key.key / bearer.token / basic.password
 *            (oauth2 client_secret has been encrypted since the Connections
 *            arc; the stage asserts it still is)
 *   Stage B  hooks.auth_config    api_key → $.key, hmac → $.secret
 *
 * ref/ACCESS_CONTROL_DESIGN.md §5.5 (amended 2026-10-14). The applied shape is
 * recorded in ref/migrations/2026-10-14_access_b4_secrets_at_rest.sql.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ DEPLOY ORDER — REVERSED FROM B1/A5: CODE FIRST, THEN THIS SCRIPT.        │
 * │ The B4 code reads both shapes (an ENCv1 value is decrypted, anything     │
 * │ else passes through — lib/secretAtRest.readSecret). The PRE-B4 code      │
 * │ reads plaintext only: run this before the deploy and every api_key       │
 * │ credential and every authenticated hook breaks until it lands.           │
 * │   1. land + deploy B4   2. node scripts/accessB4SecretsAtRest.js         │
 * │   3. ... --apply        (re-runnable; each stage resumes on its own)     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * USAGE (repo root, .env reaches production — same setup as npm run db:ref):
 *   node scripts/accessB4SecretsAtRest.js           # CHECK — read-only, prints plan
 *   node scripts/accessB4SecretsAtRest.js --apply   # run it
 * One GO / NO-GO line per stage, then one overall line naming the next command.
 *
 * Both stages' base asserts run BEFORE any write (all-or-nothing preflight);
 * only then does --apply touch rows. Each row is rewritten compare-and-swap (WHERE the column still holds what
 * was read), so a concurrent edit through the UI is never clobbered — the
 * row is reported and left for the re-run. Every encrypted row is verified
 * through the REAL read paths: credentialInjection.buildAuthHeaders for
 * credentials, hookService.authenticateRequest for hooks (a real api_key
 * header / HMAC signature over a sample body).
 */

'use strict';

const crypto = require('crypto');

// Verified live 2026-10-14 (readonly SQL): the rows holding plaintext secrets.
const EXPECTED_CREDENTIAL_IDS = [10, 12, 14];                    // api_key: Quo, Claude, Assembly AI
const EXPECTED_HOOK_IDS = [5, 21, 22, 23, 32, 36, 38, 40];      // 6 api_key + 2 hmac (Calendly)

function deps() {
  // Lazy: credentialCrypto fails fast without CREDENTIALS_ENCRYPTION_KEY.
  const credentialCrypto = require('../lib/credentialCrypto');
  const sar = require('../lib/secretAtRest');
  return { credentialCrypto, sar };
}

const parse = (v) => (v == null ? null : typeof v === 'object' ? v : JSON.parse(v));

// MySQL JSON re-orders object keys on write (CLAUDE.md, wf50): compare with
// sorted keys, never raw JSON.stringify.
const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => (a[k] = o[k], a), {}));
const othersIntact = (stored, original, field) =>
  canon({ ...stored, [field]: null }) === canon({ ...original, [field]: null });

/**
 * The local CREDENTIALS_ENCRYPTION_KEY must be PRODUCTION's: encrypting with
 * any other key would make every migrated secret unreadable to the app. The
 * oauth2 client_secrets have been ENCv1 since the Connections arc — if this
 * key can't decrypt one of them, stop before writing anything.
 */
async function keyMatchesProduction(conn) {
  const { credentialCrypto } = deps();
  const [rows] = await conn.query(
    "SELECT id, JSON_UNQUOTE(JSON_EXTRACT(config, '$.client_secret')) cs FROM credentials WHERE type = 'oauth2'");
  const sample = rows.find(r => credentialCrypto.isEncrypted(r.cs));
  if (!sample) return { ok: false, why: 'no ENCv1 oauth2 client_secret exists to test the key against' };
  try { credentialCrypto.decrypt(sample.cs); return { ok: true, id: sample.id }; }
  catch (err) { return { ok: false, why: `credential ${sample.id}'s client_secret does not decrypt with this key (${err.message})` }; }
}

// ── Stage A: credentials ─────────────────────────────────────────────────────

async function credentialPlan(conn) {
  const { credentialCrypto, sar } = deps();
  const [rows] = await conn.query('SELECT id, name, type, config, allowed_urls FROM credentials ORDER BY id');
  const plain = [];
  const oauthPlain = [];
  for (const r of rows) {
    const cfg = parse(r.config);
    if (!cfg || typeof cfg !== 'object') continue;
    for (const f of sar.fieldsFor(sar.CREDENTIAL_SECRET_FIELDS, r.type)) {
      const v = cfg[f];
      if (typeof v === 'string' && v.length && !credentialCrypto.isEncrypted(v)) {
        (r.type === 'oauth2' ? oauthPlain : plain).push({ row: r, cfg, field: f });
      }
    }
  }
  return { plain, oauthPlain };
}

/** A concrete URL inside the credential's first allowed_urls pattern (for the scope check). */
function sampleUrl(allowed) {
  const list = parse(allowed);
  const p = Array.isArray(list) ? list.find(x => typeof x === 'string') : null;
  return p ? p.replace(/\*/g, 'b4-verify') : undefined;
}

async function stageCredentials(conn, apply) {
  const { credentialCrypto, sar } = deps();
  const { buildAuthHeaders } = require('../lib/credentialInjection');
  const { plain, oauthPlain } = await credentialPlan(conn);
  console.log('Stage A — credentials.config');
  if (oauthPlain.length) {
    console.log(`  oauth2 client_secret in PLAINTEXT on credential(s) ${oauthPlain.map(p => p.row.id).join(', ')} — expected none.`);
    console.log('  NO-GO (A) — re-verify by hand; this stage changes nothing.');
    return { ok: false };
  }
  const stray = plain.filter(p => !EXPECTED_CREDENTIAL_IDS.includes(p.row.id));
  if (stray.length) {
    console.log(`  plaintext secret on unexpected credential(s): ${stray.map(p => `${p.row.id} ${p.row.type}.${p.field}`).join(', ')} — expected only ${EXPECTED_CREDENTIAL_IDS.join(', ')}.`);
    console.log('  NO-GO (A) — re-verify by hand. Nothing was changed.');
    return { ok: false };
  }
  if (!plain.length) {
    console.log('  every static secret is already encrypted ✓');
    console.log('  GO (A) — nothing to do.');
    return { ok: true, done: true };
  }
  for (const p of plain) console.log(`  credential ${p.row.id} (${p.row.name}, ${p.row.type}): ${p.field} is plaintext → encrypt`);
  if (!apply) { console.log('  GO (A) — base state matches.'); return { ok: true }; }

  for (const p of plain) {
    const enc = sar.encryptFields(p.cfg, [p.field]);
    const before = JSON.stringify(p.cfg);
    const [res] = await conn.query(
      'UPDATE credentials SET config = ? WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(config, ?)) = ?',
      [JSON.stringify(enc), p.row.id, `$.${p.field}`, p.cfg[p.field]]
    );
    if (res.affectedRows !== 1) {
      console.log(`  credential ${p.row.id}: row changed underneath (affected ${res.affectedRows}) — left for the re-run.`);
      console.log('  NO-GO (A) — re-run CHECK.');
      return { ok: false };
    }
    const [[after]] = await conn.query('SELECT id, type, config, allowed_urls FROM credentials WHERE id = ?', [p.row.id]);
    const stored = parse(after.config);
    const readBack = sar.readSecret(stored[p.field]);
    const others = othersIntact(stored, JSON.parse(before), p.field);
    let headerOk = null;
    const url = sampleUrl(after.allowed_urls);
    if (after.type === 'api_key' && url) {
      const h = buildAuthHeaders(after, url);
      headerOk = h[(stored.header || 'x-api-key')] === p.cfg[p.field];
    }
    if (!credentialCrypto.isEncrypted(stored[p.field]) || readBack !== p.cfg[p.field] || !others || headerOk === false) {
      console.log(`  credential ${p.row.id}: verify FAILED (encrypted=${credentialCrypto.isEncrypted(stored[p.field])}, round-trip=${readBack === p.cfg[p.field]}, other keys intact=${others}, chokepoint header=${headerOk}).`);
      console.log('  NO-GO (A) — verify by hand.');
      return { ok: false };
    }
    console.log(`  ✓ credential ${p.row.id}: ${p.field} encrypted; round-trip ok; other keys intact; chokepoint header ${headerOk === null ? 'n/a' : 'ok'}`);
  }
  console.log('  GO (A) — applied and verified.');
  return { ok: true };
}

// ── Stage B: hooks ───────────────────────────────────────────────────────────

async function hookPlan(conn) {
  const { credentialCrypto, sar } = deps();
  const [rows] = await conn.query("SELECT id, slug, auth_type, auth_config FROM hooks WHERE auth_type IN ('api_key','hmac') ORDER BY id");
  const plain = [];
  for (const r of rows) {
    const cfg = parse(r.auth_config);
    if (!cfg || typeof cfg !== 'object') continue;
    for (const f of sar.fieldsFor(sar.HOOK_SECRET_FIELDS, r.auth_type)) {
      const v = cfg[f];
      if (typeof v === 'string' && v.length && !credentialCrypto.isEncrypted(v)) plain.push({ row: r, cfg, field: f });
    }
  }
  return plain;
}

/** A request the REAL authenticateRequest must accept for this hook + plaintext secret. */
function verifyRequest(authType, cfg, plaintext) {
  if (authType === 'api_key') {
    return { headers: { [(cfg.header || 'x-hook-key').toLowerCase()]: plaintext } };
  }
  const body = Buffer.from('{"b4":"verify"}');
  const algo = cfg.algorithm || 'sha256';
  const header = (cfg.header || 'x-signature').toLowerCase();
  if (cfg.scheme === 'timestamped') {
    const t = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac(algo, plaintext).update(t + '.').update(body).digest('hex');
    return { headers: { [header]: `t=${t},v1=${sig}`, 'content-type': 'application/json' }, rawBodyBuf: body };
  }
  return { headers: { [header]: crypto.createHmac(algo, plaintext).update(body).digest('hex'), 'content-type': 'application/json' }, rawBodyBuf: body };
}

async function stageHooks(conn, apply) {
  const { credentialCrypto, sar } = deps();
  const { authenticateRequest } = require('../services/hookService');
  const plain = await hookPlan(conn);
  console.log('Stage B — hooks.auth_config');
  const stray = plain.filter(p => !EXPECTED_HOOK_IDS.includes(p.row.id));
  if (stray.length) {
    console.log(`  plaintext secret on unexpected hook(s): ${stray.map(p => `${p.row.id} ${p.row.slug}`).join(', ')} — expected only ${EXPECTED_HOOK_IDS.join(', ')}.`);
    console.log('  NO-GO (B) — re-verify by hand. Nothing was changed.');
    return { ok: false };
  }
  if (!plain.length) {
    console.log('  every hook secret is already encrypted ✓');
    console.log('  GO (B) — nothing to do.');
    return { ok: true, done: true };
  }
  for (const p of plain) console.log(`  hook ${p.row.id} (${p.row.slug}, ${p.row.auth_type}): ${p.field} is plaintext → encrypt`);
  if (!apply) { console.log('  GO (B) — base state matches.'); return { ok: true }; }

  for (const p of plain) {
    const enc = sar.encryptFields(p.cfg, [p.field]);
    const [res] = await conn.query(
      'UPDATE hooks SET auth_config = ? WHERE id = ? AND JSON_UNQUOTE(JSON_EXTRACT(auth_config, ?)) = ?',
      [JSON.stringify(enc), p.row.id, `$.${p.field}`, p.cfg[p.field]]
    );
    if (res.affectedRows !== 1) {
      console.log(`  hook ${p.row.id}: row changed underneath (affected ${res.affectedRows}) — left for the re-run.`);
      console.log('  NO-GO (B) — re-run CHECK.');
      return { ok: false };
    }
    const [[after]] = await conn.query('SELECT id, slug, auth_type, auth_config FROM hooks WHERE id = ?', [p.row.id]);
    const stored = parse(after.auth_config);
    const readBack = sar.readSecret(stored[p.field]);
    const others = othersIntact(stored, p.cfg, p.field);
    const verdict = authenticateRequest(after, verifyRequest(after.auth_type, stored, p.cfg[p.field]));
    if (!credentialCrypto.isEncrypted(stored[p.field]) || readBack !== p.cfg[p.field] || !others || !verdict.valid) {
      console.log(`  hook ${p.row.id}: verify FAILED (encrypted=${credentialCrypto.isEncrypted(stored[p.field])}, round-trip=${readBack === p.cfg[p.field]}, other keys intact=${others}, authenticateRequest=${JSON.stringify(verdict)}).`);
      console.log('  NO-GO (B) — verify by hand.');
      return { ok: false };
    }
    console.log(`  ✓ hook ${p.row.id}: ${p.field} encrypted; round-trip ok; other keys intact; authenticateRequest accepts a real ${after.auth_type === 'hmac' ? 'signature' : 'key'}`);
  }
  console.log('  GO (B) — applied and verified.');
  return { ok: true };
}

async function run(conn, { apply }) {
  console.log(`accessB4SecretsAtRest — ${apply ? 'APPLY' : 'CHECK'} — ${new Date().toISOString()}`);
  console.log('Reminder: the B4 CODE must already be deployed (dual-read) before --apply.\n');
  const key = await keyMatchesProduction(conn);
  if (!key.ok) {
    console.log(`CREDENTIALS_ENCRYPTION_KEY check: ${key.why}.`);
    console.log('\nNO-GO — this machine\'s key is not the one the app uses; encrypting with it would break every secret. Nothing was changed.');
    return { ok: false };
  }
  console.log(`CREDENTIALS_ENCRYPTION_KEY matches the app's (decrypts credential ${key.id}'s client_secret) ✓\n`);

  // Preflight BOTH stages' base asserts before writing anything: an
  // unexpected state in stage B must not leave stage A half-applied.
  let a = await stageCredentials(conn, false);
  console.log('');
  let b = await stageHooks(conn, false);
  console.log('');
  if (apply && a.ok && b.ok) {
    console.log('— applying —\n');
    a = await stageCredentials(conn, true);
    console.log('');
    b = a.ok ? await stageHooks(conn, true) : { ok: false };
    console.log('');
  }
  if (!a.ok || !b.ok) {
    console.log(`NO-GO — stage ${!a.ok ? 'A' : ''}${!a.ok && !b.ok ? ' and ' : ''}${!b.ok ? 'B' : ''} stopped; see above.`);
    return { ok: false };
  }
  if (a.done && b.done) {
    console.log('GO — both stages already applied; nothing to do. B4 data migration complete.');
  } else if (!apply) {
    console.log('GO — base state matches. Next (B4 code deployed?): node scripts/accessB4SecretsAtRest.js --apply');
  } else {
    console.log('GO — applied and verified. B4 data migration complete.');
  }
  return { ok: true };
}

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
      for (const k of ['host', 'user', 'password', 'database', 'CREDENTIALS_ENCRYPTION_KEY']) {
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
    }
  })();
}

module.exports = { run, EXPECTED_CREDENTIAL_IDS, EXPECTED_HOOK_IDS, verifyRequest, sampleUrl, keyMatchesProduction };
