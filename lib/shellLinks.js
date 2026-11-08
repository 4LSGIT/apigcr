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
 * caseLink's optional `tab` opens the file on that tab — `~<tab>` in its
 * ?files= token, e.g. 'checklists' (the email-attachment notice's Docs Needed
 * link). It must pass the shell's own ycSubTabOk shape or it is dropped and
 * the file opens on its default tab; the legacy form never carries one.
 *
 * These return a RAW URL. It contains '&', so a site building HTML must
 * escape it once in the href — with its own escaper where it has one, else
 * with attr() below.
 */

'use strict';

const CASE_ID = /^[A-Za-z0-9_-]+$/;
const CONTACT_ID = /^\d+$/;
/** public/index.html ycSubTabOk: a file's sub-tab token is a plain word. */
const TAB = /^[A-Za-z0-9_-]{1,32}$/;

function origin(base) {
  return String(base || 'https://app.4lsg.com').replace(/\/+$/, '');
}

function idOf(id) {
  return id == null ? '' : String(id);
}

/** The staff-shell link to a case file — on `tab` when given (see header). */
function caseLink(base, caseId, tab) {
  const id = idOf(caseId);
  if (!CASE_ID.test(id)) return `${origin(base)}/?case=${id}`;
  const rest = tab != null && TAB.test(String(tab)) ? `~${tab}` : '';
  return `${origin(base)}/?files=c${id}${rest}&open=file:0`;
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
