// services/casey/tools/index.js — Casey v2 S1: the tool layer's registry.
//
// Design: ref/CASEY_V2_DESIGN.md §4.1–4.2, §8.4–8.5; as built: §9.
//
// Eight plain functions `run(ctx, input) → data`, each described once with a
// JSON-schema `input_schema`, so the in-app loop (S2) and the MCP server (S5)
// expose the same tools unchanged. Nothing here calls a model. S3b adds
// api_write, which stores a CARD instead of acting (services/casey/cards.js);
// the loop hands it ctx.card = { chatId, toolUseId }.
//
//   ctx = { db, auth, app, headers, ip, port, via, now?, sourceRoot?, fetch? }
//     db       the main pool (report_runs logging only — sql_read reads on the
//              yc_report pool, never on db)
//     auth     req.auth as lib/auth.jwtOrApiKey built it — the identity every
//              tool runs AS. There is no service identity.
//     app      the express app (req.app) — the route catalog of THIS process
//     headers  the caller's request headers (Authorization is forwarded by
//              api_get; X-SU-Elevation is READ by whoami, never forwarded in S1)
//     ip       the caller's client IP (req.ip, trust proxy on)
//     port     the port this process listens on (server.js: PORT || 8080)
//     via      a short marker for the X-Casey-Via header ('tool-test' in S1)
//   ctxFromRequest(req, via) builds it.
//
// runTool(name, ctx, input) → the ENVELOPE every caller sees:
//   { ok: true,  tool, data, bytes, truncated, untrusted, ms }
//   { ok: false, tool, error: { code, message, ...detail }, ms }
// Input is checked against the schema first (type, required, unknown keys,
// enum, string / integer bounds, arrays with `items` and bounds, nested
// objects with `properties` — a small checker, not a JSON-schema engine: the
// schemas here use only what it supports and tests/caseyTools.test.js pins
// that). A result larger than RESULT_CAP bytes (serialised) is handed
// back as a TRUNCATED STRING with a marker, never a silently shortened
// array — the model sees that it is partial. `untrusted: true` on every
// result that carries record, file or doc content: a prompt-injection flag
// for S2's system prompt (data, not instructions).
//
// Tools throw ToolError(code, message, detail) for an expected refusal; any
// other throw is 'TOOL_FAILED' with the message (no stack to the model).

'use strict';

const RESULT_CAP = 60 * 1024;

const { ToolError } = require('./index_error');

const TOOLS = Object.freeze([
  require('./whoami'),
  require('./sql_read'),
  require('./api_get'),
  require('./lookup_routes'),
  require('./read_source'),
  require('./search_docs'),
  require('./api_write'),
  require('./flag_for_review'),   // S4b: files THIS chat for review, as the user, through the real report route
]);
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** [{ name, description, input_schema }] — what a model or an MCP client is shown. */
function definitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

// ── input checking ──────────────────────────────────────────────────────────
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function checkValue(schema, v, at) {
  const t = typeOf(v);
  const want = schema.type;
  const okType = want === 'number' ? (t === 'number' || t === 'integer') : t === want;
  if (!okType) return `${at} must be ${want}, got ${t}`;
  if (schema.enum && !schema.enum.includes(v)) return `${at} must be one of ${schema.enum.join(', ')}`;
  if (want === 'string') {
    if (schema.minLength != null && v.length < schema.minLength) return `${at} is too short`;
    if (schema.maxLength != null && v.length > schema.maxLength) return `${at} is longer than ${schema.maxLength}`;
  }
  if (want === 'integer' || want === 'number') {
    if (schema.minimum != null && v < schema.minimum) return `${at} must be >= ${schema.minimum}`;
    if (schema.maximum != null && v > schema.maximum) return `${at} must be <= ${schema.maximum}`;
  }
  if (want === 'object' && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    for (const [k, inner] of Object.entries(v)) {
      const e = checkValue(schema.additionalProperties, inner, `${at}.${k}`);
      if (e) return e;
    }
  }
  if (want === 'object' && schema.properties) {
    const e = checkInput(schema, v);            // a nested object: its own keys, required and types
    if (e) return `${at}: ${e}`;
  }
  if (want === 'array') {
    if (schema.minItems != null && v.length < schema.minItems) return `${at} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`;
    if (schema.maxItems != null && v.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < v.length; i++) {
        const e = checkValue(schema.items, v[i], `${at}[${i}]`);
        if (e) return e;
      }
    }
  }
  return null;
}

/** null when `input` satisfies `schema`, else the first problem as text. */
function checkInput(schema, input) {
  if (input === undefined || input === null) input = {};
  if (typeOf(input) !== 'object') return 'input must be an object';
  const props = schema.properties || {};
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) return `unknown input key: ${k}`;
  }
  for (const k of schema.required || []) {
    if (input[k] === undefined) return `missing required input: ${k}`;
  }
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    const e = checkValue(props[k], v, k);
    if (e) return e;
  }
  return null;
}

// ── envelope ────────────────────────────────────────────────────────────────
function envelope(tool, data, untrusted, ms) {
  let text;
  try { text = JSON.stringify(data); } catch (e) { text = JSON.stringify(String(data)); }
  if (text === undefined) text = 'null';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= RESULT_CAP) return { ok: true, tool, data, bytes, truncated: false, untrusted: !!untrusted, ms };
  // Cut on BYTES (the cap is bytes): a Buffer slice, with a split multi-byte
  // character at the cut dropped rather than emitted as U+FFFD.
  const head = Buffer.from(text, 'utf8').subarray(0, RESULT_CAP).toString('utf8').replace(/\uFFFD+$/, '');
  return {
    ok: true, tool,
    data: `${head}\n…[truncated: ${bytes} bytes serialised, cap ${RESULT_CAP}; narrow the request]`,
    bytes, truncated: true, untrusted: !!untrusted, ms,
  };
}

/**
 * runTool(name, ctx, input) → envelope. Never throws for a known tool: a
 * refusal or failure is an ok:false envelope. An unknown name is ok:false
 * UNKNOWN_TOOL (the route turns that into a 404).
 */
async function runTool(name, ctx, input) {
  const started = Date.now();
  const tool = BY_NAME.get(String(name));
  if (!tool) return { ok: false, tool: String(name), error: { code: 'UNKNOWN_TOOL', message: `no tool named ${JSON.stringify(String(name))}` }, ms: 0 };
  const bad = checkInput(tool.input_schema, input);
  if (bad) return { ok: false, tool: tool.name, error: { code: 'BAD_INPUT', message: bad }, ms: Date.now() - started };
  try {
    const data = await tool.run(ctx, input || {});
    return envelope(tool.name, data, tool.untrusted, Date.now() - started);
  } catch (e) {
    if (e instanceof ToolError) {
      return { ok: false, tool: tool.name, error: { code: e.code, message: e.message, ...(e.detail || {}) }, ms: Date.now() - started };
    }
    return { ok: false, tool: tool.name, error: { code: 'TOOL_FAILED', message: String(e && e.message || e) }, ms: Date.now() - started };
  }
}

/** The ctx for a tool run on behalf of the request's own caller. */
function ctxFromRequest(req, via = 'tool-test') {
  return {
    db: req.db,
    auth: req.auth,
    app: req.app,
    headers: req.headers || {},
    ip: req.ip || null,
    port: Number(process.env.PORT) || 8080,   // server.js: `process.env.PORT || 8080`
    via,
  };
}

module.exports = { TOOLS, RESULT_CAP, ToolError, definitions, checkInput, runTool, ctxFromRequest, envelope };
