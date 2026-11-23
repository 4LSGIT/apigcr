// tests/caseySensitivity.test.js
//
/**
 * Casey v2 S0 — lib/caseySensitivity.js: tier, proposable, autoGet.
 * Design: ref/CASEY_V2_DESIGN.md §4.4 defaults, §8.10 lists.
 *
 * WHAT IS LOCKED
 *   - The defaults: SU → T3 (GET included — an SU GET is a T3 card, never an
 *     auto read); DELETE → T2; a T2 path WORD → T2; other writes → T1; GET → T0.
 *   - proposable is false outside the staff classes, for multipart routes, and
 *     for every NEVER_PROPOSABLE match — SU routes included (the DB console).
 *   - autoGet is null for a write, false outside the staff classes, false for
 *     SU, false for NEVER_AUTO_GET; a closed staff GET is also not proposable
 *     (a credential-returning read must not become a card either).
 *   - T2 words match whole literal path segments, never params or substrings
 *     (`/api/users` is T2; `/api/userstats` is not; `:userId` is not).
 *   - The three lists as exact snapshots (regex sources / words): a change is a
 *     deliberate review, like CTA_FN_DENYLIST.
 *
 * Run: npx jest tests/caseySensitivity.test.js
 */
'use strict';

const S = require('../lib/caseySensitivity');
const { classify } = S;

const staff = (method, path, extra = {}) => classify({ method, path, authClass: 'staff', ...extra });

describe('tier defaults (design §4.4)', () => {
  test('GET on a staff route is T0 and auto', () => {
    expect(staff('GET', '/api/cases')).toEqual({ tier: 0, proposable: true, autoGet: true, reason: 'read' });
  });
  test('ordinary write is T1', () => {
    expect(staff('POST', '/api/tasks')).toMatchObject({ tier: 1, proposable: true, autoGet: null });
    expect(staff('PATCH', '/api/cases/:id')).toMatchObject({ tier: 1 });
  });
  test('every DELETE is at least T2', () => {
    expect(staff('DELETE', '/api/tasks/:id')).toMatchObject({ tier: 2, reason: 'DELETE' });
  });
  test('a T2 word anywhere in the literal path makes a write T2', () => {
    expect(staff('POST', '/api/mail/send')).toMatchObject({ tier: 2, reason: 'sensitive path word' });
    expect(staff('POST', '/api/phone-lines/:id/sms')).toMatchObject({ tier: 2 });
    expect(staff('POST', '/sequences/enroll')).toMatchObject({ tier: 2 });
    expect(staff('POST', '/workflows/:id/publish')).toMatchObject({ tier: 2 });
    expect(staff('POST', '/api/cases/:id/merge')).toMatchObject({ tier: 2 });
  });
  test('words are whole literal segments or hyphen parts — not substrings, not params', () => {
    expect(staff('POST', '/ringcentral/send-sms')).toMatchObject({ tier: 2 });
    expect(staff('POST', '/api/userstats')).toMatchObject({ tier: 1 });
    expect(staff('POST', '/api/sending-log')).toMatchObject({ tier: 1 });
    expect(staff('POST', '/api/x/:users')).toMatchObject({ tier: 1 });
    expect(staff('POST', '/api/users')).toMatchObject({ tier: 2 });
  });
  test('SU is T3 whatever the method, and an SU GET is a card, not an auto read', () => {
    expect(classify({ method: 'POST', path: '/api/admin/users', authClass: 'su' })).toMatchObject({ tier: 3, proposable: true, autoGet: null });
    expect(classify({ method: 'GET', path: '/api/admin/users', authClass: 'su' })).toMatchObject({ tier: 3, proposable: true, autoGet: false });
    expect(classify({ method: 'GET', path: '/api/cta', authClass: 'su' })).toMatchObject({ tier: 3, autoGet: false });
  });
  test('router.all (_ALL) is a write and never a card, even on a staff route', () => {
    expect(classify({ method: '_ALL', path: '/ringcentral/send-sms', authClass: 'public' })).toMatchObject({ tier: 2, proposable: false, autoGet: null });
    expect(classify({ method: '_ALL', path: '/api/anything', authClass: 'staff' })).toMatchObject({ tier: 1, proposable: false, autoGet: null, reason: 'router.all — no card method' });
  });
  test('the sends the review found at T1 are T2 words now', () => {
    for (const p of ['/api/hooks/:id/live-test', '/sequences/enrollments/:id/fire-next', '/executions/:id/resume', '/api/triggers/replay', '/workflows/test-step']) {
      expect([p, staff('POST', p).tier]).toEqual([p, 2]);
    }
  });
});

describe('proposable', () => {
  test('false outside the staff classes', () => {
    for (const cls of ['public', 'key', 'portal', 'unknown']) {
      expect(classify({ method: 'POST', path: '/api/tasks', authClass: cls }).proposable).toBe(false);
      expect(classify({ method: 'GET', path: '/api/tasks', authClass: cls }).autoGet).toBe(false);
    }
  });
  test('false for multipart routes (the card carries JSON)', () => {
    expect(staff('POST', '/api/esign/send', { multipart: true })).toMatchObject({ tier: 2, proposable: false });
  });
  test('false for every never-proposable family, SU consoles included', () => {
    const closed = [
      ['POST', '/admin/db/query', 'su'], ['POST', '/admin/db/batch', 'su'], ['POST', '/admin/api-tester/send-request', 'su'],
      ['POST', '/admin/elevate', 'su'], ['POST', '/internal/sms/send', 'staff'], ['POST', '/hooks/:slug', 'public'],
      ['POST', '/webhooks/esign/zoho', 'public'], ['POST', '/auth/reset-password', 'public'], ['POST', '/login', 'public'],
      ['POST', '/api/auth/change-password', 'staff'], ['POST', '/api/impersonation/mode', 'staff'],
      ['POST', '/api/impersonation/users/:id/start', 'staff:can'], ['POST', '/api/assistant/execute', 'staff'],
      ['GET', '/api/casey/catalog', 'su'], ['POST', '/api/readonly/sql', 'key'], ['POST', '/api/temp/clio/request', 'key'],
      // S0 review additions
      ['GET', '/db-jwt', 'staff'], ['POST', '/process-job/:id', 'staff'], ['_ALL', '/process-jobs', 'staff'], ['POST', '/process-domain-event/:id', 'staff'],
      ['POST', '/process-hook-execution/:id', 'staff'], ['_ALL', '/mailbox-ingest', 'staff'], ['POST', '/test-advance/:executionId', 'staff'],
      ['POST', '/workflows/test-step', 'staff'],
    ];
    for (const [m, p, c] of closed) {
      expect([m, p, classify({ method: m, path: p, authClass: c }).proposable]).toEqual([m, p, false]);
    }
  });
  test('a route whose response is a secret is neither auto nor a card — SU included', () => {
    expect(classify({ method: 'GET', path: '/api/credentials/:id/reveal', authClass: 'su' })).toMatchObject({ tier: 3, proposable: false, autoGet: false, reason: 'returns a secret' });
    expect(classify({ method: 'GET', path: '/api/email-credentials/:id/reveal', authClass: 'su' })).toMatchObject({ proposable: false });
    expect(classify({ method: 'POST', path: '/api/api-keys', authClass: 'su' })).toMatchObject({ tier: 3, proposable: false, reason: 'returns a secret' });
    expect(classify({ method: 'POST', path: '/api/api-keys/rotate-internal', authClass: 'su' })).toMatchObject({ proposable: false });
    expect(classify({ method: 'POST', path: '/api/readonly-keys', authClass: 'su' })).toMatchObject({ proposable: false });
    expect(staff('GET', '/clio-code')).toMatchObject({ tier: 0, proposable: false, autoGet: false, reason: 'returns a secret' });
    // but the sibling routes stay open
    expect(classify({ method: 'PATCH', path: '/api/api-keys/:id', authClass: 'su' })).toMatchObject({ proposable: true });
    expect(classify({ method: 'GET', path: '/api/credentials/:id', authClass: 'su' })).toMatchObject({ tier: 3, proposable: true, autoGet: false });
  });

  test('prefix rules do not swallow look-alike paths', () => {
    expect(staff('POST', '/api/hooks')).toMatchObject({ proposable: true });          // /hooks is the receiver; /api/hooks the editor
    expect(staff('POST', '/api/authors')).toMatchObject({ proposable: true });
    expect(staff('POST', '/api/internal-notes')).toMatchObject({ proposable: true });
    expect(staff('GET', '/api/credentials-usage')).toMatchObject({ autoGet: true });
  });
});

describe('autoGet', () => {
  test('null for writes; true for an ordinary staff GET, staff:can included', () => {
    expect(staff('POST', '/api/tasks').autoGet).toBeNull();
    expect(classify({ method: 'GET', path: '/api/entitlements', authClass: 'staff:can' }).autoGet).toBe(true);
    expect(classify({ method: 'HEAD', path: '/api/entitlements', authClass: 'staff' }).autoGet).toBe(true);
  });
  test('credential-returning staff GETs are closed — neither auto nor a card', () => {
    for (const p of ['/api/credentials', '/api/email-credentials', '/api/api-keys', '/api/readonly-keys', '/api/hooks', '/api/hooks/:id']) {
      expect([p, staff('GET', p)]).toEqual([p, { tier: 0, proposable: false, autoGet: false, reason: 'credential-returning read' }]);
      expect([p, staff('HEAD', p).autoGet]).toEqual([p, false]);
    }
    // the hook rule is exact: the executions / targets / meta reads stay open
    for (const p of ['/api/hooks/:hookId/executions', '/api/hooks/:hookId/targets', '/api/hooks/meta', '/api/hooks/executions']) {
      expect([p, classify({ method: 'GET', path: p, authClass: 'staff:can' }).autoGet]).toEqual([p, true]);
    }
    // /internal/* and /api/impersonation/* are never-proposable first; still closed to auto GET
    for (const p of ['/internal/email-test/credentials', '/internal/email-test/credentials/oauth', '/api/impersonation/users']) {
      expect([p, staff('GET', p)]).toEqual([p, { tier: 0, proposable: false, autoGet: false, reason: 'read' }]);
    }
  });
  test('the staff GETs the lists name are closed only for GET', () => {
    // A POST under /api/credentials is SU in the live app; here the rule is
    // only that NEVER_AUTO_GET is a GET rule.
    expect(staff('POST', '/api/credentials')).toMatchObject({ tier: 2, proposable: true });
  });
});

describe('the lists are exact snapshots — a change is a deliberate review', () => {
  test('T2 words', () => {
    expect([...S.T2_WORDS]).toEqual([
      'send', 'sms', 'mms', 'esign', 'campaigns', 'enroll', 'publish', 'merge',
      'purge', 'bulk', 'batch', 'users', 'api-keys', 'credentials', 'app-settings',
      'email-credentials', 'readonly-keys', 'start', 'test-send', 'test-sms',
      'live-test', 'fire-next', 'resume', 'replay', 'test-step',
    ]);
  });
  test('never proposable', () => {
    expect(S.NEVER_PROPOSABLE.map(r => r.source)).toEqual([
      '^\\S+ \\/admin\\/db(\\/|$)', '^\\S+ \\/admin\\/api-tester(\\/|$)', '^\\S+ \\/admin\\/elevate$', '^\\S+ \\/db-jwt$',
      '^\\S+ \\/internal(\\/|$)', '^\\S+ \\/process-(jobs?|domain-event|hook-execution)(\\/|$)', '^\\S+ \\/mailbox-ingest(\\/|$)',
      '^\\S+ \\/test-advance(\\/|$)', '^\\S+ \\/workflows\\/test-step$',
      '^\\S+ \\/hooks(\\/|$)', '^\\S+ \\/webhooks(\\/|$)', '^\\S+ \\/auth(\\/|$)',
      '^\\S+ \\/login$', '^\\S+ \\/api\\/auth(\\/|$)', '^\\S+ \\/api\\/impersonation(\\/|$)',
      '^\\S+ \\/api\\/assistant(\\/|$)', '^\\S+ \\/api\\/casey(\\/|$)', '^\\S+ \\/api\\/readonly(\\/|$)',
      '^\\S+ \\/api\\/temp(\\/|$)',
    ]);
  });
  test('secret returning', () => {
    expect(S.SECRET_RETURNING.map(r => r.source)).toEqual([
      '^\\S+ \\S*\\/reveal$', '^POST \\/api\\/api-keys$', '^POST \\/api\\/api-keys\\/rotate-internal$', '^POST \\/api\\/readonly-keys$', '^\\S+ \\/clio-code$',
      '^POST \\/api\\/hooks\\/:id\\/duplicate$',   // S3b: a card's result reaches the model; the new hook's targets carry their headers verbatim
    ]);
  });
  test('never auto GET', () => {
    expect(S.NEVER_AUTO_GET.map(r => r.source)).toEqual([
      '^(GET|HEAD) \\/api\\/credentials(\\/|$)', '^(GET|HEAD) \\/api\\/api-keys(\\/|$)', '^(GET|HEAD) \\/api\\/readonly-keys(\\/|$)',
      '^(GET|HEAD) \\/api\\/email-credentials(\\/|$)', '^(GET|HEAD) \\/internal(\\/|$)', '^(GET|HEAD) \\/api\\/impersonation(\\/|$)',
      '^(GET|HEAD) \\/api\\/hooks$', '^(GET|HEAD) \\/api\\/hooks\\/:id$', '^(GET|HEAD) \\/api\\/comms-archive\\/media\\/:id\\/url$',
    ]);
  });
  test('lists are frozen', () => {
    for (const l of [S.T2_WORDS, S.NEVER_PROPOSABLE, S.SECRET_RETURNING, S.NEVER_AUTO_GET]) expect(Object.isFrozen(l)).toBe(true);
  });
});
