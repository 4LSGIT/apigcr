// tests/helpers/caseyMemoryCards.js — an in-memory stand-in for
// services/casey/cards.js with the SAME API and semantics (claim order and
// tokens, settle, decline, resume, revert, the implicit resolve), for the loop
// and route suites that mock the store; the real SQL is proven by
// tests/caseyCards.mysql.test.js on MySQL 8.4. Pure functions (outcomeText,
// present, resultText, idemKey) come from the real module.
//
//   jest.mock('../services/casey/cards', () => require('./helpers/caseyMemoryCards').make(jest.requireActual('../services/casey/cards')));
//   const cards = require('../services/casey/cards');  cards._store.reset();
'use strict';

const crypto = require('crypto');

function make(actual) {
  const store = { cards: new Map(), next: 1, reset() { store.cards.clear(); store.next = 1; } };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const view = (c) => {
    if (!c) return null;
    const steps = c.steps.map(({ claim_token, ...s }) => ({ ...clone(s), result: s.result == null ? null : (() => { try { return JSON.parse(s.result); } catch (_) { return s.result; } })() }));
    const { steps: _s, ...rest } = c;
    return { ...clone(rest), steps };
  };
  const mine = (id, userId) => { const c = store.cards.get(Number(id)); return c && c.user_id === userId ? c : null; };
  return {
    ...actual,
    _store: store,
    async createCard(db, { chatId, userId, toolUseId, tier, summary, steps }) {
      if (!Array.isArray(steps) || !steps.length || steps.length > actual.MAX_STEPS) throw new Error(`a card carries 1–${actual.MAX_STEPS} steps`);
      const id = store.next++;
      store.cards.set(id, {
        id, chat_id: Number(chatId), user_id: userId, tool_use_id: String(toolUseId).slice(0, 64), tier, summary: String(summary || '').slice(0, actual.SUMMARY_MAX) || '(no summary)',
        status: 'proposed', decline_note: null, resumed_at: null, created_at: 'c',
        steps: steps.map((s, i) => ({ step_no: i + 1, method: s.method, path: s.path, body: s.body == null ? null : String(s.body), tier: s.tier, purpose: String(s.purpose || '').slice(0, actual.PURPOSE_MAX), status: 'pending', claim_token: null, http_status: null, result: null, idempotency_key: actual.idemKey(id, i + 1), claimed_at: null, settled_at: null })),
      });
      return id;
    },
    async getCard(db, id, userId) { return view(mine(id, userId)); },
    async openCard(db, chatId, userId) {
      const open = [...store.cards.values()].filter((c) => c.chat_id === Number(chatId) && c.user_id === userId && actual.OPEN.includes(c.status)).sort((a, b) => b.id - a.id)[0];
      return view(open || null);
    },
    async unresolvedCard(db, chatId, userId) {
      const c = [...store.cards.values()].filter((x) => x.chat_id === Number(chatId) && x.user_id === userId && ['proposed', 'approved', 'declined'].includes(x.status)).sort((a, b) => b.id - a.id)[0];
      return view(c || null);
    },
    async claimStep(db, cardId, userId, stepNo) {
      const c = mine(cardId, userId); if (!c) return null;
      const s = c.steps.find((x) => x.step_no === Number(stepNo)); if (!s) return null;
      const earlierNotApplied = c.steps.some((x) => x.step_no < s.step_no && x.status !== 'applied');
      if (actual.OPEN.includes(c.status) && s.status === 'pending' && !earlierNotApplied) {
        s.status = 'claimed'; s.claim_token = crypto.randomUUID(); s.claimed_at = 'now';
        if (c.status === 'proposed') c.status = 'approved';
        return { outcome: 'claimed', claim_token: s.claim_token, step: view(c).steps.find((x) => x.step_no === s.step_no) };
      }
      const shown = view(c).steps.find((x) => x.step_no === s.step_no);
      if (!actual.OPEN.includes(c.status)) return { outcome: 'closed', step: shown };
      if (s.status === 'applied') return { outcome: 'applied', step: shown };
      if (s.status === 'claimed') return { outcome: 'unknown', step: shown };
      if (earlierNotApplied) return { outcome: 'out_of_order', step: shown };
      return { outcome: 'closed', step: shown };
    },
    async settleStep(db, cardId, userId, stepNo, claimToken, { status, httpStatus, result }) {
      if (!['applied', 'failed'].includes(status)) throw new Error('settle status must be applied or failed');
      const c = mine(cardId, userId); if (!c) return false;
      const s = c.steps.find((x) => x.step_no === Number(stepNo));
      if (!s || s.status !== 'claimed' || s.claim_token !== String(claimToken || '')) return false;
      s.status = status; s.http_status = Number.isInteger(httpStatus) ? httpStatus : null; s.result = actual.storedResult(result); s.settled_at = 'now';   // the real store's own function (review S1: the helper must not re-implement the guard)
      return true;
    },
    async declineCard(db, cardId, userId, note) {
      const c = mine(cardId, userId); if (!c || c.status !== 'proposed' || c.steps.some((s) => s.status !== 'pending')) return false;
      c.status = 'declined'; c.decline_note = note == null ? null : String(note).slice(0, actual.NOTE_MAX) || null;
      for (const s of c.steps) if (s.status === 'pending') s.status = 'declined';
      return true;
    },
    async resumeCard(db, cardId, userId) {
      const c = mine(cardId, userId); if (!c || !['approved', 'declined'].includes(c.status)) return null;
      c.status = 'resumed'; c.resumed_at = 'now';
      for (const s of c.steps) if (s.status === 'pending') s.status = 'skipped';
      return view(c);
    },
    async revertResume(db, cardId, userId, prev) {
      const c = mine(cardId, userId); if (!c || c.status !== 'resumed') return false;
      const implicit = !!(prev && prev.implicit);
      c.status = implicit ? 'proposed' : (prev && prev.status) || 'approved'; c.resumed_at = null; if (implicit) c.decline_note = null;
      for (const s of c.steps) if (s.status === 'skipped' || (implicit && s.status === 'declined')) s.status = 'pending';
      return true;
    },
    async resolveForTurn(db, chatId, userId) {
      const open = await this.unresolvedCard(db, chatId, userId); if (!open) return null;
      const implicit = open.status === 'proposed' ? await this.declineCard(db, open.id, userId, actual.IMPLICIT_DECLINE_NOTE) : false;
      const card = await this.resumeCard(db, open.id, userId);
      return card ? { card, prev: { status: implicit ? 'proposed' : open.status, implicit } } : null;
    },
  };
}

module.exports = { make };
