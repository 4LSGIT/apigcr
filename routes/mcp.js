// routes/mcp.js — Casey v2 S5a: the MCP server (ref/CASEY_V2_DESIGN.md §4.9; as
// built §9 S5a). Auto-mounts (routes/).
//
//   POST /mcp   Streamable HTTP, JSON-RPC (initialize, tools/list, tools/call)
//   GET  /mcp   405 — no server-to-client stream: the server is STATELESS
//   DELETE /mcp 405 — no session to end
//
// IDENTITY: a SESSION KEY (ycro_) in X-Readonly-Api-Key — lib/auth.readonly's
// readonlyApiKeyAuth, exactly as the readonly routes (expiry, revocation, the
// parent cascade, the audit of a refused key); the catalog classifies the
// route as class `key`. The tools a key sees and may call follow its SCOPES
// (services/mcp/tools.js). No JWT ever rides here (the shell's JWT rides only
// apiSend); a machine key (yck_) is not a session identity and is refused.
// Claude Code: claude mcp add --transport http yisracase https://app.4lsg.com/mcp
//              --header "X-Readonly-Api-Key: ycro_…"
//
// STATELESS: a fresh Server + transport per request, no session id, JSON
// answers (no SSE), so Cloud Run's many instances share nothing. The body is
// the app's global JSON parser's (server.js, 10 MB) — a per-route parser
// would be an unclassifiable middleware to lib/routeCatalog. 60 requests a
// minute per key (lib/rateLimiter, in-process like every limiter here).
//
// A tool refusal is a CallToolResult with isError (the route's message), not a
// JSON-RPC error; an unknown method is the SDK's -32601. The S5b staff
// identity (api_get / api_write / flag_for_review as a person) is not here.
'use strict';

const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { readonlyApiKeyAuth } = require('../lib/auth.readonly');
const { makeLimiter } = require('../lib/rateLimiter');
const { keyAllows } = require('../lib/capabilities');
const appBuild = require('../lib/appBuild');
const mcpTools = require('../services/mcp/tools');

const router = express.Router();
const SERVER_INFO = Object.freeze({ name: 'yisracase', version: '0.5.0' });
const limited = makeLimiter(60 * 1000, 60);

/**
 * A readonly_query_log row for an IN-PROCESS tool (the review reads): the same columns the readonly
 * route's logQuery writes (routes/api.readonly.js) — api_key_id, ip, user_agent, sql_text, params_json,
 * row_count, duration_ms, status, sensitive_key, error_text; proven against the real table by
 * tests/mcpAudit.mysql.test.js (review r1: the first draft named columns the table does not have, and a
 * stub hid it). It THROWS on failure: the caller fails closed — the only audit of reading another
 * user's chat must exist before the chat is handed over.
 */
async function logTool(req, { tool, params, status = 'success', rowCount = null, durationMs = 0, error = null }) {
  await req.db.query(
    `INSERT INTO readonly_query_log
       (api_key_id, ip, user_agent, sql_text, params_json, row_count, duration_ms, status, sensitive_key, error_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.auth.keyId, req.ip || null, String(req.headers['user-agent'] || 'unknown').slice(0, 512), `mcp ${tool}`, JSON.stringify(params || {}),
      rowCount, durationMs, status, keyAllows(req.auth, 'sql.ro.sensitive') ? 1 : 0, error == null ? null : String(error).slice(0, 2000)]);
}

function toolCtx(req) {
  return {
    db: req.db, app: req.app, auth: req.auth, rawKey: req.get('x-readonly-api-key'), ip: req.ip || null,
    headers: req.headers || {}, port: Number(process.env.PORT) || 8080, via: 'mcp',
    build: { build: appBuild.build, revision: appBuild.revision, started_at: appBuild.startedAt },   // in-process: no loopback to the public route with the key header
    log: (entry) => logTool(req, entry),
  };
}

router.post("/mcp", readonlyApiKeyAuth, async (req, res) => {
  if (limited(`k:${req.auth.rootKeyId ?? req.auth.keyId}`)) return res.status(429).json({ error: 'Too many MCP requests — 60 a minute per key' });
  // A JSON-RPC BATCH (an array body) would run up to 100 calls at once past the limiter (review r1 S1); protocol
  // 2025-06-18 dropped batching and Claude Code sends none. One message per request.
  if (Array.isArray(req.body)) return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'One JSON-RPC message per request — batches are not accepted' }, id: null });
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools.definitionsFor(req.auth) }));
  server.setRequestHandler(CallToolRequestSchema, async (r) => mcpTools.callFor(req.auth, toolCtx(req), r.params.name, r.params.arguments));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request error:', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});
router.get("/mcp", readonlyApiKeyAuth, (req, res) => { res.set('Allow', 'POST'); res.status(405).json({ error: 'The MCP server is stateless: no server stream to open. POST JSON-RPC to /mcp.' }); });
router.delete("/mcp", readonlyApiKeyAuth, (req, res) => { res.set('Allow', 'POST'); res.status(405).json({ error: 'The MCP server is stateless: no session to end.' }); });

module.exports = router;
module.exports.logTool = logTool;   // tests/mcpAudit.mysql.test.js runs it against the real readonly_query_log
