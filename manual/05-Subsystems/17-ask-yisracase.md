# Ask Casey

Ask Casey is the firm's assistant inside YisraCase. It reads records through
the app's own routes as you, reads the app's code and manual, and proposes any
change as a card you approve — it never changes anything by itself. Open it from the persistent **Ask Casey** button at the
bottom of the left sidebar. **More → Ask Casey** opens the same assistant in a
wider sidebar; it does not create a second chat or replace the workspace.

The case, contact, appointment, or tool already on screen remains visible.
Opening or collapsing Casey does not change the workspace URL, cancel a
request, or reload the pane. On a phone, the same
assistant uses the full-width sidebar sheet.

## How Casey answers

Casey answers by looking things up as you — it runs
searches, reads records through the app's own routes and reads the app's code
and manual — and shows every step it took as a trail above the answer (click a
step for the exact query or request). Pick an earlier chat from the list at the
top, start a new one with **+**, delete one with the bin. Starting a new
chat, the dropdown at the top picks the model it will run on, each with a
short note on when to use it (your administrator chooses which models are
offered, in what order, the note beside each, and which one is preselected;
a chat keeps its model, and every new chat starts back at the preselected
one — except that a first message that failed keeps your pick for the
retry). **Stop** ends a turn
that is taking too long; **Keep going** appears when Casey hit the per-turn
limit before finishing. The **current view** chip tells Casey which case,
contact or tab you are looking at ("this case" means that one); remove it to
ask in general.

**Changes are cards.** Casey never changes anything by itself. When you ask
for a change — create a task, send a message, update a record — it proposes a
**card**: a one-line summary in Casey's words, then each step it wants to run
(the request and why), and the exact content that would be sent. For an
ordinary write the details sit under **Details**; for a sensitive one (a send,
a delete) the content is shown open with a warning, and a superuser action is
labelled as such (your password may be asked for, as on the admin pages).
Read the content, not just the summary — the content is what is sent. A
later step may use something an earlier step produced (the id of a record the
first step creates, say): the card shows it as `$1.task_id` until the step
runs, then shows exactly what was sent. Click
**Approve** to run the steps, in order, as yourself (each step shows applied or
failed; a later step is not run after a failure), or **Decline**, optionally
telling Casey why. Closing the tab while Casey is still working stops it after
the step in hand; a very long chat is refused with a note to start a new one. Either way Casey is told exactly what happened and answers;
typing another message instead counts as declining. If a card from an earlier
visit is still waiting, reopen the chat: a card you never answered can still
be approved or declined; one that ran partway offers **Continue** or **Stop
here**. A step that shows as *unknown* was sent but its result was never
recorded — check the record before asking for it again.

### Flagging an answer, and who can read your chats

Under every answer there is a small **Flag for review**. Use it when Casey got something wrong, refused something it should have done, or just left you unsure: type a line about what went wrong if you like, or send the flag alone. It files a Casey report in the Support Inbox, where IT reads the whole chat and fixes the cause — usually by writing Casey a note so it handles the case right from then on. Casey may also flag a chat itself when it is stuck; it tells you when it does.

A superuser can open any Casey chat — yours included — in Admin → Casey Chats, flagged or not. That is how flagged answers get fixed and how misuse is caught. Casey is a work tool: do not put in it what you would not put in a work email.
