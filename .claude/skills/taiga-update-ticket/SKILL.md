---
name: taiga-update-ticket
description: "Move your own Taiga tickets to another status, or comment on one, at once. Use for close, done, or move ticket #N, for closing the tickets of the end-of-day reminder, or for commenting on a ticket."
allowed-tools: Bash(npx taigent tickets *) Bash(npx taigent status *) Bash(npx taigent comment *) PowerShell(npx taigent tickets *) PowerShell(npx taigent status *) PowerShell(npx taigent comment *)
---

# Update my ticket

Change the status of, or comment on, **tickets** (`GLOSSARY.md`: user stories assigned to the user the `taigent` CLI logs in as). The user's message is the confirmation: once each ticket and status is unambiguous, run the command straight away. The request often arrives from Telegram (`docs/cli.md` §Telegram, in the taigent root: the project root when its `package.json` has `taigent` as `name`, else `node_modules/taigent/`); answer there with one short message.

## 1. Check the setup

The project root's `package.json` has `taigent` as `name` or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry.

Done when `package.json` names `taigent`.

## 2. Find the tickets

Run `npx taigent tickets --from <today> --to <today> --json` (today as `YYYY-MM-DD`, local time) alone in its own shell call, and pick from its `tickets` whose `isClosed` is false:

- **A ref with its project** ("#84 in vigo-auth"): that ticket.
- **A ref alone** ("đóng #84"): the open ticket with that `ref`; when refs collide across projects, ask which project.
- **Words** ("the login ticket"): the open ticket whose `subject` they match; with several or none, list the candidates (`#ref subject (project)`) and ask.
- **No ticket named** ("đóng hết", "close them", "xong rồi đóng hộ tôi"): the open tickets whose `dueDate` is today or earlier. This is the set the end-of-day reminder (`taigent notify eod`) listed; the chat holds no copy of that reminder, so rebuild it from the JSON.

Done when every ticket is a `ref` and a project slug, with nothing left to guess.

## 3. Pick the status or the comment

- **Close** ("đóng", "xong", "done", "close"): `Done`.
- Another status: its name from `docs/taiga/conventions.md` §7 (`In progress`, `Ready for test`…), as the user wrote it.
- **A comment**: the user's words, as written.

Done when each ticket has one status or one comment text.

## 4. Write

For each ticket, one command alone in its own shell call, in the order of step 2:

- Status: `npx taigent status --project <slug> <ref> <status words>`, e.g. `npx taigent status --project vigo-auth 84 Ready for test` (the words need no quotes).
- Comment: `npx taigent comment --project <slug> <ref> '<text>'`, the text in single quotes with any single quote in it dropped.

Exit 2 names what is wrong (a ticket not assigned to the user, an unknown status with the valid ones listed): relay it and ask. Exit 5 `conflict`: someone changed the ticket meanwhile; run `taigent tickets` again and retry that ticket once. Exit 2 `not logged in`, or exit 5 naming a refused or expired login: name `taiga-setup` as the fix.

Done when every ticket of step 2 has run its command.

## 5. Report

One line per ticket from the command's output (`#84 Login form (vigo-auth): In progress → Done`, or already in that status, or the error), in the user's language. Closing 3 or more tickets within a minute shows as a **Bulk close** in `taiga-my-tickets`: when that happens, say so in one line.

Done when the user has every ticket's outcome.
