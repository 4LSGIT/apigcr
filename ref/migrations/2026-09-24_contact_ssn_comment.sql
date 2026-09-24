-- ref/migrations/2026-09-24_contact_ssn_comment.sql
--
-- SSN policy reversal — bring the column COMMENT in line with the ruling.
--
-- COMMENT-only. No data, no type, no nullability change. Safe to run any time
-- relative to the code deploy: nothing reads this string at runtime, it exists
-- so the next person to open `ref/database.sql` is told the truth.
--
-- The old comment read:
--
--   'SSN for persons, EIN for orgs BY DESIGN — inherits masking AND the
--    resolver block (templates cannot emit it)'
--
-- Two thirds of that was already false and the last third stopped being true
-- on 2026-09-24:
--
--   - "inherits masking" — there was no masking. contactService.stripSsn was
--     defined, exported, imported by caseService and called nowhere; getContact
--     returned the column via SELECT *, getCase's clients include returned it
--     via SELECT co.*, and public/case.html rendered it in the Clients table.
--   - "the resolver block" — removed 2026-09-24 (Fred's ruling). A bankruptcy
--     firm files Form 121, which wants all nine digits; staff read the number
--     all day. resolverService.BLOCKED_COLUMNS no longer lists it.
--   - "templates cannot emit it" — they can now, both through the resolver and
--     through esign expression resolvers.
--
-- What IS still true and worth carrying in the comment: one column serves two
-- different things (SSN on persons, EIN on orgs), the format is inconsistent,
-- and two surfaces still refuse it for reasons that are NOT secrecy-from-staff
-- — portal cards (client-facing) and domain-event envelopes (they outlive the
-- contact row).

ALTER TABLE `contacts`
  MODIFY COLUMN `contact_ssn` char(11)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
    COMMENT 'SSN for persons, EIN for orgs BY DESIGN — one column, two meanings; branch on contact_kind. Ordinary readable/writable column since the 2026-09-24 ruling (staff, resolver, esign templates, reports). Still refused by portal cards (client-facing) and stripped from domain-event envelopes (they outlive the row). NOT NULL but usually empty; format inconsistent (both 123456789 and 123-45-6789 occur) — strip non-digits before comparing.';
