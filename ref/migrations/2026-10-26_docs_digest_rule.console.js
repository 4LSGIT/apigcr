// ref/migrations/2026-10-26_docs_digest_rule.console.js
// Runbook: ref/MAILBOX_GMAIL_PARITY.md §5 (docs@ relay). The transform is the CODE string.
//
// docs@ digest rule — paste into a logged-in SU tab's console (apiSend).
// Creates the rule INACTIVE, adds its send_email action, proves both on real
// executions (test-match + test-transform), THEN activates. Re-runnable: it
// refuses if a rule with this name already exists.
// Shadow run: TO = it@4lsg.com. At step 6, repoint with the second snippet.
(async () => {
const NAME = 'docs@ digest (replaces Pabbly)';
const TO = 'it@4lsg.com';
const FROM = 'automations@4lsg.com';
const POS_EXEC = 28130;  // a real docs@ message (worker, full fidelity) — must match
const NEG_EXEC = 28354;  // YC's own task-summary email to stuart@ — must NOT match
const MATCH = {
  "operator": "and",
  "conditions": [
    {
      "operator": "or",
      "conditions": [
        {
          "op": "equals",
          "path": "envelope.recipient",
          "value": "docs@4lsg.com"
        },
        {
          "op": "equals",
          "path": "to.0.email",
          "value": "docs@4lsg.com"
        }
      ]
    },
    {
      "op": "not_contains",
      "path": "from.email",
      "value": "@4lsg.com"
    },
    {
      "op": "not_contains",
      "path": "from.email",
      "value": "@metrodetroitbankruptcylaw.com"
    }
  ]
};
const CODE = "// docs@ digest — email ingest rule, transform_mode 'code'.\n// Runs as new Function('input', code)(envelope): synchronous, no require.\n// Output feeds send_email through the action's params_mapping\n// (subject / html / text). Every string from the message is escaped.\nconst MAX_BODY = 4000;\nconst esc = (s) => String(s == null ? '' : s).replace(/[&<>\"']/g, (c) => (\n  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\nconst from = input.from || {};\nconst email = String(from.email || '').trim();\nconst name = String(from.name || '').trim();\nconst who = (name && name.toLowerCase() !== email.toLowerCase()) ? name : (email || 'Unknown sender');\nconst subject = String(input.subject || '').trim();\n\n// ── when ──\nlet when = String(input.date || '');\nconst d = new Date(input.date || input.received_at || '');\nif (!isNaN(d.getTime())) {\n  when = d.toLocaleString('en-US', {\n    timeZone: 'America/Detroit', weekday: 'short', month: 'short', day: 'numeric',\n    year: 'numeric', hour: 'numeric', minute: '2-digit',\n  }) + ' ET';\n}\n\n// ── files ── (Gmail gives every attachment a Content-ID, PDFs included, so\n// nothing is hidden on that basis.) The IMAP worker reports the ENCODED part\n// size (base64, ~4/3 of the file); the Apps Script reports bytes.\nconst worker = !!input.mailbox;\nconst fmtSize = (n) => {\n  let b = Number(n);\n  if (!isFinite(b) || b <= 0) return '';\n  if (worker) b = b * 0.74;\n  if (b < 1024) return Math.round(b) + ' B';\n  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';\n  return (b / (1024 * 1024)).toFixed(1) + ' MB';\n};\nconst TYPES = {\n  pdf: ['PDF', '#b42318', '#fdecea'],\n  jpg: ['JPG', '#1d7a46', '#e7f5ec'], jpeg: ['JPG', '#1d7a46', '#e7f5ec'], png: ['PNG', '#1d7a46', '#e7f5ec'],\n  heic: ['HEIC', '#1d7a46', '#e7f5ec'], gif: ['GIF', '#1d7a46', '#e7f5ec'], tif: ['TIFF', '#1d7a46', '#e7f5ec'],\n  tiff: ['TIFF', '#1d7a46', '#e7f5ec'], webp: ['WEBP', '#1d7a46', '#e7f5ec'],\n  doc: ['DOC', '#1849a9', '#e8eefb'], docx: ['DOCX', '#1849a9', '#e8eefb'], rtf: ['RTF', '#1849a9', '#e8eefb'],\n  txt: ['TXT', '#1849a9', '#e8eefb'], xls: ['XLS', '#0e6245', '#e5f4ee'], xlsx: ['XLSX', '#0e6245', '#e5f4ee'],\n  csv: ['CSV', '#0e6245', '#e5f4ee'], zip: ['ZIP', '#6b4e16', '#f6efe1'],\n};\nconst typeOf = (a) => {\n  const fn = String(a.filename || '');\n  const ext = (fn.match(/\\.([A-Za-z0-9]{1,5})$/) || [])[1];\n  const key = String(ext || '').toLowerCase();\n  if (TYPES[key]) return TYPES[key];\n  const sub = String(a.mime || '').toLowerCase().split('/')[1] || '';\n  if (TYPES[sub]) return TYPES[sub];\n  if (/^image\\//i.test(a.mime || '')) return ['IMG', '#1d7a46', '#e7f5ec'];\n  return ['FILE', '#475467', '#eef0f3'];\n};\nconst files = (Array.isArray(input.attachments) ? input.attachments : []).filter(a => a && a.filename);\nconst nFiles = files.length;\n\n// ── message ── quoted history trimmed, length capped\nlet body = String(input.text || '').replace(/\\r\\n?/g, '\\n').replace(/[ \\t]+$/gm, '');\nlet trimmed = false;\nconst quoteAt = [\n  /^\\s*On .{4,200}\\bwrote:\\s*$/m,\n  /^-{2,}\\s*Original Message\\s*-{2,}/im,\n  /^From: .+\\n(?:Sent|Date): /m,\n  /^_{10,}\\s*$/m,\n].map(re => { const m = re.exec(body); return m ? m.index : -1; }).filter(i => i > 0);\nif (quoteAt.length) { body = body.slice(0, Math.min.apply(null, quoteAt)); trimmed = true; }\nbody = body.replace(/\\n{3,}/g, '\\n\\n').trim();\nlet cut = 0;\nif (body.length > MAX_BODY) { cut = body.length - MAX_BODY; body = body.slice(0, MAX_BODY).replace(/\\s+\\S*$/, ''); }\n\n// ── a case id the client typed (\"- Case PVXC1RMM\"): 8-char Crockford\n// base32, uppercase. The ?files= link fails safe on an id that isn't one.\nconst caseM = (subject + '\\n' + body).match(/\\bcase[\\s:#-]+([0-9A-HJKMNP-TV-Z]{8})\\b/i);\nconst caseId = caseM && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(caseM[1]) ? caseM[1] : null;\nconst caseUrl = caseId ? 'https://app.4lsg.com/?files=c' + caseId + '&open=file:0' : null;\n\n// ── subject line ── keeps the old digest's wording (filters on it still match)\nconst oneLine = (v) => String(v).replace(/\\s+/g, ' ').trim().slice(0, 120);\nconst outSubject = 'New email to Docs@4LSG.com — ' + oneLine(who) +\n  (nFiles ? ' (' + nFiles + (nFiles === 1 ? ' file)' : ' files)') : ' (no files)');\n\n// ── HTML (tables + inline styles: Outlook / webmail safe) ──\nconst F = \"font-family:'Segoe UI',Helvetica,Arial,sans-serif;\";\nconst reply = 'mailto:' + email + '?subject=' + encodeURIComponent('Re: ' + subject);\nconst fileRows = files.map(a => {\n  const t = typeOf(a);\n  return '<tr>' +\n    '<td width=\"52\" style=\"padding:7px 0;vertical-align:middle;\">' +\n      '<span style=\"display:inline-block;min-width:38px;text-align:center;' + F + 'font-size:10px;font-weight:700;' +\n      'letter-spacing:.04em;color:' + t[1] + ';background:' + t[2] + ';border-radius:4px;padding:3px 5px;\">' + t[0] + '</span></td>' +\n    '<td style=\"padding:7px 8px 7px 0;' + F + 'font-size:14px;color:#1d2433;word-break:break-all;\">' + esc(a.filename) + '</td>' +\n    '<td align=\"right\" style=\"padding:7px 0;' + F + 'font-size:12px;color:#6b7385;white-space:nowrap;\">' + esc(fmtSize(a.size)) + '</td>' +\n    '</tr>';\n}).join('<tr><td colspan=\"3\" style=\"border-top:1px solid #eef0f4;font-size:0;line-height:0;\">&nbsp;</td></tr>');\nconst bodyHtml = body\n  ? esc(body).replace(/\\n/g, '<br>')\n  : '<span style=\"color:#8a92a3;font-style:italic;\">' + (nFiles ? 'No message — attachments only.' : '(empty message)') + '</span>';\nconst label = (t) => '<div style=\"' + F + 'font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7385;margin:0 0 8px;\">' + t + '</div>';\n\nconst html =\n'<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>' +\n'<body style=\"margin:0;padding:0;background:#f2f4f7;\">' +\n'<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"background:#f2f4f7;\"><tr><td align=\"center\" style=\"padding:24px 12px;\">' +\n'<table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"width:100%;max-width:600px;background:#ffffff;border:1px solid #dde2ea;border-radius:10px;\">' +\n// header\n'<tr><td style=\"background:#1f3a5f;border-radius:10px 10px 0 0;padding:18px 24px;\">' +\n  '<div style=\"' + F + 'font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#b9c7dc;\">docs@4lsg.com</div>' +\n  '<div style=\"' + F + 'font-size:20px;font-weight:600;color:#ffffff;margin-top:4px;\">' +\n    (nFiles ? nFiles + (nFiles === 1 ? ' new document' : ' new documents') : 'New email (no attachments)') + '</div>' +\n'</td></tr>' +\n// sender\n'<tr><td style=\"padding:20px 24px 4px;\">' +\n  label('From') +\n  '<div style=\"' + F + 'font-size:16px;font-weight:600;color:#1d2433;\">' + esc(who) + '</div>' +\n  (email && who !== email ? '<div style=\"' + F + 'font-size:13px;color:#475467;margin-top:2px;\">' + esc(email) + '</div>' : '') +\n  '<div style=\"' + F + 'font-size:12px;color:#8a92a3;margin-top:4px;\">' + esc(when) + '</div>' +\n'</td></tr>' +\n// subject\n'<tr><td style=\"padding:16px 24px 4px;\">' + label('Subject') +\n  '<div style=\"' + F + 'font-size:15px;color:#1d2433;\">' + (subject ? esc(subject) : '<span style=\"color:#8a92a3;font-style:italic;\">(no subject)</span>') + '</div>' +\n'</td></tr>' +\n// case\n(caseUrl ? '<tr><td style=\"padding:14px 24px 0;\">' +\n  '<a href=\"' + esc(caseUrl) + '\" style=\"display:inline-block;' + F + 'font-size:13px;font-weight:600;color:#1f3a5f;background:#e8eefb;border:1px solid #c9d6ef;border-radius:6px;padding:7px 12px;text-decoration:none;\">Open case ' + esc(caseId) + ' in YisraCase &rarr;</a>' +\n  '<div style=\"' + F + 'font-size:11px;color:#8a92a3;margin-top:4px;\">The client typed this case number; check it matches.</div>' +\n'</td></tr>' : '') +\n// files\n'<tr><td style=\"padding:18px 24px 4px;\">' + label('Attachments (' + nFiles + ')') +\n  (nFiles\n    ? '<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\">' + fileRows + '</table>'\n    : '<div style=\"' + F + 'font-size:14px;color:#8a92a3;font-style:italic;\">None</div>') +\n'</td></tr>' +\n// message\n'<tr><td style=\"padding:18px 24px 22px;\">' + label('Message') +\n  '<div style=\"' + F + 'font-size:14px;line-height:1.5;color:#1d2433;background:#f8f9fb;border:1px solid #eef0f4;border-radius:8px;padding:12px 14px;\">' + bodyHtml +\n    (trimmed ? '<div style=\"font-size:12px;color:#8a92a3;margin-top:10px;\">— earlier messages in the thread trimmed —</div>' : '') +\n    (cut ? '<div style=\"font-size:12px;color:#8a92a3;margin-top:10px;\">— message shortened (' + cut + ' more characters) —</div>' : '') +\n  '</div>' +\n'</td></tr>' +\n// actions + footer\n(email ? '<tr><td style=\"padding:0 24px 22px;\"><a href=\"' + esc(reply) + '\" style=\"display:inline-block;' + F + 'font-size:13px;font-weight:600;color:#ffffff;background:#1f3a5f;border-radius:6px;padding:9px 14px;text-decoration:none;\">Reply to ' + esc(name || email) + '</a></td></tr>' : '') +\n'<tr><td style=\"background:#f8f9fb;border-top:1px solid #eef0f4;border-radius:0 0 10px 10px;padding:12px 24px;\">' +\n  '<div style=\"' + F + 'font-size:11px;line-height:1.5;color:#8a92a3;\">The original message and its files are in the stuart@4lsg.com mailbox (YisraCase &rarr; Comms). Sent automatically by YisraCase for mail to docs@4lsg.com.</div>' +\n'</td></tr>' +\n'</table></td></tr></table></body></html>';\n\n// ── plain-text alternative ──\nconst text = [\n  (nFiles ? nFiles + (nFiles === 1 ? ' new document' : ' new documents') : 'New email (no attachments)') + ' at docs@4lsg.com',\n  '',\n  'From: ' + who + (email && who !== email ? ' <' + email + '>' : ''),\n  'Received: ' + when,\n  'Subject: ' + (subject || '(no subject)'),\n  caseUrl ? 'Case (as typed by the client): ' + caseId + ' — ' + caseUrl : null,\n  '',\n  'Attachments (' + nFiles + '):',\n  nFiles ? files.map(a => '  - ' + a.filename + (fmtSize(a.size) ? ' (' + fmtSize(a.size) + ')' : '')).join('\\n') : '  none',\n  '',\n  'Message:',\n  body || (nFiles ? '(no message — attachments only)' : '(empty message)'),\n  trimmed ? '\\n— earlier messages in the thread trimmed —' : null,\n  cut ? '— message shortened (' + cut + ' more characters) —' : null,\n  '',\n  '— The original message and its files are in the stuart@4lsg.com mailbox (YisraCase → Comms).',\n].filter(x => x !== null).join('\\n');\n\nreturn { subject: outSubject, html, text, sender_email: email, files: nFiles, case_id: caseId };\n";
const MAPPING = { from: "'" + FROM + "'", to: "'" + TO + "'", subject: 'subject', html: 'html', text: 'text' };
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const fail = (m, extra) => { console.error('NO-GO —', m, extra ?? ''); throw new Error(m); };

// 0. base: no rule with this name yet
const { rules } = await apiSend('/api/email-ingest/rules', 'GET');
const dup = rules.filter(r => r.name === NAME);
if (dup.length) fail('a rule named ' + JSON.stringify(NAME) + ' already exists: id ' + dup.map(r => r.id).join(', '));

// 1. prove match + transform on real executions BEFORE writing anything
const tm = async (exec_id) => (await apiSend('/api/email-ingest/rules/test-match', 'POST',
  { match_mode: 'conditions', match_config: MATCH, exec_id, include_misses: true })).rows[0];
const pos = await tm(POS_EXEC), neg = await tm(NEG_EXEC);
if (!pos || pos.matched !== true) fail('positive execution did not match', pos);
if (!neg || neg.matched !== false) fail('negative execution matched', neg);
const tt = await apiSend('/api/email-ingest/rules/test-transform', 'POST', {
  transform_mode: 'code', transform_config: { code: CODE }, exec_id: POS_EXEC,
  params_mappings: [{ label: 'send_email', mapping: MAPPING }] });
if (!tt.transform || !tt.transform.ok) fail('transform failed', tt.transform);
const p = tt.resolved_params[0].params;
if (p.from !== FROM || p.to !== TO || !/^New email to Docs@4LSG\.com — /.test(p.subject) || !/<table/.test(p.html) || !p.text) fail('resolved params wrong', p);
console.log('preview subject:', p.subject, '| html', p.html.length, 'B | source', tt.source);

// 2. create INACTIVE, verify round-trip (key-order-insensitive: MySQL JSON reorders keys)
const { rule } = await apiSend('/api/email-ingest/rules', 'POST', {
  name: NAME, active: 0, position: 0,
  description: 'Replaces the Apps Script -> Pabbly docs@ digest (2026-10-26). Non-firm mail to docs@4lsg.com -> one formatted email per message.',
  match_mode: 'conditions', match_config: MATCH, transform_mode: 'code', transform_config: { code: CODE } });
const got = (await apiSend('/api/email-ingest/rules/' + rule.id, 'GET')).rule;
if (Number(got.active) !== 0 || canon(J(got.match_config)) !== canon(MATCH) || J(got.transform_config).code !== CODE || got.actions.length) fail('created rule differs', got);

// 3. the action
const { action } = await apiSend('/api/email-ingest/rules/' + rule.id + '/actions', 'POST', {
  action_type: 'internal_function', position: 0, active: 1, name: 'send digest',
  config: { function_name: 'send_email', params_mapping: MAPPING } });
const got2 = (await apiSend('/api/email-ingest/rules/' + rule.id, 'GET')).rule;
if (got2.actions.length !== 1 || got2.actions[0].id !== action.id || canon(J(got2.actions[0].config)) !== canon({ function_name: 'send_email', params_mapping: MAPPING })) fail('action differs', got2.actions);

// 4. arm it
await apiSend('/api/email-ingest/rules/' + rule.id, 'PUT', { active: 1 });
const fin = (await apiSend('/api/email-ingest/rules/' + rule.id, 'GET')).rule;
if (Number(fin.active) !== 1) fail('not active after PUT', fin.active);
console.log('GO — rule ' + rule.id + ' (action ' + action.id + ') is ACTIVE, sending to ' + TO + '. Next: watch the next docs@ email arrive at ' + TO + ' alongside Pabbly\'s.');
})();
