// lib/internal_functions/emailAttachments.js
//
// Email attachments as automation material — ref/EMAIL_ATTACHMENTS_DESIGN.md.
//
//   email_case_match          which case an email belongs to (read-only)
//   email_attachments_file    file a stored email's attachments to Dropbox
//                             (case Client Uploads, or the unsorted bin) and
//                             build the staff notice
//   email_attachments_refile  move a message's filed attachments into a case
//                             (the answer to a request_decision)
//
// All three address a message in the YC mailbox store (mail_messages), so they
// work for any IMAP mailbox — Gmail now, Migadu later. An ingest rule hands
// the reference over from its envelope: the worker's envelope carries
// mailbox.message_row_id (= mail_message_id); any envelope can resolve through
// source + headers.message_id.
//
// Once filed, the files are ordinary Dropbox documents: parse_pdf (dropbox_path),
// query_ai file inputs and send_email attachment_urls read them from there.
//
// CTA (services/ctaService.js): email_case_match is DENIED — a public link has
// no use for a read, and this one returns a client's cases. The other two stay
// eligible: an SU-minted "file these to case X" link is exactly what refile is
// for, and every plan is frozen at mint.

'use strict';

const fns = {};

const REF_PARAMS = [
  { name: 'mail_message_id', type: 'integer', required: false, placeholderAllowed: true,
    description: 'mail_messages.id — from an email rule: {{mailbox.message_row_id}} (worker-ingested mail). One of the three reference forms.',
    example: '{{mail_message_id}}' },
  { name: 'source', type: 'string', required: false, placeholderAllowed: true,
    description: 'With message_id: the ingest identity (envelope source + headers.message_id). Resolves mail from any feeder that the mailbox store also holds.',
    example: '{{source}}' },
  { name: 'message_id', type: 'string', required: false, placeholderAllowed: true,
    description: 'With source: the ingest dedupe key (Gmail id for gmail-firm, RFC Message-ID for mailbox-imap).',
    example: '{{headers.message_id}}' },
  { name: 'mailbox_id', type: 'integer', required: false, placeholderAllowed: true,
    description: 'With folder + uid: the envelope\'s mailbox block.', example: '{{mailbox.id}}' },
  { name: 'folder', type: 'string', required: false, placeholderAllowed: true,
    description: 'With mailbox_id + uid.', example: '{{mailbox.folder}}' },
  { name: 'uid', type: 'integer', required: false, placeholderAllowed: true,
    description: 'With mailbox_id + folder.', example: '{{mailbox.uid}}' },
];

/** The reference the params name, empty strings (unresolved placeholders) dropped. */
function refOf(p) {
  const v = (k) => (p[k] == null || p[k] === '' ? undefined : p[k]);
  return {
    mail_message_id: v('mail_message_id'),
    source: v('source'),
    message_id: v('message_id'),
    mailbox_id: v('mailbox_id'),
    folder: v('folder'),
    uid: v('uid'),
  };
}

function withVar(output, outputVar) {
  const set_vars = {};
  if (outputVar) set_vars[outputVar] = output;
  return { success: true, output, set_vars };
}

// ─────────────────────────────────────────────────────────────────────────────

fns.email_case_match = async (params = {}, db) => {
  const attachments = require('../../services/mailbox/mailAttachmentService');   // lazy require (convention)
  const caseMatch = require('../../services/emailCaseMatchService');            // lazy require (convention)
  const { senderOf } = require('../../services/mailbox/mailReadService');       // lazy require (convention)
  const { emitText } = require('../../services/mailbox/mailboxIngestService');  // lazy require (convention)

  let from = params.from_email == null ? '' : String(params.from_email);
  let subject = params.subject == null ? '' : String(params.subject);
  let text = params.text == null ? '' : String(params.text);
  const ref = refOf(params);
  if (Object.values(ref).some(x => x !== undefined)) {
    let msg;
    try {
      msg = await attachments.resolveMessage(db, ref);
    } catch (err) {
      throw new Error(`email_case_match: ${err.message}`);
    }
    if (!msg) throw new Error('email_case_match: the message is not in the mailbox store');
    from = from || senderOf(msg.from_addr) || '';
    subject = subject || msg.subject || '';
    text = text || emitText(msg.body_text, msg.body_html).text;
  }
  if (!from && !subject && !text) {
    throw new Error('email_case_match: give a message reference, or from_email / subject / text');
  }
  const output = await caseMatch.matchCase(db, { fromEmail: from, subject, text });
  return withVar(output, params.output_var);
};
fns.email_case_match.__meta = {
  category: 'email',
  description: 'Which case does an email belong to? A case id or case number (docket) named in the subject (or after "case" in the message), else the sender\'s one open case (Open/Pending/Filed; with several, the one retained case). Read-only. Output: case_id (null = undecided), method, flag (conflict / multiple_case_ids / multiple_open_cases / no_open_case / unknown_sender), reason, contact, candidates.',
  params: [
    ...REF_PARAMS,
    { name: 'from_email', type: 'string', required: false, placeholderAllowed: true,
      description: 'Sender address, when not giving a message reference (or to override it).', example: '{{from.email}}' },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true, example: '{{subject}}' },
    { name: 'text', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'Message text; quoted history is ignored.', example: '{{text}}' },
    { name: 'output_var', type: 'string', required: false, placeholderAllowed: true,
      description: 'Also copy the output into this workflow variable.', example: 'match' },
  ],
  example: { mail_message_id: '{{mail_message_id}}', output_var: 'match' },
};

// ─────────────────────────────────────────────────────────────────────────────

fns.email_attachments_file = async (params = {}, db) => {
  const svc = require('../../services/emailAttachmentFilingService');   // lazy require (convention)
  let output;
  try {
    output = await svc.fileMessageAttachments(db, {
      ref: refOf(params),
      target: params.target,
      caseId: params.case_id || undefined,
      contactId: params.contact_id || undefined,
      subfolder: params.subfolder || undefined,
      unsortedSubfolder: params.unsorted_subfolder || undefined,
      filedBy: params.filed_by,
      noticeSubjectPrefix: params.notice_subject_prefix,
      noticeTitle: params.notice_title,
    });
  } catch (err) {
    throw new Error(`email_attachments_file: ${err.message}`);
  }
  return withVar(output, params.output_var);
};
fns.email_attachments_file.__meta = {
  category: 'email',
  workflowOnly: true,   // fetches every attachment over IMAP and uploads to Dropbox — not a sequence step
  description: 'File a stored email\'s attachments to Dropbox, once per attachment (re-runs file only what is missing). target auto: the email_case_match case → <case folder>/Client Uploads/Emailed YYMMDD; no case → the unsorted client-uploads folder, in "Emailed YYMMDD - <sender>". Every file is registered in Documents. Skips signature-size inline images, file types the client-upload page refuses, and files over 40 MB — all listed. Output: placement (case/unsorted/none), case_id, match, folder_path, folder_link, files[] (each filed one with a link opening it), skipped[], counts, docs_checklist (the case\'s Docs Needed list: link, items, open_count, open[] — null when none), needs_decision + decision_options (for request_decision), and a ready staff notice: notice_subject, notice_html, notice_text — plus notice_html_decision (the notice with [[options_html]] in it) for request_decision\'s email_html when needs_decision.',
  params: [
    ...REF_PARAMS,
    { name: 'target', type: 'enum', enum: ['auto', 'case', 'contact', 'unsorted'], required: false, default: 'auto',
      description: 'auto = choose the case (email_case_match); case / contact / unsorted = file there.' },
    { name: 'case_id', type: 'string', required: false, placeholderAllowed: true, description: 'For target case.' },
    { name: 'contact_id', type: 'integer', required: false, placeholderAllowed: true, description: 'For target contact (the unsorted folder, registered to the contact).' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Folder under the case folder. Tokens {yymmdd} {yyyy-mm-dd} {sender}; "/" nests.',
      default: 'Client Uploads/Emailed {yymmdd}' },
    { name: 'unsorted_subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Folder in the unsorted client-uploads folder (one segment). Same tokens.',
      default: 'Emailed {yymmdd} - {sender}' },
    { name: 'notice_subject_prefix', type: 'string', required: false, placeholderAllowed: true,
      description: 'Start of notice_subject; default "Emailed files — ". Keep an older digest\'s wording here so mail filters keyed on it still match.',
      example: 'New email to Docs@4LSG.com — ' },
    { name: 'notice_title', type: 'string', required: false, placeholderAllowed: true,
      description: 'Small label at the top of the notice; default "Emailed documents".', example: 'docs@4lsg.com' },
    { name: 'filed_by', type: 'integer', required: false, placeholderAllowed: true,
      description: 'Acting user id for the registry; omit for automation.' },
    { name: 'output_var', type: 'string', required: false, placeholderAllowed: true,
      description: 'Copy the output into this workflow variable — later steps read {{filing.notice_html}}, {{filing.decision_options}}, {{filing.mail_message_id}}.',
      example: 'filing' },
  ],
  example: { mail_message_id: '{{mail_message_id}}', target: 'auto', output_var: 'filing' },
};

// ─────────────────────────────────────────────────────────────────────────────

fns.email_attachments_refile = async (params = {}, db) => {
  const svc = require('../../services/emailAttachmentFilingService');   // lazy require (convention)
  let output;
  try {
    output = await svc.refileMessageAttachments(db, {
      mailMessageId: params.mail_message_id,
      caseId: params.case_id,
      subfolder: params.subfolder || undefined,
      filedBy: params.filed_by,
    });
  } catch (err) {
    throw new Error(`email_attachments_refile: ${err.message}`);
  }
  return withVar(output, params.output_var);
};
fns.email_attachments_refile.__meta = {
  category: 'email',
  workflowOnly: true,
  description: 'Move every attachment email_attachments_file filed for a message into a case folder (<case folder>/Client Uploads/Emailed YYMMDD), following staff renames and moves (by Dropbox id), and link each to the case in Documents. Use after a request_decision on {{filing.decision_options}}. Output: moved[], already_there[], failed[], folder_path, folder_link.',
  params: [
    { name: 'mail_message_id', type: 'integer', required: true, placeholderAllowed: true,
      description: 'The message, as email_attachments_file reported it.', example: '{{filing.mail_message_id}}' },
    { name: 'case_id', type: 'string', required: true, placeholderAllowed: true,
      description: 'The case to move them into.', example: '{{chosen_case}}' },
    { name: 'subfolder', type: 'string', required: false, placeholderAllowed: true,
      description: 'Folder under the case folder; same tokens as email_attachments_file.',
      default: 'Client Uploads/Emailed {yymmdd}' },
    { name: 'filed_by', type: 'integer', required: false, placeholderAllowed: true },
    { name: 'output_var', type: 'string', required: false, placeholderAllowed: true, example: 'refiled' },
  ],
  example: { mail_message_id: '{{filing.mail_message_id}}', case_id: '{{chosen_case}}', output_var: 'refiled' },
};

module.exports = fns;
