#!/bin/bash
# The one command a reviewer runs:  bash scripts/commsArchive/s0_harness/run.sh
# Starts the stub API, runs every suite through the REAL gcloud CLI, prints
# RESULT lines, and exits non-zero on any failed check. No credentials, no network:
# gcloud uses a dummy token and an isolated config; anything that tries to leave the
# machine hits a dead proxy.  Optional: run.sh precheck  (one suite)
HD=$(cd "$(dirname "$0")" && pwd)
export S0_WORK=$(mktemp -d "${TMPDIR:-/tmp}/s0h.XXXXXX")
. "$HD/lib.sh"
for t in gcloud jq curl python3 openssl; do command -v $t >/dev/null || { echo "missing: $t"; exit 2; }; done
# Cloud Shell runs bash 5; bash 3.2 (macOS /bin/bash) handles a trapped Ctrl-C around a waited
# child differently, so its interrupt results do not carry over. Put bash 5 first (S0_PATH_PREPEND).
bv=$(bash -c 'echo ${BASH_VERSINFO[0]}')
[ "$bv" -ge 5 ] || [ -n "${S0_ALLOW_OLD_BASH:-}" ] || { echo "bash on PATH is $bv.x; Cloud Shell runs 5.x. Put bash 5 first via S0_PATH_PREPEND (or S0_ALLOW_OLD_BASH=1 to run anyway)."; exit 2; }
echo "harness: $(gcloud version 2>/dev/null | head -1) · bash $(bash -c 'echo $BASH_VERSION') · timeout: $(command -v timeout)"
# The released copy: the script with its HOLD line emptied (identical once released).
SRC=${S0_SOURCE:-$HD/../s0_infra.sh}   # the mutation suite points this at a mutant
python3 - "$SRC" "$WORK/s0_infra.sh" <<'PY'
import re, sys
s = open(sys.argv[1]).read(); n = len(re.findall(r'(?m)^HOLD="[^"]*"$', s))
assert n == 1, 'expected exactly one HOLD line, found %d' % n
open(sys.argv[2], 'w').write(re.sub(r'(?m)^HOLD="[^"]*"$', 'HOLD=""', s))
PY
stub_up || exit 1; trap 'stub_down; rm -rf "$WORK"' EXIT
export S0_SHARED=1 S0_RELEASED=$WORK/s0_infra.sh
rc=0
for s in ${1:-precheck stages interrupts}; do
  f=$HD/suite_$s.sh; [ -f "$f" ] || continue
  if [ "$s" = precheck ]; then S0_SCRIPT=$SRC bash "$f" || rc=1
  else S0_SCRIPT=$WORK/s0_infra.sh bash "$f" || rc=1; fi
done
echo; [ $rc = 0 ] && echo "HARNESS: ALL SUITES PASSED" || echo "HARNESS: FAILURES (see FAIL lines above)"
exit $rc
