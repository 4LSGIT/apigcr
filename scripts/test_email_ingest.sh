#!/usr/bin/env node
//
// scripts/test_email_ingest.sh — actually a Node.js script. Named .sh
// for discoverability; run with `node scripts/test_email_ingest.sh` or
// chmod +x and rely on the shebang.
//
// Exercises the 5 test cases from the worker prompt against a running
// instance. Uses the readonly SQL endpoint for DB verification.
//
// Usage:
//   node scripts/test_email_ingest.sh \
//     --base-url http://localhost:8080 \
//     --ingest-key <openssl rand -hex 24> \
//     --ro-key ycro_...
//
// Defaults:
//   --base-url       http://localhost:8080
//   --ro-base-url    https://app.4lsg.com   (readonly SQL endpoint
//                                            runs on production)
//
// Required:
//   --ingest-key     the api_key seeded for source='siteground-php'
//   --ro-key         a current ycro_... readonly key
//
// Exit code: 0 if all PASS, 1 if any FAIL.

const args = parseArgs(process.argv.slice(2));
const BASE_URL    = args['base-url']    || 'http://localhost:8080';
const RO_BASE_URL = args['ro-base-url'] || 'https://app.4lsg.com';
const INGEST_KEY  = args['ingest-key']  || process.env.EMAIL_INGEST_KEY;
const RO_KEY      = args['ro-key']      || process.env.READONLY_API_KEY;

if (!INGEST_KEY) {
  console.error('--ingest-key (or EMAIL_INGEST_KEY env) is required');
  process.exit(2);
}
if (!RO_KEY) {
  console.error('--ro-key (or READONLY_API_KEY env) is required');
  process.exit(2);
}

// EMAIL_DOMAINS the server is configured for. Default mirrors the
// emailIngestService default. Override with --firm-domains a,b,c when
// the deployed env differs.
const FIRM_DOMAINS = (args['firm-domains'] || '4lsg.com,legalsolutions.group,metrodetroitbankruptcylaw.com,metrodetroitlitigation.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const FIRM_DOMAIN = FIRM_DOMAINS[0];

// ─────────────────────────────────────────────────────────────
// Pretty-printer + result tracking.
// ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function pass(name, detail = '') {
  passed++;
  console.log(`\x1b[32mPASS\x1b[0m  ${name}` + (detail ? ` — ${detail}` : ''));
}
function fail(name, detail = '') {
  failed++;
  failures.push({ name, detail });
  console.log(`\x1b[31mFAIL\x1b[0m  ${name}` + (detail ? ` — ${detail}` : ''));
}

// ─────────────────────────────────────────────────────────────
// HTTP + DB helpers.
// ─────────────────────────────────────────────────────────────

async function postIngest(body, opts = {}) {
  const res = await fetch(`${BASE_URL}/api/email/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Email-Ingest-Key': opts.apiKey || INGEST_KEY,
    },
    body: JSON.stringify(body),
  });
  let parsed;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}

async function sql(query, params = []) {
  const res = await fetch(`${RO_BASE_URL}/api/readonly/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Readonly-Api-Key': RO_KEY,
    },
    body: JSON.stringify({ sql: query, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`SQL error: ${j.error}`);
  return j.rows || [];
}

// ─────────────────────────────────────────────────────────────
// Envelope builder.
// ─────────────────────────────────────────────────────────────

function buildEnvelope({ fromEmail, toEmails = [], ccEmails = [], subject = 'Test', messageId, text = 'body' }) {
  const msgId = messageId || `<${Date.now()}.${Math.random().toString(36).slice(2)}@test.yisracase>`;
  return {
    schema_version:  '1',
    received_at:     new Date().toISOString(),
    source:          'siteground-php',
    adapter_version: 'test-1.0',
    kind:            'email',
    envelope: {
      sender:    fromEmail,
      recipient: toEmails[0] || '',
      domain:    (toEmails[0] || '').split('@')[1] || '',
      exim_message_id: msgId.replace(/^<|>$/g, ''),
    },
    from:     { name: '', email: fromEmail },
    to:       toEmails.map(e => ({ name: '', email: e })),
    cc:       ccEmails.map(e => ({ name: '', email: e })),
    reply_to: [],
    subject,
    date:     new Date().toUTCString(),
    text,
    html:     `<p>${text}</p>`,
    attachments: [],
    auth:    { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    headers: {
      message_id:   msgId,
      in_reply_to:  null,
      references:   null,
      content_type: 'text/plain',
    },
    raw: { headers_block: '', body_block: '' },
    _parse_warnings: [],
  };
}


// ─────────────────────────────────────────────────────────────
// Cases.
// ─────────────────────────────────────────────────────────────

async function case1_loggedNovel() {
  const name = '[1] Novel inbound → status=logged, log + email_log + execution rows';
  const msgId = `<case1.${Date.now()}@test.yisracase>`;
  const env = buildEnvelope({
    fromEmail: 'external-sender@example.com',
    toEmails:  [`stuart@${FIRM_DOMAIN}`],
    subject:   'Test case 1',
    messageId: msgId,
    text:      'Hello, this is case 1.',
  });

  const r = await postIngest(env);
  if (r.status !== 200) return fail(name, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.status !== 'logged') return fail(name, `status=${r.body?.status} body=${JSON.stringify(r.body)}`);
  if (!r.body.execution_id || !r.body.log_id || !r.body.email_log_id)
    return fail(name, `missing ids: ${JSON.stringify(r.body)}`);

  // Verify in DB
  const stripped = msgId.replace(/^<|>$/g, '');
  const ex = await sql(
    `SELECT id, status, source_id, log_id, email_log_id, message_id
       FROM email_ingest_executions WHERE id = ?`, [r.body.execution_id]
  );
  if (!ex.length || ex[0].status !== 'logged') return fail(name, `execution row missing or wrong status: ${JSON.stringify(ex)}`);
  if (String(ex[0].message_id) !== stripped) return fail(name, `execution.message_id=${ex[0].message_id} expected=${stripped}`);

  const lg = await sql(
    `SELECT log_id, log_direction, log_link_type, log_link_id, log_subject
       FROM log WHERE log_id = ?`, [r.body.log_id]
  );
  if (!lg.length) return fail(name, `log row ${r.body.log_id} not found`);
  if (lg[0].log_direction !== 'incoming') return fail(name, `direction=${lg[0].log_direction} expected incoming`);
  if (lg[0].log_link_type !== 'email') return fail(name, `link_type=${lg[0].log_link_type} expected email`);
  if (lg[0].log_link_id !== 'external-sender@example.com') return fail(name, `link_id=${lg[0].log_link_id}`);

  const el = await sql(
    `SELECT id, source, message_id FROM email_log WHERE id = ?`, [r.body.email_log_id]
  );
  if (!el.length) return fail(name, `email_log row ${r.body.email_log_id} not found`);
  if (el[0].source !== 'siteground-php') return fail(name, `email_log.source=${el[0].source}`);
  if (String(el[0].message_id) !== stripped) return fail(name, `email_log.message_id=${el[0].message_id}`);

  pass(name, `execId=${r.body.execution_id} logId=${r.body.log_id} elId=${r.body.email_log_id}`);
  return { msgId, executionId: r.body.execution_id, logId: r.body.log_id, emailLogId: r.body.email_log_id };
}

async function case2_duplicate(case1Result) {
  const name = '[2] Same envelope re-POSTed → status=duplicate, no new log row';
  if (!case1Result) return fail(name, 'case1 prerequisite did not pass');

  const env = buildEnvelope({
    fromEmail: 'external-sender@example.com',
    toEmails:  [`stuart@${FIRM_DOMAIN}`],
    subject:   'Test case 1',
    messageId: case1Result.msgId,
    text:      'Hello, this is case 1.',
  });

  const r = await postIngest(env);
  if (r.status !== 200) return fail(name, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.status !== 'duplicate') return fail(name, `status=${r.body?.status}`);
  if (r.body.email_log_id !== case1Result.emailLogId)
    return fail(name, `email_log_id=${r.body.email_log_id} expected=${case1Result.emailLogId}`);
  if (r.body.log_id) return fail(name, `unexpected log_id on duplicate: ${r.body.log_id}`);

  // Verify no second log row was created against this email
  const lg = await sql(
    `SELECT COUNT(*) AS n FROM log WHERE log_link_type='email' AND log_subject=?`,
    ['Test case 1']
  );
  if (Number(lg[0].n) !== 1) return fail(name, `expected exactly 1 log row, found ${lg[0].n}`);

  pass(name, `dup execId=${r.body.execution_id}`);
}

async function case3_firmToFirm() {
  const name = '[3] All addresses in firm domains → status=skipped_firm_to_firm, email_log yes, log no';
  const msgId = `<case3.${Date.now()}@test.yisracase>`;
  const env = buildEnvelope({
    fromEmail: `ss@${FIRM_DOMAIN}`,
    toEmails:  [`stuart@${FIRM_DOMAIN}`],
    ccEmails:  [`sb@${FIRM_DOMAIN}`],
    subject:   'Internal coordination',
    messageId: msgId,
    text:      'internal',
  });

  const r = await postIngest(env);
  if (r.status !== 200) return fail(name, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.status !== 'skipped_firm_to_firm') return fail(name, `status=${r.body?.status}`);
  if (!r.body.email_log_id) return fail(name, 'no email_log_id on skipped');
  if (r.body.log_id) return fail(name, `unexpected log_id on skipped: ${r.body.log_id}`);

  // Verify no log row exists for this message
  const stripped = msgId.replace(/^<|>$/g, '');
  const ex = await sql(
    `SELECT log_id FROM email_ingest_executions WHERE message_id = ? AND status='skipped_firm_to_firm'`,
    [stripped]
  );
  if (!ex.length || ex[0].log_id != null)
    return fail(name, `execution.log_id should be NULL: ${JSON.stringify(ex)}`);

  const el = await sql(`SELECT id, source FROM email_log WHERE id = ?`, [r.body.email_log_id]);
  if (!el.length || el[0].source !== 'siteground-php')
    return fail(name, `email_log row missing or wrong source: ${JSON.stringify(el)}`);

  pass(name, `execId=${r.body.execution_id} elId=${r.body.email_log_id}`);
}

async function case4_outgoing() {
  const name = '[4] from firm domain, to external → status=logged, direction=outgoing, link_id=to[0]';
  const msgId = `<case4.${Date.now()}@test.yisracase>`;
  const env = buildEnvelope({
    fromEmail: `ss@${FIRM_DOMAIN}`,
    toEmails:  ['client@external-client.com'],
    subject:   'Re: your matter',
    messageId: msgId,
    text:      'reply',
  });

  const r = await postIngest(env);
  if (r.status !== 200) return fail(name, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.status !== 'logged') return fail(name, `status=${r.body?.status}`);

  const lg = await sql(
    `SELECT log_direction, log_link_type, log_link_id FROM log WHERE log_id = ?`,
    [r.body.log_id]
  );
  if (!lg.length) return fail(name, `log ${r.body.log_id} not found`);
  if (lg[0].log_direction !== 'outgoing') return fail(name, `direction=${lg[0].log_direction}`);
  if (lg[0].log_link_id !== 'client@external-client.com')
    return fail(name, `link_id=${lg[0].log_link_id}`);

  pass(name, `outgoing logId=${r.body.log_id}`);
}

async function case5_authFailed() {
  const name = '[5] Bad X-Email-Ingest-Key → 401, execution row status=auth_failed';
  const env = buildEnvelope({
    fromEmail: 'whoever@example.com',
    toEmails:  [`stuart@${FIRM_DOMAIN}`],
    subject:   'should be rejected',
  });

  const r = await postIngest(env, { apiKey: 'this-is-not-a-valid-key' });
  if (r.status !== 401) return fail(name, `HTTP ${r.status} expected 401: ${JSON.stringify(r.body)}`);

  // Find a recent auth_failed row to confirm it was written
  const rows = await sql(
    `SELECT id, status, error, source_id, remote_ip
       FROM email_ingest_executions
      WHERE status='auth_failed'
      ORDER BY id DESC LIMIT 1`
  );
  if (!rows.length) return fail(name, 'no auth_failed execution row found');
  if (rows[0].source_id !== null) return fail(name, `source_id should be NULL on auth_failed: ${JSON.stringify(rows[0])}`);

  pass(name, `auth_failed execId=${rows[0].id}`);
}


// ─────────────────────────────────────────────────────────────
// Runner.
// ─────────────────────────────────────────────────────────────

(async () => {
  console.log(`Email Ingest self-test`);
  console.log(`  BASE_URL    = ${BASE_URL}`);
  console.log(`  RO_BASE_URL = ${RO_BASE_URL}`);
  console.log(`  FIRM_DOMAINS = ${FIRM_DOMAINS.join(', ')}\n`);

  let c1;
  try { c1 = await case1_loggedNovel(); }    catch (e) { fail('[1]', e.message); }
  try { await case2_duplicate(c1); }         catch (e) { fail('[2]', e.message); }
  try { await case3_firmToFirm(); }          catch (e) { fail('[3]', e.message); }
  try { await case4_outgoing(); }            catch (e) { fail('[4]', e.message); }
  try { await case5_authFailed(); }          catch (e) { fail('[5]', e.message); }

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('runner crashed:', err);
  process.exit(2);
});


// ─────────────────────────────────────────────────────────────
// Minimal arg parser. Supports --key value and --key=value.
// ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}