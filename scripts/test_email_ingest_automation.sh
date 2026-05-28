#!/usr/bin/env bash
# scripts/test_email_ingest_automation.sh
#
# Phase 2 Slice 2.3 — Email Ingest Layer 3 (Automation Rules) integration test.
#
# Posts envelopes to the live ingest endpoint and verifies the resulting
# email_ingest_executions rows via the readonly SQL endpoint. Proves:
#   - Layer 3 does NOT fire on non-matching subjects (no false positives)
#   - Layer 3 fires on the sentinel subject (matched_rules + action_outcomes)
#   - Layer 3 fires even when Layer 2 SUPPRESSES the log row (independence)
#   - Duplicates do NOT re-run rule eval (metadata NULL on dup path)
#   - Inactive rules don't match (manual step — readonly key can't UPDATE)
#
# Prereqs:
#   - Code deployed (emailIngestRuleService.js + modified emailIngestService.js)
#   - Seed migration applied (the 'TEST: ingest layer 3 echo' rule, active=1)
#   - The court suppression rule (id 1, 'Court emails (uscourts.gov)') active=1
#     (created in Slice 2.1; confirmed live).
#
# Env:
#   INGEST_KEY    — the gmail-firm source's X-Email-Ingest-Key
#   READONLY_KEY  — ycro_... readonly SQL key
#   BASE_URL      — default https://app.4lsg.com
#
# Usage:
#   export INGEST_KEY=<gmail-firm key>
#   export READONLY_KEY=ycro_...
#   ./scripts/test_email_ingest_automation.sh
#
# Requires: bash, curl, jq.

set -uo pipefail

BASE_URL="${BASE_URL:-https://app.4lsg.com}"
INGEST_URL="$BASE_URL/api/email/ingest"
SQL_URL="$BASE_URL/api/readonly/sql"

: "${INGEST_KEY:?set INGEST_KEY to the gmail-firm X-Email-Ingest-Key}"
: "${READONLY_KEY:?set READONLY_KEY to the ycro_ readonly SQL key}"

SENTINEL="_EMAIL_INGEST_2_3_TEST_"
RUN_TAG="s23-$(date +%s)-$$"     # uniquify message-ids per run to avoid dedup
PASS=0; FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
ok()    { green "  PASS: $*"; PASS=$((PASS+1)); }
no()    { red   "  FAIL: $*"; FAIL=$((FAIL+1)); }

# ── helpers ──────────────────────────────────────────────────
# post <message_id> <from_email> <to_email> <subject>  → echoes response JSON
post() {
  local mid="$1" from="$2" to="$3" subj="$4"
  curl -sS -X POST "$INGEST_URL" \
    -H "Content-Type: application/json" \
    -H "X-Email-Ingest-Key: $INGEST_KEY" \
    -d "$(jq -n --arg mid "$mid" --arg from "$from" --arg to "$to" --arg subj "$subj" '
      { kind:"email",
        from:{email:$from},
        to:[{email:$to}],
        subject:$subj,
        text:"slice 2.3 self-test body",
        headers:{message_id:$mid} }')"
}

# sql <query> → echoes rows JSON array
sql() {
  curl -sS -X POST "$SQL_URL" \
    -H "Content-Type: application/json" \
    -H "X-Readonly-Api-Key: $READONLY_KEY" \
    -d "$(jq -n --arg q "$1" '{sql:$q}')" | jq -c '.rows'
}

# meta_for <message_id> → echoes the metadata JSON (or null) for the newest exec row
exec_row_for() {
  local mid="$1"
  sql "SELECT status, metadata FROM email_ingest_executions WHERE message_id = '$mid' ORDER BY id DESC LIMIT 1"
}

# Resolve rule ids we assert against.
TEST_RULE_ID="$(sql "SELECT id FROM email_ingest_rules WHERE name = 'TEST: ingest layer 3 echo' LIMIT 1" | jq -r '.[0].id // empty')"
COURT_RULE_ID="$(sql "SELECT id FROM email_ingest_log_suppressions WHERE name LIKE 'Court emails%' LIMIT 1" | jq -r '.[0].id // empty')"

echo "BASE_URL=$BASE_URL"
echo "test rule id  = ${TEST_RULE_ID:-<not found>}"
echo "court rule id = ${COURT_RULE_ID:-<not found>}"
echo

if [[ -z "$TEST_RULE_ID" ]]; then
  red "Seed rule 'TEST: ingest layer 3 echo' not found — apply the seed migration first."
  exit 2
fi

# ─────────────────────────────────────────────────────────────
# TEST 1 — Baseline: no sentinel → logged, no matched_rules/action_outcomes
# (to is a firm address so the legacy-mimic suppression rule does NOT fire)
# ─────────────────────────────────────────────────────────────
echo "TEST 1 — baseline (no automation match)"
MID1="<$RUN_TAG-t1@x>"
R1="$(post "$MID1" "ext@example.com" "b@4lsg.com" "ordinary subject no sentinel")"
echo "  response: $R1"
[[ "$(jq -r '.status' <<<"$R1")" == "logged" ]] && ok "status=logged" || no "expected status=logged"
ROW1="$(exec_row_for "$MID1")"
[[ "$(jq -r '.[0].status' <<<"$ROW1")" == "logged" ]] && ok "exec status=logged" || no "exec status not logged: $ROW1"
M1="$(jq -c '.[0].metadata' <<<"$ROW1")"
if [[ "$M1" == "null" ]]; then
  ok "metadata is NULL (no rules matched, no suppression)"
else
  # Acceptable only if it has neither matched_rules nor action_outcomes
  if [[ "$(jq -r '(.matched_rules//empty)|length' <<<"$M1")" == "" || "$(jq -r '.matched_rules // empty' <<<"$M1")" == "" ]]; then
    ok "metadata present but no matched_rules"
  else
    no "metadata unexpectedly has matched_rules: $M1"
  fi
fi
echo

# ─────────────────────────────────────────────────────────────
# TEST 2 — Automation fires: sentinel subject → logged + matched_rules + action success
# ─────────────────────────────────────────────────────────────
echo "TEST 2 — automation fires (logged)"
MID2="<$RUN_TAG-t2@x>"
R2="$(post "$MID2" "ext@example.com" "b@4lsg.com" "subject with $SENTINEL here")"
echo "  response: $R2"
[[ "$(jq -r '.status' <<<"$R2")" == "logged" ]] && ok "status=logged" || no "expected status=logged"
ROW2="$(exec_row_for "$MID2")"
M2="$(jq -c '.[0].metadata' <<<"$ROW2")"
echo "  metadata: $M2"
[[ "$(jq -r --arg id "$TEST_RULE_ID" '.matched_rules // [] | index(($id|tonumber)) != null' <<<"$M2")" == "true" ]] \
  && ok "matched_rules contains test rule $TEST_RULE_ID" || no "matched_rules missing $TEST_RULE_ID: $M2"
[[ "$(jq -r '.action_outcomes[0].status' <<<"$M2")" == "success" ]] \
  && ok "action_outcomes[0].status=success" || no "first action not success: $M2"
[[ "$(jq -r '.action_outcomes[0].action_type' <<<"$M2")" == "internal_function" ]] \
  && ok "action_outcomes[0].action_type=internal_function" || no "wrong action_type: $M2"
echo

# ─────────────────────────────────────────────────────────────
# TEST 3 — Layer independence: court (suppressed) + sentinel (automation fires)
#   from uscourts.gov → court suppression rule fires (skip log)
#   subject has sentinel → automation rule fires anyway
#   to is firm addr → legacy-mimic rule does NOT fire (keeps suppressed_by clean)
# ─────────────────────────────────────────────────────────────
echo "TEST 3 — suppressed AND automation fires (KEY independence proof)"
MID3="<$RUN_TAG-t3@x>"
R3="$(post "$MID3" "clerk@txs.uscourts.gov" "b@4lsg.com" "court notice $SENTINEL")"
echo "  response: $R3"
[[ "$(jq -r '.status' <<<"$R3")" == "skipped_suppression" ]] && ok "status=skipped_suppression" || no "expected skipped_suppression"
ROW3="$(exec_row_for "$MID3")"
M3="$(jq -c '.[0].metadata' <<<"$ROW3")"
echo "  metadata: $M3"
if [[ -n "$COURT_RULE_ID" ]]; then
  [[ "$(jq -r --arg id "$COURT_RULE_ID" '.suppressed_by // [] | index(($id|tonumber)) != null' <<<"$M3")" == "true" ]] \
    && ok "suppressed_by contains court rule $COURT_RULE_ID" || no "suppressed_by missing court rule: $M3"
else
  [[ "$(jq -r '.suppressed_by // [] | length > 0' <<<"$M3")" == "true" ]] \
    && ok "suppressed_by non-empty" || no "suppressed_by empty: $M3"
fi
[[ "$(jq -r --arg id "$TEST_RULE_ID" '.matched_rules // [] | index(($id|tonumber)) != null' <<<"$M3")" == "true" ]] \
  && ok "matched_rules contains test rule $TEST_RULE_ID (automation ran despite suppression)" || no "matched_rules missing: $M3"
[[ "$(jq -r '.action_outcomes[0].status' <<<"$M3")" == "success" ]] \
  && ok "action fired successfully under suppression" || no "action not success under suppression: $M3"
echo

# ─────────────────────────────────────────────────────────────
# TEST 4 — Duplicate does NOT re-fire automation
#   Re-post TEST 2's exact message-id → duplicate, metadata NULL.
# ─────────────────────────────────────────────────────────────
echo "TEST 4 — duplicate does not re-run rule eval"
R4="$(post "$MID2" "ext@example.com" "b@4lsg.com" "subject with $SENTINEL here")"
echo "  response: $R4"
[[ "$(jq -r '.status' <<<"$R4")" == "duplicate" ]] && ok "status=duplicate" || no "expected duplicate"
# Newest row for MID2 should be the duplicate row (id desc) with NULL metadata.
ROW4="$(exec_row_for "$MID2")"
[[ "$(jq -r '.[0].status' <<<"$ROW4")" == "duplicate" ]] && ok "newest exec row for MID2 is duplicate" || no "newest not duplicate: $ROW4"
[[ "$(jq -c '.[0].metadata' <<<"$ROW4")" == "null" ]] && ok "duplicate row metadata is NULL" || no "duplicate row metadata not NULL: $ROW4"
echo

# ─────────────────────────────────────────────────────────────
# TEST 5 — Inactive rule (manual; readonly key can't UPDATE)
# ─────────────────────────────────────────────────────────────
echo "TEST 5 — inactive rule (manual step)"
echo "  The readonly endpoint can't UPDATE. To verify:"
echo "    1. (write session) UPDATE email_ingest_rules SET active=0 WHERE id=$TEST_RULE_ID;"
echo "    2. POST an envelope with subject containing $SENTINEL"
echo "       and assert status=logged with metadata NULL (no matched_rules)."
echo "    3. (write session) UPDATE email_ingest_rules SET active=1 WHERE id=$TEST_RULE_ID;"
echo "  Skipped automatically in this run."
echo

# ── summary ──────────────────────────────────────────────────
echo "────────────────────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]] && { green "ALL ASSERTIONS PASSED"; exit 0; } || { red "FAILURES PRESENT"; exit 1; }