// tests/helpers/caseySendProposalDb.js
//
/**
 * The scripted fake database the A14 send NORMALIZER reads in the unit and
 * end-to-end suites (tests/caseySendAction.test.js, tests/caseySend.routes.test.js):
 * contacts, one contact_phones / contact_emails row, cases + case_relate,
 * channel_grants, resolverService's single JOIN SELECT evaluated from the
 * seed, and optoutService's consent reads (tests/helpers/optoutFake.js — the
 * row flags plus T.consent_states, comm_consent_state rows). Unknown
 * statements THROW. The same SQL runs on MySQL in
 * tests/caseySendAction.mysql.test.js (gated).
 */

'use strict';

const { answerOptout } = require('./optoutFake');

const USER = 22;

const STAMP = new Date('2026-10-26T10:00:00Z');

function makeDb(over = {}) {
  const T = {
    contacts: [
      { contact_id: 1309, contact_name: 'Pat One', contact_fname: 'Pat', contact_lname: 'One', contact_ssn: '123-45-6789' },
      { contact_id: 1400, contact_name: 'Other Person', contact_fname: 'Other', contact_lname: 'Person', contact_ssn: '' },
    ],
    contact_phones: [{ id: 12, contact_id: 1309, phone: '3135550001', label: 'Mobile', is_primary: 1, sms_optout: 0, end_date: null, updated_at: STAMP }],
    contact_emails: [
      { id: 13, contact_id: 1309, email: 'pat@example.com', label: 'Personal', is_primary: 1, email_optout: 0, end_date: null, updated_at: STAMP },
      // A14X: a second address on the same contact and one on another contact — cc / bcc rows.
      { id: 14, contact_id: 1309, email: 'pat.work@example.com', label: 'Work', is_primary: 0, email_optout: 0, end_date: null, updated_at: STAMP },
      { id: 15, contact_id: 1400, email: 'other@example.com', label: 'Personal', is_primary: 1, email_optout: 0, end_date: null, updated_at: STAMP },
    ],
    // CASE3 exists but is nobody's case here (the email Case field may name it; an SMS may not).
    cases: [{ case_id: 'CASE1', case_number: '26-40001', case_number_full: '2:26-bk-40001', case_type: 'Chapter 7' },
      { case_id: 'CASE3', case_number: '26-40003', case_number_full: '2:26-bk-40003', case_type: 'Chapter 13' }],
    case_relate: [{ case_relate_case_id: 'CASE1', case_relate_client_id: 1309 }],
    channel_grants: [{ user: USER, channel_type: 'phone_line', channel_id: 3, can_send: 1 }, { user: USER, channel_type: 'mailbox', channel_id: 5, can_send: 1 }],
    consent_states: [],
    ...over,
  };
  const seen = [];
  const db = {
    getConnection: async () => { throw new Error('no connections'); },
    async query(sql, p = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      seen.push(s);
      const consent = answerOptout(s, p, { phones: T.contact_phones, emails: T.contact_emails, contacts: T.contacts, states: T.consent_states });
      if (consent) return consent;
      if (s === 'SELECT contact_id, contact_name FROM contacts WHERE contact_id = ? LIMIT 1') {
        return [T.contacts.filter((c) => c.contact_id === Number(p[0]))];
      }
      if (/FROM contact_phones cp .* WHERE cp\.id = \?$/.test(s)) return [T.contact_phones.filter((r) => r.id === Number(p[0]))];
      if (/FROM contact_emails ce .* WHERE ce\.id = \?$/.test(s)) return [T.contact_emails.filter((r) => r.id === Number(p[0]))];
      // sendActionCase: the case by id, with EXISTS(case_relate link to the contact) as `linked` (params: contact, case).
      if (/^SELECT c\.case_id, COALESCE\(NULLIF\(c\.case_number_full, ''\), NULLIF\(c\.case_number, ''\), c\.case_id\) AS label, EXISTS\(SELECT 1 FROM case_relate cr WHERE cr\.case_relate_case_id = c\.case_id AND cr\.case_relate_client_id = \?\) AS linked FROM cases c WHERE c\.case_id = \? LIMIT 1$/.test(s)) {
        const c = T.cases.find((x) => x.case_id === p[1]);
        const linked = T.case_relate.some((r) => r.case_relate_case_id === p[1] && r.case_relate_client_id === Number(p[0]));
        return [c ? [{ case_id: c.case_id, label: c.case_number_full || c.case_number || c.case_id, linked: linked ? 1 : 0 }] : []];
      }
      if (s === 'SELECT channel_id FROM channel_grants WHERE user = ? AND channel_type = ? AND can_send = 1') {
        return [T.channel_grants.filter((g) => g.user === Number(p[0]) && g.channel_type === p[1] && g.can_send).map((g) => ({ channel_id: g.channel_id }))];
      }
      // resolverService's single JOIN SELECT, evaluated from the seed.
      // FROM the first referenced table, LEFT JOIN the rest; params are the
      // joins' anchors in order, then the base anchor.
      const base = /^SELECT .* FROM `(contacts|cases)`((?: LEFT JOIN `\w+` ON `\w+`\.`\w+` = \?)*) WHERE `\w+`\.`\w+` = \? LIMIT 1$/.exec(s);
      if (base) {
        const joined = [...base[2].matchAll(/LEFT JOIN `(\w+)`/g)].map((m) => m[1]);
        const anchors = {};
        joined.forEach((t, i) => { anchors[t] = p[i]; });
        anchors[base[1]] = p[p.length - 1];
        const find = (t) => (t === 'contacts' ? T.contacts.find((c) => c.contact_id === Number(anchors.contacts))
          : t === 'cases' ? T.cases.find((c) => c.case_id === anchors.cases) : null);
        if (!find(base[1])) return [[]];
        const row = {};
        for (const m of s.matchAll(/`(\w+)`\.`(\w+)` AS `(\w+__\w+)`/g)) {
          const [, table, col, alias] = m;
          const src = find(table);
          row[alias] = src && src[col] !== undefined ? src[col] : null;
        }
        return [[row]];
      }
      throw new Error(`caseySendAction fake db: unscripted statement: ${s}`);
    },
  };
  db.T = T;
  db.seen = seen;
  return db;
}


module.exports = { makeDb, STAMP, USER };
