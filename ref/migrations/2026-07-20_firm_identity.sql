-- ============================================================================
-- 2026-07-20_firm_identity.sql
-- Firm identity settings: firm_name, firm_address, firm_attorney_name.
--
-- WHY
--   services/esignPrefillService.js resolved 'firm.name' and 'attorney.name'
--   from HARDCODED STRING LITERALS, and 'firm.address' did not exist at all —
--   there was no address anywhere in app_settings, env, or the tree, so the
--   resolver was deliberately omitted (a template referencing it failed
--   ESIGN_BAD_RESOLVER at save time rather than rendering a legal document
--   with a silently blank address). This file supplies the missing data so
--   the code can stop hardcoding and the address resolver can exist.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- RUN THIS FIRST, THEN DEPLOY THE CODE.
--
-- SQL-first is the inert direction here. Nothing reads these keys until the
-- matching build ships: lib/firmConfig's REGISTRY has no entry for them, and
-- cfg() THROWS on an unregistered key, so the rows sit unread. The reverse
-- order is the dangerous one — deployed code would call cfg('firm_name')
-- against rows that do not exist yet, and firmConfig would return null on
-- every read until this ran. (The name resolvers keep a literal fallback, so
-- even that degrades rather than blanking; firm.address does not, and would
-- resolve to '' — caught by a required-field check only if the template
-- declares one. Do not rely on that. Run the SQL first.)
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Safe to re-run. Every INSERT refreshes the metadata columns but deliberately
-- PRESERVES `value`, so a re-run can never revert an address or firm name that
-- staff have since corrected in Settings.
--
-- To seed a DIFFERENT initial value, edit the VALUES clause before the first
-- run — or just save it in Settings -> Firm Identity afterwards.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. FIRM NAME
--
-- 'Legal Solutions Group' is the display name already used repo-wide
-- (routes/api.redirects.js, public/docReq.html, views/v.html). It stays a
-- literal fallback in esignPrefillService so clearing this row degrades to the
-- old hardcoded behaviour instead of putting a blank firm name on a retainer.
--
-- sort_order 5: first in the Firm Identity group, ahead of the existing
-- fe-firm_logo_url (10) / fe-firm_phone (20) / fe-firm_site_url (30) /
-- firm_email (40).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('firm_name', 'Legal Solutions Group', 0, 1, 'Firm Identity',
   'Firm Name',
   'The firm''s legal/display name as it should appear on generated documents (e-sign contracts, retainers). Leaving this blank falls back to the hardcoded ''Legal Solutions Group'' rather than rendering an empty name.',
   'string', 5)
ON DUPLICATE KEY UPDATE
  is_secret = VALUES(is_secret), is_editable = VALUES(is_editable),
  category  = VALUES(category),  label       = VALUES(label),
  description = VALUES(description), type = VALUES(type), sort_order = VALUES(sort_order);
  -- `value` deliberately absent: a re-run must not revert a staff edit.


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIRM ADDRESS
--
-- type `json_array` — ONE LINE PER ELEMENT. Both settings.html (VALIDATORS)
-- and PUT /api/app-settings (TYPE_VALIDATORS) enforce array-ness on save and
-- render it in a textarea, matching the fe-event_types / fe-trustees
-- precedent.
--
-- WHY AN ARRAY AND NOT A SINGLE STRING WITH A NEWLINE: the e-sign render path
-- HTML-escapes every interpolated value (esignSendService _escapeHtml), so a
-- '<br>' in this value would render as literal '&lt;br&gt;' and a '\n' would
-- collapse to a space. Keeping the lines separate lets the TEMPLATE decide the
-- layout — firm.address_line1 / firm.address_line2 in two elements for a
-- stacked block, or firm.address for the comma-joined inline form.
--
-- Elements are coerced and empty-filtered on read (_addressLines), so a third
-- line, or a trailing blank one, is harmless.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('firm_address',
   '["18481 W. 10 Mile Rd., #100","Southfield, MI 48075"]',
   0, 1, 'Firm Identity',
   'Firm Mailing Address',
   'The firm''s mailing address, ONE JSON STRING PER LINE - e.g. ["18481 W. 10 Mile Rd., #100","Southfield, MI 48075"]. Used on generated documents. Templates can place the lines separately (firm.address_line1 / firm.address_line2) or inline as a comma-joined single line (firm.address). Blank means no address renders at all - a template that marks its address field required will refuse to send rather than mail a contract with an empty address.',
   'json_array', 50)
ON DUPLICATE KEY UPDATE
  is_secret = VALUES(is_secret), is_editable = VALUES(is_editable),
  category  = VALUES(category),  label       = VALUES(label),
  description = VALUES(description), type = VALUES(type), sort_order = VALUES(sort_order);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ATTORNEY NAME
--
-- The firm's signing attorney. Same literal-fallback arrangement as firm_name.
--
-- ALSO CONSUMED BY workflow 30 (Adobe Sign: completion), step 2, which strips
-- the attorney out of the subject's "between X and Y" signer list to derive
-- the client's name. That parser currently carries its OWN lowercase literal
-- ("stuart sandweiss") inside custom_code; wiring it to this setting is a
-- separate workflow_steps edit, not part of this file.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO app_settings
  (`key`, `value`, is_secret, is_editable, category, label, description, type, sort_order)
VALUES
  ('firm_attorney_name', 'Stuart Sandweiss', 0, 1, 'Firm Identity',
   'Signing Attorney Name',
   'The attorney whose name appears on generated documents and whose name is stripped from Adobe Sign signer lists when identifying the client. Leaving this blank falls back to the hardcoded ''Stuart Sandweiss''.',
   'string', 60)
ON DUPLICATE KEY UPDATE
  is_secret = VALUES(is_secret), is_editable = VALUES(is_editable),
  category  = VALUES(category),  label       = VALUES(label),
  description = VALUES(description), type = VALUES(type), sort_order = VALUES(sort_order);


-- ============================================================================
-- VERIFY (run after applying)
-- ============================================================================
-- SELECT `key`, `value`, type, is_editable, sort_order
--   FROM app_settings
--  WHERE category = 'Firm Identity'
--  ORDER BY sort_order;
--
--    5  firm_name           Legal Solutions Group                  string
--   10  fe-firm_logo_url    https://iili.io/Jy2nXHv.md.png         url
--   20  fe-firm_phone       2484179800                             phone
--   30  fe-firm_site_url    https://legalsolutions.group           url
--   40  firm_email          office@4lsg.com                        email
--   50  firm_address        ["18481 W. 10 Mile Rd., #100", ...]    json_array
--   60  firm_attorney_name  Stuart Sandweiss                       string
--
-- Confirm the address parses as an array of exactly the intended lines:
-- SELECT JSON_VALID(`value`) AS ok,
--        JSON_LENGTH(`value`) AS lines,
--        JSON_EXTRACT(`value`, '$[0]') AS line1,
--        JSON_EXTRACT(`value`, '$[1]') AS line2
--   FROM app_settings WHERE `key` = 'firm_address';
--   → ok=1, lines=2
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- The code tolerates all three rows being absent: firm_name and
-- attorney.name fall back to their literals, firm.address resolves to ''.
-- Templates that declare an address key `required` will refuse to send.
--
--   DELETE FROM app_settings
--    WHERE `key` IN ('firm_name', 'firm_address', 'firm_attorney_name');
--
-- Note this does NOT roll back lib/firmConfig's REGISTRY entries — cfg() on a
-- registered-but-absent key returns null, which is the handled case.
-- ============================================================================
