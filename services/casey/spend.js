// services/casey/spend.js — Casey v2's monthly spend gate: the SAME firm cap
// as Ask Casey v1 (assistant_ai_monthly_cap_cents, lib/settingsRegistry.js),
// over the same rows. v2 logs its ai_calls rows as consumer_ref
// 'assistant_v2:u<user>:c<chat>' — inside the 'assistant_%' family v1 already
// sums (services/assistantService.js assistantMonthToDateCents) — so one cap
// bounds both surfaces without touching the frozen v1 code: either side's
// spend counts against the other's check. Checked before EVERY model call of
// a turn, so a turn in flight may overshoot by one request's cost. Missing /
// blank → the code default; present but not a whole number → 0 (fail closed,
// as v1 and the comms cap do).
'use strict';

const SPEND_CAP_KEY = 'assistant_ai_monthly_cap_cents';
const DEFAULT_SPEND_CAP_CENTS = 20000;
const CONSUMER_PREFIX = 'assistant_v2';

function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  if (detail) e.detail = detail;
  return e;
}

async function capCents(db) {
  const { getSettings } = require('../settingsService'); // lazy require (convention)
  const raw = (await getSettings(db, [SPEND_CAP_KEY]))[SPEND_CAP_KEY];
  if (raw == null || String(raw).trim() === '') return DEFAULT_SPEND_CAP_CENTS;
  const text = String(raw).trim();
  return /^\d{1,10}$/.test(text) ? Number(text) : 0;
}

async function monthToDateCents(db) {
  const [[row]] = await db.query(
    `SELECT COALESCE(SUM(cost_cents), 0) AS c FROM ai_calls
      WHERE consumer_ref LIKE 'assistant\\_%' AND created_at >= DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01')`);
  return Number(row && row.c) || 0;
}

async function assertSpendAllowed(db) {
  const cap = await capCents(db);
  const spent = await monthToDateCents(db);
  if (spent >= cap) {
    throw httpError(429, 'Casey has reached the firm\'s monthly AI spending limit. It will be available again next month, or an administrator can raise the limit.');
  }
  return { cap, spent };
}

const consumerRef = (userId, chatId) => `${CONSUMER_PREFIX}:u${userId}:c${chatId}`;

module.exports = { SPEND_CAP_KEY, DEFAULT_SPEND_CAP_CENTS, CONSUMER_PREFIX, httpError, capCents, monthToDateCents, assertSpendAllowed, consumerRef };
