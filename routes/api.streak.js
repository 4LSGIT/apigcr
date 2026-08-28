// routes/api.streak.js
//
/**
 * YisraStreak — daily-habit accountability boards.
 * routes/api.streak.js
 *
 * Deliberately standalone. Touches only `streak_boards` and `streak_checkins`
 * (ref/streak-schema.sql). Does not read or write any YisraCase table, does not
 * use the app JWT, and can be deleted wholesale without consequence.
 *
 * ── AUTH ────────────────────────────────────────────────────────────────────
 * Two credentials, both re-verified on EVERY request. No sessions, no cookies.
 * This is deliberate light auth, not security — it keeps honest people honest
 * and keeps a random URL-guesser out. Do not put anything sensitive on a board.
 *
 *   Member  →  X-Streak-Auth : base64("username:password")
 *              bcrypt-compared against the board's own member list.
 *
 *   Admin   →  X-Streak-Admin: base64("password")
 *              compared against env STREAK_ADMIN_PASSWORD. If that env var is
 *              unset, every admin endpoint returns 503 (fail closed).
 *
 * A custom header (not `Authorization: Basic`) so the browser never raises its
 * native credential dialog on a 401. base64 so a non-ASCII password survives
 * the ISO-8859-1 header transport.
 *
 * ── DATE HANDLING ───────────────────────────────────────────────────────────
 * A board has a `tz`. That tz is used for exactly one thing: deciding which ISO
 * date string "today" is. Every calculation after that — streak walks, the day
 * grid, the backfill window — is pure calendar arithmetic on `YYYY-MM-DD`
 * strings done in UTC, where there is no DST and a day is always a day.
 *
 * All DATE columns are read back with DATE_FORMAT so mysql2 hands us strings,
 * not Date objects. No driver-timezone subtleties anywhere in this file.
 *
 * ── STREAK SEMANTICS ────────────────────────────────────────────────────────
 * The current streak survives today until midnight: it counts back from today
 * if today is ticked, else from yesterday if yesterday is ticked, else it's 0.
 * So you don't watch your streak read "0" all morning before you've done it.
 *
 * ── ROUTES ──────────────────────────────────────────────────────────────────
 *   GET    /api/streak/meta/:slug              public   board title + who's on it (for the login screen)
 *   POST   /api/streak/auth/:slug              member   credential check (login screen)
 *   GET    /api/streak/board/:slug             member   full board state + day grid + last 50 messages
 *   POST   /api/streak/board/:slug/checkin     member   tick a day for YOURSELF   { date?, note? }
 *   DELETE /api/streak/board/:slug/checkin     member   untick a day for YOURSELF { date? }
 *   GET    /api/streak/board/:slug/messages    member   older messages { before_id }
 *   POST   /api/streak/board/:slug/message     member   post a message  { body }
 *   DELETE /api/streak/board/:slug/message/:id member   delete YOUR OWN message
 *
 *   GET    /api/streak/boards                  admin    list all boards
 *   POST   /api/streak/boards                  admin    create
 *   PATCH  /api/streak/boards/:slug            admin    edit title/desc/tz/archived/members
 *   DELETE /api/streak/boards/:slug            admin    delete board + its checkins
 *
 * A member can only ever tick or untick their OWN row — the username comes from
 * the credential, never from the request body. That is the whole point. The same
 * rule governs chat: you post as yourself and you can only delete your own.
 *
 * ── CHAT ────────────────────────────────────────────────────────────────────
 * Board-scoped, not day-scoped. It rides along inside GET /board/:slug rather
 * than getting its own poll, because memberAuth spends a full bcrypt compare on
 * every request and a dedicated chat poll would double that bill for nothing.
 *
 * Timestamps go out as epoch seconds (UNIX_TIMESTAMP), never as formatted
 * strings — the client renders them in the VIEWER's timezone. `board.tz` decides
 * what day it is for streak purposes and nothing else; two members in different
 * countries must each see their own clock on a message.
 *
 * Every path is >= 2 segments, so the `GET /:page` static catch-all in server.js
 * (registered before the routes/ scan) never intercepts these.
 *
 * Front end: public/streak.html  →  /streak  and  /streak?b=<slug>
 */

const express   = require("express");
const bcrypt    = require("bcrypt");
const crypto    = require("crypto");
const rateLimit = require("express-rate-limit");
const { DateTime } = require("luxon");

const router = express.Router();

// ─── config ──────────────────────────────────────────────────────────────────

const DEFAULT_TZ    = process.env.FIRM_TIMEZONE || "America/Detroit";
const ADMIN_PASS    = process.env.STREAK_ADMIN_PASSWORD || "";
const BCRYPT_ROUNDS = 10;

/** How far back a member may tick or untick a day. Unbounded backfill would make
 *  the streak number meaningless — you could click your way to 100 days. */
const BACKFILL_DAYS = 7;

/** Width of the day grid returned to the client. */
const GRID_DAYS  = 28;
const MAX_MEMBERS = 8;
const MIN_PASS_LEN = 4;

/** Messages returned per page — both in the board payload and per "load older". */
const MSG_PAGE  = 50;
const MSG_MAX   = 1000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const USER_RE = /^[a-z0-9._-]{1,32}$/;
const ISO_RE  = /^\d{4}-\d{2}-\d{2}$/;

/** Burned on every failed member lookup so a wrong username costs the same wall
 *  time as a wrong password. Computed once at boot (~60ms). */
const DUMMY_HASH = bcrypt.hashSync("yisrastreak-dummy", BCRYPT_ROUNDS);

const limit = (max) => rateLimit({
  windowMs: 60 * 1000,
  max,
  message: { error: "Too many requests — slow down and try again in a minute." },
});
const memberLimiter = limit(60);
const adminLimiter  = limit(30);
const metaLimiter   = limit(60);

// ─── helpers ─────────────────────────────────────────────────────────────────

/** base64 → utf-8 string. "" on garbage. */
function b64(v) {
  try { return Buffer.from(String(v || ""), "base64").toString("utf8"); }
  catch { return ""; }
}

/** Length-safe constant-time compare (hash first so lengths always match). */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** ISO-date arithmetic in UTC. No DST, no drift, no surprises. */
const U     = (iso)        => DateTime.fromISO(iso, { zone: "utc" });
const shift = (iso, days)  => U(iso).plus({ days }).toISODate();

/** The board's local "today" as a YYYY-MM-DD string. */
function todayIn(tz) {
  const dt = DateTime.now().setZone(tz);
  return (dt.isValid ? dt : DateTime.now().setZone(DEFAULT_TZ)).toISODate();
}

const validTz = (tz) => DateTime.now().setZone(tz).isValid;

function slugify(s) {
  const out = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return out || "board";
}

async function uniqueSlug(db, base) {
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 44)}-${n}`;
    const [[hit]] = await db.query(
      "SELECT id FROM streak_boards WHERE slug = ? LIMIT 1", [slug]
    );
    if (!hit) return slug;
  }
  return `${base.slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`;
}

async function loadBoard(db, slug) {
  const [[b]] = await db.query(
    `SELECT id, slug, title, description, tz, members, archived,
            DATE_FORMAT(created_at, '%Y-%m-%d') AS created_on
       FROM streak_boards
      WHERE slug = ?
      LIMIT 1`,
    [slug]
  );
  if (!b) return null;
  // mysql2 returns JSON columns already parsed. Guard for the case where the row
  // was hand-written as a string via dbConsole.
  if (!Array.isArray(b.members)) {
    try { b.members = JSON.parse(b.members) || []; } catch { b.members = []; }
  }
  b.archived = !!b.archived;
  return b;
}

/** Strip bcrypt hashes before anything leaves the process. */
const publicMembers = (members) =>
  (members || []).map((m) => ({ username: m.u, name: m.name || m.u }));

/**
 * Streak stats from a set of ISO dates.
 *
 * current   — counts back from today, or from yesterday if today isn't done yet,
 *             so a live streak doesn't read 0 until the day is actually lost.
 * longest   — longest run ever, including the current one.
 */
function statsFor(dates, todayISO) {
  const set = new Set(dates);
  const yesterdayISO = shift(todayISO, -1);

  let current = 0;
  let cursor =
    set.has(todayISO)     ? todayISO :
    set.has(yesterdayISO) ? yesterdayISO :
    null;
  while (cursor && set.has(cursor)) {
    current += 1;
    cursor = shift(cursor, -1);
  }

  const sorted = [...set].sort();
  let longest = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = (prev && shift(prev, 1) === d) ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = d;
  }

  return {
    current,
    longest,
    total: set.size,
    last_done: sorted.length ? sorted[sorted.length - 1] : null,
    done_today: set.has(todayISO),
  };
}

/** Shared date validation for checkin / uncheckin. Returns { date } or { error }. */
function resolveDate(raw, todayISO) {
  const date = String(raw || todayISO);
  if (!ISO_RE.test(date) || !U(date).isValid) {
    return { error: "date must be YYYY-MM-DD" };
  }
  if (date > todayISO) {
    return { error: "That day hasn't happened yet." };
  }
  if (date < shift(todayISO, -BACKFILL_DAYS)) {
    return { error: `You can only change the last ${BACKFILL_DAYS} days.` };
  }
  return { date };
}

// ─── chat helpers ────────────────────────────────────────────────────────────

/**
 * Author display name, resolved against the board's member list with the raw
 * username as the fallback — so a member who was later removed from the board
 * still reads sensibly in the scrollback instead of vanishing.
 */
function nameLookup(members) {
  const map = new Map((members || []).map((m) => [m.u, m.name || m.u]));
  return (u) => map.get(u) || u;
}

/**
 * Normalize an incoming message body. Returns { body } or { error }.
 *
 * varchar(1000) counts CHARACTERS in utf8mb4 while JS .length counts UTF-16 code
 * units, and code units >= characters for every string, so slicing at MSG_MAX in
 * JS can never overflow the column. The surrogate guard stops the slice landing
 * between the halves of an astral character and writing a lone surrogate.
 */
function cleanBody(raw) {
  let s = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (!s) return { error: "Say something first." };
  if (s.length > MSG_MAX) {
    s = s.slice(0, MSG_MAX);
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  }
  return { body: s };
}

/**
 * One page of messages, oldest → newest.
 *
 * `beforeId` pages backwards for "load older". We ask for one row more than the
 * page size purely to answer `has_more` without a second COUNT query.
 * `ts` is epoch seconds — see the CHAT note at the top of the file.
 */
async function fetchMessages(db, boardId, members, beforeId = null) {
  const nameOf = nameLookup(members);

  const params = [boardId];
  let where = "board_id = ?";
  if (beforeId) { where += " AND id < ?"; params.push(beforeId); }

  const [rows] = await db.query(
    `SELECT id, username, body, UNIX_TIMESTAMP(created_at) AS ts
       FROM streak_messages
      WHERE ${where}
      ORDER BY id DESC
      LIMIT ${MSG_PAGE + 1}`,
    params
  );

  const has_more = rows.length > MSG_PAGE;
  if (has_more) rows.pop();

  return {
    has_more,
    messages: rows.reverse().map((r) => ({
      id: r.id,
      username: r.username,
      name: nameOf(r.username),
      body: r.body,
      ts: Number(r.ts),
    })),
  };
}

// ─── auth middleware ─────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  if (!ADMIN_PASS) {
    return res.status(503).json({
      error: "STREAK_ADMIN_PASSWORD is not set on this server, so board admin is disabled.",
    });
  }
  const given = b64(req.headers["x-streak-admin"]);
  if (!given || !safeEqual(given, ADMIN_PASS)) {
    return res.status(401).json({ error: "Wrong admin password." });
  }
  next();
}

/** Resolves :slug → req.board and verifies X-Streak-Auth → req.member. */
async function memberAuth(req, res, next) {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Bad board link." });

    const board = await loadBoard(req.db, slug);
    if (!board) return res.status(404).json({ error: "No such board." });

    const raw = b64(req.headers["x-streak-auth"]);
    const sep = raw.indexOf(":");
    const username = sep < 0 ? "" : raw.slice(0, sep).trim().toLowerCase();
    const password = sep < 0 ? "" : raw.slice(sep + 1);
    if (!username || !password) return res.status(401).json({ error: "Sign in to see this board." });

    const member = board.members.find((m) => m.u === username);
    // Always spend the bcrypt time, even on an unknown username.
    const ok = await bcrypt.compare(password, member?.h || DUMMY_HASH);
    if (!member || !ok) return res.status(401).json({ error: "Wrong name or password." });

    req.board  = board;
    req.member = member;
    next();
  } catch (err) {
    console.error("[api.streak] memberAuth error:", err);
    res.status(500).json({ error: "Sign-in failed." });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MEMBER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/streak/meta/:slug   (public)
 *
 * Just enough for the login screen to render: the board's title and who is on
 * it, so a member picks their name instead of typing a username. No hashes, no
 * checkin data. Anyone with the link sees this — that is an accepted trade.
 */
router.get("/api/streak/meta/:slug", metaLimiter, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Bad board link." });

    const board = await loadBoard(req.db, slug);
    if (!board) return res.status(404).json({ error: "No such board." });

    res.json({
      slug: board.slug,
      title: board.title,
      description: board.description,
      archived: board.archived,
      members: publicMembers(board.members),
    });
  } catch (err) {
    console.error("[api.streak] GET meta error:", err);
    res.status(500).json({ error: "Couldn't load that board." });
  }
});

/** POST /api/streak/auth/:slug — credential check for the login screen. */
router.post("/api/streak/auth/:slug", memberLimiter, memberAuth, (req, res) => {
  res.json({
    ok: true,
    slug: req.board.slug,
    title: req.board.title,
    username: req.member.u,
    name: req.member.name || req.member.u,
  });
});

/**
 * GET /api/streak/board/:slug — everything the board view needs, in one call.
 *
 * Pulls every checkin row for the board. Two people over five years is ~3,600
 * rows; the whole-table read keeps the streak logic trivial and honest. If a
 * board ever grows past ~50k rows this becomes the thing to revisit, and the
 * fix is to window `days` while keeping a MAX/COUNT aggregate for the totals.
 */
router.get("/api/streak/board/:slug", memberLimiter, memberAuth, async (req, res) => {
  try {
    const board    = req.board;
    const todayISO = todayIn(board.tz);

    const [rows] = await req.db.query(
      `SELECT username,
              DATE_FORMAT(checkin_date, '%Y-%m-%d') AS d,
              DATE_FORMAT(logged_date,  '%Y-%m-%d') AS logged,
              note
         FROM streak_checkins
        WHERE board_id = ?
        ORDER BY checkin_date ASC`,
      [board.id]
    );

    // Oldest → newest, ending on today.
    const grid = [];
    for (let i = GRID_DAYS - 1; i >= 0; i--) grid.push(shift(todayISO, -i));

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.username)) byUser.set(r.username, []);
      byUser.get(r.username).push(r);
    }

    const members = board.members.map((m) => {
      const mine   = byUser.get(m.u) || [];
      const byDate = new Map(mine.map((r) => [r.d, r]));
      return {
        username: m.u,
        name: m.name || m.u,
        is_you: m.u === req.member.u,
        ...statsFor(mine.map((r) => r.d), todayISO),
        days: grid.map((d) => {
          const hit = byDate.get(d);
          return {
            date: d,
            done: !!hit,
            // logged_date > checkin_date  ⇒  ticked after the fact.
            late: !!hit && hit.logged > d,
            note: hit?.note || null,
          };
        }),
      };
    });

    // Chat rides along here rather than on its own poll — see the CHAT note at
    // the top of the file. One indexed range scan, capped at MSG_PAGE rows.
    const chat = await fetchMessages(req.db, board.id, board.members);

    res.json({
      slug: board.slug,
      title: board.title,
      description: board.description,
      tz: board.tz,
      archived: board.archived,
      today: todayISO,
      backfill_days: BACKFILL_DAYS,
      grid_days: GRID_DAYS,
      you: req.member.u,
      members,
      all_done_today: members.length > 0 && members.every((m) => m.done_today),
      messages: chat.messages,
      messages_has_more: chat.has_more,
      message_max: MSG_MAX,
    });
  } catch (err) {
    console.error("[api.streak] GET board error:", err);
    res.status(500).json({ error: "Couldn't load the board." });
  }
});

/**
 * POST /api/streak/board/:slug/checkin — tick a day for yourself.
 * Body: { date?: "YYYY-MM-DD" (default today), note?: string }
 *
 * Idempotent. Re-ticking an already-ticked day updates the note (if one was
 * supplied) but deliberately does NOT touch logged_date — once a day was ticked
 * late it stays marked late.
 */
router.post("/api/streak/board/:slug/checkin", memberLimiter, memberAuth, async (req, res) => {
  try {
    const board = req.board;
    if (board.archived) return res.status(409).json({ error: "This board is archived." });

    const todayISO = todayIn(board.tz);
    const { date, error } = resolveDate(req.body?.date, todayISO);
    if (error) return res.status(400).json({ error });

    const hasNote = Object.prototype.hasOwnProperty.call(req.body || {}, "note");
    const note = hasNote
      ? (String(req.body.note ?? "").trim().slice(0, 280) || null)
      : null;

    await req.db.query(
      `INSERT INTO streak_checkins
              (board_id, username, checkin_date, logged_date, note)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
              note = IF(?, VALUES(note), note)`,
      [board.id, req.member.u, date, todayISO, note, hasNote ? 1 : 0]
    );

    res.json({ ok: true, date, late: date < todayISO });
  } catch (err) {
    console.error("[api.streak] POST checkin error:", err);
    res.status(500).json({ error: "Couldn't save that." });
  }
});

/**
 * DELETE /api/streak/board/:slug/checkin — untick a day for yourself.
 * Body or query: { date?: "YYYY-MM-DD" (default today) }
 */
router.delete("/api/streak/board/:slug/checkin", memberLimiter, memberAuth, async (req, res) => {
  try {
    const board = req.board;
    if (board.archived) return res.status(409).json({ error: "This board is archived." });

    const todayISO = todayIn(board.tz);
    const { date, error } = resolveDate(req.body?.date || req.query?.date, todayISO);
    if (error) return res.status(400).json({ error });

    const [r] = await req.db.query(
      `DELETE FROM streak_checkins
        WHERE board_id = ? AND username = ? AND checkin_date = ?`,
      [board.id, req.member.u, date]
    );

    res.json({ ok: true, date, deleted: r.affectedRows });
  } catch (err) {
    console.error("[api.streak] DELETE checkin error:", err);
    res.status(500).json({ error: "Couldn't undo that." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAT ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/streak/board/:slug/messages — page backwards through the scrollback.
 * Query: { before_id }
 *
 * The board payload already carries the newest page, so this exists only to
 * serve "load older". Omitting before_id returns the newest page again.
 */
router.get("/api/streak/board/:slug/messages", memberLimiter, memberAuth, async (req, res) => {
  try {
    const raw = req.query?.before_id;
    const beforeId = (raw == null || raw === "") ? null : Number(raw);
    if (beforeId !== null && (!Number.isInteger(beforeId) || beforeId < 1)) {
      return res.status(400).json({ error: "Bad before_id." });
    }
    res.json(await fetchMessages(req.db, req.board.id, req.board.members, beforeId));
  } catch (err) {
    console.error("[api.streak] GET messages error:", err);
    res.status(500).json({ error: "Couldn't load the chat." });
  }
});

/**
 * POST /api/streak/board/:slug/message — say something. Body: { body }
 *
 * The author is the credential, never the request body. The inserted row is
 * re-read for its timestamp so the client shows the DATABASE's clock; app server
 * and DB server are different machines and their clocks can disagree.
 */
router.post("/api/streak/board/:slug/message", memberLimiter, memberAuth, async (req, res) => {
  try {
    const board = req.board;
    if (board.archived) return res.status(409).json({ error: "This board is archived." });

    const { body, error } = cleanBody(req.body?.body);
    if (error) return res.status(400).json({ error });

    const [ins] = await req.db.query(
      "INSERT INTO streak_messages (board_id, username, body) VALUES (?, ?, ?)",
      [board.id, req.member.u, body]
    );

    const [[row]] = await req.db.query(
      "SELECT UNIX_TIMESTAMP(created_at) AS ts FROM streak_messages WHERE id = ?",
      [ins.insertId]
    );

    res.status(201).json({
      ok: true,
      message: {
        id: ins.insertId,
        username: req.member.u,
        name: req.member.name || req.member.u,
        body,
        ts: Number(row?.ts ?? Math.floor(Date.now() / 1000)),
      },
    });
  } catch (err) {
    console.error("[api.streak] POST message error:", err);
    res.status(500).json({ error: "Couldn't send that." });
  }
});

/**
 * DELETE /api/streak/board/:slug/message/:id — remove YOUR OWN message.
 *
 * Hard delete, no edit, no tombstone. Two people on a board do not need an audit
 * trail; they need to be able to fix a typo.
 */
router.delete("/api/streak/board/:slug/message/:id", memberLimiter, memberAuth, async (req, res) => {
  try {
    const board = req.board;
    if (board.archived) return res.status(409).json({ error: "This board is archived." });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Bad message id." });

    const [[row]] = await req.db.query(
      "SELECT username FROM streak_messages WHERE id = ? AND board_id = ? LIMIT 1",
      [id, board.id]
    );
    if (!row) return res.status(404).json({ error: "That message is already gone." });
    if (row.username !== req.member.u) {
      return res.status(403).json({ error: "You can only delete your own messages." });
    }

    const [r] = await req.db.query(
      "DELETE FROM streak_messages WHERE id = ? AND board_id = ? AND username = ?",
      [id, board.id, req.member.u]
    );

    res.json({ ok: true, id, deleted: r.affectedRows });
  } catch (err) {
    console.error("[api.streak] DELETE message error:", err);
    res.status(500).json({ error: "Couldn't delete that." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/streak/boards — list, with a little activity summary per board. */
router.get("/api/streak/boards", adminLimiter, adminAuth, async (req, res) => {
  try {
    const [rows] = await req.db.query(
      `SELECT b.id, b.slug, b.title, b.description, b.tz, b.archived, b.members,
              DATE_FORMAT(b.created_at, '%Y-%m-%d') AS created_on,
              (SELECT COUNT(*) FROM streak_checkins c WHERE c.board_id = b.id) AS checkins,
              (SELECT DATE_FORMAT(MAX(c.checkin_date), '%Y-%m-%d')
                 FROM streak_checkins c WHERE c.board_id = b.id) AS last_checkin
         FROM streak_boards b
        ORDER BY b.archived ASC, b.id DESC`
    );

    res.json({
      boards: rows.map((b) => {
        let members = b.members;
        if (!Array.isArray(members)) {
          try { members = JSON.parse(members) || []; } catch { members = []; }
        }
        return {
          id: b.id,
          slug: b.slug,
          title: b.title,
          description: b.description,
          tz: b.tz,
          archived: !!b.archived,
          created_on: b.created_on,
          checkins: b.checkins,
          last_checkin: b.last_checkin,
          members: publicMembers(members),
        };
      }),
    });
  } catch (err) {
    console.error("[api.streak] GET boards error:", err);
    res.status(500).json({ error: "Couldn't list boards." });
  }
});

/**
 * Validate + hash an incoming members array.
 * `existing` (the board's current members) lets a PATCH omit a password to mean
 * "leave this person's password alone".
 * Returns { members } or { error }.
 */
async function buildMembers(input, existing = []) {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "Add at least one person." };
  }
  if (input.length > MAX_MEMBERS) {
    return { error: `At most ${MAX_MEMBERS} people per board.` };
  }

  const prev = new Map(existing.map((m) => [m.u, m]));
  const seen = new Set();
  const out = [];

  for (const raw of input) {
    const u = String(raw?.username || "").trim().toLowerCase();
    if (!USER_RE.test(u)) {
      return { error: `"${raw?.username ?? ""}" is not a valid username (a-z, 0-9, . _ - only).` };
    }
    if (seen.has(u)) return { error: `Duplicate username: ${u}` };
    seen.add(u);

    const name = String(raw?.name || u).trim().slice(0, 60) || u;
    const pw   = raw?.password == null ? "" : String(raw.password);

    let h;
    if (pw) {
      if (pw.length < MIN_PASS_LEN) {
        return { error: `Password for ${u} must be at least ${MIN_PASS_LEN} characters.` };
      }
      h = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    } else if (prev.has(u)) {
      h = prev.get(u).h;              // unchanged member — keep the existing hash
    } else {
      return { error: `${u} is new, so they need a password.` };
    }

    out.push({ u, name, h });
  }
  return { members: out };
}

/**
 * POST /api/streak/boards — create.
 * Body: { title, description?, tz?, slug?,
 *         members: [{ username, name?, password }] }
 */
router.post("/api/streak/boards", adminLimiter, adminAuth, async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: "Give the board a title." });

    const description = req.body?.description
      ? String(req.body.description).trim().slice(0, 500)
      : null;

    const tz = String(req.body?.tz || DEFAULT_TZ).trim();
    if (!validTz(tz)) return res.status(400).json({ error: `"${tz}" is not a valid IANA timezone.` });

    const { members, error } = await buildMembers(req.body?.members);
    if (error) return res.status(400).json({ error });

    let slug = req.body?.slug ? String(req.body.slug).trim().toLowerCase() : slugify(title);
    if (!SLUG_RE.test(slug)) {
      return res.status(400).json({ error: "Slug must be lowercase letters, numbers and dashes." });
    }
    slug = await uniqueSlug(req.db, slug);

    // mysql2 will not stringify an array for you — bind JSON as text.
    await req.db.query(
      `INSERT INTO streak_boards (slug, title, description, tz, members)
       VALUES (?, ?, ?, ?, ?)`,
      [slug, title, description, tz, JSON.stringify(members)]
    );

    res.status(201).json({ ok: true, slug, title, members: publicMembers(members) });
  } catch (err) {
    console.error("[api.streak] POST boards error:", err);
    res.status(500).json({ error: "Couldn't create the board." });
  }
});

/**
 * PATCH /api/streak/boards/:slug — edit.
 * Body: any of { title, description, tz, archived, members }
 *
 * `members` is a FULL REPLACEMENT of the array. Omit a member's `password` to
 * leave it alone; supply one to reset it. Dropping someone from the array does
 * not delete their checkins — re-adding the same username restores their
 * history intact.
 */
router.patch("/api/streak/boards/:slug", adminLimiter, adminAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Bad board link." });

    const board = await loadBoard(req.db, slug);
    if (!board) return res.status(404).json({ error: "No such board." });

    const sets = [];
    const params = [];
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body || {}, k);

    if (has("title")) {
      const title = String(req.body.title || "").trim().slice(0, 160);
      if (!title) return res.status(400).json({ error: "Title can't be empty." });
      sets.push("title = ?"); params.push(title);
    }
    if (has("description")) {
      const d = req.body.description ? String(req.body.description).trim().slice(0, 500) : null;
      sets.push("description = ?"); params.push(d);
    }
    if (has("tz")) {
      const tz = String(req.body.tz || "").trim();
      if (!validTz(tz)) return res.status(400).json({ error: `"${tz}" is not a valid IANA timezone.` });
      sets.push("tz = ?"); params.push(tz);
    }
    if (has("archived")) {
      sets.push("archived = ?"); params.push(req.body.archived ? 1 : 0);
    }
    if (has("members")) {
      const { members, error } = await buildMembers(req.body.members, board.members);
      if (error) return res.status(400).json({ error });
      sets.push("members = ?"); params.push(JSON.stringify(members));
    }

    if (!sets.length) return res.status(400).json({ error: "Nothing to change." });

    params.push(board.id);
    await req.db.query(
      `UPDATE streak_boards SET ${sets.join(", ")} WHERE id = ?`,
      params
    );

    const fresh = await loadBoard(req.db, slug);
    res.json({
      ok: true,
      slug: fresh.slug,
      title: fresh.title,
      description: fresh.description,
      tz: fresh.tz,
      archived: fresh.archived,
      members: publicMembers(fresh.members),
    });
  } catch (err) {
    console.error("[api.streak] PATCH board error:", err);
    res.status(500).json({ error: "Couldn't save the board." });
  }
});

/** DELETE /api/streak/boards/:slug — board + all its checkins. No undo. */
router.delete("/api/streak/boards/:slug", adminLimiter, adminAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").toLowerCase();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "Bad board link." });

    const board = await loadBoard(req.db, slug);
    if (!board) return res.status(404).json({ error: "No such board." });

    // No FK, so the cascade is ours. Pure DB work — safe to auto-retry.
    const removed = await req.db.withTransaction(async (conn) => {
      const [c] = await conn.query("DELETE FROM streak_checkins WHERE board_id = ?", [board.id]);
      const [m] = await conn.query("DELETE FROM streak_messages WHERE board_id = ?", [board.id]);
      await conn.query("DELETE FROM streak_boards WHERE id = ?", [board.id]);
      return { checkins: c.affectedRows, messages: m.affectedRows };
    });

    res.json({
      ok: true,
      slug,
      checkins_deleted: removed.checkins,
      messages_deleted: removed.messages,
    });
  } catch (err) {
    console.error("[api.streak] DELETE board error:", err);
    res.status(500).json({ error: "Couldn't delete the board." });
  }
});


module.exports = router;