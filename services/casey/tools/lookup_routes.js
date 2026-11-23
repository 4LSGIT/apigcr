// lookup_routes — search the route catalog, judged for THIS user (Casey v2 S1,
// design §4.2–4.3). Reads lib/routeCatalog in-process: the catalog of the app
// serving this request. Key, portal and public rows are omitted — a staff
// JWT cannot call them at all (§8.1).
'use strict';

const catalog = require('../../../lib/routeCatalog');
const { CAPABILITIES, can, routeAllowed } = require('../../../lib/capabilities');
const { isSuperuser } = require('../../../lib/auth.superuser');

const MAX = 40;
const CASEY_CLASSES = new Set(['staff', 'staff:can', 'su']);

/** { allowed: true|false|null, reason } — may this identity call this row? null = depends on the request. */
function judge(row, auth) {
  if (!auth) return { allowed: false, reason: 'not signed in' };
  const key = auth.type === 'api_key';
  if (row.flags.includes('jwtOnly') && key) return { allowed: false, reason: 'needs a signed-in person, not a machine key' };
  // A SCOPED key reaches only the paths its route:/ scopes cover (jwtOrApiKey,
  // lib/capabilities.routeAllowed) — judged on the route pattern's prefix.
  if (key && auth.scopes != null && row.authClass !== 'staff:can' && !routeAllowed(auth, row.path)) return { allowed: false, reason: 'outside this key\'s route scopes' };
  if (row.authClass === 'su') {
    if (key) return { allowed: false, reason: 'superuser only; a machine key is never a superuser' };
    return isSuperuser(auth)
      ? { allowed: true, reason: row.elevation ? 'superuser; a live elevation (password prompt) is required at call time' : 'superuser (no elevation step on this route)' }
      : { allowed: false, reason: 'superuser only' };
  }
  if (row.authClass === 'staff:can') {
    if (row.can === 'dynamic') return { allowed: null, reason: 'the capability is chosen per request (the settings key or body scope)' };
    const held = Object.prototype.hasOwnProperty.call(CAPABILITIES, row.can) && can(auth, row.can);
    return held ? { allowed: true, reason: `holds ${row.can}` } : { allowed: false, reason: `needs ${row.can}` };
  }
  if (row.authClass === 'staff') return { allowed: true, reason: 'any staff identity' };
  return { allowed: false, reason: `${row.authClass} route — not reachable with a staff identity` };
}

module.exports = {
  name: 'lookup_routes',
  description: `Search the app's route catalog (every API route, its auth class, capability, sensitivity tier, whether it may be called/proposed) and learn whether the CURRENT user may call each one. Filters: q (substring of the path), family (e.g. /api/cases), method. Returns up to ${MAX} rows; only staff-reachable routes (staff, staff:can, su). Read the handler with read_source to learn its body and response.`,
  input_schema: {
    type: 'object',
    properties: {
      q: { type: 'string', maxLength: 120, description: 'Case-insensitive substring of the path, e.g. "appt" or "/api/tasks".' },
      family: { type: 'string', maxLength: 120, description: 'Exact route family, e.g. "/api/contacts".' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'Only this method.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX, description: `Max rows (default ${MAX}).` },
    },
    required: [],
  },
  untrusted: false,
  async run(ctx, input) {
    const cat = catalog.catalogFor(ctx.app);
    const needle = input.q ? String(input.q).toLowerCase() : null;
    const limit = input.limit || MAX;
    const all = cat.rows.filter((r) => CASEY_CLASSES.has(r.authClass)
      && (!needle || r.path.toLowerCase().includes(needle))
      && (!input.family || r.family === input.family)
      && (!input.method || r.method === input.method));
    const rows = all.slice(0, limit).map((r) => ({
      method: r.method, path: r.path, family: r.family,
      auth: r.authClass, capability: r.can, superuser_tool: r.suTool,
      tier: `T${r.tier}`, proposable: r.proposable, auto_get: r.autoGet,
      idempotent: !!r.idempotent, multipart: r.multipart,
      you: judge(r, ctx.auth),
    }));
    return { count: all.length, returned: rows.length, truncated: all.length > rows.length, rows };
  },
  judge,   // shared with api_write (S3b): the same verdict decides whether a step may go on a card for this user
};
