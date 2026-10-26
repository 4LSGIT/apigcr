'use strict';
// A20.1 — preview an ingest rule's match / transform against a message WITHOUT
// side effects. One core serves two consumers:
//
//   - the four native dry-run endpoints, POST /api/{email,phone}-ingest/rules/
//     test-match and .../test-transform (routes/api.emailIngest.js,
//     routes/api.phoneIngest.js), whose responses are UNCHANGED — pinned
//     byte-for-byte, queries included, by tests/ingestRulePreview.routes.test.js
//     against a golden recorded before this extraction;
//   - Casey's automation.preview_ingest_rule read kind (previewRows below).
//
// Both evaluate through the PRODUCTION functions — ruleService._evaluateMatch
// and ._runTransform — never evaluateRules, which is the live path: it bumps
// match_count/last_matched_at (and with them the rule's updated_at) and
// dispatches actions. Nothing here writes: no action dispatch, no execution
// row, no metrics bump, no log write. The only statements are the sample
// fetchers' SELECTs and the kind's rule/target SELECTs.
//
// The kind is NARROWER than the native endpoints on purpose:
//   - it previews a STORED rule only (by id). The native endpoints take an
//     editor's unsaved match/transform body — including `code` mode — so a
//     model-supplied body would be model-composed code. Code now runs in the
//     QuickJS guest engine in the sandbox child (lib/guestCode.js), the same
//     engine production uses, but widening the kind to unsaved bodies is a
//     separate decision; a stored rule's code already runs on every inbound
//     message, so previewing it widens nothing.
//   - email envelopes are prepared the way evaluateRules prepares them
//     (`body` = text || html), which the native tester does not do on
//     full-fidelity rows (filed: ref/plans.md, A20 follow-ups). The route
//     adapters keep the native behavior unchanged.

const actionDispatchers = require('../lib/actionDispatchers');
const guestCode = require('../lib/guestCode');

// Lazy, like the ingest services themselves (their CIRCULAR-DEPENDENCY NOTE):
// the rule services pull hookService → actionDispatchers → engines.
const CHANNELS = {
  email: {
    name: 'email',
    ruleService: () => require('./emailIngestRuleService'),
    sampleService: () => require('./emailIngestSampleService'),
    rules: 'email_ingest_rules',
    actions: 'email_ingest_rule_actions',
    executions: 'email_ingest_executions',
    ruleKey: 'email_ingest_rule_id',
    execKey: 'email_ingest_execution_id',
    async fetch(db, { execId, limit, since, until }) {
      const sample = this.sampleService();
      return execId !== undefined
        ? sample.fetchSyntheticEnvelopes(db, { exec_id: execId })
        : sample.fetchSyntheticEnvelopes(db, { limit, since, until, scope: 'wide' });
    },
    notFoundMessage(kind, execId) {
      return kind === 'no_email_log'
        ? `execution #${execId} has no email_log row — nothing to reconstruct (auth/validation failures never produced one)`
        : `execution #${execId} not found`;
    },
    shape(r) {
      return {
        from: (r.envelope.from && r.envelope.from.email != null) ? r.envelope.from.email : null,
        label: this.sampleService()._subjectSnippet(r.envelope.subject),
      };
    },
    reportsUnparseable: false,
  },
  phone: {
    name: 'phone',
    ruleService: () => require('./phoneIngestRuleService'),
    sampleService: () => require('./phoneIngestSampleService'),
    rules: 'phone_ingest_rules',
    actions: 'phone_ingest_rule_actions',
    executions: 'phone_ingest_executions',
    ruleKey: 'phone_ingest_rule_id',
    execKey: 'phone_ingest_execution_id',
    async fetch(db, { execId, limit, since, until }) {
      const sample = this.sampleService();
      return execId !== undefined
        ? sample.fetchEnvelopes(db, { exec_id: execId })
        : sample.fetchEnvelopes(db, { limit, since, until });
    },
    notFoundMessage(kind, execId, verb) {
      return kind === 'unparseable'
        ? `execution #${execId} has no parseable raw_input — nothing to ${verb}`
        : `execution #${execId} not found`;
    },
    shape(r) {
      return {
        from: (r.envelope && r.envelope.from != null) ? r.envelope.from : null,
        label: this.sampleService()._testLabel(r.envelope, r.event_type, r.ts),
      };
    },
    reportsUnparseable: true,
  },
};

function channelOf(name) {
  const ch = CHANNELS[name];
  if (!ch) throw new Error(`unknown ingest channel: ${name}`);
  return ch;
}

function shapedError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ─────────────────────────────────────────────────────────────
// Native request validation (moved verbatim from the routes)
// ─────────────────────────────────────────────────────────────

function _validateMatchRequest(body) {
  const { match_mode, match_config } = body;
  if (match_mode !== 'conditions' && match_mode !== 'code') {
    return { error: "match_mode must be 'conditions' or 'code'" };
  }

  let limit = 100;
  if (body.limit !== undefined && body.limit !== null) {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1) return { error: 'limit must be a positive integer' };
    limit = Math.min(300, n);
  }

  let since;
  if (body.since !== undefined && body.since !== null && body.since !== '') {
    const d = new Date(body.since);
    if (isNaN(d.getTime())) return { error: 'Invalid since datetime' };
    since = body.since;
  }

  let until;
  if (body.until !== undefined && body.until !== null && body.until !== '') {
    const d = new Date(body.until);
    if (isNaN(d.getTime())) return { error: 'Invalid until datetime' };
    if (since !== undefined && d.getTime() < new Date(since).getTime()) {
      return { error: 'until must be >= since — the range is backwards' };
    }
    until = body.until;
  }

  let execId;
  if (body.exec_id !== undefined && body.exec_id !== null && body.exec_id !== '') {
    const n = Number(body.exec_id);
    if (!Number.isInteger(n) || n < 1) return { error: 'exec_id must be a positive integer' };
    if (since !== undefined || until !== undefined) {
      return { error: 'exec_id and since/until are mutually exclusive — target one execution or a date window, not both' };
    }
    execId = n; // limit is ignored in exec_id mode
  }

  const includeMisses = body.include_misses === true;

  if (match_mode === 'conditions') {
    // The production matcher treats a NULL conditions config as NON-match
    // (never match-all), so testing one is pointless — reject with the
    // explicit always-match shape instead.
    if (match_config == null || typeof match_config !== 'object' || Array.isArray(match_config)) {
      return { error: "conditions mode requires match_config to be an object — for an explicit always-match, use {operator:'and', conditions:[]}" };
    }
  } else {
    // code mode — extract the code string EXACTLY the way _evaluateMatch
    // does: a string config is JSON.parse'd FIRST (the matcher's defensive
    // parse), THEN code = string-or-.code. A raw (non-JSON) code string
    // therefore never matches in production — reject it up front instead of
    // returning a misleading 0-match run. Then compile ONCE so a syntax
    // error is a clean 400 instead of 0-matches-with-N-warnings. COMPILE
    // ONLY: `new Function` builds the function and it is DISCARDED, never
    // called — the body is not executed in this process. Per-row evaluation
    // goes through _evaluateMatch, i.e. the guest engine production uses, so
    // runtime semantics (error swallowing included) are production's. (V8's
    // parser is kept for this pre-check because its message is pinned by
    // the golden; a body V8 accepts and QuickJS rejects reports per row as a
    // code error, exactly as it would live.)
    let cfg = match_config;
    if (typeof cfg === 'string') {
      try { cfg = JSON.parse(cfg); }
      catch {
        return { error: "match_config string is not valid JSON — the production matcher would treat this as non-match on every event; send {code:'...'} instead" };
      }
    }
    const code = typeof cfg === 'string' ? cfg : cfg?.code;
    if (!code || typeof code !== 'string' || !code.trim()) {
      return { error: 'code mode requires a non-empty code string (match_config.code)' };
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function('input', code);
    } catch (err) {
      return { error: `code does not compile: ${err.message}` };
    }
  }

  return { match_mode, match_config, limit, since, until, execId, includeMisses };
}

function _validateTransformRequest(body) {
  const { transform_mode, transform_config } = body;
  if (typeof transform_mode !== 'string' || !transform_mode) {
    return { error: 'transform_mode is required' };
  }

  const hasExec  = body.exec_id !== undefined && body.exec_id !== null && body.exec_id !== '';
  const hasInput = body.input   !== undefined && body.input   !== null;
  if (hasExec === hasInput) {
    return { error: 'provide exactly one of exec_id (historical execution) or input (inline event object)' };
  }

  let execId;
  if (hasExec) {
    const n = Number(body.exec_id);
    if (!Number.isInteger(n) || n < 1) return { error: 'exec_id must be a positive integer' };
    execId = n;
  } else if (typeof body.input !== 'object' || Array.isArray(body.input)) {
    return { error: 'input must be a JSON object (the event to transform)' };
  }

  let paramsMappings;
  if (body.params_mappings !== undefined && body.params_mappings !== null) {
    if (!Array.isArray(body.params_mappings) || body.params_mappings.length > 20) {
      return { error: 'params_mappings must be an array of at most 20 {label?, mapping} entries' };
    }
    for (const pm of body.params_mappings) {
      if (pm == null || typeof pm !== 'object' || Array.isArray(pm)
          || pm.mapping == null || typeof pm.mapping !== 'object' || Array.isArray(pm.mapping)) {
        return { error: 'each params_mappings entry needs a mapping object' };
      }
    }
    paramsMappings = body.params_mappings;
  }

  return { transform_mode, transform_config, execId, input: body.input, paramsMappings };
}

// ─────────────────────────────────────────────────────────────
// The shared core
// ─────────────────────────────────────────────────────────────

// Evaluate `rule` against each corpus row with the production matcher;
// `prepare` (kind only) turns a fetched envelope into what evaluateRules sees.
// A code-mode rule's body is pre-run over the whole corpus in ONE sandbox
// child (guestCode.batchRunner) and each row is then answered through the
// production _evaluateMatch with that runner — one child instead of one per
// row, same engine, same per-row semantics. The code is located exactly as
// _evaluateMatch locates it; if that ever drifted, the runner simply runs the
// uncovered call on its own (correct, only slower).
async function _matchCorpus(ch, rule, rows, { prepare, observe } = {}) {
  const ruleService = ch.ruleService();
  const envelopes = rows.map((r) => (prepare ? prepare(r) : r.envelope));
  let runCode;
  if (rule.match_mode === 'code') {
    let cfg = rule.match_config;
    let parsed = true;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (_) { parsed = false; } }
    const code = parsed ? (typeof cfg === 'string' ? cfg : cfg?.code) : null;
    if (code) {
      runCode = await guestCode.batchRunner(code, envelopes, {
        timeoutMs: guestCode.DEFAULT_TIMEOUT_MS, truthy: true, label: `${ch.name}IngestRule code`,
      });
    }
  }
  const matches = [];
  const misses = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const envelope = envelopes[i];
    let matched;
    let note = null;
    if (observe) {
      const seen = await observe((warn) => ruleService._evaluateMatch(rule, envelope, { warn, runCode }));
      matched = seen.value;
      note = seen.note;
    } else {
      matched = await ruleService._evaluateMatch(rule, envelope, { runCode });
    }
    const label = ch.shape(r);
    const shaped = {
      exec_id:  r.exec_id,
      ts:       r.ts,
      from:     label.from,
      label:    label.label,
      matched,
      fidelity: r.fidelity,
      status:   r.status,
    };
    if (observe) shaped.note = note;
    (matched ? matches : misses).push(shaped);
  }
  return { matches, misses };
}

// Route adapter — POST /api/{email,phone}-ingest/rules/test-match.
async function testMatch(db, channelName, body) {
  const ch = channelOf(channelName);
  const v = _validateMatchRequest(body || {});
  if (v.error) return { status: 400, body: { error: v.error } };

  // exec_id → that one execution. Otherwise the windowed corpus (email: scope
  // 'wide' — suppressed/skipped events in, duplicates out).
  const corpus = await ch.fetch(db, v);
  if (corpus.not_found) {
    return { status: 404, body: { error: ch.notFoundMessage(corpus.not_found, v.execId, 'evaluate') } };
  }

  const testRule = { id: 'test-match', name: '(editor)', match_mode: v.match_mode, match_config: v.match_config };
  const { matches, misses } = await _matchCorpus(ch, testRule, corpus.rows);

  const out = {
    success:       true,
    total:         corpus.rows.length,
    matched_count: matches.length,
  };
  if (ch.reportsUnparseable) out.unparseable_skipped = corpus.unparseable_skipped;
  out.rows = v.includeMisses ? matches.concat(misses) : matches;
  if ((v.since !== undefined || v.until !== undefined) && corpus.window_total !== undefined) {
    out.window_total = corpus.window_total;
    out.truncated    = corpus.window_total > corpus.rows.length;
  }
  return { status: 200, body: out };
}

// Route adapter — POST /api/{email,phone}-ingest/rules/test-transform.
async function testTransform(db, channelName, body) {
  const ch = channelOf(channelName);
  const v = _validateTransformRequest(body || {});
  if (v.error) return { status: 400, body: { error: v.error } };

  let envelope, source;
  if (v.execId !== undefined) {
    const corpus = await ch.fetch(db, { execId: v.execId });
    if (corpus.not_found) {
      return { status: 404, body: { error: ch.notFoundMessage(corpus.not_found, v.execId, 'transform') } };
    }
    const row = corpus.rows[0];
    envelope = row.envelope;
    source   = { exec_id: row.exec_id, ts: row.ts, fidelity: row.fidelity, status: row.status };
  } else {
    envelope = v.input;
    source   = 'inline';
  }

  const testRule = { id: 'test-transform', name: '(editor)', transform_mode: v.transform_mode, transform_config: v.transform_config };
  const tr = await ch.ruleService()._runTransform(testRule, envelope);
  const transform = tr.ok ? { ok: true, output: tr.output } : { ok: false, error: tr.error };

  const out = { success: true, source, input: envelope, transform };
  if (tr.ok && v.paramsMappings) {
    out.resolved_params = v.paramsMappings.map((pm, i) => ({
      label:  (typeof pm.label === 'string' && pm.label) ? pm.label : `mapping #${i + 1}`,
      params: actionDispatchers.resolveParamsMapping(pm.mapping, tr.output),
    }));
  }
  return { status: 200, body: out };
}

// ─────────────────────────────────────────────────────────────
// Casey's automation.preview_ingest_rule
// ─────────────────────────────────────────────────────────────

const PREVIEW_WINDOW_MAX = 40;
const OUTPUT_CELL_CHARS = 2500;
const NOTE_CHARS = 300;

function capJson(value, max) {
  if (value === undefined) return null;
  let s;
  try { s = JSON.stringify(value); } catch (_) { s = String(value); }
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length} chars total]` : s;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function hostOf(url) {
  try { return new URL(String(url)).host || null; } catch (_) { return null; }
}

// The production matcher/transformer report WHY a rule did not match (or a
// mapper warning) only through a warning — a throwing match is a silent
// non-match in the stored record. `fn` receives a warn sink to hand the
// production function (its `warn` option); the text is captured AND still
// forwarded to console.warn, so the logs read exactly as they do for the
// native tester. A sink, not a console.warn patch: the call is async now (the
// guest engine), and a patched global would capture whatever else warned
// while it waited.
async function observeWarnings(fn) {
  const seen = [];
  const warn = (...args) => {
    seen.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    console.warn(...args);
  };
  const value = await fn(warn);
  const note = seen.length ? seen.join(' | ').replace(/\[(?:email|phone)IngestRule\]\s*/g, '').slice(0, NOTE_CHARS) : null;
  return { value, note };
}

// What evaluateRules hands the matcher. Email only: evaluateRules derives
// `body` = text || html || '' (the wire envelope carries no body). A
// reconstructed row (raw_input truncated) carries no text/html but already
// holds email_log.body, which IS that derivation as stored at ingest — keep it.
// A user sample with no text/html may state body directly.
function productionEnvelope(channel, envelope, { fidelity, sample } = {}) {
  if (channel !== 'email' || envelope == null || typeof envelope !== 'object') return envelope;
  if (fidelity === 'reconstructed') return envelope;
  const derived = envelope.text || envelope.html || '';
  if (sample && !envelope.text && !envelope.html) return { ...envelope, body: envelope.body != null ? envelope.body : '' };
  return { ...envelope, body: derived };
}

function messageSummary(channel, envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (channel === 'email') {
    const from = envelope.from && typeof envelope.from === 'object' ? envelope.from.email : envelope.from;
    const to = Array.isArray(envelope.to) ? envelope.to.map((t) => t && t.email).filter(Boolean).join(', ') : envelope.to;
    return `from ${from || '?'} to ${to || '?'} — subject "${String(envelope.subject || '').slice(0, 160)}"`.slice(0, NOTE_CHARS);
  }
  const msg = envelope.message != null ? ` — "${String(envelope.message).replace(/\s+/g, ' ').slice(0, 120)}"` : '';
  return `${envelope.type || 'event'} from ${envelope.from || '?'} to ${envelope.to || '?'}${msg}`.slice(0, NOTE_CHARS);
}

async function loadStoredRule(db, ch, ruleId) {
  const [[rule]] = await db.query(
    `SELECT id, name, active, position, match_mode, match_config, transform_mode, transform_config
       FROM ${ch.rules} WHERE id = ?`, [ruleId]);
  if (!rule) throw shapedError(404, `${ch.name} ingest rule ${ruleId} does not exist`);
  const [actions] = await db.query(
    `SELECT id, name, position, active, action_type, config
       FROM ${ch.actions} WHERE rule_id = ? ORDER BY position ASC, id ASC`, [ruleId]);
  return { rule, actions };
}

// One redacted line per action saying what it WOULD do with this output —
// computed, never dispatched. Mirrors the dispatchers' own refusals.
async function wouldFire(db, ch, rule, actions, output, { isTest }) {
  const rows = [];
  const cfgOf = (a) => parseJson(a.config, {}) || {};
  const ids = (type, key) => [...new Set(actions.filter((a) => a.action_type === type)
    .map((a) => Number(cfgOf(a)[key])).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const wfIds = ids('workflow', 'workflow_id');
  const tplIds = ids('sequence', 'template_id');
  const slugs = [...new Set(actions.filter((a) => a.action_type === 'hook').map((a) => String(cfgOf(a).slug || '')).filter(Boolean))];
  const credIds = ids('http', 'credential_id');
  const byId = async (sql, list) => (list.length
    ? (await db.query(sql.replace('(?)', `(${list.map(() => '?').join(',')})`), list))[0] : []);
  const workflows = new Map((await byId('SELECT id, name, active, current_version FROM workflows WHERE id IN (?)', wfIds)).map((r) => [Number(r.id), r]));
  const templates = new Map((await byId('SELECT id, name, active FROM sequence_templates WHERE id IN (?)', tplIds)).map((r) => [Number(r.id), r]));
  const hooks = new Map((await byId('SELECT slug, name, active FROM hooks WHERE slug IN (?)', slugs)).map((r) => [String(r.slug), r]));
  const creds = new Map((await byId('SELECT id, name FROM credentials WHERE id IN (?)', credIds)).map((r) => [Number(r.id), String(r.name)]));

  for (const a of actions) {
    const cfg = cfgOf(a);
    const row = {
      row: 'would_fire_action', [ch.ruleKey]: Number(rule.id), rule_action_id: Number(a.id),
      action_name: a.name || null, action_type: a.action_type, active: a.active ? 1 : 0,
      would: null, resolved_params: null,
    };
    if (!a.active) {
      row.would = 'nothing — this action is inactive and is never dispatched';
    } else if (a.action_type === 'workflow') {
      const wf = workflows.get(Number(cfg.workflow_id));
      if (isTest) row.would = `nothing — a "-test-" replay envelope skips workflow actions (status skipped_test_envelope)`;
      else if (!wf) row.would = `fail — workflow ${cfg.workflow_id} does not exist`;
      else if (!wf.active) row.would = `be refused — workflow ${wf.id} "${wf.name}" is inactive`;
      else if (!Number(wf.current_version)) row.would = `be refused — workflow ${wf.id} "${wf.name}" has never been published`;
      else row.would = `start workflow ${wf.id} "${wf.name}" with the transform output as its init_data`;
    } else if (a.action_type === 'sequence') {
      const field = cfg.contact_id_field || 'contact_id';
      const contactId = output == null ? undefined : actionDispatchers.getByPath(output, field);
      const target = cfg.template_id != null && cfg.template_id !== ''
        ? (() => { const t = templates.get(Number(cfg.template_id)); return t ? `template ${t.id} "${t.name}"${t.active ? '' : ' (inactive)'}` : `template ${cfg.template_id} (missing)`; })()
        : `the active template of type "${cfg.template_type}"`;
      row.would = (contactId == null || contactId === '')
        ? `fail — the transform output has no contact id at "${field}" (sequence enrollment needs one)`
        : `enroll contact ${String(contactId).slice(0, 40)} in ${target}`;
    } else if (a.action_type === 'internal_function') {
      row.would = `call internal function ${cfg.function_name || '(none)'} with the resolved params`;
      row.resolved_params = capJson(actionDispatchers.resolveParamsMapping(cfg.params_mapping, output), 1200);
    } else if (a.action_type === 'hook') {
      const h = hooks.get(String(cfg.slug || ''));
      row.would = !h ? `fail — hook "${cfg.slug}" does not exist`
        : `re-enter hook "${h.name}" (${h.active ? 'active' : 'INACTIVE — it would refuse'}) with the output wrapped as body`;
    } else if (a.action_type === 'http') {
      // NEVER the URL or a header value — host, method and credential label only.
      const cred = cfg.credential_id != null ? (creds.get(Number(cfg.credential_id)) || `credential #${cfg.credential_id}`) : 'no credential';
      row.would = `send ${String(cfg.method || 'POST').toUpperCase()} to host ${hostOf(cfg.url) || '(unparseable)'} [URL redacted] using ${cred}`;
    } else {
      row.would = `fail — unknown action type ${a.action_type}`;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The read kind. `step` is the validated shape from assistantService
 * validateStep: { channel, rule_id, execution_id? | sample? | window? }.
 * Returns evidence rows; writes nothing.
 */
async function previewRows(db, { channel, rule_id, execution_id, sample, window } = {}) {
  const ch = channelOf(channel);
  const { rule, actions } = await loadStoredRule(db, ch, rule_id);
  const ruleService = ch.ruleService();
  const base = {
    channel: ch.name, [ch.ruleKey]: Number(rule.id), rule_name: rule.name,
    rule_active: rule.active ? 1 : 0, match_mode: rule.match_mode, transform_mode: rule.transform_mode,
    dry_run: 1,
  };
  const inactiveNote = rule.active ? null
    : 'the rule is INACTIVE: live ingest never evaluates it — this shows what it would do if it were active';

  if (window) {
    const limit = Math.max(1, Math.min(Number(window.limit) || 20, PREVIEW_WINDOW_MAX));
    // Firm-local bounds (a date-only until = the end of that day), the same
    // conversion the execution finder uses.
    const { windowBound } = require('./automationReadService');
    const corpus = await ch.fetch(db, { limit, since: windowBound(window.since, false), until: windowBound(window.until, true) });
    const { matches, misses } = await _matchCorpus(ch, rule, corpus.rows, {
      prepare: (r) => productionEnvelope(ch.name, r.envelope, { fidelity: r.fidelity }),
      observe: observeWarnings,
    });
    const summary = {
      row: 'preview_window', ...base, total: corpus.rows.length, matched_count: matches.length,
      window_total: corpus.window_total !== undefined ? corpus.window_total : null,
      truncated: corpus.window_total !== undefined ? (corpus.window_total > corpus.rows.length ? 1 : 0) : null,
      unparseable_skipped: corpus.unparseable_skipped !== undefined ? corpus.unparseable_skipped : null,
      note: [inactiveNote, 'match only — preview one execution id to see the transform output and the actions'].filter(Boolean).join('; '),
      side_effects: 'none: no action dispatched, no execution row, no match_count bump',
    };
    const hits = matches.concat(misses).map((h) => ({
      row: 'preview_hit', [ch.ruleKey]: Number(rule.id), [ch.execKey]: h.exec_id, ts: h.ts,
      from: h.from, label: h.label, matched: h.matched ? 1 : 0, match_note: h.note,
      fidelity: h.fidelity, status: h.status,
    }));
    return [summary, ...hits];
  }

  let envelope;
  let source;
  let isTest = false;
  if (execution_id !== undefined) {
    const corpus = await ch.fetch(db, { execId: execution_id });
    if (corpus.not_found) throw shapedError(404, ch.notFoundMessage(corpus.not_found, execution_id, 'evaluate'));
    const r = corpus.rows[0];
    envelope = productionEnvelope(ch.name, r.envelope, { fidelity: r.fidelity });
    source = { [ch.execKey]: r.exec_id, message_source: `${ch.name} execution #${r.exec_id}`, fidelity: r.fidelity, execution_status: r.status, ts: r.ts };
    if (ch.name === 'email') {
      // emailIngestService flags a GAS "-test-" replay by its message_id and
      // the rule service then skips workflow actions; the fetcher does not
      // carry the flag, so read the id (same marker, same test).
      const [[m]] = await db.query(`SELECT message_id FROM ${ch.executions} WHERE id = ?`, [r.exec_id]);
      isTest = !!(m && require('./emailIngestService').TEST_MESSAGE_ID_RE.test(String(m.message_id || '')));
    }
  } else {
    // Fail closed: the validator guarantees exactly one source; a caller that
    // lost it must not preview an empty message.
    if (sample == null || typeof sample !== 'object' || Array.isArray(sample)) {
      throw shapedError(422, 'preview needs exactly one message source: an execution id, a sample, or a window');
    }
    envelope = productionEnvelope(ch.name, sample, { sample: true });
    source = { message_source: 'sample supplied in the question', fidelity: 'sample' };
  }

  const match = await observeWarnings((warn) => ruleService._evaluateMatch(rule, envelope, { warn }));
  // Exactly the live order: the transform runs only for a matching rule —
  // a stored code transform never runs on a message it would not see.
  const transform = match.value
    ? await observeWarnings((warn) => ruleService._runTransform(rule, envelope, { warn }))
    : { value: null, note: null };
  const tr = transform.value;
  const activeActions = actions.filter((a) => a.active).length;
  let fires;
  if (!match.value) fires = 'no — the rule does not match this message';
  else if (!tr.ok) fires = 'no — the rule MATCHES but its transform fails, so no action fires (a failed "transform" outcome is recorded)';
  else if (!activeActions) fires = 'matched, but the rule has no active actions — only the match is recorded';
  else fires = `yes — ${activeActions} active action(s) would be dispatched in position order, each isolated from the others' failures`;
  if (!rule.active) fires = `${fires} [rule inactive: live ingest never evaluates it]`;

  let transformOutput = null;
  if (tr && tr.ok) {
    transformOutput = (rule.transform_mode || 'passthrough') === 'passthrough'
      ? 'passthrough — the actions receive the message envelope unchanged'
      : capJson(tr.output, OUTPUT_CELL_CHARS);
  }
  const rows = [{
    row: 'preview', ...base, ...source,
    message_summary: messageSummary(ch.name, envelope),
    is_test_replay: isTest ? 1 : 0,
    matched: match.value ? 1 : 0,
    match_note: match.note,
    transform_ok: tr ? (tr.ok ? 1 : 0) : null,
    transform_error: tr && !tr.ok ? String(tr.error || '').slice(0, NOTE_CHARS) : null,
    transform_warnings: transform.note,
    transform_output: transformOutput,
    would_fire: fires,
    note: inactiveNote,
    side_effects: 'none: no action dispatched, no execution row, no match_count bump',
  }];
  if (match.value && tr && tr.ok) rows.push(...await wouldFire(db, ch, rule, actions, tr.output, { isTest }));
  return rows;
}

module.exports = {
  testMatch,
  testTransform,
  previewRows,
  productionEnvelope,
  observeWarnings,
  CHANNELS,
  PREVIEW_WINDOW_MAX,
};
