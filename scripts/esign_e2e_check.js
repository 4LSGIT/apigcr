#!/usr/bin/env node
// scripts/esign_e2e_check.js
//
// E-Sign Phase 1C — LIVE end-to-end checkpoint.
//
// 1B's smoke script proved the OUTBOUND contract: we can build an envelope
// Zoho accepts. This one proves the INBOUND half, which is the part that was
// written against a payload shape nobody has ever seen — Zoho publishes no
// webhook reference for Zoho Sign. Everything in services/esignWebhookService
// downstream of parsing is defensive guesswork until a real delivery lands.
//
// So the most valuable thing this script does is not the PASS/FAIL list. It is
// step D printing the VERBATIM payloads Zoho actually sent, captured in
// signing_request_events.payload. That output turns the parser from a hedge
// into a contract.
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//   node scripts/esign_e2e_check.js --config
//       Print the webhook URL to paste into Zoho, including the live token.
//       Read-only. Run this FIRST.
//
//   node scripts/esign_e2e_check.js --send <case_id> <your-email>
//       Create a real signing_requests row against a real case, send a
//       one-page test document, and mark it sent. Prints the request id.
//
//   node scripts/esign_e2e_check.js --verify <request_id> [--raw]
//       After you have signed the email: check everything the webhook should
//       have done. Prints captured payloads. --raw dumps them unabridged.
//
//   Flags: --live   send for real (COSTS 5 CREDITS). Default is test mode.
//          --raw    full payloads in --verify.
//
// ─── WHY --send USES A REAL CASE ─────────────────────────────────────────────
// The filing path resolves cases.case_dropbox and files into that folder. A
// fake case id would exercise the skip branch, which is not the branch that
// needs proving. Pick a real case you do not mind a test PDF appearing in —
// it lands in "<case folder>/Signed Documents/".
//
// 69 of 1066 live cases have no case_dropbox. If you want to check the SKIP
// path instead, pass one of those: expect status signed, no PDF path, and a
// "File signed doc manually" task.

const ARGV = process.argv.slice(2);
const MODE =
  ARGV.includes('--config') ? 'config' :
  ARGV.includes('--send')   ? 'send'   :
  ARGV.includes('--verify') ? 'verify' : null;
const LIVE = ARGV.includes('--live');
const RAW  = ARGV.includes('--raw');
const POSITIONAL = ARGV.filter((a) => !a.startsWith('--'));

if (!MODE) {
  console.error(`usage:
  node scripts/esign_e2e_check.js --config
  node scripts/esign_e2e_check.js --send <case_id> <your-email> [--live]
  node scripts/esign_e2e_check.js --verify <request_id> [--raw]`);
  process.exit(1);
}

require('dotenv').config();

const db = require('../startup/db');
const esignService = require('../services/esignService');
const dropboxService = require('../services/dropboxService');
const { getProvider } = require('../services/esign');
const { WEBHOOK_PATH } = require('../routes/api.esign');

const APP_URL = process.env.APP_URL || 'https://app.4lsg.com';

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  const mark = ok === true ? 'PASS' : ok === null ? 'WARN' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? `\n         ${detail}` : ''}`);
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

// ─────────────────────────────────────────────────────────────────────────────
// A minimal one-page PDF, assembled here so the script carries no fixture.
// Deliberately plain: 1B already settled coordinate placement, so this run is
// about the inbound pipeline, not calibration.
// ─────────────────────────────────────────────────────────────────────────────

function buildTestPdf() {
  const lines = [
    'BT /F1 16 Tf 72 720 Td (YisraCase e-sign PIPELINE CHECK - PLEASE IGNORE) Tj ET',
    'BT /F1 10 Tf 72 696 Td (This document exists to prove the webhook, filing and logging path.) Tj ET',
    'BT /F1 10 Tf 72 680 Td (Sign it, then run: node scripts/esign_e2e_check.js --verify <id>) Tj ET',
    '0.85 0.10 0.10 RG 1.4 w 72 144 216 36 re S',
    'BT /F1 8 Tf 72 186 Td (SIGNATURE) Tj ET',
    '0.85 0.10 0.10 RG 1.4 w 360 144 144 24 re S',
    'BT /F1 8 Tf 360 174 Td (DATE - should auto-stamp today, NOT be an empty picker) Tj ET',
  ].join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(lines)} >>\nstream\n${lines}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Matches the red boxes drawn above. Neutral space: origin bottom-left. */
const PLACEMENTS = {
  coord_space: 'pdf_user_space',
  fields: [
    { page: 1, x: 72,  y: 144, w: 216, h: 36, type: 'signature', signer: 1 },
    { page: 1, x: 360, y: 144, w: 144, h: 24, type: 'date',      signer: 1 },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// --config
// ─────────────────────────────────────────────────────────────────────────────

async function runConfig() {
  section('WEBHOOK CONFIGURATION');

  const [[row]] = await db.query(
    "SELECT `value` FROM app_settings WHERE `key` = 'esign_webhook_token' LIMIT 1"
  );
  const token = row && row.value ? String(row.value).trim() : null;

  if (!token) {
    console.log(`
  esign_webhook_token is NOT SET.

  The endpoint fails CLOSED, so every delivery from Zoho is 401 until this
  exists. Apply ref/2026-07-19_esign_phase1c.sql, which generates one with
  RANDOM_BYTES(32), then re-run this command.
`);
    return 1;
  }

  console.log(`
  Paste this into  Zoho Sign → Settings → Integrations → Webhooks:

    ${APP_URL}${WEBHOOK_PATH}?token=${token}

    Method:        POST
    Content-Type:  whatever Zoho offers — the receiver handles JSON,
                   form-urlencoded, and raw text.
    Events:        subscribe to EVERYTHING available.

  Subscribe broadly on purpose. Zoho does not document this payload, so the
  point of the first run is to SEE what arrives; a narrow subscription would
  hide the very events we are trying to learn. Anything unrecognized becomes
  an audit row with the body stored verbatim, never an error.

  Sanity check — this must return 401, because the token is wrong:

    curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\
      '${APP_URL}${WEBHOOK_PATH}?token=WRONG' \\
      -H 'Content-Type: application/json' -d '{}'

  And this must return 200 with {"status":"received"} — a valid token with a
  body that cannot be parsed is captured and warned about, never a 500,
  because a 5xx would start a Zoho retry storm:

    curl -s -X POST '${APP_URL}${WEBHOOK_PATH}?token=${token}' \\
      -H 'Content-Type: application/json' -d '{"ping":true}'
`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// --send
// ─────────────────────────────────────────────────────────────────────────────

async function runSend() {
  const caseId = POSITIONAL[0];
  const email  = POSITIONAL[1];

  if (!caseId || !email || !email.includes('@')) {
    console.error('usage: node scripts/esign_e2e_check.js --send <case_id> <your-email> [--live]');
    return 1;
  }

  section('PRE-FLIGHT');

  const [[caseRow]] = await db.query(
    'SELECT case_id, case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [caseId]
  );
  if (!caseRow) {
    check(`case ${caseId} exists`, false, 'No such case. Pass a real case_id.');
    return 1;
  }
  check(`case ${caseId} exists`, true);
  check('case has a Dropbox folder',
    Boolean(caseRow.case_dropbox), 
    caseRow.case_dropbox
      ? String(caseRow.case_dropbox).slice(0, 90)
      : 'EMPTY — filing will SKIP and raise a manual-filing task. That is a valid path to test, just not the main one.');

  const [[tok]] = await db.query(
    "SELECT `value` FROM app_settings WHERE `key` = 'esign_webhook_token' LIMIT 1"
  );
  check('esign_webhook_token is set',
    Boolean(tok && String(tok.value || '').trim()),
    tok && tok.value ? '' : 'Apply the 1C SQL first, or nothing will come back.');

  const [[tm]] = await db.query(
    "SELECT `value` FROM app_settings WHERE `key` = 'esign_test_mode' LIMIT 1"
  );
  const testMode = !LIVE;
  console.log(`\n  Sending in ${testMode ? 'TEST MODE (free, watermarked)' : 'LIVE MODE — 5 CREDITS'}.`);
  console.log(`  app_settings esign_test_mode = ${tm ? tm.value : '(unset)'} (the provider reads this; --live overrides).`);

  section('CREATE + SEND');

  // Reuse an unsent draft from a previous failed attempt rather than leaving a
  // trail of orphans. markSent only accepts draft → sent, so a draft is
  // exactly as usable as a fresh row.
  const [[existing]] = await db.query(
    `SELECT id FROM signing_requests
      WHERE linkable_type = 'case' AND linkable_id = ?
        AND kind = 'pipeline_check' AND status = 'draft'
      ORDER BY id DESC LIMIT 1`, [String(caseId)]
  );

  let request;
  if (existing) {
    request = await esignService.getById(db, existing.id);
    check(`reusing draft from a previous attempt (id ${request.id})`, true, `tracking_id ${request.tracking_id}`);
  } else {
    request = await esignService.createRequest(db, {
      linkableType: 'case',
      linkableId:   caseId,
      kind:         'pipeline_check',
      documentName: 'Phase 1C pipeline check',
      recipients:   [{ name: 'Checkpoint Signer', email, order: 1 }],
      placementJson: PLACEMENTS,
      createdBy:    1,
    });
    check(`signing_requests row created (id ${request.id})`, true, `tracking_id ${request.tracking_id}`);
  }

  const provider = await getProvider(db);
  let sent;
  try {
    sent = await provider.sendForSignature({
      // The provider's contract is `pdfBuffer`, and it derives the uploaded
      // filename as `${documentName}.pdf` — there is no fileName parameter.
      pdfBuffer:    buildTestPdf(),
      documentName: 'Phase 1C pipeline check',
      recipients:   [{ name: 'Checkpoint Signer', email, order: 1 }],
      placements:   PLACEMENTS,
      testing:      testMode,
    });
  } catch (err) {
    check('Zoho accepted the envelope', false, err.message);
    console.log(`
  Request ${request.id} is still a DRAFT — nothing was sent, no credits spent.
  Fix the cause and re-run the same command; this script reuses the draft
  rather than piling up a new row per attempt.
`);
    return 1;
  }
  check('Zoho accepted the envelope', true, `provider_id ${sent.providerId}`);

  await esignService.markSent(db, request.id, { providerId: sent.providerId });
  check('row marked sent', true);

  section('NEXT');
  console.log(`
  1. Open the email at ${email} and SIGN it.

  2. While signing, note for the report:
       • Does the DATE field auto-stamp today's date, or is it an empty
         picker you have to fill in? This is the one open question from
         Task 0b — the code sends field_type_name 'Date' (auto-stamp)
         rather than 'CustomDate' (picker), and this is where that is settled.
       • Is the page watermarked? ${testMode
           ? 'It SHOULD be — that proves test mode, and that this cost 0 credits.'
           : 'It should NOT be — you passed --live.'}

  3. Then run:

       node scripts/esign_e2e_check.js --verify ${request.id}

     Give it a minute after signing. If Zoho's webhook never fires, the row
     stays 'sent' and the nightly reconciliation job would eventually catch
     it — --verify will tell you which of those happened.
`);
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// --verify
// ─────────────────────────────────────────────────────────────────────────────

async function runVerify() {
  const id = parseInt(POSITIONAL[0], 10);
  if (!Number.isInteger(id)) {
    console.error('usage: node scripts/esign_e2e_check.js --verify <request_id> [--raw]');
    return 1;
  }

  const request = await esignService.getById(db, id);
  if (!request) {
    console.error(`No signing_requests row with id ${id}.`);
    return 1;
  }

  // ── the row ───────────────────────────────────────────────────────────────
  section('ROW STATE');
  console.log(`  ${request.tracking_id}  ${request.linkable_type} ${request.linkable_id}  provider_id ${request.provider_id}`);

  check("status is 'signed'", request.status === 'signed',
    request.status === 'signed'
      ? ''
      : `status is '${request.status}'. If it is 'sent', the webhook never arrived — ` +
        `check the Zoho webhook config and the Cloud Run logs for '[ESIGN WEBHOOK]'. ` +
        `Run the reconciliation job to confirm the fallback works: ` +
        `it should move this row on its own.`);

  check('completed_at is stamped', Boolean(request.completed_at),
    request.completed_at ? new Date(request.completed_at).toISOString() : 'NULL');

  check('recipients carry a per-signer status',
    Array.isArray(request.recipients) && request.recipients.some((r) => r.status),
    JSON.stringify(request.recipients));

  // ── filing ────────────────────────────────────────────────────────────────
  section('DROPBOX FILING');

  const [[caseRow]] = request.linkable_type === 'case'
    ? await db.query('SELECT case_dropbox FROM cases WHERE case_id = ? LIMIT 1', [request.linkable_id])
    : [[null]];
  const expectFiling = Boolean(caseRow && caseRow.case_dropbox);

  if (!expectFiling) {
    check('filing correctly SKIPPED (no case folder)', !request.signed_pdf_path,
      'This case has no case_dropbox, so the skip path is what should have run. ' +
      'Confirm a "File signed doc manually" task exists.');
  } else {
    check('signed_pdf_path recorded', Boolean(request.signed_pdf_path), request.signed_pdf_path || 'NULL');
    check('cert_pdf_path recorded', request.cert_pdf_path ? true : null,
      request.cert_pdf_path || 'NULL — non-fatal by design; the certificate is corroborating, not operative.');

    if (request.signed_pdf_path) {
      const folder = request.signed_pdf_path.replace(/\/[^/]+$/, '');
      try {
        const credentialId = await dropboxService._resolveCredential(db, {});
        const listing = await dropboxService.listFolder(db, { credentialId, path: folder });
        const names = (listing.entries || listing || []).map((e) => e.name || e);
        const wanted = request.signed_pdf_path.split('/').pop();
        check('the signed PDF is actually in Dropbox', names.includes(wanted),
          names.length ? `folder holds: ${names.join(', ')}` : 'folder is empty');
      } catch (err) {
        check('the signed PDF is actually in Dropbox', null, `could not list ${folder}: ${err.message}`);
      }
    }
  }

  // ── audit trail ───────────────────────────────────────────────────────────
  section('AUDIT EVENTS');

  const [events] = await db.query(
    `SELECT id, event, recipient_email, occurred_at, created_at, payload
       FROM signing_request_events WHERE signing_request_id = ? ORDER BY id ASC`, [id]
  );

  for (const e of events) {
    console.log(`  #${e.id.toString().padStart(4)}  ${String(e.event).padEnd(28)} ` +
                `${e.recipient_email || '-'}  occurred=${e.occurred_at ? new Date(e.occurred_at).toISOString() : 'NULL'}`);
  }

  const names = events.map((e) => e.event);
  check("a 'created' event exists", names.includes('created'));
  check("a 'sent' event exists",    names.includes('sent'));
  check("a 'signed' event exists",  names.includes('signed'),
    names.includes('signed') ? '' : 'The status change never happened — see ROW STATE above.');
  if (expectFiling) {
    check("a 'filed' event exists", names.includes('filed'),
      names.includes('filed') ? '' : "Look for 'filing_needs_attention' instead — filing failed and raised a task.");
  }
  check('no duplicate status events',
    new Set(names).size === names.length || !names.filter((n) => n === 'signed').slice(1).length,
    `events: ${names.join(', ')}`);

  // ── THE POINT OF THIS SCRIPT ──────────────────────────────────────────────
  section('CAPTURED ZOHO PAYLOADS — verbatim');
  console.log(`
  Zoho publishes no webhook payload reference, so services/esignWebhookService
  parses defensively: it hunts for request_id/request_status across several
  shapes and never lets the guessed part drive a state transition. Everything
  below is what actually arrived. Paste it back to the manager session — it is
  what turns the parser from a hedge into a contract.
`);

  const captured = events.filter((e) => e.payload && (e.payload.raw || e.payload.unparsed_body || e.payload.operation_type));
  if (!captured.length) {
    console.log('  (nothing captured — no webhook delivery reached this request)');
  }
  for (const e of captured) {
    const json = JSON.stringify(e.payload, null, 2);
    console.log(`\n  ── event #${e.id} "${e.event}" ${'─'.repeat(30)}`);
    console.log(RAW ? json : json.split('\n').slice(0, 60).join('\n') +
      (json.split('\n').length > 60 ? `\n  … ${json.split('\n').length - 60} more lines (re-run with --raw)` : ''));
  }

  // Distinct operation_type values are the single most useful output here:
  // they are the vocabulary the bounce heuristic and _eventNameFor are guessing at.
  const ops = [...new Set(events.map((e) => e.payload && e.payload.operation_type).filter(Boolean))];
  if (ops.length) {
    console.log(`\n  DISTINCT operation_type VALUES OBSERVED: ${ops.join(', ')}`);
    console.log('  → these are what _eventNameFor and BOUNCE_HINT should be tightened against.');
  }

  // ── log rows ──────────────────────────────────────────────────────────────
  section('CASE LOG ROWS');

  const [logs] = await db.query(
    `SELECT log_id, log_type, log_link_type, log_link_id, log_by, log_direction, log_subject, log_data
       FROM log
      WHERE log_type = 'esign' AND log_link_id = ?
      ORDER BY log_id ASC`, [String(request.linkable_id)]
  );

  for (const l of logs) {
    console.log(`  #${l.log_id}  ${l.log_direction.padEnd(8)} by=${l.log_by}  ${l.log_subject}`);
  }

  check('log rows were written', logs.length > 0,
    logs.length ? '' : 'The log hook did not fire. Confirm routes/api.esign.js is deployed — ' +
                       'requiring it is what installs the hook.');
  check('every row is attributed to the automations user (by=0)',
    logs.every((l) => Number(l.log_by) === 0),
    'Hook-written rows are machine events; human attribution belongs in log_data.');
  check("no 'created' or 'viewed' rows leaked into the log",
    !logs.some((l) => /esign (created|viewed):/i.test(l.log_subject || '')),
    'Those are audit-table-only by design — the allowlist is the filter.');

  const sentLog   = logs.find((l) => /esign sent:/i.test(l.log_subject || ''));
  const signedLog = logs.find((l) => /esign signed:/i.test(l.log_subject || ''));
  if (sentLog)   check("the 'sent' row is outgoing",   sentLog.log_direction === 'outgoing', sentLog.log_direction);
  if (signedLog) check("the 'signed' row is incoming", signedLog.log_direction === 'incoming', signedLog.log_direction);

  // ── tasks ─────────────────────────────────────────────────────────────────
  section('TASKS RAISED');
  const [tasks] = await db.query(
    `SELECT task_id, task_title, task_to, task_link_type, task_link_id, task_status
       FROM tasks WHERE task_source = 'esign' ORDER BY task_id DESC LIMIT 10`
  );
  if (!tasks.length) {
    console.log(`  (none — correct for a clean run${expectFiling ? '' : ', EXCEPT this case has no Dropbox folder, so one was expected'})`);
    if (!expectFiling) check('a manual-filing task was raised', false, 'Expected one for a case with no Dropbox folder.');
  }
  for (const t of tasks) {
    console.log(`  #${t.task_id}  → user ${t.task_to}  [${t.task_link_type || '-'} ${t.task_link_id || '-'}]  ${t.task_title}`);
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.ok === false).length;
  const warned = results.filter((r) => r.ok === null).length;
  section('SUMMARY');
  console.log(`  ${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failed\n`);

  console.log(`  STILL REQUIRES YOUR EYES:

  [ ] DATE FIELD — did it auto-stamp the signing date, or present an empty
      picker? Task 0b sends field_type_name 'Date'. If it rendered as an
      editable picker, the fallback ladder is documented in the FIELD_TYPES
      header of services/esign/zohoSignProvider.js.

  [ ] WATERMARK — present on the filed PDF? Confirms test mode, and that this
      run cost nothing.

  [ ] THE FILED PDF — open it from Dropbox. Is it the signed version (with the
      signature rendered), not the original?

  [ ] THE CASE LOG in the UI — do the e-sign rows read sensibly next to the
      Adobe-era rows from Phase 0?
`);
  return failed ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  if (MODE === 'config') return runConfig();
  if (MODE === 'send')   return runSend();
  return runVerify();
})()
  .then((code) => { process.exitCode = code || 0; })
  .catch((err) => {
    console.error('\nUNCAUGHT — the script itself broke:');
    console.error(err);
    process.exitCode = 2;
  })
  .finally(async () => {
    // esignService fires the log hook fire-and-forget (_fireLogHook does not
    // return the promise), so there is no handle to await. A short drain lets
    // the in-flight createLogEntry INSERT land before the pool closes —
    // without it, `--send` reliably loses the 'sent' log row to
    // "Can't add new command when connection is in closed state".
    //
    // Cloud Run never hits this: its pool is long-lived and is not closed
    // per request. This is a short-lived-script problem.
    await new Promise((r) => setTimeout(r, 1500));
    try { await db.end(); } catch { /* pool may already be closed */ }
  });