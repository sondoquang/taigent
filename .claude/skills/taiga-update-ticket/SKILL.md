---
name: taiga-update-ticket
description: "Move your own Taiga tickets to another status, comment on one, or approve the re-plan of their due dates, at once. Use for close, done, or move ticket #N, for closing the tickets of the end-of-day reminder, for approving the re-plan, or for commenting on a ticket."
allowed-tools: Bash(npx taigent tickets *) Bash(npx taigent status *) Bash(npx taigent comment *) Bash(npx taigent due *) PowerShell(npx taigent tickets *) PowerShell(npx taigent status *) PowerShell(npx taigent comment *) PowerShell(npx taigent due *)
---

# Update my ticket

Change the status of, comment on, or set the due date of **tickets** (`GLOSSARY.md`: user stories assigned to the user the `taigent` CLI logs in as). The user's message is the confirmation: once each ticket and change is unambiguous, run the command straight away. The one exception is `Done`, below. The request often arrives from Telegram, in answer to the **End-of-day reminder** (`docs/cli.md` §Notify and §Telegram, in the taigent root: the project root when its `package.json` has `taigent` as `name`, else `node_modules/taigent/`); answer there with one short message.

## 1. Check the setup

The project root's `package.json` has `taigent` as `name` or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry.

Done when `package.json` names `taigent`.

## 2. Read the tickets

Run `npx taigent tickets --from <today> --to <today> --eod --json` (today as `YYYY-MM-DD`, local time) alone in its own shell call. The chat holds no copy of the end-of-day reminder (a bot receives none of its own messages), so every set below is rebuilt from this JSON: the reminder's tickets are those of `tickets` whose `isFinished` is false and whose `dueDate` is `today` or earlier, and `--eod` plans from the next working day as the reminder does, so `replan` holds the reminder's entries. When this conversation already shows a `taiga-my-tickets` report, leave out `--eod`: the re-plan to approve is the one that report showed.

Done when you hold its JSON.

## 3. Pick the change

- **Close** ("close them", "đóng hết", "đóng #84", "xong", "done", "close"): `Ready for test`, the ticket waiting for QA/QC.
- **`Done`**: only when the user asks for `Done` by name and says the tickets were tested. Asked for `Done` without saying so: ask whether they were tested, and write nothing until they confirm.
- Another status: its name from `docs/taiga/conventions.md` §7 (`In progress`, `Ready for test`…), as the user wrote it.
- **A comment**: the user's words, as written.
- **Approve the re-plan** ("approve the re-plan", "duyệt re-plan", "ok re-plan"): each `replan` entry's `proposedDueDate` with its `comment`, as printed.

Done when the request is one status, one comment or the re-plan.

## 4. Find the tickets

For a status or a comment, pick from `tickets` whose `isFinished` is false (a status other than close may also name a finished ticket by ref):

- **A ref with its project** ("#84 in vigo-auth"): that ticket.
- **A ref alone** ("đóng #84"): the ticket with that `ref`; when refs collide across projects, ask which project.
- **Words** ("the login ticket"): the ticket whose `subject` they match; with several or none, list the candidates (`#ref subject (project)`) and ask.
- **No ticket named** ("đóng hết", "close them", "xong rồi đóng hộ tôi"): the end-of-day reminder's tickets of step 2. None: say there is nothing to close.

For the re-plan: in answer to the end-of-day reminder, the `replan` entries of its tickets; otherwise every `replan` entry, in their order. Refs or projects named ("duyệt re-plan #2"): only those entries. `replan` empty: say there is no re-plan to approve; the plan already fits the due dates.

Done when every ticket is a `ref` and a project slug, with nothing left to guess.

## 5. Write

For each ticket, one command alone in its own shell call, in the order of step 4:

- Status: `npx taigent status --project <slug> <ref> <status words>`, e.g. `npx taigent status --project vigo-auth 84 Ready for test` (the words need no quotes).
- Comment: `npx taigent comment --project <slug> <ref> '<text>'`, the text in single quotes with any single quote in it dropped.
- Re-plan entry: `npx taigent due --project <project> <ref> <proposedDueDate> -- '<comment>'`, the entry's `comment` in single quotes with any single quote in it dropped. Approving the same entry twice is harmless: the command then changes nothing.

Exit 2 names what is wrong (a ticket not assigned to the user, an unknown status with the valid ones listed, an invalid day): relay it and go on with the next ticket. Exit 5 `conflict`: someone changed the ticket meanwhile; run `taigent tickets` again and retry that ticket once. Exit 2 `not logged in`, or exit 5 naming a refused or expired login: stop and name `taiga-setup` as the fix.

Done when every ticket of step 4 has run its command.

## 6. Report

One line per ticket from the command's output, in the user's language: `#84 Login form (vigo-auth): In progress → Ready for test`, `#2 Export (vigo-medical-hub): due date 2026-11-20 → 2026-11-23, with a comment`, already in that status or due date, or the error. Moving 3 or more tickets to `Done` within a minute shows as a **Bulk close** in `taiga-my-tickets`: when that happens, say so in one line. After a close to `Ready for test`, add that `Done` follows once QA/QC has tested them.

Done when the user has every ticket's outcome.
