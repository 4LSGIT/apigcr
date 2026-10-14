# s0_harness — dry run for `scripts/commsArchive/s0_infra.sh`

```
bash scripts/commsArchive/s0_harness/run.sh          # every suite (~15 min); exits non-zero on any failed check
bash scripts/commsArchive/s0_harness/run.sh stages   # one suite: precheck | stages | interrupts
bash scripts/commsArchive/s0_harness/mutate.sh       # mutation check (~30 min): every mutant must be killed
```

Needs `gcloud`, `jq`, `curl`, `python3`, `openssl`, and **bash 5** first on `PATH` (Cloud Shell's;
macOS `/bin/bash` 3.2 handles a trapped Ctrl-C differently, so `run.sh` refuses it). No
credentials and no network: nothing here touches Google.

```
S0_PATH_PREPEND=/path/to/bash5/bin:/path/to/google-cloud-sdk/bin bash scripts/commsArchive/s0_harness/run.sh
```

Run it under the SDK version Cloud Shell has (a versioned archive from
`dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-<ver>-<os>-<arch>.tar.gz`,
unpacked anywhere; never touch the installed SDK) as well as your own: client-side checks
differ between versions. The `harness:` line at the top of the output names what ran.

## What it is

The CLAUDE.md rule for hand-run production operations: every command runs with its exact
text on a local harness before Fred types it, and every command that changes something
runs through the **real gcloud CLI against a stub API**, so gcloud's own client-side
logic runs (it refused `--clear-vpc-connector` on production after a stand-in had passed it).

| Real thing | Here |
|---|---|
| Storage JSON, IAM, IAM Credentials, Resource Manager, Service Usage, Logging, Cloud Build APIs | `stub.py` at `http://api.localhost:<port>/`, via gcloud's `api_endpoint_overrides/*` |
| Cloud Run v1 (regional) | the same stub: gcloud derives `us-east1-` + the override host, and `*.localhost` resolves locally |
| `storage.googleapis.com` (anonymous reads, signed URLs) | the stub at `gcs.localhost` / `<bucket>.gcs.localhost`; gcloud's `storage/gs_xml_endpoint_url` points signed URLs there |
| The app on the service URL and on tag URLs | the stub at `*.run.localhost`: the app's own `401 {"error":"Unauthorized"}`, and a boot log derived from the revision's real settings |
| Your gcloud login | an isolated `CLOUDSDK_CONFIG` with a dummy token file |
| `timeout` (macOS has none) | `bin/timeout.c`, compiled into the work dir when no real one is on `PATH` (`timeout_fallback.py` without a C compiler); mirrors coreutils 9.5 `src/timeout.c`: signals pass to the command, a signal death is re-raised (so bash runs its INT trap), expiry sends TERM and exits 124 |

Safety net: `lib.sh` sets `HTTPS_PROXY` to a dead port with `NO_PROXY` for `*.localhost`,
so anything that tries to leave the machine fails. That net caught `gcloud storage sign-url`
probing the real `<bucket>.storage.googleapis.com`, and the script's anonymous check briefly
doing the same, before either was rerouted.

## Calibration

The stub's service, revision and boot-log shapes are production's, from `s0_infra.sh
calibrate` run in Cloud Shell on 2026-10-14 (revision `svpcac-01718-5sd`; variable values
were never printed). What that changed: the template names the image by tag while the
revision holds the digest; the service carries `run.googleapis.com/build-*` and `runapps`
annotations, which every PUT must send back unchanged (asserted); production prints no
`[db] connected` line (development-only), so the database is evidenced at boot by the
field-def reconcile's absence of failure lines.

## Suites

- `suite_precheck.sh`: precheck, status and calibrate are read-only by effect (stub state
  identical before and after, and no mutating request in the call log); every problem is
  named; faults and hangs are reported, not fatal; calibrate prints no variable value.
  Run against the exact file, so the early-release `HOLD` line is tested too.
- `suite_stages.sh`: bucket, iam, env, verify, rollback. The happy path, a rerun of each
  stage (it must change nothing), and a fault at each failure point (fails, lands but its
  answer is lost, hangs, wrong pre-existing state). Each outcome is asserted on the stub's
  state, independently of the script's own read-back.
- `suite_interrupts.sh`: the whole sequence on a pseudo-terminal with the real waits and
  time limits, then Ctrl-C and a lost terminal in the middle of each stage, each followed
  by a rerun that finishes.
- `mutate.sh`: breaks one guard of the script at a time and reruns the scenarios that
  should catch it. A mutant that survives means the scenario does not test that guard.

Every run of the script inside a suite also asserts the house rule: the last line is one
GO or NO-GO line that agrees with the exit code. Each run has a watchdog (`S0_RUN_LIMIT`,
300 s): a stage that does not finish fails its scenario instead of stalling the suite.

Options: `S0_ONLY=<regex>` runs only matching scenarios; `S0_FAILDIR=<dir>` keeps the full
output and stub call log of every failing run; `S0_PORT` picks the stub's port (it refuses
one already in use); `S0_GATE=<script>` makes `mutate.sh` take a machine-wide slot per mutant.

## What it found in the script (each now has a scenario and a mutant)

- The env stage required a boot line production never prints (development-only).
- A Ctrl-C during a redirected gcloud call printed the closing lines into the redirect
  target: traps now write to fd 3.
- A timed-out `gcloud storage` call left worker processes holding the log pipe: the stage
  printed NO-GO and never returned. gcloud's stdout now goes to a file.
- Real-CLI facts the stand-in would not have known: gcloud pins the image tag to the
  revision's digest on update; retries a single 503 on bucket create, service PUT and
  bucket delete by itself; sends IAM etags back URL-safe; `sign-url` probes the URL it signs.

`HOLD`: the script refuses the stages named in its `HOLD` line. The read-only stages ship
first with the mutating ones held; `run.sh` tests the mutating suites on a copy with only
that line emptied (identical to the file once it is released).

## Not modelled (only provable on real Google)

IAM evaluation and propagation delay (the stub applies grants instantly and checks only
the signer's bucket grant when a signed URL is used); real V4 signature verification (the
stub accepts exactly the signatures its `signBlob` issued); Cloud Run's real revision
start, timing and controller-added annotations (`calibrate` output from production is
what the stub's service and revision shapes are checked against); Google's exact error
texts beyond the ones gcloud itself prints.

## Files

`stub.py` (the fake APIs; `/__ctl/*` is the harness control: reset, faults, state edits),
`lib.sh` (isolated gcloud config, stub start/stop), `t.sh` (assertions), `ptyrun.py`
(pseudo-terminal runner), `bin/timeout`, the suites, `run.sh`, `mutate.sh`.
