// ref/migrations/2026-10-26_docs_digest_repoint.console.js
// Runbook: ref/MAILBOX_GMAIL_PARITY.md step 6, item 1.
//
// docs@ digest — repoint from the shadow address to the real recipient(s).
// Run at step 6, right before the Apps Script trigger comes off.
// Asserts the shadow config it expects, writes, re-reads.
(async () => {
const NAME = 'docs@ digest (replaces Pabbly)';
const FROM_TO = 'it@4lsg.com';
const NEW_TO = 'shoshana@metrodetroitbankruptcylaw.com'; // comma-separate to add more
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
  ? Object.keys(x).sort().reduce((o, key) => (o[key] = x[key], o), {}) : x);
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const fail = (m, extra) => { console.error('NO-GO —', m, extra ?? ''); throw new Error(m); };
const { rules } = await apiSend('/api/email-ingest/rules', 'GET');
const hits = rules.filter(r => r.name === NAME);
if (hits.length !== 1) fail('expected exactly one rule named ' + JSON.stringify(NAME) + ', found ' + hits.length);
const rule = (await apiSend('/api/email-ingest/rules/' + hits[0].id, 'GET')).rule;
if (rule.actions.length !== 1) fail('expected one action', rule.actions);
const a = rule.actions[0], cfg = J(a.config);
const want = { function_name: 'send_email', params_mapping: { from: "'automations@4lsg.com'", to: "'" + FROM_TO + "'", subject: 'subject', html: 'html', text: 'text' } };
if (canon(cfg) !== canon(want)) fail('action is not the shadow config', cfg);
const next = { ...cfg, params_mapping: { ...cfg.params_mapping, to: "'" + NEW_TO + "'" } };
await apiSend('/api/email-ingest/rule-actions/' + a.id, 'PUT', { config: next });
const after = J((await apiSend('/api/email-ingest/rules/' + rule.id, 'GET')).rule.actions[0].config);
if (canon(after) !== canon(next)) fail('write did not land', after);
console.log('GO — rule ' + rule.id + ' now sends to ' + NEW_TO + '. Next: Apps Script trigger off, then disable the Pabbly docs@ workflow.');
})();
