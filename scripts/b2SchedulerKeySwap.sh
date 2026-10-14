#!/bin/bash
# scripts/b2SchedulerKeySwap.sh — access-control B2, ops half.
#
# Swaps the two Cloud Scheduler jobs onto freshly minted ROUTE-SCOPED yck_
# keys (design ref/ACCESS_CONTROL_DESIGN.md §5.2/§5.6 B2). Run in CLOUD
# SHELL as a project owner. One stage per command, re-runnable, no prompts;
# every external call under `timeout`. GO / NO-GO per stage names the next
# command.
#
# BEFORE THE SITTING (in the app, Admin → API Keys — B2's scopes box):
#   mint key A: label "scheduler process-jobs",   scopes: route:/process-jobs
#   mint key B: label "scheduler mailbox-ingest", scopes: route:/mailbox-ingest
# Keep both values handy. The OLD keys stay valid until you revoke them in
# the pane at the end — that is also the ROLLBACK: re-run a swap stage with
# the old value.
#
#   bash ~/b2_keys.sh precheck
#   KEY='yck_…A…' bash ~/b2_keys.sh swap-pj
#   bash ~/b2_keys.sh verify-pj        # ~1 min window (job runs every minute)
#   KEY='yck_…B…' bash ~/b2_keys.sh swap-mi
#   bash ~/b2_keys.sh verify-mi        # up to ~6 min window (*/5 cron)
# then: revoke the two OLD keys in the pane ("Pabbly"-era key 3 + key 7).
set -u
PROJECT=lsg-api-425223
LOC=us-east1
PJ=process-jobs
MI=mailbox-ingest
STAMP_DIR="${HOME}/.b2keys"; mkdir -p "$STAMP_DIR"

mask() { local v="$1"; [ -z "$v" ] && echo "(none)" || echo "${v:0:12}…(${#v} chars)"; }

jobjson() { timeout 60 gcloud scheduler jobs describe "$1" --location="$LOC" --project="$PROJECT" --format=json; }

hdr_prefix() { jq -r '.httpTarget.headers["x-api-key"] // "" | .[0:12]'; }

case "${1:-}" in
precheck)
  ok=1
  for t in gcloud jq timeout; do command -v $t >/dev/null || { echo "  missing tool: $t"; ok=0; }; done
  acct=$(timeout 30 gcloud config get-value account 2>/dev/null); echo "  account: $acct"
  for j in "$PJ" "$MI"; do
    js=$(jobjson "$j") || { echo "  cannot describe $j"; ok=0; continue; }
    st=$(echo "$js" | jq -r .state); pf=$(echo "$js" | hdr_prefix)
    hdrs=$(echo "$js" | jq -r '.httpTarget.headers | keys | join(",")')
    echo "  $j: state=$st x-api-key prefix=${pf}… schedule=$(echo "$js" | jq -r .schedule) headers=[$hdrs]"
    [ "$st" = ENABLED ] || { echo "  $j is not ENABLED"; ok=0; }
    # --update-headers PATCHes the WHOLE headers map (proven against a stub
    # API: one PATCH, updateMask=httpTarget.headers, no GET) — any custom
    # header beyond x-api-key would be dropped by the swap. Refuse here.
    for h in $(echo "$js" | jq -r '.httpTarget.headers | keys[]'); do
      case "$h" in x-api-key|X-Api-Key|User-Agent|Content-Type) ;; *) echo "  $j carries unexpected header '$h' — the swap would DROP it"; ok=0;; esac
    done
  done
  [ $ok = 1 ] && echo "GO — precheck clean. Next: KEY='yck_…A…' bash ~/b2_keys.sh swap-pj" \
             || echo "NO-GO — fix the lines above. Nothing was changed."
  ;;
swap-pj|swap-mi)
  job=$PJ; nxt="bash ~/b2_keys.sh verify-pj"; [ "$1" = swap-mi ] && job=$MI && nxt="bash ~/b2_keys.sh verify-mi"
  [ -n "${KEY:-}" ] || { echo "NO-GO — set KEY: KEY='yck_…' bash ~/b2_keys.sh $1. Nothing was changed."; exit 2; }
  case "$KEY" in yck_*) ;; *) echo "NO-GO — KEY does not start with yck_. Nothing was changed."; exit 2;; esac
  before=$(jobjson "$job" | hdr_prefix)
  date -u +%Y-%m-%dT%H:%M:%SZ > "$STAMP_DIR/$1.swapped_at"
  timeout 90 gcloud scheduler jobs update http "$job" --location="$LOC" --project="$PROJECT" \
    --update-headers=x-api-key="$KEY" >/dev/null || { echo "NO-GO — update failed; job unchanged (verify: describe shows prefix ${before}…)."; exit 1; }
  after=$(jobjson "$job" | hdr_prefix)
  [ "$after" = "${KEY:0:12}" ] \
    && echo "GO — $job header swapped (${before}… → ${after}…). Next: $nxt" \
    || { echo "NO-GO — read-back prefix ${after}… does not match the new key. Investigate before anything else."; exit 1; }
  ;;
verify-pj|verify-mi)
  job=$PJ; waits=8; nxt="KEY='yck_…B…' bash ~/b2_keys.sh swap-mi"; [ "$1" = verify-mi ] && job=$MI && waits=38 && nxt="revoke the two OLD keys in Admin → API Keys — done."
  since=$(cat "$STAMP_DIR/swap-${1#verify-}.swapped_at" 2>/dev/null || date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
  fails=0
  for i in $(seq 1 $waits); do
    # A FAILING logging call must never read as "no attempts yet" — count
    # consecutive failures and NO-GO on 3 (found by the stand-in dry-run).
    if ! errs=$(timeout 60 gcloud logging read \
      "resource.type=cloud_scheduler_job AND resource.labels.job_id=$job AND timestamp>=\"$since\" AND severity>=ERROR" \
      --project="$PROJECT" --limit=5 --format="value(timestamp)"); then
      fails=$((fails+1)); [ $fails -ge 3 ] && { echo "NO-GO — gcloud logging read failed $fails times; check auth/API, then re-run: bash ~/b2_keys.sh $1"; exit 1; }
      sleep "${B2_SLEEP:-10}"; continue
    fi
    fails=0
    okn=$(timeout 60 gcloud logging read \
      "resource.type=cloud_scheduler_job AND resource.labels.job_id=$job AND timestamp>=\"$since\" AND severity<ERROR" \
      --project="$PROJECT" --limit=5 --format="value(timestamp)" | grep -c . || true)
    n=$(echo "$errs" | grep -c . || true)
    [ "$n" -gt 0 ] && { echo "NO-GO — $job logged $n ERROR attempt(s) since the swap. ROLLBACK: KEY='<old key value>' bash ~/b2_keys.sh swap-${1#verify-}"; exit 1; }
    [ "$okn" -gt 0 ] && { echo "GO — $job fired cleanly since the swap ($okn attempt(s), no errors). Next: $nxt"; exit 0; }
    sleep "${B2_SLEEP:-10}"
  done
  echo "NO-GO — no attempt logged yet for $job (window too short or logs lagging). Re-run: bash ~/b2_keys.sh $1"
  exit 1
  ;;
*)
  sed -n '2,24p' "$0"
  ;;
esac
