// services/emailAttachmentNotice.js
//
/**
 * The staff notice for one email whose attachments were filed — PURE (no I/O).
 * renderDigest: the same notice for a BURST of emails from one sender
 * (services/emailAttachmentDigestService, design §8).
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
 * Each filed file's name links to it (`files[].link`, the folder link opened on
 * the file), and a case with a Docs Needed list gets its link, its open items
 * and "check them off" in the instructions (`docs_checklist`).
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

/** The day alone / the time alone, firm-local — a digest of one day's emails names the day once. */
function fmtDay(date) {
  const d = date instanceof Date ? date : (date ? new Date(date) : null);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { timeZone: FIRM_TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTime(date) {
  const d = date instanceof Date ? date : (date ? new Date(date) : null);
  if (!d || isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { timeZone: FIRM_TZ, hour: 'numeric', minute: '2-digit' }) + ' ET';
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

// ── shared pieces (render and renderDigest) ─────────────────────────────────
const F = "font-family:'Segoe UI',Helvetica,Arial,sans-serif;";
const label = (t) => `<div style="${F}font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7385;margin:0 0 8px;">${esc(t)}</div>`;
const button = (href, text, dark) => `<a href="${esc(href)}" style="display:inline-block;${F}font-size:13px;font-weight:600;` +
  (dark ? 'color:#ffffff;background:#1f3a5f;' : 'color:#1f3a5f;background:#e8eefb;border:1px solid #c9d6ef;') +
  `border-radius:6px;padding:8px 13px;text-decoration:none;margin:0 6px 6px 0;">${esc(text)}</a>`;
const oneLine = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 120);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const statusText = (f) => (f.status === 'already_filed' ? 'filed earlier'
  : f.status === 'in_progress' ? 'being filed by another run'
    : f.status === 'failed' ? `NOT filed — ${f.error || 'error'}` : '');
const fileRow = (name, size, note, noteColor, href) => {
  const t = typeOf(name);
  return '<tr>' +
    `<td width="52" style="padding:7px 0;vertical-align:middle;"><span style="display:inline-block;min-width:38px;text-align:center;${F}font-size:10px;font-weight:700;letter-spacing:.04em;color:${t[1]};background:${t[2]};border-radius:4px;padding:3px 5px;">${t[0]}</span></td>` +
    `<td style="padding:7px 8px 7px 0;${F}font-size:14px;color:#1d2433;word-break:break-all;">` +
      (href ? `<a href="${esc(href)}" style="color:#1f3a5f;">${esc(name)}</a>` : esc(name)) +
    (note ? `<div style="${F}font-size:12px;color:${noteColor};margin-top:2px;">${esc(note)}</div>` : '') + '</td>' +
    `<td align="right" style="padding:7px 0;${F}font-size:12px;color:#6b7385;white-space:nowrap;">${esc(fmtBytes(size))}</td></tr>`;
};
const sep = '<tr><td colspan="3" style="border-top:1px solid #eef0f4;font-size:0;line-height:0;">&nbsp;</td></tr>';

/** One email's file rows: filed, then failed, then skipped. */
function fileRows(files, skipped) {
  const landed = files.filter(f => f.status === 'filed' || f.status === 'already_filed');
  const failed = files.filter(f => f.status === 'failed' || f.status === 'in_progress');
  return [
    ...landed.map(f => fileRow(f.filed_name || f.filename, f.bytes, statusText(f), '#6b7385', f.link)),
    ...failed.map(f => fileRow(f.filename, f.bytes, statusText(f), '#b42318')),
    ...skipped.map(s => fileRow(s.filename, null, `not filed — ${SKIP_REASON[s.reason] || s.reason}`, '#8a92a3')),
  ];
}
function fileLines(files, skipped) {
  const landed = files.filter(f => f.status === 'filed' || f.status === 'already_filed');
  const failed = files.filter(f => f.status === 'failed' || f.status === 'in_progress');
  return [
    ...landed.map(f => `  - ${f.filed_name || f.filename}${fmtBytes(f.bytes) ? ` (${fmtBytes(f.bytes)})` : ''}${statusText(f) ? ` — ${statusText(f)}` : ''}`),
    ...failed.map(f => `  - ${f.filename} — ${statusText(f)}`),
    ...skipped.map(s => `  - ${s.filename} — not filed: ${SKIP_REASON[s.reason] || s.reason}`),
  ];
}

/** The Docs Needed block: {head, html, text[]} — or null without a list. */
function docsNeeded(dl) {
  if (!dl || !dl.link) return null;
  const more = dl.open_count - dl.open.length;
  const head = dl.open_count
    ? `Docs Needed list — ${dl.open_count} of ${dl.items} still needed:`
    : `Docs Needed list — ${dl.items ? `all ${dl.items} items checked off` : 'no items yet'}`;
  const html = `<div style="${F}font-size:13px;color:#1d2433;margin-top:10px;"><a href="${esc(dl.link)}" style="color:#1f3a5f;">${esc(head)}</a></div>` +
    (dl.open.length
      ? `<ul style="margin:4px 0 0 18px;padding:0;">${dl.open.map(n => `<li style="${F}font-size:13px;color:#1d2433;margin:2px 0;">${esc(n)}</li>`).join('')}` +
        (more > 0 ? `<li style="${F}font-size:13px;color:#6b7385;margin:2px 0;list-style:none;">${esc(`+ ${more} more`)}</li>` : '') + '</ul>'
      : '');
  const text = [`${head} ${dl.link}`, ...dl.open.map(n => `  - ${n}`), ...(more > 0 ? [`  + ${more} more`] : [])];
  return { head, html, text };
}

/** The candidate cases a person may pick from. */
function candidatesHtml(cands, appUrl) {
  return cands.length
    ? `<div style="${F}font-size:13px;color:#1d2433;margin-top:10px;">Possible cases:</div><ul style="margin:6px 0 0 18px;padding:0;">` +
      cands.map(c => `<li style="${F}font-size:13px;color:#1d2433;margin:2px 0;">` +
        (appUrl ? `<a href="${esc(caseLinkOf(appUrl, c.case_id))}" style="color:#1f3a5f;">${esc(c.case_id)}</a>` : esc(c.case_id)) +
        esc(` — ${[c.case_number, c.case_type, c.case_stage].filter(Boolean).join(' · ')}`) + '</li>').join('') + '</ul>'
    : '';
}
const candidateLine = (c) => `  possible case: ${c.case_id} — ${[c.case_number, c.case_type, c.case_stage].filter(Boolean).join(' · ')}`;

/** The outer frame: header (title + headline), the given rows, footer. */
function frame(title, headline, rowsHtml) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:#f2f4f7;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f4f7;"><tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dde2ea;border-radius:10px;">' +
    // header
    `<tr><td style="background:#1f3a5f;border-radius:10px 10px 0 0;padding:18px 24px;">` +
      `<div style="${F}font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#b9c7dc;">${esc(title)}</div>` +
      `<div style="${F}font-size:20px;font-weight:600;color:#ffffff;margin-top:4px;">` + esc(headline) + '</div>' +
    '</td></tr>' +
    rowsHtml +
    `<tr><td style="background:#f8f9fb;border-top:1px solid #eef0f4;border-radius:0 0 10px 10px;padding:12px 24px;">` +
      `<div style="${F}font-size:11px;line-height:1.5;color:#8a92a3;">Sent automatically by YisraCase. The original email is in YisraCase → Comms.</div>` +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

/** A coloured where-box. */
function whereBox(tone, head, body, extraHtml) {
  return `<tr><td style="padding:20px 24px 4px;"><div style="background:${tone[0]};border:1px solid ${tone[1]};border-radius:8px;padding:12px 14px;">` +
    `<div style="${F}font-size:15px;font-weight:700;color:${tone[2]};">${esc(head)}</div>` +
    `<div style="${F}font-size:13px;line-height:1.5;color:#1d2433;margin-top:4px;">${esc(body)}</div>` +
    extraHtml +
    '</div></td></tr>';
}
const TONE = Object.freeze({
  none: ['#f8f9fb', '#eef0f4', '#475467'],
  failed: ['#fdecea', '#f5c2bd', '#8a1f13'],
  case: ['#e7f5ec', '#b7e1c6', '#14532d'],
  unsorted: ['#fff4e5', '#f5d5a8', '#7a4a06'],
});

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
  const match = r.match || {};
  const caseId = r.case_id || null;
  const unsorted = r.placement === 'unsorted';
  const nAll = files.length + skipped.length;
  const dl = r.docs_checklist && r.docs_checklist.link ? r.docs_checklist : null;   // the client's Docs Needed list

  // ── subject ──
  let outcome;
  if (!nAll) outcome = ' (no files)';
  else if (!landed.length) outcome = ` (${nAll} file${nAll === 1 ? '' : 's'}) — NOT FILED`;
  else if (caseId && !unsorted) outcome = ` (${landed.length} file${landed.length === 1 ? '' : 's'}) — filed to case ${caseId}`;
  else outcome = ` (${landed.length} file${landed.length === 1 ? '' : 's'}) — UNSORTED, needs a case`;
  const subject = unToken(`${subjectPrefix}${oneLine(who)}${outcome}`);

  // ── pieces ──
  const when = fmtWhen(r.date);
  const ex = messageExcerpt(r.text);

  // where it went
  let whereHead;
  let whereBody;
  let tone;
  if (!nAll) {
    tone = TONE.none;
    whereHead = 'No attachments';
    whereBody = 'This email carried no files.';
  } else if (!landed.length) {
    tone = TONE.failed;
    whereHead = 'Nothing was filed';
    whereBody = 'None of the attachments could be filed (listed below). Open the email in YisraCase → Comms or Gmail and save them by hand.';
  } else if (caseId && !unsorted) {
    tone = TONE.case;
    whereHead = `Filed to case ${caseId}`;
    whereBody = `${match.reason || ''} Review the files, rename them, ` +
      (dl ? 'move them where they belong in the case folder, and check them off the Docs Needed list.'
        : 'and move them where they belong in the case folder.');
    whereBody = whereBody.trim();
  } else {
    tone = TONE.unsorted;
    whereHead = 'Filed to Unsorted — needs a case';
    whereBody = `${match.reason || 'No case could be chosen.'} Move the files to the right case folder.` +
      (dl ? ' Then check them off the Docs Needed list.' : '');
  }
  const links = [];
  if (r.folder_link) links.push(button(r.folder_link, 'Open the Dropbox folder', true));
  if (caseId && r.case_link) links.push(button(r.case_link, `Open case ${caseId} in YisraCase`));
  if (dl) links.push(button(dl.link, 'Open the Docs Needed list'));
  if (!caseId && r.contact_link && match.contact) links.push(button(r.contact_link, `Open ${match.contact.name || 'the contact'} in YisraCase`));
  const cands = (!caseId || unsorted) && Array.isArray(match.candidates) ? match.candidates : [];
  const candHtml = candidatesHtml(cands, r.app_url);
  const folderLine = r.folder_path
    ? `<div style="${F}font-size:12px;color:#475467;margin-top:8px;word-break:break-all;">Dropbox: ${esc(r.folder_path)}</div>`
    : '';
  const dn = docsNeeded(dl);
  const dlHtml = dn ? dn.html : '';

  // files
  const rows = fileRows(files, skipped);

  const bodyHtml = ex.body
    ? esc(ex.body).replace(/\n/g, '<br>')
    : `<span style="color:#8a92a3;font-style:italic;">${nAll ? 'No message — attachments only.' : '(empty message)'}</span>`;

  const html = frame(title, nAll ? `${landed.length} of ${nAll} file${nAll === 1 ? '' : 's'} filed` : 'New email (no attachments)',
    // where
    whereBox(tone, whereHead, whereBody, candHtml + folderLine + dlHtml +
      (withOptions
        ? `<div style="${F}font-size:13px;font-weight:600;color:#1d2433;margin:12px 0 6px;">Which case? The files move there when you choose.</div>[[options_html]]`
        : '')) +
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
    '</td></tr>');

  // ── plain text ──
  const t = [];
  t.push(nAll ? `${landed.length} of ${nAll} file${nAll === 1 ? '' : 's'} filed` : 'New email (no attachments)');
  t.push('');
  t.push(`${whereHead}. ${whereBody}`);
  for (const c of cands) t.push(candidateLine(c));
  if (r.folder_path) t.push(`Dropbox: ${r.folder_path}`);
  if (r.folder_link) t.push(`Folder: ${r.folder_link}`);
  if (caseId && r.case_link) t.push(`Case: ${r.case_link}`);
  if (dn) t.push(...dn.text);
  t.push('');
  t.push(`From: ${who}${from.email && who !== from.email ? ` <${from.email}>` : ''}`);
  if (when) t.push(`Received: ${when}`);
  t.push(`Subject: ${r.subject || '(no subject)'}`);
  t.push('');
  t.push(`Attachments (${nAll}):`);
  if (!nAll) t.push('  none');
  t.push(...fileLines(files, skipped));
  t.push('');
  t.push('Message:');
  t.push(ex.body || (nAll ? '(no message — attachments only)' : '(empty message)'));
  if (ex.trimmed) t.push('— earlier messages in the thread trimmed —');
  if (ex.cut) t.push(`— message shortened (${ex.cut} more characters) —`);

  return { subject, html, text: t.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderDigest — one notice for a BURST of emails from one sender
// ─────────────────────────────────────────────────────────────────────────────

/** Message text shown per email in a digest (each email's excerpt is cut again to this). */
const DIGEST_BODY_MAX = 600;

const landedOf = (r) => (Array.isArray(r.files) ? r.files : []).filter(f => f.status === 'filed' || f.status === 'already_filed');
const failedOf = (r) => (Array.isArray(r.files) ? r.files : []).filter(f => f.status === 'failed' || f.status === 'in_progress');
/** Where an email's filed files went: 'case:<id>', 'unsorted', or null (nothing landed). */
const destOf = (r) => (!landedOf(r).length ? null
  : (r.placement === 'unsorted' || !r.case_id ? 'unsorted' : `case:${r.case_id}`));

function digestExcerpt(r) {
  const ex = r.excerpt && typeof r.excerpt === 'object' ? r.excerpt : { body: '', trimmed: false, cut: 0 };
  let body = String(ex.body || '');
  let cut = Number(ex.cut) || 0;
  if (body.length > DIGEST_BODY_MAX) {
    cut += body.length - DIGEST_BODY_MAX;
    body = body.slice(0, DIGEST_BODY_MAX).replace(/\s+\S*$/, '');
  }
  return { body, trimmed: !!ex.trimmed, cut };
}

/**
 * The notice for several emails from one sender (services/emailAttachmentDigestService).
 * One where-box per destination — each case the files went to, the unsorted
 * folder, and what could not be filed — then every email, oldest first, with
 * its files and a short excerpt. Same escaping and [[…]] rules as render().
 *
 * @param {object} o
 * @param {object[]} o.results     the stored filing results, oldest first (≥ 1)
 * @param {object} [o.checklists]  case_id → docs_checklist read at digest time (fresher than each result's)
 * @param {string} [o.subjectPrefix]
 * @param {string} [o.title]
 * @param {boolean} [o.withOptions] put [[options_html]] in the unsorted box (request_decision email_html)
 * @returns {{subject: string, html: string, text: string}}
 */
function renderDigest({ results, checklists = {}, subjectPrefix = 'Emailed files — ', title = 'Emailed documents', withOptions = false } = {}) {
  const rs = (Array.isArray(results) ? results : []).filter(Boolean);
  const last = rs[rs.length - 1] || {};
  const from = last.from || {};
  const who = from.name || from.email || 'Unknown sender';
  const nAll = rs.reduce((a, r) => a + (Array.isArray(r.files) ? r.files.length : 0) + (Array.isArray(r.skipped) ? r.skipped.length : 0), 0);
  const nLanded = rs.reduce((a, r) => a + landedOf(r).length, 0);
  const nFailed = rs.reduce((a, r) => a + failedOf(r).length, 0);
  const appUrl = (rs.find(r => r.app_url) || {}).app_url || '';

  // destinations, in first-seen order: cases, then unsorted
  const groups = new Map();
  for (const r of rs) {
    const k = destOf(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === 'unsorted') - (b === 'unsorted'));
  const caseIds = keys.filter(k => k !== 'unsorted').map(k => k.slice(5));
  const unsortedRs = groups.get('unsorted') || [];

  // ── subject ──
  let outcome;
  if (!nAll) outcome = ` (${plural(rs.length, 'email')}, no files)`;
  else if (!nLanded) outcome = ` (${plural(nAll, 'file')} from ${plural(rs.length, 'email')}) — NOT FILED`;
  else {
    const head = ` (${plural(nLanded, 'file')} from ${plural(rs.length, 'email')})`;
    outcome = unsortedRs.length ? `${head} — UNSORTED, needs a case`
      : `${head} — filed to case${caseIds.length === 1 ? '' : 's'} ${caseIds.join(', ')}`;
  }
  const subject = unToken(`${subjectPrefix}${oneLine(who)}${outcome}`);

  // ── where-boxes ──
  const boxes = [];
  const t = [];
  const headline = nAll ? `${plural(rs.length, 'email')} · ${nLanded} of ${plural(nAll, 'file')} filed` : `${plural(rs.length, 'email')} (no attachments)`;
  t.push(headline);
  const folderLines = (grp) => [...new Set(grp.map(r => r.folder_path).filter(Boolean))];
  const folderLinks = (grp) => [...new Map(grp.filter(r => r.folder_link).map(r => [r.folder_path || r.folder_link, r.folder_link])).values()];
  const folderHtml = (paths) => paths.map(p =>
    `<div style="${F}font-size:12px;color:#475467;margin-top:8px;word-break:break-all;">Dropbox: ${esc(p)}</div>`).join('');
  const buttonsHtml = (bs) => (bs.length ? `<div style="margin-top:12px;">${bs.join('')}</div>` : '');
  for (const k of keys) {
    const grp = groups.get(k);
    const lastR = grp[grp.length - 1];
    const n = grp.reduce((a, r) => a + landedOf(r).length, 0);
    const paths = folderLines(grp);
    const links = folderLinks(grp);
    t.push('');
    if (k !== 'unsorted') {
      const caseId = k.slice(5);
      const dn = docsNeeded(checklists[caseId] !== undefined ? checklists[caseId] : lastR.docs_checklist);
      const head = `Filed to case ${caseId} — ${plural(n, 'file')} from ${plural(grp.length, 'email')}`;
      const body = `${(lastR.match && lastR.match.reason) || ''} Review the files, rename them, ` +
        (dn ? 'move them where they belong in the case folder, and check them off the Docs Needed list.'
          : 'and move them where they belong in the case folder.');
      const bs = [
        ...links.map((l, i) => button(l, links.length > 1 ? `Open Dropbox folder ${i + 1}` : 'Open the Dropbox folder', true)),
        ...(lastR.case_link ? [button(lastR.case_link, `Open case ${caseId} in YisraCase`)] : []),
        ...(dn ? [button(checklists[caseId] ? checklists[caseId].link : lastR.docs_checklist.link, 'Open the Docs Needed list')] : []),
      ];
      boxes.push(whereBox(TONE.case, head, body.trim(), folderHtml(paths) + (dn ? dn.html : '') + buttonsHtml(bs)));
      t.push(`${head}. ${body.trim()}`);
      for (const p of paths) t.push(`Dropbox: ${p}`);
      for (const l of links) t.push(`Folder: ${l}`);
      if (lastR.case_link) t.push(`Case: ${lastR.case_link}`);
      if (dn) t.push(...dn.text);
    } else {
      const cands = [...new Map(grp.flatMap(r => (r.match && Array.isArray(r.match.candidates) ? r.match.candidates : []))
        .map(c => [c.case_id, c])).values()];
      const withContact = grp.find(r => r.contact_link && r.match && r.match.contact);
      const head = `Filed to Unsorted — needs a case — ${plural(n, 'file')} from ${plural(grp.length, 'email')}`;
      const body = `${(lastR.match && lastR.match.reason) || 'No case could be chosen.'} Move the files to the right case folder.`;
      const bs = [
        ...links.map((l, i) => button(l, links.length > 1 ? `Open Dropbox folder ${i + 1}` : 'Open the Dropbox folder', true)),
        ...(withContact ? [button(withContact.contact_link, `Open ${withContact.match.contact.name || 'the contact'} in YisraCase`)] : []),
      ];
      boxes.push(whereBox(TONE.unsorted, head, body, candidatesHtml(cands, appUrl) + folderHtml(paths) +
        (withOptions
          ? `<div style="${F}font-size:13px;font-weight:600;color:#1d2433;margin:12px 0 6px;">Which case? Every unsorted file in this notice moves there when you choose.</div>[[options_html]]`
          : '') + buttonsHtml(bs)));
      t.push(`${head}. ${body}`);
      for (const c of cands) t.push(candidateLine(c));
      for (const p of paths) t.push(`Dropbox: ${p}`);
      for (const l of links) t.push(`Folder: ${l}`);
    }
  }
  if (nFailed) {
    const head = `${plural(nFailed, 'file')} could not be filed`;
    const body = 'They are listed below with the reason. Open the email in YisraCase → Comms or Gmail and save them by hand.';
    boxes.push(whereBox(TONE.failed, head, body, ''));
    t.push('', `${head}. ${body}`);
  }
  if (!boxes.length) {
    const body = 'These emails carried no files.';
    boxes.push(whereBox(TONE.none, 'No attachments', body, ''));
    t.push('', `No attachments. ${body}`);
  }

  // ── sender, then every email ──
  const days = new Set(rs.map(r => fmtDay(r.date)));
  const oneDay = days.size === 1 && !days.has('');
  const firstWhen = fmtWhen(rs[0] && rs[0].date);
  const lastWhen = fmtWhen(last.date);
  const span = firstWhen && lastWhen && firstWhen !== lastWhen
    ? `${firstWhen} – ${oneDay ? fmtTime(last.date) : lastWhen}` : (lastWhen || firstWhen);
  const whenOf = (r) => (oneDay ? fmtTime(r.date) : fmtWhen(r.date)) || 'Email';
  const tagged = keys.length > 1;
  const emailBlock = (r, i) => {
    const files = Array.isArray(r.files) ? r.files : [];
    const skipped = Array.isArray(r.skipped) ? r.skipped : [];
    const k = destOf(r);
    const tag = tagged && k ? ` · ${k === 'unsorted' ? 'Unsorted' : `case ${k.slice(5)}`}` : '';
    const rows = fileRows(files, skipped);
    const ex = digestExcerpt(r);
    return `<div style="${i ? 'border-top:1px solid #eef0f4;' : ''}padding:12px 0;">` +
      `<div style="${F}font-size:12px;color:#8a92a3;">${esc(`${whenOf(r)}${tag}`)}</div>` +
      `<div style="${F}font-size:15px;font-weight:600;color:#1d2433;margin-top:2px;">${r.subject ? esc(r.subject) : '<span style="color:#8a92a3;font-style:italic;font-weight:400;">(no subject)</span>'}</div>` +
      (rows.length
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">${rows.join(sep)}</table>`
        : `<div style="${F}font-size:13px;color:#8a92a3;font-style:italic;margin-top:4px;">No attachments</div>`) +
      (ex.body
        ? `<div style="${F}font-size:13px;line-height:1.5;color:#1d2433;background:#f8f9fb;border:1px solid #eef0f4;border-radius:8px;padding:8px 12px;margin-top:6px;">${esc(ex.body).replace(/\n/g, '<br>')}` +
          (ex.trimmed || ex.cut ? `<div style="font-size:12px;color:#8a92a3;margin-top:6px;">${esc(ex.cut ? `— shortened (${ex.cut} more characters) —` : '— earlier messages in the thread trimmed —')}</div>` : '') +
          '</div>'
        : '') +
      '</div>';
  };

  const html = frame(title, headline,
    boxes.join('') +
    `<tr><td style="padding:16px 24px 4px;">${label('From')}` +
      `<div style="${F}font-size:16px;font-weight:600;color:#1d2433;">${esc(who)}</div>` +
      (from.email && who !== from.email ? `<div style="${F}font-size:13px;color:#475467;margin-top:2px;">${esc(from.email)}</div>` : '') +
      (span ? `<div style="${F}font-size:12px;color:#8a92a3;margin-top:4px;">${esc(span)}</div>` : '') +
    '</td></tr>' +
    `<tr><td style="padding:18px 24px 22px;">${label(`Emails (${rs.length})`)}${rs.map(emailBlock).join('')}</td></tr>`);

  t.push('');
  t.push(`From: ${who}${from.email && who !== from.email ? ` <${from.email}>` : ''}`);
  if (span) t.push(`Received: ${span}`);
  rs.forEach((r, i) => {
    const files = Array.isArray(r.files) ? r.files : [];
    const skipped = Array.isArray(r.skipped) ? r.skipped : [];
    const k = destOf(r);
    const ex = digestExcerpt(r);
    t.push('');
    t.push(`${i + 1}. ${whenOf(r)}${tagged && k ? ` · ${k === 'unsorted' ? 'Unsorted' : `case ${k.slice(5)}`}` : ''}`);
    t.push(`   Subject: ${r.subject || '(no subject)'}`);
    const lines = fileLines(files, skipped);
    t.push(...(lines.length ? lines : ['  (no attachments)']));
    if (ex.body) t.push(...ex.body.split('\n').map(l => `   > ${l}`));
  });

  return { subject, html, text: t.join('\n') };
}

function caseLinkOf(appUrl, caseId) {
  return require('../lib/shellLinks').caseLink(appUrl, caseId);   // lazy (convention)
}

module.exports = { render, renderDigest, messageExcerpt, fmtBytes, MAX_BODY, DIGEST_BODY_MAX };
