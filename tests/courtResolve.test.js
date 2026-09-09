// tests/courtResolve.test.js
// ── person-preferring primary (incident 2026-09-09: enrollment 176) ──
// resolveCase's primary_contact_id feeds comms (341 appt + sequence
// enrollment, court_processed event, {{primary_contact_id}} substitution).
// An org cannot answer a phone, so the contact query must rank persons
// before orgs, ahead of the relate-type ranking. These tests pin the SQL
// actually sent (house dispatch-on-SQL-text idiom) and the row selection.

const { resolveCase } = require('../lib/courtResolve');

function stubDb(contactRows) {
  const sent = [];
  return {
    sent,
    query: async (sql, params) => {
      sent.push(sql);
      if (/FROM cases/i.test(sql)) {
        return [[{ case_id: 'PY9ZD564', case_number_full: '26-49875-lsg',
                   case_number: '26-49875', case_chapter: '11', case_caption: null }]];
      }
      if (/FROM case_relate/i.test(sql)) return [contactRows];
      return [[]];
    },
  };
}

test('contacts query ranks persons before orgs, before relate rank', async () => {
  const db = stubDb([{ contact_id: 1899, contact_name: 'Alexandria Riley' }]);
  const out = await resolveCase(db, { case_number: '26-49875' });
  const contactsSql = db.sent.find(s => /FROM case_relate/i.test(s));
  expect(contactsSql).toMatch(/ORDER BY \(co\.contact_kind = 'person'\) DESC/);
  expect(contactsSql).toMatch(/FIELD\(cr\.case_relate_type/); // rank still applies within kind
  expect(out.primary_contact_id).toBe(1899); // DB's first row is taken as-is
});

test('no related contacts → null primary, found case intact', async () => {
  const db = stubDb([]);
  const out = await resolveCase(db, { case_number: '26-49875' });
  expect(out.found).toBe(true);
  expect(out.primary_contact_id).toBeNull();
});
