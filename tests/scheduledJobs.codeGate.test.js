'use strict';
/**
 * tests/scheduledJobs.codeGate.test.js
 *
 * custom_code SCHEDULED JOBS are gated like custom_code workflow steps.
 *
 * WHY THIS SUITE EXISTS: this writer was the hole in the original gate (found
 * 2026-10-22, safe-mode S2). The workflow step writers and test-step were
 * gated on automations.manage, but POST /scheduled-jobs accepted
 * job_type:'custom_code' and PATCH /scheduled-jobs/:id accepted a whole
 * data object with data.type:'custom_code' from ANY staff JWT — and both
 * execute through the same lib/job_executor. A gate on one writer is a gate
 * on none.
 *
 * Policy mirrors routes/workflows.js refuseCodeStepWithoutCapability:
 * code_mode 'safe' (QuickJS guest engine) is open to all staff; 'standard'
 * or absent needs automations.manage; an unknown mode is a 400 for everyone.
 *
 * HARNESS: the real router over a real ephemeral socket, the idiom from
 * tests/workflows.codeStepGate.test.js. Only jwtOrApiKey is mocked. The db
 * stub serves the PATCH route's job-row SELECT and THROWS on everything
 * else, so a passing refusal also proves the gate answers before the insert;
 * allow cases are asserted as "not 403/400" — the throwing stub fails them
 * later, which is not the gate's business.
 */

const express = require('express');
const http = require('http');

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const STAFF = { type: 'jwt', userId: 2, roles: ['staff'] };
const ADMIN = { type: 'jwt', userId: 1, roles: ['admin', 'staff', 'attorney'] };

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.db = {
      query: async (sql) => {
        if (/SELECT id, status, type FROM scheduled_jobs/.test(sql)) {
          return [[{ id: 9, status: 'pending', type: 'one_time' }]];
        }
        throw new Error(`db touched: ${sql}`);
      },
    };
    next();
  });
  a.use(require('../routes/scheduled_jobs.js'));
  return a;
}

function send(method, urlPath, payload) {
  const a = app();
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          server.close();
          let body = {};
          try { body = JSON.parse(out || '{}'); } catch { body = { raw: out }; }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.write(data);
      req.end();
    });
  });
}

const CODE_JOB = (extra = {}) =>
  ({ type: 'one_time', job_type: 'custom_code', code: '1;', delay: '10m', ...extra });

describe('POST /scheduled-jobs gates standard custom_code', () => {
  test('plain staff, no code_mode (= standard): refused', async () => {
    mockAuth = STAFF;
    const r = await send('POST', '/scheduled-jobs', CODE_JOB());
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/automations\.manage/);
  });

  test('plain staff, explicit standard: refused', async () => {
    mockAuth = STAFF;
    const r = await send('POST', '/scheduled-jobs', CODE_JOB({ code_mode: 'standard' }));
    expect(r.status).toBe(403);
  });

  test('plain staff, safe mode: passes the gate', async () => {
    mockAuth = STAFF;
    const r = await send('POST', '/scheduled-jobs', CODE_JOB({ code_mode: 'safe' }));
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(400);
  });

  test('an unknown code_mode is a 400 for everyone — validation, not the gate', async () => {
    mockAuth = ADMIN;
    const r = await send('POST', '/scheduled-jobs', CODE_JOB({ code_mode: 'nope' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/code_mode/);
  });

  test('admin standard: not refused', async () => {
    mockAuth = ADMIN;
    const r = await send('POST', '/scheduled-jobs', CODE_JOB());
    expect(r.status).not.toBe(403);
  });
});

describe('PATCH /scheduled-jobs/:id gates a custom_code data payload', () => {
  test('plain staff replacing data with standard code: refused', async () => {
    mockAuth = STAFF;
    const r = await send('PATCH', '/scheduled-jobs/9',
      { data: { type: 'custom_code', code: 'x;' } });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/automations\.manage/);
  });

  test('plain staff replacing data with SAFE code: passes the gate', async () => {
    mockAuth = STAFF;
    const r = await send('PATCH', '/scheduled-jobs/9',
      { data: { type: 'custom_code', code: 'x;', code_mode: 'safe' } });
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(400);
  });

  test('a non-code PATCH from staff is not refused by this gate', async () => {
    mockAuth = STAFF;
    const r = await send('PATCH', '/scheduled-jobs/9', { name: 'renamed' });
    expect(r.status).not.toBe(403);
  });
});
