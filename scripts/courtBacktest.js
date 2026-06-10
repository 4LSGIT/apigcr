// scripts/courtBacktest.js
//
// OFFLINE backtest harness for the court_extract prompt. Pulls a stratified
// sample of historical MIEB emails from email_log, runs aiService.call against
// each, and scores the output — WITHOUT writing to cases/appts/events or any
// court table. (ai_calls rows from aiService.call are expected; this script
// reads ai_calls back read-only to recover per-call latency/cost.)
//
// Usage:
//   node scripts/courtBacktest.js [--model=claude-sonnet-4-6] [--perCategory=5]
//                                 [--out=backtest_<model>_<ts>.json]
//
// Scoring per email (NO writes):
//   - usable_json    : call ok && json parsed
//   - citation_pass  : every citation value is a whitespace-normalized
//                      substring of the body (per-field misses recorded)
//   - resolve        : resolveCase(db, case_number) → case_found / primary_contact_found
//   - field_agreement: where the live cases row already holds a value, compare
//                      extracted case_file_date / case_trustee / case_objection,
//                      and compare any create_appointment date to case_341_current
//                      (date part). agree | disagree | db_empty.
//
// Writes only a local report JSON file + prints an aggregate block to console.

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const db = require('../startup/db');
const aiService = require('../services/aiService');
const { resolveCase } = require('../lib/courtResolve');
const { checkCitations } = require('../lib/courtCitation');

// ─────────────────────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

const args = parseArgs(process.argv);
const MODEL = args.model || 'claude-sonnet-4-6';
// 'natural' (default): latest N MIEB emails, UNFILTERED — the true production
//   base-rate distribution (mostly noise, thin actionable scatter). This is the
//   honest accuracy test. Recent email_log is forwarder-complete + plain text.
// 'stratified': latest perCategory per doc-type filter — forces coverage of the
//   rare actionable paths for targeted prompt spot-checks. NOT a base rate.
const MODE = (args.mode === 'stratified') ? 'stratified' : 'natural';
// --source=test : restrict to GAS test-trigger rows (message_id carries the
//   '-test-<ts36>-<rand6>' suffix). Use right after firing forwardTestTrigger to
//   score exactly the batch you just ingested, immune to any real court email
//   that lands between trigger and run. Default 'log' = the full MIEB corpus.
const SOURCE = (args.source === 'test') ? 'test' : 'log';
const PER_CATEGORY = Math.max(1, parseInt(args.perCategory, 10) || 5);
const SAMPLE_SIZE = Math.max(1, parseInt(args.sampleSize, 10) || 40);
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = args.out || `backtest_${MODE}_${MODEL}_${TS}.json`;

// ─────────────────────────────────────────────────────────────
// Stratified sample definition (MODE='stratified' only). Each category: a
// subject WHERE clause; we take the latest PER_CATEGORY MIEB emails matching
// it, then dedupe by message_id (first category to claim an id keeps it).
// Filters widened to match the real MIEB doc-type vocabulary observed in the
// corpus (the original 9 caught only ~24% of rows).
// ─────────────────────────────────────────────────────────────

const CATEGORIES = [
  { name: 'voluntary_petition', where: "subject LIKE '%Voluntary Petition%'" },
  { name: 'meeting_ch7',        where: "subject LIKE '%Meeting of Creditors%' AND subject LIKE '%Ch 7%'" },
  { name: 'meeting_ch13',       where: "subject LIKE '%Meeting of Creditors%' AND subject LIKE '%Ch 13%'" },
  { name: 'continued',          where: "(subject LIKE '%Continuance%' OR subject LIKE '%Continued Meeting%' OR subject LIKE '%Rescheduled%' OR subject LIKE '%Meeting of Creditors Not Held%')" },
  { name: 'hearing',            where: "(subject LIKE '%Notice of Hearing%' OR subject LIKE '%Notice and Opportunity for Hearing%' OR subject LIKE '%Order to Set Hearing%' OR subject LIKE '%Order To Set Hearing%')" },
  { name: 'adjourned',          where: "(subject LIKE '%Adjourn%' OR subject LIKE '%Reschedul%' OR subject LIKE '%Continue Hearing%')" },
  { name: 'show_cause',         where: "subject LIKE '%Show Cause%'" },
  { name: 'discharge_close',    where: "(subject LIKE '%Discharg%' OR subject LIKE '%Final Decree%' OR subject LIKE '%Case Closed%')" },
  { name: 'order',              where: "(subject LIKE '%\\\"Order%' OR subject LIKE '%Payment Order%' OR subject LIKE '%Notice of Presentment%')" },
  { name: 'pleading',           where: "(subject LIKE '%Stipulation%' OR subject LIKE '%Response%' OR subject LIKE '%Reply%' OR subject LIKE '%Motion%' OR subject LIKE '%Objection%')" },
  { name: 'noise',              where: "(subject LIKE '%Certificate%' OR subject LIKE '%Statement%' OR subject LIKE '%BNC%' OR subject LIKE '%Proof of Claim%')" },
];

/**
 * Coarse doc-type label derived from the SUBJECT only — for the human-readable
 * distribution in the report. NOT a gold classification label (these historical
 * emails have no ground-truth class); it just lets us eyeball the sampled mix.
 */
function subjectDocType(subject) {
  const s = String(subject || '');
  if (/Voluntary Petition/i.test(s)) return 'voluntary_petition';
  if (/Meeting of Creditors Not Held|Continued Meeting|Continuance of Meeting/i.test(s)) return 'continued_meeting';
  if (/Meeting of Creditors|341/i.test(s)) return /Ch 7/i.test(s) ? 'meeting_ch7' : (/Ch 13/i.test(s) ? 'meeting_ch13' : 'meeting');
  if (/Adjourn|Reschedul|Continue Hearing/i.test(s)) return 'adjourned';
  if (/Notice (of|and Opportunity for) Hearing|Order to Set Hearing/i.test(s)) return 'hearing';
  if (/Show Cause/i.test(s)) return 'show_cause';
  if (/Discharg|Final Decree|Case Closed/i.test(s)) return 'discharge_close';
  if (/Proof of Claim/i.test(s)) return 'proof_of_claim';
  if (/BNC|Certificate/i.test(s)) return 'certificate';
  if (/Notice of Presentment|Payment Order|"Order/i.test(s)) return 'order';
  if (/Stipulation|Response|Reply|Motion|Objection|Summons/i.test(s)) return 'pleading';
  if (/Statement|Schedule|Plan|Application|Cover Sheet|Corporate Ownership/i.test(s)) return 'filing_doc';
  return 'other';
}

async function buildSample() {
  // When sourcing the test batch, restrict to the '-test-' mangled ids. This
  // predicate is ANDed into whichever mode's query runs.
  const testPred = SOURCE === 'test' ? " AND message_id LIKE '%-test-%'" : '';

  if (MODE === 'natural') {
    // Real base-rate (source=log): latest N MIEB emails, no category filter.
    // source=test: latest N test-trigger rows — exactly the batch you ingested.
    const [rows] = await db.query(
      `SELECT id, message_id, subject, from_email, body
         FROM email_log
        WHERE from_email LIKE '%mieb%'${testPred}
        ORDER BY id DESC
        LIMIT ?`,
      [SAMPLE_SIZE]
    );
    const seen = new Set();
    const sample = [];
    for (const r of rows) {
      if (seen.has(r.message_id)) continue;
      seen.add(r.message_id);
      sample.push({ sample_category: subjectDocType(r.subject), ...r });
    }
    return sample;
  }

  // stratified
  const seen = new Set();
  const sample = [];
  for (const cat of CATEGORIES) {
    const [rows] = await db.query(
      `SELECT id, message_id, subject, from_email, body
         FROM email_log
        WHERE from_email LIKE '%mieb%'${testPred} AND ${cat.where}
        ORDER BY id DESC
        LIMIT ?`,
      [PER_CATEGORY]
    );
    for (const r of rows) {
      if (seen.has(r.message_id)) continue;
      seen.add(r.message_id);
      sample.push({ sample_category: cat.name, ...r });
    }
  }
  return sample;
}

// ─────────────────────────────────────────────────────────────
// Scoring helpers
// ─────────────────────────────────────────────────────────────

/** Collapse all whitespace runs to single spaces, trim. */
function normWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// checkCitations + NON_CITABLE_FIELDS now live in lib/courtCitation.js so the
// live executor (services/courtExecutor.js) and this harness score citations
// identically. Imported above. normWs (below/above) stays local.

/** Extract the first create_appointment action's date (YYYY-MM-DD) or null. */
function firstApptDate(json) {
  const actions = Array.isArray(json && json.actions) ? json.actions : [];
  for (const a of actions) {
    if (a && a.type === 'create_appointment' && a.fields && a.fields.date) {
      return String(a.fields.date);
    }
  }
  return null;
}

/** Pull the update_case_fields map (merged) from actions, or {}. */
function caseFieldsFromJson(json) {
  const actions = Array.isArray(json && json.actions) ? json.actions : [];
  const merged = {};
  for (const a of actions) {
    if (a && a.type === 'update_case_fields' && a.fields && typeof a.fields === 'object') {
      Object.assign(merged, a.fields);
    }
  }
  return merged;
}

/** mysql DATE/DATETIME value → 'YYYY-MM-DD' (date part) or null. */
function toDatePart(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    // pool timezone is 'Z'; take the UTC date part.
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Compare extracted values against the live cases row (read-only). Only fields
 * the DB already holds are scored as agree/disagree; empty DB → db_empty.
 */
async function fieldAgreement(json, caseId) {
  const result = {
    case_file_date: 'no_extract',
    case_trustee: 'no_extract',
    case_objection: 'no_extract',
    appt_date_vs_341_current: 'no_extract',
  };
  if (!caseId) {
    for (const k of Object.keys(result)) result[k] = 'no_case';
    return result;
  }

  const [rows] = await db.query(
    `SELECT case_file_date, case_trustee, case_objection, case_341_current
       FROM cases WHERE case_id = ? LIMIT 1`,
    [caseId]
  );
  if (!rows.length) {
    for (const k of Object.keys(result)) result[k] = 'no_case';
    return result;
  }
  const row = rows[0];
  const cf = caseFieldsFromJson(json);

  // Date columns: compare date parts.
  const dateCmp = (extracted, dbVal) => {
    if (extracted == null) return 'no_extract';
    if (dbVal == null) return 'db_empty';
    return toDatePart(extracted) === toDatePart(dbVal) ? 'agree' : 'disagree';
  };
  // String column (trustee): trim + case-insensitive compare.
  const strCmp = (extracted, dbVal) => {
    if (extracted == null) return 'no_extract';
    if (dbVal == null || String(dbVal).trim() === '') return 'db_empty';
    return normWs(extracted).toLowerCase() === normWs(dbVal).toLowerCase()
      ? 'agree' : 'disagree';
  };

  result.case_file_date = dateCmp(cf.case_file_date, row.case_file_date);
  result.case_trustee   = strCmp(cf.case_trustee, row.case_trustee);
  result.case_objection = dateCmp(cf.case_objection, row.case_objection);

  const apptDate = firstApptDate(json);
  result.appt_date_vs_341_current =
    apptDate == null ? 'no_extract'
    : row.case_341_current == null ? 'db_empty'
    : (apptDate === toDatePart(row.case_341_current) ? 'agree' : 'disagree');

  return result;
}

/** Read back latency_ms (and a cost sanity value) for a logged ai_calls row. */
async function fetchCallMeta(callId) {
  if (!callId) return { latency_ms: null, cost_cents: null };
  try {
    const [rows] = await db.query(
      `SELECT latency_ms, cost_cents FROM ai_calls WHERE id = ? LIMIT 1`,
      [callId]
    );
    if (!rows.length) return { latency_ms: null, cost_cents: null };
    return {
      latency_ms: rows[0].latency_ms == null ? null : Number(rows[0].latency_ms),
      cost_cents: rows[0].cost_cents == null ? null : Number(rows[0].cost_cents),
    };
  } catch (_) {
    return { latency_ms: null, cost_cents: null };
  }
}

// ─────────────────────────────────────────────────────────────
// Aggregate helpers
// ─────────────────────────────────────────────────────────────

function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0; // one decimal %
}

function tally(values) {
  const t = {};
  for (const v of values) t[v] = (t[v] || 0) + 1;
  return t;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backtest] source=${SOURCE} mode=${MODE} model=${MODEL} `
    + (MODE === 'natural' ? `sampleSize=${SAMPLE_SIZE}` : `perCategory=${PER_CATEGORY}`));
  const sample = await buildSample();
  console.log(`[backtest] sampled ${sample.length} unique emails`);

  const perEmail = [];
  let totalCostCents = 0;
  const latencies = [];

  for (let i = 0; i < sample.length; i++) {
    const e = sample[i];
    process.stdout.write(`[backtest] ${i + 1}/${sample.length} id=${e.id} (${e.sample_category}) ... `);

    let callResult;
    try {
      callResult = await aiService.call(db, {
        promptKey: 'court_extract',
        vars: {
          message_id: e.message_id,
          subject: e.subject,
          from_email: e.from_email,
        },
        userInput: e.body,
        model: MODEL,
        outputType: 'json',
        consumerRef: 'backtest',
      });
    } catch (err) {
      callResult = { ok: false, error: 'exception', detail: err.message, callId: null };
    }

    const usableJson = !!(callResult.ok && callResult.json);
    const json = usableJson ? callResult.json : null;

    // Cost: prefer computeCostCents from returned usage; fall back to ai_calls.
    const meta = await fetchCallMeta(callResult.callId);
    let costCents = null;
    if (callResult.usage &&
        (callResult.usage.input_tokens != null || callResult.usage.output_tokens != null)) {
      costCents = aiService.computeCostCents(
        callResult.usage.input_tokens, callResult.usage.output_tokens);
    } else if (meta.cost_cents != null) {
      costCents = meta.cost_cents;
    }
    if (costCents != null) totalCostCents += costCents;
    if (meta.latency_ms != null) latencies.push(meta.latency_ms);

    // Citations.
    const citation = usableJson
      ? checkCitations(e.subject, e.body, json && json.actions)
      : { pass: false, misses: [] };

    // Resolve (read-only) off the extracted case_number.
    const docket = usableJson && json.case_number ? json.case_number : null;
    let resolve = { case_found: false, primary_contact_found: false, case_id: null };
    let caseId = null;
    if (docket) {
      const r = await resolveCase(db, docket);
      caseId = r.found ? r.case_id : null;
      resolve = {
        case_found: r.found,
        primary_contact_found: !!r.primary_contact_id,
        case_id: r.case_id,
        primary_contact_id: r.primary_contact_id,
      };
    }

    // Field agreement vs live cases row.
    const agreement = usableJson
      ? await fieldAgreement(json, caseId)
      : { case_file_date: 'no_json', case_trustee: 'no_json',
          case_objection: 'no_json', appt_date_vs_341_current: 'no_json' };

    const classification = usableJson ? (json.classification || null) : null;
    const needsReview = usableJson ? !!json.needs_review : null;

    perEmail.push({
      message_id: e.message_id,
      email_id: e.id,
      sample_category: e.sample_category,
      subject: e.subject,
      model: MODEL,
      classification,
      needs_review: needsReview,
      usable_json: usableJson,
      call_error: callResult.ok ? null : (callResult.error || null),
      citation_pass: citation.pass,
      citation_misses: citation.misses,
      resolve,
      field_agreement: agreement,
      cost_cents: costCents,
      latency_ms: meta.latency_ms,
      call_id: callResult.callId || null,
      raw_output: usableJson ? json : (callResult.output || null),
    });

    console.log(usableJson
      ? `${classification} cite=${citation.pass ? 'PASS' : 'miss'} case=${resolve.case_found ? 'Y' : 'N'}`
      : `UNUSABLE (${callResult.error || 'no_json'})`);
  }

  // ── Aggregates ──
  const n = perEmail.length;
  const usable = perEmail.filter((x) => x.usable_json);
  const nUsable = usable.length;

  const classCounts = tally(usable.map((x) => x.classification || 'null'));
  const citePass = usable.filter((x) => x.citation_pass).length;
  const caseResolved = usable.filter((x) => x.resolve.case_found).length;

  // Primary-contact resolve rate among 341s (create_appointment present).
  const appts = usable.filter((x) => firstApptDate(x.raw_output) != null);
  const apptCaseResolved = appts.filter((x) => x.resolve.case_found);
  const apptPrimaryResolved = appts.filter((x) => x.resolve.primary_contact_found).length;

  // Agreement tallies across the four scored dimensions.
  const agreementTallies = {};
  for (const dim of ['case_file_date', 'case_trustee', 'case_objection', 'appt_date_vs_341_current']) {
    agreementTallies[dim] = tally(usable.map((x) => x.field_agreement[dim]));
  }

  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  const aggregate = {
    source: SOURCE,
    mode: MODE,
    model: MODEL,
    sample_param: MODE === 'natural' ? { sampleSize: SAMPLE_SIZE } : { perCategory: PER_CATEGORY },
    sampled: n,
    sampled_subject_doctypes: tally(perEmail.map((x) => x.sample_category)),
    usable_json: { count: nUsable, rate_pct: pct(nUsable, n) },
    citation_pass: { count: citePass, of_usable: nUsable, rate_pct: pct(citePass, nUsable) },
    case_resolve: { count: caseResolved, of_usable: nUsable, rate_pct: pct(caseResolved, nUsable) },
    primary_contact_resolve_among_341s: {
      count: apptPrimaryResolved,
      of_341s: appts.length,
      case_found_341s: apptCaseResolved.length,
      rate_pct: pct(apptPrimaryResolved, appts.length),
    },
    // NOTE: model output distribution, NOT accuracy — these historical emails
    // have no gold-label class to score against.
    classification_counts: classCounts,
    needs_review_count: usable.filter((x) => x.needs_review).length,
    field_agreement: agreementTallies,
    total_cost_cents: Math.round(totalCostCents * 1000) / 1000,
    avg_latency_ms: avgLatency,
  };

  // ── Write report ──
  const report = {
    generated_at: new Date().toISOString(),
    args: { source: SOURCE, mode: MODE, model: MODEL, perCategory: PER_CATEGORY, sampleSize: SAMPLE_SIZE, out: OUT },
    aggregate,
    emails: perEmail,
  };
  const outPath = path.resolve(process.cwd(), OUT);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n========== AGGREGATE ==========');
  console.log(JSON.stringify(aggregate, null, 2));
  console.log(`\n[backtest] report written: ${outPath}`);
}

main()
  .then(() => db.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[backtest] FATAL:', err);
    try { await db.end(); } catch (_) {}
    process.exit(1);
  });