// lib/internal_functions/users.js
//
// USERS — staff-roster lookup for workflows, sequences, scheduled jobs, hook
// targets and the email/phone ingest action dispatchers.
//
//   lookup_user — resolve ONE user from a single free-text box.
//   list_users  — resolve MANY users by filter; returns an array for `foreach`.
//
// `users` is the FIRM STAFF table, not `contacts` (clients). Automation reaches
// it constantly by id — tasks.task_to, appts.appt_with, log.log_by,
// reports.created_by — but until now the only way to turn one of those ids into
// a name / email / phone inside a workflow was a hand-written query_db step.
// These two functions are that step, with the credential columns fenced off.
//
// ─────────────────────────────────────────────────────────────
// DESIGN NOTES
//
// 1. ONE INPUT BOX (lookup_user). `user` accepts an id, username, initials,
//    display name, first or last name, email or phone. `match` pins the
//    interpretation when a value is genuinely ambiguous; `auto` (the default)
//    walks the strategy tiers in AUTO_ORDER and stops at the FIRST tier that
//    produces a hit. Tiering — not a single OR'd query — is what keeps "SS"
//    from colliding with "Sandweiss": an exact-initials hit wins before fuzzy
//    name matching is ever consulted.
//
// 2. ALL ALLOWED FIELDS BY DEFAULT, with optional `fields` narrowing.
//    Consistent with lookup_contact / lookup_appointment, which both return
//    the whole row: unused keys cost nothing when the caller consumes
//    {{this.email}}. `fields` earns its keep on list_users, where the payload
//    is an array that gets serialized into workflow_execution_steps and, via
//    output_var, into workflow_executions.variables on every merge.
//
// 3. EXPLICIT SELECT LIST, never `SELECT *`. lookup_appointment can get away
//    with `SELECT *` because `appts` holds nothing secret. `users` holds
//    password_hash and reset_token, so the column list is a whitelist —
//    a sensitive column added to the table later cannot auto-leak into
//    workflow output, it has to be opted in here.
//
// 4. FETCH-ALL-THEN-FILTER-IN-JS. `users.user` is a tinyint PK, so the table is
//    hard-capped at 128 rows by the schema itself (9 today, and
//    routes/admin.users.js calls out the 127-id ceiling explicitly). One
//    unfiltered read with an explicit column list beats building either the
//    seven-way OR'd query lookup_user's tiering would need or the ten-way
//    dynamic WHERE list_users' filters would need, and it makes the ambiguity
//    and role-typo messages trivial to build.
//
// 5. LOUD ON AMBIGUITY (lookup_user). More than one match in the winning tier
//    throws and names the candidates. Same typo-protection philosophy as
//    get_settings' all-or-nothing: a silently-wrong user id causes subtler
//    downstream bugs (an SMS to the wrong staffer) than a failed step.
//    `missing_ok` softens NOT-FOUND only — never ambiguity, which is always a
//    config error.
//
// 6. list_users EXCLUDES DISABLED AND AUTOMATION USERS BY DEFAULT. See the
//    ACTIVE / AUTOMATION note above the filter helpers — this is the single
//    most consequential default in this file.

const fns = {};

// ─────────────────────────────────────────────────────────────
// Column policy — shared by both functions
// ─────────────────────────────────────────────────────────────

// NEVER returned, and never SELECTed. `password` / `password_hash` /
// `reset_token` / `reset_expires` are credential material (resolverService's
// BLOCKED_COLUMNS.users fences the first two off from the placeholder resolver
// for the same reason, and routes/api.firmData.js strips all four from
// /api/firm-data; this list is the same set). `user_custom_tab` is a per-user
// UI-state JSON blob with no automation value.
const BLOCKED_COLUMNS = Object.freeze([
  'password', 'password_hash', 'reset_token', 'reset_expires', 'user_custom_tab',
]);

// Returned by default, in this order.
//
// NOTE on the two email/phone pairs — they are NOT duplicates:
//   email / phone                 → the staffer's CONTACT address. What
//                                   job_executor.js, portalCallbackService.js
//                                   and run_task_digest notify.
//   default_email / default_phone → the staffer's preferred SENDING identity
//                                   (the Settings picker default, see
//                                   routes/auth.profile.js + communicate.html).
// Automation that notifies a user wants `email`/`phone`; automation that sends
// AS a user wants `default_email`/`default_phone`. Both are returned rather
// than collapsed into one "best" field, because collapsing them would silently
// pick the wrong semantic half the time.
const RETURNED_COLUMNS = Object.freeze([
  'user',              // PK (tinyint) — the id every other table FKs to
  'username',          // login handle
  'user_name',         // display name, NOT NULL
  'user_real_name',
  'user_fname',
  'user_lname',
  'user_initials',
  'user_type',         // 0 = the automations pseudo-user; truthy = real person
  'user_auth',         // 'authorized' | 'authorized - SU' | 'disabled'
  'roles',             // SET('it','admin','staff','attorney','automation') → csv string
  'email',
  'default_email',
  'phone',
  'default_phone',
  'allow_sms',
  'does_appts',
  'ringcentral',
  'task_remind_freq',
  'user_gcal_id',
  'freebusy_calendar_ids',
]);

// Computed, not columns. Cheap here and awkward everywhere else:
// workflow_engine.resolvePlaceholders has NO modifier syntax (that lives in
// resolverService, a different pipeline), so a workflow that wants a
// human-formatted phone in an SMS body has no other way to get one.
const DERIVED_FIELDS = Object.freeze([
  'phone_formatted',           // "(248) 559-2400" from `phone`
  'default_phone_formatted',   // ditto from `default_phone`
  'roles_list',                // roles csv → array, so `foreach` can walk it
]);

// Always present in output regardless of `fields`. Deliberately named so they
// cannot collide with a users column (every column is `user*`, `default_*`, or
// one of email/phone/roles/allow_sms/does_appts/ringcentral/task_remind_freq).
const META_KEYS = Object.freeze(['found', 'matched_by']);

const SELECTABLE = new Set([...RETURNED_COLUMNS, ...DERIVED_FIELDS]);

const SELECT_SQL =
  `SELECT ${RETURNED_COLUMNS.map(c => `\`${c}\``).join(', ')} FROM users`;

// Mirrors the column's SET definition. Used only for typo protection on the
// `role` filter, and UNIONed with the roles actually present in the fetched
// rows — so an ALTER TABLE that adds a role can never make this list wrongly
// reject a legitimate filter value.
const SCHEMA_ROLES = Object.freeze(['it', 'admin', 'staff', 'attorney', 'automation']);

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

function _norm(v) {
  return String(v == null ? '' : v).trim();
}

function _lc(v) {
  return _norm(v).toLowerCase();
}

/**
 * Normalize a phone string to 10 digits. Strips +1, dashes, parens, spaces.
 * Duplicated from services/contactService.js + services/contactPhoneService.js
 * intentionally — those two already duplicate each other on the stated ground
 * that each stays self-contained rather than cross-importing. Same behavior.
 */
function normalizePhone(phone) {
  if (!phone && phone !== 0) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** 10 digits → "(248) 559-2400". Anything else passes through (null stays null). */
function formatPhone(phone) {
  const d = normalizePhone(phone);
  if (d.length !== 10) return (phone == null || phone === '') ? null : String(phone);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Human label for ambiguity / not-found messages: "#22 Rena Grunberger (RENA)". */
function _label(u) {
  return `#${u.user} ${u.user_name || `${_norm(u.user_fname)} ${_norm(u.user_lname)}`.trim()}` +
         (u.username ? ` (${u.username})` : '');
}

/**
 * csv string OR array → trimmed, deduped, blank-dropped array. `null` when the
 * param was absent/empty. The array branch exists because a single-token
 * {{placeholder}} resolving to an array arrives AS an array (workflow_engine's
 * single-placeholder fast path) — the same dual-accept get_settings.keys does.
 */
function _csvList(v, fnName, label) {
  if (v == null || v === '') return null;
  let list = v;
  if (typeof list === 'string') list = list.split(',');
  if (typeof list === 'number') list = [list];
  if (!Array.isArray(list)) {
    throw new Error(`${fnName}: ${label} must be a comma-separated string or an array`);
  }
  list = [...new Set(
    list.map(x => (x == null ? '' : String(x).trim())).filter(Boolean)
  )];
  return list.length ? list : null;
}

/** csv/array of user ids → Set of Numbers. Throws on a non-numeric entry. */
function _idSet(v, fnName, label) {
  const list = _csvList(v, fnName, label);
  if (!list) return null;
  const bad = list.filter(x => !/^\d{1,3}$/.test(x));
  if (bad.length) {
    throw new Error(`${fnName}: ${label} must contain user ids (0–127), got: ${bad.join(', ')}`);
  }
  return new Set(list.map(Number));
}

/**
 * Tri-state boolean filter: null (absent → no filter), true, or false.
 * Lenient on string forms because a resolved {{placeholder}} always arrives as
 * a string — same reasoning as send_email.include_signature's coercion.
 */
function _triBool(params, name, fnName) {
  if (!(name in params)) return null;
  const v = params[name];
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number')  return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s))  return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  throw new Error(`${fnName}: ${name} must be a boolean (got "${v}")`);
}

/**
 * Validate + resolve the `fields` param. Returns the ordered list of keys to
 * project, defaulting to everything. Unknown names throw (typo protection);
 * the always-present META_KEYS get a targeted message rather than being
 * reported as unknown.
 */
function _resolveFields(raw, fnName) {
  const list = _csvList(raw, fnName, 'fields');
  if (!list) return [...RETURNED_COLUMNS, ...DERIVED_FIELDS];

  const always = list.filter(f => META_KEYS.includes(f));
  if (always.length) {
    throw new Error(
      `${fnName}: ${always.join(', ')} ${always.length > 1 ? 'are' : 'is'} always returned — ` +
      `remove ${always.length > 1 ? 'them' : 'it'} from fields`
    );
  }
  const unknown = list.filter(f => !SELECTABLE.has(f));
  if (unknown.length) {
    throw new Error(
      `${fnName}: unknown field(s): ${unknown.join(', ')}. Available: ${[...SELECTABLE].join(', ')}`
    );
  }
  return list;
}

/** roles csv → array. Shared by the roles_list derived field and the role filter. */
function _rolesOf(u) {
  const s = _norm(u.roles);
  return s ? s.split(',').map(r => r.trim().toLowerCase()).filter(Boolean) : [];
}

/** Project one row onto `selected`, computing the derived fields on demand. */
function _project(u, selected) {
  const out = {};
  for (const f of selected) {
    switch (f) {
      case 'phone_formatted':         out[f] = formatPhone(u.phone); break;
      case 'default_phone_formatted': out[f] = formatPhone(u.default_phone); break;
      case 'roles_list':              out[f] = _rolesOf(u); break;
      default:                        out[f] = u[f] === undefined ? null : u[f];
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// ACTIVE / AUTOMATION — the two defaults that matter most on list_users
//
// There is no DELETE for users. routes/admin.users.js is explicit: "'Removing'
// a user means disabling them" — POST /disable sets user_auth='disabled' and
// wipes the passwords, and routes/auth.login.js gates login on
// user_auth.startsWith('authorized'). So a list_users that did NOT filter on
// this by default would have every "email all staff" workflow quietly mailing
// ex-employees forever. active_only defaults TRUE and uses the same predicate
// as the login gate.
//
// user 0 is the `automations` pseudo-user (user_type = 0, roles = 'automation',
// email = admin@4lsg.com). public/index.html's task-assignee picker filters it
// out with `.filter(u => u.user_type)`; the same predicate is used here.
// include_automation defaults FALSE so "notify everyone" means people.
// ─────────────────────────────────────────────────────────────

function _isActive(u) {
  return _lc(u.user_auth).startsWith('authorized');
}

function _isHuman(u) {
  return Number(u.user_type) !== 0;
}

// ─────────────────────────────────────────────────────────────
// lookup_user — match strategies
//
// `applicable(raw)` — can this strategy even be tried on this input? Used two
//   ways: in auto mode it silently skips the tier; in explicit mode a false
//   here throws a precise "match=phone but … " error instead of a vague
//   "not found".
// `test(u, raw)` — does this user match?
// `why` — the message fragment used when an explicit match= is inapplicable.
// ─────────────────────────────────────────────────────────────

const STRATEGIES = {
  // users.user is tinyint (0..127), so an id is 1–3 digits. A 10-digit string
  // can therefore never be mistaken for an id, and vice versa.
  id: {
    why: 'a numeric user id (0–127)',
    applicable: raw => /^\d{1,3}$/.test(raw),
    test: (u, raw) => Number(u.user) === Number(raw),
  },
  email: {
    why: 'a value containing "@"',
    applicable: raw => raw.includes('@'),
    test: (u, raw) => {
      const v = raw.toLowerCase();
      return _lc(u.email) === v || _lc(u.default_email) === v;
    },
  },
  phone: {
    why: 'a value that normalizes to 10 digits',
    applicable: raw => normalizePhone(raw).length === 10,
    test: (u, raw) => {
      const v = normalizePhone(raw);
      return normalizePhone(u.phone) === v || normalizePhone(u.default_phone) === v;
    },
  },
  username: {
    why: 'a non-empty value',
    applicable: raw => raw.length > 0,
    test: (u, raw) => _lc(u.username) === raw.toLowerCase(),
  },
  initials: {
    why: 'a value of 1–3 characters',
    applicable: raw => raw.length > 0 && raw.length <= 3,
    test: (u, raw) => _lc(u.user_initials) === raw.toLowerCase(),
  },
  // Exact, case-insensitive, across every name column + "First Last".
  name: {
    why: 'a non-empty value',
    applicable: raw => raw.length > 0,
    test: (u, raw) => {
      const v = raw.toLowerCase();
      return [
        u.user_name,
        u.user_real_name,
        `${_norm(u.user_fname)} ${_norm(u.user_lname)}`,
        u.user_fname,
        u.user_lname,
      ].some(n => _lc(n) === v);
    },
  },
  // Last resort. Only reached in auto mode when every exact tier came up empty.
  // Requires >= 2 chars so a stray single letter can't match the whole roster.
  name_fuzzy: {
    why: 'a value of at least 2 characters',
    applicable: raw => raw.length >= 2,
    test: (u, raw) => {
      const v = raw.toLowerCase();
      return [
        u.user_name,
        u.user_real_name,
        `${_norm(u.user_fname)} ${_norm(u.user_lname)}`,
        u.username,
      ].some(n => _lc(n).includes(v));
    },
  },
};

// Order matters: most specific / least collidable first.
const AUTO_ORDER = Object.freeze([
  'id', 'email', 'phone', 'username', 'initials', 'name', 'name_fuzzy',
]);

// What a user-facing `match` value expands to internally. Only `name` expands
// (exact first, then fuzzy) — everything else is a single tier.
const MATCH_MODES = Object.freeze({
  auto:     AUTO_ORDER,
  id:       ['id'],
  username: ['username'],
  initials: ['initials'],
  name:     ['name', 'name_fuzzy'],
  email:    ['email'],
  phone:    ['phone'],
});

// ─────────────────────────────────────────────────────────────
// lookup_user
// ─────────────────────────────────────────────────────────────

/**
 * lookup_user
 * Resolve ONE staff user from a single free-text box and return their info.
 *
 * NOTE ON DISABLED USERS: unlike list_users, lookup_user does NOT filter on
 * user_auth. It answers "who is id 4?" — and the honest answer for a disabled
 * ex-employee is their row plus user_auth='disabled', not "not found". Callers
 * that must not act on a disabled user branch on {{this.user_auth}}.
 *
 * params:
 *   user        {string|number}  — id, username, initials, name, email or phone.
 *                                  Can be a {{placeholder}}. `0` is a real user
 *                                  (Automations), so falsiness is NOT emptiness.
 *   match       {string?}        — auto (default) | id | username | initials |
 *                                  name | email | phone
 *   fields      {string?}        — csv subset of the returned fields. Default:
 *                                  all. Unknown names throw (typo protection).
 *   missing_ok  {boolean?}       — default false. true → no match returns
 *                                  success with found:false instead of throwing.
 *                                  Ambiguity still throws either way.
 *   output_var  {string?}        — stash the whole map in this workflow variable.
 *
 * output (flat, so {{this.email}} works like lookup_contact):
 *   found        boolean
 *   matched_by   'id'|'email'|'phone'|'username'|'initials'|'name'|'name_fuzzy'|null
 *   …plus every field in `fields` (or all of them by default)
 *
 * example config:
 *   {
 *     "function_name": "lookup_user",
 *     "params": { "user": "{{task_to}}" },
 *     "set_vars": {
 *       "assigneeName":  "{{this.user_name}}",
 *       "assigneeEmail": "{{this.email}}",
 *       "assigneePhone": "{{this.phone}}"
 *     }
 *   }
 */

fns.lookup_user = async (params, db) => {
    const p = params || {};

    // `0` is user "Automations" — a real row. Emptiness must be tested on the
    // trimmed string, never on falsiness.
    const raw = _norm(p.user);
    if (raw === '') throw new Error('lookup_user requires user (id, username, initials, name, email or phone)');

    const match = _lc(p.match || 'auto');
    const tiers = MATCH_MODES[match];
    if (!tiers) {
      throw new Error(`lookup_user: match must be one of ${Object.keys(MATCH_MODES).join(', ')} (got "${match}")`);
    }

    const selected = _resolveFields(p.fields, 'lookup_user');

    // Explicit-mode inapplicability is a config error, not a miss.
    if (match !== 'auto' && !STRATEGIES[tiers[0]].applicable(raw)) {
      throw new Error(
        `lookup_user: match="${match}" requires ${STRATEGIES[tiers[0]].why}, got "${raw}"`
      );
    }

    // One bounded read (tinyint PK ⇒ ≤128 rows), explicit columns.
    const [rows] = await db.query(SELECT_SQL);

    // Walk the tiers; first tier with any hit wins.
    let matched_by = null;
    let hits = [];
    for (const tier of tiers) {
      const s = STRATEGIES[tier];
      if (!s.applicable(raw)) continue;
      const found = rows.filter(u => s.test(u, raw));
      if (found.length) { matched_by = tier; hits = found; break; }
    }

    // Ambiguity: always loud, even under missing_ok.
    if (hits.length > 1) {
      const shown = hits.slice(0, 10).map(_label).join(', ');
      const more  = hits.length > 10 ? `, +${hits.length - 10} more` : '';
      throw new Error(
        `lookup_user: "${raw}" matched ${hits.length} users by ${matched_by} (${shown}${more}). ` +
        `Use a more specific value, or set match to pin the lookup type.`
      );
    }

    const set_vars = {};

    if (!hits.length) {
      if (!p.missing_ok) {
        throw new Error(`lookup_user: no user matched "${raw}"${match === 'auto' ? '' : ` by ${match}`}`);
      }
      console.log(`[LOOKUP_USER] "${raw}" → no match (missing_ok)`);
      // Same key set as a hit, all null — a stable output shape means a
      // downstream {{this.email}} / {{var.email}} resolves identically whether
      // or not the lookup landed, instead of the key silently not existing.
      const output = { found: false, matched_by: null };
      for (const f of selected) output[f] = null;
      if (p.output_var) set_vars[p.output_var] = output;
      return { success: true, output, set_vars };
    }

    const u = hits[0];
    const output = { found: true, matched_by, ..._project(u, selected) };

    console.log(`[LOOKUP_USER] "${raw}" → ${_label(u)} (by ${matched_by})`);

    if (p.output_var) set_vars[p.output_var] = output;
    return { success: true, output, set_vars };
  };

fns.lookup_user.__meta = {
  category: 'users',
  description:
    'Look up one staff user by id, username, initials, name, email or phone — one input box, ' +
    'auto-detected. Returns their full (non-credential) record flat, so {{this.email}} / ' +
    '{{this.user_name}} / {{this.phone}} work directly. Throws if the value matches more than one user.',
  params: [
    { name: 'user', type: 'string', required: true, placeholderAllowed: true,
      description:
        'The one box: a user id (users.user), username, initials, display/first/last name, ' +
        'email (email or default_email) or phone (phone or default_phone, any format). ' +
        'Note 0 is a valid id (Automations).',
      example: '{{task_to}}' },

    { name: 'match', type: 'enum', required: false, default: 'auto',
      enum: ['auto', 'id', 'username', 'initials', 'name', 'email', 'phone'],
      description:
        'Pin how `user` is interpreted. auto tries id → email → phone → username → initials → ' +
        'exact name → fuzzy name and stops at the first tier that hits. Set this when a value ' +
        'could be read two ways, or to fail fast on bad input.',
      example: 'id' },

    { name: 'fields', type: 'string', required: false, placeholderAllowed: true, strictString: true,
      description:
        'Comma-separated subset of fields to return. Default returns all of them. found and ' +
        'matched_by are always included. Unknown names throw. Available: ' +
        [...SELECTABLE].join(', ') + '.',
      example: 'user_name, email, phone_formatted' },

    { name: 'missing_ok', type: 'boolean', required: false, default: false,
      description:
        'false (default) throws when nothing matches. true returns success with found:false so a ' +
        'later step can branch on it. Ambiguous matches throw either way — that is always a config error.' },

    { name: 'output_var', type: 'string', required: false,
      description: 'Also store the whole map in this workflow variable; fields are then {{var.email}} etc.',
      example: 'assignee' },
  ],
  example: { user: '{{task_to}}' },
};

// ─────────────────────────────────────────────────────────────
// list_users
// ─────────────────────────────────────────────────────────────

const SORT_KEYS = Object.freeze({
  user_name:     u => _lc(u.user_name),
  user_lname:    u => _lc(u.user_lname),
  user_initials: u => _lc(u.user_initials),
  user:          u => Number(u.user),
});

/**
 * list_users
 * Return the staff users matching a filter set, as an ARRAY built for `foreach`.
 *
 * Complements lookup_user (exactly one) with the fan-out case: "notify every
 * attorney", "assign round-robin across whoever does appointments", "SMS
 * everyone who opted in".
 *
 * DEFAULTS THAT MATTER — see the ACTIVE / AUTOMATION note above:
 *   active_only        true  → drops user_auth='disabled' (how the firm removes
 *                              people; there is no DELETE for users)
 *   include_automation false → drops user 0, the automations pseudo-user
 *
 * params:
 *   role               {string?}  — csv of roles (it, admin, staff, attorney,
 *                                   automation). See role_match.
 *   role_match         {string?}  — 'any' (default) | 'all'
 *   does_appts         {boolean?} — tri-state; omit for no filter
 *   allow_sms          {boolean?} — tri-state
 *   ringcentral        {boolean?} — tri-state
 *   has_email          {boolean?} — tri-state, on the CONTACT column `email`
 *   has_phone          {boolean?} — tri-state, on the CONTACT column `phone`
 *   ids                {string?}  — csv/array of user ids to restrict to
 *   exclude            {string?}  — csv/array of user ids to drop
 *   active_only        {boolean?} — default true
 *   include_automation {boolean?} — default false
 *   sort               {string?}  — user_name (default) | user_lname |
 *                                   user_initials | user
 *   fields             {string?}  — csv subset per user. Default: all.
 *   require_any        {boolean?} — default false. true → throw when nothing matched.
 *   output_var         {string?}  — stash the users ARRAY in this variable
 *   count_var          {string?}  — stash the count in this variable
 *
 * output:
 *   users       array   — the foreach target; each entry is a projected user map
 *   count       number
 *   has_users   boolean
 *   ids         number[] — every matched user id
 *   emails      string[] — non-empty `email` values, deduped, in sort order
 *   emails_csv  string   — the above joined with ", "
 *   phones      string[] — non-empty `phone` values, normalized to 10 digits
 *
 * ids / emails / phones are built from the FULL rows, so they stay populated
 * even when `fields` narrows the per-user maps down to something that excludes
 * those columns.
 *
 * example config (fan out over attorneys):
 *   step 3: {
 *     "function_name": "list_users",
 *     "params": { "role": "attorney", "has_email": true },
 *     "set_vars": { "attorneys": "{{this.users}}" }
 *   }
 *   step 4: {
 *     "function_name": "foreach",
 *     "params": { "list": "{{attorneys}}", "item_var": "atty", "end_step": 7 }
 *   }
 *   step 5: send_email to "{{atty.email}}"
 *   step 6: set_next back to 4
 */

fns.list_users = async (params, db) => {
    const p = params || {};
    const FN = 'list_users';

    const sort = _lc(p.sort || 'user_name');
    if (!SORT_KEYS[sort]) {
      throw new Error(`${FN}: sort must be one of ${Object.keys(SORT_KEYS).join(', ')} (got "${sort}")`);
    }

    const roleMatch = _lc(p.role_match || 'any');
    if (roleMatch !== 'any' && roleMatch !== 'all') {
      throw new Error(`${FN}: role_match must be any or all (got "${roleMatch}")`);
    }

    const selected   = _resolveFields(p.fields, FN);
    const wantRoles  = (_csvList(p.role, FN, 'role') || []).map(r => r.toLowerCase());
    const onlyIds    = _idSet(p.ids, FN, 'ids');
    const excludeIds = _idSet(p.exclude, FN, 'exclude');

    const fDoesAppts  = _triBool(p, 'does_appts',  FN);
    const fAllowSms   = _triBool(p, 'allow_sms',   FN);
    const fRingcentral= _triBool(p, 'ringcentral', FN);
    const fHasEmail   = _triBool(p, 'has_email',   FN);
    const fHasPhone   = _triBool(p, 'has_phone',   FN);

    // Both default ON-the-safe-side; see the ACTIVE / AUTOMATION note.
    //
    // IMPLICATION: naming 'automation' in the `role` filter turns
    // include_automation on, because otherwise that filter is self-contradictory
    // and returns a guaranteed-empty list. An explicit include_automation always
    // wins over the implication.
    //
    // `ids` gets NO such implication, deliberately. A role filter is hand-written
    // by the workflow author, so role='automation' is unambiguously on purpose. An
    // `ids` list is usually machine-generated (e.g. SELECT DISTINCT log_by), and
    // user 0 shows up in those constantly — auto-including it there would
    // reintroduce exactly the "notify everyone who touched this case → emails
    // admin@4lsg.com" bug the default exists to prevent. Pass
    // include_automation: true if you really want the system account.
    const activeOnly = _triBool(p, 'active_only', FN) ?? true;
    const includeAutomation =
      _triBool(p, 'include_automation', FN) ?? wantRoles.includes('automation');

    // One bounded read (tinyint PK ⇒ ≤128 rows), explicit columns.
    const [rows] = await db.query(SELECT_SQL);

    // Role typo protection. Valid = the column's SET ∪ whatever the data
    // actually carries, so an ALTER that adds a role can never make a
    // legitimate filter value get rejected here.
    if (wantRoles.length) {
      const known = new Set(SCHEMA_ROLES);
      for (const u of rows) for (const r of _rolesOf(u)) known.add(r);
      const bad = wantRoles.filter(r => !known.has(r));
      if (bad.length) {
        throw new Error(
          `${FN}: unknown role(s): ${bad.join(', ')}. Available: ${[...known].sort().join(', ')}`
        );
      }
    }

    let matched = rows.filter(u => {
      if (activeOnly        && !_isActive(u)) return false;
      if (!includeAutomation && !_isHuman(u)) return false;
      if (onlyIds    && !onlyIds.has(Number(u.user))) return false;
      if (excludeIds &&  excludeIds.has(Number(u.user))) return false;

      if (wantRoles.length) {
        const has = new Set(_rolesOf(u));
        const ok = roleMatch === 'all'
          ? wantRoles.every(r => has.has(r))
          : wantRoles.some(r => has.has(r));
        if (!ok) return false;
      }

      if (fDoesAppts   !== null && Boolean(Number(u.does_appts))  !== fDoesAppts)   return false;
      if (fAllowSms    !== null && Boolean(Number(u.allow_sms))   !== fAllowSms)    return false;
      if (fRingcentral !== null && Boolean(Number(u.ringcentral)) !== fRingcentral) return false;
      if (fHasEmail    !== null && (_norm(u.email) !== '')        !== fHasEmail)    return false;
      if (fHasPhone    !== null && (normalizePhone(u.phone).length === 10) !== fHasPhone) return false;

      return true;
    });

    const keyOf = SORT_KEYS[sort];
    matched = matched.sort((a, b) => {
      const ka = keyOf(a), kb = keyOf(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return Number(a.user) - Number(b.user);   // stable tiebreak
    });

    const count = matched.length;
    if (!count && p.require_any) {
      throw new Error(`${FN}: no users matched the filters (require_any is set)`);
    }

    // Built from the FULL rows on purpose — `fields` narrows the per-user maps,
    // not these roll-ups.
    const emails = [...new Set(matched.map(u => _norm(u.email)).filter(Boolean))];
    const phones = [...new Set(matched.map(u => normalizePhone(u.phone)).filter(d => d.length === 10))];

    const output = {
      users: matched.map(u => _project(u, selected)),
      count,
      has_users: count > 0,
      ids: matched.map(u => Number(u.user)),
      emails,
      emails_csv: emails.join(', '),
      phones,
    };

    console.log(
      `[LIST_USERS] ${count} user(s)` +
      (wantRoles.length ? ` role=${wantRoles.join('|')}(${roleMatch})` : '') +
      ` active_only=${activeOnly} automation=${includeAutomation} → ${output.ids.join(',') || '—'}`
    );

    const set_vars = {};
    if (p.output_var) set_vars[p.output_var] = output.users;   // the ARRAY — feed straight to foreach
    if (p.count_var)  set_vars[p.count_var]  = count;

    return { success: true, output, set_vars };
  };

fns.list_users.__meta = {
  category: 'users',
  description:
    'List staff users matching a filter (role, does_appts, allow_sms, has_email, …). Returns an ' +
    'ARRAY built to feed straight into foreach, plus ids / emails / emails_csv / phones roll-ups. ' +
    'Excludes disabled users and the automations pseudo-user by default.',
  params: [
    { name: 'role', type: 'string', required: false, placeholderAllowed: true, strictString: true,
      description:
        'Comma-separated roles to filter on: it, admin, staff, attorney, automation. ' +
        'Unknown role names throw. Omit for no role filter.',
      example: 'attorney' },

    { name: 'role_match', type: 'enum', required: false, default: 'any', enum: ['any', 'all'],
      description: 'any (default) = has at least one of the listed roles. all = has every one of them.' },

    { name: 'does_appts', type: 'boolean', required: false,
      description: 'Filter on users.does_appts. Omit for no filter.' },
    { name: 'allow_sms', type: 'boolean', required: false,
      description: 'Filter on users.allow_sms — who has opted in to SMS. Omit for no filter.' },
    { name: 'ringcentral', type: 'boolean', required: false,
      description: 'Filter on users.ringcentral. Omit for no filter.' },

    { name: 'has_email', type: 'boolean', required: false,
      description:
        'true = only users with a non-empty `email`. Checks the CONTACT column (what notifications ' +
        'go to), not default_email (the sending identity).' },
    { name: 'has_phone', type: 'boolean', required: false,
      description:
        'true = only users whose `phone` normalizes to 10 digits. Checks the CONTACT column, not ' +
        'default_phone.' },

    // No strictString on these two, unlike `role` / `fields`: a BARE NUMBER is a
    // legitimate single-id value here ({exclude: 6}), and _csvList handles it at
    // run time. strictString would 400 that at save for no reason. A number is
    // meaningless for role/fields, so those keep the flag.
    { name: 'ids', type: 'string', required: false, placeholderAllowed: true,
      description:
        'Comma-separated user ids to restrict the result to — hydrate a list of ids from an earlier ' +
        'step in one call. A bare number works for a single id; a placeholder resolving to an array ' +
        'also works.',
      example: '1, 6, 22' },
    { name: 'exclude', type: 'string', required: false, placeholderAllowed: true,
      description: 'Comma-separated user ids to drop (e.g. don\'t notify whoever triggered the run).',
      example: '{{trigger.user_id}}' },

    { name: 'active_only', type: 'boolean', required: false, default: true,
      description:
        'true (default) drops user_auth=\'disabled\'. Disabling IS how the firm removes a user — ' +
        'there is no DELETE — so turning this off will mail ex-employees.' },
    { name: 'include_automation', type: 'boolean', required: false, default: false,
      description:
        'false (default) drops user 0, the automations pseudo-user (user_type = 0). Naming ' +
        '"automation" in `role` turns this on implicitly (that filter is otherwise guaranteed ' +
        'empty); setting it explicitly always wins. `ids` does NOT imply it — those lists are ' +
        'usually machine-generated and user 0 appears in them constantly.' },

    { name: 'sort', type: 'enum', required: false, default: 'user_name',
      enum: ['user_name', 'user_lname', 'user_initials', 'user'],
      description: 'Sort order. Ties break on user id, so the order is stable run to run.' },

    { name: 'fields', type: 'string', required: false, placeholderAllowed: true, strictString: true,
      description:
        'Comma-separated subset of fields per user. Default returns all of them. Narrowing matters ' +
        'here — the array is serialized into workflow_execution_steps and, via output_var, into the ' +
        'execution variables on every merge. ids / emails / phones are unaffected. Available: ' +
        [...SELECTABLE].join(', ') + '.',
      example: 'user, user_name, email' },

    { name: 'require_any', type: 'boolean', required: false, default: false,
      description:
        'false (default) returns an empty list when nothing matched — branch on {{this.has_users}}. ' +
        'true throws instead, for filters that should never legitimately be empty.' },

    { name: 'output_var', type: 'string', required: false,
      description: 'Store the users ARRAY in this variable — feed it straight to foreach\'s list.',
      example: 'attorneys' },
    { name: 'count_var', type: 'string', required: false,
      description: 'Store the match count in this variable.',
      example: 'attorneyCount' },
  ],
  example: { role: 'attorney', has_email: true, output_var: 'attorneys' },
};

// Exported for tests / documentation generators. `__`-prefixed keys are
// filtered from the UI function lists by the same rule that hides
// __getAllMeta et al (routes/workflows.js), so these never reach a picker.
fns.__USER_RETURNED_COLUMNS = RETURNED_COLUMNS;
fns.__USER_DERIVED_FIELDS   = DERIVED_FIELDS;
fns.__USER_BLOCKED_COLUMNS  = BLOCKED_COLUMNS;
fns.__USER_META_KEYS        = META_KEYS;

module.exports = fns;