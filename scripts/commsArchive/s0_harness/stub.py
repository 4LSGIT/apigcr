#!/usr/bin/env python3
"""Stub Google APIs for the S0 infra harness (scripts/commsArchive/s0_infra.sh).

The REAL gcloud CLI is pointed here with api_endpoint_overrides/* (see lib.sh), so
gcloud's own client-side logic (read-modify-write, waits, refusals) runs for real
and only the server side is modelled. One process, routed by Host header:

  api.localhost             Storage JSON, IAM, IAM Credentials, Resource Manager,
                            Service Usage, Logging, Cloud Build
  us-east1-api.localhost    Cloud Run v1 (gcloud derives "<region>-" + override host)
  gcs.localhost             the public storage host: anonymous GETs and signed URLs
  *.run.localhost           the app: the service URL and its tag URLs
  any host, /__ctl/*        harness control (state, faults, call log)

No credentials anywhere: gcloud authenticates with a dummy token file.
Usage: stub.py PORT STATEFILE
"""
import base64, copy, hashlib, http.server, json, os, random, re, socket, string, sys, threading, time
import urllib.parse as up

PORT = int(sys.argv[1]); STATEFILE = sys.argv[2]
P = 'lsg-api-425223'; PN = '618099140949'; R = 'us-east1'
SA = PN + '-compute@developer.gserviceaccount.com'
CONN = P + ':' + R + ':yc-mysql'
LOCK = threading.RLock()
SECRET = b'stub-signing-secret'

# ── state ────────────────────────────────────────────────────────────────────
def now_iso(): return time.strftime('%Y-%m-%dT%H:%M:%S.000000Z', time.gmtime())
def rnd(n=3): return ''.join(random.choice(string.ascii_lowercase) for _ in range(n))
def etag(): return base64.b64encode(os.urandom(6)).decode()
def same_etag(a, b):  # gcloud sends etags back URL-safe base64; the bytes are what count
    n = lambda e: (e or '').replace('-', '+').replace('_', '/')
    return n(a) == n(b)

# Names and their order as production has them (calibrate, 2026-10-14); values are dummies.
PROD_ENV = [(n, 'dummy-' + n.lower()) for n in (
    'database user password RINGCENTRAL_CLIENT_ID RINGCENTRAL_CLIENT_SECRET RINGCENTRAL_REDIRECT_URI RINGCENTRAL_API_KEY '
    'API_KEY ENVIRONMENT GCS_BUCKET DROPBOX_ACCESS_TOKEN JWT_SECRET INTERNAL_API_KEY FIRM_TIMEZONE DROPBOX_TOKEN APP_URL '
    'EMAIL_DOMAIN EMAIL_DOMAINS IT_EMAIL AUTO_EMAIL DROPBOX_APP_KEY DROPBOX_APP_SECRET DROPBOX_REFRESH_TOKEN '
    'CREDENTIALS_ENCRYPTION_KEY user_ro password_ro FIRM_LOG FIRM_PHONE FIRM_EMAIL FIRM_URL GROQ_API_KEY ANTHROPIC_API_KEY '
    'BADGE_DEVICE_TOKEN AITEST_ENABLED AITEST_KEY STREAK_ADMIN_PASSWORD CLOUD_TASKS_LOCATION CLOUD_TASKS_QUEUE').split()] + [
    ('INSTANCE_CONNECTION_NAME', CONN)]
SHA = 'bf5150d16ba35e48a4a3a9aa3757054f0fb1f91b'

def template(env, image_sha=SHA):
    return {  # the shape production's template has (calibrate, 2026-10-14)
        'metadata': {'annotations': {
            'autoscaling.knative.dev/maxScale': '6',
            'run.googleapis.com/client-name': 'gcloud', 'run.googleapis.com/client-version': '589.0.0',
            'run.googleapis.com/cloudsql-instances': CONN,
            'run.googleapis.com/startup-cpu-boost': 'true'},
            'labels': {'client.knative.dev/nonce': rnd(10), 'commit-sha': image_sha, 'gcb-build-id': '707148ce-5bd8-4320-9383-38d0998c3c2b',
                       'gcb-trigger-id': 'deae68ad-1912-4a06-9db6-516dab663a64', 'gcb-trigger-region': 'global',
                       'managed-by': 'gcp-cloud-build-deploy-cloud-run', 'run.googleapis.com/startupProbeType': 'Default'}},
        'spec': {'containerConcurrency': 80, 'timeoutSeconds': 900, 'serviceAccountName': SA,
                 'containers': [{'name': 'apigcr-1',
                                 'image': 'us-east1-docker.pkg.dev/%s/cloud-run-source-deploy/apigcr/svpcac:%s' % (P, image_sha),
                                 'ports': [{'name': 'http1', 'containerPort': 8080}],
                                 'env': [{'name': k, 'value': v} for k, v in env],
                                 'resources': {'limits': {'cpu': '1000m', 'memory': '1Gi'}},
                                 'startupProbe': {'timeoutSeconds': 240, 'periodSeconds': 240, 'failureThreshold': 1, 'tcpSocket': {'port': 8080}}}]}}

def fresh_state():
    s = {
        'project': {'projectId': P, 'projectNumber': PN, 'lifecycleState': 'ACTIVE', 'name': P},
        'services_enabled': ['run.googleapis.com', 'storage.googleapis.com', 'storage-api.googleapis.com', 'iam.googleapis.com',
                             'cloudbuild.googleapis.com', 'logging.googleapis.com', 'sqladmin.googleapis.com',
                             'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com'],
        'sa': {'exists': True, 'disabled': False, 'policy': {'version': 1, 'etag': 'ACAB'}},
        'project_policy': {'version': 1, 'etag': 'BwYAAAAAAAA=', 'bindings': [
            {'role': 'roles/editor', 'members': ['serviceAccount:' + SA]},
            {'role': 'roles/cloudsql.client', 'members': ['serviceAccount:' + SA]},
            {'role': 'roles/owner', 'members': ['user:operator@example.com']}]},
        'buckets': {}, 'taken_elsewhere': [],
        'run': None, 'revisions': {}, 'counter': 500, 'logs': {},
        'builds': [],  # [{id, location, status}]
        'signatures': {}, 'caller_can_impersonate': True, 'faults': [], 'flags': {},
    }
    rev0 = 'svpcac-00500-' + rnd()   # production: svpcac-01718-5sd; the number only orders revisions here
    t = template(PROD_ENV); t['metadata']['name'] = None; del t['metadata']['name']
    svc = {'apiVersion': 'serving.knative.dev/v1', 'kind': 'Service',
           'metadata': {'name': 'svpcac', 'namespace': PN, 'generation': 500, 'resourceVersion': 'AAA' + rnd(6),
                        'uid': 'u-' + rnd(8), 'creationTimestamp': '2024-06-01T00:00:00.000000Z',
                        'labels': {'cloud.googleapis.com/location': R},
                        'annotations': {  # production's service annotations (calibrate, 2026-10-14)
                            'run.googleapis.com/build-enable-automatic-updates': 'false',
                            'run.googleapis.com/build-id': '829656dd-f3c4-4267-8698-1df9af7e3dc4',
                            'run.googleapis.com/build-image-uri': 'us-east1-docker.pkg.dev/%s/cloud-run-source-deploy/svpcac' % P,
                            'run.googleapis.com/build-name': 'projects/%s/locations/us-east1/builds/829656dd-f3c4-4267-8698-1df9af7e3dc4' % PN,
                            'run.googleapis.com/build-source-location': 'gs://run-sources-%s-us-east1/services/svpcac/x.zip#1' % P,
                            'run.googleapis.com/client-name': 'gcloud', 'run.googleapis.com/client-version': '589.0.0',
                            'run.googleapis.com/ingress': 'all', 'run.googleapis.com/ingress-status': 'all',
                            'run.googleapis.com/operation-id': 'op-' + rnd(8),
                            'run.googleapis.com/urls': json.dumps(['https://svpcac-%s.%s.run.app' % (PN, R), 'https://svpcac-ztvzsuxura-ue.a.run.app']),
                            'runapps.googleapis.com/integrations': 'firebase-hosting/firebase-hosting-746132',
                            'runapps.googleapis.com/integrations.firebase-hosting.firebase-hosting-746132': '2024-07-01T14:37:10.018092Z',
                            'serving.knative.dev/creator': 'operator@example.com', 'serving.knative.dev/lastModifier': SA}},
           'spec': {'template': t, 'traffic': [{'percent': 100, 'latestRevision': True}]},
           'status': {}}
    s['run'] = svc
    make_revision(s, rev0, t, ready=True)
    s['run']['status'] = {'latestCreatedRevisionName': rev0, 'latestReadyRevisionName': rev0}
    resolve(s)
    return s

def digest_of(tmpl):
    img = tmpl['spec']['containers'][0]['image']
    if '@sha256:' in img: return img
    repo = img.rsplit(':', 1)[0]
    return repo + '@sha256:' + hashlib.sha256(img.encode()).hexdigest()

def with_digest(spec):
    sp = copy.deepcopy(spec); c = sp['containers'][0]; c['image'] = digest_of({'spec': spec}); return sp

def make_revision(s, name, tmpl, ready=True, message=None):
    r = {'apiVersion': 'serving.knative.dev/v1', 'kind': 'Revision',
         'metadata': {'name': name, 'namespace': PN, 'uid': 'r-' + rnd(8), 'creationTimestamp': now_iso(), 'generation': 1,
                      'labels': dict(tmpl.get('metadata', {}).get('labels', {}), **{
                          'serving.knative.dev/service': 'svpcac', 'serving.knative.dev/configuration': 'svpcac',
                          'serving.knative.dev/configurationGeneration': str(s['counter']),
                          'serving.knative.dev/route': 'svpcac', 'cloud.googleapis.com/location': R}),
                      'annotations': dict(tmpl.get('metadata', {}).get('annotations', {}), **{
                          'serving.knative.dev/creator': 'operator@example.com', 'run.googleapis.com/operation-id': 'op-' + rnd(8)}),
                      'ownerReferences': [{'kind': 'Configuration', 'name': 'svpcac', 'apiVersion': 'serving.knative.dev/v1'}]},
         'spec': with_digest(tmpl['spec']),
         'status': {'observedGeneration': 1, 'conditions': [
             {'type': 'Ready', 'status': 'True' if ready else 'False', 'lastTransitionTime': now_iso(),
              **({} if ready else {'reason': 'HealthCheckContainerError', 'message': message or 'The user-provided container failed to start and listen on the port defined provided by the PORT=8080 environment variable.'})},
             {'type': 'ContainerHealthy', 'status': 'True' if ready else 'False', 'lastTransitionTime': now_iso()},
             {'type': 'ResourcesAvailable', 'status': 'True', 'lastTransitionTime': now_iso()}],
             'logUrl': 'https://console.cloud.google.com/logs', 'imageDigest': digest_of(tmpl),
             'containerStatuses': [{'name': 'apigcr-1', 'imageDigest': digest_of(tmpl)}]}}
    s['revisions'][name] = r
    # boot log, derived from what the revision would actually do
    env = {e['name']: e.get('value') for e in tmpl['spec']['containers'][0].get('env', [])}
    ann = tmpl.get('metadata', {}).get('annotations', {})
    # what production prints at boot (calibrate, 2026-10-14). The '[db] connected' line is
    # development-only (startup/db.js); the database is reached at boot by the field-def
    # reconcile, which prints only on failure.
    lines = ['app build: %s (mtime 1791933561000)' % name, 'db ready', 'Node runtime: v24.9.0', 'Server is running on port 8080.']
    sock_ok = env.get('INSTANCE_CONNECTION_NAME') and ann.get('run.googleapis.com/cloudsql-instances', '') == env['INSTANCE_CONNECTION_NAME']
    if not sock_ok or (s['flags'].get('boot_without_socket') and s['counter'] > 500):
        lines.append('[fieldDefReconciler] boot: could not get a connection / the lock: connect ENOENT /cloudsql/%s' % env.get('INSTANCE_CONNECTION_NAME'))
    if s['flags'].get('boot_no_server_line') and s['counter'] > 500:
        lines = [l for l in lines if 'Server is running' not in l]
    if s['flags'].get('dirty_log'): lines.insert(3, s['flags']['dirty_log'])
    if not ready: lines = lines[:1] + ['Error: listen EADDRINUSE']
    s['logs'][name] = [{'textPayload': l, 'timestamp': now_iso(), 'severity': 'ERROR' if 'failed' in l else 'DEFAULT'} for l in lines]

def resolve(s):
    """Recompute service.status from spec, as the control plane would."""
    svc = s['run']; st = svc['status']; base = 'http://svpcac.run.localhost:%d' % PORT   # production: https://svpcac-ztvzsuxura-ue.a.run.app
    traffic = []
    for t in svc['spec'].get('traffic', []):
        e = {}
        if t.get('latestRevision'):
            e = {'revisionName': st['latestReadyRevisionName'], 'latestRevision': True}
        else:
            e = {'revisionName': t['revisionName']}
        if 'percent' in t: e['percent'] = t['percent']
        if t.get('tag'):
            e['tag'] = t['tag']; e['url'] = 'http://%s---svpcac.run.localhost:%d' % (t['tag'], PORT)
        traffic.append(e)
    ready = 'True'
    lc = s['revisions'][st['latestCreatedRevisionName']]
    lc_ready = lc['status']['conditions'][0]['status']
    conds = [{'type': 'Ready', 'status': lc_ready, 'lastTransitionTime': now_iso()},
             {'type': 'ConfigurationsReady', 'status': lc_ready, 'lastTransitionTime': now_iso()},
             {'type': 'RoutesReady', 'status': 'True', 'lastTransitionTime': now_iso()}]
    if lc_ready != 'True':
        msg = 'Revision \'%s\' is not ready and cannot serve traffic. %s' % (lc['metadata']['name'], lc['status']['conditions'][0].get('message', ''))
        conds[0]['message'] = msg; conds[0]['reason'] = 'HealthCheckContainerError'
        conds[1]['message'] = msg; conds[1]['reason'] = 'HealthCheckContainerError'
    svc['status'] = dict(st, observedGeneration=svc['metadata']['generation'], conditions=conds,
                         traffic=traffic, url=base, address={'url': base})

def load():
    if os.path.exists(STATEFILE): return json.load(open(STATEFILE))
    s = fresh_state(); save(s); return s
def save(s):
    tmp = STATEFILE + '.tmp'; json.dump(s, open(tmp, 'w'), indent=1); os.replace(tmp, STATEFILE)

CALLS = os.path.join(os.path.dirname(os.path.abspath(STATEFILE)), 'calls.log')

# ── HTTP plumbing ────────────────────────────────────────────────────────────
class Srv(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6; daemon_threads = True
    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0); super().server_bind()

class Reply(Exception):
    def __init__(self, code, body=None, headers=None, raw=None, ctype='application/json'):
        self.code, self.body, self.headers, self.raw, self.ctype = code, body, headers or {}, raw, ctype

def gerr(code, msg, status=None, reason=None):
    st = status or {400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND',
                    409: 'ALREADY_EXISTS', 412: 'FAILED_PRECONDITION', 500: 'INTERNAL', 503: 'UNAVAILABLE'}.get(code, 'UNKNOWN')
    e = {'code': code, 'message': msg, 'status': st}
    if reason: e['errors'] = [{'message': msg, 'domain': 'global', 'reason': reason}]
    return Reply(code, {'error': e})

def xml_err(code, c, msg):
    return Reply(code, raw=('<?xml version=\'1.0\' encoding=\'UTF-8\'?><Error><Code>%s</Code><Message>%s</Message></Error>' % (c, msg)).encode(),
                 ctype='application/xml; charset=UTF-8')

class H(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def handle_any(self):
        if 'chunked' in (self.headers.get('transfer-encoding') or '').lower():
            body = b''
            while True:
                ln = int(self.rfile.readline().strip().split(b';')[0], 16)
                if ln == 0: self.rfile.readline(); break
                body += self.rfile.read(ln); self.rfile.readline()
        else:
            n = int(self.headers.get('content-length') or 0)
            body = self.rfile.read(n) if n else b''
        host = (self.headers.get('host') or '').split(':')[0]
        u = up.urlsplit(self.path); path = u.path; q = dict(up.parse_qsl(u.query, keep_blank_values=True))
        key = '%s %s%s' % (self.command, host, path)
        try:
            if path.startswith('/__ctl/'): ctl(self, path, q, body); return
            with open(CALLS, 'a') as f:
                f.write('%s %s %s?%s\n' % (time.strftime('%H:%M:%S'), self.command, host + path, u.query))
                if body and self.command != 'GET' and 'upload' not in path: f.write('    body: %s\n' % body[:3000].decode('utf8', 'replace'))
            fault_hit(key, before=True)
            try:
                route(self, host, path, q, body)
            except Reply:
                raise
            except Exception:
                import traceback; traceback.print_exc(); sys.stderr.flush()
                raise gerr(500, 'stub crashed (see stub.log): ' + key)
        except Reply as r:
            out = r.raw if r.raw is not None else (json.dumps(r.body).encode() if r.body is not None else b'')
            try:
                self.send_response(r.code)
                self.send_header('content-type', r.ctype)
                for k, v in r.headers.items(): self.send_header(k, v)
                self.send_header('content-length', str(len(out))); self.end_headers()
                if self.command != 'HEAD': self.wfile.write(out)
            except (BrokenPipeError, ConnectionResetError):
                pass
    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = handle_any

# ── faults ───────────────────────────────────────────────────────────────────
# {"match": "<regex over 'METHOD host/path'>", "mode": "error"|"hang"|"after"|"after_hang", "code": 503, "count": 1,
#  "seconds": 30, "skip": 0}   skip: let that many matching requests through first.  count -1 = forever.
#   error: answer `code` and do nothing.  hang: sleep `seconds`, then error.  after: do it, then answer `code`.
AFTER = threading.local()
def fault_hit(key, before):
    with LOCK:
        s = load(); hit = None
        for f in s['faults']:
            if f.get('count', 1) != 0 and re.search(f['match'], key):
                if f.get('skip', 0) > 0: f['skip'] -= 1; save(s); break
                hit = f; break
        if not hit: AFTER.mode = None; return
        if hit.get('count', 1) > 0: hit['count'] = hit.get('count', 1) - 1
        save(s)
    mode = hit.get('mode', 'error')
    if mode == 'hang':
        time.sleep(hit.get('seconds', 30)); raise gerr(hit.get('code', 503), 'stub: injected hang then failure')
    if mode == 'error':
        raise gerr(hit.get('code', 503), hit.get('message', 'stub: injected failure'))
    AFTER.mode = hit  # 'after': the route does the work, then fails

def finish(code, body, headers=None):
    hit = getattr(AFTER, 'mode', None)
    if hit:
        AFTER.mode = None
        if hit.get('mode') == 'after_hang': time.sleep(hit.get('seconds', 30))
        raise gerr(hit.get('code', 503), 'stub: injected failure after the change was made')
    raise Reply(code, body, headers)

# ── control ──────────────────────────────────────────────────────────────────
def ctl(h, path, q, body):
    with LOCK:
        if path == '/__ctl/reset':
            s = fresh_state(); save(s); open(CALLS, 'w').close(); raise Reply(200, {'ok': True})
        s = load()
        if path == '/__ctl/state': raise Reply(200, s)
        if path == '/__ctl/whoami': raise Reply(200, {'statefile': STATEFILE})
        if path == '/__ctl/faults':
            s['faults'] = json.loads(body or b'[]'); save(s); raise Reply(200, {'ok': True})
        if path == '/__ctl/py':  # mutate state with a python statement over `s` (harness only)
            exec(body.decode(), {'s': s, 'SA': SA, 'P': P, 'PN': PN, 'CONN': CONN, 'make_revision': make_revision,
                                 'resolve': resolve, 'template': template, 'PROD_ENV': PROD_ENV, 'copy': copy})
            save(s); raise Reply(200, {'ok': True})
        if path == '/__ctl/eval':  # an expression, or statements that set `out`
            src = body.decode(); env = {'s': s, 'SA': SA}
            try: v = eval(src, env)
            except SyntaxError: exec(src, env); v = env['out']
            raise Reply(200, {'v': v})
    raise Reply(404, {'error': 'no such control'})

# ── routing ──────────────────────────────────────────────────────────────────
def route(h, host, path, q, body):
    if host == 'us-east1-api.localhost': return run_api(h, path, q, body)
    if host == 'gcs.localhost': return public_gcs(h, path, q)
    if host.endswith('.gcs.localhost'): return public_gcs(h, '/' + host[:-len('.gcs.localhost')] + path, q)
    if host.endswith('.run.localhost'): return app(h, host, path)
    if host != 'api.localhost': raise gerr(404, 'stub: unknown host ' + host)
    auth = h.headers.get('authorization', '')
    if not auth.startswith('Bearer '): raise gerr(401, 'stub: no bearer token')
    if path.startswith('/storage/v1/') or path.startswith('/upload/storage/v1/') or path.startswith('/resumable/'): return storage(h, path, q, body)
    if path.startswith('/v1/projects/-/serviceAccounts/') and (':signBlob' in path or ':generateAccessToken' in path): return iamcred(h, path, body)
    if path.startswith('/v1/projects/%s/serviceAccounts/' % P) or path.startswith('/v1/projects/-/serviceAccounts/'): return iam_sa(h, path, body)
    if path.startswith('/v1/projects/%s/locations/' % P) and '/builds' in path: return builds(h, path, q)
    if path.startswith('/v1/projects/%s/builds' % P): return builds(h, '/v1/projects/%s/locations/global/builds' % P, q)
    if path.startswith('/v1/projects/%s/services' % P) or path.startswith('/v1/operations/'): return usage(h, path, q, body)
    if path == '/v2/entries:list': return logging_list(h, body)
    if path.startswith('/v1/roles/'): return role_def(h, path)
    if path.startswith('/v1/projects/%s' % P) or path.startswith('/v3/projects/%s' % P): return crm(h, path, body)
    raise gerr(404, 'stub: unmodelled API path ' + path)

def j(body):
    return json.loads(body) if body else {}

# Resource Manager ─────────────────────────────────────────────────────────────
def crm(h, path, body):
    with LOCK:
        s = load()
        if path.endswith(':getIamPolicy'): finish(200, s['project_policy'])
        if path.endswith(':setIamPolicy'):  # never by the script; modelled for the mutation suite
            pol = j(body).get('policy', {}); pol['etag'] = etag(); s['project_policy'] = pol; save(s); finish(200, pol)
        if path in ('/v1/projects/' + P, '/v3/projects/' + P): finish(200, s['project'])
    raise gerr(404, 'stub: crm ' + path)

# Service Usage ────────────────────────────────────────────────────────────────
def usage(h, path, q, body):
    with LOCK:
        s = load()
        if path.startswith('/v1/operations/'):
            finish(200, {'name': path[4:], 'done': True, 'response': {'@type': 'type.googleapis.com/google.api.serviceusage.v1.EnableServiceResponse'}})
        m = re.match(r'^/v1/projects/%s/services/([^/:]+):enable$' % P, path)
        if m and h.command == 'POST':
            if m.group(1) not in s['services_enabled']: s['services_enabled'].append(m.group(1)); save(s)
            finish(200, {'name': 'operations/acf.' + rnd(8), 'done': True, 'response': {'@type': 'type.googleapis.com/google.api.serviceusage.v1.EnableServiceResponse', 'service': {'name': 'projects/%s/services/%s' % (PN, m.group(1)), 'state': 'ENABLED'}}})
        if path == '/v1/projects/%s/services:batchEnable' % P:
            for x in j(body).get('serviceIds', []):
                if x not in s['services_enabled']: s['services_enabled'].append(x)
            save(s); finish(200, {'name': 'operations/acf.' + rnd(8), 'done': True})
        m = re.match(r'^/v1/projects/%s/services/([^/:]+)$' % P, path)
        if m:
            finish(200, {'name': 'projects/%s/services/%s' % (PN, m.group(1)), 'state': 'ENABLED' if m.group(1) in s['services_enabled'] else 'DISABLED', 'config': {'name': m.group(1)}})
        if path == '/v1/projects/%s/services' % P:
            flt = q.get('filter', '')
            names = s['services_enabled'] if 'ENABLED' in flt else s['services_enabled']
            finish(200, {'services': [{'name': 'projects/%s/services/%s' % (PN, n), 'config': {'name': n, 'title': n}, 'state': 'ENABLED'} for n in names]})
    raise gerr(404, 'stub: serviceusage ' + path)

# IAM service account ──────────────────────────────────────────────────────────
def iam_sa(h, path, body):
    with LOCK:
        s = load()
        m = re.match(r'^/v1/projects/[^/]+/serviceAccounts/([^/:]+)(:getIamPolicy|:setIamPolicy)?$', path)
        if not m: raise gerr(404, 'stub: iam ' + path)
        if m.group(1) != SA or not s['sa']['exists']:
            raise gerr(404, 'Unknown service account', 'NOT_FOUND')
        if m.group(2) == ':getIamPolicy': finish(200, s['sa']['policy'])
        if m.group(2) == ':setIamPolicy':
            pol = j(body).get('policy', {})
            if pol.get('etag') and not same_etag(pol['etag'], s['sa']['policy'].get('etag')):
                raise gerr(409, 'There were concurrent policy changes.', 'ABORTED')
            pol['etag'] = etag(); pol['version'] = 1
            if not pol.get('bindings'): pol.pop('bindings', None)
            s['sa']['policy'] = pol; save(s); finish(200, pol)
        finish(200, {'name': 'projects/%s/serviceAccounts/%s' % (P, SA), 'projectId': P, 'uniqueId': '1' * 21, 'email': SA,
                     'displayName': 'Compute Engine default service account', 'disabled': s['sa']['disabled'], 'etag': 'MDEwMjE5MjA='})

def iamcred(h, path, body):
    with LOCK:
        s = load()
        m = re.match(r'^/v1/projects/-/serviceAccounts/([^/:]+):(signBlob|generateAccessToken)$', path)
        if not m or m.group(1) != SA: raise gerr(404, 'stub: iamcredentials ' + path)
        if 'iamcredentials.googleapis.com' not in s['services_enabled']:
            raise gerr(403, 'IAM Service Account Credentials API has not been used in project %s before or it is disabled.' % PN, 'PERMISSION_DENIED')
        if not s['caller_can_impersonate']:
            raise gerr(403, "Permission 'iam.serviceAccounts.%s' denied on resource (or it may not exist)." %
                       ('signBlob' if m.group(2) == 'signBlob' else 'getAccessToken'), 'PERMISSION_DENIED', 'IAM_PERMISSION_DENIED')
        if m.group(2) == 'generateAccessToken':
            finish(200, {'accessToken': 'stub-impersonated-token', 'expireTime': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 3600))})
        payload = base64.b64decode(j(body)['payload'])
        sig = hashlib.sha256(SECRET + payload).digest() * 8  # 256 bytes, like RSA-2048
        s['signatures'][sig.hex()] = time.time(); save(s)
        finish(200, {'keyId': 'k' * 40, 'signedBlob': base64.b64encode(sig).decode()})

# IAM predefined roles (permission sets from Google's published reference, Oct 2026) ───────────
OBJ_USER = ['storage.objects.create', 'storage.objects.createContext', 'storage.objects.delete', 'storage.objects.deleteContext',
            'storage.objects.get', 'storage.objects.list', 'storage.objects.move', 'storage.objects.restore', 'storage.objects.update',
            'storage.objects.updateContext', 'storage.multipartUploads.abort', 'storage.multipartUploads.create',
            'storage.multipartUploads.list', 'storage.multipartUploads.listParts', 'resourcemanager.projects.get']
ROLE_PERMS = {'roles/storage.objectUser': OBJ_USER,
              'roles/storage.objectAdmin': OBJ_USER + ['storage.objects.getIamPolicy', 'storage.objects.setIamPolicy', 'storage.objects.setRetention'],
              'roles/storage.objectViewer': ['storage.objects.get', 'storage.objects.list'],
              'roles/storage.objectCreator': ['storage.objects.create']}
def role_def(h, path):
    with LOCK:
        s = load(); name = path[len('/v1/'):]
        perms = s['flags'].get('role_override', {}).get(name, ROLE_PERMS.get(name))
        if perms is None: raise gerr(404, 'stub: role not modelled ' + name)
        finish(200, {'name': name, 'title': name, 'includedPermissions': sorted(perms), 'stage': 'GA', 'etag': 'AA=='})

# Cloud Build ───────────────────────────────────────────────────────────────────
def builds(h, path, q):
    with LOCK:
        s = load()
        m = re.match(r'^/v1/projects/%s/locations/([^/]+)/builds$' % P, path)
        if not m: raise gerr(404, 'stub: builds ' + path)
        loc = m.group(1); flt = q.get('filter', '')
        out = [b for b in s['builds'] if b['location'] == loc]
        if 'WORKING' in flt or 'QUEUED' in flt:
            out = [b for b in out if b['status'] in ('WORKING', 'QUEUED')]
        # a build that "starts" after N list calls (models a push landing mid-stage)
        for b in s['builds']:
            if b.get('starts_after_calls') is not None:
                b['starts_after_calls'] -= 1
                if b['starts_after_calls'] < 0: b['status'] = 'WORKING'; b['starts_after_calls'] = None
        save(s)
        finish(200, {'builds': [{'id': b['id'], 'projectId': P, 'status': b['status'], 'createTime': now_iso(),
                                 'name': 'projects/%s/locations/%s/builds/%s' % (PN, b['location'], b['id']),
                                 'substitutions': {'TRIGGER_NAME': 'rmgpgab-svpcac-us-east1-4LSGIT-apigcr--maulx'}} for b in out]})

# Logging ───────────────────────────────────────────────────────────────────────
def logging_list(h, body):
    with LOCK:
        s = load(); req = j(body); flt = req.get('filter', '')
        m = re.search(r'revision_name\s*=\s*"([^"]+)"', flt)
        names = [m.group(1)] if m else list(s['logs'])
        ents = []
        for n in names:
            for e in s['logs'].get(n, []):
                ents.append({'textPayload': e['textPayload'], 'timestamp': e['timestamp'], 'severity': e['severity'],
                             'resource': {'type': 'cloud_run_revision', 'labels': {'service_name': 'svpcac', 'revision_name': n, 'location': R, 'project_id': P}},
                             'logName': 'projects/%s/logs/run.googleapis.com%%2Fstdout' % P, 'insertId': rnd(12)})
        finish(200, {'entries': ents[:int(req.get('pageSize', 1000))]})

# Storage JSON ──────────────────────────────────────────────────────────────────
BUCKET_DEFAULTS = lambda name, loc: {
    'kind': 'storage#bucket', 'id': name, 'name': name, 'selfLink': 'https://www.googleapis.com/storage/v1/b/' + name,
    'projectNumber': PN, 'metageneration': '1', 'location': loc, 'locationType': 'region', 'storageClass': 'STANDARD',
    'etag': 'CAE=', 'timeCreated': now_iso(), 'updated': now_iso(), 'rpo': 'DEFAULT',
    'iamConfiguration': {'bucketPolicyOnly': {'enabled': False}, 'uniformBucketLevelAccess': {'enabled': False}, 'publicAccessPrevention': 'inherited'},
    'softDeletePolicy': {'retentionDurationSeconds': '604800', 'effectiveTime': now_iso()},
    'hierarchicalNamespace': {'enabled': False}}

def bucket_view(b):
    v = copy.deepcopy(b['res'])
    return v

def storage(h, path, q, body):
    with LOCK:
        s = load()
        m = re.match(r'^/storage/v1/b/?$', path)
        if m and h.command == 'POST':
            req = j(body); name = req.get('name')
            if name in s['taken_elsewhere'] or name in s['buckets']:
                raise gerr(409, 'Your previous request to create the named bucket succeeded and you already own it.' if name in s['buckets']
                           else 'The requested bucket name is not available. The bucket namespace is shared by all users of the system. Please select a different name and try again.', 'ALREADY_EXISTS', 'conflict')
            res = BUCKET_DEFAULTS(name, (req.get('location') or 'US').upper())
            for k, v in req.items():
                if k in ('iamConfiguration',):
                    ic = res['iamConfiguration']
                    if 'uniformBucketLevelAccess' in v:
                        ic['uniformBucketLevelAccess'] = {'enabled': bool(v['uniformBucketLevelAccess'].get('enabled'))}
                        ic['bucketPolicyOnly'] = dict(ic['uniformBucketLevelAccess'])
                        if ic['uniformBucketLevelAccess']['enabled']: ic['uniformBucketLevelAccess']['lockedTime'] = now_iso()
                    if 'publicAccessPrevention' in v: ic['publicAccessPrevention'] = v['publicAccessPrevention']
                elif k == 'softDeletePolicy':
                    res['softDeletePolicy'] = {'retentionDurationSeconds': str(v.get('retentionDurationSeconds', '0')), 'effectiveTime': now_iso()}
                    if res['softDeletePolicy']['retentionDurationSeconds'] == '0': res['softDeletePolicy'] = {'retentionDurationSeconds': '0'}
                elif k == 'location': pass
                elif k in ('versioning', 'retentionPolicy', 'lifecycle', 'encryption', 'autoclass', 'storageClass', 'labels',
                           'hierarchicalNamespace', 'customPlacementConfig', 'objectRetention', 'rpo'):
                    res[k] = v
                elif k in ('name', 'project'): pass
                else: raise gerr(400, 'stub: unmodelled bucket field ' + k)
            if res.get('retentionPolicy'): res['retentionPolicy']['effectiveTime'] = now_iso()
            s['buckets'][name] = {'res': res, 'policy': {'version': 1, 'etag': 'CAE=', 'bindings': [
                {'role': 'roles/storage.legacyBucketOwner', 'members': ['projectEditor:' + P, 'projectOwner:' + P]},
                {'role': 'roles/storage.legacyBucketReader', 'members': ['projectViewer:' + P]},
                {'role': 'roles/storage.legacyObjectOwner', 'members': ['projectEditor:' + P, 'projectOwner:' + P]},
                {'role': 'roles/storage.legacyObjectReader', 'members': ['projectViewer:' + P]}]},
                'objects': {}, 'gen': 1700000000000000}
            save(s); finish(200, bucket_view(s['buckets'][name]))
        m = re.match(r'^/storage/v1/b/([^/]+)/storageLayout$', path)
        if m:
            b = need_bucket(s, m.group(1))
            finish(200, {'kind': 'storage#storageLayout', 'bucket': m.group(1), 'location': b['res']['location'],
                         'locationType': 'region', 'hierarchicalNamespace': {'enabled': False}})
        m = re.match(r'^/storage/v1/b/([^/]+)(/iam)?$', path)
        if m:
            name = m.group(1)
            if name in s['taken_elsewhere']:
                raise gerr(403, 'operator@example.com does not have storage.buckets.get access to the Google Cloud Storage bucket. Permission \'storage.buckets.get\' denied on resource (or it may not exist).', reason='forbidden')
            if name not in s['buckets']: raise gerr(404, 'The specified bucket does not exist.', reason='notFound')
            b = s['buckets'][name]
            if m.group(2):
                if h.command == 'GET': finish(200, b['policy'])
                if h.command == 'PUT':
                    pol = j(body)
                    if pol.get('etag') and not same_etag(pol['etag'], b['policy']['etag']): raise gerr(412, 'Precondition Failed', reason='conditionNotMet')
                    pub = any(mm in ('allUsers', 'allAuthenticatedUsers') for bd in pol.get('bindings', []) for mm in bd['members'])
                    if pub and b['res']['iamConfiguration']['publicAccessPrevention'] == 'enforced':
                        raise gerr(412, 'The member bindings allUsers and allAuthenticatedUsers are not allowed since public access prevention is enforced.', reason='conditionNotMet')
                    pol['etag'] = etag(); pol['version'] = 1; b['policy'] = pol; save(s); finish(200, pol)
            if h.command == 'GET': finish(200, bucket_view(b))
            if h.command == 'DELETE':
                if any(not o.get('soft') for o in b['objects'].values()): raise gerr(409, 'The bucket you tried to delete is not empty.', reason='conflict')
                del s['buckets'][name]; save(s); finish(204, None)
            if h.command == 'PATCH':  # the script never updates a bucket; modelled for the mutation suite
                for k, v in j(body).items():
                    if k == 'name': continue   # gcloud sends the bucket's own name along
                    if k in ('versioning', 'lifecycle', 'retentionPolicy', 'storageClass', 'labels'): b['res'][k] = v
                    else: raise gerr(400, 'stub: unmodelled bucket PATCH field ' + k)
                save(s); finish(200, bucket_view(b))
        m = re.match(r'^/storage/v1/b/([^/]+)/o$', path)
        if m and h.command == 'GET':
            b = need_bucket(s, m.group(1)); pre = q.get('prefix', '')
            soft = q.get('softDeleted') == 'true'
            items = [o['meta'] for n, o in sorted(b['objects'].items()) if n.startswith(pre) and bool(o.get('soft')) == soft]
            finish(200, {'kind': 'storage#objects', 'items': items} if items else {'kind': 'storage#objects'})
        m = re.match(r'^/storage/v1/b/([^/]+)/o/(.+)$', path)
        if m:
            b = need_bucket(s, m.group(1)); name = up.unquote(m.group(2))
            o = b['objects'].get(name)
            if not o or o.get('soft'): raise gerr(404, 'No such object: %s/%s' % (m.group(1), name), reason='notFound')
            if h.command == 'DELETE':
                if b['res']['softDeletePolicy'].get('retentionDurationSeconds', '0') != '0':
                    o['soft'] = True; o['meta']['softDeleteTime'] = now_iso()
                else:
                    del b['objects'][name]
                save(s); finish(204, None)
            if q.get('alt') == 'media':
                hit = getattr(AFTER, 'mode', None)
                raise Reply(200, raw=base64.b64decode(o['data']), ctype=o['meta']['contentType'],
                            headers={'x-goog-hash': 'md5=' + o['meta']['md5Hash'], 'x-goog-generation': o['meta']['generation']})
            finish(200, o['meta'])
        m = re.match(r'^/upload/storage/v1/b/([^/]+)/o$', path)
        if m and h.command == 'POST':
            b = need_bucket(s, m.group(1)); ut = q.get('uploadType')
            if ut == 'multipart':
                meta, data = parse_multipart(h.headers.get('content-type', ''), body)
                return finish(200, put_object(s, b, m.group(1), meta.get('name') or q.get('name'), data, meta, q))
            if ut == 'resumable':
                meta = j(body); uid = rnd(16)
                s.setdefault('uploads', {})[uid] = {'bucket': m.group(1), 'meta': meta, 'name': meta.get('name') or q.get('name'), 'q': q}
                save(s)
                raise Reply(200, {}, headers={'location': 'http://api.localhost:%d/upload/storage/v1/b/%s/o?uploadType=resumable&upload_id=%s' % (PORT, m.group(1), uid)})
            if ut == 'media':
                return finish(200, put_object(s, b, m.group(1), q.get('name'), body, {'contentType': h.headers.get('content-type')}, q))
        if m and h.command == 'PUT' and q.get('upload_id'):
            u = s.get('uploads', {}).pop(q['upload_id'], None)
            if not u: raise gerr(404, 'stub: no such upload')
            b = need_bucket(s, u['bucket'])
            return finish(200, put_object(s, b, u['bucket'], u['name'], body, u['meta'], u['q']))
    raise gerr(404, 'stub: unmodelled storage call %s %s' % (h.command, path))

def need_bucket(s, name):
    if name not in s['buckets']: raise gerr(404, 'The specified bucket does not exist.', reason='notFound')
    return s['buckets'][name]

def parse_multipart(ctype, body):
    bd = re.search(r"""boundary=["']?([^"';]+)["']?""", ctype).group(1).encode()
    parts = [p for p in body.split(b'--' + bd) if p.strip() not in (b'', b'--')]
    def split(p):
        p = p[2:] if p.startswith(b'\r\n') else p[1:] if p.startswith(b'\n') else p
        m = re.search(rb'\r?\n\r?\n', p)
        data = p[m.end():]
        return p[:m.start()], data[:-2] if data.endswith(b'\r\n') else data[:-1] if data.endswith(b'\n') else data
    _, mj = split(parts[0]); _, data = split(parts[1])
    return json.loads(mj), data

def put_object(s, b, bname, name, data, meta, q):
    if q.get('ifGenerationMatch') == '0' and name in b['objects'] and not b['objects'][name].get('soft'):
        raise gerr(412, 'At least one of the pre-conditions you specified did not hold.', reason='conditionNotMet')
    b['gen'] += 1
    md5 = base64.b64encode(hashlib.md5(data).digest()).decode()
    m = {'kind': 'storage#object', 'id': '%s/%s/%d' % (bname, name, b['gen']), 'name': name, 'bucket': bname,
         'generation': str(b['gen']), 'metageneration': '1', 'contentType': meta.get('contentType') or 'application/octet-stream',
         'storageClass': meta.get('storageClass') or b['res']['storageClass'], 'size': str(len(data)), 'md5Hash': md5,
         'crc32c': 'AAAAAA==', 'etag': 'CAE=', 'timeCreated': now_iso(), 'updated': now_iso(), 'timeStorageClassUpdated': now_iso()}
    b['objects'][name] = {'meta': m, 'data': base64.b64encode(data).decode()}
    save(s); return m

# public storage host ────────────────────────────────────────────────────────────
def public_gcs(h, path, q):
    with LOCK:
        s = load()
        m = re.match(r'^/storage/v1/b/([^/]+)/iam/testPermissions$', path)
        if m:  # testIamPermissions as whoever the bearer token is (only the impersonated SA is modelled)
            if h.headers.get('authorization') != 'Bearer stub-impersonated-token': raise gerr(401, 'stub: only the SA token is modelled')
            b = s['buckets'].get(m.group(1))
            if not b: raise gerr(404, 'The specified bucket does not exist.')
            have = set()
            for bd in b['policy'].get('bindings', []):
                if 'serviceAccount:' + SA in bd['members']: have |= set(s['flags'].get('role_override', {}).get(bd['role'], ROLE_PERMS.get(bd['role'], [])))
            if s['flags'].get('sa_reads_via_project_role'): have |= set(ROLE_PERMS['roles/storage.objectAdmin'])
            want = up.parse_qs(up.urlsplit(h.path).query).get('permissions', [])
            got = [p for p in want if p in have]
            raise Reply(200, {'kind': 'storage#testIamPermissionsResponse', **({'permissions': got} if got else {})})
        parts = path.lstrip('/').split('/', 1)
        bname = parts[0]; oname = up.unquote(parts[1]) if len(parts) > 1 else None
        b = s['buckets'].get(bname)
        if not b: raise xml_err(404, 'NoSuchBucket', 'The specified bucket does not exist.')
        q = {k.lower(): v for k, v in q.items()}
        if 'x-goog-signature' in q:
            sig = q['x-goog-signature']
            if sig not in s['signatures'] and not s['flags'].get('accept_any_signature'): raise xml_err(403, 'SignatureDoesNotMatch', 'Access denied.')
            import calendar
            t0 = calendar.timegm(time.strptime(q.get('x-goog-date', ''), '%Y%m%dT%H%M%SZ'))
            if time.time() > t0 + int(q.get('x-goog-expires', '0')): raise xml_err(400, 'ExpiredToken', 'Invalid argument.')
            if up.unquote(q.get('x-goog-credential', '')).split('/')[0] != SA: raise xml_err(403, 'SignatureDoesNotMatch', 'Access denied.')
            # the signer must still hold object read on this bucket when the URL is used
            if not any(m == 'serviceAccount:' + SA for bd in b['policy'].get('bindings', []) for m in bd['members']
                       if bd['role'] in ('roles/storage.objectUser', 'roles/storage.objectAdmin', 'roles/storage.objectViewer')) \
               and not s['flags'].get('sa_reads_via_project_role'):
                raise xml_err(403, 'AccessDenied', '%s does not have storage.objects.get access to the Google Cloud Storage object.' % SA)
        else:
            if h.headers.get('authorization'): raise xml_err(400, 'stub', 'authenticated public reads are not modelled')
            public = any(m in ('allUsers',) for bd in b['policy'].get('bindings', []) for m in bd['members']
                         if bd['role'] in ('roles/storage.objectViewer', 'roles/storage.legacyObjectReader', 'roles/storage.objectUser', 'roles/storage.objectAdmin'))
            if b['res']['iamConfiguration']['publicAccessPrevention'] == 'enforced' or not public:
                raise xml_err(401, 'AccessDenied', 'Anonymous caller does not have storage.objects.%s access to the Google Cloud Storage %s.' % ('get' if oname else 'list', 'object' if oname else 'bucket'))
        if not oname:
            raise Reply(200, raw=b'<ListBucketResult/>', ctype='application/xml')
        o = b['objects'].get(oname)
        if not o or o.get('soft'): raise xml_err(404, 'NoSuchKey', 'The specified key does not exist.')
        raise Reply(200, raw=base64.b64decode(o['data']), ctype=o['meta']['contentType'])

# the app ────────────────────────────────────────────────────────────────────────
def app(h, host, path):
    with LOCK:
        s = load(); st = s['run']['status']
        if host.startswith('svpcac.'):
            tr = [t for t in st['traffic'] if t.get('percent')]
            rev = max(tr, key=lambda t: t['percent'])['revisionName'] if tr else None
        else:
            tag = host.split('---')[0]
            rev = next((t['revisionName'] for t in st['traffic'] if t.get('tag') == tag), None)
            if not rev: raise Reply(404, raw=b'<html><body>Error: Page not found</body></html>', ctype='text/html')
        r = s['revisions'].get(rev)
        down = s['flags'].get('app_down_revisions', [])
        new_down = s['flags'].get('app_down_new') and int(rev.split('-')[1]) > 500
        if not r or r['status']['conditions'][0]['status'] != 'True' or rev in down or 'ALL' in down or new_down:
            raise Reply(503, raw=b'<html><head><title>503 Service Unavailable</title></head><body>Service Unavailable</body></html>', ctype='text/html')
        env = {e['name']: e.get('value') for e in r['spec']['containers'][0].get('env', [])}
        s['flags'].setdefault('served', []).append(rev); save(s)
    if path.startswith('/api/'):
        raise Reply(401, {'error': 'Unauthorized'}, headers={'x-powered-by': 'Express'})
    raise Reply(200, raw=b'<!doctype html><title>YisraCase</title>', ctype='text/html', headers={'x-powered-by': 'Express'})

# Cloud Run v1 ─────────────────────────────────────────────────────────────────
def strip_status(o):
    o = copy.deepcopy(o); o.pop('status', None); return o

def run_api(h, path, q, body):
    if not h.headers.get('authorization', '').startswith('Bearer '): raise gerr(401, 'stub: no bearer token')
    with LOCK:
        s = load(); ns = '/apis/serving.knative.dev/v1/namespaces/'
        m = re.match(r'^%s([^/]+)/services/([^/]+)$' % re.escape(ns), path)
        if m:
            if m.group(1) not in (P, PN) or m.group(2) != 'svpcac' or not s['run']:
                raise gerr(404, "Resource 'svpcac' of kind 'SERVICE' in region 'us-east1' in project '%s' does not exist." % P)
            if h.command == 'GET': finish(200, s['run'])
            if h.command == 'PUT':
                new = j(body); svc = s['run']; s.setdefault('puts', []).append(copy.deepcopy(new))
                rv = new.get('metadata', {}).get('resourceVersion')
                if rv and rv != svc['metadata']['resourceVersion']:
                    raise gerr(409, 'Conflict for resource \'svpcac\': version \'%s\' was specified but current version is \'%s\'.' % (rv, svc['metadata']['resourceVersion']), 'ABORTED')
                old_t = svc['spec']['template']; new_t = new['spec']['template']
                if s['flags'].get('drop_env_on_update'):
                    c = new_t['spec']['containers'][0]; c['env'] = [e for e in c.get('env', []) if e['name'] != s['flags']['drop_env_on_update']]
                if s['flags'].get('drop_cloudsql_on_update'):
                    new_t.get('metadata', {}).get('annotations', {}).pop('run.googleapis.com/cloudsql-instances', None)
                changed = json.dumps(old_t, sort_keys=True) != json.dumps(new_t, sort_keys=True)
                svc['spec'] = new['spec']
                svc['metadata']['annotations'] = new['metadata'].get('annotations', svc['metadata']['annotations'])
                svc['metadata']['labels'] = new['metadata'].get('labels', svc['metadata']['labels'])
                svc['metadata']['generation'] += 1; svc['metadata']['resourceVersion'] = 'AAA' + rnd(6)
                if changed:
                    s['counter'] += 1
                    name = new_t.get('metadata', {}).get('name') or 'svpcac-%05d-%s' % (s['counter'], rnd())
                    if name in s['revisions']:
                        raise gerr(409, "Revision named '%s' with different configuration already exists." % name, 'ALREADY_EXISTS')
                    fail = bool(s['flags'].get('revision_fails'))
                    make_revision(s, name, new_t, ready=not fail)
                    svc['status']['latestCreatedRevisionName'] = name
                    if not fail: svc['status']['latestReadyRevisionName'] = name
                # a traffic entry naming a revision that is not ready is accepted; status shows it
                for t in svc['spec'].get('traffic', []):
                    if t.get('revisionName') and t['revisionName'] not in s['revisions']:
                        raise gerr(400, "Revision '%s' does not exist." % t['revisionName'], 'INVALID_ARGUMENT')
                resolve(s); save(s); finish(200, svc)
        m = re.match(r'^%s([^/]+)/revisions/([^/]+)$' % re.escape(ns), path)
        if m:
            r = s['revisions'].get(m.group(2))
            if not r: raise gerr(404, "Revision '%s' not found." % m.group(2))
            finish(200, r)
        m = re.match(r'^%s([^/]+)/revisions$' % re.escape(ns), path)
        if m:
            finish(200, {'apiVersion': 'serving.knative.dev/v1', 'kind': 'RevisionList', 'items': list(s['revisions'].values()), 'metadata': {}})
        m = re.match(r'^%s([^/]+)/configurations/svpcac$' % re.escape(ns), path)
        if m:
            finish(200, {'apiVersion': 'serving.knative.dev/v1', 'kind': 'Configuration', 'metadata': {'name': 'svpcac', 'namespace': PN},
                         'spec': {'template': s['run']['spec']['template']}, 'status': {'latestCreatedRevisionName': s['run']['status']['latestCreatedRevisionName'], 'latestReadyRevisionName': s['run']['status']['latestReadyRevisionName']}})
    raise gerr(404, 'stub: unmodelled Cloud Run call %s %s' % (h.command, path))

if __name__ == '__main__':
    load()
    Srv(('::', PORT), H).serve_forever()
