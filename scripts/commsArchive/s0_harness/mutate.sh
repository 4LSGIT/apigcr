#!/bin/bash
# Mutation check: break the script one guard at a time; the named scenarios must FAIL.
# A mutant that survives means those scenarios do not really test that guard.
#   bash mutate.sh            all mutants      bash mutate.sh m_p3   one mutant
HD=$(cd "$(dirname "$0")" && pwd); SRC=$HD/../s0_infra.sh
M=$(mktemp -d "${TMPDIR:-/tmp}/s0m.XXXXXX"); trap 'rm -rf "$M"' EXIT
KILLED=0; SURVIVED=0; BROKEN=0
# mutant NAME SUITE SCENARIO-REGEX OLD NEW   (OLD must occur exactly once in the script)
mutant() {
  [ -n "${ONLY:-}" ] && [ "$1" != "$ONLY" ] && return 0
  python3 - "$SRC" "$M/$1.sh" "$4" "$5" <<'PY' || { echo "   $1: anchor not found exactly once — mutant BROKEN"; BROKEN=$((BROKEN+1)); return 0; }
import sys
s = open(sys.argv[1]).read(); old, new = sys.argv[3], sys.argv[4]
if s.count(old) != 1: sys.exit(1)
open(sys.argv[2], 'w').write(s.replace(old, new))
PY
  bash -n "$M/$1.sh" || { echo "   $1: mutant has a syntax error — BROKEN"; BROKEN=$((BROKEN+1)); return 0; }
  # S0_GATE: a machine-wide gate script; each mutant's run takes one cpu slot through it
  if S0_SOURCE="$M/$1.sh" S0_ONLY="$3" ${S0_GATE:+bash "$S0_GATE" cpu "comms/S0: mutant $1" --} bash "$HD/run.sh" "$2" > "$M/$1.out" 2>&1; then
    SURVIVED=$((SURVIVED+1)); echo "   SURVIVED: $1 ($2 / $3)"
  elif grep -q 'FAIL \[' "$M/$1.out"; then
    KILLED=$((KILLED+1)); echo "   killed:   $1 — $(grep -m1 'FAIL \[' "$M/$1.out" | sed 's/^ *//' | cut -c1-150)"
  else  # run.sh failed without a scenario failing: the harness, not the mutant
    BROKEN=$((BROKEN+1)); echo "   BROKEN:   $1 — the harness failed, not a scenario: $(grep -v '^$' "$M/$1.out" | tail -1 | cut -c1-150)"
  fi
}
ONLY=${1:-}
echo "### precheck / status / calibrate / hold"
mutant m_p1 precheck '^P3 ' '    chk("soft delete (seconds)"; ((.softDeletePolicy.retentionDurationSeconds // "0") | tostring); "2592000"),' ''
mutant m_p2 precheck '^P2 ' 'then BSTATE=taken' 'then BSTATE=absent'
mutant m_p3 precheck '^P6 ' "      *)           bad \"traffic is not '100% LATEST'" "      *)           note \"traffic is not '100% LATEST'"
mutant m_p4 precheck '^P2 ' 'else nogo ""; echo "PRECHECK: $FAILS problem(s) above — nothing was changed — NO-GO. Send this log to the manager."; exit 1; fi' 'else nogo ""; echo "PRECHECK: $FAILS problem(s) above — nothing was changed — NO-GO. Send this log to the manager."; fi'
mutant m_p5 precheck '^C1 ' 'echo "== service $SVC (variable values removed)"; jq "$strip" "$TMP/svc.json"' 'echo "== service $SVC (variable values removed)"; jq . "$TMP/svc.json"'
mutant m_p6 precheck '^C1 ' "    if v in t: n += t.count(v); t = t.replace(v, '<value masked>')" '    pass'
if grep -q '^HOLD="[a-z]' "$SRC"; then mutant m_p7 precheck '^H1 ' '  case " $HOLD " in *" $CMD "*)' '  case " $HOLD " in *" nothing "*)'
else echo "   n/a:      m_p7 (HOLD is empty in this copy, so no stage is held; the gate was killed against the held copy)"; fi
mutant m_p8 precheck '^P1 ' '  say "APIs"' '  say "APIs"; g 60 services enable $API_IC'
mutant m_p9 precheck '^P14 ' 'timeout --foreground "$t" gcloud' 'gcloud'
mutant m_p10 precheck '^P7 ' '&& ok "Cloud SQL attachment $CONN on the template" || bad' '&& ok "Cloud SQL attachment $CONN on the template" || note'
echo "### bucket"
mutant m_b1 stages '^B1 ' ' --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d' ' --uniform-bucket-level-access --soft-delete-duration=30d'
mutant m_b2 stages '^B1 ' ' --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d' ' --uniform-bucket-level-access --public-access-prevention'
mutant m_b3 stages '^B1 ' '--default-storage-class=ARCHIVE \' '--default-storage-class=STANDARD \'
mutant m_b4 stages '^B1 ' '      bucket_state
      [ "$BSTATE" = present ] || stop "the bucket was not created (see above)." ;;' '      g 60 storage buckets update "gs://$B" --versioning; bucket_state
      [ "$BSTATE" = present ] || stop "the bucket was not created (see above)." ;;'
mutant m_b5 precheck '^P4 ' '    chk("versioning"; (.versioning.enabled // false); false),' ''
mutant m_b6 stages '^B2 ' '    nogo "BUCKET EXISTS BUT IS NOT AS SPECIFIED — NO-GO. Nothing was changed; it is not fixed automatically. Send this log to the manager."
    exit 1' '    :'
echo "### iam"
mutant m_i1 stages '^I1 ' 'ROLE_OBJ=roles/storage.objectUser;' 'ROLE_OBJ=roles/storage.objectAdmin;'
mutant m_i2 stages '^I1 ' 'g 120 storage buckets add-iam-policy-binding "gs://$B" --member="serviceAccount:$SA" --role=$ROLE_OBJ --format=none; rc=$?' 'g 120 projects add-iam-policy-binding $P --member="serviceAccount:$SA" --role=$ROLE_OBJ --condition=None --format=none; rc=$?'
mutant m_i3 stages '^I1 ' '  if has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA"; then echo "already granted"' '  if true; then echo "already granted"'
mutant m_i4 stages '^I1 ' '  if api_enabled $API_IC; then echo "already enabled"' '  if true; then echo "already enabled"'
mutant m_i5 stages '^I3 ' '  [ -z "$(sa_other_roles)" ] || stop "the service account already holds other roles' '  true || stop "the service account already holds other roles'
echo "### env"
mutant m_e1 stages '^E1 ' '"$envflag" --no-traffic --tag=$TAG' '"$envflag" --tag=$TAG'
mutant m_e2 stages '^E5b ' '  if ! diff "$TMP/norm_O.json" "$TMP/norm_N.json" > "$TMP/diff.txt"; then' '  if false; then'
mutant m_e3 stages '^E6 ' '  if grep -E "$DIRTY" "$TMP/boot.log" > "$TMP/dirty.txt"; then' '  if false; then'
mutant m_e4 stages '^E7b ' "  grep -q 'Server is running on port' \"\$TMP/boot.log\" || stop" '  true || stop'
mutant m_e5 stages '^E8 ' '  [ "$code" = 401 ] && [ "$(jq -r '"'"'.error // ""'"'"' "$TMP/app.out" 2>/dev/null)" = Unauthorized ] || stop' '  true || stop'
mutant m_e6 stages '^E3 ' '  [ -z "$bl" ] || stop "a Cloud Build started' '  true || stop "a Cloud Build started'
mutant m_e7 stages '^E2 ' '  [ -z "$bl" ] || stop "a Cloud Build is running ($bl). Wait' '  true || stop "a Cloud Build is running ($bl). Wait'
mutant m_e8 stages '^E1 ' '--to-latest --remove-tags=$TAG; rc=$?' '--to-latest; rc=$?'
mutant m_e9 stages '^E9 ' '    *) stop "traffic is not in a shape this script handles' '    *) echo "traffic is not in a shape this script handles'
echo "### verify"
mutant m_v1 stages '^V4 ' '  case $c1 in 401|403) ok' '  case $c1 in 401|403|200) ok'
mutant m_v2 stages '^V9 ' '[ "$ts" != "$su" ] && [ "$ct" = 403 ] && ok' 'true && ok'
mutant m_v3 stages '^V7 ' 'NEED_PERMS="storage.objects.create storage.objects.get storage.objects.list storage.objects.delete"' 'NEED_PERMS="storage.objects.create storage.objects.get storage.objects.delete"'
mutant m_v4 stages '^V2 ' '[ "$(jq -r '"'"'.md5Hash'"'"' "$TMP/probe.json")" = "$md5" ] && ok "present, content as written"' 'true && ok "present, content as written"'
mutant m_v5 stages '^V2 ' '    nogo ""; echo "VERIFY: $FAILS problem(s) above — NO-GO. Send this log to the manager."; exit 1' '    nogo ""; echo "VERIFY: $FAILS problem(s) above — NO-GO. Send this log to the manager."'
mutant m_v6 stages '^V3 ' '    echo "  you cannot impersonate the service account — signing proof deferred' '    bad "you cannot impersonate"; echo "  you cannot impersonate the service account — signing proof deferred'
echo "### rollback"
mutant m_r1 stages '^R2 ' '      if grep -vqx "$PROBE" "$TMP/objs.txt"; then' '      if false; then'
mutant m_r2 stages '^R1 ' '          g 120 iam service-accounts remove-iam-policy-binding' '          true || g 120 iam service-accounts remove-iam-policy-binding'
echo "### interrupts"
mutant m_k1 interrupts '^K1 ' "  trap 'echo >&3; echo \"--- interrupted\" >&3; exit 130' INT" "  :"
mutant m_k2 interrupts '^K3 ' '  if [ "$shape" = pinned_ours ] && [ -n "$N" ] && rev_json "$N" && rev_ready "$N" && [ "$(rev_var "$N")" = "$want" ]; then' '  if false; then'
mutant m_k3 interrupts '^K9 ' "  trap 'echo >&3; echo \"--- interrupted\" >&3; exit 130' INT" "  trap 'echo; echo \"--- interrupted\"; exit 130' INT"
echo "### a timed-out gcloud must not hang the stage"
mutant m_g1 stages '^R4 ' '            timeout --foreground "$t" gcloud "${@:2}" </dev/null >"$TMP/gout" 2>"$ERR"; rc=$?
            cat "$TMP/gout"; return $rc; }' '            timeout --foreground "$t" gcloud "${@:2}" </dev/null 2>"$ERR"; }'
echo; echo "RESULT MUTATIONS: killed=$KILLED survived=$SURVIVED broken=$BROKEN"
[ $SURVIVED = 0 ] && [ $BROKEN = 0 ]
