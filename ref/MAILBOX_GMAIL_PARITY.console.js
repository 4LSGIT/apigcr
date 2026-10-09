// S1-G text-parity check — ref/MAILBOX_GMAIL_PARITY.md (gate G4, window W4).
// Paste into the console of a logged-in SU app.4lsg.com tab. READ-ONLY:
// SELECTs through the SU DB console, GET …/emit-preview, POST
// /api/email-ingest/rules/test-transform (zero side effects).
//
// For each INBOX message of the Gmail mailbox that the Apps Script adapter
// also logged AND that matched at least one rule in production, it runs every
// matched rule's PRODUCTION transform twice — on the Apps Script envelope as
// logged, and on the same envelope with text/html swapped for what the worker
// emits (GET …/emit-preview = the worker's own emitText) — and compares the
// outputs. Passthrough rules (12/13/14/18) hand the whole envelope to their
// actions, so for those the text itself is compared.
//
// Differences are classified per output FIELD: 'format' when the two values
// agree once '*' bold markers are dropped and whitespace is collapsed (Gmail's
// plain text hard-wraps at ~76 columns and renders <b> as *bold*), 'VALUE'
// otherwise. Verdict: STOP on any court-mail VALUE difference (or a
// passthrough rule whose normalized text differs); REVIEW when only format
// differences remain (accept or reject by ruling); PASS when identical.
await (async function textParity({ address = 'stuart@4lsg.com', limit = 60, sinceUtc = null } = {}) {
  const sql = async (query) => (await apiSend('/admin/db/query', 'POST', { query })).rows;
  const lit = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  const asObj = (v) => {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (_) { return null; }
  };
  const canon = (v) => {
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  };
  const norm = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // A JSON string literal that starts at `"key":"` inside a cut-off JSON text
  // (raw_input over 16 KB is stored as {preview: "<truncated JSON>"}).
  const readJsonString = (s, key) => {
    const k = `"${key}":"`;
    const i = s.indexOf(k);
    if (i < 0) return null;
    let lit2 = '"';
    for (let j = i + k.length; j < s.length; j++) {
      const c = s[j];
      lit2 += c;
      if (c === '\\') { if (j + 1 < s.length) lit2 += s[++j]; continue; }
      if (c === '"') { try { return JSON.parse(lit2); } catch (_) { return null; } }
    }
    return null; // the cut fell inside this field
  };
  const envelopeOf = (raw) => {
    const v = asObj(raw);
    if (!v) return null;
    if (v._truncated) {
      const p = String(v.preview || '');
      return { _from_preview: true, text: readJsonString(p, 'text'), html: readJsonString(p, 'html') };
    }
    return v;
  };
  const fmt = (v) => (typeof v === 'string' ? v.replace(/\*/g, '').replace(/\s+/g, ' ').trim() : v);
  const fieldDiffs = (a, b) => {
    const x = (a && a.output) || {}; const y = (b && b.output) || {};
    if (!a || !b || a.ok !== b.ok) return [{ field: '(transform)', cls: 'VALUE', gas: canon(a).slice(0, 200), worker: canon(b).slice(0, 200) }];
    const out = [];
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (canon(x[k]) === canon(y[k])) continue;
      out.push({ field: k, cls: canon(fmt(x[k])) === canon(fmt(y[k])) ? 'format' : 'VALUE',
        gas: canon(x[k]).slice(0, 200), worker: canon(y[k]).slice(0, 200) });
    }
    return out;
  };
  const firstDiff = (a, b) => {
    const x = norm(a); const y = norm(b);
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    return { at: i, gas: JSON.stringify(x.slice(Math.max(0, i - 40), i + 60)), worker: JSON.stringify(y.slice(Math.max(0, i - 40), i + 60)) };
  };

  const [mb] = await sql(`SELECT id FROM mailboxes WHERE address = ${lit(address)}`);
  if (!mb) throw new Error(`no mailbox ${address}`);
  const rules = (await apiSend('/api/email-ingest/rules', 'GET')).rules || [];
  const ruleById = new Map(rules.map(r => [Number(r.id), r]));

  const rows = await sql(`
    SELECT m.id AS mid, LEFT(m.subject, 70) AS subject, l.id AS el_id,
           l.from_email, l.to_email, l.subject AS el_subject,
           (SELECT e.metadata FROM email_ingest_executions e
             WHERE e.email_log_id = l.id AND e.status <> 'duplicate' ORDER BY e.id LIMIT 1) AS meta,
           (SELECT e.raw_input FROM email_ingest_executions e
             WHERE e.email_log_id = l.id AND e.remote_ip IS NOT NULL
             ORDER BY (e.status = 'duplicate'), e.id LIMIT 1) AS gas_raw
      FROM mail_messages m
      JOIN email_log l ON l.source = 'gmail-firm' AND l.message_id = m.provider_id
     WHERE m.mailbox_id = ${Number(mb.id)} AND m.folder = 'INBOX'
       ${sinceUtc ? `AND m.ingested_at >= ${lit(sinceUtc)}` : ''}
     ORDER BY m.id DESC LIMIT ${Number(limit)}`);

  const report = [];
  const diffs = [];
  let compared = 0; let textSame = 0; let textChecked = 0; let skipped = 0;
  for (const r of rows) {
    const matched = ((asObj(r.meta) || {}).matched_rules || []).map(Number);
    const gas = envelopeOf(r.gas_raw);
    if (!gas || gas.text == null) { skipped++; continue; } // no Apps Script copy, or its text was cut off
    const pv = (await apiSend(`/api/mailboxes/${mb.id}/messages/${r.mid}/emit-preview`, 'GET')).preview;
    const same = norm(gas.text) === norm(pv.text);
    textChecked++; if (same) textSame++;
    const court = /uscourts\.gov$/i.test(String(r.from_email || ''));
    const base = gas._from_preview
      ? { kind: 'email', source: 'gmail-firm', from: { email: r.from_email, name: '' }, to: [{ email: r.to_email, name: '' }],
          subject: r.el_subject, text: gas.text, html: gas.html || '' }
      : gas;
    const yc = { ...base, text: pv.text, html: pv.html != null ? pv.html : base.html };
    const ruleResults = [];
    for (const rid of matched) {
      const rule = ruleById.get(rid);
      if (!rule) continue;
      if (!rule.transform_mode || rule.transform_mode === 'passthrough') {
        const cls = same ? 'same' : (fmt(gas.text) === fmt(pv.text) ? 'format' : 'VALUE');
        ruleResults.push(`${rid}:pass-thru ${cls}`);
        if (!same) diffs.push({ mid: r.mid, rule: rid, court, kind: cls, field: '(passthrough text)', ...firstDiff(gas.text, pv.text) });
        continue;
      }
      const body = (input) => ({ transform_mode: rule.transform_mode, transform_config: asObj(rule.transform_config) ?? rule.transform_config, input });
      const a = await apiSend('/api/email-ingest/rules/test-transform', 'POST', body(base));
      const b = await apiSend('/api/email-ingest/rules/test-transform', 'POST', body(yc));
      compared++;
      const fd = fieldDiffs(a.transform, b.transform);
      const worst = fd.some(d => d.cls === 'VALUE') ? 'VALUE' : (fd.length ? 'format' : 'same');
      ruleResults.push(`${rid}:${worst}`);
      for (const d of fd) diffs.push({ mid: r.mid, rule: rid, court, kind: d.cls, field: d.field, gas: d.gas, worker: d.worker });
    }
    report.push({ mid: r.mid, court, subject: r.subject, text: same ? 'same' : 'DIFFERS', rules: ruleResults.join(' ') || '(none matched)' });
  }
  console.table(report);
  const byField = {};
  for (const d of diffs) {
    const k = `${d.rule}.${d.field}${d.court ? '' : ' (non-court)'}`;
    const e = byField[k] || (byField[k] = { format: 0, VALUE: 0, example_gas: d.gas, example_worker: d.worker });
    e[d.kind] = (e[d.kind] || 0) + 1;
    if (d.kind === 'VALUE' && e.VALUE === 1) { e.example_gas = d.gas; e.example_worker = d.worker; }
  }
  if (diffs.length) console.table(byField);
  const courtValue = diffs.filter(d => d.court && d.kind === 'VALUE');
  const verdict = courtValue.length
    ? `STOP — ${courtValue.length} court-mail VALUE difference(s): rule it (or fix htmlToText) before emitting / continuing the window`
    : (diffs.length ? `REVIEW — ${diffs.length} format-only or non-court difference(s); no court VALUE difference` : 'PASS');
  console.log(`[text-parity] ${verdict}. messages=${rows.length} checked=${textChecked} (text same ${textSame}) ` +
    `rule-outputs compared=${compared} skipped(no GAS text)=${skipped}`);
  return { verdict, report, diffs, byField };
})();
