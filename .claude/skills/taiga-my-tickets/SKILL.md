---
name: taiga-my-tickets
description: "Your Taiga tickets (user stories assigned to you) in a period, with due status and effort. Use for my tickets or my work in a given period."
allowed-tools: Bash(npx taigent tickets *) PowerShell(npx taigent tickets *)
---

# My tickets

Report the **Period's tickets** (`GLOSSARY.md`) of the user the `taigent` CLI logs in as: the user stories assigned to them that closed or are due in the period, plus every one still open, each with its **Due status** and **Effort**. A **Ticket** is a user story; tasks and issues are not tickets. The read-only `npx taigent tickets` computes everything; this skill only lays its JSON out (`docs/cli.md` §Tickets holds the contract, in the taigent root: the project root when its `package.json` has `taigent` as `name`, else `node_modules/taigent/`).

## 1. Check the setup

The project root's `package.json` has `taigent` as `name` or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The CLI reads the `TAIGA_*` variables from the environment or from `.env` on its own.

Done when `package.json` names `taigent`.

## 2. Pick the period

Turn the period into a first and a last day, `YYYY-MM-DD`, in the machine's local time zone:

- No period named: the current week, Monday to Sunday, future days included.
- "Last week", "October", "from 26/10 to 1/11": those days, both included.
- Words that admit two readings ("last week" said on a Sunday): take the more recent one, and name the other in the report header.

Done when you have both days and, where the words were ambiguous, the reading you set aside.

## 3. Run `taigent tickets`

Run `npx taigent tickets --from <first day> --to <last day> --json`, alone in its own shell call; add `--project <slug>` when the user named one project. Exit 2 or 5: show the error and stop; for a missing `TAIGA_*` variable or a refused login, name `taiga-setup` as the fix.

Done when you hold its JSON.

## 4. Report

Build the report from the JSON alone: every count, sum, due status and order comes from it as printed, and fields it lacks stay out. Write it in the user's language (headings and labels included; due status names stay as printed). Dates as `DD/MM`, times in local time. An effort with `effortSource` `points` reads `<effort>h*`, a null one `—`.

1. **Header**: `# <tickets of> <user.username> — <period>` (e.g. `Tuần 26/10 – 01/11/2026`), then one line: the days (Monday–Sunday for a week), local time, and when it was made (`generatedAt`). The user asked about someone else: say the report covers `user.username` only. The reading set aside in step 2, when there was one.
2. **Summary**, three bullets from `summary`:
   - tickets in total; closed with their count per due status; open with their count per due status (statuses with 0 left out; `closed.withoutClosingDay` when not 0).
   - effort hours, split into Spent Time (`effort.spent`: tickets) and estimated from points (`effort.points`: tickets).
   - tickets per project, in the order of `summary.projects`.
3. **By day** (closed tickets): a table `Day | Closed | Effort`, one row per entry of `days`, zero days included.
4. **By project**: one `### <project name> (<count>)` per entry of `summary.projects`, in that order, then a table `# | Ticket | Status | Due status | Assignees | Due | Closed | Effort` with that project's tickets in the order of `tickets`: `#ref`, subject, status, due status, assignees joined with `, `, due date, local closing day and time (`—` when open).
5. **Still open**: a table `# | Project | Ticket | Status | Due status | Due | Effort` with every ticket whose `isClosed` is false, in the order of `tickets`. None: say so in one line.
6. **Notes**:
   - `*` = estimated from points because no Spent Time was entered (when any effort reads `*`).
   - Each `notes.bulkCloses` run: `count` tickets closed between `first` and `last` (local time), with their refs; their closing day may be later than when the work was actually done.
   - `notes.missingEffort`: the tickets with neither points nor Spent Time, as `#ref (project)`.

Done when the report has its header, the summary, every day of `days`, every project of `summary.projects`, the open tickets, and a note for every bulk close and every ticket missing effort. The report is the whole job: statuses, due dates and Spent Time stay as people set them on Taiga.
