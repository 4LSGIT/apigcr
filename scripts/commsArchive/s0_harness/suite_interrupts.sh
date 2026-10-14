#!/bin/bash
# Ctrl-C and a lost terminal in the middle of each stage, on a real pseudo-terminal; then the
# rerun finishes the job. Plus the whole sequence once on a pty with the REAL waits and time limits.
. "$(dirname "$0")/lib.sh"; . "$(dirname "$0")/t.sh"
[ -n "${S0_SHARED:-}" ] || { stub_up || exit 1; trap stub_down EXIT; }
# pty MODE TRIGGER STAGE [ARG]: the stage on a terminal, interrupted at TRIGGER
pty() {
  [ "$SKIP" = 1 ] && return 0
  : > "$WORK/calls.log"; PSTAGE=$3
  ( cd "$HOME" && python3 "$HD/ptyrun.py" "$OUT" "$1" "$2" 120 -- bash "$SCRIPT" "${@:3}" ); RC=$?
  LAST=$(grep . "$OUT" | tail -1 | tr -d '\r')
}
serving() { st "[t['revisionName'] for t in s['run']['status']['traffic'] if t.get('percent')==100][0]"; }
nrevs()   { st "len(s['revisions'])"; }
follows() { [ "$(st "s['run']['spec']['traffic']==[{'percent':100,'latestRevision':True}]")" = true ]; }
rev0()    { st "sorted(s['revisions'])[0]"; }
intr()    { [ "$SKIP" = 1 ] && return 0; [ -n "${S0_SHOW:-}" ] && { echo "----- out:"; cat "$OUT"; echo "----- log file:"; tail -5 "$HOME/s0_$PSTAGE.log"; echo "----- end"; }; check "interrupted, says so" 'has "--- interrupted"'; check "ends NO-GO" 'lastm NO-GO'; check "exit 130" '[ "$RC" = 130 ]'; }

scen "K0 the whole sequence on a terminal, real waits and time limits"
[ "$SKIP" = 1 ] || ( unset S0_LOG_WAIT S0_POLL S0_APP_WAIT S0_TIMEOUT_DIV S0_SIGN_WAIT
  for x in precheck bucket iam env verify status; do
    pty none x $x; [ "$RC" = 0 ] || { echo "  FAIL [K0] $x rc=$RC: $LAST"; exit 1; }
    printf '%s' "$LAST" | grep -q " — GO" || { echo "  FAIL [K0] $x: $LAST"; exit 1; }
  done ); K0RC=$?; [ "$SKIP" = 1 ] && K0RC=0; check "every stage GO on a pty with the real settings" '[ $K0RC = 0 ]'

scen "K1 Ctrl-C while the bucket create is in flight (it lands): rerun GO"
faults '[{"match":"^POST api.localhost/storage/v1/b$","mode":"after_hang","seconds":20,"count":1}]'
pty int "2 create it" bucket; intr
faults '[]'; run bucket; check "rerun GO" 'lastm "BUCKET OK"'

scen "K2 Ctrl-C during the self-signing grant (it does not land): rerun GO"
prep bucket; faults '[{"match":"setIamPolicy","mode":"hang","seconds":20,"count":1}]'
pty int "3 roles/iam.serviceAccountTokenCreator" iam; intr
faults '[]'; run iam; check "rerun GO" 'lastm "IAM OK"'

scen "K3 Ctrl-C while the env update is in flight (it lands): old revision still serves; rerun does not redeploy"
prep bucket; prep iam; R0=$(rev0)
faults '[{"match":"^PUT us-east1-api.localhost/.*/services/svpcac$","mode":"after_hang","seconds":20,"count":1}]'
pty int "3 a new revision" env; intr
check "old revision serves" '[ "$(serving)" = "$R0" ]'
faults '[]'; run env
check "rerun GO" 'lastm "ENV OK"'; check "one new revision only" '[ "$(nrevs)" = 2 ]'; check "follows" follows

scen "K4 Ctrl-C while waiting for the boot log: old revision serves; rerun GO"
prep bucket; prep iam; R0=$(rev0)
faults '[{"match":"entries:list","mode":"hang","seconds":20,"count":1}]'
pty int "6 svpcac" env; intr
check "old revision serves" '[ "$(serving)" = "$R0" ]'
faults '[]'; run env; check "rerun GO" 'lastm "ENV OK"'; check "no redeploy" '[ "$(nrevs)" = 2 ]'

scen "K5 Ctrl-C while the traffic move is in flight (it lands): rerun GO"
prep bucket; prep iam
faults '[{"match":"^PUT us-east1-api.localhost/.*/services/svpcac$","mode":"after_hang","seconds":20,"count":1,"skip":1}]'
pty int "8 traffic back" env; intr
faults '[]'; run env; check "rerun GO" 'lastm "ENV OK"'; check "follows" follows; check "no redeploy" '[ "$(nrevs)" = 2 ]'

scen "K6 terminal lost while the env update is in flight: rerun GO"
prep bucket; prep iam; R0=$(rev0)
faults '[{"match":"^PUT us-east1-api.localhost/.*/services/svpcac$","mode":"after_hang","seconds":20,"count":1}]'
pty hup "3 a new revision" env
check "stopped (not finished)" '[ "$RC" != 0 ]'
sleep 1; check "old revision serves" '[ "$(serving)" = "$R0" ]'
faults '[]'; run env; check "rerun GO" 'lastm "ENV OK"'; check "follows" follows

scen "K7 Ctrl-C while signing in verify: rerun GO"
for x in bucket iam env; do prep $x; done
faults '[{"match":":signBlob","mode":"hang","seconds":20,"count":1}]'
pty int "6 a URL signed" verify; intr
faults '[]'; run verify; check "rerun GO" 'lastm "VERIFY OK"'

scen "K8 Ctrl-C during rollback's env update: rerun finishes"
for x in bucket iam env verify; do prep $x; done
faults '[{"match":"^PUT us-east1-api.localhost/.*/services/svpcac$","mode":"after_hang","seconds":20,"count":1}]'
pty int "3 a new revision" rollback; intr
faults '[]'; run rollback; check "rerun GO" 'lastm "ROLLED BACK"'

scen "K9 Ctrl-C in precheck: nothing changed"
faults '[{"match":"serviceAccounts/[^:]*$","mode":"hang","seconds":20,"count":1}]'
snap before; pty int "service account" precheck; intr; check "nothing changed" same_state
summary interrupts
[ $FAILN = 0 ]
