// tests/caseyActionPermissions.test.js
//
/**
 * Ask Casey typed actions — P2 permission & capability matrix, negative side.
 *
 * WHAT P2 ASKS (ref/ASK_CASEY_ACTIONS_PLAN.md "#### P2"): inventory route
 * authentication, role/capability checks, row-level/firm scope and native-UI
 * visibility for every proposed kind, then "add negative tests for cross-firm
 * IDs, inactive records, insufficient roles, and permissions changing between
 * proposal and click".
 *
 * THE BOUNDARY BEING TESTED (plan, "Governing principle"): Casey proposes, the
 * staff member's own browser performs the write through the ordinary
 * authenticated route, and "the existing route ... is the final authority".
 * These tests ask that claim two questions for all 57 shipped kinds:
 *   1. what does the route actually gate on?  (section 1 — no DB needed)
 *   2. where is the normalizer stricter than the route, i.e. where is the
 *      route NOT an authority at all?        (section 2 — real MySQL)
 *
 * MEASURED FACTS THIS FILE LOCKS
 *   · Every one of the 57 kinds maps to a route gated by lib/auth.jwtOrApiKey
 *     and NOTHING else: authentication (staff-audience JWT whose user_auth
 *     starts 'authorized'), no role, no capability, no row/firm scope. The
 *     one nuance is job.code_safe.create.v1 (safe-mode S3): its route carries
 *     a capability gate on STANDARD-mode code only, which the fixed request
 *     builder never sends (code_mode pinned 'safe'), so for this kind's
 *     actual request the route is as capability-free as the rest — pinned by
 *     its own test below. The
 *     schema has no firm_id/tenant_id column at all (0 occurrences in
 *     ref/database.sql), so "cross-firm" has no expression here; the
 *     row-scope negatives are foreign-PARENT negatives instead (a subrecord
 *     id on the wrong contact, a case not linked to the appointment's
 *     contact).
 *   · A read-only View-as session is refused at the route (403
 *     view_as_read_only) — the one authorization-shaped gate in the stack.
 *   · The normalizer's staff predicates are LIKE-based on a varchar
 *     (user_auth LIKE 'authorized%', user_type <> 0) and are exercised on a
 *     real engine, because `user_auth = 1` once shipped dead (plan, course
 *     correction 5).
 *   · A5's row-version precondition really refuses a stale reviewed write —
 *     and is blind to a change made inside the same wall-clock second,
 *     because contact_phones.updated_at is a 1-second TIMESTAMP.
 *
 * GAPS FOUND, left as test.skip (fixing them is another lane's work). Each
 * skipped test is written the way the code SHOULD behave and names its gap.
 *
 * SECTION 2 IS GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE:
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3321/yc_casey_p2_test \
 *     npx jest tests/caseyActionPermissions.test.js --runInBand
 * The database name must end in _test; the suite DROPs and recreates the
 * tables it needs FROM ref/database.sql (real prod types, real CHECK
 * constraints), so its predicates cannot drift from the live schema. It
 * recreates them in beforeAll, so run it --runInBand and never concurrently
 * with tests/assistantNormalizer.mysql.test.js against the same database —
 * that suite owns users / contacts / contact_phones too.
 * Expected console noise: the post-commit fire-and-forget side effects
 * (domain events, alerting, sequences, GCal) log failures for tables this
 * harness deliberately does not create. That they are survivable is the
 * documented invariant ("Post-commit side effects ... fire-and-forget").
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// ── The matrix, kind → the browser's fixed route/method ─────────────────────
// Source: public/assistant.html's taskActionRequest / eventActionRequest /
// apptActionRequest / contactSubrecordActionRequest (read 2026-10-21). Ids are
// literals here because section 1 only needs the mount point.
const KINDS = [
  { kind: 'task.create.v1', method: 'POST', path: '/api/tasks' },
  { kind: 'task.update.v1', method: 'PATCH', path: '/api/tasks/1' },
  { kind: 'task.complete.v1', method: 'PATCH', path: '/api/tasks/1/complete' },
  { kind: 'task.cancel.v1', method: 'PATCH', path: '/api/tasks/1/delete' },
  { kind: 'task.reopen.v1', method: 'PATCH', path: '/api/tasks/1/reopen' },
  { kind: 'task.transfer.v1', method: 'PATCH', path: '/api/tasks/1/transfer' },
  { kind: 'event.create.v1', method: 'POST', path: '/api/events' },
  { kind: 'event.update.v1', method: 'PATCH', path: '/api/events/1' },
  { kind: 'event.complete.v1', method: 'PATCH', path: '/api/events/1/complete' },
  { kind: 'event.cancel.v1', method: 'PATCH', path: '/api/events/1/cancel' },
  { kind: 'appt.create.v1', method: 'POST', path: '/api/appts' },
  { kind: 'appt.update.v1', method: 'PATCH', path: '/api/appts/1' },
  { kind: 'appt.attended.v1', method: 'POST', path: '/api/appts/1/attended' },
  { kind: 'appt.no_show.v1', method: 'POST', path: '/api/appts/1/no-show' },
  { kind: 'appt.cancel.v1', method: 'POST', path: '/api/appts/cancel' },
  { kind: 'appt.reschedule.v1', method: 'POST', path: '/api/appts/reschedule' },
  { kind: 'appt.reschedule_later.v1', method: 'POST', path: '/api/appts/reschedule' },
  { kind: 'contact.phone.create.v1', method: 'POST', path: '/api/contact-phones' },
  { kind: 'contact.phone.update.v1', method: 'PATCH', path: '/api/contact-phones/1' },
  { kind: 'contact.phone.end.v1', method: 'PATCH', path: '/api/contact-phones/1' },
  { kind: 'contact.email.create.v1', method: 'POST', path: '/api/contact-emails' },
  { kind: 'contact.email.update.v1', method: 'PATCH', path: '/api/contact-emails/1' },
  { kind: 'contact.email.end.v1', method: 'PATCH', path: '/api/contact-emails/1' },
  { kind: 'contact.address.create.v1', method: 'POST', path: '/api/contact-addresses' },
  { kind: 'contact.address.update.v1', method: 'PATCH', path: '/api/contact-addresses/1' },
  { kind: 'contact.address.end.v1', method: 'PATCH', path: '/api/contact-addresses/1' },
  // A6: the Relationships tab's and the contact form Roles section's own routes.
  { kind: 'contact.relation.create.v1', method: 'POST', path: '/api/contact-relations' },
  { kind: 'contact.relation.update.v1', method: 'PATCH', path: '/api/contact-relations/1' },
  { kind: 'contact.role.create.v1', method: 'POST', path: '/api/contacts/1/roles' },
  { kind: 'contact.role.update.v1', method: 'PATCH', path: '/api/contacts/1/roles/1' },
  // A7 group A: the case and contact pages' own generic PATCH (case notes and
  // alerts share one mount).
  { kind: 'case.notes.update.v1', method: 'PATCH', path: '/api/cases/1' },
  { kind: 'case.alerts.update.v1', method: 'PATCH', path: '/api/cases/1' },
  { kind: 'contact.notes.update.v1', method: 'PATCH', path: '/api/contacts/1' },
  // A8: the case page's own Contacts routes (routes/api.cases.js).
  { kind: 'case.contact.add.v1', method: 'POST', path: '/api/cases/1/contacts' },
  { kind: 'case.contact.update.v1', method: 'PATCH', path: '/api/cases/1/contacts/2' },
  { kind: 'case.contact.remove.v1', method: 'DELETE', path: '/api/cases/1/contacts/2' },
  // A9: both pipeline kinds POST the case page's own advance (routes/api.pipeline.js).
  { kind: 'case.pipeline.advance.v1', method: 'POST', path: '/api/cases/1/pipeline/advance' },
  { kind: 'case.pipeline.move.v1', method: 'POST', path: '/api/cases/1/pipeline/advance' },
  { kind: 'job.code_safe.create.v1', method: 'POST', path: '/scheduled-jobs' },
  { kind: 'workflow.draft.v1', method: 'POST', path: '/workflows/bulk' },
  { kind: 'workflow.step_insert.v1', method: 'POST', path: '/workflows/1/steps' },
  { kind: 'workflow.step_edit.v1', method: 'PATCH', path: '/workflows/1/steps/1' },
  { kind: 'workflow.publish.v1', method: 'POST', path: '/workflows/1/publish' },
  // A17.7: the start route itself (the browser never sends use_draft).
  { kind: 'workflow.start.v1', method: 'POST', path: '/workflows/1/start' },
  { kind: 'hook.create.v1', method: 'POST', path: '/api/hooks' },
  { kind: 'sequence.step_insert.v1', method: 'POST', path: '/sequences/templates/1/steps' },
  { kind: 'sequence.publish.v1', method: 'POST', path: '/sequences/templates/1/publish' },
  // A18.4b: the native enroll route (direct template_id, trigger_data {}).
  { kind: 'sequence.enroll.v1', method: 'POST', path: '/sequences/enroll' },
  { kind: 'sms.send.v1', method: 'POST', path: '/api/phone-lines/3/sms' },
  { kind: 'email.send.v1', method: 'POST', path: '/api/mail/send' },
  // A16: the Reports editor's own create route.
  { kind: 'report.draft.v1', method: 'POST', path: '/api/reports' },
  // A20.2 / A20.3: the ingest rule editor's own routes (email shown; the
  // phone routes mirror them one-for-one — pinned by the parity test below).
  { kind: 'ingest_rule.create.v1', method: 'POST', path: '/api/email-ingest/rules' },
  { kind: 'ingest_rule.update.v1', method: 'PUT', path: '/api/email-ingest/rules/1' },
  { kind: 'ingest_rule.set_active.v1', method: 'PUT', path: '/api/email-ingest/rules/1' },
  { kind: 'ingest_rule.action_add.v1', method: 'POST', path: '/api/email-ingest/rules/1/actions' },
  { kind: 'ingest_rule.action_update.v1', method: 'PUT', path: '/api/email-ingest/rule-actions/1' },
  { kind: 'ingest_rule.action_remove.v1', method: 'DELETE', path: '/api/email-ingest/rule-actions/1' },
];

// The six original families' route files carry NO capability gate at all
// (structural test below). routes/scheduled_jobs.js is mounted too, but it is
// NOT in this list: it legitimately holds the automations.manage gate on
// STANDARD-mode code (safe-mode S2), which the job family never sends.
const CAPABILITY_FREE_ROUTE_FILES = ['routes/api.tasks.js', 'routes/api.events.js', 'routes/api.appts.js',
  'routes/api.contactPhones.js', 'routes/api.contactEmails.js', 'routes/api.contactAddresses.js',
  // A7 group A: the generic case / contact PATCH files — jwtOrApiKey only.
  // Their mounts are whole-segment (/api/contacts/:id), so they never catch
  // /api/contacts/:id/roles ahead of the role router.
  'routes/api.cases.js', 'routes/api.contacts.js',
  // A9: the pipeline routes — jwtOrApiKey only (advance, move, overrides alike).
  'routes/api.pipeline.js'];
const ROUTE_FILES = [...CAPABILITY_FREE_ROUTE_FILES, 'routes/api.contactRelations.js',
  // A6: the per-contact role routes are jwtOrApiKey only; the file's
  // requireAuth gates the role-TYPE catalog writes, which no card sends.
  'routes/api.contactRoles.js', 'routes/scheduled_jobs.js', 'routes/workflows.js', 'routes/api.hooks.js', 'routes/sequences.js',
  // A14: the comms hub's send routes — the one family whose route IS an
  // authorization seat (per-channel can_send grants, SU step-up), pinned below.
  'routes/api.phoneComms.js', 'routes/api.mail.js',
  // A16: Reports — writes need a JWT with a userId (requireUser: API keys are
  // 403), no role or capability; the per-row lock lives in reportService.
  'routes/api.reports.js',
  // A20.2 / A20.3: the ingest rule routes — jwtOrApiKey, plus the ingest code
  // gate (automations.manage) on requests that carry a code body only.
  'routes/api.emailIngest.js', 'routes/api.phoneIngest.js'];

// ── Shared HTTP harness: the real routers behind the real jwtOrApiKey ──────
// Both sections drive the SAME routers. Section 1 hands them a stub req.db
// (on a refusal path only the fire-and-forget audit insert touches it);
// section 2 hands them the real pool.
const SECRET = 'casey-p2-test-secret';

function appWith(db) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = db || { query: async () => [[], []] }; next(); });
  for (const f of ROUTE_FILES) a.use(require(path.join(REPO, f)));
  return a;
}

function token(over = {}) {
  return jwt.sign({
    sub: 2, username: 'plain', user_type: 1, aud: 'staff',
    user_auth: 'authorized', roles: ['staff'],
    ...(process.env.JWT_VERSION ? { ver: parseInt(process.env.JWT_VERSION, 10) } : {}),
    ...over,
  }, SECRET, { expiresIn: '5m' });
}

function call(a, { method, path: urlPath }, headers = {}, body = {}) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(a).listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          srv.close();
          let parsed = {};
          try { parsed = JSON.parse(data || '{}'); } catch (_) { parsed = { raw: data }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

const bearer = (t) => ({ authorization: `Bearer ${t}` });

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — the route-level gate, for all 57 kinds (no database)
// ═══════════════════════════════════════════════════════════════════════════

describe('P2 — what the canonical write route gates on (all 57 shipped kinds)', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });

  const app = appWith;

  test('the 57 kinds cover 50 distinct route+method mounts', () => {
    expect(KINDS).toHaveLength(57);
    expect(new Set(KINDS.map((k) => `${k.method} ${k.path}`)).size).toBe(50);
    // A18.3: the matrix is the shipped inventory — the action ledger's KINDS
    // registry (which every shipped kind must join, tests/assistantPromptKinds)
    // — so a new kind that skips this table fails here instead of silently.
    const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
    expect(KINDS.map((k) => k.kind).sort()).toEqual([...ledger.KINDS.keys()].sort());
  });

  test('no token: every kind is 401 — authentication is required for all 57', async () => {
    const a = app();
    for (const k of KINDS) {
      const res = await call(a, k);
      expect({ kind: k.kind, status: res.status }).toEqual({ kind: k.kind, status: 401 });
    }
  });

  // The audience guard is belt-and-braces on top of the user_auth gate
  // (Portal Slice 1, defense D1), so this token carries a VALID user_auth:
  // only the `aud` check can refuse it.
  test('a contact-audience token is 401 on every kind even with a staff user_auth', async () => {
    const a = app();
    for (const k of KINDS) {
      const res = await call(a, k, bearer(token({ aud: 'contact' })));
      expect({ kind: k.kind, status: res.status }).toEqual({ kind: k.kind, status: 401 });
    }
  });

  test('a portal-shaped token (no user_auth claim at all) is 401 on every kind', async () => {
    const a = app();
    for (const k of KINDS) {
      const res = await call(a, k, bearer(token({ user_auth: undefined })));
      expect({ kind: k.kind, status: res.status }).toEqual({ kind: k.kind, status: 401 });
    }
  });

  // user_auth is a VARCHAR, never a flag: the gate is a PREFIX test
  // (payload.user_auth.startsWith('authorized')), so the negatives must be
  // real strings, not 0/1.
  test.each(['disabled', 'pending', '', 'AUTHORIZED', 'not authorized'])(
    'a staff token whose user_auth is %p is 401 on every kind', async (value) => {
      const a = app();
      for (const k of KINDS) {
        const res = await call(a, k, bearer(token({ user_auth: value })));
        expect({ kind: k.kind, user_auth: value, status: res.status })
          .toEqual({ kind: k.kind, user_auth: value, status: 401 });
      }
    });

  test('a read-only View-as session is 403 view_as_read_only on every kind', async () => {
    const a = app();
    for (const k of KINDS) {
      const res = await call(a, k, bearer(token({ view_as: true, act: { sub: 6, username: 'IT' } })));
      expect({ kind: k.kind, status: res.status, code: res.body.code })
        .toEqual({ kind: k.kind, status: 403, code: 'view_as_read_only' });
    }
  });

  test('a LIVE View-as session is not refused by the gate (writes are the point of live mode)', async () => {
    const a = app();
    const t = token({ view_as: true, view_as_mode: 'live', act: { sub: 6, username: 'IT' } });
    const res = await call(a, { method: 'PATCH', path: '/api/tasks/1/reopen' }, bearer(t));
    expect([401, 403]).not.toContain(res.status);
  });

  // THE ROLE QUESTION. There is no role or capability gate on any of the first 33 (the two A14 send kinds are the per-channel exception, pinned below):
  // a user holding only `staff` (no admin / it / su, no capability) reaches
  // every handler. Proven per family by observing the canonical service call.
  describe('no role or capability gate: a roleless-but-staff token reaches the handler', () => {
    const cases = [
      ['task', 'services/taskService', 'completeTask', { method: 'PATCH', path: '/api/tasks/1/complete' }, {}, () => ({ id: 1 })],
      ['event', 'services/eventService', 'completeEvent', { method: 'PATCH', path: '/api/events/1/complete' }, {}, () => ({ event: { event_id: 1 } })],
      ['appt', 'services/apptService', 'markAttended', { method: 'POST', path: '/api/appts/1/attended' }, {}, () => ({ appt_id: 1 })],
      ['contact subrecord', 'services/contactPhoneService', 'updateContactPhone', { method: 'PATCH', path: '/api/contact-phones/1' }, { notes: 'x' }, () => ({ phone: { id: 1 } })],
      // A6: both relation/role write routes behind the same bare gate.
      ['contact relation', 'services/contactRelationService', 'createRelation', { method: 'POST', path: '/api/contact-relations' }, { contact_a_id: 1, contact_b_id: 2, type_code: 'spouse' }, () => ({ relation: { id: 1 } }), 201],
      ['contact role', 'services/contactRoleService', 'attachRole', { method: 'POST', path: '/api/contacts/1/roles' }, { role: 'judge', attrs: { judge_3: 'abc' } }, () => ({ id: 1 }), 201],
      // A7 group A: the generic case / contact PATCH behind the same bare gate.
      ['case text', 'services/caseService', 'updateCase', { method: 'PATCH', path: '/api/cases/1' }, { case_notes: 'x' }, () => ({ case_id: '1', updated_fields: ['case_notes'], changes: {} })],
      ['contact text', 'services/contactService', 'updateContact', { method: 'PATCH', path: '/api/contacts/1' }, { contact_notes: 'x' }, () => ({ contact_id: 1, updated_fields: ['contact_notes'], changes: {} })],
      // A8: the case-contact add/remove behind the same bare gate (the PATCH
      // writes through req.db itself — no service to observe; its gate is the
      // same jwtOrApiKey, pinned by the 401/403 sweeps above).
      ['case contact add', 'services/caseService', 'addCaseContact', { method: 'POST', path: '/api/cases/1/contacts' }, { contact_id: 2, relate_type: 'Other' }, () => ({ case_relate_id: 5 })],
      ['case contact remove', 'services/caseService', 'removeCaseContact', { method: 'DELETE', path: '/api/cases/1/contacts/2' }, {}, () => ({ removed: true })],
      // A9: the pipeline advance behind the same bare gate.
      ['case pipeline', 'services/pipelineService', 'advanceStage', { method: 'POST', path: '/api/cases/1/pipeline/advance' }, { stage: 'docs' }, () => ({ noop: false, skipped: false })],
    ];
    test.each(cases)('%s family', async (_family, modPath, fnName, route, body, result, created = 200) => {
      const mod = require(path.join(REPO, modPath));
      const spy = jest.spyOn(mod, fnName).mockImplementation(async () => result());
      try {
        for (const roles of [['staff'], [], ['attorney']]) {
          spy.mockClear();
          const res = await call(app(), route, bearer(token({ roles })), body);
          expect({ roles: roles.join(',') || 'none', status: res.status, reached: spy.mock.calls.length })
            .toEqual({ roles: roles.join(',') || 'none', status: created, reached: 1 });
        }
      } finally { spy.mockRestore(); }
    });
  });

  // Structural lock on the matrix's "auth/role gate" column: if anyone ever
  // adds requireAuth({ can: … }) to one of these files, this fails and the
  // matrix in the plan must be updated with it.
  test('none of the six original route files mounts a capability/role gate', () => {
    for (const f of CAPABILITY_FREE_ROUTE_FILES) {
      const src = read(f);
      expect({ f, requireAuth: /requireAuth/.test(src) }).toEqual({ f, requireAuth: false });
      expect({ f, can: /\bcan\(\s*req\.auth/.test(src) }).toEqual({ f, can: false });
      expect({ f, superuser: /isSuperuser|superuserOnly/.test(src) }).toEqual({ f, superuser: false });
      expect({ f, jwtOrApiKey: /require\('\.\.\/lib\/auth\.jwtOrApiKey'\)/.test(src) })
        .toEqual({ f, jwtOrApiKey: true });
    }
  });

  // A6: the relation routes mount no capability gate at all; the role routes'
  // only requireAuth is the role-TYPE catalog's (firm.settings), on exactly the
  // two type-write mounts — never on the per-contact rows a card writes.
  test('A6 route files: relations ungated; the roles file gates only the role-type catalog writes', () => {
    const rel = read('routes/api.contactRelations.js');
    expect(/requireAuth/.test(rel)).toBe(false);
    const roles = read('routes/api.contactRoles.js');
    const gated = [...roles.matchAll(/router\.(\w+)\('([^']+)',\s*firmSettingsWrite/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(gated).toEqual(['post /api/contact-role-types', 'put /api/contact-role-types/:code']);
    for (const mount of ["router.post('/api/contacts/:id/roles', jwtOrApiKey", "router.patch('/api/contacts/:id/roles/:roleRowId', jwtOrApiKey"]) {
      expect(roles).toContain(mount);
    }
  });

  // The job kind's route DOES hold a capability gate — on STANDARD-mode code
  // only. The family's fixed request builder pins code_mode 'safe', so the
  // kind's actual request clears it rolelessly; a plain-staff standard body is
  // refused. Both sides pinned behaviourally so neither can drift silently.
  // hook.create.v1 is the ONE kind whose route requires a capability for its
  // whole surface: hooks mint inbound endpoints, and api.hooks.js is gated on
  // automations.manage (requireAuth) by design. The card therefore applies
  // only for admin/IT/SU; a plain staff click is a clean refusal, not a write.
  test('hook.create.v1: capability-gated for everyone below automations.manage', async () => {
    const a = app();
    const body = { name: 'h', active: 0, targets: [{ name: 't', target_type: 'workflow', config: { workflow_id: 1 } }] };
    const staff = await call(a, { method: 'POST', path: '/api/hooks' }, bearer(token({ roles: ['staff'] })), body);
    expect(staff.status).toBe(403);
    const admin = await call(a, { method: 'POST', path: '/api/hooks' }, bearer(token({ roles: ['admin', 'staff'] })), body);
    expect([401, 403]).not.toContain(admin.status);
  });

  // A16: POST /api/reports gates on a logged-in user and nothing else — a
  // roleless staff token reaches createReport (any staff member may author a
  // report, S3; API keys are refused by requireUser), and the service — not
  // the route — owns the per-row lock, which a create never meets (new rows
  // start unlocked). The card therefore widens nothing.
  test('report.draft.v1: a roleless staff token reaches createReport', async () => {
    const reportService = require(path.join(REPO, 'services/reportService'));
    const spy = jest.spyOn(reportService, 'createReport').mockImplementation(async () => ({ id: 1 }));
    try {
      for (const roles of [['staff'], [], ['attorney']]) {
        spy.mockClear();
        const res = await call(app(), { method: 'POST', path: '/api/reports' }, bearer(token({ roles })), { report_key: 'x' });
        expect({ roles: roles.join(',') || 'none', status: res.status, reached: spy.mock.calls.length })
          .toEqual({ roles: roles.join(',') || 'none', status: 201, reached: 1 });
      }
    } finally { spy.mockRestore(); }
  });

  test('job.code_safe.create.v1: safe body is roleless, standard body is capability-gated', async () => {
    const a = app();
    const base = { type: 'one_time', job_type: 'custom_code', code: '1;', delay: '10m' };
    const safe = await call(a, { method: 'POST', path: '/scheduled-jobs' },
      bearer(token({ roles: ['staff'] })), { ...base, code_mode: 'safe' });
    expect([401, 403]).not.toContain(safe.status);
    const standard = await call(a, { method: 'POST', path: '/scheduled-jobs' },
      bearer(token({ roles: ['staff'] })), base);
    expect(standard.status).toBe(403);
    expect(standard.body.error).toMatch(/automations\.manage/);
  });

  // A14: the send routes are the exception to "no authorization": each checks
  // the caller's can_send grant on THAT line / mailbox (mailboxService.getAccess
  // — the route, not the normalizer, is the authority), refuses x-api-key
  // callers (humans only), and makes an SU step up before dispatch. A roleless
  // staff token with no grant is refused — 404, no existence oracle — and
  // nothing reaches the send services.
  test('sms.send.v1 / email.send.v1: a staff token without a send grant is refused before any send', async () => {
    const phoneComms = require(path.join(REPO, 'services/phoneCommsService'));
    const mailSend = require(path.join(REPO, 'services/mailbox/mailboxSendService'));
    const smsSpy = jest.spyOn(phoneComms, 'sendSms');
    const emailSvc = require(path.join(REPO, 'services/emailService'));
    const mailSpy = jest.spyOn(emailSvc, 'sendEmailDirect');
    try {
      const a = app();
      const sms = await call(a, { method: 'POST', path: '/api/phone-lines/3/sms' }, bearer(token({ roles: ['staff'] })), { to: '3135550001', message: 'hi' });
      expect(sms.status).toBe(404);
      const mail = await call(a, { method: 'POST', path: '/api/mail/send' }, bearer(token({ roles: ['staff'] })),
        { mailbox_id: 1, to: ['pat@example.com'], subject: 's', body_text: 'b' });
      expect(mail.status).toBe(404);
      expect(smsSpy).not.toHaveBeenCalled();
      expect(mailSpy).not.toHaveBeenCalled();
      expect(typeof mailSend.resolveIdentity).toBe('function');
    } finally { smsSpy.mockRestore(); mailSpy.mockRestore(); }
  });

  // A20.2 / A20.3: the ingest rule routes gate on authentication, plus the
  // ingest code gate on a request that CARRIES a code body (match or
  // transform): a roleless staff token reaches createRule with a conditions
  // body and is refused 403 with a code body — so a Casey code card applies
  // only for automations.manage holders, by the route, not the card.
  test.each(['email', 'phone'])('ingest_rule (%s): conditions reach the service rolelessly; a code body needs automations.manage', async (ch) => {
    const svc = require(path.join(REPO, `services/${ch}IngestRuleService`));
    const spy = jest.spyOn(svc, 'createRule').mockImplementation(async () => ({ id: 1, actions: [] }));
    try {
      const a = app();
      const base = { name: 'r', active: 0, match_mode: 'conditions', match_config: { operator: 'and', conditions: [{ path: 'subject', op: 'contains', value: 'x' }] } };
      for (const roles of [['staff'], [], ['attorney']]) {
        spy.mockClear();
        const res = await call(a, { method: 'POST', path: `/api/${ch}-ingest/rules` }, bearer(token({ roles })), base);
        expect({ roles: roles.join(',') || 'none', status: res.status, reached: spy.mock.calls.length })
          .toEqual({ roles: roles.join(',') || 'none', status: 201, reached: 1 });
      }
      spy.mockClear();
      const code = await call(a, { method: 'POST', path: `/api/${ch}-ingest/rules` }, bearer(token({ roles: ['staff'] })),
        { ...base, match_mode: 'code', match_config: { code: 'return true;' } });
      expect(code.status).toBe(403);
      expect(code.body.missingCapability).toBe('automations.manage');
      expect(spy).not.toHaveBeenCalled();
      const admin = await call(a, { method: 'POST', path: `/api/${ch}-ingest/rules` }, bearer(token({ roles: ['admin', 'staff'] })),
        { ...base, transform_mode: 'code', transform_config: { code: 'return input;' } });
      expect(admin.status).toBe(201);
    } finally { spy.mockRestore(); }
  });

  test('the phone ingest rule routes mirror the email ones the ingest cards use', () => {
    const email = read('routes/api.emailIngest.js');
    const phone = read('routes/api.phoneIngest.js');
    for (const k of KINDS.filter((x) => x.kind.startsWith('ingest_rule.'))) {
      const route = k.path.replace('/1', '/:id').replace('/1/', '/:id/');
      const verb = k.method.toLowerCase();
      expect({ k: k.kind, email: email.includes(`router.${verb}('${route}'`) }).toEqual({ k: k.kind, email: true });
      expect({ k: k.kind, phone: phone.includes(`router.${verb}('${route.replace('email-ingest', 'phone-ingest')}'`) }).toEqual({ k: k.kind, phone: true });
    }
  });

  // Row/firm scope: there is none to test, and this is why.
  test('the schema has no firm/tenant column, so no kind can carry a cross-firm scope', () => {
    const dump = read('ref/database.sql');
    expect(dump.match(/`(?:firm_id|tenant_id)`/g)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — normalizer vs route, on a real engine
// ═══════════════════════════════════════════════════════════════════════════

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['users', 'contacts', 'cases', 'case_relate', 'tasks', 'log',
  'scheduled_jobs', 'appts', 'events', 'contact_phones'];

/** CREATE TABLE + its ALTER blocks for one table, line-based out of the dump.
 *  Line-based on purpose: column COMMENTs contain ';', so a regex to the next
 *  semicolon truncates mid-COMMENT and the CREATE fails. */
function dumpBlocks(dumpLines, table) {
  const out = [];
  let cur = null;
  const start = new RegExp(`^(?:CREATE TABLE|ALTER TABLE) \`${table}\`[ (]*$`);
  for (const line of dumpLines) {
    if (cur == null) { if (start.test(line)) cur = [line]; continue; }
    cur.push(line);
    if (/;\s*$/.test(line)) { out.push(cur.join('\n').replace(/;\s*$/, '')); cur = null; }
  }
  return out;
}

d('P2 — Ask Casey action permissions against a real engine', () => {
  const svc = require('../services/assistantService');
  const taskService = require('../services/taskService');
  const eventService = require('../services/eventService');
  const apptService = require('../services/apptService');
  const phoneSvc = require('../services/contactPhoneService');
  const calendarTypeService = require('../services/calendarTypeService');
  const { withTransaction } = require('../lib/withTransaction');

  let pool;
  let api;                       // the real routers over the real pool
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const one = async (sql, p) => (await pool.query(sql, p))[0][0];
  let typeSpies = [];
  const OLD_SECRET = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    pool = mysql.createPool({ uri: URL_, connectionLimit: 5, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    // Prod builds req.db the same way (startup/db.js) — services call
    // db.withTransaction, so the harness must carry it.
    pool.withTransaction = (fn, opts) => withTransaction(pool, fn, opts);
    api = appWith(pool);

    const dumpLines = read('ref/database.sql').split('\n');
    for (const t of [...TABLES].reverse()) await q(`DROP TABLE IF EXISTS \`${t}\``);
    for (const t of TABLES) {
      const blocks = dumpBlocks(dumpLines, t);
      if (!blocks.length) throw new Error(`ref/database.sql has no CREATE TABLE for ${t}`);
      for (const b of blocks) await pool.query(b);
    }

    // does_appts = 1 requires default_phone — the live CHECK constraint
    // chk_does_appts_requires_phone came along with the real CREATE.
    // users.user is AUTO_INCREMENT and the production sql_mode has no
    // NO_AUTO_VALUE_ON_ZERO, so an explicit 0 gets RENUMBERED to the next
    // auto value. The Automations pseudo-user (user 0) therefore has to be
    // renumbered into place after the insert, exactly as a live restore would.
    await q(`INSERT INTO users (user, username, user_name, user_fname, user_lname, user_initials,
                                user_auth, user_type, does_appts, ringcentral, default_phone) VALUES
      (9, 'auto',  'Automations', 'A', 'A', 'AAA', 'authorized',       0, 0, 0, NULL),
      (1, 'host',  'Host',        'H', 'H', 'HHH', 'authorized',       1, 1, 0, '2485550101'),
      (2, 'plain', 'Plain',       'P', 'P', 'PPP', 'authorized',       1, 0, 0, NULL),
      (3, 'dis',   'Disabled',    'D', 'D', 'DDD', 'disabled',         1, 1, 0, '2485550103'),
      (4, 'sutier','SuTier',      'S', 'S', 'SSS', 'authorized - SU',  1, 0, 0, NULL)`);
    await q("UPDATE users SET user = 0 WHERE username = 'auto'");
    expect(await one("SELECT user_type FROM users WHERE user = 0")).toEqual({ user_type: 0 });
    await q(`INSERT INTO contacts (contact_id, contact_name) VALUES
      (1309, 'Reviewed client'), (1400, 'Unrelated client')`);
    await q("INSERT INTO cases (case_id, case_number, case_number_full) VALUES ('C1', '26-1', '26-10001-abc')");
    // Case C1 belongs to contact 1400, NOT to 1309 — the foreign-parent fixture.
    await q('INSERT INTO case_relate (case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (?, ?, ?)',
      ['C1', 1400, 'Primary']);
    typeSpies = [
      jest.spyOn(calendarTypeService, 'resolveForCreate').mockResolvedValue({ type_key: 'consult', kind: 'meeting' }),
      jest.spyOn(calendarTypeService, 'getType').mockResolvedValue({ type_key: 'consult', label: 'Consultation', kind: 'meeting', active: 1, singleton: 0 }),
    ];
  });

  afterAll(async () => {
    typeSpies.forEach((s) => s.mockRestore());
    process.env.JWT_SECRET = OLD_SECRET;
    if (pool) await pool.end();
  });

  const ev = (rows) => [{ id: 'q1', kind: 'sql.read', purpose: 'fixture', rows }];
  const ref = [{ query_id: 'q1', row_number: 1 }];
  const draft = (value, evidence, opts) => svc.normalizeActionDraft(pool, value, evidence, opts || {});

  // ── 2a. staff eligibility: a varchar predicate, on the engine ────────────

  describe('assignee / provider eligibility (the predicate that shipped dead once)', () => {
    const createDraft = (assignee) => draft(
      { kind: 'task.create.v1', title: 'Call client', description: 'Why', assignee_user_id: assignee, evidence: ref },
      ev([{ contact_id: 1309 }]), { currentUserId: 2 });

    test('task.create: only an authorized, non-automation user is proposable', async () => {
      await expect(createDraft(2)).resolves.toMatchObject({ assignee: { user_id: 2, label: 'Plain' } });
      // 'authorized - SU' passes because the predicate is a LIKE prefix.
      await expect(createDraft(4)).resolves.toMatchObject({ assignee: { user_id: 4 } });
      for (const bad of [0, 3, 99]) {
        await expect(createDraft(bad)).rejects.toThrow(/assignee is unavailable/);
      }
      // The predicate that matched nothing live: the engine, on these rows.
      expect(await q("SELECT user FROM users WHERE user_auth = 1 AND user_type <> 0")).toEqual([]);
    });

    test('task.transfer: same predicate, and a terminal task cannot be transferred', async () => {
      const t = await taskService.createTask(pool, { from: 2, to: 2, title: 'Transferable', desc: 'd', send_assignment_email: false });
      const evidence = ev([{ task_id: t.task_id }]);
      const transfer = (assignee) => draft({ kind: 'task.transfer.v1', task_id: t.task_id, assignee_user_id: assignee, evidence: ref }, evidence);
      await expect(transfer(1)).resolves.toMatchObject({ assignee: { user_id: 1 } });
      for (const bad of [0, 3, 99]) await expect(transfer(bad)).rejects.toThrow(/assignee is unavailable|assignee is invalid/);
      await expect(transfer(2)).rejects.toThrow(/already assigned to that user/);
      await q("UPDATE tasks SET task_status = 'Completed' WHERE task_id = ?", [t.task_id]);
      await expect(transfer(1)).rejects.toThrow(/completed task cannot be transferred/);
    });

    test('event reminder assignee uses the same predicate', async () => {
      const base = {
        kind: 'event.create.v1', event_type: 'Hearing', event_title: 'Hearing', event_date: '2099-03-03',
        event_all_day: true, event_time: null, event_length: null, event_location: '', event_link: '',
        event_note: '', event_with: null, link: null, evidence: ref,
      };
      const evidence = ev([{ contact_id: 1309 }]);
      // resolveForCreate is spied to a MEETING kind for the appt tests; events
      // refuse meeting types, so point it at a deadline for this one.
      typeSpies[0].mockResolvedValueOnce({ type_key: 'hearing', kind: 'deadline' });
      typeSpies[1].mockResolvedValueOnce({ type_key: 'hearing', label: 'Hearing', kind: 'deadline', active: 1 });
      await expect(draft({ ...base, reminder: { to: 3, date: '2099-03-01' } }, evidence))
        .rejects.toThrow(/reminder assignee is unavailable/);
    });

    // GAP G4: eventDraftProvider checks only `does_appts = 1` — not
    // user_auth / user_type — so Casey can propose a DISABLED provider as an
    // event's availability scope, which the native dialog never offers
    // (public/eventform.html filters `does_appts && active !== false`).
    test.skip('event availability scope refuses a disabled provider (GAP G4: does_appts only)', async () => {
      typeSpies[0].mockResolvedValueOnce({ type_key: 'hearing', kind: 'deadline' });
      typeSpies[1].mockResolvedValueOnce({ type_key: 'hearing', label: 'Hearing', kind: 'deadline', active: 1 });
      await expect(draft({
        kind: 'event.create.v1', event_type: 'Hearing', event_title: 'Timed', event_date: '2099-03-03',
        event_all_day: false, event_time: '10:00', event_length: 60, event_location: '', event_link: '',
        event_note: '', event_with: 3, reminder: null, link: null, evidence: ref,
      }, ev([{ contact_id: 1309 }]))).rejects.toThrow(/provider is unavailable/);
    });

    test('appointment provider: authorized + hosting + non-automation', async () => {
      const appt = (provider) => draft({
        kind: 'appt.create.v1', contact_id: 1309, appt_type: 'Consultation', appt_length: 30,
        appt_platform: 'Telephone', appt_date: '2099-01-05 10:00', appt_with: provider, evidence: ref,
      }, ev([{ contact_id: 1309 }]));
      await expect(appt(1)).resolves.toMatchObject({ provider: { user_id: 1, label: 'Host' } });
      for (const bad of [0, 2, 3, 99]) await expect(appt(bad)).rejects.toThrow(/provider is (?:unavailable|invalid)/);
    });
  });

  // ── 2b. row scope: foreign parents, since there is no firm axis ──────────

  describe('row scope — foreign parent / unrelated record ids', () => {
    test('appt.create refuses a case that is not linked to the reviewed contact', async () => {
      await expect(draft({
        kind: 'appt.create.v1', contact_id: 1309, case_id: 'C1', appt_type: 'Consultation', appt_length: 30,
        appt_platform: 'Telephone', appt_date: '2099-01-05 10:00', appt_with: 1, evidence: ref,
      }, ev([{ contact_id: 1309 }]))).rejects.toThrow(/case is not linked to the selected contact/);
    });

    test('contact subrecord update refuses a phone id that belongs to another contact', async () => {
      const ins = await q("INSERT INTO contact_phones (contact_id, phone, label, is_primary, start_date, notes) VALUES (1309, '2485551600', 'Mobile', 1, '2026-01-01', 'orig')");
      const id = ins.insertId;
      // Evidence that names the WRONG parent for a real record id.
      await expect(draft({ kind: 'contact.phone.update.v1', contact_id: 1400, phone_id: id, changes: { notes: 'x' }, evidence: ref },
        ev([{ contact_id: 1400, phone_id: id }]))).rejects.toThrow(/target is unavailable on that contact/);
      // And evidence for the right parent but a record id the evidence never named.
      await expect(draft({ kind: 'contact.phone.update.v1', contact_id: 1309, phone_id: id + 999, changes: { notes: 'x' }, evidence: ref },
        ev([{ contact_id: 1309, phone_id: id }]))).rejects.toThrow(/evidence does not identify the target record/);
      await q('DELETE FROM contact_phones WHERE id = ?', [id]);
    });

    test('task link refuses a contact id that does not exist', async () => {
      await expect(draft({
        kind: 'task.create.v1', title: 'T', description: 'D', assignee_user_id: 2,
        link: { type: 'contact', id: '987654' }, evidence: ref,
      }, ev([{ contact_id: 1309 }]), { currentUserId: 2 })).rejects.toThrow(/link/i);
    });
  });

  // ── 2c. terminal state at PROPOSAL time ─────────────────────────────────

  describe('terminal state is refused at proposal time', () => {
    test('task: complete/cancel/reopen/update respect the stored status', async () => {
      const t = await taskService.createTask(pool, { from: 2, to: 2, title: 'Lifecycle', desc: 'd', send_assignment_email: false });
      const evidence = ev([{ task_id: t.task_id }]);
      const kind = (k, extra) => draft({ kind: k, task_id: t.task_id, evidence: ref, ...extra }, evidence);
      await expect(kind('task.reopen.v1')).rejects.toThrow(/Only completed or canceled tasks can be reopened/);
      await q("UPDATE tasks SET task_status = 'Completed' WHERE task_id = ?", [t.task_id]);
      await expect(kind('task.complete.v1')).rejects.toThrow(/already completed/);
      await expect(kind('task.update.v1', { changes: { title: 'New' } })).rejects.toThrow(/completed task cannot be edited/);
      await expect(kind('task.reopen.v1')).resolves.toMatchObject({ kind: 'task.reopen.v1' });
      await q("UPDATE tasks SET task_status = 'Deleted' WHERE task_id = ?", [t.task_id]);
      await expect(kind('task.cancel.v1')).rejects.toThrow(/already canceled/);
      await expect(kind('task.complete.v1')).rejects.toThrow(/deleted task cannot be completed/);
    });

    test('event: only a current Scheduled, non-superseded event is proposable', async () => {
      const ins = await q("INSERT INTO events (event_title, event_type, event_date, event_status, event_all_day) VALUES ('Live', 'Call', '2099-01-05', 'Scheduled', 0)");
      const id = ins.insertId;
      const evidence = ev([{ event_id: id }]);
      const kind = (k) => draft({ kind: k, event_id: id, evidence: ref }, evidence);
      await expect(kind('event.cancel.v1')).resolves.toMatchObject({ kind: 'event.cancel.v1' });
      await q("UPDATE events SET event_status = 'Canceled' WHERE event_id = ?", [id]);
      for (const k of ['event.complete.v1', 'event.cancel.v1']) {
        await expect(kind(k)).rejects.toThrow(/Only a current Scheduled event/);
      }
      // A superseded row reads Scheduled but is dead (U6c): also refused.
      await q("UPDATE events SET event_status = 'Scheduled', superseded_by_event_id = ? WHERE event_id = ?", [id, id]);
      await expect(kind('event.complete.v1')).rejects.toThrow(/Only a current Scheduled event/);
    });

    test('appointment: per-kind allowed statuses, and a blank status is refused', async () => {
      const mk = async (status) => (await q(
        "INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', ?, 1)",
        [status])).insertId;
      const kind = (k, id, extra) => draft({ kind: k, appt_id: id, evidence: ref, ...extra }, ev([{ appt_id: id }]));
      const canceled = await mk('Canceled');
      for (const k of ['appt.update.v1', 'appt.attended.v1', 'appt.no_show.v1']) {
        await expect(kind(k, canceled, k === 'appt.update.v1' ? { changes: { note: 'n' } } : {}))
          .rejects.toThrow(/status Canceled cannot be used/);
      }
      const resched = await mk('Rescheduled');
      await expect(kind('appt.cancel.v1', resched)).rejects.toThrow(/status Rescheduled cannot be used/);
      const blank = await mk('');
      await expect(kind('appt.attended.v1', blank)).rejects.toThrow(/status unknown cannot be used/);
      // The corrections the native UI offers stay proposable.
      const attended = await mk('Attended');
      await expect(kind('appt.no_show.v1', attended)).resolves.toMatchObject({ kind: 'appt.no_show.v1' });
      await expect(kind('appt.cancel.v1', attended)).resolves.toMatchObject({ kind: 'appt.cancel.v1' });
    });

    test('contact subrecord: an ended row cannot be updated or ended again', async () => {
      const ins = await q("INSERT INTO contact_phones (contact_id, phone, label, start_date, end_date, end_reason) VALUES (1309, '2485551700', 'Mobile', '2026-01-01', '2026-06-01', 'ended')");
      const id = ins.insertId;
      for (const k of ['contact.phone.update.v1', 'contact.phone.end.v1']) {
        await expect(draft({
          kind: k, contact_id: 1309, phone_id: id, evidence: ref,
          ...(k.includes('update') ? { changes: { notes: 'x' } } : { end_date: '2026-07-01', end_reason: 'ended' }),
        }, ev([{ contact_id: 1309, phone_id: id }]))).rejects.toThrow(/Only an active contact subrecord/);
      }
      await q('DELETE FROM contact_phones WHERE id = ?', [id]);
    });
  });

  // ── 2d. the route as "the final authority" — where it holds ─────────────

  describe('the write route refuses a reviewed state that changed (where it does)', () => {
    test('task complete/transfer: the service re-reads and refuses', async () => {
      const t = await taskService.createTask(pool, { from: 2, to: 2, title: 'Race', desc: 'd', send_assignment_email: false });
      await q("UPDATE tasks SET task_status = 'Completed' WHERE task_id = ?", [t.task_id]);
      await expect(taskService.completeTask(pool, t.task_id, 2, { via: 'app' })).rejects.toThrow(/already completed/);
      await expect(taskService.transferTask(pool, t.task_id, 1, 2)).rejects.toThrow(/Cannot transfer a Completed task/);
    });

    // Two redundant guards by design (course correction 1): the pre-read
    // status check AND the conditional UPDATE. Either one alone keeps this
    // test green, so only removing BOTH kills it — verified 2026-10-21.
    test('appointment cancel / reschedule: the conditional UPDATE refuses a repeat (409)', async () => {
      const id = (await q("INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', 'Canceled', 1)")).insertId;
      const err = await apptService.cancelAppt(pool, { appt_id: id, actingUserId: 2, source: 'staff', cancel_gcal: false })
        .then(() => null, (e) => e);
      expect(err && err.code).toBe('appt_status_conflict');
      expect(err.status).toBe(409);
      const id2 = (await q("INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', 'Rescheduled', 1)")).insertId;
      const err2 = await apptService.rescheduleLater(pool, { appt_id: id2, actingUserId: 2, source: 'staff' })
        .then(() => null, (e) => e);
      expect(err2 && err2.code).toBe('appt_status_conflict');
    });

    // GAP G5: the cancel and reschedule routes map the service's 409
    // apptStatusConflict to HTTP 500 (`err.message.includes('not found') ?
    // 404 : 500` — they never read err.status, unlike PATCH /api/appts/:id),
    // so the reviewed card shows a server error instead of "someone already
    // did this". Measured over the real router + real pool.
    test('MEASURED: a repeat cancel through the real route is refused — as HTTP 500 (GAP G5)', async () => {
      const id = (await q("INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', 'Canceled', 1)")).insertId;
      const res = await call(api, { method: 'POST', path: '/api/appts/cancel' }, bearer(token()),
        { appt: id, note: '', sms: false, email: false, confirm_message: '', cancel_gcal: false, create_task: false });
      expect(res.body.message).toMatch(/already Canceled/);
      expect(res.status).toBe(500);                 // ← should be 409; see GAP G5
      expect(await one('SELECT appt_status FROM appts WHERE appt_id = ?', [id]))
        .toEqual({ appt_status: 'Canceled' });       // nothing changed
    });

    test.skip('the appointment cancel route returns 409 on a status conflict (GAP G5)', async () => {
      const id = (await q("INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', 'Canceled', 1)")).insertId;
      const res = await call(api, { method: 'POST', path: '/api/appts/cancel' }, bearer(token()),
        { appt: id, cancel_gcal: false });
      expect(res.status).toBe(409);
    });

    test('contact subrecord: the A5 row-version precondition refuses a stale reviewed write', async () => {
      const id = (await q("INSERT INTO contact_phones (contact_id, phone, label, is_primary, start_date, notes) VALUES (1309, '2485551800', 'Mobile', 1, '2026-01-01', 'orig')")).insertId;
      const evidence = ev([{ contact_id: 1309, phone_id: id }]);
      // mysql2 hands a TIMESTAMP back as a Date; the proposal carries its ISO form.
      const stored = await one('SELECT updated_at FROM contact_phones WHERE id = ?', [id]);
      expect(stored.updated_at).toBeInstanceOf(Date);
      const proposal = await draft({ kind: 'contact.phone.update.v1', contact_id: 1309, phone_id: id, changes: { notes: 'reviewed' }, evidence: ref }, evidence);
      expect(proposal.target.expected_updated_at).toBe(stored.updated_at.toISOString());

      // Someone else edits the row in a LATER second (updated_at is a
      // 1-second TIMESTAMP ... ON UPDATE CURRENT_TIMESTAMP).
      await new Promise((r) => setTimeout(r, 1100));
      await q("UPDATE contact_phones SET notes = 'someone else' WHERE id = ?", [id]);
      await expect(phoneSvc.updateContactPhone(pool, id, { notes: proposal.changes.notes },
        { updatedBy: 2, expectedUpdatedAt: proposal.target.expected_updated_at }))
        .rejects.toThrow(/Concurrent phone update detected/);

      // A fresh proposal applies.
      const fresh = await draft({ kind: 'contact.phone.update.v1', contact_id: 1309, phone_id: id, changes: { notes: 'reviewed' }, evidence: ref }, evidence);
      const res = await phoneSvc.updateContactPhone(pool, id, { notes: fresh.changes.notes },
        { updatedBy: 2, expectedUpdatedAt: fresh.target.expected_updated_at });
      expect(res.phone.notes).toBe('reviewed');
      await q('DELETE FROM contact_phones WHERE id = ?', [id]);
    });

    // GAP G3 (narrow): the precondition's resolution is one second, so a
    // change made inside the same second as the proposal's read is invisible
    // to it. Measured, not inferred — two UPDATEs in one second leave
    // updated_at byte-identical.
    test('MEASURED: the row-version precondition is blind inside one second', async () => {
      const id = (await q("INSERT INTO contact_phones (contact_id, phone, label, start_date, notes) VALUES (1309, '2485551900', 'Mobile', '2026-01-01', 'a')")).insertId;
      await q("UPDATE contact_phones SET notes = 'b' WHERE id = ?", [id]);
      const before = await one('SELECT updated_at FROM contact_phones WHERE id = ?', [id]);
      await q("UPDATE contact_phones SET notes = 'c' WHERE id = ?", [id]);
      const after = await one('SELECT updated_at FROM contact_phones WHERE id = ?', [id]);
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
      expect((await one('SELECT notes FROM contact_phones WHERE id = ?', [id])).notes).toBe('c');
      await q('DELETE FROM contact_phones WHERE id = ?', [id]);
    });
  });

  // ── 2e. the gaps: the route is NOT the authority ────────────────────────
  //
  // Each of these drives the canonical service the reviewed card calls and
  // currently SUCCEEDS on a state the normalizer refuses at proposal time.
  // Written the way the code should behave; skipped because the fix is
  // another lane's.

  describe('GAPS — writes the normalizer refuses but the route accepts', () => {
    // GAP G1: taskService.updateTask has no terminal-state guard (only the
    // task_due → status recompute is guarded), so a card reviewed while the
    // task was open still edits it after someone completed it.
    test.skip('PATCH /api/tasks/:id refuses a Completed task (GAP G1)', async () => {
      const t = await taskService.createTask(pool, { from: 2, to: 2, title: 'G1', desc: 'd', send_assignment_email: false });
      await q("UPDATE tasks SET task_status = 'Completed' WHERE task_id = ?", [t.task_id]);
      await expect(taskService.updateTask(pool, t.task_id, { task_title: 'Edited after completion' }, 2))
        .rejects.toThrow(/completed/i);
    });

    // GAP G2a: completeEvent guards only 'already Completed' and cancelEvent
    // only 'already Canceled', and neither looks at superseded_by_event_id —
    // so a Canceled event can be Completed, a Completed one Canceled, and a
    // superseded (dead) row either.
    test.skip('PATCH /api/events/:id/complete refuses a Canceled event (GAP G2a)', async () => {
      const id = (await q("INSERT INTO events (event_title, event_type, event_date, event_status, event_all_day) VALUES ('G2a', 'Call', '2099-01-05', 'Canceled', 0)")).insertId;
      await expect(eventService.completeEvent(pool, id, 2, {})).rejects.toThrow(/Canceled/);
    });

    test.skip('PATCH /api/events/:id/cancel refuses a superseded event (GAP G2b)', async () => {
      const id = (await q("INSERT INTO events (event_title, event_type, event_date, event_status, event_all_day, superseded_by_event_id) VALUES ('G2b', 'Call', '2099-01-06', 'Scheduled', 0, 1)")).insertId;
      await expect(eventService.cancelEvent(pool, id, 2, { delete_gcal: false })).rejects.toThrow(/superseded/);
    });

    // GAP G2c: updateEvent's supersession guard only fires when the patch
    // carries event_status — which a Casey update never does.
    test.skip('PATCH /api/events/:id refuses a field edit on a superseded event (GAP G2c)', async () => {
      const id = (await q("INSERT INTO events (event_title, event_type, event_date, event_status, event_all_day, superseded_by_event_id) VALUES ('G2c', 'Call', '2099-01-07', 'Scheduled', 0, 1)")).insertId;
      await expect(eventService.updateEvent(pool, id, { event_title: 'Edited after supersession' }, 2))
        .rejects.toThrow(/superseded/);
    });

    // GAP G2d: markAttended / markNoShow guard only the same-status repeat, so
    // a Canceled appointment can be marked Attended and a Rescheduled
    // predecessor can be marked No Show — which erases the only marker that
    // it was superseded (appts carry no pointer on the predecessor).
    test.skip('POST /api/appts/:id/attended refuses a Canceled appointment (GAP G2d)', async () => {
      const id = (await q("INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', 'Canceled', 1)")).insertId;
      await expect(apptService.markAttended(pool, { appt_id: id, actingUserId: 2, source: 'staff' }))
        .rejects.toThrow(/Canceled/);
    });

    test.skip('POST /api/appts/:id/no-show refuses a Rescheduled appointment (GAP G2d)', async () => {
      const id = (await q("INSERT INTO appts (appt_client_id, appt_type, appt_date, appt_length, appt_platform, appt_status, appt_with) VALUES (1309, 'Consultation', '2099-02-02 15:00:00', 30, 'Telephone', 'Rescheduled', 1)")).insertId;
      await expect(apptService.markNoShow(pool, { appt_id: id, enroll: false, actingUserId: 2, source: 'staff' }))
        .rejects.toThrow(/Rescheduled/);
    });

    // GAP G6: createTask and createAppt never validate the actor's chosen
    // assignee / provider at all — the normalizer's predicate is the ONLY
    // check, and it ran when the card was built. Disable a user between
    // proposal and click and the write still lands on them.
    test.skip('POST /api/tasks refuses an assignee who is no longer authorized (GAP G6)', async () => {
      await expect(taskService.createTask(pool, { from: 2, to: 3, title: 'G6', desc: 'd', send_assignment_email: false }))
        .rejects.toThrow(/assignee|authorized/i);
    });

    test.skip('POST /api/tasks refuses an assignee who does not exist (GAP G6)', async () => {
      await expect(taskService.createTask(pool, { from: 2, to: 987, title: 'G6b', desc: 'd', send_assignment_email: false }))
        .rejects.toThrow(/not found|assignee/i);
    });
  });
});
