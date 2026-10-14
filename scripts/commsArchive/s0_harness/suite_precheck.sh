#!/bin/bash
# precheck, status and calibrate: read-only by effect, and every problem named.
. "$(dirname "$0")/lib.sh"; . "$(dirname "$0")/t.sh"
[ -n "${S0_SHARED:-}" ] || { stub_up || exit 1; trap stub_down EXIT; }

scen "P1 fresh project: precheck GO, next is bucket"
readonly_run precheck
check "GO names bucket" 'lastm "PRECHECK OK.*GO\. Next: bash ~/s0_infra.sh bucket"'
check "iamcredentials reported off" 'has "iamcredentials.googleapis.com is off"'
check "editor role noted" 'has "holds roles/editor"'

scen "P2 bucket name taken by another project"
spy "s['taken_elsewhere']=['lsg-yc-comms-archive']"
readonly_run precheck
check "NO-GO" 'lastm "NO-GO"'; check "names it" 'has "taken by ANOTHER project"'

scen "P3 bucket exists with 7-day soft delete (the GCS default)"
prep bucket; spy "s['buckets']['lsg-yc-comms-archive']['res']['softDeletePolicy']['retentionDurationSeconds']='604800'"
readonly_run precheck
check "NO-GO" 'lastm "NO-GO"'; check "names soft delete" 'has "PROBLEM: exists but soft delete (seconds): is \"604800\", must be \"2592000\""'

scen "P4 bucket exists with PAP inherited, versioning on, a lifecycle rule, a retention policy, STANDARD class"
prep bucket
spy "b=s['buckets']['lsg-yc-comms-archive']['res']; b['iamConfiguration']['publicAccessPrevention']='inherited'; b['versioning']={'enabled':True}; b['lifecycle']={'rule':[{'action':{'type':'Delete'},'condition':{'age':365}}]}; b['retentionPolicy']={'retentionPeriod':'1'}; b['storageClass']='STANDARD'"
readonly_run precheck
for f in "public access prevention" "versioning" "lifecycle rules" "retention policy" "default storage class"; do check "names $f" "has \"exists but $f\""; done
check "counts five" 'has "PRECHECK: 5 problem(s)"'

scen "P5 service account disabled"
spy "s['sa']['disabled']=True"; readonly_run precheck
check "named" 'has "the service account is DISABLED"'; check "NO-GO" 'lastm NO-GO'

scen "P6 traffic pinned to a revision (not by this script)"
pin_other; readonly_run precheck
check "named" "has \"traffic is not '100% LATEST'\""; check "NO-GO" 'lastm NO-GO'

scen "P7 template without the Cloud SQL attachment"
spy "del s['run']['spec']['template']['metadata']['annotations']['run.googleapis.com/cloudsql-instances']"
readonly_run precheck
check "named" 'has "does not carry the Cloud SQL attachment"'; check "NO-GO" 'lastm NO-GO'

scen "P8 Cloud Run API disabled"
spy "s['services_enabled'].remove('run.googleapis.com')"; readonly_run precheck
check "named" 'has "run.googleapis.com is not enabled"'; check "NO-GO" 'lastm NO-GO'

scen "P9 project number differs"
spy "s['project']['projectNumber']='111'"; readonly_run precheck
check "named" 'has "could not confirm project lsg-api-425223"'; check "NO-GO" 'lastm NO-GO'

scen "P10 COMMS_ARCHIVE_BUCKET already set to something else"
spy "s['run']['spec']['template']['spec']['containers'][0]['env'].append({'name':'COMMS_ARCHIVE_BUCKET','value':'other-bucket'})"
readonly_run precheck
check "named" "has \"COMMS_ARCHIVE_BUCKET is set to 'other-bucket'\""; check "NO-GO" 'lastm NO-GO'

scen "P11 a public member and an extra SA role on the bucket"
prep bucket
spy "s['buckets']['lsg-yc-comms-archive']['policy']['bindings'] += [{'role':'roles/storage.objectViewer','members':['allUsers']},{'role':'roles/storage.objectAdmin','members':['serviceAccount:'+SA]}]"
readonly_run precheck
check "public named" 'has "public members on the bucket in: roles/storage.objectViewer"'
check "extra role named" 'has "holds other roles on the bucket: roles/storage.objectAdmin"'; check "NO-GO" 'lastm NO-GO'

scen "P12 a Cloud Build is running: noted, still GO"
spy "s['builds']=[{'id':'b-123','location':'global','status':'WORKING'}]"; readonly_run precheck
check "noted" 'has "a build is running (b-123)"'; check "GO" 'lastm "PRECHECK OK"'

scen "P13 every read fails with 503"
faults '[{"match":"^(GET|POST) ","mode":"error","code":503,"count":-1}]'
readonly_run precheck
check "NO-GO" 'lastm NO-GO'; check "reports unreadable bucket" 'has "could not read the bucket"'; check "reports unreadable service" 'has "could not read the service svpcac"'

scen "P14 the bucket read hangs: time limit turns it into a reported problem"
faults '[{"match":"GET api.localhost/storage/v1/b/lsg-yc-comms-archive$","mode":"hang","seconds":60,"count":-1}]'
t0=$SECONDS; readonly_run precheck
check "finished within the scaled limits" '[ $((SECONDS-t0)) -lt 45 ]'
check "named as unreadable" 'has "could not read the bucket"'; check "time limit said so" 'has "no answer within the time limit"'

scen "P15 the env stage was interrupted after pinning traffic"
spy "r=$REV0; t=copy.deepcopy(s['run']['spec']['template']); t['spec']['containers'][0]['env'].append({'name':'COMMS_ARCHIVE_BUCKET','value':'lsg-yc-comms-archive'}); make_revision(s,'svpcac-00501-new',t); s['run']['spec']['template']=t; s['run']['spec']['traffic']=[{'revisionName':r,'percent':100},{'revisionName':'svpcac-00501-new','tag':'s0env'}]; s['run']['status']['latestCreatedRevisionName']='svpcac-00501-new'; s['run']['status']['latestReadyRevisionName']='svpcac-00501-new'; resolve(s)"
readonly_run precheck
check "named, with the command" 'has "PINNED to" && has "Run: bash ~/s0_infra.sh env"'

scen "S1 status on a fresh project: GO, next bucket"
readonly_run status
check "GO names bucket" 'lastm "GO\. Next: bash ~/s0_infra.sh bucket"'

scen "S2 status after everything: next is verify"
for x in bucket iam env; do prep $x; done
readonly_run status
check "GO names verify" 'lastm "GO\. Next: bash ~/s0_infra.sh verify"'

scen "S3 status after an env stage was cut short (traffic pinned): NO-GO naming env"
spy "r=$REV0; t=copy.deepcopy(s['run']['spec']['template']); t['spec']['containers'][0]['env'].append({'name':'COMMS_ARCHIVE_BUCKET','value':'lsg-yc-comms-archive'}); make_revision(s,'svpcac-00501-new',t); s['run']['spec']['template']=t; s['run']['spec']['traffic']=[{'revisionName':r,'percent':100},{'revisionName':'svpcac-00501-new','tag':'s0env'}]; s['run']['status']['latestCreatedRevisionName']='svpcac-00501-new'; s['run']['status']['latestReadyRevisionName']='svpcac-00501-new'; resolve(s)"
readonly_run status
check "NO-GO naming env" 'lastm "an env stage was cut short — NO-GO\. Next: bash ~/s0_infra.sh env"'

scen "S4 status with only a leftover s0env tag: NO-GO naming env"
for x in bucket iam env; do prep $x; done
spy "s['run']['spec']['traffic'].append({'revisionName': s['run']['status']['latestReadyRevisionName'], 'tag':'s0env'}); resolve(s)"
readonly_run status
check "NO-GO naming env" 'lastm "Next: bash ~/s0_infra.sh env"' ; check "rc 1" '[ "$RC" = 1 ]'

scen "C1 calibrate prints names, no values; masks a value that leaks into an annotation"
spy "e=s['run']['spec']['template']['spec']['containers'][0]['env']; [x.update(value='SECRET-'+x['name']+'-xyz123') for x in e if x['name'] in ('JWT_SECRET','password','API_KEY','database','user')]; s['run']['metadata']['annotations']['leak']='SECRET-JWT_SECRET-xyz123'; make_revision(s, $REV0, s['run']['spec']['template']); resolve(s)"
readonly_run calibrate
check "env names present" 'has "\"name\": \"JWT_SECRET\""'
check "no secret value anywhere in the output" '! grep -q "SECRET-" "$OUT"'
check "no secret value in the log file" '! grep -q "SECRET-" "$HOME/s0_calibrate.log"'
check "the leak was counted" 'has "second pass: 1 leftover"'
check "published values kept" 'has "lsg-api-425223:us-east1:yc-mysql"'
check "boot lines listed" 'has "Server is running on port 8080."'
check "missing-bucket wording captured" 'has "not found: 404"'
if grep -q '^HOLD="[a-z]' "$SCRIPT"; then
  for x in bucket iam env verify rollback; do
    scen "H1 this copy holds '$x': refused, nothing called"
    readonly_run $x
    check "refused" "lastm \"'$x' IS NOT RELEASED IN THIS COPY — NO-GO\""
    check "no request at all" '[ ! -s "$WORK/calls.log" ]'
  done
fi
summary precheck
[ $FAILN = 0 ]
