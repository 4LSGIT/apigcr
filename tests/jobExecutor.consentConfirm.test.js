/**
 * tests/jobExecutor.consentConfirm.test.js — YisraMail P2 (ref/YISRAMAIL_DESIGN.md §4.6)
 *
 * lib/job_executor's 'consent_sms_confirm' branch: the ONE confirmation text
 * for an opt-out word Quo does not act on. It sends exactly once, from
 * data.line to data.to, through phoneService.sendSms DIRECTLY — the deliberate
 * consent-gate exemption (the recipient has just opted out; the confirmation
 * is the one text the law expects). No consent read at all: a gate added here
 * would swallow the confirmation, so the test fails on ANY db statement or
 * opt-out lookup. A send failure fails the job (max_attempts 1 on the row —
 * never a resend loop).
 */
'use strict';

jest.mock('../services/phoneService', () => ({ sendSms: jest.fn(), getAdapter: jest.fn(() => null) }));
jest.mock('../services/settingsService', () => ({ getSetting: jest.fn(async () => null), getSettings: jest.fn() }));

const phoneService = require('../services/phoneService');
const settingsService = require('../services/settingsService');
const optout = require('../services/optoutService');
const { executeJob } = require('../lib/job_executor');
const consent = require('../services/phoneConsentService');

function strictDb() {
  const seen = [];
  return { seen, query: jest.fn(async (sql) => { seen.push(sql); throw new Error(`no statement expected: ${sql}`); }) };
}

const job = (data, over = {}) => ({ id: 41, attempts: 0, max_attempts: 1, data: JSON.stringify({ type: consent.CONFIRM_JOB_TYPE, ...data }), ...over });

beforeEach(() => {
  jest.clearAllMocks();
  settingsService.getSettings.mockImplementation(async (_db, keys) => Object.fromEntries(keys.map((k) => [k, k === 'firm_name' ? 'Legal Solutions Group' : null])));
});

test('sends once, from data.line to data.to, with the default words — and reads no consent', async () => {
  phoneService.sendSms.mockResolvedValue({ id: 'm' });
  const findSpy = jest.spyOn(optout, 'findOptedOut');
  const assertSpy = jest.spyOn(optout, 'assertNotOptedOut');
  const db = strictDb();
  const out = await executeJob(job({ line: '2484179800', to: '3135550001', provider_message_id: 'ACx' }), db);
  expect(out).toEqual({ sent: true, line: '2484179800', to: '3135550001' });
  expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
  expect(phoneService.sendSms).toHaveBeenCalledWith(db, '2484179800', '3135550001',
    "You've been unsubscribed from texts from Legal Solutions Group. Reply START to resume.");
  expect(db.seen).toEqual([]);
  expect(findSpy).not.toHaveBeenCalled();
  expect(assertSpy).not.toHaveBeenCalled();
  findSpy.mockRestore(); assertSpy.mockRestore();
});

test('the setting\'s words win', async () => {
  settingsService.getSettings.mockResolvedValue({ [consent.CONFIRM_TEXT_KEY]: 'You are unsubscribed. Reply START to come back.', firm_name: 'X' });
  phoneService.sendSms.mockResolvedValue({});
  await executeJob(job({ line: '2484179800', to: '3135550001' }), strictDb());
  expect(phoneService.sendSms.mock.calls[0][3]).toBe('You are unsubscribed. Reply START to come back.');
});

test("Quo's own opted-out refusal (400 0201400) is provider-confirmed: the job succeeds, nothing is resent (job 12787, 2026-10-30)", async () => {
  phoneService.sendSms.mockRejectedValue(new Error('Quo API 400: {"message":"User has opted out of receiving messages","code":"0201400","status":400,"title":"User Opted Out"}'));
  const out = await executeJob(job({ line: '2484179800', to: '3135550001' }), strictDb());
  expect(out).toEqual({ sent: false, provider_confirmed: true, line: '2484179800', to: '3135550001' });
  expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
});

test('any other Quo 400 still fails the job', async () => {
  phoneService.sendSms.mockRejectedValue(new Error('Quo API 400: {"message":"Invalid phone number","code":"0101400"}'));
  await expect(executeJob(job({ line: '2484179800', to: '3135550001' }), strictDb())).rejects.toThrow('Quo API 400');
});

test('a send failure fails the job (one attempt — the caller records it failed)', async () => {
  phoneService.sendSms.mockRejectedValue(new Error('Quo API 500'));
  await expect(executeJob(job({ line: '2484179800', to: '3135550001' }), strictDb())).rejects.toThrow('Quo API 500');
  expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
});

test('missing line / to refuse before any send', async () => {
  await expect(executeJob(job({ to: '3135550001' }), strictDb())).rejects.toThrow('consent_sms_confirm: missing line');
  await expect(executeJob(job({ line: '2484179800' }), strictDb())).rejects.toThrow('consent_sms_confirm: missing to');
  expect(phoneService.sendSms).not.toHaveBeenCalled();
});
