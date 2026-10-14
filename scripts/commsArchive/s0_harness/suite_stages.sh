#!/bin/bash
# bucket, iam, env, verify, rollback: the happy path, re-runs, and a fault at each failure point.
# Outcomes are asserted on the stub's own state (what Google would hold), not only on the
# script's words.
. "$(dirname "$0")/lib.sh"; . "$(dirname "$0")/t.sh"
[ -n "${S0_SHARED:-}" ] || { stub_up || exit 1; trap stub_down EXIT; }

BK="s['buckets']['lsg-yc-comms-archive']"
SAM="'serviceAccount:'+SA"
bucket_exact='b=s["buckets"]["lsg-yc-comms-archive"]["res"]; ic=b["iamConfiguration"]; out=(b["location"],b["storageClass"],ic["uniformBucketLevelAccess"]["enabled"],ic["publicAccessPrevention"],b["softDeletePolicy"]["retentionDurationSeconds"],"retentionPolicy" in b,"lifecycle" in b,b.get("versioning",{}).get("enabled",False),"encryption" in b)'
bucket_ok() { [ "$(st "$bucket_exact")" = '["US-EAST1", "ARCHIVE", true, "enforced", "2592000", false, false, false, false]' ]; }
grant_obj() { [ "$(st "[b['role'] for b in s['buckets']['lsg-yc-comms-archive']['policy'].get('bindings',[]) if 'serviceAccount:'+SA in b['members']]")" = '["roles/storage.objectUser"]' ]; }
grant_tc()  { [ "$(st "[b['role'] for b in s['sa']['policy'].get('bindings',[]) if 'serviceAccount:'+SA in b['members']]")" = '["roles/iam.serviceAccountTokenCreator"]' ]; }
api_on()    { [ "$(st "'iamcredentials.googleapis.com' in s['services_enabled']")" = true ]; }
proj_pol()  { st "s['project_policy']['bindings']"; }
# structural comparisons in Python (key order is not data: gcloud writes latestRevision before percent)
follows()   { [ "$(st "s['run']['spec']['traffic']==[{'percent':100,'latestRevision':True}]")" = true ]; }
serving()   { st "[t['revisionName'] for t in s['run']['status']['traffic'] if t.get('percent')==100][0]"; }
var_on()    { st "[e.get('value') for e in s['revisions'][s['run']['status']['latestReadyRevisionName']]['spec']['containers'][0]['env'] if e['name']=='COMMS_ARCHIVE_BUCKET']"; }
nrevs()     { st "len(s['revisions'])"; }
pinned_to() { [ "$(st "[t for t in s['run']['spec']['traffic'] if t.get('percent')==100]==[{'revisionName':'$1','percent':100}]")" = true ]; }
REV0N=""; rev0() { st "sorted(s['revisions'])[0]"; }
# independent template diff: the newest revision equals the first except the variable (and the image pin)
only_var_diff() { st "
import copy
r=sorted(s['revisions']); a=copy.deepcopy(s['revisions'][r[0]]['spec']); b=copy.deepcopy(s['revisions'][r[-1]]['spec'])
for x in (a,b):
  c=x['containers'][0]; c['env']=sorted([e for e in c['env'] if e['name']!='COMMS_ARCHIVE_BUCKET'], key=lambda e:e['name']); c['image']='IMG'; x.pop('nodeSelector',None)
out=a==b and s['revisions'][r[-1]]['metadata']['annotations'].get('run.googleapis.com/cloudsql-instances')==s['revisions'][r[0]]['metadata']['annotations'].get('run.googleapis.com/cloudsql-instances')" | tail -1; }
EOF_UNUSED=1

# ── bucket ──
scen "B1 bucket on a fresh project"
run bucket
check "GO names iam" 'lastm "BUCKET OK.*GO\. Next: bash ~/s0_infra.sh iam"'
check "stub holds the bucket exactly as specified" 'bucket_ok'
check "created once" '[ "$(grep -c "POST api.localhost/storage/v1/b?" "$WORK/calls.log")" = 1 ]'
snap before; run bucket
check "B1 rerun: GO" 'lastm "BUCKET OK"'; check "rerun creates nothing" '[ -z "$(mutations)" ]'; check "rerun changes nothing" same_state

scen "B2 bucket present but wrong (7-day soft delete): NO-GO, nothing changed, not fixed"
prep bucket; spy "$BK['res']['softDeletePolicy']['retentionDurationSeconds']='604800'"
readonly_run bucket
check "names the field" 'has "WRONG: soft delete (seconds)"'; check "NO-GO" 'lastm "IS NOT AS SPECIFIED — NO-GO"'

scen "B3 name taken by another project: NO-GO, nothing created"
spy "s['taken_elsewhere']=['lsg-yc-comms-archive']"; readonly_run bucket
check "NO-GO" 'lastm NO-GO'; check "says so" 'has "belongs to another project"'

scen "B4 create keeps failing (503; gcloud's own retries do not help): NO-GO; rerun GO"
faults '[{"match":"^POST api.localhost/storage/v1/b$","mode":"error","code":503,"count":-1}]'
run bucket; check "NO-GO" 'lastm NO-GO'; check "no bucket" '[ "$(st "list(s[\"buckets\"])")" = "[]" ]'
faults '[]'; run bucket; check "rerun GO" 'lastm "BUCKET OK"'; check "bucket exact" bucket_ok

scen "B4b one transient 503 on create: gcloud retries by itself, GO"
faults '[{"match":"^POST api.localhost/storage/v1/b$","mode":"error","code":503,"count":1}]'
run bucket; check "GO" 'lastm "BUCKET OK"'; check "two POSTs (the retry)" '[ "$(grep -c "POST api.localhost/storage/v1/b?" "$WORK/calls.log")" = 2 ]'

scen "B5 create succeeds but the answer is lost: same run notices and goes on"
faults '[{"match":"^POST api.localhost/storage/v1/b$","mode":"after","code":503,"count":1}]'
run bucket; check "GO" 'lastm "BUCKET OK"'; check "bucket exact" bucket_ok

scen "B6 create hangs past its time limit: NO-GO; rerun GO"
faults '[{"match":"^POST api.localhost/storage/v1/b$","mode":"hang","seconds":30,"count":1}]'
run bucket; check "NO-GO" 'lastm NO-GO'; check "time limit named" 'has "no answer within the time limit"'
run bucket; check "rerun GO" 'lastm "BUCKET OK"'

# ── iam ──
scen "I1 iam after bucket"
prep bucket; PP=$(proj_pol)
run iam
check "GO names env" 'lastm "IAM OK.*GO\. Next: bash ~/s0_infra.sh env"'
check "bucket: exactly objectUser for the SA" grant_obj
check "SA: exactly tokenCreator on itself" grant_tc
check "IAM Credentials API on" api_on
check "project policy untouched" '[ "$(proj_pol)" = "$PP" ]'
snap before; run iam
check "rerun GO" 'lastm "IAM OK"'; check "rerun changes nothing" '[ -z "$(mutations)" ] && same_state'

scen "I2 iam with no bucket: NO-GO, nothing changed"
readonly_run iam; check "points at bucket" 'has "Run: bash ~/s0_infra.sh bucket"'; check "NO-GO" 'lastm NO-GO'

scen "I3 the SA already holds objectAdmin on the bucket: NO-GO, nothing changed"
prep bucket; spy "$BK['policy']['bindings'].append({'role':'roles/storage.objectAdmin','members':[$SAM]})"
readonly_run iam; check "names it" 'has "already holds other roles on the bucket: roles/storage.objectAdmin"'

scen "I4 SA policy write fails: NO-GO with the bucket grant kept; rerun adds only what is missing"
prep bucket
faults '[{"match":"setIamPolicy","mode":"error","code":503,"count":-1}]'
run iam; check "NO-GO" 'lastm NO-GO'; check "bucket grant made" grant_obj; check "no self grant" '! grant_tc'
faults '[]'; run iam; check "rerun GO" 'lastm "IAM OK"'; check "self grant now" grant_tc
check "rerun did not touch the bucket policy" '! grep -q "PUT api.localhost/storage/v1/b/lsg-yc-comms-archive/iam" "$WORK/calls.log"'

scen "I5 bucket policy write applied but answer lost: read back, GO"
prep bucket
faults '[{"match":"^PUT api.localhost/storage/v1/b/lsg-yc-comms-archive/iam$","mode":"after","code":503,"count":1}]'
run iam; check "GO" 'lastm "IAM OK"'; check "grant there" grant_obj

scen "I6 API enable fails: NO-GO; rerun GO"
prep bucket
faults '[{"match":":enable$","mode":"error","code":500,"count":-1}]'
run iam; check "NO-GO" 'lastm NO-GO'; check "API still off" '! api_on'
faults '[]'; run iam; check "rerun GO" 'lastm "IAM OK"'; check "API on" api_on

# ── env ──
scen "E1 env: no-traffic revision, proven, then traffic moves"
prep bucket; prep iam; R0=$(rev0)
run env
check "GO names verify" 'lastm "ENV OK.*GO\. Next: bash ~/s0_infra.sh verify"'
check "caveat in the opening line" 'sed -n 2p "$OUT" | grep -q "DO NOT push to main until this stage ends"'
check "traffic follows LATEST, no tag" follows
check "serving a NEW revision" '[ "$(serving)" != "$R0" ]'
check "it carries the variable" '[ "$(var_on)" = "[\"lsg-yc-comms-archive\"]" ]'
check "stub-side diff: only the variable changed" '[ "$(only_var_diff)" = true ]'
check "exactly one new revision" '[ "$(nrevs)" = 2 ]'
check "every service PUT kept the build-* and runapps annotations unchanged" '[ "$(st "
a0={k:v for k,v in s[\"run\"][\"metadata\"][\"annotations\"].items() if k.startswith((\"run.googleapis.com/build-\",\"runapps.\"))}
out=len(a0)==7 and len(s.get(\"puts\",[]))>=2 and all({k:v for k,v in p[\"metadata\"][\"annotations\"].items() if k.startswith((\"run.googleapis.com/build-\",\"runapps.\"))}==a0 for p in s[\"puts\"])")" = true ]'
check "the tagged URL answered BEFORE traffic moved" 'a=$(grep -n "s0env---svpcac.run.localhost/api/cases" "$WORK/calls.log" | head -1 | cut -d: -f1); b=$(grep -n "^.* PUT us-east1-api.localhost/.*/services/svpcac" "$WORK/calls.log" | tail -1 | cut -d: -f1); [ -n "$a" ] && [ "$a" -lt "$b" ]'
check "build check ran twice (start, before the move)" '[ "$(grep -c "locations/global/builds" "$WORK/calls.log")" = 2 ]'
snap before; run env
check "E1 rerun: GO without a new revision" 'lastm "ENV OK" && [ "$(nrevs)" = 2 ] && [ -z "$(mutations)" ]'

scen "E2 a Cloud Build is running: refused before anything"
prep bucket; prep iam; spy "s['builds']=[{'id':'b-9','location':'global','status':'WORKING'}]"
readonly_run env; check "names it" 'has "a Cloud Build is running (b-9)"'; check "NO-GO says nothing changed" 'lastm "NO-GO. Nothing was changed"'

scen "E3 a build starts while the new revision is being proven: traffic NOT moved; rerun finishes without redeploying"
prep bucket; prep iam; R0=$(rev0)
spy "s['builds']=[{'id':'b-7','location':'global','status':'SUCCESS','starts_after_calls':1}]"
run env
check "NO-GO, traffic not moved" 'has "a Cloud Build started (b-7)" && lastm "PINNED to it"'
check "still pinned to the old revision" "pinned_to $R0"
spy "s['builds']=[]"
run env
check "rerun GO" 'lastm "ENV OK"'; check "no second deploy" '[ "$(nrevs)" = 2 ]'; check "follows" follows

scen "E4 the new revision fails to start: NO-GO, old one serves (pinned); rerun deploys again"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['revision_fails']=True"
run env
check "NO-GO" 'lastm NO-GO'; check "old revision serves" '[ "$(serving)" = "$R0" ]'
spy "s['flags']['revision_fails']=False"
run env
check "rerun GO" 'lastm "ENV OK"'; check "follows" follows; check "var on" '[ "$(var_on)" = "[\"lsg-yc-comms-archive\"]" ]'

scen "E5 the update loses the Cloud SQL attachment: diff refuses, traffic NOT moved"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['drop_cloudsql_on_update']=True"
run env
check "diff named" 'has "differs from" && has "run.googleapis.com/cloudsql-instances"'; check "pinned to old" "pinned_to $R0"

scen "E5b the update silently drops another variable (JWT_SECRET): only the diff can see it"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['drop_env_on_update']='JWT_SECRET'"
run env
check "diff named" 'has "differs from" && has "JWT_SECRET"'; check "pinned to old" "pinned_to $R0"

scen "E6 the boot log has a failure line: traffic NOT moved"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['dirty_log']='Unhandled rejection: Error: boom'"
run env
check "named" 'has "boot log has failure lines"'; check "pinned to old" "pinned_to $R0"

scen "E7 the boot-time database work fails (socket missing): traffic NOT moved"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['boot_without_socket']=True"
run env
check "named" 'has "boot log has failure lines" && has "could not get a connection"'; check "pinned to old" "pinned_to $R0"

scen "E7b the new revision never logs that it started: traffic NOT moved"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['boot_no_server_line']=True"
run env
check "named" "has \"no 'Server is running' line\""; check "pinned to old" "pinned_to $R0"

scen "E8 the new revision's URL does not answer as the app: traffic NOT moved"
prep bucket; prep iam; R0=$(rev0); spy "s['flags']['app_down_new']=True"
run env
check "named" 'has "did not answer as the app"'; check "pinned to old" "pinned_to $R0"

scen "E9 traffic pinned by someone else: refused, nothing changed"
prep bucket; prep iam; pin_other
readonly_run env; check "named" 'has "not in a shape this script handles"'

scen "E10 the traffic move keeps failing (gcloud retries one 503 by itself): NO-GO pinned; rerun moves it without redeploying"
prep bucket; prep iam; R0=$(rev0)
faults '[{"match":"^PUT us-east1-api.localhost/.*/services/svpcac$","mode":"error","code":503,"count":-1,"skip":1}]'
run env
check "NO-GO" 'lastm NO-GO'; check "pinned to old" "pinned_to $R0"
faults '[]'; run env
check "rerun GO" 'lastm "ENV OK"'; check "no second deploy" '[ "$(nrevs)" = 2 ]'; check "follows" follows

scen "E11 the traffic move applies but its answer is lost: same run confirms by reading back"
prep bucket; prep iam
faults '[{"match":"^PUT us-east1-api.localhost/.*/services/svpcac$","mode":"after","code":503,"count":1,"skip":1}]'
run env; check "GO" 'lastm "ENV OK"'; check "follows" follows

scen "E12 left with only the s0env tag (after the move): rerun removes it"
prep bucket; prep iam; prep env
spy "s['run']['spec']['traffic'].append({'revisionName': s['run']['status']['latestReadyRevisionName'], 'tag':'s0env'}); resolve(s)"
run env; check "GO" 'lastm "ENV OK"'; check "tag gone" follows; check "no deploy" '[ "$(nrevs)" = 2 ]'

scen "E13 the service URL fails after the move: NO-GO with the exact way back"
prep bucket; prep iam; R0=$(rev0)
faults '[{"match":"^GET svpcac.run.localhost/api/cases","mode":"error","code":503,"count":-1}]'
run env; check "names the command back" "has \"--to-revisions=$R0=100\""; check "NO-GO" 'lastm NO-GO'

# ── verify ──
scen "V1 verify after everything"
for x in bucket iam env; do prep $x; done
run verify
check "GO" 'lastm "VERIFY OK.*GO"'
PT=$(sed -n "s/^PROBE_TEXT='\(.*\)'\$/\1/p" "$SCRIPT")
check "probe stored, exactly the script's PROBE_TEXT" '[ -n "$PT" ] && [ "$(st "__import__(\"base64\").b64decode(s[\"buckets\"][\"lsg-yc-comms-archive\"][\"objects\"][\"_s0/probe.txt\"][\"data\"]).decode()")" = "$PT" ]'
check "anonymous refused (401)" 'has "anonymous GET of the probe: HTTP 401"'
check "signed 200 + tampered 403" 'has "HTTP 200, the probe" && has "one signature digit changed: HTTP 403"'
check "role definition covers create/get/list/delete" 'has "roles/storage.objectUser includes create, get, list and delete"'
check "effective permissions as the SA" 'has "as the service account, on gs://lsg-yc-comms-archive: create, get, list, delete all allowed"'
run verify
check "rerun GO, probe not re-uploaded, never deleted" 'lastm "VERIFY OK" && ! grep -q "/upload/" "$WORK/calls.log" && ! grep -q "^.* DELETE " "$WORK/calls.log"'

scen "V2 the probe was changed by someone: NO-GO"
for x in bucket iam env verify; do prep $x; done
spy "o=$BK['objects']['_s0/probe.txt']; o['data']='eA=='; o['meta']['md5Hash']='AAAA'"
run verify; check "named" 'has "present but its content changed"'; check "NO-GO" 'lastm NO-GO'

scen "V3 you cannot impersonate the SA: its own line, still GO"
for x in bucket iam env; do prep $x; done; spy "s['caller_can_impersonate']=False"
run verify
check "distinct line" 'has "you cannot impersonate the service account — signing proof deferred to the post-S1a app check: GO"'
check "GO" 'lastm "VERIFY OK.*deferred to the post-S1a app check"'
check "effective check deferred on its own line" 'has "its effective-permission check is deferred to S1a'"'"'s pre-flight: GO"'

scen "V4 bucket opened to the public (PAP off + allUsers): NO-GO"
for x in bucket iam env; do prep $x; done
spy "$BK['res']['iamConfiguration']['publicAccessPrevention']='inherited'; $BK['policy']['bindings'].append({'role':'roles/storage.objectViewer','members':['allUsers']})"
run verify
check "PAP named" 'has "public access prevention"'; check "public member named" 'has "public members in"'
check "anonymous 200 named" 'has "anonymous GET of the probe answered HTTP 200"'

scen "V5 the bucket grant was removed: the signed URL fails"
for x in bucket iam env; do prep $x; done
spy "$BK['policy']['bindings']=[b for b in $BK['policy']['bindings'] if b['role']!='roles/storage.objectUser']"
run verify; check "grant named" 'has "has no roles/storage.objectUser"'; check "signed URL named" 'has "signed URL answered HTTP 403"'

scen "V7 Google's objectUser no longer includes list: NO-GO naming it"
for x in bucket iam env; do prep $x; done
spy "s['flags']['role_override']={'roles/storage.objectUser':[p for p in __import__('json').load(open('/dev/null')) ] if False else ['storage.objects.create','storage.objects.get','storage.objects.delete','storage.objects.update']}"
run verify; check "role gap named" 'has "roles/storage.objectUser lacks: storage.objects.list"'; check "effective gap named" 'has "NOT allowed: storage.objects.list"'; check "NO-GO" 'lastm NO-GO'

scen "V8 the SA was given objectCreator instead of objectUser: NO-GO naming get, list, delete"
for x in bucket iam env; do prep $x; done
spy "[b.update(role='roles/storage.objectCreator') for b in $BK['policy']['bindings'] if b['role']=='roles/storage.objectUser']"
run verify; check "named" 'has "NOT allowed: storage.objects.get storage.objects.list storage.objects.delete"'; check "NO-GO" 'lastm NO-GO'

scen "V9 storage would accept a tampered signature: NO-GO"
for x in bucket iam env; do prep $x; done; spy "s['flags']['accept_any_signature']=True"
run verify; check "named" 'has "tampered signed URL answered HTTP 200"'; check "NO-GO" 'lastm NO-GO'

scen "V6 iamcredentials off and env not done: NO-GO, both named"
prep bucket; prep iam; spy "s['services_enabled'].remove('iamcredentials.googleapis.com')"
run verify; check "API named" 'has "iamcredentials.googleapis.com is not enabled"'; check "env named" "has \"COMMS_ARCHIVE_BUCKET is '' on the template\""

# ── rollback ──
scen "R1 rollback everything"
for x in bucket iam env verify; do prep $x; done; R1=$(serving)
run rollback
check "GO, says the API stays on" 'lastm "ROLLED BACK \(env iam bucket\) — GO\. iamcredentials.googleapis.com is left enabled on purpose"'
check "bucket gone" '[ "$(st "list(s[\"buckets\"])")" = "[]" ]'
check "self grant gone" '! grant_tc'; check "API still on" api_on
check "variable off, traffic follows" '[ "$(var_on)" = "[]" ] && follows'
check "via a proven new revision" '[ "$(serving)" != "$R1" ] && grep -q "s0env---svpcac.run.localhost/api/cases" "$WORK/calls.log"'
snap before; run rollback
check "rerun: GO, nothing to do" 'lastm "ROLLED BACK" && [ -z "$(mutations)" ]'

scen "R2 the archive holds an object: refused, nothing changed"
for x in bucket iam env verify; do prep $x; done
spy "$BK['objects']['phone/rec/2026/10/1-1.mp3']={'meta':{'name':'phone/rec/2026/10/1-1.mp3','contentType':'audio/mpeg','md5Hash':'x','generation':'1'},'data':''}"
readonly_run rollback
check "refused" 'lastm "ROLLBACK REFUSED — the archive holds objects — NO-GO"'

scen "R3 rollback env only"
for x in bucket iam env; do prep $x; done
run rollback env
check "GO" 'lastm "ROLLED BACK \(env\) — GO"'; check "variable off" '[ "$(var_on)" = "[]" ] && follows'
check "bucket and grants stay" 'bucket_ok && grant_obj && grant_tc'

scen "R4 bucket delete keeps failing (gcloud retries one 503 by itself): NO-GO; rerun finishes"
for x in bucket iam env verify; do prep $x; done
faults '[{"match":"^DELETE api.localhost/storage/v1/b/lsg-yc-comms-archive$","mode":"error","code":503,"count":-1}]'
run rollback; check "NO-GO" 'lastm NO-GO'
faults '[]'; run rollback; check "rerun GO" 'lastm "ROLLED BACK"'; check "bucket gone" '[ "$(st "list(s[\"buckets\"])")" = "[]" ]'

scen "R5 a build is running: rollback of env refused before it changes anything"
for x in bucket iam env; do prep $x; done; spy "s['builds']=[{'id':'b-5','location':'global','status':'QUEUED'}]"
readonly_run rollback
check "refused at env, nothing changed" 'has "a Cloud Build is running (b-5)" && lastm "ROLLBACK OF ENV NOT DONE — NO-GO"'

scen "U1 unknown rollback part"
run rollback everything; check "usage, rc 2" '[ "$RC" = 2 ]'
summary stages
[ $FAILN = 0 ]
