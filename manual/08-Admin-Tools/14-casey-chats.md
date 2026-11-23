# 14 — Casey Chats (Admin → Casey Chats, superuser)

Every Casey chat of every user, and the transcript of any one of them, read-only. It exists for review: a flagged answer, a pattern across users, how much Casey is used and what it costs, and misuse — attempts to make Casey spy on a colleague, to pull data it should refuse, or to talk it out of its rules.

## Who sees it

Superusers only, with the password step-up (the same elevation the DB console asks for): reading another person's conversation is a deliberate act, and the step-up is the pause before it. Staff are told in the Ask Casey chapter that a superuser can read their chats.

## The list

Newest activity first, every user's. Each row shows the title (the first message), the user, the last activity, how many rows are stored, what the chat cost (the model calls, in cents), and a red flag with a count when someone flagged it. Filter by user, by a word in the title, or to flagged chats only.

## Reading a chat

Click a row. The transcript opens on the right — the real Casey pane, in review mode: every stored row as the model saw it, the tool calls and their results on click, the cards with their steps and outcomes, the answers. Nothing can be sent from here: no composer, no delete, no flagging. A banner names the owner, the model and effort, the prompt version and every report that named the chat; a flagged answer is outlined in red, and a link from the Support Inbox lands on the message that was flagged.

## From a report

A **Casey report** in the Support Inbox (the flag under an answer, or Casey's own `flag_for_review`) carries an **Open chat N at message M** link that opens the chat here. Read it, then fix the cause — usually a line in Casey Notes, sometimes the app — and reply to the reporter from the Support Inbox as for any report (the outcomes for this kind: Fixed with a Casey Note / Fixed in the app / Casey was right / Other).

## What it does not do

It does not resolve or reply (the Support Inbox does); it does not delete a chat (the owner does, from the pane); it does not show chats of the previous Casey (v1 keeps its own history until it is retired).

## Technical reference

- Routes: `GET /api/casey/review` (the list: `user`, `q`, `flagged=1`, `before`, `limit` ≤ 200) and `GET /api/casey/review/:id` (the chat, its messages with every block, its cards, its reports) — `routes/api.casey.js`, the superuser casey guard (JWT + su + elevation); never a View-as session; not switched off by `casey_v2_enabled`.
- Readers: `services/casey/chats.listForReview / getForReview / flagsForReview`, `services/casey/cards.listForChat` — unscoped by user, used only by these routes.
- The page: `public/caseyReview.html` (tile `adminCaseyChats`); the transcript is `public/casey.html?review=<id>&seq=<n>`. The flag: `kind = 'casey'` on `issue_reports` (`ref/migrations/2026-11-23_casey_v2_s4b_flag.sql`), `context.casey` `{chat_id, seq, model, prompt_version, by}`. Design: `ref/CASEY_V2_DESIGN.md` §4.8 and §9 S4b.
