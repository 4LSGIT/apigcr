// lib/shellLinks.js
//
/**
 * Staff-shell deep links to ONE file, by exact id (wsurl S-links).
 *
 * The shell's canonical workspace form, `/?files=c<case_id>&open=file:0` /
 * `/?files=p<contact_id>&open=file:0`, reopens the file through
 * restoreOpenFiles, which verifies the id AND the type and fails safe ("could
 * not be reopened"). The legacy one-shot `/?case=<id>` / `/?contact=<id>` goes
 * through a limit=1 SEARCH instead, so an id that misses the exact tier (a
 * deleted contact; a contact_id over 6 digits) opens the search's best match
 * — another client's file. The shell still accepts the legacy form forever
 * (sent emails carry it); new links use this.
 *
 * The id shapes match the shell's own checks (public/index.html addFile /
 * restoreOpenFiles): case_id is opaque [A-Za-z0-9_-]+ (lib/caseId.js),
 * contact_id is digits. An id that fails falls back to the LEGACY form,
 * unchanged — never a broken ?files=.
 *
 * These return a RAW URL. It contains '&', so a site building HTML must
 * escape it once in the href — with its own escaper where it has one, else
 * with attr() below.
 */

'use strict';

const CASE_ID = /^[A-Za-z0-9_-]+$/;
const CONTACT_ID = /^\d+$/;

function origin(base) {
  return String(base || 'https://app.4lsg.com').replace(/\/+$/, '');
}

function idOf(id) {
  return id == null ? '' : String(id);
}

/** The staff-shell link to a case file. */
function caseLink(base, caseId) {
  const id = idOf(caseId);
  return CASE_ID.test(id)
    ? `${origin(base)}/?files=c${id}&open=file:0`
    : `${origin(base)}/?case=${id}`;
}

/** The staff-shell link to a contact file. */
function contactLink(base, contactId) {
  const id = idOf(contactId);
  return CONTACT_ID.test(id)
    ? `${origin(base)}/?files=p${id}&open=file:0`
    : `${origin(base)}/?contact=${id}`;
}

/** Escape a URL for a double-quoted HTML attribute. */
function attr(url) {
  return String(url)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { caseLink, contactLink, attr };
