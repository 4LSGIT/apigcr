// lib/internal_functions/ai_match.js
//
// ai_match — generic AI extraction against a registry match set (Court Email
// Pipeline v2, stages 2–4). The workflow-authorable replacement for the
// monolithic court_extract step's EXTRACTION HALF only: it classifies +
// extracts + verifies, and returns structured matches. It NEVER resolves
// cases, reconciles prior items, or dispatches workflows — those are
// downstream steps (foreach over {{<output_var>.matches}} +
// evaluate_condition / start_workflow), which is the whole point: routing
// policy lives visibly in the workflow graph and the registry, not in code.
//
// NON-NEGOTIABLE PROPERTIES the workflow author CANNOT misconfigure:
//   1. INJECTION GUARD — subject and sender are attacker-influenceable, so
//      this function assembles "SUBJECT: …\nFROM: …\n\n<body>" ITSELF and
//      passes it as aiService userInput, which is wrapped in
//      <untrusted_user_input>. There is no param that reaches the trusted
//      system block except source_ref (our own id) and the registry-generated
//      prompt. This mirrors the security-critical convention court_extract
//      enforces across its three call sites (lib/aiPrompts/courtExtract.js v3
//      note) — kept identical here.
//   2. CITATION VERIFICATION always runs — per field, against exactly the
//      text the model saw (services/aiMatchService.validateMatches). Required
//      field fails → the match is flagged; optional field fails → the field
//      is dropped. No bypass param exists.
//   3. ai_calls LOGGING always happens — aiService.call logs every attempt
//      with cost, tagged consumer_ref `ai_match:<set_key>@v<version>:<ref>`.
//
// The author chooses THE MATCH SET (set_key) and WHAT TO DO WITH RESULTS
// (output_var + downstream steps). Nothing else.

const fns = {};

fns.ai_match = async (params, db) => {
    const aiMatchService = require('../../services/aiMatchService'); // lazy require (convention)
    const aiService      = require('../../services/aiService');      // lazy require (convention)

    const setKey = params.set_key != null ? String(params.set_key).trim() : '';
    if (!setKey) throw new Error('ai_match: set_key is required');

    const subject   = params.subject    != null ? String(params.subject)    : '';
    const fromEmail = params.from_email != null ? String(params.from_email) : '';
    const body      = params.body       != null ? String(params.body)       : '';
    if (!subject && !body) throw new Error('ai_match: at least one of subject/body is required');

    const sourceRef = params.source_ref != null && String(params.source_ref).trim() !== ''
      ? String(params.source_ref).trim()
      : 'unknown';

    const loaded = await aiMatchService.loadMatchSet(db, setKey);
    if (!loaded) throw new Error(`ai_match: match set "${setKey}" not found or inactive`);
    const { set, types, typesByKey } = loaded;
    if (!types.length) throw new Error(`ai_match: match set "${setKey}" has no active types`);

    // Registry-generated system prompt. Trusted content only.
    const systemText = aiMatchService.buildPrompt(set, types);

    // SECURITY: subject + sender ride INSIDE <untrusted_user_input> —
    // assembled here, not by the author. Identical to the court_extract
    // convention. This exact string is also the citation haystack, so the
    // model can only ever be held to text it was actually shown.
    const userInput = `SUBJECT: ${subject}\nFROM: ${fromEmail}\n\n${body}`;

    const model     = params.model != null && String(params.model).trim() !== ''
      ? String(params.model).trim() : 'claude-sonnet-4-6';
    const maxTokens = Number(params.max_tokens) > 0 ? Number(params.max_tokens) : 2000;

    const result = await aiService.call(db, {
      inlineSystem: systemText,
      vars:         { source_ref: sourceRef },
      userInput,
      model,
      max_tokens:   maxTokens,
      outputType:   'json',
      consumerRef:  `ai_match:${setKey}@v${set.version}:${sourceRef}`,
    });

    if (!result.ok || !result.json) {
      const detail = result.detail ? ` (${result.detail})` : '';
      throw new Error(`ai_match failed: ${result.error || 'no_json'}${detail} (ai_calls id ${result.callId ?? 'n/a'})`);
    }

    const validated = aiMatchService.validateMatches(result.json, typesByKey, userInput);

    const output = {
      set_key:      setKey,
      set_version:  set.version,
      source_ref:   sourceRef,
      ai_call_id:   result.callId ?? null,
      docket:       typeof result.json.docket    === 'string' ? result.json.docket    : null,
      case_name:    typeof result.json.case_name === 'string' ? result.json.case_name : null,
      matches:              validated.matches,
      flags:                validated.flags,
      dropped_fields:       validated.dropped_fields,
      unmatched_candidates: validated.unmatched_candidates,
      // convenience partitions for cheap workflow branching:
      match_count:   validated.matches.length,
      act_matches:   validated.matches.filter(m => m.disposition === 'act' && !m.flagged),
      flagged_count: validated.flags.length,
    };

    const setVars = {};
    if (params.output_var) setVars[String(params.output_var)] = output;

    console.log(
      `[AI_MATCH] set=${setKey}@v${set.version} ref=${sourceRef} ` +
      `matches=${output.match_count} act=${output.act_matches.length} flags=${output.flagged_count}`
    );

    return { success: true, output, set_vars: setVars };
  };

fns.ai_match.__meta = {
  category: 'ai',
  description: 'Match text (e.g. an email) against a registry match set (ai_match_sets/ai_match_types) and extract each matched type\'s declared fields with verbatim citations. The prompt is generated from the registry; the model can only emit keys from the closed list; citations are verified per field (required-field failure flags the match, optional-field failure drops the field). Foreign text always rides inside the injection guard and every attempt is logged to ai_calls. Returns {matches, act_matches, flags, unmatched_candidates}; route matches downstream with foreach + evaluate_condition/start_workflow — this step never dispatches anything itself.',
  params: [
    { name: 'set_key', type: 'string', required: true, placeholderAllowed: true,
      description: 'ai_match_sets.set_key to match against (e.g. "court_nef").',
      example: 'court_nef' },
    { name: 'subject', type: 'string', required: false, placeholderAllowed: true,
      description: 'Untrusted subject line. Rides inside the injection guard; part of the citation haystack.' },
    { name: 'from_email', type: 'string', required: false, placeholderAllowed: true,
      description: 'Untrusted sender. Rides inside the injection guard.' },
    { name: 'body', type: 'string', required: false, placeholderAllowed: true,
      description: 'Untrusted body text. Rides inside the injection guard; part of the citation haystack.' },
    { name: 'source_ref', type: 'string', required: false, placeholderAllowed: true,
      description: 'Our own reference id (e.g. message_id) — the only trusted metadata shown to the model; also stamped into ai_calls consumer_ref.' },
    { name: 'output_var', type: 'string', required: false,
      description: 'Also copy the full result into this named variable for later steps (foreach over {{var.matches}}).',
      example: 'court' },
    { name: 'model', type: 'string', required: false,
      description: 'Model override. Default claude-sonnet-4-6.' },
    { name: 'max_tokens', type: 'integer', required: false, min: 200, max: 8000,
      description: 'Response token cap. Default 2000.' },
  ],
  requiredWith: [['subject', 'body']],
  example: {
    set_key: 'court_nef',
    subject: '{{subject}}',
    from_email: '{{from_email}}',
    body: '{{body}}',
    source_ref: '{{message_id}}',
    output_var: 'court',
  }
};

module.exports = fns;