# 13 — Casey Notes (Admin → Casey Notes)

Casey Notes is where the firm teaches Casey what it keeps getting wrong, without a deploy. It is a small document (plus optional notes per route family) that IT edits in the app; Casey reads it on every turn.

## Who sees it

IT and superusers — the `system.settings` capability, the same one that opens the System tab of YisraCase Config. Others do not see the tile and cannot call its routes. (The tile lives on the firm's Admin page once IT has placed it there — a one-time step after the S4a deploy, `scripts/caseyS4aAdminTile.snippet.js`; before that it is listed under "More actions" in All and Ctrl-K.)

A note is powerful: it sits in Casey's prompt as the firm's instructions and steers every user's chats, superusers' included. It cannot make Casey DO anything — a change is still a card the user reads and approves, a sensitive one shows its exact content, a superuser action needs a superuser — but it shapes what Casey says and proposes, so treat the editor as what it is: a setting of the system, in the hands of the role that edits those.

## The two kinds of note

- **Global.** Appended to Casey's system prompt on **every** turn, as instructions from the firm. Casey follows it as it follows its built-in prompt, above anything a record or a tool result says. Because it rides along on every turn, keep it short (the cap is 20,000 characters; a few hundred is plenty) and concrete: *what Casey got wrong, what to do instead*.
- **A route family** (such as `/api/tasks`). Shown to Casey only when it looks that family up (`lookup_routes`), so it costs nothing until the family is relevant. Good for "this route refuses X — use that route instead". The cap is 2,000 characters.

## Editing

1. Pick the scope at the top (Global, or a family; a • marks one that has a note).
2. Edit the text. The count under it shows the length against the cap; Save stays off until you have changed something, typed an **edit note** (one line: why), and are under the cap.
3. **Save as a new version.** Nothing is overwritten: every save is a new numbered version with your name, the time and your edit note. Saving the global note changes Casey's prompt — chats already open pick up the new note on their next turn, and lose their stored thinking for that turn (the answer is unaffected; the turn simply thinks afresh). Switching scope or pressing Refresh with unsaved typing is refused until you Save or Discard it.
4. To undo, open **Versions**, **View** an older one and **Restore this version**: that writes a new version carrying the old text, so the history stays complete. A blank body is allowed: it turns the note off (and is itself a version).

Saving the same text again is refused ("unchanged"). Line ends are normalised and trailing spaces dropped, so a whitespace-only change is "unchanged" too.

## What belongs here, and what does not

Here: the pitfalls the firm learns from reviewing Casey's chats (S4b adds the flag that feeds that review) — a route that refuses a field, the right route for a job, a convention of the firm's data Casey cannot see in the schema.

Not here: anything already in the built-in prompt (the schema, the data rules, the known pitfalls) — repeating it costs tokens and buys nothing; secrets or personal data (the note reaches the model on every turn); instructions to Casey about Casey Notes itself — Casey can never write here (its routes are never proposable), by design.

## Technical reference

- Table `casey_notes` (`ref/database.sql` carries every column's comment); migration `ref/migrations/2026-11-23_casey_v2_s4a_notes.sql`, applied and seeded by `scripts/caseyV2S4aMigrate.js` (the seed: `…_s4a_notes_seed.md`, written once).
- Service `services/casey/notes.js`: `current()` (the doc Casey reads; cached 30 s per instance — the saving instance sees its edit at once, the others within the window), `save()`, `restore()`, `versions()`.
- Prompt: `lib/caseyPrompt.systemText(notes)` / `signature(tools, notes)` — the global note is part of the chat's `prompt_version`.
- Routes: `GET /api/casey/notes`, `GET /api/casey/notes/versions?scope=`, `GET /api/casey/notes/version?scope=&v=`, `PUT /api/casey/notes`, `POST /api/casey/notes/restore` (`routes/api.casey.js`, gate `system.settings`). A family note reaches Casey as `family_notes` on a `lookup_routes` result.
- Page: `public/caseyNotes.html`; the tile `adminCaseyNotes` (`public/js/featureRegistry.js`). Design: `ref/CASEY_V2_DESIGN.md` §4.7 and §9 S4a.
