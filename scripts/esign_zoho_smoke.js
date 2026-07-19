#!/usr/bin/env node
// scripts/esign_zoho_smoke.js
//
// E-Sign Phase 1B — LIVE smoke test against Zoho Sign.
//
// The provider layer was built against Zoho's documentation. Documentation is
// a hypothesis. This script is the experiment: it exercises every method of
// the contract against the real API and prints a labelled JSON block per step,
// so the follow-up fix round is mechanical rather than exploratory.
//
// ─── SAFETY ──────────────────────────────────────────────────────────────────
// Runs in TEST MODE unless you pass --live. Test mode envelopes are free,
// permanently watermarked, and capped by Zoho at 50/month. The script recalls
// the envelope it creates in step 7, so nothing lingers in the dashboard.
// It never writes to signing_requests — the provider layer does not touch
// the database, and neither does this.
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//   node scripts/esign_zoho_smoke.js <recipient-email> [--live] [--keep] [--raw]
//
//   <recipient-email>  REQUIRED. Use YOUR OWN address — you must open the
//                      resulting email to judge the field placement.
//   --live             Send for real. COSTS 5 ZOHO CREDITS. Do not use for
//                      the calibration run; the watermark is the proof that
//                      test mode worked.
//   --keep             Skip the recall in step 7, so the envelope stays open
//                      and you can sign it end-to-end. Step 7's verdict is
//                      then reported as SKIPPED.
//   --raw              Dump full Zoho payloads. Verbose; useful when a step
//                      fails and the summary is not enough.
//
// Requires the same env as the app (.env): host / user / password / database,
// plus CREDENTIALS_ENCRYPTION_KEY for token decryption.
//
// ─── WHAT THIS RUN MUST SETTLE ───────────────────────────────────────────────
// Each is printed again in the closing checklist:
//   1. COORDINATE TRANSFORM — does the signature field land inside the red box
//      on the calibration page? (the single highest-risk assumption)
//   2. REMIND ENDPOINT — §12 open item. Does POST /requests/{id}/remind work
//      on this firm's API-only plan, or does it 4xx?
//   3. CREDIT ENDPOINT — does anything on GET /accounts expose a balance?
//      Slice 1C's low-credit alert depends on the answer.
//   4. PAGE LIMIT / PRICING — read off the Zoho dashboard, not the API.
//
// Continues past failures wherever it is safe to do so: a step that cannot
// run without a request_id is skipped, everything else is attempted, and the
// summary at the end lists PASS/FAIL/SKIP per step.

// ─────────────────────────────────────────────────────────────────────────────
// Args — parsed BEFORE the requires. services/oauthService pulls in
// lib/credentialCrypto, which fail-fasts at require() when
// CREDENTIALS_ENCRYPTION_KEY is unset. That is correct in production, but it
// would bury a plain "you forgot the email address" under a crypto stack
// trace. Usage errors are cheap; check them first.
// ─────────────────────────────────────────────────────────────────────────────

const ARGV      = process.argv.slice(2);
const RECIPIENT = ARGV.find((a) => !a.startsWith('--'));
const LIVE      = ARGV.includes('--live');
const KEEP      = ARGV.includes('--keep');
const RAW       = ARGV.includes('--raw');

if (!RECIPIENT || !RECIPIENT.includes('@')) {
  console.error('usage: node scripts/esign_zoho_smoke.js <recipient-email> [--live] [--keep] [--raw]');
  console.error('       <recipient-email> should be YOUR address — you must open the email to judge placement.');
  process.exit(1);
}

require('dotenv').config();

const db = require('../startup/db');
const { getProvider } = require('../services/esign');
const { getSettings } = require('../services/settingsService');
const oauthService = require('../services/oauthService');
const { neutralToZohoFields, DEFAULT_PAGE } = require('../services/esign/zohoSignProvider');

// ─────────────────────────────────────────────────────────────────────────────
// The calibration page (US Letter 612x792, 1-inch grid, two labelled target
// boxes). Generated offline; regenerate with the python script recorded in the
// Phase 1B report if the target rects below ever change.
// ─────────────────────────────────────────────────────────────────────────────

const CALIBRATION_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg' +
  'L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug' +
  'L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAg' +
  'UiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5' +
  'cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMjc0OSA+PgpzdHJlYW0K' +
  'QlQgL0YxIDE1IFRmIDcyIDczOCBUZCAoWWlzcmFDYXNlIGUtc2lnbiBzbW9rZSB0ZXN0IC0gUExFQVNFIElHTk9SRSkg' +
  'VGogRVQKQlQgL0YxIDkgVGYgNzIgNzIwIFRkIChVUyBMZXR0ZXIgNjEyeDc5MnB0LiBHcmlkID0gMSBpbmNoID0gNzJw' +
  'dC4gTGFiZWxzIGFyZSBQREYgdXNlciBzcGFjZTogb3JpZ2luIEJPVFRPTS1MRUZULCB5IGdyb3dzIFVQLikgVGogRVQK' +
  'MC43OCAwLjc4IDAuODIgUkcgMC40IHcKMCAwIG0gMCA3OTIgbCBTCjcyIDAgbSA3MiA3OTIgbCBTCjE0NCAwIG0gMTQ0' +
  'IDc5MiBsIFMKMjE2IDAgbSAyMTYgNzkyIGwgUwoyODggMCBtIDI4OCA3OTIgbCBTCjM2MCAwIG0gMzYwIDc5MiBsIFMK' +
  'NDMyIDAgbSA0MzIgNzkyIGwgUwo1MDQgMCBtIDUwNCA3OTIgbCBTCjU3NiAwIG0gNTc2IDc5MiBsIFMKMCAwIG0gNjEy' +
  'IDAgbCBTCjAgNzIgbSA2MTIgNzIgbCBTCjAgMTQ0IG0gNjEyIDE0NCBsIFMKMCAyMTYgbSA2MTIgMjE2IGwgUwowIDI4' +
  'OCBtIDYxMiAyODggbCBTCjAgMzYwIG0gNjEyIDM2MCBsIFMKMCA0MzIgbSA2MTIgNDMyIGwgUwowIDUwNCBtIDYxMiA1' +
  'MDQgbCBTCjAgNTc2IG0gNjEyIDU3NiBsIFMKMCA2NDggbSA2MTIgNjQ4IGwgUwowIDcyMCBtIDYxMiA3MjAgbCBTCjAg' +
  'NzkyIG0gNjEyIDc5MiBsIFMKMC4zNSAwLjM1IDAuNCBSRyAxLjEgdwowIDAgbSA2MTIgMCBsIFMKMCAwIG0gMCA3OTIg' +
  'bCBTCjAgMCAwIHJnCkJUIC9GMSA3IFRmIDc0IDUgVGQgKHg9NzIpIFRqIEVUCkJUIC9GMSA3IFRmIDE0NiA1IFRkICh4' +
  'PTE0NCkgVGogRVQKQlQgL0YxIDcgVGYgMjE4IDUgVGQgKHg9MjE2KSBUaiBFVApCVCAvRjEgNyBUZiAyOTAgNSBUZCAo' +
  'eD0yODgpIFRqIEVUCkJUIC9GMSA3IFRmIDM2MiA1IFRkICh4PTM2MCkgVGogRVQKQlQgL0YxIDcgVGYgNDM0IDUgVGQg' +
  'KHg9NDMyKSBUaiBFVApCVCAvRjEgNyBUZiA1MDYgNSBUZCAoeD01MDQpIFRqIEVUCkJUIC9GMSA3IFRmIDU3OCA1IFRk' +
  'ICh4PTU3NikgVGogRVQKQlQgL0YxIDcgVGYgMyA3NSBUZCAoeT03MikgVGogRVQKQlQgL0YxIDcgVGYgMyAxNDcgVGQg' +
  'KHk9MTQ0KSBUaiBFVApCVCAvRjEgNyBUZiAzIDIxOSBUZCAoeT0yMTYpIFRqIEVUCkJUIC9GMSA3IFRmIDMgMjkxIFRk' +
  'ICh5PTI4OCkgVGogRVQKQlQgL0YxIDcgVGYgMyAzNjMgVGQgKHk9MzYwKSBUaiBFVApCVCAvRjEgNyBUZiAzIDQzNSBU' +
  'ZCAoeT00MzIpIFRqIEVUCkJUIC9GMSA3IFRmIDMgNTA3IFRkICh5PTUwNCkgVGogRVQKQlQgL0YxIDcgVGYgMyA1Nzkg' +
  'VGQgKHk9NTc2KSBUaiBFVApCVCAvRjEgNyBUZiAzIDY1MSBUZCAoeT02NDgpIFRqIEVUCkJUIC9GMSA3IFRmIDMgNzIz' +
  'IFRkICh5PTcyMCkgVGogRVQKMC44NSAwLjEwIDAuMTAgUkcgMS42IHcKNzIgMTQ0IDIxNiAzNiByZSBTCjAuODUgMC4x' +
  'MCAwLjEwIFJHIDAuOSB3CjYyIDE0NCBtIDgyIDE0NCBsIFMKNzIgMTM0IG0gNzIgMTU0IGwgUwowLjg1IDAuMTAgMC4x' +
  'MCByZwpCVCAvRjEgOCBUZiA3MiAxODUgVGQgKFNJR05BVFVSRSBGSUVMRCBTSE9VTEQgTEFORCBJTiBUSElTIEJPWCkg' +
  'VGogRVQKQlQgL0YxIDcgVGYgNzIgMTMxIFRkIChuZXV0cmFsOiB4PTcyIHk9MTQ0IHc9MjE2IGg9MzYgIFwoeSBtZWFz' +
  'dXJlZCBmcm9tIHBhZ2UgQk9UVE9NXCkpIFRqIEVUCjAgMCAwIHJnCjAuODUgMC4xMCAwLjEwIFJHIDEuNiB3CjM2MCAx' +
  'NDQgMTQ0IDI0IHJlIFMKMC44NSAwLjEwIDAuMTAgUkcgMC45IHcKMzUwIDE0NCBtIDM3MCAxNDQgbCBTCjM2MCAxMzQg' +
  'bSAzNjAgMTU0IGwgUwowLjg1IDAuMTAgMC4xMCByZwpCVCAvRjEgOCBUZiAzNjAgMTczIFRkIChEQVRFIEZJRUxEIFNI' +
  'T1VMRCBMQU5EIElOIFRISVMgQk9YKSBUaiBFVApCVCAvRjEgNyBUZiAzNjAgMTMxIFRkIChuZXV0cmFsOiB4PTM2MCB5' +
  'PTE0NCB3PTE0NCBoPTI0ICBcKHkgbWVhc3VyZWQgZnJvbSBwYWdlIEJPVFRPTVwpKSBUaiBFVAowIDAgMCByZwpCVCAv' +
  'RjEgOCBUZiA3MiAzMDAgVGQgKEhPVyBUTyBSRUFEIFRIRSBSRVNVTFQ6KSBUaiBFVApCVCAvRjEgOCBUZiA3MiAyODgg' +
  'VGQgKCAgZmllbGQgaW5zaWRlIHRoZSByZWQgYm94IC4uLi4uLi4uLi4uLi4uLi4uLiB0cmFuc2Zvcm0gQ09SUkVDVCwg' +
  'c2hpcCBpdCkgVGogRVQKQlQgL0YxIDggVGYgNzIgMjc2IFRkICggIGZpZWxkIG1pcnJvcmVkIGFib3V0IHRoZSBwYWdl' +
  'IG1pZGRsZSAuLi4uLi4geS1mbGlwIGlzIHdyb25nIFwob3JpZ2luIGFzc3VtcHRpb24gMVwpKSBUaiBFVApCVCAvRjEg' +
  'OCBUZiA3MiAyNjQgVGQgKCAgZmllbGQgZXhhY3RseSBvbmUgYm94LWhlaWdodCB0b28gbG93IC4uLi4uLiBkcm9wIHRo' +
  'ZSAiLSBoIiBcKGFzc3VtcHRpb24gMlwpKSBUaiBFVApCVCAvRjEgOCBUZiA3MiAyNTIgVGQgKCAgZmllbGQgb24gdGhl' +
  'IHdyb25nIHBhZ2UgLi4uLi4uLi4uLi4uLi4uLi4uLiBORVVUUkFMX1BBR0VfQkFTRSBpcyB3cm9uZyBcKGFzc3VtcHRp' +
  'b24gNVwpKSBUaiBFVApCVCAvRjEgOCBUZiA3MiAyNDAgVGQgKCAgZmllbGQgdGlueSAvIGh1Z2UsIHJpZ2h0IHBvc2l0' +
  'aW9uIC4uLi4uLi4uLiBwZXJjZW50IHZzIHBvaW50cyBkaXNhZ3JlZSBcKGFzc3VtcHRpb24gNFwpKSBUaiBFVApCVCAv' +
  'RjEgOCBUZiA3MiAyMjggVGQgKCAgZmllbGQgYXQgdGhlIGNvcnJlY3QgeCBidXQgeSBuZWFyIHRoZSB0b3AgLiB5IHNl' +
  'bnQgdW5mbGlwcGVkKSBUaiBFVApCVCAvRjEgOCBUZiA3MiAxMDAgVGQgKEEgd2F0ZXJtYXJrIG9uIHRoaXMgcGFnZSA9' +
  'IHRlc3QgbW9kZSB3YXMgYWN0aXZlID0gbm8gWm9obyBjcmVkaXRzIHdlcmUgc3BlbnQuKSBUaiBFVAplbmRzdHJlYW0K' +
  'ZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAw' +
  'MDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzExIDAwMDAwIG4gCnRy' +
  'YWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMzExMgolJUVPRgo=';

/**
 * The placements the script asks for. These MUST match the red boxes drawn on
 * the calibration page — the whole verdict rests on that correspondence.
 * Neutral space: origin bottom-left, points, (x,y) = box's bottom-left corner.
 */
const PLACEMENTS = {
  coord_space: 'pdf_user_space',
  fields: [
    { page: 1, x: 72,  y: 144, w: 216, h: 36, type: 'signature', signer: 1 },
    { page: 1, x: 360, y: 144, w: 144, h: 24, type: 'date',      signer: 1 },
  ],
};

const DOCUMENT_NAME = 'YisraCase smoke test — ignore';

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────────

const results = [];

function head(n, title) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`STEP ${n} — ${title}`);
  console.log('═'.repeat(78));
}

function show(label, obj) {
  console.log(`${label}:`);
  console.log(JSON.stringify(obj, null, 2));
}

function pass(n, note) { results.push({ step: n, verdict: 'PASS', note }); console.log(`\n  ✓ PASS — ${note}`); }
function fail(n, note) { results.push({ step: n, verdict: 'FAIL', note }); console.log(`\n  ✗ FAIL — ${note}`); }
function skip(n, note) { results.push({ step: n, verdict: 'SKIP', note }); console.log(`\n  – SKIP — ${note}`); }

/** Everything useful off a typed provider error, and nothing sensitive. */
function errShape(err) {
  return {
    message:         err.message,
    code:            err.code            ?? null,
    provider:        err.provider        ?? null,
    httpStatus:      err.httpStatus      ?? null,
    providerCode:    err.providerCode    ?? null,
    providerMessage: err.providerMessage ?? null,
    causeMessage:    err.cause?.message  ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  YisraCase — Zoho Sign provider smoke test (Phase 1B)                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log(`  recipient : ${RECIPIENT}`);
  console.log(`  mode      : ${LIVE ? '*** LIVE — THIS SPENDS 5 ZOHO CREDITS ***' : 'TEST (free, watermarked)'}`);
  console.log(`  recall    : ${KEEP ? 'SKIPPED (--keep)' : 'yes, step 7'}`);
  console.log(`  started   : ${new Date().toISOString()}`);

  if (LIVE) {
    console.log('\n  --live given. Sleeping 5s so you can Ctrl-C if that was a mistake…');
    await new Promise((r) => setTimeout(r, 5000));
  }

  let providerId = null;

  // ── 1 ─ config, credential, token ──────────────────────────────────────────
  head(1, 'Settings → credential → access token');
  let provider;
  try {
    const settings = await getSettings(db, ['esign_credential_id', 'esign_test_mode']);
    show('app_settings', settings);

    if (settings.esign_credential_id == null) {
      fail(1, 'esign_credential_id is not in app_settings — run ref/2026-07-19_esign_phase1b.sql first');
      return finish();
    }

    provider = await getProvider(db);
    console.log(`\n  provider resolved: ${provider.name} (credential ${provider.credentialId})`);

    // Prove the transform BEFORE any network call — this is free and it is the
    // exact payload step 3 will send, so a wrong number is visible here first.
    const { bySigner, count } = neutralToZohoFields(PLACEMENTS, DEFAULT_PAGE);
    console.log(`\n  coordinate transform preview (${count} fields, page ${DEFAULT_PAGE.width}x${DEFAULT_PAGE.height}):`);
    show('  zoho fields for signer 1', bySigner[1]);
    console.log('\n  EXPECTED, if the assumptions hold:');
    console.log('    signature  x_coord 72   y_coord 612  abs 216x36   (792 - 144 - 36 = 612)');
    console.log('    date       x_coord 360  y_coord 624  abs 144x24   (792 - 144 - 24 = 624)');

    const token = await oauthService.getValidAccessToken(db, provider.credentialId);
    console.log(`\n  access token acquired: ${token.length} chars, prefix "${token.slice(0, 6)}…"`);
    console.log('  (length + prefix only — the token itself is never printed or logged)');
    pass(1, 'settings read, provider constructed, token acquired');
  } catch (err) {
    show('error', errShape(err));
    fail(1, `could not get to a usable provider: ${err.message}`);
    return finish();
  }

  // ── 2 ─ credit balance ─────────────────────────────────────────────────────
  head(2, 'getCreditBalance()  —  OPEN QUESTION: does the API expose a balance?');
  try {
    const bal = await provider.getCreditBalance();
    show('result', RAW ? bal : { credits: bal.credits, supported: bal.supported, error: bal.error ?? null });
    if (!RAW && bal.raw) {
      console.log('\n  GET /accounts top-level keys (re-run with --raw for the full body):');
      console.log('   ', Object.keys(bal.raw).join(', '));
      const acct = bal.raw.accounts ?? bal.raw.account ?? null;
      if (acct && typeof acct === 'object') {
        console.log('  accounts keys:', Object.keys(Array.isArray(acct) ? (acct[0] || {}) : acct).join(', '));
      }
    }
    if (bal.supported) {
      pass(2, `balance exposed: ${bal.credits} credits — 1C can build the low-credit alert on the API`);
    } else {
      pass(2, 'NO balance field found — 1C must drive the low-credit alert from a local envelope counter (5 credits each), not the API');
    }
  } catch (err) {
    show('error', errShape(err));
    fail(2, 'getCreditBalance threw — inspect above; a 4xx here still answers the question');
  }

  // ── 3 ─ send ───────────────────────────────────────────────────────────────
  head(3, 'sendForSignature()  —  THE COORDINATE TRANSFORM TEST');
  try {
    const pdfBuffer = Buffer.from(CALIBRATION_PDF_B64, 'base64');
    console.log(`  calibration pdf: ${pdfBuffer.length} bytes, magic "${pdfBuffer.subarray(0, 5)}"`);
    show('placements sent', PLACEMENTS);

    const sent = await provider.sendForSignature({
      pdfBuffer,
      documentName: DOCUMENT_NAME,
      recipients: [{ name: 'Smoke Test', email: RECIPIENT, order: 1 }],
      placements: PLACEMENTS,
      expirationDays: 1,
      pageInfo: DEFAULT_PAGE,
      testing: !LIVE,
    });

    providerId = sent.providerId;
    show('result', {
      providerId: sent.providerId,
      status: sent.status,
      providerStatus: sent.providerStatus,
      testing: sent.testing,
      ...(RAW ? { raw: sent.raw } : {}),
    });
    pass(3, `envelope ${providerId} created and submitted (status ${sent.status})`);
  } catch (err) {
    show('error', errShape(err));
    console.log('\n  IF THIS IS A 4xx ON /submit, the two likeliest causes, in order:');
    console.log('    a) fields must be the CATEGORIZED object form —');
    console.log('       {check_boxes:[], date_fields:[], image_fields:[]} — rather than the');
    console.log('       flat array this build sends. Zoho documents BOTH; the flat array is');
    console.log('       what its own how-to / embedded-signing / self-sign examples use.');
    console.log('    b) fields need an account-specific field_type_id, obtainable from the');
    console.log('       field-types endpoint. Paste the providerMessage above into the report.');
    fail(3, 'send failed — nothing downstream can run');
  }

  // ── 4 ─ status ─────────────────────────────────────────────────────────────
  head(4, 'getStatus()');
  if (!providerId) {
    skip(4, 'no providerId from step 3');
  } else {
    try {
      const st = await provider.getStatus(providerId);
      show('result', {
        status: st.status, providerStatus: st.providerStatus, recipients: st.recipients,
        ...(RAW ? { raw: st.raw } : {}),
      });
      if (st.status === null) {
        fail(4, `request_status "${st.providerStatus}" is NOT in ZOHO_REQUEST_STATUS_MAP — add it`);
      } else {
        pass(4, `mapped "${st.providerStatus}" → "${st.status}"`);
      }
      const unmapped = st.recipients.filter((r) => r.status === null);
      if (unmapped.length) {
        console.log(`  ! ${unmapped.length} recipient(s) had an unmapped action_status — see the warns above`);
      }
    } catch (err) {
      show('error', errShape(err));
      fail(4, 'getStatus threw');
    }
  }

  // ── 5 ─ list ───────────────────────────────────────────────────────────────
  head(5, 'listInProgress()  —  new envelope must appear');
  try {
    const list = await provider.listInProgress();
    console.log(`  ${list.items.length} in-progress envelope(s), ${list.pagesFetched} page(s) fetched, capped=${list.capped}`);
    show('first 5', list.items.slice(0, 5));
    if (!providerId) {
      skip(5, 'no providerId to look for (the call itself succeeded)');
    } else if (list.items.some((i) => i.providerId === String(providerId))) {
      pass(5, `${providerId} found — paging + status filter both work`);
    } else {
      fail(5, `${providerId} NOT in the list. Either search_columns.request_status is being ` +
              'rejected/ignored by Zoho, or start_index is not 1-based as assumed.');
    }
  } catch (err) {
    show('error', errShape(err));
    fail(5, 'listInProgress threw — check the page_context shape');
  }

  // ── 6 ─ remind (§12) ───────────────────────────────────────────────────────
  head(6, 'remind()  —  §12 OPEN ITEM: is this endpoint available on the API-only plan?');
  if (!providerId) {
    skip(6, 'no providerId from step 3');
  } else {
    try {
      const rem = await provider.remind(providerId, RECIPIENT);
      show('result', RAW ? rem : { ok: rem.ok, remindedAll: rem.remindedAll, raw: rem.raw });
      pass(6, '§12 ANSWERED: POST /requests/{id}/remind WORKS on this plan. ' +
              'Note it reminds every pending recipient — there is no per-recipient parameter.');
    } catch (err) {
      show('RAW OUTCOME (this is the §12 answer either way)', errShape(err));
      fail(6, `§12 ANSWERED: remind is NOT usable — HTTP ${err.httpStatus}, Zoho code ${err.providerCode}. ` +
              '1C must fall back to Zoho\'s built-in automatic reminders (email_reminders / reminder_period ' +
              'on the create call) instead of an on-demand nudge.');
    }
  }

  // ── 7 ─ recall ─────────────────────────────────────────────────────────────
  head(7, 'recall() then getStatus()  —  expect recalled');
  if (!providerId) {
    skip(7, 'no providerId from step 3');
  } else if (KEEP) {
    skip(7, `--keep given; envelope ${providerId} LEFT OPEN. Recall it yourself in the Zoho dashboard when done.`);
  } else {
    try {
      const rec = await provider.recall(providerId, 'smoke test');
      show('recall', RAW ? rec : { status: rec.status, reasonSentToProvider: rec.reasonSentToProvider });
      console.log('  (reasonSentToProvider:false is expected — Zoho\'s recall takes no reason parameter)');

      const after = await provider.getStatus(providerId);
      show('status after recall', { status: after.status, providerStatus: after.providerStatus });
      if (after.status === 'recalled') {
        pass(7, 'recalled and confirmed — nothing left open in the Zoho dashboard');
      } else {
        fail(7, `recall returned ok but status is "${after.status}" (zoho "${after.providerStatus}"), not "recalled"`);
      }
    } catch (err) {
      show('error', errShape(err));
      fail(7, `recall failed — envelope ${providerId} MAY STILL BE OPEN. Check the Zoho dashboard.`);
    }
  }

  return finish(providerId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8 — summary + the manual half
// ─────────────────────────────────────────────────────────────────────────────

function finish(providerId) {
  head(8, 'SUMMARY + MANUAL VERIFICATION (only you can do this part)');

  console.log('  Automated results:');
  for (const r of results) {
    const mark = r.verdict === 'PASS' ? '✓' : r.verdict === 'FAIL' ? '✗' : '–';
    console.log(`    ${mark} step ${r.step}  ${r.verdict.padEnd(4)}  ${r.note}`);
  }
  const failed = results.filter((r) => r.verdict === 'FAIL').length;
  console.log(`\n  ${results.length} steps run, ${failed} failed.`);

  console.log(`
  ────────────────────────────────────────────────────────────────────────────
  NOW GO AND LOOK. Four things this script cannot see:
  ────────────────────────────────────────────────────────────────────────────

  [ ] 1. COORDINATE TRANSFORM — the whole point of the run.
         Open the Zoho signing email sent to ${RECIPIENT} and click through to
         the document. (If step 7 recalled it, use the Zoho dashboard's preview
         instead — or re-run with --keep to keep the link live.)

         The page has a 1-inch grid and two RED boxes. Report which is true:

           (a) both fields sit INSIDE their red boxes
                   → transform is CORRECT. Nothing to change.
           (b) fields are mirrored — near the TOP of the page instead of the
               bottom third
                   → the y-flip is inverted. Remove the flip in
                     neutralToZohoFields (assumption 1).
           (c) fields sit exactly one box-height BELOW the boxes
                   → drop the "- h" from yTop (assumption 2).
           (d) right position, wrong SIZE
                   → percent and absolute pairs disagree; send only one
                     (assumption 4).
           (e) fields on a different page / missing
                   → NEUTRAL_PAGE_BASE (assumption 5).

         Note the x position separately from y — x needs no transform, so a
         correct x with a wrong y confirms the flip is the only problem.

  [ ] 2. WATERMARK — is the page watermarked?
         ${LIVE ? 'You ran --live, so there should be NO watermark and 5 credits are gone.'
                : 'YES expected. A watermark proves testing=true reached Zoho and this run cost 0 credits.'}
         If you ran WITHOUT --live and see NO watermark, stop: testing=true is
         not being honoured and every send so far has been billed.

  [ ] 3. DATE FIELD BEHAVIOUR — is it a signer-editable date picker, or an
         auto-stamped signing date? This build sends CustomDate. If you wanted
         the auto-stamped signing date, change FIELD_TYPES.date.field_type_name
         to 'Date' in zohoSignProvider.js — that is the entire fix.

  [ ] 4. FROM THE ZOHO DASHBOARD, not the API (§12):
         [ ] page limit per envelope (matters for long bankruptcy petitions)
         [ ] current credit balance and the price per credit
         [ ] test documents used this month (Zoho caps test mode at 50/month)
         [ ] confirm the plan is API-only vs Enterprise — it changes what
             step 6 above means

  ────────────────────────────────────────────────────────────────────────────
  Paste this entire output back to the manager session, plus your answers to
  1–4. Everything else in Phase 1B is already decided.
  ────────────────────────────────────────────────────────────────────────────
`);

  if (providerId && KEEP) {
    console.log(`  REMINDER: envelope ${providerId} is still OPEN (--keep).\n`);
  }
  return failed;
}

main()
  .then((failed) => { process.exitCode = failed ? 1 : 0; })
  .catch((err) => {
    console.error('\nUNCAUGHT — the script itself broke, not the provider:');
    console.error(err);
    process.exitCode = 2;
  })
  .finally(async () => {
    try { await db.end(); } catch { /* pool may already be closed */ }
  });