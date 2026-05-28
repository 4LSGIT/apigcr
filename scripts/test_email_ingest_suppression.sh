#!/usr/bin/env bash
# scripts/test_email_ingest_suppression.sh
#
# Phase 2 Slice 2.1 — integration tests for the Layer 2 suppression layer.
#
# Hits the live /api/email/ingest endpoint and verifies both:
#   1. HTTP response shape
#   2. Resulting email_ingest_executions row (via the readonly SQL endpoint)
#
# Prereqs (export before running):
#   INGEST_KEY     — a valid X-Email-Ingest-Key for the gmail-firm source
#                    (rotate this if you don't have a current one)
#   READONLY_KEY   — a valid X-Readonly-Api-Key for /api/readonly/sql
#
# Optional:
#   BASE_URL       — defaults to https://app.4lsg.com
#   SOURCE_NAME    — source name to use; defaults to gmail-firm
#   DOMAIN_FIRM    — firm domain for test 4; defaults to 4lsg.com
#   SUPPRESSION_RULE_NAME — used to look up the seeded rule's id;
#                          defaults to 'Court emails (uscourts.gov)'
#
# Test 5 ("inactive suppression") requires a write to the live DB which the
# readonly endpoint can't perform. Documented as a manual step below.
#
# Each test prints "PASS:" or "FAIL:" with diagnostic info and exits 1 on
# any failure so the script can run in CI later if needed.

set -uo pipefail

: "${INGEST_KEY:?must set INGEST_KEY (X-Email-Ingest-Key for gmail-firm)}"
: "${READONLY_KEY:?must set READONLY_KEY (X-Readonly-Api-Key)}"
BASE_URL="${BASE_URL:-https://app.4lsg.com}"
SOURCE_NAME="${SOURCE_NAME:-gmail-firm}"
DOMAIN_FIRM="${DOMAIN_FIRM:-4lsg.com}"
SUPPRESSION_RULE_NAME="${SUPPRESSION_RULE_NAME:-Court emails (uscourts.gov)}"

RUN_TAG="$(date +%Y%m%dT%H%M%S)-$$"

PASS=0
FAIL=0

# ─────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────
ingest() {
  # $1 = JSON body. Echo "<HTTP_STATUS>\n<BODY>".
  local body="$1"
  local resp
  resp="$(curl -sS -o /tmp/ingest.body -w "%{http_code}" -X POST \
    "$BASE_URL/api/email/ingest" \
    -H 'Content-Type: application/json' \
    -H "X-Email-Ingest-Key: $INGEST_KEY" \
    --data "$body")"
  echo "$resp"
  cat /tmp/ingest.body
}

rosql() {
  # $1 = SQL string. Returns the rows JSON array string.
  local sql="$1"
  curl -sS -X POST "$BASE_URL/api/readonly/sql" \
    -H 'Content-Type: application/json' \
    -H "X-Readonly-Api-Key: $READONLY_KEY" \
    --data "$(jq -n --arg s "$sql" '{sql:$s}')"
}

assert_eq() {
  # $1 label, $2 expected, $3 actual
  if [[ "$2" == "$3" ]]; then
    echo "  PASS: $1 = $2"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $1: expected '$2', got '$3'"
    FAIL=$((FAIL+1))
  fi
}

# ─────────────────────────────────────────────────────────────
# Resolve the seeded court rule's id (needed for test 2 metadata check)
# ─────────────────────────────────────────────────────────────
echo "─── Resolving court suppression rule id"
COURT_RULE_ROWS="$(rosql "SELECT id FROM email_ingest_log_suppressions WHERE name = '${SUPPRESSION_RULE_NAME//\'/\'\'}' AND active = 1")"
echo "  rosql resp: $COURT_RULE_ROWS"
COURT_RULE_ID="$(echo "$COURT_RULE_ROWS" | jq -r '.rows[0].id // empty')"
if [[ -z "$COURT_RULE_ID" ]]; then
  echo "FATAL: could not find active suppression rule named '$SUPPRESSION_RULE_NAME'. Did the seed migration run?"
  exit 1
fi
echo "  COURT_RULE_ID = $COURT_RULE_ID"

# ─────────────────────────────────────────────────────────────
# Test envelope builder
# ─────────────────────────────────────────────────────────────
make_envelope() {
  # $1 from_email, $2 to_email (json array contents minus the wrapping), $3 message_id, $4 subject
  local from_email="$1"
  local to_email="$2"
  local message_id="$3"
  local subject="$4"
  jq -n \
    --arg from "$from_email" \
    --arg to "$to_email" \
    --arg mid "$message_id" \
    --arg subj "$subject" \
    '{
      schema_version: "1",
      received_at: (now | todate),
      source: "gmail-firm",
      adapter_version: "test-1.0",
      kind: "email",
      envelope: { sender: null, recipient: null, local_part: null, plus_tag: null, domain: null, exim_message_id: null, exim_local_part_raw: null, exim_domain_raw: null },
      from: { name: "", email: $from },
      to:   [ { name: "", email: $to } ],
      cc: [], reply_to: [],
      subject: $subj,
      date: (now | todate),
      text: "test body",
      html: "",
      attachments: [],
      auth: { spf: null, dkim: null, dmarc: null, arc: null, antispam_result: null, raw_authentication_results: null },
      headers: { message_id: $mid, in_reply_to: null, references: null, content_type: null, list_id: null, all: {} },
      raw: { headers_block: "", body_block: null },
      _parse_warnings: []
    }'
}

# ─────────────────────────────────────────────────────────────
# TEST 1 — Baseline logged path
# ─────────────────────────────────────────────────────────────
echo
echo "─── TEST 1: baseline logged"
T1_MID="t1-$RUN_TAG@test.local"
T1_BODY="$(make_envelope 'alice@external.com' 'sender@example.com' "$T1_MID" 'T1 baseline')"
T1_OUT="$(ingest "$T1_BODY")"
T1_CODE="$(echo "$T1_OUT" | head -1)"
T1_RESP="$(echo "$T1_OUT" | tail -n +2)"
echo "  HTTP=$T1_CODE  resp=$T1_RESP"
T1_STATUS="$(echo "$T1_RESP" | jq -r '.status')"
T1_EXEC_ID="$(echo "$T1_RESP" | jq -r '.execution_id')"
assert_eq "T1 http 200" "200" "$T1_CODE"
assert_eq "T1 status" "logged" "$T1_STATUS"

T1_ROW="$(rosql "SELECT status, metadata FROM email_ingest_executions WHERE id = $T1_EXEC_ID")"
T1_DB_STATUS="$(echo "$T1_ROW" | jq -r '.rows[0].status')"
T1_DB_META="$(echo "$T1_ROW" | jq -r '.rows[0].metadata')"
assert_eq "T1 db.status" "logged" "$T1_DB_STATUS"
assert_eq "T1 db.metadata" "null" "$T1_DB_META"

# ─────────────────────────────────────────────────────────────
# TEST 2 — Court match → skipped_suppression
# ─────────────────────────────────────────────────────────────
echo
echo "─── TEST 2: court suppression"
T2_MID="t2-$RUN_TAG@test.local"
T2_BODY="$(make_envelope 'ecf@miwb.uscourts.gov' 'sender@example.com' "$T2_MID" 'T2 court')"
T2_OUT="$(ingest "$T2_BODY")"
T2_CODE="$(echo "$T2_OUT" | head -1)"
T2_RESP="$(echo "$T2_OUT" | tail -n +2)"
echo "  HTTP=$T2_CODE  resp=$T2_RESP"
T2_STATUS="$(echo "$T2_RESP" | jq -r '.status')"
T2_EXEC_ID="$(echo "$T2_RESP" | jq -r '.execution_id')"
T2_EL_ID="$(echo "$T2_RESP" | jq -r '.email_log_id // empty')"
T2_LOG_ID="$(echo "$T2_RESP" | jq -r '.log_id // empty')"
assert_eq "T2 http 200" "200" "$T2_CODE"
assert_eq "T2 status" "skipped_suppression" "$T2_STATUS"
assert_eq "T2 no log_id" "" "$T2_LOG_ID"
[[ -n "$T2_EL_ID" ]] && echo "  PASS: T2 email_log_id present ($T2_EL_ID)" && PASS=$((PASS+1)) || { echo "  FAIL: T2 email_log_id missing"; FAIL=$((FAIL+1)); }

T2_ROW="$(rosql "SELECT status, metadata, log_id, email_log_id FROM email_ingest_executions WHERE id = $T2_EXEC_ID")"
T2_DB_STATUS="$(echo "$T2_ROW" | jq -r '.rows[0].status')"
T2_DB_META_RAW="$(echo "$T2_ROW" | jq -r '.rows[0].metadata')"
# metadata column comes back as a JSON string from the readonly endpoint
T2_DB_META_CONTAINS_ID="$(echo "$T2_DB_META_RAW" | jq -r --argjson id "$COURT_RULE_ID" '.suppressed_by | index($id) // empty')"
T2_DB_LOG_ID="$(echo "$T2_ROW" | jq -r '.rows[0].log_id')"
assert_eq "T2 db.status" "skipped_suppression" "$T2_DB_STATUS"
assert_eq "T2 db.log_id null" "null" "$T2_DB_LOG_ID"
[[ -n "$T2_DB_META_CONTAINS_ID" ]] \
  && echo "  PASS: T2 db.metadata.suppressed_by contains $COURT_RULE_ID" && PASS=$((PASS+1)) \
  || { echo "  FAIL: T2 db.metadata.suppressed_by missing $COURT_RULE_ID (raw=$T2_DB_META_RAW)"; FAIL=$((FAIL+1)); }

# Verify email_log row IS present and log row is NOT present.
T2_EL_ROW="$(rosql "SELECT id FROM email_log WHERE source='$SOURCE_NAME' AND message_id='$T2_MID'")"
T2_EL_COUNT="$(echo "$T2_EL_ROW" | jq -r '.rowCount')"
assert_eq "T2 email_log row exists" "1" "$T2_EL_COUNT"
# No log row should exist for this message_id (we have no link from log to message_id directly,
# but the executions row has log_id=NULL, which is the contract).

# ─────────────────────────────────────────────────────────────
# TEST 3 — Same court message_id again → duplicate (suppression doesn't run)
# ─────────────────────────────────────────────────────────────
echo
echo "─── TEST 3: court repeat → duplicate"
T3_OUT="$(ingest "$T2_BODY")"  # same body as T2
T3_CODE="$(echo "$T3_OUT" | head -1)"
T3_RESP="$(echo "$T3_OUT" | tail -n +2)"
echo "  HTTP=$T3_CODE  resp=$T3_RESP"
T3_STATUS="$(echo "$T3_RESP" | jq -r '.status')"
T3_EXEC_ID="$(echo "$T3_RESP" | jq -r '.execution_id')"
assert_eq "T3 http 200" "200" "$T3_CODE"
assert_eq "T3 status" "duplicate" "$T3_STATUS"

T3_ROW="$(rosql "SELECT status, metadata FROM email_ingest_executions WHERE id = $T3_EXEC_ID")"
T3_DB_STATUS="$(echo "$T3_ROW" | jq -r '.rows[0].status')"
T3_DB_META="$(echo "$T3_ROW" | jq -r '.rows[0].metadata')"
assert_eq "T3 db.status" "duplicate" "$T3_DB_STATUS"
assert_eq "T3 db.metadata null (suppression did not run)" "null" "$T3_DB_META"

# ─────────────────────────────────────────────────────────────
# TEST 4 — Firm-to-firm → skipped_firm_to_firm (suppression doesn't run)
# ─────────────────────────────────────────────────────────────
echo
echo "─── TEST 4: firm-to-firm short-circuits before suppression"
T4_MID="t4-$RUN_TAG@test.local"
T4_BODY="$(make_envelope "alice@$DOMAIN_FIRM" "bob@$DOMAIN_FIRM" "$T4_MID" 'T4 internal')"
T4_OUT="$(ingest "$T4_BODY")"
T4_CODE="$(echo "$T4_OUT" | head -1)"
T4_RESP="$(echo "$T4_OUT" | tail -n +2)"
echo "  HTTP=$T4_CODE  resp=$T4_RESP"
T4_STATUS="$(echo "$T4_RESP" | jq -r '.status')"
T4_EXEC_ID="$(echo "$T4_RESP" | jq -r '.execution_id')"
assert_eq "T4 http 200" "200" "$T4_CODE"
assert_eq "T4 status" "skipped_firm_to_firm" "$T4_STATUS"

T4_ROW="$(rosql "SELECT status, metadata FROM email_ingest_executions WHERE id = $T4_EXEC_ID")"
T4_DB_STATUS="$(echo "$T4_ROW" | jq -r '.rows[0].status')"
T4_DB_META="$(echo "$T4_ROW" | jq -r '.rows[0].metadata')"
assert_eq "T4 db.status" "skipped_firm_to_firm" "$T4_DB_STATUS"
assert_eq "T4 db.metadata null (suppression did not run)" "null" "$T4_DB_META"

# ─────────────────────────────────────────────────────────────
# TEST 5 — Inactive rule → falls through to logged
#
# REQUIRES MANUAL SETUP (readonly endpoint can't UPDATE).
# Run by hand from a write-capable session:
#
#   UPDATE email_ingest_log_suppressions SET active = 0 WHERE id = <COURT_RULE_ID>;
#   <run this script with INGEST_KEY etc. set>
#   <verify the T5 block below shows status='logged'>
#   UPDATE email_ingest_log_suppressions SET active = 1 WHERE id = <COURT_RULE_ID>;
#
# If the rule is currently INACTIVE when this script runs, T5 will pass.
# If ACTIVE (the default), T5 is skipped with a notice.
# ─────────────────────────────────────────────────────────────
echo
echo "─── TEST 5: inactive rule (manual prep)"
T5_ACTIVE_CHECK="$(rosql "SELECT active FROM email_ingest_log_suppressions WHERE id = $COURT_RULE_ID")"
T5_ACTIVE="$(echo "$T5_ACTIVE_CHECK" | jq -r '.rows[0].active')"
if [[ "$T5_ACTIVE" == "1" ]]; then
  echo "  SKIPPED: court rule is currently active=1. To run this test,"
  echo "  set the rule to active=0 first (see comment block above), then re-run."
else
  T5_MID="t5-$RUN_TAG@test.local"
  T5_BODY="$(make_envelope 'inactive@miwb.uscourts.gov' 'sender@example.com' "$T5_MID" 'T5 inactive')"
  T5_OUT="$(ingest "$T5_BODY")"
  T5_CODE="$(echo "$T5_OUT" | head -1)"
  T5_RESP="$(echo "$T5_OUT" | tail -n +2)"
  echo "  HTTP=$T5_CODE  resp=$T5_RESP"
  T5_STATUS="$(echo "$T5_RESP" | jq -r '.status')"
  assert_eq "T5 http 200" "200" "$T5_CODE"
  assert_eq "T5 status (rule inactive → logged)" "logged" "$T5_STATUS"
fi

# ─────────────────────────────────────────────────────────────
echo
echo "─── SUMMARY: $PASS pass / $FAIL fail"
[[ $FAIL -eq 0 ]] || exit 1