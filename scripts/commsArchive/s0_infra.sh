#!/bin/bash
# s0_infra.sh — comms archive S0 infrastructure, run by hand in Cloud Shell.
# Design: ref/COMMS_ARCHIVE_DESIGN.md §4 (bucket, IAM, signing). Result: ref/INFRA_GCP.md.
#
# Upload this file to Cloud Shell, then run one stage at a time. Each stage ends with ONE
# line that says GO or NO-GO and names the next command. Every stage can be run again:
# it reads what already exists and carries on from there (also after Ctrl-C).
#
#   bash ~/s0_infra.sh precheck   read-only: lists every problem, changes nothing
#   bash ~/s0_infra.sh bucket     creates gs://lsg-yc-comms-archive exactly as specified
#   bash ~/s0_infra.sh iam        object access for the app's service account on that bucket
#                                 only; it may sign URLs as itself; IAM Credentials API on
#   bash ~/s0_infra.sh env        COMMS_ARCHIVE_BUCKET on svpcac: a new revision with no
#                                 traffic, proven on its own URL, then traffic moves to it
#   bash ~/s0_infra.sh verify     checks all of the above by effect; keeps a probe object
#   bash ~/s0_infra.sh status     read-only: where everything stands, and the next command
#   bash ~/s0_infra.sh calibrate  read-only: svpcac's configuration WITHOUT variable values,
#                                 for the harness that dry-runs this script
#
#   bash ~/s0_infra.sh rollback [env|iam|bucket]   undo, newest first (no word = all three).
#                                 Refuses if the bucket holds anything but the probe object.
#
# Each run writes its output to ~/s0_<stage>.log and appends it to ~/s0_all.log.
# Nothing in here is secret: every name below is already in ref/INFRA_GCP.md.

set -u
# Stages this copy refuses to run (the read-only stages ship first, alone). Empty = all released.
HOLD=""
P=lsg-api-425223; PN=618099140949; R=us-east1; SVC=svpcac
B=lsg-yc-comms-archive; SA=$PN-compute@developer.gserviceaccount.com
CONN=$P:$R:yc-mysql; VAR=COMMS_ARCHIVE_BUCKET; TAG=s0env
ROLE_OBJ=roles/storage.objectUser; NEED_PERMS="storage.objects.create storage.objects.get storage.objects.list storage.objects.delete"; ROLE_TC=roles/iam.serviceAccountTokenCreator; API_IC=iamcredentials.googleapis.com
PROBE=_s0/probe.txt
PROBE_TEXT='YisraCase comms archive S0 probe object. Not client data. Kept on purpose: the post-S1a signing check reads it, and delete detection skips the _s0/ prefix. See ref/INFRA_GCP.md.'
CMD=${1:-status}; ARG2=${2:-}
# Harness seams (unset in Cloud Shell): where anonymous / signed-URL requests go, and wait lengths.
GCS_PUBLIC=${S0_GCS_PUBLIC:-}; LOG_WAIT=${S0_LOG_WAIT:-300}; POLL=${S0_POLL:-15}; APP_WAIT=${S0_APP_WAIT:-120}; SIGN_WAIT=${S0_SIGN_WAIT:-180}; TDIV=${S0_TIMEOUT_DIV:-1}
# Boot-log lines that make a revision NOT clean (the app's own failure lines, and Cloud Run's).
# Every production boot runs the field-def reconcile, which connects to the database: a broken
# Cloud SQL socket shows as its "could not get a connection" line (ENOENT /cloudsql/…).
DIRTY='\[db\] connection failed|MySQL pool error|\[fieldDefReconciler\] boot: (could not get a connection|FAILED|unexpected error)|uncaughtException|unhandledRejection|Unhandled rejection|ECONNREFUSED|ENOENT|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|EADDRINUSE|ER_ACCESS_DENIED|Access denied for user|Container called exit|STARTUP TCP probe failed'

export CLOUDSDK_CORE_PROJECT=$P CLOUDSDK_CORE_DISABLE_PROMPTS=1
TMP=$(mktemp -d); ERR=$TMP/err
nogo() { NOGO=$1; }   # the line printed if the stage stops early
nogo ""

# gcloud with a time limit, stdin closed; its stderr kept in $ERR (shown with `showerr`).
# Its stdout goes to a file too, printed once it ends: when the limit kills gcloud, its
# `gcloud storage` worker processes outlive it, and any pipe they inherited (the log tee, a
# $(…)) would then never close — the stage would print NO-GO and hang. Files they may keep.
g()       { local t=$(( $1 / TDIV )) rc; [ $t -ge 1 ] || t=1
            timeout --foreground "$t" gcloud "${@:2}" </dev/null >"$TMP/gout" 2>"$ERR"; rc=$?
            cat "$TMP/gout"; return $rc; }
showerr() { [ -s "$ERR" ] && sed 's/^/    | /' "$ERR" | tail -15; return 0; }
timedout(){ [ "$1" = 124 ] && echo "    (no answer within the time limit)"; return 0; }
say()     { echo; echo "--- $*"; }
stop()    { echo; echo "STOP: $*"; exit 1; }
FAILS=0
bad()     { echo "  PROBLEM: $*"; FAILS=$((FAILS+1)); }
ok()      { echo "  ok: $*"; }
note()    { echo "  note: $*"; }
pub()     {  # the public URL for a storage URL (identity in Cloud Shell)
  local u=$1; [ -z "$GCS_PUBLIC" ] && { printf '%s' "$u"; return; }
  local h=${GCS_PUBLIC#*://}
  u=$(printf '%s' "$u" | sed -E "s#^https://([a-z0-9._-]+)\.storage\.googleapis\.com/#${GCS_PUBLIC%%://*}://\1.$h/#; s#^https://storage\.googleapis\.com/#$GCS_PUBLIC/#")
  printf '%s' "$u"
}

# ── reading the live state ────────────────────────────────────────────────────
# bucket_state → BSTATE = present | absent | taken | unknown ; $TMP/bucket.json when present
bucket_state() {
  local rc; g 60 storage buckets describe "gs://$B" --raw --format=json > "$TMP/bucket.json"; rc=$?
  if [ $rc = 0 ] && jq -e '.name' "$TMP/bucket.json" >/dev/null 2>&1; then BSTATE=present
  elif grep -qE 'not found: 404|NotFoundException|404' "$ERR"; then BSTATE=absent
  elif grep -qE '403|does not have storage.buckets.get|AccessDenied|Forbidden' "$ERR"; then BSTATE=taken
  else BSTATE=unknown; timedout $rc; fi
}

# Prints one line per field that is not as specified (empty output = correct).
bucket_wrong() {
  jq -r '
    def chk(f; got; want): if got == want then empty else "\(f): is \(got|tojson), must be \(want|tojson)" end;
    chk("location"; .location; "US-EAST1"),
    chk("locationType"; .locationType; "region"),
    chk("default storage class"; .storageClass; "ARCHIVE"),
    chk("uniform bucket-level access"; (.iamConfiguration.uniformBucketLevelAccess.enabled // false); true),
    chk("public access prevention"; (.iamConfiguration.publicAccessPrevention // "inherited"); "enforced"),
    chk("soft delete (seconds)"; ((.softDeletePolicy.retentionDurationSeconds // "0") | tostring); "2592000"),
    chk("retention policy"; (.retentionPolicy // null); null),
    chk("object retention"; (.objectRetention.mode // null); null),
    chk("lifecycle rules"; ((.lifecycle.rule // []) | length); 0),
    chk("versioning"; (.versioning.enabled // false); false),
    chk("encryption key (CMEK)"; (.encryption.defaultKmsKey // null); null),
    chk("autoclass"; (.autoclass.enabled // false); false),
    chk("requester pays"; (.billing.requesterPays // false); false)
  ' "$TMP/bucket.json"
}

bucket_policy() { g 60 storage buckets get-iam-policy "gs://$B" --format=json > "$TMP/bpol.json" && jq -e . "$TMP/bpol.json" >/dev/null 2>&1; }
sa_policy()     { g 60 iam service-accounts get-iam-policy "$SA" --format=json > "$TMP/sapol.json" && jq -e . "$TMP/sapol.json" >/dev/null 2>&1; }
# has_binding FILE ROLE MEMBER → unconditional binding present
has_binding()   { jq -e --arg r "$2" --arg m "$3" 'any(.bindings[]?; .role == $r and (.condition == null) and any(.members[]; . == $m))' "$1" >/dev/null; }
public_members(){ jq -r '[.bindings[]? | select(any(.members[]; . == "allUsers" or . == "allAuthenticatedUsers")) | .role] | join(", ")' "$TMP/bpol.json"; }
sa_other_roles(){ jq -r --arg m "serviceAccount:$SA" --arg r "$ROLE_OBJ" '[.bindings[]? | select(.role != $r and any(.members[]; . == $m)) | .role] | join(", ")' "$TMP/bpol.json"; }
api_enabled()   { g 120 services list --enabled --format='value(config.name)' > "$TMP/apis.txt" && grep -qx "$1" "$TMP/apis.txt"; }

svc_json()  { g 60 run services describe $SVC --region=$R --format=json > "$TMP/svc.json" && jq -e '.metadata.name' "$TMP/svc.json" >/dev/null 2>&1; }
rev_json()  { g 60 run revisions describe "$1" --region=$R --format=json > "$TMP/rev_$1.json" && jq -e '.metadata.name' "$TMP/rev_$1.json" >/dev/null 2>&1; }
sj()        { jq -r "$@" "$TMP/svc.json"; }
# traffic shape: follows | pinned_ours | other
traffic_shape() {
  sj --arg t "$TAG" '
    (.spec.traffic // []) as $tr
    | if ([$tr[] | select((.percent // 0) > 0)] | length) == 1 and any($tr[]; .latestRevision == true and .percent == 100) then "follows"
      elif ([$tr[] | select((.percent // 0) > 0)] | length) == 1 and any($tr[]; (.revisionName // "") != "" and .percent == 100) and any($tr[]; .tag == $t) then "pinned_ours"
      else "other" end'
}
serving_rev() { sj '[.status.traffic[]? | select(.percent == 100) | .revisionName][0] // ""'; }
tag_rev()     { sj --arg t "$TAG" '[.status.traffic[]? | select(.tag == $t) | .revisionName][0] // ""'; }
tag_url()     { sj --arg t "$TAG" '[.status.traffic[]? | select(.tag == $t) | .url][0] // ""'; }
has_tag()     { [ "$(sj --arg t "$TAG" 'any(.spec.traffic[]?; .tag == $t)')" = true ]; }
tmpl_var()    { sj --arg v "$VAR" '[.spec.template.spec.containers[0].env[]? | select(.name == $v) | .value][0] // ""'; }
rev_var()     { jq -r --arg v "$VAR" '[.spec.containers[0].env[]? | select(.name == $v) | .value][0] // ""' "$TMP/rev_$1.json"; }
rev_ready()   { [ "$(jq -r '[.status.conditions[]? | select(.type == "Ready") | .status][0] // ""' "$TMP/rev_$1.json")" = True ]; }

builds_ongoing() {  # prints running build ids (trigger lives in global; us-east1 too in case it moves)
  local loc out=""
  for loc in global $R; do
    g 60 builds list --ongoing --region=$loc --format='value(id)' > "$TMP/builds.txt" || { echo "UNKNOWN"; return; }
    out="$out$(cat "$TMP/builds.txt")"
  done
  printf '%s' "$out"
}

# ── precheck / status ─────────────────────────────────────────────────────────
survey() {  # read-only; sets NEXT (and RESUME when an env stage was cut short); counts FAILS
  NEXT=""; RESUME=""
  say "tools and identity"
  local t; for t in gcloud jq curl timeout openssl; do command -v $t >/dev/null 2>&1 && ok "$t" || bad "$t is not installed"; done
  note "$(gcloud version 2>/dev/null </dev/null | head -1)"
  local acct; acct=$(gcloud config get-value account 2>/dev/null </dev/null)
  [ -n "$acct" ] && ok "signed in as $acct" || bad "no active gcloud account (gcloud auth login)"
  local pn; pn=$(g 60 projects describe $P --format='value(projectNumber)')
  [ "$pn" = "$PN" ] && ok "project $P is number $PN" || { bad "could not confirm project $P (got '${pn}')"; showerr; }
  if g 60 projects get-iam-policy $P --format=json > "$TMP/ppol.json"; then
    jq -e --arg m "user:$acct" 'any(.bindings[]?; .role == "roles/owner" and any(.members[]; . == $m))' "$TMP/ppol.json" >/dev/null \
      && ok "$acct is a project Owner" || note "$acct is not a project Owner: the iam stage needs setIamPolicy on the bucket and on the service account"
    jq -e --arg m "serviceAccount:$SA" 'any(.bindings[]?; .role == "roles/editor" and any(.members[]; . == $m))' "$TMP/ppol.json" >/dev/null \
      && note "the service account holds roles/editor on the project (so it can already reach every bucket); the bucket grant below is what remains if that is ever removed"
  else bad "could not read the project IAM policy"; showerr; fi

  say "APIs"
  if g 120 services list --enabled --format='value(config.name)' > "$TMP/apis.txt"; then
    for t in storage.googleapis.com iam.googleapis.com run.googleapis.com cloudbuild.googleapis.com logging.googleapis.com; do
      grep -qx $t "$TMP/apis.txt" && ok "$t enabled" || bad "$t is not enabled"; done
    grep -qx $API_IC "$TMP/apis.txt" && ok "$API_IC enabled" || note "$API_IC is off — the iam stage enables it"
  else bad "could not list the enabled APIs"; showerr; fi

  say "service account $SA"
  if g 60 iam service-accounts describe "$SA" --format=json > "$TMP/sa.json"; then
    [ "$(jq -r '.disabled // false' "$TMP/sa.json")" = false ] && ok "exists and is enabled" || bad "the service account is DISABLED"
  else bad "the service account does not exist or cannot be read"; showerr; fi

  say "bucket gs://$B"
  bucket_state; local bwrong=""
  case $BSTATE in
    absent)  ok "does not exist yet — the bucket stage creates it"; NEXT=${NEXT:-bucket} ;;
    taken)   bad "the name is taken by ANOTHER project (describe answers 403). Stop and choose a new name with the manager"; showerr ;;
    unknown) bad "could not read the bucket"; showerr ;;
    present)
      bwrong=$(bucket_wrong)
      if [ -z "$bwrong" ]; then ok "exists, every field as specified"
      else printf '%s\n' "$bwrong" | while IFS= read -r l; do echo "  PROBLEM: exists but $l"; done; FAILS=$((FAILS + $(printf '%s\n' "$bwrong" | grep -c .))); fi ;;
  esac
  if [ "$BSTATE" = present ]; then
    if bucket_policy; then
      has_binding "$TMP/bpol.json" $ROLE_OBJ "serviceAccount:$SA" && ok "$ROLE_OBJ granted to the service account" || { note "the service account has no $ROLE_OBJ on the bucket yet"; NEXT=${NEXT:-iam}; }
      [ -z "$(public_members)" ] || bad "public members on the bucket in: $(public_members)"
      [ -z "$(sa_other_roles)" ] || bad "the service account holds other roles on the bucket: $(sa_other_roles) (only $ROLE_OBJ is specified)"
    else bad "could not read the bucket IAM policy"; showerr; fi
    g 60 storage objects describe "gs://$B/$PROBE" --format='value(name)' >/dev/null && ok "probe object $PROBE present" || note "no probe object yet — verify uploads it"
  fi

  say "signing"
  if sa_policy; then
    has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA" && ok "the service account may sign as itself ($ROLE_TC on itself)" || { note "the service account cannot sign as itself yet"; NEXT=${NEXT:-iam}; }
  else bad "could not read the service account's IAM policy"; showerr; fi
  grep -qx $API_IC "$TMP/apis.txt" 2>/dev/null || NEXT=${NEXT:-iam}

  say "Cloud Run service $SVC"
  if svc_json; then
    local shape; shape=$(traffic_shape)
    case $shape in
      follows)     ok "100% of traffic follows LATEST ($(serving_rev))" ;;
      pinned_ours) bad "traffic is PINNED to $(serving_rev) by an unfinished env stage (tag $TAG on $(tag_rev)): Cloud Build deploys get no traffic until it ends. Run: bash ~/s0_infra.sh env"; RESUME=env ;;
      *)           bad "traffic is not '100% LATEST': $(sj -c '.spec.traffic')" ;;
    esac
    [ "$(sj '.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"] // ""')" = "$CONN" ] && ok "Cloud SQL attachment $CONN on the template" || bad "the template does not carry the Cloud SQL attachment $CONN"
    [ "$(sj '.status.latestReadyRevisionName')" = "$(sj '.status.latestCreatedRevisionName')" ] || note "the newest revision $(sj '.status.latestCreatedRevisionName') is not ready (serving: $(sj '.status.latestReadyRevisionName'))"
    local v; v=$(tmpl_var)
    if [ "$v" = "$B" ]; then ok "$VAR=$B on the template"
    elif [ -z "$v" ]; then note "$VAR is not set yet — the env stage sets it"; NEXT=${NEXT:-env}
    else bad "$VAR is set to '$v', not '$B'"; fi
    has_tag && [ "$shape" = follows ] && { note "a leftover '$TAG' tag is on the service; the env stage removes it"; RESUME=env; }
  else bad "could not read the service $SVC"; showerr; fi

  say "Cloud Build"
  local bl; bl=$(builds_ongoing)
  case "$bl" in "") ok "no build running" ;; UNKNOWN) bad "could not list Cloud Builds"; showerr ;; *) note "a build is running ($bl): the env stage waits for it to end";; esac
  NEXT=${RESUME:-${NEXT:-verify}}
}

precheck() {
  nogo "PRECHECK — could not finish — NO-GO. Nothing was changed."
  survey
  echo
  if [ "$FAILS" = 0 ]; then nogo ""; echo "PRECHECK OK — nothing was changed — GO. Next: bash ~/s0_infra.sh $NEXT"
  else nogo ""; echo "PRECHECK: $FAILS problem(s) above — nothing was changed — NO-GO. Send this log to the manager."; exit 1; fi
}

status() {
  nogo "STATUS — could not finish (read-only, nothing was changed)."
  survey; nogo ""
  echo
  if [ "$FAILS" = 0 ] && [ -z "$RESUME" ]; then echo "STATUS — read-only, nothing was changed; no problems — GO. Next: bash ~/s0_infra.sh $NEXT"
  elif [ -n "$RESUME" ]; then echo "STATUS — read-only, nothing was changed; an env stage was cut short — NO-GO. Next: bash ~/s0_infra.sh $RESUME (it carries on from where it stopped)"; exit 1
  else echo "STATUS — read-only, nothing was changed; $FAILS problem(s) above — NO-GO. Send this log to the manager."; exit 1; fi
}

# ── calibrate ─────────────────────────────────────────────────────────────────
# Prints svpcac and its serving revision with every variable VALUE removed (names kept),
# plus the serving revision's boot lines with the database and account names masked.
# A second pass masks any value that slipped through, so this log is safe to pass on.
calibrate() {
  nogo "CALIBRATE — could not finish (read-only, nothing was changed). Rerun: bash ~/s0_infra.sh calibrate"
  svc_json || { showerr; stop "could not read $SVC"; }
  # values ref/INFRA_GCP.md §5 already publishes are left alone; every other value is masked if it shows up
  local public='["INSTANCE_CONNECTION_NAME","ENVIRONMENT","APP_URL","FIRM_TIMEZONE","EMAIL_DOMAIN","EMAIL_DOMAINS","IT_EMAIL","AUTO_EMAIL","FIRM_PHONE","FIRM_EMAIL","FIRM_URL","GCS_BUCKET","CLOUD_TASKS_LOCATION","CLOUD_TASKS_QUEUE","RINGCENTRAL_REDIRECT_URI","AITEST_ENABLED","COMMS_ARCHIVE_BUCKET"]'
  ( umask 077; jq -r --argjson pub "$public" '[.spec.template.spec.containers[]?.env[]? | select(.name as $n | $pub | index($n) | not) | .value // empty | select(length >= 4)] | .[]' "$TMP/svc.json" > "$TMP/values.txt" )
  local strip='del(.spec.template.spec.containers[]?.env[]?.value, .spec.template.spec.containers[]?.env[]?.valueFrom, .spec.containers[]?.env[]?.value, .spec.containers[]?.env[]?.valueFrom)'
  local R0; R0=$(serving_rev)
  {
    echo "== service $SVC (variable values removed)"; jq "$strip" "$TMP/svc.json"
    if [ -n "$R0" ] && rev_json "$R0"; then echo "== serving revision $R0 (variable values removed)"; jq "$strip" "$TMP/rev_$R0.json"
    else echo "== serving revision: could not read it"; fi
    echo "== boot lines of $R0 (database and account names masked)"
    g 120 logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SVC\" AND resource.labels.revision_name=\"$R0\"" \
        --freshness=30d --limit=2000 --format='value(textPayload)' > "$TMP/boot.log" || { echo "(could not read the log)"; showerr; }
    grep -E '^\[db|^\[dbReadonly|Server is running|^app build|^db ready|MySQL pool error' "$TMP/boot.log" \
      | sed -E 's/connected to [^@ ]*@/connected to <db>@/; s/ as [^ ]+$/ as <user>/' | sort | uniq -c | sort -rn | head -30
    echo "== lines the boot-log check would call failures: $(grep -cE "$DIRTY" "$TMP/boot.log" || true)"
    grep -E "$DIRTY" "$TMP/boot.log" | sed -E 's/[0-9]+/N/g' | cut -c1-160 | sort | uniq -c | sort -rn | head -15
    echo "== how gcloud reports a missing bucket"
    g 60 storage buckets describe "gs://$B" --raw --format=json >/dev/null && echo "(it exists)" || sed 's/^/    | /' "$ERR" | head -5
  } > "$TMP/cal.txt"
  python3 - "$TMP/values.txt" "$TMP/cal.txt" <<'PY'
import sys
vals = sorted({v for v in open(sys.argv[1]).read().split('\n') if len(v) >= 4}, key=len, reverse=True)
t = open(sys.argv[2]).read(); n = 0
for v in vals:
    if v in t: n += t.count(v); t = t.replace(v, '<value masked>')
open(sys.argv[2], 'w').write(t + '== second pass: %d leftover occurrence(s) of a variable value masked\n' % n)
PY
  rm -f "$TMP/values.txt"
  cat "$TMP/cal.txt"
  nogo ""; echo; echo "CALIBRATE DONE — read-only, nothing was changed — GO. Next: send ~/s0_calibrate.log to the manager"
}

# ── bucket ────────────────────────────────────────────────────────────────────
bucket() {
  nogo "BUCKET NOT DONE — NO-GO. Rerun: bash ~/s0_infra.sh bucket (it picks up from what exists)."
  say "1 is gs://$B there already?"
  bucket_state
  case $BSTATE in
    taken)   showerr; stop "the name gs://$B belongs to another project. Nothing was changed." ;;
    unknown) showerr; stop "could not read the bucket. Nothing was changed." ;;
    absent)
      say "2 create it: us-east1, Archive class, uniform access, public access prevented, soft delete 30 days"
      local rc
      g 180 storage buckets create "gs://$B" --project=$P --location=$R --default-storage-class=ARCHIVE \
        --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=30d; rc=$?
      showerr; timedout $rc
      bucket_state
      [ "$BSTATE" = present ] || stop "the bucket was not created (see above)." ;;
    present) echo "it exists; checking it rather than creating it" ;;
  esac
  say "3 every field, read back"
  local w; w=$(bucket_wrong)
  if [ -n "$w" ]; then
    printf '%s\n' "$w" | sed 's/^/  WRONG: /'
    nogo "BUCKET EXISTS BUT IS NOT AS SPECIFIED — NO-GO. Nothing was changed; it is not fixed automatically. Send this log to the manager."
    exit 1
  fi
  jq -r '"  location \(.location) · class \(.storageClass) · uniform access \(.iamConfiguration.uniformBucketLevelAccess.enabled) · public access prevention \(.iamConfiguration.publicAccessPrevention) · soft delete \(.softDeletePolicy.retentionDurationSeconds)s · no retention policy, no lifecycle, versioning off, Google-managed key"' "$TMP/bucket.json"
  nogo ""; echo; echo "BUCKET OK — gs://$B exists exactly as specified — GO. Next: bash ~/s0_infra.sh iam"
}

# ── iam ───────────────────────────────────────────────────────────────────────
iam() {
  nogo "IAM NOT DONE — NO-GO. Rerun: bash ~/s0_infra.sh iam (grants already made stay; it adds what is missing)."
  say "1 the bucket must exist exactly as specified"
  bucket_state; [ "$BSTATE" = present ] || stop "gs://$B is not there ($BSTATE). Run: bash ~/s0_infra.sh bucket"
  [ -z "$(bucket_wrong)" ] || stop "gs://$B is not as specified. Run: bash ~/s0_infra.sh bucket (it names the field)"
  say "2 $ROLE_OBJ on gs://$B for the service account (create / read / list / delete objects; nothing on any other bucket)"
  bucket_policy || { showerr; stop "could not read the bucket IAM policy"; }
  [ -z "$(sa_other_roles)" ] || stop "the service account already holds other roles on the bucket: $(sa_other_roles). Not changing anything; send this log to the manager."
  [ -z "$(public_members)" ] || stop "the bucket grants a public member ($(public_members)). Not changing anything."
  if has_binding "$TMP/bpol.json" $ROLE_OBJ "serviceAccount:$SA"; then echo "already granted"
  else
    local rc; g 120 storage buckets add-iam-policy-binding "gs://$B" --member="serviceAccount:$SA" --role=$ROLE_OBJ --format=none; rc=$?
    showerr; timedout $rc
    bucket_policy || { showerr; stop "could not read the bucket IAM policy back"; }
    has_binding "$TMP/bpol.json" $ROLE_OBJ "serviceAccount:$SA" || stop "the grant is not in the bucket's policy"
    echo "granted"
  fi
  say "3 $ROLE_TC for the service account on itself (V4 signed URLs with no key file)"
  sa_policy || { showerr; stop "could not read the service account's IAM policy"; }
  if has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA"; then echo "already granted"
  else
    local rc; g 120 iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=$ROLE_TC --condition=None --format=none; rc=$?
    showerr; timedout $rc
    sa_policy || { showerr; stop "could not read the service account's IAM policy back"; }
    has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA" || stop "the grant is not in the service account's policy"
    echo "granted"
  fi
  say "4 the IAM Credentials API (what signing calls)"
  local apinote="the IAM Credentials API enabled"
  if api_enabled $API_IC; then echo "already enabled"; apinote="the IAM Credentials API (already enabled)"
  else
    local rc; g 300 services enable $API_IC; rc=$?
    showerr; timedout $rc
    api_enabled $API_IC || stop "$API_IC is not enabled"
    echo "enabled"
  fi
  nogo ""; echo; echo "IAM OK — bucket access, self-signing and $apinote in place — GO. Next: bash ~/s0_infra.sh env"
}

# ── env (and its undo) ────────────────────────────────────────────────────────
# Template diff: everything except $VAR, the revision's own name/ids, gcloud's client
# stamps and the image tag → digest pin gcloud does on every update must be identical.
norm_rev() {  # $1 file; $2 $3: the old revision's image and its digest (gcloud pins the tag to the digest)
  jq -S --arg v "$VAR" --arg i "$2" --arg d "$3" '
    def dropk(p): with_entries(select(.key as $k | any(p[]; . as $x | $k | startswith($x)) | not));
    {annotations: ((.metadata.annotations // {}) | dropk(["run.googleapis.com/client-name","run.googleapis.com/client-version","run.googleapis.com/operation-id","serving.knative.dev/creator","serving.knative.dev/lastModifier"])),
     labels: ((.metadata.labels // {}) | dropk(["serving.knative.dev/","client.knative.dev/nonce","cloud.googleapis.com/location"])),
     spec: (.spec | .containers |= map(.env = ((.env // []) | map(select(.name != $v)) | sort_by(.name))
                                       | .image = (if .image == $d or .image == $i then "SAME IMAGE" else .image end)))}
    | walk(if type == "object" then with_entries(select(.value != null and .value != {} and .value != [])) else . end)' "$1"
}

envflow() {  # $1 = set | unset
  local mode=$1 want; [ "$mode" = set ] && want=$B || want=""
  nogo "ENV NOT DONE — NO-GO. Nothing was changed. Rerun: bash ~/s0_infra.sh env"
  [ "$mode" = unset ] && nogo "ROLLBACK OF ENV NOT DONE — NO-GO. Nothing was changed by it. Rerun: bash ~/s0_infra.sh rollback env"
  local what; [ "$mode" = set ] && what="$VAR=$B" || what="$VAR removed"
  echo "env ($what on $SVC). DO NOT push to main until this stage ends — it refuses to start while a Cloud Build runs, and checks again before moving traffic."
  say "1 no Cloud Build may be running"
  local bl; bl=$(builds_ongoing)
  [ "$bl" = UNKNOWN ] && { showerr; stop "could not list Cloud Builds. Nothing was changed."; }
  [ -z "$bl" ] || stop "a Cloud Build is running ($bl). Wait until it has finished and deployed, then rerun. Nothing was changed."
  echo "none"
  if [ "$mode" = set ]; then
    say "1b the bucket it names must exist exactly as specified"
    bucket_state; [ "$BSTATE" = present ] || stop "gs://$B is not there ($BSTATE). Run: bash ~/s0_infra.sh bucket. Nothing was changed."
    [ -z "$(bucket_wrong)" ] || stop "gs://$B is not as specified. Run: bash ~/s0_infra.sh bucket (it names the field). Nothing was changed."
    echo "it does"
  fi
  say "2 the service as it is"
  svc_json || { showerr; stop "could not read $SVC. Nothing was changed."; }
  local shape O N; shape=$(traffic_shape); O=$(serving_rev)
  echo "traffic: $shape · serving $O · latest ready $(sj '.status.latestReadyRevisionName') · $VAR='$(tmpl_var)'"
  [ "$(sj '.spec.template.metadata.annotations["run.googleapis.com/cloudsql-instances"] // ""')" = "$CONN" ] || stop "the template has no Cloud SQL attachment $CONN — not what INFRA_GCP describes. Nothing was changed."
  case $shape in
    follows)
      if [ "$(tmpl_var)" = "$want" ] && [ "$(sj '.status.latestReadyRevisionName')" = "$(sj '.status.latestCreatedRevisionName')" ] && [ "$O" = "$(sj '.status.latestReadyRevisionName')" ]; then
        if has_tag; then
          say "already serving it; removing the leftover '$TAG' tag"
          local rc; g 600 run services update-traffic $SVC --region=$R --remove-tags=$TAG; rc=$?; showerr; timedout $rc
          svc_json && ! has_tag || stop "the '$TAG' tag is still there"
        fi
        env_done "$SVC already serves $O with $what, traffic follows LATEST"; return 0
      fi ;;
    pinned_ours) echo "an earlier env run stopped after pinning traffic to $O; carrying on from there" ;;
    *) stop "traffic is not in a shape this script handles: $(sj -c '.spec.traffic'). Nothing was changed." ;;
  esac
  [ -n "$O" ] || stop "could not tell which revision serves traffic. Nothing was changed."

  nogo "ENV NOT DONE — NO-GO. Production still serves $O, unchanged, but traffic is PINNED to it: Cloud Build deploys get no traffic until this ends. Rerun: bash ~/s0_infra.sh env (it carries on). To back out instead: bash ~/s0_infra.sh rollback env"
  [ "$mode" = unset ] && nogo "ROLLBACK OF ENV NOT DONE — NO-GO. Production still serves $O, unchanged, but traffic is PINNED to it: Cloud Build deploys get no traffic until this ends. Rerun: bash ~/s0_infra.sh rollback env"
  N=$(tag_rev)
  if [ "$shape" = pinned_ours ] && [ -n "$N" ] && rev_json "$N" && rev_ready "$N" && [ "$(rev_var "$N")" = "$want" ]; then
    say "3 the new revision $N already exists (no traffic); not deploying again"
  else
    say "3 a new revision with $what, NO traffic, tag '$TAG' (a few minutes)"
    local envflag; [ "$mode" = set ] && envflag="--update-env-vars=$VAR=$B" || envflag="--remove-env-vars=$VAR"
    local rc; g 900 run services update $SVC --region=$R "$envflag" --no-traffic --tag=$TAG; rc=$?
    showerr; timedout $rc
    svc_json || { showerr; stop "could not read $SVC back"; }
    [ "$(traffic_shape)" = pinned_ours ] || stop "traffic is not pinned to the old revision as expected: $(sj -c '.spec.traffic')"
    O=$(serving_rev); N=$(tag_rev)
    [ -n "$N" ] && [ "$N" != "$O" ] || stop "no new revision under the '$TAG' tag"
    rev_json "$N" || { showerr; stop "could not read revision $N"; }
    rev_ready "$N" || stop "the new revision $N did not become ready: $(jq -r '[.status.conditions[]? | select(.type=="Ready") | .message][0] // ""' "$TMP/rev_$N.json")"
  fi
  echo "serving (unchanged): $O · new, no traffic: $N"

  say "4 $N differs from $O ONLY by $VAR"
  rev_json "$O" || { showerr; stop "could not read revision $O"; }
  [ "$(rev_var "$N")" = "$want" ] || stop "$N has $VAR='$(rev_var "$N")', expected '$want'"
  local img dig; img=$(jq -r '.spec.containers[0].image // ""' "$TMP/rev_$O.json"); dig=$(jq -r '.status.imageDigest // ""' "$TMP/rev_$O.json")
  [ -n "$img" ] && [ -n "$dig" ] || stop "could not read $O's image and digest"
  norm_rev "$TMP/rev_$O.json" "$img" "$dig" > "$TMP/norm_O.json"; norm_rev "$TMP/rev_$N.json" "$img" "$dig" > "$TMP/norm_N.json"
  if ! diff "$TMP/norm_O.json" "$TMP/norm_N.json" > "$TMP/diff.txt"; then
    sed 's/^/    /' "$TMP/diff.txt" | head -40
    stop "$N differs from $O in more than $VAR (above). Traffic was NOT moved."
  fi
  [ "$(jq -r '.metadata.annotations["run.googleapis.com/cloudsql-instances"] // ""' "$TMP/rev_$N.json")" = "$CONN" ] || stop "$N lacks the Cloud SQL attachment"
  echo "identical apart from $VAR: image, service account, Cloud SQL attachment, scaling, every other variable"

  say "5 a real request to $N on its own URL answers as the app"
  local u code=""; u=$(tag_url); [ -n "$u" ] || stop "no URL for the '$TAG' tag"
  local t0=$SECONDS
  while :; do
    code=$(curl -s -m 30 -o "$TMP/app.out" -w '%{http_code}' "$u/api/cases" || true)
    [ "$code" = 401 ] && break
    [ $((SECONDS - t0)) -ge "$APP_WAIT" ] && break
    echo "  HTTP $code — waiting (cold start)"; sleep "$POLL"
  done
  echo "GET $u/api/cases -> HTTP $code $(head -c 80 "$TMP/app.out" 2>/dev/null)   (expect 401 {\"error\":\"Unauthorized\"})"
  [ "$code" = 401 ] && [ "$(jq -r '.error // ""' "$TMP/app.out" 2>/dev/null)" = Unauthorized ] || stop "$N did not answer as the app. Traffic was NOT moved."

  say "6 $N's boot log: started, no failure lines (its boot-time database work included)"
  local f="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$SVC\" AND resource.labels.revision_name=\"$N\""
  t0=$SECONDS
  while :; do
    g 90 logging read "$f" --freshness=2h --limit=1000 --format='value(textPayload)' > "$TMP/boot.log" || { showerr; : > "$TMP/boot.log"; }
    grep -q 'Server is running on port' "$TMP/boot.log" && break
    [ $((SECONDS - t0)) -ge "$LOG_WAIT" ] && break
    echo "  boot log not in yet — waiting"; sleep "$POLL"
  done
  echo "  $(grep -c . "$TMP/boot.log") line(s) read"
  grep -q 'Server is running on port' "$TMP/boot.log" || stop "no 'Server is running' line from $N within ${LOG_WAIT}s. Traffic was NOT moved."
  if grep -E "$DIRTY" "$TMP/boot.log" > "$TMP/dirty.txt"; then
    sed 's/^/    /' "$TMP/dirty.txt" | sort | uniq -c | head -20
    stop "$N's boot log has failure lines (above). Traffic was NOT moved."
  fi
  echo "  clean: started, and no failure line (the boot-time field reconcile reached the database)"

  say "7 no Cloud Build started meanwhile"
  bl=$(builds_ongoing)
  [ "$bl" = UNKNOWN ] && { showerr; stop "could not list Cloud Builds. Traffic was NOT moved."; }
  [ -z "$bl" ] || stop "a Cloud Build started ($bl). Traffic was NOT moved. Rerun once it has finished: it will deploy again from the new image."
  echo "none"

  say "8 traffic back to following LATEST ($N), tag removed"
  local rc; g 600 run services update-traffic $SVC --region=$R --to-latest --remove-tags=$TAG; rc=$?
  showerr; timedout $rc
  svc_json || { showerr; stop "could not read $SVC back"; }
  [ "$(traffic_shape)" = follows ] && ! has_tag || stop "traffic is not '100% LATEST, no tag': $(sj -c '.spec.traffic')"
  [ "$(serving_rev)" = "$N" ] || stop "LATEST is $(serving_rev), not $N"
  code=$(curl -s -m 30 -o "$TMP/app.out" -w '%{http_code}' "$(sj '.status.url')/api/cases" || true)
  echo "GET $(sj '.status.url')/api/cases -> HTTP $code   (expect 401)"
  [ "$code" = 401 ] || stop "the service URL does not answer as the app after the move. Back to the old revision NOW: gcloud run services update-traffic $SVC --region=$R --to-revisions=$O=100 — then tell the manager."
  env_done "$SVC serves $N with $what; traffic follows LATEST"
}
# envflow's last line: the stage's GO line, or (inside rollback) a progress line.
env_done() {
  if [ "$CMD" = env ]; then nogo ""; echo; echo "ENV OK — $1 — GO. Next: bash ~/s0_infra.sh verify"
  else echo "  env part done: $1"; fi
}
env_stage() { envflow set; }

# ── verify ────────────────────────────────────────────────────────────────────
verify() {
  nogo "VERIFY — could not finish — NO-GO. Nothing was changed except, at most, the probe object. Rerun: bash ~/s0_infra.sh verify"
  say "1 bucket fields"
  bucket_state; [ "$BSTATE" = present ] || stop "gs://$B is not there ($BSTATE)"
  local w; w=$(bucket_wrong); [ -z "$w" ] && ok "every field as specified" || { printf '%s\n' "$w" | sed 's/^/  PROBLEM: /'; FAILS=$((FAILS + $(printf '%s\n' "$w" | grep -c .))); }
  say "2 who may do what"
  if bucket_policy; then
    has_binding "$TMP/bpol.json" $ROLE_OBJ "serviceAccount:$SA" && ok "$ROLE_OBJ on gs://$B for the service account" || bad "the service account has no $ROLE_OBJ on gs://$B"
    [ -z "$(sa_other_roles)" ] && ok "no other bucket role for it" || bad "other bucket roles for the service account: $(sa_other_roles)"
    [ -z "$(public_members)" ] && ok "no public member in the bucket policy" || bad "public members in: $(public_members)"
  else bad "could not read the bucket policy"; showerr; fi
  if sa_policy; then has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA" && ok "the service account may sign as itself" || bad "no $ROLE_TC for the service account on itself"
  else bad "could not read the service account's policy"; showerr; fi
  local apiok=0; api_enabled $API_IC && { ok "$API_IC enabled"; apiok=1; } || bad "$API_IC is not enabled"
  # what the archive sweep's pre-flight requires (create, get, list) plus purge (delete)
  local p miss=""
  if g 60 iam roles describe $ROLE_OBJ --format=json > "$TMP/role.json"; then
    for p in $NEED_PERMS; do jq -e --arg p "$p" 'any(.includedPermissions[]?; . == $p)' "$TMP/role.json" >/dev/null || miss="$miss $p"; done
    [ -z "$miss" ] && ok "$ROLE_OBJ includes create, get, list and delete (Google's current definition)" || bad "$ROLE_OBJ lacks:$miss"
  else bad "could not read the definition of $ROLE_OBJ"; showerr; fi
  if [ $apiok = 1 ]; then
    local tok; tok=$(g 60 auth print-access-token --impersonate-service-account="$SA")
    if [ -n "$tok" ]; then
      local q=""; for p in $NEED_PERMS; do q="$q&permissions=$p"; done
      curl -s -m 30 -H "Authorization: Bearer $tok" -o "$TMP/perm.json" "$(pub "https://storage.googleapis.com/storage/v1/b/$B/iam/testPermissions?${q#&}")" || true
      tok=""; miss=""
      for p in $NEED_PERMS; do jq -e --arg p "$p" 'any(.permissions[]?; . == $p)' "$TMP/perm.json" >/dev/null 2>&1 || miss="$miss $p"; done
      [ -z "$miss" ] && ok "as the service account, on gs://$B: create, get, list, delete all allowed" || bad "as the service account, on gs://$B, NOT allowed:$miss"
    elif grep -qiE 'PERMISSION_DENIED|getAccessToken|iam.serviceAccounts|403' "$ERR"; then
      echo "  you cannot impersonate the service account — its effective-permission check is deferred to S1a's pre-flight: GO"
    else bad "could not get a token as the service account"; showerr; fi
  fi
  say "3 the service"
  if svc_json; then
    [ "$(traffic_shape)" = follows ] && ! has_tag && ok "traffic follows LATEST, no '$TAG' tag" || bad "traffic: $(sj -c '.spec.traffic')"
    [ "$(tmpl_var)" = "$B" ] && ok "$VAR=$B on the template" || bad "$VAR is '$(tmpl_var)' on the template"
    local L; L=$(sj '.status.latestReadyRevisionName')
    [ "$L" = "$(serving_rev)" ] && rev_json "$L" && [ "$(rev_var "$L")" = "$B" ] && ok "the serving revision $L has it" || bad "the serving revision does not carry $VAR=$B"
  else bad "could not read $SVC"; showerr; fi
  say "4 probe object gs://$B/$PROBE"
  printf '%s' "$PROBE_TEXT" > "$TMP/probe.txt"
  local md5; md5=$(openssl md5 -binary "$TMP/probe.txt" | base64)
  if g 60 storage objects describe "gs://$B/$PROBE" --raw --format=json > "$TMP/probe.json"; then
    [ "$(jq -r '.md5Hash' "$TMP/probe.json")" = "$md5" ] && ok "present, content as written" || bad "present but its content changed (md5 $(jq -r '.md5Hash' "$TMP/probe.json"), expected $md5)"
  elif grep -qE '404|not found' "$ERR"; then
    local rc; g 120 storage cp "$TMP/probe.txt" "gs://$B/$PROBE" --content-type=text/plain; rc=$?; timedout $rc
    if g 60 storage objects describe "gs://$B/$PROBE" --raw --format=json > "$TMP/probe.json" && [ "$(jq -r '.md5Hash' "$TMP/probe.json")" = "$md5" ]; then ok "uploaded (kept from now on)"
    else bad "could not upload the probe object"; showerr; fi
  else bad "could not read the probe object"; showerr; fi
  say "5 nobody outside gets in"
  local c1 c2
  c1=$(curl -s -m 30 -o "$TMP/anon.out" -w '%{http_code}' "$(pub "https://storage.googleapis.com/$B/$PROBE")" || true)
  c2=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$(pub "https://storage.googleapis.com/$B/")" || true)
  case $c1 in 401|403) ok "anonymous GET of the probe: HTTP $c1 (refused)";; *) bad "anonymous GET of the probe answered HTTP $c1 (must be 401 or 403)";; esac
  case $c2 in 401|403) ok "anonymous listing of the bucket: HTTP $c2 (refused)";; *) bad "anonymous listing answered HTTP $c2 (must be 401 or 403)";; esac
  say "6 a URL signed as the service account opens the probe; a tampered one does not"
  local SIGN=""
  if [ $apiok = 1 ] && g 120 storage sign-url "gs://$B/$PROBE" --impersonate-service-account="$SA" --duration=5m --format='value(signed_url)' > "$TMP/signed.txt"; then
    local su ts cs ct t0=$SECONDS; su=$(pub "$(head -1 "$TMP/signed.txt")")
    local sig nd; sig=${su#*[xX]-[gG]oog-[sS]ignature=}; sig=${sig%%&*}
    [ "${sig: -1}" = 0 ] && nd=1 || nd=0; ts=${su/$sig/${sig%?}$nd}
    while :; do  # a new grant can take a minute or two to reach storage
      cs=$(curl -s -m 30 -o "$TMP/signed.out" -w '%{http_code}' "$su" || true)
      [ "$cs" = 200 ] && break; [ $((SECONDS - t0)) -ge "$SIGN_WAIT" ] && break
      echo "  signed URL: HTTP $cs — waiting for the grant to propagate"; sleep "$POLL"
    done
    ct=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$ts" || true)
    [ "$cs" = 200 ] && cmp -s "$TMP/signed.out" "$TMP/probe.txt" && ok "signed URL (5 min, signed by the service account): HTTP 200, the probe's exact bytes" || bad "signed URL answered HTTP $cs (must be 200 with the probe's bytes)"
    [ "$ts" != "$su" ] && [ "$ct" = 403 ] && ok "same URL with one signature digit changed: HTTP 403" || bad "tampered signed URL answered HTTP $ct (must be 403)"
    SIGN="proven with your identity acting as the service account; the app-side proof follows after S1a"
  elif [ $apiok = 1 ] && grep -qiE 'PERMISSION_DENIED|getAccessToken|signBlob|iam.serviceAccounts|403' "$ERR"; then
    echo "  you cannot impersonate the service account — signing proof deferred to the post-S1a app check: GO"
    showerr; SIGN="deferred to the post-S1a app check (you cannot impersonate the service account)"
  elif [ $apiok = 1 ]; then bad "could not sign a URL"; showerr
  fi
  echo
  if [ "$FAILS" = 0 ]; then
    nogo ""; echo "VERIFY OK — bucket, access, signing ($SIGN) and env all as specified — GO. Next: none in this script; S0 infra is done (send this log to the manager)."
  else
    nogo ""; echo "VERIFY: $FAILS problem(s) above — NO-GO. Send this log to the manager."; exit 1
  fi
}

# ── rollback ──────────────────────────────────────────────────────────────────
rollback() {
  local parts; case "$ARG2" in "") parts="env iam bucket";; env|iam|bucket) parts=$ARG2;; *)
    echo "usage: bash ~/s0_infra.sh rollback [env|iam|bucket]"; echo; echo "ROLLBACK — unknown part '$ARG2' — NO-GO. Nothing was changed."; exit 2;; esac
  nogo "ROLLBACK NOT DONE — NO-GO. Rerun: bash ~/s0_infra.sh rollback $ARG2 (it carries on from what is left)."
  say "1 the bucket must hold nothing but the probe object (otherwise the archive is in use: refused)"
  bucket_state
  case $BSTATE in
    present)
      g 300 storage objects list "gs://$B" --format='value(name)' > "$TMP/objs.txt" || { showerr; stop "could not list the bucket. Nothing was changed."; }
      if grep -vqx "$PROBE" "$TMP/objs.txt"; then
        echo "  $(grep -vxc "$PROBE" "$TMP/objs.txt") object(s) besides the probe, e.g. $(grep -vx "$PROBE" "$TMP/objs.txt" | head -3 | tr '\n' ' ')"
        nogo "ROLLBACK REFUSED — the archive holds objects — NO-GO. Nothing was changed."; exit 1
      fi
      g 300 storage objects list "gs://$B" --soft-deleted --format='value(name)' > "$TMP/soft.txt" 2>/dev/null && [ -s "$TMP/soft.txt" ] \
        && echo "  note: $(grep -c . "$TMP/soft.txt") soft-deleted object(s) in it (restorable for 30 days; they go with the bucket)"
      echo "  empty apart from the probe" ;;
    absent) echo "  no bucket" ;;
    *) showerr; stop "could not read the bucket ($BSTATE). Nothing was changed." ;;
  esac
  local p
  for p in $parts; do
    case $p in
      env)
        say "env: $VAR off $SVC"
        envflow unset
        nogo "ROLLBACK NOT DONE — NO-GO. Rerun: bash ~/s0_infra.sh rollback $ARG2 (it carries on from what is left)." ;;
      iam)
        say "iam: the two grants"
        if [ "$BSTATE" = present ] && bucket_policy && has_binding "$TMP/bpol.json" $ROLE_OBJ "serviceAccount:$SA"; then
          g 120 storage buckets remove-iam-policy-binding "gs://$B" --member="serviceAccount:$SA" --role=$ROLE_OBJ --format=none || { showerr; stop "could not remove the bucket grant"; }
          bucket_policy && ! has_binding "$TMP/bpol.json" $ROLE_OBJ "serviceAccount:$SA" || stop "the bucket grant is still there"
          echo "  bucket grant removed"
        else echo "  no bucket grant"; fi
        sa_policy || { showerr; stop "could not read the service account's policy"; }
        if has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA"; then
          g 120 iam service-accounts remove-iam-policy-binding "$SA" --member="serviceAccount:$SA" --role=$ROLE_TC --condition=None --format=none || { showerr; stop "could not remove the self-signing grant"; }
          sa_policy && ! has_binding "$TMP/sapol.json" $ROLE_TC "serviceAccount:$SA" || stop "the self-signing grant is still there"
          echo "  self-signing grant removed"
        else echo "  no self-signing grant"; fi
        echo "  $API_IC is left enabled on purpose" ;;
      bucket)
        say "bucket: the probe, then gs://$B"
        if [ "$BSTATE" = present ]; then
          if grep -qx "$PROBE" "$TMP/objs.txt"; then g 120 storage rm "gs://$B/$PROBE" || { showerr; stop "could not delete the probe object"; }; echo "  probe deleted"; fi
          g 300 storage buckets delete "gs://$B" || { showerr; stop "could not delete the bucket"; }
          bucket_state; [ "$BSTATE" = absent ] || stop "the bucket is still there ($BSTATE)"
          echo "  bucket deleted"
        else echo "  no bucket"; fi ;;
    esac
  done
  nogo ""; echo; echo "ROLLED BACK ($parts) — GO. $API_IC is left enabled on purpose. Next: bash ~/s0_infra.sh status"
}

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

main() {
  trap "" PIPE   # if the terminal goes away, keep going
  # The traps write to fd 3, the stage's real output: a trap runs inside whatever redirection the
  # interrupted command had (e.g. `g … > file`), so a plain echo would land in that file, unseen.
  exec 3>&1
  trap 'rc=$?; rm -rf "$TMP"; if [ $rc -ne 0 ] && [ -n "$NOGO" ]; then echo >&3; echo "$NOGO" >&3; fi' EXIT
  trap 'echo >&3; echo "--- interrupted" >&3; exit 130' INT
  trap 'exit 129' HUP TERM
  echo "s0_infra.sh $CMD${ARG2:+ $ARG2} — $(date -u '+%Y-%m-%d %H:%M UTC') — $(sha256sum "$0" 2>/dev/null | cut -c1-12)"
  case " $HOLD " in *" $CMD "*)
    echo; echo "'$CMD' IS NOT RELEASED IN THIS COPY — NO-GO. Nothing was changed. This copy runs only: precheck, status, calibrate."; exit 1;; esac
  case "$CMD" in
    precheck) precheck ;;
    calibrate) calibrate ;;
    status)   status ;;
    bucket)   bucket ;;
    iam)      iam ;;
    env)      env_stage ;;
    verify)   verify ;;
    rollback) rollback ;;
  esac
}

case "$CMD" in
  precheck|status|calibrate|bucket|iam|env|verify|rollback) ;;
  *) usage; echo; echo "UNKNOWN COMMAND '$CMD' — NO-GO. Nothing was changed."; rm -rf "$TMP"; exit 2 ;;
esac
main 2>&1 | tee -i ~/s0_$CMD.log | tee -i -a ~/s0_all.log
exit ${PIPESTATUS[0]}
