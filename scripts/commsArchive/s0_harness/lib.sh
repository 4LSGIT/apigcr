# Sourced by the harness scripts. Starts the stub API on a free port and points the
# REAL gcloud at it through an isolated CLOUDSDK_CONFIG (never your own gcloud login).
set -u
HD=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT=${S0_SCRIPT:-$HD/../s0_infra.sh}
WORK=${S0_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/s0h.XXXXXX")}
PORT=${S0_PORT:-18600}
export CLOUDSDK_CONFIG=$WORK/gcloud HOME=$WORK/home
mkdir -p "$CLOUDSDK_CONFIG" "$HOME"
# S0_PATH_PREPEND: put Cloud Shell's tools first (bash 5, a given gcloud SDK's bin). run.sh checks bash.
[ -n "${S0_PATH_PREPEND:-}" ] && export PATH="$S0_PATH_PREPEND:$PATH"
# No coreutils timeout on PATH (macOS): build bin/timeout.c (a port of coreutils' semantics) into
# the work dir; the Python fallback is only for a machine without a C compiler.
if ! command -v timeout >/dev/null 2>&1; then
  mkdir -p "$WORK/bin"
  if cc -O2 -o "$WORK/bin/timeout" "$HD/bin/timeout.c" 2>/dev/null; then :; else cp "$HD/bin/timeout_fallback.py" "$WORK/bin/timeout"; chmod +x "$WORK/bin/timeout"; fi
  export PATH="$WORK/bin:$PATH"
fi
# Safety net: anything that tries to leave the machine goes to a dead proxy and fails.
export HTTPS_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9
export NO_PROXY=localhost,.localhost,127.0.0.1,::1 no_proxy=localhost,.localhost,127.0.0.1,::1
unset GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN_FILE CLOUDSDK_CORE_ACCOUNT CLOUDSDK_CORE_PROJECT
echo dummy-token-not-a-credential > "$WORK/token"
B=http://api.localhost:$PORT/
{
  printf '[core]\naccount = operator@example.com\nproject = lsg-api-425223\ndisable_usage_reporting = true\n'
  printf 'universe_domain = localhost\n'   # matches the overrides, so gcloud stays quiet about them (Cloud Shell has no such line)
  printf '[auth]\naccess_token_file = %s\n' "$WORK/token"
  printf '[component_manager]\ndisable_update_check = true\n'
  printf '[storage]\ngs_xml_endpoint_url = http://gcs.localhost:%s\n' $PORT   # signed-URL host (sign-url also probes it)
  printf '[api_endpoint_overrides]\n'
  for a in storage run iam iamcredentials cloudresourcemanager serviceusage logging cloudbuild; do printf '%s = %s\n' $a $B; done
} > "$WORK/gcloud.cfg"
# gcloud reads the active named configuration (a legacy top-level `properties` file is
# migrated once and then ignored), so write that directly.
mkdir -p "$CLOUDSDK_CONFIG/configurations"; rm -f "$CLOUDSDK_CONFIG/properties"
cp "$WORK/gcloud.cfg" "$CLOUDSDK_CONFIG/configurations/config_default"; printf default > "$CLOUDSDK_CONFIG/active_config"   # no newline: gcloud reads it verbatim
export S0_GCS_PUBLIC=http://gcs.localhost:$PORT
CTL=http://api.localhost:$PORT/__ctl

stub_up() {  # refuses a busy port, and checks that the stub answering is this run's own
  if curl -s -m 2 -o /dev/null "$CTL/state"; then echo "HARNESS: port $PORT is already in use (a stale stub?). Pick another S0_PORT."; return 1; fi
  python3 "$HD/stub.py" $PORT "$WORK/state.json" > "$WORK/stub.log" 2>&1 &
  echo $! > "$WORK/stub.pid"
  for i in $(seq 1 50); do
    [ "$(curl -s -m 2 "$CTL/whoami" | python3 -c 'import sys,json; print(json.load(sys.stdin)["statefile"])' 2>/dev/null)" = "$WORK/state.json" ] && return 0
    sleep 0.1; done
  echo "stub did not start: $(cat "$WORK/stub.log")"; return 1
}
stub_down() { [ -f "$WORK/stub.pid" ] && kill "$(cat "$WORK/stub.pid")" 2>/dev/null; rm -f "$WORK/stub.pid"; }
reset()  { curl -s -X POST "$CTL/reset" >/dev/null; }
faults() { [ "${SKIP:-0}" = 1 ] && return 0; curl -s -X POST --data-binary "$1" "$CTL/faults" >/dev/null; }
spy()    { [ "${SKIP:-0}" = 1 ] && return 0; curl -s -X POST --data-binary "$1" "$CTL/py" | grep -q '"ok"' || { echo "HARNESS: state edit failed: $1"; return 1; }; }
ev()     { curl -s -X POST --data-binary "$1" "$CTL/eval" | python3 -c 'import sys,json; v=json.load(sys.stdin)["v"]; print(v if isinstance(v,str) else json.dumps(v))'; }
