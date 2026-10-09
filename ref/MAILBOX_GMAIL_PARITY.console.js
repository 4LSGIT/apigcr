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
// Every difference gets ONE class (runbook §2 G4 documents them):
//   format          equal ignoring whitespace, '*' and '_' — Gmail's ~75-col
//                   hard wrap, *bold* / _underline_ markers, ____ rules
//   gmail-render    equal once Gmail's own renderings are undone on the GAS
//                   side: literal "&nbsp" (no semicolon), ------ lines for
//                   <hr>, "[image: alt]"
//   gas-tail-cut    a whole-text field where GAS's text is a strict prefix of
//                   the worker's — Gmail dropped the tail (claims NEFs with an
//                   unclosed <b>: everything after "Amount Claimed")
//   gmail-css-leak  a whole-text field where GAS's text = the worker's + CSS
//                   rule(s) Gmail leaked from a <style> block
//   gmail-input-artifact  a code/mapper rule field that differs, where the
//                   SAME rule run on GAS's text with Gmail's renderings undone
//                   (hard wraps rejoined, '*' markers, literal &nbsp, ------
//                   lines, [image: alt]) gives the worker's value — Gmail's
//                   rendering broke the capture. Rule 8 filer: the wrap cut
//                   "Elizabeth Q.\nUwedjojevwe"; rule 16: "*Document Number:* 30"
//                   hides the number. The worker's value is the right one.
//   VALUE           anything else
// All but VALUE are the REVIEW-pass classes (worker equal or better). Verdict:
// STOP on any court-mail VALUE difference; REVIEW when only REVIEW-pass classes
// (or non-court differences) remain — read the examples, then accept by ruling;
// PASS when identical.
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

  // ── classes (ref/MAILBOX_GMAIL_PARITY.md §2 G4) ──
  const REVIEW_PASS = ['format', 'gmail-render', 'gas-tail-cut', 'gmail-css-leak', 'gmail-input-artifact'];
  const sq = (v) => String(v == null ? '' : v).replace(/[\s*_]+/g, '');
  const deco = (v) => String(v == null ? '' : v).replace(/&nbsp;?/gi, ' ').replace(/-{10,}/g, ' ')
    .replace(/\[image: ([^\]]*)\]/g, '$1');
  const CSS_ONLY = /^(?:[^{}]+\{[^{}]*\})+$/;
  // gas / worker: one rule-output field, or a text; gasText: GAS's whole envelope text.
  const classify = (gas, worker, gasText) => {
    if (canon(gas) === canon(worker)) return 'same';
    if ((gas != null && typeof gas !== 'string') || (worker != null && typeof worker !== 'string')) return 'VALUE';
    const x = sq(deco(gas)); const y = sq(worker); const T = sq(deco(gasText));
    if (sq(gas) === y) return 'format';
    if (x === y) return 'gmail-render';
    if (T && x.includes(T) && y.length > x.length && y.startsWith(x)) return 'gas-tail-cut';
    if (T && x.includes(T) && x.length > y.length && x.startsWith(y) && CSS_ONLY.test(x.slice(y.length))) return 'gmail-css-leak';
    return 'VALUE';
  };
  // Gmail's plain text hard-wraps so no line's text passes 75 columns
  // (measured on 80 live NEFs: every cut capture sat at a break where the line
  // + the next word > 75; no shorter break is a wrap). Rejoin exactly those —
  // a source line break (short line) stays a break.
  const GMAIL_WRAP = 75;
  const unwrap = (t) => {
    const lines = String(t == null ? '' : t).replace(/\r\n?/g, '\n').split('\n');
    let out = lines[0];
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1].replace(/\s+$/, '');
      const next = lines[i].replace(/^\s+/, '');
      const word = next.split(/\s/)[0];
      out = prev && word && prev.length + 1 + word.length > GMAIL_WRAP ? `${out.replace(/\s+$/, '')} ${next}` : `${out}\n${lines[i]}`;
    }
    return out;
  };
  // GAS's text with Gmail's renderings undone — the third run's input.
  const ungmail = (t) => deco(unwrap(t)).replace(/\*/g, '');
  // ── end classes ──

  // Where two values part, for the eye: the first difference that is NOT
  // whitespace / '*' / '_' (after undoing Gmail's renderings on the GAS side,
  // for the classes that are about content beyond them), ~160 chars around it.
  const showDiff = (gas, worker, kind) => {
    const str = (v) => (v == null ? '' : typeof v === 'string' ? v : canon(v));
    const g = ['gas-tail-cut', 'gmail-css-leak', 'gmail-input-artifact'].includes(kind) ? deco(str(gas)) : str(gas);
    const w = str(worker);
    const a = sq(g); const b = sq(w);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const pos = (raw, n) => { // index in raw of the n-th character sq keeps (past the last one: just after it)
      let c = 0; let after = 0;
      for (let j = 0; j < raw.length; j++) {
        if (/[\s*_]/.test(raw[j])) continue;
        if (c++ === n) return j;
        after = j + 1;
      }
      return after;
    };
    let gi = pos(g, i); let wi = pos(w, i);
    if (a === b) { gi = 0; while (gi < g.length && g[gi] === w[gi]) gi++; wi = gi; } // 'format': the raw split
    const clip = (t, j) => JSON.stringify(t.slice(Math.max(0, j - 60), j + 100).replace(/\s+/g, ' '));
    return { gas: clip(g, gi), worker: clip(w, wi) };
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
    const textCls = classify(gas.text, pv.text, gas.text);
    textChecked++; if (textCls === 'same') textSame++;
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
        ruleResults.push(`${rid}:pass-thru ${textCls}`);
        if (textCls !== 'same') diffs.push({ mid: r.mid, rule: rid, court, kind: textCls, field: '(passthrough text)', ...showDiff(gas.text, pv.text, textCls) });
        continue;
      }
      const body = (input) => ({ transform_mode: rule.transform_mode, transform_config: asObj(rule.transform_config) ?? rule.transform_config, input });
      const a = (await apiSend('/api/email-ingest/rules/test-transform', 'POST', body(base))).transform;
      const b = (await apiSend('/api/email-ingest/rules/test-transform', 'POST', body(yc))).transform;
      compared++;
      const fd = [];
      if (!a || !b || a.ok !== b.ok) {
        fd.push({ field: '(transform)', kind: 'VALUE', ...showDiff(canon(a), canon(b), 'VALUE') });
      } else {
        const x = a.output || {}; const y = b.output || {};
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
          const kind = classify(x[k], y[k], gas.text);
          if (kind !== 'same') fd.push({ field: k, kind, ...showDiff(x[k], y[k], kind) });
        }
        if (fd.some(d => d.kind === 'VALUE')) {
          // Third run: the rule on GAS's text with Gmail's renderings undone.
          const bare = { ...base, text: ungmail(base.text) };
          const c = (await apiSend('/api/email-ingest/rules/test-transform', 'POST', body(bare))).transform;
          if (c && c.ok) {
            for (const d of fd) {
              if (d.kind !== 'VALUE') continue;
              const k2 = classify((c.output || {})[d.field], y[d.field], bare.text);
              if (k2 === 'same' || k2 === 'format') Object.assign(d, { kind: 'gmail-input-artifact' }, showDiff(x[d.field], y[d.field], 'gmail-input-artifact'));
            }
          }
        }
      }
      const worst = fd.some(d => d.kind === 'VALUE') ? 'VALUE' : (fd.length ? 'review' : 'same');
      ruleResults.push(`${rid}:${worst}`);
      for (const d of fd) diffs.push({ mid: r.mid, rule: rid, court, ...d });
    }
    report.push({ mid: r.mid, court, subject: r.subject, text: textCls, rules: ruleResults.join(' ') || '(none matched)' });
  }
  console.table(report);
  // One row per rule.field × class: its count and first example.
  const byField = {};
  for (const d of diffs) {
    const k = `${d.rule}.${d.field}${d.court ? '' : ' (non-court)'} — ${d.kind}`;
    const e = byField[k] || (byField[k] = { n: 0, mid: d.mid, example_gas: d.gas, example_worker: d.worker });
    e.n++;
  }
  if (diffs.length) console.table(byField);
  const courtValue = diffs.filter(d => d.court && d.kind === 'VALUE');
  const unknown = diffs.filter(d => d.kind !== 'VALUE' && !REVIEW_PASS.includes(d.kind));
  if (unknown.length) throw new Error(`unclassified kinds: ${[...new Set(unknown.map(d => d.kind))].join(', ')}`);
  const counts = {};
  for (const d of diffs) counts[d.kind] = (counts[d.kind] || 0) + 1;
  const verdict = courtValue.length
    ? `STOP — ${courtValue.length} court-mail VALUE difference(s): a finding for the manager, never a live tweak`
    : (diffs.length ? `REVIEW — no court VALUE difference; ${JSON.stringify(counts)}: read the examples, accept by ruling` : 'PASS');
  console.log(`[text-parity] ${verdict}. messages=${rows.length} checked=${textChecked} (text same ${textSame}) ` +
    `rule-outputs compared=${compared} skipped(no GAS text)=${skipped}`);
  return { verdict, counts, report, diffs, byField };
})();
