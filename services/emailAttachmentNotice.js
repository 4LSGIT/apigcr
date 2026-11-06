// services/emailAttachmentNotice.js
//
/**
 * The staff notice for one email whose attachments were filed — PURE (no I/O).
 *
 * services/emailAttachmentFilingService.js hands this its result; the output
 * rides out as `notice_subject` / `notice_html` / `notice_text` on the
 * `email_attachments_file` internal function, so a workflow's send_email step
 * can deliver it as-is. Layout ported from the docs@ digest rule's transform
 * (ref/migrations/2026-10-26_docs_digest_rule.console.js): tables + inline
 * styles, Outlook / webmail safe. Design: ref/EMAIL_ATTACHMENTS_DESIGN.md §5.
 *
 * EVERY string that came from the email or the database is escaped. The
 * subject is a MIME header, not HTML — never escaped (taskService convention).
 *
 * The subject keeps the docs@ digest's wording by default when the caller
 * passes its prefix ("New email to Docs@4LSG.com — "), so a mail filter keyed
 * on the old digest still matches.
 *
 * withOptions: the request_decision variant. The where-box carries the literal
 * token [[options_html]], which request_decision replaces with one button per
 * option. Because request_decision expands [[…]] tokens in its email_html and
 * subject (and THROWS on an unknown [[respond_url:X]]), no email-derived text
 * may carry "[[" into either: esc() encodes square brackets as entities (they
 * render the same), and the subject breaks "[[" / "]]" apart.
 */

'use strict';

const FIRM_TZ = process.env.FIRM_TIMEZONE || 'America/Detroit';

/** Message text shown, after quoted history is cut. */
const MAX_BODY = 4000;

const SKIP_REASON = Object.freeze({
  inline_image: 'inline image (signature / logo)',
  type_not_allowed: 'file type not filed',
  too_large: 'too large to file',
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"'[\]]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '[': '&#91;', ']': '&#93;' }[c]));

/** A MIME subject cannot use entities: break request_decision's [[ / ]] token marks instead. */
const unToken = (s) => String(s).replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]');

function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(date) {
  const d = date instanceof Date ? date : (date ? new Date(date) : null);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: FIRM_TZ, weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  }) + ' ET';
}

/** The sender's own words: quoted history cut (emailCaseMatchService.ownText), length capped. */
function messageExcerpt(text) {
  const { ownText } = require('./emailCaseMatchService');   // lazy (convention)
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '');
  let body = ownText(raw);
  const trimmed = body.length < raw.length;
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  let cut = 0;
  if (body.length > MAX_BODY) {
    cut = body.length - MAX_BODY;
    body = body.slice(0, MAX_BODY).replace(/\s+\S*$/, '');
  }
  return { body, trimmed, cut };
}

const TYPES = {
  pdf: ['PDF', '#b42318', '#fdecea'],
  jpg: ['JPG', '#1d7a46', '#e7f5ec'], jpeg: ['JPG', '#1d7a46', '#e7f5ec'], png: ['PNG', '#1d7a46', '#e7f5ec'],
  heic: ['HEIC', '#1d7a46', '#e7f5ec'], gif: ['GIF', '#1d7a46', '#e7f5ec'], tif: ['TIFF', '#1d7a46', '#e7f5ec'],
  tiff: ['TIFF', '#1d7a46', '#e7f5ec'], webp: ['WEBP', '#1d7a46', '#e7f5ec'], bmp: ['BMP', '#1d7a46', '#e7f5ec'],
  doc: ['DOC', '#1849a9', '#e8eefb'], docx: ['DOCX', '#1849a9', '#e8eefb'], rtf: ['RTF', '#1849a9', '#e8eefb'],
  odt: ['ODT', '#1849a9', '#e8eefb'], txt: ['TXT', '#1849a9', '#e8eefb'],
  xls: ['XLS', '#0e6245', '#e5f4ee'], xlsx: ['XLSX', '#0e6245', '#e5f4ee'], ods: ['ODS', '#0e6245', '#e5f4ee'],
  csv: ['CSV', '#0e6245', '#e5f4ee'],
};
function typeOf(name) {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(String(name || '')) || [])[1];
  return TYPES[String(ext || '').toLowerCase()] || ['FILE', '#475467', '#eef0f3'];
}

/**
 * @param {object} o
 * @param {object} o.result       the filing result (emailAttachmentFilingService)
 * @param {string} [o.subjectPrefix] default 'Emailed files — '
 * @param {string} [o.title]      the small header label, default the mailbox-neutral 'Emailed documents'
 * @param {boolean} [o.withOptions] put [[options_html]] in the where-box (request_decision email_html)
 * @returns {{subject: string, html: string, text: string}}
 */
function render({ result, subjectPrefix = 'Emailed files — ', title = 'Emailed documents', withOptions = false } = {}) {
  const r = result || {};
  const from = r.from || {};
  const who = from.name || from.email || 'Unknown sender';
  const files = Array.isArray(r.files) ? r.files : [];
  const skipped = Array.isArray(r.skipped) ? r.skipped : [];
  const landed = files.filter(f => f.status === 'filed' || f.status === 'already_filed');
  const failed = files.filter(f => f.status === 'failed' || f.status === 'in_progress');
  const match = r.match || {};
  const caseId = r.case_id || null;
  const unsorted = r.placement === 'unsorted';
  const nAll = files.length + skipped.length;

  // ── subject ──
  const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
  let outcome;
  if (!nAll) outcome = ' (no files)';
  else if (!landed.length) outcome = ` (${nAll} file${nAll === 1 ? '' : 's'}) — NOT FILED`;
  else if (caseId && !unsorted) outcome = ` (${landed.length} file${landed.length === 1 ? '' : 's'}) — filed to case ${caseId}`;
  else outcome = ` (${landed.length} file${landed.length === 1 ? '' : 's'}) — UNSORTED, needs a case`;
  const subject = unToken(`${subjectPrefix}${oneLine(who)}${outcome}`);

  // ── pieces ──
  const when = fmtWhen(r.date);
  const ex = messageExcerpt(r.text);
  const F = "font-family:'Segoe UI',Helvetica,Arial,sans-serif;";
  const label = (t) => `<div style="${F}font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7385;margin:0 0 8px;">${esc(t)}</div>`;
  const button = (href, text, dark) => `<a href="${esc(href)}" style="display:inline-block;${F}font-size:13px;font-weight:600;` +
    (dark ? 'color:#ffffff;background:#1f3a5f;' : 'color:#1f3a5f;background:#e8eefb;border:1px solid #c9d6ef;') +
    `border-radius:6px;padding:8px 13px;text-decoration:none;margin:0 6px 6px 0;">${esc(text)}</a>`;

  // where it went
  let whereHead;
  let whereBody;
  let tone;
  if (!nAll) {
    tone = ['#f8f9fb', '#eef0f4', '#475467'];
    whereHead = 'No attachments';
    whereBody = 'This email carried no files.';
  } else if (!landed.length) {
    tone = ['#fdecea', '#f5c2bd', '#8a1f13'];
    whereHead = 'Nothing was filed';
    whereBody = 'None of the attachments could be filed (listed below). Open the email in YisraCase → Comms or Gmail and save them by hand.';
  } else if (caseId && !unsorted) {
    tone = ['#e7f5ec', '#b7e1c6', '#14532d'];
    whereHead = `Filed to case ${caseId}`;
    whereBody = `${match.reason || ''} Review the files, rename them, and move them where they belong in the case folder.`.trim();
  } else {
    tone = ['#fff4e5', '#f5d5a8', '#7a4a06'];
    whereHead = 'Filed to Unsorted — needs a case';
    whereBody = `${match.reason || 'No case could be chosen.'} Move the files to the right case folder.`;
  }
  const links = [];
  if (r.folder_link) links.push(button(r.folder_link, 'Open the Dropbox folder', true));
  if (caseId && r.case_link) links.push(button(r.case_link, `Open case ${caseId} in YisraCase`));
  if (!caseId && r.contact_link && match.contact) links.push(button(r.contact_link, `Open ${match.contact.name || 'the contact'} in YisraCase`));
  const cands = (!caseId || unsorted) && Array.isArray(match.candidates) ? match.candidates : [];
  const candHtml = cands.length
    ? `<div style="${F}font-size:13px;color:#1d2433;margin-top:10px;">Possible cases:</div><ul style="margin:6px 0 0 18px;padding:0;">` +
      cands.map(c => `<li style="${F}font-size:13px;color:#1d2433;margin:2px 0;">` +
        (r.app_url ? `<a href="${esc(caseLinkOf(r.app_url, c.case_id))}" style="color:#1f3a5f;">${esc(c.case_id)}</a>` : esc(c.case_id)) +
        esc(` — ${[c.case_number, c.case_type, c.case_stage].filter(Boolean).join(' · ')}`) + '</li>').join('') + '</ul>'
    : '';
  const folderLine = r.folder_path
    ? `<div style="${F}font-size:12px;color:#475467;margin-top:8px;word-break:break-all;">Dropbox: ${esc(r.folder_path)}</div>`
    : '';

  // files
  const statusText = (f) => (f.status === 'already_filed' ? 'filed earlier'
    : f.status === 'in_progress' ? 'being filed by another run'
      : f.status === 'failed' ? `NOT filed — ${f.error || 'error'}` : '');
  const fileRow = (name, size, note, noteColor) => {
    const t = typeOf(name);
    return '<tr>' +
      `<td width="52" style="padding:7px 0;vertical-align:middle;"><span style="display:inline-block;min-width:38px;text-align:center;${F}font-size:10px;font-weight:700;letter-spacing:.04em;color:${t[1]};background:${t[2]};border-radius:4px;padding:3px 5px;">${t[0]}</span></td>` +
      `<td style="padding:7px 8px 7px 0;${F}font-size:14px;color:#1d2433;word-break:break-all;">${esc(name)}` +
      (note ? `<div style="${F}font-size:12px;color:${noteColor};margin-top:2px;">${esc(note)}</div>` : '') + '</td>' +
      `<td align="right" style="padding:7px 0;${F}font-size:12px;color:#6b7385;white-space:nowrap;">${esc(fmtBytes(size))}</td></tr>`;
  };
  const sep = '<tr><td colspan="3" style="border-top:1px solid #eef0f4;font-size:0;line-height:0;">&nbsp;</td></tr>';
  const rows = [
    ...landed.map(f => fileRow(f.filed_name || f.filename, f.bytes, statusText(f), '#6b7385')),
    ...failed.map(f => fileRow(f.filename, f.bytes, statusText(f), '#b42318')),
    ...skipped.map(s => fileRow(s.filename, null, `not filed — ${SKIP_REASON[s.reason] || s.reason}`, '#8a92a3')),
  ];

  const bodyHtml = ex.body
    ? esc(ex.body).replace(/\n/g, '<br>')
    : `<span style="color:#8a92a3;font-style:italic;">${nAll ? 'No message — attachments only.' : '(empty message)'}</span>`;

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f2f4f7;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f4f7;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dde2ea;border-radius:10px;">' +
    // header
    `<tr><td style="background:#1f3a5f;border-radius:10px 10px 0 0;padding:18px 24px;">` +
      `<div style="${F}font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#b9c7dc;">${esc(title)}</div>` +
      `<div style="${F}font-size:20px;font-weight:600;color:#ffffff;margin-top:4px;">` +
        esc(nAll ? `${landed.length} of ${nAll} file${nAll === 1 ? '' : 's'} filed` : 'New email (no attachments)') + '</div>' +
    '</td></tr>' +
    // where
    `<tr><td style="padding:20px 24px 4px;"><div style="background:${tone[0]};border:1px solid ${tone[1]};border-radius:8px;padding:12px 14px;">` +
      `<div style="${F}font-size:15px;font-weight:700;color:${tone[2]};">${esc(whereHead)}</div>` +
      `<div style="${F}font-size:13px;line-height:1.5;color:#1d2433;margin-top:4px;">${esc(whereBody)}</div>` +
      candHtml + folderLine +
      (withOptions
        ? `<div style="${F}font-size:13px;font-weight:600;color:#1d2433;margin:12px 0 6px;">Which case? The files move there when you choose.</div>[[options_html]]`
        : '') +
    '</div></td></tr>' +
    (links.length ? `<tr><td style="padding:12px 24px 0;">${links.join('')}</td></tr>` : '') +
    // sender
    `<tr><td style="padding:16px 24px 4px;">${label('From')}` +
      `<div style="${F}font-size:16px;font-weight:600;color:#1d2433;">${esc(who)}</div>` +
      (from.email && who !== from.email ? `<div style="${F}font-size:13px;color:#475467;margin-top:2px;">${esc(from.email)}</div>` : '') +
      (when ? `<div style="${F}font-size:12px;color:#8a92a3;margin-top:4px;">${esc(when)}</div>` : '') +
    '</td></tr>' +
    `<tr><td style="padding:16px 24px 4px;">${label('Subject')}` +
      `<div style="${F}font-size:15px;color:#1d2433;">${r.subject ? esc(r.subject) : '<span style="color:#8a92a3;font-style:italic;">(no subject)</span>'}</div>` +
    '</td></tr>' +
    // files
    `<tr><td style="padding:18px 24px 4px;">${label(`Attachments (${nAll})`)}` +
      (rows.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join(sep)}</table>`
        : `<div style="${F}font-size:14px;color:#8a92a3;font-style:italic;">None</div>`) +
    '</td></tr>' +
    // message
    `<tr><td style="padding:18px 24px 22px;">${label('Message')}` +
      `<div style="${F}font-size:14px;line-height:1.5;color:#1d2433;background:#f8f9fb;border:1px solid #eef0f4;border-radius:8px;padding:12px 14px;">${bodyHtml}` +
        (ex.trimmed ? '<div style="font-size:12px;color:#8a92a3;margin-top:10px;">— earlier messages in the thread trimmed —</div>' : '') +
        (ex.cut ? `<div style="font-size:12px;color:#8a92a3;margin-top:10px;">— message shortened (${ex.cut} more characters) —</div>` : '') +
      '</div>' +
    '</td></tr>' +
    `<tr><td style="background:#f8f9fb;border-top:1px solid #eef0f4;border-radius:0 0 10px 10px;padding:12px 24px;">` +
      `<div style="${F}font-size:11px;line-height:1.5;color:#8a92a3;">Sent automatically by YisraCase. The original email is in YisraCase → Comms.</div>` +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';

  // ── plain text ──
  const t = [];
  t.push(nAll ? `${landed.length} of ${nAll} file${nAll === 1 ? '' : 's'} filed` : 'New email (no attachments)');
  t.push('');
  t.push(`${whereHead}. ${whereBody}`);
  for (const c of cands) t.push(`  possible case: ${c.case_id} — ${[c.case_number, c.case_type, c.case_stage].filter(Boolean).join(' · ')}`);
  if (r.folder_path) t.push(`Dropbox: ${r.folder_path}`);
  if (r.folder_link) t.push(`Folder: ${r.folder_link}`);
  if (caseId && r.case_link) t.push(`Case: ${r.case_link}`);
  t.push('');
  t.push(`From: ${who}${from.email && who !== from.email ? ` <${from.email}>` : ''}`);
  if (when) t.push(`Received: ${when}`);
  t.push(`Subject: ${r.subject || '(no subject)'}`);
  t.push('');
  t.push(`Attachments (${nAll}):`);
  if (!nAll) t.push('  none');
  for (const f of landed) t.push(`  - ${f.filed_name || f.filename}${fmtBytes(f.bytes) ? ` (${fmtBytes(f.bytes)})` : ''}${statusText(f) ? ` — ${statusText(f)}` : ''}`);
  for (const f of failed) t.push(`  - ${f.filename} — ${statusText(f)}`);
  for (const s of skipped) t.push(`  - ${s.filename} — not filed: ${SKIP_REASON[s.reason] || s.reason}`);
  t.push('');
  t.push('Message:');
  t.push(ex.body || (nAll ? '(no message — attachments only)' : '(empty message)'));
  if (ex.trimmed) t.push('— earlier messages in the thread trimmed —');
  if (ex.cut) t.push(`— message shortened (${ex.cut} more characters) —`);

  return { subject, html, text: t.join('\n') };
}

function caseLinkOf(appUrl, caseId) {
  return require('../lib/shellLinks').caseLink(appUrl, caseId);   // lazy (convention)
}

module.exports = { render, messageExcerpt, fmtBytes, MAX_BODY };
