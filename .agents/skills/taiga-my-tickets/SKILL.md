---
name: taiga-my-tickets
description: "Your Taiga tickets (user stories assigned to you) in a period, with progress, due status, effort, the plan by day, warnings and the re-plan. Use for my tickets, my plan or my work in a given period."
allowed-tools: Bash(npx taigent tickets *) PowerShell(npx taigent tickets *)
---

# My tickets

Report the **Period's tickets** (`GLOSSARY.md`) of the user the `taigent` CLI logs in as: every **Planned ticket** (`Ready`, `In progress`, `Ready for test`) plus the ones closed in `Done` during the period, each with its progress group, **Due status** and **Effort**, then the **Plan** of their **Remaining work** by **Working day**, its warnings and the **Re-plan** of the tickets **At risk**. A **Ticket** is a user story; tasks and issues are not tickets. The read-only `npx taigent tickets` computes everything; this skill only lays its JSON out (`docs/cli.md` §Tickets holds the contract, in the taigent root: the project root when its `package.json` has `taigent` as `name`, else `node_modules/taigent/`).

## 1. Check the setup

The project root's `package.json` has `taigent` as `name` or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The CLI uses the user's stored login (`taigent login`), or `TAIGA_*` variables, on its own.

Done when `package.json` names `taigent`.

## 2. Pick the period

Turn the period into a first and a last day, `YYYY-MM-DD`, in the machine's local time zone:

- No period named: the current week, Monday to Sunday, future days included.
- "Last week", "October", "from 26/10 to 1/11": those days, both included.
- Words that admit two readings ("last week" said on a Sunday): take the more recent one, and name the other in the report header.

Done when you have both days and, where the words were ambiguous, the reading you set aside.

## 3. Run `taigent tickets`

Run `npx taigent tickets --from <first day> --to <last day> --json`, alone in its own shell call; add `--project <slug>` when the user named one project. Exit 2 or 5: show the error and stop; for `not logged in`, an expired stored login or a refused login, name `taiga-setup` as the fix.

Done when you hold its JSON.

## 4. Report

Build the report from the JSON alone: every count, sum, due status, plan hour and order comes from it as printed, and fields it lacks stay out. Write it in the user's language (headings and labels included; progress groups and due status names stay as printed). Dates as `DD/MM`, times in local time. A ticket reads `#<ref>` within its project's section and `<project slug>#<ref>` elsewhere. An effort with `effortSource` `points` reads `<effort>h*`, a null one `—`.

1. **Header**: `# <tickets of> <user.username> — <period>` (e.g. `Tuần 16/11 – 22/11/2026`), then one line: the days (Monday–Sunday for a week), today (`today`), local time, and when it was made (`generatedAt`). The user asked about someone else: say the report covers `user.username` only. The reading set aside in step 2, when there was one.
2. **Summary**, four bullets from `summary`:
   - tickets in total, and their count per progress group (`byProgress`, groups with 0 left out).
   - finished (`finished.total`) with their count per due status, plus `finished.withoutFinishingDay` when not 0; not finished (`notFinished.total`) with their count per due status (statuses with 0 left out).
   - effort hours (`effort.hours`), split into Spent Time (`effort.spent`: hours, tickets) and estimated from points (`effort.points`: hours, tickets).
   - tickets per project, in the order of `summary.projects`.
3. **Finished by day**: a table `Day | Finished | Effort`, one row per entry of `days`, zero days included.
4. **Plan by day**: one line `Plan from <plan.start>, 8h per working day`, then a table `Day | Hours | Tickets` with one row per entry of `plan.days`: its date with the weekday, `hours`, and its entries as `<ticket> <hours>h` in their order. `plan.days` empty: say there is no remaining work to plan, in one line.
5. **By project**: one `### <project name> (<count>)` per entry of `summary.projects`, in that order, then a table `# | Ticket | Progress | Due status | Assignees | Due | Finished | Effort | Remaining | Start by | Planned finish` with that project's tickets in the order of `tickets`: `#ref`, subject, `progress`, due status (`—` when null), assignees joined with `, `, `dueDate`, local `finishedAt` (`—` when null), effort, `remainingWork` as hours, `latestStartDay`, `plannedFinishDay` with ⚠ when `atRisk` (`—` for each null).
6. **Warnings**: one bullet per non-empty list of `warnings`, its tickets in their order: Overdue (`overdue`), no due date (`noDueDate`), no points (`noPoints`), still `Ready` on or after the latest start day (`lateStart`), and At risk (`atRisk`), each At risk ticket followed by its `plannedFinishDay`, its `dueDate` and its `sharingTickets`. All empty: say there is no warning, in one line.
7. **Re-plan proposal** (only when `replan` is not empty): a table `Ticket | Subject | Due | Proposed due | Shares its days with` with one row per entry, in order, each followed by its `comment` as printed (Vietnamese, it is what goes onto Taiga). Then say, in the user's language: nothing has been written to Taiga; replying "approve the re-plan" (or "duyệt re-plan") has `taiga-update-ticket` set each proposed due date with its comment, through `taigent due`.
8. **Notes**:
   - `*` = estimated from points because no Spent Time was entered (when any effort reads `*`).
   - Each `notes.bulkCloses` run: `count` tickets closed between `first` and `last` (local time), with their tickets; their closing day may be later than when the work was actually done (a **Bulk close**).
   - `notes.missingEffort`: the tickets with neither points nor Spent Time.

Done when the report has its header, the summary, every day of `days` and of `plan.days`, every project of `summary.projects`, every non-empty warning list, every `replan` entry with how to approve it, and a note for every bulk close and every ticket missing effort. The report is the whole job: statuses, due dates and Spent Time stay as people set them on Taiga, and the re-plan stays a proposal.
