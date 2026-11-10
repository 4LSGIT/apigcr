// tests/emailAttachmentsComms.routes.test.js
//
/**
 * Email attachments S3 — the three Comms filing routes in routes/api.mail.js
 * (ref/EMAIL_ATTACHMENTS_DESIGN.md §9). The REAL router and auth middleware
 * over an express app on an ephemeral port; the service
 * (services/emailAttachmentCommsService.js) is stubbed here — its behaviour
 * is proven on MySQL 8 by tests/emailAttachments.mysql.test.js (gated).
 *
 * What the routes own: the staff-JWT guard, the caller's id (req.auth.userId —
 * a STRING; the service Number()s it) and the body handed through untouched, the 409 that carries `needs_confirmation`, and
 * sendError's wording (a 4xx says why, a 5xx says nothing).
 *
 * Mutation-checked (2026-11-10): the 409 branch dropped → the confirm test;
 * requireJwt dropped from the guard → the API-key test.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'eatt-comms-test-secret';
process.env.INTERNAL_API_KEY = 'yci_eatt_comms_internal'; // secret-scan: allow

jest.mock('../services/emailAttachmentCommsService', () => ({
  preview: jest.fn(),
  caseFolders: jest.fn(),
  fileOne: jest.fn(),
  sendNotice: jest.fn(),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const comms = require('../services/emailAttachmentCommsService');

const db = { query: jest.fn(async () => [[]]) };
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = db; next(); });
app.use(require('../routes/api.mail'));

let server; let base;
beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const tok = (user) => jwt.sign({ sub: String(user), username: `u${user}`, user_auth: 'authorized', aud: 'staff' }, process.env.JWT_SECRET);
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);

async function call(url, { t, apiKey, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (t) headers.Authorization = `Bearer ${t}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

describe('POST /api/mail/attachments/preview', () => {
  test('a staff JWT: the caller and the body go through; the answer comes back as success', async () => {
    comms.preview.mockResolvedValue({ case: null, messages: [{ id: 7 }] });
    const r = await call('/api/mail/attachments/preview', { t: tok(6), body: { message_ids: [7], case_id: 'PVXC1RMM' } });
    expect(r).toEqual({ status: 200, json: { status: 'success', case: null, messages: [{ id: 7 }] } });
    expect(comms.preview).toHaveBeenCalledWith(db, '6', { message_ids: [7], case_id: 'PVXC1RMM' });
  });

  test('no sign-in → 401; the internal API key (no user) → 403; the service is never asked', async () => {
    expect((await call('/api/mail/attachments/preview', { body: { message_ids: [7] } })).status).toBe(401);
    const k = await call('/api/mail/attachments/preview', { apiKey: process.env.INTERNAL_API_KEY, body: { message_ids: [7] } });
    expect(k).toEqual({ status: 403, json: { status: 'error', message: 'Mail routes require a signed-in user' } });
    expect(comms.preview).not.toHaveBeenCalled();
  });
});

describe('POST /api/mail/messages/:id/attachments/file', () => {
  test('one email: the id from the path, the caller, the body', async () => {
    comms.fileOne.mockResolvedValue({ id: 41, files: [{ part: '2', status: 'filed' }] });
    const body = { case_id: 'PVXC1RMM', parts: ['2'], move: true, link: true, batch: 'batchAAAA1111' };
    const r = await call('/api/mail/messages/41/attachments/file', { t: tok(5), body });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'success', id: 41, files: [{ part: '2', status: 'filed' }] });
    expect(comms.fileOne).toHaveBeenCalledWith(db, '5', '41', body);
  });

  test('a pick that needs the second confirmation → 409 carrying needs_confirmation', async () => {
    const needs = [{ part: '3', filename: 'scans.zip', why: 'type' }];
    comms.fileOne.mockRejectedValue(err(409, 'This file needs a second confirmation: scans.zip', { expose: true, needs_confirmation: needs }));
    const r = await call('/api/mail/messages/41/attachments/file', { t: tok(5), body: { case_id: 'PVXC1RMM', parts: ['3'] } });
    expect(r).toEqual({ status: 409, json: { status: 'error', message: 'This file needs a second confirmation: scans.zip', needs_confirmation: needs } });
  });

  test('other refusals say why (4xx); a crash says nothing (5xx)', async () => {
    comms.fileOne.mockRejectedValueOnce(err(422, "run.exe cannot be filed: its type is on the firm's never-filed list."));
    expect(await call('/api/mail/messages/41/attachments/file', { t: tok(5), body: { case_id: 'X1', parts: ['4'] } }))
      .toEqual({ status: 422, json: { status: 'error', message: "run.exe cannot be filed: its type is on the firm's never-filed list." } });
    comms.fileOne.mockRejectedValueOnce(err(404, 'Message not found'));
    expect((await call('/api/mail/messages/41/attachments/file', { t: tok(22), body: {} })).json.message).toBe('Message not found');
    comms.fileOne.mockRejectedValueOnce(new Error('ER_LOCK_DEADLOCK: secret detail'));
    expect(await call('/api/mail/messages/41/attachments/file', { t: tok(5), body: {} }))
      .toEqual({ status: 500, json: { status: 'error', message: 'Mail request failed' } });
  });
});

describe('POST /api/mail/attachments/folders (S3b)', () => {
  test('the case folder\'s subfolders for the caller; refusals say why', async () => {
    comms.caseFolders.mockResolvedValueOnce({ case_id: 'PVXC1RMM', folders: [' 012 - Supplemental Responses'], truncated: false, reason: null });
    const r = await call('/api/mail/attachments/folders', { t: tok(22), body: { case_id: 'PVXC1RMM' } });
    expect(r).toEqual({ status: 200, json: { status: 'success', case_id: 'PVXC1RMM', folders: [' 012 - Supplemental Responses'], truncated: false, reason: null } });
    expect(comms.caseFolders).toHaveBeenCalledWith(db, '22', { case_id: 'PVXC1RMM' });
    comms.caseFolders.mockRejectedValueOnce(err(404, 'Case not found'));
    expect(await call('/api/mail/attachments/folders', { t: tok(22), body: { case_id: 'NOPE' } })).toEqual({ status: 404, json: { status: 'error', message: 'Case not found' } });
    expect((await call('/api/mail/attachments/folders', { body: { case_id: 'X' } })).status).toBe(401);
  });
});

describe('POST /api/mail/attachments/notice', () => {
  test('the batch goes through with the caller', async () => {
    comms.sendNotice.mockResolvedValue({ sent: true, count: 3, notices: 2 });
    const r = await call('/api/mail/attachments/notice', { t: tok(6), body: { batch: 'batchAAAA1111' } });
    expect(r).toEqual({ status: 200, json: { status: 'success', sent: true, count: 3, notices: 2 } });
    expect(comms.sendNotice).toHaveBeenCalledWith(db, '6', { batch: 'batchAAAA1111' });
  });
});
