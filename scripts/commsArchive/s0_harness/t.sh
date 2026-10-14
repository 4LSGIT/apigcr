# Scenario helpers. Sourced after lib.sh. Every assertion counts; nothing is only printed.
PASS=${PASS:-0}; FAILN=${FAILN:-0}; CUR=""; LAST=""; RC=0
export S0_SIGN_WAIT=${S0_SIGN_WAIT:-3} S0_LOG_WAIT=${S0_LOG_WAIT:-8} S0_POLL=${S0_POLL:-1} S0_APP_WAIT=${S0_APP_WAIT:-4} S0_TIMEOUT_DIV=${S0_TIMEOUT_DIV:-10}
OUT=$WORK/out.txt
ok_()  { PASS=$((PASS+1)); }
no_()  { FAILN=$((FAILN+1)); echo "  FAIL [$CUR] $*"; echo "    last line: $LAST"
         # S0_FAILDIR: keep the full output of every failing run (the work dir is deleted at the end)
         if [ -n "${S0_FAILDIR:-}" ]; then mkdir -p "$S0_FAILDIR"; local f; f=$S0_FAILDIR/$(printf '%s' "${CUR%% *}" | tr -c 'A-Za-z0-9' _).$FAILN.txt
           { echo "# $CUR — $*"; cat "$OUT" 2>/dev/null; echo "# calls:"; cat "$WORK/calls.log" 2>/dev/null; } > "$f"; fi; }
check(){ [ "$SKIP" = 1 ] && return 0; if eval "$2"; then ok_; else no_ "$1"; fi; }
# S0_ONLY=<regex> runs only the scenarios whose title matches (the mutation suite uses it)
SKIP=0
scen() { CUR=$1; SKIP=0; if [ -n "${S0_ONLY:-}" ] && ! printf '%s' "$1" | grep -qE -- "$S0_ONLY"; then SKIP=1; return 0; fi
         reset; faults '[]'; echo "## $1"; }
# run STAGE [ARG]: the script exactly as Fred runs it (from $HOME, logs to ~). Also asserts the
# house rule on EVERY run: the last line is one GO or NO-GO line that agrees with the exit code.
run() {
  [ "$SKIP" = 1 ] && return 0
  : > "$WORK/calls.log"
  # watchdog: a stage that does not finish is a failure, not a stalled suite (S0_RUN_LIMIT seconds)
  ( cd "$HOME" && timeout "${S0_RUN_LIMIT:-300}" bash "$SCRIPT" "$@" ) > "$OUT" 2>&1; RC=$?
  [ "$RC" = 124 ] && echo "HARNESS: the stage did not finish within ${S0_RUN_LIMIT:-300}s" >> "$OUT"
  LAST=$(grep . "$OUT" | tail -1)
  if [ $RC = 0 ]; then check "rc 0 ends with a GO line" 'case "$LAST" in *" — GO"*|*" — GO."*) ! printf "%s" "$LAST" | grep -q "NO-GO";; *) false;; esac'
  else check "rc $RC ends with a NO-GO line" 'printf "%s" "$LAST" | grep -q "NO-GO"'; fi
  RSTAGE=$1; check "log file written" '[ -s "$HOME/s0_$RSTAGE.log" ]'
}
has()   { grep -qF -- "$1" "$OUT"; }
lastm() { printf '%s' "$LAST" | grep -qE -- "$1"; }
# mutating requests the stub saw during the last run
mutations() { grep -E '^[0-9:]+ (PUT|PATCH|DELETE) |^[0-9:]+ POST [^ ]*(setIamPolicy|:enable|batchEnable|/storage/v1/b\?|/upload/)' "$WORK/calls.log" | grep -v '/__ctl/'; }
snap()  { curl -s "$CTL/state" | python3 -c '
import sys, json
s = json.load(sys.stdin); s["flags"].pop("served", None); s.pop("signatures", None); s.pop("faults", None); s.pop("uploads", None)
for b in s.get("builds", []): b.pop("starts_after_calls", None)
print(json.dumps(s, sort_keys=True))' > "$WORK/snap.$1"; }
same_state() { snap after; cmp -s "$WORK/snap.before" "$WORK/snap.after"; }
readonly_run() {  # run a stage and assert it changed nothing, by effect
  [ "$SKIP" = 1 ] && return 0
  snap before; run "$@"
  check "$1 sent no mutating request" '[ -z "$(mutations)" ]'
  check "$1 left the state unchanged" 'same_state'
}
st()  { ev "$1"; }
# the canned state edits used by several suites
REV0='s["run"]["status"]["latestReadyRevisionName"]'
pin_other()  { spy "s['run']['spec']['traffic']=[{'revisionName': $REV0, 'percent': 100}]; resolve(s)"; }
# setup steps run the RELEASED copy (the file under test may hold its mutating stages)
prep() { [ "$SKIP" = 1 ] && return 0; ( cd "$HOME" && bash "${S0_RELEASED:-$SCRIPT}" "$@" ) >/dev/null 2>&1; }
summary() { echo; echo "RESULT $1: passed=$PASS failed=$FAILN"; }
