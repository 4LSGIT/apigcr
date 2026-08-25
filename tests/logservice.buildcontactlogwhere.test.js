/**
 * tests/logservice.buildcontactlogwhere.test.js
 *
 * Tests for logService._buildContactLogWhere — added with About-link S1,
 * which grew the fragment from four sources to five:
 *   1. contact-typed direct match
 *   2. legacy NULL-typed log_link match
 *   3. phone-typed rows via contact_phones date window
 *   4. email-typed rows via contact_emails date window
 *   5. about-link: log_about_type = 'contact' AND log_about_id = contactId
 *
 * The contract these tests pin down:
 *   - the about arm is present and is a plain literal match (no
 *     contact_phones/contact_emails window resolution for about values —
 *     that is a deliberate design decision, see the builder docstring);
 *   - param order matches clause order exactly:
 *       [String(id), String(id), id, id, String(id)]
 *     — first two stringified (varchar cols), middle two raw (INT
 *     contact_id in the EXISTS subqueries), about param stringified;
 *   - placeholder count equals param count (mysql2 bind contract).
 *
 * Pure function — no DB, no mocks needed.
 *
 * Run:
 *   npx jest tests/logservice.buildcontactlogwhere.test.js
 */
const logService = require('../services/logService');

const { _buildContactLogWhere } = logService;

const countPlaceholders = s => (s.match(/\?/g) || []).length;

describe('_buildContactLogWhere — five-source fragment (About-link S1)', () => {

  test('all five arms present', () => {
    const { whereFragment } = _buildContactLogWhere(412);

    expect(whereFragment).toContain(`l.log_link_type = 'contact' AND l.log_link_id = ?`);
    expect(whereFragment).toContain(`l.log_link_type IS NULL    AND l.log_link    = ?`);
    expect(whereFragment).toContain(`l.log_link_type = 'phone'`);
    expect(whereFragment).toContain('contact_phones');
    expect(whereFragment).toContain(`l.log_link_type = 'email'`);
    expect(whereFragment).toContain('contact_emails');
    expect(whereFragment).toContain(`l.log_about_type = 'contact' AND l.log_about_id = ?`);
  });

  test('param order matches clause order: [String, String, raw, raw, String]', () => {
    const { params } = _buildContactLogWhere(412);

    expect(params).toEqual(['412', '412', 412, 412, '412']);
    expect(typeof params[0]).toBe('string');
    expect(typeof params[1]).toBe('string');
    expect(typeof params[2]).toBe('number');
    expect(typeof params[3]).toBe('number');
    expect(typeof params[4]).toBe('string');
  });

  test('string contactId input: raw params stay as passed, stringified stay strings', () => {
    const { params } = _buildContactLogWhere('412');
    expect(params).toEqual(['412', '412', '412', '412', '412']);
  });

  test('placeholder count equals param count', () => {
    const { whereFragment, params } = _buildContactLogWhere(412);
    expect(countPlaceholders(whereFragment)).toBe(params.length);
  });

  test('about arm does NOT window-resolve — no about clause touches contact_phones/contact_emails', () => {
    const { whereFragment } = _buildContactLogWhere(412);
    const aboutArms = whereFragment
      .split(/\bOR\b/)
      .filter(t => /log_about_type/.test(t));
    expect(aboutArms).toHaveLength(1);
    expect(aboutArms[0]).not.toContain('contact_phones');
    expect(aboutArms[0]).not.toContain('contact_emails');
    expect(aboutArms[0]).not.toContain('EXISTS');
  });
});
